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
import { traced, tracedNet } from "./verify-emit.mjs";

// wrap(obj, names, effect): replace each named method with a recorder that (via `traced`) emits the effect
// iff this is the OUTERMOST wrapped call, then delegates transparently (same this/args/return). The
// re-entrancy guard in `traced` keeps a stdlib call's OWN internal wrapped calls from attributing to the app.
function wrap(obj, names, effect) {
  for (const name of names) {
    const orig = obj?.[name];
    if (typeof orig !== "function") continue;
    obj[name] = function (...args) { return traced(effect, this, orig, args); };
  }
}
// wrapNet: like wrap, but classifies the DESTINATION (host/port from the args) → Net (+ Llm for a model host /
// + Db for a database port), so a `deny Llm`/`deny Db` claim is verifiable and a missed refinement caught.
function wrapNet(obj, names, base) {
  for (const name of names) {
    const orig = obj?.[name];
    if (typeof orig !== "function") continue;
    obj[name] = function (...args) { return tracedNet(base, name, this, orig, args); };
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
wrapNet(net, ["connect", "createConnection"], "net");
if (net.Socket && net.Socket.prototype) wrapNet(net.Socket.prototype, ["connect"], "net");
wrapNet(http, NET_VERBS, "http");
wrapNet(https, NET_VERBS, "https");
wrapNet(dns, DNS_VERBS, "dns");
if (dns.promises) wrapNet(dns.promises, DNS_VERBS, "dns");

// globals — not module exports, so the loader never sees them. All routed through the same guard.
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (...a) { return tracedNet("http", "fetch", this, origFetch, a); };
}
wrap(crypto, ["randomBytes", "randomFillSync", "randomFill", "randomInt", "randomUUID"], "Rand");
{
  const origRandom = Math.random;
  Math.random = function () { return traced("Rand", Math, origRandom, []); };
  const origNow = Date.now;
  Date.now = function () { return traced("Clock", Date, origNow, []); };
  if (globalThis.performance && typeof performance.now === "function") {
    const origPerf = performance.now.bind(performance);
    performance.now = function () { return traced("Clock", null, origPerf, []); };
  }
}
try {
  const proxied = new Proxy(process.env, {
    // a process.env READ is Env — but only the app's OWN read (depth 0); a read INSIDE a wrapped stdlib call
    // is that call's business. `traced` gates it: the app's direct read is outermost (recorded), a nested one skipped.
    get(t, k) { return typeof k === "string" && k in t ? traced("Env", t, () => t[k], []) : t[k]; },
  });
  Object.defineProperty(process, "env", { value: proxied, configurable: true });
} catch { /* process.env not reconfigurable — Env capture unavailable, disclosed by absence */ }

// (2) the ESM NAMED-export path. Registered AFTER the patches above (the imports are hoisted, so the builtins
// were imported un-redirected and patched first). Best-effort: an older node without module.register keeps
// the CJS + default/namespace coverage; the ESM-named gap is then disclosed by verify's coverage, never silent.
try { register("./verify-loader.mjs", import.meta.url); } catch { /* module.register unavailable */ }
