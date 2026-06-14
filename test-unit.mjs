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
  loadReport, loadCallgraph, isReport,
} from "./query-core.mjs";
import {
  parsePolicy, scopeMatches, hostPart, cmdBase, pathCovered, tableCovered, literalAllowed, EFFECTS,
} from "./policy.mjs";

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

// ── policy: the DSL grammar (positional, mirroring the Rust/JVM parsers) ───────────────────────────
test("parsePolicy: deny is POSITIONAL — first non-effect token ends the effect list (= scope)", () => {
  const p = parsePolicy("deny Net foo Db");
  assert.deepEqual(p.deny, [{ effects: ["Net"], scope: "foo", raw: "deny Net foo Db" }]); // Db NOT captured
});
test("parsePolicy: pure → an empty-effect deny (any effect forbidden)", () => {
  assert.deepEqual(parsePolicy("pure svc").deny, [{ effects: [], scope: "svc", raw: "pure svc" }]);
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
  assert.deepEqual(p.deny, [{ effects: ["Fs"], scope: "", raw: "deny Fs" }]); // bare `deny`, `garbage`, `Unknown` all dropped
});
test("EFFECTS: the §1 vocabulary", () => {
  assert.ok(EFFECTS.includes("Net") && EFFECTS.includes("Clipboard") && EFFECTS.length === 10);
});

// ── policy: scope matching + the per-effect literal matchers ──────────────────────────────────────
test("scopeMatches: segment-prefix match, bounded by name length", () => {
  assert.equal(scopeMatches("a.b.foo", "b"), true);
  assert.equal(scopeMatches("svc.handler", "svc.handler"), true);
  assert.equal(scopeMatches("a.b", "x"), false);
  assert.equal(scopeMatches("a", "a.b.c"), false); // scope longer than name
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
