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
