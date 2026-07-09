#!/usr/bin/env node
/**
 * candor-lsp behavioral tests — the LSP P1 contract over a REAL scanned report:
 *   • initialize negotiates codeLens + open/save sync and resolves the workspace's .candor/report;
 *   • didOpen publishes the gate verdict as diagnostics (the .candor/config-discovered policy),
 *     at the violating function's line, severity error, code AS-EFF-006;
 *   • codeLens renders each effectful fn's `⚡ effects · blast radius N` at its loc line;
 *   • didClose clears diagnostics; unknown methods error; shutdown answers.
 * Hermetic: scans a throwaway project with the local scan.mjs, then drives lsp.mjs over LSP stdio
 * (Content-Length framing — deliberately NOT the MCP newline framing).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- fixture: a project whose leaf() performs Net, scanned for real ---------------------------------
const W = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-"));
fs.mkdirSync(path.join(W, "src"));
fs.writeFileSync(path.join(W, "src", "app.ts"), `import http from "node:http";
export function leaf(): void { http.get("http://x"); }
export function mid(): void { leaf(); }
export function handler(): void { mid(); }
`);
fs.mkdirSync(path.join(W, ".candor"));
execFileSync("node", [path.join(HERE, "scan.mjs"), path.join(W, "src"), "--out", path.join(W, ".candor", "report")], { stdio: "ignore" });
fs.writeFileSync(path.join(W, "arch.policy"), "deny Net\n");
fs.writeFileSync(path.join(W, ".candor", "config"), "policy arch.policy\n");
const DOC = pathToFileURL(path.join(W, "src", "app.ts")).href;

// ---- an LSP stdio session (Content-Length framing) ---------------------------------------------------
// Shutdown is GRACEFUL (TESTING.md §6): end stdin and let lsp.mjs exit on its own stdin-end handler —
// the old srv.kill() here discarded the child's NODE_V8_COVERAGE, so lsp.mjs measured 0% while actually
// exercised (the coverage policy names this exact trap). The exit code rides back with the replies so a
// server that stops exiting cleanly on stdin end FAILS a pin below; a hung server is killed after a
// deadline and surfaces as exitCode null (loud), never a silent hang.
function lspSession(messages, expectedInbound, extraEnv = {}) {
  return new Promise((resolve) => {
    const srv = spawn("node", [path.join(HERE, "lsp.mjs")], { env: { ...process.env, ...extraEnv } });
    let buf = Buffer.alloc(0);
    const inbound = [];
    let finishing = false;
    const finish = () => {
      if (finishing) return;
      finishing = true;
      const deadline = setTimeout(() => srv.kill("SIGKILL"), 15000);
      srv.on("exit", (code) => { clearTimeout(deadline); resolve({ inbound, exitCode: code }); });
      srv.stdin.end();
    };
    srv.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const he = buf.indexOf("\r\n\r\n");
        if (he < 0) break;
        const m = buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i);
        const len = m ? parseInt(m[1], 10) : 0;
        if (buf.length < he + 4 + len) break;
        inbound.push(JSON.parse(buf.slice(he + 4, he + 4 + len).toString()));
        buf = buf.slice(he + 4 + len);
        if (inbound.length >= expectedInbound) { finish(); return; }
      }
    });
    for (const msg of messages) {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      srv.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      srv.stdin.write(body);
    }
  });
}

const { inbound: replies, exitCode: mainExit } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", id: 2, method: "textDocument/codeLens", params: { textDocument: { uri: DOC } } },
  { jsonrpc: "2.0", id: 5, method: "textDocument/hover", params: { textDocument: { uri: DOC }, position: { line: 1, character: 4 } } },
  { jsonrpc: "2.0", id: 6, method: "textDocument/hover", params: { textDocument: { uri: DOC }, position: { line: 3, character: 4 } } },
  { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: DOC } } },
  { jsonrpc: "2.0", id: 3, method: "nosuch/method", params: {} },
  { jsonrpc: "2.0", id: 4, method: "shutdown" },
], 8); // init + didOpen diagnostics + lens + 2 hovers + didClose diagnostics + error + shutdown

const byId = (id) => replies.find((r) => r.id === id);
const notes = replies.filter((r) => r.method === "textDocument/publishDiagnostics");

const init = byId(1)?.result;
ok("initialize: codeLens capability + server identity",
   init?.capabilities?.codeLensProvider && init?.serverInfo?.name === "candor-lsp", JSON.stringify(init)?.slice(0, 120));

const diag = notes[0]?.params;
ok("didOpen publishes the config-discovered gate verdict as diagnostics",
   diag?.uri === DOC && diag.diagnostics.length >= 1, JSON.stringify(diag)?.slice(0, 160));
const d = diag?.diagnostics?.find((x) => x.code === "AS-EFF-006");
ok("the violation lands as source=candor, code=AS-EFF-006, severity=error",
   d && d.source === "candor" && d.severity === 1, JSON.stringify(diag?.diagnostics)?.slice(0, 160));
ok("the diagnostic sits at leaf()'s line (line 1, 0-based)",
   d?.range?.start?.line === 1, JSON.stringify(d?.range));

const lenses = byId(2)?.result ?? [];
ok("codeLens: each effectful fn gets a lens", lenses.length >= 3, `got ${lenses.length}`);
const leafLens = lenses.find((l) => l.range.start.line === 1);
ok("the leaf lens names the effect and the blast radius",
   /⚡ .*Net.*blast radius 2/.test(leafLens?.command?.title ?? ""), leafLens?.command?.title);

const hovLeaf = byId(5)?.result?.contents?.value ?? "";
ok("hover on leaf: direct effect named", hovLeaf.includes("**app.leaf**") && /Net.*performed directly here/.test(hovLeaf), hovLeaf.slice(0, 140));
ok("hover on leaf: blast radius present", /Blast radius: \*\*2\*\*/.test(hovLeaf), hovLeaf.slice(-60));
const hovHandler = byId(6)?.result?.contents?.value ?? "";
ok("hover on handler: inherited Net shows the provenance chain to the source",
   /Net.*via .*leaf \(source\)/.test(hovHandler), hovHandler.slice(0, 180));

ok("didClose clears the document's diagnostics",
   notes[1]?.params?.uri === DOC && notes[1].params.diagnostics.length === 0, JSON.stringify(notes[1]?.params));
ok("an unknown method errors (not silence)", byId(3)?.error?.code === -32601);
ok("shutdown answers null", byId(4) && byId(4).result === null);
ok("the server exits 0 on stdin end (graceful shutdown — coverage flushes, §6)", mainExit === 0, `exitCode=${mainExit}`);

// ── a SET-but-missing CANDOR_POLICY is disclosed (window/logMessage), never a silent source swap ────
// The family posture is loud-on-configured-but-unusable (scan exits 2 here); the LSP is advisory, so it
// warns and falls back to config discovery — but the swap must be visible, not quiet (review find).
// The same session also pins warnOnce's DEDUP: a second didOpen re-runs activePolicy, but the
// set-but-missing disclosure must log ONCE, not once per request (an advisory warning that repeats on
// every keystroke-adjacent event is noise an editor user turns off).
const { inbound: missReplies } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri: DOC } } },
], 4, { CANDOR_POLICY: path.join(W, "no-such.policy") }); // init + logMessage + 2× diagnostics
const logNote = missReplies.find((r) => r.method === "window/logMessage");
ok("set-but-missing CANDOR_POLICY logs a window/logMessage disclosure",
   logNote && /CANDOR_POLICY is set but .*no-such\.policy/.test(logNote.params?.message ?? ""),
   JSON.stringify(logNote)?.slice(0, 160));
const missDiag = missReplies.find((r) => r.method === "textDocument/publishDiagnostics");
ok("…and diagnostics still publish from the .candor/config fallback (the disclosed swap)",
   missDiag?.params?.diagnostics?.some((x) => x.code === "AS-EFF-006"), JSON.stringify(missDiag?.params)?.slice(0, 160));
ok("warnOnce: the disclosure logs ONCE across repeated didOpen/didSave (dedup, not per-request noise)",
   missReplies.filter((r) => r.method === "window/logMessage").length === 1
   && missReplies.filter((r) => r.method === "textDocument/publishDiagnostics").length === 2,
   JSON.stringify(missReplies.map((r) => r.method ?? r.id)));

// ── a SET-and-FOUND CANDOR_POLICY drives the diagnostics (the env happy path) ──────────────────────
// Only the missing-env arm was pinned; the env policy actually WINNING over .candor/config discovery
// (activePolicy's first return) had no test. The env policy uses a distinct scope (`deny Net app`) so
// the diagnostic's quoted rule text proves WHICH policy produced it — the config's is a bare `deny Net`.
fs.writeFileSync(path.join(W, "env.policy"), "deny Net app\n");
const { inbound: envReplies } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
], 2, { CANDOR_POLICY: path.join(W, "env.policy") }); // init + diagnostics (no logMessage)
const envDiag = envReplies.find((r) => r.method === "textDocument/publishDiagnostics");
const envD = envDiag?.params?.diagnostics?.find((x) => x.code === "AS-EFF-006");
ok("set-and-found CANDOR_POLICY drives the diagnostics (the env rule's own text in the message)",
   envD && /deny Net app/.test(envD.message), JSON.stringify(envDiag?.params)?.slice(0, 200));
ok("…with no window/logMessage (a usable env policy is not a disclosure event)",
   !envReplies.some((r) => r.method === "window/logMessage"), JSON.stringify(envReplies.map((r) => r.method ?? r.id)));

// ── the publishDiagnostics catch: a diagnostics-computation failure is DISCLOSED, never a crash ────
// CANDOR_POLICY pointing at a DIRECTORY passes existsSync but throws on read (EISDIR) inside
// diagnosticsFor — the catch must log "diagnostics failed", and the server must stay up (the next
// request still answers) rather than dying on one bad configuration.
const { inbound: dirReplies, exitCode: dirExit } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", id: 2, method: "shutdown" },
], 3, { CANDOR_POLICY: W }); // init + "diagnostics failed" logMessage + shutdown reply
ok("a diagnostics failure (CANDOR_POLICY = a directory) is disclosed via window/logMessage, not a crash",
   dirReplies.some((r) => r.method === "window/logMessage" && /diagnostics failed/.test(r.params?.message ?? "")),
   JSON.stringify(dirReplies).slice(0, 240));
ok("…and the server keeps serving after the failure (shutdown still answers; clean exit)",
   dirReplies.some((r) => r.id === 2 && r.result === null) && dirExit === 0,
   `exitCode=${dirExit}`);

// ── initialize via rootPath (the pre-URI LSP field): workspace + report still resolve ──────────────
// Only the rootUri arm was exercised; an editor sending the legacy `rootPath` string must get the same
// .candor/report resolution + config-discovered diagnostics.
const { inbound: rpReplies } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootPath: W } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
], 2);
const rpDiag = rpReplies.find((r) => r.method === "textDocument/publishDiagnostics");
ok("initialize with rootPath (non-URI) resolves the workspace report + publishes the gate diagnostics",
   rpDiag?.params?.diagnostics?.some((x) => x.code === "AS-EFF-006"), JSON.stringify(rpDiag?.params)?.slice(0, 160));

fs.rmSync(W, { recursive: true, force: true });
console.log(`\ntest-lsp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
