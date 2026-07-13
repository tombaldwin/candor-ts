# Using candor-ts (instructions for an AI coding agent)

You are working in a TypeScript project. **candor-ts** tells you, for every function, which side
effects it can reach — network, filesystem, database, subprocess, env, clock — *including effects
inherited transitively through any chain of calls across files*. Use it instead of tracing call
chains by hand.

> **This document ships inside the package.** `npx -y candor-ts --agents` prints the contract for
> the *installed* version — always prefer that over a vendored or fetched copy, which can describe
> a different candor-ts than the one you are running.

> **Already installed? Report the version and ask before upgrading — before you scan.** If this
> project already has candor (a `.candor/` report directory, or `candor-ts` reachable via `npx`/a
> global install), do this *first*: run `npx -y candor-ts --version` (offline) and **tell the user
> plainly which version they're on** — e.g. *"This project is on candor-ts `<version>` (spec 0.11)."*
> On a build too old for the flag, read `candor.version` / `candor.spec` from an existing
> `.candor/report*.json`, or `npm ls -g candor-ts`.
>
> **Staying current is your job, not candor's.** candor never phones home — it audits and denies the
> Net effect, so it will not reach the network to check itself. `candor-ts --version` prints the
> installed build, the spec contract it speaks, and the upgrade line (`npm install -g
> candor-ts@latest`) — fully offline. **You** have the network: compare the installed version against
> npm. If it's behind, **ask the user before upgrading** — e.g. *"candor-ts `<latest>` is available
> (you're on `<installed>`) — upgrade before I scan?"* — and run `npm install -g candor-ts@latest` (or `npx
> -y candor-ts@latest`) only if they agree. Never upgrade silently: an analysis tool's version is
> part of its result's provenance, so the user decides when it changes. If it's already current (or
> the user declines), just proceed; if candor isn't installed at all, install it normally.

The language-agnostic consumption contract is
[candor-spec/AGENTS.md](https://github.com/tombaldwin/candor-spec/blob/main/AGENTS.md); this file is
the TypeScript-specific production + query surface.

## Produce a report

On npm (needs node ≥ 20):

```sh
npx -y candor-ts <project-dir>          # tsconfig.json honored; tests/node_modules excluded
npx -y candor-ts <dir> --allow-js       # also analyze .js/.mjs sources (walks the tree)
```

This writes `<project-dir>/.candor/report.json` and `.candor/report.callgraph.json` (override
with `--out <prefix>`). **Install the TARGET's dependencies first** (`npm install` in the project)
— without node_modules, imports don't resolve and most functions read `Unknown` (disclosed; the
scanner warns loudly). Add `--policy <file>` (or set `CANDOR_POLICY`) to enforce a §6.2 policy over the
scan: exit 1 on violation, exit 2 LOUDLY if the policy file is unreadable. `--gate-json <file|->`
additionally writes the structured verdict `{spec, ok, violations:[{rule,fn,effects,detail}]}`
(spec §3.3) — the machine-readable form CI/SARIF converters consume, from the SAME violations that
set the exit code. A checked-in `.candor/config` (spec §3.4; `policy <file>` / `baseline <report>` /
`deps <paths>`, one key per line, discovered walking UP from the scan target, relative values
anchored to the config's repo) is the no-env-wiring floor; flag → env → config → default.

**The AS-EFF-005 baseline guard** (spec §7): set `CANDOR_BASELINE=<saved report.json>` (or the
config `baseline` key) and the scan compares per function — an EXISTING function that gained an
effect versus the baseline fails the run (exit 1, `[AS-EFF-005]` lines, records join `--gate-json`);
new functions are exempt. Fail-closed: an unparseable baseline, or one from a different engine
build, is invalid gate input — exit 2 WITHOUT evaluating (never a silent skip); an absent file is a
note and the guard is inactive. `query diff` is the read-only twin: it DISCLOSES a build mismatch
(⚠, exit 0) instead of failing — use the scan-time guard, not `diff`, as the CI gate. Semantics
match the reference engine (candor-java).

**Report shape:** the file is `{ "candor": {version, toolchain, spec}, "functions": [...] }`;
`functions` is an **array** of entries (not a map — don't index it by name), each carrying **`fn`**
— module-qualified, `.`-separated
(`src.db.save` for `save()` in `src/db.ts`; class methods are `src.api.Client.send`; a function
declared inside a TS `namespace` carries the namespace segments too — `src.util.Ns.helper` — in
`fn` AND the callgraph/hierarchy keys, while its `hash` keeps the bare local name for cross-package
joining; builds before 0.8.7 omitted the namespace segments, so an engine upgrade across that line
is baseline-invalidating — regenerate saved reports) — with
`inferred` (the full transitive set) / `direct` / `unresolved` / optional `hosts`/`cmds`/`paths`/
`tables` (the literal surfaces). **Only effectful-or-unresolved functions appear in the report;
pure functions are omitted** — a function present in the callgraph sidecar but absent from
`.functions[]` is pure (as far as the engine resolved). In *neither* file = never analyzed
(a test file? an unexported arrow inside an object literal?) — conclude nothing.

A dist-CJS export unit (a `module.exports` surface scanned with `--allow-js`) carries
`unitKind: "export"` (spec 0.8, informative); ordinary functions omit the field.

**Multi-package (monorepos / private deps):** point `CANDOR_DEPS` at the dependencies' reports
(a path list, or a directory of `*.json`); an unclassified call into a package with a loaded
report inherits that function's recorded transitive effects and literal surfaces, joined by the
report's `hash` (`package#LocalName`). A report produced by a different candor-ts version is
downgraded to `Unknown` rather than silently trusted (spec §2.1). Caveat: a type-only boundary
(`import type` …, the tRPC style) has no runtime calls to inherit through — nothing to join.

## Query it (same names/shapes as the Rust and JVM engines — candor-spec §3.1)

```sh
Q() { npx -y -p candor-ts candor-ts-query "$@"; }; P=".candor/report"   # a function — works in bash AND zsh
Q show     $P <fn-query> 1          # a function's effects (+ hosts/tables when visible)
Q where    $P <Effect>   1          # {effect, directly, inherited}
Q impact   $P <fn-query>            # THE BLAST RADIUS: {fn, affectedCount, affected, entryPoints}
Q callers  $P <fn-query> 1          # the lower-level form: {of, direct, transitive} — works for pure fns
Q callers  $P <fn-query> --include-unknown 1  # + possibleViaUnknownDispatch: the unresolved-dispatch frontier
Q path     $P <fn> <Effect>         # how a fn reaches an effect: the chain to the nearest source
Q tour [N] --report $P              # the N (default 10) most surprising transitive reaches
Q map      $P 1                     # {module: {effects, functions}}
Q containment $P [baseline-prefix]  # §6.1 boundary-effect dispersion; with a baseline = AS-EFF-010 ratchet (exit 1 on a leak)
Q blindspots $P                     # the Unknown SOURCES (fns with unknownWhy), ranked by Unknown blast radius
Q whatif   $P <fn> <Effect> [policy]  # pre-edit gate verdict (exit 1 if it would violate)
Q fix      $P <fn> <Effect> <policy>  # the boundary FIX: where the effect belongs + the hoist refactor
Q unverified $P <policy> [--strict]  # pure/deny layers that PASS but are Unknown (not PROVABLY clean)
Q fix-gate $P <policy>              # a fix for EVERY crossing — the loop's block-message remedy
Q diff     $P <baseline-prefix> 1   # per-function effect delta (exit 1 on a gained effect)
Q gains    $P <baseline-prefix>     # supply-chain alarm: {gained, byFunction} — effects a surface grew
Q reachable $P 1                    # what the app DOES at runtime: effects over the entry points
Q parsepolicy <policy-file>         # the canonical §6.2 parse (what the gate will enforce)
```

And as an MCP server, so an agent pulls these as tools instead of shelling out:
`CANDOR_REPORT=$P npx -y candor-ts-mcp` (tools `candor_impact`/`candor_reachable`/`candor_where`/…,
plus `candor_gate`/`candor_whatif`/`candor_fix` — a given-but-unreadable `policy` is a loud tool
error, never a clean verdict). `npx -y candor-ts-watch <dir>` keeps the report fresh as you edit (and
reports the edit-delta); `candor-lsp` serves the same report as CodeLens/hover/diagnostics in any LSP
editor, plus two code actions (plain LSP — helix/neovim/VS Code/JetBrains-via-LSP4IJ all get them
without client code): the pre-edit whatif (`candor: what if <fn> performed <E>?` → the `candor.whatif`
command) and, when the cursor sits in a function that actually violates the policy, the boundary FIX
(`candor fix: hoist <E> out of <fn>` → the `candor.fix` command: where the effect belongs + the hoist
refactor, as a showMessage and a transient diagnostic, cleared on the file's next open/save).
CAVEAT — the MCP/LSP gate verdicts are computed FROM THE REPORT: the engine's own `--policy` /
`--gate-json` run additionally fails an allow rule whose literal surface is incomplete (a masked
endpoint — internal state, not a report field), so treat a report-side green as advisory and the
scan-time gate as the CI truth.

Name queries resolve exact > segment-suffix (`db.save` matches `src.db.save`, never
`src.db.save_all`) > substring — the same ladder as the other engines. The trailing `1` is the
want-JSON flag.

- **Blast radius of editing a function** → `impact <fn>` (the `affected` list + downstream
  `entryPoints`; NOT its `inferred`, which is what the function itself does). Works pre-edit for a
  still-pure function. `callers <fn>` is the lower-level raw-callers form.
- **Decide BEFORE you edit** → `whatif <fn> <Effect> [policy]` — every transitive caller gains the
  effect, crossed with the policy.
- **After you change code** → `diff` against a baseline report; a gained `Net`/`Db`/`Exec`/`Fs` you
  didn't intend is a regression in your change.

## TypeScript-specific things to know

- **Arrow-const functions are first-class**: `export const f = async () => …` is analyzed and named
  like a declaration; calls to it are edges. An arrow assigned inside a function body becomes its
  own unit (`src.x.helper`) — effects still propagate to the enclosing caller through the edge.
- **The classifier is curated** — the node builtins plus a growing npm tier; the README's
  "classifier" paragraph is the ONE current list (this file deliberately doesn't duplicate it — a
  vendored copy here drifted a full generation once).
  An unlisted package contributes nothing — an effect through it is invisible, not `Unknown`. The
  scanner **names these per scan**: the receipt's coverage-ledger line (marker: `classifier doesn't
  cover`) lists every npm package the code demonstrably calls that candor's classifier neither
  classifies nor has reviewed-pure — read it before concluding "no effect" through anything it names.
- **`process.env.X` reads are `Env`** (a property read, not a call); `Date.now()` is `Clock`.
- **DI-style code reads `Unknown` a lot, by design**: a function-typed parameter or field being
  called is genuinely indeterminate (rimraf's injected-fs style yields many `Unknown`s — that's the
  §4 disclosure contract, not noise). When every visible call site passes a *named* function, the callback
  resolves instead. And a method call on a **local-interface-typed value** (`store.save()` where
  `class PgStore implements Store`) resolves to the local implementors when the dispatch is narrow
  (≤12 classes) — the layered-DI pattern carries its real effects; only an interface with no
  visible implementor still reads `Unknown` (`dispatch:<Type>`).
- **`unknownWhy` names each direct Unknown's origin** (`call:jwt.sign`, `callback:param#0`,
  `dispatch:<Type>`) — triage starts at the named site. Inheritors carry `Unknown` with no why;
  follow the callgraph down to the root.
- **`entryPoint: true` marks runtime-invoked roots** (Nest `@Get/@Post/…` handler methods, Next
  `route.ts` HTTP exports and `middleware`) — their effects are never orphaned; `reachable` unions
  over them. Pure entry points stay visible in the report.

A worked policy (§6.2 — one rule per line, `#` comments):

```text
deny Net domain                       # the domain module reaches no network, transitively
pure  parse
allow Db in db  orders ledger.*       # the db module touches ONLY these tables
forbid domain -> infra
```

Note the `pure` semantics: it forbids every *effect* but NOT `Unknown` — the §4 trust marker is
uncertainty, not an effect (matching the reference engine, candor-java). Where a boundary must also
exclude the unverifiable case, say so explicitly: `deny Unknown <scope>` is the knob.

## The trust rule — do not skip this

`inferred` is authoritative for what candor-ts resolved. When `unresolved` is true (or `Unknown` is
present — a callback value, an `any`-typed callee, resolution landing on a type rather than a
body), the set may be incomplete: read the source for *that* function before relying on it. Never
conclude a function is pure while it is marked unresolved. The literal surfaces (`hosts`/`tables`/
`cmds`/`paths`) are the decidable subset only — absence is never a claim of absence. **And the
curated-classifier caveat cuts the other way:** a call into an npm package the classifier doesn't
cover contributes NOTHING — invisible, not `Unknown`. The scan's receipt now DISCLOSES these by name
(the coverage ledger, marker: `classifier doesn't cover`), so the blind spots are per-scan evidence, not a doc footnote: never conclude
"no effect" through a package that line names (the documented weaker edge of the
never-silently-pure promise, same as every candor engine's curated classifier). Each function ALSO
carries an `invisible` list — the uncovered packages it (transitively) reaches — so `inferred` is
never an unqualified claim PER FUNCTION: `inferred: []` with a non-empty `invisible` means "pure as
far as candor could see, but it could not see through these" (a LOWER bound), not "pure". An uncurated
dependency can opt out of that blind spot by declaring `"candorEffects": ["Net", …]` in its
`package.json` (the §5.1 effect manifest, read declared-not-verified) — its calls then classify to
the declared set instead of contributing nothing.
