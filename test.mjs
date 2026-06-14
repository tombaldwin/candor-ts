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
  const d = project({
    "package.json": `{"dependencies": {"left-pad": "1.0.0"}}`,
    "src/x.ts": `export function f(): number { return 1; }`,
  });
  const { r } = scan(d);
  check("missing node_modules warns LOUDLY", r.stderr.includes("WARNING") && r.stderr.includes("npm install"));
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
  const r1 = spawnSync("node", [path.join(HERE, "scan.mjs"), app], { encoding: "utf8" });
  const rep1 = JSON.parse(fs.readFileSync(path.join(app, ".candor", "report.json"), "utf8"));
  check("without CANDOR_DEPS the cross-package call is invisible",
        entry(rep1, "src.checkout.buy") == null, JSON.stringify(rep1.functions));
  const r2 = spawnSync("node", [path.join(HERE, "scan.mjs"), app],
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
}
{
  const d = project({
    "src/u.ts": `export function launder(x: unknown): void { (x as any)(); }
export function recv(cb: () => void, other: string): void { cb(); }`,
  });
  const { report } = scan(d);
  check("unknownWhy names the unresolvable callee", 
        entry(report, "src.u.launder")?.unknownWhy?.some((w) => w.startsWith("call:")),
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
  check("an interface with NO implementor stays honest Unknown (dispatch:<Type>)",
        entry(report, "src.app.orphan")?.inferred.includes("Unknown")
        && entry(report, "src.app.orphan")?.unknownWhy?.includes("dispatch:Sink"),
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
  check("effect manifest: a typo'd effect name voids the declaration (f stays pure) and warns",
        !entry(rep2, "app.f") && /candorEffects has an invalid effect/.test(r2.stderr), r2.stderr);
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

console.log(`\ntest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
