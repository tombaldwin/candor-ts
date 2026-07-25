# Re-runs of the frozen slice under a corrected instrument

`FROZEN.md` pins the manifest, the classifier and the oracle, and `results/` is what that pinned artifact
actually produced. Neither is amended. When a defect is found **in the instrument** — not in the classifier —
the slice is re-run under the corrected engine and filed **beside** the frozen record, with its own engine
hash. Editing the pin in place would restate a pre-registered result as though the original run had never
happened, which is the failure pre-registration exists to prevent.

    EXPECT_SHA=<corrected engine hash> RESULTS_DIR=$PWD/results-<slug> bash run_frozen.sh

## 2026-07-25 — `results-corrected/`: two instrument defects in the Node oracle

Both were in the **capture**, not the classifier, and both were found by the transitive-recall battery
(`../../transitive-recall.mjs`) rather than by this slice.

1. **The stack was truncated at ten frames.** Transitive attribution reads `new Error().stack`, and V8's
   default `Error.stackTraceLimit` is 10 — several consumed by the patched builtin and Node's internals
   before app code. Outer project frames were silently dropped, so a false all-clear on them could not be
   caught. A 16-deep synchronous chain charged **5 of 16** frames. This biases every result in the dangerous
   direction: truncation can only lose checked frames and miss violations, never invent them.

2. **The module loader's file reads were charged to the program.** Loading a CommonJS module reads its file,
   and the loader performs that read while every module in the `require` chain is still on the stack. A
   program whose only "effect" is `require()` was charged `Fs` at every require site. That is the fabrication
   mirror, in the instrument built to catch its opposite.

**The order matters, and is the point of this note.** Fixing (1) alone took the slice from 3 violations to
**9**, across five packages that had been clean — four of them `<module>` frames in `node-tar`. Reported at
that moment they would have read as a dramatic set of new catches. They were artifacts of (2), which (1) had
merely made visible by restoring the outer frames the loader sits above. **A run between the two fixes is not
filed here**, because a number that was never true is not a datapoint; it is recorded in this note as the
reason the second fix exists.

`results-corrected/` is the slice under both fixes. Compare against `results/` (the frozen run) with the
truncation caveat above: the frozen numbers were produced by an instrument that could not see past a handful
of frames, so its checked counts are lower bounds and its clean packages are weaker evidence than they read.

### Result: `results-corrected/` vs `results/`

| | frozen (truncating) | depth fix only | corrected (both) | + import edge |
|---|---|---|---|---|
| checked | 85 | 96 | 92 | **92** |
| sound-complete | 5 | 3 | 5 | **4** |
| violations | 3 | 9 | 4 | **3** |

Seven more frames adjudicated than the frozen run, the same five sound-complete frames, and **four**
violations. Two are dispositions already on the record: `node-tar`'s
`WriteEntrySync.constructor` catch and `get-port`'s `test.<module>` scanner-scope flag.

**Two are new, and both were traced to source rather than counted.** `proper-lockfile`'s `index.<module>`
ran `{Env, Fs}` while declared complete-pure: it `require`s `lib/lockfile`, which `require`s `graceful-fs`,
whose module top level reads `process.env.NODE_DEBUG` (`graceful-fs.js:35`). `write-file-atomic`'s
`lib.index.<module>` ran `{Rand}` on the same shape, through `imurmurhash`/`signal-exit`. Under the
transitive reading a module initializer that reaches an **unanalyzed dependency's** top-level effect must
disclose `Unknown`, not claim purity — so both are candidate silent under-reports of one class, and both
were invisible before the truncation fix because the frames that carry them are the outermost ones.

**Recorded, not repaired** — per the pre-registration discipline. Adjudicating the class and deciding what
the classifier should say about a top-level `require` of an unanalyzed dependency is separate work.

### `results-importedge/` — one of the two closed, by determination rather than disclosure

Investigating the class showed the vein was **not** about unanalyzed dependencies: candor-ts did not model
the import edge at all, **not even between two modules inside the scanned project**, where nothing is
unanalyzed and the answer is simply computable. Modelling it (candor-ts `70553c3`, the shape candor-java has
always had) closes `proper-lockfile`: `index.<module>` moves from **VIOLATION to disclosed** — the package
goes 1 violation → 0 — because the edge resolves intra-project down to a module that already discloses.
No `Unknown` was invented and nothing flooded; `sound-complete` drops 5 → 4 for the same reason, a frame
correctly moving from *claimed complete* to *disclosed*.

`write-file-atomic` still flags: its `Rand` reaches through `node_modules`, which is the **external half**
of the vein and remains open. That the two findings separated exactly along the line the analysis predicted
is the useful part — the fix is scoped to what it can determine, and the residue is named rather than
papered over.
