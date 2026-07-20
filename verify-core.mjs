// candor verify — the dynamic HONESTY ORACLE core (candor-spec RQ1; COMPLETENESS-MANIFEST-DESIGN.md §3).
//
// The mechanism-INDEPENDENT third check of the defense-in-depth ladder (static analysis → cross-engine
// conformance → THIS): does runtime behaviour escape what candor DECLARED? Given (1) a candor report
// (per-fn inferred effects) and (2) a runtime trace attributing effect-bearing calls to functions, decide
// the honesty invariant per EXECUTED function:
//
//     observed(f) ⊆ inferred(f)     OR     Unknown ∈ inferred(f)
//
// and classify each executed fn:
//   · sound-complete-ok  — Unknown ∉ inferred, observed ⊆ inferred            (held tightly)
//   · disclosed-partial  — Unknown ∈ inferred                                 (held by disclosure)
//       of which "Unknown-load-bearing": observed ⊄ (inferred ∖ {Unknown})    (the disclosure mattered)
//   · VIOLATION          — Unknown ∉ inferred, observed ⊄ inferred            (a FALSE ALL-CLEAR = the cardinal sin)
//
// A function ABSENT from the report is a claim of purity (inferred = ∅) — so a silently-dropped effectful
// fn surfaces here as a violation, exactly the bug class candor exists to prevent. This shares no code,
// spec interpretation, or author intuition with the four static engines: it checks candor against REALITY.
// Ported from the RQ1 research harness (~/candor-paper/harness) — the reusable, testable checker.

const UNKNOWN = "Unknown";

// The effect scope the oracle asserts over. `direct` = the syscall-parity headline set (what even a
// mechanism-independent kernel trace witnesses) — the conservative, strongest claim. `all` = everything the
// language-level Node capture additionally wraps at the entry-point boundary (Env/Clock/Rand read from
// process memory / the vDSO, invisible to a syscall trace, but visible when we wrap `process.env`/`Date`).
export const DIRECT_SCOPE = ["Net", "Fs", "Exec"];
export const ALL_SCOPE = [...DIRECT_SCOPE, "Env", "Clock", "Rand", "Llm", "Db", "Ipc", "Clipboard", "Log"];

export function scopeSet(scope) {
  return new Set(scope === "all" ? ALL_SCOPE : DIRECT_SCOPE);
}

/** report `{ functions: [{fn, inferred}] }` (or a bare array) → Map fn → Set(effects). Absent ⇒ ∅ (pure). */
export function reportEffects(report) {
  const fns = Array.isArray(report) ? report : (report.functions ?? []);
  const m = new Map();
  for (const e of fns) m.set(e.fn, new Set(e.inferred ?? []));
  return m;
}

/** report → Map fn → sorted array of the fn's `unknownWhy` reasons (the reason-scoped-Unknown ⟨0.19⟩
 *  vocabulary: `dispatch:`/`reflect:*`/`callback:`/`unresolved`/…). Absent/empty ⇒ omitted. This is the
 *  BLAME source: when the oracle finds a disclosed Unknown doing real work at runtime, `unknownWhy` names the
 *  exact unresolved edge to resolve for a precise (non-Unknown) answer. */
export function reportReasons(report) {
  const fns = Array.isArray(report) ? report : (report.functions ?? []);
  const m = new Map();
  for (const e of fns) if (e.unknownWhy?.length) m.set(e.fn, [...e.unknownWhy].sort());
  return m;
}

/** trace events [{fn, effect}] → Map fn → Set(observed effects in scope). Executed-but-effect-free fns
 *  still appear (∅) so they count toward coverage. */
export function observedByFn(events, scope) {
  const allowed = scopeSet(scope);
  const obs = new Map();
  for (const ev of events) {
    if (!ev || !ev.fn) continue;
    if (!obs.has(ev.fn)) obs.set(ev.fn, new Set());
    if (ev.effect && allowed.has(ev.effect)) obs.get(ev.fn).add(ev.effect);
  }
  return obs;
}

// Effect REFINEMENTS: `Llm` and `Db` (as observed by this oracle — always a network destination: a model
// host / a database port) are refinements of `Net` — an Llm/Db call IS a Net call. So candor honestly
// declaring `Net` (it couldn't resolve the model host / db-ness) is SATISFIED by an observed Llm/Db: the
// BASE effect was reported, which is what the honesty invariant (and any Net gate) turns on. A missing
// REFINEMENT is not a false-pure; only a missing BASE effect is the cardinal sin. So an observed refinement
// is "covered" if the refinement OR its base is inferred.
const BASE = { Llm: "Net", Db: "Net" };
const covered = (e, inferred) => inferred.has(e) || (BASE[e] && inferred.has(BASE[e]));
const subset = (obs, inferred) => [...obs].every((e) => covered(e, inferred)); // obs ⊆ inferred (up to refinement)
const diff = (obs, inferred) => [...obs].filter((e) => !covered(e, inferred)); // the genuinely-escaped effects

/**
 * The invariant check. `report`/`observed` are Maps (fn → Set). `reasonsMap` (fn → array of `unknownWhy`
 * reasons, from `reportReasons`) is optional — when present, a LOAD-BEARING disclosed-partial row carries a
 * `blame` field naming the exact unresolved edge(s) to resolve for a precise answer. Returns { rows,
 * violations, metrics }. A VIOLATION is a fn that ran effects its COMPLETE (no-Unknown) signature didn't
 * include — the cardinal sin.
 */
export function honestyCheck(reportMap, observedMap, scope, reasonsMap = null) {
  const allowed = scopeSet(scope);
  const rows = [];
  const violations = [];
  const blame = []; // load-bearing-Unknown rows → the unknownWhy edge(s) to resolve for precision
  let clean = 0, disclosed = 0, loadBearing = 0;
  for (const fn of [...observedMap.keys()].sort()) {
    const inferred = reportMap.get(fn) ?? new Set(); // absent ⇒ ∅ (claimed pure)
    const obs = new Set([...observedMap.get(fn)].filter((e) => allowed.has(e)));
    let verdict, rowBlame = null;
    if (inferred.has(UNKNOWN)) {
      verdict = "disclosed-partial";
      disclosed++;
      const tight = new Set([...inferred].filter((e) => e !== UNKNOWN));
      if (!subset(obs, tight)) {
        loadBearing++; // the Unknown was doing real work
        // BLAME: the disclosure ACTUALLY mattered (observed escapes the non-Unknown signature). Attribute it to
        // the fn's own `unknownWhy` reason(s) — the precise unresolved edge to resolve to eliminate the Unknown.
        rowBlame = { fn, escaped: diff(obs, tight).sort(), why: reasonsMap?.get(fn) ?? [] };
        blame.push(rowBlame);
      }
    } else if (subset(obs, inferred)) {
      verdict = "sound-complete-ok";
      clean++;
    } else {
      verdict = "VIOLATION";
      violations.push({ fn, observed: [...obs].sort(), inferred: [...inferred].sort(), escaped: diff(obs, inferred).sort() });
    }
    const row = { fn, verdict, observed: [...obs].sort(), inferred: [...inferred].sort() };
    if (rowBlame) row.blame = rowBlame.why; // the load-bearing row names its own unresolved edge(s)
    rows.push(row);
  }
  const metrics = {
    scope,
    effectsInScope: [...allowed].sort(),
    executedFunctionsChecked: observedMap.size,
    soundCompleteOk: clean,
    disclosedPartial: disclosed,
    disclosedUnknownLoadBearing: loadBearing,
    cardinalSinViolations: violations.length,
    honestyInvariantHolds: violations.length === 0,
  };
  return { rows, violations, blame, metrics };
}

/** Parse a candor `loc` string (`file:line:col`) → `{ file, line }` (or null). The file is normalized to
 *  forward slashes: scan.mjs writes `loc` with the raw OS separator (a backslash on Windows) while the
 *  runtime capture (verify-emit) forward-slashes its site paths, so without this NO site matches on Windows
 *  and every effect is dropped (a whole-platform false all-clear). candor's `loc` is a project-RELATIVE path
 *  (no `C:` drive), so a bare `\`→`/` is safe. */
function parseLoc(loc) {
  if (!loc) return null;
  const i = loc.lastIndexOf(":", loc.lastIndexOf(":") - 1); // split off `:line:col`
  const file = loc.slice(0, i).replace(/\\/g, "/");
  const line = Number(loc.slice(i + 1).split(":")[0]);
  return Number.isFinite(line) ? { file, line } : null;
}

/**
 * ATTRIBUTION: map raw capture sites `{file, line, effect}` (the runtime call-site) to the candor function
 * that ENCLOSES them. An event with no project file (a dependency's own effect, `file: null`) is unattributed
 * — dropped (it is not the target's code). Returns `[{fn, effect}]`.
 *
 * SOUNDNESS — the anchor universe and the containment test both matter.
 * · UNIVERSE: the §2 report carries a start loc for EFFECTFUL fns only. Anchoring against those alone lets an
 *   effect run inside a fn candor called PURE (report-absent) fold onto the nearest preceding effectful fn,
 *   whose claim covers it — a silent MISS. `locIndex` (candor's `<prefix>.locs.json`, EVERY analyzed fn incl.
 *   pure) closes that: a pure fn's effect anchors to ITSELF and, absent from the effectful set, is a VIOLATION.
 * · CONTAINMENT: a start-only "nearest declaration below" rule misattributes a site that sits AFTER a nested
 *   fn but INSIDE the effectful outer fn to that nested (often pure) fn — a FALSE violation (found corpus-
 *   testing: an fs.readFileSync deep in `run()` bucketed onto a pure callback arrow declared earlier). So when
 *   the index carries SPANS ({loc, end}), attribute to the INNERMOST fn whose [start,end] CONTAINS the site
 *   (greatest start among containers). Start-only entries fall back to nearest-declaration-below (disclosed).
 */
export function attribute(events, report, locIndex = null) {
  const byFile = new Map();
  const push = (loc, end, fn) => {
    const p = parseLoc(loc);
    if (!p) return;
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push({ start: p.line, end: (typeof end === "number" ? end : null), fn });
  };
  if (locIndex) {
    for (const [fn, v] of Object.entries(locIndex)) {
      if (v && typeof v === "object") push(v.loc, v.end, fn);  // span form {loc, end}
      else push(v, null, fn);                                  // legacy start-only string
    }
  } else {
    const fns = Array.isArray(report) ? report : (report.functions ?? []);
    for (const e of fns) push(e.loc, e.endLine ?? null, e.fn);
  }
  const out = [];
  let unattributed = 0; // captured PROJECT effects (ev.file non-null) we could NOT place on any function
  for (const ev of events) {
    if (!ev || !ev.file) continue; // node-internal / a dependency's own I/O — not the target's code
    const arr = byFile.get(ev.file);
    let pick = null;
    if (arr) {
      // Prefer SPAN containment: the innermost fn (greatest start) whose [start,end] contains the site line.
      // Fall back to nearest-declaration-below among start-only (no-end) entries when nothing spanned contains.
      let best = null, fallback = null;
      for (const c of arr) {
        if (c.end != null) {
          if (c.start <= ev.line && ev.line <= c.end && (!best || c.start > best.start)) best = c;
        } else if (c.start <= ev.line && (!fallback || c.start > fallback.start)) {
          fallback = c;
        }
      }
      pick = best ?? fallback;
    }
    if (pick) out.push({ fn: pick.fn, effect: ev.effect });
    else unattributed++; // the effect ran in the target's code but landed on no analyzed fn — see verifySites
  }
  return { events: out, unattributed };
}

/** Convenience: run the check from a raw report doc + raw trace events (already `{fn, effect}`). */
export function verify(report, events, scope = "direct") {
  return honestyCheck(reportEffects(report), observedByFn(events, scope), scope, reportReasons(report));
}

/**
 * Run the full pipeline from a report doc + raw CAPTURE SITES `{file, line, effect}`: attribute then check.
 * `opts.locIndex` = fn → loc for the FULL analyzed universe (candor's `<prefix>.locs.json`) — REQUIRED for
 * sound attribution (see `attribute`). `opts.analyzedCount` = |analyzed universe| (the manifest's
 * `analyzed.count`) — used to detect unlocated pure fns when locIndex is absent. When attribution is NOT
 * provably complete, the result carries `metrics.attributionComplete = false` + `metrics.attributionNote`
 * so the caller can DISCLOSE (fail closed) rather than present a HOLDS as a sound all-clear.
 */
export function verifySites(report, sites, scope = "direct", opts = {}) {
  const { locIndex = null, analyzedCount = null } = opts;
  const { events, unattributed } = attribute(sites, report, locIndex);
  const result = honestyCheck(reportEffects(report), observedByFn(events, scope), scope, reportReasons(report));

  const fns = Array.isArray(report) ? report : (report.functions ?? []);
  const effectfulWithLoc = fns.filter((f) => parseLoc(f.loc)).length; // only fns we can actually ANCHOR
  const locEntries = locIndex ? Object.keys(locIndex).length : 0;
  const locHasSpans = !!locIndex && Object.values(locIndex).every((v) => v && typeof v === "object" && typeof v.end === "number");
  // The index certifies sound attribution ONLY when it is present, NON-EMPTY, all-spans, and COVERS the
  // analyzed universe (an empty/truncated/start-only <prefix>.locs.json must NOT count as complete — else it
  // silently drops every site and prints HOLDS). If analyzedCount is unknown, require at least the anchorable
  // effectful set.
  const indexCovers = !!locIndex && locEntries > 0 && locHasSpans
    && (analyzedCount == null ? locEntries >= effectfulWithLoc : locEntries >= analyzedCount);
  // Without an index: sound only if no pure fn could be mislocated (analyzedCount ≤ the ANCHORABLE effectful
  // count — counting only entries that actually carry a parseable loc, so a report whose effectful entries lack
  // loc cannot masquerade as fully-anchored).
  const pureUnlocated = analyzedCount != null ? Math.max(0, analyzedCount - effectfulWithLoc) : null;
  const universeSound = indexCovers || (locIndex == null && pureUnlocated === 0);

  // THE DECISIVE INVARIANT: every captured project effect was placed on a function. A single unplaced site
  // (empty/stale/mismatched index, a file candor never analyzed, a path-separator mismatch) means a real
  // observed effect went unchecked — the all-clear is not sound regardless of the index's shape.
  result.metrics.attributionComplete = universeSound && unattributed === 0;
  result.metrics.unattributedSites = unattributed;
  if (!result.metrics.attributionComplete) {
    result.metrics.attributionNote = unattributed > 0
      ? `${unattributed} captured effect-site(s) could not be attributed to any analyzed function (an empty/stale/mismatched loc index, or code candor did not analyze) — those effects are NOT checked; not a sound all-clear (re-scan to emit a complete <prefix>.locs.json)`
      : (locIndex != null && !indexCovers)
        ? "the loc index does not cover the analyzed universe (empty, truncated, or start-only) — a pure fn's effect could fold into a neighbour; not a sound all-clear (re-scan)"
        : pureUnlocated == null
          ? "no loc index and analyzed-universe size unknown — a pure fn that ran an effect may have been credited to a neighbouring function; not a sound all-clear (re-scan to emit <prefix>.locs.json)"
          : `${pureUnlocated} pure fn(s) have no location — an effect executed inside one is credited to the nearest preceding effectful fn, so a cardinal-sin escape can be silently missed; not a sound all-clear (re-scan to emit <prefix>.locs.json)`;
  }
  return result;
}
