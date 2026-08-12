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
 * CANONICAL grammar (candor-spec §3.3.1 ⟨0.10⟩ — one shape, every engine):
 *   node query.mjs <verb> <verb-args…> [--report <locator>] [--policy <file>] [--json] [--strict] [--include-unknown]
 * The report is DISCOVERED (walk up from CWD for a `.candor/` dir → `<that>/.candor/report`; CANDOR_REPORT
 * overrides) unless --report gives a locator (a dir → `<dir>/.candor/report`; a `.json` path → that report
 * path; else a prefix). diff/gains are the exception: two positional locators <current> <baseline>.
 *
 * DEPRECATED aliases (kept accepted through the 0.10 line, stderr-noted — candor-spec §3.3.1 / PART 17):
 *   node query.mjs <verb> <PREFIX> <verb-args…> [0|1]      (leading-positional report + trailing 0|1 sentinel)
 *   node query.mjs whatif/fix <prefix> <fn> <Effect> [policy-file] [0|1]   (positional policy)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePolicy, scopeMatches, discoverConfigPolicy, parseUnknownAliases, discoverConfigText,
         evaluatePolicy, reportNetClasses, resolveReasonClasses, discoverConfigPath,
         policyVocabularyAnchor, policyErrorText, policyRefusalUnevaluated, policyUnreadable, policyZeroRules,
         fatalPolicyErrors, refusalVerdict,
         unanswerableScoped } from "./policy.mjs";
import { hasReport } from "./query-core.mjs";
import { printAgents } from "./contract.mjs";
import { bestFinds } from "./surface.mjs";
import { isTestPath } from "./scan-core.mjs";
// ONE source of truth for loading + name-matching — query.mjs kept DRIFTED local copies that didn't
// merge sibling reports, didn't tolerate a corrupt report (bare JSON.parse → uncaught crash), and used
// a `matchTier` missing `#` (so the SAME query resolved differently between `impact` and `callers` on a
// JVM `Type#method` report). Importing the shared functions removes all three divergences (review find).
import { impact as coreImpact, path as corePath, gains as coreGains,
         show as coreShow, blindspots as coreBlindspots, blindspotsStats as coreBlindspotsStats,
         callers as coreCallers, callersFrontier, loadHierarchy,
         containment as coreContainment, diff as coreDiff,
         where as coreWhere, map as coreMap, whatif as coreWhatif,
         fix as coreFix, fixGate as coreFixGate, unverified as coreUnverified,
         matches as coreMatches, gainsCoverage, gainsCompletenessFields, parseClassFilter, ClassFilterError,
         loadReport, loadCallgraph, reportCallsGraph, loadGateReport, gateReportInputFiles,
         reportVersion, reportPackage,
         advisoryAnswer,
         reportCompleteness, mustHedge, completenessFields, absorbCompleteness } from "./query-core.mjs";
const emit = (v) => console.log(JSON.stringify(v, null, 1));
// ⟨0.24⟩ SPEC §3.2 — THE OTHER CHANNEL. `advisoryAnswer` withdraws the claim from the JSON; this withdraws
// it from the one a human reads, and the spec requires both because a test that reads one channel is
// evidence about one channel. candor-rust built a mutant that kept the whole JSON fix and deleted only the
// printed line, and it SURVIVED that engine's entire suite — absence-asserts on `ok` cannot see stderr.
// candor-java found the same hole independently: `✓ within policy` IS the prose `ok: true`, so removing the
// JSON field while leaving the sentence standing MOVES the false all-clear rather than removing it.
const advisoryIncompleteNote = (verb, unanalyzed) => {
  console.error(`candor-ts: ${verb} could NOT fully evaluate — the report declares ${unanalyzed.length} unit(s) candor could not analyze; a function in an unanalyzed file is absent from \`functions\`, so it cannot be enumerated here at all`);
  for (const u of unanalyzed) console.error(`    ${u.path}${u.reason ? `  (${u.reason})` : ""}`);
  console.error(`  (\`ok\` is OMITTED — neither value is a statement this input licenses; \`--strict\` exits 2, the could-not-evaluate code)`);
};
// ⟨0.24⟩ SPEC §3.2 `4fd140c` — the SAME other channel, for the OTHER thing an advisory verb cannot be more
// certain about than the gate: a rule whose narrowing evidence the report does not carry. The JSON withdraws
// `ok` and carries `unevaluated`; this says it where a human is looking. Written as a sibling of the note
// above rather than folded into it because the two causes are different — an unread FILE versus an
// unanswerable RULE — and a reader who is told the wrong one goes to the wrong place to fix it.
// `tail` is per-verb because the CONSEQUENCE is: `fix-gate`/`unverified` withdraw `ok` and their `--strict`
// exits 2, while `fix` answers about ONE function and has neither field nor flag — a note that promised
// both would be describing a document the reader is not holding.
const advisoryUnevaluatedNote = (verb, unevaluated, tail) => {
  console.error(`candor-ts: ${verb} could NOT fully evaluate — ${unevaluated.length} policy rule(s) could not be evaluated against this report; \`gate --report\` REFUSES over these (exit 2, SPEC §3.1 answerability), and an advisory verb may be LESS certain than the gate, never MORE (SPEC §3.2)`);
  for (const u of unevaluated) console.error(`    ${u.why}`);
  console.error(`  ${tail}`);
};
const UNEVAL_TAIL_STRICT = "(`ok` is OMITTED — neither value is a statement this input licenses; no remedy is offered for a boundary the gate could not adjudicate; `--strict` exits 2, the could-not-evaluate code)";

// ---- ⟨0.28⟩ SPEC §2 — AN ADVISORY VERB OVER A CONFIGURED ZERO-RULE POLICY ANSWERS WITH THE CAVEAT
// DOCUMENT, RESULT KEYS WITHHELD, EXIT UNCHANGED.
//
// §6.2 makes the same condition an exit-2 REFUSAL for the GATE, on the ground that `ok: true` is a claim
// about the code no such run is entitled to make. These verbs share that loader and were not touched by
// the rung. They are ADVISORY — they set no verdict, so the gate's refusal posture is the wrong import.
// What they DO produce is an answer *relative to a policy*, and relative to no rules that answer is not a
// finding, it is an absence of questions. MEASURED here 2026-08-12 over `# no rules yet`:
//
//     whatif      {"of":[…],"affected":[…],"violations":[],"ok":true}          exit 0
//     fix         {"crossing":false,"reason":"not-forbidden"}                  exit 0
//     fix-gate    {"ok":true,"remedies":[]}                                    exit 0 (also --strict)
//     unverified  {"ok":true,"unverified":[]}                                  exit 0 (also --strict)
//
// `not-forbidden` by a policy that forbids nothing is vacuously true — an all-clear produced by deleting
// the question. So the result keys are withheld: `unverified` does not emit an empty `unverified` list
// over a policy that asked nothing, for the same reason ⟨0.27⟩'s refusal document must not carry
// `violations`. And `fix` emits NO `crossing` KEY — ⟨0.28⟩ pins that key as present exactly when the verb
// answered, and here it did not.
//
// `fix` IS IN THE LIST BECAUSE THE LIST IS A CONDITION, NOT AN ENUMERATION. §2 names `whatif`/`fix-gate`/
// `unverified` because those were the three in front of the author, and records the divergence that
// created: candor-rust extended the rule to `fix` and flagged it, candor-swift read the list as closed and
// did not. Every verb that answers relative to a CONFIGURED policy takes this rule.
//
// NO NEW KEY. The document carries `unevaluated` with one entry naming the whole policy, in the EXACT
// spelling this engine's own gate routes already use for their zero-rule refusal (`policyZeroRules`, one
// builder, shared) — so the gate and the advisory verbs say the same thing about the same policy in the
// same words, which is what makes a cross-engine consumer possible at all.
//
// A policy that is NOT CONFIGURED is untouched: that remains the honest way to say "I am not gating"
// (§6.2), and it is exactly why a configured zero-rule policy is never a legitimate expression of it.
const policyAskedNothing = (pol) => !!pol && !pol.deny.length && !pol.allow.length && !pol.forbid.length;
const emitZeroRuleCaveat = (verb, policyFile, comp) => {
  const { unevaluated } = policyZeroRules(policyFile);
  console.error(`candor-ts: ${verb}: the policy at ${policyFile} yielded NO RULES — every line was ignored `
    + `(see the \`ignoring policy rule\` warnings above), the file is empty, or it holds only comments. A `
    + `policy with no rules ASKS NOTHING, so this verb has no answer to give relative to it: the result `
    + `keys are WITHHELD and this caveat stands in their place (SPEC §2 ⟨0.28⟩). \`gate\` refuses outright `
    + `over this policy (exit 2). If you did not mean to gate, remove the policy configuration rather than `
    + `pointing it at a file with no rules in it.`);
  // The report-completeness caveat rides the SAME document when it applies: the two disclosures are
  // independent — one says the policy asked nothing, the other that the report could not see everything —
  // and each says something the other does not.
  emit({ unevaluated, ...completenessFields(comp) });
};
// ⟨0.28⟩ SPEC §2's OTHER cause on the ADVISORY channel — `analyzed.count: 0`, which `advisoryIncompleteNote`
// above could not say because it is written around an unread FILE and this report names none. Same two
// channels, different sentence, and the tail is the OPPOSITE one: the gate exits 0 over these bytes
// (⟨0.24⟩: a disclosure, not an exit code), so `--strict` does not move either and this note is all there is.
// ⟨0.28⟩ The THIRD cause on the advisory channel — a report file under the locator whose bytes could not
// be parsed. Its own sentence because the repair differs (fix or re-write that file, not "re-scan the
// sources"), and the gate tail is the `unanalyzed` one: `gate --report` REFUSES over a corrupt member
// (measured, exit 2), so `--strict`'s exit is bounded by the gate exactly as for an unread source file.
const advisoryUnreadableNote = (verb, unreadable) => {
  console.error(`candor-ts: ${verb} could NOT fully evaluate — ${unreadable.length} report file(s) under this locator could not be parsed, and whatever they say is not in this answer:`);
  for (const f of unreadable) console.error(`    ${f}`);
  console.error("  (`ok` is OMITTED — neither value is a statement this input licenses; `gate --report` exits 2 over these bytes. Fix or regenerate the corrupt report.)");
};
// ⟨0.28⟩ SPEC §2's THIRD ROW on the ADVISORY channel. Its own sentence beside the judged-nothing one
// below, for the reason `incompleteAnswerNote` gives: that note asserts `analyzed.count: 0`, which a
// row-3 report never said, and the repair is a producer that emits a manifest rather than a scan that
// reaches a conclusion.
const advisoryNoManifestNote = (verb, files) => {
  console.error(`candor-ts: ${verb} could NOT fully evaluate — ${files.length} report(s) under this locator carry NO \`analyzed\` manifest at all (SPEC §2 row 3, a pre-⟨0.21⟩ producer), so they make no claim about what was judged and their silence licenses none either:`);
  for (const f of files) console.error(`    ${f}`);
  console.error("  (`ok` is OMITTED — neither value is a statement this input licenses. `gate --report` exits 0 over these bytes, so this note is the whole of the warning. Re-scan with a current engine so the report carries its manifest.)");
};
const advisoryJudgedNothingNote = (verb) => {
  console.error(`candor-ts: ${verb} could NOT fully evaluate — the report(s) under this locator say they JUDGED NOTHING (⟨0.24⟩ \`analyzed.count\` is 0, absent with no entries, or unreadable), so absence from \`functions\` licenses no purity claim about any unit and there is nothing here to certify`);
  console.error("  (`ok` is OMITTED — neither value is a statement this input licenses. NOTHING DOWNSTREAM WILL CATCH THIS FOR YOU: `gate --report` exits 0 over a judged-nothing report and `--strict` does not move either, so this note is the whole of the warning. Re-scan the sources you meant to check.)");
};
// The §6 effect vocabulary — used to reject a typo'd effect name in `where` (corpus-audit #3). Kept in step
// with SPEC §6 / the umbrella's list; an unknown name PRESENT in a report (a spec extension) is still allowed.
const KNOWN_EFFECTS = ["Net", "Fs", "Db", "Llm", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard", "Unknown"];
// Suggest the nearest known flag for a typo (longest shared prefix ≥3): `--polciy` → `--policy` (#2).
function didYouMeanFlag(unknown) {
  const known = ["--report", "--policy", "--json", "--text", "--strict", "--include-unknown", "--stats", "--class", "--gate-json"];
  const u = unknown.replace(/^-+/, "").toLowerCase();
  let best = null, bestLen = 2;
  for (const k of known) {
    const kn = k.replace(/^-+/, "");
    let s = 0; while (s < u.length && s < kn.length && u[s] === kn[s]) s++;
    if (s >= 3 && s > bestLen) { bestLen = s; best = k; }
  }
  return best ? ` — did you mean \`${best}\`?` : "";
}

// ---- #8 output mode: PROSE at a TTY, JSON when piped or `--json` — so interactive `candor where Db` reads
// like candor-java/-rust instead of dumping raw JSON, while a pipe/redirect (never a TTY) still yields the
// pinned JSON untouched. MCP/LSP call query-core directly (not this CLI), so they're unaffected; conformance
// passes `--json` or captures over a pipe → JSON. `--json` forces JSON; `--text`/`--human` forces prose. -----
const wantJsonOut = (a) =>
  a.includes("--json") || (!a.includes("--text") && !a.includes("--human") && !process.stdout.isTTY);
// Emit the pinned JSON, or render prose via proseFn(data). Returns data so the caller can still exit on it.
const put = (a, data, proseFn) => { if (!proseFn || wantJsonOut(a)) emit(data); else proseFn(data); return data; };

// ---- ⟨0.28⟩ SPEC §2 — THE COMPLETENESS CAVEAT ON A *DESCRIPTIVE* VERB. `advisoryAnswer` +
// `advisoryIncompleteNote` above are the two channels for a verb that renders a VERDICT; the clause they
// implement was scoped to verdicts, and ⟨0.28⟩ widens it to "any verb whose output could be read as a
// negative finding about the code — a verdict, an empty result set, or a zero count". These three helpers
// are the SAME two channels for an ANSWER. One reader (`reportCompleteness`), one key set
// (`completenessFields`), one trigger (`mustHedge`) — a second mechanism is how the family ended up with
// two element rules for the manifest reader, and how one channel goes quiet while the other is asserted on.

// What `gate --report` does over THESE SAME BYTES, as one sentence — a function and not a constant because
// the two causes get OPPOSITE answers. §3.3 makes an incomplete analysis of the target's own code an exit-2
// gate cause, so "the gate refuses too" is true of `unanalyzed`; ⟨0.24⟩ ruled count-0 the other way ("a
// disclosure, not an exit code"), so the gate exits 0 there. A note that sends the reader to a CI job which
// then passes teaches them the warning is noise — the disclosure discrediting itself. The count-0 sentence
// is also the more urgent one and says so: nothing downstream fails closed on those bytes.
const gateLine = (comp) => (comp.unanalyzed.length || comp.unreadable?.length
  ? "`gate --report` exits 2 over these bytes."
  : "NOTHING DOWNSTREAM WILL CATCH THIS FOR YOU — `gate --report` exits 0 over a judged-nothing report (⟨0.24⟩: a disclosure, not an exit code), so this note is the whole of the warning.");

// The HUMAN half. A no-op when there is nothing to disclose, so an ordinary run stays byte-identical, and
// printed BEFORE the answer because it qualifies a NON-EMPTY result as much as an empty one: a function in
// an unread file performs the effect or does not, and no list below can say which.
//
// ON STDOUT, WITH THE ANSWER IT QUALIFIES — this engine had it on stderr, alone against three: java
// documents stdout as deliberate ("a caveat on the other stream is one `2>/dev/null` from gone"), and
// swift's log records catching and REVERTING exactly this stderr choice after diffing against rust. The
// caveat and the answer must travel the same pipe, or a `2>/dev/null` consumer keeps the reassurance and
// loses its withdrawal. Every caller is on the PROSE branch (`putAnswer`'s else-arm, `tour`'s human arm,
// `gains`' else-arm), so stdout is never carrying a JSON document when this prints — JSON-mode runs take
// the machine half (`completenessFields`) instead and this function is not called at all.
const incompleteAnswerNote = (comp, soWhat, tail) => {
  if (!mustHedge(comp)) return;
  // Three causes, one sentence each, and only true ones: `unreadable` is a report file whose BYTES could
  // not be parsed — not "declared unanalyzed units" and not "judged nothing", both of which would send
  // the reader to the wrong repair (rust names it separately for the same reason).
  const causes = [];
  if (comp.unanalyzed.length)
    causes.push(`declare ${comp.unanalyzed.length} unit(s) candor could not analyze`);
  if (comp.judgedNothing.length)
    causes.push("say they JUDGED NOTHING (`analyzed.count: 0`)");
  // ⟨0.28⟩ SPEC §2's THIRD ROW, and it gets its OWN sentence because the one above was FALSE for it:
  // this engine told the reader a row-3 report "says it judged nothing (`analyzed.count: 0`)" when the
  // report declares nothing at all, and this family rates a false disclosure worse than a missing one.
  // The repairs differ too — row 1 wants a scan that reaches a conclusion, row 3 wants a producer that
  // emits a manifest — so a reader given the wrong one goes to the wrong place.
  if (comp.noManifest?.length)
    causes.push(`include ${comp.noManifest.length} report(s) carrying NO \`analyzed\` manifest at all`);
  if (comp.unreadable?.length)
    causes.push(`include ${comp.unreadable.length} file(s) that could not be parsed at all`);
  console.log(`candor-ts: ⚠ INCOMPLETE — the report(s) under this locator ${causes.join(", and ")}, so ${soWhat}:`);
  for (const u of comp.unanalyzed) console.log(`    ${u.path}${u.reason ? `  (${u.reason})` : ""}`);
  if (comp.judgedNothing.length)
    console.log("    (a report that judged nothing names no function at all — its silence is not a purity claim about any unit)");
  for (const f of comp.noManifest ?? [])
    console.log(`    ${f} — no \`analyzed\` manifest (a pre-⟨0.21⟩ producer): it makes no claim about what was judged, so its silence licenses none either. Re-scan with a current engine.`);
  for (const f of comp.unreadable ?? [])
    console.log(`    ${f} — could not be parsed (corrupt or mid-write), so whatever it says is not in this answer`);
  console.log(`    ${tail} ${gateLine(comp)}`);
};

// The MACHINE half. Spread LAST so the verb's own pinned key order is untouched (JS objects keep insertion
// order), and `{}` on a complete report — the whole document is then byte-identical to a pre-⟨0.28⟩ one.
//
// THE COLLISION GUARD THIS USED TO CARRY IS GONE, because ⟨0.28⟩ Rung A removed the only shape that could
// construct it. `map` was the one caller whose top level is a USER NAMESPACE, and it answered by MERGING
// the hedge over a module literally named `incomplete` and disclosing the loss on stderr — a lost row the
// operator was told about, which was the best available answer while the caveat had to ride the result.
// It no longer does: `map` takes `putCaveatInstead` below, where the caveat REPLACES the document and
// nothing is displaced. Every remaining caller has a FIXED key set of its own (`where`
// {effect,directly,inherited}, `reachable` {entryPoints,effects}, `containment` {contained,ambient},
// `blindspots` {sources,totalUnknown}), so a collision here is not constructible from any report.
// Deleted rather than kept as a dormant guard: a check whose condition cannot arise reads as coverage.
const withCompleteness = (data, comp) => ({ ...data, ...completenessFields(comp) });

// `put`, plus the caveat on BOTH channels from ONE trigger — a caller cannot get the JSON half and the prose
// half to disagree, which is exactly the mutant (`ec1a441`) that survived a whole suite in candor-rust.
// `proseFn` receives the hedge flag as its second argument so it can WITHDRAW its reassuring sentence; the
// note alone is not enough, because "no Unknown sources ✓" IS the prose spelling of the empty JSON.
const putAnswer = (a, data, proseFn, comp, soWhat, tail) => {
  if (!proseFn || wantJsonOut(a)) { emit(withCompleteness(data, comp)); return data; }
  incompleteAnswerNote(comp, soWhat, tail);
  proseFn(data, mustHedge(comp));
  return data;
};

// ---- ⟨0.28⟩ RUNG A — SPEC §2: "A VERB WHOSE PINNED SHAPE CANNOT CARRY THE CAVEAT MUST EMIT THE CAVEAT
// DOCUMENT INSTEAD OF ITS RESULT DOCUMENT." Not a result document with the caveat omitted, and not an
// empty result of the pinned shape. `putAnswer` above SPREADS the caveat into the answer, which works for
// every verb with a fixed key set; two verbs have no such place:
//
//   show   pinned to a TOP-LEVEL ARRAY — nowhere to put a key at all. MEASURED here 2026-08-12 over a
//          report declaring one `unanalyzed` unit: `[]`, exit 0, no caveat on ANY channel. *Nothing
//          performs this effect*, asserted about code nobody examined.
//   map    keyed by the operator's own MODULE names. MEASURED: the caveat keys merged INTO the module
//          namespace, and the merged shape disclosed the collision loudly while still dropping the row.
//
// AND THE RULING NAMES THIS ENGINE FOR WHY THE `@`-PREFIX ESCAPE IS NOT AVAILABLE: §2.2's convention is
// airtight for a sidecar because a `@`-key cannot collide with a TYPE name — but an npm scoped package is
// spelled `@scope/name`, so `@incomplete` is a key a real ts module could own. "A convention that is
// airtight in one namespace and merely unlikely in another is not a convention; it is a deferred
// collision."
//
// THE TYPE CHANGE IS THE POINT. A consumer doing `for (const x of doc)` over `show` gets a TypeError
// rather than a silent zero-iteration loop — the one case where breaking a consumer is the CORRECT
// outcome, because the consumer was being lied to. The exit does not move (⟨0.24⟩: a disclosure, not an
// exit code), and HEALTHY OUTPUT IS BYTE-IDENTICAL: the shape changes only on the hedge path.
//
// The PROSE arm is `putAnswer`'s, verbatim — prose has no shape problem, and the clause is about the
// machine document. Sharing the note + renderer call keeps the two channels from drifting.
//
// THE HEALTHY JSON ARM MUST NOT GO THROUGH `withCompleteness`, and the first draft of this helper did:
// it delegated to `putAnswer`, whose `{ ...data, ...{} }` turned `show`'s ARRAY into `{"0": {…}}` — the
// pinned top-level array destroyed on the very path this rung promises to leave byte-identical. Caught by
// the intact-input control before it left the machine. So the healthy arm emits `data` itself.
const putCaveatInstead = (a, data, proseFn, comp, soWhat, tail) => {
  if (!proseFn || wantJsonOut(a)) { emit(mustHedge(comp) ? completenessFields(comp) : data); return data; }
  incompleteAnswerNote(comp, soWhat, tail);
  proseFn(data, mustHedge(comp));
  return data;
};
// The one sentence every hedged prose arm ends with, so the six cannot drift into six wordings.
const NOT_A = (claim) => `— but see the INCOMPLETE note above; this is NOT "${claim}"`;
const csv = (xs) => (xs && xs.length ? xs.join(", ") : "none");
const rows = (xs, pre = "    ") => { for (const x of xs) console.log(pre + x); };
// Per-verb prose renderers. Read the SAME shapes query-core returns (so JSON and prose can't drift); kept
// terse and scannable, in candor's voice (cf. the existing `tour`/`path` human forms).
const P = {
  // ⟨0.28⟩ `hedge` is `mustHedge(comp)` (see `putAnswer`): the report could not support a determined
  // negative, so the reassuring sentence — which IS the prose spelling of the empty JSON — is withdrawn.
  // Never a manufactured finding in its place: the answer stands, its STANDING is what changes.
  where: (d, hedge) => {
    const n = d.directly.length + d.inherited.length;
    if (n === 0) {
      console.log(hedge
        ? `candor: 0 functions candor COULD SEE perform ${d.effect} ${NOT_A(`nothing performs ${d.effect}`)}.`
        : `candor: 0 functions perform ${d.effect} in this report.`);
      return;
    }
    console.log(`candor where ${d.effect} — ${n} function${n === 1 ? "" : "s"}:`);
    if (d.directly.length) { console.log(`  perform it directly (${d.directly.length}):`); rows(d.directly); }
    if (d.inherited.length) { console.log(`  reach it transitively (${d.inherited.length}):`); rows(d.inherited); }
  },
  callers: (d) => {
    // ⟨0.28⟩ UNREACHABLE FROM THE CLI since the callers verb split the empty-`of` case into its two real
    // causes below (no graph at all -> `unanswerable`, exit 2; a name absent from a real graph -> "no
    // function matching", exit 2). Kept as a renderer guard only; do NOT route a new caller through it —
    // this sentence is a determined negative and is the wrong answer when there is no call graph.
    if (!d.of.length) { console.log("candor: no function in the call graph matches that name."); return; }
    console.log(`candor callers — who reaches \`${d.of.join("`, `")}\`:`);
    console.log(`  direct callers (${d.direct.length}): ${csv(d.direct)}`);
    console.log(`  transitive callers (${d.transitive.length}): ${csv(d.transitive)}`);
  },
  show: (d, hedge) => {
    // ⟨0.28⟩ the empty sentence stops citing the ⟨0.21⟩ purity convention when the report cannot back it:
    // over these bytes an absent function is not evidence of purity, it is evidence of nothing.
    if (!d.length) {
      console.log(hedge
        ? `candor: no effectful function candor COULD SEE matches that name ${NOT_A("this function is pure")} — absence from this report licenses no purity claim here.`
        : "candor: no effectful function matches that name (pure functions are omitted from the report).");
      return;
    }
    d.forEach((e, i) => {
      if (i) console.log("");
      console.log(`${e.fn}`);
      console.log(`  effects: ${csv(e.inferred)}${e.direct && e.direct.length ? `   (direct: ${e.direct.join(", ")})` : ""}`);
      if (e.hosts?.length)  console.log(`  hosts:   ${e.hosts.join(", ")}`);
      if (e.cmds?.length)   console.log(`  cmds:    ${e.cmds.join(", ")}`);
      if (e.paths?.length)  console.log(`  paths:   ${e.paths.join(", ")}`);
      if (e.tables?.length) console.log(`  tables:  ${e.tables.join(", ")}`);
    });
  },
  map: (d, hedge) => {
    const mods = Object.entries(d);
    if (!mods.length) {
      console.log(hedge
        ? `candor: no effectful module candor COULD SEE ${NOT_A("the code performs no effects")}.`
        : "candor: no effectful modules in this report.");
      return;
    }
    console.log("candor map — effects by module:");
    for (const [m, v] of mods) console.log(`  ${m} — ${csv(v.effects)}  (${v.functions} fn${v.functions === 1 ? "" : "s"})`);
  },
  containment: (d, hedge) => {
    if ("leaks" in d) { // ratchet (a baseline was given)
      // The ✓ is withdrawn from BOTH directions here, not just the empty one: this answer is a DIFFERENCE,
      // so a partial side is unsound two ways — a leak in an unread CURRENT file is missed, one in an unread
      // BASELINE file reads as newly appeared (a fabricated leak, at exit 1).
      if (!d.leaks.length)
        console.log(hedge
          ? `candor containment — no boundary effect candor COULD SEE reached a new layer vs the baseline ${NOT_A("nothing leaked")}.`
          : "candor containment — no boundary effect reached a new layer vs the baseline. ✓");
      else { console.log(`candor containment — ${d.leaks.length} boundary effect(s) reached a NEW layer (leak):`); rows(d.leaks); }
      if (d.cleanups && d.cleanups.length) { console.log(`  no longer present (${d.cleanups.length}):`); rows(d.cleanups); }
      return;
    }
    if (!d.contained.length && !Object.keys(d.ambient).length) {
      console.log(hedge
        ? `candor containment — no boundary effect candor COULD SEE ${NOT_A("there are no boundary effects")}.`
        : "candor containment — no boundary effects in this report.");
      return;
    }
    console.log("candor containment — how well each boundary effect stays in one layer:");
    for (const c of d.contained)
      console.log(`  ${c.effect}: ${c.containmentPct}% in \`${c.owner}\` (spread across ${c.layers} layer${c.layers === 1 ? "" : "s"})`);
    const amb = Object.entries(d.ambient);
    if (amb.length) console.log(`  ambient (reported, not scored): ${amb.map(([e, n]) => `${e}×${n}`).join(", ")}`);
  },
  reachable: (d, hedge) => {
    const effs = Object.entries(d.effects);
    console.log(`candor reachable — what the ${d.entryPoints} entry point${d.entryPoints === 1 ? "" : "s"} do at runtime:`);
    // "the program performs no effect at runtime" is the strongest claim this tool can make, and it stays a
    // DETERMINED negative on good data (a library has no entry points) — which is exactly why the caveat
    // must be said, rather than left for a reader to infer from the emptiness.
    if (!effs.length) {
      console.log(hedge
        ? `  no effect reaches an entry point candor COULD SEE ${NOT_A("the program performs no effect at runtime")}.`
        : "  no effect reaches an entry point.");
      return;
    }
    for (const [e, v] of effs) console.log(`  ${e}: ${v.count} (via ${csv(v.via)})`);
  },
  impact: (d) => {
    console.log(`candor impact — the blast radius of \`${d.fn}\`:`);
    console.log(`  ${d.affectedCount} effectful function(s) transitively call it${d.affected.length ? ":" : "."}`);
    if (d.affected.length) rows(d.affected);
    if (d.entryPoints.length) { console.log(`  reachable from ${d.entryPoints.length} entry point(s):`); rows(d.entryPoints.map((ep) => `${ep.fn}  [${csv(ep.inferred)}]`)); }
  },
  blindspots: (d, hedge) => {
    if (!d.sources.length) {
      console.log(hedge
        ? `candor blindspots — no Unknown source candor COULD SEE ${NOT_A("there are no blind spots")}.`
        : `candor blindspots — no Unknown sources${d.totalUnknown ? " (all Unknown here is inherited, not rooted in a call)" : ""}. ✓`);
      return;
    }
    console.log(`candor blindspots — ${d.sources.length} Unknown source${d.sources.length === 1 ? "" : "s"} (of ${d.totalUnknown} function(s) carrying Unknown), most-smearing first:`);
    for (const s of d.sources) console.log(`  \`${s.fn}\` — ${csv(s.why)}; reaches ${s.reaches} caller(s)`);
  },
  blindspotsStats: (d, hedge) => {
    if (!d.sources) {
      console.log(hedge
        ? `candor blindspots --stats — no Unknown source candor COULD SEE (nothing to classify) ${NOT_A("there are no blind spots")}.`
        : "candor blindspots --stats — no Unknown sources (nothing to classify). ✓");
      return;
    }
    console.log(`candor blindspots --stats — ${d.sources} Unknown source(s) by reason class (of ${d.totalUnknown} function(s) carrying Unknown) — size the blind-spot cost before \`deny E Unknown[…]\`:`);
    Object.entries(d.byClass).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}${k === "setup" ? "   ← fixable: the scan isn't configured, not a real blind spot" : ""}`));
  },
  // ⟨0.28⟩ `hedge` is true when EITHER side's report is incomplete (see the gains case). "No newly-reached
  // effects ✓" IS the prose spelling of `gained: []`, and it is the determined negative this alarm verb
  // exists to license — so it is withdrawn, not decorated. A non-empty list is left standing: it may be
  // short, which the stderr note above says, but every entry in it was measured.
  gains: (d, hedge) => {
    if (!d.gained.length) {
      console.log(hedge
        ? `candor gains — no newly-reached effects candor COULD SEE vs the baseline ${NOT_A("this bump gained nothing")}.`
        : "candor gains — no newly-reached effects vs the baseline. ✓");
      return;
    }
    console.log(`candor gains — the surface newly reaches: ${d.gained.join(", ")}`);
    for (const g of d.byFunction) console.log(`  \`${g.fn}\` gained ${g.effect}${g.origin ? `  (${g.origin})` : ""}`);
  },
  diff: (d) => {
    if (!d.changes.length) { console.log("candor diff — no effect changes vs the baseline. ✓"); return; }
    console.log(`candor diff — ${d.changes.length} function(s) changed vs the baseline:`);
    for (const c of d.changes) console.log(`  \`${c.fn}\`${c.gained.length ? `  +${c.gained.join(",")}` : ""}${c.lost.length ? `  -${c.lost.join(",")}` : ""}`);
  },
};

// The fn-name UNIVERSE a `<fn>` target resolves against: the callgraph keys UNIONed with the report's fn
// names. Not a new set — this is byte-for-byte the one mcp.mjs's fn-existence guard already builds, so
// the CLI and the MCP surface refuse exactly the same names (a name the agent tool calls nonexistent must
// not be one the CLI silently answers `0` for). Used by the `impact`/`path` bad-target gates below.
//
// THE UNION IS THE SAFE DIRECTION. §2.2 makes every fn a callgraph key and the report is the effectful
// SUBSET, so today the union IS the keys; the union is what keeps that an observation rather than an
// assumption. Refusing only a name that resolves in NEITHER set means no answer these verbs can actually
// compute is ever withdrawn — gating on one set alone would be the ⟨0.24⟩ count-0 mirror defect the day
// the two disagreed.
const knownFnNames = (cg, fns) => [...new Set([...Object.keys(cg), ...fns.map((e) => e.fn)])];

// Render `path` in HUMAN (non-`--json`) form — the indented provenance chain, BYTE-IDENTICAL to the
// Rust reference (candor-query/src/callers.rs) and the Java port (Query.java). The `--json` shape is
// UNTOUCHED (conformance PART 5 pins `{effect, fn, path:[{fn,loc,source}]}` four-way): this path is
// only taken when the caller did NOT pass --json, and it reads the SAME `path` array corePath computes.
// Prints to stdout and returns nothing (matches the JSON-only verbs' fire-and-forget style).
function renderPathHuman(fns, cg, fnQ, eff) {
  // Resolve the start over the REPORT entries (as Rust does) — that's where `inferred` lives, and the
  // no-effect wording quotes it. The RESOLVED name (not the raw query) is then handed to corePath,
  // which re-resolves over the CALLGRAPH keys — a DIFFERENT name set: a raw partial query could pick
  // a different fn there (report `app.db.save`, graph `app.cache.save` for the query "save"), so the
  // header described one function and the chain/verdict another (a misleading "not statically
  // traceable" over a traceable fn). An exact name resolves identically in both sets (match tier 3,
  // exact, beats every partial tier and only its own name can equal it), so they cannot disagree.
  const start = coreMatches(fns.map((e) => e.fn), fnQ)[0];
  if (start === undefined) {
    // No matching function at all — parity with Rust/Java's "no function matching" (stderr, exit 2).
    console.error(`candor-query path: no function matching '${fnQ}'`);
    process.exit(2);
  }
  const startEntry = fns.find((e) => e.fn === start);
  const inferred = startEntry?.inferred ?? [];
  if (!inferred.includes(eff)) {
    // The effect is not even inferred — the honest "does not perform" answer (SPEC §3.1), NOT an error.
    // `inferred` is printed in Rust's `{:?}` debug shape: each name quoted, ", "-joined, in `[...]`,
    // in the report's original order (unsorted). An empty set prints `[]`.
    const dbg = `[${inferred.map((e) => `"${e}"`).join(", ")}]`;
    console.log(`${start} does not perform ${eff}  (inferred: ${dbg})`);
    return;
  }
  const r = corePath(fns, cg, start, eff);
  if (r.path.length === 0) {
    // Inferred, but no LOCAL direct source on a `calls` path — reached cross-crate or via Unknown.
    console.log(`${start} performs ${eff} but its source is not a local function `
      + `(cross-crate, or via Unknown) — not statically traceable.`);
    return;
  }
  console.log(`candor path — how \`${start}\` comes to perform ${eff}:\n`);
  r.path.forEach((step, i) => {
    const indent = "  ".repeat(i + 1);
    const arrow = i === 0 ? "" : "→ ";
    const isSource = i === r.path.length - 1;
    const tag = isSource
      ? `   [${eff} source${step.loc ? ` @ ${step.loc}` : ""}]`
      : "";
    console.log(`${indent}${arrow}${step.fn}${tag}`);
  });
}

// ONE version + spec source, the SAME way scan.mjs reads them: PKG_VERSION is the bare semver from
// package.json; SPEC_VERSION is the spec contract this build speaks. Reused, never re-littered.
const QUERY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(QUERY_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.27";

// ---- the §3.3.1 canonical query grammar (⟨0.10⟩, additive over 0.9) --------------------------------
// One shape for every verb: `<verb> <verb-args…> [--report <locator>] [--policy <file>] [--json]
// [--strict] [--include-unknown]`. The report is DISCOVERED by default; --report overrides. The old
// leading-positional-report form, the trailing `0|1` JSON sentinel, and a positional policy stay
// accepted as DEPRECATED aliases (stderr-noted) so the conformance suite's old-grammar invocations
// (and every 0.9 caller) keep working — never removed before the next breaking bump.

// A one-line deprecation note to STDERR (stdout stays pure JSON — the machine consumer never sees it).
// De-duplicated so a single invocation prints each distinct note at most once.
const _deprecated = new Set();
const deprecate = (msg) => { if (!_deprecated.has(msg)) { _deprecated.add(msg); console.error(`candor-ts-query: [deprecated] ${msg}`); } };

// Resolve a --report <locator> by the ONE §3.3.1 rule: a directory → `<dir>/.candor/report`; a path
// ending `.json` → that full report path (minus the `.json`, since loadReport takes a prefix and adds
// it back); otherwise a bare prefix. Returns the PREFIX loadReport/loadCallgraph expect.
function locatorToPrefix(loc) {
  try { if (fs.statSync(loc).isDirectory()) return path.join(loc, ".candor", "report"); } catch { /* not a dir */ }
  if (loc.endsWith(".json")) return loc.slice(0, -".json".length);   // full report path → its prefix
  return loc;                                                        // bare prefix
}

// DISCOVER the report prefix when no --report: CANDOR_REPORT env wins; else walk UP from CWD for a
// `.candor/` directory and use its `report` prefix (the §3.4 discovery mechanism, the twin of scan.mjs's
// config walk-up). Returns null when NEITHER is found — the caller then fails LOUD (exit 2). It must NOT
// fall back to a bogus `.candor/report` prefix: that made the loaders read ZERO functions and every
// discovery verb emit an authoritative-empty answer at exit 0 — a false all-clear, the §4 cardinal sin
// (`where Net` in a dir with no `.candor/` up-tree). Matches the Rust engine's discover_report_prefix.
function discoverReportPrefix() {
  const env = process.env.CANDOR_REPORT;
  if (env) return locatorToPrefix(env);
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".candor"))) return path.join(d, ".candor", "report");
    if (path.dirname(d) === d) break;                                // filesystem root
  }
  return null;                                                       // no --report, no .candor/ discovered
}

// The report prefix for a discovery verb (no --report): the parsed/explicit locator, else discovery.
// A null prefix (no --report AND nothing discovered) is a LOUD exit-2 failure — never a silent empty
// answer. A resolved prefix that names NO report files is likewise loud (hasReport). One helper so every
// verb's no-report path is identical to the Rust engine's (report_or_discover + the no-files check).
function requireReport(prefix) {
  if (prefix === null) {
    console.error("candor-ts: no report found (no --report and no .candor/ discovered) — scan the crate first.");
    process.exit(2);
  }
  if (!hasReport(prefix)) {
    console.error(`candor-ts: no report files at prefix '${prefix}' — check the path, or scan the crate first.`);
    process.exit(2);
  }
  return prefix;
}

// Load a report, but FAIL LOUD (exit 2) when a file was found yet nothing parsed — the disclose-and-
// tolerate loadReport returns [] there, which every verb would read as "no effects": `tour` prints
// "nothing hidden", a policy `map`/gate PASSES — the §4 cardinal-sin false all-clear over a corrupt
// report. A legitimately effect-free crate still writes a report that LISTS its functions, so empty +
// hardFail is always the corrupt case (mirrors candor-rust load_entries_loud; java/swift already die
// loud). One corrupt file among several still merges (non-empty → returned), staying tolerant.
function loadReportOrDie(prefix) {
  const fns = loadReport(prefix);
  if (fns.length === 0 && fns.hardFail) {
    console.error(`candor-ts: every report found at prefix '${prefix}' failed to load — refusing to report an empty (all-clear) answer over a corrupt report; re-run the scan.`);
    process.exit(2);
  }
  return fns;
}

// Parse the canonical flags out of a verb's args, leaving the POSITIONAL verb-args behind. Handles the
// deprecated `0|1` trailing sentinel (→ noted, dropped; JSON is the default here anyway) so the old
// grammar stays green. `flags` names the boolean flags this verb honours (`strict`/`includeUnknown`);
// `argc` is the verb's CANONICAL positional arity (report excluded) — the sentinel/leading-report peels
// are gated on the positional count EXCEEDING it, so a canonical arg (`show 1`, `callers 0`, `path fn 0`)
// is never eaten as a sentinel (matches the Rust grammar's Shape.verb_args arity gate).
// Returns { positionals, reportPrefix, reportExplicit, policyFile, strict, includeUnknown }.
function parseCanonical(rawArgs, { policy = false, strict = false, includeUnknown = false, argc = 0 } = {}) {
  const positionals = [];
  let reportLocator = null, policyFile = null, wantStrict = false, wantIncludeUnknown = false;
  let sawClass = false;   // ⟨0.24⟩ `--class` takes ONE list and is NOT repeatable (SPEC §6.2)
  // SPEC §3.2 ⟨0.28⟩ (every value-taking flag below): "given no value" MEANS the next token is
  // flag-shaped, or the clause is unimplementable — consuming the token as the value made this very
  // diagnostic unreachable and silently reinterpreted a flag. Measured on this file: `where Fs
  // --report --json` diagnosed the wrong cause ("no report files at prefix '--json'"), and on a
  // NON-policy verb `--policy --json` consumed-and-DISCARDED the next flag at exit 0 — a silently
  // different command than the one on screen, the §6.2 unknown-flag reinterpretation one position
  // over. A bare `-` stays a value and fails loud downstream (an unreadable file / unknown class);
  // `./--weird` spells a file genuinely named like a flag.
  const flagShaped = (v) => v !== undefined && v !== "-" && v.startsWith("-") && v.length > 1;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--report") {
      // A `--report` with no following value is a LOUD usage error (exit 2), never a silent fall-back to
      // discovery and never an uncaught `locatorToPrefix(undefined)` TypeError (`where Fs --report`).
      if (flagShaped(rawArgs[i + 1])) { console.error(`candor-ts: --report was given no value — the next token '${rawArgs[i + 1]}' is a flag, not a locator (a path really named that is spelled ./${rawArgs[i + 1]})`); process.exit(2); }
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --report requires a <locator> value (a directory, a .json report path, or a prefix)"); process.exit(2); }
      reportLocator = rawArgs[++i]; continue;
    }
    if (a === "--policy") { // consumed for EVERY verb (a valid candor flag); used only by policy verbs
      if (flagShaped(rawArgs[i + 1])) { console.error(`candor-ts: --policy was given no value — the next token '${rawArgs[i + 1]}' is a flag, not a path (a file really named that is spelled ./${rawArgs[i + 1]})`); process.exit(2); }
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --policy requires a <file> value"); process.exit(2); }
      const v = rawArgs[++i]; if (policy) policyFile = v; continue;
    }
    if (a === "--json" || a === "--text" || a === "--human") { continue; } // output-mode flags (#8) — consumed by
                                                                            // wantJsonOut(rawArgs), never a positional
    if (a === "--strict") { if (strict) wantStrict = true; continue; }                       // vocabulary — tolerated everywhere,
    if (a === "--include-unknown") { if (includeUnknown) wantIncludeUnknown = true; continue; } // used only by the verb that reads it
    if (a === "--stats") { continue; }   // ⟨0.20⟩ tolerated everywhere; read by the `blindspots` case via args.includes
    if (a === "--class") { // ⟨0.20⟩ value flag; the value is read by the `blindspots` and `unverified` cases
      if (flagShaped(rawArgs[i + 1])) { console.error(`candor-ts: --class was given no value — the next token '${rawArgs[i + 1]}' is a flag, not a <class,…> list`); process.exit(2); }
      if (i + 1 >= rawArgs.length) { console.error("candor-ts: --class requires a <class,…> value (reflect,dispatch,indirect,native,unresolved,setup; aliases: dynamic,*)"); process.exit(2); }
      // ⟨0.24⟩ SPEC §6.2's VALUE GRAMMAR, validated HERE — the one place every verb's args pass through, so
      // no verb can accept a value the filter will not honour. Two rules, one reason (see parseClassFilter):
      // a `--class` the engine cannot honour must be REFUSED, because honouring it partially SHRINKS the
      // answer and a shrunken answer is unreadable from a true all-clear.
      // (1) NOT REPEATABLE — a second `--class` is a usage error, not a union and not last-wins. The verbs
      // read `args.indexOf("--class")`, so a repeat silently took the FIRST list and dropped the rest: a
      // narrower answer than either flag asked for.
      if (sawClass) { console.error("candor-ts: --class is not repeatable — pass ONE comma-separated list (e.g. `--class reflect,native`); a second --class is a usage error, not a union"); process.exit(2); }
      sawClass = true;
      // (2) EVERY TOKEN RECOGNISED — a typo'd token exits 2 naming the token and the accepted set, rather
      // than dropping to an empty filter that reports zero holes at exit 0.
      try { parseClassFilter(rawArgs[i + 1]); }
      catch (e) { if (e instanceof ClassFilterError) { console.error(e.message); process.exit(2); } throw e; }
      i++; continue;
    }
    if (a === "--gate-json") {
      // ⟨0.24⟩ `--gate-json` is the GATE's verdict flag. On a read-only query it would be silently INERT,
      // which is the gateless-green shape: a wrapper names a verdict path, nothing writes it, the wrapper
      // reads no violations and calls the build clean. Name the verb that does emit one (java parity).
      console.error(`candor-ts-query: --gate-json applies to \`gate\` (and to a scan) — \`${cmd}\` emits no gate verdict.\n  Use: candor-ts-query gate --report <locator> --policy <file> --gate-json ${rawArgs[i + 1] ?? "<file>"}`);
      process.exit(2);
    }
    if (a.startsWith("-") && a.length > 1) {
      // An unrecognized flag is a TYPO, not a positional — reject it LOUD (exit 2), never silently swallow.
      // A swallowed `--polciy` runs the query with NO policy and exits green: a CI author who typos --policy
      // ships a gate that never fires (corpus re-audit cardinal sin — a loud error, never a silent guess).
      console.error(`candor-ts-query: unknown flag '${a}'${didYouMeanFlag(a)}\n  known flags: --report, --policy, --json, --text, --strict, --include-unknown, --stats`);
      process.exit(2);
    }
    positionals.push(a);
  }
  // Deprecated trailing `0|1` JSON sentinel (Rust/TS legacy): if the LAST positional is a bare 0 or 1,
  // strip it (candor-ts emits JSON regardless) and note the deprecation. ARITY-GATED: only when the
  // positional count EXCEEDS the verb's canonical arity — otherwise `show 1` / `callers 0` / `where 1` /
  // `path fn 0` would have their genuine query token eaten and run with a missing arg (degenerate empty
  // result, exit 0). Never strip a positional the canonical form needs (matches Rust's arity gate).
  if (positionals.length > argc && /^[01]$/.test(positionals[positionals.length - 1])) {
    deprecate("the trailing `0|1` JSON sentinel is deprecated — candor-ts emits JSON; use --json to select it explicitly");
    positionals.pop();
  }
  const reportExplicit = reportLocator !== null;
  const reportPrefix = reportExplicit ? locatorToPrefix(reportLocator) : discoverReportPrefix();
  return { positionals, reportPrefix, reportExplicit, policyFile, strict: wantStrict, includeUnknown: wantIncludeUnknown };
}

// A verb that takes ONE report + `argc` verb-positionals (where <Effect>: 1; show/callers/impact <fn>:
// 1; path <fn> <Effect>: 2; map/reachable/blindspots: 0). Applies discovery + --report, then peels the
// DEPRECATED leading-positional report: if --report wasn't given AND the first positional resolves to a
// report AND there's one positional MORE than the verb needs, treat that first token as the report.
// Returns { prefix, args } — `args` is exactly the verb's own positionals.
function resolveReportVerb(rawArgs, argc, opts = {}) {
  const p = parseCanonical(rawArgs, { ...opts, argc });
  let { positionals, reportPrefix } = p;
  if (!p.reportExplicit && positionals.length === argc + 1 && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>` (a dir, a .json path, or a prefix); the report is discovered from `.candor/` by default");
    reportPrefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  return { ...p, prefix: requireReport(reportPrefix), args: positionals };
}

// whatif/fix share a shape: one report + `<fn> <Effect>` + a policy. Canonical §3.3.1: `<fn> <Effect>
// [--policy <file>]`, report discovered/--report. DEPRECATED aliases (kept green for the old grammar):
// a leading-positional report AND a trailing positional policy — `<prefix> <fn> <Effect> [policy]`.
// Peels both (stderr-noted), then resolves the policy through resolvePolicy (flag > positional >
// CANDOR_POLICY > .candor/config). Returns { prefix, target, eff, policyFile }.
function resolveWhatifFix(rawArgs) {
  const p = parseCanonical(rawArgs, { policy: true, argc: 2 });
  let positionals = p.positionals, prefix = p.reportPrefix, positionalPolicy = null;
  // A leading-positional report fires only when --report is absent, there are MORE than the 2 verb args,
  // and the first token resolves to a report (else the extra positional is the deprecated policy).
  if (!p.reportExplicit && positionals.length > 2 && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the report is discovered from `.candor/` by default");
    prefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  const [target, eff, posPolicy] = positionals;               // a 3rd positional is the deprecated policy
  if (posPolicy) positionalPolicy = posPolicy;
  const { policyFile } = resolvePolicy(p.policyFile, positionalPolicy);
  return { prefix: requireReport(prefix), target, eff, policyFile };
}

// fix-gate/unverified share a shape: one report + a policy + no verb-positionals (unverified also takes
// --strict). Canonical §3.3.1: `[--policy <file>] [--strict]`, report discovered/--report. DEPRECATED
// alias: a leading report + a positional policy — `<prefix> <policy-file> [--strict]`. Peels both
// (stderr-noted), then resolves the policy through resolvePolicy. Returns { prefix, policyFile, strict }.
function resolveGateVerb(rawArgs, { strict = false } = {}) {
  const p = parseCanonical(rawArgs, { policy: true, strict, argc: 0 });
  let positionals = p.positionals, prefix = p.reportPrefix, positionalPolicy = null;
  if (!p.reportExplicit && positionals.length && hasReport(locatorToPrefix(positionals[0]))) {
    deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the report is discovered from `.candor/` by default");
    prefix = locatorToPrefix(positionals[0]);
    positionals = positionals.slice(1);
  }
  if (positionals[0]) positionalPolicy = positionals[0];       // the remaining positional is the deprecated policy
  const { policyFile } = resolvePolicy(p.policyFile, positionalPolicy);
  return { prefix: requireReport(prefix), policyFile, strict: p.strict };
}

// ⟨0.24⟩ `gate --report <locator> --policy <file> [--json] [--gate-json <file>]` (SPEC §3.1) — a QUERY
// verb, so it inherits §3.3.1's grammar unchanged: the same locator rules, the same discovery fallback,
// the same policy fallback, the same exit-2 on an unreadable policy. What it does NOT inherit is the
// deprecated-alias machinery, because it has NO POSITIONALS: a stray argument is a usage error, never
// probed as a report or a policy. Kept out of parseCanonical for that reason — the peel helpers exist to
// accept the old grammar, and there is no old grammar for a verb introduced at ⟨0.24⟩.
// ── SPEC §3.3.1 ⟨0.27⟩ sink-arming helpers, shared by the gate verb. The scan entry point has its own
// copies (scan.mjs) because it must not import from this file; the RULES are the spec's, not shared code.

/** Learn `--gate-json` and `--policy` from a verb's argv with NO side effects. */
function preScanGateArgs(av) {
  let gate = null, policy = null, report = null;
  for (let i = 0; i < av.length; i++) {
    const a = av[i], v = av[i + 1];
    if (a !== "--gate-json" && a !== "--policy" && a !== "--report") continue;
    if (v === undefined || (v.startsWith("-") && v !== "-")) continue;
    if (a === "--gate-json") gate = v; else if (a === "--policy") policy = v; else report = v;
    i++;
  }
  return { gate, policy, report };
}

/** Artifact identity, not string identity — `--policy /w/P --gate-json ./P` from /w is one file. */
function sameArtifactPath(a, b) {
  if (!a || !b || a === "-" || b === "-") return false;
  const resolve = (p) => {
    try { return fs.realpathSync(p); } catch { /* not there yet — resolve the parent */ }
    try { return path.join(fs.realpathSync(path.dirname(path.resolve(p))), path.basename(p)); }
    catch { return null; }
  };
  const x = resolve(a);
  return x !== null && x === resolve(b);
}

/** The files the CWD-discovered \`.candor/config\` names, resolved as the loader resolves them. */
function configDeclaredInputs() {
  const out = [];
  try {
    const disc = discoverConfigPolicy(process.cwd());
    if (disc?.policyPath) out.push([disc.policyPath, "the config policy key"]);
    const cfgPath = discoverConfigPath(process.cwd());
    if (cfgPath) out.push([cfgPath, 'the discovered .candor/config']);
  } catch { /* lenient: the real load refuses on its own terms */ }
  return out;
}

/** Refuse a sink that names an input of this run, having written nothing. */
function refuseGateJsonOverInput(gate, other, flag) {
  if (!sameArtifactPath(gate, other)) return;
  console.error(`candor-ts-query: --gate-json ${gate} names the SAME FILE as ${flag} ${other} — refusing `
    + `(exit 2). The verdict is armed before the policy is read, so this would overwrite your policy and `
    + `then gate on the wreckage. Nothing was written; give the verdict its own path.`);
  process.exit(2);
}

/** `.candor/config` is never a verdict sink, wherever it is. */
function refuseGateJsonAtConfig(gate) {
  if (!gate || gate === "-") return;
  const abs = path.resolve(gate);
  if (path.basename(abs) !== "config" || path.basename(path.dirname(abs)) !== ".candor") return;
  console.error(`candor-ts-query: --gate-json ${gate} is a .candor/config — refusing (exit 2). This would `
    + `destroy the config that configures this run. Nothing was written; give the verdict its own path.`);
  process.exit(2);
}

/** Write the fail-closed refusal every later exit inherits unless a real verdict replaces it. */
// ⟨0.28⟩ RESOLVE THE SINK TO ITS FINAL ARTIFACT BEFORE WRITING, and preserve the operator's layout.
// `renameSync` REPLACES a symlink rather than following it, so an `artifacts/verdict.json` linked into a
// shared directory kept a previous run's `{"ok": true}` while this run's document landed on the link — a
// stale green with a single `--gate-json` and no operator mistake. And rename gives the destination a NEW
// inode, so a multiply-linked target strands its other name with the previous document; there the write
// goes in place, trading the atomicity window for not publishing a stale verdict at a name the operator
// wired up. SPEC §3.3.1 states identity about ARTIFACTS; this family had it in the comparison only.
function resolveSinkArtifact(p) {
  let cur = p;
  for (let i = 0; i < 32; i++) {
    let st;
    try { st = fs.lstatSync(cur); } catch { return cur; }
    if (!st.isSymbolicLink()) return cur;
    let t;
    try { t = fs.readlinkSync(cur); } catch { return cur; }
    cur = path.isAbsolute(t) ? t : path.join(path.dirname(cur), t);
  }
  return cur;
}

function writeSinkAtomic(p, text) {
  const target = resolveSinkArtifact(p);
  try {
    if (fs.statSync(target).nlink > 1) { fs.writeFileSync(target, text); return; }
  } catch { /* not there yet — the ordinary temp+rename path is right */ }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

function armQueryGateJson(p) {
  try {
    writeSinkAtomic(p, JSON.stringify(
      refusalVerdict(SPEC_VERSION, "the gate did not complete — this document was written when the run "
        + "STARTED and was never replaced by a verdict, so the run failed, crashed or was killed before "
        + "it could decide. It is NOT a verdict about the code; see the run's stderr for the cause."),
      null, 1) + "\n");
  } catch (e) {
    console.error(`candor-ts-query: could not arm --gate-json ${p} fail-closed (${e.message})`);
  }
}

function resolveGateReportVerb(rawArgs) {
  const usageLine = "usage: candor-ts-query gate --report <locator> --policy <file> [--json] [--gate-json <file>]";
  let reportLocator = null, policyFile = null, gateJsonPath = null, json = false;
  // SPEC §3.3.1 ⟨0.27⟩ — ARM FIRST, AND NEVER OVER AN INPUT. A pre-pass with no side effects, so both
  // the collision refusal and the arming precede every exit in the loop below. See the note where the
  // arming used to live for why the previous ordering was wrong.
  {
    const { gate, policy, report } = preScanGateArgs(rawArgs);
    if (gate) {
      // THE STREAM HOOK IS INSTALLED FIRST, before anything that can exit. It WRITES NOTHING until the
      // process exits, so unlike the file arming below it cannot land on an input and has no reason to
      // wait behind the collision checks.
      //
      // It used to be installed after them, and `configDeclaredInputs()` — one of those checks — reads
      // the config, which exits 2 through a shared helper when the config is unreadable. So the earliest
      // exit-2 cause there is left stdout EMPTY on this route while java and swift wrote the refusal.
      // Found by the gate-verb cells in candor/bin/probe-causes.sh; candor-scan had the same gap through
      // the same shared loader, one language across.
      if (gate === "-") {
        process.on("exit", (code) => {
          if (code === 2 && !globalThis.__candorGateVerdictWritten) {
            console.log(JSON.stringify(refusalVerdict(SPEC_VERSION,
              "the gate did not complete — this run exited before a verdict could be produced", null), null, 1));
          }
        });
      }
      refuseGateJsonOverInput(gate, policy, "--policy");
      // §3.3.1 names "a report being read (`gate --report`)" as an input. Writing the verdict there
      // destroys the very report the gate was asked to judge, and the diagnostic then blames the report
      // rather than the collision.
      refuseGateJsonOverInput(gate, report, "--report");
      // ⟨0.28⟩ …AND THE FILES THE LOCATOR EXPANDS TO, because the raw flag value above is not what the
      // gate READS: a locator is a prefix/dir (or a discovery, when absent), and `loadGateReport` reads
      // its expansion — so a sink naming one of the expanded reports, or one of their §2.2 sidecars,
      // named an input the token comparison could not see. Enumerated by the loader-adjacent
      // `gateReportInputFiles` (query-core.mjs); the measurement lives there.
      const expandedInputs = gateReportInputFiles(report ? locatorToPrefix(report) : discoverReportPrefix());
      for (const f of expandedInputs) refuseGateJsonOverInput(gate, f, "a file this gate reads —");
      refuseGateJsonOverInput(gate, process.env.CANDOR_POLICY, "CANDOR_POLICY");
      // THE CONFIG-DECLARED POLICY. This verb's policy ladder falls back to the \`policy\` key of the
      // config discovered from the CWD, and the guard checked only the flags — so the checked-in form,
      // which is the one a CI job has, was destroyed at exit 0 while the flag form refused. The same
      // hole the scan route closed, one route across.
      for (const [p2, label] of configDeclaredInputs()) refuseGateJsonOverInput(gate, p2, label);
      refuseGateJsonAtConfig(gate);
      // ⟨0.28⟩ THE RUNG BINDS EVERY ROUTE. It shipped on scan.mjs only, so this verb kept last-wins and a
      // gate that FIRED left the first named sink holding a previous run's `{"ok": true}`. Every named
      // sink also gets the input checks, and the input exemption covers that PATH, not the run — so the
      // other sinks still receive the refusal.
      const namedSinks = [];
      for (let k = 0; k < rawArgs.length; k++) {
        if (rawArgs[k] !== "--gate-json") continue;
        const v = rawArgs[k + 1];
        if (v === undefined || (v !== "-" && v.startsWith("-"))) continue;
        if (!namedSinks.some((x) => x === v || (x !== "-" && v !== "-" && sameArtifactPath(x, v)))) namedSinks.push(v);
        k++;
      }
      for (const g of namedSinks) {
        refuseGateJsonOverInput(g, policy, "--policy");
        refuseGateJsonOverInput(g, report, "--report");
        // ⟨0.28⟩ the expanded report set (and its sidecars), exactly as the single-sink path asks it
        // above — a duplicate must not smuggle an expanded input past the guard.
        for (const f of expandedInputs) refuseGateJsonOverInput(g, f, "a file this gate reads —");
        refuseGateJsonOverInput(g, process.env.CANDOR_POLICY, "CANDOR_POLICY");
        refuseGateJsonOverInput(g, process.env.CANDOR_CONFIG, "CANDOR_CONFIG");
        for (const [p2, label] of configDeclaredInputs()) refuseGateJsonOverInput(g, p2, label);
        refuseGateJsonAtConfig(g);
      }
      if (namedSinks.length > 1) {
        const list = namedSinks.join(", ");
        console.error(`candor-ts-query: --gate-json given more than once (${list}) — refusing (exit 2). A `
          + `gate publishes ONE verdict. Naming two sinks says where it goes twice, and the reader of the `
          + `path that loses cannot tell it lost. Name one, or run the gate twice.`);
        const doc = JSON.stringify(refusalVerdict(SPEC_VERSION,
          `--gate-json was given more than once (${list}) — a run publishes one verdict to one sink`, null), null, 1);
        for (const g of namedSinks) {
          if (g === "-") { globalThis.__candorGateVerdictWritten = true; console.log(doc); continue; }
          try { writeSinkAtomic(g, doc + "\n"); }
          catch (e) { console.error(`candor-ts-query: could not write the refusal to --gate-json ${g} (${e.message})`); }
        }
        process.exit(2);
      }
      if (gate !== "-") armQueryGateJson(gate);
      // …AND THE STREAM'S ANALOG OF ARMING — now installed at the top of this block, see the note there. `armQueryGateJson` writes a fail-closed placeholder to a
      // FILE; a stream cannot hold one, so the equivalent is a hook that emits the refusal on any
      // exit-2 path that has not already written a verdict.
      //
      // Without it, this verb exited 2 during ARGUMENT PARSING with stdout EMPTY, while the same verb
      // refusing later from inside the gate streamed the document — the same operator mistake, two
      // answers, decided by how early it was caught. A machine consumer reading an empty stream after
      // exit 2 cannot tell it from a clean gate.
      //
      // Measured at the 0.27 go/no-go: java, swift and ts all had this hole on the `gate` verb, and
      // PART 36's stream rows never reached it because every one of them runs the SCAN route. The row
      // that catches it is now there.
    }
  }
  // SPEC §3.2 ⟨0.28⟩: "given no value" MEANS the next token is flag-shaped — consuming it as a filename
  // made this diagnostic unreachable and reinterpreted the command line: `--policy --gate-json -` read
  // *policy = the file named `--gate-json`* and diagnosed the displaced `-` as an "unexpected argument".
  // The sink the operator named is STILL a sink: the pre-pass above leaves a flag-shaped token live, so
  // `--gate-json -` after the broken flag installed the stream hook (and a file sink was armed
  // fail-closed) BEFORE this refusal fires — the exits below inherit that, like every other exit-2 in
  // this loop. A bare `-` stays a value; `./--weird` spells a file genuinely named like a flag.
  const flagShapedValue = (v) => v !== undefined && v !== "-" && v.startsWith("-") && v.length > 1;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--report") {
      if (flagShapedValue(rawArgs[i + 1])) { console.error(`candor-ts: --report was given no value — the next token '${rawArgs[i + 1]}' is a flag, not a locator (a path really named that is spelled ./${rawArgs[i + 1]})\n  ${usageLine}`); process.exit(2); }
      if (i + 1 >= rawArgs.length) { console.error(`candor-ts: --report requires a <locator> value (a directory, a .json report path, or a prefix)\n  ${usageLine}`); process.exit(2); }
      reportLocator = rawArgs[++i]; continue;
    }
    if (a === "--policy") {
      if (flagShapedValue(rawArgs[i + 1])) { console.error(`candor-ts: --policy was given no value — the next token '${rawArgs[i + 1]}' is a flag, not a path (a file really named that is spelled ./${rawArgs[i + 1]})\n  ${usageLine}`); process.exit(2); }
      if (i + 1 >= rawArgs.length) { console.error(`candor-ts: --policy requires a <file> value\n  ${usageLine}`); process.exit(2); }
      policyFile = rawArgs[++i]; continue;
    }
    if (a === "--gate-json") {
      // A valueless OR flag-shaped value FAILS (exit 2), so `--gate-json --policy p` cannot swallow the
      // policy and run GATELESS-GREEN — the one shape a wrapper never notices. `-` is stdout, not a flag.
      const v = rawArgs[i + 1];
      if (v === undefined || (v.startsWith("-") && v !== "-")) { console.error(`candor-ts: --gate-json requires a value (a path, or \`-\` for stdout)\n  ${usageLine}`); process.exit(2); }
      gateJsonPath = rawArgs[++i]; continue;
    }
    // `--json` IS `--gate-json -` (SPEC §3.1 ⟨0.24⟩), deliberately: on a scan `--json <file>` writes the
    // REPORT, and there is no report to write here, so the verb's machine output is the VERDICT. A second
    // meaning would be the one place a consumer could tell the two routes into the gate apart.
    if (a === "--json") { json = true; continue; }
    if (a === "--text" || a === "--human") { continue; }   // output-mode vocabulary — accepted, inert here
    if (a.startsWith("-") && a.length > 1) {
      console.error(`candor-ts-query gate: unknown flag '${a}'${didYouMeanFlag(a)}\n  ${usageLine}`);
      process.exit(2);
    }
    console.error(`candor-ts-query gate: unexpected argument '${a}' — \`gate\` takes no positionals; the report is a --report locator and the policy a --policy file\n  ${usageLine}`);
    process.exit(2);
  }
  // ARMING MOVED ABOVE THE FLAG LOOP (SPEC §3.3.1 ⟨0.27⟩).
  //
  // It used to sit here, and the comment justified it with a ⟨0.24⟩ ruling of my own: "a USAGE error was
  // never a gate invocation, so it must write NOTHING". SPEC §3.3 says the opposite in terms — it names
  // an unknown flag as a broken-gate-config exit-2 cause, and §3.1 adds that "if `--gate-json` was
  // requested and the run exits 2 for ANY reason, a fail-closed document is written", calling a
  // carve-out "a fail-open path with a reason attached". The ruling I built here was that carve-out, and
  // the test pinning it pinned a reading the spec had already superseded. The stale green does not care
  // that the operator's shell also failed.
  const _policy = resolvePolicy(policyFile, null).policyFile;
  const prefix = requireReport(reportLocator !== null ? locatorToPrefix(reportLocator) : discoverReportPrefix());
  return { prefix, policyFile: _policy, gateJsonPath, json };
}

/**
 * ⟨0.24⟩ ONE policy LOAD for every verb in this file that consults one, so the vocabulary anchor and the
 * unreadable-policy posture cannot drift between them (SPEC §6.2 `382a7e0`/`be0b9a9`, §3.1 `99eb4e9`).
 *
 * Two defects it closes at once, and the second is why it had to be a shared helper rather than a check
 * bolted onto the gate. `whatif`, `fix`, `fix-gate` and `unverified` never loaded `unknown-alias` AT ALL:
 * they silently rewrote an aliased rule — widening or narrowing it — while the gate honoured it, so the
 * same policy meant two different things in the verb an agent consults BEFORE editing and in the gate that
 * judges the edit. And once an unrecognised token became a policy ERROR, those same four verbs would have
 * started REFUSING a perfectly valid aliased policy. Wiring the anchor in makes them right; the refusal
 * alone would only have made them loud.
 */
function loadPolicyOrDie(policyFile, text) {
  const errs = [];
  const aliases = parseUnknownAliases(discoverConfigText(policyVocabularyAnchor(policyFile, process.cwd())), errs);
  const pol = parsePolicy(text, aliases);
  errs.push(...pol.errors);
  // ⟨0.24⟩ FATAL only: `errors` also carries every LINE the parser dropped whole (SPEC §3.1
  // `195d45a`) — additive to the `parsepolicy` witness, deliberately silent about the gate.
  const fatal = fatalPolicyErrors(errs);
  if (fatal.length) { console.error(policyErrorText(policyFile, fatal)); process.exit(2); }
  return pol;
}

// Resolve the policy for the gate verbs (whatif/fix/fix-gate/unverified): the --policy flag, else the
// deprecated positional policy, else CANDOR_POLICY, else the `.candor/config` `policy` key (§3.3/§3.4,
// the same precedence scan.mjs uses). Returns { policyFile, fromPositional } — policyFile null if none.
function resolvePolicy(policyFlag, positionalPolicy) {
  if (policyFlag) return { policyFile: policyFlag, fromPositional: false };
  if (positionalPolicy) {
    deprecate("a positional policy file is deprecated — pass it as `--policy <file>` (or set CANDOR_POLICY / a .candor/config `policy` key)");
    return { policyFile: positionalPolicy, fromPositional: true };
  }
  if (process.env.CANDOR_POLICY) return { policyFile: process.env.CANDOR_POLICY, fromPositional: false };
  const disc = discoverConfigPolicy(process.cwd());
  if (disc?.policyPath) return { policyFile: disc.policyPath, fromPositional: false };
  return { policyFile: null, fromPositional: false };
}

// The full subcommand catalogue — name + one-line description (derived from the per-subcommand
// comments + the module-doc header). The single source for the --help list AND the no-arg/unknown
// usage, so the two can never drift back to a stale hand-list again.
// Grammar per candor-spec §3.3.1 ⟨0.10⟩: the report is a FLAG (--report), discovered from `.candor/`
// by default; verb args are positional; --json selects JSON; --policy supplies a policy. The old
// leading-positional/`0|1`/positional-policy forms stay accepted as deprecated aliases (see the parser).
const REPORT_TAIL = "[--report <locator>] [--json]";
const SUBCOMMANDS = [
  ["parsepolicy", "<file>", "parse a policy file (candor-spec §6.2) and print it as JSON"],
  ["show", `<query> ${REPORT_TAIL}`, "the effect record(s) for a function — direct, inferred, surfaces"],
  ["where", `<Effect> ${REPORT_TAIL}`, "functions with an effect, split into directly / inherited"],
  ["callers", `<query> [--include-unknown] ${REPORT_TAIL}`, "who reaches a function: {of, direct, transitive}"],
  ["map", REPORT_TAIL, "per-module effect rollup: {effects, functions} by module"],
  ["containment", `[<baseline>] ${REPORT_TAIL}`, "§6.1 boundary-effect dispersion; with a baseline, the leak ratchet (exit 1)"],
  ["diff", "<current> <baseline> [--json]", "per-function effect delta vs a baseline: {changes:[{fn,gained,lost}]} (exit 1 on a gain)"],
  ["reachable", REPORT_TAIL, "effects unioned over the entry points: what the app DOES at runtime"],
  ["impact", `<query> ${REPORT_TAIL}`, "blast radius of a function (backward dual of reachable)"],
  ["blindspots", `${REPORT_TAIL} [--stats] [--class <c,…>]`, "the Unknown sources ranked by blast radius; --stats: reason-class distribution; --class: drill down"],
  ["tour", `[<N>] ${REPORT_TAIL}`, "the N most surprising transitive reaches — the guided cold-repo poke (no re-scan)"],
  ["gains", "<current> <baseline> [--json] [--strict]", "the supply-chain alarm: what the surface gained between two reports (--strict: exit 1 on ANY gain)"],
  ["path", `<fn> <Effect> ${REPORT_TAIL}`, "a call path from a function to where an effect enters"],
  ["whatif", `<fn> <Effect> [--policy <file>] ${REPORT_TAIL}`, "the impact of giving a function an effect, vs a policy (exit 1 on a violation)"],
  ["fix", `<fn> <Effect> [--policy <file>] ${REPORT_TAIL}`, "the boundary fix: where the effect belongs + the hoist refactor"],
  ["fix-gate", `[--policy <file>] [--strict] ${REPORT_TAIL}`, "a fix for EVERY boundary crossing — advisory (--strict: exit 1 while any remains)"],
  ["unverified", `[--policy <file>] [--strict] [--class <c,…>] ${REPORT_TAIL}`, "pure/deny layers that PASS but are Unknown (not PROVABLY clean); --class: drill down"],
  ["gate", "--report <locator> --policy <file> [--json] [--gate-json <file>]", "apply a policy to an EXISTING report, no scan — the supply-chain gate (exit 0/1/2)"],
  ["agents", "", "print the agent contract for this build (AGENTS.md)"],
];

// The full usage block — every real subcommand, replacing the stale hand-list. Printed to stderr on
// the no-arg / unknown-command path (exit 2) and reused in --help (stdout, exit 0).
const usage = () => {
  const w = Math.max(...SUBCOMMANDS.map(([n, a]) => `${n} ${a}`.trimEnd().length));
  const lines = SUBCOMMANDS.map(([n, a, d]) => `  ${`${n} ${a}`.trimEnd().padEnd(w)}  ${d}`);
  lines.push(`  ${"-V, --version".padEnd(w)}  print the installed version + upgrade line (offline)`);
  lines.push(`  ${"-h, --help".padEnd(w)}  show this help`);
  return `USAGE: candor-ts-query <command> [args]\n\n${lines.join("\n")}`;
};

// --version / -V: a print-and-exit MODE, handled before the switch so it never depends on a command.
// Fully OFFLINE — candor never phones home. Staying current is the AGENT's job.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`candor-ts-query ${PKG_VERSION} (spec ${SPEC_VERSION})`);
  console.log("upgrade: npm install -g candor-ts@latest");
  process.exit(0);
}

// -h / --help: a print-and-exit MODE, handled before the switch (so `-h`'s single dash is never
// mistaken for a command). House-style page: identity + model paragraph + COMMON/ALL ACTIONS
// (the action names derived from SUBCOMMANDS, so the list can never go stale) + OPTIONS + footer.
// The exit-2 error path keeps the denser fully-described usage() above.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  const names = SUBCOMMANDS.map(([n]) => n);
  const allActions = [names.slice(0, 9), names.slice(9)].map((row) => `  ${row.join("  ")}`).join("\n");
  console.log(`candor-ts-query — read-only queries over a candor report.

Answers come from the report candor-ts wrote — discovered by walking up from the
cwd to a .candor/ dir (CANDOR_REPORT overrides; --report pins a locator). No
re-scan, no network. Every engine speaks the same grammar, so these actions and
flags match the rest of the family.

USAGE
  candor-ts-query <action> [args] [options]

COMMON ACTIONS
  where <Effect>            the functions that perform an effect
  path <fn> <Effect>        the call path by which a function reaches an effect
  callers <fn>              who calls a function, direct and transitive
  tour [N]                  the N most surprising transitive reaches (default 10)
  blindspots                the Unknown sources worth resolving, ranked by reach
  gains <current> <base>    what a new version newly reaches (the supply-chain diff)
  fix <fn> <Effect>         the boundary hoist that would clear a violation
  gate --policy <file>      apply a policy to an EXISTING report, no scan (exit 0/1/2)

ALL ACTIONS
${allActions}

OPTIONS  (uniform across every engine)
  --report <locator>        use this report instead of discovering .candor/
  --policy <file>           evaluate a policy — exit 1 on a violation (whatif, fix, fix-gate,
                            unverified, gate; CANDOR_POLICY / a .candor/config \`policy\` key when absent)
  --gate-json <file>        gate: write the structured verdict there (\`-\` = stdout). \`--json\` IS
                            \`--gate-json -\` — there is no report to write, so the machine output of
                            \`gate\` is the verdict. Any other action rejects the flag (exit 2)
                            rather than accepting it and writing nothing.
  --json                    machine-readable JSON (the default when output is piped/redirected;
                            \`gate\` takes it explicitly, so a pipe never changes its verdict route)
  --text, --human           human-readable prose (the default at a terminal)
  --include-unknown         callers: also list the unresolved-dispatch frontier
  --class <c,…>             blindspots/unverified: drill down by Unknown reason class. ONE
                            comma-separated list, NOT repeatable, drawn from reflect, dispatch,
                            indirect, native, unresolved, setup — plus \`dynamic\` (every genuine
                            class, i.e. all but setup) and \`*\` (all). An unrecognised token is a
                            usage error (exit 2), never a silently narrower answer.
  --strict                  make an advisory verb a CI gate — exit 1 while a finding remains:
                            unverified (an unverified-purity hole), fix-gate (a boundary
                            crossing), gains (ANY gained effect). Advisory (exit 0) otherwise.
                            ⟨0.24⟩ EXIT 2 — could-not-fully-evaluate, the gate's own code — when the
                            report declares \`unanalyzed\`, or when a policy rule's narrowing
                            evidence the report does not carry made \`gate --report\` refuse: an
                            advisory verb may be LESS certain than the gate, never MORE (SPEC §3.2).
  -V, --version             print the installed version + upgrade line (offline)
  -h, --help                show this help

  diff and gains take two positional report locators: <current> <baseline>. Run
  candor-ts-query with no action for the full per-action argument list.

EXAMPLES
  candor-ts-query where Db
  candor-ts-query path app.orders.render Net
  candor-ts-query gains new/.candor/report.json old/.candor/report.json
  candor-ts-query fix-gate --policy candor.policy
  candor-ts-query gate --report node_modules/left-pad/.candor/report.json --policy candor.policy

Docs: candor.poly.io   ·   Verify an install: candor doctor
See https://github.com/tombaldwin/candor`);
  process.exit(0);
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case "--agents":
  case "agents":
    printAgents(); // shared with scan.mjs — one implementation, can't diverge within an install
    break;
  case "parsepolicy": {
    // An unreadable/missing file is a clean exit-2 error, not an uncaught readFileSync stack trace.
    let text;
    try {
      text = fs.readFileSync(args[0], "utf8");
    } catch {
      console.error(`candor: policy ${args[0] ?? "(no file given)"} could not be read`);
      process.exit(2);
    }
    // ⟨0.19⟩ config-aware: resolve `Unknown[<alias>]` via a checked-in `unknown-alias`, anchored to the
    // policy file (or CANDOR_CONFIG) — the dump reflects real gate resolution + pins the four-way expansion.
    //
    // ⟨0.24⟩ THIS VERB MUST NOT REFUSE (SPEC §3.1 `6929dce`), and it is the one policy-consulting verb that
    // must not. Making an unrecognised token a policy ERROR (§6.2 `be0b9a9`) is right for the GATE, which
    // must not enforce a policy it cannot honour as written — but applying it in the PARSER put the refusal
    // on the WITNESS, whose entire job is to answer "what did this engine make of my policy?", a question
    // most valuable exactly when the answer is "not what you meant". Measured: this verb began exiting 2 on
    // the conformance battery, which carries `Unknown[bogus,reflect]` and `Net[bogus,unknown-host]`
    // DELIBERATELY, and the four-way suite HALTED at PART 4 — one ruling took the whole cross-impl
    // differential offline. A diagnostic that declines to explain the thing being diagnosed has inverted
    // its purpose.
    //
    // So: the parse, PLUS `errors` naming every token that could not be honoured and the accepted set, at
    // exit 0. The token has to APPEAR as an error rather than being silently dropped — pre-⟨0.24⟩ this was
    // drop-with-a-warning, and a differential that cannot tell "dropped" from "rejected" cannot pin this
    // rung at all. The rules themselves are unchanged, which is what keeps PART 4's deny/allow/forbid
    // comparison meaningful across the engines that report the error differently.
    const ppErrs = [];
    const ppAliases = parseUnknownAliases(discoverConfigText(policyVocabularyAnchor(args[0], process.cwd())), ppErrs);
    const ppPol = parsePolicy(text, ppAliases);
    emit({ ...ppPol, errors: [...ppErrs, ...ppPol.errors] });
    break;
  }
  case "show": {
    // Was a hand-copy of query-core's show that had DRIFTED — it read the wrong Fs key (`e.fs`, never
    // written; the paths silently vanished) and dropped Exec `cmds` entirely. Call the shared show so
    // the CLI and the MCP `candor_show` are one implementation that cannot diverge again.
    const { prefix, args: [q] } = resolveReportVerb(args, 1);
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never a silently-empty
    // `[]` at exit 0, which reads as an authoritative "no such function" over a question never asked.
    if (!q) { console.error("usage: candor-ts-query show <query> [--report <locator>] [--json]"); process.exit(2); }
    // ⟨0.28⟩ RUNG A — `show`'s pinned shape is a TOP-LEVEL ARRAY, so over a hedging report it emits the
    // CAVEAT DOCUMENT INSTEAD (see `putCaveatInstead`). Before this it took plain `put` and had no
    // completeness reader at all: measured, `[]` at exit 0 over a report whose own manifest names a file
    // candor could not read — the only verb of the six with no caveat on EITHER channel.
    putCaveatInstead(args, coreShow(loadReportOrDie(prefix), q), P.show, reportCompleteness(prefix),
      `the function(s) shown below are only those candor could SEE match \`${q}\``,
      "A function in an unread unit is ABSENT from the report, so it cannot be shown here at all. Re-scan for a complete answer.");
    break;
  }
  case "where": {
    // Shared query-core (like show/callers) — the CLI and MCP `candor_where` are ONE implementation.
    // Hand-copies of core functions in this file have drifted three times (show, callers, diff); the
    // fix each time was the same: delegate, keep query.mjs as arg-parsing + emit + exit codes only.
    const { prefix, args: [eff] } = resolveReportVerb(args, 1);
    // A missing/empty <Effect> is a LOUD usage error (exit 2, like candor-java's missing-arg path) —
    // never an authoritative-empty {directly:[],inherited:[]} at exit 0 (a false all-clear shape).
    if (!eff) { console.error("usage: candor-ts-query where <Effect> [--report <locator>] [--json]"); process.exit(2); }
    // A typo'd / unknown effect NAME is a LOUD error (exit 2) — never a false-empty {directly:[],inherited:[]}
    // at exit 0, which reads as an authoritative "nothing performs Net" when the user actually typed "Network"
    // (corpus-audit #3). A KNOWN effect that is simply absent stays a valid 0-result; an unknown name that is
    // PRESENT in the report (a spec extension effect) is allowed — so error only when the name is NEITHER.
    const fnsW = loadReportOrDie(prefix);
    if (!KNOWN_EFFECTS.includes(eff) && !new Set(fnsW.flatMap((e) => e.inferred || [])).has(eff)) {
      console.error(`candor-ts-query where: unknown effect '${eff}' (known: ${KNOWN_EFFECTS.join(", ")})`); process.exit(2);
    }
    // ⟨0.28⟩ SPEC §2 — `{"directly":[],"inherited":[]}` is one of the four empty answers the clause names
    // by measurement. The caveat rides the SAME document (see `putAnswer`); the exit code does not move.
    putAnswer(args, coreWhere(fnsW, eff), P.where, reportCompleteness(prefix),
      `the function(s) named below are only those candor could SEE perform ${eff}`,
      `A function in an unread unit is ABSENT from the report, so it cannot appear in either list. Re-scan for a complete answer.`);
    break;
  }
  case "callers": {
    // --include-unknown ⟨0.7⟩ adds the unresolved-dispatch frontier (possibleViaUnknownDispatch); without
    // it, the byte-for-byte {of,direct,transitive} shape is unchanged (cross-engine parity). Call the
    // shared query-core so the CLI and MCP compute one truth (the prior inline copy had drifted before).
    const { prefix, args: [q], includeUnknown } = resolveReportVerb(args, 1, { includeUnknown: true });
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never an empty
    // {of:[],direct:[],transitive:[]} at exit 0 (reads as "nothing reaches it" for a fn never named).
    if (!q) { console.error("usage: candor-ts-query callers <query> [--include-unknown] [--report <locator>] [--json]"); process.exit(2); }
    // ⟨0.28⟩ PREFER THE §2.2 SIDECAR, FALL BACK TO THE REPORT'S OWN `calls` EDGES — rust's exact split
    // (callers.rs). The sidecar records EVERY function including pure ones, so it is the COMPLETE graph;
    // the report's embedded edges are effect-relevant only, but a report is a §3.3.1 locator in its own
    // right (a single hand-copied report.json) and rust/java answer real callers over it at exit 0 while
    // this engine refused `unanswerable` exit 2 — a one-engine divergence that broke a cross-engine
    // script. The fail-closed arm below now fires only when the graph is GENUINELY absent (no sidecar
    // AND no embedded edges — the armed pair), which narrows when it fires without removing it.
    const cg = loadCallgraph(prefix);
    const completeGraph = Object.keys(cg).length > 0;
    const graph = completeGraph ? cg : reportCallsGraph(loadReportOrDie(prefix));
    const cres = includeUnknown ? callersFrontier(graph, loadReportOrDie(prefix), loadHierarchy(prefix), q) : coreCallers(graph, q);
    // A nonexistent function is a LOUD error (exit 2), like path/impact — never an empty {of:[],direct:[],
    // transitive:[]} at exit 0, which reads as an authoritative "nothing calls it" for a fn that doesn't exist
    // (corpus-audit #3). Gated on a NON-empty callgraph so a missing sidecar isn't misreported as "no such fn".
    if (cres.of.length === 0) {
      // ⟨0.28⟩ UNANSWERABLE MUST REACH THE MACHINE CHANNEL (SPEC §3.3.1). This branch printed
      // `{"of":[],"direct":[],"transitive":[]}` at exit 0 while the human arm said "no function in the
      // call graph matches that name" — and BOTH readings are a determined negative, which is worse than
      // the reference engines' split: rust/java's human arm at least said "no call graph in the report".
      // A consumer reading `direct`, or defaulting it (the fail-open idiom ⟨0.24⟩ names on every key in
      // this format), is told NOBODY CALLS this function: a blast radius of "safe to edit" over a pair
      // whose honest answer is "this run judged nothing". The ⟨0.28⟩ sidecar rule (scan.mjs, which
      // deletes the §2.2 sidecars with an armed report) did not dig this hole — an absent sidecar has
      // always answered this way — it aimed traffic at it by making no-sidecar the STANDARD state after
      // a failed run.
      //
      // BOTH CHANNELS FAIL CLOSED: the document names itself unanswerable AND the exit is non-zero.
      // §3.3.1 permits either, but each ALONE leaves a naive reader exposed — the key alone still lets
      // `d.direct ?? []` read as a determined negative, and the exit alone leaves a JSON consumer
      // holding an empty document. Same shape as rust `358e117` / java `927252c`.
      //
      // ONLY THIS ARM, and the control separation is the load-bearing half. An EMPTY graph means there
      // is no call graph AT ALL (no §2.2 sidecar, and ⟨0.24⟩ rules an empty/unparseable one identical to
      // an absent one), which is the unanswerable case. A function with genuinely no callers over a REAL
      // graph still answers `direct: []` at exit 0 below — a determined negative, and withdrawing it
      // would be the mirror defect (the ⟨0.24⟩ count-0 lesson) — and a name absent from a real graph
      // still exits 2 as "no function matching", because a graph WAS read there.
      //
      // ONE SITE, MEASURED NOT ASSUMED: the rust reference had this branch twice (callers_via_callgraph
      // + the frontier variant) and warned to grep for both; candor-ts folds `--include-unknown` through
      // this same block via `callersFrontier`, so `grep -n 'coreCallers\|callersFrontier' query.mjs`
      // finds exactly one CALL site (plus the import). Verified through the flag as well: `--json
      // --include-unknown` discloses too. The MCP surface was measured, not assumed, and already fails
      // closed — `candor_callers` over an armed pair returns `isError: true` from mcp.mjs's fn-existence
      // guard, which unions the callgraph keys with the report's fns, both empty here.
      if (Object.keys(graph).length === 0) {
        const why = "no call graph in the report — the §2.2 sidecar is absent, so who calls this function is UNANSWERABLE, not empty (SPEC §3.3.1 ⟨0.28⟩)";
        put(args, { of: [q], unanswerable: why }, () => console.log(`candor: ${why}`));
        process.exit(2);
      }
      // ⟨0.28⟩ Only the COMPLETE graph (the sidecar) can prove a name absent. Over the effect-only
      // fallback a miss is INCONCLUSIVE — a pure leaf called only by pure fns is simply invisible there —
      // so the answer is empty at exit 0, never a fabricated "no such function" (rust corpus-audit #5,
      // byte-matching its two arms: `{}` on the machine channel, the re-scan pointer on the human one).
      if (!completeGraph) {
        put(args, {}, () => console.log(`candor: no caller of \`${q}\` in the effect-relevant graph (the full call-graph sidecar is absent; re-scan with --out to see pure-only callers).`));
        break;
      }
      console.error(`candor-ts-query callers: no function matching '${q}' in the call graph`); process.exit(2);
    }
    put(args, cres, P.callers);
    break;
  }
  case "map": {
    // Shared query-core — the CLI and MCP `candor_map` are one implementation (see `where` above).
    const { prefix } = resolveReportVerb(args, 0);
    // ⟨0.28⟩ `map` answers `{}`, which SPEC §2 calls the STRONGEST determined negative there is: every key
    // a consumer reads defaults to empty, so `d["db"] ?? {}` cannot tell an empty map from an unexamined
    // one. RUNG A: its top level is a USER NAMESPACE, so the caveat REPLACES the module map rather than
    // merging into it — the merged shape displaced a real module row to make space for the hedge.
    putCaveatInstead(args, coreMap(loadReportOrDie(prefix)), P.map, reportCompleteness(prefix),
      "the module rows below cover only the source candor read",
      "A module living wholly in an unread unit is MISSING from this overview, and one that IS listed may be missing functions. Re-scan for a complete map.");
    break;
  }
  case "containment": {
    // SPEC §6.1 boundary-effect dispersion; with a baseline it's the AS-EFF-010 ratchet (exit 1 on a new
    // leak), matching candor-java / candor-query. JSON-only, like every other candor-ts query command.
    // Canonical §3.3.1: `containment [<baseline>]` — the main report discovered / --report, the SINGLE
    // canonical positional is the OPTIONAL baseline (verb_args: 1). A lone bare positional is therefore
    // the BASELINE (the gating ratchet), NEVER re-read as the deprecated leading report — which silently
    // dropped to non-gating report-mode (exit 0), the §4 cardinal-sin gate-off this fixes. The deprecated
    // old form (`containment <report> <baseline>`) is ARITY-GATED: the leading-report peel fires only when
    // the positionals EXCEED 1, so `containment P` stays the ratchet and `containment leaky P` still peels
    // `leaky` as the report and leaves `P` the baseline (both old-grammar tests stay green). Matches Rust.
    const p = parseCanonical(args, { argc: 1 });
    let prefix = p.reportPrefix, basePrefix;
    if (!p.reportExplicit && p.positionals.length > 1 && hasReport(locatorToPrefix(p.positionals[0]))) {
      deprecate("a leading-positional report is deprecated — pass it as `--report <locator>`; the baseline stays positional (`containment [<baseline>]`)");
      prefix = locatorToPrefix(p.positionals[0]);
      basePrefix = p.positionals[1] ? locatorToPrefix(p.positionals[1]) : undefined;
    } else {
      basePrefix = p.positionals[0] ? locatorToPrefix(p.positionals[0]) : undefined;
    }
    prefix = requireReport(prefix);
    if (basePrefix) {
      const baseFns = loadReportOrDie(basePrefix);
      if (baseFns.length === 0) {   // fail CLOSED (exit 2), not a wall of bogus "everything leaked" (exit 1)
        console.error(`candor-ts: no report at baseline prefix '${basePrefix}' — check the path`);
        process.exit(2);
      }
      const r = coreContainment(loadReportOrDie(prefix), baseFns);
      // ⟨0.28⟩ BOTH SIDES' MANIFESTS. This answer is a DIFFERENCE, so it is unsound if either side is
      // partial, and in OPPOSITE directions: a leak living in an unread file of the CURRENT tree is missed
      // (a false all-clear at exit 0), while one living in an unread file of the BASELINE reads as newly
      // appeared (a fabricated leak, at exit 1). A wholly-empty baseline already fails closed above; a
      // baseline that loaded but declares `unanalyzed` is the case that reached here silently.
      putAnswer(args, r, P.containment,
        absorbCompleteness(reportCompleteness(prefix), reportCompleteness(basePrefix)),
        "the leak set below is a difference over only the code candor read on BOTH sides",
        "An unread unit of the current tree hides a leak; an unread unit of the baseline manufactures one. Re-scan both before moving the ratchet.");
      process.exit(r.leaks.length ? 1 : 0);
    }
    putAnswer(args, coreContainment(loadReportOrDie(prefix)), P.containment, reportCompleteness(prefix),
      "the containment scores below cover only the boundary effects candor could see",
      "A boundary effect in an unread unit is in no layer's count, so a dispersed effect can score as contained. Re-scan for a complete picture.");
    break;
  }
  case "diff": {
    // per-function effect delta vs a baseline: {changes: [{fn, gained, lost}]} — the envelope shape
    // the conformance suite pins (diff-vs-self must be {changes: []}). Shared query-core: the CLI's
    // former inline copy built `new Map(fns.map((e) => [e.fn, …]))` — the exact last-wins collapse
    // core's effectsByFn was rewritten to avoid (merged multi-report siblings sharing a short fn name
    // dropped one member's effects, so a gained Net could VANISH from diff and its exit-1 contract —
    // a supply-chain miss, and the CLI disagreeing with MCP `candor_diff` on the same reports).
    // §3.3.1: diff/gains are the exception to discovery — two positional locators <current> <baseline>,
    // each resolved by the shared locator rule (dir / .json path / prefix). --json is accepted (JSON is
    // the only output). No leading-positional-report alias here: both positionals ARE the reports.
    const { positionals } = parseCanonical(args, {});
    if (positionals.length < 2) { console.error("usage: candor-ts-query diff <current> <baseline> [--json]"); process.exit(2); }
    const [curPrefix, basePrefix] = positionals.map(locatorToPrefix);
    // BOTH locators must name real report files (the Rust engine's no-files check, named per side so
    // the user knows which path to fix): a typo'd prefix loaded [] with hardFail=false and emitted an
    // authoritative EMPTY {changes:[]} at exit 0 — the §4 false all-clear on the ratchet verb.
    if (!hasReport(curPrefix)) { console.error(`candor-ts: no report files at current prefix '${curPrefix}' — check the path.`); process.exit(2); }
    if (!hasReport(basePrefix)) { console.error(`candor-ts: no report files at baseline prefix '${basePrefix}' — check the path.`); process.exit(2); }
    const { changes } = coreDiff(loadReportOrDie(curPrefix), loadReportOrDie(basePrefix));
    // §2.1: a baseline is comparable only to its own producing build — disclose a mismatch (the gains
    // may be the engine reclassifying after a coverage batch, not the code changing). Same note + JSON
    // provenance fields as the Rust candor-query (cross-engine parity, item 10).
    const engineV = reportVersion(curPrefix), baseV = reportVersion(basePrefix);
    const versionMismatch = engineV && baseV && engineV !== baseV;
    if (versionMismatch)
      console.error(`candor-ts: ⚠ baseline @${baseV} ≠ engine @${engineV} — some changes may be the engine reclassifying, not your code. Treat an engine swap as baseline-invalidating: review, then regenerate the baseline.`);
    put(args, { baseline_version: baseV ?? "", engine_version: engineV ?? "", changes }, P.diff);
    // diff DISCLOSES (the posture) — it is not a gate. Its gained-effect exit 1 is a convenience for
    // same-build ratchet use; under a version mismatch that signal is BOGUS (unmasking, not regression),
    // so exit 0 and let the ⚠ inform — never deliver the wave as a CI failure (review §2.1: guards fail
    // closed, queries disclose).
    process.exit(!versionMismatch && changes.some((c) => c.gained.length) ? 1 : 0);
    break; // unreachable (process.exit), but eslint can't prove it — defends against fallthrough
  }
  case "reachable": {
    // what the app DOES at runtime: effects unioned over the entry points (SPEC §3.1; same JSON
    // shape as the Rust engine: {entryPoints, effects: {Eff: {count, via}}}).
    const { prefix } = resolveReportVerb(args, 0);
    const fns = loadReportOrDie(prefix);
    const roots = fns.filter((e) => e.entryPoint);
    const byEff = {};
    for (const e of roots) for (const x of e.inferred) (byEff[x] ??= []).push(e.fn);
    // ⟨0.28⟩ `{"entryPoints":0,"effects":{}}` asserts *the program performs no effect at runtime* — the
    // strongest claim in this binary — and over a report that judged nothing it rests on no evidence.
    putAnswer(args, { entryPoints: roots.length,
           effects: Object.fromEntries(Object.entries(byEff).sort()
             .map(([k, v]) => [k, { count: v.length, via: v.sort() }])) }, P.reachable, reportCompleteness(prefix),
      "the runtime effect set below is a union over only the entry points candor could see",
      "An entry point in an unread unit contributes NOTHING to this union, and neither does any effect it reaches. Re-scan before treating this as the program's runtime surface.");
    break;
  }
  case "impact": {
    // blast radius (backward dual of reachable) — reuses the shared query-core, the same logic the
    // MCP server serves. SPEC §3.1: {fn, affectedCount, affected, entryPoints:[{fn,inferred}]}.
    const { prefix, args: [q] } = resolveReportVerb(args, 1);
    // A missing/empty <query> is a LOUD usage error (exit 2, like candor-java) — never an
    // affectedCount:0 blast radius at exit 0 for a function that was never named.
    if (!q) { console.error("usage: candor-ts-query impact <query> [--report <locator>] [--json]"); process.exit(2); }
    const impFns = loadReportOrDie(prefix);
    // ⟨0.28⟩ Sidecar first, then the report's embedded `calls` edges — rust's `impact` runs on the
    // report's edges ALONE (callers.rs cmd_impact), so a sidecar-less report must answer here too; see
    // the callers verb. The unanswerable arm below keeps the genuinely-absent case (the armed pair).
    let impCg = loadCallgraph(prefix);
    if (Object.keys(impCg).length === 0) impCg = reportCallsGraph(impFns);
    // ⟨0.28⟩ UNANSWERABLE MUST REACH THE MACHINE CHANNEL (SPEC §3.3.1), the `callers` fix (5091905) on
    // the verb its own commit message named as still open. Over an armed pair — report armed to the
    // ⟨0.21⟩ Row-1 empty, §2.2 sidecars deleted, the STANDARD post-failure state since the ⟨0.28⟩
    // sidecar rung — this printed `{"fn":…,"affectedCount":0,"affected":[],"entryPoints":[]}` at exit 0.
    // `affectedCount: 0` is the blast-radius verb's strongest claim: NOTHING CALLS THIS, SAFE TO CHANGE.
    // With no call graph the engine has not judged that; it has judged nothing. rust/java exit 2 here.
    //
    // BOTH CHANNELS FAIL CLOSED (the exit alone leaves a JSON consumer holding a document; the key alone
    // lets `d.affectedCount ?? 0` read as a determined negative), and the empty ANSWER keys are OMITTED
    // rather than zeroed, so there is nothing left for a defaulting reader to mistake for a finding.
    //
    // THE GATE IS THE EMPTY GRAPH, NOT THE EMPTY ANSWER, and that separation is the load-bearing half.
    // `impact` resolves its target over the CALLGRAPH keys, so an absent graph makes every answer a
    // vacuous 0 — that is the unanswerable case. A function that genuinely affects nothing over a REAL
    // graph still answers `affectedCount: 0` at exit 0 below: a determined negative, and withdrawing it
    // would be the mirror defect (the ⟨0.24⟩ count-0 lesson, where the plausible fix withdrew 104 real
    // claims to catch 6). The MCP `candor_impact` was measured, not assumed, and already fails closed —
    // its fn-existence guard unions the callgraph keys with the report's, both empty here.
    if (Object.keys(impCg).length === 0) {
      const why = "no call graph in the report — the §2.2 sidecar is absent, so what this function affects is UNANSWERABLE, not empty (SPEC §3.3.1 ⟨0.28⟩)";
      put(args, { fn: q, unanswerable: why }, () => console.log(`candor: ${why}`));
      process.exit(2);
    }
    // BAD TARGET → LOUD exit 2 (corpus-audit #3), the rule `callers` applies one verb up and the rule
    // rust/java ALREADY apply here — measured four-way, array-quoted, on a valid report: rust and java
    // both exit 2 with `impact: no function matching '…'`, and candor-ts was the ONE arm that printed
    // `{"fn":"zzz_no_such_fn","affectedCount":0,"affected":[],"entryPoints":[]}` at exit 0. On the
    // BLAST-RADIUS verb, `affectedCount: 0` is the strongest claim in the vocabulary — "nothing calls
    // this, safe to change" — and here it was asserted about a function that does not exist. A typo in a
    // CI script or an agent's query reads back as reassurance (§4); the truth is the question was never
    // posed. This is the same shape conformance §17 (1b) already pins for `where`/`callers`, on the two
    // verbs whose comment there wrongly assumed "path/impact already gate".
    //
    // A DIFFERENT CONDITION FROM THE UNANSWERABLE GATE ABOVE, and keeping them distinguishable is the
    // load-bearing half. That one is "there is no call graph" — nothing was judged, so the machine
    // channel carries an `unanswerable` key. This one is "the graph is fine and the NAME does not
    // resolve" — a USAGE error, reported the way `where`/`callers`/`show` report one: stderr, and NO
    // `unanswerable` key, because the run judged plenty. Hence the ORDER: unanswerable first, so an
    // absent sidecar is never misreported as a bad name (a wrong cause reads as an answer, 5091905).
    //
    // NOT THE OTHER DIRECTION: a REAL fn that genuinely affects nothing still answers `affectedCount: 0`
    // at exit 0 below. "No such function" and "that function affects nothing" must not collapse into one
    // another — withdrawing the determined negative to catch the fabricated one is the ⟨0.24⟩ count-0
    // mirror defect, where the plausible fix withdrew 104 real claims to catch 6.
    if (coreMatches(knownFnNames(impCg, impFns), q).length === 0) {
      console.error(`candor-ts-query impact: no function matching '${q}'`); process.exit(2);
    }
    put(args, coreImpact(impFns, impCg, q), P.impact);
    break;
  }
  case "blindspots": {
    // the Unknown SOURCES, ranked by blast radius — the actionable inverse of a widely-propagated
    // Unknown (SPEC §3.1 ⟨0.6⟩): { sources:[{fn,why,reaches,affected}], totalUnknown }.
    const { prefix } = resolveReportVerb(args, 0);
    const ci = args.indexOf("--class");
    const classFilter = ci >= 0 ? args[ci + 1] : null;   // ⟨0.20⟩ drill-down by reason class
    // ⟨0.28⟩ THE SHARPEST OF THE SIX: `{"sources":[],"totalUnknown":0}` reports *no blind spots* out of a
    // report whose own manifest names a file candor could not read — the unread file is the blind spot, and
    // it contributes no entry, so nothing in the computation below can see it. BOTH forms, because
    // `--stats` is the same claim counted differently (the sibling-route habit: a rule applied where the
    // work is and never to the arm one line down).
    const bsComp = reportCompleteness(prefix);
    const bsSoWhat = "the Unknown sources below are only those rooted in a call candor could see";
    const bsTail = "An unread unit contributes no entry at all, so its own Unknowns are not counted here and cannot be. Re-scan before treating this as the blind-spot inventory.";
    if (args.includes("--stats")) {   // ⟨0.20⟩ the reason-class distribution, not the source list
      putAnswer(args, coreBlindspotsStats(loadReportOrDie(prefix), classFilter), P.blindspotsStats, bsComp, bsSoWhat, bsTail);
    } else {
      putAnswer(args, coreBlindspots(loadReportOrDie(prefix), loadCallgraph(prefix), classFilter), P.blindspots, bsComp, bsSoWhat, bsTail);
    }
    break;
  }
  case "tour": {
    // The ON-DEMAND, top-N cold-repo opener (SURFACE-BEST-FIND-DESIGN.md, P2): the N most SURPRISING
    // transitive reaches in an existing report — NO re-scan. Delegates to the SHARED surface.mjs
    // bestFinds (the same heuristic the scan-time note uses, so the ranking can't drift), reading the
    // report + callgraph sidecar the scan already wrote. Port of candor-rust's candor-query tour verb —
    // human + --json output byte-identical (a conformance PART pins it four-way).
    // §3.3.1: `tour [<N>]`, report discovered / --report; the lone OPTIONAL positional is N (default 10).
    // Unlike the JSON-only verbs, tour has BOTH a human default AND a --json form (like the Rust engine),
    // so detect --json explicitly (parseCanonical otherwise silently swallows it).
    const wantJson = args.includes("--json");
    const { prefix, args: tourArgs } = resolveReportVerb(args, 1);
    let n = 10;
    if (tourArgs.length) {
      // N MUST be a positive integer ≥ 1 that fits a safe integer — like the Rust engine, which rejects
      // `tour 0` and a non-usize. `tour 0` printing "nothing hidden" over an effectful crate would be a
      // false all-clear (the §4 cardinal sin), so a non-integer, zero, or out-of-range value → exit 2.
      const parsed = /^\d+$/.test(tourArgs[0]) ? Number(tourArgs[0]) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        console.error("usage: candor-ts-query tour [<N>] [--report <locator>] [--json]   (N is a positive integer ≥ 1)");
        process.exit(2);
      }
      n = parsed;
    }
    const fns = loadReportOrDie(prefix);
    const cg = loadCallgraph(prefix);
    // Build the maps the heuristic wants from the report entries + the callgraph sidecar. `inferred`/
    // `direct` come from the report; `loc` maps a function to its "file:line" for the source callout.
    const inferred = new Map(), direct = new Map(), loc = new Map(), calls = new Map();
    for (const e of fns) {
      inferred.set(e.fn, new Set(e.inferred));
      if (e.direct.length) direct.set(e.fn, new Set(e.direct));
      if (e.loc) loc.set(e.fn, e.loc);
    }
    // `calls` prefers the FULL callgraph sidecar (every edge — the graph the scan held in memory). When
    // the sidecar is absent/empty, FALL BACK to each entry's inline `.calls` (mirrors tour.rs:66-77:
    // `if cg.is_empty() { use entry.calls } else { use cg }`). Without this fallback a report whose
    // sidecar was deleted/never-written yields an empty graph, nearestSource finds nothing, and tour
    // prints a FALSE "nothing hidden" at exit 0 — a silent under-report (the §4 cardinal sin). A corrupt
    // sidecar is already disclosed on stderr by loadCallgraph, which then returns {} → we fall back here.
    if (Object.keys(cg).length === 0) {
      for (const e of fns) if (e.calls.length) calls.set(e.fn, e.calls);
    } else {
      for (const [k, v] of Object.entries(cg)) calls.set(k, v);
    }
    // Exclude test scaffolding — a qual is test code iff its recorded loc lies on a test path, the SAME
    // isTestPath predicate the scan-note passes (scan.mjs's isTestQual). Without it `tour` surfaces test
    // functions the scan-note (and every other engine) hides — an inconsistent, noisier reach list.
    const isTestQual = (q) => { const l = loc.get(q); return l ? isTestPath(l) : false; };
    const finds = bestFinds(inferred, direct, calls, loc, n, isTestQual);
    // The header names the report's §2 envelope `package` — meaningful and locator-independent, so every
    // engine and every --report form print the SAME crate. Falls back to the prefix basename.
    const crateName = reportPackage(prefix) ?? path.basename(prefix);
    // ⟨0.28⟩ read ONCE, before either channel branches, so the JSON half and the prose half cannot end up
    // triggered by two different readings of the same bytes (see `putAnswer`; tour renders its own output).
    const tourComp = reportCompleteness(prefix);
    if (wantJson) {
      // Pure JSON to STDOUT: {"reaches":[{effect,fn,hops,loc,score,source}, …]} — ALPHABETICAL keys, the
      // same order Rust+Swift emit (loc is the SOURCE's file:line, "" when absent).
      const out = { reaches: finds.map((f) => ({
        effect: f.effect, fn: f.func, hops: f.hops, loc: f.sourceLoc, score: f.score, source: f.source,
      })) };
      // The MACHINE half of the mostly-Unknown disclosure (Fable-review finding E): a JSON consumer (the
      // agent loop) got a bare `{"reaches":[]}` and read it as clean — the same false all-clear the text
      // branch qualifies. ADDITIVE + present only when the ≥⅓-Unknown threshold trips (byte-identical
      // otherwise). Keys sorted after `reaches` (reaches < unknown) to match Rust's serde output.
      const teff = fns.filter((e) => (e.inferred ?? []).length > 0).length;
      const tunk = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
      if (teff > 0 && tunk * 3 >= teff) out.unknown = { count: tunk, total: teff };
      // ⟨0.28⟩ THE SAME ARGUMENT AS `unknown` ABOVE, ONE CAUSE OVER — and the ⅓ threshold cannot reach this
      // one. That field exists because a bare `{"reaches":[]}` read as clean to the agent loop over a
      // mostly-Unknown graph; a report that judged nothing, or that names a file it could not read, yields
      // the IDENTICAL empty array from strictly less evidence, and an unread unit contributes no entry, so
      // it moves neither `unknown` nor `total`. Spread last, `{}` on a complete report.
      console.log(JSON.stringify({ ...out, ...completenessFields(tourComp) }));
      break;
    }
    incompleteAnswerNote(tourComp,
      "the reaches below are ranked over only the call graph candor could see",
      "A surprising reach whose path runs through an unread unit is not ranked here at all, and cannot be. Re-scan for the full tour.");
    if (finds.length === 0) {
      // Effectful-but-nothing-surprising vs genuinely-pure both land here; the honest line is the useful
      // answer (never a manufactured surprise) — mirrors the scan-note fallback + the Rust engine. BUT never
      // reassure "nothing hidden" over a meaningfully-Unknown graph (unresolved calls — missing tsconfig /
      // imports): those Unknowns ARE the hidden part, their transitive effects unanalyzed (re-audit cardinal
      // sin). Same ≥⅓-effectful-Unknown gate as the scan opener (surface.mjs emitSurface).
      const teff = fns.filter((e) => (e.inferred ?? []).length > 0).length;
      const tunk = fns.filter((e) => (e.inferred ?? []).includes("Unknown")).length;
      if (teff > 0 && tunk * 3 >= teff) {
        console.log(
          `candor: no surprising reaches — but ${tunk} of ${teff} function(s) are Unknown `
          + `(unresolved calls; their transitive effects are NOT analyzed). Run \`candor blindspots\` — `
          + `the report records a reason for each.`,
        );
      } else if (mustHedge(tourComp)) {
        // "nothing hidden" is the single most reassuring sentence this binary prints, and over these bytes
        // it is the false all-clear in plain English. The ⅓-Unknown branch above cannot catch it, for the
        // reason given on the JSON arm.
        console.log(`candor: nothing hidden in what candor COULD SEE ${NOT_A("nothing is hidden")}.`);
      } else {
        console.log("candor: nothing hidden — every effect sits where its name says it should.");
      }
      break;
    }
    console.log(`candor tour — the ${finds.length} most surprising reach${finds.length === 1 ? "" : "es"} in ${crateName}:`);
    finds.forEach((f, i) => {
      const hopWord = f.hops === 1 ? "hop" : "hops";
      const whereS = f.sourceLoc ? ` (${f.sourceLoc})` : "";
      console.log(`  ${i + 1}. \`${f.func}\` performs ${f.effect}, ${f.hops} ${hopWord} away via \`${f.source}\`${whereS}`);
      console.log(`     →  candor path ${f.func} ${f.effect}`);
    });
    break;
  }
  case "gains": {
    // the supply-chain alarm (SPEC §5.1): {gained:[Effect], byFunction:[{fn,effect}]} — what the
    // surface gained between two reports (base → cur), the cross-engine machine-readable form.
    // §3.3.1: like diff, two positional locators <current> <baseline> (no discovery), each resolved by
    // the shared locator rule; --json accepted.
    // gains has no `--policy` of its own: parseCanonical consumes `--policy` for every verb (a valid flag),
    // which for gains would SILENTLY drop it and exit 0 — a CI author who reaches for `--policy` to gate a
    // supply-chain diff ships a gate that never fires. Reject it loud and point at the real gate. `--strict`
    // (below) fails on ANY gained effect; the effect-SPECIFIC gate is a `deny <E> gained` scan policy.
    if (args.includes("--policy")) { console.error("candor-ts-query gains: unknown flag '--policy' — gains is a diff view; to FAIL CI on a newly-gained effect gate at scan time with a `deny <E> gained` policy (AS-EFF-005), or use `--strict` to fail on ANY gain\n  known flags: --json, --strict"); process.exit(2); }
    const { positionals, strict } = parseCanonical(args, { strict: true });
    if (positionals.length < 2) { console.error("usage: candor-ts-query gains <current> <baseline> [--json] [--strict]"); process.exit(2); }
    const [curPrefix, basePrefix] = positionals.map(locatorToPrefix);
    // BOTH locators must name real report files (the Rust engine's no-files check, named per side):
    // a typo'd prefix loaded [] with hardFail=false and emitted an authoritative EMPTY
    // {gained:[],byFunction:[]} at exit 0 — a silent all-clear on the supply-chain ALARM verb.
    if (!hasReport(curPrefix)) { console.error(`candor-ts: no report files at current prefix '${curPrefix}' — check the path.`); process.exit(2); }
    if (!hasReport(basePrefix)) { console.error(`candor-ts: no report files at baseline prefix '${basePrefix}' — check the path.`); process.exit(2); }
    const gv = reportVersion(curPrefix), gbv = reportVersion(basePrefix);
    if (gv && gbv && gv !== gbv)
      console.error(`candor-ts: ⚠ baseline @${gbv} ≠ engine @${gv} — a "gained capability" may be the engine reclassifying, not the dependency changing. Regenerate both reports with one build to compare releases.`);
    // ⟨spec 0.12 staged⟩ the BASELINE callgraph feeds byFunction[].origin (existing/new/unknown) —
    // a MISSING sidecar loads {} and a corrupt (matched-but-unparseable) one is tagged `partial`
    // with its edges dropped-and-disclosed: either way "new" is unavailable and origin falls back
    // to "unknown" — the JSON itself discloses, never guessing "new" over a truncated graph.
    // ⟨0.15 staged⟩ coverage disclosure (COVERAGE-DESIGN.md §3): the CURRENT report's `coverage`
    // envelope rides along (a gained effect in an uncovered dep is invisible — "no gains" must not
    // read as total), plus `coverageDelta` when the baseline names different blind packages. Both
    // OMITTED when nothing applies, so a coverage-free comparison is byte-identical to ⟨0.14⟩.
    // Shared with the MCP `candor_gains` tool (gainsCoverage — the parity rule).
    // ⟨0.28⟩ SPEC §2 — …AND THE ⟨0.21⟩ MANIFEST TRAVELS ON THE SAME TERMS, WHICH IS THE STRONGER CAVEAT.
    // The line above carries `coverage` because "no gains over an uncovered dep reads clean with false
    // confidence"; measured, this same call dropped `unanalyzed` — *I could not read a file of your own
    // code* — and `analyzed.count: 0` — *I judged nothing at all*. BOTH SIDES, disclosed separately
    // (`gainsCompletenessFields`): an incomplete CURRENT means the gained set may be SHORT, an incomplete
    // BASELINE means the comparison floor is soft and the existing/new split unreliable. Not `put`,
    // because ONE trigger must reach BOTH channels — the JSON-only half is the mutant that survived a
    // whole suite in candor-rust. Verdict-preserving: the exit below is untouched.
    const gainsResult = coreGains(loadReportOrDie(curPrefix), loadReportOrDie(basePrefix), loadCallgraph(basePrefix));
    const gCur = reportCompleteness(curPrefix), gBase = reportCompleteness(basePrefix);
    const gDoc = { baseline_version: gbv ?? "", engine_version: gv ?? "",
           ...gainsResult, ...gainsCoverage(curPrefix, basePrefix), ...gainsCompletenessFields(gCur, gBase) };
    if (wantJsonOut(args)) emit(gDoc);
    else {
      incompleteAnswerNote(gCur, "the gained set below names only effects candor read in the CURRENT tree and may be SHORT",
        "An effect introduced in an unread unit of the current tree is not in the list below.");
      incompleteAnswerNote(gBase, "the BASELINE half of this comparison is itself partial and the floor it sets is soft",
        "An effect living in an unread unit of the baseline reads as NEWLY gained here — the existing/new origin split is unreliable until the baseline is re-scanned.");
      P.gains(gDoc, mustHedge(gCur) || mustHedge(gBase));
    }
    // Advisory by default (exit 0 — gains is a diff view); `--strict` fails on ANY gained effect so a
    // supply-chain CI job can require a bump introduce no new capability (mirrors `unverified --strict`).
    process.exit(strict && (gainsResult.gained?.length ?? 0) > 0 ? 1 : 0);
    break; // unreachable
  }
  case "path": {
    // BOTH a human default AND a --json form (like the Rust/Java engines). The surface opener suggests
    // `candor path <fn> <effect>`, so the DEFAULT is the readable indented chain; --json selects the
    // pinned JSON shape. parseCanonical otherwise swallows --json, so detect it explicitly (as `tour` does).
    const wantJson = args.includes("--json");
    const { prefix, args: [fn, eff] } = resolveReportVerb(args, 2);
    // BOTH positionals are required (`path <fn> <Effect>`) — a missing/empty one is a LOUD usage error
    // (exit 2, like candor-java). Before this gate, one arg slid through as `<fn> undefined` and printed
    // "does not perform undefined" at exit 0 — a false all-clear over a question that was never posed.
    if (!fn || !eff) { console.error("usage: candor-ts-query path <fn> <Effect> [--report <locator>] [--json]"); process.exit(2); }
    const fns = loadReportOrDie(prefix);
    // ⟨0.28⟩ Sidecar first, then the report's embedded `calls` edges (rust's `path` runs on the report's
    // edges alone — see the callers verb). The unanswerable arm below keeps the genuinely-absent case.
    let cg = loadCallgraph(prefix);
    if (Object.keys(cg).length === 0) cg = reportCallsGraph(fns);
    // ⟨0.28⟩ UNANSWERABLE MUST REACH THE MACHINE CHANNEL (SPEC §3.3.1) — the `impact` argument above,
    // on the verb that answers the OTHER direction. Over an armed pair this emitted
    // `{"effect":…,"fn":…,"path":[]}` at exit 0: "there is no route by which this function reaches that
    // effect", which is precisely the reassurance a reader asks `path` for, over a run that traced
    // nothing. rust/java exit 2 here.
    //
    // BEFORE THE SPLIT, so BOTH arms fail closed, and the human arm is REPAIRED not merely forwarded —
    // it exited 2 already, but said "no function matching 'f'", a determined negative about the NAME
    // when the truth is about the GRAPH. (Its other two exits are worse: with a valid report and no
    // sidecar, `path` reached "does not perform Fs" / "not statically traceable" at exit 0.) Same
    // correction `callers` needed in 5091905, for the same reason: a wrong cause reads as an answer.
    //
    // THE GATE IS THE EMPTY GRAPH, NOT THE EMPTY PATH. `path` resolves its start over the CALLGRAPH
    // keys, so with no graph every answer is a vacuous `[]`. A function that genuinely does not reach
    // the effect over a REAL graph still answers `path: []` at exit 0 below — the graph SAID no, and
    // withdrawing that is the ⟨0.24⟩ count-0 mirror defect. "The graph says no" and "there is no graph"
    // must stay distinguishable. MCP `candor_path` was measured and already fails closed (`isError`).
    if (Object.keys(cg).length === 0) {
      const why = "no call graph in the report — the §2.2 sidecar is absent, so whether this function reaches that effect is UNANSWERABLE, not a determined `no` (SPEC §3.3.1 ⟨0.28⟩)";
      if (wantJson) emit({ effect: eff, fn, unanswerable: why });
      else console.log(`candor: ${why}`);
      process.exit(2);
    }
    // BAD TARGET → LOUD exit 2 (corpus-audit #3), the `impact` argument above on the verb that answers
    // the OTHER direction, and the ONE-ENGINE divergence was HALF a divergence here: the HUMAN arm
    // (renderPathHuman) has always exited 2 with "no function matching", while `--json` printed
    // `{"effect":"Net","fn":"zzz_no_such_fn","path":[]}` at exit 0 — "there is no route by which this
    // function reaches that effect", the precise reassurance a reader asks `path` for, about a function
    // that does not exist. The MACHINE arm being the lenient one is the worse half: the human at least
    // saw an error. rust/java/swift all exit 2 on both arms (measured).
    //
    // HOISTED ABOVE THE SPLIT so ONE gate covers both arms — the divergence existed because the check
    // lived inside the human renderer only, and a rule that lives on one route is a rule the sibling
    // route does not have. renderPathHuman keeps its own resolution (over the REPORT entries, where
    // `inferred` lives) as the stricter downstream case; this gate refuses only what neither set knows.
    //
    // DISTINCT FROM THE UNANSWERABLE GATE ABOVE and ordered after it: "there is no graph" carries the
    // `unanswerable` key in the machine channel, "the graph is fine and the name is not in it" is a
    // usage error on stderr. NOT the mirror: a real fn that genuinely does not reach the effect still
    // answers `path: []` at exit 0 below — the graph SAID no, and "the graph says no", "there is no
    // graph" and "there is no such function" are three answers, not one.
    if (coreMatches(knownFnNames(cg, fns), fn).length === 0) {
      console.error(`candor-ts-query path: no function matching '${fn}'`); process.exit(2);
    }
    if (wantJson) emit(corePath(fns, cg, fn, eff));           // conformance PART 5 shape — UNCHANGED
    else {
      // The accepted 0.11 default change (the human chain replaced JSON as the no-flag output) gets a
      // ONE-line stderr breadcrumb, so a pre-0.11 pipeline that broke on the new default is pointed at
      // --json rather than left guessing. stderr only — stdout stays the human chain; --json untouched.
      console.error("candor-ts-query: tip — `--json` selects the machine-readable path shape (the default before 0.11)");
      renderPathHuman(fns, cg, fn, eff);
    }
    break;
  }
  case "whatif": {
    // §3.3.1: `whatif <fn> <Effect> [--policy <file>]`, report discovered / --report. DEPRECATED aliases:
    // a leading-positional report and a trailing positional policy (`whatif <prefix> <fn> <Effect>
    // [policy]`). resolveWhatifFix peels both (stderr-noted) so the old grammar stays green.
    const { prefix, target, eff, policyFile } = resolveWhatifFix(args);
    // A present policy MUST exist and be readable — a typo'd path must be LOUD, not silently "no policy →
    // ok:true, exit 0" (mirrors scan's --policy, which exits 2 on an unreadable file: a gate that can't
    // read its policy can't certify anything). Flag, positional, CANDOR_POLICY and .candor/config all land here.
    let pol = null;
    if (policyFile) {
      let text;
      try {
        text = fs.readFileSync(policyFile, "utf8");
      } catch {
        console.error(`candor: policy ${policyFile} could not be read; whatif NOT evaluated against it`);
        process.exit(2);
      }
      pol = loadPolicyOrDie(policyFile, text);
    }
    // Shared query-core — the CLI and MCP `candor_whatif` are one blast-radius + deny evaluation
    // (the CLI keeps the I/O + exit codes; the core is pure — see `where` above for the drift class).
    const r = coreWhatif(loadCallgraph(prefix), target, eff, pol, scopeMatches);
    if (r === null) {
      console.error(`candor: no function matching \`${target}\` in the call graph`);
      process.exit(2);
    }
    // ⟨0.24⟩ SPEC §3.2 — over a report declaring `unanalyzed`, `ok` is OMITTED (advisoryAnswer). `affected`
    // is computed over a universe this cannot see all of: a caller in an unparsed file is invisible, so
    // `true` is a claim the input does not license, and `false` would invent a violation nothing found.
    // The arrays still ship — a partial answer that says it is partial beats a refusal, and `whatif` is
    // consulted BEFORE an edit, where the alternative is the operator guessing. The exit is UNCHANGED:
    // this verb has no `--strict`, §3.2 rules no exit for it, and inventing one is the failure mode the
    // clause it lives beside exists to prevent.
    const wcomp = reportCompleteness(prefix);
    const wunan = wcomp.unanalyzed;
    if (wunan.length)
      console.error(`candor-ts: whatif is NOT a complete answer — the report declares ${wunan.length} unit(s) candor could not analyze (disclosed under \`unanalyzed\`); \`ok\` is omitted because neither value is a statement the input licenses`);
    // ⟨0.28⟩ …and the count-0 cause, which reaches here through a LIVE §2.2 sidecar: the target resolves
    // over the call graph, so this verb answers `ok: true` where the report-only verbs exit 2 on the name.
    // MEASURED exactly so — the pre-edit gate check, green, over a report that judged nothing.
    if (wcomp.judgedNothing.length) advisoryJudgedNothingNote("whatif");
    if (wcomp.noManifest.length) advisoryNoManifestNote("whatif", wcomp.noManifest);
    if (wcomp.unreadable.length) advisoryUnreadableNote("whatif", wcomp.unreadable);
    // ⟨0.28⟩ SPEC §2 — a CONFIGURED policy that parsed to zero rules asked nothing, so the pre-edit
    // verdict AND the blast radius it qualifies are withheld in favour of the caveat document. The exit
    // is UNCHANGED (0: with no rules, `violations` was empty by construction on this path anyway).
    if (policyFile && policyAskedNothing(pol)) { emitZeroRuleCaveat("whatif", policyFile, wcomp); process.exit(0); }
    emit(advisoryAnswer(r, wunan, wcomp.judgedNothing, wcomp.unreadable, wcomp.noManifest));
    process.exit(r.violations.length ? 1 : 0);
    break; // unreachable (process.exit), but eslint can't prove it — defends against fallthrough
  }
  case "fix": {
    // THE BOUNDARY FIX (integrations/FIX-SPEC.md): where a forbidden effect belongs + the hoist refactor.
    // The remedial inverse of whatif. A policy is REQUIRED and must be readable (the fix is defined relative
    // to the boundary the edit crossed) — a typo'd path fails LOUD, never a silently-empty "no crossing".
    // §3.3.1: `fix <fn> <Effect> [--policy <file>]`, report discovered / --report; the old
    // `fix <prefix> <fn> <Effect> <policy-file>` form (leading report + positional policy) stays accepted.
    const { prefix, target, eff, policyFile } = resolveWhatifFix(args);
    if (!target || !eff) { console.error("usage: candor-ts-query fix <fn> <Effect> [--policy <file>] [--report <locator>]"); process.exit(2); }
    if (!policyFile) { console.error("candor: fix requires a policy file — the fix is the refactor that restores the boundary the edit crossed (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    // The sidecar is the ONLY graph a candor-ts report carries (it embeds no inline `calls`). Fail LOUD when
    // it's absent — never compute a degenerate empty-graph remedy that reads as a false "no clean hoist".
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    const fpol = loadPolicyOrDie(policyFile, ptext);
    const r = coreFix(cg, loadReportOrDie(prefix), target, eff, fpol, scopeMatches);
    if (r === null) { console.error(`candor: no function matching \`${target}\` in the call graph`); process.exit(2); }
    // ⟨0.28⟩ SPEC §2 — this verb shares the policy loader with the three the clause names, and its every
    // answer is equally policy-relative: over a zero-rule policy it emitted `{"crossing": false,
    // "reason": "not-forbidden"}` at exit 0, and *not-forbidden* by a policy that forbids nothing is
    // vacuously true. Composed with the ⟨0.28⟩ `crossing` ruling, this emits NO `crossing` KEY — that key
    // is present exactly when the verb answered, and here it did not. Exit UNCHANGED (0; the
    // missing-function usage error above keeps its 2). Placed AFTER that error so a bad `fn` still
    // reports the bad `fn`.
    if (policyAskedNothing(fpol)) { emitZeroRuleCaveat("fix", policyFile, reportCompleteness(prefix)); process.exit(0); }
    // ⟨0.24⟩ SPEC §3.2 `4fd140c` — the printed channel for a REFUSED remedy (`refused: true`, no `crossing`
    // key). Without it the terminal shows a document with no plan in it and no reason for the absence.
    if (r.unevaluated?.length) advisoryUnevaluatedNote("fix", r.unevaluated,
      "(no remedy is offered for a boundary the gate could not adjudicate — the result carries `refused: true` and NO `crossing` key; re-scan so the report carries the evidence, or widen the rule)");
    emit(r);
    break;
  }
  case "fix-gate": {
    // A remedy for EVERY deny/pure crossing — the shape the edit-time loop folds into its block message.
    // §3.3.1: `fix-gate [--policy <file>]`, report discovered / --report. DEPRECATED alias: the old
    // `fix-gate <prefix> <policy-file>` (leading report + positional policy).
    // Advisory by default (exit 0 — the agent fix-loop reads the remedy and edits); `--strict` makes the
    // exit follow `ok`, so CI can REQUIRE zero outstanding crossings (mirrors `unverified --strict`).
    const { prefix, policyFile, strict } = resolveGateVerb(args, { strict: true });
    if (!policyFile) { console.error("candor: fix-gate requires a policy file (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read — no fix computed`); process.exit(2); }
    const cg = loadCallgraph(prefix);
    if (!cg || Object.keys(cg).length === 0) { console.error(`candor: no call-graph sidecar for '${prefix}' — fix-gate needs it (re-run: candor-ts <src> --out ${prefix})`); process.exit(2); }
    const fgpol = loadPolicyOrDie(policyFile, ptext);
    const fgr = coreFixGate(cg, loadReportOrDie(prefix), fgpol, scopeMatches);
    // ⟨0.24⟩ SPEC §3.2 — see `advisoryAnswer`. Over a report declaring `unanalyzed` this OMITS `ok`, adds
    // the manifest, and `--strict` (the CI form) exits 2 — could-not-fully-evaluate, the same code the gate
    // uses for the same situation — rather than the 1 that would claim a finding or the 0 that certified.
    const fgComp = reportCompleteness(prefix);
    const fgUnan = fgComp.unanalyzed;
    if (fgUnan.length) advisoryIncompleteNote("fix-gate", fgUnan);
    // ⟨0.28⟩ …and the count-0 cause, which reaches the DOCUMENT and the PROSE but deliberately NOT the exit
    // below (see `advisoryAnswer`). Leaving it out would have let this verb print a remedy list beside
    // `ok: true` over a report that judged nothing — the same false all-clear, arriving by omission.
    if (fgComp.judgedNothing.length) advisoryJudgedNothingNote("fix-gate");
    if (fgComp.noManifest.length) advisoryNoManifestNote("fix-gate", fgComp.noManifest);
    if (fgComp.unreadable.length) advisoryUnreadableNote("fix-gate", fgComp.unreadable);
    // ⟨0.24⟩ SPEC §3.2 `4fd140c` — and the same posture for a rule the GATE refused: no remedy is computed
    // from evidence the gate declined to read, the refusal is disclosed on both channels, and `--strict`
    // exits 2 (could-not-evaluate) rather than the 0 that would read as "no crossings left to fix".
    if (fgr.unevaluated?.length) advisoryUnevaluatedNote("fix-gate", fgr.unevaluated, UNEVAL_TAIL_STRICT);
    // ⟨0.28⟩ SPEC §2 — an empty `remedies` beside `ok: true` here is a claim relative to a gate that never
    // asked a question. The caveat document replaces the result; the EXIT is the SAME expression the
    // result path computes, over the finding sets a zero-rule policy produces by construction (no
    // remedies, no unanswerable rule) — so it moves only with the REPORT's own incompleteness, exactly as
    // it does today.
    if (policyAskedNothing(fgpol)) {
      emitZeroRuleCaveat("fix-gate", policyFile, fgComp);
      process.exit(fgUnan.length || fgComp.unreadable.length ? (strict ? 2 : 0) : 0);
    }
    emit(advisoryAnswer(fgr, fgUnan, fgComp.judgedNothing, fgComp.unreadable, fgComp.noManifest));
    // ⟨0.28⟩ `unreadable` joins the `--strict` exit-2 trigger (SPEC §3.2's pessimism relation): `gate
    // --report` REFUSES over a corrupt member — measured, exit 2 — so exiting 0/1 here claimed this verb
    // got FURTHER than the gate on identical bytes. The unreadable note above already SAID the exit was
    // bounded by the gate's while this line did not read the field — a documented limitation, unmeasured.
    process.exit(fgUnan.length || fgComp.unreadable.length || fgr.unevaluated?.length ? (strict ? 2 : 0) : (strict && !fgr.ok ? 1 : 0));
    break; // unreachable
  }
  case "unverified": {
    // PROVABLE-PURITY disclosure: pure/deny layers that PASS but contain Unknown (not provably clean). A
    // policy is required; `--strict` exits 1 on a hole. Advisory (exit 0) otherwise.
    // §3.3.1: `unverified [--policy <file>] [--strict]`, report discovered / --report. DEPRECATED alias:
    // the old `unverified <prefix> <policy-file> [--strict]` (leading report + positional policy).
    const { prefix, policyFile, strict } = resolveGateVerb(args, { strict: true });
    if (!policyFile) { console.error("candor: unverified requires a policy file (pass --policy <file>, or set CANDOR_POLICY / a .candor/config `policy` key)"); process.exit(2); }
    let ptext;
    try { ptext = fs.readFileSync(policyFile, "utf8"); }
    catch { console.error(`candor: policy ${policyFile} could not be read`); process.exit(2); }
    const uci = args.indexOf("--class");   // ⟨0.20⟩ drill-down by reason class
    // ⟨0.24⟩ the callgraph rides along: `--class` resolves the reason class TRANSITIVELY, over the same
    // reach the gate uses (SPEC §6.2). The sidecar is no longer the ONLY reach — resolveReasonClasses
    // unions it with the entries' own §2 `calls` field (what rust/java/swift resolve over), so the answer
    // is byte-identical with and without it. What remains reportable is a report that carries NEITHER:
    // then the resolution really is direct-only, every inherited hole reads `unresolved`, and the reader
    // deserves to know that rather than be told a class the engine could not walk to. Disclosed on the
    // same channel a CORRUPT sidecar already discloses on (loadCallgraph) — an ABSENT one used to say
    // nothing at all, which is exactly what made the degradation invisible for a whole release.
    const ufns = loadReportOrDie(prefix);
    const ucg = uci >= 0 ? loadCallgraph(prefix) : {};
    if (uci >= 0 && Object.keys(ucg).length === 0 && !ucg.partial && !ufns.some((e) => (e.calls ?? []).length))
      console.error(`candor-ts: no call-graph sidecar for '${prefix}' and no \`calls\` edges in the report — \`--class\` resolved each hole's reason class from its OWN \`unknownWhy\` only; a hole whose Unknown is INHERITED reads \`unresolved\` here (re-run: candor-ts <src> --out ${prefix})`);
    const upol = loadPolicyOrDie(policyFile, ptext);
    const r = coreUnverified(ufns, upol, scopeMatches,
                             uci >= 0 ? args[uci + 1] : null, ucg);
    // ⟨0.24⟩ SPEC §3.2 — see `advisoryAnswer`, and this is the SHARPEST case in the family: the verb whose
    // entire job is "your green gate is not provably green" was certifying a set it knows it cannot see all
    // of. A function in an unparsed file is absent from `functions`, so it cannot be enumerated as an
    // unverified pass — and that absence is exactly what this verb would have to report.
    const uComp = reportCompleteness(prefix);
    const uUnan = uComp.unanalyzed;
    if (uUnan.length) advisoryIncompleteNote("unverified", uUnan);
    // ⟨0.28⟩ …and the count-0 cause. MEASURED before this line: `{ok: true, unverified: []}` over a report
    // that judged nothing — this verb certifying a package it never examined. The exit is untouched.
    if (uComp.judgedNothing.length) advisoryJudgedNothingNote("unverified");
    if (uComp.noManifest.length) advisoryNoManifestNote("unverified", uComp.noManifest);
    if (uComp.unreadable.length) advisoryUnreadableNote("unverified", uComp.unreadable);
    // ⟨0.24⟩ SPEC §3.2 `4fd140c` — the function the gate could not judge is NAMED in `unverified` above,
    // with the missing evidence as its reason; this is the human channel for the same fact.
    if (r.unevaluated?.length) advisoryUnevaluatedNote("unverified", r.unevaluated, UNEVAL_TAIL_STRICT);
    // ⟨0.28⟩ SPEC §2 — the sharpest of the four: the verb whose whole job is "your green gate is not
    // provably green" answered `{"ok": true, "unverified": []}` over a policy that asked nothing. The
    // empty list is withheld for ⟨0.27⟩'s reason (a refusal document must not carry `violations`), and the
    // exit follows the same expression the result path computes over empty finding sets.
    if (policyAskedNothing(upol)) {
      emitZeroRuleCaveat("unverified", policyFile, uComp);
      process.exit(uUnan.length || uComp.unreadable.length ? (strict ? 2 : 0) : 0);
    }
    emit(advisoryAnswer(r, uUnan, uComp.judgedNothing, uComp.unreadable, uComp.noManifest));
    // ⟨0.28⟩ `unreadable` joins the `--strict` exit-2 trigger — see fix-gate above. Measured on this verb
    // before the fix: over one good report plus one unparsable sibling, `gate --report` exited 2 and
    // `unverified --strict` exited 0 — and `--strict` is how CI consumes it.
    process.exit(uUnan.length || uComp.unreadable.length || r.unevaluated?.length ? (strict ? 2 : 0) : (strict && !r.ok ? 1 : 0));
    break; // unreachable
  }
  case "gate": {
    // ⟨0.24⟩ SPEC §3.1 — apply a policy to an EXISTING report, with NO scan. Exit codes and verdict shape
    // are exactly `scan --policy`'s (0 / 1 / 2); the only difference is where `S` and `D` come from.
    //
    // WHY IT IS A MUST AND NOT A CONVENIENCE. `scan --policy` recomputes `S` from source, so the classifier
    // is always in the loop; `whatif` reports only what a hypothetical INTRODUCES (a report already
    // carrying `Net` under `deny Net` answers ok:true, by design). So the gate was never reachable as a
    // function of a GIVEN signature, and a defect in the gate was indistinguishable from a defect in the
    // classifier by any test that could be written — which is precisely how the ⟨0.24⟩ §6.2 divergence
    // hid, a contract-versus-model defect every engine implemented faithfully. It is also the supply-chain
    // verb: gating a dependency's PUBLISHED report is the operation an adopter wants and could not express
    // without re-analysing code they do not have.
    //
    // IT READS THE REPORT FILE(S) AND NOTHING ELSE — see loadGateReport, which is where the §3.1 MUST NOT
    // is enforced and argued. No `.callgraph.json`, no chained dep, no `.hierarchy.json`, no
    // re-classification. An ABSENT entry is absent: the ⟨0.21⟩ purity claim, taken as given.
    const { prefix, policyFile, gateJsonPath, json } = resolveGateReportVerb(args);
    // ⟨0.24⟩ EVERY exit from here on that is a REFUSAL writes the document (SPEC §3.1 `107755b`, carve-outs
    // removed by `1503368`) — including an unreadable policy, because a stale green does not care why this
    // run declined to overwrite it. A USAGE error deliberately does not: the command was never a gate
    // invocation, so there is nothing to refuse and nothing a wrapper could be reading a verdict from.
    const gdests = [...new Set([json ? "-" : null, gateJsonPath].filter((d) => d !== null && d !== undefined))];
    const gwrite = (obj) => {
      const text = JSON.stringify(obj, null, 1);
      for (const dest of gdests) {
        // THE FLAG IS SET WHERE THE WRITE HAPPENS, not where the gate is entered. It was set on
        // entering this verb, under the comment "reaching here means the gate ran and will write its
        // own document" — which is a claim about the future, and false: the `--policy` fallback ladder
        // can still exit 2 below without writing. That suppressed the pre-pass hook and returned the
        // run to EMPTY stdout after exit 2, which is the exact channel the hook was added to close.
        // Caught by the second go/no-go panel; the first flag placement lasted about an hour.
        if (dest === "-") { globalThis.__candorGateVerdictWritten = true; console.log(text); continue; }
        // A SURFACING side-output: an unwritable path is one stderr line, never a raw ENOENT crash whose
        // exit 1 would read as a policy violation on a clean run (the scan path's rule).
        try {
          writeSinkAtomic(dest, text + "\n");
        } catch (e) { console.error(`candor-ts: could not write --gate-json ${dest}: ${e.message}`); }
      }
    };
    const grefuse = (reason, unevaluated = null) => {
      gwrite(refusalVerdict(SPEC_VERSION, reason, unevaluated));
      process.exit(2);
    };
    if (!policyFile) { console.error("candor-ts: gate requires a policy — pass `--policy <file>`, or set CANDOR_POLICY / a .candor/config `policy` key. `gate` applies a policy to an existing report; with no policy there is no verdict to give."); process.exit(2); }
    let gtext;
    try { gtext = fs.readFileSync(policyFile, "utf8"); }
    catch {
      // The SHARED sentence + disclosure (policyUnreadable), so this document and the scan route's are
      // byte-equal for this refusal cause too — they carried two different `reason` strings, and the
      // equality row only ever exercised the UNHONOURABLE policy, so nothing could see it.
      const { why, unevaluated } = policyUnreadable(policyFile);
      console.error(`candor-ts: ${why}`);
      grefuse(why, unevaluated);
    }
    // ⟨0.19⟩ `unknown-alias` expansion for an `Unknown[<alias>]` filter, anchored to the POLICY file — an
    // alias is part of the policy's own vocabulary, not of the report. ⟨0.24⟩ SPEC §3.1 `99eb4e9` makes that
    // anchor NORMATIVE and puts the SCAN route on it too (policyVocabularyAnchor), so byte-equality holds by
    // construction rather than by the two routes happening to point at one directory. The ⟨0.20⟩
    // `net-partner` list is deliberately NOT loaded: `netClass` is read verbatim off the wire, so
    // re-classifying its hosts through THIS machine's config would be exactly the re-derivation §3.1 ⟨0.24⟩
    // forbids (and would make the verdict depend on the consumer's CWD). Nor is the `deps` key, likewise.
    const gcfgDir = policyVocabularyAnchor(policyFile, process.cwd());
    const gerrors = [];
    const gpol = parsePolicy(gtext, parseUnknownAliases(discoverConfigText(gcfgDir), gerrors));
    gerrors.push(...gpol.errors);
    const gfatal = fatalPolicyErrors(gerrors);   // ⟨0.24⟩ see loadPolicyOrDie: dropped LINES report, tokens refuse
    // ⟨0.24⟩ SPEC §6.2 (`382a7e0` + `be0b9a9`): a policy that cannot be honoured AS WRITTEN is a POLICY
    // ERROR, not a rule to silently rewrite — exit 2, the unreadable-policy posture, before any evaluation.
    // ⟨0.24⟩ …and the refusal DISCLOSES which lines went unevaluated, from the SAME builder the scan route
    // uses (SPEC §3.1 makes byte-equality between the two documents the acceptance test — the scan route
    // needed this list so a dominating baseline regression could carry the refusal beside it, and a list on
    // one route only would break the equality on the very change that repaired the precedence).
    // ⟨0.27⟩ …listing EVERY rule of the refused policy, not only the unhonourable lines — the shared
    // builder with the scan route (SPEC §3.1's composed-document clause; byte-equality binds the two).
    if (gfatal.length) { const why = policyErrorText(policyFile, gfatal); console.error(why); grefuse(why, policyRefusalUnevaluated(gtext, gfatal)); }
    // ⟨0.28⟩ …AND A CONFIGURED POLICY THAT YIELDED ZERO RULES REFUSES THE SAME WAY (SPEC §6.2). The scan
    // route carries the same block with the same builder; this one is not optional beside it, on §6.2's own
    // words ("Measured on the `gate --report` verb too — a route is not covered by its sibling") and on
    // §3.1's byte-equality MUST, which a one-route rung would break on the `# nothing` policy. Every rule
    // vector, never a subset: `deny` (deny + pure), `allow`, `forbid` — keying on one would refuse an
    // ordinary allow-only or forbid-only gate as if it had no rules.
    if (!gpol.deny.length && !gpol.allow.length && !gpol.forbid.length) {
      const { why, unevaluated } = policyZeroRules(policyFile);
      console.error(`candor-ts: gate: ${why} — refusing (exit 2, gate NOT enforced). Every line was ignored `
        + `(see the \`ignoring policy rule\` warnings above), the file is empty, or it holds only comments. A `
        + `gate with no rules cannot have caught anything, and \`ok: true\` here would be indistinguishable `
        + `from a gate that ran and found nothing.`);
      grefuse(why, unevaluated);
    }
    // ⟨0.24⟩ THE CONFIG FILE THAT SUPPLIED VOCABULARY THE VERDICT USED (SPEC §3.1 `99eb4e9`) — named on a
    // REFERENCE, not only on a firing, because the measured harm was a GREEN verdict a vocabulary file made
    // green. Omitted when no alias was used, so every other verdict stays byte-identical to before.
    const gcfgPath = Object.keys(gpol.aliasesUsed).length ? discoverConfigPath(gcfgDir) : null;
    const gvocab = gcfgPath ? { config: gcfgPath, aliases: gpol.aliasesUsed } : null;
    // ── ANSWERABILITY (SPEC §3.1 ⟨0.24⟩): a rule whose EVIDENCE THE WIRE DOES NOT CARRY is NOT EVALUATED,
    // never evaluated on partial evidence — which would be the gateless-green failure the gate exists to
    // prevent, in the fail-OPEN direction, on a policy the user believed was enforced. Two of the three are
    // decidable from the POLICY alone, so their GRANULARITY is whole-policy.
    //
    // ⟨0.24⟩ BUT WHOLE-POLICY GRANULARITY IS NOT A LICENCE TO SUPPRESS A VIOLATION (SPEC §3.1 `1503368`).
    // These two used to exit 2 on the spot, so a firing `deny Fs` beside a `forbid` rule exited 2 with the
    // certain violation absent from the document — the same Lemma-2 error as the scoped case, and Lemma 2
    // does not care which KIND of refusal stands beside the firing rule. They are now UNEVALUATED rules
    // disclosed beside whatever the rest of the policy decided; a policy that is nothing BUT these still
    // refuses below, because then there is no verdict to dominate them.
    const gunevaluated = [];
    if (gpol.forbid.length) {
      const why = `this policy has ${gpol.forbid.length} \`forbid\` rule(s), which \`gate --report\` cannot evaluate — a report's \`calls\` graph is EFFECT-RELEVANT (only callees with a non-empty effect set are kept), so a crossing into a wholly PURE unit is invisible in it while \`forbid\` matches on NAME. The rule would read green where a scan fails. Gate layering at scan time: candor-ts <src> --policy ${policyFile}`;
      console.error(`candor-ts: gate: ${why}`);
      for (const r of gpol.forbid) gunevaluated.push({ rule: r.raw, why });
    }
    if (gpol.allow.length) {
      const effs = [...new Set(gpol.allow.map((r) => r.effect))].sort();
      const why = `this policy has \`allow ${effs.join("`/`")}\` rule(s), which \`gate --report\` cannot evaluate — the AS-EFF-008 surface-completeness marker does not ride the report wire in any form, so a benign visible literal beside a runtime-computed endpoint would be CERTIFIED here and flagged by a scan. (\`netClass: unknown-host\` is NOT that marker — it also names a merely UNRECOGNISED host, so reading it as "masked" flags functions whose surface is fully visible.) Gate allowlists at scan time: candor-ts <src> --policy ${policyFile}`;
      console.error(`candor-ts: gate: ${why}`);
      for (const r of gpol.allow) gunevaluated.push({ rule: r.raw, why });
    }
    const g = loadGateReport(prefix);
    // ANY report under the locator that did not load cleanly REFUSES THE WHOLE GATE — not just the case
    // where they ALL failed. The old guard was `functions.length === 0 && hardFail`, i.e. it fired only
    // when nothing survived anywhere, so a multi-report prefix with ONE clean sibling and one truncated
    // one gated GREEN off the survivor: measured on `rep.Aclean.scan.json` (pure) beside a mid-write
    // `rep.Bdirty.scan.json` (which carried the `Net` the policy denies), candor-ts exited 0 with
    // `{"ok":true,"violations":[]}`. The stderr line from loadGateReport DID say the dirty report's
    // functions were omitted — but stderr is not the machine-consumer channel, and a CI wrapper reads the
    // DOCUMENT, which was a clean green with no trace that half the package was missing. §3.1: "a report
    // that cannot be parsed is corrupt input, not an effect-free package … A located report that yields no
    // trustworthy functions MUST fail loudly." The union of a signature and a hole is a HOLE: the gate is
    // a claim about a whole package, and the effects of the sibling that did not load are exactly the ones
    // a violation would have come from. Keep the per-file disclosure, move the verdict — refuse BEFORE
    // building `gverdictObj`, so no VERDICT document is written to stdout or to `--gate-json <file>`
    // either. Matches candor-rust and candor-swift, both of which exit 2 on this fixture.
    //
    // ⟨0.24⟩ A REFUSAL DOCUMENT still goes out (SPEC §3.1 `107755b`) — the earlier reading, that writing
    // nothing keeps a wrapper from mistaking a refusal for a judgement, had it backwards: writing nothing
    // does not leave the wrapper with no document, it leaves it with LAST RUN's. What stops the refusal
    // being read as a judgement is `refused: true` and the MISSING `violations` key, not its absence from
    // the disk.
    //
    // ⟨0.24⟩ AND THE PRECEDENCE RULING DOES NOT REACH THIS EXIT (SPEC §3.1 `01d5c6b`). The two refusals are
    // indistinguishable from the exit code, so the distinction has to be drawn here. An ANSWERABILITY
    // refusal says the report is trustworthy and one rule cannot be decided from it — the other rules'
    // evidence IS carried, so a firing rule is certain and Lemma 2 makes exit 1 dominate. A CORRUPTION
    // refusal says the report cannot be read AS A REPORT, which undermines the very premise that argument
    // runs on: a violation computed from a document with an unparseable §2 key is not a certain finding, it
    // is a finding computed from bytes of unknown meaning, and exiting 1 on it would assert a confidence the
    // input does not support — the mirror of the fabrication `5a8cf48` closed. The test, stated rather than
    // instanced: does the refusal's cause undermine the premise that the fired rule's evidence was carried?
    // Here it does, so nothing downstream of this input is certain and the refusal dominates.
    //
    // …and the SAME refusal covers the second way a report fails to load cleanly: a §2 key that is PRESENT
    // BUT UNPARSEABLE (SPEC §2 ⟨0.24⟩ — "a reader that recovers from a type mismatch by substituting the
    // default … the language's convenience default is the fail-open direction on every key in this
    // format"). The refusal NAMES the key, as the spec requires, because the point is to send the producer
    // back to the bytes. Measured: `{"fn":"app.bad","inferred":[1],"direct":[1]}` under `deny Net` gated
    // exit 0 with `{"ok":true,"violations":[]}` — the entry was coerced to an effect-free one, and under
    // ⟨0.21⟩ an effect-free entry is a POSITIVE PURITY CLAIM, so the corrupt entry did not become a gap,
    // it became a lie. ABSENT is untouched: absent takes its documented default, which is exactly the
    // distinction the rule draws.
    if (g.hardFail) {
      if (g.corrupt.length)
        console.error(`candor-ts: the report at prefix '${prefix}' has ${g.corrupt.length} present-but-unparseable §2 key(s) — a key that is THERE but of the wrong shape is corrupt input, not an empty one (SPEC §2 ⟨0.24⟩); coercing it to its empty value would turn corruption into a purity claim. Refusing to gate — fix the report or re-run the scan:\n  ${g.corrupt.join("\n  ")}`);
      const why = `a report found at prefix '${prefix}' failed to load — refusing to gate over a report that did not load cleanly; a partial signature makes a green verdict meaningless (the effects of the report that did not load are exactly the ones a violation would come from). Re-run the scan.`;
      console.error(`candor-ts: ${why}`);
      grefuse(why, gunevaluated);
    }
    // ⟨0.24⟩ …AND A REPORT THAT JUDGED NOTHING IS NOT AN ALL-CLEAR EITHER (SPEC §2's three-row table,
    // bound to this verb by §3.1: "a report presented DIRECTLY to the gate with `analyzed.count: 0` makes
    // the same claim as a chained one, and must be read the same way … the obligation is on the reading,
    // not on the route by which the report arrived"). The chained half of this rule lives in scan.mjs, on
    // the coverage decision; here there is no coverage decision to hang it on — the report IS the whole
    // input — so what the rule buys is the DISCLOSURE beside the verdict.
    //
    // NOT the exit code and NOT the verdict document, deliberately, on two independent grounds. §3.1 makes
    // byte-equality with `scan --policy`'s `--gate-json` the acceptance test, and a scan that analyzed
    // nothing writes `{ok: true, analyzed: {count: 0}, violations: []}` and exits 0 — so diverging here
    // would split the verb this rung exists to keep single. And a verdict is an ASSERTION: the consumer has
    // no evidence of any effect, so manufacturing one would be the fabrication mirror of the silent
    // under-report. The machine channel is already correct and already byte-equal — `analyzed.count` rides
    // the document, which is what ⟨0.21⟩ put it there for. What was missing is that a human reading "no
    // violations" had nothing telling them the gate had judged nothing at all.
    if (g.judgedNothing)
      console.error(`candor-ts: the report at '${prefix}' judged NOTHING (⟨0.24⟩ \`analyzed.count\` is 0, absent with no `
        + `entries, or unreadable) — a report with no judgment in it is not an all-clear, so a green verdict below `
        + `certifies nothing: absence from \`functions\` licenses no purity claim about any unit. Re-scan the sources `
        + `you meant to gate (candor-ts <src> --out ${prefix}), or gate the report of the package that has them.`);
    // THE REPORT ROUTE'S `(S, D)`: `S` = each entry's `inferred`, verbatim; `D` = the reason classes
    // resolved over the entries' OWN `calls` edges (the sidecar is NOT passed — that is the MUST NOT), by
    // the SAME resolution the scan gate and `unverified --class` use. `netClass` verbatim, likewise.
    const gnet = reportNetClasses(g.functions, { authoritative: true });
    const gacc = resolveReasonClasses(g.functions, {});
    // THE THIRD REFUSAL — the only one that depends on the REPORT rather than the policy alone, and the
    // only one whose GRANULARITY is per (rule, function). See unanswerableScoped for why it is minimal, and
    // why it no longer short-circuits.
    const { unevaluated: gscoped, withhold: gwithhold } = unanswerableScoped(gpol, g.functions, gacc, gnet);
    for (const u of gscoped) { console.error(`candor-ts: gate: ${u.why}`); gunevaluated.push(u); }
    // ONE matcher for both routes into the gate (SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST APPLY THE
    // SAME RULE, AND SHOULD SHARE THE SAME CODE"). `scan --policy` and this verb both land in
    // evaluatePolicy, which is what makes "the same verdict from the same signature" a property of the
    // code rather than of two consistent authors. The empty callgraph/incomplete/partners arguments are
    // the report route's honest inputs, not stubs: none of the three rides the ⟨0.24⟩ wire.
    //
    // ⟨0.24⟩ `forbid`/`allow` are STRIPPED rather than passed: they are the two whole-policy unanswerable
    // kinds, now disclosed as `unevaluated` instead of short-circuiting (`1503368`), and handing them to the
    // matcher would be the very evaluation-on-partial-evidence they are unanswerable FOR — `allow` would
    // fire AS-EFF-008 "no visible literal" on every report entry whose surface the wire does not carry.
    const gviol = evaluatePolicy({ deny: gpol.deny, allow: [], forbid: [] },
                                 g.functions, {}, new Map(), new Set(), gnet, gwithhold);
    // Route the human output exactly as a scan does: to stderr whenever stdout carries the verdict
    // document, so `candor-ts-query gate … --json | jq` sees pure JSON.
    const gsay = (json || gateJsonPath === "-") ? (l) => console.error(l) : (l) => console.log(l);
    // ⟨0.27⟩ SPEC §4 — THE ZERO-MATCH DISCLOSURE BELONGS ON THIS ROUTE TOO. Its absence was found by a
    // cross-engine differential: java and swift disclosed on `gate --report`, rust and ts did not, so
    // the same typo'd policy was reported by two engines and silently scored as satisfied by two. §4's
    // MUST carries no route qualifier, and this is the SUPPLY-CHAIN gate — a consumer pointing a policy
    // at a report someone else produced. ALWAYS on stderr, never through `gsay`: this is a disclosure
    // about the policy, not a verdict line, and stdout may be carrying the verdict document.
    for (const raw of gviol.zeroMatch ?? []) {
      console.error(`candor: policy rule matched NO function — \`${raw}\`. It was evaluated and bound `
        + `nothing, so it cannot have caught anything. Legitimate when one policy is shared across `
        + `repos; a typo'd layer name otherwise.`);
    }
    for (const x of gviol) gsay(`[${x.rule}] ${x.detail}`);
    // ⟨0.21⟩ COMPLETENESS MANIFEST: a gate cannot be green over code candor never analyzed. The scan path
    // exits 2 on its OWN `unanalyzed`; here the same manifest travels ON the report, so the same verdict
    // follows from it. A real violation (exit 1) dominates, as it does there.
    const gincomplete = g.unanalyzed.length > 0;
    // The verdict document — the SAME builder shape scan.mjs writes, field for field and in the same key
    // order, because §3.1 ⟨0.24⟩ makes byte-equality with `scan --policy`'s `--gate-json` the acceptance
    // test. `analyzed.count`, `incomplete`/`unanalyzed` and the ⟨0.15⟩ coverage advisory all come off the
    // report envelope rather than being recomputed.
    //
    // ⟨0.24⟩ PRECEDENCE (SPEC §3.1 `7271c69`): **violation (1) > refusal (2) > incomplete (2)**, and the
    // first rung is forced by Lemma 2 rather than chosen. A firing rule is decided on evidence the report
    // carries, so no unanswerable rule beside it can un-reject the policy — the verdict is written and the
    // unevaluated rules ride ALONGSIDE it under `unevaluated`. Only when nothing fired is the refusal the
    // whole answer, and then it is a REFUSAL DOCUMENT (no `violations` key), not a verdict.
    const gverdictObj = { spec: SPEC_VERSION, ok: gviol.length === 0 && !gincomplete,
                          analyzed: { count: g.analyzed } };
    if (gvocab) gverdictObj.policyVocabulary = gvocab;
    gverdictObj.violations = gviol;
    if (gunevaluated.length) gverdictObj.unevaluated = gunevaluated;
    // ⟨0.27⟩ SPEC §4 `zeroMatch` — the same list the stderr lines above carry, in the machine channel,
    // in the same position the scan route puts it (§3.1's byte-equality MUST binds the two documents).
    if (gviol.zeroMatch?.length) gverdictObj.zeroMatch = gviol.zeroMatch;
    // ⟨0.28⟩ SPEC §6.2 `ignored: [{line, text, reason}]` — the policy lines the parse DROPPED, in the SAME
    // position the scan route puts them, because §3.1 makes byte-equality between the two documents the
    // acceptance test and §6.2 records this defect measured "on the `gate --report` verb too — a route is
    // not covered by its sibling". Distinct from `unevaluated`: that carries rules that PARSED and could
    // not be answered, this carries text that never became a rule at all. Omitted when empty; `ok` and
    // the exit do not consult it (the line-level leniency is unchanged, only disclosed).
    if (gpol.ignored?.length) gverdictObj.ignored = gpol.ignored;
    if (gincomplete) { gverdictObj.incomplete = true; gverdictObj.unanalyzed = g.unanalyzed; }
    if (g.coverage.length)
      gverdictObj.coverage = { uncovered: g.coverage.length, packages: g.coverage.map((c) => c.name) };
    if (gviol.length) {
      gwrite(gverdictObj);
      console.error(`candor-ts: ${gviol.length} policy violation(s)`);
      if (gunevaluated.length)
        console.error(`candor-ts: …and ${gunevaluated.length} rule(s) could not be evaluated against this report (disclosed above and under \`unevaluated\`) — the violation(s) named are certain regardless of how those would have resolved`);
      console.error("→ candor-ts-query fix-gate names the remedy for each");
      process.exit(1);
    }
    if (gunevaluated.length)
      grefuse(`${gunevaluated.length} policy rule(s) could not be evaluated against this report`, gunevaluated);
    if (gincomplete) {
      const why = `gate NOT certified — the report declares ${g.unanalyzed.length} unit(s) candor could not analyze; a gate cannot be green over unanalyzed code`;
      console.error(`candor-ts: ${why}`);
      // The INCOMPLETE verdict is a JUDGEMENT, not a refusal: it names what was analyzed and what was not,
      // and §3.1 makes byte-equality with `scan --policy`'s document the acceptance test for exactly it.
      gwrite(gverdictObj);
      process.exit(2);
    }
    gwrite(gverdictObj);
    gsay("candor-ts: no violations");
    process.exit(0);
    break; // unreachable
  }
  default:
    // no command (cmd === undefined) or an unknown one: the FULL usage, not the stale 6-item list.
    if (cmd !== undefined) console.error(`candor-ts-query: unknown command '${cmd}'`);
    console.error(usage());
    process.exit(2);
}
