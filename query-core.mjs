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
// A sibling filename that is a real REPORT (not a callgraph sidecar, an encountered-crate ledger, or a
// calibrated-coverage sidecar). Exported so `hasReport` (the MCP existence check) uses the SAME predicate
// as the loader — else a prefix whose only sibling is `.encountered-*`/`.calibrated.json` passes the
// existence check but loads ZERO functions → an authoritative-empty result (silent under-report; review find).
export const isReport = (f) => !f.endsWith(".callgraph.json") && !f.endsWith(".hierarchy.json") && !f.includes(".encountered-") && !f.endsWith(".calibrated.json");

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

export function loadReport(prefix) {
  if (fs.existsSync(`${prefix}.json`)) {
    // The PRIMARY report parse must DISCLOSE-and-tolerate like the sibling path — a bare JSON.parse here
    // threw an uncaught stack trace on the CLI for a corrupt `<prefix>.json` (asymmetric with siblings).
    try { return normFns(JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")), `${prefix}.json`); }
    catch { console.error(`candor-ts: report ${prefix}.json failed to parse — OMITTED (corrupt or mid-write); re-run the scan`); return []; }
  }
  // No exact <prefix>.json — merge the multi-report siblings (the Rust/workspace form).
  const fns = [];
  for (const f of siblings(prefix, isReport)) {
    // DISCLOSE a malformed sibling — never silently drop it (a vanished report reads as "no effect").
    try { fns.push(...normFns(JSON.parse(fs.readFileSync(f, "utf8")), f)); }
    catch { console.error(`candor-ts: report ${f} failed to parse — its functions are OMITTED from this query (corrupt or mid-write); re-run the scan`); }
  }
  return fns;
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

function reverseGraph(cg) {
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
  const segs = fn.split(".");
  return prefixLen + 2 < segs.length ? segs[prefixLen] : "(root)";
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
