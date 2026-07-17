// candor verify — the shared EMIT + effect-classification core, imported by BOTH the preload (which patches
// the builtins' DEFAULT-export objects + globals) and the ESM loader's generated wrappers (which wrap the
// builtins' NAMED exports — a separate binding node:fs keeps distinct from the default object). Factoring it
// here keeps ONE attribution + trace-write + effect map, so the two capture paths can never disagree. Runs in
// the APPLICATION context (both the preload and the generated wrappers execute in the app's main thread).

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

function canonical(p) { try { return fs.realpathSync(nodePath.resolve(p)); } catch { return nodePath.resolve(p); } }
const ROOT = canonical(process.env.CANDOR_VERIFY_ROOT || process.cwd());
const TRACE = process.env.CANDOR_VERIFY_TRACE;

function relIfProject(src) {
  if (!src) return null;
  let abs;
  if (src.startsWith("file://")) { try { abs = fileURLToPath(src); } catch { return null; } }
  else if (nodePath.isAbsolute(src)) abs = src;
  else return null;
  if (abs.includes("/node_modules/") || abs.includes("\\node_modules\\")) return null;
  const rel = nodePath.relative(ROOT, abs);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
  return rel.split(nodePath.sep).join("/");
}

const FRAME = /\((?:(.+):(\d+):(\d+))\)$|at (?:(.+):(\d+):(\d+))$/;
function nearestSite() {
  const stack = new Error().stack || "";
  for (const lineStr of stack.split("\n").slice(1)) {
    const m = FRAME.exec(lineStr.trim());
    if (!m) continue;
    const rel = relIfProject(m[1] ?? m[4]);
    if (rel) return { file: rel, line: Number(m[2] ?? m[5]) };
  }
  return null;
}

let traceFd = null;
let last = "";
/** Record an effect at the nearest PROJECT call-site. Un-attributed effects (node internals, a dependency's
 *  own I/O — no project frame below) are dropped, not written: they aren't the target's code. Consecutive
 *  identical (file,line,effect) events are collapsed — one effectful stdlib call fans out into several
 *  wrapped internal calls at the SAME site (e.g. statSync → internal realpath), which the set-based check
 *  ignores anyway; deduping keeps the trace honest about distinct sites. */
export function emit(effect) {
  if (!TRACE) return;
  const site = nearestSite();
  if (!site) return;
  const rec = JSON.stringify({ file: site.file, line: site.line, effect });
  if (rec === last) return;
  last = rec;
  try {
    if (traceFd === null) traceFd = fs.openSync(TRACE, "a");
    fs.writeSync(traceFd, rec + "\n");
  } catch { /* a trace-write failure must never crash the app under test */ }
}

// The effect a named export of a wrapped builtin performs (the RUNTIME boundary — independent of candor's
// static κ classifier by design). Only function-valued verbs appear; everything else is passthrough.
const FS_VERBS = new Set([
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync",
  "unlink", "unlinkSync", "rename", "renameSync", "mkdir", "mkdirSync", "rmdir", "rmdirSync",
  "rm", "rmSync", "copyFile", "copyFileSync", "createReadStream", "createWriteStream",
  "realpath", "realpathSync", "access", "accessSync", "truncate", "truncateSync", "watch", "watchFile",
]);
const EXEC_VERBS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const NET_VERBS = new Set([
  "connect", "createConnection", "request", "get", "createSocket",
  "lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt", "resolveCname", "resolveNs", "resolveSrv",
]);

export function effectOf(base, name) {
  if (base === "child_process") return EXEC_VERBS.has(name) ? "Exec" : null;
  if (base === "fs" || base === "fs/promises") return FS_VERBS.has(name) ? "Fs" : null;
  if (["net", "http", "https", "http2", "dgram", "dns", "dns/promises"].includes(base)) {
    return NET_VERBS.has(name) ? "Net" : null;
  }
  return null;
}
