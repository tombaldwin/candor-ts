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
         containment as coreContainment,
         loadReport, loadCallgraph, matches } from "./query-core.mjs";
const emit = (v) => console.log(JSON.stringify(v, null, 1));

// ONE version + spec source, the SAME way scan.mjs reads them: PKG_VERSION is the bare semver from
// package.json; SPEC_VERSION is the spec contract this build speaks. Reused, never re-littered.
const QUERY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(QUERY_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.7";

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
    const [prefix, eff] = args;
    const fns = loadReport(prefix);
    emit({
      effect: eff,
      directly: fns.filter((e) => e.direct.includes(eff)).map((e) => e.fn).sort(),
      inherited: fns.filter((e) => e.inferred.includes(eff) && !e.direct.includes(eff)).map((e) => e.fn).sort(),
    });
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
    const [prefix] = args;
    const fns = loadReport(prefix);
    const mods = {};
    for (const e of fns) {
      const mod = e.fn.includes(".") ? e.fn.split(".").slice(0, -1).join(".") : "(root)";
      const m = (mods[mod] ??= { effects: new Set(), functions: 0 });
      for (const x of e.inferred) m.effects.add(x);
      m.functions += 1;
    }
    emit(Object.fromEntries(Object.entries(mods).sort()
      .map(([k, v]) => [k, { effects: [...v.effects].sort(), functions: v.functions }])));
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
    // the conformance suite pins (diff-vs-self must be {changes: []}).
    const [curPrefix, basePrefix] = args;
    const cur = new Map(loadReport(curPrefix).map((e) => [e.fn, new Set(e.inferred)]));
    const base = new Map(loadReport(basePrefix).map((e) => [e.fn, new Set(e.inferred)]));
    const changes = [];
    for (const fn of new Set([...cur.keys(), ...base.keys()])) {
      const c = cur.get(fn) ?? new Set(), b = base.get(fn) ?? new Set();
      const gained = [...c].filter((e) => !b.has(e)).sort();
      const lost = [...b].filter((e) => !c.has(e)).sort();
      if (gained.length || lost.length) changes.push({ fn, gained, lost });
    }
    changes.sort((a, b) => a.fn.localeCompare(b.fn));
    emit({ changes });
    process.exit(changes.some((c) => c.gained.length) ? 1 : 0);
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
    emit(coreGains(loadReport(curPrefix), loadReport(basePrefix)));
    break;
  }
  case "path": {
    const [prefix, fn, eff] = args;
    emit(corePath(loadReport(prefix), loadCallgraph(prefix), fn, eff));
    break;
  }
  case "whatif": {
    const [prefix, target, eff, maybePolicy] = args;
    const cg = loadCallgraph(prefix);
    const names = Object.keys(cg);
    const targets = matches(names, target);
    if (targets.length === 0) {
      console.error(`candor: no function matching \`${target}\` in the call graph`);
      process.exit(2);
    }
    const rev = new Map();
    for (const [caller, callees] of Object.entries(cg))
      for (const c of callees) (rev.get(c) ?? rev.set(c, []).get(c)).push(caller);
    const affected = new Set(targets);
    const queue = [...targets];
    while (queue.length) {
      const n = queue.pop();
      for (const c of rev.get(n) ?? []) if (!affected.has(c)) { affected.add(c); queue.push(c); }
    }
    const violations = [];
    // A present policy arg (anything but the 0/1 verbosity sentinels) MUST exist and be readable —
    // a typo'd path must be LOUD, not silently "no policy → ok:true, exit 0" (mirrors scan's --policy,
    // which exits 2 on an unreadable file: a gate that can't read its policy can't certify anything).
    if (maybePolicy && maybePolicy !== "0" && maybePolicy !== "1") {
      let text;
      try {
        text = fs.readFileSync(maybePolicy, "utf8");
      } catch {
        console.error(`candor: policy ${maybePolicy} could not be read; whatif NOT evaluated against it`);
        process.exit(2);
      }
      const pol = parsePolicy(text);
      for (const r of pol.deny) {
        if (r.effects.length && !r.effects.includes(eff)) continue; // pure ([]) forbids ANY effect
        for (const fn of affected)
          if (!r.scope || scopeMatches(fn, r.scope))
            violations.push({ fn, rule: `deny ${r.effects.join(" ") || "(pure)"} ${r.scope}`.trim() });
      }
    }
    emit({ of: targets, effect: eff, affected: [...affected].sort(), violations, ok: violations.length === 0 });
    process.exit(violations.length ? 1 : 0);
    break; // unreachable (process.exit), but eslint can't prove it — defends against fallthrough
  }
  default:
    // no command (cmd === undefined) or an unknown one: the FULL usage, not the stale 6-item list.
    if (cmd !== undefined) console.error(`candor-ts-query: unknown command '${cmd}'`);
    console.error(usage());
    process.exit(2);
}
