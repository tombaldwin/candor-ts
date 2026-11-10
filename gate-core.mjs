// The gate's evaluation over a report and a policy TEXT, moved out of query.mjs so a second caller (the MCP
// `candor_accepts` tool) can run this engine's OWN gate in-process instead of spawning a child: query.mjs is a CLI
// whose top level runs on import, and the self-gate declares exactly three Exec sites.
import { parsePolicy, parseUnknownAliases, discoverConfigText,
         evaluatePolicy, reportNetClasses, resolveReasonClasses, discoverConfigPath,
         policyVocabularyAnchor, policyErrorText, policyRefusalUnevaluated, policyZeroRules,
         fatalPolicyErrors, refusalVerdict, sortViolations,
         unanswerableScoped, wholePolicyUnanswerable, reportUnits, noteSyntheticHits, settleAccept, announceAccepted, settleProbe } from "./policy.mjs";
import { loadGateReport, byCodePoint } from "./query-core.mjs";
import { consultedSwitches, switchRefusalReason } from "./env.mjs";
import { SPEC_VERSION } from "./spec-version.mjs";

/**
 * THE GATE'S EVALUATION over a report and a policy TEXT, shared by `gate --report` and `accepts` (SPEC §6.2 ⟨0.41⟩:
 * the refresh verb runs this engine's OWN gate over the proposal, never a second implementation of it). Moved out of
 * `case "gate"` verbatim: the only edits are that `process.exit` is the injected `exit` and the inputs arrive in `env`.
 * The gate verb passes `process.exit` and the document sinks; `accepts` passes an `exit` that throws and a `gwrite`
 * that keeps the document. `exit` never returns.
 */
export function gateCore({ prefix, policyFile, gtext, json, gateJsonPath, gwrite, grefuse, exit }) {
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
    if (!gpol.deny.length && !gpol.allow.length && !gpol.forbid.length && !(gpol.only ?? []).length) {
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
    // ⟨0.29⟩ ONE IMPLEMENTATION, THREE CALLERS. This block used to live here and only here, and the two
    // other report-reading routes in this package (the MCP `candor_gate` tool, the LSP diagnostics path)
    // passed the whole policy to the matcher — so `forbid` was answered from a report on the agent
    // channel while the CLI refused it. Moved into `wholePolicyUnanswerable` so the next route inherits
    // the rule instead of being audited into it.
    const gwp = wholePolicyUnanswerable(gpol, "`gate --report`");
    const gunevaluated = gwp.unevaluated;
    // One line per rule, each NAMING the rule. The previous shape printed a single kind-level sentence
    // for the whole policy, so an operator with three `forbid` rules learned that three rules were
    // unenforced and not which. The `unevaluated` array in the JSON document already carried `rule`; the
    // human channel simply did not show it.
    for (const u of gunevaluated) console.error(`candor-ts: gate: ${u.why}`);
    // ⟨0.33⟩ this gate's OWN rules ride along so `loadGateReport` can compare them against every gated
    // report's `scannedUnder` (SPEC §2 ⟨0.33⟩) — the ONE place this route computes that condition; see
    // `g.unaskedRules` below.
    const g = loadGateReport(prefix, gpol.deny);
    // ⟨0.42⟩ SPEC §3.3 cause (e) / §3.4 (c), SOUNDNESS R1634: A GATE UNDER A SET RESULT-MOVING SWITCH IS UNANSWERABLE. Two
    // sources, UNIONED: (i) a switch THIS process consulted (a gate that ran no analysis consults none, and engines MUST
    // NOT read every switch at start, so `gate --report` in an environment holding a scan-time switch judges a clean
    // report as it would without it), and (ii) a non-empty `switches` on the report being judged, which a switched
    // scan wrote. Exit 2, the §3.1 refusal document (no `violations`) carrying the names; a violation does not dominate it.
    {
      const sw = [...new Set([...consultedSwitches(), ...(g.switches ?? [])])].sort(byCodePoint);
      if (sw.length) {
        const why = switchRefusalReason(sw);
        console.error(`candor-ts: gate: ${why}`);
        grefuse(why, null, sw);
      }
    }
    // ⟨0.32⟩ DOES THIS POLICY'S ANSWER DEPEND ON THE CODE THE PRODUCER LEFT UNREAD? — the ONE place that
    // condition is applied on this route (the rule itself is stated at the reading site in
    // query-core.mjs's `loadGateReport`). `deny` is the rule vector that carries `pure` too;
    // `allow`/`forbid`/`only` live in their own, and none of them is answered from code OUTSIDE the scan's
    // scope, so refusing them for want of a peek would be an over-charge — the same short-circuit
    // scan.mjs's peek applies to the same question.
    //
    // APPLIED TO THE VALUE, not repeated at the exit arm, and that is deliberate: this list feeds BOTH
    // `gincomplete` (hence `ok`/`incomplete` in the verdict document) and the exit code below, so a
    // condition stated at only one of them lets the two disagree — a document reading `ok: false,
    // incomplete: true` beside exit 0. candor-rust's copy of this rung had exactly that split.
    const gunread = gpol.deny.length ? g.unread : [];
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
    // ⟨0.32⟩ THE UNIT IDENTITY FOR A MULTI-REPORT PREFIX (SPEC §2.2). Built ONCE here and handed to every
    // accumulator, so the gate, its refusal and its verdict all key the same way — a private copy is how
    // the advisory verbs came to disagree with the gate before.
    const gunits = reportUnits(g.functions);
    const gnet = reportNetClasses(g.functions, { authoritative: true, units: gunits });
    const gacc = resolveReasonClasses(g.functions, {}, gunits);
    // THE THIRD REFUSAL — the only one that depends on the REPORT rather than the policy alone, and the
    // only one whose GRANULARITY is per (rule, function). See unanswerableScoped for why it is minimal, and
    // why it no longer short-circuits.
    const { unevaluated: gscoped, withhold: gwithhold } = unanswerableScoped(gpol, g.functions, gacc, gnet, gunits);
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
    const gviolRaw = evaluatePolicy(gwp.answerable,
                                    g.functions, {}, new Map(), new Set(), gnet, gwithhold, gunits);
    // ⟨0.41⟩ SPEC §6.2 `accept`: the SAME settle the scan route runs, over the same rows (§3.1 ⟨0.41⟩ puts
    // `accepted` in the evaluated projection). A rule this route could not answer — `forbid`, `only`, `allow`,
    // an unanswerable filter — is in `gunevaluated`, so its entries are `unjudged` here and accepted on the
    // scan route. The count line prints on every run that accepted a row, including one that exits 2.
    const gaccept = settleAccept(gwp.answerable, gviolRaw, g.functions, { unevaluated: gunevaluated });
    const gviol = gaccept.violations;
    gviol.zeroMatch = gviolRaw.zeroMatch;
    gviol.syntheticHits = gviolRaw.syntheticHits;
    announceAccepted(gaccept);
    // ⟨0.39⟩ see scan.mjs's twin — one printer, both verdict routes.
    noteSyntheticHits(gviol);
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
    // ⟨0.30⟩ the SECOND cause, read off the report because this route cannot peek — the report carries the
    // peek's findings, which is what makes §3.1 byte-equality hold here by construction rather than by two
    // authors agreeing. ABSENT is not empty: a report produced with no policy was never asked.
    const gscope = g.outOfScope ?? [];
    // ⟨0.32⟩ the THIRD cause, read off `excluded[].peeked` — code the PRODUCER never opened. Distinct from
    // the ⟨0.30⟩ one above: that is "the peek looked and found the effect you deny", this is "nothing
    // looked at all", and the two want different repairs.
    // ⟨0.33⟩ the FOURTH cause — a class the producer's peek DID read, but under a deny set that does not
    // cover this gate's own. Distinct from `gunread` above: that is "nothing looked", this is "something
    // looked, for a narrower question than the one being asked now". Computed by `loadGateReport` from
    // the SAME `scannedUnder`/`excluded[].peeked` pair the gate route reads for its other two scope
    // causes, never re-derived here.
    const gunasked = g.unaskedRules ?? [];
    const gincomplete = g.unanalyzed.length > 0 || gscope.length > 0 || gunread.length > 0
                       || gunasked.length > 0;
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
    // ⟨0.31⟩ the partner declaration that moved the producer's classification, READ OFF THE REPORT —
    // never recomputed here. This route has no target to anchor `net-partner` at, and the note above
    // says why recomputing would be wrong anyway: `netClass` is read verbatim off the wire, so
    // re-classifying through THIS machine's config is the re-derivation §3.1 forbids and would make the
    // verdict depend on the consumer's CWD. The producer recorded which of its declared partners
    // actually participated; both routes copy that one record, and byte-equality holds by construction.
    // Same position as the scan route puts it, for the same reason as `policyVocabulary` above.
    if (g.netPartners?.length) gverdictObj.netPartners = g.netPartners;
    // ⟨0.32⟩ SPEC §2 — the sort key includes the unit identity. See `sortViolations`; the SAME call
    // is made on the scan route, because §3.1 makes the two documents byte-equal.
    // ⟨0.41⟩ …unless this is an exit-2 INCOMPLETE verdict over a policy with `accept` entries and nothing left
    // red: it "makes no claim about violations", so the key is absent (see the scan route's twin). Without
    // `accept` entries the document keeps its `violations: []`.
    if (!(gincomplete && (gpol.accept ?? []).length && gviol.length === 0))
      gverdictObj.violations = sortViolations(gviol);
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
    // ⟨0.41⟩ SPEC §6.2 `accepted` — same key and position as the scan route; omitted from every exit-2 document.
    if (gaccept.accepted && !(gincomplete && gviol.length === 0)) gverdictObj.accepted = gaccept.accepted;
    if (gincomplete) {
      gverdictObj.incomplete = true;
      if (g.unanalyzed.length) gverdictObj.unanalyzed = g.unanalyzed;
    }
    // ⟨0.30⟩ same key, same position as the scan route's — §3.1's byte-equality is the acceptance test.
    if (gscope.length) gverdictObj.outOfScope = gscope;
    if (g.coverage.length)
      gverdictObj.coverage = { uncovered: g.coverage.length, packages: g.coverage.map((c) => c.name) };
    if (gviol.length) {
      gwrite(gverdictObj);
      console.error(`candor-ts: ${gviol.length} policy violation(s)`);
      if (gunevaluated.length)
        console.error(`candor-ts: …and ${gunevaluated.length} rule(s) could not be evaluated against this report (disclosed above and under \`unevaluated\`) — the violation(s) named are certain regardless of how those would have resolved`);
      console.error("→ candor-ts-query fix-gate names the remedy for each");
      exit(1);
    }
    if (gunevaluated.length)
      grefuse(`${gunevaluated.length} policy rule(s) could not be evaluated against this report`, gunevaluated);
    if (gincomplete) {
      // ⟨0.30⟩ NAME THE CAUSE THAT ACTUALLY FIRED. Two causes reach this exit now, and a message that
      // always says "could not analyze" would report the wrong repair for the scope one — the operator
      // would go looking for a parse failure that is not there.
      // ⟨0.32⟩ …and a THIRD, in the same order scan.mjs uses (`unanalyzed` → `outOfScope` → `unread`),
      // so a report that trips two of them names the same cause on both routes. Its message differs from
      // the `outOfScope` one because the repair does: that one wants a scan whose SELECTOR reaches the
      // code, this one wants a scan that was ASKED the question at all.
      // ⟨0.33⟩ …and a FOURTH, LAST, because each cause above names a MORE concrete gap than this one: a
      // class the producer's peek DID read, but under a deny set that does not cover this gate's own —
      // SPEC §2 ⟨0.33⟩. The remedy says "the SAME policy", not "a policy": the operator DID scan with a
      // policy, and reading ⟨0.32⟩'s remedy loosely (any policy re-scans it) is what produces this hole,
      // because the peek only ever looked for the PRODUCER's denied effects.
      //
      // ⟨0.34⟩ …and TWO SENTENCES for that fourth cause, chosen by `g.unaskedRulesPredates033` — SAME
      // verdict, SAME exit, ONLY this line's wording moves (`g.unaskedRulesPredates033` never touches
      // `gincomplete`/`gverdictObj` above). The ⟨0.33⟩ sentence is TRUE of a ≥⟨0.33⟩ producer that
      // genuinely scanned under a narrower deny set, and MISLEADING of a report that predates ⟨0.33⟩
      // entirely — such a producer never had a `scannedUnder` key to hold ANY deny set in, so "does not
      // cover" reads as "chose a different policy" where the truth is "could not yet record one". SPEC
      // ⟨0.34⟩ explicitly ruled OUT a version floor for the VERDICT (a report's age cannot license
      // certification — a pre-⟨0.33⟩ producer's peek was still bounded by SOME policy nobody here can
      // see, so refusing is correct either way), so the version decides ONLY which of these two
      // already-true sentences to print. The `else` arm is character-for-character the pre-⟨0.34⟩ text —
      // the control this rung ships with.
      const why = g.unanalyzed.length
        ? `gate NOT certified — the report declares ${g.unanalyzed.length} unit(s) candor could not analyze; a gate cannot be green over unanalyzed code`
        : gscope.length
        ? `gate NOT certified — the report names ${gscope.length} function(s) OUTSIDE the scan's scope performing an effect this policy denies; the gate did not judge them, so the verdict is incomplete rather than a pass`
        : gunread.length
        ? `gate NOT certified — the report says the scan did not READ ${gunread.join(", ")}. Their effects are absent because nothing looked, not because there are none, so the verdict is INCOMPLETE rather than a pass. Re-scan the sources with this policy (candor-ts <dir> --policy <file>) — a scan that was never asked cannot certify what it never opened`
        : g.unaskedRulesPredates033
        ? `gate NOT certified — this report was produced before ⟨0.33⟩, when a producing scan did not yet record the deny set its peek ran under (\`scannedUnder\`), so it cannot say whether ${gunasked.length} rule(s) of this policy were ever asked: ${gunasked.join(", ")}. The excluded files it reports as read may have been searched for OTHER effects, or for none at all — there is no way to tell from a report this old — so the verdict is INCOMPLETE rather than a pass. Re-scan with a 0.33+ engine under THE SAME policy this gate is applying (candor-ts <dir> --policy <file> --json <report>) — not merely under a policy`
        : `gate NOT certified — this report's peek was bounded by the deny set its producing scan held, and that set does not cover ${gunasked.length} rule(s) of this policy: ${gunasked.join(", ")}. The excluded files it reports as read were searched for OTHER effects, so an empty finding there is not an answer to this question, and the verdict is INCOMPLETE rather than a pass. Re-run the producing scan under THE SAME policy this gate is applying (candor-ts <dir> --policy <file> --json <report>) — not merely under a policy`;
      console.error(`candor-ts: ${why}`);
      // The INCOMPLETE verdict is a JUDGEMENT, not a refusal: it names what was analyzed and what was not,
      // and §3.1 makes byte-equality with `scan --policy`'s document the acceptance test for exactly it.
      gwrite(gverdictObj);
      exit(2);
    }
    gwrite(gverdictObj);
    gsay("candor-ts: no violations");
    exit(0);
}

/** Thrown by the `exit` that `runAcceptsGate` hands `gateCore` — `process.exit` would end the verb that is asking. */
class GateDone extends Error { constructor(code) { super("gate done"); this.code = code; } }

/**
 * SPEC §6.2 ⟨0.41⟩ `accepts`: this engine's OWN gate (`gateCore`, the code `gate --report` runs) over a policy given
 * as TEXT, in-process, with the document kept instead of printed. The policy file is never written; `policyPath` only
 * anchors the `.candor/config` vocabulary and names the file in messages. `probe` arms `settleProbe` so the caller can
 * read the entries, the rows each took, and the (hash, fn) twins from the same settle the verdict used.
 */
export function runAcceptsGate(prefix, policyPath, lines, probe) {
  let doc = null, rc = null, err = "";
  const gwrite = (obj) => { doc = obj; };
  const exit = (code) => { throw new GateDone(code); };
  const grefuse = (reason, unevaluated = null, switches = null) => { gwrite(refusalVerdict(SPEC_VERSION, reason, unevaluated, switches)); exit(2); };
  const e0 = console.error, l0 = console.log;
  console.error = (...a) => { err += a.join(" ") + "\n"; };
  console.log = () => {};
  settleProbe.armed = true; settleProbe.last = null;
  try {
    gateCore({ prefix, policyFile: policyPath, gtext: lines.join("\n"), json: true, gateJsonPath: null, gwrite, grefuse, exit });
  } catch (e) {
    if (!(e instanceof GateDone)) throw e;
    rc = e.code;
  } finally {
    console.error = e0; console.log = l0;
    settleProbe.armed = false;
  }
  const out = { rc, doc, err, probe: probe ? settleProbe.last : null };
  settleProbe.last = null;
  return out;
}
