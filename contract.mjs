import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The agent contract for THE INSTALLED VERSION — AGENTS.md ships in the npm tarball, so the doc and
// engine cannot drift (the spec §2.1 version-trust rule applied to documentation). ONE implementation
// used by both scan.mjs and query.mjs, so `--agents` output can never diverge within an install.
export function printAgents() {
  const dir = path.dirname(fileURLToPath(import.meta.url)); // the package root (where AGENTS.md ships)
  const semver = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  console.log(`<!-- candor-ts ${semver} · the agent contract for this installed version -->`);
  process.stdout.write(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"));
}
