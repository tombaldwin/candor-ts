# candor-ts — the derivability proof

<p align="center"><img src="https://raw.githubusercontent.com/tombaldwin/candor/main/assets/beaky.svg" alt="Beaky, the candor canary" width="180"></p>

A **minimal TypeScript implementation slice** of [candor-spec](../candor-spec) 0.3, written **from the
spec documents alone** (SPEC.md, SEMANTICS.md, CLASSIFIER.md) to answer one question executably:

> *Is the spec enough to derive a new-language implementation?*

**Yes — 20/20.** This engine passes the *same* `conformance/expected.json` oracle the Rust
(candor-scan) and JVM (candor-java) engines answer to, including the corners: the Unknown trust
contract, closure attribution, transitive propagation/recursion, method receivers, and scheduler
attribution.

The candor family in five minutes: [candor.poly.io](https://candor.poly.io).

## Beyond the proof slice: the query surface + the policy grammar

`query.mjs` adds the SPEC §3.1 read-only queries and the §6.2 policy grammar over scan.mjs's report:

```sh
node scan.mjs Cases.ts out
node query.mjs show     out act 1            # match ladder: exact > segment-suffix > substring
node query.mjs where    out Fs 1             # {effect, directly, inherited}
node query.mjs callers  out transitive_leaf 1  # {of, direct, transitive} — the blast radius
node query.mjs map      out 1                # {module: {effects, functions}}
node query.mjs whatif   out leaf Net policy  # pre-edit gate verdict (exit 1 on violation)
node query.mjs parsepolicy policy            # the canonical §6.2 dump the conformance suite diffs
```

The scanner also captures the SPEC §2 **literal surfaces** where a string literal makes them
decidable — `hosts` at a classified `Net` call, `tables` (table-position identifiers, mirroring the
Rust/JVM extractors exactly) at a classified `Db` call (`node:sqlite`, pg, sqlite3, mysql2) — never
from a runtime-computed value, propagated transitively like effects, gated by `allow Net`/`allow Db`.

These run live in the spec's conformance CI as the **third engine in three differentials**: the
effect-set oracle (Part 6), the policy-DSL grammar battery (Part 4 — including `allow Db` tables),
and the query-shape/match-ladder checks (Part 5).

**Provenance, honestly:** `scan.mjs` was written from the spec documents alone — the clean-room
derivability proof, and that claim is frozen there. `query.mjs` came later, implemented from the
same spec text but by an author who had by then read the reference engines; its ongoing guarantee
is the conformance differential, not clean-room provenance.

```sh
npm install
node scan.mjs Cases.ts out
node check.mjs out.json ../candor-spec/conformance/expected.json
```

## What it implements (and where the spec told it how)

| Piece | Spec source |
|---|---|
| Resolve every call via the compiler API (`getResolvedSignature`), never syntax | CLASSIFIER §1 |
| κ classifies the resolved target's module (`node:fs`→Fs, `node:net`→Net, `child_process`→Exec, …) | CLASSIFIER §2, TS notes |
| `process.env` property read → Env; `Date.now` → Clock | SPEC §1 |
| Local edges + least-fixpoint propagation | SEMANTICS §5a |
| Closure bodies attribute to the nearest enclosing function | SEMANTICS §2 |
| A call resolving to a *type* (function-typed field/param) → `Unknown`, never silent-pure | SPEC §4 |
| Unmatched external calls contribute nothing (curated-κ caveat) | SEMANTICS §8 C1 |
| `{ candor: { version, toolchain, spec: "0.3" }, functions }` envelope; pure fns omitted | SPEC §2/§2.1 |
| Call-graph sidecar with **every** analyzed function a key | SPEC §2.2 |

## What it deliberately is not

A product. No queries/tools (§3.1–3.2), no policy gate (§6.2), no capabilities (§5), a single-file κ.
All of those are now specified precisely enough to add (the policy grammar and query shapes were made
normative + executable exactly because this derivation exercise found them missing) — but the slice's
job was to prove the *analysis core and wire format* derive cleanly, and it does.

The one engine-fix the derivation needed (a call landing on a function-*type* declaration read as
pure until §4 was applied to it) is itself evidence the spec's trust contract carries the load: the
fix was "do what §4 says", not "go read the Rust source".
