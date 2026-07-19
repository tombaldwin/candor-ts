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
// TRANSITIVE attribution: EVERY project frame on the stack (nearest-first, deduped), not only the nearest.
// candor's report is transitive — a function that REACHES an effect is effectful — so each project frame's
// call-site line, mapped downstream (verify-core `attribute`) to the function that ENCLOSES it, attributes the
// effect to the leaf function AND every caller of it, exactly as the report claims. A single nearest-frame
// site (the earlier behaviour) attributes only to the leaf, so a CALLER that reaches an effect through a
// dropped/dynamic edge and is reported pure is never tested (its observed set is empty ⇒ H holds vacuously) —
// the transitive cardinal sin the oracle must falsify.
function projectSites() {
  const stack = new Error().stack || "";
  const sites = [];
  const seenHere = new Set();
  for (const lineStr of stack.split("\n").slice(1)) {
    const m = FRAME.exec(lineStr.trim());
    if (!m) continue;
    const rel = relIfProject(m[1] ?? m[4]);
    if (!rel) continue;
    const line = Number(m[2] ?? m[5]);
    const key = rel + ":" + line;
    if (!seenHere.has(key)) { seenHere.add(key); sites.push({ file: rel, line }); }
  }
  return sites;
}

let traceFd = null;
const written = new Set();
function write(site, effect) {
  const rec = JSON.stringify({ file: site.file, line: site.line, effect });
  if (written.has(rec)) return; // set-based oracle: write each (site,effect) once (bounds the trace to distinct sites)
  written.add(rec);
  try {
    if (traceFd === null) traceFd = fs.openSync(TRACE, "a");
    fs.writeSync(traceFd, rec + "\n");
  } catch { /* a trace-write failure must never crash the app under test */ }
}
/** Record an effect at EVERY project call-site on the stack (transitive: the leaf and every caller). Effects
 *  with no project frame (node internals, a dependency's own I/O) attribute nowhere and are dropped. */
export function emit(effect) {
  if (!TRACE) return;
  for (const site of projectSites()) write(site, effect);
}
/** Record SEVERAL effects transitively (a `Net` refined to `Net`+`Llm`/`Db`): each effect at every site. */
export function emitMany(effects) {
  if (!TRACE || !effects.length) return;
  const sites = projectSites();
  for (const site of sites) for (const e of effects) write(site, e);
}

// RE-ENTRANCY GUARD: a wrapped stdlib call (e.g. net.connect) internally calls OTHER wrapped stdlib calls
// (an fs stat, a Date.now) with the APP frame still on the stack — those are the OUTER effect's business,
// not the app's own direct effects, and attributing them to the app frame would FABRICATE an escape (a
// false violation). So record only the OUTERMOST wrapped call: `traced` brackets the delegated call with a
// depth counter and emits only at depth 1. The app calling fs AND net directly are both depth-1 (recorded);
// only NESTED wrapped calls are suppressed.
let depth = 0;
/** Wrap one delegated call: emit `effect` iff outermost, then invoke `fn` transparently (this/args/return). */
export function traced(effect, self, fn, args) {
  const d = ++depth;
  try { if (d === 1) emit(effect); return fn.apply(self, args); }
  finally { depth--; }
}
/** Like `traced`, for a Net entry point — classifies the destination (host/port) → Net (+ Llm/Db). */
export function tracedNet(base, name, self, fn, args) {
  const d = ++depth;
  try { if (d === 1) { const dst = destOf(base, name, args); emitMany(netEffects(dst.host, dst.port)); } return fn.apply(self, args); }
  finally { depth--; }
}

// ── Net destination classification (RQ1 §A: an oracle sees Net; classify the destination to confirm Llm
// vs Db vs bare Net). The oracle keeps its OWN host/port tables — deliberately NOT candor's MODEL_HOSTS —
// so this check stays INDEPENDENT of the classifier it audits (a shared table would make them agree by
// construction). A curated starter set; a model call candor claims `Llm` that hits an unlisted host reads
// as bare `Net` here (a disclosed limit, never a false violation — Net ⊆ {Llm,Net} still holds).
const ORACLE_MODEL_HOSTS = [
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.mistral.ai",
  "api.cohere.ai", "api.cohere.com", "api.groq.com", "api.together.xyz", "api.perplexity.ai", "openrouter.ai",
];
const DB_PORTS = new Set([5432, 3306, 27017, 6379, 1433, 1521, 9042, 5984, 8123, 26257, 3050, 50000]);
function hostname(h) {
  if (!h) return "";
  let s = String(h).toLowerCase();
  if (s.startsWith("[")) { const e = s.indexOf("]"); if (e >= 0) return s.slice(1, e); }
  else if ((s.match(/:/g) || []).length === 1) s = s.split(":")[0];
  return s;
}
function isModelHost(h) {
  const host = hostname(h);
  return ORACLE_MODEL_HOSTS.some((m) => host === m || host.endsWith("." + m));
}
/** Classify a captured Net destination → the effect list to emit (`Net` always; `Llm` for a model host;
 *  `Db` for a known database port). A loopback/AF_UNIX destination is local IPC, but still Net egress off
 *  the process — kept as Net (candor models a socket as Net regardless of destination). */
export function netEffects(host, port) {
  const effects = ["Net"];
  if (isModelHost(host)) effects.push("Llm");
  if (port != null && DB_PORTS.has(Number(port))) effects.push("Db");
  return effects;
}

/** Extract {host, port} from a wrapped Net entry point's args (best-effort; any parse failure → bare Net).
 *  `base`/`name` select the arg shape: fetch(url|Request), http(s).request/get(url|options), net.connect/
 *  createConnection(options|port[,host]|path), dns.<verb>(hostname). */
export function destOf(base, name, args) {
  try {
    const a0 = args[0];
    if (base === "dns" || base === "dns/promises") return { host: typeof a0 === "string" ? a0 : "", port: null };
    if (base === "net") {
      // connect/createConnection: (options) | (port[, host]) | (path)
      if (typeof a0 === "number") return { host: typeof args[1] === "string" ? args[1] : "", port: a0 };
      if (a0 && typeof a0 === "object") return { host: a0.host || a0.hostname || "", port: a0.port ?? null };
      return { host: "", port: null };
    }
    // http/https request/get + fetch: a URL string, a URL object, or an options object.
    let u = a0;
    if (typeof u === "string") { const url = new URL(u); return { host: url.hostname, port: url.port || null }; }
    if (u && typeof u === "object") {
      if (typeof u.href === "string") { const url = new URL(u.href); return { host: url.hostname, port: url.port || null }; }
      // a Request-like (fetch) or an http options object
      if (typeof u.url === "string") { const url = new URL(u.url); return { host: url.hostname, port: url.port || null }; }
      return { host: u.hostname || u.host || "", port: u.port ?? null };
    }
  } catch { /* unparseable destination — fall through to bare Net */ }
  return { host: "", port: null };
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
