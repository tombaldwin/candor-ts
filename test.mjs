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

// ── 2b. SETUP split (⟨0.19⟩, SPEC §6.2 §3): a declared-but-uninstalled dep tags no-node_modules (setup) ──
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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

// ── 2f-septies (c). the ⟨0.21⟩ `unanalyzed` manifest, read four ways ──────────────────────────────
// `21277eb` withheld coverage from a dep report that declares itself incomplete. It asked
// `Array.isArray(u) && u.length > 0`, which reads `"unanalyzed": "oops"` and `"unanalyzed": {}` as
// COMPLETE — so a report that GARBLES its completeness claim bought the coverage a report that states
// it plainly is refused. Same door, reopened by a malformed key, and a fail-OPEN.
//
// java and rust (candor-rust `dbab8be`) both fail closed here; ts and swift did not. Coverage is the
// claim that an ABSENT entry is the dep's own purity claim (SPEC §2 rule 3), so an unreadable
// completeness claim must buy nothing — the posture this file already takes on a malformed `inferred`.
{
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
{
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

// ── 3n. NAMESPACE layers are name segments (the family ruling) ─────────────────────────────────────
// §6.2 scope segments split on the same boundaries as the §3.1 name ladder, and a namespace is a
// segment — rust modules and swift enum-namespaces already behave this way. Before this, a unit in
// `export namespace app { … }` was named `mod.fn` (namespace DROPPED), so `forbid app -> repo` /
// `deny Fs app` against namespace layers was silently inert while the same policy bit on directory
// layers. The fix is in the NAMING (report-affecting: `fn` gains the namespace segments); the §2
// hash keeps the bare local name so cross-package report chaining is unaffected.
{
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

// ── 3o. `pure` forbids every EFFECT — not `Unknown` (the family ruling) ─────────────────────────────
// Unknown is the §4 trust marker, not an effect: the reference engine (candor-java) and the rust deep
// engine exclude it from a `pure` rule's hits, and `deny Unknown <scope>` is the explicit knob for
// scopes that must exclude uncertainty (AS-EFF-003's concern). candor-ts wrongly counted an
// Unknown-only fn as a `pure` violation until 2026-07-09 — a cross-engine verdict split on the same
// policy. Effectful fns still trip `pure`; deny Unknown still fires.
{
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
  check("--gate-json verdict declares spec 0.23", v?.spec === "0.23", JSON.stringify(v)?.slice(0, 120));
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
{
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
{
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

// ── 3e. .candor/config (§config): target-anchored, env-overridden, fail-closed ─────────────────────
{
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
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-basever-"));
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

// ── 8b. TOP-LEVEL executable statements attribute to a synthesized `<module>` unit (the ESM
// top-level-await / serverless-handler silent-pure hole: a file whose top-level body does I/O was
// scanned as functions:[] → a false "pure" verdict that a `deny Llm`/`deny Fs` gate PASSED). The
// module body is the file's own initializer — the field-init `Class.constructor` synthesis one level
// up. Minted LAZILY, unitKind "initializer" (spec §2, java's `<clinit>` twin). ──────────────────
{
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
{
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
{
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
{
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
{
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

// ── ⟨0.13⟩ Llm: model-host refinement + model-SDK surface + the deny/allow gate (SPEC §1) ───────────
{
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
{
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
{
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
  const eng = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-mutant-"));
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
{
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
}

// ── 11a. ⟨0.21⟩ a chained report that DECLARES ITSELF INCOMPLETE grants no coverage ───────────────
// §2 rule 3 turns a report's silence into a purity claim. A report carrying `unanalyzed` has just said it
// never read some of its own source, so its silence about that source answers nothing — the same split
// `651c9f9` made for a report that fails the §2.1 version check, through a different door.
{
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

// ── 11b. ⟨0.20⟩ the dep's Net-surface INCOMPLETENESS crosses the boundary with its hosts ──────────
// A trust marker failing OPEN at the scan boundary: `hosts` is a LOWER bound and `netClass`'s
// `unknown-host` is the producer's published judgment that it is one. The join copied the literals and
// not the judgment, so the consumer re-derived `netClass` from a partial surface and certified it.
{
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
// ⟨0.15 staged⟩ the coverage envelope is OMITTED when nothing is uncovered — a fully-covered report is
// byte-identical to a ⟨0.14⟩ one (the wire-compatibility half of the rung), and an UNRESOLVABLE import
// keeps the stronger `Unknown` posture without joining the ledger (no node_modules path to count).
{
  const d = project({
    "src/c.ts": `import * as fsm from "node:fs";
export function covered(): Buffer { return fsm.readFileSync("/x"); }`,
  });
  const { report } = scan(d);
  // ⟨0.22⟩ the completeness manifest ALWAYS appends `analyzed:{count,digest}`; a fully-covered/complete
  // scan still omits `coverage` and `unanalyzed` (both empty), so the wire stays byte-compatible bar the
  // additive `analyzed` sibling.
  check("⟨0.15⟩ a fully-covered scan OMITS the coverage envelope key entirely",
        report !== null && !("coverage" in report) && !("unanalyzed" in report)
          && JSON.stringify(Object.keys(report)) === JSON.stringify(["candor", "package", "functions", "analyzed"]),
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
{
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
{
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
{
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
// That is FABRICATION — the precision failure, the opposite direction from candor's cardinal sin (the
// silent under-report). The rule is now member-aware: construction (token "new")
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

// ── decorator-factory effects must NOT be FABRICATED onto the decorated unit (fabrication) ───────
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

// ── sync-callback-invoker: an OPAQUE callback to a sync HOF (forEach/map/…) must disclose Unknown ────
// A `(x)=>void` PARAMETER (or an `any`-typed callable) handed to `Array.prototype.forEach` & friends is
// INVOKED by the HOF — but the es-lib signature resolved the CALLEE, so the reference dropped silent-pure
// (`arr.forEach(cb)` read PURE though `cb` runs caller-supplied code — the cardinal sin). This is the TS
// arm of a four-way sync-callback-invoker parity fix (candor-java shipped it as c755acd / SYNC_CALLBACK_
// INVOKERS). CRUCIAL GUARD: only OPAQUE callbacks disclose — an INLINE arrow keeps its analyzed effect and
// a resolvable NAMED fn keeps its resolved effect (no flood of the overwhelming-majority inline shape).
{
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
{
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

// ── process.env READ idioms → Env: not just the direct `process.env.KEY` dot access, but bracket access,
// a local const-alias of process.env, destructuring a key off it, and the `in` membership test. Each of
// these read SILENT-PURE before (dogfound on chalk/supports-color, which reads env via `const {env} =
// process; 'FORCE_COLOR' in env; env.TERM`). SOUNDNESS: the same idiom on a NON-process.env object stays
// pure (no fabrication), and a reassigned alias local is cleared. ──────────────────────────────────────
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
          r.status === 0 && /USAGE\n/.test(r.stdout) && /--policy/.test(r.stdout) && /--json/.test(r.stdout),
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
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-qcorrupt-"));
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
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-cliarms-"));
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

  fs.rmSync(d, { recursive: true, force: true });
}

// ── CLI-11. `tour`: the missing-sidecar fallback + N validation (the surface-port review fixes) ─────
// The scan-time note surfaces the single best reach; `tour` is its on-demand top-N form (SURFACE-BEST-
// FIND-DESIGN.md P2). Two cardinal-sin holes the review flagged in the port: (a) with the callgraph
// sidecar deleted, `tour` built `calls` ONLY from the sidecar, found nothing, and printed a FALSE
// "nothing hidden" at exit 0 — a silent under-report; the fix falls back to each entry's inline `calls`
// (mirrors tour.rs). (b) `tour 0`/an out-of-range N printed the same false all-clear instead of a usage
// error; the fix rejects it (exit 2). Also pins the alphabetical --json keys + the package-named header.
{
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
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-missarg-"));
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
{
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
// ("spec 0.23", no stale generation strings — AGENTS.md shipped "spec 0.7" examples a full generation
// after the 0.8 roll) and, wherever they lean on the reference engine, attribute it (candor-java IS
// the reference — the family ruling the baseline/pure semantics cite).
{
  for (const f of ["README.md", "AGENTS.md"]) {
    const doc = fs.readFileSync(path.join(HERE, f), "utf8");
    check(`${f} states the current spec contract (spec 0.23)`, doc.includes("spec 0.23"));
    const stale = doc.match(/spec 0\.[0-7]\b|spec 0\.9\b|spec 0\.1[0-5]\b/g) ?? [];
    check(`${f} carries no stale spec-generation string`, stale.length === 0, JSON.stringify(stale));
    const refLines = doc.split("\n").filter((l) => /reference engine/i.test(l));
    check(`${f} mentions the reference engine at least once`, refLines.length > 0);
    check(`${f}: every "reference engine" mention attributes candor-java`,
          refLines.every((l) => /candor-java/.test(l)),
          JSON.stringify(refLines.filter((l) => !/candor-java/.test(l))));
  }
}

// ── candor verify: the dynamic honesty oracle, end to end (scan → run → check) ────────────────────
{
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
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "candor-verify-seed-"));
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
    const tSeedDir = fs.mkdtempSync(path.join(os.tmpdir(), "candor-verify-tseed-"));
    const tseeded = structuredClone(trep);
    for (const e of tseeded.functions) if (e.fn === "t.middle") e.inferred = [];
    fs.writeFileSync(path.join(tSeedDir, "t.seed.scan.json"), JSON.stringify(tseeded));
    const ts = tVerify(path.join(tSeedDir, "t"));
    let tsj = null; try { tsj = JSON.parse(ts.stdout); } catch { /* below */ }
    check("verify: a TRANSITIVE-caller miss (caller declared pure, reaches Fs through a callee) VIOLATES on the caller",
      ts.status === 1 && (tsj?.violations || []).some((v) => v.fn === "t.middle" && v.escaped?.includes("Fs")),
      `exit=${ts.status} out=${(ts.stdout || "").slice(0, 300)}`);
    // (c) DISCLOSURE FLIPS IT — the same run under an `Unknown` disclosure HOLDS (disclosed-partial).
    const discDir = fs.mkdtempSync(path.join(os.tmpdir(), "candor-verify-disc-"));
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
    const nSeedDir = fs.mkdtempSync(path.join(os.tmpdir(), "candor-verify-nseed-"));
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
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "candor-verify-empty-"));
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
{
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
{
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
{
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
{
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
{
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

console.log(`\ntest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
