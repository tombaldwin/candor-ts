#!/usr/bin/env node
/**
 * Soundness fuzzer for candor-ts — the family harness ported (candor-rust soundness/, candor-java
 * soundness/, candor-agents fuzz.py). Generates compilable TS projects that thread a KNOWN effect
 * from a sink up through a chain of call forms — the forms that could hide an edge in TS: direct
 * calls, arrow-consts, method calls, cross-FILE imports, closures, a callback parameter (which must
 * read Unknown), an `any`-typed callee (likewise). Every chain function transitively reaches the
 * effect, so each must be reported with the effect OR Unknown — a chain function reported pure (or
 * omitted) is a SILENT UNDER-REPORT, the bug class this exists to catch. The precision twin: a pure
 * bystander must stay OUT of the report.
 *
 * Run: node fuzz.mjs [N]   (default 25 seeds)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// deterministic seeded RNG (mulberry32) — same-seed reproducibility, like the Rust gen.py
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const SINKS = {
  fs:   { import: `import * as fsm from "node:fs";`, stmt: `fsm.readFileSync("/tmp/x");`, eff: "Fs" },
  net:  { import: `import * as netm from "node:net";`, stmt: `netm.connect(9, "127.0.0.1");`, eff: "Net" },
  exec: { import: `import * as cp from "node:child_process";`, stmt: `try { cp.execSync("true"); } catch {}`, eff: "Exec" },
  env:  { import: ``, stmt: `void process.env.CANDOR_FUZZ;`, eff: "Env" },
};
// Edge forms: how fn i reaches fn i+1 (or the sink). `unknown: true` forms must read Unknown
// instead of (or in addition to) the effect.
const FORMS = ["direct", "arrow_const", "method", "closure", "callback_recv", "any_call"];

function genProject(seed) {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 5); // chain length 2..6
  const sink = pick(r, Object.keys(SINKS));
  const multiFile = r() < 0.5;
  const forms = [];
  const decls = [];   // per-fn source (in one file) or per-file sources
  const files = {};
  const expectUnknown = new Set(); // fns whose form makes Unknown the required marker

  const callExpr = (callee) => `${callee}()`;
  // fn names f00..f(n-1), sink fn "sink"
  const fnName = (i) => (i < n ? `f${String(i).padStart(2, "0")}` : "sink");

  const bodies = [];
  bodies[n] = `export function sink(): void { ${SINKS[sink].stmt} }`;
  for (let i = n - 1; i >= 0; i--) {
    const callee = fnName(i + 1);
    const me = fnName(i);
    const form = pick(r, FORMS);
    forms[i] = form;
    switch (form) {
      case "direct":
        bodies[i] = `export function ${me}(): void { ${callExpr(callee)}; }`;
        break;
      case "arrow_const":
        bodies[i] = `export const ${me} = (): void => { ${callExpr(callee)}; };`;
        break;
      case "method":
        // a class method in the chain; the next caller still calls `me` via a tiny forwarder const
        bodies[i] = `class K${i} { run(): void { ${callExpr(callee)}; } }\n` +
                    `export const ${me} = (): void => { new K${i}().run(); };`;
        break;
      case "closure":
        bodies[i] = `export function ${me}(): void { const c = () => { ${callExpr(callee)}; }; c(); }`;
        break;
      case "callback_recv":
        // the effect reaches `me` ONLY through a callback parameter it invokes → Unknown required
        bodies[i] = `function recv${i}(cb: () => void): void { cb(); }\n` +
                    `export function ${me}(): void { recv${i}(() => { ${callExpr(callee)}; }); }`;
        expectUnknown.add(`recv${i}`);
        break;
      case "any_call":
        // the callee laundered through `any` → unresolvable → Unknown required for `me`;
        // ALSO keep a real edge so the chain's effect still flows (the Unknown is in addition).
        bodies[i] = `export function ${me}(): void { const a: any = ${callee}; a(); ${callExpr(callee)}; }`;
        expectUnknown.add(me);
        break;
    }
  }
  const bystander = `export function zzBystander(n: number): number { return n * 2; }`;

  if (multiFile) {
    // one module per chain fn, importing the next — cross-file edges under test
    for (let i = 0; i <= n; i++) {
      const me = fnName(i);
      const imp = i < n ? `import { ${fnName(i + 1)} } from "./${fnName(i + 1)}.js";\n` : "";
      const sinkImp = i === n ? SINKS[sink].import + "\n" : "";
      files[`src/${me}.ts`] = sinkImp + imp + bodies[i] + "\n";
    }
    files["src/zz.ts"] = bystander + "\n";
  } else {
    files["src/all.ts"] = SINKS[sink].import + "\n" + bodies.slice().reverse().join("\n") + "\n" + bystander + "\n";
  }
  return { files, n, sink, forms, expectUnknown, multiFile };
}

function runSeed(seed) {
  const { files, n, sink, forms, expectUnknown, multiFile } = genProject(seed);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-fuzz-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const res = spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8" });
  const bad = [];
  const rp = path.join(d, ".candor", "report.json");
  if (!fs.existsSync(rp)) return [`seed ${seed}: scan produced no report: ${res.stderr?.slice(0, 200)}`];
  const report = JSON.parse(fs.readFileSync(rp, "utf8"));
  const by = new Map(report.functions.map((e) => [e.fn.split(".").pop(), e]));
  const eff = SINKS[sink].eff;
  // SOUNDNESS: every chain fn must read effect-or-Unknown — pure/omitted is the bug.
  for (let i = 0; i <= n; i++) {
    const me = i === n ? "sink" : `f${String(i).padStart(2, "0")}`;
    const e = by.get(me);
    if (!e) bad.push(`seed ${seed}: ${me} OMITTED (silent pure; sink=${sink}, form=${forms[i] ?? "-"}, multi=${multiFile})`);
    else if (!e.inferred.includes(eff) && !e.inferred.includes("Unknown"))
      bad.push(`seed ${seed}: ${me} lacks ${eff}/Unknown: ${e.inferred} (form=${forms[i] ?? "-"})`);
  }
  // the Unknown-required forms must actually carry the marker
  for (const me of expectUnknown) {
    const e = by.get(me);
    if (!e || !e.inferred.includes("Unknown"))
      bad.push(`seed ${seed}: ${me} should read Unknown (callback/any form): ${e ? e.inferred : "OMITTED"}`);
  }
  // PRECISION twin: the pure bystander stays out of the report.
  if (by.has("zzBystander")) bad.push(`seed ${seed}: bystander leaked: ${by.get("zzBystander").inferred}`);
  fs.rmSync(d, { recursive: true, force: true });
  return bad;
}

const N = Number(process.argv[2] ?? 25);
let fails = [];
for (let seed = 1; seed <= N; seed++) fails = fails.concat(runSeed(seed));
for (const b of fails) console.log(`  ${b}`);
const failedSeeds = new Set(fails.map((f) => f.split(":")[0]));
console.log(`fuzz: ${N - failedSeeds.size} seeds passed, ${failedSeeds.size} failed`);
process.exit(fails.length ? 1 : 0);
