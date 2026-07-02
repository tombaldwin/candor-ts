#!/usr/bin/env node
/**
 * Behavioral tests for the candor-ts product surface — small synthetic projects in temp dirs,
 * asserted end to end (the conformance suite covers the cross-engine contract; this covers the
 * product mechanics: multi-file resolution, arrow-const collection, literal surfaces, the gate).
 *
 * Run: node test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { show, loadReport, callersFrontier } from "./query-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
}

function project(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-test-"));
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
{
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
{
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

// ── 2c. a FUNCTION-SCOPED local fn sharing a module unit's name must NOT fabricate (collision fix) ──
// `const persist = arrow` at module scope + a same-named PURE local `const persist` inside another fn
// minted the SAME `mod.persist` key; the second `fns.set` clobbered the first, and the checker-resolved
// LOCAL edge then read the module unit's Fs off the shared entry — FABRICATED onto a pure caller. Found
// by the cross-engine review of candor-rust's qself/macro phantom-edge class (same class, different repo).
{
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
{
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
{
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
{
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

// ── 2b. `show` SURFACES the literal Fs paths + Exec cmds (the regression that shipped) ─────────────
// scan writes the surface under report keys `paths`/`cmds`; `show` once read a nonexistent `e.fs`, so
// it silently dropped every file path even though the MCP `candor_show` doc promises "paths". The CLI
// had its own drifted copy that ALSO dropped `cmds`. One shared show now feeds both; assert it surfaces.
{
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
{
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

// ── 3a. --json: stdout is the §2 envelope and stays PURE JSON — even with a firing policy gate ──────
{
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
{
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
  check("--gate-json verdict declares spec 0.8", v?.spec === "0.8", JSON.stringify(v)?.slice(0, 120));
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
}

// ── 3d. --gate-json robustness: unwritable path never crashes; `-` keeps stdout pure ────────────────
{
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

// ── 3b. single-dash unknown flag is rejected (NOT read as a positional target) ──────────────────────
{
  const bad = spawnSync("node", [path.join(HERE, "scan.mjs"), "-policy", "/nonexistent-xyz"], { encoding: "utf8" });
  check("a single-dash unknown flag (`-policy`) exits 2 as an unknown flag, not a scan target",
        bad.status === 2 && bad.stderr.includes("unknown flag -policy"), bad.stderr.slice(0, 120));
}

// ── masking evasion (the cross-engine HIGH): a benign captured host must NOT certify an invisible
// runtime-host reach; a use-call (write) after a captured connect host must NOT false-positive ──────
{
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
{
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
{
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
{
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
{
  // [31] a local `process` shadow must NOT fabricate Ipc/Clock by callee text.
  const d = project({
    "src/p.ts": `export function f() { const process = { send: (x: number) => x + 1 }; return process.send(41); }`,
  });
  check("[31] local process shadow does not fabricate Ipc", !entry(scan(d).report, "src.p.f"));
}
{
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
{
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
{
  const d = project({
    "src/cb.ts": `export function run(f: () => void): void { f(); }`,
  });
  const { report } = scan(d);
  check("callback param call -> Unknown (never silent-pure)",
        entry(report, "src.cb.run")?.unresolved === true);
}

// ── 5. tsconfig project discovery + test exclusion ────────────────────────────────────────────────
{
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
{
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
{
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
{
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

// ── 9. ambient builtins + crypto tier + the missing-deps warning (CTA dogfood) ───────────────────
{
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
{
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
{
  const d = project({
    "package.json": `{"dependencies": {"left-pad": "1.0.0"}}`,
    "src/x.ts": `export function f(): number { return 1; }`,
  });
  const { r } = scan(d);
  check("missing node_modules warns LOUDLY", r.stderr.includes("WARNING") && r.stderr.includes("npm install"));
}

// ── coverage calibration: effectful npm packages the differential found disclosed-but-unmodeled ───
// Each: the effect-bearing API → its effect, AND a PURE API of the SAME package → pure (no fabrication).
{
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
{
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

// ── 11. cross-package inheritance (CANDOR_DEPS, spec §2 hash) ─────────────────────────────────────
{
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
}

// ── 12. entry points + reachable + unknownWhy + allow-js + import-alias edges ────────────────────
{
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
{
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
{
  const d = project({
    "src/x.js": `import * as fsm from "node:fs";
export function jsRead() { return fsm.readFileSync("/x"); }`,
  });
  const { report } = scan(d, "--allow-js");
  check("--allow-js analyzes JS sources", entry(report, "src.x.jsRead")?.inferred.includes("Fs"),
        JSON.stringify(report?.functions));
}
{
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
{
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
  const { r } = scan(d);
  check("κ ledger names an unlisted package in the receipt",
        /κ doesn't know 1 package/.test(r.stderr) && /leftpad \(1 call\)/.test(r.stderr), r.stderr);
  check("κ ledger stays quiet about reviewed-pure and curated packages",
        !/lodash/.test(r.stderr) && !/node:fs/.test(r.stderr), r.stderr);
}

// ── interface-CHA: a LOCAL interface dispatch resolves to its implementors (the Rust move) ────────
{
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

// ── 11b. the CJS dist chain: a require()-style dep scanned with --allow-js chains the same way ────
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
  // candorEffects: [] is an explicit "declared pure" — covered, NOT a κ blind spot
  const { r: r3 } = scan(project(pkg([])));
  check("effect manifest: candorEffects:[] is declared-pure (covered), not a blind spot",
        !/doesn't know[^\n]*mylib/.test(r3.stderr), r3.stderr);
  // a non-array candorEffects is malformed → warned and ignored, never silently
  const { r: r4 } = scan(project({ ...pkg([]), "node_modules/mylib/package.json": JSON.stringify({ name: "mylib", version: "1.0.0", types: "index.d.ts", main: "index.js", candorEffects: "Net" }) }));
  check("effect manifest: a non-array candorEffects is warned and ignored (not silent)",
        /candorEffects must be an array/.test(r4.stderr), r4.stderr);
}

// ── Exec-cliff refinement (SPEC §4 ⟨0.5⟩): the head is argv[0]; a literal ARGUMENT must not refine ─
{
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
{
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
{
  const Q = await import("./query-core.mjs");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-corrupt-"));
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
// That is FABRICATION — candor's cardinal sin. The rule is now member-aware: construction (token "new")
// is pure; every function/verb member keeps Net (so an unlisted effectful call never under-reports).
// Both directions pinned here (the standalone fabrication_probe.mjs is the broader generative guard).
{
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
// caught it: trustworthy URL predicates call isIP and inherited a phantom Net — the cardinal sin):
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
{
  const Q = await import("./query-core.mjs");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-cgcorrupt-"));
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

// ── decorator-factory effects must NOT be FABRICATED onto the decorated unit (cardinal sin) ───────
{
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
{
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

// ── Object.defineProperty runtime-accessor: a descriptor get/set is invisible to the TS checker (it
// types target.key as a DATA prop), so a forcing site `target.key` read silent-pure — the cardinal sin.
// FIX = mint the descriptor body as a unit + edge the forcing site to it (precise when target+key pin),
// else disclose Unknown (computed key). Controls pin no-fabrication (pure getter / value descriptor).
{
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
{
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
{
  const cg = { "m.Impl.run": ["m.Sink.touch"], "m.Sink.touch": [], "m.Frontier.go": [] };
  const fns = [{ fn: "m.Frontier.go", unknownWhy: ["dispatch:m.Base.run"] }, { fn: "m.Impl.run", unknownWhy: [] }];
  const hier = { "m.Impl": ["m.Base"] }; // Impl <: Base
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

// ── node:vm executes a runtime code STRING → Unknown (the eval-class disclosure). Was silent-pure —
// found by real-world corpus testing (vm is κ-covered @types/node with no rule, so it read pure, not
// invisible). Mirrors eval/Function/import() which already disclose Unknown. ──
{
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
{
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

// @types/X (DefinitelyTyped) maps to the RUNTIME package X so the curated κ tier (keyed by runtime names)
// fires — a curated package typed via @types must NOT read silent-pure. Corpus find: `pool.query()` reported
// pure because the decl resolved to `@types/pg` (not `pg`), so the pg→Db rule never matched. A real TS
// Postgres app MUST have @types/pg installed (pg ships no types), so this was a live silent under-report.
{
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
{
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
{
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
{
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
{
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
{
  for (const flag of ["--help", "-h"]) {
    const r = runScan(flag);
    check(`scan ${flag} → usage with the real flags, exit 0`,
          r.status === 0 && /USAGE:/.test(r.stdout) && /--policy/.test(r.stdout) && /--json/.test(r.stdout),
          `status=${r.status} ${r.stdout.slice(0, 120)}`);
  }
}

// ── CLI-6. unknown flags: a DOUBLE-dash --bogus and a generic SINGLE-dash -x both exit 2 ───────────
// §3b pins `-policy` (a single-dash near-miss of a real flag). These pin the general arms: any
// unrecognized flag — long OR short — is a hard exit-2 unknown-flag error, never a silent scan
// target. The single-dash case is the SHIPPED FIX (a `-x` once fell through to "scan path -x").
{
  const bogus = runScan("--bogus");
  check("scan --bogus (unknown long flag) exits 2 with an unknown-flag error",
        bogus.status === 2 && /unknown flag --bogus/.test(bogus.stderr), `status=${bogus.status} ${bogus.stderr.slice(0, 120)}`);
  const dashX = runScan("-x");
  check("scan -x (unknown SHORT flag) exits 2 — NOT read as a positional scan target (the single-dash fix)",
        dashX.status === 2 && /unknown flag -x/.test(dashX.stderr), `status=${dashX.status} ${dashX.stderr.slice(0, 120)}`);
}

// ── CLI-7. ADVERSARIAL scan inputs: no crash, an honest (loud) disclosure on each pathology ───────
{
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
{
  for (const flag of ["--version", "-V"]) {
    const r = runQuery(flag);
    check(`query ${flag} → version banner, exit 0`,
          r.status === 0 && /candor-ts-query [0-9]/.test(r.stdout.split("\n")[0]), `status=${r.status} ${r.stdout.slice(0, 80)}`);
  }
  for (const flag of ["--help", "-h"]) {
    const r = runQuery(flag);
    check(`query ${flag} → usage, exit 0`, r.status === 0 && /USAGE: candor-ts-query/.test(r.stdout), `status=${r.status} ${r.stdout.slice(0, 80)}`);
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

// ── CLI-9. query.mjs against a CORRUPT/TRUNCATED report → clean handling, never an uncaught throw ──
// query-core's loadReport is unit-pinned (test-unit) to coerce a corrupt report to []; this pins the
// CLI WIRING end to end: a query command over a truncated report must exit cleanly (0), emit valid
// JSON, disclose the corruption on stderr, and NOT leak a readFileSync/JSON.parse stack trace.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-qcorrupt-"));
  fs.writeFileSync(path.join(d, "rep.json"), `{ "candor": {}, "functions": [ { "fn": "x.`); // truncated mid-object
  const prefix = path.join(d, "rep");
  const r = runQuery("show", prefix, "x");
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { /* null → check fails with raw stdout */ }
  check("query show on a CORRUPT report: clean exit 0, valid JSON ([]) on stdout, no uncaught throw",
        r.status === 0 && Array.isArray(parsed) && parsed.length === 0
          && !/\bat \w+ \(.*\.mjs/.test(r.stderr), `status=${r.status} stdout=${r.stdout.slice(0, 80)} stderr=${r.stderr.slice(0, 160)}`);
  check("query show on a CORRUPT report: the corruption is DISCLOSED on stderr (not silently empty)",
        /failed to parse/.test(r.stderr), r.stderr.slice(0, 200));
  // map (a different loadReport consumer) must likewise survive a corrupt report without a stack.
  const rm = runQuery("map", prefix);
  check("query map on a CORRUPT report also exits cleanly with valid JSON (no stack trace)",
        rm.status === 0 && !/\bat \w+ \(.*\.mjs/.test(rm.stderr) && (() => { try { JSON.parse(rm.stdout); return true; } catch { return false; } })(),
        `status=${rm.status} ${rm.stderr.slice(0, 160)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\ntest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
