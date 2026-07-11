# Changelog

All notable changes to candor-ts are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the family convention (candor-rust's
CHANGELOG): candor is pre-1.0, so minor versions may include behavioural changes — always in the
soundness-increasing direction (the §4 trust contract) — and a **⚠** marks an entry that affects
report bytes or gate verdicts (regenerate baselines / expect verdict changes across it).

## [0.8.17] — 2026-07-11

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
