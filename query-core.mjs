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

export function loadReport(prefix) {
  const d = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  return d.functions ?? d;
}
export function loadCallgraph(prefix) {
  return JSON.parse(fs.readFileSync(`${prefix}.callgraph.json`, "utf8"));
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
    if (e.fs?.length) o.fs = e.fs;
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
  const effectful = new Set(fns.map((e) => e.fn)); // the report lists only effect-carrying units
  const entrySet = new Set(fns.filter((e) => e.entryPoint).map((e) => e.fn));
  const reached = new Set();
  const queue = [...targets];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!reached.has(c) && !targets.includes(c)) { reached.add(c); queue.push(c); }
  }
  const affected = [...reached].filter((n) => effectful.has(n)).sort();
  const entryPoints = [...reached].filter((n) => entrySet.has(n)).sort();
  return { fn: targets.length === 1 ? targets[0] : q, affectedCount: affected.length, entryPoints, affected };
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
