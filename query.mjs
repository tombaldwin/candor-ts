#!/usr/bin/env node
/**
 * candor-ts queries — the SPEC §3.1 read-only query surface + the §6.2 policy grammar, over the
 * report + callgraph sidecar that scan.mjs writes. Same command names, same JSON shapes, same match
 * ladder as the Rust and JVM engines (the cross-impl conformance suite diffs all three).
 *
 * Provenance note (honesty): the ORIGINAL scan.mjs was written from the spec documents alone — the
 * clean-room derivability proof. This file was added later, implemented from the same spec text,
 * but its author had by then read the reference engines; the ongoing guarantee for it is the
 * conformance differential, not clean-room provenance.
 *
 *   node query.mjs parsepolicy <file>
 *   node query.mjs show     <prefix> <query>  <0|1>
 *   node query.mjs where    <prefix> <Effect> <0|1>
 *   node query.mjs callers  <prefix> <query>  <0|1>
 *   node query.mjs map      <prefix>          <0|1>
 *   node query.mjs whatif   <prefix> <fn> <Effect> [policy-file] [0|1]
 */
import fs from "node:fs";

const EFFECTS = ["Net", "Fs", "Db", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard"];
const ALLOW_EFFECTS = new Set(["Net", "Exec", "Fs", "Db"]); // the four literal surfaces (§6.2)

// ---- the §6.2 policy grammar (deny/pure/allow/forbid; # comments; malformed lines warned) --------
export function parsePolicy(text) {
  const deny = [], allow = [], forbid = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    const warn = (why) => console.error(`candor: ignoring policy rule (${why}): ${line}`);
    if (t[0] === "deny") {
      // tokens that name an effect (or Unknown) join the forbidden set; the FIRST non-effect token
      // is the scope and ENDS the rule. A deny naming no effect is dropped (it is NOT a pure rule).
      const effects = [];
      let scope = "";
      for (const tok of t.slice(1)) {
        if (EFFECTS.includes(tok) || tok === "Unknown") effects.push(tok);
        else { scope = tok; break; }
      }
      if (effects.length === 0) { warn("deny names no known effect"); continue; }
      deny.push({ effects: effects.sort(), scope });
    } else if (t[0] === "pure") {
      deny.push({ effects: [], scope: t[1] ?? "" }); // pure = deny-everything (empty set)
    } else if (t[0] === "allow") {
      if (t.length < 3) { warn("allow names no values"); continue; }
      if (!ALLOW_EFFECTS.has(t[1])) { warn("allow supports only Net hosts / Exec commands / Fs paths / Db tables"); continue; }
      let scope = "", vi = 2;
      if (t[2] === "in") { scope = t[3] ?? ""; vi = 4; }
      const values = t.slice(vi);
      if (values.length === 0) { warn("allow names no values"); continue; }
      allow.push({ effect: t[1], scope, values: values.sort() });
    } else if (t[0] === "forbid") {
      // forbid A -> B
      const m = line.match(/^forbid\s+(\S+)\s*->\s*(\S+)$/);
      if (!m) { warn("malformed forbid (expected `forbid A -> B`)"); continue; }
      forbid.push({ from: m[1], to: m[2] });
    } else {
      warn("unknown rule kind");
    }
  }
  return { deny, allow, forbid };
}

// ---- the §6.2 scope match: by NAME SEGMENT (over "."), last segment a prefix ----------------------
export function scopeMatches(name, scope) {
  const segs = name.split(".");
  const parts = scope.split(".");
  if (parts.length === 0 || parts.length > segs.length) return false;
  const last = parts[parts.length - 1], init = parts.slice(0, -1);
  outer: for (let i = 0; i + parts.length <= segs.length; i++) {
    for (let k = 0; k < init.length; k++) if (segs[i + k] !== init[k]) continue outer;
    if (segs[i + parts.length - 1].startsWith(last)) return true;
  }
  return false;
}

// ---- the §3.1 match ladder: exact > segment-suffix > substring ------------------------------------
function matchTier(name, q) {
  if (name === q) return 3;
  if (name.endsWith(q) && /[.$]$/.test(name.slice(0, name.length - q.length))) return 2;
  if (name.includes(q)) return 1;
  return 0;
}
function matches(names, q) {
  const best = Math.max(0, ...names.map((n) => matchTier(n, q)));
  return best === 0 ? [] : names.filter((n) => matchTier(n, q) >= best);
}

function loadReport(prefix) {
  const d = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  return d.functions ?? d;
}
function loadCallgraph(prefix) {
  return JSON.parse(fs.readFileSync(`${prefix}.callgraph.json`, "utf8"));
}
const emit = (v) => console.log(JSON.stringify(v, null, 1));

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case "parsepolicy": {
    emit(parsePolicy(fs.readFileSync(args[0], "utf8")));
    break;
  }
  case "show": {
    const [prefix, q] = args;
    const fns = loadReport(prefix);
    const hit = new Set(matches(fns.map((e) => e.fn), q));
    const out = fns.filter((e) => hit.has(e.fn)).map((e) => {
      const o = { fn: e.fn, inferred: e.inferred, direct: e.direct };
      if (e.fs?.length) o.fs = e.fs;
      if (e.hosts?.length) o.hosts = e.hosts;
      if (e.tables?.length) o.tables = e.tables;
      o.unresolved = e.unresolved;
      return o;
    });
    emit(out);
    break;
  }
  case "where": {
    const [prefix, eff] = args;
    const fns = loadReport(prefix);
    emit({
      effect: eff,
      directly: fns.filter((e) => e.direct.includes(eff)).map((e) => e.fn).sort(),
      inherited: fns.filter((e) => e.inferred.includes(eff) && !e.direct.includes(eff)).map((e) => e.fn).sort(),
    });
    break;
  }
  case "callers": {
    const [prefix, q] = args;
    const cg = loadCallgraph(prefix);
    const names = Object.keys(cg);
    const targets = matches(names, q);
    const rev = new Map();
    for (const [caller, callees] of Object.entries(cg))
      for (const c of callees) (rev.get(c) ?? rev.set(c, []).get(c)).push(caller);
    const direct = new Set(), transitive = new Set();
    const queue = [...targets];
    for (const t of targets) for (const c of rev.get(t) ?? []) direct.add(c);
    while (queue.length) {
      const n = queue.pop();
      for (const c of rev.get(n) ?? []) if (!transitive.has(c) && !targets.includes(c)) { transitive.add(c); queue.push(c); }
    }
    emit({ of: targets, direct: [...direct].sort(), transitive: [...transitive].sort() });
    break;
  }
  case "map": {
    const [prefix] = args;
    const fns = loadReport(prefix);
    const mods = {};
    for (const e of fns) {
      const mod = e.fn.includes(".") ? e.fn.split(".")[0] : "(root)";
      const m = (mods[mod] ??= { effects: new Set(), functions: 0 });
      for (const x of e.inferred) m.effects.add(x);
      m.functions += 1;
    }
    emit(Object.fromEntries(Object.entries(mods).sort()
      .map(([k, v]) => [k, { effects: [...v.effects].sort(), functions: v.functions }])));
    break;
  }
  case "diff": {
    // per-function effect delta vs a baseline: {changes: [{fn, gained, lost}]} — the envelope shape
    // the conformance suite pins (diff-vs-self must be {changes: []}).
    const [curPrefix, basePrefix] = args;
    const cur = new Map(loadReport(curPrefix).map((e) => [e.fn, new Set(e.inferred)]));
    const base = new Map(loadReport(basePrefix).map((e) => [e.fn, new Set(e.inferred)]));
    const changes = [];
    for (const fn of new Set([...cur.keys(), ...base.keys()])) {
      const c = cur.get(fn) ?? new Set(), b = base.get(fn) ?? new Set();
      const gained = [...c].filter((e) => !b.has(e)).sort();
      const lost = [...b].filter((e) => !c.has(e)).sort();
      if (gained.length || lost.length) changes.push({ fn, gained, lost });
    }
    changes.sort((a, b) => a.fn.localeCompare(b.fn));
    emit({ changes });
    process.exit(changes.some((c) => c.gained.length) ? 1 : 0);
  }
  case "whatif": {
    const [prefix, target, eff, maybePolicy] = args;
    const cg = loadCallgraph(prefix);
    const names = Object.keys(cg);
    const targets = matches(names, target);
    if (targets.length === 0) {
      console.error(`candor: no function matching \`${target}\` in the call graph`);
      process.exit(2);
    }
    const rev = new Map();
    for (const [caller, callees] of Object.entries(cg))
      for (const c of callees) (rev.get(c) ?? rev.set(c, []).get(c)).push(caller);
    const affected = new Set(targets);
    const queue = [...targets];
    while (queue.length) {
      const n = queue.pop();
      for (const c of rev.get(n) ?? []) if (!affected.has(c)) { affected.add(c); queue.push(c); }
    }
    const violations = [];
    if (maybePolicy && maybePolicy !== "0" && maybePolicy !== "1" && fs.existsSync(maybePolicy)) {
      const pol = parsePolicy(fs.readFileSync(maybePolicy, "utf8"));
      for (const r of pol.deny) {
        if (r.effects.length && !r.effects.includes(eff)) continue; // pure ([]) forbids ANY effect
        for (const fn of affected)
          if (!r.scope || scopeMatches(fn, r.scope))
            violations.push({ fn, rule: `deny ${r.effects.join(" ") || "(pure)"} ${r.scope}`.trim() });
      }
    }
    emit({ of: targets, effect: eff, affected: [...affected].sort(), violations, ok: violations.length === 0 });
    process.exit(violations.length ? 1 : 0);
  }
  default:
    console.error("usage: node query.mjs <parsepolicy|show|where|callers|map|whatif> …");
    process.exit(2);
}
