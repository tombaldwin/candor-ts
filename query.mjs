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
 *   node query.mjs parsepolicy <file>
 *   node query.mjs show     <prefix> <query>  <0|1>
 *   node query.mjs where    <prefix> <Effect> <0|1>
 *   node query.mjs callers  <prefix> <query>  <0|1>
 *   node query.mjs map      <prefix>          <0|1>
 *   node query.mjs whatif   <prefix> <fn> <Effect> [policy-file] [0|1]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePolicy, scopeMatches } from "./policy.mjs";
import { printAgents } from "./contract.mjs";
// ONE source of truth for loading + name-matching — query.mjs kept DRIFTED local copies that didn't
// merge sibling reports, didn't tolerate a corrupt report (bare JSON.parse → uncaught crash), and used
// a `matchTier` missing `#` (so the SAME query resolved differently between `impact` and `callers` on a
// JVM `Type#method` report). Importing the shared functions removes all three divergences (review find).
import { impact as coreImpact, path as corePath, gains as coreGains,
         show as coreShow, blindspots as coreBlindspots,
         callers as coreCallers, callersFrontier, loadHierarchy,
         containment as coreContainment, diff as coreDiff,
         where as coreWhere, map as coreMap, whatif as coreWhatif,
         fix as coreFix, fixGate as coreFixGate, unverified as coreUnverified,
         loadReport, loadCallgraph, reportVersion } from "./query-core.mjs";
const emit = (v) => console.log(JSON.stringify(v, null, 1));

// ONE version + spec source, the SAME way scan.mjs reads them: PKG_VERSION is the bare semver from
// package.json; SPEC_VERSION is the spec contract this build speaks. Reused, never re-littered.
const QUERY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(QUERY_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.9";

// The full subcommand catalogue — name + one-line description (derived from the per-subcommand
// comments + the module-doc header). The single source for the --help list AND the no-arg/unknown
// usage, so the two can never drift back to a stale hand-list again.
const SUBCOMMANDS = [
  ["parsepolicy", "<file>", "parse a policy file (candor-spec §6.2) and print it as JSON"],
  ["show", "<prefix> <query> [0|1]", "the effect record(s) for a function — direct, inferred, surfaces"],
  ["where", "<prefix> <Effect> [0|1]", "functions with an effect, split into directly / inherited"],
  ["callers", "<prefix> <query> [0|1]", "who reaches a function: {of, direct, transitive} (--include-unknown)"],
  ["map", "<prefix> [0|1]", "per-module effect rollup: {effects, functions} by module"],
  ["containment", "<prefix> [baseline-prefix]", "§6.1 boundary-effect dispersion; with a baseline, the leak ratchet (exit 1)"],
  ["diff", "<cur-prefix> <base-prefix>", "per-function effect delta vs a baseline: {changes:[{fn,gained,lost}]} (exit 1 on a gain)"],
  ["reachable", "<prefix>", "effects unioned over the entry points: what the app DOES at runtime"],
  ["impact", "<prefix> <query>", "blast radius of a function (backward dual of reachable)"],
  ["blindspots", "<prefix>", "the Unknown sources, ranked by blast radius"],
  ["gains", "<cur-prefix> <base-prefix>", "the supply-chain alarm: what the surface gained between two reports"],
  ["path", "<prefix> <fn> <Effect>", "a call path from a function to where an effect enters"],
  ["whatif", "<prefix> <fn> <Effect> [policy-file] [0|1]", "the impact of giving a function an effect, vs a policy (exit 1 on a violation)"],
  ["fix", "<prefix> <fn> <Effect> <policy-file>", "the boundary fix: where the effect belongs + the hoist refactor"],
  ["fix-gate", "<prefix> <policy-file>", "a fix for EVERY boundary crossing — the loop's block-message remedy"],
  ["unverified", "<prefix> <policy-file> [--strict]", "pure/deny layers that PASS but are Unknown (not PROVABLY clean)"],
  ["agents", "", "print the agent contract for this build (AGENTS.md)"],
];

// The full usage block — every real subcommand, replacing the stale hand-list. Printed to stderr on
// the no-arg / unknown-command path (exit 2) and reused in --help (stdout, exit 0).
const usage = () => {
  const w = Math.max(...SUBCOMMANDS.map(([n, a]) => `${n} ${a}`.trimEnd().length));
  const lines = SUBCOMMANDS.map(([n, a, d]) => `  ${`${n} ${a}`.trimEnd().padEnd(w)}  ${d}`);
  lines.push(`  ${"-V, --version".padEnd(w)}  print the build and spec version (offline)`);
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
// mistaken for a command). Banner + USAGE + the full described subcommand list + the github footer.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`candor-ts-query ${PKG_VERSION} — read-only queries over a candor report (candor-spec ${SPEC_VERSION})

${usage()}

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
    emit(parsePolicy(text));
    break;
  }
  case "show": {
    // Was a hand-copy of query-core's show that had DRIFTED — it read the wrong Fs key (`e.fs`, never
    // written; the paths silently vanished) and dropped Exec `cmds` entirely. Call the shared show so
    // the CLI and the MCP `candor_show` are one implementation that cannot diverge again.
    const [prefix, q] = args;
    emit(coreShow(loadReport(prefix), q));
    break;
  }
  case "where": {
    // Shared query-core (like show/callers) — the CLI and MCP `candor_where` are ONE implementation.
    // Hand-copies of core functions in this file have drifted three times (show, callers, diff); the
    // fix each time was the same: delegate, keep query.mjs as arg-parsing + emit + exit codes only.
    const [prefix, eff] = args;
    emit(coreWhere(loadReport(prefix), eff));
    break;
  }
  case "callers": {
    // --include-unknown ⟨0.7⟩ adds the unresolved-dispatch frontier (possibleViaUnknownDispatch); without
    // it, the byte-for-byte {of,direct,transitive} shape is unchanged (cross-engine parity). Call the
    // shared query-core so the CLI and MCP compute one truth (the prior inline copy had drifted before).
    const includeUnknown = args.includes("--include-unknown");
    const [prefix, q] = args.filter((a) => a !== "--include-unknown");
    const cg = loadCallgraph(prefix);
    if (includeUnknown) emit(callersFrontier(cg, loadReport(prefix), loadHierarchy(prefix), q));
    else emit(coreCallers(cg, q));
    break;
  }
  case "map": {
    // Shared query-core — the CLI and MCP `candor_map` are one implementation (see `where` above).
    const [prefix] = args;
    emit(coreMap(loadReport(prefix)));
    break;
  }
  case "containment": {
    // SPEC §6.1 boundary-effect dispersion; with a baseline prefix it's the AS-EFF-010 ratchet (exit 1 on a
    // new leak), matching candor-java / candor-query. JSON-only, like every other candor-ts query command.
    const [prefix, basePrefix] = args;
    if (basePrefix) {
      const baseFns = loadReport(basePrefix);
      if (baseFns.length === 0) {   // fail CLOSED (exit 2), not a wall of bogus "everything leaked" (exit 1)
        console.error(`candor-ts: no report at baseline prefix '${basePrefix}' — check the path`);
        process.exit(2);
      }
      const r = coreContainment(loadReport(prefix), baseFns);
      emit(r);
      process.exit(r.leaks.length ? 1 : 0);
    }
    emit(coreContainment(loadReport(prefix)));
    break;
  }
  case "diff": {
    // per-function effect delta vs a baseline: {changes: [{fn, gained, lost}]} — the envelope shape
    // the conformance suite pins (diff-vs-self must be {changes: []}). Shared query-core: the CLI's
    // former inline copy built `new Map(fns.map((e) => [e.fn, …]))` — the exact last-wins collapse
    // core's effectsByFn was rewritten to avoid (merged multi-report siblings sharing a short fn name
    // dropped one member's effects, so a gained Net could VANISH from diff and its exit-1 contract —
    // a supply-chain miss, and the CLI disagreeing with MCP `candor_diff` on the same reports).
    const [curPrefix, basePrefix] = args;
    const { changes } = coreDiff(loadReport(curPrefix), loadReport(basePrefix));
    // §2.1: a baseline is comparable only to its own producing build — disclose a mismatch (the gains
    // may be the engine reclassifying after a coverage batch, not the code changing). Same note + JSON
    // provenance fields as the Rust candor-query (cross-engine parity, item 10).
    const engineV = reportVersion(curPrefix), baseV = reportVersion(basePrefix);
    const versionMismatch = engineV && baseV && engineV !== baseV;
    if (versionMismatch)
      console.error(`candor-ts: ⚠ baseline @${baseV} ≠ engine @${engineV} — some changes may be the engine reclassifying, not your code. Treat an engine swap as baseline-invalidating: review, then regenerate the baseline.`);
    emit({ baseline_version: baseV ?? "", engine_version: engineV ?? "", changes });
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
    const [prefix] = args;
    const fns = loadReport(prefix);
    const roots = fns.filter((e) => e.entryPoint);
    const byEff = {};
    for (const e of roots) for (const x of e.inferred) (byEff[x] ??= []).push(e.fn);
    emit({ entryPoints: roots.length,
           effects: Object.fromEntries(Object.entries(byEff).sort()
             .map(([k, v]) => [k, { count: v.length, via: v.sort() }])) });
    break;
  }
  case "impact": {
    // blast radius (backward dual of reachable) — reuses the shared query-core, the same logic the
    // MCP server serves. SPEC §3.1: {fn, affectedCount, affected, entryPoints:[{fn,inferred}]}.
    const [prefix, q] = args;
    emit(coreImpact(loadReport(prefix), loadCallgraph(prefix), q));
    break;
  }
  case "blindspots": {
    // the Unknown SOURCES, ranked by blast radius — the actionable inverse of a widely-propagated
    // Unknown (SPEC §3.1 ⟨0.6⟩): { sources:[{fn,why,reaches,affected}], totalUnknown }.
    const [prefix] = args;
    emit(coreBlindspots(loadReport(prefix), loadCallgraph(prefix)));
    break;
  }
  case "gains": {
    // the supply-chain alarm (SPEC §5.1): {gained:[Effect], byFunction:[{fn,effect}]} — what the
    // surface gained between two reports (base → cur), the cross-engine machine-readable form.
    const [curPrefix, basePrefix] = args;
    const gv = reportVersion(curPrefix), gbv = reportVersion(basePrefix);
    if (gv && gbv && gv !== gbv)
      console.error(`candor-ts: ⚠ baseline @${gbv} ≠ engine @${gv} — a "gained capability" may be the engine reclassifying, not the dependency changing. Regenerate both reports with one build to compare releases.`);
    emit({ baseline_version: gbv ?? "", engine_version: gv ?? "", ...coreGains(loadReport(curPrefix), loadReport(basePrefix)) });
    break;
  }
  case "path": {
    const [prefix, fn, eff] = args;
    emit(corePath(loadReport(prefix), loadCallgraph(prefix), fn, eff));
    break;
  }
  case "whatif": {
    const [prefix, target, eff, maybePolicy] = args;
    // A present policy arg (anything but the 0/1 verbosity sentinels) MUST exist and be readable —
    // a typo'd path must be LOUD, not silently "no policy → ok:true, exit 0" (mirrors scan's --policy,
    // which exits 2 on an unreadable file: a gate that can't read its policy can't certify anything).
    let pol = null;
    if (maybePolicy && maybePolicy !== "0" && maybePolicy !== "1") {
      let text;
      try {
        text = fs.readFileSync(maybePolicy, "utf8");
      } catch {
        console.error(`candor: policy ${maybePolicy} could not be read; whatif NOT evaluated against it`);
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
    const [prefix, target, eff, policyFile] = args;
    if (!target || !eff) { console.error("usage: candor-ts-query fix <prefix> <fn> <Effect> <policy-file>"); process.exit(2); }
    if (!policyFile) { console.error("candor: fix requires a policy file — the fix is the refactor that restores the boundary the edit crossed"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    // The sidecar is the ONLY graph a candor-ts report carries (it embeds no inline `calls`). Fail LOUD when
    // it's absent — never compute a degenerate empty-graph remedy that reads as a false "no clean hoist".
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    const r = coreFix(cg, loadReport(prefix), target, eff, parsePolicy(ptext), scopeMatches);
    if (r === null) { console.error(`candor: no function matching \`${target}\` in the call graph`); process.exit(2); }
    emit(r);
    break;
  }
  case "fix-gate": {
    // A remedy for EVERY deny/pure crossing — the shape the edit-time loop folds into its block message.
    const [prefix, policyFile] = args;
    if (!policyFile) { console.error("candor: fix-gate requires a policy file"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix-gate needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    emit(coreFixGate(cg, loadReport(prefix), parsePolicy(ptext), scopeMatches));
    break;
  }
  case "unverified": {
    // PROVABLE-PURITY disclosure: pure/deny layers that PASS but contain Unknown (not provably clean). A
    // policy is required; `--strict` exits 1 on a hole. Advisory (exit 0) otherwise.
    const strict = args.includes("--strict");
    const [prefix, policyFile] = args.filter((a) => a !== "--strict");
    if (!policyFile) { console.error("candor: unverified requires a policy file"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read`); process.exit(2); }
    const r = coreUnverified(loadReport(prefix), parsePolicy(ptext), scopeMatches);
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
