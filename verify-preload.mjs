// candor verify — the runtime CAPTURE front-end (loaded via `node --import ./verify-preload.mjs app.js`).
//
// Independence by construction: this shares NO code with candor's static classifier. It wraps the REAL
// effectful Node entry points (the runtime boundary where an effect actually happens) and, on each call,
// attributes it to the nearest PROJECT source frame on the stack — emitting `{file, line, effect}` to a
// trace. `candor verify` later maps each site to the candor function that encloses it and checks
// `observed ⊆ inferred ∪ {Unknown}`. Wrapping the boundary (not candor's claimed sites) is what makes this
// a check against REALITY rather than against candor's own opinion.
//
// Config (env): CANDOR_VERIFY_ROOT = the scanned project root; CANDOR_VERIFY_TRACE = the NDJSON trace path.
// Scope: `direct` (the default) captures {Net, Fs, Exec} — the syscall-parity headline; the Env/Clock/Rand
// wraps below are only ASSERTED over under `--scope all` (the checker enforces the scope), but capturing
// them always is harmless. NDJSON append so a multi-process run accumulates.
//
// KNOWN SLICE-1 LIMITATION: patching the builtin module singletons catches CJS (every style, since the app
// requires AFTER this preload) and ESM NAMESPACE access (`import * as fs; fs.readFileSync()`), but NOT ESM
// DESTRUCTURED named imports of builtins (`import { readFileSync } from "node:fs"` — a live binding bound
// before the call). Most code uses the namespace/default form; the gap is disclosed, never silent.

import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import cp from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

// Canonicalize the root (resolve symlinks) so it matches the paths V8 puts in stack frames — node
// canonicalizes module paths, so on macOS an os.tmpdir() `/var/folders/…` root would never match a
// `/private/var/folders/…` frame and every project effect would drop as "unattributed" (a silent miss).
function canonical(p) { try { return fs.realpathSync(nodePath.resolve(p)); } catch { return nodePath.resolve(p); } }
const ROOT = canonical(process.env.CANDOR_VERIFY_ROOT || process.cwd());
const TRACE = process.env.CANDOR_VERIFY_TRACE;

// Resolve a raw stack-frame source (a path or a file:// URL) to a ROOT-relative path, or null when it is
// outside the project (a builtin, a node_modules dep — attributed to the project frame that CALLED it).
function relIfProject(src) {
  if (!src) return null;
  let abs;
  if (src.startsWith("file://")) {
    try { abs = fileURLToPath(src); } catch { return null; }
  } else if (nodePath.isAbsolute(src)) {
    abs = src;
  } else {
    return null; // node:internal, `node:fs`, eval, etc. — never a project site
  }
  if (abs.includes("/node_modules/") || abs.includes("\\node_modules\\")) return null;
  const rel = nodePath.relative(ROOT, abs);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null; // outside the root
  return rel.split(nodePath.sep).join("/");
}

// The nearest PROJECT site on the current stack: `{file, line}` (ROOT-relative), or null when the effect
// fired with no project frame below it (a dep's own effect — disclosed as an unattributed event).
const FRAME = /\((?:(.+):(\d+):(\d+))\)$|at (?:(.+):(\d+):(\d+))$/;
function nearestSite() {
  const stack = new Error().stack || "";
  for (const lineStr of stack.split("\n").slice(1)) {
    const m = FRAME.exec(lineStr.trim());
    if (!m) continue;
    const src = m[1] ?? m[4];
    const line = Number(m[2] ?? m[5]);
    const rel = relIfProject(src);
    if (rel) return { file: rel, line };
  }
  return null;
}

let traceFd = null;
function emit(effect) {
  if (!TRACE) return;
  const site = nearestSite();
  // Only PROJECT-attributed effects are checkable per-function. An effect with no project frame below it
  // (node's own module-loader / type-stripping fs calls, or a dependency's internal I/O) is NOT the
  // target's code — dropped here rather than written, which also spares the trace the loader's fs storm.
  if (!site) return;
  try {
    if (traceFd === null) traceFd = fs.openSync(TRACE, "a");
    fs.writeSync(traceFd, JSON.stringify({ file: site.file, line: site.line, effect }) + "\n");
  } catch { /* a trace-write failure must never crash the app under test */ }
}

// ── wrap the effectful entry points (the runtime boundary) ────────────────────────────────────────
// `wrap(obj, names, effect)` replaces each named method with a recorder that emits then delegates. Keeps
// the original's `this`, args, and return — a transparent shim (never alters the program's behaviour).
function wrap(obj, names, effect) {
  for (const name of names) {
    const orig = obj?.[name];
    if (typeof orig !== "function") continue;
    obj[name] = function (...args) {
      emit(effect);
      return orig.apply(this, args);
    };
  }
}

// Fs — the file/dir I/O verbs (sync + async + streams). fs/promises shares these method names on fs.promises.
const FS_VERBS = [
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync",
  "unlink", "unlinkSync", "rename", "renameSync", "mkdir", "mkdirSync", "rmdir", "rmdirSync",
  "rm", "rmSync", "copyFile", "copyFileSync", "createReadStream", "createWriteStream",
  "realpath", "realpathSync", "access", "accessSync", "truncate", "truncateSync", "watch", "watchFile",
];
wrap(fs, FS_VERBS, "Fs");
if (fs.promises) wrap(fs.promises, FS_VERBS, "Fs");

// Exec — subprocess launch.
wrap(cp, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "Exec");

// Net — sockets, HTTP(S) clients, DNS, datagram, and the global fetch.
wrap(net, ["connect", "createConnection"], "Net");
if (net.Socket && net.Socket.prototype) wrap(net.Socket.prototype, ["connect"], "Net");
wrap(http, ["request", "get"], "Net");
wrap(https, ["request", "get"], "Net");
wrap(dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt"], "Net");
if (dns.promises) wrap(dns.promises, ["lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt"], "Net");
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (...args) { emit("Net"); return origFetch.apply(this, args); };
}

// Rand — CSPRNG + Math.random (best-effort; asserted only under `--scope all`).
wrap(crypto, ["randomBytes", "randomFillSync", "randomFill", "randomInt", "randomUUID"], "Rand");
{
  const origRandom = Math.random;
  Math.random = function () { emit("Rand"); return origRandom.call(Math); };
}

// Clock — wall-clock reads (best-effort; `all` scope). Date.now + performance.now + process.hrtime.
{
  const origNow = Date.now;
  Date.now = function () { emit("Clock"); return origNow.call(Date); };
  if (globalThis.performance && typeof performance.now === "function") {
    const origPerf = performance.now.bind(performance);
    performance.now = function () { emit("Clock"); return origPerf(); };
  }
}

// Env — process.env reads, via a Proxy that records a get of a real key then delegates (best-effort;
// `all` scope). Skipped if the Proxy install fails (some runtimes freeze process.env).
try {
  const realEnv = process.env;
  const proxied = new Proxy(realEnv, {
    get(t, k) { if (typeof k === "string" && k in t) emit("Env"); return t[k]; },
  });
  Object.defineProperty(process, "env", { value: proxied, configurable: true });
} catch { /* process.env not reconfigurable — Env capture unavailable, disclosed by absence */ }
