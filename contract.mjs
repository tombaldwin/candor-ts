import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The agent contract for THE INSTALLED VERSION — AGENTS.md ships in the npm tarball, so the doc and
// engine cannot drift (the spec §2.1 version-trust rule applied to documentation). ONE implementation
// used by both scan.mjs and query.mjs, so `--agents` output can never diverge within an install.
// `fd` and `budgetMs` are parameters ONLY so the suite can drive this exact loop against a real
// non-blocking fd. A guard that has never taken its own EAGAIN branch is a guard nobody has seen work,
// and this file's whole history is failure modes that only appear on a pipe. Production passes neither.
export function printAgents(fd = 1, budgetMs = 5000) {
  const dir = path.dirname(fileURLToPath(import.meta.url)); // the package root (where AGENTS.md ships)
  const semver = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  const out = `<!-- candor-ts ${semver} · the agent contract for this installed version -->\n`
    + fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
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
          try { fs.writeSync(2, `candor-ts: --agents output stalled at ${off} of ${buf.length} bytes `
                              + `— the reader has not drained for ${EAGAIN_BUDGET_MS}ms. This contract is INCOMPLETE.\n`); }
          catch { /* nothing left to tell */ }
          return;
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
    try { fs.writeSync(2, `candor-ts: --agents output was cut short at ${off} of ${buf.length} bytes `
                        + `— the reader closed the pipe. This contract is INCOMPLETE.\n`); } catch { /* nothing left to tell */ }
  }
}
