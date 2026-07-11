# candor-ts — HOF receiver-type precision (scope)

_Scoping doc from the 2026-07-11 spec-0.9 dogfood (see candor umbrella BACKLOG). Status: **scoped, not
started.** Deliberately narrow + soundness-bounded._

## The finding (precise diagnosis, with evidence)

Dogfooding `candor-ts@0.9.0` on `zx` surfaced `util.bufArrJoin` marked **Unknown** (`callback:arr.reduce`)
though it is **genuinely pure**:

```ts
export const bufArrJoin = (arr: TSpawnStore[keyof TSpawnStore]): string =>
  arr.reduce((acc, buf) => acc + bufToString(buf), '')   // bufToString is a local pure fn
```

candor-ts **already** resolves array higher-order builtins correctly — the gap is *receiver-type recognition*,
not callback handling. Discriminating fixtures (`scratchpad/hof-recon`) pin it exactly:

| receiver type | callback | verdict | correct? |
|---|---|---|---|
| `number[]` | calls a fn (`bufToString`) | **PURE** | ✓ candor already resolves array HOFs incl. calling callbacks |
| `any` | trivial (`a+b`) | **Unknown** | ✓ **SOUND** — can't prove `any.reduce` is `Array.prototype.reduce` |
| `any` | calls a fn | **Unknown** | ✓ **SOUND** |
| `TSpawnStore[keyof TSpawnStore]` (→ `Buffer[]`, imported) | calls a fn | **Unknown** | ✗ **precision miss** — the type *is* provably an array |

So the trigger is: **the receiver's type does not syntactically read as an array**, even when a full
type-checker would prove it is one. `arr.reduce`/`.map`/`.filter`/… on such a receiver is treated as an
unresolved method dispatch → `callback:` Unknown.

## The soundness line (non-negotiable)

candor's cardinal sin is the silent under-report. `arr.reduce` may only be treated as the pure
`Array.prototype.reduce` when the receiver is **provably** an array — otherwise a custom object with an
effectful `reduce` would be silently marked pure. Therefore:

- **`any` / `unknown` / unconstrained-generic receiver → stays `Unknown`.** No heuristic "reduce is probably
  array-reduce." This is correct today and MUST NOT change.
- Only **provably-array** type-forms may be resolved.

The fix is entirely about widening the *provably-array* recognizer — never about guessing.

## Scope of the change (candor-ts only)

Extend candor-ts's "is this receiver an Array?" check (the light local type inference) to recognize array-ness
through more type-forms, resolving to the concrete element type so the HOF callback is analyzed (as it already
is for `number[]`):

1. **Indexed-access types** — `T[K]` / `T[keyof T]` where every constituent value type is an array (the
   `bufArrJoin` case). Requires resolving `T` (possibly imported) and its property value types.
2. **Imported type aliases / interfaces** — resolve the alias across the module import to its underlying form
   before deciding array-ness (candor-ts already resolves imports for call targets; reuse that).
3. **Unions of arrays** — `A[] | B[]` → array (element type `A | B`).
4. **Named array-like aliases** — `type Bufs = Buffer[]`.

Each is a *sound widening*: it only ever turns an unprovable-Unknown into a proven-pure/effect when the type
genuinely resolves to an array. Anything that doesn't resolve stays Unknown.

## Honest impact — this is the SMALLER lever

On the `zx` scan the array-HOF-on-complex-type case was **3 of 82** Unknowns. The **dominant** `unverified`
noise was **external lib-method Unknowns (54)** — `callback:chalk.grey` and friends: calls into untyped/
external deps candor-ts can't see. If the goal is improving the `unverified`/disclosure *signal*, that bucket
is the bigger win and a **separate thread** (options: κ-style disclosed-invisible for external deps like
candor-scan does, or a curated pure-lib table). This doc scopes the array-HOF item Tom asked for; it should be
weighed against that larger lever.

## NOT a cross-engine / spec change

- TS-specific type-form (indexed-access etc.); candor-scan already resolves Rust iterator closures, and no
  **shared** conformance fixture exercises this pattern — so improving candor-ts here does **not** diverge it
  from the other engines on the pinned contract. No spec bump, no four-engine coordination.
- It **does** change candor-ts report bytes (`bufArrJoin`: Unknown → pure) and therefore gate verdicts under
  `deny Unknown` → **baseline-invalidating (⚠)** → a candor-ts report-affecting release (e.g. 0.9.x with a ⚠
  CHANGELOG entry + a baseline regen note). Tier-1 in effect, but candor-ts-local (the shared floor is
  unaffected because the pattern isn't in the shared fixtures).

## Implementation sketch

- Locate the array-receiver test in `scan.mjs`/`scan-core.mjs` (the site that emits `callback:<recv>.<method>`
  for unresolved HOF dispatch on a non-array receiver).
- Before falling back to `callback:` Unknown, run the widened array-resolver on the receiver's inferred type;
  on success, treat the call as the pure Array HOF and analyze the callback body (existing path).
- Guardrail: the resolver must return array-ness only on a *proof*; any unresolved constituent → not-array →
  Unknown (unchanged).

## Test plan

- Unit: the `hof-recon/discriminate.ts` matrix as a fixture — assert `arrCall` pure (regression), `any`-receiver
  cases **stay Unknown** (the soundness guard — this is the important one), indexed-access/imported/union
  array receivers become pure.
- Measure: re-scan `zx` and confirm the 3 array-HOF Unknowns clear and **nothing that should be Unknown
  flips** (diff the report; watch the effectful set doesn't shrink anywhere it shouldn't).
- Add a candor-ts-local baseline-invalidation note; conformance suite unchanged (no shared fixture touched).

## Effort & recommendation

- **Effort:** small–medium. The widening is bounded, but indexed-access + cross-import type resolution is real
  type-level work and risks creeping toward reimplementing tsc's type system — keep it to the enumerated,
  provable forms and stop.
- **Recommendation:** worthwhile as a *correctness-of-precision* polish, but **low ROI in isolation** (3/82 on
  zx). Best done **together with, or after, the external-lib-method thread** (the 54-bucket) — that pair is
  what actually lifts the `unverified` signal on real TS code. If picking one, do the external-lib lever first.

---

# The external-lib lever (the bigger, 54-bucket)

## The finding (recon evidence)

candor-ts discloses a call into an **uncovered external package** in **two different ways depending on the
call's syntactic shape** — the inconsistency is the defect:

| call shape | example | disclosure | evidence |
|---|---|---|---|
| **named-import call** | `import {grey} from 'chalk'; grey(x)` | **κ-invisible** (named in the κ ledger, reads pure-disclosed) | `extlib-recon/mylib`: `writeLog`(Fs)+`grey` both read pure, stderr `κ doesn't know 1 package: mylib` |
| **member access on a namespace import** | `import chalk from 'chalk'; chalk.grey(x)` | **per-call `callback:chalk.grey` Unknown** | zx: 54 of 82 Unknowns are this shape |

Same underlying fact — "chalk is an uncovered package" — surfaced two ways. candor's intended model (the
`INVISIBLE (not Unknown)` κ language + the *disclosed syntactic floor* profile) is that an **uncovered-package
call is κ-invisible**, while **Unknown is reserved for unresolvable in-*code* dispatch** (fn values, dynamic
member on an unknown-typed receiver). By that model `chalk.grey` is *misclassified*: it's an uncovered-package
call wearing an in-code-dispatch (`callback:`) marker. Mechanism: `scan-core.mjs` `kappa(module, member)` +
the κ-invisible fallback resolve the named-import arm to the package; the member-access arm doesn't route
`chalk.grey` back to "chalk is an uncovered package," so it falls to `callback:` Unknown.

## Options

1. **Route member-access-on-uncovered-package into the κ channel (recommended).** `chalk.grey` → κ-invisible
   (name chalk in the ledger), same as the named-import shape. Removes the 54 from Unknown, keeps disclosure
   (κ ledger), and **converges candor-ts with candor-scan's κ-for-deps**. It's the *same soundness posture*
   candor-ts already applies to named-import dep calls — a consistency alignment, not a new relaxation.
2. **Chaining (`CANDOR_DEPS`, existing feature) — full fidelity.** Scan the dep, chain its report, resolve the
   *real* effect (chalk→pure, an ORM→Db). Conformance-pinned (PART 14) **for named-imports**; member-access
   chaining likely has the same split and **needs verifying**. This is the right answer for a user who wants
   true dep effects; orthogonal to (1) and worth a docs push ("chain your deps") regardless.
3. **Curate chalk-et-al as pure in the κ table — REJECT as the primary path.** The `scan-core.mjs:131` argon2
   precedent (a curated-κ entry made `argon2.hash` **silently pure** on a real Nest app) shows every
   curated-*pure* row is an unverified purity CLAIM and a silent-under-report generator. κ-*invisible*
   (option 1, names the dep in the ledger) is honest-disclosed; κ-*curated-pure* is dangerous. Don't conflate.

## The posture decision — RESOLVED: κ-invisible (2026-07-11)

Framed initially as an open posture choice, but the evidence settled it: **candor-ts already committed to
invisible-not-Unknown for deps, in its shipped docs**, so this is a bug against a decided contract, not a new
choice:
- `AGENTS.md:144/184` — "an effect through an unlisted package is **invisible, not `Unknown`**."
- `AGENTS.md:188-189` — each function carries a **per-function `invisible` list** of the κ-unknown packages it
  reaches; `inferred: []` + non-empty `invisible` = "pure as far as candor can see." So the disclosure is
  **trackable per function**, not merely an aggregate ledger — the "κ is too quiet" worry is void.
- `README.md:83` — "the same under-report-and-say-so posture as the other engines" (the family posture).

Proof of the bug (before/after): a named-import call `grey(x)` → `inferred:[] invisible:['mylib']` (honors the
contract); a member-access call `chalk.grey(x)` → `inferred:['Unknown'] invisible:None unknownWhy:[callback:chalk.grey]`
(violates it). So the member-access arm emits Unknown **instead of** populating `invisible`.

The §4-strict alternative (make every unseeable dep call Unknown, incl. named-imports) is rejected: it would
*contradict* candor-ts's shipped contract and *diverge* it from candor-scan/the family. The argon2 caveat
(`scan-core.mjs:131`) is a **separate axis** — curated-*coverage* precision ("model the member," not drop
coverage) — not the invisible-vs-Unknown question. Unknown stays reserved for genuine in-code unresolvable
dispatch (`dispatch:`, `callback:param#0`) — the real ports `unverified` should surface.

Cross-engine: option 1 converges candor-ts toward candor-scan; the κ-ledger conformance (PART 4c) still holds
(chalk is named either way). Report-affecting (member-access fns: Unknown → pure+κ) → **baseline-invalidating
⚠**, candor-ts-local.

---

# Comparison & recommendation

| | **Array-HOF** (receiver-type) | **External-lib** (κ consistency) |
|---|---|---|
| zx impact | **3 / 82** Unknowns | **54 / 82** Unknowns |
| root cause | indexed-access/imported array types not recognized as arrays | member-access on uncovered pkg → Unknown instead of κ |
| fix shape | widen the array-type recognizer (type-level work) | route member-access into the existing κ channel (attribution) |
| soundness | pure widening; only *provable* arrays; `any`/opaque stays Unknown | consistency alignment; same posture as named-import κ; disclosed |
| main risk | creep toward reimplementing tsc's type system | trades Unknown → κ-invisible (weaker, but disclosed); posture call |
| effort | small–medium | small (attribution) + optional chaining verification |
| cross-engine | candor-ts-only, no spec impact | **converges** candor-ts toward candor-scan; κ-ledger contract holds |
| character | *more precise* (Unknown → proven) | *more consistent* (one dep-disclosure channel) |

**Recommendation: do the external-lib κ-consistency fix first.** It clears ~18× the real-world Unknown noise
of the HOF item (54 vs 3), is small, fixes a genuine same-dep-two-disclosures inconsistency, and converges
candor-ts with candor-scan. Then the array-HOF item as follow-on precision polish. Keep the **chaining docs
push** in mind as the orthogonal full-fidelity path. The one thing to settle before coding the external-lib
fix is the **posture** (κ-invisible vs §4-Unknown for deps) — that's a decision, not a discovery.
