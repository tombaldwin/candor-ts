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
  // Split LINES on \n / \r\n / bare \r — the three forms Java's Files.readAllLines (the reference parser)
  // breaks on. Splitting on \n ONLY let a classic-Mac (bare-\r) file collapse to one line: \r is also an
  // in-line ASCII-ws token separator (below), so every rule after the first was glued into the first rule's
  // tokens and dropped — a gateless-green divergence (sweep [16]/[17]). \v/\f stay in-line separators.
  for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
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

/** §6.2 scope match: by NAME SEGMENT, last segment a prefix.
 * Segments split on BOTH "." and "::" — Rust/Java qualify with "::" while TS uses ".", and a shared
 * policy must match across engines (a `Foo::bar` scope authored against Rust was inert in TS before). */
export function scopeMatches(name, scope) {
  const segs = name.split(/[.:]+/).filter(Boolean);
  const parts = scope.split(/[.:]+/).filter(Boolean);
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
// Each violation is a STRUCTURED record { rule, fn, effects, detail } (candor-spec §3.3 ⟨0.8⟩): `effects`
// is the specific denied/allowed effect set the violation concerns ([] for the 009 layer-flow, which has
// no single effect); `detail` is the message BODY (no `[AS-EFF-00x]` prefix — the rule carries the code).
// The console gate renders `[${rule}] ${detail}`; --gate-json emits the records verbatim.
export function evaluatePolicy(pol, functions, callgraph, incomplete = new Map()) {
  const out = [];
  const surfaces = { Net: "hosts", Exec: "cmds", Fs: "paths", Db: "tables" };
  const push = (rule, fn, effects, detail) => out.push({ rule, fn, effects, detail });
  for (const f of functions) {
    for (const r of pol.deny) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      const hits = r.effects.length === 0 ? f.inferred : f.inferred.filter((e) => r.effects.includes(e));
      if (hits.length) push("AS-EFF-006", f.fn, hits, `\`${f.fn}\` performs { ${hits.join(", ")} }, forbidden by policy: \`${r.raw}\``);
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
        push("AS-EFF-008", f.fn, [r.effect], `\`${f.fn}\` performs ${r.effect} with no visible literal — the surface cannot be certified: \`${r.raw}\``);
      } else {
        const bad = reached.filter((v) => !literalAllowed(r.effect, v, r.values));
        if (bad.length) push("AS-EFF-008", f.fn, [r.effect], `\`${f.fn}\` reaches { ${bad.join(", ")} } outside the allowlist: \`${r.raw}\``);
      }
    }
  }
  // AS-EFF-009: forbid A -> B by reachability over the callgraph. No single effect → effects: [].
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
      if (hit) push("AS-EFF-009", fn, [], `\`${fn}\` reaches into a forbidden layer (via \`${hit}\`), violating policy: \`${r.raw}\``);
    }
  }
  return out;
}

// ---- .candor/config discovery (spec §3.4) — shared by the MCP + LSP surfaces -----------------------
// Walk UP from `fromDir` to the nearest .candor/config and return its `policy` entry resolved against
// that config's repo root: { policyPath, repoRoot } — or null. A RELATIVE `policy` value resolves
// against the repo the config belongs to (the parent of its `.candor/`), NEVER the process CWD — the
// family rule (scan.mjs configAnchor is the producer-side twin): a checked-in config means the same
// file wherever the consumer process was launched. Read-only + best-effort (a consumer surface never
// gates a build; a broken config surfaces as the caller's error).
import fs from "node:fs";
import nodePath from "node:path";
export function discoverConfigPolicy(fromDir) {
  let dir = nodePath.resolve(fromDir);
  for (;;) {
    const cand = nodePath.join(dir, ".candor", "config");
    if (fs.existsSync(cand)) {
      const m = fs.readFileSync(cand, "utf8").split(/\r?\n/)
        .map((l) => l.split("#", 1)[0].trim()).filter(Boolean)
        .map((l) => l.match(/^(\S+)\s*(.*)$/)).find((mm) => mm && mm[1].toLowerCase() === "policy");
      if (!m) return null;
      return { policyPath: nodePath.resolve(dir, m[2].trim()), repoRoot: dir };
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
