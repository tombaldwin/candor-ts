/**
 * The §6.2 policy grammar + gate semantics, shared by query.mjs (whatif/parsepolicy) and scan.mjs
 * (the standing --policy gate). One parser, one matcher set — the same single-source rule the Rust
 * engines follow (candor-classify::policy), so the TS gate can never disagree with its own whatif.
 */

export const EFFECTS = ["Net", "Fs", "Db", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard"];
const ALLOW_EFFECTS = new Set(["Net", "Exec", "Fs", "Db"]); // the four literal surfaces

// The §6.2 token separator: ASCII whitespace ONLY (space/tab/LF/VT/FF/CR). JS `\s`/`String.trim` strip
// Unicode spaces (NBSP, ideographic, …) that Java drops — a gateless-green cross-engine divergence
// (adversarial DSL review). A non-ASCII space stays part of its token → the rule is malformed, dropped.
const ASCII_WS = /[ \t\n\v\f\r]+/;
const ASCII_WS_TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
export function parsePolicy(text) {
  const deny = [], allow = [], forbid = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].replace(ASCII_WS_TRIM, "");
    if (!line) continue;
    const t = line.split(ASCII_WS);
    const warn = (why) => console.error(`candor: ignoring policy rule (${why}): ${line}`);
    if (t[0] === "deny") {
      const effects = [];
      let scope = "";
      for (const tok of t.slice(1)) {
        if (EFFECTS.includes(tok) || tok === "Unknown") effects.push(tok);
        else { scope = tok; break; }
      }
      if (effects.length === 0) { warn("deny names no known effect"); continue; }
      deny.push({ effects: [...new Set(effects)].sort(), scope, raw: line }); // dedup: a set, like rust/java
    } else if (t[0] === "pure") {
      deny.push({ effects: [], scope: t[1] ?? "", raw: line });
    } else if (t[0] === "allow") {
      if (t.length < 3) { warn("allow names no values"); continue; }
      if (!ALLOW_EFFECTS.has(t[1])) { warn("allow supports only Net hosts / Exec commands / Fs paths / Db tables"); continue; }
      let scope = "", vi = 2;
      if (t[2] === "in") { scope = t[3] ?? ""; vi = 4; }
      const values = t.slice(vi);
      if (values.length === 0) { warn("allow names no values"); continue; }
      allow.push({ effect: t[1], scope, values: [...new Set(values)].sort(), raw: line }); // dedup (set)
    } else if (t[0] === "forbid") {
      // Token-wise like the Rust/JVM parsers: the arrow must be its own whitespace-separated token
      // (`a->b` glued is malformed), and tokens past `b` are ignored. A regex here once accepted and
      // rejected DIFFERENT lines than the other engines — the one thing a shared gate must not do.
      const [a, arrow, b] = [t[1] ?? "", t[2] ?? "", t[3] ?? ""];
      if (!a || arrow !== "->" || !b) { warn("malformed forbid (want `forbid <scope> -> <scope>`)"); continue; }
      forbid.push({ from: a, to: b, raw: line });
    } else {
      warn("unknown rule kind");
    }
  }
  return { deny, allow, forbid };
}

/** §6.2 scope match: by NAME SEGMENT over ".", last segment a prefix. */
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

// ---- the effect-specific literal matchers (§6.2), mirroring the Rust/JVM semantics ---------------
export function hostPart(h) {
  if (h.startsWith("[")) return h.slice(1).split("]")[0];           // [ipv6][:port]
  if ((h.match(/:/g) ?? []).length > 1) return h;                   // bare ipv6 — no port to strip
  return h.split(":")[0];
}
export function cmdBase(c) {
  const first = c.trim().split(/\s+/)[0];
  return first.split(/[/\\]/).pop();
}
export function pathCovered(a, r) {
  const norm = (s) => s.split(/[/\\]/).filter((c) => c && c !== ".");
  if (norm(r).includes("..")) return false;
  const abs = (s) => s.startsWith("/") || s.startsWith("\\");
  if (abs(a) !== abs(r)) return false;
  const ac = norm(a), rc = norm(r);
  return ac.length <= rc.length && ac.every((x, i) => x === rc[i]);
}
export function tableCovered(a, r) {
  a = a.toLowerCase(); r = r.toLowerCase();
  if (a.endsWith(".*")) return r.startsWith(a.slice(0, -1));        // "schema." prefix
  return a === r;
}
export function literalAllowed(effect, reached, values) {
  switch (effect) {
    case "Net":  return values.some((a) => hostPart(a) === hostPart(reached));
    case "Exec": return values.some((a) => cmdBase(a) === cmdBase(reached));
    case "Fs":   return values.some((a) => pathCovered(a, reached));
    case "Db":   return values.some((a) => tableCovered(a, reached));
    default:     return values.includes(reached);
  }
}

/**
 * The standing gate: evaluate a parsed policy over a report + callgraph (AS-EFF-006 deny/pure over
 * transitive inferred; AS-EFF-008 allowlists over the transitive literal surfaces, the no-visible-
 * literal case flagged as uncertifiable; AS-EFF-009 forbid by reachability). One line per violation.
 */
export function evaluatePolicy(pol, functions, callgraph, incomplete = new Map()) {
  const out = [];
  const surfaces = { Net: "hosts", Exec: "cmds", Fs: "paths", Db: "tables" };
  for (const f of functions) {
    for (const r of pol.deny) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      const hits = r.effects.length === 0 ? f.inferred : f.inferred.filter((e) => r.effects.includes(e));
      if (hits.length) out.push(`[AS-EFF-006] \`${f.fn}\` performs { ${hits.join(", ")} }, forbidden by policy: \`${r.raw}\``);
    }
    for (const r of pol.allow) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      if (!f.inferred.includes(r.effect)) continue;
      const reached = f[surfaces[r.effect]] ?? [];
      // An INCOMPLETE surface (a structurally-invisible reach — a host-establishing call with a runtime/
      // invisible host) can't be certified even with visible hosts, else a benign literal masks the
      // invisible forbidden endpoint (the masking evasion). Matches candor-java 0.5.29 / candor-rust.
      const surfaceIncomplete = incomplete.get(f.fn)?.has(r.effect);
      if (reached.length === 0 || surfaceIncomplete) {
        out.push(`[AS-EFF-008] \`${f.fn}\` performs ${r.effect} with no visible literal — the surface cannot be certified: \`${r.raw}\``);
      } else {
        const bad = reached.filter((v) => !literalAllowed(r.effect, v, r.values));
        if (bad.length) out.push(`[AS-EFF-008] \`${f.fn}\` reaches { ${bad.join(", ")} } outside the allowlist: \`${r.raw}\``);
      }
    }
  }
  // AS-EFF-009: forbid A -> B by reachability over the callgraph.
  for (const r of pol.forbid) {
    for (const fn of Object.keys(callgraph)) {
      if (!scopeMatches(fn, r.from)) continue;
      const seen = new Set([fn]), queue = [fn];
      let hit = null;
      while (queue.length && !hit) {
        for (const c of callgraph[queue.pop()] ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          if (scopeMatches(c, r.to)) { hit = c; break; }
          queue.push(c);
        }
      }
      if (hit) out.push(`[AS-EFF-009] \`${fn}\` reaches into a forbidden layer (via \`${hit}\`), violating policy: \`${r.raw}\``);
    }
  }
  return out;
}
