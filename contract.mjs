import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The agent contract for THE INSTALLED VERSION — AGENTS.md ships in the npm tarball, so the doc and
// engine cannot drift (the spec §2.1 version-trust rule applied to documentation). ONE implementation
// used by both scan.mjs and query.mjs, so `--agents` output can never diverge within an install.
// `fd` and `budgetMs` are parameters ONLY so the suite can drive this exact loop against a real
// non-blocking fd. A guard that has never taken its own EAGAIN branch is a guard nobody has seen work,
// and this file's whole history is failure modes that only appear on a pipe. Production passes neither.
// `--agents` was never the only print-then-exit site — it was the only one that got FIXED, which is how
// the defect survived. `printAgents` now delegates to `writeStdoutSync` below so the next bulk-output
// site inherits the fix instead of being audited into it.
export function printAgents(fd = 1, budgetMs = 5000) {
  const dir = path.dirname(fileURLToPath(import.meta.url)); // the package root (where AGENTS.md ships)
  const semver = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  const out = `<!-- candor-ts ${semver} · the agent contract for this installed version -->\n`
    + fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  writeStdoutSync(out, "--agents", fd, budgetMs);
}

// ── THE SYNCHRONOUS BULK WRITER ───────────────────────────────────────────────────────────────────
// MEASURED on `scan.mjs --json --policy <p>` over a 400-file fixture with a violation: **95281 bytes to
// a FILE, valid JSON; 65536 bytes through a PIPE, a JSONDecodeError** — exactly the pipe buffer, exit 1
// either way, nothing on stderr. `console.log` is asynchronous on a pipe and `process.exit()` discards
// what is still buffered, which is the identical defect the `--agents` path was rewritten for, in the
// path a MACHINE consumer reads. The umbrella backlog asserted the opposite — that the remaining
// print-then-exit sites "fit the buffer and survive by SIZE" — which was true of the usage strings
// somebody measured and false of the report envelope nobody did.
//
// `what` names the caller, so the stderr diagnostic points at the surface that lost bytes.
// RETURNS true when every byte landed, false when it gave up (EAGAIN budget) or the reader left (EPIPE).
// The test driver needs that answer — an unfinished dump is an incomplete report and must turn the run
// red — and returning it is what let the driver delete its own private copy of this loop, which was
// unreachable from any route the suite drives and therefore untested by construction.
export function writeStdoutSync(out, what = "output", fd = 1, budgetMs = 5000) {
  // fs.writeSync, NOT console.log/process.stdout.write. On a PIPE those are asynchronous, and scan.mjs
  // calls `process.exit(0)` on the next line — which discards whatever is still buffered. The contract
  // came out TRUNCATED AT 8170 OF 23121 CHARACTERS, cut mid-sentence, with exit 0 and nothing on stderr:
  // an agent piping `candor-ts --agents` into its context silently read a third of its own instructions.
  // Only on a pipe — a redirect to a file writes synchronously, which is why this survived a manual
  // check and only the suite's execFileSync saw it.
  //
  // The comment above says one implementation cannot diverge, and it was still wrong: query.mjs `break`s
  // and drains on the way out, scan.mjs exits. THE SIBLING ROUTE AGAIN — sharing the PRINTER does not
  // share the EXIT, and the divergence lived in the caller the shared function was meant to protect.
  // Fixing it here rather than in scan.mjs is deliberate: the next caller inherits the fix.
  //
  // Two failure modes the first version of this did not handle, both specific to a PIPE, which is the
  // case it exists for:
  //   EPIPE  — the reader stopped early (`| head -n5`, `| grep -m1`, a consumer that closed). The old
  //            console.log path exited 0 silently; a bare writeSync raises, and a print-and-exit mode
  //            answering a contract request with a Node stack trace and exit 1 is a worse regression
  //            than the truncation this replaced. Swallowed — the reader left, that is not our error.
  //   EAGAIN — once stdout has been initialised, libuv puts the pipe in non-blocking mode and writeSync
  //            THROWS rather than short-writing as soon as the payload exceeds the 64 KiB pipe buffer.
  //            The contract is 24 KiB today, so this is latent, not live — and it would come back as
  //            exactly the truncation-plus-noise this function was written to remove. Retry with a
  //            small backoff (Atomics.wait is the only synchronous sleep available here) — BOUNDED, see
  //            below.
  //
  // WHAT THE BUDGET ACTUALLY BOUNDS: `budgetMs` of ZERO PROGRESS, not total wall-clock. The deadline
  // resets on every successful write, including a partial one, so a reader draining a chunk at a time
  // stretches the total to budget × the number of stalls. That is the RIGHT property — a slow reader must
  // not be cut off for being slow, and the failure this guards is a reader that has STOPPED — but
  // "bounded at 5s" was the wrong description of it, and the payload here is a fixed 24 KiB so the worst
  // case is a small multiple rather than unbounded. Measured with a 500ms budget against a reader taking
  // 4096 bytes every 400ms: 2409ms total, whole contract delivered, no give-up.
  //
  // THE RETRY IS BOUNDED, and it was not. `while (off < buf.length)` with an unconditional 1 ms sleep
  // spins FOREVER against a reader that stalls without ever closing — an agent harness that stops
  // reading while holding the pipe open, a log collector wedged on a full disk. EPIPE is the case where
  // the reader LEFT, and it is handled; this is the case where it stayed and stopped, and the two look
  // nothing alike from here. A hung `--agents` cannot be told from a slow one: it reports nothing, and
  // burns whatever timeout is around it. Both endings are bad, so pick the one that is legible — say so
  // on fd 2, in the same words as the EPIPE arm, and stop.
  //
  // WHY THE SAME BUDGET AS test.mjs's DRIVER: this is the identical hazard on the identical primitive,
  // and the fix went into the driver first while this one — the one an AGENT actually reads through a
  // pipe — was left spinning. The sibling route, again, and this side is the user-facing half.
  const EAGAIN_BUDGET_MS = budgetMs;
  let off = 0, deadline = 0;
  const buf = Buffer.from(out, "utf8");
  const idle = new Int32Array(new SharedArrayBuffer(4));
  try {
    while (off < buf.length) {
      try { off += fs.writeSync(fd, buf, off, buf.length - off); deadline = 0; }   // a short write is legal
      catch (e) {
        if (e.code !== "EAGAIN") throw e;
        // A wall-clock deadline, not a retry count: Atomics.wait's 1 ms is a FLOOR, so N turns is not N
        // milliseconds of anything. Reset on every byte that lands, so a slow reader is never punished
        // for being slow — only a stopped one runs the budget down.
        if (deadline === 0) deadline = Date.now() + EAGAIN_BUDGET_MS;
        else if (Date.now() >= deadline) {
          try { fs.writeSync(2, `candor-ts: ${what} output stalled at ${off} of ${buf.length} bytes `
                              + `— the reader has not drained for ${EAGAIN_BUDGET_MS}ms. This output is INCOMPLETE.\n`); }
          catch { /* nothing left to tell */ }
          return false;
        }
        Atomics.wait(idle, 0, 0, 1);
      }
    }
  } catch (e) {
    if (e.code !== "EPIPE") throw e;
    // SWALLOWED, BUT NOT SILENT. Exiting non-zero would make `--agents | head` a failure, which it is
    // not. But a truncated contract with exit 0 and an empty stderr is verbatim the defect this function
    // was rewritten to remove ("an agent piping candor-ts --agents into its context silently read a
    // third of its own instructions") — so the reader-left case has to be STATED. stderr may be closed
    // too; that write is best-effort by construction.
    try { fs.writeSync(2, `candor-ts: ${what} output was cut short at ${off} of ${buf.length} bytes `
                        + `— the reader closed the pipe. This output is INCOMPLETE.\n`); } catch { /* nothing left to tell */ }
    return false;
  }
  return true;
}

// ── SPEC §3.3.1 ⟨0.28⟩ THE SINK WRITER, AND THE ONE SHAPE THAT IS NEVER A SINK ────────────────────
//
// ONE IMPLEMENTATION, for the same reason `printAgents` and `writeStdoutSync` live here: scan.mjs and
// query.mjs are two entry points that must not import from each other, and until 2026-08-30 each
// carried its own byte-identical copy of these two functions plus its own spelling of the
// `.candor/config` shape check. That duplication is not theoretical drift — it is the measured
// SIBLING-ROUTE pattern: three guard-deletion findings were closed on query.mjs's copies on
// 2026-08-30, and scan.mjs's copies were still unprotected hours later (neutering all three left the
// full 1702-row battery green, while three hand repros destroyed a `.candor/config`, severed a symlink
// and stranded a hard-linked sink). Both routes now have watched-RED rows; keeping ONE implementation
// is what stops the third route from starting out with none.
//
// RESOLVE THE SINK TO ITS FINAL ARTIFACT BEFORE WRITING, and preserve the operator's layout.
// `renameSync` REPLACES a symlink rather than following it, so an `artifacts/verdict.json` linked into a
// shared directory kept a previous run's `{"ok": true}` while this run's document landed on the link — a
// stale green with a single `--gate-json` and no operator mistake. And rename gives the destination a NEW
// inode, so a multiply-linked target strands its other name with the previous document; there the write
// goes in place, trading the atomicity window for not publishing a stale verdict at a name the operator
// wired up. SPEC §3.3.1 states identity about ARTIFACTS; this family had it in the comparison only.
export function resolveSinkArtifact(p) {
  let cur = p;
  for (let i = 0; i < 32; i++) {
    let st;
    try { st = fs.lstatSync(cur); } catch { return cur; }
    if (!st.isSymbolicLink()) return cur;
    let t;
    try { t = fs.readlinkSync(cur); } catch { return cur; }
    cur = path.isAbsolute(t) ? t : path.join(path.dirname(cur), t);
  }
  return cur;
}

export function writeSinkAtomic(p, text) {
  const target = resolveSinkArtifact(p);
  try {
    if (fs.statSync(target).nlink > 1) { fs.writeFileSync(target, text); return; }
  } catch { /* not there yet — the ordinary temp+rename path is right */ }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

/** `.candor/config` is never a verdict sink, wherever it is — the SHAPE, not a discovered path.
 *  The per-input collision checks can only name inputs a run was TOLD about; the config is DISCOVERED
 *  by walking up from the target, so by the time its path is known the arming has already destroyed it.
 *  A check on the shape needs no discovery, so it runs before the first write and covers a config found
 *  anywhere up the tree. The PREDICATE is shared; each route keeps its own diagnostic and its own
 *  refusal plumbing (scan.mjs also feeds the ⟨0.28⟩ report stream through `refuseEarly`). */
export function isCandorConfigSink(p) {
  if (!p || p === "-") return false;
  const abs = path.resolve(p);
  return path.basename(abs) === "config" && path.basename(path.dirname(abs)) === ".candor";
}
