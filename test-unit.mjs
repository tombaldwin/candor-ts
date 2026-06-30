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
  containment, loadReport, loadCallgraph, isReport,
} from "./query-core.mjs";
import {
  parsePolicy, scopeMatches, hostPart, cmdBase, pathCovered, tableCovered, literalAllowed, EFFECTS,
} from "./policy.mjs";
import {
  isTestPath, kappa, kappaKnows, commandHeadEffects, hostLiteral, tablesInSql,
} from "./scan-core.mjs";

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
test("parsePolicy: dedups repeated tokens (a set, matching rust/java)", () => {
  // ts kept `deny Net Net` → [Net,Net] while rust/java dedup — a canonical-form divergence (adversarial review)
  assert.deepEqual(parsePolicy("deny Net Net").deny[0].effects, ["Net"]);
  assert.deepEqual(parsePolicy("allow Net api api").allow[0].values, ["api"]);
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
