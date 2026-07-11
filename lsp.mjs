#!/usr/bin/env node
/**
 * candor-lsp — candor's effect map as a Language Server (AGENT-SURFACE-DESIGN bet 2, P1): the report,
 * rendered where the code is.
 *
 *   • CodeLens per effectful function: `⚡ Db, Net · blast radius 12` — the transitive effect set and
 *     how many functions transitively call it (who is affected if it changes).
 *   • Diagnostics: the repo's architecture-policy verdict (the §6.2 gate, resolved from CANDOR_POLICY
 *     or the checked-in .candor/config — spec §3.4) as squiggles at each violating function's line.
 *     CAVEAT — a report-computed gate is WEAKER than the engine's own --gate-json run: the scan-time
 *     gate also fails an allow rule whose literal surface is INCOMPLETE (a masked/invisible endpoint,
 *     kept internal per the java/rust engines — not a report field), so no-squiggle here can still be
 *     red in CI. The engine's --gate-json is the authoritative form (same caveat as MCP candor_gate).
 *   • Hover: effect PROVENANCE — for each inherited effect, the `path` hop chain to the function that
 *     performs it directly ("Net via mid → leaf (source)"), plus unknownWhy when the fn discloses opacity.
 *   • CodeAction (pre-edit whatif): inside a function the report knows, one action per BOUNDARY effect
 *     the fn does NOT already perform — `candor: what if <fn> performed Net?`. Each resolves to the
 *     `candor.whatif` workspace/executeCommand, answered server-side with the SAME query-core whatif the
 *     CLI and MCP use (single-source): a window/showMessage one-liner (the policy rule that WOULD fire +
 *     the blast radius; no policy discovered → radius only, said so) and a transient Information
 *     diagnostic at the fn's line carrying the detail (rule + first callers), cleared on the next
 *     didOpen/didSave/didChange of that file or replaced by re-running the action. Plain LSP — works in
 *     helix/neovim/VS Code/JetBrains-via-LSP4IJ without client-side code.
 *
 *   Perf (measured on the 5k-fn synthetic fixture in test-lsp.mjs — 50 files × 100 fns, one 5k-deep
 *   call chain, worst-case doc): codeLens ≈ 63ms, codeAction ≈ 5ms per request, INCLUDING the
 *   per-request report re-read. No caching layer — the freshness contract stays "re-read per request".
 *
 * The server is a pure CONSUMER of the spec report envelope + callgraph sidecar (any engine — JVM /
 * Rust / TS / Swift / agents; the same read layer as candor-mcp), and it never scans (the analyzer
 * self-boundary, spec §7.12): whatever refreshes the report (candor-ts-watch, the Claude Code stop
 * hook, a build step) refreshes the lenses — reports are re-read per request, so freshness is free.
 * A stale report is a stale map, disclosed by its own provenance (§2.1), never re-derived here.
 *
 * Report prefix resolution: initializationOptions.report → $CANDOR_REPORT → <workspace>/.candor/report.
 * Transport: LSP stdio (Content-Length framed JSON-RPC 2.0).
 *
 * Editor wiring (no dedicated extension needed where the editor speaks LSP natively):
 *   helix   languages.toml:  language-server.candor = { command = "candor-lsp" }
 *   neovim  vim.lsp.start({ name = "candor", cmd = { "candor-lsp" } })
 *   VS Code needs a thin client extension — a later slice.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as Q from "./query-core.mjs";
import { discoverConfigPolicy, evaluatePolicy, parsePolicy, scopeMatches } from "./policy.mjs";

// Version: from the sibling package.json when running inside the npm package; a single-file BUNDLE of
// this server (the IDE-plugin embedding) has no sibling package.json — fall back rather than crash.
let VERSION = "bundled";
try { VERSION = createRequire(import.meta.url)("./package.json").version; } catch { /* bundled */ }

// ---- state (set at initialize) ---------------------------------------------------------------------
let rootPath = null;
let reportPrefix = process.env.CANDOR_REPORT || process.argv[2] || null;

const hasReport = Q.hasReport; // single-sourced with the loader predicate (query-core) — see mcp.mjs

// ---- fn → document mapping --------------------------------------------------------------------------
// A report `loc` is `<file>:<line>[:col…]` where <file> is either a repo-relative PATH (the scan-source
// engines) or a BARE filename (JVM bytecode SourceFile) — for the bare form the path is rebuilt from the
// fn's package segments, the same rule candor-sarif ships. Documents are matched by path SUFFIX (the
// workspace root need not equal the report's root).
function locParts(loc) {
  if (typeof loc !== "string") return null;
  const m = loc.match(/^(.*?):(\d+)/);
  return m ? { file: m[1], line: Math.max(0, parseInt(m[2], 10) - 1) } : null;
}
function candidatePaths(fn, file) {
  if (file.includes("/")) return [file];
  const parts = fn.split(".");
  const cands = [file];
  if (parts.length >= 3) cands.unshift(parts.slice(0, -2).join("/") + "/" + file);
  return cands;
}
function docMatches(docPath, fn, file) {
  const norm = docPath.split(nodePath.sep).join("/");
  return candidatePaths(fn, file).some((c) => norm === c || norm.endsWith("/" + c));
}
/** Every report entry whose loc maps into this document: [{ entry, line }]. Loaded FRESH per call
 *  (the per-request re-read is the freshness design); a caller that already has the report passes
 *  it via `fns` so one request never parses the same file twice. */
function entriesInDoc(docPath, fns = null) {
  if (!hasReport(reportPrefix)) return null;
  const out = [];
  for (const e of (fns ?? Q.loadReport(reportPrefix))) {
    const lp = e.loc && locParts(e.loc);
    if (lp && docMatches(docPath, e.fn, lp.file)) out.push({ entry: e, line: lp.line });
  }
  return out;
}

// The transitive-caller COUNT for an exact fn name over an already-inverted graph. The lenses used
// Q.callers per entry, and every callers() call rebuilt reverseGraph from scratch — a 50-fn document
// over a JVM-scale callgraph did 50 full graph inversions PER codeLens request (review find). One
// inversion per request + a plain BFS; report fn names are exact cg keys, so no match ladder needed.
function transitiveCallerCount(rev, fn) {
  const seen = new Set([fn]);
  const queue = [fn];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c); }
  }
  return seen.size - 1; // minus the target itself
}

// ---- CodeLens ---------------------------------------------------------------------------------------
function codeLenses(docPath) {
  const found = entriesInDoc(docPath);
  if (found === null) return [];
  let rev = null;
  try { rev = Q.reverseGraph(Q.loadCallgraph(reportPrefix)); } catch { /* no callgraph — effects-only lens */ }
  return found.map(({ entry, line }) => {
    const blast = rev ? ` · blast radius ${transitiveCallerCount(rev, entry.fn)}` : "";
    const eff = (entry.inferred || []).join(", ") || "pure";
    return {
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
      command: { title: `⚡ ${eff}${blast}`, command: "" },   // informational lens (no action) — P1
    };
  });
}

// The entry ENCLOSING a line: the report pins each fn at its declaration line, so the match is the
// greatest entry line ≤ the cursor (functions are sequential in a file — a sound approximation that
// needs no parser). Shared by hover and codeAction — one rule for "which function is the cursor in".
function enclosingEntry(docPath, line, fns = null) {
  const found = entriesInDoc(docPath, fns);
  if (!found || !found.length) return null;
  return found.filter((x) => x.line <= line).sort((a, b) => b.line - a.line)[0] ?? null;
}

// ---- Hover: effect provenance at the cursor ----------------------------------------------------------
// For each inferred effect: direct → "performed here"; inherited → the §3.1 `path` chain to the direct
// source. unknownWhy rides along when the fn introduces opacity.
function hoverAt(docPath, line) {
  if (!hasReport(reportPrefix)) return null;
  const fns = Q.loadReport(reportPrefix);          // ONE load per request (enclosingEntry reuses it)
  const at = enclosingEntry(docPath, line, fns);
  if (!at) return null;
  const { entry } = at;
  const cg = Q.loadCallgraph(reportPrefix);
  const lines = [`**${entry.fn}** — ⚡ { ${(entry.inferred || []).join(", ") || "pure"} }`];
  for (const eff of entry.inferred || []) {
    if (eff === "Unknown") continue;                          // covered by unknownWhy below
    if ((entry.direct || []).includes(eff)) {
      lines.push(`- **${eff}** — performed directly here`);
      continue;
    }
    try {
      const hops = (Q.path(fns, cg, entry.fn, eff)?.path || []).map((h) => h.fn.split(/[.:]+/).pop() + (h.source ? " (source)" : ""));
      lines.push(hops.length > 1 ? `- **${eff}** — via ${hops.slice(1).join(" → ")}` : `- **${eff}** — inherited (source is cross-boundary or framework-synthesised)`);
    } catch { lines.push(`- **${eff}** — inherited`); }
  }
  if (entry.unknownWhy?.length) lines.push(`- **Unknown** — ${entry.unknownWhy.join(", ")}`);
  if (entry.invisible?.length) lines.push(`- _invisible_: ${entry.invisible.join(", ")} (unmodeled — the effect set is a lower bound)`);
  try {
    const c = Q.callers(cg, entry.fn);
    lines.push(`\nBlast radius: **${(c?.transitive || []).length}** transitive caller(s)`);
  } catch { /* no callgraph */ }
  return {
    contents: { kind: "markdown", value: lines.join("\n") },
    range: { start: { line: at.line, character: 0 }, end: { line: at.line, character: 200 } },
  };
}

// ---- Diagnostics (the live gate) ---------------------------------------------------------------------
const warned = new Set();
function warnOnce(message) { if (!warned.has(message)) { warned.add(message); logMessage(message); } }
function activePolicy() {
  const env = process.env.CANDOR_POLICY;
  if (env) {
    if (fs.existsSync(env)) return fs.readFileSync(env, "utf8");
    // Set-but-missing must be LOUD (the family's configured-but-unusable posture — scan exits 2 here).
    // This is an advisory surface, so: disclose the policy-source swap, then fall through to discovery.
    warnOnce(`candor-lsp: CANDOR_POLICY is set but ${env} does not exist — falling back to .candor/config discovery (diagnostics may reflect a different policy than you configured)`);
  }
  const from = reportPrefix ? nodePath.dirname(nodePath.resolve(reportPrefix)) : rootPath;
  const cfg = from ? discoverConfigPolicy(from) : null;
  if (cfg && fs.existsSync(cfg.policyPath)) return fs.readFileSync(cfg.policyPath, "utf8");
  return null;
}
function diagnosticsFor(docPath) {
  const text = activePolicy();
  if (text === null || !hasReport(reportPrefix)) return [];
  const fns = Q.loadReport(reportPrefix);
  const violations = evaluatePolicy(parsePolicy(text), fns, Q.loadCallgraph(reportPrefix));
  const locByFn = new Map(fns.filter((e) => e.loc).map((e) => [e.fn, locParts(e.loc)]));
  const out = [];
  for (const v of violations) {
    const lp = locByFn.get(v.fn);
    if (!lp || !docMatches(docPath, v.fn, lp.file)) continue;
    out.push({
      range: { start: { line: lp.line, character: 0 }, end: { line: lp.line, character: 200 } },
      severity: v.rule === "AS-EFF-007" ? 2 : 1,   // the advisory code is a warning, the rest errors
      source: "candor",
      code: v.rule,
      message: v.detail || `${v.fn} violates ${v.rule}`,
    });
  }
  return out;
}
function publishDiagnostics(uri) {
  let docPath;
  try { docPath = fileURLToPath(uri); } catch { return; }
  try {
    const diags = diagnosticsFor(docPath).concat(transient.get(uri) ?? []);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diags } });
  } catch (e) {
    logMessage(`candor-lsp: diagnostics failed for ${uri}: ${e.message}`);
  }
}
function logMessage(message) { send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 2, message } }); }
function showMessage(type, message) { send({ jsonrpc: "2.0", method: "window/showMessage", params: { type, message } }); }

// ---- CodeAction: the pre-edit whatif (spec §3.1 whatif, rendered as an editor action) -----------------
// From a position inside a function the report knows, offer "what if <fn> performed <E>?" for each
// BOUNDARY effect (Q.CONTAINED — ambient effects gate nothing) the fn does not already carry. The action
// carries a plain `command` (no client-side resolve, no edit) so it works in any LSP client verbatim.
const WHATIF_COMMAND = "candor.whatif";
const FIX_COMMAND = "candor.fix";
function codeActions(docPath, uri, range) {
  const at = enclosingEntry(docPath, range?.start?.line ?? 0);
  if (!at) return [];                                  // a fn the report doesn't know → no actions, never an error
  const have = new Set(at.entry.inferred || []);
  const out = [];
  for (const eff of Q.CONTAINED) {                     // ≤6 boundary effects — the natural cap
    if (have.has(eff)) continue;
    out.push({
      title: `candor: what if ${at.entry.fn} performed ${eff}?`,
      command: {
        title: `candor: what if ${at.entry.fn} performed ${eff}?`,
        command: WHATIF_COMMAND,
        arguments: [{ fn: at.entry.fn, effect: eff, uri, line: at.line }],
      },
    });
  }
  // The REMEDIAL companion (integrations/FIX-SPEC.md): for each BOUNDARY effect the fn ALREADY performs that
  // the active policy FORBIDS here, offer the FIX — where the effect belongs + the hoist. Only real crossings
  // are offered (Q.fix returns `crossing:false` otherwise), so this is empty unless the cursor sits in a
  // function that actually violates the boundary. Same policy source as the diagnostics + the whatif action.
  const policyText = activePolicy();
  if (policyText !== null && hasReport(reportPrefix)) {
    const pol = parsePolicy(policyText);
    const cg = Q.loadCallgraph(reportPrefix);
    const fns = Q.loadReport(reportPrefix);
    for (const eff of Q.CONTAINED) {
      if (!have.has(eff)) continue;
      const r = Q.fix(cg, fns, at.entry.fn, eff, pol, scopeMatches);
      if (r && r.crossing) {
        out.push({
          title: `candor fix: hoist ${eff} out of ${at.entry.fn}`,
          command: {
            title: `candor fix: hoist ${eff} out of ${at.entry.fn}`,
            command: FIX_COMMAND,
            arguments: [{ fn: at.entry.fn, effect: eff, uri, line: at.line }],
          },
        });
      }
    }
  }
  return out;
}

// Transient whatif diagnostics (Information severity, appended to the gate diagnostics on publish):
// uri -> Diagnostic[]. Cleared on the next didOpen/didSave/didChange of that file; re-running the
// action replaces the previous answer (one live whatif overlay per file, not an accumulating pile).
const transient = new Map();
function clearTransient(uri) {
  if (transient.delete(uri)) publishDiagnostics(uri);   // republish without the overlay
}

// The candor.whatif command: the SAME query-core whatif the CLI (`query.mjs whatif`) and MCP
// (`candor_whatif`) run — blast radius over the callgraph + the deny rules that WOULD fire, against the
// live policy (CANDOR_POLICY / .candor/config discovery, same source as the diagnostics). Everything is
// re-read per call (the freshness contract). Malformed args → logMessage + null, never a throw.
function runWhatif(a) {
  if (!a || typeof a !== "object" || typeof a.fn !== "string" || typeof a.effect !== "string") {
    logMessage(`candor-lsp: ${WHATIF_COMMAND} called with malformed arguments (expected [{ fn, effect, uri?, line? }]) — ignored`);
    return null;
  }
  if (!hasReport(reportPrefix)) {
    showMessage(2, "candor: no report found — scan first (candor-ts <dir> --out .candor/report)");
    return null;
  }
  const policyText = activePolicy();
  const r = Q.whatif(Q.loadCallgraph(reportPrefix), a.fn, a.effect,
                     policyText === null ? null : parsePolicy(policyText), scopeMatches);
  if (r === null) {
    showMessage(2, `candor: no function matching \`${a.fn}\` in the call graph — the report may be stale`);
    return null;
  }
  const callers = r.affected.filter((f) => !r.of.includes(f));   // affected minus the target(s) themselves
  const rules = [...new Set(r.violations.map((v) => v.rule))];
  const verdict = policyText === null
    ? `candor: no policy discovered — blast radius only: ${callers.length} caller(s) would inherit ${a.effect}`
    : rules.length
      ? `✗ ${rules[0]} would fire — ${callers.length} caller(s) inherit ${a.effect}`
      : `✓ no policy rule fires — ${callers.length} caller(s) would inherit ${a.effect}`;
  showMessage(rules.length ? 2 : 3, verdict);                    // warning when a rule fires, info otherwise
  if (typeof a.uri === "string" && Number.isInteger(a.line)) {   // the detail, pinned at the fn's line
    const head = callers.slice(0, 10);
    const lines = [`what if ${r.of.join(", ")} performed ${a.effect}? ${verdict}`];
    if (rules.length > 1) lines.push(`rules: ${rules.join("; ")}`);
    lines.push(head.length
      ? `callers: ${head.join(", ")}${callers.length > head.length ? ` +${callers.length - head.length} more` : ""}`
      : "no callers — the blast radius is the function itself");
    transient.set(a.uri, [{
      range: { start: { line: a.line, character: 0 }, end: { line: a.line, character: 200 } },
      severity: 3, source: "candor", code: "whatif", message: lines.join("\n"),
    }]);
    publishDiagnostics(a.uri);
  }
  return r;   // the raw whatif result rides back as the executeCommand result (a thick client can render it)
}

// The candor.fix command: the SAME query-core `fix` the CLI (`query.mjs fix`) and MCP (`candor_fix`) run —
// the boundary remedy (where the effect belongs + the hoist refactor), against the live policy (same source
// as the diagnostics). Re-read per call (the freshness contract). Malformed args → logMessage + null.
function runFix(a) {
  if (!a || typeof a !== "object" || typeof a.fn !== "string" || typeof a.effect !== "string") {
    logMessage(`candor-lsp: ${FIX_COMMAND} called with malformed arguments (expected [{ fn, effect, uri?, line? }]) — ignored`);
    return null;
  }
  if (!hasReport(reportPrefix)) {
    showMessage(2, "candor: no report found — scan first (candor-ts <dir> --out .candor/report)");
    return null;
  }
  const policyText = activePolicy();
  if (policyText === null) {
    showMessage(2, "candor: no policy discovered — a fix is defined relative to a boundary; set CANDOR_POLICY or check one into .candor/config");
    return null;
  }
  const r = Q.fix(Q.loadCallgraph(reportPrefix), Q.loadReport(reportPrefix), a.fn, a.effect,
                  parsePolicy(policyText), scopeMatches);
  if (r === null) {
    showMessage(2, `candor: no function matching \`${a.fn}\` in the call graph — the report may be stale`);
    return null;
  }
  if (!r.crossing) {
    showMessage(3, `candor: \`${a.fn}\` — ${a.effect} isn't forbidden here; no boundary fix needed`);
    return r;
  }
  const verdict = r.cleanHoist
    ? `candor fix: hoist ${a.effect} to ${r.hoistTo.join(", ")} — the ${r.deniedSpan.length} ${r.layer || "(root)"} function(s) then stay pure (or relax the boundary: ${r.policyAlternative})`
    : `candor fix: no clean hoist for ${a.effect} — introduce a port, or relax the boundary: ${r.policyAlternative}`;
  showMessage(2, verdict);
  if (typeof a.uri === "string" && Number.isInteger(a.line)) {   // the plan, pinned at the fn's line
    const lines = [`candor fix — hoist ${a.effect} out of the ${r.layer || "(root)"} boundary`];
    lines.push(`site: ${r.site.join(", ") || "(cross-module or Unknown source)"}`);
    if (r.cleanHoist) {
      lines.push(`hoist ${a.effect} to: ${r.hoistTo.join(", ")}`);
      lines.push(`then pure (thread the value): ${r.deniedSpan.join(", ")}`);
    } else {
      lines.push("no clean hoist — introduce a port (inject the effect from an allowed layer), or relax the boundary");
    }
    lines.push(`policy alternative: ${r.policyAlternative}`);
    transient.set(a.uri, [{
      range: { start: { line: a.line, character: 0 }, end: { line: a.line, character: 200 } },
      severity: 3, source: "candor", code: "fix", message: lines.join("\n"),
    }]);
    publishDiagnostics(a.uri);
  }
  return r;   // the raw remedy rides back as the executeCommand result (a thick client can render it)
}

// ---- the LSP method surface ---------------------------------------------------------------------------
function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    if (params?.rootUri) { try { rootPath = fileURLToPath(params.rootUri); } catch { /* keep null */ } }
    else if (params?.rootPath) rootPath = params.rootPath;
    if (params?.initializationOptions?.report) reportPrefix = params.initializationOptions.report;
    if (!reportPrefix && rootPath) {
      const cand = nodePath.join(rootPath, ".candor", "report");
      if (hasReport(cand)) reportPrefix = cand;
    }
    return result(id, {
      capabilities: {
        textDocumentSync: { openClose: true, save: true, change: 0 },  // report-backed: buffer edits don't move the map
        codeLensProvider: { resolveProvider: false },
        hoverProvider: true,
        codeActionProvider: { resolveProvider: false },                // actions carry their command inline
        executeCommandProvider: { commands: [WHATIF_COMMAND, FIX_COMMAND] },
      },
      serverInfo: { name: "candor-lsp", version: VERSION },
    });
  }
  if (method === "initialized" || method === "$/cancelRequest" || method === "$/setTrace") return;
  // didOpen/didSave/didChange drop the file's transient whatif overlay — a fresh look at the file (or an
  // edit) invalidates a hypothetical answered against the previous state. didChange is not negotiated
  // (change: 0) but is handled defensively for clients that send it anyway.
  if (method === "textDocument/didOpen") { transient.delete(params.textDocument.uri); return publishDiagnostics(params.textDocument.uri); }
  if (method === "textDocument/didSave") { transient.delete(params.textDocument.uri); return publishDiagnostics(params.textDocument.uri); }
  if (method === "textDocument/didChange") return clearTransient(params.textDocument.uri);
  if (method === "textDocument/didClose")
    return send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
  if (method === "textDocument/hover") {
    try { return result(id, hoverAt(fileURLToPath(params.textDocument.uri), params.position?.line ?? 0)); }
    catch { return result(id, null); }   // hover is best-effort — null, never a crash
  }
  if (method === "textDocument/codeLens") {
    try { return result(id, codeLenses(fileURLToPath(params.textDocument.uri))); }
    catch { return result(id, []); }   // a non-file URI / unreadable report → no lenses, never a crash
  }
  if (method === "textDocument/codeAction") {
    try { return result(id, codeActions(fileURLToPath(params.textDocument.uri), params.textDocument.uri, params.range)); }
    catch { return result(id, []); }   // unknown fn / non-file URI / unreadable report → no actions, never an error
  }
  if (method === "workspace/executeCommand") {
    const handlers = { [WHATIF_COMMAND]: runWhatif, [FIX_COMMAND]: runFix };
    const run = handlers[params?.command];
    if (!run) {
      logMessage(`candor-lsp: unknown command \`${params?.command}\` — this server provides ${WHATIF_COMMAND} and ${FIX_COMMAND}`);
      return result(id, null);
    }
    try { return result(id, run(params?.arguments?.[0])); }
    catch (e) { logMessage(`candor-lsp: ${params?.command} failed: ${e.message}`); return result(id, null); }
  }
  if (method === "shutdown") return result(id, null);
  if (method === "exit") process.exit(0);
  if (id !== undefined) error(id, -32601, `method not found: ${method}`);
}

// ---- LSP stdio transport (Content-Length framed JSON-RPC) ---------------------------------------------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.slice(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }            // skip an unframed preamble
    const len = parseInt(m[1], 10);
    if (buf.length < headerEnd + 4 + len) return;                     // body not fully arrived
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
    buf = buf.slice(headerEnd + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    try { handle(msg); } catch (e) { if (msg.id !== undefined) error(msg.id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
