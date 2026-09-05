/**
 * Adversarial tests for the generated-code validator, and for the build that follows it.
 *
 * These are the evidence behind PLAN §M3's third number — *how many generated mods silently did
 * nothing* — which is the one that must be zero. So they are written as attacks, not as ceremony:
 * every rule gets a fixture that breaks it, and every rule that can be evaded gets a fixture that
 * tries. A test that only proves the good case passes proves nothing about a validator, because the
 * failure mode of a validator is a false *negative*.
 *
 * Runs against the package's build output (`../dist/*.js`), which `npm test` produces first.
 *
 * It used to import `../src/*.ts` directly and lean on Node's built-in type stripping, which is
 * nicer — nothing stands between the test and the code. It was changed because the node that
 * `npm run` resolves on this box is not the node on the interactive PATH (measured 2026-08-31:
 * v20.17.0 vs v24.19.0), so `npm test` failed with ERR_UNKNOWN_FILE_EXTENSION while
 * `node --test` on the same file passed 36/36. A test suite whose result depends on which node
 * happened to answer is not a test suite. Revert this the day the repo pins its own runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCssModeStylesheet, validate, validateSource } from '../dist/validate.js';
import { assertObsidianShape, buildPatchPlugin, sha256Hex, stopBuilder } from '../dist/build.js';
import { buildCorrectionPrompt, CSS_MODE_EXAMPLE, PATCH_PLUGIN_TEMPLATE } from '../dist/prompt.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const rules = (findings) => [...new Set(findings.map((f) => f.rule))].sort();
const countOf = (findings, rule) => findings.filter((f) => f.rule === rule).length;
const show = (findings) =>
  findings.map((f) => `${f.rule} @${f.line}:${f.column} — ${f.message}`).join('\n');

/** Assert a fixture is clean, and print what went wrong when it is not. */
function assertClean(source, label) {
  const findings = validate(source);
  assert.deepEqual(findings, [], `${label} should validate clean, got:\n${show(findings)}`);
}

/** Assert a fixture trips exactly the rules named, and no others. */
function assertRules(source, expected, label) {
  const findings = validate(source);
  assert.deepEqual(
    rules(findings),
    [...expected].sort(),
    `${label}\n${show(findings)}`,
  );
  return findings;
}

/** Assert a fixture trips at least the rules named. */
function assertIncludes(source, expected, label) {
  const findings = validate(source);
  for (const rule of expected) {
    assert.ok(
      findings.some((f) => f.rule === rule),
      `${label}: expected rule "${rule}"\n${show(findings)}`,
    );
  }
  return findings;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The compliant fixture — a faithful, minimal plain-JS rendering of PATCH_PLUGIN_TEMPLATE
 * ──────────────────────────────────────────────────────────────────────────── */

const GOOD = `import { Notice, Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

const MOD_ID = "modkit-mod-example";
const MOD_LABEL = "Mod: Example";
const TARGET_LABEL = "Example Plugin";
const TARGET_MEMBER = "someMethod";
const VERSION_FROM = "0.0.0";
const APP_MIN_VERSION = "1.7.2";

function cmpSemver(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
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

function guardUninstall(uninstall) {
  return function modkitUninstall() {
    try { uninstall(); } catch (err) { console.error("[" + MOD_ID + "] " + String(err)); }
  };
}

export default class ModkitPatchPlugin extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    this.modkitArmed = false;
    this.modkitHealth = { state: "target-gone", detail: "not checked yet" };

    if (!requireApiVersion(APP_MIN_VERSION)) { this.modkitHalt("target-moved", "needs a newer Obsidian"); return; }
    const version = this.modkitTargetVersion();
    if (version === null) { this.modkitHalt("target-gone", TARGET_LABEL + " is not enabled"); return; }
    if (cmpSemver(version, VERSION_FROM) < 0) { this.modkitHalt("target-moved", "below " + VERSION_FROM); return; }

    const target = this.app?.plugins?.plugins?.["example-plugin-id"];
    if (!target) { this.modkitHalt("target-gone", TARGET_LABEL + " is not enabled"); return; }
    const holder = target.constructor?.prototype;
    if (!holder) { this.modkitHalt("target-gone", "no prototype"); return; }

    const desc = descriptorFor(holder, TARGET_MEMBER);
    if (!desc) { this.modkitHalt("target-moved", TARGET_MEMBER + " is gone"); return; }
    if (desc.get || desc.set) { this.modkitHalt("error", TARGET_MEMBER + " is an accessor"); return; }
    if (typeof desc.value !== "function") { this.modkitHalt("target-moved", "not a function"); return; }
    if (desc.writable === false && desc.configurable === false) { this.modkitHalt("error", "non-writable"); return; }
    if (Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)) { this.modkitHalt("error", "bound on the instance"); return; }
    const baseRef = desc.value;

    const self = this;
    this.register(guardUninstall(around(holder, {
      someMethod(next) {
        return function (...args) {
          if (!self.modkitArmed) return next.apply(this, args);
          self.modkitBump();
          return next.apply(this, args);
        };
      },
    })));

    if (holder[TARGET_MEMBER] === baseRef) { this.modkitHalt("error", "the patch did not take"); return; }

    this.modkitArmed = true;
    this.modkitHealth = { state: "applied", detail: "" };
    this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), 30000));
    new Notice(MOD_LABEL + " — patched " + TARGET_LABEL + " " + version);
  }

  modkitTargetVersion() {
    try {
      return this.app?.plugins?.manifests?.["example-plugin-id"]?.version ?? null;
    } catch { return null; }
  }

  modkitBump() { this.modkitCalls += 1; }

  modkitHalt(state, detail) {
    this.modkitHealth = { state: state, detail: detail };
    console.warn("[" + MOD_ID + "] " + state + ": " + detail);
    new Notice(MOD_LABEL + " — not applied: " + detail);
  }

  modkitCheckNoEffect() {
    if (this.modkitArmed !== true) return;
    if (this.modkitCalls > 0) return;
    this.modkitHealth = { state: "no-effect", detail: TARGET_MEMBER + " was never called" };
    new Notice(MOD_LABEL + " — installed, but nothing has called " + TARGET_MEMBER + "() yet.");
  }

  modkitStatus() {
    return { modId: MOD_ID, state: this.modkitHealth.state, detail: this.modkitHealth.detail, invocations: this.modkitCalls };
  }

  async modkitProbe() {
    const before = this.modkitCalls;
    const target = this.app?.plugins?.plugins?.["example-plugin-id"];
    if (!target || typeof target[TARGET_MEMBER] !== "function") return false;
    target[TARGET_MEMBER]();
    return this.modkitCalls > before;
  }
}
`;

/* A plane-E mod: no around() at all, DOM through the documented globals and the reclaim contract. */
// `dom`-mode, not `css`-mode: it mutates an element it did not create (addClass/removeClass) rather
// than shipping a stylesheet, which is `stylesCss`'s job now that `inject-stylesheet` (added for L1)
// rejects a plane-E mod that builds a <style> element from JavaScript — see the `inject-stylesheet`
// suite below for that fixture instead. This one still exercises the same three DOM reclaim shapes
// the comment on its one caller names: activeDocument, registerDomEvent, and a register()'d teardown.
const GOOD_PLANE_E = `import { Notice, Plugin } from "obsidian";

const MOD_ID = "modkit-mod-dim-titles";
const MOD_LABEL = "Mod: dim the note titles";

export default class ModkitPatchPlugin extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    const el = activeDocument.querySelector(".inline-title");
    el?.addClass(MOD_ID);
    this.register(() => el?.removeClass(MOD_ID));
    this.registerDomEvent(activeDocument, "click", () => this.modkitBump());
    new Notice(MOD_LABEL + " — applied");
  }

  modkitBump() { this.modkitCalls += 1; }

  async modkitProbe() {
    return activeDocument.querySelector("." + MOD_ID) !== null;
  }
}
`;

/* ────────────────────────────────────────────────────────────────────────────
 * The compliant cases
 * ──────────────────────────────────────────────────────────────────────────── */

test('a template-shaped patch validates with zero findings', () => {
  assertClean(GOOD, 'the compliant fixture');
  const report = validateSource(GOOD);
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('a plane-E DOM/CSS mod validates with zero findings', () => {
  // No around(), so the patch-specific contract rules stay quiet — but the reclaim rules do not:
  // this fixture uses activeDocument (a documented Obsidian global), registerDomEvent, and a
  // register()'d teardown, and would fail if any of those were written the easy way.
  assertClean(GOOD_PLANE_E, 'the plane-E fixture');
});

test('the two sanctioned global acquisitions are permitted, and only in their exact position', () => {
  // The rules ban `document` and `window` by name; these two forms are permitted by *node identity*
  // instead. If this goes red the ban has swallowed the contract it exists to enforce.
  const source = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    this.registerDomEvent(document.body, "click", () => {});
    this.registerInterval(window.setInterval(() => {}, 1000));
  }
  async modkitProbe() { return true; }
}
`;
  assertClean(source, 'the sanctioned acquisition forms');
});

test('PATCH_PLUGIN_TEMPLATE validates with zero findings', () => {
  // The template is the canonical passing case — it is what the model is shown and what the
  // validator checks. If this goes red, the two have drifted apart, and every mod generated from
  // the template inherits the drift.
  assertClean(PATCH_PLUGIN_TEMPLATE, 'the template');
});

test('esbuild\'s `export { X as default }` rewrite is accepted', () => {
  // esbuild's ts→esm transform turns `export default class X` into a class declaration plus a bare
  // ExportNamedDeclaration. A validator that only knows ExportDefaultDeclaration rejects its own
  // template — this cost a false positive during recon.
  const rewritten = GOOD.replace(
    'export default class ModkitPatchPlugin extends Plugin {',
    'class ModkitPatchPlugin extends Plugin {',
  ).concat('\nexport { ModkitPatchPlugin as default };\n');
  assertClean(rewritten, 'the export-rewritten fixture');
});

/* ────────────────────────────────────────────────────────────────────────────
 * One fixture per rule
 * ──────────────────────────────────────────────────────────────────────────── */

test('parse: an unparseable source is one finding, not a thrown exception', () => {
  const findings = validate('export default class { ');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'parse');
  assert.equal(findings[0].severity, 'error');
  assert.ok(findings[0].line >= 1 && findings[0].column >= 1);
});

test('no-top-level-side-effects: anything that runs at module scope', () => {
  const source = `import { Plugin } from "obsidian";
console.log("hello");
let counter = 0;
const now = Date.now();
export default class M extends Plugin { async modkitProbe() { return true; } }
`;
  const findings = assertIncludes(source, ['no-top-level-side-effects'], 'top-level statements');
  // the ExpressionStatement, the `let`, and the `const` with a call initialiser
  assert.equal(countOf(findings, 'no-top-level-side-effects'), 3, show(findings));
});

test('no-bare-global: a banned global read outside a sanctioned acquisition', () => {
  const source = GOOD.replace(
    'this.modkitCalls = 0;',
    'this.modkitCalls = 0;\n    const d = document.body;\n    void d;',
  );
  assertRules(source, ['no-bare-global'], 'a bare document read');
});

test('no-bare-global: the handler body of registerDomEvent gets no exemption', () => {
  // registerDomEvent sanctions argument 0 — the element expression — and nothing else. A handler is
  // ordinary code, and this is the shape an ancestor-based test would wave through.
  const source = GOOD_PLANE_E.replace(
    'this.registerDomEvent(activeDocument, "click", () => this.modkitBump());',
    'this.registerDomEvent(activeDocument, "click", () => { localStorage.setItem("x", "1"); });',
  );
  assertRules(source, ['no-bare-global'], 'a global read inside a registered handler');
});

test('no-host-assignment: assigning to something the mod does not own', () => {
  const source = GOOD.replace(
    'const baseRef = desc.value;',
    'const baseRef = desc.value;\n    holder.someMethod = function () {};',
  );
  assertRules(source, ['no-host-assignment'], 'a direct prototype assignment');
});

test('no-raw-timer: a bare timer, and one smuggled through register()', () => {
  const bare = GOOD.replace(
    'this.modkitArmed = true;',
    'this.modkitArmed = true;\n    setInterval(() => this.modkitBump(), 1000);',
  );
  assertIncludes(bare, ['no-raw-timer', 'no-bare-global'], 'a bare setInterval');

  // registerInterval sanctions `window.setInterval(...)` as its direct argument. A bare
  // `setInterval` handed to it is still a raw timer, because nothing has reclaimed the *global*.
  const smuggled = GOOD.replace(
    'this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), 30000));',
    'this.registerInterval(setInterval(() => this.modkitCheckNoEffect(), 30000));',
  );
  assertIncludes(smuggled, ['no-raw-timer', 'no-bare-global'], 'setInterval smuggled through registerInterval');
});

test('no-raw-listener: addEventListener is never acceptable, however it is written', () => {
  const plain = GOOD_PLANE_E.replace(
    'this.registerDomEvent(activeDocument, "click", () => this.modkitBump());',
    'activeDocument.addEventListener("click", () => this.modkitBump());',
  );
  assertRules(plain, ['no-raw-listener'], 'a plain addEventListener');

  // The concatenation evasion: a name-based rule that does not fold static strings misses this
  // entirely, which is the exact objection to validating with regexes.
  const concatenated = GOOD_PLANE_E.replace(
    'this.registerDomEvent(activeDocument, "click", () => this.modkitBump());',
    'activeDocument["add" + "Event" + "Listener"]("click", () => this.modkitBump());',
  );
  assertRules(concatenated, ['no-raw-listener'], 'a concatenated addEventListener');
});

test('patch-must-be-registered: around() outside this.register()', () => {
  const source = GOOD.replace(
    'this.register(guardUninstall(around(holder, {',
    'const un = around(holder, {',
  )
    .replace('    })));', '    });\n    void un;');
  assertIncludes(source, ['patch-must-be-registered'], 'an unregistered around()');
});

test('no-eval: eval, new Function, and dynamic import', () => {
  const source = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  async onload() {
    const f = new Function("return 1");
    void f;
    void eval("1 + 1");
    void import("obsidian");
  }
  async modkitProbe() { return true; }
}
`;
  const findings = assertIncludes(source, ['no-eval'], 'code-loading constructs');
  assert.equal(countOf(findings, 'no-eval'), 3, show(findings));
});

test('import-not-allowed: anything but obsidian and monkey-around, node: loudest of all', () => {
  const node = GOOD.replace(
    'import { around } from "monkey-around";',
    'import { around } from "monkey-around";\nimport { readFileSync } from "node:fs";',
  );
  const findings = assertIncludes(node, ['import-not-allowed'], 'a node: import');
  assert.match(
    findings.find((f) => f.rule === 'import-not-allowed').message,
    /external.*node:|node:.*external/i,
    'the message must say why node: specifically breaks the build',
  );

  const third = GOOD.replace(
    'import { around } from "monkey-around";',
    'import { around } from "monkey-around";\nimport { moment } from "obsidian-tasks-plugin";',
  );
  assertIncludes(third, ['import-not-allowed'], 'a third-party import');

  // The allowlist is a parameter, so a caller can prove the rule actually reads it.
  assert.equal(
    validate(GOOD, { allowedImports: ['obsidian'] }).some((f) => f.rule === 'import-not-allowed'),
    true,
  );
});

test('default-export-must-extend-plugin: missing, wrong shape, wrong superclass, or doubled', () => {
  const noDefault = GOOD.replace('export default class ModkitPatchPlugin', 'class ModkitPatchPlugin');
  assertIncludes(noDefault, ['default-export-must-extend-plugin'], 'no default export');

  const notAClass = `import { Plugin } from "obsidian";
function make() { return new Plugin(); }
export default make;
`;
  assertIncludes(notAClass, ['default-export-must-extend-plugin'], 'a non-class default export');

  const wrongSuper = GOOD.replace(
    'export default class ModkitPatchPlugin extends Plugin {',
    'export default class ModkitPatchPlugin extends Object {',
  );
  assertIncludes(wrongSuper, ['default-export-must-extend-plugin'], 'the wrong superclass');
});

test('no-dynamic-host-member: a computed key into the host graph', () => {
  const source = GOOD.replace(
    'this.app?.plugins?.plugins?.["example-plugin-id"];',
    'this.app?.plugins?.plugins?.[TARGET_ID];',
  ).replace('const TARGET_MEMBER =', 'const TARGET_ID = "example-plugin-id";\nconst TARGET_MEMBER =');
  assertIncludes(source, ['no-dynamic-host-member'], 'a computed plugin id');
});

test('unguarded-internal-access: an undocumented internal reached without ?.', () => {
  const source = GOOD.replace(
    'this.app?.plugins?.plugins?.["example-plugin-id"];',
    'this.app.plugins.plugins["example-plugin-id"];',
  );
  const findings = assertIncludes(source, ['unguarded-internal-access'], 'a bare app.plugins walk');
  // every hop from the internal onward: .plugins, .plugins, ["example-plugin-id"]
  assert.equal(countOf(findings, 'unguarded-internal-access'), 3, show(findings));
});

test('missing-version-gate: a patch installed before the target version is checked', () => {
  const source = GOOD
    .replace('if (!requireApiVersion(APP_MIN_VERSION)) { this.modkitHalt("target-moved", "needs a newer Obsidian"); return; }\n', '')
    .replace('const version = this.modkitTargetVersion();\n', 'const version = "1.0.0";\n')
    .replace('if (cmpSemver(version, VERSION_FROM) < 0) { this.modkitHalt("target-moved", "below " + VERSION_FROM); return; }\n', '')
    .replace('if (version === null) { this.modkitHalt("target-gone", TARGET_LABEL + " is not enabled"); return; }\n', '')
    .replace('  modkitTargetVersion() {\n    try {\n      return this.app?.plugins?.manifests?.["example-plugin-id"]?.version ?? null;\n    } catch { return null; }\n  }\n', '');
  assertIncludes(source, ['missing-version-gate'], 'no gate before the first around()');
});

test('missing-no-effect-probe: a mod that cannot check itself', () => {
  const source = GOOD.replace(/  async modkitProbe\(\) \{[\s\S]*?\n  \}\n/, '');
  assertRules(source, ['missing-no-effect-probe'], 'a mod with no probe');
});

test('accessor-target: a patch installed with no descriptor pre-flight', () => {
  // around() reads a property and writes it back, so a getter-only member (Tasks apiV1, QuickAdd
  // api) is silently not patched. A mod that never asks for the descriptor cannot know.
  const source = GOOD
    .replace(/function descriptorFor\(holder, name\) \{[\s\S]*?\n\}\n/, 'function descriptorFor(holder, name) {\n  return { value: holder[name], writable: true, configurable: true };\n}\n')
    .replace('if (desc.get || desc.set) { this.modkitHalt("error", TARGET_MEMBER + " is an accessor"); return; }\n    ', '');
  assertIncludes(source, ['accessor-target'], 'no accessor pre-flight');
});

test('bound-method-target: a prototype patch with no instance-shadow check', () => {
  // A method captured with .bind(this) at construction is off the prototype call path — true of both
  // Obsidian Tasks renderers — so the patch installs, verifies, and never runs.
  const source = GOOD.replace(
    'if (Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)) { this.modkitHalt("error", "bound on the instance"); return; }\n    ',
    '',
  );
  assertIncludes(source, ['bound-method-target'], 'no bound-shadow check');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Evasions — the tests that matter most
 * ──────────────────────────────────────────────────────────────────────────── */

test('EVASION: this.register(anythingAtAll()) no longer whitelists its whole subtree', () => {
  // This is the one documented fail-open hole in the recon validator: `inRegister` was an ANCESTOR
  // test, so wrapping the leak in an IIFE handed to register() made every rule inside it silent.
  const source = GOOD.replace(
    'this.modkitArmed = true;',
    `this.modkitArmed = true;
    this.register((() => {
      document.addEventListener("click", () => {});
      setInterval(() => {}, 10);
      return () => {};
    })());`,
  );
  // Note what is *not* asserted: that register() rejected the IIFE. It cannot, and it does not need
  // to — `this.register(() => el.remove())` is an ordinary teardown, so the argument itself is not
  // where the rule can bite. The leaks are caught where they actually are, one by one, because the
  // exemption is now attached to specific sub-expressions instead of to a whole subtree.
  const findings = assertIncludes(
    source,
    ['no-bare-global', 'no-raw-listener', 'no-raw-timer'],
    'an IIFE smuggled through this.register()',
  );
  // Two banned globals: `document` and `setInterval`.
  assert.ok(countOf(findings, 'no-bare-global') >= 2, show(findings));
});

test('EVASION: a local named `document` in one function does not whitelist the global elsewhere', () => {
  // The recon validator collected declarations into one flat, module-wide set, so a parameter named
  // `document` anywhere made `document` legal everywhere. Scope resolution is what closes that.
  const source = GOOD
    .replace('function guardUninstall(uninstall) {', 'function guardUninstall(uninstall, document) {\n  void document;')
    .replace('this.modkitArmed = true;', 'this.modkitArmed = true;\n    void document.title;');
  assertIncludes(source, ['no-bare-global'], 'a shadowing parameter elsewhere in the module');
});

test('a genuine local binding is still not a global read', () => {
  // The other direction, and it has to hold or the scope work has just traded one false answer for
  // another: a real local named `app` inside onload() is that local, not the banned global.
  const source = GOOD.replace(
    'this.modkitArmed = true;',
    'this.modkitArmed = true;\n    const app = this.app;\n    void app;',
  );
  assertClean(source, 'a local shadowing a banned global name');
});

test('EVASION: around() hidden one closure deep inside register() is still unregistered', () => {
  const source = GOOD.replace(
    'this.register(guardUninstall(around(holder, {',
    'this.register(later(() => around(holder, {',
  ).replace('    })));', '    })));\n');
  assertIncludes(source, ['patch-must-be-registered'], 'around() behind a closure');
});

test('one wrapper call around around() is accepted; that is the template shape', () => {
  // guardUninstall() exists because Obsidian does not specify whether a throwing unload callback
  // aborts its siblings. The rule has to permit exactly this and no more.
  const findings = validate(GOOD).filter((f) => f.rule === 'patch-must-be-registered');
  assert.deepEqual(findings, [], show(findings));
});

test('every finding carries a usable location and an excerpt', () => {
  const source = GOOD.replace(
    'this.modkitArmed = true;',
    'this.modkitArmed = true;\n    document.title = "pwned";',
  );
  const findings = validate(source);
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(Number.isInteger(f.line) && f.line >= 1, `bad line on ${f.rule}`);
    assert.ok(Number.isInteger(f.column) && f.column >= 1, `bad column on ${f.rule}`);
    assert.equal(f.file, 'main.js');
    assert.equal(typeof f.message, 'string');
    assert.ok(f.message.length > 20, `message too terse on ${f.rule}: ${f.message}`);
  }
  const global = findings.find((f) => f.rule === 'no-bare-global');
  assert.match(global.excerpt, /document\.title/);
  // The reported line really is the offending line, not an approximation of it.
  assert.equal(source.split('\n')[global.line - 1].trim(), 'document.title = "pwned";');
});

test('the everything-wrong fixture trips every rule it should, and nothing throws', () => {
  const source = `import { Plugin } from "obsidian";
import fs from "node:fs";
document.title = "pwned";
console.log("side effect");
let mutable = 1;

export default class Bad extends Object {
  onload() {
    const t = this.app.plugins.plugins["victim"];
    t.someMethod = function () {};
    around(t.constructor.prototype, { m(n) { return n; } });
    setInterval(() => {}, 10);
    document.addEventListener("click", () => {});
    localStorage.setItem("k", "v");
    new Function("return 1")();
    const key = "victim";
    void this.app.plugins.plugins[key];
    void fs;
    void mutable;
  }
}
`;
  const findings = validate(source);
  const seen = rules(findings);
  for (const rule of [
    'no-top-level-side-effects',
    'no-bare-global',
    'no-host-assignment',
    'no-raw-timer',
    'no-raw-listener',
    'patch-must-be-registered',
    'no-eval',
    'import-not-allowed',
    'default-export-must-extend-plugin',
    'no-dynamic-host-member',
    'unguarded-internal-access',
    'missing-version-gate',
    'missing-no-effect-probe',
    'accessor-target',
    'bound-method-target',
  ]) {
    assert.ok(seen.includes(rule), `expected ${rule}\n${show(findings)}`);
  }
  assert.equal(validateSource(source).ok, false);
});

test('requireTemplateContract: false drops the structural rules and keeps the reclaim rules', () => {
  const fragment = `import { Plugin } from "obsidian";
export class Fragment extends Plugin {
  onload() { document.addEventListener("click", () => {}); }
}
`;
  const strict = rules(validate(fragment));
  assert.ok(strict.includes('missing-no-effect-probe'));
  assert.ok(strict.includes('default-export-must-extend-plugin'));

  const loose = rules(validate(fragment, { requireTemplateContract: false }));
  assert.ok(!loose.includes('missing-no-effect-probe'));
  assert.ok(!loose.includes('default-export-must-extend-plugin'));
  assert.ok(loose.includes('no-raw-listener'), 'the reclaim contract still applies');
  assert.ok(loose.includes('no-bare-global'));
});

test('findings come back sorted by position, so a report reads like the file', () => {
  const source = GOOD.replace(
    'this.modkitArmed = true;',
    'this.modkitArmed = true;\n    document.title = "a";\n    localStorage.clear();',
  );
  const findings = validate(source);
  for (let i = 1; i < findings.length; i++) {
    const prev = findings[i - 1];
    const cur = findings[i];
    assert.ok(
      prev.line < cur.line || (prev.line === cur.line && prev.column <= cur.column),
      `out of order at ${i}: ${prev.rule}@${prev.line}:${prev.column} then ${cur.rule}@${cur.line}:${cur.column}`,
    );
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The 2026-08-31 hardening pass — twenty bypasses, every one reproduced first
 *
 * Three adversarial verifiers ran the *compiled* validator and got **zero findings** from each
 * fixture below. That number is the evidence for PLAN §M3's third claim, so these are written as
 * the attacks they were, with the before/after count named in each test. The shared shape of every
 * hole was a rule asking about a *name or a token* where it should have asked about *provenance*.
 *
 * The false-rejection tests at the end matter exactly as much. A validator that rejects correct
 * code burns a generation on the retry loop and teaches everyone downstream to stop trusting it,
 * so hardening that swings into over-rejection has not made anything safer.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A minimal well-formed mod, for fixtures where the template contract is not what is under test. */
function mod(body, { imports = '', members = '' } = {}) {
  return `import { Plugin } from "obsidian";${imports}
export default class M extends Plugin {
  onload() {
${body}
  }
${members}  async modkitProbe() { return true; }
}
`;
}

test('F1: no-host-assignment survives one level of indirection (was 0 findings, all five)', () => {
  // (a) a helper that does the assignment. Host provenance now flows from the argument into the
  // parameter it binds, so `h[n] = f` inside install() knows `h` is foreign.
  const viaHelper = `import { Plugin } from "obsidian";
function install(h, n, f) { h[n] = f; }
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["victim"];
    install(t.constructor.prototype, "m", function () {});
  }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(viaHelper, ['no-host-assignment'], 'a host write done by a helper function');

  // (b)–(c) mutators carry no AssignmentExpression node at all, so a rule that walked assignments
  // could not see them however carefully it asked about the left-hand side.
  for (const [label, call] of [
    ['Object.assign', 'Object.assign(t.constructor.prototype, { m: function () {} });'],
    ['Object.defineProperty', 'Object.defineProperty(t.constructor.prototype, "m", { value: function () {} });'],
    ['Object.defineProperties', 'Object.defineProperties(t.constructor.prototype, { m: { value: 1 } });'],
    ['Reflect.set', 'Reflect.set(t.constructor.prototype, "m", function () {});'],
    ['Reflect.defineProperty', 'Reflect.defineProperty(t.constructor.prototype, "m", { value: 1 });'],
  ]) {
    const source = mod(`    const t = this.app?.plugins?.plugins?.["victim"];\n    ${call}`);
    assertIncludes(source, ['no-host-assignment'], `${label} into the host graph`);
  }

  // (d) provenance through a plain local. `this.app.workspace.leaked = …` was blocked; one `const`
  // in front of it was not.
  assertIncludes(
    mod('    const w = this.app.workspace;\n    w.onLayoutReady = function () {};'),
    ['no-host-assignment'],
    'a host object held in a local',
  );

  // (e) the chain root is a *call*, so `chainRoot()` bottomed out on a CallExpression and the rule
  // gave up. Host-ness is a property of the whole expression now.
  assertIncludes(
    mod('    this.app.workspace.getLeavesOfType("markdown")[0].view.onload = function () {};'),
    ['no-host-assignment'],
    'a host object reached through the result of a host call',
  );
});

test('F2: plane A — patching the obsidian module itself is a host assignment (was 0 findings)', () => {
  // The worst of the twenty: this permanently patches Obsidian for every plugin in the vault, has
  // no uninstaller, and survives the mod being removed. It validated clean.
  const source = `import { Plugin, Workspace } from "obsidian";
export default class M extends Plugin {
  onload() { Workspace.prototype.getLeaf = function () {}; }
  async modkitProbe() { return true; }
}
`;
  const findings = assertIncludes(source, ['no-host-assignment'], 'a write to an obsidian export');
  assert.match(
    findings.find((f) => f.rule === 'no-host-assignment').message,
    /Obsidian itself/,
    'the message has to say why this one is worse than the others',
  );
});

test('F3: patch-must-be-registered matches the import binding, not the string "around"', () => {
  // Renaming the import was a one-token bypass of the rule that is the entire reason around() is
  // safe here. The file already resolved obsidian's bindings this way.
  const source = `import { Plugin } from "obsidian";
import { around as patchIt } from "monkey-around";
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["victim"];
    patchIt(t?.constructor?.prototype, { m(next) { return function () { return next.apply(this, arguments); }; } });
  }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(source, ['patch-must-be-registered'], 'around() imported under another name');
});

test('F4: the Component reclaim contract, past timers and listeners (each was 0 findings)', () => {
  // The single most common Obsidian leak there is.
  assertIncludes(
    mod('    this.app.workspace.on("file-open", () => {});'),
    ['event-must-be-registered'],
    'an unregistered workspace EventRef',
  );
  assertIncludes(
    mod('    this.app.vault.on("modify", () => {});'),
    ['event-must-be-registered'],
    'an unregistered vault EventRef',
  );

  // An on-handler is a listener nothing removes, whichever object carries it.
  assertIncludes(
    mod('    const el = activeDocument.querySelector(".x");\n    el.onclick = () => {};'),
    ['no-host-assignment'],
    'an on-handler on a queried host element',
  );
  assertIncludes(
    mod('    const es = new EventSource("http://localhost/x");\n    es.onmessage = () => {};'),
    ['no-raw-listener', 'must-be-reclaimed'],
    'an EventSource nobody closes',
  );

  for (const ctor of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    assertIncludes(
      mod(`    new ${ctor}(() => {}).observe(activeDocument.body, { childList: true });`),
      ['must-be-reclaimed'],
      `an unreclaimed ${ctor}`,
    );
  }

  // The one that matters most, because plane E is what the element picker emits: a <style> appended
  // to head forever, a permanent class on a host element, and an observer on the document body.
  const planeELeak = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    const style = activeDocument.createElement("style");
    style.textContent = ".inline-title { opacity: 0.5; }";
    activeDocument.head.appendChild(style);
    const el = activeDocument.querySelector(".inline-title");
    el.classList.add("modkit-dim");
    new MutationObserver(() => {}).observe(activeDocument.body, { childList: true, subtree: true });
  }
  async modkitProbe() { return true; }
}
`;
  const leaks = assertIncludes(planeELeak, ['must-be-reclaimed'], 'the plane-E leaker');
  assert.equal(countOf(leaks, 'must-be-reclaimed'), 3, show(leaks));
});

test('F5: module- and construction-time execution is more than program.body (was 0 findings)', () => {
  // The same statement, in three positions `checkTopLevel` could not see. A static block runs at
  // module load, before onload, outside any Component, and disabling the mod does not undo it.
  const staticBlock = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  static { activeDocument.body.dataset.pwned = "1"; }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(staticBlock, ['no-top-level-side-effects', 'no-host-assignment'], 'a static block');

  const fieldInit = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  boom = (activeDocument.body.dataset.pwned = "1");
  async modkitProbe() { return true; }
}
`;
  assertIncludes(fieldInit, ['no-top-level-side-effects', 'no-host-assignment'], 'a class field initialiser');

  const paramDefault = `import { Plugin } from "obsidian";
function f(x = (activeDocument.body.dataset.pwned = "1")) { return x; }
export default class M extends Plugin {
  onload() { f(); }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(paramDefault, ['no-top-level-side-effects', 'no-host-assignment'], 'a parameter default');

  // Ordinary class fields and ordinary defaults stay legal — the grammar is the one module scope
  // already uses, not a ban on the syntax.
  assertClean(
    `import { Plugin } from "obsidian";
function f(opts = {}, n = 0, s = "x") { return [opts, n, s]; }
export default class M extends Plugin {
  modkitCalls = 0;
  modkitHealth = { state: "applied" };
  onload() { void f(); }
  async modkitProbe() { return true; }
}
`,
    'benign field initialisers and parameter defaults',
  );
});

/**
 * The ceremony fixture — five dead lines that satisfied all three refusal rules while an unguarded
 * `around()` installed on Tasks' `apiV1`, which is precisely the accessor case that must be refused.
 *
 * Deleting only the ceremony flipped the same file to three errors, which is the whole
 * demonstration: the rules were measuring the ceremony rather than the patch.
 */
const CEREMONY = `import { Notice, Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

const MOD_ID = "mod";
const TARGET_MEMBER = "apiV1";

export default class M extends Plugin {
  async onload() {
    this.manifest.version;
    const _d = Object.getOwnPropertyDescriptor(Object.prototype, "toString");
    if (_d && _d.get) return;
    ({}).hasOwnProperty("nope");
    const t = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
    if (!t) return;
    const holder = t.constructor?.prototype;
    this.register(around(holder, { apiV1(next) { return function () { return next.apply(this, arguments); }; } }));
    new Notice("ok");
    void requireApiVersion;
  }
  async modkitProbe() { return true; }
}
`;

test('F6: the three refusal rules are bound to the patch, not to tokens (was 0 findings)', () => {
  const findings = assertIncludes(
    CEREMONY,
    ['accessor-target', 'bound-method-target', 'missing-version-gate'],
    'five lines of ceremony in front of an unguarded around() on an accessor',
  );
  // Exactly the three the verifier got by *deleting* the ceremony. Adding the tokens back must no
  // longer be a way to make them go away.
  assert.equal(countOf(findings, 'accessor-target'), 1, show(findings));
  assert.equal(countOf(findings, 'bound-method-target'), 1, show(findings));
  assert.equal(countOf(findings, 'missing-version-gate'), 1, show(findings));

  // Deleting the ceremony changes nothing, because the ceremony was never what was being measured.
  const stripped = CEREMONY
    .replace('    this.manifest.version;\n', '')
    .replace('    const _d = Object.getOwnPropertyDescriptor(Object.prototype, "toString");\n', '')
    .replace('    if (_d && _d.get) return;\n', '')
    .replace('    ({}).hasOwnProperty("nope");\n', '');
  assert.deepEqual(
    rules(validate(stripped)).filter((r) => r.startsWith('accessor') || r.startsWith('bound') || r.startsWith('missing-version')),
    ['accessor-target', 'bound-method-target', 'missing-version-gate'],
    'the ceremony was load-bearing for nothing',
  );

  // A *real* descriptor pre-flight, taken on the wrong object, still does not answer the question.
  const wrongHolder = GOOD.replace(
    'const desc = descriptorFor(holder, TARGET_MEMBER);',
    'const desc = descriptorFor(Object.prototype, TARGET_MEMBER);',
  );
  assertIncludes(wrongHolder, ['accessor-target'], 'a descriptor taken on the wrong holder');

  // Same for the shadow check: asking `{}` whether it shadows the member is not asking the instance.
  const wrongInstance = GOOD.replace(
    'Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)',
    'Object.prototype.hasOwnProperty.call({}, TARGET_MEMBER)',
  );
  assertIncludes(wrongInstance, ['bound-method-target'], 'a shadow check asked of the wrong object');

  // And a version token that is not the *target's* version is not a gate. `this.manifest` is the
  // mod's own manifest, and reading it satisfied `missing-version-gate` outright.
  const ownManifest = GOOD.replace(
    'const version = this.modkitTargetVersion();',
    'const version = this.manifest.version;',
  ).replace(
    '  modkitTargetVersion() {\n    try {\n      return this.app?.plugins?.manifests?.["example-plugin-id"]?.version ?? null;\n    } catch { return null; }\n  }\n',
    '',
  );
  assertIncludes(ownManifest, ['missing-version-gate'], 'the mod\'s own manifest version as a gate');
});

test('F7/F10: computed access and the unnamed Function constructor (were 0 findings)', () => {
  // A real leak, and a two-line evasion of every name-based rule in the file. Folding the const
  // turns it back into the ordinary listener it is.
  const computed = mod('    const m = "add" + "EventListener";\n    activeDocument[m]("click", () => {});');
  assertIncludes(computed, ['no-raw-listener'], 'addEventListener behind a const');

  // A key that genuinely cannot be resolved leaves every name-based rule blind, so it is refused
  // rather than guessed at.
  const unresolvable = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    const key = this.modkitPick();
    void activeDocument[key];
  }
  modkitPick() { return "body"; }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(unresolvable, ['no-dynamic-host-member'], 'a host object indexed with a runtime key');

  // The same shape one indirection deeper: host provenance reaches the parameter, so the computed
  // access on it is just as unanswerable.
  const viaParam = `import { Plugin } from "obsidian";
function go(doc, k) { void doc[k]; }
export default class M extends Plugin {
  onload() { go(activeDocument, this.modkitPick()); }
  modkitPick() { return "body"; }
  async modkitProbe() { return true; }
}
`;
  assertIncludes(viaParam, ['no-dynamic-host-member'], 'a host object indexed through a parameter');

  // The Function constructor, reached without ever writing its name.
  assertIncludes(
    mod('    void (() => {}).constructor("return globalThis")();'),
    ['no-eval'],
    'the Function constructor via a function literal',
  );
  assertIncludes(
    mod('    const F = ({}).constructor.constructor;\n    F("return this")().foo = 1;'),
    ['no-eval'],
    'the Function constructor twice-chained',
  );
  // This one the validator already caught, because the key folds to "eval". Kept so a future
  // refactor of the folding cannot quietly lose it.
  assertIncludes(mod('    void activeWindow["ev" + "al"]("1+1");'), ['no-eval'], 'a concatenated eval');
});

test('F8: correct code is NOT rejected — the shape modkit\'s own picker uses', () => {
  // `this.registerInterval(win.setInterval(fn, ms))` was rejected as `no-raw-timer` because the
  // recogniser accepted only the literal identifiers `window`/`activeWindow` as the receiver. That
  // is picker.ts:609's shape, so the validator was rejecting modkit's own code.
  const localWin = GOOD.replace(
    'this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), 30000));',
    'const win = activeWindow;\n    this.registerInterval(win.setInterval(() => this.modkitCheckNoEffect(), 30000));',
  );
  assertClean(localWin, 'a registered interval on a window held in a local');

  const fieldWin = GOOD.replace(
    'this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), 30000));',
    'this.modkitWin = activeWindow;\n    this.registerInterval(this.modkitWin.setInterval(() => this.modkitCheckNoEffect(), 30000));',
  );
  assertClean(fieldWin, 'a registered interval on a window held on `this`');

  // `const off = around(...); this.register(off);` registers the uninstaller. It was rejected as
  // `patch-must-be-registered` — a false rejection of the exact thing the rule exists to require.
  const namedUninstaller = GOOD
    .replace('this.register(guardUninstall(around(holder, {', 'const off = around(holder, {')
    .replace('    })));', '    });\n    this.register(off);');
  assertClean(namedUninstaller, 'an around() registered through a named uninstaller');

  // The same for an EventRef held in a local before it is registered.
  const namedEventRef = GOOD.replace(
    'this.modkitArmed = true;',
    'this.modkitArmed = true;\n    const ref = this.app.workspace.on("file-open", () => this.modkitBump());\n    this.registerEvent(ref);',
  );
  assertClean(namedEventRef, 'an EventRef registered through a local');
});

test('F8: the sanctioned reclaim forms all still validate clean', () => {
  // The other direction of the same worry. Every form the contract *requires* has to pass, or the
  // hardening has simply moved the failure from silent leaks to unusable rejections.
  //
  // A reclaimed <style> element used to be on this list — it was the pre-L1 "sanctioned" way to
  // style a host element (see the `must-be-reclaimed` message this fixture used to demonstrate).
  // `inject-stylesheet` retired it: `stylesCss` is the sanctioned way to style now, on every plane,
  // so a built-and-reclaimed <style> element is no longer one of the forms this fixture should
  // claim are clean. See the `inject-stylesheet` suite for its fixture instead.
  const source = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    this.registerEvent(this.app.workspace.on("file-open", () => {}));
    this.registerEvent(this.app.vault.on("modify", () => {}));
    const obs = new MutationObserver(() => {});
    obs.observe(activeDocument.body, { childList: true });
    this.register(() => obs.disconnect());
    const el = activeDocument.querySelector(".inline-title");
    el.addClass("modkit-dim");
    this.register(() => el.removeClass("modkit-dim"));
  }
  async modkitProbe() { return true; }
}
`;
  assertClean(source, 'every sanctioned reclaim form');
});

test('F9: the correction turn states the requirement without naming the three pre-flight rules', () => {
  // For a structural rule the id is pure help — its message names the one legal form, so the
  // cheapest edit is the fix. For the three L0 rules the cheapest edit used to be *adding the
  // token*, and we were handing over the id, which is the most efficient hint about which token.
  const findings = validate(CEREMONY).filter((f) => f.severity === 'error');
  assert.ok(findings.length >= 3, show(findings));

  const built = buildCorrectionPrompt(
    {
      request: 'announce the task count',
      target: { kind: 'plugin', pluginId: 'obsidian-tasks-plugin', version: '7.14.0' },
      modId: 'modkit-mod-x',
      modVersion: '0.0.1',
      minAppVersion: '1.7.2',
    },
    CEREMONY,
    findings,
  );

  for (const rule of ['accessor-target', 'bound-method-target', 'missing-version-gate']) {
    assert.ok(
      !built.prompt.includes(`\`${rule}\``),
      `the correction turn must not hand back the id \`${rule}\` — it is the hint that makes ` +
        'token-stuffing the cheapest edit',
    );
  }
  // The requirement itself still goes back in full, or the correction turn teaches nothing at all.
  assert.match(built.prompt, /accessor pre-flight on the member being patched/);
  assert.match(built.prompt, /asking the live instance/);
  assert.match(built.prompt, /reading the target/i);
  assert.match(built.prompt, /not a token to add/);

  // Structural rules keep their ids, because there the id and the fix point the same way.
  const structural = validate(GOOD_PLANE_E.replace(
    'this.registerDomEvent(activeDocument, "click", () => this.modkitBump());',
    'activeDocument.addEventListener("click", () => this.modkitBump());',
  ));
  const withStructural = buildCorrectionPrompt(
    {
      request: 'dim the titles',
      target: { kind: 'plugin', pluginId: 'x', version: '1.0.0' },
      modId: 'm',
      modVersion: '0.0.1',
      minAppVersion: '1.7.2',
    },
    GOOD_PLANE_E,
    structural,
  );
  assert.match(withStructural.prompt, /`no-raw-listener`/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The 2026-08-31 replay pass — bypasses found by attacking the HARDENED validator
 *
 * The F1–F10 fixtures above are the ten holes the first adversarial round found. The five below
 * were found the same way against the code that closed them, and every one of them returned **zero
 * findings** when it was written. They share one shape with F1–F10: a rule that asks about a *name*,
 * answered by binding that name to something else.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The worst of the round, because of what it takes down with it.
 *
 * `isAroundCall` matched a bare Identifier only, so a namespace import made `ma.around(...)`
 * invisible. That is not one rule missing — `facts.firstAround` stayed `null`, and all three refusal
 * rules hang off it, so the file below (a permanent prototype patch with no uninstaller, no version
 * gate and no accessor pre-flight) validated completely clean.
 */
const NAMESPACE_AROUND = `import { Notice, Plugin } from "obsidian";
import * as ma from "monkey-around";

const MOD_ID = "mod";

export default class M extends Plugin {
  async onload() {
    const target = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
    if (!target) return;
    const holder = target.constructor.prototype;
    ma.around(holder, { getTasks(next) { return function () { return next.apply(this, arguments); }; } });
    new Notice("ok");
  }
  async modkitProbe() { return true; }
}
`;

test('F11: around() through a namespace import (was 0 findings — and skipped all three refusals)', () => {
  assertIncludes(
    NAMESPACE_AROUND,
    ['patch-must-be-registered', 'missing-version-gate', 'accessor-target', 'bound-method-target'],
    'import * as ma from "monkey-around"',
  );
  // The same one indirection deeper: a local bound to `around`, and a local bound to `ma.around`.
  assertIncludes(
    mod(
      '    const t = this.app?.plugins?.plugins?.["x"];\n' +
        '    const patch = around;\n' +
        '    patch(t.constructor.prototype, { m(next) { return function () { return next.apply(this, arguments); }; } });',
      { imports: '\nimport { around } from "monkey-around";' },
    ),
    ['patch-must-be-registered'],
    'const patch = around',
  );
});

test('F12: `this.app.…` is not owned just because the chain starts at `this` (was 0 findings)', () => {
  // `owns()` bottomed out on "the chain root is ThisExpression", which made every host element
  // reached the ordinary Obsidian way — this.app.workspace.containerEl — the mod's own property.
  assertIncludes(
    mod(
      '    const banner = activeDocument.createElement("div");\n' +
        '    this.app.workspace.containerEl.appendChild(banner);\n' +
        '    this.app.workspace.containerEl.addClass("mine");',
    ),
    ['must-be-reclaimed'],
    'appending to and classing a host element through this.app',
  );
  // And the mod's own field is still owned, which is the half that must not regress.
  assertClean(
    mod(
      '    this.modkitBox = activeDocument.createElement("div");\n' +
        '    this.modkitBox.addClass("mine");\n' +
        '    this.modkitBox.appendChild(activeDocument.createElement("span"));',
    ),
    'a node the mod created and holds on `this`',
  );
});

test('F13: insertAdjacentHTML and a raw animation frame (were 0 findings)', () => {
  // Not in INSERT_METHODS, so a permanent <style> in the user's head was invisible. It takes a
  // string rather than a node, so there is nothing to register — refusing it is the answer.
  assertIncludes(
    mod('    activeDocument.head.insertAdjacentHTML("beforeend", "<style>.x{}</style>");'),
    ['must-be-reclaimed'],
    'insertAdjacentHTML into the host head',
  );
  // requestAnimationFrame was a banned *global* and nothing else, so the member form armed a
  // self-rescheduling loop that outlives the mod.
  assertIncludes(
    mod(
      '    const loop = () => { activeWindow.requestAnimationFrame(loop); };\n' +
        '    activeWindow.requestAnimationFrame(loop);',
    ),
    ['no-raw-timer'],
    'a requestAnimationFrame loop',
  );
  // There is no register*() form for a frame request, so the rule has to accept the one correct
  // shape — hold the handle, register the cancel — or it is a flat refusal of a legitimate mod.
  assertClean(
    mod(
      '    const frame = activeWindow.requestAnimationFrame(() => {});\n' +
        '    this.register(() => activeWindow.cancelAnimationFrame(frame));',
    ),
    'a frame request whose cancel is registered',
  );
});

test('F14: an observer and a code loader, each behind a local binding (were 0 findings)', () => {
  assertIncludes(
    mod(
      '    const MO = MutationObserver;\n' +
        '    const obs = new MO(() => {});\n' +
        '    obs.observe(activeDocument.body, { childList: true });',
    ),
    ['must-be-reclaimed'],
    'MutationObserver under an alias',
  );
  // `new (…).constructor(…)` reaches AsyncFunction/GeneratorFunction without writing a banned name.
  // The *call* form was already rejected; the `new` form, directly and through a const, was not.
  assertIncludes(
    mod('    const AF = Object.getPrototypeOf(async function () {}).constructor;\n    void new AF("return 1");'),
    ['no-eval'],
    'the AsyncFunction constructor through getPrototypeOf',
  );
  assertIncludes(
    mod('    void new (Object.getPrototypeOf(function* () {}).constructor)("return 1");'),
    ['no-eval'],
    'the GeneratorFunction constructor, inline',
  );
});

test('F16: delete and an aliased mutator are assignments with no `=` in them (were 0 findings)', () => {
  // A delete carries neither an AssignmentExpression nor a call, so both halves of
  // no-host-assignment looked past it — and it is *harder* to undo than a replacement, because the
  // original value is gone the moment it runs.
  assertIncludes(
    mod(
      '    const t = this.app?.plugins?.plugins?.["x"];\n' +
        '    delete t.constructor.prototype.someMethod;',
    ),
    ['no-host-assignment'],
    'delete on a target prototype',
  );
  assertIncludes(
    mod('    delete this.app.workspace.someField;'),
    ['no-host-assignment'],
    'delete on the app graph',
  );
  // The mutator table is keyed by the holder's *name*, so one rebinding switched it off.
  assertIncludes(
    mod(
      '    const t = this.app?.plugins?.plugins?.["x"];\n' +
        '    const O = Object;\n' +
        '    O.assign(t.constructor.prototype, { m() {} });',
    ),
    ['no-host-assignment'],
    'Object.assign through an alias',
  );
  // Deleting the mod's own state is not a host write.
  assertClean(mod('    this.modkitCache = {};\n    delete this.modkitCache.entry;'), 'delete on the mod\'s own field');
});

test('F15: an inert const initialiser is not a top-level side effect (was a FALSE rejection)', () => {
  // `const KEY = "add" + "EventListener"` is the exact shape the const-folding in F7 exists to
  // resolve, and rejecting the declaration while folding its value was self-contradictory. A false
  // rejection is a real defect: it burns a generation on the retry loop.
  assertClean(
    `import { Plugin } from "obsidian";
const A = "Mod: ";
const B = A + "Tasks";
const C = B;
export default class M extends Plugin {
  onload() { void C; }
  async modkitProbe() { return true; }
}
`,
    'concatenated and re-bound string constants at module scope',
  );
  // Composition only — a call on either side of the `+` is still work that runs at module load.
  assertIncludes(
    `import { Plugin } from "obsidian";
const D = "x" + activeDocument.head.insertAdjacentHTML("beforeend", "<i></i>");
export default class M extends Plugin {
  onload() { void D; }
  async modkitProbe() { return true; }
}
`,
    ['no-top-level-side-effects'],
    'a call hidden inside a concatenation',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * The 2026-08-31 PROVENANCE pass — the binding lattice
 *
 * Round two of the adversarial review closed eleven bypasses and found eleven more. Six of those
 * were closed; the remaining verdict was a clear NO on pointing modkit at a plugin anyone actually
 * uses, for one structural reason: **every rule that protected the host asked a question about a
 * NAME**, and provenance was built from exactly two shapes — a `const <Identifier> = <expr>`
 * declarator, and the parameters of a directly-called named function. Nine other spellings of the
 * same dataflow were therefore invisible, and every one returned **zero findings** against the
 * hardened build.
 *
 * Each one permanently patches a plugin someone relies on (or Obsidian's own `Workspace`) with no
 * uninstaller, no version gate and no accessor pre-flight; each survives disable AND uninstall; and
 * each leaves nothing in the mod list to explain it, because the mod that did it is gone.
 *
 * The fixtures below are those nine, the two extras from the same finding, the two consequence gaps
 * and the two false rejections. Every one was reproduced at the stated count against the compiled
 * validator before the lattice existed, and is re-run here against the file that replaced it.
 *
 * The pass-clean half matters exactly as much. Hardening that swings into over-rejection has made
 * nothing safer — it has moved the failure from a silent leak to a burnt generation, and taught
 * everyone downstream to trust the only safety mechanism less.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The replay corpus's base: a complete, realistic, template-shaped mod that validates to **zero
 * findings**. Every attack below is this file plus one injection, which is what makes the
 * before/after counts attributable — a fixture that is 90% noise proves nothing about one rule.
 */
const REPLAY_BASE = `import { Notice, Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

/* ── Generation-time facts. Every one is re-asserted at load, before anything is installed. ── */
const MOD_ID = "modkit-mod-tasks-count-a91c";
const MOD_LABEL = "Mod: Tasks — announce the task count";
const TARGET_LABEL = "Tasks";
const TARGET_MEMBER = "getTasks";
const VERSION_FROM = "7.14.0";
const VERSION_TO = "";                 /* "" means open-ended */
const APP_MIN_VERSION = "1.7.2";
const NO_EFFECT_MODE = "on-demand";    /* or "event-driven" */
const NO_EFFECT_DEADLINE_MS = 30000;

function semverRank(v) {
  /* Ranked rather than compared field-by-field so there is no computed indexing anywhere in this
     file — a validator that rejects computed access on the host graph should not have to tell
     locals apart to let this through. Pre-release suffixes are ignored on purpose; five digits per
     field is far more than any plugin uses. */
  const parts = String(v).split("-")[0].split(".").concat(["0", "0", "0"]).slice(0, 3);
  let rank = 0;
  for (const part of parts) rank = rank * 100000 + (Number(part) || 0);
  return rank;
}

function cmpSemver(a, b) {
  const ra = semverRank(a);
  const rb = semverRank(b);
  if (ra < rb) return -1;
  return ra > rb ? 1 : 0;
}

function descriptorFor(holder, name) {
  /* Walk the chain by hand. Both "name in holder" and a bare read report a healthy-looking value
     for an accessor, and a bare read INVOKES the getter. */
  let o = holder;
  while (o) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return d;
    o = Object.getPrototypeOf(o);
  }
  return null;
}

export default class ModkitMod extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    this.modkitArmed = false;
    this.modkitFaulted = false;
    this.modkitVersionSeen = null;
    this.modkitHealth = { state: "target-gone", detail: "not checked yet" };

    /* 1 ── the version gate. Runs FIRST, before the first around() call. */
    if (!requireApiVersion(APP_MIN_VERSION)) {
      this.modkitHalt("target-moved", "needs Obsidian " + APP_MIN_VERSION);
      return;
    }
    const version = this.modkitTargetVersion();
    this.modkitVersionSeen = version;
    if (version === null) {
      this.modkitHalt("target-gone", TARGET_LABEL + " is not installed or not enabled");
      return;
    }
    if (cmpSemver(version, VERSION_FROM) < 0) {
      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is below " + VERSION_FROM);
      return;
    }
    if (VERSION_TO && cmpSemver(version, VERSION_TO) >= 0) {
      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is at or past " + VERSION_TO);
      return;
    }

    /* 2 ── the handle. Literal ids only, and every hop optional-chained: app.plugins is
       undocumented and may simply not be there. */
    const target = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
    if (!target) {
      this.modkitHalt("target-gone", TARGET_LABEL + " is not enabled");
      return;
    }
    const holder = target.constructor?.prototype;
    if (!holder) {
      this.modkitHalt("target-gone", "the target class has no prototype");
      return;
    }

    /* 3 ── L0 pre-flight: the three silent no-op classes, each caught BEFORE anything installs. */
    const desc = descriptorFor(holder, TARGET_MEMBER);
    if (!desc) {
      this.modkitHalt("target-moved", TARGET_MEMBER + "() is not on the target any more");
      return;
    }
    if (desc.get || desc.set) {
      this.modkitHalt("error", TARGET_MEMBER + " is an accessor — around() cannot patch it");
      return;
    }
    if (typeof desc.value !== "function") {
      this.modkitHalt("target-moved", TARGET_MEMBER + " is not a function");
      return;
    }
    if (desc.writable === false && desc.configurable === false) {
      this.modkitHalt("error", TARGET_MEMBER + " is non-writable — the patch would be swallowed");
      return;
    }
    /* The bound-at-construction class, caught at RUNTIME rather than guessed from source: if the
       live object shadows the member with its own copy (this.x = this._x.bind(this) in a
       constructor or a class-field initialiser), the prototype is off the call path and patching it
       would install cleanly and change nothing. */
    if (Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)) {
      this.modkitHalt(
        "error",
        TARGET_MEMBER + " is shadowed by a bound copy on the live object — patching the prototype would do nothing",
      );
      return;
    }
    const baseRef = desc.value;

    /* 4 ── install. around() goes DIRECTLY inside this.register(), so the uninstaller can never be
       dropped. The wrapper stays a pass-through until step 5 arms it, which is how a multi-member
       patch is all-or-nothing without holding uninstallers of its own. */
    const self = this;
    this.register(
      around(holder, {
        getTasks(next) {
          return function (...args) {
            if (!self.modkitArmed) return next.apply(this, args);
            self.modkitBump();
            const result = next.apply(this, args);
            try {
              /* ── the requested change goes here ── */
            } catch (err) {
              /* A fault in OUR change must never take the target down with it, and must be
                 attributed to this mod — otherwise the user files modkit's bug against the
                 plugin's author. */
              self.modkitFault(err);
            }
            return result;
          };
        },
      }),
    );

    /* 5 ── L2: the assignment must actually have taken. The only reliable catch for a write that
       was swallowed rather than refused. */
    if (holder.getTasks === baseRef) {
      this.modkitHalt("error", "the patch did not take — the property was not replaced");
      return;
    }

    this.modkitArmed = true;
    this.modkitHealth = { state: "applied", detail: "" };
    this.modkitPublish();

    /* 6 ── L3: an event-driven mod that has never fired by its deadline is a real finding. An
       on-demand mod arms no deadline — a call count of zero is expected there, not a fault. */
    if (NO_EFFECT_MODE === "event-driven") {
      this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), NO_EFFECT_DEADLINE_MS));
    }

    new Notice(MOD_LABEL + ": patched " + TARGET_LABEL + " " + version);
  }

  modkitTargetVersion() {
    try {
      return (
        this.app?.plugins?.manifests?.["obsidian-tasks-plugin"]?.version ??
        this.app?.plugins?.plugins?.["obsidian-tasks-plugin"]?.manifest?.version ??
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
    /* Never throw, and never fail quietly. The plugin stays enabled and inert so the user can see
       it in modkit's mod list and ask for a regeneration. */
    this.modkitHealth = { state: state, detail: detail };
    console.warn("[" + MOD_ID + "] " + state + ": " + detail);
    new Notice(MOD_LABEL + " — not applied: " + detail);
    this.modkitPublish();
  }

  modkitFault(err) {
    /* Attributed loudly, and the Notice only once per load: the alternative is a user reporting
       modkit's bug to the plugin's author. */
    const detail = err && err.message ? String(err.message) : String(err);
    this.modkitHealth = { state: "error", detail: detail };
    console.error("[" + MOD_ID + "] this modkit mod (not " + TARGET_LABEL + ") threw: " + detail);
    if (!this.modkitFaulted) {
      this.modkitFaulted = true;
      new Notice(MOD_LABEL + " — this modkit mod errored, not " + TARGET_LABEL + ". See the console.");
    }
    this.modkitPublish();
  }

  modkitCheckNoEffect() {
    if (this.modkitArmed !== true) return;
    if (this.modkitCalls > 0) {
      if (this.modkitHealth.state === "no-effect") {
        this.modkitHealth = { state: "applied", detail: "called " + this.modkitCalls + " time(s)" };
        this.modkitPublish();
      }
      return;
    }
    if (this.modkitHealth.state !== "applied") return;
    this.modkitHealth = { state: "no-effect", detail: TARGET_MEMBER + "() has not been called since load" };
    console.warn("[" + MOD_ID + "] no-effect: nothing called " + TARGET_MEMBER + "()");
    this.modkitPublish();
  }

  /* The pull side of health reporting. modkit's mod list reads this — keep the name and the shape. */
  modkitStatus() {
    return {
      modId: MOD_ID,
      state: this.modkitHealth.state,
      detail: this.modkitHealth.detail,
      invocations: this.modkitCalls,
      targetVersionSeen: this.modkitVersionSeen,
    };
  }

  /* The push side. Entirely best-effort: a mod must still work with modkit disabled, uninstalled,
     or older than the method being called, because mods arrive on other devices by vault sync where
     modkit itself may not be installed at all. */
  modkitPublish() {
    try {
      const host = this.app?.plugins?.plugins?.["modkit"];
      if (host && typeof host.modkitReportHealth === "function") {
        host.modkitReportHealth(MOD_ID, this.modkitStatus());
      }
    } catch {
      /* reporting health must never be the thing that breaks a mod */
    }
  }

  /* The no-effect probe: exercises the patched path and asserts the observable difference. This is
     also the artifact that becomes the frozen regression test. Zero arguments, returns a boolean. */
  async modkitProbe() {
    try {
      const before = this.modkitCalls;
      const target = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
      if (!target || typeof target.getTasks !== "function") return false;
      target.getTasks();
      return this.modkitCalls > before;
    } catch {
      return false;
    }
  }
}
`;

const ONLOAD_ANCHOR = '    this.modkitPublish();\n\n    /* 6 ──';
const TOP_ANCHOR = 'const MOD_ID =';
const CLASS_ANCHOR = '  modkitTargetVersion() {';

/** The replay harness: the clean base, plus one injection, in one of three positions. */
function replay(code, where = 'onload') {
  let out;
  if (where === 'top') out = REPLAY_BASE.replace(TOP_ANCHOR, code + '\n' + TOP_ANCHOR);
  else if (where === 'class') out = REPLAY_BASE.replace(CLASS_ANCHOR, code + '\n\n' + CLASS_ANCHOR);
  else out = REPLAY_BASE.replace(ONLOAD_ANCHOR, code + '\n\n' + ONLOAD_ANCHOR);
  // An injection that silently fails to land turns every assertion below into a test of the base.
  assert.notEqual(out, REPLAY_BASE, `the ${where} anchor moved — the injection did not land`);
  return out;
}

test('the replay base is clean, so every count below is attributable to its one injection', () => {
  assertClean(REPLAY_BASE, 'the replay base');
});

/* ── The nine provenance spellings. Every one of them was 0 findings. ───────── */

const NINE_SPELLINGS = [
  {
    id: 'P1',
    label: 'a destructured prototype — const { prototype } = target.constructor',
    code:
      '    const { prototype } = target.constructor;\n' +
      '    prototype.getTasks = function () { return []; };',
  },
  {
    id: 'P2',
    label: 'a destructured host object — const { workspace } = this.app',
    code: '    const { workspace } = this.app;\n    workspace.getLeaf = function () {};',
  },
  {
    id: 'P3',
    // The template TEACHES `const self = this`, so this is the spelling a generated mod reaches for
    // by imitation rather than by malice — which is what makes it the worst of the nine.
    label: 'a this-alias — const me = this; me.app.workspace.getLeaf = fn',
    code: '    const me = this;\n    me.app.workspace.getLeaf = function () {};',
  },
  {
    id: 'P4',
    label: 'a host holder parked on a field of `this`',
    code:
      '    this.h = target.constructor.prototype;\n' +
      '    this.h.getTasks = function () { return []; };',
  },
  {
    id: 'P5',
    label: 'a host holder returned from an arrow',
    code:
      '    const holderOf = () => target.constructor.prototype;\n' +
      '    holderOf().getTasks = function () { return []; };',
  },
  {
    id: 'P6',
    label: 'a host holder inside an array literal',
    code:
      '    const boxes = [target.constructor.prototype];\n' +
      '    boxes[0].getTasks = function () { return []; };',
  },
  {
    id: 'P7',
    label: 'a host holder through a Map round-trip',
    code:
      '    const bag = new Map();\n' +
      '    bag.set("h", target.constructor.prototype);\n' +
      '    bag.get("h").getTasks = function () { return []; };',
  },
  {
    id: 'P8',
    label: 'a host holder across an await boundary',
    code:
      '    const h2 = await Promise.resolve(target.constructor.prototype);\n' +
      '    h2.getTasks = function () { return []; };',
  },
  {
    id: 'P9',
    label: 'a host holder handed to a callback parameter',
    code:
      '    [target.constructor.prototype].forEach((h) => { h.getTasks = function () { return []; }; });',
  },
];

for (const spelling of NINE_SPELLINGS) {
  test(`${spelling.id}: ${spelling.label} (was 0 findings)`, () => {
    const findings = assertRules(replay(spelling.code), ['no-host-assignment'], spelling.label);
    // Exactly one: the base is clean, so the count belongs to the injection and to nothing else.
    assert.equal(countOf(findings, 'no-host-assignment'), 1, show(findings));
  });
}

/* ── The two extras from the same finding, also 0 findings ─────────────────── */

test('P10: an unregistered host event through a destructured receiver (was 0 findings)', () => {
  const source = replay(
    '    const { workspace } = this.app;\n    workspace.on("file-open", () => this.modkitBump());',
  );
  assertRules(source, ['event-must-be-registered'], 'workspace.on() on a destructured receiver');
});

test('P11: a call through a detached method binding (was 0 findings)', () => {
  // `const s = activeWindow.setInterval; s(fn, 100)` puts the method's name on the BINDING and
  // nowhere near the call site, so a callee-name rule saw an ordinary call to `s`.
  const timer = replay('    const s = activeWindow.setInterval;\n    s(() => this.modkitBump(), 100);');
  assertRules(timer, ['no-raw-timer'], 'setInterval through a detached binding');

  // The same shape for an event subscription, re-attached with .call().
  const viaCall = replay(
    '    const ws = this.app.workspace;\n' +
      '    const on = ws.on;\n' +
      '    on.call(ws, "file-open", () => this.modkitBump());',
  );
  assertIncludes(viaCall, ['event-must-be-registered'], 'on() through a detached binding');
});

/* ── Scope correctness, which the previous pass explicitly left undone ─────── */

test('P12: bindings resolve through a scope chain, not a flat name map', () => {
  // The old provenance map was flat and name-keyed, so a helper parameter colliding with an outer
  // binding took the outer alias — in both directions. This is the safe direction: the parameter
  // really does take the argument's provenance, one helper deep.
  const viaHelper = replay('    this.modkitInstall(target.constructor.prototype);').replace(
    CLASS_ANCHOR,
    '  modkitInstall(holder) {\n    holder.getTasks = function () { return []; };\n  }\n\n' + CLASS_ANCHOR,
  );
  assertIncludes(viaHelper, ['no-host-assignment'], 'a host write done through a helper method');

  // And this is the direction a flat map got wrong the other way: a parameter that happens to reuse
  // an outer *host* name is its own binding, so a write to the mod's own element through it is not
  // a finding. Rejecting it would be a false rejection caused purely by a name collision.
  const shadowed = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    const holder = this.app.workspace;
    void holder;
    const own = activeDocument.createElement("div");
    this.modkitBox = own;
    this.modkitDecorate(own);
  }
  modkitDecorate(holder) { holder.addClass("modkit-x"); }
  async modkitProbe() { return true; }
}
`;
  assertClean(shadowed, 'a parameter shadowing an outer host binding');
});

/* ── UNKNOWN FAILS CLOSED: the property that makes the TENTH spelling safe ─── */

test('P13: a holder the analysis cannot follow is treated as the host\'s, not as the mod\'s', () => {
  // This is the whole design decision, asserted directly, and it is the reason there is no tenth
  // fixture to write: a flow the lattice cannot model resolves to `unknown`, and `unknown` is
  // `host`. Closing bypasses one at a time is how you earn an eleventh.
  //
  // A holder that resolves to no binding at all is the purest case — the analysis knows literally
  // nothing about it, and refuses.
  const bareGlobal = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() { unknownHolder.getTasks = function () { return []; }; }
  async modkitProbe() { return true; }
}
`;
  // ⚠️ Round 5 made this list LONGER, not shorter: writing a function onto a member of something
  // the mod does not own is a *patch install*, so it now also owes the version gate and the accessor
  // pre-flight that used to be skipped whenever the file contained no around() call. Both extra
  // rules are true of this fixture — it installs a patch and gates nothing.
  const findings = assertRules(
    bareGlobal,
    ['accessor-target', 'missing-version-gate', 'no-host-assignment'],
    'an unresolvable holder',
  );
  const hostWrite = findings.find((f) => f.rule === 'no-host-assignment');
  assert.ok(hostWrite, 'the host write itself must still be reported');
  assert.match(
    hostWrite.message,
    /provenance the validator could not establish/,
    'the message has to say WHY and what to write instead, or the correction turn cannot act on it',
  );
  assert.match(hostWrite.message, /Bind the holder in one expression from this\.app/);

  // And the realistic case: a helper whose parameter no call site in the file pins down. A class
  // method is reachable from outside the file — Obsidian's lifecycle, a command callback, modkit's
  // own harness — so "nobody calls it here" is not "it never runs with a host object".
  const uncalledHelper = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() { this.modkitCalls = 0; }
  modkitInstall(h) { h.getTasks = function () { return []; }; }
  async modkitProbe() { return true; }
}
`;
  assertRules(
    uncalledHelper,
    ['accessor-target', 'missing-version-gate', 'no-host-assignment'],
    "an uncalled helper's parameter as a holder",
  );

  // The other direction, and it is what stops fail-closed from meaning fail-always: the same helper
  // with a call site that hands it an element the mod created is clean.
  const wired = `import { Plugin } from "obsidian";
export default class M extends Plugin {
  onload() {
    this.modkitBox = activeDocument.createElement("div");
    this.modkitDecorate(this.modkitBox);
  }
  modkitDecorate(el) { el.addClass("modkit-x"); }
  async modkitProbe() { return true; }
}
`;
  assertClean(wired, 'a helper wired to an element the mod created');
});

/* ── Consequence, not ceremony: the two gaps subject-binding left open ─────── */

test('P14: a descriptor taken on the right holder and discarded is not a pre-flight (was 0 findings)', () => {
  // The pre-flight was `sawAccessorTest && descriptorCalls.some(bound to holder)`, and
  // `sawAccessorTest` was a FILE-GLOBAL boolean that any `map.get(x)` satisfied. So a mod could
  // take the descriptor on exactly the right holder for exactly the right member, throw it away,
  // and pass — then install on a getter-only member and report `applied`.
  const discarded = REPLAY_BASE.replace(
    '    if (desc.get || desc.set) {\n' +
      '      this.modkitHalt("error", TARGET_MEMBER + " is an accessor — around() cannot patch it");\n' +
      '      return;\n' +
      '    }\n',
    '    const cache = new Map();\n    const unrelated = cache.get("anything");\n    void unrelated;\n',
  );
  assert.notEqual(discarded, REPLAY_BASE, 'the accessor block did not get replaced');
  assertRules(discarded, ['accessor-target'], 'a descriptor measured and discarded');

  // Destructuring the descriptor is the same test written the other way, and must still pass.
  const destructured = REPLAY_BASE.replace(
    '    if (desc.get || desc.set) {',
    '    const { get, set } = desc;\n    if (get || set) {',
  );
  assert.notEqual(destructured, REPLAY_BASE, 'the accessor test did not get rewritten');
  assertClean(destructured, 'an accessor pre-flight written by destructuring');
});

test('P15: a target version read but only null-checked is not a gate (was 0 findings)', () => {
  // `missing-version-gate` was satisfied by a host-rooted `.version` read that reached no
  // comparison at all — and, fixed the obvious way, would still be satisfied by one compared only
  // to `null`. An existence check is not a range check: it cannot tell that the target MOVED, which
  // is the entire failure the gate exists to catch.
  const nullOnly = REPLAY_BASE.replace(
    '    if (cmpSemver(version, VERSION_FROM) < 0) {\n' +
      '      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is below " + VERSION_FROM);\n' +
      '      return;\n' +
      '    }\n' +
      '    if (VERSION_TO && cmpSemver(version, VERSION_TO) >= 0) {\n' +
      '      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is at or past " + VERSION_TO);\n' +
      '      return;\n' +
      '    }\n',
    '',
  );
  assert.notEqual(nullOnly, REPLAY_BASE, 'the range checks did not get removed');
  // `if (version === null) { halt; return; }` survives in the base and must NOT count as the gate.
  assertRules(nullOnly, ['missing-version-gate'], 'a version read compared only to null');

  // A range check whose failure path computes an answer and carries on is not a gate either.
  const noRefusal = REPLAY_BASE.replace(
    '    if (cmpSemver(version, VERSION_FROM) < 0) {\n' +
      '      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is below " + VERSION_FROM);\n' +
      '      return;\n' +
      '    }\n',
    '    const tooOld = cmpSemver(version, VERSION_FROM) < 0;\n    void tooOld;\n',
  ).replace(
    '    if (VERSION_TO && cmpSemver(version, VERSION_TO) >= 0) {\n' +
      '      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is at or past " + VERSION_TO);\n' +
      '      return;\n' +
      '    }\n',
    '',
  );
  assertIncludes(noRefusal, ['missing-version-gate'], 'a range check whose failure path does nothing');
});

test('P19: a gate whose comparison lives inside a predicate helper still counts', () => {
  // The consequence rule follows the version into a helper's PARAMETER, because
  // `if (!inRange(version)) { …; return; }` is an ordinary way to write a gate and rejecting it
  // would be a false rejection on correct code. Both directions are asserted, because a rule that
  // accepts this without checking what the helper does has stopped measuring anything.
  const gated = `import { Notice, Plugin } from "obsidian";
import { around } from "monkey-around";
const MEMBER = "getTasks";
function inRange(v) { return String(v).split(".")[0] >= "7"; }
function descriptorFor(h, n) { return Object.getOwnPropertyDescriptor(h, n); }
export default class M extends Plugin {
  onload() {
    this.n = 0;
    const v = this.app?.plugins?.manifests?.["obsidian-tasks-plugin"]?.version;
    if (!inRange(v)) { new Notice("moved"); return; }
    const t = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
    if (!t) return;
    const holder = t.constructor?.prototype;
    const desc = descriptorFor(holder, MEMBER);
    if (!desc || desc.get || desc.set) { new Notice("accessor"); return; }
    if (Object.prototype.hasOwnProperty.call(t, MEMBER)) { new Notice("shadowed"); return; }
    const self = this;
    this.register(around(holder, { getTasks(next) { return function () { self.n += 1; return next.apply(this, arguments); }; } }));
  }
  async modkitProbe() { return this.n >= 0; }
}
`;
  assertClean(gated, 'a gate written as a predicate helper');

  // The same file with the range check swapped for an existence check is still refused.
  const ungated = gated
    .replace('function inRange(v) { return String(v).split(".")[0] >= "7"; }\n', '')
    .replace('if (!inRange(v)) { new Notice("moved"); return; }', 'if (v === null) { new Notice("gone"); return; }');
  assertIncludes(ungated, ['missing-version-gate'], 'the same file with only a null check');
});

/* ── The reclaim ledger, narrowed from "any identifier in a register() argument" ── */

test('P16: a leak is not reclaimed by sharing a name with the template\'s register block', () => {
  // `reclaimedNames` was every identifier appearing ANYWHERE inside ANY this.register(...)
  // argument, head-matched on a dotted path. The base's own register block mentions `self`, `next`,
  // `args` and `err`, so a leak whose receiver happened to be called one of those was reclaimed BY
  // COINCIDENCE. Both of these were 0 findings.
  // A <div>, not a <style> element: `inject-stylesheet` (added for L1) would also fire on a <style>
  // element built this way, on top of the `must-be-reclaimed` this fixture means to isolate.
  const viaNext = replay(
    '    const next = activeDocument.createElement("div");\n' +
      '    activeDocument.body.appendChild(next);',
  );
  assertRules(viaNext, ['must-be-reclaimed'], 'a <div> leaked under the name `next`');

  const viaErr = replay(
    '    const err = activeDocument.querySelector(".inline-title");\n' +
      '    err.addClass("modkit-pwned");',
  );
  assertRules(viaErr, ['must-be-reclaimed'], 'a class leaked under the name `err`');

  // And a real teardown still reclaims, or the narrowing has broken the contract it enforces.
  assertClean(
    replay(
      '    const banner = activeDocument.createElement("div");\n' +
        '    activeDocument.body.appendChild(banner);\n' +
        '    this.register(() => banner.remove());',
    ),
    'an appended node whose removal is registered',
  );
});

/* ── The two false rejections. A false rejection is a real defect. ──────────── */

test('P17: an inert Object.freeze() const is not a top-level side effect (was a FALSE rejection)', () => {
  assertClean(
    `import { Plugin } from "obsidian";
const LIMITS = Object.freeze({ max: 10 });
const NAMES = Object.freeze(["a", "b"]);
const EMPTY = Object.create(null);
export default class M extends Plugin {
  onload() { void LIMITS; void NAMES; void EMPTY; }
  async modkitProbe() { return true; }
}
`,
    'frozen literal records at module scope',
  );

  // The exemption is for a fold of literals, not for calls in general: a `freeze` over anything
  // that has to be *evaluated* is still work that runs at module load.
  assertIncludes(
    `import { Plugin } from "obsidian";
const FROZEN = Object.freeze(activeDocument.head);
export default class M extends Plugin {
  onload() { void FROZEN; }
  async modkitProbe() { return true; }
}
`,
    ['no-top-level-side-effects'],
    'Object.freeze over a host member',
  );

  // Object and array *literals* stay shallow on purpose — a call nested inside one is caught where
  // it actually is, by the rule that names the real defect, rather than by a blanket rejection of
  // the declaration. This is the same trade the pre-existing top-level rule already made; what
  // matters is that it is still an error, and that the message points at the leak.
  const nested = validate(`import { Plugin } from "obsidian";
const BOOT = Object.freeze({ done: activeDocument.head.insertAdjacentHTML("beforeend", "<i></i>") });
export default class M extends Plugin {
  onload() { void BOOT; }
  async modkitProbe() { return true; }
}
`);
  assert.ok(nested.some((f) => f.severity === 'error'), show(nested));
  assert.ok(nested.some((f) => f.rule === 'must-be-reclaimed'), show(nested));
});

test('P18: contentEl.addClass() inside a Modal onOpen() is legal (was a FALSE rejection)', () => {
  // THE canonical Obsidian idiom — every example in the API docs writes it, and Obsidian empties
  // contentEl on close, so nothing leaks. Any generated mod that opened a modal hit
  // `must-be-reclaimed` and burned its one correction turn on a non-defect. Making this legal needs
  // the validator to know the class extends Modal: the exemption is the SUPERCLASS, not the name.
  assertClean(
    `import { Modal, Notice, Plugin } from "obsidian";
class ModkitSheet extends Modal {
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("modkit-sheet");
    contentEl.setText("hello");
  }
  onClose() { this.contentEl.empty(); }
}
export default class M extends Plugin {
  onload() {
    this.modkitSheet = new ModkitSheet(this.app);
    new Notice("ready");
  }
  async modkitProbe() { return true; }
}
`,
    'a Modal styling its own contentEl',
  );

  // The same for a settings tab, written through `this` rather than by destructuring.
  assertClean(
    `import { Plugin, PluginSettingTab } from "obsidian";
class ModkitTab extends PluginSettingTab {
  display() {
    this.containerEl.empty();
    this.containerEl.addClass("modkit-tab");
  }
}
export default class M extends Plugin {
  onload() { this.addSettingTab(new ModkitTab(this.app, this)); }
  async modkitProbe() { return true; }
}
`,
    'a PluginSettingTab styling its own containerEl',
  );

  // ⚠️ And the exemption really is the superclass and the field, not the file: the same call on an
  // element reached through the app graph is still a leak, inside a Modal as much as anywhere.
  assertIncludes(
    `import { Modal, Plugin } from "obsidian";
class ModkitSheet extends Modal {
  onOpen() {
    this.contentEl.addClass("modkit-sheet");
    this.app.workspace.containerEl.addClass("modkit-everywhere");
  }
}
export default class M extends Plugin {
  onload() { this.modkitSheet = new ModkitSheet(this.app); }
  async modkitProbe() { return true; }
}
`,
    ['must-be-reclaimed'],
    'a Modal reaching outside its own contentEl',
  );
});

/* ── The whole replay corpus, re-run against the lattice ────────────────────── */

/**
 * Every fixture from the two earlier adversarial rounds, replayed against the rewrite.
 *
 * They are a table rather than prose because their value is exactly that none of them regresses:
 * each was reproduced at zero findings once, and a rule that quietly stops asking is
 * indistinguishable from a rule nobody wrote. The `clean` half is not filler — it is the only thing
 * standing between "hardened" and "unusable".
 */
const REPLAY_CORPUS = [
  { id: 'a', expect: 'caught', desc: 'a host write done inside a helper function',
    top: 'function install(h, n, f) {\n  h[n] = f;\n}',
    code: '    install(target.constructor.prototype, "getTasks", function () { return []; });' },
  { id: 'b', expect: 'caught', desc: 'Object.assign onto the target prototype',
    code: '    Object.assign(target.constructor.prototype, { getTasks: function () { return []; } });' },
  { id: 'c', expect: 'caught', desc: 'Object.defineProperty onto the target prototype',
    code: '    Object.defineProperty(target.constructor.prototype, "getTasks", { value: function () { return []; } });' },
  { id: 'd', expect: 'caught', desc: 'a host object held in a local',
    code: '    const w = this.app.workspace;\n    w.onLayoutReady = function () {};' },
  { id: 'e', expect: 'caught', desc: 'a host object reached through the result of a host call',
    code: '    this.app.workspace.getLeavesOfType("markdown")[0].view.onload = function () {};' },
  { id: 'f', expect: 'caught', desc: 'plane A — patching the obsidian module itself',
    top: 'import { Workspace } from "obsidian";',
    code: '    Workspace.prototype.getLeaf = function () {};' },
  { id: 'g', expect: 'caught', desc: 'around() imported under another name, called outside register()',
    top: 'import { around as patchIt } from "monkey-around";',
    code: '    const proto2 = target.constructor.prototype;\n    patchIt(proto2, { getTasks: function (next) { return function () { return next.apply(this, arguments); }; } });' },
  { id: 'h', expect: 'caught', desc: 'a workspace EventRef nobody registered',
    code: '    this.app.workspace.on("file-open", function () {});' },
  { id: 'i', expect: 'caught', desc: 'a MutationObserver nobody disconnects',
    code: '    new MutationObserver(function () {}).observe(activeDocument.body, { childList: true });' },
  { id: 'j', expect: 'caught', desc: 'the plane-E leaker: a permanent <style>, a permanent class, a live observer',
    code: '    const style = activeDocument.createElement("style");\n    style.setAttribute("data-modkit-mod", MOD_ID);\n    style.textContent = ".tasks{color:red}";\n    activeDocument.head.appendChild(style);\n    activeDocument.body.classList.add("modkit-tasks-mod");\n    new MutationObserver(function () {}).observe(activeDocument.body, { childList: true, subtree: true });' },
  { id: 'k', expect: 'caught', where: 'class', desc: 'a class static {} block writing to the user\'s document',
    code: '  static {\n    activeDocument.body.dataset.pwned = "1";\n  }' },
  { id: 'l1', expect: 'caught', where: 'class', desc: 'a class field initialiser writing to the user\'s document',
    code: '  modkitFlag = (activeDocument.body.dataset.pwned = "1");' },
  { id: 'l2', expect: 'caught', where: 'top', desc: 'a parameter default writing to the user\'s document',
    code: 'function withDefault(x = (activeDocument.body.dataset.pwned = "1")) {\n  return x;\n}' },
  { id: 'm', expect: 'caught', desc: 'addEventListener behind a concatenated const',
    top: 'const EV = "add" + "EventListener";',
    code: '    activeDocument[EV]("click", function () {});' },
  { id: 'n', expect: 'caught', desc: 'the Function constructor via a function literal',
    code: '    const g = (() => {}).constructor("return globalThis")();\n    console.log(g);' },
  { id: 'n1b', expect: 'caught', desc: 'a destructured document body',
    code: '    const { body } = activeDocument;\n    body.dataset.pwned = "1";' },
  { id: 'n2b', expect: 'caught', desc: "a DOM leak through the template's own `self` binding",
    code: '    const banner = activeDocument.createElement("div");\n    self.app.workspace.containerEl.appendChild(banner);' },
  { id: 'n4', expect: 'caught', desc: 'around() through a local alias, outside register()',
    code: '    const patch = around;\n    patch(target.constructor.prototype, { toString: function (next) { return function () { return next.apply(this, arguments); }; } });' },
  { id: 'n5', expect: 'caught', desc: 'appending to and classing a host element through this.app',
    code: '    const banner = activeDocument.createElement("div");\n    banner.setAttribute("data-modkit-mod", MOD_ID);\n    this.app.workspace.containerEl.appendChild(banner);\n    this.app.workspace.containerEl.addClass("modkit-pwned");' },
  { id: 'n6', expect: 'caught', desc: 'insertAdjacentHTML into the host head',
    code: '    activeDocument.head.insertAdjacentHTML("beforeend", "<style>.tasks{color:red}</style>");' },
  { id: 'n7', expect: 'caught', where: 'top', desc: 'a module-load side effect hidden in an object literal',
    code: 'const BOOT = { done: activeDocument.head.insertAdjacentHTML("beforeend", "<style>.x{}</style>") };' },
  { id: 'n8', expect: 'caught', desc: 'MutationObserver under a local alias',
    code: '    const MO = MutationObserver;\n    const obs = new MO(function () {});\n    obs.observe(activeDocument.body, { childList: true, subtree: true });' },
  { id: 'n9', expect: 'caught', desc: 'the AsyncFunction constructor through getPrototypeOf',
    code: '    const AF = Object.getPrototypeOf(async function () {}).constructor;\n    const made = new AF("return 1");\n    console.log(made);' },
  { id: 'n10', expect: 'caught', desc: 'a host object through an array literal',
    code: '    const arr = [this.app.workspace];\n    arr[0].onLayoutReady = function () {};' },
  { id: 'n11', expect: 'caught', desc: 'a host object through a closure return',
    code: '    const get = () => this.app.workspace;\n    get().getLeaf = function () {};' },
  { id: 'n12', expect: 'caught', desc: 'a host object stashed on a field of `this`',
    code: '    this.ws = this.app.workspace;\n    this.ws.getLeaf = function () {};' },
  { id: 'n16', expect: 'caught', desc: 'a self-rescheduling requestAnimationFrame loop',
    code: '    const loop = () => { this.modkitBump(); activeWindow.requestAnimationFrame(loop); };\n    activeWindow.requestAnimationFrame(loop);' },
  { id: 'n19', expect: 'caught', desc: 'Object.assign through an alias of Object',
    code: '    const O = Object;\n    O.assign(target.constructor.prototype, { getTasks: function () { return []; } });' },
  { id: 'n20', expect: 'caught', desc: 'a second <style> leaked beside a properly reclaimed one',
    code: '    const style = activeDocument.createElement("style");\n    activeDocument.head.appendChild(style);\n    this.register(() => style.remove());\n    const otherStyle = activeDocument.createElement("style");\n    activeDocument.head.appendChild(otherStyle);' },
  { id: 'w7', expect: 'caught', desc: 'delete a member off the host prototype',
    code: '    delete target.constructor.prototype.getTasks;' },
  { id: 'w8', expect: 'caught', desc: 'a Proxy over a destructured host container, installed back onto it',
    code: '    const { plugins } = this.app;\n    this.app.plugins = new Proxy(plugins, {});' },

  // ── the must-pass-clean half ──
  { id: 'p1', expect: 'clean', desc: 'a registered interval on a window held in a local',
    code: '    const win = activeWindow;\n    this.registerInterval(win.setInterval(() => this.modkitCheckNoEffect(), 30000));' },
  { id: 'p2', expect: 'clean', desc: 'around() registered through a named uninstaller',
    code: '    const off = around(holder, { toString: function (next) { return function () { return next.apply(this, arguments); }; } });\n    this.register(off);' },
  { id: 'p3', expect: 'clean', desc: "modkit's own picker shape — this.win = activeWindow, then registerInterval",
    code: '    this.win = activeWindow;\n    this.registerInterval(this.win.setInterval(() => this.modkitCheckNoEffect(), 30000));' },
  { id: 'p4', expect: 'clean', desc: 'a created, marked, and reclaimed <div> (no plane passed — inject-stylesheet does not apply to a non-<style> element)',
    code: '    const box = activeDocument.createElement("div");\n    box.setAttribute("data-modkit-mod", MOD_ID);\n    box.textContent = "hi";\n    activeDocument.body.appendChild(box);\n    this.register(() => box.remove());' },
  { id: 'p5', expect: 'clean', desc: 'a properly registered workspace event',
    code: '    this.registerEvent(this.app.workspace.on("file-open", () => this.modkitBump()));' },
  { id: 'p6', expect: 'clean', desc: 'a frame request whose cancel is registered',
    code: '    const frame = activeWindow.requestAnimationFrame(() => this.modkitBump());\n    this.register(() => activeWindow.cancelAnimationFrame(frame));' },
  { id: 'p7', expect: 'clean', desc: 'an idle callback whose cancel is registered',
    code: '    const idle = activeWindow.requestIdleCallback(() => this.modkitBump());\n    this.register(() => activeWindow.cancelIdleCallback(idle));' },
  { id: 'p8', expect: 'clean', desc: 'an EventRef held in a local before it is registered',
    code: '    const ref = this.app.workspace.on("file-open", () => this.modkitBump());\n    this.registerEvent(ref);' },
  { id: 'p9', expect: 'clean', desc: "a destructured field of the mod's own object stays the mod's own",
    code: '    this.modkitBox = activeDocument.createElement("div");\n    const { modkitBox } = this;\n    modkitBox.addClass("modkit-mine");' },
  { id: 'p10', expect: 'clean', where: 'top', desc: 'concatenated and re-bound string constants at module scope',
    code: 'const A_LABEL = "Mod: ";\nconst B_LABEL = A_LABEL + "Tasks";\nconst C_LABEL = B_LABEL;' },
  { id: 'p11', expect: 'clean', where: 'top', desc: 'a frozen literal record at module scope',
    code: 'const LIMITS = Object.freeze({ max: 10 });' },
];

for (const c of REPLAY_CORPUS) {
  test(`REPLAY ${c.id}: ${c.desc} — must ${c.expect}`, () => {
    let source = REPLAY_BASE;
    if (c.top) {
      source = source.replace(TOP_ANCHOR, c.top + '\n' + TOP_ANCHOR);
      assert.notEqual(source, REPLAY_BASE, `${c.id}: the top anchor moved`);
    }
    const where = c.where ?? 'onload';
    const before = source;
    if (where === 'top') source = source.replace(TOP_ANCHOR, c.code + '\n' + TOP_ANCHOR);
    else if (where === 'class') source = source.replace(CLASS_ANCHOR, c.code + '\n\n' + CLASS_ANCHOR);
    else source = source.replace(ONLOAD_ANCHOR, c.code + '\n\n' + ONLOAD_ANCHOR);
    assert.notEqual(source, before, `${c.id}: the ${where} anchor moved — the injection did not land`);

    const findings = validate(source);
    const errors = findings.filter((f) => f.severity === 'error');
    if (c.expect === 'clean') {
      assert.deepEqual(errors, [], `${c.id} must validate clean, got:\n${show(findings)}`);
    } else {
      assert.ok(errors.length > 0, `${c.id} returned zero findings again:\n${show(findings)}`);
    }
  });
}

test('REPLAY (plane E): the reclaimed <style> shape p4 used to be — clean with no plane, an error on E', () => {
  // The REPLAY_CORPUS loop above calls `validate(source)` with no plane, so it never exercised
  // `inject-stylesheet`'s error severity — p4 used to assert this exact shape was unconditionally
  // "clean", which stopped being true the moment L1 shipped. This pins both halves against the full
  // template, not just the isolated snippets the dedicated inject-stylesheet tests above use.
  const code =
    '    const style = activeDocument.createElement("style");\n' +
    '    style.setAttribute("data-modkit-mod", MOD_ID);\n' +
    '    style.textContent = ".tasks{color:red}";\n' +
    '    activeDocument.head.appendChild(style);\n' +
    '    this.register(() => style.remove());';
  const source = REPLAY_BASE.replace(ONLOAD_ANCHOR, code + '\n\n' + ONLOAD_ANCHOR);
  assert.notEqual(source, REPLAY_BASE, 'the onload anchor did not move — the injection did not land');

  const noPlane = validate(source);
  assert.deepEqual(
    noPlane.filter((f) => f.severity === 'error'),
    [],
    `no plane must stay clean (the permissive default), got:\n${show(noPlane)}`,
  );

  const planeE = validate(source, { reachPlane: 'E' });
  const hit = planeE.find((f) => f.rule === 'inject-stylesheet');
  assert.ok(hit, `plane E must catch this shape, got:\n${show(planeE)}`);
  assert.equal(hit.severity, 'error');
});

/* ── The sweep this pass ran against ITSELF ─────────────────────────────────── */

/**
 * Thirteen spellings nobody had written down, run against the lattice the moment it was working.
 *
 * This is the claim the whole restructure rests on, so it had to be tested rather than asserted:
 * if provenance is a real dataflow property, a spelling that was never enumerated should be caught
 * anyway. Eleven were, first try. **Two were not** — `T8` (a this-alias aliased a second time) and
 * `T11` (a mutator detached by destructuring, `const { assign } = Object`) — and both were closed
 * in the same pass by propagating `thisOf`/`member` through an identifier alias and by asking the
 * binding, not the call site, which method a mutator call goes through.
 *
 * They are kept because they are the honest record: the lattice is not magic, it just moves the
 * remaining holes from "any name you rebind" to "a channel nobody modelled" — and it fails closed
 * on the second kind, which is why `P13` matters more than any single row here.
 */
const TENTH_SPELLING_SWEEP = [
  { id: 'T1', desc: 'nested destructuring with a default and a rename',
    code: '    const { constructor: { prototype: proto3 = {} } = {} } = target;\n    proto3.getTasks = function () { return []; };' },
  { id: 'T2', desc: 'array destructuring out of a host array',
    code: '    const [leaf] = this.app.workspace.getLeavesOfType("markdown");\n    leaf.view = null;' },
  { id: 'T3', desc: 'a rest element off a host object',
    code: '    const { ...rest } = this.app.workspace;\n    rest.getLeaf = function () {};' },
  { id: 'T4', desc: 'a Set round-trip, read back by for-of',
    code: '    const seen = new Set();\n    seen.add(target.constructor.prototype);\n    for (const h of seen) { h.getTasks = function () { return []; }; }' },
  { id: 'T5', desc: 'an array push, then an index read',
    code: '    const holders = [];\n    holders.push(target.constructor.prototype);\n    holders[0].getTasks = function () { return []; };' },
  { id: 'T6', desc: 'two hops of arrow returns',
    code: '    const inner = () => target.constructor.prototype;\n    const outer = () => inner();\n    outer().getTasks = function () { return []; };' },
  { id: 'T7', desc: 'a promise .then() callback parameter',
    code: '    await Promise.resolve(target.constructor.prototype).then((h) => { h.getTasks = function () { return []; }; });' },
  { id: 'T8', desc: 'a this-alias aliased a second time (MISSED on the first sweep, closed here)',
    code: '    const a1 = this;\n    const b1 = a1;\n    b1.app.workspace.getLeaf = function () {};' },
  { id: 'T9', desc: 'an object literal member, read back',
    code: '    const box = { h: target.constructor.prototype };\n    box.h.getTasks = function () { return []; };' },
  { id: 'T10', desc: 'a field on `this` written in one method and read in another',
    code: '    this.stash = target.constructor.prototype;\n    this.modkitLand();',
    extraClass: '  modkitLand() {\n    this.stash.getTasks = function () { return []; };\n  }' },
  { id: 'T11', desc: 'a mutator detached by destructuring — const { assign } = Object (MISSED on the first sweep, closed here)',
    code: '    const { assign } = Object;\n    assign(target.constructor.prototype, { getTasks: function () { return []; } });' },
  { id: 'T12', desc: 'delete through a destructured prototype',
    code: '    const { prototype } = target.constructor;\n    delete prototype.getTasks;' },
  { id: 'T13', desc: 'an on-handler assigned to a destructured host element',
    code: '    const { body } = activeDocument;\n    body.onclick = () => this.modkitBump();' },
];

for (const c of TENTH_SPELLING_SWEEP) {
  test(`SWEEP ${c.id}: ${c.desc}`, () => {
    let source = REPLAY_BASE;
    if (c.extraClass) {
      source = source.replace(CLASS_ANCHOR, c.extraClass + '\n\n' + CLASS_ANCHOR);
      assert.notEqual(source, REPLAY_BASE, `${c.id}: the class anchor moved`);
    }
    const before = source;
    source = source.replace(ONLOAD_ANCHOR, c.code + '\n\n' + ONLOAD_ANCHOR);
    assert.notEqual(source, before, `${c.id}: the onload anchor moved — the injection did not land`);
    const findings = validate(source);
    assert.ok(
      findings.some((f) => f.severity === 'error'),
      `${c.id} returned zero findings:\n${show(findings)}`,
    );
  });
}

test('PATCH_PLUGIN_TEMPLATE stays clean under the lattice', () => {
  // The single most important pass-clean case in the file. The template is what every generated mod
  // is a copy of, so a lattice that rejects it rejects everything, and the whole hardening is a net
  // loss. Asserted separately from the earlier template test because this one is about the rewrite.
  assertClean(PATCH_PLUGIN_TEMPLATE, 'the template, under the binding lattice');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The build — a bundle that succeeds but has the wrong shape is the worst failure
 * ──────────────────────────────────────────────────────────────────────────── */

test('the template builds to an Obsidian-loadable main.js', async () => {
  const result = await buildPatchPlugin(PATCH_PLUGIN_TEMPLATE, { loader: 'js', sourcefile: 'main.js' });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors, null, 2));

  // The CJS handoff Obsidian actually reads.
  assert.match(result.code, /module\.exports = __toCommonJS\(/);
  assert.match(result.code, /default: \(\) =>/);
  // `obsidian` is answered by the host's own require; monkey-around is inlined, not required.
  assert.deepEqual(result.externals, ['obsidian']);
  assert.ok(
    result.inlined.some((p) => p.includes('monkey-around')),
    `monkey-around should be inlined, got ${result.inlined.join(', ')}`,
  );
  // The banner is the visible half of attribution: a user opening the file learns what it is.
  assert.match(result.code, /Generated by modkit/);
  assert.equal(result.sha256, sha256Hex(result.code));
  assert.equal(result.bytes, Buffer.byteLength(result.code, 'utf8'));
});

test('the build is deterministic — same source, same digest', async () => {
  const source = 'import { Plugin } from "obsidian";\nexport default class M extends Plugin {}\n';
  const a = await buildPatchPlugin(source);
  const b = await buildPatchPlugin(source);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.sha256, b.sha256);
});

test('a build that leaves a node builtin required at runtime is refused', async () => {
  // `node:` specifiers are in the external list, so esbuild builds this happily and emits
  // require("node:fs") — which throws on desktop startup and does not exist on mobile at all.
  // Catching it here rather than at enablePlugin() time is the whole point of the shape assertion.
  const source = 'import { readFileSync } from "node:fs";\nexport default class M { r = readFileSync; }\n';
  const result = await buildPatchPlugin(source);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.text).join('\n'), /require\(\)s "node:fs"/);
});

test('a build with no default export is refused before it can be enabled', () => {
  const noDefault = `var main_exports = {};
__export(main_exports, { helper: () => helper });
module.exports = __toCommonJS(main_exports);
`;
  const errors = assertObsidianShape(noDefault);
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /exports no `default`/);

  const notCjs = 'export default class X {}\n';
  assert.match(assertObsidianShape(notCjs)[0].text, /module\.exports = __toCommonJS/);

  assert.deepEqual(
    assertObsidianShape('var m = {};\n__export(m, { default: () => X });\nmodule.exports = __toCommonJS(m);\nvar o = require("obsidian");\n'),
    [],
  );
});

test('a source that does not compile comes back as errors, not as an exception', async () => {
  const result = await buildPatchPlugin('export default class {');
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(typeof result.errors[0].text, 'string');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Round 5 — the sixteen bypasses and the four false rejections
 *
 * Two independent adversaries ran against the round-4 build. Both returned NO, both converged on
 * the same causes, and both wrote their own fixtures. Every fixture below is one of theirs,
 * verbatim in shape, with the verdict it must now produce. The four false rejections matter as much
 * as the bypasses: `generate.ts` gives the model ONE correction turn, so refusing a correct
 * spelling pushes the next attempt toward the accepted one — and in the reclaim ledger's case the
 * accepted one was precisely the spelling that poisoned the whole file.
 * ──────────────────────────────────────────────────────────────────────────── */

const R5 = 'import { Plugin } from "obsidian";\nimport { around } from "monkey-around";\n';

/** Findings for a fragment (contract off unless asked), so a fixture is about its own defect. */
const r5Findings = (source, contract = false) =>
  validate(source, { requireTemplateContract: contract });

function r5Catch(source, label, contract = false) {
  const all = r5Findings(source, contract);
  const errs = all.filter((f) => f.severity === 'error');
  assert.ok(errs.length > 0, `${label}: expected an error finding, got none\n${show(all)}`);
  return errs;
}

function r5Clean(source, label, contract = false) {
  const all = r5Findings(source, contract);
  assert.deepEqual(all, [], `${label} must validate clean, got:\n${show(all)}`);
}

/** The rules a fixture trips, deduped — for asserting *which* defence caught it. */
const r5Rules = (source, contract = false) => rules(r5Findings(source, contract));

/** A complete, contract-shaped mod, so the template rules are actually in play. */
const r5Mod = (body, gate = "    if (!requireApiVersion('1.7.2')) return;") =>
  `import { Notice, Plugin, requireApiVersion } from 'obsidian';
import { around } from 'monkey-around';
const MOD_ID = 'm';
export default class M extends Plugin {
  async onload() {
${gate}
    const target = this.app?.plugins?.plugins?.['dataview'];
    if (!target) return;
    const holder = target.constructor?.prototype;
    if (!holder) return;
${body}
  }
  async modkitProbe() { return true; }
}
`;

/* ── 1. The reclaim ledger: identities, not a global bag of bare names ─────── */

test('R5-1: one correct teardown no longer disarms must-be-reclaimed for the whole file', () => {
  // `reclaimedNames` was a global, unscoped Set of NAMES, head-matched against a dotted path. A
  // single correct `this.register(() => this.styleEl.remove())` therefore put `this` in the bag and
  // exempted every `this.*`-rooted host mutation in the file. Worse: the template's own register
  // block mentions `self`, `holder`, `next`, `args` and `err`, so those names were pre-poisoned for
  // every generated mod. All four of these were zero findings.
  // A <div>, not a <style> element: `inject-stylesheet` (added for L1) would also fire on a <style>
  // element built this way, on top of the `must-be-reclaimed` this fixture means to isolate.
  const viaThis = `${R5}
export default class M extends Plugin {
  onload() {
    this.boxEl = activeDocument.createElement("div");
    this.register(() => this.boxEl.remove());
    this.app.workspace.containerEl.addClass("modkit-permanent");
  }
}`;
  assert.deepEqual(r5Rules(viaThis), ['must-be-reclaimed'], 'a permanent class beside a correct teardown');

  const viaSelf = `${R5}
export default class M extends Plugin {
  onload() {
    const self = this;
    self.boxEl = activeDocument.createElement("div");
    this.register(() => self.boxEl.remove());
    self.app.workspace.containerEl.addClass("modkit-permanent");
  }
}`;
  assert.deepEqual(r5Rules(viaSelf), ['must-be-reclaimed'], 'the same through the template-taught `self`');

  // Two different bindings that happen to share a spelling are two different things.
  const collide = `${R5}
export default class M extends Plugin {
  onload() {
    const root = activeDocument.createElement("div");
    this.app.workspace.containerEl.appendChild(root);
    this.register(() => root.remove());
    this.decorate();
  }
  decorate() { const root = this.app.workspace.containerEl; root.addClass("modkit-permanent"); }
}`;
  assert.deepEqual(r5Rules(collide), ['must-be-reclaimed'], 'a name collision across two methods');

  // The same bag disarmed the frame-loop rule: any cancelled `frame` cancelled every `frame`.
  const frame = `${R5}
export default class M extends Plugin {
  onload() {
    const frame = activeWindow.requestAnimationFrame(() => 1);
    this.register(() => activeWindow.cancelAnimationFrame(frame));
    this.spin();
  }
  spin() { const frame = activeWindow.requestAnimationFrame(() => this.spin()); }
}`;
  assert.deepEqual(r5Rules(frame), ['no-raw-timer'], 'a second, uncancelled frame loop');
});

test('R5-1: the three correct reclaim spellings the ledger used to refuse (were FALSE rejections)', () => {
  // <div>, not <style>: `inject-stylesheet` (added for L1) would also fire on a <style> element
  // built this way, on top of the reclaim-spelling this fixture means to isolate.
  //
  // A teardown delegated to a helper. The helper really does remove it; the old ledger only ever
  // looked at literal TEARDOWN_CALLS names inside the register argument itself.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const s = activeDocument.createElement("div");
    activeDocument.body.appendChild(s);
    this.register(() => this.teardown(s));
  }
  teardown(s) { s.remove(); }
}`,
    'a reclaim delegated to a helper method',
  );

  // `this.register(this.cleanup.bind(this))` — the canonical way to register an existing method.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    this.boxEl = activeDocument.createElement("div");
    activeDocument.body.appendChild(this.boxEl);
    this.register(this.cleanup.bind(this));
  }
  cleanup() { this.boxEl.remove(); }
}`,
    'a reclaim registered through .bind',
  );

  // onunload() is Obsidian's OWN documented teardown hook. Refusing it is indefensible.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    this.boxEl = activeDocument.createElement("div");
    activeDocument.body.appendChild(this.boxEl);
  }
  onunload() { this.boxEl.remove(); }
}`,
    'a reclaim in onunload()',
  );

  // And the delegation must not become a new free pass: a helper that removes something ELSE
  // reclaims nothing.
  const wrongThing = `${R5}
export default class M extends Plugin {
  onload() {
    const s = activeDocument.createElement("div");
    const other = activeDocument.createElement("div");
    activeDocument.body.appendChild(s);
    this.register(() => this.teardown(other));
  }
  teardown(x) { x.remove(); }
}`;
  assert.deepEqual(r5Rules(wrongThing), ['must-be-reclaimed'], 'a helper that removes the wrong node');
});

/* ── 2. NewExpression resolved DOWN to owned instead of UP to unknown ──────── */

test('R5-2: a constructor that wraps its argument is not the mod\'s own (were 0 findings)', () => {
  const proxy = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const p = new Proxy(t.constructor.prototype, {});
    p.getTasks = () => 1;
  }
}`;
  assertIncludes(proxy, ['no-host-assignment'], 'new Proxy(hostProto, {}) — Proxy is on INERT_GLOBALS');

  const stash = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    class Box { constructor(h) { this.h = h; } }
    const b = new Box(t.constructor.prototype);
    b.h.getTasks = () => 1;
  }
}`;
  assertIncludes(stash, ['no-host-assignment'], 'a one-line class that stashes its argument');

  const seeded = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const bag = new Map([["h", t.constructor.prototype]]);
    bag.get("h").getTasks = () => 1;
  }
}`;
  assertIncludes(seeded, ['no-host-assignment'], 'a Map seeded in its constructor argument');

  const ref = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const r = new WeakRef(t.constructor.prototype);
    r.deref().getTasks = () => 1;
  }
}`;
  assertIncludes(ref, ['no-host-assignment'], 'new WeakRef(holder).deref()');

  // And the direction that keeps fail-closed from meaning fail-always: a construction whose
  // arguments are the mod's own is still the mod's own.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const obs = new MutationObserver(() => 1);
    obs.observe(activeDocument.body, { childList: true });
    this.register(() => obs.disconnect());
  }
}`,
    'a constructor handed nothing of the host\'s',
  );
});

/* ── 3. An object member's getter body was never evaluated ─────────────────── */

test('R5-3: a getter or method that hands back the host makes its container the host\'s', () => {
  const getter = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const box = { get h() { return t.constructor.prototype; } };
    box.h.getTasks = () => 1;
  }
}`;
  assertIncludes(getter, ['no-host-assignment'], 'an object-literal getter returning the holder');

  const method = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const api = { h() { return t.constructor.prototype; } };
    api.h().getTasks = () => 1;
  }
}`;
  assertIncludes(method, ['no-host-assignment'], 'a shorthand method returning the holder');

  const defined = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const box = {};
    Object.defineProperty(box, "h", { get() { return t.constructor.prototype; } });
    box.h.getTasks = () => 1;
  }
}`;
  assertIncludes(defined, ['no-host-assignment'], 'a getter installed with Object.defineProperty');

  const staticGetter = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    class Box { static get h() { return t.constructor.prototype; } }
    Box.h.getTasks = () => 1;
  }
}`;
  assertIncludes(staticGetter, ['no-host-assignment'], 'a class static getter returning the holder');
});

/* ── 4. A parameter DEFAULT is a call site the analysis never read ─────────── */

test('R5-4: a holder carried in on a parameter default (was 0 findings on four spellings)', () => {
  const spellings = [
    ['a declaration called with no arguments', 'function install(h = holder) { h.getTasks = () => 1; }\n    install();'],
    ['called with an explicit undefined', 'function install(h = holder) { h.getTasks = () => 1; }\n    install(undefined);'],
    ['an arrow with a default', 'const install = (h = holder) => { h.getTasks = () => 1; };\n    install();'],
    ['a default after a supplied parameter', 'function install(a, h = holder) { h.getTasks = () => 1; }\n    install(1);'],
  ];
  for (const [label, body] of spellings) {
    const source = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const holder = t.constructor.prototype;
    ${body}
  }
}`;
    assertIncludes(source, ['no-host-assignment'], label);
  }
});

/* ── 5. fieldProv defaulted an unwritten field to owned, and the Modal carve-out
 *      short-circuited before the field's real provenance was consulted ─────── */

test('R5-5: a subclass of a HOST class does not own the fields it inherited (were 0 findings)', () => {
  const view = (body) => `import { ItemView, Plugin } from "obsidian";
class V extends ItemView {
  onOpen() {
${body}
  }
}
export default class M extends Plugin { onload() { this.v = V; } }
`;
  assertIncludes(view('    this.leaf.view = null;'), ['no-host-assignment'], 'ItemView this.leaf');
  assertIncludes(view('    this.scope.register = function () {};'), ['no-host-assignment'], 'ItemView this.scope');
  assertIncludes(view('    this.leaf.on("x", () => {});'), ['event-must-be-registered'], 'an unregistered this.leaf.on');

  assertIncludes(
    `import { MarkdownView, Plugin } from "obsidian";
class V extends MarkdownView {
  onOpen() { this.editor.setValue = function () {}; }
}
export default class M extends Plugin { onload() { this.v = V; } }
`,
    ['no-host-assignment'],
    'MarkdownView this.editor',
  );

  // The carve-out is for a field OBSIDIAN wrote. A host value the mod parked on a carve-out name is
  // worth what the mod put there — this returned zero findings, laundered through `this.modalEl`.
  assertIncludes(
    `import { Plugin, Modal } from "obsidian";
class Dlg extends Modal {
  arm(p) { this.modalEl = p; this.modalEl.getTasks = () => 1; }
}
export default class M extends Plugin {
  onload() { const t = this.app?.plugins?.plugins?.["tasks"]; new Dlg(this.app).arm(t.constructor.prototype); }
}
`,
    ['no-host-assignment'],
    'a host prototype parked on a carve-out field',
  );

  // Both canonical idioms stay legal: an unwritten carve-out field is still Obsidian's to empty.
  r5Clean(
    `import { Plugin, Modal } from "obsidian";
class Dlg extends Modal {
  onOpen() { this.contentEl.addClass("modkit-x"); this.contentEl.setText("hi"); }
}
export default class M extends Plugin { onload() { this.d = Dlg; } }
`,
    'contentEl inside a Modal onOpen',
  );
  r5Clean(
    `import { Plugin, PluginSettingTab, Setting } from "obsidian";
class Tab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("x").addToggle((t) => t.setValue(true));
  }
}
export default class M extends Plugin { onload() { this.addSettingTab(new Tab(this.app, this)); } }
`,
    'a PluginSettingTab building its own UI',
  );
});

/* ── 6. The contract rules asked for a NAME where the host rules ask the lattice ─ */

test('R5-6: a patch installed BY ASSIGNMENT owes the same contract as one installed by around()', () => {
  // The matched pair. Same target, same damage, only the install spelling differs. Before this pass
  // the around() one was rejected three times over and the assignment one shipped clean.
  const viaAround = r5Mod(
    "    this.register(around(holder, { getTasks: (n) => function (...a) { return n.apply(this, a); } }));",
  );
  const viaAssignment = r5Mod(`    const v = new Proxy(holder, {});
    const b = v.getTasks;
    v.getTasks = function (...a) { return b.apply(this, a); };`);

  for (const rule of ['missing-version-gate', 'accessor-target']) {
    assert.ok(
      rules(validate(viaAround)).includes(rule),
      `the around() control must still trip ${rule}\n${show(validate(viaAround))}`,
    );
    assert.ok(
      rules(validate(viaAssignment)).includes(rule),
      `the assignment install must trip ${rule} too\n${show(validate(viaAssignment))}`,
    );
  }

  // And the second half: requireApiVersion() alone is NOT a gate on a third-party class dug out of
  // a live object. The mod never touches app.plugins, so `internalRooted` stayed empty and a bare
  // requireApiVersion() satisfied the rule.
  const derived = `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
export default class M extends Plugin {
  async modkitProbe() { return true; }
  onload() {
    if (!requireApiVersion("1.7.2")) return;
    const leaf = this.app.workspace.getMostRecentLeaf();
    const holder = leaf.view.constructor.prototype;
    const d = Object.getOwnPropertyDescriptor(holder, "onOpen");
    if (d && (d.get || d.set)) return;
    if (Object.prototype.hasOwnProperty.call(leaf.view, "onOpen")) return;
    this.register(around(holder, { onOpen: (n) => function () { return n.call(this); } }));
  }
}
`;
  assertIncludes(derived, ['missing-version-gate'], 'a third-party view prototype behind requireApiVersion alone');

  // The carve-out itself survives, because plane A patches Obsidian's own API and requireApiVersion
  // is exactly the right gate for it.
  r5Clean(
    `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
export default class M extends Plugin {
  async modkitProbe() { return true; }
  onload() {
    if (!requireApiVersion("1.7.2")) return;
    const holder = this.app.workspace;
    const d = Object.getOwnPropertyDescriptor(holder, "getLeaf");
    if (d && (d.get || d.set)) return;
    this.register(around(holder, { getLeaf: (n) => function () { return n.call(this); } }));
  }
}
`,
    'requireApiVersion as the gate for a documented Obsidian object',
    true,
  );
});

/* ── 7. OWNING_FACTORIES matched a method NAME and ignored the receiver ────── */

test('R5-7: createEl/createDiv on a host receiver is createElement AND appendChild (were 0 findings)', () => {
  const leak = (body) => `${R5}
export default class M extends Plugin {
  onload() {
${body}
  }
}`;
  for (const [label, body, expected] of [
    // The headline discovery is still a <style> tag, and it now trips two independent defences —
    // `must-be-reclaimed` because nothing removes it, and `inject-stylesheet` (added for L1)
    // because a plane-E mod (or, absent plane info, any mod) should never build one this way at
    // all. Both firing is the point: this is the pattern that shipped live on 2026-09-02.
    ['head.createEl("style") — a permanent CSS injection', '    activeDocument.head.createEl("style", { text: ".x { display: none }" });', ['inject-stylesheet', 'must-be-reclaimed']],
    ['body.createDiv — a permanent node in the user document', '    activeDocument.body.createDiv({ cls: "leak" });', ['must-be-reclaimed']],
    ['workspace.containerEl.createEl', '    this.app.workspace.containerEl.createEl("div", { text: "leak" });', ['must-be-reclaimed']],
    ['createSpan on a host element', '    this.app.workspace.containerEl.createSpan("leak");', ['must-be-reclaimed']],
  ]) {
    assert.deepEqual(rules(r5Findings(leak(body))), expected, label);
  }

  // Bound and reclaimed is the correct spelling and stays clean — a <div>, not a <style> element,
  // since `inject-stylesheet` now rejects the latter however it is reclaimed.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const el = activeDocument.head.createEl("div", { text: "leak" });
    this.register(() => el.remove());
  }
}`,
    'a createEl whose removal is registered',
  );
  // The detached factories insert nothing and must stay legal.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const s = activeDocument.createElement("div");
    s.textContent = "leak";
    activeDocument.head.appendChild(s);
    this.register(() => s.remove());
  }
}`,
    'createElement, appended, removal registered',
  );
});

/* ── 8. no-host-assignment inspected exactly one node shape ────────────────── */

test('R5-8: every other way of writing to a host member (all were 0 findings)', () => {
  const write = (body) => `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const h = t.constructor.prototype;
${body}
  }
}`;
  assertIncludes(write('    [h.getTasks] = [() => 1];'), ['no-host-assignment'], 'an ArrayPattern LHS');
  assertIncludes(write('    ({ a: h.getTasks } = { a: () => 1 });'), ['no-host-assignment'], 'an ObjectPattern LHS');
  assertIncludes(write('    for (h.getTasks of [() => 1]) { }'), ['no-host-assignment'], 'a for-of assignment target');
  assertIncludes(
    `${R5}
export default class M extends Plugin {
  onload() { this.app.workspace.leftSplit.collapsed++; }
}`,
    ['no-host-assignment'],
    'an UpdateExpression on a host member',
  );

  // The mod's own state, written the same four ways, is still the mod's own.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    this.state = { a: 0, b: 0 };
    [this.state.a] = [1];
    ({ b: this.state.b } = { b: 2 });
    this.state.a++;
  }
}`,
    'the same shapes on the mod\'s own object',
  );
});

/* ── 9. An insert is a removal at the other end ────────────────────────────── */

test('R5-9: a host node moved into the mod\'s own container is still taken (was 0 findings)', () => {
  const theft = `${R5}
export default class M extends Plugin {
  onload() {
    const box = activeDocument.createElement("div");
    box.appendChild(this.app.workspace.containerEl.firstChild);
    this.register(() => box.remove());
  }
}`;
  const errs = r5Catch(theft, 'a reparented host element');
  assert.ok(
    errs.some((f) => f.rule === 'must-be-reclaimed' && /moves a node that belongs to the host/.test(f.message)),
    `the message must name the theft, not the container\n${show(errs)}`,
  );

  // Appending the mod's own node into the mod's own container is untouched.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const box = activeDocument.createElement("div");
    const inner = activeDocument.createElement("span");
    box.appendChild(inner);
  }
}`,
    'an owned node into an owned container',
  );
});

/* ── 10. Component.register takes exactly one callback ─────────────────────── */

test('R5-10: this.register(a, b) drops b at runtime, and no longer sanctions it (was 0 findings)', () => {
  const two = `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const h = t.constructor.prototype;
    this.register(around(h, { getTasks: (n) => function(){ return n.call(this); } }),
                  around(h, { getGroups: (n) => function(){ return n.call(this); } }));
  }
}`;
  const errs = r5Catch(two, 'two uninstallers in one register call');
  assert.ok(
    errs.some((f) => f.rule === 'patch-must-be-registered'),
    `the second patch outlives the mod forever\n${show(errs)}`,
  );

  // One per call is the correct shape and stays clean.
  r5Clean(
    `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const h = t.constructor.prototype;
    this.register(around(h, { getTasks: (n) => function(){ return n.call(this); } }));
    this.register(around(h, { getGroups: (n) => function(){ return n.call(this); } }));
  }
}`,
    'one this.register(...) per uninstaller',
  );
});

/* ── 11. Binding.member came only from a direct MemberExpression initialiser ── */

test('R5-11: a detached method through a sequence, a .bind, and a baked-in holder (were 0 findings)', () => {
  assertIncludes(
    `${R5}
export default class M extends Plugin { onload() { const s = (0, activeWindow.setInterval); s(() => 1, 100); } }`,
    ['no-raw-timer'],
    'a timer detached through a sequence expression',
  );
  assertIncludes(
    `${R5}
export default class M extends Plugin {
  onload() { const on = activeDocument.addEventListener.bind(activeDocument); on("click", () => 1); }
}`,
    ['no-raw-listener'],
    'addEventListener detached with .bind',
  );
  assertIncludes(
    `${R5}
export default class M extends Plugin {
  onload() {
    const t = this.app?.plugins?.plugins?.["tasks"];
    const put = Reflect.set.bind(null, t.constructor.prototype);
    put("getTasks", () => 1);
  }
}`,
    ['no-host-assignment'],
    'Reflect.set with the host holder baked in by .bind',
  );
});

/* ── 12. The Function constructor does not need `new` ──────────────────────── */

test('R5-12: a code-loader binding CALLED rather than constructed (was 0 findings)', () => {
  assertIncludes(
    `${R5}
export default class M extends Plugin {
  onload() { const C = ({}).constructor; const F = C.constructor; F("return 1")(); }
}`,
    ['no-eval'],
    'Function reached through two .constructor hops and called',
  );
});

/* ── 13. The no-effect probe was satisfied by a name ───────────────────────── */

test('R5-13: an empty modkitProbe() body reports nothing and no longer counts', () => {
  const empty = `import { Plugin, requireApiVersion } from "obsidian";
export default class M extends Plugin {
  modkitProbe() {}
  onload() { if (!requireApiVersion("1.7.2")) return; }
}
`;
  assertIncludes(empty, ['missing-no-effect-probe'], 'a probe with an empty body');

  const reports = `import { Plugin, requireApiVersion } from "obsidian";
export default class M extends Plugin {
  modkitProbe() { return this.calls > 0; }
  onload() { this.calls = 0; if (!requireApiVersion("1.7.2")) return; }
}
`;
  r5Clean(reports, 'a probe that hands something back', true);
});

/* ── 14. The version gate lost the flow through a coercion ─────────────────── */

test('R5-14: a plausible inline major-version gate is accepted (was a FALSE rejection)', () => {
  const gated = (gate) => `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
function descriptorFor(holder, name) {
  let c = holder;
  while (c) { const d = Object.getOwnPropertyDescriptor(c, name); if (d) return d; c = Object.getPrototypeOf(c); }
  return null;
}
export default class M extends Plugin {
  async modkitProbe() { return true; }
  async onload() {
    if (!requireApiVersion("1.7.2")) return;
${gate}
    const target = this.app?.plugins?.plugins?.["dataview"];
    if (!target) return;
    const holder = target.constructor?.prototype;
    if (!holder) return;
    const desc = descriptorFor(holder, "getTasks");
    if (!desc) return;
    if (desc.get || desc.set) return;
    if (Object.prototype.hasOwnProperty.call(target, "getTasks")) return;
    this.register(around(holder, { getTasks: (n) => function (...a) { self.calls += 1; return n.apply(this, a); } }));
  }
}
`;
  // ⚠️ The wrapper counts a call rather than being a bare pass-through, and the `self` alias exists
  // only to let it. This fixture's subject is the **version gate**; the wrapper was incidental
  // filler, and a bare `return n.apply(this, a)` now draws a `no-op-patch` warning (a mod that
  // provably changes nothing is the failure the no-effect probe exists for). The gate assertion —
  // and `r5Clean`'s "not one finding of any severity" — is unchanged.
  const read =
    '    const self = this;\n    self.calls = 0;\n' +
    '    const v = this.app?.plugins?.manifests?.["dataview"]?.version ?? null;\n    if (v === null) return;\n';

  // The one that was refused: the version flows through String()/split()/Number() before the check.
  r5Clean(
    gated(read + '    const major = Number(String(v).split(".")[0]);\n    if (major < 1) return;'),
    'an inline major-version gate',
    true,
  );
  // The three controls the adversary used to prove it was the analysis and not the fixture.
  r5Clean(gated(read + '    if (v < "0.5.0") return;'), 'a direct string compare', true);
  r5Clean(
    gated(read + '    if (v.localeCompare("0.5.0", undefined, { numeric: true }) < 0) return;'),
    'a localeCompare gate',
    true,
  );

  // ⚠️ And the other direction, which the same flow work closed: a gate COMPUTED AND DISCARDED is
  // still not a gate. `inRange(v);` as a bare statement refuses nothing.
  assertIncludes(
    `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
function inRange(v) { return String(v).split(".")[0] >= "7"; }
export default class M extends Plugin {
  async modkitProbe() { return true; }
  onload() {
    if (!requireApiVersion("1.7.2")) return;
    const t = this.app?.plugins?.plugins?.["tasks"];
    const v = this.app?.plugins?.manifests?.["tasks"]?.version;
    inRange(v);
    const h = t.constructor.prototype;
    const d = Object.getOwnPropertyDescriptor(h, "getTasks");
    if (d && (d.get || d.set)) return;
    if (Object.prototype.hasOwnProperty.call(t, "getTasks")) return;
    this.register(around(h, { getTasks: (n) => function(){ return n.call(this); } }));
  }
}
`,
    ['missing-version-gate'],
    'a range check whose result is thrown away',
  );
});

/* ── The acceptance test: the two complete mods that shipped at zero findings ── */

test('R5-ACCEPTANCE: the four end-to-end mods that validated clean while doing permanent damage', () => {
  const e2e = `import { Notice, Plugin, requireApiVersion } from 'obsidian';

const MOD_ID = 'modkit-mod-dataview-fast-tasks';
const MOD_LABEL = 'Mod: Dataview — cache getTasks';
const TARGET_LABEL = 'Dataview';

export default class ModkitPatchPlugin extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    this.modkitHealth = { state: 'target-gone', detail: 'not checked yet' };
    if (!requireApiVersion('1.7.2')) return;

    const target = this.app?.plugins?.plugins?.['dataview'];
    if (!target) return;
    const holder = target.constructor?.prototype;
    if (!holder) return;

    const self = this;
INSTALL

    this.modkitHealth = { state: 'applied', detail: '' };
    new Notice(MOD_LABEL + ' — patched ' + TARGET_LABEL);
  }

  async modkitProbe() {
    const before = this.modkitCalls;
    const target = this.app?.plugins?.plugins?.['dataview'];
    if (!target) return false;
    return this.modkitCalls > before;
  }
}
`;
  const installs = {
    'a Proxy-laundered prototype patch with no around() and no uninstaller': `    const view = new Proxy(holder, {});
    const base = view.getTasks;
    view.getTasks = function patched(...args) {
      self.modkitCalls += 1;
      return base.apply(this, args);
    };`,
    'the same patch laundered through an object-literal getter': `    const box = { get held() { return holder; } };
    const view = box.held;
    const base = view.getTasks;
    view.getTasks = function patched(...args) {
      self.modkitCalls += 1;
      return base.apply(this, args);
    };`,
    'the same patch laundered through a parameter default': `    function install(h = holder) {
      const base = h.getTasks;
      h.getTasks = function patched(...args) {
        self.modkitCalls += 1;
        return base.apply(this, args);
      };
    }
    install();`,
    'a permanent CSS injection through activeDocument.head.createEl': `    activeDocument.head.createEl('style', {
      text: '.dataview-task { display: none !important; }',
      attr: { 'data-modkit-mod': MOD_ID },
    });`,
  };
  for (const [label, install] of Object.entries(installs)) {
    const source = e2e.replace('INSTALL', install);
    const errs = validate(source).filter((f) => f.severity === 'error');
    assert.ok(errs.length > 0, `${label} must be blocked\n${show(validate(source))}`);
  }

  // "The worst thing a plausible model output could do that this validator permits." Every line is
  // a shape a model reaches for unprompted; it validated at ZERO findings under the full contract.
  const worst = `import { Plugin, Modal, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

const MOD_ID = "modkit-mod-tasks-compact";
const CSS = ".modkit-compact .task-list-item { line-height: 1.1; }";

class HelpModal extends Modal {
  onOpen() {
    this.contentEl.setText("Compact tasks is active.");
  }
  arm(view) {
    this.modalEl = view.constructor.prototype;
    this.modalEl.modkitCompact = true;
  }
}

export default class ModkitCompactTasks extends Plugin {
  modkitProbe() {}

  async onload() {
    if (!requireApiVersion("1.7.2")) return;

    const self = this;
    self.styleEl = activeDocument.createElement("style");
    self.styleEl.textContent = CSS;
    self.styleEl.setAttribute("data-modkit-mod", MOD_ID);
    activeDocument.head.appendChild(self.styleEl);
    this.register(() => self.styleEl.remove());

    self.app.workspace.containerEl.addClass("modkit-compact");

    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;
    const holder = leaf.view.constructor.prototype;

    const d = Object.getOwnPropertyDescriptor(holder, "onOpen");
    if (d && (d.get || d.set)) return;
    if (Object.prototype.hasOwnProperty.call(leaf.view, "onOpen")) return;

    this.register(around(holder, {
      onOpen: (next) => function () { return next.call(this); },
    }));

    const help = new HelpModal(this.app);
    help.arm(leaf.view);
  }
}
`;
  const worstRules = rules(validate(worst));
  for (const rule of [
    'missing-no-effect-probe', // the empty probe
    'no-host-assignment', // the host prototype parked on the Modal carve-out field
    'must-be-reclaimed', // the permanent class on Obsidian's workspace element
    'missing-version-gate', // requireApiVersion is not a gate on a third-party view class
  ]) {
    assert.ok(worstRules.includes(rule), `the worst-case mod must trip ${rule}\n${show(validate(worst))}`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Round 6 — the effects axis, and the last lattice cell
 *
 * Round 5's finding was not another bypass of the reclaim contract: both adversaries confirmed the
 * binding lattice holds, 158/159 prior fixtures caught, every provenance-laundering shape refused.
 * What they found was a SECOND AXIS, named exactly:
 *
 *   "The reclaim contract asks: can Obsidian take this patch back. Every finding below is a mod
 *    whose patch IS perfectly removable and whose EFFECTS are not. Disabling the mod does not
 *    un-rewrite a note, un-trash a file, un-disable Dataview, un-send a POST, or un-run
 *    child_process."
 *
 * — plus one remaining cell of the lattice itself, where an unresolvable call INHERITED its
 * receiver's provenance instead of degrading.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Effects for a fragment. Effects never block, so these assertions are about the *declaration*. */
const effectsOf = (source, contract = false) =>
  validateSource(source, { requireTemplateContract: contract }).effects;
const effectKinds = (source, contract = false) =>
  [...new Set(effectsOf(source, contract).map((e) => e.kind))].sort();

test('R6-1: activeWindow.require is the whole node filesystem, and was banned only as a bare name', () => {
  // Both halves of the finding: the member form must be exactly as banned as the bare form, and the
  // rejection must stop naming `activeWindow` as the remedy for `require`.
  const bare = r5Catch(`${R5}
export default class M extends Plugin { onload() { const fs = require("fs"); fs.writeFileSync("/tmp/x", ""); } }`, 'bare require');
  const member = r5Catch(`${R5}
export default class M extends Plugin { onload() { const fs = activeWindow.require("fs"); fs.writeFileSync("/tmp/x", ""); } }`, 'activeWindow.require');
  assert.ok(rules(member).includes('no-bare-global'), show(member));

  for (const findings of [bare, member]) {
    // The remedy is the half after the em dash; quoting the offending expression back is fine, but
    // *recommending* activeWindow for require() is how the correction turn learned the bypass.
    const remedies = findings.map((f) => f.message.split('—').slice(1).join('—')).join('\n');
    assert.ok(
      !/activeDocument\/activeWindow|use activeWindow/.test(remedies),
      'the rejection for require() must not offer activeWindow as the remedy — that is the ' +
        `working bypass, handed to the correction turn:\n${remedies}`,
    );
    assert.ok(/filesystem/.test(remedies), `the remedy must be the real one:\n${remedies}`);
  }

  // The rest of the seam, each reproduced at zero findings on 2026-08-31.
  for (const [label, body] of [
    ['child_process', 'const cp = activeWindow.require("child_process"); cp.execFile("/bin/ls", [], () => {});'],
    ['fetch', 'activeWindow.fetch("https://x.example", { method: "POST" });'],
    ['localStorage', 'activeWindow.localStorage.setItem("k", "v");'],
    ['process', 'this.p = activeWindow.process.env;'],
    ['electron', 'this.e = activeWindow.electron;'],
    ['open', 'activeWindow.open("https://x.example");'],
    ['sendBeacon on the bare navigator', 'navigator.sendBeacon("https://x.example", "d");'],
    ['destructured require', 'const { rmSync } = activeWindow.require("fs"); rmSync("/tmp/x");'],
  ]) {
    r5Catch(`${R5}
export default class M extends Plugin { onload() { ${body} } }`, `${label} through the window`);
  }
});

test('R6-2: a WebSocket is a connection the reclaim contract has to give back', () => {
  const rulesFor = r5Rules(`${R5}
export default class M extends Plugin { onload() { const ws = new activeWindow.WebSocket("wss://x.example"); this.ws = ws; } }`);
  assert.ok(rulesFor.includes('must-be-reclaimed'), rulesFor.join(','));

  // …and closing it is the remedy the message names, so the remedy must pass.
  r5Clean(`${R5}
export default class M extends Plugin { onload() { const ws = new activeWindow.WebSocket("wss://x.example"); this.register(() => ws.close()); } }`,
    'a WebSocket closed at unload');
});

test('R6-3: THE LAST LATTICE CELL — a #private method resolved to owned instead of unknown', () => {
  // Adversary 2, verbatim: "A call to a #private method on this resolves to owned instead of
  // unknown, so the lattice own fail-closed rule never applies… The fail-open is INSIDE the
  // lattice, in the one cell where an unresolvable call INHERITS its receiver provenance instead of
  // DEGRADING."
  const grab = 'const t = this.app?.plugins?.plugins?.["tasks"]; return t.constructor.prototype;';
  const cases = [
    ['a host write', '#grab() { ' + grab + ' }', 'const h = this.#grab(); h.getTasks = () => 1;', 'no-host-assignment'],
    ['used directly', '#grab() { ' + grab + ' }', 'this.#grab().getTasks = () => 1;', 'no-host-assignment'],
    ['a DOM leak', '#root() { return this.app.workspace.containerEl; }', 'this.#root().addClass("forever");', 'must-be-reclaimed'],
    ['an event', '#ws() { return this.app.workspace; }', 'this.#ws().on("file-open", () => 1);', 'event-must-be-registered'],
    ['a delete', '#grab() { ' + grab + ' }', 'delete this.#grab().getTasks;', 'no-host-assignment'],
  ];
  for (const [label, method, body, rule] of cases) {
    const found = r5Rules(`${R5}
export default class M extends Plugin { ${method} onload() { ${body} } }`);
    assert.ok(found.includes(rule), `${label} through a #private method must trip ${rule}, got ${found.join(',')}`);
  }

  // The audit the finding asked for: the same degrade for ANY unresolvable member call. A method
  // that is not in the file at all is not the mod's just because `this` is.
  assert.ok(
    r5Rules(`${R5}
export default class M extends Plugin { onload() { const h = this.notAMethod(); h.getTasks = () => 1; } }`).includes(
      'no-host-assignment',
    ),
    'a call to a method that does not exist must degrade to unknown',
  );

  // …and the control it must not cost: a private helper that returns something the mod DID create.
  r5Clean(`${R5}
export default class M extends Plugin { #box() { return activeDocument.createElement("div"); }
  onload() { const b = this.#box(); b.addClass("mine"); this.register(() => b.remove()); } }`,
    'a private helper returning an owned element');
});

test('R6-4: the loop class — nothing to unload, and relaunching hangs it again', () => {
  const loops = [
    ['async while(true)', 'async onload() { while (true) { await Promise.resolve(); if (this.app) break; } }'],
    ['for(;;)', 'async onload() { for (;;) { await null; if (this.app) break; } }'],
    ['do…while(true)', 'async onload() { do { await null; } while (true); }'],
    ['a const-false-free while', 'async onload() { const GO = true; while (GO) { await null; } }'],
  ];
  for (const [label, body] of loops) {
    assert.ok(
      r5Rules(`${R5}
export default class M extends Plugin { ${body} }`).includes('no-unstoppable-loop'),
      `${label} must be caught`,
    );
  }

  // The self-rescheduling spellings. The timer forms are `no-raw-timer` (queueMicrotask joined
  // RAW_TIMER_CALLS in this pass); the promise and recursion forms had no rule at all.
  assert.ok(
    r5Rules(`${R5}
export default class M extends Plugin { onload() { const loop = () => activeWindow.queueMicrotask(loop); loop(); } }`).includes(
      'no-raw-timer',
    ),
    'a queueMicrotask pump must be caught',
  );
  assert.ok(
    r5Rules(`${R5}
export default class M extends Plugin { onload() { const loop = () => { Promise.resolve().then(loop); }; loop(); } }`).includes(
      'no-unstoppable-loop',
    ),
    'a promise-chain pump must be caught',
  );
  assert.ok(
    r5Rules(`${R5}
export default class M extends Plugin { async onload() { await this.spin(); }
  async spin() { await Promise.resolve(); return this.spin(); } }`).includes('no-unstoppable-loop'),
    'an async self-recursive pump must be caught',
  );

  // Bounded loops are ordinary code and must stay clean — the template walks a prototype chain.
  r5Clean(`${R5}
export default class M extends Plugin { onload() {
  let c = this.app; let n = 0;
  while (c) { c = Object.getPrototypeOf(c); n += 1; }
  for (let i = 0; i < 10; i++) { n += i; }
  this.n = n; } }`, 'bounded loops');
});

test('R6-5: the SAFE multi-patch form was rejected and the UNSAFE one accepted', () => {
  // Measured correction-loop poisoning: the only correct way to reclaim two around() calls on two
  // holders was refused, while dropping an uninstaller into a one-argument helper passed.
  const T = 'const t = this.app?.plugins?.plugins?.["tasks"]; const h = t.constructor.prototype;';
  // A real wrapper (it rewrites the return), so neither `no-op-patch` nor a host write on the
  // target's own `this` shows up and the fixtures are about the reclaim shape alone.
  const W = '(n) => function (...a) { const r = n.apply(this, a); return r === undefined ? r : r; }';

  r5Clean(`${R5}
export default class M extends Plugin { onload() { ${T}
  const offs = [around(h, { render: ${W} }), around(h, { refresh: ${W} })];
  this.register(() => { for (const off of offs) off(); }); } }`, 'an array of uninstallers, for…of');

  r5Clean(`${R5}
export default class M extends Plugin { onload() { ${T}
  const offs = [around(h, { render: ${W} }), around(h, { refresh: ${W} })];
  this.register(() => offs.forEach((f) => f())); } }`, 'an array of uninstallers, forEach');

  r5Clean(`${R5}
export default class M extends Plugin { onload() { ${T}
  const g = this.app?.workspace?.constructor?.prototype;
  const offs = [around(h, { render: ${W} }), around(g, { onLayoutReady: ${W} })];
  this.register(() => { for (const off of offs) off(); }); } }`, 'two holders, array form');

  // The unsafe one: a one-argument helper silently drops everything after the first.
  const dropped = r5Catch(`${R5}
function safe(fn) { return () => { try { fn(); } catch (e) { console.error(e); } }; }
export default class M extends Plugin { onload() { ${T}
  this.register(safe(around(h, { render: ${W} }), around(h, { refresh: ${W} }))); } }`, 'a dropped uninstaller');
  assert.equal(countOf(dropped, 'patch-must-be-registered'), 1, show(dropped));

  // And the near-miss the relaxation must not swallow: a loop written wrong reclaims one of two.
  const partial = r5Catch(`${R5}
export default class M extends Plugin { onload() { ${T}
  const offs = [around(h, { render: ${W} }), around(h, { refresh: ${W} })];
  this.register(() => offs[0]()); } }`, 'only the first uninstaller called');
  assert.equal(countOf(partial, 'patch-must-be-registered'), 1, show(partial));
});

test('R6-6: a destructive teardown on a HOST receiver is the damage, not the reclaim', () => {
  // `empty` is in TEARDOWN_CALLS, so wiping Obsidian's sidebar read as a *reclaim*.
  const src = `${R5}
export default class M extends Plugin { onload() {
  this.app.workspace.leftSplit.containerEl.empty();
  const el = this.app.workspace.containerEl;
  el.addClass("mine"); } }`;
  assert.ok(r5Rules(src).includes('must-be-reclaimed'), 'the host class must still owe a reclaim');
  assert.deepEqual(effectKinds(src), ['host-dom-destruction']);

  // The un-doing half of the vocabulary is untouched: this is the form the message itself asks for.
  r5Clean(`${R5}
export default class M extends Plugin { onload() {
  const el = activeDocument.querySelector(".inline-title");
  el.addClass("modkit-dim");
  this.register(() => el.removeClass("modkit-dim")); } }`, 'an inverse mutation on a host element');
});

test('R6-7: two false rejections that steered the correction loop', () => {
  // vault.append is a FILE api; `append` is also in INSERT_METHODS, and the DOM rule fired on it.
  r5Clean(`${R5}
export default class M extends Plugin { async onload() {
  const f = this.app.vault.getAbstractFileByPath("Done.md");
  if (f) await this.app.vault.append(f, "- done"); } }`, 'vault.append');

  // The same object under two names: reclaimed through the field, appended through the local.
  for (const [label, teardown] of [
    ['register + a helper method', 'onload2() {} '],
    ['onunload', ''],
  ]) {
    void label;
    void teardown;
  }
  // A <div>, not a <style> element: `inject-stylesheet` (added for L1) now flags a style element
  // built this way on any plane, reclaimed or not, so it would confound what this fixture actually
  // tests — that reclaim-tracking follows a renamed field through a bound method and through
  // onunload. See validate.test.mjs's inject-stylesheet suite for the style-element case.
  r5Clean(`${R5}
export default class M extends Plugin {
  onload() {
    const box = activeDocument.createElement("div");
    activeDocument.body.appendChild(box);
    this.boxEl = box;
    this.register(this.cleanup.bind(this));
  }
  cleanup() { this.boxEl?.remove(); } }`, 'reclaim through a renamed field, via register');

  r5Clean(`${R5}
export default class M extends Plugin {
  onload() {
    const box = activeDocument.createElement("div");
    activeDocument.body.appendChild(box);
    this.boxEl = box;
  }
  onunload() { this.boxEl?.remove(); } }`, 'reclaim through a renamed field, via onunload');
});

test('R6-8: a prototype holder returned by a helper hid patchesPrototype', () => {
  // With `holder` laundered through `protoOf()`, `requireApiVersion` alone satisfied the gate on a
  // THIRD-PARTY view class, and the bound-method pre-flight was never required at all.
  const found = r5Rules(`import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
function protoOf(x) { return x.constructor.prototype; }
export default class M extends Plugin {
  modkitProbe() { return true; }
  onload() {
    if (!requireApiVersion("1.7.2")) return;
    const leaf = this.app.workspace.getMostRecentLeaf();
    const holder = protoOf(leaf.view);
    const d = Object.getOwnPropertyDescriptor(holder, "onOpen");
    if (d && (d.get || d.set)) return;
    this.register(around(holder, { onOpen: (n) => function () { const r = n.call(this); return r; } }));
  }
}`, true);
  assert.ok(found.includes('missing-version-gate'), found.join(','));
  assert.ok(found.includes('bound-method-target'), found.join(','));
});

test('R6-9: a mod that provably does nothing', () => {
  const shell = (body) => `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";
export default class M extends Plugin {
  async modkitProbe() { const t = this.app?.plugins?.plugins?.["tasks"]; return typeof t?.render === "function"; }
  async onload() {
    if (!requireApiVersion("1.7.2")) return;
    const t = this.app?.plugins?.plugins?.["tasks"]; if (!t) return;
    const v = this.app?.plugins?.manifests?.["tasks"]?.version; if (!v) return;
    if (Number(String(v).split(".")[0]) < 7) return;
    const holder = t.constructor?.prototype; if (!holder) return;
    const d = Object.getOwnPropertyDescriptor(holder, "render");
    if (!d || d.get || d.set) return;
    if (Object.prototype.hasOwnProperty.call(t, "render")) return;
${body}
  }
}`;

  // A pure pass-through wrapper: a WARNING, because the artifact still ships and only a run can
  // settle whether a mod had an effect. What is decidable is that this one cannot have had one.
  const noop = validate(shell('    this.register(around(holder, { render: (n) => function (...a) { return n.apply(this, a); } }));'), {
    requireTemplateContract: true,
  });
  assert.deepEqual(rules(noop), ['no-op-patch'], show(noop));
  assert.deepEqual(noop.map((f) => f.severity), ['warning'], 'a no-op wrapper must not block the artifact');

  // A patch behind a statically false flag: an ERROR, because it is certain.
  const dead = validate(
    shell('    const ENABLED = false;\n    if (ENABLED) { this.register(around(holder, { render: (n) => function (...a) { this.t = 1; return n.apply(this, a); } })); }'),
    { requireTemplateContract: true },
  );
  assert.ok(rules(dead).includes('unreachable-install'), show(dead));

  // The four REAL wrapper shapes must stay silent — these are the mods the product exists to make,
  // and a warning on them steers the one correction turn away from useful work.
  for (const [label, wrapper] of [
    ['rewrites an argument', '(n) => function (opts, ...rest) { return n.call(this, { ...opts, compact: true }, ...rest); }'],
    ['rewrites the return', '(n) => function (...a) { const r = n.apply(this, a); return String(r); }'],
    ['counts on the plugin', '(n) => function (...a) { self.calls += 1; return n.apply(this, a); }'],
    ['suppresses conditionally', '(n) => function (...a) { if (self.quiet) return undefined; return n.apply(this, a); }'],
  ]) {
    const src = shell(`    const self = this; self.calls = 0; self.quiet = false;
    this.register(around(holder, { render: ${wrapper} }));`);
    assert.deepEqual(validate(src, { requireTemplateContract: true }), [], `a real wrapper that ${label}`);
  }
});

test('R6-10: THE EFFECTS AXIS — declared, not banned, and never blocking', () => {
  const vaultRewrite = `${R5}
export default class M extends Plugin { async onload() {
  const files = this.app.vault.getMarkdownFiles();
  for (const file of files) {
    const text = await this.app.vault.read(file);
    await this.app.vault.modify(file, text.replace(/a/g, "b"));
  } } }`;

  // The whole point: this validates CLEAN as code, and is declared as an effect.
  const report = validateSource(vaultRewrite, { requireTemplateContract: false });
  assert.deepEqual(report.findings, [], show(report.findings));
  assert.equal(report.ok, true, 'an effect must never block the artifact');
  assert.equal(report.effects.length, 1, JSON.stringify(report.effects));

  const [effect] = report.effects;
  assert.equal(effect.severity, 'declaration');
  assert.notEqual(effect.severity, 'error');
  assert.equal(effect.kind, 'vault-write');
  assert.equal(effect.reversedOnUnload, false);
  assert.equal(effect.subject, 'this.app.vault');
  assert.equal(typeof effect.summary, 'string');
  assert.equal(typeof effect.line, 'number');
  assert.equal(effect.file, 'main.js');

  // One kind per shape, over the mods that all validated at zero findings in round 5.
  const cases = [
    ['trash a file', 'await this.app.fileManager.trashFile(f);', 'vault-write'],
    ['adapter write', 'await this.app.vault.adapter.write("x.md", "y");', 'vault-write'],
    ['rename', 'await this.app.fileManager.renameFile(f, "b.md");', 'vault-write'],
    ['editor', 'const editor = this.app.workspace.activeEditor.editor; editor.setValue("x");', 'editor-write'],
    ['target settings', 'const t = this.app?.plugins?.plugins?.["tasks"]; await t.saveSettings();', 'target-plugin-settings'],
    ['target lifecycle', 'const t = this.app?.plugins?.plugins?.["tasks"]; await t.onload();', 'target-plugin-lifecycle'],
    ['disable a plugin', 'await this.app?.plugins?.disablePlugin?.("dataview");', 'plugin-enablement'],
    ['host config', 'this.app.vault.setConfig("livePreview", false);', 'host-config-write'],
    ['dom destruction', 'this.app.workspace.leftSplit.containerEl.empty();', 'host-dom-destruction'],
  ];
  for (const [label, body, kind] of cases) {
    const kinds = effectKinds(`${R5}
export default class M extends Plugin { async onload() { const f = this.app.vault.getFiles()[0]; ${body} } }`);
    assert.ok(kinds.includes(kind), `${label} must declare ${kind}, got [${kinds.join(',')}]`);
  }

  // Network egress, with the endpoint named — that is the line the review gate leads with.
  const net = effectsOf(`import { Plugin, requestUrl } from "obsidian";
export default class M extends Plugin { async onload() {
  await requestUrl({ url: "https://x.example/ingest", method: "POST", body: "{}" }); } }`);
  assert.equal(net.length, 1);
  assert.equal(net[0].kind, 'network-egress');
  assert.equal(net[0].subject, 'https://x.example/ingest');
  assert.ok(net[0].summary.includes('https://x.example/ingest'), net[0].summary);

  // A correct mod declares NOTHING. A list that fires on everything is a list nobody reads.
  assert.deepEqual(
    effectsOf(`${R5}
export default class M extends Plugin { onload() {
  const style = activeDocument.createElement("style");
  style.textContent = ".x { display: none; }";
  activeDocument.head.appendChild(style);
  this.register(() => style.remove()); } }`),
    [],
    'the canonical correct mod must declare no effects',
  );
});

test('R6-11: ACCEPTANCE — adversary 2\'s end-to-end mod, which shipped at zero findings', () => {
  // A complete, boring-looking, fully contract-conformant mod: Obsidian gate, target-version gate,
  // accessor pre-flight, own-property pre-flight, a real probe, health reporting, and a correctly
  // registered around(). It validated at ZERO findings and left Tasks' showNotice() permanently
  // stubbed, a class permanently on the workspace container, and a workspace listener permanently
  // subscribed. Every host reach goes through a #private method.
  const source = `import { Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

const MOD_ID = "modkit-quieter-tasks";

export default class QuieterTasks extends Plugin {
  #target() { return this.app?.plugins?.plugins?.["obsidian-tasks-plugin"]; }
  #holder() { return this.#target()?.constructor?.prototype; }
  #shell() { return this.app?.workspace?.containerEl; }
  #events() { return this.app?.workspace; }

  async modkitProbe() {
    const holder = this.#holder();
    return typeof holder?.renderTaskLine === "function";
  }

  modkitStatus() { return { modId: MOD_ID, state: this.armed === true ? "applied" : "target-gone", detail: "" }; }

  modkitPublish() {
    try {
      const host = this.app?.plugins?.plugins?.["modkit"];
      host?.modkitReportHealth?.(MOD_ID, this.modkitStatus());
    } catch { /* health reporting must never break a mod */ }
  }

  async onload() {
    this.armed = false;
    if (!requireApiVersion("1.7.2")) return;
    const version = this.app?.plugins?.manifests?.["obsidian-tasks-plugin"]?.version;
    if (version === undefined || version === null) return;
    if (Number(String(version).split(".")[0]) < 7) return;
    const holder = this.#holder();
    if (!holder) return;
    const desc = Object.getOwnPropertyDescriptor(holder, "renderTaskLine");
    if (!desc || desc.get || desc.set) return;
    const live = this.#target();
    if (live && Object.prototype.hasOwnProperty.call(live, "renderTaskLine")) return;

    const self = this;
    self.calls = 0;
    this.register(
      around(holder, {
        renderTaskLine: (next) =>
          function (...args) {
            self.calls += 1;
            return next.apply(this, args);
          },
      }),
    );

    this.#holder().showNotice = function () { return undefined; };
    this.#shell().addClass("quieter-tasks-active");
    this.#events().on("file-open", () => { self.calls = 0; });

    this.armed = true;
    this.modkitPublish();
  }
}
`;
  const findings = validate(source, { requireTemplateContract: true });
  const errs = findings.filter((f) => f.severity === 'error');
  assert.ok(errs.length >= 3, `the acceptance mod must be blocked, got:\n${show(findings)}`);
  for (const [rule, damage] of [
    ['no-host-assignment', "Tasks' showNotice() is permanently stubbed"],
    ['must-be-reclaimed', 'a class is left on the workspace container forever'],
    ['event-must-be-registered', 'a workspace listener fires against a dead mod forever'],
  ]) {
    assert.ok(rules(errs).includes(rule), `${damage} — expected ${rule}, got ${rules(errs).join(',')}`);
  }
  // The mod's own registered patch is correct and must NOT be among the complaints.
  assert.ok(!rules(errs).includes('patch-must-be-registered'), show(errs));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Round 6b — the verification pass, and the two holes it found
 *
 * Both are the same shape as the round-5 finding one layer down: a rule that reads a NAME, and a
 * spelling that puts the name somewhere the rule does not look.
 *
 *   1. `el.addEventListener.call(el, …)` — the INLINE `.call`. The two-step form (`const add =
 *      el.addEventListener; add.call(el, …)`) was already caught, because the method's name sits on
 *      `add`'s binding. Written inline the name is one hop into the callee, `calleeNameAt` returned
 *      the literal `"call"`, and a permanent listener on a host element validated at zero findings.
 *      `el.addClass.call(el, "x")` did the same to `must-be-reclaimed`.
 *   2. `img.src = "https://…"` — egress with no network API at all. `requestUrl()`, the sanctioned
 *      door, DECLARES `network-egress`; an `<img>` the mod created, assigned a remote `src`, sent
 *      the identical GET and declared nothing. So did `new Image().src`, a `<link rel=prefetch>`
 *      whose removal was even registered, and an owned `<style>` carrying `url(https://…)`.
 * ──────────────────────────────────────────────────────────────────────────── */

const R6B_HOST_EL = '    const el = this.app.workspace.containerEl;\n';

test('R6b-1: the inline .call spelling of a raw listener is the raw listener', () => {
  const direct = r5Rules(`${R5}
export default class M extends Plugin { onload() {\n${R6B_HOST_EL}    el.addEventListener("click", () => {});\n} }`);
  const inline = r5Rules(`${R5}
export default class M extends Plugin { onload() {\n${R6B_HOST_EL}    el.addEventListener.call(el, "click", () => {});\n} }`);
  const detached = r5Rules(`${R5}
export default class M extends Plugin { onload() {\n${R6B_HOST_EL}    const add = el.addEventListener;\n    add.call(el, "click", () => {});\n} }`);
  assert.ok(direct.includes('no-raw-listener'), direct.join(','));
  assert.ok(inline.includes('no-raw-listener'), `the inline .call form escaped: ${inline.join(',')}`);
  assert.ok(detached.includes('no-raw-listener'), detached.join(','));
});

test('R6b-2: .call and .apply do not launder a host-element mutation past must-be-reclaimed', () => {
  for (const spelling of ['el.addClass.call(el, "x")', 'el.addClass.apply(el, ["x"])', 'el.setAttribute.call(el, "data-x", "1")']) {
    const found = r5Rules(`${R5}
export default class M extends Plugin { onload() {\n${R6B_HOST_EL}    ${spelling};\n} }`);
    assert.ok(found.includes('must-be-reclaimed'), `${spelling} escaped: ${found.join(',')}`);
  }
});

test('R6b-3: an owned element is still owned — the fix must not reject the correct mod', () => {
  // `.call` on something the MOD made is not a host mutation, and `this.register(this.cleanup.bind
  // (this))` is the documented reclaim spelling. Neither may become a finding.
  r5Clean(`${R5}
export default class M extends Plugin {
  onload() {
    const own = activeDocument.createElement("div");
    own.addClass.call(own, "modkit-x");
    this.register(this.cleanup.bind(this));
  }
  cleanup() {}
}`, 'owned .call and a bound reclaim');
});

test('R6b-4: a remote URL handed to a DOM loader is egress, and is declared', () => {
  const sinks = [
    'const img = activeDocument.createElement("img"); img.src = "https://c.example.com/p?v=" + MOD_ID;',
    'const img = new Image(); img.src = "https://c.example.com/p";',
    'const l = activeDocument.createElement("link"); l.setAttribute("href", "https://c.example.com/p");',
    'const s = activeDocument.createElement("style"); s.textContent = ".x{background:url(https://c.example.com/p)}";',
  ];
  for (const sink of sinks) {
    const kinds = effectKinds(`${R5}
const MOD_ID = "m";
export default class M extends Plugin { onload() { ${sink} } }`);
    assert.deepEqual(kinds, ['network-egress'], `${sink}\n  declared: ${kinds.join(',')}`);
  }
});

test('R6b-5: the declaration fires on a remote scheme, not on the word "url"', () => {
  // A local resource path, a docs link that is never loaded, and ordinary CSS must all stay silent —
  // a review screen people learn to skim is the failure mode this whole axis is trying to avoid.
  for (const quiet of [
    'const img = activeDocument.createElement("img"); img.src = this.app.vault.getResourcePath(null);',
    'const s = activeDocument.createElement("style"); s.textContent = ".x{display:none}";',
    'const d = activeDocument.createElement("div"); d.setAttribute("data-modkit", "1");',
    'new Notice("docs at https://docs.example.com");',
  ]) {
    const kinds = effectKinds(`${R5}
export default class M extends Plugin { onload() { ${quiet} } }`);
    assert.deepEqual(kinds, [], `${quiet}\n  declared: ${kinds.join(',')}`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * L1 · `inject-stylesheet` and `css-mod-without-stylesheet`
 *
 * PLAN.md's "Where this actually is": every generated plane-E mod so far did
 * `activeDocument.head.appendChild(style)` in `onload()`, which lands in whichever *window* happens
 * to be `activeDocument` — Settings, if the mod was (re)installed with Settings focused — instead of
 * the workspace the user is looking at. `stylesCss` is the fix: Obsidian applies it to every window
 * itself. These two rules are the validator half; prompt.ts's `REACH_AND_REFUSAL` and
 * `CSS_MODE_EXAMPLE` are the other half.
 * ──────────────────────────────────────────────────────────────────────────── */

test('inject-stylesheet: the exact 2026-09-02 shape, on plane E, is an error naming stylesCss', () => {
  // The literal pattern measured in the real generated mod: create, set text, append — three
  // separate statements, so the rule has to connect the appendChild back to the identifier.
  const source = `${R5}
export default class M extends Plugin {
  async onload() {
    const style = activeDocument.createElement("style");
    style.textContent = ".workspace-tab-header-inner-icon { display: none; }";
    activeDocument.head.appendChild(style);
  }
  async modkitProbe() { return true; }
}`;
  const findings = validate(source, { reachPlane: 'E' });
  const hits = findings.filter((f) => f.rule === 'inject-stylesheet');
  assert.ok(hits.length >= 1, `expected inject-stylesheet, got:\n${show(findings)}`);
  for (const hit of hits) {
    assert.equal(hit.severity, 'error', show(findings));
    assert.match(hit.message, /stylesCss/, 'the message must name stylesCss as the way');
  }
});

test('inject-stylesheet: every shape named in the rule, each on its own', () => {
  const cases = [
    ['createEl("style", …)', 'activeDocument.head.createEl("style", { text: ".x{color:red}" });'],
    ['document.createElement("style") + appendChild', 'const s = document.createElement("style"); activeDocument.head.appendChild(s);'],
    ['createElementNS(…, "style")', 'const s = activeDocument.createElementNS("http://www.w3.org/1999/xhtml", "style"); activeDocument.head.appendChild(s);'],
    ['.style.cssText =', 'this.app.workspace.containerEl.style.cssText = ".x{color:red}";'],
    ['insertAdjacentHTML with <style', 'activeDocument.head.insertAdjacentHTML("beforeend", "<style>.x{color:red}</style>");'],
    ['a template literal containing <style', 'const html = `<style>.x{color:red}</style>`; void html;'],
    ['new CSSStyleSheet()', 'const sheet = new CSSStyleSheet(); void sheet;'],
    ['adoptedStyleSheets', 'const sheets = activeDocument.adoptedStyleSheets; void sheets;'],
  ];
  for (const [label, line] of cases) {
    const source = `${R5}
export default class M extends Plugin {
  async onload() {
    ${line}
  }
  async modkitProbe() { return true; }
}`;
    const findings = validate(source, { reachPlane: 'E' });
    assert.ok(
      findings.some((f) => f.rule === 'inject-stylesheet' && f.severity === 'error'),
      `${label}: expected inject-stylesheet (error), got:\n${show(findings)}`,
    );
  }
});

test('inject-stylesheet: a const-bound or concatenated "style" tag name does not evade the rule', () => {
  // The same two-token evasion `staticStringValue`'s own doc comment describes for
  // `activeDocument[m]("click", …)` (see F7/F10 above), aimed at this rule's tag-name check instead
  // of a listener name: a bare `tag.type === 'Literal'` test misses both of these.
  const cases = [
    ['createElement(TAG) behind a const', 'const TAG = "style"; const s = activeDocument.createElement(TAG); activeDocument.head.appendChild(s);'],
    ['createElement("sty" + "le") concatenated', 'const s = activeDocument.createElement("sty" + "le"); activeDocument.head.appendChild(s);'],
  ];
  for (const [label, line] of cases) {
    const source = `${R5}
export default class M extends Plugin {
  async onload() {
    ${line}
  }
  async modkitProbe() { return true; }
}`;
    const findings = validate(source, { reachPlane: 'E' });
    assert.ok(
      findings.some((f) => f.rule === 'inject-stylesheet' && f.severity === 'error'),
      `${label}: expected inject-stylesheet (error), got:\n${show(findings)}`,
    );
  }
});

test('inject-stylesheet: el.setAttribute("style", …) — the inline-style path .style.foo does not close', () => {
  // .style.display = "none" is already blocked by no-host-assignment; setAttribute("style", …)
  // reaches the same inline "style" attribute without ever touching a `.style` MemberExpression, so
  // it was the one natural way left to style an element from onload() without building a <style>
  // element at all.
  const source = `${R5}
export default class M extends Plugin {
  async onload() {
    const el = activeDocument.querySelector(".workspace-tab-header-inner-icon");
    el.setAttribute("style", "display:none");
    this.register(() => el.removeAttribute("style"));
  }
  async modkitProbe() { return true; }
}`;
  const findings = validate(source, { reachPlane: 'E' });
  const hit = findings.find((f) => f.rule === 'inject-stylesheet');
  assert.ok(hit, `expected inject-stylesheet, got:\n${show(findings)}`);
  assert.equal(hit.severity, 'error');
  assert.match(hit.message, /stylesCss/);
});

test('inject-stylesheet: the same shape on a non-E plane is a warning, not a rejection', () => {
  // Reclaimed, so `must-be-reclaimed` (always an error) does not also fire — this fixture isolates
  // `inject-stylesheet` on its own, to show its severity is the thing that changes with plane.
  const source = `${R5}
export default class M extends Plugin {
  async onload() {
    const style = activeDocument.createElement("style");
    activeDocument.head.appendChild(style);
    this.register(() => style.remove());
  }
  async modkitProbe() { return true; }
}`;
  const findings = validate(source, { reachPlane: 'C' });
  const hit = findings.find((f) => f.rule === 'inject-stylesheet');
  assert.ok(hit, `expected inject-stylesheet, got:\n${show(findings)}`);
  assert.equal(hit.severity, 'warning');
  // A warning never blocks: `ok` only turns on an error.
  assert.equal(validateSource(source, { reachPlane: 'C' }).ok, true, show(validateSource(source, { reachPlane: 'C' }).findings));

  // No plane at all (a bare `validate()` call, as a test or a dev-introspection request makes) reads
  // the same as "not plane E" — the permissive default.
  assert.equal(validate(source).find((f) => f.rule === 'inject-stylesheet').severity, 'warning');
});

test('CSS_MODE_EXAMPLE validates with zero findings on plane E', () => {
  // The example the model is shown for a css-mode mod — the shape prompt.ts asks for instead of the
  // canonical (plane-C) template. If this goes red, the example itself would be rejected.
  assert.deepEqual(validate(CSS_MODE_EXAMPLE, { reachPlane: 'E' }), []);
});

test('css-mod-without-stylesheet: an empty or whitespace stylesCss on a css-mode plane-E mod is an error', () => {
  for (const empty of [undefined, '', '   \n\t  ']) {
    const findings = checkCssModeStylesheet('E', 'css', empty);
    assert.equal(findings.length, 1, `stylesCss=${JSON.stringify(empty)}: ${show(findings)}`);
    assert.equal(findings[0].rule, 'css-mod-without-stylesheet');
    assert.equal(findings[0].severity, 'error');
  }
});

test('css-mod-without-stylesheet: exempt whenever the mod is not a css-mode plane-E mod', () => {
  assert.deepEqual(checkCssModeStylesheet('E', 'css', '.x { color: red; }'), [], 'a real stylesheet passes');
  assert.deepEqual(checkCssModeStylesheet('E', 'dom', ''), [], 'dom-mode plane E styles nothing by definition');
  assert.deepEqual(checkCssModeStylesheet('C', 'css', ''), [], 'not plane E at all');
  assert.deepEqual(checkCssModeStylesheet('A', undefined, undefined), [], 'a plane with no reachMode concept');
});

test('buildCorrectionPrompt: a css-mod-without-stylesheet finding echoes the rejected stylesCss', () => {
  // The finding is located at styles.css, and the only fix is a non-empty stylesCss — but
  // buildCorrectionPrompt only ever showed the rejected `source`. A model that reads "return the
  // complete corrected source" literally could fix every source-side finding, re-omit stylesCss
  // (nothing here reminded it the field exists), and get rejected again identically.
  const findings = checkCssModeStylesheet('E', 'css', '');
  assert.equal(findings.length, 1, show(findings));

  const withoutStyles = buildCorrectionPrompt(
    { request: 'hide the icon', target: { kind: 'plugin', pluginId: 'x', version: '1.0.0' }, modId: 'm', modVersion: '0.0.1', minAppVersion: '1.7.2' },
    CSS_MODE_EXAMPLE,
    findings,
  );
  assert.doesNotMatch(withoutStyles.prompt, /You also produced this `stylesCss`/, 'no 4th arg: no styles block at all');

  const withStyles = buildCorrectionPrompt(
    { request: 'hide the icon', target: { kind: 'plugin', pluginId: 'x', version: '1.0.0' }, modId: 'm', modVersion: '0.0.1', minAppVersion: '1.7.2' },
    CSS_MODE_EXAMPLE,
    findings,
    '',
  );
  assert.match(withStyles.prompt, /You also produced this `stylesCss`/);
  assert.match(withStyles.prompt, /\(empty\)/, 'the empty stylesCss must be shown as empty, not silently dropped');
  assert.match(withStyles.prompt, /fixed by returning a corrected, non-empty `stylesCss` — not by editing `source`/);

  const nonEmptyStyles = buildCorrectionPrompt(
    { request: 'hide the icon', target: { kind: 'plugin', pluginId: 'x', version: '1.0.0' }, modId: 'm', modVersion: '0.0.1', minAppVersion: '1.7.2' },
    CSS_MODE_EXAMPLE,
    findings,
    '.tasks { color: red; }',
  );
  assert.match(nonEmptyStyles.prompt, /```css\n\.tasks \{ color: red; \}\n```/, 'a real rejected stylesheet is echoed verbatim');
});

test.after(async () => {
  await stopBuilder();
});
