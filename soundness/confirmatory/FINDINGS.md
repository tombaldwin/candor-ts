# Node confirmatory arm — flag adjudication (verified 2026-07-21)

The frozen held-out run flagged three packages `VIOLATION` (`node-tar`, `get-port`, `proper-lockfile`).
Each was traced to source against the frozen `0.23.1` engine. **All three are oracle-side artifacts, not
classifier false all-clears** — but they arise from *three distinct* mechanisms, and the "safe direction"
claim holds only because each was traced (a silent under-report can be *displaced* onto a dismissible
container flag, so blanket dismissal without per-flag tracing would itself be unsound).

The load-bearing property that makes all three over-flags (never hidden under-reports): the oracle's
per-frame check is **additive** — charging or synthesising an extra frame can only turn *that* frame red; it
never removes a charge from a genuinely-analysed frame, whose own frame is still mapped and checked. So a real
under-report in an analysed function is still flagged through that function's own frame.

## 1. `get-port` — harness effect charged to a test-file frame
Flagged frame: `test.<module>`, observed `{Fs,Net}`, declared `{Net}`. Verified: `index.js` (the whole
library) imports only `node:net`/`node:os` — **zero `Fs`** (line-by-line). The escaped `Fs` is the `ava`
harness writing snapshot/reporter files, charged to the *test file's* module frame because the test file was
in the scanned set. Fix belongs to the protocol: **scan library sources only**, never test files.

## 2. `proper-lockfile` — effect charged outside the frame's dynamic extent
Flagged frame: `index.<module>`, observed `{Fs}`, declared `∅`. Verified: `index.js` is a pure re-export
barrel — its module top-level runs only `require`s, function *declarations*, and `module.exports`
assignments; **zero `Fs` at module-init time**. The `Fs` fires later, inside `lib/lockfile` during `lock()`
*calls* (all correctly `Unknown`-disclosed via `options.fs.*`), which are **outside the module-init frame's
dynamic extent**. candor correctly inferred `index.<module>` pure; the oracle mis-charged a
later-firing effect to it.

## 3. `node-tar` — oracle synthesised a frame candor never analysed
Flagged frame: `WriteEntrySync.constructor`, observed `{Env,Fs}`, declared `∅`. `new WriteEntrySync()`
*genuinely* performs `Env` (the base `WriteEntry` constructor reads `process.getuid`/`process.env.USER`/
`process.cwd()`) and `Fs` (its `super()` calls `this[LSTAT]()`, which dispatches to the sync override
`fs.lstatSync`). **But candor-ts `0.23.1` emits no `WriteEntrySync.constructor` function row at all** —
verified by scanning the frozen `tar@6.2.1` package directly: only the *methods* (`[LSTAT]`/`[OPENFILE]`/
`[READ]`/`[CLOSE]`) are emitted, each correctly `['Fs','Unknown']`; there is no constructor row, and the
construction path is `Unknown`-disclosed at call sites (`pack.<module>` escapes `Env` via
`callback:this[WRITEENTRYCLASS]`). So the `inferred: []` in the verify.json is **the oracle defaulting an
un-emitted frame to pure**, not a classifier claim. No candor signature is violated.

## The oracle bug (reported, not fixed under freeze) — two sub-forms
`verify-core.attribute()`:
- **(a) out-of-extent / non-library charging** — charges an effect to a container frame (`<module>`) whose
  true dynamic extent does not include the effect, or to a test-file frame (get-port, proper-lockfile).
- **(b) synthetic-frame defaulting** — materialises a runtime frame candor never emitted as an analysed
  function (an implicit/aggregate constructor) and defaults its signature to pure `∅`, then checks it
  (node-tar). The sound behaviour is to attribute such a frame to its **nearest analysed ancestor** (the
  §3.4 collapse the JVM arm already does), never to invent a pure signature.

Both are **over-flag only** (safe direction). The fix is: scan library sources only; and attribute
un-analysed runtime frames to the nearest analysed ancestor rather than defaulting them pure.

## Residual coverage question (A0), surfaced not resolved
node-tar shows candor emits no constructor row for these classes. The construction path *is*
`Unknown`-disclosed at the call sites exercised here, so no under-report surfaced — but whether every
`new X()` caller is charged the constructor's *direct* effects (e.g. the base constructor's `Env`) or
discloses `Unknown` is a coverage question this run raises and does not settle. Future work, stated as such.
