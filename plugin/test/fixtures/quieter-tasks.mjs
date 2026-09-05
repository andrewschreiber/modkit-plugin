/**
 * The end-to-end fixture's mod, in the shape the generator emits.
 *
 * It is a real patch source, not a sketch: it is fed to the daemon's **own** validator and
 * its **own** esbuild build inside `e2e.test.mjs`, so if it drifted out of the contract the e2e
 * would fail rather than quietly test a shape nothing ships. It is a trimmed cousin of the
 * daemon's `PATCH_PLUGIN_TEMPLATE` (`packages/modkit-daemon/src/prompt.ts`) — the same gates,
 * the same reclaim discipline, none of the multi-member machinery this one target does not need.
 *
 * It lives in its own file, and as `.mjs` rather than as a string in the test, so an editor lints it
 * and so the validator sees exactly the bytes a model would have produced.
 */

import { Notice, Plugin, requireApiVersion } from 'obsidian';
import { around } from 'monkey-around';

const MOD_ID = 'modkit-mod-quieter-tasks';
const MOD_LABEL = 'Mod: Quieter tasks';
const TARGET_LABEL = 'Tasks';
const TARGET_ID = 'obsidian-tasks-plugin';
const TARGET_MEMBER = 'onload';
const VERSION_FROM = '7.0.0';
const APP_MIN_VERSION = '1.7.2';

function internals(app) {
  return app;
}

function cmpSemver(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function descriptorFor(holder, name) {
  let cursor = holder;
  while (cursor) {
    const desc = Object.getOwnPropertyDescriptor(cursor, name);
    if (desc) return desc;
    cursor = Object.getPrototypeOf(cursor);
  }
  return null;
}

function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function guardUninstall(uninstall) {
  return function modkitUninstall() {
    try {
      uninstall();
    } catch (err) {
      console.error('[' + MOD_ID + '] uninstall failed: ' + describeError(err));
    }
  };
}

export default class QuieterTasks extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    this.modkitArmed = false;
    this.modkitVersionSeen = null;
    this.modkitFaulted = false;
    this.modkitHealth = { state: 'target-gone', detail: 'not checked yet' };

    if (!requireApiVersion(APP_MIN_VERSION)) {
      this.modkitHalt('target-moved', 'needs Obsidian ' + APP_MIN_VERSION + ' or newer');
      return;
    }

    const version = this.modkitTargetVersion();
    this.modkitVersionSeen = version;
    if (version === null) {
      this.modkitHalt('target-gone', TARGET_LABEL + ' is not installed or not enabled');
      return;
    }
    if (cmpSemver(version, VERSION_FROM) < 0) {
      this.modkitHalt('target-moved', TARGET_LABEL + ' ' + version + ' is below ' + VERSION_FROM);
      return;
    }

    const target = internals(this.app)?.plugins?.plugins?.['obsidian-tasks-plugin'];
    if (!target) {
      this.modkitHalt('target-gone', TARGET_LABEL + ' (' + TARGET_ID + ') is not enabled');
      return;
    }
    const holder = target.constructor?.prototype;
    if (!holder) {
      this.modkitHalt('target-gone', 'the target class has no prototype to patch');
      return;
    }

    const desc = descriptorFor(holder, TARGET_MEMBER);
    if (!desc) {
      this.modkitHalt('target-moved', TARGET_MEMBER + '() is no longer on ' + TARGET_LABEL);
      return;
    }
    if (desc.get || desc.set) {
      this.modkitHalt('error', TARGET_MEMBER + ' is an accessor — around() cannot patch it');
      return;
    }
    if (typeof desc.value !== 'function') {
      this.modkitHalt('target-moved', TARGET_MEMBER + ' is not a function any more');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)) {
      // The live object shadows the prototype with its own bound copy, so a prototype patch would
      // never be reached. The validator requires this check, and it is right to.
      this.modkitHalt(
        'error',
        TARGET_MEMBER + ' is bound on the instance, so a prototype patch would never be reached',
      );
      return;
    }
    const baseRef = desc.value;

    const self = this;
    this.register(
      guardUninstall(
        around(holder, {
          onload(next) {
            return function patched(...args) {
              if (!self.modkitArmed) return next.apply(this, args);
              self.modkitBump();
              const result = next.apply(this, args);
              try {
                console.info('[' + MOD_ID + '] ' + TARGET_LABEL + ' completion notices routed to the console');
              } catch (err) {
                self.modkitFault(err);
              }
              return result;
            };
          },
        }),
      ),
    );

    if (holder[TARGET_MEMBER] === baseRef) {
      this.modkitHalt('error', 'the patch did not take — ' + TARGET_MEMBER + ' was not replaced');
      return;
    }

    this.modkitArmed = true;
    this.modkitHealth = { state: 'applied', detail: '' };
    this.modkitPublish();
    new Notice(MOD_LABEL + ' — patched ' + TARGET_LABEL + ' ' + version);
  }

  modkitTargetVersion() {
    try {
      const host = internals(this.app);
      return (
        host?.plugins?.manifests?.['obsidian-tasks-plugin']?.version ??
        host?.plugins?.plugins?.['obsidian-tasks-plugin']?.manifest?.version ??
        null
      );
    } catch {
      return null;
    }
  }

  modkitBump() {
    this.modkitCalls += 1;
  }

  modkitHalt(state, detail) {
    this.modkitHealth = { state, detail };
    console.warn('[' + MOD_ID + '] ' + state + ': ' + detail);
    new Notice(MOD_LABEL + ' — not applied: ' + detail);
    this.modkitPublish();
  }

  modkitFault(err) {
    this.modkitHealth = { state: 'error', detail: describeError(err) };
    console.error('[' + MOD_ID + '] this modkit mod (not ' + TARGET_LABEL + ') threw: ' + describeError(err));
    if (!this.modkitFaulted) {
      this.modkitFaulted = true;
      new Notice(MOD_LABEL + ' — this modkit mod errored, not ' + TARGET_LABEL + '. See the console.');
    }
    this.modkitPublish();
  }

  modkitStatus() {
    return {
      modId: MOD_ID,
      state: this.modkitHealth.state,
      detail: this.modkitHealth.detail,
      invocations: this.modkitCalls,
      targetVersionSeen: this.modkitVersionSeen,
    };
  }

  modkitPublish() {
    try {
      const host = internals(this.app)?.plugins?.plugins?.['modkit'];
      host?.modkitReportHealth?.(MOD_ID, this.modkitStatus());
    } catch {
      /* reporting health must never be the thing that breaks a mod */
    }
  }

  async modkitProbe() {
    try {
      const before = this.modkitCalls;
      const target = internals(this.app)?.plugins?.plugins?.['obsidian-tasks-plugin'];
      if (!target) return false;
      const method = target[TARGET_MEMBER];
      if (typeof method !== 'function') return false;
      method.call(target);
      return this.modkitCalls > before;
    } catch {
      return false;
    }
  }
}
