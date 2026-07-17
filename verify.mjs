#!/usr/bin/env node
// candor verify — the DYNAMIC HONESTY ORACLE cli (candor-spec RQ1). Run a program under a runtime capture,
// then check candor's static claim against what actually happened: `observed(f) ⊆ inferred(f) ∪ {Unknown}`
// per executed function. A cardinal-sin VIOLATION — a function that RAN an effect its complete (no-Unknown)
// signature omitted, or an ABSENT (claimed-pure) function that ran anything — exits 1. This is the
// mechanism-INDEPENDENT check: it observes the real Node effect boundary, sharing no code with the classifier.
//
//   candor-ts-verify [<dir>] --run "<cmd>" [--report <prefix>] [--scope direct|all] [--json]
//
// <dir> = the scanned project root (default cwd; its .candor/report is used unless --report overrides).
// --run = the command that exercises the code (e.g. "node app.js", "npm test"). Its node process(es) load
// the capture preload via NODE_OPTIONS. --scope: direct = {Net,Fs,Exec} (the syscall-parity headline),
// all = also the language-level {Env,Clock,Rand,…}. Exit 1 on any cardinal-sin violation, else 0.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadReport } from "./query-core.mjs";
import { verifySites } from "./verify-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`candor verify: ${msg}`);
  console.error('usage: candor-ts-verify [<dir>] --run "<cmd>" [--report <prefix>] [--scope direct|all] [--json]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let dir = null, runCmd = null, reportPrefix = null, scope = "direct", wantJson = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--run") runCmd = argv[++i];
  else if (a === "--report") reportPrefix = argv[++i];
  else if (a === "--scope") scope = argv[++i];
  else if (a === "--json") wantJson = true;
  else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage(`unknown flag ${a}`);
  else if (dir === null) dir = a;
  else usage(`unexpected argument ${a}`);
}
if (!runCmd) usage("missing --run <cmd> (the command that exercises the code)");
if (scope !== "direct" && scope !== "all") usage(`--scope must be direct|all (got ${scope})`);

const rootDir = path.resolve(dir ?? ".");
if (!fs.existsSync(rootDir)) usage(`no such directory: ${rootDir}`);

// Resolve the report: --report prefix, else <dir>/.candor/report (the standing convention).
const prefix = reportPrefix ?? path.join(rootDir, ".candor", "report");
const fns = loadReport(prefix);
if (!fns || fns.length === 0) {
  usage(`no report at ${prefix} — scan the project first (candor-ts ${rootDir}) so verify has a claim to check`);
}
const report = { functions: fns };

// A fresh trace file + the capture preload wired via NODE_OPTIONS so EVERY node subprocess of --run
// (including `npm test`'s workers) records. The preload attributes to the nearest frame under rootDir.
const traceFile = path.join(os.tmpdir(), `candor-verify-${process.pid}-${Date.now()}.ndjson`);
try { fs.rmSync(traceFile, { force: true }); } catch { /* fresh */ }
const preload = path.join(HERE, "verify-preload.mjs");
const env = {
  ...process.env,
  CANDOR_VERIFY_ROOT: rootDir,
  CANDOR_VERIFY_TRACE: traceFile,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--import ${JSON.stringify(preload)}`,
};

if (!wantJson) console.error(`candor verify: running \`${runCmd}\` under the honesty oracle (scope: ${scope})…`);
const run = spawnSync(runCmd, { shell: true, stdio: wantJson ? ["inherit", "ignore", "inherit"] : "inherit", env });
if (run.error) usage(`could not run \`${runCmd}\`: ${run.error.message}`);

// Read the capture (NDJSON sites). An absent/empty trace means nothing effectful ran (or nothing was
// captured) — a vacuous HOLD, disclosed by the executed-fn count.
let sites = [];
try {
  sites = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch { /* no trace written — no effectful call recorded */ }
try { fs.rmSync(traceFile, { force: true }); } catch { /* best-effort cleanup */ }

const { rows, violations, metrics } = verifySites(report, sites, scope);
metrics.analyzedFunctionsTotal = fns.length; // coverage denominator (the static claim's size)
metrics.programExitCode = run.status;

if (wantJson) {
  console.log(JSON.stringify({ metrics, violations, rows }, null, 2));
} else {
  const held = metrics.honestyInvariantHolds;
  console.log(`candor verify [${scope}]: honesty invariant ${held ? "HOLDS ✓" : "VIOLATED ✘"} ` +
    `over ${metrics.executedFunctionsChecked} executed fn(s) (of ${fns.length} analyzed)`);
  console.log(`  sound-complete ok       : ${metrics.soundCompleteOk}`);
  console.log(`  disclosed-partial       : ${metrics.disclosedPartial} (${metrics.disclosedUnknownLoadBearing} Unknown-load-bearing)`);
  console.log(`  cardinal-sin violations : ${metrics.cardinalSinViolations}`);
  for (const v of violations) {
    console.log(`    ✘ ${v.fn}: ran { ${v.observed.join(", ")} } but candor declared complete { ${v.inferred.join(", ") || "pure"} } → escaped { ${v.escaped.join(", ")} }`);
  }
  if (run.status !== 0) {
    console.error(`  note: \`${runCmd}\` exited ${run.status} — the trace may be partial (fewer functions exercised).`);
  }
}

process.exit(violations.length ? 1 : 0);
