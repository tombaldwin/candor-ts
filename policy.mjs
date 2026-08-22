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

// ⟨0.33⟩ THE UNIT IDENTITY, AS A PLUGGABLE POLICY — `units`, threaded through every function on this page
// that keys an accumulator by a function.
//
// It exists because a MULTI-REPORT gate must join by `hash` and never by bare `fn` (SPEC §2.2: "names may
// legitimately repeat across packages"), and this engine joined by `fn`. Measured on candor-ts at spec
// 0.31: `gate --report` over member `a` REFUSED a scoped rule at exit 2, and gating that same member
// beside an unrelated sibling exited 0 with `policy ✓` — a false green produced by ADDING a report. The
// harm is not effects merging (union can only add violations); it is REASONS merging, because a reason
// set is what makes an `Unknown` ANSWERABLE. `a`'s reasonless Unknown borrowed `b`'s `callback:` class,
// the filter saw a class the rule does not deny, and tolerated: "I cannot say" became "I checked".
//
// AND THE KEY SWAP CANNOT BE MADE ALONE, which is why the identity is a PARAMETER rather than a hardcoded
// `e.hash`. A policy SCOPE is written against the NAME (`deny Exec app::`) and the verdict ROW must print
// the NAME (§3.3.1 byte-equality with `scan --policy`), so a key that is not a name has to travel BESIDE
// the name, never instead of it. Keying by hash without that separation is a false green introduced while
// fixing a false green — the shape where killing an over-charge introduces a silent under-report. Hence
// the split landing: this identity is plumbed and verified a NO-OP first, and only then swapped.
//
// `identityUnits()` is the SCAN route's identity and the default everywhere: a scan gates ONE analysis
// world, its keys are already names, so that route cannot change behaviour by construction.
export const AMBIGUOUS = Symbol("candor:ambiguous-callee");

export function identityUnits() {
  return {
    key: (e) => e?.fn,
    /** A callee/caller NAME resolved to a unit key, `AMBIGUOUS`, or null. Under identity a name IS a key. */
    resolveCall: (_callerKey, name) => name,
    /** Every unit key declaring `name`. Under identity, the name itself. */
    unitsNamed: (name) => [name],
  };
}

/** `units.key` with the identity default applied, for the sites that take `units` as an option. */
const unitKey = (units, e) => (units ? units.key(e) : e?.fn);

/**
 * ⟨0.33⟩ The effect set the GATE reads for one entry: the report's `inferred`, plus `Unknown` when the
 * merge could not resolve one of this entry's callee names (see `reportUnits`). An unresolvable callee
 * means the transitive set on the wire cannot be completed here, and `Unknown` is what this family says
 * about a reach it cannot follow. Never subtracts.
 */
export function effectiveInferred(f, reasonAcc, units = null) {
  const inf = f?.inferred ?? [];
  const amb = reasonAcc?.ambiguous;
  if (!amb || amb.size === 0 || inf.includes("Unknown")) return inf;
  return amb.has(unitKey(units, f)) ? [...inf, "Unknown"] : inf;
}
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
export function resolveReasonClasses(functions, callgraph = {}, units = null) {
  const U = units ?? identityUnits();
  const acc = new Map();
  // ⟨0.33⟩ the units whose OWN callee name the merge could not resolve — see the contribution below.
  const ambiguous = new Set();
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
  // ⟨0.33⟩ NODES AND EDGES. `calls` names a callee by BARE `fn`, so keying the accumulators by a unit key
  // while joining the EDGES by name leaves the same defect one layer down — harder to see, because the
  // node table looks right. Every edge endpoint therefore goes through `units.resolveCall`, which is
  // identity on the scan route and the hash join on the report route.
  const link = (callerKey, name) => {
    const r = U.resolveCall(callerKey, name);
    // AMBIGUOUS: two or more units declare this name and nothing here can say which is meant. Dropping
    // the edge is right — picking would invent a reach — but dropping it SILENTLY is not, and that was
    // measured on candor-rust: the caller lost the reason class it would have inherited, stayed
    // ANSWERABLE through a reason of its own, and a RED verdict went GREEN by adding a report. So the
    // ambiguity is CONTRIBUTED at the caller's entry instead (below), before the fixpoint.
    if (r === AMBIGUOUS) { ambiguous.add(callerKey); return; }
    if (r != null) addEdge(callerKey, r);
  };
  for (const f of functions ?? []) {
    const ck = U.key(f);
    for (const c of f.calls ?? []) link(ck, c);
  }
  for (const [caller, callees] of Object.entries(callgraph ?? {})) {
    // The SIDECAR's caller is a NAME too, and it takes the SAME rule rather than a carve-out: one unit
    // declaring it resolves, several means the edge cannot be attributed and each candidate carries the
    // ambiguity. Attaching it to all of them would be the name join again, in the caller direction —
    // and that direction is the harmful one, since a borrowed class is what makes an Unknown answerable.
    // A name no entry declares keeps a key of its own (`unitsNamed` returns it), so an intermediate hop
    // the report omits as effect-free still carries classes through, exactly as it did before.
    const ckeys = U.unitsNamed(caller);
    if (ckeys.length === 1) {
      for (const c of Array.isArray(callees) ? callees : []) link(ckeys[0], c);
    } else if (ckeys.length > 1) {
      for (const k of ckeys) ambiguous.add(k);
    }
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
    if (cs.size) acc.set(U.key(f), cs);
  }
  // ⟨0.33⟩ …and the AMBIGUITY CONTRIBUTES, exactly as the reasonless Unknown above it does — at the
  // caller's own entry, before the fixpoint. `dispatch` is the right class by the vocabulary's own
  // definition ("unresolved virtual/dynamic dispatch, SAME-NAME AMBIGUITY"), and it is evidence THIS
  // merge holds — it saw two declarers — never a class borrowed from another function's body, so it
  // cannot make some other function's Unknown answerable, which is what the original defect did.
  for (const k of ambiguous) {
    let s = acc.get(k);
    if (!s) { s = new Set(); acc.set(k, s); }
    s.add("dispatch");
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
  // ⟨0.33⟩ The unresolvable-callee set rides the accumulator NON-ENUMERABLY (the `zeroMatch` precedent
  // below), so every existing caller keeps a plain `Map` and nothing that serializes one acquires a field
  // the spec has not pinned. `effectiveInferred` is the only reader.
  Object.defineProperty(acc, "ambiguous", { value: ambiguous, enumerable: false });
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
// The two effect-position vocabularies, as sorted arrays. `deny`'s is every effect plus the §4 trust
// marker; `allow`'s is the CLOSED set of effects that carry a literal surface a value list can restrict.
const EFFECT_VOCAB = [...EFFECTS, "Unknown"].sort();
const ALLOW_VOCAB = [...ALLOW_EFFECTS].sort();
const ALLOW_FORM = ["allow <Effect> [in <scope>] <value…>"];

// The §6.2 token separator: ASCII whitespace ONLY (space/tab/LF/VT/FF/CR). JS `\s`/`String.trim` strip
// Unicode spaces (NBSP, ideographic, …) that Java drops — a gateless-green cross-engine divergence
// (adversarial DSL review). A non-ASCII space stays part of its token → the rule is malformed, dropped.
const ASCII_WS = /[ \t\n\v\f\r]+/;
const ASCII_WS_TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
// ⟨0.19⟩ `aliases` (a Map name→class-token[], from `.candor/config` `unknown-alias`) lets an `Unknown[<name>]`
// filter resolve a user-defined name (SPEC §6.2). A config alias never changes what bare `deny E Unknown`
// means (always `Unknown[*]`), so a rule's denied set stays legible from the policy alone.
//
// ⟨0.24⟩ RETURNS `errors` AND `aliasesUsed` BESIDE THE RULES (SPEC §6.2 `382a7e0`/`be0b9a9`, §3.1 `99eb4e9`).
// The rule objects are UNCHANGED — a token this parser cannot honour is still recorded in the rule exactly
// as before, so `parsepolicy` can still show what was written — but an UNRECOGNISED VALUE TOKEN now lands
// in `errors`, and every verdict-bearing call site refuses (exit 2) instead of running a policy it silently
// rewrote. Measured on this engine before the change, over a report whose only `Unknown` is reflect-caused:
//
//   deny Unknown[dispatch,nativ] app         -> exit 0, rule kept as `Unknown[dispatch]`      NARROWS
//   deny Net[known-partner,unkown-host] app  -> exit 0, rule kept as `Net[known-partner]`     NARROWS
//   deny Unknown[corp] app                   -> exit 1, rule kept as bare `deny Unknown`      WIDENS
//
// The NARROWING half is the fail-open and it is the common case — a typo lands beside correct tokens far
// more often than alone — and the rule stops gating what the operator spelled while the gate still looks
// armed. The WIDENING half is loud but announces "ignoring policy rule" and then KEEPS a DIFFERENT rule,
// which is a false disclosure. Neither is a policy the operator wrote.
//
// ⟨0.24⟩ AND `errors` COVERS EVERY LINE THIS PARSER DID NOT HONOUR, NOT ONLY UNRECOGNISED TOKENS (SPEC §3.1
// `195d45a`). Measured against the reference engine on the conformance battery: java reported 12, candor-ts
// 5 — the seven missing were LINES DROPPED WHOLE (an unknown effect name, an `allow` on an effect that
// takes no operand, two malformed `forbid`s, two `allow`s naming no values, an unknown rule kind), each
// warned on stderr and invisible to the machine output. **A dropped rule is the LIMIT CASE of "silently
// rewritten into a different policy": the rewritten policy is the one without that line**, which is a
// BIGGER rewrite than a narrowed filter, not a smaller one. The witness was disclosing the two cases that
// prompted the clause and silent on the ones that did not.
export const POLICY_ERROR_KINDS = ["reason-class/alias", "Net destination-class", "effect-name", "rule-kind"];
// ⟨0.24⟩ FATAL vs DISCLOSED-ONLY. `errors` is ONE list because §3.1 pins one list, but it carries two
// populations and only the verdict-bearing call sites need the distinction, so it is derived from `kind`
// rather than stored.
//
// ⟨0.24⟩ `effect-name` IS FATAL (SPEC §6.2 `1e1748a`) — a typo'd EFFECT NAME deleted the rule, silently,
// four-way green. Measured on all four engines:
//
//     deny Nett app             ->  rust 0  ts 0  java 0  swift 0    the rule is DELETED, the gate is green
//     allow Nett host.example   ->  rust 0  ts 0  java 0  swift 0    the certification silently vanishes
//
// The operator reads an armed `deny Net`; there is no gate at all. This engine already called a dropped
// rule the LIMIT CASE of silently rewriting the policy — a BIGGER rewrite than a narrowed filter — and the
// bigger one was warning-only while the smaller one was exit 2. The grammar defence for leaving it open is
// real but narrower than it was taken to be, and the two conditions that escape it are exactly the ones
// that raise this kind:
//   · `allow`'s effect position is a FIXED, CLOSED set with no scope reading available, so a token outside
//     it is unambiguously a typo (and `allow Clock …` is the same shape: an effect carrying no literal
//     surface a value list could restrict);
//   · a `deny` whose effect list ends up EMPTY after scope-splitting is malformed under either reading —
//     there is no legitimate policy it could be — so refusing loses nothing.
// What stays open, deliberately, is the genuinely ambiguous middle: a `deny` with at least one valid effect
// and an unrecognised trailing token that MIGHT be a scope (`deny Net Exex app`). `parsepolicy` reports it
// either way, so the operator can always see it.
//
// `rule-kind` stays DISCLOSED-ONLY: `195d45a` is explicit that reporting a dropped line is "additive to the
// witness and silent about the gate", and a malformed `forbid` or an unknown rule kind has no closed
// vocabulary to be measured against — that would be a grammar change, not a token change.
const FATAL_ERROR_KINDS = new Set(["reason-class/alias", "Net destination-class", "effect-name"]);
export const fatalPolicyErrors = (errors) => (errors ?? []).filter((e) => FATAL_ERROR_KINDS.has(e.kind));
// The accepted sets, as ARRAYS (SPEC §3.1 `901f14d`: `accepted` is an array of tokens, not prose — a prose
// string is unparseable by the consumer the field exists for).
const REASON_VOCAB = [...REASON_CLASSES, "dynamic", "*"];
const RULE_KIND_VOCAB = ["deny", "pure", "forbid", "only", "allow"];
const DROPPED = (why) => `policy line NOT HONOURED — DROPPED (${why}); it is absent from the parse, so the `
                       + `policy that ran is the one without it`;

export function parsePolicy(text, aliases = null) {
  const deny = [], allow = [], forbid = [], only = [];
  // ⟨0.24⟩ every line this parser could not honour AS WRITTEN, and every alias a rule RESOLVED THROUGH.
  // `aliasesUsed` is recorded at the point of USE, never from the alias map: a config defining ten aliases
  // the policy never mentions moved nothing, and naming it would train the reader to skip the field.
  //
  // THE ENTRY SHAPE IS PINNED (SPEC §3.1 `195d45a` + `901f14d`): `{kind, token, accepted, rule, message}`,
  // `kind` drawn from the closed POLICY_ERROR_KINDS, `accepted` an ARRAY, `rule` the source line verbatim.
  // This engine emitted `vocabulary` for `kind`, `where` for `rule`, prose for `accepted`, and no `message`
  // at all — three renamed/reshaped fields on the one output whose whole job is to be diffed.
  const errors = [], aliasesUsed = new Map();
  // ⟨0.28⟩ SPEC §6.2 — **THE CONDITION IS A DROPPED LINE, NOT AN EMPTY POLICY.** The zero-rule refusal
  // fires only at ZERO survivors, so the discontinuity was stark and the wrong way round: 0 of 10 rules
  // parsing refused at exit 2, while 1 of 10 wrote `{"ok": true, "violations": []}` at exit 0 and said
  // NOTHING about the nine gates that were never asked. A 90%-gateless green, arriving at every fraction
  // below 100%. Refusal is the wrong remedy there — it would break the forward-compatibility leniency
  // §6.2 has just finished defending — so DISCLOSURE is: the verdict document carries the lines the
  // parse dropped, and a machine consumer can see that the gate it is reading is smaller than the gate
  // that was written.
  //
  // `{line, text, reason}` exactly: `line` 1-based over the normalized split (a bare `\r` breaks a line
  // here, as it does for the parse), `text` the source line VERBATIM — before comment-stripping and
  // trimming, unlike `rule`, because the operator matches it against their file — and `reason` the SAME
  // sentence the stderr channel carries.
  //
  // BUILT IN `err`, not as a second pass, so it cannot drift from the list it is derived from. FATAL
  // errors are excluded: a fatal error (a typo'd effect token, `deny Nett app`) is a policy ERROR that
  // refuses the whole run at exit 2, and a refused run has no verdict for a dropped line to have shrunk.
  // A SEPARATE list rather than two new fields on `errors`, because that entry shape is PINNED (§3.1
  // `195d45a`/`901f14d`) and `parsepolicy`'s witness output is diffed across engines byte for byte.
  const ignored = [];
  let lineNo = 0, rawLineText = "";
  const err = (kind, token, accepted, rule, message) => {
    errors.push({ kind, token, accepted, rule, message });
    if (!FATAL_ERROR_KINDS.has(kind)) ignored.push({ line: lineNo, text: rawLineText, reason: message });
  };
  // Split LINES on \n / \r\n / bare \r — the three forms Java's Files.readAllLines (the reference parser)
  // breaks on. Splitting on \n ONLY let a classic-Mac (bare-\r) file collapse to one line: \r is also an
  // in-line ASCII-ws token separator (below), so every rule after the first was glued into the first rule's
  // tokens and dropped — a gateless-green divergence (sweep [16]/[17]). \v/\f stay in-line separators.
  for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    lineNo++; rawLineText = rawLine;   // ⟨0.28⟩ the source position `ignored` reports (see `err`)
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
            else err("Net destination-class", cn, [...NET_DEST_CLASSES, "*"], line,
                     `unknown Net destination-class \`${cn}\` (known: ${NET_DEST_CLASSES.join(", ")}, or *)`);
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
            else if (aliases && aliases.has(cn)) { aliasesUsed.set(cn, [...aliases.get(cn)].sort()); aliases.get(cn).forEach((c) => unknownClasses.add(c)); } // ⟨0.19⟩ config unknown-alias
            else err("reason-class/alias", cn, REASON_VOCAB, line,
                     `unknown reason-class/alias \`${cn}\` (known: ${REASON_CLASSES.join(", ")}; aliases: `
                     + "dynamic, *, or a config `unknown-alias`)");
          }
          continue;
        }
        if (EFFECTS.includes(tok) || tok === "Unknown") {
          effects.push(tok);
          if (tok === "Unknown") unknownStar = true; // bare Unknown ⇒ all classes
          if (tok === "Net") netStar = true;         // bare Net ⇒ all destinations
        } else { scope = tok; break; }
      }
      if (effects.length === 0) {
        warn("deny names no known effect");
        err("effect-name", t[1] ?? "", EFFECT_VOCAB, line, DROPPED("names no known effect"));
        continue;
      }
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
      if (t.length < 3) {
        warn("allow names no values");
        // `token` is EMPTY, not the line's remainder: nothing here was UNRECOGNISED — the line is
        // truncated, so there is no offending token to name and inventing one would misdirect the reader.
        err("rule-kind", "", ALLOW_FORM, line, DROPPED("allow names no values"));
        continue;
      }
      if (!ALLOW_EFFECTS.has(t[1])) {
        warn("allow supports only Net hosts / Llm hosts / Exec commands / Fs paths / Db tables");
        err("effect-name", t[1], ALLOW_VOCAB, line,
            DROPPED("allow supports only Net hosts / Llm hosts / Exec commands / Fs paths / Db tables"));
        continue;
      }
      let scope = "", vi = 2;
      if (t[2] === "in") { scope = t[3] ?? ""; vi = 4; }
      const values = t.slice(vi);
      if (values.length === 0) {
        warn("allow names no values");
        err("rule-kind", "", ALLOW_FORM, line, DROPPED("allow names no values"));
        continue;
      }
      allow.push({ effect: t[1], scope, values: [...new Set(values)].sort(), raw: line }); // dedup (set)
    } else if (t[0] === "forbid") {
      // Token-wise like the Rust/JVM parsers: the arrow must be its own whitespace-separated token
      // (`a->b` glued is malformed), and tokens past `b` are ignored. A regex here once accepted and
      // rejected DIFFERENT lines than the other engines — the one thing a shared gate must not do.
      const [a, arrow, b] = [t[1] ?? "", t[2] ?? "", t[3] ?? ""];
      if (!a || arrow !== "->" || !b) {
        warn("malformed forbid (want `forbid <scope> -> <scope>`)");
        err("rule-kind", t.slice(1).join(" "), ["forbid <scope> -> <scope>"], line,
            DROPPED("want `forbid <scope> -> <scope>`"));
        continue;
      }
      forbid.push({ from: a, to: b, raw: line });
    } else if (t[0] === "only") {
      // ⟨0.29⟩ THE PERMISSION FORM. Token-wise like its `forbid` sibling above — the arrow must be its own
      // token — but everything AFTER the arrow is a permitted scope, so this takes a LIST where `forbid`
      // takes one destination and ignores the tail. An EMPTY tail is dropped rather than read as "A may
      // reach nothing at all": that is a different rule, and one far likelier typed by accident than meant.
      const from = t[1] ?? "", arrow = t[2] ?? "", to = t.slice(3).filter(Boolean);
      if (!from || arrow !== "->" || !to.length) {
        warn("malformed only (want `only <scope> -> <scope> [<scope> …]`)");
        err("rule-kind", t.slice(1).join(" "), ["only <scope> -> <scope> [<scope> …]"], line,
            DROPPED("want `only <scope> -> <scope> [<scope> …]`"));
        continue;
      }
      only.push({ from, to, raw: line });
    } else {
      warn("unknown rule kind");
      err("rule-kind", t[0], RULE_KIND_VOCAB, line, DROPPED(`unknown rule kind \`${t[0]}\``));
    }
  }
  // ⟨0.24⟩ `aliasesUsed` is name -> THE CLASSES IT RESOLVED TO, not a bare name list (SPEC §3.1
  // `b4e9155`): naming the source without the content leaves a reader knowing they were affected and not
  // how. Key order is sorted so the disclosure is deterministic across runs and across the two routes.
  //
  // ⟨0.24⟩ THIS IS THE OBJECT FORM AND IT IS DELIBERATE — a measured three-to-one divergence, KEPT.
  // candor-ts emits `policyVocabulary.aliases` as `{"corp": ["reflect"]}` where rust, java and swift emit
  // the ARRAY `["corp"]`; conformance R9's shape walk was blind one level down and scored all four OK.
  // The object stands, on `b4e9155`'s own argument rather than on preference:
  //
  //   · The clause's SHAPE is `{ "config": "<path>", "aliases": { … } }` — braces, i.e. an object. The
  //     array is a departure from the written pin, not the pin.
  //   · Its ARGUMENT is decisive and is about the array, one level down. It rejects swift's
  //     `configSources: [path]` because that "names the file but drops the alias names, and the file is
  //     the lesser half — an operator reading a verdict changed by an ambient definition needs to see WHAT
  //     THE DEFINITION WAS, not merely that one existed. A disclosure that names the source but not the
  //     content leaves the reader knowing they were affected and not how." `aliases: ["corp"]` fails that
  //     sentence for exactly the same reason `configSources` does: it names the alias and drops the
  //     definition. And the definition is the whole of what moved the verdict — `corp = reflect` and
  //     `corp = reflect,native` gate differently under one unchanged policy line, so a reader who sees
  //     only the NAME cannot tell which gate ran.
  //   · The object is a strict superset: `Object.keys(aliases)` recovers the array exactly, so nothing a
  //     consumer of the array form can do is lost.
  //
  // Being outnumbered is not the argument against it, and this family has twice found the outlier to be
  // the correct one on `gate --report` questions. Recorded for the spec to adjudicate.
  // ⟨0.28⟩ `ignored` rides the parse beside `errors` (SPEC §6.2) — see the note on `err`. The gate routes
  // spread it onto the verdict document; `parsepolicy`'s pinned witness shape is untouched.
  return { deny, allow, forbid, only, errors, ignored,
           aliasesUsed: Object.fromEntries([...aliasesUsed.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) };
}

// ⟨0.24⟩ The ONE rendering of the unreadable-policy posture (SPEC §6.2), so the wording cannot drift
// between the scan gate, `gate --report`, `whatif`, `fix-gate`, `unverified` and `parsepolicy`. Returns the
// human line; the caller prints it, writes the ⟨0.24⟩ refusal document and exits 2.
export function policyErrorText(policyFile, errors) {
  const head = `candor-ts: policy ${policyFile} cannot be honoured AS WRITTEN`;
  const body = errors.map((e) =>
    `  unknown ${e.kind} \`${e.token}\` (known: ${e.accepted.join(", ")})\n    in: ${e.rule}`).join("\n");
  // ⟨0.24⟩ the tail is written for the population actually present. A VALUE-token typo rewrites a rule;
  // an EFFECT-name typo DELETES it — different harms, and the alias remedy applies only to the first.
  const dropped = errors.filter((e) => e.kind === "effect-name");
  const tail = dropped.length === errors.length
    ? "  Refusing (exit 2), policy NOT evaluated: the rule names no effect this engine knows, so honouring "
      + "the policy as written would mean DROPPING the line — and the policy that then runs is the one "
      + "without it, which is a bigger rewrite than a narrowed filter, not a smaller one.\n"
      + "  Fix the spelling. (`allow` takes only Net/Llm hosts, Exec commands, Fs paths or Db tables.)"
    : "  Refusing (exit 2), policy NOT evaluated: dropping the token would rewrite the policy into a "
      + "DIFFERENT one. If it is the list's only token the rule WIDENS to the bare effect; if it sits beside "
      + "valid tokens the rule NARROWS and stops gating what you spelled, while the gate still looks armed.\n"
      + "  Fix the spelling, or define it in `.candor/config` as `unknown-alias <name> = <class,…>`.";
  return `${head} — ${errors.length} line(s) it cannot honour:\n${body}\n` + tail;
}

// ⟨0.24⟩ THE `unevaluated` DISCLOSURE FOR A POLICY THIS ENGINE CANNOT HONOUR AS WRITTEN — one entry per
// RAW POLICY LINE (SPEC §3.1: "the RAW policy line, verbatim"), grouped because one line can carry two bad
// tokens. ONE builder, because BOTH gate routes emit it and §3.1 makes byte-equality between their
// documents the acceptance test: the scan route gained it first (a certain baseline regression must ride
// exit 1 with the refusal disclosed beside it) and `gate --report` has to say the same thing in the same
// bytes or the equality MUST breaks on the very change that repaired the precedence.
//
// The wording is written FOR THE DOCUMENT rather than reusing `policyErrorText`, which ends "Refusing
// (exit 2)" — true of a refusal document and FALSE beside a dominating violation, and a machine-consumer
// channel is exactly where a stale sentence about the exit code does damage.
export function policyErrorUnevaluated(errors) {
  const byLine = new Map();
  for (const e of errors) {
    if (!byLine.has(e.rule)) byLine.set(e.rule, []);
    byLine.get(e.rule).push(`\`${e.token}\` is not a recognised ${e.kind} (known: ${e.accepted.join(", ")})`);
  }
  return [...byLine.entries()].map(([rule, ts]) => ({ rule,
    why: `NOT EVALUATED — this line cannot be honoured as written: ${ts.join("; ")}. Dropping the token `
       + `would gate a DIFFERENT policy than the one spelled (alone the rule widens to the bare effect; `
       + `beside valid tokens it narrows while the gate still looks armed).` }));
}

// ⟨0.24⟩ …and the same for a policy that could not be READ at all. ONE sentence and one `unevaluated`
// entry for both gate routes: they had two different `reason` strings, so §3.1's byte-equality MUST was
// already broken for this cause and no test could see it (the equality row only exercises the UNHONOURABLE
// policy). `rule` names the WHOLE FILE, parenthesised so it cannot be mistaken for a policy line — an
// unreadable policy has no lines to name, and a consumer of a verdict where a certain violation DOMINATED
// this refusal must still be able to see from the DOCUMENT that the policy half of the gate never ran.
export function policyUnreadable(policyFile) {
  const shown = policyFile === "" ? "(configured empty)" : policyFile;
  const why = `policy ${shown} could not be read — the gate was NOT enforced from it`;
  return { why, unevaluated: [{ rule: `(entire policy ${shown} — unreadable, no rules parsed)`, why }] };
}

// ⟨0.28⟩ …and the same for a policy that READ PERFECTLY and yielded NO RULES AT ALL (SPEC §6.2). Same
// builder shape as `policyUnreadable` directly above, because it is the same clause reached through a
// different door: the harm §6.2 names for an unreadable file — "a typo'd policy path that runs green is a
// gate that silently passes everything" — arrives just as easily through a README that parses to nothing.
// `rule` names the WHOLE POLICY, parenthesised, the shape §3.1 pins for a policy with no lines to name
// (here there are lines, but none of them became a rule, so there is no rule text to quote).
export function policyZeroRules(policyFile) {
  const shown = policyFile === "" ? "(configured empty)" : policyFile;
  const why = `policy ${shown} yielded NO RULES — the gate was NOT enforced from it`;
  return { why, unevaluated: [{ rule: `(entire policy ${shown} — no rules parsed)`,
    why: `${why}. Every line was ignored, the file is empty, or it holds only comments; nothing was `
       + `evaluated, so no rule can have passed.` }] };
}

// ⟨0.24⟩ THE REFUSAL DOCUMENT (SPEC §3.1 `107755b`, carve-outs removed by `1503368`). A refusal used to
// write NO `--gate-json` document at all, so a CI wrapper reading that path unconditionally re-read THE
// PREVIOUS RUN'S document as current — a green file from yesterday's clean run, still on disk, is how a
// refusal becomes an all-clear. Deleting the path is not the fix either: a consumer that treats a missing
// file as "nothing to report" fails open by a different route.
//
// It MUST be fail-closed to a NAIVE reader: `ok: false` so a consumer keying only on `ok` lands on FAIL,
// `refused: true` so one keying on that learns why, and **NO `violations` KEY AT ALL** — the gate is making
// no claim about violations, and an empty array is precisely the claim it cannot make. ABSENT, not empty.
// `1503368`: no cause is exempt, including an unreadable policy — a stale green does not care why this run
// declined to overwrite it.
export function refusalVerdict(spec, reason, unevaluated = null) {
  const o = { spec, ok: false, refused: true, reason };
  if (unevaluated && unevaluated.length) o.unevaluated = unevaluated;
  return o;
}

/** §6.2 scope match: by NAME SEGMENT, last segment a prefix.
 * Segments split on BOTH "." and "::" — Rust/Java qualify with "::" while TS uses ".", and a shared
 * policy must match across engines (a `Foo::bar` scope authored against Rust was inert in TS before). */
// ⟨0.29⟩ SCOPE MATCHING FOR A PERMISSION, where the prefix rule below is FAIL-OPEN.
//
// `scopeMatches`'s last segment is a PREFIX of its name-segment, so `util` matches `utilities`. For
// deny/pure/forbid that widening is FAIL-CLOSED — a scope matching more forbids more — and it is why the
// rule exists. For the `to` list of an `only` rule it is the exact inverse: a permitted scope matching
// more PERMITS more, so the matcher that keeps every other rule kind safe silently widens the one form
// whose entire purpose is to fail safe. MEASURED on the shipped ⟨0.29⟩ implementation: `only model ->
// util` let `model.go` reach `utilities_untrusted.exfil` at `policy ✓`, while `forbid model -> util`
// charged AS-EFF-009 on the identical reach.
//
// The `from` side KEEPS the prefix rule: it selects which functions the rule BINDS, so matching more
// constrains more. Each side takes the matcher whose over-approximation errs toward the gate firing.
export function scopeMatchesPermitted(name, scope) {
  const segs = name.split(/[.:]+/).filter(Boolean);
  const parts = scope.split(/[.:]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > segs.length) return false;
  outer: for (let i = 0; i + parts.length <= segs.length; i++) {
    for (let k = 0; k < parts.length; k++) if (segs[i + k] !== parts[k]) continue outer;
    return true;
  }
  return false;
}

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

// ⟨0.24⟩ SPEC §3.1 — the REPORT route's Net destination classes, taken VERBATIM off the wire.
//
// `netClass` is already the TRANSITIVE set the producer derived (scan.mjs writes `netClassesOf([...rec
// .hosts], rec.incomplete.has("Net"), netPartners)` into every Net-bearing entry), so re-deriving it in a
// consumer is a §3.1 ⟨0.24⟩ re-classification with two live failure modes, in OPPOSITE directions:
//   · the producer's `.candor/config` `net-partner` list is NOT on the wire, so a host the producer
//     classified `known-partner` re-derives here as `unknown-host` — `deny Net[unknown-host]` fires on a
//     function the producing project asserted safe (a FABRICATED violation, and one whose evidence the
//     consumer cannot even see);
//   · the AS-EFF-008 masked-surface flag is not on the wire either, so an entry whose `netClass` says
//     `unknown-host` BECAUSE its host was runtime-computed re-derives from its one benign visible literal
//     and loses the `unknown-host` member — the fail-OPEN mirror, on the exact filter a hardening team
//     narrows through.
// TWO MODES, because the two report routes differ in ONE way that matters — whether a refusal channel
// exists downstream:
//   · DEFAULT (MCP `candor_gate`, LSP diagnostics): map only the entries that actually CARRY the field.
//     An entry without it falls back to the derivation, which is the fail-CLOSED reading (`netClassesOf`
//     floors an empty/masked surface at `unknown-host`) and keeps a pre-⟨0.20⟩ or foreign report gated
//     rather than silently un-narrowed. Neither surface can refuse a question, so a hedge beats a hole.
//   · `authoritative` (`gate --report`): map EVERY `Net`-bearing entry, to its `netClass` or to the EMPTY
//     set, so the derivation is unreachable and the report is the only source of the class — the §3.1
//     ⟨0.24⟩ MUST NOT taken literally. That verb REFUSES a scoped `deny Net[…]` over a `netClass`-less
//     entry (exit 2), so no gate DECISION rests on the empty set; what the mode additionally prevents is
//     the class list a BARE `deny Net` violation REPORTS being re-derived from `hosts` — asserting a
//     destination class the report never made, in a field a consumer reads as the producer's judgment.
export function reportNetClasses(functions, { authoritative = false, units = null } = {}) {
  const m = new Map();
  for (const f of functions ?? []) {
    const carried = Array.isArray(f.netClass) ? f.netClass : [];
    if (carried.length === 0 && !(authoritative && (f.inferred ?? []).includes("Net"))) continue;
    // ⟨0.33⟩ keyed by the UNIT, not by the bare name — two members of a workspace may legitimately share
    // one (SPEC §2.2), and merging their destination classes is the same borrowing the reason-class merge
    // was measured doing. A repeated KEY is one unit reported twice; UNION rather than overwrite — the
    // direction that cannot turn a violation into a pass (java `gateInputFromReport` merges the same way).
    const k = unitKey(units, f);
    const prev = m.get(k);
    m.set(k, prev ? [...new Set([...prev, ...carried])].sort() : carried);
  }
  return m;
}

// ⟨0.24⟩ MOVED HERE FROM query.mjs (SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST APPLY THE SAME RULE, AND
// SHOULD SHARE THE SAME CODE"). It lived beside `gate --report` because that is where it was written, and
// the consequence was measured on the two surfaces that have no exit code: `mcp.mjs` and `lsp.mjs` called
// `evaluatePolicy` with NO withhold predicate and no discloser, so BOTH directions of harm were live on the
// surface an agent trusts and no human reads. Same report, same policy, against the CLI:
//
//   deny Unknown[reflect] app   -> CLI exit 2 (refused);  MCP {"ok":true,"violations":[]}   FALSE ALL-CLEAR
//   deny Net[unknown-host] app  -> CLI exit 2 (refused);  MCP fires AND asserts
//                                                         "netClass":["unknown-host"] the report never carried
//
// The control (`deny Unknown app`) fires on both, so the channel was not simply dead — it was answering a
// narrowing question the report cannot answer, in whichever direction the missing evidence happened to fall.
// A helper that only one of three call sites can reach is a rule only one of them implements.
/**
 * ⟨0.24⟩ THE THIRD ANSWERABILITY CASE (SPEC §3.1) — a class-scoped `deny` over a report that cannot answer
 * the narrowing question. Returns the refusal message, or null when every scoped filter is answerable.
 *
 * A bare `deny Net` / `deny Unknown` asks a question the effect set alone answers. A SCOPED one —
 * `deny Net[unknown-host]`, `deny Unknown[dispatch]` — asks a second question ("…and is the destination /
 * the reason class one of THESE?") and NARROWS the gate on the answer. Where the report does not carry the
 * evidence, the field is simply absent, the matcher sees an empty set, nothing intersects, and the effect
 * is dropped from the violation: **the narrowing succeeds BECAUSE the evidence is missing**. Measured on
 * the reference engine — `deny Net[unknown-host]` over a `Net`-bearing entry with no `netClass` returned
 * exit 0 where bare `deny Net` returns 1, an absent optional field silently un-scoping a fail-closed gate.
 *
 * THE REFUSAL IS MINIMAL, and the minimality is the subtle half. §3.1 ⟨0.24⟩: a scoped `deny` is NOT
 * unanswerable merely because some datum is missing. The class set only ever GROWS as evidence arrives
 * (§6.2 CONTRIBUTES, never retracts) and `Reject` is upward-closed in it, so
 *   · if the classes determinable from the entry ALONE already INTERSECT the filter, the rule FIRES and the
 *     answer is certain — missing data could only have added more matches. That case never reaches here:
 *     it is `evaluatePolicy`'s ordinary path.
 *   · only where the determinable set is EMPTY does the rule fail to fire AND could the missing datum still
 *     make it fire. That, and only that, is refused.
 * A NON-empty set that does not intersect is answered (tolerated), because on the wire both fields are
 * total by construction for the entries this can reach: `netClass` is emitted for EVERY `Net`-bearing entry
 * and floored at `unknown-host`, and an in-scope `Unknown` always resolves — a DIRECT one CONTRIBUTES
 * `unresolved` at its own entry (resolveReasonClasses, §6.2 requirement 3) and an INHERITED one has the
 * callee that raised it in `calls`, because that callee carries `Unknown` and is therefore effectful and
 * present. So a non-empty set means the channel is carried and the producer's set is the whole answer.
 *
 * That entry-level CONTRIBUTION is also why this engine does not repeat the over-broad refusal the spec
 * records against candor-swift: a function whose direct `Unknown` names no reason is answerable here under
 * `deny E Unknown[unresolved]` — the class comes from the entry itself, with no transitive step — so it
 * FIRES rather than exiting 2.
 *
 * PER (RULE, FUNCTION), not per policy — §3.1's granularity ruling. A scoped rule whose own matches all
 * carry their evidence evaluates normally; only the rule that would have been silently narrowed is refused.
 *
 * ⟨0.24⟩ IT NO LONGER SHORT-CIRCUITS THE GATE (SPEC §3.1 `7271c69` + `5a8cf48`), and that is the whole of
 * this rung's precedence correction. It used to return the FIRST refusal message and the verb exited 2 on
 * the spot — so a policy carrying a firing `deny Fs` BESIDE one unanswerable scoped rule exited 2 and wrote
 * no `--gate-json` document at all, DELETING A CERTAIN VIOLATION from the machine-consumer channel. `Reject`
 * is upward-closed (PAPER3 Lemma 2): if a rule fires on evidence the report carries, however the
 * unanswerable rule would have resolved cannot un-reject it, so exit 1 is not merely fail-closed there, it
 * is CERTAIN — and it names the violation where exit 2 names nothing.
 *
 * So it now returns EVERY unanswerable (rule, function, effect) triple, as a disclosure that travels
 * ALONGSIDE a verdict rather than as the whole output, plus the `withhold` predicate `evaluatePolicy` needs
 * to keep the unevidenced pairs from FIRING (see the note on that parameter — flooring an empty class set
 * at `unresolved` is right for a matcher and wrong for a firing).
 */
// ── WHOLE-POLICY UNANSWERABLE KINDS ON A REPORT ROUTE (SPEC §3.1 ⟨0.24⟩ ANSWERABILITY) ────────────
// `forbid` and `allow` cannot be answered from a §2 report, so a route reading one must DISCLOSE them and
// evaluate what is left — never pass them to the matcher, and never drop them silently.
//
// WHY THIS IS A FUNCTION AND NOT A THIRD COPY. It lived inline in `query.mjs`'s `gate --report`, and the
// two OTHER report-reading routes in this package — the MCP `candor_gate` tool and the LSP diagnostics
// path — passed the WHOLE policy to `evaluatePolicy`. MEASURED on the real functions with
// `forbid model -> model`: with no callgraph sidecar (what `loadCallgraph` returns for a hand-copied
// `report.json`) the answer was `violations: 0, unevaluated: 0` — a SILENT GREEN, the false all-clear the
// rule exists to prevent; with a sidecar it EVALUATED the rule and returned an AS-EFF-009 violation. Both
// outcomes the MUST forbids, on the channel an agent reads, for any engine's report (`candor mcp` routes
// every engine's reports through here). The CLI had the rule and its two siblings did not — so the fix is
// one implementation with three callers, not three implementations that agree today.
//
// Returns { unevaluated, answerable, onlyUnanswerable }:
//   unevaluated       — [{rule, why}] to disclose on whatever channel the caller has
//   answerable        — the policy with these kinds REMOVED, safe to hand to evaluatePolicy
//   onlyUnanswerable  — true when nothing else remains, i.e. there is no verdict to stand beside the
//                       refusal and the route must refuse outright (⟨0.24⟩ §3.1 `1503368`: whole-policy
//                       granularity is not a licence to SUPPRESS a certain violation, so when other rules
//                       can still fire, they decide and these ride along disclosed)
export function wholePolicyUnanswerable(pol, verb = "this route") {
  const unevaluated = [];
  // ⟨0.29⟩ NO COUNT OF THE FILE'S RULES IN A ROW ABOUT ONE OF THEM. The `why` was phrased "this policy
  // has N `forbid` rule(s)", so with two `forbid` lines BOTH rows said "2" — a fact about the file,
  // attached to a row that is about one line of it, and the reader's obvious inference (that this row
  // covers all N) is false. It is a kind-level PREDICATE now, and the SUBJECT is the rule the caller
  // prints in front of it: `` `forbid a -> b` is a `forbid` rule, which … ``.
  //
  // `why` IS SELF-CONTAINED, and that is a decision about the CALLERS rather than about wording. Six
  // sites print one of these, and THREE of them print `why` alone — `query.mjs`'s advisory disclosure,
  // the LSP's fix path, and the MCP error, i.e. the agent channel. A predicate-style `why` ("is a
  // `forbid` rule, which …") reads correctly only where the caller happens to prefix the rule, so those
  // three would have lost the rule name entirely and read as fragments. Naming the rule HERE cannot be
  // got wrong by a caller added later; the two sites that used to prefix it drop their prefix.
  const forbidWhy = (raw) => `\`${raw.trim()}\` is a \`forbid\` rule, which ${verb} cannot evaluate — `
    + "a report's `calls` graph is not the evidence a NAME-matching dependency rule needs, and a report "
    + "MUST NOT be back-filled from its sidecar. Gate at scan time (candor-ts <src> --policy <file>).";
  const allowWhy = (raw) => `\`${raw.trim()}\` is an \`allow\` rule, which ${verb} cannot evaluate — `
    + "the AS-EFF-008 surface-completeness marker is not guaranteed to ride the wire, and an engine that "
    + "answered where its siblings refuse would have SPLIT THE VERB. Gate at scan time.";
  // ⟨0.29⟩ `only` IS AS UNANSWERABLE AS `forbid`, and for a STRICTER reason. Both match on NAME, which a
  // report's effect-relevant wire cannot settle — but `forbid` asks whether ONE named crossing is present,
  // while `only` asks whether EVERYTHING reached is on a list. A report that omits a crossing makes
  // `forbid` read green; it makes `only` read green as a claim of COMPLETENESS.
  const onlyWhy = (raw) => `\`${raw.trim()}\` is an \`only\` rule, which ${verb} cannot evaluate — it `
    + "asks whether EVERYTHING a scope reaches is on a list, and a report carries an effect-relevant call "
    + "surface rather than the complete dependency graph a NAME-matching rule needs. Answering it here "
    + "would certify completeness from evidence that is not complete. Gate at scan time.";
  for (const r of pol.forbid ?? []) unevaluated.push({ rule: r.raw, why: forbidWhy(r.raw) });
  for (const r of pol.only ?? []) unevaluated.push({ rule: r.raw, why: onlyWhy(r.raw) });
  for (const r of pol.allow ?? []) unevaluated.push({ rule: r.raw, why: allowWhy(r.raw) });
  return {
    unevaluated,
    // REMOVED from the answerable policy, not merely disclosed beside it: a kind left in the object is a
    // kind `evaluatePolicy` walks, and the disclosure would then stand next to the very evaluation it says
    // did not happen. (Measured in the java arm of this same port, where the two sites were one line
    // apart and only the one I was working in got updated.)
    answerable: { ...pol, allow: [], forbid: [], only: [] },
    onlyUnanswerable: unevaluated.length > 0 && !pol.deny?.length,
  };
}

// ⟨0.33⟩ THE WITHHOLD IS KEYED BY UNIT; THE DISCLOSURE NAMES THE FUNCTION. Keying the held set by name
// would withhold the rule on EVERY same-named unit — and a withheld triple is a violation NOT reported,
// so that is the fail-OPEN direction: one member's missing evidence deleting another member's certain
// violation. `evaluatePolicy` and `narrowingContext` pass the unit key in turn. `why` still lists NAMES,
// because a key is not something an operator can look up in their own source.
export function unanswerableScoped(pol, functions, reasonAcc, netMap, units = null) {
  const held = new Set(), byRule = new Map();
  const key = (raw, uk, eff) => `${raw}\u0000${uk}\u0000${eff}`;
  const note = (r, uk, fn, eff, why) => {
    held.add(key(r.raw, uk, eff));
    let e = byRule.get(r.raw);
    if (!e) { e = { rule: r.raw, fns: [], why }; byRule.set(r.raw, e); }
    e.fns.push(fn);
  };
  for (const r of pol.deny) {
    for (const f of functions) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      const uk = unitKey(units, f);
      const inf = effectiveInferred(f, reasonAcc, units);
      if (r.netClasses?.length && inf.includes("Net") && !(netMap.get(uk)?.length))
        note(r, uk, f.fn, "Net", "narrows on the Net DESTINATION CLASS, but %F carr%S Net with no "
          + "`netClass` in this report — the field the filter reads is absent, so the narrowing would "
          + "succeed for lack of evidence and drop a Net the bare `deny Net` catches. NOT EVALUATED for "
          + "those functions rather than passed: an absent optional field must not relax a fail-closed "
          + "gate. Use the bare `deny Net`, or gate at scan time (candor-ts <src> --policy <file>).");
      if (r.unknownClasses?.length && inf.includes("Unknown") && !(reasonAcc.get(uk)?.size))
        note(r, uk, f.fn, "Unknown", "narrows on the Unknown REASON CLASS, but %F carr%S Unknown with no "
          + "reason reachable in this report — neither %P own `unknownWhy` nor a `calls` edge to one. "
          + "§6.2 resolves the class set TRANSITIVELY over the gate's reach; with the channel missing, "
          + "every narrowed filter silently tolerates while only the bare `deny Unknown` fires. NOT "
          + "EVALUATED for those functions rather than passed. Use the bare `deny Unknown`, or gate at "
          + "scan time (candor-ts <src> --policy <file>).");
    }
  }
  // EVERY withheld function is named, never one witness standing for the rest: the operator has to be able
  // to see which part of the policy went unenforced, and a count cannot be acted on.
  const unevaluated = [...byRule.values()].map(({ rule, fns, why }) => {
    const names = [...new Set(fns)].sort();
    const list = names.map((n) => `\`${n}\``).join(", ");
    return { rule, why: `\`${rule}\` ` + why.replace("%F", list).replace("%S", names.length === 1 ? "ies" : "y")
                                            .replace("%P", names.length === 1 ? "its" : "their") };
  });
  return { unevaluated, withhold: held.size ? (r, uk, eff) => held.has(key(r.raw, uk, eff)) : null };
}

/**
 * The standing gate: evaluate a parsed policy over a report + callgraph (AS-EFF-006 deny/pure over
 * transitive inferred; AS-EFF-008 allowlists over the transitive literal surfaces, the no-visible-
 * literal case flagged as uncertifiable; AS-EFF-009 forbid by reachability). One line per violation.
 *
 * ⟨0.24⟩ THE ONLY MATCHING CODE IN THIS ENGINE. `scan --policy` lands here over the live graph;
 * `gate --report` (SPEC §3.1) lands here over a WRITTEN report, with `callgraph`/`incomplete`/`partners`
 * empty — none of the three rides the ⟨0.24⟩ wire, and the two rule kinds that would have needed them
 * (`forbid`, `allow`) are REFUSED by that verb rather than evaluated on partial evidence. That shared
 * landing is what makes "the same verdict from the same signature" a property of the code rather than of
 * two consistent authors, and it is what §6.2 asks for: "THE GATE AND THE DISCLOSURE MUST APPLY THE SAME
 * RULE, AND SHOULD SHARE THE SAME CODE."
 */
// Each violation is a STRUCTURED record { rule, fn, effects, detail } (candor-spec §3.3 ⟨0.8⟩): `effects`
// is the specific denied/allowed effect set the violation concerns ([] for the 009 layer-flow, which has
// no single effect); `detail` is the message BODY (no `[AS-EFF-00x]` prefix — the rule carries the code).
// The console gate renders `[${rule}] ${detail}`; --gate-json emits the records verbatim.
// ⟨0.24⟩ `withhold(rule, fn, effect) -> bool` (SPEC §3.1 `5a8cf48`) — THE OPERATIONAL FORM OF MINIMAL
// REFUSAL, and the half of the precedence ruling that makes it safe. It is null on the scan route (full
// evidence, nothing to withhold) and supplied by `gate --report`.
//
// WHY IT EXISTS, because the mechanism is not obvious from the signature. Until the precedence fix, an
// unanswerable scoped rule SHORT-CIRCUITED the whole gate, so this function was never reached with one.
// Removing the short-circuit made it reachable — and `reasonClassesMatch` floors an empty class set at
// `unresolved`, which is the correct fail-closed default for a MATCHER ("could this rule apply?") and the
// WRONG basis for a FIRING ("did it?"). Measured on this engine: a `deny Unknown[unresolved]` over an entry
// whose Unknown is INHERITED and reasonless began emitting an actual violation RECORD, asserting a reason
// nobody recorded. Same constant, same helper, opposite direction of harm — a fabrication reachable ONLY
// through the soundness fix.
//
// It is per (rule, function, effect), never whole-policy and never whole-rule: `deny Fs Net[unknown-host]`
// over a function carrying BOTH a certain `Fs` and a `netClass`-less `Net` must still report the `Fs`.
// Withholding the pair would delete a certain violation — the very harm the precedence ruling is fixing.
/** ⟨0.24⟩ ONE definition of a function's Net destination classes for a run: the report's own field when it
 *  carries one (reportNetClasses), else the derivation from the surfaces the caller supplied. Exported so
 *  the ADVISORY verbs resolve the class the same way the gate does — see `classFilterExcludes`. */
export function netClassResolver(incomplete = new Map(), partners = new Set(), netClasses = null, units = null) {
  // `has`, not `get(…) ?? derive`: an entry mapped to the EMPTY set is a report that carried no class, and
  // on the authoritative route that absence is the answer — deriving one there would re-classify.
  // ⟨0.33⟩ `netClasses` is keyed by UNIT (reportNetClasses); `incomplete` stays keyed by NAME, because it
  // is the SCAN route's own live structure and that route's keys are names by construction.
  return (f) => {
    const k = unitKey(units, f);
    return (netClasses && netClasses.has(k))
      ? netClasses.get(k)
      : netClassesOf(f.hosts ?? [], incomplete.get(f.fn)?.has("Net") ?? false, partners);
  };
}

/**
 * ⟨0.24⟩ THE CLASS FILTER, AS A PREDICATE ON ONE (rule, function, effect) — does `r`'s `Unknown[…]` /
 * `Net[…]` narrowing EXCLUDE `eff` at `entry`? Factored out of `evaluatePolicy` because it was inlined
 * there, and inlined there meant the two ADVISORY verbs that ask the same question computed from the
 * effect set ALONE. Measured on this engine, `deny Unknown[reflect,unresolved] app` over a report whose
 * only hole is `native:dlopen` — the class the policy EXCLUDES:
 *
 *     gate --report        exit 0, no violations           <- correct, the class is excluded
 *     fix-gate --strict    exit 1 + a remedy naming it     <- OVER-CHARGE: a red CI check and a hoist
 *                                                             instruction for a boundary nothing denies
 *     unverified --strict  exit 0, ok:true, []             <- UNDER-REPORT, and the worse half: the layer
 *                                                             PASSES while carrying an Unknown, so it is a
 *                                                             pass-but-Unknown hole, and the verb whose whole
 *                                                             job is "your green gate is not provably green"
 *                                                             certified it clean
 *
 * Same shape on the `Net[…]` sibling (`deny Net[unknown-host]` over a `known-partner` entry). SPEC §6.2:
 * "THE GATE AND THE DISCLOSURE MUST APPLY THE SAME RULE, AND SHOULD SHARE THE SAME CODE" — this is that
 * code, and both halves existed because the disclosure side never reached it.
 *
 * THE MATCHER QUESTION, NOT THE FIRING ONE. `reasonClassesMatch` floors an empty class set at `unresolved`,
 * which the note on `withhold` records as the correct fail-closed default for a MATCHER ("could this rule
 * apply?") and the wrong basis for a FIRING ("did it?"). The advisory verbs ask the matcher question — they
 * emit no violation record that could assert a reason nobody recorded — so they use this predicate WITHOUT
 * `withhold`, whose paired `unevaluated` disclosure has no ruled shape on those verbs anyway.
 *
 * An entry ABSENT from the report excludes NOTHING: a missing entry is missing evidence, and the direction
 * that cannot turn a boundary crossing into a silent pass is "the rule still applies".
 */
export function classFilterExcludes(r, entry, eff, reasonAcc, netClassOf, units = null) {
  if (!entry) return false;
  // ⟨0.33⟩ the lookup key comes from the ENTRY, never from its name: a name-keyed lookup into a
  // unit-keyed map does not error, it returns `undefined`, and `undefined` reads here as "no classes" —
  // which `reasonClassesMatch` floors at `unresolved`. Silent, and in whichever direction the filter falls.
  if (eff === "Unknown" && r.unknownClasses?.length)
    return !reasonClassesMatch(reasonAcc.get(unitKey(units, entry)), r.unknownClasses);
  if (eff === "Net" && r.netClasses?.length)
    return !netClassOf(entry).some((c) => r.netClasses.includes(c));
  return false;
}

export function evaluatePolicy(pol, functions, callgraph, incomplete = new Map(), partners = new Set(), netClasses = null, withhold = null, units = null) {
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
  const reasonAcc = resolveReasonClasses(functions, callgraph, units);
  // ⟨0.24⟩ ONE definition of a function's Net destination classes for this run (netClassResolver above):
  // the report's own field when it carries one, else the derivation from the surfaces the caller supplied.
  // The gate's TEST and the class list it REPORTS both read it, so the two can't disagree about one function.
  const netClassOf = netClassResolver(incomplete, partners, netClasses, units);
  for (const f of functions) {
    // ⟨0.33⟩ the KEY identifies the unit; `f.fn` is the NAME, and the name is what a policy SCOPE matches
    // and what the verdict row prints (§3.3.1 byte-equality with `scan --policy` rests on it).
    const uk = unitKey(units, f);
    const inferredOf = effectiveInferred(f, reasonAcc, units);
    for (const r of pol.deny) {
      if (r.scope && !scopeMatches(f.fn, r.scope)) continue;
      // `pure` (empty forbidden set) forbids every EFFECT — not `Unknown`, which is the §4 trust
      // marker, not an effect (AS-EFF-003's concern; `deny Unknown <scope>` is the explicit knob).
      // The reference engine (candor-java) and the rust deep engine exclude it identically; candor-ts
      // wrongly counted an Unknown-only fn as a `pure` violation until 2026-07-09.
      const hits = r.effects.length === 0
        ? inferredOf.filter((e) => e !== "Unknown")
        : inferredOf.filter((e) => r.effects.includes(e));
      // Reason-scoped Unknown: a `deny E Unknown[classes]` keeps its Unknown hit only for a fn whose
      // TRANSITIVE reason classes include one of those; Net destination-class: a `deny Net[dest…]` keeps its
      // Net hit only for a fn reaching one of those destinations, else tolerates (only asserted-safe ones).
      // Fail-closed: a masked surface / a Net with no visible host is unknown-host (netClassesOf); the class
      // travels the call graph via f.hosts + f.incomplete, propagated transitively before the gate (scan.mjs).
      // ⟨0.24⟩ BOTH now live in `classFilterExcludes`, so `fix-gate` and `unverified` apply the same filter
      // instead of computing from the effect set alone (see that function's measurement).
      let kept = hits.filter((e) => !classFilterExcludes(r, f, e, reasonAcc, netClassOf, units));
      // ⟨0.24⟩ …and LAST, because it overrides the matchers rather than joining them: an effect whose match
      // this report cannot evidence is neither a violation nor a pass. The caller lists it as `unevaluated`.
      if (withhold && kept.length) kept = kept.filter((e) => !withhold(r, uk, e));
      if (kept.length) {
        // When Unknown is denied, report ALL reason classes on the fn (transitive) — every reason the gate bit.
        const rc = kept.includes("Unknown") ? [...(reasonAcc.get(uk) ?? [])].sort() : undefined;
        // ⟨0.20⟩ when Net is denied, report ALL of the fn's destination classes (transitive).
        const ncv = kept.includes("Net") ? netClassOf(f) : undefined;
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
  // ⟨0.29⟩ AS-EFF-011 — `only A -> B …`: a fn in A may reach A and the listed scopes, NOTHING else. The
  // same walk as `forbid` above with the test INVERTED, and the inversion is the point: `forbid` fails
  // OPEN, so a leaf can only be protected by enumerating what it must not reach — a list that does not
  // cover a package added tomorrow. `only` fails SAFE.
  //
  // THE WALK STOPS AT A PERMITTED SCOPE. A permitted callee's own dependencies are governed by the rules
  // about IT; descending past it would make `only` demand the transitive closure of everything you permit,
  // which is the same enumeration-that-rots one level down. `from` IS descended through — a fn in A
  // calling another fn in A that reaches infra is still A reaching infra.
  for (const r of pol.only ?? []) {
    for (const fn of Object.keys(callgraph)) {
      if (!scopeMatches(fn, r.from)) continue;
      const seen = new Set([fn]), queue = [fn];
      let hit = null;
      while (queue.length && !hit) {
        for (const c of callgraph[queue.pop()] ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          // ⟨0.29⟩ EXACT segment match — the shared prefix matcher is fail-OPEN for a permission.
          if (r.to.some((t) => scopeMatchesPermitted(c, t))) continue;   // permitted; callees not ours
          if (!scopeMatches(c, r.from)) { hit = c; break; }
          queue.push(c);
        }
      }
      // ⟨0.29⟩ ITS OWN CODE, not `forbid`'s — a rule code is what a CI suppression keys on, and these two
      // are opposite constructs. Sharing 009 would make an existing `forbid` suppression silently mute
      // `only` violations its author never accepted.
      if (hit) push("AS-EFF-011", fn, [], `\`${fn}\` reaches \`${hit}\`, which this permission rule does not permit: \`${r.raw}\``);
    }
  }
  // ⟨0.27⟩ SPEC §4 — A RULE WHOSE SCOPE BOUND NO FUNCTION IS UNANSWERABLE, AND IS DISCLOSED RATHER THAN
  // SCORED AS SATISFIED. Measured on this engine before the fix: `deny Fs orders` exits 1 on a real
  // violation while `deny Fs ordrs` exits 0 in silence — a one-character typo in a layer name is a
  // permanently green gate, and `unverified` then calls the layer "PROVABLY clean". The asymmetry is the
  // tell: a typo'd EFFECT token already exits 2 naming the accepted vocabulary.
  //
  // Carried as a PROPERTY on the returned array rather than as a second return value, so every existing
  // caller keeps working unchanged and `--gate-json` is untouched: JSON.stringify ignores non-index
  // properties on an array, so the verdict document cannot acquire a field the spec has not pinned.
  //
  // A `deny`/`pure` with NO scope applies to every function and so can never be this kind of typo —
  // excluded. A `forbid` counts a match on either endpoint. Counted over the same names the gate saw.
  const zeroCount = new Map();
  for (const r of pol.deny) if (r.scope) zeroCount.set(r.raw, 0);
  for (const r of pol.forbid) zeroCount.set(r.raw, 0);
  // ⟨0.29⟩ …and `only`, counted on `from` ALONE — deliberately not either endpoint the way a `forbid`
  // counts. A forbid's subject is the pair; an `only`'s subject is the scope it makes a PROMISE about, so
  // a rule whose destinations all resolve while its `from` names nothing has bound nothing, and that is
  // exactly the typo that leaves an operator believing a leaf is protected.
  for (const r of pol.only ?? []) zeroCount.set(r.raw, 0);
  if (zeroCount.size) {
    const names = new Set(functions.map((f) => f.fn));
    for (const k of Object.keys(callgraph ?? {})) names.add(k);
    for (const n of names) {
      for (const r of pol.deny) if (r.scope && scopeMatches(n, r.scope)) zeroCount.set(r.raw, zeroCount.get(r.raw) + 1);
      for (const r of pol.forbid) {
        if (scopeMatches(n, r.from) || scopeMatches(n, r.to)) zeroCount.set(r.raw, zeroCount.get(r.raw) + 1);
      }
      for (const r of pol.only ?? []) {
        if (scopeMatches(n, r.from)) zeroCount.set(r.raw, zeroCount.get(r.raw) + 1);
      }
    }
  }
  // ⟨0.27⟩ CODE-POINT order, explicitly — the `zeroMatch` verdict key pins the `viaDispatchOn` collation
  // (SPEC §4), and JS's default sort orders by UTF-16 code unit, which disagrees above the BMP. The raw
  // line is built from user identifiers, so this is reachable rather than theoretical.
  out.zeroMatch = [...zeroCount].filter(([, c]) => c === 0).map(([raw]) => raw)
    .sort((a, b) => {
      const ai = [...a], bi = [...b];
      for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
        const d = ai[i].codePointAt(0) - bi[i].codePointAt(0);
        if (d) return d;
      }
      return ai.length - bi.length;
    });
  return out;
}

// ⟨0.27⟩ EVERY RULE OF A REFUSED POLICY, one `unevaluated` entry per raw line (SPEC §3.1's
// composed-document clause; candor-java `unhonouredRules` is the model). `policyErrorUnevaluated` above
// names only the UNHONOURABLE lines — measured, that let a consumer read `deny Fs`, absent from the list
// on an exit-1 document, as evaluated-and-passed: a per-rule false all-clear arriving through the
// disclosure itself. The unhonourable lines keep their specific `why`; every other rule line carries the
// whole-policy refusal, because a policy is evaluated as a whole or not at all. ONE builder for both gate
// routes, for the same byte-equality reason as its siblings above.
export function policyRefusalUnevaluated(policyText, errors) {
  const fatal = new Map(policyErrorUnevaluated(errors).map((e) => [e.rule, e.why]));
  const out = [];
  for (const raw of policyText.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    out.push({ rule: line,
      why: fatal.get(line)
        ?? "NOT EVALUATED — a rule elsewhere in this policy cannot be honoured as written (named beside "
         + "its own entry in this list), and a policy is evaluated as a whole or not at all: a verdict "
         + "from its readable subset would be a verdict on a policy nobody wrote." });
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
      // A config that EXISTS but cannot be READ is configured-but-unusable, which §3.4 makes exit 2 —
      // never a silent "absent" and never an uncaught throw. The bare `readFileSync` here let an EACCES
      // escape as an uncaught exception: node exits 1, which is the POLICY VIOLATION code, and the
      // armed sentinel survived because nothing replaced it. Two wrong answers from one missing catch.
      // The siblings below swallow to null, which is the other wrong answer — an unreadable pin or
      // policy silently not enforced — so all three now refuse the same way.
      const m = readConfigOrRefuse(cand).split(/\r?\n/)
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
  if (env) { return readConfigOrRefuse(env, "CANDOR_CONFIG"); }
  let dir = nodePath.resolve(fromDir);
  for (;;) {
    const cand = nodePath.join(dir, ".candor", "config");
    if (fs.existsSync(cand)) { return readConfigOrRefuse(cand); }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ⟨0.24⟩ The PATH the text above came from (SPEC §3.1 `99eb4e9`: "if a config file supplied vocabulary that
// participated in the verdict, the `--gate-json` document MUST name that file"). Discovery WALKS PARENT
// DIRECTORIES and `CANDOR_CONFIG` overrides it outright, so a file the operator never named — and cannot
// see named anywhere in the output — can decide the verdict. That is the ambient-input failure this format
// exists to refuse, and the remedy is the usual one: not to forbid the input, but to make it unable to act
// unnamed. Same walk as `discoverConfigText`, deliberately, so the two cannot name different files.
/**
 * Read a `.candor/config` that DISCOVERY has already found, or refuse (exit 2).
 *
 * The three readers in this file each handled an unreadable-but-present config differently: one let the
 * exception escape (node exits 1 — the POLICY VIOLATION code — with a stack trace, and an armed
 * `--gate-json` sentinel left in place), and two swallowed it to `null`, which reads as "no config" and
 * silently drops whatever the file configured: a policy, a baseline, or an engine pin the operator
 * believes is guarding them. §3.4's posture is the unreadable-policy one — configured-but-unusable
 * fails loud — so all three route through here.
 */
function readConfigOrRefuse(p, via = null) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    console.error(`candor-ts: ${via ? `${via}=` : ""}${p} exists but could not be read (${e.code ?? e.message}) `
      + `— failing (exit 2, unevaluable). A config that cannot be read is a guard the operator believes `
      + `is on: it may name a policy, a baseline or an engine pin, and treating it as absent would run `
      + `without them.`);
    process.exit(2);
  }
}

export function discoverConfigPath(fromDir) {
  const env = process.env.CANDOR_CONFIG;
  if (env) { readConfigOrRefuse(env, "CANDOR_CONFIG"); return nodePath.resolve(env); }
  let dir = nodePath.resolve(fromDir);
  for (;;) {
    const cand = nodePath.join(dir, ".candor", "config");
    if (fs.existsSync(cand)) return cand;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ⟨0.24⟩ The ANCHOR for keys that supply POLICY VOCABULARY (SPEC §3.1 `99eb4e9`). All four gate verbs used
// to anchor config discovery at the POLICY file's directory while all four scan routes anchored at the
// TARGET, so with the policy filed outside the scan target `scan --policy P` and `gate --report R --policy
// P` expanded the SAME rule differently — §3.1's byte-equality MUST broken by a file that is neither the
// report nor the policy. Vocabulary travels with the policy that uses it. TARGET-scoped keys (`deps`,
// `net-partner`, scan settings) keep anchoring at the target, because they describe the thing being scanned
// rather than the language the rules are written in.
export function policyVocabularyAnchor(policyFile, fallbackDir) {
  return policyFile ? nodePath.dirname(nodePath.resolve(policyFile)) : fallbackDir;
}

// ⟨0.19⟩ Parse `unknown-alias <name> = <class,…>` lines (SPEC §6.2) into a Map name→class-token[]. A name
// that shadows a built-in (`*`/`dynamic`/a class token) is warned-and-skipped, as is a no-valid-class def.
// Byte-shape with the java `Config.addAlias` / rust `parse_unknown_aliases`.
// ⟨0.24⟩ `errors`, when supplied, receives an unrecognised token in an alias DEFINITION under the same rule
// as one in the policy itself (SPEC §6.2 `be0b9a9` — the rule binds EVERY policy value list). This is the
// sharper of the two: the typo is in the VOCABULARY the policy is written against rather than in the policy,
// and it fails open identically — `unknown-alias corp = dispatch,nativ` silently becomes `{dispatch}`, so
// `deny Unknown[corp]` stops gating native-caused holes that `= dispatch,native` catches, and the operator
// reads a policy that mentions no typo at all. A RESERVED or empty NAME stays a warn-and-skip: the name is
// not a value token, the definition is dropped whole, and a rule referencing it then raises its own
// unrecognised-token error at the policy — loud by the route the ruling already covers.
export function parseUnknownAliases(configText, errors = null) {
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
      else if (errors) errors.push({ kind: "reason-class/alias", token: cn,
                                     accepted: [...REASON_CLASSES, "dynamic"], rule: line,
                                     message: `unknown reason-class \`${cn}\` in an \`unknown-alias\` `
                                            + `DEFINITION (known: ${REASON_CLASSES.join(", ")}, or dynamic)` });
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
export function parseNetPartners(configText, errs = null) {
  const out = new Set();
  if (!configText) return out;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m || m[1].toLowerCase() !== "net-partner") continue;
    const val = m[2].trim();
    // ⟨0.29⟩ A MALFORMED VALUE IS DISCLOSED, NOT SILENTLY KEPT AS JUNK. The grammar is
    // `net-partner <host>`; the `=` spelling an operator reaches for by habit
    // (`net-partner = partner.example`) parsed as the HOST "= partner.example", which entered the set and
    // matched nothing for the rest of the run. The direction is safe — the gate stays armed, so nothing
    // is certified that should not be — which is exactly why it can sit unnoticed: the operator believes
    // a partner is declared, the verdict says otherwise, and no line connects the two. ⟨0.28⟩ gave POLICY
    // files an `ignored` block for this; config files had no equivalent.
    if (!val) continue;
    if (/\s/.test(val) || val.startsWith("=")) {
      errs?.push({ kind: "config-value", raw: raw.trim(),
                   why: `net-partner takes a bare host — \`net-partner <host>\`, one per line; `
                      + `'${val}' is not one and was IGNORED (an '=' or extra words is the usual cause)` });
      continue;
    }
    out.add(hostPart(val).toLowerCase());
  }
  return out;
}
