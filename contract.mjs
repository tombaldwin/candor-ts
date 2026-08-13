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
  let off = 0;
  const buf = Buffer.from(out, "utf8");
  while (off < buf.length) off += fs.writeSync(1, buf, off, buf.length - off); // a short write is legal
}
