#!/usr/bin/env node
/**
 * Tests for query-core.mjs (the shared query functions) and mcp.mjs (the MCP server, driven over its
 * real stdio JSON-RPC transport). Cross-checks the shared queries against the conformance-verified
 * query.mjs so query-core can't drift from the canonical CLI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Q from "./query-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}  ${d}`));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- a tiny fixture report: handler -> mid -> leaf(Net) -------------------------------------------
const W = fs.mkdtempSync("/tmp/candor-mcp-");
fs.writeFileSync(`${W}/app.ts`, `import * as http from "node:http";
export function leaf(): void { http.get("http://x"); }
export function mid(): void { leaf(); }
export function handler(): void { mid(); }
`);
execFileSync("node", [`${HERE}/scan.mjs`, `${W}/app.ts`, `${W}/r`], { stdio: "ignore" });
const P = `${W}/r`;
const fns = Q.loadReport(P), cg = Q.loadCallgraph(P);

// ---- query-core unit checks ----------------------------------------------------------------------
const imp = Q.impact(fns, cg, "leaf");
ok("impact: affected = the transitive effectful callers (mid, handler)",
   eq(imp.affected, ["app.handler", "app.mid"]) && imp.affectedCount === 2, JSON.stringify(imp));
ok("impact: shape matches candor-query (fn, affectedCount, entryPoints) + the `affected` extension",
   "fn" in imp && "affectedCount" in imp && Array.isArray(imp.entryPoints) && "affected" in imp);

const pth = Q.path(fns, cg, "handler", "Net");
ok("path: shortest chain handler -> mid -> leaf, source flagged at the Net origin",
   eq(pth.path.map((s) => s.fn), ["app.handler", "app.mid", "app.leaf"])
   && pth.path[2].source === true && pth.path[0].source === false, JSON.stringify(pth));
const noPath = Q.path(fns, cg, "leaf", "Db");
ok("path: honest empty when no local source performs the effect", eq(noPath.path, []));

const w = Q.where(fns, "Net");
ok("where: leaf is a direct Net source; mid/handler inherit it",
   eq(w.directly, ["app.leaf"]) && eq(w.inherited, ["app.handler", "app.mid"]), JSON.stringify(w));

// defensive: a partial/malformed report (entries missing §2 required fields) must TOLERATE, not throw
const B = fs.mkdtempSync("/tmp/candor-bad-");
fs.writeFileSync(`${B}/r.json`, JSON.stringify({ functions: [{ fn: "a" }, { fn: "b", inferred: ["Net"] }] }));
fs.writeFileSync(`${B}/r.callgraph.json`, JSON.stringify({ a: null, b: ["a"] }));
const bf = Q.loadReport(`${B}/r`), bcg = Q.loadCallgraph(`${B}/r`);
let threw = false;
try { Q.where(bf, "Net"); Q.map(bf); Q.reachable(bf); Q.impact(bf, bcg, "a"); Q.callers(bcg, "b"); } catch { threw = true; }
ok("query-core tolerates a malformed report (missing inferred/direct/calls) without throwing", !threw);
fs.rmSync(B, { recursive: true, force: true });

// cross-engine loader: a multi-report prefix (<prefix>.<crate>.scan.json, the candor-scan/Rust form)
// merges every sibling — so the MCP server serves a report from ANY engine, not just candor-ts's.
const M = fs.mkdtempSync("/tmp/candor-multi-");
fs.writeFileSync(`${M}/r.a.scan.json`, JSON.stringify({ functions: [{ fn: "a::f", inferred: ["Net"], direct: ["Net"], calls: [] }] }));
fs.writeFileSync(`${M}/r.b.scan.json`, JSON.stringify({ functions: [{ fn: "b::g", inferred: ["Fs"], direct: ["Fs"], calls: [] }] }));
fs.writeFileSync(`${M}/r.a.scan.callgraph.json`, JSON.stringify({ "a::f": [] }));
fs.writeFileSync(`${M}/r.b.scan.callgraph.json`, JSON.stringify({ "b::g": [] }));
// a --gate-json verdict written beside the prefix is NOT a report sibling: merging it disclosed
// "no functions array — OMITTED" on every query over the recommended CI layout (review find).
fs.writeFileSync(`${M}/r.gate.json`, JSON.stringify({ spec: "0.23", ok: true, violations: [] }));
const merged = Q.loadReport(`${M}/r`);
ok("cross-engine loader: a multi-report prefix merges every sibling (Rust/workspace form)",
   merged.length === 2 && merged.some((e) => e.fn === "a::f") && merged.some((e) => e.fn === "b::g"));
ok("loader: a sibling .gate.json verdict is not mistaken for a report (no malformed-report noise)",
   !Q.isReport("r.gate.json") && merged.length === 2);
ok("cross-engine loader: the callgraph sidecars merge too",
   "a::f" in Q.loadCallgraph(`${M}/r`) && "b::g" in Q.loadCallgraph(`${M}/r`));
fs.rmSync(M, { recursive: true, force: true });

// a corrupt MATCHED sidecar makes the graph PARTIAL (the hardFail precedent) — and gains' origin
// ladder must not read a dropped file's fns as "new" (the supply-chain attack signal downgraded):
// report hit → existing; graph node → existing; graph empty OR partial → unknown; else new.
{
  const PG = fs.mkdtempSync("/tmp/candor-partialcg-");
  fs.writeFileSync(`${PG}/r.a.scan.callgraph.json`, JSON.stringify({ "a::f": [] }));
  fs.writeFileSync(`${PG}/r.b.scan.callgraph.json`, "{ truncated");   // matched, unparseable → edges dropped
  const pcg = Q.loadCallgraph(`${PG}/r`);
  ok("loadCallgraph: a corrupt MATCHED sibling sidecar tags the graph `partial` (non-enumerable)",
     pcg.partial === true && !Object.keys(pcg).includes("partial") && "a::f" in pcg, JSON.stringify(pcg));
  ok("loadCallgraph: an ABSENT sidecar is NOT partial (the empty graph is the whole truth)",
     Q.loadCallgraph(`${PG}/none`).partial === false);
  const pg = Q.gains([{ fn: "a::f", inferred: ["Net"] }, { fn: "b::g", inferred: ["Net"] }], [], pcg);
  const orig = (fn) => pg.byFunction.find((x) => x.fn === fn)?.origin;
  ok("gains origin over a PARTIAL baseline graph: a surviving node stays 'existing'; an absent fn is 'unknown', never 'new'",
     orig("a::f") === "existing" && orig("b::g") === "unknown", JSON.stringify(pg.byFunction));
  fs.rmSync(PG, { recursive: true, force: true });
}

// REGRESSION: diff/gains must UNION effects across same-named rows, not last-wins. Two merged workspace
// members with a shared short fn name (the multi-report loader produces both) collapsed to the last,
// so gains MISSED a gained effect (a supply-chain false negative — the dangerous direction).
const curDup = [{ fn: "init", inferred: ["Net"] }, { fn: "init", inferred: ["Exec"] }];
const baseDup = [{ fn: "init", inferred: [] }];
ok("gains: same-named rows UNION (a supply-chain alarm never drops a gained effect)",
   eq(Q.gains(curDup, baseDup).gained, ["Exec", "Net"]), JSON.stringify(Q.gains(curDup, baseDup)));
// a non-array inferred (e.g. the string "Net") must NOT iterate into {N,e,t} (fabricated effects)
ok("loader: a non-array `inferred` is coerced to [], not iterated into characters",
   eq(Q.gains([{ fn: "x", inferred: "Net" }], [{ fn: "x", inferred: [] }]).gained, []));

// ---- cross-check the shared queries against the canonical query.mjs (no drift) --------------------
// This block exists because the package's recurring failure mode is drift between duplicated
// implementations (show, callers, and diff each drifted before being migrated to query-core) — every
// query BOTH surfaces serve is pinned CLI == core, so a re-fork can't ship silently.
function cliRaw(args) { return execFileSync("node", [`${HERE}/query.mjs`, ...args], { encoding: "utf8" }); }
function cli(args) { return JSON.parse(cliRaw(args)); }
ok("query-core where == query.mjs where (canonical, conformance-verified)",
   eq(Q.where(fns, "Net"), cli(["where", P, "Net"])));
ok("query-core callers == query.mjs callers", eq(Q.callers(cg, "leaf"), cli(["callers", P, "leaf"])));
ok("query-core reachable == query.mjs reachable", eq(Q.reachable(fns), cli(["reachable", P])));
ok("query-core map == query.mjs map", eq(Q.map(fns), cli(["map", P])));
ok("query-core diff-vs-self == query.mjs diff-vs-self (both {changes: []})",
   eq(Q.diff(fns, fns), { changes: cli(["diff", P, P]).changes }));
{ // whatif: same blast radius + verdict from both surfaces (no policy → the pure-core half)
  const cliWi = cli(["whatif", P, "leaf", "Db"]);
  ok("query-core whatif == query.mjs whatif",
     eq(Q.whatif(cg, "leaf", "Db", null, () => false), cliWi), JSON.stringify(cliWi));
}
// REGRESSION (CLI): duplicate fn names across merged multi-report siblings must UNION in `diff`, not
// collapse last-wins — the collapse masked a gained effect from the CLI's gained→exit-1 contract while
// MCP candor_diff (query-core) reported it: the package's no-two-truths rule broken between surfaces.
{
  const DD = fs.mkdtempSync("/tmp/candor-dupdiff-");
  // cur: two workspace members both defining `init`; only member a's gained Net. Baseline: neither.
  fs.writeFileSync(`${DD}/cur.a.scan.json`, JSON.stringify({ functions: [{ fn: "init", inferred: ["Net"], direct: ["Net"] }] }));
  fs.writeFileSync(`${DD}/cur.b.scan.json`, JSON.stringify({ functions: [{ fn: "init", inferred: [], direct: [] }] }));
  fs.writeFileSync(`${DD}/base.json`, JSON.stringify({ functions: [{ fn: "init", inferred: [], direct: [] }] }));
  const r = (() => { // execFileSync throws on exit 1 — capture status + stdout by hand
    try { return { status: 0, stdout: cliRaw(["diff", `${DD}/cur`, `${DD}/base`]) }; }
    catch (e) { return { status: e.status, stdout: e.stdout.toString() }; }
  })();
  const out = JSON.parse(r.stdout);
  ok("CLI diff: a duplicated fn name UNIONS (the gained Net is not masked by a last-wins sibling)",
     out.changes.some((c) => c.fn === "init" && c.gained.includes("Net")), r.stdout.slice(0, 160));
  ok("CLI diff: the masked gain still trips the gained→exit-1 contract", r.status === 1, `status=${r.status}`);
  fs.rmSync(DD, { recursive: true, force: true });
}

// ---- the MCP server, over its real stdio JSON-RPC transport --------------------------------------
function mcpSession(requests, extraArgs = [], extraEnv = { CANDOR_REPORT: P }) {
  return new Promise((resolve) => {
    const srv = spawn("node", [`${HERE}/mcp.mjs`, ...extraArgs], { env: { ...process.env, ...extraEnv } });
    let out = "", responses = [];
    srv.stdout.on("data", (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
        if (responses.length === requests.filter((r) => r.id !== undefined).length) { srv.stdin.end(); resolve(responses); }
      }
    });
    for (const r of requests) srv.stdin.write(JSON.stringify(r) + "\n");
  });
}

const replies = await mcpSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "candor_impact", arguments: { fn: "leaf" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "candor_where", arguments: { effect: "Net" } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "candor_impact", arguments: { fn: "nope" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "candor_impact", arguments: {} } },
]);
const byId = Object.fromEntries(replies.map((r) => [r.id, r]));

ok("mcp: initialize returns serverInfo + tools capability",
   byId[1]?.result?.serverInfo?.name === "candor-mcp" && "tools" in byId[1].result.capabilities);
ok("mcp: tools/list advertises candor_impact and candor_reachable",
   byId[2]?.result?.tools?.some((t) => t.name === "candor_impact")
   && byId[2].result.tools.some((t) => t.name === "candor_reachable"));
const impCall = JSON.parse(byId[3].result.content[0].text);
ok("mcp: tools/call candor_impact returns the same result as the core",
   eq(impCall.affected, ["app.handler", "app.mid"]));
const whereCall = JSON.parse(byId[4].result.content[0].text);
ok("mcp: tools/call candor_where returns the effect surface", eq(whereCall.directly, ["app.leaf"]));
ok("mcp: a no-match query is a tool-level error (isError), not a crash",
   byId[5]?.result?.isError === true);
ok("mcp: a missing required arg (fn) is a clear error, not a silently-empty result",
   byId[6]?.result?.isError === true && /missing required argument/.test(byId[6].result.content[0].text));

// REGRESSION: a malformed frame that parses to a non-object (`null`, a bare primitive, a batch array)
// must NOT crash the server — `null\n` killed it (handle(null) destructured; the catch re-derefed
// msg.id on null → threw OUTSIDE the handler → process exit → the agent's whole session died).
async function rawSession(lines) {
  return new Promise((resolve) => {
    const srv = spawn("node", [`${HERE}/mcp.mjs`], { env: { ...process.env, CANDOR_REPORT: P } });
    let out = "", responses = [];
    srv.stdout.on("data", (d) => {
      out += d; let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
        if (responses.length >= 2) { srv.stdin.end(); resolve(responses); }
      }
    });
    for (const l of lines) srv.stdin.write(l + "\n");
  });
}
const afterNull = await rawSession([
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  "null",                  // the crash trigger
  "false", "[1,2,3]",      // other non-object frames
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
]);
ok("mcp: a `null`/primitive/array frame does NOT crash the server (it still answers the next request)",
   afterNull.some((r) => r.id === 2 && r.result !== undefined), JSON.stringify(afterNull));

// ── the unified-surface additions: gate (via .candor/config), containment, blindspots, resources ────
// The fixture project W gains a checked-in config + policy so candor_gate resolves them with NO args —
// the spec §3.4 flow. `leaf` performs Net, so `deny Net` fires with the structured {rule,fn,effects}.
fs.mkdirSync(path.join(W, ".candor"), { recursive: true });
fs.writeFileSync(path.join(W, "arch.policy"), "deny Net\n");
fs.writeFileSync(path.join(W, ".candor", "config"), "policy arch.policy\n");
const extra = await mcpSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "candor_gate", arguments: {} } },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "candor_containment", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "candor_blindspots", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "resources/list" },
  { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "candor://report" } },
  // candor_fix resolves the SAME checked-in policy as candor_gate (no args) — leaf performs Net under the
  // whole-project `deny Net`, a real crossing with no clean hoist (every caller is also denied).
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "candor_fix", arguments: { fn: "leaf", effect: "Net" } } },
]);
const toolText = (id) => JSON.parse(extra.find((r) => r.id === id).result.content[0].text);
const gate = toolText(2);
ok("mcp: candor_gate resolves the checked-in .candor/config policy (no args) and fails the violating repo",
   gate.ok === false && gate.violations.some((v) => v.rule === "AS-EFF-006" && v.effects.includes("Net")),
   JSON.stringify(gate));
const fixR = toolText(7);
ok("mcp: candor_fix resolves the checked-in policy (no args) and returns the boundary remedy",
   fixR.crossing === true && fixR.site.includes("app.leaf") && fixR.policyAlternative === "allow Net",
   JSON.stringify(fixR));
const cont = toolText(3);
ok("mcp: candor_containment returns the per-effect dispersion shape",
   cont && (Array.isArray(cont.contained) || typeof cont === "object"), JSON.stringify(cont).slice(0, 120));
ok("mcp: candor_blindspots returns the sources shape",
   Array.isArray(toolText(4).sources), JSON.stringify(toolText(4)).slice(0, 120));
const resList = extra.find((r) => r.id === 5).result.resources;
ok("mcp: resources/list names the report AND the checked-in policy",
   resList.some((r) => r.uri.startsWith("candor://report")) && resList.some((r) => r.uri.startsWith("candor://policy")),
   JSON.stringify(resList));
const resRead = extra.find((r) => r.id === 6).result.contents[0];
ok("mcp: resources/read serves the report envelope",
   resRead.mimeType === "application/json" && JSON.parse(resRead.text).some((f) => f.fn === "app.leaf"),
   String(resRead.text).slice(0, 120));

// ── candor_whatif over MCP: the pre-edit gate must FAIL CLOSED on a bad policy path ────────────────
// (review headline find: a typo'd/missing `policy` silently evaluated with NO policy → ok:true — a
// false green on the agent-facing surface, the exact gateless-green shape the CLI whatif exits 2 on.)
const OUTSIDE = fs.mkdtempSync("/tmp/candor-outside-");
fs.writeFileSync(path.join(OUTSIDE, "other.policy"), "deny Net\n");
const wi = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "candor_whatif", arguments: args } });
const wiReplies = await mcpSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  wi(2, { fn: "mid", effect: "Net", policy: path.join(W, "arch.policy") }),      // repo-root policy, violating
  wi(3, { fn: "mid", effect: "Db", policy: path.join(W, "arch.policy") }),       // repo-root policy, passing
  wi(4, { fn: "mid", effect: "Net", policy: path.join(W, "no-such.policy") }),   // MISSING path → loud error
  wi(5, { fn: "mid", effect: "Net", policy: path.join(OUTSIDE, "other.policy") }), // outside the repo → refused
  wi(6, { fn: "mid", effect: "Net" }),                                           // no policy → blast radius only
]);
const wiById = Object.fromEntries(wiReplies.map((r) => [r.id, r]));
const wiText = (id) => wiById[id].result.content[0].text;
const wiJson = (id) => JSON.parse(wiText(id));
ok("mcp whatif: a repo-root policy is READ (not refused by the old .candor-dir confinement root) and violates",
   wiById[2].result.isError !== true && wiJson(2).ok === false && wiJson(2).violations.length > 0, wiText(2).slice(0, 160));
ok("mcp whatif: the same policy passes a non-denied effect (control)",
   wiById[3].result.isError !== true && wiJson(3).ok === true && wiJson(3).violations.length === 0, wiText(3).slice(0, 160));
ok("mcp whatif: a MISSING policy path is a loud tool error (fail closed), never a clean ok:true",
   wiById[4].result.isError === true && /could not be read/.test(wiText(4)), wiText(4).slice(0, 160));
ok("mcp whatif: a policy outside the report's repo is refused (confinement)",
   wiById[5].result.isError === true && /must be within/.test(wiText(5)), wiText(5).slice(0, 160));
ok("mcp whatif: no policy given still answers the blast radius (ok:true, no violations)",
   wiById[6].result.isError !== true && wiJson(6).ok === true && wiJson(6).affected.includes("app.handler"), wiText(6).slice(0, 160));

// ── --root lockdown: a report prefix outside the declared workspace is refused — but an out-of-tree
// BASELINE (diff/gains) is accepted: a prior-release report deliberately kept outside the repo is
// read-only comparison input the agent names explicitly, not a served-workspace resource.
fs.copyFileSync(`${P}.json`, `${OUTSIDE}/r.json`);                       // the out-of-tree baseline —
fs.copyFileSync(`${P}.callgraph.json`, `${OUTSIDE}/r.callgraph.json`);   // an identical prior "release"
const rootReplies = await mcpSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "candor_where", arguments: { effect: "Net" } } },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "candor_where", arguments: { effect: "Net", report: `${OUTSIDE}/r` } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "candor_diff", arguments: { baseline: `${OUTSIDE}/r` } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "candor_gains", arguments: { baseline: `${OUTSIDE}/r` } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "candor_diff", arguments: { baseline: `${OUTSIDE}/no-such` } } },
], ["--root", W]);
const rootById = Object.fromEntries(rootReplies.map((r) => [r.id, r]));
ok("mcp --root: the in-workspace default prefix still serves",
   rootById[2].result.isError !== true && JSON.parse(rootById[2].result.content[0].text).directly.includes("app.leaf"));
ok("mcp --root: a report prefix outside the workspace is refused",
   rootById[3].result.isError === true && /outside the served workspace/.test(rootById[3].result.content[0].text),
   rootById[3].result.content[0].text.slice(0, 160));
ok("mcp --root: an OUT-OF-TREE baseline is accepted by candor_diff (read-only comparison input, not confined)",
   rootById[4].result.isError !== true && eq(JSON.parse(rootById[4].result.content[0].text).changes, []),
   rootById[4].result.content[0].text.slice(0, 160));
ok("mcp --root: an OUT-OF-TREE baseline is accepted by candor_gains too (identical scan → no gained effects)",
   rootById[5].result.isError !== true && eq(JSON.parse(rootById[5].result.content[0].text).gained, []),
   rootById[5].result.content[0].text.slice(0, 160));
ok("mcp --root: a MISSING baseline stays a loud, informative error (existence check kept)",
   rootById[6].result.isError === true && /no report at .*no-such.*run a candor scan first/.test(rootById[6].result.content[0].text),
   rootById[6].result.content[0].text.slice(0, 160));
fs.rmSync(OUTSIDE, { recursive: true, force: true });

// ── ⟨0.15 staged⟩ candor_gains coverage parity: the MCP tool spreads the SAME gainsCoverage the CLI
// verb does (one code path, the parity rule) — the current envelope's ledger + the name-level delta
// ride along; a coverage-free comparison carries neither key (the pre-0.15 result, byte-identical).
{
  const CV = fs.mkdtempSync("/tmp/candor-covgains-");
  const doc = (extra) => JSON.stringify({ candor: { version: "eeeeeee", spec: "0.23" },
    functions: [{ fn: "m.f", inferred: ["Net"], direct: ["Net"] }], ...extra });
  fs.writeFileSync(`${CV}/cur.json`, doc({ coverage: { uncovered: [{ name: "blinddep", calls: 2 }] } }));
  fs.writeFileSync(`${CV}/base.json`, doc({}));
  const covReplies = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "candor_gains", arguments: { report: `${CV}/cur`, baseline: `${CV}/base` } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "candor_gains", arguments: { report: `${CV}/base`, baseline: `${CV}/base` } } },
  ]);
  const covById = Object.fromEntries(covReplies.map((r) => [r.id, r]));
  const gCov = JSON.parse(covById[2].result.content[0].text);
  ok("mcp candor_gains ⟨0.15⟩: the current report's coverage envelope + nowUncovered delta ride along",
     eq(gCov.coverage, { uncovered: [{ name: "blinddep", calls: 2 }] })
       && eq(gCov.coverageDelta, { nowUncovered: ["blinddep"], noLongerUncovered: [] }),
     JSON.stringify(gCov).slice(0, 240));
  const gPlain = JSON.parse(covById[3].result.content[0].text);
  ok("mcp candor_gains ⟨0.15⟩: coverage-free reports carry NEITHER coverage key (pre-0.15 result unchanged)",
     !("coverage" in gPlain) && !("coverageDelta" in gPlain), JSON.stringify(Object.keys(gPlain)));
  fs.rmSync(CV, { recursive: true, force: true });
}

// ── the MCP list caps: an over-cap result is TRUNCATED with exact counts + a disclosure flag ────────
// These caps are the agent-context contract (MCP_LIST_CAP=50): a large repo's where/callers/impact/
// blindspots answer must stay token-bounded, the COUNT must stay exact, and the truncation must be
// flagged — silently-shortened lists would misreport the blast radius. Synthetic report: 60 entry-point
// callers of one Net+Unknown leaf (>cap on every listed surface).
{
  const CAP = fs.mkdtempSync("/tmp/candor-cap-");
  const capFns = [{ fn: "cap.leaf", inferred: ["Net", "Unknown"], direct: ["Net"], unknownWhy: ["reflect:eval"] }];
  const capCg = { "cap.leaf": [] };
  for (let i = 0; i < 60; i++) {
    const n = `cap.f${String(i).padStart(2, "0")}`;
    capFns.push({ fn: n, inferred: ["Net", "Unknown"], direct: [], entryPoint: true });
    capCg[n] = ["cap.leaf"];
  }
  fs.writeFileSync(`${CAP}/r.json`, JSON.stringify({ functions: capFns }));
  fs.writeFileSync(`${CAP}/r.callgraph.json`, JSON.stringify(capCg));
  fs.writeFileSync(`${CAP}/gate.policy`, "deny Net\n");
  const CR = `${CAP}/r`;
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { report: CR, ...args } } });
  const capReplies = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_where", { effect: "Net" }),
    call(3, "candor_callers", { fn: "cap.leaf" }),
    call(4, "candor_impact", { fn: "cap.leaf" }),
    call(5, "candor_blindspots", {}),
    call(6, "candor_whatif", { fn: "cap.f00", effect: "Net", policy: `${CAP}/gate.policy` }),
    call(7, "candor_gate", {}),
  ]);
  const capById = Object.fromEntries(capReplies.map((r) => [r.id, r]));
  const capText = (id) => JSON.parse(capById[id].result.content[0].text);
  const w60 = capText(2);
  ok("cap: candor_where truncates the over-cap inherited list to 50, keeps the exact counts, flags it",
     w60.truncated === true && w60.inheritedCount === 60 && w60.inherited.length === 50
     && w60.directlyCount === 1 && eq(w60.directly, ["cap.leaf"]), JSON.stringify(w60).slice(0, 160));
  const c60 = capText(3);
  ok("cap: candor_callers truncates direct+transitive to 50 with exact counts + the flag",
     c60.truncated === true && c60.directCount === 60 && c60.direct.length === 50
     && c60.transitiveCount === 60 && c60.transitive.length === 50, JSON.stringify(c60).slice(0, 160));
  const i60 = capText(4);
  ok("cap: candor_impact truncates affected (exact affectedCount stays) and flags it",
     i60.affectedTruncated === true && i60.affectedCount === 60 && i60.affected.length === 50,
     JSON.stringify(i60).slice(0, 160));
  ok("cap: candor_impact truncates the entry-point list with its own count + flag",
     i60.entryPointsTruncated === true && i60.entryPointCount === 60 && i60.entryPoints.length === 50,
     JSON.stringify(i60).slice(0, 160));
  const b60 = capText(5);
  ok("cap: candor_blindspots truncates a source's affected list; `reaches` stays the exact count",
     b60.sources[0]?.fn === "cap.leaf" && b60.sources[0].affectedTruncated === true
     && b60.sources[0].reaches === 60 && b60.sources[0].affected.length === 50 && b60.totalUnknown === 61,
     JSON.stringify(b60).slice(0, 200));
  // a repo with NO .candor layout: the policy confinement root falls back to the report's own dir —
  // a policy beside the report must be readable (the policyRoot non-.candor branch).
  const wi60 = capText(6);
  ok("policy confinement: with no .candor/config the report's own dir is the root (a sibling policy reads)",
     capById[6].result.isError !== true && wi60.ok === false && wi60.violations.length > 0,
     capById[6].result.content[0].text.slice(0, 160));
  ok("candor_gate with no `policy` arg and no checked-in config is a loud error, never a silent green",
     capById[7].result.isError === true && /no policy/.test(capById[7].result.content[0].text),
     capById[7].result.content[0].text.slice(0, 120));
  fs.rmSync(CAP, { recursive: true, force: true });
}

// ── resources/read: the policy resource, the URI-encoded prefix, refusals, and protocol errors ─────
{
  // a second repo whose checked-in config points OUTSIDE its own tree — the confined read must refuse
  const CONF = fs.mkdtempSync("/tmp/candor-conf-");
  fs.mkdirSync(path.join(CONF, ".candor"));
  fs.writeFileSync(path.join(CONF, ".candor", "report.json"), JSON.stringify({ functions: [{ fn: "c.f", inferred: ["Net"], direct: ["Net"] }] }));
  fs.writeFileSync(path.join(CONF, ".candor", "config"), "policy ../escape.policy\n");
  const confPrefix = path.join(CONF, ".candor", "report");
  const read = (id, uri) => ({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } });
  const resReplies = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    read(2, "candor://policy"),                                                       // default prefix → W's checked-in policy
    read(3, `candor://report?prefix=${encodeURIComponent(confPrefix)}`),              // the URI-encoded prefix is honored
    read(4, `candor://policy?prefix=${encodeURIComponent(confPrefix)}`),              // config escapes the repo → refused
    read(5, "candor://nope"),                                                         // unknown resource → error
    { jsonrpc: "2.0", id: 6, method: "bogus/method" },                                // unknown METHOD → -32601
  ]);
  const resById = Object.fromEntries(resReplies.map((r) => [r.id, r]));
  const pol = resById[2].result?.contents?.[0];
  ok("resources/read candor://policy serves the checked-in §6.2 policy text",
     pol?.mimeType === "text/plain" && pol.text === "deny Net\n", JSON.stringify(resById[2]).slice(0, 160));
  const enc = resById[3].result?.contents?.[0];
  ok("resources/read honors the ?prefix= encoded in the resource URI (not the default report)",
     enc?.mimeType === "application/json" && JSON.parse(enc.text).some((f) => f.fn === "c.f"),
     JSON.stringify(resById[3]).slice(0, 160));
  ok("resources/read refuses a checked-in policy that escapes the repo (confined read, fail closed)",
     resById[4].error?.code === -32602 && /must be within/.test(resById[4].error.message),
     JSON.stringify(resById[4]).slice(0, 160));
  ok("resources/read of an unknown candor:// URI is a protocol error, not silence",
     resById[5].error?.code === -32602 && /unknown resource/.test(resById[5].error.message),
     JSON.stringify(resById[5]).slice(0, 160));
  ok("an unknown METHOD errors -32601 (the JSON-RPC error path)",
     resById[6].error?.code === -32601 && /method not found/.test(resById[6].error.message),
     JSON.stringify(resById[6]).slice(0, 160));
  fs.rmSync(CONF, { recursive: true, force: true });
}

// ── a CORRUPT report is a tool-level ERROR over MCP, never an empty all-clear ──────────────────────
// Q.loadReport tolerates-and-tags (hardFail); the tools ignored the tag, so a corrupt report returned
// a SUCCESSFUL empty result ({gained:[],byFunction:[]}, {} map) where the CLI exits 2 — the §4
// cardinal-sin false all-clear on the agent surface. Also: the BASELINE prefix of diff/gains skipped
// the resolvePrefix existence check (only the main report had it), so a typo'd baseline diffed as
// an authoritative empty. Both now surface as the isError tool result.
{
  const C = fs.mkdtempSync("/tmp/candor-mcpcorrupt-");
  fs.writeFileSync(`${C}/r.json`, `{ "functions": [ { "fn": "x.`); // truncated mid-write
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const cr = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_gains", { report: `${C}/r`, baseline: P }),
    call(3, "candor_map", { report: `${C}/r` }),
    call(4, "candor_diff", { report: P, baseline: `${C}/r` }),
    call(5, "candor_diff", { report: P, baseline: `${C}/no-such` }),
    call(6, "candor_impact", { report: `${C}/r`, fn: "x" }),
  ]);
  const crById = Object.fromEntries(cr.map((r) => [r.id, r]));
  const crText = (id) => crById[id].result.content[0].text;
  ok("mcp corrupt: candor_gains over a corrupt CURRENT report is a loud tool error, never {gained:[]} (all-clear)",
     crById[2].result.isError === true && /refusing to report an empty/.test(crText(2)), crText(2).slice(0, 160));
  ok("mcp corrupt: candor_map over a corrupt report is a loud tool error, never {}",
     crById[3].result.isError === true && /refusing to report an empty/.test(crText(3)), crText(3).slice(0, 160));
  ok("mcp corrupt: candor_diff over a corrupt BASELINE is a loud tool error, never an empty delta",
     crById[4].result.isError === true && /refusing to report an empty/.test(crText(4)), crText(4).slice(0, 160));
  ok("mcp: a baseline prefix matching NO report files is a loud tool error (resolvePrefix), never an empty diff",
     crById[5].result.isError === true && /no report at/.test(crText(5)), crText(5).slice(0, 160));
  ok("mcp corrupt: the fn-existence guard reports the corruption, not a bogus 'no function matching'",
     crById[6].result.isError === true && /refusing to report an empty/.test(crText(6)), crText(6).slice(0, 160));
  fs.rmSync(C, { recursive: true, force: true });
}

// ── a PARTIALLY-corrupt multi-report prefix is a tool error for candor_gate, not a green verdict ────
// The block above only covered "EVERY file failed". The mixed case is the live one, and it is worse on
// this surface than on the CLI: `candor_gate` answered `{ok: true, violations: []}` — a VERDICT, the
// clean bill of health an agent acts on — off the one sibling that survived, while the sibling carrying
// the denied `Net` was dropped with a disclosure written to the SERVER's stderr, which the agent never
// reads. Same rule as the CLI `gate --report`. CONTROLS: the same prefix with B written whole gates
// RED (so the fixture can fire), and candor_map over the partial prefix still ANSWERS (the read-only
// tools keep the looser bar deliberately — a partial answer is a smaller claim than a green gate).
{
  const M = fs.mkdtempSync("/tmp/candor-mcppartial-");
  const V = { candor: { version: "handwritten", toolchain: "none", spec: "0.24" } };
  const clean = { ...V, package: "cleanpkg", analyzed: { count: 3, digest: "aa" }, functions: [{ fn: "a.pureish", inferred: [], direct: [] }] };
  const dirty = { ...V, package: "dirty", analyzed: { count: 1, digest: "bb" },
                  functions: [{ fn: "b.leak", inferred: ["Net"], direct: ["Net"], hosts: ["evil.example"], netClass: ["unknown-host"] }] };
  fs.mkdirSync(`${M}/part`); fs.mkdirSync(`${M}/fire`);
  fs.writeFileSync(`${M}/part/rep.Aclean.scan.json`, JSON.stringify(clean));
  fs.writeFileSync(`${M}/part/rep.Bdirty.scan.json`, `{"candor":{"spec":"0.24"},"package":"dirty","functions":[{"fn":"b.leak","inferred":[`);
  fs.writeFileSync(`${M}/fire/rep.Aclean.scan.json`, JSON.stringify(clean));
  fs.writeFileSync(`${M}/fire/rep.Bdirty.scan.json`, JSON.stringify(dirty));
  fs.writeFileSync(`${M}/part/deny.pol`, "deny Net\n");   // policy confinement: it must live in the report's own repo
  fs.writeFileSync(`${M}/fire/deny.pol`, "deny Net\n");
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const pr = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_gate", { report: `${M}/part/rep`, policy: `${M}/part/deny.pol` }),
    call(3, "candor_gate", { report: `${M}/fire/rep`, policy: `${M}/fire/deny.pol` }),
    call(4, "candor_map", { report: `${M}/part/rep` }),
  ]);
  const pById = Object.fromEntries(pr.map((r) => [r.id, r]));
  const pText = (id) => pById[id].result.content[0].text;
  ok("mcp partial: candor_gate over a PARTIALLY-corrupt multi-report prefix is a loud tool error, never {ok:true,violations:[]}",
     pById[2].result.isError === true && /did not load cleanly/.test(pText(2)) && !/"ok": ?true/.test(pText(2)), pText(2).slice(0, 200));
  ok("mcp partial: CONTROL — the SAME prefix with B written whole gates RED (the fixture can fire)",
     pById[3].result.isError !== true && JSON.parse(pText(3)).ok === false && JSON.parse(pText(3)).violations.length === 1, pText(3).slice(0, 200));
  ok("mcp partial: CONTROL — a read-only tool over the same partial prefix still ANSWERS (the bar is raised only for the verdict)",
     pById[4].result.isError !== true, pText(4).slice(0, 160));
  fs.rmSync(M, { recursive: true, force: true });
}

fs.rmSync(W, { recursive: true, force: true });
// ── candor_activity: the edit-time gate's self-inspection tool (FEEDBACK-SPEC "richer MCP push") ──
{
  const A = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-act-"));
  fs.mkdirSync(path.join(A, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(A, ".candor", "activity.jsonl"), [
    '{"ts":"2026-07-14T10:00:00Z","sessionId":"s1","engine":"candor-scan","edited":null,"gained":["Fs"],"blastRadius":3,"maxHops":2,"verdict":"blocked","violations":["AS-EFF-006"],"unknowns":0,"effects":["Fs"],"reviewMs":100}',
    '{ corrupt line — skipped }',
    '{"ts":"2026-07-14T11:00:00Z","sessionId":"s2","engine":"candor-scan","edited":null,"gained":[],"blastRadius":0,"verdict":"clean","violations":[],"unknowns":0,"effects":["Fs"],"reviewMs":50}',
  ].join("\n") + "\n");
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const ar = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_activity", { log: `${A}/.candor/activity.jsonl` }),
    call(3, "candor_activity", { log: `${A}/.candor/activity.jsonl`, session: "s1" }),
    call(4, "candor_activity", { log: `${A}/.candor/no-such.jsonl` }),
    call(5, "candor_activity", { log: "../../etc/passwd" }),
  ], ["--root", A]);
  const aById = Object.fromEntries(ar.map((r) => [r.id, r]));
  const aj = (id) => JSON.parse(aById[id].result.content[0].text);
  ok("activity: summary counts edits/verdicts and skips the corrupt line",
     aj(2).edits === 2 && aj(2).blocked === 1 && aj(2).clean === 1, aById[2].result.content[0].text.slice(0, 160));
  ok("activity: violations by code + effectsIntroduced + blast + deepestPropagation aggregated",
     aj(2).violations["AS-EFF-006"] === 1 && aj(2).effectsIntroduced.includes("Fs")
       && aj(2).largestBlastRadius === 3 && aj(2).deepestPropagation === 2, aById[2].result.content[0].text.slice(0, 200));
  ok("activity: recent records returned (most recent last)",
     aj(2).recent.length === 2 && aj(2).recent[1].sessionId === "s2");
  ok("activity: session filter narrows to one record", aj(3).edits === 1 && aj(3).blocked === 1);
  ok("activity: a missing log is an empty result with a wiring note, NOT an error",
     aById[4].result.isError !== true && aj(4).edits === 0 && /isn't wired/.test(aj(4).note || ""));
  ok("activity: a log path escaping --root is REFUSED (confinement)",
     aById[5].result.isError === true && /outside the served workspace/.test(aById[5].result.content[0].text));
  // no report exists under A at all — the tool must not demand one (noReport dispatch).
  ok("activity: works with NO report in the workspace (log-only tool needs no scan)",
     aById[2].result.isError !== true);

  // ── the default-log anchor ladder: the documented `CANDOR_REPORT=/repo/.candor/report npx
  // candor-ts-mcp` invocation, run from a DIFFERENT cwd (this test's), no --root, no `log` arg — the
  // default must resolve beside the served report prefix, not against the process cwd (which found
  // nothing). The old anchor was WORKSPACE_ROOT ?? cwd.
  const viaPrefix = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_activity", {}),
  ], [], { CANDOR_REPORT: path.join(A, ".candor", "report") });
  const vp = JSON.parse(viaPrefix.find((r) => r.id === 2).result.content[0].text);
  ok("activity: the DEFAULT log resolves beside $CANDOR_REPORT from a different cwd (anchor ladder, not cwd)",
     vp.edits === 2 && vp.blocked === 1 && vp.log === path.join(A, ".candor", "activity.jsonl"),
     viaPrefix.find((r) => r.id === 2).result.content[0].text.slice(0, 200));

  // ── `since` filters TEMPORALLY, not bytewise: an offset-variant bound ("…T11:30:00+01:00" ==
  // 10:30:00Z) sorts lexicographically AFTER both Z-form record timestamps — the old compare dropped
  // everything; temporally it must keep the 11:00Z record. A record whose ts doesn't parse is KEPT
  // (the null-ts posture); an unparseable `since` falls back to the lexicographic compare.
  fs.writeFileSync(path.join(A, ".candor", "since.jsonl"), [
    '{"ts":"2026-07-14T10:00:00Z","verdict":"clean","gained":[],"blastRadius":0}',
    '{"ts":"2026-07-14T11:00:00Z","sessionId":"late","verdict":"blocked","gained":["Net"],"blastRadius":1}',
    '{"ts":"not a timestamp","verdict":"clean","gained":[],"blastRadius":0}',
  ].join("\n") + "\n");
  const sr = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_activity", { log: `${A}/.candor/since.jsonl`, since: "2026-07-14T11:30:00+01:00" }),  // == 10:30Z
    call(3, "candor_activity", { log: `${A}/.candor/since.jsonl`, since: "2026-07-14T10:30:00.000Z" }),   // millis variant
    call(4, "candor_activity", { log: `${A}/.candor/since.jsonl`, since: "zzz-not-a-date" }),             // unparseable bound
  ], ["--root", A]);
  const sj = (id) => JSON.parse(sr.find((r) => r.id === id).result.content[0].text);
  ok("activity since: an OFFSET-variant bound filters temporally (keeps 11:00Z + the unparseable-ts record)",
     sj(2).edits === 2 && sj(2).blocked === 1 && sj(2).recent.some((r) => r.sessionId === "late"),
     sr.find((r) => r.id === 2).result.content[0].text.slice(0, 200));
  ok("activity since: a millis-variant bound filters the same way (and unparseable record ts stays KEPT)",
     sj(3).edits === 2 && sj(3).recent.some((r) => r.ts === "not a timestamp"),
     sr.find((r) => r.id === 3).result.content[0].text.slice(0, 200));
  ok("activity since: an unparseable bound falls back to the lexicographic compare (all three below 'zzz…' drop)",
     sj(4).edits === 0, sr.find((r) => r.id === 4).result.content[0].text.slice(0, 160));
  fs.rmSync(A, { recursive: true, force: true });
}

// ---- ⟨0.24⟩ the MCP `candor_gate` tool SHARES `evaluatePolicy` with `gate --report` ---------------
// SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST APPLY THE SAME RULE, AND SHOULD SHARE THE SAME CODE."
// `gate --report` lands in the same `evaluatePolicy` this tool does, so the correctness argument for one
// is the correctness argument for the other — and this tool reads WHATEVER report the caller points it
// at, including a foreign one. The ⟨0.20⟩ destination class is where that bites: `netClass` records the
// PRODUCER's `net-partner` judgment, and that config does not ride the wire, so re-deriving the class
// from `hosts` here answered with the CONSUMER's evidence about someone else's project — a FABRICATED
// `deny Net[unknown-host]` hit in one direction and a `deny Net[known-partner]` that silently stops
// firing in the other. Both arms asserted, over a report this machine did not produce.
{
  const F = fs.mkdtempSync("/tmp/candor-mcp-foreign-");
  fs.writeFileSync(`${F}/r.json`, JSON.stringify({
    candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 1, digest: "0" },
    functions: [{ fn: "app.call", inferred: ["Net"], direct: ["Net"], hosts: ["partner.example"], netClass: ["known-partner"] }],
  }));
  fs.writeFileSync(`${F}/u.pol`, "deny Net[unknown-host]\n");
  fs.writeFileSync(`${F}/k.pol`, "deny Net[known-partner]\n");
  const gcall = (id, pol) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "candor_gate", arguments: { report: `${F}/r`, policy: `${F}/${pol}` } } });
  const gr = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               gcall(2, "u.pol"), gcall(3, "k.pol")], [], { CANDOR_REPORT: `${F}/r` });
  const gt = (id) => JSON.parse(gr.find((r) => r.id === id).result.content[0].text);
  ok("candor_gate: `netClass` VERBATIM over a FOREIGN report — `deny Net[unknown-host]` does not fire on a producer-declared `known-partner` host (a re-derivation fabricates a violation here)",
     gt(2).ok === true && gt(2).violations.length === 0, JSON.stringify(gt(2)).slice(0, 200));
  ok("candor_gate: …and `deny Net[known-partner]` DOES fire on it (a re-derivation would silently tolerate)",
     gt(3).ok === false && gt(3).violations[0]?.fn === "app.call"
     && eq(gt(3).violations[0]?.netClass, ["known-partner"]), JSON.stringify(gt(3)).slice(0, 200));
  fs.rmSync(F, { recursive: true, force: true });
}

// ⟨0.24⟩ A REPORT THAT JUDGED NOTHING IS NOT A CLEAN BILL OF HEALTH — SPEC §2's three-row table, bound
// to this surface by §3.1 ("the obligation is on the reading, not on the route by which the report
// arrived"). This tool gates whatever `report` points at, with no version check, so it is exactly how a
// foreign count-0 report reaches an AGENT — and `{ok: true, violations: []}` over one says the code is
// clean when nothing in it was ever judged. The caveat is ADDITIVE: `ok`/`violations` keep their meaning
// (the report asserts no effect, so asserting one here would be fabrication) and the field is absent on
// every ordinary report, which is what the CONTROL row pins.
{
  const F = fs.mkdtempSync("/tmp/candor-mcp-unjudged-");
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app" };
  fs.writeFileSync(`${F}/zero.json`, JSON.stringify({ ...V, analyzed: { count: 0, digest: "0" }, functions: [] }));
  fs.writeFileSync(`${F}/allpure.json`, JSON.stringify({ ...V, analyzed: { count: 2, digest: "0" }, functions: [] }));
  fs.writeFileSync(`${F}/p.pol`, "deny Net\n");
  const ucall = (id, rep) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "candor_gate", arguments: { report: `${F}/${rep}`, policy: `${F}/p.pol` } } });
  const ur = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               ucall(2, "zero"), ucall(3, "allpure")], [], { CANDOR_REPORT: `${F}/zero` });
  const ut = (id) => JSON.parse(ur.find((r) => r.id === id).result.content[0].text);
  ok("candor_gate: ⟨0.24⟩ a count-0 report is flagged `judgedNothing` with a caveat — a green verdict over it certifies nothing",
     ut(2).ok === true && ut(2).judgedNothing === true && /judged NOTHING/.test(ut(2).caveat ?? ""),
     JSON.stringify(ut(2)).slice(0, 240));
  ok("candor_gate: ⟨0.24⟩ CONTROL — count n>0 with the SAME empty `functions` carries no caveat (§2 rule 3's all-pure claim, believed)",
     ut(3).ok === true && ut(3).judgedNothing === undefined && ut(3).caveat === undefined,
     JSON.stringify(ut(3)).slice(0, 240));
  fs.rmSync(F, { recursive: true, force: true });
}

// ── ⟨0.24⟩ THE AGENT-FACING GATE TAKES THE POLICY-ERROR POSTURE, AND RESOLVES THE VOCABULARY ──────
// `candor_gate` is a GATE, and it called `parsePolicy(text)` with no alias map and no error check. Two
// live fail-opens on the surface an agent trusts most: an aliased rule was silently WIDENED to the bare
// effect (so the same policy meant one thing here and another in the CLI gate that judges the edit), and
// after §6.2 `be0b9a9` an unrecognised token would have kept enforcing a policy the engine cannot honour
// as written — the NARROWING case, which stops gating what the operator spelled while the gate still
// looks armed. Both rows drive the real MCP session; the CONTROL is what keeps the row from passing on a
// tool that has simply started erroring on every policy.
{
  const G = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-pol-"));
  fs.mkdirSync(path.join(G, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(G, "app.ts"),
    'export function dyn(o: any, k: string) { return o[k](); }\n');
  execFileSync("node", [path.join(HERE, "scan.mjs"), G, "--out", path.join(G, ".candor", "report")],
               { stdio: "ignore" });
  // TWO aliases, and the second is the whole point. The entry's Unknown is `callback:`-caused ⇒ class
  // `indirect`, so `fires = indirect` fires and `tolerates = reflect` must NOT. An engine that ignores
  // the alias map drops the token and WIDENS the rule to a bare `deny Unknown`, which fires on BOTH — so
  // the firing row alone cannot tell "the alias resolved" from "the alias was ignored".
  fs.writeFileSync(path.join(G, ".candor", "config"),
                   "unknown-alias fires = indirect\nunknown-alias tolerates = reflect\n");
  fs.writeFileSync(path.join(G, "typo.pol"), "deny Unknown[dispatch,nativ] app\n");
  fs.writeFileSync(path.join(G, "alias.pol"), "deny Unknown[fires] app\n");
  fs.writeFileSync(path.join(G, "tolerate.pol"), "deny Unknown[tolerates] app\n");
  fs.writeFileSync(path.join(G, "plain.pol"), "deny Unknown app\n");
  const RP = path.join(G, ".candor", "report");
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const gr = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "candor_gate", { report: RP, policy: path.join(G, "typo.pol") }),
    call(3, "candor_gate", { report: RP, policy: path.join(G, "alias.pol") }),
    call(4, "candor_gate", { report: RP, policy: path.join(G, "plain.pol") }),
    call(5, "candor_gate", { report: RP, policy: path.join(G, "tolerate.pol") }),
  ], ["--root", G]);
  const gById = Object.fromEntries(gr.map((r) => [r.id, r]));
  const txt = (id) => gById[id].result.content[0].text;
  ok("⟨0.24⟩ candor_gate: an unrecognised policy token is a POLICY ERROR — the tool errors naming the token, it does not enforce a rule it silently rewrote",
     gById[2].result.isError === true && /nativ/.test(txt(2)), txt(2).slice(0, 200));
  const aliased = JSON.parse(txt(3)), plain = JSON.parse(txt(4)), tolerated = JSON.parse(txt(5));
  // THE DISCRIMINATING PAIR. Before the fix the firing row passed FOR THE WRONG REASON — the token was
  // dropped, the rule widened to a bare `deny Unknown`, and a widened rule fires too. Only the tolerating
  // arm separates the two readings, and it is the one that regresses.
  ok("⟨0.24⟩ candor_gate: a `.candor/config` alias RESOLVES here as it does at the CLI gate — the class it names FIRES, and a class it does not name is TOLERATED (a dropped-and-widened rule would fire on both)",
     gById[3].result.isError !== true && aliased.ok === false && aliased.violations.length === 1
       && gById[5].result.isError !== true && tolerated.ok === true && tolerated.violations.length === 0,
     `fires=${txt(3).slice(0, 140)} tolerates=${txt(5).slice(0, 140)}`);
  ok("⟨0.24⟩ candor_gate CONTROL: an ordinary policy with no alias and no typo still gates normally",
     gById[4].result.isError !== true && plain.ok === false && plain.violations.length === 1,
     txt(4).slice(0, 200));
  fs.rmSync(G, { recursive: true, force: true });
}

// ── ⟨0.24⟩ THE AGENT-FACING GATE HAD NO WITHHOLD PATH, AND BOTH DIRECTIONS OF HARM WERE LIVE ───────
// SPEC §3.1's answerability rule reached `gate --report` and stopped there, because that is where it was
// written. `mcp.mjs` called the SAME `evaluatePolicy` with no `withhold` predicate and the DEFAULT
// netClass mode, so on the surface an agent trusts and no human reads, one report and one policy gave:
//
//   deny Unknown[reflect] app   -> CLI exit 2 (refused);  MCP {"ok":true,"violations":[]}   FALSE ALL-CLEAR
//   deny Net[unknown-host] app  -> CLI exit 2 (refused);  MCP FIRES, asserting
//                                                         "netClass":["unknown-host"] the report never carried
//
// The report is FOREIGN and handwritten on purpose: `app.handler`'s `Unknown` is INHERITED with no
// `unknownWhy` and no `calls` edge (the reason channel is simply absent), and `app.fetcher` carries `Net`
// with no `netClass` — the two shapes the two narrowing filters read. THE CONTROL is what makes the rows
// mean anything: bare `deny Unknown` must still FIRE, or a tool that had simply stopped gating would pass
// the first two rows. The last row is the precedence half (SPEC §3.1 `7271c69`): a certain `deny Fs`
// beside the unanswerable rule must produce the violation AND the disclosure, never one or the other.
{
  const A = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-withhold-"));
  fs.writeFileSync(`${A}/r.json`, JSON.stringify({
    candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 3, digest: "0" },
    functions: [
      { fn: "app.handler", inferred: ["Unknown"], direct: [], unresolved: true },
      { fn: "app.fetcher", inferred: ["Net"], direct: ["Net"], hosts: ["example.com"] },
      { fn: "app.writes", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] },
    ],
  }));
  fs.writeFileSync(`${A}/reflect.pol`, "deny Unknown[reflect] app\n");
  fs.writeFileSync(`${A}/net.pol`, "deny Net[unknown-host] app\n");
  fs.writeFileSync(`${A}/control.pol`, "deny Unknown app\n");
  fs.writeFileSync(`${A}/both.pol`, "deny Fs app\ndeny Unknown[reflect] app\n");
  const wcall = (id, pol) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "candor_gate", arguments: { report: `${A}/r`, policy: `${A}/${pol}` } } });
  const wr = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               wcall(2, "reflect.pol"), wcall(3, "net.pol"),
                               wcall(4, "control.pol"), wcall(5, "both.pol")], [], { CANDOR_REPORT: `${A}/r` });
  const wt = (id) => JSON.parse(wr.find((r) => r.id === id).result.content[0].text);
  ok("⟨0.24⟩ candor_gate: a scoped `deny Unknown[reflect]` the report cannot answer is REFUSED, not answered green — `ok:false`, `refused:true`, and NO `violations` key (an absent key, never `[]`)",
     wt(2).ok === false && wt(2).refused === true && !("violations" in wt(2))
     && wt(2).unevaluated?.[0]?.rule === "deny Unknown[reflect] app"
     && /no reason reachable/.test(wt(2).unevaluated?.[0]?.why ?? ""),
     JSON.stringify(wt(2)).slice(0, 260));
  ok("⟨0.24⟩ candor_gate: a scoped `deny Net[unknown-host]` over a `netClass`-less entry is REFUSED — it no longer FIRES asserting a destination class the report never carried",
     wt(3).ok === false && wt(3).refused === true && !("violations" in wt(3))
     && wt(3).unevaluated?.[0]?.rule === "deny Net[unknown-host] app"
     // and the ASSERTION is gone, not merely relabelled: nothing in the result STATES a `netClass` the
     // report never carried. The disclosure NAMES the absent field in prose, by design, so the test looks
     // for the JSON key rather than the word.
     && !/"netClass"/.test(JSON.stringify(wt(3))),
     JSON.stringify(wt(3)).slice(0, 260));
  ok("⟨0.24⟩ candor_gate CONTROL: the bare `deny Unknown` still FIRES on the same entry — the channel is narrowed, not dead",
     wt(4).ok === false && wt(4).violations?.length === 1 && wt(4).violations[0].fn === "app.handler"
     && wt(4).refused === undefined,
     JSON.stringify(wt(4)).slice(0, 260));
  ok("⟨0.24⟩ candor_gate PRECEDENCE: a certain `deny Fs` violation beside the unanswerable rule is IN the result, with `unevaluated` alongside — a refusal never deletes a certain violation",
     wt(5).ok === false && wt(5).violations?.length === 1 && wt(5).violations[0].rule === "AS-EFF-006"
     && wt(5).violations[0].fn === "app.writes" && wt(5).unevaluated?.length === 1
     && wt(5).refused === undefined,
     JSON.stringify(wt(5)).slice(0, 300));
  fs.rmSync(A, { recursive: true, force: true });
}

// ── ⟨0.21⟩ candor_gate IMPLEMENTED NO INCOMPLETENESS RULE AT ALL ───────────────────────────────────
// A report DECLARING `unanalyzed` says candor could not see part of the code it is describing; a `deny`
// that "passes" over invisible effects is a false-pure. `scan --policy` exits 2 on its own manifest and
// `gate --report` exits 2 on the report's, and this tool returned `{ok:true,violations:[]}` over the same
// bytes. The CONTROL is the identical report with the manifest removed, so the row cannot pass on a tool
// that has started flagging everything.
{
  const I = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-incomplete-"));
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app",
              analyzed: { count: 1, digest: "0" },
              functions: [{ fn: "app.fetcher", inferred: ["Net"], direct: ["Net"], hosts: ["x"], netClass: ["unknown-host"] }] };
  fs.writeFileSync(`${I}/inc.json`, JSON.stringify({ ...V, unanalyzed: [{ path: "src/broken.ts", reason: "parse error" }] }));
  fs.writeFileSync(`${I}/ok.json`, JSON.stringify(V));
  fs.writeFileSync(`${I}/p.pol`, "deny Fs app\n");
  const icall = (id, rep) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "candor_gate", arguments: { report: `${I}/${rep}`, policy: `${I}/p.pol` } } });
  const ir = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               icall(2, "inc"), icall(3, "ok")], [], { CANDOR_REPORT: `${I}/inc` });
  const it = (id) => JSON.parse(ir.find((r) => r.id === id).result.content[0].text);
  ok("⟨0.21⟩ candor_gate: a report declaring `unanalyzed` cannot gate GREEN — ok:false, incomplete:true, and the units named (the CLI exits 2 on the same bytes)",
     it(2).ok === false && it(2).incomplete === true && it(2).unanalyzed?.[0]?.path === "src/broken.ts"
     && Array.isArray(it(2).violations) && it(2).violations.length === 0,
     JSON.stringify(it(2)).slice(0, 260));
  ok("⟨0.21⟩ candor_gate CONTROL: the SAME report without the manifest gates green and carries no `incomplete` key",
     it(3).ok === true && it(3).incomplete === undefined && it(3).unanalyzed === undefined,
     JSON.stringify(it(3)).slice(0, 260));
  fs.rmSync(I, { recursive: true, force: true });
}

// ── ⟨0.24⟩ THE SAME RULE ON candor_unverified — the OTHER CHANNEL (SPEC §3.2 `ec1a441`) ─────────────
// `candor_gate` above refuses to read green over a declared manifest. `candor_unverified` read the same
// bytes and returned `ok: true` with an empty array — on the surface an agent trusts and no human reads,
// for the verb whose entire job is "your green gate is not provably green". The rule binds EVERY channel
// a verb answers on, not just the CLI's JSON, so this is asserted here and not inferred from the CLI row.
// ABSENCE is asserted, never falsiness: `ok:false` would satisfy a `!ok` test while being the fabrication
// the rule forbids (a hole claimed beside an empty array).
{
  const I = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-uvinc-"));
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app",
              analyzed: { count: 1, digest: "0" },
              functions: [{ fn: "app.port", inferred: ["Unknown"], direct: ["Unknown"],
                            unknownWhy: ["dispatch:x"], calls: [] }] };
  fs.writeFileSync(`${I}/inc.json`, JSON.stringify({ ...V, unanalyzed: [{ path: "src/broken.ts", reason: "parse error" }] }));
  fs.writeFileSync(`${I}/ok.json`, JSON.stringify(V));
  fs.writeFileSync(`${I}/p.pol`, "pure app\n");
  const ucall = (id, rep) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "candor_unverified", arguments: { report: `${I}/${rep}`, policy: `${I}/p.pol` } } });
  const ur = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               ucall(2, "inc"), ucall(3, "ok")], [], { CANDOR_REPORT: `${I}/inc` });
  const ut = (id) => JSON.parse(ur.find((r) => r.id === id).result.content[0].text);
  ok("⟨0.24⟩ candor_unverified over a report declaring `unanalyzed`: `ok` is ABSENT, incomplete:true + the manifest take its place (the agent surface is a channel this rule binds)",
     !("ok" in ut(2)) && ut(2).incomplete === true && ut(2).unanalyzed?.[0]?.path === "src/broken.ts"
     && Array.isArray(ut(2).unverified),
     JSON.stringify(ut(2)).slice(0, 260));
  ok("⟨0.24⟩ candor_unverified CONTROL: the SAME report without the manifest still carries `ok`, still finds the hole, and has no `incomplete` key",
     ut(3).ok === false && ut(3).incomplete === undefined && ut(3).unanalyzed === undefined
     && ut(3).unverified?.[0]?.fn === "app.port",
     JSON.stringify(ut(3)).slice(0, 260));
  fs.rmSync(I, { recursive: true, force: true });
}

// ── ⟨0.24⟩ THE ADVISORY-CONFIDENCE LAW ON THE AGENT SURFACE (SPEC §3.2 `4fd140c`) ───────────────────
// An advisory verb may be LESS certain than the gate, NEVER MORE. Over a report carrying `hosts` and no
// `netClass`, `candor_gate` REFUSES (`refused:true`, no `violations` key) while `candor_unverified` cleared
// the function from a FALLBACK DERIVATION and `candor_fix` answered `crossing:false, reason:"not-forbidden"`
// — a derived all-clear, delivered to an agent, about the one boundary the gate declined to adjudicate.
// Asserted HERE rather than inferred from the CLI rows: the rule binds every channel a verb answers on, and
// this channel has no exit code and no human reading it.
//
// THE DECOY IS DELIBERATE. `app.nativeHole` is a provable-purity hole under the same policy, so a check that
// only asks "did the verb return anything?" passes while `app.noClass` is silently cleared — which is
// exactly how the weaker form of the conformance row passed on all four engines while the defect stood.
{
  const B = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-bound-"));
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app",
              analyzed: { count: 2, digest: "0" },
              functions: [{ fn: "app.nativeHole", inferred: ["Unknown"], direct: ["Unknown"],
                            unknownWhy: ["native:dlopen"], calls: [] },
                          { fn: "app.noClass", inferred: ["Net"], direct: ["Net"],
                            hosts: ["api.example.com"], calls: [] }] };
  // The MIRROR: the identical shape with the evidence ON THE WIRE. Nothing here is unanswerable, so the
  // tools must answer exactly as before — this is the row that fails if the fix over-reports.
  const M = { ...V, functions: [{ fn: "app.hasClass", inferred: ["Net"], direct: ["Net"],
                                  hosts: ["api.example.com"], netClass: ["unknown-host"], calls: [] }] };
  fs.writeFileSync(`${B}/r.json`, JSON.stringify(V));
  fs.writeFileSync(`${B}/r.callgraph.json`, JSON.stringify({ "app.nativeHole": [], "app.noClass": [] }));
  fs.writeFileSync(`${B}/m.json`, JSON.stringify(M));
  fs.writeFileSync(`${B}/m.callgraph.json`, JSON.stringify({ "app.hasClass": [] }));
  fs.writeFileSync(`${B}/p.pol`, "deny Net[unknown-host] app\n");
  const bcall = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: { policy: `${B}/p.pol`, ...args } } });
  const br = await mcpSession([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
                               bcall(2, "candor_gate", { report: `${B}/r` }),
                               bcall(3, "candor_unverified", { report: `${B}/r` }),
                               bcall(4, "candor_fix", { report: `${B}/r`, fn: "app.noClass", effect: "Net" }),
                               bcall(5, "candor_unverified", { report: `${B}/m` }),
                               bcall(6, "candor_fix", { report: `${B}/m`, fn: "app.hasClass", effect: "Net" })],
                              [], { CANDOR_REPORT: `${B}/r` });
  const bt = (id) => JSON.parse(br.find((r) => r.id === id).result.content[0].text);
  ok("⟨0.24⟩ advisory-bound (MCP): the ORACLE — `candor_gate` REFUSES over `hosts` with no `netClass`, naming `app.noClass`, with NO `violations` key",
     bt(2).ok === false && bt(2).refused === true && !("violations" in bt(2))
     && /app\.noClass/.test(bt(2).unevaluated?.[0]?.why ?? ""),
     JSON.stringify(bt(2)).slice(0, 300));
  ok("⟨0.24⟩ advisory-bound (MCP): `candor_unverified` NAMES `app.noClass` — the function the gate could not judge — and not merely the decoy hole a bare non-empty check would accept",
     (bt(3).unverified ?? []).some((h) => h.fn === "app.noClass")
     && (bt(3).unverified ?? []).some((h) => h.fn === "app.nativeHole"),
     JSON.stringify(bt(3)).slice(0, 400));
  ok("⟨0.24⟩ advisory-bound (MCP): …with THE MISSING EVIDENCE as the reason and no `upgrade`, `ok` ABSENT, and the gate's own `unevaluated:[{rule,why}]` beside it",
     !("ok" in bt(3)) && bt(3).unevaluated?.[0]?.rule === "deny Net[unknown-host] app"
     && (() => { const h = (bt(3).unverified ?? []).find((x) => x.fn === "app.noClass");
                 return /no `netClass` in this report/.test(h?.why ?? "") && !("upgrade" in (h ?? {})); })(),
     JSON.stringify(bt(3)).slice(0, 400));
  ok("⟨0.24⟩ advisory-bound (MCP): `candor_fix` REFUSES instead of answering `crossing:false` — NO `crossing` key at all, because 'no boundary fix needed' is the one claim it cannot make here",
     bt(4).refused === true && !("crossing" in bt(4)) && bt(4).unevaluated?.length === 1
     && bt(4).fn === "app.noClass",
     JSON.stringify(bt(4)).slice(0, 300));
  ok("⟨0.24⟩ advisory-bound (MCP) MIRROR: with `netClass` on the wire nothing is refused — `candor_unverified` carries `ok` with no `unevaluated`, and `candor_fix` still returns a real `crossing:true` remedy",
     bt(5).ok === true && bt(5).unevaluated === undefined && bt(5).unverified?.length === 0
     && bt(6).crossing === true && bt(6).refused === undefined,
     `uv=${JSON.stringify(bt(5)).slice(0, 200)} fix=${JSON.stringify(bt(6)).slice(0, 200)}`);
  fs.rmSync(B, { recursive: true, force: true });
}

// ---- ⟨0.28⟩ SPEC §2 — THE ⟨0.21⟩ MANIFEST REACHES THE AGENT CHANNEL TOO --------------------------
// The CLI and this server are ONE implementation, so a caveat shipped on one of them is a caveat the
// other silently drops. MEASURED here before the fix, over the standard post-failure artifact
// (`analyzed.count: 0` + a non-empty `unanalyzed`): `candor_where` → `{"directly":[],"inherited":[]}`,
// `candor_map` → `{}`, `candor_blindspots` → `{"sources":[],"totalUnknown":0}`, `candor_reachable` →
// `{"entryPoints":0,"effects":{}}`, `candor_containment` → `{"contained":[],"ambient":{}}` — five flat
// all-clears. The agent is the consumer that CANNOT ASK A FOLLOW-UP QUESTION: a loop reading
// `sources.length === 0` records "no blind spots" and moves on. (`candor_show`/`candor_impact` already
// fail closed here on the fn-existence guard, which is why they are not in this matrix.)
{
  const A = fs.mkdtempSync(path.join(os.tmpdir(), "candor-mcp-desc-"));
  // Its own scan: the top-of-file fixture `W` is removed long before this block, and reusing a deleted
  // prefix would make every row below pass on a tool error rather than on an answer.
  fs.writeFileSync(`${A}/app.ts`, `import * as http from "node:http";
export function leaf(): void { http.get("http://x"); }
export function mid(): void { leaf(); }
`);
  execFileSync("node", [`${HERE}/scan.mjs`, `${A}/app.ts`, `${A}/base`], { stdio: "ignore" });
  const P = `${A}/base`;
  const src = JSON.parse(fs.readFileSync(`${P}.json`, "utf8"));
  const mk = (name, mut) => { const doc = JSON.parse(JSON.stringify(src)); mut(doc);
                              fs.writeFileSync(`${A}/${name}.json`, JSON.stringify(doc)); return `${A}/${name}`; };
  const armedP = mk("armed", (o) => { o.functions = []; o.analyzed = { count: 0 };
                                      o.unanalyzed = [{ path: "src/gone.ts", reason: "parse error" }]; });
  const c0P = mk("count0", (o) => { o.functions = []; o.analyzed = { count: 0 }; delete o.unanalyzed; });
  const pureP = mk("allpure", (o) => { o.functions = []; o.analyzed = { count: 9 }; delete o.unanalyzed; });
  const TOOLS5 = [["candor_where", { effect: "Net" }], ["candor_map", {}], ["candor_blindspots", {}],
                  ["candor_reachable", {}], ["candor_containment", {}]];
  const callAll = async (pfx) => {
    const rs = await mcpSession(TOOLS5.map(([name, a], i) =>
      ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: { ...a, report: pfx } } })));
    const by = Object.fromEntries(rs.map((r) => [r.id, r]));
    return TOOLS5.map(([name], i) => [name, JSON.parse(by[i + 1].result.content[0].text)]);
  };
  // A + D: BOTH causes. `unanalyzed` says candor could not READ a file; `analyzed.count: 0` says it
  // reached no conclusion and therefore names no file at all — a manifest-only reader sees that second
  // one as a complete report, which is exactly how it stayed invisible.
  for (const [cause, pfx, wantUnan] of [["an armed", armedP, true], ["a count-0, NO-`unanalyzed`,", c0P, false]])
    for (const [name, doc] of await callAll(pfx))
      ok(`⟨0.28⟩ ${name} over ${cause} report carries \`incomplete: true\` — an agent cannot otherwise tell "nobody performs this" from "nothing was examined"`,
         doc.incomplete === true
         // The ARRAY of report paths — the cross-engine wire shape (rust/java/swift); the boolean
         // spelling is the MCP gate tool's own flag, a different surface (see mcp.mjs).
         && Array.isArray(doc.judgedNothing) && doc.judgedNothing[0] === `${pfx}.json`
         && (wantUnan ? doc.unanalyzed?.length === 1 : !("unanalyzed" in doc)),
         JSON.stringify(doc).slice(0, 240));
  // B: an INTACT report is untouched — a hedge on every call is one an agent learns to ignore.
  for (const [name, doc] of await callAll(P))
    ok(`⟨0.28⟩ CONTROL: ${name} over an INTACT report is unhedged — its pinned shape is unchanged`,
       !("incomplete" in doc) && !("judgedNothing" in doc), JSON.stringify(doc).slice(0, 200));
  // …and the ⟨0.24⟩ mirror: `analyzed.count: 9` with `functions: []` is a purity CLAIM rule 3 requires a
  // consumer to believe, not a silence. Hedging it would withdraw the claim this rung exists to protect.
  for (const [name, doc] of await callAll(pureP))
    ok(`⟨0.28⟩ CONTROL: ${name} over an ALL-PURE report (\`analyzed.count: 9\`, \`functions: []\`) does NOT hedge`,
       !("incomplete" in doc), JSON.stringify(doc).slice(0, 200));
  fs.rmSync(A, { recursive: true, force: true });
}

console.log(`\ntest-mcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
