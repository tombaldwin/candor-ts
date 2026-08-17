#!/usr/bin/env node
/**
 * Behavioral tests for the candor-ts product surface — small synthetic projects in temp dirs,
 * asserted end to end (the conformance suite covers the cross-engine contract; this covers the
 * product mechanics: multi-file resolution, arrow-const collection, literal surfaces, the gate).
 *
 * Run: node test.mjs
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { show, loadReport, callersFrontier, blindspots, blindspotsStats } from "./query-core.mjs";
import { scratch, keepOnFailure } from "./scratch.mjs";
import { printAgents, writeStdoutSync } from "./contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The spec floor this build declares, DERIVED from the binary under test rather than written as a
// literal. A verdict's `spec` must equal what the engine says it speaks; asserting it against a
// hardcoded "0.27" tests a literal against a literal and makes every floor bump edit this file. That
// class was closed as "a one-off" once and then cost an edit in every repo on the next rung.
const SPEC = (execFileSync(process.execPath, [path.join(HERE, "scan.mjs"), "--version"], { encoding: "utf8" })
  .match(/\(spec ([0-9.]+)\)/) ?? [])[1];
if (!SPEC) throw new Error("could not derive the spec floor from `scan.mjs --version`");
let pass = 0, fail = 0;
// ── SHARDING ────────────────────────────────────────────────────────────────────────────────────────
// `node test.mjs --shard=I/N` runs only the top-level blocks whose index ≡ I (mod N); `--parallel[=N]`
// runs those shards as children and sums them. This file is 281s of the 346s `npm test` takes locally
// and ~700 of CI's 884 — ~1,300 fixture scans at ~1.5s each, each paying for a fresh TypeScript program.
// The blocks are already independent (`{}`-scoped, each minting its own temp tree), so the parallelism
// was there to take. Nothing about what is asserted changes.
//
// THE BLOCK LIST IS PARSED, NOT PATTERN-MATCHED. The first attempt found top-level blocks with a regex
// for a bare `{` at column 0, tracking backtick parity to skip fixture source. The parity desynced —
// backticks appear in comments and ordinary strings too — and it reported 96 real blocks and 79 inside
// template literals when the truth is 175 real ones. A third of the suite then ran in EVERY shard.
// ci/shard-check.sh caught it; the regex could not have. The generator uses ts.createSourceFile.
//
// ROUND-ROBIN, not contiguous ranges: the expensive blocks cluster at the end (the ⟨0.28⟩ sink work
// spawns far more scans than the early classifier rows), so splitting by position leaves one shard
// carrying most of the cost.
// THE SPACE-SEPARATED FORM IS AN ERROR, NOT A NO-OP. `--parallel 4` and `--shard 0/8` are what a person
// types, and nothing matched them: the bare flag fell through and the `4` was matched by no parser, so
// `--parallel 4` silently ran the default shard count and `--shard 0/8` silently ran the ENTIRE suite as
// though unsharded. That is the same silent fallback the validation below was added to close, reached by
// the spelling the validation does not look at — the operator asking for a specific count gets a
// different one and no stderr. Both flags take `=`, and saying so is cheaper than guessing.
for (const flag of ['--shard', '--parallel']) {
  const at = process.argv.indexOf(flag);
  if (at >= 0 && process.argv[at + 1] !== undefined && !process.argv[at + 1].startsWith('-')) {
    console.error(`test.mjs: ${flag} takes its value with an '=' — write ${flag}=${process.argv[at + 1]}, not `
                + `'${flag} ${process.argv[at + 1]}' (which would silently run the default)`);
    process.exit(2);
  }
}
const SHARD = (() => {
  const a = process.argv.find((x) => x.startsWith('--shard='));
  if (!a) return null;
  const m = /^(\d+)\/(\d+)$/.exec(a.slice('--shard='.length));
  if (!m) { console.error(`test.mjs: --shard wants I/N, got '${a}'`); process.exit(2); }
  const [i, n] = [Number(m[1]), Number(m[2])];
  if (!(n > 0 && i >= 0 && i < n)) { console.error(`test.mjs: --shard=${i}/${n} out of range`); process.exit(2); }
  return { i, n };
})();
let _blkIdx = 0;
const blk = () => { const i = _blkIdx++; return !SHARD || i % SHARD.n === SHARD.i; };

// The parent runs NO blocks: it dispatches and exits before the suite body is reached. Sharding lives
// here rather than in a CI matrix because ci.yml runs `npm test` on purpose — enumerating stages in the
// workflow is how the probe and mcp/watch suites once went silently missing from CI — and because a
// developer gets the same speedup.
if (SHARD === null) {
  const pa = process.argv.find((x) => x === '--parallel' || x.startsWith('--parallel='));
  if (pa) {
    // BOTH the flag and the env override are VALIDATED, in the same shape as --shard above (usage error,
    // exit 2, naming what was given). Neither was, and the parent generates the children's --shard from
    // this number, so a bad value here came back as the CHILDREN's error. Measured before this fix:
    //   --parallel=3.7  spawned `--shard=0/3.7`, which the child's own regex rejects — all shards exited
    //                   2 with no summary, and the parent blamed the shards for a flag IT wrote.
    //   --parallel=abc, --parallel=, =0, =-4, CANDOR_TEST_SHARDS=abc
    //                   all failed `want > 0` and fell back to the core count with nothing on stderr —
    //                   so an operator setting the override precisely to STOP an oversubscribed run got
    //                   the oversubscribed run, silently, which is the failure the override exists for.
    //   --parallel=1e9  passed `want > 0` and reached Array.from({ length: 1e9 }).
    // The upper bound is a sanity rail, not a capability claim: the suite is 175 blocks, so shards past
    // this point are empty children paying process + TypeScript startup for nothing.
    const MAX_SHARDS = 64;
    const shardCount = (raw, what) => {
      // `\d+` on purpose: it is the only spelling that is unambiguously a shard count. Number() accepts
      // '3.7', '1e9', '0x10', ' 4 ' and '-4', and every one of those reaches the child as a --shard value.
      if (!/^\d+$/.test(raw)) {
        console.error(`test.mjs: ${what} wants a whole number of shards, got '${raw}'`); process.exit(2);
      }
      const n = Number(raw);
      if (!(n >= 1 && n <= MAX_SHARDS)) {
        console.error(`test.mjs: ${what}=${raw} out of range (want 1..${MAX_SHARDS})`); process.exit(2);
      }
      return n;
    };
    const want = pa.includes('=') ? shardCount(pa.slice(pa.indexOf('=') + 1), '--parallel') : 0;
    // All cores, not cores-1. The parent only awaits children, so reserving one for it buys nothing —
    // and CI runners are small, where that one core is a third of the machine. Measured: the local 12-core
    // box went 286s → 74s, while CI's first run at cores-1 managed only 884s → 612s. CANDOR_TEST_SHARDS
    // overrides for a runner that reports more cores than it can actually schedule. An EMPTY env var reads
    // as unset (that is what `CANDOR_TEST_SHARDS= npm test` means); an empty `--parallel=` does not, because
    // someone typed the `=`.
    const envRaw = process.env.CANDOR_TEST_SHARDS;
    const env = envRaw === undefined || envRaw === '' ? 0 : shardCount(envRaw, 'CANDOR_TEST_SHARDS');
    const N = want > 0 ? want : env > 0 ? env : Math.max(2, Math.min(8, os.cpus()?.length ?? 4));
    // `spawn`, awaited together — NOT `spawnSync` in a map. The first version did exactly that and was
    // sequential by construction (spawnSync blocks until the child exits), measuring 289s against 286s
    // for the plain run. shard-check could not see it: the totals are identical whether the children
    // run together or in a queue. Only the clock catches a parallel driver that is not parallel.
    // THE PARENT OWNS THE CHILDREN'S LIFETIME. Measured before this: SIGTERM the parent and all N
    // `node test.mjs --shard=i/N` children survived with ppid 1, still scanning and still minting fixture
    // trees that nothing would sweep — the 46,919-directory leak scratch.mjs exists to stop, refilled by
    // the one process shape scratch.mjs cannot see. Ctrl-C in a terminal hid it: the tty signals the whole
    // process GROUP, so the children were already dying for a reason that has nothing to do with us. A CI
    // step timeout or a plain `kill <pid>` signals the parent only.
    //
    // SIGTERM ALONE DOES NOT KILL A SHARD, and that is the whole reason this needs two stages. MEASURED:
    // `node test.mjs --shard=0/8`, SIGTERMed mid-run, was still alive 25 seconds later and only SIGKILL
    // ended it. The cause is scratch.mjs, unhappily: installing a JS listener REPLACES the default "die"
    // disposition, and the callback can only be dispatched from the event loop — but a shard's whole body
    // is synchronous top-level code, 175 blocks of blocking spawnSync scans, and never yields until it is
    // finished. So the sweep handler that exists to stop the fixture-tree leak is exactly what makes the
    // leaking process unkillable. (Same shape as the unkillable-Ctrl-C bug scratch.mjs's own comment
    // records, from the other direction — and it is not confined to --parallel: a plain `node test.mjs`
    // ignores SIGTERM for the same reason.) TERM first anyway, so a child that IS at a yield point exits
    // cleanly and sweeps; then a bounded grace; then KILL what is left, because a parent that politely
    // asks and then dies has not solved anything.
    const live = new Set();
    const GRACE_MS = 500;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      // prependListener, NOT `on`. scratch.mjs installs its sweep handler at IMPORT time — before this
      // line runs — and that handler ends with `removeAllListeners(sig)` and a re-raise.
      //   THE MECHANISM, corrected: `removeAllListeners` is NOT what would skip an appended listener.
      //   EventEmitter.emit iterates a CLONE of the listener array, so a listener appended after
      //   scratch.mjs's still runs (measured: both fire). What actually skips it is the RE-RAISE on the
      //   next line — with the default disposition restored, `process.kill(process.pid, sig)` terminates
      //   inside the call and never returns (measured: exit 143, the appended listener never ran).
      //   Stated because a maintainer who tests only the first claim will find it false and revert this.
      // Running first also gives the order we want: children are signalled, then the parent sweeps.
      process.prependListener(sig, () => {
        for (const c of live) { try { c.kill(sig); } catch { /* already gone; nothing to kill */ } }
        // A synchronous grace: this runs from a signal handler with the parent about to re-raise, so there
        // is no later turn of the event loop to escalate from. Atomics.wait is the only blocking sleep.
        if (live.size) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, GRACE_MS);
        for (const c of live) {
          // `c.kill()`, NEVER `process.kill(c.pid, …)`. The ChildProcess method is a no-op once Node has
          // reaped the child (`_handle === null`, returns false), so it needs no liveness probe. The pid
          // form does: a child that exited BEFORE the signal and is sitting between 'exit' and 'close'
          // with its stdio still draining has already been reaped, so its pid is free for reuse and
          // signalling it by number can hit an unrelated process. The first version probed with
          // `process.kill(c.pid, 0)` first, which is the same hazard one step removed.
          try { c.kill('SIGKILL'); } catch { /* reaped or gone */ }
        }
        live.clear();
      });
    }
    // ONE PARENT-OWNED TMPDIR FOR THE WHOLE RUN, because the kill above buys the orphan fix with a leak:
    // a SIGKILLed child cannot run its own scratch.mjs sweep, and the killed run measured 136 fixture
    // trees left in $TMPDIR. Pointing the children's `os.tmpdir()` at a directory the PARENT minted with
    // `scratch()` moves the ownership up one level — the parent's sweep removes the lot, on the signal
    // path too (this handler runs first, scratch.mjs's sweep second). It also fixes the case nobody was
    // watching: before, an orphan that ran to completion swept its own trees, so the leak was invisible
    // unless you killed it, and now neither ending leaks.
    const kidTmp = scratch('candor-ts-parallel-');
    const kids = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
      const c = spawn(process.execPath, [fileURLToPath(import.meta.url), `--shard=${i}/${N}`],
                      { env: { ...process.env, TMPDIR: kidTmp } });
      live.add(c);
      let out = '', err = '';
      // `spawn` has NO `encoding` option (that is spawnSync/execFile), so chunks arrive as Buffers and
      // `out += d` decoded each independently — measured 29 U+FFFD in 264 KB, because every assertion
      // name here is dense with 3-byte characters (─ ⟨⟩ → — κ).
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { err += d; });
      // A child that dies by SIGNAL, or exits non-zero after printing a valid summary (OOM between the
      // last write and exit, with 8 TypeScript programs resident), would otherwise contribute its counts
      // and let the parent exit 0. Status and signal are part of the verdict, not just diagnostics.
      c.on('error', (e) => { live.delete(c); res({ stdout: out, stderr: `${err}\nspawn failed: ${e.message}\n`, status: null, signal: null }); });
      c.on('close', (status, signal) => { live.delete(c); res({ stdout: out, stderr: err, status, signal }); });
    })));
    // fs.writeSync, NOT process.stdout.write — the same defect contract.mjs was rewritten for in this
    // same release. On a PIPE those writes are asynchronous and `process.exit()` below discards whatever
    // is still buffered: measured at exactly 65536 bytes delivered with the `test: N passed` summary GONE,
    // both at N=2 (2 × 72 KB, the 2-core-runner shape) and at N=8 with a late reader. CI captures step
    // stdout on a pipe, so `npm test` could exit 0 having printed no summary at all — and a lost summary
    // is indistinguishable from the crashed-shard case `broke` exists to catch.
    //
    // ⟨0.29⟩ THE DRIVER USES THE SHARED WRITER — it had its own private copy of this loop, and that copy
    // was a closure inside this branch, so NO route the suite drives could reach it: the arm was untested
    // by construction. That is the sibling asymmetry inverted. `contract.mjs`'s half got a row (driving
    // the real loop against a FIFO filled to capacity, which is what caught it being vacuous on Linux)
    // and the driver's half got none, because the driver was fixed FIRST and its test came second.
    //
    // Deleting the copy is better than writing a second row for it: one implementation, already
    // exercised. `writeStdoutSync` returns false when it gave up (EAGAIN budget) or the reader left
    // (EPIPE), which is the `dropped` signal this driver needs — an unfinished dump is an incomplete
    // report, indistinguishable from a clean one, the same argument `broke` rests on.
    //
    // The residual, stated because it has not changed: on this path fd 1 stays BLOCKING (nothing here
    // creates a `process.stdout` stream), so the EAGAIN arm is LATENT and the write blocks in the kernel
    // instead. One `console.log` before the dump arms it. A blocking write cannot be bounded from user
    // code without going async, and that is not fixed here.
    let dropped = 0;
    const wr = (fd, text) => { if (text && !writeStdoutSync(text, "the shard dump", fd)) dropped++; };
    let p = 0, f = 0, broke = 0;
    kids.forEach((k, i) => {
      wr(1, k.stdout ?? '');
      wr(2, k.stderr ?? '');
      const m = /^test: (\d+) passed, (\d+) failed$/m.exec(k.stdout ?? '');
      // A shard with no summary line did not finish. Counting it 0/0 would let a crashed child pass as
      // an empty shard — the vacuous green this suite exists to reject.
      if (!m) { broke++; wr(1, `  FAIL shard ${i}/${N} produced no summary line (status ${k.status}, signal ${k.signal})\n`); return; }
      if (k.status !== 0 || k.signal) {
        broke++; wr(1, `  FAIL shard ${i}/${N} reported ${m[1]} passed but exited status ${k.status} signal ${k.signal}\n`); return;
      }
      p += Number(m[1]); f += Number(m[2]);
    });
    wr(1, `\ntest: ${p} passed, ${f} failed  (${N} shards)\n`);
    if (broke) wr(1, `test: ${broke} shard(s) did not report cleanly — treating the run as FAILED\n`);
    // A dump this driver could not finish writing is a run whose report is INCOMPLETE, and an incomplete
    // report that exits 0 is indistinguishable from a clean one — the same reason `broke` exists.
    if (dropped) wr(1, `test: ${dropped} write(s) dropped on a stalled fd — the output above is INCOMPLETE\n`);
    // The children's trees now live under a directory this process owns, so the parent has to honour the
    // same keep-the-evidence rule the shards do: a failing shard printed paths into them (`  FAIL … /var/
    // folders/…`), and sweeping on the way out would delete what those lines point at.
    // `dropped` counts too: the run exits 1 for it, and a run that exits 1 must not sweep the evidence
    // its own output pointed at. Keeping on two of the three red conditions was an oversight, not a rule.
    if (f || broke || dropped) keepOnFailure();
    process.exit(f || broke || dropped ? 1 : 0);
  }
}

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
}

function project(files) {
  // `scratch`, not a bare mkdtempSync: this is called ~1,300 times a run and used to leave every tree
  // behind — the single biggest contributor to the 46,919 `candor-*` dirs measured in $TMPDIR. Trees
  // still survive a FAILING run, which is when their paths are printed and someone wants to look.
  const d = scratch("candor-ts-test-");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return d;
}
function scan(dir, ...extra) {
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), dir, ...extra], { encoding: "utf8" });
  const rp = path.join(dir, ".candor", "report");
  const report = fs.existsSync(`${rp}.json`) ? JSON.parse(fs.readFileSync(`${rp}.json`, "utf8")) : null;
  const cg = fs.existsSync(`${rp}.callgraph.json`) ? JSON.parse(fs.readFileSync(`${rp}.callgraph.json`, "utf8")) : null;
  return { r, report, cg, prefix: rp };
}
const entry = (rep, fn) => rep.functions.find((e) => e.fn === fn);

// ── 1. multi-file: cross-file edges resolve and effects propagate ─────────────────────────────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("INSERT INTO orders (id) VALUES (1)"); }`,
    "src/api.ts": `import { save } from "./db.js";
import { DatabaseSync } from "node:sqlite";
export function handle(db: DatabaseSync): void { save(db); }`,
  });
  const { report, cg } = scan(d);
  check("cross-file edge resolves", cg["src.api.handle"]?.includes("src.db.save"), JSON.stringify(cg));
  check("effects propagate across files", entry(report, "src.api.handle")?.inferred.includes("Db"));
  check("tables propagate across files", entry(report, "src.api.handle")?.tables?.includes("orders"));
}

// ── 2. arrow-const functions are analyzed (the rimraf gap) ────────────────────────────────────────
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
export const readIt = (p: string) => fsm.readFileSync("/etc/app/x");
export const wrap = () => readIt("y");`,
  });
  const { report, cg } = scan(d);
  check("arrow consts are analyzed + named", entry(report, "src.a.readIt")?.inferred.includes("Fs"));
  check("calls RESOLVE to an arrow const (edge, not Unknown)",
        cg["src.a.wrap"]?.includes("src.a.readIt"), JSON.stringify(cg));
  check("path literal captured", entry(report, "src.a.readIt")?.paths?.includes("/etc/app/x"));
}

// ── 2b. SETUP split (⟨0.19⟩, SPEC §6.2 §3): a declared-but-uninstalled dep tags no-node_modules (setup) ──
if (blk()) {
  const d = project({
    "package.json": `{ "name": "demo", "dependencies": { "left-pad": "^1.0.0" } }`,
    "src/app.ts": `import leftPad from "left-pad";
import * as lp from "left-pad";
export function pad(s: string) { return leftPad(s, 10); }
export function pad2(s: string) { return lp.default(s, 10); }`,
  });
  const { report, r } = scan(d);
  check("uninstalled declared dep tags no-node_modules (setup)",
        entry(report, "src.app.pad")?.unknownWhy?.includes("no-node_modules:left-pad"), JSON.stringify(entry(report, "src.app.pad")));
  check("namespace import of an uninstalled dep tags setup too",
        entry(report, "src.app.pad2")?.unknownWhy?.includes("no-node_modules:left-pad"));
  check("SETUP diagnostic names the package + the fix", /SETUP —.*left-pad.*npm install/s.test(r.stderr), r.stderr);
  // Unknown[dynamic] EXCLUDES setup → tolerates the mis-config; Unknown[setup] fires on it.
  fs.writeFileSync(path.join(d, "dyn.pol"), "deny Net Unknown[dynamic]\n");
  fs.writeFileSync(path.join(d, "setup.pol"), "deny Net Unknown[setup]\n");
  check("Unknown[dynamic] tolerates a setup hole (exit 0)", scan(d, "--policy", path.join(d, "dyn.pol")).r.status === 0);
  check("Unknown[setup] fires on a setup hole (exit 1)", scan(d, "--policy", path.join(d, "setup.pol")).r.status === 1);
}

// ── 2c. a FUNCTION-SCOPED local fn sharing a module unit's name must NOT fabricate (collision fix) ──
// `const persist = arrow` at module scope + a same-named PURE local `const persist` inside another fn
// minted the SAME `mod.persist` key; the second `fns.set` clobbered the first, and the checker-resolved
// LOCAL edge then read the module unit's Fs off the shared entry — FABRICATED onto a pure caller. Found
// by the cross-engine review of candor-rust's qself/macro phantom-edge class (same class, different repo).
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
export const persist = (msg: string): void => { fsm.writeFileSync("/tmp/x", msg); };
export function handler(): void {
  const persist = (n: number) => n * 2;
  persist(10);
}`,
  });
  const { report } = scan(d);
  check("module-level effectful unit still reports its effect", entry(report, "src.a.persist")?.inferred.includes("Fs"));
  check("a same-named function-scoped local does NOT fabricate onto a pure caller (handler stays pure)",
        entry(report, "src.a.handler") === undefined, JSON.stringify(report.functions));
}

// ── 2d. a LOCAL-VAR-aliased fn invoked via .call()/.apply() must NOT silent-pure (reflective-invoke) ─
// `const m = effectful; m.call(null, p)` — the `.call`/`.apply` arm special-cased member/identifier
// RECEIVERS but never resolved a local var's binding through the `.call`/`.apply` property access, so the
// edge dropped silent-pure (the cardinal sin). FIX = follow the alias to the real fn unit (recovers the
// edge, like the direct `effectful.call(…)` form); an unresolvable holder discloses Unknown; a PURE local
// var stays pure (no fabrication). Controls below pin all three boundaries.
if (blk()) {
  const d = project({
    "src/a.ts": `import { writeFileSync } from "fs";
function effectful(p: string) { writeFileSync(p, "x"); }
class C {
  doIt(p: string) { writeFileSync(p, "y"); }
  m1(p: string) { const m = this.doIt; m.call(this, p); }
}
export function localCall(p: string)  { const m = effectful; m.call(null, p); }
export function localApply(p: string) { const m = effectful; m.apply(null, [p]); }
export function localPlain(p: string) { const m = effectful; m(p); }
export function pureLocalCall() { const m = (n: number) => n * 2; return m.call(null, 1); }
export function viaParam(fn: Function, p: string) { const m = fn; m.call(null, p); }`,
  });
  const { report } = scan(d);
  const eff = (fn) => entry(report, fn)?.inferred ?? [];
  const carries = (fn) => eff(fn).includes("Fs") || eff(fn).includes("Unknown");
  // BUG cases: now recover the real effect (or at minimum disclose Unknown), no longer silent-pure.
  check("local-var alias .call() no longer silent-pure (carries effect/Unknown)", carries("src.a.localCall"),
        JSON.stringify(eff("src.a.localCall")));
  check("local-var alias .apply() no longer silent-pure (carries effect/Unknown)", carries("src.a.localApply"),
        JSON.stringify(eff("src.a.localApply")));
  check("this-method alias .call() no longer silent-pure (carries effect/Unknown)", carries("src.a.C.m1"),
        JSON.stringify(eff("src.a.C.m1")));
  // Real-fix evidence: the alias is RESOLVED to the fn, so the precise Fs is recovered (not just Unknown).
  check("local-var alias .call() recovers the precise Fs (real fix, edge resolved)", eff("src.a.localCall").includes("Fs"));
  // CONTROL (precision preserved): the plain direct invoke still resolves to Fs.
  check("control: plain local invoke m(p) still Fs", eff("src.a.localPlain").includes("Fs"));
  // CONTROL (no fabrication): a PURE local var .call()'d must stay pure — never gain an effect.
  check("no-fabrication: a pure local var .call()'d stays pure", eff("src.a.pureLocalCall").length === 0,
        JSON.stringify(eff("src.a.pureLocalCall")));
  // HONESTY: an unresolvable holder (a Function param) discloses Unknown, never silent-pure.
  check("honesty: an unresolvable fn-holder .call()'d discloses Unknown (not silent-pure)",
        eff("src.a.viaParam").includes("Unknown"), JSON.stringify(eff("src.a.viaParam")));
}

// ── 2e. a `.bind()`-wrapped callback passed to an INVOKING HOF must NOT silent-pure ─────────────────
// `setTimeout(this.flush.bind(this), 0)` / `[1,2].forEach(effFs.bind(null))` schedule the BOUND fn, but the
// argument is a CallExpression (callee = `.bind`), which the HOF-ref arm skipped (it only edged identifier /
// property-access args) → the scheduling fn read silent-pure (the cardinal sin, gate-evadable `deny Fs`).
// `.bind` is the missing third member of the `.call`/`.apply` reflective-invoke family. FIX = unwrap the
// `.bind` chain to the root receiver and resolve it to its fn unit (recovers the precise effect); an
// unresolvable receiver discloses Unknown; a `.bind` on a PURE fn stays pure (no fabrication).
if (blk()) {
  const d = project({
    "src/a.ts": `import { writeFileSync } from "fs";
import { execSync } from "child_process";
function effFs(p: string) { writeFileSync(p, "x"); }
function effExec() { execSync("ls"); }
function pure(n: number) { return n + 1; }
function getCb(): () => void { return () => {}; }
class W {
  flush() { writeFileSync("/tmp/x", "y"); }
  schedule() { setTimeout(this.flush.bind(this), 0); }
}
export function bindSetTimeout()  { setTimeout(effFs.bind(null, "/tmp/x"), 0); }
export function bindSetImmediate(){ setImmediate(effExec.bind(null)); }
export function bindThen()        { Promise.resolve().then(effFs.bind(null, "/tmp/x")); }
export function bindForEach()     { [1, 2].forEach(effFs.bind(null, "/tmp/x")); }
export function bindMap()         { return [1, 2].map(effFs.bind(null, "/tmp/x")); }
export function bindChained()     { setTimeout(effFs.bind(null).bind(null, "/tmp/x"), 0); }
export function viaW()            { return new W().schedule(); }
export function bindPure()        { setTimeout(pure.bind(null, 3), 0); }
export function bindUnresolvable(){ setTimeout(getCb().bind(null), 0); }`,
  });
  const { report } = scan(d);
  const eff = (fn) => entry(report, fn)?.inferred ?? [];
  // BUG cases: the bound effectful callback's effect is now reachable at the scheduling fn (precise).
  check("bind→setTimeout no longer silent-pure (carries Fs)", eff("src.a.bindSetTimeout").includes("Fs"),
        JSON.stringify(eff("src.a.bindSetTimeout")));
  check("bind→setImmediate carries Exec", eff("src.a.bindSetImmediate").includes("Exec"),
        JSON.stringify(eff("src.a.bindSetImmediate")));
  check("bind→Promise.then carries Fs", eff("src.a.bindThen").includes("Fs"),
        JSON.stringify(eff("src.a.bindThen")));
  check("bind→forEach carries Fs", eff("src.a.bindForEach").includes("Fs"),
        JSON.stringify(eff("src.a.bindForEach")));
  check("bind→map carries Fs", eff("src.a.bindMap").includes("Fs"),
        JSON.stringify(eff("src.a.bindMap")));
  check("this.method.bind(this)→setTimeout carries Fs", eff("src.a.W.schedule").includes("Fs"),
        JSON.stringify(eff("src.a.W.schedule")));
  check("chained .bind().bind() resolves through to root ref (Fs)", eff("src.a.bindChained").includes("Fs"),
        JSON.stringify(eff("src.a.bindChained")));
  // NO FABRICATION: a PURE fn .bind()'d and scheduled stays pure — never gains an effect.
  check("no-fabrication: a pure fn .bind()'d to setTimeout stays pure", eff("src.a.bindPure").length === 0,
        JSON.stringify(eff("src.a.bindPure")));
  // HONESTY: an unresolvable receiver (`getCb().bind(null)`) discloses Unknown, never silent-pure.
  check("honesty: an unresolvable .bind() receiver discloses Unknown (not silent-pure)",
        eff("src.a.bindUnresolvable").includes("Unknown"), JSON.stringify(eff("src.a.bindUnresolvable")));
}

// ── 2f. IMPLICIT VALUE-COERCION edges: a coercion method (toString/valueOf/toJSON/[Symbol.toPrimitive])
// invoked by the JS coercion protocol must NOT silent-pure the triggering fn ───────────────────────
// `"x" + e` / `` `${e}` `` / `String(e)` call e.toString; `e * 2` / `-e` call e.valueOf;
// `JSON.stringify(e)` calls e.toJSON; `[Symbol.toPrimitive]` is preferred for `+`/arith. None surfaces
// as a CallExpression on the user method, so an effectful coercion member read silent-pure (cardinal
// sin). FIX = resolve the operand's type's coercion member via the checker, edge to it when LOCAL.
// NO FABRICATION: a PURE coercion member edges a pure unit; string+string / number+number / String(42) /
// JSON.stringify of a plain object (no toJSON) resolve to no LOCAL member → stay pure.
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
class Eff {
  toString(): string { fsm.appendFileSync("/tmp/x", "s"); return "e"; }
  valueOf(): number { fsm.appendFileSync("/tmp/x", "v"); return 1; }
  toJSON(): object { fsm.appendFileSync("/tmp/x", "j"); return {}; }
  [Symbol.toPrimitive](_h: string): string { fsm.appendFileSync("/tmp/x", "p"); return "e"; }
}
class Pure { toString() { return "p"; } valueOf() { return 2; } toJSON() { return {}; } }
export function concatTrigger(): string { const e = new Eff(); return "x" + e; }
export function templateTrigger(e: Eff): string { return \`event: \${e}\`; }
export function stringTrigger(): string { const e = new Eff(); return String(e); }
export function emptyConcat(): string { const e = new Eff(); return "" + e; }
export function arithTrigger(): number { const e = new Eff(); return e * 2; }
export function unaryTrigger(): number { const e = new Eff(); return -e; }
export function jsonTrigger(): string { const e = new Eff(); return JSON.stringify(e); }
export function pureConcat(): string { const p = new Pure(); return "x" + p; }
export function pureArith(): number { const p = new Pure(); return p * 2; }
export function pureJson(): string { const p = new Pure(); return JSON.stringify(p); }
export function stringNum(): string { return String(42); }
export function strStr(a: string, b: string): string { return a + b; }
export function numNum(a: number, b: number): number { return a + b; }
export function plainJson(): string { return JSON.stringify({ a: 1 }); }`,
  });
  const { report } = scan(d);
  const eff = (fn) => entry(report, fn)?.inferred ?? [];
  // EFFECTFUL triggers: the coercion member's Fs is now reachable at the triggering fn.
  check("toString via string-concat carries Fs", eff("src.a.concatTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.concatTrigger")));
  check("toString via template literal carries Fs", eff("src.a.templateTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.templateTrigger")));
  check("toString via String() carries Fs", eff("src.a.stringTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.stringTrigger")));
  check("toString via \"\"+x carries Fs", eff("src.a.emptyConcat").includes("Fs"),
        JSON.stringify(eff("src.a.emptyConcat")));
  check("valueOf via arithmetic (x*2) carries Fs", eff("src.a.arithTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.arithTrigger")));
  check("valueOf via unary (-x) carries Fs", eff("src.a.unaryTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.unaryTrigger")));
  check("toJSON via JSON.stringify carries Fs", eff("src.a.jsonTrigger").includes("Fs"),
        JSON.stringify(eff("src.a.jsonTrigger")));
  // NO FABRICATION: pure coercion members + primitive operands stay pure.
  check("no-fabrication: pure toString via concat stays pure", eff("src.a.pureConcat").length === 0,
        JSON.stringify(eff("src.a.pureConcat")));
  check("no-fabrication: pure valueOf via arith stays pure", eff("src.a.pureArith").length === 0,
        JSON.stringify(eff("src.a.pureArith")));
  check("no-fabrication: pure toJSON via stringify stays pure", eff("src.a.pureJson").length === 0,
        JSON.stringify(eff("src.a.pureJson")));
  check("no-fabrication: String(42) stays pure", eff("src.a.stringNum").length === 0,
        JSON.stringify(eff("src.a.stringNum")));
  check("no-fabrication: string+string concat stays pure", eff("src.a.strStr").length === 0,
        JSON.stringify(eff("src.a.strStr")));
  check("no-fabrication: number+number arithmetic stays pure", eff("src.a.numNum").length === 0,
        JSON.stringify(eff("src.a.numNum")));
  check("no-fabrication: JSON.stringify of a plain object (no toJSON) stays pure",
        eff("src.a.plainJson").length === 0, JSON.stringify(eff("src.a.plainJson")));
}

// ── 2f-bis. IMPLICIT STRINGIFICATION reached through DISPATCH or a SINK ────────────────────────────
// The four-way common-mode vein (candor-spec SOUNDNESS-VEIN-implicit-stringify.md), found on HikariCP
// by the dynamic oracle and reproduced in all four engines. §2f above resolves the coercion member on
// the operand's DECLARED type, which stays silent in the two shapes that actually occur in real code:
//   (1) DISPATCH — the operand is typed by an INTERFACE (or a base class) that declares no `toString`,
//       so the checker lands on the pure lib.es `Object.prototype.toString` and edges nowhere, even
//       though the only runtime implementor's `toString` performs an effect.
//   (2) SINK — the stringification happens INSIDE a library (`console.log("%s", e)`, a logger's
//       parameterized level-method, `Array.prototype.join`). There is no coercion node at the call
//       site at all; statically the site resolves cleanly to the log/join call, so the fn looks fully
//       accounted for while the argument's own effect is absorbed silently.
// FIX = CHA-dispatch the coercion member over the type's LOCAL implementors/subclasses (reusing the
// interfaceImpls / classDescendants indexes ordinary dispatch already uses), and model the named
// stringifying sinks. NO FABRICATION: a string/number/plain-object/library-typed operand, or a type
// with no LOCAL coercion member, resolves to nothing and contributes nothing.
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
interface Entry { state(): number; }
class EffEntry implements Entry {
  state(): number { return 1; }
  toString(): string { fsm.appendFileSync("/tmp/x", "s"); return "e"; }
  toJSON(): object { fsm.appendFileSync("/tmp/x", "j"); return {}; }
}
interface PureEntry { state(): number; }
class PureImpl implements PureEntry { state(): number { return 1; } toString(): string { return "p"; } }
abstract class Base { abstract kind(): string; }
class EffSub extends Base { kind(): string { return "k"; } toString(): string { fsm.appendFileSync("/tmp/x", "b"); return "s"; } }

// (1) DISPATCH: the operand is INTERFACE-typed; the effectful toString lives on the implementor.
export function ifaceTemplate(e: Entry): string { return \`entry: \${e}\`; }
export function ifaceConcat(e: Entry): string { return "entry: " + e; }
export function ifaceString(e: Entry): string { return String(e); }
export function ifaceJson(e: Entry): string { return JSON.stringify(e); }
export function baseTemplate(b: Base): string { return \`b: \${b}\`; }

// (2) SINK: the library stringifies the argument internally.
export function consoleFmt(e: Entry): void { console.log("entry: %s", e); }
export function consoleBare(e: Entry): void { console.error(e); }
export function joinElems(es: Entry[]): string { return es.join(", "); }
export function templateArray(es: Entry[]): string { return \`all: \${es}\`; }
export function jsonArray(es: Entry[]): string { return JSON.stringify(es); }

// NO FABRICATION.
export function purePlainTemplate(s: string): string { return \`hi \${s}\`; }
export function pureNumTemplate(n: number): string { return \`n=\${n}\`; }
export function pureIfaceTemplate(p: PureEntry): string { return \`p: \${p}\`; }
export function pureConsoleString(s: string): void { console.log("x %s", s); }
export function pureConsoleLib(dt: Date): void { console.log("d %s", dt); }
export function pureJoinStrings(xs: string[]): string { return xs.join("/"); }`,
  });
  const { report } = scan(d);
  const eff = (fn) => entry(report, fn)?.inferred ?? [];
  // (1) DISPATCH — CHA over the interface's/base's LOCAL implementors.
  check("stringify-vein: template over an INTERFACE-typed operand carries the impl's Fs",
        eff("src.a.ifaceTemplate").includes("Fs"), JSON.stringify(eff("src.a.ifaceTemplate")));
  check("stringify-vein: concat over an INTERFACE-typed operand carries Fs",
        eff("src.a.ifaceConcat").includes("Fs"), JSON.stringify(eff("src.a.ifaceConcat")));
  check("stringify-vein: String() over an INTERFACE-typed operand carries Fs",
        eff("src.a.ifaceString").includes("Fs"), JSON.stringify(eff("src.a.ifaceString")));
  check("stringify-vein: JSON.stringify over an INTERFACE-typed operand carries the impl's toJSON Fs",
        eff("src.a.ifaceJson").includes("Fs"), JSON.stringify(eff("src.a.ifaceJson")));
  check("stringify-vein: template over a BASE-CLASS-typed operand carries the subclass override's Fs",
        eff("src.a.baseTemplate").includes("Fs"), JSON.stringify(eff("src.a.baseTemplate")));
  // (2) SINK — the HikariCP/SLF4J shape, and the array-element shape.
  check("stringify-vein: console.log(\"%s\", e) carries the argument's toString Fs (the HikariCP shape)",
        eff("src.a.consoleFmt").includes("Fs"), JSON.stringify(eff("src.a.consoleFmt")));
  check("stringify-vein: console.error(e) with an object argument carries Fs",
        eff("src.a.consoleBare").includes("Fs"), JSON.stringify(eff("src.a.consoleBare")));
  check("stringify-vein: arr.join() carries the ELEMENT's toString Fs",
        eff("src.a.joinElems").includes("Fs"), JSON.stringify(eff("src.a.joinElems")));
  check("stringify-vein: a template over an ARRAY carries the element's toString Fs",
        eff("src.a.templateArray").includes("Fs"), JSON.stringify(eff("src.a.templateArray")));
  check("stringify-vein: JSON.stringify(arr) carries the element's toJSON Fs",
        eff("src.a.jsonArray").includes("Fs"), JSON.stringify(eff("src.a.jsonArray")));
  // NO FABRICATION — the mechanism must be inert on the overwhelming majority of real sites.
  check("no-fabrication: a plain template over a STRING stays pure",
        eff("src.a.purePlainTemplate").length === 0, JSON.stringify(eff("src.a.purePlainTemplate")));
  check("no-fabrication: a template over a NUMBER stays pure",
        eff("src.a.pureNumTemplate").length === 0, JSON.stringify(eff("src.a.pureNumTemplate")));
  check("no-fabrication: a PURE toString reached by interface-CHA contributes nothing",
        eff("src.a.pureIfaceTemplate").length === 0, JSON.stringify(eff("src.a.pureIfaceTemplate")));
  check("no-fabrication: console.log of a string stays pure",
        eff("src.a.pureConsoleString").length === 0, JSON.stringify(eff("src.a.pureConsoleString")));
  check("no-fabrication: console.log of a LIBRARY-typed value (Date) stays pure",
        eff("src.a.pureConsoleLib").length === 0, JSON.stringify(eff("src.a.pureConsoleLib")));
  check("no-fabrication: joining an array of strings stays pure",
        eff("src.a.pureJoinStrings").length === 0, JSON.stringify(eff("src.a.pureJoinStrings")));
}

// ── 2f-ter. The stringifying-SINK table on an EXTERNAL logger (the direct SLF4J analogue) ──────────
// A logging level-method on an EXTERNAL receiver (pino/winston/bunyan) formats its arguments, running
// the argument's toString/toJSON inside the library — the exact shape the vein was found on. A LOCAL
// logger is NOT treated as a sink: its body is walked, so its stringification is already ordinary code.
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
import { logger } from "extlogger";
interface Entry { state(): number; }
class EffEntry implements Entry {
  state(): number { return 1; }
  toString(): string { fsm.appendFileSync("/tmp/x", "s"); return "e"; }
}
export function viaExternalLogger(e: Entry): void { logger.info("entry %s", e); }
export function viaExternalLoggerPrimitive(n: number): void { logger.info("n %s", n); }`,
    "node_modules/extlogger/package.json": `{"name":"extlogger","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
    "node_modules/extlogger/index.d.ts": `export interface Logger { info(msg: string, ...rest: unknown[]): void; }
export declare const logger: Logger;`,
    "node_modules/extlogger/index.js": `exports.logger = { info(){} };`,
  });
  const { report } = scan(d);
  const eff = (fn) => entry(report, fn)?.inferred ?? [];
  check("stringify-vein: an EXTERNAL logger level-method carries the argument's toString Fs",
        eff("src.a.viaExternalLogger").includes("Fs"), JSON.stringify(eff("src.a.viaExternalLogger")));
  check("no-fabrication: an external logger call with a primitive argument gains no Fs",
        !eff("src.a.viaExternalLoggerPrimitive").includes("Fs"),
        JSON.stringify(eff("src.a.viaExternalLoggerPrimitive")));
}

// ── 2f-quater. IMPLICIT COERCION ACROSS THE SCAN BOUNDARY ─────────────────────────────────────────
// candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md. §2f/§2f-bis close the vein INSIDE one
// project; split the same code across a package boundary and scan the dependency separately — the
// arrangement candor's own docs recommend — and it reappeared. A coercion is not a CallExpression, and
// the cross-package join + κ ledger both live in the CallExpression handler, so `` `${e}` `` on a
// DEPENDENCY class whose `toString` writes a file yielded NOTHING: no effect, no Unknown, no
// `invisible`. The dep's report already carried the answer under `depkit#Entry.toString`.
//
// It was GATE-level, not report-level: `deny Fs` went exit 1 (correct) → exit 0 (a false all-clear) on
// identical source. Both halves are pinned here: the chained join recovers the effect, and the
// UNCHAINED scan discloses the package instead of claiming purity.
if (blk()) {
  const depSrc = `import * as fsm from "node:fs";
export class Entry {
  toString(): string { fsm.appendFileSync("/tmp/x", "s"); return "e"; }
  toJSON(): object { fsm.appendFileSync("/tmp/x", "j"); return {}; }
}
export class Plain { label(): string { return "p"; } }`;
  // the dependency, scanned on its own — its report hashes under `depkit#Entry.toString`
  const depDir = project({ "package.json": `{"name":"depkit","version":"1.0.0"}`, "src/index.ts": depSrc });
  const { prefix: depPrefix } = scan(depDir);
  const depReport = JSON.parse(fs.readFileSync(`${depPrefix}.json`, "utf8"));
  check("the DEPENDENCY's own report holds the answer under `depkit#Entry.toString`",
        depReport.functions.some((e) => e.hash === "depkit#Entry.toString" && e.inferred.includes("Fs")),
        JSON.stringify(depReport.functions));

  const appFiles = {
    "package.json": `{"name":"app","version":"1.0.0"}`,
    "src/m.ts": `import { Entry, Plain } from "depkit";
export function describe(e: Entry): string { return \`\${e}\`; }
export function stringify(e: Entry): string { return String(e); }
export function jsonify(e: Entry): string { return JSON.stringify(e); }
export function joinAll(es: Entry[]): string { return es.join(", "); }
export function plainly(p: Plain): string { return \`\${p}\`; }
export function strs(a: string, b: string): string { return a + b; }`,
    "node_modules/depkit/package.json": `{"name":"depkit","version":"1.0.0","types":"dist/index.d.ts","main":"dist/index.js"}`,
    "node_modules/depkit/dist/index.d.ts": `export declare class Entry { toString(): string; toJSON(): object; }
export declare class Plain { label(): string; }`,
    "node_modules/depkit/dist/index.js": `exports.Entry = class {}; exports.Plain = class {};`,
  };
  // (a) CHAINED — the dep's report is available, so the boundary must be transparent.
  const app = project(appFiles);
  fs.writeFileSync(path.join(app, "deny.policy"), "deny Fs\n");
  const chained = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "deny.policy")],
                            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  const crep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const ceff = (fn) => entry(crep, fn)?.inferred ?? [];
  check("boundary: a chained dep's toString reaches a TEMPLATE LITERAL",
        ceff("src.m.describe").includes("Fs"), JSON.stringify(crep.functions));
  check("boundary: ...and String(x)", ceff("src.m.stringify").includes("Fs"), JSON.stringify(ceff("src.m.stringify")));
  check("boundary: ...and JSON.stringify(x) via toJSON",
        ceff("src.m.jsonify").includes("Fs"), JSON.stringify(ceff("src.m.jsonify")));
  check("boundary: ...and Array.join, which coerces every ELEMENT",
        ceff("src.m.joinAll").includes("Fs"), JSON.stringify(ceff("src.m.joinAll")));
  check("boundary: the `deny Fs` gate is exit 1 again (was exit 0 — a false all-clear)",
        chained.status === 1, `status=${chained.status} ${chained.stdout}`);
  // NO FABRICATION: a dep class that declares NO coercion member inherits the provably-pure es-lib
  // `Object.prototype.toString`, so it resolves to nothing — the property that keeps this from turning
  // every template literal over every dependency type into a finding.
  check("no-fabrication: a dep type declaring no toString stays pure",
        entry(crep, "src.m.plainly") == null, JSON.stringify(entry(crep, "src.m.plainly")));
  check("no-fabrication: string+string stays pure", entry(crep, "src.m.strs") == null,
        JSON.stringify(entry(crep, "src.m.strs")));

  // (b) UNCHAINED — no dep report, so the effect is genuinely unknowable here; it must be DISCLOSED as
  // a blind package, never absorbed into a confident pure verdict.
  const app2 = project(appFiles);
  const { report: urep } = scan(app2);
  check("boundary, unchained: the coercion discloses the dep package as invisible",
        entry(urep, "src.m.describe")?.invisible?.includes("depkit"), JSON.stringify(urep.functions));
  check("boundary, unchained: ...and it reaches the κ-coverage ledger",
        urep.coverage?.uncovered?.some((u) => u.name === "depkit"), JSON.stringify(urep.coverage));

  // (c) the CONTROL the whole vein is defined against: the same code in ONE project. The chained result
  // must equal it — that equality IS the property, not the effect list in isolation.
  const ctl = project({ "package.json": `{"name":"ctl","version":"1.0.0"}`, "src/depkit.ts": depSrc,
    "src/m.ts": appFiles["src/m.ts"].replace(`"depkit"`, `"./depkit"`) });
  const { report: ctlrep } = scan(ctl);
  for (const fn of ["describe", "stringify", "jsonify", "joinAll"])
    check(`boundary: split+chained matches the one-project control for ${fn}`,
          JSON.stringify(ceff(`src.m.${fn}`)) === JSON.stringify(entry(ctlrep, `src.m.${fn}`)?.inferred ?? []),
          `chained=${JSON.stringify(ceff(`src.m.${fn}`))} control=${JSON.stringify(entry(ctlrep, `src.m.${fn}`)?.inferred)}`);
}

// ── 2f-quinquies. `new DepClass()` ACROSS the scan boundary ───────────────────────────────────────
// Same vein, second mechanism. Every scan mints a `Class.constructor` unit — explicit ctor or not,
// because field initializers execute at construction — so a dependency's report DOES carry
// `<pkg>#<Class>.constructor`. The consumer never asked for it: the cross-package join keys on
// `decl.name`, and a ConstructorDeclaration has no name, so the tail was null and the lookup skipped;
// the implicit-ctor arm (no resolved declaration at all) never consulted the chain either. An effectful
// dependency constructor was absorbed silently at every `new` across the boundary.
if (blk()) {
  const depSrc = `import * as fsm from "node:fs";
export class Boot { constructor() { fsm.appendFileSync("/tmp/x", "b"); } }
export class Lazy { x: string = fsm.readFileSync("/tmp/y", "utf8"); }
export class Idle { label(): string { return "i"; } }`;
  const depDir = project({ "package.json": `{"name":"ctorkit","version":"1.0.0"}`, "src/index.ts": depSrc });
  const { prefix: depPrefix } = scan(depDir);
  const appFiles = {
    "package.json": `{"name":"capp","version":"1.0.0"}`,
    "src/m.ts": `import { Boot, Lazy, Idle } from "ctorkit";
export function boot(): Boot { return new Boot(); }
export function lazy(): Lazy { return new Lazy(); }
export function idle(): Idle { return new Idle(); }`,
    "node_modules/ctorkit/package.json": `{"name":"ctorkit","version":"1.0.0","types":"dist/index.d.ts","main":"dist/index.js"}`,
    // Boot declares its ctor (the named-declaration arm); Lazy and Idle do not (the implicit-ctor arm).
    "node_modules/ctorkit/dist/index.d.ts": `export declare class Boot { constructor(); }
export declare class Lazy { x: string; }
export declare class Idle { label(): string; }`,
    "node_modules/ctorkit/dist/index.js": `exports.Boot = class {}; exports.Lazy = class {}; exports.Idle = class {};`,
  };
  const app = project(appFiles);
  fs.writeFileSync(path.join(app, "deny.policy"), "deny Fs\n");
  const chained = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "deny.policy")],
                            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  const crep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const ceff = (fn) => entry(crep, fn)?.inferred ?? [];
  check("boundary: `new DepClass()` with a DECLARED ctor inherits the dep's constructor effects",
        ceff("src.m.boot").includes("Fs"), JSON.stringify(crep.functions));
  check("boundary: ...and with an IMPLICIT ctor (a dep field initializer) too",
        ceff("src.m.lazy").includes("Fs"), JSON.stringify(ceff("src.m.lazy")));
  check("no-fabrication: constructing a PURE dep class stays pure",
        entry(crep, "src.m.idle") == null, JSON.stringify(entry(crep, "src.m.idle")));
  check("boundary: the `deny Fs` gate is exit 1 again for `new DepClass()`",
        chained.status === 1, `status=${chained.status} ${chained.stdout}`);
  // Unchained the construction is unknowable, and must stay DISCLOSED rather than confidently pure —
  // the behaviour that was already correct here, pinned so the join did not quietly replace it.
  const { report: urep } = scan(project(appFiles));
  check("boundary, unchained: `new DepClass()` still discloses the package",
        entry(urep, "src.m.boot")?.invisible?.includes("ctorkit"), JSON.stringify(urep.functions));
}

// ── 2f-sexies. A DEP function passed BY REFERENCE to an invoking HOF ──────────────────────────────
// Same vein, third mechanism. `xs.forEach(depWrite)` / `setTimeout(depWrite, 0)`: the HOF calls it, so
// its effects are reachable — but the ref got neither an edge (no local unit) nor an Unknown. The
// opaque-callback Unknown is suppressed for a ref that resolves to a concrete declaration, on the stated
// grounds that "dep calls flow through the κ/invisible channel" — and that channel is the CallExpression
// handler, which a by-reference pass never enters. The result was silent-pure on BOTH sides of the
// boundary: no effect chained, no disclosure unchained.
if (blk()) {
  const depSrc = `import * as fsm from "node:fs";
export function writeIt(x: string): void { fsm.appendFileSync("/tmp/x", x); }
export function pureIt(x: string): string { return x.trim(); }
export function map<T, R>(xs: T[], fn: (x: T) => R): R[] { return xs.map(fn); }`;
  const depDir = project({ "package.json": `{"name":"hofkit","version":"1.0.0"}`, "src/index.ts": depSrc });
  const { prefix: depPrefix } = scan(depDir);
  const appFiles = {
    "package.json": `{"name":"happ","version":"1.0.0"}`,
    "src/m.ts": `import { writeIt, pureIt, map, forEach, filter, reduce, groupBy, find, sort, every, anyHof, anyHof2 } from "hofkit";
import { localWrite } from "./local.js";
export function viaForEach(xs: string[]): void { xs.forEach(writeIt); }
export function viaTimeout(): void { setTimeout(writeIt, 0); }
export function viaPureRef(xs: string[]): string[] { return xs.map(pureIt); }
export function viaStore(xs: string[], sink: unknown[]): void { sink.push(writeIt); }
// POSITION. forEach's SECOND argument is thisArg — bound as this, never invoked. The by-reference dep
// charge originally ran ABOVE the position guard and so fired at every argument index, charging a
// non-callback dep ref's effects to the caller.
export function viaThisArg(xs: string[]): void { xs.forEach(pureIt, writeIt); }
// ...and the OTHER direction. then(onFulfilled, onRejected) invokes its SECOND argument on rejection, so
// a dep callback there IS reachable. A blanket arg-0 position rule drops it — a miss, not an over-charge.
export function viaThenReject(p: Promise<string>): void { p.then(pureIt, writeIt); }
// STATIC/FREE FORM: the collection is first and the callback SECOND. calleeName cannot tell _.map from
// xs.map, so a hand-written position map dropped these entirely. The CALLEE's parameter type can.
export function viaStaticForm(xs: string[]): unknown[] { return map(xs, writeIt); }
// ...and the .bind arm obeys the same position rule: a bound dep fn in the thisArg slot is not invoked.
export function viaBindThisArg(xs: string[]): void { xs.forEach(pureIt, writeIt.bind(null)); }
// The same shape with a LOCAL writer. A dep ref in this slot can only ever produce Unknown here (the
// .bind arm resolves refs to project UNITS, and a dep fn is not one), so an assertion about Fs on the
// line above cannot fail whatever the gate does — a local one can.
export function viaBindThisArgLocal(xs: string[]): void { xs.forEach(pureIt, localWrite.bind(null)); }
// ...but the position rule may only DROP on positive evidence. A dependency's free-form HOF whose
// published typings declare "fn: any" says nothing about whether it invokes that position, and the
// .bind arm read that silence as "not a callback" — dropping the bound writer entirely.
export function viaLooseStaticBind(xs: string[]): void { forEach(xs, localWrite.bind(null)); }
// CONTROL for the same shape at the position the NAME MAP owns: it never consulted the signature, so
// it must stay charged however loosely the callee is typed.
export function viaLooseBindArg0(xs: string[]): void { filter(localWrite.bind(null), xs); }
// ── the BY-REFERENCE arm's form of the same hole, and the SEED rows that bound the fix ─────────────
// NO FABRICATION FIRST. The free form relocates the name map by exactly ONE place — it does not
// charge every position the signature happens to be silent about. The SEED of a fold is argument 2,
// it is a function VALUE the fold never invokes, and the naive three-valued widening ("charge
// wherever calleeParamIsCallable returns null") charges it.
export function viaFreeSeedDep(xs: string[], cb: any): any { return reduce(xs, cb, writeIt); }
// ...and the METHOD form is not relocated at all: argument 0 is positively the callback, so the map
// is CONFIRMED rather than merely assumed, and zod's path.reduce(fn, obj) seed stays out.
export function viaMethodSeed(xs: string[], seed: any): any { return xs.reduce((a: any) => a, seed); }
// ...and the relocation must exclude any. checker.isArrayLikeType(any) is TRUE, so a relocation that
// does not put the RECEIVER SLOT of a loosely-typed METHOD-form HOF inside the map — which silences
// the thisArg denylist b66b69a landed one commit earlier.
export function viaAnyHofThisArg(): void { anyHof.forEach(pureIt, localWrite); }
// ...and the same any at parameter 0 with a second parameter the thisArg denylist does NOT name, so
// the top-of-loop drop cannot fire and the relocation is what decides. This is the row the any
// exclusion answers for; the thisArg row above is answered by the denylist itself.
export function viaAnyHofExtra(): void { anyHof2.forEach(pureIt, writeIt); }
// ...and the relocation is the WEAKEST of the three evidences, so the signature may VETO it. Argument 1
// is declared a string; the relocation names that position and must not win.
export function viaFreeTypedNonCallbackDep(xs: string[]): any { return groupBy(xs, writeIt); }
// ...and the DROP arm must not share the relocated set at all: it already demands positive evidence,
// and a relocation inferred from a convention overruling that charges the bound writer in the slot.
export function viaFreeTypedNonCallbackBind(xs: string[]): any { return groupBy(xs, localWrite.bind(null)); }
// ...and a UNION at parameter 0 is the relocated receiver only if EVERY constituent is. A string carries
// [Symbol.iterator], so an any-constituent test read TypeORM's EntityTarget<T> as a collection and
// relocated the map onto its options argument — 68 firings on a production tree, all 68 wrong.
export function viaUnionParam0(xs: string[]): any { return find(xs, writeIt); }
// ...and a bare string is not one either, for the same reason and on its own.
export function viaStringParam0(): any { return sort("abc", writeIt); }
// THE REACH. A dep fn passed BY REFERENCE at a position a loosely-typed collection-first HOF does not
// declare: the map assumes position 0, the signature says any, and the arm returned early on the
// POSITIVE test — so "I could not tell" meant the dep's concrete Fs was dropped.
export function viaLooseStaticRef(xs: string[]): void { forEach(xs, writeIt); }
// ...and a collection is not only an array. Object.groupBy/Map.groupBy declare Iterable<T>, and a Set
// is array-LIKE to nobody — the iterator member is what says "collection", so the relocation must read
// it or the whole static-form family narrows to arrays.
export function viaIterableParam0(s: Set<string>): boolean { return every(s, writeIt); }
export function viaBoolean(xs: (string | null)[]): unknown[] { return xs.filter(Boolean); }
export function viaString(xs: number[]): string[] { return xs.map(String); }`,
    "src/local.ts": `import * as fsm from "node:fs";
export function localWrite(x: string): void { fsm.appendFileSync("/tmp/y", x); }`,
    "node_modules/hofkit/package.json": `{"name":"hofkit","version":"1.0.0","types":"dist/index.d.ts","main":"dist/index.js"}`,
    "node_modules/hofkit/dist/index.d.ts": `export declare function writeIt(x: string): void;
export declare function pureIt(x: string): string;
export declare function forEach(xs: any[], fn: any): void;
export declare function filter(fn: any, xs: any[]): any[];
export declare function reduce(xs: any[], fn: any, seed: any): any;
export declare function groupBy(xs: any[], key: string): any;
export declare function find(target: any[] | { n: number }, opts: any): any;
export declare function sort(target: string, opts: any): any;
export declare function every(xs: Iterable<string>, fn: any): boolean;
export declare const anyHof: { forEach(fn: any, thisArg?: any): void };
export declare const anyHof2: { forEach(fn: any, extra?: any): void };`,
    "node_modules/hofkit/dist/index.js": `exports.writeIt = () => {}; exports.pureIt = (x) => x;`,
  };
  const app = project(appFiles);
  fs.writeFileSync(path.join(app, "deny.policy"), "deny Fs\n");
  const chained = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "deny.policy")],
                            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  const crep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const ceff = (fn) => entry(crep, fn)?.inferred ?? [];
  check("boundary: a dep fn passed to forEach carries the dep's effects",
        ceff("src.m.viaForEach").includes("Fs"), JSON.stringify(crep.functions));
  check("boundary: ...and to setTimeout", ceff("src.m.viaTimeout").includes("Fs"),
        JSON.stringify(ceff("src.m.viaTimeout")));
  check("boundary: the `deny Fs` gate is exit 1 again for a by-reference dep callback",
        chained.status === 1, `status=${chained.status} ${chained.stdout}`);
  // NO FABRICATION. Three shapes that must stay untouched: a PURE dep fn (the dep's report omits it —
  // silence is its purity claim), a STORE sink that never invokes its argument (`push` is not an invoking
  // HOF), and the pure global coercion constructors this arm deliberately lets through to the ES lib.
  check("no-fabrication: a PURE dep fn by reference stays pure", entry(crep, "src.m.viaPureRef") == null,
        JSON.stringify(entry(crep, "src.m.viaPureRef")));
  check("no-fabrication: a dep fn merely STORED (push) is not charged", entry(crep, "src.m.viaStore") == null,
        JSON.stringify(entry(crep, "src.m.viaStore")));
  check("no-fabrication: .filter(Boolean) stays pure", entry(crep, "src.m.viaBoolean") == null,
        JSON.stringify(entry(crep, "src.m.viaBoolean")));
  check("no-fabrication: .map(String) stays pure", entry(crep, "src.m.viaString") == null,
        JSON.stringify(entry(crep, "src.m.viaString")));
  check("no-fabrication: a dep ref in forEach's thisArg slot is never invoked, so it is not charged",
        entry(crep, "src.m.viaThisArg") == null, JSON.stringify(entry(crep, "src.m.viaThisArg")));
  check("boundary: then()'s SECOND callback is invoked on rejection, so its dep effects are reachable",
        ceff("src.m.viaThenReject").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaThenReject")));
  // NOT asserted here: the STATIC-form case (`map(xs, writeIt)` — collection first, callback second).
  // The fix is verified on a standalone two-package fixture where the dependency sits in node_modules
  // (viaStatic: ['Unknown'] before, ['Fs', 'Unknown'] after). In THIS harness the dep is placed such that
  // the callee resolves local, so the non-local HOF gate never opens and the case cannot be exercised —
  // a fixture limitation, not engine behaviour. Left unasserted rather than asserted-and-skipped, and
  // recorded in SCAN-BOUNDARY-WORK-QUEUE.md so it is not mistaken for coverage.
  // The receiver-slot guard, asserted so it can actually FAIL. Mutating the guard out left the suite
  // 766/0: the assertion here was `!includes("Fs")` on a DEP ref, and that arm's only possible output
  // is an Unknown disclosure — the shape it was written to catch (['Unknown'] before the guard, pure
  // after) was invisible to it. Assert the ENTRY's absence for the dep form, and add a LOCAL writer
  // whose fabrication shows up as the concrete Fs.
  check("no-fabrication: a BOUND dep fn in the thisArg slot is not invoked, so nothing is disclosed",
        entry(crep, "src.m.viaBindThisArg") == null, JSON.stringify(entry(crep, "src.m.viaBindThisArg")));
  check("no-fabrication: ...and a bound LOCAL writer in that slot is not charged either",
        entry(crep, "src.m.viaBindThisArgLocal") == null, JSON.stringify(entry(crep, "src.m.viaBindThisArgLocal")));
  // ...and the SECOND DIRECTION of the very same guard. `!hofInvokesArg(...)` is a positive test used to
  // return early, so "the signature told me nothing" meant SILENCE: a dependency's free-form
  // `forEach(xs: any[], fn: any)` dropped a `.bind`-wrapped local writer, and a scoped `deny Fs` went
  // from exit 1 to exit 0. `any` at a parameter is NO evidence — only the named receiver slot
  // (`thisArg`) is evidence, which is what the check above pins. Charge unless positively told not to.
  check("boundary: a LOOSELY-TYPED free-form HOF still invokes its bound callback",
        ceff("src.m.viaLooseStaticBind").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaLooseStaticBind")));
  check("boundary: ...and the name map's own position never depended on the signature",
        ceff("src.m.viaLooseBindArg0").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaLooseBindArg0")));
  // The GATE form of the same defect — the reason it is a cardinal sin and not a precision loss.
  fs.writeFileSync(path.join(app, "scoped.policy"), "deny Fs src.m.viaLooseStaticBind\n");
  const scoped = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "scoped.policy")],
                           { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  check("boundary: a scoped `deny Fs` is exit 1 for a bound callback under a loosely-typed HOF",
        scoped.status === 1, `status=${scoped.status} ${scoped.stdout}`);
  // ── the BY-REFERENCE arm's form of the same hole. NO-FABRICATION ROWS FIRST: each one is a shape a
  // widening could reach that this one must not, and each was measured to FAIL under a mutant.
  // A widening that charges wherever `calleeParamIsCallable` returns `null` charges the fold's SEED —
  // a function VALUE at a position the fold never invokes. `reduce`'s relocated map is {0,1}; the seed
  // is argument 2 and stays out.
  check("no-fabrication: a free-form fold's SEED is not a callback, however loosely it is typed",
        !ceff("src.m.viaFreeSeedDep").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaFreeSeedDep")));
  // The METHOD form is not relocated at all — its argument 0 is positively the callback, so the name
  // map is confirmed rather than merely assumed. This is the zod `path.reduce(fn, obj)` shape that
  // guard (1) was written for, and the only thing standing between it and a fabricated disclosure.
  check("no-fabrication: the METHOD form's seed discloses nothing (the zod path.reduce shape)",
        entry(crep, "src.m.viaMethodSeed") == null, JSON.stringify(entry(crep, "src.m.viaMethodSeed")));
  // `checker.isArrayLikeType(any)` is TRUE, so a relocation that does not exclude `any` fires on a
  // loosely-typed METHOD-form HOF and pulls the RECEIVER SLOT into the map — silencing the `thisArg`
  // denylist landed one commit earlier. A fix undoing its predecessor, caught by measuring the predicate.
  check("no-fabrication: an `any`-typed parameter 0 does not defeat the thisArg denylist",
        !ceff("src.m.viaAnyHofThisArg").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaAnyHofThisArg")));
  check("no-fabrication: ...and an `any` parameter 0 is not a relocated receiver at an undenied slot",
        !ceff("src.m.viaAnyHofExtra").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaAnyHofExtra")));
  check("no-fabrication: a POSITIVELY typed non-callback outranks the relocated position",
        !ceff("src.m.viaFreeTypedNonCallbackDep").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaFreeTypedNonCallbackDep")));
  check("no-fabrication: ...and the DROP arm does not consult the relocated set at all",
        !ceff("src.m.viaFreeTypedNonCallbackBind").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaFreeTypedNonCallbackBind")));
  check("no-fabrication: a UNION at parameter 0 relocates only if EVERY constituent is a collection",
        !ceff("src.m.viaUnionParam0").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaUnionParam0")));
  check("no-fabrication: ...and a bare `string` is iterable but is not a relocated receiver",
        !ceff("src.m.viaStringParam0").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaStringParam0")));
  // THE REACH. Same predicate, same argument, same position — and the LOCAL half of it was charged all
  // along (`viaLooseStaticBind` above), because the local edge arm sits ABOVE guard (1) and the dep
  // charge sits below it. Two rules on one argument list, disagreeing only about which tree the
  // referent lives in, which is what makes it a boundary defect rather than a limitation.
  check("boundary: a dep fn BY REFERENCE under a loosely-typed collection-first HOF carries its effects",
        ceff("src.m.viaLooseStaticRef").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaLooseStaticRef")));
  check("boundary: ...and an Iterable at parameter 0 is a relocated receiver too (Object.groupBy's shape)",
        ceff("src.m.viaIterableParam0").includes("Fs"), JSON.stringify(entry(crep, "src.m.viaIterableParam0")));
  fs.writeFileSync(path.join(app, "ref.policy"), "deny Fs src.m.viaLooseStaticRef\n");
  const refGate = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "ref.policy")],
                            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  check("boundary: a scoped `deny Fs` is exit 1 for a by-reference callback under a loose free-form HOF",
        refGate.status === 1, `status=${refGate.status} ${refGate.stdout}`);
  // THE CONTROL. The identical shape with the HOF and the writer in ONE tree: the non-local arm never
  // opens, the precise callback-flow resolves it, and the gate is exit 1 in BOTH arms. Without this the
  // row above could be a general limitation of loose typings rather than a boundary defect.
  const oneTree = project({
    "package.json": `{"name":"honeapp","version":"1.0.0"}`,
    "src/hof.ts": `export function forEach(xs: any[], fn: any): void { for (const x of xs) fn(x); }`,
    "src/w.ts": `import * as fsm from "node:fs";
export function writeIt(x: string): void { fsm.appendFileSync("/tmp/x", x); }`,
    "src/m.ts": `import { forEach } from "./hof.js";
import { writeIt } from "./w.js";
export function viaLooseStaticRef(xs: string[]): void { forEach(xs, writeIt); }
// ...and a collection is not only an array. Object.groupBy/Map.groupBy declare Iterable<T>, and a Set
// is array-LIKE to nobody — the iterator member is what says "collection", so the relocation must read
// it or the whole static-form family narrows to arrays.
export function viaIterableParam0(s: Set<string>): boolean { return every(s, writeIt); }`,
  });
  fs.writeFileSync(path.join(oneTree, "ref.policy"), "deny Fs src.m.viaLooseStaticRef\n");
  const oneGate = spawnSync("node", [path.join(HERE, "scan.mjs"), oneTree, "--policy", path.join(oneTree, "ref.policy")],
                            { encoding: "utf8" });
  check("boundary control: the SAME shape inside ONE tree is exit 1 in both arms",
        oneGate.status === 1, `status=${oneGate.status} ${oneGate.stdout}`);
  // Unchained the dep's body is unknowable — disclose the package rather than claim purity.
  const { report: urep } = scan(project(appFiles));
  check("boundary, unchained: a by-reference dep callback discloses the package",
        entry(urep, "src.m.viaForEach")?.invisible?.includes("hofkit"), JSON.stringify(urep.functions));
  check("no-fabrication, unchained: .filter(Boolean) still discloses nothing",
        entry(urep, "src.m.viaBoolean") == null, JSON.stringify(entry(urep, "src.m.viaBoolean")));
}

// ── 2f-septies. THE CACHE THAT WAS NEVER CLEARED ──────────────────────────────────────────────────
// `.candor/dep-inits/` and `.candor/deps/` are write-only caches. A package whose rescan THREW was
// therefore answered from the PREVIOUS run's file, while the `catch` that swallowed the failure said in
// its own comment that the dep "is skipped" — candor-spec SCAN-BOUNDARY-WORK-QUEUE.md, filed
// ABSENT-BY-ACCIDENT, and the same class as candor-swift `43a0eaa`.
//
// The failure lever is the ordinary published shape, not a contrivance: the file walk excludes `*.d.ts`
// and `*.min.js`, so a package shipping typings plus a minified bundle exits 2 on "no TypeScript
// sources" while still RESOLVING for its consumer. Measured on five real packages in the A/B corpus.
if (blk()) {
  const appFiles = {
    "package.json": `{"name":"t2app","version":"1.0.0","dependencies":{"stalekit":"1.0.0"}}`,
    "src/m.ts": `import { hot } from "stalekit";
export function useHot(): void { hot("x"); }`,
    "node_modules/stalekit/package.json": `{"name":"stalekit","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
    "node_modules/stalekit/index.d.ts": `export declare function hot(x: string): void;`,
    // v1: a body candor can read, and it is PURE — so the cached report's SILENCE is a purity claim.
    "node_modules/stalekit/index.js": `export function hot(x) { return 1; }`,
  };
  const app = project(appFiles);
  const cache = (f) => path.join(app, ".candor", "dep-inits", f);
  const useHot = () => {
    const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
    return entry(rep, "src.m.useHot");
  };
  const run = () => spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--dep-inits"], { encoding: "utf8" });

  run();
  check("dep-inits cache: a scannable dependency is scanned and its report cached",
        fs.existsSync(cache("stalekit.json")), fs.readdirSync(path.join(app, ".candor", "dep-inits")).join(","));
  check("dep-inits cache: ...and the chained report's silence is the dep's purity claim",
        useHot() == null, JSON.stringify(useHot()));

  // NO-DELETION FIRST. A report the USER placed for a package this run never discovered is not a
  // deletion candidate — the sweep that fixed swift's version of this destroyed exactly these
  // (candor-swift `b4f6cbc`), and they are unrecoverable.
  fs.writeFileSync(cache("notacandidate.json"),
    JSON.stringify({ candor: { version: "whatever" }, package: "notacandidate", functions: [] }));

  // The package is upgraded to a MINIFIED build: same typings, so the consumer still resolves `hot`,
  // but nothing candor can analyze — the rescan exits 2 and the `catch` swallows it.
  fs.rmSync(path.join(app, "node_modules", "stalekit", "index.js"));
  fs.writeFileSync(path.join(app, "node_modules", "stalekit", "index.min.js"),
    `import fs from "node:fs";export function hot(x){fs.appendFileSync("/tmp/hot",x)}`);
  const r2 = run();
  // THE DEFECT, in the cardinal-sin direction: the on-disk body writes a file, and the consumer was
  // reading a PURITY CLAIM sourced entirely from the previous run's report about source that is gone.
  check("dep-inits cache: a package whose rescan THREW is not answered from the previous run's file",
        useHot()?.invisible?.includes("stalekit"), JSON.stringify(useHot()));
  check("dep-inits cache: ...the stale cached report is removed, not merely ignored",
        !fs.existsSync(cache("stalekit.json")), fs.readdirSync(path.join(app, ".candor", "dep-inits")).join(","));
  check("dep-inits cache: ...and it says so on stderr rather than going quiet",
        /could not scan stalekit/.test(r2.stderr), r2.stderr);
  // …and the other direction of the same sweep.
  check("no-deletion: a report candor did not write is never a deletion candidate",
        fs.existsSync(cache("notacandidate.json")), fs.readdirSync(path.join(app, ".candor", "dep-inits")).join(","));

  // CONTROL. Restore the scannable build: the sweep must not fire, the cache must come back, and the
  // answer must be exactly what it was. Without this the rows above pass for a sweep that deletes
  // everything every run.
  fs.rmSync(path.join(app, "node_modules", "stalekit", "index.min.js"));
  fs.writeFileSync(path.join(app, "node_modules", "stalekit", "index.js"), `export function hot(x) { return 1; }`);
  fs.writeFileSync(path.join(app, "node_modules", "stalekit", "package.json"),
    `{"name":"stalekit","version":"1.0.0","types":"index.d.ts","main":"index.js"}`);
  const r3 = run();
  check("dep-inits cache control: a SUCCEEDING rescan keeps its cache and its answer",
        fs.existsSync(cache("stalekit.json")) && useHot() == null, JSON.stringify(useHot()));
  check("dep-inits cache control: ...and the sweep says nothing when nothing failed",
        !/could not scan/.test(r3.stderr), r3.stderr);
}

// ── 2f-septies (b). the same cache, reached through `--workspace` ─────────────────────────────────
// `.candor/deps/` is the dir `--workspace` writes AND the dir users point `CANDOR_DEPS` at, so both
// directions have to hold here at once: a failed path dep's stale report must go, and a hand-placed
// report for a non-path dependency must survive AND still chain.
if (blk()) {
  const app = project({
    "package.json": `{"name":"wapp","version":"1.0.0"}`,
    "src/m.ts": `import { pull } from "handdep";
import { run } from "sib";
export function useHand(): void { pull(); }
export function useSib(): void { run(); }`,
    "node_modules/handdep/package.json": `{"name":"handdep","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
    "node_modules/handdep/index.d.ts": `export declare function pull(): void;`,
    "node_modules/handdep/index.js": `exports.pull=()=>{};`,
  });
  // A real workspace path dep: a SYMLINK out of node_modules to a sibling source tree.
  const sib = project({
    "package.json": `{"name":"sib","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
    "index.d.ts": `export declare function run(): void;`,
    "index.ts": `import * as fsm from "node:fs";
export function run(): void { fsm.appendFileSync("/tmp/sib", "x"); }`,
  });
  fs.symlinkSync(sib, path.join(app, "node_modules", "sib"));
  const depsDir = path.join(app, ".candor", "deps");
  const run = () => spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--workspace"], { encoding: "utf8" });
  const eff = (fn) => {
    const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
    return entry(rep, fn);
  };

  run();
  check("workspace cache: a symlinked path dep is scanned and chained",
        eff("src.m.useSib")?.inferred?.includes("Fs"), JSON.stringify(eff("src.m.useSib")));
  // A hand-placed report for a package that is NOT a path dep — a real dir in node_modules, so it is
  // never a discovery candidate. This is the ordinary `CANDOR_DEPS`-into-`.candor/deps` setup.
  fs.writeFileSync(path.join(depsDir, "handdep.json"), JSON.stringify({
    candor: { version: JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version
      ? `candor-ts-${JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version}` : "x" },
    package: "handdep",
    functions: [{ fn: "index.pull", hash: "handdep#pull", inferred: ["Fs"], direct: ["Fs"] }],
  }));

  // The path dep loses its analyzable source (its `.d.ts` stays, so the consumer still resolves `run`).
  fs.rmSync(path.join(sib, "index.ts"));
  fs.rmSync(path.join(sib, "index.js"), { force: true });
  const r2 = run();
  check("workspace cache: a path dep whose rescan THREW is not answered from the previous run's file",
        !eff("src.m.useSib")?.inferred?.includes("Fs"), JSON.stringify(eff("src.m.useSib")));
  check("workspace cache: ...its stale report is removed",
        !fs.existsSync(path.join(depsDir, "sib.json")), fs.readdirSync(depsDir).join(","));
  // Named by the DERIVED package name, not the directory. The two differ here by construction — the
  // path dep's directory is a mkdtemp name and its manifest says `sib` — so the manifest-name source
  // is load-bearing for this row and the basename fallback cannot answer it by accident.
  check("workspace cache: ...and it names the PACKAGE on stderr, not the checkout directory",
        /could not scan sib\b/.test(r2.stderr), r2.stderr);
  // BOTH DIRECTIONS AT ONCE, which is the point of doing this in `.candor/deps` rather than a fixture dir.
  check("no-deletion: a hand-placed report in the workspace deps dir survives the sweep",
        fs.existsSync(path.join(depsDir, "handdep.json")), fs.readdirSync(depsDir).join(","));
  check("no-deletion: ...and is still chained",
        eff("src.m.useHand")?.inferred?.includes("Fs"), JSON.stringify(eff("src.m.useHand")));
}

// ── 2f-septies (b2). THE SWEEP DELETED THE FILE AND LEFT THE ANSWER ────────────────────────────────
// `95d0b8b` is right that a cached report this run did not write is not this run's answer, and it
// sweeps one. But it sweeps AFTER the fixpoint rounds have already run, and every child in those rounds
// is spawned with `CANDOR_DEPS` pointing at the SAME cache — so a sibling that scanned cleanly has
// already chained the report being deleted, and ITS cached report keeps that answer. The parent then
// chains the sibling. The file goes; the conclusion drawn from it survives one hop away.
//
// candor-swift `43a0eaa` re-runs its fixpoint once for exactly this reason. The workspace here is the
// two-hop shape that makes it visible: `libb` imports `liba`, and `liba` stops being scannable.
//
// THE CONTROL IS THE COLD ARM, and it is what makes this a cache defect rather than a limitation: the
// same source with no cache at all must give the same answer as the same source with one. A cache that
// changes the verdict is the whole bug, in either direction.
if (blk()) {
  const mkWorkspace = (ifaceForm) => {
    // The path dep at the far end. Two shapes, because they fail in OPPOSITE directions.
    const liba = project(ifaceForm ? {
      "package.json": `{"name":"liba","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export interface Fetcher { fetch(): void; }
export declare class Client implements Fetcher { fetch(): void; }`,
      "index.ts": `import * as fsm from "node:fs";
export interface Fetcher { fetch(): void; }
export class Client implements Fetcher { fetch(): void { fsm.appendFileSync("/tmp/liba", "x"); } }`,
    } : {
      "package.json": `{"name":"liba","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export declare function aWrite(): void;`,
      "index.ts": `export function aWrite(): void { /* pure, so the cached report's SILENCE is the claim */ }`,
    });
    // The SIBLING. It scans cleanly in every run; it is the carrier, not the casualty.
    const libb = project(ifaceForm ? {
      "package.json": `{"name":"libb","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export declare function useB(f: import("liba").Fetcher): void;`,
      "index.ts": `import type { Fetcher } from "liba";
export function useB(f: Fetcher): void { f.fetch(); }`,
    } : {
      "package.json": `{"name":"libb","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export declare function useB(): void;`,
      "index.ts": `import { aWrite } from "liba";
export function useB(): void { aWrite(); }`,
    });
    const app = project(ifaceForm ? {
      "package.json": `{"name":"wsapp","version":"1.0.0"}`,
      "src/m.ts": `import { useB } from "libb";
import type { Fetcher } from "liba";
export function callB(f: Fetcher): void { useB(f); }`,
    } : {
      "package.json": `{"name":"wsapp","version":"1.0.0"}`,
      "src/m.ts": `import { useB } from "libb";
export function callB(): void { useB(); }`,
    });
    fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
    fs.symlinkSync(liba, path.join(app, "node_modules", "liba"));
    fs.symlinkSync(libb, path.join(app, "node_modules", "libb"));
    // `libb` resolves `liba` through its own node_modules — a real workspace link, not the app's.
    fs.mkdirSync(path.join(libb, "node_modules"), { recursive: true });
    fs.symlinkSync(liba, path.join(libb, "node_modules", "liba"));
    return { app, liba, libb };
  };
  const runWs = (app, extra = []) =>
    spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--workspace", ...extra], { encoding: "utf8" });
  const appEntry = (app, fn) =>
    entry(JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")), fn);
  const depBytes = (app) => {
    const d = path.join(app, ".candor", "deps");
    return fs.readdirSync(d).sort().map((f) => `${f}:${fs.readFileSync(path.join(d, f), "utf8")}`).join("\n");
  };

  // ── THE NO-CHANGE FIXTURE, FIRST. A second fixpoint pass that alters a CLEAN run is the obvious cost
  // of this fix, so it is the row written before the defect's. Nothing here is stale, nothing is swept,
  // and the re-pass must not run at all.
  {
    const { app } = mkWorkspace(false);
    const r1 = runWs(app);
    const before = depBytes(app) + "\n@app\n" + fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8");
    const r2 = runWs(app);
    const after = depBytes(app) + "\n@app\n" + fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8");
    check("workspace re-pass: a clean run sweeps nothing", !/could not scan/.test(r1.stderr + r2.stderr),
          r1.stderr + r2.stderr);
    // The re-pass is GATED on something having been dropped. Without this row the gate is invisible in
    // every channel the suite reads (an ungated re-pass is byte-identical and merely slower — standing
    // bar item 8c: a guard that cannot be detected needs a test), so the gate discloses itself on the
    // one channel that can see it.
    check("workspace re-pass: ...so the fixpoint is NOT re-run", !/re-ran the dependency fixpoint/.test(r1.stderr + r2.stderr),
          r1.stderr + r2.stderr);
    check("workspace re-pass: ...and every artifact is byte-identical across the two runs", before === after,
          `${before}\n---\n${after}`);
    check("workspace re-pass: ...with the two-hop chain intact and the consumer reading it",
          /chained 2 workspace dep report\(s\), transitive: liba, libb/.test(r2.stderr), r2.stderr);
  }

  // ── THE DEFECT, in the cardinal-sin direction: an ANSWERABLE key (`declare function aWrite`). The
  // stale report's SILENCE about `aWrite` is its purity claim (SPEC §2 rule 3), `libb` chained it, and
  // the parent inherited a positive purity claim about a call into source candor could not read.
  {
    const { app, liba } = mkWorkspace(false);
    runWs(app);
    check("workspace re-pass: the two-hop chain is pure while `liba` is scannable and pure",
          appEntry(app, "src.m.callB") == null, JSON.stringify(appEntry(app, "src.m.callB")));
    // `liba` loses its analyzable source; its `.d.ts` stays, so `libb` still RESOLVES `aWrite`.
    fs.rmSync(path.join(liba, "index.ts"));
    const r = runWs(app);
    check("workspace re-pass: a SIBLING's cached report does not keep the swept report's answer",
          appEntry(app, "src.m.callB")?.invisible?.includes("liba"), JSON.stringify(appEntry(app, "src.m.callB")));
    check("workspace re-pass: ...the carrier's own cached report is re-derived too",
          entry(JSON.parse(fs.readFileSync(path.join(app, ".candor", "deps", "libb.json"), "utf8")), "index.useB")
            ?.invisible?.includes("liba"),
          fs.readFileSync(path.join(app, ".candor", "deps", "libb.json"), "utf8"));
    check("workspace re-pass: ...and the run says it re-derived rather than only deleting",
          /re-ran the dependency fixpoint/.test(r.stderr), r.stderr);
    // THE COLD CONTROL. Same source, no cache: the answer must be the same one. Without this row the
    // rows above pass for any change that happens to disclose, rather than for the right answer.
    const cold = mkWorkspace(false);
    runWs(cold.app);
    fs.rmSync(path.join(cold.liba, "index.ts"));
    fs.rmSync(path.join(cold.app, ".candor", "deps"), { recursive: true, force: true });
    runWs(cold.app);
    check("workspace re-pass control: the COLD arm gives the same answer as the warm one",
          JSON.stringify(appEntry(cold.app, "src.m.callB")?.invisible)
            === JSON.stringify(appEntry(app, "src.m.callB")?.invisible),
          `${JSON.stringify(appEntry(cold.app, "src.m.callB"))} vs ${JSON.stringify(appEntry(app, "src.m.callB"))}`);
  }

  // ── THE SAME MECHANISM MOVING A GATE, through the interface-CHA join. `liba`'s run-1 report carries an
  // `interfaceUnion` entry for `Fetcher.fetch`, so `libb`'s `f.fetch()` joins a CONCRETE `Fs` — and that
  // `Fs` survived inside `libb`'s cached report after `liba`'s was swept. `deny Fs` was exit 1 over a
  // body that is no longer on disk, against a cold arm that is exit 0. The opposite direction to the
  // rows above, from the identical cause, which is why both are here.
  {
    const { app, liba } = mkWorkspace(true);
    runWs(app);
    check("workspace re-pass: the interface-CHA join carries the dep's concrete effect while it is readable",
          appEntry(app, "src.m.callB")?.inferred?.includes("Fs"), JSON.stringify(appEntry(app, "src.m.callB")));
    fs.rmSync(path.join(liba, "index.ts"));
    fs.writeFileSync(path.join(app, "fs.policy"), "deny Fs src.m.callB\n");
    const g = runWs(app, ["--policy", path.join(app, "fs.policy")]);
    check("workspace re-pass: a stale interface-CHA effect does not survive the sweep inside a sibling",
          !appEntry(app, "src.m.callB")?.inferred?.includes("Fs"), JSON.stringify(appEntry(app, "src.m.callB")));
    check("workspace re-pass: ...and it is disclosed rather than merely dropped (item 1b)",
          appEntry(app, "src.m.callB")?.invisible?.includes("liba"), JSON.stringify(appEntry(app, "src.m.callB")));
    check("workspace re-pass: ...so `deny Fs` is exit 0, agreeing with the cache-free arm", g.status === 0,
          `status=${g.status} ${g.stdout}`);
  }
}

// ── 2f-septies (b3). THE TWO NAMES THAT HAVE TO BE ONE NAME ────────────────────────────────────────
// `95d0b8b`'s sweep rule is "a file candor would have OVERWRITTEN on success is the file it removes on
// failure". That is only true while the WRITER's name and the SWEEPER's candidate name are the same
// string, and they were two spellings of one derivation: the writer took `report.package` on trust,
// `failedDepName` required a non-empty STRING. A manifest whose `name` is not a string makes them
// disagree — and the sweep is the unrecoverable direction.
if (blk()) {
  const mkOwn = (manifestName) => {
    const dep = project({
      "package.json": `{"name":${manifestName},"version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export declare function u(): void;`,
      "index.ts": `export function u(): void {}`,
    });
    const app = project({
      "package.json": `{"name":"ownapp","version":"1.0.0"}`,
      "src/m.ts": `export function f(): void {}`,
    });
    fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
    // The link's NAME in node_modules is what makes it a discovered path dep; the file it is filed under
    // comes from the manifest, and the two are deliberately different here.
    fs.symlinkSync(dep, path.join(app, "node_modules", "utils"));
    fs.mkdirSync(path.join(app, ".candor", "deps"), { recursive: true });
    return { app, dep, base: path.basename(dep) };
  };
  const runWs = (app) => spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--workspace"], { encoding: "utf8" });

  // NO-DELETION FIRST, and this row is the whole point: a report the USER placed under the name the
  // sweep would derive for this dep must not be destroyed by a scan that SUCCEEDED. Pre-fix it was —
  // `name.replace` threw on the number, the `catch` read the success as a failure, and the sweep took it.
  {
    const { app, dep, base } = mkOwn("123");
    const hand = path.join(app, ".candor", "deps", `${base}.json`);
    fs.writeFileSync(hand, JSON.stringify({ candor: { version: "hand" }, package: "handmade", functions: [] }));
    const r = runWs(app);
    check("workspace ownership: a dep whose manifest `name` is not a string is not a FAILED scan",
          !/could not scan/.test(r.stderr), r.stderr);
    check("workspace ownership: ...so nothing at the derived name is deleted",
          fs.existsSync(hand), fs.readdirSync(path.join(app, ".candor", "deps")).join(","));
    // …and the file that is there is candor's own report for that dep, filed under the SAME name
    // `failedDepName` would have derived — which is what makes the sweep's rule true rather than lucky.
    let filed = null;
    try { filed = JSON.parse(fs.readFileSync(hand, "utf8")); } catch { /* the row above already named it */ }
    check("workspace ownership: ...it is candor's own report, filed under the sweeper's own name",
          Array.isArray(filed?.functions) && filed.candor?.version !== "hand", JSON.stringify(filed)?.slice(0, 120));
    check("workspace ownership: ...and the count line names what is on disk, not the manifest's non-string",
          new RegExp(`chained 1 workspace dep report\\(s\\), transitive: ${base}`).test(r.stderr), r.stderr);
    fs.rmSync(dep, { recursive: true, force: true });
  }
  // CONTROL: an ordinary string name is unaffected — the derivation only changes where it was undefined.
  {
    const { app } = mkOwn(`"utilkit"`);
    const r = runWs(app);
    check("workspace ownership control: an ordinary manifest name still files under the manifest name",
          fs.existsSync(path.join(app, ".candor", "deps", "utilkit.json")),
          fs.readdirSync(path.join(app, ".candor", "deps")).join(","));
    check("workspace ownership control: ...and says so", /transitive: utilkit/.test(r.stderr), r.stderr);
  }
  // THE WRITE DOOR. `95d0b8b` closed "a report this run did not write is not this run's answer" for a
  // scan that threw. The bookkeeping sat ABOVE the write, so a write that threw — a read-only cache dir,
  // a full disk, a mode a CI image sets — recorded the dep as ANSWERED, the sweep skipped it, and the
  // PREVIOUS run's report stood in for one this run never put on disk. Same class, different door.
  {
    const dep = project({
      "package.json": `{"name":"wkit","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
      "index.d.ts": `export declare function w(): void;`,
      "index.ts": `export function w(): void {}`,
    });
    const app = project({
      "package.json": `{"name":"wapp2","version":"1.0.0"}`,
      "src/m.ts": `import { w } from "wkit";
export function useW(): void { w(); }`,
    });
    fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
    fs.symlinkSync(dep, path.join(app, "node_modules", "wkit"));
    runWs(app);
    const cached = path.join(app, ".candor", "deps", "wkit.json");
    check("workspace write door: a scannable path dep is cached", fs.existsSync(cached),
          fs.readdirSync(path.join(app, ".candor", "deps")).join(","));
    // The dep gains an effect AND the cache file becomes unwritable, so the fresh bytes cannot land.
    fs.writeFileSync(path.join(dep, "index.ts"),
      `import * as fsm from "node:fs";\nexport function w(): void { fsm.appendFileSync("/tmp/w", "x"); }`);
    fs.chmodSync(cached, 0o444);
    const r = runWs(app);
    const e = entry(JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")), "src.m.useW");
    check("workspace write door: a report this run could not WRITE is not served from the previous run",
          !(e == null), JSON.stringify(e));
    check("workspace write door: ...it is swept and named on stderr", /could not scan wkit\b/.test(r.stderr), r.stderr);
    fs.chmodSync(path.dirname(cached), 0o755);
  }
}

// ── 2f-septies (c). the ⟨0.21⟩ `unanalyzed` manifest, read four ways ──────────────────────────────
// `21277eb` withheld coverage from a dep report that declares itself incomplete. It asked
// `Array.isArray(u) && u.length > 0`, which reads `"unanalyzed": "oops"` and `"unanalyzed": {}` as
// COMPLETE — so a report that GARBLES its completeness claim bought the coverage a report that states
// it plainly is refused. Same door, reopened by a malformed key, and a fail-OPEN.
//
// java and rust (candor-rust `dbab8be`) both fail closed here; ts and swift did not. Coverage is the
// claim that an ABSENT entry is the dep's own purity claim (SPEC §2 rule 3), so an unreadable
// completeness claim must buy nothing — the posture this file already takes on a malformed `inferred`.
if (blk()) {
  const depDir = project({ "package.json": `{"name":"mkit","version":"1.0.0"}`,
    "src/index.ts": `import * as fsm from "node:fs";
export function loud(): void { fsm.appendFileSync("/tmp/m", "x"); }
export function quiet(): string { return "q"; }` });
  const { prefix } = scan(depDir);
  const base = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  const appFiles = {
    "package.json": `{"name":"mapp","version":"1.0.0"}`,
    "src/m.ts": `import { quiet } from "mkit";
export function useQuiet(): string { return quiet(); }`,
    "node_modules/mkit/package.json": `{"name":"mkit","version":"1.0.0","types":"index.d.ts","main":"index.js"}`,
    "node_modules/mkit/index.d.ts": `export declare function loud(): void;
export declare function quiet(): string;`,
    "node_modules/mkit/index.js": `exports.loud=()=>{};exports.quiet=()=>"q";`,
  };
  // `covered` = the dep's silence about `quiet` was read as its purity claim, so no entry is emitted.
  const covered = (manifest) => {
    const app = project(appFiles);
    const d = JSON.parse(JSON.stringify(base));
    if (manifest === undefined) delete d.unanalyzed; else d.unanalyzed = manifest;
    const dep = path.join(app, "dep.json");
    fs.writeFileSync(dep, JSON.stringify(d));
    spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: dep } });
    const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
    return entry(rep, "src.m.useQuiet") == null;
  };
  // THE TWO COMPLETE READINGS, FIRST. The writer OMITS the key when it has nothing to declare, so
  // reading absence as incompleteness withholds coverage from every ordinary report — the tempting
  // fail-closed reading, and the one that breaks everything (candor-java's mutant failed seven tests).
  check("manifest: an ABSENT `unanalyzed` is a COMPLETE report and still grants coverage", covered(undefined));
  check("manifest: an EMPTY `unanalyzed` is complete too", covered([]));
  check("manifest: a non-empty `unanalyzed` withholds coverage (⟨0.21⟩, 21277eb)",
        !covered([{ path: "src/x.ts", reason: "source failed to parse" }]));
  // …and the malformed shapes, which fail CLOSED.
  check("manifest: a STRING `unanalyzed` is not a completeness claim — coverage withheld", !covered("oops"));
  check("manifest: an OBJECT `unanalyzed` is not one either", !covered({}));
  check("manifest: a NULL `unanalyzed` is not one either", !covered(null));
}

// ── 2f-sexies. the UNANSWERABLE KEY across the scan boundary ──────────────────────────────────────
// candor-spec DEP-RECEIVER-TYPING-DESIGN.md, half 1. A chained lookup coming back empty has two
// readings with opposite evidential weight, and the engine drew no distinction: a key that names a
// BODY the dep scanned (`declare class C { m() }`) makes absence the dep's own purity claim (SPEC §2
// rule 3), but a key that names an ABSTRACTION — an interface method/property signature, an anonymous
// type-literal member, an `abstract` member — names nothing the dep's report could ever carry, so the
// silence answered a question that was never asked. Measured pre-fix: `go` ABSENT from the report
// while the dependency's own report read `ifacekit#Client.fetch -> ['Fs']`.
// Third conjunct: only when the dependency is CHAINED. Unchained, the κ ledger already discloses
// `invisible: [pkg]` and a second voice would be pure false uncertainty.
if (blk()) {
  const depSrc = `import * as fsm from "node:fs";
export interface Fetcher { fetch(): string; }
export class Client implements Fetcher { fetch(): string { return fsm.readFileSync("/etc/x", "utf8"); } }
export function build(): Fetcher { return new Client(); }
export abstract class Base { abstract pull(): string; }
export class Puller extends Base { pull(): string { return process.env.HOME ?? ""; } }
export function buildBase(): Base { return new Puller(); }
export interface Api { load: () => string; }
export class ApiImpl implements Api { load = (): string => fsm.readFileSync("/etc/y", "utf8"); }
export function buildApi(): Api { return new ApiImpl(); }
export interface Job { run(): void; }
export class RealJob implements Job { run(): void { fsm.appendFileSync("/tmp/j", "x"); } }
export function buildJob(): Job { return new RealJob(); }
export class Plain { label(): string { return "p"; } }
export class Loud { shout(): string { return fsm.readFileSync("/etc/z", "utf8"); } }`;
  const appSrc = `import { build, buildBase, buildApi, buildJob, Plain, Loud } from "SPEC";
export function useFetcher(): string { return build().fetch(); }
export function usePuller(): string { return buildBase().pull(); }
export function useApi(): string { return buildApi().load(); }
export function useJob(): void { [1].forEach(buildJob().run); }
export function usePlain(): string { return new Plain().label(); }
export function useLoud(): string { return new Loud().shout(); }`;
  const depDir = project({ "package.json": `{"name":"ifacekit","version":"1.0.0"}`, "src/index.ts": depSrc });
  const { prefix: depPrefix } = scan(depDir);
  // The published shape: dist JS + typings. The `implements`/`extends` clauses and the bodies live in
  // the dep's SOURCE; the consumer only ever sees these declarations.
  const appFiles = {
    "package.json": `{"name":"capp","version":"1.0.0"}`,
    "src/m.ts": appSrc.replace("SPEC", "ifacekit"),
    "node_modules/ifacekit/package.json": `{"name":"ifacekit","version":"1.0.0","types":"dist/index.d.ts","main":"dist/index.js"}`,
    "node_modules/ifacekit/dist/index.d.ts": `export interface Fetcher { fetch(): string; }
export declare function build(): Fetcher;
export declare abstract class Base { abstract pull(): string; }
export declare function buildBase(): Base;
export interface Api { load: () => string; }
export declare function buildApi(): Api;
export interface Job { run(): void; }
export declare function buildJob(): Job;
export declare class Plain { label(): string; }
export declare class Loud { shout(): string; }`,
    "node_modules/ifacekit/dist/index.js": `exports.build = () => ({}); exports.buildBase = () => ({}); exports.buildApi = () => ({});
exports.buildJob = () => ({}); exports.Plain = class {}; exports.Loud = class {};`,
  };
  const app = project(appFiles);
  fs.writeFileSync(path.join(app, "deny.policy"), "deny Fs Unknown\n");
  const chained = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "deny.policy")],
                            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  const crep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const why = (fn) => entry(crep, fn)?.unknownWhy ?? [];
  const unk = (fn) => (entry(crep, fn)?.inferred ?? []).includes("Unknown");
  check("boundary: a chained dep's INTERFACE-typed receiver discloses instead of reading pure",
        unk("src.m.useFetcher") && why("src.m.useFetcher").includes("dispatch:ifacekit.Fetcher.fetch"),
        JSON.stringify(crep.functions));
  check("boundary: ...an ABSTRACT member of a chained dep's class likewise",
        unk("src.m.usePuller") && why("src.m.usePuller").includes("dispatch:ifacekit.Base.pull"),
        JSON.stringify(entry(crep, "src.m.usePuller")));
  check("boundary: ...and a FUNCTION-VALUED property signature (the call resolves to the function type)",
        unk("src.m.useApi") && why("src.m.useApi").includes("dispatch:ifacekit.Api.load"),
        JSON.stringify(entry(crep, "src.m.useApi")));
  check("boundary: ...and on the DESUGARED path (a dep interface member passed by reference to a HOF)",
        unk("src.m.useJob") && why("src.m.useJob").includes("dispatch:ifacekit.Job.run"),
        JSON.stringify(entry(crep, "src.m.useJob")));
  // CONTROL 1 — KEYED-AND-MISSED. `Plain.label` is a CONCRETE method the dep scanned and found pure, so
  // its absence from the dep's report IS its answer (SPEC §2 rule 3). Disclosing here would be the false
  // uncertainty this rung is built to avoid: silence must survive.
  check("no false uncertainty: a keyed-and-missed CONCRETE dep method stays silent",
        entry(crep, "src.m.usePlain") == null, JSON.stringify(entry(crep, "src.m.usePlain")));
  // CONTROL 2 — the precise join still wins. A concrete, EFFECTFUL dep method keeps its exact effect;
  // the disclosure must never displace an answer the engine actually has.
  check("precision preserved: a concrete effectful dep method still joins to its exact effect",
        (entry(crep, "src.m.useLoud")?.inferred ?? []).includes("Fs") && !unk("src.m.useLoud"),
        JSON.stringify(entry(crep, "src.m.useLoud")));
  // THE GATE FLIP, on a project holding ONLY the unanswerable call — so the verdict turns on this arm
  // and nothing else. Split + chained was exit 0 (a false all-clear over a dependency that reads a file);
  // it is exit 1 again, matching the one-project control.
  const gateApp = project({ ...appFiles, "src/m.ts": `import { build } from "ifacekit";
export function useFetcher(): string { return build().fetch(); }` });
  fs.writeFileSync(path.join(gateApp, "deny.policy"), "deny Fs Unknown\n");
  const gated = spawnSync("node", [path.join(HERE, "scan.mjs"), gateApp, "--policy", path.join(gateApp, "deny.policy")],
                          { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  check("boundary: the `deny Fs Unknown` gate is exit 1 again for an unanswerable dep key",
        gated.status === 1, `status=${gated.status} ${gated.stdout}`);
  check("boundary: ...and the whole-app gate fails too",
        chained.status === 1, `status=${chained.status} ${chained.stdout}`);
  // CONTROL 3 — the third conjunct. UNCHAINED, the κ ledger already names the package `invisible`, so
  // the arm must not fire: a second disclosure over the same gap is noise, and `invisible` must survive.
  const { report: urep } = scan(project(appFiles));
  check("third conjunct: UNCHAINED the arm is silent and `invisible` is intact",
        entry(urep, "src.m.useFetcher")?.invisible?.includes("ifacekit")
        && !(entry(urep, "src.m.useFetcher")?.inferred ?? []).includes("Unknown"),
        JSON.stringify(entry(urep, "src.m.useFetcher")));
  // SINGLE-TREE CONTROL — the same source in ONE project resolves precisely (local interface CHA / class
  // overrides reach the implementations), which is what makes this a BOUNDARY defect and not a general
  // limitation of the engine.
  const { report: ctl } = scan(project({
    "package.json": `{"name":"one","version":"1.0.0"}`,
    "src/dep.ts": depSrc,
    "src/m.ts": appSrc.replace("SPEC", "./dep"),
  }));
  check("single-tree control: the same code in ONE project resolves the interface dispatch precisely",
        (entry(ctl, "src.m.useFetcher")?.inferred ?? []).includes("Fs"),
        JSON.stringify(entry(ctl, "src.m.useFetcher")));
}

// ── 1c. the BODY-LESS LOCAL declaration — the block above's untaken sibling route ──────────────────
// Everything above is about a declaration in a DEPENDENCY. The identical shape in the project's OWN
// source went the other way: `localName` mints a unit for any declaration it can name, WITHOUT asking
// whether it has a body, the call site edges the caller to that empty unit, and the caller unioned
// nothing and read PURE. Found on real code — candor-ts's whole report for `axios` is 54 `index.d.ts`
// declarations while its 61 `.js` implementation files are never analyzed, so `deny Unknown` exited 0
// where rust, java and swift all exit 1 on the same input. The fix charges the DECLARATION (java's
// shape) and lets the existing fixpoint carry it caller-ward.
if (blk()) {
  const src = `import * as fsm from "node:fs";
declare function ambient(u: string): string;
export function callsAmbient(): string { return ambient("u"); }
export function over(a: string): void;
export function over(a: number): void;
export function over(a: any): void { fsm.writeFileSync("/tmp/x", String(a)); }
export function callsOver(): void { over("x"); }
export abstract class Base { abstract hook(): void; run(): void { this.hook(); } }
export class Impl extends Base { hook(): void { fsm.readFileSync("/tmp/y"); } }
export abstract class Lone { abstract solo(): void; call(): void { this.solo(); } }
export function outer(): void {
  function inner(a: string): void;
  function inner(a: number): void;
  function inner(a: any): void { fsm.writeFileSync("/tmp/z", String(a)); }
  inner("x");
}
export abstract class Top { abstract tick(): void; }
export abstract class Mid extends Top { abstract tick(): void; }
export class Deep extends Mid { tick(): void { fsm.readFileSync("/tmp/d"); } }
export function viaTop(t: Top): void { t.tick(); }
export declare function widget(u: string): string;
export declare namespace widget { const version: string; }
export function callsWidget(): string { return widget("u"); }`;
  const dir = project({ "package.json": `{"name":"bl","version":"1.0.0"}`, "src/a.ts": src });
  const { report: rep } = scan(dir);
  const eff = (fn) => entry(rep, fn)?.inferred ?? [];
  const why = (fn) => entry(rep, fn)?.unknownWhy ?? [];
  // THE UNDER-REPORT, closed. An ambient declaration has no body in the analyzed set, so it cannot be
  // certified pure — and the caller inherits that, which is the half a consumer's gate reads.
  check("body-less: a local ambient `declare function` is Unknown, not pure",
        eff("src.a.ambient").includes("Unknown"), JSON.stringify(entry(rep, "src.a.ambient")));
  check("body-less: ...with §4's `native:` class — the same class java gives `native int ambient`",
        why("src.a.ambient").includes("native:ambient"), JSON.stringify(why("src.a.ambient")));
  check("body-less: ...and the CALLER inherits it (the transitive half a gate actually reads)",
        eff("src.a.callsAmbient").includes("Unknown"), JSON.stringify(entry(rep, "src.a.callsAmbient")));
  // An `abstract` member NO local subclass overrides is an unresolved DISPATCH — owner and member are
  // both nameable, which is exactly what §4 reserves `dispatch:` for, and it is swift's spelling too.
  check("body-less: an `abstract` member with NO local override is Unknown[dispatch:]",
        eff("src.a.Lone.solo").includes("Unknown") && why("src.a.Lone.solo").some((w) => w.startsWith("dispatch:")),
        JSON.stringify(entry(rep, "src.a.Lone.solo")));
  check("body-less: ...and its caller inherits that too",
        eff("src.a.Lone.call").includes("Unknown"), JSON.stringify(entry(rep, "src.a.Lone.call")));
  // OVER-CHARGE CONTROL 1 — THE OVERLOAD SET. `over` is two body-less signatures followed by a bodied
  // implementation under the SAME unit name. Marking body-less units without mirroring `fns.set`'s
  // last-write-wins would call every overloaded function in every real project unanalysable and charge
  // its callers Unknown — a fabrication introduced BY the fix for an under-report, which is the failure
  // mode this project measures most often. `over` keeps its exact effect and stays free of Unknown.
  check("no over-charge: an OVERLOAD SET keeps its implementation's effect, no Unknown",
        eff("src.a.over").includes("Fs") && !eff("src.a.over").includes("Unknown"),
        JSON.stringify(entry(rep, "src.a.over")));
  check("no over-charge: ...and its caller is precisely Fs, not Unknown",
        eff("src.a.callsOver").includes("Fs") && !eff("src.a.callsOver").includes("Unknown"),
        JSON.stringify(entry(rep, "src.a.callsOver")));
  // OVER-CHARGE CONTROL 2 — CHA ALREADY ANSWERED. `Base.hook` is abstract, but a local subclass bodies
  // it, and the class-CHA at the dispatch site already edges the caller to that override. Charging the
  // empty base as well would manufacture uncertainty over code the engine can see. MEASURED on the
  // corpus: this control is what takes zod's delta to +0 and hono's from +18 to +9.
  check("no over-charge: an abstract member a LOCAL subclass bodies stays resolved (CHA answered it)",
        !eff("src.a.Base.hook").includes("Unknown"), JSON.stringify(entry(rep, "src.a.Base.hook")));
  check("no over-charge: ...so its caller is precisely Fs, with no Unknown",
        eff("src.a.Base.run").includes("Fs") && !eff("src.a.Base.run").includes("Unknown"),
        JSON.stringify(entry(rep, "src.a.Base.run")));
  // THE GATE FLIP, on a project holding ONLY the unanswerable call — the verdict turns on this arm and
  // nothing else. `deny Unknown` is the gate whose whole purpose is "fail if candor cannot see what this
  // reaches"; on this input it was exit 0, and the other three engines exit 1.
  const g = project({ "package.json": `{"name":"g","version":"1.0.0"}`,
    "src/a.ts": `declare function ambient(u: string): string;
export function callsAmbient(): string { return ambient("u"); }`,
    "deny.policy": "deny Unknown\n" });
  const gated = spawnSync("node", [path.join(HERE, "scan.mjs"), g, "--policy", path.join(g, "deny.policy")],
                          { encoding: "utf8" });
  check("body-less: `deny Unknown` is exit 1 over a caller of a body-less declaration (was 0)",
        gated.status === 1, `status=${gated.status} ${gated.stdout}`);
  // GATE CONTROL — the same gate over a project whose declarations are all bodied stays green, so the
  // flip above is the unanswerable declaration and not `deny Unknown` becoming unusable on real TS.
  const gc = project({ "package.json": `{"name":"gc","version":"1.0.0"}`,
    "src/a.ts": `export abstract class B { abstract h(): void; run(): void { this.h(); } }
export class I extends B { h(): void {} }`,
    "deny.policy": "deny Unknown\n" });
  const gctl = spawnSync("node", [path.join(HERE, "scan.mjs"), gc, "--policy", path.join(gc, "deny.policy")],
                         { encoding: "utf8" });
  check("body-less GATE CONTROL: `deny Unknown` stays exit 0 when every declaration has a local body",
        gctl.status === 0, `status=${gctl.status} ${gctl.stdout}`);
  // OVER-CHARGE CONTROL 3 — A FUNCTION-SCOPED OVERLOAD SET. Control 1 above only exercises the
  // MODULE-LEVEL form, and that gap shipped a real fabrication: a function-scoped unit carries a
  // `#line:col` suffix in its qual, so each signature holds a distinct key, the implementation's
  // last-write-wins delete never reaches them, and every signature was charged `Unknown[native:]` over
  // code sitting in the same file. The guard is the SYMBOL — shared by every overload at any scope.
  check("no over-charge: a FUNCTION-SCOPED overload set is not charged (the qual suffix defeats the delete)",
        !Object.keys(rep.functions.reduce((a, f) => (a[f.fn] = 1, a), {}))
          .some((fn) => fn.startsWith("src.a.inner#") && eff(fn).includes("Unknown")),
        JSON.stringify(rep.functions.filter((f) => f.fn.startsWith("src.a.inner"))));
  check("no over-charge: ...and its enclosing function keeps the implementation's exact effect",
        eff("src.a.outer").includes("Fs") && !eff("src.a.outer").includes("Unknown"),
        JSON.stringify(entry(rep, "src.a.outer")));
  // OVER-CHARGE CONTROL 4 — AN INTERMEDIATE ABSTRACT CLASS. `classOverrides` records DIRECT subclass
  // overrides only, so `Base -> Mid (abstract) -> Deep (bodied)` resolved one level to a body-less
  // member and charged the base, though the sole concrete implementation is right there and analyzed.
  // NOT an over-charge control — the previous version of this row asserted `Fs` on a hierarchy whose
  // middle class re-declared nothing, so `classOverrides` already linked the concrete override straight
  // to the base and the row passed identically on an engine WITHOUT the change it claimed to guard. It
  // was vacuous, and a silent under-report shipped behind it. With `Mid` re-declaring the member the
  // shape is real, and the assertion is the one that matters: the caller must not VANISH. Absence from
  // `functions` is a positive purity claim under SPEC §2 rule 3, so a disappearing caller is the cardinal
  // sin wearing an empty report. Over-charging it with Unknown is the survivable direction.
  check("no silent loss: a caller through a RE-DECLARING intermediate abstract is still reported",
        entry(rep, "src.a.viaTop") != null && eff("src.a.viaTop").includes("Unknown"),
        JSON.stringify(entry(rep, "src.a.viaTop")));
  // THE UMD/AMBIENT TYPINGS SHAPE — `declare function f(); declare namespace f {}`, which is jQuery,
  // lodash, moment and chalk. A ts.ModuleDeclaration carries a `.body` (its ModuleBlock), so a bare
  // `!!d.body` test read the NAMESPACE as f's overload implementation, dropped the charge, and reported
  // the caller pure. That is the axios cardinal sin reopened by the pass that closed it; it shipped.
  check("body-less: a `declare function` MERGED with a namespace is still Unknown, not pure",
        eff("src.a.widget").includes("Unknown"), JSON.stringify(entry(rep, "src.a.widget")));
  check("body-less: ...and its caller too — a ModuleBlock is not a function body",
        eff("src.a.callsWidget").includes("Unknown"), JSON.stringify(entry(rep, "src.a.callsWidget")));
}

// ── 1d. `--agents` must not truncate on a PIPE ────────────────────────────────────────────────────
// scan.mjs printed the contract and immediately `process.exit(0)`, which discards Node's asynchronous
// stdout buffer on a pipe: 8170 of 23121 characters, cut mid-sentence, exit 0, nothing on stderr. An
// agent piping `candor-ts --agents` into its context silently read a third of its own instructions. The
// existing contract test caught it only because execFileSync uses a pipe; a shell redirect to a FILE
// writes synchronously and looked fine. Assert the byte count through a pipe explicitly, so a future
// regression names the cause rather than failing an equality over 23k characters.
if (blk()) {
  const doc = fs.readFileSync(path.join(HERE, "AGENTS.md"), "utf8");
  for (const bin of ["scan.mjs", "query.mjs"]) {
    const out = spawnSync("node", [path.join(HERE, bin), "--agents"], { encoding: "utf8", maxBuffer: 1 << 26 });
    check(`--agents (${bin}) writes the WHOLE contract through a pipe (no exit-truncation)`,
          out.stdout.length > doc.length && out.stdout.endsWith(doc),
          `got ${out.stdout.length} chars, contract is ${doc.length}`);
  }
}

// ── 1d3. A BULK DOCUMENT MUST SURVIVE A PIPE, not just `--agents` ─────────────────────────────────
// The `--agents` truncation got fixed and its SIBLINGS did not, which is the habit this project keeps
// measuring in itself. `console.log` is asynchronous on a pipe and every bulk-output path here ends in
// `process.exit(…)`, which discards what is still buffered.
//
// MEASURED before the fix, on `scan.mjs --json --policy <p>` over this fixture: 95281 bytes to a FILE and
// valid JSON, **65536 bytes through a PIPE and a JSONDecodeError** — exactly the pipe buffer, exit 1 on
// both, nothing on stderr. That is the machine-consumer path (`candor-ts src --json --policy p | jq`), so
// the loss is silent AND the document is invalid: strictly worse than the `--agents` case that got the
// class fixed. The umbrella backlog asserted these sites "fit the buffer and survive by SIZE", which was
// true of the usage strings somebody measured and false of the report envelope nobody did.
//
// THE ROW COMPARES A PIPE AGAINST A FILE rather than asserting a byte count: the count moves with the
// fixture and the classifier, and a row that needs updating every rung gets updated without being read.
// The fixture must EXCEED the buffer or the row is vacuous, so that is asserted too.
if (blk()) {
  const dir = scratch("candor-ts-bigpipe-");
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 400; i++) {
    fs.writeFileSync(path.join(src, `m${i}.ts`),
      `import http from "node:http";\nexport function f${i}(): void { http.get("http://x${i}"); }\n`);
  }
  const pol = path.join(dir, "p.pol");
  fs.writeFileSync(pol, "deny Net\n");
  const argv = [path.join(HERE, "scan.mjs"), src, "--json", "--policy", pol];
  // A REAL FILE for the baseline, via a shell redirect. spawnSync's own `stdout` capture is a PIPE too,
  // so using it as "the file size" measured the truncation on BOTH sides: against the unfixed engine the
  // baseline came back as 8192 bytes and the not-vacuous row failed for the wrong reason. A redirect to
  // a file is the only sink here that is synchronous by construction, which is the whole distinction.
  const q = (x) => `'${x.replace(/'/g, "'\\''")}'`;
  const cmd = `${q(process.execPath)} ${argv.map(q).join(" ")}`;
  const filePath = path.join(dir, "out.json");
  spawnSync("sh", ["-c", `${cmd} > ${q(filePath)} 2>/dev/null`]);
  const fileBytes = fs.statSync(filePath).size;
  const toPipe = spawnSync("sh", ["-c", `${cmd} 2>/dev/null | cat`], { encoding: "utf8", maxBuffer: 1 << 28 });
  check("--json over a large scan EXCEEDS the pipe buffer (the row is not vacuous)",
        fileBytes > 65536, `only ${fileBytes} bytes to a file — the fixture no longer tests anything`);
  check("--json delivers the WHOLE envelope through a pipe, not the first 64KiB",
        toPipe.stdout.length === fileBytes,
        `pipe got ${toPipe.stdout.length} of the file's ${fileBytes} bytes`);
  let parsed = false;
  try { JSON.parse(toPipe.stdout); parsed = true; } catch { /* reported below */ }
  check("…and what arrives through the pipe is VALID JSON (a truncated document is not a document)",
        parsed, `${toPipe.stdout.length} bytes, tail: ${JSON.stringify(toPipe.stdout.slice(-40))}`);
}

// ── 1d2. …and must not HANG when the reader stalls without closing ────────────────────────────────
// The EPIPE arm covers the reader that LEFT. This is the reader that STAYED and stopped — an agent
// harness holding the pipe open while it blocks, a log collector wedged on a full disk. The retry loop
// was `while (off < buf.length)` with an unconditional 1ms sleep and no exit: it spun forever, and a
// hung `--agents` cannot be told from a slow one. It reports nothing and burns the surrounding timeout.
//
// DRIVES THE REAL LOOP, not a copy of it — a FIFO opened O_NONBLOCK on the write end with a reader that
// never reads, which is the only way to make writeSync actually raise EAGAIN. (`printAgents` takes its
// fd and budget as parameters for exactly this; production passes neither.) Both halves are asserted:
// the call RETURNS inside the budget, and it says on stderr that the contract is incomplete — a silent
// give-up would be the same truncation-with-exit-0 this whole section exists to prevent.
//
// THE SECOND ASSERTION IS THE CALIBRATION. That diagnostic is reachable only from the branch this fix
// added, past its deadline — the previous loop had no such message and no way out of the `while`. So the
// row cannot pass against the old code by any route; it hangs instead. Worth saying, because the timing
// assertion ALONE would go green on a machine where the write happened to land.
if (blk()) {
  const dir = scratch("candor-ts-eagain-");
  const fifo = path.join(dir, "p");
  spawnSync("mkfifo", [fifo]);
  // THE READ END IS HELD IN-PROCESS, no reader process at all. The first version spawned
  // `sh -c 'exec 3<fifo; sleep 30'` — and /bin/sh forks for a compound command, so `reader.kill()` killed
  // the SHELL and left `sleep 30` alive with ppid 1, holding the read end open into a directory the sweep
  // had already removed. In a change titled "own the children", the new test was the one thing that did
  // not. An O_NONBLOCK O_RDONLY open succeeds on a FIFO with no writer, and satisfies the write end's
  // need for a reader without any process to lose track of.
  let rfd = -1, wfd = -1;
  try {
    rfd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    wfd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch { /* reported by the guard below */ }
  if (wfd < 0) {
    check("--agents stalled-reader guard: could not open the FIFO", false, "the fixture could not be built");
  } else {
    // FILL THE PIPE FIRST, and this is what makes the row portable. The contract is 24110 bytes and a
    // Linux FIFO holds 65536, so `printAgents` wrote the WHOLE thing on its first call, never raised
    // EAGAIN, and never entered the branch under test — CI went red on the calibration assertion while
    // the timing assertion passed in 1ms having tested nothing. macOS was green only because its pipe
    // holds 8192. That is this project's own hazard reproduced inside the fix's own test, and the reason
    // it surfaced as a loud failure instead of a vacuous green is the second assertion. Filling to
    // capacity first makes the buffer's size irrelevant.
    const fill = Buffer.alloc(4096, 0x61);
    let filled = 0;
    for (;;) {
      try { filled += fs.writeSync(wfd, fill, 0, fill.length); }
      catch (e) { if (e.code === "EAGAIN") break; throw e; }
      if (filled > (1 << 22)) break;   // a rail, in case some platform's FIFO never says EAGAIN
    }
    const t0 = Date.now();
    const errFd = fs.openSync(path.join(dir, "err"), "w");
    const saved = fs.writeSync;
    // Redirect only the guard's own fd-2 diagnostic into a file, so the assertion can read it.
    fs.writeSync = (fd, ...rest) => saved.call(fs, fd === 2 ? errFd : fd, ...rest);
    try { printAgents(wfd, 600); } finally { fs.writeSync = saved; fs.closeSync(errFd); }
    const ms = Date.now() - t0;
    const diag = fs.readFileSync(path.join(dir, "err"), "utf8");
    check("--agents fixture really is at EAGAIN before the call (the row is not vacuous)",
          filled > 0, `the FIFO accepted ${filled} bytes and never blocked`);
    check("--agents RETURNS when the reader stalls without closing (bounded EAGAIN retry)",
          ms < 5000, `took ${ms}ms — the retry loop is unbounded again`);
    check("…and says on stderr that the contract is INCOMPLETE",
          /stalled at \d+ of \d+ bytes/.test(diag) && diag.includes("INCOMPLETE"),
          `stderr was ${JSON.stringify(diag.slice(0, 120))}`);
    fs.closeSync(wfd);
  }
  if (rfd >= 0) fs.closeSync(rfd);
}

// ── 2b. `show` SURFACES the literal Fs paths + Exec cmds (the regression that shipped) ─────────────
// scan writes the surface under report keys `paths`/`cmds`; `show` once read a nonexistent `e.fs`, so
// it silently dropped every file path even though the MCP `candor_show` doc promises "paths". The CLI
// had its own drifted copy that ALSO dropped `cmds`. One shared show now feeds both; assert it surfaces.
if (blk()) {
  const d = project({
    "src/io.ts": `import * as fsm from "node:fs";
import { execSync } from "node:child_process";
export function readCfg() { return fsm.readFileSync("/etc/app/config.json"); }
export function runIt() { return execSync("ls -la"); }`,
  });
  const { prefix } = scan(d);
  const fns = loadReport(prefix);
  const rc = show(fns, "readCfg")[0];
  const ri = show(fns, "runIt")[0];
  check("show surfaces Fs paths under `paths` (not the dead `fs` key)",
        rc?.paths?.includes("/etc/app/config.json") && rc?.fs === undefined, JSON.stringify(rc));
  check("show surfaces Exec cmds", ri?.cmds?.includes("ls"), JSON.stringify(ri));
}

// ── 3. the standing gate: deny + allow + forbid, exit codes ───────────────────────────────────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`,
    "src/domain.ts": `import { save } from "./db.js";
import { DatabaseSync } from "node:sqlite";
export function place(db: DatabaseSync): void { save(db); }`,
    "policy": "deny Db domain\nallow Db in db ledger.*\nforbid domain -> db\n",
  });
  const { r } = scan(d, "--policy", path.join(d, "policy"));
  check("gate exits 1 on violations", r.status === 1, `status=${r.status}`);
  check("deny fires transitively (006)", r.stdout.includes("[AS-EFF-006]") && r.stdout.includes("src.domain.place"));
  check("allowlist flags the un-sanctioned table (008)", r.stdout.includes("[AS-EFF-008]") && r.stdout.includes("customers"));
  check("layering fires (009)", r.stdout.includes("[AS-EFF-009]") && r.stdout.includes("src.domain.place"));
  const r2 = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", "/nonexistent"], { encoding: "utf8" });
  check("unreadable policy exits 2 LOUDLY", r2.status === 2 && r2.stderr.includes("NOT enforced"));
}

// ── 3n. NAMESPACE layers are name segments (the family ruling) ─────────────────────────────────────
// §6.2 scope segments split on the same boundaries as the §3.1 name ladder, and a namespace is a
// segment — rust modules and swift enum-namespaces already behave this way. Before this, a unit in
// `export namespace app { … }` was named `mod.fn` (namespace DROPPED), so `forbid app -> repo` /
// `deny Fs app` against namespace layers was silently inert while the same policy bit on directory
// layers. The fix is in the NAMING (report-affecting: `fn` gains the namespace segments); the §2
// hash keeps the bare local name so cross-package report chaining is unaffected.
if (blk()) {
  const d = project({
    "src/a.ts": `import * as fsm from "node:fs";
export namespace repo {
  export function load(): string { return fsm.readFileSync("/x", "utf8"); }
}
export namespace app {
  export function entry(): string { return repo.load(); }
}
export namespace lib.util {
  export function deep(): string { return fsm.readFileSync("/y", "utf8"); }
}
export namespace outer {
  export namespace inner {
    export class C { m(): string { return fsm.readFileSync("/z", "utf8"); } }
  }
}`,
    "layer.policy": "forbid app -> repo\n",
    "cousin.policy": "forbid app -> other\n",
    "deny.policy": "deny Fs app\n",
    "denycousin.policy": "deny Fs cousin\n",
  });
  const { report, cg } = scan(d);
  check("namespace is a name segment (fn carries it)",
        entry(report, "src.a.repo.load")?.inferred.includes("Fs"), JSON.stringify(report.functions.map((f) => f.fn)));
  check("dotted `namespace a.b` contributes every segment",
        entry(report, "src.a.lib.util.deep")?.inferred.includes("Fs"));
  check("nested namespaces + class methods qualify through the whole chain",
        entry(report, "src.a.outer.inner.C.m")?.inferred.includes("Fs"));
  check("cross-namespace edge resolves under the namespaced names",
        cg["src.a.app.entry"]?.includes("src.a.repo.load"), JSON.stringify(cg));
  check("§2 hash keeps the BARE local name (report chaining unaffected)",
        entry(report, "src.a.repo.load")?.hash?.endsWith("#load"), entry(report, "src.a.repo.load")?.hash);
  const gate = (pol) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out",
                                           path.join(d, ".candor", "g"), "--policy", path.join(d, pol)], { encoding: "utf8" });
  const rl = gate("layer.policy"), rc = gate("cousin.policy"), rd = gate("deny.policy"), rdc = gate("denycousin.policy");
  check("forbid app -> repo BITES on namespace layers (009, exit 1)",
        rl.status === 1 && rl.stdout.includes("[AS-EFF-009]") && rl.stdout.includes("src.a.app.entry"),
        `status=${rl.status} ${rl.stdout}`);
  check("forbid against a cousin namespace stays green (exit 0)", rc.status === 0, `status=${rc.status} ${rc.stdout}`);
  check("deny Fs app BITES on the namespace scope (006, exit 1)",
        rd.status === 1 && rd.stdout.includes("[AS-EFF-006]") && rd.stdout.includes("src.a.app.entry"),
        `status=${rd.status} ${rd.stdout}`);
  check("deny against a cousin scope stays green (exit 0)", rdc.status === 0, `status=${rdc.status} ${rdc.stdout}`);
}

// ── 3n2. ⟨0.29⟩ `only <A> -> <B> …` — THE PERMISSION FORM: forbid fails OPEN, only fails SAFE ───────
// `forbid` can state a prohibition but not a permission, so "this package is a leaf" is spelled by
// enumerating what it must NOT reach — an allowlist in the unsafe direction, because a package added
// tomorrow is not on the list and nothing says so. Found by pointing candor's own architecture gate at
// candor, where `forbid <pkg>.model -> <pkg>` self-fires because a scope matches a contiguous run of
// segments and `model` sits under the prefix it is protecting itself from.
if (blk()) {
  const d = project({
    "src/a.ts": `export namespace model {
  export function shape(): number { return util.helper(); }
  export function leaks(): number { return infra.dbRead(); }
}
export namespace util { export function helper(): number { return deep.inner(); } }
export namespace infra { export function dbRead(): number { return 9; } }
export namespace deep { export function inner(): number { return 1; } }`,
    "short.policy": "only model -> util\n",
    "full.policy": "only model -> util infra\n",
    "zero.policy": "only nosuch -> util\n",
  });
  const gate = (pol) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out",
                                           path.join(d, ".candor", "o"), "--policy", path.join(d, pol)], { encoding: "utf8" });
  const short = gate("short.policy"), full = gate("full.policy"), zero = gate("zero.policy");
  check("only: what the permission list OMITS is a violation (011, exit 1)",
        short.status === 1 && short.stdout.includes("[AS-EFF-011]") && short.stdout.includes("infra.dbRead"),
        `status=${short.status} ${short.stdout}`);
  check("only: the rule names itself in the message",
        short.stdout.includes("only model -> util"), short.stdout);
  // THE TAIL IS A LIST, and the STOP RULE rides the same row: `util` is permitted and itself reaches
  // `deep`, which nothing permits. If the walk descended past a permitted scope this would fire, and
  // `only` would demand the transitive closure of everything you allow — the same enumeration-that-rots
  // one level down, which would make the form useless for the leaf case it exists for.
  check("only: the tail is a LIST, and a permitted scope's OWN deps are not this rule's business",
        full.status === 0 && !full.stdout.includes("deep"), `status=${full.status} ${full.stdout}`);
  // ZERO-MATCH ON `from`, not either endpoint the way a `forbid` counts: `util` resolves here, so
  // counting the destinations would have hidden the typo that matters.
  check("only: a rule whose `from` binds nothing is DISCLOSED though its destination resolves",
        zero.status === 0 && zero.stderr.includes("matched NO function") && zero.stderr.includes("only nosuch -> util"),
        `status=${zero.status} ${zero.stderr}`);
  check("only: an only-only policy is ARMED, not a zero-rule file",
        !full.stderr.includes("NO RULES"), full.stderr);
  // …AND A REPORT ROUTE REFUSES IT (exit 2), for a STRICTER reason than `forbid`'s: `forbid` asks whether
  // one named crossing is present, `only` asks whether EVERYTHING reached is on a list, so a report that
  // omits a crossing turns a green into a claim of COMPLETENESS.
  const rep = path.join(d, ".candor", "o.json");
  const g = spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", rep,
                               "--policy", path.join(d, "short.policy")], { encoding: "utf8" });
  check("only: a report route REFUSES it (exit 2) rather than evaluating it",
        g.status === 2 && (g.stderr + g.stdout).includes("only model -> util"),
        `status=${g.status} ${g.stderr}`);
  check("only: …and no AS-EFF-011 was drawn from the report",
        !(g.stderr + g.stdout).includes("[AS-EFF-011]"), g.stdout + g.stderr);
  // ⟨0.29⟩ ITS OWN CODE — a suppression written for a `forbid` crossing must not mute this.
  check("only: the violation carries AS-EFF-011, never `forbid`'s 009",
        !short.stdout.includes("[AS-EFF-009]"), short.stdout);
}

// ── 3o. `pure` forbids every EFFECT — not `Unknown` (the family ruling) ─────────────────────────────
// Unknown is the §4 trust marker, not an effect: the reference engine (candor-java) and the rust deep
// engine exclude it from a `pure` rule's hits, and `deny Unknown <scope>` is the explicit knob for
// scopes that must exclude uncertainty (AS-EFF-003's concern). candor-ts wrongly counted an
// Unknown-only fn as a `pure` violation until 2026-07-09 — a cross-engine verdict split on the same
// policy. Effectful fns still trip `pure`; deny Unknown still fires.
if (blk()) {
  const d = project({
    "src/u.ts": `export function entry(f: () => void): void { f(); }`,
    "src/e.ts": `import * as fsm from "node:fs";\nexport function writer(): void { fsm.writeFileSync("/x", "1"); }`,
    "pure-u.policy": "pure u\n",
    "pure-e.policy": "pure e\n",
    "deny-unknown.policy": "deny Unknown u\n",
  });
  const gate = (pol) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out",
                                           path.join(d, ".candor", "g"), "--policy", path.join(d, pol)], { encoding: "utf8" });
  const pu = gate("pure-u.policy"), pe = gate("pure-e.policy"), du = gate("deny-unknown.policy");
  check("`pure` does NOT fire on an Unknown-only fn (exit 0 — Unknown is not an effect)",
        pu.status === 0, `status=${pu.status} ${pu.stdout}`);
  check("`pure` still fires on a genuinely effectful fn (006, exit 1)",
        pe.status === 1 && pe.stdout.includes("[AS-EFF-006]"), `status=${pe.status} ${pe.stdout}`);
  check("`deny Unknown <scope>` remains the strictness knob (006 on Unknown, exit 1)",
        du.status === 1 && du.stdout.includes("Unknown"), `status=${du.status} ${du.stdout}`);
}

// ── 3a. --json: stdout is the §2 envelope and stays PURE JSON — even with a firing policy gate ──────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`,
    "src/domain.ts": `import { save } from "./db.js";
import { DatabaseSync } from "node:sqlite";
export function place(db: DatabaseSync): void { save(db); }`,
    "policy": "deny Db domain\n",
  });
  // (a) plain --json: stdout parses as the §2 envelope
  const j = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--json"], { encoding: "utf8" });
  let env = null;
  try { env = JSON.parse(j.stdout); } catch { /* env stays null → checks fail with the raw text */ }
  check("--json stdout parses as the §2 envelope", env !== null && Array.isArray(env.functions), j.stdout.slice(0, 120));
  // (b) no report files are written in --json mode (the default .candor/ dir is not even created)
  check("--json writes NO files (no .candor/report.json)", !fs.existsSync(path.join(d, ".candor", "report.json")));

  // (c)+(d) --json + a firing policy gate: exit 1, stdout STILL pure JSON, violation text on stderr
  const jg = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--json", "--policy", path.join(d, "policy")], { encoding: "utf8" });
  check("--json + gate violation still exits 1", jg.status === 1, `status=${jg.status}`);
  let envG = null;
  try { envG = JSON.parse(jg.stdout); } catch { /* null → the check below fails with the raw stdout */ }
  check("--json + gate violation: stdout stays PURE JSON (no [AS-EFF-…] leak)",
        envG !== null && Array.isArray(envG.functions) && !jg.stdout.includes("[AS-EFF-"), jg.stdout.slice(0, 160));
  check("--json + gate violation: the [AS-EFF-…] line is on stderr",
        jg.stderr.includes("[AS-EFF-006]") && jg.stderr.includes("src.domain.place"), jg.stderr.slice(0, 200));
}

// ── 3c. --gate-json ⟨0.8⟩: the structured gate verdict, faithful to the exit code ───────────────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`,
    "src/domain.ts": `import { save } from "./db.js";
import { DatabaseSync } from "node:sqlite";
export function place(db: DatabaseSync): void { save(db); }`,
    "policy": "deny Db domain\n",
  });
  const gp = path.join(d, "gate.json");
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", path.join(d, "policy"), "--gate-json", gp], { encoding: "utf8" });
  check("--gate-json + violation still exits 1", r.status === 1, `status=${r.status}`);
  let v = null;
  try { v = JSON.parse(fs.readFileSync(gp, "utf8")); } catch { /* null → checks fail with raw */ }
  check(`--gate-json verdict declares spec ${SPEC}`, v?.spec === SPEC, JSON.stringify(v)?.slice(0, 120));
  check("--gate-json verdict ok:false on a failing gate", v?.ok === false, `ok=${v?.ok}`);
  const viol = v?.violations?.find((x) => x.fn === "src.domain.place");
  check("--gate-json names the violating fn with its rule", viol?.rule === "AS-EFF-006", JSON.stringify(v?.violations)?.slice(0, 160));
  check("--gate-json carries the denied effects", Array.isArray(viol?.effects) && viol.effects.includes("Db"), JSON.stringify(viol?.effects));

  // clean case: --gate-json with no gate configured writes ok:true, []
  const gp2 = path.join(d, "gate2.json");
  const r2 = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--gate-json", gp2], { encoding: "utf8" });
  let v2 = null;
  try { v2 = JSON.parse(fs.readFileSync(gp2, "utf8")); } catch { /* null */ }
  check("--gate-json with no gate → ok:true, []", r2.status === 0 && v2?.ok === true && v2.violations.length === 0, `status=${r2.status} ok=${v2?.ok}`);
  // ⟨0.15 staged⟩ a fully-covered scan's verdict carries NO coverage key — the pre-0.15 verdict is
  // byte-compatible, and conformance's cross-engine verdict compare sees the same field set.
  check("⟨0.15⟩ --gate-json on a fully-covered scan has NO coverage field (verdict unchanged)",
        v !== null && !("coverage" in v) && !("coverage" in (v2 ?? { coverage: 1 })),
        JSON.stringify(Object.keys(v ?? {})));
}

// ── 3c2. ⟨0.15 staged⟩ --gate-json coverage ADVISORY: disclosed, never verdict-affecting ────────────
// COVERAGE-DESIGN.md §3: when the κ ledger is non-empty the verdict gains `coverage: {uncovered: N,
// packages: [...]}` — VERDICT-PRESERVING (the ⟨0.9⟩ provable-purity auto-disclosure precedent): ok /
// violations / exit are identical with or without it, on both a failing and a passing gate.
if (blk()) {
  const stub = {
    "node_modules/blinddep/package.json": `{"name":"blinddep","version":"0.0.0","main":"index.js","types":"index.d.ts"}`,
    "node_modules/blinddep/index.d.ts": `export declare function poke(): string;`,
    "node_modules/blinddep/index.js": `module.exports.poke = () => "y";`,
  };
  const d = project({
    ...stub,
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
import { poke } from "blinddep";
export function save(db: DatabaseSync): void { poke(); db.exec("UPDATE customers SET v = 1"); }`,
    "deny-db.policy": "deny Db\n",
    "deny-net.policy": "deny Net\n",
  });
  const gate = (policy) => {
    const gp = path.join(d, `gate-${path.basename(policy)}.json`);
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", path.join(d, policy), "--gate-json", gp], { encoding: "utf8" });
    let v = null;
    try { v = JSON.parse(fs.readFileSync(gp, "utf8")); } catch { /* null → checks fail with raw */ }
    return { r, v };
  };
  const bad = gate("deny-db.policy");   // violation + uncovered dep
  check("⟨0.15⟩ gate advisory: a FAILING verdict carries the coverage note, ok/exit untouched",
        bad.r.status === 1 && bad.v?.ok === false && bad.v.violations.length === 1
          && JSON.stringify(bad.v.coverage) === JSON.stringify({ uncovered: 1, packages: ["blinddep"] }),
        `status=${bad.r.status} ${JSON.stringify(bad.v)}`);
  const good = gate("deny-net.policy"); // clean gate + uncovered dep
  check("⟨0.15⟩ gate advisory: a PASSING verdict stays ok:true/exit 0 — the note discloses, never gates",
        good.r.status === 0 && good.v?.ok === true && good.v.violations.length === 0
          && JSON.stringify(good.v.coverage) === JSON.stringify({ uncovered: 1, packages: ["blinddep"] }),
        `status=${good.r.status} ${JSON.stringify(good.v)}`);
  // ⟨0.22⟩ the completeness manifest inserts `analyzed:{count}` after `ok` (mirrors the java reference
  // verdict order + the report envelope); the pinned spec/ok/…/violations/coverage order is otherwise intact.
  check("⟨0.15⟩ gate advisory: field ORDER preserves the pinned verdict fields first (spec, ok, analyzed, violations)",
        JSON.stringify(Object.keys(bad.v ?? {})) === JSON.stringify(["spec", "ok", "analyzed", "violations", "coverage"]),
        JSON.stringify(Object.keys(bad.v ?? {})));
}

// ── 3c3. ⟨0.22⟩ COMPLETENESS MANIFEST: analyzed universe + fail-closed gate over unparsed source ─────
// The tier-1 rung ported from the java reference: (a) `analyzed:{count,digest}` counts the WHOLE analyzed
// universe (pure leaves included), so a consumer computes the pure count = analyzed.count − |functions|;
// (b) a syntactically-broken .ts is disclosed in the report's `unanalyzed` (was stderr-only); (c) a
// CONFIGURED gate over it fails closed — verdict {ok:false, incomplete:true, unanalyzed:[…]} + exit 2 (a
// real violation still dominates at exit 1); (d) the digest is stable across a same-input re-scan.
if (blk()) {
  const d = project({
    "src/good.ts": `export function pureAdd(x: number, y: number): number { return x + y; }
export async function fetchIt(u: string): Promise<Response> { return fetch(u); }`,
    "src/broken.ts": `export function oops( {\n  const x =\n`, // a syntax error — TS cannot parse it
    "deny-db.policy": "deny Db\n",  // the app performs Net, not Db → no real violation
    "deny-net.policy": "deny Net\n", // fetchIt performs Net → a real violation
  });
  // (a) the analyzed universe includes the pure fn the report omits.
  const { r: bareR } = scan(d, "--json");
  const env = JSON.parse(bareR.stdout);
  check("⟨0.22⟩ analyzed.count > |functions| (pure fn is analyzed but omitted from the report)",
        env.analyzed?.count > env.functions.length && env.analyzed.count - env.functions.length >= 1,
        `count=${env.analyzed?.count} |functions|=${env.functions.length}`);
  check("⟨0.22⟩ analyzed.digest is 16 lowercase hex chars",
        /^[0-9a-f]{16}$/.test(env.analyzed?.digest ?? ""), env.analyzed?.digest);
  // (b) the broken source is machine-legible in `unanalyzed`.
  check("⟨0.22⟩ a syntactically-broken .ts is disclosed in the report's `unanalyzed`",
        Array.isArray(env.unanalyzed) && env.unanalyzed.length === 1
          && env.unanalyzed[0].path.includes("broken") && env.unanalyzed[0].reason === "source failed to parse",
        JSON.stringify(env.unanalyzed));
  check("⟨0.22⟩ a BARE scan over unparsed source still exits 0 (disclosure, not a gate)", bareR.status === 0,
        `status=${bareR.status}`);
  // (d) the digest is stable across a same-input re-scan.
  const env2 = JSON.parse(scan(d, "--json").r.stdout);
  check("⟨0.22⟩ the analyzed-set digest is stable across a same-input re-scan",
        env.analyzed.digest === env2.analyzed.digest, `${env.analyzed.digest} vs ${env2.analyzed.digest}`);
  // (c) a CONFIGURED gate with NO real violation cannot certify → exit 2, verdict incomplete.
  const gp = path.join(d, "v.json");
  const gated = spawnSync("node", [path.join(HERE, "scan.mjs"), d,
    "--policy", path.join(d, "deny-db.policy"), "--gate-json", gp], { encoding: "utf8" });
  const v = JSON.parse(fs.readFileSync(gp, "utf8"));
  check("⟨0.22⟩ a gate over unparsed source cannot be green → exit 2 (could-not-evaluate)",
        gated.status === 2, `status=${gated.status}`);
  check("⟨0.22⟩ the verdict is {ok:false, incomplete:true, unanalyzed:[…]} (a machine learns WHY)",
        v.ok === false && v.incomplete === true && Array.isArray(v.unanalyzed) && v.unanalyzed.length === 1
          && v.unanalyzed[0].path.includes("broken"), JSON.stringify(v));
  check("⟨0.22⟩ the verdict mirrors the report's analyzed:{count}",
        v.analyzed?.count === env.analyzed.count, JSON.stringify(v.analyzed));
  // (c-cont) a real violation still DOMINATES (exit 1) and the incompleteness is still disclosed.
  const gp2 = path.join(d, "v2.json");
  const gated2 = spawnSync("node", [path.join(HERE, "scan.mjs"), d,
    "--policy", path.join(d, "deny-net.policy"), "--gate-json", gp2], { encoding: "utf8" });
  const v2 = JSON.parse(fs.readFileSync(gp2, "utf8"));
  check("⟨0.22⟩ a real violation outranks the incompleteness (exit 1)", gated2.status === 1,
        `status=${gated2.status}`);
  check("⟨0.22⟩ the incompleteness is still disclosed on a violating run",
        v2.ok === false && v2.incomplete === true && v2.violations.length >= 1, JSON.stringify(v2).slice(0, 160));
}

// ── 3d. --gate-json robustness: unwritable path never crashes; `-` keeps stdout pure ────────────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`,
    "policy": "deny Db\n",
  });
  // (a) unwritable verdict path: one stderr line, the true exit code kept (1 here — the violation), no throw.
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", path.join(d, "policy"), "--gate-json", path.join(d, "no/such/dir/gate.json")], { encoding: "utf8" });
  check("--gate-json unwritable path keeps the violation exit (1)", r.status === 1, `status=${r.status}`);
  check("--gate-json unwritable path: no raw stack trace", !r.stderr.includes("at ") || r.stderr.includes("could not write"), r.stderr.slice(0, 200));
  const rc = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--gate-json", path.join(d, "no/such/dir/gate.json")], { encoding: "utf8" });
  check("--gate-json unwritable path on a GATELESS run stays exit 0", rc.status === 0, `status=${rc.status} stderr=${rc.stderr.slice(0,120)}`);
  // (b) `--gate-json -`: stdout is PURE verdict JSON; the AS-EFF line goes to stderr.
  const rd = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", path.join(d, "policy"), "--gate-json", "-"], { encoding: "utf8" });
  let vd = null;
  try { vd = JSON.parse(rd.stdout); } catch { /* null → fail below with raw */ }
  check("--gate-json - : stdout parses as the pure verdict", vd?.ok === false, rd.stdout.slice(0, 160));
  check("--gate-json - : the AS-EFF line is on stderr", rd.stderr.includes("[AS-EFF-006]"), rd.stderr.slice(0, 160));
}

// ── 3e. .candor/config (§config): target-anchored, env-overridden, fail-closed ─────────────────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`,
    "deny-db.policy": "deny Db\n",
    "deny-net.policy": "deny Net\n",
    ".candor/config": "policy deny-db.policy\npolcy typo-key\n",
  });
  // (a) the checked-in config drives the gate — no flag, no env — discovered via the TARGET's
  // ancestors. The `policy` value is RELATIVE and the scan runs from a DIFFERENT cwd (this repo): it
  // must resolve against the config's repo root, never the process cwd (the family rule) — a
  // checked-in config means the same file wherever the scan is launched from.
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src")], { encoding: "utf8" });
  check(".candor/config drives the gate (exit 1, AS-EFF-006) — relative policy anchored to the repo, not the cwd",
        r.status === 1 && r.stdout.includes("[AS-EFF-006]"), `status=${r.status} ${r.stdout.slice(0,120)} ${r.stderr.slice(0,160)}`);
  check("unknown config key warns (typo protection)", r.stderr.includes("unknown config key 'polcy'"), r.stderr.slice(0, 200));
  // a configured-but-EMPTY policy (a bare `policy` line) fails LOUD (exit 2) — "" is falsy, and a
  // truthy gate check silently dropped it (the quiet gateless-green the §config posture forbids)
  const dEmpty = project({
    "src/p.ts": `export function f(): void { /* pure */ }`,
    ".candor/config": "policy\n",
  });
  const rEmpty = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(dEmpty, "src")], { encoding: "utf8" });
  check("a bare `policy` config line fails closed (exit 2), never a silent no-gate",
        rEmpty.status === 2 && /could not be read/.test(rEmpty.stderr), `status=${rEmpty.status} ${rEmpty.stderr.slice(0,160)}`);
  // (b) the env overrides the config (a passing deny-Net policy wins over the config's deny-Db)
  const re = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src")], { encoding: "utf8", env: { ...process.env, CANDOR_POLICY: path.join(d, "deny-net.policy") } });
  check("CANDOR_POLICY env overrides the config", re.status === 0, `status=${re.status} ${re.stderr.slice(0,120)}`);
  // (c) a set-but-unusable CANDOR_CONFIG fails closed (exit 2), never silently gateless
  const rc = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src")], { encoding: "utf8", env: { ...process.env, CANDOR_CONFIG: path.join(d, "no-such-config") } });
  check("typo'd CANDOR_CONFIG fails closed (exit 2)", rc.status === 2, `status=${rc.status}`);
  // (d) INERT-KEY DISCLOSURE (§config, the 2026-07-09 amendment; candor-scan's config.rs is the twin): a
  // key in the FAMILY vocabulary that this engine does not wire (strict/no-ambient/closed-world/taint)
  // SAYS SO — a checked-in `closed-world` that changes behaviour on the JVM engine and silently nothing
  // here is a declared-gate-silently-off. Disclosure is stderr-only: exit code, stdout, report untouched.
  const dInert = project({
    "src/p.ts": `export function f(): void { /* pure */ }`,
    ".candor/config": "closed-world true\nstrict\n",
  });
  const rInert = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(dInert, "src"), "--json"], { encoding: "utf8" });
  for (const k of ["closed-world", "strict"]) {
    check(`a recognized-but-unimplemented config key '${k}' is DISCLOSED (never silently ignored)`,
          new RegExp(`config key '${k}' is recognized by the candor family but not implemented by candor-ts`).test(rInert.stderr),
          rInert.stderr.slice(0, 300));
    check(`an inert config key '${k}' is NOT reported as an UNKNOWN key (a typo and a coverage gap are different cases)`,
          !rInert.stderr.includes(`ignoring unknown config key '${k}'`), rInert.stderr.slice(0, 300));
  }
  let inertReport = null;
  try { inertReport = JSON.parse(rInert.stdout); } catch { /* null → fails below with the raw stdout */ }
  check("inert-key disclosure is stderr-only: exit 0 and stdout stays PURE report JSON",
        rInert.status === 0 && Array.isArray(inertReport?.functions), `status=${rInert.status} ${rInert.stdout.slice(0, 160)}`);
  // The OTHER half of the gate: an IMPLEMENTED key must NOT warn — without this the fix degenerates into
  // "warn about everything" and the disclosure stops meaning anything. `policy` here drives a real gate.
  const rLive = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src")], { encoding: "utf8" });
  check("an IMPLEMENTED config key ('policy') is never disclosed as inert",
        !/config key 'policy' is recognized by the candor family/.test(rLive.stderr), rLive.stderr.slice(0, 300));
  check("the implemented key still drives its mode (the config `policy` gate fires, exit 1)",
        rLive.status === 1 && rLive.stdout.includes("[AS-EFF-006]"), `status=${rLive.status} ${rLive.stdout.slice(0, 120)}`);
}

// ── 3f. diff/gains disclose a producing-build mismatch (§2.1 — baseline-invalidation) ──────────────
if (blk()) {
  const d = scratch("candor-basever-");
  fs.writeFileSync(path.join(d, "cur.json"), JSON.stringify({ candor: { version: "bbbbbbb", spec: "0.23" },
    functions: [{ fn: "a.leaf", inferred: ["Net", "Log"], direct: ["Net", "Log"] }] }));
  fs.writeFileSync(path.join(d, "base.json"), JSON.stringify({ candor: { version: "aaaaaaa", spec: "0.23" },
    functions: [{ fn: "a.leaf", inferred: ["Net"], direct: ["Net"] }] }));
  const r = spawnSync("node", [path.join(HERE, "query.mjs"), "diff", path.join(d, "cur"), path.join(d, "base"), "--json"], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  check("diff carries the producing builds (rust-parity fields)", out.baseline_version === "aaaaaaa" && out.engine_version === "bbbbbbb", r.stdout.slice(0, 120));
  check("diff EXITS 0 under a version mismatch (disclosure, not a gate — the bogus-wave CI failure the posture forbids)", r.status === 0, `status=${r.status}`);
  check("diff still reports the drift (disclosure, not suppression)", out.changes.length === 1 && out.changes[0].gained.includes("Log"), JSON.stringify(out.changes));
  check("the mismatch note is on stderr", r.stderr.includes("baseline-invalidating") && r.stderr.includes("aaaaaaa"), r.stderr.slice(0, 160));
  // same-build → no note
  fs.writeFileSync(path.join(d, "base.json"), JSON.stringify({ candor: { version: "bbbbbbb", spec: "0.23" },
    functions: [{ fn: "a.leaf", inferred: ["Net"], direct: ["Net"] }] }));
  const r2 = spawnSync("node", [path.join(HERE, "query.mjs"), "diff", path.join(d, "cur"), path.join(d, "base"), "--json"], { encoding: "utf8" });
  check("same producing build → no mismatch note", !r2.stderr.includes("⚠"), r2.stderr.slice(0, 120));
  check("same build WITH a gain → exits 1 (the legitimate ratchet signal is preserved)", r2.status === 1, `status=${r2.status}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 3b. single-dash unknown flag is rejected (NOT read as a positional target) ──────────────────────
if (blk()) {
  const bad = spawnSync("node", [path.join(HERE, "scan.mjs"), "-policy", "/nonexistent-xyz"], { encoding: "utf8" });
  check("a single-dash unknown flag (`-policy`) exits 2 as an unknown flag, not a scan target",
        bad.status === 2 && bad.stderr.includes("unknown flag -policy"), bad.stderr.slice(0, 120));
}

// ── masking evasion (the cross-engine HIGH): a benign captured host must NOT certify an invisible
// runtime-host reach; a use-call (write) after a captured connect host must NOT false-positive ──────
if (blk()) {
  const d = project({
    "src/m.ts": `import https from "https";
import { connect } from "net";
export function maskFn(evil: string): void { https.get("https://benign.com/x"); https.get(evil); }
export function cleanFn(): void { const s = connect(443, "benign.com"); s.write(Buffer.from("d")); }`,
    "policy": "allow Net benign.com\n",
  });
  const { r } = scan(d, "--policy", path.join(d, "policy"));
  check("masking: an invisible runtime-host reach is NOT certified by a benign captured host (008)",
        r.stdout.includes("[AS-EFF-008]") && r.stdout.includes("src.m.maskFn"), r.stdout);
  check("masking: a use-call (write) after a captured connect host does NOT false-positive",
        !r.stdout.includes("src.m.cleanFn"), r.stdout);
}

// ── sweep 2026-06-17: masking generalized to all 4 effects; establishing-set; fabrication; setters;
// disclosure; bare-CR. Each guards a confirmed, reproduced finding. ───────────────────────────────
if (blk()) {
  // [11] masking is NOT Net-only: an Fs runtime-path / Exec runtime-command masked by a benign literal
  // must fail closed; [12] dgram.send (UDP) is host-establishing.
  const d = project({
    "src/m.ts": `import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as dgram from "node:dgram";
export function maskFs(p: string): void { fs.writeFileSync("/var/app/ok.txt","ok"); fs.writeFileSync(p,"x"); }
export function cleanFs(): void { fs.writeFileSync("/var/app/ok.txt","ok"); }
export function maskExec(c: string): void { cp.execFileSync("ls"); cp.execFileSync(c); }
export function maskUdp(h: string): void { const s = dgram.createSocket("udp4"); s.send(Buffer.from("x"),53,"safe.example.com"); s.send(Buffer.from("x"),53,h); }`,
    "pol.fs": "allow Fs /var/app\n", "pol.exec": "allow Exec ls\n", "pol.net": "allow Net safe.example.com\n",
  });
  const fsG = scan(d, "--policy", path.join(d, "pol.fs")).r.stdout;
  check("masking Fs: invisible runtime path fails closed", fsG.includes("[AS-EFF-008]") && fsG.includes("src.m.maskFs"), fsG);
  check("masking Fs: the clean benign-literal path certifies", !fsG.includes("src.m.cleanFs"), fsG);
  check("masking Exec: invisible runtime command fails closed",
        scan(d, "--policy", path.join(d, "pol.exec")).r.stdout.includes("src.m.maskExec"));
  check("masking [12]: dgram.send UDP runtime host fails closed",
        scan(d, "--policy", path.join(d, "pol.net")).r.stdout.includes("src.m.maskUdp"));
}
if (blk()) {
  // ⟨0.29⟩ dgram's DESTINATION is at argument 2 or 4, and argument 0 is the MESSAGE. `urlArgLiteral`
  // fell through to `litAt(0)` for `send`, so the payload was published as the endpoint.
  //
  // WHY THE ROW ABOVE COULD NOT SEE IT, which is the durable half: its fixture sends
  // `Buffer.from("x")`. A Buffer is not a string literal, so `litAt(0)` returned null there and the
  // masking assertion passed for a reason that had nothing to do with the position rule. The moment the
  // message is a plain string — the ordinary way to send text over UDP — arg0 becomes a literal and is
  // read as the host. A fixture chosen for one property silently decided another.
  //
  // MEASURED: `s.send("telemetry.example", 0, 17, 53, dst)` published
  // `hosts: ["telemetry.example"]` with NO `incomplete`, so `allow Net telemetry.example` answered
  // `policy ✓` at exit 0 over a send to a runtime-controlled address — a fabricated destination masking
  // a real one. candor-java and candor-swift fail closed on their equivalents.
  const d = project({
    "src/u.ts": `import * as dgram from "node:dgram";
const s = dgram.createSocket("udp4");
export function payloadIsNotTheHost(dst: string): void { s.send("telemetry.example", 0, 17, 53, dst); }
export function litLongForm(): void { s.send("payload", 0, 7, 53, "telemetry.example"); }
export function litShortForm(): void { s.send("payload", 53, "telemetry.example"); }`,
    "pol.net": "allow Net telemetry.example\n",
  });
  const g = scan(d, "--policy", path.join(d, "pol.net")).r.stdout;
  const rep = scan(d).report;
  const hosts = (fn) => (entry(rep, fn)?.hosts ?? []).join(",");
  check("⟨0.29⟩ dgram: the MESSAGE at arg0 is not published as the host — it is the payload, not the endpoint",
        hosts("src.u.payloadIsNotTheHost") === "", hosts("src.u.payloadIsNotTheHost"));
  check("⟨0.29⟩ dgram: …and the runtime destination is disclosed rather than certified by that payload",
        g.includes("[AS-EFF-008]") && g.includes("src.u.payloadIsNotTheHost"), g);
  // THE OVER-CHARGE CONTROLS — both documented overloads. Without these the fix is satisfied by never
  // reading a dgram address at all, which fails the row above for free and answers nothing for a user.
  check("⟨0.29⟩ dgram CONTROL: send(msg, offset, length, port, address) captures the address at arg4",
        hosts("src.u.litLongForm") === "telemetry.example", hosts("src.u.litLongForm"));
  check("⟨0.29⟩ dgram CONTROL: send(msg, port, address) captures the address at arg2",
        hosts("src.u.litShortForm") === "telemetry.example", hosts("src.u.litShortForm"));
  check("⟨0.29⟩ dgram CONTROL: …and both literal-address forms CERTIFY under the allowlist",
        !g.includes("src.u.litLongForm") && !g.includes("src.u.litShortForm"), g);
}
if (blk()) {
  // ⟨0.29⟩ THE FOURTH AND LAST LOCATOR SURFACE. `Db` read the first string literal ANYWHERE in the call
  // and parsed it as SQL, so a literal in the PARAMS position became the table — and because a table HAD
  // been captured, the masking guard below it never fired. MEASURED:
  // `db.query(userSql, "SELECT * FROM audit_log")` → `tables: ["audit_log"]`, no `incomplete`, and the
  // function was ABSENT from the violation list under `allow Db audit_log`: a green gate over a query
  // whose SQL is a runtime value. Every string-SQL client puts the statement at argument 0
  // (`query(text, values)`, `execute(sql, params)`, `raw(sql, bindings)`, `prepare(sql)`), so a later
  // literal is a parameter, a fallback query or a health-check string — data, not the statement run.
  //
  // candor-rust reads argument 0 already; candor-java captures the same fabricated table but ALSO marks
  // `incomplete`, so its verdict fails closed on an imprecise report rather than certifying.
  const d = project({
    "node_modules/pg/package.json": `{"name":"pg","version":"8.0.0","types":"index.d.ts","main":"index.js"}`,
    "node_modules/pg/index.d.ts": `export declare class Client { query(text: string, values?: any): Promise<any>; }`,
    "node_modules/pg/index.js": `exports.Client = class Client { query(){} };`,
    "src/q.ts": `import { Client } from "pg";
const db = new Client();
export function paramsLit(userSql: string): void { db.query(userSql, "SELECT * FROM audit_log"); }
export function okLit(p: string): void { db.query("SELECT * FROM ok_table WHERE x=$1", [p]); }`,
    "pol.db": "allow Db audit_log\n",
  });
  const rep = scan(d).report;
  const g = scan(d, "--policy", path.join(d, "pol.db")).r.stdout;
  const tables = (fn) => (entry(rep, fn)?.tables ?? []).join(",");
  check("⟨0.29⟩ Db: a SQL-shaped literal in the PARAMS position is not published as a table",
        tables("src.q.paramsLit") === "", tables("src.q.paramsLit"));
  check("⟨0.29⟩ Db: …and the runtime SQL is disclosed rather than certified by that literal",
        g.includes("[AS-EFF-008]") && g.includes("src.q.paramsLit"), g);
  // THE OVER-CHARGE CONTROL: reading argument 0 only must not cost the real surface.
  check("⟨0.29⟩ Db CONTROL: a literal SQL at argument 0 still yields its table",
        tables("src.q.okLit") === "ok_table", tables("src.q.okLit"));
}
if (blk()) {
  // [9] net-cluster fabrication: pure config/metadata members are NOT Net.
  const d = project({
    "src/f.ts": `import * as tls from "node:tls";
import * as http from "node:http";
export function ciphers() { return tls.getCiphers(); }
export function validate(n: string) { return http.validateHeaderName(n); }`,
  });
  const { report } = scan(d);
  check("[9] tls.getCiphers is pure (not fabricated Net)", !entry(report, "src.f.ciphers"));
  check("[9] http.validateHeaderName is pure (not fabricated Net)", !entry(report, "src.f.validate"));
}
if (blk()) {
  // [10] compound/logical assignment invokes the setter; [32] destructuring-assignment target.
  const d = project({
    "src/s.ts": `import * as fs from "node:fs";
class C { #n = 0; get count() { return this.#n; } set count(v: number) { fs.appendFileSync("/p", String(v)); } }
export function bump(c: C) { c.count += 1; }
export function coalesce(c: C) { c.count ??= 5; }
export function destr(c: C) { ({ count: c.count } = { count: 7 }); }
export function read(c: C) { return c.count; }`,
  });
  const { report } = scan(d);
  check("[10] compound-assign (+=) invokes the effectful setter", entry(report, "src.s.bump")?.inferred.includes("Fs"));
  check("[10] logical-assign (??=) invokes the effectful setter", entry(report, "src.s.coalesce")?.inferred.includes("Fs"));
  check("[32] destructuring-assign target invokes the setter", entry(report, "src.s.destr")?.inferred.includes("Fs"));
}
if (blk()) {
  // [31] a local `process` shadow must NOT fabricate Ipc/Clock by callee text.
  const d = project({
    "src/p.ts": `export function f() { const process = { send: (x: number) => x + 1 }; return process.send(41); }`,
  });
  check("[31] local process shadow does not fabricate Ipc", !entry(scan(d).report, "src.p.f"));
}
if (blk()) {
  // [13] implicit-ctor blind class: `new Pool()` from an unmodeled pkg discloses `invisible`, not plain pure.
  const d = project({
    "node_modules/unmodeled-pkg/package.json": `{ "name": "unmodeled-pkg", "version": "1.0.0", "types": "index.d.ts", "main": "index.js" }`,
    "node_modules/unmodeled-pkg/index.d.ts": `export class Pool { query(): void; }`,
    "node_modules/unmodeled-pkg/index.js": `class Pool { query(){} }\nmodule.exports = { Pool };`,
    "src/x.ts": `import { Pool } from "unmodeled-pkg";\nexport function makePool() { return new Pool(); }`,
    "tsconfig.json": `{ "compilerOptions": { "target": "ES2020", "module": "commonjs", "moduleResolution": "node", "skipLibCheck": true }, "include": ["src/**/*"] }`,
  });
  const f = entry(scan(d).report, "src.x.makePool");
  check("[13] blind-class construction discloses invisible (not silent-pure)",
        f && (f.invisible ?? []).includes("unmodeled-pkg"), JSON.stringify(f));
}
if (blk()) {
  // [17] bare-CR policy: a multi-rule classic-Mac policy must not collapse to rule 1.
  const d = project({
    "src/h.ts": `import * as cp from "node:child_process";\nexport function hop() { cp.execSync("ls"); }`,
    "pol": "deny Clock nope\rdeny Exec hop\rdeny Net nope2\r",
  });
  const g = scan(d, "--policy", path.join(d, "pol")).r.stdout;
  check("[17] bare-CR policy: rule after \\r is enforced (not dropped)",
        g.includes("[AS-EFF-006]") && g.includes("src.h.hop"), g);
}

// ── 4. honest Unknown: a callback parameter never reads pure ──────────────────────────────────────
if (blk()) {
  const d = project({
    "src/cb.ts": `export function run(f: () => void): void { f(); }`,
  });
  const { report } = scan(d);
  check("callback param call -> Unknown (never silent-pure)",
        entry(report, "src.cb.run")?.unresolved === true);
}

// ── 5. tsconfig project discovery + test exclusion ────────────────────────────────────────────────
if (blk()) {
  const d = project({
    "tsconfig.json": `{"compilerOptions": {"strict": true}, "include": ["src", "test"]}`,
    "src/x.ts": `import * as fsm from "node:fs";
export function go(): void { fsm.readFileSync("/x"); }`,
    "test/x.test.ts": `import * as fsm from "node:fs";
export function harness(): void { fsm.rmSync("/danger"); }`,
  });
  const { report } = scan(d);
  check("tsconfig include honored, tests excluded",
        entry(report, "src.x.go") && !report.functions.some((e) => e.fn.includes("harness")),
        JSON.stringify(report.functions.map((e) => e.fn)));
}

// ── 6. class arrow-properties + constructors are units (the got dogfood holes) ───────────────────
if (blk()) {
  const d = project({
    "src/h.ts": `import * as fsm from "node:fs";
export class Handler {
  private readonly onError = (): void => { fsm.rmSync("/tmp/x"); };
  constructor() { fsm.readFileSync("/cfg"); }
  fire(): void { this.onError(); }
}
export function boot(): Handler { return new Handler(); }`,
  });
  const { report, cg } = scan(d);
  check("class arrow-property is a unit with its effects",
        entry(report, "src.h.Handler.onError")?.inferred.includes("Fs"),
        JSON.stringify(report.functions.map((e) => e.fn)));
  check("calling an arrow-property edges to it", cg["src.h.Handler.fire"]?.includes("src.h.Handler.onError"));
  check("constructor is a unit; `new` edges to it",
        cg["src.h.boot"]?.includes("src.h.Handler.constructor")
        && entry(report, "src.h.boot")?.inferred.includes("Fs"),
        JSON.stringify(cg));
}

// ── 7. callback_named: all-named call sites resolve; an opaque one keeps Unknown ─────────────────
if (blk()) {
  const d = project({
    "src/cb.ts": `import * as fsm from "node:fs";
export function effectful(): void { fsm.readFileSync("/x"); }
export function pureFn(n: number): number { return n; }
function invoke(cb: () => void): void { cb(); }
export function a(): void { invoke(effectful); }
export function b(): void { invoke(effectful); }
function invokeOpaque(cb: () => void): void { cb(); }
export function c(f: () => void): void { invokeOpaque(f); }`,
  });
  const { report, cg } = scan(d);
  check("all-named callback resolves to targets (no false Unknown)",
        cg["src.cb.invoke"]?.includes("src.cb.effectful")
        && entry(report, "src.cb.invoke")?.inferred.includes("Fs")
        && entry(report, "src.cb.invoke")?.unresolved === false,
        JSON.stringify(entry(report, "src.cb.invoke")));
  check("an opaque call site keeps the honest Unknown",
        entry(report, "src.cb.invokeOpaque")?.unresolved === true);
}

// ── 8. field initializers attribute to the constructor (the silent-pure hole) ────────────────────
if (blk()) {
  const d = project({
    "src/f.ts": `import * as fsm from "node:fs";
export class Config {
  data = fsm.readFileSync("/etc/cfg");
  constructor(public name: string) {}
}
export class Implicit { data = fsm.rmSync("/x"); }
export function load(): Config { return new Config("x"); }
export function make(): Implicit { return new Implicit(); }`,
  });
  const { report } = scan(d);
  check("field-init effects land on the explicit ctor",
        entry(report, "src.f.Config.constructor")?.inferred.includes("Fs"));
  check("caller inherits them precisely (no false Unknown)",
        entry(report, "src.f.load")?.inferred.includes("Fs") && entry(report, "src.f.load")?.unresolved === false);
  check("implicit ctor synthesized; `new` edges to it",
        entry(report, "src.f.make")?.inferred.includes("Fs") && entry(report, "src.f.make")?.unresolved === false,
        JSON.stringify(entry(report, "src.f.make")));
}

// ── 8b. TOP-LEVEL executable statements attribute to a synthesized `<module>` unit (the ESM
// top-level-await / serverless-handler silent-pure hole: a file whose top-level body does I/O was
// scanned as functions:[] → a false "pure" verdict that a `deny Llm`/`deny Fs` gate PASSED). The
// module body is the file's own initializer — the field-init `Class.constructor` synthesis one level
// up. Minted LAZILY, unitKind "initializer" (spec §2, java's `<clinit>` twin). ──────────────────
if (blk()) {
  const d = project({
    "src/tla.ts": `const r = await fetch("https://api.openai.com/x"); export { r };`,
    "src/fsmod.ts": `import { readFileSync } from "node:fs";\nconst c = readFileSync("/etc/x"); export { c };`,
    "src/reach.ts": `function work(){ return fetch("https://api.openai.com/x"); }\nwork();`,
    "src/pure.ts": `const x = 1 + 2; export function f(): number { return x; }`,
    "src/dec.ts": `function factory(){ fetch("https://api.openai.com/x"); return (t: any) => t; }\n@factory()\nexport class C {}`,
    "src/sb.ts": `export class C { static { fetch("https://api.openai.com/x"); } }`,
  });
  const { report } = scan(d);
  // a `static { … }` block runs at class-DEFINITION, not instance construction — its own initializer
  // unit `C.<static-init>` (unitKind initializer), NOT folded into the instance `C.constructor`.
  const sb = entry(report, "src.sb.C.<static-init>");
  check("static block → C.<static-init> unit carries Llm+Net (not folded into the ctor)",
        sb && sb.inferred.includes("Llm") && sb.inferred.includes("Net"), JSON.stringify(report.functions));
  check("the static-init unit is tagged unitKind:initializer",
        sb?.unitKind === "initializer", JSON.stringify(sb));
  check("a static block is NOT attributed to C.constructor",
        entry(report, "src.sb.C.constructor") == null, JSON.stringify(report.functions));
  const m1 = entry(report, "src.tla.<module>");
  check("top-level await fetch → <module> unit carries Llm+Net (not silent-pure)",
        m1 && m1.inferred.includes("Llm") && m1.inferred.includes("Net"), JSON.stringify(report.functions));
  check("the synthesized <module> unit is tagged unitKind:initializer",
        m1?.unitKind === "initializer", JSON.stringify(m1));
  check("top-level `const c = readFileSync(...)` → <module> carries Fs",
        entry(report, "src.fsmod.<module>")?.inferred.includes("Fs"), JSON.stringify(report.functions));
  check("top-level `work()` makes <module> TRANSITIVELY Llm+Net (edge, not dropped)",
        entry(report, "src.reach.<module>")?.inferred.includes("Net")
          && entry(report, "src.reach.work")?.inferred.includes("Net"), JSON.stringify(report.functions));
  check("a PURE top-level does NOT gain a <module> unit (pure units omitted)",
        entry(report, "src.pure.<module>") == null, JSON.stringify(report.functions));
  check("a DECORATOR application (@factory()) is NOT attributed to <module> (load-time, factory owns it)",
        entry(report, "src.dec.<module>") == null && entry(report, "src.dec.factory")?.inferred.includes("Net"),
        JSON.stringify(report.functions));
}


// ── 8b-i. The MODULE-IMPORT EDGE: importing a module RUNS its top level, so the importer reaches
// whatever that initializer does. candor-ts had the initializer UNIT (8b) but not the EDGE INTO it, so
// `app` requiring an effectful `dep` read sound-complete pure while `dep.<module>` read {Env} two lines
// away — a false all-clear found on real code (candor-spec SOUNDNESS-VEIN-initializer-edge.md); the JVM
// engine has had the equivalent GETSTATIC→<clinit> edge all along. Only specifiers resolving INSIDE the
// scanned set get an edge, so both ends are analyzed and no `Unknown` is invented. ──────────────────
if (blk()) {
  const d = project({
    "src/dep.ts": `export const dbg = process.env.NODE_DEBUG || "";`,
    "src/app.ts": `import { dbg } from "./dep";\nexport const n = 1;`,
    "src/cjs.ts": `const d = require("./dep");\nexport const m = 2;`,
    "src/deep.ts": `import { n } from "./app";\nexport const q = n;`,
    "src/purelib.ts": `export const k = 1 + 2;`,
    "src/usespure.ts": `import { k } from "./purelib";\nexport const z = k;`,
    "src/infn.ts": `export function load() { const d = require("./dep"); return d.dbg; }`,
    "src/ext.ts": `import { x } from "some-external-pkg";\nexport const e = x;`,
  });
  const { report } = scan(d);
  check("ESM import of an effectful module → the importer's <module> reaches Env",
        entry(report, "src.app.<module>")?.inferred.includes("Env"), JSON.stringify(report.functions));
  check("CJS require of an effectful module → same edge",
        entry(report, "src.cjs.<module>")?.inferred.includes("Env"), JSON.stringify(report.functions));
  check("the edge is TRANSITIVE across a chain of importers (deep → app → dep)",
        entry(report, "src.deep.<module>")?.inferred.includes("Env"), JSON.stringify(report.functions));
  // The anti-flood property, and the reason this fix needs no Unknown: an edge into a PURE initializer
  // produces a pure unit, and pure units are omitted. Importing must not manufacture a report entry.
  check("importing a PURE module mints no <module> unit (no flood)",
        entry(report, "src.usespure.<module>") == null, JSON.stringify(report.functions));
  // A require() inside a function body is that FUNCTION's reach, not the module initializer's.
  check("require() inside a function charges the FUNCTION, not <module>",
        entry(report, "src.infn.load")?.inferred.includes("Env")
          && entry(report, "src.infn.<module>") == null, JSON.stringify(report.functions));
  // A bare specifier is an external package: out of the scanned set, so deliberately unchanged here —
  // blanket-disclosing it measured at 60-100% of modules (see the vein doc). Guards against the fix
  // quietly widening into the flood it was designed to avoid.
  // ...and when the dependency's report IS chained, the same edge becomes DETERMINED rather than absent:
  // importing a package runs its entry module, and the dep's initializers already hash under `<pkg>#<module>`.
  // This is the external half of the vein, and it invents no `Unknown` — an UNCHAINED dependency is still
  // left exactly alone (the check above), because blanket-disclosing every external import measured at
  // 60-100% of modules.
  {
    // the dependency, scanned on its own — its top level performs a Clock read
    const depDir = project({ "index.ts": `export const t = Date.now();` });
    fs.writeFileSync(path.join(depDir, "package.json"),
                     JSON.stringify({ name: "some-external-pkg", version: "0.0.0" }));
    const { prefix: depPrefix } = scan(depDir);
    const d2 = project({ "src/uses.ts": `import { x } from "some-external-pkg";\nexport const e = x;` });
    // chaining is CANDOR_DEPS / config (`--deps` is the --workspace alias), so spawn with the env set
    spawnSync("node", [path.join(HERE, "scan.mjs"), d2],
              { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
    const r2 = JSON.parse(fs.readFileSync(path.join(d2, ".candor", "report.json"), "utf8"));
    // ...and `--dep-inits` produces that chain automatically: node_modules is on disk, so the packages the
  // project imports at top level get scanned and chained without the user staging reports by hand. Bounded
  // to DIRECT dependencies (a bare specifier at file scope), and anything not installed is skipped and
  // reported as such rather than silently counted.
  {
    const app = project({ "src/a.ts": `import { t } from "dep-with-init";\nexport const v = t;` });
    const nm = path.join(app, "node_modules", "dep-with-init");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "package.json"),
                     JSON.stringify({ name: "dep-with-init", version: "0.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(nm, "index.js"), `const t = Date.now();\nmodule.exports = { t };`);
    const { report: r3 } = scan(app, "--allow-js", "--dep-inits");
    check("--dep-inits scans an installed dep and its initializer reaches the importer",
          entry(r3, "src.a.<module>")?.inferred.includes("Clock"), JSON.stringify(r3?.functions));
  }
    check("a CHAINED external dep's initializer effects reach the importing <module>",
          entry(r2, "src.uses.<module>")?.inferred.includes("Clock"), JSON.stringify(r2?.functions));
  }
    check("a bare (external) specifier does NOT mint an initializer unit",
        entry(report, "src.ext.<module>") == null, JSON.stringify(report.functions));
}

// ── 8c. the MONOREPO shape discloses exactly like the published shape ─────────────────────────────
// candor-spec SOUNDNESS-VEIN-crossing-the-scan-boundary.md, "ts, monorepo shape": a workspace dep is a
// SYMLINK into node_modules and the checker resolves it to its REAL path, which carries no
// `node_modules/` segment. Every κ-ledger / `invisible` arm was gated on that segment, so a symlinked
// sibling package produced NO disclosure at all — no `invisible`, no `coverage.uncovered`, no stderr
// advisory — while the PUBLISHED-package form of the SAME code disclosed correctly. In a monorepo that
// made every cross-package reach read confidently pure. Both shapes are asserted side by side so they
// can never drift apart again.
if (blk()) {
  const wsdepSrc = { "package.json": JSON.stringify({ name: "wsdep", version: "0.0.0", main: "dist/index.js", types: "dist/index.d.ts" }),
                     "dist/index.d.ts": `export declare class Entry { toString(): string; }\nexport declare function writeIt(x: string): void;\n`,
                     "dist/index.js": `"use strict";\nconst fs = require("fs");\nexports.writeIt = (x) => fs.writeFileSync("/tmp/w", x);\n` };
  const appSrc = `import { writeIt } from "wsdep";\nexport function go(): void { writeIt("x"); }\n`;
  // (a) SYMLINKED workspace dep — the sibling package lives outside the scanned tree.
  const sib = project(wsdepSrc);
  const mono = project({ "src/m.ts": appSrc });
  fs.mkdirSync(path.join(mono, "node_modules"), { recursive: true });
  fs.symlinkSync(sib, path.join(mono, "node_modules", "wsdep"), "dir");
  const { report: mrep, r: mr } = scan(mono);
  // (b) the same code with the dep INSTALLED as a real directory (the published-package shape).
  const pub = project({ "src/m.ts": appSrc });
  for (const [rel, content] of Object.entries(wsdepSrc)) {
    const p = path.join(pub, "node_modules", "wsdep", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const { report: prep } = scan(pub);
  check("a SYMLINKED workspace dep is disclosed as invisible (not silently pure)",
        entry(mrep, "src.m.go")?.invisible?.includes("wsdep"), JSON.stringify(mrep.functions));
  check("...and it reaches the κ-coverage ledger (coverage.uncovered)",
        mrep.coverage?.uncovered?.some((u) => u.name === "wsdep"), JSON.stringify(mrep.coverage));
  check("...and the loud stderr advisory names it",
        /wsdep/.test(mr.stderr), mr.stderr);
  check("the monorepo shape discloses IDENTICALLY to the published-package shape",
        JSON.stringify(entry(mrep, "src.m.go")?.invisible) === JSON.stringify(entry(prep, "src.m.go")?.invisible),
        `${JSON.stringify(entry(mrep, "src.m.go"))} vs ${JSON.stringify(entry(prep, "src.m.go"))}`);
  // The anti-flood counterpart: the scan's OWN package is never a foreign package. A file of ours that
  // the target simply didn't include (our own `dist/` typings) must not make us blind to ourselves.
  const self = project({ "package.json": JSON.stringify({ name: "selfpkg", version: "0.0.0" }),
                         "types/shape.d.ts": `export declare function helper(): void;\n`,
                         "src/u.ts": `import { helper } from "../types/shape";\nexport function call(): void { helper(); }\n` });
  const { report: srep } = scan(path.join(self, "src"));
  check("the scan's OWN package is not disclosed as an external blind spot",
        !(entry(srep, "u.call")?.invisible ?? []).includes("selfpkg"), JSON.stringify(srep.functions));
}

// ── 9. ambient builtins + crypto tier + the missing-deps warning (CTA dogfood) ───────────────────
if (blk()) {
  const d = project({
    "src/a.ts": `export function slugish(): number { return Math.random(); }
export function stamp(): Date { return new Date(); }
export function parsed(): Date { return new Date("2020-01-01"); }`,
  });
  const { report } = scan(d);
  check("Math.random -> Rand", entry(report, "src.a.slugish")?.inferred.includes("Rand"));
  check("new Date() -> Clock", entry(report, "src.a.stamp")?.inferred.includes("Clock"));
  check("new Date(string) is parsing, not Clock", entry(report, "src.a.parsed") == null,
        JSON.stringify(entry(report, "src.a.parsed")));
}
if (blk()) {
  // covered-module precision: crypto's generateKeyPair*/generateKey*/generatePrime* draw from the CSPRNG
  // just like random* — they read silent-pure before being modeled (the κ-coverage floor can't tell an
  // unmodeled entropy draw from a pure unmodeled member; the fix is to MODEL the member).
  const d = project({
    "src/k.ts": `import * as crypto from "node:crypto";
export function keypair() { return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }); }
export function prime() { return crypto.generatePrimeSync(256); }`,
  });
  const { report } = scan(d);
  check("crypto.generateKeyPairSync -> Rand", entry(report, "src.k.keypair")?.inferred.includes("Rand"));
  check("crypto.generatePrimeSync -> Rand", entry(report, "src.k.prime")?.inferred.includes("Rand"));
}
if (blk()) {
  const d = project({
    "package.json": `{"dependencies": {"left-pad": "1.0.0"}}`,
    "src/x.ts": `export function f(): number { return 1; }`,
  });
  const { r } = scan(d);
  check("missing node_modules warns LOUDLY", r.stderr.includes("WARNING") && r.stderr.includes("npm install"));
}
if (blk()) {
  // Regression for the 0.9 dogfood trap (scanning `zx/src`): a SUBDIR scan of a project whose manifest is
  // one level up, whose deps are devDependencies (npm install fetches those too), and with no node_modules —
  // must STILL warn. Before: the check only looked at <scanRoot>/package.json's `dependencies`, so this read
  // as a codebase full of spurious `Unknown`s with no warning. Exercises both fixes (walk-up + devDeps).
  const d = project({
    "package.json": `{"devDependencies": {"chalk": "^5"}}`,
    "src/x.ts": `import chalk from "chalk";\nexport function f(s: string): string { return chalk.grey(s); }`,
  });
  const { r } = scan(path.join(d, "src"));
  check("subdir scan (devDeps, no node_modules) still warns", r.stderr.includes("WARNING") && r.stderr.includes("npm install"));
}
if (blk()) {
  // κ-batch from the 0.9 dogfood on zx (source-verified): which -> Fs (PATH stat via isexe), @webpod/ps ->
  // Exec (spawns the OS ps/kill), envapi member-precise (load/config READ the .env file -> Fs; parse/
  // stringify are pure string transforms). The `parse` PURE assert is the fabrication guard — the argon2
  // lesson: model the effectful member, never blanket-grant a mixed package.
  const pkg = (name, types) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","types":"index.d.ts","main":"index.js"}`,
    [`node_modules/${name}/index.d.ts`]: types,
    [`node_modules/${name}/index.js`]: ``,
  });
  const d = project({
    ...pkg("which", `declare function which(cmd: string): Promise<string>;\nexport default which;`),
    ...pkg("@webpod/ps", `export declare function lookup(q: object): Promise<object[]>;\nexport declare function kill(pid: number): Promise<void>;`),
    ...pkg("envapi", `export declare function parse(s: string): Record<string, string>;\nexport declare function load(...f: string[]): Record<string, string>;\nexport declare function config(f?: string): void;`),
    "src/cli.ts": `import which from "which";
import { lookup, kill } from "@webpod/ps";
import { parse, load, config } from "envapi";
export function findExe(c: string) { return which(c); }
export function listProcs() { return lookup({}); }
export function killProc(p: number) { return kill(p); }
export function loadEnv(f: string) { return load(f); }
export function cfgEnv() { return config(); }
export function parseEnv(s: string) { return parse(s); }`,
  });
  const { report } = scan(d);
  check("κ: which -> Fs", entry(report, "src.cli.findExe")?.inferred.includes("Fs"));
  check("κ: @webpod/ps lookup -> Exec", entry(report, "src.cli.listProcs")?.inferred.includes("Exec"));
  check("κ: @webpod/ps kill -> Exec", entry(report, "src.cli.killProc")?.inferred.includes("Exec"));
  check("κ: envapi load -> Fs", entry(report, "src.cli.loadEnv")?.inferred.includes("Fs"));
  check("κ: envapi config -> Fs", entry(report, "src.cli.cfgEnv")?.inferred.includes("Fs"));
  check("κ: envapi parse stays PURE (fabrication guard)", entry(report, "src.cli.parseEnv") == null,
        JSON.stringify(entry(report, "src.cli.parseEnv")));
}

// ── coverage calibration: effectful npm packages the differential found disclosed-but-unmodeled ───
// Each: the effect-bearing API → its effect, AND a PURE API of the SAME package → pure (no fabrication).
if (blk()) {
  const pkg = (name, types) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","types":"index.d.ts","main":"index.js"}`,
    [`node_modules/${name}/index.d.ts`]: types,
    [`node_modules/${name}/index.js`]: ``,
  });
  // uuid: v1/v4/v6/v7 -> Rand; parse/stringify/validate -> pure (v3/v5 are deterministic hashes -> pure)
  {
    const d = project({
      ...pkg("uuid", `export declare function v4(): string;
export declare function v7(): string;
export declare function v5(name: string, ns: string): string;
export declare function parse(s: string): Uint8Array;
export declare function validate(s: string): boolean;`),
      "src/u.ts": `import { v4, v7, v5, parse, validate } from "uuid";
export function gen() { return v4() + v7(); }
export function hash() { return v5("a", "b"); }
export function pure() { return validate("x") ? parse("y") : null; }`,
    });
    const { report } = scan(d);
    check("uuid v4/v7 -> Rand", entry(report, "src.u.gen")?.inferred.includes("Rand"));
    check("uuid v5 (deterministic hash) is PURE", entry(report, "src.u.hash") == null,
          JSON.stringify(entry(report, "src.u.hash")));
    check("uuid parse/validate are PURE", entry(report, "src.u.pure") == null,
          JSON.stringify(entry(report, "src.u.pure")));
  }
  // nanoid: nanoid/customAlphabet -> Rand; urlAlphabet const -> pure
  {
    const d = project({
      ...pkg("nanoid", `export declare function nanoid(size?: number): string;
export declare function customAlphabet(alphabet: string, size?: number): () => string;
export declare const urlAlphabet: string;`),
      "src/n.ts": `import { nanoid, customAlphabet, urlAlphabet } from "nanoid";
export function id() { return nanoid(); }
export function factory() { return customAlphabet("abc", 5); }
export function constRead() { return urlAlphabet.length; }`,
    });
    const { report } = scan(d);
    check("nanoid -> Rand", entry(report, "src.n.id")?.inferred.includes("Rand"));
    check("nanoid customAlphabet -> Rand", entry(report, "src.n.factory")?.inferred.includes("Rand"));
    check("nanoid urlAlphabet const is PURE", entry(report, "src.n.constRead") == null,
          JSON.stringify(entry(report, "src.n.constRead")));
  }
  // open: default export open() + openApp() -> Exec; apps const -> pure
  {
    const d = project({
      ...pkg("open", `declare function open(target: string): Promise<unknown>;
export declare function openApp(name: string): Promise<unknown>;
export declare const apps: Record<string, string>;
export default open;`),
      "src/o.ts": `import open, { openApp, apps } from "open";
export function url() { return open("http://x"); }
export function app() { return openApp("safari"); }
export function constRead() { return Object.keys(apps).length; }`,
    });
    const { report } = scan(d);
    check("open default export -> Exec", entry(report, "src.o.url")?.inferred.includes("Exec"));
    check("open openApp -> Exec", entry(report, "src.o.app")?.inferred.includes("Exec"));
    check("open apps const is PURE", entry(report, "src.o.constRead") == null,
          JSON.stringify(entry(report, "src.o.constRead")));
  }
  // gaxios: request/get/post -> Net (the HTTP client)
  {
    const d = project({
      ...pkg("gaxios", `export declare class Gaxios { request(opts: object): Promise<unknown>; get(url: string): Promise<unknown>; }
export declare function request(opts: object): Promise<unknown>;`),
      "src/g.ts": `import { request } from "gaxios";
export function fetch() { return request({ url: "http://api" }); }`,
    });
    const { report } = scan(d);
    check("gaxios request -> Net", entry(report, "src.g.fetch")?.inferred.includes("Net"));
  }
  // stripe: the DEEP resource chain stripe.<resource>.<verb>() and the nested
  // stripe.checkout.sessions.create() -> Net; toString -> pure; new Stripe() -> pure
  {
    const d = project({
      ...pkg("stripe", `export declare class Stripe {
  constructor(key: string);
  customers: Stripe.CustomersResource;
  checkout: Stripe.CheckoutResource;
}
export declare namespace Stripe {
  interface CustomersResource { create(p: object): Promise<unknown>; toJSON(): string; }
  interface CheckoutResource { sessions: SessionsResource; }
  interface SessionsResource { create(p: object): Promise<unknown>; }
}
export default Stripe;`),
      "src/s.ts": `import Stripe from "stripe";
const stripe = new Stripe("sk");
export function cust() { return stripe.customers.create({}); }
export function sess() { return stripe.checkout.sessions.create({}); }
export function ctor() { return new Stripe("x"); }`,
    });
    const { report } = scan(d);
    check("stripe.customers.create() (deep chain) -> Net",
          entry(report, "src.s.cust")?.inferred.includes("Net"), JSON.stringify(entry(report, "src.s.cust")));
    check("stripe.checkout.sessions.create() (deeper chain) -> Net",
          entry(report, "src.s.sess")?.inferred.includes("Net"), JSON.stringify(entry(report, "src.s.sess")));
    check("new Stripe() construction is PURE (no Net fabricated)", entry(report, "src.s.ctor") == null,
          JSON.stringify(entry(report, "src.s.ctor")));
  }
  // #13 (corpus-audit): a BARE call to an HTTP-client identifier that is DEFAULT- or NAMED-imported from
  // node-fetch / got / axios / undici resolves to Net — even when the package is NOT installed (so its
  // signature doesn't resolve). `import fetch from "node-fetch"; fetch(url)` used to read Unknown
  // (callback:fetch) instead of Net, the headline effect. Also asserts the URL host is captured and NO
  // spurious Unknown lingers, and a pure sibling stays pure (no over-fire).
  {
    const d = project({
      "src/n.ts": `import fetch from "node-fetch";
import got from "got";
import axios from "axios";
import { request } from "undici";
export async function pay() { await fetch("https://api.stripe.com/charge"); }
export async function g() { await got("https://api.example.com/a"); }
export async function a() { await axios("https://api.example.com/b"); }
export async function u() { await request("https://api.example.com/c"); }
export function pure() { return 1 + 2; }`,
    });
    const { report } = scan(d);
    for (const [fn, host] of [["pay", "api.stripe.com"], ["g", "api.example.com"], ["a", "api.example.com"], ["u", "api.example.com"]]) {
      const e = entry(report, `src.n.${fn}`);
      check(`#13 ${fn}: bare HTTP-client import call -> Net`, e?.inferred.includes("Net"), JSON.stringify(e));
      check(`#13 ${fn}: no spurious Unknown`, !!e && !e.inferred.includes("Unknown"), JSON.stringify(e));
      check(`#13 ${fn}: host ${host} captured`, e?.hosts?.includes(host), JSON.stringify(e?.hosts));
    }
    check("#13 pure sibling stays pure (no over-fire)", entry(report, "src.n.pure") == null,
          JSON.stringify(entry(report, "src.n.pure")));
  }
  // review-fix (#13 over-fire): only the CLIENT CALLABLE of an HTTP package is Net. A named CLASS export
  // (`Headers`, `Response`) called bare must NOT be Net — the default import + named request fns still are.
  {
    const d = project({
      "src/h.ts": `import fetch, { Headers } from "node-fetch";
import { request } from "undici";
export async function real() { await fetch("https://api.stripe.com/x"); }
export function hdrs() { return Headers(); }
export async function req() { await request("https://api.example.com/y"); }`,
    });
    const { report } = scan(d);
    check("#13 fetch default import -> Net", entry(report, "src.h.real")?.inferred.includes("Net"));
    check("#13 undici { request } -> Net", entry(report, "src.h.req")?.inferred.includes("Net"));
    check("#13 { Headers } class export is NOT over-reported as Net",
          !(entry(report, "src.h.hdrs")?.inferred || []).includes("Net"),
          JSON.stringify(entry(report, "src.h.hdrs")));
  }
  // bullmq: queue.add / getJob -> Db (Redis); queue.on (event wiring) -> pure
  {
    const d = project({
      ...pkg("bullmq", `export declare class Queue {
  add(name: string, data: object): Promise<unknown>;
  on(ev: string, cb: () => void): this;
}`),
      "src/b.ts": `import { Queue } from "bullmq";
export function enqueue(q: Queue) { return q.add("job", {}); }
export function wire(q: Queue) { return q.on("completed", () => {}); }`,
    });
    const { report } = scan(d);
    check("bullmq queue.add -> Db", entry(report, "src.b.enqueue")?.inferred.includes("Db"));
    check("bullmq queue.on (event wiring) is PURE", entry(report, "src.b.wire") == null,
          JSON.stringify(entry(report, "src.b.wire")));
  }
  // @sentry/node: captureException/flush -> Net; init is config (pure)
  {
    const d = project({
      "node_modules/@sentry/node/package.json": `{"name":"@sentry/node","types":"index.d.ts","main":"index.js"}`,
      "node_modules/@sentry/node/index.d.ts": `export declare function captureException(e: unknown): string;
export declare function flush(t?: number): Promise<boolean>;
export declare function init(o: object): void;
export declare function setTag(k: string, v: string): void;`,
      "node_modules/@sentry/node/index.js": ``,
      "src/se.ts": `import { captureException, flush, init, setTag } from "@sentry/node";
export function report(e: Error) { return captureException(e); }
export function drain() { return flush(2000); }
export function setup() { init({}); setTag("a", "b"); }`,
    });
    const { report } = scan(d);
    check("@sentry/node captureException -> Net", entry(report, "src.se.report")?.inferred.includes("Net"));
    check("@sentry/node flush -> Net", entry(report, "src.se.drain")?.inferred.includes("Net"));
    check("@sentry/node init/setTag (config) are PURE", entry(report, "src.se.setup") == null,
          JSON.stringify(entry(report, "src.se.setup")));
  }
  // posthog-node: capture/flush -> Net; new PostHog() ctor is config (pure)
  {
    const d = project({
      ...pkg("posthog-node", `export declare class PostHog {
  constructor(key: string);
  capture(e: object): void;
  flush(): Promise<void>;
  on(ev: string, cb: () => void): void;
}`),
      "src/p.ts": `import { PostHog } from "posthog-node";
const client = new PostHog("k");
export function track() { return client.capture({ event: "x" }); }
export function drain() { return client.flush(); }
export function ctor() { return new PostHog("y"); }`,
    });
    const { report } = scan(d);
    check("posthog-node capture -> Net", entry(report, "src.p.track")?.inferred.includes("Net"));
    check("posthog-node flush -> Net", entry(report, "src.p.drain")?.inferred.includes("Net"));
    check("new PostHog() construction is PURE", entry(report, "src.p.ctor") == null,
          JSON.stringify(entry(report, "src.p.ctor")));
  }
  // nest-winston: the injected logger's level verbs -> Log
  {
    const d = project({
      "node_modules/nest-winston/package.json": `{"name":"nest-winston","types":"index.d.ts","main":"index.js"}`,
      "node_modules/nest-winston/index.d.ts": `export declare class WinstonLogger {
  log(m: string): void;
  error(m: string): void;
  setContext(c: string): void;
}`,
      "node_modules/nest-winston/index.js": ``,
      "src/w.ts": `import { WinstonLogger } from "nest-winston";
export function emit(l: WinstonLogger) { l.log("hi"); l.error("oops"); }
export function ctx(l: WinstonLogger) { l.setContext("svc"); }`,
    });
    const { report } = scan(d);
    check("nest-winston logger.log/error -> Log", entry(report, "src.w.emit")?.inferred.includes("Log"));
    check("nest-winston setContext (config) is PURE", entry(report, "src.w.ctx") == null,
          JSON.stringify(entry(report, "src.w.ctx")));
  }
}

// ── 10. @Entity decorator names feed the tables surface (the TypeORM declarative move) ──────────
if (blk()) {
  const d = project({
    "node_modules/typeorm/index.d.ts": `export declare function Entity(name?: string): ClassDecorator;
export declare class Repository<T> { find(): Promise<T[]>; save(e: T): Promise<T>; }`,
    "node_modules/typeorm/package.json": `{"name":"typeorm","types":"index.d.ts","main":"index.js"}`,
    "node_modules/typeorm/index.js": ``,
    "tsconfig.json": `{"compilerOptions":{"strict":true,"experimentalDecorators":true},"include":["src"]}`,
    "src/svc.ts": `import { Entity, Repository } from "typeorm";
@Entity("user")
export class UserEntity { name = ""; }
export class Svc {
  constructor(private repo: Repository<UserEntity>) {}
  list(): Promise<UserEntity[]> { return this.repo.find(); }
}`,
  });
  const { report } = scan(d);
  const e = entry(report, "src.svc.Svc.list");
  check("ORM call classifies Db with the decorator's table",
        e?.inferred.includes("Db") && e?.tables?.includes("user"), JSON.stringify(e));
}

// ── ⟨0.13⟩ Llm: model-host refinement + model-SDK surface + the deny/allow gate (SPEC §1) ───────────
if (blk()) {
  // (a) HOST-LITERAL refinement: a known model host → Net + Llm; an unknown host stays bare Net.
  const d = project({
    "src/m.ts": `export async function ask() { return fetch("https://api.anthropic.com/v1/messages", { method: "POST" }); }
export async function weather() { return fetch("https://api.weather.gov/points/1,2"); }
export async function ollama() { return fetch("http://localhost:11434/api/generate"); }
export async function bedrock() { return fetch("https://bedrock-runtime.us-east-1.amazonaws.com/x"); }`,
  });
  const { report } = scan(d);
  const ask = entry(report, "src.m.ask");
  check("Llm host-literal: fetch to a model host classifies { Net, Llm }",
        ask?.inferred.includes("Net") && ask?.inferred.includes("Llm") && ask?.hosts?.includes("api.anthropic.com"),
        JSON.stringify(ask));
  check("Llm host-literal: an UNKNOWN host stays bare Net (never guessed)",
        entry(report, "src.m.weather")?.inferred.includes("Net")
        && !entry(report, "src.m.weather")?.inferred.includes("Llm"),
        JSON.stringify(entry(report, "src.m.weather")));
  check("Llm host-literal: Ollama :11434 refines to Llm",
        entry(report, "src.m.ollama")?.inferred.includes("Llm"), JSON.stringify(entry(report, "src.m.ollama")));
  check("Llm host-literal: AWS Bedrock runtime refines to Llm",
        entry(report, "src.m.bedrock")?.inferred.includes("Llm"), JSON.stringify(entry(report, "src.m.bedrock")));
  // FINDING 9: a dotless local Ollama endpoint refines to Llm but the host is NOT captured as a Net
  // allowlist literal (java parity #2 — preserve the host gate). `localhost:11434` must NOT appear in hosts.
  check("FINDING 9: Ollama localhost:11434 → Llm but host is NOT captured in the allowlist surface",
        entry(report, "src.m.ollama")?.inferred.includes("Llm")
        && !(entry(report, "src.m.ollama")?.hosts ?? []).some((h) => h.includes("11434") || h === "localhost"),
        JSON.stringify(entry(report, "src.m.ollama")));

  // ── FINDINGS 1/6/7 — a host predicate runs against the EXTRACTED URL arg, never a raw literal ──────
  {
    const pkg = (name, types) => ({
      [`node_modules/${name}/package.json`]: `{"name":"${name}","types":"index.d.ts","main":"index.js"}`,
      [`node_modules/${name}/index.d.ts`]: types,
      [`node_modules/${name}/index.js`]: ``,
    });
    // FINDING 1: the :11434 gate must run against a PARSED host, not a raw literal that merely contains
    // ":11434". A relative path `axios.post("/v1/models:11434/generate")` parses to no host → NO Llm.
    // FINDING 6: `fetch(runtimeUrl, "literal")` — the trailing literal (options/headers) is NOT the host.
    // FINDING 7: `fetch(new URL(...))` is a STRUCTURED arg — it must NOT fail the surface closed.
    // (`incomplete` is an INTERNAL surface, not a report field, so masking is asserted through the GATE.)
    const fd = project({
      ...pkg("axios", `declare const axios: { post(url: string, body?: unknown): Promise<unknown>; get(url: string): Promise<unknown>; };\nexport default axios;`),
      "src/f.ts": `import axios from "axios";
export function relPath(): Promise<unknown> { return axios.post("/v1/models:11434/generate", {}); }
export async function wrongArg(u: string) { return fetch(u, { headers: { host: "api.anthropic.com" } }); }
export async function structured() { const u = new URL("https://api.example.com/x"); return fetch(u).then(() => fetch("https://api.example.com/y")); }
export async function realModel() { return fetch("https://api.anthropic.com/v1/messages"); }`,
    });
    const fr = scan(fd).report;
    const rel = entry(fr, "src.f.relPath");
    check("FINDING 1: axios.post to a relative path containing ':11434' does NOT fabricate Llm",
          rel?.inferred.includes("Net") && !rel?.inferred.includes("Llm")
          && !(rel?.hosts ?? []).some((h) => h.includes("11434")),
          JSON.stringify(rel));
    const wrong = entry(fr, "src.f.wrongArg");
    check("FINDING 6: fetch(runtimeUrl, {host literal}) does NOT read the trailing literal as the host",
          wrong?.inferred.includes("Net") && !(wrong?.hosts ?? []).includes("api.anthropic.com")
          && !wrong?.inferred.includes("Llm"),
          JSON.stringify(wrong));
    const real = entry(fr, "src.f.realModel");
    check("FINDINGS intact: fetch to a real model host still → { Net, Llm, host captured }",
          real?.inferred.includes("Net") && real?.inferred.includes("Llm")
          && (real?.hosts ?? []).includes("api.anthropic.com"),
          JSON.stringify(real));
    // FINDING 6 (masking preserved): the RUNTIME-STRING url `fetch(u, …)` masks the host → an `allow Net`
    // on that host must FAIL CLOSED (AS-EFF-008), exactly like the other runtime-host masking cases.
    fs.writeFileSync(path.join(fd, "allow-wrong"), "allow Net in src.f.wrongArg api.anthropic.com\n");
    const gw = scan(fd, "--policy", path.join(fd, "allow-wrong")).r;
    check("FINDING 6: the runtime-string-URL fetch fails the Net surface closed (masking preserved, AS-EFF-008)",
          gw.status === 1 && gw.stdout.includes("[AS-EFF-008]") && gw.stdout.includes("src.f.wrongArg"),
          `status=${gw.status} ${gw.stdout.slice(0, 200)}`);
    // FINDING 7 (no fail-closed regression): `structured` reaches a VISIBLE literal host (api.example.com)
    // AND a STRUCTURED `fetch(new URL(u))`. The structured arg did NOT mask a literal — pre-fix it wrongly
    // marked the surface incomplete, so `allow Net api.example.com` failed closed even though the only real
    // host IS allowlisted. Post-fix the structured arg is clean → the gate CERTIFIES it (exit 0, no AS-EFF-008).
    fs.writeFileSync(path.join(fd, "allow-struct"), "allow Net in src.f.structured api.example.com\n");
    const gs = scan(fd, "--policy", path.join(fd, "allow-struct")).r;
    check("FINDING 7: fetch(new URL(...)) alongside a visible host is NOT fail-closed — gate certifies clean (exit 0)",
          gs.status === 0 && !gs.stdout.includes("src.f.structured"),
          `status=${gs.status} ${gs.stdout.slice(0, 200)}`);
  }

  // ── CONST-STRING PROPAGATION (java constant-inlining parity) — a host anchored by a `const NAME =
  //    "literal"` string resolves through the SAME host-extraction path, so Llm/Db/Net-host all benefit ──
  {
    const cd = project({
      "src/c.ts": `const API_BASE = "https://api.openai.com/v1";
export async function callTmpl(){ return fetch(\`\${API_BASE}/chat/completions\`); }
export async function callBare(){ return fetch(API_BASE); }
export async function callConcat(){ return fetch(API_BASE + "/completions"); }
export async function inlineControl(){ return fetch("https://api.openai.com/v1/chat"); }`,
    });
    const cr = scan(cd).report;
    for (const fn of ["callTmpl", "callBare", "callConcat", "inlineControl"]) {
      const e = entry(cr, `src.c.${fn}`);
      check(`const-host: fetch anchored by a const model host → { Net, Llm, host } (${fn})`,
            e?.inferred.includes("Net") && e?.inferred.includes("Llm")
            && (e?.hosts ?? []).includes("api.openai.com"),
            JSON.stringify(e));
    }

    // FABRICATION GUARDS — a const/template/concat that is NOT a model host, or whose head is NOT a
    // readable `const` string literal, MUST stay bare Net and NEVER fabricate Llm (nor a host guess).
    const gd = project({
      "src/g.ts": `const CDN = "https://cdn.example.com";
export async function cdnTmpl(){ return fetch(\`\${CDN}/asset.js\`); }
export async function cdnBare(){ return fetch(CDN); }
export async function cdnConcat(){ return fetch(CDN + "/x"); }
declare function getConfig(): string;
const runtimeHost = getConfig();
export async function runtimeVal(){ return fetch(\`\${runtimeHost}/chat\`); }
const seg = "chat";
export async function literalPrefix(){ return fetch(\`https://api.openai.com/\${seg}\`); }
let mutable = "https://api.openai.com";
export async function splitAuthority(){ return fetch(\`https://\${seg}/chat\`); }
mutable = "https://elsewhere.example.com";
export async function letVar(){ return fetch(\`\${mutable}/chat\`); }
export async function nonConstHead(){ return fetch(\`\${getConfig()}/chat\`); }`,
    });
    const gr = scan(gd).report;
    // the CDN const is a real, statically-known host → captured as a PLAIN Net host, but NEVER Llm.
    for (const fn of ["cdnTmpl", "cdnBare", "cdnConcat"]) {
      const e = entry(gr, `src.g.${fn}`);
      check(`const-host fabrication guard: a non-model const host stays { Net } only, host captured but NOT Llm (${fn})`,
            e?.inferred.includes("Net") && !e?.inferred.includes("Llm")
            && (e?.hosts ?? []).includes("cdn.example.com"),
            JSON.stringify(e));
    }
    // a runtime value / reassignable `let` / non-const interpolation head are all UNRESOLVABLE at the head
    // → bare Net, no host, no Llm. This is the "NEVER guess" boundary. `splitAuthority` (`https://${seg}/`)
    // interpolates INSIDE the authority, so the literal head never completes a host → also bare Net.
    for (const fn of ["runtimeVal", "letVar", "nonConstHead", "splitAuthority"]) {
      const e = entry(gr, `src.g.${fn}`);
      check(`const-host fabrication guard: an unresolvable host stays bare Net (no Llm, no host guess) (${fn})`,
            e?.inferred.includes("Net") && !e?.inferred.includes("Llm")
            && !(e?.hosts ?? []).some((h) => h.includes("openai") || h.includes("elsewhere")),
            JSON.stringify(e));
    }
    // `literalPrefix` (`\`https://api.openai.com/\${seg}\``) — the literal HEAD already completes the
    // authority (a `/` after `://` within the literal), so the host is statically known: LITERAL-HEAD
    // extraction refines it to Llm + Net + host, exactly like an inline literal. (Was formerly a bare-Net
    // under-report; this is the gap closed.)
    {
      const e = entry(gr, "src.g.literalPrefix");
      check("literal-head: `https://api.openai.com/${seg}` — host in the literal head → { Net, Llm, host }",
            e?.inferred.includes("Net") && e?.inferred.includes("Llm")
            && (e?.hosts ?? []).includes("api.openai.com"),
            JSON.stringify(e));
    }
    // the gate must still fire `deny Llm` on the const-anchored model call (the resolution is real, not
    // cosmetic — it reaches the verdict).
    fs.writeFileSync(path.join(cd, "deny-const"), "deny Llm src.c.callTmpl\n");
    const cg = scan(cd, "--policy", path.join(cd, "deny-const")).r;
    check("const-host: deny Llm gates the const-anchored model call (exit 1, AS-EFF-006 names Llm)",
          cg.status === 1 && cg.stdout.includes("[AS-EFF-006]") && cg.stdout.includes("src.c.callTmpl") && cg.stdout.includes("Llm"),
          `status=${cg.status} ${cg.stdout.slice(0, 200)}`);
  }

  // ── LITERAL-HEAD HOST EXTRACTION (the most common real-world URL shape: host in the literal head, the
  //    interpolation only in the PATH). A template `\`scheme://authority/${path}\`` or concat
  //    `"scheme://authority/" + path` whose literal HEAD terminates the authority with a `/` after `://`
  //    carries a statically-known host → refine like an inline literal. When the interpolation is or could
  //    be WITHIN the authority (split host, whole host, dotless label, interpolated port), the head does NOT
  //    complete the authority → stays bare Net (safe under-report, never a host/Llm guess). ──
  {
    const ld = project({
      "src/lh.ts": `export async function tmplPath(p: string){ return fetch(\`https://api.openai.com/v1/\${p}\`); }
export async function tmplRootPath(p: string){ return fetch(\`https://api.openai.com/\${p}\`); }
export async function concatPath(p: string){ return fetch("https://api.openai.com/v1/" + p); }
export async function splitAuthority(x: string){ return fetch(\`https://api.\${x}.com/v1/y\`); }
export async function wholeHost(h: string){ return fetch(\`https://\${h}/v1/y\`); }
export async function dotlessLabel(x: string){ return fetch(\`https://api.openai\${x}/v1\`); }
export async function interpPort(port: string){ return fetch(\`https://api.openai.com:\${port}/v1\`); }
export async function cdnGuard(p: string){ return fetch(\`https://cdn.example.com/v1/\${p}\`); }`,
    });
    const lr = scan(ld).report;
    // POSITIVE — the literal head completes the authority `api.openai.com` (a model host) → Net + Llm + host.
    for (const fn of ["tmplPath", "tmplRootPath", "concatPath"]) {
      const e = entry(lr, `src.lh.${fn}`);
      check(`literal-head POSITIVE: model host in the literal head → { Net, Llm, host } (${fn})`,
            e?.inferred.includes("Net") && e?.inferred.includes("Llm")
            && (e?.hosts ?? []).includes("api.openai.com"),
            JSON.stringify(e));
    }
    // NEGATIVE — the interpolation is or could be inside the authority → bare Net, NO host, NO Llm.
    for (const fn of ["splitAuthority", "wholeHost", "dotlessLabel", "interpPort"]) {
      const e = entry(lr, `src.lh.${fn}`);
      check(`literal-head NEGATIVE: interpolation in the authority stays bare Net (no host, no Llm) (${fn})`,
            e?.inferred.includes("Net") && !e?.inferred.includes("Llm")
            && (e?.hosts ?? []).length === 0,
            JSON.stringify(e));
    }
    // FABRICATION GUARD — a non-model literal-head host (`cdn.example.com`) is captured as a PLAIN Net host
    // but MUST NOT become Llm.
    {
      const e = entry(lr, "src.lh.cdnGuard");
      check("literal-head FABRICATION GUARD: a non-model literal-head host → { Net, host } but NOT Llm",
            e?.inferred.includes("Net") && !e?.inferred.includes("Llm")
            && (e?.hosts ?? []).includes("cdn.example.com"),
            JSON.stringify(e));
    }
  }

  // (b) MODEL-SDK surface: an `import OpenAI from "openai"` client call → Llm + Net (stubbed like the
  //     κ-coverage tests — no real package needed; the SDK is recognized by its module NAME via κ).
  const stub = (name, member) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","version":"0.0.0","main":"index.js","types":"index.d.ts"}`,
    [`node_modules/${name}/index.d.ts`]: `declare class OpenAI { chat: { completions: { create(o: object): Promise<string> } }; ${member}(s: string): Promise<string>; }
export default OpenAI;`,
    [`node_modules/${name}/index.js`]: `module.exports = class OpenAI { async ${member}(s) { return s; } };`,
  });
  const sd = project({
    ...stub("openai", "invoke"),
    "src/s.ts": `import OpenAI from "openai";
const client = new OpenAI();
export async function complete() { return client.invoke("hello"); }`,
  });
  const sdkReport = scan(sd).report;
  const comp = entry(sdkReport, "src.s.complete");
  check("Llm model-SDK: a call into the `openai` client classifies { Net, Llm } (no method gating)",
        comp?.inferred.includes("Llm") && comp?.inferred.includes("Net"), JSON.stringify(comp));
  check("Llm model-SDK: the SDK is κ-covered — NOT a blind spot in the ledger",
        !/classifier doesn't cover/.test(scan(sd).r.stderr) || !/openai/.test(scan(sd).r.stderr),
        scan(sd).r.stderr.slice(0, 160));

  // (c) the gate: `deny Llm` fires on a model-reaching fn (exit 1, AS-EFF names Llm).
  fs.writeFileSync(path.join(d, "deny"), "deny Llm src.m.ask\n");
  const dg = scan(d, "--policy", path.join(d, "deny")).r;
  check("deny Llm gates a model-reaching fn (exit 1, AS-EFF-006 names Llm)",
        dg.status === 1 && dg.stdout.includes("[AS-EFF-006]") && dg.stdout.includes("src.m.ask") && dg.stdout.includes("Llm"),
        `status=${dg.status} ${dg.stdout.slice(0, 200)}`);

  // (d) allow Llm certifies a sanctioned model host, flags an un-sanctioned one.
  fs.writeFileSync(path.join(d, "allow"), "allow Llm in src.m.ask api.anthropic.com\nallow Llm in src.m.bedrock api.anthropic.com\n");
  const ag = scan(d, "--policy", path.join(d, "allow")).r;
  check("allow Llm certifies the sanctioned host, flags the un-sanctioned one (AS-EFF-008)",
        ag.status === 1 && ag.stdout.includes("[AS-EFF-008]") && ag.stdout.includes("src.m.bedrock")
        && !ag.stdout.includes("src.m.ask"), `status=${ag.status} ${ag.stdout.slice(0, 240)}`);
}

// ── ⟨0.13⟩ Llm: a MASKED host on a model-reaching fn fails the allow-Llm surface closed (parity #3) ─
if (blk()) {
  // The fn reaches a KNOWN model host (Llm is inferred) AND a runtime host (masks the Net surface). A
  // benign visible model literal must NOT certify `allow Llm` — the incomplete Net surface fails it
  // closed, exactly as java's incompleteAsLlm re-keys a Net-incomplete surface onto Llm (parity #3).
  const d = project({
    "src/m.ts": `export async function pick(runtimeUrl: string) {
  await fetch("https://api.anthropic.com/v1/messages");   // visible model host → Llm inferred
  return fetch(runtimeUrl);                                // runtime host → Net surface incomplete
}`,
  });
  fs.writeFileSync(path.join(d, "allow"), "allow Llm in src.m.pick api.anthropic.com\n");
  const g = scan(d, "--policy", path.join(d, "allow")).r;
  check("masked model host: a Net-incomplete surface fails `allow Llm` closed (AS-EFF-008, parity #3)",
        g.status === 1 && g.stdout.includes("[AS-EFF-008]") && g.stdout.includes("src.m.pick"),
        `status=${g.status} ${g.stdout.slice(0, 200)}`);
}

// ── 11. cross-package inheritance (CANDOR_DEPS, spec §2 hash) ─────────────────────────────────────
if (blk()) {
  // the DEPENDENCY, scanned from source — its report carries hashes (pkg#LocalName)
  const dep = project({
    "package.json": `{"name": "billing-lib"}`,
    "src/pay.ts": `import * as netm from "node:net";
export function charge(amount: number): void { netm.connect(443, "api.stripe.com"); }`,
  });
  const depScan = scan(dep);
  check("producer emits the spec §2 hash",
        entry(depScan.report, "src.pay.charge")?.hash === "billing-lib#charge",
        JSON.stringify(entry(depScan.report, "src.pay.charge")));

  // the CONSUMER: imports billing-lib via node_modules (a d.ts — the dependency's source is not here)
  const app = project({
    "package.json": `{"name": "shop", "dependencies": {"billing-lib": "1.0.0"}}`,
    "node_modules/billing-lib/package.json": `{"name":"billing-lib","types":"index.d.ts","main":"index.js"}`,
    "node_modules/billing-lib/index.d.ts": `export declare function charge(amount: number): void;`,
    "node_modules/billing-lib/index.js": ``,
    "src/checkout.ts": `import { charge } from "billing-lib";
export function buy(): void { charge(100); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8" });
  const rep1 = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const buy1 = entry(rep1, "src.checkout.buy");
  // Without CANDOR_DEPS billing-lib's effects are invisible — but now DISCLOSED per-fn (not silently pure):
  // the fn is kept with `invisible:["billing-lib"]` and an empty `inferred` (a LOWER bound), not omitted.
  check("without CANDOR_DEPS the cross-package call is DISCLOSED as invisible (not silently pure)",
        buy1 != null && buy1.inferred.length === 0 && buy1.invisible?.includes("billing-lib"),
        JSON.stringify(rep1.functions));
  spawnSync("node", [path.join(HERE, "scan.mjs"), app],
                       { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(dep, ".candor", "report.json") } });
  const rep2 = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const buy = entry(rep2, "src.checkout.buy");
  check("with CANDOR_DEPS the consumer inherits the dep's effects + hosts",
        buy?.inferred.includes("Net") && buy?.hosts?.includes("api.stripe.com"), JSON.stringify(buy));

  // version trust (§2.1): a report from a different engine version downgrades to Unknown
  const stale = JSON.parse(fs.readFileSync(path.join(dep, ".candor", "report.json"), "utf8"));
  stale.candor.version = "candor-ts-0.0.0-other";
  const stalePath = path.join(dep, "stale.json");
  fs.writeFileSync(stalePath, JSON.stringify(stale));
  spawnSync("node", [path.join(HERE, "scan.mjs"), app],
            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: stalePath } });
  const rep3 = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const buy3 = entry(rep3, "src.checkout.buy");
  check("a different-version dep report downgrades to Unknown (never silently trusted)",
        buy3?.inferred.includes("Unknown") && !buy3?.inferred.includes("Net"), JSON.stringify(buy3));

  // a RELATIVE `deps` value in .candor/config resolves against the CONFIG's repo, not the process cwd
  // (the family rule; the scan below runs from this repo's cwd, where "deps/billing.json" is nothing)
  fs.mkdirSync(path.join(app, "deps"), { recursive: true });
  fs.copyFileSync(path.join(dep, ".candor", "report.json"), path.join(app, "deps", "billing.json"));
  fs.mkdirSync(path.join(app, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(app, ".candor", "config"), "deps deps/billing.json\n");
  spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8" });
  const rep4 = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const buy4 = entry(rep4, "src.checkout.buy");
  check("config `deps` with a RELATIVE path anchors to the config's repo (cross-package effects inherit)",
        buy4?.inferred.includes("Net") && buy4?.hosts?.includes("api.stripe.com"), JSON.stringify(buy4));
}

// ── 11d. the TRUST-MARKER INVARIANT holds over every entry every scan writes ──────────────────────
// `e66f29e` shipped a union entry carrying `inferred:['Unknown']` with `unresolved` absent — a TIER-1
// marker reading FALSE on an entry that was not resolved, live on all seven of rxjs's unions. Two
// independent producers derive that marker. This asserts the property rather than re-checking the two.
if (blk()) {
  const d = project({
    "package.json": `{"name":"markers"}`,
    "src/a.ts": `import * as netm from "node:net";
export function reflectish(k: string): void { eval(k); }
export function netty(): void { netm.connect(443, "sentry.io"); }
export function inherits(k: string): void { reflectish(k); }
export interface Store { save(p: string): void; }
export class FileStore implements Store { save(p: string): void { eval(p); } }
export class MemStore implements Store { save(p: string): void { netm.connect(443, "x.example.com"); } }`,
  });
  for (const [label, extra] of [["plain", []], ["producer (union entries)", []]]) {
    const env = label === "plain" ? { ...process.env } : { ...process.env, CANDOR_WORKSPACE_CHAIN: "1" };
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...extra], { encoding: "utf8", env });
    const rep = JSON.parse(fs.readFileSync(path.join(d, ".candor", "report.json"), "utf8"));
    const bad = rep.functions.filter((e) =>
      ((e.inferred ?? []).includes("Unknown") && e.unresolved !== true)
      || (Array.isArray(e.direct) && e.direct.includes("Unknown") && !(e.unknownWhy ?? []).length));
    check(`every entry's trust markers agree with its effect set — ${label}`,
          r.status === 0 && bad.length === 0, JSON.stringify(bad));
  }
  // …and the check FAILS CLOSED rather than writing a report that lies. Injected through the one channel a
  // test has: a report is written only after the check, so a violated invariant means NO report and exit 2.
  const probe = project({
    "package.json": `{"name":"probe"}`,
    "src/a.ts": `export function f(k: string): void { eval(k); }`,
  });
  // The mutant engine lives in its OWN dir (siblings copied, node_modules symlinked) and never inside the
  // scanned project — a scratch copy of the engine left in a scanned tree shows up as extra units, which
  // has cost this vein a false A/B datapoint before.
  const eng = scratch("candor-ts-mutant-");
  for (const m of ["policy.mjs", "query-core.mjs", "contract.mjs", "scan-core.mjs", "surface.mjs", "package.json"])
    fs.copyFileSync(path.join(HERE, m), path.join(eng, m));
  try { fs.symlinkSync(path.join(HERE, "node_modules"), path.join(eng, "node_modules"), "dir"); } catch { /* exists */ }
  const mutant = path.join(eng, "scan.mjs");
  fs.writeFileSync(mutant, fs.readFileSync(path.join(HERE, "scan.mjs"), "utf8")
    .replace("    unresolved: inf.includes(\"Unknown\"),", "    unresolved: false,"));
  const r2 = spawnSync("node", [mutant, probe, "--out", path.join(probe, "m")], { encoding: "utf8" });
  check("a producer that gets the marker wrong writes NO report and exits 2",
        r2.status === 2 && /INTERNAL INVARIANT VIOLATED/.test(r2.stderr)
        && !fs.existsSync(path.join(probe, "m.json")), `status=${r2.status} ${r2.stderr.slice(0, 300)}`);
}

// ── 11c. ⟨0.19⟩ the reason class survives a dep unit that only INHERITED its Unknown ──────────────
// ⟨0.6⟩ makes `unknownWhy` DIRECT-ONLY, so a dependency's exported function publishes `Unknown` with no
// reason whenever the unresolvable call is one hop further in. The consumer then falls back to
// `unresolved`, and `deny Unknown[reflect]` reads green one package boundary along.
if (blk()) {
  const pol = (dir, body) => { const p = path.join(dir, "p.policy"); fs.writeFileSync(p, body); return p; };
  // pkgc: the Unknown ORIGIN is a LOCAL callee; the EXPORT a consumer joins only inherits it.
  const c = project({
    "package.json": `{"name":"pkgc"}`,
    "src/c.ts": `import * as netm from "node:net";
function origin(k: string): void { netm.connect(443, "api.example.com"); eval(k); }
export function reach(k: string): void { origin(k); }`,
  });
  const cRep = scan(c).report;
  check("producer: the exported unit inherits Unknown and — per ⟨0.6⟩ — publishes NO reason",
        cRep.functions.find((e) => e.hash === "pkgc#reach")?.inferred.includes("Unknown")
        && !(cRep.functions.find((e) => e.hash === "pkgc#reach")?.unknownWhy ?? []).length,
        JSON.stringify(cRep.functions.map((e) => [e.hash, e.unknownWhy])));
  // THE SECOND FIXTURE, WRITTEN FIRST (item 0): a unit that HAS its own reason must keep exactly that and
  // must NOT be widened with its callees'. The report's `unknownWhy` is direct-only by contract at both
  // ends; this recovery is for units that have NONE, not a licence to accumulate over the graph.
  check("a unit with its OWN reason is not widened by its callees'",
        JSON.stringify(cRep.functions.find((e) => e.hash === "pkgc#origin")?.unknownWhy) === '["reflect:eval"]',
        JSON.stringify(cRep.functions.find((e) => e.hash === "pkgc#origin")));
  const mkMid = (name, dts) => project({
    "package.json": `{"name":"${name}","dependencies":{"pkgc":"1.0.0"}}`,
    "node_modules/pkgc/package.json": `{"name":"pkgc","types":"index.d.ts","main":"index.js"}`,
    "node_modules/pkgc/index.d.ts": dts,
    "node_modules/pkgc/index.js": ``,
    "src/b.ts": `import { reach } from "pkgc";
export function middle(k: string): void { reach(k); }`,
  });
  const b = mkMid("pkgb", `export declare function reach(k: string): void;`);
  const cDeps = path.join(c, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), b], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: cDeps } });
  const bRep = JSON.parse(fs.readFileSync(path.join(b, ".candor", "report.json"), "utf8"));
  check("ONE hop: the consumer recovers the dep's inherited reason CLASS (not `unresolved`)",
        bRep.functions.find((e) => e.hash === "pkgb#middle")?.unknownWhy?.includes("reflect:eval"),
        JSON.stringify(bRep.functions.map((e) => [e.hash, e.unknownWhy])));
  // TWO hops: pkga -> pkgb -> pkgc. pkgb's own entry now carries the reason, so the second hop is the
  // ordinary `4dad22d` copy — but only because the first hop stopped losing it.
  const a = project({
    "package.json": `{"name":"pkga","dependencies":{"pkgb":"1.0.0"}}`,
    "node_modules/pkgb/package.json": `{"name":"pkgb","types":"index.d.ts","main":"index.js"}`,
    "node_modules/pkgb/index.d.ts": `export declare function middle(k: string): void;`,
    "node_modules/pkgb/index.js": ``,
    "src/a.ts": `import { middle } from "pkgb";
export function top(k: string): void { middle(k); }`,
  });
  const bDeps = path.join(b, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), a], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: bDeps } });
  const aRep = JSON.parse(fs.readFileSync(path.join(a, ".candor", "report.json"), "utf8"));
  check("TWO hops: the reason class still arrives",
        aRep.functions.find((e) => e.hash === "pkga#top")?.unknownWhy?.includes("reflect:eval"),
        JSON.stringify(aRep.functions.map((e) => [e.hash, e.unknownWhy])));

  // THE SINGLE-TREE CONTROL, and the gate in BOTH directions. `deny Unknown[native]` is the negative
  // control that proves the rule discriminates; `deny Unknown[unresolved]` is the DEGRADATION mirror —
  // before the fix it was 0 single-tree and 1 chained, i.e. the catch-all fired where the precise rule
  // could not. Both must now agree with the control.
  const ctl = project({
    "package.json": `{"name":"pkga"}`,
    "src/c.ts": `import * as netm from "node:net";
function origin(k: string): void { netm.connect(443, "api.example.com"); eval(k); }
export function reach(k: string): void { origin(k); }`,
    "src/b.ts": `import { reach } from "./c";
export function middle(k: string): void { reach(k); }`,
    "src/a.ts": `import { middle } from "./b";
export function top(k: string): void { middle(k); }`,
  });
  for (const [rule, want] of [["deny Unknown[reflect]", 1], ["deny Unknown[native]", 0], ["deny Unknown[unresolved]", 0]]) {
    const one = spawnSync("node", [path.join(HERE, "scan.mjs"), ctl, "--policy", pol(ctl, rule + "\n")], { encoding: "utf8" });
    const hop1 = spawnSync("node", [path.join(HERE, "scan.mjs"), b, "--policy", pol(b, rule + "\n")],
                           { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: cDeps } });
    const hop2 = spawnSync("node", [path.join(HERE, "scan.mjs"), a, "--policy", pol(a, rule + "\n")],
                           { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: bDeps } });
    check(`\`${rule}\`: chained agrees with the single-tree control at one hop AND two`,
          one.status === want && hop1.status === want && hop2.status === want,
          `control=${one.status} hop1=${hop1.status} hop2=${hop2.status} want=${want}`);
  }

  // THE FIXTURE ITEM 0 DEMANDED, and it caught a live under-carry. The first version of this recovery ran
  // only for dep entries with NO reason of their own — and the fixture above, whose export inherits its
  // Unknown and has no direct reason, was structurally incapable of noticing a unit that has one AND
  // reaches a SECOND class through its calls. `both` sources `reflect:eval` itself and calls a `callback:`
  // unit; with the restriction it carried only `reflect:`, and `deny Unknown[indirect]` was exit 1
  // single-tree and exit 0 chained — this commit's own defect, one shape narrower.
  const c2 = project({
    "package.json": `{"name":"pkgc2"}`,
    "src/c.ts": `import * as netm from "node:net";
function deep(k: string): void { netm.connect(443, "api.example.com"); (process as any).binding(k); }
export function both(k: string): void { eval(k); deep(k); }`,
  });
  scan(c2);
  const b3 = project({
    "package.json": `{"name":"pkgb3","dependencies":{"pkgc2":"1.0.0"}}`,
    "node_modules/pkgc2/package.json": `{"name":"pkgc2","types":"index.d.ts","main":"index.js"}`,
    "node_modules/pkgc2/index.d.ts": `export declare function both(k: string): void;`,
    "node_modules/pkgc2/index.js": ``,
    "src/b.ts": `import { both } from "pkgc2";
export function middle(k: string): void { both(k); }`,
  });
  const ctl2 = project({
    "package.json": `{"name":"pkgb3"}`,
    "src/c.ts": `import * as netm from "node:net";
function deep(k: string): void { netm.connect(443, "api.example.com"); (process as any).binding(k); }
export function both(k: string): void { eval(k); deep(k); }`,
    "src/b.ts": `import { both } from "./c";
export function middle(k: string): void { both(k); }`,
  });
  const c2Deps = path.join(c2, ".candor", "report.json");
  for (const [rule, want] of [["deny Unknown[indirect]", 1], ["deny Unknown[reflect]", 1],
                              ["deny Unknown[native]", 0], ["deny Unknown[dispatch]", 0]]) {
    const one = spawnSync("node", [path.join(HERE, "scan.mjs"), ctl2, "--policy", pol(ctl2, rule + "\n")], { encoding: "utf8" });
    const two = spawnSync("node", [path.join(HERE, "scan.mjs"), b3, "--policy", pol(b3, rule + "\n")],
                          { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: c2Deps } });
    check(`a dep unit with its OWN reason still carries the classes it REACHES — \`${rule}\``,
          one.status === want && two.status === want, `control=${one.status} chained=${two.status} want=${want}`);
  }

  // NO CROSS-REPORT CONTAMINATION. The resolver keys on `fn` quals, which are report-LOCAL and collide
  // freely between packages — leaf-key joining ACROSS reports is the fabrication this vein exists to avoid.
  // `otherpkg` declares the same qual `src.c.origin` with a NATIVE reason and nothing must pick it up.
  const other = project({
    "package.json": `{"name":"otherpkg"}`,
    "src/c.ts": `export function origin(k: string): void { (process as any).binding(k); }`,
  });
  const otherRep = scan(other).report;
  // The string to look for is READ OUT OF the other report rather than written here by hand. A literal
  // guess is how this assertion was vacuous on its first pass — it asserted the absence of a `native:`
  // prefix while the reason `otherpkg` actually emits is `callback:`, so the mutant that merges every
  // report into one graph passed it. A test that cannot name what it reads proves nothing.
  const foreignWhy = otherRep.functions.find((e) => e.fn === "src.c.origin")?.unknownWhy?.[0];
  check("control: the other package declares the SAME qual with a DIFFERENT reason",
        !!foreignWhy && foreignWhy !== "reflect:eval", JSON.stringify(otherRep.functions.map((e) => [e.fn, e.unknownWhy])));
  // The FOREIGN report is chained FIRST, deliberately: the resolution is computed and applied per report as
  // each is read, so a globally-scoped resolver only contaminates a report loaded AFTER the colliding one.
  // Chaining pkgc first hides the hazard behind load order, which is exactly the kind of accident that makes
  // a guard look verified when it is not.
  const bothDeps = `${path.join(other, ".candor", "report.json")}:${cDeps}`;
  const b2 = mkMid("pkgb2", `export declare function reach(k: string): void;`);
  spawnSync("node", [path.join(HERE, "scan.mjs"), b2], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: bothDeps } });
  const b2mid = JSON.parse(fs.readFileSync(path.join(b2, ".candor", "report.json"), "utf8"))
    .functions.find((e) => e.hash === "pkgb2#middle");
  check("a same-named qual in ANOTHER report contributes no reason (per-report, never leaf-keyed)",
        b2mid?.unknownWhy?.includes("reflect:eval") && !(b2mid?.unknownWhy ?? []).includes(foreignWhy),
        JSON.stringify(b2mid) + " foreign=" + foreignWhy);

  // The FALLBACK survives: an inherited Unknown with nothing recoverable still reads `unresolved` rather
  // than losing its reason field altogether.
  const bare = project({
    "package.json": `{"name":"barepkg"}`,
    "src/x.ts": `export declare function opaque(): void;
export function wrap(): void { (opaque as any)(); }`,
  });
  scan(bare);
  const bareCons = project({
    "package.json": `{"name":"bareapp","dependencies":{"barepkg":"1.0.0"}}`,
    "node_modules/barepkg/package.json": `{"name":"barepkg","types":"index.d.ts","main":"index.js"}`,
    "node_modules/barepkg/index.d.ts": `export declare function wrap(): void;`,
    "node_modules/barepkg/index.js": ``,
    "src/m.ts": `import { wrap } from "barepkg";\nexport function go(): void { wrap(); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), bareCons], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(bare, ".candor", "report.json") } });
  const goBare = entry(JSON.parse(fs.readFileSync(path.join(bareCons, ".candor", "report.json"), "utf8")), "src.m.go");
  check("an inherited Unknown with nothing recoverable still carries a reason field",
        goBare == null || !goBare.inferred.includes("Unknown") || (goBare.unknownWhy ?? []).length > 0,
        JSON.stringify(goBare));

  // ⟨0.24⟩ SPEC §6.2's CONTRIBUTES clause — and the reason it is a NO-OP for this engine, pinned so it
  // stays one. The clause says a reasonless `Unknown` must CONTRIBUTE `unresolved` rather than default to
  // it when the class set comes out EMPTY (absence is not upward-closed: acquiring a second, classifiable
  // reason REMOVED the default, so a caller of one reasonless dep was rejected while a caller of that dep
  // AND a reasoned one — strictly worse-known — passed). It also says the right place to satisfy that is
  // where the Unknown is CREATED, so the ill-formed state is never constructed at all. candor-ts is
  // already there, twice over: the emitter writes `unknownWhy: ["unresolved"]` on ANY direct Unknown it
  // could not name, and the trust-marker self-check above it REFUSES TO WRITE A REPORT that carries one
  // (`direct carries Unknown but unknownWhy is empty`) — the state is not merely unwritten, it is
  // unwritable. Same shape as swift's per-entry `dep:<hash>` / `dep-stale:<pkg>` tags, one layer later.
  //
  // MEASURED before pinning it, by instrumenting the gate's empty-set default and running five real arms
  // (this engine's own sources with --allow-js, execa @ HEAD, got @ HEAD, and execa chained against 13
  // dependency reports — once TRUSTED, once STALE): 0 fires, and 0 entries carrying a direct Unknown with
  // no reason, over 1872 Unknown-bearing functions. The STALE arm is the one that matters — a distrusted
  // producer's entries are downgraded to a bare `Unknown` with its reasons deliberately NOT copied
  // (the loader's `if (!stale)` guards), which is the route candor-java found to be its ONLY route to the
  // join-side default. So this asserts the scan SUCCEEDS on that arm: an invariant that fails closed is
  // satisfied only if a report comes out the other side.
  const staleDir = path.join(bareCons, "stale-deps");
  fs.mkdirSync(staleDir, { recursive: true });
  const bareRep = JSON.parse(fs.readFileSync(path.join(bare, ".candor", "report.json"), "utf8"));
  bareRep.candor.version = "0000000-not-this-build";
  fs.writeFileSync(path.join(staleDir, "barepkg.json"), JSON.stringify(bareRep));
  fs.rmSync(path.join(bareCons, ".candor"), { recursive: true, force: true });   // delete before re-measuring
  const staleRun = spawnSync("node", [path.join(HERE, "scan.mjs"), bareCons], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: staleDir } });
  const stalePathJ = path.join(bareCons, ".candor", "report.json");
  const staleRep = fs.existsSync(stalePathJ) ? JSON.parse(fs.readFileSync(stalePathJ, "utf8")) : null;
  const unnamed = (staleRep?.functions ?? []).filter((e) => (e.direct ?? []).includes("Unknown") && !(e.unknownWhy ?? []).length);
  check("⟨0.24⟩ a reasonless Unknown is NOT REPRESENTABLE: every DIRECT Unknown carries a reason, even one a STALE dep produced",
        staleRep != null && staleRun.status === 0 && unnamed.length === 0
          && staleRep.functions.some((e) => (e.direct ?? []).includes("Unknown")),
        `status=${staleRun.status} ${staleRun.stderr.slice(0, 200)} ${JSON.stringify((staleRep?.functions ?? []).map((e) => [e.fn, e.direct, e.unknownWhy]))}`);
}

// ── 11a. ⟨0.21⟩ a chained report that DECLARES ITSELF INCOMPLETE grants no coverage ───────────────
// §2 rule 3 turns a report's silence into a purity claim. A report carrying `unanalyzed` has just said it
// never read some of its own source, so its silence about that source answers nothing — the same split
// `651c9f9` made for a report that fails the §2.1 version check, through a different door.
if (blk()) {
  const pol = (dir, body) => { const p = path.join(dir, "p.policy"); fs.writeFileSync(p, body); return p; };
  const mkApp = (name) => project({
    "package.json": `{"name":"${name}","dependencies":{"holedep":"1.0.0"}}`,
    "node_modules/holedep/package.json": `{"name":"holedep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/holedep/index.d.ts": `export declare function ping(): void;\nexport declare function save(p: string): void;`,
    "node_modules/holedep/index.js": ``,
    "src/main.ts": `import { save } from "holedep";\nexport function go(): void { save("/tmp/x"); }`,
  });
  // THE SECOND FIXTURE, WRITTEN FIRST (standing bar item 0): a COMPLETE dep report must still grant
  // coverage, so a key it does not answer stays SILENT. Without this control the fix is indistinguishable
  // from "chained coverage no longer exists", which re-opens the κ-hedge flood §2 rule 3 exists to close.
  const whole = project({
    "package.json": `{"name":"holedep"}`,
    "src/ok.ts": `import * as netm from "node:net";\nexport function ping(): void { netm.connect(443, "ok.example.com"); }`,
    "src/other.ts": `export function save(p: string): void { /* genuinely pure */ }`,
  });
  const wholeRep = scan(whole).report;
  check("control: the complete dep report declares no unanalyzed units",
        !(wholeRep.unanalyzed ?? []).length, JSON.stringify(wholeRep.unanalyzed));
  const appW = mkApp("wholeapp");
  spawnSync("node", [path.join(HERE, "scan.mjs"), appW], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(whole, ".candor", "report.json") } });
  const goW = entry(JSON.parse(fs.readFileSync(path.join(appW, ".candor", "report.json"), "utf8")), "src.main.go");
  check("a COMPLETE dep report still grants coverage — its silence stays a purity claim",
        goW == null || (!goW.invisible?.includes("holedep") && !goW.inferred.includes("Unknown")),
        JSON.stringify(goW));

  // THE DEFECT. `const T = \`` swallows the rest of the file, so `save` is not merely mis-parsed — its
  // declaration is GONE from the report while the envelope still names the package. The dep's own scan
  // refuses to certify a gate over itself (exit 2); the consumer used to certify one on its behalf.
  const holed = project({
    "package.json": `{"name":"holedep"}`,
    "src/ok.ts": `import * as netm from "node:net";\nexport function ping(): void { netm.connect(443, "ok.example.com"); }`,
    "src/broken.ts": "import * as fsm from \"node:fs\";\nconst T = `oops\nexport function save(p: string): void { fsm.writeFileSync(p, \"x\"); }\n",
  });
  const holedScan = scan(holed);
  check("the dep scan discloses the hole and still names its package",
        (holedScan.report.unanalyzed ?? []).length === 1 && holedScan.report.package === "holedep"
        && !holedScan.report.functions.some((e) => e.hash === "holedep#save"),
        JSON.stringify(holedScan.report.unanalyzed) + " " + JSON.stringify(holedScan.report.functions.map((e) => e.hash)));
  const depRepPath = path.join(holed, ".candor", "report.json");
  const app = mkApp("holeapp");
  spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: depRepPath } });
  const go = entry(JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")), "src.main.go");
  check("a key an INCOMPLETE dep report cannot answer hedges instead of reading pure",
        go != null && go.invisible?.includes("holedep"), JSON.stringify(go));
  const gate = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", pol(app, "deny Fs\n")],
                         { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: depRepPath } });
  check("…and the consumer stops certifying: the incomplete chain is DISCLOSED on stderr",
        /declare source they could not analyze/.test(gate.stderr) && /holedep/.test(gate.stderr), gate.stderr);

  // THE SINGLE-TREE CONTROL: the same sources in ONE package are exit 2 in BOTH arms — the gate cannot be
  // green over unanalyzed code — so chaining an incomplete report was strictly worse than not chaining it.
  const ctl = project({
    "package.json": `{"name":"holeapp"}`,
    "src/broken.ts": "import * as fsm from \"node:fs\";\nconst T = `oops\nexport function save(p: string): void { fsm.writeFileSync(p, \"x\"); }\n",
    "src/main.ts": `import { save } from "./broken";\nexport function go(): void { save("/tmp/x"); }`,
  });
  const ctlGate = spawnSync("node", [path.join(HERE, "scan.mjs"), ctl, "--policy", pol(ctl, "deny Fs\n")], { encoding: "utf8" });
  check("single-tree control: the gate refuses to certify over unanalyzed code (exit 2)",
        ctlGate.status === 2, String(ctlGate.status) + ctlGate.stderr);

  // An `import` backed ONLY by an incomplete report discloses, the way one backed only by a stale report
  // does — the initializer edge's half of the same argument.
  const imp = project({
    "package.json": `{"name":"impapp","dependencies":{"holedep":"1.0.0"}}`,
    "node_modules/holedep/package.json": `{"name":"holedep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/holedep/index.d.ts": `export declare function ping(): void;`,
    "node_modules/holedep/index.js": ``,
    "src/main.ts": `import "holedep";\nexport function go(): void { }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), imp], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: depRepPath } });
  const impMod = JSON.parse(fs.readFileSync(path.join(imp, ".candor", "report.json"), "utf8"))
    .functions.find((e) => e.fn === "src.main.<module>");
  check("an import backed only by an INCOMPLETE report discloses Unknown[incomplete-dep]",
        impMod?.inferred.includes("Unknown") && impMod?.unknownWhy?.includes("incomplete-dep:holedep"),
        JSON.stringify(impMod));

  // The KEPT half, and the guard that makes this different from staleness: an entry the incomplete report
  // DOES carry is still applied UNCHANGED. Its effects were derived from source the dep did read, so
  // downgrading them would be trading a false purity claim for a lost reach.
  const useOk = project({
    "package.json": `{"name":"okapp","dependencies":{"holedep":"1.0.0"}}`,
    "node_modules/holedep/package.json": `{"name":"holedep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/holedep/index.d.ts": `export declare function ping(): void;`,
    "node_modules/holedep/index.js": ``,
    "src/main.ts": `import { ping } from "holedep";\nexport function go(): void { ping(); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), useOk], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: depRepPath } });
  const goOk = entry(JSON.parse(fs.readFileSync(path.join(useOk, ".candor", "report.json"), "utf8")), "src.main.go");
  check("an entry the incomplete report DOES carry is applied unchanged (not downgraded to Unknown)",
        goOk?.inferred.includes("Net") && !goOk?.inferred.includes("Unknown") && goOk?.hosts?.includes("ok.example.com"),
        JSON.stringify(goOk));

  // A package chained TWICE — once incomplete, once complete — is COVERED by the complete report. Same
  // rule as the stale/fresh pair one line along in the loader: a real coverage claim must not pick up the
  // other report's hedge, or a fixpoint `--workspace` round that happens to also see an older partial
  // report would hedge everything.
  const appBoth = mkApp("bothapp");
  spawnSync("node", [path.join(HERE, "scan.mjs"), appBoth], { encoding: "utf8",
    env: { ...process.env, CANDOR_DEPS: `${depRepPath}:${path.join(whole, ".candor", "report.json")}` } });
  const repBoth = JSON.parse(fs.readFileSync(path.join(appBoth, ".candor", "report.json"), "utf8"));
  const goBoth = entry(repBoth, "src.main.go");
  check("a package chained twice — incomplete AND complete — is covered by the COMPLETE report",
        goBoth == null || (!goBoth.invisible?.includes("holedep") && !goBoth.inferred.includes("Unknown")),
        JSON.stringify(goBoth));
  // …and specifically at the IMPORT edge, which is the only reader of `incompleteDepPkgs` that a covered
  // package still reaches (the κ-ledger arm is gated on the package being UNcovered, so it cannot). Without
  // the dedup the importing module discloses `Unknown[incomplete-dep]` on a package a complete report
  // covers — false uncertainty manufactured by the fix, and the mutant that proves this guard is load-bearing.
  const modBoth = repBoth.functions.find((e) => e.fn === "src.main.<module>");
  check("…including at the import edge: no incomplete-dep hedge on a package a complete report covers",
        !(modBoth?.unknownWhy ?? []).some((w) => w.startsWith("incomplete-dep:")), JSON.stringify(modBoth));

  // Half 1 must SURVIVE the coverage withdrawal. The unanswerable-key Unknown fires today because the
  // package is covered; withholding coverage sends the site to the κ-ledger arm, and letting that hedge
  // REPLACE the Unknown would narrow `deny E Unknown[dispatch]` — a gate lost to a fix (item 0).
  const ifaceDep = project({
    "package.json": `{"name":"ifacedep"}`,
    "src/ok.ts": `import * as fsm from "node:fs";\nexport class FileStore { save(p: string): void { fsm.writeFileSync(p, "x"); } }`,
    "src/broken.ts": "const T = `oops\nexport function gone(): void { }\n",
  });
  scan(ifaceDep);
  const ifaceApp = project({
    "package.json": `{"name":"ifaceapp","dependencies":{"ifacedep":"1.0.0"}}`,
    "node_modules/ifacedep/package.json": `{"name":"ifacedep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/ifacedep/index.d.ts": `export interface Store { save(p: string): void; }\nexport declare function build(): Store;`,
    "node_modules/ifacedep/index.js": ``,
    "src/main.ts": `import { build } from "ifacedep";\nexport function go(): void { build().save("/tmp/x"); }`,
  });
  const ifaceDeps = path.join(ifaceDep, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), ifaceApp], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: ifaceDeps } });
  const goIf = entry(JSON.parse(fs.readFileSync(path.join(ifaceApp, ".candor", "report.json"), "utf8")), "src.main.go");
  check("half 1's unanswerable-key Unknown SURVIVES the coverage withdrawal (both voices, not one)",
        goIf?.inferred.includes("Unknown") && goIf?.unknownWhy?.some((w) => w.startsWith("dispatch:ifacedep.Store."))
        && goIf?.invisible?.includes("ifacedep"), JSON.stringify(goIf));
  const ifaceGate = spawnSync("node", [path.join(HERE, "scan.mjs"), ifaceApp, "--policy", pol(ifaceApp, "deny Fs Unknown[dispatch]\n")],
                              { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: ifaceDeps } });
  check("…so `deny Fs Unknown[dispatch]` still fires over an incomplete chain (exit 1)",
        ifaceGate.status === 1, String(ifaceGate.status) + ifaceGate.stdout);
}

// ── 11e. ⟨0.24⟩ a chained report that JUDGED NOTHING grants no coverage ───────────────────────────
// SPEC §2's three-row table. The same door as 11a with a third key: staleness says the report is not ours
// to repeat, incompleteness says it could not read its own source, and this says there is nothing in it to
// repeat at all. MEASURED here before a line was written (dep `hit()` reads /etc/hosts, app `go()` calls
// it, `deny Fs`):
//
//   unchained          go -> inferred: [], invisible: ['ratesdep'], coverage.uncovered, κ nudge   exit 0
//   trusted            go -> inferred: ['Fs']                                                     exit 1
//   count: 0   (pre)   go -> ABSENT FROM `functions`, no coverage, no verdict block, no nudge      exit 0
//
// State the harm precisely, because the loose form sends you after the wrong symptom: an empty report
// carries no effects, so the count-0 arm cannot itself TRIP a gate — it and the unchained arm both exit 0.
// What it DELETES is the DISCLOSURE, so the FLOOR assertion below is EQUALITY WITH THE UNCHAINED ARM
// rather than a literal: "exactly as if unchained" is what §2 states, and a literal would pass for a fix
// that happened to hedge differently. The count-n arm beside it is a CONTROL, not decoration — both prior
// engines report that keying the rule on the emptiness of `functions` fails the control while the count-0
// row stays GREEN, so the FLOOR arm alone cannot catch the destructive fix.
if (blk()) {
  const pol = (dir, body) => { const p = path.join(dir, "p.policy"); fs.writeFileSync(p, body); return p; };
  const dep = project({
    "package.json": `{"name":"ratesdep"}`,
    "src/index.ts": `import * as fsm from "node:fs";
export function hit(): string { return fsm.readFileSync("/etc/hosts", "utf8"); }
export function calc(a: number): number { return a + 1; }`,
  });
  const depRep = scan(dep).report;
  check("⟨0.24⟩ control: the report the arms are derived from judged units and names its package",
        depRep.analyzed?.count > 0 && depRep.package === "ratesdep"
        && depRep.functions.some((e) => e.hash === "ratesdep#hit"),
        JSON.stringify({ analyzed: depRep.analyzed, package: depRep.package }));
  // `calc` is PURE, so the dep's report OMITS it — that absence is the §2 rule 3 purity claim, and the
  // second app is how coverage (rather than the entry join) is observed on its own.
  // EVERY arm is the same package in a different directory: the entry `hash` is `<package>#<fn>`, and the
  // FLOOR row below asserts the count-0 arm's entry EQUALS the unchained arm's, which a per-arm package
  // name would break for a reason that has nothing to do with the rule.
  const mkApp = (call) => project({
    "package.json": `{"name":"ratesapp","dependencies":{"ratesdep":"1.0.0"}}`,
    "node_modules/ratesdep/package.json": `{"name":"ratesdep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/ratesdep/index.d.ts": `export declare function hit(): string;\nexport declare function calc(a: number): number;`,
    "node_modules/ratesdep/index.js": ``,
    "src/main.ts": call === "calc"
      ? `import { calc } from "ratesdep";\nexport function go(): number { return calc(1); }`
      : `import { hit } from "ratesdep";\nexport function go(): string { return hit(); }`,
  });
  // ONE arm = one app, scanned once with `deny Fs` and a `--gate-json`, so the FOUR channels the defect
  // deleted are all observable: the per-fn entry, the envelope `coverage`, the verdict's coverage block
  // and stderr.
  const arm = (doc, call) => {
    const app = mkApp(call);
    const env = { ...process.env };
    if (doc !== null) {
      const f = path.join(app, "dep.json");
      fs.writeFileSync(f, JSON.stringify(doc, null, 1));
      env.CANDOR_DEPS = f;
    } else delete env.CANDOR_DEPS;
    const run = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", pol(app, "deny Fs\n"),
                                   "--gate-json", path.join(app, "v.json")], { encoding: "utf8", env });
    const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
    return { rep, go: entry(rep, "src.main.go"), coverage: rep.coverage ?? null,
             verdict: JSON.parse(fs.readFileSync(path.join(app, "v.json"), "utf8")),
             status: run.status, stderr: run.stderr };
  };
  const JUDGED_NOTHING = /judged NOTHING/;
  const withFns = (fns) => ({ ...JSON.parse(JSON.stringify(depRep)), functions: fns });
  const emptied = (analyzed) => {
    const d = withFns([]);
    if (analyzed === undefined) delete d.analyzed; else d.analyzed = analyzed;
    return d;
  };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const unchained = arm(null);
  const trusted = arm(depRep);
  const zero = arm(emptied({ count: 0, digest: depRep.analyzed.digest }));
  const allpure = arm(emptied({ count: 2, digest: depRep.analyzed.digest }));

  // NON-VACUITY: the reference arms have to differ, or every equality below is trivially satisfied.
  check("⟨0.24⟩ reference arms: trusted knows `Fs` (exit 1); unchained hedges `invisible` + `coverage` (exit 0)",
        trusted.go?.inferred.includes("Fs") && trusted.status === 1
        && unchained.go?.invisible?.includes("ratesdep") && unchained.coverage?.uncovered?.[0]?.name === "ratesdep"
        && unchained.status === 0,
        JSON.stringify({ trusted: trusted.go, unchained: unchained.go, cov: unchained.coverage, ex: [trusted.status, unchained.status] }));
  // THE FLOOR, asserted as EQUALITY with the unchained arm across all four channels.
  check("⟨0.24⟩ FLOOR: a count-0 chain answers EXACTLY as the UNCHAINED arm does (entry, coverage, verdict, exit)",
        same(zero.go, unchained.go) && same(zero.coverage, unchained.coverage)
        && same(zero.verdict.coverage, unchained.verdict.coverage) && zero.status === unchained.status,
        JSON.stringify({ zero: [zero.go, zero.coverage, zero.verdict.coverage, zero.status],
                         unchained: [unchained.go, unchained.coverage, unchained.verdict.coverage, unchained.status] }));
  check("⟨0.24⟩ …and it is DISCLOSED by name on stderr, with a remedy (the disclosure IS the fix)",
        JUDGED_NOTHING.test(zero.stderr) && /ratesdep/.test(zero.stderr) && /analyzed\.count/.test(zero.stderr),
        zero.stderr.slice(0, 300));
  // THE CONTROL. Byte-identical to the arm above apart from ONE integer, and it must stay UNTOUCHED: §2
  // rule 3 makes an all-pure dependency's empty report a CLAIM. A fix keyed on `functions.length` passes
  // the two rows above and fails exactly here.
  check("⟨0.24⟩ CONTROL: count n>0 with the SAME empty `functions` is still believed all-pure (unchanged)",
        allpure.go === undefined && allpure.coverage === null && allpure.verdict.coverage === undefined
        && allpure.status === 0 && !JUDGED_NOTHING.test(allpure.stderr),
        JSON.stringify({ go: allpure.go, cov: allpure.coverage, v: allpure.verdict, ex: allpure.status }));

  // ROW 3 of the table, and the anti-flood row beside it. A pre-⟨0.21⟩ producer's manifest-less report
  // says nothing about whether it judged anything, so an EMPTY one falls back to the unchained reading —
  // a deliberate retirement of the old affordance — while one that LISTS functions judged units and said
  // so the only way it could, and keeps the coverage it has always had.
  const noManifest = arm(emptied(undefined));
  check("⟨0.24⟩ row 3: a manifest-less EMPTY report falls back to the unchained reading",
        same(noManifest.go, unchained.go) && same(noManifest.coverage, unchained.coverage)
        && JUDGED_NOTHING.test(noManifest.stderr),
        JSON.stringify({ go: noManifest.go, cov: noManifest.coverage }));
  const noManifestFns = (() => { const d = JSON.parse(JSON.stringify(depRep)); delete d.analyzed; return d; })();
  const legacy = arm(noManifestFns);
  check("⟨0.24⟩ anti-flood: a manifest-less report that LISTS functions keeps its standing (entries + coverage)",
        legacy.go?.inferred.includes("Fs") && !JUDGED_NOTHING.test(legacy.stderr), JSON.stringify(legacy.go));
  // FAIL CLOSED: a judgment claim that cannot be READ is not a claim. A denylist of proven-safe shapes,
  // the posture 11a's malformed-`unanalyzed` row already takes one key over.
  for (const [label, a] of [["a string", "oops"], ["an empty object", {}], ["null", null],
                            ["a non-numeric count", { count: "2" }]]) {
    const garbled = arm(emptied(a));
    check(`⟨0.24⟩ fail-closed: a manifest that is ${label} grants no coverage`,
          same(garbled.go, unchained.go) && JUDGED_NOTHING.test(garbled.stderr), JSON.stringify(garbled.go));
  }

  // COVERAGE IS ANCHORED TWICE — the envelope `package` key AND each entry's `hash` prefix — so gating one
  // is a no-op wearing a fix's clothes. The CONTRADICTORY report (count 0 while listing functions) is the
  // only shape that reaches the entry anchor, and it must fail closed there too: the arm below calls
  // `calc`, which the dep's report legitimately OMITS, so the answer turns on COVERAGE alone.
  const contradictory = withFns(depRep.functions);
  contradictory.analyzed = { count: 0, digest: depRep.analyzed.digest };
  const calcTrusted = arm(depRep, "calc");
  const calcContra = arm(contradictory, "calc");
  check("⟨0.24⟩ control: a trusted report's SILENCE about the pure `calc` is its purity claim (no hedge)",
        calcTrusted.go === undefined || !calcTrusted.go.invisible?.includes("ratesdep"), JSON.stringify(calcTrusted.go));
  check("⟨0.24⟩ the ENTRY-hash anchor is gated too: a count-0 report LISTING functions grants no coverage",
        calcContra.go?.invisible?.includes("ratesdep"), JSON.stringify(calcContra.go));
  // …and the other half of that shape: withholding coverage may never take a real ANSWER with it. The
  // entries stay ungated, so the key the contradictory report DOES carry is still applied unchanged.
  const hitContra = arm(contradictory);
  check("⟨0.24⟩ …while its entries stay UNGATED — a key it does answer is applied unchanged (strictly additive)",
        hitContra.go?.inferred.includes("Fs"), JSON.stringify(hitContra.go));

  // A package chained TWICE — once judged, once not — IS covered. The direction follows from what the
  // second report SAYS: a count-0 report makes no claim in either direction, so letting it withdraw
  // another report's earned purity claim would be the mirror sin.
  const bothApp = mkApp("calc");
  const zeroFile = path.join(bothApp, "zero.json"), realFile = path.join(bothApp, "real.json");
  fs.writeFileSync(zeroFile, JSON.stringify(emptied({ count: 0, digest: "x" }), null, 1));
  fs.writeFileSync(realFile, JSON.stringify(depRep, null, 1));
  spawnSync("node", [path.join(HERE, "scan.mjs"), bothApp], { encoding: "utf8",
    env: { ...process.env, CANDOR_DEPS: `${zeroFile}:${realFile}` } });
  const goBothZ = entry(JSON.parse(fs.readFileSync(path.join(bothApp, ".candor", "report.json"), "utf8")), "src.main.go");
  check("⟨0.24⟩ a package chained twice — count-0 AND judged — keeps the JUDGED report's coverage",
        goBothZ === undefined || !goBothZ.invisible?.includes("ratesdep"), JSON.stringify(goBothZ));

  // ── ⟨0.24⟩ THE FOURTH CONJUNCT: a §2 key that is PRESENT BUT UNPARSEABLE (SPEC §2) ───────────────
  // The same defect as the count-0 rows above, arriving through a different key, and MEASURED strictly
  // worse: `functions: "oops"` / entry `inferred: null` put `go` ABSENT from `functions` — a ⟨0.21⟩
  // positive purity claim — with no `invisible`, no `coverage.uncovered` and no verdict coverage block,
  // where the UNCHAINED arm discloses all four. Its fabrication mirror rode the same line: `inferred:
  // "Fs"` was iterated into CHARACTERS and shipped to the consumer's own report as `['F','s']`.
  // The floor is the same one §2 states for count-0 — "exactly as if unchained" — asserted as EQUALITY
  // across all four channels, with the trusted arm above as the non-vacuity control.
  const mut = (f) => { const d = JSON.parse(JSON.stringify(depRep)); f(d); return d; };
  const CORRUPT = [
    ["`functions` is a string", mut((d) => { d.functions = "oops"; })],
    ["`functions` is an object", mut((d) => { d.functions = {}; })],
    ["entry `inferred` is null", mut((d) => { for (const e of d.functions) { e.inferred = null; e.direct = null; } })],
    ["entry `inferred` is a bare string", mut((d) => { for (const e of d.functions) { e.inferred = "Fs"; e.direct = "Fs"; } })],
    ["entry `inferred` holds a non-string", mut((d) => { for (const e of d.functions) { e.inferred = [7]; e.direct = [7]; } })],
    ["entry `unknownWhy` holds a non-string", mut((d) => { for (const e of d.functions) e.unknownWhy = [7]; })],
    ["an entry has no `fn`", mut((d) => { for (const e of d.functions) delete e.fn; })],
  ];
  const cbad = [];
  for (const [label, doc] of CORRUPT) {
    const a = arm(doc);
    if (!(same(a.go, unchained.go) && same(a.coverage, unchained.coverage)
          && same(a.verdict.coverage, unchained.verdict.coverage) && a.status === unchained.status))
      cbad.push(`${label}: ${JSON.stringify({ go: a.go, cov: a.coverage, vcov: a.verdict.coverage, exit: a.status })}`);
    // The fabrication half: no character-soup effect may reach the consumer's report under ANY row.
    if ((a.go?.inferred ?? []).some((x) => typeof x !== "string" || !/^[A-Z]/.test(x)))
      cbad.push(`${label}: FABRICATED effect(s) ${JSON.stringify(a.go.inferred)}`);
  }
  check(`⟨0.24⟩ FLOOR: all ${CORRUPT.length} present-but-unparseable §2 keys on a chained dep answer EXACTLY as the UNCHAINED arm (entry, coverage, verdict, exit), and none fabricates an effect`,
        cbad.length === 0, cbad.join("\n"));
  const cdis = arm(CORRUPT[3][1]);
  check("⟨0.24⟩ …and the corrupt chain is DISCLOSED by name on stderr, with a remedy",
        /present.but.UNPARSEABLE|present-but-unparseable/i.test(cdis.stderr) && /ratesdep/.test(cdis.stderr),
        cdis.stderr.slice(0, 400));
  // STRICTLY ADDITIVE, and this is the row that stops the fix from becoming a silent under-report of its
  // own: one corrupt entry must not withdraw a SIBLING entry that reads cleanly. `hit` is garbled, `calc`
  // is intact, and `calc`'s absence from the report is still the dep's purity claim about it.
  const partial = mut((d) => { d.functions[0].inferred = [7]; d.functions[0].direct = [7];
                               d.functions.push({ fn: "src.index.calc", hash: "ratesdep#calc", loc: "x:1:1",
                                                  inferred: ["Exec"], direct: ["Exec"], cmds: ["git"] }); });
  const pa = arm(partial, "calc");
  check("⟨0.24⟩ STRICTLY ADDITIVE: a corrupt entry does not withdraw a SIBLING entry that reads cleanly (`calc` still delivers Exec)",
        pa.go?.inferred?.includes("Exec"), JSON.stringify(pa.go));
  // CONTROL for the whole block: the untouched report still delivers, so the rows above are not passing
  // because the fixture stopped joining at all.
  check("⟨0.24⟩ CONTROL: the UNMUTATED report still delivers `Fs` and fires the gate (exit 1)",
        trusted.go?.inferred.includes("Fs") && trusted.status === 1, JSON.stringify(trusted.go));
}

// ── 11b. ⟨0.20⟩ the dep's Net-surface INCOMPLETENESS crosses the boundary with its hosts ──────────
// A trust marker failing OPEN at the scan boundary: `hosts` is a LOWER bound and `netClass`'s
// `unknown-host` is the producer's published judgment that it is one. The join copied the literals and
// not the judgment, so the consumer re-derived `netClass` from a partial surface and certified it.
if (blk()) {
  const pol = (dir, body) => { const p = path.join(dir, "p.policy"); fs.writeFileSync(p, body); return p; };
  // THE SECOND FIXTURE, WRITTEN FIRST (standing bar item 0): a dep whose Net surface is COMPLETE must NOT
  // pick up `unknown-host` at the consumer. Without this control the fix is indistinguishable from
  // "every chained Net is unknown-host", which floods `deny Net[unknown-host]` on clean code.
  const cleanDep = project({
    "package.json": `{"name":"cleanlib"}`,
    "src/t.ts": `import * as netm from "node:net";
export function beacon(): void { netm.connect(443, "sentry.io"); }`,
  });
  scan(cleanDep);
  const cleanApp = project({
    "package.json": `{"name":"cleanapp","dependencies":{"cleanlib":"1.0.0"}}`,
    "node_modules/cleanlib/package.json": `{"name":"cleanlib","types":"index.d.ts","main":"index.js"}`,
    "node_modules/cleanlib/index.d.ts": `export declare function beacon(): void;`,
    "node_modules/cleanlib/index.js": ``,
    "src/m.ts": `import { beacon } from "cleanlib";
export function go(): void { beacon(); }`,
  });
  const cleanDeps = path.join(cleanDep, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), cleanApp], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: cleanDeps } });
  const goClean = entry(JSON.parse(fs.readFileSync(path.join(cleanApp, ".candor", "report.json"), "utf8")), "src.m.go");
  check("a COMPLETE dep Net surface stays certified at the consumer (no unknown-host flood)",
        goClean?.netClass?.includes("known-telemetry") && !goClean?.netClass?.includes("unknown-host"),
        JSON.stringify(goClean));
  const cleanGate = spawnSync("node", [path.join(HERE, "scan.mjs"), cleanApp, "--policy", pol(cleanApp, "deny Net[unknown-host]\n")],
                              { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: cleanDeps } });
  check("…and `deny Net[unknown-host]` stays GREEN over it", cleanGate.status === 0, cleanGate.stdout + cleanGate.stderr);

  // THE DEFECT: one literal host and one runtime host in the same dep function. The producer publishes
  // `netClass: ['known-telemetry','unknown-host']`; the consumer used to read `['known-telemetry']`.
  const dep = project({
    "package.json": `{"name":"masklib"}`,
    "src/t.ts": `import * as netm from "node:net";
export function beacon(where: string): void { netm.connect(443, "sentry.io"); netm.connect(443, where); }`,
  });
  const depRep = scan(dep).report;
  check("producer publishes the masked Net surface as unknown-host",
        entry(depRep, "src.t.beacon")?.netClass?.includes("unknown-host")
        && entry(depRep, "src.t.beacon")?.netClass?.includes("known-telemetry"),
        JSON.stringify(entry(depRep, "src.t.beacon")));
  const app = project({
    "package.json": `{"name":"maskapp","dependencies":{"masklib":"1.0.0"}}`,
    "node_modules/masklib/package.json": `{"name":"masklib","types":"index.d.ts","main":"index.js"}`,
    "node_modules/masklib/index.d.ts": `export declare function beacon(where: string): void;`,
    "node_modules/masklib/index.js": ``,
    "src/m.ts": `import { beacon } from "masklib";
export function go(w: string): void { beacon(w); }`,
  });
  const deps = path.join(dep, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: deps } });
  const go = entry(JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")), "src.m.go");
  check("a chained dep's masked Net surface arrives as unknown-host (the marker crosses the boundary)",
        go?.inferred.includes("Net") && go?.hosts?.includes("sentry.io") && go?.netClass?.includes("unknown-host"),
        JSON.stringify(go));

  // THE SINGLE-TREE CONTROL — the same source in ONE package is exit 1 in BOTH arms, so this is a
  // BOUNDARY defect and not a general limitation of the destination-class rung.
  const ctl = project({
    "package.json": `{"name":"maskapp"}`,
    "src/t.ts": `import * as netm from "node:net";
export function beacon(where: string): void { netm.connect(443, "sentry.io"); netm.connect(443, where); }`,
    "src/m.ts": `import { beacon } from "./t";
export function go(w: string): void { beacon(w); }`,
  });
  const ctlGate = spawnSync("node", [path.join(HERE, "scan.mjs"), ctl, "--policy", pol(ctl, "deny Net[unknown-host]\n")], { encoding: "utf8" });
  check("single-tree control: `deny Net[unknown-host]` fires (exit 1)", ctlGate.status === 1, ctlGate.stdout + ctlGate.stderr);
  const splitGate = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", pol(app, "deny Net[unknown-host]\n")],
                              { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: deps } });
  check("split + chained: the SAME rule still fires (exit 1) — the boundary no longer certifies it",
        splitGate.status === 1, splitGate.stdout + splitGate.stderr);

  // The MASKING form java `e24edd9` names, one layer up: the consumer's OWN literal host must not certify
  // a dep's hostless Net. Without the marker `hosts` is non-empty, so `netClassesOf` never adds unknown-host.
  const hostless = project({
    "package.json": `{"name":"hostlesslib"}`,
    "src/t.ts": `import * as netm from "node:net";
export function send(where: string): void { netm.connect(443, where); }`,
  });
  scan(hostless);
  const mixed = project({
    "package.json": `{"name":"mixedapp","dependencies":{"hostlesslib":"1.0.0"}}`,
    "node_modules/hostlesslib/package.json": `{"name":"hostlesslib","types":"index.d.ts","main":"index.js"}`,
    "node_modules/hostlesslib/index.d.ts": `export declare function send(where: string): void;`,
    "node_modules/hostlesslib/index.js": ``,
    "src/m.ts": `import { send } from "hostlesslib";
import * as netm from "node:net";
export function both(w: string): void { netm.connect(443, "sentry.io"); send(w); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), mixed], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(hostless, ".candor", "report.json") } });
  const both = entry(JSON.parse(fs.readFileSync(path.join(mixed, ".candor", "report.json"), "utf8")), "src.m.both");
  check("a sibling literal in the CONSUMER's body cannot certify a chained dep's hostless Net",
        both?.netClass?.includes("unknown-host") && both?.netClass?.includes("known-telemetry"),
        JSON.stringify(both));
}

// ── 12. entry points + reachable + unknownWhy + allow-js + import-alias edges ────────────────────
if (blk()) {
  const d = project({
    "tsconfig.json": `{"compilerOptions":{"strict":true,"experimentalDecorators":true},"include":["src","app"]}`,
    "src/deco.d.ts": `declare global { function __noop(): void; }
export declare function Get(path?: string): MethodDecorator;`,
    "src/ctl.ts": `import { Get } from "./deco.js";
import { DatabaseSync } from "node:sqlite";
export class Ctl {
  @Get("/x") list(db: DatabaseSync): void { db.exec("SELECT 1 FROM t"); }
  @Get("/pure") ping(): string { return "pong"; }
}`,
    "app/x/route.ts": `import * as netm from "node:net";
export function GET(): void { netm.connect(443, "api.x.com"); }`,
  });
  const { report, prefix } = scan(d);
  check("Nest-style @Get marks an entry point", entry(report, "src.ctl.Ctl.list")?.entryPoint === true);
  check("a PURE entry point stays visible", entry(report, "src.ctl.Ctl.ping")?.entryPoint === true,
        JSON.stringify(report.functions.map((e) => e.fn)));
  check("a Next route handler is an entry point", entry(report, "app.x.route.GET")?.entryPoint === true);
  const reach = JSON.parse(spawnSync("node", [path.join(HERE, "query.mjs"), "reachable", prefix, "1"],
                                     { encoding: "utf8" }).stdout);
  check("reachable unions effects over entry points (rust-shaped JSON)",
        reach.entryPoints === 3 && reach.effects?.Db?.count === 1 && reach.effects?.Net?.count === 1,
        JSON.stringify(reach));

  // whatif against a TYPO'd policy path must be LOUD (exit 2), not gateless-green (ok:true, exit 0).
  const q = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), ...a], { encoding: "utf8" });
  const wiBad = q("whatif", prefix, "GET", "Db", path.join(d, "no-such-policy"));
  check("whatif on a non-existent policy path exits 2 LOUDLY (not gateless-green)",
        wiBad.status === 2 && /could not be read/.test(wiBad.stderr), `status=${wiBad.status} ${wiBad.stderr.slice(0, 120)}`);
  // a REAL policy still evaluates (control): a deny that the affected set trips → exit 1.
  fs.writeFileSync(path.join(d, "pol"), "deny Net app\n");
  const wiOk = q("whatif", prefix, "GET", "Net", path.join(d, "pol"));
  check("whatif against a real policy still evaluates (exit 1 on a violation)",
        wiOk.status === 1 && /"ok": false/.test(wiOk.stdout), `status=${wiOk.status} ${wiOk.stdout.slice(0, 120)}`);
  // the 0/1 verbosity sentinel is NOT treated as a policy path (no spurious read attempt).
  const wiSentinel = q("whatif", prefix, "GET", "Net", "1");
  check("whatif treats a trailing 0/1 as the verbosity sentinel, not a policy path",
        wiSentinel.status === 0 && /"ok": true/.test(wiSentinel.stdout), `status=${wiSentinel.status} ${wiSentinel.stdout.slice(0, 120)}`);

  // parsepolicy on an unreadable file → clean exit 2, NOT an uncaught readFileSync stack trace.
  const ppBad = q("parsepolicy", path.join(d, "no-such-policy"));
  check("parsepolicy on an unreadable file exits 2 cleanly (no stack trace)",
        ppBad.status === 2 && /could not be read/.test(ppBad.stderr) && !/Error:|at /.test(ppBad.stderr),
        `status=${ppBad.status} ${ppBad.stderr.slice(0, 160)}`);
}
if (blk()) {
  const d = project({
    "src/u.ts": `export function launder(x: unknown): void { (x as any)(); }
export function recv(cb: () => void, other: string): void { cb(); }`,
  });
  const { report } = scan(d);
  check("unknownWhy names the unresolvable callee", 
        entry(report, "src.u.launder")?.unknownWhy?.some((w) => w.startsWith("callback:")),
        JSON.stringify(entry(report, "src.u.launder")));
  check("unknownWhy names the opaque callback param",
        entry(report, "src.u.recv")?.unknownWhy?.includes("callback:param#0"),
        JSON.stringify(entry(report, "src.u.recv")));
}
if (blk()) {
  const d = project({
    "src/x.js": `import * as fsm from "node:fs";
export function jsRead() { return fsm.readFileSync("/x"); }`,
  });
  const { report } = scan(d, "--allow-js");
  check("--allow-js analyzes JS sources", entry(report, "src.x.jsRead")?.inferred.includes("Fs"),
        JSON.stringify(report?.functions));
}
if (blk()) {
  const d = project({
    "src/e.ts": `import * as fsm from "node:fs";
export class Loader { cfg = fsm.readFileSync("/cfg"); }`,
    "src/m.ts": `import { Loader } from "./e.js";
export function boot(): Loader { return new Loader(); }`,
  });
  const { report, cg } = scan(d);
  check("an IMPORTED class's `new` edges through the alias to its ctor",
        cg["src.m.boot"]?.includes("src.e.Loader.constructor")
        && entry(report, "src.m.boot")?.inferred.includes("Fs") && !entry(report, "src.m.boot")?.unresolved,
        JSON.stringify(cg));
}

// ── κ-coverage ledger: an unlisted npm package the code calls is NAMED in the receipt ─────────────
if (blk()) {
  const stub = (name, member) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","version":"0.0.0","main":"index.js","types":"index.d.ts"}`,
    [`node_modules/${name}/index.d.ts`]: `export declare function ${member}(s: string): string;`,
    [`node_modules/${name}/index.js`]: `module.exports.${member} = (s) => s;`,
  });
  const d = project({
    ...stub("leftpad", "pad"),     // unlisted — must be DISCLOSED
    ...stub("lodash", "chunk"),    // KAPPA_PURE — reviewed, must NOT be disclosed
    "src/a.ts": `import { pad } from "leftpad";
import { chunk } from "lodash";
import * as fsm from "node:fs";
export function go(): string { fsm.readFileSync("/x"); chunk("ab"); return pad("hi"); }`,
  });
  const { r, report } = scan(d);
  check("coverage ledger names an unlisted package in the receipt",
        /classifier doesn't cover 1 package/.test(r.stderr) && /leftpad \(1 call\)/.test(r.stderr), r.stderr);
  check("coverage ledger stays quiet about reviewed-pure and curated packages",
        !/lodash/.test(r.stderr) && !/node:fs/.test(r.stderr), r.stderr);
  // ⟨0.15 staged⟩ the ledger travels WITH the artifact (COVERAGE-DESIGN.md §1): the envelope carries the
  // SAME names/counts the stderr line prints, and per-fn attribution (`invisible`) is unchanged by it.
  check("⟨0.15⟩ envelope `coverage.uncovered` carries the stderr ledger as data (same names, same counts)",
        JSON.stringify(report?.coverage) === JSON.stringify({ uncovered: [{ name: "leftpad", calls: 1 }] }),
        JSON.stringify(report?.coverage));
  check("⟨0.15⟩ the per-fn posture is untouched: the calling fn still carries `invisible` (no reshape)",
        entry(report, "src.a.go")?.invisible?.includes("leftpad"), JSON.stringify(entry(report, "src.a.go")));
}

// ── ⟨0.24⟩ REPORT BYTES ARE LOCALE-INDEPENDENT (SPEC §2) ─────────────────────────────────────────
// The coverage ledger's name tiebreak orders bytes INSIDE the emitted report, and it used
// `localeCompare` — which consults the runtime's ambient locale. So the same build over the same
// unchanged tree could emit two different reports on two machines, and every "a default report is
// byte-identical" claim in the spec (plus the deterministic effects-fingerprint) rested on it not doing
// that. This is a SEPARATE, STRICTER rule than the collation one below: collation picks which of the
// well-defined orders, this one says the order must not consult the environment at all.
//
// MEASURED, not argued. Pre-fix, on this build, the two runs below produced reports with DIFFERENT md5 —
// the `coverage.uncovered` entries transposed — because Estonian collates z between s and t, so
// `"zpad".localeCompare("tpad")` flips sign with `LC_ALL`. The keys are npm package names: lowercase
// ASCII, exactly the case the UTF-16 hazard cannot reach. ASCII bought no safety here.
//
// The counts are EQUAL (one call each) on purpose: the primary key is count-descending, so equal counts
// are what hand the decision to the name comparator. With unequal counts this fixture would pass under
// `localeCompare` and pin nothing.
if (blk()) {
  const stub = (name) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","version":"0.0.0","main":"index.js","types":"index.d.ts"}`,
    [`node_modules/${name}/index.d.ts`]: `export declare function go(s: string): string;`,
    [`node_modules/${name}/index.js`]: `module.exports.go = (s) => s;`,
  });
  const d = project({
    ...stub("zpad"), ...stub("tpad"),
    "src/a.ts": `import { go as gz } from "zpad";
import { go as gt } from "tpad";
export function run(): string { return gz("a") + gt("b"); }`,
  });
  // `--json` prints the report to stdout, so this compares the emitted BYTES and never a re-parse.
  const under = (loc) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--json"],
                                   { encoding: "utf8", env: { ...process.env, LC_ALL: loc, LANG: loc } });
  const c = under("C").stdout, et = under("et_EE.UTF-8").stdout, da = under("da_DK.UTF-8").stdout;
  check("⟨0.24⟩ report BYTES are identical under LC_ALL=C, et_EE and da_DK (SPEC §2 locale-independence)",
        c.length > 0 && c === et && c === da,
        `C=${c.length}B et=${et.length}B da=${da.length}B` + (c === et ? "" : ` | first divergence C-vs-et`));
  // Identity alone would also hold for a comparator that is stably WRONG, so pin the order too: code
  // point puts `tpad` first. Asserted on ALL THREE runs, not just the C one — under `localeCompare` the C
  // run alone still reads `tpad, zpad`, so checking it would go green against the very defect this block
  // exists for. The et/da runs are where the order actually moves.
  const names = (s) => (JSON.parse(s).coverage?.uncovered ?? []).map((u) => u.name);
  const cp = JSON.stringify(["tpad", "zpad"]);
  check("⟨0.24⟩ ...and that one order is CODE POINT (tpad before zpad) in EVERY locale, not a collation",
        JSON.stringify(names(c)) === cp && JSON.stringify(names(et)) === cp && JSON.stringify(names(da)) === cp,
        `C=${JSON.stringify(names(c))} et=${JSON.stringify(names(et))} da=${JSON.stringify(names(da))}`);
  // CALIBRATION — is the fixture discriminating on THIS runtime? `localeCompare(a, b, "et")` names the
  // locale explicitly, so it answers "does this build carry Estonian collation data?" without depending
  // on the parent's own environment. If it does, the ambient probe MUST flip too; if it does not (a
  // small-ICU Node), nothing in the environment can break the report here and the two checks above are a
  // regression guard on the comparator rather than a demonstration of the break. Said out loud, because a
  // test that quietly stops discriminating is worse than one that never did.
  const hasEtData = "zpad".localeCompare("tpad", "et") < 0;
  const probe = spawnSync("node", ["-e", "process.stdout.write(String('zpad'.localeCompare('tpad')))"],
                          { encoding: "utf8", env: { ...process.env, LC_ALL: "et_EE.UTF-8", LANG: "et_EE.UTF-8" } });
  check("⟨0.24⟩ ...calibration: where the build HAS Estonian collation, LC_ALL flips `localeCompare` on this ASCII pair",
        !hasEtData || probe.stdout.trim() === "-1", `etData=${hasEtData} ambientProbe=${JSON.stringify(probe.stdout)}`);
  if (!hasEtData) console.log("  note this Node build lacks Estonian collation data — the two checks above are a NON-discriminating regression guard on this runtime");
}

// ⟨0.15 staged⟩ the coverage envelope is OMITTED when nothing is uncovered — a fully-covered report is
// byte-identical to a ⟨0.14⟩ one (the wire-compatibility half of the rung), and an UNRESOLVABLE import
// keeps the stronger `Unknown` posture without joining the ledger (no node_modules path to count).
if (blk()) {
  const d = project({
    "src/c.ts": `import * as fsm from "node:fs";
export function covered(): Buffer { return fsm.readFileSync("/x"); }`,
  });
  const { report } = scan(d);
  // ⟨0.22⟩ the completeness manifest ALWAYS appends `analyzed:{count,digest}`; a fully-covered/complete
  // scan still omits `coverage` and `unanalyzed` (both empty), so the wire stays byte-compatible bar the
  // additive `analyzed` sibling.
  //
  // ⟨0.29⟩ …and `excluded`, which is ALWAYS present and deliberately NOT omitted when empty. That is a
  // real wire change and this row is where it shows up, which is the row doing its job. The reasoning is
  // the opposite of `coverage`'s: for a ledger, "empty" and "absent" can mean the same thing, but for a
  // SCOPE they cannot — ⟨0.26⟩ requires an absent key to mean "this producer cannot answer", and an
  // engine that omits its scope when nothing was excluded is indistinguishable from one that has no
  // concept of scope at all. Emitting `[]` is the positive statement ⟨0.27⟩ asks for.
  check("⟨0.15⟩ a fully-covered scan OMITS the coverage envelope key entirely",
        report !== null && !("coverage" in report) && !("unanalyzed" in report)
          && JSON.stringify(Object.keys(report)) === JSON.stringify(["candor", "resolves", "package", "functions", "analyzed", "excluded"]),
        JSON.stringify(Object.keys(report ?? {})));
  const d2 = project({
    "src/u.ts": `import { x } from "not-installed-dep";
export function f(): string { return x(); }`,
  });
  const r2 = scan(d2);
  check("⟨0.15⟩ an unresolvable import stays Unknown (the stronger posture) and outside the ledger — no coverage key",
        entry(r2.report, "src.u.f")?.inferred.includes("Unknown") && !("coverage" in r2.report),
        JSON.stringify({ keys: Object.keys(r2.report ?? {}), f: entry(r2.report, "src.u.f") }));
}

// ── scan-completeness nudge: a high CALL VOLUME into unscanned packages means a missing input ─────
// A scan that sees the app but none of its dependencies leaves their effects invisible — indistinguishable
// in the report from "there is nothing there". The trigger is call VOLUME, not package count (candor-java's
// own build output: 519 calls into 4 packages), so the threshold is pinned at its literal boundary here: a
// drift of the constant must break this test, not slip through. Advisory ONLY — stderr, never the verdict.
if (blk()) {
  const stub = (name, member) => ({
    [`node_modules/${name}/package.json`]: `{"name":"${name}","version":"0.0.0","main":"index.js","types":"index.d.ts"}`,
    [`node_modules/${name}/index.d.ts`]: `export declare function ${member}(s: string): string;`,
    [`node_modules/${name}/index.js`]: `module.exports.${member} = (s) => s;`,
  });
  // n distinct call SITES into one uncovered package — the ledger counts calls, so n is the trigger value.
  const callsInto = (n) => project({
    ...stub("blindpkg", "touch"),
    "src/a.ts": `import { touch } from "blindpkg";
export function go(): void {
${Array.from({ length: n }, (_, i) => `  touch("x${i}");`).join("\n")}
}`,
  });
  const below = scan(callsInto(49));
  check("scan-completeness nudge: JUST BELOW the threshold (49 calls) is SILENT",
        /blindpkg \(49 calls\)/.test(below.r.stderr) && !/hint — /.test(below.r.stderr), below.r.stderr);
  const at = scan(callsInto(50));
  check("scan-completeness nudge: AT the threshold (50 calls) it fires, naming the volume + package count",
        /hint — 50 calls go into 1 package that is not scanned/.test(at.r.stderr), at.r.stderr);
  check("scan-completeness nudge: it names the remedy (chain the dependencies' reports) and promises VISIBILITY",
        /CANDOR_DEPS/.test(at.r.stderr) && /--workspace/.test(at.r.stderr)
          && /DETERMINED effects instead of being absent/.test(at.r.stderr), at.r.stderr);
  check("scan-completeness nudge: the conformance-matched ledger line is UNCHANGED beneath it",
        /classifier doesn't cover 1 package this code calls into/.test(at.r.stderr), at.r.stderr);
  // VERDICT-NEUTRALITY: the advisory is stderr-only, so a `--json` pipe stays pure JSON and the exit code
  // is whatever the analysis said (0 here — no gate configured). An advisory that broke `… | jq` would be
  // a worse bug than the blind spot it reports.
  const j = scan(callsInto(50), "--json");
  let env = null;
  try { env = JSON.parse(j.r.stdout); } catch { /* null → the check fails with the raw stdout */ }
  check("scan-completeness nudge: stdout stays PURE JSON while the advisory prints (stderr only)",
        env !== null && Array.isArray(env.functions) && !j.r.stdout.includes("hint — ")
          && /hint — 50 calls/.test(j.r.stderr) && j.r.status === 0,
        `status=${j.r.status} stdout=${j.r.stdout.slice(0, 120)}`);
}

// ── interface-CHA: a LOCAL interface dispatch resolves to its implementors (the Rust move) ────────
if (blk()) {
  const d = project({
    "src/store.ts": `import * as fsm from "node:fs";
export interface Store { save(q: string): void; }
export class FsStore implements Store {
  save(q: string): void { fsm.writeFileSync("/data/q", q); }
}
export interface Sink { flush(): void; }`,
    "src/app.ts": `import { Store, Sink } from "./store.js";
export function handle(store: Store): void { store.save("x"); }
export function orphan(k: Sink): void { k.flush(); }`,
  });
  const { report, cg } = scan(d);
  check("interface dispatch edges to the local implementor and carries the CONCRETE effect",
        cg["src.app.handle"]?.includes("src.store.FsStore.save")
        && entry(report, "src.app.handle")?.inferred.includes("Fs")
        && !entry(report, "src.app.handle")?.inferred.includes("Unknown"),
        JSON.stringify({ cg: cg["src.app.handle"], e: entry(report, "src.app.handle") }));
  check("an interface with NO implementor stays honest Unknown (canonical dispatch:Owner.member)",
        entry(report, "src.app.orphan")?.inferred.includes("Unknown")
        && entry(report, "src.app.orphan")?.unknownWhy?.some((w) => /^dispatch:.*\.Sink\.flush$/.test(w)),
        JSON.stringify(entry(report, "src.app.orphan")));
}

// ── SPEC §4's dividing line: `dispatch:` needs an OWNER TYPE **and** a MEMBER ─────────────────────
// "an unresolved virtual/interface dispatch with a resolvable owner type + member … every owner-less
// unresolved invocation is `callback:`" (SPEC §4), and `owner.member` is the vocabulary's one NORMATIVE
// detail — what conformance PART 10 compares and what the ⟨0.7⟩ dispatch-frontier resolves against the
// hierarchy sidecar. Each emission site used to substitute the literal words `type`/`member` for
// whichever half it could not name. Measured on a 15-repo corpus: 1,234 such emissions, every one from
// the interface-CHA arm, and they moved 695 functions into reason class `dispatch` where rust
// (`callback:unresolved call`), java (`callback:…Function.apply`) and swift (`callback:fn`) all say
// `indirect` for the same input. BOTH DIRECTIONS are asserted here, because the change NARROWS
// `deny Unknown[dispatch]` and a fixture that only shows the narrowing is the item-0 trap.
if (blk()) {
  const d = project({
    "package.json": `{"name":"vocab","version":"1.0.0"}`,
    "src/a.ts": `export interface Store { save(x: string): void; }
export interface UnaryFunction { (x: string): void; }
// KEEPS dispatch: a named interface, a named member, no implementor.
export function useStore(s: Store): void { s.save("x"); }
// A named type whose only content is a CALL SIGNATURE — there is no member to name, and invoking it is
// a function-VALUE call. The owner half survives in the callback: detail (best-effort, not normative).
export function useUnary(f: UnaryFunction): void { f("x"); }
// The mirror: a member of an ANONYMOUS type literal — the member is named, the owner is not.
const holder: { run(): void } = { run() {} };
export function useHolder(): void { holder.run(); }`,
  });
  const { report } = scan(d);
  const why = (fn) => entry(report, fn)?.unknownWhy ?? [];
  const noDispatch = (fn) => !why(fn).some((w) => w.startsWith("dispatch:"));
  check("§4 SECOND DIRECTION: a named interface member with no impl KEEPS dispatch:<owner>.<member>",
        why("src.a.useStore").includes("dispatch:src.a.Store.save"), JSON.stringify(why("src.a.useStore")));
  check("§4: a named CALL-SIGNATURE type has no member, so the reason is callback:, not dispatch:",
        why("src.a.useUnary").includes("callback:src.a.UnaryFunction") && noDispatch("src.a.useUnary"),
        JSON.stringify(why("src.a.useUnary")));
  check("§4: a member of an ANONYMOUS type literal has no owner, so it is callback: too",
        why("src.a.useHolder").includes("callback:run") && noDispatch("src.a.useHolder"),
        JSON.stringify(why("src.a.useHolder")));
  check("§4: no reason anywhere spells the placeholder words `type`/`member` in an owner.member slot",
        !report.functions.some((f) => (f.unknownWhy ?? []).some((w) => /^dispatch:(.*\.)?type\.|^dispatch:.*\.member$/.test(w))),
        JSON.stringify(report.functions.flatMap((f) => f.unknownWhy ?? [])));
  // THE GATE, both ways. Nothing goes silent — the Unknown and its trust marker are untouched; what
  // moves is which CLASS-TARGETED rule bites, and the same site is caught by Unknown[indirect].
  const gate = (rule) => {
    fs.writeFileSync(path.join(d, "g.pol"), `${rule}\n`);
    return scan(d, "--policy", path.join(d, "g.pol")).r.status;
  };
  check("§4 gate: `deny Unknown[dispatch]` STILL fires on the well-formed dispatch (exit 1)",
        gate("deny Unknown[dispatch,unresolved] src.a.useStore") === 1);
  check("§4 gate: ...and no longer fires on the owner-less call (exit 0)",
        gate("deny Unknown[dispatch,unresolved] src.a.useUnary") === 0);
  check("§4 gate: `deny Unknown[indirect]` fires there instead — the hole is still gated (exit 1)",
        gate("deny Unknown[indirect,unresolved] src.a.useUnary") === 1);
  check("§4 gate: and bare `deny Unknown` is unmoved, so nothing went silent (exit 1)",
        gate("deny Unknown src.a.useUnary") === 1);
}

// ── super-interface CHA (R47): a SUPER-method on a sub-interface value resolves precisely ──────────
if (blk()) {
  const d = project({
    "src/store.ts": `import * as fsm from "node:fs";
export interface Sup { base(): void; }
export interface Sub extends Sup { extra(): void; }
export class Impl implements Sub {
  base(): void { fsm.writeFileSync("/b", "x"); }
  extra(): void { fsm.writeFileSync("/e", "x"); }
}`,
    "src/app.ts": `import { Sub } from "./store.js";
export function callsSuper(s: Sub): void { s.base(); }
export function callsOwn(s: Sub): void { s.extra(); }`,
  });
  const { report } = scan(d);
  check("a SUPER-interface method on a sub-interface value resolves to the impl (Fs, not Unknown) — R47",
        entry(report, "src.app.callsSuper")?.inferred.includes("Fs")
        && !entry(report, "src.app.callsSuper")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.app.callsSuper")));
  check("the sub-interface's OWN method still resolves",
        entry(report, "src.app.callsOwn")?.inferred.includes("Fs"),
        JSON.stringify(entry(report, "src.app.callsOwn")));
}

// ── 11b. the CJS dist chain: a require()-style dep scanned with --allow-js chains the same way ────
if (blk()) {
  // the DEPENDENCY ships CJS: exports via assignment, not declarations (the jsonwebtoken shape).
  const dep = project({
    "package.json": `{"name": "old-school"}`,
    "sign.js": `const fs = require("node:fs");
module.exports = function (payload) { return fs.readFileSync("/key") + payload; };`,
    "index.js": `module.exports = { sign: require("./sign"), tag: (s) => s };`,
  });
  const depScan = scan(dep, "--allow-js");
  const signFn = entry(depScan.report, "sign.sign");
  check("a `module.exports = function` is a UNIT, named by its file, with the chainable hash",
        signFn?.inferred.includes("Fs") && signFn?.hash === "old-school#sign",
        JSON.stringify(depScan.report?.functions));
  check("a CJS export unit carries unitKind 'export' (spec 0.5 draft); TS fns omit the field",
        signFn?.unitKind === "export", JSON.stringify(signFn));

  // the CONSUMER sees only typings; CANDOR_DEPS carries the dist-JS scan across the boundary.
  const app = project({
    "package.json": `{"name": "shop2", "dependencies": {"old-school": "1.0.0"}}`,
    "node_modules/old-school/package.json": `{"name":"old-school","types":"index.d.ts","main":"index.js"}`,
    "node_modules/old-school/index.d.ts": `export declare function sign(p: string): string;`,
    "node_modules/old-school/index.js": ``,
    "src/use.ts": `import { sign } from "old-school";
export function stamp(): string { return sign("x"); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), app],
            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(dep, ".candor", "report.json") } });
  const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  check("the consumer inherits a CJS dep's effects through the chain",
        entry(rep, "src.use.stamp")?.inferred.includes("Fs"),
        JSON.stringify(rep.functions));
}

// ── /code-review fixes: ledger coverage, @types, CHA soundness, CJS join shapes ──────────────────
if (blk()) {
  // (a) chained coverage: a package with a loaded sibling report leaves the ledger even when the
  // called fn is PURE (omitted from the report) — and an all-pure EMPTY report counts via `package`.
  const dep = project({
    "package.json": `{"name": "pure-utils"}`,
    "src/u.ts": `export function pad(s: string): string { return s + " "; }`,
  });
  scan(dep); // all-pure: zero entries, but the envelope carries package: pure-utils
  const app = project({
    "package.json": `{"name": "app3", "dependencies": {"pure-utils": "1.0.0"}}`,
    "node_modules/pure-utils/package.json": `{"name":"pure-utils","types":"index.d.ts","main":"index.js"}`,
    "node_modules/pure-utils/index.d.ts": `export declare function pad(s: string): string;`,
    "node_modules/pure-utils/index.js": ``,
    "src/a.ts": `import { pad } from "pure-utils";
import * as fsm from "node:fs";
export function go(): string { fsm.readFileSync("/x"); return pad("hi"); }`,
  });
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app],
                      { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(dep, ".candor", "report.json") } });
  check("an all-pure dep's EMPTY report covers its package (no ledger entry)",
        !/pure-utils/.test(r.stderr), r.stderr);
}
if (blk()) {
  // (b) @types: a KAPPA_PURE package typed via DefinitelyTyped is NOT disclosed
  const d = project({
    "node_modules/lodash/package.json": `{"name":"lodash","main":"index.js"}`,
    "node_modules/lodash/index.js": `module.exports.chunk = (s) => s;`,
    "node_modules/@types/lodash/package.json": `{"name":"@types/lodash","types":"index.d.ts"}`,
    "node_modules/@types/lodash/index.d.ts": `export declare function chunk(s: string): string;`,
    "src/a.ts": `import { chunk } from "lodash";
import * as fsm from "node:fs";
export function go(): string { fsm.readFileSync("/x"); return chunk("ab"); }`,
  });
  const { r } = scan(d);
  check("a reviewed-pure package typed via @types stays out of the ledger",
        !/lodash/.test(r.stderr), r.stderr);
}
if (blk()) {
  // (c) CHA soundness: an implementor whose member is INHERITED keeps the Unknown (no silent drop)
  const d = project({
    "src/s.ts": `import * as fsm from "node:fs";
export interface Store { save(q: string): void; }
export class Base { save(q: string): void { fsm.writeFileSync("/d", q); } }
export class PgStore extends Base implements Store {}
export class MemStore implements Store { save(q: string): void { /* pure */ } }`,
    "src/a.ts": `import { Store } from "./s.js";
export function handle(store: Store): void { store.save("x"); }`,
  });
  const { report } = scan(d);
  const h = entry(report, "src.a.handle");
  check("a partially-resolved interface dispatch keeps honest Unknown",
        h?.inferred.includes("Unknown"), JSON.stringify(h));
}
if (blk()) {
  // (d) merged interface declarations: the impl registers under BOTH blocks
  const d = project({
    "src/s.ts": `import * as fsm from "node:fs";
export interface Store { save(q: string): void; }
export interface Store { flush(): void; }
export class FsStore implements Store {
  save(q: string): void { fsm.writeFileSync("/d", q); }
  flush(): void { fsm.writeFileSync("/d", ""); }
}`,
    "src/a.ts": `import { Store } from "./s.js";
export function fin(store: Store): void { store.flush(); }`,
  });
  const { report, cg } = scan(d);
  check("a merged interface's second block still CHA-resolves",
        cg["src.a.fin"]?.includes("src.s.FsStore.flush")
        && entry(report, "src.a.fin")?.inferred.includes("Fs")
        && !entry(report, "src.a.fin")?.inferred.includes("Unknown"),
        JSON.stringify({ cg: cg["src.a.fin"], e: entry(report, "src.a.fin") }));
}
if (blk()) {
  // (e) CJS join shapes: interface-shaped typings (Owner.member) + quoted export keys both join
  const dep = project({
    "package.json": `{"name": "legacy-sign"}`,
    "index.js": `const fs = require("node:fs");
module.exports = { "sign": function (p) { return fs.readFileSync("/k") + p; } };`,
  });
  const depScan = scan(dep, "--allow-js");
  check("a QUOTED export key hashes clean (pkg#sign, not pkg#\"sign\")",
        entry(depScan.report, "index.sign")?.hash === "legacy-sign#sign",
        JSON.stringify(depScan.report?.functions));
  const app = project({
    "package.json": `{"name": "app4", "dependencies": {"legacy-sign": "1.0.0"}}`,
    "node_modules/legacy-sign/package.json": `{"name":"legacy-sign","types":"index.d.ts","main":"index.js"}`,
    "node_modules/legacy-sign/index.d.ts": `export interface Signer { sign(p: string): string; }
declare const s: Signer;
export = s;`,
    "node_modules/legacy-sign/index.js": ``,
    "src/u.ts": `import s = require("legacy-sign");
export function stamp(): string { return s.sign("x"); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), app],
            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(dep, ".candor", "report.json") } });
  const rep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  check("interface-shaped typings join via the bare-member fallback",
        entry(rep, "src.u.stamp")?.inferred.includes("Fs"), JSON.stringify(rep.functions));
}

// ── solution-style tsconfig (files: [] + references) — the hono shape ─────────────────────────────
if (blk()) {
  const d = project({
    "tsconfig.json": `{"files": [], "references": [{"path": "./tsconfig.build.json"}]}`,
    "tsconfig.build.json": `{"compilerOptions": {"target": "es2022", "moduleResolution": "bundler", "module": "esnext", "types": []}, "include": ["src/**/*.ts"]}`,
    "src/a.ts": `import * as fsm from "node:fs";
export function r(): Buffer { return fsm.readFileSync("/x"); }`,
  });
  const { report } = scan(d);
  check("a solution-style tsconfig follows its references (the hono shape)",
        entry(report, "src.a.r")?.inferred.includes("Fs"), JSON.stringify(report?.functions));
}

// ── --agents: the self-describing engine (the contract ships in the tarball) ──────────────────────
if (blk()) {
  const doc = fs.readFileSync(path.join(HERE, "AGENTS.md"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  for (const bin of ["scan.mjs", "query.mjs"]) {
    const out = execFileSync(process.execPath, [path.join(HERE, bin), "--agents"], { encoding: "utf8" });
    check(`--agents (${bin}) prints the version header + the exact installed contract`,
          out.startsWith(`<!-- candor-ts ${pkg.version}`) && out.endsWith(doc), out.slice(0, 120));
  }
  check("the npm tarball ships AGENTS.md (files allowlist)", pkg.files.includes("AGENTS.md"));
  // --agents must NOT fire when it is the VALUE of --out (a scripted gate `--out $PREFIX` where
  // $PREFIX expanded to --agents) — that exits 0 having scanned nothing.
  const asValue = spawnSync("node", [path.join(HERE, "scan.mjs"), ".", "--out", "--agents"], { encoding: "utf8" });
  check("--agents as the VALUE of --out fails (not a print-and-exit hijack)",
        asValue.status === 2 && !asValue.stdout.includes("Using candor-ts"), asValue.stdout.slice(0, 80));
  // a KNOWN flag given BEFORE the target must not produce a lying "unknown flag" error.
  const flagFirst = spawnSync("node", [path.join(HERE, "scan.mjs"), "--allow-js", "/nonexistent-xyz"], { encoding: "utf8" });
  check("a known flag before the target is accepted (no lying 'unknown flag')",
        !(flagFirst.stderr || "").includes("unknown flag --allow-js"), flagFirst.stderr?.slice(0, 100));
  // ONE version source: the envelope version equals the --agents banner version (package.json).
  const banner = execFileSync(process.execPath, [path.join(HERE, "scan.mjs"), "--agents"], { encoding: "utf8" }).split("\n")[0];
  check("envelope version is single-sourced from package.json (no drift vs the banner)",
        banner.includes(`candor-ts ${pkg.version}`), banner);
}

// unitKind 'export' is PER-UNIT: a same-named ordinary TS function in another file is not mislabeled
if (blk()) {
  const d = project({
    "package.json": `{"name": "mix"}`,
    "dist/util.js": `const fs = require("node:fs");\nmodule.exports.sign = function () { return fs.readFileSync("/k"); };`,
    "src/crypto.ts": `export function sign(): number { return Date.now(); }`,
  });
  const { report } = scan(d, "--allow-js");
  const tsSign = report.functions.find((e) => e.fn === "src.crypto.sign");
  const jsSign = report.functions.find((e) => e.unitKind === "export");
  check("the CJS export is tagged unitKind:export, the same-named TS function is NOT",
        jsSign && tsSign && tsSign.unitKind === undefined, JSON.stringify({ tsSign, jsSign }));
}

// ── effect manifest (SPEC §5.1): a package's package.json candorEffects is the declared tier ──────
if (blk()) {
  const pkg = (effects) => ({
    "app.ts": `import { send } from "mylib";\nexport function f(): void { send(); }`,
    "node_modules/mylib/package.json": JSON.stringify({ name: "mylib", version: "1.0.0", types: "index.d.ts", main: "index.js", candorEffects: effects }),
    "node_modules/mylib/index.d.ts": `export declare function send(): void;`,
    "node_modules/mylib/index.js": `module.exports={send(){}};`,
  });
  const { report } = scan(project(pkg(["Net"])));
  check("effect manifest: a declared candorEffects classifies the otherwise-uncurated package (Net)",
        entry(report, "app.f")?.inferred.includes("Net"), JSON.stringify(report?.functions));
  // a typo'd effect name VOIDS the declaration loudly — never silently narrow on garbage (SPEC §5.1)
  const { report: rep2, r: r2 } = scan(project(pkg(["net"])));
  // the voided declaration makes mylib a blind spot: f stays pure (send not classified) but is now
  // DISCLOSED with `invisible:["mylib"]` (not silently omitted), and the warning still fires.
  const fVoid = entry(rep2, "app.f");
  check("effect manifest: a typo'd effect name voids the declaration (f pure + mylib disclosed invisible) and warns",
        fVoid?.inferred.length === 0 && fVoid?.invisible?.includes("mylib")
          && /candorEffects has an invalid effect/.test(r2.stderr), r2.stderr);
  // candorEffects: [] is an explicit "declared pure" — covered, NOT a coverage blind spot
  const { r: r3 } = scan(project(pkg([])));
  check("effect manifest: candorEffects:[] is declared-pure (covered), not a blind spot",
        !/doesn't cover[^\n]*mylib/.test(r3.stderr), r3.stderr);
  // a non-array candorEffects is malformed → warned and ignored, never silently
  const { r: r4 } = scan(project({ ...pkg([]), "node_modules/mylib/package.json": JSON.stringify({ name: "mylib", version: "1.0.0", types: "index.d.ts", main: "index.js", candorEffects: "Net" }) }));
  check("effect manifest: a non-array candorEffects is warned and ignored (not silent)",
        /candorEffects must be an array/.test(r4.stderr), r4.stderr);
}

// ── Exec-cliff refinement (SPEC §4 ⟨0.5⟩): the head is argv[0]; a literal ARGUMENT must not refine ─
if (blk()) {
  const d = project({ "cmd.ts":
      `import { spawn, execSync } from "child_process";\n` +
      `export function litProg(): void { execSync("curl http://x"); }\n` +       // legit: curl IS argv[0]
      `export function litArr(): void { spawn("psql", ["-c", "q"]); }\n` +        // legit: psql is argv[0]
      `export function varHead(tool: string): void { spawn(tool, "curl"); }\n` }); // trap: dynamic program
  const { report } = scan(d);
  check("Exec-refine: a literal program head (argv[0]) refines the cliff (curl → Net)",
        entry(report, "cmd.litProg")?.inferred.includes("Net"), JSON.stringify(entry(report, "cmd.litProg")));
  check("Exec-refine: a literal head as element 0 of the args array refines (psql → Db)",
        entry(report, "cmd.litArr")?.inferred.includes("Db"), JSON.stringify(entry(report, "cmd.litArr")));
  // the trap: program is a runtime variable, "curl" is a trailing ARGUMENT — must NOT fabricate Net
  check("Exec-refine: a dynamic program with a trailing 'curl' literal does NOT fabricate Net (argv[0] gate)",
        entry(report, "cmd.varHead")?.inferred.includes("Exec") && !entry(report, "cmd.varHead")?.inferred.includes("Net"),
        JSON.stringify(entry(report, "cmd.varHead")));
}

// ── concurrency: the report is written ATOMICALLY (no mid-write truncation window) ────────────────
// The recommended agent setup runs candor-ts-watch (re-scans on edit) alongside the MCP server /
// query (reads the report). An in-place write would let a reader observe a half-written file and
// throw on JSON.parse; an atomic temp+rename guarantees old-or-new-whole. We assert the rename
// discipline by its observable side effect: the scan leaves NO `.tmp` turds and writes valid JSON.
if (blk()) {
  const d = project({ "app.ts": `import * as fsm from "node:fs";\nexport function f(): void { fsm.readFileSync("/x"); }` });
  const { prefix } = scan(d);
  const leftovers = fs.readdirSync(path.dirname(prefix)).filter((n) => n.includes(".tmp"));
  check("atomic write: scan leaves no .tmp leftovers (temp file was renamed into place)",
        leftovers.length === 0, leftovers.join());
  // the written report is parseable as a whole (the post-rename invariant a concurrent reader relies on)
  let parsed = true; try { JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")); JSON.parse(fs.readFileSync(`${prefix}.callgraph.json`, "utf8")); } catch { parsed = false; }
  check("atomic write: the written report and callgraph are whole, valid JSON", parsed);
}

// ── a corrupt SIBLING report is DISCLOSED, not silently dropped (never-silently-pure) ─────────────
// loadReport merges sibling reports (the Rust/workspace form). A malformed sibling must WARN and be
// omitted loudly — silently skipping it would make its effectful functions read as "no effect".
if (blk()) {
  const Q = await import("./query-core.mjs");
  const d = scratch("candor-ts-corrupt-");
  // two siblings under one prefix: one valid (effectful), one truncated mid-object
  fs.writeFileSync(path.join(d, "rep.good.scan.json"), JSON.stringify({ candor: { version: "x" }, functions: [{ fn: "g.net", inferred: ["Net"], direct: ["Net"] }] }));
  fs.writeFileSync(path.join(d, "rep.bad.scan.json"), `{ "candor": { "version": "x" }, "functions": [ { "fn": "b.`);
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(String(m));
  let fns; try { fns = Q.loadReport(path.join(d, "rep")); } finally { console.error = orig; }
  check("corrupt sibling: the VALID sibling's functions still load (one bad file doesn't kill the query)",
        fns.some((e) => e.fn === "g.net"), JSON.stringify(fns));
  check("corrupt sibling: the malformed report is DISCLOSED on stderr, not silently dropped",
        errs.some((m) => /failed to parse/.test(m) && /rep\.bad\.scan\.json/.test(m)), errs.join("\n"));
}

// ── node-builtin net cluster: inert CONSTRUCTION is pure, the request/connect/listen surface is Net ─
// The κ rule for net/http/https/tls/http2 was once whole-module (`[regex, null, "Net"]`), painting
// Net onto provably-pure members: `new http.Agent()` is a connection-pool CONFIG object (no I/O until
// a request uses it), `new http.Server()`/`new net.Socket()` open nothing until `.listen()`/`.connect()`.
// That is FABRICATION — the precision failure, the opposite direction from candor's cardinal sin (the
// silent under-report). The rule is now member-aware: construction (token "new")
// is pure; every function/verb member keeps Net (so an unlisted effectful call never under-reports).
// Both directions pinned here (the standalone fabrication_probe.mjs is the broader generative guard).
if (blk()) {
  const d = project({
    "src/n.ts": `import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
// PURE — inert construction (config/connection-pool/socket objects; no fd, no syscall):
export function pureAgent(): void { const x = new http.Agent(); void x; }
export function pureHttpServer(): void { const x = new http.Server(); void x; }
export function pureSocket(): void { const x = new net.Socket(); void x; }
// PURE — the string VALIDATORS: net.isIP/isIPv4/isIPv6 parse a string and return 0/4/6 (or a bool);
// no socket, no fd, no syscall. The whole-module Net rule once fabricated Net here (a node-fetch sweep
// caught it: trustworthy URL predicates call isIP and inherited a phantom Net — a fabrication):
export function pureIsIP(): void { const x = net.isIP("1.2.3.4"); void x; }
export function pureIsIPv4(): void { const x = net.isIPv4("1.2.3.4"); void x; }
export function pureIsIPv6(): void { const x = net.isIPv6("::1"); void x; }
// EFFECTFUL — the request/connect/listen surface + I/O verbs (must keep Net):
export function effRequest(): void { const x = http.request("http://h/"); void x; }
export function effGet(): void { const x = http.get("http://h/"); void x; }
export function effNetConnect(): void { const x = net.connect(80, "h"); void x; }
export function effCreateServer(): void { const x = net.createServer(); void x; }
export function effTlsConnect(): void { const x = tls.connect(443, "h"); void x; }
export function effSocketConnect(s: net.Socket): void { const x = s.connect(80, "h"); void x; }
// RAW-SOCKET regression pins (four-way): the low-level socket surface must classify Net. The chained
// \`new net.Socket().connect()\` form (construction is inert, but the .connect() I/O verb is the network
// boundary) and net.createConnection (an alias of net.connect) — both are the raw socket, both are Net.
export function effRawSocketConnect(): void { const x = new net.Socket().connect(80, "h"); void x; }
export function effCreateConnection(): void { const x = net.createConnection(80, "h"); void x; }
export function effServerListen(srv: http.Server): void { const x = srv.listen(80); void x; }
// CONNECTING constructor — NOT inert: new http.ClientRequest(url) performs the network I/O on
// construction (it is what http.request() returns and dispatches). The blanket new-exemption once
// converted this real Net source into pure (a cardinal-sin under-report); it must keep Net.
export function effClientRequest(): void { const x = new http.ClientRequest("http://h/"); void x; }`,
  });
  const { report } = scan(d);
  const isPure = (fn) => !entry(report, fn) || (entry(report, fn).inferred ?? []).length === 0;
  const isNet = (fn) => entry(report, fn)?.inferred.includes("Net");
  // pure direction — no fabrication
  check("net-cluster: new http.Agent() is PURE (inert config object, no I/O)", isPure("src.n.pureAgent"),
        JSON.stringify(entry(report, "src.n.pureAgent")));
  check("net-cluster: new http.Server() is PURE (listens to nothing until .listen())", isPure("src.n.pureHttpServer"),
        JSON.stringify(entry(report, "src.n.pureHttpServer")));
  check("net-cluster: new net.Socket() is PURE (no fd until .connect())", isPure("src.n.pureSocket"),
        JSON.stringify(entry(report, "src.n.pureSocket")));
  // the pure VALIDATORS — net.isIP/isIPv4/isIPv6 are string parsers, NOT I/O (the node-fetch fabrication)
  check("net-cluster: net.isIP() is PURE (string validator, no socket/fd/syscall)", isPure("src.n.pureIsIP"),
        JSON.stringify(entry(report, "src.n.pureIsIP")));
  check("net-cluster: net.isIPv4() is PURE (string validator, no I/O)", isPure("src.n.pureIsIPv4"),
        JSON.stringify(entry(report, "src.n.pureIsIPv4")));
  check("net-cluster: net.isIPv6() is PURE (string validator, no I/O)", isPure("src.n.pureIsIPv6"),
        JSON.stringify(entry(report, "src.n.pureIsIPv6")));
  // effectful direction — no lost control
  check("net-cluster: http.request() reports Net", isNet("src.n.effRequest"), JSON.stringify(entry(report, "src.n.effRequest")));
  check("net-cluster: http.get() reports Net", isNet("src.n.effGet"), JSON.stringify(entry(report, "src.n.effGet")));
  check("net-cluster: net.connect() reports Net", isNet("src.n.effNetConnect"), JSON.stringify(entry(report, "src.n.effNetConnect")));
  check("net-cluster: net.createServer() reports Net", isNet("src.n.effCreateServer"), JSON.stringify(entry(report, "src.n.effCreateServer")));
  check("net-cluster: tls.connect() reports Net", isNet("src.n.effTlsConnect"), JSON.stringify(entry(report, "src.n.effTlsConnect")));
  check("net-cluster: socket.connect() (I/O verb) reports Net", isNet("src.n.effSocketConnect"), JSON.stringify(entry(report, "src.n.effSocketConnect")));
  // raw-socket regression pins — the low-level socket surface must never silently regress off Net.
  check("net-cluster: new net.Socket().connect() (raw socket) reports Net", isNet("src.n.effRawSocketConnect"), JSON.stringify(entry(report, "src.n.effRawSocketConnect")));
  check("net-cluster: net.createConnection() (raw socket) reports Net", isNet("src.n.effCreateConnection"), JSON.stringify(entry(report, "src.n.effCreateConnection")));
  check("net-cluster: server.listen() (I/O verb) reports Net", isNet("src.n.effServerListen"), JSON.stringify(entry(report, "src.n.effServerListen")));
  // the connecting-ctor control: the regression that motivated the connecting-ctor carve-out — and
  // that the inert ctors above MUST stay pure alongside it (the fix removes the bug, not the feature).
  check("net-cluster: new http.ClientRequest() (CONNECTING ctor) reports Net (not freed by the new-exemption)",
        isNet("src.n.effClientRequest"), JSON.stringify(entry(report, "src.n.effClientRequest")));
}

// ── a corrupt/null PRIMARY callgraph is DISCLOSED+tolerated, never an uncaught crash ───────────────
// loadCallgraph once parsed the primary `<prefix>.callgraph.json` with a bare JSON.parse and an
// unguarded Object.entries (asymmetric with loadReport's primary path and with its OWN sibling-merge
// path below). A corrupt or `null` primary callgraph threw an uncaught SyntaxError / "Cannot convert
// null to object" — the CLI died with a raw stack trace. The loader must disclose a corrupt graph on
// stderr (κ-ledger ethos) and return an empty graph rather than crash; a `null`/non-object parse
// must never reach Object.entries.
if (blk()) {
  const Q = await import("./query-core.mjs");
  const d = scratch("candor-ts-cgcorrupt-");
  // corrupt (truncated) primary callgraph
  fs.writeFileSync(path.join(d, "rep.callgraph.json"), `{ "a.f": [ "a.g`);
  let errs = [], cg, threw = false;
  let orig = console.error; console.error = (m) => errs.push(String(m));
  try { cg = Q.loadCallgraph(path.join(d, "rep")); } catch { threw = true; } finally { console.error = orig; }
  check("corrupt primary callgraph: loadCallgraph does NOT crash (returns a graph)", !threw && cg && typeof cg === "object", String(threw));
  check("corrupt primary callgraph: an empty graph is returned (tolerated, not partial junk)", cg && Object.keys(cg).length === 0, JSON.stringify(cg));
  check("corrupt primary callgraph: the corruption is DISCLOSED on stderr (κ-ledger ethos)",
        errs.some((m) => /failed to parse/.test(m) && /rep\.callgraph\.json/.test(m)), errs.join("\n"));
  // a `null` primary callgraph parses fine but must NOT reach Object.entries
  fs.writeFileSync(path.join(d, "rep.callgraph.json"), `null`);
  errs = []; threw = false; orig = console.error; console.error = (m) => errs.push(String(m));
  try { cg = Q.loadCallgraph(path.join(d, "rep")); } catch { threw = true; } finally { console.error = orig; }
  check("null primary callgraph: loadCallgraph does NOT crash on Object.entries(null)", !threw && cg && Object.keys(cg).length === 0, String(threw));
  // a VALID primary callgraph still loads identically (the fix must not break the happy path)
  fs.writeFileSync(path.join(d, "rep.callgraph.json"), JSON.stringify({ "a.f": ["a.g"], "a.g": [] }));
  const good = Q.loadCallgraph(path.join(d, "rep"));
  check("valid primary callgraph: loads identically (edges preserved, non-array values normalized)",
        JSON.stringify(good) === JSON.stringify({ "a.f": ["a.g"], "a.g": [] }), JSON.stringify(good));
}

// ── decorator-factory effects must NOT be FABRICATED onto the decorated unit (fabrication) ───────
if (blk()) {
  const d = project({
    "src/d.ts": `import cp from "node:child_process";
function logged(_a: string) { cp.execSync("ls"); return function (_t:any,_k:string,_d:PropertyDescriptor){}; }
function classDec(_a: string) { cp.execSync("ls"); return function (c:any){return c;}; }
class C { @logged("hi") pure(): number { return 1; } }
@classDec("x") class D { run(): number { return 2; } }
export function callsPure(c: C): number { return c.pure(); }
export function makesD(): D { return new D(); }
export function callsFactory(): void { logged("z"); }`,
  });
  const { report } = scan(d);
  check("decorator factory does NOT fabricate onto the decorated method",
        !entry(report, "src.d.C.pure")?.inferred.length, JSON.stringify(entry(report, "src.d.C.pure")));
  check("decorator fabrication does not propagate to callers",
        !entry(report, "src.d.callsPure")?.inferred.length, JSON.stringify(entry(report, "src.d.callsPure")));
  check("class decorator does NOT fabricate onto the constructor",
        !entry(report, "src.d.makesD")?.inferred.length, JSON.stringify(entry(report, "src.d.makesD")));
  // but the factory's OWN effect (and a genuine call to it) is still captured — no lost control
  check("decorator factory body still reports its effect",
        entry(report, "src.d.logged")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.d.logged")));
  check("a genuine call to the factory still propagates",
        entry(report, "src.d.callsFactory")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.d.callsFactory")));
}

// a fn-reference passed to a STORE/compare/log sink (not an invoking HOF) must NOT fabricate its effect
if (blk()) {
  const d = project({
    "src/h.ts": `import { readFileSync } from "node:fs";
function eff(): string { return readFileSync("/h", "utf8"); }
const reg = new Map<string, Function>();
export function stores() { reg.set("a", eff); }
export function includesIt(a: Function[]) { return a.includes(eff); }
export function logs() { console.log(eff); }
export function invokesMap(xs: number[]) { return xs.map(eff); }`,
  });
  const { report } = scan(d);
  check("HOF-ref: a fn stored (not invoked) does NOT fabricate its effect",
        !entry(report, "src.h.stores")?.inferred.length, JSON.stringify(entry(report, "src.h.stores")));
  check("HOF-ref: a fn passed to includes/log does NOT fabricate",
        !entry(report, "src.h.includesIt")?.inferred.length && !entry(report, "src.h.logs")?.inferred.length);
  check("HOF-ref: a fn passed to an INVOKING HOF (map) still propagates",
        entry(report, "src.h.invokesMap")?.inferred.includes("Fs"));
}

// ── sync-callback-invoker: an OPAQUE callback to a sync HOF (forEach/map/…) must disclose Unknown ────
// A `(x)=>void` PARAMETER (or an `any`-typed callable) handed to `Array.prototype.forEach` & friends is
// INVOKED by the HOF — but the es-lib signature resolved the CALLEE, so the reference dropped silent-pure
// (`arr.forEach(cb)` read PURE though `cb` runs caller-supplied code — the cardinal sin). This is the TS
// arm of a four-way sync-callback-invoker parity fix (candor-java shipped it as c755acd / SYNC_CALLBACK_
// INVOKERS). CRUCIAL GUARD: only OPAQUE callbacks disclose — an INLINE arrow keeps its analyzed effect and
// a resolvable NAMED fn keeps its resolved effect (no flood of the overwhelming-majority inline shape).
if (blk()) {
  const d = project({
    "src/cb.ts": `import * as fs from "fs";
export function knownPure(x: number): number { return x + 1; }
export function knownEffect(): void { fs.writeFileSync("/tmp/x", "y"); }
// BUG fixed: opaque callback to a sync HOF → Unknown (was silent-pure).
export function opaqueForEach(cb: (x: number) => void): void { [1, 2, 3].forEach(cb); }
export function opaqueMap(cb: (x: number) => number): number[] { return [1, 2, 3].map(cb); }
export function opaqueReduce(cb: (a: number, x: number) => number): number { return [1, 2, 3].reduce(cb, 0); }
export function anyCallback(cb: any): void { [1, 2, 3].forEach(cb); }
// NO-OVER-DISCLOSURE controls: inline arrow keeps its real effect (Fs), a pure inline stays pure,
// a resolvable named callback keeps its resolved effect, and a non-callback arg (reduce's initial value,
// sort with no callback) never fabricates.
export function inlineEffect(): void { [1, 2, 3].forEach((x) => fs.writeFileSync("/tmp/x", String(x))); }
export function inlinePure(): void { [1, 2, 3].forEach((x) => { const y = x + 1; void y; }); }
export function namedResolvable(): void {
  function helper(x: number) { fs.writeFileSync("/tmp/x", String(x)); }
  [1, 2, 3].forEach(helper);
}
export function sortNoCallback(): number[] { return [3, 1, 2].sort(); }`,
  });
  const { report } = scan(d);
  // THE FIX — opaque callbacks disclose Unknown (never silent-pure).
  check("sync-HOF: opaque forEach callback discloses Unknown (was silent-pure)",
        entry(report, "src.cb.opaqueForEach")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.opaqueForEach")));
  check("sync-HOF: opaque map callback discloses Unknown",
        entry(report, "src.cb.opaqueMap")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.opaqueMap")));
  check("sync-HOF: opaque reduce callback discloses Unknown (the `0` initial value is NOT a callback)",
        entry(report, "src.cb.opaqueReduce")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.opaqueReduce")));
  check("sync-HOF: an `any`-typed callback discloses Unknown (could hold a function)",
        entry(report, "src.cb.anyCallback")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.anyCallback")));
  // THE GUARD — no over-disclosure (must NOT trade the cardinal sin for its fabrication mirror).
  check("sync-HOF: an INLINE-arrow forEach still carries its real effect (Fs, not flooded to Unknown)",
        entry(report, "src.cb.inlineEffect")?.inferred.includes("Fs")
        && !entry(report, "src.cb.inlineEffect")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.inlineEffect")));
  check("sync-HOF: a PURE inline-arrow forEach stays pure (no over-disclosure)",
        entry(report, "src.cb.inlinePure") === undefined, JSON.stringify(entry(report, "src.cb.inlinePure")));
  check("sync-HOF: a RESOLVABLE named callback keeps its resolved effect (Fs), not Unknown",
        entry(report, "src.cb.namedResolvable")?.inferred.includes("Fs")
        && !entry(report, "src.cb.namedResolvable")?.inferred.includes("Unknown"),
        JSON.stringify(entry(report, "src.cb.namedResolvable")));
  check("sync-HOF: sort() with NO callback stays pure (no fabrication)",
        entry(report, "src.cb.sortNoCallback") === undefined, JSON.stringify(entry(report, "src.cb.sortNoCallback")));
}

// ── sync-callback-invoker: over-disclosure guards found by A/B on real code (zod) ────────────────────
// Two false-positive shapes the first cut hit on zod, both now gated: a pure GLOBAL builtin passed as the
// callback (`.filter(Boolean)` / `.map(String)` — coercion globals are pure, decl in lib.es5.d.ts, not
// opaque), and a NON-callback positional whose type is `any` (`path.reduce(fn, obj)` — the `obj` SEED is
// arg 1, never the invoked fn). Both must stay PURE; a genuine opaque callback in the SAME file still fires.
if (blk()) {
  const d = project({
    "src/g.ts": `import * as fs from "fs";
// pure global builtins as callbacks — must stay pure (not Unknown).
export function filterBoolean(xs: (string | undefined)[]): string[] { return xs.filter(Boolean) as string[]; }
export function mapString(xs: number[]): string[] { return xs.map(String); }
export function mapNumber(xs: string[]): number[] { return xs.map(Number); }
// reduce with an \`any\`-typed SEED at arg 1 (inline callback at arg 0) — seed is NOT the invoked fn.
export function reduceAnySeed(obj: any, path: string[]): any { return path.reduce((acc, k) => acc?.[k], obj); }
// CONTROL — a genuine opaque callback param in the same file STILL discloses Unknown.
export function stillFires(cb: (x: number) => void): void { [1, 2].forEach(cb); }`,
  });
  const { report } = scan(d);
  check("sync-HOF: .filter(Boolean) stays pure (pure global builtin, not opaque)",
        entry(report, "src.g.filterBoolean") === undefined, JSON.stringify(entry(report, "src.g.filterBoolean")));
  check("sync-HOF: .map(String) / .map(Number) stay pure (coercion globals)",
        entry(report, "src.g.mapString") === undefined && entry(report, "src.g.mapNumber") === undefined,
        JSON.stringify([entry(report, "src.g.mapString"), entry(report, "src.g.mapNumber")]));
  check("sync-HOF: reduce's `any`-typed SEED (arg 1) is NOT flagged as a callback",
        entry(report, "src.g.reduceAnySeed") === undefined, JSON.stringify(entry(report, "src.g.reduceAnySeed")));
  check("sync-HOF: a genuine opaque callback in the same file STILL fires (guards didn't over-suppress)",
        entry(report, "src.g.stillFires")?.inferred.includes("Unknown"), JSON.stringify(entry(report, "src.g.stillFires")));
}

// ── Object.defineProperty runtime-accessor: a descriptor get/set is invisible to the TS checker (it
// types target.key as a DATA prop), so a forcing site `target.key` read silent-pure — the cardinal sin.
// FIX = mint the descriptor body as a unit + edge the forcing site to it (precise when target+key pin),
// else disclose Unknown (computed key). Controls pin no-fabrication (pure getter / value descriptor).
if (blk()) {
  const d = project({
    "src/a.ts": `import { execSync } from "node:child_process";
import fs from "node:fs";
export const config: { token: string } = {} as any;
Object.defineProperty(config, "token", {
  configurable: true,
  get() { const v = execSync("vault read -field=token secret/app").toString();
          Object.defineProperty(config, "token", { value: v }); return v; }
});
export function readToken(): string { return config.token; }

// setter variant
export const sink: { k: string } = {} as any;
Object.defineProperty(sink, "k", { set(v: string) { fs.writeFileSync("/tmp/z", v); } });
export function write(): void { sink.k = "hi"; }

// defineProperties (multiple) + a value descriptor among them
export const multi: { a: string; b: string } = {} as any;
Object.defineProperties(multi, {
  a: { get() { return execSync("netstat").toString(); } },
  b: { value: "x" },
});
export function readA(): string { return multi.a; }
export function readB(): string { return multi.b; }

// computed key on a known target — can't pin the key → honest Unknown disclosure
export const dyn: Record<string, string> = {} as any;
const kk = "secret";
Object.defineProperty(dyn, kk, { get() { return execSync("id").toString(); } });
export function readDyn(): string { return dyn.secret; }

// NO-FABRICATION controls: a pure getter, and a value (data) descriptor — both stay pure.
export const pure: { k: number } = {} as any;
Object.defineProperty(pure, "k", { get() { return 1 + 1; } });
export function readPure(): number { return pure.k; }
export const dataOnly: { k: number } = {} as any;
Object.defineProperty(dataOnly, "k", { value: 42 });
export function readData(): number { return dataOnly.k; }`,
  });
  const { report } = scan(d);
  check("defineProperty getter: forcing site carries the precise effect (Exec), not silent-pure",
        entry(report, "src.a.readToken")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.a.readToken")));
  check("defineProperty setter: assignment site carries the setter's effect (Fs)",
        entry(report, "src.a.write")?.inferred.includes("Fs"), JSON.stringify(entry(report, "src.a.write")));
  check("defineProperties: a getter member propagates (Exec)",
        entry(report, "src.a.readA")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.a.readA")));
  check("defineProperties: a value member among them does NOT fabricate (readB pure)",
        entry(report, "src.a.readB") === undefined, JSON.stringify(entry(report, "src.a.readB")));
  check("defineProperty computed key: forcing site discloses Unknown (never silent-pure)",
        entry(report, "src.a.readDyn")?.inferred.includes("Unknown"), JSON.stringify(entry(report, "src.a.readDyn")));
  check("NO-FABRICATION: a pure defineProperty getter stays pure",
        entry(report, "src.a.readPure") === undefined, JSON.stringify(entry(report, "src.a.readPure")));
  check("NO-FABRICATION: a value (data) descriptor stays pure",
        entry(report, "src.a.readData") === undefined, JSON.stringify(entry(report, "src.a.readData")));
}

// ── opaque-iterable force: a param/any/type-param iterable runs caller-supplied iterator code ──────
// (epistemically identical to invoking an opaque callback → Unknown, never silent-pure). PRESERVE
// concrete built-in iteration (array/string/Map → pure) and LOCAL generators (real effect propagates).
if (blk()) {
  const d = project({
    "src/it.ts": `import * as fs from "fs";
// BUG fixed: forcing an OPAQUE iterable/iterator parameter must disclose Unknown (was silent-pure).
export function collect<T>(source: Iterable<T>): T[] { const o: T[] = []; for (const x of source) o.push(x); return o; }
export function spreads<T>(xs: Iterable<T>): T[] { return [...xs]; }
export function nexts<T>(it: Iterator<T>): void { it.next(); }
export function fromParam(xs: Iterable<number>): number[] { return Array.from(xs); }
export function destrParam(xs: Iterable<number>): number { const [a] = xs; return a as number; }
export function anyIter(x: any): void { for (const v of x) { void v; } }
// CONTROL — opaque callback (already correct): Unknown.
export function callsParam(f: () => void): void { f(); }
// NO-REGRESSION — concrete built-in iterables run NO user code → stay PURE.
export function arrIter(): number[] { const a = [1, 2, 3]; const o: number[] = []; for (const x of a) o.push(x); return o; }
export function arrSpread(): number[] { const a = [1, 2, 3]; return [...a]; }
export function mapIter(): string[] { const m = new Map<string, number>(); const o: string[] = []; for (const [k] of m) o.push(k); return o; }
// LOCAL generator consumer: the real effect (Fs) must propagate, NOT Unknown.
function* fsGen(): Generator<number> { fs.readFileSync("/x"); yield 1; }
export function localConsume(): number[] { const o: number[] = []; for (const v of fsGen()) o.push(v); return o; }
// LOCAL pure generator consumer: stays PURE (no fabrication).
function* pureGen(): Generator<number> { yield 1; }
export function pureConsume(): number[] { const o: number[] = []; for (const v of pureGen()) o.push(v); return o; }`,
  });
  const { report } = scan(d);
  const u = (fn) => entry(report, fn)?.inferred?.includes("Unknown");
  // opaque-iterable / opaque-iterator force → Unknown (the fixed under-report)
  check("[iter] opaque Iterable param (for-of) → Unknown", u("src.it.collect"), JSON.stringify(entry(report, "src.it.collect")));
  check("[iter] opaque Iterable param (spread [...x]) → Unknown", u("src.it.spreads"), JSON.stringify(entry(report, "src.it.spreads")));
  check("[iter] opaque Iterator param (.next()) → Unknown", u("src.it.nexts"), JSON.stringify(entry(report, "src.it.nexts")));
  check("[iter] opaque iterable (Array.from) → Unknown", u("src.it.fromParam"));
  check("[iter] opaque iterable (array destructure) → Unknown", u("src.it.destrParam"));
  check("[iter] any-typed iterable → Unknown", u("src.it.anyIter"));
  check("[iter] control: opaque callback still Unknown", u("src.it.callsParam"));
  // NO-REGRESSION: concrete built-in iteration stays PURE (omitted from the report = pure)
  check("[iter] array iteration stays PURE", entry(report, "src.it.arrIter") === undefined, JSON.stringify(entry(report, "src.it.arrIter")));
  check("[iter] array spread stays PURE", entry(report, "src.it.arrSpread") === undefined, JSON.stringify(entry(report, "src.it.arrSpread")));
  check("[iter] Map iteration stays PURE", entry(report, "src.it.mapIter") === undefined, JSON.stringify(entry(report, "src.it.mapIter")));
  // local generator: real effect propagates, NOT a fabricated/under-reported Unknown
  check("[iter] LOCAL generator consumer propagates the real effect (Fs)",
        entry(report, "src.it.localConsume")?.inferred?.includes("Fs")
        && !u("src.it.localConsume"), JSON.stringify(entry(report, "src.it.localConsume")));
  check("[iter] LOCAL pure generator consumer stays PURE",
        entry(report, "src.it.pureConsume") === undefined, JSON.stringify(entry(report, "src.it.pureConsume")));
}

// ── callers --include-unknown ⟨0.7⟩: the unresolved-dispatch frontier. Confirmed callers never include a
// fn reaching the target only via a `dispatch:OWNER.member` the engine declined to resolve; the frontier
// discloses those iff a confirmed reacher is an override of OWNER.member (subtype-per-hierarchy = precise).
if (blk()) {
  const cg = { "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [], "m.Frontier.go": [] };
  const fns = [{ fn: "m.Frontier.go", unknownWhy: ["dispatch:m.Base.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  const hier = { "m.Impl": ["m.Base"], "m.Base": [] }; // Impl <: Base; ⟨0.26⟩ the root carries its own key
  const r = callersFrontier(cg, fns, hier, "m.Sink.touch");
  check("frontier: a dispatch:Base.run is disclosed when a confirmed reacher overrides Base.run",
        r.transitive.includes("m.Impl.run")
        && r.possibleViaUnknownDispatch.length === 1
        && r.possibleViaUnknownDispatch[0].fn === "m.Frontier.go"
        && r.possibleViaUnknownDispatch[0].viaDispatchOn === "run",
        JSON.stringify(r.possibleViaUnknownDispatch));
  const fns2 = [{ fn: "m.Frontier.go", unknownWhy: ["dispatch:m.Unrelated.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  check("frontier: precision drops an unrelated same-named dispatch (hierarchy rules it out)",
        callersFrontier(cg, fns2, hier, "m.Sink.touch").possibleViaUnknownDispatch.length === 0, "");
  check("frontier: no hierarchy -> simple-name match over-lists (safe lower-bound direction)",
        callersFrontier(cg, fns2, {}, "m.Sink.touch").possibleViaUnknownDispatch.length === 1, "");
}

// ── frontier ⟨0.24⟩: a DOT-FREE `dispatch:` detail (§4 reserves it for a dispatch whose owner type could
// not be formed at all — candor-rust emits `dispatch:untyped cross-package receiver`) names no OWNER and
// no member, so condition (3) is UNANSWERABLE and MUST NOT be scored as a failed one. MEASURED before the
// fix on exactly this shape: the frontier held ONLY the dotted entry in BOTH arms and no diagnostic named
// the dropped one. The CONTROLS below are what separate this fix from a blanket "disclose everything". ──
if (blk()) {
  const cg = { "m.Impl.handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Dotted.go": [], "m.Untyped.go": [], "m.Unrelated.go": [], "m.NoReason.go": [] };
  const hier = { "m.Impl": ["m.Base"], "m.Base": [] }; // Impl <: Base; ⟨0.26⟩ the root carries its own key
  const fns = [
    { fn: "m.Impl.handle", unknownWhy: [] },
    { fn: "m.Dotted.go", unknownWhy: ["dispatch:m.Base.handle"] },                   // dotted, condition (3) HOLDS
    { fn: "m.Untyped.go", unknownWhy: ["dispatch:untyped cross-package receiver"] }, // dot-free
    { fn: "m.Unrelated.go", unknownWhy: ["dispatch:m.Elsewhere.handle"] },           // dotted, condition (3) FAILS
    { fn: "m.NoReason.go", unknownWhy: [] },                                         // no dispatch reason at all
  ];
  const raw = "untyped cross-package receiver";
  const got = (h) => callersFrontier(cg, fns, h, "m.Sink.touch").possibleViaUnknownDispatch;
  // (a) DISCLOSED with the raw detail verbatim, in BOTH arms.
  for (const [arm, h] of [["hierarchy", hier], ["no-hierarchy", {}]]) {
    const r = got(h);
    check(`frontier: dot-free dispatch detail is DISCLOSED with the raw detail (${arm} arm)`,
          r.some((e) => e.fn === "m.Untyped.go" && e.viaDispatchOn === raw), JSON.stringify(r));
  }
  // (b) THE CONTROLS — without these a blanket "disclose every Unknown fn" would pass (a). A fn with NO
  // dispatch reason stays out of BOTH arms; a fn whose DOTTED reason genuinely fails condition (3) (owner
  // `m.Elsewhere`, not above the reaching override) stays out of the arm that can answer condition (3).
  check("frontier control: a fn with no dispatch reason is NOT disclosed (hierarchy arm)",
        !got(hier).some((e) => e.fn === "m.NoReason.go"), JSON.stringify(got(hier)));
  check("frontier control: a fn with no dispatch reason is NOT disclosed (no-hierarchy arm)",
        !got({}).some((e) => e.fn === "m.NoReason.go"), JSON.stringify(got({})));
  check("frontier control: a DOTTED reason failing condition (3) is still ruled OUT (unrelated owner)",
        !got(hier).some((e) => e.fn === "m.Unrelated.go"), JSON.stringify(got(hier)));
  // and the answerable dotted entry is unmoved by the widening.
  check("frontier: hierarchy arm holds EXACTLY the dotted + the dot-free entry",
        JSON.stringify(got(hier)) === JSON.stringify([{ fn: "m.Dotted.go", viaDispatchOn: "handle" }, { fn: "m.Untyped.go", viaDispatchOn: raw }]),
        JSON.stringify(got(hier)));
  // NO NEW FALSE POSITIVE. `declaringType`/`simpleMethod` fall back to the WHOLE string with no dot, so a
  // dot-free detail could already match a reacher by name — reflexively under a hierarchy when the reacher
  // is itself dot-free (a root-level TS function), or by simple name in the fallback arm. Measured: that
  // coincidence produced viaDispatchOn === the raw detail already, i.e. exactly what ⟨0.24⟩ requires, so
  // the widening supersedes the accident rather than adding a second, differently-valued entry.
  const cg2 = { "m.Impl.handle": ["m.Sink.touch"], "handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Coincide.go": [] };
  const fns2b = [{ fn: "m.Coincide.go", unknownWhy: ["dispatch:handle"] }, { fn: "m.Impl.handle", unknownWhy: [] }, { fn: "handle", unknownWhy: [] }];
  for (const [arm, h] of [["hierarchy", hier], ["no-hierarchy", {}]]) {
    const r = callersFrontier(cg2, fns2b, h, "m.Sink.touch").possibleViaUnknownDispatch;
    check(`frontier: a dot-free detail COINCIDING with a reacher name yields ONE entry, raw detail (${arm} arm)`,
          JSON.stringify(r) === JSON.stringify([{ fn: "m.Coincide.go", viaDispatchOn: "handle" }]), JSON.stringify(r));
  }
  // ROW 3 — the ARM-DEPENDENT shape, and the reason §3.1 ⟨0.24⟩ requires the short-circuit BEFORE the
  // split rather than merely before the lookup. A dot-free detail equal to a DOTTED reacher's SIMPLE
  // METHOD name: the by-method lookup hits (the detail became the member), so the no-hierarchy arm
  // disclosed it; the hierarchy arm then ran the subtype test with owner = "handle" — a string that is
  // not a type name — and DROPPED it. MEASURED here pre-fix, with the short-circuit disabled: no-hier
  // `[{m.Row3.go, handle}]`, hier `[]`. Same input, opposite outputs, decided by nothing but whether a
  // sidecar exists. The assertion is arm-EQUALITY, not two separate contains-checks, because the defect
  // was the disagreement. Note there is NO dot-free reacher here — that is what separates this from the
  // coincidence case above, where reflexivity made the hierarchy arm agree by accident.
  const cg3 = { "m.Impl.handle": ["m.Sink.touch"], "m.Sink.touch": [], "m.Row3.go": [] };
  const fns3 = [{ fn: "m.Row3.go", unknownWhy: ["dispatch:handle"] }, { fn: "m.Impl.handle", unknownWhy: [] }];
  const withH = callersFrontier(cg3, fns3, hier, "m.Sink.touch").possibleViaUnknownDispatch;
  const noH = callersFrontier(cg3, fns3, {}, "m.Sink.touch").possibleViaUnknownDispatch;
  check("frontier: dot-free detail == a dotted reacher's simple method name — SAME in both arms (row 3)",
        JSON.stringify(withH) === JSON.stringify(noH), `hier=${JSON.stringify(withH)} nohier=${JSON.stringify(noH)}`);
  check("frontier: ...and that shared answer is the entry, disclosed with the raw detail (row 3)",
        JSON.stringify(withH) === JSON.stringify([{ fn: "m.Row3.go", viaDispatchOn: "handle" }]), JSON.stringify(withH));
}

// ── frontier ⟨0.24⟩ THE MIXED SOURCE + the pinned COLLATION. One fn carrying several `dispatch:` reasons
// gets ONE entry whose `viaDispatchOn` is the SORTED, DEDUPLICATED, comma-joined union of the passing
// members and the raw dot-free details. The two literals below are candor-java's, produced from its real
// CLI, and are the shared cross-engine fixture — assert the exact STRING, because the conformance
// differential only substring-checks this field and cannot see an ordering divergence. ──
if (blk()) {
  const cg = { "app.Impl.run": ["app.Sink.touch"], "app.Zed.write": ["app.Sink.touch"], "app.Sink.touch": [], "app.Mixed.go": [] };
  const hier = { "app.Impl": ["app.Base", "app.Other"], "app.Zed": ["app.Base"] };
  // Reasons fed in an order that is NOT the sorted order, and the sorted answer INTERLEAVES the two kinds
  // (`write` sorts AFTER the dot-free phrase). So a "dotted members first, then dot-free" join fails, an
  // insertion-order join fails, and the assertion cannot lean on an upstream container to have sorted.
  const fns = [
    { fn: "app.Mixed.go", unknownWhy: ["dispatch:untyped cross-package receiver", "dispatch:app.Base.write", "dispatch:app.Base.run"] },
    { fn: "app.Impl.run", unknownWhy: [] }, { fn: "app.Zed.write", unknownWhy: [] },
  ];
  const mixed = callersFrontier(cg, fns, hier, "app.Sink.touch").possibleViaUnknownDispatch;
  check("frontier: MIXED source -> ONE entry, sorted union of members + raw details (java's literal)",
        JSON.stringify(mixed) === JSON.stringify([{ fn: "app.Mixed.go", viaDispatchOn: "run,untyped cross-package receiver,write" }]),
        JSON.stringify(mixed));
  // DEDUP: two dotted reasons naming the SAME member through different owners, both passing (the reacher
  // is a subtype of both) — the member appears ONCE.
  const fnsD = [
    { fn: "app.Mixed.go", unknownWhy: ["dispatch:app.Base.run", "dispatch:app.Other.run"] },
    { fn: "app.Impl.run", unknownWhy: [] }, { fn: "app.Zed.write", unknownWhy: [] },
  ];
  const dedup = callersFrontier(cg, fnsD, hier, "app.Sink.touch").possibleViaUnknownDispatch;
  check("frontier: two reasons naming the same member M dedup to one M (java's literal)",
        JSON.stringify(dedup) === JSON.stringify([{ fn: "app.Mixed.go", viaDispatchOn: "run" }]), JSON.stringify(dedup));
  // COLLATION, on a fixture that DISTINGUISHES the two orders — candor-java's pair, mirrored. U+1D400 is
  // supplementary (stored as the surrogate pair D835 DC00); U+FB00 is BMP, ABOVE the surrogate block. Under
  // JS's default UTF-16 code-unit sort the supplementary one comes FIRST (0xD835 < 0xFB00); under the
  // pinned CODE-POINT order it comes LAST (0x1D400 > 0xFB00). Both are letters, so this is a realistic
  // identifier pair. Both details are dot-free, so they are disclosed verbatim and the assertion is purely
  // about order. VERIFIED RED against a bare `.sort()` (which produced the U+1D400-first string).
  // The all-ASCII literals above are deliberately NOT this test: ASCII is where the two orders agree, so
  // they pin the join and the dedup while this pins the collation.
  const bmp = "ﬀ", sup = "\u{1D400}";
  const fnsC = [{ fn: "app.Mixed.go", unknownWhy: [`dispatch:${sup}`, `dispatch:${bmp}`] }, { fn: "app.Impl.run", unknownWhy: [] }];
  const coll = callersFrontier(cg, fnsC, hier, "app.Sink.touch").possibleViaUnknownDispatch;
  check("frontier: viaDispatchOn collates by UNICODE CODE POINT, not UTF-16 code unit",
        coll.length === 1 && coll[0].viaDispatchOn === `${bmp},${sup}`,
        JSON.stringify(coll) + ` (utf16 order would be ${JSON.stringify(`${sup},${bmp}`)})`);
  // CARDINALITY, not identity. Two details differing only in an UNPAIRED SURROGATE must stay TWO elements.
  // A comparator that encodes to UTF-8 first collapses every lone surrogate to the same replacement bytes,
  // so they compare EQUAL; in candor-java, whose accumulator is a comparator-backed sorted set, that meant
  // "duplicate" and one element silently vanished — order-correct and lossy at once. Asserted as a COUNT,
  // not a string: a lone surrogate does not survive the JSON wire in any engine, so identity is not
  // pinnable end-to-end (java's first attempt failed on its own harness rendering both as `?`).
  // MEASURED, and stated plainly because a test comment that overclaims is the defect this repo keeps
  // finding: this assertion does NOT go red against the UTF-8 comparator HERE. This accumulator dedups by
  // `Set` string identity and orders in a separate `Array.sort`, which never drops equal elements, so both
  // survive either way. It is a REGRESSION guard on the accumulator's shape — the day the `Set` + `sort`
  // pair becomes one comparator-backed sorted structure, this is the assertion that catches it.
  const fnsS = [{ fn: "app.Mixed.go", unknownWhy: ["dispatch:\uD800", "dispatch:\uD801"] }, { fn: "app.Impl.run", unknownWhy: [] }];
  const surr = callersFrontier(cg, fnsS, hier, "app.Sink.touch").possibleViaUnknownDispatch;
  check("frontier: two details differing only in a LONE SURROGATE stay two entries (no lossy collapse)",
        surr.length === 1 && surr[0].viaDispatchOn.split(",").length === 2,
        JSON.stringify(surr.map((e) => [...e.viaDispatchOn].map((c) => c.codePointAt(0).toString(16)))));
  // ⟨0.24⟩ THE OTHER SORT IN THIS FUNCTION — the ENTRY order, keyed on `fn`, which used `localeCompare`
  // (SPEC §2: every ordering in a QUERY OUTPUT is locale-independent too, not just the ones in a report).
  // The pair is chosen so `localeCompare` and code point DISAGREE in EVERY locale, not just an exotic one:
  // ICU compares letters case-insensitively at the primary level, so `app.Zed.run` sorts AFTER
  // `app.alpha.run` (z after a), while code point puts it FIRST ('Z' = U+005A < 'a' = U+0061). Verified in
  // C, en_GB, et_EE, da_DK, tr_TR and ja_JP: `localeCompare` = +1, code point = −1 in all six. So this
  // assertion goes RED against `localeCompare` on any runtime, which the ASCII-lowercase fixtures above
  // would not — and a PascalCase type segment beside a lowercase module segment is what real quals look
  // like, so it is the realistic case rather than the contrived one.
  const cgO = { "app.Zed.run": [], "app.alpha.run": [], "app.Sink.touch": [], "app.Impl.run": ["app.Sink.touch"] };
  const fnsO = [
    { fn: "app.alpha.run", unknownWhy: ["dispatch:app.Base.run"] },
    { fn: "app.Zed.run", unknownWhy: ["dispatch:app.Base.run"] },
    { fn: "app.Impl.run", unknownWhy: [] },
  ];
  const ord = callersFrontier(cgO, fnsO, { "app.Impl": ["app.Base"] }, "app.Sink.touch")
    .possibleViaUnknownDispatch.map((e) => e.fn);
  check("frontier: ENTRY order is by CODE POINT, not `localeCompare` (uppercase segment sorts first)",
        JSON.stringify(ord) === JSON.stringify(["app.Zed.run", "app.alpha.run"]),
        JSON.stringify(ord) + ` (localeCompare order would be ${JSON.stringify(["app.alpha.run", "app.Zed.run"])})`);
}

// ── §4 ⟨0.24⟩ the FIFTH kind, `ambiguous:` — A DISPATCH FRONTIER MUST KEY OFF THE KIND, NOT THE CLASS ──
// `ambiguous:` means the analyser's own NAME RESOLUTION was ambiguous (two same-named local definitions),
// so NO OWNER TYPE was ever formed. It projects to §6.2 class `dispatch`, but the frontier's condition (3)
// — "is a confirmed reacher an OVERRIDE of OWNER.member?" — has nothing to resolve against. A CLASS-keyed
// frontier admits those entries; a KIND-keyed one excludes them for free. candor-ts's is kind-keyed
// (`w.startsWith("dispatch:")` in callersFrontier), and this pins it AGAINST the class selector over ONE
// report, mirroring candor-rust's fixture: the two selectors must DISAGREE about the `ambiguous:` entry,
// and the disagreement is the correct answer, not a bug in either. Asserting only the frontier's exclusion
// would also pass if the entry were simply missing from the report — the `blindspots --class dispatch`
// half is what proves the entry is present, is class `dispatch`, and is nonetheless kept out.
if (blk()) {
  const cg = { "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [], "m.Dotted.go": [], "m.Ambig.go": [], "m.Banana.go": [] };
  const hier = { "m.Impl": ["m.Base"], "m.Base": [] }; // Impl <: Base; ⟨0.26⟩ the root carries its own key
  const fns = [
    { fn: "m.Impl.run", inferred: [], unknownWhy: [] },
    { fn: "m.Dotted.go", inferred: ["Unknown"], unknownWhy: ["dispatch:m.Base.run"] },  // kind dispatch, class dispatch
    { fn: "m.Ambig.go", inferred: ["Unknown"], unknownWhy: ["ambiguous:two same-named local definitions"] },
    { fn: "m.Banana.go", inferred: ["Unknown"], unknownWhy: ["banana:whatever"] },      // the off-vocabulary control
  ];
  for (const [arm, h] of [["hierarchy", hier], ["no-hierarchy", {}]]) {
    const fr = callersFrontier(cg, fns, h, "m.Sink.touch").possibleViaUnknownDispatch;
    check(`frontier is KIND-keyed: an \`ambiguous:\` source is NOT admitted (${arm} arm)`,
          !fr.some((e) => e.fn === "m.Ambig.go"), JSON.stringify(fr));
    // …and the answerable `dispatch:` entry is still there, so the exclusion is discrimination, not a
    // frontier that stopped working.
    check(`frontier: the dotted \`dispatch:\` source IS still admitted alongside it (${arm} arm)`,
          fr.length === 1 && fr[0].fn === "m.Dotted.go", JSON.stringify(fr));
  }
  // THE CLASS-KEYED SELECTOR OVER THE SAME REPORT returns it — proving the entry exists and IS class
  // `dispatch` (§6.2), i.e. that the frontier's exclusion is keyed on the KIND and on nothing else.
  const byClass = blindspots(fns, cg, "dispatch").sources.map((s) => s.fn).sort();
  check("§6.2: `blindspots --class dispatch` (CLASS-keyed) DOES return the `ambiguous:` source",
        JSON.stringify(byClass) === JSON.stringify(["m.Ambig.go", "m.Dotted.go"]), JSON.stringify(byClass));
  // THE CONTROL. A fabricated off-vocabulary kind must behave exactly as before the fifth kind was
  // recognised: never admitted to the frontier (asserted in both arms above by `fr.length === 1`), and
  // classified through the CONSERVATIVE CATCH-ALL — `unresolved`, not `dispatch`. Without this pair,
  // "added a fifth kind" and "stopped checking the kind set" are the same diff.
  check("control: a fabricated `banana:` kind is NOT class dispatch (catch-all, §2 forward-compat)",
        !blindspots(fns, cg, "dispatch").sources.some((s) => s.fn === "m.Banana.go"),
        JSON.stringify(blindspots(fns, cg, "dispatch").sources.map((s) => s.fn)));
  check("control: a fabricated `banana:` kind classifies `unresolved`",
        JSON.stringify(blindspots(fns, cg, "unresolved").sources.map((s) => s.fn)) === JSON.stringify(["m.Banana.go"]),
        JSON.stringify(blindspots(fns, cg, "unresolved").sources.map((s) => s.fn)));
  // …and the class DISTRIBUTION counts them in exactly those two buckets, with nothing landing anywhere
  // else — the whole-report view, which a per-entry assertion cannot see.
  const st = blindspotsStats(fns).byClass;
  check("blindspots --stats: ambiguous+dispatch → 2 dispatch, banana → 1 unresolved, rest 0",
        st.dispatch === 2 && st.unresolved === 1 && st.reflect === 0 && st.native === 0
          && st.indirect === 0 && st.setup === 0, JSON.stringify(st));
}

// ── §4 ⟨0.24⟩ the fifth kind, END TO END through the shipped verbs (the model-level block above is over
// query-core directly; this is the same three claims through the CLI a consumer actually runs, on a report
// candor-ts did not produce — a foreign engine's, which is the only way `ambiguous:` reaches it). ──
if (blk()) {
  const d = scratch("candor-ts-kind024-");
  const rep = {
    candor: { version: "candor-rust-0.24.0", spec: "0.24" },
    functions: [
      // The three `*.go` units reach `m.Sink.touch` ONLY through their unresolved call — they are NOT
      // confirmed callers (the frontier skips those), which is the whole shape the verb exists to disclose.
      { fn: "m.Dotted.go", inferred: ["Unknown"], direct: ["Unknown"], unresolved: true, unknownWhy: ["dispatch:m.Base.run"] },
      { fn: "m.Ambig.go", inferred: ["Unknown"], direct: ["Unknown"], unresolved: true, unknownWhy: ["ambiguous:two same-named local definitions"] },
      { fn: "m.Banana.go", inferred: ["Unknown"], direct: ["Unknown"], unresolved: true, unknownWhy: ["banana:whatever"] },
      { fn: "m.Impl.run", inferred: [], direct: [], unresolved: false, calls: ["m.Sink.touch"] },
      { fn: "m.Sink.touch", inferred: [], direct: [], unresolved: false },
    ],
  };
  const prefix = path.join(d, "report");
  fs.writeFileSync(`${prefix}.json`, JSON.stringify(rep));
  fs.writeFileSync(`${prefix}.callgraph.json`, JSON.stringify(
    { "m.Dotted.go": [], "m.Ambig.go": [], "m.Banana.go": [],
      "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [] }));
  const q = (...a) => {
    const r = spawnSync("node", [path.join(HERE, "query.mjs"), ...a, "--report", prefix, "--json"], { encoding: "utf8" });
    return { r, out: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  const bs = q("blindspots");
  const whyOf = (fn) => bs.out?.sources.find((s) => s.fn === fn)?.why;
  // (1) ROUND-TRIPPED VERBATIM. Both the fifth kind and the fabricated one — the engine neither rewrites
  // nor drops a `kind:detail` it did not author. The fabricated one is the load-bearing half: an engine
  // that had started normalising unknown kinds onto a known one would pass every class assertion below.
  check("e2e: `ambiguous:` round-trips VERBATIM through `blindspots --json`",
        JSON.stringify(whyOf("m.Ambig.go")) === JSON.stringify(["ambiguous:two same-named local definitions"]),
        JSON.stringify(bs.out?.sources));
  check("e2e control: a fabricated `banana:whatever` round-trips VERBATIM too (§2 forward-compat)",
        JSON.stringify(whyOf("m.Banana.go")) === JSON.stringify(["banana:whatever"]), JSON.stringify(bs.out?.sources));
  // (2) CLASSIFIED — the fifth kind onto `dispatch` (§6.2), the fabricated one onto the CATCH-ALL.
  const cls = (c) => q("blindspots", "--class", c).out?.sources.map((s) => s.fn).sort() ?? null;
  check("e2e: `blindspots --class dispatch` selects the `ambiguous:` source (§6.2 projection)",
        JSON.stringify(cls("dispatch")) === JSON.stringify(["m.Ambig.go", "m.Dotted.go"]), JSON.stringify(cls("dispatch")));
  check("e2e control: `--class unresolved` selects the fabricated kind and ONLY it (catch-all, not dispatch)",
        JSON.stringify(cls("unresolved")) === JSON.stringify(["m.Banana.go"]), JSON.stringify(cls("unresolved")));
  // (3) THE FRONTIER STAYS KIND-KEYED THROUGH THE CLI. `m.Impl.run` is the confirmed reacher and an
  // override of `m.Base.run` under no hierarchy sidecar (simple-name match), so `m.Dotted.go` is disclosed
  // — and neither the class-sibling `ambiguous:` nor the fabricated kind rides in behind it.
  const fr = q("callers", "m.Sink.touch", "--include-unknown").out?.possibleViaUnknownDispatch ?? [];
  check("e2e: `callers --include-unknown` admits ONLY the `dispatch:` source (kind-keyed frontier)",
        JSON.stringify(fr.map((e) => e.fn)) === JSON.stringify(["m.Dotted.go"]), JSON.stringify(fr));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── §4 ⟨0.24⟩ "a consumer may need a kind it never emits" — THE CHAIN RELAY. candor-ts emits no
// `ambiguous:` of its own (TypeScript's module system gives every declaration a resolvable home), but the
// dependency join copies a chained report's `unknownWhy` VERBATIM into the consumer's own report keyed by
// the CALLING function, so the kind lands in candor-ts output regardless. Pinned here so the relay cannot
// silently start filtering by a kind allowlist — which would be this engine's version of the §4 defect. ──
if (blk()) {
  // The dep's unit must be EFFECTFUL to appear in its report at all (§2 rule 3: silence is purity), so it
  // reads the clock — the effect is scaffolding, the `unknownWhy` rewrite below is the subject.
  const depDir = project({ "index.ts": `export function reach(): number { return Date.now(); }` });
  fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({ name: "ambig-dep", version: "0.0.0" }));
  const { prefix: depPrefix } = scan(depDir);
  // Rewrite the DEP's entry to carry the two foreign kinds, leaving the producing-build header intact (the
  // join distrusts a report whose `candor.version` is not this exact build and downgrades it to a bare
  // Unknown, so a literally-foreign file would test the STALE path instead of the relay).
  const depRep = JSON.parse(fs.readFileSync(`${depPrefix}.json`, "utf8"));
  const de = depRep.functions.find((e) => e.fn.endsWith(".reach"));
  de.inferred = ["Unknown"]; de.direct = ["Unknown"]; de.unresolved = true;
  de.unknownWhy = ["ambiguous:two same-named local definitions", "banana:whatever"];
  fs.writeFileSync(`${depPrefix}.json`, JSON.stringify(depRep));
  const app = project({
    "package.json": `{"name": "ambig-app", "dependencies": {"ambig-dep": "0.0.0"}}`,
    "node_modules/ambig-dep/package.json": `{"name":"ambig-dep","types":"index.d.ts","main":"index.js"}`,
    "node_modules/ambig-dep/index.d.ts": `export declare function reach(): number;`,
    "node_modules/ambig-dep/index.js": ``,
    "src/a.ts": `import { reach } from "ambig-dep";\nexport function go(): number { return reach(); }`,
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), app],
            { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${depPrefix}.json` } });
  const appRep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  const why = entry(appRep, "src.a.go")?.unknownWhy ?? [];
  check("chain relay: a dep's `ambiguous:` reaches the CONSUMER's own report, verbatim",
        why.includes("ambiguous:two same-named local definitions"), JSON.stringify(entry(appRep, "src.a.go")));
  check("chain relay control: a dep's FABRICATED kind is relayed verbatim too (no allowlist filter)",
        why.includes("banana:whatever"), JSON.stringify(entry(appRep, "src.a.go")));
}

// ── node:vm executes a runtime code STRING → Unknown (the eval-class disclosure). Was silent-pure —
// found by real-world corpus testing (vm is κ-covered @types/node with no rule, so it read pure, not
// invisible). Mirrors eval/Function/import() which already disclose Unknown. ──
if (blk()) {
  const d = project({
    "src/a.ts": `import vm from "node:vm";
export function runIt(c: string) { return vm.runInThisContext(c); }
export function runNew(c: string) { return vm.runInNewContext(c); }
export function scriptIt(c: string) { const s = new vm.Script(c); return s.runInContext(vm.createContext({})); }
export function compileIt(c: string) { return vm.compileFunction(c); }
export function createCtx() { return vm.createContext({}); }`,
  });
  const { report } = scan(d);
  const u = (fn) => entry(report, fn)?.inferred.includes("Unknown");
  check("vm.runInThisContext discloses Unknown (opaque code exec, not silent-pure)", u("src.a.runIt"));
  check("vm.runInNewContext discloses Unknown", u("src.a.runNew"));
  check("vm.Script.runInContext discloses Unknown", u("src.a.scriptIt"));
  check("vm.compileFunction discloses Unknown", u("src.a.compileIt"));
  check("vm Unknown carries a why (SPEC §4)",
        entry(report, "src.a.runIt")?.unknownWhy?.some((w) => w.startsWith("reflect:vm")),
        JSON.stringify(entry(report, "src.a.runIt")?.unknownWhy));
  // anti-fabrication control: vm.createContext (builds a sandbox object, runs no code) stays pure.
  check("vm.createContext stays pure (no fabricated Unknown — only the run/compile verbs)",
        entry(report, "src.a.createCtx") === undefined, JSON.stringify(entry(report, "src.a.createCtx")));
}

// ── dynamic require(<non-literal>) → Unknown (the CJS twin of import(m)); literal / require.resolve /
// a project-local `require` shadow all stay pure (no fabrication). Corpus-testing find, sibling of vm. ──
if (blk()) {
  const d = project({
    "src/a.ts": `export function dyn(m: string) { return require(m); }
export function lit() { return require("node:fs"); }
export function resolveIt(m: string) { return require.resolve(m); }`,
    "src/shadow.ts": `function require(x: string) { return 1; }
export function shadowed(y: string) { return require(y); }`,
  });
  const { report } = scan(d);
  check("dynamic require(var) discloses Unknown (opaque module load, like import(m))",
        entry(report, "src.a.dyn")?.inferred.includes("Unknown"));
  check("dynamic require Unknown carries reflect:require why (SPEC §4)",
        entry(report, "src.a.dyn")?.unknownWhy?.includes("reflect:require"));
  check("literal require('node:fs') stays pure (static resolvable load, no method call)",
        entry(report, "src.a.lit") === undefined, JSON.stringify(entry(report, "src.a.lit")));
  check("require.resolve(m) stays pure (returns a path, loads nothing)",
        entry(report, "src.a.resolveIt") === undefined);
  check("a project-local `require` shadow stays pure (no fabricated Unknown)",
        entry(report, "src.shadow.shadowed") === undefined, JSON.stringify(entry(report, "src.shadow.shadowed")));
}

// ── process.env READ idioms → Env: not just the direct `process.env.KEY` dot access, but bracket access,
// a local const-alias of process.env, destructuring a key off it, and the `in` membership test. Each of
// these read SILENT-PURE before (dogfound on chalk/supports-color, which reads env via `const {env} =
// process; 'FORCE_COLOR' in env; env.TERM`). SOUNDNESS: the same idiom on a NON-process.env object stays
// pure (no fabrication), and a reassigned alias local is cleared. ──────────────────────────────────────
if (blk()) {
  const d = project({
    "src/pos.ts": `const envA = process.env;
const { env: envB } = process;
export function bracket() { return process.env["FOO"]; }
export function aliasDot() { return envA.FOO; }
export function aliasBracket() { return envA["FOO"]; }
export function destr() { const { FOO } = process.env; return FOO; }
export function inOp() { return "FOO" in process.env; }
export function inAlias() { return "FOO" in envA; }
export function destrEnvOffProcess() { return envB.TERM; }
export function dynKey(k: string) { return envA[k]; }`,
    "src/neg.ts": `function getConfig(): Record<string, string> { return {}; }
const cfg = getConfig();
export function cfgBracket() { return cfg["FOO"]; }
export function inParam(o: object) { return "FOO" in o; }
export function destrParam(o: { FOO?: string }) { const { FOO } = o; return FOO; }`,
    "src/shadow.ts": `const process = { env: { FOO: "x" } as Record<string, string> };
export function shadowed() { return process.env["FOO"]; }`,
    "src/reassign.ts": `function other(): Record<string, string> { return {}; }
let env = process.env;
env = other();
export function afterReassign() { return env.FOO; }`,
  });
  const { report } = scan(d);
  const isEnv = (fn) => entry(report, fn)?.inferred.includes("Env");
  // POSITIVE — all read Env.
  check("process.env[\"KEY\"] bracket access → Env", isEnv("src.pos.bracket"), JSON.stringify(entry(report, "src.pos.bracket")));
  check("const env = process.env; env.KEY → Env (alias dot)", isEnv("src.pos.aliasDot"));
  check("const env = process.env; env[\"KEY\"] → Env (alias bracket)", isEnv("src.pos.aliasBracket"));
  check("const {KEY} = process.env → Env (destructure)", isEnv("src.pos.destr"));
  check("\"KEY\" in process.env → Env (in operator)", isEnv("src.pos.inOp"));
  check("\"KEY\" in env → Env (in operator on alias)", isEnv("src.pos.inAlias"));
  check("const {env} = process; env.KEY → Env (env destructured off process)", isEnv("src.pos.destrEnvOffProcess"));
  check("const env = process.env; env[dynamicKey] → Env (dynamic bracket key still reads env)", isEnv("src.pos.dynKey"));
  // NEGATIVE — fabrication guard: same idioms on a NON-process.env object stay pure.
  check("cfg[\"KEY\"] where cfg is NOT process.env stays pure (no fabricated Env)",
        !isEnv("src.neg.cfgBracket"), JSON.stringify(entry(report, "src.neg.cfgBracket")));
  check("\"KEY\" in <param> stays pure (in on an arbitrary object is not Env)", !isEnv("src.neg.inParam"));
  check("const {KEY} = <param> stays pure (destructure off an arbitrary object is not Env)", !isEnv("src.neg.destrParam"));
  check("a project-local `const process` shadow does NOT fabricate Env (process.env[\"K\"] on the shadow)",
        !isEnv("src.shadow.shadowed"), JSON.stringify(entry(report, "src.shadow.shadowed")));
  check("a `let env = process.env` REASSIGNED to a non-env value clears the alias (stays pure)",
        !isEnv("src.reassign.afterReassign"), JSON.stringify(entry(report, "src.reassign.afterReassign")));
}

// ── EFFECT-POLYMORPHISM (the dotenv `populate` boundary): process.env aliased THROUGH a parameter into a leaf
// that WRITES it is a real Env effect the leaf reads pure in isolation (its body has no lexical process.env).
// Reconciled along the callgraph: a MUST-alias arg into a written parameter → Env (proven); a MAY-alias (a
// reassignable union — dotenv's `let pe = process.env; if (opts.pe) pe = opts.pe`) → Unknown (possible, so
// disclose, never fabricate Env). FABRICATION GUARD: a non-env arg, or a param only READ not written, stays
// pure — the census shows this fires on ~1 leaf per corpus, not the benign argument-mutating majority. ──
if (blk()) {
  const d = project({
    "src/must.ts": `function writeEnv(target: Record<string,string>) { target.FOO = "x"; }
const env = process.env;
export function callMust() { writeEnv(env); }`,
    "src/may.ts": `function writeMay(target: Record<string,string>) { target.FOO = "x"; }
export function callMay(opts: { pe?: Record<string,string> }) {
  let pe = process.env;
  if (opts.pe) pe = opts.pe;   // reassignable union → pe is only a MAY-alias of process.env
  writeMay(pe);
}`,
    "src/neg.ts": `function writePlain(target: Record<string,string>) { target.FOO = "x"; }
export function callPlain() { writePlain({}); }`,
    "src/read.ts": `function readParam(src: Record<string,string>) { return src.FOO; }
export function callRead() { return readParam(process.env); }`,
  });
  const { report } = scan(d);
  const inf = (fn) => entry(report, fn)?.inferred ?? [];
  check("param-write leaf called with a MUST env-alias → Env (proven env write through the parameter)",
        inf("src.must.writeEnv").includes("Env"), JSON.stringify(entry(report, "src.must.writeEnv")));
  check("param-write leaf called with a MAY env-alias (reassignable union) → Unknown, NOT fabricated Env",
        inf("src.may.writeMay").includes("Unknown") && !inf("src.may.writeMay").includes("Env"),
        JSON.stringify(entry(report, "src.may.writeMay")));
  check("param-write leaf called with a NON-env object stays PURE (no over-disclosure — the 27:1 guard)",
        entry(report, "src.neg.writePlain") == null, JSON.stringify(entry(report, "src.neg.writePlain")));
  check("a leaf that only READS its parameter (no write) is NOT tainted by an env arg (stays pure)",
        entry(report, "src.read.readParam") == null, JSON.stringify(entry(report, "src.read.readParam")));
}

// ── EFFECT-POLYMORPHISM, the TRANSITIVE closure (a max code review found pass 2c's one-hop/direct model leaked):
// env-fed-ness flows to a FIXPOINT over parameters, and the env effect is attributed to the INNERMOST unit that
// writes an env-fed variable — its own parameter OR a captured one — through ANY assignment operator. So a
// forwarding hop, a local alias, a closure that captures the parameter, and a compound assignment are all caught;
// a benign argument-mutation with NO process.env inflow stays pure (still gated on a real env source). ─────────
if (blk()) {
  const d = project({
    "src/hop.ts": `function inner(t: Record<string,string>) { t.FOO = 'x'; }
function outer(p: Record<string,string>) { inner(p); }
const env = process.env;
export function go() { outer(env); }`,                                    // env forwarded one hop → INNER is the writer
    "src/alias.ts": `function wAlias(p: Record<string,string>) { const t = p; t.FOO = 'x'; }
const env = process.env;
export function go() { wAlias(env); }`,                                   // write through a local alias of the param
    "src/closure.ts": `function fillU(target: Record<string,string>) { const cb = () => { target.FOO = 'x'; }; [1].forEach(cb); }
const env = process.env;
export function go() { fillU(env); }`,                                    // write inside a closure that CAPTURES the param
    "src/compound.ts": `function seedC(t: Record<string,string>) { t.PATH ||= '/x'; }
const env = process.env;
export function go() { seedC(env); }`,                                    // compound assignment (||=) to an env-fed param
    "src/benign.ts": `function w2(t: Record<string,string>) { t.Z = '1'; }
function fwd(p: Record<string,string>) { w2(p); }
export function use() { fwd({ a: 'b' }); }`,                              // two hops, NO env inflow → must stay pure
    "src/inline.ts": `function fillInline(target: Record<string,string>) { [1].forEach(() => { target.FOO = 'x'; }); }
const env = process.env;
export function go() { fillInline(env); }`,                               // ANON inline callback = NOT a minted unit → write folds onto fillInline (matches the oracle's span attribution)
  });
  const { report } = scan(d);
  const inf = (fn) => entry(report, fn)?.inferred ?? [];
  check("TRANSITIVE: env forwarded one hop → the actual writer (inner) is Env, not silently pure",
        inf("src.hop.inner").includes("Env"), JSON.stringify(entry(report, "src.hop.inner")));
  check("ALIAS: a write through `const t = param` on an env-fed param → Env",
        inf("src.alias.wAlias").includes("Env"), JSON.stringify(entry(report, "src.alias.wAlias")));
  check("CLOSURE: a write inside a closure capturing an env-fed param → that closure unit is Env",
        report.functions.some((f) => /src\.closure\.(cb|fillU)/.test(f.fn) && f.inferred.includes("Env")),
        JSON.stringify(report.functions.filter((f) => f.fn.startsWith("src.closure"))));
  check("COMPOUND: a compound assignment (`||=`) to an env-fed param → Env (not only `=` is a write)",
        inf("src.compound.seedC").includes("Env"), JSON.stringify(entry(report, "src.compound.seedC")));
  check("BENIGN: an argument-mutation reached by two hops with NO env inflow stays PURE (no over-disclosure)",
        entry(report, "src.benign.w2") == null && entry(report, "src.benign.fwd") == null,
        JSON.stringify([entry(report, "src.benign.w2"), entry(report, "src.benign.fwd")]));
  check("INLINE CLOSURE: an ANONYMOUS callback (not a minted unit) writing an env-fed param folds onto the enclosing unit → Env",
        inf("src.inline.fillInline").includes("Env"), JSON.stringify(entry(report, "src.inline.fillInline")));
}

// ── WHOLE-OBJECT process.env access via BUILTINS/SPREAD (a corpus-hunt find — `process.env.KEY` was caught but
// the env object handed WHOLE to a builtin that enumerates/mutates it read silent-pure): `Object.assign(env, o)` /
// `Object.defineProperty(env, …)` / `Reflect.set(env, …)` WRITE the environment; `{...env}` / `Object.keys(env)` /
// `Object.assign(_, env)` / `JSON.stringify(env)` READ every key. All are Env; a builtin on a NON-env object, and a
// project-local `Object`/`Reflect` SHADOW, stay pure (no fabrication). Direct and through an env-fed parameter. ──
if (blk()) {
  const d = project({
    "src/w.ts": `export function wAssign(o: Record<string,string>) { Object.assign(process.env, o); }
export function wDefine(k: string) { Object.defineProperty(process.env, k, { value: 'x' }); }
export function wReflect(k: string, v: string) { Reflect.set(process.env, k, v); }`,
    "src/r.ts": `export function rSpread() { return { ...process.env }; }
export function rKeys() { return Object.keys(process.env); }
export function rAssignSrc() { const o: any = {}; Object.assign(o, process.env); return o; }`,
    "src/thru.ts": `function assignInto(t: Record<string,string>, o: Record<string,string>) { Object.assign(t, o); }
function dumpKeys(t: Record<string,string>) { return Object.keys(t); }
const env = process.env;
export function loadEnv(o: Record<string,string>) { assignInto(env, o); }
export function dumpEnv() { return dumpKeys(env); }`,
    "src/neg.ts": `export function benignAssign() { return Object.assign({}, { a: 1 }); }
export function benignKeys(o: Record<string,unknown>) { return Object.keys(o); }`,
    "src/shadow.ts": `const Shadow = { assign: (a: any) => a };
export function shadowed() { const Object = Shadow; return Object.assign(process.env, {}); }`,
  });
  const { report } = scan(d);
  const isEnv = (fn) => (entry(report, fn)?.inferred ?? []).includes("Env");
  for (const [fn, label] of [["src.w.wAssign", "Object.assign(process.env, o) WRITE"], ["src.w.wDefine", "Object.defineProperty(process.env) WRITE"],
                             ["src.w.wReflect", "Reflect.set(process.env) WRITE"], ["src.r.rSpread", "{...process.env} READ"],
                             ["src.r.rKeys", "Object.keys(process.env) READ"], ["src.r.rAssignSrc", "Object.assign(_, process.env) READ"]])
    check(`whole-env builtin: ${label} → Env`, isEnv(fn), JSON.stringify(entry(report, fn)));
  check("whole-env builtin THROUGH a param: assignInto(env, o) → Env (write via Object.assign on an env-fed param)", isEnv("src.thru.assignInto"));
  check("whole-env builtin THROUGH a param: dumpKeys(env) → Env (read via Object.keys on an env-fed param)", isEnv("src.thru.dumpKeys"));
  check("GUARD: Object.assign/keys on a NON-env object stays PURE (no fabrication)",
        entry(report, "src.neg.benignAssign") == null && entry(report, "src.neg.benignKeys") == null,
        JSON.stringify([entry(report, "src.neg.benignAssign"), entry(report, "src.neg.benignKeys")]));
  check("GUARD: a project-local `Object` SHADOW does NOT fabricate Env on `Object.assign(process.env, …)`",
        entry(report, "src.shadow.shadowed") == null, JSON.stringify(entry(report, "src.shadow.shadowed")));
}

// ── the same whole-env class via for-in and the `structuredClone` bare global (a further corpus-probe pass). ──
if (blk()) {
  const d = project({
    "src/fi.ts": `export function forInEnv() { let n = 0; for (const k in process.env) n++; return n; }
export function cloneEnv() { return structuredClone(process.env); }`,
    "src/thru.ts": `function iter(t: Record<string,string>) { let n = 0; for (const k in t) n++; return n; }
const env = process.env;
export function go() { return iter(env); }`,
    "src/neg.ts": `export function forInPlain(o: Record<string,string>) { let n = 0; for (const k in o) n++; return n; }
export function cloneObj(o: unknown) { return structuredClone(o); }`,
  });
  const { report } = scan(d);
  const isEnv = (fn) => (entry(report, fn)?.inferred ?? []).includes("Env");
  check("for-in over process.env → Env (`for (k in process.env)` enumerates every key)", isEnv("src.fi.forInEnv"));
  check("structuredClone(process.env) → Env (deep-clone reads every key; bare global builtin)", isEnv("src.fi.cloneEnv"));
  check("for-in over an env-fed PARAMETER → Env (through the pass-2c env-fed analysis)", isEnv("src.thru.iter"));
  check("GUARD: for-in / structuredClone over a NON-env object stays PURE (no fabrication)",
        entry(report, "src.neg.forInPlain") == null && entry(report, "src.neg.cloneObj") == null,
        JSON.stringify([entry(report, "src.neg.forInPlain"), entry(report, "src.neg.cloneObj")]));
}

// ── REFLECTIVE INVOKE of a κ-EFFECTFUL builtin — `fn.call`/`fn.apply`/`Reflect.apply(fn,…)` reach the invoked
// function's effect (a corpus-probe find: these read silent-pure while `.bind`/alias/computed-member were caught).
// The invoked ref is classified through the SAME κ table a direct call uses, so an EFFECTFUL builtin gets its
// effect and a PURE builtin (`[].slice.call(args)`, `hasOwnProperty.call`) stays pure — no over-disclosure. ──
if (blk()) {
  const d = project({
    "src/eff.js": `const fs = require('fs');
module.exports.viaCall = (p) => fs.writeFileSync.call(null, p, 'x');
module.exports.viaApply = (p) => fs.writeFileSync.apply(null, [p, 'x']);
module.exports.viaReflect = (p) => Reflect.apply(fs.writeFileSync, null, [p, 'x']);`,
    "src/pure.js": `module.exports.sliceCall = function() { return Array.prototype.slice.call(arguments); };
module.exports.hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
module.exports.mapCall = (o) => Array.prototype.map.call(o, (x) => x);`,
    "src/proj.js": `function doWrite(p) { require('fs').writeFileSync(p, 'x'); }
module.exports.viaProjCall = (p) => doWrite.call(null, p);`,   // a PROJECT fn via .call → edge, effect propagates
  });
  const { report } = scan(d, "--allow-js");
  const inf = (fn) => entry(report, fn)?.inferred ?? [];
  for (const fn of ["src.eff.viaCall", "src.eff.viaApply", "src.eff.viaReflect"])
    check(`reflective invoke of fs.writeFileSync (${fn.split(".").pop()}) → Fs`, inf(fn).includes("Fs"), JSON.stringify(entry(report, fn)));
  check("reflective invoke of a PURE builtin (`[].slice.call`, `hasOwnProperty.call`, `[].map.call`) stays PURE — no over-disclosure",
        entry(report, "src.pure.sliceCall") == null && entry(report, "src.pure.hasOwn") == null && entry(report, "src.pure.mapCall") == null,
        JSON.stringify([entry(report, "src.pure.sliceCall"), entry(report, "src.pure.hasOwn"), entry(report, "src.pure.mapCall")]));
  check("a PROJECT function invoked via `.call` still edges (its Fs propagates)", inf("src.proj.viaProjCall").includes("Fs"));
}

// ── TAGGED-TEMPLATE calls (`sql`…``): a corpus-probe find. The template-literal SQL clients (postgres.js /
// @vercel/postgres / slonik) EXECUTE via the tag → Db; the tagged-template arm previously only edged a LOCAL tag,
// so an external tag got neither its κ effect nor the κ-ledger `invisible` disclosure a regular external call gets
// (silent-pure). Now it classifies the external tag exactly like a regular call; a builtin tag (String.raw) is
// pure (no fabrication). ─────────────────────────────────────────────────────────────────────────────────────
if (blk()) {
  const d = project({
    "node_modules/postgres/package.json": JSON.stringify({ name: "postgres", version: "3.4.0", main: "index.js", types: "index.d.ts" }),
    "node_modules/postgres/index.d.ts": `declare function postgres(url?: string): postgres.Sql;
declare namespace postgres { interface Sql { (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>; end(): Promise<void>; } }
export = postgres;`,
    "node_modules/postgres/index.js": "module.exports = () => () => Promise.resolve([]);",
    "node_modules/mytag/package.json": JSON.stringify({ name: "mytag", version: "1.0.0", main: "i.js", types: "i.d.ts" }),
    "node_modules/mytag/i.d.ts": "export declare function mytag(s: TemplateStringsArray, ...v: unknown[]): string;",
    "node_modules/mytag/i.js": "module.exports.mytag = (s) => s.join('');",
    "src/db.ts": `import postgres from 'postgres';
const sql = postgres(process.env.DB_URL);
export function q(id: number) { return sql\`SELECT * FROM users WHERE id = \${id}\`; }`,
    "src/tag.ts": `import { mytag } from 'mytag';
export function unmodeledTag(x: number) { return mytag\`hi \${x}\`; }
export function rawTag(x: number) { return String.raw\`hi \${x}\`; }`,
  });
  const { report } = scan(d);
  check("tagged-template SQL client (postgres.js `sql`…``) → Db, not silent-pure",
        (entry(report, "src.db.q")?.inferred ?? []).includes("Db"), JSON.stringify(entry(report, "src.db.q")));
  check("an UNMODELED tagged template → κ-ledger `invisible` disclosure, never silent-pure",
        (entry(report, "src.tag.unmodeledTag")?.invisible ?? []).includes("mytag"), JSON.stringify(entry(report, "src.tag.unmodeledTag")));
  check("a builtin tag (`String.raw`) stays PURE (no fabrication)",
        entry(report, "src.tag.rawTag") == null, JSON.stringify(entry(report, "src.tag.rawTag")));
}

// ── `globalThis.process.env` / `global.process.env` — the SAME env object reached off the global (isomorphic
// code, often `(globalThis as any).process.env`). Read AND write are Env; a project-local `globalThis` shadow or
// an unrelated `obj.process.env` stays pure (no fabrication). ─────────────────────────────────────────────────
if (blk()) {
  const d = project({
    "src/g.ts": `export function readGT() { return globalThis.process.env.HOME; }
export function writeGT(k: string) { globalThis.process.env[k] = 'x'; }
export function castGlobal() { return (global as any).process.env.HOME; }`,
    "src/neg.ts": `const gt = { process: { env: { HOME: '/x' } } };
export function shadowed() { const globalThis = gt; return globalThis.process.env.HOME; }
export function unrelated(o: { process: { env: Record<string,string> } }) { return o.process.env.HOME; }`,
  });
  const { report } = scan(d);
  const isEnv = (fn) => (entry(report, fn)?.inferred ?? []).includes("Env");
  check("globalThis.process.env READ → Env", isEnv("src.g.readGT"), JSON.stringify(entry(report, "src.g.readGT")));
  check("globalThis.process.env WRITE → Env", isEnv("src.g.writeGT"), JSON.stringify(entry(report, "src.g.writeGT")));
  check("(global as any).process.env → Env (cast unwrapped)", isEnv("src.g.castGlobal"), JSON.stringify(entry(report, "src.g.castGlobal")));
  check("GUARD: a project-local `globalThis` shadow does NOT fabricate Env, nor an unrelated `obj.process.env`",
        entry(report, "src.neg.shadowed") == null && entry(report, "src.neg.unrelated") == null,
        JSON.stringify([entry(report, "src.neg.shadowed"), entry(report, "src.neg.unrelated")]));
}

// ── the SAME globalThis.process gap for the process.* global CALLS: `globalThis.process.hrtime()` → Clock,
// `global.process.send()` → Ipc (a project `const process` shadow stays pure). ───────────────────────────────
if (blk()) {
  const d = project({
    "src/g.ts": `export function hr() { return globalThis.process.hrtime(); }
export function hrBig() { return globalThis.process.hrtime.bigint(); }
export function snd(m: unknown) { return (global as any).process.send(m); }`,
    "src/neg.ts": `const process = { hrtime: () => [0, 0], send: (_: unknown) => true };
export function shadowHr() { return process.hrtime(); }
export function shadowSend(m: unknown) { return process.send(m); }`,
  });
  const { report } = scan(d);
  const has = (fn, e) => (entry(report, fn)?.inferred ?? []).includes(e);
  check("globalThis.process.hrtime() → Clock", has("src.g.hr", "Clock"), JSON.stringify(entry(report, "src.g.hr")));
  check("globalThis.process.hrtime.bigint() → Clock", has("src.g.hrBig", "Clock"));
  check("global.process.send() → Ipc", has("src.g.snd", "Ipc"), JSON.stringify(entry(report, "src.g.snd")));
  check("GUARD: a project-local `const process` shadow does NOT fabricate Clock/Ipc",
        !has("src.neg.shadowHr", "Clock") && !has("src.neg.shadowSend", "Ipc"),
        JSON.stringify([entry(report, "src.neg.shadowHr"), entry(report, "src.neg.shadowSend")]));
}

// @types/X (DefinitelyTyped) maps to the RUNTIME package X so the curated κ tier (keyed by runtime names)
// fires — a curated package typed via @types must NOT read silent-pure. Corpus find: `pool.query()` reported
// pure because the decl resolved to `@types/pg` (not `pg`), so the pg→Db rule never matched. A real TS
// Postgres app MUST have @types/pg installed (pg ships no types), so this was a live silent under-report.
if (blk()) {
  const d = project({
    "node_modules/pg/package.json": JSON.stringify({ name: "pg", version: "8.0.0", main: "index.js" }),
    "node_modules/pg/index.js": "module.exports = {};",
    "node_modules/@types/pg/index.d.ts": "export declare class Pool { query(sql: string): Promise<any>; }",
    "src/a.ts": `import { Pool } from "pg";
export function q(p: Pool) { return p.query("SELECT 1"); }`,
  });
  const { report } = scan(d);
  check("@types/pg maps to pg → pool.query() is Db (not silent-pure; DefinitelyTyped curated mapping)",
        entry(report, "src.a.q")?.inferred.includes("Db"), JSON.stringify(entry(report, "src.a.q")));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CLI / GATE BEHAVIOUR MATRIX — assert the real stdout/stderr/exit of `node scan.mjs …` and
// `node query.mjs …`. This session's shipped bugs lived in the CLI/gate/adversarial layer (the
// single-dash flag, the whatif/parsepolicy unreadable-policy exit, the --json purity), so this
// section pins the WHOLE surface, not just the firing-gate happy path covered above (§3, §3a, §3b).
// Helpers spawn the bin and return the raw {status,stdout,stderr}; assertions are on those three.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const runScan = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), ...a], { encoding: "utf8" });
const runQuery = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), ...a], { encoding: "utf8" });
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));

// ── CLI-1. bare scan → reports files written, exit 0 (the default, file-writing mode) ─────────────
if (blk()) {
  const d = project({ "src/a.ts": `import * as fsm from "node:fs";\nexport function f(): void { fsm.readFileSync("/x"); }` });
  const r = runScan(d);
  check("bare scan exits 0 and WRITES the report files to .candor/", r.status === 0
        && fs.existsSync(path.join(d, ".candor", "report.json"))
        && fs.existsSync(path.join(d, ".candor", "report.callgraph.json")), `status=${r.status} stderr=${r.stderr?.slice(0, 120)}`);
  // bare scan reports human progress on stderr (the §2 envelope is NOT dumped to stdout without --json)
  check("bare scan: stdout is not the JSON envelope (file-writing mode, not --json)",
        !r.stdout.includes('"functions"'), r.stdout.slice(0, 120));
}

// ── CLI-2. --json + a CLEAN policy → pure JSON envelope on stdout, exit 0 (the gate passes) ───────
// §3a already covers --json (envelope shape, no files) and --json + a VIOLATING policy (exit 1,
// stderr-only violations). The missing leg is the clean-pass: a satisfied gate must stay exit 0 with
// stdout still pure JSON — never a spurious exit 1, never a violation line on a green run.
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";\nexport function save(db: DatabaseSync): void { db.exec("UPDATE ledger SET v = 1"); }`,
    "policy": "allow Db in db ledger\n",  // the only table touched (ledger) IS sanctioned → clean
  });
  const r = runScan(d, "--json", "--policy", path.join(d, "policy"));
  check("--json + a CLEAN policy exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(0, 160)}`);
  let env = null; try { env = JSON.parse(r.stdout); } catch { /* null → check below fails with raw stdout */ }
  check("--json + a CLEAN policy: stdout is the PURE §2 envelope (no [AS-EFF-…] leak)",
        env !== null && Array.isArray(env.functions) && !r.stdout.includes("[AS-EFF-"), r.stdout.slice(0, 160));
}

// ── CLI-3. --policy <clean> (non-JSON) → exit 0; the gate is silent on a satisfied policy ─────────
if (blk()) {
  const d = project({
    "src/db.ts": `import { DatabaseSync } from "node:sqlite";\nexport function save(db: DatabaseSync): void { db.exec("UPDATE ledger SET v = 1"); }`,
    "policy": "allow Db in db ledger\n",  // the only table touched (ledger) IS sanctioned → clean
  });
  const r = runScan(d, "--policy", path.join(d, "policy"));
  check("--policy <clean> exits 0 (a satisfied gate is green)", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(0, 160)}`);
  check("--policy <clean>: no [AS-EFF-…] violation line is printed on a clean run",
        !r.stdout.includes("[AS-EFF-") && !r.stderr.includes("[AS-EFF-"), `${r.stdout.slice(0, 120)} / ${r.stderr.slice(0, 120)}`);
}

// ── CLI-4. --version / -V → `candor-ts <ver> (spec <X>)`, exit 0 (both spellings; offline) ─────────
if (blk()) {
  for (const flag of ["--version", "-V"]) {
    const r = runScan(flag);
    const line1 = r.stdout.split("\n")[0];
    check(`scan ${flag} → 'candor-ts <ver> (spec <X>)' on line 1, exit 0`,
          r.status === 0 && new RegExp(`^candor-ts ${PKG.version.replace(/\./g, "\\.")} \\(spec [0-9.]+\\)$`).test(line1),
          `status=${r.status} line1=${JSON.stringify(line1)}`);
  }
}

// ── CLI-5. --help / -h → usage (the real flag list), exit 0 (both spellings; `-h`'s single dash
// must reach the print-and-exit mode, not be eaten by the unknown-flag arm) ─────────────────────
if (blk()) {
  for (const flag of ["--help", "-h"]) {
    const r = runScan(flag);
    check(`scan ${flag} → usage with the real flags, exit 0`,
          r.status === 0 && /USAGE\n/.test(r.stdout) && /--policy/.test(r.stdout) && /--json/.test(r.stdout),
          `status=${r.status} ${r.stdout.slice(0, 120)}`);
  }
}

// ── CLI-6. unknown flags: a DOUBLE-dash --bogus and a generic SINGLE-dash -x both exit 2 ───────────
// §3b pins `-policy` (a single-dash near-miss of a real flag). These pin the general arms: any
// unrecognized flag — long OR short — is a hard exit-2 unknown-flag error, never a silent scan
// target. The single-dash case is the SHIPPED FIX (a `-x` once fell through to "scan path -x").
if (blk()) {
  const bogus = runScan("--bogus");
  check("scan --bogus (unknown long flag) exits 2 with an unknown-flag error",
        bogus.status === 2 && /unknown flag --bogus/.test(bogus.stderr), `status=${bogus.status} ${bogus.stderr.slice(0, 120)}`);
  const dashX = runScan("-x");
  check("scan -x (unknown SHORT flag) exits 2 — NOT read as a positional scan target (the single-dash fix)",
        dashX.status === 2 && /unknown flag -x/.test(dashX.stderr), `status=${dashX.status} ${dashX.stderr.slice(0, 120)}`);
}

// ── CLI-7. ADVERSARIAL scan inputs: no crash, an honest (loud) disclosure on each pathology ───────
if (blk()) {
  // (a) a syntactically-broken .ts must not throw an uncaught TS-compiler stack — degrade to a report.
  const broken = project({ "src/b.ts": `export function broken(: void { return\n` }); // unbalanced/garbage
  const rb = runScan(broken);
  check("adversarial: a syntactically-broken .ts does not crash (graceful exit 0|1|2, report written)",
        [0, 1, 2].includes(rb.status) && !/\bat \w+ \(.*scan\.mjs/.test(rb.stderr)
          && fs.existsSync(path.join(broken, ".candor", "report.json")),
        `status=${rb.status} ${rb.stderr.slice(0, 200)}`);

  // (b) deps DECLARED but no node_modules → the LOUD warning path (effects through unresolved pkgs are
  // disclosed, not silently dropped) — must warn on stderr and still exit 0.
  const noMods = project({
    "package.json": `{"name":"x","dependencies":{"express":"^4.0.0"}}`,
    "src/a.ts": `import e from "express";\nexport function f() { return e(); }\n`,
  });
  const rn = runScan(noMods);
  check("adversarial: deps declared but no node_modules → LOUD warning on stderr, exit 0 (not silently pure)",
        rn.status === 0 && /no node_modules/.test(rn.stderr) && /npm install/.test(rn.stderr),
        `status=${rn.status} ${rn.stderr.slice(0, 200)}`);

  // (c) --allow-js on PLAIN JS (no TS at all) → analyzes it, exit 0, effect honestly surfaced, no crash.
  const pj = project({ "src/a.js": `const fs = require("fs");\nmodule.exports.r = function () { return fs.readFileSync("/x"); };\n` });
  const rj = runScan(pj, "--allow-js");
  const pjRep = fs.existsSync(path.join(pj, ".candor", "report.json"))
    ? JSON.parse(fs.readFileSync(path.join(pj, ".candor", "report.json"), "utf8")) : null;
  check("adversarial: --allow-js on plain JS does not crash and surfaces the effect (src.a.r → Fs)",
        rj.status === 0 && pjRep?.functions.some((e) => e.fn === "src.a.r" && e.inferred.includes("Fs")),
        `status=${rj.status} ${rj.stderr.slice(0, 160)}`);
}

// ── CLI-8. query.mjs print-and-exit modes + unknown command (the FULL, non-stale usage) ───────────
if (blk()) {
  for (const flag of ["--version", "-V"]) {
    const r = runQuery(flag);
    check(`query ${flag} → version banner, exit 0`,
          r.status === 0 && /candor-ts-query [0-9]/.test(r.stdout.split("\n")[0]), `status=${r.status} ${r.stdout.slice(0, 80)}`);
  }
  for (const flag of ["--help", "-h"]) {
    const r = runQuery(flag);
    check(`query ${flag} → usage, exit 0`, r.status === 0 && /USAGE\n {2}candor-ts-query <action>/.test(r.stdout), `status=${r.status} ${r.stdout.slice(0, 80)}`);
  }
  // unknown command → exit 2 AND the FULL subcommand list (the regression was a stale 6-item hand-list;
  // assert several real subcommands are present so a drift back to a partial list fails here).
  const unk = runQuery("bogus-cmd");
  check("query <unknown command> exits 2 and prints the FULL (non-stale) usage with every subcommand",
        unk.status === 2 && /unknown command 'bogus-cmd'/.test(unk.stderr)
          && ["show", "where", "callers", "whatif", "reachable", "impact", "containment", "diff", "gains", "path", "parsepolicy"]
            .every((c) => new RegExp(`\\b${c}\\b`).test(unk.stderr)),
        unk.stderr.slice(0, 240));
  // no command at all (cmd === undefined) → also the full usage, exit 2
  const none = runQuery();
  check("query with NO command exits 2 with the full usage", none.status === 2 && /USAGE: candor-ts-query/.test(none.stderr),
        `status=${none.status} ${none.stderr.slice(0, 120)}`);
}

// ── CLI-9. query.mjs against a CORRUPT/TRUNCATED report → FAIL LOUD, never a false all-clear ──
// A report that is FOUND but wholly fails to parse must exit 2 with the corruption DISCLOSED on stderr —
// NOT exit 0 with an empty answer. Emptiness reads as "no effects": `show`/`map` returning [] / {} at
// exit 0 over a corrupt report is the §4 cardinal-sin false all-clear (a gate on `map` would PASS). All
// four engines now die loud here (candor-rust load_entries_loud; java throws; swift → no-report). The
// original no-crash guarantee is kept: the exit is a clean console.error, NOT a leaked JSON.parse stack.
if (blk()) {
  const d = scratch("candor-ts-qcorrupt-");
  fs.writeFileSync(path.join(d, "rep.json"), `{ "candor": {}, "functions": [ { "fn": "x.`); // truncated mid-object
  const prefix = path.join(d, "rep");
  const r = runQuery("show", prefix, "x");
  check("query show on a CORRUPT report: FAILS LOUD (exit 2), no empty all-clear, no uncaught throw",
        r.status === 2 && r.stdout.trim() === ""
          && !/\bat \w+ \(.*\.mjs/.test(r.stderr), `status=${r.status} stdout=${r.stdout.slice(0, 80)} stderr=${r.stderr.slice(0, 160)}`);
  check("query show on a CORRUPT report: the corruption is DISCLOSED on stderr (not silently empty)",
        /failed to parse/.test(r.stderr) && /refusing to report an empty/.test(r.stderr), r.stderr.slice(0, 240));
  // map (a different loadReport consumer) must likewise die loud — an empty {} at exit 0 false-passes a gate.
  const rm = runQuery("map", prefix);
  check("query map on a CORRUPT report also FAILS LOUD (exit 2), no {} all-clear, no stack trace",
        rm.status === 2 && rm.stdout.trim() === "" && !/\bat \w+ \(.*\.mjs/.test(rm.stderr),
        `status=${rm.status} ${rm.stderr.slice(0, 160)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── CLI-10. the query.mjs arms with no in-repo behavioral coverage (TESTING.md §2.1/§2.5) ───────────
// Conformance exercises some of these cross-engine, but an engine-local regression stays green in this
// repo's CI until the spec repo happens to run (§3) — so each arm gets a CLI-level spawn here with its
// EXACT exit code (1 vs 2 is load-bearing: violation vs could-not-evaluate).
if (blk()) {
  const d = scratch("candor-cliarms-");
  const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rep = (fns) => JSON.stringify({ candor: { version: "ttttttt", spec: "0.23" }, functions: fns });
  fs.writeFileSync(path.join(d, "r.json"), rep([
    { fn: "app.db.save", inferred: ["Db"], direct: ["Db"], loc: "db.ts:1", tables: ["orders"] },
    { fn: "app.web.handler", inferred: ["Db"], direct: [], entryPoint: true, loc: "web.ts:1" },
  ]));
  fs.writeFileSync(path.join(d, "r.callgraph.json"), JSON.stringify({
    "app.web.handler": ["app.db.save"], "app.db.save": [],
  }));
  const P = path.join(d, "r");

  // containment (report form): Db fully contained in the db layer, exit 0. §3.3.1 ⟨0.10⟩: a single bare
  // positional is now the BASELINE (the ratchet), so report-mode passes the report via `--report` — the
  // migrated form (the old bare `containment <prefix>` re-read the prefix as the report and silently
  // dropped to non-gating mode; that gate-off is the bug fixed here, so report-mode is `--report <loc>`).
  const cont = runQuery("containment", "--report", P);
  const contJ = JSON.parse(cont.stdout);
  check("CLI containment: the §6.1 dispersion report (Db 100% in `db`), exit 0",
        cont.status === 0 && contJ.contained.length === 1
          && contJ.contained[0].effect === "Db" && contJ.contained[0].containmentPct === 100
          && contJ.contained[0].owner === "db" && contJ.contained[0].layers === 1,
        `status=${cont.status} ${cont.stdout.slice(0, 160)}`);

  // containment ratchet (AS-EFF-010): a NEW layer for a contained effect → leak, exit 1
  fs.writeFileSync(path.join(d, "leaky.json"), rep([
    { fn: "app.db.save", inferred: ["Db"], direct: ["Db"] },
    { fn: "app.web.handler", inferred: ["Db"], direct: ["Db"], entryPoint: true }, // Db leaked into web
  ]));
  const ratchet = runQuery("containment", path.join(d, "leaky"), P);
  check("CLI containment ratchet: a new layer leaks (Db → web) and exits 1",
        ratchet.status === 1 && JSON.parse(ratchet.stdout).leaks.includes("Db → web"),
        `status=${ratchet.status} ${ratchet.stdout.slice(0, 120)}`);
  const clean = runQuery("containment", P, P);
  check("CLI containment ratchet: self-vs-self is leak-free, exit 0",
        clean.status === 0 && JSON.parse(clean.stdout).leaks.length === 0, `status=${clean.status}`);
  // fail CLOSED on an unreadable baseline: exit 2, never a bogus everything-leaked exit 1
  const noBase = runQuery("containment", P, path.join(d, "no-such-baseline"));
  check("CLI containment ratchet: a missing baseline fails closed (exit 2, not a bogus leak wall)",
        noBase.status === 2 && /no report at baseline prefix/.test(noBase.stderr),
        `status=${noBase.status} ${noBase.stderr.slice(0, 120)}`);

  // impact: the backward blast radius, §3.1 shape, exit 0
  const imp = runQuery("impact", P, "save");
  const impJ = JSON.parse(imp.stdout);
  check("CLI impact: {fn, affectedCount, affected, entryPoints} with the entry point named, exit 0",
        imp.status === 0 && impJ.fn === "app.db.save" && impJ.affectedCount === 1
          && impJ.affected.includes("app.web.handler")
          && impJ.entryPoints.some((e) => e.fn === "app.web.handler" && e.inferred.includes("Db")),
        `status=${imp.status} ${imp.stdout.slice(0, 160)}`);

  // #8 output mode (corpus-audit): the DATA verbs (where/callers/show/map/…) default to PROSE at a TTY and
  // JSON when piped or `--json` — so interactive `candor where Db` reads like candor-java instead of dumping
  // JSON, while a pipe (this harness) still gets JSON so machine consumers are untouched. `--json` forces
  // JSON (it used to be silently ignored); `--text`/`--human` forces prose.
  {
    const wj = runQuery("where", "Db", "--report", P);              // piped (not a TTY) → JSON default
    check("#8 where: piped output stays JSON (machine consumers untouched)",
          wj.status === 0 && JSON.parse(wj.stdout).effect === "Db", wj.stdout.slice(0, 120));
    const wt = runQuery("where", "Db", "--report", P, "--text");    // forced prose
    check("#8 where --text: human prose, not JSON",
          wt.status === 0 && wt.stdout.startsWith("candor where Db —") && !wt.stdout.includes("{"),
          JSON.stringify(wt.stdout).slice(0, 160));
    const wjson = runQuery("where", "Db", "--report", P, "--json"); // --json now HONORED (was ignored)
    check("#8 where --json: JSON selected explicitly",
          wjson.status === 0 && JSON.parse(wjson.stdout).effect === "Db", wjson.stdout.slice(0, 120));
    const mt = runQuery("map", "--report", P, "--text");
    check("#8 map --text: prose header, not JSON",
          mt.stdout.startsWith("candor map —") && !mt.stdout.includes("{"), JSON.stringify(mt.stdout).slice(0, 120));
    // review-fix: --text/--human must be STRIPPED from positionals — else `show --text <fn>` treats `--text`
    // as the query, drops the real fn, and prints a false "no such function" all-clear at exit 0 (cardinal sin).
    const st = runQuery("show", "--text", "save", "--report", P);   // --text BEFORE the <fn> query
    check("#8 show --text <fn> (flag before query): finds the real fn, no false all-clear",
          st.status === 0 && st.stdout.includes("app.db.save") && !/no effectful function/.test(st.stdout),
          `status=${st.status} ${JSON.stringify(st.stdout).slice(0, 160)}`);
    const ct = runQuery("callers", "--human", "save", "--report", P);
    check("#8 callers --human <fn> (flag before query): resolves the real fn",
          ct.status === 0 && ct.stdout.includes("save"), `status=${ct.status} ${ct.stdout.slice(0, 120)}`);
  }

  // #3 target validation (corpus-audit): a typo'd EFFECT or a nonexistent FUNCTION is a LOUD error (exit 2),
  // like path/impact already are — never a false-empty result at exit 0 (reads as an authoritative all-clear
  // for a question that was never actually posed — the §4 cardinal sin). A VALID effect that's simply absent
  // stays a legitimate 0-result at exit 0.
  {
    const bad = runQuery("where", "Netwerk", "--report", P);
    check("#3 where <typo effect> → exit 2, names the known set",
          bad.status === 2 && /unknown effect 'Netwerk'/.test(bad.stderr) && /Net, Fs, Db/.test(bad.stderr),
          `status=${bad.status} ${bad.stderr.slice(0, 120)}`);
    const absent = runQuery("where", "Clipboard", "--report", P);   // valid effect, not in this report
    check("#3 where <valid-but-absent effect> → exit 0 (a real 0-result, NOT an error)",
          absent.status === 0 && JSON.parse(absent.stdout).effect === "Clipboard"
            && JSON.parse(absent.stdout).directly.length === 0, `status=${absent.status}`);
    const noFn = runQuery("callers", "no_such_function_xyz", "--report", P);
    check("#3 callers <nonexistent fn> → exit 2 (not empty at exit 0)",
          noFn.status === 2 && /no function matching 'no_such_function_xyz'/.test(noFn.stderr),
          `status=${noFn.status} ${noFn.stderr.slice(0, 120)}`);
    const realFn = runQuery("callers", "save", "--report", P);      // app.db.save exists
    check("#3 callers <real fn> → exit 0, resolves normally",
          realFn.status === 0 && JSON.parse(realFn.stdout).of.some((f) => f.endsWith("save")),
          `status=${realFn.status} ${realFn.stdout.slice(0, 120)}`);
  }

  // path --json: forward provenance to the direct source, the §3.1 shape (conformance PART 5 pins it
  // four-way — the human default below must NOT change it). --json is now REQUIRED to select JSON.
  const pth = runQuery("path", P, "handler", "Db", "--json");
  const pthJ = JSON.parse(pth.stdout);
  check("CLI path --json: handler → save with the source flagged, exit 0 (the pinned shape, UNCHANGED)",
        pth.status === 0 && pthJ.effect === "Db" && pthJ.fn === "app.web.handler"
          && pthJ.path.map((s) => s.fn).join(">") === "app.web.handler>app.db.save"
          && pthJ.path[1].source === true && pthJ.path[0].source === false
          && pthJ.path[1].loc === "db.ts:1",
        `status=${pth.status} ${pth.stdout.slice(0, 160)}`);

  // path HUMAN (no --json): the indented provenance chain, BYTE-IDENTICAL to the Rust/Java reference.
  // The surface opener suggests `candor path <fn> <effect>`, so the default output must be readable —
  // NOT raw JSON. Header + one indented line per hop; the source annotated `[<effect> source @ <loc>]`.
  const pthH = runQuery("path", P, "handler", "Db");
  const expectHuman = "candor path — how `app.web.handler` comes to perform Db:\n\n"
    + "  app.web.handler\n"
    + "    → app.db.save   [Db source @ db.ts:1]\n";
  check("CLI path (human): the indented chain, NOT JSON — byte-identical to the Rust reference",
        pthH.status === 0 && pthH.stdout === expectHuman && !pthH.stdout.includes("{"),
        `status=${pthH.status} stdout=${JSON.stringify(pthH.stdout).slice(0, 200)}`);

  // the accepted 0.11 default change (human chain replaced JSON as the no-flag output) leaves a ONE-line
  // stderr breadcrumb, so a pre-0.11 pipeline that broke on the new default is pointed at --json.
  check("CLI path (human): the 0.11 default-change breadcrumb prints ONCE, on stderr only",
        (pthH.stderr.match(/tip — `--json` selects the machine-readable path shape \(the default before 0\.11\)/g) || []).length === 1
          && !pthH.stdout.includes("tip —"),
        `stderr=${JSON.stringify(pthH.stderr).slice(0, 240)}`);
  check("CLI path --json: NO breadcrumb tip (the machine branch is untouched)",
        !/tip — `--json`/.test(pth.stderr), pth.stderr.slice(0, 160));

  // header/chain agreement: the human render resolved its START twice over two DIFFERENT name sets —
  // the REPORT names (header + inferred wording) and the CALLGRAPH keys (corePath's chain) — so the
  // query "save" could describe `app.db.save` in the header yet trace `app.cache.save` in the graph:
  // a misleading "not statically traceable" over a perfectly traceable fn. The report-resolved start
  // is now passed to corePath (an exact name resolves identically in both sets).
  fs.writeFileSync(path.join(d, "dres.json"), JSON.stringify({ functions: [
    { fn: "app.db.save", inferred: ["Db"], direct: ["Db"], loc: "db.ts:1" },
  ] }));
  // app.cache.save comes FIRST among the callgraph keys, so the raw query "save" resolved to IT there.
  fs.writeFileSync(path.join(d, "dres.callgraph.json"), JSON.stringify({ "app.cache.save": [], "app.db.save": [] }));
  const pthD = runQuery("path", "save", "Db", "--report", path.join(d, "dres"));
  check("CLI path (human): header and chain resolve the SAME fn (report + callgraph name sets can't disagree)",
        pthD.status === 0 && pthD.stdout.includes("how `app.db.save` comes to perform Db")
          && /app\.db\.save {3}\[Db source @ db\.ts:1\]/.test(pthD.stdout)
          && !/not statically traceable/.test(pthD.stdout),
        `status=${pthD.status} stdout=${JSON.stringify(pthD.stdout).slice(0, 240)}`);

  // path (human) when the effect isn't performed → Rust's "does not perform  (inferred: [...])" wording,
  // exit 0 (an honest non-answer, NOT an error). `save` performs Db but not Net.
  const pthN = runQuery("path", P, "save", "Net");
  check("CLI path (human): a not-performed effect prints the `does not perform  (inferred: …)` line, exit 0",
        pthN.status === 0 && pthN.stdout === `app.db.save does not perform Net  (inferred: ["Db"])\n`,
        `status=${pthN.status} stdout=${JSON.stringify(pthN.stdout).slice(0, 200)}`);
  // and its --json counterpart still emits the honest empty-path object — the shape is UNCHANGED by this
  // fix (corePath is untouched; it echoes the raw query token in `fn` for an empty path, as it always has).
  const pthNJ = runQuery("path", P, "save", "Net", "--json");
  check("CLI path --json: a not-performed effect emits {effect,fn,path:[]} (the pinned empty-path shape, UNCHANGED)",
        pthNJ.status === 0 && eqJson(JSON.parse(pthNJ.stdout), { effect: "Net", fn: "save", path: [] }),
        `status=${pthNJ.status} ${pthNJ.stdout.slice(0, 160)}`);

  // gains: the supply-chain alarm + the §2.1 version-skew disclosure
  fs.writeFileSync(path.join(d, "oldbase.json"), JSON.stringify({ candor: { version: "aaaaaaa", spec: "0.23" },
    functions: [{ fn: "app.db.save", inferred: ["Db"], direct: ["Db"] }] }));
  fs.writeFileSync(path.join(d, "cur2.json"), JSON.stringify({ candor: { version: "bbbbbbb", spec: "0.23" },
    functions: [{ fn: "app.db.save", inferred: ["Db", "Exec"], direct: ["Db", "Exec"] }] }));
  const g = runQuery("gains", path.join(d, "cur2"), path.join(d, "oldbase"));
  const gJ = JSON.parse(g.stdout);
  check("CLI gains: the gained effect + per-function detail + provenance fields, exit 0",
        g.status === 0 && eqJson(gJ.gained, ["Exec"]) && gJ.byFunction.some((x) => x.fn === "app.db.save" && x.effect === "Exec" && x.origin === "existing")
          && gJ.baseline_version === "aaaaaaa" && gJ.engine_version === "bbbbbbb",
        `status=${g.status} ${g.stdout.slice(0, 160)}`);
  check("CLI gains: a producing-build mismatch is DISCLOSED on stderr (reclassify vs regression ambiguity)",
        /⚠/.test(g.stderr) && /reclassifying/.test(g.stderr), g.stderr.slice(0, 160));
  fs.writeFileSync(path.join(d, "samebase.json"), JSON.stringify({ candor: { version: "bbbbbbb", spec: "0.23" },
    functions: [{ fn: "app.db.save", inferred: ["Db"], direct: ["Db"] }] }));
  const g2 = runQuery("gains", path.join(d, "cur2"), path.join(d, "samebase"));
  check("CLI gains: same producing build → no mismatch note", g2.status === 0 && !/⚠/.test(g2.stderr),
        g2.stderr.slice(0, 120));

  // ⟨spec 0.12 staged⟩ byFunction[].origin, keyed on the BASELINE CALLGRAPH (reports omit pure fns, §2):
  // a baseline-pure fn that now does Net is "existing" (the supply-chain attack signal, a different alarm
  // from a "new" fn); no baseline callgraph at all → "unknown" (undecidable, disclosed not guessed).
  fs.writeFileSync(path.join(d, "obase.json"), JSON.stringify({ candor: { version: "ccccccc", spec: "0.23" },
    functions: [{ fn: "m.g", inferred: ["Fs"], direct: ["Fs"] }] }));
  fs.writeFileSync(path.join(d, "obase.callgraph.json"), JSON.stringify({ "m.f": ["m.g"], "m.g": [] }));
  fs.writeFileSync(path.join(d, "ocur.json"), JSON.stringify({ candor: { version: "ccccccc", spec: "0.23" },
    functions: [{ fn: "m.f", inferred: ["Net"], direct: ["Net"] }, { fn: "m.g", inferred: ["Fs"], direct: ["Fs"] },
                { fn: "m.h", inferred: ["Net"], direct: ["Net"] }] }));
  const originOf = (j, fn) => j.byFunction.find((x) => x.fn === fn)?.origin;
  const gO = JSON.parse(runQuery("gains", path.join(d, "ocur"), path.join(d, "obase")).stdout);
  check("CLI gains: origin — baseline-pure callgraph node gaining Net is 'existing', an unseen fn is 'new'",
        originOf(gO, "m.f") === "existing" && originOf(gO, "m.h") === "new",
        JSON.stringify(gO.byFunction));
  fs.unlinkSync(path.join(d, "obase.callgraph.json"));
  const gU = JSON.parse(runQuery("gains", path.join(d, "ocur"), path.join(d, "obase")).stdout);
  check("CLI gains: origin — no baseline callgraph → 'unknown' for report-absent fns",
        originOf(gU, "m.f") === "unknown" && originOf(gU, "m.h") === "unknown",
        JSON.stringify(gU.byFunction));

  // a PARTIAL baseline callgraph (a matched sidecar failed to parse — loadCallgraph drops its edges,
  // discloses on stderr, and tags the graph `partial`) must NOT let a dropped file's fns read as "new":
  // absence from the surviving edges proves nothing, so origin downgrades to "unknown" — never the
  // supply-chain attack signal ("existing" fn newly effectful) relabeled as a benign new feature.
  fs.writeFileSync(path.join(d, "obase.callgraph.json"), "{ truncated-mid-write");
  const gPart = runQuery("gains", path.join(d, "ocur"), path.join(d, "obase"));
  const gP = JSON.parse(gPart.stdout);
  check("CLI gains: origin — a PARTIAL baseline callgraph → 'unknown', never a fabricated 'new'",
        originOf(gP, "m.f") === "unknown" && originOf(gP, "m.h") === "unknown"
          && /callgraph .* failed to parse/.test(gPart.stderr),
        `${JSON.stringify(gP.byFunction)} stderr=${gPart.stderr.slice(0, 120)}`);
  fs.unlinkSync(path.join(d, "obase.callgraph.json"));

  // ⟨0.15 staged⟩ gains coverage disclosure (COVERAGE-DESIGN.md §3): the CURRENT report's `coverage`
  // envelope rides along + a name-level `coverageDelta` vs the baseline; every OTHER field (gained /
  // byFunction / provenance) is unchanged by it, and a coverage-free comparison stays byte-identical
  // to the ⟨0.14⟩ shape (no key at all — the checks above already parse those outputs strictly).
  fs.writeFileSync(path.join(d, "covcur.json"), JSON.stringify({ candor: { version: "ddddddd", spec: "0.23" },
    functions: [{ fn: "m.f", inferred: ["Net"], direct: ["Net"] }],
    coverage: { uncovered: [{ name: "blinddep", calls: 2 }] } }));
  fs.writeFileSync(path.join(d, "covbase.json"), JSON.stringify({ candor: { version: "ddddddd", spec: "0.23" },
    functions: [] }));
  const gCov = JSON.parse(runQuery("gains", path.join(d, "covcur"), path.join(d, "covbase")).stdout);
  check("⟨0.15⟩ CLI gains: the CURRENT report's coverage envelope rides along (uncovered dep named)",
        eqJson(gCov.coverage, { uncovered: [{ name: "blinddep", calls: 2 }] }) && eqJson(gCov.gained, ["Net"]),
        JSON.stringify(gCov));
  check("⟨0.15⟩ CLI gains: a baseline WITHOUT the ledger yields the nowUncovered delta (java's field names — wire parity)",
        eqJson(gCov.coverageDelta, { nowUncovered: ["blinddep"], noLongerUncovered: [] }),
        JSON.stringify(gCov.coverageDelta));
  const gPlain = JSON.parse(runQuery("gains", path.join(d, "cur2"), path.join(d, "oldbase")).stdout);
  check("⟨0.15⟩ CLI gains: coverage-free reports carry NEITHER coverage key (byte-identical to ⟨0.14⟩)",
        !("coverage" in gPlain) && !("coverageDelta" in gPlain)
          && eqJson(Object.keys(gPlain), ["baseline_version", "engine_version", "gained", "byFunction"]),
        JSON.stringify(Object.keys(gPlain)));

  // the two-locator verbs fail LOUD on a typo'd prefix (the Rust engine's "no report files at …"
  // check, named per side): [] with hardFail=false otherwise emitted an authoritative EMPTY
  // {gained:[]} / {changes:[]} at exit 0 — a silent all-clear on the alarm/ratchet verbs.
  const gTypoC = runQuery("gains", path.join(d, "no-such-cur"), path.join(d, "oldbase"));
  check("CLI gains: a typo'd CURRENT locator exits 2 with the no-files disclosure (no empty all-clear)",
        gTypoC.status === 2 && /no report files at current prefix/.test(gTypoC.stderr) && gTypoC.stdout.trim() === "",
        `status=${gTypoC.status} ${gTypoC.stderr.slice(0, 120)}`);
  const gTypoB = runQuery("gains", path.join(d, "cur2"), path.join(d, "no-such-base"));
  check("CLI gains: a typo'd BASELINE locator exits 2, naming the baseline side",
        gTypoB.status === 2 && /no report files at baseline prefix/.test(gTypoB.stderr) && gTypoB.stdout.trim() === "",
        `status=${gTypoB.status} ${gTypoB.stderr.slice(0, 120)}`);
  const dTypoC = runQuery("diff", path.join(d, "no-such-cur"), path.join(d, "oldbase"));
  check("CLI diff: a typo'd CURRENT locator exits 2 with the no-files disclosure (no empty all-clear)",
        dTypoC.status === 2 && /no report files at current prefix/.test(dTypoC.stderr) && dTypoC.stdout.trim() === "",
        `status=${dTypoC.status} ${dTypoC.stderr.slice(0, 120)}`);
  const dTypoB = runQuery("diff", path.join(d, "cur2"), path.join(d, "no-such-base"));
  check("CLI diff: a typo'd BASELINE locator exits 2, naming the baseline side",
        dTypoB.status === 2 && /no report files at baseline prefix/.test(dTypoB.stderr) && dTypoB.stdout.trim() === "",
        `status=${dTypoB.status} ${dTypoB.stderr.slice(0, 120)}`);
  const dMissing = runQuery("diff", path.join(d, "cur2"));
  check("CLI diff: a MISSING locator is a usage error (exit 2), not a crash or an empty delta",
        dMissing.status === 2 && /usage: candor-ts-query diff/.test(dMissing.stderr),
        `status=${dMissing.status} ${dMissing.stderr.slice(0, 120)}`);

  // parsepolicy SUCCESS (only the unreadable exit-2 arm was pinned): valid JSON of the parsed grammar
  fs.writeFileSync(path.join(d, "arch.policy"), "deny Net web\nallow Fs in db /var/data\nforbid web -> db\n");
  const pp = runQuery("parsepolicy", path.join(d, "arch.policy"));
  const ppJ = JSON.parse(pp.stdout);
  check("CLI parsepolicy: a readable policy emits the parsed {deny,allow,forbid} JSON, exit 0",
        pp.status === 0 && ppJ.deny[0].scope === "web" && ppJ.allow[0].values.includes("/var/data")
          && ppJ.forbid[0].to === "db",
        `status=${pp.status} ${pp.stdout.slice(0, 160)}`);

  // whatif with NO matching fn: could-not-evaluate → exit 2 (distinct from a violation's exit 1)
  const wnm = runQuery("whatif", P, "no-such-fn-zzz", "Net");
  check("CLI whatif: no matching function exits 2 with the no-match diagnostic (not 0, not 1)",
        wnm.status === 2 && /no function matching/.test(wnm.stderr),
        `status=${wnm.status} ${wnm.stderr.slice(0, 120)}`);

  // blindspots over a report WITH unknownWhy sources (the in-repo pin; the arm ran only on clean reports)
  fs.writeFileSync(path.join(d, "bs.json"), rep([
    { fn: "app.dyn", inferred: ["Unknown"], unknownWhy: ["reflect:eval"] },
    { fn: "app.caller", inferred: ["Unknown"] },
  ]));
  fs.writeFileSync(path.join(d, "bs.callgraph.json"), JSON.stringify({ "app.caller": ["app.dyn"], "app.dyn": [] }));
  const bs = runQuery("blindspots", path.join(d, "bs"));
  const bsJ = JSON.parse(bs.stdout);
  check("CLI blindspots: the ranked sources shape over real unknownWhy sources, exit 0",
        bs.status === 0 && bsJ.totalUnknown === 2 && bsJ.sources.length === 1
          && bsJ.sources[0].fn === "app.dyn" && bsJ.sources[0].reaches === 1
          && eqJson(bsJ.sources[0].affected, ["app.caller"]),
        `status=${bs.status} ${bs.stdout.slice(0, 160)}`);

  // ⟨0.24⟩ `unverified --class`, END TO END — the CLI arm the unit test cannot reach: the verb has to LOAD
  // the callgraph sidecar, because the class set is resolved TRANSITIVELY (SPEC §6.2). `app.caller`
  // inherits its Unknown from `app.dyn` and so publishes no reason of its own (⟨0.6⟩ direct-only); the old
  // filter matched the direct field and dropped it from EVERY `--class`, `dynamic` included.
  fs.writeFileSync(path.join(d, "uv.json"), rep([
    { fn: "app.dyn", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["reflect:eval"], loc: "u.ts:1" },
    { fn: "app.caller", inferred: ["Unknown"], direct: [], loc: "u.ts:9" },
  ]));
  fs.writeFileSync(path.join(d, "uv.callgraph.json"), JSON.stringify({ "app.caller": ["app.dyn"], "app.dyn": [] }));
  fs.writeFileSync(path.join(d, "uv.policy"), "pure app\n");
  const uv = (...extra) => {
    const r = runQuery("unverified", "--report", path.join(d, "uv"), "--policy", path.join(d, "uv.policy"), ...extra);
    return { status: r.status, fns: JSON.parse(r.stdout).unverified.map((h) => h.fn).sort() };
  };
  const uvAll = uv(), uvDyn = uv("--class", "dynamic"), uvRefl = uv("--class", "reflect"), uvNat = uv("--class", "native");
  check("CLI unverified --class dynamic excludes NOTHING (the §6.2 ⟨0.24⟩ diagnostic)",
        uvAll.status === 0 && eqJson(uvAll.fns, ["app.caller", "app.dyn"]) && eqJson(uvDyn.fns, uvAll.fns),
        `all=${JSON.stringify(uvAll)} dyn=${JSON.stringify(uvDyn)}`);
  check("CLI unverified --class: the INHERITED hole is scoped by its callee's class, transitively",
        eqJson(uvRefl.fns, ["app.caller", "app.dyn"]) && eqJson(uvNat.fns, []),
        `reflect=${JSON.stringify(uvRefl.fns)} native=${JSON.stringify(uvNat.fns)}`);

  // ── ⟨0.24⟩ SPEC §6.2's `--class` VALUE GRAMMAR, end to end over EVERY verb that takes the flag ─────
  // `--class <c>[,<c>…]` is ONE comma-separated list, NOT repeatable; an unrecognised token is a usage
  // error (exit 2) naming the token and the accepted set. Before this, `--class dyanmic` exited 0 with an
  // EMPTY filter and a repeated `--class` silently took the first list — both NARROW the answer, and a
  // narrowed answer is unreadable from a genuine all-clear. Deliberately NOT the policy side's
  // drop-with-a-warning: a dropped policy token leaves the rule WIDER (loud), this left it NARROWER.
  // The MESSAGE is asserted, not just the exit code — a status-only assertion passes for the wrong reason
  // (any other arg-parse defect also exits 2), which is how a sibling engine's flag test survived its own
  // mutation today.
  const ACCEPTED = /reflect,dispatch,indirect,native,unresolved,setup/;
  const bsc = (...extra) => {
    const r = runQuery("blindspots", "--report", path.join(d, "bs"), ...extra);
    let n = null; try { n = JSON.parse(r.stdout).sources.length; } catch { /* refused ⇒ no stdout */ }
    return { status: r.status, n, err: r.stderr };
  };
  // (1) a valid single token and (2) a valid comma LIST are honoured — and the count is the control: this
  // change must alter no selection for well-formed input (bs.json: one source, `reflect:eval`).
  const gOne = bsc("--class", "reflect"), gList = bsc("--class", "reflect,native");
  const gDyn = bsc("--class", "dynamic"), gStar = bsc("--class", "*"), gNone = bsc(), gNat = bsc("--class", "native");
  check("CLI --class ⟨0.24⟩ grammar: a single token and a comma LIST are accepted and select the same source",
        gOne.status === 0 && gOne.n === 1 && gList.status === 0 && gList.n === 1 && gNone.n === 1,
        `one=${JSON.stringify(gOne)} list=${JSON.stringify(gList)} unfiltered=${gNone.n}`);
  // (3) BOTH aliases are accepted — `dynamic` is what §6.2's normative diagnostic passes, so a grammar
  // rejecting it would break that standing test; `native` is the discrimination control, proving an empty
  // result under a VALID token is exit 0 and never confusable with a refusal.
  check("CLI --class ⟨0.24⟩ grammar: `dynamic` and `*` are accepted; a valid-but-unmatched class is exit 0",
        gDyn.status === 0 && gDyn.n === 1 && gStar.status === 0 && gStar.n === 1 && gNat.status === 0 && gNat.n === 0,
        `dynamic=${JSON.stringify(gDyn)} star=${JSON.stringify(gStar)} native=${JSON.stringify(gNat)}`);
  // (4) an UNRECOGNISED token: exit 2, naming the token AND the accepted set — never an empty filter at 0.
  const typo = bsc("--class", "dyanmic"), typoInList = bsc("--class", "reflect,dyanmic");
  check("CLI --class ⟨0.24⟩ grammar: a typo'd token exits 2 NAMING the token and the accepted set",
        typo.status === 2 && /`dyanmic`/.test(typo.err) && ACCEPTED.test(typo.err) && /dynamic,\*/.test(typo.err)
          && typo.n === null,
        `status=${typo.status} n=${typo.n} err=${typo.err.trim()}`);
  check("CLI --class ⟨0.24⟩ grammar: one bad token poisons the whole list (no PARTIAL honour at exit 0)",
        typoInList.status === 2 && /`dyanmic`/.test(typoInList.err) && typoInList.n === null,
        `status=${typoInList.status} n=${typoInList.n} err=${typoInList.err.trim()}`);
  // (5) NOT REPEATABLE: two VALID tokens, so the ONLY defect is the repetition — and the message must be
  // the not-repeatable one, not the unknown-class one, or the test would pass for the wrong reason.
  const rep2 = bsc("--class", "reflect", "--class", "native");
  check("CLI --class ⟨0.24⟩ grammar: a repeated --class exits 2 (not a union, not last-wins)",
        rep2.status === 2 && /not repeatable/.test(rep2.err) && !/unknown reason class/.test(rep2.err)
          && rep2.n === null,
        `status=${rep2.status} n=${rep2.n} err=${rep2.err.trim()}`);
  // (6) the grammar is a property of the FLAG, so it holds on every verb that accepts it — `blindspots`,
  // `blindspots --stats` and `unverified` are this engine's three readers of the filter.
  const stats = runQuery("blindspots", "--stats", "--report", path.join(d, "bs"), "--class", "dyanmic");
  const statsOk = runQuery("blindspots", "--stats", "--report", path.join(d, "bs"), "--class", "reflect");
  const uvTypo = runQuery("unverified", "--report", path.join(d, "uv"), "--policy", path.join(d, "uv.policy"),
                          "--class", "dyanmic");
  const uvRep = runQuery("unverified", "--report", path.join(d, "uv"), "--policy", path.join(d, "uv.policy"),
                         "--class", "reflect", "--class", "native");
  check("CLI --class ⟨0.24⟩ grammar: the SAME rule on `blindspots --stats` and `unverified` (all 3 readers)",
        stats.status === 2 && /`dyanmic`/.test(stats.stderr) && ACCEPTED.test(stats.stderr)
          && uvTypo.status === 2 && /`dyanmic`/.test(uvTypo.stderr) && ACCEPTED.test(uvTypo.stderr)
          && uvRep.status === 2 && /not repeatable/.test(uvRep.stderr)
          && statsOk.status === 0 && JSON.parse(statsOk.stdout).byClass.reflect === 1,
        `stats=${stats.status}/${stats.stderr.trim()} uv=${uvTypo.status}/${uvTypo.stderr.trim()} `
          + `uvRep=${uvRep.status} statsOk=${statsOk.status}/${statsOk.stdout.trim()}`);

  fs.rmSync(d, { recursive: true, force: true });
}

// ── CLI-11. `tour`: the missing-sidecar fallback + N validation (the surface-port review fixes) ─────
// The scan-time note surfaces the single best reach; `tour` is its on-demand top-N form (SURFACE-BEST-
// FIND-DESIGN.md P2). Two cardinal-sin holes the review flagged in the port: (a) with the callgraph
// sidecar deleted, `tour` built `calls` ONLY from the sidecar, found nothing, and printed a FALSE
// "nothing hidden" at exit 0 — a silent under-report; the fix falls back to each entry's inline `calls`
// (mirrors tour.rs). (b) `tour 0`/an out-of-range N printed the same false all-clear instead of a usage
// error; the fix rejects it (exit 2). Also pins the alphabetical --json keys + the package-named header.
if (blk()) {
  const d = project({
    "cases.ts": `import * as fsm from "node:fs";
class Settings { static load(): boolean { return refresh(); } }
function refresh(): boolean { return compute(); }
function compute(): boolean { return ioReadThing(); }
export function ioReadThing(): boolean { fsm.readFileSync("/tmp/x"); return true; }
export { Settings };`,
  });
  const prefix = path.join(d, "tsrep");
  spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "cases.ts"), prefix], { encoding: "utf8" });

  // The report must EMBED inline `calls` per entry (the sidecar is not the only graph) — that's what the
  // no-sidecar fallback reads.
  const rep = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  check("tour: the report embeds inline `calls` edges (the no-sidecar fallback source)",
        rep.functions.find((e) => e.fn === "cases.Settings.load")?.calls?.includes("cases.refresh"),
        JSON.stringify(rep.functions.find((e) => e.fn === "cases.Settings.load")));

  const topReach = (out) => { try { return JSON.parse(out).reaches?.[0]; } catch { return null; } };

  // (with the sidecar) tour surfaces the benign-deep reach; --json keys are ALPHABETICAL (effect, fn,
  // hops, loc, score, source) — the exact order the Rust+Swift engines emit.
  const withCg = runQuery("tour", "--report", prefix, "--json");
  const tr = topReach(withCg.stdout);
  check("tour --json: surfaces the benign-deep reach (Settings.load → Fs) with the sidecar present",
        withCg.status === 0 && tr?.fn === "cases.Settings.load" && tr?.effect === "Fs",
        `status=${withCg.status} ${withCg.stdout.slice(0, 200)}`);
  check("tour --json: reach keys are ALPHABETICAL (effect, fn, hops, loc, score, source) — Rust/Swift order",
        tr && JSON.stringify(Object.keys(tr)) === JSON.stringify(["effect", "fn", "hops", "loc", "score", "source"]),
        JSON.stringify(tr && Object.keys(tr)));
  // the human header names the report's §2 PACKAGE (not the prefix basename `tsrep`).
  const human = runQuery("tour", "--report", prefix);
  check("tour: the header names the report's package (envelope `package`, not the prefix basename)",
        human.status === 0 && new RegExp(`in ${rep.package}:`).test(human.stdout) && !/in tsrep:/.test(human.stdout),
        human.stdout.split("\n")[0]);

  // (a) DELETE the callgraph sidecar → tour must STILL surface the reach via the inline `calls` fallback,
  // never a false "nothing hidden". This is the BLOCKER fix (a deleted/never-written sidecar is common).
  fs.rmSync(`${prefix}.callgraph.json`);
  const noCg = runQuery("tour", "--report", prefix, "--json");
  const trNo = topReach(noCg.stdout);
  check("tour: with the callgraph sidecar DELETED, STILL surfaces the reach (inline `calls` fallback, not a false all-clear)",
        noCg.status === 0 && trNo?.fn === "cases.Settings.load" && trNo?.effect === "Fs",
        `status=${noCg.status} ${noCg.stdout.slice(0, 200)}`);
  const noCgHuman = runQuery("tour", "--report", prefix);
  check("tour: sidecar deleted → the human note does NOT print the false 'nothing hidden'",
        !/nothing hidden/.test(noCgHuman.stdout), noCgHuman.stdout.slice(0, 160));

  // (b) N validation: `tour 0`, a non-integer, and an out-of-range N are all usage errors (exit 2) — a
  // `tour 0` printing "nothing hidden" over an effectful crate is a false all-clear (the §4 cardinal sin).
  for (const bad of ["0", "1.5", "abc", "99999999999999999999"]) {
    const r = runQuery("tour", bad, "--report", prefix);
    check(`tour ${bad}: invalid N → exit 2 usage error (never a false 'nothing hidden')`,
          r.status === 2 && /usage: candor-ts-query tour/.test(r.stderr) && !/nothing hidden/.test(r.stdout),
          `status=${r.status} ${(r.stdout + r.stderr).slice(0, 160)}`);
  }
  // a VALID positive N still works (exit 0).
  const good = runQuery("tour", "2", "--report", prefix, "--json");
  check("tour 2: a valid positive N works (exit 0, ≤2 reaches)",
        good.status === 0 && (JSON.parse(good.stdout).reaches?.length ?? 99) <= 2, `status=${good.status}`);

  // #1 (re-audit cardinal sin): over a meaningfully-UNKNOWN graph (unresolved calls — a missing tsconfig /
  // unresolvable imports), tour must NOT reassure "nothing hidden" — the Unknowns ARE the hidden part. ≥⅓ of
  // effectful fns Unknown → a qualified warning naming the count + `candor blindspots`; a clean graph is
  // unchanged. (Same gate the scan opener uses in surface.mjs.)
  const munk = `${d}/munk`; fs.mkdirSync(`${munk}/.candor`, { recursive: true });
  fs.writeFileSync(`${munk}/.candor/report.json`, JSON.stringify({ candor: { version: "t", toolchain: "node", spec: "0.23" },
    functions: [ { fn: "a.loadA", inferred: ["Unknown"], unknownWhy: ["callback:x"] },
                 { fn: "a.loadB", inferred: ["Unknown"], unknownWhy: ["callback:y"] },
                 { fn: "db.query", inferred: ["Fs"], direct: ["Fs"] } ] }));
  const mt = runQuery("tour", "--report", munk);
  check("#1 tour: mostly-Unknown graph → qualified, NOT a false 'nothing hidden'",
        !/nothing hidden/.test(mt.stdout) && /are Unknown/.test(mt.stdout) && /blindspots/.test(mt.stdout),
        mt.stdout.slice(0, 180));
  const clean = `${d}/clean`; fs.mkdirSync(`${clean}/.candor`, { recursive: true });
  fs.writeFileSync(`${clean}/.candor/report.json`, JSON.stringify({ candor: { version: "t", toolchain: "node", spec: "0.23" },
    functions: [ { fn: "svc.now", inferred: ["Clock"], direct: ["Clock"] } ] }));
  const ct = runQuery("tour", "--report", clean);
  check("#1 tour: a clean effectful graph (no Unknown) still says 'nothing hidden'",
        /nothing hidden/.test(ct.stdout), ct.stdout.slice(0, 120));

  fs.rmSync(d, { recursive: true, force: true });
}

// ── CLI-12. missing required verb-args → usage error (exit 2), never a silent empty answer ─────────
// `where` (and its siblings) with NO verb argument ran the query over `undefined` and emitted an
// authoritative-empty shape at exit 0 ({directly:[],inherited:[]}, [], {of:[],direct:[],transitive:[]},
// an affectedCount:0 blast radius, "does not perform undefined") — a false all-clear over a question
// never asked. candor-java treats a missing required arg as a usage error (exit 2, usage line); each
// report-backed single-arg verb now does the same. `path` requires BOTH positionals (arity 2). `fix`
// already had the guard (pinned here so it can't regress); reachable/map take no verb-arg and are
// exercised argless in CLI-10.
if (blk()) {
  const d = scratch("candor-missarg-");
  fs.writeFileSync(path.join(d, "r.json"), JSON.stringify({ candor: { version: "ttttttt", spec: "0.23" },
    functions: [{ fn: "app.db.save", inferred: ["Db"], direct: ["Db"], loc: "db.ts:1" }] }));
  fs.writeFileSync(path.join(d, "r.callgraph.json"), JSON.stringify({ "app.db.save": [] }));
  const P = path.join(d, "r");

  for (const [verb, usageRe] of [
    ["where", /usage: candor-ts-query where <Effect>/],
    ["show", /usage: candor-ts-query show <query>/],
    ["callers", /usage: candor-ts-query callers <query>/],
    ["impact", /usage: candor-ts-query impact <query>/],
    ["path", /usage: candor-ts-query path <fn> <Effect>/],
  ]) {
    const r = runQuery(verb, "--report", P);
    check(`CLI ${verb} with NO verb-arg: usage error (exit 2, usage on stderr, EMPTY stdout)`,
          r.status === 2 && usageRe.test(r.stderr) && r.stdout.trim() === "",
          `status=${r.status} stdout=${r.stdout.slice(0, 80)} stderr=${r.stderr.slice(0, 120)}`);
  }
  // an EMPTY-string arg is the same missing-arg class (never a silent empty answer)
  const we = runQuery("where", "", "--report", P);
  check("CLI where with an EMPTY-string <Effect>: usage error (exit 2)",
        we.status === 2 && /usage: candor-ts-query where <Effect>/.test(we.stderr),
        `status=${we.status} ${we.stderr.slice(0, 120)}`);
  // path arity: ONE arg is still missing its <Effect> — both the human default and --json branch
  const p1 = runQuery("path", "save", "--report", P);
  check("CLI path with one arg (missing <Effect>): usage error (exit 2), never `does not perform undefined`",
        p1.status === 2 && /usage: candor-ts-query path <fn> <Effect>/.test(p1.stderr)
          && !/does not perform/.test(p1.stdout),
        `status=${p1.status} ${(p1.stdout + p1.stderr).slice(0, 160)}`);
  const p1j = runQuery("path", "save", "--json", "--report", P);
  check("CLI path --json with one arg: usage error (exit 2), never an empty-path all-clear",
        p1j.status === 2 && /usage: candor-ts-query path <fn> <Effect>/.test(p1j.stderr) && p1j.stdout.trim() === "",
        `status=${p1j.status} ${(p1j.stdout + p1j.stderr).slice(0, 160)}`);
  // fix already guarded its args — pinned so the behavior can't regress
  const fx = runQuery("fix", "--report", P);
  check("CLI fix with NO verb-args: usage error (exit 2) — the existing guard, pinned",
        fx.status === 2 && /usage: candor-ts-query fix <fn> <Effect>/.test(fx.stderr),
        `status=${fx.status} ${fx.stderr.slice(0, 120)}`);
  // and a PRESENT arg still answers (exit 0) — the guard must not over-fire
  const wOk = runQuery("where", "Db", "--report", P);
  check("CLI where with a real <Effect> still answers (exit 0, the guard does not over-fire)",
        wOk.status === 0 && JSON.parse(wOk.stdout).directly.includes("app.db.save"),
        `status=${wOk.status} ${wOk.stdout.slice(0, 120)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── CLI-13. gate FAILURE points at the remedy verb (fix-gate); a clean run is byte-free of it ──────
// The failing gate printed violations + `candor-ts: N policy violation(s)` but never named the engine's
// own remedy verb. The pointer is APPEND-ONLY on the failure path, on the summary's stream (stderr):
// exit code, violation lines and the summary text are conformance-pinned and unchanged; a zero-violation
// run must not mention it anywhere.
if (blk()) {
  const d = project({
    "src/web.ts": `export function handler(): void { fetch("https://api.example.com/x"); }`,
    "policy": "deny Net\n",
  });
  const r = runScan(d, "--policy", path.join(d, "policy"));
  check("failing gate: the fix-gate pointer line follows the summary on stderr (exit 1 unchanged)",
        r.status === 1
          && r.stderr.includes("candor-ts: 1 policy violation(s)\n→ candor-ts-query fix-gate names the remedy for each"),
        `status=${r.status} stderr=${JSON.stringify(r.stderr.slice(-220))}`);
  fs.writeFileSync(path.join(d, "allow.policy"), "allow Net api.example.com\n");
  const rOk = runScan(d, "--policy", path.join(d, "allow.policy"));
  check("clean gate: NO pointer line anywhere (zero-violation output unchanged)",
        rOk.status === 0 && !rOk.stdout.includes("fix-gate names the remedy") && !rOk.stderr.includes("fix-gate names the remedy")
          && rOk.stderr.includes("candor-ts: policy ✓"),
        `status=${rOk.status} stderr=${rOk.stderr.slice(-160)}`);
}

// ── Object.create descriptor accessors (definePropertyAccessor Case B, the create half) ────────────
// The defineProperty/defineProperties halves are pinned above; the Object.create(proto, {key: desc})
// form — descriptor getters on the CREATED object, joined through the binding the result is assigned
// to — had no execution. The unbound-result form can't join a forcing site, but the descriptor body is
// still a minted unit whose effect is IN the report (never silent-pure at the report level).
if (blk()) {
  const d = project({
    "src/c.ts": `import { execSync } from "node:child_process";
const proto = {};
export const o = Object.create(proto, {
  p: { get: () => execSync("id").toString() },
  q: { value: 42 },
});
export function readCreate(): string { return o.p; }
export function readValue(): number { return o.q; }
// the result NOT bound to a simple identifier: no joinable target, but the getter body is a unit
export function makeUnbound(): object { return Object.create(proto, { z: { get: () => execSync("who").toString() } }); }`,
  });
  const { report } = scan(d);
  check("Object.create descriptor getter: the forcing site through the bound const carries the effect (Exec)",
        entry(report, "src.c.readCreate")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.c.readCreate")));
  check("Object.create: a value descriptor member does NOT fabricate (readValue pure)",
        entry(report, "src.c.readValue") === undefined, JSON.stringify(entry(report, "src.c.readValue")));
  check("Object.create with an UNBOUND result: the descriptor getter is still a minted, effect-carrying unit",
        report.functions.some((e) => /defineProperty\(<create>\)\.get z/.test(e.fn) && e.inferred.includes("Exec")),
        JSON.stringify(report.functions.map((e) => e.fn)));
}

// ── the uninstalled-namespace-import κ fallback: classify by the import SPECIFIER ──────────────────
// A namespace import from a bare specifier that didn't RESOLVE (package not installed in this tree)
// still classifies through κ by the syntactic path — winston.info is Log, not Unknown noise; an
// UNMODELED uninstalled package stays the honest Unknown disclosure (the anti-fabrication twin).
if (blk()) {
  const d = project({
    "src/l.ts": `import * as winstonm from "winston";
import * as mystery from "some-unlisted-pkg-zz";
export function logIt(): void { winstonm.info("hello"); }
export function callMystery(): void { mystery.go(); }`,
  });
  const { report } = scan(d);
  const logIt = entry(report, "src.l.logIt");
  check("uninstalled winston (κ-modeled) classifies Log via the import specifier, not Unknown",
        logIt?.direct.includes("Log") && !logIt.inferred.includes("Unknown"), JSON.stringify(logIt));
  const myst = entry(report, "src.l.callMystery");
  check("uninstalled UNMODELED package: the call discloses Unknown with its why (never a guessed effect)",
        myst?.inferred.includes("Unknown") && (myst.unknownWhy ?? []).some((w) => w.includes("mystery.go")),
        JSON.stringify(myst));
}

// ── class-override dispatch: the >12-family TOO-WIDE arm falls to Unknown, never silent ────────────
// The ≤12 fan-out edges every override (precise); a WIDER family cannot be enumerated soundly, so the
// dispatch site must disclose Unknown with the canonical dispatch:OWNER.member why. Both sides of the
// boundary pinned: 12 overrides → the real effect propagates (no Unknown); 13 → Unknown (and the
// un-edged override effect is NOT silently claimed either way).
if (blk()) {
  const mkSubs = (n) => Array.from({ length: n }, (_, i) =>
    i === 0
      ? `export class S0 extends Base { m(): void { fsm.writeFileSync("/tmp/s0", "x"); } }`
      : `export class S${i} extends Base { m(): void { /* pure */ } }`).join("\n");
  const src = (n) => `import * as fsm from "node:fs";
export class Base { m(): void { /* pure */ } }
${mkSubs(n)}
export function dispatch(b: Base): void { b.m(); }`;
  const at = scan(project({ "src/w.ts": src(12) })); // AT the family bound: precise fan-out
  const atD = at.report.functions.find((e) => e.fn === "src.w.dispatch");
  check("override dispatch at the 12-family bound: the override's effect propagates precisely (Fs, no Unknown)",
        atD?.inferred.includes("Fs") && !atD.inferred.includes("Unknown"), JSON.stringify(atD));
  const over = scan(project({ "src/w.ts": src(13) })); // OVER the bound: too wide to enumerate soundly
  const overD = over.report.functions.find((e) => e.fn === "src.w.dispatch");
  check("override dispatch over the bound (13): Unknown disclosed with the canonical dispatch:Base.m why",
        overD?.inferred.includes("Unknown") && (overD.unknownWhy ?? []).some((w) => w === "dispatch:Base.m"),
        JSON.stringify(overD));
}

// ── R32: node:stream provided method → the subclass's `_write`/`_read` override ────────────────────
// A Writable's public `.write()`/`.end()` drive the user's `_write` INSIDE node core (invisible), so a
// custom effectful stream reached only via the public API read silent-pure. The fix edges the driver to
// the local override. resolve-or-skip: an inert override / a non-stream class / a std stream adds nothing.
if (blk()) {
  const d = project({
    "src/s.ts": `import { Writable, Readable } from "stream";
import * as fs from "fs";
class FileSink extends Writable { _write(c: any, e: string, cb: () => void) { fs.writeFileSync("/tmp/x", c); cb(); } }
export function viaWrite(s: FileSink) { s.write("d"); }
export function viaEnd(s: FileSink) { s.end("d"); }
class FeedReader extends Readable { _read() { fs.readFileSync("/tmp/x"); } }
export function viaRead(r: FeedReader) { r.read(); }
class InertSink extends Writable { _write(c: any, e: string, cb: () => void) { const x = 1; } }
export function viaInert(s: InertSink) { s.write("d"); }
class Logger { write(s: string) {} _write(x: any) { fs.writeFileSync("/tmp/z", x); } }
export function viaLogger(l: Logger) { l.write("x"); }`,
  });
  const { report } = scan(d);
  const inf = (fn) => (report.functions.find((e) => e.fn === fn)?.inferred) ?? [];
  check("node stream .write() drives the local _write override (Fs recovered)", inf("src.s.viaWrite").includes("Fs"), JSON.stringify(inf("src.s.viaWrite")));
  check("node stream .end() drives _write too", inf("src.s.viaEnd").includes("Fs"), JSON.stringify(inf("src.s.viaEnd")));
  check("node stream .read() drives the local _read override", inf("src.s.viaRead").includes("Fs"), JSON.stringify(inf("src.s.viaRead")));
  check("an INERT _write is not fabricated onto the .write() caller", !inf("src.s.viaInert").includes("Fs"), JSON.stringify(inf("src.s.viaInert")));
  check("a non-stream class with a write() method gets NO _write edge", !inf("src.s.viaLogger").includes("Fs"), JSON.stringify(inf("src.s.viaLogger")));
}

// ── Object.assign getter enumeration: copying a source's props invokes its getters ─────────────────
// `Object.assign(t, src)` reads every own enumerable prop of src — an effectful getter RUNS (the
// object-spread twin). Both recordAccessorHit branches pinned: a CLASS-typed source's getter is a
// minted unit → the copier inherits the precise effect; an object-LITERAL getter (no minted unit)
// falls to the disclosed-Unknown branch — never silent-pure either way. Plain data stays pure.
if (blk()) {
  const d = project({
    "src/g.ts": `import { execSync } from "node:child_process";
export class Vault { get tok(): string { return execSync("vault read tok").toString(); } }
export const secretive = { get tok(): string { return execSync("vault read tok").toString(); } };
export const plain = { a: 1 };
export function copyClass(v: Vault): object { return Object.assign({}, v); }
export function copyLit(): object { return Object.assign({}, secretive); }
export function copyPlain(): object { return Object.assign({}, plain); }`,
  });
  const { report } = scan(d);
  check("Object.assign enumerates a class source's getters: the copier inherits the precise Exec",
        entry(report, "src.g.copyClass")?.inferred.includes("Exec"), JSON.stringify(entry(report, "src.g.copyClass")));
  const lit = entry(report, "src.g.copyLit");
  check("Object.assign over an object-literal getter: disclosed (Exec or Unknown+reflect:accessor), never silent",
        lit !== undefined && (lit.inferred.includes("Exec")
          || (lit.inferred.includes("Unknown") && (lit.unknownWhy ?? []).some((w) => w.startsWith("reflect:accessor:")))),
        JSON.stringify(lit));
  check("NO-FABRICATION: Object.assign from a plain-data source stays pure",
        entry(report, "src.g.copyPlain") === undefined, JSON.stringify(entry(report, "src.g.copyPlain")));
}

// ── .candor/config discovered-but-UNREADABLE fails closed (exit 2) ─────────────────────────────────
// The CANDOR_CONFIG-set-but-missing and configured-but-empty arms are pinned above; the discovery-path
// read failure (config EXISTS but readFileSync throws — here a directory at the config path) was the
// remaining untested fail-closed arm. A gate source must never vanish silently.
if (blk()) {
  const d = project({ "src/p.ts": `export function f(): void { /* pure */ }` });
  fs.mkdirSync(path.join(d, ".candor", "config"), { recursive: true }); // a DIRECTORY named `config`
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src")], { encoding: "utf8" });
  check("a discovered .candor/config that cannot be READ fails closed (exit 2, disclosed)",
        r.status === 2 && /config .*could not be read/.test(r.stderr),
        `status=${r.status} ${r.stderr.slice(0, 160)}`);
}

// ── the AS-EFF-005 baseline guard (CANDOR_BASELINE / config `baseline`; SPEC §7 item 5) ────────────
// Exit-code contract per gate surface (TESTING.md §2.5): gain → 1, clean → 0, absent file → note + 0,
// unparseable / missing-or-mismatched producing version → 2 WITHOUT evaluating, new fns exempt.
// Semantics mirror the reference engine (candor-java Policy.checkBaseline).
if (blk()) {
  const baseSrc = `import { DatabaseSync } from "node:sqlite";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); }`;
  const gainedSrc = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function save(db: DatabaseSync): void { db.exec("UPDATE customers SET v = 1"); readFileSync("/etc/x"); }`;
  const d = project({ "src/db.ts": baseSrc });
  const run = (env, ...extra) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...extra],
    { encoding: "utf8", env: { ...process.env, ...env } });
  run({});                                                       // record the baseline (same build)
  const bl = path.join(d, "baseline.json");
  fs.copyFileSync(path.join(d, ".candor", "report.json"), bl);

  // clean: same code vs its own baseline → exit 0, no violation
  const rClean = run({ CANDOR_BASELINE: bl });
  check("baseline guard: clean run exits 0", rClean.status === 0, `status=${rClean.status} ${rClean.stderr.slice(0, 160)}`);
  check("baseline guard: clean run announces the active guard", rClean.stderr.includes("baseline ✓"), rClean.stderr.slice(0, 200));

  // absent baseline FILE: one stderr note, guard inactive, exit unchanged (ratchet not adopted)
  const rAbsent = run({ CANDOR_BASELINE: path.join(d, "no-such-baseline.json") });
  check("baseline guard: absent file → note + exit 0 (guard inactive)",
        rAbsent.status === 0 && /does not exist.*not active/.test(rAbsent.stderr), `status=${rAbsent.status} ${rAbsent.stderr.slice(0, 200)}`);

  // gain: an EXISTING fn gaining an effect → [AS-EFF-005] + exit 1; and the record joins --gate-json
  fs.writeFileSync(path.join(d, "src", "db.ts"), gainedSrc);
  const gp = path.join(d, "gate.json");
  const rGain = run({ CANDOR_BASELINE: bl }, "--gate-json", gp);
  check("baseline guard: an existing fn gaining an effect exits 1", rGain.status === 1, `status=${rGain.status}`);
  check("baseline guard: the gain is an [AS-EFF-005] line naming fn + effect",
        rGain.stdout.includes("[AS-EFF-005]") && rGain.stdout.includes("src.db.save") && rGain.stdout.includes("Fs"),
        rGain.stdout.slice(0, 240));
  let gv = null;
  try { gv = JSON.parse(fs.readFileSync(gp, "utf8")); } catch { /* null → the checks below fail with raw */ }
  const gRec = gv?.violations?.find((x) => x.rule === "AS-EFF-005");
  check("baseline guard: the AS-EFF-005 record joins the --gate-json verdict (ok:false)",
        gv?.ok === false && gRec?.fn === "src.db.save" && Array.isArray(gRec?.effects) && gRec.effects.includes("Fs"),
        JSON.stringify(gv)?.slice(0, 240));

  // new-fn exemption: a NEW effectful fn (absent from the baseline) is reviewed as new code, not a regression
  fs.writeFileSync(path.join(d, "src", "db.ts"),
    `${baseSrc}\nimport { readFileSync } from "node:fs";\nexport function fresh(): void { readFileSync("/etc/y"); }`);
  const rNew = run({ CANDOR_BASELINE: bl });
  check("baseline guard: a NEW effectful fn is exempt (exit 0)", rNew.status === 0,
        `status=${rNew.status} ${(rNew.stdout + rNew.stderr).slice(0, 200)}`);
  fs.writeFileSync(path.join(d, "src", "db.ts"), gainedSrc);   // back to the gaining shape for the arms below

  // doctored producing version (§2.1): exit 2 WITHOUT evaluating — no [AS-EFF-005] line even though a
  // same-build compare WOULD find the gain (the bogus-wave/fail-open posture, the unreadable-policy class)
  const doctored = path.join(d, "doctored.json");
  fs.writeFileSync(doctored, fs.readFileSync(bl, "utf8").replace(/"version": "[^"]*"/, '"version": "candor-ts-0.0.1"'));
  const rDoc = run({ CANDOR_BASELINE: doctored });
  check("baseline guard: a different-build baseline exits 2 (invalid gate input, disclosed)",
        rDoc.status === 2 && /produced by engine build candor-ts-0\.0\.1/.test(rDoc.stderr), `status=${rDoc.status} ${rDoc.stderr.slice(0, 240)}`);
  check("baseline guard: the mismatch is NOT evaluated (no [AS-EFF-005] violation line)",
        !rDoc.stdout.includes("[AS-EFF-005]") && !rDoc.stderr.includes("[AS-EFF-005]"), (rDoc.stdout + rDoc.stderr).slice(0, 240));

  // a provenance-less (legacy bare-array) baseline is as unverifiable as a mismatch → exit 2
  const legacy = path.join(d, "legacy.json");
  fs.writeFileSync(legacy, JSON.stringify([{ fn: "src.db.save", inferred: ["Db"] }]));
  const rLegacy = run({ CANDOR_BASELINE: legacy });
  check("baseline guard: a baseline with no provenance header exits 2",
        rLegacy.status === 2 && /no provenance header/.test(rLegacy.stderr), `status=${rLegacy.status} ${rLegacy.stderr.slice(0, 200)}`);

  // present-but-unparseable: exit 2, never a silent pass (fail-closed, TESTING.md §2.2)
  const bad = path.join(d, "bad.json");
  fs.writeFileSync(bad, "{ definitely not json");
  const rBad = run({ CANDOR_BASELINE: bad });
  check("baseline guard: an unparseable baseline exits 2 (never a silent pass)",
        rBad.status === 2 && /could not be parsed/.test(rBad.stderr), `status=${rBad.status} ${rBad.stderr.slice(0, 200)}`);

  // config `baseline` key: a RELATIVE value anchors to the CONFIG's repo (never the process cwd) and
  // activates the guard — the same gain must fire with no env var set at all
  fs.mkdirSync(path.join(d, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(d, ".candor", "config"), "baseline baseline.json\n");
  const rCfg = spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8", cwd: os.tmpdir() });
  check("baseline guard: the config `baseline` key (relative, config-anchored) activates the guard — gain exits 1",
        rCfg.status === 1 && rCfg.stdout.includes("[AS-EFF-005]"), `status=${rCfg.status} ${(rCfg.stdout + rCfg.stderr).slice(0, 240)}`);
  fs.rmSync(path.join(d, ".candor", "config"));
}

// ── ⟨0.16⟩ callgraph-aware baseline guard (SPEC §7 item 5, the ⟨0.16⟩ paragraph) ──────
// Reports OMIT pure functions (§2), so a fn that shipped PURE and now performs an effect is absent from
// the baseline REPORT and reads as exempt "new code" — the sharpest supply-chain shape. The ⟨0.16⟩ fix
// keys existence on the baseline CALLGRAPH sidecar (<baseline>.callgraph.json, which lists pure leaves),
// reusing the `gains` origin node-set test. Three sidecar states: PRESENT catches pure→effectful (exit 1),
// ABSENT degrades to report-only + a stderr note (exit 0 here), PRESENT-but-corrupt fails closed (exit 2).
if (blk()) {
  // The acceptance probe: a pure `fmt` (util.ts) + an already-effectful `fetch_` (api.ts).
  const utilPure = `export function fmt(s: string): string { return s.toUpperCase(); }`;
  const utilGain = `import { readFileSync } from "node:fs";
export function fmt(s: string): string { readFileSync("/etc/x"); return s.toUpperCase(); }`;
  const apiSrc = `export function fetch_(h: string): Promise<Response> { return fetch("https://" + h); }`;
  const d = project({ "util.ts": utilPure, "api.ts": apiSrc });
  const run = (env, ...extra) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...extra],
    { encoding: "utf8", env: { ...process.env, ...env } });

  // record the baseline as the report/callgraph PAIR (--out writes <prefix>.json + <prefix>.callgraph.json)
  const blPrefix = path.join(d, ".candor", "baseline");
  run({}, "--out", blPrefix);
  const bl = `${blPrefix}.json`, blCg = `${blPrefix}.callgraph.json`;
  check("⟨0.16⟩ baseline pair: the callgraph sidecar was written alongside the report",
        fs.existsSync(bl) && fs.existsSync(blCg), `report=${fs.existsSync(bl)} cg=${fs.existsSync(blCg)}`);
  // `fmt` is PURE, so it is OMITTED from the baseline report but PRESENT as a callgraph node — the whole point
  const blReport = JSON.parse(fs.readFileSync(bl, "utf8"));
  const blCgObj = JSON.parse(fs.readFileSync(blCg, "utf8"));
  check("⟨0.16⟩ baseline: pure `fmt` is absent from the report but present as a callgraph node",
        !blReport.functions.some((e) => e.fn === "util.fmt") && ("util.fmt" in blCgObj),
        `inReport=${blReport.functions.some((e) => e.fn === "util.fmt")} inCg=${"util.fmt" in blCgObj}`);

  // ACCEPTANCE 4 (no-op): rescan unchanged against the pair → exit 0, clean
  const rNoop = run({ CANDOR_BASELINE: bl });
  check("⟨0.16⟩ acceptance 4: no-op rescan against the pair exits 0, clean",
        rNoop.status === 0 && !rNoop.stdout.includes("[AS-EFF-005]"), `status=${rNoop.status} ${(rNoop.stdout + rNoop.stderr).slice(0, 200)}`);

  // ACCEPTANCE 1 (sidecar PRESENT): util.fmt gains Fs → exit 1, fmt flagged. The pure→effectful transition
  // the pre-⟨0.16⟩ report-only guard MISSED (fmt was absent from the report, read as exempt "new").
  fs.writeFileSync(path.join(d, "util.ts"), utilGain);
  const gp = path.join(d, "gate.json");
  const rGain = run({ CANDOR_BASELINE: bl }, "--gate-json", gp);
  check("⟨0.16⟩ acceptance 1: sidecar present → formerly-pure fmt gaining Fs exits 1",
        rGain.status === 1, `status=${rGain.status} ${(rGain.stdout + rGain.stderr).slice(0, 200)}`);
  check("⟨0.16⟩ acceptance 1: the gain is an [AS-EFF-005] line naming util.fmt + Fs",
        rGain.stdout.includes("[AS-EFF-005]") && rGain.stdout.includes("util.fmt") && rGain.stdout.includes("Fs"),
        rGain.stdout.slice(0, 240));
  let gv = null; try { gv = JSON.parse(fs.readFileSync(gp, "utf8")); } catch { /* null → checks below fail raw */ }
  const gRec = gv?.violations?.find((x) => x.rule === "AS-EFF-005" && x.fn === "util.fmt");
  check("⟨0.16⟩ acceptance 1: the pure→effectful gain joins --gate-json (ok:false)",
        gv?.ok === false && Array.isArray(gRec?.effects) && gRec.effects.includes("Fs"), JSON.stringify(gv)?.slice(0, 240));

  // ACCEPTANCE 2 (sidecar ABSENT): same edit, delete the callgraph → degrade to report-only. fmt was pure,
  // so report-only reads it as new code → NOT caught → exit 0, plus the stderr note the guard is weaker.
  const blCgSaved = fs.readFileSync(blCg, "utf8");
  fs.rmSync(blCg);
  const rNoCg = run({ CANDOR_BASELINE: bl });
  check("⟨0.16⟩ acceptance 2: sidecar deleted → report-only degradation exits 0 (pure→effectful not caught)",
        rNoCg.status === 0 && !rNoCg.stdout.includes("[AS-EFF-005]"), `status=${rNoCg.status} ${(rNoCg.stdout + rNoCg.stderr).slice(0, 200)}`);
  check("⟨0.16⟩ acceptance 2: a stderr note discloses the guard is WEAKER without the sidecar",
        /no baseline callgraph sidecar/.test(rNoCg.stderr) && /WEAKER/.test(rNoCg.stderr), rNoCg.stderr.slice(0, 260));

  // ACCEPTANCE 3 (sidecar PRESENT-but-corrupt): truncate to `{` → fail closed (exit 2), like a corrupt
  // baseline. A broken sidecar must not silently narrow the guard back to report-only.
  fs.writeFileSync(blCg, "{");
  const rBadCg = run({ CANDOR_BASELINE: bl });
  check("⟨0.16⟩ acceptance 3: a corrupt/truncated sidecar fails closed (exit 2)",
        rBadCg.status === 2 && /baseline callgraph.*could not be parsed/.test(rBadCg.stderr), `status=${rBadCg.status} ${rBadCg.stderr.slice(0, 240)}`);
  check("⟨0.16⟩ acceptance 3: the corrupt sidecar is NOT narrowed to report-only (no silent exit 0/1 pass)",
        rBadCg.status === 2 && !rBadCg.stdout.includes("[AS-EFF-005]"), `status=${rBadCg.status} ${(rBadCg.stdout).slice(0, 200)}`);
  fs.writeFileSync(blCg, blCgSaved);   // restore the good sidecar for the widening arm

  // ACCEPTANCE 5 (already-effectful WIDENING, unchanged behaviour): api.fetch_ is Net in the baseline and
  // now also does Fs → exit 1, caught the same way with OR without the sidecar (it was in the report).
  fs.writeFileSync(path.join(d, "util.ts"), utilPure);   // revert fmt so only api widens
  fs.writeFileSync(path.join(d, "api.ts"),
    `import { readFileSync } from "node:fs";
export function fetch_(h: string): Promise<Response> { readFileSync("/etc/x"); return fetch("https://" + h); }`);
  const rWiden = run({ CANDOR_BASELINE: bl });
  check("⟨0.16⟩ acceptance 5: an already-effectful fn WIDENING (Net→Net+Fs) exits 1",
        rWiden.status === 1 && rWiden.stdout.includes("[AS-EFF-005]") && rWiden.stdout.includes("api.fetch_") && rWiden.stdout.includes("Fs"),
        `status=${rWiden.status} ${rWiden.stdout.slice(0, 240)}`);

  // a genuinely NEW fn (in neither report nor callgraph) stays exempt even with the sidecar present
  fs.writeFileSync(path.join(d, "api.ts"), apiSrc);   // revert api
  fs.writeFileSync(path.join(d, "util.ts"),
    `${utilPure}\nimport { readFileSync } from "node:fs";\nexport function brandnew(): void { readFileSync("/etc/y"); }`);
  const rNew = run({ CANDOR_BASELINE: bl });
  check("⟨0.16⟩ a genuinely new effectful fn (in neither report nor callgraph) stays exempt (exit 0)",
        rNew.status === 0 && !rNew.stdout.includes("[AS-EFF-005]"), `status=${rNew.status} ${(rNew.stdout + rNew.stderr).slice(0, 200)}`);
  fs.writeFileSync(path.join(d, "util.ts"), utilPure);   // revert util for the Unknown-only arm below

  // ── ⟨0.16⟩ an Unknown-ONLY gain is ADVISORY, not a regression ──────────────────────────────
  // Unknown is the §4 trust marker, not an effect (`pure` policies exclude it); on real dependency bumps
  // a pure→Unknown transition is dominated by resolution noise, so exit-1 on it would break CI on
  // innocuous bumps. A formerly-pure fmt that now invokes a Function-typed param (an unresolvable call →
  // Unknown, no real effect) must exit 0 with a stderr NOTE — NOT the [AS-EFF-005] line — and keep
  // --gate-json ok:true. Mirrors the reference engine (candor-scan gate.rs check_baseline). A REAL
  // effect gain is still a violation (acceptance 1 above, on Fs), and a REAL+Unknown gain reports the
  // real set only (Unknown filtered from the shown effects).
  fs.writeFileSync(path.join(d, "util.ts"),
    `export function fmt(s: string, cb: Function): string { cb(); return s.toUpperCase(); }`);
  const guAdv = path.join(d, "gate-adv.json");
  const rUnk = run({ CANDOR_BASELINE: bl }, "--gate-json", guAdv);
  check("⟨0.16⟩ Unknown-only gain: a formerly-pure fmt gaining ONLY Unknown exits 0 (advisory, not a regression)",
        rUnk.status === 0 && !rUnk.stdout.includes("[AS-EFF-005]"), `status=${rUnk.status} ${(rUnk.stdout + rUnk.stderr).slice(0, 200)}`);
  check("⟨0.16⟩ Unknown-only gain: a stderr NOTE discloses the advisory (names the fn, cites §4 trust marker)",
        /note — 1 function\(s\) gained an unresolved call \(Unknown\)/.test(rUnk.stderr) && rUnk.stderr.includes("util.fmt") && /advisory, NOT a regression/.test(rUnk.stderr),
        rUnk.stderr.slice(0, 300));
  let guv = null; try { guv = JSON.parse(fs.readFileSync(guAdv, "utf8")); } catch { /* null → checks below fail raw */ }
  check("⟨0.16⟩ Unknown-only gain: --gate-json ok stays true (an advisory must NOT set ok:false)",
        guv?.ok === true && !(guv?.violations ?? []).some((x) => x.rule === "AS-EFF-005"), JSON.stringify(guv)?.slice(0, 240));

  // a REAL+Unknown gain together → still a violation, but the shown effects are the REAL set (Unknown filtered)
  fs.writeFileSync(path.join(d, "util.ts"),
    `import { readFileSync } from "node:fs";
export function fmt(s: string, cb: Function): string { cb(); readFileSync("/etc/x"); return s.toUpperCase(); }`);
  const guMix = path.join(d, "gate-mix.json");
  const rMix = run({ CANDOR_BASELINE: bl }, "--gate-json", guMix);
  let mv = null; try { mv = JSON.parse(fs.readFileSync(guMix, "utf8")); } catch { /* null */ }
  const mRec = mv?.violations?.find((x) => x.rule === "AS-EFF-005" && x.fn === "util.fmt");
  check("⟨0.16⟩ real+Unknown gain: still a violation (exit 1), shown effects are the REAL set with Unknown filtered",
        rMix.status === 1 && mv?.ok === false && mRec?.effects?.includes("Fs") && !mRec?.effects?.includes("Unknown"),
        `status=${rMix.status} ${JSON.stringify(mRec)}`);
}

// ── ⟨unknown-ratchet⟩ the OPT-IN that flips an Unknown-ONLY gain from advisory to a FAILURE ─────────
// (config `unknown-ratchet` / CANDOR_UNKNOWN_RATCHET, default OFF). This is what makes `deny E Unknown`
// adoptable on legacy DI/reflection code: the CURRENT Unknown surface is GRANDFATHERED (a fn ALREADY
// Unknown in the baseline shows no gain ⇒ never flagged), and only a NEWLY-introduced Unknown fails.
// Default OFF must leave the ⟨0.16⟩ advisory posture BYTE-IDENTICAL (exit 0, a stderr note). Mirrors the
// reference engine (candor-java Policy.checkBaseline under ctx().unknownRatchet). require(<var>) is the
// deterministic Unknown-ONLY source (an opaque module load, no real effect).
if (blk()) {
  // baseline: X (already Unknown via require(var)) + Y (pure) + Z (already effectful, Fs) — a real anchor
  const baseSrc = `export function x(m: string) { return require(m); }
export function y(s: string): string { return s.toUpperCase(); }
import { readFileSync } from "node:fs";
export function z(): void { readFileSync("/etc/z"); }`;
  // current: X STILL Unknown (grandfathered), Y NOW Unknown (a NEW blind spot), Z unchanged
  const curSrc = `export function x(m: string) { return require(m); }
export function y(m: string) { return require(m); }
import { readFileSync } from "node:fs";
export function z(): void { readFileSync("/etc/z"); }`;
  const d = project({ "src/a.ts": baseSrc });
  const run = (env, ...extra) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...extra],
    { encoding: "utf8", env: { ...process.env, ...env } });
  // record the baseline PAIR (report + callgraph) with the same build, then move to the current shape
  const blPrefix = path.join(d, ".candor", "ur-baseline");
  run({}, "--out", blPrefix);
  const bl = `${blPrefix}.json`;
  const blReport = JSON.parse(fs.readFileSync(bl, "utf8"));
  check("unknown-ratchet: the baseline records src.a.x as ALREADY Unknown (the grandfathered surface)",
        blReport.functions.find((e) => e.fn === "src.a.x")?.inferred.includes("Unknown"),
        JSON.stringify(blReport.functions.find((e) => e.fn === "src.a.x")));
  fs.writeFileSync(path.join(d, "src", "a.ts"), curSrc);

  // OFF (default): both X (grandfathered) and Y (new Unknown) are Unknown-only gains → advisory, exit 0,
  // ZERO violations. This is the BYTE-IDENTICAL ⟨0.16⟩ posture — the ratchet is opt-in.
  const goff = path.join(d, "ur-off.json");
  const rOff = run({ CANDOR_BASELINE: bl }, "--gate-json", goff);
  let ov = null; try { ov = JSON.parse(fs.readFileSync(goff, "utf8")); } catch { /* null → checks below fail raw */ }
  const offViol = (ov?.violations ?? []).filter((v) => v.rule === "AS-EFF-005");
  check("unknown-ratchet OFF: an Unknown-only gain stays advisory — exit 0, ZERO AS-EFF-005 violations",
        rOff.status === 0 && !rOff.stdout.includes("[AS-EFF-005]") && ov?.ok === true && offViol.length === 0,
        `status=${rOff.status} ${JSON.stringify(offViol)} ${rOff.stderr.slice(0, 160)}`);

  // ON (env CANDOR_UNKNOWN_RATCHET): X is GRANDFATHERED (already Unknown in the baseline → no gain), only
  // the NEWLY-introduced Unknown on Y fails → exit 1, EXACTLY ONE AS-EFF-005 violation naming src.a.y.
  const gon = path.join(d, "ur-on.json");
  const rOn = run({ CANDOR_BASELINE: bl, CANDOR_UNKNOWN_RATCHET: "1" }, "--gate-json", gon);
  let nv = null; try { nv = JSON.parse(fs.readFileSync(gon, "utf8")); } catch { /* null */ }
  const onViol = (nv?.violations ?? []).filter((v) => v.rule === "AS-EFF-005");
  check("unknown-ratchet ON (env): a NEWLY-introduced Unknown fails — exit 1, EXACTLY 1 AS-EFF-005 (src.a.y)",
        rOn.status === 1 && nv?.ok === false && onViol.length === 1 && onViol[0].fn === "src.a.y"
          && onViol[0].effects?.includes("Unknown"),
        `status=${rOn.status} ${JSON.stringify(onViol)}`);
  check("unknown-ratchet ON: the already-Unknown src.a.x is GRANDFATHERED (never flagged)",
        !onViol.some((v) => v.fn === "src.a.x"), JSON.stringify(onViol));
  check("unknown-ratchet ON: the [AS-EFF-005] line names src.a.y + cites the ratchet as a NEW blind spot",
        rOn.stdout.includes("[AS-EFF-005]") && rOn.stdout.includes("src.a.y") && /NEW blind spot \(unknown-ratchet\)/.test(rOn.stdout),
        rOn.stdout.slice(0, 260));

  // ON via the config `unknown-ratchet` key (a bare key, no value → truthy) — same failure, no env var
  fs.mkdirSync(path.join(d, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(d, ".candor", "config"), "baseline .candor/ur-baseline.json\nunknown-ratchet\n");
  const rCfg = spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8", cwd: os.tmpdir() });
  check("unknown-ratchet ON (config `unknown-ratchet` bare key): the new Unknown fails — exit 1",
        rCfg.status === 1 && rCfg.stdout.includes("[AS-EFF-005]") && rCfg.stdout.includes("src.a.y"),
        `status=${rCfg.status} ${(rCfg.stdout + rCfg.stderr).slice(0, 240)}`);
  // the config key is KNOWN — no "ignoring unknown config key" warning (it must not warn inert)
  check("unknown-ratchet: the config key is KNOWN (never warned inert)",
        !/ignoring unknown config key 'unknown-ratchet'/.test(rCfg.stderr), rCfg.stderr.slice(0, 200));
  fs.rmSync(path.join(d, ".candor", "config"));
}

// ── doc drift gates (TESTING.md §9): the family phrases the docs must carry ────────────────────────
// README/AGENTS are load-bearing self-descriptions: they must state the CURRENT spec contract
// (no stale generation strings — AGENTS.md shipped "spec 0.7" examples a full generation after the
// 0.8 roll) and, wherever they lean on the reference engine, attribute it (candor-java IS the
// reference — the family ruling the baseline/pure semantics cite).
//
// TWO FIXES, both from the 0.23→0.24 bump, where this gate was GREEN while the doc it gates carried a
// stale current-contract claim:
//
//   FORM. The old detector was `/spec 0\.2[0-3]\b/` — a SPACE. README's envelope row writes
//   `spec: "0.23"`, with a colon and quotes, so the stale string walked straight past a check whose
//   whole job was catching it. The separator is now any 1-4 of quote/colon/space/hyphen, which covers
//   `spec 0.27`, `spec: "0.24"`, `spec-0.24` and `candor-spec 0.27` (package.json's npm description —
//   the most externally visible copy of all, and the one that shipped to the registry stale).
//   Deliberately NOT `[^0-9A-Za-z]`: that class matches the `§` in a lowercase `spec §6.1`, turning a
//   section reference into the version "6.1".
//
//   EXEMPTION. The old detector enumerated stale RANGES with a hole at 0.8, because AGENTS.md's
//   `unitKind: "export"` (spec 0.8, informative)` is a HISTORICAL MARKER — it names the rung a field
//   arrived at and must not move when the floor does. An enumeration encodes the wrong thing: it
//   false-positives the next legitimate annotation, and it needs an edit every time the floor moves.
//   The gate now keys on the `, informative)` marker itself, which IS the current-contract-versus-
//   history distinction, and compares everything else against the ONE current value.
//
// And that value is READ FROM scan.mjs, not written here. A literal in a drift gate pins the drift it
// exists to catch — exactly how candor-java's docs gate stayed green through this same bump.
if (blk()) {
  const SPEC = (fs.readFileSync(path.join(HERE, "scan.mjs"), "utf8")
    .match(/const SPEC_VERSION = "([0-9]+\.[0-9]+)"/) ?? [])[1];
  check("the doc gate reads the spec floor off scan.mjs (not a literal)", !!SPEC, String(SPEC));
  // Any `spec` + version, capturing a trailing historical marker so it can be told apart.
  const claim = /spec[-: "]{1,4}([0-9]+\.[0-9]+)(, informative\))?/g;
  const staleIn = (doc) =>
    [...doc.matchAll(claim)].filter((m) => !m[2] && m[1] !== SPEC).map((m) => m[0]);

  // A NEGATIVE CONTROL for the exemption. If `, informative)` ever stopped matching, the filter above
  // would silently pass everything and this whole gate would become a no-op that still printed ok.
  const probe = `(spec 0.8, informative) and a live spec: "0.9" and a section ref spec §6.1`;
  check("the historical-marker exemption discriminates (skips `, informative)`, keeps a live claim, ignores `spec §`)",
        JSON.stringify(staleIn(probe)) === JSON.stringify([`spec: "0.9`]), JSON.stringify(staleIn(probe)));

  // package.json's description is the npm REGISTRY page — a current-contract claim with the widest
  // audience of any doc here, and the last one anybody looks at.
  for (const f of ["README.md", "AGENTS.md", "package.json"]) {
    const doc = fs.readFileSync(path.join(HERE, f), "utf8");
    check(`${f} states the current spec contract (spec ${SPEC})`,
          new RegExp(`spec[-: "]{1,4}${SPEC.replace(".", "\\.")}\\b`).test(doc));
    const stale = staleIn(doc);
    check(`${f} carries no stale spec-generation string`, stale.length === 0, JSON.stringify(stale));
  }

  for (const f of ["README.md", "AGENTS.md"]) {
    const doc = fs.readFileSync(path.join(HERE, f), "utf8");
    const refLines = doc.split("\n").filter((l) => /reference engine/i.test(l));
    check(`${f} mentions the reference engine at least once`, refLines.length > 0);
    check(`${f}: every "reference engine" mention attributes candor-java`,
          refLines.every((l) => /candor-java/.test(l)),
          JSON.stringify(refLines.filter((l) => !/candor-java/.test(l))));
  }
  // ⟨0.24⟩ …AND the `unknownWhy` kind vocabulary, which is the OTHER thing this doc restates from the spec
  // and the one §4 ⟨0.24⟩ names as the drift surface: "an engine holds this vocabulary twice, and the
  // halves drift". candor-ts holds the executable copy ONCE (policy.mjs's prefix table — no enum, no union,
  // no validator), so AGENTS.md IS the second copy, and a doc that lists four kinds while the table
  // classifies five is the same divergence one layer out. Measured before this gate: the doc named
  // `call:jwt.sign` — a RETIRED origin the engine has not emitted since the `callback:param#i` form landed
  // — as a live example, alongside no mention of `ambiguous:` at all.
  {
    const doc = fs.readFileSync(path.join(HERE, "AGENTS.md"), "utf8");
    for (const k of ["reflect:", "native:", "dispatch:", "callback:", "ambiguous:"])
      check(`AGENTS.md names §4's kind \`${k}\` (the closed five-kind vocabulary)`, doc.includes(`\`${k}`), k);
    check("AGENTS.md names no RETIRED `call:` origin (the engine emits `callback:param#i`)",
          !/`call:/.test(doc), (doc.match(/`call:[^`]*`/g) ?? []).join(" "));
  }
}

// ── candor verify: the dynamic honesty oracle, end to end (scan → run → check) ────────────────────
if (blk()) {
  const d = project({
    "app.ts": `import fs from "node:fs";
function reads(): number { return fs.statSync(process.execPath).size; }
function pure(x: number): number { return x + 1; }
function main(): void { reads(); pure(2); }
main();
`,
    "package.json": '{"name":"vapp","version":"0.0.0","type":"module"}',
  });
  const { report } = scan(d);
  const canStripTypes = spawnSync("node", ["--experimental-strip-types", "-e", "0"], { encoding: "utf8" }).status === 0;
  if (!canStripTypes) {
    check("verify: end-to-end (SKIPPED — node lacks --experimental-strip-types)", true);
  } else {
    const runCmd = `node --experimental-strip-types ${JSON.stringify(path.join(d, "app.ts"))}`;
    const verify = (prefix) => spawnSync("node",
      [path.join(HERE, "verify.mjs"), d, "--report", prefix, "--run", runCmd, "--json"],
      { encoding: "utf8" });
    // (a) HAPPY PATH — candor is sound, so the invariant HOLDS (the effectful `reads` declared Fs).
    const h = verify(path.join(d, ".candor", "report"));
    let hj = null; try { hj = JSON.parse(h.stdout); } catch { /* parse below */ }
    check("verify: a sound scan HOLDS the honesty invariant (exit 0)",
      h.status === 0 && hj?.metrics.honestyInvariantHolds === true && hj?.metrics.cardinalSinViolations === 0,
      `exit=${h.status} out=${(h.stdout || "").slice(0, 200)} err=${(h.stderr || "").slice(0, 200)}`);
    check("verify: the effectful fn is attributed + checked (observed Fs ⊆ inferred Fs)",
      hj?.metrics.soundCompleteOk >= 1, JSON.stringify(hj?.metrics));
    // (b) SEEDED MISS — a report that (wrongly) declares `reads` complete-pure. verify must catch the
    // escaped Fs the run exhibits and exit 1: the cardinal-sin falsifier working.
    const seedDir = scratch("candor-verify-seed-");
    const seeded = structuredClone(report);
    for (const e of seeded.functions) if (e.fn === "app.reads") e.inferred = [];
    fs.writeFileSync(path.join(seedDir, "s.seed.scan.json"), JSON.stringify(seeded));
    const s = verify(path.join(seedDir, "s"));
    let sj = null; try { sj = JSON.parse(s.stdout); } catch { /* below */ }
    check("verify: a SEEDED silent miss (declared pure, ran Fs) is a VIOLATION (exit 1)",
      s.status === 1 && sj?.metrics.cardinalSinViolations === 1
        && sj?.violations?.[0]?.fn === "app.reads" && sj?.violations?.[0]?.escaped?.includes("Fs"),
      `exit=${s.status} out=${(s.stdout || "").slice(0, 200)}`);
    // (b2) TRANSITIVE-CALLER MISS — candor's report is transitive, so a CALLER that reaches an effect through
    // a callee is itself effectful. The oracle must attribute the effect to that caller (via the FULL stack,
    // not just the nearest/leaf frame) and catch it when the report wrongly declares the caller pure. Fixture
    // main → middle → leaf(fs): seed `middle` pure, leave the leaf correct → a VIOLATION on the CALLER.
    const td = project({
      "t.ts": `import fs from "node:fs";
function leaf(): number { return fs.statSync(process.execPath).size; }
function middle(): number { return leaf(); }
function main(): void { middle(); }
main();
`,
      "package.json": '{"name":"tvapp","version":"0.0.0","type":"module"}',
    });
    const { report: trep } = scan(td);
    check("verify: candor's report is transitive (a caller of an Fs leaf is itself Fs)",
      trep.functions.some((e) => e.fn === "t.middle" && (e.inferred || []).includes("Fs"))
        && trep.functions.some((e) => e.fn === "t.main" && (e.inferred || []).includes("Fs")),
      JSON.stringify(trep.functions.map((e) => [e.fn, e.inferred])));
    const tRun = `node --experimental-strip-types ${JSON.stringify(path.join(td, "t.ts"))}`;
    const tVerify = (prefix) => spawnSync("node",
      [path.join(HERE, "verify.mjs"), td, "--report", prefix, "--run", tRun, "--json"], { encoding: "utf8" });
    // sound report → holds, and transitive attribution witnesses the whole chain (leaf + middle + main).
    const th = tVerify(path.join(td, ".candor", "report"));
    let thj = null; try { thj = JSON.parse(th.stdout); } catch { /* below */ }
    check("verify: transitive attribution witnesses the caller chain (≥3 fns checked), HOLDS",
      th.status === 0 && thj?.metrics.honestyInvariantHolds === true && thj?.metrics.executedFunctionsChecked >= 3,
      `exit=${th.status} m=${JSON.stringify(thj?.metrics)}`);
    // seed the miss at the CALLER `middle` (leave the leaf correct) → must VIOLATE on t.middle, not only t.leaf.
    const tSeedDir = scratch("candor-verify-tseed-");
    const tseeded = structuredClone(trep);
    for (const e of tseeded.functions) if (e.fn === "t.middle") e.inferred = [];
    fs.writeFileSync(path.join(tSeedDir, "t.seed.scan.json"), JSON.stringify(tseeded));
    const ts = tVerify(path.join(tSeedDir, "t"));
    let tsj = null; try { tsj = JSON.parse(ts.stdout); } catch { /* below */ }
    check("verify: a TRANSITIVE-caller miss (caller declared pure, reaches Fs through a callee) VIOLATES on the caller",
      ts.status === 1 && (tsj?.violations || []).some((v) => v.fn === "t.middle" && v.escaped?.includes("Fs")),
      `exit=${ts.status} out=${(ts.stdout || "").slice(0, 300)}`);
    // (c) DISCLOSURE FLIPS IT — the same run under an `Unknown` disclosure HOLDS (disclosed-partial).
    const discDir = scratch("candor-verify-disc-");
    const disc = structuredClone(report);
    for (const e of disc.functions) if (e.fn === "app.reads") e.inferred = ["Unknown"];
    // Write a CANONICAL report + copy the real span sidecar so attribution is COMPLETE (mirrors a real scan):
    // otherwise the doctored report has no <prefix>.locs.json and verify correctly fails closed (exit 2).
    fs.writeFileSync(path.join(discDir, "rep.json"), JSON.stringify(disc));
    fs.copyFileSync(path.join(d, ".candor", "report.locs.json"), path.join(discDir, "rep.locs.json"));
    const c = verify(path.join(discDir, "rep"));
    let cj = null; try { cj = JSON.parse(c.stdout); } catch { /* below */ }
    check("verify: disclosure (Unknown) flips the same run to HELD (disclosed-partial, load-bearing)",
      c.status === 0 && cj?.metrics.honestyInvariantHolds === true && cj?.metrics.disclosedUnknownLoadBearing === 1,
      `exit=${c.status} out=${(c.stdout || "").slice(0, 200)}`);
    // (d) ESM DESTRUCTURED named import of a builtin — the capture path the module.register loader closes
    // (the preload's default-object patch alone would miss it, since node:fs's named `statSync` is a distinct
    // binding). A seeded miss on it must still be caught, proving the loader wrapped the named export.
    const nd = project({
      "napp.ts": `import { statSync } from "node:fs";\nfunction reads(): number { return statSync(process.execPath).size; }\nfunction main(): void { reads(); }\nmain();\n`,
      "package.json": '{"name":"nvapp","version":"0.0.0","type":"module"}',
    });
    const { report: nrep } = scan(nd);
    const nSeedDir = scratch("candor-verify-nseed-");
    const nseeded = structuredClone(nrep);
    for (const e of nseeded.functions) if (e.fn === "napp.reads") e.inferred = [];
    fs.writeFileSync(path.join(nSeedDir, "n.seed.scan.json"), JSON.stringify(nseeded));
    const nRun = `node --experimental-strip-types ${JSON.stringify(path.join(nd, "napp.ts"))}`;
    const n = spawnSync("node", [path.join(HERE, "verify.mjs"), nd, "--report", path.join(nSeedDir, "n"), "--run", nRun, "--json"], { encoding: "utf8" });
    let njson = null; try { njson = JSON.parse(n.stdout); } catch { /* below */ }
    check("verify: an ESM DESTRUCTURED named builtin import is captured (the loader closes the gap)",
      n.status === 1 && njson?.violations?.[0]?.fn === "napp.reads" && njson?.violations?.[0]?.escaped?.includes("Fs"),
      `exit=${n.status} out=${(n.stdout || "").slice(0, 200)}`);
    // (e) ATTRIBUTION SOUNDNESS — a PURE fn (absent from the §2 report, BETWEEN two effectful fns) that
    // secretly runs an effect must anchor to ITSELF via the all-fn loc index (<prefix>.locs.json) and surface
    // as a VIOLATION — not fold into the nearest preceding effectful fn, whose claim would absorb it (the
    // silent false-all-clear the dogfood found). Scan a SOUND version (computeTotal pure ⇒ absent from the
    // report, PRESENT in the loc index), then make computeTotal read a file on the SAME line (report + locs
    // stay valid) and run: the loc index puts the Fs on computeTotal, and candor claims it pure ⇒ VIOLATION.
    const outTmp = path.join(os.tmpdir(), "papp-out.txt");
    const pd = project({
      "papp.ts": `import { readFileSync, writeFileSync } from "node:fs";
function loadCfg(p: string): string { return readFileSync(p, "utf8"); }
function saveOut(p: string, s: string): void { writeFileSync(p, s); }
function computeTotal(): number { const salt = 0; return salt - salt; }
function run(): void { const c = loadCfg(process.execPath); saveOut(${JSON.stringify(outTmp)}, String(computeTotal()) + c.length); }
run();
`,
      "package.json": '{"name":"papp","version":"0.0.0","type":"module"}',
    });
    const { report: prep, prefix: ppfx } = scan(pd);
    const locs = fs.existsSync(`${ppfx}.locs.json`) ? JSON.parse(fs.readFileSync(`${ppfx}.locs.json`, "utf8")) : {};
    check("verify: the all-fn loc index is emitted and includes PURE fns (computeTotal)",
      !!locs["papp.computeTotal"] && !prep.functions.find((e) => e.fn === "papp.computeTotal"),
      `locs=${JSON.stringify(locs)} effectful=${prep.functions.map((e) => e.fn).join(",")}`);
    // secretly make the "pure" fn read a file — SAME line, so the scanned report + loc index stay valid.
    const psrc = fs.readFileSync(path.join(pd, "papp.ts"), "utf8")
      .replace("const salt = 0;", 'const salt = readFileSync(process.execPath, "utf8").length;');
    fs.writeFileSync(path.join(pd, "papp.ts"), psrc);
    const pRun = `node --experimental-strip-types ${JSON.stringify(path.join(pd, "papp.ts"))}`;
    const pv = spawnSync("node", [path.join(HERE, "verify.mjs"), pd, "--report", ppfx, "--run", pRun, "--json"], { encoding: "utf8" });
    let pj = null; try { pj = JSON.parse(pv.stdout); } catch { /* below */ }
    check("verify: a PURE fn that runs an effect is caught via the loc index (not folded into a neighbour)",
      pv.status === 1 && pj?.metrics.attributionComplete === true
        && pj?.violations?.some((v) => v.fn === "papp.computeTotal" && v.escaped?.includes("Fs")),
      `exit=${pv.status} out=${(pv.stdout || "").slice(0, 220)}`);
    // (f) FAIL-CLOSED: an EMPTY span sidecar drops every captured site — verify must exit 2 (attribution
    // INCOMPLETE), never a green exit 0 over a run whose real effects could not be placed (review #4/#7).
    const emptyDir = scratch("candor-verify-empty-");
    fs.writeFileSync(path.join(emptyDir, "rep.json"), JSON.stringify(report)); // a SOUND envelope (reads=Fs)…
    fs.writeFileSync(path.join(emptyDir, "rep.locs.json"), "{}");              // …but an EMPTY span index
    const ec = verify(path.join(emptyDir, "rep"));
    let ecj = null; try { ecj = JSON.parse(ec.stdout); } catch { /* below */ }
    check("verify: an empty loc index fails CLOSED (exit 2, attribution INCOMPLETE) — never a false HOLD",
      ec.status === 2 && ecj?.metrics.attributionComplete === false && ecj?.metrics.unattributedSites >= 1,
      `exit=${ec.status} out=${(ec.stdout || "").slice(0, 200)}`);
  }
}

// ── the DIST-PACKAGE interface union (scan-boundary vein) ─────────────────────────────────────────
// A published package ships compiled `dist` JS beside its `.d.ts`, and `implements` survives ONLY in the
// typings — so the interface-union emitter, which walks the CLASS's heritage clauses, found nothing and a
// chained consumer dispatching on the interface could never resolve. The relation is recovered from the
// package's OWN typings module's exports, paired to the scanned dist class by exported name.
if (blk()) {
  const CHAIN = { ...process.env, CANDOR_WORKSPACE_CHAIN: "1" };
  const distDep = () => project({
    "package.json": `{"name":"depkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k, v) { fs.writeFileSync("/tmp/" + k, v); } }
exports.FileStore = FileStore;
function build() { return new FileStore(); }
exports.build = build;`,
    "dist/index.d.ts": `export interface Store { save(k: string, v: string): void; }
export declare class FileStore implements Store { save(k: string, v: string): void; }
export declare function build(): Store;`,
  });
  const chainScan = (dir, ...extra) => {
    const rp = path.join(dir, ".candor", "report");
    fs.rmSync(`${rp}.json`, { force: true }); // never read a stale arm back (standing bar item 8)
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), dir, ...extra], { encoding: "utf8", env: CHAIN });
    return { r, report: fs.existsSync(`${rp}.json`) ? JSON.parse(fs.readFileSync(`${rp}.json`, "utf8")) : null, prefix: rp };
  };

  const dep = distDep();
  const ds = chainScan(dep, "--allow-js");
  const union = ds.report?.functions.find((e) => e.hash === "depkit#Store.save");
  check("a dist package publishes the union for an interface declared only in its TYPINGS",
        union?.interfaceUnion === true && union?.inferred.includes("Fs"),
        JSON.stringify(ds.report?.functions.map((e) => [e.hash, e.inferred])));

  // the consumer: dispatch on the interface type across the boundary. Before this, half 1 disclosed
  // `Unknown[dispatch:depkit.Store.save]` — a key formed that no report could ever answer.
  const app = project({
    "package.json": `{"name":"shopapp","dependencies":{"depkit":"1.0.0"}}`,
    "node_modules/depkit/package.json": `{"name":"depkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "node_modules/depkit/dist/index.js": ``,
    "node_modules/depkit/dist/index.d.ts": `export interface Store { save(k: string, v: string): void; }
export declare class FileStore implements Store { save(k: string, v: string): void; }
export declare function build(): Store;`,
    "src/use.ts": `import { Store } from "depkit";
export function go(s: Store): void { s.save("a", "b"); }`,
    "fs.pol": `deny Fs\n`,
  });
  fs.rmSync(path.join(app, ".candor", "report.json"), { force: true });
  const ar = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "fs.pol")],
                       { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(dep, ".candor", "report.json") } });
  const arep = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  check("the chained consumer RESOLVES the dist package's interface dispatch (was Unknown[dispatch])",
        entry(arep, "src.use.go")?.inferred.join() === "Fs", JSON.stringify(arep.functions));
  check("…and the two-tree `deny Fs` gate fires again (exit 1)", ar.status === 1, `exit=${ar.status}`);
  // the single-tree control: identical source in ONE project. This is what proves it is a BOUNDARY defect.
  const ctl = project({
    "package.json": `{"name":"ctl"}`,
    "src/dep.ts": `import * as fs from "node:fs";
export interface Store { save(k: string, v: string): void; }
export class FileStore implements Store { save(k: string, v: string): void { fs.writeFileSync("/tmp/" + k, v); } }`,
    "src/use.ts": `import { Store } from "./dep.js";
export function go(s: Store): void { s.save("a", "b"); }`,
    "fs.pol": `deny Fs\n`,
  });
  check("single-tree control: the same dispatch fails the same gate (exit 1)",
        scan(ctl, "--policy", path.join(ctl, "fs.pol")).r.status === 1);

  // flag OFF: a default scan of the same package emits no union entry at all.
  const off = scan(dep, "--allow-js");
  check("without CANDOR_WORKSPACE_CHAIN a dist package emits NO union entry",
        !off.report?.functions.some((e) => e.interfaceUnion), JSON.stringify(off.report?.functions.map((e) => e.hash)));

  // FABRICATION control: the interface belongs to ANOTHER package. Pairing by name is authoritative only
  // WITHIN a package; re-keying a foreign interface under ours is the leaf-name join this vein has been
  // burned by, so the arm must decline.
  const foreign = project({
    "package.json": `{"name":"depkit2","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "node_modules/other/package.json": `{"name":"other","types":"index.d.ts","main":"index.js"}`,
    "node_modules/other/index.js": ``,
    "node_modules/other/index.d.ts": `export interface Store { save(k: string, v: string): void; }`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k, v) { fs.writeFileSync("/tmp/" + k, v); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": `import { Store } from "other";
export declare class FileStore implements Store { save(k: string, v: string): void; }`,
  });
  const fr = chainScan(foreign, "--allow-js");
  check("an interface owned by ANOTHER package is never re-keyed under this one (no cross-package name join)",
        !fr.report?.functions.some((e) => e.hash.endsWith("#Store.save")),
        JSON.stringify(fr.report?.functions.map((e) => e.hash)));

  // THE SECOND FIXTURE (standing bar item 0): the arm must not COST anything. A package built to `dist`
  // keeps a `types` entry that is the generated SHADOW of the very source being scanned, so both arms carry
  // `interface Store` — and treating that as an ambiguous name deleted the real in-scan union entries. This
  // is not hypothetical: it removed seven from @ukri-tfs/common's report before the A/B caught it.
  const shadowed = project({
    "package.json": `{"name":"shadowed","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "tsconfig.json": `{"include":["src"]}`,
    "src/index.ts": `import * as fs from "node:fs";
export interface Store { save(k: string): void; }
export class FileStore implements Store { save(k: string): void { fs.writeFileSync(k, "x"); } }`,
    "dist/index.d.ts": `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }`,
  });
  const sh = chainScan(shadowed);
  check("a package whose TYPINGS shadow its scanned source KEEPS its in-scan union entry",
        sh.report?.functions.find((e) => e.hash === "shadowed#Store.save")?.inferred.includes("Fs"),
        JSON.stringify(sh.report?.functions.map((e) => [e.hash, e.inferred])));

  // the union's class-name join UNIONS every unit sharing the tail rather than picking one last-wins: a
  // package built twice (dist/cjs + dist/esm, or src + dist) has two units per class, and publishing one
  // build's effects as the whole answer is a silent under-report of the other's.
  const dual = project({
    "package.json": `{"name":"dual","main":"dist/cjs/index.js","types":"dist/cjs/index.d.ts"}`,
    "dist/cjs/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/cjs/index.d.ts": `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }`,
    "dist/esm/index.js": `export class FileStore { save(k) { /* pure in this build */ } }`,
  });
  const du = chainScan(dual, "--allow-js");
  check("the union covers EVERY build of a doubly-compiled class (not just the last one seen)",
        du.report?.functions.find((e) => e.hash === "dual#Store.save")?.inferred.includes("Fs"),
        JSON.stringify(du.report?.functions.map((e) => [e.hash, e.inferred])));

  // the same-package test compares REALPATHS. A workspace package is reached through a node_modules
  // symlink (the monorepo shape this vein already had to fix once), and TypeScript resolves a bare
  // self-reference to the symlink TARGET — so a textual prefix test rejects the package's own typings and
  // the guard becomes an under-report. Verified to catch: with the textual test, no union is emitted here.
  const ws = project({
    "packages/symkit/package.json": `{"name":"symkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "packages/symkit/dist/types.d.ts": `export interface Store { save(k: string): void; }`,
    "packages/symkit/dist/index.d.ts": `import { Store } from "symkit/dist/types.js";
export { Store };
export declare class FileStore implements Store { save(k: string): void; }`,
    "packages/symkit/dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
  });
  fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
  fs.symlinkSync(path.join(ws, "packages", "symkit"), path.join(ws, "node_modules", "symkit"), "dir");
  const wr = chainScan(path.join(ws, "node_modules", "symkit"), "--allow-js");
  check("a workspace package reached through a node_modules SYMLINK still emits its union",
        wr.report?.functions.find((e) => e.hash === "symkit#Store.save")?.interfaceUnion === true,
        JSON.stringify(wr.report?.functions.map((e) => [e.hash, e.inferred])));

  // ── THE CENSUS COVERS WHAT THE KEY COVERS ───────────────────────────────────────────────────────
  // The union hash is `pkg#Iface.member` — package plus a BARE interface name — so EVERY interface of
  // that name in the package maps to it, whichever subpath exported it. Reading only the `.` typings
  // left the ambiguity counter blind to the rest: an effectful `Store` on `.` published its `Fs` as the
  // answer a consumer of `pkg/sub`'s unrelated PURE `Store` resolves to. A fabricated effect and a
  // fabricated `deny Fs` catch, in the direction this vein's item 1 says never to trade for.
  const SUBKIT_PKG = `{"name":"subkit","main":"dist/index.js","types":"dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},"./sub":{"types":"./dist/sub.d.ts","default":"./dist/sub.js"}}}`;
  const SUBKIT_MAIN_DTS = `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }`;
  const SUBKIT_SUB_DTS = `export interface Store { save(k: string): void; }
export declare class MemStore implements Store { save(k: string): void; }`;
  const subkit = project({
    "package.json": SUBKIT_PKG,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": SUBKIT_MAIN_DTS,
    "dist/sub.js": `"use strict";
class MemStore { save(k) { /* pure — nothing here can touch the disk */ } }
exports.MemStore = MemStore;`,
    "dist/sub.d.ts": SUBKIT_SUB_DTS,
  });
  const sk = chainScan(subkit, "--allow-js");
  check("two DIFFERENT interfaces exported under one name through different subpaths: the name is REFUSED",
        !sk.report?.functions.some((e) => e.hash === "subkit#Store.save"),
        JSON.stringify(sk.report?.functions.map((e) => [e.hash, e.inferred])));

  const subapp = project({
    "package.json": `{"name":"subapp","dependencies":{"subkit":"1.0.0"}}`,
    "node_modules/subkit/package.json": SUBKIT_PKG,
    "node_modules/subkit/dist/index.js": ``,
    "node_modules/subkit/dist/index.d.ts": SUBKIT_MAIN_DTS,
    "node_modules/subkit/dist/sub.js": ``,
    "node_modules/subkit/dist/sub.d.ts": SUBKIT_SUB_DTS,
    "src/use.ts": `import { Store } from "subkit/sub";
export function go(s: Store): void { s.save("a"); }`,
    "fs.pol": `deny Fs\n`,
  });
  fs.rmSync(path.join(subapp, ".candor", "report.json"), { force: true });
  const skr = spawnSync("node", [path.join(HERE, "scan.mjs"), subapp, "--policy", path.join(subapp, "fs.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(subkit, ".candor", "report.json") } });
  const skrep = JSON.parse(fs.readFileSync(path.join(subapp, ".candor", "report.json"), "utf8"));
  check("…and the consumer of the OTHER subpath discloses Unknown instead of inheriting the Fs",
        entry(skrep, "src.use.go")?.inferred.join() === "Unknown"
          && entry(skrep, "src.use.go")?.unknownWhy?.some((w) => w.startsWith("dispatch:")),
        JSON.stringify(entry(skrep, "src.use.go")));
  check("…so `deny Fs` no longer fires on a dispatch that cannot touch the disk (exit 0)",
        skr.status === 0, `exit=${skr.status}`);
  // the single-tree control — the same two interfaces in ONE project, no boundary. Exit 0 in BOTH arms:
  // this is a fabrication, so the control is what proves the split arm was inventing the catch, not that
  // the merged arm is missing it.
  const skctl = project({
    "package.json": `{"name":"skctl"}`,
    "src/main.ts": `import * as fs from "node:fs";
export interface Store { save(k: string): void; }
export class FileStore implements Store { save(k: string): void { fs.writeFileSync(k, "x"); } }`,
    "src/sub.ts": `export interface Store { save(k: string): void; }
export class MemStore implements Store { save(k: string): void { /* pure */ } }`,
    "src/use.ts": `import { Store } from "./sub.js";
export function go(s: Store): void { s.save("a"); }`,
    "fs.pol": `deny Fs\n`,
  });
  const skc = scan(skctl, "--policy", path.join(skctl, "fs.pol"));
  check("single-tree control: in ONE project the same dispatch is charged no Fs at all",
        !(entry(skc.report, "src.use.go")?.inferred ?? []).includes("Fs"),
        JSON.stringify(entry(skc.report, "src.use.go") ?? null));

  // THE SECOND FIXTURE, and it comes first (standing bar item 0): widening the census is a NARROWING of
  // what may be published, so it must be shown not to have narrowed past the real arms. A subpath-only
  // interface with an unambiguous name must now publish its union — the widening is a GAIN direction as
  // well as a refusal — and the main entry's union must survive beside it.
  const twokit = project({
    "package.json": `{"name":"twokit","main":"dist/index.js","types":"dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},"./q":{"types":"./dist/q.d.ts","default":"./dist/q.js"}}}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": SUBKIT_MAIN_DTS,
    "dist/q.js": `"use strict";
const https = require("node:https");
class HttpQueue { push(k) { https.get("http://q.example.com/" + k); } }
exports.HttpQueue = HttpQueue;`,
    "dist/q.d.ts": `export interface Queue { push(k: string): void; }
export declare class HttpQueue implements Queue { push(k: string): void; }`,
  });
  const tk = chainScan(twokit, "--allow-js");
  check("a SUBPATH-only interface with an unambiguous name now publishes its union too",
        tk.report?.functions.find((e) => e.hash === "twokit#Queue.push")?.inferred.includes("Net"),
        JSON.stringify(tk.report?.functions.map((e) => [e.hash, e.inferred])));
  check("…and the main entry point's union is untouched by the widening",
        tk.report?.functions.find((e) => e.hash === "twokit#Store.save")?.inferred.includes("Fs"),
        JSON.stringify(tk.report?.functions.map((e) => [e.hash, e.inferred])));

  // The other second fixture: a RE-EXPORT is ONE declaration, not two. `index.d.ts` re-exporting `./sub`
  // means both entry points name the same interface, and counting them twice would refuse every package
  // that ships a barrel file — the widening turning into the under-report it exists to avoid. One
  // program over all the roots is what makes the node identity hold; per-root programs would not.
  const rekit = project({
    "package.json": `{"name":"rekit","main":"dist/index.js","types":"dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},"./sub":{"types":"./dist/sub.d.ts","default":"./dist/sub.js"}}}`,
    "dist/index.js": `"use strict";
module.exports = require("./sub.js");`,
    "dist/index.d.ts": `export * from "./sub.js";`,
    "dist/sub.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/sub.d.ts": SUBKIT_MAIN_DTS,
  });
  check("a BARREL re-export is one declaration, not an ambiguous pair",
        chainScan(rekit, "--allow-js").report?.functions
          .find((e) => e.hash === "rekit#Store.save")?.inferred.includes("Fs"));

  // `typesVersions` is the shape 8 of 343 corpus packages declare and 7 spell with a `*` — it names files
  // WITHOUT the extension (`{"*":{"*":["dist/*"]}}`), so the census has to put `.d.ts` back and expand the
  // star, or the second `Store` is invisible exactly as it was through `exports`.
  const wildkit = project({
    "package.json": `{"name":"wildkit","main":"dist/index.js","types":"dist/index.d.ts","typesVersions":{"*":{"*":["dist/*"]}}}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": SUBKIT_MAIN_DTS,
    "dist/other.js": `"use strict";
class MemStore { save(k) { } }
exports.MemStore = MemStore;`,
    "dist/other.d.ts": SUBKIT_SUB_DTS,
  });
  check("a WILDCARD typesVersions entry is expanded, so its second `Store` is counted",
        !chainScan(wildkit, "--allow-js").report?.functions.some((e) => e.hash === "wildkit#Store.save"));

  // A star that expands past the cap means the census is INCOMPLETE, and half a census is what re-opens
  // the fabrication — so the typings arm is refused outright rather than published on partial evidence.
  const bigFiles = { "package.json": `{"name":"bigkit","main":"dist/index.js","types":"dist/index.d.ts","typesVersions":{"*":{"*":["dist/*"]}}}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": SUBKIT_MAIN_DTS };
  for (let i = 0; i < 200; i++) bigFiles[`dist/f${i}.d.ts`] = `export declare const x${i}: number;\n`;
  check("a typings census truncated by the cap publishes NOTHING from the typings, not half of it",
        !chainScan(project(bigFiles), "--allow-js").report?.functions.some((e) => e.interfaceUnion));

  // ── A TRUNCATED CENSUS REFUSES TO PUBLISH, NOT TO LOOK ──────────────────────────────────────────
  // The check above passes for a package whose ONLY arm is the typings one, so it could not tell "the
  // typings arm was dropped" from "nothing was published". Dropping the arm lands the refusal on the
  // EVIDENCE side — and the evidence is the only thing that can say a name means two different things.
  // With an IN-SCAN arm present, a truncated census made the in-scan `Store` look UNIQUE: the ambiguity
  // counter read 1 instead of 2, the never-guess guard did not fire, and the package published its
  // INTERNAL `Store` (whose implementer does Net) as the answer for the PUBLIC one (whose implementer
  // writes to disk) — `mixkit#Store.save -> ['Net'] unresolved:false`, the exact fabrication `d7060ca`
  // measured and closed, restored for precisely the packages big enough to hit the cap.
  const CAPKIT_PKG = `{"name":"capkit","main":"dist/index.js","types":"dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},"./*":{"types":"./dist/*.d.ts","default":"./dist/*.js"}}}`;
  const CAPKIT_DTS = `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }`;
  const capkit = (nFillers) => {
    const files = {
      "package.json": CAPKIT_PKG,
      // the INTERNAL `Store`: a different interface that happens to share the public one's name.
      "src/internal.ts": `import * as https from "node:https";
export interface Store { save(k: string): void; }
export class MemStore implements Store { save(k: string): void { https.get("http://telemetry.example.com/" + k); } }`,
      "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
      "dist/index.d.ts": CAPKIT_DTS,
    };
    for (let i = 0; i < nFillers; i++) files[`dist/g${i}.d.ts`] = `export declare const y${i}: number;\n`;
    return project(files);
  };
  // THE SECOND FIXTURE, WRITTEN FIRST (standing bar item 0). This makes the emitter publish LESS, so the
  // failure mode to look for is a refusal that swallows the cases it was never about: a census that
  // COMPLETES — even a big one, right up under the cap — must still publish exactly what it did before.
  const capSmall = chainScan(capkit(100), "--allow-js").report;
  check("a big-but-COMPLETE typings census still publishes: the refusal is scoped to truncation",
        capSmall?.functions.some((e) => e.hash === "capkit#FileStore.save")
          && !capSmall?.functions.some((e) => e.hash === "capkit#Store.save"),
        JSON.stringify(capSmall?.functions.map((e) => [e.hash, e.inferred])));
  const capBig = chainScan(capkit(200), "--allow-js").report;
  check("…and a TRUNCATED one publishes no union at all, rather than the in-scan arm's confident answer",
        !capBig?.functions.some((e) => e.hash === "capkit#Store.save"),
        JSON.stringify(capBig?.functions.map((e) => [e.hash, e.inferred, e.interfaceUnion])));

  // The consumer arms, which are where the fabrication was cashed: a confident `Net` on a dispatch that
  // cannot reach the network, and a dropped `Fs` on one that writes to disk.
  const capapp = (producer, pol) => {
    const app = project({
      "package.json": `{"name":"capapp","dependencies":{"capkit":"1.0.0"}}`,
      "node_modules/capkit/package.json": CAPKIT_PKG,
      "node_modules/capkit/dist/index.js": ``,
      "node_modules/capkit/dist/index.d.ts": CAPKIT_DTS,
      "src/use.ts": `import { Store } from "capkit";
export function go(s: Store): void { s.save("a"); }`,
      "p.pol": pol,
    });
    fs.rmSync(path.join(app, ".candor", "report.json"), { force: true });   // standing bar item 7
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "p.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(producer, ".candor", "report.json") } });
    return { r, rep: JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")) };
  };
  const bigProducer = capkit(200);
  chainScan(bigProducer, "--allow-js");
  const capNet = capapp(bigProducer, "deny Net\n");
  check("a consumer of the truncated producer discloses the dispatch instead of inheriting a fabricated Net",
        entry(capNet.rep, "src.use.go")?.inferred.join() === "Unknown"
          && entry(capNet.rep, "src.use.go")?.unknownWhy?.includes("dispatch:capkit.Store.save"),
        JSON.stringify(entry(capNet.rep, "src.use.go")));
  check("…the fabricated `deny Net` catch is gone (exit 1 -> 0)", capNet.r.status === 0, `exit=${capNet.r.status}`);
  check("…and `deny Unknown[dispatch]` bites where the confident wrong answer sat (exit 0 -> 1)",
        capapp(bigProducer, "deny Unknown[dispatch,unresolved]\n").r.status === 1);
  // The single-tree control. Same two interfaces, one project, no boundary: the dispatch resolves to the
  // PUBLIC implementer's Fs. That is what makes the split arm's confident `Net` a boundary defect rather
  // than a limit of the analysis — and it is exit 1 on `deny Fs` in both arms, where the split arm sat
  // green at exit 0 while publishing an answer from the wrong interface entirely.
  const capctl = project({
    "package.json": `{"name":"capctl"}`,
    "src/internal.ts": `import * as https from "node:https";
export interface Store { save(k: string): void; }
export class MemStore implements Store { save(k: string): void { https.get("http://telemetry.example.com/" + k); } }`,
    "src/pub.ts": `import * as fs from "node:fs";
export interface PublicStore { save(k: string): void; }
export class FileStore implements PublicStore { save(k: string): void { fs.writeFileSync(k, "x"); } }`,
    "src/use.ts": `import { PublicStore } from "./pub.js";
export function go(s: PublicStore): void { s.save("a"); }`,
    "fs.pol": `deny Fs\n`,
  });
  const capc = scan(capctl, "--policy", path.join(capctl, "fs.pol"));
  check("single-tree control: the same dispatch resolves to Fs, never to the other interface's Net",
        entry(capc.report, "src.use.go")?.inferred.join() === "Fs" && capc.r.status === 1,
        JSON.stringify(entry(capc.report, "src.use.go")));

  // ── A NAME COLLISION IS EVIDENCE, NOT NOISE ─────────────────────────────────────────────────────
  // "The in-scan arm wins" dropped the typings arm on the NAME alone, throwing away the one piece of
  // evidence the engine had that the name means two different things. A package with an INTERNAL
  // `interface Store` (its implementer does Net) and a PUBLIC one its typings pair to an effectful
  // `FileStore` published `mixkit#Store.save -> ['Net']` with `unresolved: false`: a fabricated Net, a
  // dropped Fs and no disclosure at all. The in-scan arm alone cannot see this — a `dist` class carries
  // no heritage clause — so the defect predates the typings arm and only becomes fixable once that arm
  // exists to contradict it.
  const MIX_DTS = `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }`;
  const mixkit = project({
    "package.json": `{"name":"mixkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "src/internal.ts": `import * as https from "node:https";
export interface Store { save(k: string): void; }
export class MemStore implements Store { save(k: string): void { https.get("http://telemetry.example.com/" + k); } }`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class FileStore { save(k) { fs.writeFileSync(k, "x"); } }
exports.FileStore = FileStore;`,
    "dist/index.d.ts": MIX_DTS,
  });
  const mx = chainScan(mixkit, "--allow-js");
  check("an in-scan interface does NOT publish its answer under a name the typings give to another",
        !mx.report?.functions.some((e) => e.hash === "mixkit#Store.save"),
        JSON.stringify(mx.report?.functions.map((e) => [e.hash, e.inferred])));

  const mixapp = (pol) => {
    const app = project({
      "package.json": `{"name":"mixapp","dependencies":{"mixkit":"1.0.0"}}`,
      "node_modules/mixkit/package.json": `{"name":"mixkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
      "node_modules/mixkit/dist/index.js": ``,
      "node_modules/mixkit/dist/index.d.ts": MIX_DTS,
      "src/use.ts": `import { Store } from "mixkit";
export function go(s: Store): void { s.save("a"); }`,
      "p.pol": pol,
    });
    fs.rmSync(path.join(app, ".candor", "report.json"), { force: true });
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "p.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(mixkit, ".candor", "report.json") } });
    return { r, rep: JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")) };
  };
  const mxNet = mixapp("deny Net\n");
  check("…so the consumer discloses the dispatch instead of inheriting the OTHER interface's Net",
        entry(mxNet.rep, "src.use.go")?.inferred.join() === "Unknown"
          && entry(mxNet.rep, "src.use.go")?.unknownWhy?.includes("dispatch:mixkit.Store.save"),
        JSON.stringify(entry(mxNet.rep, "src.use.go")));
  check("…the fabricated `deny Net` catch is gone (exit 1 -> 0)", mxNet.r.status === 0, `exit=${mxNet.r.status}`);
  check("…and `deny Unknown[dispatch]` now bites where a confident wrong answer sat (exit 0 -> 1)",
        mixapp("deny Unknown[dispatch,unresolved]\n").r.status === 1);
  // the single-tree control: one project, both interfaces, the PUBLIC one's implementer effectful. The
  // dispatch resolves precisely there, which is what makes the split arm's confident `Net` a defect of
  // the boundary rather than a limit of the analysis.
  const mxctl = project({
    "package.json": `{"name":"mxctl"}`,
    "src/internal.ts": `import * as https from "node:https";
export interface Store { save(k: string): void; }
export class MemStore implements Store { save(k: string): void { https.get("http://telemetry.example.com/" + k); } }`,
    "src/pub.ts": `import * as fs from "node:fs";
export interface PublicStore { save(k: string): void; }
export class FileStore implements PublicStore { save(k: string): void { fs.writeFileSync(k, "x"); } }`,
    "src/use.ts": `import { PublicStore } from "./pub.js";
export function go(s: PublicStore): void { s.save("a"); }`,
    "fs.pol": `deny Fs\n`,
  });
  const mxc = scan(mxctl, "--policy", path.join(mxctl, "fs.pol"));
  check("single-tree control: the same dispatch resolves to Fs, and never to the other interface's Net",
        entry(mxc.report, "src.use.go")?.inferred.join() === "Fs",
        JSON.stringify(entry(mxc.report, "src.use.go")));

  // THE SECOND FIXTURE, and the reason the rule is REDUNDANCY and not the name: a `types` entry that is
  // the generated shadow of the scanned source names the SAME implementers, so the typings arm adds
  // nothing and the in-scan union must survive untouched. Counting those as two competing declarations is
  // what deleted seven real entries from @ukri-tfs/common the first time round. Distinct from the
  // `shadowed` fixture above: this one has TWO implementers, so a subset test that only handled the
  // one-class case would pass there and fail here.
  const shadow2 = project({
    "package.json": `{"name":"shadow2","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "tsconfig.json": `{"include":["src"]}`,
    "src/index.ts": `import * as fs from "node:fs";
export interface Store { save(k: string): void; }
export class FileStore implements Store { save(k: string): void { fs.writeFileSync(k, "x"); } }
export class MemStore implements Store { save(k: string): void { /* pure */ } }`,
    "dist/index.d.ts": `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }
export declare class MemStore implements Store { save(k: string): void; }`,
  });
  check("a generated SHADOW naming the same implementers leaves the in-scan union untouched",
        chainScan(shadow2).report?.functions
          .find((e) => e.hash === "shadow2#Store.save")?.inferred.includes("Fs"),
        JSON.stringify(chainScan(shadow2).report?.functions.map((e) => [e.hash, e.inferred])));

  // ── THE FAN-OUT BOUND ───────────────────────────────────────────────────────────────────────────
  // The union emitter unioned EVERY implementer, skipping the `CHA_FANOUT_LIMIT` the in-scan dispatch
  // site applies — so the producer published what its own dispatch refuses to resolve. Measured on real
  // code: rxjs's `Operator` has 70 implementers, 16 of which reach Net; rxjs's own
  // `Observable.subscribe` reads `Unknown[dispatch:src.internal.Operator.Operator.call]` while its
  // report handed a chained consumer `rxjs#Operator.call -> ['Net','Unknown']`.
  const chanLib = (n, lastEffectful) => {
    const cls = [];
    for (let i = 0; i < n - 1; i++) cls.push(`export class C${i} implements Chan { go(): void { } }`);
    cls.push(lastEffectful
      ? `export class C${n - 1} implements Chan { go(): void { https.get("http://s3.example.com/x"); } }`
      : `export class C${n - 1} implements Chan { go(): void { } }`);
    return project({ "package.json": `{"name":"fankit"}`,
      "src/index.ts": `import * as https from "node:https";
export interface Chan { go(): void; }
${cls.join("\n")}` });
  };
  // THE SECOND FIXTURES FIRST, both taken from the java sibling (`429c7b2`), which wrote them for the
  // same reason: the fixture proving a narrowing closed a fabrication cannot notice the reaches it closed
  // with it. An interface AT the bound is the widest one in-scan dispatch resolves, so it must still
  // publish precisely — a bound written as `>=` would take the whole rung with it and no smear fixture
  // would say so.
  check("an interface AT the fan-out bound (12) still publishes its precise union",
        chainScan(chanLib(12, true)).report?.functions
          .find((e) => e.hash === "fankit#Chan.go")?.inferred.join() === "Net");
  const wide = chainScan(chanLib(13, true)).report?.functions.find((e) => e.hash === "fankit#Chan.go");
  check("past the bound the union is refused: Unknown, NOT the 13-way smear",
        wide?.inferred.join() === "Unknown" && wide?.unresolved === true, JSON.stringify(wide));
  check("…and the refusal carries its reason so `deny E Unknown[dispatch]` still bites",
        wide?.unknownWhy?.join() === "dispatch:fankit.Chan.go", JSON.stringify(wide));
  // The other second fixture, and the one shape that ADDS an entry: past the bound the disclosure is
  // made even when every implementer the scan CAN see is pure. Silence would be a purity claim (SPEC §2
  // rule 3) and twelve pure implementers do not make the thirteenth pure — dropping the union and
  // leaving nothing is the cardinal sin wearing a precision fix.
  const widePure = chainScan(chanLib(13, false)).report?.functions.find((e) => e.hash === "fankit#Chan.go");
  check("a broad interface whose visible implementers are ALL pure discloses Unknown rather than nothing",
        widePure?.inferred.join() === "Unknown", JSON.stringify(widePure));

  // THE UNKNOWN TRUST MARKER IS A FUNCTION OF THE SET, not of the branch that put Unknown there. It was
  // set only on the `broad` arm, so a union INHERITING Unknown from an implementer published
  // `inferred: ['Unknown']` with `unresolved` absent — a machine consumer told in one field that the set
  // may be incomplete (SPEC §2) and in the next that it is not. Live: all seven of rxjs's published
  // unions. The REASON stays scoped to `broad`, correctly — ⟨0.6⟩ requires `unknownWhy` on a DIRECT
  // Unknown source, and an Unknown inherited from an implementer's body is not one.
  const inheritedUnknown = project({
    "package.json": `{"name":"unkkit"}`,
    "src/index.ts": `export interface Chan { go(): void; }
export class C0 implements Chan { go(): void { (globalThis as any).mystery.run(); } }`,
  });
  const iu = chainScan(inheritedUnknown).report?.functions.find((e) => e.hash === "unkkit#Chan.go");
  check("a union that INHERITS Unknown carries the trust marker, not just the broad arm",
        iu?.inferred.includes("Unknown") && iu?.unresolved === true && iu?.unknownWhy === undefined,
        JSON.stringify(iu));
  // …and the second fixture: a union with no Unknown must still say so, rather than gaining the marker.
  check("…and a union with no Unknown still reports `unresolved: false`",
        chainScan(chanLib(12, true)).report?.functions
          .find((e) => e.hash === "fankit#Chan.go")?.unresolved === false,
        JSON.stringify(chainScan(chanLib(12, true)).report?.functions.find((e) => e.hash === "fankit#Chan.go")));

  // the consumer side: what the smear did was fail `deny Net` on a dispatch that cannot reach the
  // network. After the bound it is disclosed instead — `deny Net` exit 1 -> 0, `deny Unknown[dispatch]`
  // exit 0 -> 1 — and NOTHING goes silent, which is the trade the java sibling measured too.
  const fanDep = chanLib(13, true);
  chainScan(fanDep);
  const fanApp = (pol) => {
    const app = project({
      "package.json": `{"name":"fanapp","dependencies":{"fankit":"1.0.0"}}`,
      "node_modules/fankit/package.json": `{"name":"fankit","types":"index.d.ts","main":"index.js"}`,
      "node_modules/fankit/index.js": ``,
      "node_modules/fankit/index.d.ts": `export interface Chan { go(): void; }`,
      "src/use.ts": `import { Chan } from "fankit";
export function drive(c: Chan): void { c.go(); }`,
      "p.pol": pol,
    });
    fs.rmSync(path.join(app, ".candor", "report.json"), { force: true });
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "p.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(fanDep, ".candor", "report.json") } });
    return { r, rep: JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")) };
  };
  const fanNet = fanApp("deny Net\n");
  check("the chained consumer of a BROAD interface no longer inherits the smeared Net (exit 1 -> 0)",
        fanNet.r.status === 0 && !(entry(fanNet.rep, "src.use.drive")?.inferred ?? []).includes("Net"),
        `exit=${fanNet.r.status} ${JSON.stringify(entry(fanNet.rep, "src.use.drive"))}`);
  check("…and it is DISCLOSED there, not silent: Unknown, and `deny Unknown` bites (exit 0 -> 1)",
        (entry(fanNet.rep, "src.use.drive")?.inferred ?? []).includes("Unknown")
          && fanApp("deny Unknown\n").r.status === 1,
        JSON.stringify(entry(fanNet.rep, "src.use.drive")));

  // ── A REAL ENTRY CLAIMING THE HASH NO LONGER SUPPRESSES THE UNION ───────────────────────────────
  // `if (emittedHashes.has(hash)) continue` dropped the union whenever any real entry already published
  // under it — the candor-java sibling `48a5f18`, whose argument transfers whole: `['Fs']` under a hash a
  // consumer keys on IS a purity claim about everything else that dispatch reaches. TS reaches the
  // collision by a BARE NAME (`pkg#Store.save`), so any `class Store` in the package claims the key an
  // interface-typed consumer forms — by declaration merging, or by two unrelated declarations sharing a
  // name across files.
  const COLLIDE_DTS = `export interface Store { save(k: string): void; }
export declare class FileStore implements Store { save(k: string): void; }
export declare class NetStore implements Store { save(k: string): void; }`;
  const collidekit = project({
    "package.json": `{"name":"collidekit"}`,
    "src/iface.ts": `import * as fs from "node:fs";
import * as https from "node:https";
export interface Store { save(k: string): void; }
export class FileStore implements Store { save(k: string): void { fs.writeFileSync(k, "x"); } }
export class NetStore implements Store { save(k: string): void { https.get("http://s3.example.com/" + k); } }`,
    // an UNRELATED class that happens to share the interface's bare name, so it claims `#Store.save`.
    "src/other.ts": `export class Store { save(k: string): void { void process.env.HOME; } }`,
    "src/use.ts": `import type { Store } from "./iface.js";
export function go(s: Store): void { s.save("a"); }`,
    "net.pol": `deny Net\n`,
  });
  const collideRep = chainScan(collidekit).report;
  check("a claimed hash still gets its union, as a MARKED entry beside the real one",
        collideRep?.functions.some((e) => e.hash === "collidekit#Store.save" && e.interfaceUnion
                                          && e.inferred.join() === "Fs,Net"),
        JSON.stringify(collideRep?.functions.map((e) => [e.fn, e.hash, e.inferred])));
  // THE SECOND FIXTURE, and it is why this is not java's `mergeUnionInto`. java widens the claiming entry
  // in place; it can, because there the claimant is the interface's own `default` METHOD, whose in-scan
  // dispatch site is already charged the whole CHA union. TS interfaces have no bodies, so the claimant is
  // always a CLASS body — and widening it charges that class with effects a DIFFERENT class performs.
  // Measured on this fixture with java's merge ported literally: `src.other.Store.save`, whose body only
  // reads an environment variable, comes back `['Env','Fs','Net']` and the producer's own `deny Net` names
  // it as a violator. That is the hazard java's comment names when it refuses to widen `overdeclared`, one
  // field along. The union goes in its own entry instead and SPEC §2's duplicate-hash UNION rule joins it.
  check("…and the CLAIMING entry is not rewritten: a class keeps the effects its own body has",
        collideRep?.functions.find((e) => e.fn === "src.other.Store.save")?.inferred.join() === "Env",
        JSON.stringify(collideRep?.functions.find((e) => e.fn === "src.other.Store.save")));
  const collideProd = spawnSync("node", [path.join(HERE, "scan.mjs"), collidekit, "--policy", path.join(collidekit, "net.pol")],
                                { encoding: "utf8", env: { ...process.env, CANDOR_WORKSPACE_CHAIN: "1" } });
  const collideGate = `${collideProd.stdout}\n${collideProd.stderr}`;
  check("…so the producer's own `deny Net` names the union, never the env-reading class",
        /AS-EFF-006\] `Store\.save`/.test(collideGate)
          && !/AS-EFF-006\] `src\.other\.Store\.save`/.test(collideGate),
        collideGate.split("\n").filter((l) => l.includes("AS-EFF")).join(" | "));

  const collideApp = (pol) => {
    const app = project({
      "package.json": `{"name":"collideapp","dependencies":{"collidekit":"1.0.0"}}`,
      "node_modules/collidekit/package.json": `{"name":"collidekit","main":"index.js","types":"index.d.ts"}`,
      "node_modules/collidekit/index.js": ``,
      "node_modules/collidekit/index.d.ts": COLLIDE_DTS,
      "src/use.ts": `import type { Store } from "collidekit";
export function go(s: Store): void { s.save("a"); }`,
      "p.pol": pol,
    });
    fs.rmSync(path.join(app, ".candor", "report.json"), { force: true });   // standing bar item 7
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app, "--policy", path.join(app, "p.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(collidekit, ".candor", "report.json") } });
    return { r, rep: JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8")) };
  };
  const collideNet = collideApp("deny Net\n");
  check("the chained consumer inherits the dispatch union, not just the claiming entry (deny Net 0 -> 1)",
        collideNet.r.status === 1
          && ["Env", "Fs", "Net"].every((e) => entry(collideNet.rep, "src.use.go")?.inferred.includes(e)),
        `exit=${collideNet.r.status} ${JSON.stringify(entry(collideNet.rep, "src.use.go"))}`);
  // The single-tree control: the same dispatch, one project, no boundary — `['Fs','Net']` and exit 1. That
  // is what makes the chained `['Env']` a boundary defect rather than a limit, and it is the shape of
  // `48a5f18`'s argument: the engine must not contradict itself across the scan boundary.
  const collideCtl = scan(collidekit, "--policy", path.join(collidekit, "net.pol"));
  check("single-tree control: the same dispatch reads Fs,Net in one project and `deny Net` exits 1",
        entry(collideCtl.report, "src.use.go")?.inferred.join() === "Fs,Net" && collideCtl.r.status === 1,
        `exit=${collideCtl.r.status} ${JSON.stringify(entry(collideCtl.report, "src.use.go"))}`);

  // THE OTHER SECOND FIXTURE: a claimed hash whose union adds NOTHING must produce no second entry, or a
  // merge that fires when there is nothing to merge is just bloating the report. java's `mergeUnionInto`
  // returns `real` unchanged for exactly this case.
  const quietClaim = project({
    "package.json": `{"name":"quietkit"}`,
    "src/iface.ts": `import * as fs from "node:fs";
export interface Store { save(k: string): void; }
export class FileStore implements Store { save(k: string): void { fs.writeFileSync(k, "x"); } }`,
    "src/other.ts": `import * as fs from "node:fs";
export class Store { save(k: string): void { fs.writeFileSync(k, "y"); } }`,
  });
  check("a claimed hash whose union adds nothing publishes no second entry",
        chainScan(quietClaim).report?.functions.filter((e) => e.hash === "quietkit#Store.save").length === 1,
        JSON.stringify(chainScan(quietClaim).report?.functions.map((e) => [e.fn, e.hash, e.inferred])));

  // DECLARATION MERGING, the other door to the same collision: `interface Store` and `class Store` are one
  // name, so the class's own `save` claims the key. The checker resolves a `Store`-typed receiver to the
  // class body, so this one under-reports in-scan too — but the published artifact must not, since a
  // structurally-compatible `NetStore` is assignable to `Store` and the emitter had already computed that.
  const mergekit = project({
    "package.json": `{"name":"mergekit"}`,
    "src/index.ts": `import * as fs from "node:fs";
import * as https from "node:https";
export interface Store { save(k: string): void; }
export class Store { save(k: string): void { fs.writeFileSync(k, "x"); } }
export class NetStore implements Store { save(k: string): void { https.get("http://s3.example.com/" + k); } }`,
  });
  check("a DECLARATION-MERGED class+interface publishes the union too",
        chainScan(mergekit).report?.functions.some((e) => e.hash === "mergekit#Store.save" && e.interfaceUnion),
        JSON.stringify(chainScan(mergekit).report?.functions.map((e) => [e.fn, e.hash, e.inferred])));

  // AND THE `broad` CASE, which is what the fan-out bound exists for: past the bound the union publishes
  // `['Unknown'] unresolved:true`, and a claiming entry used to REPLACE that disclosure with a confident
  // answer about a dispatch the engine had just refused to resolve.
  const broadClaim = (() => {
    const cls = [];
    for (let i = 0; i < 13; i++) cls.push(`export class C${i} implements Store { save(k: string): void { } }`);
    return project({
      "package.json": `{"name":"broadkit"}`,
      "src/iface.ts": `export interface Store { save(k: string): void; }
${cls.join("\n")}`,
      "src/other.ts": `import * as fs from "node:fs";
export class Store { save(k: string): void { fs.writeFileSync(k, "z"); } }`,
    });
  })();
  const bc = chainScan(broadClaim).report?.functions
    .find((e) => e.hash === "broadkit#Store.save" && e.interfaceUnion);
  check("a BROAD dispatch still discloses Unknown under a hash a real entry claims",
        bc?.inferred.join() === "Unknown" && bc?.unresolved === true
          && bc?.unknownWhy?.join() === "dispatch:broadkit.Store.save",
        JSON.stringify(chainScan(broadClaim).report?.functions.map((e) => [e.fn, e.hash, e.inferred])));

  // ── AN INTERFACE METHOD HAS TWO SPELLINGS ───────────────────────────────────────────────────────
  // `run(x): void` is a MethodSignature; `run: (x) => void` is a PropertySignature over a
  // FunctionTypeNode. The same contract, and only the first was ever looked at — by the union emitter
  // OR by the in-scan dispatch site, so both arms fell through to Unknown. Real: @cucumber/cucumber's
  // `IDefinition.getInvocationParameters`, and the whole of @ukri-tfs/email's `SendStrategy`, which
  // declares four implementers and not one method signature.
  const PROP_DTS = `export interface IDefinition { getInvocationParameters: (o: string) => string[]; }
export declare class Definition implements IDefinition { getInvocationParameters: (o: string) => string[]; }`;
  const propkit = project({
    "package.json": `{"name":"propkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class Definition { getInvocationParameters(o) { return [fs.readFileSync(o, "utf8")]; } }
exports.Definition = Definition;`,
    "dist/index.d.ts": PROP_DTS,
  });
  const pk = chainScan(propkit, "--allow-js");
  check("an interface member spelled as a FUNCTION-TYPED PROPERTY is unioned like a method",
        pk.report?.functions.find((e) => e.hash === "propkit#IDefinition.getInvocationParameters")
          ?.inferred.includes("Fs"),
        JSON.stringify(pk.report?.functions.map((e) => [e.hash, e.inferred])));

  const propapp = project({
    "package.json": `{"name":"propapp","dependencies":{"propkit":"1.0.0"}}`,
    "node_modules/propkit/package.json": `{"name":"propkit","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "node_modules/propkit/dist/index.js": ``,
    "node_modules/propkit/dist/index.d.ts": PROP_DTS,
    "src/use.ts": `import { IDefinition } from "propkit";
export function go(d: IDefinition): string[] { return d.getInvocationParameters("x"); }`,
    "fs.pol": `deny Fs\n`,
  });
  fs.rmSync(path.join(propapp, ".candor", "report.json"), { force: true });
  const pr = spawnSync("node", [path.join(HERE, "scan.mjs"), propapp, "--policy", path.join(propapp, "fs.pol")],
                       { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: path.join(propkit, ".candor", "report.json") } });
  const prep = JSON.parse(fs.readFileSync(path.join(propapp, ".candor", "report.json"), "utf8"));
  check("the chained consumer resolves the property-spelled dispatch (was Unknown)",
        entry(prep, "src.use.go")?.inferred.join() === "Fs", JSON.stringify(entry(prep, "src.use.go")));
  check("…and the two-tree `deny Fs` gate fires (exit 0 -> 1)", pr.status === 1, `exit=${pr.status}`);
  // the single-tree control, in BOTH class spellings: the implementer can declare the member as a method
  // or as an arrow-valued property, and the dispatch must resolve either way.
  for (const [what, impl] of [["arrow property", `getInvocationParameters = (o: string): string[] => [fs.readFileSync(o, "utf8")];`],
                              ["method", `getInvocationParameters(o: string): string[] { return [fs.readFileSync(o, "utf8")]; }`]]) {
    const ctl = project({
      "package.json": `{"name":"propctl"}`,
      "src/dep.ts": `import * as fs from "node:fs";
export interface IDefinition { getInvocationParameters: (o: string) => string[]; }
export class Definition implements IDefinition { ${impl} }`,
      "src/use.ts": `import { IDefinition } from "./dep.js";
export function go(d: IDefinition): string[] { return d.getInvocationParameters("x"); }`,
    });
    check(`single-tree control (${what} implementer): the same dispatch resolves to Fs, not Unknown`,
          entry(scan(ctl).report, "src.use.go")?.inferred.join() === "Fs",
          JSON.stringify(entry(scan(ctl).report, "src.use.go")));
  }
  // THE SECOND FIXTURE: precise or nothing. A property that is NOT function-typed must not be joined by
  // name — charging a plain data property whose name happens to match a unit is the fabrication mirror
  // of the miss above, and a union-typed `(() => void) | undefined` is not a function type either.
  const notfn = project({
    "package.json": `{"name":"notfn","main":"dist/index.js","types":"dist/index.d.ts"}`,
    "dist/index.js": `"use strict";
const fs = require("node:fs");
class Definition { load(o) { return fs.readFileSync(o, "utf8"); } }
exports.Definition = Definition;`,
    "dist/index.d.ts": `export interface IDefinition { load: string; maybe?: (() => void) | undefined; }
export declare class Definition implements IDefinition { load: string; }`,
  });
  check("a NON-function-typed property of the same name is never joined (precise or nothing)",
        !chainScan(notfn, "--allow-js").report?.functions.some((e) => e.hash.startsWith("notfn#IDefinition.")),
        JSON.stringify(chainScan(notfn, "--allow-js").report?.functions.map((e) => [e.hash, e.inferred])));
}

// ── PER-FILE module unit keys: importing a package charges its ENTRY, not every file it ships ─────
// All of a package's module units used to hash `<pkg>#<module>`, and duplicate hashes union on load, so
// `import "pkg"` charged the union of EVERY published file's top level — `proper-lockfile` picked up `Net`
// from `retry`'s `example/dns.js`. Per-file keys let the consumer ask for the module the specifier names.
if (blk()) {
  const depSrc = {
    "package.json": `{"name":"depkit3","main":"index.js"}`,
    "index.js": `"use strict";
const inner = require("./lib/inner.js");
module.exports = { inner };`,
    // the entry does not perform this itself — it is reached only THROUGH the entry's require.
    "lib/inner.js": `"use strict";
const fs = require("node:fs");
const CFG = fs.readFileSync("/etc/inner.conf", "utf8");
module.exports = { CFG };`,
    // published, but nothing imports it: the false charge.
    "example/dns.js": `"use strict";
const net = require("node:net");
net.connect(53, "8.8.8.8");`,
  };
  const dep = project(depSrc);
  const ds = scan(dep, "--allow-js");
  const mods = ds.report.functions.filter((e) => e.hash.endsWith(".<module>"));
  check("each file's initializer gets its OWN cross-package key (not one shared `<pkg>#<module>`)",
        mods.length === 3 && new Set(mods.map((e) => e.hash)).size === 3
          && mods.some((e) => e.hash === "depkit3#index.<module>"),
        JSON.stringify(mods.map((e) => e.hash)));

  const consumer = (specifier, extra = {}) => {
    const app = project({
      "package.json": `{"name":"shopapp3","dependencies":{"depkit3":"1.0.0"}}`,
      "src/use.ts": `import ${JSON.stringify(specifier)};\nexport function go(): number { return 1; }`,
      "net.pol": `deny Net\n`,
      "fs.pol": `deny Fs\n`,
      ...extra,
    });
    for (const [rel, content] of Object.entries(depSrc)) {
      const p = path.join(app, "node_modules", "depkit3", rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return app;
  };
  const runChained = (app, depReport, ...extra) => {
    fs.rmSync(path.join(app, ".candor", "report.json"), { force: true }); // standing bar item 8
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), app, ...extra],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: depReport } });
    const p = path.join(app, ".candor", "report.json");
    return { r, report: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null };
  };
  const depReport = `${ds.prefix}.json`;

  // THE SECOND FIXTURE, WRITTEN FIRST (standing bar item 0). This narrows what an import charges, so the
  // failure mode to look for is the MISS: the entry's transitively-required module genuinely DOES run on
  // import, and its top-level effect must survive. It survives without a reachability analysis because the
  // entry unit's own `inferred` already carries the closure — the in-scan module-import edge computed it.
  const a1 = consumer("depkit3");
  const c1 = runChained(a1, depReport);
  check("an import still charges the entry's TRANSITIVELY-required module's top-level effect",
        entry(c1.report, "src.use.<module>")?.inferred.includes("Fs"),
        JSON.stringify(c1.report?.functions));
  check("…and the gate on that real reach still fires (deny Fs, exit 1)",
        runChained(a1, depReport, "--policy", path.join(a1, "fs.pol")).r.status === 1);
  // and the fabrication is gone: nothing imports `example/dns.js`, so its Net is no longer charged.
  check("an import no longer charges an UNIMPORTED file's top level",
        !entry(c1.report, "src.use.<module>")?.inferred.includes("Net"),
        JSON.stringify(c1.report?.functions));
  check("…so the gate stops firing on the effect that file alone contributed (deny Net, exit 0)",
        runChained(a1, depReport, "--policy", path.join(a1, "net.pol")).r.status === 0);

  // a SUBPATH import names its own module, and must still charge it — narrowing to the package entry
  // regardless of the specifier would be the same miss one level along.
  const a2 = consumer("depkit3/example/dns.js");
  const c2 = runChained(a2, depReport);
  check("a SUBPATH import charges the module that specifier names",
        entry(c2.report, "src.use.<module>")?.inferred.includes("Net"),
        JSON.stringify(c2.report?.functions));

  // COMPATIBILITY. A report written before per-file keys hashes every module unit `<pkg>#<module>`. A new
  // consumer must not silently resolve nothing over it — that would turn a precision fix into the
  // under-report this vein exists to close — so the old key is honoured when present, with its old (union)
  // answer. No current engine emits a bare `<module>` tail, so its presence is a reliable discriminator.
  const legacy = JSON.parse(fs.readFileSync(depReport, "utf8"));
  for (const e of legacy.functions) if (e.hash.endsWith(".<module>")) e.hash = "depkit3#<module>";
  const legacyPath = path.join(dep, ".candor", "legacy.json");
  fs.writeFileSync(legacyPath, JSON.stringify(legacy));
  const a3 = consumer("depkit3");
  const c3 = runChained(a3, legacyPath);
  check("a report using the OLD shared `<pkg>#<module>` key still resolves (never silently nothing)",
        entry(c3.report, "src.use.<module>")?.inferred.includes("Fs"),
        JSON.stringify(c3.report?.functions));

  // and when the package is NOT on disk there is nothing to resolve an entry against, so the answer stays
  // the union — an over-approximation, never a fresh silence.
  const a4 = project({
    "package.json": `{"name":"shopapp4","dependencies":{"depkit3":"1.0.0"}}`,
    "src/use.ts": `import "depkit3";\nexport function go(): number { return 1; }`,
  });
  const c4 = runChained(a4, depReport);
  check("an uninstallable package falls back to the union rather than resolving nothing",
        entry(c4.report, "src.use.<module>")?.inferred.includes("Fs"),
        JSON.stringify(c4.report?.functions));

  // ORDERING. The compatibility branch used to run FIRST and win unconditionally, so a report carrying
  // both key shapes was answered by the legacy UNION — the over-approximation this change exists to
  // remove — even though the precise per-file answer sat right beside it. Precise first, legacy as the
  // fallback: the same answer for a report with one shape, the right one for a report with both.
  const both = JSON.parse(fs.readFileSync(depReport, "utf8"));
  both.functions.push({ ...both.functions.find((e) => e.hash === "depkit3#example.dns.<module>"),
                        hash: "depkit3#<module>" });
  const bothPath = path.join(dep, ".candor", "both.json");
  fs.writeFileSync(bothPath, JSON.stringify(both));
  const c5 = runChained(consumer("depkit3"), bothPath);
  check("a report carrying BOTH key shapes is answered by the PRECISE one, not the legacy union",
        entry(c5.report, "src.use.<module>")?.inferred.includes("Fs")
          && !entry(c5.report, "src.use.<module>")?.inferred.includes("Net"),
        JSON.stringify(c5.report?.functions));
}

// ── ⟨0.19⟩ THE REASON CLASS TRAVELS ACROSS THE DEP JOIN ───────────────────────────────────────────
// The join copied `inferred` and `invisible` only, so a dependency's `Unknown[reflect:eval]` arrived as a
// bare Unknown and fell back to the generic `unresolved` — and `deny Net Unknown[reflect]`, a rule written
// to bite exactly that hole, stopped biting one package boundary away. The ts sibling of candor-java
// `6ab26e4`, whose root cause was the same DUPLICATION: two copies of the apply path, drifted, and the
// reason class added to neither.
if (blk()) {
  const dep = project({
    "package.json": `{"name":"reflkit","main":"index.js","types":"index.d.ts"}`,
    "src/index.ts": `export function run(name: string): void { (0, eval)(name); }`,
  });
  const ds = scan(dep);
  check("the dependency discloses its own reason class",
        entry(ds.report, "src.index.run")?.unknownWhy?.join() === "reflect:eval",
        JSON.stringify(ds.report?.functions));
  const app = (pol) => {
    const a = project({
      "package.json": `{"name":"reflapp","dependencies":{"reflkit":"1.0.0"}}`,
      "node_modules/reflkit/package.json": `{"name":"reflkit","main":"index.js","types":"index.d.ts"}`,
      "node_modules/reflkit/index.js": ``,
      "node_modules/reflkit/index.d.ts": `export declare function run(name: string): void;`,
      "src/use.ts": `import { run } from "reflkit";
export function go(): void { run("x"); }`,
      "p.pol": pol,
    });
    fs.rmSync(path.join(a, ".candor", "report.json"), { force: true });   // standing bar item 7
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), a, "--policy", path.join(a, "p.pol")],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: `${ds.prefix}.json` } });
    return { r, rep: JSON.parse(fs.readFileSync(path.join(a, ".candor", "report.json"), "utf8")) };
  };
  const refl = app("deny Net Unknown[reflect]\n");
  check("…and the consumer inherits it, instead of falling back to the generic `unresolved`",
        entry(refl.rep, "src.use.go")?.unknownWhy?.join() === "reflect:eval",
        JSON.stringify(entry(refl.rep, "src.use.go")));
  check("…so `deny Net Unknown[reflect]` bites one package boundary along (exit 0 -> 1)",
        refl.r.status === 1, `exit=${refl.r.status}`);
  // THE SECOND FIXTURE. Carrying the reason must not make the scope WIDER: a rule naming a DIFFERENT class
  // has to keep passing, or "the class travels" has quietly become "every narrowed rule now matches".
  check("…while a rule naming a different class still passes — the scoping still discriminates",
        app("deny Net Unknown[native]\n").r.status === 0);
  // And a report from another build keeps the BARE Unknown: its reasons are assertions from an engine we
  // have just decided not to trust, and `unresolved` is the honest class for "we cannot say why".
  const staleDep = JSON.parse(fs.readFileSync(`${ds.prefix}.json`, "utf8"));
  staleDep.candor.version += "-other";
  const stalePath = path.join(dep, ".candor", "other.json");
  fs.writeFileSync(stalePath, JSON.stringify(staleDep));
  const a2 = project({
    "package.json": `{"name":"reflapp2","dependencies":{"reflkit":"1.0.0"}}`,
    "node_modules/reflkit/package.json": `{"name":"reflkit","main":"index.js","types":"index.d.ts"}`,
    "node_modules/reflkit/index.js": ``,
    "node_modules/reflkit/index.d.ts": `export declare function run(name: string): void;`,
    "src/use.ts": `import { run } from "reflkit";
export function go(): void { run("x"); }`,
  });
  fs.rmSync(path.join(a2, ".candor", "report.json"), { force: true });
  spawnSync("node", [path.join(HERE, "scan.mjs"), a2], { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: stalePath } });
  const staleRep = JSON.parse(fs.readFileSync(path.join(a2, ".candor", "report.json"), "utf8"));
  check("an UNTRUSTED report's reason class is not repeated — the Unknown stays bare",
        !(entry(staleRep, "src.use.go")?.unknownWhy ?? []).includes("reflect:eval"),
        JSON.stringify(entry(staleRep, "src.use.go")));
}

// ── §2.1 STALENESS: an UNTRUSTED report's SILENCE is not a purity claim ───────────────────────────
// §2.1 downgrades a chained report from another engine build to `Unknown`. It did that to the entries the
// report CARRIES — while registering the package as covered anyway, so every key the report did NOT contain
// went on reading PURE, on the authority of a report the engine had just decided not to trust. A silent
// under-report, and it is the class a wire-key change falls into: when the module unit key moved from
// `<pkg>#<module>` to `<pkg>#<relpath>.<module>`, an already-installed consumer's lookup simply missed, and
// no version string could have rescued it — staleness rewrites the CONTENT of the keys a report carries and
// can never conjure one it lacks. Measured with that build as the consumer over a report from this one: the
// importer was ABSENT from `functions` (a ⟨0.21⟩ purity claim) with `deny Fs` at exit 0, where the
// single-tree control is exit 1 in both arms. So an untrusted report grants NO coverage, and an import
// backed only by one discloses `Unknown`.
if (blk()) {
  const dep = project({
    "package.json": `{"name":"stalekit","main":"index.js","types":"index.d.ts"}`,
    "index.js": `"use strict";
const fs = require("node:fs");
fs.writeFileSync("/tmp/stalekit-boot", "1");
function helper() { fs.readFileSync("/tmp/stalekit-x"); }
module.exports = { helper };`,
    "index.d.ts": `export declare function helper(): void;`,
  });
  const ds = scan(dep, "--allow-js");
  const freshPath = `${ds.prefix}.json`;
  const fresh = JSON.parse(fs.readFileSync(freshPath, "utf8"));
  const write = (name, r) => {
    const p = path.join(dep, ".candor", name);
    fs.writeFileSync(p, JSON.stringify(r));
    return p;
  };
  // The SAME report, one field different — the build id. Nothing else changes, so every difference in the
  // consumer's output is attributable to §2.1 and to nothing else.
  const otherBuild = { ...fresh, candor: { ...fresh.candor, version: `${fresh.candor.version}-other` } };
  const otherPath = write("otherbuild.json", otherBuild);
  // …and the pair carrying no answer for `helper` at all, which is where "silence" is the whole question:
  // from a TRUSTED report that absence is the dependency's purity claim (SPEC §2 rule 3); from an untrusted
  // one it is not an answer at all.
  const drop = (r, suffix) => ({ ...r, functions: r.functions.filter((e) => !e.hash.endsWith(suffix)) });
  const quietFreshPath = write("quiet-fresh.json", drop(fresh, "#helper"));
  const quietOtherPath = write("quiet-other.json", drop(otherBuild, "#helper"));
  const noModOtherPath = write("nomod-other.json", drop(otherBuild, ".<module>"));

  const app = () => project({
    "package.json": `{"name":"staleapp","dependencies":{"stalekit":"1.0.0"}}`,
    "node_modules/stalekit/package.json": `{"name":"stalekit","main":"index.js","types":"index.d.ts"}`,
    "node_modules/stalekit/index.js": `"use strict";\nmodule.exports = { helper() {} };`,
    "node_modules/stalekit/index.d.ts": `export declare function helper(): void;`,
    "src/use.ts": `import { helper } from "stalekit";
export function go(): void { helper(); }`,
    "unknown.pol": `deny Unknown\n`,
  });
  const run = (a, deps, ...extra) => {
    fs.rmSync(path.join(a, ".candor", "report.json"), { force: true });   // standing bar item 7
    const r = spawnSync("node", [path.join(HERE, "scan.mjs"), a, ...extra],
                        { encoding: "utf8", env: { ...process.env, CANDOR_DEPS: deps } });
    const p = path.join(a, ".candor", "report.json");
    return { r, report: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null };
  };

  // THE SECOND FIXTURE, WRITTEN FIRST (standing bar item 0). This makes a report count for LESS, so the
  // failure mode to look for is false uncertainty: a report from THIS build must keep resolving precisely,
  // and its silence must keep meaning pure. Both halves, before either half of the stale arm is believed.
  const f = run(app(), freshPath);
  check("a chained report from THIS build still resolves precisely (no fresh uncertainty)",
        entry(f.report, "src.use.go")?.inferred.join() === "Fs"
          && entry(f.report, "src.use.<module>")?.inferred.join() === "Fs",
        JSON.stringify(f.report?.functions));
  check("…and a TRUSTED report's silence still reads as the dependency's purity claim (§2 rule 3)",
        !entry(run(app(), quietFreshPath).report, "src.use.go"),
        JSON.stringify(run(app(), quietFreshPath).report?.functions));

  // The stale arm. The entries it carries downgrade (that half always worked); the entries it does NOT
  // carry stop reading pure — the κ ledger's `invisible` hedge comes back, because the package is no
  // longer covered by a report we trust.
  const o = run(app(), otherPath);
  check("a report from ANOTHER build downgrades the keys it carries to Unknown (§2.1, unchanged)",
        entry(o.report, "src.use.go")?.inferred.join() === "Unknown",
        JSON.stringify(o.report?.functions));
  check("an UNTRUSTED report's silence is no longer a purity claim — the ledger hedges instead",
        entry(run(app(), quietOtherPath).report, "src.use.go")?.invisible?.includes("stalekit"),
        JSON.stringify(run(app(), quietOtherPath).report?.functions));

  // The import edge is the site the wire-key change actually broke, and it has no κ ledger under it —
  // a module key that is simply absent charges nothing at all. Disclose instead: `Unknown`, with its reason.
  check("an import backed only by an untrusted report discloses Unknown, never nothing",
        entry(o.report, "src.use.<module>")?.inferred.join() === "Unknown"
          && entry(o.report, "src.use.<module>")?.unknownWhy?.includes("stale-dep:stalekit"),
        JSON.stringify(entry(o.report, "src.use.<module>")));
  check("…and it holds when the untrusted report carries no module entry to downgrade at all",
        entry(run(app(), noModOtherPath).report, "src.use.<module>")?.unknownWhy?.includes("stale-dep:stalekit"),
        JSON.stringify(run(app(), noModOtherPath).report?.functions));
  const pol = (a) => ["--policy", path.join(a, "unknown.pol")];
  const aStale = app(), aFresh = app();
  check("…so `deny Unknown` catches the untrusted chain (exit 1) where the trusted one passes (exit 0)",
        run(aStale, otherPath, ...pol(aStale)).r.status === 1
          && run(aFresh, freshPath, ...pol(aFresh)).r.status === 0);
}

// ── the SEEDED-VIOLATION SENSITIVITY BATTERY as a gate (RQ1 Part C) ───────────────────────────────
// The honesty oracle is only worth its verdict if it is SENSITIVE. sensitivity.mjs plants a real Fs effect
// behind each of N dynamic mechanisms (eval, Function ctor, computed require, callback-in-collection, async
// continuation, computed-key dispatch, deserialization hook, property getter) and measures BOTH sides: candor
// disclosed (Fs/Unknown), and — with candor's disclosure stripped — the oracle still caught it. No mechanism
// may ESCAPE (run yet be caught by neither), and every mechanism that runs must be oracle-caught (full recall).
if (blk()) {
  const r = spawnSync("node", [path.join(HERE, "sensitivity.mjs"), "--json"], { encoding: "utf8" });
  let s = null; try { s = JSON.parse(r.stdout).summary; } catch { /* below */ }
  check("sensitivity: no dynamic mechanism ESCAPES the honesty invariant (exit 0)",
    r.status === 0 && s && s.escaped === 0, `exit=${r.status} out=${(r.stdout || "").slice(0, 200)} err=${(r.stderr || "").slice(0, 200)}`);
  check("sensitivity: candor discloses Fs/Unknown for every dynamic mechanism (full disclosure)",
    s && s.candorDisclosureRate === `${s.total}/${s.total}`, JSON.stringify(s));
  check("sensitivity: the oracle catches every executed effect with disclosure stripped (full recall)",
    s && (() => { const [a, b] = s.oracleRecall.split("/"); return Number(a) === Number(b); })(),
    `oracleRecall=${s?.oracleRecall} inconclusive=${s?.inconclusive}`);
}

// ── ⟨0.24⟩ SPEC §3.1 `gate --report <locator> --policy <file>` ────────────────────────────────────
// Apply a policy to an EXISTING report, with no scan. Everything below drives the SHIPPED CLI and reads
// its exit code / its `--gate-json` bytes — never the in-process functions — because the whole point of
// the verb is that the gate is reachable as a function of a GIVEN signature, and an in-process capture
// would re-open exactly the "a defect in the gate and a defect in the classifier are indistinguishable"
// hole the clause exists to close.
const gateCli = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), "gate", ...a], { encoding: "utf8" });
// A hand-written report at `<dir>/r.json` (+ optional sidecar) — the shape conformance PART 27 writes.
function handReport(files) {
  const d = scratch("candor-ts-gate-");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 1));
  }
  return d;
}

// ⟨0.24⟩ THE REFUSAL DOCUMENT (SPEC §3.1 `107755b`, carve-outs removed by `1503368`). Four rows below used
// to assert a refusal wrote NOTHING, on the reasoning that an absent document keeps a wrapper from
// mistaking a refusal for a judgement. That had it backwards, and the whole rung turns on why: writing
// nothing does not leave the wrapper with NO document, it leaves it with LAST RUN'S — a green file from
// yesterday's clean run, still on disk, read as today's all-clear. What stops a refusal being read as a
// judgement is `refused: true` and the MISSING `violations` key, not its absence from the disk. Every one
// of those rows keeps its real protection — no GREEN verdict may be emitted — and gains the stronger claim.
const isRefusal = (text) => {
  let d;
  try { d = JSON.parse(text); } catch { return false; }
  return d && d.ok === false && d.refused === true && !("violations" in d);
};

// ── (a) EQUIVALENCE IS THE ACCEPTANCE TEST, AND IT IS BYTE-LEVEL ──────────────────────────────────
// For any report a scan produced, `gate --report <it> --policy P` must produce a `--gate-json` document
// BYTE-EQUAL to `scan --policy P`'s — `analyzed.count`, `reasonClass`, `netClass` and the coverage
// advisory included — and the SAME exit code. Anything less lets the two routes drift into two gates.
// (This matrix is the standing gate; the landing measurement ran 73 rows over three corpora, including
// a 1717-function slice of eslint's rules, all byte-equal.)
if (blk()) {
  const d = project({
    ".candor/config": "net-partner api.partner.example\n",
    "package.json": `{ "name": "gatefix", "dependencies": { "left-pad": "^1.0.0" } }`,
    "src/app.ts": `import * as fsm from "node:fs";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import leftPad from "left-pad";
export function readIt() { return fsm.readFileSync("/etc/hosts"); }
export async function fetchPartner() { return fetch("https://api.partner.example/x"); }
export async function fetchTelemetry() { return fetch("https://sentry.io/api"); }
export async function fetchRuntime(u: string) { return fetch(u); }
export function runIt() { return execSync("git status"); }
export function save(db: DatabaseSync) { db.exec("INSERT INTO orders (id) VALUES (1)"); }
export function envIt() { return process.env.HOME; }
export function padIt(s: string) { return leftPad(s, 10); }
export function dyn(o: any, k: string) { return o[k](); }
export function refl(s: string) { return eval(s); }
export function all(db: DatabaseSync, o: any) {
  readIt(); fetchPartner(); fetchTelemetry(); fetchRuntime("x"); runIt(); save(db);
  envIt(); padIt("a"); dyn(o, "k"); refl("1");
}`,
  });
  const POLICIES = [
    ["pure", "pure\n"], ["deny_fs", "deny Fs\n"], ["deny_net", "deny Net\n"], ["deny_db", "deny Db\n"],
    ["deny_exec", "deny Exec\n"], ["deny_env", "deny Env\n"], ["deny_unknown", "deny Unknown\n"],
    ["deny_clipboard", "deny Clipboard\n"], ["deny_net_unknown", "deny Net Unknown\n"],
    ["u_dispatch", "deny Unknown[dispatch,unresolved]\n"], ["u_reflect", "deny Unknown[reflect,unresolved]\n"],
    ["u_setup", "deny Unknown[setup]\n"], ["u_dynamic", "deny Unknown[dynamic]\n"],
    ["n_unknownhost", "deny Net[unknown-host]\n"], ["n_partner", "deny Net[known-partner]\n"],
    ["n_telemetry", "deny Net[known-telemetry]\n"],
    ["scoped", "deny Fs src.app.readIt\n"], ["scoped_none", "pure ZzzNoSuchScope\n"],
    ["multi", "deny Net\ndeny Fs\ndeny Unknown[dynamic,unresolved]\n"], ["comment_only", "# nothing\n"],
  ];
  const out = path.join(d, "verdicts");
  fs.mkdirSync(out, { recursive: true });
  const diffs = [];
  let fired = 0, firedDoc = 0, refusedOnSelfProduced = 0, sawNetClass = false, sawReasonClass = false;
  for (const [name, text] of POLICIES) {
    const pol = path.join(d, `${name}.pol`);
    fs.writeFileSync(pol, text);
    const a = path.join(out, `${name}.scan.json`), b = path.join(out, `${name}.gate.json`);
    for (const f of [a, b]) if (fs.existsSync(f)) fs.rmSync(f);   // DELETE the output before measuring
    const s = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", pol, "--gate-json", a], { encoding: "utf8" });
    const g = gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", pol, "--gate-json", b);
    if (!fs.existsSync(a) || !fs.existsSync(b)) { diffs.push(`${name}: a --gate-json document was not written (scan ${s.status}, gate ${g.status})`); continue; }
    const av = fs.readFileSync(a), bv = fs.readFileSync(b);
    if (!av.equals(bv)) diffs.push(`${name}: NOT byte-equal\n  scan ${av.toString().slice(0, 400)}\n  gate ${bv.toString().slice(0, 400)}`);
    if (s.status !== g.status) diffs.push(`${name}: exit ${s.status} (scan) vs ${g.status} (gate)`);
    if (s.status === 1) fired++;
    // ⟨0.24⟩ PER-ROUTE CONTENT, and this is what a byte-equality matrix cannot see by construction.
    // AUDITED by building the adversary rather than reasoning about it: a mutant serializer that keeps
    // every exit code and writes `violations: []` unconditionally on BOTH routes. ALL 22 comparison rows
    // passed it — the two routes stayed byte-equal BECAUSE THEY WERE MAKING THE SAME MISTAKE, and every
    // finding vanished from the only channel a machine consumer reads while the exit code still said
    // "fail". So each row now asserts, PER ROUTE, that exit 1 ⟺ the document carries at least one
    // violation RECORD, and flags the mirror (an exit-0 document that carries violations) with it.
    for (const [route, buf, st] of [["scan", av, s.status], ["gate", bv, g.status]]) {
      let doc = null;
      try { doc = JSON.parse(buf.toString()); } catch { diffs.push(`${name}/${route}: the verdict did not parse`); continue; }
      // ⟨0.28⟩ A REFUSAL ROW IS NOT A VERDICT ROW, and the assertions below are about verdicts. `comment_only`
      // is a configured policy that yields ZERO RULES, which SPEC §6.2 ⟨0.28⟩ makes a REFUSAL on both routes
      // — so `violations` is deliberately ABSENT and exit is 2. Held to the STRICTER contract instead of
      // exempted: exit 2, `ok:false`, `refused:true`, and NO `violations` key (an empty array is exactly the
      // claim a refusal cannot make). The byte-equality comparison above still binds the two routes.
      if (doc.refused === true) {
        if (st !== 2) diffs.push(`${name}/${route}: a refusal document but exit ${st}, not 2`);
        if (doc.ok !== false) diffs.push(`${name}/${route}: a refusal document whose \`ok\` is not false — a naive consumer reads it as a pass`);
        if ("violations" in doc) diffs.push(`${name}/${route}: a refusal document carrying a \`violations\` key — the gate is making no claim about violations, so the key must be ABSENT, not empty`);
        continue;
      }
      const n = Array.isArray(doc.violations) ? doc.violations.length : -1;
      if (n < 0) { diffs.push(`${name}/${route}: a VERDICT document with no \`violations\` array`); continue; }
      if (st === 1 && n === 0)
        diffs.push(`${name}/${route}: exit 1 but the document carries NO violation record — the finding was computed, set the exit code, and was then deleted from the machine-consumer channel`);
      if (st === 0 && n > 0)
        diffs.push(`${name}/${route}: exit 0 but the document carries ${n} violation record(s) — the mirror defect`);
      if (st === 1 && n > 0) firedDoc++;
    }
    // "Refusing costs nothing on a self-produced report" (SPEC §3.1) — netClass is emitted for every
    // Net-bearing entry and floored at unknown-host, and an in-scope Unknown always resolves. A refusal
    // here would mean the producer dropped a channel its own consumer needs.
    if (g.status === 2 && s.status !== 2) { refusedOnSelfProduced++; diffs.push(`${name}: gate REFUSED a self-produced report — ${g.stderr.slice(0, 300)}`); }
    if (av.includes("netClass")) sawNetClass = true;
    if (av.includes("reasonClass")) sawReasonClass = true;
  }
  check(`gate --report: --gate-json is BYTE-EQUAL to scan --policy's over ${POLICIES.length} policies, same exit`,
        diffs.length === 0, diffs.join("\n"));
  // The row is VACUOUS unless a policy actually fired — byte-equal empty verdicts prove little.
  // ⟨0.24⟩ `fired` COUNTED THE SCAN'S EXIT CODE, which is the same hole as above one level up: a route
  // that computed the violations, exited 1 and then wrote an empty list satisfied the guard AND the byte
  // comparison. Under the mutant it read `fired=16` — comfortably past its own threshold — while not one
  // document carried a record. The guard now counts rows whose VERDICT carries a violation record.
  check("gate --report: the equivalence matrix is NON-VACUOUS (policies that violate WITH RECORDS IN THE DOCUMENT, and the ⟨0.19⟩/⟨0.20⟩ class fields ride the verdict)",
        firedDoc >= 10 && sawNetClass && sawReasonClass,
        `firedDoc=${firedDoc} (route-rows whose document carries a record) fired=${fired} (exit-1 rows) netClass=${sawNetClass} reasonClass=${sawReasonClass}`);
  check("gate --report: no answerability refusal fires on a report this engine produced",
        refusedOnSelfProduced === 0);

  // ⟨0.21⟩ the completeness manifest travels ON the report, so the SAME exit-2 follows from it. A real
  // violation dominates, exactly as it does on the scan path.
  fs.writeFileSync(path.join(d, "src", "bad.ts"), "export function broken( { { {\n");
  const inc = [];
  for (const [name, text] of [["i_net", "deny Net\n"], ["i_clipboard", "deny Clipboard\n"]]) {
    const pol = path.join(d, `${name}.pol`);
    fs.writeFileSync(pol, text);
    const a = path.join(out, `${name}.scan.json`), b = path.join(out, `${name}.gate.json`);
    for (const f of [a, b]) if (fs.existsSync(f)) fs.rmSync(f);
    const s = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", pol, "--gate-json", a], { encoding: "utf8" });
    const g = gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", pol, "--gate-json", b);
    if (!fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b)) || s.status !== g.status)
      inc.push(`${name}: scan ${s.status} / gate ${g.status}`);
    if (name === "i_clipboard" && g.status !== 2) inc.push("i_clipboard: an unanalyzed unit must make the gate exit 2, not certify");
    // ⟨0.24⟩ the same per-route content rule. `i_net` fires AND is incomplete — a real violation dominates
    // (§3.3), so exit 1 here must still be backed by a record, and the mutant proved these two rows could
    // not see its absence either.
    if (name === "i_net") for (const [route, f, st] of [["scan", a, s.status], ["gate", b, g.status]]) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(f, "utf8")); } catch { inc.push(`${name}/${route}: unparseable verdict`); continue; }
      if (st === 1 && !(doc.violations ?? []).length)
        inc.push(`${name}/${route}: exit 1 with an EMPTY violation list — the finding never reached the consumer`);
    }
  }
  check("gate --report: the ⟨0.21⟩ `unanalyzed` manifest carries the same exit-2 verdict, byte-equal", inc.length === 0, inc.join("; "));

  // ⟨0.24⟩ A NEW ARM, for a state nothing above can reach: a POLICY the engine cannot honour as written.
  // Every row above uses a well-formed policy, so the matrix had no opinion on what the two routes do
  // when the policy itself is the problem — and "both routes refuse identically" is itself a byte-equality
  // claim. It is asserted as a PAIR with `parsepolicy` (SPEC §3.1 `6929dce`): the two ENFORCERS must
  // refuse and write byte-equal refusal documents, while the WITNESS must answer at exit 0. Putting the
  // error in the parser is what took the four-way conformance suite offline at PART 4, and the arm that
  // would have caught that is this one.
  const perr = [];
  for (const [label, text] of [["typo_beside", "deny Unknown[dispatch,nativ]\n"],
                               ["typo_sole", "deny Net[unkown-host]\n"]]) {
    const pol = path.join(d, `${label}.pol`);
    fs.writeFileSync(pol, text);
    const a2 = path.join(out, `${label}.scan.json`), b2 = path.join(out, `${label}.gate.json`);
    for (const f of [a2, b2]) if (fs.existsSync(f)) fs.rmSync(f);
    const s2 = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", pol, "--gate-json", a2], { encoding: "utf8" });
    const g2 = gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", pol, "--gate-json", b2);
    if (s2.status !== 2 || g2.status !== 2) perr.push(`${label}: exit ${s2.status} (scan) / ${g2.status} (gate), both must be 2`);
    if (!fs.existsSync(a2) || !fs.existsSync(b2)) { perr.push(`${label}: a refusal document was not written on both routes`); continue; }
    if (!fs.readFileSync(a2).equals(fs.readFileSync(b2))) perr.push(`${label}: the two refusal documents are NOT byte-equal`);
    if (!isRefusal(fs.readFileSync(a2, "utf8"))) perr.push(`${label}: the document is not a ⟨0.24⟩ refusal (ok:false + refused:true + NO violations key)`);
    const pp = spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", pol], { encoding: "utf8" });
    if (pp.status !== 0) perr.push(`${label}: parsepolicy exit ${pp.status} — the WITNESS must not refuse`);
    else if (!(JSON.parse(pp.stdout).errors ?? []).length) perr.push(`${label}: parsepolicy reported no \`errors\``);
  }
  check("⟨0.24⟩ gate --report: an UNHONOURABLE POLICY refuses identically on both routes (byte-equal refusal documents) while `parsepolicy` still reports it at exit 0",
        perr.length === 0, perr.join("\n"));
}

// ── (b) THE MUST NOT: an ABSENT entry is absent, past THREE back-fill channels at once ─────────────
// SPEC §3.1 ⟨0.24⟩: "An engine MUST NOT re-derive, widen, or re-classify anything while serving this
// verb … a report entry that is ABSENT is absent — the ⟨0.21⟩ purity claim — and MUST NOT be back-filled
// from a callgraph sidecar or a chained dep." `app.Facade.load` is NOT in the report, and the effect it
// would have is supplied through every channel this engine has: the `.callgraph.json` sidecar names it
// and edges it to an Fs-bearing unit, a chained dep report gives it Fs outright, and a `.candor/config`
// `deps` key sits beside the report AND in the directory the verb does open a config from.
// MUTATION-VERIFIED 2026-07-28: with the reader patched to adopt a sidecar-named entry from the dep
// report, the ABSENT arm goes 0 -> 1. The NEGATIVE CONTROL below is what makes that meaningful — without
// it, an engine that ignored the policy entirely would pass this row.
if (blk()) {
  const dep = { candor: { version: "handwritten", spec: "0.24" }, package: "dep", analyzed: { count: 2, digest: "0" },
                functions: [{ fn: "app.Facade.load", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] },
                            { fn: "dep.readCfg", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] }] };
  const absent = { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 3, digest: "0" },
                   functions: [{ fn: "app.Wire.send", inferred: ["Net"], direct: ["Net"], hosts: ["ok.example.com"], netClass: ["unknown-host"] }] };
  const present = JSON.parse(JSON.stringify(absent));
  present.functions.push({ fn: "app.Facade.load", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] });
  const cg = { "app.Facade.load": ["dep.readCfg"], "dep.readCfg": [], "app.Wire.send": [] };
  const d = handReport({
    "rep/r.json": absent, "rep/r.callgraph.json": cg,
    "rep/r2.json": present, "rep/r2.callgraph.json": cg,
    "deps/dep.json": dep,
    "p.pol": "deny Fs app.Facade\n",
  });
  fs.mkdirSync(path.join(d, "rep", ".candor"), { recursive: true });
  fs.writeFileSync(path.join(d, "rep", ".candor", "config"), `deps ${path.join(d, "deps")}\n`);
  fs.mkdirSync(path.join(d, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(d, ".candor", "config"), `deps ${path.join(d, "deps")}\n`);
  const env = { ...process.env, CANDOR_DEPS: path.join(d, "deps") };
  const run = (rep) => spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", path.join(d, "rep", rep),
                                          "--policy", path.join(d, "p.pol")], { encoding: "utf8", cwd: path.join(d, "rep"), env });
  const ra = run("r.json"), rp = run("r2.json");
  check("gate --report: an ABSENT entry is NOT back-filled from a callgraph sidecar, a chained dep, or a config `deps` key (exit 0)",
        ra.status === 0, `exit=${ra.status} ${ra.stdout}${ra.stderr}`.slice(0, 400));
  check("gate --report: NEGATIVE CONTROL — the same policy + the same three baits, effect written INTO the report (exit 1)",
        rp.status === 1, `exit=${rp.status} ${rp.stdout}${rp.stderr}`.slice(0, 400));
}

// ── (c) ANSWERABILITY: a rule whose EVIDENCE THE WIRE DOES NOT CARRY is REFUSED, never evaluated ────
// All three were measured FAIL-OPEN if approximated instead, and the third is a live one: `deny
// Net[unknown-host]` over a Net-bearing entry with no `netClass` matched an empty set and returned exit
// 0 where the bare `deny Net` returns 1 — an absent optional field silently un-scoping a fail-closed
// security gate. The BARE rule rides along as the control that proves the fixture can fire at all.
if (blk()) {
  const d = handReport({
    "r.json": { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 4, digest: "0" },
      functions: [
        { fn: "app.egress", inferred: ["Net"], direct: ["Net"], hosts: ["example.com"] },              // Net, netClass ABSENT
        { fn: "app.classed", inferred: ["Net"], direct: ["Net"], hosts: ["example.com"], netClass: ["unknown-host"] },
        { fn: "app.inherited", inferred: ["Unknown"], direct: [] },                                    // inherited Unknown, no `calls`
        { fn: "app.reasonless", inferred: ["Unknown"], direct: ["Unknown"] },                          // DIRECT Unknown, no reason
      ] },
  });
  const rc = (text) => {
    fs.writeFileSync(path.join(d, "p.pol"), text);
    return gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol")).status;
  };
  check("gate --report: `forbid A -> B` is REFUSED whole-policy (exit 2) — a report's `calls` is effect-relevant, so a crossing into a wholly PURE unit is invisible",
        rc("forbid a -> b\n") === 2);
  check("gate --report: `allow <E> …` is REFUSED whole-policy (exit 2) — the AS-EFF-008 surface-completeness marker does not ride the wire",
        rc("allow Net in app example.com\n") === 2);
  check("gate --report: a class-scoped `deny Net[…]` over a Net entry with NO `netClass` is REFUSED (exit 2)",
        rc("deny Net[unknown-host] app.egress\n") === 2);
  check("gate --report: …and the BARE `deny Net` over the same entry FIRES (exit 1) — which is what makes the refusal a fail-open fix, not a formality",
        rc("deny Net app.egress\n") === 1);
  check("gate --report: a class-scoped `deny Unknown[…]` over an INHERITED Unknown with no `calls` edge is REFUSED (exit 2)",
        rc("deny Unknown[dispatch] app.inherited\n") === 2);
  check("gate --report: …and the bare `deny Unknown` over the same entry FIRES (exit 1)",
        rc("deny Unknown app.inherited\n") === 1);
  // THE REFUSAL IS MINIMAL (SPEC §3.1 ⟨0.24⟩), and per (rule, function): the class set only GROWS and
  // Reject is upward-closed in it, so a scoped rule whose own matches carry their evidence still
  // evaluates — including the arm where it does NOT fire, which is an ANSWER and not a refusal.
  check("gate --report: MINIMAL — a scoped `deny Net[unknown-host]` over an entry that DOES carry `netClass` FIRES (exit 1), even though another entry in the report lacks the field",
        rc("deny Net[unknown-host] app.classed\n") === 1);
  check("gate --report: MINIMAL — the same entry under `deny Net[known-partner]` is ANSWERED, not refused (exit 0)",
        rc("deny Net[known-partner] app.classed\n") === 0);
  // The ⟨0.24⟩ CONTRIBUTES case, which SPEC §3.1 records candor-swift as refusing OVER-BROADLY: a
  // function whose DIRECT `Unknown` names no reason contributes `unresolved` FROM THE ENTRY ALONE, with
  // no transitive step, so the rule fires and the answer is certain. This engine already contributes at
  // the entry (policy.mjs resolveReasonClasses), so it answers rather than declining.
  check("gate --report: MINIMAL — a reasonless DIRECT `Unknown` is answerable: `deny Unknown[unresolved]` FIRES (exit 1), not exit 2",
        rc("deny Unknown[unresolved] app.reasonless\n") === 1);
  check("gate --report: …and `deny Unknown[dispatch]` over that same entry is ANSWERED as a pass (exit 0)",
        rc("deny Unknown[dispatch] app.reasonless\n") === 0);
}

// ── (d) `netClass` is read VERBATIM — the MUST NOT's "no re-classifying", with teeth ───────────────
// The producer's `.candor/config` `net-partner` list is not on the wire. Re-deriving the destination
// class in the consumer would answer with THIS machine's evidence about the PRODUCER's project, in both
// directions: a `known-partner` host re-read as `unknown-host` (a FABRICATED `deny Net[unknown-host]`
// hit) and, symmetrically, a `deny Net[known-partner]` that stops firing. Both arms are asserted, and
// the second run adds a consumer-side config naming a DIFFERENT partner to prove the CWD cannot move it.
if (blk()) {
  const d = handReport({
    "r.json": { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 1, digest: "0" },
      functions: [{ fn: "app.call", inferred: ["Net"], direct: ["Net"], hosts: ["partner.example"], netClass: ["known-partner"] }] },
    "u.pol": "deny Net[unknown-host]\n",
    "k.pol": "deny Net[known-partner]\n",
  });
  const run = (pol) => spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", path.join(d, "r.json"),
                                          "--policy", path.join(d, pol)], { encoding: "utf8", cwd: d }).status;
  check("gate --report: `netClass` VERBATIM — `deny Net[unknown-host]` does NOT fire on a host the producer classified `known-partner` (exit 0; a re-derivation says 1)",
        run("u.pol") === 0);
  check("gate --report: `netClass` VERBATIM — `deny Net[known-partner]` DOES fire on it (exit 1; a re-derivation says 0)",
        run("k.pol") === 1);
  fs.mkdirSync(path.join(d, ".candor"), { recursive: true });
  fs.writeFileSync(path.join(d, ".candor", "config"), "net-partner other.example\n");
  check("gate --report: a CONSUMER-side `net-partner` config cannot move the verdict (the §3.1 MUST NOT: no re-mapping through this machine's config)",
        run("k.pol") === 1);
}

// ── (e) THE GRAMMAR (§3.3.1, inherited unchanged) and the `--json` ≡ `--gate-json -` ruling ─────────
if (blk()) {
  const d = handReport({
    "r.json": { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 1, digest: "0" },
      functions: [{ fn: "app.f", inferred: ["Net"], direct: ["Net"], hosts: ["x.example"], netClass: ["unknown-host"] }] },
    "ok.pol": "deny Fs\n",
  });
  const R = path.join(d, "r.json"), P = path.join(d, "ok.pol");
  check("gate --report: a stray POSITIONAL is a usage error (exit 2) — `gate` takes none, so it is never probed as a report or a policy",
        gateCli("--report", R, "--policy", P, "stray").status === 2);
  check("gate --report: an UNREADABLE policy exits 2, policy NOT evaluated (never a silent green)",
        gateCli("--report", R, "--policy", path.join(d, "nope.pol")).status === 2);
  check("gate --report: no policy at all is exit 2 — with no policy there is no verdict to give",
        gateCli("--report", R).status === 2);
  check("gate --report: a report locator that names nothing is exit 2",
        gateCli("--report", path.join(d, "missing.json"), "--policy", P).status === 2);
  check("gate --report: `--gate-json` with no value is exit 2",
        gateCli("--report", R, "--policy", P, "--gate-json").status === 2);
  check("gate --report: `--gate-json --policy p` cannot SWALLOW the policy and run gateless-green (exit 2)",
        gateCli("--report", R, "--policy", P, "--gate-json", "--policy", P).status === 2);
  check("gate --report: a typo'd flag is exit 2, never swallowed",
        gateCli("--report", R, "--policy", P, "--jsno").status === 2);
  check("gate --report: CANDOR_POLICY is the same fallback the other policy verbs use",
        spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", R], { encoding: "utf8", env: { ...process.env, CANDOR_POLICY: P } }).status === 0);
  // `--json` IS `--gate-json -` (SPEC §3.1 ⟨0.24⟩): on a scan `--json <file>` writes the REPORT, and
  // there is no report to write here. A second meaning would be the one place a consumer could tell the
  // two routes into the gate apart. Parsed from the SHIPPED CLI's stdout, so a prose line leaking onto
  // stdout fails the row rather than being argued about.
  const j = gateCli("--report", R, "--policy", P, "--json");
  let jv = null; try { jv = JSON.parse(j.stdout); } catch { /* below */ }
  check("gate --report: `--json` puts the VERDICT on stdout as pure JSON (prose routed to stderr)",
        jv !== null && jv.spec === SPEC && jv.ok === true && Array.isArray(jv.violations), j.stdout.slice(0, 300));
  const gj = gateCli("--report", R, "--policy", P, "--gate-json", "-");
  check("gate --report: `--gate-json -` writes the SAME document to stdout — the two spellings are one flag",
        gj.stdout === j.stdout, `${gj.stdout.slice(0, 200)} vs ${j.stdout.slice(0, 200)}`);
  const both = gateCli("--report", R, "--policy", P, "--json", "--gate-json", "-");
  check("gate --report: `--json --gate-json -` emits the verdict ONCE (stdout stays parseable)",
        both.stdout === j.stdout);
  // `--gate-json` on a read-only query would be silently INERT — the gateless-green shape (a wrapper
  // names a verdict path, nothing writes it, the wrapper reads no violations and calls the build clean).
  const inert = spawnSync("node", [path.join(HERE, "query.mjs"), "where", "Net", "--report", R, "--gate-json", path.join(d, "v.json")], { encoding: "utf8" });
  check("gate --report: `--gate-json` on a read-only verb is exit 2 naming `gate`, never silently inert",
        inert.status === 2 && /--gate-json applies to `gate`/.test(inert.stderr), inert.stderr.slice(0, 200));
  check("gate is listed in the usage catalogue (so the verb is discoverable, not folklore)",
        /^\s+gate\s+--report/m.test(spawnSync("node", [path.join(HERE, "query.mjs")], { encoding: "utf8" }).stderr));
}

// ── (e2) SPEC §3.2 ⟨0.28⟩ "GIVEN NO VALUE" MEANS THE NEXT TOKEN IS FLAG-SHAPED ──────────────────────
// The query/gate sibling of the scan CLI's conformance §3.1 (b13) row — the route the row never drives.
// Measured before the fix: `gate --report R --policy --gate-json -` consumed `--gate-json` as the policy
// FILENAME and diagnosed the displaced `-` as an "unexpected argument" (the "given no value" cause
// unreachable — no argv could produce it); `where Fs --report --json` blamed a report named `--json`; and
// on a NON-policy verb `--policy --json` was consumed and DISCARDED at exit 0 — a silently different
// command than the one on screen. BOTH halves are asserted on the gate rows — exit 2 alone passes
// against the broken behaviour, which also exited 2.
if (blk()) {
  const d = handReport({
    "r.json": { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 1, digest: "0" },
      functions: [{ fn: "app.f", inferred: ["Net"], direct: ["Net"], hosts: ["x.example"], netClass: ["unknown-host"] }] },
    "ok.pol": "deny Fs\n",
  });
  const R = path.join(d, "r.json"), P = path.join(d, "ok.pol");
  // The conformance rows run env-scrubbed; a CANDOR_POLICY in the harness environment must not turn
  // these into different runs (the policy ladder would resolve it and gate for real).
  const env = { ...process.env };
  delete env.CANDOR_POLICY; delete env.CANDOR_CONFIG; delete env.CANDOR_REPORT;
  const cli = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), ...a], { encoding: "utf8", env });
  // The STREAM spelling: the refusal document belongs on stdout, with the RIGHT cause on stderr.
  const s = cli("gate", "--report", R, "--policy", "--gate-json", "-");
  check("⟨0.28⟩ gate: `--policy --gate-json -` is '--policy was given no value', exit 2 — not a swallowed sink + displaced positional",
        s.status === 2 && /--policy was given no value/.test(s.stderr) && s.stderr.includes("--gate-json"), s.stderr.slice(0, 200));
  check("⟨0.28⟩ gate: …and the `--gate-json -` sink named AFTER the broken flag still carries the fail-closed refusal document on stdout",
        isRefusal(s.stdout), s.stdout.slice(0, 200));
  // The FILE spelling: a previous run's green must not survive as current.
  const G = path.join(d, "stale.json");
  fs.writeFileSync(G, '{"ok": true}\n');
  const f2 = cli("gate", "--report", R, "--policy", "--gate-json", G);
  let gv = null; try { gv = JSON.parse(fs.readFileSync(G, "utf8")); } catch { /* below */ }
  check("⟨0.28⟩ gate: the FILE spelling of the sink is fail-closed too — the stale green is replaced, exit 2",
        f2.status === 2 && gv !== null && gv.ok === false && gv.refused === true, `exit=${f2.status} ${JSON.stringify(gv)?.slice(0, 160)}`);
  // The same rule on the query grammar, one row per value-taking flag.
  const w = cli("where", "Fs", "--report", "--json");
  check("⟨0.28⟩ query: `--report --json` is '--report was given no value' (exit 2), never a report named `--json`",
        w.status === 2 && /--report was given no value/.test(w.stderr), w.stderr.slice(0, 200));
  const p2 = cli("where", "Fs", "--report", R, "--policy", "--json");
  check("⟨0.28⟩ query: `--policy --json` on a NON-policy verb is exit 2 — it was consumed-and-DISCARDED at exit 0, a silently different command",
        p2.status === 2 && /--policy was given no value/.test(p2.stderr), `exit=${p2.status} ${p2.stderr.slice(0, 200)}`);
  const c = cli("blindspots", "--report", R, "--class", "--json");
  check("⟨0.28⟩ query: `--class --json` is '--class was given no value' (exit 2), never an unknown-class diagnosis of a flag",
        c.status === 2 && /--class was given no value/.test(c.stderr), c.stderr.slice(0, 200));
  // The boundaries: the same argvs with the mistake repaired. A bare `-` stays a value (`--gate-json -`
  // is the stream form, pinned byte-equal to `--json` in (e) above), and a normal `--policy <file>` gates.
  const okGate = cli("gate", "--report", R, "--policy", P, "--gate-json", "-");
  let okv = null; try { okv = JSON.parse(okGate.stdout); } catch { /* below */ }
  check("⟨0.28⟩ boundary: the repaired argv gates for real — `--policy <file> --gate-json -` streams a verdict, not a refusal (exit 0)",
        okGate.status === 0 && okv?.ok === true && Array.isArray(okv?.violations), okGate.stdout.slice(0, 200));
  check("⟨0.28⟩ boundary: a value-shaped `--report <file> --json` still answers (exit 0)",
        cli("where", "Fs", "--report", R, "--json").status === 0);
}

// ── (f) THE ⟨0.15⟩ COVERAGE ADVISORY rides the verdict, off the ENVELOPE ───────────────────────────
// SPEC §3.1 names the coverage advisory in the byte-equality obligation, but the κ ledger is empty on
// every corpus the equivalence matrix above can reach, so the arm would be VACUOUS there. Asserted
// directly instead: the verdict block is `{uncovered: <count>, packages: [<name>…]}` in the PRODUCER's
// order (calls descending, then name by code point) — the same shape `scan --policy --gate-json` writes,
// read off the report envelope rather than recomputed. The two rows also differ (2 uncovered, `tpad`
// before `zpad` despite the alphabetical order) so a shape that ignored the ledger cannot pass.
if (blk()) {
  const d = handReport({
    "r.json": { candor: { version: "handwritten", spec: "0.24" }, package: "app", analyzed: { count: 2, digest: "0" },
      coverage: { uncovered: [{ name: "zpad", calls: 1 }, { name: "tpad", calls: 9 }] },
      functions: [{ fn: "app.f", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] }] },
    "p.pol": "deny Net\n",
  });
  const r = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol"), "--json");
  let v = null; try { v = JSON.parse(r.stdout); } catch { /* below */ }
  check("gate --report: the ⟨0.15⟩ κ ledger rides the verdict as {uncovered, packages} in the producer's order",
        v !== null && v.analyzed.count === 2 && v.coverage?.uncovered === 2
        && JSON.stringify(v.coverage.packages) === JSON.stringify(["tpad", "zpad"]), r.stdout.slice(0, 300));
}

// ── (g) THE VERB REFUSES A CORRUPT REPORT rather than gating an empty (all-clear) signature ─────────
if (blk()) {
  const d = handReport({ "r.json": "{ not json", "p.pol": "deny Net\n" });
  const r = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol"));
  check("gate --report: a corrupt report is exit 2 — never an empty signature gated green (the §4 cardinal sin)",
        r.status === 2, `exit=${r.status}`);
}

// ── (g2) A PARTIALLY-CORRUPT MULTI-REPORT PREFIX REFUSES TOO, AND THE ASSERTION IS ON THE DOCUMENT ──
// The row above only covered the case where EVERY file failed. The live defect was the MIXED one: a
// clean `<prefix>.Aclean.scan.json` (pure) beside a mid-write `<prefix>.Bdirty.scan.json` that carried
// the `Net` the policy denies. The old guard was `functions.length === 0 && hardFail`, so the survivor
// kept the count above zero and the gate exited 0 with `{"ok":true,"violations":[]}` — a clean green over
// a package half of whose signature never loaded. The SHAPE of the finding is the DOCUMENT, not the exit
// code: loadGateReport's stderr line DID name the dirty file, but stderr is not the machine-consumer
// channel and a CI wrapper reads the verdict. So this row asserts the document is ABSENT (nothing on
// stdout, nothing written to `--gate-json <file>`), keeps the stderr disclosure as a requirement, and
// carries TWO negative controls so it cannot pass by refusing every multi-report prefix. rust and swift
// already exit 2 on this exact fixture.
if (blk()) {
  const V = { candor: { version: "handwritten", toolchain: "none", spec: "0.24" } };
  const clean = { ...V, package: "cleanpkg", analyzed: { count: 3, digest: "aa" },
                  functions: [{ fn: "a.pureish", inferred: [], direct: [] }] };
  const dirtyWhole = { ...V, package: "dirty", analyzed: { count: 1, digest: "bb" },
                       functions: [{ fn: "b.leak", inferred: ["Net"], direct: ["Net"], hosts: ["evil.example"], netClass: ["unknown-host"] }] };
  const pureWhole = { ...V, package: "dirty", analyzed: { count: 1, digest: "bb" },
                      functions: [{ fn: "b.fine", inferred: ["Fs"], direct: ["Fs"], paths: ["/tmp/x"] }] };
  // Truncated mid-write, as a killed or half-flushed scan leaves it — and truncated INSIDE the very entry
  // that carried the Net, so the effect is unrecoverable from the bytes on disk.
  const truncated = `{"candor":{"version":"h","toolchain":"n","spec":"0.24"},"package":"dirty","functions":[{"fn":"b.leak","inferred":[`;
  const d = handReport({
    "part/rep.Aclean.scan.json": clean, "part/rep.Bdirty.scan.json": truncated,
    "fire/rep.Aclean.scan.json": clean, "fire/rep.Bdirty.scan.json": dirtyWhole,
    "pass/rep.Aclean.scan.json": clean, "pass/rep.Bdirty.scan.json": pureWhole,
    "p.pol": "deny Net\n",
  });
  const P = path.join(d, "p.pol");
  const gj = path.join(d, "verdict.json");
  if (fs.existsSync(gj)) fs.rmSync(gj);                       // DELETE the output before measuring
  const r = gateCli("--report", path.join(d, "part", "rep"), "--policy", P, "--json", "--gate-json", gj);
  check("gate --report: a PARTIALLY-corrupt multi-report prefix is exit 2 — one clean sibling does not license a verdict over the one that did not load",
        r.status === 2, `exit=${r.status} ${r.stdout}${r.stderr}`.slice(0, 400));
  check("gate --report: …and NO VERDICT DOCUMENT is produced — stdout and `--gate-json <file>` both carry a ⟨0.24⟩ REFUSAL (ok:false, refused:true, no `violations` key), never the green one that WAS the finding",
        isRefusal(r.stdout) && fs.existsSync(gj) && isRefusal(fs.readFileSync(gj, "utf8")),
        `stdout=${r.stdout.slice(0, 200)} gateJson=${fs.existsSync(gj) ? fs.readFileSync(gj, "utf8").slice(0, 200) : "(absent)"}`);
  check("gate --report: …and the per-file disclosure is KEPT — the refusal names the sibling that failed to parse",
        /rep\.Bdirty\.scan\.json/.test(r.stderr) && /failed to (parse|load)/.test(r.stderr), r.stderr.slice(0, 300));
  // CONTROL 1: the same prefix shape with B written WHOLE — the merge works, and the Net the truncation
  // hid is exactly what a violation would have come from.
  const f = gateCli("--report", path.join(d, "fire", "rep"), "--policy", P, "--json");
  check("gate --report: CONTROL — the SAME two-sibling prefix with B written whole FIRES the violation the truncation hid (exit 1)",
        f.status === 1 && JSON.parse(f.stdout).violations.length === 1, `exit=${f.status} ${f.stdout.slice(0, 300)}`);
  // CONTROL 2: a multi-report prefix is not refused for BEING multi-report.
  const p = gateCli("--report", path.join(d, "pass", "rep"), "--policy", P, "--json");
  check("gate --report: CONTROL — a two-sibling prefix that BOTH load cleanly still certifies (exit 0, count summed across siblings)",
        p.status === 0 && JSON.parse(p.stdout).ok === true && JSON.parse(p.stdout).analyzed.count === 4,
        `exit=${p.status} ${p.stdout.slice(0, 300)}`);
}

// ── (h) ⟨0.24⟩ A REPORT THAT JUDGED NOTHING IS NOT AN ALL-CLEAR (SPEC §2's table, bound by §3.1) ────
// "A report presented DIRECTLY to the gate with `analyzed.count: 0` makes the same claim as a chained
// one, and must be read the same way … the obligation is on the reading, not on the route by which the
// report arrived." This verb IS the foreign-report route — nothing here is version-checked, so the count-0
// report a chain would send down the §2.1 stale path arrives at full trust. What the rule buys is the
// DISCLOSURE beside "no violations": the exit code and the verdict document must NOT move, because §3.1
// makes byte-equality with `scan --policy`'s the acceptance test (a scan that analyzed nothing writes
// `{ok: true, analyzed: {count: 0}}` and exits 0) and because a verdict is an assertion the report gives
// no evidence for. The CONTROL rows are the same three the chained half carries, for the same reason.
if (blk()) {
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app" };
  const F = [{ fn: "app.f", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] }];
  const d = handReport({
    "zero.json": { ...V, analyzed: { count: 0, digest: "0" }, functions: [] },
    "allpure.json": { ...V, analyzed: { count: 2, digest: "0" }, functions: [] },
    "nomanifest.json": { ...V, functions: [] },
    "garbled.json": { ...V, analyzed: "oops", functions: [] },
    "legacy.json": F,                                             // a bare-array report: its ENTRIES are its claim
    "ordinary.json": { ...V, analyzed: { count: 3, digest: "0" }, functions: F },
    "p.pol": "deny Net\n",
  });
  const say = (rep) => gateCli("--report", path.join(d, rep), "--policy", path.join(d, "p.pol"), "--json");
  const judged = (r) => /judged NOTHING/.test(r.stderr);
  const z = say("zero.json");
  check("⟨0.24⟩ gate --report: a count-0 report is DISCLOSED as having judged nothing, beside the verdict",
        judged(z) && /analyzed\.count/.test(z.stderr) && /licenses no purity claim/.test(z.stderr), z.stderr.slice(0, 300));
  check("⟨0.24⟩ gate --report: …and the VERDICT and EXIT do not move (byte-equality with `scan --policy` is the acceptance test)",
        z.status === 0 && JSON.parse(z.stdout).ok === true && JSON.parse(z.stdout).analyzed.count === 0
        && JSON.parse(z.stdout).violations.length === 0, `exit=${z.status} ${z.stdout.slice(0, 200)}`);
  // THE CONTROL: one integer apart from the row above, and §2 rule 3 requires the gate to believe it.
  const a = say("allpure.json");
  check("⟨0.24⟩ gate --report: CONTROL — count n>0 with the SAME empty `functions` gets NO caveat",
        !judged(a) && a.status === 0 && JSON.parse(a.stdout).analyzed.count === 2, a.stderr.slice(0, 200));
  const o = say("ordinary.json");
  check("⟨0.24⟩ gate --report: CONTROL — an ordinary report with entries gets NO caveat",
        !judged(o) && o.status === 0, o.stderr.slice(0, 200));
  // The legacy bare array is why the check is the SHARED predicate and not the summed `analyzed.count`:
  // it has no envelope to sum, so a count-derived test would call the one report shape whose entries ARE
  // its judgment claim "unjudged" and hedge every pre-⟨0.21⟩ consumer.
  check("⟨0.24⟩ gate --report: a legacy bare-array report with entries gets NO caveat (its entries are the claim)",
        !judged(say("legacy.json")), say("legacy.json").stderr.slice(0, 200));
  check("⟨0.24⟩ gate --report: row 3 — a manifest-less EMPTY report reads as judged-nothing",
        judged(say("nomanifest.json")));
  // Fail-closed on a manifest that cannot be READ — and after the ⟨0.24⟩ present-but-unparseable rule
  // (SPEC §2) the fail-closed answer on THIS route is the refusal, not the caveat: `analyzed: "oops"` is
  // a §2 key that is THERE and of the wrong shape, so exit 2 NAMING it. The count-0 row above is the
  // control that keeps the two apart — a READABLE zero still exits 0 with an unmoved document, because
  // there the byte-equality obligation is real (a scan that analyzed nothing writes exactly that), while
  // no scan ever emits `analyzed: "oops"` for a refusal to diverge from.
  const gb = say("garbled.json");
  check("⟨0.24⟩ gate --report: fail-closed — a manifest that cannot be READ is not a claim: exit 2, naming `analyzed`",
        gb.status === 2 && /`analyzed`/.test(gb.stderr) && isRefusal(gb.stdout), `exit=${gb.status} ${gb.stderr.slice(0, 300)}`);
}

// ── (i) ⟨0.24⟩ SPEC §2: A PRESENT-BUT-UNPARSEABLE KEY IS CORRUPT INPUT, NEVER ITS EMPTY VALUE ───────
// "That default is always the permissive value — 0, [], absent — so the coercion converts corrupt input
// into a claim, and on every one of these keys the claim is the safe-looking one." Under ⟨0.21⟩ an entry
// with no effects is a POSITIVE PURITY CLAIM, so an entry whose `inferred` was coerced from `[1]` to `[]`
// did not become a gap — it became a lie, and the gate certified it (measured: exit 0,
// `{"ok":true,"violations":[]}`). The matrix below is half REFUSAL rows and half ABSENT rows on purpose:
// the rule is a DISTINCTION, and a fix that refused on absence too would be a spurious-refusal machine
// that fails every pre-⟨0.21⟩ and every legitimately-sparse report. The last two rows pin the SCOPE — a
// wrong-typed key no verdict reads is not a refusal, and a read-only query over the same bytes still
// answers (it returns what it found rather than certifying, so the coercion is right there).
if (blk()) {
  const V = { candor: { version: "handwritten", spec: "0.24" }, package: "app" };
  const A = { count: 2, digest: "0" };
  const clean = { fn: "app.ok", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] };
  const rep = (o) => ({ ...V, analyzed: A, functions: [], ...o });
  const d = handReport({
    // ── PRESENT BUT UNPARSEABLE → exit 2, naming the key
    "e_elem.json":    rep({ functions: [{ fn: "app.bad", inferred: [1], direct: [1] }] }),
    "e_nonarr.json":  rep({ functions: [{ fn: "app.bad", inferred: "Net", direct: [] }] }),
    "e_mixed.json":   rep({ functions: [clean, { fn: "app.bad", inferred: [1] }] }),   // a SURVIVOR beside it
    "e_nofn.json":    rep({ functions: [clean, { inferred: ["Net"], direct: ["Net"] }] }),
    "e_why.json":     rep({ functions: [{ fn: "app.bad", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: [7] }] }),
    "e_netcls.json":  rep({ functions: [{ fn: "app.bad", inferred: ["Net"], direct: ["Net"], hosts: ["x"], netClass: 1 }] }),
    "e_declared.json": rep({ functions: [{ fn: "app.bad", inferred: [], direct: [], declared: { Net: true } }] }),
    "u_strings.json": rep({ unanalyzed: ["src/broken.ts"] }),                     // the spec's own case
    "u_nonarr.json":  rep({ unanalyzed: "src/broken.ts" }),
    "u_badpath.json": rep({ unanalyzed: [{ path: 3, reason: "parse error" }] }),
    "a_bool.json":    rep({ analyzed: { count: true, digest: "0" } }),             // swift's NSNumber bridge
    "a_frac.json":    rep({ analyzed: { count: 0.5, digest: "0" } }),
    "a_neg.json":     rep({ analyzed: { count: -1, digest: "0" } }),
    "a_str.json":     rep({ analyzed: { count: "2", digest: "0" } }),
    // ── LEGITIMATELY ABSENT → the documented default, exit 0
    "ok_noinf.json":  rep({ functions: [{ fn: "app.q", direct: [] }] }),           // `inferred` simply absent
    "ok_bare.json":   rep({ functions: [{ fn: "app.q" }] }),                       // every optional key absent
    "ok_nounan.json": rep({ functions: [clean] }),                                 // `unanalyzed` absent
    "ok_noman.json":  { ...V, functions: [clean] },                                // `analyzed` absent (pre-⟨0.21⟩)
    "ok_emptyman.json": rep({ analyzed: { digest: "0" }, functions: [clean] }),    // `count` absent INSIDE `analyzed`
    "ok_emptyunan.json": rep({ unanalyzed: [], functions: [clean] }),              // present and EMPTY is not corrupt
    // ── SCOPE: wrong-typed, but no verdict reads it → not a refusal
    "ok_offscope.json": rep({ functions: [{ ...clean, loc: 7, hash: [], unresolved: "yes", unitKind: 3 }] }),
    "p.pol": "deny Net\n",
  });
  const g = (rep_) => gateCli("--report", path.join(d, rep_), "--policy", path.join(d, "p.pol"), "--json");
  const REFUSE = [["e_elem", "inferred"], ["e_nonarr", "inferred"], ["e_mixed", "inferred"], ["e_nofn", "fn"],
                  ["e_why", "unknownWhy"], ["e_netcls", "netClass"], ["e_declared", "declared"],
                  ["u_strings", "unanalyzed"], ["u_nonarr", "unanalyzed"], ["u_badpath", "unanalyzed"],
                  ["a_bool", "analyzed.count"], ["a_frac", "analyzed.count"], ["a_neg", "analyzed.count"],
                  ["a_str", "analyzed.count"]];
  const bad = [];
  for (const [name, key] of REFUSE) {
    const r = g(`${name}.json`);
    if (r.status !== 2) bad.push(`${name}: exit ${r.status} (expected 2) ${r.stdout.slice(0, 120)}`);
    else if (!r.stderr.includes(`\`${key}\``)) bad.push(`${name}: refused but did not NAME \`${key}\` — ${r.stderr.slice(0, 200)}`);
    else if (!isRefusal(r.stdout)) bad.push(`${name}: refused, but the document is not a ⟨0.24⟩ refusal (want ok:false + refused:true + NO violations key): ${r.stdout.slice(0, 160)}`);
  }
  check(`⟨0.24⟩ gate --report: all ${REFUSE.length} present-but-unparseable §2 keys are exit 2, each NAMING the key, each emitting a REFUSAL document and never a verdict`,
        bad.length === 0, bad.join("\n"));
  // THE OTHER HALF OF THE RULE. Without these the fix is indistinguishable from "refuse anything unusual",
  // which would break every sparse or pre-⟨0.21⟩ report in the wild.
  const spurious = [];
  for (const name of ["ok_noinf", "ok_bare", "ok_nounan", "ok_noman", "ok_emptyman", "ok_emptyunan", "ok_offscope"]) {
    const r = g(`${name}.json`);
    if (r.status !== 0) spurious.push(`${name}: exit ${r.status} (expected 0) — ${r.stderr.slice(0, 200)}`);
  }
  check("⟨0.24⟩ gate --report: CONTROL — an ABSENT key takes its documented default (exit 0), and a wrong-typed key NO verdict reads is not a refusal",
        spurious.length === 0, spurious.join("\n"));
  // The mixed row is the sharp one: a clean entry survived, so a "did anything load?" guard would have
  // certified. Assert the SURVIVOR did not license the verdict.
  const mx = g("e_mixed.json");
  check("⟨0.24⟩ gate --report: a corrupt entry BESIDE a clean survivor still refuses — the survivor does not license a verdict over the entry that could not be read",
        mx.status === 2 && isRefusal(mx.stdout) && /app\.bad/.test(mx.stderr), `exit=${mx.status} ${mx.stderr.slice(0, 250)}`);
  // NEGATIVE CONTROL for the whole block: the same entry written WELL, with the effect the corruption hid.
  const live = handReport({ "r.json": { ...V, analyzed: A, functions: [{ fn: "app.bad", inferred: ["Net"], direct: ["Net"], hosts: ["x"], netClass: ["unknown-host"] }] },
                            "p.pol": "deny Net\n" });
  const lv = gateCli("--report", path.join(live, "r.json"), "--policy", path.join(live, "p.pol"), "--json");
  check("⟨0.24⟩ gate --report: NEGATIVE CONTROL — the same entry written WELL fires the violation (exit 1), so the refusal rows are not just an unloadable fixture",
        lv.status === 1 && JSON.parse(lv.stdout).violations.length === 1, `exit=${lv.status} ${lv.stdout.slice(0, 200)}`);
  // THE BOUNDARY: the coercion is still right on a read-only query, which returns what it found rather
  // than certifying. `show` over the very bytes the gate refuses must still answer, exit 0.
  const sh = spawnSync("node", [path.join(HERE, "query.mjs"), "show", "--report", path.join(d, "e_elem.json"), "app.bad"], { encoding: "utf8" });
  check("⟨0.24⟩ gate --report: BOUNDARY — a read-only query over the SAME corrupt bytes still answers (exit 0); only the verdict route refuses",
        sh.status === 0, `exit=${sh.status} ${sh.stderr.slice(0, 200)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ⟨0.24⟩ THE PRECEDENCE / REFUSAL-DOCUMENT / POLICY-ERROR / VOCABULARY-ANCHOR RUNG
// (SPEC §3.1 `7271c69` `107755b` `99eb4e9` `1503368` `5a8cf48` `01d5c6b` `b4e9155` `6929dce`, §6.2
//  `382a7e0` `be0b9a9`.)  Every row here drives the SHIPPED CLI and reads the DOCUMENT, not the exit
// code alone — the harm this whole rung is about is evidence going missing from the machine-consumer
// channel, and an exit-code-only assertion is blind to exactly that.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
if (blk()) {
  const V = { candor: { version: "handwritten", spec: "0.24" } };
  const readDoc = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  // A GREEN document already sitting at the --gate-json path: the shape a CI cache or yesterday's clean
  // run leaves behind, and the whole reason a refusal must WRITE rather than skip.
  const STALE = JSON.stringify({ spec: "0.24", ok: true, analyzed: { count: 9 }, violations: [] }, null, 1);
  const seedStale = (p) => { fs.writeFileSync(p, STALE + "\n"); return p; };

  // ── ITEM 1: A CERTAIN VIOLATION DOMINATES A REFUSAL ─────────────────────────────────────────────
  // The report carries one unambiguous `Fs` and one `Net` with NO `netClass`, so `deny Net[unknown-host]`
  // cannot be decided from it. Before this rung all four engines exited 2 on the PAIR and wrote no
  // document at all, deleting a certain violation from the only channel a CI wrapper reads.
  {
    const d = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 2, digest: "0" },
                  functions: [{ fn: "app.writes", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] },
                              { fn: "app.calls", inferred: ["Net"], direct: ["Net"] }] },
      "mixed.pol": "deny Fs\ndeny Net[unknown-host] app\n",
      "fire.pol": "deny Fs\n",
      "refuse.pol": "deny Net[unknown-host] app\n",
      "forbid.pol": "deny Fs\nforbid app -> infra\n",
      "allow.pol": "deny Fs\nallow Exec in app git\n",
    });
    const run = (pol, out) => {
      const p = path.join(d, out);
      if (fs.existsSync(p)) fs.rmSync(p);          // DELETE the output before measuring — a stale
      return { r: gateCli("--report", path.join(d, "r.json"),   // artifact here reads as a pass.
                          "--policy", path.join(d, pol), "--gate-json", p), doc: () => readDoc(p) };
    };
    // THE ROW. Not `status === 1` — the defect is precisely the case where an engine could get the code
    // right and still ship no evidence, so the assertion is on the RECORD in the document.
    const mixed = run("mixed.pol", "mixed.json");
    const mv = mixed.doc()?.violations;
    check("⟨0.24⟩ precedence: a firing `deny Fs` BESIDE an unanswerable scoped rule exits 1 and the document CARRIES the certain violation",
          mixed.r.status === 1 && Array.isArray(mv) && mv.some((v) => v.fn === "app.writes"),
          `exit=${mixed.r.status} doc=${JSON.stringify(mixed.doc())?.slice(0, 300)}`);
    // …and the rule it could NOT read is disclosed rather than swallowed — exit 1 reports what it is sure
    // of, it does not conceal the part it could not evaluate.
    check("⟨0.24⟩ precedence: …and the unevaluated rule rides the SAME document under `unevaluated`",
          (mixed.doc()?.unevaluated ?? []).some((u) => /Net\[unknown-host\]/.test(u.rule)),
          JSON.stringify(mixed.doc()?.unevaluated));
    // TWO CONTROLS, neither optional. Without the second the row cannot distinguish "the violation
    // dominated the refusal" from "the scoped rule was answerable all along and there was no refusal".
    const fire = run("fire.pol", "fire.json"), refuse = run("refuse.pol", "refuse.json");
    check("⟨0.24⟩ precedence CONTROL: `deny Fs` alone still exits 1, `deny Net[unknown-host]` alone still exits 2",
          fire.r.status === 1 && refuse.r.status === 2, `fire=${fire.r.status} refuse=${refuse.r.status}`);
    // ⟨0.24⟩ `1503368`: precedence binds the WHOLE-POLICY refusals too. Lemma 2 does not care which KIND
    // of refusal stands beside the firing rule. These two used to exit 2 with the violation absent.
    for (const [pol, out, kind] of [["forbid.pol", "fb.json", "forbid"], ["allow.pol", "al.json", "allow"]]) {
      const a = run(pol, out);
      check(`⟨0.24⟩ precedence: a firing rule beside a whole-policy \`${kind}\` refusal exits 1 with the violation in the document`,
            a.r.status === 1 && (a.doc()?.violations ?? []).some((v) => v.fn === "app.writes"),
            `exit=${a.r.status} doc=${JSON.stringify(a.doc())?.slice(0, 300)}`);
    }
  }

  // ── ITEM 1b: THE FABRICATION THE PRECEDENCE FIX MAKES REACHABLE ─────────────────────────────────
  // Removing the short-circuit lets the evaluator reach code it never reached before, and
  // `reasonClassesMatch` floors an EMPTY class set at `unresolved` — right for a MATCHER ("could this
  // rule apply?"), wrong as grounds for a FIRING ("did it?"). Without the withholding this engine emits
  // a violation RECORD for `app.inherits`, asserting a reason nobody recorded. MUTATION-VERIFIED: with
  // the `withhold` filter removed, `app.inherits` appears in `violations`.
  {
    const d = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 2, digest: "0" },
                  functions: [{ fn: "app.writes", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] },
                              // INHERITED and reasonless: no `unknownWhy`, no `direct` Unknown (which would
                              // CONTRIBUTE `unresolved` at its own entry), and a `calls` edge to a callee
                              // the report does not carry — so nothing classifies it.
                              { fn: "app.inherits", inferred: ["Unknown"], direct: [], calls: ["vendor.gone"] }] },
      "p.pol": "deny Fs\ndeny Unknown[unresolved] app.inherits\n",
    });
    const out = path.join(d, "v.json");
    const r = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol"), "--gate-json", out);
    const vs = readDoc(out)?.violations ?? [];
    check("⟨0.24⟩ withholding: an unanswerable (rule, fn) pair is NEITHER a violation nor a pass — no fabricated `unresolved` record beside the certain one",
          r.status === 1 && vs.length === 1 && vs[0].fn === "app.writes",
          `exit=${r.status} violations=${JSON.stringify(vs)}`);
  }

  // ── ITEM 1c: THE WITHHOLDING IS PER (RULE, FUNCTION, **EFFECT**) ────────────────────────────────
  // ONE rule and ONE function carrying BOTH a certain `Fs` and a `netClass`-less `Net`. Withholding the
  // (rule, function) PAIR — the form §3.1 `5a8cf48` states — deletes the certain `Fs` violation and
  // refuses instead: MEASURED exit 2 with the `violations` key ABSENT, which is the exact harm the
  // precedence ruling exists to fix, reintroduced by the fix for the fabrication above.
  {
    const d = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 1, digest: "0" },
                  functions: [{ fn: "app.mixed", inferred: ["Fs", "Net"], direct: ["Fs", "Net"], paths: ["/etc/hosts"] }] },
      "p.pol": "deny Fs Net[unknown-host] app\n",
    });
    const out = path.join(d, "v.json");
    const r = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol"), "--gate-json", out);
    const doc = readDoc(out);
    check("⟨0.24⟩ withholding is per (rule, fn, EFFECT): one rule's certain `Fs` survives beside its own unanswerable `Net[unknown-host]` on the SAME function",
          r.status === 1 && (doc?.violations ?? []).length === 1
            && doc.violations[0].fn === "app.mixed" && doc.violations[0].effects.join() === "Fs",
          `exit=${r.status} doc=${JSON.stringify(doc)?.slice(0, 300)}`);
  }

  // ── ITEM 1d: A CORRUPTION REFUSAL DOMINATES EVEN A CERTAIN VIOLATION ────────────────────────────
  // ⟨0.24⟩ `01d5c6b`. The two refusals are indistinguishable from the exit code, so the boundary has to
  // be asserted. An ANSWERABILITY refusal leaves the premise intact — the other rules' evidence IS
  // carried — so a firing rule is certain. A CORRUPTION refusal denies that premise: a violation
  // computed from a document with an unparseable §2 key is a finding computed from bytes of unknown
  // meaning, and exit 1 there would assert a confidence the input does not support.
  {
    const d = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 2, digest: "0" },
                  functions: [{ fn: "app.writes", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] },
                              { fn: "app.bad", inferred: ["Net"], direct: ["Net"], netClass: 1 }] },
      "p.pol": "deny Fs\n",
    });
    const out = seedStale(path.join(d, "v.json"));
    const r = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "p.pol"), "--gate-json", out);
    const doc = readDoc(out);
    check("⟨0.24⟩ precedence BOUNDARY: a CORRUPTION refusal dominates even a firing rule (exit 2, refused, no violations key) — unlike an answerability refusal",
          r.status === 2 && doc?.ok === false && doc?.refused === true && !("violations" in doc),
          `exit=${r.status} doc=${JSON.stringify(doc)?.slice(0, 300)}`);
  }

  // ── ITEM 2: A REFUSAL MUST STILL WRITE A DOCUMENT, AND IT MUST NOT CARRY `violations` ───────────
  // Every row seeds a GREEN document at the path first, because "wrote nothing" and "wrote a refusal"
  // are indistinguishable on an empty directory — and the hazard is a wrapper re-reading LAST RUN's
  // verdict, not a missing file. `1503368`: no cause is exempt, including an unreadable policy.
  {
    const d = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 1, digest: "0" },
                  functions: [{ fn: "app.calls", inferred: ["Net"], direct: ["Net"] }] },
      "bad.json": "{ this is not json",
      "scoped.pol": "deny Net[unknown-host] app\n",
      "forbid.pol": "forbid app -> infra\n",
      "allow.pol": "allow Exec in app git\n",
      "typo.pol": "deny Unknown[dispatch,nativ] app\n",
      "live.pol": "deny Net\n",
    });
    const bad = [];
    const ROWS = [
      ["an unanswerable scoped rule", "scoped.pol", "r.json"],
      ["a whole-policy `forbid`", "forbid.pol", "r.json"],
      ["a whole-policy `allow`", "allow.pol", "r.json"],
      ["an unrecognised policy token", "typo.pol", "r.json"],
      ["an unreadable policy", "nosuch.pol", "r.json"],
      ["a report that did not load", "live.pol", "bad.json"],
    ];
    for (const [label, pol, rep] of ROWS) {
      const out = seedStale(path.join(d, `ref.${pol}.${rep}.json`));
      const r = gateCli("--report", path.join(d, rep), "--policy", path.join(d, pol), "--gate-json", out);
      const doc = readDoc(out);
      if (r.status !== 2) { bad.push(`${label}: exit ${r.status}, want 2`); continue; }
      if (!doc) { bad.push(`${label}: no parseable document — the wrapper re-reads YESTERDAY'S verdict`); continue; }
      if (doc.ok !== false) bad.push(`${label}: ok=${JSON.stringify(doc.ok)}, want false (a consumer keying only on \`ok\` must land on FAIL)`);
      if (doc.refused !== true) bad.push(`${label}: refused=${JSON.stringify(doc.refused)}, want true`);
      // ABSENT, not empty — and this is the whole assertion. `=== []` would pass on the fail-open shape:
      // a refusal makes NO claim about violations, and an empty array is precisely the claim it cannot make.
      if ("violations" in doc) bad.push(`${label}: carries a \`violations\` key (${JSON.stringify(doc.violations)}) — ABSENT, not empty`);
      if (!doc.reason) bad.push(`${label}: no \`reason\``);
    }
    check(`⟨0.24⟩ refusal document: all ${ROWS.length} refusal causes OVERWRITE a stale green with ok:false + refused:true and NO \`violations\` key`,
          bad.length === 0, bad.join("\n"));
    // THE CONTROL, without which the row above passes on an engine that has stopped emitting the key at
    // all: a real verdict still carries `violations`, and a clean one still carries it EMPTY.
    const liveOut = path.join(d, "live.json");
    const live = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "live.pol"), "--gate-json", liveOut);
    const pureOut = path.join(d, "pure.json");
    fs.writeFileSync(path.join(d, "pure.pol"), "deny Fs\n");
    const pure = gateCli("--report", path.join(d, "r.json"), "--policy", path.join(d, "pure.pol"), "--gate-json", pureOut);
    check("⟨0.24⟩ refusal document CONTROL: a real VERDICT still carries `violations` (fired: 1 record; clean: an empty array)",
          live.status === 1 && (readDoc(liveOut)?.violations ?? []).length === 1
            && pure.status === 0 && Array.isArray(readDoc(pureOut)?.violations) && readDoc(pureOut).violations.length === 0,
          `live=${live.status} pure=${pure.status}`);
    // ⟨0.27⟩ REVERSED, and it is worth saying why the old row was wrong rather than just deleting it.
    // It asserted that a USAGE error (no `--policy`) leaves the stale document untouched, on the ground
    // that "the command was never a gate invocation". But `--gate-json <path>` WAS requested: the
    // operator asked for a verdict at that path and misconfigured how to reach it, and a green document
    // from yesterday sitting there is exactly as dangerous as it is after any other exit 2. SPEC §3.3
    // names an unknown flag as a broken-gate-config exit-2 cause, §3.1 requires a fail-closed document
    // on EVERY exit-2 cause, and §1916 calls a carve-out "a fail-open path with a reason attached".
    // This row was that carve-out; the reason was only ever that the case felt different.
    //
    // The one thing that still writes nothing is a sink that cannot BE a sink — no value, or the same
    // artifact as an input this run must read. That is not a carve-out: the path was never a verdict
    // path, so there is no stale verdict at it.
    const useOut = seedStale(path.join(d, "usage.json"));
    const use = gateCli("--report", path.join(d, "r.json"), "--gate-json", useOut);
    check("⟨0.27⟩ refusal document: a USAGE error (no --policy) ALSO replaces a stale green — the sink was requested, so it is armed",
          use.status === 2 && readDoc(useOut)?.ok === false && readDoc(useOut)?.refused === true
            && !("violations" in (readDoc(useOut) ?? {})), `exit=${use.status}`);
    // …and the genuinely unusable sink, which must leave the input alone.
    const polPath = path.join(d, "collide.pol");
    fs.writeFileSync(polPath, "deny Fs\n");
    const collide = gateCli("--report", path.join(d, "r.json"), "--policy", polPath, "--gate-json", polPath);
    check("⟨0.27⟩ a --gate-json that names the --policy is refused (exit 2) with the policy INTACT and nothing written",
          collide.status === 2 && fs.readFileSync(polPath, "utf8") === "deny Fs\n", `exit=${collide.status}`);
  }

  // ── ITEM 3: AN UNRECOGNISED VALUE TOKEN IS A POLICY ERROR — AND `parsepolicy` STILL REPORTS ─────
  // The TYPO-BESIDE-VALID-TOKENS row comes FIRST in every list because it is the fail-open one and the
  // one that will regress: measured before the fix, `deny Unknown[dispatch,nativ]` exited 0 (the rule
  // NARROWED to `[dispatch]` and stopped gating native-caused holes while the gate looked armed), where
  // the sole-unrecognised-token form exited 1 (the rule WIDENED to a bare `deny Unknown`). Two different
  // wrong answers from two silent rewrites of the same one-line policy.
  {
    const d = project({
      "polhome/.candor/config": "unknown-alias corp = dispatch,nativ\n",
      "src/app.ts": "export function dyn(o: any, k: string) { return o[k](); }\n",
    });
    const rep = handReport({
      "r.json": { ...V, package: "app", analyzed: { count: 1, digest: "0" },
                  functions: [{ fn: "app.dyn", inferred: ["Unknown", "Net"], direct: ["Unknown", "Net"],
                                unknownWhy: ["native:ffi"], hosts: ["x.example"], netClass: ["unknown-host"] }] },
    });
    const POLICIES = [
      ["a typo BESIDE valid reason-class tokens (NARROWS — the fail-open)", "deny Unknown[dispatch,nativ] app\n"],
      ["a typo BESIDE valid Net destination-class tokens (NARROWS)", "deny Net[known-partner,unkown-host] app\n"],
      ["the SOLE reason-class token unrecognised (WIDENS)", "deny Unknown[corp2] app\n"],
      ["the SOLE Net destination-class token unrecognised (WIDENS)", "deny Net[unkown-host] app\n"],
    ];
    const bad = [];
    for (const [label, text] of POLICIES) {
      const pol = path.join(d, "p.pol");
      fs.writeFileSync(pol, text);
      // THE PAIR (`6929dce`): the ENFORCER refuses, the WITNESS reports. Both halves are asserted for
      // every policy, because moving the error out of the parser is exactly the change that re-opens the
      // fail-open, and leaving it in the parser is what took the four-way differential offline.
      const g = gateCli("--report", path.join(rep, "r.json"), "--policy", pol);
      if (g.status !== 2) bad.push(`${label}: gate --report exit ${g.status}, want 2`);
      if (!/nativ|unkown-host|corp2/.test(g.stderr)) bad.push(`${label}: the gate did not NAME the offending token`);
      const s = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", pol], { encoding: "utf8" });
      if (s.status !== 2) bad.push(`${label}: scan --policy exit ${s.status}, want 2`);
      const pp = spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", pol], { encoding: "utf8" });
      if (pp.status !== 0) bad.push(`${label}: parsepolicy exit ${pp.status}, want 0 — the WITNESS must not refuse`);
      const errs = (() => { try { return JSON.parse(pp.stdout).errors ?? []; } catch { return null; } })();
      if (!errs || !errs.length) bad.push(`${label}: parsepolicy reported no \`errors\` — a diff that cannot tell "dropped" from "rejected" cannot pin this rung`);
    }
    check(`⟨0.24⟩ policy error: all ${POLICIES.length} unrecognised-token forms REFUSE on both gate routes (exit 2) and are REPORTED by parsepolicy (exit 0)`,
          bad.length === 0, bad.join("\n"));
    // THE THIRD VOCABULARY (`be0b9a9`): the typo is in the alias DEFINITION rather than in the policy,
    // and it fails open identically — `= dispatch,nativ` silently becomes `{dispatch}`, so the rule stops
    // gating native-caused holes while the policy mentions no typo at all.
    const apol = path.join(d, "polhome", "a.pol");
    fs.writeFileSync(apol, "deny Unknown[corp] app\n");
    const ag = gateCli("--report", path.join(rep, "r.json"), "--policy", apol);
    check("⟨0.24⟩ policy error: a typo in an alias DEFINITION (`unknown-alias corp = dispatch,nativ`) is a policy error too — the vocabulary the policy is written against",
          ag.status === 2 && /nativ/.test(ag.stderr), `exit=${ag.status} ${ag.stderr.slice(0, 200)}`);
    // THE CONTROL: correctly spelled, the very same rules are honoured. Without it every row above passes
    // on an engine that has started refusing every policy.
    fs.writeFileSync(path.join(d, "polhome", ".candor", "config"), "unknown-alias corp = dispatch,native\n");
    const ok1 = gateCli("--report", path.join(rep, "r.json"), "--policy", apol);
    fs.writeFileSync(path.join(d, "ok.pol"), "deny Unknown[dispatch,native] app\n");
    const ok2 = gateCli("--report", path.join(rep, "r.json"), "--policy", path.join(d, "ok.pol"));
    check("⟨0.24⟩ policy error CONTROL: the SAME rules spelled correctly are honoured and FIRE (exit 1) — via the alias and directly",
          ok1.status === 1 && ok2.status === 1, `alias=${ok1.status} direct=${ok2.status}`);
  }

  // ── ITEM 4: POLICY VOCABULARY ANCHORS AT THE POLICY FILE, ON BOTH ROUTES, AND IS DISCLOSED ──────
  // The policy is filed OUTSIDE the scan target — which every pre-existing row in this file fails to do,
  // and is exactly why the anchor split went unseen in four engines. Before the fix the gate verb
  // anchored at the policy's directory and the scan route at the target, so the same rule expanded
  // differently and §3.1's byte-equality MUST was breakable by a file that is neither report nor policy.
  {
    const d = project({
      "polhome/my.policy": "deny Unknown[corp] src\n",
      "proj/src/app.ts": "export function dyn(o: any, k: string) { return o[k](); }\n",
    });
    const proj = path.join(d, "proj"), pol = path.join(d, "polhome", "my.policy");
    const cfg = path.join(d, "polhome", ".candor", "config");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const both = (label, aliasDef, wantExit) => {
      fs.writeFileSync(cfg, aliasDef);
      const a = path.join(d, `${label}.scan.json`), b = path.join(d, `${label}.gate.json`);
      for (const f of [a, b]) if (fs.existsSync(f)) fs.rmSync(f);
      const s = spawnSync("node", [path.join(HERE, "scan.mjs"), proj, "--policy", pol, "--gate-json", a], { encoding: "utf8" });
      const g = gateCli("--report", path.join(proj, ".candor", "report.json"), "--policy", pol, "--gate-json", b);
      const out = [];
      if (!fs.existsSync(a) || !fs.existsSync(b)) out.push(`${label}: a document was not written (scan ${s.status}, gate ${g.status})`);
      else if (!fs.readFileSync(a).equals(fs.readFileSync(b)))
        out.push(`${label}: NOT byte-equal\n  scan ${fs.readFileSync(a, "utf8").slice(0, 300)}\n  gate ${fs.readFileSync(b, "utf8").slice(0, 300)}`);
      if (s.status !== g.status) out.push(`${label}: exit ${s.status} (scan) vs ${g.status} (gate)`);
      if (s.status !== wantExit) out.push(`${label}: exit ${s.status}, want ${wantExit}`);
      return { out, doc: readDoc(a) };
    };
    // The entry's Unknown is `callback:`-caused ⇒ class `indirect`. BOTH arms are required: one alone
    // cannot tell "the alias resolved" from "the alias was ignored and the rule widened to bare Unknown",
    // because a widened rule ALSO fires. The tolerating arm is the discrimination control.
    const fire = both("firing", "unknown-alias corp = indirect\n", 1);
    const tol = both("tolerating", "unknown-alias corp = reflect\n", 0);
    check("⟨0.24⟩ vocabulary anchor: with the policy filed OUTSIDE the scan target, both routes agree byte-for-byte — FIRING alias (exit 1) and TOLERATING alias (exit 0)",
          fire.out.length === 0 && tol.out.length === 0, [...fire.out, ...tol.out].join("\n"));
    // AND THE AMBIENCE IS DISCLOSED. Discovery walks parent directories and CANDOR_CONFIG overrides it
    // outright, so a file the operator never named can decide the verdict. The OBJECT form is required
    // (`b4e9155`): naming the source without the content leaves the reader knowing they were affected
    // and not how.
    const pv = fire.doc?.policyVocabulary;
    check("⟨0.24⟩ vocabulary anchor: the verdict NAMES the config that supplied the vocabulary, with the alias DEFINITION (`{config, aliases:{name:[class…]}}`), not just its name",
          pv?.config === cfg && pv?.aliases && !Array.isArray(pv.aliases)
            && JSON.stringify(pv.aliases.corp) === JSON.stringify(["indirect"]),
          JSON.stringify(pv));
    // Recorded at the point of USE, never from the alias map: a config defining ten aliases the policy
    // never mentions changed nothing, and naming it would train the reader to ignore the field.
    fs.writeFileSync(cfg, "unknown-alias corp = indirect\nunknown-alias unused = reflect\n");
    fs.writeFileSync(path.join(d, "noalias.pol"), "deny Fs src\n");
    const na = path.join(d, "noalias.json");
    if (fs.existsSync(na)) fs.rmSync(na);
    spawnSync("node", [path.join(HERE, "scan.mjs"), proj, "--policy", path.join(d, "noalias.pol"), "--gate-json", na], { encoding: "utf8" });
    check("⟨0.24⟩ vocabulary anchor: a policy that references NO alias discloses nothing (the block is omitted, so the verdict stays byte-identical to pre-⟨0.24⟩)",
          readDoc(na) && !("policyVocabulary" in readDoc(na)), JSON.stringify(readDoc(na))?.slice(0, 200));
  }
}

// ── ⟨0.24⟩ PRECEDENCE BINDS THE VERDICT, NOT THE POLICY GATE (SPEC §3.1 `4c79958`) ─────────────────
// A CERTAIN baseline regression was DELETED from the machine channel by an unrelated policy refusal, in
// all four engines. Measured — a pure function gains an `Fs` call, scanned against a frozen baseline:
//
//     control (no policy)          -> exit 1, violations ["AS-EFF-005"]
//     + a policy with a bad token  -> exit 2, NO `violations` key
//
// It survived on stderr, so the human saw it and CI did not — the split this rung exists to close. The
// AS-EFF-005 guard is a DIFFERENT violation producer from the policy gate, it runs earlier by design, and
// it records into the same verdict; the precedence repair had been scoped to the policy gate's own list.
// THE ASSERTION IS ON THE DOCUMENT, deliberately: an exit code alone cannot tell a lost finding from a
// found one, and the document is the channel that lost it.
if (blk()) {
  const pureSrc = "export function worker(): number { return 41 + 1; }\nexport function caller(): number { return worker(); }\n";
  const gainSrc = 'import fs from "node:fs";\nexport function worker(): number { fs.readFileSync("/tmp/x"); return 41 + 1; }\nexport function caller(): number { return worker(); }\n';
  const d = project({ "src/app.ts": pureSrc });
  const bl = path.join(d, "baseline.json");
  const run = (args, env = {}) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...args],
    { encoding: "utf8", env: { ...process.env, ...env } });
  run([]);                                                     // record the baseline (same build, all pure)
  fs.copyFileSync(path.join(d, ".candor", "report.json"), bl);
  fs.copyFileSync(path.join(d, ".candor", "report.callgraph.json"), path.join(d, "baseline.callgraph.json"));
  fs.writeFileSync(path.join(d, "src", "app.ts"), gainSrc);    // the regression
  fs.writeFileSync(path.join(d, "typo.pol"), "deny Unknown[nativ] app\n");
  const readDoc = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const ctlP = path.join(d, "ctl.json"), badP = path.join(d, "bad.json"), unreadP = path.join(d, "unread.json");

  // CONTROL — no policy at all. This is the row that establishes the finding EXISTS on this fixture; a
  // regression that silently stopped firing would make every row below pass for the wrong reason.
  const ctl = run(["--gate-json", ctlP], { CANDOR_BASELINE: bl });
  const ctlDoc = readDoc(ctlP);
  check("⟨0.24⟩ precedence CONTROL: the baseline regression alone exits 1 with AS-EFF-005 IN the document",
        ctl.status === 1 && ctlDoc?.ok === false
          && ctlDoc.violations?.filter((v) => v.rule === "AS-EFF-005").length === 2,
        `status=${ctl.status} ${JSON.stringify(ctlDoc)?.slice(0, 240)}`);

  // THE DEFECT — an UNHONOURABLE policy beside it. The violation must still be in the document.
  const bad = run(["--policy", path.join(d, "typo.pol"), "--gate-json", badP], { CANDOR_BASELINE: bl });
  const badDoc = readDoc(badP);
  check("⟨0.24⟩ precedence: an unhonourable policy does NOT delete the certain baseline regression — the AS-EFF-005 violations are IN the document",
        badDoc?.ok === false && Array.isArray(badDoc.violations)
          && badDoc.violations.filter((v) => v.rule === "AS-EFF-005").length === 2
          && badDoc.violations.some((v) => v.fn.endsWith("app.worker")),
        JSON.stringify(badDoc)?.slice(0, 300));
  check("⟨0.24⟩ precedence: …and the refusal rides ALONGSIDE it under `unevaluated`, naming the raw policy line — a consumer of exit 1 can still see the policy never ran",
        badDoc?.unevaluated?.length === 1 && badDoc.unevaluated[0].rule === "deny Unknown[nativ] app"
          && /NOT EVALUATED/.test(badDoc.unevaluated[0].why ?? "") && /nativ/.test(badDoc.unevaluated[0].why ?? ""),
        JSON.stringify(badDoc?.unevaluated)?.slice(0, 300));
  check("⟨0.24⟩ precedence: the certain violation dominates the refusal on the EXIT CODE too (1, not 2)",
        bad.status === 1, `status=${bad.status} ${(bad.stdout + bad.stderr).slice(0, 240)}`);

  // THE SAME MIRROR ON THE OTHER REFUSAL CAUSE — an UNREADABLE policy. Same producer upstream, same rule.
  const unread = run(["--policy", path.join(d, "no-such.pol"), "--gate-json", unreadP], { CANDOR_BASELINE: bl });
  const unreadDoc = readDoc(unreadP);
  check("⟨0.24⟩ precedence MIRROR: an UNREADABLE policy does not delete it either (the rule is over the verdict, not over one refusal cause)",
        unread.status === 1 && unreadDoc?.violations?.filter((v) => v.rule === "AS-EFF-005").length === 2
          && unreadDoc.unevaluated?.length === 1 && /entire policy/.test(unreadDoc.unevaluated[0].rule ?? ""),
        `status=${unread.status} ${JSON.stringify(unreadDoc)?.slice(0, 300)}`);

  // AND THE REFUSAL SHAPE IS INTACT WHERE NOTHING WAS ESTABLISHED — the fix must not turn every refusal
  // into a verdict. Same policy, NO baseline: the document is a refusal, and `violations` is ABSENT (not
  // `[]`, which is precisely the claim a refusing gate cannot make).
  const refP = path.join(d, "ref.json");
  const ref = run(["--policy", path.join(d, "typo.pol"), "--gate-json", refP]);
  const refDoc = readDoc(refP);
  check("⟨0.24⟩ precedence CONTROL 2: with nothing established, the refusal is still a REFUSAL — exit 2, `refused:true`, and NO `violations` key",
        ref.status === 2 && refDoc?.refused === true && refDoc.ok === false && !("violations" in refDoc),
        `status=${ref.status} ${JSON.stringify(refDoc)?.slice(0, 240)}`);
}

// ── ⟨0.28⟩ A CONFIGURED POLICY THAT YIELDS ZERO RULES REFUSES (SPEC §6.2) ──────────────────────────
// MEASURED four-way 2026-08-10: `--policy <a README>` wrote `{"ok":true,"violations":[]}` and exited 0 —
// byte-identical to a gate that ran and found nothing, AND byte-identical to the no-gate-configured
// verdict, so the machine channel cannot tell "your code is clean" from "your gate had no rules". The
// per-line `ignoring policy rule` warnings go to stderr, which is not that channel.
//
// THE ROWS THAT MATTER MOST HERE ARE THE NEGATIVE ONES. candor-rust's first draft of this check read one
// of its three rule vectors and made every allow-only and layer-only policy refuse — `allow Net
// api.stripe.com` is an ordinary allowlist gate, not an absent one. A zero-rule check that inspects a
// SUBSET of the rule kinds is the same false-answer shape this rung exists to close, pointed the other
// way, so the allow-only / forbid-only / pure-only rows below are not padding.
if (blk()) {
  const d = project({ "src/app.ts": 'import fs from "node:fs";\nexport function saveIt(): void { fs.writeFileSync("/tmp/x", "d"); }\n' });
  const W = (n, t) => { const p = path.join(d, n); fs.writeFileSync(p, t); return p; };
  const readme = W("readme.md", "# Project README\n\nThis is documentation, not a policy file.\nSomeone pointed --policy at it by mistake.\n");
  const empty = W("empty.pol", "");
  const comments = W("comments.pol", "# just a comment\n\n# another\n");
  const readDoc = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const run = (args, env = {}) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...args],
    { encoding: "utf8", env: { ...process.env, ...env } });

  for (const [label, pol] of [["a README (every line ignored)", readme], ["an EMPTY file", empty], ["a comments-only file", comments]]) {
    const g = path.join(d, "zr.json");
    if (fs.existsSync(g)) fs.rmSync(g);
    const r = run(["--policy", pol, "--gate-json", g]);
    const doc = readDoc(g);
    check(`⟨0.28⟩ zero-rule policy — ${label} REFUSES: exit 2, \`ok:false\`, \`refused:true\`, and NO \`violations\` key`,
          r.status === 2 && doc?.ok === false && doc.refused === true && !("violations" in doc),
          `status=${r.status} ${JSON.stringify(doc)?.slice(0, 240)}`);
    check(`⟨0.28⟩ …and it names the WHOLE POLICY under \`unevaluated\` — ${label}`,
          doc?.unevaluated?.length === 1 && /^\(entire policy .* — no rules parsed\)$/.test(doc.unevaluated[0].rule ?? ""),
          JSON.stringify(doc?.unevaluated)?.slice(0, 300));
  }

  // THE CONTROL, and it is the row that makes this a rule rather than a blanket: NOT configuring a policy
  // is the honest way to say "I am not gating". An engine that refuses here has broken the no-gate case,
  // which is a worse defect than the one the rung closes.
  const cg = path.join(d, "ctl.json");
  const ctl = run(["--gate-json", cg]);
  const ctlDoc = readDoc(cg);
  check("⟨0.28⟩ zero-rule CONTROL: a run that configured NO policy still exits 0 with an ordinary verdict — the rung must not refuse a run that never asked for a gate",
        ctl.status === 0 && ctlDoc?.ok === true && Array.isArray(ctlDoc.violations) && ctlDoc.violations.length === 0,
        `status=${ctl.status} ${JSON.stringify(ctlDoc)?.slice(0, 240)}`);

  // THE TRAP. Each of these policies has exactly one rule, in a DIFFERENT parser vector, and each is an
  // ordinary gate. Whatever verdict they reach, it must not be a zero-rule refusal.
  for (const [label, text] of [["allow-only (`allow Fs …`, an ordinary allowlist gate)", "allow Fs /tmp/x\n"],
                               ["forbid-only (a layer rule)", "forbid ui -> db\n"],
                               ["pure-only", "pure ZzzNoSuchScope\n"]]) {
    const pol = W(`trap-${label.slice(0, 6).replace(/\W/g, "")}.pol`, text);
    const r = run(["--policy", pol]);
    check(`⟨0.28⟩ zero-rule NEGATIVE: a ${label} policy is a REAL gate and must NOT refuse as ruleless — the check reads EVERY rule vector, not one`,
          r.status !== 2, `status=${r.status} ${(r.stdout + r.stderr).slice(-300)}`);
  }
  const fires = run(["--policy", W("fires.pol", "deny Fs\n")]);
  check("⟨0.28⟩ zero-rule NEGATIVE: a `deny` that FIRES still exits 1", fires.status === 1, `status=${fires.status}`);
  const clean = run(["--policy", W("clean.pol", "deny Net\n")]);
  check("⟨0.28⟩ zero-rule NEGATIVE: a `deny` that does NOT fire still exits 0", clean.status === 0, `status=${clean.status}`);

  // PRECEDENCE — the same rule the two refusal branches above it obey (SPEC §3.1 `4c79958`): a CERTAIN
  // violation dominates. No POLICY violation can exist with zero rules, but an AS-EFF-005 baseline
  // regression is a finding from evidence this run carries, and it must not be deleted by this refusal.
  const bl = path.join(d, "baseline.json");
  const pd = project({ "src/app.ts": "export function worker(): number { return 41 + 1; }\n" });
  spawnSync("node", [path.join(HERE, "scan.mjs"), pd], { encoding: "utf8" });
  fs.copyFileSync(path.join(pd, ".candor", "report.json"), bl);
  fs.copyFileSync(path.join(pd, ".candor", "report.callgraph.json"), path.join(d, "baseline.callgraph.json"));
  fs.writeFileSync(path.join(pd, "src", "app.ts"), 'import fs from "node:fs";\nexport function worker(): number { fs.readFileSync("/tmp/x"); return 41 + 1; }\n');
  const pg = path.join(d, "prec.json");
  const prec = spawnSync("node", [path.join(HERE, "scan.mjs"), pd, "--policy", readme, "--gate-json", pg],
    { encoding: "utf8", env: { ...process.env, CANDOR_BASELINE: bl } });
  const precDoc = readDoc(pg);
  check("⟨0.28⟩ zero-rule PRECEDENCE: a certain AS-EFF-005 regression dominates (exit 1, the violation IN the document) and the refusal rides beside it under `unevaluated`",
        prec.status === 1 && precDoc?.violations?.some((v) => v.rule === "AS-EFF-005")
          && /no rules parsed/.test(precDoc.unevaluated?.[0]?.rule ?? ""),
        `status=${prec.status} ${JSON.stringify(precDoc)?.slice(0, 300)}`);

  // BOTH ROUTES, because §6.2 says a route is not covered by its sibling and §3.1 makes byte-equality
  // between the two gate documents the acceptance test.
  const sJ = path.join(d, "eq.scan.json"), gJ = path.join(d, "eq.gate.json");
  for (const f of [sJ, gJ]) if (fs.existsSync(f)) fs.rmSync(f);
  const es = run(["--policy", comments, "--gate-json", sJ]);
  const eg = gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", comments, "--gate-json", gJ);
  check("⟨0.28⟩ zero-rule on `gate --report` too, and its document is BYTE-EQUAL to the scan route's (same exit)",
        es.status === 2 && eg.status === 2 && fs.existsSync(sJ) && fs.existsSync(gJ)
          && fs.readFileSync(sJ).equals(fs.readFileSync(gJ)),
        `scan=${es.status} gate=${eg.status}\n  scan ${readDoc(sJ) && JSON.stringify(readDoc(sJ)).slice(0, 200)}\n  gate ${readDoc(gJ) && JSON.stringify(readDoc(gJ)).slice(0, 200)}`);
}

// ── ⟨0.24⟩ THE `parsepolicy` `errors` SHAPE, AND ITS COVERAGE (SPEC §3.1 `195d45a` + `901f14d`) ─────
// Two defects on the ONE output whose whole job is to be diffed across four engines.
//
// SHAPE: the pin is `{kind, token, accepted, rule, message}` with `kind` from a CLOSED set and `accepted`
// an ARRAY OF TOKENS. This engine emitted `vocabulary` for `kind`, `where` for `rule`, `accepted` as PROSE
// ("reflect, dispatch, … aliases: dynamic, *, …") and no `message` at all — a prose string is unparseable
// by the consumer the field exists for.
//
// COVERAGE: measured against the reference engine on the conformance battery — java 12 errors, candor-ts
// 4. The eight missing were LINES DROPPED WHOLE (an unknown effect name, an `allow` on an effect that
// takes no operand, two malformed `forbid`s, two `allow`s naming no values, an unknown rule kind), each
// warned on stderr and invisible to the machine output. A dropped rule is the LIMIT CASE of "silently
// rewritten into a different policy": the rewritten policy is the one WITHOUT that line.
if (blk()) {
  const d = project({ "src/a.ts": "export function f(): void {}\n" });
  const battery = [
    "deny Net Db domain",              // honoured — the vacuity guard for the parse itself
    "deny notaneffect",                // DROPPED: names no known effect
    "allow Clock whatever",            // DROPPED: Clock carries no literal surface a value list restricts
    "allow Net in",                    // DROPPED: names no values
    "forbid bad",                      // DROPPED: malformed
    "forbid glued->arrow",             // DROPPED: the arrow must be its own token
    "nonsense line",                   // DROPPED: unknown rule kind
    "deny Fs Unknown[bogus,reflect] io",   // an unrecognised VALUE TOKEN (the pre-existing half)
    "deny Net[bogus,unknown-host] mixed",  // …and on the destination-class vocabulary
  ].join("\n") + "\n";
  const pol = path.join(d, "battery.pol");
  fs.writeFileSync(pol, battery);
  const pp = spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", pol], { encoding: "utf8" });
  const out = (() => { try { return JSON.parse(pp.stdout); } catch { return null; } })();
  const errs = out?.errors ?? [];
  const KINDS = ["reason-class/alias", "Net destination-class", "effect-name", "rule-kind"];
  // The rules themselves are UNCHANGED by the error list — a line with a bad TOKEN is still kept exactly
  // as written (so the four-way deny/allow/forbid comparison stays meaningful), and only the DROPPED forms
  // are absent. Three `deny` lines in, three out; the two `allow`/`forbid` lines are the dropped ones.
  check("⟨0.24⟩ parsepolicy: the WITNESS still does not refuse (exit 0) and its parse is unchanged — token-faulty rules kept, dropped forms absent",
        pp.status === 0 && out?.deny?.length === 3 && out?.allow?.length === 0 && out?.forbid?.length === 0,
        `exit=${pp.status} ${pp.stdout.slice(0, 200)}`);
  check("⟨0.24⟩ parsepolicy `errors` SHAPE: every entry is `{kind, token, accepted, rule, message}` — `kind` from the CLOSED set, `accepted` an ARRAY, and the renamed `vocabulary`/`where` are GONE",
        errs.length > 0 && errs.every((e) =>
          KINDS.includes(e.kind) && typeof e.token === "string" && Array.isArray(e.accepted)
          && typeof e.rule === "string" && typeof e.message === "string"
          && !("vocabulary" in e) && !("where" in e)),
        JSON.stringify(errs.slice(0, 2)));
  check("⟨0.24⟩ parsepolicy `accepted` is a parseable TOKEN LIST, not prose — the reason-class entry names each class as its own element",
        errs.some((e) => e.kind === "reason-class/alias" && e.accepted.includes("reflect")
                      && e.accepted.includes("dynamic") && e.accepted.includes("*")
                      && e.accepted.every((a) => !a.includes(","))),
        JSON.stringify(errs.find((e) => e.kind === "reason-class/alias")));
  // COVERAGE: every line the parse did not honour must appear, keyed by its RAW text.
  const dropped = ["deny notaneffect", "allow Clock whatever", "allow Net in", "forbid bad",
                   "forbid glued->arrow", "nonsense line"];
  const missing = dropped.filter((l) => !errs.some((e) => e.rule === l));
  check("⟨0.24⟩ parsepolicy `errors` covers EVERY LINE NOT HONOURED, not only unrecognised tokens — the six DROPPED lines each appear, naming the raw line",
        missing.length === 0, `missing: ${missing.join(" | ")}  got: ${errs.map((e) => e.rule).join(" | ")}`);
  check("⟨0.24⟩ parsepolicy: …and each dropped line SAYS it was dropped, so a reader can tell 'dropped' from 'rejected'",
        dropped.every((l) => /NOT HONOURED — DROPPED/.test(errs.find((e) => e.rule === l)?.message ?? "")),
        JSON.stringify(errs.filter((e) => dropped.includes(e.rule)).map((e) => e.message)));
  check("⟨0.24⟩ parsepolicy: the two unrecognised VALUE TOKENS are still reported, with their own kinds",
        errs.some((e) => e.kind === "reason-class/alias" && e.token === "bogus")
        && errs.some((e) => e.kind === "Net destination-class" && e.token === "bogus"),
        JSON.stringify(errs.map((e) => `${e.kind}:${e.token}`)));
  // AND THE GATE IS UNMOVED BY THE ADDITION (`195d45a`: "additive to the witness and silent about the
  // gate"). A policy whose ONLY fault is a dropped FORM must not start refusing — that would be a grammar
  // change, and `deny Net Exex app` cannot be told from a legitimate scope by the parser.
  const formOnly = path.join(d, "formonly.pol");
  fs.writeFileSync(formOnly, "deny Net domain\nforbid bad\nnonsense line\n");
  const sf = spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", formOnly], { encoding: "utf8" });
  const ppf = spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", formOnly], { encoding: "utf8" });
  const fErrs = (() => { try { return JSON.parse(ppf.stdout).errors ?? []; } catch { return []; } })();
  check("⟨0.24⟩ parsepolicy CONTROL: a dropped rule FORM is reported by the witness but does NOT make the gate refuse — reporting it needed no grammar decision, refusing would have been one",
        sf.status === 0 && fErrs.length === 2, `scan exit=${sf.status} errors=${fErrs.length}`);
  // …and the CONTROL that keeps the row from passing on a parser that has stopped reporting: a clean
  // policy carries NO `errors` at all, so a good parse stays byte-identical to pre-⟨0.24⟩.
  const clean = path.join(d, "clean.pol");
  fs.writeFileSync(clean, "deny Net domain\nallow Net in api example.com\nforbid a -> b\n");
  const ppc = spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", clean], { encoding: "utf8" });
  const cOut = (() => { try { return JSON.parse(ppc.stdout); } catch { return null; } })();
  check("⟨0.24⟩ parsepolicy CONTROL: a clean policy reports ZERO errors (the field does not fire on well-formed lines)",
        ppc.status === 0 && (cOut?.errors ?? []).length === 0 && cOut?.deny?.length === 1
          && cOut?.allow?.length === 1 && cOut?.forbid?.length === 1,
        JSON.stringify(cOut)?.slice(0, 200));
}

// ── ⟨0.24⟩ A TYPO'D EFFECT NAME DELETED THE RULE, SILENTLY, FOUR-WAY GREEN (SPEC §6.2 `1e1748a`) ────
// Measured on all four engines:
//
//     deny Nett app             ->  rust 0  ts 0  java 0  swift 0    the rule is DELETED, the gate is green
//     allow Nett host.example   ->  rust 0  ts 0  java 0  swift 0    the certification silently vanishes
//
// The operator reads an armed `deny Net` and there is no gate at all. This document already calls a dropped
// rule the LIMIT CASE of silently rewriting the policy — a bigger rewrite than a narrowed filter — yet the
// bigger one was warning-only while the smaller one was exit 2. The grammar defence is real but narrower
// than it was taken to be: `allow`'s effect position is a CLOSED set with no scope reading available, and a
// `deny` whose effect list ends up EMPTY is malformed under either reading. Both are exit 2.
//
// THE ROW THAT MAKES THE OTHERS MEAN SOMETHING is the ambiguous middle: `deny Net Exex app` has a valid
// effect and a trailing token that MIGHT be a scope, so it stays permissive by design. Without it this
// block would pass on an engine that had simply started refusing any unfamiliar token.
if (blk()) {
  const d = project({ "src/a.ts": "export function f(): void {}\n" });
  const rep = path.join(d, ".candor", "report.json");
  spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8" });
  const pol = (name, text) => { const p = path.join(d, name); fs.writeFileSync(p, text); return p; };
  const denyTypo = pol("denytypo.pol", "deny Nett app\n");
  const allowTypo = pol("allowtypo.pol", "allow Nett host.example\n");
  const middle = pol("middle.pol", "deny Net Exex app\n");
  const good = pol("good.pol", "deny Net app\n");
  // The `allow` control runs on the SCAN route only: `gate --report` cannot evaluate an `allow` at all
  // (the AS-EFF-008 surface-completeness marker does not ride the report wire), so it refuses there for a
  // reason that has nothing to do with this rung.
  const goodAllow = pol("goodallow.pol", "allow Fs in app /etc/app\n");
  const scan = (p) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", p], { encoding: "utf8" });
  const gate = (p) => gateCli("--report", rep, "--policy", p);
  const pp = (p) => spawnSync("node", [path.join(HERE, "query.mjs"), "parsepolicy", p], { encoding: "utf8" });
  const sDeny = scan(denyTypo), gDeny = gate(denyTypo);
  check("⟨0.24⟩ effect-name: `deny Nett app` — a `deny` whose effect list is EMPTY after scope-splitting is a POLICY ERROR on BOTH gate routes (exit 2), never a silently deleted rule",
        sDeny.status === 2 && gDeny.status === 2 && /Nett/.test(sDeny.stderr) && /Nett/.test(gDeny.stderr),
        `scan=${sDeny.status} gate=${gDeny.status} ${sDeny.stderr.slice(0, 200)}`);
  const sAllow = scan(allowTypo), gAllow = gate(allowTypo);
  check("⟨0.24⟩ effect-name: `allow Nett host.example` — `allow`'s effect position is a CLOSED set with no scope reading, so the typo is a POLICY ERROR on both routes (exit 2)",
        sAllow.status === 2 && gAllow.status === 2 && /Nett/.test(sAllow.stderr) && /Nett/.test(gAllow.stderr),
        `scan=${sAllow.status} gate=${gAllow.status} ${sAllow.stderr.slice(0, 200)}`);
  const sMid = scan(middle), gMid = gate(middle);
  check("⟨0.24⟩ effect-name CONTROL — the AMBIGUOUS MIDDLE stays permissive by design: `deny Net Exex app` has a valid effect and a trailing token that might be a scope, so it is NOT refused (exit 0)",
        sMid.status === 0 && gMid.status === 0, `scan=${sMid.status} gate=${gMid.status}`);
  const sGood = scan(good), gGood = gate(good), sGoodAllow = scan(goodAllow);
  check("⟨0.24⟩ effect-name CONTROL — correctly spelled `deny Net` / `allow Fs` still evaluate normally (the refusal is not now firing on every policy)",
        sGood.status === 0 && gGood.status === 0 && sGoodAllow.status === 0,
        `scan=${sGood.status} gate=${gGood.status} allow=${sGoodAllow.status} ${sGood.stderr.slice(0, 160)}`);
  // THE WITNESS STILL MUST NOT REFUSE (`6929dce`): making a token a policy error in the PARSER is what
  // took the four-way differential offline once already.
  const both = [pp(denyTypo), pp(allowTypo)];
  check("⟨0.24⟩ effect-name: `parsepolicy` still REPORTS both forms at exit 0 — the enforcer refuses, the witness explains",
        both.every((r) => r.status === 0)
        && both.every((r) => { try { return (JSON.parse(r.stdout).errors ?? []).some((e) => e.kind === "effect-name" && e.token === "Nett"); } catch { return false; } }),
        both.map((r) => `${r.status} ${r.stdout.slice(0, 80)}`).join(" | "));
}

// ── ⟨0.24⟩ `policyVocabulary.aliases` IS THE OBJECT FORM, ON BOTH ROUTES (SPEC §3.1 `b4e9155`) ──────
// A measured three-to-one divergence, KEPT: candor-ts emits `{"corp": ["reflect"]}` where rust, java and
// swift emit `["corp"]`. The clause's written shape is `{"config": "<path>", "aliases": { … }}` — braces —
// and its ARGUMENT settles it one level down: it rejects swift's `configSources: [path]` because a
// disclosure that "names the source but not the content leaves the reader knowing they were affected and
// not how". `aliases: ["corp"]` fails that same sentence — `corp = reflect` and `corp = reflect,native`
// gate differently under one unchanged policy line, so a reader who sees only the NAME cannot tell which
// gate ran. The object is a strict superset (`Object.keys` recovers the array), so nothing is lost.
//
// The pre-existing row pins the SCAN route. This one pins `gate --report`, because §3.1 makes byte-equality
// between the two documents the acceptance test and a shape held on one route only is the divergence this
// field already produced once.
if (blk()) {
  const d = project({ "src/app.ts": "export function dyn(o: any, k: string) { return o[k](); }\n" });
  spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8" });
  const home = path.join(d, "polhome");
  fs.mkdirSync(path.join(home, ".candor"), { recursive: true });
  const cfg = path.join(home, ".candor", "config");
  fs.writeFileSync(cfg, "unknown-alias corp = indirect\n");
  const apol = path.join(home, "a.pol");
  fs.writeFileSync(apol, "deny Unknown[corp] src\n");
  const gj = path.join(d, "vocab.gate.json"), sj = path.join(d, "vocab.scan.json");
  const g = gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", apol, "--gate-json", gj);
  spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--policy", apol, "--gate-json", sj], { encoding: "utf8" });
  const gdoc = (() => { try { return JSON.parse(fs.readFileSync(gj, "utf8")); } catch { return null; } })();
  check("⟨0.24⟩ policyVocabulary: `gate --report` discloses `aliases` as the OBJECT name→classes, not a bare name list — a reader must be able to see WHAT the ambient definition was, not merely that one existed",
        g.status === 1 && gdoc?.policyVocabulary?.config === cfg
          && gdoc.policyVocabulary.aliases && !Array.isArray(gdoc.policyVocabulary.aliases)
          && JSON.stringify(gdoc.policyVocabulary.aliases.corp) === JSON.stringify(["indirect"]),
        `exit=${g.status} ${JSON.stringify(gdoc?.policyVocabulary)}`);
  check("⟨0.24⟩ policyVocabulary: …and the two routes agree BYTE for BYTE on the whole document (§3.1's acceptance test — a shape held on one route only is how this field diverged in the first place)",
        fs.existsSync(sj) && fs.readFileSync(gj).equals(fs.readFileSync(sj)),
        `${fs.existsSync(sj) ? "differ" : "no scan document"}`);
  // AND THE DISCRIMINATING CONTROL: the object must carry the DEFINITION, so a config whose alias resolves
  // to a DIFFERENT class set must produce a different disclosure under the identical policy line. An array
  // of names cannot tell these two apart, which is the whole of the argument above.
  fs.writeFileSync(cfg, "unknown-alias corp = indirect,reflect\n");
  const gj2 = path.join(d, "vocab2.gate.json");
  gateCli("--report", path.join(d, ".candor", "report.json"), "--policy", apol, "--gate-json", gj2);
  const gdoc2 = (() => { try { return JSON.parse(fs.readFileSync(gj2, "utf8")); } catch { return null; } })();
  check("⟨0.24⟩ policyVocabulary CONTROL: a config that resolves the SAME alias to a DIFFERENT class set produces a DIFFERENT disclosure under an unchanged policy line — the array form cannot express this, which is why the object stands",
        JSON.stringify(gdoc2?.policyVocabulary?.aliases?.corp) === JSON.stringify(["indirect", "reflect"])
          && JSON.stringify(gdoc2?.policyVocabulary?.aliases) !== JSON.stringify(gdoc?.policyVocabulary?.aliases),
        JSON.stringify(gdoc2?.policyVocabulary));
}

// ── ⟨0.24⟩ THE ADVISORY VERBS AND THE RULE'S `Unknown[…]`/`Net[…]` CLASS FILTER (SPEC §6.2) ─────────
// `gate --report` reads a rule's narrowing filter; `fix-gate` and `unverified` computed from the EFFECT
// SET ALONE, so over a report whose only hole is a class the policy EXCLUDES the three verbs disagreed:
//
//   gate --report        exit 0, no violations          <- correct, the class is excluded
//   fix-gate --strict    exit 1 + a remedy naming it    <- OVER-CHARGE: a red CI check and a hoist
//                                                          instruction for a boundary nothing denies
//   unverified --strict  exit 0, ok:true, []            <- UNDER-REPORT, and the worse half
//
// The under-report is the half that matters: the layer PASSES while carrying an Unknown, so it IS a
// pass-but-Unknown hole — and `unverified`, the verb whose entire job is "your green gate is not provably
// green", certified it clean. Both halves are fixed in one change; closing only the over-charge would kill
// a fabrication and leave its silent mirror standing.
//
// EVERY ARM CARRIES ITS MIRROR. A filter can only NARROW what a verb reports, so the regression to guard
// is LOST DISCLOSURE: each excluded-class row is paired with a row whose policy classes DO match, asserted
// still named — and with the BARE (unfiltered) rule, which must be untouched.
if (blk()) {
  const d = scratch("candor-classfilter-");
  const rep = (fns) => JSON.stringify({ candor: { version: "ttttttt", spec: "0.23" }, functions: fns });
  const W = (n, o) => fs.writeFileSync(path.join(d, n), typeof o === "string" ? o : JSON.stringify(o));
  const pol = (n, text) => { W(n, text); return path.join(d, n); };
  const J = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  // (A) THE UNKNOWN HALF. One function, one hole, class `native` — under a policy that denies `Unknown`
  // narrowed to `reflect,unresolved`, i.e. every class BUT this one.
  W("u.json", rep([{ fn: "app.loader", inferred: ["Unknown"], direct: ["Unknown"],
                     unknownWhy: ["native:dlopen"], calls: [], loc: "a.ts:1" }]));
  W("u.callgraph.json", { "app.loader": [] });
  const U = path.join(d, "u");
  const pExcl = pol("u-excl.policy", "deny Unknown[reflect,unresolved] app\n");  // excludes `native`
  const pMatch = pol("u-match.policy", "deny Unknown[native] app\n");            // MATCHES `native`
  const pBare = pol("u-bare.policy", "deny Unknown app\n");                      // no filter at all
  const gate = (P) => runQuery("gate", "--report", U, "--policy", P);
  const fg = (P) => { const r = runQuery("fix-gate", "--report", U, "--policy", P, "--strict"); return { s: r.status, j: J(r) }; };
  const uv = (P) => { const r = runQuery("unverified", "--report", U, "--policy", P, "--strict"); return { s: r.status, j: J(r) }; };

  // The GATE is the oracle every other row is measured against — it was always right, which is what makes
  // the other two verbs' disagreement a defect rather than a policy question.
  check("⟨0.24⟩ class filter: the GATE excludes the unmatched class (exit 0) and FIRES on the matching one (exit 1) — the oracle",
        gate(pExcl).status === 0 && gate(pMatch).status === 1 && gate(pBare).status === 1,
        `excl=${gate(pExcl).status} match=${gate(pMatch).status} bare=${gate(pBare).status}`);
  // THE OVER-CHARGE, closed: no remedy for a boundary the policy does not deny.
  const fgExcl = fg(pExcl);
  check("⟨0.24⟩ fix-gate reads the rule's `Unknown[…]` filter: no remedy, ok:true, exit 0 for a class the policy EXCLUDES",
        fgExcl.s === 0 && fgExcl.j?.ok === true && fgExcl.j?.remedies.length === 0, JSON.stringify(fgExcl));
  // …and its MIRROR: the remedy is NOT lost where the classes DO meet, nor under the bare rule.
  const fgMatch = fg(pMatch), fgBare = fg(pBare);
  check("⟨0.24⟩ fix-gate MIRROR — the remedy SURVIVES when the policy's class matches, and under the bare rule (the filter narrows, it does not disable)",
        fgMatch.s === 1 && fgMatch.j?.remedies?.[0]?.fn === "app.loader" && fgMatch.j.remedies[0].effect === "Unknown"
          && fgBare.s === 1 && fgBare.j?.remedies?.[0]?.fn === "app.loader",
        `match=${JSON.stringify(fgMatch)} bare=${JSON.stringify(fgBare)}`);
  // THE UNDER-REPORT, closed — the half that matters. The layer PASSES the gate while carrying an Unknown.
  const uvExcl = uv(pExcl);
  check("⟨0.24⟩ unverified reads the rule's `Unknown[…]` filter: the PASS-but-Unknown hole is NAMED (ok:false, exit 1) where the gate is green — the false all-clear this verb exists to prevent",
        uvExcl.s === 1 && uvExcl.j?.ok === false && uvExcl.j?.unverified?.[0]?.fn === "app.loader",
        JSON.stringify(uvExcl));
  // …and its MIRROR: where the rule really DOES fire, the function is a VIOLATION (the gate's job), never
  // double-reported here. This is the row that fails if the filter is applied in the wrong direction.
  const uvMatch = uv(pMatch), uvBare = uv(pBare);
  check("⟨0.24⟩ unverified MIRROR — a function the gate REPORTS is not also an unverified hole (ok:true), under the matching filter AND the bare rule",
        uvMatch.s === 0 && uvMatch.j?.unverified.length === 0 && uvBare.s === 0 && uvBare.j?.unverified.length === 0,
        `match=${JSON.stringify(uvMatch)} bare=${JSON.stringify(uvBare)}`);

  // (B) THE `Net[…]` SIBLING, same shape: a function reaching only a `known-partner` destination, under
  // `deny Net[unknown-host]`. The report CARRIES `netClass`, so the class is taken verbatim off the wire.
  W("n.json", rep([{ fn: "app.send", inferred: ["Net", "Unknown"], direct: ["Net", "Unknown"],
                     hosts: ["api.partner.example"], netClass: ["known-partner"],
                     unknownWhy: ["native:dlopen"], calls: [], loc: "n.ts:1" }]));
  W("n.callgraph.json", { "app.send": [] });
  const N = path.join(d, "n");
  const nExcl = pol("n-excl.policy", "deny Net[unknown-host] app\n");
  const nMatch = pol("n-match.policy", "deny Net[known-partner] app\n");
  const nfg = (P) => { const r = runQuery("fix-gate", "--report", N, "--policy", P, "--strict"); return { s: r.status, j: J(r) }; };
  const nuv = (P) => { const r = runQuery("unverified", "--report", N, "--policy", P, "--strict"); return { s: r.status, j: J(r) }; };
  const nfgE = nfg(nExcl), nfgM = nfg(nMatch), nuvE = nuv(nExcl), nuvM = nuv(nMatch);
  check("⟨0.24⟩ class filter, `Net[…]` sibling: fix-gate charges NO remedy for a destination class the policy excludes — and STILL charges one when it matches",
        nfgE.s === 0 && nfgE.j?.remedies.length === 0 && nfgM.s === 1 && nfgM.j?.remedies?.[0]?.effect === "Net",
        `excl=${JSON.stringify(nfgE)} match=${JSON.stringify(nfgM)}`);
  check("⟨0.24⟩ class filter, `Net[…]` sibling: unverified NAMES the pass-but-Unknown hole under the excluded class, and does NOT under the matching one",
        nuvE.s === 1 && nuvE.j?.unverified?.[0]?.fn === "app.send" && nuvM.s === 0 && nuvM.j?.unverified.length === 0,
        `excl=${JSON.stringify(nuvE)} match=${JSON.stringify(nuvM)}`);

  // (C) THE HAZARD THE FIX CREATED, which is the fourth time on this rung: making the predicate
  // filter-aware is exactly what first lets a NARROWED rule BE the rule a hole is disclosed under, and the
  // reconstruction dropped the bracket. It printed the operator's narrowed line back as the WIDE one and
  // advised the nonsense `deny Unknown Unknown app`; on the Net sibling it advised `deny Net Unknown app`,
  // SILENTLY UN-NARROWING a rule scoped to one destination class — an instruction that reddens a gate on
  // traffic the operator had accepted. Dormant until the fix reached it.
  check("⟨0.24⟩ the disclosed rule keeps its BRACKET — the operator's narrowed line is not printed back as the wide one",
        uvExcl.j?.unverified?.[0]?.rule === "deny Unknown[reflect,unresolved] app"
          && nuvE.j?.unverified?.[0]?.rule === "deny Net[unknown-host] app",
        `unknown=${uvExcl.j?.unverified?.[0]?.rule} net=${nuvE.j?.unverified?.[0]?.rule}`);
  check("⟨0.24⟩ the UPGRADE widens a narrowed `Unknown` rather than appending a second one, and never un-narrows a `Net[…]` the operator scoped",
        uvExcl.j?.unverified?.[0]?.upgrade === "deny Unknown app"
          && nuvE.j?.unverified?.[0]?.upgrade === "deny Net[unknown-host] Unknown app",
        `unknown=${uvExcl.j?.unverified?.[0]?.upgrade} net=${nuvE.j?.unverified?.[0]?.upgrade}`);
  // …and the CONTROL that keeps conformance PARTs 12c/12d unmoved: a rule with NO filter renders exactly
  // as it always did, `pure` branch and multi-effect `deny` branch alike.
  const pPure = pol("p.policy", "pure app\n");
  const pMulti = pol("m.policy", "deny Db Net app\n");
  W("p.json", rep([{ fn: "app.leaf", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["dispatch:x"], calls: [], loc: "p.ts:1" }]));
  W("p.callgraph.json", { "app.leaf": [] });
  const pj = (P) => J(runQuery("unverified", "--report", path.join(d, "p"), "--policy", P));
  check("⟨0.24⟩ CONTROL: an UNFILTERED rule renders byte-identically to before — `pure app` → `deny Unknown app`, `deny Db Net app` → `deny Db Net Unknown app` (conformance 12c/12d unmoved)",
        pj(pPure)?.unverified?.[0]?.rule === "pure app" && pj(pPure)?.unverified?.[0]?.upgrade === "deny Unknown app"
          && pj(pMulti)?.unverified?.[0]?.rule === "deny Db Net app"
          && pj(pMulti)?.unverified?.[0]?.upgrade === "deny Db Net Unknown app",
        `pure=${JSON.stringify(pj(pPure)?.unverified?.[0])} multi=${JSON.stringify(pj(pMulti)?.unverified?.[0])}`);

  // (D) THE OTHER CHANNEL. The scan-time gate note is a SECOND copy of the `unverified` disclosure and it
  // shares the predicate, so the filter has to reach it too — a verb with two channels needs the claim
  // withdrawn from both, and a test that reads one channel is evidence about one channel. Note the
  // DIRECTION: a hole is a function that PASSES its rule while Unknown, so it is the EXCLUDING policy that
  // must produce the note (the gate is green there and the note is the only thing saying why that green is
  // not proof), and the MATCHING one that must not (there it is a violation, and the gate reports it).
  // `callback:param#0` classifies `indirect`, verified against the emitted report rather than assumed.
  const sd = project({
    "src/app.ts": `export function loader(go: () => void): void { go(); }\n`,
    "excl.policy": "deny Unknown[reflect] app\n",       // excludes `indirect` → PASSES → note
    "match.policy": "deny Unknown[indirect] app\n",     // matches → a VIOLATION → no note
    "pure.policy": "pure app\n",                        // unfiltered control → note, unchanged
  });
  const scanOf = (p) => runScan(sd, "--policy", path.join(sd, p));
  const NOTE = /PASS the policy but are Unknown/;
  const sExcl = scanOf("excl.policy"), sMatch = scanOf("match.policy"), sPure = scanOf("pure.policy");
  check("⟨0.24⟩ the SCAN-TIME gate note reads the filter too — the green gate over an EXCLUDED class now carries the note that says why that green is not proof (it was silent, matching the CLI's under-report)",
        sExcl.status === 0 && NOTE.test(sExcl.stderr),
        `status=${sExcl.status} ${JSON.stringify(sExcl.stderr.slice(0, 240))}`);
  check("⟨0.24⟩ …and its MIRROR on the same channel: where the class MATCHES it is a violation the gate reports (exit 1) and the note must NOT double-report it; the unfiltered `pure app` control still discloses",
        sMatch.status === 1 && !NOTE.test(sMatch.stderr) && sPure.status === 0 && NOTE.test(sPure.stderr),
        `match=${sMatch.status}/${JSON.stringify(sMatch.stderr.slice(0, 160))} pure=${sPure.status}/${NOTE.test(sPure.stderr)}`);

  // (E) THE `Net[…]` AXIS OF THE SAME CHANNEL, which nothing above reaches. (B) covers the destination-class
  // filter on the REPORT route, where `netClass` arrives on the wire; (D) covers the scan route on the
  // REASON-class axis. The scan route's Net half is the one the two cannot compose to, and it is the one
  // that needs real DATA THREADED rather than a conjunct added: a destination class is NOT derivable from
  // the fields a hole record carries — it needs the host surface, the masked-surface flag AND the config
  // `net-partner` list, none of which travels on the wire. So the scan-time context is built from the run's
  // LIVE evidence, and this row is what says that threading actually happened.
  //
  // MEASURED on the pre-fix build over these bytes: NO note under EITHER policy — the same silent
  // under-report as the CLI's, on the channel a scan operator actually reads. `api.acme.example` classifies
  // `known-partner` ONLY because `.candor/config` says so, which is exactly the evidence a consumer-side
  // re-derivation would lose, so the row would also catch a fix that re-derived instead of threading.
  const nd = project({
    "src/app.ts": "export async function send(go: () => void): Promise<void> {\n"
                + "  await fetch(\"https://api.acme.example/v1/x\");\n  go();\n}\n",
    ".candor/config": "net-partner acme.example\n",
    "excl.policy": "deny Net[unknown-host] app\n",      // excludes `known-partner` → PASSES → note
    "match.policy": "deny Net[known-partner] app\n",    // matches → a VIOLATION → no note
  });
  const nExclR = runScan(nd, "--policy", path.join(nd, "excl.policy"));
  const nMatchR = runScan(nd, "--policy", path.join(nd, "match.policy"));
  check("⟨0.24⟩ the scan-time note reads the `Net[…]` DESTINATION-class filter too, off the run's own live evidence: a config-declared partner host PASSES `deny Net[unknown-host]` (exit 0) and the note names the pass-but-Unknown hole",
        nExclR.status === 0 && NOTE.test(nExclR.stderr) && /deny Net\[unknown-host\] Unknown app/.test(nExclR.stderr),
        `status=${nExclR.status} ${JSON.stringify(nExclR.stderr.slice(0, 300))}`);
  // The violation RECORD rides stdout and the advisory note rides stderr, so the mirror reads BOTH streams:
  // asserting only "no note" would be satisfied by a run that also lost the violation.
  check("⟨0.24⟩ …and its MIRROR: under the MATCHING destination class the same function is a violation the gate REPORTS (exit 1, an AS-EFF-006 record naming the narrowed rule), with no note double-reporting it — the row that fails if the filter is applied in the wrong direction",
        nMatchR.status === 1 && !NOTE.test(nMatchR.stderr)
          && /\[AS-EFF-006\][^\n]*deny Net\[known-partner\] app/.test(nMatchR.stdout),
        `status=${nMatchR.status} out=${JSON.stringify(nMatchR.stdout.slice(-200))} err=${JSON.stringify(nMatchR.stderr.slice(0, 200))}`);
  fs.rmSync(nd, { recursive: true, force: true });
  fs.rmSync(sd, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.24⟩ THE OMIT-`ok` RULE, ON EVERY ADVISORY VERB THAT ANSWERS `ok` (SPEC §3.2) ─────────────────
// `gate --report` has refused to read green over a declared `unanalyzed` manifest since ⟨0.21⟩.
// `unverified`, `fix-gate` and `whatif` read the SAME bytes and answered `ok: true` with an empty array,
// exit 0, no disclosure on any channel — and `--strict` is how CI consumes the first two.
//
//   gate --report        exit 2, incomplete, manifest        <- correct
//   unverified --strict  exit 0, ok:true, no disclosure
//   fix-gate  --strict   exit 0, ok:true, no disclosure
//
// `unverified` is the sharpest case in the family: the verb that exists to say "your green gate is not
// provably green", certifying a set it knows it cannot see all of. A function in an unparsed file is
// ABSENT from `functions`, so it cannot be enumerated as an unverified pass at all — and that absence is
// exactly what the verb would have to report.
//
// NEITHER BOOLEAN IS HONEST, so the field goes: `true` asserts a claim the input does not license, and
// `false` would assert "a hole exists, here it is" beside an EMPTY array — the fabrication mirror. The
// assertions below check ABSENCE (`"ok" in j`), never falsiness: `ok:false` would satisfy a `!j.ok` test
// while being the invention the rule exists to forbid.
if (blk()) {
  const d = scratch("candor-advisory-inc-");
  const W = (n, o) => fs.writeFileSync(path.join(d, n), typeof o === "string" ? o : JSON.stringify(o));
  const J = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const env = (extra) => ({ candor: { version: "ttttttt", spec: "0.23" }, ...extra,
    functions: [{ fn: "app.svc", inferred: ["Unknown"], direct: ["Unknown"],
                  unknownWhy: ["dispatch:x"], calls: [], loc: "s.ts:1" }] });
  const MANIFEST = [{ path: "src/broken.ts", reason: "source failed to parse" }];
  W("inc.json", env({ unanalyzed: MANIFEST }));           // declares one unit it could not analyze
  W("cmp.json", env({}));                                  // the SAME report, complete — the mirror
  W("inc.callgraph.json", { "app.svc": [] });
  W("cmp.callgraph.json", { "app.svc": [] });
  W("p.policy", "deny Net app\n");
  const POL = path.join(d, "p.policy");
  const run = (verb, pfx, ...extra) => {
    const r = runQuery(verb, "--report", path.join(d, pfx), "--policy", POL, ...extra);
    return { s: r.status, j: J(r), err: r.stderr };
  };

  // THE ORACLE: the gate over the identical manifest. Every row below is measured against it.
  const g = runQuery("gate", "--report", path.join(d, "inc"), "--policy", POL, "--json");
  check("⟨0.24⟩ advisory `ok`: the ORACLE — `gate --report` over the same bytes exits 2, incomplete, with the manifest",
        g.status === 2 && J(g)?.incomplete === true && J(g)?.unanalyzed?.[0]?.path === "src/broken.ts",
        `status=${g.status} ${g.stdout.slice(0, 200)}`);

  const uInc = run("unverified", "inc", "--strict"), fInc = run("fix-gate", "inc", "--strict");
  check("⟨0.24⟩ `unverified --strict` over an incomplete report OMITS `ok`, emits incomplete+manifest, exits 2 — the verb whose job is 'your green gate is not provably green' had been certifying it",
        uInc.s === 2 && !("ok" in (uInc.j ?? { ok: 1 })) && uInc.j?.incomplete === true
          && uInc.j?.unanalyzed?.[0]?.path === "src/broken.ts" && Array.isArray(uInc.j?.unverified),
        `status=${uInc.s} ${JSON.stringify(uInc.j)}`);
  check("⟨0.24⟩ `fix-gate --strict` over an incomplete report does the same (the rule binds every advisory sibling, not the verb its defect was found in)",
        fInc.s === 2 && !("ok" in (fInc.j ?? { ok: 1 })) && fInc.j?.incomplete === true
          && fInc.j?.unanalyzed?.[0]?.reason === "source failed to parse" && Array.isArray(fInc.j?.remedies),
        `status=${fInc.s} ${JSON.stringify(fInc.j)}`);
  // `whatif` is where the rule was first ruled (`0075987`) and it was never implemented here either. Its
  // ARRAYS still ship — a partial answer that says it is partial beats a refusal, and `whatif` is consulted
  // BEFORE an edit, where the alternative is the operator guessing.
  const w = runQuery("whatif", "--report", path.join(d, "inc"), "--policy", POL, "app.svc", "Net");
  const wj = J(w);
  check("⟨0.24⟩ `whatif` over an incomplete report OMITS `ok` too, and its `affected`/`violations` arrays still ship",
        !("ok" in (wj ?? { ok: 1 })) && wj?.incomplete === true && Array.isArray(wj?.affected)
          && Array.isArray(wj?.violations) && wj?.unanalyzed?.length === 1,
        `status=${w.status} ${JSON.stringify(wj)}`);

  // THE MIRROR, and the one that guards against the fix eating the ordinary case: a COMPLETE report is
  // UNCHANGED, byte for byte — `ok` present, `--strict` exit follows it, no `incomplete`/`unanalyzed` key.
  const uCmp = run("unverified", "cmp", "--strict"), fCmp = run("fix-gate", "cmp", "--strict");
  const wCmp = J(runQuery("whatif", "--report", path.join(d, "cmp"), "--policy", POL, "app.svc", "Net"));
  check("⟨0.24⟩ MIRROR — a COMPLETE report still carries `ok` on all three verbs, with no `incomplete`/`unanalyzed` key (a pre-⟨0.24⟩ consumer's document is untouched)",
        "ok" in (uCmp.j ?? {}) && uCmp.j.incomplete === undefined && uCmp.j.unanalyzed === undefined
          && "ok" in (fCmp.j ?? {}) && fCmp.j.incomplete === undefined
          && "ok" in (wCmp ?? {}) && wCmp.incomplete === undefined,
        `uv=${JSON.stringify(uCmp.j)} fg=${JSON.stringify(fCmp.j)} whatif=${JSON.stringify(wCmp)}`);
  check("⟨0.24⟩ MIRROR — and on the complete report `--strict` still follows `ok` (exit 1 on a finding, 0 on none): the incompleteness arm did not swallow the ordinary exit contract",
        uCmp.s === 1 && uCmp.j.ok === false && uCmp.j.unverified.length === 1 && fCmp.s === 0 && fCmp.j.ok === true,
        `uv=${uCmp.s}/${JSON.stringify(uCmp.j)} fg=${fCmp.s}/${JSON.stringify(fCmp.j)}`);
  // ADVISORY BY DEFAULT is preserved: without `--strict` these verbs still exit 0 (the agent fix-loop reads
  // the body). The DOCUMENT still discloses — the exit code is not the disclosure.
  const uAdv = run("unverified", "inc"), fAdv = run("fix-gate", "inc");
  check("⟨0.24⟩ without `--strict` the advisory verbs still exit 0 over an incomplete report — and the document still discloses (the exit code was never the disclosure)",
        uAdv.s === 0 && uAdv.j?.incomplete === true && fAdv.s === 0 && fAdv.j?.incomplete === true,
        `uv=${uAdv.s} fg=${fAdv.s}`);

  // THE OTHER CHANNEL — the half a suite cannot see by construction. candor-rust built a mutant that kept
  // the whole JSON fix and deleted only the printed line, and it SURVIVED that engine's entire suite,
  // because absence-asserts on `ok` cannot see stderr. A verb with two output channels needs the claim
  // withdrawn from BOTH, so the printed withdrawal is asserted here as its own row.
  check("⟨0.24⟩ THE OTHER CHANNEL: the printed line withdraws the claim too, names the count and the unit, and says `ok` was omitted — a test that reads one channel is evidence about one channel",
        /could NOT fully evaluate/.test(uInc.err) && /src\/broken\.ts/.test(uInc.err) && /`ok` is OMITTED/.test(uInc.err)
          && /could NOT fully evaluate/.test(fInc.err) && /src\/broken\.ts/.test(fInc.err),
        `uv=${JSON.stringify(uInc.err.slice(0, 300))} fg=${JSON.stringify(fInc.err.slice(0, 200))}`);
  check("⟨0.24⟩ …and its MIRROR on that channel: a COMPLETE report prints no withdrawal (the note fires on the condition, not on every run)",
        !/could NOT fully evaluate/.test(uCmp.err) && !/could NOT fully evaluate/.test(fCmp.err),
        `uv=${JSON.stringify(uCmp.err.slice(0, 200))}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.24⟩ AN ADVISORY VERB MAY BE LESS CERTAIN THAN THE GATE, NEVER MORE (SPEC §3.2 `4fd140c`) ─────
// THE GENERAL LAW behind the omit-`ok` block above, and this is its third instance — the one that forced
// the law to be stated rather than patched a third time. Over a report carrying `hosts` but NO `netClass`,
// under `deny Net[unknown-host] app`, MEASURED on this engine before the change:
//
//   gate --report   exit 2   §3.1 answerability refusal — it CANNOT judge `app.noClass`
//   unverified      exit 0   CLEARS `app.noClass` and names a DIFFERENT hole instead
//   fix-gate        exit 0   a full hoist plan for `app.noClass`, computed from the DERIVED class
//   fix … Net       exit 0   `crossing:false, reason:"not-forbidden"` — the same guess, asserted
//
// The advisory verbs answered from a FALLBACK DERIVATION: `netClassesOf` floors an absent surface at
// `unknown-host`, so the class the gate declined to invent was invented one call away. The code documented
// that as intentional — "no refusal channel, so a hedge beats a hole" — and the first half is true. A hedge
// does beat a hole. But a DERIVATION is not a hedge; it is a SECOND OPINION, and it is the one opinion an
// advisory verb is not entitled to.
//
// THE ASSERTIONS ARE PER FUNCTION, and that is not a stylistic choice. A weaker form of this row — "the
// gate withheld, so the verb names SOMETHING" — PASSED on all four engines while the defect stood, because
// `unverified` names a different hole (`app.nativeHole`, which the same policy makes a provable-purity
// hole). The fixture below carries that decoy deliberately: a test that only counts entries cannot see this
// defect at all.
//
// THE MIRROR IS THE OVER-REPORT, and it is the risk this change actually runs: a function the gate CAN
// clear must not start being named, and a remedy for a CERTAIN crossing must still be offered. Four mirror
// rows below — netClass carried and firing, netClass carried and excluded, the BARE `deny Net` over the
// same evidence-less report (no narrowing ⇒ nothing to refuse), and the `Unknown[…]` hole that must still
// be found.
if (blk()) {
  const d = scratch("candor-advisory-bound-");
  const W = (n, o) => fs.writeFileSync(path.join(d, n), typeof o === "string" ? o : JSON.stringify(o));
  const J = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  // The conformance R11 report, verbatim in shape: (a) a decoy Unknown hole the policy's class filter
  // EXCLUDES, (b) the Net entry with hosts and no `netClass` — the one the gate cannot judge, (c) a plain
  // violator so the gate has something certain to charge.
  W("r.json", { candor: { version: "ttttttt", spec: "0.23" }, package: "app",
                analyzed: { count: 3, digest: "0" },
                functions: [
                  { fn: "app.nativeHole", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["native:dlopen"] },
                  { fn: "app.noClass", inferred: ["Net"], direct: ["Net"], hosts: ["api.example.com"] },
                  { fn: "app.writes", inferred: ["Fs"], direct: ["Fs"], paths: ["/etc/hosts"] }] });
  W("r.callgraph.json", { "app.nativeHole": [], "app.noClass": [], "app.writes": [] });
  // The MIRROR report: the same two Net shapes with the evidence PRESENT — one class the rule names, one it
  // excludes. Nothing here is unanswerable, so nothing here may change.
  W("m.json", { candor: { version: "ttttttt", spec: "0.23" }, package: "app",
                analyzed: { count: 2, digest: "0" },
                functions: [
                  { fn: "app.hasClass", inferred: ["Net"], direct: ["Net"], hosts: ["api.example.com"], netClass: ["unknown-host"] },
                  { fn: "app.partner", inferred: ["Net"], direct: ["Net"], hosts: ["p.example.com"], netClass: ["known-partner"] }] });
  W("m.callgraph.json", { "app.hasClass": [], "app.partner": [] });
  W("net.policy", "deny Net[unknown-host] app\n");
  W("bare.policy", "deny Net app\n");
  W("unk.policy", "deny Unknown[reflect,unresolved] app\n");
  const P = (n) => path.join(d, n);
  const run = (verb, rep, pol, ...extra) => {
    const r = runQuery(verb, "--report", P(rep), "--policy", P(pol), ...extra);
    return { s: r.status, j: J(r), err: r.stderr };
  };
  const named = (j) => new Set((j?.unverified ?? []).map((h) => h.fn));

  // THE ORACLE: the gate over the identical bytes. Every row below is a comparison against it, because the
  // invariant is a COMPARISON — the advisory verb's confidence bounded above by the gate's — not a shape.
  const gN = runQuery("gate", "--report", P("r"), "--policy", P("net.policy"), "--json");
  check("⟨0.24⟩ advisory-bound: the ORACLE — `gate --report` REFUSES over `hosts` with no `netClass`, exit 2, naming `app.noClass` as the entry it could not judge",
        gN.status === 2 && J(gN)?.refused === true && !("violations" in (J(gN) ?? {}))
          && /app\.noClass/.test(J(gN)?.unevaluated?.[0]?.why ?? ""),
        `status=${gN.status} ${gN.stdout.slice(0, 300)}`);

  const uRef = run("unverified", "r", "net.policy", "--strict");
  check("⟨0.24⟩ advisory-bound: `unverified` NAMES the function the gate could not judge — per FUNCTION, because it also names a DIFFERENT hole and a bare non-empty check passes on that alone",
        named(uRef.j).has("app.noClass") && named(uRef.j).has("app.nativeHole"),
        `named=${[...named(uRef.j)]} ${JSON.stringify(uRef.j)}`);
  check("⟨0.24⟩ advisory-bound: …and the recorded reason is THE MISSING EVIDENCE, never the derived class — recording the derivation would restate the defect as a disclosure",
        (() => { const h = (uRef.j?.unverified ?? []).find((x) => x.fn === "app.noClass");
                 return h && /no `netClass` in this report/.test(h.why ?? "") && !("upgrade" in h)
                        && !/unknown-host"|netClass":/.test(JSON.stringify(h).replace(/why":"[^"]*"/, "")); })(),
        JSON.stringify((uRef.j?.unverified ?? []).find((x) => x.fn === "app.noClass")));
  check("⟨0.24⟩ advisory-bound: `unverified` carries the GATE'S OWN `unevaluated:[{rule,why}]` shape (§3.1) rather than a second spelling, OMITS `ok`, and `--strict` exits 2 — matching the gate",
        uRef.s === 2 && !("ok" in (uRef.j ?? { ok: 1 }))
          && uRef.j?.unevaluated?.length === 1 && uRef.j.unevaluated[0].rule === "deny Net[unknown-host] app"
          && typeof uRef.j.unevaluated[0].why === "string",
        `status=${uRef.s} ${JSON.stringify(uRef.j)}`);

  const fRef = run("fix-gate", "r", "net.policy", "--strict");
  check("⟨0.24⟩ advisory-bound: `fix-gate` offers NO remedy premised on evidence the gate refused to read — a hoist plan for a boundary the gate could not adjudicate is a confident instruction resting on a guess",
        (fRef.j?.remedies ?? []).every((p) => p.fn !== "app.noClass"),
        JSON.stringify(fRef.j));
  check("⟨0.24⟩ advisory-bound: …and dropping the plan is NOT the whole fix — `fix-gate` discloses `unevaluated`, omits `ok`, and `--strict` exits 2, else a fabricated instruction is traded for a false all-clear",
        fRef.s === 2 && !("ok" in (fRef.j ?? { ok: 1 })) && fRef.j?.unevaluated?.length === 1
          && Array.isArray(fRef.j?.remedies),
        `status=${fRef.s} ${JSON.stringify(fRef.j)}`);

  // `fix` is the SINGLE-FUNCTION sibling — the one the LSP code action and the MCP tool run. Its refusal
  // takes the gate's document shape: NO `crossing` key at all, because `crossing:false` reads as "nothing
  // forbids this here", which is precisely the claim it cannot make.
  const one = runQuery("fix", "app.noClass", "Net", "--report", P("r"), "--policy", P("net.policy"));
  const oj = J(one);
  check("⟨0.24⟩ advisory-bound: `fix` REFUSES rather than answering `crossing:false, reason:\"not-forbidden\"` — an ABSENT key, not a false one, because 'no boundary fix needed' is a claim",
        oj?.refused === true && !("crossing" in (oj ?? {})) && oj?.unevaluated?.length === 1
          && oj?.fn === "app.noClass",
        JSON.stringify(oj));

  // THE OTHER CHANNEL. candor-rust built a mutant that kept the whole JSON fix and deleted only the printed
  // line, and it survived that engine's entire suite.
  check("⟨0.24⟩ advisory-bound, THE OTHER CHANNEL: the printed line withdraws the claim on all three verbs, quotes the rule, and says why — a test that reads one channel is evidence about one channel",
        /could NOT fully evaluate/.test(uRef.err) && /no `netClass` in this report/.test(uRef.err)
          && /could NOT fully evaluate/.test(fRef.err) && /never MORE/.test(fRef.err)
          && /could NOT fully evaluate/.test(one.stderr) && /refused: true/.test(one.stderr),
        `uv=${JSON.stringify(uRef.err.slice(0, 200))} fg=${JSON.stringify(fRef.err.slice(0, 120))} fix=${JSON.stringify(one.stderr.slice(0, 120))}`);

  // ── THE MIRRORS: a function the gate CAN clear must not start being named ────────────────────────────
  const gM = runQuery("gate", "--report", P("m"), "--policy", P("net.policy"), "--json");
  const uM = run("unverified", "m", "net.policy", "--strict"), fM = run("fix-gate", "m", "net.policy", "--strict");
  check("⟨0.24⟩ advisory-bound MIRROR — with `netClass` ON THE WIRE the gate JUDGES (exit 1 on `app.hasClass`), so nothing is refused: `ok` is present on both verbs and no `unevaluated` key appears",
        gM.status === 1 && "ok" in (uM.j ?? {}) && "ok" in (fM.j ?? {})
          && uM.j.unevaluated === undefined && fM.j.unevaluated === undefined,
        `gate=${gM.status} uv=${JSON.stringify(uM.j)} fg=${JSON.stringify(fM.j)}`);
  check("⟨0.24⟩ advisory-bound MIRROR — and the CERTAIN crossing still gets its remedy: `fix-gate` names `app.hasClass`, `--strict` exits 1, and `app.partner` (a class the rule EXCLUDES) is still silent",
        fM.s === 1 && (fM.j?.remedies ?? []).some((p) => p.fn === "app.hasClass")
          && (fM.j?.remedies ?? []).every((p) => p.fn !== "app.partner") && !named(uM.j).has("app.partner"),
        `status=${fM.s} ${JSON.stringify(fM.j)}`);
  const gB = runQuery("gate", "--report", P("r"), "--policy", P("bare.policy"), "--json");
  const fB = run("fix-gate", "r", "bare.policy", "--strict");
  check("⟨0.24⟩ advisory-bound MIRROR — a BARE `deny Net` over the SAME evidence-less report narrows on nothing, so the gate FIRES (exit 1) and the remedy for `app.noClass` is still offered: the refusal keys on the FILTER, not on the missing field",
        gB.status === 1 && fB.s === 1 && fB.j?.ok === false && fB.j.unevaluated === undefined
          && (fB.j?.remedies ?? []).some((p) => p.fn === "app.noClass"),
        `gate=${gB.status} fg=${fB.s}/${JSON.stringify(fB.j)}`);
  const gU = runQuery("gate", "--report", P("r"), "--policy", P("unk.policy"), "--json");
  const uU = run("unverified", "r", "unk.policy", "--strict");
  check("⟨0.24⟩ advisory-bound MIRROR — under `deny Unknown[reflect,unresolved]` the gate CLEARS (exit 0, the class is excluded) and `unverified` still finds the provable-purity hole with its upgrade: the ⟨0.24⟩ class-filter fix is intact",
        gU.status === 0 && uU.s === 1 && uU.j?.ok === false && named(uU.j).has("app.nativeHole")
          && uU.j.unevaluated === undefined
          && uU.j.unverified.find((h) => h.fn === "app.nativeHole")?.upgrade === "deny Unknown app",
        `gate=${gU.status} uv=${uU.s}/${JSON.stringify(uU.j)}`);

  // ── THE UNKNOWN AXIS, ADDED BY THE MUTANT AUDIT ────────────────────────────────────────────────────
  // A mutant that deleted the withhold from `deniedLayer`, restoring `fix-gate`'s remedy, SURVIVED the
  // battery above — because on the `Net` axis the authoritative empty class set already excludes the rule,
  // so the two halves of the fix are individually redundant THERE. On the `Unknown` axis they are not:
  // `reasonClassesMatch` FLOORS an empty reason set at `unresolved`, so `deny Unknown[unresolved]` over a
  // reasonless Unknown MATCHES, and with the withhold removed `fix-gate` came back with a full hoist plan
  // for `app.blind`, `ok:false`, exit 1 — and no `unevaluated` beside it, since the disclosure is gathered
  // only where nothing certainly denied. Measured, mutant applied:
  //
  //   gate --report      exit 2, refused                     <- unchanged, the oracle
  //   fix-gate (mutant)  remedy for app.blind, ok:false       <- the ruled defect, live
  //   fix-gate (fixed)   remedies: [], unevaluated: [1]
  //
  // Which is the audit doing its job: the fixture that proved one axis closed could not see the other.
  const dU = scratch("candor-advisory-bound-unk-");
  fs.writeFileSync(path.join(dU, "r.json"), JSON.stringify({
    candor: { version: "ttttttt", spec: "0.23" }, package: "app", analyzed: { count: 1, digest: "0" },
    functions: [{ fn: "app.blind", inferred: ["Unknown"], direct: [], unresolved: true }] }));
  fs.writeFileSync(path.join(dU, "r.callgraph.json"), JSON.stringify({ "app.blind": [] }));
  fs.writeFileSync(path.join(dU, "u.policy"), "deny Unknown[unresolved] app\n");
  const runU = (verb, ...extra) => {
    const r = runQuery(verb, "--report", path.join(dU, "r"), "--policy", path.join(dU, "u.policy"), ...extra);
    return { s: r.status, j: J(r), err: r.stderr };
  };
  const gUn = runQuery("gate", "--report", path.join(dU, "r"), "--policy", path.join(dU, "u.policy"), "--json");
  const fUn = runU("fix-gate", "--strict"), uUn = runU("unverified", "--strict");
  check("⟨0.24⟩ advisory-bound, UNKNOWN axis: the ORACLE — `gate --report` REFUSES a `deny Unknown[unresolved]` over an Unknown with NO reachable reason (an empty class set is not evidence of that class)",
        gUn.status === 2 && J(gUn)?.refused === true && /no reason reachable/.test(J(gUn)?.unevaluated?.[0]?.why ?? ""),
        `status=${gUn.status} ${gUn.stdout.slice(0, 250)}`);
  check("⟨0.24⟩ advisory-bound, UNKNOWN axis: `fix-gate` offers NO remedy and discloses instead — the axis where the withhold is LOAD-BEARING, found by a mutant the Net fixture could not catch",
        fUn.s === 2 && (fUn.j?.remedies ?? []).length === 0 && !("ok" in (fUn.j ?? { ok: 1 }))
          && fUn.j?.unevaluated?.[0]?.rule === "deny Unknown[unresolved] app",
        `status=${fUn.s} ${JSON.stringify(fUn.j)}`);
  check("⟨0.24⟩ advisory-bound, UNKNOWN axis: `unverified` NAMES `app.blind` with the missing evidence, beside the ordinary provable-purity hole it is ALSO an instance of",
        uUn.s === 2 && (uUn.j?.unverified ?? []).some((h) => h.fn === "app.blind" && /no reason reachable/.test(h.why ?? ""))
          && (uUn.j?.unverified ?? []).some((h) => h.fn === "app.blind" && h.upgrade === "deny Unknown app"),
        `status=${uUn.s} ${JSON.stringify(uUn.j)}`);
  fs.rmSync(dU, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.24⟩ `whatif` NAMES THE OPERATOR'S OWN RULE, AND SAYS WHAT A NARROWED VERDICT RESTS ON ────────
// SPEC §3.1 (`6f30540`, shape corrected by `901f14d`): `violations[].conditional: "<the narrowing left
// unevaluated>"`, a STRING, omitted on rules that do not narrow. `conditional` was ONE-ENGINE (candor-rust)
// when this landed; the ground truth below was read off that engine's OUTPUT, not off a description of it —
// the spec's own first pin of this field was mis-transcribed from prose and had to be corrected.
//
// WHY THE FIELD EXISTS. `whatif` asks about an effect the code does not have yet, so a narrowing filter
// quantifies over a CLASS of something that does not exist and cannot be matched. Charging it is the right
// fail-closed default for a pre-edit gate — the edit could land in any class — but the verdict is therefore
// CONDITIONAL, and §3.1's rule for exactly this shape is that an unanswerable condition is DISCLOSED, never
// scored as a failed one.
//
// AND THE TWO HALVES ONLY WORK TOGETHER. MEASURED on this engine before the change, over one hand-built
// report, against candor-rust over byte-identical inputs:
//
//   `deny Unknown[reflect] app.nat`        rust `deny Unknown[reflect] app.nat`   ts `deny Unknown app.nat`
//   `deny Net[unknown-host,known-partner] app`  rust verbatim                     ts `deny Net app`
//   `deny Net Db  app  # comment`          rust `deny Net Db  app`                ts `deny Db Net app`
//   `pure app`                             rust `pure app`                        ts `deny (pure) app`
//   …and `conditional` on the first two    rust present                           ts absent everywhere
//
// The narrowed rows are the sharp ones: the operator's own scoping erased in the verb an agent reads BEFORE
// editing. But printing `raw` while the verdict stayed filter-blind would be WORSE than that bug — the same
// unconditional "would violate", now attributed to the narrowed line, reading as a filter candor evaluated
// and did not. So the raw line and the condition land in one change.
if (blk()) {
  const d = scratch("candor-whatif-cond-");
  fs.writeFileSync(path.join(d, "r.json"), JSON.stringify({
    candor: { version: "ttttttt", spec: "0.24" }, package: "app", analyzed: { count: 1, digest: "0" },
    functions: [{ fn: "app.nat", inferred: ["Unknown"], direct: ["Unknown"], unknownWhy: ["native:extern fn"], calls: [], loc: "a.ts:1" }],
  }));
  fs.writeFileSync(path.join(d, "r.callgraph.json"), JSON.stringify({ "app.nat": [] }));
  const R = path.join(d, "r"), P = path.join(d, "w.policy");
  const wi = (text, eff) => {
    fs.writeFileSync(P, `${text}\n`);
    const r = runQuery("whatif", "app.nat", eff, "--report", R, "--policy", P, "--json");
    try { return JSON.parse(r.stdout).violations[0] ?? {}; } catch { return {}; }
  };

  // ARM 1 — the rule is named VERBATIM: comment stripped and ends trimmed, but the operator's own effect
  // ORDER, internal spacing and rule KIND survive. `pure app` reads back as itself, not as `deny (pure) app`.
  const vNarrowU = wi("deny Unknown[reflect,unresolved] app.nat", "Unknown");
  const vNarrowN = wi("deny Net[unknown-host,known-partner] app", "Net");
  check("⟨0.24⟩ whatif names the operator's OWN rule — a narrowed line keeps its bracket instead of being printed back as the WIDE rule they did not write",
        vNarrowU.rule === "deny Unknown[reflect,unresolved] app.nat"
          && vNarrowN.rule === "deny Net[unknown-host,known-partner] app",
        `unknown=${vNarrowU.rule} net=${vNarrowN.rule}`);
  check("⟨0.24⟩ …and so does an UNNARROWED one: effect order, internal spacing and the `pure` kind are the operator's, not a normalization (`deny Net Db  app` never `deny Db Net app`; `pure app` never `deny (pure) app`)",
        wi("deny Net Db  app     # keep the app layer pure", "Net").rule === "deny Net Db  app"
          && wi("pure app", "Net").rule === "pure app",
        `multi=${wi("deny Net Db  app     # keep the app layer pure", "Net").rule} pure=${wi("pure app", "Net").rule}`);

  // ARM 2 — the half that keeps ARM 1 from lying: the verdict on a narrowed rule is CONDITIONAL and says so.
  // Byte-equal to candor-rust's strings, read off that engine's JSON: classes sorted, joined ` / `.
  check("⟨0.24⟩ a narrowed `Unknown[…]` rule discloses the condition its verdict rests on — the class an effect that does not exist yet cannot be matched against",
        vNarrowU.conditional === "the `Unknown` you introduce is of reason class reflect / unresolved",
        JSON.stringify(vNarrowU));
  check("⟨0.24⟩ …and the `Net[…]` sibling names the DESTINATION class, classes sorted and ` / `-joined (byte-equal to candor-rust, the engine this field was read off)",
        vNarrowN.conditional === "the `Net` you introduce reaches destination class known-partner / unknown-host",
        JSON.stringify(vNarrowN));
  check("⟨0.24⟩ `dynamic` discloses the classes it RESOLVED TO, not the alias — the condition names what would have to be true, and `dynamic` is not a class",
        wi("deny Unknown[dynamic] app.nat", "Unknown").conditional
          === "the `Unknown` you introduce is of reason class dispatch / indirect / native / reflect / unresolved",
        JSON.stringify(wi("deny Unknown[dynamic] app.nat", "Unknown")));

  // THE MIRROR, and the reason it is the mirror the brief asks for: a `conditional` on EVERY violation would
  // train the reader to ignore it, which is the same failure as naming a config that moved nothing. A rule
  // that does not narrow rests on no condition, so the KEY IS ABSENT and the document is byte-identical to a
  // pre-⟨0.24⟩ one. `in`, never falsiness — an empty-string `conditional` would satisfy a `!c` test while
  // being the invention this row exists to forbid.
  const noCond = (t, e) => !("conditional" in wi(t, e));
  check("⟨0.24⟩ MIRROR — a rule that does NOT narrow emits no `conditional` at all: bare `deny`, `pure`, and the explicit `[*]`/bare-`Unknown` wildcards, whose empty filter matches everything",
        noCond("deny Unknown app.nat", "Unknown") && noCond("deny Net app", "Net")
          && noCond("pure app", "Net") && noCond("deny Unknown[*] app.nat", "Unknown")
          && noCond("deny Net[*] app", "Net"),
        JSON.stringify([wi("deny Unknown app.nat", "Unknown"), wi("deny Net[*] app", "Net")]));
  // …and the filter keys on the effect being INTRODUCED, not on the rule merely CARRYING a bracket. A
  // `deny Net[unknown-host] Fs app` asked about `Fs` charges `Fs` unconditionally: the `Net` narrowing says
  // nothing about it, and quoting it there would attach a condition to a verdict that does not rest on one.
  const mixedFs = wi("deny Net[unknown-host] Fs app", "Fs");
  const mixedNet = wi("deny Unknown[reflect,unresolved] Net[unknown-host] app", "Net");
  check("⟨0.24⟩ MIRROR — the condition keys on the effect being INTRODUCED, not on the rule carrying a bracket: `Fs` under `deny Net[unknown-host] Fs app` is charged unconditionally, and a two-filter rule quotes only the asked-about one",
        !("conditional" in mixedFs) && mixedFs.rule === "deny Net[unknown-host] Fs app"
          && mixedNet.conditional === "the `Net` you introduce reaches destination class unknown-host",
        `fs=${JSON.stringify(mixedFs)} net=${JSON.stringify(mixedNet)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE §2.2 SIDECARS GO WITH THE ARMED REPORT — DELETED, NOT EMPTIED (SPEC §3.3.1) ─────────
// An armed report beside a LIVE sidecar is a pair that contradicts itself, and it is not decorative:
// `callers`/`whatif`/`rewire` are answered FROM THE SIDECAR, because a currently-pure function is absent
// from the report by §2 rule 3. MEASURED on this engine before the fix — baseline `f` pure with caller
// `g`, new version gives `f` an `fs.readFileSync` and adds caller `h`, run exits 2 on an unknown flag:
// `callers f` answered exit 0 with direct `[src.app.g]`. Confident, and wrong.
//
// THE PREMISE ROW IS FIRST AND IS LOAD-BEARING: "no sidecars afterwards" and "this engine never wrote
// one" are the same directory listing, so a block that only counts what is left can pass vacuously.
if (blk()) {
  const d = project({
    "tsconfig.json": '{ "compilerOptions": { "target": "ES2020", "module": "ESNext", "strict": true }, "include": ["src/**/*.ts"] }\n',
    "src/app.ts": 'export function f(): number { return 1; }\n'
      + 'export function g(): number { return f(); }\n'
      + 'export function main(): void { console.log(g()); }\n',
  });
  const SEGS = ["callgraph", "hierarchy", "locs"];
  const pfx = path.join(d, "out", "p");
  fs.mkdirSync(path.dirname(pfx), { recursive: true });
  const run = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), d, ...a], { encoding: "utf8" });
  const there = (p) => fs.existsSync(p);
  const sidecars = (stem) => SEGS.map((s) => `${stem}.${s}.json`);

  run("--out", pfx);
  check("⟨0.28⟩ sidecar PREMISE: a clean `--out` run really writes all three §2.2 sidecars — without this row the block below passes on an engine that never wrote one",
        sidecars(pfx).every(there), sidecars(pfx).map((p) => `${path.basename(p)}=${there(p)}`).join(" "));

  // The neighbours that must SURVIVE. A gate verdict is the VERDICT sink's document — separately armed,
  // separately named by the operator — so the report sink deleting it is §3.3.1's cross-sink harm; and
  // `encountered-*` is a prefix family belonging to no report's pair. Both are in §2.2's reserved list,
  // which is why the exclusion is argued rather than assumed.
  fs.writeFileSync(`${pfx}.gate.json`, '{"spec":"0.27","ok":true,"violations":[]}\n');
  fs.writeFileSync(`${pfx}.encountered-hosts.json`, '{"api.example.com":1}\n');
  // …and an ORPHAN: a second report under the same prefix that this run arms but never writes.
  for (const [from, to] of [[`${pfx}.json`, `${pfx}.orphanA.json`], [`${pfx}.callgraph.json`, `${pfx}.orphanA.callgraph.json`]]) fs.copyFileSync(from, to);
  const gateBefore = fs.readFileSync(`${pfx}.gate.json`, "utf8");
  const encBefore = fs.readFileSync(`${pfx}.encountered-hosts.json`, "utf8");

  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as fs from "fs";\n'
    + 'export function f(): number { return fs.readFileSync("/etc/hosts").length; }\n'
    + 'export function g(): number { return f(); }\n'
    + 'export function h(): number { return f(); }\n'
    + 'export function main(): void { console.log(g() + h()); }\n');
  const armedRun = run("--out", pfx, "--zzz-not-a-flag");
  const armedDoc = JSON.parse(fs.readFileSync(`${pfx}.json`, "utf8"));
  check("⟨0.28⟩ sidecar: the run exits 2 with the report armed to the ⟨0.21⟩ Row-1 empty (the premise the sidecar rule hangs off)",
        armedRun.status === 2 && armedDoc.functions.length === 0 && armedDoc.analyzed.count === 0 && armedDoc.unanalyzed?.length > 0,
        `status=${armedRun.status} ${JSON.stringify(armedDoc).slice(0, 200)}`);
  check("⟨0.28⟩ sidecar: …and all three of the armed report's §2.2 sidecars are GONE — deleted, not emptied (an empty file would be a claim ⟨0.24⟩ has already ruled meaningless)",
        sidecars(pfx).every((p) => !there(p)), sidecars(pfx).filter(there).join(" "));
  check("⟨0.28⟩ sidecar: `<stem>.gate.json` SURVIVES byte-identical — a gate verdict is the VERDICT sink's document, and taking it from the report sink is §3.3.1's cross-sink harm",
        fs.readFileSync(`${pfx}.gate.json`, "utf8") === gateBefore, "gate.json changed");
  check("⟨0.28⟩ sidecar: `<stem>.encountered-hosts.json` survives too — a prefix family that belongs to no report's pair",
        fs.readFileSync(`${pfx}.encountered-hosts.json`, "utf8") === encBefore, "encountered-hosts.json changed");
  check("⟨0.28⟩ sidecar: an ORPHAN report armed under the same prefix loses ITS sidecar as well — the rule is per REPORT, not per `--out` value",
        !there(`${pfx}.orphanA.callgraph.json`), "the orphan's callgraph is still there");

  // ── ⟨0.28⟩ …AND UNANSWERABLE REACHES THE MACHINE CHANNEL (SPEC §3.3.1). Deleting the sidecar removes
  // the confidently WRONG answer above; it does not by itself produce an honest one. The absence arm was
  // `{"of":[],"direct":[],"transitive":[]}` at exit 0 while the human arm said "no function in the call
  // graph matches that name" — and BOTH of those are determined negatives. A consumer reading `direct`,
  // or DEFAULTING it (the fail-open idiom ⟨0.24⟩ names on every key in this format), is told NOBODY CALLS
  // `f`: "safe to edit" over a pair whose honest answer is "this run judged nothing". §3.3.1 permits an
  // `unanswerable` key OR a non-zero exit; BOTH are asserted, because each alone leaves a naive reader
  // exposed — the key alone still lets `d.direct ?? []` read as a determined negative, the exit alone
  // leaves a JSON consumer holding an empty document. Conformance PART 37 row (e) pins the same thing.
  const callersQ = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), "callers", ...a, "--report", pfx], { encoding: "utf8" });
  for (const flags of [[], ["--include-unknown"]]) {
    const lbl = flags.length ? " (--include-unknown — the frontier arm routes through the same block)" : "";
    const aj = callersQ("src.app.f", ...flags, "--json");
    let doc = null; try { doc = JSON.parse(aj.stdout); } catch { /* stays null → the row fails loudly */ }
    check(`⟨0.28⟩ callers --json over an armed pair carries \`unanswerable\` and NO \`direct\`/\`transitive\`${lbl}`,
          !!doc && typeof doc.unanswerable === "string" && doc.unanswerable.length > 0 && !("direct" in doc) && !("transitive" in doc),
          `${aj.stdout}`.slice(0, 220));
    check(`⟨0.28⟩ …and exits non-zero, so an exit-only consumer fails closed too${lbl}`,
          aj.status !== 0, `status=${aj.status}`);
    const ah = callersQ("src.app.f", ...flags, "--text");
    check(`⟨0.28⟩ …and the human arm says there is NO CALL GRAPH (not "no such function"), same non-zero exit${lbl}`,
          ah.status !== 0 && /no call graph in the report/.test(ah.stdout),
          `status=${ah.status} ${ah.stdout}`.slice(0, 220));
  }

  // ── ⟨0.28⟩ …AND `impact`/`path` TOO. 5091905 measured both as still silent here and named them as a
  // rung of their own; this is that rung. They are not descriptive report-only verbs — both resolve their
  // TARGET over the §2.2 call graph, so with no sidecar every answer is vacuous, and each vacuum spells
  // itself as the reassurance the verb exists to give. `affectedCount: 0` is the blast-radius verb saying
  // NOTHING CALLS THIS, SAFE TO CHANGE; `path: []` is "there is no route by which this reaches that
  // effect". Both at exit 0, over a run that judged nothing. rust and java exit 2 on both — a one-engine
  // divergence against three arms, not a design question. As above, the key AND the exit are asserted,
  // and the empty ANSWER keys must be GONE rather than zeroed: a `d.affectedCount ?? 0` reader must have
  // nothing left to mistake for a finding.
  const impactQ = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), "impact", ...a, "--report", pfx], { encoding: "utf8" });
  const pathQ = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), "path", ...a, "--report", pfx], { encoding: "utf8" });
  const ij = impactQ("src.app.f", "--json");
  let ijDoc = null; try { ijDoc = JSON.parse(ij.stdout); } catch { /* stays null → the row fails loudly */ }
  check("⟨0.28⟩ impact --json over an armed pair carries `unanswerable` and NO `affectedCount`/`affected` — a 0 blast radius is the strongest safe-to-change claim this format has",
        !!ijDoc && typeof ijDoc.unanswerable === "string" && ijDoc.unanswerable.length > 0
          && !("affectedCount" in ijDoc) && !("affected" in ijDoc) && !("entryPoints" in ijDoc),
        `${ij.stdout}`.slice(0, 220));
  check("⟨0.28⟩ …and impact exits non-zero, so an exit-only consumer fails closed too",
        ij.status !== 0, `status=${ij.status}`);
  const ih = impactQ("src.app.f", "--text");
  check("⟨0.28⟩ …and impact's human arm says there is NO CALL GRAPH, same non-zero exit",
        ih.status !== 0 && /no call graph in the report/.test(ih.stdout),
        `status=${ih.status} ${ih.stdout}`.slice(0, 220));
  const pj = pathQ("src.app.f", "Fs", "--json");
  let pjDoc = null; try { pjDoc = JSON.parse(pj.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ path --json over an armed pair carries `unanswerable` and NO `path` key — an empty chain reads as `this effect is not reachable from here`",
        !!pjDoc && typeof pjDoc.unanswerable === "string" && pjDoc.unanswerable.length > 0 && !("path" in pjDoc),
        `${pj.stdout}`.slice(0, 220));
  check("⟨0.28⟩ …and path exits non-zero",
        pj.status !== 0, `status=${pj.status}`);
  // path's human arm is REPAIRED, not merely forwarded: it exited 2 already, but blamed the NAME ("no
  // function matching 'src.app.f'") when the truth is about the GRAPH — the same wrong-cause-reads-as-an-
  // answer correction `callers` needed. Its other two human exits were worse still: over a VALID report
  // with the sidecar gone it reached "does not perform Fs" / "not statically traceable" at exit 0.
  const ph = pathQ("src.app.f", "Fs", "--text");
  check("⟨0.28⟩ …and path's human arm says NO CALL GRAPH rather than blaming the function name, same non-zero exit",
        ph.status !== 0 && /no call graph in the report/.test(ph.stdout) && !/no function matching/.test(ph.stderr),
        `status=${ph.status} ${ph.stdout}${ph.stderr}`.slice(0, 220));

  // RECOVERY. The absence arm is a state a completing run leaves, not a state it gets stuck in.
  // A SECOND orphan, seeded here so the run that arms it is the one that COMPLETES: only a completing
  // run reaches `disarmUnwrittenOutReports`, which is what hands an unowned report back.
  fs.writeFileSync(`${pfx}.orphanB.json`, JSON.stringify({ candor: { version: "candor-ts-x", spec: "0.27" }, functions: [], analyzed: { count: 3 } }, null, 1));
  fs.writeFileSync(`${pfx}.orphanB.callgraph.json`, JSON.stringify({ "gone.pkg.a": ["gone.pkg.b"], "gone.pkg.b": [] }, null, 1));
  const orphanBefore = [`${pfx}.orphanB.json`, `${pfx}.orphanB.callgraph.json`].map((p) => [p, fs.readFileSync(p, "utf8")]);
  const rec = run("--out", pfx);
  const cg = JSON.parse(fs.readFileSync(`${pfx}.callgraph.json`, "utf8"));
  check("⟨0.28⟩ sidecar: a recovering run writes all three back, and the call graph now answers `h` — the caller the stale sidecar hid",
        rec.status === 0 && sidecars(pfx).every(there) && (cg["src.app.h"] ?? []).includes("src.app.f") && (cg["src.app.g"] ?? []).includes("src.app.f"),
        `status=${rec.status} ${JSON.stringify(cg).slice(0, 200)}`);

  // THE CONTROLS ON THE RECOVERED PAIR, and they are the load-bearing half of the machine-channel rows
  // above: ONLY "no graph at all" is unanswerable. A fn that really has no callers over a COMPLETE graph
  // must still answer `direct: []` at exit 0 — a DETERMINED negative, and withdrawing it would be the
  // mirror defect (the ⟨0.24⟩ count-0 lesson, where the plausible fix withdrew 104 real claims to catch
  // 6). A name absent from a real graph must still be the "no function matching" error, because a graph
  // WAS read. Without these three rows the fix is indistinguishable from `callers` refusing everything.
  const okReal = callersQ("src.app.f", "--json");
  let okDoc = null; try { okDoc = JSON.parse(okReal.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: over the RECOVERED pair `callers` still answers the real blast radius at exit 0",
        okReal.status === 0 && !!okDoc && !("unanswerable" in okDoc)
          && okDoc.direct.includes("src.app.g") && okDoc.direct.includes("src.app.h"),
        `status=${okReal.status} ${okReal.stdout}`.slice(0, 220));
  const lonely = callersQ("src.app.main", "--json");
  let lonelyDoc = null; try { lonelyDoc = JSON.parse(lonely.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: a fn with GENUINELY no callers over a complete graph still answers `direct: []` at exit 0 — a determined negative, not a refusal",
        lonely.status === 0 && !!lonelyDoc && !("unanswerable" in lonelyDoc)
          && lonelyDoc.direct.length === 0 && lonelyDoc.transitive.length === 0 && lonelyDoc.of.includes("src.app.main"),
        `status=${lonely.status} ${lonely.stdout}`.slice(0, 220));
  const nofn = callersQ("zzzNoSuchFn", "--json");
  check("⟨0.28⟩ CONTROL: a nonexistent fn over a REAL graph is still `no function matching` at exit 2 — not the unanswerable disclosure (a graph WAS read; the name is not in it)",
        nofn.status === 2 && /no function matching/.test(nofn.stderr) && !/unanswerable/.test(nofn.stdout + nofn.stderr),
        `status=${nofn.status} ${nofn.stdout}${nofn.stderr}`.slice(0, 220));

  // …AND THE SAME CONTROLS FOR `impact`/`path`, which is where the mirror defect would actually land:
  // both verbs answer a NEGATIVE in the same shape as their unanswerable one, so "the graph says no" and
  // "there is no graph" have to stay distinguishable or the fix has simply moved the lie.
  const okImp = impactQ("src.app.f", "--json");
  let okImpDoc = null; try { okImpDoc = JSON.parse(okImp.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: over the RECOVERED pair `impact` still answers the real affected list at exit 0",
        okImp.status === 0 && !!okImpDoc && !("unanswerable" in okImpDoc) && okImpDoc.affectedCount === 3
          && ["src.app.g", "src.app.h", "src.app.main"].every((f) => okImpDoc.affected.includes(f)),
        `status=${okImp.status} ${okImp.stdout}`.slice(0, 220));
  const zeroImp = impactQ("src.app.main", "--json");
  let zeroImpDoc = null; try { zeroImpDoc = JSON.parse(zeroImp.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: a fn that GENUINELY affects nothing over a complete graph still answers `affectedCount: 0` at exit 0 — a determined negative, not a refusal (the ⟨0.24⟩ count-0 mirror)",
        zeroImp.status === 0 && !!zeroImpDoc && !("unanswerable" in zeroImpDoc)
          && zeroImpDoc.affectedCount === 0 && zeroImpDoc.affected.length === 0 && zeroImpDoc.fn === "src.app.main",
        `status=${zeroImp.status} ${zeroImp.stdout}`.slice(0, 220));
  const okPath = pathQ("src.app.g", "Fs", "--json");
  let okPathDoc = null; try { okPathDoc = JSON.parse(okPath.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: over the RECOVERED pair `path` still answers the real chain at exit 0, source and all",
        okPath.status === 0 && !!okPathDoc && !("unanswerable" in okPathDoc)
          && okPathDoc.path.length === 2 && okPathDoc.path.at(-1).fn === "src.app.f" && okPathDoc.path.at(-1).source === true,
        `status=${okPath.status} ${okPath.stdout}`.slice(0, 220));
  const noReach = pathQ("src.app.main", "Net", "--json");
  let noReachDoc = null; try { noReachDoc = JSON.parse(noReach.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ CONTROL: a fn that GENUINELY does not reach the effect over a complete graph still answers `path: []` at exit 0 — the graph SAID no, and withdrawing that is the mirror defect",
        noReach.status === 0 && !!noReachDoc && !("unanswerable" in noReachDoc)
          && Array.isArray(noReachDoc.path) && noReachDoc.path.length === 0 && noReachDoc.effect === "Net",
        `status=${noReach.status} ${noReach.stdout}`.slice(0, 220));
  // THE NONEXISTENT-NAME ROW, and it is now a GATE rather than a control. It used to pin exit 0 as
  // UNCHANGED-not-correct, with a note saying "when that rung is closed, change this row deliberately
  // rather than by surprise" — this is that deliberate change. The rung: `impact`/`path` had no
  // bad-target gate at all on candor-ts (conformance §17 (1b)'s comment claims "path/impact already
  // gate"; measured four-way with array quoting, rust/java/swift exit 2 and candor-ts alone answered
  // `affectedCount: 0` / `path: []` at exit 0 — an authoritative all-clear about a fn that does not
  // exist). Both verbs now exit 2 naming the target, like `callers`.
  //
  // TWO ASSERTIONS, and the second is the one that keeps the ⟨0.28⟩ fix above intact: exit 2 AND no
  // `unanswerable` anywhere. "There is no call graph" and "the graph is fine, the name is not in it"
  // are different answers with the same exit code, and a reader who is handed the wrong cause goes to
  // the wrong place to fix it. The unanswerable rows above assert the converse (disclosure, and no
  // "no function matching"), so the pair cannot collapse in either direction.
  const nofnI = impactQ("zzzNoSuchFn", "--json");
  const nofnP = pathQ("zzzNoSuchFn", "Fs", "--json");
  check("⟨0.28⟩ a nonexistent fn over a REAL graph is a BAD TARGET on impact/path too — exit 2 naming it, never `affectedCount: 0` / `path: []` at exit 0 (corpus-audit #3, the rung §17 (1b) assumed was already closed)",
        nofnI.status === 2 && nofnP.status === 2
          && /impact: no function matching 'zzzNoSuchFn'/.test(nofnI.stderr)
          && /path: no function matching 'zzzNoSuchFn'/.test(nofnP.stderr)
          && !/unanswerable/.test(nofnI.stdout + nofnI.stderr) && !/unanswerable/.test(nofnP.stdout + nofnP.stderr),
        `impact=${nofnI.status} ${nofnI.stdout.slice(0, 90)}${nofnI.stderr.slice(0, 90)} path=${nofnP.status} ${nofnP.stdout.slice(0, 90)}${nofnP.stderr.slice(0, 90)}`);
  // BOTH ARMS, because the divergence lived on ONE route: `path`'s HUMAN arm always exited 2 here while
  // `--json` — the arm a CI script and an agent read — answered `path: []` at exit 0, and `impact` was
  // lenient on both. A gate that only the prose reader gets is the sibling-route habit, so the no-flag
  // form is measured rather than assumed.
  const nofnIh = impactQ("zzzNoSuchFn");
  const nofnPh = pathQ("zzzNoSuchFn", "Fs");
  check("⟨0.28⟩ …and on the NO-FLAG (human) arm of both verbs — the machine arm was the lenient one, so neither route is left ungated",
        nofnIh.status === 2 && nofnPh.status === 2
          && /no function matching/.test(nofnIh.stderr) && /no function matching/.test(nofnPh.stderr),
        `impact=${nofnIh.status} ${nofnIh.stderr.slice(0, 90)} path=${nofnPh.status} ${nofnPh.stderr.slice(0, 90)}`);
  // THE SCOPE BOUNDARY OF THE ROWS ABOVE, pinned as UNCHANGED rather than as correct — the same discipline
  // the bad-target row itself was held under until this commit. A typo'd EFFECT (`path <real fn> Netwerk`)
  // is arguably a bad target too, and `where` refuses exactly that typo (exit 2, "unknown effect"). But
  // MEASURED on a valid report, rust, java AND swift all answer `path: []` at exit 0 here — so `path` and
  // `where` disagree in all four engines, uniformly. Gating it in candor-ts alone would manufacture a
  // fresh one-engine divergence out of the fix for one, which is the whole failure mode this rung exists
  // to close. It is a FOUR-WAY rung of its own; when it is opened, this row changes deliberately.
  const typoEff = pathQ("src.app.g", "Netwerk", "--json");
  let typoDoc = null; try { typoDoc = JSON.parse(typoEff.stdout); } catch { /* stays null */ }
  check("⟨0.28⟩ SCOPE: a typo'd EFFECT on `path` is NOT part of this rung — still `path: []` at exit 0, which is what rust/java/swift all do (a four-way rung, not a one-engine fix)",
        typoEff.status === 0 && !!typoDoc && !("unanswerable" in typoDoc)
          && Array.isArray(typoDoc.path) && typoDoc.path.length === 0 && typoDoc.effect === "Netwerk",
        `status=${typoEff.status} ${typoEff.stdout}`.slice(0, 220));

  // …and the orphan is handed back WHOLE. Restoring the report while leaving its sidecars deleted is a
  // third state neither the pre-run tree nor the armed tree ever had.
  check("⟨0.28⟩ sidecar: the ORPHAN this run turned out not to own comes back with its sidecar — report AND callgraph byte-identical",
        orphanBefore.every(([p, v]) => fs.existsSync(p) && fs.readFileSync(p, "utf8") === v),
        orphanBefore.filter(([p, v]) => !fs.existsSync(p) || fs.readFileSync(p, "utf8") !== v).map(([p]) => path.basename(p)).join(" "));

  // THE INPUT EXEMPTION COVERS THE SIDECARS. "Do not touch what this run READS" does not stop at the
  // report half: a `--policy`, a chained dep report or the config can be named `<stem>.locs.json`.
  const locsBefore = fs.readFileSync(`${pfx}.locs.json`, "utf8");
  const exempt = run("--out", pfx, "--policy", `${pfx}.locs.json`, "--zzz-not-a-flag");
  check("⟨0.28⟩ sidecar: a sidecar that is ALSO an input of this run is left in place and SAID SO on stderr — the exemption is asked of the same `sameArtifact`/`runInputs` the sink guards use",
        fs.readFileSync(`${pfx}.locs.json`, "utf8") === locsBefore
          && /is what this run READS as --policy — leaving it in place/.test(exempt.stderr),
        `${exempt.stderr}`.slice(0, 300));

  // AND THE SIDECARS FOLLOW ONLY IF THE REPORT ACTUALLY ARMED. A write that FAILS leaves the PREVIOUS
  // run's report on disk; removing its sidecars there is a stale-report/no-callgraph pair no run has
  // ever written — worse than the state the failure left. A pair degrades together or not at all.
  run("--out", pfx);
  const before = [`${pfx}.json`, ...sidecars(pfx)].map((p) => [p, fs.readFileSync(p, "utf8")]);
  fs.chmodSync(path.dirname(pfx), 0o555);
  const ro = run("--out", pfx, "--zzz-not-a-flag");
  fs.chmodSync(path.dirname(pfx), 0o755);
  check("⟨0.28⟩ sidecar PREMISE: a read-only directory really does fail the arm write (else the row below is vacuous)",
        /could not arm the report/.test(ro.stderr), `${ro.stderr}`.slice(0, 300));
  check("⟨0.28⟩ sidecar: an arm that FAILED to write leaves BOTH halves exactly as found — report and all three sidecars byte-identical — and says so on stderr",
        before.every(([p, v]) => fs.existsSync(p) && fs.readFileSync(p, "utf8") === v)
          && /leaving it AND its §2\.2 sidecars exactly as they are/.test(ro.stderr),
        before.filter(([p, v]) => !fs.existsSync(p) || fs.readFileSync(p, "utf8") !== v).map(([p]) => path.basename(p)).join(" ") || `${ro.stderr}`.slice(0, 300));

  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE GRAPH VERBS FALL BACK TO THE REPORT'S OWN `calls` EDGES ──────────────────────────────
// A valid report queried WITHOUT its sidecar — a single hand-copied `report.json`, a locator §3.3.1
// supports — is a graph present by another route, not an absent one. rust and java build the fallback
// graph from the report's embedded edges and answer real callers at exit 0; this engine's ⟨0.28⟩
// unanswerable arm fired on it, flipping a cross-engine script's exit 0→2 on one arm of four.
// `unanswerable` now fires only when the graph is GENUINELY absent (no sidecar AND no embedded edges —
// the armed pair), which the block above still pins.
if (blk()) {
  const d = project({
    "src/app.ts": 'import * as fs from "fs";\n'
      + 'export function leaf(): number { return fs.readFileSync("/etc/hosts").length; }\n'
      + 'export function mid(): number { return leaf(); }\n'
      + 'export function top(): number { return mid(); }\n',
  });
  spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out", path.join(d, "full")], { encoding: "utf8" });
  // The hand-copied form: the report alone, no §2.2 sidecars anywhere near it.
  const solo = path.join(d, "solo"); fs.mkdirSync(solo);
  fs.copyFileSync(path.join(d, "full.json"), path.join(solo, "r.json"));
  const q = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), ...a, "--report", path.join(solo, "r.json"), "--json"], { encoding: "utf8" });

  const c = q("callers", "src.app.leaf");
  let cdoc = null; try { cdoc = JSON.parse(c.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ fallback: `callers` over a sidecar-less report answers the REAL callers from the report's `calls` edges at exit 0 — rust/java's answer, not `unanswerable`",
        c.status === 0 && !!cdoc && !("unanswerable" in cdoc)
          && cdoc.direct.includes("src.app.mid") && cdoc.transitive.includes("src.app.top"),
        `status=${c.status} ${c.stdout}`.slice(0, 220));
  const i = q("impact", "src.app.leaf");
  let idoc = null; try { idoc = JSON.parse(i.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ fallback: `impact` too — the blast radius is in the report's own edges",
        i.status === 0 && !!idoc && !("unanswerable" in idoc)
          && idoc.affectedCount === 2 && idoc.affected.includes("src.app.top"),
        `status=${i.status} ${i.stdout}`.slice(0, 220));
  const p = q("path", "src.app.top", "Fs");
  let pdoc = null; try { pdoc = JSON.parse(p.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ fallback: `path` too — the chain to the source, ending on `leaf` marked as it",
        p.status === 0 && !!pdoc && !("unanswerable" in pdoc)
          && pdoc.path.length === 3 && pdoc.path.at(-1).fn === "src.app.leaf" && pdoc.path.at(-1).source === true,
        `status=${p.status} ${p.stdout}`.slice(0, 220));
  // Only the COMPLETE graph proves a name absent: the fallback is effect-relevant edges only, so a pure
  // leaf called only by pure fns is invisible there — a no-match is INCONCLUSIVE, answered `{}` at exit 0
  // (rust corpus-audit #5), never a fabricated "no such function" and never the unanswerable disclosure.
  const nm = q("callers", "zzz_not_anywhere");
  check("⟨0.28⟩ fallback: a no-match over the effect-only graph is `{}` at exit 0 — inconclusive, not `no function matching` (which only the complete sidecar can prove) and not `unanswerable` (a graph WAS read)",
        nm.status === 0 && nm.stdout.trim() === "{}" && !/no function matching|unanswerable/.test(nm.stdout + nm.stderr),
        `status=${nm.status} ${nm.stdout}${nm.stderr}`.slice(0, 220));
  const nmh = spawnSync("node", [path.join(HERE, "query.mjs"), "callers", "zzz_not_anywhere", "--report", path.join(solo, "r.json"), "--text"], { encoding: "utf8" });
  check("⟨0.28⟩ fallback: …and the human arm points at the ABSENT SIDECAR and the re-scan, byte-matching rust's sentence",
        nmh.status === 0 && /no caller of `zzz_not_anywhere` in the effect-relevant graph \(the full call-graph sidecar is absent; re-scan with --out to see pure-only callers\)\./.test(nmh.stdout),
        `status=${nmh.status} ${nmh.stdout}${nmh.stderr}`.slice(0, 220));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ ARMING NEVER TOUCHES THE SCAN TARGET (SPEC §3.3.1 (3)) ───────────────────────────────────
// The worst artifact the ⟨0.28⟩ review found, on this engine: `scan.mjs app.ts --gate-json app.ts`
// ARMED the refusal verdict OVER the operator's source file, parsed the wreckage it had just written
// ("1 source file(s) failed to parse — NOT analyzed"), and exited 0. Silent destruction of the one file
// the run exists to describe, reported as success. §3.3.1 (3) lists "the target's own source tree"
// among the inputs arming must not touch; `runInputs` registered policy / env / deps / config — not the
// target. EVERY row here asserts the BYTES, because an exit-code assertion alone passes on an engine
// that still destroys the file and then exits 2 about something else.
if (blk()) {
  const d = scratch("candor-target-");
  const src = path.join(d, "app.ts");
  fs.writeFileSync(src, "export function hello(): number { return 1 }\n");
  const before = fs.readFileSync(src, "utf8");
  const run = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), ...a], { encoding: "utf8", cwd: d });

  const g = run("app.ts", "--gate-json", "app.ts");
  check("⟨0.28⟩ target: `--gate-json <the scan target>` leaves the target BYTE-IDENTICAL — arming must never destroy the source it is about to scan",
        fs.readFileSync(src, "utf8") === before, fs.readFileSync(src, "utf8").slice(0, 120));
  check("⟨0.28⟩ target: …and the run REFUSES loudly — exit 2 naming the collision, never exit 0 claiming success over a tree it just broke",
        g.status === 2 && /names the SAME FILE as the scan target/.test(g.stderr),
        `status=${g.status} ${g.stderr}`.slice(0, 240));

  // THE SECOND ROUTE TO THE SAME SINK: the report set's FINAL write, which the armer's exemption does
  // not run in front of. A `tsconfig.json` target under `--out tsconfig` was left unarmed by the
  // exemption and then destroyed by `writeAtomic(`${outPrefix}.json`)` at exit 0 — "wrote 0 effectful
  // functions … to tsconfig.json", over the file that configured the scan.
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/lib.ts"), "export function f(): number { return 2 }\n");
  const tsc = path.join(d, "tsconfig.json");
  fs.writeFileSync(tsc, '{ "compilerOptions": { "target": "ES2020", "module": "ESNext" }, "include": ["src/**/*.ts"] }\n');
  const tscBefore = fs.readFileSync(tsc, "utf8");
  const o = run("tsconfig.json", "--out", "tsconfig");
  check("⟨0.28⟩ target: `--out <prefix>` whose report set expands onto the target leaves the target BYTE-IDENTICAL — the final write is a second route to the report sink and carries the same input rule",
        fs.readFileSync(tsc, "utf8") === tscBefore, fs.readFileSync(tsc, "utf8").slice(0, 120));
  check("⟨0.28⟩ target: …refused at exit 2 naming the file, never a report silently withheld or an exit 0",
        o.status === 2 && /SAME FILE as the scan target/.test(o.stderr),
        `status=${o.status} ${o.stderr}`.slice(0, 240));

  // THE CONTROL that keeps this exact-artifact, never containment: a verdict written INSIDE the scanned
  // tree is ordinary usage (the recommended CI layout), and a directory-aware rule refused it once
  // before — the comment beside the dep-directory expansion records it taking 33 tests with it.
  const v = run(".", "--gate-json", path.join(d, "verdict.json"));
  check("⟨0.28⟩ target CONTROL: a verdict sink INSIDE a directory target is still ordinary usage — exact-artifact comparison, never containment",
        v.status === 0 && fs.existsSync(path.join(d, "verdict.json")),
        `status=${v.status} ${v.stderr}`.slice(0, 200));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE SCAN TARGET EXPANDS TO THE FILES THE RUN WILL PARSE (SPEC §3.3.1) ────────────────────
// The residual the exact-artifact ruling above deliberately left, and the ruling names THIS engine's
// reproduction: `--gate-json src/main.ts` while scanning `tsconfig.json`. MEASURED here 2026-08-12
// before the fix, and it is the worse of the two artifacts the spec prints:
//
//   candor-ts: 1 source file(s) failed to parse — NOT analyzed …
//   candor-ts: wrote 0 effectful functions (1 analyzed, 1 files) to .candor/report.json      exit 0
//   $ cat src/main.ts  →  { "spec": "0.27", "ok": false, … }
//
// The operator's source, unrecoverably replaced, reported as SUCCESS — the run destroyed the file and
// then disclosed the parse failure it had itself caused. Arming precedes the file walk, so the check is
// over what IS knowable then: the sink's EXTENSION against the engine's own parse set.
//
// EVERY ROW ASSERTS THE BYTES. An exit-code row alone passes on a build that destroys the file and then
// exits 2 about the wreckage — which is exactly how candor-java's spelling of this defect presents.
// The two CONTROLS are the point of the rule's shape: `.candor/verdict.json` is under the target and is
// not source (a containment rule refuses it, and took 33 tests with it here once), and a `.ts` sink
// OUTSIDE the target is not this rule at all.
if (blk()) {
  const d = scratch("candor-tgtexp-");
  fs.mkdirSync(path.join(d, "src"));
  const src = path.join(d, "src", "main.ts");
  fs.writeFileSync(src, "export function hello(): number { return 1 }\n");
  fs.writeFileSync(path.join(d, "tsconfig.json"),
    '{ "compilerOptions": { "target": "ES2020", "module": "ESNext" }, "include": ["src/**/*.ts"] }\n');
  fs.writeFileSync(path.join(d, "candor.policy"), "deny Exec\n");
  const before = fs.readFileSync(src, "utf8");
  const run = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), ...a], { encoding: "utf8", cwd: d });

  const t = run("tsconfig.json", "--gate-json", "src/main.ts");
  check("⟨0.28⟩ target expansion: a `.ts` sink under a TSCONFIG target leaves the source BYTE-IDENTICAL — the parsed set lives under the config's directory, not under the token",
        fs.readFileSync(src, "utf8") === before, fs.readFileSync(src, "utf8").slice(0, 120));
  check("⟨0.28⟩ target expansion: …refused at exit 2 saying the sink is source under the target, never exit 0 'wrote 0 effectful functions' over the file it just destroyed",
        t.status === 2 && /lies UNDER the scan target/.test(t.stderr), `status=${t.status} ${t.stderr}`.slice(0, 260));

  const dir = run(".", "--policy", "candor.policy", "--gate-json", "src/main.ts");
  check("⟨0.28⟩ target expansion: the DIRECTORY-target spelling is the same rule — source byte-identical, exit 2 (a route is not covered by its sibling)",
        dir.status === 2 && fs.readFileSync(src, "utf8") === before && /lies UNDER the scan target/.test(dir.stderr),
        `status=${dir.status} ${dir.stderr}`.slice(0, 260));

  // The DUPLICATE-sink route shares the predicate, so a second `--gate-json` cannot smuggle the
  // duplicate-refusal document over source the single-sink route refuses to touch. The source path is
  // exempt (nothing written); the innocent sibling sink still gets the refusal — the ⟨0.28⟩ scoping.
  const innocent = path.join(d, "pre.json");
  fs.writeFileSync(innocent, '{"ok":true}');
  const dup = run(".", "--policy", "candor.policy", "--gate-json", "src/main.ts", "--gate-json", "pre.json");
  check("⟨0.28⟩ target expansion: the DUPLICATE-sink route asks the same predicate — the source is exempt and byte-identical…",
        dup.status === 2 && fs.readFileSync(src, "utf8") === before,
        `status=${dup.status} ${fs.readFileSync(src, "utf8").slice(0, 120)}`);
  check("⟨0.28⟩ target expansion: …and the INNOCENT sibling sink still gets the duplicate refusal, so it stops publishing its stale `ok: true`",
        /"refused": true/.test(fs.readFileSync(innocent, "utf8")) && /given more than once/.test(fs.readFileSync(innocent, "utf8")),
        fs.readFileSync(innocent, "utf8").slice(0, 200));

  // CONTROL 1 — the recommended layout. `<target>/.candor/verdict.json` is under the target and is NOT
  // source, so it must still gate for real. This is what separates the rule from the containment fix
  // the ruling explicitly rejects.
  fs.mkdirSync(path.join(d, ".candor"), { recursive: true });
  const ok = run(".", "--policy", "candor.policy", "--gate-json", ".candor/verdict.json");
  check("⟨0.28⟩ target expansion CONTROL: `<target>/.candor/verdict.json` is under the target and is not source — it still gates for real (exit 0, verdict written)",
        ok.status === 0 && /"ok": true/.test(fs.readFileSync(path.join(d, ".candor", "verdict.json"), "utf8")),
        `status=${ok.status} ${ok.stderr}`.slice(0, 240));

  // CONTROL 2 — a parsed extension OUTSIDE the target is not this rule.
  const outside = scratch("candor-tgtexp-out-");
  const away = path.join(outside, "v.ts");
  const off = run("src", "--policy", "candor.policy", "--gate-json", away);
  check("⟨0.28⟩ target expansion CONTROL: a `.ts` sink OUTSIDE the target is permitted — the predicate is containment AND extension, not extension alone",
        off.status === 0 && /"ok": true/.test(fs.readFileSync(away, "utf8")), `status=${off.status} ${off.stderr}`.slice(0, 240));
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE GATE'S INPUT GUARD COVERS WHAT THE `--report` LOCATOR EXPANDS TO (SPEC §3.3.1 (3)) ───
// "AND AN INPUT LOCATOR NAMES A SET — COMPARE THE EXPANSION, NEVER THE TOKEN." The guard compared the
// sink against the raw locator while `loadGateReport` reads the locator's expansion. MEASURED on this
// engine 2026-08-12, each at the BYTES because each also "failed" with a plausible exit code:
//   gate --report r --policy P --gate-json r.json      → exit 2, the operator's report replaced by the
//       armed refusal — and the diagnostic blamed the report ("has no functions array") for the
//       corruption this run inflicted;
//   the discovery spelling (no --report, sink = the discovered .candor/report.json) — identical;
//   gate … --gate-json r.callgraph.json                → the §2.2 sidecar half, destroyed at a SUCCESS
//       exit: the report loads fine, the gate runs, and a REAL verdict lands where the graph belongs.
if (blk()) {
  const d = scratch("candor-gatelocator-");
  fs.writeFileSync(path.join(d, "app.ts"),
    'import * as nfs from "node:fs";\nexport function save(): void { nfs.writeFileSync("x", "1"); }\n');
  fs.writeFileSync(path.join(d, "deny-fs.policy"), "deny Fs\n");
  const pfx = path.join(d, "r");
  spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "app.ts"), "--out", pfx], { encoding: "utf8" });
  const gate = (...a) => spawnSync("node", [path.join(HERE, "query.mjs"), "gate",
    "--policy", path.join(d, "deny-fs.policy"), ...a], { encoding: "utf8", cwd: d });

  const repBefore = fs.readFileSync(`${pfx}.json`, "utf8");
  const g1 = gate("--report", pfx, "--gate-json", `${pfx}.json`);
  check("⟨0.28⟩ gate locator: `--gate-json <one of the locator's expanded reports>` leaves the report BYTE-IDENTICAL — the guard compares the expansion, never the token",
        fs.readFileSync(`${pfx}.json`, "utf8") === repBefore, fs.readFileSync(`${pfx}.json`, "utf8").slice(0, 120));
  check("⟨0.28⟩ gate locator: …refused at exit 2 naming the collision, never a downstream 'failed to load' over the wreckage",
        g1.status === 2 && /a file this gate reads/.test(g1.stderr), `status=${g1.status} ${g1.stderr}`.slice(0, 240));

  // The DISCOVERY spelling: no `--report` anywhere in argv — the reports this gate is about to read
  // from the discovered `.candor/` are inputs just the same.
  spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "app.ts")], { encoding: "utf8", cwd: d });
  const disc = path.join(d, ".candor", "report.json");
  const discBefore = fs.readFileSync(disc, "utf8");
  const g2 = gate("--gate-json", path.join(".candor", "report.json"));
  check("⟨0.28⟩ gate locator: the DISCOVERED report is an input too — byte-identical after `gate --gate-json .candor/report.json` with no --report at all",
        fs.readFileSync(disc, "utf8") === discBefore, fs.readFileSync(disc, "utf8").slice(0, 120));
  check("⟨0.28⟩ gate locator: …and the discovery spelling is refused at exit 2",
        g2.status === 2, `status=${g2.status} ${g2.stderr}`.slice(0, 240));

  // The SIDECAR half of the pair — the worse artifact: before the fix this run SUCCEEDED (exit 1, a
  // real verdict) while replacing the callgraph, so every later `callers`/`tour` read a verdict
  // document where the graph belongs.
  const cgBefore = fs.readFileSync(`${pfx}.callgraph.json`, "utf8");
  const g3 = gate("--report", pfx, "--gate-json", `${pfx}.callgraph.json`);
  check("⟨0.28⟩ gate locator: the report's §2.2 callgraph sidecar is part of what the locator names — byte-identical, refused at exit 2 (before the fix: a REAL verdict here at exit 1)",
        g3.status === 2 && fs.readFileSync(`${pfx}.callgraph.json`, "utf8") === cgBefore,
        `status=${g3.status} ${fs.readFileSync(`${pfx}.callgraph.json`, "utf8").slice(0, 120)}`);

  // THE CONTROL, load-bearing: `<stem>.gate.json` is a sibling matching `<stem>.*.json` — the exact
  // file a fix that guarded "everything sharing the stem" would refuse — and it is the recommended
  // beside-the-report verdict layout (`isReport` excludes it for the same reason). It must still gate,
  // with a REAL verdict, and leave the reports it read untouched.
  const g4 = gate("--report", pfx, "--gate-json", `${pfx}.gate.json`);
  let g4doc = null; try { g4doc = JSON.parse(fs.readFileSync(`${pfx}.gate.json`, "utf8")); } catch { /* null fails below */ }
  check("⟨0.28⟩ gate locator CONTROL: `--gate-json <stem>.gate.json` beside the reports still gates — a violation VERDICT at exit 1, never a refusal (over-refusal here breaks the recommended layout)",
        g4.status === 1 && !!g4doc && g4doc.refused === undefined && Array.isArray(g4doc.violations) && g4doc.violations.length > 0,
        `status=${g4.status} ${JSON.stringify(g4doc)?.slice(0, 160)}`);
  check("⟨0.28⟩ gate locator CONTROL: …and the reports the control run read are byte-identical after it",
        fs.readFileSync(`${pfx}.json`, "utf8") === repBefore, "the control run changed the report");
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ A SYMLINKED SIDECAR IS LEFT ALONE, AND SAID SO (the rust 8094169 ruling) ─────────────────
// This engine resolved the link and deleted its TARGET — a file outside the prefix, the canonical copy
// in a shared-artifact CI layout, unrecoverable because a failing run never restores. And even on
// success, delete-then-restore-by-bytes converts the operator's LINK into a regular file. rust and
// swift leave the link alone; java deleted the link itself (also wrong, fixed in parallel). The rows
// assert the LINK is still a link AND the target's bytes survive — an exit-code assertion cannot see
// either half.
if (blk()) {
  const d = scratch("candor-symside-");
  fs.mkdirSync(path.join(d, "shared"));
  fs.mkdirSync(path.join(d, "work"));
  const src = path.join(d, "work", "app.ts");
  fs.writeFileSync(src, "export function f(): number { return 1 }\n");
  const pfx = path.join(d, "work", "out");
  const run = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), src, ...a], { encoding: "utf8" });
  run("--out", pfx);
  // Replace the callgraph sidecar with a symlink into the shared directory — the layout the ruling
  // exists for: many prefixes, one canonical graph.
  const canonical = path.join(d, "shared", "callgraph.json");
  fs.renameSync(`${pfx}.callgraph.json`, canonical);
  const canonBytes = fs.readFileSync(canonical, "utf8");
  // Relative, and PROVEN to resolve before anything is asserted over it: a dangling link makes the
  // target-intact and link-intact rows below pass VACUOUSLY on a broken engine (measured — the first
  // draft of this block pointed one directory too high and its falsification run passed 2 of 4 rows).
  fs.symlinkSync(path.join("..", "shared", "callgraph.json"), `${pfx}.callgraph.json`);
  check("⟨0.28⟩ symlinked sidecar PREMISE: the link resolves to the canonical file (a dangling link would make every row below vacuous)",
        fs.existsSync(`${pfx}.callgraph.json`) && fs.readFileSync(`${pfx}.callgraph.json`, "utf8") === canonBytes,
        `link resolves=${fs.existsSync(`${pfx}.callgraph.json`)}`);

  const r = run("--out", pfx, "--zzz-not-a-flag");
  check("⟨0.28⟩ symlinked sidecar: a failing run leaves the link's TARGET intact — deleting it destroyed a canonical file OUTSIDE the prefix, unrecoverably",
        fs.existsSync(canonical) && fs.readFileSync(canonical, "utf8") === canonBytes,
        `target exists=${fs.existsSync(canonical)}`);
  check("⟨0.28⟩ symlinked sidecar: …and the LINK is still a symlink at its old path — a severed layout is not recoverable, and a restore-by-bytes would hand back a regular file",
        fs.lstatSync(`${pfx}.callgraph.json`).isSymbolicLink(), "the link is gone or is now a regular file");
  check("⟨0.28⟩ symlinked sidecar: …and it is DISCLOSED as left, with the pair named unanswerable — leaving it silently would let the armed-report/live-sidecar contradiction stand unexplained",
        r.status === 2 && /is a SYMLINK\b/.test(r.stderr) && /unanswerable/.test(r.stderr),
        `status=${r.status} ${r.stderr}`.slice(0, 300));
  // THE CONTROL: a REGULAR sidecar still goes with its armed report — the ruling narrows the delete to
  // what the run owns, it does not turn the ⟨0.28⟩ pairing rule off.
  const locs = `${pfx}.locs.json`;
  check("⟨0.28⟩ symlinked sidecar CONTROL: the sibling REGULAR sidecar of the same armed report is still deleted — the ruling is about links, not about arming",
        !fs.existsSync(locs), "locs.json survived arming");
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE PRE-PASS AGREES WITH THE PARSE LOOP ABOUT WHICH TOKENS CONSUME A VALUE ───────────────
// `--policy --out X`: the loop refuses at `--policy` ("requires a value") and never parses another
// token; the pre-pass skipped on, read `--out X` as a fresh flag, and ARMED X — on an argv the loop
// never accepts, so SPEC §3.3.1 (1)'s precondition ("`--out` has been parsed and accepted") was false
// and X's previous reports became permanent placeholders. The BYTES are the assertion: the run exits 2
// either way, so only the report can tell the fixed engine from the broken one.
if (blk()) {
  const d = scratch("candor-prepass-");
  const src = path.join(d, "app.ts");
  fs.writeFileSync(src, "export function f(): number { return 1 }\n");
  const pfx = path.join(d, "X");
  const run = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), src, ...a], { encoding: "utf8" });
  run("--out", pfx);
  const good = fs.readFileSync(`${pfx}.json`, "utf8");

  const r1 = run("--policy", "--out", pfx);
  check("⟨0.28⟩ pre-pass: `--policy --out X` exits 2 with X's previous report BYTE-IDENTICAL — the loop refuses at `--policy`, so no `--out` was ever accepted and nothing may be armed",
        r1.status === 2 && /--policy requires a value/.test(r1.stderr) && fs.readFileSync(`${pfx}.json`, "utf8") === good,
        `status=${r1.status} armed=${/armed/.test(fs.readFileSync(`${pfx}.json`, "utf8"))}`);
  // THE SIBLING ROUTE — the same disagreement through `--gate-json`'s missing value, because a rule
  // stated over the instance and not the condition is how this family regresses.
  const r2 = run("--gate-json", "--out", pfx);
  check("⟨0.28⟩ pre-pass: `--gate-json --out X` (the sibling value-taking flag) leaves X untouched too — the rule is about value consumption, not about `--policy`",
        r2.status === 2 && fs.readFileSync(`${pfx}.json`, "utf8") === good,
        `status=${r2.status}`);
  // THE CONTROLS: an `--out` the loop ACCEPTED before it died still arms (that is the ⟨0.28⟩ rung
  // working), whether the death is an unknown flag after it or a value-starved flag after it.
  const r3 = run("--out", pfx, "--zzz-not-a-flag");
  check("⟨0.28⟩ pre-pass CONTROL: `--out X --zzz` still arms X — the loop accepted the pair before it died, which is exactly the staleness case the rung exists for",
        r3.status === 2 && /armed/.test(fs.readFileSync(`${pfx}.json`, "utf8")), fs.readFileSync(`${pfx}.json`, "utf8").slice(0, 160));
  run("--out", pfx);   // restore a good report
  const r4 = run("--out", pfx, "--policy");
  check("⟨0.28⟩ pre-pass CONTROL: `--out X --policy` (value-starved flag AFTER the accepted pair) arms X as well — acceptance is decided at the token the loop dies on, not by the run's overall fate",
        r4.status === 2 && /armed/.test(fs.readFileSync(`${pfx}.json`, "utf8")), fs.readFileSync(`${pfx}.json`, "utf8").slice(0, 160));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ SPEC §2 — THE DESCRIPTIVE VERBS CARRY THE ⟨0.21⟩ MANIFEST TOO ────────────────────────────
// The re-disclosure MUST was written over the instance it was found in ("a verb whose VERDICT could
// change") and ⟨0.28⟩ widens it to the condition that makes it true: ANY verb whose output could be read
// as a negative finding — a verdict, an EMPTY RESULT SET, or a ZERO COUNT. MEASURED on this engine before
// the fix, over the standard post-failure artifact (`analyzed.count: 0` + a non-empty `unanalyzed`):
//
//     where Fs {"effect":"Fs","directly":[],"inherited":[]}   map {}   tour {"reaches":[]}
//     blindspots {"sources":[],"totalUnknown":0}   reachable {"entryPoints":0,"effects":{}}
//     containment {"contained":[],"ambient":{}}                     — six flat all-clears, exit 0, no hedge
//
// A matrix rather than six hand-written rows, because the defect IS the missing row: every verb here was
// written by someone who had thought about incompleteness for the verb next to it. Each cell asserts BOTH
// channels and the EXIT, which is the shape the mutants in this family survive through — candor-rust built
// one that kept the whole JSON fix and deleted only the printed line, and it passed that engine's suite.
if (blk()) {
  const d = scratch("candor-desc-");
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as fs from "fs";\n'
    + 'export function leaf(): number { return fs.readFileSync("/etc/hosts").length; }\n'
    + 'export function mid(): number { return leaf(); }\n'
    + 'export function main(): void { console.log(mid()); }\n');
  spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out", path.join(d, "r")], { encoding: "utf8" });
  const intact = JSON.parse(fs.readFileSync(path.join(d, "r.json"), "utf8"));

  // The four artifact states, all derived from ONE real scan so a difference between them is the state and
  // nothing else. `allpure` is the CONTROL that keeps this rung from becoming a hedge on every run: ⟨0.24⟩
  // rules `analyzed.count > 0` with `functions: []` a legitimate purity claim a consumer MUST believe.
  const state = (name, mut) => {
    const dir = path.join(d, name); fs.mkdirSync(dir, { recursive: true });
    const doc = JSON.parse(JSON.stringify(intact)); mut(doc);
    fs.writeFileSync(path.join(dir, "r.json"), JSON.stringify(doc));
    for (const s of ["callgraph", "hierarchy", "locs"]) {
      const from = path.join(d, `r.${s}.json`);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `r.${s}.json`));
    }
    return path.join(dir, "r");
  };
  const armedP = state("armed", (o) => { o.functions = []; o.analyzed = { count: 0 };
                                         o.unanalyzed = [{ path: "src/gone.ts", reason: "parse error" }]; });
  const count0P = state("count0", (o) => { o.functions = []; o.analyzed = { count: 0 }; delete o.unanalyzed; });
  const partialP = state("partial", (o) => { o.unanalyzed = [{ path: "src/gone.ts", reason: "parse error" }]; });
  const pureP = state("allpure", (o) => { o.functions = []; o.analyzed = { count: 7 }; delete o.unanalyzed; });
  const intactP = path.join(d, "r");

  const VERBS = [
    ["where", ["where", "Fs"], /0 functions perform Fs/, /NOT "nothing performs Fs"/],
    ["map", ["map"], /no effectful modules in this report/, /NOT "the code performs no effects"/],
    ["blindspots", ["blindspots"], /no Unknown sources/, /NOT "there are no blind spots"/],
    ["blindspots --stats", ["blindspots", "--stats"], /no Unknown sources \(nothing to classify\)/, /NOT "there are no blind spots"/],
    ["reachable", ["reachable"], /no effect reaches an entry point\./, /NOT "the program performs no effect at runtime"/],
    ["containment", ["containment"], /no boundary effects in this report/, /NOT "there are no boundary effects"/],
    ["tour", ["tour", "3"], /nothing hidden — every effect/, /NOT "nothing is hidden"/],
  ];
  const dq = (verb, pfx, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...verb, "--report", `${pfx}.json`, ...flags], { encoding: "utf8" });

  for (const [label, argv, calmRe, hedgeRe] of VERBS) {
    // A — the manifest reaches the MACHINE channel, under BOTH causes, and the exit does not move. The
    // `judgedNothing`/`unanalyzed` split is asserted per cause because the two want different repairs: one
    // wants a scan that can READ a file, the other a scan that reached a conclusion.
    for (const [cause, pfx, wantUnan] of [["an armed", armedP, true], ["a count-0, NO-`unanalyzed`,", count0P, false]]) {
      const j = dq(argv, pfx, "--json");
      let doc = null; try { doc = JSON.parse(j.stdout); } catch { /* stays null → the row fails loudly */ }
      check(`⟨0.28⟩ ${label} over ${cause} report carries \`incomplete: true\` on the JSON channel — an empty answer over a report that judged nothing is a determined negative it cannot support`,
            !!doc && doc.incomplete === true
              // The ARRAY of report paths — the rust/java/swift wire shape, naming WHICH report judged
              // nothing. This engine shipped `judgedNothing: true` first, and a consumer doing
              // `doc.judgedNothing.length` got a TypeError here while `=== true` missed the other three.
              && Array.isArray(doc.judgedNothing) && doc.judgedNothing.length === 1
              && doc.judgedNothing[0] === `${pfx}.json`
              && (wantUnan ? Array.isArray(doc.unanalyzed) && doc.unanalyzed.length === 1 : !("unanalyzed" in doc)),
            `${j.stdout}`.slice(0, 260));
      // C — exit codes. This rung adds a caveat; it does not refuse. ⟨0.24⟩ ruled count-0 explicitly:
      // "A DISCLOSURE, NOT AN EXIT CODE" — `gate --report` exits 0 over these bytes, and a descriptive
      // verb exiting non-zero would claim it got LESS far than the gate on identical input.
      check(`⟨0.28⟩ …and ${label} still exits 0 over it — the caveat travels, the verdict does not move`,
            j.status === 0, `status=${j.status}`);
      // The OTHER channel, and it is asserted separately on purpose: "no Unknown sources ✓" IS the prose
      // spelling of the empty JSON, so a fix that leaves the sentence standing MOVES the false all-clear.
      const h = dq(argv, pfx, "--text");
      check(`⟨0.28⟩ …and the HUMAN arm of ${label} withdraws its reassurance and prints the INCOMPLETE note ON STDOUT with the answer it qualifies — a caveat on the other stream is one \`2>/dev/null\` from gone (java's words; swift reverted exactly this stderr choice; ts was the last outlier)`,
            hedgeRe.test(h.stdout) && !calmRe.test(h.stdout) && /⚠ INCOMPLETE/.test(h.stdout)
              && !/INCOMPLETE/.test(h.stderr),
            `out=${h.stdout}`.slice(0, 200) + ` err=${h.stderr}`.slice(0, 200));
    }

    // …and the note tells the truth about what CI will do, which is the OPPOSITE for the two causes. §3.3
    // makes `unanalyzed` an exit-2 gate cause; ⟨0.24⟩ makes count-0 an exit-0 one. A warning that sends the
    // reader to a job which then passes teaches them the warning is noise.
    check(`⟨0.28⟩ …and ${label}'s note says the gate REFUSES over \`unanalyzed\` and that NOTHING catches a count-0 report — the two causes get opposite sentences`,
          /gate --report` exits 2 over these bytes/.test(dq(argv, armedP, "--text").stdout)
            && /NOTHING DOWNSTREAM WILL CATCH THIS FOR YOU/.test(dq(argv, count0P, "--text").stdout));

    // B — THE CONTROL. Over an INTACT report the answer is byte-identical, on both channels, and no
    // stderr note appears. candor-rust's first draft of this rung silently RE-SORTED two of these
    // documents on ordinary runs (its serialiser is BTreeMap-backed) — a disclosure rung must not reformat
    // the answers it is disclosing about, and no assertion that reads keys by name can see that.
    const ij = dq(argv, intactP, "--json"), ih = dq(argv, intactP, "--text");
    check(`⟨0.28⟩ CONTROL: ${label} over an INTACT report is UNHEDGED on both channels and exits 0 — a hedge on every run trains the reader to ignore it`,
          ij.status === 0 && !/incomplete/.test(ij.stdout) && !/judgedNothing/.test(ij.stdout)
            && ih.stderr === "" && !hedgeRe.test(ih.stdout),
          `json=${ij.stdout}`.slice(0, 200) + ` err=${ih.stderr}`.slice(0, 160));

    // …and the ⟨0.24⟩ MIRROR CONTROL: a report that judged 7 units and found none of them effectful is
    // making a purity CLAIM, not a silence. Hedging it would withdraw the very claim §2 rule 3 protects
    // (java measured 104 legitimate all-pure reports against 6 harmful count-0 ones).
    const pj = dq(argv, pureP, "--json");
    check(`⟨0.28⟩ CONTROL: ${label} over an ALL-PURE report (\`analyzed.count: 7\`, \`functions: []\`) does NOT hedge — that empty answer is a claim the report is entitled to make`,
          pj.status === 0 && !/incomplete/.test(pj.stdout), `${pj.stdout}`.slice(0, 200));

    // …and the caveat qualifies a NON-EMPTY answer just as much as an empty one: a function in an unread
    // file performs the effect or does not, and no list the verb prints can say which.
    const qj = dq(argv, partialP, "--json");
    let qdoc = null; try { qdoc = JSON.parse(qj.stdout); } catch { /* null → fails loudly */ }
    check(`⟨0.28⟩ ${label} over a report with REAL content that declares \`unanalyzed\` still discloses — the manifest qualifies a non-empty answer too, and carries \`unanalyzed\` without \`judgedNothing\``,
          !!qdoc && qdoc.incomplete === true && qdoc.unanalyzed?.length === 1 && !("judgedNothing" in qdoc),
          `${qj.stdout}`.slice(0, 260));
  }

  // `containment <baseline>` reads TWO locators, and its answer is a DIFFERENCE — unsound if either side
  // is partial, in OPPOSITE directions: a leak in an unread file of the current tree is missed, one in an
  // unread file of the baseline reads as NEWLY APPEARED, at exit 1. The baseline's manifest is the half
  // that arrived here silently (a wholly-empty baseline already fails closed).
  const ratchet = spawnSync("node", [path.join(HERE, "query.mjs"), "containment", `${partialP}.json`,
                                     "--report", `${intactP}.json`, "--json"], { encoding: "utf8" });
  let rdoc = null; try { rdoc = JSON.parse(ratchet.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ containment vs a BASELINE that declares `unanalyzed` discloses the BASELINE's manifest — an unread baseline unit manufactures a leak, the mirror of the one an unread current unit hides",
        !!rdoc && rdoc.incomplete === true && rdoc.unanalyzed?.length === 1 && "leaks" in rdoc,
        `${ratchet.stdout}`.slice(0, 260));
  const ratchetOk = spawnSync("node", [path.join(HERE, "query.mjs"), "containment", `${intactP}.json`,
                                       "--report", `${intactP}.json`, "--json"], { encoding: "utf8" });
  check("⟨0.28⟩ CONTROL: containment vs an INTACT baseline is unhedged and still exits 0 — the ratchet's exit follows the LEAKS, never the caveat",
        ratchetOk.status === 0 && !/incomplete/.test(ratchetOk.stdout), `status=${ratchetOk.status} ${ratchetOk.stdout}`.slice(0, 200));

  // `map`'s top level is a USER NAMESPACE — the one document whose own rows could collide with the keys
  // this rung must add. ⟨0.28⟩ RUNG A DISSOLVES THE COLLISION rather than disclosing it: the caveat
  // REPLACES the module map, so a module named `incomplete` is not displaced by a hedge, it is simply
  // absent along with every other row. The previous shape merged the keys and named the lost row loudly —
  // the best answer available while the caveat had to ride the result, and still a dropped row. The
  // stderr warning is GONE and this row asserts that: a disclosure about a displacement that can no
  // longer happen is the `net-partner` false disclosure pointed backwards.
  const colP = state("collide", (o) => {
    o.functions = o.functions.map((e) => ({ ...e, fn: e.fn.replace(/^src\.app\./, "incomplete.") }));
    o.unanalyzed = [{ path: "src/gone.ts", reason: "parse error" }];
  });
  const col = spawnSync("node", [path.join(HERE, "query.mjs"), "map", "--report", `${colP}.json`, "--json"], { encoding: "utf8" });
  let cdoc = null; try { cdoc = JSON.parse(col.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ Rung A: over a report whose module is literally named `incomplete`, `map` emits the CAVEAT DOCUMENT and nothing else — the collision cannot arise because no module row rides beside the hedge",
        !!cdoc && cdoc.incomplete === true && Array.isArray(cdoc.unanalyzed)
          && Object.keys(cdoc).every((k) => ["incomplete", "unanalyzed", "judgedNothing"].includes(k)),
        `${col.stdout}`.slice(0, 260));
  check("⟨0.28⟩ Rung A: …and the old collision warning is GONE — a stderr disclosure about a displacement that can no longer happen is a false disclosure",
        !/row literally named/.test(col.stderr), `${col.stderr}`.slice(0, 240));

  // ── ⟨0.28⟩ RUNG A, THE OTHER HALF: `show` IS PINNED TO A TOP-LEVEL ARRAY, so it has nowhere to put a
  // caveat KEY at all — and before this rung it carried none on EITHER channel, the only verb of the
  // seven above with no completeness reader whatsoever. MEASURED here 2026-08-12:
  //
  //     show app.save --report <report declaring one unanalyzed unit> --json   →  [ {…} ]   exit 0
  //     show app.save --report <report with analyzed.count: 0>         --json   →  []       exit 0
  //
  // `[]` over a manifest naming a file the scan could not read is *nothing performs this effect*, asserted
  // about code nobody examined. The ruling: emit the CAVEAT DOCUMENT INSTEAD. The TYPE CHANGE is the
  // point — a consumer doing `for (const x of doc)` gets a TypeError rather than a silent zero-iteration
  // loop, which is the one case where breaking a consumer is the correct outcome.
  //
  // The `@`-prefix escape §2.2 uses for sidecars is unavailable, and the ruling names THIS engine for
  // why: `map` is keyed by module names and an npm scoped package is `@scope/name`, so `@incomplete` is a
  // key a real ts module could own.
  {
    const sq = (pfx, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), "show", "app.leaf",
      "--report", `${pfx}.json`, ...flags], { encoding: "utf8" });
    for (const [cause, pfx, key] of [["an `unanalyzed`", partialP, "unanalyzed"],
                                     ["a judged-nothing", count0P, "judgedNothing"]]) {
      const j = sq(pfx, "--json");
      let doc = null; try { doc = JSON.parse(j.stdout); } catch { /* null → the row fails loudly */ }
      check(`⟨0.28⟩ Rung A: \`show\` over ${cause} report emits the CAVEAT DOCUMENT instead of its ARRAY — an array here is the pre-⟨0.28⟩ silent wrong answer, and an OBJECT is the loud stop the ruling asks for`,
            !!doc && !Array.isArray(doc) && doc.incomplete === true && Array.isArray(doc[key])
              && Object.keys(doc).every((k) => ["incomplete", "unanalyzed", "judgedNothing"].includes(k)),
            `${j.stdout}`.slice(0, 260));
      check(`⟨0.28⟩ Rung A: …and \`show\` still exits 0 over ${cause} report — the caveat is a disclosure, not a verdict (⟨0.24⟩)`,
            j.status === 0, `status=${j.status}`);
      const h = sq(pfx, "--text");
      check(`⟨0.28⟩ Rung A: …and the HUMAN arm of \`show\` prints the ⚠ INCOMPLETE note ON STDOUT — it had NO caveat on either channel before this rung`,
            /⚠ INCOMPLETE/.test(h.stdout) && !/INCOMPLETE/.test(h.stderr), `out=${h.stdout}`.slice(0, 220));
    }
    // …and the hedged EMPTY prose stops citing the ⟨0.21⟩ purity convention: over these bytes an absent
    // function is not evidence of purity, and "pure functions are omitted from the report" says it is.
    const eh = spawnSync("node", [path.join(HERE, "query.mjs"), "show", "zzz_no_such_fn",
      "--report", `${count0P}.json`, "--text"], { encoding: "utf8" });
    check("⟨0.28⟩ Rung A: `show`'s empty PROSE arm withdraws the ⟨0.21⟩ purity sentence when hedging — absence from a report that judged nothing licenses no purity claim",
          /licenses no purity claim/.test(eh.stdout) && !/pure functions are omitted/.test(eh.stdout),
          `${eh.stdout}`.slice(0, 240));

    // INTACT-INPUT CONTROL, and it is the row that caught a real regression while this was written: the
    // first draft routed the healthy JSON arm through the key-spreading helper, which turned the pinned
    // top-level array into `{"0": {…}}`. Both shapes AND both channels.
    const cj = sq(intactP, "--json"), ch = sq(intactP, "--text");
    let cdoc2 = null; try { cdoc2 = JSON.parse(cj.stdout); } catch { /* null → fails loudly */ }
    check("⟨0.28⟩ Rung A CONTROL: `show` over an INTACT report keeps its pinned TOP-LEVEL ARRAY, unhedged — the shape moves only on the hedge path",
          Array.isArray(cdoc2) && cdoc2.length === 1 && cdoc2[0].fn === "src.app.leaf" && cj.status === 0,
          `${cj.stdout}`.slice(0, 240));
    check("⟨0.28⟩ Rung A CONTROL: …and its human arm is silent — no note, no stderr, byte-identical to a pre-⟨0.28⟩ run",
          /app\.leaf/.test(ch.stdout) && !/INCOMPLETE/.test(ch.stdout) && ch.stderr === "",
          `out=${ch.stdout}`.slice(0, 200) + ` err=${ch.stderr}`.slice(0, 160));
    const mj2 = spawnSync("node", [path.join(HERE, "query.mjs"), "map", "--report", `${intactP}.json`, "--json"], { encoding: "utf8" });
    let mdoc2 = null; try { mdoc2 = JSON.parse(mj2.stdout); } catch { /* null → fails loudly */ }
    check("⟨0.28⟩ Rung A CONTROL: `map` over an INTACT report keeps its module rows and gains no caveat key",
          !!mdoc2 && !("incomplete" in mdoc2) && Object.keys(mdoc2).length > 0,
          `${mj2.stdout}`.slice(0, 240));
  }

  // ── THE ARRAY EARNS ITS SHAPE ON A MULTI-REPORT LOCATOR: it names WHICH member judged nothing, which
  // `true` never could. PER FILE, the rust/java semantics ("a locator naming several members must
  // disclose EACH silent one by name") — the gate's ANDed boolean is a different question (`did this
  // locator judge ANYTHING`) and keeps its own answer: one member with real judgments means the union
  // judged something, so `gate --report` stays exit 0 while the disclosure still names the silent file.
  {
    const mdir = path.join(d, "multi"); fs.mkdirSync(mdir, { recursive: true });
    const memberDoc = JSON.parse(JSON.stringify(intact));
    fs.writeFileSync(path.join(mdir, "r.aa.scan.json"), JSON.stringify(memberDoc));
    fs.writeFileSync(path.join(mdir, "r.bb.scan.json"),
      JSON.stringify({ candor: memberDoc.candor, functions: [], analyzed: { count: 0 } }));
    const mp = path.join(mdir, "r");
    const mj = spawnSync("node", [path.join(HERE, "query.mjs"), "where", "Fs", "--report", mp, "--json"], { encoding: "utf8" });
    let mdoc = null; try { mdoc = JSON.parse(mj.stdout); } catch { /* null → fails loudly */ }
    check("⟨0.28⟩ a multi-report locator with ONE judged-nothing member hedges and NAMES that member — the per-file semantics the array shape exists for",
          !!mdoc && mdoc.incomplete === true && Array.isArray(mdoc.judgedNothing)
            && mdoc.judgedNothing.length === 1 && mdoc.judgedNothing[0] === path.join(mdir, "r.bb.scan.json")
            && mdoc.directly.length > 0,
          `${mj.stdout}`.slice(0, 280));
    fs.writeFileSync(path.join(mdir, "m.pol"), "deny Net src.app\n");
    const mg = spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", mp,
                                  "--policy", path.join(mdir, "m.pol"), "--gate-json", "-"], { encoding: "utf8" });
    check("⟨0.28⟩ CONTROL: `gate --report` over the same mixed locator still exits 0 with no judged-nothing caveat — the union judged something, and the gate's ANDed question is not this disclosure's per-file one",
          mg.status === 0 && !/judgedNothing/.test(mg.stdout), `status=${mg.status} ${mg.stdout}`.slice(0, 200));
  }

  // ── …AND THE ADVISORY VERBS TAKE THE SECOND CAUSE TOO, WITHOUT MOVING AN EXIT CODE. Their manifest arm
  // has existed since ⟨0.24⟩; the `analyzed.count: 0` arm did not, and a report that judged nothing carries
  // no `unanalyzed` to trip it. MEASURED: `unverified` answered `{ok: true, unverified: []}` over one —
  // the verb whose whole job is "your green gate is not provably green", certifying a package nothing in
  // it ever examined. Leaving these on the old trigger while the descriptive verbs moved would also split
  // the two channels of one document: a remedy list under `ok: true`, beneath an INCOMPLETE note.
  //
  // THE EXIT IS THE CONTROL, AND IT IS THE POINT. ⟨0.24⟩ ruled count-0 "A DISCLOSURE, NOT AN EXIT CODE":
  // `gate --report` exits 0 over these bytes, so a `--strict` advisory verb exiting 2 would claim it got
  // LESS far than the gate on identical input. No conformance part gates this, so it is pinned here.
  fs.writeFileSync(path.join(d, "p.pol"), "deny Net src.app\n");
  const pol = ["--policy", path.join(d, "p.pol")];
  const adv = (verb, pfx, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...verb, "--report", `${pfx}.json`, ...pol, ...flags], { encoding: "utf8" });
  for (const [label, argv] of [["unverified", ["unverified"]], ["fix-gate", ["fix-gate"]], ["whatif", ["whatif", "src.app.mid", "Net"]]]) {
    const j = adv(argv, count0P, "--json");
    let doc = null; try { doc = JSON.parse(j.stdout); } catch { /* null → fails loudly */ }
    check(`⟨0.28⟩ ${label} over a judged-nothing report WITHDRAWS \`ok\` and carries \`incomplete: true\` + \`judgedNothing\` (the array of report paths — one wire spelling across the answer and advisory documents) — the ⟨0.24⟩ manifest arm cannot see this cause, because there is no unread file to name`,
          !!doc && !("ok" in doc) && doc.incomplete === true
            && Array.isArray(doc.judgedNothing) && doc.judgedNothing[0] === `${count0P}.json`
            && !("unanalyzed" in doc),
          `${j.stdout}`.slice(0, 240));
    check(`⟨0.28⟩ …and ${label} says it on the HUMAN channel too — the mutant this family keeps building keeps exactly one of these two`,
          /JUDGED NOTHING/.test(adv(argv, count0P, "--text").stderr), `${adv(argv, count0P, "--text").stderr}`.slice(0, 200));
  }
  for (const label of ["unverified", "fix-gate"]) {
    const s = adv([label], count0P, "--strict", "--json");
    check(`⟨0.28⟩ CONTROL: \`${label} --strict\` over a judged-nothing report still exits 0 — ⟨0.24⟩ ruled this cause a DISCLOSURE, and the gate exits 0 over the same bytes`,
          s.status === 0, `status=${s.status}`);
    const a2 = adv([label], armedP, "--strict", "--json");
    check(`⟨0.28⟩ CONTROL: \`${label} --strict\` over an \`unanalyzed\` report still exits 2 — the manifest arm's exit is untouched by this rung`,
          a2.status === 2, `status=${a2.status}`);
    const c2 = adv([label], intactP, "--strict", "--json");
    check(`⟨0.28⟩ CONTROL: \`${label} --strict\` over an INTACT report carries \`ok\` and no caveat — byte-identical to a pre-⟨0.28⟩ run`,
          !/incomplete/.test(c2.stdout) && /"ok"/.test(c2.stdout) && c2.stderr === "",
          `${c2.stdout}`.slice(0, 200) + ` err=${c2.stderr}`.slice(0, 160));
    const p2 = adv([label], partialP, "--json");
    check(`⟨0.28⟩ CONTROL: \`${label}\` over an \`unanalyzed\`-only report is UNCHANGED — \`incomplete\` + the manifest and NO \`judgedNothing\`, exactly the ⟨0.24⟩ document`,
          !/judgedNothing/.test(p2.stdout) && /"incomplete": true/.test(p2.stdout), `${p2.stdout}`.slice(0, 220));
  }


  // ── …AND `gains`, THE LAST CELL OF THE §2 RE-DISCLOSURE MUST. This verb has carried the CURRENT
  // report's `coverage` ledger since ⟨0.15⟩ — "a no-gains over an uncovered dep reads clean with false
  // confidence" — and MEASURED, the same call on the same report dropped `unanalyzed`, the STRONGER
  // caveat. BOTH SIDES SEPARATELY, because a gains answer rests on two reports that fail differently: an
  // incomplete CURRENT means the gained set may be SHORT, an incomplete BASELINE means the comparison
  // floor is soft and the existing/new `origin` split unreliable. One combined flag would say "something
  // is incomplete" and leave a supply-chain reviewer unable to act. Key names are candor-scan's exactly
  // (fe5d831) — conformance PART 39 greps this wire surface across all four engines.
  const gq = (cur, base, ...flags) =>
    spawnSync("node", [path.join(HERE, "query.mjs"), "gains", `${cur}.json`, `${base}.json`, ...flags], { encoding: "utf8" });
  const gjson = (cur, base, ...flags) => { const r = gq(cur, base, "--json", ...flags);
    let doc = null; try { doc = JSON.parse(r.stdout); } catch { /* null → the row fails loudly */ } return { r, doc }; };

  // The BASELINE half — and the answer under it is `gained: []`, the determined negative this alarm verb
  // exists to license. Only the `baseline*` keys move: the current side is intact and must stay silent.
  {
    const { r, doc } = gjson(intactP, partialP);
    check("⟨0.28⟩ gains over a BASELINE that declares `unanalyzed` carries `baselineIncomplete` + `baselineUnanalyzed` — the comparison floor is soft, so the existing/new origin split is unreliable",
          !!doc && doc.baselineIncomplete === true && doc.baselineUnanalyzed?.length === 1
            && !("incomplete" in doc) && !("unanalyzed" in doc) && Array.isArray(doc.gained),
          `${r.stdout}`.slice(0, 300));
    check("⟨0.28⟩ …and gains still exits 0 over it — advisory by default, and this rung adds a caveat, never a verdict",
          r.status === 0, `status=${r.status}`);
    check("⟨0.28⟩ …and gains says it on the HUMAN channel too — on STDOUT, with the answer it qualifies — naming the BASELINE as the soft half",
          /⚠ INCOMPLETE/.test(gq(intactP, partialP, "--text").stdout)
            && /BASELINE half of this comparison/.test(gq(intactP, partialP, "--text").stdout)
            && !/INCOMPLETE/.test(gq(intactP, partialP, "--text").stderr),
          `${gq(intactP, partialP, "--text").stdout}`.slice(0, 240));
  }
  // The CURRENT half, under BOTH causes — the side that makes the gained set SHORT.
  for (const [cause, pfx, wantUnan] of [["an armed", armedP, true], ["a count-0, NO-`unanalyzed`,", count0P, false]]) {
    const { r, doc } = gjson(pfx, intactP);
    check(`⟨0.28⟩ gains over ${cause} CURRENT report carries \`incomplete: true\` — an empty gained set out of a report that judged nothing is a determined negative it cannot support`,
          !!doc && doc.incomplete === true
            && Array.isArray(doc.judgedNothing) && doc.judgedNothing[0] === `${pfx}.json`
            && (wantUnan ? doc.unanalyzed?.length === 1 : !("unanalyzed" in doc))
            && !("baselineIncomplete" in doc),
          `${r.stdout}`.slice(0, 300));
    check(`⟨0.28⟩ …and gains over ${cause} current still exits 0, and the reassuring "no newly-reached effects ✓" is WITHDRAWN from the prose`,
          r.status === 0 && /NOT "this bump gained nothing"/.test(gq(pfx, intactP, "--text").stdout)
            && !/vs the baseline\. ✓/.test(gq(pfx, intactP, "--text").stdout),
          `status=${r.status} ${gq(pfx, intactP, "--text").stdout}`.slice(0, 240));
  }
  // …and the BASELINE-prefixed spelling of the count-0 cause is the SAME ARRAY SHAPE. `gains` splits by
  // engine exactly the way the plain key did — `gainsCompletenessFields` prefixes whatever
  // `completenessFields` returns, so `baselineJudgedNothing` was a boolean here and an array in java. A
  // supply-chain script written against java's shape threw on this engine's output over identical trees.
  {
    const { r, doc } = gjson(intactP, count0P);
    check("⟨0.28⟩ gains over a count-0 BASELINE carries `baselineJudgedNothing` as the ARRAY of report paths — the same wire shape as the plain key, through the same one reader",
          !!doc && doc.baselineIncomplete === true
            && Array.isArray(doc.baselineJudgedNothing) && doc.baselineJudgedNothing[0] === `${count0P}.json`
            && !("incomplete" in doc) && !("judgedNothing" in doc),
          `${r.stdout}`.slice(0, 300));
  }
  // BOTH sides at once — the two disclosures are SEPARATE keys, not one merged flag.
  {
    const { doc } = gjson(armedP, partialP);
    check("⟨0.28⟩ gains with BOTH sides incomplete discloses them SEPARATELY — a reviewer can tell a short gained set from a soft floor, which one merged `incomplete` could not",
          !!doc && doc.incomplete === true && doc.unanalyzed?.length === 1
            && doc.baselineIncomplete === true && doc.baselineUnanalyzed?.length === 1,
          `${JSON.stringify(doc)}`.slice(0, 300));
  }
  // THE CONTROL: two INTACT reports. Unhedged on both channels — the check that caught candor-rust's
  // BTreeMap re-sort and candor-java's `Map.of` salting on ordinary runs.
  {
    const r = gq(intactP, intactP, "--json"), h = gq(intactP, intactP, "--text");
    check("⟨0.28⟩ CONTROL: gains over two INTACT reports is UNHEDGED on both channels and exits 0 — a hedge on every run trains the reader to ignore it",
          r.status === 0 && !/incomplete/.test(r.stdout) && !/judgedNothing/.test(r.stdout)
            && r.stderr === "" && h.stderr === "" && /vs the baseline\. ✓/.test(h.stdout),
          `json=${r.stdout}`.slice(0, 200) + ` err=${h.stderr}`.slice(0, 160));
    // …and the ⟨0.24⟩ MIRROR CONTROL: an all-pure baseline (`analyzed.count: 7`, `functions: []`) is
    // making a purity CLAIM, not a silence — hedging it would withdraw the claim §2 rule 3 protects.
    const p = gjson(intactP, pureP);
    check("⟨0.28⟩ CONTROL: gains against an ALL-PURE baseline does NOT hedge, and its real gains still stand — that empty baseline is a claim the report is entitled to make",
          !!p.doc && !("baselineIncomplete" in p.doc) && !("incomplete" in p.doc) && p.doc.gained?.length > 0,
          `${p.r.stdout}`.slice(0, 240));
  }
  // THE EXIT IS THE CONTROL. `--strict` keys on the GAINED SET, which this rung does not touch: it still
  // fires over a caveat-bearing pair that gained something, and still does not fire when nothing was
  // gained — including over a judged-nothing current, where ⟨0.24⟩ ruled the cause "a disclosure, not an
  // exit code" and `gate --report` exits 0 over the same bytes.
  check("⟨0.28⟩ CONTROL: `gains --strict` still exits 1 over a caveat-bearing pair that GAINED an effect — the strict exit keys on the gained set, not on the caveat",
        gq(partialP, pureP, "--json", "--strict").status === 1,
        `status=${gq(partialP, pureP, "--json", "--strict").status}`);
  check("⟨0.28⟩ CONTROL: `gains --strict` over a judged-nothing CURRENT still exits 0 — the caveat travels, the verdict does not move",
        gq(count0P, intactP, "--json", "--strict").status === 0,
        `status=${gq(count0P, intactP, "--json", "--strict").status}`);

  // ── THE CORRUPT SIBLING IS THE THIRD CAUSE, AND IT IS NOT `judgedNothing`. MEASURED (candor-spec
  // conformance/gen_key_shapes.py corpus, 2026-08-12): over an intact member with an unparseable `.dep`
  // sibling under the same locator, rust and swift answered `incomplete: true` ALONE, while this engine
  // listed the corrupt file under `judgedNothing` — a fabricated `analyzed.count: 0` claim about bytes
  // nobody could read, sending the reader to "re-scan" when the repair is "fix the corrupt file". And
  // `reportUnanalyzed` skipped the same file with a bare `catch`, so the manifest arm was silent about
  // it by construction. The wire form here is the family's: the flag, no third key.
  {
    const sdir = path.join(d, "corruptsib"); fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "r.aa.scan.json"), JSON.stringify(intact));
    fs.writeFileSync(path.join(sdir, "r.bb.scan.json"), "{ this is not json");
    // The §2.2 sidecars ride along so `fix-gate` (which needs the call graph) answers over this locator
    // for the #79 rows below rather than refusing for a missing sidecar.
    for (const s of ["callgraph", "hierarchy", "locs"]) {
      const from = path.join(d, `r.${s}.json`);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(sdir, `r.${s}.json`));
    }
    const sp = path.join(sdir, "r");
    const sq = (verb, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...verb, "--report", sp, ...flags], { encoding: "utf8" });

    const wj = sq(["where", "Fs"], "--json");
    let wdoc = null; try { wdoc = JSON.parse(wj.stdout); } catch { /* null → fails loudly */ }
    check("⟨0.28⟩ a corrupt sibling under the locator hedges the answer — `incomplete: true`, NO `judgedNothing` (a file whose bytes cannot be read asserted nothing) and NO invented `unanalyzed` row: the wire shape rust and swift already answer",
          !!wdoc && wdoc.incomplete === true && !("judgedNothing" in wdoc) && !("unanalyzed" in wdoc)
            && wdoc.directly.length > 0 && wj.status === 0,
          `status=${wj.status} ${wj.stdout}`.slice(0, 260));

    const uj = sq(["unverified"], ...pol, "--json");
    let udoc = null; try { udoc = JSON.parse(uj.stdout); } catch { /* null → fails loudly */ }
    check("⟨0.28⟩ unverified over the corrupt sibling WITHDRAWS `ok` and keeps its findings — a certification over a member nobody could read is the false all-clear, and a refusal would be less than the partial answer §3.2 asks for",
          !!udoc && !("ok" in udoc) && udoc.incomplete === true && !("judgedNothing" in udoc)
            && Array.isArray(udoc.unverified) && uj.status === 0,
          `status=${uj.status} ${uj.stdout}`.slice(0, 260));
    check("⟨0.28⟩ …and names the corrupt FILE on the human channel with the true gate line — `gate --report` REFUSES over these bytes (exit 2), unlike the count-0 cause",
          /could not be parsed/.test(uj.stderr) && /r\.bb\.scan\.json/.test(uj.stderr)
            && /exits 2 over these bytes/.test(uj.stderr),
          `${uj.stderr}`.slice(0, 300));

    // ⟨0.28⟩ #79 — THE `--strict` EXIT IS BOUNDED BY THE GATE OVER THESE BYTES (SPEC §3.2's pessimism
    // relation). This block first shipped with a control pinning the exit UNCHANGED, while the stderr
    // note two lines up told the reader "`gate --report` exits 2 over these bytes" — the engine asserting
    // the bound on one channel and pinning its violation on another. MEASURED before the fix:
    // `gate --report` exit 2, `unverified --strict` exit 0, `fix-gate --strict` exit 1 (its finding),
    // each claiming it got FURTHER than the gate on identical bytes — and `--strict` is how CI consumes
    // both. The plain (advisory) exit stays 0: only the CI form takes the gate's exit.
    check("⟨0.28⟩ #79 PREMISE: `gate --report` over one good member + one unparsable sibling exits 2 — the bound the strict exits below are measured against",
          spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", sp, ...pol, "--json"], { encoding: "utf8" }).status === 2);
    for (const label of ["unverified", "fix-gate"]) {
      const s = sq([label], ...pol, "--strict", "--json");
      let sdoc = null; try { sdoc = JSON.parse(s.stdout); } catch { /* null → fails loudly */ }
      check(`⟨0.28⟩ #79: \`${label} --strict\` over the corrupt-sibling locator exits 2 — an advisory verb may be LESS certain than the gate, never MORE, and the exit is part of the answer`,
            s.status === 2, `status=${s.status}`);
      check(`⟨0.28⟩ #79: …and the \`${label}\` document still hedges (\`ok\` withdrawn, \`incomplete: true\`) — the exit change rides the document that was already right`,
            !!sdoc && !("ok" in sdoc) && sdoc.incomplete === true, `${s.stdout}`.slice(0, 200));
      check(`⟨0.28⟩ #79 CONTROL: \`${label}\` WITHOUT --strict over the same bytes stays exit 0 — advisory by default`,
            sq([label], ...pol, "--json").status === 0, `status=${sq([label], ...pol, "--json").status}`);
      check(`⟨0.28⟩ #79 CONTROL: \`${label} --strict\` over the INTACT locator stays exit 0 — the corrupt sibling is the only thing that moved it`,
            spawnSync("node", [path.join(HERE, "query.mjs"), label, "--report", intactP, ...pol, "--strict", "--json"], { encoding: "utf8" }).status === 0);
    }

    // A locator whose ONLY member is corrupt REFUSES (exit 2, "refusing to report an empty (all-clear)
    // answer over a corrupt report") — measured, and stronger than a hedge: with zero readable members
    // there is no partial answer to qualify, and an empty document with `incomplete: true` would still
    // read as "nothing performs Fs" to a consumer that never checks the flag. The hedge is for the
    // partial case above; the refusal is for the nothing case, and this pins the line between them.
    const gonly = path.join(d, "corruptonly"); fs.mkdirSync(gonly, { recursive: true });
    fs.writeFileSync(path.join(gonly, "r.aa.scan.json"), "{ nope");
    const go = spawnSync("node", [path.join(HERE, "query.mjs"), "where", "Fs", "--report", path.join(gonly, "r"), "--json"], { encoding: "utf8" });
    check("⟨0.28⟩ a locator whose ONLY member is corrupt still REFUSES loudly (exit 2) — zero readable members leaves no partial answer to hedge, and an empty hedged document would read as an all-clear to a flag-blind consumer",
          go.status === 2 && /refusing to report an empty/.test(go.stderr),
          `status=${go.status} err=${go.stderr}`.slice(0, 220));
  }

  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ AN ADVISORY VERB OVER A CONFIGURED ZERO-RULE POLICY (SPEC §2) ────────────────────────────
// §6.2 makes a configured policy that yields no rules an exit-2 REFUSAL for the GATE, on the ground that
// `ok: true` is a claim about the code no such run is entitled to make. These four verbs share that
// loader and the rung did not touch them. MEASURED here 2026-08-12 over `# no rules yet`:
//
//     whatif      {"of":[…],"affected":[…],"violations":[],"ok":true}          exit 0
//     fix         {"crossing":false,"reason":"not-forbidden"}                  exit 0
//     fix-gate    {"ok":true,"remedies":[]}                                    exit 0 (also --strict)
//     unverified  {"ok":true,"unverified":[]}                                  exit 0 (also --strict)
//
// *not-forbidden* by a policy that forbids nothing is vacuously true — an all-clear produced by deleting
// the question. They are ADVISORY, so the gate's refusal posture is the wrong import: the caveat document
// replaces the result, the result keys are WITHHELD, and the EXIT DOES NOT MOVE.
//
// `fix` IS IN THE LIST BECAUSE THE LIST IS A CONDITION, NOT AN ENUMERATION — §2 names three verbs because
// three were in front of the author, and records the divergence that created (rust extended it, swift read
// the list as closed). Composed with the `crossing` ruling, `fix` emits NO `crossing` key here.
if (blk()) {
  const d = scratch("candor-zerorule-");
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as fs from "fs";\n'
    + 'export function leaf(): number { return fs.readFileSync("/etc/hosts").length; }\n'
    + 'export function mid(): number { return leaf(); }\n'
    + 'export function main(): void { console.log(mid()); }\n');
  spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out", path.join(d, "r")], { encoding: "utf8" });
  const R = path.join(d, "r.json");
  // The three spellings §6.2's refusal covers, so the caveat cannot hold for one and not the others.
  const zero = { comments: "# no rules yet\n", empty: "", junk: "this is a README, not a policy\n" };
  for (const [name, text] of Object.entries(zero)) fs.writeFileSync(path.join(d, `${name}.policy`), text);
  fs.writeFileSync(path.join(d, "real.policy"), "deny Fs\n");
  const q = (argv, pol, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...argv,
    "--report", R, "--policy", path.join(d, `${pol}.policy`), "--json", ...flags], { encoding: "utf8" });
  // `resultKeys` are the keys each verb's own answer document carries — the ones that must be ABSENT.
  const VERBS = [
    ["whatif", ["whatif", "src.app.mid", "Net"], ["ok", "violations", "affected", "of"], []],
    ["fix", ["fix", "src.app.leaf", "Fs"], ["crossing", "reason", "hoistTo", "policyAlternative"], []],
    ["fix-gate", ["fix-gate"], ["ok", "remedies"], ["--strict"]],
    ["unverified", ["unverified"], ["ok", "unverified"], ["--strict"]],
  ];
  for (const [label, argv, resultKeys, strictFlags] of VERBS) {
    for (const pol of Object.keys(zero)) {
      const r = q(argv, pol, ...strictFlags);
      let doc = null; try { doc = JSON.parse(r.stdout); } catch { /* null → the row fails loudly */ }
      check(`⟨0.28⟩ zero-rule: \`${label}\` over a CONFIGURED policy that parsed to no rules (${pol}) emits the CAVEAT DOCUMENT — \`unevaluated\` naming the WHOLE policy, in the spelling the gate's own refusal already uses`,
            !!doc && Array.isArray(doc.unevaluated) && doc.unevaluated.length === 1
              && /^\(entire policy .*— no rules parsed\)$/.test(doc.unevaluated[0].rule)
              && /yielded NO RULES/.test(doc.unevaluated[0].why),
            `${r.stdout}`.slice(0, 260));
      check(`⟨0.28⟩ zero-rule: …and \`${label}\`'s RESULT KEYS are withheld (${resultKeys.join("/")}) — an empty finding list over a policy that asked nothing is ⟨0.27⟩'s \`violations\`-on-a-refusal, one condition over`,
            !!doc && resultKeys.every((k) => !(k in doc)), `${r.stdout}`.slice(0, 260));
      check(`⟨0.28⟩ zero-rule: …and \`${label}\`'s EXIT DOES NOT MOVE (0${strictFlags.length ? ", --strict included" : ""}) — a disclosure, not a verdict; the GATE is the one that refuses (⟨0.24⟩)`,
            r.status === 0, `status=${r.status} err=${r.stderr}`.slice(0, 200));
    }
    // …and the human channel says it too: the mutant this family keeps building keeps exactly one of the
    // two, and candor-rust's survived a whole suite.
    check(`⟨0.28⟩ zero-rule: …and \`${label}\` says it on the HUMAN channel — a JSON-only fix moves the false all-clear rather than removing it`,
          /yielded NO RULES/.test(q(argv, "comments", ...strictFlags).stderr),
          `${q(argv, "comments", ...strictFlags).stderr}`.slice(0, 220));

    // CONTROL: a policy with ONE real rule is byte-identical to a pre-rung run — the caveat fires on the
    // CONDITION (zero rules), never on the presence of a policy.
    const c = q(argv, "real", ...strictFlags);
    check(`⟨0.28⟩ zero-rule CONTROL: \`${label}\` over a policy with a REAL rule carries its result keys and NO caveat — the rule fires on zero rules, not on gating`,
          !/unevaluated/.test(c.stdout) && resultKeys.some((k) => c.stdout.includes(`"${k}"`)),
          `${c.stdout}`.slice(0, 220));
  }
  // The gate ROUTE is the control that pins the spelling: §6.2 refuses there (exit 2) and the entry the
  // refusal carries must be the SAME one the advisory caveat carries, or a cross-engine consumer is
  // reading two names for one condition. Asserted as an EQUALITY, not two regexes.
  const gz = spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", R,
    "--policy", path.join(d, "comments.policy"), "--json"], { encoding: "utf8" });
  const uz = q(["unverified"], "comments");
  let gdoc = null, udoc = null;
  try { gdoc = JSON.parse(gz.stdout); } catch { /* null → fails loudly */ }
  try { udoc = JSON.parse(uz.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ zero-rule: the gate REFUSES (exit 2) and its `unevaluated` entry is CHARACTER-IDENTICAL to the advisory caveat's — one condition, one spelling, so the gate and the advisory verbs describe the same policy in the same words",
        gz.status === 2 && !!gdoc && !!udoc
          && JSON.stringify(gdoc.unevaluated) === JSON.stringify(udoc.unevaluated),
        `gate=${gz.stdout}`.slice(0, 200) + ` adv=${uz.stdout}`.slice(0, 200));
  // A policy that is NOT CONFIGURED is the honest way to say "I am not gating" (§6.2) and is untouched:
  // `whatif` with no policy still answers its blast radius. This is the control that keeps the caveat from
  // swallowing the no-gate case, which is a legitimate expression of intent and the other three refuse.
  const np = spawnSync("node", [path.join(HERE, "query.mjs"), "whatif", "src.app.mid", "Net",
    "--report", R, "--json"], { encoding: "utf8", env: { ...process.env, CANDOR_POLICY: "" } });
  let ndoc = null; try { ndoc = JSON.parse(np.stdout); } catch { /* null → fails loudly */ }
  check("⟨0.28⟩ zero-rule CONTROL: NO policy configured at all is untouched — `whatif` still answers its blast radius, because not configuring a gate is the honest way to say you are not gating (§6.2)",
        np.status === 0 && !!ndoc && Array.isArray(ndoc.affected) && !("unevaluated" in ndoc),
        `${np.stdout}`.slice(0, 220));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE THIRD ROW IS NOT THE FIRST ROW — `noManifest` (SPEC §2) ──────────────────────────────
// §2's three-row table distinguishes `analyzed.count: 0` (row 1 — *nothing was judged*, a claim the
// report MAKES) from `analyzed` ABSENT (row 3 — a pre-⟨0.21⟩ producer with no manifest at all, which
// claims nothing). MEASURED here 2026-08-12 over `{"candor":{…},"functions":[]}` with no `analyzed` key:
//
//   where Fs --json  → {…,"incomplete":true,"judgedNothing":["<the row-3 report>"]}
//   where Fs --text  → "say they JUDGED NOTHING (`analyzed.count: 0`)"
//
// The report declares nothing. The hedge is the right DIRECTION — row 3's own instruction is *no
// manifest, no claim* — but the disclosure is FALSE, and this family rates a false disclosure worse than
// a missing one. It also holed ⟨0.28⟩'s own pin, which defines `judgedNothing` as *reports declaring
// `analyzed.count: 0`*. The repairs differ: row 1 wants a scan that reaches a conclusion, row 3 wants a
// producer that emits a manifest at all.
//
// ROW 2 IS THE CONTROL THAT MAKES ROW 1 AND ROW 3 MEAN ANYTHING (conformance PART 26's CONTROL
// SEPARATION): `count: 7` with `functions: []` is a legitimate all-pure CLAIM a consumer MUST believe,
// and a fix that hedges all three has disabled the feature rather than implemented the rule.
if (blk()) {
  const d = scratch("candor-nomanifest-");
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as fs from "fs";\n'
    + 'export function leaf(): number { return fs.readFileSync("/etc/hosts").length; }\n'
    + 'export function mid(): number { return leaf(); }\n');
  spawnSync("node", [path.join(HERE, "scan.mjs"), d, "--out", path.join(d, "r")], { encoding: "utf8" });
  const intact = JSON.parse(fs.readFileSync(path.join(d, "r.json"), "utf8"));
  const state = (name, mut) => {
    const doc = JSON.parse(JSON.stringify(intact)); mut(doc);
    fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(doc));
    return path.join(d, `${name}.json`);
  };
  const row1 = state("row1", (o) => { o.functions = []; o.analyzed = { count: 0 }; });
  const row3 = state("row3", (o) => { o.functions = []; delete o.analyzed; });
  const row2 = state("row2", (o) => { o.functions = []; o.analyzed = { count: 7 }; });
  // A row-3 report that LISTS functions demonstrably judged units and said so the only way it could —
  // `claimsToHaveJudgedNothing`'s manifest-absent row keeps its standing, so it must not hedge at all.
  const row3full = state("row3full", (o) => { delete o.analyzed; });
  fs.writeFileSync(path.join(d, "policy"), "deny Fs\n");
  const q = (argv, file, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...argv,
    "--report", file, "--json", ...flags], { encoding: "utf8" });
  // THE HUMAN CHANNEL NEEDS ITS OWN HELPER, and the first version of these rows did not have one: `q`
  // always appends `--json`, and `wantJsonOut` keys on the flag being PRESENT, so a trailing `--text`
  // was inert and the "human note" row was asserting about the JSON document. It passed the assertion it
  // was given and measured the wrong channel — caught by the suite, not by the hand-run that preceded it.
  const qt = (argv, file, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...argv,
    "--report", file, "--text", ...flags], { encoding: "utf8" });
  const doc = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const w3 = doc(q(["where", "Fs"], row3));
  check("⟨0.28⟩ noManifest: a report carrying NO `analyzed` key is disclosed under `noManifest`, and is NOT listed under `judgedNothing` — it declares nothing, so saying it declared `analyzed.count: 0` is a FALSE disclosure",
        !!w3 && w3.incomplete === true && Array.isArray(w3.noManifest)
          && w3.noManifest.length === 1 && w3.noManifest[0] === row3 && !("judgedNothing" in w3),
        `${JSON.stringify(w3)}`.slice(0, 260));
  const h3 = qt(["where", "Fs"], row3);
  check("⟨0.28⟩ noManifest: …and the HUMAN note stops asserting `analyzed.count: 0` about it — the repair it points at is a producer that emits a manifest, not a scan that reaches a conclusion",
        /NO `analyzed` manifest/.test(h3.stdout) && !/JUDGED NOTHING/.test(h3.stdout)
          && /⚠ INCOMPLETE/.test(h3.stdout),
        `${h3.stdout}`.slice(0, 300));
  const s3 = doc(q(["show", "src.app.leaf"], row3));
  check("⟨0.28⟩ noManifest: the key rides the Rung A CAVEAT DOCUMENT too — `show` over a row-3 report emits `{incomplete, noManifest}` and nothing else",
        !!s3 && !Array.isArray(s3) && s3.incomplete === true && Array.isArray(s3.noManifest)
          && Object.keys(s3).every((k) => ["incomplete", "noManifest"].includes(k)),
        `${JSON.stringify(s3)}`.slice(0, 240));
  const u3 = q(["unverified"], row3, "--policy", path.join(d, "policy"));
  const u3d = doc(u3);
  check("⟨0.28⟩ noManifest: the ADVISORY document carries it too, `ok` withdrawn — an advisory verb's `ok` is a claim about the CODE, and a report that never emitted a manifest cannot support it",
        !!u3d && !("ok" in u3d) && u3d.incomplete === true && Array.isArray(u3d.noManifest)
          && !("judgedNothing" in u3d),
        `${JSON.stringify(u3d)}`.slice(0, 240));
  check("⟨0.28⟩ noManifest: …and its own sentence on the HUMAN channel, not the judged-nothing one",
        /carry NO `analyzed` manifest at all/.test(u3.stderr) && !/JUDGED NOTHING/.test(u3.stderr),
        `${u3.stderr}`.slice(0, 260));
  check("⟨0.28⟩ noManifest: …and the exit does NOT move (0) — a disclosure, not a verdict, exactly as ⟨0.24⟩ ruled the count-0 arm",
        u3.status === 0, `status=${u3.status}`);

  // ROW 1 keeps its own key: the split has to go BOTH ways or it is a rename, not a distinction.
  const w1 = doc(q(["where", "Fs"], row1));
  check("⟨0.28⟩ noManifest CONTROL: a row-1 report (`analyzed.count: 0`) is STILL `judgedNothing` and is NOT `noManifest` — the split goes both ways or it is a rename",
        !!w1 && Array.isArray(w1.judgedNothing) && w1.judgedNothing[0] === row1 && !("noManifest" in w1),
        `${JSON.stringify(w1)}`.slice(0, 240));
  // ROW 2: the CONTROL SEPARATION arm. Hedging this would withdraw the very claim §2 rule 3 protects.
  const w2 = doc(q(["where", "Fs"], row2));
  check("⟨0.28⟩ noManifest CONTROL SEPARATION: a row-2 report (`count: 7`, `functions: []`) does NOT hedge at all — an all-pure claim a consumer MUST believe; hedging all three rows disables the feature rather than implementing the rule",
        !!w2 && !("incomplete" in w2) && !("noManifest" in w2) && !("judgedNothing" in w2),
        `${JSON.stringify(w2)}`.slice(0, 240));
  // A manifest-less report that LISTS functions judged units the only way it could.
  const w3f = doc(q(["where", "Fs"], row3full));
  check("⟨0.28⟩ noManifest CONTROL: a manifest-less report that LISTS functions is NOT hedged — its entries are the claim it could make, and ⟨0.24⟩'s manifest-absent row keeps its standing",
        !!w3f && !("incomplete" in w3f) && w3f.directly.length > 0, `${JSON.stringify(w3f)}`.slice(0, 240));
  // A locator naming BOTH kinds discloses each under its own key — the whole point of two names.
  {
    const both = path.join(d, "both"); fs.mkdirSync(both, { recursive: true });
    fs.copyFileSync(row1, path.join(both, "r.aa.scan.json"));
    fs.copyFileSync(row3, path.join(both, "r.bb.scan.json"));
    const wb = doc(q(["where", "Fs"], path.join(both, "r")));
    check("⟨0.28⟩ noManifest: a locator naming ONE of each discloses them under SEPARATE keys — one key meaning two things is what loses the distinction the three-row table exists to draw",
          !!wb && wb.judgedNothing?.length === 1 && wb.noManifest?.length === 1
            && wb.judgedNothing[0].endsWith("r.aa.scan.json") && wb.noManifest[0].endsWith("r.bb.scan.json"),
          `${JSON.stringify(wb)}`.slice(0, 300));
  }
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ WHAT EACH LOCATOR FORM RESOLVES TO (SPEC §3.1) ───────────────────────────────────────────
// "AND HERE IS WHAT EACH LOCATOR FORM RESOLVES TO — because 'expand as the loader will' says how to
// compare, and never says what the loader should expand to." Three engines were measured disagreeing,
// and the disagreement was invisible because each was internally consistent. This engine was measured
// CORRECT on all three forms; these rows PIN that, because candor-swift was found unioning where it must
// not and candor-java answering a PREFIX from the lexicographically first file, and "correct today" with
// no row is how a contract drifts back.
//
//   FILE      → that file, and its §2.2 sidecars. NOT the prefix siblings beside it: the operator named
//               one artifact, and reading three would make `--report r.json` mean something different
//               according to what else happens to sit in the directory.
//   PREFIX    → the whole matching set, unioned — for EVERY verb, not just the gate.
//   DIRECTORY → the reports discovered inside it (`<dir>/.candor/report`).
if (blk()) {
  const d = scratch("candor-locator-");
  const pfx = path.join(d, "pfx"); fs.mkdirSync(pfx, { recursive: true });
  const env = { candor: { version: "handwritten", toolchain: "n", spec: "0.27" } };
  const mk = (fn, eff) => ({ ...env, package: "p", functions: [{ fn, loc: "s:1", inferred: [eff], direct: [eff] }], analyzed: { count: 1 } });
  fs.writeFileSync(path.join(pfx, "r.aa.scan.json"), JSON.stringify(mk("aa.one", "Fs")));
  fs.writeFileSync(path.join(pfx, "r.bb.scan.json"), JSON.stringify(mk("bb.two", "Net")));
  fs.writeFileSync(path.join(pfx, "r.aa.scan.callgraph.json"), JSON.stringify({ "aa.one": [], "aa.pureCaller": ["aa.one"] }));
  fs.writeFileSync(path.join(pfx, "r.bb.scan.callgraph.json"), JSON.stringify({ "bb.two": [], "bb.pureCaller": ["bb.two"] }));
  const dir = path.join(d, "dircase"); fs.mkdirSync(path.join(dir, ".candor"), { recursive: true });
  fs.copyFileSync(path.join(pfx, "r.aa.scan.json"), path.join(dir, ".candor", "report.aa.scan.json"));
  fs.copyFileSync(path.join(pfx, "r.bb.scan.json"), path.join(dir, ".candor", "report.bb.scan.json"));
  fs.writeFileSync(path.join(d, "deny-net.policy"), "deny Net\n");
  const q = (argv, loc, ...flags) => spawnSync("node", [path.join(HERE, "query.mjs"), ...argv,
    "--report", loc, "--json", ...flags], { encoding: "utf8" });
  const doc = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const P = path.join(pfx, "r"), FA = path.join(pfx, "r.aa.scan.json");

  const mp = doc(q(["map"], P));
  check("⟨0.28⟩ locator PREFIX: a DESCRIPTIVE verb answers over the WHOLE matching set, unioned — candor-java answered `map`/`where`/`show` from the lexicographically FIRST file, which is two contracts wearing one flag",
        !!mp && "aa" in mp && "bb" in mp, `${JSON.stringify(mp)}`.slice(0, 220));
  check("⟨0.28⟩ locator PREFIX: …and so does the GATE — the `Net` in the second sibling fires (exit 1), which is the arm a first-file reading silently drops",
        (() => { const g = spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", P,
          "--policy", path.join(d, "deny-net.policy"), "--json"], { encoding: "utf8" });
          return g.status === 1 && /bb\.two/.test(g.stdout); })(), "");
  const mf = doc(q(["map"], FA));
  check("⟨0.28⟩ locator FILE: a locator naming ONE FILE resolves to THAT FILE — no sibling union, so `--report r.aa.scan.json` does not change meaning according to what else sits in the directory",
        !!mf && "aa" in mf && !("bb" in mf), `${JSON.stringify(mf)}`.slice(0, 220));
  check("⟨0.28⟩ locator FILE: …and the GATE over it does not see the sibling's violation either (exit 0) — the same expansion on both routes",
        (() => { const g = spawnSync("node", [path.join(HERE, "query.mjs"), "gate", "--report", FA,
          "--policy", path.join(d, "deny-net.policy"), "--json"], { encoding: "utf8" });
          return g.status === 0; })(), "");
  const cf = doc(q(["callers", "aa.one"], FA));
  check("⟨0.28⟩ locator FILE: …but its §2.2 SIDECARS ARE in the expansion — `callers` answers a PURE caller only the call graph knows, so the pair travels with the file",
        !!cf && cf.direct?.includes("aa.pureCaller"), `${JSON.stringify(cf)}`.slice(0, 220));
  const cx = q(["callers", "bb.two"], FA);
  check("⟨0.28⟩ locator FILE: …and NOT the sibling's sidecar — a name only the other pair's graph carries is absent (exit 2), never answered from a file the operator did not name",
        cx.status === 2 && /no function matching/.test(cx.stderr), `status=${cx.status} ${cx.stderr}`.slice(0, 200));
  const cp = doc(q(["callers", "bb.two"], P));
  check("⟨0.28⟩ locator PREFIX: …while the prefix form unions the SIDECARS too, so the same query answers",
        !!cp && cp.direct?.includes("bb.pureCaller"), `${JSON.stringify(cp)}`.slice(0, 220));
  const md = doc(q(["map"], dir));
  check("⟨0.28⟩ locator DIRECTORY: a directory resolves to the reports DISCOVERED inside it (`<dir>/.candor/report`), unioned",
        !!md && "aa" in md && "bb" in md, `${JSON.stringify(md)}`.slice(0, 220));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ A REPEATED `--out` IS REFUSED, AND EVERY PREFIX NAMED GETS THE FAIL-CLOSED REPORT ─────────
// SPEC §3.3.1 settles the question its own rung filed as "deferred" for the report sink while settling
// it for the verdict sink, on no stated ground except which sink was in front of the author. `--out A
// --out B` says where the reports go, twice; the two statements cannot both be honoured. MEASURED here
// 2026-08-12: last-wins at exit 0, with `A.json` BYTE-IDENTICAL to the previous good run — a stale green
// whose reader has no way to learn it lost, and a `gate --report A` over it answers from a scan that
// never ran.
//
// "The fail-closed report at every prefix named" means, under this sink's own arming rules, ARMING each
// prefix: the set at risk is the one the PREVIOUS run left there. The run exits before scanning, so the
// hand-back never runs and the placeholders STAND — the fail-closed reading a run that scanned nothing
// is entitled to. Rows assert the BYTES, not the exit code, because the pre-fix build exits 0 and the
// whole defect is what is left on disk.
if (blk()) {
  const d = scratch("candor-dupout-");
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as nfs from "node:fs";\nexport function save(): void { nfs.writeFileSync("x", "1"); }\n');
  fs.writeFileSync(path.join(d, "deny-fs.policy"), "deny Fs\n");
  const scan = (...a) => spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src"), ...a],
    { encoding: "utf8", cwd: d });
  const A = path.join(d, "A"), B = path.join(d, "B");
  scan("--out", A); scan("--out", B);
  const aBefore = fs.readFileSync(`${A}.json`, "utf8");
  const armed = (f) => { const t = fs.readFileSync(f, "utf8");
    return /"analyzed": \{ "count": 0 \}/.test(t) && /"reason": "armed:/.test(t); };
  const hadSidecar = fs.existsSync(`${A}.callgraph.json`);

  const dup = scan("--out", A, "--out", B);
  check("⟨0.28⟩ repeated --out: the LOSING prefix stops publishing the previous run's report — it holds the ⟨0.21⟩ fail-closed empty, not the stale green it held before the fix",
        armed(`${A}.json`) && fs.readFileSync(`${A}.json`, "utf8") !== aBefore,
        fs.readFileSync(`${A}.json`, "utf8").slice(0, 160));
  check("⟨0.28⟩ repeated --out: …and so does EVERY prefix named, the last one included — 'every path named gets the refusal', in the report sink's spelling",
        armed(`${B}.json`), fs.readFileSync(`${B}.json`, "utf8").slice(0, 160));
  check("⟨0.28⟩ repeated --out: …refused at exit 2 naming both prefixes, never the exit-0 last-wins scan",
        dup.status === 2 && /--out given more than once/.test(dup.stderr)
          && dup.stderr.includes(A) && dup.stderr.includes(B),
        `status=${dup.status} ${dup.stderr}`.slice(0, 260));
  check("⟨0.28⟩ repeated --out: …and the §2.2 sidecars go with the armed reports, so no live call graph is left pairing with a no-claim report",
        hadSidecar && !fs.existsSync(`${A}.callgraph.json`) && !fs.existsSync(`${B}.callgraph.json`),
        `hadSidecar=${hadSidecar}`);
  check("⟨0.28⟩ repeated --out: …and the placeholders STAND — the run exited before scanning, so the hand-back must not restore a previous run's answer as current",
        armed(`${A}.json`) && armed(`${B}.json`), "");

  // The OTHER sinks named in the same argv get their documents too: the rule is about a RUN.
  fs.writeFileSync(path.join(d, "pre.gate.json"), '{"ok":true}');
  const g = scan("--out", A, "--out", B, "--policy", path.join(d, "deny-fs.policy"),
                 "--gate-json", path.join(d, "pre.gate.json"));
  check("⟨0.28⟩ repeated --out: a `--gate-json` file sink in the same argv stops publishing its stale `{\"ok\":true}` — it holds the armed refusal, `ok:false` + `refused:true`",
        g.status === 2 && /"refused": true/.test(fs.readFileSync(path.join(d, "pre.gate.json"), "utf8"))
          && /"ok": false/.test(fs.readFileSync(path.join(d, "pre.gate.json"), "utf8")),
        fs.readFileSync(path.join(d, "pre.gate.json"), "utf8").slice(0, 200));
  const js = scan("--out", A, "--out", B, "--json");
  check("⟨0.28⟩ repeated --out: the `--json` REPORT STREAM carries the fail-closed document naming this cause — never 0 bytes on stdout at exit 2 (§3.3.1 (4))",
        js.status === 2 && /"analyzed": \{ "count": 0 \}/.test(js.stdout)
          && /--out was given more than once/.test(js.stdout),
        `status=${js.status} ${js.stdout}`.slice(0, 220));
  const gs = scan("--out", A, "--out", B, "--policy", path.join(d, "deny-fs.policy"), "--gate-json", "-");
  check("⟨0.28⟩ repeated --out: …and the `--gate-json -` VERDICT STREAM carries the refusal verdict, as the stream's only content",
        gs.status === 2 && /"refused": true/.test(gs.stdout) && /--out was given more than once/.test(gs.stdout),
        `status=${gs.status} ${gs.stdout}`.slice(0, 220));

  // CONTROL 1 — two spellings of ONE prefix are ONE sink (the §3.3.1 artifact rule applied to a prefix),
  // so a legal command is not refused. This is the mirror of the stale green: refusing here would be the
  // hardlink mistake the verdict sink already paid for.
  const one = spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src"), "--out", "A", "--out", "./A"],
    { encoding: "utf8", cwd: d });
  check("⟨0.28⟩ repeated --out CONTROL: `--out A --out ./A` from A's own directory is ONE sink and is NOT refused — artifact identity, not string identity",
        one.status === 0 && /wrote 1 effectful functions/.test(one.stderr),
        `status=${one.status} ${one.stderr}`.slice(0, 220));
  // CONTROL 2 — a SINGLE `--out` is completely unchanged.
  const single = scan("--out", path.join(d, "C"));
  check("⟨0.28⟩ repeated --out CONTROL: a single `--out` still writes its report and exits 0 — the refusal fires on the DUPLICATE, not on the flag",
        single.status === 0 && fs.existsSync(path.join(d, "C.json")), `status=${single.status}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── ⟨0.28⟩ THE VERDICT CARRIES `ignored` — THE POLICY LINES THE PARSE DROPPED (SPEC §6.2) ───────────
// "AND THE CONDITION IS A DROPPED LINE, NOT AN EMPTY POLICY — the clause above is stated over its own
// instance, which is the fifth time in this document." The zero-rule refusal fires only at ZERO
// survivors, so the discontinuity was stark and the wrong way round:
//
//   0 of 10 rules parse  →  exit 2, the fail-closed refusal document
//   1 of 10 rules parse  →  {"ok": true, "violations": []}, exit 0, and the document says NOTHING
//                           about the nine gates that were never asked
//
// A 90%-gateless green, arriving at every fraction below 100%. Refusal is the wrong remedy — it would
// break the forward-compatibility leniency §6.2 has just finished defending — so DISCLOSURE is.
// MEASURED here 2026-08-12: all four warnings on stderr, the verdict document silent on both routes.
//
// `ignored` is DISTINCT from `unevaluated` and the distinction is load-bearing: `unevaluated` carries
// rules that PARSED and could not be answered, `ignored` carries text that never became a rule at all.
if (blk()) {
  const d = scratch("candor-ignored-");
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/app.ts"),
    'import * as nfs from "node:fs";\nexport function save(): void { nfs.writeFileSync("x", "1"); }\n');
  // Three DROPPED lines and one survivor. Every dropped form is a `rule-kind` error — the non-fatal
  // class. A typo'd EFFECT token (`deny Nett app`, `allow Clock foo`) is a policy ERROR at exit 2, not an
  // ignored line, which is the case §6.2 explicitly sets aside; the fatal control below pins that.
  fs.writeFileSync(path.join(d, "drop.policy"),
    "deny Net\nthis line is not a rule\nallow\nforbid nonsense here\n# a comment: not a dropped line\n");
  fs.writeFileSync(path.join(d, "clean.policy"), "deny Fs\n");
  fs.writeFileSync(path.join(d, "fatal.policy"), "deny Fs\nallow Clock foo\n");
  spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src"), "--out", path.join(d, "r")], { encoding: "utf8" });
  const scanGate = (pol, sink) => spawnSync("node", [path.join(HERE, "scan.mjs"), path.join(d, "src"),
    "--policy", path.join(d, pol), "--gate-json", path.join(d, sink)], { encoding: "utf8", cwd: d });
  const verbGate = (pol) => spawnSync("node", [path.join(HERE, "query.mjs"), "gate",
    "--report", path.join(d, "r.json"), "--policy", path.join(d, pol), "--json"], { encoding: "utf8", cwd: d });

  const sc = scanGate("drop.policy", "v.json");
  const v = JSON.parse(fs.readFileSync(path.join(d, "v.json"), "utf8"));
  check("⟨0.28⟩ ignored: a policy with 3 dropped lines and 1 survivor carries them on the VERDICT document — the machine channel, where before the fix only stderr said anything",
        Array.isArray(v.ignored) && v.ignored.length === 3, `${JSON.stringify(v)}`.slice(0, 300));
  check("⟨0.28⟩ ignored: …in the pinned `{line, text, reason}` shape — `line` 1-based, `text` the source line VERBATIM (the operator matches it against their file), `reason` the sentence stderr carries",
        v.ignored?.[0]?.line === 2 && v.ignored[0].text === "this line is not a rule"
          && /DROPPED/.test(v.ignored[0].reason)
          && v.ignored[1].line === 3 && v.ignored[1].text === "allow"
          && v.ignored[2].line === 4 && v.ignored[2].text === "forbid nonsense here",
        `${JSON.stringify(v.ignored)}`.slice(0, 300));
  check("⟨0.28⟩ ignored: …and it is NOT `unevaluated` — that key carries rules that PARSED and could not be answered; a dropped line never became a rule at all, and here the surviving `deny Net` was evaluated normally",
        !("unevaluated" in v) && v.ok === true && sc.status === 0,
        `status=${sc.status} ${JSON.stringify(v)}`.slice(0, 220));
  check("⟨0.28⟩ ignored: …and `ok`/the exit do NOT consult it — the line-level leniency §6.2 defends is unchanged, only disclosed",
        v.ok === true && sc.status === 0, `status=${sc.status} ok=${v.ok}`);

  // §6.2 records this measured on `gate --report` too, and §3.1 makes byte-equality between the two
  // verdict documents the acceptance test — so the key has to land in the same position, not merely be
  // present on both. Asserted as a whole-document equality, which a per-key check cannot see.
  const vb = verbGate("drop.policy");
  check("⟨0.28⟩ ignored: the `gate --report` verdict is BYTE-EQUAL to the scan route's, `ignored` included — a route is not covered by its sibling, and §3.1 binds the two documents",
        vb.status === 0 && vb.stdout === fs.readFileSync(path.join(d, "v.json"), "utf8"),
        `status=${vb.status} ${vb.stdout}`.slice(0, 240));

  // CONTROL 1 — a clean policy's verdict is byte-identical to a pre-⟨0.28⟩ one: the key is OMITTED, not
  // emitted empty. `deny Fs` also FIRES here, so the control covers a non-green verdict as well.
  scanGate("clean.policy", "c.json");
  const c = fs.readFileSync(path.join(d, "c.json"), "utf8");
  check("⟨0.28⟩ ignored CONTROL: a clean policy's verdict carries NO `ignored` key at all — omitted when nothing was dropped, so an ordinary verdict stays byte-identical",
        !/ignored/.test(c) && /"ok": false/.test(c) && /AS-EFF-006/.test(c), `${c}`.slice(0, 200));
  // CONTROL 2 — the case §6.2 sets aside: a typo'd EFFECT token is a policy ERROR at exit 2, not an
  // ignored line. A refused run has no verdict for a dropped line to have shrunk, so `ignored` must not
  // appear there — it would describe a gate that never ran.
  const f = scanGate("fatal.policy", "f.json");
  const fd = fs.readFileSync(path.join(d, "f.json"), "utf8");
  check("⟨0.28⟩ ignored CONTROL: a FATAL policy error still REFUSES (exit 2) and its refusal document carries `unevaluated`, never `ignored` — a refused run has no verdict for a dropped line to have shrunk",
        f.status === 2 && /"refused": true/.test(fd) && /"unevaluated"/.test(fd) && !/"ignored"/.test(fd),
        `status=${f.status} ${fd}`.slice(0, 240));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\ntest: ${pass} passed, ${fail} failed`);
if (fail) keepOnFailure();   // a failing assertion printed a path into one of these trees — keep them
process.exit(fail ? 1 : 0);
