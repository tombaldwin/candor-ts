import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch directories for the harnesses, removed when the run ends.
//
// WHY THIS EXISTS. Every harness here made fixture trees with a bare `fs.mkdtempSync` and removed none
// of them. Measured 2026-08-14: 46,919 `candor-*` directories in $TMPDIR, ~7,300 of them from test.mjs's
// `project()` alone, which mints one per fixture and is called ~1,300 times a run. It is not only
// untidy — it made a single `candor-swift privacy-manifest --verify` take 72 seconds, because listing
// the plist's ancestor meant listing all of $TMPDIR. The engine side of that was fixed in 2026-08-07;
// this is the side that keeps refilling the directory.
//
// KEPT ON FAILURE, DELIBERATELY. A failing assertion prints the path to its fixture tree, and deleting
// it on the way out would remove the evidence at exactly the moment someone needs it. `keepOnFailure()`
// lets a harness say "this run failed" and the trees survive, with a line saying where they are.
// Success is the common case and the one that accumulates.
//
// SIGINT/SIGTERM are handled because the killed-mid-run case was the obvious contributor — though 46,919
// is not all killed runs.
const made = [];
let keep = false;

export function scratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Call before exiting when the run FAILED — the trees are evidence, so they stay. */
export function keepOnFailure() { keep = true; }

function sweep() {
  if (keep) {
    if (made.length) console.log(`  (${made.length} fixture tree(s) kept for inspection under ${os.tmpdir()})`);
    return;
  }
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  made.length = 0;
}

process.on("exit", sweep);
// A signal does NOT run `exit` handlers on its own, which is the killed-mid-run leak. Re-raise after
// sweeping so the exit status still reflects the signal rather than becoming a clean 0.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { sweep(); process.kill(process.pid, sig); });
}
