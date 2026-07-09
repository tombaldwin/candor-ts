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
function lspSession(messages, expectedInbound, extraEnv = {}) {
  return new Promise((resolve) => {
    const srv = spawn("node", [path.join(HERE, "lsp.mjs")], { env: { ...process.env, ...extraEnv } });
    let buf = Buffer.alloc(0);
    const inbound = [];
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
        if (inbound.length >= expectedInbound) { srv.stdin.end(); srv.kill(); resolve(inbound); return; }
      }
    });
    for (const msg of messages) {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      srv.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      srv.stdin.write(body);
    }
  });
}

const replies = await lspSession([
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

// ── a SET-but-missing CANDOR_POLICY is disclosed (window/logMessage), never a silent source swap ────
// The family posture is loud-on-configured-but-unusable (scan exits 2 here); the LSP is advisory, so it
// warns and falls back to config discovery — but the swap must be visible, not quiet (review find).
const missReplies = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
], 3, { CANDOR_POLICY: path.join(W, "no-such.policy") }); // init + logMessage + diagnostics
const logNote = missReplies.find((r) => r.method === "window/logMessage");
ok("set-but-missing CANDOR_POLICY logs a window/logMessage disclosure",
   logNote && /CANDOR_POLICY is set but .*no-such\.policy/.test(logNote.params?.message ?? ""),
   JSON.stringify(logNote)?.slice(0, 160));
const missDiag = missReplies.find((r) => r.method === "textDocument/publishDiagnostics");
ok("…and diagnostics still publish from the .candor/config fallback (the disclosed swap)",
   missDiag?.params?.diagnostics?.some((x) => x.code === "AS-EFF-006"), JSON.stringify(missDiag?.params)?.slice(0, 160));

fs.rmSync(W, { recursive: true, force: true });
console.log(`\ntest-lsp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
