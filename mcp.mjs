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
import { discoverConfigPolicy, evaluatePolicy, parsePolicy, scopeMatches } from "./policy.mjs";

const VERSION = createRequire(import.meta.url)("./package.json").version; // single-sourced, like scan.mjs

// CLI: [prefix] [--root <dir>]. `--root` LOCKS the server to a workspace: every report prefix (and
// therefore every policy read, whose confinement root derives from the prefix) must live inside it.
// Without it the confinement is only RELATIVE — the `report` arg is client-chosen, so a client that can
// also plant a parseable report in a target tree could anchor policy reads there (review find).
const CLI_ARGS = process.argv.slice(2);
let WORKSPACE_ROOT = null;
{
  const i = CLI_ARGS.indexOf("--root");
  if (i >= 0) { WORKSPACE_ROOT = nodePath.resolve(CLI_ARGS[i + 1] ?? "."); CLI_ARGS.splice(i, 2); }
}
const DEFAULT_PREFIX = process.env.CANDOR_REPORT || CLI_ARGS[0]
  || (fs.existsSync(".candor") ? ".candor/report" : null);   // the engines' default --out convention

const within = (abs, root) => abs === root || abs.startsWith(root + nodePath.sep);
// hasReport is the shared query-core check — the SAME predicate (Q.isReport) the loader uses, so a
// prefix whose only sibling is `.encountered-*`/`.calibrated.json` can't pass existence yet load zero
// functions (an authoritative-empty result — a silent under-report; review find).
function resolvePrefix(args) {
  const p = args?.report || DEFAULT_PREFIX;
  if (!p) throw new Error("no report prefix: pass `report`, set $CANDOR_REPORT, or give one as the CLI arg");
  if (WORKSPACE_ROOT && !within(nodePath.resolve(p), WORKSPACE_ROOT))
    throw new Error(`report prefix \`${clip(p)}\` is outside the served workspace (--root ${WORKSPACE_ROOT}) — refusing`);
  if (!Q.hasReport(p)) throw new Error(`no report at \`${p}\` (.json or .<crate>.scan.json) — run a candor scan first`);
  return p;
}
// Truncate a caller-supplied value echoed back in an error (a multi-MB `fn` would otherwise be reflected
// verbatim — token/memory amplification over the agent transport, the opposite of the list-cap thrift).
const clip = (s, n = 120) => { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; };
// Load a report but FAIL LOUD (a thrown tool-level error) when files were FOUND yet nothing parsed —
// Q.loadReport discloses-and-tolerates, returning [] with the non-enumerable `hardFail` tag there, and
// an empty SUCCESSFUL result ({gained:[],byFunction:[]}, [] show, {} map) reads as an all-clear over a
// corrupt report — the §4 cardinal sin, exactly what the CLI's loadReportOrDie exits 2 on. The throw
// surfaces as the same isError result shape every other tool failure uses. EVERY tool that loads a
// report (main prefix or baseline) goes through this — never bare Q.loadReport.
function loadReportLoud(p) {
  const fns = Q.loadReport(p);
  if (fns.length === 0 && fns.hardFail)
    throw new Error(`every report found at prefix \`${clip(p)}\` failed to load — refusing to report an empty (all-clear) answer over a corrupt report; re-run the scan`);
  return fns;
}
// The confinement root for a caller-supplied policy path: the repo the report belongs to — the
// .candor/config-discovered repo root when there is one, else the parent of a `.candor/` report
// directory, else the report's own directory. The old default (always dirname(prefix)) was the
// `.candor/` dir itself under the standard `.candor/report` layout, so a legitimate repo-root policy —
// the very layout candor_gate resolves via cfg.repoRoot — was refused (review find).
function policyRoot(prefix) {
  const cfg = configPolicy(prefix);
  if (cfg) return cfg.repoRoot;
  const dir = nodePath.resolve(nodePath.dirname(prefix));
  return nodePath.basename(dir) === ".candor" ? nodePath.dirname(dir) : dir;
}
// Read a caller-supplied policy file CONFINED to the report's repo tree. The MCP surface is
// report-query-only (spec §7.12); an arbitrary `policy` path (/etc/passwd, ~/.aws/credentials) whose
// parsed deny-rule scopes are reflected back in violations[].rule is an arbitrary-file-read exfiltration
// channel — tie the policy to the project it gates. FAIL CLOSED on an unreadable path: the thrown error
// surfaces as the tool-level isError — a typo'd policy must be LOUD, never a clean no-policy verdict
// (the gateless-green shape the CLI's whatif exits 2 on).
function confinedPolicyRead(policyPath, prefix, root = policyRoot(prefix)) {
  const abs = nodePath.resolve(policyPath);
  if (!within(abs, root) || (WORKSPACE_ROOT && !within(abs, WORKSPACE_ROOT)))
    throw new Error(`policy must be within the report's repo (${root}) — refusing to read \`${clip(policyPath)}\``);
  try { return fs.readFileSync(abs, "utf8"); }
  catch { throw new Error(`policy \`${clip(policyPath)}\` could not be read — NOT evaluated (a missing gate source must be loud, never a clean verdict)`); }
}
// The repo's .candor/config (spec §3.4), from the report's directory upward — shared impl in policy.mjs.
function configPolicy(prefix) {
  return discoverConfigPolicy(nodePath.dirname(nodePath.resolve(prefix)) || ".");
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
  let out = r;
  if (Array.isArray(r.affected) && r.affected.length > MCP_LIST_CAP)   // affectedCount is the full count
    out = { ...out, affected: r.affected.slice(0, MCP_LIST_CAP), affectedTruncated: true };
  if (Array.isArray(r.entryPoints) && r.entryPoints.length > MCP_LIST_CAP)
    out = { ...out, entryPointCount: r.entryPoints.length, entryPoints: r.entryPoints.slice(0, MCP_LIST_CAP), entryPointsTruncated: true };
  return out;
}
// The same token-amplification argument as capImpact, for the other unbounded lists: `where` on a
// pervasive effect (Log, Unknown) lists most of a large repo; a blindspot source's `affected` is a
// transitive-caller list. Counts stay exact; truncation is flagged.
function capWhere(r) {
  const cap = (k) => Array.isArray(r[k]) && r[k].length > MCP_LIST_CAP;
  if (!cap("directly") && !cap("inherited")) return r;
  return {
    effect: r.effect,
    directlyCount: r.directly.length, directly: r.directly.slice(0, MCP_LIST_CAP),
    inheritedCount: r.inherited.length, inherited: r.inherited.slice(0, MCP_LIST_CAP),
    truncated: true,
  };
}
function capBlindspots(r) {
  const sources = (r.sources ?? []).map((s) =>
    Array.isArray(s.affected) && s.affected.length > MCP_LIST_CAP
      ? { ...s, affected: s.affected.slice(0, MCP_LIST_CAP), affectedTruncated: true }  // `reaches` is the full count
      : s);
  return { ...r, sources };
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
    run: (a, p) => capImpact(Q.impact(loadReportLoud(p), Q.loadCallgraph(p), a.fn)),
  },
  candor_where: {
    description: "Which functions perform a given effect (e.g. Net, Db, Exec, Fs) — `directly` vs `inherited` via a callee. The effect-surface map.",
    schema: { type: "object", properties: { effect: { type: "string", description: "Net|Fs|Db|Exec|Env|Clock|Ipc|Log|Rand|Clipboard|Unknown" }, ...reportArg }, required: ["effect"] },
    run: (a, p) => capWhere(Q.where(loadReportLoud(p), a.effect)),
  },
  candor_reachable: {
    description: "What the program/fleet actually DOES at runtime: effects unioned over the entry points, with how many roots reach each and via which.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => Q.reachable(loadReportLoud(p)),
  },
  candor_path: {
    description: "Forward provenance: the shortest call chain from `fn` to the nearest function that performs `effect` DIRECTLY — 'this reaches Net through WHAT?'.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => Q.path(loadReportLoud(p), Q.loadCallgraph(p), a.fn, a.effect),
  },
  candor_callers: {
    description: "Who calls `fn` — direct (one hop) and transitive callers over the effect-relevant call graph.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => capCallers(Q.callers(Q.loadCallgraph(p), a.fn)),
  },
  candor_show: {
    description: "A function's effects (inferred = transitive, direct = own body) plus its literal surfaces (hosts/cmds/paths/tables) when present.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => Q.show(loadReportLoud(p), a.fn),
  },
  candor_map: {
    description: "Per-module effect overview: each module's union of effects and function count. The architecture-at-a-glance.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => Q.map(loadReportLoud(p)),
  },
  candor_whatif: {
    description: "Hypothetically add `effect` to `fn` and report the blast radius; with `policy`, also the deny-rule violations it would cause. Pre-edit gate check.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, policy: { type: "string", description: "path to a CANDOR_POLICY file (optional)" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => {
      // A GIVEN policy path is always read (confined, fail-closed) — the old `existsSync` guard made a
      // typo'd/missing path silently evaluate with NO policy → `ok:true, violations:[]`, a false green
      // on the agent-facing pre-edit gate (exactly what the CLI whatif exits 2 to prevent). The read's
      // throw lands as the tool-level isError, mirroring the CLI's fail-closed posture.
      const pol = a.policy ? parsePolicy(confinedPolicyRead(a.policy, p)) : null;
      const r = Q.whatif(Q.loadCallgraph(p), a.fn, a.effect, pol, scopeMatches);
      if (r === null) throw new Error(`no function matching \`${clip(a.fn)}\` in the call graph`);
      return r;
    },
  },
  candor_fix: {
    description: "THE BOUNDARY FIX: when `fn` performs `effect` in a layer the policy forbids (a violation candor_whatif/candor_gate reports), compute the architectural REMEDY — not just 'the domain can't do Net', but WHERE the effect belongs and the refactor to put it there: the direct call site to hoist, the forbidden-layer functions that become pure and thread the value as a parameter, and the nearest allowed-layer caller to perform the effect ({ crossing, site, deniedSpan, hoistTo, policyAlternative }). The remedial inverse of candor_whatif. Call this INSTEAD OF guessing a fix (adding `allow` to the domain, moving the I/O one call up, threading a handle the wrong way). Advisory: it names the structure, you write the code; the gate re-scan verifies. Uses `policy` if given, else the repo's checked-in .candor/config policy (spec §3.4).",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => {
      // The fix is defined relative to a boundary — a policy is required. Given → confined fail-closed read;
      // else the repo's checked-in policy (same resolution as candor_gate), so it works zero-config.
      let text;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4) — the fix is defined relative to the boundary it crosses");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      const cg = Q.loadCallgraph(p);
      // The sidecar is the only graph a candor-ts report carries — fail loud (tool error) when it's absent,
      // never a degenerate empty-graph remedy. (/code-review.)
      if (!cg || Object.keys(cg).length === 0) throw new Error(`no call-graph sidecar for the report — fix needs it (re-scan with --out)`);
      const r = Q.fix(cg, loadReportLoud(p), a.fn, a.effect, parsePolicy(text), scopeMatches);
      if (r === null) throw new Error(`no function matching \`${clip(a.fn)}\` in the call graph`);
      return r;
    },
  },
  candor_gate: {
    description: "The policy verdict over this report: { ok, violations:[{rule, fn, effects, detail}] } — 'would this repo pass its architecture gate?'. Uses `policy` if given, else the repo's checked-in .candor/config policy (spec §3.4). Computed from the report — the engine's own --gate-json run is the authoritative CI form: it additionally fails an allow rule whose literal surface is INCOMPLETE (a masked/invisible endpoint), which is not a report field, so a green here can still be red in CI.",
    schema: { type: "object", properties: { policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: [] },
    run: (a, p) => {
      let text;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4)");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      const v = evaluatePolicy(parsePolicy(text), loadReportLoud(p), Q.loadCallgraph(p));
      return { ok: v.length === 0, violations: v };
    },
  },
  candor_unverified: {
    description: "PROVABLE-PURITY check (INSTANT): a `pure`/`deny <E>` policy layer PASSES a function that has "
                 + "no such effect — but if that function is Unknown (candor couldn't resolve one of its calls), "
                 + "the pass is UNVERIFIED: the Unknown could hide the very effect the rule forbids. The classic "
                 + "case is a fn/closure-injected 'port' — the domain reads as Unknown, so `deny Net domain`/`pure "
                 + "domain` clear it though it may reach Net at runtime. Returns each such function + the `deny <E> "
                 + "Unknown <scope>` upgrade that makes the layer PROVABLY clean. Uses `policy` if given, else the "
                 + "repo's checked-in .candor/config policy.",
    schema: { type: "object", properties: { policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: [] },
    run: (a, p) => {
      let text;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4)");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      return Q.unverified(loadReportLoud(p), parsePolicy(text), scopeMatches);
    },
  },
  candor_containment: {
    description: "Per boundary effect (Db/Net/Exec/Fs/Ipc/Clipboard): how contained it is in one architectural layer — the dispersion diagnostic (spec §6.1). Not a score; per-effect facts.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => Q.containment(loadReportLoud(p)),
  },
  candor_blindspots: {
    description: "The Unknown SOURCES — calls the engine genuinely could not resolve (reflection, wide dispatch, fn-pointers) — ranked by how many functions inherit Unknown through each. Turns a high-Unknown report into a short worklist.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => capBlindspots(Q.blindspots(loadReportLoud(p), Q.loadCallgraph(p))),
  },
  candor_diff: {
    description: "The per-function effect delta versus a baseline report: gained (introduced vs inherited) and lost effects. 'What did this change do to the effect surface?'.",
    schema: { type: "object", properties: { baseline: { type: "string", description: "the baseline report prefix" }, ...reportArg }, required: ["baseline"] },
    run: (a, p) => {
      // The BASELINE locator gets the SAME existence + --root confinement checks as the main report
      // (resolvePrefix) — a typo'd baseline loaded [] with hardFail=false and diffed as an
      // authoritative empty {changes:[]} (the CLI now exits 2 on the same miss).
      const b = resolvePrefix({ report: a.baseline });
      return { baseline_version: Q.reportVersion(b) ?? "", engine_version: Q.reportVersion(p) ?? "",
               ...Q.diff(loadReportLoud(p), loadReportLoud(b)) };
    },
  },
  candor_gains: {
    description: "The supply-chain alarm: effects the surface GAINED versus a baseline (package-level + per-function) — 'did this dependency bump add Net/Exec somewhere?'.",
    schema: { type: "object", properties: { baseline: { type: "string", description: "the baseline report prefix" }, ...reportArg }, required: ["baseline"] },
    run: (a, p) => {
      // Same baseline existence + --root confinement as candor_diff — an empty {gained:[]} over a
      // typo'd baseline is a silent all-clear on the supply-chain ALARM tool.
      const b = resolvePrefix({ report: a.baseline });
      // ⟨spec 0.12 staged⟩ baseline callgraph → byFunction[].origin, same as the CLI (parity). The
      // loader's non-enumerable `partial` tag rides along: a corrupt baseline sidecar (edges dropped,
      // disclosed) downgrades origin to "unknown", never a fabricated "new" over a truncated graph.
      return { baseline_version: Q.reportVersion(b) ?? "", engine_version: Q.reportVersion(p) ?? "",
               ...Q.gains(loadReportLoud(p), loadReportLoud(b), Q.loadCallgraph(b)) };
    },
  },
};

// ---- MCP resources: the report + the checked-in policy, readable directly --------------------------
function listResources(prefix) {
  const res = [{ uri: `candor://report?prefix=${encodeURIComponent(prefix)}`, name: "candor report",
                 description: "the spec §2 report envelope (all packages under the prefix)", mimeType: "application/json" }];
  const cfg = prefix ? configPolicy(prefix) : null;
  if (cfg && fs.existsSync(cfg.policyPath))
    res.push({ uri: `candor://policy?prefix=${encodeURIComponent(prefix)}`, name: "candor policy",
               description: "the repo's checked-in §6.2 architecture policy (via .candor/config)", mimeType: "text/plain" });
  return res;
}
function readResource(uri, prefix) {
  if (uri.startsWith("candor://report")) return { mimeType: "application/json", text: JSON.stringify(loadReportLoud(prefix)) };
  if (uri.startsWith("candor://policy")) {
    const cfg = configPolicy(prefix);
    if (!cfg) throw new Error("no checked-in policy (no .candor/config with a `policy` key)");
    return { mimeType: "text/plain", text: confinedPolicyRead(cfg.policyPath, prefix, cfg.repoRoot) };
  }
  throw new Error(`unknown resource: ${uri}`);
}

// ---- JSON-RPC 2.0 over stdio (newline-delimited; the MCP stdio framing) ---------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "candor-mcp", version: VERSION },
      instructions: "candor's read-only effect queries. Prefer candor_impact/candor_reachable/candor_where over manually tracing the call graph — they return deterministic ground truth from a precomputed report. Run a candor scan first to produce the report.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notifications: no reply
  if (method === "ping") return result(id, {});
  if (method === "resources/list") {
    try { return result(id, { resources: DEFAULT_PREFIX && Q.hasReport(DEFAULT_PREFIX) ? listResources(DEFAULT_PREFIX) : [] }); }
    catch { return result(id, { resources: [] }); }
  }
  if (method === "resources/read") {
    try {
      // Honor the prefix ENCODED in the resource URI (resources/list mints `?prefix=…`) — it was
      // decorative before, always resolving the default (review find). resolvePrefix keeps the
      // existence + --root checks on whatever the client asked for.
      const uri = params?.uri || "";
      let encoded = null;
      try { encoded = new URL(uri).searchParams.get("prefix"); } catch { /* not URL-shaped — default */ }
      const prefix = resolvePrefix(encoded ? { report: encoded } : {});
      const r = readResource(uri, prefix);
      return result(id, { contents: [{ uri: params?.uri, ...r }] });
    } catch (e) { return error(id, -32602, `candor: ${e.message}`); }
  }
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
        const names = [...new Set([...Object.keys(Q.loadCallgraph(prefix)), ...loadReportLoud(prefix).map((e) => e.fn)])];
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
