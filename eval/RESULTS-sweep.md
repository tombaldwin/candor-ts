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

## The framework-app modality (added after the sweep) — the ORM-tier hole

Scanning a real **application** (a TypeORM/NestJS realworld app, 34 files) — a modality the
library sweep never touched — found the next hole in minutes: a database-heavy app read **zero
`Db`** (20 Unknown-only entries), because every data access resolves into the `typeorm` package,
which κ didn't know — invisible, not even `Unknown` (the curated-classifier caveat doing exactly
what it documents, on the most common app shape in the ecosystem). The JVM engine learned this
same lesson as "read Spring's declarations".

Fixed same-day with a **verb-precise ORM tier** (typeorm / @prisma/client / mongoose / sequelize /
drizzle-orm — execution verbs only, builders stay pure; plus @nestjs/axios → Net). Post-fix the
same app reads **45 functions carrying `Db`**, the service layer named exactly
(`ArticleService.findAll` …), and **20 controller methods inherit `Db` transitively** — the
layered-architecture visibility a policy gate needs (`deny Db controller` is now a meaningful TS
rule).

## Round 2 (same day): two more findings from pulling the zod thread

1. **`callback_named` ported** (the precision lever finding 3 named): a function invoking a callback
   PARAMETER now resolves to the named targets when every visible call site passes one — with the
   type-landing and identifier paths unified through one deferral (the engine's redundant Unknown
   defenses had made the first attempt a no-op: the same per-mechanism lesson as the fuzzer teeth).
   rimraf: 44 → 30 unresolved, 7 false Unknown-only entries left the report.
2. **A true silent-pure soundness hole — field initializers** — found by diagnosing why zod didn't
   move: `class C { data = fs.readFileSync(…) }` with an innocent explicit constructor produced an
   EMPTY report — the initializer runs at construction but attributed to nothing. Fixed with the
   JVM's model: every named class gets a `Class.constructor` unit (synthesized when implicit),
   field-initializer calls attribute there, `new C()` edges there even with an implicit ctor, and a
   class passed AS A VALUE resolves as a callback target. Fuzzer form `field_init` locks it.
   zod's count *rose* 489 → 501 after the fix — previously-lost field-init surface becoming
   visible, the right direction.
3. **zod itself is the honest residual**: its `$constructor`-factory style launders construction
   through function values — genuinely dynamic, correctly `Unknown`. Not every flood is a bug.

## Round 3: the CTA dogfood (the stranger's route) — two soundness finds + the UX one

A fresh agent given only the umbrella one-liner on a fresh clone of the Nest app produced a correct,
layered effect map (services own all 24 direct-Db functions; controllers/middleware inherit; gate
verified live in both directions) — and a 12-item friction list. The substantive finds, all fixed:

1. **Ambient builtins were unclassified**: `Math.random()` (a slugifier's entropy) and `new Date()`
   (a JWT issuer's timestamps) contributed nothing — `updateTimestamp` was omitted as pure. Now
   `Rand`/`Clock` (no-arg `new Date()` only; `new Date("2020-…")` is parsing and stays pure).
2. **argon2 came out silently pure** — `hashPassword` absent from the report, `findOne` reading a
   confident `[Db]` past an `argon2.verify`. The curated-κ caveat landing on exactly the call a
   security review cares about. κ gains the entropy tier (argon2/bcrypt/bcryptjs, node:crypto's
   random surface); both now read `Rand`. The caveat itself is now stated in AGENTS.md's trust
   section (it was only in the README) — the weaker edge of "never silently pure" must be visible
   where agents read.
3. **The missing-node_modules scan silently produced an all-Unknown report** the agent initially
   accepted ("wrote 62 effectful functions", 100% Unknown). The scanner now warns loudly, and
   AGENTS.md says install the target's deps first.
4. Doc fixes from the rest of the list: the `$Q` shorthand was bash-only (now a function, works in
   zsh); the report-shape wording implied a map (it's an array of `fn`-keyed entries); the sidecar
   filename was wrong; a worked policy block added; the umbrella's min-version rule now reads
   per-impl. Known remaining: TypeORM `@Entity('user')` decorator names don't feed `tables` yet
   (the JVM's declarative move, queued).

## Honest bounds

- N=12 library repos + one framework app (post-sweep); one ecosystem slice — no monorepos, no
  Next/front-end apps, no `allowJs`.
- "Effectful" counts include `Unknown`-only entries; given finding 3, raw counts overstate the
  *classified* effect surface on callback-heavy repos.
- One scan per repo at one commit; no cross-version stability claim.
- No completeness ground truth in the sweep itself — that's the PROVE-IT protocol's job.
