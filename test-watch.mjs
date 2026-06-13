#!/usr/bin/env node
/** Tests for watch.mjs — the freshness loop helpers + an end-to-end "edit → detect → re-scan → the
 *  report reflects the edit" check (the agent loop that feeds candor-ts-mcp live ground truth). */
import fs from "node:fs";
import * as W from "./watch.mjs";
import * as Q from "./query-core.mjs";

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
// and an editing-an-unrelated-marker write triggers NO source change (the gate)
fs.writeFileSync(`${D}/note.md`, `still not a source — touched\n`);
ok("the freshness gate: a non-source write is not a tracked change",
   W.changedFiles(h2, W.hashFiles(W.trackedFiles(D))).length === 0);

fs.rmSync(D, { recursive: true, force: true });
console.log(`\ntest-watch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
