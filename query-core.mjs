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
import { reasonClass, REASON_CLASSES, DYNAMIC_CLASSES, resolveReasonClasses, reasonClassesMatch,
         classFilterExcludes, netClassResolver, reportNetClasses, unanswerableScoped } from "./policy.mjs";

// Sibling report/callgraph files of a multi-report prefix (candor-scan writes <prefix>.<crate>.scan.json,
// one per workspace member) — so the loaders read ANY engine's output, not just candor-ts's <prefix>.json.
// This is the cross-engine premise: an agent queries a report from any language identically.
function siblings(prefix, predicate) {
  const dir = nodePath.dirname(prefix) || ".";
  const base = nodePath.basename(prefix);
  try {
    // SORTED, because readdir order is filesystem ENUMERATION order — stable on one machine, divergent
    // across filesystems and checkouts, and everything downstream of this list inherits it: the merge
    // order of multi-report functions, the concatenation order of the ⟨0.28⟩ `unanalyzed` disclosure,
    // which duplicate callgraph key wins Object.assign. rust (candor-report lib.rs), java (Query.java)
    // and swift (FixCLI.swift) all sort here; this engine was the outlier, so two engines over an
    // IDENTICAL tree could emit differently-ordered arrays and a byte-diffing consumer read a change
    // where there was none.
    return fs.readdirSync(dir).filter((f) => f.startsWith(base + ".") && f.endsWith(".json") && predicate(f))
      .sort().map((f) => nodePath.join(dir, f));
  } catch { return []; }
}
// A sibling filename that is a real REPORT (not a callgraph sidecar, an encountered-crate ledger, a
// calibrated-coverage sidecar, or a --gate-json verdict written beside the prefix). Exported so
// `hasReport` (the MCP existence check) uses the SAME predicate as the loader — else a prefix whose only
// sibling is `.encountered-*`/`.calibrated.json` passes the existence check but loads ZERO functions →
// an authoritative-empty result (silent under-report; review find). `.gate.json` has no functions array,
// so merging it "disclosed a malformed report" on every query over the recommended CI layout — noisy, excluded.
export const isReport = (f) => !f.endsWith(".callgraph.json") && !f.endsWith(".hierarchy.json") && !f.endsWith(".locs.json") && !f.includes(".encountered-") && !f.endsWith(".calibrated.json") && !f.endsWith(".gate.json");

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
// The report FILE(S) a prefix names: the exact `<prefix>.json`, else its multi-report siblings. ONE copy,
// because the loaders and the ⟨0.24⟩ judged-nothing check must read the same file set — a helper reading a
// narrower one would answer about a report the gate never gated.
const reportFilesAt = (prefix) => (fs.existsSync(`${prefix}.json`) ? [`${prefix}.json`] : siblings(prefix, isReport));

// ⟨0.28⟩ SPEC §3.3.1 (3) — the FILES a gate `--report` locator names, for the verdict-sink guard:
// `reportFilesAt`'s expansion (the SAME enumeration `loadGateReport` below reads — kept adjacent so the
// guard and the loader cannot drift), plus each report's §2.2 sidecars. Exists because the guard
// compared the sink against the raw locator TOKEN while the loader reads the token's EXPANSION.
// MEASURED on this engine 2026-08-12:
//
//   gate --report r --policy P --gate-json r.json
//       → armQueryGateJson wrote the refusal placeholder OVER the operator's report, the load then
//         failed on the wreckage ("has no functions array"), and the exit-2 refusal document was
//         written over it AGAIN. The no-`--report` discovery spelling (sink = the discovered
//         `.candor/report.json`) destroyed the discovered report identically.
//
// THE SIDECARS RIDE ALONG (same clause: a report locator names the PAIR). The gate opens no sidecar —
// that MUST NOT is `loadGateReport`'s — but a sink on the pair's other half is WORSE: the report loads
// fine, the gate runs, and a REAL verdict lands on the callgraph at a success exit; `callers`/`tour`
// then read a verdict document where the graph belongs. The segment list is the `isReport` denylist's
// pair-carrying members: `gate` is excluded because `<stem>.gate.json` is the verdict sink's own
// beside-the-report layout — the exact spelling `--gate-json` exists for, pinned by the control test —
// and `encountered-*` because it is engine-local scan bookkeeping no query reads. Existing files only:
// the guard protects data, and a sidecar not on disk has none to lose.
const PAIRED_SIDECAR_SEGMENTS = ["calibrated", "callgraph", "hierarchy", "layerreach", "locs"];
export function gateReportInputFiles(prefix) {
  if (!prefix) return [];
  const out = [];
  for (const r of reportFilesAt(prefix)) {
    if (r.endsWith(".json")) {
      const stem = r.slice(0, -".json".length);
      for (const seg of PAIRED_SIDECAR_SEGMENTS) {
        const side = `${stem}.${seg}.json`;
        if (fs.existsSync(side)) out.push(side);
      }
    }
    out.push(r);
  }
  return out;
}

// Defend the queries against a partial/old-engine/hand-edited report: the §2 required fields are
// defaulted, and a WRONG-TYPE field is coerced — a non-array `inferred` (e.g. the string "Net") must
// NOT survive, or `new Set("Net")` iterates characters into {N,e,t} (a fabricated effect set). Array
// only when actually an array, and STRING elements only; else []. The §2 forward-compatibility posture
// applied to the consumer. The coercion is what keeps the READ-ONLY queries never-crash / never-fabricate;
// on a VERDICT route it is not enough on its own, which is what `entryCorruptKeys` below exists for.
function normFn(e) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const o = { ...e, inferred: arr(e.inferred), direct: arr(e.direct), calls: arr(e.calls) };
  // The optional string-array fields are rewritten ONLY when present, so "omitted when empty" survives
  // (`show` gates each on `?.length`) — but when present they get the same element filter, because a
  // non-string in `unknownWhy` reaches `reasonClass()` and one in `hosts`/`netClass` reaches the ⟨0.20⟩
  // destination-class matcher.
  for (const k of ["unknownWhy", "netClass", "hosts", "cmds", "paths", "tables",
                   "declared", "undeclared", "overdeclared"]) if (k in e) o[k] = arr(e[k]);
  return o;
}

// ⟨0.24⟩ SPEC §2: **A KEY THAT IS PRESENT BUT UNPARSEABLE IS CORRUPT INPUT, AND MUST NEVER BE COERCED TO
// ITS EMPTY VALUE.** `normFn` above coerces, and on a read-only query that is right — it returns what it
// found and asserts nothing. On a VERDICT route it is the fail-open direction, because under ⟨0.21⟩ an
// entry's absence from `functions` is a POSITIVE PURITY CLAIM: an entry whose `inferred` cannot be read
// silently becomes an entry with no effects, which is not a gap but a lie. Measured: `{"fn":"app.bad",
// "inferred":[1],"direct":[1]}` under `deny Net` gated exit 0 with `{"ok":true,"violations":[]}`.
//
// So the loaders ALSO record which keys were present-but-unparseable, and the verdict routes refuse on
// that (see `loadGateReport`'s `corrupt` and query.mjs's `gate --report`). ABSENT is NOT corrupt — absent
// takes its documented default, which is the whole distinction the rule draws; only a key that is THERE
// and of the wrong shape is a refusal. Scoped to the §2 keys a verdict reads: `fn` (the entry's identity
// — §2-required, and an entry with no name is a claim about nothing), the effect sets the policy matches
// on, the ⟨0.19⟩/⟨0.20⟩ class fields it scopes with, and the `calls` edges the reason-class fixpoint runs
// over. `loc`/`hash`/`unitKind`/`invisible`/`unresolved` are deliberately NOT here: no verdict reads them,
// so refusing on them would be a spurious refusal on a report whose gate-relevant content is intact.
const VERDICT_STR_ARRAY_KEYS = ["inferred", "direct", "calls", "unknownWhy", "netClass", "hosts",
                                "declared", "undeclared", "overdeclared"];
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
export function entryCorruptKeys(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["<entry is not an object>"];
  const bad = [];
  if (typeof e.fn !== "string") bad.push("fn");
  for (const k of VERDICT_STR_ARRAY_KEYS) if (k in e && !isStrArray(e[k])) bad.push(k);
  return bad;
}

/** ⟨0.24⟩ The same present-but-unparseable question asked of a WHOLE PARSED REPORT rather than one entry —
 *  for the CHAINED-dep route in scan.mjs, which reads a foreign report it did not produce and joins it into
 *  its own. It lives here beside `entryCorruptKeys` for the reason `claimsToHaveJudgedNothing` does: the
 *  chained route and the `gate --report` route must read the same key the same way, or a report refused by
 *  one is believed by the other. `functions` present-but-not-an-array short-circuits (there are no entries
 *  to walk). `unanalyzed` is deliberately NOT here — scan.mjs's `incomplete` conjunct already fails closed
 *  on a malformed one, and its "declares source it could not analyze" remedy is the more specific message.
 *  Returns [] for an intact report, so the caller's conjunct is `.length > 0`. */
export function reportCorruptKeys(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  if ("functions" in parsed && !Array.isArray(parsed.functions)) return ["`functions` (present but not an array)"];
  const bad = [];
  for (const e of parsed.functions ?? []) {
    const k = entryCorruptKeys(e);
    if (k.length) bad.push(`${typeof e?.fn === "string" ? `entry \`${e.fn}\`` : "an entry"}: ${k.map((x) => `\`${x}\``).join(", ")}`);
  }
  return bad;
}

// Normalize a parsed report's `functions` into clean entries. A non-array `functions`, or an entry that
// isn't an object with a STRING `fn`, is DISCLOSED and dropped — it would otherwise crash a query
// (`map()` deref on a fn-less entry) or fabricate a junk entity (a primitive normalized into `{0:'t',…}`).
// The never-crash / never-fabricate posture for malformed input from any engine's report.
// Returns `{entries, corrupt}`: `corrupt` NAMES every present-but-unparseable §2 key (SPEC §2 ⟨0.24⟩,
// `entryCorruptKeys`), for the verdict routes that must refuse rather than believe the coerced default.
function normFns(parsed, source) {
  const raw = parsed && typeof parsed === "object" && parsed.functions !== undefined ? parsed.functions : parsed;
  if (!Array.isArray(raw)) {
    console.error(`candor-ts: report ${source} has no functions array — OMITTED from this query (malformed report)`);
    return { entries: [], corrupt: ["`functions` (absent, or not an array)"] };
  }
  const out = [], corrupt = [];
  for (const e of raw) {
    const bad = entryCorruptKeys(e);
    if (bad.length) {
      const who = typeof e?.fn === "string" ? `entry \`${e.fn}\`` : "an entry";
      corrupt.push(`${who}: ${bad.map((k) => `\`${k}\``).join(", ")}`);
      console.error(`candor-ts: report ${source}: ${who} has present-but-unparseable §2 key(s) ${bad.map((k) => `\`${k}\``).join(", ")}`
        + ` — a key that is THERE but of the wrong shape is corrupt input, not an empty one (SPEC §2 ⟨0.24⟩)`);
    }
    if (e && typeof e === "object" && typeof e.fn === "string") out.push(normFn(e));
    else console.error(`candor-ts: report ${source} has a malformed entry (no string \`fn\`) — skipped`);
  }
  return { entries: out, corrupt };
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
      const doc = JSON.parse(fs.readFileSync(f, "utf8"));
      const p = doc?.package;
      if (typeof p === "string" && p) return p;
      // The `packages` PLURAL envelope — the JVM shape (SPEC §2): one entry names it verbatim; several
      // name their longest common dotted prefix (`com.a.x` + `com.a.y` → `com.a`); none shared → null.
      if (Array.isArray(doc?.packages)) {
        const label = packagesLabel(doc.packages.filter((x) => typeof x === "string" && x));
        if (label) return label;
      }
    } catch { /* unreadable sibling — keep looking */ }
  }
  return null;
}

// The longest common dot-separated prefix of a plural `packages` list — whole segments only (`com.ab` +
// `com.ac` share `com`, not `com.a`); null when nothing is shared. Mirrors Rust's packages_label (tour.rs).
function packagesLabel(pkgs) {
  if (pkgs.length === 0) return null;
  if (pkgs.length === 1) return pkgs[0];
  const first = pkgs[0].split(".");
  let n = first.length;
  for (const p of pkgs.slice(1)) {
    const segs = p.split(".");
    let i = 0;
    while (i < Math.min(n, segs.length) && segs[i] === first[i]) i++;
    n = i;
    if (n === 0) return null; // nothing shared — the basename fallback is more honest
  }
  return first.slice(0, n).join(".");
}

/** ⟨0.15 staged⟩ the report's §2 `coverage` envelope field (COVERAGE-DESIGN.md §1) — the κ ledger of
 *  packages whose effects were INVISIBLE to the scan (absent, NOT a claim they're pure). Returns the
 *  normalized uncovered list [{name, calls}] (multi-report siblings merged, counts summed, sorted the
 *  producer's way: count desc, name asc), or null when absent/empty — the pre-0.15 report and the
 *  fully-covered report look identical here, and null keeps the consumer's output field OMITTED
 *  (never a fabricated `coverage: []` claim over a report that never carried the field). */
export function reportCoverage(prefix) {
  const files = fs.existsSync(`${prefix}.json`) ? [`${prefix}.json`] : siblings(prefix, isReport);
  const merged = new Map();
  for (const f of files) {
    try {
      const unc = JSON.parse(fs.readFileSync(f, "utf8"))?.coverage?.uncovered;
      if (!Array.isArray(unc)) continue;   // absent/malformed field → contributes nothing (§2 forward-compat)
      for (const e of unc) {
        // Tolerate a foreign/hand-edited entry: a string `name` is required; a non-numeric `calls`
        // counts as 0 (the entry still NAMES the blind spot — dropping it would under-disclose).
        if (e && typeof e === "object" && typeof e.name === "string" && e.name) {
          const n = typeof e.calls === "number" && Number.isFinite(e.calls) ? e.calls : 0;
          merged.set(e.name, (merged.get(e.name) ?? 0) + n);
        }
      }
    } catch { /* unreadable sibling — the reportVersion posture: keep looking */ }
  }
  if (merged.size === 0) return null;
  return [...merged.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
    .map(([name, calls]) => ({ name, calls }));
}

/** ⟨0.15 staged⟩ gains' coverage disclosure (COVERAGE-DESIGN.md §3) — the OPTIONAL blocks the gains
 *  JSON carries, computed from the two reports' envelopes. ONE code path for the CLI verb and the MCP
 *  `candor_gains` tool (the parity rule). Returns a spreadable object:
 *   · `coverage: {uncovered:[{name,calls}]}` — the CURRENT report's ledger, when non-empty (a gained
 *     effect in an uncovered dep is invisible, so "no gains" must not read as total);
 *   · `coverageDelta: {nowUncovered:[name], noLongerUncovered:[name]}` — whenever the two ledgers
 *     NAME different packages (a dep becoming uncovered between scans is itself a signal). The field
 *     names are the java reference engine's exactly (cross-engine wire parity). Keyed on names, not
 *     counts: a call-count wobble is ordinary code change, a new blind package is the alarm.
 *  Both omitted when nothing applies — a coverage-free comparison is byte-identical to ⟨0.14⟩. */
export function gainsCoverage(curPrefix, basePrefix) {
  const cur = reportCoverage(curPrefix);
  const base = reportCoverage(basePrefix);
  const out = {};
  if (cur) out.coverage = { uncovered: cur };
  const curNames = new Set((cur ?? []).map((e) => e.name));
  const baseNames = new Set((base ?? []).map((e) => e.name));
  const nowUncovered = [...curNames].filter((n) => !baseNames.has(n)).sort();
  const noLongerUncovered = [...baseNames].filter((n) => !curNames.has(n)).sort();
  if (nowUncovered.length || noLongerUncovered.length) out.coverageDelta = { nowUncovered, noLongerUncovered };
  return out;
}

/**
 * ⟨0.28⟩ SPEC §2 — AND THE SAME MUST CARRIES THE ⟨0.21⟩ MANIFEST, WHICH IS THE STRONGER CAVEAT.
 *
 * `gainsCoverage` above has carried the CURRENT report's `coverage` ledger into this verb since ⟨0.15⟩,
 * for the reason §2 gives: *a "no gains" over an uncovered dep reads clean with false confidence*.
 * MEASURED: the same verb, on the same report, in the same output, dropped `unanalyzed`.
 * `coverage.uncovered` says *I could not see into this dependency*; `unanalyzed` says *I could not read
 * this file of your own code*, and `analyzed.count: 0` says *I judged nothing at all*. The mechanism was
 * already here and pointed at the weaker field.
 *
 * BOTH SIDES, DISCLOSED SEPARATELY, because a gains answer rests on TWO reports and they fail in
 * different directions:
 *   · an incomplete CURRENT means the gained set may be SHORT — effects the reader is not being told
 *     about, which is the whole thing this alarm verb exists to name;
 *   · an incomplete BASELINE means the comparison FLOOR is soft, so the existing-vs-new `origin` split
 *     is unreliable and an effect that was always there can read as newly appeared.
 * One combined flag would say "something here is incomplete" and leave a supply-chain reviewer unable to
 * act on it. This is why gains does NOT use `absorbCompleteness` (which `containment <baseline>` does):
 * that verb's answer is a single leak set the two manifests both qualify, while these two qualify
 * different halves of the answer. The prefixed spelling mirrors the shape already used for coverage
 * (`coverage` for the current, `coverageDelta` for the difference) rather than inventing a new one, and
 * `incomplete`/`unanalyzed`/`baselineIncomplete`/`baselineUnanalyzed` are candor-scan's key names exactly
 * (fe5d831) — this is a cross-engine wire surface.
 *
 * ONE READER (`reportCompleteness`) and ONE KEY SET (`completenessFields`), shared with the six
 * descriptive verbs, so the ⟨0.24⟩ count-0 arm cannot be answered one way here and another there. Both
 * halves are `{}` on a complete report, so an ordinary comparison stays byte-identical to ⟨0.27⟩.
 *
 * Verdict-preserving: no exit code moves. `gains` is advisory by default and `--strict` keys on the
 * GAINED SET, which this does not touch.
 */
export const gainsCompletenessFields = (cur, base) => ({
  ...completenessFields(cur),
  ...Object.fromEntries(Object.entries(completenessFields(base))
    .map(([k, v]) => [`baseline${k[0].toUpperCase()}${k.slice(1)}`, v])),
});

/** The prefix-level form — the `gainsCoverage` signature, for callers that hold two locators and no
 *  completeness objects (the MCP `candor_gains` tool; the parity rule). */
export const gainsCompleteness = (curPrefix, basePrefix) =>
  gainsCompletenessFields(reportCompleteness(curPrefix), reportCompleteness(basePrefix));

// The returned array carries a non-enumerable `hardFail` flag: true iff a report file was FOUND but
// yielded NO trustworthy functions — a parse failure OR a malformed shape (a `null`/array/wrong-typed
// doc, a non-array `functions`, all-junk entries). The loud CLI wrapper (loadReportOrDie) needs it to
// tell "the report we found was corrupt" (never an all-clear) apart from a well-formed EMPTY report.
const tagHardFail = (fns, hardFail) => { Object.defineProperty(fns, "hardFail", { value: hardFail, enumerable: false }); return fns; };

// A well-formed report that legitimately lists ZERO functions — the ONLY empty result that is NOT a
// corruption (parity with the Rust engine, which returns Ok(empty) for a valid empty envelope). A §2
// envelope with `functions: []`, or a legacy bare `[]`. Anything else empty is malformed → hard fail.
const isCleanEmptyReport = (parsed) =>
  (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.functions) && parsed.functions.length === 0)
  || (Array.isArray(parsed) && parsed.length === 0);

/** ⟨0.24⟩ Does this report say it judged NOTHING? SPEC §2's three-row table, plus the fail-closed row the
 *  table implies. ONE rule, TWO routes: `scan.mjs` asks it of every CHAINED dep report (where the answer
 *  decides coverage — see `unjudgedDepPkgs` there for the defect and the measurement) and `gate --report`
 *  asks it of the report it was handed DIRECTLY, because §3.1 ⟨0.24⟩ puts the obligation on the READING,
 *  not on the route the report arrived by. It lives here so the two can never drift into two readings of
 *  the same integer. `fns` is the report's entries, consulted ONLY on the manifest-absent row.
 *
 *   · `analyzed.count` numeric and <= 0  → judged nothing. A report with no judgment in it is not an
 *     all-clear: its silence licenses no purity claim about any unit.
 *   · `analyzed.count` numeric and > 0   → judged n units. UNCHANGED — including the ordinary non-empty
 *     `functions` case, and including `n > 0` with `functions: []`, which is a legitimate all-pure claim
 *     §2 rule 3 requires a consumer to BELIEVE. That row is the CONTROL: keying this on the emptiness of
 *     `functions` instead would not implement the rule, it would disable the claim rule 3 protects (java
 *     measured 1997 dependency jars: 79 count-0 reports of which 6 granted coverage, against 104
 *     legitimate all-pure ones — the plausible fix withdraws 104 real claims to catch 6).
 *   · `analyzed` ABSENT → a pre-⟨0.21⟩ producer with no manifest: judged-nothing IFF there are no
 *     entries (spec row 3). One that LISTS functions demonstrably judged units and said so the only way
 *     it could, so it keeps the standing it has always had.
 *   · `analyzed` PRESENT but unreadable (`"oops"`, `{}`, `null`, a non-numeric `count`) → a judgment
 *     claim that cannot be READ is not a claim: FAIL CLOSED. A denylist of proven-safe shapes. */
export const claimsToHaveJudgedNothing = (parsed, fns) => {
  if (!parsed || typeof parsed !== "object" || !("analyzed" in parsed)) return !(fns ?? []).length;
  const a = parsed.analyzed;
  if (!a || typeof a !== "object" || Array.isArray(a)) return true;      // unreadable manifest → not a claim
  if (typeof a.count !== "number" || !Number.isFinite(a.count)) return true;
  return a.count <= 0;
};

/** ⟨0.24⟩ The same question asked of a PREFIX rather than of one parsed doc — for the consumers that read
 *  a report they did not produce and hold no envelope: the MCP `candor_gate` tool and the LSP's live gate.
 *  Both take a `--report`/`initializationOptions.report` locator and both answer "no violations" off it,
 *  so a report that judged nothing reaches an AGENT as a clean bill of health by the exact route SPEC §3.1
 *  ⟨0.24⟩ describes ("the obligation is on the reading, not on the route by which the report arrived").
 *  A prefix with NO report files is not judged-nothing — it is nothing at all, and each caller already has
 *  a loud not-found path for it (`hasReport`). ANDed across the multi-report siblings for the reason
 *  `loadGateReport` records: the union has judged something as soon as one member has. */
export function reportJudgedNothing(prefix) {
  const files = reportFilesAt(prefix);
  if (!files.length) return false;
  return files.every(fileClaimsJudgedNothing);
}
// The per-FILE question the two prefix-level readers above and below share — extracted so the boolean
// (the gate's ANDed "did this locator judge anything at all") and the ⟨0.28⟩ disclosure (WHICH member
// files judged nothing) cannot drift into two readings of the same integer.
function fileClaimsJudgedNothing(f) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return true; }   // unreadable → no claim
  // The raw entries, read QUIETLY: this is an advisory, and its caller has already run the loud loader
  // over the same bytes, so re-disclosing a malformed shape here would double every such line.
  const raw = parsed && typeof parsed === "object" && parsed.functions !== undefined ? parsed.functions : parsed;
  return claimsToHaveJudgedNothing(parsed, Array.isArray(raw) ? raw : []);
}
/** ⟨0.28⟩ The report FILES under a locator that say they judged nothing — one path per file, the shape
 *  the disclosure carries (see `completenessFields`). PER FILE, not the ANDed prefix answer: a locator
 *  naming several members must disclose EACH silent one by name (rust `report_completeness`, java
 *  `ReportCompleteness` — "one label per report file declaring `analyzed.count: 0`").
 *
 *  A file that does not PARSE is excluded here and carried as `unreadable` instead — `judgedNothing` is
 *  the report's OWN `analyzed.count: 0` assertion, and a file whose bytes cannot be read asserted
 *  nothing. MEASURED (candor-spec conformance/gen_key_shapes.py corpus, 2026-08-12): over an intact
 *  report with a corrupt `.dep` sibling, rust and swift answer `incomplete: true` alone while this
 *  engine listed the corrupt file under `judgedNothing` — a fabricated claim about content nobody read,
 *  and a consumer told "re-scan, that report reached no conclusion" when the repair is "that file is
 *  corrupt". `fileClaimsJudgedNothing`'s own unreadable→true stays: `reportJudgedNothing` above is the
 *  gate's ANDed fail-closed question, where "no readable claim" must never read as "judged something". */
export function reportJudgedNothingFiles(prefix) {
  return reportFilesAt(prefix).filter((f) => fileParses(f) && fileClaimsJudgedNothing(f) && !fileHasNoManifest(f));
}

/** ⟨0.28⟩ SPEC §2 — **THE THIRD ROW IS NOT THE FIRST ROW.** §2's three-row table distinguishes
 *  `analyzed.count: 0` (row 1 — *nothing was judged*, a claim the report MAKES) from `analyzed` ABSENT
 *  (row 3 — a pre-⟨0.21⟩ producer with no manifest at all, which claims nothing). MEASURED here
 *  2026-08-12 over `{"candor":{…},"functions":[]}` with no `analyzed` key: this engine listed the file
 *  under `judgedNothing` and its note said the report *"say[s] they JUDGED NOTHING (`analyzed.count:
 *  0`)"*. **The report declares nothing.** The HEDGE is the right direction — row 3's own instruction is
 *  *no manifest, no claim* — but the disclosure is FALSE, and this family rates a false disclosure worse
 *  than a missing one (§3.4's `net-partner` finding: an engine reported "ignoring unknown config key"
 *  while honouring it).
 *
 *  It is also a hole in ⟨0.28⟩'s own pin, which defines `judgedNothing` as *reports declaring
 *  `analyzed.count: 0`*: putting a row-3 report there makes the key mean two things and loses the
 *  distinction the table exists to draw. The REPAIRS differ — row 1 wants a scan that reaches a
 *  conclusion, row 3 wants a producer that emits a manifest at all.
 *
 *  A legacy BARE ARRAY report has no envelope and therefore no manifest either, so it is row 3 too when
 *  it is empty; when it LISTS entries it is not hedging at all (`claimsToHaveJudgedNothing` is false) and
 *  never reaches this filter. Asked of the same parsed bytes as its two siblings so the three cannot
 *  drift into three readings of one file. */
const fileHasNoManifest = (f) => {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return false; }  // unreadable → `unreadable`
  if (Array.isArray(parsed)) return true;                       // legacy bare array: no envelope, no manifest
  return !!parsed && typeof parsed === "object" && !("analyzed" in parsed);
};

/** ⟨0.28⟩ The consulted report FILES carrying no `analyzed` key at all — SPEC §2's row 3, pinned to its
 *  own key (`noManifest`) in the rung that introduced it. Only the files that are also HEDGING: a row-3
 *  report that LISTS functions demonstrably judged units and said so the only way it could, and keeps the
 *  standing it has always had (`claimsToHaveJudgedNothing`'s manifest-absent row). */
export function reportNoManifestFiles(prefix) {
  return reportFilesAt(prefix).filter((f) => fileParses(f) && fileHasNoManifest(f) && fileClaimsJudgedNothing(f));
}

/** ⟨0.28⟩ Does the file's TEXT parse at all — the line between "this report says X" and "this report
 *  says nothing readable". Parse-only on purpose: shape defects inside a parsed document are judged per
 *  key role (SPEC §2 ⟨0.24⟩) by the loaders, not here. */
const fileParses = (f) => {
  try { JSON.parse(fs.readFileSync(f, "utf8")); return true; } catch { return false; }
};

/** ⟨0.28⟩ The report FILES under a locator that could not be read at all — the THIRD cause, and it is a
 *  cause of `incomplete` with NO wire key of its own (rust and swift both answer `incomplete: true` and
 *  name the file on the human channel only; matching them is the point — one wire shape per state).
 *  Before this arm existed, `reportUnanalyzed` skipped an unparseable member with a bare `catch` and the
 *  corrupt file surfaced only through the judged-nothing mislabel above. */
export function reportUnreadableFiles(prefix) {
  return reportFilesAt(prefix).filter((f) => !fileParses(f));
}

// Load ONE report file → { entries, hardFail }. A read/parse throw, or an empty result over a doc that
// is NOT a clean-empty report, is a hard fail (the file was found but carries no trustworthy functions —
// letting it read as [] would be the §4 false all-clear). Discloses every failure mode on stderr.
function loadOneReport(file, label) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { console.error(`candor-ts: report ${label} failed to parse — its functions are OMITTED from this query (corrupt or mid-write); re-run the scan`); return { entries: [], hardFail: true }; }
  const { entries, corrupt } = normFns(parsed, label);
  // normFns already DISCLOSED any malformation (no functions array / dropped entries / a present-but-
  // unparseable §2 key). If nothing usable survived AND the doc wasn't a clean-empty report, the report is
  // corrupt — fail loud, never empty. A present-but-unparseable §2 key is EQUALLY a hard fail even when
  // other entries survived (SPEC §2 ⟨0.24⟩): under ⟨0.21⟩ the coerced-empty entry is a purity CLAIM, so
  // believing the survivors would certify a package whose corrupt entry is exactly where the violation
  // would have been. `hardFail` is only consulted by the loud wrappers, so the tolerant read-only queries
  // keep returning what they found (see loadReportOrDie / loadReportLoud).
  if (entries.length === 0 && !isCleanEmptyReport(parsed)) {
    console.error(`candor-ts: report ${label} yielded no usable functions — OMITTED (malformed report); re-run the scan`);
    return { entries, hardFail: true, corrupt };
  }
  return { entries, hardFail: corrupt.length > 0, corrupt };
}

/**
 * ⟨0.24⟩ SPEC §3.2 — the `unanalyzed` COMPLETENESS MANIFEST at a prefix, for the ADVISORY verbs, merged
 * across sibling reports. A SECOND, LENIENT reader beside `loadGateReport`'s, and the leniency is the
 * point: the gate route is CERTIFYING, so a malformed manifest there is a hard fail that names the key;
 * these verbs are advisory, and refusing to answer at all is strictly less than the partial answer §3.2
 * asks for. So it reads silently and never fails a load. (candor-swift `mergeUnanalyzed`, same reasoning.)
 *
 * The ELEMENT rule is candor-ts's own gate normalization rather than swift's, deliberately: swift skips a
 * member with no string `path`, ts's gate normalizes it to `{path:"", reason:""}` and still trips the
 * incompleteness. Skipping here would make the advisory verb LESS sensitive than the gate over the same
 * bytes — a report the gate exits 2 on, and `unverified` answers `ok: true` over. That is the exact
 * under-report this rung exists to close, so the manifest counts an element the moment it is an object.
 */
export function reportUnanalyzed(prefix) {
  const out = [];
  for (const f of reportFilesAt(prefix)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue; // legacy bare array: no envelope
    const us = parsed.unanalyzed;
    if (!Array.isArray(us)) continue;
    for (const u of us)
      if (u && typeof u === "object" && !Array.isArray(u))
        out.push({ path: typeof u.path === "string" ? u.path : "", reason: typeof u.reason === "string" ? u.reason : "" });
  }
  return out;
}

/**
 * ⟨0.28⟩ SPEC §2 — THE SAME MANIFEST, READ FOR A *DESCRIPTIVE* VERB. `reportUnanalyzed` above was written
 * for the ADVISORY verbs, because the clause it implements was written over the instance it was found in:
 * "a report-consuming verb whose VERDICT could change". ⟨0.28⟩ corrects the clause to the condition that
 * makes it true — the obligation binds **any verb whose output could be read as a negative finding about
 * the code: a verdict, an EMPTY RESULT SET, or a ZERO COUNT**. MEASURED on this engine over the standard
 * post-⟨0.28⟩ artifact (`analyzed.count: 0` + a non-empty `unanalyzed`, what an armed run leaves on disk):
 *
 *     where Fs     {"effect":"Fs","directly":[],"inherited":[]}    exit 0, no hedge
 *     map          {}                                              exit 0, no hedge
 *     blindspots   {"sources":[],"totalUnknown":0}                 exit 0, no hedge
 *     reachable    {"entryPoints":0,"effects":{}}                  exit 0, no hedge
 *     containment  {"contained":[],"ambient":{}}                   exit 0, no hedge
 *     tour         {"reaches":[]}                                  exit 0, no hedge
 *
 * "no blind spots" out of a report whose own manifest names a file candor could not read. A consumer
 * cannot distinguish *nobody performs Fs* from *nothing was examined*.
 *
 * ONE READER, TWO CAUSES, and the second cause is why this is a function rather than a call to
 * `reportUnanalyzed` at six new sites:
 *
 *   · `unanalyzed` non-empty — candor could not READ a file of the target's own code;
 *   · `analyzed.count: 0` — candor read what it read and JUDGED NOTHING. A report in that state carries
 *     no `unanalyzed` at all (there is no unread FILE to name), so a manifest-only reader sees a complete
 *     report and every verb answers `{}` over it just the same. SPEC §2 names both: *"a report-consuming
 *     verb MUST re-disclose a non-empty `unanalyzed`, **and an `analyzed.count` of 0**, on the same
 *     terms"*. Decided by `reportJudgedNothing` — the SAME predicate `gate --report`, the MCP gate and the
 *     LSP already ask — so a report cannot be judged-nothing on one route and not on another.
 *
 * A report that is BOTH complete and has judged something yields `mustHedge() === false`, and every
 * consumer below is then a no-op: an ordinary run stays byte-identical. That is not a nicety — a hedge on
 * every run trains the reader to ignore it, the same reason ⟨0.15⟩ omits `coverage` when nothing is
 * uncovered.
 */
export function reportCompleteness(prefix) {
  // `judgedNothing` is the PER-FILE list, not the ANDed boolean the gate asks: the disclosure names
  // WHICH report judged nothing, so a locator with one silent member among several still hedges — the
  // semantics rust and java pin, and a repair the reader can aim (that file, not "somewhere here").
  // ⟨0.28⟩ `unreadable`: the third cause, split out of the judged-nothing mislabel — see
  // `reportUnreadableFiles`. It hedges the answer and names the file on the human channel only.
  // ⟨0.28⟩ `noManifest`: SPEC §2's row 3, split out of the `judgedNothing` mislabel — see
  // `reportNoManifestFiles`. It hedges like the others and carries its own wire key, because the two
  // want different repairs and because `judgedNothing` is PINNED to "reports declaring `analyzed.count:
  // 0`", which a row-3 report is not.
  return { unanalyzed: reportUnanalyzed(prefix), judgedNothing: reportJudgedNothingFiles(prefix),
           noManifest: reportNoManifestFiles(prefix), unreadable: reportUnreadableFiles(prefix) };
}

/**
 * ⟨0.28⟩ Is there anything to disclose? **The trigger for an ANSWER, where a non-empty `unanalyzed` alone
 * is the trigger for a VERDICT** — and the difference is an exit code, not a mood.
 *
 * `unverified --strict` / `fix-gate --strict` answer 2 ("the gate refuses over these bytes, so do I") off
 * the `unanalyzed` arm — and ⟨0.28⟩ off the `unreadable` arm too, because `gate --report` REFUSES over a
 * corrupt member (measured, exit 2) and §3.2's relation binds the exit as much as the document. ⟨0.24⟩
 * ruled the count-0 arm explicitly the other way for exactly those bytes: it is *a disclosure, not an
 * exit code* — `gate --report` exits 0 over a judged-nothing report, and a verb exiting 2 there would
 * claim it got LESS far than the gate on identical input, the mirror of the over-claim the strict exit
 * exists to prevent. So count-0 reaches both DISCLOSURE channels through this predicate and stops at the
 * exit code; see `advisoryAnswer`, whose exit-bearing callers key `--strict` on manifest + unreadable.
 */
export const mustHedge = (c) => !!(c && (c.unanalyzed?.length || c.judgedNothing?.length
                                         || c.noManifest?.length || c.unreadable?.length));

/**
 * ⟨0.28⟩ The disclosure KEYS, defined ONCE, for spreading into a verb's answer document — `{}` when there
 * is nothing to disclose, so `{ ...data, ...completenessFields(c) }` is byte-identical to `data` on a
 * complete report. (JS objects preserve insertion order, so the verb's own keys keep their pinned order
 * and the caveat lands after them. candor-rust's first draft of this rung routed two verbs through a
 * BTreeMap-backed serialiser to reach the same place and silently RE-SORTED both documents on ordinary
 * runs — a disclosure rung must not reformat the answers it is disclosing about.)
 *
 * `incomplete: true` is the flag EITHER cause raises, so a consumer that only branches on it is safe under
 * both; `judgedNothing`/`unanalyzed` name WHICH, because the two want different repairs — one wants a scan
 * that can READ a file, the other a scan that reached a conclusion. Each is omitted when it does not
 * apply, so a document raised by `unanalyzed` alone stays byte-identical to the pre-⟨0.28⟩ advisory shape.
 *
 * `judgedNothing` is the ARRAY OF REPORT PATHS, the shape rust, java and swift all emit — this engine
 * first shipped `judgedNothing: true`, reusing the MCP gate tool's spelling, and a consumer doing
 * `doc.judgedNothing.length` got a TypeError here while one doing `=== true` missed the other three.
 * The array also answers a question the boolean cannot: WHICH report judged nothing, over a multi-report
 * locator. The two spellings now deliberately differ because they are different surfaces: THIS key rides
 * answer/advisory documents and is the cross-engine wire shape; the MCP gate tool's `judgedNothing: true`
 * (mcp.mjs) is a flag on ONE gate verdict about ONE locator, where "which file" is carried by the
 * adjacent ⟨0.24⟩ prose and no sibling engine serves that tool — the wire shape governs everywhere the
 * engines can be diffed.
 */
export function completenessFields(c) {
  if (!mustHedge(c)) return {};
  // `unreadable` raises the flag and adds NO key of its own — measured, rust and swift answer
  // `incomplete: true` alone over a corrupt sibling, and a third spelling here would be the
  // judgedNothing three-way split again, minted by the engine that was fixing it.
  // ⟨0.28⟩ `noManifest` is the third NAMED cause, `omitted when empty` like the other two, and it RAISES
  // `incomplete` exactly as they do — the flag stays the one key a consumer may branch on alone and be
  // safe under every cause. It is separate from `judgedNothing` because that key is pinned to "reports
  // declaring `analyzed.count: 0`" and a row-3 report declares nothing: merging them would make one key
  // mean two things and lose the distinction §2's three-row table exists to draw.
  return { incomplete: true,
           ...(c.unanalyzed?.length ? { unanalyzed: c.unanalyzed } : {}),
           ...(c.judgedNothing?.length ? { judgedNothing: c.judgedNothing } : {}),
           ...(c.noManifest?.length ? { noManifest: c.noManifest } : {}) };
}

/**
 * ⟨0.28⟩ Union in a SECOND locator's manifest — for `containment <baseline>`, whose answer is a DIFFERENCE
 * and is therefore unsound if EITHER side is partial, in opposite directions: a leak living in an unread
 * file of the CURRENT tree is missed (a false all-clear), while one living in an unread file of the
 * BASELINE reads as newly appeared (a fabricated leak, at exit 1). One merged object rather than two
 * notes, because the keys are fixed and a second write would overwrite the first side's manifest.
 */
export const absorbCompleteness = (a, b) => ({
  unanalyzed: [...(a.unanalyzed ?? []), ...(b.unanalyzed ?? [])],
  judgedNothing: [...(a.judgedNothing ?? []), ...(b.judgedNothing ?? [])],
  noManifest: [...(a.noManifest ?? []), ...(b.noManifest ?? [])],
  unreadable: [...(a.unreadable ?? []), ...(b.unreadable ?? [])],
});

/**
 * ⟨0.24⟩ SPEC §3.2 — THE OMIT-`ok` RULE, IN ONE PLACE so `unverified`, `fix-gate`, `whatif` and any later
 * sibling cannot drift apart on it. Over a report declaring `unanalyzed`, an advisory verb emits
 * `incomplete: true` plus the manifest and **OMITS `ok`**.
 *
 * NEITHER BOOLEAN IS HONEST THERE. `ok: true` asserts "nothing here is denied / everything is provably
 * clean" over a universe the verb knows it cannot see all of — a function in an unparsed file is absent
 * from `functions`, so it cannot be enumerated at all, and its absence is exactly what the verb would have
 * to report. `ok: false` would assert "a hole exists, here it is" beside an EMPTY array — the fabrication
 * mirror, and worse than the silence it replaces. So the field goes: a consumer writing `if (r.ok)` gets a
 * falsy value and fails safe, one that looks further learns precisely what went unread.
 *
 * This is deliberately NOT the refusal document's shape (`ok:false` + `refused:true`, §3.1): there
 * `ok:false` is TRUE — the gate did not certify — whereas here neither value is. A shape is copied for its
 * reasoning, not its familiarity. And the GATE keeps its `ok:false` for the same reason; it is not changed
 * to match.
 *
 * `unverified` is the sharpest case in the family — the verb whose entire job is to say "your green gate
 * is not provably green", certifying a set it knows it cannot see all of. MEASURED on this engine before
 * the fix: over a report declaring one unparsed unit, `gate --report` exits 2 with the manifest while both
 * `unverified --strict` and `fix-gate --strict` returned `ok: true` and exit 0 — and `--strict` is how CI
 * consumes both. Byte-aligned with candor-swift `emitAdvisoryAnswer`.
 *
 * ⟨0.24⟩ THE SECOND TRIGGER: `body.unevaluated` (SPEC §3.2 `4fd140c`). The general law behind the manifest
 * rule above is that an advisory verb may be LESS certain than the gate and never MORE — and a rule the
 * gate REFUSED for want of evidence withdraws `ok` for the identical reason an unread file does. Neither
 * boolean is honest: `ok: true` certifies a function the gate could not judge, and `ok: false` asserts the
 * named entries are unverified PASSES when whether they pass is the open question. The trigger is read off
 * the BODY rather than taken as a third parameter, so a verb that computes the disclosure cannot forget to
 * declare it — the ⟨0.24⟩ measurement that the CLI and MCP had drifted on exactly this began with a second
 * channel forgetting to pass an argument.
 *
 * ⟨0.28⟩ THE THIRD TRIGGER: `judgedNothing` — SPEC §2's `analyzed.count: 0` row, which this function did
 * not read. MEASURED: over a report that judged nothing, `unverified` answered `{ok: true, unverified: []}`
 * — the verb whose whole job is *"your green gate is not provably green"* certifying a package it never
 * examined, from a report that names no unread FILE to trip the manifest arm. `ok` goes for the same
 * reason it goes above: neither boolean is honest, and `if (r.ok)` must fail safe.
 *
 * AND THE EXIT CODE DOES NOT MOVE, which is the load-bearing half. Both `--strict` callers compute their
 * exit from the MANIFEST alone, never from this document, because ⟨0.24⟩ ruled count-0 explicitly the other
 * way: *"A DISCLOSURE, NOT AN EXIT CODE"*. `gate --report` exits 0 over these bytes, and an advisory verb
 * exiting 2 there would claim it got LESS far than the gate on identical input — the mirror of the
 * over-claim the strict exit exists to prevent. (`mustHedge` is the same distinction, stated for a verb
 * that has no exit code for it to matter to.)
 */
export function advisoryAnswer(body, unanalyzed, judgedNothing = [], unreadable = [], noManifest = []) {
  const unevaluated = body?.unevaluated;
  if (!unanalyzed?.length && !unevaluated?.length && !judgedNothing?.length && !unreadable?.length
      && !noManifest?.length)
    return body;  // COMPLETE: unchanged, byte for byte, `ok` and all.
  const { ok, ...rest } = body;                          // eslint-disable-line no-unused-vars -- omitted BY DESIGN
  // The array of report paths, same key and same shape as `completenessFields` — ONE wire spelling for
  // this key across the answer and advisory documents (see the shape ruling there). `unreadable` withdraws
  // `ok` and raises `incomplete` with NO key of its own, exactly as `completenessFields` rules it.
  // ⟨0.28⟩ `noManifest` DOES get a key of its own — SPEC §2 pins it — and it rides here for the same
  // reason `judgedNothing` does: an advisory verb's `ok` is a claim about the CODE, and a report that
  // never emitted a manifest cannot support it (row 3: *no manifest, no claim*).
  const judged = { ...(judgedNothing?.length ? { judgedNothing } : {}),
                   ...(noManifest?.length ? { noManifest } : {}) };
  // Key order matches the gate's verdict document: the finding, then `unevaluated`, then the manifest.
  if (unanalyzed?.length) return { ...rest, incomplete: true, unanalyzed, ...judged };
  return (judgedNothing?.length || noManifest?.length || unreadable?.length)
    ? { ...rest, incomplete: true, ...judged } : rest;
}

export function loadReport(prefix) {
  if (fs.existsSync(`${prefix}.json`)) {
    const { entries, hardFail } = loadOneReport(`${prefix}.json`, `${prefix}.json`);
    return tagHardFail(entries, hardFail);
  }
  // No exact <prefix>.json — merge the multi-report siblings (the Rust/workspace form).
  const fns = [];
  let hardFail = false;
  for (const f of siblings(prefix, isReport)) {
    // DISCLOSE a malformed sibling — never silently drop it (a vanished report reads as "no effect").
    const r = loadOneReport(f, f);
    fns.push(...r.entries);
    if (r.hardFail) hardFail = true;
  }
  return tagHardFail(fns, hardFail);
}

/**
 * ⟨0.24⟩ THE `gate --report` READER (SPEC §3.1) — the report FILE(S) at `prefix`, and nothing else.
 *
 * A SEPARATE reader was needed, and not because the existing one enriches: `loadReport` above reads the
 * same files, but it returns ONLY the `functions` array and THROWS THE ENVELOPE AWAY. The gate verdict is
 * `{spec, ok, analyzed:{count}, violations, incomplete?, unanalyzed?, coverage?}` — three of those fields
 * are ⟨0.21⟩/⟨0.15⟩ ENVELOPE facts, so a verb that must produce a document byte-equal to `scan --policy`'s
 * cannot be built on a loader that discards them. Reading them in a SECOND pass would be worse than a
 * second reader: the envelope and the entries would come from two reads of a file another process may
 * rewrite between them (scan writes atomically, so one read is always one coherent report). Hence: one
 * pass, one parse per file, entries AND envelope out of the same bytes.
 *
 * WHAT IT DELIBERATELY DOES NOT READ, because §3.1 ⟨0.24⟩ forbids improving the input ("An engine MUST NOT
 * re-derive, widen, or re-classify anything while serving this verb … a report entry that is ABSENT is
 * absent — the ⟨0.21⟩ purity claim — and MUST NOT be back-filled from a callgraph sidecar or a chained
 * dep"): no `.callgraph.json` (`loadCallgraph`, which `callers`/`tour`/`fix`/`fix-gate`/`unverified --class`
 * all call), no `.hierarchy.json`, no `.locs.json`, no `CANDOR_DEPS`/`.candor/config` `deps` chaining, no
 * `net-partner` re-mapping of the `netClass` this report already states. The reach the reason-class
 * fixpoint runs over is the entries' OWN §2 `calls` field — report data in, report data out.
 *
 * Returns `{functions, analyzed, unanalyzed, coverage, judgedNothing, hardFail, corrupt}`. `hardFail`
 * carries the `loadReport` meaning exactly: a file was FOUND and yielded nothing trustworthy (never "there
 * was no file" — the caller's `requireReport` owns that), so a corrupt report can be refused instead of
 * gated green. `corrupt` NAMES every present-but-unparseable §2 key found (SPEC §2 ⟨0.24⟩ requires the
 * refusal to name the key), entry-level and envelope-level; non-empty implies `hardFail`.
 * `judgedNothing` is the ⟨0.24⟩ reading of `analyzed.count` (see `claimsToHaveJudgedNothing`).
 */
export function loadGateReport(prefix) {
  const files = reportFilesAt(prefix);
  const functions = [], unanalyzed = [], cov = new Map(), corrupt = [];
  let hardFail = false, analyzed = 0;
  // ⟨0.24⟩ did the report handed to the gate judge ANYTHING? Per FILE, then ANDed across the multi-report
  // siblings, because the union of several reports has judged something as soon as ONE of them has — the
  // same union the `functions` arrays and the `analyzed` counts take one line down. Answered by the SHARED
  // predicate (see `claimsToHaveJudgedNothing`), never re-derived from the summed count: a bare-array
  // legacy report `continue`s past the envelope block below with a count of 0 and would read as
  // judged-nothing on the sum alone, while its entries are exactly the evidence that it judged units.
  let judgedNothing = true;
  for (const f of files) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch { console.error(`candor-ts: report ${f} failed to parse — its functions are OMITTED from this gate (corrupt or mid-write); re-run the scan`); hardFail = true; continue; }
    const { entries, corrupt: entryCorrupt } = normFns(parsed, f);
    if (entries.length === 0 && !isCleanEmptyReport(parsed)) {
      console.error(`candor-ts: report ${f} yielded no usable functions — OMITTED (malformed report); re-run the scan`);
      hardFail = true;
    }
    for (const c of entryCorrupt) corrupt.push(`${f}: ${c}`);
    if (!claimsToHaveJudgedNothing(parsed, entries)) judgedNothing = false;
    functions.push(...entries);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;  // legacy bare array: no envelope
    // ⟨0.21⟩ the completeness manifest. `count` SUMS across siblings, exactly as the multi-report `functions`
    // arrays concatenate — the analyzed universe of a workspace is the union of its members'.
    // ⟨0.24⟩ ABSENT vs PRESENT-BUT-UNPARSEABLE, on the two envelope keys the verdict reads. ABSENT keeps its
    // documented default (a pre-⟨0.21⟩ producer emits no `analyzed` at all, and `claimsToHaveJudgedNothing`
    // owns that row); PRESENT and of the wrong shape is corrupt input, NAMED in the refusal, never summed
    // as 0 or dropped as []. A BOOLEAN is not an integer — `typeof true` is "boolean", and swift read
    // `{count: true}` as 1 through an NSNumber bridge — and neither is a fraction or a negative (SPEC §2
    // ⟨0.24⟩: "non-integral, negative, non-numeric or otherwise unparseable"). `analyzed: {}` with `count`
    // simply ABSENT is NOT corrupt: the key is missing, so it takes the documented default and the
    // judged-nothing disclosure carries it.
    if ("analyzed" in parsed) {
      const a = parsed.analyzed;
      if (!a || typeof a !== "object" || Array.isArray(a))
        corrupt.push(`${f}: \`analyzed\` (expected an object \`{count, digest}\`)`);
      else if ("count" in a && !(typeof a.count === "number" && Number.isInteger(a.count) && a.count >= 0))
        corrupt.push(`${f}: \`analyzed.count\` (expected a non-negative integer; a boolean is not an integer)`);
      else if (typeof a.count === "number") analyzed += a.count;
    }
    // ⟨0.21⟩ `unanalyzed` — normalized to the {path, reason} pair, in THAT key order, because the verdict
    // this feeds is compared BYTE for byte against the scan's. This is the SHARPEST case of the ⟨0.24⟩ rule
    // and the spec says so: `unanalyzed` NON-EMPTINESS is the fail-closed trigger, so a silently dropped
    // element turns exit 2 into a green verdict. `unanalyzed: ["src/broken.rs"]` — a bare string list — was
    // dropped by all four engines and exited 0. A missing `reason` on an otherwise well-formed element stays
    // lenient (an absent key, defaulted to ""), and the {unit, why} shape the spec names lands there: the
    // element is an object, both keys are absent, so it normalizes to `{path:"",reason:""}` and still trips
    // the incompleteness exit — which is why ts already refused that one.
    if ("unanalyzed" in parsed) {
      const us = parsed.unanalyzed;
      if (!Array.isArray(us)) corrupt.push(`${f}: \`unanalyzed\` (expected an array of \`{path, reason}\`)`);
      else for (const u of us) {
        if (!u || typeof u !== "object" || Array.isArray(u))
          corrupt.push(`${f}: \`unanalyzed\` (an element is ${JSON.stringify(u)}, not a \`{path, reason}\` object)`);
        else if (("path" in u && typeof u.path !== "string") || ("reason" in u && typeof u.reason !== "string"))
          corrupt.push(`${f}: \`unanalyzed\` (an element's \`path\`/\`reason\` is present but not a string)`);
        else unanalyzed.push({ path: typeof u.path === "string" ? u.path : "", reason: typeof u.reason === "string" ? u.reason : "" });
      }
    }
    // ⟨0.15⟩ the κ ledger. Merged + re-sorted the PRODUCER's way (count desc, name asc by code point —
    // reportCoverage's rule, and scan.mjs's), so a single-report prefix reproduces the emitted order exactly.
    const unc = parsed.coverage?.uncovered;
    if (Array.isArray(unc))
      for (const e of unc)
        if (e && typeof e === "object" && typeof e.name === "string" && e.name) {
          const n = typeof e.calls === "number" && Number.isFinite(e.calls) ? e.calls : 0;
          cov.set(e.name, (cov.get(e.name) ?? 0) + n);
        }
  }
  const coverage = [...cov.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
    .map(([name, calls]) => ({ name, calls }));
  return { functions, analyzed, unanalyzed, coverage, judgedNothing, hardFail: hardFail || corrupt.length > 0, corrupt };
}
// The returned graph carries a non-enumerable `partial` flag (the loadReport `hardFail` precedent):
// true iff a sidecar file was MATCHED but failed to read/parse — its edges were DROPPED (disclosed on
// stderr above), so the graph is an UNDER-approximation. An ABSENT sidecar is NOT partial: nothing
// matched, and the empty graph is the whole (disclosable) truth. gains' origin ladder needs the
// distinction: over a partial baseline graph, absence from the surviving edges proves nothing, so
// labeling a dropped file's fns "new" would downgrade the attack signal — fall back to "unknown".
const tagPartial = (cg, partial) => { Object.defineProperty(cg, "partial", { value: partial, enumerable: false }); return cg; };
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
    // `null` `<prefix>.callgraph.json` (asymmetric with siblings). Tolerate (empty graph) + disclose,
    // and TAG the drop (`partial`) so a consumer never mistakes the truncated graph for the whole one.
    try { return tagPartial(norm(JSON.parse(fs.readFileSync(`${prefix}.callgraph.json`, "utf8"))), false); }
    catch { console.error(`candor-ts: callgraph ${prefix}.callgraph.json failed to parse — its edges are OMITTED from this query (corrupt or mid-write); re-run the scan`); return tagPartial({}, true); }
  }
  const cg = {};
  let partial = false;
  for (const f of siblings(prefix, (x) => x.endsWith(".callgraph.json"))) {
    try { Object.assign(cg, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { console.error(`candor-ts: callgraph ${f} failed to parse — its edges are OMITTED from this query (corrupt or mid-write); re-run the scan`); partial = true; }
  }
  return tagPartial(norm(cg), partial);
}

/**
 * ⟨0.28⟩ The call graph EMBEDDED IN THE REPORT — each entry's §2 `calls` edges, keyed by fn. The
 * fallback the graph verbs (`callers`/`impact`/`path`, CLI and MCP) run over when the §2.2 sidecar is
 * absent, exactly as rust (callers.rs: "Fallback (no call-graph sidecar): build a graph from the
 * report's effect-relevant `calls` edges and run the SAME query") and java do. Without it, a VALID
 * report queried without its sidecar — a single hand-copied `report.json`, a locator §3.3.1 supports —
 * answered `unanswerable` at exit 2 here while rust and java answered real callers at exit 0.
 * `unanswerable` is for a graph that is genuinely ABSENT, not for one present by another route.
 *
 * EVERY entry is a key, even one with no calls — a leaf that performs its effect directly must still
 * resolve as a target (rust's fallback map collects every entry). Same-named entries across merged
 * workspace siblings UNION their edges (the effectsByFn lesson: last-wins silently drops a member's
 * rows). Effect-relevant edges ONLY, so this graph under-approximates the sidecar: a pure fn appears at
 * most as a CALLEE, never a key — which is why a no-match over the fallback is INCONCLUSIVE, not proof
 * of absence (the callers verb keeps that distinction; rust corpus-audit #5).
 */
export function reportCallsGraph(fns) {
  const g = {};
  for (const e of fns) {
    const prev = g[e.fn];
    g[e.fn] = prev ? [...new Set([...prev, ...(e.calls ?? [])])] : [...(e.calls ?? [])];
  }
  return g;
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
// ⟨metadata keys⟩ A key this reader cannot interpret is DROPPED, not coerced. `norm` used to turn a
// non-array value into `[]` and KEEP the key, which puts a PHANTOM TYPE in the hierarchy — a name no code
// declares — and a phantom is not inert here: `callersFrontier`'s `hasHier` gates on
// `Object.keys(h).length > 0`, so ONE metadata key flips the frontier off the over-listing simple-name
// match onto the precise subtype test, over a hierarchy that can answer nothing. Measured on candor-java's
// first `"@superclass"` encoding (an OBJECT among arrays; since fixed producer-side to a flat array,
// candor-java `403f24b`): a flat project whose sidecar was `{}` disclosed `possibleViaUnknownDispatch:
// [app.Frontier.go]`, and the SAME project with `{"@superclass":{}}` disclosed `[]`. A metadata key
// silently narrowed a disclosure.
// The rule is deliberately asymmetric because the two mistakes are not. A phantom key can only ever
// NARROW this frontier; dropping an unknown key can only ever widen it back to the documented fallback,
// and this frontier is a disclosure that is explicitly allowed to over-list. So the `@` extension
// namespace and any non-array value both go, rather than being guessed at.
export function loadHierarchy(prefix) {
  const norm = (h) => (h && typeof h === "object" && !Array.isArray(h))
    ? Object.fromEntries(Object.entries(h).filter(([k, v]) => !k.startsWith("@") && Array.isArray(v))) : {};
  if (fs.existsSync(`${prefix}.hierarchy.json`)) {
    try { return norm(JSON.parse(fs.readFileSync(`${prefix}.hierarchy.json`, "utf8"))); } catch { return {}; }
  }
  const h = {};
  for (const f of siblings(prefix, (x) => x.endsWith(".hierarchy.json"))) {
    try { Object.assign(h, JSON.parse(fs.readFileSync(f, "utf8"))); } catch { /* tolerate */ }
  }
  return norm(h);
}

// Order two strings by UNICODE CODE POINT — the collation SPEC §3.1 ⟨0.24⟩ pins for `viaDispatchOn`
// (Rust gets it free from `BTreeSet<&str>`), AND the ordering SPEC §2 ⟨0.24⟩ pins for EVERY ordering in a
// report or a query output. JavaScript's DEFAULT `Array.sort` (and `<`, and
// `String.prototype.localeCompare`, and `Intl.Collator`) is NOT it: the first three order by UTF-16 CODE
// UNIT, so a supplementary character — stored as a surrogate pair starting U+D800 — sorts BEFORE
// everything above the surrogate block, the opposite of code-point order; `Intl.Collator` is
// locale-sensitive, which is worse still. ASCII is unaffected either way, but `<owner>.<member>` is built
// from user identifiers and all four analysed languages allow non-ASCII ones, so this is reachable.
//
// ⟨0.24⟩ The two rules are SEPARATE and the locale one is STRICTER: collation says which of the
// well-defined orders, §2 says the order must not consult the environment AT ALL — the same input on the
// same machine under a different `LC_ALL` must produce the same bytes, or "a default report is
// byte-identical" is not even a checkable claim and the effects-fingerprint has no ground. `localeCompare`
// satisfies NEITHER; this comparator satisfies both. That is not theoretical here and it is not confined to
// exotic characters: MEASURED on this build (node v23.6.0, full ICU), `"zpad".localeCompare("tpad")` is +1
// under `LC_ALL=C` and −1 under `LC_ALL=et_EE.UTF-8` — Estonian collates z between s and t — and pure-ASCII
// lowercase npm package names are exactly what the coverage ledger below is keyed by. Two scans of one
// build of one engine over one unchanged tree emitted DIFFERENT REPORT BYTES (different md5, the
// `coverage.uncovered` entries transposed). `LC_ALL=da_DK.UTF-8` breaks a second pure-ASCII pair
// (`"aardvark"` sorts AFTER `"z"`, aa = å). The old "ASCII is unaffected" reasoning held only for the
// UTF-16 hazard; it never held for the locale one.
//
// §3.1 also names UTF-8 byte order as the same ORDER — but NOT as the method, and this comparator
// deliberately does no encoding. An UNPAIRED SURROGATE is representable in a UTF-16 string yet has no UTF-8
// encoding, so encoding first maps every lone surrogate to the SAME replacement bytes and two details
// differing only there compare EQUAL. In candor-java that was also CARDINALITY-LOSSY: its accumulator is a
// comparator-backed sorted set, so "equal" meant "duplicate" and one element vanished from the join.
// MEASURED here, and it does NOT transfer: this accumulator dedups by `Set` STRING IDENTITY and orders in a
// separate `Array.sort` that never drops equal elements, so a `Buffer.compare(Buffer.from(a,"utf8"), …)`
// comparator keeps both entries (verified — the lone-surrogate test below stays green against it). The
// encoding is still refused, because that safety is a property of the accumulator, not of the comparator,
// and it evaporates the day this is refactored to a comparator-backed sorted set. Spreading a string
// yields CODE POINTS (JS string iteration is code-point-wise) and leaves a lone surrogate as itself, so
// comparing those sequences is order-correct AND lossless, with no arithmetic and nothing to evaporate.
//
// EXPORTED, and it is the ONLY string comparator in this engine — `scan.mjs` imports THIS one rather than
// growing a second. A near-copy is how the report side and the query side drift back apart, one clause at a
// time, and the drift would be invisible on the ASCII inputs every test uses.
export const byCodePoint = (a, b) => {
  const A = [...a], B = [...b];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i].codePointAt(0), y = B[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return A.length - B.length;
};

// Reflexive+transitive subtype test over the hierarchy sidecar.
//
// ⟨0.26⟩ THREE-VALUED, because the format now distinguishes what it could not before. SPEC §2.2 makes the
// KEY SET the manifest: a producer emits a key for every type it indexed, `[]` included, so a type with NO
// key is one the pass never looked at. `hierarchy[t] ?? []` read those two cases alike and answered
// `false` — a positive claim about a type nobody analysed.
//
// MEASURED before the rung, doctoring only the sidecar of a real scan: removing the REACHING implementor's
// entry silently dropped the dispatcher from `possibleViaUnknownDispatch` (`[]` where the control gives
// `[Dispatcher.run]`), while removing the sidecar ENTIRELY left it correct — the ⟨0.24⟩ per-file rule
// over-lists. LESS information was SAFER than partial information. candor-java behaved identically, which
// is what said the defect was the FORMAT rather than either consumer.
//
// A POSITIVE DOMINATES: if a known path reaches `owner` the answer is YES even when another branch ran
// into an unindexed type — the relation is established and an unknown branch cannot un-establish it. NO is
// reserved for a walk that stayed entirely inside types the sidecar answers for.
function subtypeOf(type, owner, hierarchy) {
  if (type === owner) return "YES";
  let sawUnindexed = false;
  const seen = new Set(), stack = [type];
  while (stack.length) {
    const cur = stack.pop();
    if (!Object.prototype.hasOwnProperty.call(hierarchy, cur)) { sawUnindexed = true; continue; }
    for (const s of hierarchy[cur]) { if (s === owner) return "YES"; if (!seen.has(s)) { seen.add(s); stack.push(s); } }
  }
  return sawUnindexed ? "UNANSWERABLE" : "NO";
}

// The two-valued form. UNANSWERABLE collapses to TRUE — disclose, never drop — which is the direction
// §2.2 ⟨0.26⟩ requires and the opposite of what absence used to do.
function isSubtypeOf(type, owner, hierarchy) {
  return subtypeOf(type, owner, hierarchy) !== "NO";
}

// callers + the unresolved-dispatch frontier (--include-unknown, SPEC §3.1/§4 0.7): the CONFIRMED set,
// plus functions that reach `q` only through a `dispatch:OWNER.member` the engine declined to resolve —
// disclosed iff a confirmed reacher is an override of OWNER.member (same method AND a subtype of OWNER
// per the hierarchy; empty hierarchy → simple-name match, over-lists). Never asserted ("cannot confirm").
//
// ⟨0.24⟩ A `dispatch:` detail with NO DOT (§4 reserves it for an unresolved dispatch where NO owner type
// could be formed at all — candor-rust's `dispatch:untyped cross-package receiver`) names no OWNER and no
// member, so condition (3) — "is a confirmed reacher an override of OWNER.M?" — is UNANSWERABLE, and an
// unanswerable condition MUST NOT be scored as a failed one. It is DISCLOSED with `viaDispatchOn` = the
// raw detail verbatim. Measured here before the fix, on a report carrying one dotted and one dot-free
// source: the frontier held ONLY the dotted entry, in BOTH the hierarchy and the no-hierarchy arm, with no
// diagnostic naming the dropped one — `typesByMethod.get(<whole detail>)` missed and the `continue` ate it.
// Same direction the no-hierarchy fallback already takes one rung up: with no sidecar the subtype test is
// unanswerable and the answer is to over-list, not to drop. The frontier over-lists by construction and
// asserts nothing into `transitive`, so a spurious entry costs precision while a dropped one is a false
// all-clear on the query. The test is STRUCTURAL and runs BEFORE the split is attempted (a §3.1 MUST),
// never a match on the specific string: an allowlist of known details would silently drop every detail it
// did not anticipate, which is this defect again.
//
// The short-circuit has to come FIRST because the split helpers fall back to the WHOLE STRING with no dot,
// and they are applied to the reason detail AND to the reachers' quals — so the override test degenerates
// into string equality between a reason detail and a function name. Three dot-free shapes, measured:
//   · a PHRASE (`untyped cross-package receiver`) — dropped in both arms; the defect as briefed.
//   · a detail equal to a reacher's WHOLE qual — disclosed, but in the hierarchy arm the subtype test
//     passed only by REFLEXIVITY over a string that is not a type name; the sidecar was never consulted.
//     Right output, wrong reason — the shape that hides the gap instead of showing it.
//   · a detail equal to a DOTTED reacher's simple method name — matched in the no-hierarchy arm (the
//     by-method lookup hits) and DROPPED in the hierarchy arm (the subtype test runs with a non-type
//     string as owner). Same input, opposite outputs, decided by whether a sidecar happens to exist.
// That last one is the same lever as the phantom-key fix `7bbf73c` (an uninterpretable sidecar key is
// dropped, not kept as `[]`, because keeping it flips the arm): one changes WHICH arm you land in, this
// one removes the arm's power to change the answer for an unanswerable detail.
//
// ⟨0.24⟩ THE MIXED SOURCE: one function carrying several `dispatch:` reasons — dotted ones that pass
// condition (3) and dot-free ones that cannot be evaluated — gets ONE entry whose `viaDispatchOn` is the
// sorted, deduplicated, comma-joined union of the passing members `M` and the raw dot-free details. The
// two kinds INTERLEAVE (they are one sorted set, not "dotted first"), and the `Set` supplies the dedup.
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
      const key = w.slice("dispatch:".length);
      // STRUCTURAL, and BEFORE the split is attempted (SPEC §3.1 ⟨0.24⟩ MUST). No dot ⇒ no owner and no
      // member ⇒ condition (3) is unanswerable ⇒ disclose the raw detail. Tested on the same stripped
      // string the split would consume, so this fires exactly when the split would have no dot to use.
      if (!stripPos(key).includes(".")) { hits.add(key); continue; }
      const m = simpleMethod(key), owner = declaringType(key);
      const types = typesByMethod.get(m);
      if (!types) continue;
      if (!hasHier || types.some((t) => isSubtypeOf(t, owner, hierarchy))) hits.add(m);
    }
    if (hits.size) possible.push({ fn: f.fn, viaDispatchOn: [...hits].sort(byCodePoint).join(",") });
  }
  possible.sort((a, b) => byCodePoint(a.fn, b.fn));
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
export const CONTAINED = ["Db", "Net", "Llm", "Exec", "Fs", "Ipc", "Clipboard"];
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
    const owner = entries.slice().sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))[0];
    const placement = Object.fromEntries(entries.slice().sort((a, b) => byCodePoint(a[0], b[0])));
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
// ⟨0.20⟩ `--class <c,…>` filter: the six reason classes, `dynamic` (every genuine class), or `*` (all).
// null spec ⇒ no filter. The vocabulary is policy.mjs's — the flag and a `deny E Unknown[…]` rule must name
// the same class set, so `--class` resolving `dynamic` from a private copy of the list is a drift waiting
// to happen.
//
// ⟨0.24⟩ THE VALUE GRAMMAR (SPEC §6.2): an UNRECOGNISED token is a USAGE ERROR, not a warn-and-drop. This
// is deliberately the OPPOSITE of the policy side, and the asymmetry is the whole point. A dropped token in
// a `deny E Unknown[…]` rule leaves the rule WIDER — it still fires, on more, so the mistake is loud. A
// dropped token here leaves the filter NARROWER: `--class dyanmic` answered a question the user never asked
// with a SMALLER number, exit 0, indistinguishable from a real all-clear. That is the same fail-open class
// as the transitive-resolution defect fixed in cbbb05c, arriving through the argument parser instead of the
// match rule. A query flag that cannot be honoured is REFUSED, never approximated.
// Throws ClassFilterError so the caller can render it as a usage error (exit 2); it is never a warning and
// never a silent empty set. Empty tokens (a trailing comma, whitespace) are separators, not tokens.
const ALL_CLASSES = REASON_CLASSES;
export class ClassFilterError extends Error {}
export function parseClassFilter(spec) {
  if (!spec) return null;
  const out = new Set();
  for (let t of spec.split(",")) {
    t = t.trim();
    if (!t) continue;
    if (t === "*") return new Set(ALL_CLASSES);
    if (t === "dynamic") { for (const c of DYNAMIC_CLASSES) out.add(c); continue; }
    if (ALL_CLASSES.includes(t)) out.add(t);
    else throw new ClassFilterError(`candor-ts: --class: unknown reason class \`${t}\` (accepted: ${ALL_CLASSES.join(",")}; aliases: dynamic,*)`);
  }
  return out;
}
// `blindspots`'s filter, and DELIBERATELY the direct-only one — see SPEC §6.2 ⟨0.24⟩ req 0. `blindspots`
// is the SOURCE view (§3.1): it already excludes a unit whose Unknown is purely inherited, so every entry
// it filters carries a direct reason by construction and reading `unknownWhy` is correct here. Resolving
// transitively would pull in exactly the units the verb is defined to exclude, turning a ranked worklist of
// root causes into a list of everything downstream of them. `unverified` is the opposite and shares the
// FLAG, not this predicate: an inherited hole is still a hole the gate did not prove. A shared code path is
// not a shared defect. Measured: `--class dynamic` already excludes nothing here (237/190/55 sources on
// three targets, unchanged filtered), which is what a correct source view looks like.
const classMatches = (cf, why) => cf === null || (why ?? []).some((w) => cf.has(reasonClass(w)));

export function blindspots(fns, cg, classSpec = null) {
  const cf = parseClassFilter(classSpec);
  const rev = reverseGraph(cg);
  const totalUnknown = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
  const sources = [];
  for (const e of fns) {
    const why = e.unknownWhy ?? [];
    if (why.length === 0 || !classMatches(cf, why)) continue; // a SOURCE of a matching reason class
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
  sources.sort((a, b) => b.reaches - a.reaches || byCodePoint(a.fn, b.fn)); // most-smearing first, stable
  return { sources, totalUnknown };
}

// `blindspots --stats` (SPEC §3.1 ⟨0.20⟩): the reason-class DISTRIBUTION over the Unknown SOURCES — how
// much Unknown, by class {reflect,dispatch,indirect,native,unresolved,setup} — so a team can SIZE the
// blind-spot cost (and separate genuine dynamism from `setup` mis-config) BEFORE `deny E Unknown`. Counts
// SOURCE functions per class (a multi-reason fn counts in each class it has). Matches candor-java/rust/swift.
export function blindspotsStats(fns, classSpec = null) {
  const cf = parseClassFilter(classSpec);
  const ORDER = ["reflect", "dispatch", "indirect", "native", "unresolved", "setup"];
  const byClass = Object.fromEntries(ORDER.map((c) => [c, 0]));
  const totalUnknown = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
  let sources = 0;
  for (const e of fns) {
    const why = e.unknownWhy ?? [];
    if (why.length === 0 || !classMatches(cf, why)) continue;
    sources++;
    const classes = new Set(why.map(reasonClass));
    for (const c of classes) byClass[c]++;
  }
  return { byClass, sources, totalUnknown };
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
  changes.sort((a, b) => byCodePoint(a.fn, b.fn));
  return { changes };
}

// gains: the package-level SUPPLY-CHAIN alarm (spec §5.1) — the UNION of effects the surface gained
// between two reports (base → cur), with per-function detail. A dependency that grows a Net/Exec reach
// between releases. Same shape as candor-query's `gains --json`. Built on diff so it can't drift.
//
// ⟨spec 0.12 staged⟩ each byFunction entry carries `origin` — the candor-gains prototype's key finding
// promoted into the open query. A gain on a fn that EXISTED at the baseline (shipped pure, now does
// Net — the supply-chain attack signal) is a different alarm from a NEW fn that does Net (a feature).
// Reports OMIT pure functions (§2), so existence is keyed on the baseline CALLGRAPH (a baseline-pure
// fn is a graph node with no report entry):
//   "existing" — in the baseline report, or a baseline-callgraph node (caller key or callee);
//   "new"      — a COMPLETE baseline callgraph was loaded and the fn is in neither (did not exist);
//   "unknown"  — absent from the baseline report AND the graph cannot decide: no baseline callgraph
//                found (empty graph) OR the graph is PARTIAL (loadCallgraph's non-enumerable `partial`
//                tag — a matched sidecar failed to load, its edges were dropped-and-disclosed, so
//                absence from the survivors proves nothing). Undecidable is DISCLOSED, never guessed
//                (§4) — a partial graph must not downgrade the attack signal from a dropped file's
//                fns to a benign-looking "new".
// `baseCg` defaults to {} (no callgraph → "unknown") so core-only callers keep working unchanged.
export function gains(curFns, baseFns, baseCg = {}) {
  const baseSet = new Set(baseFns.map((e) => e.fn));
  const cgNodes = new Set(Object.entries(baseCg).flatMap(([k, vs]) => [k, ...vs]));
  // The ladder: report hit → existing; graph node → existing (a surviving node is real even in a
  // partial graph — the drop loses nodes, never invents them); else "new" only when a COMPLETE
  // non-empty graph can vouch for non-existence; else "unknown".
  const graphDecides = cgNodes.size > 0 && baseCg.partial !== true;
  const originOf = (fn) => baseSet.has(fn) ? "existing"
    : cgNodes.has(fn) ? "existing"
    : graphDecides ? "new" : "unknown";
  const gained = new Set(), byFunction = [];
  for (const c of diff(curFns, baseFns).changes) {
    for (const e of c.gained) { gained.add(e); byFunction.push({ effect: e, fn: c.fn, origin: originOf(c.fn) }); }
  }
  return { gained: [...gained].sort(), byFunction };
}

/**
 * ⟨0.24⟩ THE CONDITION A `whatif` VERDICT RESTS ON, when the matched rule NARROWS the effect being
 * INTRODUCED — `null` when it does not, which is the ordinary case and keeps the key absent.
 *
 * WHY IT IS NOT A `classFilterExcludes` CALL, which is the obvious-looking move and the wrong one. That
 * predicate closed `fix-gate`/`unverified`, and it does not carry over here: those two read a signature that
 * EXISTS, so a class is available to match. `whatif` asks about an effect the code has NOT GOT — a
 * `deny Net[unknown-host]` rule quantifies over the destination of a call that does not exist — so there is
 * nothing to match and the question is genuinely unanswerable. Charging it stays the right default for a
 * PRE-EDIT gate (the edit could land in any class, so fail closed); what was wrong was showing that
 * unconditional verdict beside a rule rebuilt WITHOUT its filter.
 *
 * SPEC §3.1 ⟨0.24⟩'s rule for exactly this shape: an unanswerable condition is DISCLOSED, never scored as a
 * failed one. So the verdict is unchanged and the condition rides beside it.
 *
 * The class lists are stored sorted by `parsePolicy` (and `dynamic`/aliases are already RESOLVED there, so
 * the condition names classes rather than the alias the operator typed — the condition has to say what would
 * have to be TRUE, and `dynamic` is not something an Unknown can be). Byte-aligned with candor-rust
 * `narrowing_condition`, read off that engine's JSON rather than off a description of it.
 */
export function narrowingCondition(r, eff) {
  if (eff === "Unknown" && r.unknownClasses?.length)
    return `the \`Unknown\` you introduce is of reason class ${r.unknownClasses.join(" / ")}`;
  if (eff === "Net" && r.netClasses?.length)
    return `the \`Net\` you introduce reaches destination class ${r.netClasses.join(" / ")}`;
  return null;
}

// whatif: hypothetically add `eff` to `target` and report the blast radius + any policy violations.
// `policyParsed` is an already-parsed policy object (or null); kept I/O-free for the core.
//
// ⟨0.24⟩ THE RULE IS NAMED VERBATIM, AND A NARROWED VERDICT SAYS WHAT IT RESTS ON (SPEC §6.2 for the first
// half, §3.1 `6f30540`/`901f14d` for the second). `rule` was REBUILT from `effects` + `scope`, which
// normalized away everything the operator wrote. MEASURED on this engine against candor-rust over
// byte-identical inputs:
//
//   `deny Unknown[reflect] app.nat`             rust: verbatim      ts: `deny Unknown app.nat`
//   `deny Net[unknown-host,known-partner] app`  rust: verbatim      ts: `deny Net app`
//   `deny Net Db  app  # comment`               rust: verbatim      ts: `deny Db Net app`
//   `pure app`                                  rust: `pure app`    ts: `deny (pure) app`
//
// The narrowed rows are the sharp ones — the operator's own scoping ERASED in the verb an agent reads before
// editing, at exactly the moment they are deciding whether that scoping protects them. And the two halves
// only work together: printing `raw` while the verdict stayed filter-blind would be WORSE than the bug, the
// same unconditional "would violate" now attributed to the narrowed line, reading as a filter candor
// evaluated and did not. `raw` is the line with its comment stripped and its ends trimmed (parsePolicy) —
// the same field `unevaluated[].rule` already ships, so one rule reads back one way everywhere.
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
      // OMITTED unless this rule narrows the effect being INTRODUCED, so every document from an unfiltered
      // policy — which is nearly all of them — stays byte-identical, and the key keeps its meaning. A
      // `conditional` on every violation would train the reader to ignore it, the same failure as naming a
      // config that moved nothing. It also keys on the INTRODUCED effect, not on the rule merely carrying a
      // bracket: `deny Net[unknown-host] Fs app` asked about `Fs` charges `Fs` unconditionally.
      const cond = narrowingCondition(r, eff);
      for (const fn of affected)
        if (!r.scope || scopeMatches(fn, r.scope))
          violations.push(cond ? { fn, rule: r.raw, conditional: cond } : { fn, rule: r.raw });
    }
  }
  return { of: targets, effect: eff, affected: [...affected].sort(), violations, ok: violations.length === 0 };
}

// deniedLayer: the deny/`pure` scope (the "layer") forbidding `eff` at `fn`, or null if allowed there.
// Mirrors the gate's AS-EFF-006 predicate (candor-java/candor-query): a `deny` fires when it names the
// effect; a `pure` rule (empty effects) forbids every real effect but not Unknown.
//
// ⟨0.24⟩ …AND ITS `Unknown[…]`/`Net[…]` CLASS FILTER (SPEC §6.2), which this predicate did not read. It
// computed from the effect NAME alone, so `deny Unknown[reflect] app` "denied" a function whose only hole
// is `native:dlopen` — a boundary the policy explicitly excludes — and `fix-gate --strict` returned exit 1
// plus a hoist instruction for it while the gate over the same bytes exited 0. `ctx` is the narrowing
// context (narrowingContext below); absent, nothing is excluded and the old behaviour stands.
//
// ⟨0.24⟩ …AND IT NOW HONOURS THE GATE'S ANSWERABILITY WITHHOLD (SPEC §3.2 `4fd140c`). A (rule, fn, effect)
// whose narrowing evidence the report does not carry is NOT EVALUATED — so it neither denies nor clears
// here, and the caller must DISCLOSE it rather than compute a remedy from it. `continue` is the whole
// mechanism: the rule is skipped, a later rule may still deny, and if none does, `deniedLayer` returns null
// and the caller reads `ctx.held(fn, eff)` to tell "nothing forbids this" from "the gate could not say".
function deniedLayer(fn, eff, policyParsed, scopeMatches, ctx = null) {
  for (const r of policyParsed.deny) {
    const denies = r.effects.length === 0 ? eff !== "Unknown" : r.effects.includes(eff);
    if (!denies || (r.scope && !scopeMatches(fn, r.scope))) continue;
    if (ctx && classFilterExcludes(r, ctx.entry(fn), eff, ctx.reasonAcc, ctx.netClassOf)) continue;
    if (ctx?.withhold && ctx.withhold(r, fn, eff)) continue;
    return r.scope ?? "";
  }
  return null;
}

/**
 * ⟨0.24⟩ The narrowing context the class filter needs, over a LOADED report: a function's transitive
 * Unknown reason classes and its Net destination classes, plus the entry lookup both read — and, since
 * SPEC §3.2 `4fd140c`, THE GATE'S OWN ANSWERABILITY REFUSAL over the same bytes.
 *
 * ⟨0.24⟩ THE FALLBACK DERIVATION IS GONE (`authoritative: true`), AND THAT IS THE POINT. This built its
 * `netClass` map in the DEFAULT (non-authoritative) mode, so an entry carrying `hosts` and no `netClass`
 * fell back to `netClassesOf` — and the comment here argued that was a hedge, because "`fix-gate` and
 * `unverified` have no refusal channel, so a hedge beats a hole". The first half of that is true and this
 * change keeps it. But a DERIVATION is not a hedge; it is a SECOND OPINION, and it is the one opinion an
 * advisory verb is not entitled to. MEASURED on this engine, report with `hosts` and no `netClass`, policy
 * `deny Net[unknown-host] app`:
 *
 *     gate --report        exit 2, §3.1 answerability refusal — it CANNOT judge `app.noClass`
 *     unverified           exit 0, CLEARS `app.noClass` and names a different hole instead
 *     fix-gate             exit 0, a hoist plan for `app.noClass` premised on the DERIVED class
 *
 * The verb was more confident than the gate over identical bytes, in both directions at once: silent where
 * the gate refused, and instructing where the gate declined to read. So the class now comes off the wire or
 * not at all (`authoritative`), exactly as `gate --report`, the MCP gate and the LSP diagnostics already
 * read it — and the refusal channel the old comment said did not exist is the one this context now carries:
 *
 *   `withhold(rule, fn, eff)`  the gate's own per-(rule, function, effect) predicate (unanswerableScoped).
 *   `unevaluated: [{rule, why}]`  the gate's own DISCLOSURE SHAPE (§3.1) — not a second spelling of it.
 *   `held(fn, eff?)`  the same facts keyed by FUNCTION, because an advisory verb answers per function.
 *
 * COMPUTED FROM THE SAME CODE, not a re-statement of it: `unanswerableScoped` is the gate's function, so
 * containment (`U_clear ⊆ G_clear`) holds because one predicate decides both, not because two authors
 * agreed. `policyParsed` is optional and defaults to null — the scan route (scan.mjs) builds its own ctx
 * from LIVE evidence where no field is missing and nothing is refused, and it keeps the old behaviour.
 *
 * MEASURED, AND WORTH KNOWING BEFORE YOU EDIT EITHER LINE: given the withhold, `authoritative` carries NO
 * behaviour of its own. A mutant restoring the derivation was BYTE-IDENTICAL across the whole fixture
 * battery, because `unanswerableScoped` withholds exactly when the authoritative class set is empty and
 * treats "absent from the map" and "mapped to `[]`" the same — so the derivation is only ever reachable for
 * triples the withhold has already removed. It stays because the two routes should READ one report
 * identically and because a live fallback is a loaded gun for the next call site added here, not because a
 * test can tell. The withhold, by contrast, IS load-bearing on the `Unknown` axis, where
 * `reasonClassesMatch` floors an empty set at `unresolved` and the filter therefore MATCHES: removing it
 * there brought back a full hoist plan for a reasonless `Unknown` under `deny Unknown[unresolved]`. Both
 * facts came out of the mutant audit, and only the second one was a missing test.
 *
 * `resolveReasonClasses` unions the sidecar with the entries' own §2 `calls`, so the answer is the same
 * whether or not the caller loaded a callgraph — which is why MCP's `candor_unverified`, which loads no
 * sidecar, gets the same narrowing as the CLI.
 */
export function narrowingContext(fns, cg = {}, policyParsed = null) {
  const byName = indexFns(fns);
  const reasonAcc = resolveReasonClasses(fns, cg);
  // VERBATIM OFF THE WIRE: every `Net`-bearing entry maps to its `netClass` or to the EMPTY set, so the
  // derivation is unreachable and the report is the only source of the class (reportNetClasses' argument).
  const netMap = reportNetClasses(fns, { authoritative: true });
  const { unevaluated, withhold } = policyParsed
    ? unanswerableScoped(policyParsed, fns, reasonAcc, netMap)
    : { unevaluated: [], withhold: null };
  // The disclosure, keyed by FUNCTION. `unanswerableScoped` groups by RULE because that is the granularity
  // a gate verdict lists; an advisory verb names FUNCTIONS, so the same triples are indexed both ways here
  // rather than re-derived by each caller — one computation, two readings, no chance of them disagreeing.
  const byRaw = new Map(unevaluated.map((u) => [u.rule, u]));
  const heldByFn = new Map();
  if (withhold)
    for (const f of fns)
      for (const r of policyParsed.deny)
        for (const eff of f.inferred ?? []) {
          if (!withhold(r, f.fn, eff)) continue;
          const u = byRaw.get(r.raw);
          if (!u) continue;                                  // unreachable: every held triple has a group
          const cur = heldByFn.get(f.fn) ?? new Map();
          cur.set(`${r.raw}\0${eff}`, { fn: f.fn, rule: r.raw, effect: eff, why: u.why });
          heldByFn.set(f.fn, cur);
        }
  return {
    reasonAcc,
    netClassOf: netClassResolver(new Map(), new Set(), netMap),
    entry: (fn) => byName.get(fn) ?? null,
    withhold,
    unevaluated,
    held: (fn, eff = null) =>
      [...(heldByFn.get(fn)?.values() ?? [])].filter((h) => eff === null || h.effect === eff),
  };
}

/** ⟨0.24⟩ SPEC §3.2 — the `unevaluated: [{rule, why}]` disclosure for a SUBSET of held triples, in the
 *  gate's own shape and deduplicated by rule (a rule withheld on two effects of one function is ONE
 *  unevaluated rule, exactly as the gate lists it). */
function unevaluatedOf(held) {
  const byRule = new Map();
  for (const h of held) if (!byRule.has(h.rule)) byRule.set(h.rule, { rule: h.rule, why: h.why });
  return [...byRule.values()];
}

// The site-anchored cut (integrations/FIX-SPEC.md), shared by fix + fixGate — the byte-for-byte port of
// candor-query / candor-java's computeRemedy. Forward-BFS to the direct site(s), then climb UP through the
// denied layer so the pure span is the same whichever inheriting function triggered it (root-independent);
// the allowed-layer callers where the climb stops are the hoist frontier.
function computeRemedy(start, eff, layer, cg, rev, byName, policyParsed, scopeMatches, ctx = null) {
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
    if (deniedLayer(a, eff, policyParsed, scopeMatches, ctx) !== null) deniedSpan.add(a);
    up.push(a);
  }
  while (up.length) {
    const cur = up.shift();
    for (const caller of rev.get(cur) ?? []) {
      const ce = byName.get(caller);
      // skip a caller that doesn't route the effect — INCLUDING one absent from the report (a pure
      // callgraph-only node never carries the effect). Matches candor-swift. (/code-review — was `ce && !…`.)
      if (!ce || !(ce.inferred ?? []).includes(eff)) continue;
      if (deniedLayer(caller, eff, policyParsed, scopeMatches, ctx) !== null) {
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
      if (deniedLayer(caller, eff, policyParsed, scopeMatches, ctx) !== null) {
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
//
// ⟨0.24⟩ …AND `crossing: false` IS A CLAIM, so it is not the answer where the gate REFUSED (SPEC §3.2
// `4fd140c`). `reason: "not-forbidden"` says "no policy forbids this effect here" — over an entry whose
// narrowing evidence the report does not carry, that is the derived second opinion, asserted to the one
// caller (the LSP code action) that acts on it. The refusal takes the GATE'S OWN document shape (§3.1
// `107755b`): `refused: true`, the `unevaluated` disclosure, and **NO `crossing` KEY AT ALL** — absent, not
// `false`, because a claim it cannot make must not be spelled as a claim it can.
export function fix(cg, fns, target, eff, policyParsed, scopeMatches) {
  const ctx = narrowingContext(fns, cg, policyParsed);   // ⟨0.24⟩ the rule's class filter + the gate's refusal
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
  const layer = deniedLayer(start, eff, policyParsed, scopeMatches, ctx);
  if (layer === null) {
    // ORDER MATTERS: the withhold is checked only where NO rule denied, because a rule that fires on
    // evidence the report DOES carry is certain and dominates (PAPER3 Lemma 2 — the same precedence the
    // gate applies). A remedy for a certain crossing is not premised on the refused evidence.
    const held = ctx.held(start, eff);
    if (held.length)
      return { fn: start, effect: eff, refused: true, unevaluated: unevaluatedOf(held) };
    return { fn: start, effect: eff, crossing: false, reason: "not-forbidden" };
  }
  const rev = reverseGraph(cg);
  return { crossing: true, ...computeRemedy(start, eff, layer, cg, rev, byName, policyParsed, scopeMatches, ctx) };
}

// fixGate: a remedy for EVERY deny/`pure` (AS-EFF-006) crossing in the report, collapsing the inheritors of
// one root cause to a single plan (keyed by effect|layer|site|hoist). Returns { ok, remedies } — the shape
// the edit-time loop folds into its block message.
//
// ⟨0.24⟩ …AND IT OFFERS NO REMEDY PREMISED ON EVIDENCE THE GATE REFUSED TO READ (SPEC §3.2 `4fd140c`). A
// hoist plan for a boundary the gate could not adjudicate is a confident instruction resting on a guess —
// MEASURED on this engine: over a report carrying `hosts` and no `netClass` under `deny Net[unknown-host]
// app`, `gate --report` exited 2 while this verb printed a full hoist plan for `app.noClass`, computed from
// the class the gate had just declined to invent. `deniedLayer` now skips the withheld triple, so no plan is
// built — and the `unevaluated` disclosure rides out beside the remedies so that SILENCE IS NOT THE FIX
// EITHER. Dropping the plan without the disclosure would trade a fabricated instruction for a false
// all-clear, which is the failure this project keeps measuring in fabrication repairs.
export function fixGate(cg, fns, policyParsed, scopeMatches) {
  const ctx = narrowingContext(fns, cg, policyParsed);   // ⟨0.24⟩ the class filter + the gate's refusal
  const byName = indexFns(fns);
  const rev = reverseGraph(cg);
  const plans = new Map();
  const held = [];
  // Iterate functions in sorted-name order so the first-writer-wins `fn` representative of a collapsed
  // remedy is deterministic across engines (candor-query/java/swift all iterate a sorted key set).
  for (const e of [...fns].sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0))) {
    for (const eff of [...(e.inferred ?? [])].sort()) {
      const layer = deniedLayer(e.fn, eff, policyParsed, scopeMatches, ctx);
      if (layer !== null) {
        const p = computeRemedy(e.fn, eff, layer, cg, rev, byName, policyParsed, scopeMatches, ctx);
        const key = `${p.effect}|${p.layer}|${p.site}|${p.hoistTo}`;
        if (!plans.has(key)) plans.set(key, p);
      } else {
        held.push(...ctx.held(e.fn, eff));   // see `fix`: only where nothing certain denied
      }
    }
  }
  // Emit remedies in dedup-key order (candor-query BTreeMap / java TreeMap / swift sorted-keys all do).
  const remedies = [...plans.keys()].sort().map((k) => plans.get(k));
  const unevaluated = unevaluatedOf(held);
  // `ok` STAYS in the body and `advisoryAnswer` removes it when `unevaluated` is non-empty — the §3.2
  // omit-`ok` rule lives in ONE place so this verb, `unverified` and `whatif` cannot drift apart on it.
  return unevaluated.length ? { ok: remedies.length === 0, remedies, unevaluated }
                            : { ok: remedies.length === 0, remedies };
}

// unverified: the PROVABLE-PURITY disclosure (eval/fixloop/DISPATCH-NOTE.md, mirrors candor-query). A
// `pure`/`deny E` layer PASSES a function that carries none of its forbidden effects — but if that function is
// `Unknown` (an unresolvable call), the pass is UNVERIFIED: the Unknown could hide the very effect the rule
// forbids (the fn/closure-port hole). Returns each such function + the `deny E Unknown <scope>` upgrade.
/** Reconstruct a rule's source form and its `Unknown`-forbidding upgrade: `[source, upgrade]`. `pure
 *  <scope>` → ["pure <scope>", "deny Unknown <scope>"]; `deny <E…> <scope>` → ["deny <E…> <scope>",
 *  "deny <E…> Unknown <scope>"]. Shared so the gate note and `unverified` name the identical upgrade.
 *
 *  ⟨0.24⟩ THE NARROWING FILTERS ARE RENDERED, and they had to start being rendered in the SAME change that
 *  made them reachable here. Making `unverifiedHoleRule` filter-aware is exactly what first lets a
 *  `deny Unknown[reflect]` / `deny Net[unknown-host]` rule BE the rule a hole is disclosed under — and this
 *  reconstruction dropped the bracket, so the fix printed the operator's narrowed rule back to them as the
 *  WIDE one (`deny Unknown app`) and advised the nonsense upgrade `deny Unknown Unknown app`; on the Net
 *  sibling it advised `deny Net Unknown app`, which SILENTLY UN-NARROWS a rule the operator scoped to one
 *  destination class. Dormant until the fix reached it — the standing shape on this rung is code that was
 *  correct only because nothing upstream ever handed it the case it mishandles.
 *
 *  A rule carrying NO filter renders byte-identically to before, which is what keeps conformance PARTs
 *  12c/12d (`deny Db Net Unknown domain`, four-way) unmoved.
 *
 *  THE UPGRADE SPLITS on whether the rule already denies `Unknown`. If it does, it can only be here
 *  NARROWED — a bare `deny … Unknown` fires on every Unknown, so the function would be a violation and not
 *  a hole — and the upgrade is that term WIDENED to bare `Unknown`, never a second `Unknown` appended.
 *  Byte-aligned with candor-rust `rule_and_upgrade`. */
export function ruleUpgrade(r) {
  const suffix = r.scope ? ` ${r.scope}` : "";
  // `pure` forbids real effects but not Unknown; to REQUIRE provable purity, add a deny-Unknown.
  if (r.effects.length === 0) return [`pure${suffix}`, `deny Unknown${suffix}`];
  // One effect term, with its narrowing filter if it has one. Both class lists are stored sorted by
  // `parsePolicy`, so the dump and the disclosure spell one rule one way.
  const term = (e) =>
    e === "Unknown" && r.unknownClasses?.length ? `Unknown[${r.unknownClasses.join(",")}]`
    : e === "Net" && r.netClasses?.length ? `Net[${r.netClasses.join(",")}]`
    : e;
  const effs = r.effects.map(term).join(" ");
  if (r.effects.includes("Unknown"))
    return [`deny ${effs}${suffix}`,
            `deny ${r.effects.map((e) => (e === "Unknown" ? "Unknown" : term(e))).join(" ")}${suffix}`];
  return [`deny ${effs}${suffix}`, `deny ${effs} Unknown${suffix}`];
}

/** The single predicate for a provable-purity hole (eval/fixloop/DISPATCH-NOTE.md): a function that is
 *  Unknown, sits in a pure/deny scope, and PASSES that rule (carries none of its forbidden real effects) —
 *  so its compliance is asserted but not verified (the Unknown could hide the very effect the rule forbids;
 *  the classic case is a fn/closure-injected port). A *real* violation is the gate's job, not this. Returns
 *  the first governing rule under which the function is such a hole, or null. Shared by the gate note
 *  (scan.mjs) and `unverified` so "what a hole is" has ONE definition (conformance PART 12d pins agreement).
 *
 *  ⟨0.24⟩ …AND `violates` NOW READS THE RULE'S `Unknown[…]`/`Net[…]` CLASS FILTER (SPEC §6.2) — the
 *  UNDER-REPORT half of the same defect `deniedLayer` carried, and the worse half. `deny Unknown[reflect]
 *  app` over a function whose only hole is `native:dlopen` computed `violates = true` from the effect set
 *  alone and fell through to "a real violation the gate already reports" — but the gate does NOT report it:
 *  the class is excluded, the layer PASSES, and it passes WHILE CARRYING an Unknown. That is precisely a
 *  pass-but-Unknown hole, and `unverified --strict` answered `ok: true` with an empty array over it — the
 *  verb whose entire job is "your green gate is not provably green" certifying a green gate it cannot see
 *  through. Closing only the `fix-gate` over-charge would have killed a fabrication and left its silent
 *  mirror standing. `ctx` is the narrowing context; absent, nothing is excluded and the old behaviour
 *  stands (the scan-time gate note in scan.mjs builds its own from the scan's live evidence).
 *
 *  ⟨0.24⟩ …AND A WITHHELD (rule, fn, effect) DOES NOT COUNT AS A FIRING EITHER (SPEC §3.2 `4fd140c`). The
 *  fall-through reads "else it's a real violation the gate already reports" — over an effect whose narrowing
 *  evidence the report does not carry, the gate reports NOTHING; it refuses. Treating the withheld effect as
 *  a violation would silently drop the function from this list on the strength of a violation nobody made,
 *  which is the same silence in a second place. Withheld ⇒ not a firing ⇒ the function stays a hole here,
 *  the LESS-confident direction, which is the one this verb is allowed to move in. */
export function unverifiedHoleRule(fn, inferred, policyParsed, scopeMatches, ctx = null) {
  const inf = inferred ?? [];
  if (!inf.includes("Unknown")) return null;
  const entry = ctx ? ctx.entry(fn) : null;
  // An effect the rule NAMES but whose class filter excludes here is not a violation — it is exactly what
  // the gate tolerates, so the pass is real, and the Unknown it passes with makes that pass unverified.
  const fires = (r, x) => !(ctx && classFilterExcludes(r, entry, x, ctx.reasonAcc, ctx.netClassOf))
                       && !(ctx?.withhold && ctx.withhold(r, fn, x));
  for (const r of policyParsed.deny) {
    if (r.scope && !scopeMatches(fn, r.scope)) continue;
    const violates = r.effects.length === 0
      ? inf.some((x) => x !== "Unknown" && fires(r, x))        // pure: any real effect is a violation
      : inf.some((x) => r.effects.includes(x) && fires(r, x)); // deny: a named effect is a violation
    if (!violates) return r;                    // else it's a real violation the gate already reports
  }
  return null;
}

// ⟨0.24⟩ `--class` here resolves the class set TRANSITIVELY, with the GATE's own code (policy.mjs) and over
// the same reach the gate uses — `cg` is the callgraph sidecar. It used to match `e.unknownWhy`, the
// DIRECT-only field (§4: a reason names a site in the fn's OWN body), so a hole whose Unknown is purely
// inherited matched NO filter at all — including one naming its own class, and including `dynamic`, which
// names every genuine class and must therefore exclude nothing. That made the one verb whose job is to
// surface the holes a green gate is hiding under-report them, and under-report MORE the more the user
// narrowed. Measured on three real targets, unfiltered → `--class dynamic`: 207→173, 268→158, 64→21.
//
// ⟨0.24⟩ AND IT NAMES THE FUNCTION THE GATE COULD NOT JUDGE (SPEC §3.2 `4fd140c`). A function the gate
// COULD NOT JUDGE is an unverified hole in the strongest sense this verb has — it is precisely "your green
// gate is not provably green" — and clearing it because a fallback derivation happened to decide it is the
// verb contradicting its own purpose. MEASURED before the fix, report with `hosts` and no `netClass` under
// `deny Net[unknown-host] app`: `gate --report` exited 2 naming `app.noClass` as the entry it could not
// judge, and this verb exited 0 having cleared `app.noClass` AND NAMED A DIFFERENT HOLE — which is why the
// conformance row asserts per FUNCTION: "the verb names something" passed on all four engines while the
// defect stood.
//
// THE RECORDED REASON IS THE MISSING EVIDENCE, NEVER THE DERIVED CLASS. Recording the class would restate
// the defect as a disclosure — the second opinion, published. So the entry carries the gate's OWN sentence
// (`unanswerableScoped`'s `why`, verbatim, the same string the gate's `unevaluated[].why` carries) and
// carries NO `upgrade`: an upgrade is a remedy, and a remedy premised on evidence the gate refused to read
// is exactly what the same ruling forbids `fix-gate` to offer.
//
// `--class` DOES NOT FILTER THESE. That flag is the reader's drill-down over Unknown REASON classes; a
// function the gate could not judge may carry no Unknown at all (the measured one carries `Net`), and
// dropping it for failing a filter it is not an instance of would put the silence back under exactly the
// narrowing that hid it — the shape §3.1 calls "every narrowed filter silently tolerates".
export function unverified(fns, policyParsed, scopeMatches, classSpec = null, cg = {}) {
  const cf = parseClassFilter(classSpec);   // ⟨0.20⟩ --class: keep only holes of a matching reason class
  // ⟨0.24⟩ the POLICY's own `Unknown[…]`/`Net[…]` narrowing, which is a different question from `--class`
  // (the reader's drill-down) and was never asked at all: `reasonAcc` here rides the ctx, so the two
  // narrowings resolve the class set exactly once and from the same code as the gate.
  const ctx = narrowingContext(fns, cg, policyParsed);
  const holes = [];
  const held = [];
  for (const e of fns) {
    // Same predicate + upgrade as the gate note (scan.mjs) — one source of truth for a hole.
    const r = unverifiedHoleRule(e.fn, e.inferred, policyParsed, scopeMatches, ctx);
    if (r && !(cf && !reasonClassesMatch(ctx.reasonAcc.get(e.fn), cf))) {
      const [rule, upgrade] = ruleUpgrade(r);
      holes.push({ fn: e.fn, rule, unknownWhy: e.unknownWhy ?? [], upgrade });
    }
    // …and, INDEPENDENTLY of whether it is also a provable-purity hole, every rule the gate withheld on
    // this function: one entry per (function, rule), in report order, beside the holes rather than in a
    // separate array a consumer reading `unverified[]` would never look at.
    const h = ctx.held(e.fn);
    for (const u of unevaluatedOf(h)) holes.push({ fn: e.fn, rule: u.rule, why: u.why });
    held.push(...h);
  }
  const unevaluated = unevaluatedOf(held);
  // `ok` STAYS here and `advisoryAnswer` removes it when `unevaluated` is non-empty (the §3.2 omit-`ok`
  // rule, in one place). Neither boolean is a statement this input licenses: `ok: true` would certify a set
  // the verb could not judge, and `ok: false` would assert these entries are unverified PASSES — but the
  // gate could not decide whether they pass at all.
  return unevaluated.length ? { ok: holes.length === 0, unverified: holes, unevaluated }
                            : { ok: holes.length === 0, unverified: holes };
}
