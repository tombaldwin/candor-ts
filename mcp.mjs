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
import nodePath from "node:path";
import * as Q from "./query-core.mjs";
import { parsePolicy, scopeMatches } from "./policy.mjs";

const VERSION = createRequire(import.meta.url)("./package.json").version; // single-sourced, like scan.mjs

const DEFAULT_PREFIX = process.env.CANDOR_REPORT || process.argv[2] || null;

// A report exists at the prefix if there's an exact `<prefix>.json` (candor-ts) OR a sibling
// `<prefix>.<crate>.scan.json` (the candor-scan/Rust multi-report form) — the loaders read both, so
// the MCP server serves a report from ANY engine, not just candor-ts's.
function hasReport(p) {
  if (fs.existsSync(`${p}.json`)) return true;
  const base = nodePath.basename(p);
  try {
    // SAME predicate (Q.isReport) the loader uses — a prefix whose only sibling is `.encountered-*` /
    // `.calibrated.json` must NOT pass here, else loadReport finds zero functions and the tool returns an
    // authoritative-empty result instead of "no report" (a silent under-report — review find).
    return fs.readdirSync(nodePath.dirname(p) || ".").some((f) =>
      f.startsWith(base + ".") && f.endsWith(".json") && Q.isReport(f));
  } catch { return false; }
}
function resolvePrefix(args) {
  const p = args?.report || DEFAULT_PREFIX;
  if (!p) throw new Error("no report prefix: pass `report`, set $CANDOR_REPORT, or give one as the CLI arg");
  if (!hasReport(p)) throw new Error(`no report at \`${p}\` (.json or .<crate>.scan.json) — run a candor scan first`);
  return p;
}
// Truncate a caller-supplied value echoed back in an error (a multi-MB `fn` would otherwise be reflected
// verbatim — token/memory amplification over the agent transport, the opposite of the list-cap thrift).
const clip = (s, n = 120) => { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; };
// Read a caller-supplied policy file CONFINED to the report's directory tree. The MCP surface is
// report-query-only (spec §7.12); an arbitrary `policy` path (/etc/passwd, ~/.aws/credentials) whose
// parsed deny-rule scopes are reflected back in violations[].rule is an arbitrary-file-read exfiltration
// channel — tie the policy to the project it gates.
function confinedPolicyRead(policyPath, prefix) {
  const root = nodePath.resolve(nodePath.dirname(prefix));
  const abs = nodePath.resolve(policyPath);
  if (abs !== root && !abs.startsWith(root + nodePath.sep))
    throw new Error(`policy must be within the report's directory (${root}) — refusing to read \`${clip(policyPath)}\``);
  return fs.readFileSync(abs, "utf8");
}

// ---- the tools: name -> {description, schema, run} ------------------------------------------------
const reportArg = { report: { type: "string", description: "report prefix (optional; defaults to $CANDOR_REPORT)" } };

// Bound a blast-radius/caller LIST for the agent transport: on a large repo a single fn can have
// hundreds-to-thousands of transitive callers, an unbounded multi-thousand-token answer. The agent's
// question ("how big is the blast radius / where does it surface") is answered by the COUNT + the entry
// points + the top names — so cap the list to MCP_LIST_CAP, keep the exact count, and flag truncation.
// The full list stays available from the CLI / `--json` (the spec-pinned §3.1 shape is UNCHANGED — this
// only shapes the MCP result for its token-sensitive transport). Small results are returned verbatim.
const MCP_LIST_CAP = 50;
function capImpact(r) {
  if (!Array.isArray(r.affected) || r.affected.length <= MCP_LIST_CAP) return r; // affectedCount is the full count
  return { ...r, affected: r.affected.slice(0, MCP_LIST_CAP), affectedTruncated: true };
}
function capCallers(r) {
  const d = r.direct ?? [], t = r.transitive ?? [];
  if (d.length <= MCP_LIST_CAP && t.length <= MCP_LIST_CAP) return r;
  return {
    of: r.of,
    directCount: d.length, direct: d.slice(0, MCP_LIST_CAP),
    transitiveCount: t.length, transitive: t.slice(0, MCP_LIST_CAP),
    truncated: true,
  };
}
const TOOLS = {
  candor_impact: {
    description: "Backward blast radius: every effectful function that transitively calls `fn`, and which runtime entry points are downstream. Answers 'if I change this, what surfaces at runtime?' — the cheapest possible alternative to tracing callers by hand.",
    schema: { type: "object", properties: { fn: { type: "string", description: "the function/unit to assess" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => capImpact(Q.impact(Q.loadReport(p), Q.loadCallgraph(p), a.fn)),
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
    run: (a, p) => capCallers(Q.callers(Q.loadCallgraph(p), a.fn)),
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
      const pol = a.policy && fs.existsSync(a.policy) ? parsePolicy(confinedPolicyRead(a.policy, p)) : null;
      const r = Q.whatif(Q.loadCallgraph(p), a.fn, a.effect, pol, scopeMatches);
      if (r === null) throw new Error(`no function matching \`${clip(a.fn)}\` in the call graph`);
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
      // Enforce the tool's declared required args server-side — a missing `fn` must be a clear error,
      // not a silently-empty result (a defensive server doesn't trust the client to validate).
      const missing = (t.schema.required || []).filter((k) => args[k] === undefined || args[k] === "");
      if (missing.length)
        return result(id, { content: [{ type: "text", text: `candor: missing required argument(s): ${missing.join(", ")}` }], isError: true });
      const prefix = resolvePrefix(args);
      // A tool that targets a `fn` gets a clear "not found" rather than a silently-empty result —
      // an agent must distinguish "no such function" from "found, nothing calls it".
      if (args.fn !== undefined) {
        const names = [...new Set([...Object.keys(Q.loadCallgraph(prefix)), ...Q.loadReport(prefix).map((e) => e.fn)])];
        if (Q.matches(names, args.fn).length === 0)
          return result(id, { content: [{ type: "text", text: `candor: no function matching \`${clip(args.fn)}\` in this report` }], isError: true });
      }
      const out = t.run(args, prefix);
      // Minified, not pretty-printed: the consumer is an AGENT (it parses the JSON), so the indentation
      // was ~25-30% of every result's tokens for no benefit. The CLI keeps its human-readable shapes.
      return result(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
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
    // A JSON-RPC frame is a (non-null, non-array) object. `null`, a bare primitive, or a batch array
    // would crash `handle`'s destructure — and the catch's own `msg.id` deref re-threw OUTSIDE the
    // handler, killing the whole server (and the agent's session) on a single `null\n` line (review find).
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    try { handle(msg); } catch (e) { if (msg.id !== undefined) error(msg.id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
