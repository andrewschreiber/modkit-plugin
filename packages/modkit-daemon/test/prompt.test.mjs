/**
 * `withholdCompletenessRuleIds` used to string-edit three rule ids
 * (`missing-version-gate`, `accessor-target`, `bound-method-target`) back out of the system prompt
 * at the point of the model call, because `RECLAIM_CONTRACT` in `prompt.ts` wrote them in as bullet
 * heads in the first place. That was two places doing the same job for one fact; the fix is for
 * `RECLAIM_CONTRACT` to simply never write the ids in.
 *
 * This asserts the built-in system prompt — what the model actually sees — contains none of the
 * three ids, while the requirement text they used to head is still there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGenerationPrompt, CSS_MODE_EXAMPLE, GENERATION_SCHEMA, parseGenerationOutput, SYSTEM_PROMPT } from '../dist/prompt.js';

const WITHHELD_IDS = ['missing-version-gate', 'accessor-target', 'bound-method-target'];

test('SYSTEM_PROMPT never names the three completeness rule ids', () => {
  for (const id of WITHHELD_IDS) {
    assert.ok(
      !SYSTEM_PROMPT.includes(id),
      `SYSTEM_PROMPT should not contain the withheld rule id "${id}"`,
    );
  }
});

test('SYSTEM_PROMPT still states the three completeness requirements, without their ids', () => {
  assert.match(
    SYSTEM_PROMPT,
    /read the \*\*target's own\*\* version off the/,
    'the version-gate requirement text should survive',
  );
  assert.match(
    SYSTEM_PROMPT,
    /getOwnPropertyDescriptor/,
    'the accessor-target requirement text should survive',
  );
  assert.match(
    SYSTEM_PROMPT,
    /hasOwnProperty\.call/,
    'the bound-method-target requirement text should survive',
  );
});

test('SYSTEM_PROMPT no longer promises every rule is named', () => {
  assert.ok(
    !SYSTEM_PROMPT.includes('the validator rejects on exactly these, by id'),
    'the intro line should no longer promise every rule is named',
  );
});

/*
 * L1 — a plane-E css-mode mod must ship its rules as `stylesCss`, never as a `<style>` element
 * written from `main.js` (PLAN.md's "Where this actually is": every generated CSS mod so far did
 * `activeDocument.head.appendChild(style)`, which lands in whichever window is active rather than
 * the one Obsidian would apply `styles.css` to). These assert the instruction actually reached the
 * model — both in the fixed system prompt and in a real per-request build.
 */

test('SYSTEM_PROMPT tells the model to use stylesCss for a css-mode plane-E mod, not a <style> element', () => {
  assert.match(SYSTEM_PROMPT, /stylesCss/, 'stylesCss must be named somewhere in the system prompt');
  assert.match(
    SYSTEM_PROMPT,
    /reachMode.*"css"/s,
    'the css-mode guidance for plane E must be present',
  );
  assert.match(
    SYSTEM_PROMPT,
    /no styling work at all/,
    'the system prompt must say a css-mode onload() does no styling work',
  );
  // Named as the remedy the validator's own rejection points at — see `inject-stylesheet` in
  // validate.ts, whose message text this must stay consistent with.
  assert.match(SYSTEM_PROMPT, /Obsidian opens Settings as a.*separate window/);
  // The example the model is shown for this case ships in the prompt verbatim.
  assert.ok(SYSTEM_PROMPT.includes(CSS_MODE_EXAMPLE), 'CSS_MODE_EXAMPLE must be embedded in the system prompt');
});

/*
 * `reachMode` is optional in GENERATION_SCHEMA (only `outcome`/`explanation` are in `required`, the
 * same as every other plane's reach fields), so an absent or mis-cased value used to default to
 * `css` silently. That turned a dom-mode plane-E answer that simply omitted the field into a mod
 * validated as css-mode, rejected by `css-mod-without-stylesheet` with a reclaim-contract message
 * that has nothing to do with the actual (metadata) problem. `reachFrom` now treats "not exactly
 * css or dom" as an incomplete reach, the same as a missing selector.
 */
const patchBase = { outcome: 'patch', explanation: 'x', source: 'export default class M {}', plane: 'E', reachSelector: '.x' };

test('parseGenerationOutput: plane E with reachMode omitted is an incomplete reach, not a silent css default', () => {
  const result = parseGenerationOutput({ ...patchBase });
  assert.equal(result.ok, false);
  assert.match(result.error, /reach fields for plane "E" were incomplete/);
});

test('parseGenerationOutput: plane E with a mis-cased reachMode ("DOM") is also incomplete, not silently "css"', () => {
  const result = parseGenerationOutput({ ...patchBase, reachMode: 'DOM' });
  assert.equal(result.ok, false);
  assert.match(result.error, /reach fields for plane "E" were incomplete/);
});

test('parseGenerationOutput: plane E with reachMode "dom" stated correctly parses as dom-mode', () => {
  const result = parseGenerationOutput({ ...patchBase, reachMode: 'dom' });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'patch');
  assert.deepEqual(result.value.patch.reach, { plane: 'E', selector: '.x', mode: 'dom' });
});

test('parseGenerationOutput: plane E with reachMode "css" stated correctly parses as css-mode', () => {
  const result = parseGenerationOutput({ ...patchBase, reachMode: 'css' });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'patch');
  assert.deepEqual(result.value.patch.reach, { plane: 'E', selector: '.x', mode: 'css' });
});

test('a built prompt for a css-mode plane-E request carries the stylesCss instruction', () => {
  const built = buildGenerationPrompt({
    request: 'hide the search tab icon',
    target: { kind: 'plugin', pluginId: 'x', pluginName: 'X', version: '1.0.0' },
    proposedReach: { plane: 'E', selector: '.workspace-tab-header[data-type="search"]', mode: 'css' },
    modId: 'modkit-mod-x-1234',
    modVersion: '0.1.0',
    minAppVersion: '1.7.2',
  });
  assert.match(
    built.prompt,
    /reachMode.*is.*"css".*put every rule in `stylesCss`/s,
    `the per-request instructions must tell the model what a css-mode plane-E answer looks like:\n${built.prompt}`,
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * refusalNeededPaths — the field that turns a `no-source-available` refusal into a retry
 * ──────────────────────────────────────────────────────────────────────────── */

const refusalBase = {
  outcome: 'refusal',
  refusalReason: 'no-source-available',
  explanation: 'The file that does this was not included.',
  refusalDetail: 'src/Obsidian/Cache.ts is in the omitted list.',
};

test('parseGenerationOutput: refusalNeededPaths reaches the pipeline', () => {
  const result = parseGenerationOutput({ ...refusalBase, refusalNeededPaths: ['src/Obsidian/Cache.ts'] });
  assert.ok(result.ok);
  assert.equal(result.value.kind, 'refusal');
  assert.deepEqual(result.value.refusal.neededPaths, ['src/Obsidian/Cache.ts']);
});

test('parseGenerationOutput: no refusalNeededPaths leaves the key absent, not an empty array', () => {
  const result = parseGenerationOutput({ ...refusalBase });
  assert.ok(result.ok);
  assert.equal('neededPaths' in result.value.refusal, false, 'absent means "did not ask", not "asked for nothing"');
});

test('parseGenerationOutput: a malformed refusalNeededPaths is dropped, never a parse failure', () => {
  // A pipeline failure here would throw away a refusal that is otherwise correct and useful.
  for (const bad of ['src/Obsidian/Cache.ts', 42, null, {}, [1, 2], [''], ['   ']]) {
    const result = parseGenerationOutput({ ...refusalBase, refusalNeededPaths: bad });
    assert.ok(result.ok, `refusalNeededPaths: ${JSON.stringify(bad)} should still parse`);
    assert.equal('neededPaths' in result.value.refusal, false);
  }
});

test('parseGenerationOutput: entries are trimmed and de-duplicated', () => {
  const result = parseGenerationOutput({
    ...refusalBase,
    refusalNeededPaths: ['  src/Obsidian/Cache.ts  ', 'src/Obsidian/Cache.ts', '', 'src/Query/Query.ts'],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.refusal.neededPaths, ['src/Obsidian/Cache.ts', 'src/Query/Query.ts']);
});

test('GENERATION_SCHEMA declares refusalNeededPaths as a string array', () => {
  const prop = GENERATION_SCHEMA.properties.refusalNeededPaths;
  assert.equal(prop.type, 'array');
  assert.equal(prop.items.type, 'string');
  assert.match(prop.description, /no-source-available/);
});
