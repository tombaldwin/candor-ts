#!/usr/bin/env node
// candor — the SEEDED-VIOLATION SENSITIVITY BATTERY (RQ1 Part C, the paper's "non-negotiable" experiment).
//
// A clean honesty-oracle result is meaningless without proving the falsifier is SENSITIVE. For each dynamic
// mechanism a static analyzer legitimately cannot see through (eval, Function ctor, computed require, a
// callback stored in a collection, an async/detached continuation, a config-driven target, computed-key
// dispatch), we PLANT a real effect (an Fs read of a unique sentinel file) reachable ONLY through that
// mechanism, then check the two-sided honesty guarantee:
//
//   observed(f) ⊆ declared(f) ∪ {Unknown}   holds for EACH mechanism iff, at the seeded function,
//   candor EITHER disclosed the effect / an Unknown  (the CONTRACT pre-empted it)
//   OR  `candor verify` caught the containment violation at runtime  (the ORACLE was the net).
//
// A mechanism where NEITHER happens — yet the effect provably ran — is an ESCAPE: a hole in the contract
// or the oracle. That is the finding this battery exists to surface; it is disclosed, never hidden.
//
//   node sensitivity.mjs [--json] [--keep]
//
// Each fixture prints `EFFECT-RAN:<mech>` after performing the planted effect, so the harness has an
// INDEPENDENT witness that the effect executed (needed to distinguish a true ESCAPE from a path not taken).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wantJson = process.argv.includes("--json");
const keep = process.argv.includes("--keep");

// The planted effect is an Fs WRITE to a per-fixture OUT path, hidden behind the mechanism. Using a write
// (not a read) gives an OUT-OF-BAND execution witness — the harness checks the filesystem for OUT afterward,
// so nothing candor-visible has to prove the effect ran (a candor-visible witness would itself leak the Fs
// and confound the disclosure check). The seeded function is `leak`; candor should mark it Fs or Unknown, or
// verify must catch the write. `OUT` is substituted into each source as a string literal (the DESTINATION is
// literal; only the fs API reference is hidden behind the mechanism — so a non-disclosing candor is a real miss).
const MECHANISMS = [
  { id: "eval", desc: "eval of a dynamic string",
    body: `const m = "write" + "FileSync"; const api = eval("require('node:fs')." + m); api(OUT, "ran");` },
  { id: "function-ctor", desc: "new Function(...) generated code",
    body: `const f = new Function("o", "require('node:fs').writeFileSync(o,'ran')"); f(OUT);` },
  { id: "computed-require", desc: "require() of a computed module name",
    body: `const name = ["node:", "fs"].join(""); require(name).writeFileSync(OUT, "ran");` },
  { id: "callback-in-collection", desc: "an effectful closure stored in a collection, invoked later",
    body: `const reg = new Map(); reg.set("k", () => require("node:fs").writeFileSync(OUT, "ran")); reg.get("k")();` },
  { id: "async-continuation", desc: "effect in a detached async continuation",
    body: `await new Promise((res) => setTimeout(() => { require("node:fs").writeFileSync(OUT, "ran"); res(); }, 0));` },
  { id: "computed-key-dispatch", desc: "computed-key method dispatch to an effectful method",
    body: `const api = require("node:fs"); const key = "write" + "FileSync"; api[key](OUT, "ran");` },
  { id: "deserialization-hook", desc: "effect fired from a JSON.parse reviver (a lifecycle callback)",
    body: `JSON.parse('{"a":1}', (k, v) => { if (k === "a") require("node:fs").writeFileSync(OUT, "ran"); return v; });` },
  { id: "property-getter", desc: "effect performed inside a property getter, triggered by access",
    body: `const o = {}; Object.defineProperty(o, "x", { get() { require("node:fs").writeFileSync(OUT, "ran"); return 1; } }); void o.x;` },
];

const FIXTURE = (mech) => `// seeded fixture: ${mech.desc} (a real Fs write reachable only via this mechanism)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);   // CJS require in an ESM fixture (module scope)
globalThis.require = require;                       // also global, so new Function(...)'s generated code resolves it
const OUT = ${JSON.stringify("__OUT__")};
export async function leak() { ${mech.body} }   // candor should disclose Fs/Unknown here, else verify must catch it
export function pureNoise(a) { return a * 2 + 1; }
await leak();
`;

function scan(dir, prefix) {
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), dir, "--allow-js", "--out", prefix], { encoding: "utf8" });
  const rep = fs.existsSync(`${prefix}.json`) ? JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")) : null;
  return { ok: r.status === 0, rep };
}

// candor discloses the effect at `leak` iff leak's inferred set (transitively) contains Fs OR Unknown.
function candorDiscloses(rep) {
  const fns = rep?.functions ?? [];
  const leak = fns.find((f) => f.fn.endsWith(".leak") || f.fn === "app.leak");
  if (!leak) return { disclosed: false, how: "leak absent (claimed pure)" };
  const inf = leak.inferred ?? [];
  if (inf.includes("Fs")) return { disclosed: true, how: "inferred Fs" };
  if (inf.includes("Unknown")) return { disclosed: true, how: "disclosed Unknown" };
  return { disclosed: false, how: `claimed { ${inf.join(", ") || "pure"} }` };
}

// Write a DISCLOSURE-STRIPPED copy of the report next to <prefix>: every fn claimed complete-pure (inferred
// []). This forces the ORACLE to be the only net — the harshest recall test: with candor's disclosure gone,
// does verify still catch the effect the mechanism actually performed? The span loc index is kept (real
// attribution). Returns the stripped prefix.
function stripDisclosure(prefix) {
  const stripped = prefix + ".stripped";
  const rep = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  for (const f of rep.functions ?? []) f.inferred = [];
  fs.writeFileSync(`${stripped}.json`, JSON.stringify(rep));
  for (const ext of [".callgraph.json", ".locs.json"]) {
    if (fs.existsSync(`${prefix}${ext}`)) fs.copyFileSync(`${prefix}${ext}`, `${stripped}${ext}`);
  }
  return stripped;
}

function runVerify(dir, prefix, appPath, outPath) {
  try { fs.rmSync(outPath, { force: true }); } catch { /* fresh */ }
  const canStrip = spawnSync("node", ["--experimental-strip-types", "-e", "0"]).status === 0;
  const runCmd = `node ${canStrip ? "--experimental-strip-types " : ""}${JSON.stringify(appPath)}`;
  const r = spawnSync("node", [path.join(HERE, "verify.mjs"), dir, "--report", prefix, "--run", runCmd, "--json"], { encoding: "utf8" });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* leave null */ }
  const ran = fs.existsSync(outPath); // OUT-OF-BAND witness: the planted write landed ⇒ the effect executed
  return { j, ran, raw: r };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "candor-sensitivity-"));
const results = [];
for (const mech of MECHANISMS) {
  const dir = path.join(root, mech.id);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "OUT.marker");
  fs.writeFileSync(path.join(dir, "app.ts"), FIXTURE(mech).replace("__OUT__", outPath));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"sens","version":"0.0.0","type":"module"}');

  const prefix = path.join(dir, ".candor", "report");
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const { rep } = scan(dir, prefix);
  const disc = candorDiscloses(rep);                       // side 1: did candor pre-emptively disclose?
  // side 2 (oracle recall): strip candor's disclosure → does verify still catch the runtime effect?
  const stripped = stripDisclosure(prefix);
  const { j, ran } = runVerify(dir, stripped, path.join(dir, "app.ts"), outPath);

  const oracleCaught = !!j?.violations?.some((v) => v.escaped?.includes("Fs"));
  let verdict;
  if (!ran) verdict = "INCONCLUSIVE (effect did not run)"; // fixture didn't exercise the path — not a pass
  else if (oracleCaught) verdict = "ORACLE-CAUGHT";        // recall ✓: caught even with disclosure stripped
  else verdict = "ESCAPED";                                // effect provably ran, oracle missed it — a HOLE

  results.push({ mechanism: mech.id, desc: mech.desc, candorDisclosed: disc.disclosed, candor: disc.how,
    effectRan: ran, oracleCaught, verdict });
}

if (!keep) fs.rmSync(root, { recursive: true, force: true });

const ran = results.filter((r) => r.effectRan);
const escaped = results.filter((r) => r.verdict === "ESCAPED");
const inconclusive = results.filter((r) => r.verdict.startsWith("INCONCLUSIVE"));
const disclosed = results.filter((r) => r.candorDisclosed);
const summary = {
  total: results.length,
  candorDisclosureRate: `${disclosed.length}/${results.length}`, // side 1: candor pre-empted (Fs/Unknown)
  oracleRecall: `${ran.filter((r) => r.oracleCaught).length}/${ran.length}`, // side 2: caught with disclosure stripped
  escaped: escaped.length,
  inconclusive: inconclusive.length,
};

if (wantJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log("candor sensitivity battery — the seeded honesty-invariant study (RQ1 Part C)");
  console.log("  two-sided per mechanism: (1) did candor DISCLOSE (Fs/Unknown)?  (2) with disclosure STRIPPED,");
  console.log("  did the ORACLE still catch the runtime effect? An effect that ran but neither net caught = ESCAPE.\n");
  for (const r of results) {
    const mark = r.verdict === "ESCAPED" ? "✘" : r.verdict.startsWith("INCONCLUSIVE") ? "•" : "✓";
    console.log(`  ${mark} ${r.mechanism.padEnd(24)} disclosed=${r.candorDisclosed ? "yes" : "NO "}  oracle=${r.oracleCaught ? "caught" : (r.effectRan ? "MISSED" : "n/a  ")}  → ${r.verdict}`);
    console.log(`      candor ${r.candor}`);
  }
  console.log(`\n  candor disclosure rate : ${summary.candorDisclosureRate}   (mechanisms candor pre-emptively flagged Fs/Unknown)`);
  console.log(`  oracle recall          : ${summary.oracleRecall}   (of effects that ran, caught with candor's disclosure stripped)`);
  if (escaped.length) console.log(`  ✘ ESCAPED (${escaped.length}): ${escaped.map((e) => e.mechanism).join(", ")} — a hole in the contract or the oracle`);
  if (inconclusive.length) console.log(`  • inconclusive (${inconclusive.length}): ${inconclusive.map((e) => e.mechanism).join(", ")} — fixture did not exercise the effect`);
}
process.exit(escaped.length ? 1 : 0);
