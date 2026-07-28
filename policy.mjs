/**
 * The §6.2 policy grammar + gate semantics, shared by query.mjs (whatif/parsepolicy) and scan.mjs
 * (the standing --policy gate). One parser, one matcher set — the same single-source rule the Rust
 * engines follow (candor-classify::policy), so the TS gate can never disagree with its own whatif.
 */

import { NET_DEST_CLASSES, netClassesOf } from "./scan-core.mjs";

export const EFFECTS = ["Net", "Fs", "Db", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard", "Llm"];

// Reason-scoped Unknown (REASON-SCOPED-UNKNOWN-DESIGN.md): the CLOSED, cross-engine reason-class set a
// `deny E Unknown[class…]` rule quantifies over. Must be IDENTICAL to candor-java's ReasonClass and
// candor-rust's — the mapping below mirrors java's prefix-based ReasonClass.classify(String).
export const REASON_CLASSES = ["reflect", "dispatch", "indirect", "native", "unresolved", "setup"];
// `dynamic` = every GENUINE blind-spot class (excludes `setup`), incl. `unresolved` so it never under-gates.
// Exported so the `--class` flag (query-core) resolves the alias from THIS list rather than a second copy:
// the flag and the policy filter name the same vocabulary, so `--class dynamic` and `Unknown[dynamic]`
// cannot drift into meaning different sets.
export const DYNAMIC_CLASSES = ["reflect", "dispatch", "indirect", "native", "unresolved"];
/** Map a raw `unknownWhy` token (e.g. `reflect:eval`, `callback:fetch`) to its normative reason class. */
export function reasonClass(why) {
  const w = String(why).trim().toLowerCase();
  // `startsWith`, NOT `===`. candor-swift emits this token in the normative `kind:detail` form —
  // `dynamicMemberLookup:<root>.<prop>` (CallCollector.swift) — and never bare, so an equality test can
  // never match a real one and the token falls through to the `unresolved` catch-all below. Both classes
  // are in DYNAMIC_CLASSES, so a bare `deny Unknown` is unaffected; what silently weakens is the
  // class-targeted `deny Unknown[reflect]`, which is the form the reason ratchet is adopted in. Found by
  // the swift sweep (the same equality test made `Unknown[reflect]` unsatisfiable there even in one tree)
  // and fixed in candor-java as `d9b07b0`. Widening to a prefix is monotone: only ever MORE tokens reach
  // `reflect`, never fewer.
  if (w.startsWith("reflect") || w.startsWith("dynamicmemberlookup")) return "reflect";
  if (w.startsWith("native")) return "native";
  if (w.startsWith("callback") || w.startsWith("closure") || w.startsWith("task-handoff")) return "indirect";
  if (w.startsWith("dispatch") || w.startsWith("indy") || w.startsWith("ambiguous")) return "dispatch";
  if (w.startsWith("missing-config") || w.startsWith("no-tsconfig") || w.startsWith("no-node_modules")) return "setup";
  return "unresolved"; // conservative catch-all
}

// ⟨0.24⟩ THE reason-class resolution — ONE copy, for the GATE (evaluatePolicy, over the scan's in-memory
// graph) and for the DISCLOSURE (`unverified --class`, over a loaded report). SPEC §6.2: "THE GATE AND THE
// DISCLOSURE MUST APPLY THE SAME RULE, AND SHOULD SHARE THE SAME CODE." They did not: the gate resolved
// transitively and the query open-coded a second, direct-only match — two implementations of one rule
// inside one engine, drifting because nothing compared them, and the consumer-side one under-reported the
// very holes the verb exists to name. Measured before the repair, `--class dynamic` (an alias for every
// genuine class, so it must exclude NOTHING) against unfiltered `unverified`: 207→173 on this engine's own
// sources, 268→158 on execa, 64→21 on got. So: no second fixpoint, no second match rule.
//
// `unknownWhy` is DIRECT-ONLY by design (§4: a reason names a site in the function's OWN body), so a
// function whose Unknown is purely INHERITED carries no reason of its own — 24% of Unknown-bearing entries
// on this engine's sources and 57-58% on execa/got. Matching against the direct field reads a field that
// answers a different question.
export function resolveReasonClasses(functions, callgraph = {}) {
  const acc = new Map();
  // ⟨0.24⟩ THE REACH IS THE REPORT'S OWN, not the sidecar's. §2 embeds the call edges per entry (`calls`)
  // precisely so a consumer without the sidecar can reconstruct the graph, and rust (`reason_class_acc`),
  // java (`gateInputFromReport`: `edges…addAll(e.calls())`) and swift all resolve the reason classes over
  // THAT field. candor-ts read `<prefix>.callgraph.json` and nothing else, so a report whose sidecar was
  // deleted / never written / left behind in another workspace silently degraded to a DIRECT-ONLY
  // resolution — every inherited hole's class set came back empty, and the empty set then matched every
  // filter (see reasonClassesMatch). Two independent faults compounding into one wrong answer: `--class
  // unresolved` selected `b_reasoned_only`, whose Unknown its callee classified `dispatch`, which is the
  // literal outcome §6.2 requirement 3 forbids. Seeding from `calls` also makes the answer BYTE-IDENTICAL
  // with and without the sidecar, which is the property the other three engines have and this one lacked.
  // UNION rather than either-or: the sidecar can carry edges an older report's entries don't, and more
  // edges only ever ADD classes — the fail-closed direction for the gate that shares this resolution.
  const edges = new Map();
  const addEdge = (caller, callee) => {
    let s = edges.get(caller);
    if (!s) { s = new Set(); edges.set(caller, s); }
    s.add(callee);
  };
  for (const f of functions ?? []) for (const c of f.calls ?? []) addEdge(f.fn, c);
  for (const [caller, callees] of Object.entries(callgraph ?? {})) {
    for (const c of Array.isArray(callees) ? callees : []) addEdge(caller, c);
  }
  for (const f of functions ?? []) {
    const cs = new Set((f.unknownWhy ?? []).map(reasonClass));
    // ⟨0.24⟩ CONTRIBUTES, not "is treated as". A DIRECT Unknown the function did not name ADDS
    // `unresolved` HERE, at the node that owns the hole — never as a fallback on the JOINED set being
    // empty. Emptiness is not upward-closed, so the old absence-keyed default was REMOVED by acquiring a
    // second, classifiable reason: a caller of one reasonless dep was rejected by `Unknown[unresolved]`,
    // a caller of one reasoned dep was not, and a caller of BOTH — strictly worse-known than the first —
    // passed. Adding a call turned a red verdict green (the monotone-denial corollary).
    // Gated on a DIRECT Unknown (§6.2 req 3), never on the reason set merely being absent: absence is
    // also exactly what an INHERITED Unknown looks like, and tagging one of those `unresolved` when its
    // callee classified it perfectly well is the mirror fabrication.
    // candor-ts's own reports cannot reach this branch — its emitter already writes `["unresolved"]` on a
    // direct Unknown it could not name (scan.mjs), which is the same rule one layer earlier, at the source.
    // It fires for a FOREIGN report (java/rust/swift/an older build), which every query verb also reads.
    if ((f.direct ?? []).includes("Unknown") && !(f.unknownWhy ?? []).length) cs.add("unresolved");
    if (cs.size) acc.set(f.fn, cs);
  }
  // …then propagate over the call graph to a fixpoint, so `Unknown[reflect]` at a caller inheriting
  // Unknown from a reflect-caused callee still fires (matches java/rust reasonClassAcc).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [caller, callees] of edges) {
      for (const callee of callees) {
        const cc = acc.get(callee);
        if (!cc) continue;
        let set = acc.get(caller);
        if (!set) { set = new Set(); acc.set(caller, set); }
        for (const c of cc) if (!set.has(c)) { set.add(c); changed = true; }
      }
    }
  }
  return acc;
}

/** ⟨0.24⟩ The class MATCH, shared by the gate and `unverified --class`. `classes` = a fn's resolved class
 *  set (resolveReasonClasses); `filter` = the rule's / the flag's class tokens (an array or a Set). A null
 *  filter means no narrowing.
 *
 *  THE UNCLASSIFIABLE CASE PROJECTS TO `{unresolved}` — it is not "kept by every filter". §6.2: a hole
 *  nothing classified CONTRIBUTES `unresolved`, and `unresolved` is one class among six, so the hole is
 *  kept by `unresolved` and by `dynamic` (which names every genuine class) and dropped by `native`,
 *  `reflect`, `dispatch`, `indirect` and `setup` — the spec's own discrimination control says post-repair
 *  `--class native` selects 0. Byte-aligns with rust `reason_class_matches` (its None/empty arms both read
 *  `want.contains(Unresolved)`) and java `reasonClassesOf` (`Set.of(UNRESOLVED)`).
 *
 *  A blanket `return true` here was the mirror of the fail-open it replaced, and worse on two counts.
 *  (1) `setup`: `dynamic` deliberately EXCLUDES `setup` as non-genuine, so an entry matching `--class
 *  setup` because nothing classified it is doubly wrong. (2) It re-opened requirement 3 through the MATCH
 *  arm rather than the contribution: an inherited `Unknown` its callee classified `dispatch` was selected
 *  by `--class unresolved` whenever the reach could not be walked, which is the literal outcome §6.2
 *  forbids — and the requirement-3 gating in resolveReasonClasses, which is correct, cannot prevent it
 *  because the empty set never reaches that code. Measured cross-engine on identical bytes before the
 *  repair: `--class native` on an orphan-callee report gave rust/java/swift `[]` and ts `['app.orphan']`.
 *
 *  This is still the fail-CLOSED direction for the case that made a blanket keep tempting: a hole no
 *  filter would name is kept by the two filters an adopter narrows THROUGH (`unresolved`, `dynamic`),
 *  never dropped by all six. What it refuses is asserting a class the engine does not have evidence for. */
export function reasonClassesMatch(classes, filter) {
  if (!filter) return true;
  const has = filter instanceof Set ? (c) => filter.has(c) : (c) => filter.includes(c);
  if (!classes || classes.size === 0) return has("unresolved");
  for (const c of classes) if (has(c)) return true;
  return false;
}
// The literal surfaces `allow` can restrict. `Llm` ⟨0.13⟩ rides Net's host literal (SPEC §1) —
// `allow Llm <host…>` restricts which MODEL hosts a scope may reach, matched by hostname like Net.
const ALLOW_EFFECTS = new Set(["Net", "Exec", "Fs", "Db", "Llm"]);

// The §6.2 token separator: ASCII whitespace ONLY (space/tab/LF/VT/FF/CR). JS `\s`/`String.trim` strip
// Unicode spaces (NBSP, ideographic, …) that Java drops — a gateless-green cross-engine divergence
// (adversarial DSL review). A non-ASCII space stays part of its token → the rule is malformed, dropped.
const ASCII_WS = /[ \t\n\v\f\r]+/;
const ASCII_WS_TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
// ⟨0.19⟩ `aliases` (a Map name→class-token[], from `.candor/config` `unknown-alias`) lets an `Unknown[<name>]`
// filter resolve a user-defined name (SPEC §6.2). A config alias never changes what bare `deny E Unknown`
// means (always `Unknown[*]`), so a rule's denied set stays legible from the policy alone.
export function parsePolicy(text, aliases = null) {
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
      // Reason-class filter on an `Unknown` membership: empty ⇒ `Unknown[*]` (any reason — the bare
      // form); non-empty ⇒ only those classes. `*` = all; `dynamic` = every genuine class.
      const unknownClasses = new Set();
      let unknownStar = false;
      // Destination-class filter on a `Net` membership (NET-DESTINATION-CLASS-DESIGN.md): empty ⇒ `Net[*]`
      // (any destination — the bare form); non-empty ⇒ only those classes. `*` = all.
      const netClasses = new Set();
      let netStar = false;
      for (const tok of t.slice(1)) {
        const nm = /^Net\[(.*)\]$/.exec(tok);
        if (nm) {
          effects.push("Net");
          for (let cn of nm[1].split(",")) {
            cn = cn.trim();
            if (!cn) continue;
            if (cn === "*") netStar = true;
            else if (NET_DEST_CLASSES.includes(cn)) netClasses.add(cn);
            else warn(`unknown Net destination-class \`${cn}\` (known: ${NET_DEST_CLASSES.join(",")}, or *)`);
          }
          continue;
        }
        const m = /^Unknown\[(.*)\]$/.exec(tok);
        if (m) {
          effects.push("Unknown");
          for (let cn of m[1].split(",")) {
            cn = cn.trim();
            if (!cn) continue;
            if (cn === "*") unknownStar = true;
            else if (cn === "dynamic") DYNAMIC_CLASSES.forEach((c) => unknownClasses.add(c));
            else if (REASON_CLASSES.includes(cn)) unknownClasses.add(cn);
            else if (aliases && aliases.has(cn)) aliases.get(cn).forEach((c) => unknownClasses.add(c)); // ⟨0.19⟩ config unknown-alias
            else warn(`unknown reason-class/alias \`${cn}\` (known: ${REASON_CLASSES.join(",")}; aliases: dynamic,*, or a config \`unknown-alias\`)`);
          }
          continue;
        }
        if (EFFECTS.includes(tok) || tok === "Unknown") {
          effects.push(tok);
          if (tok === "Unknown") unknownStar = true; // bare Unknown ⇒ all classes
          if (tok === "Net") netStar = true;         // bare Net ⇒ all destinations
        } else { scope = tok; break; }
      }
      if (effects.length === 0) { warn("deny names no known effect"); continue; }
      // `*` (or bare Unknown) means all classes ⇒ empty filter (matches any Unknown).
      let uc = unknownStar ? [] : [...unknownClasses].sort();
      // `*` (or bare Net) means all destinations ⇒ empty filter (matches any Net).
      const nc = netStar ? [] : [...netClasses].sort();
      // A2 under-gating lint: a narrowed scope omitting `unresolved` (the catch-all for holes the engine
      // couldn't classify) may silently tolerate exactly those — flag it (advisory, non-fatal).
      if (uc.length && !uc.includes("unresolved"))
        console.error(`candor: policy rule narrows \`Unknown[…]\` but omits \`unresolved\` — may UNDER-gate on holes the engine couldn't classify; add \`unresolved\` (or use \`dynamic\`): ${line}`);
      deny.push({ effects: [...new Set(effects)].sort(), scope, unknownClasses: uc, netClasses: nc, raw: line }); // dedup: a set, like rust/java
    } else if (t[0] === "pure") {
      deny.push({ effects: [], scope: t[1] ?? "", unknownClasses: [], netClasses: [], raw: line });
    } else if (t[0] === "allow") {
      if (t.length < 3) { warn("allow names no values"); continue; }
      if (!ALLOW_EFFECTS.has(t[1])) { warn("allow supports only Net hosts / Llm hosts / Exec commands / Fs paths / Db tables"); continue; }
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
    // `Llm` ⟨0.13⟩ rides Net's host literal (SPEC §1) — matched by hostname exactly like Net.
    case "Llm":  return values.some((a) => hostPart(a) === hostPart(reached));
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
export function evaluatePolicy(pol, functions, callgraph, incomplete = new Map(), partners = new Set()) {
  const out = [];
  // `Llm` ⟨0.13⟩ reaches the SAME hosts surface as Net (an Llm host WAS captured as a Net host literal).
  const surfaces = { Net: "hosts", Llm: "hosts", Exec: "cmds", Fs: "paths", Db: "tables" };
  // §6.2 ⟨0.19⟩: `reasonClass` (all classes on the fn) rides an AS-EFF-006 Unknown violation; ⟨0.20⟩ `netClass`
  // (all destination classes on the fn) rides a Net violation. Both omitted when empty (byte-identical verdict).
  const push = (rule, fn, effects, detail, reasonClass, netClass) => {
    const rec = { rule, fn, effects, detail };
    if (reasonClass && reasonClass.length) rec.reasonClass = reasonClass;
    if (netClass && netClass.length) rec.netClass = netClass;
    out.push(rec);
  };
  // Reason-scoped Unknown: the Unknown reason CLASS travels the call graph the same way the Unknown
  // EFFECT does. ONE copy of that resolution, shared with the disclosure side — see resolveReasonClasses.
  const reasonAcc = resolveReasonClasses(functions, callgraph);
  for (const f of functions) {
    for (const r of pol.deny) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      // `pure` (empty forbidden set) forbids every EFFECT — not `Unknown`, which is the §4 trust
      // marker, not an effect (AS-EFF-003's concern; `deny Unknown <scope>` is the explicit knob).
      // The reference engine (candor-java) and the rust deep engine exclude it identically; candor-ts
      // wrongly counted an Unknown-only fn as a `pure` violation until 2026-07-09.
      const hits = r.effects.length === 0
        ? f.inferred.filter((e) => e !== "Unknown")
        : f.inferred.filter((e) => r.effects.includes(e));
      // Reason-scoped Unknown: a `deny E Unknown[classes]` keeps its Unknown hit only for a fn whose
      // TRANSITIVE reason classes include one of those. Same rule object as `unverified --class`.
      let kept = hits;
      if (hits.includes("Unknown") && (r.unknownClasses?.length)
          && !reasonClassesMatch(reasonAcc.get(f.fn), r.unknownClasses)) kept = hits.filter((e) => e !== "Unknown");
      // Net destination-class: a `deny Net[dest…]` keeps its Net hit only for a fn reaching one of those
      // destination classes; else tolerate (only asserted-safe destinations). Fail-closed: a masked surface /
      // a Net with no visible host is unknown-host (netClassesOf). The class travels the call graph via
      // f.hosts + f.incomplete, both propagated transitively before the gate (scan.mjs).
      if (kept.includes("Net") && (r.netClasses?.length)) {
        const fnNet = netClassesOf(f.hosts ?? [], incomplete.get(f.fn)?.has("Net") ?? false, partners);
        if (!fnNet.some((c) => r.netClasses.includes(c))) kept = kept.filter((e) => e !== "Net");
      }
      if (kept.length) {
        // When Unknown is denied, report ALL reason classes on the fn (transitive) — every reason the gate bit.
        const rc = kept.includes("Unknown") ? [...(reasonAcc.get(f.fn) ?? [])].sort() : undefined;
        // ⟨0.20⟩ when Net is denied, report ALL of the fn's destination classes (transitive).
        const ncv = kept.includes("Net")
          ? netClassesOf(f.hosts ?? [], incomplete.get(f.fn)?.has("Net") ?? false, partners)
          : undefined;
        push("AS-EFF-006", f.fn, kept, `\`${f.fn}\` performs { ${kept.join(", ")} }, forbidden by policy: \`${r.raw}\``, rc, ncv);
      }
    }
    for (const r of pol.allow) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      if (!f.inferred.includes(r.effect)) continue;
      const reached = f[surfaces[r.effect]] ?? [];
      // An INCOMPLETE surface (a structurally-invisible reach — a host-establishing call with a runtime/
      // invisible host) can't be certified even with visible hosts, else a benign literal masks the
      // invisible forbidden endpoint (the masking evasion). Matches candor-java 0.5.29 / candor-rust.
      // `Llm` ⟨0.13⟩ rides the Net host literal (SPEC §1), so a runtime/masked host that makes the Net
      // surface incomplete must fail-close `allow Llm …` identically (java parity #3): a benign visible
      // model host must not certify a scope that also reaches a hidden one.
      const surfaceIncomplete = incomplete.get(f.fn)?.has(r.effect)
        || (r.effect === "Llm" && incomplete.get(f.fn)?.has("Net"));
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

// ⟨0.19⟩ Discover `.candor/config` TEXT anchored at `fromDir`: $CANDOR_CONFIG if set + readable, else the
// nearest `.candor/config` walking UP, else null. Read-only + lenient (the caller decides fail-closed).
export function discoverConfigText(fromDir) {
  const env = process.env.CANDOR_CONFIG;
  if (env) { try { return fs.readFileSync(env, "utf8"); } catch { return null; } }
  let dir = nodePath.resolve(fromDir);
  for (;;) {
    const cand = nodePath.join(dir, ".candor", "config");
    if (fs.existsSync(cand)) { try { return fs.readFileSync(cand, "utf8"); } catch { return null; } }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ⟨0.19⟩ Parse `unknown-alias <name> = <class,…>` lines (SPEC §6.2) into a Map name→class-token[]. A name
// that shadows a built-in (`*`/`dynamic`/a class token) is warned-and-skipped, as is a no-valid-class def.
// Byte-shape with the java `Config.addAlias` / rust `parse_unknown_aliases`.
export function parseUnknownAliases(configText) {
  const out = new Map();
  if (!configText) return out;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m || m[1].toLowerCase() !== "unknown-alias") continue;
    const eq = m[2].indexOf("=");
    if (eq < 0) { console.error(`candor: ignoring \`unknown-alias\` (want \`unknown-alias <name> = <class,…>\`): ${m[2]}`); continue; }
    const name = m[2].slice(0, eq).trim();
    if (!name || name === "*" || name === "dynamic" || REASON_CLASSES.includes(name)) {
      console.error(`candor: ignoring \`unknown-alias\` with reserved/empty name \`${name}\` (may not shadow \`*\`/\`dynamic\`/a class token)`);
      continue;
    }
    const classes = new Set();
    for (let cn of m[2].slice(eq + 1).split(",")) {
      cn = cn.trim();
      if (!cn) continue;
      if (cn === "dynamic") DYNAMIC_CLASSES.forEach((c) => classes.add(c));
      else if (REASON_CLASSES.includes(cn)) classes.add(cn);
      else console.error(`candor: \`unknown-alias ${name}\` names unknown reason-class \`${cn}\` — skipped`);
    }
    if (classes.size === 0) console.error(`candor: ignoring \`unknown-alias ${name}\` — no valid reason-class`);
    else out.set(name, [...classes]);
  }
  return out;
}

// ⟨0.20⟩ Parse `net-partner <host>` lines (NET-DESTINATION-CLASS-DESIGN.md) into a Set of host-normalized
// partner hosts — the per-project `known-partner` set for the Net destination-class classifier. Multi-value
// (repeatable key); the value's `:port` is stripped + lowercased like MODEL_HOSTS. Case-insensitive key,
// mirroring parseUnknownAliases + the java/rust config loaders. A partner is per-project — never universal.
export function parseNetPartners(configText) {
  const out = new Set();
  if (!configText) return out;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m || m[1].toLowerCase() !== "net-partner") continue;
    const val = m[2].trim();
    if (val) out.add(hostPart(val).toLowerCase());
  }
  return out;
}
