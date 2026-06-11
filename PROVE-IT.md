# Prove it on *your* repo — a 15-minute self-experiment (TypeScript)

The candor family's [evals](https://github.com/tombaldwin/candor-rust/blob/main/EVAL.md) show
agents miss most of an effect's blast radius on *our* fixtures. You shouldn't care about our
fixtures. This is the same A/B, run by **your** agent on **your** TypeScript codebase, with every
claimed result verifiable by you at a file:line. Either outcome is informative — including "candor
didn't help here" (the prompt reports that too, and says why).

**Requirements:** a TypeScript project, node ≥ 20, any agentic coding tool. (Rust project? Use the
[Rust variant](https://github.com/tombaldwin/candor-rust/blob/main/PROVE-IT.md); JVM? the
[JVM variant](https://github.com/tombaldwin/candor-java/blob/main/PROVE-IT.md).)

**Paste this prompt into your agent at the repo root:**

---

```text
We're testing whether a static effect-analysis tool (candor-ts) tells me things about MY codebase
that you'd otherwise miss or take longer to find. Follow these steps IN ORDER — the order is the
experiment's integrity (your manual answer must be committed before the tool's answer exists).

STEP 1 — Pick the target. Choose ONE function in this project's PRODUCTION code (not tests, which
the scan deliberately excludes as harness code) that performs I/O (network, filesystem, database,
subprocess) and is called from more than one place — ideally one I care about changing. If I named
a function in my message, use that. State your choice.

STEP 2 — MANUAL TRACE (commit before looking at any tool output). From source alone, answer:
"Which functions in this project would be affected if <target> changed its behavior — i.e. every
TRANSITIVE caller, across all files?" Work as you normally would (grep, read). Write the complete
list to ./candor-manual-<target>.txt in the repo root (NOT a fixed /tmp name — repeated runs must
not cross-contaminate) — one function per line, named the way the callgraph keys them:
module-qualified with "." segments (src.db.save for save() in src/db.ts; class members
src.api.Client.send, constructors src.api.Client.constructor; a NESTED named function is keyed flat
under its module, while an anonymous arrow — including one wrapped in a cast — folds into its
enclosing function). Also note roughly how
many file-reads/searches it took you.

STEP 3 — Run candor-ts:
  git clone --depth 1 https://github.com/tombaldwin/candor-ts /tmp/candor-ts
  (cd /tmp/candor-ts && npm install --no-fund --no-audit)
  node /tmp/candor-ts/scan.mjs .
It writes .candor/report.json (per-function transitive effects) and .candor/report.callgraph.json
(every analyzed function's direct callees, pure ones included).

STEP 4 — Compute the tool's answer from the callgraph sidecar (plain JSON — no magic): write a
~10-line script that loads the callgraph, builds the reverse edge map, and BFS's from the target to
collect every transitive caller. Save to ./candor-tool-<target>.txt. (Note .candor/report.json's `functions` is an ARRAY of
{fn, inferred, …} entries; the callgraph sidecar is a keyed map — don't index the report like a
map.)

STEP 5 — Diff and VERIFY. Compare the two lists.
- For each function candor found that your manual trace MISSED: reconstruct the call chain from the
  callgraph (target ← caller ← caller …) and open ONE file per missed function to confirm the call
  site is real, quoting the file:line. These are real, verifiable edges — not tool assertions.
- For each function YOU listed that candor did not: check whether it's a real caller candor missed
  (a call through a callback value or an `any`-typed callee reads Unknown rather than edging — see
  the README's trust contract; a genuinely dropped edge is worth reporting at
  https://github.com/tombaldwin/candor-ts/issues) or a mistake in the trace.

STEP 6 — Scorecard. Report, honestly:
- target function, and the size of its true radius
- manual trace: N of M found, the specific functions missed (with the verified file:line evidence),
  and the file-reads/searches it took
- candor-ts: one scan + one script, and its own N of M
- AND if the result is unflattering to candor-ts, say so plainly: if your manual trace found
  everything (shallow radius, distinctive names — common in small projects), the honest conclusion
  is "on this codebase candor's value is speed/CI-gating, not completeness." If candor-ts missed
  real callers (DI-heavy code where calls flow through injected function values is its documented
  honest-Unknown territory; an unlisted npm package's effects are its documented classifier gap),
  report that as the tool's limitation.

Do not soften either direction. The point is what's true on THIS repo.
```

---

## Why this is a fair test

Same protocol as the family's pre-registered evals: the commitment device (manual answer written
before the tool runs), no circular trust (every claimed miss comes with a call chain whose every
edge is a real call site in *your* code), and the negative result in-scope. candor-ts is the
youngest engine — its misses are the most likely in the family, and we want them reported.
