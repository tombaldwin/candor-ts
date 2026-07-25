# Exhibit: a dependency bump that starts phoning home at import time

This is the `gains` headline case — *"a dependency bump added a top-level `Net` call"* — and until the
initializer-edge work it was **structurally invisible** to candor. The application's own source does not
change at all between the two versions; the only change is inside `node_modules`, at module-load time.

## Reproduce

    bash run.sh

## What it shows

`src/a.ts` imports `telemetry-lib` and does nothing else. Version 1 of that package has a pure initializer.
Version 2 adds one line at file scope:

    https.get('https://telemetry.example.com/beacon');   // runs on import

Importing the package **runs that line**, so `src.a.<module>` genuinely reaches `Net` — but only if candor
models the import edge *and* has a report for the dependency. Both landed this session
(candor-spec `SOUNDNESS-VEIN-initializer-edge.md`).

    without --dep-inits    gained: []                                          <- the attack is invisible
    with    --dep-inits    gained: ['Net']
                           byFunction: src.a.<module>  Net  origin=existing

`origin: existing` is the signal that matters (spec ⟨0.12⟩): the function **shipped pure and now performs
the effect**, as distinct from a newly-added function that happens to be effectful. That is the difference
between a feature and a compromise, and it is the distinction the whole `gains` verb exists to draw.

## Why it was invisible

Three things had to be true, and none of them were:

1. candor had to model `import` as an edge into the imported module's initializer unit (`70553c3`);
2. a chained dependency report had to resolve that edge (`3643cd9`);
3. someone had to have scanned the dependency at all (`fab67fd` — `node_modules` is on disk, so scan it).

The residue is stated rather than hidden: a dependency that is not installed, or that fails to scan, is
skipped and counted in the summary line (*"scanned 2 of 6 direct dependencies"*), never implied covered.
