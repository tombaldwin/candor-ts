/**
 * candor query core — the SPEC §3.1 read-only queries as PURE functions over a loaded report +
 * callgraph sidecar. Shared by the MCP server (mcp.mjs) so the agent surface and the CLI compute
 * the same answers. Shapes match the reference engines (candor-query / candor-java); a cross-check
 * test (test.mjs) pins them against query.mjs and the Rust binary so this can't drift — the family's
 * no-two-truths rule, enforced by test rather than (yet) by query.mjs importing this.
 *
 * Every function takes already-loaded data (fns = the report's `functions`; cg = the callgraph
 * object name->callees) and RETURNS a plain object — no I/O, no process exit. The caller emits.
 */
import fs from "node:fs";
import nodePath from "node:path";

// Sibling report/callgraph files of a multi-report prefix (candor-scan writes <prefix>.<crate>.scan.json,
// one per workspace member) — so the loaders read ANY engine's output, not just candor-ts's <prefix>.json.
// This is the cross-engine premise: an agent queries a report from any language identically.
function siblings(prefix, predicate) {
  const dir = nodePath.dirname(prefix) || ".";
  const base = nodePath.basename(prefix);
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(base + ".") && f.endsWith(".json") && predicate(f))
      .map((f) => nodePath.join(dir, f));
  } catch { return []; }
}
// A sibling filename that is a real REPORT (not a callgraph sidecar, an encountered-crate ledger, a
// calibrated-coverage sidecar, or a --gate-json verdict written beside the prefix). Exported so
// `hasReport` (the MCP existence check) uses the SAME predicate as the loader — else a prefix whose only
// sibling is `.encountered-*`/`.calibrated.json` passes the existence check but loads ZERO functions →
// an authoritative-empty result (silent under-report; review find). `.gate.json` has no functions array,
// so merging it "disclosed a malformed report" on every query over the recommended CI layout — noisy, excluded.
export const isReport = (f) => !f.endsWith(".callgraph.json") && !f.endsWith(".hierarchy.json") && !f.includes(".encountered-") && !f.endsWith(".calibrated.json") && !f.endsWith(".gate.json");

// A report exists at the prefix if there's an exact `<prefix>.json` (candor-ts) OR a sibling
// `<prefix>.<crate>.scan.json` (the candor-scan/Rust multi-report form) — the loaders read both, so a
// consumer (MCP/LSP) serves a report from ANY engine. ONE copy here: the check was triplicated across
// mcp.mjs/lsp.mjs, and an earlier divergence from the loader predicate was itself a review find.
export function hasReport(p) {
  if (!p) return false;
  if (fs.existsSync(`${p}.json`)) return true;
  const base = nodePath.basename(p);
  try {
    return fs.readdirSync(nodePath.dirname(p) || ".").some((f) =>
      f.startsWith(base + ".") && f.endsWith(".json") && isReport(f));
  } catch { return false; }
}

// Defend the queries against a partial/old-engine/hand-edited report: the §2 required fields are
// defaulted, and a WRONG-TYPE field is coerced — a non-array `inferred` (e.g. the string "Net") must
// NOT survive, or `new Set("Net")` iterates characters into {N,e,t} (a fabricated effect set). Array
// only when actually an array; else []. The §2 forward-compatibility posture applied to the consumer.
function normFn(e) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { ...e, inferred: arr(e.inferred), direct: arr(e.direct), calls: arr(e.calls) };
}

// Normalize a parsed report's `functions` into clean entries. A non-array `functions`, or an entry that
// isn't an object with a STRING `fn`, is DISCLOSED and dropped — it would otherwise crash a query
// (`map()` deref on a fn-less entry) or fabricate a junk entity (a primitive normalized into `{0:'t',…}`).
// The never-crash / never-fabricate posture for malformed input from any engine's report.
function normFns(parsed, source) {
  const raw = parsed && typeof parsed === "object" && parsed.functions !== undefined ? parsed.functions : parsed;
  if (!Array.isArray(raw)) {
    console.error(`candor-ts: report ${source} has no functions array — OMITTED from this query (malformed report)`);
    return [];
  }
  const out = [];
  for (const e of raw) {
    if (e && typeof e === "object" && typeof e.fn === "string") out.push(normFn(e));
    else console.error(`candor-ts: report ${source} has a malformed entry (no string \`fn\`) — skipped`);
  }
  return out;
}

/** The producing engine build of the report(s) at a prefix (the §2.1 envelope `candor.version`) — null
 *  when unreadable/absent (a legacy bare array has no provenance). Baselines are comparable only to
 *  their own producing version (§2.1): diff/gains consumers disclose a mismatch (an engine swap makes
 *  "gained" effects ambiguous — unmasking vs regression — the baseline-invalidation rule, AGENTS §2a). */
export function reportVersion(prefix) {
  const files = fs.existsSync(`${prefix}.json`) ? [`${prefix}.json`] : siblings(prefix, isReport);
  for (const f of files) {
    try {
      const v = JSON.parse(fs.readFileSync(f, "utf8"))?.candor?.version;
      if (v) return String(v);
    } catch { /* unreadable sibling — keep looking */ }
  }
  return null;
}

/** The report's §2 envelope `package` name — meaningful and locator-independent, so every engine and
 *  every --report form print the same crate in the `tour` header. null when absent/unreadable (the
 *  caller falls back to the prefix basename). Mirrors surface.rs/tour.rs::report_package. */
export function reportPackage(prefix) {
  const files = fs.existsSync(`${prefix}.json`) ? [`${prefix}.json`] : siblings(prefix, isReport);
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(f, "utf8"))?.package;
      if (typeof p === "string" && p) return p;
    } catch { /* unreadable sibling — keep looking */ }
  }
  return null;
}

// The returned array carries a non-enumerable `hardFail` flag: true iff a report file was FOUND but
// wholly failed to read/parse. The loud CLI wrapper (loadReportOrDie) needs it to tell "empty-but-valid
// report" apart from "the report we found was corrupt", which must never read as an empty all-clear.
const tagHardFail = (fns, hardFail) => { Object.defineProperty(fns, "hardFail", { value: hardFail, enumerable: false }); return fns; };
export function loadReport(prefix) {
  if (fs.existsSync(`${prefix}.json`)) {
    // The PRIMARY report parse must DISCLOSE-and-tolerate like the sibling path — a bare JSON.parse here
    // threw an uncaught stack trace on the CLI for a corrupt `<prefix>.json` (asymmetric with siblings).
    try { return tagHardFail(normFns(JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")), `${prefix}.json`), false); }
    catch { console.error(`candor-ts: report ${prefix}.json failed to parse — OMITTED (corrupt or mid-write); re-run the scan`); return tagHardFail([], true); }
  }
  // No exact <prefix>.json — merge the multi-report siblings (the Rust/workspace form).
  const fns = [];
  let hardFail = false;
  for (const f of siblings(prefix, isReport)) {
    // DISCLOSE a malformed sibling — never silently drop it (a vanished report reads as "no effect").
    try { fns.push(...normFns(JSON.parse(fs.readFileSync(f, "utf8")), f)); }
    catch { console.error(`candor-ts: report ${f} failed to parse — its functions are OMITTED from this query (corrupt or mid-write); re-run the scan`); hardFail = true; }
  }
  return tagHardFail(fns, hardFail);
}
export function loadCallgraph(prefix) {
  // A `null`/non-object parse (a `null` callgraph, an array, a number) must NOT reach Object.entries —
  // it throws "Cannot convert null to object". Coerce anything but a plain object to {} (an empty
  // graph), the never-crash direction.
  const norm = (cg) => (cg && typeof cg === "object" && !Array.isArray(cg))
    ? Object.fromEntries(Object.entries(cg).map(([k, v]) => [k, Array.isArray(v) ? v : []]))
    : {};
  if (fs.existsSync(`${prefix}.callgraph.json`)) {
    // The PRIMARY callgraph parse must DISCLOSE-and-tolerate like the sibling path below and like
    // loadReport — a bare JSON.parse here threw an uncaught stack trace on the CLI for a corrupt or
    // `null` `<prefix>.callgraph.json` (asymmetric with siblings). Tolerate (empty graph) + disclose.
    try { return norm(JSON.parse(fs.readFileSync(`${prefix}.callgraph.json`, "utf8"))); }
    catch { console.error(`candor-ts: callgraph ${prefix}.callgraph.json failed to parse — its edges are OMITTED from this query (corrupt or mid-write); re-run the scan`); return {}; }
  }
  const cg = {};
  for (const f of siblings(prefix, (x) => x.endsWith(".callgraph.json"))) {
    try { Object.assign(cg, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { console.error(`candor-ts: callgraph ${f} failed to parse — its edges are OMITTED from this query (corrupt or mid-write); re-run the scan`); }
  }
  return norm(cg);
}

// ---- the §3.1 match ladder: exact > segment-suffix > substring ------------------------------------
function matchTier(name, q) {
  if (name === q) return 3;
  if (name.endsWith(q) && /[.$#]$/.test(name.slice(0, name.length - q.length))) return 2;
  if (name.includes(q)) return 1;
  return 0;
}
export function matches(names, q) {
  const best = Math.max(0, ...names.map((n) => matchTier(n, q)));
  return best === 0 ? [] : names.filter((n) => matchTier(n, q) >= best);
}

// Exported for consumers that answer MANY caller-count questions over one loaded graph (the LSP
// codeLens): building the inversion once per request instead of once per `callers()` call.
export function reverseGraph(cg) {
  const rev = new Map();
  for (const [caller, callees] of Object.entries(cg))
    for (const c of callees) {
      if (!rev.has(c)) rev.set(c, []);
      rev.get(c).push(caller);
    }
  return rev;
}

// what effects a function carries (its row), and a name->row index for loc/direct lookups.
function indexFns(fns) {
  return new Map(fns.map((e) => [e.fn, e]));
}

export function show(fns, q) {
  const hit = new Set(matches(fns.map((e) => e.fn), q));
  return fns.filter((e) => hit.has(e.fn)).map((e) => {
    const o = { fn: e.fn, inferred: e.inferred, direct: e.direct };
    // Literal Fs paths live under the report's `paths` key (scan emits `entry.paths`), NOT `fs` — the
    // old `e.fs` read a field this engine never writes, so `show`/`candor_show` silently dropped every
    // file path (the MCP tool's own doc promises "hosts/cmds/paths/tables"). Surface it as `paths`, the
    // report's key, mirroring hosts/cmds/tables below.
    if (e.paths?.length) o.paths = e.paths;
    if (e.hosts?.length) o.hosts = e.hosts;
    if (e.cmds?.length) o.cmds = e.cmds;
    if (e.tables?.length) o.tables = e.tables;
    o.unresolved = e.unresolved;
    return o;
  });
}

export function where(fns, eff) {
  return {
    effect: eff,
    directly: fns.filter((e) => e.direct.includes(eff)).map((e) => e.fn).sort(),
    inherited: fns.filter((e) => e.inferred.includes(eff) && !e.direct.includes(eff)).map((e) => e.fn).sort(),
  };
}

export function callers(cg, q) {
  const targets = matches(Object.keys(cg), q);
  const rev = reverseGraph(cg);
  const direct = new Set(), transitive = new Set();
  for (const t of targets) for (const c of rev.get(t) ?? []) direct.add(c);
  const queue = [...targets];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!transitive.has(c) && !targets.includes(c)) { transitive.add(c); queue.push(c); }
  }
  return { of: targets, direct: [...direct].sort(), transitive: [...transitive].sort() };
}

// The bare method name / declaring type of a `mod.Class.member` qual (drop a `#line:col` function-scoped
// suffix, then split on the last dot). Used by the dispatch-frontier to match a confirmed reacher against
// a `dispatch:OWNER.member` owner.
const stripPos = (s) => { const h = s.indexOf("#"); return h >= 0 ? s.slice(0, h) : s; };
export function simpleMethod(fn) { const b = stripPos(fn); const i = b.lastIndexOf("."); return i >= 0 ? b.slice(i + 1) : b; }
export function declaringType(fn) { const b = stripPos(fn); const i = b.lastIndexOf("."); return i >= 0 ? b.slice(0, i) : b; }

// Load the type-hierarchy sidecar (`<prefix>.hierarchy.json`, 0.7), or {} if absent (→ the frontier
// falls back to a simple-name match, which over-lists — the safe direction).
export function loadHierarchy(prefix) {
  const norm = (h) => (h && typeof h === "object" && !Array.isArray(h))
    ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v : []])) : {};
  if (fs.existsSync(`${prefix}.hierarchy.json`)) {
    try { return norm(JSON.parse(fs.readFileSync(`${prefix}.hierarchy.json`, "utf8"))); } catch { return {}; }
  }
  const h = {};
  for (const f of siblings(prefix, (x) => x.endsWith(".hierarchy.json"))) {
    try { Object.assign(h, JSON.parse(fs.readFileSync(f, "utf8"))); } catch { /* tolerate */ }
  }
  return norm(h);
}

// Reflexive+transitive subtype test over the hierarchy sidecar.
function isSubtypeOf(type, owner, hierarchy) {
  if (type === owner) return true;
  const seen = new Set(), stack = [type];
  while (stack.length) {
    for (const s of hierarchy[stack.pop()] ?? []) { if (s === owner) return true; if (!seen.has(s)) { seen.add(s); stack.push(s); } }
  }
  return false;
}

// callers + the unresolved-dispatch frontier (--include-unknown, SPEC §3.1/§4 0.7): the CONFIRMED set,
// plus functions that reach `q` only through a `dispatch:OWNER.member` the engine declined to resolve —
// disclosed iff a confirmed reacher is an override of OWNER.member (same method AND a subtype of OWNER
// per the hierarchy; empty hierarchy → simple-name match, over-lists). Never asserted ("cannot confirm").
export function callersFrontier(cg, fns, hierarchy, q) {
  const base = callers(cg, q);
  const confirmed = new Set([...base.of, ...base.transitive]);
  const typesByMethod = new Map();
  for (const r of confirmed) { const m = simpleMethod(r); (typesByMethod.get(m) ?? typesByMethod.set(m, []).get(m)).push(declaringType(r)); }
  const hasHier = hierarchy && Object.keys(hierarchy).length > 0;
  const possible = [];
  for (const f of fns) {
    if (confirmed.has(f.fn)) continue;
    const hits = new Set();
    for (const w of f.unknownWhy ?? []) {
      if (!w.startsWith("dispatch:")) continue;
      const key = w.slice("dispatch:".length), m = simpleMethod(key), owner = declaringType(key);
      const types = typesByMethod.get(m);
      if (!types) continue;
      if (!hasHier || types.some((t) => isSubtypeOf(t, owner, hierarchy))) hits.add(m);
    }
    if (hits.size) possible.push({ fn: f.fn, viaDispatchOn: [...hits].sort().join(",") });
  }
  possible.sort((a, b) => a.fn.localeCompare(b.fn));
  return { ...base, possibleViaUnknownDispatch: possible };
}

export function map(fns) {
  const mods = {};
  for (const e of fns) {
    const mod = e.fn.includes(".") ? e.fn.split(".").slice(0, -1).join(".") : "(root)";
    const m = (mods[mod] ??= { effects: new Set(), functions: 0 });
    for (const x of e.inferred) m.effects.add(x);
    m.functions += 1;
  }
  return Object.fromEntries(Object.entries(mods).sort()
    .map(([k, v]) => [k, { effects: [...v.effects].sort(), functions: v.functions }]));
}

// containment (SPEC §6.1) — how well each BOUNDARY effect stays in one layer (dispersion, NOT a count),
// with the AS-EFF-010 ratchet when a baseline is given. Mirrors candor-java Query.containment and
// candor-query cmd_containment: boundary effects are scored, ambient ones reported-not-scored; a layer is
// the segment AFTER the common dotted prefix ("(root)" when no package layer follows). Uses DIRECT effects.
export const CONTAINED = ["Db", "Net", "Exec", "Fs", "Ipc", "Clipboard"];
export const AMBIENT = ["Log", "Clock", "Rand", "Env"];
function commonPrefixLen(fns) {
  let best = null;
  for (const e of fns) {
    const segs = e.fn.split(".");
    if (best === null) { best = segs; continue; }
    let i = 0; const n = Math.min(best.length, segs.length);
    while (i < n && best[i] === segs[i]) i++;
    best = best.slice(0, i);
  }
  return (best ?? []).length;
}
function layerOf(fn, prefixLen) {
  // The layer = the first segment after the common prefix, the leaf excluded. candor-ts names functions
  // with a FILE.fn (free fns) or FILE.Class.method tail — a SHALLOW 1-segment-minimum tail — so the rule is
  // `prefixLen + 1 < length` (matching candor-rust's layer_of). candor-java uses `+2` because its names carry
  // an extra Package.Class.method segment; copying that here collapsed every 2-segment free function to
  // "(root)", killing the dispersion signal on real TS reports.
  const segs = fn.split(".");
  return prefixLen + 1 < segs.length ? segs[prefixLen] : "(root)";
}
export function containment(fns, baseFns) {
  const pl = commonPrefixLen(fns);
  const known = new Set([...CONTAINED, ...AMBIENT]);
  const byEff = {}; // effect -> { layer -> count }, over DIRECT effects
  for (const e of fns) for (const eff of (e.direct ?? [])) {
    if (!known.has(eff)) continue;
    const layer = layerOf(e.fn, pl);
    (byEff[eff] ??= {})[layer] = (byEff[eff][layer] ?? 0) + 1;
  }
  // RATCHET: a baseline was given — flag any contained effect now in a layer it wasn't in (a leak), note removals.
  if (baseFns) {
    const bpl = commonPrefixLen(baseFns);
    const baseLayers = {};
    for (const e of baseFns) for (const eff of (e.direct ?? [])) {
      if (!CONTAINED.includes(eff)) continue;
      (baseLayers[eff] ??= new Set()).add(layerOf(e.fn, bpl));
    }
    const leaks = [], cleanups = [];
    for (const eff of CONTAINED) {
      const now = new Set(Object.keys(byEff[eff] ?? {}));
      const was = baseLayers[eff] ?? new Set();
      for (const l of now) if (!was.has(l)) leaks.push(`${eff} → ${l}`);
      for (const l of was) if (!now.has(l)) cleanups.push(`${eff} ⊘ ${l}`);
    }
    return { leaks: leaks.sort(), cleanups: cleanups.sort() };
  }
  // REPORT: the containment diagnostic.
  const contained = [];
  for (const eff of CONTAINED) {
    const layers = byEff[eff]; if (!layers) continue;
    const entries = Object.entries(layers);
    const tot = entries.reduce((a, [, n]) => a + n, 0);
    const owner = entries.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const placement = Object.fromEntries(entries.slice().sort((a, b) => a[0].localeCompare(b[0])));
    contained.push({ effect: eff, containmentPct: Math.floor((100 * owner[1]) / tot),
                     layers: entries.length, owner: owner[0], placement });
  }
  const ambient = {};
  for (const eff of AMBIENT) if (byEff[eff]) ambient[eff] = Object.keys(byEff[eff]).length;
  return { contained, ambient };
}

export function reachable(fns) {
  const roots = fns.filter((e) => e.entryPoint);
  const byEff = {};
  for (const e of roots) for (const x of e.inferred) (byEff[x] ??= []).push(e.fn);
  return {
    entryPoints: roots.length,
    effects: Object.fromEntries(Object.entries(byEff).sort()
      .map(([k, v]) => [k, { count: v.length, via: v.sort() }])),
  };
}

// impact: the BACKWARD blast radius — every effectful fn that transitively calls the target, and
// which ENTRY POINTS are downstream. Matches candor-query's {fn, affectedCount, entryPoints} and adds
// the `affected` list (a forward-compatible extension: an agent wants the names, not just a count).
export function impact(fns, cg, q) {
  const targets = matches(Object.keys(cg), q);
  const rev = reverseGraph(cg);
  const idx = indexFns(fns);
  const effectful = new Set(fns.map((e) => e.fn)); // the report lists only effect-carrying units
  const entrySet = new Set(fns.filter((e) => e.entryPoint).map((e) => e.fn));
  const reached = new Set();
  const queue = [...targets];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!reached.has(c) && !targets.includes(c)) { reached.add(c); queue.push(c); }
  }
  const tgt = targets[0];
  const affected = [...reached].filter((n) => effectful.has(n)).sort();
  const rootNames = [];
  if (idx.get(tgt)?.entryPoint) rootNames.push(tgt); // the target itself, if a runtime root
  rootNames.push(...[...reached].filter((n) => entrySet.has(n)).sort());
  const entryPoints = rootNames.map((n) => ({ fn: n, inferred: idx.get(n)?.inferred ?? [] }));
  return { fn: tgt ?? q, affectedCount: affected.length, affected, entryPoints };
}

// blindspots (SPEC §3.1 ⟨0.6⟩): the Unknown SOURCES — fns whose OWN body has an unresolvable call (so
// they carry `unknownWhy`), each ranked by its Unknown blast radius (the transitive callers that inherit
// Unknown through it). The actionable inverse of a widely-propagated Unknown: a report can read mostly
// Unknown from a handful of root causes — this names them, ranked, to declare/resolve/accept. Matches
// candor-java/candor-query: { sources:[{fn,why,reaches,affected}], totalUnknown }.
export function blindspots(fns, cg) {
  const rev = reverseGraph(cg);
  const totalUnknown = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
  const sources = [];
  for (const e of fns) {
    const why = e.unknownWhy ?? [];
    if (why.length === 0) continue; // a SOURCE carries its own unknownWhy; a purely-transitive Unknown does not
    const reached = new Set();
    const queue = [e.fn];
    const seen = new Set([e.fn]);
    while (queue.length) {
      const n = queue.pop();
      for (const c of rev.get(n) ?? []) if (!seen.has(c)) { seen.add(c); reached.add(c); queue.push(c); }
    }
    const affected = [...reached].sort();
    sources.push({ fn: e.fn, why, reaches: affected.length, affected });
  }
  sources.sort((a, b) => b.reaches - a.reaches || a.fn.localeCompare(b.fn)); // most-smearing first, stable
  return { sources, totalUnknown };
}

// path: the FORWARD provenance — a shortest BFS over the calls graph from `fn` to the nearest unit
// that performs `eff` DIRECTLY (the source). Matches candor-query's {effect, fn, path:[{fn,loc,source}]}.
export function path(fns, cg, fnQ, eff) {
  const idx = indexFns(fns);
  const targets = matches(Object.keys(cg), fnQ);
  const start = targets[0];
  const isSource = (n) => idx.get(n)?.direct?.includes(eff);
  if (start === undefined) return { effect: eff, fn: fnQ, path: [] };
  // BFS, tracking predecessor for path reconstruction.
  const prev = new Map([[start, null]]);
  const queue = [start];
  let found = isSource(start) ? start : null;
  while (queue.length && found === null) {
    const n = queue.shift();
    for (const c of cg[n] ?? []) {
      if (prev.has(c)) continue;
      prev.set(c, n);
      if (isSource(c)) { found = c; break; }
      queue.push(c);
    }
  }
  if (found === null) return { effect: eff, fn: fnQ, path: [] }; // honest: no local source on a path
  const chain = [];
  for (let n = found; n !== null; n = prev.get(n)) chain.unshift(n);
  return {
    effect: eff,
    fn: start,
    path: chain.map((n) => ({ fn: n, loc: idx.get(n)?.loc ?? "", source: n === found })),
  };
}

// diff: the per-unit effect delta between two reports (cur vs base) — {changes:[{fn, gained, lost}]}.
// The same shape query.mjs emits; the watcher uses it to tell an agent what its edit changed.
// Effects keyed by fn name, UNIONED across rows that share a name. A plain `new Map(fns.map(...))`
// keeps only the LAST same-named row — so when the multi-report loader merges workspace members that
// share a short fn name, one member's effects silently vanish from diff/gains → a SUPPLY-CHAIN MISS
// (gains fails to flag a gained Net). Unioning is the safe direction (never drops an effect).
function effectsByFn(fns) {
  const m = new Map();
  for (const e of fns) {
    const s = m.get(e.fn) ?? new Set();
    for (const x of (Array.isArray(e.inferred) ? e.inferred : [])) s.add(x);  // a string "Net" would iter chars
    m.set(e.fn, s);
  }
  return m;
}

export function diff(curFns, baseFns) {
  const cur = effectsByFn(curFns);
  const base = effectsByFn(baseFns);
  const changes = [];
  for (const fn of new Set([...cur.keys(), ...base.keys()])) {
    const c = cur.get(fn) ?? new Set(), b = base.get(fn) ?? new Set();
    const gained = [...c].filter((e) => !b.has(e)).sort();
    const lost = [...b].filter((e) => !c.has(e)).sort();
    if (gained.length || lost.length) changes.push({ fn, gained, lost });
  }
  changes.sort((a, b) => a.fn.localeCompare(b.fn));
  return { changes };
}

// gains: the package-level SUPPLY-CHAIN alarm (spec §5.1) — the UNION of effects the surface gained
// between two reports (base → cur), with per-function detail. A dependency that grows a Net/Exec reach
// between releases. Same shape as candor-query's `gains --json`. Built on diff so it can't drift.
export function gains(curFns, baseFns) {
  const gained = new Set(), byFunction = [];
  for (const c of diff(curFns, baseFns).changes) {
    for (const e of c.gained) { gained.add(e); byFunction.push({ fn: c.fn, effect: e }); }
  }
  return { gained: [...gained].sort(), byFunction };
}

// whatif: hypothetically add `eff` to `target` and report the blast radius + any policy violations.
// `policyParsed` is an already-parsed policy object (or null); kept I/O-free for the core.
export function whatif(cg, target, eff, policyParsed, scopeMatches) {
  const targets = matches(Object.keys(cg), target);
  if (targets.length === 0) return null; // caller decides how to surface "no such fn"
  const rev = reverseGraph(cg);
  const affected = new Set(targets);
  const queue = [...targets];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!affected.has(c)) { affected.add(c); queue.push(c); }
  }
  const violations = [];
  if (policyParsed) {
    for (const r of policyParsed.deny) {
      if (r.effects.length && !r.effects.includes(eff)) continue; // pure ([]) forbids ANY effect
      for (const fn of affected)
        if (!r.scope || scopeMatches(fn, r.scope))
          violations.push({ fn, rule: `deny ${r.effects.join(" ") || "(pure)"} ${r.scope}`.trim() });
    }
  }
  return { of: targets, effect: eff, affected: [...affected].sort(), violations, ok: violations.length === 0 };
}

// deniedLayer: the deny/`pure` scope (the "layer") forbidding `eff` at `fn`, or null if allowed there.
// Mirrors the gate's AS-EFF-006 predicate (candor-java/candor-query): a `deny` fires when it names the
// effect; a `pure` rule (empty effects) forbids every real effect but not Unknown.
function deniedLayer(fn, eff, policyParsed, scopeMatches) {
  for (const r of policyParsed.deny) {
    const denies = r.effects.length === 0 ? eff !== "Unknown" : r.effects.includes(eff);
    if (denies && (!r.scope || scopeMatches(fn, r.scope))) return r.scope ?? "";
  }
  return null;
}

// The site-anchored cut (integrations/FIX-SPEC.md), shared by fix + fixGate — the byte-for-byte port of
// candor-query / candor-java's computeRemedy. Forward-BFS to the direct site(s), then climb UP through the
// denied layer so the pure span is the same whichever inheriting function triggered it (root-independent);
// the allowed-layer callers where the climb stops are the hoist frontier.
function computeRemedy(start, eff, layer, cg, rev, byName, policyParsed, scopeMatches) {
  const sites = new Set();
  const fseen = new Set([start]);
  const fq = [start];
  while (fq.length) {
    const cur = fq.shift();
    const fe = byName.get(cur);
    if (fe && (fe.direct ?? []).includes(eff)) sites.add(cur);
    for (const c of cg[cur] ?? []) {
      const ce = byName.get(c);
      if (ce && (ce.inferred ?? []).includes(eff) && !fseen.has(c)) { fseen.add(c); fq.push(c); }
    }
  }
  const anchors = sites.size ? [...sites] : [start];
  const deniedSpan = new Set();
  const hoistTo = new Set();
  const up = [];
  for (const a of anchors) {
    if (deniedLayer(a, eff, policyParsed, scopeMatches) !== null) deniedSpan.add(a);
    up.push(a);
  }
  while (up.length) {
    const cur = up.shift();
    for (const caller of rev.get(cur) ?? []) {
      const ce = byName.get(caller);
      // skip a caller that doesn't route the effect — INCLUDING one absent from the report (a pure
      // callgraph-only node never carries the effect). Matches candor-swift. (/code-review — was `ce && !…`.)
      if (!ce || !(ce.inferred ?? []).includes(eff)) continue;
      if (deniedLayer(caller, eff, policyParsed, scopeMatches) !== null) {
        if (!deniedSpan.has(caller)) { deniedSpan.add(caller); up.push(caller); }
      } else {
        hoistTo.add(caller);
      }
    }
  }
  // higher hoist options: allowed-layer transitive callers of the minimal frontier that also route the
  // effect — hoisting higher keeps the frontier pure too, at the cost of threading through more signatures
  // (FIX-SPEC: the trade-off, disclosed not hidden).
  // The SANDWICHED-layer check (/code-review): a hoist is CLEAN only if no forbidden fn sits ABOVE the
  // frontier. If a denied fn calls into a hoist target, hoisting the effect there leaves that caller
  // violating. Detected in the same climb that gathers `hoistHigher` (the allowed ancestors).
  const hoistHigher = new Set();
  let sandwiched = false;
  const hseen = new Set(hoistTo);
  const hq = [...hoistTo];
  while (hq.length) {
    const cur = hq.shift();
    for (const caller of rev.get(cur) ?? []) {
      const ce = byName.get(caller);
      if (!ce || !(ce.inferred ?? []).includes(eff)) continue;
      if (deniedLayer(caller, eff, policyParsed, scopeMatches) !== null) {
        sandwiched = true;
      } else if (!hseen.has(caller)) {
        hseen.add(caller);
        hoistHigher.add(caller);
        hq.push(caller);
      }
    }
  }
  return {
    fn: start, effect: eff, layer,
    cleanHoist: hoistTo.size > 0 && !sandwiched,
    site: [...sites].sort(),
    deniedSpan: [...deniedSpan].sort(),
    hoistTo: [...hoistTo].sort(),
    hoistHigher: [...hoistHigher].sort(),
    policyAlternative: layer ? `allow ${eff} ${layer}` : `allow ${eff}`,
  };
}

// fix: the boundary remedy for ONE function (the remedial inverse of whatif). Returns null if the function
// isn't in the graph; `{ crossing:false, reason }` if it performs the effect but no policy forbids it there
// (or it doesn't perform it) — a no-op the caller reports plainly; else the full remedy (`crossing:true`).
// NOTE: `cg` (the callgraph sidecar) is REQUIRED — unlike candor-query/java/swift, a candor-ts report does not
// embed inline `calls`, so the sidecar is the only graph; the CLI/MCP callers fail loud when it's absent
// rather than compute a degenerate empty-graph remedy. (/code-review.)
export function fix(cg, fns, target, eff, policyParsed, scopeMatches) {
  // Resolve against REPORT function names only (not callgraph nodes, which include pure fns absent from the
  // report) — so `fix <pure-fn>` is a uniform "no such fn" across engines, not a TS-only crossing:false.
  // (/code-review — candor-query/java/swift all match report fns only.)
  const m = matches(fns.map((e) => e.fn), target);
  if (m.length === 0) return null;
  const byName = indexFns(fns);
  // prefer a match that actually performs the effect, so a bare leaf resolves to the violating function
  const start = m.find((n) => (byName.get(n)?.inferred ?? []).includes(eff)) ?? m[0];
  const se = byName.get(start);
  if (!se || !(se.inferred ?? []).includes(eff))
    return { fn: start, effect: eff, crossing: false, reason: "does-not-perform" };
  const layer = deniedLayer(start, eff, policyParsed, scopeMatches);
  if (layer === null)
    return { fn: start, effect: eff, crossing: false, reason: "not-forbidden" };
  const rev = reverseGraph(cg);
  return { crossing: true, ...computeRemedy(start, eff, layer, cg, rev, byName, policyParsed, scopeMatches) };
}

// fixGate: a remedy for EVERY deny/`pure` (AS-EFF-006) crossing in the report, collapsing the inheritors of
// one root cause to a single plan (keyed by effect|layer|site|hoist). Returns { ok, remedies } — the shape
// the edit-time loop folds into its block message.
export function fixGate(cg, fns, policyParsed, scopeMatches) {
  const byName = indexFns(fns);
  const rev = reverseGraph(cg);
  const plans = new Map();
  // Iterate functions in sorted-name order so the first-writer-wins `fn` representative of a collapsed
  // remedy is deterministic across engines (candor-query/java/swift all iterate a sorted key set).
  for (const e of [...fns].sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0))) {
    for (const eff of [...(e.inferred ?? [])].sort()) {
      const layer = deniedLayer(e.fn, eff, policyParsed, scopeMatches);
      if (layer !== null) {
        const p = computeRemedy(e.fn, eff, layer, cg, rev, byName, policyParsed, scopeMatches);
        const key = `${p.effect}|${p.layer}|${p.site}|${p.hoistTo}`;
        if (!plans.has(key)) plans.set(key, p);
      }
    }
  }
  // Emit remedies in dedup-key order (candor-query BTreeMap / java TreeMap / swift sorted-keys all do).
  const remedies = [...plans.keys()].sort().map((k) => plans.get(k));
  return { ok: remedies.length === 0, remedies };
}

// unverified: the PROVABLE-PURITY disclosure (eval/fixloop/DISPATCH-NOTE.md, mirrors candor-query). A
// `pure`/`deny E` layer PASSES a function that carries none of its forbidden effects — but if that function is
// `Unknown` (an unresolvable call), the pass is UNVERIFIED: the Unknown could hide the very effect the rule
// forbids (the fn/closure-port hole). Returns each such function + the `deny E Unknown <scope>` upgrade.
/** Reconstruct a rule's source form and its `Unknown`-forbidding upgrade: `[source, upgrade]`. `pure
 *  <scope>` → ["pure <scope>", "deny Unknown <scope>"]; `deny <E…> <scope>` → ["deny <E…> <scope>",
 *  "deny <E…> Unknown <scope>"]. Shared so the gate note and `unverified` name the identical upgrade. */
export function ruleUpgrade(r) {
  const suffix = r.scope ? ` ${r.scope}` : "";
  return r.effects.length === 0
    ? [`pure${suffix}`, `deny Unknown${suffix}`]
    : [`deny ${r.effects.join(" ")}${suffix}`, `deny ${r.effects.join(" ")} Unknown${suffix}`];
}

/** The single predicate for a provable-purity hole (eval/fixloop/DISPATCH-NOTE.md): a function that is
 *  Unknown, sits in a pure/deny scope, and PASSES that rule (carries none of its forbidden real effects) —
 *  so its compliance is asserted but not verified (the Unknown could hide the very effect the rule forbids;
 *  the classic case is a fn/closure-injected port). A *real* violation is the gate's job, not this. Returns
 *  the first governing rule under which the function is such a hole, or null. Shared by the gate note
 *  (scan.mjs) and `unverified` so "what a hole is" has ONE definition (conformance PART 12d pins agreement). */
export function unverifiedHoleRule(fn, inferred, policyParsed, scopeMatches) {
  const inf = inferred ?? [];
  if (!inf.includes("Unknown")) return null;
  for (const r of policyParsed.deny) {
    if (r.scope && !scopeMatches(fn, r.scope)) continue;
    const violates = r.effects.length === 0
      ? inf.some((x) => x !== "Unknown")        // pure: any real effect is a violation
      : inf.some((x) => r.effects.includes(x)); // deny: a named effect is a violation
    if (!violates) return r;                    // else it's a real violation the gate already reports
  }
  return null;
}

export function unverified(fns, policyParsed, scopeMatches) {
  const holes = [];
  for (const e of fns) {
    // Same predicate + upgrade as the gate note (scan.mjs) — one source of truth for a hole.
    const r = unverifiedHoleRule(e.fn, e.inferred, policyParsed, scopeMatches);
    if (!r) continue;
    const [rule, upgrade] = ruleUpgrade(r);
    holes.push({ fn: e.fn, rule, unknownWhy: e.unknownWhy ?? [], upgrade });
  }
  return { ok: holes.length === 0, unverified: holes };
}
