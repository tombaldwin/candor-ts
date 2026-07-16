#!/usr/bin/env node
/**
 * candor-lsp behavioral tests — the LSP P1 contract over a REAL scanned report:
 *   • initialize negotiates codeLens + open/save sync and resolves the workspace's .candor/report;
 *   • didOpen publishes the gate verdict as diagnostics (the .candor/config-discovered policy),
 *     at the violating function's line, severity error, code AS-EFF-006;
 *   • codeLens renders each effectful fn's `⚡ effects · blast radius N` at its loc line;
 *   • codeAction offers `candor: what if <fn> performed <E>?` per boundary effect the fn lacks, and
 *     the candor.whatif executeCommand answers with showMessage + a transient Information diagnostic
 *     (cleared on didSave), for: a rule-firing effect, a clean effect, a no-policy repo (radius only);
 *   • didClose clears diagnostics; unknown methods error; shutdown answers; malformed whatif args and
 *     unknown commands are logged, never a crash;
 *   • a 5k-fn synthetic fixture pins codeLens/codeAction latency (the large-repo perf gate).
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
// `deny Db app` is INERT against the real report (nothing performs Db) — it exists so the whatif
// code-action has a rule that fires only HYPOTHETICALLY, without disturbing the diagnostics pins.
fs.writeFileSync(path.join(W, "arch.policy"), "deny Net\ndeny Db app\n");
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
    const times = [];    // arrival timestamp per inbound message — the perf fixture reads reply gaps
    let finishing = false;
    const finish = () => {
      if (finishing) return;
      finishing = true;
      const deadline = setTimeout(() => srv.kill("SIGKILL"), 15000);
      srv.on("exit", (code) => { clearTimeout(deadline); resolve({ inbound, times, exitCode: code }); });
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
        times.push(Date.now());
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
ok("initialize: codeAction + executeCommand capabilities (the whatif surface, advertised)",
   init?.capabilities?.codeActionProvider
   && init?.capabilities?.executeCommandProvider?.commands?.includes("candor.whatif"),
   JSON.stringify(init?.capabilities)?.slice(0, 200));

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

// ── the pre-edit whatif code-action: offer → execute → transient diagnostic → didSave clears ────────
// leaf() already performs Net, so the offered actions are the OTHER boundary effects; `deny Db app`
// (inert against the real report) is the rule that fires only hypothetically. The command surfaces its
// answer as showMessage + a transient Information diagnostic, replaced on re-run, cleared on didSave.
const RANGE1 = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } };   // inside leaf()
const waArgs = (fn, effect) => [{ fn, effect, uri: DOC, line: 1 }];
const { inbound: waReplies, exitCode: waExit } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", id: 10, method: "textDocument/codeAction", params: { textDocument: { uri: DOC }, range: RANGE1, context: { diagnostics: [] } } },
  { jsonrpc: "2.0", id: 11, method: "textDocument/codeAction", params: { textDocument: { uri: DOC }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: [] } } },
  { jsonrpc: "2.0", id: 12, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: waArgs("app.leaf", "Db") } },
  { jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri: DOC } } },
  { jsonrpc: "2.0", id: 13, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: waArgs("app.leaf", "Exec") } },
  { jsonrpc: "2.0", id: 14, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: waArgs("app.nosuchfn", "Db") } },
  { jsonrpc: "2.0", id: 15, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: ["garbage"] } },
  { jsonrpc: "2.0", id: 16, method: "workspace/executeCommand", params: { command: "candor.nope", arguments: [] } },
  { jsonrpc: "2.0", id: 18, method: "workspace/executeCommand", params: { command: "candor.fix", arguments: waArgs("app.leaf", "Net") } },
  { jsonrpc: "2.0", id: 17, method: "shutdown" },
], 21); // …as before + (msg,diag,result) for the candor.fix crossing
const waById = (id) => waReplies.find((r) => r.id === id);
const waSeq = waReplies.map((r) => r.method ?? `id:${r.id}`);

const actions = waById(10)?.result ?? [];
const whatifActions = actions.filter((a) => a.command?.command === "candor.whatif");
const fixActions = actions.filter((a) => a.command?.command === "candor.fix");
ok("codeAction inside leaf(): one whatif action per boundary effect leaf lacks (Net excluded)",
   whatifActions.length === 6 && !whatifActions.some((a) => a.title.includes("performed Net"))
   && ["Db", "Llm", "Exec", "Fs", "Ipc", "Clipboard"].every((e) => whatifActions.some((a) => a.title === `candor: what if app.leaf performed ${e}?`)),
   JSON.stringify(actions.map((a) => a.title)));
// leaf() PERFORMS Net and the active policy forbids it → the remedial companion offers the fix (only for a
// real crossing; the whatif actions above are for effects leaf lacks — the two are complementary).
ok("codeAction inside leaf(): a candor.fix action for the Net crossing leaf() actually has",
   fixActions.length === 1 && fixActions[0].title === "candor fix: hoist Net out of app.leaf"
   && fixActions[0].command.arguments?.[0]?.fn === "app.leaf" && fixActions[0].command.arguments[0].effect === "Net",
   JSON.stringify(fixActions.map((a) => a.title)));
ok("each action carries its command (whatif|fix) with {fn, effect, uri, line} arguments",
   actions.every((a) => (a.command?.command === "candor.whatif" || a.command?.command === "candor.fix")
     && a.command.arguments?.[0]?.fn === "app.leaf" && a.command.arguments[0].uri === DOC
     && a.command.arguments[0].line === 1),
   JSON.stringify(actions[0]?.command));
// candor.fix executeCommand: leaf() performs Net under `deny Net` (whole-project) → a crossing with NO clean
// hoist (every caller is also denied); runFix returns the raw remedy and surfaces the port/relax guidance.
const fixResult = waById(18)?.result;
ok("candor.fix executeCommand returns the raw remedy (crossing, no clean hoist under whole-project deny)",
   fixResult?.crossing === true && fixResult.cleanHoist === false
   && fixResult.site?.includes("app.leaf") && fixResult.policyAlternative === "allow Net",
   JSON.stringify(fixResult));
ok("codeAction outside any known fn (line 0) → no actions, never an error",
   Array.isArray(waById(11)?.result) && waById(11).result.length === 0, JSON.stringify(waById(11)));

// exec 12: the hypothetical Db fires `deny Db app` — showMessage one-liner + transient detail diagnostic.
const fireIdx = waSeq.indexOf("id:12");
const fireMsg = waReplies.slice(0, fireIdx).reverse().find((r) => r.method === "window/showMessage");
ok("whatif(leaf, Db): showMessage names the rule that WOULD fire + the caller radius",
   fireMsg?.params?.type === 2 && /✗ deny Db app would fire — 2 caller\(s\) inherit Db/.test(fireMsg?.params?.message ?? ""),
   JSON.stringify(fireMsg?.params));
const fireDiagNote = waReplies.slice(0, fireIdx).reverse().find((r) => r.method === "textDocument/publishDiagnostics");
const fireDiag = fireDiagNote?.params?.diagnostics?.find((x) => x.code === "whatif");
ok("…and a transient Information diagnostic at leaf's line carries the detail (rule + callers)",
   fireDiag && fireDiag.severity === 3 && fireDiag.source === "candor" && fireDiag.range.start.line === 1
   && /callers: app\.handler, app\.mid/.test(fireDiag.message), JSON.stringify(fireDiag)?.slice(0, 300));
ok("…alongside the standing gate diagnostics, not replacing them",
   fireDiagNote?.params?.diagnostics?.some((x) => x.code === "AS-EFF-006"),
   JSON.stringify(fireDiagNote?.params?.diagnostics?.map((x) => x.code)));
const fireRes = waById(12)?.result;
ok("…and the executeCommand result is the raw whatif shape (ok:false, violations, affected)",
   fireRes?.ok === false && fireRes.effect === "Db" && fireRes.affected?.length === 3
   && fireRes.violations?.every((v) => v.rule === "deny Db app"), JSON.stringify(fireRes)?.slice(0, 200));

// didSave clears the transient overlay (the gate diagnostics republish without the whatif code).
const saveDiag = waReplies.slice(fireIdx + 1).find((r) => r.method === "textDocument/publishDiagnostics");
ok("didSave clears the transient whatif diagnostic (gate diagnostics remain)",
   saveDiag && !saveDiag.params.diagnostics.some((x) => x.code === "whatif")
   && saveDiag.params.diagnostics.some((x) => x.code === "AS-EFF-006"),
   JSON.stringify(saveDiag?.params?.diagnostics?.map((x) => x.code)));

// exec 13: a clean hypothetical — no rule fires, the radius still reported (and the overlay returns).
const cleanIdx = waSeq.indexOf("id:13");
const cleanMsg = waReplies.slice(fireIdx + 1, cleanIdx).reverse().find((r) => r.method === "window/showMessage");
ok("whatif(leaf, Exec): no rule fires — info message still reports the radius",
   cleanMsg?.params?.type === 3 && /✓ no policy rule fires — 2 caller\(s\) would inherit Exec/.test(cleanMsg?.params?.message ?? ""),
   JSON.stringify(cleanMsg?.params));
ok("…with ok:true and empty violations in the result", waById(13)?.result?.ok === true && waById(13).result.violations.length === 0);

// exec 14–16: the no-crash discipline — stale fn, malformed args, unknown command.
const missIdx = waSeq.indexOf("id:14");
const missMsg = waReplies.slice(cleanIdx + 1, missIdx).reverse().find((r) => r.method === "window/showMessage");
ok("whatif on a fn the callgraph doesn't know: a showMessage miss (stale-report hint), result null",
   /no function matching `app\.nosuchfn`/.test(missMsg?.params?.message ?? "") && waById(14)?.result === null,
   JSON.stringify(missMsg?.params));
ok("malformed candor.whatif arguments: logged, result null, never a throw",
   waReplies.some((r) => r.method === "window/logMessage" && /malformed arguments/.test(r.params?.message ?? ""))
   && waById(15)?.result === null, JSON.stringify(waById(15)));
ok("an unknown workspace command: logged, result null",
   waReplies.some((r) => r.method === "window/logMessage" && /unknown command `candor\.nope`/.test(r.params?.message ?? ""))
   && waById(16)?.result === null, JSON.stringify(waById(16)));
ok("the whatif session still shuts down cleanly (exit 0 on stdin end)", waById(17)?.result === null && waExit === 0, `exitCode=${waExit}`);

// ── a no-policy repo: the whatif still answers — blast radius only, and SAYS so ────────────────────
const W2 = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-nopol-"));
fs.mkdirSync(path.join(W2, "src"));
fs.copyFileSync(path.join(W, "src", "app.ts"), path.join(W2, "src", "app.ts"));
fs.mkdirSync(path.join(W2, ".candor"));
execFileSync("node", [path.join(HERE, "scan.mjs"), path.join(W2, "src"), "--out", path.join(W2, ".candor", "report")], { stdio: "ignore" });
const DOC2 = pathToFileURL(path.join(W2, "src", "app.ts")).href;
const { inbound: npReplies } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(W2).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DOC2, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", id: 2, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: [{ fn: "app.leaf", effect: "Db", uri: DOC2, line: 1 }] } },
], 5); // init + didOpen diag + showMessage + transient diag + result
const npMsg = npReplies.find((r) => r.method === "window/showMessage");
ok("no policy discovered: the whatif says so and still reports the blast radius",
   /no policy discovered — blast radius only: 2 caller\(s\) would inherit Db/.test(npMsg?.params?.message ?? ""),
   JSON.stringify(npMsg?.params));
ok("…result: ok:true, no violations, the affected set intact",
   npReplies.find((r) => r.id === 2)?.result?.ok === true && npReplies.find((r) => r.id === 2).result.affected.length === 3,
   JSON.stringify(npReplies.find((r) => r.id === 2)?.result)?.slice(0, 160));
fs.rmSync(W2, { recursive: true, force: true });

// ── large-repo latency (the P2 perf slice): 5k fns, one 5k-deep call chain, 50 files ────────────────
// A synthetic report+callgraph written directly (no scan — the fixture pins the CONSUMER's cost). The
// opened doc holds the 100 fns with the DEEPEST caller radii (worst-case BFS per lens). The pin is a
// loose 1000ms — vs ~200ms budget and single-digit-ms measured (see below) — so it catches a complexity
// regression (an O(n²) inversion-per-lens relapse) without flaking on a slow CI box.
const PERF = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-perf-"));
fs.mkdirSync(path.join(PERF, ".candor"));
{
  const functions = [], cg = {};
  const nameOf = (i) => `f${Math.floor(i / 100)}.fn${i}`;
  for (let i = 0; i < 5000; i++) {
    functions.push({ fn: nameOf(i), inferred: ["Net"], direct: i === 0 ? ["Net"] : [], calls: [],
                     loc: `src/f${Math.floor(i / 100)}.ts:${(i % 100) + 1}` });
    cg[nameOf(i)] = i > 0 ? [nameOf(i - 1)] : [];      // one 5000-deep chain: fn_i → fn_{i-1}
  }
  fs.writeFileSync(path.join(PERF, ".candor", "report.json"), JSON.stringify({ candor: { version: "perf-fixture", spec: "0.18" }, functions }));
  fs.writeFileSync(path.join(PERF, ".candor", "report.callgraph.json"), JSON.stringify(cg));
}
const PDOC = pathToFileURL(path.join(PERF, "src", "f0.ts")).href;   // fns 0..99 — the deep end of the chain
const { inbound: pfReplies, times: pfTimes } = await lspSession([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(PERF).href } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: PDOC, languageId: "typescript", version: 1, text: "" } } },
  { jsonrpc: "2.0", id: 2, method: "textDocument/codeLens", params: { textDocument: { uri: PDOC } } },
  { jsonrpc: "2.0", id: 3, method: "textDocument/codeAction", params: { textDocument: { uri: PDOC }, range: RANGE1, context: { diagnostics: [] } } },
  { jsonrpc: "2.0", id: 4, method: "shutdown" },
], 5); // init + didOpen diag + lens + action + shutdown
const pfSeq = pfReplies.map((r) => r.method ?? `id:${r.id}`);
const lensMs = pfTimes[pfSeq.indexOf("id:2")] - pfTimes[pfSeq.indexOf("id:2") - 1];
const actionMs = pfTimes[pfSeq.indexOf("id:3")] - pfTimes[pfSeq.indexOf("id:3") - 1];
console.log(`  perf 5k-fn fixture: codeLens ${lensMs}ms, codeAction ${actionMs}ms (budget ~200ms; pin 1000ms)`);
ok("5k-fn fixture: codeLens answers all 100 doc fns with blast radii",
   (pfReplies.find((r) => r.id === 2)?.result ?? []).length === 100
   && /blast radius 4999/.test(pfReplies.find((r) => r.id === 2).result.find((l) => l.range.start.line === 0)?.command?.title ?? ""),
   JSON.stringify(pfReplies.find((r) => r.id === 2)?.result?.[0]));
ok("5k-fn fixture: codeLens latency within the large-repo pin", lensMs < 1000, `${lensMs}ms`);
ok("5k-fn fixture: codeAction latency within the large-repo pin",
   actionMs < 1000 && (pfReplies.find((r) => r.id === 3)?.result ?? []).length === 6, `${actionMs}ms`);
fs.rmSync(PERF, { recursive: true, force: true });

fs.rmSync(W, { recursive: true, force: true });
// ── the activity push (AGENT-SURFACE-DESIGN.md P2): a new BLOCKED record surfaces in-editor ─────────
{
  const AW = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-act-"));
  fs.mkdirSync(path.join(AW, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(AW, "edited.ts"), "export const x = 1;\n");
  const LOG = path.join(AW, ".candor", "activity.jsonl");
  fs.writeFileSync(LOG, '{"ts":"2026-07-14T09:00:00Z","verdict":"blocked","gained":["Db"],"blastRadius":9}\n'); // PRE-EXISTING — must NOT replay
  const blocked = '{"ts":"2026-07-14T10:00:00Z","sessionId":"s1","engine":"candor-scan","edited":["edited.ts"],"gained":["Fs"],"blastRadius":3,"maxHops":2,"verdict":"blocked","violations":["AS-EFF-006"]}\n';
  const clean = '{"ts":"2026-07-14T10:01:00Z","verdict":"clean","gained":[],"blastRadius":0}\n';
  const got = await new Promise((resolve) => {
    const srv = spawn("node", [path.join(HERE, "lsp.mjs")], { env: { ...process.env, CANDOR_LSP_ACTIVITY_POLL_MS: "80" } });
    let buf = Buffer.alloc(0); const inbound = [];
    const send = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); srv.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); srv.stdin.write(b); };
    const deadline = setTimeout(() => { srv.kill("SIGKILL"); resolve(inbound); }, 15000);
    srv.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const he = buf.indexOf("\r\n\r\n"); if (he < 0) break;
        const m = buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i);
        const len = m ? parseInt(m[1], 10) : 0;
        if (buf.length < he + 4 + len) break;
        inbound.push(JSON.parse(buf.slice(he + 4, he + 4 + len).toString()));
        buf = buf.slice(he + 4 + len);
        // done once we've seen: the blocked showMessage, the overlay publish, and the clean-record clear
        const clears = inbound.filter((x) => x.method === "textDocument/publishDiagnostics" && x.params.diagnostics.length === 0).length;
        if (inbound.some((x) => x.method === "window/showMessage" && /candor gate: blocked/.test(x.params.message)) && clears >= 1) {
          clearTimeout(deadline); srv.kill(); resolve(inbound); return;
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(AW).href } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    setTimeout(() => fs.appendFileSync(LOG, blocked), 250);   // appended AFTER startup — this one pushes
    setTimeout(() => fs.appendFileSync(LOG, clean), 900);     // then the gate goes green — overlay clears
  });
  const msgs = got.filter((x) => x.method === "window/showMessage").map((x) => x.params.message);
  const gateMsg = msgs.find((m) => /candor gate: blocked/.test(m)) || "";
  ok("activity push: a NEW blocked record shows the delta in-editor",
     /introduces \{Fs\}/.test(gateMsg) && /blast radius 3/.test(gateMsg) && /deepest propagation 2 hop/.test(gateMsg) && /AS-EFF-006/.test(gateMsg), gateMsg);
  ok("activity push: the PRE-EXISTING record did not replay (no Db message)", !msgs.some((m) => /\{Db\}/.test(m)), msgs.join(" | "));
  const pubs = got.filter((x) => x.method === "textDocument/publishDiagnostics" && /edited\.ts$/.test(x.params.uri));
  ok("activity push: the edited file carries a transient gate diagnostic", pubs.some((p) => p.params.diagnostics.some((d) => d.code === "gate")), JSON.stringify(pubs[0]?.params ?? {}));
  ok("activity push: the next CLEAN record clears the overlay", pubs.some((p) => p.params.diagnostics.length === 0));
  fs.rmSync(AW, { recursive: true, force: true });
}

{
  // off-switch: CANDOR_LSP_ACTIVITY=off → no push even when a blocked record lands
  const AW = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-actoff-"));
  fs.mkdirSync(path.join(AW, ".candor"), { recursive: true });
  const LOG = path.join(AW, ".candor", "activity.jsonl"); fs.writeFileSync(LOG, "");
  const got = await new Promise((resolve) => {
    const srv = spawn("node", [path.join(HERE, "lsp.mjs")], { env: { ...process.env, CANDOR_LSP_ACTIVITY: "off", CANDOR_LSP_ACTIVITY_POLL_MS: "80" } });
    let buf = Buffer.alloc(0); const inbound = [];
    const send = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); srv.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); srv.stdin.write(b); };
    setTimeout(() => { srv.kill(); resolve(inbound); }, 1200);
    srv.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const he = buf.indexOf("\r\n\r\n"); if (he < 0) break;
        const m = buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i);
        const len = m ? parseInt(m[1], 10) : 0;
        if (buf.length < he + 4 + len) break;
        inbound.push(JSON.parse(buf.slice(he + 4, he + 4 + len).toString()));
        buf = buf.slice(he + 4 + len);
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(AW).href } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    setTimeout(() => fs.appendFileSync(LOG, '{"verdict":"blocked","gained":["Fs"],"blastRadius":1}\n'), 200);
  });
  ok("activity push: CANDOR_LSP_ACTIVITY=off disables it", !got.some((x) => x.method === "window/showMessage" && /candor gate/.test(x.params.message)));
  fs.rmSync(AW, { recursive: true, force: true });
}

// ── a phase-driven LSP session for the poll-timed activity tests: send frames, AWAIT inbound
// predicates (scanned in arrival order, each match consumed — so identical-looking publishes in
// different phases don't alias), instead of a fixed reply count.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lspDrive(extraEnv = {}) {
  const srv = spawn("node", [path.join(HERE, "lsp.mjs")], { env: { ...process.env, CANDOR_LSP_ACTIVITY_POLL_MS: "80", ...extraEnv } });
  let buf = Buffer.alloc(0);
  const inbound = [];
  const waiters = [];
  srv.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const he = buf.indexOf("\r\n\r\n"); if (he < 0) break;
      const m = buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i);
      const len = m ? parseInt(m[1], 10) : 0;
      if (buf.length < he + 4 + len) break;
      inbound.push(JSON.parse(buf.slice(he + 4, he + 4 + len).toString()));
      buf = buf.slice(he + 4 + len);
      for (const w of [...waiters]) w();
    }
  });
  let scanFrom = 0;
  const waitFor = (pred, timeout = 10000) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { done = true; waiters.splice(waiters.indexOf(scan), 1); resolve(null); }, timeout);
    function scan() {
      if (done) return;
      for (let i = scanFrom; i < inbound.length; i++) {
        if (pred(inbound[i])) {
          done = true; scanFrom = i + 1; clearTimeout(t);
          waiters.splice(waiters.indexOf(scan), 1); resolve(inbound[i]); return;
        }
      }
    }
    waiters.push(scan);
    scan();
  });
  const send = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); srv.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); srv.stdin.write(b); };
  // graceful close (TESTING.md §6 — coverage flushes on stdin end), SIGKILL only as the hang backstop
  const close = () => new Promise((resolve) => {
    const t = setTimeout(() => srv.kill("SIGKILL"), 5000);
    srv.on("exit", (code) => { clearTimeout(t); resolve(code); });
    srv.stdin.end();
  });
  return { inbound, waitFor, send, close };
}

// ── FINDING 1 regression: the writer's cap trim-rewrite (any size DECREASE) must NOT replay history ──
// lib-candor-summary.sh rewrites the log via tail+mv on EVERY append once past CANDOR_ACTIVITY_CAP, so
// a shrink is routine — the old offset-to-0 reset replayed the whole trimmed tail (~5000 records, each
// blocked one a showMessage) on every poll. The fix skips the tail to the file's END.
{
  const AW = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-trim-"));
  fs.mkdirSync(path.join(AW, ".candor"), { recursive: true });
  const LOG = path.join(AW, ".candor", "activity.jsonl");
  const oldLine = (i) => `{"ts":"2026-07-14T0${i % 10}:00:00Z","verdict":"blocked","edited":null,"gained":["Db"],"blastRadius":${i}}\n`;
  fs.writeFileSync(LOG, Array.from({ length: 20 }, (_, i) => oldLine(i)).join(""));
  const s = lspDrive();
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(AW).href } });
  s.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await s.waitFor((m) => m.id === 1);
  await sleep(250);                                     // let the tail settle at the initial size
  // the writer's trim: keep the last 10 lines, replace atomically (tail > tmp && mv — same shape)
  const tail = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).slice(-10).map((l) => l + "\n").join("");
  fs.writeFileSync(LOG + ".tmp", tail);
  fs.renameSync(LOG + ".tmp", LOG);
  await sleep(400);                                     // several polls observe the shrunken file
  // a genuinely NEW record appended AFTER the rewrite must still push (the tail re-anchored at the end)
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T12:00:00Z","verdict":"blocked","edited":null,"gained":["Exec"],"blastRadius":1}\n');
  const fresh = await s.waitFor((m) => m.method === "window/showMessage" && /introduces \{Exec\}/.test(m.params.message));
  await s.close();
  const gateMsgs = s.inbound.filter((m) => m.method === "window/showMessage" && /candor gate: blocked/.test(m.params.message));
  ok("trim-rewrite: NO historical record replays after the size decrease (no Db flood)",
     !gateMsgs.some((m) => /\{Db\}/.test(m.params.message)), gateMsgs.map((m) => m.params.message).join(" | ").slice(0, 200));
  ok("trim-rewrite: a record appended AFTER the rewrite still pushes (tail re-anchored at the end, not wedged)",
     fresh !== null && gateMsgs.length === 1, `gate messages: ${gateMsgs.length}`);
  fs.rmSync(AW, { recursive: true, force: true });
}

// ── FINDING 2 regression: the activity gate overlay and the whatif overlay COEXIST and clear
// independently — a blocked record must not clobber a live whatif; a clean record must not delete it.
{
  // realpath'd fixture so the client uri and the tailer's canonical key coincide (the DIVERGENT case
  // is pinned separately below); no policy → every published diagnostic is an overlay.
  const WA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-ovl-")));
  fs.mkdirSync(path.join(WA, "src"));
  fs.writeFileSync(path.join(WA, "src", "app.ts"), `import http from "node:http";
export function leaf(): void { http.get("http://x"); }
export function mid(): void { leaf(); }
export function handler(): void { mid(); }
`);
  fs.mkdirSync(path.join(WA, ".candor"));
  execFileSync("node", [path.join(HERE, "scan.mjs"), path.join(WA, "src"), "--out", path.join(WA, ".candor", "report")], { stdio: "ignore" });
  const LOG = path.join(WA, ".candor", "activity.jsonl");
  fs.writeFileSync(LOG, "");
  const ADOC = pathToFileURL(path.join(WA, "src", "app.ts")).href;
  const pub = (m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === ADOC;
  const codes = (m) => m.params.diagnostics.map((d) => d.code);
  const s = lspDrive();
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(WA).href } });
  s.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  s.send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: ADOC, languageId: "typescript", version: 1, text: "" } } });
  await s.waitFor(pub);                                 // the didOpen publish (empty — no policy)
  s.send({ jsonrpc: "2.0", id: 2, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: [{ fn: "app.leaf", effect: "Db", uri: ADOC, line: 1 }] } });
  const p1 = await s.waitFor((m) => pub(m) && codes(m).includes("whatif"));
  ok("overlay coexistence: the whatif overlay publishes (radius-only, no-policy repo)", p1 !== null, JSON.stringify(p1?.params));
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T10:00:00Z","verdict":"blocked","edited":["src/app.ts"],"gained":["Fs"],"blastRadius":3,"violations":["AS-EFF-006"]}\n');
  const p2 = await s.waitFor((m) => pub(m) && codes(m).includes("gate"));
  ok("a blocked record ADDS the gate overlay alongside the live whatif overlay (no clobber — own map)",
     p2 !== null && codes(p2).includes("whatif"), JSON.stringify(p2?.params.diagnostics.map((d) => d.code)));
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T10:01:00Z","verdict":"clean","gained":[],"blastRadius":0}\n');
  const p3 = await s.waitFor((m) => pub(m) && !codes(m).includes("gate"));
  ok("the next clean record clears ONLY the gate overlay — the whatif overlay SURVIVES",
     p3 !== null && codes(p3).includes("whatif"), JSON.stringify(p3?.params.diagnostics.map((d) => d.code)));
  s.send({ jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri: ADOC } } });
  const p4 = await s.waitFor((m) => pub(m) && m.params.diagnostics.length === 0);
  ok("didSave clears the whatif overlay too (both overlay layers gone)", p4 !== null, JSON.stringify(p4?.params));
  // the 2a regression proper: after a save PRUNED the file from activityOverlaid, a later clean record
  // must not touch the file's FRESH whatif overlay (the old shared map deleted it).
  s.send({ jsonrpc: "2.0", id: 3, method: "workspace/executeCommand", params: { command: "candor.whatif", arguments: [{ fn: "app.leaf", effect: "Exec", uri: ADOC, line: 1 }] } });
  await s.waitFor((m) => pub(m) && codes(m).includes("whatif"));
  const pubsBefore = s.inbound.filter(pub).length;
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T10:02:00Z","verdict":"clean","gained":[],"blastRadius":0}\n');
  await sleep(400);                                     // several polls process the clean record
  ok("a clean record after the save leaves the fresh whatif overlay untouched (pruned bookkeeping — no republish)",
     s.inbound.filter(pub).length === pubsBefore, `publishes went ${pubsBefore} → ${s.inbound.filter(pub).length}`);
  await s.close();
  fs.rmSync(WA, { recursive: true, force: true });
}

// ── FINDING 3 regression: the activity overlay clears through CANONICAL keys even when the client's
// uri encoding diverges from the server-computed one. The divergences exercised: a percent-encoded
// letter in the client's uri ("%65dited.ts" = "edited.ts" — every platform), and, on macOS, the
// tmpdir symlink (/var → /private/var: the fixture path is NOT realpath'd, the tailer's key is).
{
  const AC = fs.mkdtempSync(path.join(os.tmpdir(), "candor-lsp-enc-"));
  fs.mkdirSync(path.join(AC, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(AC, "edited.ts"), "export const x = 1;\n");
  const LOG = path.join(AC, ".candor", "activity.jsonl");
  fs.writeFileSync(LOG, "");
  const variant = pathToFileURL(path.join(AC, "edited.ts")).href.replace(/edited\.ts$/, "%65dited.ts");
  const pubEdited = (m) => m.method === "textDocument/publishDiagnostics" && /dited\.ts$/.test(m.params.uri);
  const s = lspDrive();
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(AC).href } });
  s.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await s.waitFor((m) => m.id === 1);
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T10:00:00Z","verdict":"blocked","edited":["edited.ts"],"gained":["Fs"],"blastRadius":1,"violations":["AS-EFF-006"]}\n');
  const set = await s.waitFor((m) => pubEdited(m) && m.params.diagnostics.some((d) => d.code === "gate"));
  ok("divergent-encoding: the blocked record sets the gate overlay (server-computed key)", set !== null, JSON.stringify(set?.params));
  // the clear arrives under a DIFFERENT uri string for the same file — must still find the overlay
  s.send({ jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri: variant } } });
  const cleared = await s.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === variant);
  ok("divergent-encoding: didSave under the variant uri publishes WITHOUT the gate overlay (canonical lookup)",
     cleared !== null && cleared.params.diagnostics.length === 0, JSON.stringify(cleared?.params));
  // the decisive pin: the save must have PRUNED the canonical key — a later clean record then has
  // nothing to republish. The wedged (string-keyed) overlay republished the server uri here.
  const pubsBefore = s.inbound.filter(pubEdited).length;
  fs.appendFileSync(LOG, '{"ts":"2026-07-14T10:01:00Z","verdict":"clean","gained":[],"blastRadius":0}\n');
  await sleep(400);
  ok("divergent-encoding: the variant-uri save PRUNED the overlay bookkeeping (a later clean record republishes nothing)",
     s.inbound.filter(pubEdited).length === pubsBefore, `publishes went ${pubsBefore} → ${s.inbound.filter(pubEdited).length}`);
  await s.close();
  fs.rmSync(AC, { recursive: true, force: true });
}

console.log(`\ntest-lsp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
