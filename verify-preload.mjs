// candor verify — the runtime CAPTURE front-end (loaded via `node --import ./verify-preload.mjs app.js`).
//
// Independence by construction: this shares NO code with candor's static classifier. It wraps the REAL
// effectful Node entry points (the runtime boundary where an effect actually happens) and, on each call,
// attributes it to the nearest PROJECT source frame — emitting `{file, line, effect}` (via ./verify-emit.mjs)
// to a trace. `candor verify` later maps each site to the candor function that encloses it and checks
// `observed ⊆ inferred ∪ {Unknown}`. Observing the boundary (not candor's claimed sites) is what makes this
// a check against REALITY rather than candor's own opinion.
//
// TWO capture paths, one emit: (1) HERE — patch the builtins' DEFAULT-export objects (`fs.readFileSync = …`)
// + the globals (fetch/Math.random/Date/process.env) — covers CJS (every style) + ESM default/namespace; and
// (2) ./verify-loader.mjs (registered below) — wraps the builtins' NAMED exports, a SEPARATE binding node:fs
// keeps distinct from the default object, so `import { readFileSync } from "node:fs"` is caught too. A call
// takes exactly one path, so there is no double-count.
//
// Config (env): CANDOR_VERIFY_ROOT (project root), CANDOR_VERIFY_TRACE (NDJSON trace) — read by verify-emit.

import { register } from "node:module";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import cp from "node:child_process";
import crypto from "node:crypto";
import { emit } from "./verify-emit.mjs";

// wrap(obj, names, effect): replace each named method with a recorder that emits then delegates — a
// transparent shim (same `this`, args, return; never alters the program's behaviour).
function wrap(obj, names, effect) {
  for (const name of names) {
    const orig = obj?.[name];
    if (typeof orig !== "function") continue;
    obj[name] = function (...args) { emit(effect); return orig.apply(this, args); };
  }
}

const FS_VERBS = [
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync",
  "unlink", "unlinkSync", "rename", "renameSync", "mkdir", "mkdirSync", "rmdir", "rmdirSync",
  "rm", "rmSync", "copyFile", "copyFileSync", "createReadStream", "createWriteStream",
  "realpath", "realpathSync", "access", "accessSync", "truncate", "truncateSync", "watch", "watchFile",
];
const NET_VERBS = ["connect", "createConnection", "request", "get"];
const DNS_VERBS = ["lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt"];

// (1) the DEFAULT-export objects (CJS + ESM default/namespace).
wrap(fs, FS_VERBS, "Fs");
if (fs.promises) wrap(fs.promises, FS_VERBS, "Fs");
wrap(cp, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "Exec");
wrap(net, ["connect", "createConnection"], "Net");
if (net.Socket && net.Socket.prototype) wrap(net.Socket.prototype, ["connect"], "Net");
wrap(http, NET_VERBS, "Net");
wrap(https, NET_VERBS, "Net");
wrap(dns, DNS_VERBS, "Net");
if (dns.promises) wrap(dns.promises, DNS_VERBS, "Net");

// globals — not module exports, so the loader never sees them.
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (...a) { emit("Net"); return origFetch.apply(this, a); };
}
wrap(crypto, ["randomBytes", "randomFillSync", "randomFill", "randomInt", "randomUUID"], "Rand");
{
  const origRandom = Math.random;
  Math.random = function () { emit("Rand"); return origRandom.call(Math); };
  const origNow = Date.now;
  Date.now = function () { emit("Clock"); return origNow.call(Date); };
  if (globalThis.performance && typeof performance.now === "function") {
    const origPerf = performance.now.bind(performance);
    performance.now = function () { emit("Clock"); return origPerf(); };
  }
}
try {
  const proxied = new Proxy(process.env, {
    get(t, k) { if (typeof k === "string" && k in t) emit("Env"); return t[k]; },
  });
  Object.defineProperty(process, "env", { value: proxied, configurable: true });
} catch { /* process.env not reconfigurable — Env capture unavailable, disclosed by absence */ }

// (2) the ESM NAMED-export path. Registered AFTER the patches above (the imports are hoisted, so the builtins
// were imported un-redirected and patched first). Best-effort: an older node without module.register keeps
// the CJS + default/namespace coverage; the ESM-named gap is then disclosed by verify's coverage, never silent.
try { register("./verify-loader.mjs", import.meta.url); } catch { /* module.register unavailable */ }
