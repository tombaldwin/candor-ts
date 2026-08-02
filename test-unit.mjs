#!/usr/bin/env node
/**
 * Native unit tests (node:test, zero-dep, offline) for candor-ts's PURE cores — the query algebra
 * (query-core.mjs) and the policy DSL + literal matchers (policy.mjs). The behavioral suite (test.mjs)
 * scans real projects end to end; THIS suite pins the helpers' edge cases directly and fast, so a
 * regression in (say) the match ladder, the diff union, or a literal-coverage rule is caught at the
 * function boundary instead of only through a whole-scan assertion.
 *
 * Run: node --test test-unit.mjs   (or `npm run test:unit`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  matches, show, where, callers, map, impact, path as provenance, diff, gains, reachable, whatif,
  fix, fixGate, unverified,
  containment, loadReport, loadCallgraph, loadHierarchy, callersFrontier, blindspots, blindspotsStats, isReport,
  reportCoverage, gainsCoverage, parseClassFilter, ClassFilterError,
  claimsToHaveJudgedNothing, loadGateReport, reportJudgedNothing,
} from "./query-core.mjs";
import {
  parsePolicy, scopeMatches, hostPart, cmdBase, pathCovered, tableCovered, literalAllowed, EFFECTS,
  discoverConfigPolicy, evaluatePolicy, reasonClass, parseUnknownAliases, parseNetPartners,
  resolveReasonClasses,
} from "./policy.mjs";
import {
  isTestPath, kappa, kappaKnows, commandHeadEffects, hostLiteral, tablesInSql,
  isModelHost, modelHostEffects, isModelSdkPackage, netDestClass,
} from "./scan-core.mjs";
import { bestFind, bestFinds, tokenize } from "./surface.mjs";
import { verify, verifySites } from "./verify-core.mjs";
import { netEffects, destOf } from "./verify-emit.mjs";
import { parseTrace, programCheck } from "./verify-syscall.mjs";

// ── query-core: the §3.1 match ladder (exact > segment-suffix > substring) ────────────────────────
test("matches: exact beats substring cousins", () => {
  assert.deepEqual(matches(["foo", "foobar"], "foo"), ["foo"]);
});
test("matches: segment-suffix (.) beats a substring cousin, excludes embedded names", () => {
  assert.deepEqual(matches(["a.foo", "a.foobar"], "foo"), ["a.foo"]); // `.`-boundary wins
});
test("matches: falls back to substring when no exact/segment hit", () => {
  assert.deepEqual(matches(["xfoox", "yyy"], "foo"), ["xfoox"]);
});
test("matches: no hit → empty", () => {
  assert.deepEqual(matches(["a", "b"], "zzz"), []);
});

// ── query-core: show surfaces every literal surface under its report key ──────────────────────────
test("show: surfaces paths/hosts/cmds/tables + the 4 core keys, never the dead `fs` key", () => {
  const fns = [{
    fn: "m.f", inferred: ["Fs", "Net", "Exec", "Db"], direct: ["Fs"],
    paths: ["/etc/x"], hosts: ["api.example.com"], cmds: ["ls"], tables: ["users"], unresolved: false,
  }];
  const [o] = show(fns, "m.f");
  assert.deepEqual(o.paths, ["/etc/x"]);
  assert.deepEqual(o.hosts, ["api.example.com"]);
  assert.deepEqual(o.cmds, ["ls"]);
  assert.deepEqual(o.tables, ["users"]);
  assert.equal(o.fs, undefined); // the regression: `fs` is never a candor-ts report key
  assert.deepEqual([o.fn, o.inferred, o.direct, o.unresolved], ["m.f", ["Fs", "Net", "Exec", "Db"], ["Fs"], false]);
});
test("show: omits an absent surface", () => {
  const [o] = show([{ fn: "p", inferred: ["Clock"], direct: ["Clock"], unresolved: false }], "p");
  assert.equal("paths" in o, false);
  assert.equal("hosts" in o, false);
});

// ── reason-scoped Unknown (REASON-SCOPED-UNKNOWN-DESIGN.md — four-way with java/rust) ────────────────
test("reasonClass: raw unknownWhy tokens map to normative classes", () => {
  assert.equal(reasonClass("reflect:eval"), "reflect");
  assert.equal(reasonClass("native:extern"), "native");
  assert.equal(reasonClass("callback:fetch"), "indirect");
  assert.equal(reasonClass("dispatch:Foo.bar"), "dispatch");
  assert.equal(reasonClass("ambiguous:same-name"), "dispatch");
  assert.equal(reasonClass("unresolved"), "unresolved");
  assert.equal(reasonClass("brand-new-token"), "unresolved"); // conservative catch-all
  // A FOREIGN engine's token arrives in the normative `kind:detail` form. candor-swift emits
  // `dynamicMemberLookup:<root>.<prop>` and NEVER the bare token, so the `===` this replaced could not
  // match a real one — it fell through to `unresolved`, and since both classes are in DYNAMIC_CLASSES a
  // bare `deny Unknown` still fired while the class-targeted `deny Unknown[reflect]` silently did not.
  // The bare row stays: dropping it while widening would be a narrowing dressed as a fix.
  assert.equal(reasonClass("dynamicMemberLookup:Config.host"), "reflect");
  assert.equal(reasonClass("dynamicMemberLookup"), "reflect");
});
// ⟨0.24⟩ `ambiguous:` is SPEC §4's FIFTH kind — the analyser's own NAME RESOLUTION was ambiguous (two
// same-named local definitions), so no owner type could be formed at all. Not a `dispatch:` with a missing
// body and not a `callback:` (no function value). candor-ts's language model produces none of its own —
// TypeScript's module system gives every declaration a resolvable home — but the kind reaches this engine
// two ways: a chained dependency's `unknownWhy` is relayed VERBATIM into the consumer's report
// (scan.mjs's join), and EVERY query verb reads foreign reports (`--report` at a candor-rust prefix, where
// the kind is on 8710 of 19607 Unknown-bearing entries). So it must classify here whether or not it is
// emitted here. §6.2 projects it to class `dispatch`, which is why nothing above ever noticed §4 was one
// kind short: candor-ts holds this vocabulary ONCE (this prefix table — no enum, no union, no validator,
// no kind-keyed `switch`), so the two-halves drift §4 ⟨0.24⟩ warns about is structurally unreachable here.
//
// THE CONTROL that separates "added a fifth kind" from "stopped checking the kind set": a FABRICATED
// off-vocabulary kind must still route through the CONSERVATIVE CATCH-ALL (§2 forward-compatibility), NOT
// through `dispatch`. In the `kind:detail` form specifically — the bare `brand-new-token` row above cannot
// catch a blanket `return "dispatch"` in the catch-all, and cannot catch a catch-all widened to a prefix
// match either. Asserted for the kind that WAS added and one that was NOT, side by side, because the pair
// is the assertion: either one alone passes a diff that stopped discriminating.
test("reasonClass ⟨0.24⟩: `ambiguous:` classifies dispatch; a fabricated kind stays on the catch-all", () => {
  assert.equal(reasonClass("ambiguous:two same-named local definitions"), "dispatch"); // dot-free detail
  assert.equal(reasonClass("ambiguous:mod.Thing.go"), "dispatch");                     // dotted detail
  assert.equal(reasonClass("Ambiguous:Mixed-Case"), "dispatch");                       // the table lowercases
  assert.equal(reasonClass("banana:whatever"), "unresolved");   // § 2 forward-compat, NOT dispatch
  assert.equal(reasonClass("banana"), "unresolved");
  // and the near-miss: a kind that merely CONTAINS a canonical name is not that kind (the table is a
  // PREFIX match, and a prefix match is exactly what a `.includes()` slip would turn into a false hit).
  assert.equal(reasonClass("not-ambiguous:x"), "unresolved");
  assert.equal(reasonClass("banana:ambiguous:x"), "unresolved");
});
test("parsePolicy: Unknown[class…] / * / dynamic", () => {
  const r = parsePolicy("deny Net Unknown[dispatch,indirect] dom\n").deny[0];
  assert.deepEqual(r.effects, ["Net", "Unknown"]);
  assert.equal(r.scope, "dom");
  assert.deepEqual(r.unknownClasses, ["dispatch", "indirect"]);
  assert.deepEqual(parsePolicy("deny Net Unknown dom\n").deny[0].unknownClasses, []); // bare ⇒ all
  assert.deepEqual(parsePolicy("deny Net Unknown[*] dom\n").deny[0].unknownClasses, []); // * ⇒ all
  assert.deepEqual(parsePolicy("deny Net Unknown[dynamic] dom\n").deny[0].unknownClasses,
    ["dispatch", "indirect", "native", "reflect", "unresolved"]);
});
test("config unknown-alias: resolves a user name, rejects a reserved one", () => {
  const aliases = parseUnknownAliases(
    "unknown-alias risky = reflect,native\nunknown-alias telemetry = indirect\nunknown-alias reflect = native\n");
  assert.deepEqual([...aliases.get("risky")].sort(), ["native", "reflect"]);
  assert.deepEqual([...aliases.get("telemetry")], ["indirect"]);
  assert.equal(aliases.has("reflect"), false, "a config alias may not shadow a class token");
  assert.deepEqual(parsePolicy("deny Net Unknown[risky] api\n", aliases).deny[0].unknownClasses, ["native", "reflect"]);
  // an UNDEFINED alias name is dropped-with-warning → empty filter (behaves like bare Unknown[*])
  assert.deepEqual(parsePolicy("deny Net Unknown[nope] api\n", aliases).deny[0].unknownClasses, []);
});
test("evaluatePolicy: reason class propagates transitively to callers", () => {
  // caller inherits Unknown from a reflect-caused callee; only the callee has the direct reason.
  const functions = [
    { fn: "dom.caller", inferred: ["Unknown"] },
    { fn: "dom.callee", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },
  ];
  const cg = { "dom.caller": ["dom.callee"], "dom.callee": [] };
  const fire = (pol) => evaluatePolicy(parsePolicy(pol), functions, cg).filter((v) => v.rule === "AS-EFF-006").map((v) => v.fn).sort();
  // §6.2 ⟨0.19⟩: the verdict carries reasonClass on the Unknown denial — on the caller too (transitive).
  const rc = evaluatePolicy(parsePolicy("deny Net Unknown[reflect]\n"), functions, cg).filter((v) => v.rule === "AS-EFF-006");
  for (const v of rc) assert.deepEqual(v.reasonClass, ["reflect"], `reasonClass rides the Unknown verdict for ${v.fn}`);
  assert.deepEqual(fire("deny Net Unknown[reflect]\n"), ["dom.callee", "dom.caller"], "reflect fires on caller + callee");
  assert.deepEqual(fire("deny Net Unknown[native]\n"), [], "native tolerates a reflect-class Unknown");
  assert.deepEqual(fire("deny Net Unknown\n"), ["dom.callee", "dom.caller"], "bare Unknown fires on any");
  // an Unknown with no recorded reason ⇒ unresolved (conservative). ⟨0.24⟩ the fixture now says WHOSE
  // hole it is: `direct: ["Unknown"]` — a leaf with no callees, so its Unknown can only be its own. The
  // contribution is gated on exactly that (§6.2 req 3); an entry that merely INHERITED an Unknown is
  // scoped by its callee's class instead, which is what `dom.caller` above pins.
  const noReason = [{ fn: "x.f", inferred: ["Unknown"], direct: ["Unknown"] }];
  const fire2 = (pol) => evaluatePolicy(parsePolicy(pol), noReason, { "x.f": [] }).filter((v) => v.rule === "AS-EFF-006").length;
  assert.equal(fire2("deny Net Unknown[unresolved]\n"), 1, "no reason ⇒ unresolved matches");
  assert.equal(fire2("deny Net Unknown[reflect]\n"), 0, "no reason ⇒ not a specific class");
});

test("parsePolicy + netDestClass: Net destination-class parses and classifies", () => {
  // `Net[unknown-host,known-telemetry]` narrows the Net membership; bare/`*` ⇒ all; unknown class dropped.
  assert.deepEqual(parsePolicy("deny Net[unknown-host,known-telemetry] dom").deny[0].netClasses,
    ["known-telemetry", "unknown-host"]);
  assert.deepEqual(parsePolicy("deny Net dom").deny[0].netClasses, [], "bare Net ⇒ all");
  assert.deepEqual(parsePolicy("deny Net[*] dom").deny[0].netClasses, [], "Net[*] ⇒ all");
  assert.deepEqual(parsePolicy("deny Net[nope] dom").deny[0].netClasses, [], "unknown class dropped ⇒ all");
  const none = new Set();
  assert.equal(netDestClass("sentry.io", none), "known-telemetry");
  assert.equal(netDestClass("us.i.posthog.com", none), "known-telemetry"); // 0.20.1 corpus-grown
  assert.equal(netDestClass("o1.ingest.sentry.io", none), "known-telemetry", "subdomain-aware");
  assert.equal(netDestClass("api.openai.com", none), "known-partner", "a model host is known-partner");
  assert.equal(netDestClass("evil.example.com", none), "unknown-host");
  assert.equal(netDestClass("api.stripe.com", new Set(["api.stripe.com"])), "known-partner", "config partner");
  assert.equal(netDestClass("api.stripe.com", none), "unknown-host", "partner is config-only");
  assert.deepEqual([...parseNetPartners("net-partner Api.Stripe.com:443\nNET-PARTNER hooks.stripe.com\n")].sort(),
    ["api.stripe.com", "hooks.stripe.com"]);
});
test("evaluatePolicy: Net destination-class gate fires on unknown-host, tolerates asserted-safe", () => {
  const functions = [
    { fn: "d.tel", inferred: ["Net"], hosts: ["sentry.io"] },
    { fn: "d.exfil", inferred: ["Net"], hosts: ["evil.example.com"] },
    { fn: "d.runtime", inferred: ["Net"], hosts: [] },       // Net, no visible host → fail-closed unknown-host
    { fn: "d.partner", inferred: ["Net"], hosts: ["api.stripe.com"] },
    { fn: "d.caller", inferred: ["Net"], hosts: ["evil.example.com"] }, // reaches exfil transitively (hosts propagated)
  ];
  const cg = { "d.caller": ["d.exfil"] };
  const partners = new Set(["api.stripe.com"]);
  const fire = (pol) => evaluatePolicy(parsePolicy(pol), functions, cg, new Map(), partners)
    .filter((v) => v.rule === "AS-EFF-006").map((v) => v.fn).sort();
  assert.deepEqual(fire("deny Net[unknown-host]\n"), ["d.caller", "d.exfil", "d.runtime"],
    "unknown-host + runtime + the caller reaching exfil fire; telemetry + config-partner tolerated");
  // the verdict carries the fn's destination classes.
  const v = evaluatePolicy(parsePolicy("deny Net[unknown-host]\n"), functions, cg, new Map(), partners)
    .find((x) => x.fn === "d.exfil");
  assert.deepEqual(v.netClass, ["unknown-host"]);
  // fail-closed on a masked surface: a visible telemetry host with an incomplete Net surface → unknown-host.
  const masked = [{ fn: "m", inferred: ["Net"], hosts: ["sentry.io"] }];
  const inc = new Map([["m", new Set(["Net"])]]);
  assert.equal(evaluatePolicy(parsePolicy("deny Net[unknown-host]\n"), masked, {}, inc, partners)
    .filter((x) => x.rule === "AS-EFF-006").length, 1, "a masked surface fails closed even with a telemetry host");
  // bare `deny Net` still denies ALL destinations (backward-compat).
  assert.deepEqual(fire("deny Net\n"), ["d.caller", "d.exfil", "d.partner", "d.runtime", "d.tel"]);
});

// ── candor verify: the dynamic honesty oracle (RQ1) ───────────────────────────────────────────────
test("verify: a hidden effect (ran Net, declared complete-pure) is a cardinal-sin VIOLATION", () => {
  const report = { functions: [{ fn: "app.f", inferred: [] }] };       // candor claimed f pure (complete)
  const trace = [{ fn: "app.f", effect: "Net" }];                       // …but it ran Net
  const r = verify(report, trace, "direct");
  assert.equal(r.metrics.honestyInvariantHolds, false);
  assert.equal(r.metrics.cardinalSinViolations, 1);
  assert.deepEqual(r.violations[0].escaped, ["Net"]);
});
test("verify: an ABSENT fn is a purity claim — a runtime effect from it is a VIOLATION", () => {
  const r = verify({ functions: [] }, [{ fn: "app.dropped", effect: "Fs" }], "direct");
  assert.equal(r.metrics.cardinalSinViolations, 1, "a silently-dropped effectful fn surfaces as a violation");
});
test("verify: disclosure (Unknown) flips the same run to HELD (disclosed-partial, load-bearing)", () => {
  const report = { functions: [{ fn: "app.f", inferred: ["Unknown"] }] };
  const r = verify(report, [{ fn: "app.f", effect: "Net" }], "direct");
  assert.equal(r.metrics.honestyInvariantHolds, true, "Unknown discloses the hole — the invariant HOLDS");
  assert.equal(r.metrics.cardinalSinViolations, 0);
  assert.equal(r.metrics.disclosedUnknownLoadBearing, 1, "the Unknown was doing real work");
});
test("verify: a load-bearing Unknown is BLAMED to its unknownWhy reason (the edge to resolve for precision)", () => {
  // The disclosure held the invariant, but the Unknown ACTUALLY mattered (Net escaped the non-Unknown sig).
  // The blame names the exact unresolved edge (`callback:fetch`) to resolve to eliminate the Unknown.
  const report = { functions: [{ fn: "app.f", inferred: ["Unknown"], unknownWhy: ["callback:fetch"] }] };
  const r = verify(report, [{ fn: "app.f", effect: "Net" }], "direct");
  assert.equal(r.metrics.honestyInvariantHolds, true, "still HELD — verdict is unchanged");
  assert.equal(r.metrics.disclosedUnknownLoadBearing, 1);
  assert.equal(r.blame.length, 1, "the load-bearing Unknown is surfaced as blame");
  assert.deepEqual(r.blame[0].why, ["callback:fetch"], "blamed to its unknownWhy reason");
  assert.deepEqual(r.blame[0].escaped, ["Net"], "…for the effect the Unknown was covering");
  assert.deepEqual(r.rows.find((x) => x.fn === "app.f").blame, ["callback:fetch"], "the row carries the blame too");
});
test("verify: a NON-load-bearing disclosed Unknown gets no blame (the disclosure didn't matter here)", () => {
  // Net is inferred explicitly; the Unknown adds nothing the run needed ⇒ no blame (nothing to resolve).
  const report = { functions: [{ fn: "app.f", inferred: ["Net", "Unknown"], unknownWhy: ["callback:fetch"] }] };
  const r = verify(report, [{ fn: "app.f", effect: "Net" }], "direct");
  assert.equal(r.metrics.disclosedUnknownLoadBearing, 0);
  assert.equal(r.blame.length, 0, "the Unknown wasn't load-bearing → nothing to blame");
});
// ── attribution soundness: a pure fn (no loc in the §2 report) that runs an effect must not fold into a
// neighbour and vanish. The ALL-FUNCTION loc index closes the hole; its absence must fail CLOSED (disclose).
test("verify: WITHOUT the loc index, a pure fn's effect folds into the preceding effectful fn — disclosed, not silently HELD", () => {
  // loadConfig@3 (Fs), saveResult@6 (Fs) are effectful; computeTotal@9 is pure (absent). An Fs at line 10
  // is INSIDE computeTotal — but with only effectful locs it anchors to saveResult@6 (which claims Fs).
  const report = { functions: [
    { fn: "app.loadConfig", inferred: ["Fs"], loc: "app.ts:3:1" },
    { fn: "app.saveResult", inferred: ["Fs"], loc: "app.ts:6:1" },
  ] };
  const sites = [{ file: "app.ts", line: 10, effect: "Fs" }];
  const r = verifySites(report, sites, "direct", { analyzedCount: 3 }); // 3 analyzed, 2 effectful ⇒ 1 pure unlocated
  assert.equal(r.metrics.cardinalSinViolations, 0, "the misattribution hides the escape (the bug)…");
  assert.equal(r.metrics.attributionComplete, false, "…but it is NO LONGER a silent all-clear — disclosed");
  assert.match(r.metrics.attributionNote, /pure fn/);
});
test("verify: WITH the loc index, the same pure-fn effect anchors to itself and is a cardinal-sin VIOLATION", () => {
  const report = { functions: [
    { fn: "app.loadConfig", inferred: ["Fs"], loc: "app.ts:3:1" },
    { fn: "app.saveResult", inferred: ["Fs"], loc: "app.ts:6:1" },
  ] };
  const sites = [{ file: "app.ts", line: 10, effect: "Fs" }];
  const locIndex = { "app.loadConfig": { loc: "app.ts:3:1", end: 5 }, "app.saveResult": { loc: "app.ts:6:1", end: 8 }, "app.computeTotal": { loc: "app.ts:9:1", end: 11 } };
  const r = verifySites(report, sites, "direct", { locIndex, analyzedCount: 3 });
  assert.equal(r.metrics.attributionComplete, true, "the full-universe span index makes attribution sound");
  assert.equal(r.metrics.cardinalSinViolations, 1, "computeTotal ran Fs but is claimed pure — the cardinal sin");
  assert.equal(r.violations[0].fn, "app.computeTotal");
  assert.deepEqual(r.violations[0].escaped, ["Fs"]);
});
test("verify: SPAN containment — an effect after a nested pure fn but INSIDE the effectful outer fn attributes to the OUTER (no false violation)", () => {
  // The corpus-found false positive: `run` (effectful, Fs) spans [1,20]; a pure callback `cb` (absent from
  // the report) is a nested arrow spanning [5,6]. An Fs site at line 10 is INSIDE run but AFTER cb. A start-
  // only "nearest declaration below" rule would blame cb (pure) → false VIOLATION; span containment blames run.
  const report = { functions: [{ fn: "app.run", inferred: ["Fs"], loc: "app.ts:1:1", endLine: 20 }] };
  const sites = [{ file: "app.ts", line: 10, effect: "Fs" }];
  const locIndex = { "app.run": { loc: "app.ts:1:1", end: 20 }, "app.cb": { loc: "app.ts:5:1", end: 6 } };
  const r = verifySites(report, sites, "direct", { locIndex, analyzedCount: 2 });
  assert.equal(r.metrics.cardinalSinViolations, 0, "the site is inside run (Fs), not the pure nested cb");
  assert.equal(r.rows.find((x) => x.observed.includes("Fs"))?.fn, "app.run", "attributed to the innermost CONTAINING span");
});
test("verify: SPAN containment still catches a real escape inside the nested pure fn itself", () => {
  // Same shape, but the Fs site is at line 5 — INSIDE cb's own span [5,6]. cb is claimed pure ⇒ VIOLATION.
  const report = { functions: [{ fn: "app.run", inferred: ["Fs"], loc: "app.ts:1:1", endLine: 20 }] };
  const locIndex = { "app.run": { loc: "app.ts:1:1", end: 20 }, "app.cb": { loc: "app.ts:5:1", end: 6 } };
  const r = verifySites(report, [{ file: "app.ts", line: 5, effect: "Fs" }], "direct", { locIndex, analyzedCount: 2 });
  assert.equal(r.metrics.cardinalSinViolations, 1);
  assert.equal(r.violations[0].fn, "app.cb", "the innermost span containing line 5 is cb");
});
test("verify: an UNPLACED project effect (a captured site the index can't anchor) makes attribution INCOMPLETE", () => {
  // The decisive invariant: a real observed effect that lands on no analyzed fn (empty/stale/mismatched index,
  // code candor never analyzed, a path-separator mismatch) must NOT be silently dropped into a HOLD.
  const report = { functions: [{ fn: "app.f", inferred: ["Fs"], loc: "app.ts:1:1", endLine: 20 }] };
  const locIndex = { "app.f": { loc: "app.ts:1:1", end: 20 } };
  const r = verifySites(report, [{ file: "other.ts", line: 3, effect: "Fs" }], "direct", { locIndex, analyzedCount: 1 });
  assert.equal(r.metrics.attributionComplete, false, "an unplaceable project effect ⇒ not a sound all-clear");
  assert.equal(r.metrics.unattributedSites, 1);
});
test("verify: an EMPTY loc index does NOT certify attribution complete (else it drops all sites → false HOLD)", () => {
  const report = { functions: [{ fn: "app.f", inferred: ["Fs"], loc: "app.ts:1:1", endLine: 20 }] };
  const r = verifySites(report, [{ file: "app.ts", line: 3, effect: "Fs" }], "direct", { locIndex: {}, analyzedCount: 1 });
  assert.equal(r.metrics.attributionComplete, false, "empty index ⇒ every site unattributed ⇒ incomplete");
});
test("verify: attribution is complete (no disclosure) when there are no unlocated pure fns", () => {
  const report = { functions: [{ fn: "app.f", inferred: ["Fs"], loc: "app.ts:1:1" }] };
  const r = verifySites(report, [{ file: "app.ts", line: 2, effect: "Fs" }], "direct", { analyzedCount: 1 });
  assert.equal(r.metrics.attributionComplete, true, "analyzed == effectful ⇒ nothing pure to mislocate");
});
test("verify: observed ⊆ inferred is sound-complete-ok (no false positive on a truthful signature)", () => {
  const report = { functions: [{ fn: "app.f", inferred: ["Net", "Fs"] }] };
  const r = verify(report, [{ fn: "app.f", effect: "Net" }], "direct");
  assert.equal(r.metrics.soundCompleteOk, 1);
  assert.equal(r.metrics.cardinalSinViolations, 0);
});
test("verify: the observability SCOPE is enforced — an out-of-scope effect is not asserted over", () => {
  // Env is invisible to the `direct` (syscall-parity) scope, so a ran-Env-declared-pure fn is NOT a
  // violation under `direct` (the oracle must not claim soundness over effects it doesn't assert on);
  // under `all` (the language-level capture wraps process.env) it IS.
  const report = { functions: [{ fn: "app.f", inferred: [] }] };
  const trace = [{ fn: "app.f", effect: "Env" }];
  assert.equal(verify(report, trace, "direct").metrics.cardinalSinViolations, 0, "Env out of `direct` scope");
  assert.equal(verify(report, trace, "all").metrics.cardinalSinViolations, 1, "Env in `all` scope");
});

test("verify: Llm/Db are refinements of Net — an honest Net claim is NOT a violation when refined at runtime", () => {
  // candor honestly said `Net` (couldn't resolve the model host); the run refined it to Llm. HOLDS.
  const r = verify({ functions: [{ fn: "app.f", inferred: ["Net"] }] }, [{ fn: "app.f", effect: "Llm" }, { fn: "app.f", effect: "Net" }], "all");
  assert.equal(r.metrics.cardinalSinViolations, 0, "a missing REFINEMENT (Llm over a reported Net) is not a false-pure");
  // but a missing BASE effect still is: ran Llm, declared complete-pure → the base Net escaped.
  const v = verify({ functions: [{ fn: "app.f", inferred: [] }] }, [{ fn: "app.f", effect: "Llm" }], "all");
  assert.equal(v.metrics.cardinalSinViolations, 1, "an Llm over a pure claim IS a violation (neither Llm nor its base Net)");
});
test("verify: Net destination classifier refines Llm (model host) + Db (db port), else bare Net", () => {
  assert.deepEqual(netEffects("api.openai.com", 443), ["Net", "Llm"], "a model host → Llm");
  assert.deepEqual(netEffects("eu.api.openai.com", null), ["Net", "Llm"], "a model-host subdomain → Llm");
  assert.deepEqual(netEffects("db.internal", 5432), ["Net", "Db"], "a Postgres port → Db");
  assert.deepEqual(netEffects("example.com", 443), ["Net"], "an ordinary host → bare Net");
  assert.deepEqual(netEffects("", null), ["Net"], "an unresolved destination → bare Net (never fabricated)");
});
test("verify: destOf extracts host/port from each Net entry-point arg shape", () => {
  assert.deepEqual(destOf("http", "fetch", ["https://api.openai.com/v1/chat"]), { host: "api.openai.com", port: null });
  assert.deepEqual(destOf("http", "request", [{ hostname: "h.example.com", port: 8080 }]), { host: "h.example.com", port: 8080 });
  assert.deepEqual(destOf("net", "connect", [5432, "db.local"]), { host: "db.local", port: 5432 });
  assert.deepEqual(destOf("net", "connect", [{ host: "x", port: 6379 }]), { host: "x", port: 6379 });
  assert.deepEqual(destOf("dns", "lookup", ["host.example.com"]), { host: "host.example.com", port: null });
});

test("verify/syscall: parses strace + dtruss traces to the effect set (mechanism-independent)", () => {
  const strace = [
    "openat(AT_FDCWD, \"/etc/hosts\", O_RDONLY) = 3",
    "[pid 4211] connect(3, {sa_family=AF_INET, sin_port=htons(443)}, 16) = 0",
    "read(3, \"...\", 4096) = 512",
    "clock_gettime(CLOCK_MONOTONIC, ...) = 0",   // Clock is INVISIBLE to the direct scope — not counted
    "brk(NULL) = 0x55…",                          // non-effect syscall — ignored
  ].join("\n");
  assert.deepEqual([...parseTrace(strace, "strace")].sort(), ["Fs", "Net"]);
  const dtruss = "  stat64(\"/tmp/x\", 0x7ff, 0x0)\t\t = 0 0\n  execve(\"/bin/ls\", 0x7ff, 0x0)\t\t = 0 0\n";
  assert.deepEqual([...parseTrace(dtruss, "dtruss")].sort(), ["Exec", "Fs"]);
});
test("verify/syscall: an effect the kernel saw that candor claims NOWHERE is a program-wide escape", () => {
  // candor's report union has only Fs; the kernel trace shows Net → a program-wide false-pure.
  const held = programCheck(new Set(["Fs", "Net"]), new Set(["Fs", "Net"]));
  assert.equal(held.honestyInvariantHolds, true);
  const esc = programCheck(new Set(["Fs"]), new Set(["Fs", "Net"]));
  assert.deepEqual(esc.escaped, ["Net"]);
  assert.equal(esc.honestyInvariantHolds, false);
  // an Unknown ANYWHERE in the report discloses candor couldn't see everything → no escape asserted.
  const disc = programCheck(new Set(["Fs", "Unknown"]), new Set(["Fs", "Net"]));
  assert.equal(disc.honestyInvariantHolds, true);
  assert.equal(disc.disclosedUnknown, true);
});

// ── query-core: where / callers / map ─────────────────────────────────────────────────────────────
test("where: splits directly vs inherited for an effect", () => {
  const fns = [
    { fn: "a", inferred: ["Fs"], direct: ["Fs"] },
    { fn: "b", inferred: ["Fs"], direct: [] },     // inherited only
    { fn: "c", inferred: ["Net"], direct: ["Net"] },
  ];
  assert.deepEqual(where(fns, "Fs"), { effect: "Fs", directly: ["a"], inherited: ["b"] });
});
test("callers: direct one-hop + transitive upstream", () => {
  const cg = { a: ["b"], b: ["c"], c: [] };
  const r = callers(cg, "c");
  assert.deepEqual(r.of, ["c"]);
  assert.deepEqual(r.direct, ["b"]);
  assert.deepEqual(r.transitive, ["a", "b"]);
});
test("map: each module bucket is {effects, functions}", () => {
  const fns = [
    { fn: "a.b.f", inferred: ["Fs"], direct: ["Fs"] },
    { fn: "a.b.g", inferred: ["Net"], direct: ["Net"] },
    { fn: "root", inferred: ["Env"], direct: ["Env"] },
  ];
  const m = map(fns);
  assert.deepEqual(m["a.b"], { effects: ["Fs", "Net"], functions: 2 });
  assert.deepEqual(m["(root)"], { effects: ["Env"], functions: 1 });
});

// ── query-core: containment (SPEC §6.1 dispersion + AS-EFF-010 ratchet) ───────────────────────────
// Layer = the segment after the common dotted prefix; boundary effects scored, ambient reported-not-scored.
// 4-segment names (c.<layer>.<Class>.<method>) so the layer = the segment after the common `c` prefix —
// mirrors the candor-spec containment conformance fixture (c.repo.Repo.* / c.svc.Svc.*).
const CONT_CUR = [
  { fn: "c.repo.Repo.readA", inferred: ["Fs"], direct: ["Fs"] },
  { fn: "c.repo.Repo.readB", inferred: ["Fs"], direct: ["Fs"] },
  { fn: "c.svc.Svc.net", inferred: ["Net"], direct: ["Net"] },
  { fn: "c.svc.Svc.leak", inferred: ["Fs"], direct: ["Fs"] },  // the drift: Fs in a new layer
];
const CONT_BASE = CONT_CUR.filter((e) => e.fn !== "c.svc.Svc.leak");
test("containment: per-boundary-effect dispersion (pct/layers/owner/placement)", () => {
  const r = containment(CONT_CUR);
  const fs = r.contained.find((c) => c.effect === "Fs");
  assert.deepEqual(fs, { effect: "Fs", containmentPct: 66, layers: 2, owner: "repo", placement: { repo: 2, svc: 1 } });
  const net = r.contained.find((c) => c.effect === "Net");
  assert.deepEqual(net, { effect: "Net", containmentPct: 100, layers: 1, owner: "svc", placement: { svc: 1 } });
  assert.deepEqual(r.ambient, {});
});
test("containment: 2-segment names (file.fn) bucket by FILE, not all to (root)", () => {
  // REAL candor-ts naming for free functions is FILE.fn (2 segments). The layer rule must put each in its
  // file's layer, not collapse everything to "(root)" (the `+2` bug that the 4-segment fixture above masked).
  const r = containment([
    { fn: "repo.readA", inferred: ["Fs"], direct: ["Fs"] },
    { fn: "repo.readB", inferred: ["Fs"], direct: ["Fs"] },
    { fn: "svc.net", inferred: ["Net"], direct: ["Net"] },
  ]);
  const fs = r.contained.find((c) => c.effect === "Fs");
  assert.deepEqual(fs.placement, { repo: 2 });           // NOT { "(root)": 2 }
  assert.deepEqual(r.contained.find((c) => c.effect === "Net").placement, { svc: 1 });
});
test("containment ratchet: a boundary effect entering a new layer is a leak", () => {
  assert.deepEqual(containment(CONT_CUR, CONT_BASE), { leaks: ["Fs → svc"], cleanups: [] });
  assert.deepEqual(containment(CONT_CUR, CONT_CUR), { leaks: [], cleanups: [] });          // unchanged
  assert.deepEqual(containment(CONT_BASE, CONT_CUR), { leaks: [], cleanups: ["Fs ⊘ svc"] }); // improvement
});

// ── query-core: impact / path (the blast-radius + provenance shapes) ──────────────────────────────
const RADIUS_FNS = [
  { fn: "leaf", inferred: ["Fs"], direct: ["Fs"] },
  { fn: "mid", inferred: ["Fs"], direct: [] },
  { fn: "root", inferred: ["Fs"], direct: [], entryPoint: true },
];
const RADIUS_CG = { root: ["mid"], mid: ["leaf"], leaf: [] };
test("impact: backward blast radius + downstream entry points", () => {
  const r = impact(RADIUS_FNS, RADIUS_CG, "leaf");
  assert.equal(r.fn, "leaf");
  assert.equal(r.affectedCount, 2);
  assert.deepEqual(r.affected, ["mid", "root"]);
  assert.deepEqual(r.entryPoints, [{ fn: "root", inferred: ["Fs"] }]);
  assert.equal(r.affectedCount, r.affected.length); // the cross-engine invariant
});
test("path: forward provenance to the nearest direct source", () => {
  const r = provenance(RADIUS_FNS, RADIUS_CG, "root", "Fs");
  assert.equal(r.effect, "Fs");
  assert.equal(r.fn, "root");
  assert.deepEqual(r.path.map((s) => [s.fn, s.source]), [["root", false], ["mid", false], ["leaf", true]]);
});
test("path: honest empty chain when no local source is on a path", () => {
  assert.deepEqual(provenance(RADIUS_FNS, RADIUS_CG, "root", "Net"), { effect: "Net", fn: "root", path: [] });
});

// ── query-core: diff / gains (the supply-chain alarm + the union-not-last-wins fix) ───────────────
test("diff: per-fn gained/lost delta", () => {
  const r = diff([{ fn: "f", inferred: ["Net", "Fs"] }], [{ fn: "f", inferred: ["Fs"] }]);
  assert.deepEqual(r.changes, [{ fn: "f", gained: ["Net"], lost: [] }]);
});
test("gains: UNIONS effects across same-named rows (a last-wins Map would drop one — supply-chain miss)", () => {
  const cur = [{ fn: "f", inferred: ["Net"] }, { fn: "f", inferred: ["Db"] }];
  const r = gains(cur, []);
  assert.deepEqual(r.gained, ["Db", "Net"]); // both, not just the last row's
});
test("gains: a stable surface raises no alarm", () => {
  assert.deepEqual(gains([{ fn: "f", inferred: ["Fs"] }], [{ fn: "f", inferred: ["Fs"] }]).gained, []);
});

// ── query-core: reportCoverage / gainsCoverage — the ⟨0.15 staged⟩ coverage envelope consumers ─────
// COVERAGE-DESIGN.md §1/§3: the κ ledger travels with the report; gains discloses the CURRENT ledger
// and a name-level delta vs the baseline; a coverage-free comparison stays byte-identical to ⟨0.14⟩.
test("reportCoverage: reads the envelope ledger, sorted count-desc/name-asc; null when absent", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "candor-cov-"));
  fs.writeFileSync(path.join(D, "r.json"), JSON.stringify({
    functions: [], coverage: { uncovered: [{ name: "a", calls: 1 }, { name: "z", calls: 9 }, { name: "b", calls: 1 }] },
  }));
  fs.writeFileSync(path.join(D, "plain.json"), JSON.stringify({ functions: [] }));   // pre-0.15 / fully covered
  assert.deepEqual(reportCoverage(path.join(D, "r")),
    [{ name: "z", calls: 9 }, { name: "a", calls: 1 }, { name: "b", calls: 1 }]);
  assert.equal(reportCoverage(path.join(D, "plain")), null);                          // OMITTED, never []
  fs.rmSync(D, { recursive: true, force: true });
});
test("reportCoverage: multi-report siblings merge (counts summed); malformed entries tolerated", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "candor-cov-"));
  fs.writeFileSync(path.join(D, "r.a.scan.json"), JSON.stringify({
    functions: [], coverage: { uncovered: [{ name: "dep", calls: 2 }, { calls: 5 }, "junk"] },
  }));
  fs.writeFileSync(path.join(D, "r.b.scan.json"), JSON.stringify({
    functions: [], coverage: { uncovered: [{ name: "dep", calls: 3 }, { name: "other", calls: "NaN" }] },
  }));
  assert.deepEqual(reportCoverage(path.join(D, "r")),
    [{ name: "dep", calls: 5 }, { name: "other", calls: 0 }]);  // a non-numeric count still NAMES the blind spot
  fs.rmSync(D, { recursive: true, force: true });
});
test("gainsCoverage: current ledger rides along; name-level delta vs the baseline; empty case spreads to {}", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "candor-cov-"));
  const w = (f, doc) => fs.writeFileSync(path.join(D, f), JSON.stringify(doc));
  w("cur.json", { functions: [], coverage: { uncovered: [{ name: "newdep", calls: 2 }, { name: "kept", calls: 1 }] } });
  w("base.json", { functions: [], coverage: { uncovered: [{ name: "kept", calls: 4 }, { name: "gone", calls: 1 }] } });
  w("plain.json", { functions: [] });
  const g = gainsCoverage(path.join(D, "cur"), path.join(D, "base"));
  assert.deepEqual(g.coverage, { uncovered: [{ name: "newdep", calls: 2 }, { name: "kept", calls: 1 }] });
  // the delta field names are the java reference engine's exactly (cross-engine wire parity)
  assert.deepEqual(g.coverageDelta, { nowUncovered: ["newdep"], noLongerUncovered: ["gone"] });
  // count wobble only (same names) → no delta; identical ledgers → no delta; no coverage anywhere → {}
  w("wobble.json", { functions: [], coverage: { uncovered: [{ name: "kept", calls: 9 }, { name: "gone", calls: 2 }] } });
  assert.equal("coverageDelta" in gainsCoverage(path.join(D, "wobble"), path.join(D, "base")), false);
  assert.deepEqual(gainsCoverage(path.join(D, "plain"), path.join(D, "plain")), {});
  // baseline-only ledger (a dep is no longer blind): no `coverage` block, the delta names it
  const g2 = gainsCoverage(path.join(D, "plain"), path.join(D, "base"));
  assert.equal("coverage" in g2, false);
  assert.deepEqual(g2.coverageDelta, { nowUncovered: [], noLongerUncovered: ["gone", "kept"] });
  fs.rmSync(D, { recursive: true, force: true });
});

// ── query-core: reachable / whatif ────────────────────────────────────────────────────────────────
test("reachable: unions effects over entry points", () => {
  const fns = [
    { fn: "r1", inferred: ["Net"], direct: ["Net"], entryPoint: true },
    { fn: "r2", inferred: ["Net"], direct: ["Net"], entryPoint: true },
    { fn: "inner", inferred: ["Fs"], direct: ["Fs"] }, // not a root
  ];
  const r = reachable(fns);
  assert.equal(r.entryPoints, 2);
  assert.deepEqual(r.effects.Net, { count: 2, via: ["r1", "r2"] });
  assert.equal("Fs" in r.effects, false);
});
test("whatif: hypothetical effect → blast radius + deny violations", () => {
  const cg = { handler: ["svc"], svc: [] };
  const pol = parsePolicy("deny Net handler");
  const r = whatif(cg, "svc", "Net", pol, scopeMatches);
  assert.deepEqual(r.affected, ["handler", "svc"]);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.fn === "handler"));
});
test("whatif: no such fn → null", () => {
  assert.equal(whatif({ a: [] }, "nope", "Net", null, scopeMatches), null);
});

// ── fix / fix-gate: the boundary remedy (FIX-SPEC), the remedial inverse of whatif ────────────────
// orderflow: api.get → domain.bulk → domain.price → infra.fetch, all carrying Net, the leaf direct.
const ofCg = { "api.get": ["domain.bulk"], "domain.bulk": ["domain.price"], "domain.price": ["infra.fetch"], "infra.fetch": [] };
const ofFns = [
  { fn: "api.get", inferred: ["Net"], direct: [], calls: ["domain.bulk"] },
  { fn: "domain.bulk", inferred: ["Net"], direct: [], calls: ["domain.price"] },
  { fn: "domain.price", inferred: ["Net"], direct: [], calls: ["infra.fetch"] },
  { fn: "infra.fetch", inferred: ["Net"], direct: ["Net"], calls: [] },
];
test("fix: hoists Net to the api caller, site is the infra leaf, span is the two domain fns", () => {
  const r = fix(ofCg, ofFns, "domain.price", "Net", parsePolicy("deny Net domain"), scopeMatches);
  assert.equal(r.crossing, true);
  assert.equal(r.layer, "domain");
  assert.deepEqual(r.site, ["infra.fetch"]);
  assert.deepEqual(r.hoistTo, ["api.get"]);
  assert.deepEqual(r.deniedSpan, ["domain.bulk", "domain.price"]);
  assert.equal(r.policyAlternative, "allow Net domain");
  assert.deepEqual(r.hoistHigher, [], "api.get is the top — no higher hoist option");
});
test("fix: surfaces the higher-hoist trade-off when an allowed caller sits above the frontier", () => {
  const cg = { "main.run": ["api.get"], ...ofCg };
  const fns = [{ fn: "main.run", inferred: ["Net"], direct: [], calls: ["api.get"] }, ...ofFns];
  const r = fix(cg, fns, "domain.price", "Net", parsePolicy("deny Net domain"), scopeMatches);
  assert.deepEqual(r.hoistTo, ["api.get"], "the MINIMAL frontier is unchanged");
  assert.deepEqual(r.hoistHigher, ["main.run"], "main.run is the higher hoist option");
});
test("fix: a fn that performs the effect but isn't forbidden there → crossing:false", () => {
  const r = fix(ofCg, ofFns, "api.get", "Net", parsePolicy("deny Net domain"), scopeMatches);
  assert.equal(r.crossing, false);
  assert.equal(r.reason, "not-forbidden");
});
test("fix: no such fn → null", () => {
  assert.equal(fix(ofCg, ofFns, "nope", "Net", parsePolicy("deny Net domain"), scopeMatches), null);
});
test("fix: prefers the effect-performing match among same-tier name matches", () => {
  // `save` matches a pure `cache.save` and the effectful denied `repo.save` — must resolve to the latter.
  const cg = { "cache.save": [], "repo.save": [] };
  const fns = [
    { fn: "cache.save", inferred: [], direct: [], calls: [] },
    { fn: "repo.save", inferred: ["Net"], direct: ["Net"], calls: [] },
  ];
  const r = fix(cg, fns, "save", "Net", parsePolicy("deny Net repo"), scopeMatches);
  assert.equal(r.crossing, true);
  assert.equal(r.fn, "repo.save");
});
test("fix: resolves against report fns only, not callgraph-only pure nodes", () => {
  // `helper` is in the callgraph (a pure node) but absent from the report → uniform 'no such fn' (null).
  const cg = { "app.helper": [], "app.run": [] };
  const fns = [{ fn: "app.run", inferred: ["Net"], direct: ["Net"], calls: [] }];
  assert.equal(fix(cg, fns, "helper", "Net", parsePolicy("deny Net app"), scopeMatches), null);
});
test("fix-gate: the two domain inheritors collapse to one root-independent remedy", () => {
  const r = fixGate(ofCg, ofFns, parsePolicy("deny Net domain"), scopeMatches);
  assert.equal(r.ok, false);
  assert.equal(r.remedies.length, 1);
  assert.deepEqual(r.remedies[0].deniedSpan, ["domain.bulk", "domain.price"]);
  assert.deepEqual(r.remedies[0].hoistTo, ["api.get"]);
});
test("fix: a sandwiched allowed layer is NOT a clean hoist", () => {
  // domain.top → api.mid → domain.inner → infra.fetch, deny Net domain. api.mid is the nearest allowed
  // frontier but domain.top calls it → hoisting there leaves top violating → cleanHoist false.
  const cg = { "domain.top": ["api.mid"], "api.mid": ["domain.inner"], "domain.inner": ["infra.fetch"], "infra.fetch": [] };
  const fns = [
    { fn: "domain.top", inferred: ["Net"], direct: [], calls: ["api.mid"] },
    { fn: "api.mid", inferred: ["Net"], direct: [], calls: ["domain.inner"] },
    { fn: "domain.inner", inferred: ["Net"], direct: [], calls: ["infra.fetch"] },
    { fn: "infra.fetch", inferred: ["Net"], direct: ["Net"], calls: [] },
  ];
  const r = fix(cg, fns, "inner", "Net", parsePolicy("deny Net domain"), scopeMatches);
  assert.equal(r.crossing, true);
  assert.equal(r.cleanHoist, false, "a sandwiched frontier is not a clean hoist");
});
test("unverified: flags an Unknown fn in a pure/deny scope + names the deny-Unknown upgrade", () => {
  const fns = [
    { fn: "domain.price", inferred: ["Unknown"], unknownWhy: ["callback:param#0"] },
    { fn: "domain.calc", inferred: [] }, // provably pure — not flagged
  ];
  const r = unverified(fns, parsePolicy("pure domain"), scopeMatches);
  assert.equal(r.ok, false);
  assert.equal(r.unverified.length, 1);
  assert.equal(r.unverified[0].fn, "domain.price");
  assert.equal(r.unverified[0].upgrade, "deny Unknown domain");
  // ⟨0.20⟩ --class: the hole is callback→indirect, so `indirect` keeps it, `reflect` drops it (ok:true).
  assert.equal(unverified(fns, parsePolicy("pure domain"), scopeMatches, "indirect").unverified.length, 1);
  const none = unverified(fns, parsePolicy("pure domain"), scopeMatches, "reflect");
  assert.equal(none.unverified.length, 0);
  assert.equal(none.ok, true, "no matching-class hole ⇒ ok (the class-scoped view is clean)");
});
// ⟨0.24⟩ SPEC §6.2's `--class` clause, the two halves that were both wrong here: the filter read the
// DIRECT-only `unknownWhy` (so a purely inherited hole matched nothing) and it failed OPEN on absence (so
// an unclassifiable hole was dropped by EVERY filter, including one naming its own class). The cheap
// diagnostic the spec makes normative: `--class dynamic` names every genuine class, so it must exclude
// NOTHING. Measured before the repair on three real targets: 207→173, 268→158, 64→21.
test("unverified --class ⟨0.24⟩: resolves TRANSITIVELY, fails CLOSED, and still discriminates", () => {
  const cg = { "app.inherits": ["app.src"], "app.src": [], "app.mystery": [], "app.reflectOnly": [] };
  const fns = [
    // a SOURCE: its own body has the unresolvable dispatch
    { fn: "app.src", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["dispatch:app.Base.run"] },
    // ⟨0.6⟩ direct-only: a fn that merely INHERITED the Unknown publishes no reason of its own
    { fn: "app.inherits", inferred: ["Unknown"], direct: [] },
    // a direct Unknown the producer could not name (a foreign report; candor-ts's own emitter writes
    // `["unresolved"]` here, which is the same rule one layer earlier)
    { fn: "app.mystery", inferred: ["Unknown"], direct: ["Unknown"] },
    { fn: "app.reflectOnly", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["reflect:eval"] },
  ];
  const U = (spec) => unverified(fns, parsePolicy("pure app"), scopeMatches, spec, cg).unverified.map((h) => h.fn).sort();
  // THE DIAGNOSTIC: an alias for every genuine class excludes nothing.
  assert.deepEqual(U("dynamic"), U(null), "`--class dynamic` must exclude nothing");
  assert.deepEqual(U("*"), U(null));
  // (1) TRANSITIVE: the inherited hole is scoped by its CALLEE's class …
  assert.ok(U("dispatch").includes("app.inherits"), "an inherited hole matches its callee's class");
  // (2) … and NOT by `unresolved` — the control a blanket "keep everything" fails, and the mirror
  // fabrication (tagging a correctly-classified inherited Unknown `unresolved`) that §6.2 req 3 forbids.
  assert.deepEqual(U("unresolved"), ["app.mystery"],
    "only the hole nothing in reach accounts for contributes `unresolved`");
  // (3) the filter still DISCRIMINATES — it is not "everything matches everything".
  assert.deepEqual(U("native"), []);
  assert.deepEqual(U("reflect"), ["app.reflectOnly"]);
  assert.deepEqual(U("dispatch"), ["app.inherits", "app.src"]);
  // (4) A hole whose class set cannot be resolved AT ALL (inherited from beyond this report/graph)
  // PROJECTS TO `{unresolved}` — §6.2's "CONTRIBUTES `unresolved`", which is NOT "kept by every filter".
  // It is kept by the two filters an adopter narrows THROUGH and dropped by the four that would name a
  // class the engine has no evidence for; `setup` especially, since `dynamic` excludes it as non-genuine.
  const orphan = [{ fn: "app.orphan", inferred: ["Unknown"], direct: [] }];
  const orphanU = (c) => unverified(orphan, parsePolicy("pure app"), scopeMatches, c, {}).unverified.map((h) => h.fn);
  for (const c of ["unresolved", "dynamic", "*"])
    assert.deepEqual(orphanU(c), ["app.orphan"], `an unclassifiable hole is kept by --class ${c}`);
  for (const c of ["native", "reflect", "dispatch", "indirect", "setup"])
    assert.deepEqual(orphanU(c), [], `an unclassifiable hole must NOT be asserted into --class ${c}`);
  // (5) …and `blindspots` shares the FLAG, not this behaviour (§6.2 req 0). It is the SOURCE view, so the
  // inherited unit is not an entry at all and the direct-only read is CORRECT there. Measured on three
  // real targets: `blindspots --class dynamic` already excluded nothing (237/190/55, unchanged).
  const bs = (spec) => blindspots(fns, cg, spec).sources.map((s) => s.fn).sort();
  assert.ok(!bs(null).includes("app.inherits"), "blindspots excludes a purely inherited Unknown");
  assert.deepEqual(bs("dynamic"), bs(null), "blindspots --class dynamic excludes nothing either");
  assert.deepEqual(bs("dispatch"), ["app.src"], "…and stays the direct-reason SOURCE view");
});
// ⟨0.24⟩ SPEC §6.2's VALUE GRAMMAR for the flag itself. The parser is the single choke point — every verb
// that takes `--class` reaches the filter through here — so the grammar is pinned at the function boundary
// and again end to end (test.mjs CLI-10) for the flag-level rule the parser cannot see (repetition).
// WHY REFUSE, when the policy side drops-with-a-warning: a dropped token there leaves a WIDER rule (it
// still fires, on more), whereas a dropped token here leaves a NARROWER filter — `--class dyanmic` used to
// answer a question nobody asked with a SMALLER number at exit 0, unreadable from a genuine all-clear.
test("parseClassFilter ⟨0.24⟩: the §6.2 value grammar — six classes + 2 aliases, an unknown token REFUSED", () => {
  const S = (spec) => [...parseClassFilter(spec)].sort();
  // (1) a valid single token, and (2) a valid comma list (whitespace + a trailing comma are separators)
  assert.deepEqual(S("reflect"), ["reflect"]);
  assert.deepEqual(S("reflect,native"), ["native", "reflect"]);
  assert.deepEqual(S(" reflect , native ,"), ["native", "reflect"]);
  // (3) BOTH aliases are accepted — `dynamic` is what the normative §6.2 diagnostic every engine carries
  // passes, so rejecting it would break that standing test; `*` is every class INCLUDING setup.
  assert.deepEqual(S("dynamic"), ["dispatch", "indirect", "native", "reflect", "unresolved"]);
  assert.deepEqual(S("*"), ["dispatch", "indirect", "native", "reflect", "setup", "unresolved"]);
  assert.deepEqual(S("setup"), ["setup"], "`setup` is a class in its own right (excluded only from `dynamic`)");
  assert.equal(parseClassFilter(null), null, "no spec ⇒ no filter, not an empty one");
  // (4) an UNRECOGNISED token is a usage error, and the message NAMES it and lists the accepted set — the
  // assertion that separates "refused for the right reason" from "refused because something else broke".
  let err = null;
  try { parseClassFilter("dyanmic"); } catch (e) { err = e; }
  assert.ok(err instanceof ClassFilterError, `an unknown token must throw ClassFilterError, got ${err}`);
  assert.match(err.message, /`dyanmic`/, "the message names the offending token");
  assert.match(err.message, /reflect,dispatch,indirect,native,unresolved,setup/, "…and lists the six classes");
  assert.match(err.message, /dynamic,\*/, "…and both aliases");
  // (5) one bad token poisons the WHOLE list — the failure mode being closed is the PARTIAL honour, where
  // `reflect,dyanmic` quietly became `{reflect}` and reported less than either token asked for.
  assert.throws(() => parseClassFilter("reflect,dyanmic"), ClassFilterError);
  assert.throws(() => parseClassFilter("Reflect"), ClassFilterError, "the vocabulary is case-SENSITIVE");
  // (6) THE REGRESSION CONTROL: well-formed input selects exactly what it selected before. Counts, not
  // just exit codes — this change must alter no selection and no verdict for input it accepts.
  const cg = { "app.inherits": ["app.src"], "app.src": [], "app.reflectOnly": [] };
  const fns = [
    { fn: "app.src", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["dispatch:app.Base.run"] },
    { fn: "app.inherits", inferred: ["Unknown"], direct: [] },
    { fn: "app.reflectOnly", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["reflect:eval"] },
  ];
  const nb = (spec) => blindspots(fns, cg, spec).sources.length;
  const nu = (spec) => unverified(fns, parsePolicy("pure app"), scopeMatches, spec, cg).unverified.length;
  assert.deepEqual([nb(null), nb("dynamic"), nb("*"), nb("reflect"), nb("reflect,dispatch"), nb("native")],
    [2, 2, 2, 1, 2, 0], "blindspots selection by class, unchanged");
  assert.deepEqual([nu(null), nu("dynamic"), nu("*"), nu("reflect"), nu("reflect,dispatch"), nu("native")],
    [3, 3, 3, 1, 3, 0], "unverified selection by class, unchanged");
});
// The gate and the disclosure now run the SAME resolution (SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST
// APPLY THE SAME RULE, AND SHOULD SHARE THE SAME CODE") — pin the shared function's own contract.
test("resolveReasonClasses ⟨0.24⟩: CONTRIBUTES at the node, never keyed on the joined set being empty", () => {
  // The three-row counterexample to the monotone-denial corollary. Under a rule keyed on ABSENCE, `both`
  // — which calls a reasonless dep AND a reasoned one, so it knows strictly LESS than `oneReasonless` —
  // came out {dispatch} and PASSED `Unknown[unresolved]` where `oneReasonless` was rejected.
  const fns = [
    { fn: "dep.reasonless", inferred: ["Unknown"], direct: ["Unknown"] },
    { fn: "dep.reasoned", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["dispatch:d.Base.run"] },
    { fn: "app.oneReasonless", inferred: ["Unknown"], direct: [] },
    { fn: "app.oneReasoned", inferred: ["Unknown"], direct: [] },
    { fn: "app.both", inferred: ["Unknown"], direct: [] },
  ];
  const cg = {
    "app.oneReasonless": ["dep.reasonless"], "app.oneReasoned": ["dep.reasoned"],
    "app.both": ["dep.reasonless", "dep.reasoned"], "dep.reasonless": [], "dep.reasoned": [],
  };
  const acc = resolveReasonClasses(fns, cg);
  const classesOf = (fn) => [...(acc.get(fn) ?? [])].sort();
  assert.deepEqual(classesOf("app.oneReasonless"), ["unresolved"]);
  assert.deepEqual(classesOf("app.oneReasoned"), ["dispatch"]);
  assert.deepEqual(classesOf("app.both"), ["dispatch", "unresolved"],
    "a class set may only GROW as more is learned — acquiring a reason must not REMOVE `unresolved`");
  // …so the verdict is monotone: row 3 knows less than row 1 and must not pass where row 1 is rejected.
  const denied = (fn) => evaluatePolicy(parsePolicy("deny Unknown[unresolved]"), fns, cg).some((v) => v.fn === fn);
  assert.equal(denied("app.oneReasonless"), true);
  assert.equal(denied("app.both"), true, "adding a call must never turn a red verdict green");
  assert.equal(denied("app.oneReasoned"), false, "…and a classified hole is still out of scope");
});
// ⟨0.24⟩ THE TEST THE PREVIOUS ROUND COULD NOT WRITE. The control above it (`app.mystery`) carries
// `direct: ["Unknown"]`, so it exercises the CONTRIBUTION arm — the class set is `{unresolved}` before the
// match is ever consulted, and the EMPTY-set arm is never constructed. Everything about the empty set was
// therefore untested, and it read `return true`: an unclassifiable hole matched EVERY filter, including
// `native` and `setup`. Two ways to build the empty set, both from real reports, both run four-way by an
// adversarial reviewer on identical bytes:
//   (a) an ORPHAN CALLEE — the Unknown is inherited from a fn absent from the report;
//   (b) NO CALLGRAPH SIDECAR — the reach could not be walked, so even a correctly-classified inherited
//       hole came back empty and `--class unresolved` selected it, the literal outcome §6.2 req 3 forbids.
// Measured before the repair, `--class native` on (a): rust [] java [] swift [] ts ['app.orphan'].
test("unverified --class ⟨0.24⟩: the EMPTY class set projects to `unresolved`, and the reach is the REPORT's", () => {
  // A `dispatch:`-classified source, one caller that inherits from it, one caller whose callee is not in
  // the report at all. The §2 `calls` field is present — it is the reach rust/java/swift resolve over.
  const fns = [
    { fn: "app.src", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["dispatch:app.Base.run"], calls: [] },
    { fn: "app.inherits", inferred: ["Unknown"], direct: [], calls: ["app.src"] },
    { fn: "app.orphan", inferred: ["Unknown"], direct: [], calls: ["app.gone"] },
  ];
  const sidecar = { "app.src": [], "app.inherits": ["app.src"], "app.orphan": ["app.gone"] };
  const U = (c, cg) => unverified(fns, parsePolicy("pure app"), scopeMatches, c, cg).unverified.map((h) => h.fn).sort();
  for (const [what, cg] of [["with the sidecar", sidecar], ["with NO sidecar", {}]]) {
    // (1) the inherited hole is classified by its callee — and NOT swept into `unresolved`/`native`.
    assert.deepEqual(U("dispatch", cg), ["app.inherits", "app.src"], `dispatch, ${what}`);
    assert.deepEqual(U("unresolved", cg), ["app.orphan"], `unresolved, ${what}`);
    assert.deepEqual(U("native", cg), [], `native, ${what}`);
    // (2) `setup` is the sharpest form: `dynamic` EXCLUDES it, so a hole matching it because nothing
    // classified it is doubly wrong.
    assert.deepEqual(U("setup", cg), [], `setup, ${what}`);
    // (3) the projection is `{unresolved}`, so the alias that names every genuine class still excludes
    // nothing — the §6.2 diagnostic every engine carries.
    assert.deepEqual(U("dynamic", cg), U(null, cg), `--class dynamic excludes nothing, ${what}`);
  }
  // (4) BYTE-IDENTICAL with and without the sidecar — the property rust/java/swift have because they
  // resolve over the entries' own `calls`. candor-ts read `<prefix>.callgraph.json` and nothing else, so
  // a deleted/never-written sidecar silently degraded to a direct-only resolution and (1) collapsed.
  for (const c of [null, "dispatch", "unresolved", "native", "setup", "dynamic", "*"])
    assert.deepEqual(U(c, sidecar), U(c, {}), `--class ${c} must not depend on the sidecar`);
  // (5) THE GATE ARM, which shares this match: `deny E Unknown[reflect]` must not fire on a function
  // whose class set is empty. Reachable in the shipped product — the MCP `candor_gate` tool and the LSP
  // both run evaluatePolicy over a LOADED report, which may be foreign or hand-authored. Verified by a
  // run over the real MCP stdio transport, not by inspection.
  const fires = (rule) => evaluatePolicy(parsePolicy(rule), fns, {}).map((v) => v.fn).sort();
  assert.deepEqual(fires("deny Unknown[reflect] app"), [], "an empty class set is not a reflect hole");
  assert.deepEqual(fires("deny Unknown[setup] app"), [], "…nor a setup one");
  assert.deepEqual(fires("deny Unknown[unresolved] app"), ["app.orphan"], "…it IS an unresolved one");
  assert.deepEqual(fires("deny Unknown[dynamic] app"), ["app.inherits", "app.orphan", "app.src"],
    "…and `dynamic` still catches every genuine hole — the fail-closed direction is intact");
});
test("fix-gate: no crossing → ok:true, empty remedies", () => {
  const r = fixGate(ofCg, ofFns, parsePolicy("deny Net nonesuch"), scopeMatches);
  assert.equal(r.ok, true);
  assert.deepEqual(r.remedies, []);
});

// ── query-core: loader robustness (never crash, never fabricate, disclose) ────────────────────────
test("loadReport/loadCallgraph tolerate corrupt + malformed input", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-unit-"));
  // corrupt primary report → [] (disclosed on stderr, not a thrown stack)
  fs.writeFileSync(path.join(d, "corrupt.json"), "{ this is not json");
  assert.deepEqual(loadReport(path.join(d, "corrupt")), []);
  // a non-array `inferred` ("Net") must be coerced to [], never iterated into {N,e,t}
  fs.writeFileSync(path.join(d, "bad.json"), JSON.stringify({
    functions: [{ fn: "f", inferred: "Net", direct: ["Fs"] }, { nofn: true }, 42],
  }));
  const fns = loadReport(path.join(d, "bad"));
  assert.equal(fns.length, 1);          // the fn-less entry + the primitive are dropped
  assert.deepEqual(fns[0].inferred, []); // string coerced to [], no fabricated {N,e,t}
  // a null callgraph must coerce to {} (not throw on Object.entries(null))
  fs.writeFileSync(path.join(d, "n.callgraph.json"), "null");
  assert.deepEqual(loadCallgraph(path.join(d, "n")), {});
  fs.rmSync(d, { recursive: true, force: true });
});
test("isReport: a callgraph/ledger/calibrated sibling is not a report", () => {
  assert.equal(isReport("p.foo.scan.json"), true);
  assert.equal(isReport("p.foo.callgraph.json"), false);
  assert.equal(isReport("p.encountered-crates.json"), false);
  assert.equal(isReport("p.calibrated.json"), false);
});

// ── query-core: loadHierarchy (the ⟨0.7⟩ sidecar loader — was never executed by any suite) ─────────
test("loadHierarchy: exact sidecar, uninterpretable keys DROPPED, corrupt → {}, absent → {}", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  // The exact `<prefix>.hierarchy.json` form. A non-array value is DROPPED, not coerced to `[]` and
  // kept: a kept key is a PHANTOM TYPE no code declares, and `callersFrontier` counts keys.
  fs.writeFileSync(path.join(d, "r.hierarchy.json"),
    JSON.stringify({ "m.Impl": ["m.Base"], "m.Odd": "not-an-array" }));
  assert.deepEqual(loadHierarchy(path.join(d, "r")), { "m.Impl": ["m.Base"] });
  // …and the `@` extension namespace (SPEC §2.2) goes the same way, whatever shape it carries. The real
  // one is candor-java's `"@superclass"` (`bb8459a`, an OBJECT; flattened to an array in `403f24b`).
  fs.writeFileSync(path.join(d, "x.hierarchy.json"),
    JSON.stringify({ "m.Impl": ["m.Base"], "@superclass": { "m.Impl": "m.Base" } }));
  assert.deepEqual(loadHierarchy(path.join(d, "x")), { "m.Impl": ["m.Base"] });
  // …including the array-valued spelling, which type-coercion alone would have let through.
  fs.writeFileSync(path.join(d, "y.hierarchy.json"),
    JSON.stringify({ "m.Impl": ["m.Base"], "@superclass": ["m.Impl", "m.Base"] }));
  assert.deepEqual(loadHierarchy(path.join(d, "y")), { "m.Impl": ["m.Base"] });
  // A sidecar carrying ONLY metadata is exactly an ABSENT one — the row that makes it a disclosure fix
  // rather than a tidy-up, since `hasHier` reads emptiness.
  fs.writeFileSync(path.join(d, "z.hierarchy.json"), JSON.stringify({ "@superclass": ["m.Impl"] }));
  assert.deepEqual(loadHierarchy(path.join(d, "z")), {});
  // corrupt JSON → {} (tolerate — the frontier falls back to the safe over-listing direction)
  fs.writeFileSync(path.join(d, "c.hierarchy.json"), "{ not json");
  assert.deepEqual(loadHierarchy(path.join(d, "c")), {});
  // a non-object parse (null) → {}
  fs.writeFileSync(path.join(d, "n.hierarchy.json"), "null");
  assert.deepEqual(loadHierarchy(path.join(d, "n")), {});
  // absent entirely → {}
  assert.deepEqual(loadHierarchy(path.join(d, "missing")), {});
  fs.rmSync(d, { recursive: true, force: true });
});
test("loadHierarchy: multi-report SIBLINGS merge (the workspace form), corrupt sibling tolerated", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  fs.writeFileSync(path.join(d, "r.a.scan.hierarchy.json"), JSON.stringify({ "a.Impl": ["a.Base"] }));
  fs.writeFileSync(path.join(d, "r.b.scan.hierarchy.json"), JSON.stringify({ "b.Impl": ["b.Base"] }));
  fs.writeFileSync(path.join(d, "r.c.scan.hierarchy.json"), "{ corrupt");
  assert.deepEqual(loadHierarchy(path.join(d, "r")), { "a.Impl": ["a.Base"], "b.Impl": ["b.Base"] });
  fs.rmSync(d, { recursive: true, force: true });
});
test("loadHierarchy → callersFrontier: a loaded sidecar actually drives the subtype filter", () => {
  // The wiring pin: hierarchy from DISK (not a hand object) rules the unrelated dispatch out and the
  // genuine override in — the loader and the frontier agree on shape.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  fs.writeFileSync(path.join(d, "r.hierarchy.json"), JSON.stringify({ "m.Impl": ["m.Base"] }));
  const hier = loadHierarchy(path.join(d, "r"));
  const cg = { "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [], "m.Go.go": [] };
  const fns = [{ fn: "m.Go.go", unknownWhy: ["dispatch:m.Base.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  assert.deepEqual(callersFrontier(cg, fns, hier, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Go.go", viaDispatchOn: "run" }]);
  const fns2 = [{ fn: "m.Go.go", unknownWhy: ["dispatch:m.Elsewhere.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  assert.deepEqual(callersFrontier(cg, fns2, hier, "m.Sink.touch").possibleViaUnknownDispatch, []);
  fs.rmSync(d, { recursive: true, force: true });
});
test("loadHierarchy → callersFrontier: a DOT-FREE dispatch detail is disclosed, not dropped ⟨0.24⟩", () => {
  // §3.1 ⟨0.24⟩: a `dispatch:` detail with no dot names no OWNER, so condition (3) ("is a confirmed
  // reacher an override of OWNER.M?") is UNANSWERABLE — and an unanswerable condition is not a failed one.
  // MEASURED here before the fix, through this same disk-loaded path: the frontier held only the dotted
  // entry in BOTH arms, with no diagnostic. Same shape as the CLI (`callers --include-unknown`), which is
  // where the drop was seen. The controls (no-reason fn, unrelated-owner fn) are what prove the widening
  // is not a blanket.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  fs.writeFileSync(path.join(d, "r.hierarchy.json"), JSON.stringify({ "m.Impl": ["m.Base"] }));
  const hier = loadHierarchy(path.join(d, "r"));
  const cg = { "m.Impl.handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Dotted.go": [], "m.Untyped.go": [], "m.Unrelated.go": [], "m.NoReason.go": [] };
  const raw = "untyped cross-package receiver";   // candor-rust's dot-free detail
  const fns = [
    { fn: "m.Impl.handle", unknownWhy: [] },
    { fn: "m.Dotted.go", unknownWhy: ["dispatch:m.Base.handle"] },      // condition (3) HOLDS
    { fn: "m.Untyped.go", unknownWhy: [`dispatch:${raw}`] },            // UNANSWERABLE → disclose
    { fn: "m.Unrelated.go", unknownWhy: ["dispatch:m.Elsewhere.handle"] }, // condition (3) FAILS → out
    { fn: "m.NoReason.go", unknownWhy: [] },                            // no dispatch reason → out
  ];
  // Hierarchy arm: exactly the answerable-and-true entry plus the unanswerable one.
  assert.deepEqual(callersFrontier(cg, fns, hier, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Dotted.go", viaDispatchOn: "handle" }, { fn: "m.Untyped.go", viaDispatchOn: raw }]);
  // No-hierarchy arm: over-lists by simple name (so `m.Unrelated.go` joins, per the documented fallback)
  // and the dot-free entry is disclosed there too — the drop was in BOTH arms.
  assert.deepEqual(callersFrontier(cg, fns, {}, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Dotted.go", viaDispatchOn: "handle" }, { fn: "m.Unrelated.go", viaDispatchOn: "handle" },
      { fn: "m.Untyped.go", viaDispatchOn: raw }]);
  // The ARM-DEPENDENT shape: a dot-free detail equal to a DOTTED reacher's SIMPLE METHOD name. The split
  // helpers fall back to the whole string, so `handle` became BOTH owner and member: the by-method lookup
  // hit (no-hierarchy arm disclosed it) and the subtype test then ran with a non-type string as owner
  // (hierarchy arm dropped it). MEASURED pre-fix through the CLI: no-hier `[{m.Row3.go,handle}]`, hier
  // `[]` — the SAME report answered two ways by whether this sidecar file exists. Asserted as arm
  // EQUALITY, because the disagreement was the defect.
  const cg3 = { "m.Impl.handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Row3.go": [] };
  const fns3 = [{ fn: "m.Row3.go", unknownWhy: ["dispatch:handle"] }, { fn: "m.Impl.handle", unknownWhy: [] }];
  assert.deepEqual(callersFrontier(cg3, fns3, hier, "m.Sink.touch").possibleViaUnknownDispatch,
    callersFrontier(cg3, fns3, {}, "m.Sink.touch").possibleViaUnknownDispatch);
  assert.deepEqual(callersFrontier(cg3, fns3, hier, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Row3.go", viaDispatchOn: "handle" }]);
  fs.rmSync(d, { recursive: true, force: true });
});
test("loadHierarchy → callersFrontier: ABSENT ≡ EMPTY sidecar, and neither collapses the frontier ⟨0.24⟩", () => {
  // §3.1 ⟨0.24⟩: an empty §2.2 sidecar and an absent one are the SAME INPUT — both mean "the subtype test
  // is unanswerable", which means OVER-LIST, not drop. Reading `{}` as the positive claim "no type has a
  // supertype" would score condition (3) as FAILED for every dotted source at once and collapse the
  // frontier to `[]` — measured in candor-java, where it took the WORKING dotted entries with it. Pinned
  // as the three-arm triple the frontier engines share: absent ≡ `{}` (over-list) vs populated (precise).
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  fs.writeFileSync(path.join(d, "empty.hierarchy.json"), "{}");
  const absent = loadHierarchy(path.join(d, "nosuch")), empty = loadHierarchy(path.join(d, "empty"));
  fs.writeFileSync(path.join(d, "full.hierarchy.json"), JSON.stringify({ "m.Impl": ["m.Base"] }));
  const full = loadHierarchy(path.join(d, "full"));
  const cg = { "m.Impl.handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Ok.go": [], "m.Unrelated.go": [] };
  const fns = [
    { fn: "m.Ok.go", unknownWhy: ["dispatch:m.Base.handle"] },          // condition (3) HOLDS under `full`
    { fn: "m.Unrelated.go", unknownWhy: ["dispatch:m.Elsewhere.handle"] }, // condition (3) FAILS under `full`
    { fn: "m.Impl.handle", unknownWhy: [] },
  ];
  const at = (h) => callersFrontier(cg, fns, h, "m.Sink.touch").possibleViaUnknownDispatch;
  // absent ≡ empty, and BOTH over-list (the unrelated owner is admitted, the working entry is KEPT).
  assert.deepEqual(at(empty), at(absent));
  assert.deepEqual(at(empty), [{ fn: "m.Ok.go", viaDispatchOn: "handle" }, { fn: "m.Unrelated.go", viaDispatchOn: "handle" }]);
  assert.notDeepEqual(at(empty), []);   // the collapse java measured
  // populated: precise — the unrelated owner drops out, the genuine override stays.
  assert.deepEqual(at(full), [{ fn: "m.Ok.go", viaDispatchOn: "handle" }]);
  fs.rmSync(d, { recursive: true, force: true });
});
test("loadHierarchy → callersFrontier: a METADATA key cannot narrow the frontier", () => {
  // `callersFrontier` gates on `Object.keys(hierarchy).length > 0`, so a key the loader keeps but cannot
  // interpret is not inert: it takes the frontier off the documented over-listing fallback and onto the
  // precise subtype test over a hierarchy that answers nothing. Both directions, because the fix is a
  // WIDENING and the row that must not move is the one with a real type in it.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  const cg = { "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [], "m.Go.go": [] };
  const unrelated = [{ fn: "m.Go.go", unknownWhy: ["dispatch:m.Elsewhere.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  const genuine = [{ fn: "m.Go.go", unknownWhy: ["dispatch:m.Base.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];

  // NO-CHANGE DIRECTION FIRST. A real type beside the metadata key: the subtype test still rules the
  // unrelated owner out and admits the genuine override, exactly as without the metadata key.
  fs.writeFileSync(path.join(d, "both.hierarchy.json"),
    JSON.stringify({ "m.Impl": ["m.Base"], "@superclass": { "m.Impl": "m.Base" } }));
  const both = loadHierarchy(path.join(d, "both"));
  assert.deepEqual(callersFrontier(cg, unrelated, both, "m.Sink.touch").possibleViaUnknownDispatch, []);
  assert.deepEqual(callersFrontier(cg, genuine, both, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Go.go", viaDispatchOn: "run" }]);

  // THE DEFECT. A sidecar carrying ONLY metadata must behave exactly as an ABSENT one — which over-lists,
  // and over-listing is the direction a "cannot confirm" disclosure is allowed to be wrong in. Kept as a
  // phantom this returned `[]`: a reacher silently dropped from the frontier by a key about bookkeeping.
  fs.writeFileSync(path.join(d, "meta.hierarchy.json"), JSON.stringify({ "@superclass": ["m.Impl", "m.Base"] }));
  const meta = loadHierarchy(path.join(d, "meta"));
  assert.deepEqual(meta, {});
  assert.deepEqual(callersFrontier(cg, unrelated, meta, "m.Sink.touch").possibleViaUnknownDispatch,
    callersFrontier(cg, unrelated, {}, "m.Sink.touch").possibleViaUnknownDispatch);
  assert.deepEqual(callersFrontier(cg, unrelated, meta, "m.Sink.touch").possibleViaUnknownDispatch,
    [{ fn: "m.Go.go", viaDispatchOn: "run" }]);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── query-core: blindspots ranking over real unknownWhy sources (the ⟨0.6⟩ shape) ──────────────────
// Conformance owns cross-engine agreement; THIS pins the repo's own ranking loop (TESTING.md §3):
// sources are the fns carrying their OWN unknownWhy, ranked by transitive blast radius, ties by name.
test("blindspots: sources ranked by Unknown blast radius, exact reaches/affected, totalUnknown", () => {
  const fns = [
    { fn: "m.wide", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },     // reached by two callers
    { fn: "m.narrow", inferred: ["Unknown"], unknownWhy: ["dispatch:m.B.x"] }, // reached by one
    { fn: "m.mid", inferred: ["Unknown"] },                                    // transitive-only: NOT a source
    { fn: "m.top", inferred: ["Unknown"] },
  ];
  const cg = { "m.top": ["m.mid"], "m.mid": ["m.wide"], "m.one": ["m.narrow", "m.wide"], "m.wide": [], "m.narrow": [] };
  const r = blindspots(fns, cg);
  assert.equal(r.totalUnknown, 4);
  assert.deepEqual(r.sources.map((s) => s.fn), ["m.wide", "m.narrow"]); // most-smearing first; no transitive-only source
  assert.equal(r.sources[0].reaches, 3);
  assert.deepEqual(r.sources[0].affected, ["m.mid", "m.one", "m.top"]);
  assert.deepEqual(r.sources[0].why, ["reflect:eval"]);
  assert.deepEqual(r.sources[1], { fn: "m.narrow", why: ["dispatch:m.B.x"], reaches: 1, affected: ["m.one"] });
});
test("blindspots --stats: reason-class distribution over the Unknown sources (⟨0.20⟩)", () => {
  const fns = [
    { fn: "m.a", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },
    { fn: "m.b", inferred: ["Unknown"], unknownWhy: ["reflect:require", "callback:cb"] }, // two classes → both count
    { fn: "m.c", inferred: ["Unknown"], unknownWhy: ["no-node_modules:left-pad"] },       // setup
    { fn: "m.d", inferred: ["Unknown"] },  // transitive-only → NOT a source
  ];
  const r = blindspotsStats(fns);
  assert.deepEqual(Object.keys(r.byClass), ["reflect", "dispatch", "indirect", "native", "unresolved", "setup"]);
  assert.equal(r.byClass.reflect, 2);   // m.a + m.b
  assert.equal(r.byClass.indirect, 1);  // m.b's callback
  assert.equal(r.byClass.setup, 1);     // m.c
  assert.equal(r.sources, 3);           // m.a/m.b/m.c carry a direct reason; m.d is transitive-only
  assert.equal(r.totalUnknown, 4);
  // --class filter: reflect → m.a + m.b (m.b has reflect+indirect); setup → m.c only; dynamic excludes setup
  assert.equal(blindspotsStats(fns, "reflect").sources, 2);
  assert.equal(blindspotsStats(fns, "setup").sources, 1);
  assert.equal(blindspotsStats(fns, "dynamic").sources, 2, "dynamic excludes setup → m.a + m.b, not m.c");
  const cg = { "m.a": [], "m.b": [], "m.c": [], "m.d": [] };
  assert.deepEqual(blindspots(fns, cg, "setup").sources.map((s) => s.fn), ["m.c"]); // drill-down to the setup source
});
test("blindspots: equal blast radii tie-break by name (stable worklist order)", () => {
  const fns = [
    { fn: "m.b", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },
    { fn: "m.a", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },
  ];
  const r = blindspots(fns, { "m.a": [], "m.b": [] });
  assert.deepEqual(r.sources.map((s) => s.fn), ["m.a", "m.b"]);
});

// ── policy: discoverConfigPolicy terminates at the filesystem root (no config anywhere up-tree) ────
test("discoverConfigPolicy: a dir with no .candor/config up to / returns null (clean no-config)", () => {
  // The walk-to-root termination arm never ran under any suite. A fresh temp dir's ancestors are
  // system dirs; if this ever finds a config, the TEST ENVIRONMENT is polluted — that should be loud.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-noconf-"));
  assert.equal(discoverConfigPolicy(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});
test("discoverConfigPolicy: a config WITHOUT a `policy` key is null, not a crash", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-nopol-"));
  fs.mkdirSync(path.join(d, ".candor"));
  fs.writeFileSync(path.join(d, ".candor", "config"), "strict 1\n# just a comment\n");
  assert.equal(discoverConfigPolicy(d), null);
  // and the happy path from a NESTED dir: the walk finds the repo's config and anchors to its root
  fs.writeFileSync(path.join(d, ".candor", "config"), "policy arch.policy\n");
  fs.mkdirSync(path.join(d, "src", "deep"), { recursive: true });
  assert.deepEqual(discoverConfigPolicy(path.join(d, "src", "deep")),
    { policyPath: path.join(d, "arch.policy"), repoRoot: d });
  fs.rmSync(d, { recursive: true, force: true });
});

// ── policy: the DSL grammar (positional, mirroring the Rust/JVM parsers) ───────────────────────────
test("parsePolicy: deny is POSITIONAL — first non-effect token ends the effect list (= scope)", () => {
  const p = parsePolicy("deny Net foo Db");
  assert.deepEqual(p.deny, [{ effects: ["Net"], scope: "foo", unknownClasses: [], netClasses: [], raw: "deny Net foo Db" }]); // Db NOT captured
});
test("parsePolicy: pure → an empty-effect deny (any effect forbidden)", () => {
  assert.deepEqual(parsePolicy("pure svc").deny, [{ effects: [], scope: "svc", unknownClasses: [], netClasses: [], raw: "pure svc" }]);
});
test("parsePolicy: allow with `in <scope>` and values", () => {
  assert.deepEqual(parsePolicy("allow Net in api a.com b.com").allow,
    [{ effect: "Net", scope: "api", values: ["a.com", "b.com"], raw: "allow Net in api a.com b.com" }]);
});
test("parsePolicy: forbid needs a standalone `->` token", () => {
  assert.deepEqual(parsePolicy("forbid web -> db").forbid, [{ from: "web", to: "db", raw: "forbid web -> db" }]);
  assert.deepEqual(parsePolicy("forbid web->db").forbid, []); // glued arrow is malformed → dropped
});
test("parsePolicy: comments stripped, blank lines + malformed rules dropped", () => {
  const p = parsePolicy("deny Fs   # trailing comment\n\n  \ndeny\ngarbage line\nUnknown");
  assert.deepEqual(p.deny, [{ effects: ["Fs"], scope: "", unknownClasses: [], netClasses: [], raw: "deny Fs" }]); // bare `deny`, `garbage`, `Unknown` all dropped
});
test("parsePolicy: dedups repeated tokens (a set, matching rust/java)", () => {
  // ts kept `deny Net Net` → [Net,Net] while rust/java dedup — a canonical-form divergence (adversarial review)
  assert.deepEqual(parsePolicy("deny Net Net").deny[0].effects, ["Net"]);
  assert.deepEqual(parsePolicy("allow Net api api").allow[0].values, ["api"]);
});
test("EFFECTS: the §1 vocabulary", () => {
  assert.ok(EFFECTS.includes("Net") && EFFECTS.includes("Clipboard") && EFFECTS.includes("Llm")
    && EFFECTS.length === 11); // ⟨0.13⟩ added Llm
});

// ── policy: scope matching + the per-effect literal matchers ──────────────────────────────────────
test("scopeMatches: segment-prefix match, bounded by name length", () => {
  assert.equal(scopeMatches("a.b.foo", "b"), true);
  assert.equal(scopeMatches("svc.handler", "svc.handler"), true);
  assert.equal(scopeMatches("a.b", "x"), false);
  assert.equal(scopeMatches("a", "a.b.c"), false); // scope longer than name
});
test("scopeMatches: `::` scope segments match `.`-qualified names (cross-engine shared policy)", () => {
  // Rust/Java qualify with `::`; a shared policy authored with `::` must NOT be inert in TS.
  assert.equal(scopeMatches("svc.handler", "svc::handler"), true);
  assert.equal(scopeMatches("a.b.foo", "a::b"), true);
  assert.equal(scopeMatches("a.b.foo", "foo::b"), false); // segment ORDER still matters
  // a `::`-qualified NAME also splits, so a `.` policy scope matches it (both directions)
  assert.equal(scopeMatches("crate::mod::place", "mod.place"), true);
});
test("hostPart: strips :port but preserves IPv6", () => {
  assert.equal(hostPart("api.example.com:8080"), "api.example.com");
  assert.equal(hostPart("[::1]:5432"), "::1");      // bracketed ipv6 + port
  assert.equal(hostPart("2001:db8::1"), "2001:db8::1"); // bare ipv6, no port to strip
});
test("cmdBase: program basename only", () => {
  assert.equal(cmdBase("/usr/bin/curl -X POST"), "curl");
  assert.equal(cmdBase("psql"), "psql");
});
test("pathCovered: prefix-cover, abs/rel must agree, `..` never covers", () => {
  assert.equal(pathCovered("/etc", "/etc/passwd"), true);
  assert.equal(pathCovered("/etc", "/var/log"), false);
  assert.equal(pathCovered("/a", "/a/../b"), false); // traversal in the reached path
  assert.equal(pathCovered("etc", "/etc/passwd"), false); // rel allow vs abs reach
});
test("tableCovered: exact or `schema.*` prefix, case-insensitive", () => {
  assert.equal(tableCovered("users", "USERS"), true);
  assert.equal(tableCovered("public.*", "public.orders"), true);
  assert.equal(tableCovered("users", "orders"), false);
});
test("literalAllowed: dispatches to the per-effect matcher", () => {
  assert.equal(literalAllowed("Net", "api.example.com:443", ["api.example.com"]), true);
  assert.equal(literalAllowed("Fs", "/etc/passwd", ["/etc"]), true);
  assert.equal(literalAllowed("Exec", "/bin/sh", ["sh"]), true);
  assert.equal(literalAllowed("Db", "public.orders", ["public.*"]), true);
  assert.equal(literalAllowed("Net", "evil.com", ["good.com"]), false);
});

// ── scan-core: the κ classifier (the cardinal-sin surface) ────────────────────────────────────────
test("kappa: classifies the curated module/verb surface", () => {
  assert.equal(kappa("fs", "readFileSync"), "Fs");
  assert.equal(kappa("node:fs", "writeFile"), "Fs");
  assert.equal(kappa("net", "connect"), "Net");
  assert.equal(kappa("dns", "resolve"), "Net");       // DNS resolution is network I/O
  assert.equal(kappa("node:dns", "lookup"), "Net");
  assert.equal(kappa("node:dns/promises", "resolve4"), "Net");
  assert.equal(kappa("fs/promises", "readFile"), "Fs");       // the modern Fs API (subpath module)
  assert.equal(kappa("node:fs/promises", "writeFile"), "Fs");
  assert.equal(kappa("crypto", "getRandomValues"), "Rand");   // Web-Crypto CSPRNG, not `random`-prefixed
  assert.equal(kappa("os", "userInfo"), "Env");               // OS user identity
  assert.equal(kappa("node:os", "hostname"), "Env");          // machine name
  assert.equal(kappa("child_process", "exec"), "Exec");
  assert.equal(kappa("pg", "query"), "Db");
  assert.equal(kappa("crypto", "randomBytes"), "Rand");
});
test("kappa: the precision carve-outs (never fabricate)", () => {
  assert.equal(kappa("net", "isIP"), null);          // a pure string validator, not Net (the node-fetch fab)
  assert.equal(kappa("net", "new"), null);           // construction is inert
  assert.equal(kappa("dns", "getServers"), null);    // in-process config read, no network (no fab)
  assert.equal(kappa("dns", "setServers"), null);    // config write, no network
  assert.equal(kappa("os", "platform"), null);       // inert host introspection, not Env (no fab)
  assert.equal(kappa("crypto", "createHash"), null); // not the entropy surface
  assert.equal(kappa("node:dns", "new"), null);      // `new dns.Resolver()` is inert
  assert.equal(kappa("typeorm", "createQueryBuilder"), null); // a builder, not the I/O verb
  assert.equal(kappa("typeorm", "initialize"), "Db");    // DataSource.initialize() OPENS the pool — real Db I/O
  assert.equal(kappa("typeorm", "connect"), "Db");       // legacy Connection.connect() — opens the connection
  assert.equal(kappa("typeorm", "synchronize"), "Db");   // runs schema DDL against the server
  assert.equal(kappa("typeorm", "runMigrations"), "Db"); // executes migration SQL
  assert.equal(kappa("typeorm", "getMetadata"), null);   // in-memory metadata lookup, NOT connection I/O (no fab)
  assert.equal(kappa("drizzle-orm", "select"), null);    // drizzle select/insert/... are BUILDERS (no fab)
  assert.equal(kappa("drizzle-orm", "insert"), null);
  assert.equal(kappa("drizzle-orm", "execute"), "Db");   // only the terminal execution verb
  assert.equal(kappa("drizzle-orm", "findMany"), "Db");
  assert.equal(kappa("sequelize", "findAll"), "Db");     // sequelize is execute-on-call
  assert.equal(kappa("node:worker_threads", "postMessage"), "Ipc"); // worker IPC
  assert.equal(kappa("worker_threads", "receiveMessageOnPort"), "Ipc");
  assert.equal(kappa("node:cluster", "fork"), "Ipc");
  assert.equal(kappa("node:worker_threads", "terminate"), null);    // not a message verb → no fab
  assert.equal(kappa("crypto", "createHash"), null); // not the random surface
  assert.equal(kappa("some-unlisted-pkg", "go"), null);
});
test("kappaKnows: curated-or-ratified-pure, else unknown", () => {
  assert.equal(kappaKnows("fs"), true);     // a KAPPA_RULES module
  assert.equal(kappaKnows("rxjs"), true);   // a ratified-pure module
  assert.equal(kappaKnows("totally-random-pkg"), false);
});

// ── scan-core: the ⟨0.13⟩ Llm surfaces (SPEC §1 — mirrors java Literals/Rules VERBATIM) ─────────────
test("isModelHost: known model hosts + subdomains + Ollama port + Bedrock", () => {
  assert.equal(isModelHost("api.openai.com"), true);
  assert.equal(isModelHost("api.anthropic.com"), true);
  assert.equal(isModelHost("generativelanguage.googleapis.com"), true);
  assert.equal(isModelHost("api.cohere.ai"), true);       // both .ai...
  assert.equal(isModelHost("api.cohere.com"), true);      // ...and .com (java parity #5)
  assert.equal(isModelHost("API.OPENAI.COM"), true);      // case-insensitive
  assert.equal(isModelHost("eu.api.openai.com"), true);   // a subdomain of a listed host counts
  assert.equal(isModelHost("api.anthropic.com:443"), true); // :port stripped
  assert.equal(isModelHost("localhost:11434"), true);     // Ollama — LOOPBACK :11434 only
  assert.equal(isModelHost("127.0.0.1:11434"), true);
  assert.equal(isModelHost("bedrock-runtime.us-east-1.amazonaws.com"), true);       // Bedrock RUNTIME
  assert.equal(isModelHost("bedrock-agent-runtime.us-east-1.amazonaws.com"), true); // + agent runtime
});
test("isModelHost: an UNKNOWN host stays bare — never guessed (no over-match fabrication)", () => {
  assert.equal(isModelHost("api.weather.gov"), false);
  assert.equal(isModelHost("example.com"), false);
  assert.equal(isModelHost("openai.com.evil.example"), false); // NOT a subdomain of a listed host
  assert.equal(isModelHost("s3.amazonaws.com"), false);        // .amazonaws.com but not bedrock
  assert.equal(isModelHost("localhost:8080"), false);          // a non-11434 local port is not Ollama
  assert.equal(isModelHost("svc.internal.example.com:11434"), false); // max-review r3: a REMOTE host on :11434 is NOT Ollama
  assert.equal(isModelHost("bedrock-backups.s3.amazonaws.com"), false); // r3: an S3 bucket NAMED bedrock is NOT the runtime
  assert.equal(isModelHost("bedrock.us-east-1.amazonaws.com"), false);  // r3: the Bedrock CONTROL plane is not model inference
  assert.equal(isModelHost(null), false);
});
test("modelHostEffects: [Llm] for a model host, [] otherwise (Net added by the caller)", () => {
  assert.deepEqual(modelHostEffects("api.openai.com"), ["Llm"]);
  assert.deepEqual(modelHostEffects("api.weather.gov"), []);
});
test("isModelSdkPackage: the curated model-SDK clients (+ sub-paths), else false", () => {
  assert.equal(isModelSdkPackage("openai"), true);
  assert.equal(isModelSdkPackage("@anthropic-ai/sdk"), true);
  assert.equal(isModelSdkPackage("@google/generative-ai"), true);
  assert.equal(isModelSdkPackage("@aws-sdk/client-bedrock-runtime"), true);
  assert.equal(isModelSdkPackage("ai"), true);            // Vercel AI SDK
  assert.equal(isModelSdkPackage("@mistralai/mistralai"), true);
  assert.equal(isModelSdkPackage("cohere-ai"), true);
  assert.equal(isModelSdkPackage("groq-sdk"), true);
  assert.equal(isModelSdkPackage("ollama"), true);
  assert.equal(isModelSdkPackage("langchain"), true);
  assert.equal(isModelSdkPackage("@langchain/core"), true);
  assert.equal(isModelSdkPackage("openai/resources"), true);        // a sub-path import
  assert.equal(isModelSdkPackage("@langchain/core/language_models"), true);
  assert.equal(isModelSdkPackage("openai-shims"), false); // NOT a prefix false-positive (tail `(/|$)`)
  assert.equal(isModelSdkPackage("aimless"), false);      // `ai` must not match `aimless`
  assert.equal(isModelSdkPackage("express"), false);
});
test("kappa: a model-SDK package classifies Net (Llm added at the classify site)", () => {
  assert.equal(kappa("openai", "create"), "Net");         // whole-module Net; classify site adds Llm
  assert.equal(kappa("@anthropic-ai/sdk", "messages"), "Net");
  assert.equal(kappaKnows("openai"), true);               // covered — not a κ blind spot
});

// ── scan-core: the literal extractors (shared verbatim with the other engines) ────────────────────
test("commandHeadEffects: unambiguous tools only, by basename", () => {
  assert.deepEqual(commandHeadEffects("curl -X POST"), ["Net"]);
  assert.deepEqual(commandHeadEffects("/usr/bin/psql"), ["Db"]);
  assert.deepEqual(commandHeadEffects("candor-scan"), ["Env", "Fs"]);
  assert.deepEqual(commandHeadEffects("git push"), []); // multi-modal → no fabrication
});
test("hostLiteral: host[:port] from a URL/address, else null", () => {
  assert.equal(hostLiteral("https://api.example.com/v1"), "api.example.com");
  assert.equal(hostLiteral("https://user@host.com:8080/x"), "host.com:8080"); // userinfo stripped
  assert.equal(hostLiteral("example.com:443"), "example.com:443");
  assert.equal(hostLiteral("localhost"), null);   // no dot → not an address literal
  assert.equal(hostLiteral("hello world"), null);
});
test("tablesInSql: SPEC §2 table extraction (comma chain, alias guard)", () => {
  assert.deepEqual(tablesInSql("SELECT id FROM users WHERE x = 1"), ["users"]);
  assert.deepEqual(tablesInSql("SELECT a FROM t1, t2 WHERE x = 1"), ["t1", "t2"]);
  assert.deepEqual(tablesInSql("SELECT a FROM t1 a1, t2"), ["t1"]); // alias breaks the chain
  assert.deepEqual(tablesInSql("INSERT INTO audit_log (a) VALUES (1)"), ["audit_log"]);
  assert.deepEqual(tablesInSql("hello world from nowhere"), []); // not SQL
});
test("isTestPath: test/spec/node_modules are not production sources", () => {
  assert.equal(isTestPath("src/foo.test.ts"), true);
  assert.equal(isTestPath("node_modules/x/index.ts"), true);
  assert.equal(isTestPath("tests/helper.ts"), true);
  assert.equal(isTestPath("src/app.ts"), false);
});

// ── surface.mjs: the cold-repo "most surprising reach" hook (port of surface.rs) ───────────────────
const eff = (...xs) => new Set(xs);
const cal = (...xs) => new Set(xs);

test("surface.tokenize: splits on separator, `_` and camelCase", () => {
  assert.deepEqual(tokenize("settings.Settings.needsUpdate"), ["settings", "settings", "needs", "update"]);
  assert.deepEqual(tokenize("api_client.latestVersion"), ["api", "client", "latest", "version"]);
});

test("surface.tokenize: a NON-ASCII uppercase letter starts a new token (Unicode-aware, matches surface.rs)", () => {
  // surface.rs uses `ch.is_uppercase()` (Unicode) for the camelCase boundary; an ASCII-only `A..Z` check
  // would miss a non-ASCII capital (e.g. Cyrillic `Б`) so `netБar` would stay ONE token, drifting from the
  // reference. The lowercase fold + boundary must both be Unicode-aware; the digit check stays ASCII.
  assert.deepEqual(tokenize("netБar"), ["net", "бar"]);
  assert.deepEqual(tokenize("straße"), ["straße"]); // no interior uppercase → one token (ß is lowercase)
});

test("surface.bestFind: benign deep-inherited reach beats a shallow effecty one", () => {
  // Graph (mirrors surface.rs's benign_deep_inherited_beats_shallow_effecty, `.`-qualified):
  //   settings.Settings.load  (benign leaf "load")  -inherits-> Net, 3 hops
  //     -> core.refresh -> core.syncState -> net_layer.doSend (direct Net)
  //   api.fetch  (effecty leaf "fetch") -inherits-> Net, 1 hop  (EXCLUDED — effecty)
  const direct = new Map();
  const inferred = new Map();
  const calls = new Map();

  direct.set("net_layer.doSend", eff("Net"));
  inferred.set("net_layer.doSend", eff("Net"));

  inferred.set("core.syncState", eff("Net"));
  calls.set("core.syncState", cal("net_layer.doSend"));

  inferred.set("core.refresh", eff("Net"));
  calls.set("core.refresh", cal("core.syncState"));

  // benign candidate: settings.Settings.load, 3 hops to source.
  inferred.set("settings.Settings.load", eff("Net"));
  calls.set("settings.Settings.load", cal("core.refresh"));

  // effecty candidate: api.fetch, 1 hop — must be excluded by the EFFECTY leaf.
  inferred.set("api.fetch", eff("Net"));
  calls.set("api.fetch", cal("net_layer.doSend"));

  const res = bestFind(inferred, direct, calls);
  assert.notEqual(res, null, "project is effectful");
  const w = res.winner;
  assert.notEqual(w, null, "expected a winner");
  assert.equal(w.func, "settings.Settings.load");
  assert.equal(w.effect, "Net");
  assert.equal(w.hops, 3);
  assert.equal(w.source, "net_layer.doSend");
  assert.equal(w.benignToken, "load");
});

test("surface.bestFind: honest fallback when nothing qualifies", () => {
  // One effectful function, but it is a DIRECT source (not inherited) AND effecty-named — no candidate
  // qualifies → { winner: null }, the honest fallback.
  const direct = new Map([["net.client.send", eff("Net")]]);
  const inferred = new Map([["net.client.send", eff("Net")]]);
  const calls = new Map();
  const res = bestFind(inferred, direct, calls);
  assert.notEqual(res, null, "project is effectful");
  assert.equal(res.winner, null, "expected the honest fallback, got a winner");
});

test("surface.bestFind: nothing when there are no non-Unknown effects", () => {
  // No non-Unknown effect anywhere → null (caller emits nothing at all).
  const direct = new Map();
  const inferred = new Map([["util.parse", eff("Unknown")]]);
  const calls = new Map();
  assert.equal(bestFind(inferred, direct, calls), null);
});

test("surface.bestFind: a Clock/Log/Rand-only repo honestly says nothing hidden (salience 0)", () => {
  // A benign function inheriting ONLY mundane effects (Clock/Log/Rand) must NOT surface — those effects
  // now score salience 0 (matches surface.rs), so no candidate clears the bar. The repo IS effectful
  // (real, non-Unknown effects), so the caller emits the honest "nothing hidden" fallback, not a
  // manufactured surprise. Guards the Fix-2 salience change.
  const direct = new Map([
    ["logger.emit", eff("Log")],
    ["timer.tick", eff("Clock")],
    ["entropy.draw", eff("Rand")],
  ]);
  const inferred = new Map([
    ["logger.emit", eff("Log")],
    ["timer.tick", eff("Clock")],
    ["entropy.draw", eff("Rand")],
    // benign-named inheritors reaching each mundane effect — would have surfaced at salience 1.
    ["settings.load", eff("Log")],
    ["config.get", eff("Clock")],
    ["util.build", eff("Rand")],
  ]);
  const calls = new Map([
    ["settings.load", cal("logger.emit")],
    ["config.get", cal("timer.tick")],
    ["util.build", cal("entropy.draw")],
  ]);
  const res = bestFind(inferred, direct, calls);
  assert.notEqual(res, null, "project is effectful (Clock/Log/Rand are real effects)");
  assert.equal(res.winner, null, "mundane-only reaches must not surface — expected the honest fallback");
});

// ── surface.mjs: bestFinds — the top-N pool behind the `tour` verb (port of surface.rs::best_finds) ──
test("surface.bestFinds: names the benign-deep reach on a benign-deep fixture", () => {
  // The `tour` fixture: settings.Settings.load inherits Net 3 hops down via net_layer.doSend, plus an
  // effecty api.fetch that must NOT win (excluded by the leaf lexicon).
  const direct = new Map([["net_layer.doSend", eff("Net")]]);
  const inferred = new Map([
    ["net_layer.doSend", eff("Net")], ["core.syncState", eff("Net")],
    ["core.refresh", eff("Net")], ["settings.Settings.load", eff("Net")], ["api.fetch", eff("Net")],
  ]);
  const calls = new Map([
    ["core.syncState", cal("net_layer.doSend")], ["core.refresh", cal("core.syncState")],
    ["settings.Settings.load", cal("core.refresh")], ["api.fetch", cal("net_layer.doSend")],
  ]);
  const loc = new Map([["net_layer.doSend", "src/net.ts:9:1"]]);
  const finds = bestFinds(inferred, direct, calls, loc, 10);
  assert.ok(finds.length >= 1, "the benign-deep reach should surface");
  assert.equal(finds[0].func, "settings.Settings.load");
  assert.equal(finds[0].effect, "Net");
  assert.equal(finds[0].hops, 3);
  assert.equal(finds[0].source, "net_layer.doSend");
  assert.equal(finds[0].sourceLoc, "src/net.ts:9:1"); // the SOURCE's loc, for the tour callout
  assert.ok(finds.every((f) => f.func !== "api.fetch"), "effecty api.fetch is excluded");
});

test("surface.bestFinds: top-1 equals bestFind's winner (one heuristic, no drift)", () => {
  const direct = new Map([["net_layer.doSend", eff("Net")]]);
  const inferred = new Map([
    ["net_layer.doSend", eff("Net")], ["core.refresh", eff("Net")], ["settings.Settings.load", eff("Net")],
  ]);
  const calls = new Map([
    ["core.refresh", cal("net_layer.doSend")], ["settings.Settings.load", cal("core.refresh")],
  ]);
  const top1 = bestFinds(inferred, direct, calls, new Map(), 1);
  const w = bestFind(inferred, direct, calls).winner;
  assert.equal(top1.length, 1);
  assert.equal(top1[0].func, w.func);
  assert.equal(top1[0].effect, w.effect);
  assert.equal(top1[0].hops, w.hops);
  assert.equal(top1[0].source, w.source);
});

test("surface.bestFinds: dedupes to one row per function and caps at N", () => {
  // Two distinct benign candidates reach Net at different depths; the top-N lists each ONCE, ranked, and
  // N caps the list. (The intermediaries are EFFECTY-named — syncState/downloadStep — so they add no rows.)
  const direct = new Map([["net_layer.doSend", eff("Net")]]);
  const inferred = new Map([
    ["net_layer.doSend", eff("Net")], ["core.syncState", eff("Net")], ["core.downloadStep", eff("Net")],
    ["settings.Settings.load", eff("Net")], ["model.render", eff("Net")],
  ]);
  const calls = new Map([
    ["core.syncState", cal("net_layer.doSend")], ["core.downloadStep", cal("core.syncState")],
    ["settings.Settings.load", cal("core.downloadStep")], ["model.render", cal("net_layer.doSend")],
  ]);
  const got = bestFinds(inferred, direct, calls, new Map(), 10);
  assert.equal(got.length, 2, "two distinct benign functions, one row each");
  assert.equal(got[0].func, "settings.Settings.load"); // deeper reach ranks first
  assert.equal(got[1].func, "model.render");
  assert.equal(bestFinds(inferred, direct, calls, new Map(), 1).length, 1); // N caps
  assert.equal(new Set(got.map((f) => f.func)).size, got.length); // no function twice
});

test("surface.nearestSource: iterates callees in SORTED order (deterministic tie-break, matches surface.rs)", () => {
  // A benign root reaches Net via TWO equal-distance direct sources; the BFS must pick the one that sorts
  // FIRST (`aaa.doSend` < `zzz.doSend`), regardless of the callee-set INSERTION order. surface.rs walks a
  // sorted BTreeSet; raw Map order here would let the pick flip between engines (a non-determinism find).
  const direct = new Map([["aaa.doSend", eff("Net")], ["zzz.doSend", eff("Net")]]);
  const inferred = new Map([
    ["aaa.doSend", eff("Net")], ["zzz.doSend", eff("Net")], ["settings.load", eff("Net")],
  ]);
  // Insert the callees in NON-sorted order (zzz before aaa) — the sorted iteration must still pick aaa.
  const forward = new Map([["settings.load", new Set(["zzz.doSend", "aaa.doSend"])]]);
  const reverse = new Map([["settings.load", new Set(["aaa.doSend", "zzz.doSend"])]]);
  const f1 = bestFinds(inferred, direct, forward, new Map(), 1);
  const f2 = bestFinds(inferred, direct, reverse, new Map(), 1);
  assert.equal(f1[0].source, "aaa.doSend", "sorted BFS picks the first-sorting source regardless of insertion order");
  assert.equal(f2[0].source, "aaa.doSend");
  assert.equal(f1[0].source, f2[0].source, "the source is insertion-order-independent (deterministic)");
});

// ⟨0.24⟩ SPEC §2's THREE-ROW TABLE, at the function boundary. The behavioural suite drives it through the
// chain and through `gate --report`; this pins the predicate itself, because ONE integer separates a
// dependency that judged nothing from one that judged n units and found none of them effectful, and the
// second is a claim §2 chaining rule 3 requires a consumer to BELIEVE. Every row is a shape a real report
// takes; the `count > 0` rows are the control that a fix keyed on `functions` being empty would fail.
test("⟨0.24⟩ claimsToHaveJudgedNothing: the three-row table plus the fail-closed row", () => {
  const T = (analyzed, fns) => claimsToHaveJudgedNothing(analyzed === undefined ? { functions: fns } : { analyzed, functions: fns }, fns);
  // row 1 — count 0: judged nothing, whatever `functions` says.
  assert.equal(T({ count: 0 }, []), true);
  assert.equal(T({ count: 0, digest: "ab" }, []), true);
  assert.equal(T({ count: -1 }, []), true, "a negative count is not a judgment either");
  assert.equal(T({ count: 0 }, [{ fn: "a" }]), true, "count 0 while LISTING functions is contradictory: fail closed");
  // row 2 — count n > 0: judged n units. THE CONTROL: an empty `functions` here is an all-pure CLAIM.
  assert.equal(T({ count: 2 }, []), false, "count n>0 with functions:[] is rule 3's all-pure claim — believe it");
  assert.equal(T({ count: 1 }, [{ fn: "a" }]), false, "the ordinary report");
  assert.equal(T({ count: 1e6 }, []), false);
  // row 3 — manifest ABSENT: judged-nothing IFF there are no entries.
  assert.equal(T(undefined, []), true, "a pre-⟨0.21⟩ producer with nothing to show makes no claim");
  assert.equal(T(undefined, [{ fn: "a" }]), false, "…but its ENTRIES are the claim it could make");
  // the fail-closed row: a judgment claim that cannot be READ is not a claim. A denylist, not an allowlist.
  for (const bad of ["oops", {}, null, [], 7, { count: "2" }, { count: null }, { count: NaN }, { count: Infinity }])
    assert.equal(T(bad, [{ fn: "a" }]), true, `garbled manifest ${JSON.stringify(bad)} grants nothing`);
  // and the shapes that are not objects at all — a legacy bare ARRAY report has no envelope, so its
  // entries are its only claim (reading it off a summed count would call every one of them unjudged).
  assert.equal(claimsToHaveJudgedNothing([{ fn: "a" }], [{ fn: "a" }]), false);
  assert.equal(claimsToHaveJudgedNothing([], []), true);
  assert.equal(claimsToHaveJudgedNothing(null, []), true);
});

test("⟨0.24⟩ the prefix readers agree: loadGateReport and reportJudgedNothing read one rule", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "candor-unjudged-"));
  const w = (n, doc) => { fs.writeFileSync(path.join(D, `${n}.json`), JSON.stringify(doc)); return path.join(D, n); };
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app" };
  const zero = w("zero", { ...V, analyzed: { count: 0 }, functions: [] });
  const allpure = w("allpure", { ...V, analyzed: { count: 2 }, functions: [] });
  assert.equal(loadGateReport(zero).judgedNothing, true);
  assert.equal(loadGateReport(allpure).judgedNothing, false, "the control: a believed all-pure report");
  assert.equal(reportJudgedNothing(zero), true);
  assert.equal(reportJudgedNothing(allpure), false);
  // a prefix naming NO report is not "judged nothing" — it is nothing at all, and each caller owns its
  // own loud not-found path. Answering true here would put a caveat on a missing file.
  assert.equal(reportJudgedNothing(path.join(D, "absent")), false);
  // MULTI-REPORT siblings (the Rust/workspace form): the union has judged something as soon as ONE has.
  const M = fs.mkdtempSync(path.join(os.tmpdir(), "candor-unjudged-multi-"));
  fs.writeFileSync(path.join(M, "r.a.scan.json"), JSON.stringify({ ...V, analyzed: { count: 0 }, functions: [] }));
  fs.writeFileSync(path.join(M, "r.b.scan.json"), JSON.stringify({ ...V, analyzed: { count: 4 }, functions: [] }));
  assert.equal(reportJudgedNothing(path.join(M, "r")), false);
  assert.equal(loadGateReport(path.join(M, "r")).judgedNothing, false);
  fs.writeFileSync(path.join(M, "r.b.scan.json"), JSON.stringify({ ...V, analyzed: { count: 0 }, functions: [] }));
  assert.equal(reportJudgedNothing(path.join(M, "r")), true, "…and nothing has, when none has");
  fs.rmSync(D, { recursive: true, force: true });
  fs.rmSync(M, { recursive: true, force: true });
});

// ── SOURCE HYGIENE ────────────────────────────────────────────────────────────────────────────────
test("no shipped .mjs holds a raw NUL byte (it makes the file INVISIBLE to grep)", async () => {
  // A RAW NUL MAKES A FILE BINARY TO grep, WHICH REPORTS NO MATCHES AND EXITS 1.
  //
  // Found live in `query-core.mjs` (101KB, one NUL at offset 80998, a template-literal key separator
  // `${r.raw}<NUL>${eff}`): `grep -c Hierarchy query-core.mjs` printed nothing and exited 1, so a search
  // over candor-ts silently SKIPPED its largest query module and read as "not here". It was found only by
  // accident, while looking for `callersFrontier` — which sits at line 745 of the file grep would not show.
  //
  // The failure mode is the one that hides itself: the search that would have found the answer comes back
  // empty. candor-java carries this guard as `SourceHygieneTest.noMainSourceFileHoldsARawNulByte` after the
  // identical defect in `Policy.java`; candor-ts had the defect before and no guard, so it came back.
  // Write the `\0` ESCAPE instead — it compiles to the identical string.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const offenders = [];
  let scanned = 0;
  for (const f of fs.readdirSync(here)) {
    if (!f.endsWith(".mjs")) continue;
    scanned++;
    if (fs.readFileSync(path.join(here, f)).includes(0)) offenders.push(f);
  }
  // The control: a guard that walked an empty tree would pass just as loudly.
  assert.ok(scanned > 5, `scanned only ${scanned} .mjs files — the guard proved nothing`);
  assert.deepEqual(offenders, [],
    `these hold a raw NUL, so grep treats them as BINARY and reports no matches for anything in them — ` +
    `write the \\0 escape, which compiles to the identical string: ${offenders.join(", ")}`);
});
