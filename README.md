# candor-ts

<p align="center"><img src="https://raw.githubusercontent.com/tombaldwin/candor/main/assets/beaky.svg" alt="Beaky, the candor canary" width="180"></p>

**candor for TypeScript: per-function side effects, transitively, with a deterministic policy
gate.** candor-ts resolves every call through the TypeScript compiler API and reports, for each
function in your project, which effects it can reach — `Net`, `Fs`, `Db`, `Exec`, `Env`, `Clock`,
… — **including effects inherited through any chain of calls across files**, with a disclosed
`Unknown` wherever resolution fails (a callback value, an `any`-typed callee — never silently
pure). A [candor-spec](https://github.com/tombaldwin/candor-spec) implementation, sibling of the
[Rust](https://github.com/tombaldwin/candor-rust) and
[JVM](https://github.com/tombaldwin/candor-java) engines.

**Site:** [candor.poly.io](https://candor.poly.io) — the measured case in five minutes.

```sh
npm install   # typescript + @types/node

node scan.mjs <project-dir>                 # tsconfig.json honored; tests excluded; writes
                                            #   <dir>/.candor/report.json + .callgraph.json
node scan.mjs . --policy .candor/policy     # the §6.2 gate: exit 1 on violation, 2 if unreadable
node scan.mjs . --gate-json gate.json       # + the structured verdict {spec, ok, violations} (§3.3)
CANDOR_BASELINE=saved.json node scan.mjs .  # AS-EFF-005 guard: exit 1 if an existing fn GAINED an
                                            #   effect vs the saved report; 2 if it can't evaluate

node scan.mjs --version                     # installed build + spec contract (offline), + upgrade line

node query.mjs show     .candor/report db.save 1   # a function's effects (match ladder)
node query.mjs where    .candor/report Net 1       # direct sources vs inheritors
node query.mjs callers  .candor/report db.save 1   # the blast radius (transitive callers)
node query.mjs map      .candor/report 1           # module → effects overview
node query.mjs containment .candor/report          # §6.1 boundary-effect dispersion (+ baseline = ratchet)
node query.mjs blindspots  .candor/report          # the Unknown SOURCES, ranked by blast radius
node query.mjs whatif   .candor/report db.save Net policy  # pre-edit gate verdict (exit 1)
node query.mjs diff     .candor/report baseline 1  # per-function effect delta (exit 1 on a gain;
                                                   #   a baseline from a DIFFERENT build ⇒ disclosed ⚠ + exit 0)
```

A checked-in **`.candor/config`** (spec §3.4) replaces the env wiring — `policy arch.policy` /
`baseline <report.json>` / `deps <report paths>` one per line, discovered by walking up from the
scan target; relative values resolve against the config's repo, so CI is "point at the repo". A
configured-but-unusable config/policy/baseline fails loud (exit 2), never silently gateless.

The scan-time **baseline guard** (AS-EFF-005, spec §7) makes effect *regressions* un-shippable:
point `CANDOR_BASELINE` (or the config's `baseline` key) at a saved report, and any existing
function that **gained** an effect fails the scan — exit 1, the records join the `--gate-json`
verdict. New functions are exempt (reviewed as new code, not a regression). The guard is
fail-closed like the policy gate: a present-but-unparseable baseline, or one produced by a
different engine build (§2.1 — an engine upgrade is baseline-invalidating), exits 2 **without
evaluating**; only a genuinely absent file is a one-line note (guard not active). Keep the two
surfaces straight: `query diff` is the read-only comparison — it *discloses* a producing-build
mismatch (⚠, exit 0) and informs; the scan-time guard is the gate-grade fail-closed surface, the
one CI should hold. Semantics mirror the reference engine (candor-java) exactly.

**Staying current:** check your installed version and upgrade — [candor/AGENTS.md §2a](https://github.com/tombaldwin/candor/blob/main/AGENTS.md#2a-staying-current--check-the-version-upgrade). `npx -y candor-ts --version` prints the build, the spec, and the upgrade one-liner (offline; candor never phones home).

Function names are module-qualified with `.` segments (`src.db.save`), so policy scopes read
naturally. A function declared inside a TS `namespace` carries the namespace segments in `fn` and
the callgraph keys (`src.util.Ns.helper`) — so layer policies on namespaces bite — while the §2
`hash` join key keeps the bare local name; builds before 0.8.7 omitted the segments, so crossing
that line invalidates saved baselines (regenerate them). A `pure <scope>` rule forbids every
*effect* but not `Unknown` — the §4 trust marker is uncertainty, not an effect (matching the
reference engine, candor-java); `deny Unknown <scope>` is the explicit knob for boundaries that
must also exclude the unverifiable case.

```text
# .candor/policy
deny Net domain                       # the domain layer reaches no network, even through helpers
pure  parse                           # parsing is effect-free
allow Db in db  orders audit_log      # the db layer touches ONLY these tables
allow Net in billing api.stripe.com   # billing talks ONLY to Stripe
forbid domain -> infra                # the domain layer must not depend on infra
```

The report carries the four **literal surfaces** where a declaration makes them decidable —
`hosts` at `Net` calls, `tables` at `Db` calls (SQL table positions, mirroring the Rust/JVM
extractors exactly, **plus TypeORM's `@Entity("user")` declarations** read through the receiver's
`Repository<T>` type argument), `cmds` at `Exec`, path-shaped `paths` at `Fs` — never from a
runtime-computed value, propagated transitively, enforced by the `allow` rules above. On a real
Nest app this makes table-level policy live: `allow Db in article.service article comments` flags
the service reaching `user` and `follows`.

**The classifier** is curated (the same under-report-and-say-so posture as the other engines): the
Node builtins (`fs`, `net`/`http`/`tls`, `dns`, `child_process`, `worker_threads`, `node:sqlite`,
`node:vm`, `process.env`, the clock), the HTTP/queue/mail tier (axios/got/node-fetch/undici/ws/
socket.io/nodemailer, gaxios + googleapis-common + google-auth-library, stripe, @sentry/*,
posthog-node, bull/bullmq), the database drivers (pg/mysql2/mongodb/redis/ioredis/sqlite3/
better-sqlite3/knex) **and the ORM tier** (TypeORM — with `@Entity("…")` table extraction —
Prisma, Mongoose, Sequelize, drizzle-orm), plus execa/cross-spawn/shelljs/open, fs-extra/
graceful-fs/rimraf/glob/chokidar, dotenv, winston/pino/bunyan. An unlisted package contributes
nothing — candor never guesses an effect — but the scan **names it**: the receipt's coverage-ledger
line (marker: `classifier doesn't cover`) lists every package the code demonstrably calls that
candor's classifier neither classifies nor has reviewed-pure, and each function carries the
`invisible` list it (transitively) reaches.

## MCP server — candor as agent ground truth

`candor-ts-mcp` exposes the read-only queries as an [MCP](https://modelcontextprotocol.io) server, so
a coding agent can ask **"if I change this, what's the runtime blast radius?"** or **"what reaches the
network?"** and get deterministic ground truth from a precomputed report — instead of burning tokens
tracing the call graph by hand (the measured ~700–2000× token win on blast-radius questions).

```jsonc
// in an MCP client config — point it at a report you've already scanned
{ "command": "npx", "args": ["-y", "candor-ts-mcp"],
  "env": { "CANDOR_REPORT": ".candor/report.myPkg.scan" } }
```

Tools: `candor_impact` (backward blast radius), `candor_reachable` (what runs at runtime),
`candor_where` (effect surface), `candor_path` (how an effect is reached), `candor_callers`,
`candor_show`, `candor_map`, `candor_containment`, `candor_blindspots`, `candor_whatif` (pre-edit
gate check — a given-but-unreadable policy is a loud error, never a clean verdict), `candor_gate`
(the checked-in `.candor/config` policy verdict), `candor_diff`/`candor_gains` (baseline deltas).
Each takes an optional `report` prefix (else `$CANDOR_REPORT`); `--root <dir>` locks the server to
one workspace. The server is **query-only** — it never scans (the analyzer self-boundary, spec
§7.12: an agent or a hook produces the report; the server reads it, Fs only). The query logic is
the shared `query-core.mjs`, the same answers the CLI gives.

**`candor-lsp`** renders the same report where the code is, for any LSP-native editor (helix,
neovim; the JetBrains plugin bundles it): a CodeLens per effectful function (`⚡ Db, Net · blast
radius 12`), hover provenance (the hop chain to where an inherited effect is performed), and the
repo's policy verdict as diagnostics. Like the MCP server it is a pure report consumer — any
engine's report — and never scans. (Both report-computed gates are advisory: the engine's own
`--gate-json` run additionally fails masked/incomplete literal surfaces and is the authoritative
CI form.)

It also answers the pre-edit question in place: inside a function, a code action per boundary
effect the fn doesn't yet perform — `candor: what if handler performed Net?` — runs the same
whatif as `candor-ts-query whatif`/`candor_whatif` (blast radius + the policy rule that WOULD
fire) and shows the verdict as a message plus a transient diagnostic at the function (cleared on
the file's next open/save; with no policy discovered it says so and reports the radius alone).
Plain `textDocument/codeAction` + `workspace/executeCommand` (`candor.whatif`) — it works
unmodified in helix, neovim, VS Code, and JetBrains via LSP4IJ.

**The live loop** — `candor-ts-watch` keeps the report fresh as the agent edits, so the answers are
about the *current* code, not a stale snapshot:

```sh
candor-ts-watch ./src --out .candor/report   # re-scans only when a tracked source actually changes
```

It tracks the project's sources by content hash and re-scans on a real change (a no-op save or an
unrelated write does nothing), writing the same prefix the MCP server reads. So: **agent edits →
watcher refreshes the report → agent asks `candor_impact` and gets the post-edit answer.** And it
reports the **edit-delta** — not just that the report is fresh but *what the edit did* to the effect
surface (`re-scanned (1 changed: app.ts) — Δ f +Net`), so the agent learns the consequence of its
own change. v1 runs a full (sound) scan per change; the deeper *perf* optimisation — re-analysing
only the changed file's subgraph instead of the whole project — is the staged next step (the
content-hash gate is its first increment).

## Trust contract (spec §4)

Anything candor-ts can't resolve is `Unknown`, never silently pure: a function-valued parameter or
field being called, an `any`-typed callee, resolution landing on a type rather than a body.

An **uncurated dependency** can opt out of `Unknown`/silent-pure by **declaring its effects** in its
`package.json` — `"candorEffects": ["Net"]` (spec §5.1, the effect manifest). candor-ts reads it as
the declared-not-verified tier: the package's calls classify to the declared set, and it stops being
a coverage-ledger blind spot. A name outside the §1 vocabulary voids the declaration loudly (a typo must not
silently narrow a surface). And `candor-ts-query gains <cur> <base>` flags the **supply-chain**
delta — the effects a surface *gained* between two reports.
Real-world consequence, measured on [rimraf](https://github.com/isaacs/rimraf) (50 files, 55
functions analyzed): its DI-style fs injection means many functions read `Unknown`, disclosed —
that's the contract working, not noise. The report says "can reach", never "does"; an absent
literal is never a claim of absence.

## Cross-engine consistency — machine-checked

candor-ts is one of the **four code engines** (with the reference engine candor-java, the Rust
engines, and candor-swift) held together by the spec's **16-part conformance suite**: the shared
effect-set oracle, the §6.2 policy-grammar battery (including `allow Db`), the §3.1 query-shape
and match-ladder checks, the gate exit-code contracts, and the newer parts up through the
pure-vs-Unknown ruling (PART 16) — the engines must answer identically, on every push to the spec.

## What the analysis core implements (and where the spec told it how)

| Piece | Spec source |
|---|---|
| Resolve every call via the compiler API (`getResolvedSignature`), never syntax | CLASSIFIER §1 |
| The classifier maps the resolved target's module (`node:fs`→Fs, `node:net`→Net, …) | CLASSIFIER §2, TS notes |
| `process.env` property read → Env; `Date.now` → Clock | SPEC §1 |
| Local edges (cross-file) + least-fixpoint propagation | SEMANTICS §5a |
| Closure bodies attribute to the nearest enclosing function | SEMANTICS §2 |
| A call resolving to a *type* (function-typed field/param) → `Unknown`, never silent-pure | SPEC §4 |
| Unmatched external calls contribute nothing (curated-classifier caveat) | SEMANTICS §8 C1 |
| The literal surfaces `hosts`/`cmds`/`paths`/`tables`, literal-read only | SPEC §2 |
| `{ candor: { version, toolchain, spec: "0.13" }, functions }` envelope; pure fns omitted | SPEC §2/§2.1 |
| Call-graph sidecar with **every** analyzed function a key | SPEC §2.2 |
| The gate: AS-EFF-006 / 008 / 009, loud on an unreadable policy | SPEC §6.2 |

## Origin: the derivability proof

This engine began as a deliberately minimal single-file slice written **from the spec documents
alone** (SPEC.md, SEMANTICS.md, CLASSIFIER.md) — without consulting the Rust or JVM sources — to
answer executably: *is the spec enough to derive a new-language implementation?* **Yes — 20/20** on
the shared oracle. That clean-room claim is frozen at commit `a29b152`; everything since
(multi-file projects, the query surface, the gate, the literal surfaces) is spec-implemented but
post-hoc, and its guarantee is the conformance differential above, not clean-room provenance. The
one engine-fix the original derivation needed (a call landing on a function-*type* declaration read
as pure until §4 was applied to it) remains the proof point: the fix was "do what §4 says", not "go
read the Rust source".

## Status

0.13.x, speaking candor-spec 0.13: the analysis core, the gate (`--policy` / `--gate-json` /
`.candor/config`), the full §3.1 query surface (including `containment`, `blindspots`, the
`--include-unknown` dispatch frontier), the MCP server, the LSP server, and the watch loop are
real, behaviorally tested (`npm test` — the behavioral suite across six harnesses), **soundness-fuzzed
with verified teeth** (`node fuzz.mjs` — spec §7.13: generated effect chains through every encoded
call form, any silent-pure = red), and conformance-held against the Rust/JVM/Swift engines. The
npm classifier tier is deliberately curated and keeps growing case-by-case. Entry points
(Nest/Next populations), `unknownWhy` origins, `reachable`, cross-package inheritance
(`CANDOR_DEPS` + the spec §2 `hash`, version-trusted per §2.1), and `--allow-js` are all in.
On npm: `npx -y candor-ts <dir>`. Per-release detail (⚠ marks report/verdict-affecting changes):
[CHANGELOG.md](CHANGELOG.md).

## Development

No build step — the engine runs on Node directly.

```sh
npm install
npm test            # the full CI gate: lint + unit (node:test) + behavioural + MCP + watch + the
                    # fabrication probe + the §7.13 soundness fuzzer
npm run test:unit   # just the native unit tests — the query algebra + policy DSL + the scan-core
                    # classifier/literal leaves (query-core / policy / scan-core)
npm run lint        # eslint (the recommended ruleset; the CI lint gate)
node scan.mjs <dir | file.ts | tsconfig.json> --out .candor/report   # scan a project
```

The pure cores are factored into importable modules — `query-core.mjs` (the §3.1 queries),
`policy.mjs` (the §6.2 DSL + literal matchers), and `scan-core.mjs` (the classifier + the SQL/
command/host extractors) — so they're unit-tested directly; the TS-compiler-driven walk stays in `scan.mjs`.
