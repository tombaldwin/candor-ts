// The environment-access lint (env-lint.mjs) and its calibration. A lint that has never been shown to fail is not a gate:
// every spelling below is SEEDED and must be found, the clean controls must pass, and a real shipped file with one raw
// read appended must go red. Then the tree itself must be clean. (SPEC §3.4 ⟨0.42⟩, SOUNDNESS R1634.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findEnvAccess, lintTree, shippedFiles, ENV_MODULE } from "./env-lint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEEDS = {
  "dot": `const a = process.env.CANDOR_X;`,
  "optional": `const a = process?.env?.CANDOR_X;`,
  "bracket literal": `const a = process["env"].CANDOR_X;`,
  "dynamic name": `const k = "CANDOR_" + n; const a = process.env[k];`,
  "enumeration": `const ks = Object.keys(process.env);`,
  "spread": `const e = { ...process.env, A: "1" };`,
  "in operator": `const has = "X" in process.env;`,
  "globalThis": `const a = globalThis.process.env.X;`,
  "global": `const a = global.process.env.X;`,
  "cast": `const a = (process as any).env.X;`.replace(" as any", ""),   // plain parens; no TS syntax in .mjs
  "alias": `const p = process; const a = p.env.X;`,
  "alias before use": `function f() { return q.env.X; } const q = process;`,
  "destructure": `const { env } = process; const a = env.X;`,
  "destructure rest": `const { argv, ...rest } = process;`,
  "named import": `import { env } from "node:process"; const a = env.X;`,
  "default import": `import proc from "node:process"; const a = proc.env.X;`,
  "namespace import": `import * as proc from "node:process"; const a = proc.env.X;`,
  "require": `const a = require("node:process").env.X;`,
  "computed member": `const a = process[which];`,
  "escape": `register(process);`,
  "return": `function f() { return process; }`,
};

for (const [name, src] of Object.entries(SEEDS)) {
  test(`env-lint FAILS on a seeded read: ${name}`, () => {
    assert.ok(findEnvAccess(src, "seed.mjs").length > 0, `not detected: ${src}`);
  });
}

const CLEAN = {
  "argv": `const a = process.argv.slice(2);`,
  "exit": `process.exitCode = 2; process.on("exit", () => {});`,
  "stderr": `process.stderr.write("x");`,
  "versions": `const v = process.versions.node + process.pid + process.cwd();`,
  "typeof": `if (typeof process !== "undefined") {}`,
  "prose in comment": `// reads process.env.CANDOR_X\n/* process.env */ const a = 1;`,
  "prose in string": "const a = 'process.env.X'; const b = `${1} process.env`;",
  "unrelated env property": `const o = { env: {} }; const a = o.env.X; const e = { env: childEnv() };`,
  "shadowed local named env": `function f(env) { return env.X; }`,
};
for (const [name, src] of Object.entries(CLEAN)) {
  test(`env-lint passes a clean control: ${name}`, () => {
    assert.deepEqual(findEnvAccess(src, "clean.mjs"), []);
  });
}

test("env-lint FAILS on a real shipped file with ONE raw read appended (seeded into the real tree)", () => {
  const file = "scan-core.mjs";
  const text = fs.readFileSync(path.join(HERE, file), "utf8");
  assert.deepEqual(findEnvAccess(text, file), [], "the unmodified file must be clean first, or this seed proves nothing");
  const seeded = text + "\nexport const __seeded = process.env.CANDOR_SEEDED_RAW_READ;\n";
  const hits = findEnvAccess(seeded, file);
  assert.equal(hits.length, 1);
  assert.equal(seeded.split("\n")[hits[0].line - 1].includes("CANDOR_SEEDED_RAW_READ"), true, "reported at the seeded line");
});

test("env-lint scope: every shipped root .mjs is linted, and env.mjs is the one exempt module", () => {
  const files = shippedFiles();
  for (const f of ["scan.mjs", "query.mjs", "gate-core.mjs", "policy.mjs", "mcp.mjs", "lsp.mjs", "verify.mjs", "verify-preload.mjs"])
    assert.ok(files.includes(f), `${f} is not linted`);
  assert.ok(!files.includes(ENV_MODULE));
  // the module really is where reads live — a lint over a tree whose only reader were exempt AND empty would be vacuous
  assert.ok(findEnvAccess(fs.readFileSync(path.join(HERE, ENV_MODULE), "utf8"), ENV_MODULE).length > 0);
});

test("the tree has no environment access outside env.mjs", () => {
  assert.deepEqual(lintTree().map((b) => `${b.file}:${b.line} ${b.why}`), []);
});
