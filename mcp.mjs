#!/usr/bin/env node
/**
 * candor-mcp — candor's read-only query surface as an MCP server (roadmap direction #1: candor as
 * agent infrastructure). An agent asks "if I change X, what's the runtime blast radius?" or "what
 * reaches the network?" and gets DETERMINISTIC ground truth from a precomputed report in ~zero
 * exploration tokens — the measured ~700-2000x token win over grepping to the same answer.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio framing), implemented directly
 * so candor-ts's `npx` scan/query path stays dependency-free. Query logic is the shared query-core.mjs
 * (one source of truth with the CLI). The server is QUERY-ONLY (it never scans — the analyzer self-
 * boundary, SPEC §7.12; an agent/hook produces the report, the server reads it: Fs only).
 *
 * The report to query is resolved per call from the tool's `report` arg, else $CANDOR_REPORT, else
 * the first CLI arg. A `<prefix>` names `<prefix>.json` + `<prefix>.callgraph.json`.
 *
 *   CANDOR_REPORT=.candor/report.myCrate.scan  npx -y candor-ts mcp
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import * as Q from "./query-core.mjs";
import { parsePolicy, scopeMatches } from "./policy.mjs";

const VERSION = createRequire(import.meta.url)("./package.json").version; // single-sourced, like scan.mjs

const DEFAULT_PREFIX = process.env.CANDOR_REPORT || process.argv[2] || null;

function resolvePrefix(args) {
  const p = args?.report || DEFAULT_PREFIX;
  if (!p) throw new Error("no report prefix: pass `report`, set $CANDOR_REPORT, or give one as the CLI arg");
  if (!fs.existsSync(`${p}.json`)) throw new Error(`no report at \`${p}.json\` — run a candor scan first`);
  return p;
}

// ---- the tools: name -> {description, schema, run} ------------------------------------------------
const reportArg = { report: { type: "string", description: "report prefix (optional; defaults to $CANDOR_REPORT)" } };
const TOOLS = {
  candor_impact: {
    description: "Backward blast radius: every effectful function that transitively calls `fn`, and which runtime entry points are downstream. Answers 'if I change this, what surfaces at runtime?' — the cheapest possible alternative to tracing callers by hand.",
    schema: { type: "object", properties: { fn: { type: "string", description: "the function/unit to assess" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => Q.impact(Q.loadReport(p), Q.loadCallgraph(p), a.fn),
  },
  candor_where: {
    description: "Which functions perform a given effect (e.g. Net, Db, Exec, Fs) — `directly` vs `inherited` via a callee. The effect-surface map.",
    schema: { type: "object", properties: { effect: { type: "string", description: "Net|Fs|Db|Exec|Env|Clock|Ipc|Log|Rand|Clipboard|Unknown" }, ...reportArg }, required: ["effect"] },
    run: (a, p) => Q.where(Q.loadReport(p), a.effect),
  },
  candor_reachable: {
    description: "What the program/fleet actually DOES at runtime: effects unioned over the entry points, with how many roots reach each and via which.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => Q.reachable(Q.loadReport(p)),
  },
  candor_path: {
    description: "Forward provenance: the shortest call chain from `fn` to the nearest function that performs `effect` DIRECTLY — 'this reaches Net through WHAT?'.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => Q.path(Q.loadReport(p), Q.loadCallgraph(p), a.fn, a.effect),
  },
  candor_callers: {
    description: "Who calls `fn` — direct (one hop) and transitive callers over the effect-relevant call graph.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => Q.callers(Q.loadCallgraph(p), a.fn),
  },
  candor_show: {
    description: "A function's effects (inferred = transitive, direct = own body) plus its literal surfaces (hosts/cmds/paths/tables) when present.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => Q.show(Q.loadReport(p), a.fn),
  },
  candor_map: {
    description: "Per-module effect overview: each module's union of effects and function count. The architecture-at-a-glance.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => Q.map(Q.loadReport(p)),
  },
  candor_whatif: {
    description: "Hypothetically add `effect` to `fn` and report the blast radius; with `policy`, also the deny-rule violations it would cause. Pre-edit gate check.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, policy: { type: "string", description: "path to a CANDOR_POLICY file (optional)" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => {
      const pol = a.policy && fs.existsSync(a.policy) ? parsePolicy(fs.readFileSync(a.policy, "utf8")) : null;
      const r = Q.whatif(Q.loadCallgraph(p), a.fn, a.effect, pol, scopeMatches);
      if (r === null) throw new Error(`no function matching \`${a.fn}\` in the call graph`);
      return r;
    },
  },
};

// ---- JSON-RPC 2.0 over stdio (newline-delimited; the MCP stdio framing) ---------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "candor-mcp", version: VERSION },
      instructions: "candor's read-only effect queries. Prefer candor_impact/candor_reachable/candor_where over manually tracing the call graph — they return deterministic ground truth from a precomputed report. Run a candor scan first to produce the report.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notifications: no reply
  if (method === "ping") return result(id, {});
  if (method === "tools/list") {
    return result(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })),
    });
  }
  if (method === "tools/call") {
    const t = TOOLS[params?.name];
    if (!t) return error(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const args = params.arguments || {};
      const prefix = resolvePrefix(args);
      // A tool that targets a `fn` gets a clear "not found" rather than a silently-empty result —
      // an agent must distinguish "no such function" from "found, nothing calls it".
      if (args.fn !== undefined) {
        const names = [...new Set([...Object.keys(Q.loadCallgraph(prefix)), ...Q.loadReport(prefix).map((e) => e.fn)])];
        if (Q.matches(names, args.fn).length === 0)
          return result(id, { content: [{ type: "text", text: `candor: no function matching \`${args.fn}\` in this report` }], isError: true });
      }
      const out = t.run(args, prefix);
      return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
    } catch (e) {
      // A tool-level failure is reported in the result (isError), not as a protocol error.
      return result(id, { content: [{ type: "text", text: `candor: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) error(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // ignore unparseable frames
    try { handle(msg); } catch (e) { if (msg.id !== undefined) error(msg.id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
