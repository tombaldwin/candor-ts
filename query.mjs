#!/usr/bin/env node
/**
 * candor-ts queries — the SPEC §3.1 read-only query surface + the §6.2 policy grammar, over the
 * report + callgraph sidecar that scan.mjs writes. Same command names, same JSON shapes, same match
 * ladder as the Rust and JVM engines (the cross-impl conformance suite diffs all three).
 *
 * Provenance note (honesty): the ORIGINAL scan.mjs was written from the spec documents alone — the
 * clean-room derivability proof. This file was added later, implemented from the same spec text,
 * but its author had by then read the reference engines; the ongoing guarantee for it is the
 * conformance differential, not clean-room provenance.
 *
 * CANONICAL grammar (candor-spec §3.3.1 ⟨0.10⟩ — one shape, every engine):
 *   node query.mjs <verb> <verb-args…> [--report <locator>] [--policy <file>] [--json] [--strict] [--include-unknown]
 * The report is DISCOVERED (walk up from CWD for a `.candor/` dir → `<that>/.candor/report`; CANDOR_REPORT
 * overrides) unless --report gives a locator (a dir → `<dir>/.candor/report`; a `.json` path → that report
 * path; else a prefix). diff/gains are the exception: two positional locators <current> <baseline>.
 *
 * DEPRECATED aliases (kept accepted through the 0.10 line, stderr-noted — candor-spec §3.3.1 / PART 17):
 *   node query.mjs <verb> <PREFIX> <verb-args…> [0|1]      (leading-positional report + trailing 0|1 sentinel)
 *   node query.mjs whatif/fix <prefix> <fn> <Effect> [policy-file] [0|1]   (positional policy)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePolicy, scopeMatches, discoverConfigPolicy, parseUnknownAliases, discoverConfigText } from "./policy.mjs";
import { hasReport } from "./query-core.mjs";
import { printAgents } from "./contract.mjs";
import { bestFinds } from "./surface.mjs";
import { isTestPath } from "./scan-core.mjs";
// ONE source of truth for loading + name-matching — query.mjs kept DRIFTED local copies that didn't
// merge sibling reports, didn't tolerate a corrupt report (bare JSON.parse → uncaught crash), and used
// a `matchTier` missing `#` (so the SAME query resolved differently between `impact` and `callers` on a
// JVM `Type#method` report). Importing the shared functions removes all three divergences (review find).
import { impact as coreImpact, path as corePath, gains as coreGains,
         show as coreShow, blindspots as coreBlindspots, blindspotsStats as coreBlindspotsStats,
         callers as coreCallers, callersFrontier, loadHierarchy,
         containment as coreContainment, diff as coreDiff,
         where as coreWhere, map as coreMap, whatif as coreWhatif,
         fix as coreFix, fixGate as coreFixGate, unverified as coreUnverified,
         matches as coreMatches, gainsCoverage,
         loadReport, loadCallgraph, reportVersion, reportPackage } from "./query-core.mjs";
const emit = (v) => console.log(JSON.stringify(v, null, 1));
// The §6 effect vocabulary — used to reject a typo'd effect name in `where` (corpus-audit #3). Kept in step
// with SPEC §6 / the umbrella's list; an unknown name PRESENT in a report (a spec extension) is still allowed.
const KNOWN_EFFECTS = ["Net", "Fs", "Db", "Llm", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard", "Unknown"];
// Suggest the nearest known flag for a typo (longest shared prefix ≥3): `--polciy` → `--policy` (#2).
function didYouMeanFlag(unknown) {
  const known = ["--report", "--policy", "--json", "--text", "--strict", "--include-unknown", "--stats", "--class"];
  const u = unknown.replace(/^-+/, "").toLowerCase();
  let best = null, bestLen = 2;
  for (const k of known) {
    const kn = k.replace(/^-+/, "");
    let s = 0; while (s < u.length && s < kn.length && u[s] === kn[s]) s++;
    if (s >= 3 && s > bestLen) { bestLen = s; best = k; }
  }
  return best ? ` — did you mean \`${best}\`?` : "";
}

// ---- #8 output mode: PROSE at a TTY, JSON when piped or `--json` — so interactive `candor where Db` reads
// like candor-java/-rust instead of dumping raw JSON, while a pipe/redirect (never a TTY) still yields the
// pinned JSON untouched. MCP/LSP call query-core directly (not this CLI), so they're unaffected; conformance
// passes `--json` or captures over a pipe → JSON. `--json` forces JSON; `--text`/`--human` forces prose. -----
const wantJsonOut = (a) =>
  a.includes("--json") || (!a.includes("--text") && !a.includes("--human") && !process.stdout.isTTY);
// Emit the pinned JSON, or render prose via proseFn(data). Returns data so the caller can still exit on it.
const put = (a, data, proseFn) => { if (!proseFn || wantJsonOut(a)) emit(data); else proseFn(data); return data; };
const csv = (xs) => (xs && xs.length ? xs.join(", ") : "none");
const rows = (xs, pre = "    ") => { for (const x of xs) console.log(pre + x); };
// Per-verb prose renderers. Read the SAME shapes query-core returns (so JSON and prose can't drift); kept
// terse and scannable, in candor's voice (cf. the existing `tour`/`path` human forms).
const P = {
  where: (d) => {
    const n = d.directly.length + d.inherited.length;
    if (n === 0) { console.log(`candor: 0 functions perform ${d.effect} in this report.`); return; }
    console.log(`candor where ${d.effect} — ${n} function${n === 1 ? "" : "s"}:`);
    if (d.directly.length) { console.log(`  perform it directly (${d.directly.length}):`); rows(d.directly); }
    if (d.inherited.length) { console.log(`  reach it transitively (${d.inherited.length}):`); rows(d.inherited); }
  },
  callers: (d) => {
    if (!d.of.length) { console.log("candor: no function in the call graph matches that name."); return; }
    console.log(`candor callers — who reaches \`${d.of.join("`, `")}\`:`);
    console.log(`  direct callers (${d.direct.length}): ${csv(d.direct)}`);
    console.log(`  transitive callers (${d.transitive.length}): ${csv(d.transitive)}`);
  },
  show: (d) => {
    if (!d.length) { console.log("candor: no effectful function matches that name (pure functions are omitted from the report)."); return; }
    d.forEach((e, i) => {
      if (i) console.log("");
      console.log(`${e.fn}`);
      console.log(`  effects: ${csv(e.inferred)}${e.direct && e.direct.length ? `   (direct: ${e.direct.join(", ")})` : ""}`);
      if (e.hosts?.length)  console.log(`  hosts:   ${e.hosts.join(", ")}`);
      if (e.cmds?.length)   console.log(`  cmds:    ${e.cmds.join(", ")}`);
      if (e.paths?.length)  console.log(`  paths:   ${e.paths.join(", ")}`);
      if (e.tables?.length) console.log(`  tables:  ${e.tables.join(", ")}`);
    });
  },
  map: (d) => {
    const mods = Object.entries(d);
    if (!mods.length) { console.log("candor: no effectful modules in this report."); return; }
    console.log("candor map — effects by module:");
    for (const [m, v] of mods) console.log(`  ${m} — ${csv(v.effects)}  (${v.functions} fn${v.functions === 1 ? "" : "s"})`);
  },
  containment: (d) => {
    if ("leaks" in d) { // ratchet (a baseline was given)
      if (!d.leaks.length) console.log("candor containment — no boundary effect reached a new layer vs the baseline. ✓");
      else { console.log(`candor containment — ${d.leaks.length} boundary effect(s) reached a NEW layer (leak):`); rows(d.leaks); }
      if (d.cleanups && d.cleanups.length) { console.log(`  no longer present (${d.cleanups.length}):`); rows(d.cleanups); }
      return;
    }
    if (!d.contained.length && !Object.keys(d.ambient).length) { console.log("candor containment — no boundary effects in this report."); return; }
    console.log("candor containment — how well each boundary effect stays in one layer:");
    for (const c of d.contained)
      console.log(`  ${c.effect}: ${c.containmentPct}% in \`${c.owner}\` (spread across ${c.layers} layer${c.layers === 1 ? "" : "s"})`);
    const amb = Object.entries(d.ambient);
    if (amb.length) console.log(`  ambient (reported, not scored): ${amb.map(([e, n]) => `${e}×${n}`).join(", ")}`);
  },
  reachable: (d) => {
    const effs = Object.entries(d.effects);
    console.log(`candor reachable — what the ${d.entryPoints} entry point${d.entryPoints === 1 ? "" : "s"} do at runtime:`);
    if (!effs.length) { console.log("  no effect reaches an entry point."); return; }
    for (const [e, v] of effs) console.log(`  ${e}: ${v.count} (via ${csv(v.via)})`);
  },
  impact: (d) => {
    console.log(`candor impact — the blast radius of \`${d.fn}\`:`);
    console.log(`  ${d.affectedCount} effectful function(s) transitively call it${d.affected.length ? ":" : "."}`);
    if (d.affected.length) rows(d.affected);
    if (d.entryPoints.length) { console.log(`  reachable from ${d.entryPoints.length} entry point(s):`); rows(d.entryPoints.map((ep) => `${ep.fn}  [${csv(ep.inferred)}]`)); }
  },
  blindspots: (d) => {
    if (!d.sources.length) { console.log(`candor blindspots — no Unknown sources${d.totalUnknown ? " (all Unknown here is inherited, not rooted in a call)" : ""}. ✓`); return; }
    console.log(`candor blindspots — ${d.sources.length} Unknown source${d.sources.length === 1 ? "" : "s"} (of ${d.totalUnknown} function(s) carrying Unknown), most-smearing first:`);
    for (const s of d.sources) console.log(`  \`${s.fn}\` — ${csv(s.why)}; reaches ${s.reaches} caller(s)`);
  },
  blindspotsStats: (d) => {
    if (!d.sources) { console.log("candor blindspots --stats — no Unknown sources (nothing to classify). ✓"); return; }
    console.log(`candor blindspots --stats — ${d.sources} Unknown source(s) by reason class (of ${d.totalUnknown} function(s) carrying Unknown) — size the blind-spot cost before \`deny E Unknown[…]\`:`);
    Object.entries(d.byClass).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}${k === "setup" ? "   ← fixable: the scan isn't configured, not a real blind spot" : ""}`));
  },
  gains: (d) => {
    if (!d.gained.length) { console.log("candor gains — no newly-reached effects vs the baseline. ✓"); return; }
    console.log(`candor gains — the surface newly reaches: ${d.gained.join(", ")}`);
    for (const g of d.byFunction) console.log(`  \`${g.fn}\` gained ${g.effect}${g.origin ? `  (${g.origin})` : ""}`);
  },
  diff: (d) => {
    if (!d.changes.length) { console.log("candor diff — no effect changes vs the baseline. ✓"); return; }
    console.log(`candor diff — ${d.changes.length} function(s) changed vs the baseline:`);
    for (const c of d.changes) console.log(`  \`${c.fn}\`${c.gained.length ? `  +${c.gained.join(",")}` : ""}${c.lost.length ? `  -${c.lost.join(",")}` : ""}`);
  },
};

// Render `path` in HUMAN (non-`--json`) form — the indented provenance chain, BYTE-IDENTICAL to the
// Rust reference (candor-query/src/callers.rs) and the Java port (Query.java). The `--json` shape is
// UNTOUCHED (conformance PART 5 pins `{effect, fn, path:[{fn,loc,source}]}` four-way): this path is
// only taken when the caller did NOT pass --json, and it reads the SAME `path` array corePath computes.
// Prints to stdout and returns nothing (matches the JSON-only verbs' fire-and-forget style).
function renderPathHuman(fns, cg, fnQ, eff) {
  // Resolve the start over the REPORT entries (as Rust does) — that's where `inferred` lives, and the
  // no-effect wording quotes it. The RESOLVED name (not the raw query) is then handed to corePath,
  // which re-resolves over the CALLGRAPH keys — a DIFFERENT name set: a raw partial query could pick
  // a different fn there (report `app.db.save`, graph `app.cache.save` for the query "save"), so the
  // header described one function and the chain/verdict another (a misleading "not statically
  // traceable" over a traceable fn). An exact name resolves identically in both sets (match tier 3,
  // exact, beats every partial tier and only its own name can equal it), so they cannot disagree.
  const start = coreMatches(fns.map((e) => e.fn), fnQ)[0];
  if (start === undefined) {
    // No matching function at all — parity with Rust/Java's "no function matching" (stderr, exit 2).
    console.error(`candor-query path: no function matching '${fnQ}'`);
    process.exit(2);
  }
  const startEntry = fns.find((e) => e.fn === start);
  const inferred = startEntry?.inferred ?? [];
  if (!inferred.includes(eff)) {
    // The effect is not even inferred — the honest "does not perform" answer (SPEC §3.1), NOT an error.
    // `inferred` is printed in Rust's `{:?}` debug shape: each name quoted, ", "-joined, in `[...]`,
    // in the report's original order (unsorted). An empty set prints `[]`.
    const dbg = `[${inferred.map((e) => `"${e}"`).join(", ")}]`;
    console.log(`${start} does not perform ${eff}  (inferred: ${dbg})`);
    return;
  }
  const r = corePath(fns, cg, start, eff);
  if (r.path.length === 0) {
    // Inferred, but no LOCAL direct source on a `calls` path — reached cross-crate or via Unknown.
    console.log(`${start} performs ${eff} but its source is not a local function `
      + `(cross-crate, or via Unknown) — not statically traceable.`);
    return;
  }
  console.log(`candor path — how \`${start}\` comes to perform ${eff}:\n`);
  r.path.forEach((step, i) => {
    const indent = "  ".repeat(i + 1);
    const arrow = i === 0 ? "" : "→ ";
    const isSource = i === r.path.length - 1;
    const tag = isSource
      ? `   [${eff} source${step.loc ? ` @ ${step.loc}` : ""}]`
      : "";
    console.log(`${indent}${arrow}${step.fn}${tag}`);
  });
}

// ONE version + spec source, the SAME way scan.mjs reads them: PKG_VERSION is the bare semver from
// package.json; SPEC_VERSION is the spec contract this build speaks. Reused, never re-littered.
const QUERY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(QUERY_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.19";

// ---- the §3.3.1 canonical query grammar (⟨0.10⟩, additive over 0.9) --------------------------------
// One shape for every verb: `<verb> <verb-args…> [--report <locator>] [--policy <file>] [--json]
// [--strict] [--include-unknown]`. The report is DISCOVERED by default; --report overrides. The old
// leading-positional-report form, the trailing `0|1` JSON sentinel, and a positional policy stay
// accepted as DEPRECATED aliases (stderr-noted) so the conformance suite's old-grammar invocations
// (and every 0.9 caller) keep working — never removed before the next breaking bump.

// A one-line deprecation note to STDERR (stdout stays pure JSON — the machine consumer never sees it).
// De-duplicated so a single invocation prints each distinct note at most once.
const _deprecated = new Set();
const deprecate = (msg) => { if (!_deprecated.has(msg)) { _deprecated.add(msg); console.error(`candor-ts-query: [deprecated] ${msg}`); } };

// Resolve a --report <locator> by the ONE §3.3.1 rule: a directory → `<dir>/.candor/report`; a path
// ending `.json` → that full report path (minus the `.json`, since loadReport takes a prefix and adds
// it back); otherwise a bare prefix. Returns the PREFIX loadReport/loadCallgraph expect.
function locatorToPrefix(loc) {
  try { if (fs.statSync(loc).isDirectory()) return path.join(loc, ".candor", "report"); } catch { /* not a dir */ }
  if (loc.endsWith(".json")) return loc.slice(0, -".json".length);   // full report path → its prefix
  return loc;                                                        // bare prefix
}

// DISCOVER the report prefix when no --report: CANDOR_REPORT env wins; else walk UP from CWD for a
// `.candor/` directory and use its `report` prefix (the §3.4 discovery mechanism, the twin of scan.mjs's
// config walk-up). Returns null when NEITHER is found — the caller then fails LOUD (exit 2). It must NOT
// fall back to a bogus `.candor/report` prefix: that made the loaders read ZERO functions and every
// discovery verb emit an authoritative-empty answer at exit 0 — a false all-clear, the §4 cardinal sin
// (`where Net` in a dir with no `.candor/` up-tree). Matches the Rust engine's discover_report_prefix.
function discoverReportPrefix() {
  const env = process.env.CANDOR_REPORT;
  if (env) return locatorToPrefix(env);
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".candor"))) return path.join(d, ".candor", "report");
    if (path.dirname(d) === d) break;                                // filesystem root
  }
  return null;                                                       // no --report, no .candor/ discovered
}

// The report prefix for a discovery verb (no --report): the parsed/explicit locator, else discovery.
// A null prefix (no --report AND nothing discovered) is a LOUD exit-2 failure — never a silent empty
// answer. A resolved prefix that names NO report files is likewise loud (hasReport). One helper so every
// verb's no-report path is identical to the Rust engine's (report_or_discover + the no-files check).
function requireReport(prefix) {
  if (prefix === null) {
    console.error("candor-ts: no report found (no --report and no .candor/ discovered) — scan the crate first.");
    process.exit(2);
  }
  if (!hasReport(prefix)) {
    console.error(`candor-ts: no report files at prefix '${prefix}' — check the path, or scan the crate first.`);
    process.exit(2);
  }
  return prefix;
}

// Load a report, but FAIL LOUD (exit 2) when a file was found yet nothing parsed — the disclose-and-
// tolerate loadReport returns [] there, which every verb would read as "no effects": `tour` prints
// "nothing hidden", a policy `map`/gate PASSES — the §4 cardinal-sin false all-clear over a corrupt
// report. A legitimately effect-free crate still writes a report that LISTS its functions, so empty +
// hardFail is always the corrupt case (mirrors candor-rust load_entries_loud; java/swift already die
// loud). One corrupt file among several still merges (non-empty → returned), staying tolerant.
function loadReportOrDie(prefix) {
  const fns = loadReport(prefix);
  if (fns.length === 0 && fns.hardFail) {
    console.error(`candor-ts: every report found at prefix '${prefix}' failed to load — refusing to report an empty (all-clear) answer over a corrupt report; re-run the scan.`);
    process.exit(2);
  }
  return fns;
}

// Parse the canonical flags out of a verb's args, leaving the POSITIONAL verb-args behind. Handles the
// deprecated `0|1` trailing sentinel (→ noted, dropped; JSON is the default here anyway) so the old
// grammar stays green. `flags` names the boolean flags this verb honours (`strict`/`includeUnknown`);
// `argc` is the verb's CANONICAL positional arity (report excluded) — the sentinel/leading-report peels
// are gated on the positional count EXCEEDING it, so a canonical arg (`show 1`, `callers 0`, `path fn 0`)
// is never eaten as a sentinel (matches the Rust grammar's Shape.verb_args arity gate).
// Returns { positionals, reportPrefix, reportExplicit, policyFile, strict, includeUnknown }.
function parseCanonical(rawArgs, { policy = false, strict = false, includeUnknown = false, argc = 0 } = {}) {
  const positionals = [];
  let reportLocator = null, policyFile = null, wantStrict = false, wantIncludeUnknown = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--report") {
      // A `--report` with no following value is a LOUD usage error (exit 2), never a silent fall-back to
      // discovery and never an uncaught `locatorToPrefix(undefined)` TypeError (`where Fs --report`).
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --report requires a <locator> value (a directory, a .json report path, or a prefix)"); process.exit(2); }
      reportLocator = rawArgs[++i]; continue;
    }
    if (a === "--policy") { // consumed for EVERY verb (a valid candor flag); used only by policy verbs
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --policy requires a <file> value"); process.exit(2); }
      const v = rawArgs[++i]; if (policy) policyFile = v; continue;
    }
    if (a === "--json" || a === "--text" || a === "--human") { continue; } // output-mode flags (#8) — consumed by
                                                                            // wantJsonOut(rawArgs), never a positional
    if (a === "--strict") { if (strict) wantStrict = true; continue; }                       // vocabulary — tolerated everywhere,
    if (a === "--include-unknown") { if (includeUnknown) wantIncludeUnknown = true; continue; } // used only by the verb that reads it
    if (a === "--stats") { continue; }   // ⟨0.20⟩ tolerated everywhere; read by the `blindspots` case via args.includes
    if (a === "--class") { // ⟨0.20⟩ value flag; the value is read by the `blindspots` case
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --class requires a <class,…> value (reflect,dispatch,indirect,native,unresolved,setup; aliases: dynamic,*)"); process.exit(2); }
      i++; continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // An unrecognized flag is a TYPO, not a positional — reject it LOUD (exit 2), never silently swallow.
      // A swallowed `--polciy` runs the query with NO policy and exits green: a CI author who typos --policy
      // ships a gate that never fires (corpus re-audit cardinal sin — a loud error, never a silent guess).
      console.error(`candor-ts-query: unknown flag '${a}'${didYouMeanFlag(a)}\n  known flags: --report, --policy, --json, --text, --strict, --include-unknown, --stats`);
      process.exit(2);
    }
    positionals.push(a);
  }
  // Deprecated trailing `0|1` JSON sentinel (Rust/TS legacy): if the LAST positional is a bare 0 or 1,
  // strip it (candor-ts emits JSON regardless) and note the deprecation. ARITY-GATED: only when the
  // positional count EXCEEDS the verb's canonical arity — otherwise `show 1` / `callers 0` / `where 1` /
  // `path fn 0` would have their genuine query token eaten and run with a missing arg (degenerate empty
  // result, exit 0). Never strip a positional the canonical form needs (matches Rust's arity gate).
  if (positionals.length > argc && /^[01]$/.test(positionals[positionals.length - 1])) {
    deprecate("the trailing `0|1` JSON sentinel is deprecated — candor-ts emits JSON; use --json to select it explicitly");
    positionals.pop();
  }
  const reportExplicit = reportLocator !== null;
  const reportPrefix = reportExplicit ? locatorToPrefix(reportLocator) : discoverReportPrefix();
  return { positionals, reportPrefix, reportExplicit, policyFile, strict: wantStrict, includeUnknown: wantIncludeUnknown };
}

// A verb that takes ONE report + `argc` verb-positionals (where <Effect>: 1; show/callers/impact <fn>:
// 1; path <fn> <Effect>: 2; map/reachable/blindspots: 0). Applies discovery + --report, then peels the
// DEPRECATED leading-positional report: if --report wasn't given AND the first positional resolves to a
// report AND there's one positional MORE than the verb needs, treat that first token as the report.
// Returns { prefix, args } — `args` is exactly the verb's own positionals.
function resolveReportVerb(rawArgs, argc, opts = {}) {
  const p = parseCanonical(rawArgs, { ...opts, argc });
  let { positionals, reportPrefix } = p;
  if (!p.reportExplicit && positionals.length === argc + 1 && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>` (a dir, a .json path, or a prefix); the report is discovered from `.candor/` by default");
    reportPrefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  return { ...p, prefix: requireReport(reportPrefix), args: positionals };
}

// whatif/fix share a shape: one report + `<fn> <Effect>` + a policy. Canonical §3.3.1: `<fn> <Effect>
// [--policy <file>]`, report discovered/--report. DEPRECATED aliases (kept green for the old grammar):
// a leading-positional report AND a trailing positional policy — `<prefix> <fn> <Effect> [policy]`.
// Peels both (stderr-noted), then resolves the policy through resolvePolicy (flag > positional >
// CANDOR_POLICY > .candor/config). Returns { prefix, target, eff, policyFile }.
function resolveWhatifFix(rawArgs) {
  const p = parseCanonical(rawArgs, { policy: true, argc: 2 });
  let positionals = p.positionals, prefix = p.reportPrefix, positionalPolicy = null;
  // A leading-positional report fires only when --report is absent, there are MORE than the 2 verb args,
  // and the first token resolves to a report (else the extra positional is the deprecated policy).
  if (!p.reportExplicit && positionals.length > 2 && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the report is discovered from `.candor/` by default");
    prefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  const [target, eff, posPolicy] = positionals;               // a 3rd positional is the deprecated policy
  if (posPolicy) positionalPolicy = posPolicy;
  const { policyFile } = resolvePolicy(p.policyFile, positionalPolicy);
  return { prefix: requireReport(prefix), target, eff, policyFile };
}

// fix-gate/unverified share a shape: one report + a policy + no verb-positionals (unverified also takes
// --strict). Canonical §3.3.1: `[--policy <file>] [--strict]`, report discovered/--report. DEPRECATED
// alias: a leading report + a positional policy — `<prefix> <policy-file> [--strict]`. Peels both
// (stderr-noted), then resolves the policy through resolvePolicy. Returns { prefix, policyFile, strict }.
function resolveGateVerb(rawArgs, { strict = false } = {}) {
  const p = parseCanonical(rawArgs, { policy: true, strict, argc: 0 });
  let positionals = p.positionals, prefix = p.reportPrefix, positionalPolicy = null;
  if (!p.reportExplicit && positionals.length && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the report is discovered from `.candor/` by default");
    prefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  if (positionals[0]) positionalPolicy = positionals[0];       // the remaining positional is the deprecated policy
  const { policyFile } = resolvePolicy(p.policyFile, positionalPolicy);
  return { prefix: requireReport(prefix), policyFile, strict: p.strict };
}

// Resolve the policy for the gate verbs (whatif/fix/fix-gate/unverified): the --policy flag, else the
// deprecated positional policy, else CANDOR_POLICY, else the `.candor/config` `policy` key (§3.3/§3.4,
// the same precedence scan.mjs uses). Returns { policyFile, fromPositional } — policyFile null if none.
function resolvePolicy(policyFlag, positionalPolicy) {
  if (policyFlag) return { policyFile: policyFlag, fromPositional: false };
  if (positionalPolicy) {
    deprecate("a positional policy file is deprecated — pass it as `--policy <file>` (or set CANDOR_POLICY / a .candor/config `policy` key)");
    return { policyFile: positionalPolicy, fromPositional: true };
  }
  if (process.env.CANDOR_POLICY) return { policyFile: process.env.CANDOR_POLICY, fromPositional: false };
  const disc = discoverConfigPolicy(process.cwd());
  if (disc?.policyPath) return { policyFile: disc.policyPath, fromPositional: false };
  return { policyFile: null, fromPositional: false };
}

// The full subcommand catalogue — name + one-line description (derived from the per-subcommand
// comments + the module-doc header). The single source for the --help list AND the no-arg/unknown
// usage, so the two can never drift back to a stale hand-list again.
// Grammar per candor-spec §3.3.1 ⟨0.10⟩: the report is a FLAG (--report), discovered from `.candor/`
// by default; verb args are positional; --json selects JSON; --policy supplies a policy. The old
// leading-positional/`0|1`/positional-policy forms stay accepted as deprecated aliases (see the parser).
const REPORT_TAIL = "[--report <locator>] [--json]";
const SUBCOMMANDS = [
  ["parsepolicy", "<file>", "parse a policy file (candor-spec §6.2) and print it as JSON"],
  ["show", `<query> ${REPORT_TAIL}`, "the effect record(s) for a function — direct, inferred, surfaces"],
  ["where", `<Effect> ${REPORT_TAIL}`, "functions with an effect, split into directly / inherited"],
  ["callers", `<query> [--include-unknown] ${REPORT_TAIL}`, "who reaches a function: {of, direct, transitive}"],
  ["map", REPORT_TAIL, "per-module effect rollup: {effects, functions} by module"],
  ["containment", `[<baseline>] ${REPORT_TAIL}`, "§6.1 boundary-effect dispersion; with a baseline, the leak ratchet (exit 1)"],
  ["diff", "<current> <baseline> [--json]", "per-function effect delta vs a baseline: {changes:[{fn,gained,lost}]} (exit 1 on a gain)"],
  ["reachable", REPORT_TAIL, "effects unioned over the entry points: what the app DOES at runtime"],
  ["impact", `<query> ${REPORT_TAIL}`, "blast radius of a function (backward dual of reachable)"],
  ["blindspots", `${REPORT_TAIL} [--stats] [--class <c,…>]`, "the Unknown sources ranked by blast radius; --stats: reason-class distribution; --class: drill down"],
  ["tour", `[<N>] ${REPORT_TAIL}`, "the N most surprising transitive reaches — the guided cold-repo poke (no re-scan)"],
  ["gains", "<current> <baseline> [--json] [--strict]", "the supply-chain alarm: what the surface gained between two reports (--strict: exit 1 on ANY gain)"],
  ["path", `<fn> <Effect> ${REPORT_TAIL}`, "a call path from a function to where an effect enters"],
  ["whatif", `<fn> <Effect> [--policy <file>] ${REPORT_TAIL}`, "the impact of giving a function an effect, vs a policy (exit 1 on a violation)"],
  ["fix", `<fn> <Effect> [--policy <file>] ${REPORT_TAIL}`, "the boundary fix: where the effect belongs + the hoist refactor"],
  ["fix-gate", `[--policy <file>] [--strict] ${REPORT_TAIL}`, "a fix for EVERY boundary crossing — advisory (--strict: exit 1 while any remains)"],
  ["unverified", `[--policy <file>] [--strict] ${REPORT_TAIL}`, "pure/deny layers that PASS but are Unknown (not PROVABLY clean)"],
  ["agents", "", "print the agent contract for this build (AGENTS.md)"],
];

// The full usage block — every real subcommand, replacing the stale hand-list. Printed to stderr on
// the no-arg / unknown-command path (exit 2) and reused in --help (stdout, exit 0).
const usage = () => {
  const w = Math.max(...SUBCOMMANDS.map(([n, a]) => `${n} ${a}`.trimEnd().length));
  const lines = SUBCOMMANDS.map(([n, a, d]) => `  ${`${n} ${a}`.trimEnd().padEnd(w)}  ${d}`);
  lines.push(`  ${"-V, --version".padEnd(w)}  print the installed version + upgrade line (offline)`);
  lines.push(`  ${"-h, --help".padEnd(w)}  show this help`);
  return `USAGE: candor-ts-query <command> [args]\n\n${lines.join("\n")}`;
};

// --version / -V: a print-and-exit MODE, handled before the switch so it never depends on a command.
// Fully OFFLINE — candor never phones home. Staying current is the AGENT's job.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`candor-ts-query ${PKG_VERSION} (spec ${SPEC_VERSION})`);
  console.log("upgrade: npm install -g candor-ts@latest");
  process.exit(0);
}

// -h / --help: a print-and-exit MODE, handled before the switch (so `-h`'s single dash is never
// mistaken for a command). House-style page: identity + model paragraph + COMMON/ALL ACTIONS
// (the action names derived from SUBCOMMANDS, so the list can never go stale) + OPTIONS + footer.
// The exit-2 error path keeps the denser fully-described usage() above.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  const names = SUBCOMMANDS.map(([n]) => n);
  const allActions = [names.slice(0, 9), names.slice(9)].map((row) => `  ${row.join("  ")}`).join("\n");
  console.log(`candor-ts-query — read-only queries over a candor report.

Answers come from the report candor-ts wrote — discovered by walking up from the
cwd to a .candor/ dir (CANDOR_REPORT overrides; --report pins a locator). No
re-scan, no network. Every engine speaks the same grammar, so these actions and
flags match the rest of the family.

USAGE
  candor-ts-query <action> [args] [options]

COMMON ACTIONS
  where <Effect>            the functions that perform an effect
  path <fn> <Effect>        the call path by which a function reaches an effect
  callers <fn>              who calls a function, direct and transitive
  tour [N]                  the N most surprising transitive reaches (default 10)
  blindspots                the Unknown sources worth resolving, ranked by reach
  gains <current> <base>    what a new version newly reaches (the supply-chain diff)
  fix <fn> <Effect>         the boundary hoist that would clear a violation

ALL ACTIONS
${allActions}

OPTIONS  (uniform across every engine)
  --report <locator>        use this report instead of discovering .candor/
  --policy <file>           evaluate a policy — exit 1 on a violation (whatif, fix, fix-gate,
                            unverified; CANDOR_POLICY / a .candor/config \`policy\` key when absent)
  --json                    machine-readable JSON (the default when output is piped/redirected)
  --text, --human           human-readable prose (the default at a terminal)
  --include-unknown         callers: also list the unresolved-dispatch frontier
  --strict                  make an advisory verb a CI gate — exit 1 while a finding remains:
                            unverified (an unverified-purity hole), fix-gate (a boundary
                            crossing), gains (ANY gained effect). Advisory (exit 0) otherwise.
  -V, --version             print the installed version + upgrade line (offline)
  -h, --help                show this help

  diff and gains take two positional report locators: <current> <baseline>. Run
  candor-ts-query with no action for the full per-action argument list.

EXAMPLES
  candor-ts-query where Db
  candor-ts-query path app.orders.render Net
  candor-ts-query gains new/.candor/report.json old/.candor/report.json
  candor-ts-query fix-gate --policy candor.policy

Docs: candor.poly.io   ·   Verify an install: candor doctor
See https://github.com/tombaldwin/candor`);
  process.exit(0);
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case "--agents":
  case "agents":
    printAgents(); // shared with scan.mjs — one implementation, can't diverge within an install
    break;
  case "parsepolicy": {
    // An unreadable/missing file is a clean exit-2 error, not an uncaught readFileSync stack trace.
    let text;
    try {
      text = fs.readFileSync(args[0], "utf8");
    } catch {
      console.error(`candor: policy ${args[0] ?? "(no file given)"} could not be read`);
      process.exit(2);
    }
    // ⟨0.19⟩ config-aware: resolve `Unknown[<alias>]` via a checked-in `unknown-alias`, anchored to the
    // policy file (or CANDOR_CONFIG) — the dump reflects real gate resolution + pins the four-way expansion.
    const aliases = parseUnknownAliases(discoverConfigText(path.dirname(path.resolve(args[0]))));
    emit(parsePolicy(text, aliases));
    break;
  }
  case "show": {
    // Was a hand-copy of query-core's show that had DRIFTED — it read the wrong Fs key (`e.fs`, never
    // written; the paths silently vanished) and dropped Exec `cmds` entirely. Call the shared show so
    // the CLI and the MCP `candor_show` are one implementation that cannot diverge again.
    const { prefix, args: [q] } = resolveReportVerb(args, 1);
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never a silently-empty
    // `[]` at exit 0, which reads as an authoritative "no such function" over a question never asked.
    if (!q) { console.error("usage: candor-ts-query show <query> [--report <locator>] [--json]"); process.exit(2); }
    put(args, coreShow(loadReportOrDie(prefix), q), P.show);
    break;
  }
  case "where": {
    // Shared query-core (like show/callers) — the CLI and MCP `candor_where` are ONE implementation.
    // Hand-copies of core functions in this file have drifted three times (show, callers, diff); the
    // fix each time was the same: delegate, keep query.mjs as arg-parsing + emit + exit codes only.
    const { prefix, args: [eff] } = resolveReportVerb(args, 1);
    // A missing/empty <Effect> is a LOUD usage error (exit 2, like candor-java's missing-arg path) —
    // never an authoritative-empty {directly:[],inherited:[]} at exit 0 (a false all-clear shape).
    if (!eff) { console.error("usage: candor-ts-query where <Effect> [--report <locator>] [--json]"); process.exit(2); }
    // A typo'd / unknown effect NAME is a LOUD error (exit 2) — never a false-empty {directly:[],inherited:[]}
    // at exit 0, which reads as an authoritative "nothing performs Net" when the user actually typed "Network"
    // (corpus-audit #3). A KNOWN effect that is simply absent stays a valid 0-result; an unknown name that is
    // PRESENT in the report (a spec extension effect) is allowed — so error only when the name is NEITHER.
    const fnsW = loadReportOrDie(prefix);
    if (!KNOWN_EFFECTS.includes(eff) && !new Set(fnsW.flatMap((e) => e.inferred || [])).has(eff)) {
      console.error(`candor-ts-query where: unknown effect '${eff}' (known: ${KNOWN_EFFECTS.join(", ")})`); process.exit(2);
    }
    put(args, coreWhere(fnsW, eff), P.where);
    break;
  }
  case "callers": {
    // --include-unknown ⟨0.7⟩ adds the unresolved-dispatch frontier (possibleViaUnknownDispatch); without
    // it, the byte-for-byte {of,direct,transitive} shape is unchanged (cross-engine parity). Call the
    // shared query-core so the CLI and MCP compute one truth (the prior inline copy had drifted before).
    const { prefix, args: [q], includeUnknown } = resolveReportVerb(args, 1, { includeUnknown: true });
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never an empty
    // {of:[],direct:[],transitive:[]} at exit 0 (reads as "nothing reaches it" for a fn never named).
    if (!q) { console.error("usage: candor-ts-query callers <query> [--include-unknown] [--report <locator>] [--json]"); process.exit(2); }
    const cg = loadCallgraph(prefix);
    const cres = includeUnknown ? callersFrontier(cg, loadReportOrDie(prefix), loadHierarchy(prefix), q) : coreCallers(cg, q);
    // A nonexistent function is a LOUD error (exit 2), like path/impact — never an empty {of:[],direct:[],
    // transitive:[]} at exit 0, which reads as an authoritative "nothing calls it" for a fn that doesn't exist
    // (corpus-audit #3). Gated on a NON-empty callgraph so a missing sidecar isn't misreported as "no such fn".
    if (Object.keys(cg).length > 0 && cres.of.length === 0) {
      console.error(`candor-ts-query callers: no function matching '${q}' in the call graph`); process.exit(2);
    }
    put(args, cres, P.callers);
    break;
  }
  case "map": {
    // Shared query-core — the CLI and MCP `candor_map` are one implementation (see `where` above).
    const { prefix } = resolveReportVerb(args, 0);
    put(args, coreMap(loadReportOrDie(prefix)), P.map);
    break;
  }
  case "containment": {
    // SPEC §6.1 boundary-effect dispersion; with a baseline it's the AS-EFF-010 ratchet (exit 1 on a new
    // leak), matching candor-java / candor-query. JSON-only, like every other candor-ts query command.
    // Canonical §3.3.1: `containment [<baseline>]` — the main report discovered / --report, the SINGLE
    // canonical positional is the OPTIONAL baseline (verb_args: 1). A lone bare positional is therefore
    // the BASELINE (the gating ratchet), NEVER re-read as the deprecated leading report — which silently
    // dropped to non-gating report-mode (exit 0), the §4 cardinal-sin gate-off this fixes. The deprecated
    // old form (`containment <report> <baseline>`) is ARITY-GATED: the leading-report peel fires only when
    // the positionals EXCEED 1, so `containment P` stays the ratchet and `containment leaky P` still peels
    // `leaky` as the report and leaves `P` the baseline (both old-grammar tests stay green). Matches Rust.
    const p = parseCanonical(args, { argc: 1 });
    let prefix = p.reportPrefix, basePrefix;
    if (!p.reportExplicit && p.positionals.length > 1 && hasReport(locatorToPrefix(p.positionals[0]))) {
      deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the baseline stays positional (`containment [<baseline>]`)");
      prefix = locatorToPrefix(p.positionals[0]);
      basePrefix = p.positionals[1] ? locatorToPrefix(p.positionals[1]) : undefined;
    } else {
      basePrefix = p.positionals[0] ? locatorToPrefix(p.positionals[0]) : undefined;
    }
    prefix = requireReport(prefix);
    if (basePrefix) {
      const baseFns = loadReportOrDie(basePrefix);
      if (baseFns.length === 0) {   // fail CLOSED (exit 2), not a wall of bogus "everything leaked" (exit 1)
        console.error(`candor-ts: no report at baseline prefix '${basePrefix}' — check the path`);
        process.exit(2);
      }
      const r = coreContainment(loadReportOrDie(prefix), baseFns);
      put(args, r, P.containment);
      process.exit(r.leaks.length ? 1 : 0);
    }
    put(args, coreContainment(loadReportOrDie(prefix)), P.containment);
    break;
  }
  case "diff": {
    // per-function effect delta vs a baseline: {changes: [{fn, gained, lost}]} — the envelope shape
    // the conformance suite pins (diff-vs-self must be {changes: []}). Shared query-core: the CLI's
    // former inline copy built `new Map(fns.map((e) => [e.fn, …]))` — the exact last-wins collapse
    // core's effectsByFn was rewritten to avoid (merged multi-report siblings sharing a short fn name
    // dropped one member's effects, so a gained Net could VANISH from diff and its exit-1 contract —
    // a supply-chain miss, and the CLI disagreeing with MCP `candor_diff` on the same reports).
    // §3.3.1: diff/gains are the exception to discovery — two positional locators <current> <baseline>,
    // each resolved by the shared locator rule (dir / .json path / prefix). --json is accepted (JSON is
    // the only output). No leading-positional-report alias here: both positionals ARE the reports.
    const { positionals } = parseCanonical(args, {});
    if (positionals.length < 2) { console.error("usage: candor-ts-query diff <current> <baseline> [--json]"); process.exit(2); }
    const [curPrefix, basePrefix] = positionals.map(locatorToPrefix);
    // BOTH locators must name real report files (the Rust engine's no-files check, named per side so
    // the user knows which path to fix): a typo'd prefix loaded [] with hardFail=false and emitted an
    // authoritative EMPTY {changes:[]} at exit 0 — the §4 false all-clear on the ratchet verb.
    if (!hasReport(curPrefix)) { console.error(`candor-ts: no report files at current prefix '${curPrefix}' — check the path.`); process.exit(2); }
    if (!hasReport(basePrefix)) { console.error(`candor-ts: no report files at baseline prefix '${basePrefix}' — check the path.`); process.exit(2); }
    const { changes } = coreDiff(loadReportOrDie(curPrefix), loadReportOrDie(basePrefix));
    // §2.1: a baseline is comparable only to its own producing build — disclose a mismatch (the gains
    // may be the engine reclassifying after a coverage batch, not the code changing). Same note + JSON
    // provenance fields as the Rust candor-query (cross-engine parity, item 10).
    const engineV = reportVersion(curPrefix), baseV = reportVersion(basePrefix);
    const versionMismatch = engineV && baseV && engineV !== baseV;
    if (versionMismatch)
      console.error(`candor-ts: ⚠ baseline @${baseV} ≠ engine @${engineV} — some changes may be the engine reclassifying, not your code. Treat an engine swap as baseline-invalidating: review, then regenerate the baseline.`);
    put(args, { baseline_version: baseV ?? "", engine_version: engineV ?? "", changes }, P.diff);
    // diff DISCLOSES (the posture) — it is not a gate. Its gained-effect exit 1 is a convenience for
    // same-build ratchet use; under a version mismatch that signal is BOGUS (unmasking, not regression),
    // so exit 0 and let the ⚠ inform — never deliver the wave as a CI failure (review §2.1: guards fail
    // closed, queries disclose).
    process.exit(!versionMismatch && changes.some((c) => c.gained.length) ? 1 : 0);
    break; // unreachable (process.exit), but eslint can't prove it — defends against fallthrough
  }
  case "reachable": {
    // what the app DOES at runtime: effects unioned over the entry points (SPEC §3.1; same JSON
    // shape as the Rust engine: {entryPoints, effects: {Eff: {count, via}}}).
    const { prefix } = resolveReportVerb(args, 0);
    const fns = loadReportOrDie(prefix);
    const roots = fns.filter((e) => e.entryPoint);
    const byEff = {};
    for (const e of roots) for (const x of e.inferred) (byEff[x] ??= []).push(e.fn);
    put(args, { entryPoints: roots.length,
           effects: Object.fromEntries(Object.entries(byEff).sort()
             .map(([k, v]) => [k, { count: v.length, via: v.sort() }])) }, P.reachable);
    break;
  }
  case "impact": {
    // blast radius (backward dual of reachable) — reuses the shared query-core, the same logic the
    // MCP server serves. SPEC §3.1: {fn, affectedCount, affected, entryPoints:[{fn,inferred}]}.
    const { prefix, args: [q] } = resolveReportVerb(args, 1);
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never an
    // affectedCount:0 blast radius at exit 0 for a function that was never named.
    if (!q) { console.error("usage: candor-ts-query impact <query> [--report <locator>] [--json]"); process.exit(2); }
    put(args, coreImpact(loadReportOrDie(prefix), loadCallgraph(prefix), q), P.impact);
    break;
  }
  case "blindspots": {
    // the Unknown SOURCES, ranked by blast radius — the actionable inverse of a widely-propagated
    // Unknown (SPEC §3.1 ⟨0.6⟩): { sources:[{fn,why,reaches,affected}], totalUnknown }.
    const { prefix } = resolveReportVerb(args, 0);
    const ci = args.indexOf("--class");
    const classFilter = ci >= 0 ? args[ci + 1] : null;   // ⟨0.20⟩ drill-down by reason class
    if (args.includes("--stats")) {   // ⟨0.20⟩ the reason-class distribution, not the source list
      put(args, coreBlindspotsStats(loadReportOrDie(prefix), classFilter), P.blindspotsStats);
    } else {
      put(args, coreBlindspots(loadReportOrDie(prefix), loadCallgraph(prefix), classFilter), P.blindspots);
    }
    break;
  }
  case "tour": {
    // The ON-DEMAND, top-N cold-repo opener (SURFACE-BEST-FIND-DESIGN.md, P2): the N most SURPRISING
    // transitive reaches in an existing report — NO re-scan. Delegates to the SHARED surface.mjs
    // bestFinds (the same heuristic the scan-time note uses, so the ranking can't drift), reading the
    // report + callgraph sidecar the scan already wrote. Port of candor-rust's candor-query tour verb —
    // human + --json output byte-identical (a conformance PART pins it four-way).
    // §3.3.1: `tour [<N>]`, report discovered / --report; the lone OPTIONAL positional is N (default 10).
    // Unlike the JSON-only verbs, tour has BOTH a human default AND a --json form (like the Rust engine),
    // so detect --json explicitly (parseCanonical otherwise silently swallows it).
    const wantJson = args.includes("--json");
    const { prefix, args: tourArgs } = resolveReportVerb(args, 1);
    let n = 10;
    if (tourArgs.length) {
      // N MUST be a positive integer ≥ 1 that fits a safe integer — like the Rust engine, which rejects
      // `tour 0` and a non-usize. `tour 0` printing "nothing hidden" over an effectful crate would be a
      // false all-clear (the §4 cardinal sin), so a non-integer, zero, or out-of-range value → exit 2.
      const parsed = /^\d+$/.test(tourArgs[0]) ? Number(tourArgs[0]) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        console.error("usage: candor-ts-query tour [<N>] [--report <locator>] [--json]   (N is a positive integer ≥ 1)");
        process.exit(2);
      }
      n = parsed;
    }
    const fns = loadReportOrDie(prefix);
    const cg = loadCallgraph(prefix);
    // Build the maps the heuristic wants from the report entries + the callgraph sidecar. `inferred`/
    // `direct` come from the report; `loc` maps a function to its "file:line" for the source callout.
    const inferred = new Map(), direct = new Map(), loc = new Map(), calls = new Map();
    for (const e of fns) {
      inferred.set(e.fn, new Set(e.inferred));
      if (e.direct.length) direct.set(e.fn, new Set(e.direct));
      if (e.loc) loc.set(e.fn, e.loc);
    }
    // `calls` prefers the FULL callgraph sidecar (every edge — the graph the scan held in memory). When
    // the sidecar is absent/empty, FALL BACK to each entry's inline `.calls` (mirrors tour.rs:66-77:
    // `if cg.is_empty() { use entry.calls } else { use cg }`). Without this fallback a report whose
    // sidecar was deleted/never-written yields an empty graph, nearestSource finds nothing, and tour
    // prints a FALSE "nothing hidden" at exit 0 — a silent under-report (the §4 cardinal sin). A corrupt
    // sidecar is already disclosed on stderr by loadCallgraph, which then returns {} → we fall back here.
    if (Object.keys(cg).length === 0) {
      for (const e of fns) if (e.calls.length) calls.set(e.fn, e.calls);
    } else {
      for (const [k, v] of Object.entries(cg)) calls.set(k, v);
    }
    // Exclude test scaffolding — a qual is test code iff its recorded loc lies on a test path, the SAME
    // isTestPath predicate the scan-note passes (scan.mjs's isTestQual). Without it `tour` surfaces test
    // functions the scan-note (and every other engine) hides — an inconsistent, noisier reach list.
    const isTestQual = (q) => { const l = loc.get(q); return l ? isTestPath(l) : false; };
    const finds = bestFinds(inferred, direct, calls, loc, n, isTestQual);
    // The header names the report's §2 envelope `package` — meaningful and locator-independent, so every
    // engine and every --report form print the SAME crate. Falls back to the prefix basename.
    const crateName = reportPackage(prefix) ?? path.basename(prefix);
    if (wantJson) {
      // Pure JSON to STDOUT: {"reaches":[{effect,fn,hops,loc,score,source}, …]} — ALPHABETICAL keys, the
      // same order Rust+Swift emit (loc is the SOURCE's file:line, "" when absent).
      const out = { reaches: finds.map((f) => ({
        effect: f.effect, fn: f.func, hops: f.hops, loc: f.sourceLoc, score: f.score, source: f.source,
      })) };
      // The MACHINE half of the mostly-Unknown disclosure (Fable-review finding E): a JSON consumer (the
      // agent loop) got a bare `{"reaches":[]}` and read it as clean — the same false all-clear the text
      // branch qualifies. ADDITIVE + present only when the ≥⅓-Unknown threshold trips (byte-identical
      // otherwise). Keys sorted after `reaches` (reaches < unknown) to match Rust's serde output.
      const teff = fns.filter((e) => (e.inferred ?? []).length > 0).length;
      const tunk = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
      if (teff > 0 && tunk * 3 >= teff) out.unknown = { count: tunk, total: teff };
      console.log(JSON.stringify(out));
      break;
    }
    if (finds.length === 0) {
      // Effectful-but-nothing-surprising vs genuinely-pure both land here; the honest line is the useful
      // answer (never a manufactured surprise) — mirrors the scan-note fallback + the Rust engine. BUT never
      // reassure "nothing hidden" over a meaningfully-Unknown graph (unresolved calls — missing tsconfig /
      // imports): those Unknowns ARE the hidden part, their transitive effects unanalyzed (re-audit cardinal
      // sin). Same ≥⅓-effectful-Unknown gate as the scan opener (surface.mjs emitSurface).
      const teff = fns.filter((e) => (e.inferred ?? []).length > 0).length;
      const tunk = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
      if (teff > 0 && tunk * 3 >= teff) {
        console.log(
          `candor: no surprising reaches — but ${tunk} of ${teff} function(s) are Unknown `
          + `(unresolved calls; their transitive effects are NOT analyzed). Run \`candor blindspots\`; `
          + `a missing tsconfig.json or unresolvable imports are the usual cause.`,
        );
      } else {
        console.log("candor: nothing hidden — every effect sits where its name says it should.");
      }
      break;
    }
    console.log(`candor tour — the ${finds.length} most surprising reach${finds.length === 1 ? "" : "es"} in ${crateName}:`);
    finds.forEach((f, i) => {
      const hopWord = f.hops === 1 ? "hop" : "hops";
      const whereS = f.sourceLoc ? ` (${f.sourceLoc})` : "";
      console.log(`  ${i + 1}. \`${f.func}\` performs ${f.effect}, ${f.hops} ${hopWord} away via \`${f.source}\`${whereS}`);
      console.log(`     →  candor path ${f.func} ${f.effect}`);
    });
    break;
  }
  case "gains": {
    // the supply-chain alarm (SPEC §5.1): {gained:[Effect], byFunction:[{fn,effect}]} — what the
    // surface gained between two reports (base → cur), the cross-engine machine-readable form.
    // §3.3.1: like diff, two positional locators <current> <baseline> (no discovery), each resolved by
    // the shared locator rule; --json accepted.
    // gains has no `--policy` of its own: parseCanonical consumes `--policy` for every verb (a valid flag),
    // which for gains would SILENTLY drop it and exit 0 — a CI author who reaches for `--policy` to gate a
    // supply-chain diff ships a gate that never fires. Reject it loud and point at the real gate. `--strict`
    // (below) fails on ANY gained effect; the effect-SPECIFIC gate is a `deny <E> gained` scan policy.
    if (args.includes("--policy")) { console.error("candor-ts-query gains: unknown flag '--policy' — gains is a diff view; to FAIL CI on a newly-gained effect gate at scan time with a `deny <E> gained` policy (AS-EFF-005), or use `--strict` to fail on ANY gain\n  known flags: --json, --strict"); process.exit(2); }
    const { positionals, strict } = parseCanonical(args, { strict: true });
    if (positionals.length < 2) { console.error("usage: candor-ts-query gains <current> <baseline> [--json] [--strict]"); process.exit(2); }
    const [curPrefix, basePrefix] = positionals.map(locatorToPrefix);
    // BOTH locators must name real report files (the Rust engine's no-files check, named per side):
    // a typo'd prefix loaded [] with hardFail=false and emitted an authoritative EMPTY
    // {gained:[],byFunction:[]} at exit 0 — a silent all-clear on the supply-chain ALARM verb.
    if (!hasReport(curPrefix)) { console.error(`candor-ts: no report files at current prefix '${curPrefix}' — check the path.`); process.exit(2); }
    if (!hasReport(basePrefix)) { console.error(`candor-ts: no report files at baseline prefix '${basePrefix}' — check the path.`); process.exit(2); }
    const gv = reportVersion(curPrefix), gbv = reportVersion(basePrefix);
    if (gv && gbv && gv !== gbv)
      console.error(`candor-ts: ⚠ baseline @${gbv} ≠ engine @${gv} — a "gained capability" may be the engine reclassifying, not the dependency changing. Regenerate both reports with one build to compare releases.`);
    // ⟨spec 0.12 staged⟩ the BASELINE callgraph feeds byFunction[].origin (existing/new/unknown) —
    // a MISSING sidecar loads {} and a corrupt (matched-but-unparseable) one is tagged `partial`
    // with its edges dropped-and-disclosed: either way "new" is unavailable and origin falls back
    // to "unknown" — the JSON itself discloses, never guessing "new" over a truncated graph.
    // ⟨0.15 staged⟩ coverage disclosure (COVERAGE-DESIGN.md §3): the CURRENT report's `coverage`
    // envelope rides along (a gained effect in an uncovered dep is invisible — "no gains" must not
    // read as total), plus `coverageDelta` when the baseline names different blind packages. Both
    // OMITTED when nothing applies, so a coverage-free comparison is byte-identical to ⟨0.14⟩.
    // Shared with the MCP `candor_gains` tool (gainsCoverage — the parity rule).
    const gainsResult = coreGains(loadReportOrDie(curPrefix), loadReportOrDie(basePrefix), loadCallgraph(basePrefix));
    put(args, { baseline_version: gbv ?? "", engine_version: gv ?? "",
           ...gainsResult, ...gainsCoverage(curPrefix, basePrefix) }, P.gains);
    // Advisory by default (exit 0 — gains is a diff view); `--strict` fails on ANY gained effect so a
    // supply-chain CI job can require a bump introduce no new capability (mirrors `unverified --strict`).
    process.exit(strict && (gainsResult.gained?.length ?? 0) > 0 ? 1 : 0);
    break; // unreachable
  }
  case "path": {
    // BOTH a human default AND a --json form (like the Rust/Java engines). The surface opener suggests
    // `candor path <fn> <effect>`, so the DEFAULT is the readable indented chain; --json selects the
    // pinned JSON shape. parseCanonical otherwise swallows --json, so detect it explicitly (as `tour` does).
    const wantJson = args.includes("--json");
    const { prefix, args: [fn, eff] } = resolveReportVerb(args, 2);
    // BOTH positionals are required (`path <fn> <Effect>`) — a missing/empty one is a LOUD usage error
    // (exit 2, like candor-java). Before this gate, one arg slid through as `<fn> undefined` and printed
    // "does not perform undefined" at exit 0 — a false all-clear over a question that was never posed.
    if (!fn || !eff) { console.error("usage: candor-ts-query path <fn> <Effect> [--report <locator>] [--json]"); process.exit(2); }
    const fns = loadReportOrDie(prefix);
    const cg = loadCallgraph(prefix);
    if (wantJson) emit(corePath(fns, cg, fn, eff));           // conformance PART 5 shape — UNCHANGED
    else {
      // The accepted 0.11 default change (the human chain replaced JSON as the no-flag output) gets a
      // ONE-line stderr breadcrumb, so a pre-0.11 pipeline that broke on the new default is pointed at
      // --json rather than left guessing. stderr only — stdout stays the human chain; --json untouched.
      console.error("candor-ts-query: tip — `--json` selects the machine-readable path shape (the default before 0.11)");
      renderPathHuman(fns, cg, fn, eff);
    }
    break;
  }
  case "whatif": {
    // §3.3.1: `whatif <fn> <Effect> [--policy <file>]`, report discovered / --report. DEPRECATED aliases:
    // a leading-positional report and a trailing positional policy (`whatif <prefix> <fn> <Effect>
    // [policy]`). resolveWhatifFix peels both (stderr-noted) so the old grammar stays green.
    const { prefix, target, eff, policyFile } = resolveWhatifFix(args);
    // A present policy MUST exist and be readable — a typo'd path must be LOUD, not silently "no policy →
    // ok:true, exit 0" (mirrors scan's --policy, which exits 2 on an unreadable file: a gate that can't
    // read its policy can't certify anything). Flag, positional, CANDOR_POLICY and .candor/config all land here.
    let pol = null;
    if (policyFile) {
      let text;
      try {
        text = fs.readFileSync(policyFile, "utf8");
      } catch {
        console.error(`candor: policy ${policyFile} could not be read; whatif NOT evaluated against it`);
        process.exit(2);
      }
      pol = parsePolicy(text);
    }
    // Shared query-core — the CLI and MCP `candor_whatif` are one blast-radius + deny evaluation
    // (the CLI keeps the I/O + exit codes; the core is pure — see `where` above for the drift class).
    const r = coreWhatif(loadCallgraph(prefix), target, eff, pol, scopeMatches);
    if (r === null) {
      console.error(`candor: no function matching \`${target}\` in the call graph`);
      process.exit(2);
    }
    emit(r);
    process.exit(r.violations.length ? 1 : 0);
    break; // unreachable (process.exit), but eslint can't prove it — defends against fallthrough
  }
  case "fix": {
    // THE BOUNDARY FIX (integrations/FIX-SPEC.md): where a forbidden effect belongs + the hoist refactor.
    // The remedial inverse of whatif. A policy is REQUIRED and must be readable (the fix is defined relative
    // to the boundary the edit crossed) — a typo'd path fails LOUD, never a silently-empty "no crossing".
    // §3.3.1: `fix <fn> <Effect> [--policy <file>]`, report discovered / --report; the old
    // `fix <prefix> <fn> <Effect> <policy-file>` form (leading report + positional policy) stays accepted.
    const { prefix, target, eff, policyFile } = resolveWhatifFix(args);
    if (!target || !eff) { console.error("usage: candor-ts-query fix <fn> <Effect> [--policy <file>] [--report <locator>]"); process.exit(2); }
    if (!policyFile) { console.error("candor: fix requires a policy file — the fix is the refactor that restores the boundary the edit crossed (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    // The sidecar is the ONLY graph a candor-ts report carries (it embeds no inline `calls`). Fail LOUD when
    // it's absent — never compute a degenerate empty-graph remedy that reads as a false "no clean hoist".
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    const r = coreFix(cg, loadReportOrDie(prefix), target, eff, parsePolicy(ptext), scopeMatches);
    if (r === null) { console.error(`candor: no function matching \`${target}\` in the call graph`); process.exit(2); }
    emit(r);
    break;
  }
  case "fix-gate": {
    // A remedy for EVERY deny/pure crossing — the shape the edit-time loop folds into its block message.
    // §3.3.1: `fix-gate [--policy <file>]`, report discovered / --report. DEPRECATED alias: the old
    // `fix-gate <prefix> <policy-file>` (leading report + positional policy).
    // Advisory by default (exit 0 — the agent fix-loop reads the remedy and edits); `--strict` makes the
    // exit follow `ok`, so CI can REQUIRE zero outstanding crossings (mirrors `unverified --strict`).
    const { prefix, policyFile, strict } = resolveGateVerb(args, { strict: true });
    if (!policyFile) { console.error("candor: fix-gate requires a policy file (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix-gate needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    const fgr = coreFixGate(cg, loadReportOrDie(prefix), parsePolicy(ptext), scopeMatches);
    emit(fgr);
    process.exit(strict && !fgr.ok ? 1 : 0);
    break; // unreachable
  }
  case "unverified": {
    // PROVABLE-PURITY disclosure: pure/deny layers that PASS but contain Unknown (not provably clean). A
    // policy is required; `--strict` exits 1 on a hole. Advisory (exit 0) otherwise.
    // §3.3.1: `unverified [--policy <file>] [--strict]`, report discovered / --report. DEPRECATED alias:
    // the old `unverified <prefix> <policy-file> [--strict]` (leading report + positional policy).
    const { prefix, policyFile, strict } = resolveGateVerb(args, { strict: true });
    if (!policyFile) { console.error("candor: unverified requires a policy file (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read`); process.exit(2); }
    const uci = args.indexOf("--class");   // ⟨0.20⟩ drill-down by reason class
    const r = coreUnverified(loadReportOrDie(prefix), parsePolicy(ptext), scopeMatches, uci >= 0 ? args[uci + 1] : null);
    emit(r);
    process.exit(strict && !r.ok ? 1 : 0);
    break; // unreachable
  }
  default:
    // no command (cmd === undefined) or an unknown one: the FULL usage, not the stale 6-item list.
    if (cmd !== undefined) console.error(`candor-ts-query: unknown command '${cmd}'`);
    console.error(usage());
    process.exit(2);
}
