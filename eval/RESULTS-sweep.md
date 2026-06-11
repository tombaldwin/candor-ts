# Real-repo sweep — robustness + analysis profile (2026-06-11)

The TS analog of candor-rust's crate calibration, run with [sweep.sh](sweep.sh): twelve popular
repos cloned at HEAD, `npm install --ignore-scripts`, one scan each. **What this measures:**
robustness (does it crash? does it produce a plausible report?), speed, and the analysis profile on
real code. **What it does not measure:** completeness against ground truth (see the PROVE-IT
scorecard below) or any agent-productivity claim — those need the pre-registered A/B protocol the
Rust evals use, which has not been run for TS.

| repo | TS files | fns analyzed | effectful | unresolved | scan (s) | effects seen |
|---|---:|---:|---:|---:|---:|---|
| rimraf | 17 | 55 | 44 | 44 | 0.8 | Fs, Unknown |
| got | 25 | 183 | 62 | 55 | 1.2 | Net:35, Clock:27, Unknown:55 |
| ky | 29 | 71 | 28 | 26 | 0.8 | Clock, Unknown |
| zod | 195 | 958 | 490 | 490 | 1.6 | Unknown:490 |
| p-queue | 5 | 46 | 26 | 22 | 0.7 | Clock, Unknown |
| conf | 2 | 43 | 16 | 16 | 0.7 | Env:4, Unknown |
| execa, globby, del, nanoid, chalk, commander | — | — | — | — | ~0.7 | **JS-source packages** (ship `.d.ts` typings over `.js` code) — candor-ts is TS-only today, so these correctly yield no analysis rather than a wrong one |

## Findings

1. **Zero crashes; every TS repo produced a structurally plausible report.** Scans are fast —
   ~1s typical, 1.6s for zod's 195 files / 908 functions. Performance is a non-issue at this scale.
2. **The classifier fires where it should:** got's network core reads `Net` (33 fns), conf reads
   `Env`, rimraf reads `Fs`, the timeout-heavy libraries read `Clock`. No effect appeared anywhere
   it obviously shouldn't (chalk-class pure code yields nothing).
3. **The honest finding — the `Unknown` density on callback-heavy code.** zod: 490 of 958 functions
   read `Unknown` (51%; it was 65% before the property-arrow fix below — collecting those units as
   real edges removed 100 false Unknowns, a measured precision gain) — a pure validation library, flooded because its style is function-typed
   fields and parameters everywhere, each invocation honestly unresolvable under §4. rimraf (44/55,
   its DI-injected fs) and got (55) show the same shape. This is **sound but imprecise** — exactly
   the calibration frontier the Rust engine crossed early (its "Unknown flood" era, answered by
   callback-target resolution and the pure-trait calibrations). The measured next lever for the TS
   engine is the Rust `callback_named` move: when every call site of a function passes a *visible*
   named function or closure for a callback parameter, resolve to those targets instead of
   `Unknown`. Until then, treat TS reports on callback-heavy libraries as high-`Unknown` by
   construction: the trust contract holding, loudly.
4. **JS-source packages are out of scope, correctly:** half the "popular TypeScript" ecosystem
   ships compiled JS with typings (execa, globby, del, nanoid, chalk, commander). candor-ts
   analyzes TS sources; pointing it at a JS package yields "no TypeScript sources", never a wrong
   report. (An `allowJs` mode would widen coverage and is unassessed.)

## PROVE-IT scorecard (got) — and the two engine holes it found

Protocol per [PROVE-IT.md](../PROVE-IT.md): a fresh agent, manual trace committed before the tool
ran, every diff item verified at a file:line. Target: `Request._makeRequest` (got's network heart,
sitting in a retry cycle).

**Result: a 17/20 vs 17/20 tie with disjoint blind spots.**

- **Manual missed 3** the tool found: a cross-file error-path caller the agent's grep scoping
  skipped (`as-promise.onError` — verified at `as-promise/index.ts:171`), plus two
  nested-named-arrow units the agent had folded into their lexical parents. ~18 operations of
  careful reading vs one scan + a 10-line BFS.
- **The tool missed 3, and two shared one mechanism:** class **arrow-property methods**
  (`private readonly _onBodyError = (e) => …`) were not units AT ALL — no callgraph key (a §2.2
  violation), body never walked, a silent-pure hole worse than `Unknown` — and **constructors**
  were not nodes, so `new Request(…)` (whose ctor wires an effectful `flush` closure) edged
  nowhere. **Both fixed same-day** (collected as `Class.prop` / `Class.constructor` units; fuzzer
  forms `class_prop_arrow` + `ctor` lock them; zod's Unknown rate fell 65%→51% as a side effect).
- **Post-fix re-measure:** the blast radius reads **20**, recovering both fixed misses AND
  surfacing two real callers *both* methods had missed (`_sendBody`, `_writeBodyInChunks`, reachable
  only through the previously-invisible `_onBodyError`). **The third miss is root-caused as
  correct behavior, not a bug**: the receiver at `core/index.ts:1841` is destructured from an
  `as any` cast (`const {gotRequest} = requestOptions as any`), so `gotRequest._beforeError(…)` is
  a call on an `any`-typed value — statically unresolvable by construction, the documented
  any-laundering case. The entry honestly reads `unresolved: true` with `Unknown` in its set; an
  edge there would be a guess. The §4 contract held; the callgraph cannot soundly include what the
  type system has erased.

## Honest bounds

- N=12 repos, one ecosystem slice (popular small/medium libraries, Sindre-heavy); no monorepos, no
  framework apps (Next/Nest), no `allowJs`.
- "Effectful" counts include `Unknown`-only entries; given finding 3, raw counts overstate the
  *classified* effect surface on callback-heavy repos.
- One scan per repo at one commit; no cross-version stability claim.
- No completeness ground truth in the sweep itself — that's the PROVE-IT protocol's job.
