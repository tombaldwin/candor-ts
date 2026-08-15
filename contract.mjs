import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The agent contract for THE INSTALLED VERSION — AGENTS.md ships in the npm tarball, so the doc and
// engine cannot drift (the spec §2.1 version-trust rule applied to documentation). ONE implementation
// used by both scan.mjs and query.mjs, so `--agents` output can never diverge within an install.
export function printAgents() {
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
  //            small backoff (Atomics.wait is the only synchronous sleep available here).
  let off = 0;
  const buf = Buffer.from(out, "utf8");
  const idle = new Int32Array(new SharedArrayBuffer(4));
  try {
    while (off < buf.length) {
      try { off += fs.writeSync(1, buf, off, buf.length - off); }   // a short write is legal
      catch (e) { if (e.code !== "EAGAIN") throw e; Atomics.wait(idle, 0, 0, 1); }
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
