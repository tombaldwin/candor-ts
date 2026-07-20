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
  reportCoverage, gainsCoverage,
} from "./query-core.mjs";
import {
  parsePolicy, scopeMatches, hostPart, cmdBase, pathCovered, tableCovered, literalAllowed, EFFECTS,
  discoverConfigPolicy, evaluatePolicy, reasonClass, parseUnknownAliases, parseNetPartners,
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
  // an Unknown with no recorded reason ⇒ unresolved (conservative)
  const noReason = [{ fn: "x.f", inferred: ["Unknown"] }];
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
test("loadHierarchy: exact sidecar, wrong-type coercion, corrupt → {}, absent → {}", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-hier-"));
  // the exact `<prefix>.hierarchy.json` form; a non-array supertype value is coerced to []
  fs.writeFileSync(path.join(d, "r.hierarchy.json"),
    JSON.stringify({ "m.Impl": ["m.Base"], "m.Odd": "not-an-array" }));
  assert.deepEqual(loadHierarchy(path.join(d, "r")), { "m.Impl": ["m.Base"], "m.Odd": [] });
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
