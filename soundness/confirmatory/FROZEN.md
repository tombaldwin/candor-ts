# FROZEN pre-registration — the Node/TypeScript confirmatory arm

This is the Node/TS confirmatory arm of candor's honesty-invariant falsifier, the sibling of the JVM arm
(`~/git/candor-java/eval/corpus-confirmatory`, the reference engine, strongest oracle) and the Rust/Swift
syscall arms (`~/git/candor-{rust,swift}/soundness/confirmatory`). It pins **everything** — manifest,
classifier, and oracle — in one commit *before* the run. The commit that adds this directory is the
pre-registration timestamp; the run executes against exactly the artifact hashed below and reports whatever
it finds. No classifier change and no manifest edit rides along; **a violation is REPORTED, not fixed**.

## The honesty invariant (H) this arm falsifies

Each analyzed function gets an inferred signature `(S, D)` = (determined effect set, disclosure set). H, per
EXECUTED function `f`:

> `observed(f) ⊆ S(f)`   **OR**   `Unknown ∈ D(f)`

The **cardinal sin is a false all-clear**: a function that RAN an effect at runtime which its *complete*
(`D = ∅`) signature omitted. Over-disclosure (marking `Unknown`) is a **PASS**, never a sin — a
disclosed-partial verdict is by-design acceptable. The falsifiable frames are the **sound-complete** ones
(`D = ∅`); a corpus that discloses `Unknown` everywhere cannot falsify H (its check is vacuous — see
"Where this arm lands", below).

## What is frozen (all as of this commit)

- **Engine (classifier + oracle), frozen by source hash.** candor-ts is a set of `.mjs` modules, not a
  compiled jar, so the "frozen binary" is the **sha256 of the concatenated engine sources**
  `27b0fe3901bea6aa47ebf80bb9e8665594843dbd0cc98fdbc958e88bf5753293` over
  `scan.mjs scan-core.mjs query-core.mjs policy.mjs surface.mjs verify.mjs verify-core.mjs
  verify-preload.mjs verify-emit.mjs verify-loader.mjs verify-syscall.mjs`, at source commit
  `13e760fefca7cabb6b9f462f64d9843853d110d8` (candor-ts **0.23.1**, spec floor 0.23). `run_frozen.sh`
  **aborts** if the sources on the runner do not hash to this value — the freeze is machine-enforced, not
  asserted.
- **Corpus:** the 8 rows of `manifest.tsv` as of this commit — the complete set, *including* the rows that
  clone/install-fail, exercise no in-scope effect, or go vacuous. Every one gets a disposition row; attrition
  is tabulated, not narrated.
- **Effect scope:** `--scope all` (Fs/Net/Exec + Env/Clock/Rand/Llm/Db/Ipc/Clipboard/Log — everything the
  language-level Node preload witnesses at the entry-point boundary).
- **Acceptance criterion:** zero *undisclosed* violations on executed paths. A disclosed-partial verdict is a
  pass. A violation is reported (with the function + the escaped effect), not repaired.

## Held-out justification (why this is confirmatory, not developmental)

The corpus **excludes every package used to develop / calibrate / A-B candor-ts**, so the classifier has not
been tuned against it:

- **The `eval/sweep.sh` calibration set** (the TS analog of the Rust 1,294-crate calibration):
  `rimraf, execa, got, ky, zod, p-queue, globby, del, conf, nanoid, commander, chalk`.
- **The corpus-round drivers** recorded in the `candor-ts-corpus` note (the runs that *drove classifier
  fixes* — the `@types/pg`→`pg` mapping fix, the `node:vm`/`require(dynamic)` Unknown fixes, etc.):
  `prisma, pg, axios, ioredis`.

Every package in `manifest.tsv` is a fresh repo, cloned at a release tag, that the classifier was never
tuned against. This over-samples the exact shapes where a false all-clear would live: libraries that open
real files / bind real sockets / spawn real subprocesses / read the clock **in their own functions**.

## Protocol (per package, executed by `run_frozen.sh`)

1. `git clone --depth 1 --branch <tag> <url>`; record `git rev-parse HEAD` as the pinned SHA in the summary.
2. `npm install --ignore-scripts` (the test runner + the package's own deps; no lifecycle build → hermetic).
3. **Static:** `candor-ts <dir> --allow-js` → per-function `(S, D)`, the analyzed-universe count, AND
   `.candor/report.locs.json` (the full-universe loc index, **required** for sound per-function attribution:
   without it a pure fn's runtime effect could fold onto a neighbouring effectful fn and be missed).
4. **Dynamic:** `candor-ts-verify <dir> --run "<testbin> <testargs>" --scope all --json` — the run command
   invokes the package's **own** test runner binary directly (bypassing the `npm test` lint/tsd preamble
   that would abort the suite before any test executes). The preload (`verify-preload.mjs`, wired via
   `NODE_OPTIONS --import`) wraps the real Node effect boundary (`fs`/`net`/`http(s)`/`dns`/`child_process`/
   `crypto`/`Math.random`/`Date`/`process.env`), emits `{file, line, effect}` per outermost boundary call,
   and `verify-core` attributes each site to the **enclosing candor function** (via `report.locs.json`
   spans) then checks H per executed function.
5. Record one row: `{name, disposition, analyzed, checked, sound_complete, disclosed, violations, sha}`.

## Attribution granularity — PER-FUNCTION (stated plainly)

This arm is **per-function**, like the JVM arm — **not** program-level like the Rust/Swift syscall arms.
The Node preload captures each effectful boundary call's *source site* (`{file, line}` of the nearest
project frame) and `verify-core.attribute()` maps it — via the `report.locs.json` span index — to the
**innermost candor function whose `[start,end]` contains the site**. So H is checked per executed function
(`observed(f) ⊆ S(f)`), and a violation names the exact function and the escaped effect. This is materially
stronger than the syscall arms' program-wide `observed ⊆ union(S)` check.

Two honesty caveats, both machine-disclosed by the oracle (never silently swallowed):

- **Forked suites weaken attribution, and the oracle SAYS SO.** `tap`-based suites (`node-tar`,
  `write-file-atomic`, `node-which`, `mkdirp`, `graceful-fs`) fork each test file into a subprocess. The
  preload propagates via `NODE_OPTIONS` so those subprocesses are still captured, but many effects then run
  in the *test harness's* frames (tap, the test file), not in the scanned package source — so they land as
  **unattributed sites**. `verify-core` flags `attributionComplete = false` and refuses to certify a green
  all-clear (CLI exit 2). Such a row is tabulated `disclosed-partial(attr-incomplete)` or
  `vacuous(attr-incomplete)` — an honest "we did not fully check this", not a false pass. In-process runners
  (`mocha`, `ava`, `jest --runInBand`) keep the effect in the package's own frames → complete attribution.

- **Where this arm goes VACUOUS.** Some libraries (`graceful-fs` is the deliberate control) reassign `fs`
  methods dynamically and dispatch through function-valued fields. candor correctly degrades **every** such
  frame to `Unknown` — so there are **zero sound-complete (`D = ∅`) frames** and H cannot be falsified on
  that package. Its disposition is `vacuous-all-disclosed` (or `vacuous(attr-incomplete)`): a
  disclosed-partial pass that proves nothing about H. It is reported as vacuous **explicitly**, never folded
  into the "H held" count as if it were a falsifiable success.

## Where this arm lands (the load-bearing honesty statement)

The value is in the **sound-complete** column. `H held` over a package that produced **N sound-complete
frames** is a genuine confirmatory datapoint of strength N; `H held` over a package that produced **0**
sound-complete frames (everything disclosed `Unknown`, or nothing attributed) is **vacuous** and says
nothing. The summary reports both, and the per-package `disposition` distinguishes them, so "H held" is
never read as "H was tested". A **violation** — a `D = ∅` frame whose runtime effect exceeds `S` — is a
false all-clear and the most valuable outcome (the Node analog of the JVM arm's R8 catch); it is reported
with the named function and escaped effect, not repaired here.

## Reproduction

```
cd ~/git/candor-ts/soundness/confirmatory
bash run_frozen.sh          # aborts unless the engine hashes to the frozen value
```

Writes `results/FROZEN-SUMMARY.tsv` (one row per manifest package) + `results/<name>.verify.json` (the full
per-function metrics/violations/blame). Runs on macOS — the Node preload needs no `strace`/Linux (unlike the
Rust/Swift syscall arms). `SCOPE=all` and `SUITE_TIMEOUT=240` by default; `WORK=<dir>` pins the scratch dir.

## Result (run executed 2026-07-21, engine hash verified)

**8 packages, 85 executed functions checked, 5 sound-complete (`D = ∅`) frames, 0 genuine classifier
violations.** The 3 rows the runner flagged `VIOLATION` are all **attribution artifacts of the oracle, not
classifier false all-clears** — see `FINDINGS.md` for the per-violation dissection. On every one, candor's
per-function inference on the real library function was **correct**; the flagged frame was an overlapping
CONTAINER span (a whole-file `<module>` or a synthetic whole-class `constructor`, both inferred pure) onto
which a test-harness effect (or an inter-method line) folded.

| package | disposition | analyzed | checked | sound-complete | disclosed | violations |
|---|---|---|---|---|---|---|
| tmp | no-in-scope-effect | 53 | 0 | 0 | 0 | 0 |
| node-tar | flagged-VIOLATION → **artifact** | 192 | 47 | 4 | 42 | (1 artifact) |
| get-port | flagged-VIOLATION → **artifact** | 13 | 4 | 1 | 2 | (1 artifact) |
| write-file-atomic | vacuous(attr-incomplete) | 10 | 3 | 0 | 3 | 0 |
| node-which | vacuous(attr-incomplete) | 10 | 4 | 0 | 4 | 0 |
| proper-lockfile | flagged-VIOLATION → **artifact** | 27 | 20 | 0 | 19 | (1 artifact) |
| mkdirp | no-in-scope-effect | 18 | 0 | 0 | 0 | 0 |
| graceful-fs | vacuous(attr-incomplete) | 58 | 7 | 0 | 7 | 0 |

**Totals: 85 checked, 5 sound-complete, 0 genuine classifier violations, 3 oracle attribution artifacts.**

The 5 sound-complete frames — the only frames that actually falsify H — are `node-tar`
`mkdir.checkCwdSync` (Fs⊆Fs), `unpack.unlinkFileSync` (Fs,Rand⊆Fs,Rand), two `<module>` Env reads, and
`get-port` `bindPort` (Net⊆Net). H held tightly on all five.

**Honest read of strength.** This run's falsifiable signal is thin: only **5** sound-complete frames across
8 packages, because (a) two packages exercised no in-scope effect in their scanned functions, (b) three went
vacuous or attribution-incomplete (all-Unknown dispatch and/or forked `tap` suites whose effects run in the
test harness, not the library), and (c) the per-function attribution is contaminated by container-span
over-capture (the artifact class above). The Node arm is per-function *by design* — stronger than the syscall
arms' program-level check — but this frozen corpus did not produce a large body of clean `D = ∅` frames, and
the container-span weakness must be fixed (a real, reported oracle bug) before the per-function claim is as
crisp as the JVM arm's. Reported as-is; not repaired under the freeze.
