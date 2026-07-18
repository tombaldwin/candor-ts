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
fs.writeFileSync(`${M}/r.gate.json`, JSON.stringify({ spec: "0.22", ok: true, violations: [] }));
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
  const doc = (extra) => JSON.stringify({ candor: { version: "eeeeeee", spec: "0.22" },
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

console.log(`\ntest-mcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
