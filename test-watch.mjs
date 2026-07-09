#!/usr/bin/env node
/** Tests for watch.mjs — the freshness loop helpers, an end-to-end "edit → detect → re-scan → the
 *  report reflects the edit" check (the agent loop that feeds candor-ts-mcp live ground truth), and
 *  the LIVE LOOP itself (spawned process: stays alive, detects an edit, prints the Δ line). */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as W from "./watch.mjs";
import * as Q from "./query-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}  ${d}`));

const D = fs.mkdtempSync("/tmp/candor-watch-");
fs.writeFileSync(`${D}/app.ts`, `export function f(): void { /* pure */ }\n`);
fs.writeFileSync(`${D}/note.md`, `not a source\n`);
const OUT = `${D}/.candor/report`;

// ---- helpers --------------------------------------------------------------------------------------
const tracked = W.trackedFiles(D);
ok("trackedFiles: lists the TS source, skips the non-source", tracked.length === 1 && tracked[0].endsWith("app.ts"), tracked.join());
const h1 = W.hashFiles(tracked);
ok("hashFiles: one hash per tracked file", Object.keys(h1).length === 1);
ok("changedFiles: identical snapshots → no change", W.changedFiles(h1, h1).length === 0);

// ---- the freshness loop: a real edit is detected and the re-scan reflects it ----------------------
const first = W.scanOnce(D, OUT);
ok("scanOnce: produces a report", first.ok && fs.existsSync(`${OUT}.json`));
// initially f is pure → omitted from the report (no effect)
ok("report: the pure function carries no Net yet", !Q.where(Q.loadReport(OUT), "Net").directly.includes("app.f"));
const beforeRpt = W.readReportSafe(OUT); // snapshot for the edit-delta below

// the agent edits f to shell out to the network
fs.writeFileSync(`${D}/app.ts`, `import * as http from "node:http";\nexport function f(): void { http.get("http://x"); }\n`);
const h2 = W.hashFiles(W.trackedFiles(D));
const changed = W.changedFiles(h1, h2);
ok("changedFiles: the edited source is detected as changed", changed.length === 1 && changed[0].endsWith("app.ts"), changed.join());

// re-scan picks up the new effect — the report is now fresh
const second = W.scanOnce(D, OUT);
ok("scanOnce: the re-scan succeeds", second.ok);
ok("report is FRESH: f now reads Net after the edit (the live agent-loop payoff)",
   Q.where(Q.loadReport(OUT), "Net").directly.includes("app.f"), JSON.stringify(Q.where(Q.loadReport(OUT), "Net")));

// the EDIT-DELTA: the watcher tells the agent WHAT its edit did, not just that the report is fresh
const delta = Q.diff(W.readReportSafe(OUT), beforeRpt);
ok("edit-delta: the diff shows f gained Net (what the edit DID)",
   delta.changes.some((c) => c.fn.endsWith("f") && c.gained.includes("Net")), JSON.stringify(delta));
ok("formatDelta: renders the gain for the agent (e.g. 'f +Net')",
   W.formatDelta(delta.changes).includes("+Net"), W.formatDelta(delta.changes));
// and an editing-an-unrelated-marker write triggers NO source change (the gate)
fs.writeFileSync(`${D}/note.md`, `still not a source — touched\n`);
ok("the freshness gate: a non-source write is not a tracked change",
   W.changedFiles(h2, W.hashFiles(W.trackedFiles(D))).length === 0);

fs.rmSync(D, { recursive: true, force: true });

// ---- the LIVE loop, spawned for real -----------------------------------------------------------------
// This once shipped fully broken: an unref'd interval let Node exit ~0.6s after the startup scan, so the
// watcher did ONE scan and died while printing "Watching…" — and only the helpers were tested, so nothing
// caught it (watch.mjs's own comment records the incident). This is the pin for that exact bug class:
// spawn the real process, wait past the first scan, edit a source, and require (a) a second
// "re-scanned … Δ" line — the interval fired, the edit-delta rendered — (b) a SECOND edit is also
// detected (the loop persists across intervals, not a one-shot), (c) the process still alive, and
// (d) the documented Ctrl-C stop (SIGINT) is a GRACEFUL exit 0 — exit hooks run, so a NODE_V8_COVERAGE
// child flushes its coverage (TESTING.md §6) and a supervisor sees a clean stop, not a crash.
// Non-flaky by construction: every wait is a deadline-polled condition, never a fixed sleep (§9).
{
  const L = fs.mkdtempSync("/tmp/candor-watchlive-");
  fs.writeFileSync(`${L}/app.ts`, `export function f(): void { /* pure */ }\n`);
  const proc = spawn("node", [path.join(HERE, "watch.mjs"), L, "--interval", "150"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  const waitFor = (re, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (re.test(err) || Date.now() - t0 > ms) { clearInterval(iv); resolve(re.test(err)); }
    }, 50);
  });
  const started = await waitFor(/Watching…/, 30000);
  ok("live loop: the startup scan completes and the watcher announces itself", started, err.slice(0, 200));
  // the agent edits: f gains Net — the loop must detect it, re-scan, and print the Δ
  fs.writeFileSync(`${L}/app.ts`, `import * as http from "node:http";\nexport function f(): void { http.get("http://x"); }\n`);
  const rescanned = await waitFor(/re-scanned .*— Δ .*\+Net/, 30000);
  ok("live loop: the edit is detected, re-scanned, and the Δ line names the gained Net", rescanned, err.slice(-300));
  // a SECOND edit (revert to pure) must also be detected — the loop runs indefinitely, and the Δ
  // renders the LOST effect. This is the "still alive N intervals later" pin without a fixed sleep:
  // detecting it requires the interval to keep firing well after the first re-scan.
  fs.writeFileSync(`${L}/app.ts`, `export function f(): void { /* pure again */ }\n`);
  const rescanned2 = await waitFor(/re-scanned .*— Δ .*-Net/, 30000);
  ok("live loop: a SECOND edit re-scans too (the loop persists; Δ names the lost Net)", rescanned2, err.slice(-300));
  ok("live loop: the process is STILL ALIVE after both re-scans (the unref regression)",
     proc.exitCode === null, `exitCode=${proc.exitCode}`);
  // GRACEFUL shutdown: the documented stop is Ctrl-C — SIGINT must exit 0 (a clean stop, coverage
  // flushed), never die on the default signal handler (which skips exit hooks and reads as a crash).
  const exited = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000);
    proc.on("exit", (code) => { clearTimeout(t); resolve(code); });
  });
  proc.kill("SIGINT");
  const code = await exited;
  ok("live loop: SIGINT (the documented Ctrl-C stop) is a GRACEFUL exit 0 — not a signal death",
     code === 0, `exit code=${code} signal=${proc.signalCode}`);
  fs.rmSync(L, { recursive: true, force: true });
}

console.log(`\ntest-watch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
