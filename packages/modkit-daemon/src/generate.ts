/**
 * `generate.ts` — the generation pipeline.
 *
 *   resolve the target → fetch its source at the installed tag → build the prompt → call the model
 *   → parse → validate → (retry once with the findings) → bundle → an unsigned `ArtifactDraft`.
 *
 * This module implements {@link Pipeline} and exports it as **`runGeneration`**, which is the name
 * `index.ts` imports statically. Everything it needs it builds for itself from `resolveConfig()`,
 * so the daemon can wire a pipeline without knowing what a pipeline is made of; `createPipeline()`
 * is the same thing with its collaborators injected, for tests.
 *
 * ## Three things this module is opinionated about
 *
 * **1. A refusal is a first-class, correct outcome — returned, never thrown.** Only modkit
 * *breaking* is a `PipelineError`. The whole product rests on that distinction: a system that cannot
 * say "I cannot reach that" says "here is a patch" instead, and the patch silently does nothing.
 * That is the number PLAN §M3 says must be zero.
 *
 * **2. A validator rejection is a conversation, not a verdict.** On a rejection we retry **once**
 * with the findings fed back as corrections. That loop is the point of having a machine author: the
 * findings are mechanical, precise, and about shape rather than intent, which is exactly the class
 * of error a second turn fixes. A *second* rejection is not a third attempt — it becomes a refusal
 * naming what could not be satisfied, because by then the evidence is that the request cannot be met
 * inside the reclaim contract.
 *
 * The loop's uncomfortable property, stated rather than left implicit: a model that fails once is
 * asked again *with the rules in hand*, which is an invitation to optimise against the rules rather
 * than against the hazard they describe. Two things answer that. `prompt.ts`'s `RECLAIM_CONTRACT`
 * states the three completeness rules (the version-gate, the accessor check, the bound-method check)
 * as behavioural requirements without naming their rule **ids**, and `buildCorrectionPrompt` withholds
 * those same ids from the findings it feeds back on a retry — so the model always has a behaviour to
 * satisfy and no token to paste. Downstream, the plugin shows the generated source to a person before
 * it is written — the validator is a filter, not a boundary, and it has been found fail-open in four
 * consecutive adversarial rounds.
 *
 * **2b. The stylesheet is validated too, and it did not use to be.** `runValidate` runs on
 * `patch.source`; a plane-E mod's `patch.stylesCss` travelled from the model into the signed
 * payload and onto disk as `styles.css` with nothing having read it. CSS is not inert — Obsidian
 * applies it to the whole application for as long as the mod is enabled — so
 * {@link screenStylesheet} now screens it in the same currency as the source validator, and its
 * findings ride the same retry-once-then-refuse path. It is a screen, not a proof; the review
 * modal shows the stylesheet in full, and that pairing is the actual mitigation. `withStylesheetFindings`
 * also runs {@link checkCssModeStylesheet}, catching the opposite failure: a css-mode plane-E mod
 * with an *empty* `stylesCss`, which is the same silent no-op — installs, reports `applied`, styles
 * nothing — as the `inject-stylesheet` mods this fix was written for, from the other direction.
 *
 * **2c. The pipeline carries a second axis it does not enforce.** The reclaim contract asks whether
 * Obsidian can take the patch back. It cannot ask whether the patch's *effects* can be taken back —
 * a rewritten note, a trashed file, a POST — so those are **declared** rather than gated:
 * `readEffects` lifts the validator's declaration into the draft, `sign.ts` seals it inside the
 * signed payload, and the plugin's review modal leads with it. Nothing here refuses a mod for
 * declaring an effect; the person does.
 *
 * **3. No fallback to `HEAD`, ever.** If the installed version's tag cannot be resolved, that is a
 * refusal. The two live targets in this vault are a major version behind their repos' HEAD, so a
 * patch generated against HEAD would bind confidently to code the user does not have — which is
 * worse than no patch at all, and invisible.
 *
 * ## What this module does not own
 *
 * Signing. It returns an unsigned {@link ArtifactDraft} and `sign.ts` computes the digest, the
 * issue and expiry times and the daemon version — a digest supplied by the same step that produced
 * the bytes proves nothing, and the private key stays in exactly one module.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  EffectsDeclaration,
  GenerateRefusal,
  GenerateRequest,
  ModEffect,
  ModelBackend,
  ObsidianPluginManifest,
  PickEvidence,
  ReachTarget,
  TargetRef,
  TargetVersionRange,
  ValidationFinding,
  ValidationReport,
} from '@modkit/types';
import { MODKIT_MOD_ID_PREFIX, targetKey, targetVersion } from '@modkit/types';

import type { RunUsage } from './claude.js';
import { runModel } from './model.js';
import { CODEX_SANDBOX_REFUSAL } from './state.js';
import { buildPatchPlugin, type BuildMessage, type BuildResult } from './build.js';
import { PipelineError, type JobContext, type Pipeline, type PipelineInput, type PipelineResult } from './jobs.js';
import { createLogger, type Logger } from './log.js';
import { PluginRegistry } from './registry.js';
import { cmpSemver, maxSemver, parseSemver } from './semver.js';
import { extractKeywords, scanHazards, SourceFetcher, type SourceBundle, type SourceHazard } from './source.js';
import {
  buildCorrectionPrompt,
  buildGenerationPrompt,
  parseGenerationOutput,
  type ModelPatch,
  type ModelRefusal,
  type PromptInput,
} from './prompt.js';
import type { ArtifactDraft } from './sign.js';
import { ensureState, findRepoRoot, resolveConfig, type StateLayout } from './state.js';
import { checkCssModeStylesheet, validateSource, type EffectsReport, type ValidateOptions } from './validate.js';

/**
 * Render build diagnostics for a `JobError.detail`.
 *
 * Named because the obvious `errors.join('\n')` is silently wrong against structured messages — it
 * produces a column of `[object Object]`, which turns a legible esbuild error into an unreadable
 * one at exactly the moment somebody is trying to read it.
 */
function formatBuildErrors(errors: readonly BuildMessage[]): string {
  return errors
    .map((e) => {
      const where = e.file ? `${e.file}:${e.line ?? 0}:${e.column ?? 0}: ` : '';
      return `${where}${e.text}${e.excerpt ? `\n    ${e.excerpt}` : ''}`;
    })
    .join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * modkit's own floor, and the floor of everything it generates.
 *
 * `onUserEnable` and deferred views both landed in 1.7.2, and those are the two lifecycle facts a
 * plugin that installs and enables *other* plugins has to be right about. It is also already the
 * floor of an installed plugin in this vault, so it costs nothing.
 */
export const MODKIT_MIN_APP_VERSION = '1.7.2';

/**
 * How many omitted files one refusal may pull in. Small on purpose: the case this serves is "you
 * forgot the one file that matters", not "send me the repo". `DEFAULT_MAX_FILES` is 24, so a larger
 * pin would evict most of what scored in and change the question rather than answer it.
 */
const MAX_PINNED_RETRY_PATHS = 4;

const DEFAULT_MOD_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUDGET_USD = 1.5;

export interface PipelineDeps {
  registry: PluginRegistry;
  source: SourceFetcher;
  /** Where mod archives live — a regeneration reads the original request back from there. */
  layout: StateLayout;
  /** `templates/patch/` — the esbuild `resolveDir` and the dependency allowlist. */
  templateDir: string;
  model: string;
  /**
   * The daemon's configured backend — the default a request overrides, not a hard-coded one.
   *
   * `model.ts`'s header called this out as a known gap: `runModel` was falling back to
   * `resolveConfig()` per call, which made it the one link that could throw synchronously despite
   * both transports' never-throws contract. Threading it here the way `model` already was closes
   * that, and it is what makes a per-request override expressible at all.
   */
  backend?: ModelBackend;
  /**
   * Whether this daemon's operator accepted codex's sandbox caveat. Gates a `codex` override; see
   * {@link CODEX_SANDBOX_REFUSAL}. Absent is treated as NOT acknowledged — the gate fails closed,
   * so a caller that forgets to wire this cannot accidentally open it.
   */
  codexAcknowledged?: boolean;
  /**
   * A real ceiling per model turn, and a generation makes up to two. Set deliberately: the reason a
   * spend ledger exists at all is that un-instrumented headless calls are not undercounted, they are
   * absent.
   */
  maxBudgetUsd?: number;
  /**
   * A whole patch with a real plugin's source in the prompt, not a one-line brief. 300s is
   * the floor — `claude -p` pays CLI startup *plus* model latency.
   */
  timeoutMs?: number;
  /** Version for the generated manifest. A regeneration keeps the id and moves only this. */
  modVersion?: string;
  /**
   * Injectable for tests. A test double may return a bare {@link ValidationReport} with no
   * `effects` field at all — the real `validateSource` always returns the wider `EffectsReport` —
   * and both are accepted so {@link readEffects} can tell "this validator does not analyse
   * effects" apart from "analysed, and found none".
   */
  validate?: (source: string, options?: ValidateOptions) => ValidationReport | EffectsReport;
  build?: typeof buildPatchPlugin;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The pipeline
 * ──────────────────────────────────────────────────────────────────────────── */

export function createPipeline(deps: PipelineDeps): Pipeline {
  return async function pipeline(input: PipelineInput, ctx: JobContext): Promise<PipelineResult> {
    const resolved = resolveInput(input);
    const { request, target } = resolved;

    const label = displayName(target);
    const installedVersion = targetVersion(target);
    const stop = (): void => {
      if (ctx.signal.aborted) throw new PipelineError('internal', 'the job was cancelled');
    };

    const refuse = (refusal: Omit<GenerateRefusal, 'kind' | 'target'>): PipelineResult => ({
      kind: 'refused',
      target,
      ...refusal,
    });

    // The backend and model this run will actually use. Resolved once, before any work, so a
    // request asking for a backend it may not have fails immediately and for free rather than
    // after a source fetch. `deps.backend ?? 'claude'` mirrors resolveConfig's own default.
    const daemonBackend: ModelBackend = deps.backend ?? 'claude';
    const override = input.request.modelOverride;
    const backend: ModelBackend = override?.backend ?? daemonBackend;
    if (backend === 'codex' && deps.codexAcknowledged !== true) {
      throw new PipelineError('bad-request', 'this daemon is not configured to use codex', {
        detail: CODEX_SANDBOX_REFUSAL,
      });
    }
    // An override's model is only meaningful for the backend it was chosen alongside: a claude
    // model id handed to codex is a guaranteed failure. So a request that switches backend WITHOUT
    // naming a model gets that backend's own default rather than the daemon's current model
    // string, matching resolveConfig's backend-aware default ('' means "let the CLI pick").
    const modelId = override?.model ?? (backend === daemonBackend ? deps.model : backend === 'codex' ? '' : 'sonnet');

    ctx.stage('generating');

    /* ── 1 · resolve the repo ──────────────────────────────────────────────── */

    stop();
    ctx.progress(`resolving ${label} ${installedVersion}`, 0.05);

    let repo: string | undefined = target.kind === 'plugin' ? target.repo : undefined;
    let registryWarning: string | undefined;

    if (!repo && target.kind === 'plugin') {
      const lookup = await deps.registry.lookup(target.pluginId);
      repo = lookup.record?.repo;
      registryWarning = lookup.warning;
      if (!repo && lookup.freshness === 'unavailable') {
        // Never guess a repo. A wrong one produces a confident patch against someone else's code.
        return refuse({
          reason: 'no-source-available',
          explanation: `modkit could not look up where ${label}'s source lives, so it has nothing to read.`,
          detail: lookup.warning ?? 'the community plugin registry is not cached and could not be fetched',
          suggestion: 'Try again once this machine can reach raw.githubusercontent.com.',
        });
      }
    }

    /* ── 2 · fetch the source at the installed tag ─────────────────────────── */

    let bundle: SourceBundle | null = null;
    let hazards: SourceHazard[] = [];
    let sourceNote: string | undefined = registryWarning;

    if (repo) {
      stop();
      ctx.progress(`reading ${repo} at ${installedVersion}`, 0.15);
      const symbols = symbolsFor(resolved.proposedReach);
      const fetched = await deps.source.fetchSource(repo, installedVersion, {
        keywords: extractKeywords(request, symbols),
        symbols,
        includeStyles: resolved.proposedReach?.plane === 'E',
      });
      if (fetched.ok) {
        bundle = fetched.bundle;
        hazards = scanHazards(bundle, { member: memberOf(resolved.proposedReach), symbols });
      } else {
        sourceNote = fetched.error;
        if (fetched.reason === 'tag' || fetched.reason === 'bad-repo') {
          return refuse({
            reason: 'no-source-available',
            explanation: `modkit could not find ${label}'s source at version ${installedVersion}, and it will not generate against a different version.`,
            detail: fetched.error,
            suggestion: "Check that the plugin's repository publishes a release tagged with its manifest version.",
          });
        }
      }
    } else if (target.kind === 'plugin') {
      sourceNote = registryWarning ?? `no repository is recorded for ${target.pluginId}`;
    }

    /* ── 3 · build the prompt ──────────────────────────────────────────────── */

    const modId = resolved.modId;
    const modVersion = deps.modVersion ?? DEFAULT_MOD_VERSION;

    // `let` because §4b may refetch the source with paths the model asked for and ask again; the
    // correction turn in §5 must then see the fuller source too, not the first attempt's.
    let promptInput: PromptInput = {
      request,
      target,
      targetName: target.kind === 'plugin' ? target.pluginName : undefined,
      repo,
      proposedReach: resolved.proposedReach,
      evidence: resolved.evidence,
      client: resolved.client,
      source: bundle,
      hazards,
      regeneration: input.kind === 'regenerate' ? input.request.origin : undefined,
      modId,
      modVersion,
      minAppVersion: MODKIT_MIN_APP_VERSION,
    };

    const built = buildGenerationPrompt(promptInput);
    stop();
    ctx.progress(
      bundle
        ? `asking the model — ${bundle.files.length} source file(s), ${Math.round(built.bytes / 1024)} KB of context`
        : 'asking the model',
      0.25,
    );

    /* ── 4 · first turn ────────────────────────────────────────────────────── */

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBudgetUsd = deps.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    const record = (usage: RunUsage): void => recordUsage(ctx, usage);

    const first = await runModel<Record<string, unknown>>({
      system: built.system,
      prompt: built.prompt,
      model: modelId,
      schema: built.schema,
      source: 'modkit-generate',
      timeoutMs,
      maxBudgetUsd,
      signal: ctx.signal,
      onUsage: record,
    }, { backend });

    if (!first.ok) {
      if (first.usage) record(first.usage);
      throw modelError(first.error, 'The model call failed.', backend);
    }

    const parsedFirst = parseGenerationOutput(first.json);
    if (!parsedFirst.ok) {
      throw new PipelineError('model-failed', 'the model answered in an unusable shape', {
        detail: parsedFirst.error,
        retryable: true,
      });
    }
    /* ── 4b · ONE source-pinned retry when the refusal names a file we did not send ──
     *
     * Selection is a scoring heuristic over paths, and it is allowed to be wrong — being wrong
     * "costs a slightly worse context, never a wrong patch" (source.ts). That was only true while a
     * bad selection produced a bad *patch*. It also produces a **refusal that names its own cure**,
     * and until 2026-09-03 that was a dead end: the prompt asked the model to say which omitted file
     * it needed, the model said `src/Obsidian/Cache.ts`, and nothing read the answer. Two
     * generations were spent on the same missing file.
     *
     * `scorePath` already returns 5_000 for an explicitly requested path, so pinning is exact. One
     * retry, never a loop: a second refusal is the answer, the same way a second validator rejection
     * is (§5).
     */

    let parsed = parsedFirst;

    if (parsed.value.kind === 'refusal' && parsed.value.refusal.reason === 'no-source-available' && repo && bundle) {
      const wanted = neededSourcePaths(parsed.value.refusal, bundle);
      if (wanted.length > 0) {
        stop();
        ctx.stage('generating');
        ctx.progress(`the model asked for ${wanted.length} more file(s) — fetching them and asking again`, 0.3);

        const symbols = symbolsFor(resolved.proposedReach);
        const refetched = await deps.source.fetchSource(repo, installedVersion, {
          keywords: extractKeywords(request, symbols),
          symbols,
          includeStyles: resolved.proposedReach?.plane === 'E',
          paths: wanted,
        });

        // Only spend a second model call if the pin actually delivered. A refetch that still lacks
        // the file would ask the identical question and earn the identical refusal.
        const delivered = refetched.ok && wanted.some((p) => refetched.bundle.files.some((f) => f.path === p));
        if (refetched.ok && delivered) {
          bundle = refetched.bundle;
          hazards = scanHazards(bundle, { member: memberOf(resolved.proposedReach), symbols });
          promptInput = { ...promptInput, source: bundle, hazards };

          const rebuilt = buildGenerationPrompt(promptInput);
          stop();
          ctx.progress(
            `asking again — ${bundle.files.length} source file(s), ${Math.round(rebuilt.bytes / 1024)} KB of context`,
            0.35,
          );
          const pinned = await runModel<Record<string, unknown>>({
            system: rebuilt.system,
            prompt: rebuilt.prompt,
            model: modelId,
            schema: rebuilt.schema,
            source: 'modkit-generate',
            timeoutMs,
            maxBudgetUsd,
            signal: ctx.signal,
            onUsage: record,
          }, { backend });
          if (!pinned.ok) {
            if (pinned.usage) record(pinned.usage);
            throw modelError(pinned.error, 'The model call failed after fetching the files it asked for.', backend);
          }
          const parsedPinned = parseGenerationOutput(pinned.json);
          // A retry that comes back malformed must not discard the first turn's perfectly good
          // refusal — that refusal is still the honest answer to give the user.
          if (parsedPinned.ok) parsed = parsedPinned;
        }
      }
    }

    if (parsed.value.kind === 'refusal') {
      const r = parsed.value.refusal;
      return refuse({
        reason: r.reason,
        explanation: r.explanation,
        detail: sourceNote ? `${r.detail} (source note: ${sourceNote})` : r.detail,
        ...(r.suggestion ? { suggestion: r.suggestion } : {}),
        ...(r.attempted ? { attempted: r.attempted } : {}),
      });
    }

    /* ── 5 · validate, and retry ONCE with the findings fed back ───────────── */

    ctx.stage('validating');
    const runValidate = deps.validate ?? validateSource;
    // `patch.reach.plane` rides along on every call so `inject-stylesheet` (validate.ts) can tell a
    // plane-E mod's <style>-element injection (a rejection) from the same shape on another plane (a
    // warning) — see prompt.ts's `REACH_AND_REFUSAL`, which is the other half of this fix.
    const validateAndScreen = (p: ModelPatch): ValidationReport | EffectsReport =>
      withStylesheetFindings(normaliseValidation(runValidate(p.source, { reachPlane: p.reach.plane })), p.reach, p.stylesCss);
    let patch: ModelPatch = parsed.value.patch;
    // The validator runs on `patch.source` only. `patch.stylesCss` used to travel from the model
    // straight into the signed payload and onto disk as `styles.css` with nothing having looked at
    // it — and CSS is not inert: it is applied to the *whole* app for as long as the mod is
    // enabled, so it can hide Obsidian's chrome, cover the window, fetch a remote resource on
    // every render, or restyle modkit's own review gate out of existence.
    let report = validateAndScreen(patch);

    if (!report.ok) {
      const errors = report.findings.filter((f) => f.severity === 'error');
      stop();
      ctx.stage('generating');
      ctx.progress(`the validator rejected ${errors.length} thing(s) — asking for a correction`, 0.6);

      const correction = buildCorrectionPrompt(promptInput, patch.source, report.findings, patch.stylesCss ?? '');
      const second = await runModel<Record<string, unknown>>({
        system: correction.system,
        prompt: correction.prompt,
        model: modelId,
        schema: correction.schema,
        source: 'modkit-correct',
        timeoutMs,
        maxBudgetUsd,
        signal: ctx.signal,
        onUsage: record,
      }, { backend });

      if (!second.ok) {
        if (second.usage) record(second.usage);
        throw modelError(
          second.error,
          'The correction turn failed after the validator rejected the first attempt.',
          backend,
          report.findings,
        );
      }

      const parsedSecond = parseGenerationOutput(second.json);
      if (!parsedSecond.ok) {
        throw new PipelineError('model-failed', 'the correction turn answered in an unusable shape', {
          detail: parsedSecond.error,
          retryable: true,
          findings: report.findings,
        });
      }
      if (parsedSecond.value.kind === 'refusal') {
        // The correction prompt explicitly offers this: the model has now seen the rules twice and
        // concluded the request cannot be met inside them. That is an answer, not a failure.
        const r = parsedSecond.value.refusal;
        return refuse({
          reason: r.reason,
          explanation: r.explanation,
          detail: r.detail,
          ...(r.suggestion ? { suggestion: r.suggestion } : {}),
          ...(r.attempted ? { attempted: r.attempted } : {}),
        });
      }

      patch = parsedSecond.value.patch;
      ctx.stage('validating');
      report = validateAndScreen(patch);

      if (!report.ok) {
        const stillBroken = report.findings.filter((f) => f.severity === 'error');
        return refuse({
          reason: 'unsupported-request',
          attempted: patch.reach,
          explanation:
            'modkit could write code for this, but not code that can be safely removed again — so it did not ship it.',
          detail:
            'Two generations were rejected by the reclaim-contract validator. Still failing: ' +
            stillBroken
              .map((f) => `${f.rule} (${f.file ?? 'main.js'}:${f.line}:${f.column}) ${f.message}`)
              .join('; '),
          suggestion: 'A narrower request, or one aimed at a different part of the plugin, is likely to work.',
        });
      }
    }

    const warnings = report.findings.filter((f) => f.severity === 'warning');
    // The second axis, read off the *final* report — the one for the source that is actually being
    // shipped, never the rejected first turn's. `undefined` when this validator does not declare
    // effects at all, and that stays distinguishable from "declared nothing" all the way to the
    // review modal: a blank where an analysis should be must not read as a clean bill of health.
    const effects = readEffects(report);

    /* ── 6 · bundle ────────────────────────────────────────────────────────── */

    stop();
    ctx.stage('building');
    ctx.progress('bundling the mod', 0.85);

    const runBuild = deps.build ?? buildPatchPlugin;
    let outcome: BuildResult;
    try {
      outcome = await runBuild(patch.source, { resolveDir: deps.templateDir, loader: 'js', minify: false });
    } catch (err) {
      throw new PipelineError('build-failed', 'the generated mod could not be bundled', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (!outcome.ok) {
      throw new PipelineError('build-failed', 'the generated mod could not be bundled', {
        detail: formatBuildErrors(outcome.errors),
      });
    }

    /* ── 7 · the draft ─────────────────────────────────────────────────────── */

    const manifest: ObsidianPluginManifest = {
      id: modId,
      name: patch.modName || `Mod: ${label}`,
      version: modVersion,
      minAppVersion: maxSemver(MODKIT_MIN_APP_VERSION, patch.appMinVersion ?? MODKIT_MIN_APP_VERSION),
      description: patch.modDescription || defaultDescription(label, installedVersion, request),
      author: 'modkit (generated)',
      // Always false. Mods reach mobile through vault sync like any other plugin, and the validator
      // rejects the node/electron access that would make `true` honest.
      isDesktopOnly: false,
    };

    const draft: ArtifactDraft = {
      modId,
      manifest,
      mainJs: outcome.code,
      ...(patch.stylesCss ? { stylesCss: patch.stylesCss } : {}),
      request,
      target,
      reach: patch.reach,
      targetVersionRange: sanitiseRange(patch.targetVersionRange, installedVersion),
      appMinVersion: manifest.minAppVersion,
      noEffect: patch.noEffect,
      explanation: patch.explanation,
      ...(effects === undefined ? {} : { effects }),
      // The model that actually served the request, read from `modelUsage` — never echoed back from
      // the request, because a server-side fallback would make the echo a quiet lie.
      model: first.model,
    };

    return { kind: 'built', draft, ...(warnings.length > 0 ? { warnings } : {}) };
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The default, self-configuring pipeline — what `index.ts` imports
 * ──────────────────────────────────────────────────────────────────────────── */

let cachedDefault: Pipeline | null = null;

function defaultPipeline(): Pipeline {
  if (cachedDefault) return cachedDefault;
  const config = resolveConfig();
  const root = findRepoRoot();
  const layout = ensureState(config.stateDir);
  const log: Logger = createLogger({ file: layout.logFile, level: config.logLevel }).child({
    component: 'generate',
  });

  cachedDefault = createPipeline({
    registry: new PluginRegistry({ stateDir: layout.root, log: (m) => log.info(m) }),
    source: new SourceFetcher({ stateDir: layout.root, log: (m) => log.info(m) }),
    layout,
    templateDir: join(root, 'templates', 'patch'),
    model: config.model,
    backend: config.backend,
    codexAcknowledged: config.codexAcknowledged,
  });
  return cachedDefault;
}

/**
 * The pipeline, as `index.ts` loads it. Configuration is read on first use rather than at import,
 * so importing this module never touches the filesystem — which is what lets a test import
 * `createPipeline` without a `.state` directory existing.
 */
export const runGeneration: Pipeline = async (input, ctx) => defaultPipeline()(input, ctx);

/* ────────────────────────────────────────────────────────────────────────────
 * Input resolution
 * ──────────────────────────────────────────────────────────────────────────── */

interface ResolvedInput {
  /** The user's sentence, verbatim. */
  request: string;
  target: TargetRef;
  modId: string;
  proposedReach: ReachTarget | undefined;
  evidence: PickEvidence | undefined;
  client: GenerateRequest['client'] | undefined;
}

/**
 * Turn either job shape into the one set of facts the pipeline works from.
 *
 * A `RegenerateRequest` carries the sentence, the evidence and the plane that worked last time
 * straight from the plugin's own ledger — the same facts a `GenerateRequest` carries — so
 * regeneration needs nothing read back from this daemon's own archive. That archive (`saveModArchive`
 * in `jobs.ts`) is still written for audit purposes, but it is no longer the thing that makes a mod
 * regenerable: a wiped `.state` no longer takes the plugin's mods down with it.
 */
function resolveInput(input: PipelineInput): ResolvedInput {
  if (input.kind === 'generate') {
    return {
      request: input.request.request,
      target: input.request.target,
      modId: deriveModId(input.request),
      proposedReach: input.request.proposedReach,
      evidence: input.request.evidence,
      client: input.request.client,
    };
  }

  return {
    request: input.request.request,
    target: input.request.target,
    modId: input.request.modId,
    proposedReach: input.request.proposedReach,
    evidence: input.request.evidence,
    client: input.request.client,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Accepts a `ValidationReport`/`EffectsReport` or a bare findings array; `ok` is exactly "no finding is an error". */
function normaliseValidation(result: ValidationReport | EffectsReport | ValidationFinding[]): ValidationReport | EffectsReport {
  const findings = Array.isArray(result) ? result : result.findings;
  const safe = Array.isArray(findings) ? findings : [];
  const ok = !safe.some((f) => f.severity === 'error');
  // Carry the effects declaration straight through, typed, when the validator produced one — a
  // bare `ValidationReport` (the shape a test double may inject) has no `effects` field at all,
  // and that absence is exactly what `readEffects` must be able to tell apart from "declared, and
  // found none".
  if (!Array.isArray(result) && 'effects' in result) {
    return { ok, findings: safe, effects: result.effects };
  }
  return { ok, findings: safe };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The effects declaration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read the validator's effects declaration off a report, and translate it into the wire shape.
 *
 * `validate.ts`'s `EffectDeclaration` is richer than the wire needs (`severity`, `subject`,
 * `reversedOnUnload`, `file` are all internal to the validator) — this keeps only what a person
 * reads in the review: `kind`, one `detail` line (`summary`, falling back to the raw `call`), and
 * the source location.
 *
 * Returns `undefined` only when the validator did not declare effects at all — a bare
 * `ValidationReport` with no `effects` field, which a test double may inject deliberately. That
 * stays distinguishable from "declared, and found none" all the way to the review modal: a blank
 * where an analysis should be must never read as a clean bill of health.
 */
function readEffects(report: ValidationReport | EffectsReport): EffectsDeclaration | undefined {
  if (!('effects' in report)) return undefined;

  const effects: ModEffect[] = report.effects.map((e) => {
    const effect: ModEffect = { kind: e.kind, detail: e.summary ?? e.call, line: e.line, column: e.column };
    if (e.excerpt !== undefined) effect.excerpt = e.excerpt;
    return effect;
  });

  return { effects };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Screening the stylesheet
 * ──────────────────────────────────────────────────────────────────────────── */

/** Rules that must not ship, and rules a person should see. `styles.css`, not `main.js`. */
const CSS_HIDDEN_RE = /(?:display\s*:\s*none)|(?:visibility\s*:\s*hidden)|(?:opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*[;}]?)|(?:content-visibility\s*:\s*hidden)/i;

/**
 * Selectors that are the *application*, not the thing the user pointed at. A plane-E mod styling
 * one of these is styling everything.
 */
const CSS_APP_CHROME = [
  '*',
  'html',
  'body',
  '.app-container',
  '.horizontal-main-container',
  '.workspace',
  '.workspace-split',
  '.workspace-tabs',
  '.workspace-leaf',
  '.titlebar',
  '.status-bar',
  '.modal',
  '.modal-container',
  '.notice',
  '.notice-container',
  '.menu',
  '.suggestion-container',
];

/**
 * Screen a generated `styles.css`, returning findings in the same currency as the source
 * validator's so the existing machinery carries them: an `error` triggers the one correction turn
 * and, if it survives that, becomes a refusal; a `warning` is shipped and shown in the review.
 *
 * This is a screen, not a parser, and it is written to be honest about that. It catches shapes
 * whose *intent* is unambiguous and leaves judgement calls to the person reading the stylesheet in
 * full in the review modal, which is the mitigation this pairs with rather than replaces.
 *
 * Two of the four rules block:
 *
 * - **`css-targets-modkit`** — a generated stylesheet that names `modkit` is styling the tool that
 *   is about to show it to you. Obsidian applies `styles.css` document-wide while the mod is
 *   enabled, so `.modkit-review__source { display: none }` blanks the code block of *every later
 *   review* on this device, and the gate goes on reporting that it showed the user the source. A
 *   mod has no legitimate reason to name modkit's own surfaces: modkit refuses to install over
 *   itself, so it is never the target.
 * - **`css-remote-resource`** — `@import` and remote `url()` are network requests made on the
 *   host's behalf, once per render, before any of the mod's JavaScript runs. That is an effect
 *   that survives the mod (a request cannot be un-sent) and it is invisible in the source unless
 *   you know to look for it. `data:` and vault-relative URLs are fine and are not flagged.
 */
export function screenStylesheet(css: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (typeof css !== 'string' || css.trim() === '') return findings;

  // Comments are stripped for *matching* but the offsets are kept, so a reported line still points
  // at the real line. Replacing each comment with spaces of the same length is what preserves that.
  const scrubbed = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

  const at = (index: number): { line: number; column: number; excerpt: string } => {
    const before = css.slice(0, Math.max(0, index));
    const line = before.split('\n').length;
    const column = index - (before.lastIndexOf('\n') + 1) + 1;
    const excerpt = (css.split('\n')[line - 1] ?? '').trim().slice(0, 200);
    return { line, column, excerpt };
  };

  const add = (
    rule: string,
    severity: 'error' | 'warning',
    message: string,
    index: number,
  ): void => {
    const where = at(index);
    findings.push({ rule, severity, message, line: where.line, column: where.column, excerpt: where.excerpt, file: 'styles.css' });
  };

  const modkit = /modkit/i.exec(scrubbed);
  if (modkit) {
    add(
      'css-targets-modkit',
      'error',
      "a generated stylesheet must not name modkit's own interface. Obsidian applies styles.css to the whole app while the mod is enabled, so a rule matching .modkit-* restyles the review gate, the progress surface and the mod list for every later mod. Style the target's own elements instead.",
      modkit.index,
    );
  }

  const importAt = /@import\b/i.exec(scrubbed);
  if (importAt) {
    add(
      'css-remote-resource',
      'error',
      '@import fetches a stylesheet over the network every time it is applied, and modkit cannot see what comes back. Inline the rules you need instead.',
      importAt.index,
    );
  }

  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  for (let m = urlRe.exec(scrubbed); m !== null; m = urlRe.exec(scrubbed)) {
    const href = (m[2] ?? '').trim();
    if (!/^(?:https?:)?\/\//i.test(href)) continue;
    add(
      'css-remote-resource',
      'error',
      `this stylesheet fetches ${href} from the network on every render, which tells that server when the vault is open. Embed the asset as a data: URI, or drop it.`,
      m.index,
    );
  }

  // One pass over `selector { body }`. At-rules nest, so an inner rule's selector may arrive with
  // its `@media (...)` prefix attached — which is fine for a heuristic and is why these two are
  // warnings a person adjudicates rather than errors.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = ruleRe.exec(scrubbed); m !== null; m = ruleRe.exec(scrubbed)) {
    const selector = (m[1] ?? '').trim();
    const body = m[2] ?? '';
    if (selector.startsWith('@')) continue;

    const parts = selector.split(',').map((s) => s.trim());
    const hitsChrome = parts.some((part) => CSS_APP_CHROME.includes(part.replace(/\s*[:>~+].*$/, '').trim()));
    if (hitsChrome && CSS_HIDDEN_RE.test(body)) {
      add(
        'css-hides-app-chrome',
        'warning',
        `"${selector}" is Obsidian's own interface rather than the element this mod targets, and this rule hides it. Check that hiding it is what you asked for.`,
        m.index,
      );
    }
    if (/position\s*:\s*fixed/i.test(body) && /(?:inset\s*:\s*0)|(?:100vw)|(?:100vh)|(?:width\s*:\s*100%[\s\S]*height\s*:\s*100%)/i.test(body)) {
      add(
        'css-fixed-overlay',
        'warning',
        `"${selector}" covers the whole window with a fixed-position layer. That can sit in front of anything, including a dialog asking you to confirm something.`,
        m.index,
      );
    }
  }

  return findings;
}

/**
 * Merge `stylesCss`'s findings into a report, recomputing `ok` over the union: {@link
 * screenStylesheet}'s screen of the CSS itself, plus {@link checkCssModeStylesheet}'s check that a
 * css-mode plane-E mod shipped a stylesheet at all — the empty-`stylesCss` half of the silent no-op
 * `validate.ts`'s `inject-stylesheet` catches the injected-`<style>`-element half of.
 */
function withStylesheetFindings(
  report: ValidationReport | EffectsReport,
  reach: ReachTarget,
  css: string | undefined,
): ValidationReport | EffectsReport {
  const extra = [
    ...(reach.plane === 'E' ? checkCssModeStylesheet(reach.plane, reach.mode, css) : []),
    ...(css ? screenStylesheet(css) : []),
  ];
  if (extra.length === 0) return report;
  const findings = [...report.findings, ...extra];
  const ok = !findings.some((f) => f.severity === 'error');
  if ('effects' in report) return { ok, findings, effects: report.effects };
  return { ok, findings };
}

/**
 * One ledger row per model. A server-side fallback produces two honest rows rather than one
 * mislabelled total, which is why `modelUsage` is keyed by model and why this loops.
 */
function recordUsage(ctx: JobContext, usage: RunUsage): void {
  for (const m of usage.models) {
    ctx.recordUsage({
      source: usage.source,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadInputTokens: m.cacheReadInputTokens,
      cacheCreationInputTokens: m.cacheCreationInputTokens,
      ...(usage.totalCostUsd !== null ? { totalCostUsd: usage.totalCostUsd } : {}),
      ...(usage.sessionId !== null ? { sessionId: usage.sessionId } : {}),
      ...(usage.uuid !== null ? { uuid: usage.uuid } : {}),
    });
  }
}

/**
 * Does this transport failure mean "the CLI is not signed in" rather than "the call went wrong"?
 *
 * Matched on the CLI's own words, from a real failure: a friend's daemon returned
 * `"Failed to authenticate: OAuth session expired and could not be refreshed"` inside the result
 * event, and modkit reported it as a retryable `model-failed` with the message "The model call
 * failed." Both halves were wrong. It is not retryable — every retry re-runs the same expired
 * session and fails identically — and the one thing that fixes it (`claude login`) appeared
 * nowhere, so the only route to the answer was a JSON dump in a disclosure triangle.
 *
 * Deliberately a substring match on a handful of phrasings rather than a strict parse: the CLIs
 * do not give this a stable code, and the cost of a false positive here is a slightly wrong hint
 * on an error that was already fatal, while the cost of a false negative is what shipped.
 */
function authFailureHint(error: string, backend: ModelBackend): string | null {
  const e = error.toLowerCase();
  const isAuth =
    e.includes('oauth session expired') ||
    e.includes('failed to authenticate') ||
    e.includes('authentication_error') ||
    e.includes('invalid api key') ||
    e.includes('please run /login') ||
    e.includes('not logged in') ||
    e.includes('unauthorized');
  if (!isAuth) return null;
  return backend === 'codex'
    ? 'The codex CLI is not signed in, or its session expired. Run `codex login` in a terminal, then try again.'
    : 'The claude CLI is not signed in, or its session expired. Run `claude login` in a terminal, then try again.';
}

/** Cancellation, a timeout and a model error are three different problems; only one is retryable. */
function modelError(
  error: string,
  message: string,
  backend: ModelBackend,
  findings?: ValidationFinding[],
): PipelineError {
  if (error === 'cancelled' || error.startsWith('cancelled')) {
    return new PipelineError('internal', 'the job was cancelled', { detail: error });
  }
  const auth = authFailureHint(error, backend);
  if (auth) {
    // `retryable: false` is the load-bearing half: a retryable flag on an expired session invites
    // the client to re-run something that cannot succeed until a human runs a login command.
    return new PipelineError('model-auth', auth, { detail: error, retryable: false });
  }
  const timedOut = error.startsWith('killed by');
  return new PipelineError(timedOut ? 'model-timeout' : 'model-failed', timedOut ? 'the model did not answer in time' : message, {
    detail: error,
    retryable: true,
    ...(findings ? { findings } : {}),
  });
}

function displayName(target: TargetRef): string {
  if (target.kind === 'core') return target.internalPluginId ?? 'Obsidian';
  return target.pluginName ?? target.pluginId;
}

/**
 * Which omitted files a `no-source-available` refusal is asking for.
 *
 * Two sources, in order of trust:
 *  1. `refusalNeededPaths`, the structured field the schema asks for.
 *  2. A scan of the refusal's own prose — kept because the model named the file it needed in
 *     `explanation`/`detail` before the structured field existed (measured twice on 2026-09-03),
 *     and a model that explains itself well while leaving an optional array empty should not be
 *     punished for it.
 *
 * **Both are filtered against `bundle.omitted`, which is what makes the prose scan safe.** Only a
 * path this repo actually has, and that this fetch actually left out, can be pinned — so a
 * hallucinated filename, a path from a different repo, or anything already sent resolves to
 * nothing and the retry does not happen. Never `bundle.files`: re-pinning a file the model already
 * had is how one wasted turn becomes two.
 */
export function neededSourcePaths(refusal: ModelRefusal, bundle: SourceBundle): string[] {
  const omitted = new Set(bundle.omitted.map((o) => o.path));
  if (omitted.size === 0) return [];

  const out: string[] = [];
  const add = (path: string): void => {
    if (omitted.has(path) && !out.includes(path)) out.push(path);
  };

  for (const path of refusal.neededPaths ?? []) add(path);

  if (out.length === 0) {
    const prose = `${refusal.explanation} ${refusal.detail} ${refusal.suggestion ?? ''}`;
    for (const path of omitted) {
      if (prose.includes(path)) add(path);
    }
  }

  // A refusal that names half the repo is not a request for files, it is a request for a different
  // question. Pinning them all would blow the budget and evict the files that did score in.
  return out.slice(0, MAX_PINNED_RETRY_PATHS);
}

function memberOf(reach: ReachTarget | undefined): string | undefined {
  if (!reach) return undefined;
  switch (reach.plane) {
    case 'A':
    case 'B':
    case 'C':
      return reach.member;
    default:
      return undefined;
  }
}

/** The names worth scoring source files against, and worth scanning for hazards. */
function symbolsFor(reach: ReachTarget | undefined): string[] {
  if (!reach) return [];
  switch (reach.plane) {
    case 'A':
      return [reach.exportName, reach.member];
    case 'B':
      return [reach.member];
    case 'C':
      return [reach.member, ...(reach.via ? [reach.via] : [])];
    case 'D': {
      const colon = reach.commandId.indexOf(':');
      return [colon >= 0 ? reach.commandId.slice(colon + 1) : reach.commandId, reach.property];
    }
    case 'E':
      return [];
  }
}

/**
 * The mod's id — and its directory under `.obsidian/plugins/`.
 *
 * Stable for the life of the mod: a regeneration reuses it and moves only the version, because the
 * id is what Obsidian tracks a plugin by and what modkit's own records join on. The hash covers the
 * request, the target and the idempotency key, so two different requests against the same plugin
 * never collide while a retry of the same request lands on the same id.
 */
function deriveModId(request: GenerateRequest): string {
  if (request.regenerationOf?.modId) return request.regenerationOf.modId;
  const slug = targetKey(request.target)
    .toLowerCase()
    .replace(/^obsidian-/, '')
    .replace(/-plugin$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  const hash = createHash('sha256')
    .update(`${request.request}\u0000${targetKey(request.target)}\u0000${request.idempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 6);
  return `${MODKIT_MOD_ID_PREFIX}${slug || 'obsidian'}-${hash}`;
}

/**
 * Obsidian's own community-plugin list renders name + description, so the description is the one
 * place a mod announces itself with modkit not running. That is attribution work, not decoration.
 */
function defaultDescription(label: string, version: string, request: string): string {
  const intent = request.trim().replace(/\s+/g, ' ').slice(0, 90);
  return `modkit mod of ${label} ${version} — "${intent}". Managed by modkit; disable here to revert.`;
}

/**
 * Clamp the model's claimed version range so it actually contains the version it was generated
 * against.
 *
 * A range that excludes the installed version is a gate that trips on first load, leaving the mod
 * inert while it reports itself enabled — exactly the silent failure the gate exists to prevent.
 * When the model's range is unusable, pin the installed version instead: narrow and honest beats
 * wide and wrong.
 */
function sanitiseRange(range: TargetVersionRange, installed: string): TargetVersionRange {
  const pin: TargetVersionRange = { from: installed, to: null };
  if (!parseSemver(installed)) return pin;
  if (!range || !parseSemver(range.from)) return pin;
  if (cmpSemver(installed, range.from) < 0) return pin;
  if (range.to) {
    if (!parseSemver(range.to)) return { from: range.from, to: null };
    if (cmpSemver(installed, range.to) >= 0) return pin;
  }
  return { from: range.from, to: range.to ?? null };
}
