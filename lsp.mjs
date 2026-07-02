#!/usr/bin/env node
/**
 * candor-lsp — candor's effect map as a Language Server (AGENT-SURFACE-DESIGN bet 2, P1): the report,
 * rendered where the code is.
 *
 *   • CodeLens per effectful function: `⚡ Db, Net · blast radius 12` — the transitive effect set and
 *     how many functions transitively call it (who is affected if it changes).
 *   • Diagnostics: the repo's architecture-policy verdict (the §6.2 gate, resolved from CANDOR_POLICY
 *     or the checked-in .candor/config — spec §3.4) as squiggles at each violating function's line.
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
import { discoverConfigPolicy, evaluatePolicy, parsePolicy } from "./policy.mjs";

const VERSION = createRequire(import.meta.url)("./package.json").version;

// ---- state (set at initialize) ---------------------------------------------------------------------
let rootPath = null;
let reportPrefix = process.env.CANDOR_REPORT || process.argv[2] || null;

function hasReport(p) {
  if (!p) return false;
  if (fs.existsSync(`${p}.json`)) return true;
  const base = nodePath.basename(p);
  try {
    return fs.readdirSync(nodePath.dirname(p) || ".").some((f) => f.startsWith(base + ".") && f.endsWith(".json") && Q.isReport(f));
  } catch { return false; }
}

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
/** Every report entry whose loc maps into this document: [{ entry, line }]. Loaded FRESH per call. */
function entriesInDoc(docPath) {
  if (!hasReport(reportPrefix)) return null;
  const out = [];
  for (const e of Q.loadReport(reportPrefix)) {
    const lp = e.loc && locParts(e.loc);
    if (lp && docMatches(docPath, e.fn, lp.file)) out.push({ entry: e, line: lp.line });
  }
  return out;
}

// ---- CodeLens ---------------------------------------------------------------------------------------
function codeLenses(docPath) {
  const found = entriesInDoc(docPath);
  if (found === null) return [];
  const cg = Q.loadCallgraph(reportPrefix);
  return found.map(({ entry, line }) => {
    let blast = "";
    try {
      const c = Q.callers(cg, entry.fn);
      const n = (c && c.transitive && c.transitive.length) || 0;
      blast = ` · blast radius ${n}`;
    } catch { /* no callgraph — effects-only lens */ }
    const eff = (entry.inferred || []).join(", ") || "pure";
    return {
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
      command: { title: `⚡ ${eff}${blast}`, command: "" },   // informational lens (no action) — P1
    };
  });
}

// ---- Diagnostics (the live gate) ---------------------------------------------------------------------
function activePolicy() {
  const env = process.env.CANDOR_POLICY;
  if (env && fs.existsSync(env)) return fs.readFileSync(env, "utf8");
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
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(docPath) } });
  } catch (e) {
    logMessage(`candor-lsp: diagnostics failed for ${uri}: ${e.message}`);
  }
}
function logMessage(message) { send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 2, message } }); }

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
      },
      serverInfo: { name: "candor-lsp", version: VERSION },
    });
  }
  if (method === "initialized" || method === "$/cancelRequest" || method === "$/setTrace") return;
  if (method === "textDocument/didOpen") return publishDiagnostics(params.textDocument.uri);
  if (method === "textDocument/didSave") return publishDiagnostics(params.textDocument.uri);
  if (method === "textDocument/didChange") return;                    // see textDocumentSync: report-backed
  if (method === "textDocument/didClose")
    return send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
  if (method === "textDocument/codeLens") {
    try { return result(id, codeLenses(fileURLToPath(params.textDocument.uri))); }
    catch { return result(id, []); }   // a non-file URI / unreadable report → no lenses, never a crash
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
