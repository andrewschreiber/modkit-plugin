/**
 * The mod template's health state machine, executed rather than read.
 *
 * `PATCH_PLUGIN_TEMPLATE` is the only source for a generated mod's health reporting — the model
 * copies it, the validator checks it, and nothing else in the repo defines it. Until this file, it
 * had **no executable coverage at all**: `plugin/test/e2e.test.mjs` runs
 * `fixtures/quieter-tasks.mjs`, a hand-written mod that omits `modkitCheckNoEffect` entirely. So
 * the one place the no-effect machine had ever actually run was a real live vault, and there it
 * gave the wrong answer (E3, 2026-09-03: a mod that was demonstrably filtering tasks reported
 * `no-effect` for hours).
 *
 * These tests build the template itself, so the thing under test is the thing that ships. Two hand
 * copies of the template do still exist in `validate.test.mjs` — `REPLAY_BASE` and the compliant
 * `GOOD` fixture — but they are validator *shape* fixtures that are never executed as a state
 * machine, and `REPLAY_BASE` is re-synced with this file's changes rather than left to rot.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test, { describe, before } from 'node:test';

import { buildPatchPlugin } from '../dist/build.js';
import { PATCH_PLUGIN_TEMPLATE } from '../dist/prompt.js';

const TARGET_ID = 'obsidian-tasks-plugin';

/** The built bundle. Evaluated fresh per test, so each mod closes over its own Notice sink. */
let BUILT;

/** The subset of `obsidian` the template imports. */
function obsidianStub(notices) {
  class Notice {
    constructor(message) {
      notices.push(String(message));
    }
  }
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._registered = [];
      this._intervals = [];
    }
    register(cb) {
      this._registered.push(cb);
    }
    registerInterval(id) {
      this._intervals.push(id);
      return id;
    }
  }
  return { Notice, Plugin, requireApiVersion: () => true };
}

function evaluateMod(code, stub) {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`,
    { filename: 'template-main.js' },
  );
  wrapper(
    module.exports,
    (id) => {
      if (id === 'obsidian') return stub;
      throw new Error(`the template asked its host for "${id}"`);
    },
    module,
    'template-main.js',
    '.',
  );
  return module.exports.default ?? module.exports;
}

/**
 * A target whose `getTasks` lives on the prototype — the shape the template's checks demand. An
 * object literal would have `Object` as its constructor, so patching its prototype would be a bug
 * in the harness rather than a test of the mod.
 */
function makeWorld({ targetReturnsNonArray = false } = {}) {
  class TasksPlugin {}
  TasksPlugin.prototype.getTasks = function getTasks() {
    // A non-array makes the generated change (`result.filter(...)`) throw, which is the only throw
    // the mod owns. The target's own call sits OUTSIDE the wrapper's try on purpose, so a target
    // that throws is never attributed to the mod — that asymmetry is the point of modkitFault.
    if (targetReturnsNonArray) return null;
    return [{ description: 'alpha' }, { description: 'E3HIDE bravo' }];
  };

  const published = [];
  const target = new TasksPlugin();
  const app = {
    plugins: {
      manifests: { [TARGET_ID]: { version: '7.14.0' } },
      plugins: {
        [TARGET_ID]: target,
        modkit: {
          modkitReportHealth(modId, status) {
            published.push({ modId, ...status });
          },
        },
      },
    },
  };
  return { app, target, published };
}

/**
 * One mod, one world, one Notice sink. The class is re-evaluated per call rather than once in
 * `before()`: the generated module closes over whatever `obsidian` stub it was evaluated against,
 * so a shared class would send every mod's Notices into the first stub's array and any assertion
 * on `notices` would be vacuously green.
 */
async function loadMod(worldOpts) {
  const notices = [];
  const ModClass = evaluateMod(BUILT.code, obsidianStub(notices));
  const world = makeWorld(worldOpts);
  const mod = new ModClass(world.app, { id: 'modkit-mod-tasks-test', version: '0.1.0' });
  await mod.onload();
  return { mod, notices, ...world };
}

/**
 * The same template with its one mode constant flipped — which is exactly the edit a generated mod
 * makes. The shipped default is `on-demand`, so without this the event-driven half of the health
 * machine (the half E3 exercised, and the half that was wrong) would never be executed here.
 */
let BUILT_EVENT_DRIVEN;

async function loadEventDrivenMod() {
  const notices = [];
  const ModClass = evaluateMod(BUILT_EVENT_DRIVEN.code, obsidianStub(notices));
  const world = makeWorld();
  const mod = new ModClass(world.app, { id: 'modkit-mod-tasks-test', version: '0.1.0' });
  await mod.onload();
  return { mod, notices, ...world };
}

before(async () => {
  // An event-driven mod schedules its safety-net check on the bare `window`. Stubbed rather than
  // scheduled: every test here drives `modkitCheckNoEffect()` by hand, and a real timer would leak
  // past the test that armed it.
  if (globalThis.window === undefined) {
    globalThis.window = { setInterval: () => 0, clearInterval: () => {} };
  }

  BUILT = await buildPatchPlugin(PATCH_PLUGIN_TEMPLATE);
  assert.ok(BUILT.ok, `the shipped template no longer builds: ${JSON.stringify(BUILT).slice(0, 400)}`);
  const ModClass = evaluateMod(BUILT.code, obsidianStub([]));
  assert.equal(typeof ModClass, 'function', 'the template must default-export a class');

  const eventDriven = PATCH_PLUGIN_TEMPLATE.replace(
    'const NO_EFFECT_MODE = "on-demand";',
    'const NO_EFFECT_MODE = "event-driven";',
  );
  assert.notEqual(eventDriven, PATCH_PLUGIN_TEMPLATE, 'the NO_EFFECT_MODE declaration moved — fix this replace');
  BUILT_EVENT_DRIVEN = await buildPatchPlugin(eventDriven);
  assert.ok(BUILT_EVENT_DRIVEN.ok, 'the event-driven variant no longer builds');
});

/**
 * E3's finding 1, at the mod's own layer. The install-time half lives in
 * `plugin/test/installer.test.mjs`; this is the half the mod controls.
 */
describe('an event-driven mod does not claim an effect it has not had', () => {
  test('arms as no-effect, with the sentence that tells the user how to see it', async () => {
    const { mod } = await loadEventDrivenMod();

    const status = mod.modkitStatus();
    assert.equal(status.state, 'no-effect', 'nothing has called the member, so applied would be a lie');
    assert.equal(status.invocations, 0);
    assert.match(status.detail, /has not run yet/);
    assert.match(status.detail, /until it is used again/, 'the detail must say what makes it show');
  });

  test('the first real call promotes it at once, not at the next deadline', async () => {
    const { mod, target, published } = await loadEventDrivenMod();
    assert.equal(mod.modkitStatus().state, 'no-effect');

    target.getTasks();

    assert.equal(mod.modkitStatus().state, 'applied', 'promoted on the call, with no interval tick');
    assert.equal(published.at(-1).state, 'applied', 'and it reached the ledger');
  });

  test('it publishes the promotion once, not on every call', async () => {
    const { mod, target, published } = await loadEventDrivenMod();
    target.getTasks();
    const after = published.length;

    target.getTasks();
    target.getTasks();

    assert.equal(published.length, after, 'the target call path must not pay for a publish per call');
    assert.equal(mod.modkitStatus().invocations, 3);
  });

  test('a probe still cannot manufacture the promotion', async () => {
    const { mod } = await loadEventDrivenMod();
    assert.equal(await mod.modkitProbe(), true);
    assert.equal(mod.modkitStatus().state, 'no-effect', 'modkit asking the mod to prove itself is not evidence');
  });

  test('an on-demand mod is applied the moment it arms — it has no call to wait for', async () => {
    const { mod } = await loadMod();
    assert.equal(mod.modkitStatus().state, 'applied');
  });
});

describe('the template applies at all', () => {
  test('it patches the prototype and reports applied', async () => {
    const { mod, target } = await loadMod();
    assert.equal(mod.modkitStatus().state, 'applied');
    assert.equal(mod.modkitStatus().targetVersionSeen, '7.14.0');
    target.getTasks();
    assert.equal(mod.modkitStatus().invocations, 1, 'the wrapper must be on the call path');
  });
});

describe('modkitCheckNoEffect', () => {
  test('demotes to no-effect while nothing has called the member', async () => {
    const { mod } = await loadMod();
    mod.modkitCheckNoEffect();
    assert.equal(mod.modkitStatus().state, 'no-effect');
  });

  /**
   * The E3 regression. A plane-C mod on a cache-fill path patches a method the target only calls
   * when it re-parses a file, so a target whose cache was already warm at install time calls
   * nothing for as long as the user does not edit. The row demoted, and — before this fix — never
   * came back, so a mod that was provably filtering tasks read as broken for the rest of the
   * session.
   */
  test('promotes back to applied once the wrapper has actually run', async () => {
    const { mod, target, published } = await loadMod();

    mod.modkitCheckNoEffect();
    assert.equal(mod.modkitStatus().state, 'no-effect', 'precondition: the row was demoted');

    target.getTasks();
    mod.modkitCheckNoEffect();

    assert.equal(mod.modkitStatus().state, 'applied', 'silence ended, so the demotion must be withdrawn');
    const pushed = published.at(-1);
    assert.equal(
      pushed.state,
      'applied',
      'the promotion has to reach modkit, not just the mod — the ledger is what the user reads',
    );
    // The two fields every non-mod writer in the plugin drops. Pinned here because the promotion is
    // one of the few writes that carries them, and because E3 watched them vanish from a live row.
    assert.equal(pushed.invocations, 1);
    assert.equal(pushed.targetVersionSeen, '7.14.0');
  });

  test('the demotion is a row, not a toast', async () => {
    const { mod, notices } = await loadMod();
    const before = notices.length;
    mod.modkitCheckNoEffect();
    assert.equal(mod.modkitStatus().state, 'no-effect');
    assert.equal(
      notices.length,
      before,
      'silence so far is not a failure, and a toast cannot be withdrawn when the row is',
    );
  });

  test('a further check does not re-demote a mod that is still being called', async () => {
    const { mod, target } = await loadMod();
    mod.modkitCheckNoEffect();
    target.getTasks();
    mod.modkitCheckNoEffect();
    mod.modkitCheckNoEffect();
    assert.equal(mod.modkitStatus().state, 'applied');
  });

  /* ── containment: no-effect is the only state this check owns ── */

  test('never promotes out of error — a call count cannot overturn a throw', async () => {
    const { mod, target } = await loadMod();
    mod.modkitFault(new Error('the mod threw'));
    assert.equal(mod.modkitStatus().state, 'error');

    target.getTasks();
    mod.modkitCheckNoEffect();

    assert.equal(mod.modkitStatus().state, 'error', 'error is a verdict, not a report of silence');
  });

  /**
   * The reason `modkitCalls` and `modkitProbeCalls` are separate. `modkitProbe()` exercises the
   * wrapper on purpose, so if its call counted, "verify now" would promote a row to `applied`
   * having proved only that the probe works — modkit certifying its own mod on no evidence. The
   * promote-back arm turns what used to be a harmless false negative into a false positive, which
   * is why the split had to land in the same change.
   */
  test('a probe call is not evidence: modkitProbe cannot promote its own row', async () => {
    const { mod } = await loadMod();
    mod.modkitCheckNoEffect();
    assert.equal(mod.modkitStatus().state, 'no-effect');

    const probed = await mod.modkitProbe();
    assert.equal(probed, true, 'the probe must still be able to observe its own call');

    mod.modkitCheckNoEffect();
    assert.equal(
      mod.modkitStatus().state,
      'no-effect',
      'the app never called the member, so the row must stay demoted',
    );
    assert.equal(mod.modkitStatus().invocations, 0, 'a probe must not inflate the reported count');
  });

  /**
   * The load-bearing ordering behind the whole containment argument: `modkitBump()` runs BEFORE the
   * generated change, so a change that throws leaves `modkitCalls > 0` AND `state === "error"`
   * simultaneously. If the guard were `calls > 0` alone, that mod would launder itself back to
   * `applied` on the next tick.
   */
  /**
   * `calls > 0` and `error` can hold at the same time, and that co-occurrence is the whole reason
   * the guard tests the state rather than the counter alone: `modkitBump()` runs BEFORE the try
   * block, so a change that throws has already been counted by the time it faults.
   *
   * The limitation worth stating: the template's try body is an empty placeholder — the generated
   * change goes there — so a genuinely throwing change cannot be exercised against the template
   * itself, and the fault is induced directly here. What this pins is the guard's behaviour under
   * that state pair, not the wrapper's own catch.
   */
  test('calls>0 and error co-occur, and the tick does not launder it back', async () => {
    const { mod, target } = await loadMod();
    target.getTasks();
    assert.ok(mod.modkitStatus().invocations > 0, 'the bump precedes the change, not follows it');

    mod.modkitFault(new Error('the change threw'));
    mod.modkitCheckNoEffect();

    assert.equal(
      mod.modkitStatus().state,
      'error',
      'a counter-only guard would launder a throwing mod back to applied',
    );
  });

  test('never promotes out of target-gone', async () => {
    const { mod, target } = await loadMod();
    mod.modkitHalt('target-gone', 'the target went away');

    target.getTasks();
    mod.modkitCheckNoEffect();

    assert.equal(mod.modkitStatus().state, 'target-gone');
  });

  test('never promotes out of target-moved', async () => {
    const { mod, target } = await loadMod();
    mod.modkitHalt('target-moved', 'the target moved');

    target.getTasks();
    mod.modkitCheckNoEffect();

    assert.equal(mod.modkitStatus().state, 'target-moved');
  });

  test('does nothing at all when the patch never armed', async () => {
    const { mod } = await loadMod();
    mod.modkitArmed = false;
    mod.modkitHealth = { state: 'no-effect', detail: 'stale' };
    mod.modkitCalls = 5;

    mod.modkitCheckNoEffect();

    assert.equal(mod.modkitStatus().state, 'no-effect', 'an unarmed mod reports nothing either way');
  });
});
