# candor-ts

<p align="center"><img src="https://raw.githubusercontent.com/tombaldwin/candor/main/assets/beaky.svg" alt="Beaky, the candor canary" width="180"></p>

**candor for TypeScript: per-function side effects, transitively, with a deterministic policy
gate.** candor-ts resolves every call through the TypeScript compiler API and reports, for each
function in your project, which effects it can reach — `Net`, `Fs`, `Db`, `Exec`, `Env`, `Clock`,
… — **including effects inherited through any chain of calls across files**, with an honest
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

node query.mjs show     .candor/report db.save 1   # a function's effects (match ladder)
node query.mjs where    .candor/report Net 1       # direct sources vs inheritors
node query.mjs callers  .candor/report db.save 1   # the blast radius (transitive callers)
node query.mjs map      .candor/report 1           # module → effects overview
node query.mjs whatif   .candor/report db.save Net policy  # pre-edit gate verdict (exit 1)
node query.mjs diff     .candor/report baseline 1  # per-function effect delta (exit 1 on a gain)
```

Function names are module-qualified with `.` segments (`src.db.save`), so policy scopes read
naturally:

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
Node builtins (`fs`, `net`/`http`/`tls`, `child_process`, `node:sqlite`, `process.env`, the clock)
plus a small npm tier (axios/got/node-fetch/undici/ws, pg/mysql2/mongodb/redis/knex,
execa/cross-spawn, fs-extra/rimraf/glob, dotenv, winston/pino). An unlisted package contributes
nothing — candor never guesses an effect.

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
`candor_show`, `candor_map`, `candor_whatif` (pre-edit gate check). Each takes an optional `report`
prefix (else `$CANDOR_REPORT`). The server is **query-only** — it never scans (the analyzer
self-boundary, spec §7.12: an agent or a hook produces the report; the server reads it, Fs only). The
query logic is the shared `query-core.mjs`, the same answers the CLI gives.

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
Real-world consequence, measured on [rimraf](https://github.com/isaacs/rimraf) (50 files, 55
functions analyzed): its DI-style fs injection means many functions honestly read `Unknown` —
that's the contract working, not noise. The report says "can reach", never "does"; an absent
literal is never a claim of absence.

## Cross-engine consistency — machine-checked

candor-ts runs live in the spec's conformance CI as the third engine in **three differentials**:
the effect-set oracle (20 shared cases), the §6.2 policy-grammar battery (including `allow Db`),
and the §3.1 query-shape and match-ladder checks — all three engines must answer identically, on
every push to the spec.

## What the analysis core implements (and where the spec told it how)

| Piece | Spec source |
|---|---|
| Resolve every call via the compiler API (`getResolvedSignature`), never syntax | CLASSIFIER §1 |
| κ classifies the resolved target's module (`node:fs`→Fs, `node:net`→Net, …) | CLASSIFIER §2, TS notes |
| `process.env` property read → Env; `Date.now` → Clock | SPEC §1 |
| Local edges (cross-file) + least-fixpoint propagation | SEMANTICS §5a |
| Closure bodies attribute to the nearest enclosing function | SEMANTICS §2 |
| A call resolving to a *type* (function-typed field/param) → `Unknown`, never silent-pure | SPEC §4 |
| Unmatched external calls contribute nothing (curated-κ caveat) | SEMANTICS §8 C1 |
| The literal surfaces `hosts`/`cmds`/`paths`/`tables`, literal-read only | SPEC §2 |
| `{ candor: { version, toolchain, spec: "0.4" }, functions }` envelope; pure fns omitted | SPEC §2/§2.1 |
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

Young product (0.1.x): the analysis core, the gate, and the query surface are real,
behaviorally tested (`node test.mjs`), **soundness-fuzzed with verified teeth** (`node fuzz.mjs` —
spec §7.13: generated effect chains through every encoded call form, any silent-pure = red), and
conformance-held. The npm classifier tier is
deliberately curated and will keep growing case-by-case. Entry points (Nest/Next populations),
`unknownWhy` origins, `reachable`, cross-package inheritance (`CANDOR_DEPS` + the spec §2 `hash`,
version-trusted per §2.1), and `--allow-js` are all in. On npm: `npx -y candor-ts <dir>`.
