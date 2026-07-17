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

const subset = (a, b) => [...a].every((x) => b.has(x)); // a ⊆ b
const diff = (a, b) => [...a].filter((x) => !b.has(x)); // a ∖ b

/**
 * The invariant check. `report`/`observed` are Maps (fn → Set). Returns { rows, violations, metrics }.
 * A VIOLATION is a fn that ran effects its COMPLETE (no-Unknown) signature didn't include — the cardinal sin.
 */
export function honestyCheck(reportMap, observedMap, scope) {
  const allowed = scopeSet(scope);
  const rows = [];
  const violations = [];
  let clean = 0, disclosed = 0, loadBearing = 0;
  for (const fn of [...observedMap.keys()].sort()) {
    const inferred = reportMap.get(fn) ?? new Set(); // absent ⇒ ∅ (claimed pure)
    const obs = new Set([...observedMap.get(fn)].filter((e) => allowed.has(e)));
    let verdict;
    if (inferred.has(UNKNOWN)) {
      verdict = "disclosed-partial";
      disclosed++;
      const tight = new Set([...inferred].filter((e) => e !== UNKNOWN));
      if (!subset(obs, tight)) loadBearing++; // the Unknown was doing real work
    } else if (subset(obs, inferred)) {
      verdict = "sound-complete-ok";
      clean++;
    } else {
      verdict = "VIOLATION";
      violations.push({ fn, observed: [...obs].sort(), inferred: [...inferred].sort(), escaped: diff(obs, inferred).sort() });
    }
    rows.push({ fn, verdict, observed: [...obs].sort(), inferred: [...inferred].sort() });
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
  return { rows, violations, metrics };
}

/**
 * ATTRIBUTION: map raw capture sites `{file, line, effect}` (the runtime call-site) to the candor function
 * that ENCLOSES them, using the report's per-fn `loc` (file:line:col). The enclosing fn is the one whose
 * declaration line is the greatest ≤ the site line in the same file (the innermost declaration above the
 * call). An event with no project file (a dependency's own effect, `file: null`) is unattributed — dropped
 * from the per-fn check (it is not the target's code). Returns `[{fn, effect}]` for honestyCheck.
 *
 * Slice-1 imprecision (disclosed): module-top-level code AFTER a function can misattribute to that function
 * (no end-line in the report). Effects inside named functions — the common + seeded case — attribute cleanly.
 */
export function attribute(events, report) {
  const byFile = new Map();
  const fns = Array.isArray(report) ? report : (report.functions ?? []);
  for (const e of fns) {
    if (!e.loc) continue;
    const i = e.loc.lastIndexOf(":", e.loc.lastIndexOf(":") - 1); // split off `:line:col`
    const file = e.loc.slice(0, i);
    const line = Number(e.loc.slice(i + 1).split(":")[0]);
    if (!Number.isFinite(line)) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ line, fn: e.fn });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.line - b.line);
  const out = [];
  for (const ev of events) {
    if (!ev || !ev.file) continue;
    const arr = byFile.get(ev.file);
    if (!arr) continue;
    let fn = null;
    for (const c of arr) { if (c.line <= ev.line) fn = c.fn; else break; }
    if (fn) out.push({ fn, effect: ev.effect });
  }
  return out;
}

/** Convenience: run the check from a raw report doc + raw trace events (already `{fn, effect}`). */
export function verify(report, events, scope = "direct") {
  return honestyCheck(reportEffects(report), observedByFn(events, scope), scope);
}

/** Run the full pipeline from a report doc + raw CAPTURE SITES `{file, line, effect}`: attribute then check. */
export function verifySites(report, sites, scope = "direct") {
  return honestyCheck(reportEffects(report), observedByFn(attribute(sites, report), scope), scope);
}
