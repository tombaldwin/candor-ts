#!/usr/bin/env node
/**
 * candor-ts — the TypeScript implementation of candor-spec 0.5.
 *
 * Origin (kept honest): this engine began as the clean-room derivability proof — a single-file
 * slice written from SPEC.md/SEMANTICS.md/CLASSIFIER.md alone, frozen as that claim in git history
 * (`a29b152`). Product growth since (multi-file projects, the literal surfaces, the policy gate)
 * is spec-implemented but post-hoc; its guarantee is the cross-engine conformance suite.
 *
 * Resolve each call via the TypeScript compiler API (CLASSIFIER §1: resolve, don't pattern-match),
 * classify resolved external targets by the curated κ (§3; the I/O boundary), record local edges,
 * propagate to the least fixpoint (SEMANTICS §5), mark unresolvable calls Unknown (SPEC §4 — an
 * `any`-typed callee or a function-valued parameter/field IS the "could not resolve" case), and
 * emit the §2 report envelope + the §2.2 call-graph sidecar (every analyzed function a key). With
 * --policy (or CANDOR_POLICY), evaluate the §6.2 gate (AS-EFF-006/008/009) over the result: exit 1
 * on violation, exit 2 LOUDLY on an unreadable policy. With CANDOR_BASELINE (or a config `baseline`
 * key), run the AS-EFF-005 regression guard against a saved report: an existing fn gaining an effect
 * is a violation (exit 1); an unparseable or different-build baseline is invalid gate input (exit 2).
 *
 * Usage: node scan.mjs <dir | file.ts | tsconfig.json> [--out <prefix>] [--policy <file>]
 *        node scan.mjs <file.ts> <out-prefix>                  (legacy positional form)
 *   writes <prefix>.json (report) and <prefix>.callgraph.json
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { parsePolicy, evaluatePolicy, scopeMatches, parseUnknownAliases, parseNetPartners, discoverConfigText,
         reasonClass, discoverConfigPath, policyVocabularyAnchor, policyErrorText, policyRefusalUnevaluated, policyUnreadable, policyZeroRules, fatalPolicyErrors, refusalVerdict,
         netClassResolver, resolveReasonClasses } from "./policy.mjs";
import { unverifiedHoleRule, ruleUpgrade, byCodePoint, claimsToHaveJudgedNothing, reportCorruptKeys, entryCorruptKeys } from "./query-core.mjs";
import { printAgents } from "./contract.mjs";
import { isTestPath, kappa, kappaKnows, fsKind, commandHeadEffects, hostLiteral, tablesInSql,
         modelHostEffects, isModelHost, isModelSdkPackage, netClassesOf } from "./scan-core.mjs";
import { emitSurface } from "./surface.mjs";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

// The single version + spec sources, read once. PKG_VERSION is the bare semver from package.json
// (e.g. "0.5.0"); ENGINE_VERSION (below) prefixes it for the report envelope's `version` field, and
// `--version` prints the bare form. SPEC_VERSION is the spec contract this build speaks — the SAME
// literal stamped into the envelope's `spec` field, so the doc lines and the report can never drift.
// Reused, never re-littered.
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.27";
/** The `deps` / `CANDOR_DEPS` separator set — ASCII whitespace plus `:` and `,`.
 *
 * ONE CONSTANT BECAUSE TWO SPELLINGS WERE A SILENT GREEN. The §3.3.1 sink-over-input guard and the
 * dep-chain loader each carried their own regex; they disagreed on `\n`, so a newline-separated
 * `CANDOR_DEPS` was one unresolvable token to the guard and two real paths to the loader. A
 * `--gate-json` naming one of those reports was therefore unguarded: arming overwrote it, the scan
 * finished, and the operator's dep report ended up holding this run's `{"ok": true}` at exit 0.
 *
 * NOT JS `\s`, which includes U+00A0: these are PATHS, and a non-breaking space inside one is part of
 * the path, not a separator — java, rust and swift all treat it that way. */
const DEP_SEPARATORS = /[ \t\n\r:,]+/;

// --version: a print-and-exit MODE, handled before the main arg walk so it never depends on a target.
// Fully OFFLINE — candor never phones home. Staying current is the AGENT's job: read the installed
// build + upgrade line here, then (the agent has the network) compare against npm and upgrade.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`candor-ts ${PKG_VERSION} (spec ${SPEC_VERSION})`);
  console.log("upgrade: npm install -g candor-ts@latest");
  process.exit(0);
}

// -h / --help: a print-and-exit MODE (like --version), handled before the arg walk so `-h` (a single
// dash) is never mistaken for the scan target by the positional fallthrough below.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`candor-ts — the TypeScript/JavaScript effect analyzer.

Reads TS/JS source through the TypeScript compiler API — no build needed. Calls
are resolved through the checker; a call that cannot be resolved reads Unknown,
never silently pure. The report lands in .candor/, where candor-ts-query and the
umbrella \`candor\` CLI discover it.

USAGE
  candor-ts <dir | file.ts | tsconfig.json> [flags]

  The target is a project directory, a single .ts file, or a tsconfig.json.

OPTIONS
  --out <prefix>            write the report to <prefix>.json + <prefix>.callgraph.json
  --json                    print the report as JSON to stdout (instead of writing files)
  --policy <file>           enforce a policy file (deny/pure/allow/forbid) — exit 1 on a
                            violation, 2 if unreadable
  --gate-json <file>        write the structured gate verdict { spec, ok, violations } as JSON
  --allow-js                also scan plain JS/Node (.js/.mjs/.cjs), not just TypeScript
  --dep-inits               scan the packages this project imports at TOP LEVEL and chain their
                            reports, so an import that RUNS an effectful dependency initializer is
                            disclosed instead of reading pure. One child scan per direct dependency.
  --workspace  (--deps)     auto-discover the target's symlinked monorepo (workspace) dependencies,
                            scan each into .candor/deps/, and chain them so a cross-package call
                            discloses the sibling package's effects instead of reading pure
  --agents                  print the agent contract for this build (AGENTS.md)
  -V, --version             print the installed version + upgrade line (offline)
  -h, --help                show this help

ENVIRONMENT / CONFIG
  CANDOR_POLICY=<file>           the policy when --policy is absent (a .candor/config
                                 \`policy\` key works too)
  CANDOR_BASELINE=<report.json>  (or a .candor/config \`baseline\` key) runs the AS-EFF-005
                                 regression guard against a saved same-build report: exit 1
                                 when an existing function gained an effect, exit 2 on an
                                 unparseable or different-build baseline (never evaluated),
                                 a stderr note when absent
  CANDOR_UNKNOWN_RATCHET         (or a .candor/config \`unknown-ratchet\` key) opt-in: flip an
                                 Unknown-ONLY gain vs the baseline from advisory to an
                                 AS-EFF-005 FAILURE (exit 1). A fn already Unknown in the
                                 baseline is grandfathered; only a NEW Unknown fails — so
                                 \`deny E Unknown\` becomes adoptable on legacy code

EXAMPLES
  candor-ts .
  candor-ts src --allow-js
  candor-ts . --policy candor.policy --gate-json gate.json
  candor-ts-query where Db          query the report this scan wrote

Docs: candor.poly.io   ·   Verify an install: candor doctor
See https://github.com/tombaldwin/candor`);
  process.exit(0);
}

// ---- args ----------------------------------------------------------------------------------------
// ONE pass: the first non-flag is the target; value-taking flags consume the next arg and FAIL on a
// missing/flag-shaped value; an unknown flag fails; flags may precede the target. `--agents` is a
// flag (a print-and-exit MODE) — it must NOT fire when it is the VALUE of --out/--policy, which the
// value-consuming skip handles, nor produce a "lying unknown flag" error for a real flag given first.
const usage = "usage: candor-ts <dir | file.ts | tsconfig.json> [--out <prefix>] [--json] [--policy <file>] [--gate-json <file>] [--allow-js] [--workspace] [--agents] [--version] [--help]";
const argv = process.argv.slice(2);
// Declared HERE, above the sink guard, because the guard calls `loadCandorConfig` and that reads
// these: left below, they were in the temporal dead zone, the call threw, and the `catch` around it
// swallowed the throw — so the config channel the guard exists to enumerate was silently empty and a
// config-declared policy was destroyed at exit 0 again. A `catch` that hides a programming error is a
// fail-open with a reason attached.
const CONFIG_KEYS = new Set(["policy", "baseline", "strict", "no-ambient", "closed-world", "taint", "deps", "unknown-alias", "net-partner", "unknown-ratchet", "engine"]);
const CONFIG_KEYS_IMPLEMENTED = new Set(["policy", "baseline", "deps", "unknown-ratchet", "engine"]);

// ── SPEC §3.3.1 ⟨0.27⟩ ARM FIRST, AND NEVER OVER AN INPUT.
//
// This pre-pass learns the sink and this run's inputs with NO side effects, before the parse loop
// below, for two reasons the loop cannot serve:
//
//  (1) the loop's own `unknown flag` exit(2) runs BEFORE the arming did, so `--frobnicate --gate-json G`
//      exited leaving the PREVIOUS run's green document at G. §3.3 names an unknown flag as a
//      broken-gate-config exit-2 cause, which MUST leave a refusal — the contract cannot depend on
//      argv order, and it did.
//  (2) arming WRITES, so a sink that names the policy DESTROYS it. Measured: `--policy P --gate-json P`
//      on violating code exited 0 with `ok: true` — the armed JSON replaced P, every line of it parsed
//      as an unknown rule, and the gate ran over zero rules. A machine-readable all-clear produced by
//      deleting the question.
const preScan = (av) => {
  let gate = null, policy = null, target = null, out = null;
  for (let i = 0; i < av.length; i++) {
    const a = av[i], v = av[i + 1];
    if (a === "--gate-json" || a === "--policy" || a === "--out") {
      if (v === undefined || (v !== "-" && v.startsWith("--"))) continue;
      // ⟨0.28⟩ THE LAST `--out` WINS, BECAUSE THAT IS WHAT THE PARSE LOOP HONOURS — every assignment here
      // overwrites, deliberately. candor-swift's arm of this rung caught the reference engine returning
      // the FIRST: measured on `--out p1 --out p2 --zzz-not-a-flag`, p1 was armed and p2 — the prefix the
      // run would actually have written — stayed STALE, so the rung did nothing for that argv while
      // neutralising a set nobody was going to replace. A pre-pass that disagrees with the loop it exists
      // to run ahead of arms the wrong thing.
      if (a === "--gate-json") gate = v; else if (a === "--policy") policy = v; else out = v;
      i++;
      continue;
    }
    // The scan TARGET, needed to discover the `.candor/config` whose `policy` key may name an input
    // this sink must not overwrite.
    if (!a.startsWith("-") && target === null) target = a;
  }
  return { gate, policy, target, out };
};

// SPEC §3.3.1 ⟨0.28⟩ — every `--gate-json` this argv names. `preScan` keeps only the last, which is what
// the parse loop honours and exactly the behaviour this rung refuses: measured, three engines wrote the
// verdict to the LAST path and left the first holding a previous run's `{"ok": true}` while the gate
// fired — the ⟨0.27⟩ stale green, reached by a spelling nobody had considered.
const allGateSinks = (av) => {
  const out = [];
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== "--gate-json") continue;
    const v = av[i + 1];
    if (v === undefined || (v !== "-" && v.startsWith("--"))) continue;
    out.push(v); i++;
  }
  return out;
};

// Every path this run READS, whatever channel it arrived through (SPEC §3.3.1 ⟨0.27⟩).
//
// THE FIRST VERSION OF THIS GUARD KEYED ON THE FLAG. With the policy declared by `.candor/config` — the
// checked-in form, i.e. the one a CI job actually has — `--gate-json <that policy>` destroyed it and
// exited 0 with `"ok": true` in ALL FOUR ENGINES. A policy does not change what it is according to how
// the operator handed it over. The config is read LENIENTLY (no exit, no diagnostic): this runs before
// the real config load and must not pre-empt its refusal.
// Artifact identity, not string identity: `--policy /w/P --gate-json ./P` from /w is one file, and the
// engine that already had this guard compared path spellings and lost to exactly that. realpath resolves
// `.`, `..` and symlinks; for a sink that does not exist yet its parent is resolved instead.
const sameArtifact = (a, b) => {
  if (!a || !b || a === "-" || b === "-") return false;
  // ⟨0.28⟩ DEVICE+INODE FIRST. Path equality alone called two HARDLINKS to one inode two sinks and
  // refused a legal command — the mirror of the stale green. And a symlink whose target does not exist
  // YET still names that target, which `realpathSync` cannot resolve, so resolve it explicitly.
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
  } catch { /* one of them is not there yet — fall through */ }
  try {
    const ra = resolveSinkArtifact(a), rb = resolveSinkArtifact(b);
    if (ra !== a || rb !== b) {
      if (path.resolve(ra) === path.resolve(rb)) return true;
    }
  } catch { /* fall through to the path forms below */ }
  const resolve = (p) => {
    try { return fs.realpathSync(p); } catch { /* not there yet — resolve the parent */ }
    try { return path.join(fs.realpathSync(path.dirname(path.resolve(p))), path.basename(p)); } catch { return null; }
  };
  const x = resolve(a);
  return x !== null && x === resolve(b);
};

const runInputs = (target, policyFlag) => {
  const out = [];
  if (policyFlag) out.push([policyFlag, "--policy"]);
  for (const [v, label] of [["CANDOR_POLICY", "CANDOR_POLICY"], ["CANDOR_BASELINE", "CANDOR_BASELINE"],
                            ["CANDOR_CONFIG", "CANDOR_CONFIG"]]) {
    if (process.env[v]) out.push([process.env[v], label]);
  }
  // ONE DEFINITION, shared with the loader — see DEP_SEPARATORS. This comment used to claim it was
  // "the separator set the dep loader accepts" while spelling a DIFFERENT set one screen away, and the
  // gap between the two was a silent green: a newline-separated `CANDOR_DEPS` registered here as one
  // unresolvable token, so the guard protected nothing, while the loader split it into real paths.
  // `--gate-json` naming one of those reports then DESTROYED it and the run exited 0 with `ok: true`
  // written over the operator's input — §3.3.1's own words, "a machine-readable all-clear produced by
  // deleting the question". Measured live before this change.
  for (const d of (process.env.CANDOR_DEPS ?? "").split(DEP_SEPARATORS).filter(Boolean)) {
    out.push([d, "a CANDOR_DEPS report"]);
    // A DIRECTORY DEP IS EVERY REPORT INSIDE IT. `deps` accepts a directory — `--workspace` writes
    // `.candor/deps/` and hands that back, so it is the common spelling — and the loader then walks it
    // and reads each `*.json`. Registering only the DIRECTORY left those files unnamed, so
    // `--gate-json <depdir>/lib.json` was unguarded: arming destroyed the operator's dep report, the
    // run chained the wreckage and exited 0 with `ok: true` over it. Measured in all four engines.
    //
    // EXPANDED HERE, not by making `sameArtifact` directory-aware. That was tried and is far too
    // broad: the scan TARGET is an input too, and a verdict written into the tree being scanned is
    // ordinary usage — the general rule refused it and took 33 tests with it. Only a DEP directory has
    // its CONTENTS read, so only a dep directory expands.
    try {
      if (fs.statSync(d).isDirectory()) {
        for (const f of fs.readdirSync(d)) {
          if (f.endsWith(".json") && !f.endsWith(".callgraph.json") && !f.endsWith(".hierarchy.json")
              && !f.endsWith(".locs.json")) {
            out.push([path.join(d, f), "a CANDOR_DEPS report"]);
          }
        }
      }
    } catch { /* not a directory, or unreadable — the token itself is still registered above */ }
  }
  // …AND THE CONFIG'S OWN KEYS, THROUGH THE ENGINE'S OWN LOADER AND ITS OWN DISCOVERY. This used to
  // re-derive both, and a review took it apart: the home directory was computed as parent-of-parent
  // unconditionally where the loader only steps out of a trailing `.candor/` segment, so an out-of-tree
  // CANDOR_CONFIG had its relative values anchored one level too high and the guard protected a path
  // the run never reads. A second parser is a second set of holes; `loadCandorConfig` is called inside a
  // try so it can still refuse for real a moment later.
  const cfgFile = discoverConfigFile(target ?? ".");
  if (cfgFile) {
    out.push([cfgFile, "the discovered .candor/config"]);
    try {
      const cfg = loadCandorConfig(target ?? ".", { lenient: true });
      for (const key of ["policy", "baseline"]) {
        if (cfg[key]) out.push([cfg[key], `the config's \`${key}\``]);
      }
      for (const one of (cfg.deps ?? "").split(":").filter(Boolean)) {
        out.push([one, "the config's `deps`"]);
      }
    } catch { /* lenient: the real load refuses on its own terms */ }
  }
  return out;
};

// ⟨0.27⟩ THE STREAM SINK'S ANALOG OF ARMING — SPEC §3.1's stream-sink clause. `--gate-json -` cannot be
// armed (a stream has no stale previous document, and a placeholder would put TWO documents in a
// consumer's pipe), but the document-on-every-exit rule applies in full: an exit-2 cause that fires
// before the gate tail — an unknown flag, a valueless gate-adjacent flag, a missing target — must still
// leave the fail-closed refusal as the stream's only content. Measured: an unhonourable policy wrote the
// refusal to stdout while an unknown flag exited 2 leaving stdout EMPTY — the same operator mistake,
// answered or not according to which early exit fired, and an empty stream throws the consumer back to
// scraping stderr. File sinks need nothing here: the arming above already left a refusal in place.
// DECLARED HERE, above the pre-arg-loop `{ … }` block: those guards can themselves exit 2, and the
// helper has to exist BEFORE its first caller — a `const` doesn't hoist, so left below where it used to
// live (before the arg loop but after this block) it was in the temporal dead zone at every gate-input
// refusal, and stdout stayed empty on every one of them. Measured while writing this move.
const preGateSink = preScan(argv).gate;
// ⟨0.28⟩ SPEC §3.3.1 (4) — THE SAME RULE ONE HOP UPSTREAM, FOR THE REPORT STREAM. `--json` is the
// stdout REPORT sink; on any exit-2 the fail-closed ⟨0.21⟩ Row-1 report is written to stdout as the
// stream's only content. Measured 2026-08-10 across all four engines: `--json --zzz-not-a-flag` exited
// 2 with stdout ZERO BYTES, so a downstream JSON consumer parsing stdout throws and is thrown back to
// scraping stderr — the same defect ⟨0.27⟩ closed on the verdict stream, arriving through the report
// sink because that rule was written for the verdict sink and no engine extended it. Detected here
// pre-arg-loop by `argv.includes("--json")`: this flag is stdout-only, and the value-consuming flags
// exit 2 rather than swallow it as their value, so a `--json` token in argv IS the request.
const preWantJson = argv.includes("--json");
// `reportStreamWritten` latch: mirrors the rust reference's `REPORT_STREAM_WRITTEN` OnceLock. Set
// once, at the successful `wantJson` print further down the file (search for this comment tag), so a
// later exit-2 site does not put a SECOND JSON document on the stream — two documents on one pipe
// parses as neither.
let reportStreamWritten = false;
// The ⟨0.21⟩ Row-1 manifest-carrying empty: `functions: []` + `analyzed.count: 0` + `unanalyzed`
// naming the cause. A ⟨0.24⟩ consumer already reads this as *nothing was judged, no purity licence*
// and a `gate --report` records the file `invisible` — no new reader logic. The version/toolchain
// match the ordinary envelope so a consumer's provenance check reads the same.
// ONE BUILDER FOR BOTH SINKS: the stream form below and the ⟨0.28⟩ `--out` file armer emit the SAME
// bytes for the same reason string. Two spellings of one document is how a consumer ends up with two
// shapes to recognise, and the file form is the one a `gate --report` parses.
const failClosedReportDoc = (reason) => {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\n\r]/g, " ");
  return `{\n "candor": {\n  "version": "candor-ts-${PKG_VERSION}",\n  "toolchain": "node-${process.versions.node}",\n  "spec": "${SPEC_VERSION}"\n },\n "functions": [],\n "analyzed": { "count": 0 },\n "unanalyzed": [\n  { "path": "<run>", "reason": "${esc(reason)}" }\n ]\n}`;
};
const refuseEarlyToStream = (why) => {
  if (preGateSink === "-") console.log(JSON.stringify(refusalVerdict(SPEC_VERSION, why, null), null, 1));
  else if (preWantJson && !reportStreamWritten) {
    // Skipped when stdout is already claimed by `--gate-json -` (the two-stream case is refused
    // earlier with a verdict on stdout).
    console.log(failClosedReportDoc(`refused: ${why}`));
    reportStreamWritten = true;
  }
};

// ── SPEC §3.3.1 ⟨0.28⟩ — ARM THE `--out <prefix>` REPORT SET, AND HAND BACK WHAT THE RUN DID NOT OWN.
//
// The verdict sink arms by writing to a path the run is about to own. A report PREFIX cannot: at parse
// time the run does not know which files it will write (this engine writes `<prefix>.json`, a workspace
// engine fans out to one per member), so the set it DOES know is the one the PREVIOUS run left on disk —
// and that is exactly the set at risk of being read as current after this run fails. Measured on this
// engine: `node scan.mjs <target> --out p --zzz-not-a-flag` exited 2 with `p.json` byte-identical to the
// previous good run, and a downstream `gate --report p.json` then reads a green report the failed run
// never produced.
//
// Armed from the pre-pass, before the arg loop's own unknown-flag exit — the exit this rung is most
// often reached through. Each report the run does write overwrites its placeholder a moment later.
//
// SIDECARS ARE NOT TOUCHED, deliberately: whether they must arm alongside their report is an OPEN
// question against §2.2 ⟨0.26⟩'s own manifest rules, and answering it here would put a second answer in
// the family. They are left out by POSITIVE IDENTIFICATION of the report, not by a name list — see the
// loop below for why the list was the wrong mechanism and not merely the wrong length.
const OUT_ARM_DOC = failClosedReportDoc(
  "armed: this report was written when the run STARTED and was never replaced, so the run failed, "
  + "crashed or was killed before it could describe this package. It is NOT a claim about any code; "
  + "see the run's stderr for the cause.") + "\n";
/** `[path, bytes-before-arming]` for every report armed under the out prefix. */
const outArmed = [];
const armOutPrefixFailClosed = (prefix, inputs) => {
  if (!prefix) return;
  const abs = path.resolve(prefix);
  const dir = path.dirname(abs), stem = path.basename(abs);
  if (!stem) return;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }   // no previous run under this prefix: nothing to arm
  for (const name of names.sort()) {
    if (!name.startsWith(`${stem}.`) || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
    // ONLY FILES POSITIVELY IDENTIFIED AS THIS ENGINE'S OWN §2 REPORT — never a name denylist.
    //
    // The first version excluded `.callgraph`/`.hierarchy`/`.locs` by suffix and armed everything else
    // under the prefix. SPEC §2.2 ⟨0.24⟩ (the "reserved set, family-wide" paragraph) lists SEVEN reserved
    // trailing segments — `callgraph`, `hierarchy`, `calibrated`, `layerreach`, `locs`, `gate` and the
    // `encountered-*` family — and records that the engines were already drifting on it, one carving out
    // six and another two. This carved out three. Measured on the rust reference: the armer overwrote
    // `<prefix>.calibrated.json`, `.layerreach.json`, `.encountered-hosts.json` and — worst —
    // `<prefix>.gate.json`, a GATE VERDICT, each replaced by a report-shaped placeholder. A run whose
    // report sink is armed was silently destroying the verdict sink's document beside it.
    //
    // THE MECHANISM WAS WRONG, NOT JUST THE LIST. This project's denylist-over-allowlist rule is about
    // CLASSIFYING, where over-approximating is the safe direction. For a WRITER it inverts:
    // over-approximating destroys a file. §2.2 can call an incomplete denylist "loud" because an
    // unregistered suffix there merely falls back into a candidate set and gets disclosed; in an armer it
    // is silent and destructive. So this writes only what it recognises as its own report — a JSON object
    // carrying both a `candor` envelope and `functions` — which needs no list and cannot drift as the
    // reserved family grows. (The placeholder itself carries both, so an already-armed file re-arms.)
    let doc;
    try { doc = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.candor === undefined || doc.functions === undefined) continue;
    // THE ⟨0.27⟩ (2) INPUT EXEMPTION APPLIES TO THIS WRITER TOO. Arming happens before the run knows its
    // answer, so a prefix whose expansion collides with something this run READS would destroy it — the
    // same hazard that made `--policy P --gate-json P` a machine-readable all-clear. A policy or a
    // chained dep report can perfectly well be named `<prefix>.something.json`. Same resolver as every
    // other sink guard (`sameArtifact`: device+inode, then the resolved path).
    const hit = inputs.find(([other]) => sameArtifact(full, other));
    if (hit) {
      console.error(`candor-ts: --out ${prefix} would arm over ${full}, which this run READS as ${hit[1]} `
        + `— leaving it untouched. Give the report set its own prefix.`);
      continue;
    }
    // Remember the bytes BEFORE overwriting, so a run that completes can hand back anything it turned
    // out not to own (see disarmUnwrittenOutReports).
    let prev;
    try { prev = fs.readFileSync(full); } catch { continue; }
    try { writeSinkAtomic(full, OUT_ARM_DOC); outArmed.push([full, prev]); }
    catch (e) {
      console.error(`candor-ts: could not arm the report ${full} fail-closed (${e.message}) — if this run `
        + `does not complete, that path may still hold a PREVIOUS run's report`);
    }
  }
};

// HAND BACK WHAT THIS RUN TURNED OUT NOT TO OWN. Arming cannot know at parse time which files the run
// will write, so it arms the whole previous set. Once the run has finished writing, a file STILL holding
// the placeholder is one the run never claimed — a leftover from a package that is no longer in the scan.
//
// THAT IS NOT AN INCOMPLETE ANALYSIS, AND LEAVING THE PLACEHOLDER THERE ASSERTS ONE. The rust reference's
// first version kept them and described it as closing the orphaned-report defect for free; it did not. A
// placeholder's non-empty `unanalyzed` is the ⟨0.21⟩ incomplete-analysis trigger, so a COMPLETE scan
// began refusing with exit 2 and went on refusing until someone deleted the leftover by hand. The run did
// not fail to analyze that package; the package is not there. Claiming an incompleteness the run never
// experienced is the mirror of the staleness this rung exists to close.
//
// So the previous bytes go back and THE ORPHAN IS LEFT EXACTLY AS FOUND — still an open defect (a report
// for code that is gone still reaches a gate over the prefix), deliberately: it is pre-existing, it has
// its own wire question (delete it? mark it not-in-scan? a prefix can legitimately be shared), and
// resolving it inside a staleness fix would be deciding it by accident. Deleting the placeholder instead
// of restoring is rejected for §3.3.1's own reason: a consumer treating a missing file as "nothing to
// report" fails open by another route.
const disarmUnwrittenOutReports = () => {
  const armed = Buffer.from(OUT_ARM_DOC);
  for (const [file, prev] of outArmed) {
    let now;
    try { now = fs.readFileSync(file); } catch { continue; }
    if (!now.equals(armed)) continue;                      // this run rewrote it — a real report
    try { writeSinkAtomic(file, prev); }
    catch (e) {
      console.error(`candor-ts: could not restore ${file}, which this run armed but did not write `
        + `(${e.message}) — it still holds the fail-closed placeholder`);
    }
  }
};

{
  const { gate, policy, target: preTarget, out: preOut } = preScan(argv);
  // ⟨0.28⟩ The DUPLICATE case is decided below, and the single-sink guards here must not pre-empt it:
  // they act on `gate` alone — the LAST sink — so `--gate-json - --gate-json <the policy>` exited on the
  // policy before the STREAM could be told anything (measured: exit 2, stdout zero bytes).
  const _named0 = allGateSinks(argv);
  const _distinct0 = [];
  for (const g of _named0) {
    if (!_distinct0.some((k) => k === g || (k !== "-" && g !== "-" && sameArtifact(k, g)))) _distinct0.push(g);
  }
  const singleSink = _distinct0.length < 2;
  // ⟨0.28⟩ `--json` BESIDE `--gate-json -`: a report and a verdict cannot share one stream. Decided here,
  // in the pre-pass, so the refusal is stdout's ONLY content — refusing after the report has gone out is
  // the defect, not the fix. On this engine `--json` is stdout-only, so the sink alone decides it.
  if (gate === "-" && argv.includes("--json")) {
    console.error("candor-ts: --json and --gate-json - both name STDOUT — refusing (exit 2). `--json` "
      + "writes the REPORT there and `--gate-json -` the VERDICT, so this would put two JSON documents on "
      + "one stream and a consumer parsing it gets neither. Send one to a file, or run the scan twice.");
    console.log(JSON.stringify(refusalVerdict(SPEC_VERSION,
      "--json and --gate-json - both name stdout — a report and a verdict cannot share one stream", null), null, 1));
    process.exit(2);
  }
  for (const [other, flag] of (gate && singleSink ? runInputs(preTarget, policy) : [])) {
    if (gate && sameArtifact(gate, other)) {
      console.error(`candor-ts: --gate-json ${gate} names the SAME FILE as ${flag} ${other} — refusing `
        + `(exit 2). The verdict is armed before the policy is read, so this would overwrite your policy `
        + `and then gate on the wreckage. Nothing was written; give the verdict its own path.`);
      refuseEarlyToStream(`--gate-json ${gate} names the same file as ${flag} ${other}`);
      process.exit(2);
    }
  }
  // `.candor/config` is never a verdict sink, wherever it is. The per-input checks above can only name
  // inputs the run was TOLD about; the config is DISCOVERED by walking up from the target, so by the
  // time its path is known the arming has already destroyed it. A check on the SHAPE needs no
  // discovery, so it runs before the first write and covers a config found anywhere up the tree.
  if (gate && singleSink && gate !== "-") {
    const abs = path.resolve(gate);
    if (path.basename(abs) === "config" && path.basename(path.dirname(abs)) === ".candor") {
      console.error(`candor-ts: --gate-json ${gate} is a .candor/config — refusing (exit 2). The verdict `
        + `is armed before the config is read, so this would destroy the config that configures this `
        + `run. Nothing was written; give the verdict its own path.`);
      refuseEarlyToStream(`--gate-json ${gate} is a .candor/config`);   // ⟨0.28⟩ report stream too
      process.exit(2);
    }
  }
  if (gate && singleSink && sameArtifact(gate, process.env.CANDOR_CONFIG)) {
    console.error(`candor-ts: --gate-json ${gate} names the SAME FILE as CANDOR_CONFIG — refusing (exit 2).`);
    refuseEarlyToStream(`--gate-json ${gate} names the same file as CANDOR_CONFIG`);   // ⟨0.28⟩
    process.exit(2);
  }
  // ⟨0.28⟩ A REPEATED `--gate-json` IS REFUSED, AND EVERY PATH NAMED GETS THE REFUSAL. Placed after the
  // input-collision guards above and before arming: a sink that is an INPUT is refused having written
  // nothing, and that exemption outranks this one — this write must not be the thing that destroys a
  // policy. Two spellings of one path are ONE sink (the same artifact rule), so `--gate-json P
  // --gate-json ./P` from P's own directory is not a duplicate.
  const named = allGateSinks(argv);
  const distinct = [];
  for (const g of named) {
    if (!distinct.some((k) => k === g || (k !== "-" && g !== "-" && sameArtifact(k, g)))) distinct.push(g);
  }
  // EVERY named sink gets the input checks, not just the one the parse honours. The first draft checked
  // only `gate` (the last), so with `--policy P --gate-json P --gate-json B` the guard never saw P and
  // this refusal DESTROYED the policy — measured against the other three engines, which kept it. The
  // input exemption outranks this refusal: a sink that is an input is refused having written nothing.
  // ⟨0.28⟩ THE INPUT EXEMPTION COVERS THE PATH, NOT THE RUN. Refusing the whole run on the first
  // offending sink left the OTHER named sink holding whatever it held — measured: exit 2, the policy
  // correctly intact, and an innocent sink still publishing a previous run's `{"ok": true}` to its
  // reader. The offending path gets nothing; every other one gets the refusal.
  const offending = new Set();
  if (distinct.length > 1) {
    for (const g of distinct) {
      let bad = false;
      for (const [other, flag] of runInputs(preTarget, policy)) {
        if (sameArtifact(g, other)) {
          console.error(`candor-ts: --gate-json ${g} names the SAME FILE as ${flag} ${other} — refusing `
            + `(exit 2). Nothing was written there.`);
          bad = true;
        }
      }
      if (g !== "-") {
        const abs = path.resolve(g);
        if (path.basename(abs) === "config" && path.basename(path.dirname(abs)) === ".candor") {
          console.error(`candor-ts: --gate-json ${g} is a .candor/config — refusing (exit 2). Nothing was written there.`);
          bad = true;
        }
      }
      if (sameArtifact(g, process.env.CANDOR_CONFIG)) {
        console.error(`candor-ts: --gate-json ${g} names the SAME FILE as CANDOR_CONFIG — refusing (exit 2).`);
        bad = true;
      }
      if (bad) offending.add(g);
    }
    if (offending.size === distinct.length) {
      refuseEarlyToStream(`every named --gate-json path collides with an input`);   // ⟨0.28⟩ report stream
      process.exit(2);
    }
  }
  if (distinct.length > 1) {
    const list = distinct.join(", ");
    console.error(`candor-ts: --gate-json given more than once (${list}) — refusing (exit 2). A gate `
      + `publishes ONE verdict. Naming two sinks says where it goes twice, and the reader of the path `
      + `that loses cannot tell it lost. Name one, or run the gate twice.`);
    const doc = JSON.stringify(refusalVerdict(SPEC_VERSION,
      `--gate-json was given more than once (${list}) — a run publishes one verdict to one sink`, null), null, 1);
    for (const g of distinct) {
      if (offending.has(g)) continue;                 // the exemption is scoped to this path
      if (g === "-") console.log(doc);
      else try { writeSinkAtomic(g, doc + "\n"); }
      catch (e) { console.error(`candor-ts: could not write the refusal to --gate-json ${g} (${e.message})`); }
    }
    // ⟨0.28⟩ report stream: only fire the helper when stdout wasn't ALREADY claimed by a `--gate-json -`
    // verdict written in the loop above — the helper would otherwise write a second document to stdout
    // (its verdict arm keys on `preGateSink === "-"` and doesn't know one was just printed). When `-`
    // isn't in the list, refuseEarlyToStream's report arm handles the `--json` case; when it is, the
    // verdict is already there and `--json` was refused earlier (line 333), so nothing more is owed.
    if (!distinct.includes("-")) refuseEarlyToStream(`--gate-json was given more than once (${list})`);
    process.exit(2);
  }
  if (gate && gate !== "-") armGateJsonFailClosed(gate);
  // ⟨0.28⟩ …AND ARM THE REPORT SET, still before the arg loop below can exit on an unknown flag.
  //
  // **ONLY AN EXPLICITLY NAMED `--out`, NEVER THE DEFAULT PREFIX.** The first version of this armed the
  // default `<target>/.candor/report` too, reasoning that an operator who passes no `--out` still has
  // yesterday's report there to go stale. That is right about staleness and wrong about OWNERSHIP, and
  // the difference DESTROYS DATA: measured, `scan.mjs <repo> --zzz-not-a-flag` overwrote a COMMITTED
  // `.candor/report.json` with the placeholder — and committed reports and baselines are the pattern
  // this project recommends and ships in CI. A run that dies in argv parsing was never going to write
  // there, and it had not been told it owned that path. (It bit for real: this engine's first version
  // left candor-rust's committed report dirty while running a conformance probe.)
  //
  // ⟨0.27⟩'s arming rule never had to face this because `--gate-json` has no default — every verdict
  // sink is NAMED. So "arm at the instant the sink is known" presumes a sink the operator named, and
  // that presumption is explicit here: with `--out p` the operator has declared p is this run's output
  // and arming is right even when p is checked in; with no flag there is no such declaration. The legacy
  // positional prefix (`scan.mjs f.ts out`) is left alone for the same reason it was never armed here.
  //
  // `--json` publishes the report to STDOUT and writes no files at all, so there is no file sink to arm
  // in that form — it is the stream rule above, and arming under it would rewrite files this run is
  // never going to touch.
  if (preOut && !preWantJson) armOutPrefixFailClosed(preOut, runInputs(preTarget, policy));
}
let target = null, outPrefix = null, policyPath = process.env.CANDOR_POLICY ?? null, gateJsonPath = null, allowJs = false, wantAgents = false, wantJson = false, wantWorkspace = false, wantDepInits = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--agents") wantAgents = true;
  else if (a === "--json") wantJson = true;
  else if (a === "--allow-js") allowJs = true;
  // --workspace: auto-discover the target's symlinked WORKSPACE (monorepo) dependencies, scan each into
  // .candor/deps/ with interface-CHA union entries, and chain them so a cross-package call discloses the
  // sibling's effects instead of reading pure (the candor-ts analog of rust `--deps`, SPEC §2).
  else if (a === "--workspace" || a === "--deps") wantWorkspace = true;
  else if (a === "--dep-inits") wantDepInits = true;
  else if (a === "--out" || a === "--policy" || a === "--gate-json") {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`candor-ts: ${a} requires a value (${usage})`);
      refuseEarlyToStream(`${a} requires a value`);
      process.exit(2);
    }
    if (a === "--out") outPrefix = v; else if (a === "--policy") policyPath = v; else gateJsonPath = v;
    i++;
  }
  // Any leading-dash token that isn't a recognized flag is an unknown flag — NOT a positional target
  // (SPEC §6.2/§7). `-h`/`-V`/`--help`/`--version` are print-and-exit modes consumed above, so by here
  // a single-dash token (`-x`, the typo `-policy`) can only be a mistake; treating it as the scan
  // target would silently scan the wrong thing.
  else if (a.startsWith("-")) {
    console.error(`candor-ts: unknown flag ${a} (${usage})`);
    // ⟨0.27⟩ §3.3 names an unknown flag as a broken-gate-config exit-2 cause; the stream sink gets the
    // refusal document too (see refuseEarlyToStream — the file sink is already armed).
    refuseEarlyToStream(`unknown flag ${a}`);
    process.exit(2);
  }
  else if (target === null) target = a;
  else if (outPrefix === null) outPrefix = a; // legacy positional prefix
  else {
    console.error(`candor-ts: unexpected extra argument ${a} (${usage})`);
    refuseEarlyToStream(`unexpected extra argument ${a}`);
    process.exit(2);
  }
}
if (wantAgents) { printAgents(); process.exit(0); }
if (target === null) {
  console.error(usage);
  refuseEarlyToStream("no scan target");
  process.exit(2);
}

// ---- .candor/config (candor-spec §config; the checked-in alternative to the CANDOR_* env vars) -----
// Discovery is anchored to the SCAN TARGET (walk up from the target dir to the repo root's
// .candor/config), never the CWD; $CANDOR_CONFIG overrides discovery entirely. Precedence: CLI flag →
// CANDOR_* env → this file → default. FAIL-CLOSED: a configured-but-unusable file (a set CANDOR_CONFIG
// naming a missing path; a discovered file that exists but can't be read) exits 2 — a gate source must
// never vanish silently (the §6.2 unreadable-policy posture). Only genuine absence is an empty config.
// Keys are the shared FAMILY vocabulary; a key OUTSIDE it warns (typo protection: a misspelt `policy`
// must not silently drop the gate).
// ⟨0.27⟩ `engine` (SPEC §3.4) is RECOGNIZED and IMPLEMENTED here — see enforceEnginePin. It must be in
// BOTH sets: missing from the vocabulary it is reported as unknown, and missing from IMPLEMENTED it is
// disclosed as inert — both tell an operator their pin was ignored while the engine is enforcing it.
// The subset this engine actually wires to a mode — `policy` (the gate), `baseline` (AS-EFF-005),
// `deps` (the cross-package report chain) and `unknown-ratchet` (the baseline guard's opt-in). The rest
// of the vocabulary is spec-inert HERE: it drives other engines' gates. But a checked-in enforcement key
// that silently does nothing is a DECLARED-GATE-SILENTLY-OFF — the reader believes the gate is on — so
// an inert recognized key DISCLOSES loudly (stderr only; verdict/report/exit code untouched) instead of
// staying mute. Same posture + message shape as candor-scan's CONFIG_KEYS_IMPLEMENTED.
// The ANCHOR a config file's RELATIVE path values (policy/deps) resolve against: the repo the config
// belongs to — the parent of its `.candor/` directory (the standard layout; candor-init scaffolds
// `policy arch.policy` meaning the repo root's), else the config file's own directory. NEVER the
// process CWD (family rule, matching policy.mjs discoverConfigPolicy's repoRoot): a checked-in config
// must mean the same file whether the scan is launched from the repo, from $HOME, or from a CI step's
// working-directory. Env/CLI values stay CWD-relative — they're per-invocation, not checked in.
function configAnchor(file) {
  const dir = path.dirname(path.resolve(file));
  return path.basename(dir) === ".candor" ? path.dirname(dir) : dir;
}
// ⟨0.27⟩ SPEC §3.4 `engine` — THE ENGINE↔BASELINE COUPLING, enforced instead of hoped for.
//
// The committed baseline is a snapshot of what ONE engine build reported, and an engine swap is
// baseline-invalidating. What a PIN adds over the provenance checks already in place is that it is
// DECLARATIVE — a build id is a hash nobody can write down, so the intended version lived in CI config,
// decoupled from the baseline it is married to. It also tells tooling which engine to FETCH, and it
// reaches a run with NO baseline configured at all.
//
// TWO OF THE FIVE VERDICTS MUST NOT CHANGE THE EXIT CODE: an ABSENT pin (the key is opt-in by
// construction) and an UNDETERMINED one, where §3.1's unanswerable-condition rule applies — disclosed,
// never scored, INCLUDING as satisfied. Exit 2 on a mismatch, never 1: unevaluable, not violating.
//
// A pin qualified for another implementation is not ours to check — one config serves the whole family,
// and the family versions as a LADDER, so a bare version in a polyglot repo would fail whichever engine
// had not yet caught up.
const ENGINE_IMPLS = new Set(["java", "rust", "ts", "swift", "agents"]);
function enginePinFor(text, implName) {
  let wild = null, qual = null, bad = false;
  for (const rawLine of (text ?? "").split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0].toLowerCase() !== "engine") continue;
    const rest = parts.slice(1);
    // Two lines that DISAGREE about the same key are kept BOTH, so they cannot parse as a version and
    // surface as malformed. One silently discarding the other is the failure this key exists to stop.
    const slot = (cur, v) => (cur !== null && cur !== v ? `${cur} / ${v}` : v);
    // A KNOWN QUALIFIER DECIDES OWNERSHIP BEFORE ARITY. Checking the one-token case first made `engine swift` a WILDCARD pin whose version is the literal "swift" -> MALFORMED -> exit 2 in every engine, so one operator forgetting a version on a qualified line killed the whole family. SPEC 3.4 says the skip is whole-line 'whatever follows it' -- and nothing following it is a case of that too.
    if (rest.length && ENGINE_IMPLS.has(rest[0].toLowerCase())) {
      if (rest[0].toLowerCase() === implName) { if (rest.length === 2) qual = slot(qual, rest[1]); else bad = true; }
      continue;                                    // another impl's line, whatever follows it
    }
    if (rest.length === 0) bad = true;
    else if (rest.length === 1) wild = slot(wild, rest[0]);
    else bad = true;
  }
  if (bad) return "<unreadable>";
  // AN UNREADABLE UNQUALIFIED LINE IS NOT HIDDEN BY A QUALIFIED PIN. `qual ?? wild` returned the qualifi
  // ed value, so `engine garbage` beside a good qualified line passed SILENTLY here while candor-java exited 
  // 2 — the exact mirror of the bug just fixed in java, four engines the other way. Unreadability is a property of the LINE; precedence only decides which VERSION applies.
  if (wild !== null && normalizePinVersion(wild) === null) return wild;
  return qual ?? wild;
}
function normalizePinVersion(raw) {
  const s = String(raw ?? "").trim().replace(/^[vV]/, "");
  if (!/^\d+\.\d+(\.\d+)?$/.test(s)) return null;
  return s.split(".").length === 2 ? `${s}.0` : s;
}
function enforceEnginePin(targetPath) {
  const pin = enginePinFor(discoverConfigText(targetPath), "ts");
  if (pin === null || pin === undefined) return;                       // ABSENT
  const want = normalizePinVersion(pin);
  if (want === null) {
    console.error(`candor-ts: .candor/config has an \`engine\` line that is not an engine version.`);
    console.error(`        want \`engine <version>\` (e.g. \`engine v${PKG_VERSION}\`) or \`engine <impl> <version>\``);
    console.error(`        (e.g. \`engine ts v${PKG_VERSION}\`) for a repo scanned by more than one engine.`);
    console.error(`        Failing (exit 2) rather than ignoring it: a pin that cannot be read is a`);
    console.error(`        guard the operator believes is on.`);
    process.exit(2);
  }
  const running = normalizePinVersion(PKG_VERSION) ?? String(PKG_VERSION ?? "").trim();
  if (!running || running === "unknown") {                             // UNDETERMINED — disclose, never score
    console.error(`candor-ts: .candor/config pins engine ${pin}, and this build does not know its own release,`);
    console.error(`        so the pin CANNOT be checked. Disclosed, not scored — neither passed nor failed.`);
    return;
  }
  if (want === running) return;                                        // MATCH
  console.error(`candor-ts: .candor/config pins engine ${pin} but this build is candor-ts ${PKG_VERSION}.`);
  console.error(`        The pin and the committed baseline move together — a newer engine resolves more`);
  console.error(`        dispatch, so its report is not comparable with a baseline the pinned engine wrote.`);
  console.error(`        Either run the pinned engine, or update the pin and regenerate the baseline in the`);
  console.error(`        same change. Exit 2 (unevaluable), not 1 — this is not a policy violation.`);
  // ONE call, not two: an insertion script matched both pin branches to this single exit, and the
  // duplicate put TWO documents on the stream — which parses as neither. The other branch (a build that
  // cannot determine its own release) RETURNS rather than exiting: disclosed, not scored, so no refusal
  // belongs there.
  refuseEarlyToStream(`.candor/config pins engine ${pin}, which this build does not satisfy`);
  process.exit(2);
}

// WHICH config file this run reads, with NO side effects (SPEC §3.4). Extracted so the §3.3.1 sink
// guard asks the same question the loader answers instead of re-deriving the walk — a review took the
// guard's own copy apart on exactly that divergence.
function discoverConfigFile(targetPath) {
  const env = process.env.CANDOR_CONFIG;
  if (env) {
    try { return fs.statSync(env).isFile() ? env : null; } catch { return null; }
  }
  let dir = path.resolve(targetPath ?? ".");
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  for (let d = dir; ; d = path.dirname(d)) {
    const cand = path.join(d, ".candor", "config");
    if (fs.existsSync(cand)) return cand;
    if (path.dirname(d) === d) break;                         // filesystem root
  }
  return fs.existsSync(".candor/config") ? ".candor/config" : null;
}

/// `lenient: true` THROWS where this would otherwise `process.exit(2)`.
///
/// The collision pre-pass needs the config's DECLARED input paths before the sink is armed, and it
/// wrapped this call in a try under the comment "the real load refuses on its own terms" — which
/// assumes the failure arrives as an exception. It does not: `process.exit` is not catchable, so an
/// unreadable config killed the run INSIDE that try, before arming, leaving a pre-seeded green verdict
/// intact at the file sink. SPEC §3.3's own words for that: "a refusal that writes nothing leaves the
/// previous run's green document on disk." java answers the same input with `refused: true`.
///
/// Nothing is lost by leniency here. If the config cannot be read it declares no inputs anyone can
/// name, so the collision check over them is vacuous; arming then proceeds and the REAL load refuses a
/// moment later — now with the sink armed, so the refusal reaches it. A second parser was the
/// alternative, and a second parser is a second set of holes.
function loadCandorConfig(targetPath, { lenient = false } = {}) {
  let file = process.env.CANDOR_CONFIG ?? null;
  if (file !== null) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (lenient) throw new Error(`CANDOR_CONFIG set but ${file} is not a readable file`);
      console.error(`candor-ts: CANDOR_CONFIG set but ${file} is not a readable file — failing (exit 2)`);
      // The config is the EARLIEST exit-2 cause, and the one the stream sink is least likely to be
      // armed for — which is exactly why it was the last one still leaving stdout empty. Found by
      // PART 36 (b11), a row written before this line was.
      refuseEarlyToStream(`CANDOR_CONFIG set but ${file} is not a readable file`);
      process.exit(2);
    }
  } else {
    file = discoverConfigFile(targetPath);
    if (file === null) return {};
  }
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (lenient) throw new Error(`config ${file} exists but could not be read (${e.message})`);
    console.error(`candor-ts: config ${file} exists but could not be read (${e.message}) — failing (exit 2)`);
    refuseEarlyToStream(`config ${file} exists but could not be read`);
    process.exit(2);
  }
  const cfg = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();                 // strip inline comments (§6.2 lexical)
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(.*)$/);
    const key = m[1].toLowerCase(), val = (m[2] ?? "").trim();
    if (!CONFIG_KEYS.has(key)) {
      console.error(`candor-ts: ignoring unknown config key '${key}' in ${file}`);
      continue;
    }
    // MULTI-VALUE keys this engine DOES implement, but reads from the config TEXT rather than this
    // single-value map (which cannot hold many names): `unknown-alias` via parseUnknownAliases and
    // `net-partner` via parseNetPartners, both over discoverConfigText. Neither was in CONFIG_KEYS, so
    // setting either printed "ignoring unknown config key" WHILE THE VALUE WAS HONOURED — an actively
    // FALSE disclosure, worse than a missing one in a tool whose contract is that its statements about
    // itself are true. Recognized above, and skipped here so they are not mislabelled inert instead.
    if (key === "unknown-alias" || key === "net-partner") continue;
    // RECOGNIZED but not wired here: disclose that the gate/mode is off rather than accepting the key
    // into `cfg` and dropping it — silence would read as "understood and applied" to the author who
    // checked it in. Two DIFFERENT cases, both kept: outside-the-vocabulary is a typo, this is a
    // per-engine coverage gap.
    if (!CONFIG_KEYS_IMPLEMENTED.has(key)) {
      console.error(`candor-ts: config key '${key}' is recognized by the candor family but not implemented by candor-ts — that gate/mode is NOT active on this scan (the nightly lint / another engine enforces it)`);
      continue;
    }
    cfg[key] = val;
  }
  // Resolve the PATH-valued keys against the config's anchor (see configAnchor). `deps` is a path
  // LIST — each token resolves; an empty value stays empty (configured-with-empty fails loud below).
  const anchor = configAnchor(file);
  if (cfg.policy) cfg.policy = path.resolve(anchor, cfg.policy);
  if (cfg.baseline) cfg.baseline = path.resolve(anchor, cfg.baseline);
  // ASCII whitespace ONLY, like java and swift: these are PATHS, and JS `\s` includes U+00A0, so a dep
  // path containing a non-breaking space split into two halves that were then both "skipped" — a green
  // run with the dep silently unchained, where java and rust loaded it.
  if (cfg.deps) cfg.deps = cfg.deps.split(/[ \t:,]+/).filter(Boolean).map((t) => path.resolve(anchor, t)).join(":");
  return cfg;
}
// ⟨0.24⟩/⟨0.27⟩ ARM THE VERDICT FAIL-CLOSED. Every exit path then leaves a refusal behind unless the run
// got far enough to replace it with a real verdict. A review found the pin refusal leaving the PREVIOUS
// run's document on disk — a CI wrapper reading the artifact instead of the exit code then reports a pass
// over a run that refused. candor-java's `armGateJson` is the model; the wording is about the RUN, not
// about the code.
//
// A `function` declaration, not a `const`: it is CALLED from the pre-pass above the arg loop, and only a
// hoisted declaration can be. The write is inlined rather than calling `writeAtomic` for the same reason
// in reverse — that helper is a `const` declared ~4700 lines below, so calling it would be a
// temporal-dead-zone throw.
// ⟨0.28⟩ RESOLVE THE SINK TO ITS FINAL ARTIFACT BEFORE WRITING, and preserve the operator's layout.
// `renameSync` REPLACES a symlink rather than following it, so an `artifacts/verdict.json` linked into a
// shared directory kept a previous run's `{"ok": true}` while this run's document landed on the link — a
// stale green with a single `--gate-json` and no operator mistake. And rename gives the destination a NEW
// inode, so a multiply-linked target strands its other name with the previous document; there the write
// goes in place, trading the atomicity window for not publishing a stale verdict at a name the operator
// wired up. SPEC §3.3.1 states identity about ARTIFACTS; this family had it in the comparison only.
function resolveSinkArtifact(p) {
  let cur = p;
  for (let i = 0; i < 32; i++) {
    let st;
    try { st = fs.lstatSync(cur); } catch { return cur; }
    if (!st.isSymbolicLink()) return cur;
    let t;
    try { t = fs.readlinkSync(cur); } catch { return cur; }
    cur = path.isAbsolute(t) ? t : path.join(path.dirname(cur), t);
  }
  return cur;
}

function writeSinkAtomic(p, text) {
  const target = resolveSinkArtifact(p);
  try {
    if (fs.statSync(target).nlink > 1) { fs.writeFileSync(target, text); return; }
  } catch { /* not there yet — the ordinary temp+rename path is right */ }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

function armGateJsonFailClosed(p) {
  try {
    writeSinkAtomic(p, JSON.stringify({
      spec: SPEC_VERSION, ok: false, refused: true,
      reason: "the gate did not complete — this document was written when the run STARTED and was never "
        + "replaced by a verdict, so the run failed, crashed or was killed before it could decide. It is "
        + "NOT a verdict about the code; see the run's stderr for the cause.",
    }, null, 1) + "\n");
  } catch (e) {
    console.error(`candor-ts: could not arm --gate-json ${p} fail-closed (${e.message}) — if this run `
      + `does not complete, that path may still hold a PREVIOUS run's verdict`);
  }
}
// MOVED ABOVE THE CONFIG LOAD. `loadCandorConfig` is ITSELF an exit-2 cause (an unusable
// CANDOR_CONFIG, or a committed `.candor/config` that cannot be read), and arming after it left a
// config refusal exiting 2 with the PREVIOUS run's green still on disk — while the comment below
// said "BEFORE ANYTHING THAT CAN EXIT". The rule only holds if the arming really is first.
// ⟨0.24⟩ ARM THE VERDICT FAIL-CLOSED BEFORE ANYTHING THAT CAN EXIT. A review found the pin refusal
// leaving the PREVIOUS run's `--gate-json` document on disk — a CI wrapper reading the artifact instead
// of the exit code then reports a pass over a run that refused. Arming at the START makes this a CLASS
// fix: every exit path leaves a refusal unless the run got far enough to replace it. candor-java's
// `armGateJson` is the model, and the wording is about the RUN, not about the code.
// (armed by the pre-pass above, before the arg loop — see SPEC §3.3.1 ⟨0.27⟩. Arming HERE was still
// after the loop's unknown-flag exit, so the contract depended on argv order.)
const candorConfig = loadCandorConfig(target);
enforceEnginePin(target);   // ⟨0.27⟩ §3.4 — AFTER the arming, so its exit 2 cannot leave a stale verdict
// precedence: the --policy flag / CANDOR_POLICY env already populated policyPath; the config is the floor.
// A BARE `policy` line ("" value) means configured-with-empty → the unreadable-policy path fails loud.
if (policyPath === null && candorConfig.policy !== undefined) policyPath = candorConfig.policy;
// baseline (the AS-EFF-005 regression guard, SPEC §7 item 5): CANDOR_BASELINE env → config `baseline`
// (path-valued keys are already resolved against the config's anchor above). No CLI flag — matching
// candor-java, the reference engine (env/config only). A BARE `baseline` line ("") fails loud below.
let baselinePath = process.env.CANDOR_BASELINE ?? null;
// WHICH SOURCE supplied it decides what a MISSING file means: `CANDOR_BASELINE` is set unconditionally
// by the adopt workflow, so an absent path there is "the ratchet is not adopted yet"; a checked-in
// `baseline` line DECLARES this repo has one, so an absent path there was deleted or never committed —
// and the guard passing green over it is a gate that silently stopped gating.
let baselineFromConfig = false;
if (baselinePath === null && candorConfig.baseline !== undefined) { baselinePath = candorConfig.baseline; baselineFromConfig = true; }
// ⟨unknown-ratchet⟩ OPT-IN (config `unknown-ratchet` / CANDOR_UNKNOWN_RATCHET, default OFF): flip an
// Unknown-ONLY gain vs the baseline from advisory to an AS-EFF-005 failure (exit 1). Env-override truthy
// semantics mirror candor-java's Config.flag exactly — env var PRESENCE means on (env can't express off);
// else the config value is truthy (empty/true/1/yes, case-insensitive). Default OFF keeps the ⟨0.16⟩
// advisory posture BYTE-IDENTICAL. See the baseline guard below + candor-java Policy.checkBaseline.
const unknownRatchet = process.env.CANDOR_UNKNOWN_RATCHET != null
  || (candorConfig["unknown-ratchet"] !== undefined
    && (candorConfig["unknown-ratchet"] === ""
      || /^(true|1|yes)$/i.test(candorConfig["unknown-ratchet"])));

// ---- project discovery (a dir, a single file, or a tsconfig) --------------------------------------
let rootDir, fileNames, compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ["node"],
  strict: true,
};
// The scanner CLASSIFIES through the builtin typings, so `node` always rides in `types` — a
// project's `types: []` (legitimate for its own build) would blind the effect analysis itself.
function withNodeTypes(options) {
  const t = options.types && options.types.length ? options.types : [];
  return { ...options, types: [...new Set([...t, "node"])] };
}

function fromTsconfig(cfgPath, baseDir) {
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, baseDir);
  compilerOptions = withNodeTypes(parsed.options);
  let names = parsed.fileNames;
  // SOLUTION-STYLE configs (`files: [], references: [...]` — hono, most monorepo roots) list no
  // sources themselves; follow the references one level and union their file lists (skipping
  // test/bench configs by the same path rule). Found by the published-package probe: hono read
  // "no TypeScript sources".
  if (names.length === 0 && (parsed.projectReferences ?? []).length > 0) {
    for (const ref of parsed.projectReferences) {
      const refPath = ts.resolveProjectReferencePath(ref);
      if (!fs.existsSync(refPath) || isTestPath(path.relative(baseDir, refPath))) continue;
      const sub = ts.readConfigFile(refPath, ts.sys.readFile);
      const subParsed = ts.parseJsonConfigFileContent(sub.config ?? {}, ts.sys, path.dirname(refPath));
      if (names.length === 0) compilerOptions = withNodeTypes(subParsed.options);
      names = names.concat(subParsed.fileNames);
    }
    names = [...new Set(names)];
  }
  return names.filter((f) => !isTestPath(path.relative(baseDir, f)));
}
const stat = fs.existsSync(target) ? fs.statSync(target) : null;
if (!stat) {
  console.error(`candor-ts: no such path: ${target}`);
  // The SAME two lines as every other early exit in this file. `refuseEarlyToStream` WRITES AND
  // RETURNS — it is not a `Never`, and calling it INSTEAD of the exit lets the run continue past its
  // own refusal (measured, while getting this wrong: an unreadable dep wrote its refusal and then
  // exited 0). rust's equivalent is typed `-> !`, which is why the same slip could not happen there.
  refuseEarlyToStream(`no such path: ${target}`);
  process.exit(2);
}
let usedTsconfig = null;   // the tsconfig this run actually read, so a later disclosure can name the
                           // cause that APPLIES rather than the one that usually does.
if (stat.isFile() && /tsconfig.*\.json$/.test(path.basename(target))) {
  rootDir = path.dirname(path.resolve(target));
  usedTsconfig = path.resolve(target);
  fileNames = fromTsconfig(path.resolve(target), rootDir);
} else if (stat.isFile()) {
  rootDir = path.dirname(path.resolve(target));
  fileNames = [path.resolve(target)];
} else {
  rootDir = path.resolve(target);
  const tsconfig = path.join(rootDir, "tsconfig.json");
  if (fs.existsSync(tsconfig) && !allowJs) {
    usedTsconfig = tsconfig;
    fileNames = fromTsconfig(tsconfig, rootDir);
  } else {
    fileNames = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (isTestPath(path.relative(rootDir, p))) continue;
        if (ent.isDirectory()) walk(p);
        else if (/\.[mc]?tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) fileNames.push(p);
        else if (allowJs && /\.[mc]?jsx?$/.test(ent.name) && !/\.min\.js$/.test(ent.name)) fileNames.push(p);
      }
    })(rootDir);
  }
}
if (fileNames.length === 0) {
  console.error(`candor-ts: no TypeScript sources under ${target}`);
  // An empty scan is an exit-2 cause like any other: a consumer reading the stream after it must not
  // get nothing. §3.1 exempts no cause, and this one is easy to hit in CI (a path that moved).
  refuseEarlyToStream(`no TypeScript sources under ${target}`);
  process.exit(2);
}
// Builtin typings FALLBACK: the engine ships @types/node as its own dependency, so a target that
// hasn't installed it still resolves node:fs/node:net/… (found by the first npx-distribution
// probe: a bare fixture read Unknown for fs.readFileSync because nothing supplied the builtin
// types). Resolved via the module system, NOT a fixed relative path — npm HOISTS dependencies, so
// in an npx/install tree @types/node sits BESIDE candor-ts, not inside it (the second probe's
// catch). The TARGET's own @types win when present.
if (!compilerOptions.typeRoots) {
  const roots = [path.join(rootDir, "node_modules", "@types")];
  try {
    const req = createRequire(path.join(ENGINE_DIR, "scan.mjs"));
    roots.push(path.dirname(path.dirname(req.resolve("@types/node/package.json"))));
  } catch {}
  compilerOptions.typeRoots = roots;
}
if (!outPrefix) outPrefix = path.join(rootDir, ".candor", "report");
// --json prints the report to stdout and writes NOTHING, so skip creating the (otherwise default) .candor/ dir.
// The scanned package's name — the first half of the cross-package join key (SPEC §2 `hash`).
let pkgName = path.basename(rootDir);
try {
  const pj = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (pj.name) pkgName = pj.name;
} catch {}
if (!wantJson) fs.mkdirSync(path.dirname(path.resolve(outPrefix)), { recursive: true });

// A target with declared dependencies but no node_modules resolves almost nothing — the scan
// would "succeed" with a near-total-Unknown report a fresh user could ship (CTA-dogfood finding).
// Warn LOUDLY; the report is still written (it is sound), but the cause must be visible.
// ⟨0.19⟩ Also compute `declaredButUninstalled` (SPEC §6.2 §3, the setup/genuine split): a declared dep
// whose `node_modules/<dep>` is absent. An `Unknown` caused by a call into one of these is a SETUP hole
// (`no-node_modules:<pkg>` → reason class `setup`), NOT a genuine dynamic blind spot — the fix is
// `npm install`, not a policy decision. Tagging them separates the fatigue-vector (the referee's
// week-two-uninstall) from real dynamism, so a team can `Unknown[dynamic]` a strict gate AND be told
// exactly what to configure to shrink the rest.
const declaredButUninstalled = new Set();
{
  // Find the nearest package.json AT OR ABOVE the scan root: scanning a `src/` subdirectory must still see
  // the project manifest one level up, else the warning stays silent and a deps-less scan reads as a
  // codebase full of spurious `Unknown`s (the exact trap a 0.9 dogfood fell into — scanning `zx/src`).
  let projDir = null;
  for (let d = rootDir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) { projDir = d; break; }
    if (path.dirname(d) === d) break;                       // filesystem root
  }
  if (projDir) {
    try {
      // BOTH dependency kinds: `npm install` installs devDependencies too, and a project can import a
      // dev/vendored package in its source (zx imports `chalk` as a devDependency) — a `dependencies`-only
      // check left exactly that case unwarned.
      const pj = JSON.parse(fs.readFileSync(path.join(projDir, "package.json"), "utf8"));
      const deps = { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) };
      // "Installed?" follows node resolution: node_modules is searched at projDir AND every ANCESTOR, so a
      // dep HOISTED to a monorepo/workspace root counts as installed. Checking only projDir wrongly named a
      // hoisted-but-resolvable package in the SETUP diagnostic (review-found; cosmetic — the gate was already
      // safe via the resolve-first ordering, but the message must not cry wolf).
      const installed = (dep) => {
        for (let d = projDir; ; d = path.dirname(d)) {
          if (fs.existsSync(path.join(d, "node_modules", dep))) return true;
          if (path.dirname(d) === d) return false;
        }
      };
      for (const dep of Object.keys(deps)) if (!installed(dep)) declaredButUninstalled.add(dep);
      if (Object.keys(deps).length > 0 && !fs.existsSync(path.join(projDir, "node_modules")))
        console.error("candor-ts: WARNING — the project declares dependencies but has no node_modules; " +
                      "imports won't resolve, so calls into those packages can't be analyzed (they read " +
                      "`Unknown`, and their types don't resolve). Run `npm install` in the project first.");
    } catch {}
  }
  // Prisma's client types are GENERATED — a project with the prisma dependency but no generated
  // client resolves every db.* call to nothing (found on the first Next.js probe: a Prisma-backed
  // app read zero Db until `prisma generate` ran).
  if (fs.existsSync(path.join(rootDir, "node_modules", "@prisma", "client"))
      && !fs.existsSync(path.join(rootDir, "node_modules", ".prisma", "client"))) {
    console.error("candor-ts: WARNING — @prisma/client is installed but its client is not generated; " +
                  "db calls will not resolve. Run `npx prisma generate` in the target first.");
  }
}
// ⟨workspace chain⟩ --workspace: auto-discover the target's symlinked monorepo deps (a workspace link
// points OUT of node_modules to the package's real source), scan each into `.candor/deps/` with
// interface-CHA union entries (CANDOR_WORKSPACE_CHAIN), and feed that dir into the CANDOR_DEPS spec below —
// so a cross-package call (`client.get()` into `@ukri-tfs/common`) discloses the sibling's effects instead
// of reading pure. The candor-ts analog of rust `--deps`. The child scan is spawned WITHOUT --workspace, so
// there is no re-discovery recursion. TRANSITIVE: a dep's calls into ITS OWN workspace deps must also
// resolve, so we scan every dep repeatedly WITH the accumulating deps dir chained, to a fixpoint (effects
// are monotone → a few rounds converge; bounded by MAX_ROUNDS = workspace dep-graph depth).
// ⟨cache ownership⟩ `.candor/deps/` and `.candor/dep-inits/` are WRITE-ONLY caches that were never
// cleared, so a package whose rescan THREW was answered from the PREVIOUS run's file while the `catch`
// above said it "is skipped". Reproduced: a package published as typings plus a MINIFIED bundle exits 2
// on "no TypeScript sources" (the file walk excludes `*.d.ts` and `*.min.js`), and its consumer went on
// inheriting the prior build's PURITY CLAIM — silently, with `coverage.uncovered` empty and nothing on
// stderr. That is the cardinal sin through a cache door, and the same class as candor-swift `43a0eaa`.
//
// Two directions, and they pull against each other:
//   a file THIS RUN did not write is never served as if it had been, AND
//   a file CANDOR did not write is never deleted.
// The second is the unrecoverable one — candor-swift's own first fix (`b4f6cbc`) had to be repaired
// because its sweep deleted user-placed reports.
//
// So ownership is DERIVED, not marked. A sidecar marker would answer only for caches written AFTER this
// change and leave the first post-change run in exactly the broken state. The rule instead is: a file
// candor would have OVERWRITTEN on success is a file candor removes on failure. The candidates are the
// packages this run actually discovered, named by the WRITER'S OWN naming function, and nothing else is
// ever a candidate — a report the user dropped in for a package this run never looked at is untouched
// and still chains, on the same authority as any other `CANDOR_DEPS` input.
//
// STATED RESIDUAL: a cache file for a package that USED to be discovered and no longer is lingers and is
// still chained. Deleting it would require deciding it was ours, which is exactly the claim that cannot
// be made about a file this run never had a candidate for. Information kept rather than destroyed.
const depCacheFileName = (dir, name) => path.join(dir, `${String(name).replace(/[/@]/g, "_")}.json`);
// The name for a dep whose scan FAILED, in the WRITER'S OWN order of sources: the writer takes
// `report.package` and falls back to the directory basename, and `report.package` comes from the
// manifest — so the manifest `name` is the middle term, reachable without a successful scan.
function failedDepName(real) {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")).name;
    if (typeof n === "string" && n) return n;
  } catch { /* unreadable/malformed manifest — the basename is the writer's last source too */ }
  return path.basename(real);
}
function dropUnanswered(dir, candidates, answered, ownFiles, nameOf, flag) {
  const dropped = [];
  for (const c of candidates) {
    if (answered.has(c)) continue;
    const f = depCacheFileName(dir, nameOf(c));
    // Never remove a file THIS run wrote: two candidates can derive the same name, and one of them
    // succeeding must not be undone by the other failing.
    if (ownFiles.has(f) || !fs.existsSync(f)) continue;
    // Name it by the DERIVED name, not the directory: for a path dep those differ (the directory is
    // whatever the checkout is called), and naming the directory tells the reader nothing they can
    // match against their manifest — or against the file that was removed.
    try { fs.unlinkSync(f); dropped.push(nameOf(c)); }
    catch (e) { console.error(`candor-ts: ${flag} could not remove the stale cached report ${f} (${e.message}) — it will be chained`); }
  }
  if (dropped.length)
    console.error(`candor-ts: ${flag} could not scan ${dropped.sort().join(", ")} this run — dropped the PREVIOUS run's cached report(s) rather than answer from them (their calls read Unknown/invisible, as an unchained dependency does)`);
  return dropped;
}
const workspaceDepFileName = (real) => failedDepName(real);

let workspaceDepsDir = null;
if (wantWorkspace) {
  const selfPath = fileURLToPath(import.meta.url);
  workspaceDepsDir = path.join(rootDir, ".candor", "deps");
  fs.mkdirSync(workspaceDepsDir, { recursive: true });
  // 1. DISCOVER: every symlinked package real-path resolvable from rootDir (a workspace link is a symlink;
  //    a published dep is a real dir). Dedup — a hoisted dep appears under several ancestor node_modules.
  const depPaths = new Set();
  for (let d = rootDir; ; d = path.dirname(d)) {
    const nm = path.join(d, "node_modules");
    if (fs.existsSync(nm)) {
      const entries = [];
      for (const e of fs.readdirSync(nm)) {
        if (e.startsWith("@")) { try { for (const s of fs.readdirSync(path.join(nm, e))) entries.push(path.join(nm, e, s)); } catch { /* unreadable scope dir */ } }
        else entries.push(path.join(nm, e));
      }
      for (const ent of entries) {
        let isLink = false;
        try { isLink = fs.lstatSync(ent).isSymbolicLink(); } catch { /* gone */ }
        if (!isLink) continue;
        let real; try { real = fs.realpathSync(ent); } catch { continue; }
        if (fs.existsSync(path.join(real, "package.json"))) depPaths.add(real);
      }
    }
    if (path.dirname(d) === d) break;
  }
  // 2. SCAN to a FIXPOINT: each round re-scans every dep WITH the deps dir chained (CANDOR_DEPS), so a dep's
  //    calls into a sibling dep resolve. A dep chaining its OWN prior report is harmless (its internal calls
  //    resolve locally, never via crossDeps). Stop when a round changes no report, or at the depth cap.
  const names = new Set();
  const answered = new Set();                 // realpath -> this run produced a report for it
  const ownFiles = new Set();                 // the files this run wrote (never deletion candidates)
  const MAX_ROUNDS = 6;
  const runRounds = () => {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let anyChanged = false;
      for (const real of depPaths) {
        try {
          const out = execFileSync(process.execPath, [selfPath, real, "--json"],
            { env: { ...process.env, CANDOR_WORKSPACE_CHAIN: "1", CANDOR_DEPS: workspaceDepsDir },
              maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
          // ⟨ownership, half 1⟩ ONE derivation, shared with `failedDepName`, and TOTAL. The sweep's rule is
          // "a file candor would have OVERWRITTEN on success is the file it removes on failure", which is
          // only true while the writer's name and the sweeper's candidate name are the same string. They
          // were two spellings: this line took `report.package` on trust, `failedDepName` required a
          // non-empty STRING. A manifest saying `"name": 123` (or an object, or an array) made them
          // disagree — `name.replace` threw, the `catch` below read a SUCCESSFUL scan as a failure, and the
          // sweep then deleted `<directory-basename>.json`, a name this writer would never have produced.
          // Measured: a user-placed report at that name was destroyed, stderr said "could not scan utils"
          // about a scan that exited 0, and the count line claimed to have chained `123` while no file had
          // been written at all. Same test as `failedDepName`, so the two cannot drift apart again.
          const declaredPkg = JSON.parse(out.toString()).package;
          const name = (typeof declaredPkg === "string" && declaredPkg) ? declaredPkg : path.basename(real);
          const file = depCacheFileName(workspaceDepsDir, name);
          const prev = fs.existsSync(file) ? fs.readFileSync(file) : null;
          if (!prev || !prev.equals(out)) { fs.writeFileSync(file, out); anyChanged = true; }
          // ⟨ownership, half 2⟩ Recorded from the WRITE, not from the scan. These three lines used to sit
          // ABOVE it, so a `writeFileSync` that threw — a read-only `.candor/deps`, a full disk, a mode
          // the CI image sets — marked the dep ANSWERED, which made the sweep skip it and left the
          // PREVIOUS run's report standing in for a report this run never put on disk. That is exactly the
          // class `95d0b8b` closed, reached through the write door instead of the scan door. Note
          // `answered` is still recorded when the bytes are UNCHANGED and no write happens: confirmed is
          // not the same as rewritten, and keying it on a byte change would make a stable repeat run
          // delete the cache it had just verified.
          names.add(name); answered.add(real); ownFiles.add(file);
        } catch { /* a dep that fails to scan is skipped — see the ownership sweep below */ }
      }
      if (!anyChanged) break;   // fixpoint reached: transitive effects fully propagated
    }
  };
  runRounds();
  // ⟨sweep, then re-derive⟩ THE SWEEP ALONE LEAVES THE STALE ANSWER ONE HOP AWAY. Every child above is
  // spawned with `CANDOR_DEPS` pointing at THIS SAME directory, so a sibling that scanned cleanly has
  // already chained the report the sweep is about to remove — and its own cached report keeps that
  // answer, which is then what the parent chains. Deleting the file destroys the evidence and not the
  // conclusion. Measured on a two-dep workspace (`libb` imports `liba`, `liba` stops being scannable):
  // the parent's `callB` was ABSENT from `functions` — a ⟨0.21⟩ positive purity claim about a call into
  // source candor could not read — while the COLD arm, same source and no cache, said
  // `invisible: ['liba']`. Through the interface-CHA join the same shape moves a GATE: `deny Fs` exit 1
  // warm / exit 0 cold, red over a body that is not on disk.
  //
  // So re-run the fixpoint once against the swept cache. ONE extra pass suffices: a report file only
  // ever appears from a success, so a second sweep can find nothing the first did not — which is why
  // `dropUnanswered` is NOT called again (a call that can only ever return `[]` is a guard that costs
  // nothing, and this file does not keep those). Gated on something HAVING been dropped, so a clean
  // workspace pays nothing: same rounds, same spawns, byte-identical artifacts.
  // Same shape and same reason as candor-swift `43a0eaa`.
  const dropped = dropUnanswered(workspaceDepsDir, depPaths, answered, ownFiles, workspaceDepFileName, "--workspace");
  if (dropped.length) {
    // Disclosed, because it is the only channel that distinguishes the two gates: a reader who sees the
    // sweep line and NOT this one is looking at a run whose siblings still carry the swept answer.
    console.error(`candor-ts: --workspace re-ran the dependency fixpoint against the swept cache — a sibling that scanned cleanly may have chained ${dropped.sort().join(", ")} before the sweep, and its cached report would have kept that answer`);
    runRounds();
  }
  console.error(`candor-ts: --workspace chained ${names.size} workspace dep report(s), transitive${names.size ? ": " + [...names].sort().join(", ") : " (none found)"}`);
}
// ⟨dep initializers⟩ --dep-inits: importing a package RUNS its entry module, so the importer reaches
// whatever that initializer does — and with the module-import edge in place, a chained dep report resolves
// it exactly. The blocker was never analysis, it was that nobody had scanned the dependency. `node_modules`
// is on disk, so scan it: bounded to the packages this project actually imports AT TOP LEVEL (a bare
// specifier in an import/require at file scope), which is its direct dependency surface rather than the
// whole tree. Anything unresolvable or unscannable is skipped and stays exactly as it is today — the
// alternative, disclosing `Unknown` for every external import, measured at 60-100% of modules and would make
// the initializer unit uninformative (candor-spec SOUNDNESS-VEIN-initializer-edge.md).
// Opt-in: this spawns one child scan per direct dependency.
let depInitsDir = null;
if (wantDepInits) {
  const selfPath2 = fileURLToPath(import.meta.url);
  depInitsDir = path.join(rootDir, ".candor", "dep-inits");
  fs.mkdirSync(depInitsDir, { recursive: true });
  const SPEC_RE = /(?:^|\n)\s*(?:import\s[^;'"]*from\s*|import\s*|export\s[^;'"]*from\s*)['"]([^'"]+)['"]|(?:^|\n)[^\n]*\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  const wanted = new Set();
  for (const f of fileNames) {
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
      const seg = spec.split("/");
      wanted.add(spec.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0]);
    }
  }
  const scanned = [];
  const candidates = [];                      // the packages this run RESOLVED on disk — see `dropUnanswered`
  const answered = new Set(), ownFiles = new Set();
  for (const pkg of wanted) {
    let dir = null;
    for (let d = rootDir; ; d = path.dirname(d)) {
      const c = path.join(d, "node_modules", pkg);
      if (fs.existsSync(path.join(c, "package.json"))) { dir = c; break; }
      if (path.dirname(d) === d) break;
    }
    if (!dir) continue;                       // not installed, or a builtin/type-only import
    candidates.push(pkg);
    const file = depCacheFileName(depInitsDir, pkg);
    try {
      const out = execFileSync(process.execPath, [selfPath2, dir, "--json", "--allow-js"],
        { env: { ...process.env, CANDOR_WORKSPACE_CHAIN: "1" },
          maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      fs.writeFileSync(file, out);
      answered.add(pkg); ownFiles.add(file);
      scanned.push(pkg);
    } catch { /* a dep that fails to scan is skipped — see the ownership sweep below */ }
  }
  // The name is the package name the CONSUMER imports, which is what the writer above keys on, so the
  // derivation is the writer's own and has no second source to disagree with.
  dropUnanswered(depInitsDir, candidates, answered, ownFiles, (pkg) => pkg, "--dep-inits");
  console.error(`candor-ts: --dep-inits scanned ${scanned.length} of ${wanted.size} direct dependenc${wanted.size === 1 ? "y" : "ies"}${scanned.length ? ": " + scanned.sort().join(", ") : ""}`);
}
// CANDOR_DEPS (SPEC §2): sibling/dependency reports whose effects a call into that package
// inherits — the cross-package join the workspace probe measured as missing (trpc client → server:
// zero edges). The key is the report's `hash` (`package#LocalName` — derivable from BOTH a source
// scan and a .d.ts resolution). Version-aware trust (§2.1): a report from a DIFFERENT engine
// version is downgraded to Unknown rather than silently trusted. Duplicate hashes (two same-named
// exports in one package) UNION — a sound over-approximation, documented.
// ONE version source: package.json. A second hardcoded literal (the envelope's, the --agents
// banner's) that drifted from this would make the engine distrust its OWN reports at the §2.1
// staleness check (`d.candor?.version !== ENGINE_VERSION`), silently downgrading every chained dep.
const ENGINE_VERSION = `candor-ts-${PKG_VERSION}`;
const crossDeps = new Map(); // hash -> {inferred:Set, hosts:[], cmds:[], paths:[], tables:[]}
// Packages a loaded sibling report COVERS — exempt from the κ ledger even when a call joins no
// entry (reports omit pure functions: the silence is the purity claim, SPEC §2 rule 3 — the
// serde_json rule the Rust/JVM engines already carry; /code-review found TS missing it). Fed from
// the envelope's `package` field (works for an all-pure EMPTY report) and from entry hash prefixes.
const depCoveredPkgs = new Set();
// Packages whose ONLY chained report failed the §2.1 version check. Kept OUT of `depCoveredPkgs`, because a
// report the engine has decided not to trust cannot make a coverage claim on the package's behalf: §2 rule 3
// turns a report's SILENCE into a purity claim, and §2.1 exists to say this report's assertions are not ours
// to repeat. Before the split a stale report still registered coverage, so the keys it DID carry read
// `Unknown` (right) while every key it simply did not contain read PURE (wrong, and silent) — a cardinal sin
// licensed by an untrusted report. Now an unanswered key falls back to the κ ledger's `invisible: [pkg]`
// hedge, and an `import` backed only by a stale report discloses `Unknown` rather than nothing. This is the
// FORWARD half of the wire-key hazard written up at `depInitCell`: staleness downgrades the CONTENT of the
// keys a report carries and can never conjure one it lacks, so trusting its silence is what made a changed
// key shape read pure. Fires only on a version mismatch — a configuration the family already treats as
// invalid gate input (the AS-EFF-005 baseline guard says exactly that).
const staleDepPkgs = new Set();
// ⟨0.19⟩ For ONE chained report, the reason classes each unit's `Unknown` INHERITED from the units it
// calls — the half of the reason-class contract that lives underneath `4dad22d`. See the call site for the
// defect; this is the mechanism, and two properties of it are load-bearing:
//
// PER REPORT, never across. The keys here are `fn` quals (`src.c.origin`), which are report-local and
// collide freely between packages — two dependencies both shipping `src.index.helper` is ordinary. The
// cross-package key is the `hash`, and it is deliberately not what this walks: leaf-key joining across
// reports is the fabrication this whole vein exists to avoid.
//
// AT CLASS GRANULARITY, one representative reason per class rather than the transitive string set.
// Measured over 34 real dependency reports / 22 328 entries: 9 206 entries carry `Unknown` with no reason
// and 9 122 of them (99.1%) have one recoverable from `calls` — but the raw strings blow up to 458 on a
// single core-js unit, while the DISTINCT CLASSES never exceed 3 (8 097 entries reach exactly one class,
// 927 two, 98 three). The class is what `deny E Unknown[<class>]` quantifies over and what SPEC §4 makes
// normative; the raw detail is best-effort and stays with the unit that owns it, under its own hash. So a
// representative is truthful, bounded and sufficient — and picking the lexicographically smallest makes it
// deterministic, which a report diff depends on.
//
// Reverse-edge fixpoint rather than a per-entry walk: the relation is a union over a call graph that can
// cycle, and seeding from the units that HAVE a reason and pushing backwards terminates by monotonicity
// (each class's representative only ever decreases, over a finite string set) without a visited-set per
// query or a recursion depth.
function resolveInheritedWhy(entries) {
  // Nothing to propagate unless some unit both HAS a reason and is CALLED — the cheap exit for the common
  // report with no call edges at all.
  if (!entries.some((e) => (e.unknownWhy ?? []).length) || !entries.some((e) => (e.calls ?? []).length))
    return new Map();
  const callers = new Map();                       // callee qual -> the quals that call it
  for (const e of entries)
    for (const c of e.calls ?? []) {
      let list = callers.get(c);
      if (!list) { list = []; callers.set(c, list); }
      list.push(e.fn);
    }
  const byClass = new Map();                       // qual -> Map(reason class -> representative raw reason)
  const q = [];
  for (const e of entries) {
    if (!(e.unknownWhy ?? []).length) continue;
    const m = new Map();
    for (const w of e.unknownWhy) {
      const k = reasonClass(w);
      const cur = m.get(k);
      if (cur === undefined || w < cur) m.set(k, w);
    }
    byClass.set(e.fn, m);
    q.push(e.fn);
  }
  for (let head = 0; head < q.length; head++) {
    const src = byClass.get(q[head]);
    for (const up of callers.get(q[head]) ?? []) {
      let dst = byClass.get(up);
      if (!dst) { dst = new Map(); byClass.set(up, dst); }
      let changed = false;
      for (const [k, w] of src) {
        const cur = dst.get(k);
        if (cur === undefined || w < cur) { dst.set(k, w); changed = true; }
      }
      if (changed) q.push(up);
    }
  }
  const out = new Map();
  for (const [fn, m] of byClass) out.set(fn, [...m.values()].sort());
  return out;
}
// ⟨0.21⟩ Packages whose ONLY chained report DECLARES ITSELF INCOMPLETE — it carries a non-empty
// `unanalyzed`, i.e. it names source it could not analyze. Same door as `staleDepPkgs`, different key: a
// report says "these units were never derived", and §2 rule 3 then turns their ABSENCE from `functions`
// into a purity claim about exactly the code the report just said it never read. Measured before it was
// fixed: a dependency with one unparseable file scans to exit 0 and a report that still names its package,
// the consumer chains it, and a function calling the vanished declaration goes from
// `invisible:['deplib']` (unchained, the honest hedge) to ABSENT FROM THE REPORT — a ⟨0.21⟩ positive
// purity claim about a function that writes to the filesystem, with `deny Fs` at exit 0. The single-tree
// control over the SAME sources is exit 2 ("a gate cannot be green over unanalyzed code"), so chaining an
// incomplete report was strictly WORSE than not chaining it: the dependency's own scan refused to certify
// a gate over itself and the consumer certified one on its behalf.
//
// The treatment DIFFERS from staleness, and the difference is the whole point. A stale report's entries
// are assertions from a build we do not trust, so they are downgraded to `Unknown`. An incomplete report's
// entries were derived from source it DID analyze and are true — only its SILENCE is not a purity claim.
// So the entries are kept exactly as they are and only COVERAGE is withheld: strictly additive, an
// answered key still answers, an unanswered one falls back to the κ ledger's `invisible: [pkg]` hedge.
// Nothing is downgraded and no effect is ever removed.
const incompleteDepPkgs = new Set();
// ⟨0.24⟩ Packages whose ONLY chained report JUDGED NOTHING — `analyzed.count: 0`. The THIRD answer to the
// one question this door asks ("may this report's SILENCE speak?"), after staleness (§2.1, the report is
// not ours to repeat) and incompleteness (⟨0.21⟩, the report says it could not read some of its own
// source). Here the report is well-formed AND trusted AND complete; it simply judged no units at all, so
// there is nothing for its silence to be silent ABOUT.
//
// THE DEFECT, MEASURED ON THIS ENGINE BEFORE A LINE WAS WRITTEN (dep `hit()` reads /etc/hosts, app `go()`
// calls it, `deny Fs`):
//
//   unchained          go -> inferred: [], invisible: ['ratesdep'], coverage.uncovered, κ nudge   exit 0
//   trusted            go -> inferred: ['Fs']                                                     exit 1
//   count: 0   (pre)   go -> ABSENT FROM `functions`, no coverage, no verdict block, no nudge      exit 0
//
// — chaining a report that judged nothing bought a consumer MORE confidence than not chaining the package
// at all, which is the one thing a degraded report may never do. State the harm precisely: an empty report
// carries no effects, so this arm cannot itself TRIP a gate — it and the unchained arm both exit 0 on
// `deny Fs`, and the exit-1 flip exists only against the TRUSTED arm. What it DELETES is the DISCLOSURE:
// the per-fn `invisible` marker, the envelope's `coverage.uncovered`, the κ nudge on stderr and
// `--gate-json`'s coverage block, which is the machine-consumer channel. So the fix restores the
// DISCLOSURE, not the verdict — re-asserting `Fs` here would fabricate an effect the consumer has no
// evidence for. Conformance PART 26 measured the same door four-way and printed all four
// INDISTINGUISHABLE; this engine's waiver was the largest at 56 live cells ABSENT.
//
// THE WIRE ALREADY DISTINGUISHED THE TWO CASES AND NOTHING READ IT. `functions: []` is two completely
// different statements depending on one integer:
//
//   `analyzed.count: 0`   "I judged nothing here"            — an `export * from` facade package scans to
//                                                              exactly this. No unit was ever looked at,
//                                                              so absence carries no purity claim: NOT
//                                                              COVERED, exactly as if never chained.
//   `analyzed.count: n>0` "I judged n units, none effectful" — a positive all-pure claim SPEC §2 rule 3
//                                                              requires a consumer to BELIEVE: COVERED,
//                                                              and it MUST NOT be hedged.
//
// KEYED ON THE INTEGER, NEVER ON THE EMPTINESS OF `functions`, and the ratio is why that is not a style
// preference. Measured over 1997 deduplicated JVM dependency jars: 79 (4.0%) emit `count: 0` and only 6 of
// those actually granted coverage — but 104 (5.2%) are the LEGITIMATE all-pure kind. A fix keyed on
// emptiness would have withdrawn 104 real claims to catch 6: the plausible-but-wrong fix is MORE
// destructive than the defect it treats. The count-n arm is therefore carried in the test suite as an
// in-band control, and both prior engines report the same signature — hedging on emptiness fails the
// control WHILE THE COUNT-0 ROW STAYS GREEN, so the floor arm alone cannot catch it.
//
// TREATMENT follows the ⟨0.21⟩ incomplete arm, not the §2.1 stale one: entries untouched, only COVERAGE
// withheld, so this is strictly additive — it can add a hedge, never remove an effect. In the ordinary
// case a count-0 report has no entries to touch at all; the branch matters for the CONTRADICTORY report
// that claims zero while listing functions, where dropping its entries would be the mirror sin.
const unjudgedDepPkgs = new Set();
// ⟨0.24⟩ …AND THE FOURTH CONJUNCT: a chained report with a §2 key that is PRESENT BUT UNPARSEABLE (SPEC §2:
// "a reader that recovers from a type mismatch by substituting the default … the language's convenience
// default is the fail-open direction on every key in this format"). MEASURED on the ratesdep fixture below,
// `deny Fs`, against the two controls this file already carries:
//
//   unchained                go -> inferred: [], invisible: ['ratesdep'], coverage.uncovered   exit 0
//   trusted (whole report)   go -> inferred: ['Fs']                                            exit 1
//   `functions: "oops"`      go -> ABSENT FROM `functions`, no invisible, no coverage          exit 0
//   `functions: {}`          go -> ABSENT FROM `functions`, no invisible, no coverage          exit 0
//   entry `inferred: null`   go -> ABSENT FROM `functions`, no invisible, no coverage          exit 0
//   entry `inferred: "Fs"`   go -> inferred: ['F','s']                                         exit 0
//   entry `inferred: [7]`    go -> inferred: [7]                                               exit 0
//
// The first three rows are the count-0 defect arriving through a different key, and STRICTLY WORSE than not
// chaining at all: the caller drops out of `functions`, which under ⟨0.21⟩ is a positive purity claim, with
// none of the four disclosure channels the unchained arm produces. The last two are its fabrication mirror
// — a non-array `inferred` ITERATED INTO CHARACTERS and shipped to the consumer's own report as the effect
// set `['F','s']`, the exact bug `normFn` in query-core.mjs exists to prevent and which this loader,
// reading the same wire without going through it, reproduced.
//
// TREATMENT is the ⟨0.21⟩ incomplete arm's, for the same reason and with the same strictly-additive
// property: COVERAGE is withheld (so the silence stops speaking and the caller reads the unchained hedge),
// while the entries that ARE readable are joined untouched — dropping those would be the silent
// under-report this whole ladder exists to prevent. Only the UNREADABLE VALUES are dropped, so no effect
// that could be read is lost and no character-soup effect is invented. Ordered AFTER `incomplete` because
// a garbled `unanalyzed` is already caught there and "declares source it could not analyze" is the more
// specific remedy; before `judgedNothing`, which is the weakest claim of the four.
const corruptDepPkgs = new Set();
// The predicate itself is `claimsToHaveJudgedNothing` in query-core.mjs — SPEC §2's three-row table plus
// the fail-closed row it implies, kept in ONE place because `gate --report` must read the same integer the
// same way (§3.1 ⟨0.24⟩ puts the obligation on the reading, not on the route the report arrived by). The
// two rows that matter here: `analyzed` ABSENT with entries present is a pre-⟨0.21⟩ producer that judged
// something and said so the only way it could, so it KEEPS its coverage; `analyzed` present but garbled has
// made no claim, so it grants none.
{
  // --workspace's auto-scanned deps dir is prepended to the explicit CANDOR_DEPS/config spec (both chain).
  const spec = [workspaceDepsDir, depInitsDir, process.env.CANDOR_DEPS ?? candorConfig.deps ?? ""].filter(Boolean).join(":");
  const files = [];
  // ASCII WHITESPACE ONLY, the same rule as the config loader above and as java, rust and swift. JS
  // `\s` includes U+00A0, so a dep path holding a non-breaking space split into two halves — and since
  // ⟨0.27⟩ made an unresolvable dep token FATAL, that turned a path the other three engines load into a
  // hard exit 2 naming a truncated path the operator never wrote. The config loader was fixed and this
  // one, which every config-declared dep is also routed through, was not: one rule, two spellings.
  for (const tok of spec.split(DEP_SEPARATORS).filter(Boolean)) {
    try {
      if (fs.statSync(tok).isDirectory())
        for (const f of fs.readdirSync(tok)) if (f.endsWith(".json") && !f.endsWith(".callgraph.json") && !f.endsWith(".hierarchy.json") && !f.endsWith(".locs.json")) files.push(path.join(tok, f));
      if (fs.statSync(tok).isFile()) files.push(tok);
    } catch {
      // ⟨0.27⟩ SPEC §2: A CONFIGURED DEP THAT CANNOT BE READ IS UNEVALUABLE, NOT REDUCED COVERAGE.
      // Skipping it continued the run, and the caller of that dep then serialised `inferred: []` — a
      // ⟨0.21⟩ purity claim, published in the REPORT, about a function whose dependency the operator
      // configured precisely so it would not be one. This engine's note said only "skipped", so the
      // omission was not even qualified in the channel a human reads, let alone the artifact a chained
      // consumer reads. java and swift already refused; this engine and rust continued.
      console.error(`candor-ts: CANDOR_DEPS names ${tok} but it is not a readable file or directory — `
        + `failing (exit 2, unevaluable). A configured dep that is not there is not reduced coverage: `
        + `its callers would serialise \`inferred: []\`, which is a purity claim about code this scan `
        + `never saw. Scan that dependency, or remove it from the \`deps\` config / CANDOR_DEPS.`);
      // The TOKEN arm needed this too. The read and parse arms below were routed to the stream and this
      // one was not — three exits for one rule, two of them answered on the machine channel and one
      // silent, which a conformance row (PART 36 b8) caught immediately once the cause was posed at all.
      refuseEarlyToStream(`configured dependency ${tok} is not a readable file or directory`);
      process.exit(2);
    }
  }
  for (const f of files) {
    // ⟨0.27⟩ READ AND PARSE OUTSIDE THE TRY, because SPEC §2 binds them and the try was swallowing them.
    // The rule is one sentence — a configured dep path that "does not exist OR CANNOT BE READ MUST exit
    // 2, naming it" — and the 0.27 work implemented only the first half, at the token check above. A path
    // that resolved to a file which then failed to open, or held malformed JSON, was SKIPPED at exit 0,
    // and the caller of that dep serialised `inferred: []`: the ⟨0.21⟩ purity claim the token check
    // exists to prevent, reached by a different door.
    //
    // Found by the 0.27 go/no-go panel, which tested this engine's own changelog claim instead of
    // believing it. java and swift refused on both halves already; this and rust made the family 2-v-2
    // on a MUST. The surviving `catch` below still guards the PROCESSING of a well-formed document,
    // which is a different failure and stays a skip.
    let raw;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      console.error(`candor-ts: CANDOR_DEPS report ${f} could not be read —`);
      console.error(`        failing (exit 2, unevaluable). A configured dep this scan cannot read is not`);
      console.error(`        reduced coverage: its callers would serialise \`inferred: []\`, a purity claim`);
      console.error(`        about code this scan never saw.`);
      refuseEarlyToStream(`configured dependency report ${f} could not be read`);
      process.exit(2);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`candor-ts: CANDOR_DEPS report ${f} is not valid JSON —`);
      console.error(`        failing (exit 2, unevaluable). Same reason as an unreadable one: a report`);
      console.error(`        that cannot be parsed makes no claim, and continuing would publish one.`);
      refuseEarlyToStream(`configured dependency report ${f} is not valid JSON`);
      process.exit(2);
    }
    try {
      const d = parsed;
      // A report whose version can't be VERIFIED is not trusted (§2.1) — a missing header is as
      // untrustworthy as a mismatched one (the Rust engine's rule; the engines split on this).
      const stale = d.candor?.version !== ENGINE_VERSION;
      // ⟨0.21⟩ …and neither does one that names source it could not analyze (see `incompleteDepPkgs`).
      // Staleness is checked FIRST: a report we do not trust cannot be trusted about its own completeness
      // either, so its `unanalyzed` claim buys it nothing beyond the downgrade it already gets.
      // …and a MALFORMED manifest fails CLOSED. `Array.isArray(…) && length > 0` reads
      // `"unanalyzed": "oops"` and `"unanalyzed": {}` as COMPLETE, so a report that garbles its own
      // completeness claim bought the very coverage `21277eb` withheld from one that states it plainly —
      // the same door, reopened by a malformed key. This is the posture the file already takes on a
      // malformed `inferred` (untrustworthy ⇒ Unknown, never pure), and it matches java and rust
      // (candor-rust `dbab8be`), which is what stops `deny E Unknown[class]` answering differently per
      // engine. ABSENT and EMPTY are the two complete readings and they must both survive: the writer
      // OMITS the key when it has nothing to declare (see `envelope.unanalyzed` below), so reading
      // absence as incompleteness would withhold coverage from every ordinary report.
      const incomplete = !stale && d.unanalyzed !== undefined
        && !(Array.isArray(d.unanalyzed) && d.unanalyzed.length === 0);
      // ⟨0.24⟩ …and neither does one that judged NOTHING (see `unjudgedDepPkgs`). Ordered LAST of the
      // three because it is the weakest claim about the report: staleness says we may not repeat it,
      // incompleteness says it could not read its own source, and this says only that there is nothing in
      // it to repeat. A report that is stale AND count-0 is disclosed as stale, which is the more specific
      // remedy (re-scan with a matching build, not "point the scan at real sources").
      // ⟨0.24⟩ the fourth conjunct (see `corruptDepPkgs`) — a §2 key that is THERE and of the wrong shape.
      const corruptKeys = stale || incomplete ? [] : reportCorruptKeys(d);
      const corrupt = corruptKeys.length > 0;
      const judgedNothing = !stale && !incomplete && !corrupt && claimsToHaveJudgedNothing(d, d.functions);
      // COVERAGE IS ANCHORED TWICE — the envelope's `package` key AND each entry's `hash` prefix below —
      // so `covers` is chosen ONCE here and both anchors write through it. Gating one and not the other is
      // a no-op wearing a fix's clothes: an all-pure report carries the envelope key and no entries, and a
      // contradictory count-0-with-entries report carries the second and would have re-granted itself the
      // coverage the first withheld.
      const covers = stale ? staleDepPkgs : incomplete ? incompleteDepPkgs : corrupt ? corruptDepPkgs
                   : judgedNothing ? unjudgedDepPkgs : depCoveredPkgs;   // an untrusted, self-declared-incomplete, corrupt or unjudged report grants no coverage
      if (corrupt) console.error(`candor-ts: chained dependency report ${f} has ${corruptKeys.length} present-but-unparseable §2 key(s)`
        + ` — granted NO coverage, so calls into it read as INVISIBLE rather than pure (SPEC §2 ⟨0.24⟩): ${corruptKeys.join("; ")}`);
      if (typeof d.package === "string" && d.package) covers.add(d.package);
      // NEVER ITERATE AN UNREADABLE VALUE. `d.functions ?? []` walked the CHARACTERS of `functions: "oops"`,
      // and `strs()` is why `inferred: "Fs"` can no longer arrive at the consumer as the effect set
      // `['F','s']` — the `??` idiom only guards null/undefined, and every other wrong type in this format
      // is iterable or index-able into something that looks like data.
      const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
      const entries = Array.isArray(d.functions) ? d.functions : [];
      const inheritedWhy = stale ? new Map() : resolveInheritedWhy(entries);
      for (const e of entries) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.hash !== "string" || !e.hash) continue;
        // A CORRUPT ENTRY REGISTERS NO CELL. It is not enough to withhold the package's coverage: a cell
        // in `crossDeps` SHORT-CIRCUITS the ladder in `chargeExternalDecl` (`if (hit) { applyDepHit; return }`)
        // BEFORE the `depCoveredPkgs` check, so an entry whose `inferred` was dropped as unreadable would
        // hand the caller an EMPTY hit and return — the caller reads pure and never reaches the `invisible`
        // arm. Measured: with coverage withheld but the cell still registered, `go` came out ABSENT from
        // `functions` with no `invisible` and no `coverage.uncovered`. Skipping the cell lets the caller
        // fall through to exactly the ladder an UNCHAINED package takes. Per ENTRY, not per report, so a
        // report with one bad row still delivers every row that reads cleanly (strictly additive), and the
        // `continue` is placed before the `crossDeps.get` so a GOOD report's cell for the same hash — a
        // package chained twice — is never clobbered by the bad one.
        if (!stale && entryCorruptKeys(e).length) continue;
        const hashPkg = e.hash.split("#")[0];
        if (hashPkg) covers.add(hashPkg);
        const cell = crossDeps.get(e.hash) ?? { inferred: new Set(), invisible: new Set(), why: new Set(), hosts: [], cmds: [], paths: [], tables: [], netIncomplete: false };
        for (const x of stale ? ["Unknown"] : strs(e.inferred)) cell.inferred.add(x);
        // ⟨0.19⟩ THE REASON CLASS TRAVELS WITH THE UNKNOWN. Without this the join copied `inferred` and
        // `invisible` only, so a dependency's `Unknown[reflect:eval]` arrived at the consumer as a bare
        // Unknown and fell back to the generic `unresolved` — and `deny Net Unknown[reflect]`, a rule
        // written to bite exactly that hole, stopped biting one package boundary away. The ts sibling of
        // candor-java `6ab26e4`. A STALE report keeps the bare Unknown: its reasons are assertions from a
        // build we do not trust, and `unresolved` is the honest class for "we cannot say why".
        if (!stale) for (const w of strs(e.unknownWhy)) cell.why.add(w);
        // …AND THE CLASS OF AN UNKNOWN THE DEP UNIT ITSELF ONLY INHERITED. ⟨0.6⟩ makes `unknownWhy`
        // DIRECT-ONLY — required on a unit that introduces `Unknown`, absent on one that merely inherited
        // it — so a dependency's EXPORTED function publishes `inferred: ['Unknown']` with no reason at all
        // whenever the unresolvable call is one hop further in. The line above then has nothing to copy and
        // the consumer falls back to `unresolved`. `4dad22d` fixed "the join drops the reason"; this is the
        // half underneath it, "the producer never published one", and it is where the reason ratchet is
        // actually adopted: `deny Unknown[reflect]` is exit 1 single-tree and exit 0 chained, at ONE hop and
        // at two, while the bare `deny Unknown` fires throughout — so only the class-targeted middle reads
        // green. (Found by the java sweep, which reached it first; the mirror is real too — the class
        // DEGRADES to the catch-all, so `deny Unknown[unresolved]` is 0 single-tree and 1 chained.)
        //
        // No format rung and no producer change: the dependency's own `calls` edges already say which of
        // its units the Unknown came from, and that unit's `unknownWhy` is right there in the same report.
        // Resolving it HERE also keeps ⟨0.6⟩ intact at both ends — the producer still publishes a reason
        // only on a direct source, and at the consumer the joined Unknown IS direct (`applyDepHit` adds it
        // to `rec.direct`), which is the shape `4dad22d` established.
        // Applied to EVERY entry, not only the ones with no reason of their own — and restricting it to
        // those was standing-bar item 0 firing mid-implementation. The first fixture used a dep export
        // that inherits its Unknown and has NO direct reason, so it was structurally incapable of noticing
        // a unit that has one AND reaches a second class through its calls. Measured: a `pkgc#both` doing
        // `eval(k)` (its own `reflect:`) and calling a `callback:` unit carried only `reflect:`, and
        // `deny Unknown[indirect]` was exit 1 single-tree and exit 0 chained — the very defect this commit
        // closes, surviving in a narrower shape. In-scan the GATE accumulates reason classes over the call
        // graph (policy.mjs); across the boundary it cannot walk into the dependency, so the classes have
        // to travel in the cell or the accumulation stops at the package edge.
        if (!stale) for (const w of inheritedWhy.get(e.fn) ?? []) cell.why.add(w);
        // A chained dep's OWN blind boundary (an uncovered package IT calls into) travels to a consumer as
        // that consumer's `invisible` — the transitive disclosure the workspace chain exists to carry (a
        // sibling package's `SnsTopic.publish → invisible:[@aws-sdk/client-sns]` must not read pure across
        // the boundary). A stale report is already downgraded to Unknown above, so its blind is not trusted.
        if (!stale) for (const b of strs(e.invisible)) cell.invisible.add(b);
        if (!stale) for (const m of ["hosts", "cmds", "paths", "tables"])
          for (const v of strs(e[m])) if (!cell[m].includes(v)) cell[m].push(v);
        // ⟨0.20⟩ THE NET SURFACE'S INCOMPLETENESS TRAVELS WITH ITS HOSTS. `hosts` is a LOWER bound — the
        // producer marks a masked/hostless Net internally (`rec.incomplete`) and publishes that judgment as
        // `unknown-host` in `netClass`. The join copied the host LITERALS and not the judgment, so the
        // consumer re-derived `netClass` from a lower bound as if it were the whole surface: a dep entry
        // reading `netClass: ['known-telemetry','unknown-host']` arrived as `['known-telemetry']`, and
        // `deny Net[unknown-host]` — a rule whose entire job is to catch a destination candor cannot see —
        // went from exit 1 to exit 0 one package boundary along. Same shape as the ⟨0.19⟩ reason class two
        // lines up, one field over: a fail-CLOSED marker failing OPEN at the boundary. No format rung: the
        // dependency already published the answer under the hash the consumer joins.
        //
        // Read off `netClass` rather than an incompleteness field because `rec.incomplete` is deliberately
        // INTERNAL family-wide (java/rust keep it out of the report too) — `unknown-host` IS its wire form.
        // Carries ONLY the incompleteness, never the classes: `known-telemetry`/`known-partner` are facts
        // about the hosts already copied above, and re-deriving them from those literals is what keeps the
        // consumer's `netClass` a function of the surface it can see (the property `netClassesOf` exists to
        // hold). A stale report's assertions are not ours to repeat, and it contributes no Net at all.
        if (!stale && strs(e.netClass).includes("unknown-host")) cell.netIncomplete = true;
        crossDeps.set(e.hash, cell);
      }
    } catch { console.error(`candor-ts: CANDOR_DEPS report could not be processed, skipped: ${f}`); }
  }
  // A package chained TWICE — once fresh, once stale — is covered by the fresh report, so it is not a
  // stale-only package and must not pick up the disclosure below on top of a real answer.
  for (const p of depCoveredPkgs) staleDepPkgs.delete(p);
  // …and the same for completeness: a package chained twice, once complete and once not, IS covered by the
  // complete report. A COMPLETE report is a coverage claim on its own, so it must not inherit the other's
  // hedge — the same "must not pick up the disclosure on top of a real answer" rule one line up.
  for (const p of depCoveredPkgs) incompleteDepPkgs.delete(p);
  // ⟨0.24⟩ …and a package chained twice, once judged and once not, IS covered — the same rule a third
  // time, and here the argument is the strongest of the three: a count-0 report makes NO claim in either
  // direction, so it adds nothing to a report that judged something and subtracts nothing from it either.
  // Letting a report with no content withdraw another's earned purity claim is the mirror sin.
  for (const p of depCoveredPkgs) corruptDepPkgs.delete(p);
  for (const p of depCoveredPkgs) unjudgedDepPkgs.delete(p);
  if (staleDepPkgs.size)
    console.error(`candor-ts: ${staleDepPkgs.size} chained dependency report(s) were produced by a DIFFERENT engine build — `
      + `downgraded to Unknown and granted no coverage (§2.1): ${[...staleDepPkgs].sort().join(", ")}`);
  if (incompleteDepPkgs.size)
    console.error(`candor-ts: ${incompleteDepPkgs.size} chained dependency report(s) declare source they could not analyze `
      + `(\`unanalyzed\`) — entries kept, but granted no coverage, so a key they do not answer discloses instead of reading `
      + `pure: ${[...incompleteDepPkgs].sort().join(", ")}`);
  // Named on stderr for the same reason the two arms above are: the disclosure IS the fix, and a remedy is
  // named because `analyzed.count: 0` is nearly always a MIS-TARGETED scan (a facade package of re-exports,
  // an `--out` pointed at a directory with no sources) rather than a fact about the dependency.
  if (corruptDepPkgs.size)
    console.error(`candor-ts: ${corruptDepPkgs.size} chained dependency report(s) carry a §2 key that is PRESENT `
      + `but UNPARSEABLE (⟨0.24⟩ corrupt input is not an empty value) — granted no coverage, so calls into them `
      + `read as INVISIBLE rather than pure. Re-produce the report with a current engine: `
      + `${[...corruptDepPkgs].sort().join(", ")}`);
  if (unjudgedDepPkgs.size)
    console.error(`candor-ts: ${unjudgedDepPkgs.size} chained dependency report(s) judged NOTHING (⟨0.24⟩ `
      + `\`analyzed.count\` is 0, absent-with-no-functions, or unreadable) — a report with no judgment in it is `
      + `not an all-clear, so it grants NO coverage and its package stays in the κ ledger exactly as if it were `
      + `never chained: ${[...unjudgedDepPkgs].sort().join(", ")}`);
}

if (allowJs) { compilerOptions.allowJs = true; compilerOptions.checkJs = false; }
const program = ts.createProgram(fileNames, compilerOptions);
const checker = program.getTypeChecker();
const projectFiles = new Set(fileNames.map((f) => path.resolve(f)));
const sources = program.getSourceFiles().filter((f) => projectFiles.has(path.resolve(f.fileName)));

// ⟨0.21⟩ COMPLETENESS MANIFEST (Gap 2): the TARGET's own source candor could NOT analyze — a .ts that
// FAILED TO PARSE (a syntax error). getSyntacticDiagnostics() reports lexer/parser failures; the source
// was only PARTIALLY seen, so its effects are absent because unseen, NOT because pure. We disclose it to a
// MACHINE (report + gate verdict) so a green gate over it is impossible (a false-pure channel — matches
// the java reference + rust's had_parse_failure). Restrict to PROJECT files (not node_modules/libs — the
// scan doesn't analyze those). LinkedHashMap-style: disclosure order = discovery order, deduped by path.
const unanalyzedUnits = [];
{
  const seen = new Set();
  for (const diag of program.getSyntacticDiagnostics()) {
    const sf = diag.file;
    if (!sf) continue;
    const abs = path.resolve(sf.fileName);
    if (!projectFiles.has(abs) || seen.has(abs)) continue;
    seen.add(abs);
    unanalyzedUnits.push({ path: path.relative(rootDir, abs), reason: "source failed to parse" });
  }
  // The loud human channel (rust does this too): a green report must not quietly hide the incompleteness.
  if (unanalyzedUnits.length)
    console.error(`candor-ts: ${unanalyzedUnits.length} source file(s) failed to parse — NOT analyzed (see the report's \`unanalyzed\`); a gate cannot be green over unanalyzed code`);
}


// The module a declaration came from: a project file → "<local>", @types/node → the builtin name,
// node_modules/<pkg> → the package name, the ES lib → "<es-lib>".
function declModule(decl) {
  const f = path.resolve(decl.getSourceFile().fileName);
  if (projectFiles.has(f)) return "<local>";
  // `(.+?)` not `(\w+?)`: a SUBPATH typing (`@types/node/fs/promises.d.ts`, `dns/promises.d.ts`) carries
  // a `/` that `\w` can't cross, so the module collapsed to `@types/node` (via the node_modules branch
  // below) and the `fs(\/promises)?` / `dns(\/promises)?` κ rules — written to cover exactly these — could
  // never fire (`fs/promises` is the dominant modern Node FS API: a silent-pure under-report). Keep the
  // slash so the module reads `fs/promises`, which the rules match.
  let m = f.match(/@types\/node\/(.+?)\.d\.ts$/);
  if (m) return m[1];
  if (/typescript\/lib\/lib\..*\.d\.ts$/.test(f)) return "<es-lib>";
  m = f.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
  if (m) {
    // `@types/X` (DefinitelyTyped) provides types for the RUNTIME package X — map it to X so the curated κ
    // tier (keyed by the runtime name: pg/ws/…) fires. Without this a package typed via @types resolved to
    // "@types/pg", the `pg`→Db rule never matched, and the resolved-but-unmodeled external decl read
    // SILENT-PURE — `pool.query()` in a real TS Postgres app (which MUST have @types/pg installed to use
    // pg) reported pure (found by a node_modules corpus run). Scoped runtime pkgs use the `__` convention:
    // `@types/babel__core` → `@babel/core`.
    const tm = m[1].match(/^@types\/(.+)$/);
    if (tm) return tm[1].includes("__") ? "@" + tm[1].replace("__", "/") : tm[1];
    return m[1];
  }
  // WORKSPACE-SYMLINK: a monorepo dep (`@ukri-tfs/message-handling`) is symlinked into node_modules, so its
  // .d.ts resolves to its REAL path (`…/packages/message-handling/dist/…`) with NO `node_modules/` segment —
  // the node_modules regex misses and the raw absolute path leaked as the module name (an unmatchable κ key
  // AND an ugly `invisible:[/abs/path]`; the cross-package chain never joined). Walk up to the nearest
  // package.json and use its `name` — the same identity the dep's own report hashes under. (Found dogfooding
  // ukri-tfs: `channels.X.publish()` on a symlinked `OutboundChannel` never matched the chained report.)
  const wsName = nearestPackageName(f);
  if (wsName) return wsName;
  return f;
}
// Nearest `package.json` `name` at or above a file — memoized per directory. For workspace-symlinked deps
// whose real path has no `node_modules/` segment (declModule above).
const pkgNameCache = new Map();
function nearestPackageName(file) {
  let dir = path.dirname(file);
  const seen = [];
  while (dir && dir !== path.dirname(dir)) {
    if (pkgNameCache.has(dir)) { const v = pkgNameCache.get(dir); for (const d of seen) pkgNameCache.set(d, v); return v; }
    seen.push(dir);
    try {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const name = (JSON.parse(fs.readFileSync(pj, "utf8")).name) || null;
        for (const d of seen) pkgNameCache.set(d, name);
        return name;
      }
    } catch { /* unreadable package.json — keep climbing */ }
    dir = path.dirname(dir);
  }
  for (const d of seen) pkgNameCache.set(d, null);
  return null;
}
// Does reaching this declaration CROSS A PACKAGE BOUNDARY the scan cannot see into? This is the gate on
// every κ-ledger / `invisible` disclosure arm (the unmodeled-external-call, the `new ExternalClass()`, the
// external tagged template). It used to be spelled `/node_modules\//.test(file)` — true only of an
// INSTALLED-COPY dependency. A monorepo WORKSPACE dep is a SYMLINK, and the checker resolves it to its
// REAL path (`…/packages/depkit/dist/index.d.ts`) with no `node_modules/` segment, so every disclosure arm
// silently declined to fire: a symlinked sibling package produced NO disclosure at all — no `invisible`,
// no `coverage.uncovered`, no stderr advisory — while the PUBLISHED-package shape of the SAME code
// disclosed correctly (candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md, "ts, monorepo shape").
// That is the worst form: in a monorepo every cross-package reach read confidently pure until someone
// remembered `--workspace`. `declModule` already resolves such a file to its package NAME through
// `nearestPackageName`; this asks the same question for the disclosure gate.
//
// Exclusions preserved exactly: the two builtin trees (`@types/node`, `typescript`) stay out, and so does
// the scan's OWN package — a file of ours the scan simply didn't include (our own `dist/` typings, a
// `types/` dir outside the target) is not a foreign package and must not make us blind to ourselves.
// A file under no package.json at all resolves to no name and stays out, as before.
//
// "our own package" is BOTH `pkgName` and `rootOwnerPkg`, because they differ: `pkgName` falls back to the
// directory basename when the target has no package.json of its own (`candor-ts ./src`), which would make
// the enclosing package look foreign to itself and disclose us as blind to our own code.
const rootOwnerPkg = nearestPackageName(path.join(rootDir, "_"));
function crossesPackageBoundary(file) {
  if (/node_modules\//.test(file)) return !/node_modules\/(@types\/node|typescript)\//.test(file);
  const own = nearestPackageName(file);
  return !!own && own !== pkgName && own !== rootOwnerPkg;
}

// ⟨0.19⟩ The bare-package ROOT of an import specifier: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`,
// a relative/absolute path → null (not a package). Used to match an import against `declaredButUninstalled`.
function pkgRoot(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null;
  const seg = spec.split("/");
  return spec.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0];
}

// ⟨0.19⟩ The import module a call's HEAD identifier binds to (`winston.info()` → head `winston`; `chalk()` →
// `chalk`) via its import declaration — resolvable even when the package ISN'T installed, because the import
// statement is syntactically present in the local file. Mirrors the specifier extraction at the κ seam.
// Returns the bare-package root, or null when the head isn't an imported binding.
function importPkgOfHead(expr) {
  let head = expr;
  while (head && ts.isPropertyAccessExpression(head)) head = head.expression;
  if (!head || !ts.isIdentifier(head)) return null;
  const sym = checker.getSymbolAtLocation(head);
  for (const d of sym?.declarations ?? []) {
    let spec = null;
    if (ts.isNamespaceImport(d)) spec = d.parent?.parent?.moduleSpecifier;
    else if (ts.isImportClause(d)) spec = d.parent?.moduleSpecifier;              // default import
    else if (ts.isImportSpecifier(d)) spec = d.parent?.parent?.parent?.moduleSpecifier; // named import
    if (spec && ts.isStringLiteralLike(spec)) return pkgRoot(spec.text);
  }
  return null;
}

// SPEC §5.1 — the effect manifest. An uncurated package MAY declare its effect surface in its
// package.json (`"candorEffects": ["Net"]`), read as the declared-not-verified tier: it kills the
// silent pure/blind-spot the package would otherwise carry, exactly like a cap type (and unlike
// candor's own analysis, which is checked). A name outside §1 VOIDS the declaration loudly — a typo
// must never silently narrow a surface. Cached per package. `file` is the resolved declaration source.
const EFFECT_VOCAB = new Set(["Net", "Fs", "Db", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard", "Llm"]);
const _manifestCache = new Map();
// Returns the declared effect array (possibly EMPTY — `[]` is an explicit "declared pure", covered, not
// a blind spot), or `null` for no/invalid declaration (still a blind spot). A name outside §1 voids the
// declaration loudly; a non-array `candorEffects` is malformed and warned.
function packageManifestEffects(file) {
  const m = file && file.match(/^(.*\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))\//);
  if (!m) return null;
  let dir = m[1];
  // A manifest read from an `@types/<pkg>` directory is a TRUST-BOUNDARY HOLE: the @types stub is a
  // type-only package published by DefinitelyTyped/anyone — NOT the effect-owning package. Honoring its
  // `candorEffects` let an attacker's `@types/realpkg` declare `[]` to SILENCE the real realpkg's effects
  // AND its κ-ledger disclosure (defeating the spec's "a missing manifest is visible via κ" safety net).
  // Redirect to the REAL package's own dir, whose author controls it (`@types/babel__core` → `@babel/core`,
  // `@types/foo` → `foo`); if that has no manifest, it stays an honest κ-ledger blind spot, never silenced.
  const at = dir.match(/^(.*\/node_modules\/)@types\/([^/]+)$/);
  if (at) {
    const real = at[2].includes("__") ? "@" + at[2].replace("__", "/") : at[2];
    dir = at[1] + real;
  }
  if (_manifestCache.has(dir)) return _manifestCache.get(dir);
  let result = null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).candorEffects;
    if (Array.isArray(d)) {
      const bad = d.filter((e) => !EFFECT_VOCAB.has(e));
      if (bad.length) console.error(`candor-ts: ${path.basename(dir)} candorEffects has an invalid effect '${bad[0]}' — declaration voided (SPEC §1)`);
      else result = d; // a valid declaration, including [] = declared pure
    } else if (d !== undefined) {
      console.error(`candor-ts: ${path.basename(dir)} candorEffects must be an array of §1 effect names — ignored`);
    }
  } catch { /* no/unreadable manifest → undeclared */ }
  _manifestCache.set(dir, result);
  return result;
}

// ---- the literal surfaces (SPEC §2 hosts/cmds/paths/tables): the statically-decidable subset ------
// Read ONLY from string literals at a classified call — informative, never complete, never inferred.
function firstStringLiteral(node) {
  for (const a of node.arguments ?? []) {
    if (ts.isStringLiteralLike(a)) return a.text;
  }
  return null;
}

// Is this property/element access a SETTER target reached through a destructuring assignment —
// `({ k: x.prop } = src)` or `[x.prop] = arr` (sweep [32])? Walk up through PropertyAssignment /
// Object|ArrayLiteral wrappers to the enclosing `=`; it is a target only when the wrapping literal is the
// LHS (`.left`) of the assignment. A property access on the RHS (`src = { k: x.prop }`) walks to a literal
// that is `.right`, so it stays a getter READ — no false setter attribution.
function isDestructuringAssignTarget(node) {
  let cur = node, parent = node.parent;
  while (parent) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === cur) { cur = parent; parent = parent.parent; continue; }
    if (ts.isShorthandPropertyAssignment(parent)) return false; // `{prop}` has no access node to attribute
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) { cur = parent; parent = parent.parent; continue; }
    if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) { cur = parent; parent = parent.parent; continue; }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return parent.left === cur;
    return false;
  }
  return false;
}

// The literal PROGRAM head a subprocess call NAMES — argv[0] specifically, never a later argument.
// Unlike firstStringLiteral (the first literal ANYWHERE in the args), this refuses to refine when
// the program (arg0) is a runtime value but a trailing arg is a literal whose basename hits the head
// table: `spawn(toolVar, "curl")` must NOT fabricate Net — the literal is an argument, not the
// program (spec §4 ⟨0.5⟩: the head is argv[0]). Mirrors candor-java programHeadLiteral and the Rust
// is_cmd_naming_method gate. Returns null when arg0 is not a static string literal — the safe
// direction. Used ONLY for the effect refinement, never to widen it; the cosmetic `cmds` surface
// keeps firstStringLiteral.
function programHeadLiteral(node) {
  const a0 = (node.arguments ?? [])[0];
  return a0 && ts.isStringLiteralLike(a0) ? a0.text : null;
}
// The URL/endpoint literal of a host-bearing Net call, read from the DOCUMENTED URL arg position — a host
// predicate must run against the extracted URL argument, never the first literal ANYWHERE in the args:
// `fetch(runtimeUrl, "some-literal")` must NOT read the trailing literal (headers/body/options) as the
// host (the programHeadLiteral discipline, generalized from Exec to Net — FINDING 6). Position is
// member-aware: the HTTP verbs (fetch/get/post/put/patch/delete/head/options/request) take the URL FIRST;
// net.connect/createConnection put the host at arg1 in the `(port, host)` overload (and arg0 is a path/
// options in the other overloads) — so those two members read arg0-or-arg1. Only STRING-LITERAL positions
// are considered; returns null when the URL slot is not a static string literal — the safe direction.
const NET_URL_ARG1_MEMBERS = new Set(["connect", "createConnection"]);
// CONST-STRING PROPAGATION (java constant-inlining parity): resolve a bare identifier that references a
// `const NAME = "literal"` string to its literal value, and ONLY then. Returns the string, or null. The
// soundness rule is strict: resolve ONLY when EVERY value-declaration of the symbol is an immutable
// `const` (or a `readonly` field) whose initializer is a plain string literal. A `let`/`var` (reassignable),
// a declaration with no string-literal initializer (runtime value, function result, env read, config field,
// concatenation, another template), or a symbol with MORE than the string-literal decls we can see → null,
// so the call stays bare/runtime as before. NEVER guess a value we cannot read off a `const` initializer.
function constStringValue(expr) {
  if (!ts.isIdentifier(expr)) return null;
  const sym = checker.getSymbolAtLocation(expr);
  const decls = sym?.declarations ?? [];
  if (decls.length === 0) return null;
  let resolved = null;
  for (const d of decls) {
    // A `const x = "..."` variable declaration, or a `readonly x = "..."` class/property field. Both are
    // VariableDeclaration/PropertyDeclaration nodes with an initializer; the immutability gate differs.
    if (ts.isVariableDeclaration(d)) {
      // the enclosing VariableDeclarationList must be `const` — a `let`/`var` can be reassigned later.
      const list = d.parent;
      const isConst = list && ts.isVariableDeclarationList(list)
        && (list.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst || !d.initializer || !ts.isStringLiteral(d.initializer)) return null;
      if (resolved != null && resolved !== d.initializer.text) return null; // conflicting decls — bail
      resolved = d.initializer.text;
    } else if (ts.isPropertyDeclaration(d)) {
      const isReadonly = (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) !== 0;
      if (!isReadonly || !d.initializer || !ts.isStringLiteral(d.initializer)) return null;
      if (resolved != null && resolved !== d.initializer.text) return null;
      resolved = d.initializer.text;
    } else {
      return null; // any other declaration shape (function, param, import alias, …) → do not resolve
    }
  }
  return resolved;
}
// Resolve a URL ARGUMENT EXPRESSION to a statically-known URL/host string when its HOST is anchored by a
// `const NAME = "literal"` string (java constant-inlining parity). Three shapes, all requiring the host to
// live at the HEAD of the value:
//   • a bare const identifier            fetch(API_BASE)             → API_BASE's value
//   • a template whose HEAD is a const   fetch(`${API_BASE}/chat`)   → value + the literal template tail
//   • a concat whose LEFT is a const     fetch(API_BASE + "/chat")   → value + the right literal
// The template tail / concat right are appended ONLY when they are themselves plain literals, so the
// returned string is a real static URL prefix `hostLiteral` can parse (`https://host/…`). A template with a
// literal host-bearing PREFIX before the interpolation (`\`https://${h}\``) has a non-empty template HEAD, so
// its head is NOT a const identifier → not resolved here (and the literal prefix alone never named a full
// host). Anything else (non-const identifier, interpolation of a runtime value, nested template) → null.
function resolveConstUrlString(expr) {
  if (expr == null) return null;
  // bare identifier: fetch(API_BASE)
  const bare = constStringValue(expr);
  if (bare != null) return bare;
  // template literal `${HEAD_CONST}<tail literal>`: the const value must sit at the HEAD (empty template
  // head text), and we may only append a SINGLE trailing literal span — a second `${…}` interpolation is a
  // runtime value we will not resolve, but it only follows the host, so the host prefix is still sound.
  if (ts.isTemplateExpression(expr)) {
    if (expr.head.text !== "") return null;              // literal prefix before the const → not const-anchored
    const first = expr.templateSpans[0];
    const head = first && constStringValue(first.expression);
    if (head == null) return null;                       // first interpolation is not a const string
    // append the literal text between the first interpolation and the next (or end) — the URL path segment.
    return head + (first.literal.text ?? "");
  }
  // string concat `CONST + "…"`: left must be a const string; append the right ONLY if it is a plain literal.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constStringValue(expr.left);
    if (left == null) return null;
    const right = ts.isStringLiteralLike(expr.right) ? expr.right.text : "";
    return left + right;
  }
  return null;
}
// Does a literal URL-head string already contain a COMPLETE authority — i.e. is there a `/` AFTER the
// `://` still WITHIN the literal text? `https://api.openai.com/v1/` → yes (host fully present, only the
// PATH follows); `https://api.` / `https://` / `https://api.openai.com:` → no (the authority is not yet
// terminated, so an interpolation could still be part of the host/port). Requires a `scheme://` prefix;
// a bare relative path never qualifies.
function literalHeadCompletesAuthority(head) {
  const m = head.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (!m) return false;                          // no scheme://… → authority not started in the literal
  return head.indexOf("/", m[0].length) >= 0;    // a `/` after the `://` terminates the authority
}
// LITERAL-HEAD HOST EXTRACTION (java literal-inlining parity): a template `\`https://host/${path}\`` or a
// concat `"https://host/" + path` whose FIRST STATIC segment (the text before the first interpolation /
// the concat's left literal) ALREADY contains a complete `scheme://authority/…` carries a statically-known
// host — the interpolation is only in the PATH. Return that literal head (a real URL prefix `hostLiteral`
// parses to the authority). If the head does NOT terminate the authority with a `/` (`https://${h}/x`,
// `https://api.${x}.com/y`, `https://host:${port}/y`, `https://api.openai${x}/v1`) the interpolation could
// be part of the host/port → return null (safe under-report: stays bare Net). Distinct from
// resolveConstUrlString, which anchors on a CONST identifier at the head; here the head is a plain LITERAL.
function literalHeadHostUrl(expr) {
  if (expr == null) return null;
  // template `\`<head>${…}…\``: the literal head is expr.head.text (empty when the interpolation leads).
  if (ts.isTemplateExpression(expr)) {
    const head = expr.head.text;
    return literalHeadCompletesAuthority(head) ? head : null;
  }
  // concat `"<left literal>" + <anything>`: only the LEFT operand's literal text is the static head; the
  // right is a runtime value living in the path. (A nested `"a" + "b" + x` left is a BinaryExpression, not
  // a string literal, so it is not read here — a safe under-report, not a fabrication.)
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken
      && ts.isStringLiteralLike(expr.left)) {
    const head = expr.left.text;
    return literalHeadCompletesAuthority(head) ? head : null;
  }
  return null;
}
function urlArgLiteral(node, member) {
  const args = node.arguments ?? [];
  const litAt = (i) => {
    const a = args[i];
    if (!a) return null;
    if (ts.isStringLiteralLike(a)) return a.text;
    // const-anchored host (fetch(API_BASE), `${API_BASE}/x`, API_BASE+"/x"), THEN literal-head extraction
    // (`\`https://host/${p}\``, `"https://host/" + p`) when the literal head already completes the authority.
    return resolveConstUrlString(a) ?? literalHeadHostUrl(a);
  };
  if (member && NET_URL_ARG1_MEMBERS.has(member)) return litAt(0) ?? litAt(1); // (port, host) or (path)
  return litAt(0);
}
// Is arg0 a RUNTIME STRING expression whose host can't be known statically — a template, a string
// concat, or a `string`-typed variable/member/call? Only THIS shape masks the host and must fail the
// surface closed. A STRUCTURED url arg (`new URL(...)`, a `Request` object, any non-string value) carries
// its host in a form the literal gate never saw, but it did not mask a literal that WAS there — pre-Llm
// behavior added Net and moved on, so it must NOT regress to fail-closed. Absent arg0 → not a masking
// string either (never fabricate incompleteness). A static string literal is handled by urlArgLiteral, so
// it is excluded here.
function urlArgIsRuntimeString(node) {
  const a0 = (node.arguments ?? [])[0];
  if (!a0 || ts.isStringLiteralLike(a0)) return false;
  if (ts.isTemplateExpression(a0)) return true; // `${base}/path` — host built at runtime
  if (ts.isBinaryExpression(a0) && a0.operatorToken.kind === ts.SyntaxKind.PlusToken) return true; // concat
  // a variable/member/call arg: a masking runtime host only when its static type is `string` (a
  // `new URL()`/`Request`/other object is NOT a string type — leave it clean, as before the Llm port).
  const t = checker.getTypeAtLocation(a0);
  return t ? (t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0 : false;
}
// The Ollama local-endpoint decision (java Literals parity #2), routed through the EXTRACTED host, never
// a raw literal that merely CONTAINS ":11434". `urlLit` is arg0's string text; `host` is hostLiteral(urlLit)
// (null when arg0 didn't parse as a structured host/URL). Returns "capture" (a dotted model/Ollama host
// hostLiteral kept — the caller captures it and adds modelHostEffects), "llm-no-capture" (a DOTLESS
// `localhost:11434`/`127.0.0.1:11434` — refine to Llm but do NOT capture the host as a Net allowlist
// literal, so the host gate stays intact: java parity #2), or null (no model signal). CRITICAL: the
// :11434 → Llm rule fires ONLY when arg0 parsed as a STRUCTURED host:port whose port is 11434 — a raw
// relative path like `/v1/models:11434/generate` never parses as a host, so it can never fabricate Llm.
function isDotlessLocalOllama(host) {
  if (host == null) return false;
  const colon = host.lastIndexOf(":");
  if (colon < 0 || host.slice(colon + 1) !== "11434") return false;
  const hostPart = host.slice(0, colon).toLowerCase();
  return hostPart === "localhost" || hostPart === "127.0.0.1"; // dotless local endpoint only
}
function ollamaFromUrlArg(urlLit) {
  if (urlLit == null) return null;
  // Parse arg0 as a host[:port] the same way the capture path does. `scheme://host[:port]/…` yields the
  // authority even when the host is dotless; a bare `foo.internal:11434` yields itself; a relative path
  // (`/v1/x:11434/y`) parses to NOTHING → never a host, so it can never fabricate Llm (FINDING 1).
  const parsed = hostLiteral(urlLit);
  if (parsed == null) return null;
  // FINDING 9: a DOTLESS local Ollama endpoint (`http://localhost:11434/…`) refines to Llm WITHOUT
  // capturing the host as a Net allowlist literal (java parity #2 — preserve the host gate). A DOTTED
  // model/Ollama host (`foo.internal:11434`, `api.anthropic.com`) is captured as before.
  if (isDotlessLocalOllama(parsed)) return "llm-no-capture";
  return isModelHost(parsed) ? "capture-model" : "capture-plain";
}
// qualifies by the file's basename (`Cases.union_a`).
const fns = new Map();           // qualified name -> { direct, edges, hosts, tables, cmds, paths, loc }
const unlistedSeen = new Map();  // the κ-coverage ledger: unlisted npm package -> call-site count
const nodeName = new WeakMap();  // declaration node -> qualified name
// ORM table declarations: `@Entity("user")` on a class maps that class to its table — the JVM's
// read-the-declarations move (TypeORM tables live in decorators, not SQL strings, so the `tables`
// surface couldn't fire on the most common TS app shape). LITERAL decorator arg only; a no-arg
// `@Entity()` (naming-strategy-dependent) contributes nothing — never a guess.
const entityTables = new Map();    // ClassDeclaration node -> table name
const interfaceImpls = new Map();  // InterfaceDeclaration node -> implementing ClassDeclarations (CHA universe)
// The bound on an interface CHA fan-out, shared by the in-scan dispatch site and the `interfaceUnion`
// entries a chained consumer resolves through. Past it an OPEN hierarchy may have an implementer the scan
// never saw, so its visible union is an open-world guess and both sites report `Unknown` instead. It is
// one constant on purpose: the two sites disagreeing is exactly the defect the union rung shipped with —
// rxjs's `Operator` has 70 implementers, so rxjs's OWN `operator.call` reads
// `Unknown[dispatch:…Operator.call]` while its published report offered a chained consumer
// `rxjs#Operator.call -> ['Net','Unknown']`, the union of all 70. (The java sibling is `429c7b2`; its
// `isClosedHierarchy` carve-out has no TS analogue — there is no `sealed`, so no hierarchy is provably
// complete — and `closedWorldResolvable` is deliberately not copied, since asserting the scanned classes
// are the whole world is exactly what publishing for a chained consumer contradicts.)
const CHA_FANOUT_LIMIT = 12;
// How many `.d.ts` files the published-typings census will walk before giving up. It is a COST bound, not a
// soundness one — the union emitter refuses to publish anything at all once it is hit, because a census
// that stopped early cannot prove an interface name is unique in the package (see `typingsRoots`). Named
// rather than inlined for the reason `CHA_FANOUT_LIMIT` was: two literals for one rule is how they drift.
const TYPINGS_CENSUS_CAP = 128;
const classOverrides = new Map();// base-method MemberDeclaration node -> overriding subclass member nodes (class-CHA)
const classDescendants = new Map();// base ClassDeclaration -> transitive LOCAL subclass ClassDeclarations (coercion-CHA)
// `Object.defineProperty(target, key, { get/set })` runtime accessors (the silent-pure defineProperty
// hole): the TS checker types `target.key` as a plain DATA property (defineProperty is a runtime
// construct), so `accessorAt` finds no get-accessor and the forcing site `target.key` reads
// silent-pure. We index, keyed by the TARGET's symbol → key string → { get, set } descriptor function
// node, every such accessor seen in the project. The forcing-site arm consults this when the type-level
// accessor resolution comes up empty (precise edge when target+key resolve; else honest Unknown).
const definePropAccessors = new Map(); // targetSymbol -> Map(key -> { get?: fnNode, set?: fnNode })
// A descriptor accessor with a COMPUTED key (`Object.defineProperty(o, k, {get})`) on a RESOLVABLE
// target: the target symbol is known but the key isn't, so a forcing site `o.anything` MIGHT hit it. We
// record the target symbol → kinds present, and disclose Unknown at any access onto that target whose
// type-level / precise-key resolution missed — never silent-pure (matching the syntactic object-literal-
// getter posture). A descriptor whose TARGET itself is unresolvable can't be tied to any forcing site;
// its unit is still minted (effects classified, callgraph-visible), and there is nothing more to disclose.
const definePropDynamicKey = new Map(); // targetSymbol -> Set("get"|"set")
// Resolve `extends X` to X's LOCAL ClassDeclaration (through an import alias), or null. Module-level
// so both the class-CHA INDEX (below) and the dispatch site's RECEIVER-SUBTREE scoping share one
// definition of the local inheritance edge.
function localBaseClassOf(cls) {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const t = h.types?.[0];
    if (!t) continue;
    let sym = checker.getSymbolAtLocation(t.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
    const bd = (sym?.declarations ?? []).find((d) => ts.isClassDeclaration(d));
    if (bd && projectFiles.has(path.resolve(bd.getSourceFile().fileName))) return bd;
  }
  return null;
}
// Is `cls` in the subtree rooted at `root` (i.e. cls === root, or cls transitively `extends` root
// through LOCAL classes)? Used to scope a base-member override fan-out to the RECEIVER's static type
// — a sibling subclass's override lives OUTSIDE this subtree and must not contaminate the verdict.
function classInSubtree(cls, root) {
  let cur = cls, guard = 0;
  while (cur && guard++ < 64) {
    if (cur === root) return true;
    cur = localBaseClassOf(cur);
  }
  return false;
}
// node:stream PROVIDED-method → the subclass's `_`-prefixed impl override (R32 — the node sibling of
// the Writer/Reader vein). A Writable's public `.write()`/`.end()` drive the user's `_write`/`_writev`/
// `_final`/`_transform`/`_flush`; a Readable's `.read()` drives `_read` — INSIDE node core (invisible),
// so a CUSTOM effectful stream impl reached ONLY via the public API read silent-pure. The base is matched
// SYNTACTICALLY (a canonical stream-base name that is NOT a local class), so it resolves WITHOUT
// @types/node installed; a local `class Writable` shadows (never a false positive on project code).
const STREAM_BASES = new Set(["Writable", "Readable", "Duplex", "Transform", "PassThrough"]);
const STREAM_WRITE_DRIVERS = new Set(["write", "end"]);
const STREAM_READ_DRIVERS = new Set(["read"]);
const STREAM_WRITE_IMPL = ["_write", "_writev", "_final", "_transform", "_flush"];
const STREAM_READ_IMPL = ["_read"];
function classExtendsNodeStream(cls) {
  let cur = cls, guard = 0;
  while (cur && guard++ < 64) {
    for (const h of cur.heritageClauses ?? []) {
      if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      const t = h.types?.[0];
      const expr = t?.expression;
      if (!expr) continue;
      const baseName = ts.isIdentifier(expr) ? expr.text
        : ts.isPropertyAccessExpression(expr) ? expr.name.text : null; // `stream.Writable`
      if (baseName && STREAM_BASES.has(baseName)) {
        let sym = checker.getSymbolAtLocation(expr);
        if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
        const localDecl = (sym?.declarations ?? []).find((d) =>
          ts.isClassDeclaration(d) && projectFiles.has(path.resolve(d.getSourceFile().fileName)));
        if (!localDecl) return true; // an EXTERNAL stream base of a canonical name — a project class of that name shadows
      }
    }
    cur = localBaseClassOf(cur); // climb LOCAL bases; the external stream base is caught above
  }
  return false;
}
// The local `_write`/`_read`/… override unit(s) a node-stream driver method reaches on `recv`'s class,
// or [] (a non-stream receiver, an external stream, or no local override → contributes nothing).
function streamImplOverrides(recv, method) {
  const wantWrite = STREAM_WRITE_DRIVERS.has(method);
  const wantRead = STREAM_READ_DRIVERS.has(method);
  if (!wantWrite && !wantRead) return [];
  const rt = checker.getTypeAtLocation(recv);
  const cls = (rt?.symbol?.declarations ?? []).find((d) =>
    ts.isClassDeclaration(d) && projectFiles.has(path.resolve(d.getSourceFile().fileName)));
  if (!cls || !classExtendsNodeStream(cls)) return [];
  const want = wantWrite ? STREAM_WRITE_IMPL : STREAM_READ_IMPL;
  const out = [];
  let cur = cls, guard = 0;
  while (cur && guard++ < 64) {
    for (const mem of cur.members ?? []) {
      if ((ts.isMethodDeclaration(mem) || ts.isPropertyDeclaration(mem)) && mem.name
          && want.includes(mem.name.getText())) {
        const un = nodeName.get(mem);
        if (un) out.push(un);
      }
    }
    cur = localBaseClassOf(cur);
  }
  return out;
}
function moduleOf(sf) {
  const rel = path.relative(rootDir, path.resolve(sf.fileName)).replace(/\.[mc]?[tj]sx?$/, "");
  return rel.split(path.sep).join(".");
}
// Enclosing `namespace`/`module` blocks are NAME SEGMENTS (the family ruling: §6.2 scope segments
// split on the same boundaries as the §3.1 query name ladder, and a namespace is a segment — rust
// modules and swift enum-namespaces already qualify this way). A unit declared in
// `export namespace app { … }` is `mod.app.fn`, so a layer policy authored against namespace layers
// (`forbid app -> repo`, `deny Db app`) bites in TS instead of being silently inert. Returns the
// dotted prefix ("app." / "a.b.") or "". Dotted (`namespace a.b`) and nested forms both contribute
// each identifier segment; ambient string-named modules (`declare module "x"`) and `declare global`
// augmentations contribute nothing (not lexical layers of THIS module).
function namespacePrefixOf(node) {
  const segs = [];
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (!ts.isModuleBlock(p)) continue;
    // `namespace a.b { … }` nests ModuleDeclarations (a -> b -> block); walk the chain so every
    // dotted segment lands, innermost-first up.
    for (let d = p.parent; d && ts.isModuleDeclaration(d); d = ts.isModuleDeclaration(d.parent) ? d.parent : null) {
      if (d.name && ts.isIdentifier(d.name) && !(d.flags & ts.NodeFlags.GlobalAugmentation))
        segs.unshift(d.name.text);
    }
  }
  return segs.length ? `${segs.join(".")}.` : "";
}
// Is `node` (a function-expression / method-declaration / arrow) the `get` or `set` member of an
// accessor DESCRIPTOR object passed to `Object.defineProperty(target, key, desc)` /
// `Object.defineProperties(target, { key: desc, … })` / `Object.create(proto, { key: desc, … })`?
// Returns { kind:"get"|"set", targetExpr, keyText } when so (keyText is null for a non-literal key),
// or null. Only an accessor (`get`/`set`) descriptor qualifies — a `value:` (data) descriptor is NOT
// a function-property-named get/set, so it never matches (no fabrication on data props). The descriptor
// member may be `get(){}` (method), `get: function(){}` / `get: () => {}` (property-assignment): both
// have a parent PropertyAssignment-or-MethodDeclaration whose name is the identifier `get`/`set`.
function definePropertyAccessor(node) {
  let memberName = null, propParent = null;
  const p = node.parent;
  if (!p) return null;
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isObjectLiteralExpression(node.parent)) {
    // `{ get(){…} }` / `{ get x(){…} }` — but a real get/set-accessor here is the SYNTACTIC object
    // literal getter (already handled honestly); only a plain METHOD named `get`/`set` is a descriptor
    // member. A GetAccessor/SetAccessor inside a descriptor object is not how defineProperty descriptors
    // are written, so restrict to a method whose name is literally `get`/`set`.
    if (ts.isMethodDeclaration(node)) { memberName = node.name?.getText?.(); propParent = node; }
  } else if (ts.isPropertyAssignment(p) && p.initializer === node && ts.isObjectLiteralExpression(p.parent)) {
    memberName = p.name?.getText?.(); propParent = p;
  }
  if (memberName !== "get" && memberName !== "set") return null;
  const descObj = ts.isMethodDeclaration(propParent) ? propParent.parent : propParent.parent; // ObjectLiteral
  // Two shapes for the enclosing call:
  //   defineProperty(target, key, descObj)        — descObj is arg #2
  //   defineProperties(target, { key: descObj })  — descObj is a property value of arg #1
  //   create(proto, { key: descObj })             — descObj is a property value of arg #1
  const callOf = (n) => {
    let c = n.parent;
    while (c && !ts.isCallExpression(c)) c = c.parent;
    return c;
  };
  // Walk out at most: descObj -> (its parent is either the defineProperty call's arg, OR a
  // PropertyAssignment in a properties-map -> ObjectLiteral -> defineProperties/create call).
  const fnName = (call) => call && call.expression && call.expression.getText().replace(/\s+/g, "");
  // Case A: descObj is the 3rd argument of Object.defineProperty(target, key, descObj).
  if (descObj.parent && ts.isCallExpression(descObj.parent)) {
    const call = descObj.parent;
    if (fnName(call) === "Object.defineProperty" && call.arguments[2] === descObj) {
      const keyArg = call.arguments[1];
      const keyText = keyArg && ts.isStringLiteralLike(keyArg) ? keyArg.text : null;
      return { kind: memberName, targetExpr: call.arguments[0], keyText };
    }
    return null;
  }
  // Case B: descObj is a property value in a properties-map for defineProperties / create.
  if (descObj.parent && ts.isPropertyAssignment(descObj.parent)
      && ts.isObjectLiteralExpression(descObj.parent.parent)) {
    const keyProp = descObj.parent;            // `key: descObj`
    const propsMap = descObj.parent.parent;    // `{ key: descObj, … }`
    const call = callOf(propsMap);
    const fn = fnName(call);
    if (call && (fn === "Object.defineProperties" || fn === "Object.create")
        && (call.arguments[1] === propsMap)) {
      const keyText = ts.isStringLiteralLike(keyProp.name) ? keyProp.name.text
        : ts.isIdentifier(keyProp.name) ? keyProp.name.text : null;
      // For defineProperties the target is arg0. For create the NEW object IS the call's result; the
      // forcing site reads it through the binding the call is assigned to (`const o = Object.create(…)`),
      // so the stable target is that VariableDeclaration's name. When create's result isn't bound to a
      // simple identifier, there's no joinable target — targetExpr stays null (unit still minted; the
      // unpinnable marker drives the Unknown disclosure, never silent-pure).
      let targetExpr = null;
      if (fn === "Object.defineProperties") targetExpr = call.arguments[0];
      else if (fn === "Object.create" && call.parent
               && ts.isVariableDeclaration(call.parent) && call.parent.initializer === call
               && ts.isIdentifier(call.parent.name))
        targetExpr = call.parent.name;
      return { kind: memberName, targetExpr, keyText };
    }
  }
  return null;
}
// `_lastCjs` is set by markCjs when localName() returns a CJS export-surface name, read right after
// the call to tag THAT unit (spec 0.5 draft unitKind: "export"). Keyed to the unit, not a project-
// wide name set — a same-named ordinary TS function in another file must NOT be mislabeled.
let _lastCjs = false;
const markCjs = (v) => { if (v) _lastCjs = true; return v; };
function localName(node) {
  _lastCjs = false;
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${node.name.getText()}`;
  // GET/SET ACCESSORS are units too — a property read/assignment that resolves to one edges here, so
  // an accessor body that does I/O classifies normally instead of being a SILENT-PURE hole (and its
  // effect is no longer misattributed to the enclosing class's synthesized ctor, which `enclosing()`
  // would otherwise pick as the nearest unit). get/set are DISTINCT units (a class may have both for
  // one name): `Class.get raw` / `Class.set raw`, mirroring how the checker keeps them apart.
  if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${ts.isGetAccessorDeclaration(node) ? "get" : "set"} ${node.name.getText()}`;
  // `const f = (…) => …` / `const f = function (…) {…}` at any binding site — the dominant style in
  // real TS (rimraf's whole API is arrow consts; the first dogfood analyzed 0 of 50 files without
  // this). The VARIABLE name is the function's name; nodeName is ALSO set on the initializer so a
  // resolved call (whose sig.declaration is the arrow itself) finds the same qualified name.
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    return node.name.text;
  // CLASS ARROW-PROPERTY methods (`private readonly onError = (e) => …`) — the event-handler idiom.
  // Without this they were not units AT ALL: no callgraph key (a §2.2 violation), body never walked
  // (a silent-pure hole — worse than Unknown), found by the PROVE-IT dogfood on got, where the
  // request pipeline's error handlers live in exactly this form.
  if (ts.isPropertyDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    return `${node.parent.name.text}.${node.name.getText()}`;
  // Constructors are units too (`new X()` edges to `X.constructor`): a constructor that wires
  // effectful state (got's Request reassigns this.flush to an effectful closure in its ctor) was
  // invisible — same dogfood.
  if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.constructor`;
  // `Object.defineProperty(target,"key",{ get(){…}/set(){…} })` descriptor accessors — the runtime
  // accessor the TS checker can't see as a get/set (it types target.key as a data prop). Mint the
  // descriptor body as a UNIT so its effects classify normally instead of being a silent-pure hole;
  // the forcing-site arm edges target.key to it. Name keyed by target + key + kind so the same name a
  // forcing site computes joins here. Both shapes (`get(){}` method, `get:fn` property) land here.
  {
    const da = definePropertyAccessor(node);
    if (da) {
      const tn = da.targetExpr ? da.targetExpr.getText().replace(/\s+/g, "") : "<create>";
      const key = da.keyText ?? `[computed@${node.getStart()}]`;
      return `defineProperty(${tn}).${da.kind} ${key}`;
    }
  }
  // CJS export units (--allow-js, the npm half of report chaining): dist JS exports through
  // assignment, not declarations, so `module.exports = function …` / `exports.foo = …` /
  // `module.exports = { sign: fn }` were not units at all — a dep scan of jsonwebtoken yielded 4
  // shallow fns with the package's whole API invisible. The unit name mirrors what a CONSUMER's
  // resolution lands on: the fn's own name, the exported property, or the file's basename (the
  // `require('./sign')` shape).
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node) {
      const lhs = p.left.getText().replace(/\s+/g, "");
      if (lhs === "module.exports")
        return markCjs((ts.isFunctionExpression(node) && node.name?.text)
          || path.basename(node.getSourceFile().fileName).replace(/\.[mc]?jsx?$/, ""));
      const m = lhs.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
      if (m) return markCjs(m[1]);
    }
    if (ts.isPropertyAssignment(p) && p.initializer === node && ts.isObjectLiteralExpression(p.parent)) {
      const g = p.parent.parent;
      if (ts.isBinaryExpression(g) && g.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && g.right === p.parent && g.left.getText().replace(/\s+/g, "") === "module.exports")
        // .text, not getText(): a string-literal key keeps its quotes under getText, minting a
        // hash like pkg#"sign" the consumer's pkg#sign join can never hit (/code-review).
        return markCjs(p.name.text ?? p.name.getText());
    }
  }
  return null;
}
// True when `node` is lexically inside a FUNCTION body — so its bare local name can collide with a
// module-level or sibling-scope unit of the same name (see the qual disambiguation below). A namespace/
// module block and the source file are NOT function scopes (their members are top-level units).
function isFunctionScoped(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isSourceFile(p) || ts.isModuleBlock(p)) return false;
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)
        || ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)
        || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
      return true;
  }
  return false;
}
for (const sf of sources) {
  const mod = moduleOf(sf);
  (function collect(node) {
    // Every NAMED class gets a `Class.constructor` unit (synthesized when the ctor is implicit):
    // FIELD INITIALIZERS execute at construction (the JVM model — field inits belong to the ctor),
    // so their call sites need a unit to attribute to; without one, `class C { x = fs.readFileSync(…) }`
    // with an innocent explicit ctor was a SILENT-PURE hole (found chasing zod's Unknown profile).
    // The ClassDeclaration itself maps to the ctor unit, so `new C()` with an implicit ctor edges
    // there, and C passed AS A VALUE resolves as a callback target.
    if (ts.isClassDeclaration(node) && node.name) {
      for (const dec of ts.getDecorators?.(node) ?? []) {
        const e = dec.expression;
        if (ts.isCallExpression(e) && e.expression.getText() === "Entity"
            && e.arguments.length > 0 && ts.isStringLiteralLike(e.arguments[0]))
          entityTables.set(node, e.arguments[0].text);
      }
      // The interface-CHA universe (the Rust engine's local-trait move): `class PgStore
      // implements Store` is the edge a `store.save()` dispatch on the INTERFACE type resolves
      // through. Local interfaces only — flagging the lib.dom/lib.es surfaces would flood.
      // Register `node` (the class) under a LOCAL interface declaration AND its transitive SUPER-interfaces:
      // a `s.base()` on a `Sub`-typed value resolves `base` to whichever super-interface DECLARES it, so
      // `class Impl implements Sub` (where `interface Sub extends Sup`) must be in Sup's CHA universe too —
      // else the super-method dispatch read disclosed-`Unknown` instead of the precise impl (R47, the ts
      // sibling of the rust/swift supertrait dispatch). Cycle-guarded; local interfaces only.
      const registerImpl = (iface) => {
        if (!interfaceImpls.has(iface)) interfaceImpls.set(iface, []);
        const arr = interfaceImpls.get(iface);
        if (!arr.includes(node)) arr.push(node);
      };
      const localInterfaceDecls = (typeExpr) => {
        const sym = checker.getSymbolAtLocation(typeExpr);
        const tgt = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
        return (tgt?.declarations ?? []).filter((d) =>
          ts.isInterfaceDeclaration(d) && projectFiles.has(path.resolve(d.getSourceFile().fileName)));
      };
      const climbSeen = new Set();
      const climb = (iface) => {
        if (climbSeen.has(iface)) return;
        climbSeen.add(iface);
        registerImpl(iface);
        for (const eh of iface.heritageClauses ?? []) {
          if (eh.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const st of eh.types) for (const sdecl of localInterfaceDecls(st.expression)) climb(sdecl);
        }
      };
      for (const h of node.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        // Register under EVERY declaration of the interface symbol: a merged interface (two `interface
        // Store` blocks / module augmentation) resolves a method to whichever block declares it, and keying
        // only declarations[0] silently missed the others (/code-review).
        for (const t of h.types) for (const idecl of localInterfaceDecls(t.expression)) climb(idecl);
      }
      const ctorQual = `${mod}.${namespacePrefixOf(node)}${node.name.text}.constructor`;
      if (!fns.has(ctorQual)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
        fns.set(ctorQual, { local: `${node.name.text}.constructor`, direct: new Set(), fsKinds: new Set(), edges: new Set(),
                            hosts: new Set(), tables: new Set(), cmds: new Set(), paths: new Set(),
                            blind: new Set(), incomplete: new Set(), why: new Set(), entry: false,
                            loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}`,
                            endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
      }
      nodeName.set(node, ctorQual);
    }
    const n = localName(node);
    const isCjsExport = _lastCjs; // captured immediately: localName set it for THIS node only
    if (n) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      // Disambiguate FUNCTION-SCOPED local function units by position. A `const persist = () => …` (or a
      // nested `function persist(){}`) inside a fn body shares the bare `mod.name` key with a module-level
      // OR sibling-scope unit of the same name, so the second `fns.set` CLOBBERS the first and a call that
      // resolves (correctly, via the checker) to the LOCAL decl reads the OTHER unit's effects off the
      // shared entry — FABRICATING them onto a pure caller. `nodeName` is keyed by NODE identity, so a
      // per-node-unique key keeps resolution exact; only TOP-LEVEL units need the stable bare name a
      // consumer's hash-join targets (a function-scoped local is never an export, so nothing joins to it).
      // Namespace segments go in the QUAL only; `local` (and so the §2 hash `pkg#local`) stays the
      // bare name — a consumer's cross-package join resolves the callee's own name, never the
      // producer's namespace nesting, so widening the hash would break report chaining.
      const nsp = namespacePrefixOf(node);
      const qual = isFunctionScoped(node) ? `${mod}.${nsp}${n}#${line + 1}:${character + 1}` : `${mod}.${nsp}${n}`;
      fns.set(qual, { local: n, direct: new Set(), fsKinds: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
                      cmds: new Set(), paths: new Set(), blind: new Set(), incomplete: new Set(), why: new Set(), entry: false, isCjsExport,
                      loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}`,
                      endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
      nodeName.set(node, qual);
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer)
        nodeName.set(node.initializer, qual);
      // Index a `Object.defineProperty` descriptor accessor by its target SYMBOL + key, so a forcing
      // site `target.key` (which the checker types as a plain data prop) can edge to this unit. When
      // the target/key can't be pinned to a static symbol/literal, the unit still exists (named above)
      // but no precise edge is possible — record an UNRESOLVED marker so an access onto such a target
      // is disclosed Unknown rather than silently dropped.
      const da = definePropertyAccessor(node);
      if (da) {
        const tsym = da.targetExpr ? checker.getSymbolAtLocation(da.targetExpr) : null;
        if (tsym && da.keyText !== null) {
          if (!definePropAccessors.has(tsym)) definePropAccessors.set(tsym, new Map());
          const byKey = definePropAccessors.get(tsym);
          if (!byKey.has(da.keyText)) byKey.set(da.keyText, {});
          byKey.get(da.keyText)[da.kind] = node;
        } else if (tsym) {
          // computed key on a known target — any access onto this target may hit it: disclose Unknown.
          if (!definePropDynamicKey.has(tsym)) definePropDynamicKey.set(tsym, new Set());
          definePropDynamicKey.get(tsym).add(da.kind);
        }
        // (a wholly-unresolvable target leaves only the minted unit — nothing to join a forcing site to.)
      }
    }
    ts.forEachChild(node, collect);
  })(sf);
}

// Class-CHA universe (the override half of the Rust engine's local-trait / bounded-CHA move): a
// method call on a BASE-class-typed receiver resolves statically to the base method, but a SUBCLASS
// may override it with an effectful body — `class Dog extends Animal { speak(){ fs.readFileSync() } }`.
// Without fanning out to the override, `a.speak()` on an `Animal`-typed `a` comes back concrete-PURE
// (a silent-pure soundness hole, strictly worse than Unknown). We index, for every LOCAL base-class
// member, the overriding members in its LOCAL subclasses (walking the full `extends` chain so a
// grand-subclass override is attributed to the right ancestor declaration). The dispatch site (below)
// edges to the base PLUS these overrides, bounded by the same ≤12 family limit the interface path
// uses, with the same allResolved honesty gate. Local subclasses only (an external base/override
// surface stays OPAQUE, never fabricated). Mirrors interfaceImpls' merged-decl posture.
{
  const memberName = (m) => (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)
    || ts.isSetAccessorDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name?.getText?.();
  const baseClassOf = localBaseClassOf;
  for (const sf of sources) {
    (function scan(node) {
      if (ts.isClassDeclaration(node)) {
        // Local-DESCENDANT index (the coercion-CHA universe, below). classOverrides is keyed by an
        // ANCESTOR MEMBER, so it only sees an override whose base ALSO declares the name. The coercion
        // protocol's members are the opposite shape: `class Sub extends Base { toString(){…} }` where
        // `Base` declares NO toString (it inherits the pure `Object.prototype.toString`) has no
        // classOverrides entry at all, yet a `Base`-typed operand can be a `Sub` at runtime and run its
        // effectful toString. Index every local class under each of its local ancestors so
        // coercionTargets can fan out over the receiver's subtree.
        for (let anc = localBaseClassOf(node), guard = 0; anc && guard++ < 64; anc = localBaseClassOf(anc)) {
          if (!classDescendants.has(anc)) classDescendants.set(anc, []);
          const arr = classDescendants.get(anc);
          if (!arr.includes(node)) arr.push(node);
        }
        for (const m of node.members ?? []) {
          const name = memberName(m);
          if (!name) continue;
          // Walk the base chain; register this subclass member as an override of the NEAREST
          // ancestor member of the same name (one edge per (name) — TS forbids two declarations of
          // one accessor-kind/method on a class, so the first match up the chain is the override
          // target). Stop after the first ancestor declares the name: that is the unit a base-typed
          // dispatch lands on; higher ancestors are reached transitively via their own override edges.
          let base = baseClassOf(node), guard = 0;
          while (base && guard++ < 64) {
            const ancestor = (base.members ?? []).find((x) => memberName(x) === name
              && (ts.isMethodDeclaration(x) === ts.isMethodDeclaration(m))
              && (ts.isGetAccessorDeclaration(x) === ts.isGetAccessorDeclaration(m))
              && (ts.isSetAccessorDeclaration(x) === ts.isSetAccessorDeclaration(m)));
            if (ancestor) {
              if (!classOverrides.has(ancestor)) classOverrides.set(ancestor, []);
              classOverrides.get(ancestor).push(m);
              break;
            }
            base = baseClassOf(base);
          }
        }
      }
      ts.forEachChild(node, scan);
    })(sf);
  }
}

// callback-flow bookkeeping (the Rust engine's callback_named move, ported): for every call that
// edges to a LOCAL unit, record what each argument position received — a NAMED local unit (a
// resolvable callback target), or an opaque value (an inline closure stays attributed to the
// passer; a variable/property could be anything). A function that invokes a callback PARAMETER
// then resolves to the named targets IF every call site passed one — else honest Unknown.
const callbackArgs = new Map();    // calleeName -> Map(argIndex -> {targets:Set, opaque:boolean})
const paramInvokes = new Map();    // fnName -> Set(paramIndex) — this fn calls its own parameter

// ── entry points (SPEC §2 `entryPoint`): runtime-invoked roots the framework calls — their
// effects are never orphaned even with no in-project caller. Two populations for now:
// Nest HTTP handler decorators, and Next.js route-handler/middleware exports.
const HTTP_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Head", "Options"]);
const HTTP_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
for (const sf of sources) {
  const base = path.basename(sf.fileName).replace(/\.[mc]?[tj]sx?$/, "");
  (function mark(node) {
    const qual = nodeName.get(node);
    if (qual) {
      const rec = fns.get(qual);
      // Nest: a method carrying @Get()/@Post()/… is invoked by the framework router.
      for (const dec of ts.getDecorators?.(node) ?? []) {
        const e = dec.expression;
        const dn = ts.isCallExpression(e) ? e.expression.getText() : e.getText();
        if (HTTP_DECORATORS.has(dn)) rec.entry = true;
      }
      // Next: app-router route handlers (exported GET/POST/… in a `route` file) and middleware.
      const leaf = rec.local.split(".").pop();
      if (base === "route" && HTTP_EXPORTS.has(leaf)) rec.entry = true;
      if (base === "middleware" && leaf === "middleware") rec.entry = true;
    }
    ts.forEachChild(node, mark);
  })(sf);
}

// Resolve a use-site symbol through its IMPORT ALIAS to the real declaration: at `new X()` /
// `f(callback)` the symbol is the ImportSpecifier, not the class/function it names — without this,
// imported classes never edged to their ctor units and imported callback targets read opaque.
function realDecl(sym) {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch {}
  }
  return sym.valueDeclaration ?? sym.declarations?.[0];
}

// Resolve a value-reference NODE (`expr` in `expr.call(…)`/`expr.apply(…)`) to the qualified name of the
// FUNCTION UNIT it ultimately denotes — following ONE OR MORE local-variable aliases. The `.call`/`.apply`
// arm lands on the es-lib member so `getResolvedSignature` never sees the real fn; for a direct identifier
// (`effectful.call`) `realDecl` → the fn decl → a minted unit. But `const m = effectful; m.call(…)` resolves
// `m` to its VARIABLE declaration, whose initializer is the bare identifier `effectful` — the variable node
// itself is NOT a minted unit (only var-decls whose initializer is an arrow/fn-expr are), so the edge was
// dropped → silent-pure (the cardinal sin). Here we chase the variable's initializer identifier/member to
// the function it aliases. Returns the unit name, or null if the chain can't be pinned to a function unit.
// Bounded depth guards a pathological `const a=b, b=a` cycle. NO fabrication: a non-fn binding (or any link
// that doesn't resolve to a minted fn unit) returns null and the caller adds nothing / discloses Unknown.
function resolveFnRefUnit(refNode, depth = 0) {
  if (!refNode || depth > 8) return null;
  if (!ts.isIdentifier(refNode) && !ts.isPropertyAccessExpression(refNode)) return null;
  const d = realDecl(checker.getSymbolAtLocation(refNode));
  if (!d) return null;
  // Already a minted unit (the function itself, an arrow/fn-expr const, a class method/property)?
  const direct = nodeName.get(d);
  if (direct) return direct;
  // A local variable / parameter bound to a function reference — follow the initializer alias.
  if ((ts.isVariableDeclaration(d) || ts.isBindingElement(d) || ts.isParameter(d)) && d.initializer
      && (ts.isIdentifier(d.initializer) || ts.isPropertyAccessExpression(d.initializer)))
    return resolveFnRefUnit(d.initializer, depth + 1);
  return null;
}

// Unwrap a `<ref>.bind(…)` partial-application chain to the underlying function-reference RECEIVER.
// `setTimeout(this.flush.bind(this), 0)` / `effFs.bind(null)` / `cb.bind(null,a).bind(null,b)` schedule the
// BOUND function, but the argument node is a CallExpression (callee = PropertyAccessExpression `.bind`), so
// the HOF-ref arm — which only edges identifier / property-access args — dropped it (silent-pure: the
// cardinal sin). `.bind` is the third reflective-invoke member alongside `.call`/`.apply`. Given an arg
// node, returns:
//   { ref }     — it IS a `.bind` chain and the root receiver is a resolvable id/property-access ref
//                 (recursing through chained `.bind().bind()`); the caller resolves it to its fn unit.
//   { ref:null }— it IS a `.bind` chain but the root receiver is NOT a plain ref (`getCallback().bind(null)`,
//                 a parenthesized/`any` holder) — still INVOKED by the HOF, so the caller discloses Unknown.
//   null        — not a `.bind` call at all; the caller's id/property-access path handles it.
// A `.bind` on a PURE fn resolves to a pure unit (no fabrication); the bind-unresolvable case never goes
// silent-pure.
function unwrapBind(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== "bind") return null;
  let recv = node.expression.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  // chained `.bind().bind()` — recurse only when the receiver is ITSELF a `.bind` call, else it's an
  // arbitrary call (`getCallback().bind`) whose result we can't pin → unresolvable bind.
  if (ts.isCallExpression(recv)) {
    const inner = unwrapBind(recv, depth + 1);
    return inner ?? { ref: null };
  }
  return { ref: (ts.isIdentifier(recv) || ts.isPropertyAccessExpression(recv)) ? recv : null };
}

// Accessor resolution (the silent-pure-accessor fix): a property READ (`x.raw`) or property
// ASSIGNMENT target (`x.path = v`) may resolve to a getter/setter whose body performs effects. We
// resolve the property-name symbol to its declarations and look for an accessor of the matching
// kind (get for a read, set for an assignment LHS). Returns { decl, local } where `local` is true
// when the accessor's declaration lives in a project file (a UNIT we minted; edge to it). A resolved
// accessor we CAN'T see (external/typed-only declaration) returns local:false so the caller follows
// the existing Unknown/curated-κ posture — never silent-pure for a resolved-but-unseen accessor.
// A property SYMBOL → its accessor declaration of the wanted kind (or null). `local` is true when that
// declaration lives in a project file (a unit we minted; edge to it). Shared by every property-read
// shape: dot access, element access, and object destructuring.
function accessorFromSym(sym, kind /* "get" | "set" */) {
  if (!sym) return null;
  const want = kind === "get" ? ts.isGetAccessorDeclaration : ts.isSetAccessorDeclaration;
  // A symbol is an accessor only if its declarations include an accessor of the wanted kind.
  const decl = (sym.declarations ?? []).find((d) => want(d));
  if (!decl) return null;
  return { decl, local: projectFiles.has(path.resolve(decl.getSourceFile().fileName)) };
}
function accessorAt(propNode, kind /* "get" | "set" */) {
  let sym;
  if (ts.isElementAccessExpression(propNode)) {
    // `c["prop"]` carries no `.name`; resolve the LITERAL key as a property on the receiver's type.
    // A dynamic key (`c[k]`) can't be pinned to one property — leave it unresolved (the existing
    // dynamic-access posture stands; resolving it would guess, never fabricate here).
    const arg = propNode.argumentExpression;
    sym = arg && ts.isStringLiteralLike(arg)
      ? checker.getTypeAtLocation(propNode.expression)?.getProperty?.(arg.text)
      : null;
  } else {
    sym = checker.getSymbolAtLocation(propNode.name ?? propNode);
  }
  return accessorFromSym(sym, kind);
}
// A `Object.defineProperty` descriptor accessor for the forcing site `recv.key` (read → get, assign →
// set), consulted ONLY when the type-level `accessorAt` came up empty (the checker types target.key as
// a data prop, so defineProperty accessors are invisible to it). Resolve the receiver expression to its
// binding symbol and the key to a static string; look both up in `definePropAccessors`. Returns the
// descriptor function NODE (a minted unit) when found, or null. NO fabrication: a data (`value:`)
// descriptor was never indexed, an absent target/key returns null.
function definePropForceTarget(propNode, kind /* "get" | "set" */) {
  if (definePropAccessors.size === 0) return null;
  let recvExpr, keyText;
  if (ts.isElementAccessExpression(propNode)) {
    recvExpr = propNode.expression;
    const arg = propNode.argumentExpression;
    keyText = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  } else if (ts.isPropertyAccessExpression(propNode)) {
    recvExpr = propNode.expression;
    keyText = propNode.name?.getText?.();
  } else return null;
  if (keyText == null) return null;
  // Resolve the receiver to the SAME symbol the defineProperty target identifier resolved to. Follow an
  // import alias so a cross-module `import { config }` access joins the defining module's index entry.
  const rsym0 = checker.getSymbolAtLocation(recvExpr);
  if (!rsym0) return null;
  const rsym = rsym0.flags & ts.SymbolFlags.Alias ? (() => { try { return checker.getAliasedSymbol(rsym0); } catch { return rsym0; } })() : rsym0;
  const byKey = definePropAccessors.get(rsym) ?? definePropAccessors.get(rsym0);
  const entry = byKey?.get(keyText);
  return entry?.[kind] ?? null;
}
// Record a resolved accessor HIT (read or write) as an edge from `owner`: into the accessor UNIT when
// it's a local declaration we minted; otherwise Unknown (a resolved-but-unseen accessor body — never
// silent-pure, SPEC §4). `label` tags the §-why disclosure.
function recordAccessorHit(owner, hit, label) {
  const rec = fns.get(owner);
  const t = nodeName.get(hit.decl);
  if (hit.local && t) {
    rec.edges.add(t); // (EDGE) into the accessor unit — effects propagate
  } else {
    rec.direct.add("Unknown");
    rec.why.add(`reflect:accessor:${label}`); // a defineProperty runtime accessor (descriptor get/set unseen) — metaprogramming, canonical `reflect:`
  }
}

// Object PROPERTY-ENUMERATION (`{...obj}`, `const {...rest} = obj`, `Object.assign(t, obj)`): copying an
// object's own enumerable props INVOKES each source getter — the whole-object analog of `obj.prop`,
// invisible to the property-access arm (no PropertyAccess node per key). Edge `owner` to every LOCAL
// getter on the source type. A rest/spread can't name one key, so ALL getters are enumerated (sound
// over-approximation); a plain prop resolves to no accessor and adds nothing (no fabrication).
function enumerateGetters(owner, type) {
  if (!owner || !type || !type.getProperties) return;
  for (const p of type.getProperties()) {
    const hit = accessorFromSym(p, "get");
    if (hit) recordAccessorHit(owner, hit, p.getName());
  }
}

// The synthesized `<module>` unit for a source file's TOP-LEVEL executable statements (spec §2
// unitKind "initializer" — java's `<clinit>` twin). Top-level `await fetch(…)`, a bare
// `readFileSync(…)`, an IIFE, `export const r = await fetch(…)` execute at MODULE-LOAD time and
// belong to nothing named — without this unit their effects reached the SourceFile in `enclosing`,
// resolved to `null`, and were DROPPED → a false "pure" verdict (the cardinal sin: ESM top-level
// await / serverless handler files / side-effecting config modules scanned as functions: []). This
// is the field-initializer `Class.constructor` synthesis (~scan.mjs:774) one level up: the module
// body is the file's own initializer. Minted LAZILY — only when a top-level statement actually
// attributes an effect/edge here — so a pure top-level never gains a unit (pure units are omitted).
// The qual mirrors sibling top-level units (`moduleOf(sf).<module>`), and the LOCAL — the tail of the
// cross-package `hash` — carries the module path too, so every file's initializer gets its own join key.
// A bare `<module>` local collapsed every file in a package onto ONE hash `<pkg>#<module>`, and since
// duplicate hashes union on load, importing a package charged the union of EVERY published file's top
// level: `proper-lockfile` picked up `Net` from `retry`'s `example/dns.js`, which nothing imports. The
// union was baked into the KEY, not the scan scope, so narrowing the scan could not have fixed it — and
// both obvious narrowings are wrong (scanning only the entry file drops the entry's transitively-required
// modules, which genuinely DO run on import; excluding `example/`/`test/` by name is a guess about
// reachability, and those files are published). Per-file keys need no reachability guess at all: the
// consumer looks up the package's ENTRY module, whose `inferred` already includes its transitive imports
// because the in-scan module-import edge computes that closure, and an unimported `example/dns.js` simply
// has its own key nobody asks for. This is also what the rest of the family already does — java keys a
// `<clinit>` by its owner class, rust a lazy static by its item path.
function moduleUnit(sf) {
  const mod = moduleOf(sf);
  const qual = `${mod}.<module>`;
  let rec = fns.get(qual);
  if (!rec) {
    rec = { local: qual, direct: new Set(), fsKinds: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
            cmds: new Set(), paths: new Set(), blind: new Set(), incomplete: new Set(), why: new Set(),
            entry: false, unitKind: "initializer",
            loc: `${path.relative(rootDir, sf.fileName)}:1:1`,
            endLine: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1 };
    fns.set(qual, rec);
  }
  return qual;
}
// The synthesized static-initializer unit for a `class C { static { … } }` block (spec §2 unitKind
// "initializer"). A static block runs at class-DEFINITION time, not instance construction — but its
// body's effects otherwise walked up in `enclosing` to the ClassDeclaration, which maps to the
// `C.constructor` unit, so a static-init effect was MISLABELED as the instance ctor (and carried no
// unitKind). Mint it as its own unit, lazily, mirroring `moduleUnit`. (An anonymous class expression's
// static block keys under `<anonymous>`; there is at most one static-init unit per class name.)
function staticBlockUnit(node) {
  const cls = node.parent;
  const sf = node.getSourceFile();
  const mod = moduleOf(sf);
  const cname = (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name ? cls.name.text : "<anonymous>";
  const qual = `${mod}.${cname}.<static-init>`;
  let rec = fns.get(qual);
  if (!rec) {
    rec = { local: "<static-init>", direct: new Set(), fsKinds: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
            cmds: new Set(), paths: new Set(), blind: new Set(), incomplete: new Set(), why: new Set(),
            entry: false, unitKind: "initializer",
            loc: `${path.relative(rootDir, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}:1`,
            endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 };
    fns.set(qual, rec);
  }
  return qual;
}
// nearest enclosing analyzed function (closures attribute to it — SEMANTICS §2)
function enclosing(node) {
  for (let p = node; p; p = p.parent) {
    // A `static { … }` block is its own initializer unit (class-definition time), NOT the instance ctor
    // the ClassDeclaration maps to — intercept before the nodeName lookup would fold it into .constructor.
    if (ts.isClassStaticBlockDeclaration(p)) return staticBlockUnit(p);
    // A call/effect lexically inside a DECORATOR (`@factory(arg)`) runs at class-DEFINITION time, NOT in
    // the decorated declaration's body. The parent chain of a decorator's expression is
    // CallExpression → Decorator → MethodDeclaration/ClassDeclaration/Parameter, so `enclosing` otherwise
    // lands on the decorated unit and FABRICATES the factory's effects onto that method/class/param and
    // every transitive caller (a fabrication — @Entity/@Injectable factories that touch I/O would
    // poison every decorated handler). Stop at the Decorator: the factory's own effects live in its own
    // function unit; the application site attributes to nothing (load-time, like a no-arg decorator).
    if (ts.isDecorator(p)) return null;
    const n = nodeName.get(p);
    if (n) return n;
    // Reached the SourceFile with no named unit: a TOP-LEVEL executable statement. Attribute to the
    // file's synthesized `<module>` initializer unit (minted lazily here) rather than dropping it.
    if (ts.isSourceFile(p)) return moduleUnit(p);
  }
  return null;
}

// True when a receiver expression's chain ROOTS at process.stdout/stderr/stdin — including method chains
// (`process.stdin.on("data",f).on("end",g)`, `process.stdout.write(x).on(...)`). The std streams are typed
// tty.ReadStream/WriteStream which EXTEND net.Socket, so `.on`/`.write`/`.end` resolve to net.Socket members
// and the whole-module Net rule paints them — but console fd 0/1/2 I/O is not Net (§1 has no Console effect).
// `net.Socket.on`/`.write` return the stream (`this`), so a chained call's receiver is still the std stream;
// the exact-string check missed it (the receiver is the inner CallExpression). Walk the chain to its head.
function rootsAtStdStream(expr) {
  let e = expr;
  for (;;) {
    if (!e) return false;
    const t = e.getText().replace(/\s+/g, "");
    if (t === "process.stdout" || t === "process.stderr" || t === "process.stdin") return true;
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)
        || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) { e = e.expression; continue; }
    return false;
  }
}

// ---- the implicit/desugared-call surface (the silent-pure holes the AST walk misses) -------------
// CLASSIFIER §1 says resolve, don't pattern-match — but the walk only sees CallExpression/
// NewExpression (+ accessor access). Effects reached through a DESUGARED call (a `for-of` lowering to
// `it[Symbol.iterator]().next()`, a `using` to `r[Symbol.dispose]()`, a tagged template to `tag(...)`)
// were invisible: reported concrete-PURE (omitted), not even Unknown. We model the desugaring exactly
// as the spec demands — resolve the implicit target via the compiler API and edge to it when LOCAL.
// A resolved-but-unseen target follows the existing external/κ posture (OPAQUE + ledger), and a
// BUILT-IN iterator/disposer (es-lib/@types/node — a plain array's iterator, a stdlib disposable)
// resolves to a non-local declaration and edges nothing, so it correctly stays pure.

// The member symbol for a WELL-KNOWN symbol (`Symbol.iterator`, `Symbol.dispose`, …) on a type. The
// checker mangles these to an escaped name `__@iterator@<globalId>`; match by the `__@<name>@` prefix
// (the trailing id is the unique Symbol's identity, not part of the name). `prefixes` is tried in
// order so a sync site prefers the sync method and an async site its async twin (falling back to sync).
function wellKnownSymbolMember(type, prefixes) {
  if (!type || !type.getProperties) return null;
  for (const p of type.getProperties()) {
    const n = p.getName();
    for (const pre of prefixes) if (n === pre || n.startsWith(pre + "@")) return p;
  }
  return null;
}
function declOfSym(sym) { return sym && (sym.valueDeclaration ?? sym.declarations?.[0]); }
const declIsLocal = (decl) => decl && projectFiles.has(path.resolve(decl.getSourceFile().fileName));

// The LOCAL units an ITERATION over `expr` implicitly calls: the iterable's `[Symbol.iterator]` (or
// `[Symbol.asyncIterator]` for `for await`) method AND the produced iterator's `next()`. The generator
// case rolls `next`'s body into the iterator-method unit (lexical attribution), and the self-iterator
// case (`[Symbol.iterator]() { return this }` + a separate effectful `next()`) needs the `next` edge —
// so we edge to BOTH whenever each is a LOCAL unit. A built-in iterable (plain array/string/Map: the
// es-lib/@types iterator) resolves non-local → no edge → stays pure (the precision invariant).
function iterationTargets(expr, isAsync) {
  const t = checker.getTypeAtLocation(expr);
  const iterPrefixes = isAsync ? ["__@asyncIterator", "__@iterator"] : ["__@iterator"];
  const iterDecl = declOfSym(wellKnownSymbolMember(t, iterPrefixes));
  if (!iterDecl) return [];
  const out = [];
  if (declIsLocal(iterDecl)) out.push(iterDecl);
  // the iterator's next(): the return type of the [Symbol.iterator] method
  try {
    const sig = checker.getSignatureFromDeclaration(iterDecl);
    const ret = sig && checker.getReturnTypeOfSignature(sig);
    const nextDecl = declOfSym(ret && ret.getProperties().find((p) => p.getName() === "next"));
    if (nextDecl && declIsLocal(nextDecl) && !out.includes(nextDecl)) out.push(nextDecl);
  } catch { /* unresolved iterator shape — the iterator-method edge already covers the common case */ }
  return out;
}
// Edge `rec` to each LOCAL desugared target that is a minted unit. Local-only by design: an external
// iterable/disposer is OPAQUE (the curated-κ caveat — same as an unmatched external call), never a
// fabricated edge; the existing call machinery + κ ledger already cover any EXPLICIT calls into it.
function edgeToTargets(rec, decls) {
  for (const d of decls) { const t = nodeName.get(d); if (t) rec.edges.add(t); }
}

// ⟨scan-boundary, half 1⟩ Could a chained dependency's report EVER carry an entry under the key this
// declaration names? A `declare function`/`declare class` member names a real body the dependency scanned
// and hashed, so a miss is that dependency's purity claim (SPEC §2 rule 3) and must stay silent. A member
// of a TYPE — an interface method/property signature, an anonymous type-literal member, an `abstract`
// member — names no body at all: the implementation the call actually reaches is hashed under some other
// type's name (`depkit#Client.fetch` for a `Fetcher`-typed receiver), which is why the lookup was never
// answerable in the first place. Purely a question about the DECLARATION KIND, so it cannot depend on what
// happens to be in the chained report — the point is that no report could answer.
// Returns the MEMBER node to name in the disclosure (so the owner type is the interface, not the property
// the function type hangs off), or null when the key is answerable and silence is the dependency's answer.
// `interface Api { fetch: () => string }` — a call through a function-typed PROPERTY resolves to the
// FUNCTION TYPE node, which carries neither a name nor an owner; the member and its interface are one
// level up. EVERY site that keys on a declaration's name has to make that hop or it forms no key at all,
// and it is one function because these drifted apart once already: the disclosure arm made the hop and
// the chained-report join did not, so a property-spelled interface method disclosed
// `Unknown[dispatch:propkit.IDefinition.getInvocationParameters]` while the producer's union entry under
// that exact hash sat unread. A function type on a `declare const` is NOT this case — that names a real
// top-level export the dependency hashed under its bare name — so the parent must be a member signature.
function memberSigOf(decl) {
  return decl && (ts.isFunctionTypeNode(decl) || ts.isCallSignatureDeclaration(decl)) && decl.parent
    && (ts.isPropertySignature(decl.parent) || ts.isMethodSignature(decl.parent)) ? decl.parent : decl;
}
// Apply ONE chained-dependency entry to the calling unit. There is exactly one of these because there used
// to be two, drifted: the CallExpression arm and the desugared-declaration arm each spelled the copy out,
// and the ⟨0.19⟩ reason class was added to neither. That is the same root cause candor-java's `6ab26e4`
// found ("crossDepJoin reproduced inheritDepFn line for line instead of calling it"), and deleting the copy
// is most of the fix there too. The dep's `invisible` travels as this call's own — the transitive
// disclosure has to cross the package edge, or a sibling's SNS reach reads pure here — and so does its
// `unknownWhy`, so `deny E Unknown[<class>]` keeps its scope one boundary along.
function applyDepHit(rec, hit) {
  for (const x of hit.inferred) rec.direct.add(x);
  for (const b of hit.invisible ?? []) rec.blind.add(b);
  for (const w of hit.why ?? []) rec.why.add(w);
  for (const v of hit.hosts ?? []) rec.hosts.add(v);
  for (const v of hit.cmds ?? []) rec.cmds.add(v);
  for (const v of hit.paths ?? []) rec.paths.add(v);
  for (const v of hit.tables ?? []) rec.tables.add(v);
  // ⟨0.20⟩ and the Net surface's INCOMPLETENESS with them — see the loader. `hosts` above is a lower bound;
  // without this the consumer certifies a destination class off a partial host list, and a sibling literal
  // in the CONSUMER's own body masks a hostless dep Net exactly the way candor-java `e24edd9` describes one
  // layer down. Additive: it can only ADD `unknown-host`, never remove a class, so it never turns a firing
  // gate green.
  if (hit.netIncomplete) rec.incomplete.add("Net");
}
function unanswerableKey(decl) {
  if (!decl) return null;
  if (ts.isMethodSignature(decl) || ts.isPropertySignature(decl)) return decl;      // interface / type-literal member
  if (memberSigOf(decl) !== decl) return memberSigOf(decl);
  if ((ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl)
       || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl))
      && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract)) return decl; // `abstract` member of a declared class
  return null;
}
// ⟨scan-boundary, half 1⟩ THE DISCLOSURE ITSELF, in ONE place. It had two copies — the CallExpression arm
// and the desugared-declaration arm — and this pass needed to add a condition to both, which is exactly the
// setup that let candor-java's `crossDepJoin` and this engine's own dep-apply drift (`6ab26e4`, `4dad22d`).
// `dispatch:<pkg>.<owner-type>.<member>` is SPEC §4's spelling, package-qualified so a dependency's type
// can never collide with a local one.
function discloseUnanswerableKey(rec, pkg, abstraction) {
  rec.direct.add("Unknown");
  const owner = abstraction.parent?.name?.getText?.();
  rec.why.add(dispatchWhy(owner ? `${pkg}.${owner}` : null, abstraction.name?.getText?.()));
}

/// SPEC §4's dividing line, in ONE place. `dispatch:` is reserved for an unresolved dispatch whose OWNER
/// TYPE **and** MEMBER are both known — `owner.member` is the vocabulary's one NORMATIVE detail, it is what
/// conformance PART 10 compares, and it is what the ⟨0.7⟩ dispatch-frontier resolves against the hierarchy
/// sidecar. "Every owner-less unresolved invocation is `callback:`" is the spec's own words.
///
/// Each emission site used to substitute the literal words `type`/`member` for whichever half it could not
/// name, producing a `dispatch:` string that no frontier can ever resolve and — worse — a reason CLASS
/// (`dispatch`) that the other three engines do not give the same input: on an owner-less function value
/// rust emits `callback:unresolved call`, java `callback:…Function.apply`, swift `callback:fn`, all class
/// `indirect`. candor-ts was the four-way outlier and this moves it to the family AND to the spec.
///
/// The detail on `callback:` is best-effort (not conformance-compared), so keep whichever half was
/// nameable rather than discarding it: a call through a named function TYPE (`interface UnaryFunction {
/// (x: T): R }`) is `callback:<the type>`, a member of an anonymous type literal is `callback:<member>`.
const dispatchWhy = (qualifiedOwner, member) =>
  qualifiedOwner && member ? `dispatch:${qualifiedOwner}.${member}`
                           : `callback:${qualifiedOwner ?? member ?? "unresolved call"}`;

// Charge `rec` for reaching a resolved EXTERNAL declaration through a DESUGARED site — one that is not a
// CallExpression, so the (CLASSIFY)/join/ledger arm of the call path never sees it. This is the same
// decision procedure that arm runs, in the same order: the chained sibling report (the SPEC §2 `hash`
// join), then the §5.1 package manifest, then the κ-coverage ledger's `invisible`. Nothing is fabricated:
// a member declared in the ES lib / a project file / an unnameable package resolves to nothing and adds
// nothing, and a chained report that omits the entry is making its purity claim (SPEC §2 rule 3).
// `tailOverride` names the dep report's local tail explicitly when the declaration cannot supply it — a
// CONSTRUCTOR has no `name`, and the producer hashed it as `<Class>.constructor`.
function chargeExternalDecl(rec, decl, tailOverride) {
  if (!rec || !decl) return;
  const mod = declModule(decl);
  if (!mod || mod.startsWith("<")) return;             // project source / the ES lib — not a package reach
  const pkg = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
  const nameDecl = memberSigOf(decl); // a function-typed property names its member one level up
  const member = nameDecl.name?.getText?.();
  // Owner-prefixed first (`Owner.member` — how the dep's own scan hashes a method), bare member as the
  // fallback (a CJS dist scan hashes a top-level export under its bare name). Identical to the call arm.
  const owner = nameDecl.parent?.name?.getText?.();
  const hit = tailOverride ? crossDeps.get(`${pkg}#${tailOverride}`)
    : member && ((owner ? crossDeps.get(`${pkg}#${owner}.${member}`) : undefined)
      ?? crossDeps.get(`${pkg}#${member}`));
  if (hit) { applyDepHit(rec, hit); return; }
  const file = decl.getSourceFile().fileName;
  const declared = packageManifestEffects(file);
  if (declared !== null) { for (const e of declared) rec.direct.add(e); return; } // [] = declared pure
  const abstraction = unanswerableKey(decl);
  if (!kappaKnows(pkg) && !depCoveredPkgs.has(pkg) && crossesPackageBoundary(file)) {
    unlistedSeen.set(pkg, (unlistedSeen.get(pkg) ?? 0) + 1);
    rec.blind.add(pkg);
    // ⟨0.21⟩ A package chained ONLY by a SELF-DECLARED-INCOMPLETE report reaches this arm because its
    // coverage was withheld — but half 1 below still has something to say about it, and letting the ledger
    // hedge REPLACE the Unknown would be a narrowing introduced by a fix (standing bar item 0): a
    // `deny E Unknown[dispatch]` that fires today would stop firing. Both voices, not one instead of the
    // other — the "second voice is false uncertainty" argument below is about an UNCHAINED package, where
    // no report was ever asked.
    if (abstraction && incompleteDepPkgs.has(pkg)) discloseUnanswerableKey(rec, pkg, abstraction);
    return;
  }
  // ⟨scan-boundary, half 1⟩ the UNANSWERABLE key, on the desugared sites too — the CallExpression arm's
  // twin (see there for the argument). `[1].forEach(job.run)` where `job` is typed as a chained dep's
  // INTERFACE hands the join a key no report can carry, and a covered package silences the ledger, so the
  // caller read confidently pure. Same three conjuncts, same reason class.
  if (abstraction && depCoveredPkgs.has(pkg) && crossesPackageBoundary(file))
    discloseUnanswerableKey(rec, pkg, abstraction);
}

// ---- implicit VALUE-COERCION desugaring (the silent-pure holes where the JS coercion protocol calls a
// user method the AST walk never visits) ----------------------------------------------------------
// JS coerces an object to a primitive by INVOKING a method on it: `a + b`/`` `${x}` ``/`String(x)` call
// `toString` (or `[Symbol.toPrimitive]`); `x + 1`/`-x`/`+x`/relational call `valueOf` (or
// `[Symbol.toPrimitive]`); `JSON.stringify(x)` calls `toJSON`. None of these surface as a
// CallExpression on the user method, so an effectful `toString`/`valueOf`/`toJSON`/`[Symbol.toPrimitive]`
// reached this way read SILENT-PURE (the cardinal sin). We model the desugar EXACTLY as the spec demands:
// resolve the operand's type's coercion member via the checker and edge to it ONLY when it is a LOCAL
// unit. A built-in/external member (lib.es `Object.prototype.toString`, a stdlib `toJSON`) resolves
// non-local → no edge → stays pure (the precision invariant); a PURE local member edges to a pure unit
// (contributes nothing). NEVER a fabricated edge: a non-object operand, or a type with no such member,
// resolves to nothing.

// Is `m` a member shape whose BODY we can charge (a method, or a function-valued property) — not a
// getter/data field of an unrelated shape?
function isCoercionMemberDecl(m) {
  return m && (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)
    || ts.isPropertyDeclaration(m) || ts.isPropertyAssignment(m)
    || ts.isFunctionDeclaration(m) || ts.isFunctionExpression(m) || ts.isArrowFunction(m));
}
// Find member `name` declared on LOCAL class `cls` or the nearest local ancestor that declares it.
function localClassMember(cls, name) {
  for (let cur = cls, guard = 0; cur && guard++ < 64; cur = localBaseClassOf(cur)) {
    const m = (cur.members ?? []).find((x) => x.name?.getText?.() === name && isCoercionMemberDecl(x));
    if (m && declIsLocal(m)) return m;
  }
  return null;
}
// The CHA universe for a coercion operand's type: the LOCAL classes a value of this type can actually
// be at runtime. An INTERFACE-typed operand (`e: Entry`) reaches its local implementors; a BASE-CLASS-
// typed operand (`b: Base`) reaches its local subclasses. Both indexes are the ones ordinary dispatch
// already uses (interfaceImpls / the classDescendants sibling of classOverrides) — no parallel machinery.
function coercionChaClasses(part) {
  const out = [];
  const sym = part.getSymbol?.() ?? part.aliasSymbol;
  for (const d of sym?.declarations ?? []) {
    if (!declIsLocal(d)) continue;
    if (ts.isInterfaceDeclaration(d)) for (const c of interfaceImpls.get(d) ?? []) { if (!out.includes(c)) out.push(c); }
    else if (ts.isClassDeclaration(d)) for (const c of classDescendants.get(d) ?? []) { if (!out.includes(c)) out.push(c); }
  }
  return out;
}
// A call that hands its arguments to a formatter which stringifies them INSIDE the library. Two
// populations, both named (the SITE table is an allowlist by necessity — treating every external call
// as a stringifying sink would charge every argument of every call and flood; the denylist rule is
// applied to the TARGETS instead, in coercionTargets, where a forgotten case over-discloses).
const LOG_LEVEL_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace", "fatal", "verbose", "silly"]);
function isStringifyingSink(call) {
  const ex = call.expression;
  if (!ts.isPropertyAccessExpression(ex)) return false;
  const member = ex.name?.getText?.();
  // (a) `console.*` — every console method runs its arguments through util.format/inspect.
  if (ts.isIdentifier(ex.expression) && ex.expression.getText() === "console") {
    const d = declOfSym(checker.getSymbolAtLocation(ex.expression));
    return !d || !declIsLocal(d);   // the GLOBAL console; a local `const console = …` shadow is not a sink
  }
  // (b) a logging LEVEL-method on an EXTERNAL receiver — pino/winston/bunyan/log4js/debug, the direct
  // analogue of the SLF4J parameterized call this vein was found on. A LOCAL logger is excluded: its
  // body is walked, so whatever stringification it does is already visible as ordinary code and
  // modelling it as a sink too would double-charge (and would charge a `log()` that never formats).
  if (!LOG_LEVEL_METHODS.has(member)) return false;
  const decl = checker.getResolvedSignature(call)?.declaration;
  return !(decl && declIsLocal(decl));
}
// Resolve coercion members of `expr`'s type to their LOCAL decls. `names` is the ordered set of plain
// member names to try; `withPrimitive` also consults the well-known `[Symbol.toPrimitive]` (which JS
// prefers over toString/valueOf when present). A union operand is widened to its constituents so a
// `A | B` value edges to whichever side declares a LOCAL coercion member. Returns LOCAL member decls.
//
// CHA (the implicit-stringification vein, four-way common-mode — candor-spec
// SOUNDNESS-VEIN-implicit-stringify.md): the checker resolves the member on the operand's DECLARED
// type. For `describe(e: Entry)` where `Entry` is an interface declaring only `state()`,
// `getProperty("toString")` lands on lib.es `Object.prototype.toString` — external, no edge, silent
// PURE — even though the only runtime `Entry` is a class whose `toString` reads the clock. So we also
// dispatch the coercion member over the type's LOCAL implementors/subclasses, exactly as the
// CallExpression path does for ordinary virtual dispatch.
//
// Why this needs NO `Unknown` fallback and NO ≤12 family bound (unlike ordinary dispatch): the
// coercion protocol has a KNOWN-PURE terminal. A class that declares no `toString` does not leave the
// call unresolved — it inherits `Object.prototype.toString`, a builtin that provably does nothing.
// So "no local member found" is a genuine PURE resolution here, not a dropped target, and there is no
// allResolved gate to satisfy and nothing to bound away. That is what keeps this from turning every
// template literal in every program into an Unknown. (Residual, disclosed: an EXTERNAL class
// implementing a local interface is outside `interfaceImpls` — the same node_modules opacity the whole
// engine carries, covered by the κ ledger, not newly introduced here.)
//
// CROSSING THE SCAN BOUNDARY (candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md): the residual in
// the paragraph above is NOT covered by the κ ledger, measured. A coercion is not a CallExpression, and
// the ledger lives in the CallExpression handler — so `` `${e}` `` on a DEPENDENCY class whose `toString`
// writes a file emitted nothing at all: no effect, no Unknown, no `invisible`. The dependency's own
// report holds the answer under `depkit#Entry.toString` and nothing looked for it. The same code in ONE
// project is analysed correctly, so this is a boundary effect, not a general limitation — and it was
// gate-level, not report-level (`deny Fs` went 1 → 0 on identical source). `outExternal`, when supplied,
// collects the members that resolve ACROSS the boundary so the caller can run them through
// `chargeExternalDecl` (the dep-report join, then the manifest, then the ledger).
//
// This stays tight rather than blanket: only a type that EXPLICITLY DECLARES `toString`/`valueOf`/
// `toJSON`/`[Symbol.toPrimitive]` in a dependency's typings reaches it. `${aString}` and `${plainDepObj}`
// resolve to the es-lib `Object.prototype.toString` — a provably-pure terminal, excluded by
// `chargeExternalDecl`'s `<es-lib>` guard — so the overwhelming majority of template literals are
// untouched, exactly as before.
function coercionTargets(expr, names, withPrimitive, outExternal) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return [];
  const out = [];
  const push = (d) => { if (d && declIsLocal(d) && isCoercionMemberDecl(d) && !out.includes(d)) out.push(d); };
  // The far side of the boundary: a coercion member DECLARED in another package. Same shape gate as
  // `push` (a member whose body could be charged), inverted on locality.
  const pushExt = (d) => {
    if (!outExternal || !d || declIsLocal(d) || !isCoercionMemberDecl(d) || outExternal.includes(d)) return;
    outExternal.push(d);
  };
  const seen = new Set();
  // Widen unions/intersections so each branch's coercion member is considered (a `Foo | string` operand
  // can be a Foo at runtime → its local toString runs). A primitive/literal constituent has no LOCAL
  // member and contributes nothing.
  const visit = (ty, depth) => {
    if (!ty || depth > 3) return;
    const parts = ty.isUnionOrIntersection?.() ? ty.types : [ty];
    for (const part of parts) {
      if (!part || !part.getProperty || seen.has(part)) continue;
      seen.add(part);
      if (withPrimitive) {
        const pd = declOfSym(wellKnownSymbolMember(part, ["__@toPrimitive"]));
        if (pd && declIsLocal(pd) && !out.includes(pd)) out.push(pd);
        else pushExt(pd);
      }
      for (const n of names) { const md = declOfSym(part.getProperty(n)); push(md); pushExt(md); }
      // CHA fan-out over the LOCAL runtime classes of this type.
      for (const cls of coercionChaClasses(part)) {
        if (withPrimitive) {
          const ct = checker.getTypeAtLocation(cls);
          const pd = ct && declOfSym(wellKnownSymbolMember(ct, ["__@toPrimitive"]));
          if (pd && declIsLocal(pd) && !out.includes(pd)) out.push(pd);
        }
        for (const n of names) push(localClassMember(cls, n));
      }
      // A member resolved on a LOCAL BASE class that local subclasses OVERRIDE: the base-typed operand
      // can be any subclass at runtime. Reuse the ordinary-dispatch override index.
      for (const n of names) {
        const md = declOfSym(part.getProperty(n));
        if (md) for (const ov of classOverrides.get(md) ?? []) push(ov);
      }
      // ELEMENT recursion. Stringifying an ARRAY is not a leaf: `Array.prototype.toString` delegates to
      // `join`, which coerces EVERY ELEMENT — so `` `${entries}` ``/`entries.join(", ")`/`String(entries)`
      // all run each element's `toString`, and `JSON.stringify(entries)` runs each element's `toJSON`.
      // The array's OWN member resolves to the pure es-lib builtin, so without this the whole element
      // population is silently absorbed. Bounded depth (nested arrays) + a seen-set (recursive types).
      // Only the numeric index type is followed: named PROPERTIES are deliberately NOT recursed, because
      // `Object.prototype.toString` does not look at them — see the residual note at the call site.
      const el = checker.getIndexTypeOfType?.(part, ts.IndexKind.Number);
      if (el) visit(el, depth + 1);
    }
  };
  visit(t, 0);
  return out;
}
// Charge `rec` for COERCING `expr`: an edge to every LOCAL coercion member (as before), plus the
// cross-package treatment of every member that resolves into a DEPENDENCY. One helper so no coercion
// site can be wired to only half of it — the boundary half went missing at all ten sites at once
// precisely because the two halves lived apart.
function chargeCoercion(rec, expr, names, withPrimitive) {
  if (!rec) return;
  const ext = [];
  edgeToTargets(rec, coercionTargets(expr, names, withPrimitive, ext));
  for (const d of ext) chargeExternalDecl(rec, d);
}
// The numeric-element type of an array-like — the gate for treating a `.join()`/`.toString()` receiver
// as an array stringification rather than an ordinary method call on a local object.
function arrayElementTypeOf(expr) {
  const t = checker.getTypeAtLocation(expr);
  return t && checker.getIndexTypeOfType?.(t, ts.IndexKind.Number);
}
// True when `expr`'s type is an OBJECT type that could carry a coercion method (so `a + b` may trigger
// one). A pure primitive operand (string/number/boolean/bigint/null/undefined) never invokes
// toString/valueOf in `+` (string+string concatenates, number+number adds — no method call), so we skip
// it: edging there would be at best inert and the type-narrowing keeps `coercionTargets` from widening a
// huge `string | Foo` into spurious work. An object/union-containing-object is a candidate.
function mayCoerceObject(expr) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return false;
  const parts = t.isUnionOrIntersection?.() ? t.types : [t];
  const PRIM = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
    | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.VoidLike
    | ts.TypeFlags.ESSymbolLike;
  for (const part of parts) {
    if (!part) continue;
    if (part.flags & PRIM) continue;           // a pure primitive branch never coerces via a method
    if (part.flags & ts.TypeFlags.Object) return true;
    if (part.isUnionOrIntersection?.()) return true; // nested — let coercionTargets sort it out
  }
  return false;
}
// Does iterating `expr` FORCE an OPAQUE (caller-supplied) iterable? Forcing an iterable runs its
// `[Symbol.iterator]`/`next` body, which — when the iterable is a PARAMETER / `any` / a bare type-
// parameter — is caller-chosen code that can perform arbitrary I/O. This is epistemically identical to
// invoking an opaque callback parameter (the `call:param` → Unknown posture, scan.mjs ~1145-1158): a
// silent-pure verdict would be the cardinal sin. Mirror that decision exactly. Returns a `why` string
// (→ record Unknown) or null. By design this fires ONLY for genuinely caller-supplied iterables; a
// CONCRETE built-in (array/string/Map/Set: the value resolves to a concrete type, not a param) stays
// PURE, and a LOCAL iterable/generator (a local call result, a local class instance) is handled by the
// existing local-edge path (iterationTargets / the call machinery) — neither is flagged here.
// Opaque iterable INTERFACE names: a value whose TYPE is literally one of these is caller-supplied
// iterator code (its `next` body is unknowable). A CONCRETE built-in (Array/Set/Map/String) has its own
// symbol (`Array`/…) and runs a built-in iterator (no user code) → NOT opaque; a LOCAL class implementing
// Iterable is handled by the local-edge path. So we key on the type's SYMBOL NAME, NOT on "is a parameter"
// (the earlier param-identity check fabricated Unknown when iterating a concrete-typed array PARAM — the
// conformance `loop_elem` regression: `(items: T[]) => { for (const c of items) … }`).
const OPAQUE_ITERABLE_TYPES = new Set([
  "Iterable", "Iterator", "IterableIterator", "Generator",
  "AsyncIterable", "AsyncIterator", "AsyncIterableIterator", "AsyncGenerator",
]);
function opaqueIterableWhy(expr) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return null;
  // (a) `any` or a bare TYPE PARAMETER (`<T extends Iterable<…>>(x: T)`): the concrete iterable is
  // indeterminate, so its iterator body is unknowable — never silently pure.
  if (t.flags & ts.TypeFlags.Any) return "callback:opaque-iterable:any";
  if (t.flags & ts.TypeFlags.TypeParameter) return "callback:opaque-iterable:typeparam";
  // (b) the type IS an opaque iterable INTERFACE *and* the value is CALLER-SUPPLIED (a parameter / binding
  // element): `collect(source: Iterable<T>)`, `nexts(it: Iterator<T>)`, `drain(g: Generator<T>)`. The
  // caller chooses the concrete iterator (arbitrary I/O), identical to invoking an opaque callback. BOTH
  // conditions are required: a LOCAL generator/iterable CALL result (`for (const x of gen())`) also has a
  // Generator/IterableIterator type but is NOT a param → excluded, so the local-edge path edges its real
  // effect (no spurious Unknown); a concrete Array/Set/Map/String PARAM has its own symbol (not in the
  // set) → excluded → PURE (built-in iterator, no user code; the conformance `loop_elem` case).
  const sym = t.getSymbol && t.getSymbol();
  if (sym && OPAQUE_ITERABLE_TYPES.has(sym.name) && ts.isIdentifier(expr)) {
    const d = realDecl(checker.getSymbolAtLocation(expr));
    if (d && (ts.isParameter(d) || ts.isBindingElement(d))) {
      const idx = ts.isParameter(d) && d.parent ? d.parent.parameters.indexOf(d) : -1;
      return idx >= 0 ? `callback:opaque-iterable:param#${idx}` : "callback:opaque-iterable:param";
    }
  }
  return null;
}
// Record an opaque-iterable force as Unknown on the enclosing fn, UNLESS iteration already resolved a
// LOCAL desugar target (then the real effect is edged — no Unknown needed). `localResolved` = the
// non-empty result of iterationTargets (a local `[Symbol.iterator]`/`next` unit was found).
function noteOpaqueIteration(node, iterExpr, localResolved) {
  if (localResolved) return;
  const owner = enclosing(node);
  if (!owner) return;
  const why = opaqueIterableWhy(iterExpr);
  if (!why) return;
  const rec = fns.get(owner);
  if (!rec) return;
  rec.direct.add("Unknown");
  rec.why.add(why);
}

// An argument node that is a FUNCTION-typed VALUE (has ≥1 call signature) — a callback — regardless of
// whether we can pin it to a local fn unit. Used to gate the HOF-invoker Unknown disclosure below to the
// CALLBACK argument only: `reduce(fn, 0)`'s `0`, `sort(cmp)`'s absent extra arg, and any non-function
// positional (a `thisArg`, an initial value) are NOT callables → never disclose. A param typed
// `(x)=>void`, an `any`/unconstrained-generic holder, or an unresolvable ref all read as callable here
// (an `any`/`unknown` value COULD be a function the HOF invokes — the sound side; matches the direct
// `cb()` → Unknown posture). A concrete non-function type (number/string/object without a call sig) is not.
const argIsCallable = (a) => {
  if (!a) return false;
  if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return true; // inline literal — always callable
  const t = checker.getTypeAtLocation(a);
  if (!t) return false;
  // `any`/`unknown` — could hold a function; treat as callable (sound over-approx, mirrors direct-call path).
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (t.getCallSignatures?.().length > 0) return true;
  // A bare type parameter (`<T>(cb: T)`) with no constraint could be instantiated to a function.
  if (t.flags & ts.TypeFlags.TypeParameter) {
    const c = checker.getBaseConstraintOfType(t);
    if (!c || (c.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || c.getCallSignatures?.().length > 0) return true;
  }
  return false;
};

// Callee names that INVOKE a function/method argument (so a fn-reference passed to one is reachable
// through it). Array/iterable HOFs, the timer/microtask schedulers, and Promise continuations. A
// STORE/compare/log sink (`set`/`push`/`add`/`includes`/`indexOf`/`concat`/`log`/`stringify`/…) is
// deliberately ABSENT — edging there would fabricate the fn's effects on a pure path (the precision failure).
// Argument positions each invoking HOF actually CALLS. Almost every one takes its callback first, which
// is why a blanket `argIdx !== 0` guard reads as correct — but `then(onFulfilled, onRejected)` invokes its
// SECOND argument too, on rejection. Moving the by-reference dependency charge below the blanket guard
// (8ee89f5, itself fixing an over-charge) therefore dropped a genuine reach: a dep `onErr` performing Fs
// went from ['Fs'] to pure. Encode the positions rather than assume them.
const HOF_CALLBACK_POSITIONS = new Map([["then", new Set([0, 1])]]);
const DEFAULT_CB_POS = new Set([0]);

/// Does the CALLEE declare a function at this argument position? This is the real discriminator, and
/// neither the argument's own type nor a per-name position map is a substitute for it:
///
///   xs.forEach(cb, thisArg)        param 1 is `thisArg: any`      -> NOT invoked
///   p.then(onOk, onErr)            param 1 is a function          -> invoked
///   Object.groupBy(xs, keyFn)      param 1 is a function          -> invoked
///   _.map(xs, fn) / _.forEach(...) param 1 is a function          -> invoked
///
/// The static/free-function form of these HOFs puts the collection first and the callback SECOND, and
/// `calleeName` cannot see the difference — `_.map` and `xs.map` both yield "map". A hand-written position
/// map therefore silently dropped every static-form dep callback (measured: `Object.groupBy(rows,
/// depWrite)` reported the caller pure, and a `deny Fs` gate that failed before passed).
///
/// Asking the signature needs no list and cannot go stale. Falls back to the name map only when the
/// signature is unresolvable, which keeps the previous behaviour rather than guessing.
///
/// THREE-VALUED, and the third value is load-bearing: `true` = the callee declares a callback here,
/// `false` = it declares something that positively is NOT one, `null` = the signature carries no
/// information. Only a caller that treats `null` as "charge" may use this to DROP.
///
/// The receiver slot is the reason `any` cannot simply mean `false`. `xs.forEach(cb, thisArg)` declares
/// `thisArg?: any`, and so does a loosely-typed library's genuine callback (`forEach(xs: any[], fn:
/// any)`) — the same type, opposite meanings. The es-lib/DOM receiver slot is identifiable by its
/// parameter NAME, which every HOF_INVOKERS entry that has one spells `thisArg`. That name list is a
/// DENYLIST of positions proven safe to treat as non-callbacks: a receiver name nobody thought of costs
/// precision (an over-charge on the contrived `hof(xs, fn, someFn.bind(x))`), never a reach.
const THIS_ARG_PARAM_NAMES = new Set(["thisArg"]);
const calleeParamIsCallable = (node, i) => {
  const sig = checker.getResolvedSignature?.(node);
  const params = sig?.getParameters?.();
  if (!params || !params.length) return null;            // unresolvable — caller falls back
  // A trailing rest parameter covers every later position (`nextTick(cb, ...args)`).
  const p = params[Math.min(i, params.length - 1)];
  const decl = p?.valueDeclaration;
  if (i >= params.length && !(decl && ts.isParameter(decl) && decl.dotDotDotToken)) return false;
  const t = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : null;
  if (!t) return null;
  // `any`/`unknown` says nothing about whether the callee invokes this position — except at the named
  // receiver slot, which is what this carve-out was written for (`thisArg?: any`). See the denylist above.
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    return THIS_ARG_PARAM_NAMES.has(p.getName?.() ?? p.name ?? "") ? false : null;
  if (t.getCallSignatures?.().length > 0) return true;
  // A union such as `((v: T) => void) | undefined | null` — the optional onRejected shape.
  for (const u of t.types ?? []) if (u.getCallSignatures?.().length > 0) return true;
  return false;
};

/// Is the callee's parameter `i` a COLLECTION — an array, tuple, array-like or iterable?
///
/// This exists to answer ONE question, at position 0: has the RECEIVER been relocated into an argument?
/// `HOF_CALLBACK_POSITIONS`/`DEFAULT_CB_POS` describe the METHOD form (`xs.forEach(cb, thisArg)`), where
/// the collection is the receiver and the callback is argument 0. The static/free form of the same HOF
/// (`forEach(xs, cb)`, `_.map(xs, fn)`, `Object.groupBy(xs, keyFn)`) puts the collection in argument 0 and
/// shifts everything right by one — so the map is not merely silent about position 1 there, it is wrong
/// by exactly one place. When the signature is well typed the callable check already recovers that; when
/// it is not (`forEach(xs: any[], fn: any)`), nothing did.
///
/// "Positively a collection" is the whole point: this may only ever ADD positions, so a type shape it
/// fails to recognise costs the precision that is already lost today, never a reach. The obvious
/// alternative — "position 0 is positively NOT a callback" — over-fires on exactly the case the union
/// above was built for: `setTimeout`'s `TimerHandler = string | Function` carries no call signature, so
/// it would read as a relocated receiver and shift the whole map onto the delay argument.
///
/// THE FIRST VERSION OF THIS PREDICATE FIRED 68 TIMES ON A PRODUCTION TREE AND WAS WRONG ALL 68 TIMES,
/// which is why the union rule is `every` and not `some`. Every firing was TypeORM's
/// `EntityManager.find(entityClass: EntityTarget<T>, options)`, and `EntityTarget` is a union with a
/// `string` arm — `string` carries `[Symbol.iterator]`, so an ANY-constituent test called it a
/// collection and relocated the map onto `options`. A union is the relocated receiver only if EVERY
/// constituent is, and a string is never it.
const calleeParamIsCollection = (node, i) => {
  const sig = checker.getResolvedSignature?.(node);
  const params = sig?.getParameters?.();
  if (!params || i >= params.length) return false;
  const decl = params[i]?.valueDeclaration;
  const t = decl ? checker.getTypeOfSymbolAtLocation(params[i], decl) : null;
  if (!t) return false;
  // `any` FIRST, and it is not a formality: `checker.isArrayLikeType(any)` is TRUE (measured — `any` is
  // assignable to `readonly any[]`), so without this every `any`-typed parameter 0 would read as a
  // relocated receiver. That includes the METHOD form, where relocating puts the RECEIVER SLOT inside the
  // map and so silences the `thisArg` denylist `b66b69a` had just landed — a fix undoing its predecessor.
  const one = (u) => !!u && !(u.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike))
    && (checker.isArrayType?.(u) || checker.isTupleType?.(u)
    || checker.isArrayLikeType?.(u)
    // `Set`/`Map`/`Iterable<T>`/a generic `T extends Iterable<…>`: the iterator member is the definition.
    || (u.getProperties?.() ?? []).some((s) => s.getName?.().startsWith("__@iterator")));
  return t.types?.length ? t.types.every(one) : one(t);
};

/// The positions the name map would name if the RECEIVER had not moved into argument 0. Empty unless
/// parameter 0 is positively the collection.
const hofRelocatedPositions = (name, node) => {
  if (!node || !calleeParamIsCollection(node, 0)) return null;
  const shifted = new Set();
  for (const p of HOF_CALLBACK_POSITIONS.get(name) ?? DEFAULT_CB_POS) shifted.add(p + 1);
  return shifted;
};

/// The type check may only WIDEN, never narrow. Asking the callee's signature admits positions a name map
/// cannot know about (the static/free form, where the callback is second) — but a signature can also fail
/// to look callable when it plainly is: `setTimeout`'s DOM overload declares `TimerHandler = string |
/// Function`, which carries no call signatures, so a type-only rule REJECTED argument 0 and dropped an
/// effect the suite had been pinning for months. Union the two sources and a blind spot in either costs
/// precision at worst; letting either one veto costs a reach.
///
/// THE THIRD DISJUNCT is the relocated map. The name map describes the METHOD form; in the free/static
/// form the collection is argument 0 and the callback is argument 1, and a loosely-typed callee
/// (`forEach(xs: any[], fn: any)`) leaves the callable check with nothing to say — so the map was not
/// merely silent about position 1 there, it was wrong by exactly one place.
///
/// It carries NO `!== false` veto of its own, and that is a fact about the one call site rather than a
/// claim about the predicate: a position where the signature says `false` and the base map does not
/// name has ALREADY been dropped by `hofArgIsNeverCallback` at the top of that argument loop, and a
/// position where the base map DOES name it satisfies the first disjunct before this one is reached.
/// So a veto here can never change an answer — written, it failed no test, and the composition is
/// pinned by the `groupBy(xs: any[], key: string)` row instead. If this ever gains a second caller, the
/// caller owes that argument its own drop.
const hofInvokesArg = (name, i, node) =>
  (HOF_CALLBACK_POSITIONS.get(name) ?? DEFAULT_CB_POS).has(i)
  || (node ? calleeParamIsCallable(node, i) === true : false)
  || !!hofRelocatedPositions(name, node)?.has(i);

/// The `.bind` arm's form of the position rule, and it must be asked the other way round.
///
/// `hofInvokesArg` is a POSITIVE test: it answers "the callee invokes this position" or "I have no
/// evidence", and those two are not distinguishable in its return value. Using it to RETURN EARLY makes
/// "I could not tell" mean SILENCE — an allowlist of positions the engine happens to have a signature
/// for, wearing a gate's clothes. Measured on a two-package fixture: a free-form `forEach(xs, fn: any)`
/// from a dependency dropped a `.bind`-wrapped local writer entirely, and `deny Fs src.api` went from
/// exit 1 to exit 0. Unresolved and loosely-typed signatures are exactly where the engine knows least,
/// so they must charge most.
///
/// `.bind(…)` yields a FUNCTION VALUE, so the callability of the ARGUMENT is not in question here (it is
/// for the by-reference arm below, which keeps the positive test plus `argIsCallable`). The only open
/// question is whether the callee invokes THIS position, and the answer may only be "no" on positive
/// evidence: the name map excludes it AND the signature declares something that is not a callback.
///
/// It deliberately does NOT consult the relocated map above. Sharing one position set between the two
/// arms is the tidier-looking option and it is wrong: this arm already requires the signature to speak
/// POSITIVELY, and a relocation inferred from a convention must not overrule that. `groupBy(xs: any[],
/// key: string)` is the shape — argument 1 is declared a string, the relocation would put it in the map,
/// and a shared set would charge a bound writer sitting in it. Mutating the two apart also failed no
/// test, so the sharing was neither necessary nor free.
const hofArgIsNeverCallback = (name, i, node) =>
  !(HOF_CALLBACK_POSITIONS.get(name) ?? DEFAULT_CB_POS).has(i)
  && !!node && calleeParamIsCallable(node, i) === false;

const HOF_INVOKERS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "flatMap", "sort", "group", "groupBy", "partition", "mapValues", "flatMapDeep",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame", "requestIdleCallback",
  "then", "catch", "finally", "nextTick",
]);

// ---- process.env recognition: the direct dot access (`process.env.KEY`) is the JVM System.getenv twin,
// but the same environment READ is spelled several other ways that all read silent-pure without help:
// bracket access (`process.env[k]`), a local const-alias (`const env = process.env; env.KEY`),
// destructuring (`const {KEY} = process.env`), and the `in` operator (`"KEY" in process.env`). Each of
// these on process.env (or a confirmed direct alias of it) is Env. SOUNDNESS: only process.env and a
// DIRECT `x = process.env` / `const {env} = process` binding trigger — a bracket/alias/destructure/`in`
// on any OTHER object stays pure (no fabrication), and a reassigned alias local is cleared.
//
// `process` here must be Node's process object, NOT a project-local `const process = {…}` shadow
// (mirrors the process.hrtime/send guard). It qualifies when it is the ambient GLOBAL (no project
// declaration) OR a default-import of the `node:process` builtin (`import process from 'node:process'`,
// as chalk's supports-color does) — the two are the same object.
const declImportsNodeProcess = (decl) => {
  // ImportClause default binding or a namespace/named import from 'node:process' | 'process'.
  let spec = null;
  if (ts.isImportClause(decl) && decl.parent && ts.isImportDeclaration(decl.parent)) spec = decl.parent.moduleSpecifier;
  else if (ts.isImportSpecifier(decl)) spec = decl.parent?.parent?.parent?.moduleSpecifier;
  else if (ts.isNamespaceImport(decl)) spec = decl.parent?.parent?.moduleSpecifier;
  const text = spec && ts.isStringLiteral(spec) ? spec.text : null;
  return text === "node:process" || text === "process";
};
const identIsGlobalProcess = (id) => {
  if (!id) return false;
  // `globalThis.process` / `global.process` — the SAME process object reached off the global (isomorphic code:
  // `globalThis.process?.env`, often `(globalThis as any).process.env`). Unwrap parens/`as` casts around the
  // root; the `globalThis`/`global` root must be the ambient global, not a project shadow.
  if (ts.isPropertyAccessExpression(id) && id.name.text === "process") {
    let root = id.expression;
    while (ts.isParenthesizedExpression(root) || ts.isAsExpression(root) || ts.isNonNullExpression(root)) root = root.expression;
    if (ts.isIdentifier(root) && (root.text === "globalThis" || root.text === "global")) {
      const gd = checker.getSymbolAtLocation(root)?.declarations ?? [];
      return !gd.some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName)));
    }
  }
  if (!ts.isIdentifier(id) || id.text !== "process") return false;
  const decls = checker.getSymbolAtLocation(id)?.declarations ?? [];
  if (decls.some(declImportsNodeProcess)) return true;                       // `import process from 'node:process'`
  return !decls.some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName))); // else the ambient global
};
// `process.env` as an expression (PropertyAccess `process.env` where `process` is the global).
const isProcessEnvExpr = (expr) =>
  expr && ts.isPropertyAccessExpression(expr) && expr.name.text === "env" && identIsGlobalProcess(expr.expression);

// The set of local-binding SYMBOLS that alias process.env — collected below, one pre-pass over the
// sources. A symbol lands here iff its ONLY initializer/assignment is `= process.env` (a reassignment
// to anything else removes it → the alias is cleared, per the spec's reassignment rule).
const envAliasSymbols = new Set();
// MAY-alias: symbols that were EVER bound `= process.env`, INCLUDING ones later reassigned (a union like
// dotenv's `let processEnv = process.env; if (opts.processEnv) processEnv = opts.processEnv`). A MUST-alias
// (envAliasSymbols) is a proven env read → Env; a MAY-alias is only POSSIBLY env → the effect-polymorphism
// pass (2c) discloses Unknown, never fabricates Env, for one passed into a written parameter.
const envMayAliasSymbols = new Set();
{
  const aliasCandidates = new Set();   // symbol -> declared `= process.env`
  const disqualified = new Set();      // symbol assigned to something that is NOT process.env
  const noteBinding = (symbol, init) => {
    if (!symbol) return;
    if (init && isProcessEnvExpr(init)) aliasCandidates.add(symbol);
    else disqualified.add(symbol);     // bound/assigned to a non-process.env value → not (or no longer) an alias
  };
  const collectAliases = (node) => {
    // `const env = process.env` / `let`/`var` — a name-identifier binding with an initializer.
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      noteBinding(checker.getSymbolAtLocation(node.name), node.initializer ?? null);
    }
    // `const { env } = process` — destructuring `env` off the global `process` makes `env` an alias too.
    else if (ts.isVariableDeclaration(node) && node.name && ts.isObjectBindingPattern(node.name)
             && node.initializer && ts.isIdentifier(node.initializer) && identIsGlobalProcess(node.initializer)) {
      for (const el of node.name.elements) {
        // the property picked off `process` must be `env` (`{env}` or `{env: local}`); the bound name is the alias.
        const propName = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : null)
                                         : (ts.isIdentifier(el.name) ? el.name.text : null);
        if (propName === "env" && ts.isIdentifier(el.name)) aliasCandidates.add(checker.getSymbolAtLocation(el.name));
      }
    }
    // `env = <expr>` reassignment — a `let`/`var` alias reassigned to a non-process.env value is cleared.
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
             && ts.isIdentifier(node.left)) {
      noteBinding(checker.getSymbolAtLocation(node.left), node.right);
    }
    ts.forEachChild(node, collectAliases);
  };
  for (const sf of sources) collectAliases(sf);
  for (const s of aliasCandidates) if (s && !disqualified.has(s)) envAliasSymbols.add(s);
  for (const s of aliasCandidates) if (s) envMayAliasSymbols.add(s); // the MAY set: ever-bound `= process.env`
}
// True when `id` is an identifier resolving to a confirmed process.env alias local.
const identIsEnvAlias = (id) => {
  if (!id || !ts.isIdentifier(id)) return false;
  const sym = checker.getSymbolAtLocation(id);
  return !!sym && envAliasSymbols.has(sym);
};
// The receiver expression READS process.env — it is either `process.env` itself or a confirmed alias.
const readsProcessEnv = (expr) => isProcessEnvExpr(expr) || identIsEnvAlias(expr);
// MAY-read: process.env, a MUST-alias, or a MAY-alias (ever-bound to process.env but reassignable).
const identIsEnvMayAlias = (id) => {
  if (!id || !ts.isIdentifier(id)) return false;
  const sym = checker.getSymbolAtLocation(id);
  return !!sym && envMayAliasSymbols.has(sym);
};

// ---- whole-object process.env access via builtins/spread ------------------------------------------------
// `process.env.KEY` is caught above, but the WHOLE env object handed to a builtin that enumerates or mutates it
// is the same Env effect and read silent-pure: `Object.assign(process.env, o)` / `Object.defineProperty(...)` /
// `Reflect.set(process.env, …)` WRITE the environment; `{...process.env}` / `Object.keys|entries|assign(_, env)`
// / `JSON.stringify(env)` READ every key. Each of these fires the same runtime trap the oracle observes. The
// callee here is a GLOBAL `Object`/`Reflect`/`JSON` builtin — a project-local shadow must not match (mirrors the
// process/fetch guards). A USER function receiving process.env is NOT handled here — that is the env-fed
// parameter analysis (pass 2c) — so this stays scoped to builtins that touch the object in THIS frame.
const ENV_TOUCHING_BUILTIN = new Set([
  "Object.assign", "Object.keys", "Object.values", "Object.entries", "Object.fromEntries",
  "Object.getOwnPropertyNames", "Object.getOwnPropertyDescriptors", "Object.getOwnPropertyDescriptor",
  "Object.defineProperty", "Object.defineProperties",
  "Reflect.set", "Reflect.get", "Reflect.has", "Reflect.ownKeys", "Reflect.deleteProperty",
  "Reflect.defineProperty", "Reflect.getOwnPropertyDescriptor",
  "JSON.stringify",
]);
// BARE-identifier global builtins that enumerate every key of an object argument (deep-clone reads them all).
const ENV_TOUCHING_GLOBAL = new Set(["structuredClone"]);
const identIsGlobal = (id) => // an identifier that is the ambient global (no project-local declaration shadows it)
  !(checker.getSymbolAtLocation(id)?.declarations ?? []).some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName)));
// True when `node` is a call to a global builtin that reads/writes every key of an object argument (so any
// env-object argument makes the enclosing fn Env): `Object.*`/`Reflect.*`/`JSON.stringify` (member) or
// `structuredClone` (bare). Guarded against a project-local shadow of the callee.
const envTouchingBuiltinCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const c = node.expression;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression))
    return ENV_TOUCHING_BUILTIN.has(`${c.expression.text}.${c.name.text}`) && identIsGlobal(c.expression);
  if (ts.isIdentifier(c)) return ENV_TOUCHING_GLOBAL.has(c.text) && identIsGlobal(c);
  return false;
};

// A bare-identifier call whose callee is DEFAULT- or NAMED-imported from a known HTTP-client package is a
// Net call (corpus-audit #13). The κ table lists these packages, but its rule only fires on a MEMBER call
// (`axios.get(…)`); a default-imported callable invoked bare — the canonical `import fetch from 'node-fetch';
// fetch(url)` — resolves to no signature when the package isn't installed, so it read Unknown (callback:fetch)
// instead of Net, the effect users most care about. Resolve the identifier's symbol up to its
// ImportDeclaration and match the specifier; used both to CLASSIFY the call Net and to SUPPRESS the spurious
// callback-Unknown for the same node.
const NET_REQUEST_NAMED = new Set(["fetch", "request", "stream", "pipeline"]); // undici/node-fetch callables
const importedFromNetPkg = (id) => {
  if (!id || !ts.isIdentifier(id)) return false;
  for (const d of checker.getSymbolAtLocation(id)?.declarations ?? []) {
    let n = d;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (!(n && ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)
        && /^(node-fetch|undici|axios|got|superagent|phin)$/.test(n.moduleSpecifier.text))) continue;
    // Only the package's CLIENT CALLABLE is Net: the DEFAULT import (`import fetch from 'node-fetch'`,
    // `import got from 'got'`) or a NAMED request function (`import { fetch, request } from 'undici'`). A
    // named CLASS/utility export — `Headers`, `Response`, `Request`, `CookieJar`, `FormData` — is NOT a
    // request and must not be over-reported as Net (review finding). Namespace imports resolve via κ member
    // calls elsewhere, not as a bare callable here.
    if (ts.isImportClause(d)) return true;                                  // default import = the client
    if (ts.isImportSpecifier(d) && NET_REQUEST_NAMED.has((d.propertyName ?? d.name).text)) return true;
  }
  return false;
};

// ---- pass 2: per call site, the (CLASSIFY)/(EDGE)/(UNKNOWN) resolution of SEMANTICS §4 ------------
function visitCalls(node) {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const owner = enclosing(node);
    if (owner) {
      const rec = fns.get(owner);
      const sig = checker.getResolvedSignature(node);
      const decl = sig && sig.declaration;
      if (!decl) {
        // `new C()` on a class with an IMPLICIT constructor resolves to no declaration — edge to
        // the class's (synthesized) ctor unit via the class identifier before concluding Unknown.
        let edged = false, externalClass = false;
        if (ts.isNewExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
          const cd = realDecl(checker.getSymbolAtLocation(node.expression));
          const t = cd && nodeName.get(cd);
          if (t) { rec.edges.add(t); edged = true; }
          // `new ExternalClass()` with an implicit ctor: same posture as an explicit external ctor
          // the classifier doesn't know — OPAQUE (contributes nothing), not Unknown. Consistency:
          // whether a library declares its ctor must not change the verdict.
          else if (cd && ts.isClassDeclaration(cd) && !projectFiles.has(path.resolve(cd.getSourceFile().fileName))) {
            externalClass = true;
            // …but the construction DOES reach the class's package — run it through the same decision
            // procedure an unmodeled external call gets, so the pure verdict is at worst qualified.
            // Without this, `new Pool()` from an unmodeled pkg read plain pure with no disclosure, no
            // κ-ledger (sweep [13]). The CHAINED half matters just as much: the dependency's report holds
            // the construction's effects under `<pkg>#<Class>.constructor` (every scan mints that unit,
            // explicit ctor or not, because field initializers run at construction) and nothing looked for
            // it — candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md. Name the key the way the
            // producer hashed it; with no chained report this falls through to the disclosure exactly as
            // before.
            chargeExternalDecl(rec, cd, cd.name?.text ? `${cd.name.text}.constructor` : null);
          }
        }
        if (!edged && !externalClass) {
          // Blind PACKAGE member call: the receiver is a NAMESPACE import from a bare specifier
          // (`import * as winstonm from "winston"; winstonm.info()`) that didn't resolve — typically the
          // package isn't installed in this tree. The κ table may still MODEL it, so classify by the import
          // SPECIFIER (the syntactic path, mirroring how the Rust scanner classifies a crate path without
          // building). Only fires for κ-modeled packages (winston/pino/pg/…); everything else still → Unknown.
          let kEff = null;
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
              && ts.isIdentifier(node.expression.expression)) {
            const sym = checker.getSymbolAtLocation(node.expression.expression);
            for (const d of sym?.declarations ?? []) {
              if (ts.isNamespaceImport(d)) {
                const spec = d.parent?.parent?.moduleSpecifier;
                if (spec && ts.isStringLiteralLike(spec)) kEff = kappa(spec.text, node.expression.name.text);
                break;
              }
            }
          }
          if (kEff) {
            rec.direct.add(kEff); // κ-modeled package reached via an uninstalled namespace import
          } else if (ts.isCallExpression(node) && importedFromNetPkg(node.expression)) {
            rec.direct.add("Net"); // bare call to an HTTP-client default/named import whose pkg isn't installed
                                   // (so its signature didn't resolve) — Net, not Unknown (#13). Host capture
                                   // happens in the global/builtin arm below, which fires for the same node.
          } else {
            rec.direct.add("Unknown"); // unresolvable call → Unknown, never silent-pure (SPEC §4)
            // ⟨0.19⟩ SETUP split (SPEC §6.2 §3): if the callee binds to a DECLARED-but-UNINSTALLED package,
            // this Unknown is a mis-configuration (the pkg isn't `npm install`ed), not a genuine dynamic hole
            // — tag `no-node_modules:<pkg>` (reason class `setup`) so it's SEPARABLE + `npm install`-fixable.
            const setupPkg = declaredButUninstalled.size ? importPkgOfHead(node.expression) : null;
            if (setupPkg && declaredButUninstalled.has(setupPkg)) {
              rec.why.add(`no-node_modules:${setupPkg}`);
            } else {
              const callee = (node.expression?.getText?.() ?? "?").replace(/\s+/g, "").slice(0, 60);
              rec.why.add(`callback:${callee}`); // an `any`-typed/indeterminate callee (a function VALUE) — canonical `callback:`
            }
          }
        }
      } else {
        const mod = declModule(decl);
        // A LOCAL function/method passed BY REFERENCE to a NON-LOCAL (opaque) callee — `xs.map(loadFree)`,
        // `arr.forEach(this.m)`, `setTimeout(handler)`, `external(cb)` — may be INVOKED by that callee, so
        // its effects are reachable here. The precise callback-flow below only resolves a LOCAL callee's
        // params; a non-local HOF dropped the reference entirely (a silent-pure hole — confirmed for
        // `map`/`forEach`/`reduce`). Edge to the referenced unit: the sound over-approximation, matching
        // the Rust engine's fn-as-value edge. An inline closure is already charged lexically; a non-fn
        // argument resolves to no minted unit (`nodeName` miss) and adds nothing — no fabrication. Gated
        // on a non-local callee so a local callee that merely STORES (never invokes) keeps its precision.
        // ONLY a callee that actually INVOKES its fn argument makes the reference reachable here. The
        // earlier version edged for ANY non-local callee — fabricating the fn's effects onto a pure path
        // (the precision failure) for STORE/compare/log sinks that never call it (`map.set(k, fn)`,
        // `arr.push(fn)`, `arr.includes(fn)`, `console.log(fn)`, `[fn]`). Gate on a known INVOKING HOF by
        // callee name; a custom non-local HOF that invokes its arg is an honest under-report (sound),
        // never a fabrication. (A LOCAL callee keeps its precise callback-flow below.)
        const calleeName = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : null;
        if (mod !== "<local>" && calleeName && HOF_INVOKERS.has(calleeName)) {
          node.arguments?.forEach((a, argIdx) => {
            // A `<ref>.bind(…)` partial-application is a CallExpression (skipped by the id/property-access
            // gate below) but the INVOKING HOF calls the bound fn → its effects are reachable. Unwrap the
            // `.bind` chain to the root receiver and resolve it like a bare ref (`resolveFnRefUnit` follows
            // local aliases too). A `.bind` whose receiver can't be pinned to a fn unit (`getCallback().bind`,
            // a param/`any` holder) still INVOKES whatever it wraps — disclose Unknown, never silent-pure.
            // The POSITION rule applies to the `.bind` arm too. It sat above the guard and so fired at
            // every argument index — `xs.forEach(cb, dep.helper.bind(x))` charged a thisArg's effects,
            // the same over-charge the by-reference arm below was fixed for and this arm was not.
            // …but it must be the NEGATIVE test, not `!hofInvokesArg`: an unresolved or loosely-typed
            // callee signature is not a licence to drop a bound callback. See `hofArgIsNeverCallback`.
            if (hofArgIsNeverCallback(calleeName, argIdx, node)) return;
            const bound = unwrapBind(a);
            if (bound) {
              const bref = bound.ref;
              const d3 = bref && realDecl(checker.getSymbolAtLocation(bref));
              const tb = (d3 && nodeName.get(d3)) || (bref && resolveFnRefUnit(bref));
              if (tb) rec.edges.add(tb);
              else {
                rec.direct.add("Unknown");
                rec.why.add(`callback:bind:${(bref ?? a).getText().replace(/\s+/g, "").slice(0, 40)}`); // `.bind(...)` yields a function VALUE — canonical `callback:`
              }
              return;
            }
            // An INLINE arrow/function literal is charged lexically (its own unit) — never disclose here
            // (would flood the overwhelming-majority `arr.forEach(x => …)` shape). It is not an id/property-
            // access anyway, so it skips the ref arm below; guarded explicitly for clarity.
            if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return;
            if (!ts.isIdentifier(a) && !ts.isPropertyAccessExpression(a)) return;
            const d2 = realDecl(checker.getSymbolAtLocation(a));
            const t = (d2 && nodeName.get(d2)) || resolveFnRefUnit(a); // pin direct fn OR a local alias chain
            if (t) { rec.edges.add(t); return; } // resolvable named/local callback — keep its analyzed effect
            // A DEPENDENCY function passed BY REFERENCE — `xs.forEach(depWrite)`, `setTimeout(dep.tick, 0)`.
            // The invoking HOF calls it, so its effects are reachable here, and the dependency's report
            // holds them under `<pkg>#depWrite`. Guard (2) below reasons that a ref resolving to a concrete
            // external declaration is fine because "dep calls flow through the κ/invisible channel" — but
            // that channel is the CallExpression handler, and a by-reference pass never enters it. So the
            // shape got neither an edge NOR an Unknown NOR a disclosure: silent-pure, on both sides of the
            // boundary (candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md). Route it through the same
            // decision procedure a DIRECT call to it would get, which is exactly what guard (2) assumed was
            // already happening. `argIsCallable` keeps a non-function dep value out (a `reduce` seed), and a
            // pure global builtin (`.filter(Boolean)`, `.map(String)`) resolves to the ES lib and adds
            // nothing, so the shapes guard (2) protects stay protected.
            // OPAQUE callback → Unknown (the cardinal-sin guard): a callback the es-lib signature resolved to
            // the CALLEE (`forEach`) so its reference was dropped silent-pure — `arr.forEach(cb)` read pure
            // though `cb` runs caller-supplied code. Disclose Unknown, the same posture as the direct
            // `cb()` → `callback:param#i` path. THREE guards keep over-disclosure at floor:
            //  (1) POSITION — only the callback slot (arg 0). Every HOF here takes its callback FIRST
            //      (`reduce(cb, init)`, `forEach(cb, thisArg)`); a later positional is an init value / thisArg,
            //      never the invoked fn — flagging it fabricated (the zod `path.reduce(fn, obj)` `obj` seed).
            //  (2) OPACITY — the ref must resolve to a VALUE HOLDER (a parameter / local variable / binding
            //      element) or to nothing. That is a genuinely unresolvable callback. A ref resolving to a
            //      concrete function/ctor DECLARATION — a pure global builtin (`.filter(Boolean)`,
            //      `.map(String)`) or an imported dep fn — is NOT opaque: globals are pure and dep calls flow
            //      through the κ/invisible channel, so blanket-Unknown here would over-disclose them.
            //  (3) CALLABILITY — `argIsCallable` (has a call signature, or `any`/`unknown`/unconstrained
            //      generic that COULD hold a function).
            if (!hofInvokesArg(calleeName, argIdx, node)) return;
            // The BY-REFERENCE dependency charge belongs BELOW guard (1), not above it. It was placed
            // first and returned early, so it ran at EVERY argument position: `xs.reduce(dep.merge,
            // dep.makeSeed)` and `promise.then(dep.onOk, dep.onErr)` charged the non-callback argument's
            // effects to the caller. `argIsCallable` does not save it — a seed object typed `any`, or a
            // dep VALUE with a call signature, passes. Guard (1) exists for exactly this shape and its own
            // comment names the case (`path.reduce(fn, obj)`); the new arm simply ran before it.
            if (d2 && !declIsLocal(d2) && argIsCallable(a)) { chargeExternalDecl(rec, d2); return; }
            // A value holder the CALLER controls (a project param / local var / binding element) is genuinely
            // opaque. A holder declared in a LIB/dep file — the global `Boolean`/`String`/`Number` constructors
            // (`declare var Boolean: BooleanConstructor` in lib.es5.d.ts) or an imported dep binding — is a known
            // callable, NOT opaque: the coercion globals are pure and dep calls flow through κ, so excluding
            // them here keeps `.filter(Boolean)`/`.map(String)` pure. `!d2` (nothing resolved) stays opaque.
            const holderIsProjectValue = d2 && (ts.isParameter(d2) || ts.isVariableDeclaration(d2) || ts.isBindingElement(d2))
              && projectFiles.has(path.resolve(d2.getSourceFile().fileName));
            if (!(holderIsProjectValue || !d2)) return;
            if (argIsCallable(a)) {
              rec.direct.add("Unknown");
              rec.why.add(`callback:${a.getText().replace(/\s+/g, "").slice(0, 40)}`); // opaque callable invoked by a sync HOF — canonical `callback:`
            }
          });
        }
        // `fn.call(thisArg, …)` / `fn.apply(thisArg, args)` INVOKE the receiver function reference, and
        // `Reflect.apply(fn, …)` / `Reflect.construct(Ctor, …)` invoke their FIRST ARGUMENT. The resolved
        // signature lands on the es-lib `CallableFunction.call/apply` / `Reflect.apply` member, so the
        // function actually invoked (the receiver, or arg0) was never followed → the caller read
        // silent-pure (HIGH: a common reflective-invoke shape). Edge to the referenced unit, mirroring the
        // HOF-ref arm: a pure ref edges to a pure unit (no fabrication); a non-fn receiver/arg resolves to
        // no minted unit (`nodeName` miss) and adds nothing; an unresolvable ref stays opaque/Unknown.
        if (ts.isPropertyAccessExpression(node.expression)) {
          const m = node.expression.name.text;
          const recv = node.expression.expression;
          const recvText = recv.getText().replace(/\s+/g, "");
          // R32 — a node:stream driver (`s.write()`/`s.end()`/`s.read()`) on a CONCRETE local stream
          // subclass drives its `_write`/`_read`/… override, invisibly inside node core. Edge to the local
          // override (resolve-or-skip: a non-stream receiver / external stream / pure override adds nothing).
          for (const un of streamImplOverrides(recv, m)) rec.edges.add(un);
          let invokedRef = null;
          if ((m === "call" || m === "apply") && recvText !== "Reflect") invokedRef = recv;
          else if (recvText === "Reflect" && (m === "apply" || m === "construct"))
            invokedRef = (node.arguments ?? [])[0] ?? null;
          if (invokedRef && (ts.isIdentifier(invokedRef) || ts.isPropertyAccessExpression(invokedRef))) {
            const d2 = realDecl(checker.getSymbolAtLocation(invokedRef));
            // Resolve the receiver/arg0 to its function unit, FOLLOWING local-variable aliases
            // (`const m = effectful; m.call(…)`) — the direct-identifier form already landed on a minted
            // unit, but an aliased local var resolves to its VARIABLE decl (not a unit), which dropped the
            // edge silent-pure. `resolveFnRefUnit` chases the initializer alias to the real fn.
            const t = (d2 && nodeName.get(d2)) || resolveFnRefUnit(invokedRef);
            if (t) rec.edges.add(t);
            else {
              // Not a project unit — but the invoked reference may be a κ-modeled BUILTIN function
              // (`fs.writeFileSync.call(…)` / `Reflect.apply(fs.writeFileSync, …)`): the reflective invoke reaches
              // the SAME effect a direct call would. Classify the invoked function's DECLARATION through the same
              // κ table (module + member), exactly as the (CLASSIFY) arm does. A PURE builtin — `[].slice.call`,
              // `Array.prototype.map.call`, `Function.prototype.bind` — matches no κ rule and stays pure (no
              // over-disclosure); an EFFECTFUL one (`fs.writeFileSync` → Fs, `dns.resolve` → Net) gets its effect.
              const kMod = d2 && declModule(d2);
              const kMember = d2?.name?.getText?.()
                ?? (ts.isPropertyAccessExpression(invokedRef) ? invokedRef.name.text : ts.isIdentifier(invokedRef) ? invokedRef.text : null);
              const kEff = kMod && kMember ? kappa(kMod, kMember) : null;
              if (kEff) {
                rec.direct.add(kEff);
                if (kEff === "Unknown") rec.why.add(`reflect:${kMod.replace(/^node:/, "")}.${kMember}`);
              }
              // HONESTY: the receiver IS a local variable/parameter (a value declaration) that we could NOT pin
              // to a function unit (bound to a param, a reassigned/branched value, an `any`-typed holder). The
              // `.call`/`.apply` still INVOKES whatever it holds, so a silent-pure verdict would be the cardinal
              // sin — disclose Unknown. (A direct fn identifier / known fn resolved above; a non-value receiver
              // — a type, a literal — resolves to no decl and stays out, no fabrication.)
              else if (d2 && (ts.isVariableDeclaration(d2) || ts.isBindingElement(d2) || ts.isParameter(d2))) {
                rec.direct.add("Unknown");
                rec.why.add(`callback:${recvText.slice(0, 40)}.${m}`); // method on an indeterminate-valued receiver (no resolvable owner TYPE) — canonical `callback:`, not the frontier's `dispatch:OWNER.member`
              }
            }
          }
          // EXPLICIT iterator force: `it.next()` / `it.return()` / `it.throw()` on an OPAQUE iterator
          // (a parameter / `any` / type-parameter typed as the `Iterator`/`Generator` protocol) runs
          // caller-supplied iterator code — epistemically identical to forcing a for-of over an opaque
          // iterable, and to invoking an opaque callback. The method resolves to the non-local es-lib
          // `Iterator.next` signature, so the desugar above never sees it and the call lands here pure.
          // Disclose Unknown (cardinal-sin guard). Gated on the iterator-protocol type symbol so an
          // unrelated `.next()` on some other opaque param is not flagged; a LOCAL iterator's `next`
          // resolves `<local>` (edged below), never reaching this non-local arm.
          if ((m === "next" || m === "return" || m === "throw")) {
            const why = opaqueIterableWhy(recv);
            const rt = checker.getTypeAtLocation(recv);
            const sn = rt?.getSymbol?.()?.getName?.()
              ?? (rt?.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(rt)?.getSymbol?.()?.getName?.() : undefined);
            const ITER_PROTO = new Set([
              "Iterator", "AsyncIterator", "Iterable", "AsyncIterable",
              "IterableIterator", "AsyncIterableIterator", "Generator", "AsyncGenerator",
            ]);
            if (why && sn && ITER_PROTO.has(sn)) {
              rec.direct.add("Unknown");
              rec.why.add(why); // `callback:opaque-iterable:param#i` / `:any` / `:typeparam` (opaque iteration ≈ opaque callback)
            }
          }
        }
        if (mod === "<local>") {
          const targetName = nodeName.get(decl);
          if (targetName) {
            rec.edges.add(targetName); // (EDGE) — cross-FILE edges resolve the same way
            // Class-CHA fan-out: resolution landed on a base-class member that LOCAL subclasses
            // override. A base-typed receiver (`a: Animal`, or a branch-merged `Animal|Dog`) could be
            // any subclass at runtime, so the override bodies' effects must propagate — else the caller
            // reads concrete-PURE while a `Dog.speak` does I/O (the silent-pure base-dispatch hole). We
            // edge to the overrides too, bounded by the same ≤12 family limit the interface path uses,
            // with the same honesty gate: if any override isn't a resolvable unit (not minted), or the
            // family is too large, fall to Unknown rather than silently dropping it. A monomorphic
            // receiver already resolved to the leaf (`new Dog()` -> Dog.speak, no overrides) so this is
            // inert there — no double-count. A base method NO subclass overrides has no entry: today's
            // behavior (just the base) is preserved exactly.
            const allOverrides = classOverrides.get(decl);
            if (allOverrides && allOverrides.length > 0) {
              // PRECISION: scope the fan-out to the RECEIVER's static-type subtree. A base-member
              // dispatch on a receiver statically typed as subclass `Cat` can only ever bind to a
              // `Cat`-subtree body — a SIBLING `Dog.speak` override is type-impossible on this path,
              // so propagating its effect over-reports on an unreachable receiver (fabrication-
              // adjacent). When we can pin the receiver's static class (a property/element access
              // whose receiver-expression type is a LOCAL class), keep only overrides whose owning
              // class lies in that class's subtree; `viaBase(a: Animal)` keeps Dog (Dog ∈ Animal-
              // subtree, the soundness edge), `noOverride(c: Cat)` drops Dog (Dog ∉ Cat-subtree) and
              // stays pure. SOUNDNESS-PRESERVING FALLBACK: if the receiver's static class can't be
              // pinned to a LOCAL class (no property access, a union/interface/`any` receiver, an
              // external/unresolved type), we do NOT narrow — the full override set is kept, exactly
              // the pre-precision behavior, so we never silently drop an effect we can't rule out.
              let overrides = allOverrides;
              const recvExpr = (ts.isPropertyAccessExpression(node.expression)
                || ts.isElementAccessExpression(node.expression)) ? node.expression.expression : null;
              if (recvExpr) {
                const rt = checker.getTypeAtLocation(recvExpr);
                const rootClass = (rt?.symbol?.declarations ?? []).find((d) =>
                  ts.isClassDeclaration(d) && projectFiles.has(path.resolve(d.getSourceFile().fileName)));
                if (rootClass) overrides = allOverrides.filter((om) =>
                  ts.isClassDeclaration(om.parent) && classInSubtree(om.parent, rootClass));
              }
              if (overrides.length > 0) {
                if (overrides.length <= 12) {
                  let allResolved = true;
                  const oTargets = [];
                  for (const om of overrides) {
                    const ot = nodeName.get(om);
                    if (ot) oTargets.push(ot);
                    else allResolved = false;
                  }
                  for (const ot of oTargets) rec.edges.add(ot);
                  if (!allResolved) {
                    rec.direct.add("Unknown");
                    rec.why.add(dispatchWhy(  // class-override dispatch — canonical `dispatch:QUALIFIED-OWNER.member`, frontier-relevant
                      decl.parent?.name ? `${moduleOf(decl.parent.getSourceFile())}.${decl.parent.name.getText()}` : null,
                      decl.name?.getText?.()));
                  }
                } else {
                  rec.direct.add("Unknown"); // override family too wide to enumerate soundly
                  rec.why.add(dispatchWhy(decl.parent?.name?.getText?.(), decl.name?.getText?.())); // class-override dispatch (overridable member, unresolved/too-wide family) — canonical `dispatch:OWNER.member`, frontier-relevant
                }
              }
            }
            // record what each argument position received (callback-flow, see callbackArgs)
            (node.arguments ?? []).forEach((a, i) => {
              const slot = (callbackArgs.get(targetName) ?? callbackArgs.set(targetName, new Map()).get(targetName));
              const cell = slot.get(i) ?? { targets: new Set(), opaque: false };
              if (ts.isIdentifier(a)) {
                const t = (() => { const d2 = realDecl(checker.getSymbolAtLocation(a)); return d2 && nodeName.get(d2); })();
                if (t) cell.targets.add(t);
                else cell.opaque = true;
              } else if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) {
                cell.opaque = true; // inline closure: body attributed to the PASSER; opaque to the callee
              } else {
                cell.opaque = true;
              }
              slot.set(i, cell);
            });
          } else if (!ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) {
            // Resolution landed on a TYPE (a function-type annotation, a method/property signature),
            // not a body. If that type belongs to a PARAMETER of a unit, defer to callback-flow
            // resolution (pass 2b) — all-named call sites resolve it; otherwise (a field, a
            // signature, a parameter of an un-collected function) the concrete callable is
            // genuinely indeterminate: (UNKNOWN), never silent-pure (SPEC §4). An arrow/fn-
            // expression is fine: its body is visible and already walked lexically (SEMANTICS §2).
            let p = decl;
            while (p && !ts.isParameter(p) && p !== p.parent) p = p.parent;
            const ownerUnit = p && ts.isParameter(p) && p.parent && nodeName.get(p.parent);
            if (ownerUnit) {
              const idx = p.parent.parameters.indexOf(p);
              (paramInvokes.get(ownerUnit) ?? paramInvokes.set(ownerUnit, new Set()).get(ownerUnit)).add(idx);
            } else {
              // Interface-CHA (the Rust engine's local-trait move, the JVM's bounded-CHA bound):
              // a method signature on a LOCAL interface resolves to the local implementing
              // classes' members when the dispatch is narrow (≤12 implementors) — `store.save()`
              // on an injected `Store` edges to `PgStore.save`. No implementor in sight, or too
              // many: honest Unknown, exactly as before.
              // Soundness rule (/code-review): the dispatch suppresses Unknown only when EVERY
              // implementor contributed an edge — an implementor whose member is inherited from a
              // base class (or otherwise not a unit) is genuinely unresolved here, and edging the
              // others while staying silent about it would drop its effects (a §4 regression: the
              // pre-CHA code always read Unknown at this site).
              // An interface member can be spelled two ways and only one of them was ever looked at:
              // `run(x: string): void` is a MethodSignature, `run: (x: string) => void` is a
              // PropertySignature whose type is a FunctionTypeNode — the same contract, and the second
              // is what @cucumber/cucumber's `IDefinition.getInvocationParameters` and @ukri-tfs/email's
              // whole `SendStrategy` use. The checker resolves a call through the property to the
              // FUNCTION TYPE NODE, not to the property, so `isMethodSignature` was false and the
              // dispatch fell straight through to Unknown. Normalising the two spellings here also
              // repairs the disclosure: the reason read `dispatch:<module>.<property>.member`, naming
              // the property as the OWNER and losing the member entirely, which is not a name the
              // dispatch-frontier can resolve against the hierarchy sidecar.
              const sigDecl = memberSigOf(decl);
              let edged = false;
              if ((ts.isMethodSignature(sigDecl) || ts.isPropertySignature(sigDecl))
                  && sigDecl.parent && ts.isInterfaceDeclaration(sigDecl.parent)) {
                const impls = interfaceImpls.get(sigDecl.parent) ?? [];
                if (impls.length > 0 && impls.length <= CHA_FANOUT_LIMIT) {
                  const member = sigDecl.name?.getText?.();
                  let allResolved = true;
                  const targets = [];
                  for (const cls of impls) {
                    const m = (cls.members ?? []).find((x) =>
                      (ts.isMethodDeclaration(x) || ts.isPropertyDeclaration(x)) && x.name?.getText?.() === member);
                    const t = m && nodeName.get(m);
                    if (t) targets.push(t);
                    else allResolved = false;
                  }
                  for (const t of targets) rec.edges.add(t);
                  edged = targets.length > 0 && allResolved;
                }
              }
              if (!edged) {
                rec.direct.add("Unknown");
                // QUALIFIED owner (module.Type), matching the `mod.Class.member` fn quals so the
                // dispatch-frontier (callers --include-unknown) can resolve overrides against the
                // hierarchy sidecar. Bare `decl.parent.name` would not match a reacher's declaringType.
                const tn = sigDecl.parent?.name
                  ? `${moduleOf(sigDecl.parent.getSourceFile())}.${namespacePrefixOf(sigDecl.parent)}${sigDecl.parent.name.getText()}`
                  : null;
                // A CALL SIGNATURE has no member to name (`interface UnaryFunction { (x: T): R }`,
                // `type PatchFn = (a, b) => void`), and a member of an ANONYMOUS type literal has no
                // owner to name. Both are function-VALUE invocations, not member dispatch — see
                // `dispatchWhy`. This is where all 1,234 malformed strings measured on a 15-repo corpus
                // came from; the other emission sites produced none.
                rec.why.add(dispatchWhy(tn, sigDecl.name?.getText?.())); // resolution landed on a type, not a body — canonical `dispatch:OWNER.member` (frontier-relevant)
              }
            }
          }
        } else if (mod === "<es-lib>") {
          // conventionally-pure ES surface (Array/String/…) — except the clock and entropy (SPEC §1).
          // `new Date()` (no args) captures the current time -> Clock; `Math.random()` -> Rand
          // (both missed on the first real-app dogfood: a JWT issuer's timestamps and a slugifier's
          // entropy were invisible).
          const name = decl.name ? decl.name.getText() : "";
          const parent = decl.parent && decl.parent.name ? decl.parent.name.getText() : "";
          // `eval(code)` executes an arbitrary code string — it can perform ANY effect, so it is genuinely
          // Unknown (the same posture as `new Function(s)`, which already reads Unknown via the no-decl
          // path). The es-lib declares `eval` as a top-level ambient function (parent is the global/source
          // file, no type name), and `globalThis.eval`/`window.eval`/`self.eval` all resolve to the same
          // `eval` declaration — so keying on the resolved name catches every access form. Without this it
          // resolved to a benign es-lib member and read SILENT-PURE (a code-execution sink reported pure).
          if (name === "eval" && parent !== "Math" && parent !== "JSON") {
            rec.direct.add("Unknown");
            rec.why.add("reflect:eval"); // eval executes a runtime-supplied string — canonical `reflect:`
          }
          if ((parent === "DateConstructor" && name === "now") || (parent === "Performance" && name === "now"))
            rec.direct.add("Clock");
          if (parent === "Math" && name === "random") rec.direct.add("Rand");
          if (ts.isNewExpression(node) && (node.arguments ?? []).length === 0
              && checker.getTypeAtLocation(node.expression)?.symbol?.name === "DateConstructor")
            rec.direct.add("Clock");
          // Browser/runtime NETWORK globals declared in lib.dom — no importable module for the κ table to
          // key on, so they read SILENT-PURE. `XMLHttpRequest.send`/`.open` issue the HTTP request; the
          // `EventSource`/`WebSocket` constructors open a connection on construction. Net. (Found by a
          // Net-deep sweep. The npm `ws` package is already κ-covered; this is the bare browser global.)
          if (parent === "XMLHttpRequest" && (name === "send" || name === "open")) rec.direct.add("Net");
          // `new EventSource(url)` / `new WebSocket(url)`: the constructor is declared on an anonymous
          // `declare var` object type (symbol `__type`, no usable parent name), but reaching the es-lib
          // branch already proves the ctor resolved to lib.dom (not a project class shadowing the name),
          // so the constructed identifier is the real browser global.
          if (ts.isNewExpression(node)) {
            const ctorName = node.expression.getText();
            if (ctorName === "EventSource" || ctorName === "WebSocket") rec.direct.add("Net");
          }
        } else {
          // The member token κ matches: the resolved declaration's name, EXCEPT a `new X()` call,
          // whose declaration is a Constructor (empty name) — synthesize "new" so a rule can exempt
          // inert construction from its module-wide effect (the net cluster: `new http.Agent()` etc.).
          // BUT a CONNECTING constructor is NOT inert: `new http.ClientRequest(url)` performs the
          // network I/O on construction (it is what `http.request()` returns and dispatches), so the
          // blanket `new`-exemption would convert a real Net source into pure (a cardinal-sin under-
          // report). For such a ctor we synthesize the CLASS name instead of "new", so the net-cluster
          // rule's `/^(?!new$)/` matcher keeps the effect. The set is the net cluster's documented
          // public connecting ctors; http2 connects via `connect()` (a function, not a ctor) so it
          // needs no entry here. Inert ctors (Agent/Server/Socket/TLSSocket/Http2Server*/message shells)
          // still synthesize "new" and stay pure.
          const CONNECTING_CTORS = new Set(["ClientRequest"]);
          // Host-ESTABLISHING Net call names (the masking-fix allowlist): a Net call by one of these whose
          // host is not a captured literal leaves the host invisible. Excludes use-verbs (write/end/send on
          // a connected socket). `post/put/patch/delete/head/options` cover the axios/got/undici tier whose
          // URL is the call arg (sweep [18]); `dgram.send(buf,port,host)` is added module-aware below (UDP
          // has no connect, so send carries the destination — sweep [12]).
          const NET_ESTABLISHING = new Set(["request", "get", "post", "put", "patch", "delete", "head",
            "options", "connect", "createConnection", "fetch"]);
          // Fs/Exec USE-verbs whose LOCATOR was fixed earlier, not an arg of THIS call — so a missing literal
          // here is the legitimate split-construct/use shape, never the masking signal (the establishing-
          // allowlist discipline, generalized from Net to all 4 effects; sweep [11]). Fs: the fd/FileHandle
          // ops (fd came from open()); the path-taking fs.* fns are establishing. Exec: ChildProcess methods
          // (the command was fixed at spawn); the spawn fns are establishing.
          const FS_USE_VERBS = new Set(["write", "writeSync", "read", "readSync", "close", "closeSync",
            "fsync", "fsyncSync", "fdatasync", "fdatasyncSync", "ftruncate", "ftruncateSync", "fchmod",
            "fchmodSync", "fchown", "fchownSync", "futimes", "futimesSync", "fstat", "fstatSync"]);
          const EXEC_USE_VERBS = new Set(["kill", "send", "disconnect", "ref", "unref"]);
          const netEstablishing = (member) =>
            CONNECTING_CTORS.has(ctorClassName) || NET_ESTABLISHING.has(member)
            || (/^(node:)?dgram$/.test(mod) && member === "send");
          const ctorClassName = ts.isNewExpression(node)
            ? (ts.isConstructorDeclaration(decl) ? decl.parent?.name?.getText?.()
               : (decl.name ? decl.name.getText() : ""))
            : "";
          const isConstruction = ts.isConstructorDeclaration(decl) || ts.isNewExpression(node);
          // The κ member token. A named decl (function/method declaration) carries its own name; but a
          // VALUE-BINDING export — `export const v4 = (...) => ...` (the shape REAL uuid v9+/nanoid ship,
          // and the `type v4 = v4Buffer & v4String` callable type-alias of @types/uuid v8) resolves to an
          // ANONYMOUS arrow/function-type whose `decl.name` is empty, so κ saw `""` and the package's
          // entropy/net verb read silent-pure (verified against installed uuid/nanoid). Fall back to the
          // BINDING name: an arrow/fn-expr's parent VariableDeclaration / PropertyAssignment / property,
          // or a callable type-alias's TypeAliasDeclaration. Precision no-op where the old path already
          // had a name (this only fills a former `""`); never synthesizes a name for `new`.
          const bindingName = (d) => {
            const p = d.parent;
            if (!p) return "";
            if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)
                 || ts.isPropertySignature(p) || ts.isBindingElement(p) || ts.isTypeAliasDeclaration(p))
                && p.name && ts.isIdentifier(p.name)) return p.name.getText();
            return "";
          };
          const member = isConstruction
            ? (CONNECTING_CTORS.has(ctorClassName) ? ctorClassName : "new")
            : (decl.name ? decl.name.getText() : bindingName(decl));
          let eff = kappa(mod, member); // (CLASSIFY)
          // process.stdout/stderr/stdin are typed `tty.WriteStream`, which EXTENDS `net.Socket`, so a
          // `.write()`/`.end()` on them resolves to `net.Socket.write` and the whole-module Net rule
          // paints it Net. But a console write to fd 0/1/2 is TTY/console I/O, NOT network — there is no
          // "Console" effect in §1, so it must be PURE. Suppress the fabricated effect for these receivers
          // (a real `net.Socket` you constructed and `.write()` to still classifies Net — only the three
          // std streams are freed). Real-world sweep: nanoid/commander(×43)/bunyan/pino fabricated Net
          // purely from a `process.stdout.write` — the precision failure.
          if (eff && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
              && rootsAtStdStream(node.expression.expression))
            eff = null;
          if (eff) {
            rec.direct.add(eff);
            // SPEC §2 `fs` — refine an Fs we just PROVED with the direction its verb implies. DIRECT only
            // (never propagated over edges): a caller reaching one writer and one undetermined callee would
            // otherwise inherit ["write"] and thereby claim "writes but never reads" — the partial claim §2
            // forbids. An unrecognised verb adds nothing, so the field stays absent rather than half-true.
            if (eff === "Fs") {
              // A verb revealing no direction records the POISON marker "?" rather than nothing. Abstaining
              // would let a caller inherit a neighbour's ["write"] and claim "writes but never reads" over a
              // reach whose kind was never determined — the partial claim §2 forbids. Suppressed at emit.
              const ks = fsKind(mod, member);
              if (ks.length === 0) rec.fsKinds.add("?"); else for (const k of ks) rec.fsKinds.add(k);
            }
            // a κ rule that resolves to the Unknown trust-marker (node:vm code execution) is a direct
            // Unknown SOURCE — SPEC §4 requires a why on it, like eval's `reflect:eval`. (The rest of
            // the κ table is concrete effects, which carry no why.)
            if (eff === "Unknown") rec.why.add(`reflect:${mod.replace(/^node:/, "")}.${member}`);
          }
          // the literal surfaces, read only at a CLASSIFIED call (SPEC §2)
          if (eff === "Net") {
            // The host predicate runs against the EXTRACTED URL argument (arg0 — the URL/endpoint slot of
            // fetch/axios/the HTTP verbs), NEVER the first literal anywhere in the args: a trailing literal
            // in headers/body/options must not be read as the host (FINDING 6). Ollama's model decision runs
            // through the parsed host too, never a raw string that merely contains ":11434" (FINDING 1/9).
            const urlLit = urlArgLiteral(node, member);
            const ollama = ollamaFromUrlArg(urlLit);
            if (ollama === "capture-model" || ollama === "capture-plain") {
              const h = hostLiteral(urlLit);
              rec.hosts.add(h);
              // SPEC §1 ⟨0.13⟩ Llm host-literal refinement: a known model host makes this a model call
              // (Llm + Net — Net is never dropped), exactly as a jdbc URL classifies Db.
              for (const e of modelHostEffects(h)) rec.direct.add(e);
            } else {
              // No captured host literal. §1 ⟨0.13⟩ Ollama LOCAL endpoint (`localhost:11434`/`127.0.0.1:11434`):
              // refine to Llm but do NOT capture the host as a Net allowlist literal (java parity #2 —
              // preserve the host gate so `deny Llm` catches it while `allow Llm localhost` fails closed).
              if (ollama === "llm-no-capture") rec.direct.add("Llm");
              // MASKING fix: a host-ESTABLISHING Net call whose host is NOT a captured literal (runtime URL, or
              // built elsewhere) leaves the host invisible to the gate → mark the surface incomplete so a
              // benign literal can't mask it. ALLOWLIST of establishing forms only — NEVER use-calls
              // (write/end/non-dgram send), which would false-positive on `socket.connect("h").write(data)`
              // (the host is captured at connect). Under-catches an unlisted establishing verb (safe
              // direction); never over-flags a use-call.
              if (netEstablishing(member)) rec.incomplete.add("Net");
            }
          }
          // SPEC §1 ⟨0.13⟩ `Llm` model-SDK surface: a call into a curated model-provider client (the
          // scan-core MODEL_SDK regex, also the whole-module Net κ rule above) dispatches a model request
          // → Llm + Net. Net came from κ (eff === "Net"); add Llm on top. NO method-name gating (java
          // parity #1) — any call into these single-purpose clients is a model dispatch. Additive.
          if (isModelSdkPackage(mod)) rec.direct.add("Llm");
          if (eff === "Db") {
            const lit = firstStringLiteral(node);
            const before = rec.tables.size;
            for (const t of lit ? tablesInSql(lit) : []) rec.tables.add(t);
            // ORM route: `this.userRepository.find(…)` — the receiver's `Repository<UserEntity>`
            // type argument names the entity; its `@Entity("user")` decorator names the table.
            if (ts.isPropertyAccessExpression(node.expression)) {
              const rt = checker.getTypeAtLocation(node.expression.expression);
              for (const ta of checker.getTypeArguments?.(rt) ?? rt?.typeArguments ?? []) {
                const d = ta?.symbol?.declarations?.[0];
                const tbl = d && entityTables.get(d);
                if (tbl) rec.tables.add(tbl);
              }
            }
            // masking: a Db call that surfaced NO table (no SQL literal, no entity-typed receiver) reaches a
            // runtime/invisible table — a benign sibling query's literal table must not mask it. The entity
            // route above is NOT a literal so it still counts as visible (a captured table); only a fully
            // invisible query marks incomplete. `new` (a connection ctor) carries no table — skip it.
            if (rec.tables.size === before && member !== "new") rec.incomplete.add("Db");
          }
          if (eff === "Exec") {
            const lit = firstStringLiteral(node);
            if (lit) rec.cmds.add(lit.trim().split(/\s+/)[0]); // cosmetic cmds surface (any literal)
            // a known literal head refines the cliff (curl→Net, candor→Fs/Env); Exec stays. The head
            // MUST be argv[0] (programHeadLiteral), NOT any literal arg: `spawn(toolVar, "curl")`
            // names no static program, so its trailing literal must not fabricate Net (spec §4).
            const head = programHeadLiteral(node);
            if (head) for (const e of commandHeadEffects(head)) rec.direct.add(e);
            // masking (sweep [11]): an Exec call whose program head is NOT a static literal (runtime
            // command) leaves the command invisible. Establishing = the spawn fns; ChildProcess use-verbs
            // (kill/send/disconnect/ref/unref) carry no command and are excluded.
            else if (!EXEC_USE_VERBS.has(member)) rec.incomplete.add("Exec");
          }
          if (eff === "Fs") {
            const lit = firstStringLiteral(node);
            const pathCaptured = lit && /[/\\]|^[.~]/.test(lit); // path-shaped literals only
            if (pathCaptured) rec.paths.add(lit);
            // masking (sweep [11]): a path-taking fs.* call whose path is NOT a captured literal (runtime
            // path) leaves it invisible. fd/FileHandle USE-verbs (fd came from a prior open()) are excluded.
            else if (!FS_USE_VERBS.has(member)) rec.incomplete.add("Fs");
          }
          // CANDOR_DEPS: an unclassified call into a package with a loaded sibling report inherits
          // that function's recorded transitive effects (+ literal surfaces) by `hash`.
          let inheritedFromDep = false;
          if (!eff && crossDeps.size > 0 && !mod.startsWith("<")) {
            const nameDecl = memberSigOf(decl); // a function-typed property names its member one level up
            let localTail = nameDecl.name ? nameDecl.name.getText() : null;
            const owner3 = nameDecl.parent && nameDecl.parent.name ? nameDecl.parent.name.getText() : null;
            if (localTail && owner3 && (ts.isMethodSignature(nameDecl) || ts.isMethodDeclaration(nameDecl) || ts.isPropertySignature(nameDecl)))
              localTail = `${owner3}.${localTail}`;
            // `new DepClass()` — a CONSTRUCTOR declaration has NO name, so `localTail` stayed null and the
            // join was skipped entirely, even though the dependency's report carries the entry under
            // `<pkg>#<Class>.constructor` (every scan mints a `Class.constructor` unit, explicit ctor or
            // not, because field initializers run at construction). An effectful dependency constructor
            // was therefore absorbed silently at every `new` across the boundary — candor-spec
            // SOUNDNESS-VEIN-crossing-the-scan-boundary.md. Name it the way the producer hashed it.
            else if (!localTail && owner3 && ts.isConstructorDeclaration(decl))
              localTail = `${owner3}.constructor`;
            // A typed consumer resolves into `@types/<pkg>`; the dep's report hashes under `<pkg>`.
            const depMod = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
            // Owner-prefixed first (Owner.member), bare member as the fallback: a CJS dist scan
            // hashes units under the bare export name, while interface/object-shaped typings (the
            // common @types style) resolve the consumer's call to Owner.member — without the
            // fallback exactly the typed-consumer shape the chain targets never joined.
            const hit = localTail && (crossDeps.get(`${depMod}#${localTail}`)
              ?? (nameDecl.name ? crossDeps.get(`${depMod}#${nameDecl.name.getText()}`) : undefined));
            if (hit) { inheritedFromDep = true; applyDepHit(rec, hit); }
          }
          // unmatched external = (OPAQUE): contributes nothing — the curated-κ caveat C1. The
          // κ-coverage LEDGER makes the caveat per-scan evidence instead of a doc footnote: count
          // every npm package the code demonstrably calls that the classifier doesn't cover ("classifier doesn't cover" marker) and no sibling
          // report covers (the argon2 lesson — the blind spot landed on exactly the call a
          // security review cared about). Builtins are excluded: κ's builtin coverage is the
          // bounded frontier, and an unlisted builtin (path, util) is known-pure, not blind.
          if (!eff && !inheritedFromDep && !mod.startsWith("<")) {
            // The REAL package name first: a typed consumer of an untyped package resolves into
            // @types/<pkg>, and κ's tables/review lists hold the real name (/code-review: lodash
            // via @types/lodash was falsely disclosed — kappaKnows saw the unstripped name).
            const pkg = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
            const file = decl.getSourceFile().fileName;
            // SPEC §5.1: a package that DECLARES its effects (candorEffects in package.json) is read
            // at the declared-not-verified tier — its effects are attributed and it is NOT a blind
            // spot. Otherwise the κ ledger names it (an uncurated dependency the review must read).
            const declared = packageManifestEffects(file);
            const abstraction = unanswerableKey(decl);
            if (declared !== null) {
              for (const e of declared) rec.direct.add(e); // [] = declared pure: covered, adds nothing
            } else if (!kappaKnows(pkg) && !depCoveredPkgs.has(pkg) && crossesPackageBoundary(file)) {
              unlistedSeen.set(pkg, (unlistedSeen.get(pkg) ?? 0) + 1);
              // Per-fn HONESTY: this fn calls into a genuinely-blind package (κ-unknown, not dep-covered).
              // Recorded per fn, propagated transitively, emitted as `invisible` — so `inferred` is never an
              // unqualified completeness claim. This branch already IS the global-blind condition, so no
              // post-filter is needed (κ either knows a package or it doesn't).
              rec.blind.add(pkg);
              // ⟨0.21⟩ …and half 1 STILL speaks for a package whose only chained report declares itself
              // incomplete, which lands here because its coverage was withheld. See the twin in
              // `chargeExternalDecl`: the ledger hedge must ADD to the Unknown, never replace it, or the
              // completeness fix silently narrows `deny E Unknown[dispatch]` (standing bar item 0).
              if (abstraction && incompleteDepPkgs.has(pkg)) discloseUnanswerableKey(rec, pkg, abstraction);
            } else if (abstraction && depCoveredPkgs.has(pkg) && crossesPackageBoundary(file)) {
              // ⟨scan-boundary, half 1⟩ THE UNANSWERABLE KEY, candor-spec DEP-RECEIVER-TYPING-DESIGN.md.
              // A chained lookup that comes back empty has two readings with OPPOSITE evidential weight:
              //   * KEYED-AND-MISSED — the key names a BODY the dep scanned (`declare class C { m() }`,
              //     `declare function f()`), and the dep's report omits pure functions, so absence IS its
              //     answer (SPEC §2 rule 3). Silence is correct; nothing happens here.
              //   * NO ANSWERABLE KEY — resolution landed on an ABSTRACTION (an interface method/property
              //     signature, an anonymous type-literal member, an `abstract` member). There is no body
              //     under that name in the dependency, so its report can NEVER carry the key, whatever the
              //     implementations do. No question was asked, and silence answers none.
              // TypeScript reaches this case by a different road than rust: a receiver it genuinely cannot
              // type is `any`, which already reads `callback:` Unknown. Its unformed key is the receiver
              // typed to an abstraction the dependency's report has no vocabulary for — `build(): Fetcher`
              // exported over a `.d.ts` whose only implementation, `Client`, is what the dep actually
              // hashed. Measured: `go` was absent from the report entirely while the dep's own report read
              // `depkit#Client.fetch -> ['Fs']`.
              // THE THIRD CONJUNCT (`depCoveredPkgs.has(pkg)` — the dependency is CHAINED) is the arm
              // above, and it is load-bearing rather than incidental: for an UNCHAINED package the κ ledger
              // already discloses `invisible: [pkg]`, so a second voice would be pure false uncertainty. It
              // is exactly when the package IS covered that the ledger correctly falls silent and that
              // silence becomes the confident purity claim this rung exists to prevent.
              discloseUnanswerableKey(rec, pkg, abstraction);
            }
          }
        }
      }
      // the callee EXPRESSION being a plain identifier of function-typed parameter/field:
      // a PARAMETER defers to callback-flow resolution (below) — if every call site of this
      // function passes a NAMED local unit, the invocation resolves to those targets; otherwise
      // (or for fields/signatures) it is (UNKNOWN), never silent-pure (SPEC §4).
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        const d = sym && sym.valueDeclaration;
        if (d && ts.isParameter(d) && d.parent && nodeName.get(d.parent)) {
          const idx = d.parent.parameters.indexOf(d);
          const owner2 = nodeName.get(d.parent);
          (paramInvokes.get(owner2) ?? paramInvokes.set(owner2, new Set()).get(owner2)).add(idx);
        } else if (d && (ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d))) {
          rec.direct.add("Unknown"); // a callback value — genuinely indeterminate (SPEC §4)
          rec.why.add(`callback:${node.expression.getText()}`);
        }
      }
    }
  }
  // Reading process.env — the JVM System.getenv twin → Env. All the common idioms count, not just the
  // direct `process.env.KEY` dot access (see the process.env-recognition note above): dot/bracket access
  // on process.env or a confirmed alias, destructuring a key off it, and the `in` membership test.
  {
    const markEnv = () => { const owner = enclosing(node); if (owner) fns.get(owner).direct.add("Env"); };
    // `process.env.KEY` / `env.KEY` (dot) and `process.env["KEY"]` / `env[k]` (bracket, literal OR dynamic key).
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && readsProcessEnv(node.expression)) {
      markEnv();
    }
    // `const {KEY} = process.env` / `const {KEY} = env` — the object-binding pattern's initializer reads env.
    else if (ts.isVariableDeclaration(node) && node.name && ts.isObjectBindingPattern(node.name)
             && node.initializer && readsProcessEnv(node.initializer)) {
      markEnv();
    }
    // `"KEY" in process.env` / `"KEY" in env` — the `in` operator's right operand reads env.
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword
             && readsProcessEnv(node.right)) {
      markEnv();
    }
    // `{...process.env}` / `[...process.env]` / `f(...process.env)` — spreading env enumerates every key.
    else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && readsProcessEnv(node.expression)) {
      markEnv();
    }
    // `Object.assign(process.env, …)` / `Object.keys(env)` / `Reflect.set(process.env, …)` / `JSON.stringify(env)`
    // / `structuredClone(env)` — a builtin that reads/writes every key of an env-object argument.
    else if (envTouchingBuiltinCall(node) && node.arguments.some((a) => readsProcessEnv(a))) {
      markEnv();
    }
    // `for (const k in process.env)` — the for-in loop enumerates every key of the environment.
    else if (ts.isForInStatement(node) && readsProcessEnv(node.expression)) {
      markEnv();
    }
  }
  // Runtime GLOBALS reached as CALLS with no import for the κ resolver to classify: `process.hrtime()`/
  // `.hrtime.bigint()` is a monotonic clock read (Clock); `process.send(...)` is the child↔parent IPC
  // channel (Ipc); the global `fetch(...)` is the standard modern HTTP client (Net). Matched on the
  // callee — `process.*` by exact text (mirroring the process.env match), `fetch` by identifier whose
  // symbol is NOT a local declaration (so a project's own `fetch` shadow never fabricates Net).
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const ctext = callee.getText().replace(/\s+/g, "");
    let geff = null;
    // The member path AFTER the global `process` object, or null: `process.hrtime` → "hrtime",
    // `globalThis.process.hrtime.bigint` → "hrtime.bigint", `(global as any).process.send` → "send". Reuses
    // `identIsGlobalProcess` (which handles bare `process` AND `globalThis`/`global.process`, unwrapping casts,
    // and rejects a project-local `const process = {…}` shadow so a pure local method never fabricates Clock/Ipc).
    const processMemberPath = () => {
      if (!ts.isPropertyAccessExpression(callee)) return null;
      const outer = [];
      let n = callee;
      while (ts.isPropertyAccessExpression(n)) {
        if (identIsGlobalProcess(n.expression)) return [n.name.text, ...outer.reverse()].join(".");
        outer.push(n.name.text);
        n = n.expression;
      }
      return null;
    };
    const pmp = processMemberPath();
    if (pmp === "hrtime" || pmp === "hrtime.bigint") geff = "Clock"; // a monotonic clock read
    else if (pmp === "send") geff = "Ipc";                          // the child↔parent IPC channel
    else if (ts.isIdentifier(callee) && importedFromNetPkg(callee))
      geff = "Net"; // a bare call to an HTTP-client default/named import (installed → sig resolves here) — #13

    else if (ts.isIdentifier(callee) && callee.text === "fetch"
             && !(checker.getSymbolAtLocation(callee)?.declarations ?? [])
                  .some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName))))
      geff = "Net";
    // the fully-qualified global fetch — `globalThis.fetch`/`window.fetch`/`self.fetch` — is a
    // PropertyAccess callee the bare-identifier guard above misses, so it read silent-pure. Mirror the
    // `eval` global-qualifier handling (a runtime global a project would not shadow).
    else if (ctext === "globalThis.fetch" || ctext === "window.fetch" || ctext === "self.fetch")
      geff = "Net";
    if (geff) {
      const owner = enclosing(node);
      if (owner) {
        const rec = fns.get(owner);
        rec.direct.add(geff); // Net is added unconditionally for a global fetch (never gated on host capture)
        // The global `fetch(url)` is a host-bearing Net call — capture its URL-ARGUMENT host (arg0, like the
        // κ-Net path) so the allowlist/masking gate sees it, and refine to `Llm` on a known model host (SPEC
        // §1 ⟨0.13⟩). Without this, `fetch("https://api.anthropic.com/…")` read bare Net with no host at all.
        if (geff === "Net") {
          // Host predicate runs against arg0 (the URL slot), NEVER the first literal anywhere in the args:
          // `fetch(runtimeUrl, "literal")` must not read the trailing literal as the host (FINDING 6). Ollama's
          // model decision runs through the parsed host, never a raw ":11434" substring (FINDING 1/9).
          const urlLit = urlArgLiteral(node);
          const ollama = ollamaFromUrlArg(urlLit);
          if (ollama === "capture-model" || ollama === "capture-plain") {
            const h = hostLiteral(urlLit);
            rec.hosts.add(h);
            for (const e of modelHostEffects(h)) rec.direct.add(e);
          } else if (ollama === "llm-no-capture") {
            // §1 ⟨0.13⟩ dotless local Ollama endpoint: Llm WITHOUT capturing the host (java parity #2).
            rec.direct.add("Llm");
          } else if (urlArgIsRuntimeString(node)) {
            // Only a RUNTIME STRING url (template/concat/`string`-typed value) masks the host → fail closed,
            // like a host-establishing κ call. A structured `new URL(...)`/`Request` arg (or absent arg) did
            // NOT mask a literal — it passed clean pre-Llm-port, so it must NOT regress to fail-closed (FINDING 7).
            rec.incomplete.add("Net");
          }
        }
      }
    }
    // dynamic `require(<non-literal>)` — the CJS twin of `import(m)` (which already discloses Unknown):
    // it loads an arbitrary module and runs its top-level code, so the effects are opaque → Unknown. A
    // LITERAL `require('fs')` is a static, resolvable load (pure until a member call), so ONLY a
    // non-literal arg is the escape. Gated like `fetch`: a bare `require` whose symbol is NOT a project
    // declaration (a project's own `function require()` shadow never fabricates). Under-disclose Unknown,
    // never a concrete effect. (Found by real-world corpus testing; sibling of the node:vm fix.)
    if (ts.isIdentifier(callee) && callee.text === "require"
        && node.arguments?.length === 1 && !ts.isStringLiteralLike(node.arguments[0])
        && !(checker.getSymbolAtLocation(callee)?.declarations ?? [])
             .some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName)))) {
      const owner = enclosing(node);
      if (owner) { fns.get(owner).direct.add("Unknown"); fns.get(owner).why.add("reflect:require"); }
    }
    // Object.assign(target, ...sources) copies each SOURCE's own enumerable props → invokes their
    // getters (the object-spread twin). Enumerate the sources' local getters.
    if (callee.getText().replace(/\s+/g, "") === "Object.assign") {
      const owner = enclosing(node);
      for (const src of (node.arguments ?? []).slice(1)) {
        enumerateGetters(owner, checker.getTypeAtLocation(src));
      }
    }
  }
  // GET/SET ACCESSOR access (the silent-pure-accessor fix): a property read that resolves to a
  // getter, or a property assignment whose target resolves to a setter, is effectively a call into
  // the accessor body — model it as a call EDGE so the accessor's effects propagate (like a method
  // call), never silently pure. A resolved-but-UNSEEN accessor (external declaration) reads Unknown,
  // following the same posture as an unresolvable call (SPEC §4).
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    // Is this property access an assignment TARGET? A simple `x.prop = v` invokes the SETTER only. A
    // COMPOUND/LOGICAL assignment (`+=`,`-=`,`??=`,`||=`,`&&=`,…) reads the current value AND writes — both
    // the getter and the setter run (sweep [10]; pre-fix only a bare `=` was a setter site, so an effectful
    // setter under `+=`/`??=` read PURE). A DESTRUCTURING-assignment target (`({k: x.prop} = src)` /
    // `[x.prop] = arr`) is also a setter site, invisible to the simple-LHS test (sweep [32]).
    const p = node.parent;
    const isBinAssign = p && ts.isBinaryExpression(p) && p.left === node;
    const simpleAssign = isBinAssign && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const compoundAssign = isBinAssign && !simpleAssign
      && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const recordKind = (kind) => {
      const hit = accessorAt(node, kind);
      if (hit) {
        const owner = enclosing(node);
        if (!owner) return;
        const an = hit.decl.parent?.name?.getText?.() ?? "?";
        const pn = node.name?.getText?.() ?? node.argumentExpression?.getText?.() ?? "?";
        recordAccessorHit(owner, hit, `${an}.${pn}`);
        return;
      }
      // No type-level accessor — try the `Object.defineProperty` runtime-accessor index. The checker
      // types target.key as a data prop, so an effectful defineProperty getter/setter is invisible to
      // accessorAt; consult definePropForceTarget so the forcing site edges to the descriptor unit
      // (precise) instead of reading silent-pure (the cardinal sin). A descriptor we minted is always
      // local, so this is an EDGE; never Unknown for a resolved-and-seen descriptor.
      const dpNode = definePropForceTarget(node, kind);
      if (dpNode) {
        const owner = enclosing(node);
        const t = owner && nodeName.get(dpNode);
        if (t) fns.get(owner).edges.add(t);
        return;
      }
      // A computed-key descriptor accessor on this receiver's target means `recv.<anything>` MIGHT
      // invoke an effectful accessor whose key we couldn't pin — disclose Unknown (never silent-pure),
      // matching the syntactic object-literal-getter posture. Only when the receiver binds to a target
      // that carries a dynamic-key descriptor of the right kind.
      if (definePropDynamicKey.size > 0) {
        const rsym0 = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          ? checker.getSymbolAtLocation(node.expression) : null;
        const rsym = rsym0 && (rsym0.flags & ts.SymbolFlags.Alias)
          ? (() => { try { return checker.getAliasedSymbol(rsym0); } catch { return rsym0; } })() : rsym0;
        const kinds = (rsym && definePropDynamicKey.get(rsym)) || (rsym0 && definePropDynamicKey.get(rsym0));
        if (kinds && kinds.has(kind)) {
          const owner = enclosing(node);
          if (owner) { fns.get(owner).direct.add("Unknown"); fns.get(owner).why.add(`reflect:defineProperty:dynamic-key`); } // dynamic-key descriptor install — metaprogramming, canonical `reflect:`
        }
      }
    };
    if (simpleAssign || isDestructuringAssignTarget(node)) recordKind("set");
    else if (compoundAssign) { recordKind("get"); recordKind("set"); }
    else recordKind("get");
  }
  // OBJECT-DESTRUCTURING getter read (`const { prop } = obj`): each bound property is a READ that may
  // resolve to a getter whose body does I/O — the binding-pattern analog of `obj.prop`, invisible to
  // the property-access arm above because there is no PropertyAccess/ElementAccess node. (ARRAY
  // destructuring is ITERATION, handled below; object destructuring copies named own/inherited props,
  // invoking each getter.) Resolve every bound key as a property on the initializer's type; a rest
  // element / computed key can't be pinned to one accessor, so it's skipped (no fabrication).
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    const owner = enclosing(node);
    if (owner) {
      const recvType = checker.getTypeAtLocation(node.initializer);
      for (const el of node.name.elements) {
        if (el.dotDotDotToken) { enumerateGetters(owner, recvType); continue; } // `...rest` copies every
        // remaining prop → invokes every (remaining) getter; enumerate all (the bound ones double-handle).
        const key = el.propertyName ?? el.name; // `{prop}` shorthand, or `{prop: alias}`
        const keyName = ts.isIdentifier(key) ? key.text
          : ts.isStringLiteralLike(key) ? key.text : null;
        if (keyName === null) continue; // computed key (`{[k]: v}`) — unresolvable to one property
        const hit = accessorFromSym(recvType?.getProperty?.(keyName), "get");
        if (hit) recordAccessorHit(owner, hit, keyName);
      }
    }
  }
  // ITERATION desugaring (HIGH): `for (const x of bag)`, `for await (…)`, `[...bag]`, `const [a]=bag`,
  // `Array.from(bag)` all lower to `bag[Symbol.iterator]().next()`. Edge the enclosing fn to the
  // iterable's local `[Symbol.iterator]`/`[Symbol.asyncIterator]` method (and the produced iterator's
  // local `next`). A built-in iterable (array/string/Map) resolves non-local → no edge → stays pure.
  {
    let iterExpr = null, iterAsync = false;
    if (ts.isForOfStatement(node)) { iterExpr = node.expression; iterAsync = !!node.awaitModifier; }
    else if (ts.isSpreadElement(node)) iterExpr = node.expression; // [...bag] / f(...bag)
    else if (ts.isSpreadAssignment(node)) {
      iterExpr = node.expression; // {...bag} — object spread is NOT iteration (copies own enumerable
      // props, no [Symbol.iterator]); wellKnownSymbolMember finds none and edges nothing for iteration.
      // But the copy DOES invoke each source getter — enumerate them (the silent-pure object-spread hole).
      enumerateGetters(enclosing(node), checker.getTypeAtLocation(node.expression));
    }
    else if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer)
      iterExpr = node.initializer; // const [a] = bag
    else if (ts.isCallExpression(node) && node.arguments?.[0]
             && node.expression.getText() === "Array.from")
      iterExpr = node.arguments[0]; // Array.from(bag) — the iterable form (arg0 is iterated)
    if (iterExpr) {
      const owner = enclosing(node);
      if (owner) {
        const targets = iterationTargets(iterExpr, iterAsync);
        edgeToTargets(fns.get(owner), targets);
        // Opaque-iterable honesty: a param/`any`/type-parameter iterable runs caller-supplied iterator
        // code — disclose Unknown, mirroring the opaque-callback `call:param` posture (cardinal-sin
        // guard). Skipped when iteration already resolved a LOCAL unit (real effect already edged).
        noteOpaqueIteration(node, iterExpr, targets.length > 0);
      }
    }
  }
  // `using r = expr` / `await using r = expr` (MED): the scope-exit guarantees `r[Symbol.dispose]()` /
  // `r[Symbol.asyncDispose]()`. Edge the enclosing fn to the resolved LOCAL dispose method.
  if (ts.isVariableStatement(node)) {
    const fl = node.declarationList.flags;
    const isUsing = (fl & ts.NodeFlags.Using) || (fl & ts.NodeFlags.AwaitUsing);
    if (isUsing) {
      const isAwait = !!(fl & ts.NodeFlags.AwaitUsing);
      const prefixes = isAwait ? ["__@asyncDispose", "__@dispose"] : ["__@dispose"];
      const owner = enclosing(node);
      for (const d of node.declarationList.declarations) {
        if (!d.initializer || !owner) continue;
        const t = checker.getTypeAtLocation(d.initializer);
        const disposeDecl = declOfSym(wellKnownSymbolMember(t, prefixes));
        if (disposeDecl && declIsLocal(disposeDecl)) edgeToTargets(fns.get(owner), [disposeDecl]);
      }
    }
  }
  // IMPLICIT VALUE-COERCION desugaring (HIGH): the JS coercion protocol invokes a user method the AST
  // walk never visits as a CallExpression. Resolve the operand's type's coercion member and edge to it
  // when LOCAL (a built-in/external member resolves non-local → no edge → stays pure). NEVER fabricate.
  {
    const owner = enclosing(node);
    const recOf = () => owner && fns.get(owner);
    // 1+2. BINARY operators. `+` with an OBJECT operand triggers toString/valueOf (string+string,
    // number+number have no coercion method — stay pure, gated by mayCoerceObject). Arithmetic
    // (`-`/`*`/`/`/`%`/`**`) and relational (`<`/`>`/`<=`/`>=`) coerce to a NUMBER → valueOf (then
    // toString). `[Symbol.toPrimitive]` is preferred by JS over both — always consulted.
    if (ts.isBinaryExpression(node) && owner) {
      const op = node.operatorToken.kind;
      const K = ts.SyntaxKind;
      const ARITH = new Set([K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken,
        K.AsteriskAsteriskToken, K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken,
        K.GreaterThanEqualsToken, K.AmpersandToken, K.BarToken, K.CaretToken,
        K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken]);
      const COMPOUND_ARITH = new Set([K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken,
        K.PercentEqualsToken, K.AsteriskAsteriskEqualsToken]);
      if (op === K.PlusToken || op === K.PlusEqualsToken) {
        // string concat / `+` arithmetic: an OBJECT operand is coerced via toString OR valueOf (the
        // order depends on the hint, but EITHER may run — edge to both when local). string+string and
        // number+number have only primitive operands → mayCoerceObject false → no edge (pure).
        for (const operand of [node.left, node.right]) {
          if (mayCoerceObject(operand))
            chargeCoercion(recOf(), operand, ["valueOf", "toString"], true);
        }
      } else if (ARITH.has(op) || COMPOUND_ARITH.has(op)) {
        for (const operand of [node.left, node.right]) {
          if (mayCoerceObject(operand))
            chargeCoercion(recOf(), operand, ["valueOf", "toString"], true);
        }
      }
    }
    // 2. UNARY arithmetic `-x` / `+x` / `~x` coerces the operand to a number → valueOf (then toString /
    // [Symbol.toPrimitive]). (`!x` is boolean coercion — no method call; excluded.)
    if (ts.isPrefixUnaryExpression(node) && owner
        && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken
            || node.operator === ts.SyntaxKind.TildeToken)
        && mayCoerceObject(node.operand)) {
      chargeCoercion(recOf(), node.operand, ["valueOf", "toString"], true);
    }
    // 1. TEMPLATE expression `` `${x}` ``: each interpolated substitution is string-coerced → toString
    // (then [Symbol.toPrimitive]/valueOf). (A TaggedTemplate is handled separately below — the tag fn
    // receives the raw substitution values, no per-sub coercion, so we exclude tagged templates here.)
    if (ts.isTemplateExpression(node) && owner && !ts.isTaggedTemplateExpression(node.parent)) {
      for (const span of node.templateSpans)
        if (mayCoerceObject(span.expression))
          chargeCoercion(recOf(), span.expression, ["toString", "valueOf"], true);
    }
    // 5. ARRAY stringification through an EXPLICIT es-lib call: `parts.join("/")` /
    // `entries.toString()` / `entries.toLocaleString()`. Resolution lands on the pure `Array.prototype`
    // builtin, so the ELEMENTS' `toString` — which join genuinely invokes on each one — is never walked.
    // Gated on the receiver having a NUMERIC INDEX type, so a `.join()`/`.toString()` on an ordinary
    // local object (already resolved by the normal call path) is not re-charged with its own coercion.
    if (ts.isCallExpression(node) && owner && ts.isPropertyAccessExpression(node.expression)
        && ["join", "toString", "toLocaleString"].includes(node.expression.name?.getText?.())
        && arrayElementTypeOf(node.expression.expression)) {
      chargeCoercion(recOf(), node.expression.expression, ["toString", "valueOf"], true);
    }
    // 1+4. CALL forms `String(x)` (→ toString) and `JSON.stringify(x)` (→ toJSON). These resolve to the
    // es-lib `StringConstructor`/`JSON.stringify` signature (not the user method), so the CallExpression
    // walk above never follows the coercion. Edge to the argument's LOCAL toString / toJSON.
    if (ts.isCallExpression(node) && owner && node.arguments?.[0]) {
      const callee = node.expression.getText().replace(/\s+/g, "");
      const arg0 = node.arguments[0];
      if (callee === "String" && ts.isIdentifier(node.expression) && mayCoerceObject(arg0))
        chargeCoercion(recOf(), arg0, ["toString", "valueOf"], true);
      // 4. STRINGIFYING SINK: a call that hands its arguments to a formatter which invokes
      // `toString`/`toJSON` INSIDE the library — `console.log("entry: %s", e)`, `logger.warn("{}", e)`.
      // This is the shape the four-way vein was found on (HikariCP → SLF4J `MessageFormatter` →
      // `PoolEntry.toString` → the clock): statically the site resolves cleanly to the LOG call, so the
      // Log effect lands and everything looks accounted for, while the argument's own effect is absorbed
      // silently. No coercion node exists at the call site for the AST walk to see.
      //
      // The SITE table is deliberately small and named (console + the logging level-methods, mirroring
      // the candor-java reference fix); the DENYLIST-over-allowlist rule applies to the TARGETS, which is
      // where a forgotten case must land on the safe side: we never enumerate which `toString`s are
      // effectful, we edge to whatever local one exists and let the effect analysis decide. A sink whose
      // argument is a string/number/plain-object/library type resolves to no local member and therefore
      // contributes NOTHING — the mechanism is inert on the overwhelming majority of log calls.
      //
      // Over-approximation, disclosed: Node only runs a user `toString` for a `%s` specifier position
      // (a bare extra argument goes through `util.inspect`, which does not). We charge every object-typed
      // argument rather than parsing the format string, because the format string is frequently not a
      // literal and an under-charge here is the cardinal sin while an over-charge is merely conservative.
      else if (isStringifyingSink(node)) {
        for (const arg of node.arguments) {
          if (mayCoerceObject(arg)) chargeCoercion(recOf(), arg, ["toString", "valueOf"], true);
          // A structured logger (pino/bunyan/winston) JSON-serializes its argument → `toJSON`.
          chargeCoercion(recOf(), arg, ["toJSON"], false);
        }
      }
      // `"" + x` is covered by the binary arm; `String(x)` is the explicit conversion form.
      else if (callee === "JSON.stringify")
        // toJSON is consulted regardless of operand shape (JSON.stringify checks for it on any value);
        // a plain object with no LOCAL toJSON resolves to nothing → pure (no fabrication). NO Symbol-
        // toPrimitive here — JSON.stringify uses toJSON only, not the primitive-coercion protocol.
        chargeCoercion(recOf(), arg0, ["toJSON"], false);
    }
  }
  // TAGGED TEMPLATE (LOW): `` tag`…` `` calls `tag(strings, ...subs)`. getResolvedSignature resolves
  // the TaggedTemplateExpression to the tag fn cleanly — a node form the CallExpression walk never
  // visits. Edge to the tag when LOCAL; a built-in/external tag (`String.raw`) resolves non-local and
  // edges nothing (pure), matching the external-call posture.
  if (ts.isTaggedTemplateExpression(node)) {
    const owner = enclosing(node);
    if (owner) {
      const rec = fns.get(owner);
      const sig = checker.getResolvedSignature(node);
      const decl = sig && sig.declaration;
      if (decl && declIsLocal(decl)) edgeToTargets(rec, [decl]);
      else if (decl) {
        // An EXTERNAL tag — a template-literal SQL client's `sql`…`` (postgres.js/@vercel/postgres/slonik),
        // `String.raw`, etc. The CallExpression walk never visits this node, so classify it exactly as a regular
        // external call: κ effect if modeled; otherwise the κ-ledger `invisible`/`blind` disclosure an unmodeled
        // call gets (never silent-pure). A pure builtin tag (String.raw, from the TS lib, not node_modules) adds
        // nothing — no fabrication.
        const mod = declModule(decl);
        const member = decl.name ? decl.name.getText() : "";
        const eff = kappa(mod, member);
        if (eff) { rec.direct.add(eff); if (eff === "Unknown") rec.why.add(`reflect:${mod.replace(/^node:/, "")}.${member}`); }
        else {
          const file = decl.getSourceFile().fileName;
          const pkg = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
          const declared = packageManifestEffects(file);
          if (declared !== null) { for (const e of declared) rec.direct.add(e); }
          else if (!mod.startsWith("<") && !kappaKnows(pkg) && !depCoveredPkgs.has(pkg)
              && crossesPackageBoundary(file)) {
            unlistedSeen.set(pkg, (unlistedSeen.get(pkg) ?? 0) + 1);
            rec.blind.add(pkg);
          }
        }
      }
    }
  }
  ts.forEachChild(node, visitCalls);
}
for (const sf of sources) visitCalls(sf);

// ---- pass 2b: callback-flow resolution (the callback_named move) ----------------------------------
// A fn invoking its parameter i resolves to the named targets IF this project shows call sites and
// EVERY one passed a named local unit at i. Any opaque arg — or NO visible call site (the fn may be
// exported; outside callers can pass anything) — keeps the honest Unknown.
for (const [fnName, idxs] of paramInvokes) {
  const rec = fns.get(fnName);
  if (!rec) continue;
  const slots = callbackArgs.get(fnName);
  for (const idx of idxs) {
    const cell = slots?.get(idx);
    if (cell && !cell.opaque && cell.targets.size > 0) {
      for (const t of cell.targets) rec.edges.add(t);
    } else {
      rec.direct.add("Unknown");
      rec.why.add(`callback:param#${idx}`); // an opaque (or externally-callable) callback parameter
    }
  }
}

// ---- pass 2c: the effect-polymorphism fix — process.env aliased THROUGH parameters (transitive) ------
// A function that writes `x[k] = v` is pure in isolation (mutating a caller's object is not an external
// effect). But when the caller passes `process.env` (or a confirmed alias) in as that object, the write lands
// on the real environment — an Env effect the per-fn syntactic classifier cannot see at the leaf (the classic
// false all-clear; found on dotenv's `config(){ let pe=process.env; populate(pe) }` → `populate(pe){ pe[k]=v }`).
// We close it soundly by tracking, to a fixpoint, which VARIABLE SYMBOLS are env-fed — a parameter a call fills
// with an env source, a parameter fed a forwarded env-fed argument (transitive), and any local `= env-fed` alias
// — then attributing the env effect to the INNERMOST unit whose body writes an env-fed symbol (its own parameter
// OR one it captures), through ANY assignment operator. It stays GATED on a real process.env source, so it fires
// only on the rare effect-polymorphic write, never the benign argument-mutating majority. A must-source
// (process.env / an unreassigned alias) → Env; a may-source (a reassignable union) → Unknown (disclose, never
// fabricate). Direct `process.env[k]=v` / `envAlias[k]=v` are already Env via the process.env pass above.
const envFed = new Map();  // variable Symbol -> "env" (proven) | "unknown" (possible)
const setFed = (sym, kind) => {
  if (!sym) return false;
  const cur = envFed.get(sym);
  if (cur === kind || cur === "env") return false; // no change / already the stronger kind
  envFed.set(sym, kind); return true;              // new, or upgrade "unknown" -> "env"
};
// The env-source kind an expression denotes, or null: process.env / a MUST-alias → "env"; a MAY-alias
// (ever-`=process.env`, reassignable) → "unknown"; an identifier already known env-fed → its recorded kind.
const envSourceKind = (expr) => {
  if (isProcessEnvExpr(expr) || identIsEnvAlias(expr)) return "env";
  if (ts.isIdentifier(expr)) {
    if (identIsEnvMayAlias(expr)) return "unknown";
    const k = envFed.get(checker.getSymbolAtLocation(expr));
    if (k) return k;
  }
  return null;
};
// the ROOT symbol of a mutation target: `a.b[c] = …` / `a[k] = …` → the symbol of `a`.
const rootSymbolOf = (lhs) => {
  let n = lhs;
  while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression;
  return ts.isIdentifier(n) ? checker.getSymbolAtLocation(n) : null;
};
const isAssignOp = (k) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

// (A) FIXPOINT: seed env-fed variables from call-argument flow and local aliases until stable.
//  - a call `f(…, src, …)` where `src` is an env source (or already env-fed) → f's MATCHING PARAMETER is env-fed,
//    positional up to the first spread. An env source AT/AFTER a spread has an indeterminate parameter position,
//    so every plain parameter of the callee is conservatively marked "unknown" (disclose, never a precise-but-
//    wrong Env). A spread/rest DESTINATION receives values off the object, not the object itself → never env-fed.
//    Callee parameters are resolved as SYMBOLS via the checker, so an overload/renamed callee still joins (no
//    name-key mismatch); the write rule below likewise keys on symbols.
//  - a binding `const t = <env source>` / `t = <env source>` → t is env-fed (captures aliases + alias chains).
const propagateOnce = () => {
  let changed = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const params = checker.getResolvedSignature(node)?.declaration?.parameters;
      if (params) {
        let pos = 0, sawSpread = false;
        for (const arg of node.arguments ?? []) {
          if (ts.isSpreadElement(arg)) { sawSpread = true; continue; } // spread consumes ≥0 params; later positions unknown
          const kind = envSourceKind(arg);
          if (kind) {
            if (!sawSpread && pos < params.length) {
              const p = params[pos];
              if (!p.dotDotDotToken && ts.isIdentifier(p.name)) changed = setFed(checker.getSymbolAtLocation(p.name), kind) || changed;
            } else { // env source at an indeterminate position → mark every plain param "unknown" (sound over-approx)
              for (const p of params) if (!p.dotDotDotToken && ts.isIdentifier(p.name)) changed = setFed(checker.getSymbolAtLocation(p.name), "unknown") || changed;
            }
          }
          pos++;
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      const kind = envSourceKind(node.initializer);
      if (kind) changed = setFed(checker.getSymbolAtLocation(node.name), kind) || changed;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const kind = envSourceKind(node.right);
      if (kind) changed = setFed(checker.getSymbolAtLocation(node.left), kind) || changed;
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of sources) visit(sf);
  return changed;
};
let envRounds = 0;
while (propagateOnce() && envRounds++ < 64) { /* to fixpoint (bounded — chain depth + 1 in practice) */ }

// (B) WRITE rule: a unit whose body writes an env-fed variable (own param OR captured) performs its env effect.
//     Attributed to the INNERMOST enclosing unit — the frame the runtime oracle witnesses the write in, so a
//     write inside a closure lands on that closure's own unit (matching attribution). Any assignment operator
//     (`=`, `||=`, `+=`, …) counts, and a `delete env.k` mutation counts too.
const flagEnvWrite = (node, root) => {
  const kind = envFed.get(root);
  if (!kind) return;
  const rec = fns.get(enclosing(node) ?? "");
  if (!rec) return;
  if (kind === "env") { rec.direct.add("Env"); rec.why.add("env-write"); }
  else { rec.direct.add("Unknown"); rec.why.add("env-maybe-write"); }
};
const scanEnvWrites = (node) => {
  if (ts.isBinaryExpression(node) && isAssignOp(node.operatorToken.kind)
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
    const r = rootSymbolOf(node.left); if (r) flagEnvWrite(node, r);
  } else if (ts.isDeleteExpression(node)
      && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
    const r = rootSymbolOf(node.expression); if (r) flagEnvWrite(node, r);
  } else if (envTouchingBuiltinCall(node)) {
    // an env-fed variable handed to a whole-object builtin (`Object.assign(t, o)`, `Object.keys(t)`, …) has its
    // keys read/written — the same env effect through the parameter, attributed to the innermost unit.
    for (const a of node.arguments) { const r = ts.isIdentifier(a) ? checker.getSymbolAtLocation(a) : null; if (r && envFed.has(r)) { flagEnvWrite(node, r); break; } }
  } else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && ts.isIdentifier(node.expression)) {
    const r = checker.getSymbolAtLocation(node.expression); if (r && envFed.has(r)) flagEnvWrite(node, r); // `{...envFedParam}`
  } else if (ts.isForInStatement(node) && ts.isIdentifier(node.expression)) {
    const r = checker.getSymbolAtLocation(node.expression); if (r && envFed.has(r)) flagEnvWrite(node, r); // `for (k in envFedParam)`
  }
  ts.forEachChild(node, scanEnvWrites);
};
for (const sf of sources) scanEnvWrites(sf);

// ---- pass 2f: the MODULE-IMPORT edge (spec §2 initializer unit) -----------------------------------
// Importing a module RUNS its top level, so whatever imports it reaches whatever that module's
// initializer does. candor-ts modelled the initializer UNIT (⟨0.14⟩) but never the EDGE INTO it: `app.js`
// requiring an effectful `dep.js` read sound-complete pure while `dep.<module>` correctly read {Env} two
// lines away — a false all-clear, found on real code (candor-spec SOUNDNESS-VEIN-initializer-edge.md).
// candor-java has the equivalent edge already (a GETSTATIC forces the owner's `<clinit>`) and is the
// reference for the shape.
//
// Only specifiers that resolve INSIDE the scanned set get an edge. Both ends are then analyzed, so the
// answer is exact and needs no `Unknown` — and it cannot flood, because an edge into a PURE initializer
// yields a pure unit and pure units are omitted from the report. A bare specifier (an external package) is
// left exactly as it was: that half of the vein needs a dependency's own report, and blanket-disclosing it
// measured at 60-100% of modules, which would make the initializer unit useless rather than honest.
//
// The edge attributes to `enclosing`, not unconditionally to `<module>`: a top-level import is the module
// initializer's business, while a `require()` inside a function is that FUNCTION's reach. Node caches
// modules so the top level runs once, but `S` is an all-paths over-approximation (§3.3) — some execution
// does perform it, and charging every site that could be the first is the sound direction.
const MODULE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
                     "/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"];
function resolveProjectModule(spec, fromFile) {
  if (!spec.startsWith(".")) return null;            // bare specifier: external, not this edge
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const e of MODULE_EXTS) if (projectFiles.has(base + e)) return base + e;
  return null;
}
// Which of a chained dependency's module initializers an `import "pkg"` actually runs. `pkg#<relpath>
// .<module>` is per FILE, and the entry unit's `inferred` already carries its transitive imports (the
// closure computed above), so asking for the entry is both narrow and complete — no reachability guess,
// and a published-but-unimported `example/dns.js` keeps its own key that nobody looks up.
//
// COMPATIBILITY, both directions, and the second one is NOT what the first version of this comment said it
// was. The key is wire-visible, so the two builds can meet either way round.
//
// A NEW consumer over an OLD report (module units all hashed `<pkg>#<module>`) is handled here. The bare
// `<module>` tail is a STRUCTURAL discriminator, not a version guess — no engine emits one now, since every
// local carries its module path — so the old key is honoured and gives back its old (union) answer. Silence
// would have been the wrong default: resolving nothing would read the import as pure and turn a precision
// fix into the under-report this vein exists to close. The PRECISE key is tried first, so a report that
// somehow carries both is answered by the per-file one rather than by the union it supersedes.
//
// An OLD consumer over a NEW report is NOT covered, and §2.1 CANNOT cover it — the earlier claim that "an
// OLD consumer over a NEW report treats the whole report as stale and downgrades it to Unknown" is false.
// Staleness rewrites the CONTENT of the entries a report carries; it can never manufacture a key the report
// does not contain, so a consumer whose only lookup is `<pkg>#<module>` misses whatever the version says.
// Measured, pre-per-file build as the consumer over a report from this one: the importer is ABSENT from
// `functions` — a ⟨0.21⟩ purity claim — and `deny Fs` sits at exit 0 where the single-tree control is exit 1
// in both arms; with the report's version altered so the consumer calls it stale, the ordinary call join
// does downgrade to `Unknown` and the import edge stays exactly as absent as before.
//
// So the build id MUST move with a wire-key change — it is what arms every §2.1 protection that does work
// (ordinary call joins downgrade, the AS-EFF-005 baseline guard invalidates), and leaving two builds
// indistinguishable disarms all of them — but it is not what closes this, and neither is anything a new
// report could carry: the old consumer's code is frozen and reads exactly one discriminator,
// `candor.version`, so a structural field would be inert in the only direction that needs it. The fix that
// IS available is forward-looking and lives in the loader: a stale report no longer grants COVERAGE, so
// from this build on, a key an untrusted report fails to answer falls back to the κ ledger's `invisible`
// hedge instead of reading pure, and an import backed only by a stale report discloses `Unknown`.
const depEntryCache = new Map();
function depInitCell(pkg, subpath) {
  const ck = `${pkg} ${subpath}`;
  if (!depEntryCache.has(ck)) depEntryCache.set(ck, resolveDepEntryKey(pkg, subpath));
  const key = depEntryCache.get(ck);
  if (key && crossDeps.has(key)) return crossDeps.get(key);
  const old = crossDeps.get(`${pkg}#<module>`);
  if (old) return old;                                // pre-per-file report: unchanged behaviour
  if (key) return undefined;                          // per-file report, and this module is pure: silence
  // The package is not on disk, or its entry cannot be resolved (a conditional/wildcard `exports` map this
  // does not model). Nothing licenses narrowing then, so fall back to the UNION over its module units —
  // today's answer, an over-approximation, and never a fresh silence.
  let cell = null;
  for (const [h, c] of crossDeps) {
    if (!h.startsWith(`${pkg}#`) || !h.endsWith(".<module>")) continue;
    cell ??= { inferred: new Set(), invisible: new Set(), why: new Set(), hosts: [], cmds: [], paths: [], tables: [], netIncomplete: false };
    for (const e of c.inferred) cell.inferred.add(e);
    for (const b of c.invisible) cell.invisible.add(b);
    for (const w of c.why ?? []) cell.why.add(w);
    if (c.netIncomplete) cell.netIncomplete = true;   // a UNION of module units is incomplete if ANY of them is
  }
  return cell;
}
function resolveDepEntryKey(pkg, subpath) {
  let dir = null;
  for (let d = rootDir; ; d = path.dirname(d)) {
    const c = path.join(d, "node_modules", pkg);
    if (fs.existsSync(path.join(c, "package.json"))) { dir = c; break; }
    if (path.dirname(d) === d) break;
  }
  if (!dir) return null;
  const resolve = (rel) => {
    const base = path.resolve(dir, rel);
    for (const e of MODULE_EXTS) {
      const p = base + e;
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return null;
  };
  let file = null;
  if (subpath) file = resolve(subpath);
  else {
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { /* below */ }
    // `exports` wins over `main` in Node. Only the plain shapes are modelled — a string, or a "." entry
    // that is a string or a condition map — because a wildcard/pattern map cannot name ONE entry module
    // and the fallback above is the honest answer for it.
    const dot = typeof pj.exports === "string" ? pj.exports
      : (pj.exports && typeof pj.exports === "object" ? pj.exports["."] ?? null : null);
    const cand = [];
    if (typeof dot === "string") cand.push(dot);
    else if (dot && typeof dot === "object")
      for (const k of ["require", "node", "default", "import"]) if (typeof dot[k] === "string") cand.push(dot[k]);
    if (typeof pj.main === "string") cand.push(pj.main);
    cand.push("index.js");
    for (const c of cand) if ((file = resolve(c))) break;
  }
  if (!file) return null;
  const rel = path.relative(dir, file).replace(/\.[mc]?[tj]sx?$/, "").split(path.sep).join(".");
  return `${pkg}#${rel}.<module>`;
}
{
  const pending = [];                                 // [fromNode, targetQual]
  const depInits = [];                                // [fromNode, chained dep's initializer cell]
  const collect = (node) => {
    let spec = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
             && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) spec = node.arguments[0].text;
    if (spec) {
      const target = resolveProjectModule(spec, node.getSourceFile().fileName);
      if (target) {
        const rel = path.relative(rootDir, target).replace(/\.[mc]?[tj]sx?$/, "").split(path.sep).join(".");
        pending.push([node, `${rel}.<module>`]);
      } else if (!spec.startsWith(".") && crossDeps.size > 0) {
        // EXTERNAL specifier with a CHAINED report: importing a package runs its entry module, so the
        // importer reaches whatever that initializer does. The dep's module units are in `crossDeps` and
        // the edge simply never consulted them. This is the DETERMINED half of the external case: no
        // `Unknown` is invented, and an unchained dependency stays exactly as it was, because
        // blanket-disclosing every external import measured at 60-100% of modules and would make the
        // initializer unit useless rather than honest (candor-spec SOUNDNESS-VEIN-initializer-edge.md).
        // What runs is THE MODULE THIS SPECIFIER NAMES, so that is what is looked up — a subpath import
        // names its own file, a bare package name names its entry.
        const seg = spec.split("/");
        const pkg = spec.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0];
        const cell = depInitCell(pkg, spec.slice(pkg.length).replace(/^\//, ""));
        // §2.1, applied to the key rather than to the entry. The version check downgrades the CONTENT of
        // the keys a stale report carries; a key it does NOT carry — because a later build renamed it, or
        // because the module unit simply is not there — comes back empty, and "empty" is only a purity
        // claim when the report making it is trusted. So an import whose package is chained ONLY by a
        // report from another build discloses `Unknown` instead of nothing. The reason class is
        // `unresolved` (policy.mjs's catch-all), which is what it is: candor could not resolve this import,
        // and says so. This is the whole class the per-file module key change fell into — see `depInitCell`.
        // ⟨0.21⟩ …and the SAME argument for a report that declares itself INCOMPLETE. The reasoning is
        // identical with one word changed: an empty answer is a purity claim only when the report making it
        // is complete, and this one says it is not. The TREATMENT differs, because the evidence does — an
        // incomplete report's entries were derived from source it DID read, so a cell it DOES answer is kept
        // untouched (no `Unknown`, no reason bolted on); only the SILENCE hedges.
        const staleOnly = staleDepPkgs.has(pkg);
        const incompleteOnly = incompleteDepPkgs.has(pkg);
        if (cell && cell.inferred.size)
          depInits.push([node, staleOnly ? { ...cell, why: [`stale-dep:${pkg}`] } : cell]);
        else if (staleOnly)
          depInits.push([node, { inferred: new Set(["Unknown"]), invisible: new Set(), why: [`stale-dep:${pkg}`] }]);
        else if (incompleteOnly)
          depInits.push([node, { inferred: new Set(["Unknown"]), invisible: new Set(), why: [`incomplete-dep:${pkg}`] }]);
      }
    }
    ts.forEachChild(node, collect);
  };
  for (const sf of sources) collect(sf);
  // A target unit is minted lazily, so `A -> B -> C(effectful)` needs more than one sweep: B's unit does
  // not exist until B's own edge is added. Iterate until quiet rather than depending on file order, which
  // would make the result depend on how the project happens to be laid out.
  // A chained dependency's initializer effects attach DIRECTLY (its unit lives in another report, so there
  // is no local node to edge to) — the same way a chained dep's call effects are applied elsewhere.
  for (const [node, cell] of depInits) {
    const from = enclosing(node);
    const rec = from && fns.get(from);
    if (!rec) continue;
    for (const e of cell.inferred) rec.direct.add(e);
    for (const b of cell.invisible) rec.blind.add(b);
    for (const w of cell.why ?? []) rec.why.add(w);   // §2.1 stale-dep disclosure carries its reason
    // ⟨0.20⟩ …and the initializer's Net incompleteness, for the same reason the call join carries it. This
    // arm copies no `hosts` (a module unit's literals are not this caller's), so today it can only turn a
    // hostless Net that a sibling literal in THIS body would have certified back into `unknown-host`.
    if (cell.netIncomplete) rec.incomplete.add("Net");
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [node, to] of pending) {
      if (!fns.has(to)) continue;                     // no unit ⇔ that top level is pure: nothing to reach
      const from = enclosing(node);
      if (!from || from === to) continue;             // a module importing itself adds nothing
      const rec = fns.get(from);
      if (rec && !rec.edges.has(to)) { rec.edges.add(to); changed = true; }
    }
  }
}

// ---- pass 3: the least fixpoint (SEMANTICS §5a), effects + the literal surfaces -------------------
// WORKLIST least-fixpoint. The old `while (changed) { for [,rec] of fns }` swept every function on every
// pass, so its pass count equalled the longest back-to-front call chain — O(V²) on deep whole-project
// graphs. Instead, when a function's set grows, re-enqueue only its callers (the functions whose union
// reads it) via a callee→callers reverse index. Same monotone set-union (confluent) least fixpoint →
// order-independent → identical result. The `edges` are fixed, so the reverse index is shared by every
// sweep below (effects + each literal surface).
const callersOf = new Map();
for (const [name, rec] of fns)
  for (const callee of rec.edges) {
    let cs = callersOf.get(callee);
    if (!cs) callersOf.set(callee, (cs = []));
    cs.push(name);
  }
const inferred = new Map([...fns.keys()].map((k) => [k, new Set(fns.get(k).direct)]));
{
  const queue = [...fns.keys()];
  const queued = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const name = queue[head];
    queued.delete(name);
    const mine = inferred.get(name);
    const before = mine.size;
    for (const callee of fns.get(name).edges)
      for (const e of inferred.get(callee) ?? []) mine.add(e);
    if (mine.size !== before)
      for (const c of callersOf.get(name) ?? [])
        if (!queued.has(c)) { queued.add(c); queue.push(c); }
  }
}
// `fsKinds` joins the propagated surfaces: kinds TRAVEL the call graph (a caller that transitively only
// writes IS a writer), and the "?" poison travels with them so a caller of an undetermined-kind function
// inherits the SUPPRESSION rather than a half-answer. Pinned by conformance PART 31.
for (const m of ["hosts", "tables", "cmds", "paths", "blind", "incomplete", "fsKinds"]) {
  const queue = [...fns.keys()];
  const queued = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const name = queue[head];
    queued.delete(name);
    const rec = fns.get(name);
    const before = rec[m].size;
    for (const callee of rec.edges)
      for (const v of fns.get(callee)?.[m] ?? []) rec[m].add(v);
    if (rec[m].size !== before)
      for (const c of callersOf.get(name) ?? [])
        if (!queued.has(c)) { queued.add(c); queue.push(c); }
  }
}

// ---- emit: the §2 envelope (effect-free items omitted) + the §2.2 sidecar (EVERY fn a key) --------
// ⟨0.20⟩ Net destination-class partners from `.candor/config` — read ONCE here, used by the report's per-fn
// `netClass` field (below) and the gate (deny Net[unknown-host]); the SAME set both surfaces resolve.
const netPartners = parseNetPartners(discoverConfigText(target));
const functions = [];
for (const [name, rec] of fns) {
  const inf = [...inferred.get(name)].sort();
  // entry points stay visible even when pure; a BLIND fn stays too, so the honesty disclosure survives
  // on exactly the `inferred: []` fns that need it.
  if (inf.length === 0 && !rec.entry && rec.blind.size === 0) continue;
  const entry = {
    fn: name,
    loc: rec.loc,
    hash: `${pkgName}#${rec.local}`, // SPEC §2: the cross-package join key (package + local tail)
    inferred: inf,
    direct: [...rec.direct].sort(),
    // ⟨0.26⟩ `declared`/`undeclared`/`overdeclared` are DELIBERATELY ABSENT. They are the §5
    // capability-reconciliation outputs and this engine runs no such pass, so emitting `[]` would be a
    // positive claim — `undeclared: []` reads as "this function performs no undeclared effect", an
    // AS-EFF-001 all-clear from a check that never ran. SPEC §2 ⟨0.26⟩: present means the pass ran,
    // absent means it did not, and `[]` from an engine that computed nothing is forbidden.
    // They were emitted as hardcoded constants "for cross-engine schema parity" — a schema-parity check
    // is exactly what made that look conforming, which is why the rule now forbids requiring them.
    unresolved: inf.includes("Unknown"),
  };
  // Inline call edges (§2 `calls`) — the SAME edges the callgraph sidecar carries, embedded per entry so a
  // consumer without the sidecar (deleted, never-written, an old workspace) can still reconstruct the graph.
  // `tour` falls back to these when the sidecar is empty (surface robustness — mirrors the Rust report, whose
  // entries carry `calls`); omitted when a fn has no outgoing edges to keep pure leaves lean.
  if (rec.edges.size) entry.calls = [...rec.edges].sort();
  if (inf.includes("Net") && rec.hosts.size) entry.hosts = [...rec.hosts].sort();
  // ⟨0.20⟩ Net destination-class (NET-DESTINATION-CLASS-DESIGN.md): the classes present in this fn's
  // transitive Net surface — exact host-literal match, fail-closed unknown-host on a masked surface (rec
  // .incomplete has Net) OR a Net with no visible host. The class travels the call graph like the effect.
  if (inf.includes("Net")) entry.netClass = netClassesOf([...rec.hosts], rec.incomplete.has("Net"), netPartners);
  if (inf.includes("Db") && rec.tables.size) entry.tables = [...rec.tables].sort();
  if (inf.includes("Exec") && rec.cmds.size) entry.cmds = [...rec.cmds].sort();
  if (inf.includes("Fs") && rec.paths.size) entry.paths = [...rec.paths].sort();
  // SPEC §2 `fs` — the read/write kinds this fn's OWN Fs calls revealed. Gated on `inferred` carrying Fs
  // (the spec: "applies only when `inferred` contains `Fs`") and omitted when empty.
  //
  // Kinds TRAVEL (see the propagation loop); the "?" poison is what stops a PARTIAL answer travelling with
  // them. Present ⇒ some contributing Fs had no determined kind ⇒ suppress the whole field, because
  // ["write"] there would claim "writes but never reads" about a function that may do both.
  if (inf.includes("Fs") && rec.fsKinds.size && !rec.fsKinds.has("?"))
    entry.fs = [...rec.fsKinds].sort();
  // ⟨0.6⟩ unknownWhy — REQUIRED on a DIRECT Unknown SOURCE (this fn's own body has the unresolvable call,
  // so `rec.direct` carries Unknown), absent on a purely-transitive Unknown. The rich per-site reasons
  // (rec.why: callback:/dispatch:/dynamic-key:) when recorded, else a generic fallback so a source is
  // never left un-tagged — the source/transitive split the `blindspots` query needs (SPEC §3.1/§4).
  if (rec.direct.has("Unknown")) entry.unknownWhy = rec.why.size ? [...rec.why].sort() : ["unresolved"];
  // HONESTY: the npm packages this fn transitively reaches that κ couldn't see through — effects through
  // them are NOT in `inferred`, so it is a LOWER BOUND when this is non-empty. Omitted when none.
  if (rec.blind.size) entry.invisible = [...rec.blind].sort();
  if (rec.entry) entry.entryPoint = true;
  // unitKind (spec §2, informative — per-unit, not by name): the synthesized `<module>` initializer
  // carries its own kind (set at mint), a CJS export is tagged "export".
  if (rec.unitKind) entry.unitKind = rec.unitKind;
  else if (rec.isCjsExport) entry.unitKind = "export"; // spec 0.5 draft, informative — per-unit, not by name
  functions.push(entry);
}
// ⟨workspace-chain prototype — opt-in via CANDOR_WORKSPACE_CHAIN⟩ INTERFACE-CHA union entries for
// cross-package dispatch. A consumer of THIS package that calls an interface method (`ch.publish()` on an
// imported `OutboundChannel`) resolves the call to the interface METHOD SIGNATURE — which has no body, so
// no report entry, so the chain reads it pure even though every implementation reaches an effect. Emit a
// synthetic `Iface.method` entry = the UNION over each local class implementing the interface of that
// class's method effects (inferred + invisible), reusing the same `interfaceImpls` CHA universe the
// in-package dispatch already uses. Sound over-approximation (union of impls); omitted when the union is
// pure (silence = purity, SPEC §2 rule 3). GATED behind an env flag because it adds report entries a
// standalone consumer doesn't expect (and four-way conformance compares report shape) — a producer scans
// its workspace deps with the flag ON to emit chainable reports; default scans stay byte-identical.
//
// A PUBLISHED package is the shape the chain actually meets, and there the CHA universe above is EMPTY:
// npm ships compiled `dist` JS beside `.d.ts`, and `implements` survives only in the typings. Measured on
// `dist/index.js` + `dist/index.d.ts`: the emitter walks the CLASS's `heritageClauses`, `class FileStore {
// save(){} }` has none, so no interface is ever consulted and the package publishes `depkit#FileStore.save
// ['Fs']` with no union — a consumer dispatching on `Store` can never resolve it. Two probes settled where
// the relation still lives: the checker does NOT merge `exports.FileStore = FileStore` with the sibling
// `declare class FileStore implements Store` (the .js class symbol has exactly ONE declaration, its own,
// with zero heritage clauses), so no symbol walk reaches it — but the typings MODULE's exports do carry it.
// So: resolve the package's OWN typings module, walk its exports, and register each exported class that
// carries an `implements` clause under that interface, pairing the typings declaration to the scanned dist
// class BY EXPORTED NAME WITHIN THE SAME PACKAGE.
//
// THE PACKAGE BOUNDARY IS LOAD-BEARING, not a tidiness rule. Within one package `exports.FileStore` and
// `declare class FileStore` are the same public symbol by construction, so the pairing is authoritative.
// A cross-package name match would be the leaf-name join this vein has produced confirmed fabrications
// with, so BOTH the class and the interface declaration must sit inside rootDir, and an interface owned by
// another package is dropped rather than re-keyed under ours (its union belongs under ITS `pkg#` prefix).
// Honestly: only the INTERFACE-side half of that is shown load-bearing — mutating it out fabricates
// `depkit2#Store.save` from another package's interface and a named test fails. Mutating the CLASS-side
// half out breaks nothing, and no fixture could be built that makes it fire: a published foreign class
// cannot implement an interface it has no way to import, so the interface-side check already declines
// every case that reaches it. It is kept as a bound on a join by name, not claimed to be necessary.
// The interface NAME must also be unambiguous, the guard the in-scan arm already had. The remaining
// name-join hazard — several scanned units sharing the tail `Class.member` — is handled by UNIONING them
// (see `localEffs` below) rather than by dropping the class: dropping is the under-report this queue's
// item 0 keeps producing, and the dominant real cause of the collision is a package built twice to
// `dist/cjs` and `dist/esm`, where the two units are the same class and the union is exact.
//
// Typings already inside the scan are SKIPPED: a package scanned from its TypeScript source has real
// heritage clauses, so the in-scan arm above already holds the relation and this would only duplicate it.
//
// EVERY typings entry point the package declares, not just `.`. The union hash is `pkg#Iface.member` —
// package name plus a BARE interface name — so every interface named `Iface` anywhere in the package maps
// to the one key, whichever subpath a consumer imported it from. Reading only `.` left the ambiguity
// COUNTER blind to the others: `subkit` exporting an effectful `Store` from `.` and an unrelated pure
// `Store` from `./sub` published the `.` one's `Fs` as the answer for both, and a consumer of
// `subkit/sub` — whose only implementer cannot touch the disk — failed `deny Fs`. Measured on a fixture:
// exit 0 → 1 against the pre-5057026 engine, which disclosed `Unknown[dispatch:subkit.Store.save]`
// instead. That is the fabrication half of this vein, so the census has to cover what the KEY covers.
// Note the shape that must NOT become ambiguous: re-exports. One program over all the roots means a
// `.d.ts` reached from two entry points yields the SAME declaration node, and the counter is over nodes.
function typingsRoots() {
  let pj;
  try { pj = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")); } catch { return { roots: [], truncated: false }; }
  const pats = new Set();
  const isDts = (v) => typeof v === "string" && /\.d\.[cm]?ts$/.test(v);
  const walk = (v, d = 0) => {
    if (v == null || d > 8) return;
    if (typeof v === "string") { if (isDts(v)) pats.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (typeof v === "object") for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(pj.types); walk(pj.typings); walk(pj.exports);
  // `typesVersions` names files WITHOUT the extension (`{"*": {"*": ["dist/*"]}}`), so put it back or the
  // pattern matches nothing — 8 of 343 packages in the measured corpus declare one, 7 with a wildcard.
  const tv = [];
  (function collect(v, d = 0) {
    if (v == null || d > 8) return;
    if (typeof v === "string") { tv.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) collect(x, d + 1); return; }
    if (typeof v === "object") for (const x of Object.values(v)) collect(x, d + 1);
  })(pj.typesVersions);
  for (const s of tv) pats.add(isDts(s) ? s : s.replace(/(\.[mc]?jsx?)?$/, ".d.ts"));
  if (typeof pj.main === "string") walk(pj.main.replace(/\.[mc]?jsx?$/, ".d.ts"));
  pats.add("index.d.ts");
  // A `*` cannot be enumerated from the manifest, so collect the `.d.ts` files under the pattern's static
  // prefix instead. OVER-matching is the safe direction here: an extra declaration can only make a name
  // ambiguous (refused) or add an arm under a key no consumer can form. UNDER-matching is what re-opens
  // the fabrication — so `truncated` travels OUT of here, and the caller refuses to PUBLISH rather than
  // censusing half. Discarding the typings arm on its own was the wrong place to refuse: it lands the
  // refusal on the EVIDENCE side, and the evidence is what makes a colliding name ambiguous.
  const CAP = TYPINGS_CENSUS_CAP;
  const files = new Set();
  let truncated = false;
  const under = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.size >= CAP) { truncated = true; return; }
      if (e.isDirectory()) { if (e.name !== "node_modules") under(path.join(dir, e.name)); }
      else if (/\.d\.[cm]?ts$/.test(e.name)) files.add(path.join(dir, e.name));
    }
  };
  for (const pat of pats) {
    const star = pat.indexOf("*");
    if (star < 0) {
      const abs = path.resolve(rootDir, pat);
      if (fs.existsSync(abs)) files.add(abs);
      continue;
    }
    under(path.resolve(rootDir, pat.slice(0, star).replace(/[^/]*$/, "")));
  }
  return { roots: [...files], truncated: truncated || files.size > CAP };
}
function typingsInterfaceImpls() {
  const out = [];
  const census = typingsRoots();
  const roots = census.roots.filter((f) => !projectFiles.has(f));
  if (census.truncated || !roots.length) return { arms: out, truncated: census.truncated };
  // ONE program, its own: adding the .d.ts files as roots of the MAIN program would let a global
  // augmentation in the typings change how the .js itself types, i.e. move ordinary entries under the
  // flag. Isolated here, the only thing that can cross is the [interface, class-name] relation.
  let tprog, tck;
  try {
    tprog = ts.createProgram(roots, compilerOptions);
    tck = tprog.getTypeChecker();
  } catch { return { arms: out, truncated: true }; }   // no census at all is the widest truncation there is
  // "belongs to the scanned PACKAGE" — two conditions, and each one was wrong on its own first:
  //   * compared through REALPATHS, because TypeScript resolves module imports through symlinks. A
  //     workspace package reached at `node_modules/pkg -> ../packages/pkg` (the monorepo shape this vein
  //     already had to fix once, `6fb2560`) hands its typings back at their real location, and a textual
  //     prefix test then rejects the package's OWN files — the guard turning into an under-report.
  //   * a nested `node_modules` under rootDir is a DIFFERENT package, however deep. "Under rootDir" alone
  //     admits `node_modules/other/index.d.ts`, i.e. exactly the cross-package name join this must refuse.
  //     The fixture for that refusal PASSED before this line existed, purely because macOS `os.tmpdir()`
  //     hands back `/var/...` while the compiler reports `/private/var/...`, so the prefix test failed for
  //     an unrelated reason. Adding realpath removed the accident and exposed the missing check.
  const real = (f) => { try { return fs.realpathSync(path.resolve(f)); } catch { return path.resolve(f); } };
  const rootReal = real(rootDir);
  const inPkg = (f) => {
    const r = real(f);
    if (r !== rootReal && !r.startsWith(rootReal + path.sep)) return false;
    return !r.slice(rootReal.length).split(path.sep).includes("node_modules");
  };
  const deAlias = (s) => (s && s.flags & ts.SymbolFlags.Alias ? tck.getAliasedSymbol(s) : s);
  const byIface = new Map(); // InterfaceDeclaration -> class names
  const register = (idecl, clsName) => {
    if (!byIface.has(idecl)) byIface.set(idecl, []);
    const arr = byIface.get(idecl);
    if (!arr.includes(clsName)) arr.push(clsName);
  };
  const ifaceDeclsOf = (typeExpr) => (deAlias(tck.getSymbolAtLocation(typeExpr))?.declarations ?? [])
    .filter((d) => ts.isInterfaceDeclaration(d) && inPkg(d.getSourceFile().fileName));
  for (const root of roots) {
    const tsf = tprog.getSourceFile(root);
    const mod = tsf && tck.getSymbolAtLocation(tsf);
    if (!mod) continue; // a global script, not a module — it exports nothing to pair by name
    let exports_;
    try { exports_ = tck.getExportsOfModule(mod); } catch { continue; }
    for (const ex of exports_) {
      for (const d of deAlias(ex)?.declarations ?? []) {
        if (!ts.isClassDeclaration(d) || !d.name || !inPkg(d.getSourceFile().fileName)) continue;
        const clsName = d.name.text;
        // Climb super-interfaces too, matching the in-scan arm: `class C implements Sub` where
        // `interface Sub extends Sup` must be in Sup's universe, since `s.base()` on a Sub-typed value
        // resolves `base` to whichever interface DECLARES it.
        const seen = new Set();
        const climb = (idecl) => {
          if (seen.has(idecl)) return;
          seen.add(idecl);
          register(idecl, clsName);
          for (const h of idecl.heritageClauses ?? []) {
            if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
            for (const t of h.types) for (const s of ifaceDeclsOf(t.expression)) climb(s);
          }
        };
        for (const h of d.heritageClauses ?? []) {
          if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const t of h.types) for (const idecl of ifaceDeclsOf(t.expression)) climb(idecl);
        }
      }
    }
  }
  for (const [idecl, clsNames] of byIface) if (clsNames.length) out.push([idecl, clsNames]);
  return { arms: out, truncated: false };
}
if (process.env.CANDOR_WORKSPACE_CHAIN) {
  // rec.local -> {inferred:Set, blind:Set}, UNIONED over every unit sharing the tail rather than last-wins.
  // A dist package is routinely built twice (`dist/cjs/…/CucumberExpression.js` and `dist/esm/…` are the
  // same class), so a class name maps to several units; last-wins silently published ONE build's effects
  // as the whole answer. Union is the same posture the entry itself takes over implementers — and it is
  // what lets the typings arm below join by NAME without having to guess which unit the name meant.
  const localEffs = new Map();
  for (const [name, rec] of fns) {
    const cell = localEffs.get(rec.local) ?? { inferred: new Set(), blind: new Set() };
    for (const x of inferred.get(name) ?? []) cell.inferred.add(x);
    for (const b of rec.blind) cell.blind.add(b);
    localEffs.set(rec.local, cell);
  }
  // One union entry per hash — among UNION entries. It deliberately does NOT include the hashes real
  // entries already claim; see the emit site for why a claimed hash needs the union too.
  const emittedUnionHashes = new Set();
  const realByHash = new Map();
  for (const e of functions) if (!realByHash.has(e.hash)) realByHash.set(e.hash, e);
  // interface-NAME ambiguity: two `interface I` decls (different files/scopes) both key the union hash on
  // `pkg#I.m`, so first-wins would emit ONE I's union under a name a consumer of the OTHER I resolves to (a
  // fabrication). Count decls per name and skip an ambiguous one — the family's never-guess rule, matching
  // the candor-scan `lt.count > 1` / candor-swift ownersByTail guards.
  // The union arms, normalised to [InterfaceDeclaration, implementing class NAMES]: the in-scan CHA
  // universe, plus the same relation read out of a PUBLISHED package's own typings (see below).
  const unionArms = [];
  for (const [ifaceDecl, implClasses] of interfaceImpls)
    unionArms.push([ifaceDecl, implClasses.map((c) => c.name?.text).filter(Boolean)]);
  const inScanClassesByName = new Map(); // iface NAME -> every class the in-scan arms register under it
  for (const [d, cls] of unionArms) {
    const n = d.name?.text;
    if (!n) continue;
    const set = inScanClassesByName.get(n) ?? new Set();
    for (const c of cls) set.add(c);
    inScanClassesByName.set(n, set);
  }
  // A typings declaration colliding with an in-scan NAME is dropped only when it is REDUNDANT — when every
  // class it names is already in the in-scan arm's set, so the in-scan arm's union is a superset and the
  // typings arm has nothing to add. That is the SHADOW case and the only one: a package built to `dist`
  // keeps a `types` entry that is the generated shadow of the very source being scanned (@ukri-tfs/common:
  // `src/` scanned, `types: dist/lib/index.d.ts`), both arms describe the same `interface Logger` with the
  // same implementers, and counting them as two competing declarations silently deleted SEVEN real union
  // entries from that report.
  //
  // "The in-scan arm wins" as first written dropped the typings arm on the NAME alone, and that threw away
  // the one piece of evidence the engine had that the name means two different things. Measured: a package
  // whose internal `interface Store` (implementer does Net) shares a name with the PUBLIC `Store` its
  // typings pair to an effectful `FileStore` published `mixkit#Store.save -> ['Net']`, with
  // `unresolved: false` — a confident answer that is both a fabricated Net and a dropped Fs, and no
  // disclosure, so `deny Fs` sits at exit 0 on a consumer whose dispatch really does write. The in-scan
  // arm alone cannot see that (a `dist` class carries no heritage clause), which is why the defect
  // predates 5057026 in the in-scan arm and only becomes FIXABLE once the typings arm exists to
  // contradict it. Non-redundant now means AMBIGUOUS: the arm is pushed, the counter refuses BOTH, and the
  // consumer falls back to half 1's `Unknown[dispatch:pkg.Iface.member]` — honest in both directions
  // instead of confident in neither.
  //
  // Redundant-drop can still leave the in-scan union over-approximating for a consumer that meant the
  // other interface, since the in-scan set is a superset by construction. That is unchanged behaviour of
  // the in-scan arm, not something this rule introduces: no key that was precise becomes wider.
  const typings = typingsInterfaceImpls();
  for (const arm of typings.arms) {
    const n = arm[0].name?.text;
    if (!n) continue;
    const inScan = inScanClassesByName.get(n);
    if (inScan && arm[1].every((c) => inScan.has(c))) continue;
    unionArms.push(arm);
  }
  // A TRUNCATED typings census refuses the PUBLICATION, and it has to be here rather than at the census.
  // Dropping the typings arm on its own lands the refusal on the EVIDENCE side — and the evidence is the
  // only thing that can tell the engine a name means two things. The comment beside the cap argued that
  // over-matching is safe because "an extra declaration can only make a name ambiguous (refused)": true of
  // the files the walk COLLECTS, false of the arm it discards wholesale. Measured on a package whose `.d.ts`
  // tree holds 128+ declarations — routine for any `dist/**` build: the census stops, `ifaceNameCounts` for
  // `Store` reads 1 instead of 2, the ambiguity guard does not fire, and the package publishes its INTERNAL
  // `mixkit#Store.save -> ['Net'] unresolved:false` as the answer for the PUBLIC `Store` whose implementer
  // writes to disk. A consumer then inherits a fabricated Net (`deny Net` exit 0 -> 1 on a dispatch that
  // cannot reach the network) and a dropped Fs (`deny Fs` green at exit 0 on one that does) — exactly the
  // defect `d7060ca` measured and closed, restored for precisely the packages big enough to hit the cap.
  //
  // So every name REFUSES, routed through the never-guess guard the emitter already has rather than a
  // second refusal mechanism beside it: the declarations the walk did not reach could each be a second
  // `Store`, so no name in the package can be vouched for. Half 1's unanswerable-key arm is the floor under
  // this at the consumer, which is why refusing costs disclosure rather than honesty.
  if (typings.truncated)
    console.error(`candor-ts: this package's typings census exceeded ${TYPINGS_CENSUS_CAP} declaration files — `
      + `publishing NO interface-CHA union entries (an incomplete census cannot tell a colliding interface name from a unique one)`);
  const ifaceNameCounts = new Map();
  for (const [ifaceDecl] of unionArms) {
    const n = ifaceDecl.name?.text;
    if (n) ifaceNameCounts.set(n, (ifaceNameCounts.get(n) ?? 0) + 1);
  }
  for (const [ifaceDecl, implClasses] of unionArms) {
    const ifaceName = ifaceDecl.name?.text;
    if (!ifaceName || !implClasses.length) continue;
    // Never guess which `I` a name means: two declarations of it, or a census that cannot prove there is
    // only one, are the same evidential position and take the same answer.
    if (ifaceNameCounts.get(ifaceName) > 1 || typings.truncated) continue;
    // BOUNDED CHA — the same `CHA_FANOUT_LIMIT` the in-scan dispatch site applies. The union emitter
    // shipped without it, so the producer PUBLISHED what its own dispatch refuses to resolve: rxjs's
    // `Operator` has 70 implementers, sixteen of which reach Net, and rxjs's own `Observable.subscribe`
    // reads `Unknown[dispatch:src.internal.Operator.Operator.call]` while the report offers a chained
    // consumer `rxjs#Operator.call -> ['Net','Unknown']`. A consumer holding one pure operator inherits
    // the other sixty-nine, and fails `deny Net` on a dispatch that cannot reach the network.
    //
    // UNKNOWN, not silence: an absent entry is a purity claim (SPEC §2 rule 3) and twelve pure
    // implementers do not make the thirteenth pure — so the broad arm discloses even when every
    // implementer it CAN see is pure, the one shape here that adds an entry rather than narrowing one.
    // MEASURED, not assumed, and the measurement narrows the claim: mutating this to `continue` still
    // leaves a ts CONSUMER disclosing, because half 1's unanswerable-key arm covers an absent interface
    // key. What silence would cost is this report's own honesty — the producer's `deny E
    // Unknown[dispatch]`, any consumer without half 1's conjuncts, and the entry that is read as data
    // rather than joined. The named tests that fail on that mutation are the producer-side three.
    const broad = implClasses.length > CHA_FANOUT_LIMIT;

    for (const member of ifaceDecl.members ?? []) {
      // Both spellings of an interface method (see the in-scan site): `run(): void` and
      // `run: () => void`. Only a FunctionTypeNode qualifies — precise or nothing. A property typed
      // `(() => void) | undefined`, or with any non-function type, stays out: charging a plain data
      // property's name would be the fabrication mirror of the miss this closes.
      const fnMember = ts.isMethodSignature(member) || ts.isMethodDeclaration(member)
        || (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type));
      if (!member.name || !fnMember) continue;
      const m = member.name.getText();
      const infU = new Set(), blindU = new Set();
      if (broad) infU.add("Unknown");
      else for (const clsName of implClasses) {
        const e = localEffs.get(`${clsName}.${m}`);
        if (e) { for (const x of e.inferred) infU.add(x); for (const b of e.blind) blindU.add(b); }
      }
      if (infU.size === 0 && blindU.size === 0) continue; // pure across all impls — silence = purity
      const hash = `${pkgName}#${ifaceName}.${m}`;
      if (emittedUnionHashes.has(hash)) continue;
      // A REAL entry already claiming this hash used to SUPPRESS the union, and that was a silent
      // under-report — the candor-java sibling is `48a5f18`, whose argument transfers whole: publishing
      // under a hash is answering "what can running this member do", and `['Fs']` under a hash a consumer
      // keys on IS a purity claim about everything else the dispatch reaches. TS reaches the collision by
      // a BARE NAME: the hash is `pkg#Store.save`, so any `class Store` in the package claims the key an
      // interface-typed consumer forms — whether by declaration merging (`interface Store` + `class Store`
      // are one name) or by two unrelated declarations sharing a name across files. Measured on the second
      // shape: in-scan `go(s: Store) { s.save() }` reads ['Fs','Net'] (the CHA union) and `deny Net` exits
      // 1; split and chained, the consumer read the unrelated class's ['Env'] — a dropped Fs AND Net with
      // `deny Net` at exit 0, plus a fabricated `deny Env` catch. The engine contradicting itself across
      // the scan boundary, which is exactly what `48a5f18` names.
      //
      // WHERE THIS DEPARTS FROM JAVA, and why. java MERGES the union into the claiming entry. It can:
      // there the claimant is the interface's own `default` METHOD, a body whose in-scan dispatch site is
      // already charged the whole CHA union, so widening it states nothing new about that unit. TS
      // interfaces have no bodies, so the claimant is always a CLASS body — and widening a class's
      // `inferred` charges that class with effects a DIFFERENT class performs, firing the producer's own
      // AS-EFF-006/001 gate on code that cannot do it. That is precisely the hazard java's own comment
      // names when it refuses to widen `declared`/`overdeclared`, one field along. So the union is emitted
      // as its OWN entry under the shared hash instead, and SPEC §2's documented duplicate-hash UNION rule
      // does the join at the consumer — the same answer java's merge produces, with no analysed unit's
      // assertions rewritten, no `analyzed` arithmetic disturbed (the entry stays marked
      // `interfaceUnion`), and the producer's gate still describing the bodies it actually read.
      //
      // The dedup that DOES survive is java's "return `real` unchanged when the union adds nothing": if
      // every effect and every `invisible` the union carries is already under that hash, a second entry
      // would be noise, and reports stay byte-identical wherever there is nothing to add. A `broad` union
      // always publishes, because its `unresolved`/`unknownWhy` is a disclosure about the DISPATCH that a
      // resolved class entry does not make.
      const claimed = realByHash.get(hash);
      if (claimed && !broad
          && [...infU].every((x) => claimed.inferred.includes(x))
          && [...blindU].every((b) => (claimed.invisible ?? []).includes(b))) continue;
      emittedUnionHashes.add(hash);
      const sfIface = ifaceDecl.getSourceFile();
      const { line, character } = sfIface.getLineAndCharacterOfPosition(ifaceDecl.getStart());
      const un = { fn: `${ifaceName}.${m}`, loc: `${path.relative(rootDir, sfIface.fileName)}:${line + 1}:${character + 1}`,
                   hash, inferred: [...infU].sort(), interfaceUnion: true };
      // The reason travels with the disclosure, spelled the way the CONSUMER of this entry spells the
      // same site (`dispatch:<pkg>.<Iface>.<member>`, half 1's form), so a `deny E Unknown[dispatch]` at
      // the producer still bites. Known residual, not introduced here: the ts dep-join copies `inferred`
      // and `invisible` only, so a chained consumer's own entry loses the reason CLASS and falls back to
      // `unresolved` — the ts sibling of candor-java `6ab26e4`, still open.
      // The Unknown TRUST MARKER is a function of the set, exactly as it is for an ordinary entry
      // (`unresolved: inf.includes("Unknown")` above) — not of the branch that put Unknown there. Setting
      // it only on the `broad` arm left a union that inherits Unknown from an IMPLEMENTER reading
      // `inferred: ['Unknown']` with `unresolved` absent, i.e. FALSE: a machine consumer told in one field
      // that the set may be incomplete (SPEC §2 "true if `inferred` may be incomplete") and in the next
      // that it is not. Live on real code — every one of rxjs's seven published unions had it. The REASON
      // stays scoped to `broad`, and correctly: ⟨0.6⟩ requires `unknownWhy` on a DIRECT Unknown source, and
      // a union that inherited its Unknown from an implementer's body is not one.
      un.unresolved = infU.has("Unknown");
      if (broad) un.unknownWhy = [`dispatch:${pkgName}.${ifaceName}.${m}`];
      if (blindU.size) un.invisible = [...blindU].sort();
      functions.push(un);
    }
  }
}
// ---- the TRUST-MARKER INVARIANT, checked over every entry before anything is written ----------------
// An entry whose `inferred` contains `Unknown` MUST carry `unresolved: true` (SPEC §2, "true if `inferred`
// may be incomplete"), and one that names a DIRECT `Unknown` MUST carry a non-empty `unknownWhy` (⟨0.6⟩,
// REQUIRED on a source). Both are TIER-1 markers a machine consumer reads INSTEAD of re-deriving the
// judgment, so a contradiction between them and the effect set is undetectable from the outside: the
// consumer is told in one field that the set may be incomplete and in the next that it is not, and it has
// no third channel to break the tie. That is the cardinal-sin shape wearing a data-consistency bug.
//
// It is asserted rather than trusted because it has ALREADY shipped broken. `e66f29e` found a union entry
// publishing `inferred: ['Unknown']` with `unresolved` ABSENT — the marker was set on the `broad` arm only,
// so an entry that INHERITED its Unknown from an implementer read `false`. Live on all seven of rxjs's
// published unions. Two independent producers derive this marker (the ordinary entry loop and the union
// emitter) and a third would be easy to add; "two places that must agree" is a property, and a property is
// worth a check rather than a comment (item 9).
//
// FAIL CLOSED, before any file is written: no report at all is better than one whose trust markers lie,
// because a downstream gate cannot tell the difference. Exit 2 is the family's "could not produce a
// trustworthy answer" (an unreadable policy, a corrupt baseline, an unanalyzable source all take it).
{
  const contradictions = [];
  for (const e of functions) {
    if ((e.inferred ?? []).includes("Unknown") && e.unresolved !== true)
      contradictions.push(`${e.fn}: inferred carries Unknown but \`unresolved\` is ${JSON.stringify(e.unresolved)}`);
    // `direct` is absent on a synthesized union entry (it is not an analysed body), so the ⟨0.6⟩ rule is
    // asked only of entries that make a direct claim at all.
    if (Array.isArray(e.direct) && e.direct.includes("Unknown") && !(e.unknownWhy ?? []).length)
      contradictions.push(`${e.fn}: direct carries Unknown but \`unknownWhy\` is empty (⟨0.6⟩ requires it on a source)`);
  }
  if (contradictions.length) {
    console.error(`candor-ts: INTERNAL INVARIANT VIOLATED — ${contradictions.length} report entr`
      + `${contradictions.length === 1 ? "y contradicts its" : "ies contradict their"} own trust markers; `
      + `NO report written (a consumer cannot detect this from the outside):`);
    for (const c of contradictions.slice(0, 20)) console.error(`  ${c}`);
    if (contradictions.length > 20) console.error(`  … and ${contradictions.length - 20} more`);
    // ⟨0.28⟩ report stream: this exit-2 fires BEFORE the envelope is printed, so a `--json` run would
    // otherwise leave stdout empty for the whole class of trust-marker contradictions. The latch is
    // still unset at this point; the helper writes the fail-closed doc as stdout's only content.
    refuseEarlyToStream(`${contradictions.length} report entr${contradictions.length === 1 ? "y contradicts its" : "ies contradict their"} own trust markers`);
    process.exit(2);
  }
}

// ⟨0.21⟩ An opaque, within-engine-stable fingerprint of a sorted qual set — FNV-1a 64-bit over the
// newline-terminated UTF-8 quals, lowercase hex zero-padded to 16. BigInt (JS numbers can't hold 64 bits),
// masked to 64 bits each step so it matches the java reference byte-for-byte (one algorithm the spec can
// describe). Dependency-free + deterministic: it changes iff the set changes, so a same-engine re-scan of
// unchanged input agrees. NOT cryptographic and NOT cross-engine comparable (quals differ `::` vs `.`).
function fnv1aHex(sortedQuals) {
  const MASK = 0xFFFFFFFFFFFFFFFFn;
  const PRIME = 0x100000001b3n;
  let h = 0xcbf29ce484222325n; // FNV offset basis
  for (const q of sortedQuals) {
    for (const b of Buffer.from(q, "utf8")) {
      h = (h ^ BigInt(b)) & MASK;
      h = (h * PRIME) & MASK;
    }
    h = (h ^ 0x0an) & MASK; // '\n' terminator (matches the java reference)
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

// `package` names what this report COVERS — a consumer chaining it registers coverage even when
// `functions` is empty (an all-pure package's report is its purity claim, SPEC §2 rule 3).
// ⟨0.27⟩ SPEC §2.1 `resolves`: the OPTIONAL refinement surfaces this producer computes. Without it the
// absence of such a field is overloaded between "does not compute this" and "computed and could not
// determine it", and a consumer cannot read the omission at all. candor-ts resolves `fs` read/write kinds,
// so it says so. A producer MUST NOT list a surface it does not compute — that turns "unimplemented" into a
// false "undetermined", which is the inversion the field exists to prevent.
const envelope = { candor: { version: ENGINE_VERSION, toolchain: `node-${process.versions.node}`, spec: SPEC_VERSION },
                   resolves: ["fs"], package: pkgName, functions };
// ⟨0.15 staged⟩ the κ-coverage ledger as DATA (COVERAGE-DESIGN.md §1): ONE sorted form (count desc,
// name asc — exactly the stderr line's order) feeds the envelope field, the stderr receipt below, and
// the --gate-json advisory, so the three can never tell different stories.
// ⟨0.24⟩ `name asc` = BY CODE POINT (SPEC §2: every ordering in a report MUST be locale-INDEPENDENT). This
// tiebreak used `localeCompare`, and unlike the other six sites it orders bytes INSIDE THE EMITTED REPORT —
// so the break was OBSERVED, not argued: one build, one unchanged tree, two runs differing only in the
// environment (`LC_ALL=C` vs `LC_ALL=et_EE.UTF-8`) produced reports with different md5, the two
// `coverage.uncovered` entries transposed. The keys here are npm package names — lowercase ASCII, the case
// the UTF-16 hazard cannot reach — and Estonian collates z between s and t, so ASCII bought no safety.
// Every "a default report is byte-identical" claim in the spec was false against this line.
const uncoveredLedger = [...unlistedSeen.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]));
// ⟨0.15 staged⟩ `coverage` envelope field — the stderr disclosure travels WITH the artifact, so a
// report-consuming verb can no longer read a partially-covered report as total. Same names/counts as
// the stderr line. OMITTED entirely when nothing is uncovered (the `extensions`-field precedent): a
// fully-covered report stays byte-identical to a ⟨0.14⟩ one, so the rung is wire-compatible. The
// per-function posture is UNCHANGED: a resolvable-but-uncovered call keeps `invisible`, an
// unresolvable one keeps the stronger `Unknown` (COVERAGE-DESIGN.md §2 blesses both).
if (uncoveredLedger.length) {
  envelope.coverage = { uncovered: uncoveredLedger.map(([name, calls]) => ({ name, calls })) };
}
// ⟨0.21⟩ COMPLETENESS MANIFEST (Gap 1): the analyzed universe = every fn candor formed an effect judgment
// for = the minted `fns` Map (effectful + pure leaves — NOT the effectful-only `functions` array), so a
// bare-envelope consumer computes the pure count = analyzed.count − |functions| and tells analyzed-pure
// from never-seen. `digest` = an opaque within-engine-stable FNV-1a-64 fingerprint over the SORTED analyzed
// quals: it changes iff the set changes, so a same-input re-scan agrees (a re-scan check, NOT cryptographic
// and NOT cross-engine comparable — qualifiers differ). ALWAYS present.
const analyzedQuals = [...fns.keys()].sort();
envelope.analyzed = { count: fns.size, digest: fnv1aHex(analyzedQuals) };
// ⟨0.21⟩ COMPLETENESS MANIFEST (Gap 2): the target's own source candor could NOT analyze (unparsed .ts).
// OMITTED when empty — a complete scan stays byte-identical to a pre-rung report — so a MACHINE reading
// --json sees the incompleteness the stderr warning alone used to hide.
if (unanalyzedUnits.length) envelope.unanalyzed = unanalyzedUnits.map((u) => ({ path: u.path, reason: u.reason }));
const cg = {};
for (const [name, rec] of fns) cg[name] = [...rec.edges].sort();
// Write ATOMICALLY (temp + rename): a concurrent reader — the MCP server or another `query` while
// `candor-ts-watch` re-scans (the recommended agent setup runs both) — must never observe a
// half-written report. An in-place writeFileSync leaves a truncation window where JSON.parse throws;
// rename(2) is atomic within a filesystem, so a reader sees either the old report or the new one whole.
// ⟨0.28⟩ …and through `writeSinkAtomic`, so a symlinked or multiply-linked destination is written where
// the operator points rather than replaced. Reports have the same layout exposure as verdicts.
const writeAtomic = (file, text) => writeSinkAtomic(file, text);
// --json: print the §2 envelope to STDOUT instead of writing the report files (matches candor-scan/Rust).
if (wantJson) {
  console.log(JSON.stringify(envelope, null, 1));
  // ⟨0.28⟩ REPORT STREAM LATCH — a successful envelope went to stdout, so a later exit-2 site (baseline
  // corrupt, policy refusal, gate NOT certified over unanalyzed) MUST NOT also write a fail-closed
  // placeholder there. Two documents on one stream parses as neither — the same shape the two-stream
  // refusal exists to prevent, arriving through a different door. The rust reference sets the mirror
  // `REPORT_STREAM_WRITTEN` OnceLock at the analog site (crates/candor-scan/src/scan.rs).
  reportStreamWritten = true;
} else {
  writeAtomic(`${outPrefix}.json`, JSON.stringify(envelope, null, 1));
  writeAtomic(`${outPrefix}.callgraph.json`, JSON.stringify(cg, null, 1));
  // ⟨verify⟩ ALL-FUNCTION SPAN index — the [start, end] line SPAN of EVERY analyzed fn, pure ones INCLUDED
  // (the §2 report carries a start loc for effectful fns only). The dynamic honesty oracle (candor-ts-verify)
  // maps a runtime effect site to its enclosing fn; it needs SPANS, not just starts, for two reasons: (1) a
  // pure fn omitted from §2 has no anchor, so its effect would fold onto the nearest preceding effectful fn
  // and its cardinal-sin escape would vanish (a silent MISS); (2) a start-only "nearest declaration below"
  // rule misattributes a site that sits AFTER a nested fn but INSIDE the effectful outer fn to that nested
  // (often pure) fn — manufacturing a FALSE violation (found corpus-testing a real app: an fs.readFileSync in
  // a big `run()` bucketed onto a pure test-callback arrow declared earlier). With spans the oracle picks the
  // INNERMOST fn whose [start,end] CONTAINS the site — correct in both cases. Format `{fn: {loc, end}}`;
  // additive (no §2/callgraph consumer reads it); the oracle fails CLOSED (discloses) without it.
  const locs = {};
  for (const [name, rec] of fns) if (rec.loc) locs[name] = { loc: rec.loc, end: rec.endLine ?? null };
  writeAtomic(`${outPrefix}.locs.json`, JSON.stringify(locs, null, 1));
}
// Type-hierarchy sidecar (SPEC §4 / 0.7): each project class/interface (qualified `mod.Name`, matching
// the `mod.Class.member` fn quals) -> its qualified direct supertypes/interfaces. Compact (O(types)),
// lets `callers --include-unknown` resolve whether a confirmed reacher is an override of a `dispatch:`
// owner WITHOUT storing the dropped candidate edges (which would re-encode the flood bounded-CHA prevents).
const hierarchy = {};
for (const sf of sources) {
  const mod = moduleOf(sf);
  (function walk(node) {
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      const supers = [];
      for (const h of node.heritageClauses ?? []) {
        for (const t of h.types ?? []) {
          let sym = checker.getSymbolAtLocation(t.expression);
          if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
          const d = (sym?.declarations ?? []).find((x) => ts.isClassDeclaration(x) || ts.isInterfaceDeclaration(x));
          supers.push(d && d.name ? `${moduleOf(d.getSourceFile())}.${namespacePrefixOf(d)}${d.name.getText()}` : t.expression.getText());
        }
      }
      // ⟨0.26⟩ A KEY FOR EVERY TYPE INDEXED, `[]` INCLUDED — the key set IS the manifest (SPEC §2.2).
      // This was `if (supers.length)`, so a type with no supertypes was OMITTED and absence meant BOTH
      // "no supertypes" and "never indexed". Measured: removing one entry from a real sidecar silently
      // dropped a `callers --include-unknown` frontier row, while removing the sidecar ENTIRELY left it
      // correct — so LESS information was SAFER than partial information. §2.2's own example has always
      // shown `"app.Base": []`; this producer contradicted it.
      hierarchy[`${mod}.${namespacePrefixOf(node)}${node.name.getText()}`] = supers;
    }
    ts.forEachChild(node, walk);
  })(sf);
}
if (!wantJson) {
  writeAtomic(`${outPrefix}.hierarchy.json`, JSON.stringify(hierarchy, null, 1));
  console.error(`candor-ts: wrote ${functions.length} effectful functions (${fns.size} analyzed, ${sources.length} files) to ${outPrefix}.json`);
}
// ⟨0.28⟩ The run has finished writing its report set: hand back any file it armed and turned out not to
// own (see disarmUnwrittenOutReports). Placed HERE rather than at the exit sites because everything
// below — the policy gate, the baseline ratchet, the unanalyzed certification — can exit 1 or 2 having
// already published a complete report, and a leftover placeholder past this point is a claim of
// incompleteness this run did not experience.
disarmUnwrittenOutReports();
{
  // Effect breakdown — make the result visible at a glance, not just a count + a file path.
  const counts = {};
  for (const e of functions) for (const x of e.inferred) counts[x] = (counts[x] || 0) + 1;
  const breakdown = ["Net", "Llm", "Fs", "Db", "Exec", "Ipc", "Env", "Clipboard", "Clock", "Log", "Rand"]
    .filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(" · ");
  const unknown = counts.Unknown || 0;
  if (breakdown || unknown) {
    console.error(`  ${breakdown}${unknown ? `${breakdown ? "   ·   " : ""}Unknown ${unknown} (disclosed)` : ""}`);
  }
}
{
  // ⟨0.19⟩ SETUP diagnostic (SPEC §6.2 §3, the setup/genuine split): functions that read Unknown ONLY
  // because the scan isn't configured (a declared dep not installed → `no-node_modules:<pkg>`, reason class
  // `setup`) are a FIXABLE mis-configuration, not a genuine dynamic blind spot. Surface them LOUDLY with the
  // fix and separate from real dynamism — so a team runs `npm install` instead of disabling a strict gate on
  // unconfigured analysis (the referee's week-two-uninstall). `Unknown[dynamic]` EXCLUDES `setup`, so a
  // strict gate can bite genuine dynamism while tolerating these until the config is fixed.
  const setupPkgs = new Set();
  let setupFns = 0;
  for (const e of functions) {
    const why = e.unknownWhy ?? [];
    if (!why.some((w) => reasonClass(w) === "setup")) continue;
    setupFns++;
    for (const w of why) { const m = /^no-node_modules:(.+)$/.exec(w); if (m) setupPkgs.add(m[1]); }
  }
  if (setupFns > 0) {
    const pkgs = [...setupPkgs].sort();
    const shown = pkgs.slice(0, 6).join(", ") + (pkgs.length > 6 ? `, +${pkgs.length - 6} more` : "");
    console.error(`candor-ts: SETUP — ${setupFns} function(s) read Unknown ONLY because ${pkgs.length} declared `
      + `package(s) aren't installed (${shown}); run \`npm install\`, then re-scan. These are unconfigured `
      + `analysis, NOT real blind spots — a strict gate can still bite genuine dynamism with `
      + `\`deny E Unknown[dynamic]\` (which tolerates \`setup\`), then shrink to zero once installed.`);
  }
}
// Total CALLS into unscanned packages above which the scan is assumed to be MISSING ITS DEPENDENCIES —
// pointed at the app's own sources with nothing chained — and so earns the scan-completeness nudge below.
// VOLUME, not package COUNT: count is the wrong metric. candor-java's own build output makes 519 such
// calls into just 4 uncovered packages — the textbook "you pointed it at your code, not the whole
// dependency tree" scan, which any count threshold misses entirely — while a small app touching 5 tiny
// util packages would be nudged for nothing. A scan with its dependency reports chained sits at or near
// zero. Advisory only: never touches the report, the verdict, or the exit code.
const UNCOVERED_CALLS_NUDGE_MIN = 50;
if (unlistedSeen.size > 0) {
  const top = uncoveredLedger; // ⟨0.15 staged⟩ the shared sorted ledger — same names/counts as envelope `coverage`
  const shown = top.slice(0, 8).map(([p, n]) => `${p} (${n} call${n === 1 ? "" : "s"})`).join(", ");
  const more = top.length > 8 ? ` + ${top.length - 8} more` : "";
  console.error(`candor-ts: candor's classifier doesn't cover ${top.length} package${top.length === 1 ? "" : "s"} this code calls into — `
    + `their effects are INVISIBLE to the scan (absent from the report, NOT a claim they're pure): ${shown}${more}`);
  // SCAN-COMPLETENESS NUDGE. A scan that sees the app but none of its dependencies leaves those
  // dependencies' effects INVISIBLE (the ledger above) — a MISSING INPUT, not a precision defect, and the
  // two read identically in the report. Measured on the JVM engine against a real 18.7k-fn webapp: scanned
  // app-only it could PROVE Net on 465 functions; re-scanned as the deployed artifact (app + its 222
  // dependency jars) the same gate proved Net on 5,865 — the library reaches became DETERMINED effects
  // rather than nothing. Here the equivalent input is the dependencies' own reports: scan them and chain
  // them (`--workspace` for symlinked monorepo deps, `CANDOR_DEPS` for any directory of sibling reports),
  // and a call into a chained package inherits its recorded effects instead of joining this ledger.
  // The nudge deliberately promises VISIBILITY, not dispatch resolution — a broad dispatch over the app's
  // OWN hierarchy discloses Unknown for reasons more dependency code cannot fix.
  const uncoveredCalls = uncoveredLedger.reduce((sum, [, n]) => sum + n, 0);
  if (uncoveredCalls >= UNCOVERED_CALLS_NUDGE_MIN)
    console.error(`candor-ts: hint — ${uncoveredCalls} calls go into ${top.length} package${top.length === 1 ? "" : "s"} `
      + `that ${top.length === 1 ? "is" : "are"} not scanned, so their effects are invisible here. If you scanned only your own `
      + `code, point candor at the full dependency set too — scan those packages and chain their reports `
      + `(\`--workspace\` for monorepo links, \`CANDOR_DEPS=<dir>\` otherwise): those reaches then resolve to `
      + `DETERMINED effects instead of being absent.`);
}

// ---- the cold-repo hook: surface the single most SURPRISING transitive reach (surface.mjs) ---------
// One extra stderr line after the coverage ledger — the most benign-named function reaching a scary
// effect a few hops away + a ready-to-run `candor path`. Deterministic; honest "nothing hidden"
// fallback. Ported EXACTLY from candor-rust's surface.rs so every engine surfaces the SAME reach on a
// shared fixture. Prefix is `candor:` (brand voice) and the command is `candor path …` — identical on
// every engine. STDERR only, so the --json report on stdout stays clean.
if (!wantJson) {
  const directMap = new Map();
  const callsMap = new Map();
  const locMap = new Map();
  for (const [name, rec] of fns) {
    directMap.set(name, rec.direct);
    callsMap.set(name, rec.edges);
    if (rec.loc) locMap.set(name, rec.loc);
  }
  // A qual is test code iff its recorded loc (file:line[:col]) lies on a test path — the same predicate
  // the scan already uses to keep test files out of the report.
  const isTestQual = (q) => { const l = locMap.get(q); return l ? isTestPath(l) : false; };
  // The cause this run can actually stand behind, in the order the evidence supports: packages the
  // classifier does not cover (already enumerated above) beats a tsconfig guess, and a tsconfig this run
  // READ rules the tsconfig guess out entirely.
  const unresolvedCause = unlistedSeen.size > 0
    ? `the ${uncoveredLedger.length} package${uncoveredLedger.length === 1 ? "" : "s"} named above are not `
      + `covered by the classifier, so calls into them resolve to Unknown`
    : (usedTsconfig
        ? `this scan read ${path.relative(rootDir, usedTsconfig) || path.basename(usedTsconfig)}, so the `
          + `cause is unresolvable imports rather than a missing tsconfig`
        : `no tsconfig.json was found for this target, so imports resolve poorly — point candor at one`);
  emitSurface(inferred, directMap, callsMap, locMap, isTestQual, console.error, unresolvedCause);
}

// ---- the gate surfaces: the AS-EFF-005 baseline guard + the standing §6.2 policy gate --------------
// When stdout carries a JSON document — the §2 envelope (--json) OR the streamed gate verdict
// (--gate-json -) — it must stay pure JSON: route the gate's [AS-EFF-…] violation lines to stderr so
// a `… | jq` / `… | candor-sarif` pipe never breaks.
const emitViolation = (wantJson || gateJsonPath === "-") ? (l) => console.error(l) : (l) => console.log(l);
let gateViolations = [];
// ⟨0.27⟩ SPEC §4 `zeroMatch` — the raw text of every rule whose SCOPE bound no function, captured off the
// gate evaluation and emitted onto the verdict document. The stderr lines alone left a machine consumer
// unable to see that a rule bound nothing — the typo'd-scope silent green, one channel over. Disclosure
// only: `ok` and the exit code never consult it.
let gateZeroMatch = [];
// ⟨0.24⟩ the `.candor/config` that supplied POLICY VOCABULARY this verdict actually used — named on the
// document (SPEC §3.1 `99eb4e9`), null when no alias was referenced so the verdict stays byte-identical.
let policyVocabulary = null;
// ⟨0.24⟩ THE POLICY GATE'S REFUSAL, RECORDED RATHER THAN EXECUTED (SPEC §3.1 `4c79958`). An unreadable or
// unhonourable policy used to `writeRefusal(); exit(2)` on the spot — which DELETED whatever the AS-EFF-005
// baseline guard, running earlier by design, had already established. Both sites now record here and the
// single decision point below chooses between a verdict and a refusal on what the run ESTABLISHED.
// `{why, unevaluated}`: the human sentence, and the machine-legible list of policy lines that never ran.
let policyRefusal = null;
// ⟨0.24⟩ THE REFUSAL DOCUMENT on the scan route (SPEC §3.1 `107755b` + `1503368`). Same builder and same
// bytes as `gate --report`'s, so the two routes cannot drift into two shapes of "I declined to judge".
// Nothing is written when `--gate-json` was not asked for: the hazard is a wrapper re-reading a PATH.
const writeRefusal = (reason, unevaluated = null) => {
  if (!gateJsonPath) return;
  const text = JSON.stringify(refusalVerdict(SPEC_VERSION, reason, unevaluated), null, 1);
  if (gateJsonPath === "-") { console.log(text); return; }
  try { writeAtomic(gateJsonPath, text + "\n"); }
  catch (e) { console.error(`candor-ts: could not write --gate-json ${gateJsonPath}: ${e.message}`); }
};

// ---- the AS-EFF-005 baseline guard (CANDOR_BASELINE / config `baseline`; SPEC §7 item 5) -----------
// Semantics mirror the reference engine (candor-java Policy.checkBaseline) exactly:
//  · ABSENT file → one stderr note, guard inactive (ratchet not adopted; exit unchanged).
//  · PRESENT but unparseable (corrupt/truncated/not-a-report) → exit 2 WITHOUT evaluating — the guard
//    must never silently pass on unreadable gate input (the unreadable-policy class, §6.2).
//  · A missing provenance header (legacy bare array) OR a producing `candor.version` ≠ this build →
//    exit 2 WITHOUT evaluating (§2.1: a baseline is comparable only to its OWN producing version —
//    evaluating a stale one yields a bogus AS-EFF-005 wave; skipping is an unbounded fail-open window).
//    The read-only `diff`/`gains` QUERIES disclose a mismatch instead of failing — a comparison the
//    user explicitly asked for should inform; this scan-time guard is the gate and fails closed.
//  · Valid + same build → per-fn compare: an EXISTING fn gaining an effect is an [AS-EFF-005]
//    violation (exit 1, joins --gate-json); a fn absent from the baseline is NEW code, reviewed as
//    such, not a regression. Baselines omit pure fns (spec §2), so absent-prior means no prior claim.
//    An Unknown-ONLY gain is ADVISORY (a note, exit 0) UNLESS the ⟨unknown-ratchet⟩ opt-in is on
//    (config `unknown-ratchet` / CANDOR_UNKNOWN_RATCHET) — then a NEWLY-introduced Unknown FAILS
//    (exit 1) while a fn already Unknown in the baseline is grandfathered (see the gain loop below).
//
// ⟨0.16⟩ Callgraph-aware existence (SPEC §7 item 5). Reports OMIT pure functions, so a fn that
// shipped PURE and now performs an effect is absent from the baseline report and reads as exempt "new
// code" — the sharpest supply-chain shape escaping the guard. Fix: key existence on the baseline
// CALLGRAPH sidecar (<baseline>.callgraph.json, §2.2 — it lists every project fn INCLUDING pure
// leaves), exactly as `gains`'s `origin` existence test does (query-core.mjs `gains`: a fn is
// "existing" if it is a baseline-callgraph node — a caller key or a callee):
//  · sidecar PRESENT + loaded → a fn that is a baseline-callgraph node has baseline effect set ∅
//    (pure → omitted from the report) and any effect now is a GAIN violation. pure→effectful is caught.
//    A fn in NEITHER report nor callgraph genuinely did not exist → stays exempt "new".
//  · sidecar ABSENT → degrade to report-only existence (pre-⟨0.16⟩: a formerly-pure fn reads as new;
//    still catches an already-effectful fn WIDENING). One stderr note that the guard is weaker.
//  · sidecar PRESENT-but-CORRUPT → fail closed (exit 2), like a corrupt baseline: a broken sidecar
//    must not silently NARROW the guard back to report-only.
if (baselinePath !== null) {
  const shownB = baselinePath === "" ? "(configured empty)" : baselinePath;
  if (baselinePath !== "" && !fs.existsSync(baselinePath) && baselineFromConfig) {
    // A CHECKED-IN DECLARATION IS NOT THE SAME ABSENCE — see baselineFromConfig above. Exit 2: the
    // gateless-green class, and an adopter review measured this as the second-likeliest first-commit
    // mistake (`.candor/` committed, the baseline not).
    console.error(`candor-ts: .candor/config declares \`baseline ${baselinePath}\` but that file is not `
      + `there — failing (exit 2). A checked-in declaration says this repo HAS a baseline, so an absent `
      + `one was deleted or never committed. Commit it, or record one: candor-ts <target> --out <prefix>.`);
    // WRITE THE REFUSAL DOCUMENT BEFORE EXITING. Without this the `--gate-json` file keeps whatever the
    // LAST run left there — so a CI wrapper that reads the artifact instead of the exit code sees the
    // previous run's `ok: true` and reports a pass, which is the stale-artifact false green this format
    // exists to refuse. java, rust and swift all overwrite on this branch; ts alone did not.
    writeRefusal(`.candor/config declares \`baseline ${baselinePath}\` but that file is not there`);
    process.exit(2);
  } else if (baselinePath !== "" && !fs.existsSync(baselinePath)) {
    console.error(`candor-ts: CANDOR_BASELINE ${baselinePath} does not exist — the regression guard is `
      + `not active (record one: candor-ts <target> --out <prefix>, then point at the report .json).`);
  } else {
    let root = null;
    try { root = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch { /* root stays null → exit 2 */ }
    const arr = Array.isArray(root) ? root : (root && typeof root === "object" ? root.functions : null);
    if (!Array.isArray(arr)) {
      console.error(`candor-ts: baseline ${shownB} exists but could not be parsed (corrupt/truncated?) — `
        + `failing (exit 2); the guard must not silently pass on an unreadable baseline. Regenerate it with this build.`);
      // ⟨0.27⟩ the refusal document has no exempt cause AND no exempt sink (SPEC §3.1): a file sink holds
      // the armed placeholder, but `--gate-json -` is not armed, so without this write the stream carried
      // NOTHING on this cause. Writing here also replaces the placeholder with the specific reason.
      writeRefusal(`baseline ${shownB} exists but could not be parsed — guard NOT evaluated`);
      process.exit(2);
    }
    const baseVersion = !Array.isArray(root) && root.candor && typeof root.candor === "object"
      && typeof root.candor.version === "string" ? root.candor.version : null;
    if (baseVersion === null) {
      console.error(`candor-ts: the baseline ${shownB} has no provenance header (a legacy/bare-array report) — `
        + `a baseline is comparable only to its producing build (§2.1). Failing (exit 2); regenerate it with this build.`);
      writeRefusal(`baseline ${shownB} has no provenance header — guard NOT evaluated`);   // ⟨0.27⟩ see above
      process.exit(2);
    }
    if (baseVersion !== ENGINE_VERSION) {
      console.error(`candor-ts: the baseline ${shownB} was produced by engine build ${baseVersion} but this is `
        + `build ${ENGINE_VERSION} — an engine swap is baseline-invalidating and the gate cannot evaluate `
        + `(exit 2; never a silent skip, never a bogus AS-EFF-005 wave). Regenerate deliberately with this build.`);
      writeRefusal(`baseline ${shownB} was produced by engine build ${baseVersion}, not this build — guard NOT evaluated`);   // ⟨0.27⟩ see above
      process.exit(2);
    }
    const base = new Map();
    for (const e of arr) {
      if (e && typeof e.fn === "string" && e.fn) base.set(e.fn, new Set(Array.isArray(e.inferred) ? e.inferred : []));
    }
    // ⟨0.16⟩ Load the baseline callgraph sidecar next to the baseline report. The sidecar for a
    // report at <stem>.json is <stem>.callgraph.json (scan.mjs writes exactly this pair). Three states:
    //   loaded  — a parsed object → its node set (every key + every callee) keys existence, mirroring
    //             the `gains` origin test (query-core.mjs). A baseline-callgraph node whose baseline
    //             effects are ∅ (pure → omitted from the report) that now performs an effect is a GAIN.
    //   absent  — no sidecar file → degrade to report-only existence + one stderr note (guard weaker).
    //   corrupt — file present but not parseable / not a plain object → fail closed (exit 2). A broken
    //             sidecar must not silently narrow the guard (SPEC §7 item 5).
    // shownB may be "(configured empty)"; the real path is baselinePath here (non-null, exists).
    const sidecarPath = baselinePath.replace(/\.json$/i, "") + ".callgraph.json";
    let cgNodes = null;                                     // null = sidecar absent (report-only degrade)
    if (fs.existsSync(sidecarPath)) {
      let baseCg = null;
      try { baseCg = JSON.parse(fs.readFileSync(sidecarPath, "utf8")); } catch { baseCg = undefined; }
      // A non-object parse (null / array / number) is a corrupt sidecar: it cannot list nodes, and
      // treating it as "absent" would silently narrow the guard — fail closed like a corrupt baseline.
      if (baseCg === undefined || baseCg === null || typeof baseCg !== "object" || Array.isArray(baseCg)) {
        console.error(`candor-ts: the baseline callgraph ${sidecarPath} is present but could not be parsed `
          + `(corrupt/truncated?) — failing (exit 2); a broken sidecar must not silently narrow the guard to `
          + `report-only. Regenerate the baseline with this build.`);
        writeRefusal(`baseline callgraph ${sidecarPath} could not be parsed — guard NOT evaluated`);   // ⟨0.27⟩ see above
        process.exit(2);
      }
      // The node set = every caller key + every callee (a pure leaf appears only as a callee), exactly
      // as `gains` computes cgNodes. Non-array edge values are tolerated (skipped), matching loadCallgraph.
      cgNodes = new Set(Object.entries(baseCg).flatMap(([k, vs]) => [k, ...(Array.isArray(vs) ? vs : [])]));
    } else {
      console.error(`candor-ts: no baseline callgraph sidecar at ${sidecarPath} — the AS-EFF-005 guard is `
        + `WEAKER: existence falls back to the report, which omits pure functions, so a formerly-PURE fn `
        + `turning effectful reads as new code and is NOT caught (only an already-effectful fn widening is). `
        + `Regenerate the baseline with --out so the .callgraph.json is written alongside it.`);
    }
    const unknownOnly = [];   // ⟨0.16⟩ advisory: fns that gained ONLY Unknown vs the baseline
    for (const name of [...inferred.keys()].sort()) {
      const prior = base.get(name);
      // ⟨0.16⟩ Existence ladder: in the baseline REPORT → its recorded inferred set is the prior;
      // else a baseline-callgraph NODE (sidecar present) → it existed and was pure, so prior = ∅ (any
      // effect now is a gain); else genuinely absent → new code, exempt. Without the sidecar (cgNodes
      // null) only the report path decides, the pre-⟨0.16⟩ semantics.
      const priorSet = prior !== undefined ? prior
        : (cgNodes !== null && cgNodes.has(name)) ? new Set()   // baseline-pure node → ∅ prior
        : null;                                                 // new function — not a regression
      if (priorSet === null) continue;
      const gained = [...inferred.get(name)].filter((x) => !priorSet.has(x)).sort();
      if (!gained.length) continue;
      // ⟨0.16⟩ the ratchet fires only on gaining a REAL boundary effect. An Unknown-ONLY gain is
      // the §4 trust marker, not an effect (`pure` policies exclude it), and on version bumps it is
      // dominated by resolution noise — DISCLOSE it (advisory), never fail the gate on it. Mirrors the
      // reference engine (candor-scan gate.rs check_baseline).
      const real = gained.filter((x) => x !== "Unknown");
      if (!real.length) {
        // ⟨unknown-ratchet⟩ OPT-IN (config `unknown-ratchet` / CANDOR_UNKNOWN_RATCHET, default OFF).
        // This is what makes `deny E Unknown` adoptable on legacy DI/reflection-heavy code: the CURRENT
        // Unknown surface is GRANDFATHERED (a fn already Unknown in the baseline shows no gain ⇒ never
        // flagged), and only a NEWLY-introduced Unknown — a blind spot the baseline did not have — fails.
        // A team freezes today's report as the baseline and the strict gate ratchets the Unknown surface
        // DOWN instead of failing everywhere on day one; grandfather one by regenerating the baseline.
        // Default OFF preserves the ⟨0.16⟩ advisory posture (Unknown-gains = resolution noise). Mirrors
        // the reference engine (candor-java Policy.checkBaseline).
        if (unknownRatchet) {
          gateViolations.push({ rule: "AS-EFF-005", fn: name, effects: ["Unknown"],
            detail: `\`${name}\` gained an unresolved call (Unknown) not in the baseline — a NEW blind spot `
              + `(unknown-ratchet); resolve it, or regenerate the baseline to grandfather it` });
        } else {
          unknownOnly.push(name);
        }
        continue;
      }
      gateViolations.push({ rule: "AS-EFF-005", fn: name, effects: real,
        detail: `\`${name}\` gained effect { ${real.join(", ")} } not present in the baseline` });
    }
    if (unknownOnly.length) {
      unknownOnly.sort();
      const shown = unknownOnly.slice(0, 3).join(", ");
      const more = unknownOnly.length > 3 ? ` (+${unknownOnly.length - 3} more)` : "";
      console.error(`candor-ts: note — ${unknownOnly.length} function(s) gained an unresolved call `
        + `(Unknown) vs the baseline but no real effect — advisory, NOT a regression (Unknown is the §4 `
        + `trust marker, dominated by resolution noise on version bumps): ${shown}${more}`);
    }
  }
}

// ---- the standing §6.2 gate (--policy / CANDOR_POLICY) --------------------------------------------
// `!== null`, not truthiness: a CONFIGURED-but-EMPTY policy (a bare `policy` config line, a set-but-
// empty CANDOR_POLICY) is "" — falsy, so a truthy check silently skipped the gate, the exact quiet
// drop the config comment above promises fails loud. "" now reaches the read, which fails → exit 2
// (the Rust engine's behavior on the same input).
if (policyPath !== null) {
  let text = null;
  try {
    text = fs.readFileSync(policyPath, "utf8");
  } catch {
    // a set-but-unreadable policy must be LOUD — silently passing would let a violation ship
    const { why, unevaluated } = policyUnreadable(policyPath);
    console.error(`candor-ts: ${why}`);
    // ⟨0.24⟩ …and it must not leave YESTERDAY'S document at the --gate-json path (SPEC §3.1 `1503368`:
    // the refusal document has no exempt cause — a stale green does not care why this run declined to
    // overwrite it). `candor <src> --policy <typo> --gate-json <path>` is the more common CI shape than
    // `gate --report`, so closing only the query route would be closing half the hazard.
    // ⟨0.24⟩ RECORDED, NOT EXECUTED HERE (SPEC §3.1 `4c79958`) — see the emission block below.
    policyRefusal = { why, unevaluated };
  }
  if (text !== null) {
    // The masking-incompleteness map (fn -> effects whose surface is incomplete), kept INTERNAL like the
    // java/rust engines (not a report field) — passed to the gate so an incomplete surface fails closed.
    const incompleteMap = new Map();
    for (const [name, rec] of fns) if (rec.incomplete.size) incompleteMap.set(name, rec.incomplete);
    // ⟨0.19⟩ reason-class aliases (SPEC §6.2) from `.candor/config`, so `Unknown[<alias>]` resolves at the gate.
    // ⟨0.24⟩ ANCHORED AT THE POLICY FILE, not at the target (SPEC §3.1 `99eb4e9`). Vocabulary travels with the
    // policy that uses it. This route anchored at the TARGET while `gate --report` anchored at the POLICY, so
    // with the policy filed outside the scan target the two expanded the SAME rule differently and §3.1's
    // byte-equality MUST was breakable by a file that is neither the report nor the policy. `net-partner`
    // (above, at the target) is deliberately NOT moved: it describes the thing being scanned.
    const parseErrs = [];
    const unknownAliases = parseUnknownAliases(discoverConfigText(policyVocabularyAnchor(policyPath, target)), parseErrs);
    const gatePolicy = parsePolicy(text, unknownAliases);
    parseErrs.push(...gatePolicy.errors);
    // ⟨0.24⟩ only the UNRECOGNISED VALUE TOKENS refuse. `errors` now also carries every LINE this parser
    // dropped whole (SPEC §3.1 `195d45a`), which is additive to the `parsepolicy` witness and deliberately
    // silent about the gate — refusing there would be a grammar change, not a token change.
    const policyErrs = fatalPolicyErrors(parseErrs);
    // ⟨0.24⟩ SPEC §6.2 (`382a7e0` + `be0b9a9`): an unrecognised value token — in a reason-class filter, a Net
    // destination-class filter, or an alias DEFINITION — is a POLICY ERROR. Dropping it rewrites the policy
    // into a different one: alone the rule WIDENS to the bare effect, beside valid tokens it NARROWS and stops
    // gating what was spelled while the gate still looks armed. Exit 2, policy NOT evaluated.
    if (policyErrs.length) {
      const why = policyErrorText(policyPath, policyErrs);
      console.error(why);
      // ⟨0.27⟩ ONE `unevaluated` ENTRY PER RULE OF THE POLICY — not only the unhonourable lines (SPEC
      // §3.1's composed-document clause). Measured: listing only the bad token's line let a consumer read
      // `deny Fs`, absent from the exit-1 document's list, as evaluated-and-passed. The SHARED builder,
      // so this document and `gate --report`'s stay byte-equal (§3.1's acceptance test for the routes).
      policyRefusal = { why, unevaluated: policyRefusalUnevaluated(text, policyErrs) };
    } else if (!gatePolicy.deny.length && !gatePolicy.allow.length && !gatePolicy.forbid.length) {
      // ⟨0.28⟩ A CONFIGURED POLICY THAT YIELDED ZERO RULES IS A BROKEN GATE CONFIG (SPEC §6.2) — the same
      // refusal posture as the two branches above, and for the reason §6.2 already gives for an unreadable
      // FILE: "a typo'd policy path that runs green is a gate that silently passes everything". MEASURED
      // four-way 2026-08-10: `--policy <a README>` wrote `{"ok":true,"violations":[]}` and exited 0 on
      // every engine — byte-identical to a gate that ran and found nothing, AND byte-identical to the
      // no-gate-configured verdict (§3.3), so the one consumer this format exists for cannot tell "your
      // code is clean" from "your gate had no rules". The per-line `ignoring policy rule` warnings above
      // go to stderr, which is not the machine channel.
      //
      // The line-level ignore-with-a-warning leniency is UNTOUCHED and still right: silent reinterpretation
      // is the one thing a security gate must not do, and an engine meeting a rule kind from a newer rung
      // must not refuse the whole file over it. This rung is about what that leniency COMPOSES TO — a file
      // in which EVERY line was ignored is a gate that asked nothing.
      //
      // THE CONTROL, which is what makes this a rule and not a blanket: reaching here at all means a policy
      // was CONFIGURED (`--policy`, CANDOR_POLICY, or the `.candor/config` `policy` key — all three land in
      // `policyPath`). A run that configured no gate never enters this block and stays exit 0; that is the
      // honest way to say "I am not gating", and it is exactly why a configured zero-rule policy is never a
      // legitimate expression of that intent.
      //
      // EVERY RULE VECTOR, and rust's first draft of this check read only its `rules`. `parsePolicy` splits
      // the four kinds across THREE arrays — `deny` (both `deny` and `pure`), `allow` and `forbid` — so
      // keying on one made an allow-only policy (`allow Net api.stripe.com`, an ordinary allowlist gate) or
      // a forbid-only layer policy refuse as if it had no rules at all. A zero-rule test that inspects a
      // subset of the rule kinds is the same false-answer shape this rung exists to close, pointed the
      // other way.
      const { why, unevaluated } = policyZeroRules(policyPath);
      console.error(`candor-ts: ${why} — refusing (exit 2, gate NOT enforced). Every line was ignored (see `
        + `the \`ignoring policy rule\` warnings above), the file is empty, or it holds only comments. A `
        + `gate with no rules cannot have caught anything, and reporting \`ok: true\` here would be `
        + `indistinguishable from a gate that ran and found nothing. If you did not mean to gate this run, `
        + `remove the \`policy\` setting rather than pointing it at a file with no rules in it.`);
      // …RECORDED, NOT EXECUTED, so it takes the SAME precedence as both branches above (SPEC §3.1
      // `4c79958`): a certain violation dominates a refusal. No POLICY violation can exist with zero rules,
      // but an AS-EFF-005 baseline regression is a finding from evidence this run already carries, and it
      // rides exit 1 with this refusal disclosed beside it under `unevaluated`.
      policyRefusal = { why, unevaluated };
    } else {
      // ⟨0.24⟩ the config file that supplied vocabulary the verdict USED, so an ambient `.candor/config` — the
      // walk goes up through every parent, and CANDOR_CONFIG overrides it outright — cannot move a verdict while
      // staying unnamed in the output (SPEC §3.1 `99eb4e9`).
      if (Object.keys(gatePolicy.aliasesUsed).length) {
        const p = discoverConfigPath(policyVocabularyAnchor(policyPath, target));
        if (p) policyVocabulary = { config: p, aliases: gatePolicy.aliasesUsed };
      }
      const gateOut = evaluatePolicy(gatePolicy, functions, cg, incompleteMap, netPartners);
      // ⟨0.27⟩ SPEC §4 — a rule that bound NO function is disclosed, never scored as satisfied. The exit
      // code is deliberately untouched: a zero-match rule is legitimate when one policy is shared across
      // repositories and a layer exists in only some of them, so refusal would make a shared policy
      // unusable. Printed before the violations so a typo'd layer name is visible above the verdict.
      for (const raw of gateOut.zeroMatch ?? []) {
        console.error(`candor: policy rule matched NO function — \`${raw}\`. It was evaluated and bound `
          + `nothing, so it cannot have caught anything. Legitimate when one policy is shared across `
          + `repos; a typo'd layer name otherwise.`);
      }
      // ⟨0.27⟩ captured BEFORE the concat below — `concat` returns a plain array, so the `zeroMatch`
      // property riding `gateOut` would be silently lost with it (see the gateZeroMatch declaration).
      gateZeroMatch = gateOut.zeroMatch ?? [];
      gateViolations = gateViolations.concat(gateOut);
      // Provable-purity DISCLOSURE (advisory — NEVER a violation, so the exit/verdict are untouched): functions
      // in a pure/deny scope that PASS but are Unknown (the Unknown could hide the forbidden effect — a
      // fn/closure-injected port). Surfaces the gap automatically (eval/fixloop/DISPATCH-NOTE.md).
      const disclosePolicy = gatePolicy;
      // ⟨0.24⟩ the SAME narrowing context `evaluatePolicy` just used — this is the scan-time CHANNEL of the
      // `unverified` disclosure, and the class filter has to reach it too or the note names a hole the gate
      // beside it already excluded. Built from the scan's LIVE evidence (hosts + the masked-surface flag +
      // the config `net-partner` list), none of which travels on the wire, so it is strictly better-informed
      // than the report route's — and correspondingly it is the route where a re-derivation would be wrong.
      const discloseNetClassOf = netClassResolver(incompleteMap, netPartners, null);
      const discloseReasonAcc = resolveReasonClasses(functions, cg);
      const discloseByName = new Map(functions.map((f) => [f.fn, f]));
      const discloseCtx = { reasonAcc: discloseReasonAcc, netClassOf: discloseNetClassOf,
                            entry: (fn) => discloseByName.get(fn) ?? null };
      const purityHoles = [];
      for (const f of functions) {
        // Same predicate + upgrade as `candor-ts-query unverified` (query-core.mjs) — one source of truth.
        const r = unverifiedHoleRule(f.fn, f.inferred, disclosePolicy, scopeMatches, discloseCtx);
        if (r) purityHoles.push([f.fn, ruleUpgrade(r)[1]]);
      }
      if (purityHoles.length) {
        console.error(`candor-ts: note — ${purityHoles.length} function(s) PASS the policy but are Unknown (purity NOT verified — the Unknown could hide a forbidden effect):`);
        for (const [fn, up] of purityHoles) console.error(`    \`${fn}\`  → add  \`${up}\``);
        console.error("  (advisory; add the upgrade(s) to REQUIRE provable purity, or run `candor-ts-query unverified` for detail — the gate verdict is unchanged)");
      }
    }
  }
}
// ⟨0.24⟩ PRECEDENCE BINDS THE VERDICT, NOT THE POLICY GATE (SPEC §3.1 `4c79958`). This is the only place
// that decides between a VERDICT and a REFUSAL, and it now decides on what the run ESTABLISHED rather than
// on where it ended. Measured before the repair — a pure function gains an `Fs` call, scanned against a
// frozen baseline:
//
//     control (no policy)          -> exit 1, violations ["AS-EFF-005"]
//     + a policy with a bad token  -> exit 2, NO `violations` key      <- the regression was DELETED
//
// So a typo in a policy token downgraded "your change added an effect" to "could not evaluate", and the
// finding survived only on stderr — the human kept it and CI lost it. Three individually-correct decisions
// composed into it: the AS-EFF-005 baseline guard runs FIRST by design, the precedence repair was scoped to
// the policy gate's own violation list, and "a refusal document carries no `violations` key" was justified
// by every exit-2 site running before anything could be recorded — a claim about ORDERING that reads as a
// claim about SHAPE, and false the moment a producer's evidence sat upstream of the refusal.
//
// The refusal arm therefore keys on `gateViolations.length`, never on "this run ended refused". The
// baseline guard's evidence is complete and certain; a policy this engine cannot READ or cannot HONOUR
// says nothing about it, so by Lemma 2 the established violation stands however the policy would have
// resolved — and the refusal rides ALONGSIDE it under `unevaluated` rather than replacing it.
for (const x of gateViolations) emitViolation(`[${x.rule}] ${x.detail}`);
if (policyRefusal && !gateViolations.length) {
  // Nothing was established, so the refusal IS the whole answer and takes its documented shape (no
  // `violations` key — an absent key, because the gate is making no claim about violations).
  writeRefusal(policyRefusal.why, policyRefusal.unevaluated);
  process.exit(2);
}
// --gate-json ⟨0.8⟩: the structured gate verdict { spec, ok, violations:[{rule,fn,effects,detail}] }, from
// the SAME gateViolations that set the exit code (so it can't disagree). Written whenever the flag is set —
// ok:true,[] when no gate is configured. Must precede the exit(1) below.
if (gateJsonPath) {
  // ⟨0.21⟩ COMPLETENESS MANIFEST (Gap 2): a gate over code candor could NOT fully analyze (unparsed .ts)
  // must NOT read green — those effects are invisible, so a `deny`/`pure` that "passes" over them is a
  // false-pure. `ok` requires BOTH no violation AND a complete analysis. `analyzed:{count}` (Gap 1) mirrors
  // the report envelope so a --gate-json consumer sees the scan's scope from the verdict alone.
  const incomplete = unanalyzedUnits.length > 0;
  const verdictObj = { spec: SPEC_VERSION, ok: gateViolations.length === 0 && !incomplete,
                       analyzed: { count: fns.size } };
  // ⟨0.24⟩ the vocabulary file that moved the verdict, in the SAME position `gate --report` puts it, because
  // §3.1 makes byte-equality between the two routes the acceptance test. Omitted when no alias was used.
  if (policyVocabulary) verdictObj.policyVocabulary = policyVocabulary;
  verdictObj.violations = gateViolations;
  // ⟨0.24⟩ …and when a certain violation DOMINATED a policy refusal, the refusal is disclosed here rather
  // than deleted (SPEC §3.1: "the RAW policy line, verbatim", one entry per rule, omitted when empty). A
  // consumer reading exit 1 must be able to see that the POLICY half of the gate never ran — the same
  // `unevaluated` key, in the same position, that `gate --report` uses for its answerability refusals.
  if (policyRefusal) verdictObj.unevaluated = policyRefusal.unevaluated;
  // ⟨0.27⟩ SPEC §4 `zeroMatch` — the same list the stderr lines carry, in the machine channel. Omitted
  // when empty so a fully-binding verdict is byte-identical; never consulted for `ok` or the exit code.
  if (gateZeroMatch.length) verdictObj.zeroMatch = gateZeroMatch;
  // ⟨0.21⟩ (Gap 2) the machine-legible incompleteness: the units candor couldn't analyze, so a CI/agent
  // reading the JSON learns WHY the gate can't certify (the stderr warning alone used to hide this from a
  // machine). `incomplete:true` + the list; the run exits 2 (could-not-fully-evaluate) below. ok:false +
  // incomplete:true is honest — never a fabricated pass. OMITTED when complete (byte-compatible verdict).
  if (incomplete) {
    verdictObj.incomplete = true;
    verdictObj.unanalyzed = unanalyzedUnits.map((u) => ({ path: u.path, reason: u.reason }));
  }
  // ⟨0.15 staged⟩ coverage ADVISORY (COVERAGE-DESIGN.md §3): when the κ ledger is non-empty, the
  // verdict discloses what the gate could NOT see — VERDICT-PRESERVING (the ⟨0.9⟩ provable-purity
  // auto-disclosure precedent exactly): ok/violations/exit are computed above and untouched here. A
  // gate does not fail on uncovered deps (nearly every real scan has some); the policy author sees
  // the note and decides — `deny Unknown` remains the opt-in strict posture. OMITTED when fully
  // covered, so a pre-0.15 consumer's verdict is byte-identical.
  if (uncoveredLedger.length) {
    verdictObj.coverage = { uncovered: uncoveredLedger.length, packages: uncoveredLedger.map(([p]) => p) };
  }
  const verdict = JSON.stringify(verdictObj, null, 1);
  if (gateJsonPath === "-") console.log(verdict);
  else {
    // The verdict is a SURFACING side-output: an unwritable path must be one stderr line, never a raw
    // ENOENT crash whose exit 1 reads as a policy violation on a clean run (max-review find).
    try { writeAtomic(gateJsonPath, verdict + "\n"); }
    catch (e) { console.error(`candor-ts: could not write --gate-json ${gateJsonPath}: ${e.message}`); }
  }
}
// gateViolations is non-empty only when a gate surface (policy / baseline) was active and fired.
if (gateViolations.length) {
  console.error(`candor-ts: ${gateViolations.length} policy violation(s)`);
  // FAILURE-only pointer at the engine's own remedy verb (append-only, same stream as the summary; a
  // zero-violation run is byte-identical — the exit code, violation lines and summary text are pinned
  // by the conformance suite and stay untouched).
  if (policyRefusal)
    console.error(`candor-ts: …and the policy at ${policyPath === "" ? "(configured empty)" : policyPath} could not be evaluated (disclosed above and under \`unevaluated\`) — the violation(s) named are certain regardless of how it would have resolved`);
  console.error("→ candor-ts-query fix-gate names the remedy for each");
  process.exit(1);
}
// ⟨0.21⟩ COMPLETENESS MANIFEST (Gap 2): a CONFIGURED gate over code candor could NOT fully analyze (unparsed
// .ts) cannot certify — exit 2 (could-not-evaluate), the fail-closed posture (matches candor-scan's
// had_parse_failure + the java reference). A real violation (exit 1, above) dominates. A BARE scan with NO
// gate does not exit 2 — it discloses `unanalyzed` in the report and stays exit 0. This is the cardinal-sin
// fix: a broken .ts is no longer silently PARTIALLY analyzed and certified green.
const gateConfigured = policyPath !== null || baselinePath !== null;
if (gateConfigured && unanalyzedUnits.length) {
  console.error(`candor-ts: gate NOT certified — ${unanalyzedUnits.length} source file(s) could not be analyzed (see above); a gate cannot be green over unanalyzed code`);
  process.exit(2);
}
if (policyPath !== null) console.error("candor-ts: policy ✓");
if (baselinePath !== null && fs.existsSync(baselinePath)) console.error("candor-ts: baseline ✓"); // absent = inactive (noted above)
