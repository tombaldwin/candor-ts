#!/usr/bin/env node
/**
 * Tests for query-core.mjs (the shared query functions) and mcp.mjs (the MCP server, driven over its
 * real stdio JSON-RPC transport). Cross-checks the shared queries against the conformance-verified
 * query.mjs so query-core can't drift from the canonical CLI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
const merged = Q.loadReport(`${M}/r`);
ok("cross-engine loader: a multi-report prefix merges every sibling (Rust/workspace form)",
   merged.length === 2 && merged.some((e) => e.fn === "a::f") && merged.some((e) => e.fn === "b::g"));
ok("cross-engine loader: the callgraph sidecars merge too",
   "a::f" in Q.loadCallgraph(`${M}/r`) && "b::g" in Q.loadCallgraph(`${M}/r`));
fs.rmSync(M, { recursive: true, force: true });

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
function cli(args) { return JSON.parse(execFileSync("node", [`${HERE}/query.mjs`, ...args], { encoding: "utf8" })); }
ok("query-core where == query.mjs where (canonical, conformance-verified)",
   eq(Q.where(fns, "Net"), cli(["where", P, "Net"])));
ok("query-core callers == query.mjs callers", eq(Q.callers(cg, "leaf"), cli(["callers", P, "leaf"])));
ok("query-core reachable == query.mjs reachable", eq(Q.reachable(fns), cli(["reachable", P])));
ok("query-core map == query.mjs map", eq(Q.map(fns), cli(["map", P])));

// ---- the MCP server, over its real stdio JSON-RPC transport --------------------------------------
function mcpSession(requests) {
  return new Promise((resolve) => {
    const srv = spawn("node", [`${HERE}/mcp.mjs`], { env: { ...process.env, CANDOR_REPORT: P } });
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
]);
const toolText = (id) => JSON.parse(extra.find((r) => r.id === id).result.content[0].text);
const gate = toolText(2);
ok("mcp: candor_gate resolves the checked-in .candor/config policy (no args) and fails the violating repo",
   gate.ok === false && gate.violations.some((v) => v.rule === "AS-EFF-006" && v.effects.includes("Net")),
   JSON.stringify(gate));
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

fs.rmSync(W, { recursive: true, force: true });
console.log(`\ntest-mcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
