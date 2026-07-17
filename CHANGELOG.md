# Changelog

All notable changes to candor-ts are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the family convention (candor-rust's
CHANGELOG): candor is pre-1.0, so minor versions may include behavioural changes — always in the
soundness-increasing direction (the §4 trust contract) — and a **⚠** marks an entry that affects
report bytes or gate verdicts (regenerate baselines / expect verdict changes across it).

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
