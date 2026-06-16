#!/usr/bin/env node
/**
 * Soundness fuzzer for candor-ts — the family harness ported (candor-rust soundness/, candor-java
 * soundness/, candor-agents fuzz.py). Generates compilable TS projects that thread a KNOWN effect
 * from a sink up through a chain of call forms — the forms that could hide an edge in TS: direct
 * calls, arrow-consts, method calls, cross-FILE imports, closures, a callback parameter (which must
 * read Unknown), an `any`-typed callee (likewise). Every chain function transitively reaches the
 * effect, so each must be reported with the effect OR Unknown — a chain function reported pure (or
 * omitted) is a SILENT UNDER-REPORT, the bug class this exists to catch. The precision twin: a pure
 * bystander must stay OUT of the report.
 *
 * Run: node fuzz.mjs [N]   (default 25 seeds)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// deterministic seeded RNG (mulberry32) — same-seed reproducibility, like the Rust gen.py
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const SINKS = {
  fs:   { import: `import * as fsm from "node:fs";`, stmt: `fsm.readFileSync("/tmp/x");`, eff: "Fs" },
  net:  { import: `import * as netm from "node:net";`, stmt: `netm.connect(9, "127.0.0.1");`, eff: "Net" },
  exec: { import: `import * as cp from "node:child_process";`, stmt: `try { cp.execSync("true"); } catch {}`, eff: "Exec" },
  env:  { import: ``, stmt: `void process.env.CANDOR_FUZZ;`, eff: "Env" },
  // `eval(code)` runs an arbitrary code string — a code-execution sink that can perform ANY effect, so the
  // sound marker is Unknown (it resolved to a benign es-lib member and read SILENT-PURE before the fix).
  eval: { import: ``, stmt: `void eval("1");`, eff: "Unknown" },
  // browser/runtime NETWORK globals declared in lib.dom (no importable module for κ to key on) — each
  // read SILENT-PURE before the Net-deep fix: the qualified global fetch, XMLHttpRequest, EventSource.
  gfetch: { import: ``, stmt: `void globalThis.fetch("http://h");`, eff: "Net" },
  xhr:    { import: ``, stmt: `const x = new XMLHttpRequest(); x.open("GET", "/"); x.send();`, eff: "Net" },
  sse:    { import: ``, stmt: `void new EventSource("/x");`, eff: "Net" },
};
// Edge forms: how fn i reaches fn i+1 (or the sink). `unknown: true` forms must read Unknown
// instead of (or in addition to) the effect.
const FORMS = ["direct", "arrow_const", "method", "closure", "callback_recv", "any_call",
               "class_prop_arrow", "ctor", "field_init", "iface_dispatch",
               "getter_access", "setter_access", "elem_getter_access", "destr_getter_access",
               "hof_ref", "obj_spread", "fn_call", "fn_apply", "reflect_apply",
               "iter_forof", "using_dispose", "tagged_template", "class_override"];

function genProject(seed) {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 5); // chain length 2..6
  const sink = pick(r, Object.keys(SINKS));
  const multiFile = r() < 0.5;
  const forms = [];
  const files = {};
  const expectUnknown = new Set(); // fns whose form makes Unknown the required marker

  const callExpr = (callee) => `${callee}()`;
  // fn names f00..f(n-1), sink fn "sink"
  const fnName = (i) => (i < n ? `f${String(i).padStart(2, "0")}` : "sink");

  const bodies = [];
  bodies[n] = `export function sink(): void { ${SINKS[sink].stmt} }`;
  for (let i = n - 1; i >= 0; i--) {
    const callee = fnName(i + 1);
    const me = fnName(i);
    const form = pick(r, FORMS);
    forms[i] = form;
    switch (form) {
      case "direct":
        bodies[i] = `export function ${me}(): void { ${callExpr(callee)}; }`;
        break;
      case "fn_call":
        // `callee.call(thisArg)` invokes callee through Function.prototype.call — the receiver IS the
        // invoked reference (was silent-pure: the es-lib CallableFunction.call resolved, callee dropped).
        bodies[i] = `export function ${me}(): void { ${callee}.call(null); }`;
        break;
      case "fn_apply":
        bodies[i] = `export function ${me}(): void { ${callee}.apply(null, []); }`;
        break;
      case "reflect_apply":
        // `Reflect.apply(callee, …)` invokes its FIRST ARGUMENT.
        bodies[i] = `export function ${me}(): void { Reflect.apply(${callee}, null, []); }`;
        break;
      case "arrow_const":
        bodies[i] = `export const ${me} = (): void => { ${callExpr(callee)}; };`;
        break;
      case "method":
        // a class method in the chain; the next caller still calls `me` via a tiny forwarder const
        bodies[i] = `class K${i} { run(): void { ${callExpr(callee)}; } }\n` +
                    `export const ${me} = (): void => { new K${i}().run(); };`;
        break;
      case "closure":
        bodies[i] = `export function ${me}(): void { const c = () => { ${callExpr(callee)}; }; c(); }`;
        break;
      case "callback_recv":
        // the effect reaches `me` ONLY through a callback parameter it invokes → Unknown required
        bodies[i] = `function recv${i}(cb: () => void): void { cb(); }\n` +
                    `export function ${me}(): void { recv${i}(() => { ${callExpr(callee)}; }); }`;
        expectUnknown.add(`recv${i}`);
        break;
      case "class_prop_arrow":
        // the got hole: an arrow-property method was not a unit at all (silent pure)
        bodies[i] = `class P${i} { handler = (): void => { ${callExpr(callee)}; }; }\n` +
                    `export const ${me} = (): void => { new P${i}().handler(); };`;
        break;
      case "ctor":
        // the effect is wired in a CONSTRUCTOR body; `new` must edge to it
        bodies[i] = `class C${i} { constructor() { ${callExpr(callee)}; } }\n` +
                    `export const ${me} = (): void => { void new C${i}(); };`;
        break;
      case "field_init":
        // the silent-pure hole: a FIELD INITIALIZER runs at construction; its effects belong to
        // the (possibly implicit) constructor. The innocent explicit ctor variant alternates in.
        bodies[i] = `class F${i} { x = (() => { ${callExpr(callee)}; return 1; })(); ${i % 2 ? "constructor() {}" : ""} }\n` +
                    `export const ${me} = (): void => { void new F${i}(); };`;
        break;
      case "iface_dispatch":
        // interface-CHA: the call goes through an INTERFACE-typed parameter; the local
        // implementing class's method is the real body. Was a documented Unknown; the CHA
        // resolution must now carry the effect through (and the impl method itself reports it).
        bodies[i] = `interface I${i} { go(): void; }\n` +
                    `class Impl${i} implements I${i} { go(): void { ${callExpr(callee)}; } }\n` +
                    `function via${i}(x: I${i}): void { x.go(); }\n` +
                    `export function ${me}(): void { via${i}(new Impl${i}()); }`;
        break;
      case "getter_access":
        // the silent-pure ACCESSOR hole: a GETTER body reaches the next callee, reached via a
        // PROPERTY READ on an INJECTED instance (the common case — getter's class is passed in, not
        // `new`'d in the same fn, so the effect can't leak to a locally-visible ctor). Pre-fix `me`
        // was OMITTED (silent pure) and the effect was misattributed to G${i}'s constructor.
        bodies[i] = `class G${i} { get val(): number { ${callExpr(callee)}; return 1; } }\n` +
                    `export function ${me}(g: G${i}): number { return g.val; }`;
        break;
      case "setter_access":
        // the setter twin: a SETTER body reaches the next callee, reached via a PROPERTY ASSIGNMENT
        // on an injected instance. Pre-fix `me` was OMITTED (silent pure).
        bodies[i] = `class S${i} { set val(_v: number) { ${callExpr(callee)}; } }\n` +
                    `export function ${me}(s: S${i}): void { s.val = 1; }`;
        break;
      case "hof_ref":
        // the higher-order-function-REFERENCE hole: a local fn passed BY NAME to a non-local HOF
        // (`xs.map(loadFn)`) is invoked by it, but the reference was dropped (only inline closures were
        // walked) → `me` was OMITTED (silent pure). The injected param keeps the effect off any ctor.
        bodies[i] = `function ref${i}(_x: number): number { ${callExpr(callee)}; return 1; }\n` +
                    `export function ${me}(xs: number[]): number[] { return xs.map(ref${i}); }`;
        break;
      case "obj_spread":
        // the object-SPREAD-getter hole: `{ ...o }` copies own enumerable props, INVOKING each getter,
        // but spread was treated as iteration (no [Symbol.iterator]) so the getter body went silent-pure.
        bodies[i] = `class Sp${i} { get v(): number { ${callExpr(callee)}; return 1; } }\n` +
                    `export function ${me}(o: Sp${i}): object { return { ...o }; }`;
        break;
      case "elem_getter_access":
        // the ELEMENT-ACCESS twin of getter_access: a getter reached via `g["val"]` rather than `g.val`.
        // The element-access expr carries no `.name`, so the accessor resolver (keyed on `.name`) missed
        // it and `me` was OMITTED (silent pure) — a desugar hole distinct from dot access.
        bodies[i] = `class Ge${i} { get val(): number { ${callExpr(callee)}; return 1; } }\n` +
                    `export function ${me}(g: Ge${i}): number { return g["val"]; }`;
        break;
      case "destr_getter_access":
        // the OBJECT-DESTRUCTURING twin: `const { val } = g` is a property READ that invokes the getter,
        // but it is a BindingElement (no PropertyAccess/ElementAccess node), so the property-access arm
        // never saw it and `me` was OMITTED (silent pure).
        bodies[i] = `class Gd${i} { get val(): number { ${callExpr(callee)}; return 1; } }\n` +
                    `export function ${me}(g: Gd${i}): number { const { val } = g; return val; }`;
        break;
      case "iter_forof":
        // the desugared-ITERATION hole: a `for-of` over an INJECTED custom iterable lowers to
        // `bag[Symbol.iterator]().next()`. The generator method's body reaches the next callee; the
        // walk never saw the implicit call, so `me` was OMITTED (silent pure). The injected-param
        // instance keeps the effect off any locally-visible ctor — the consumer is the only carrier.
        bodies[i] = `class Bag${i} { *[Symbol.iterator](): Generator<number> { ${callExpr(callee)}; yield 1; } }\n` +
                    `export function ${me}(bag: Bag${i}): void { for (const x of bag) { void x; } }`;
        break;
      case "using_dispose":
        // the `using` hole: `using h = r` GUARANTEES `r[Symbol.dispose]()` at scope exit. The dispose
        // body reaches the next callee through an implicit call the walk missed → `me` was OMITTED.
        bodies[i] = `class Res${i} { [Symbol.dispose](): void { ${callExpr(callee)}; } }\n` +
                    `export function ${me}(r: Res${i}): void { using h = r; void h; }`;
        break;
      case "tagged_template":
        // the tagged-template hole: `` tag`…` `` calls the tag fn, a node form the CallExpression walk
        // never visited → `me` was OMITTED. The tag is a LOCAL fn reaching the next callee.
        bodies[i] = `function tag${i}(s: TemplateStringsArray, ...v: number[]): string { ${callExpr(callee)}; return s.join(""); }\n` +
                    `export function ${me}(): string { return tag${i}\`a \${1} b\`; }`;
        break;
      case "class_override":
        // class-CHA: a SUBCLASS overrides a PURE base method with an effectful body, and the call
        // goes through a BASE-class-typed receiver (a param, OR a branch-merged base|sub local — both
        // resolve statically to the base). The base method is empty, so the ONLY path to the effect is
        // the override fan-out; pre-fix `me` came back concrete-PURE (the silent-pure base-dispatch
        // hole). The override method itself (Sub${i}.act) reports the effect; `me` must read
        // effect-or-Unknown. Two receiver shapes alternate (param vs. branch-merged) to exercise both.
        bodies[i] = `class Base${i} { act(): void {} }\n` +
                    `class Sub${i} extends Base${i} { act(): void { ${callExpr(callee)}; } }\n` +
                    (i % 2
                      ? `export function ${me}(b: Base${i}): void { b.act(); }`
                      : `export function ${me}(flag: boolean): void { const b: Base${i} = flag ? new Base${i}() : new Sub${i}(); b.act(); }`);
        break;
      case "any_call":
        // the callee laundered through `any` → unresolvable → Unknown required for `me`;
        // ALSO keep a real edge so the chain's effect still flows (the Unknown is in addition).
        bodies[i] = `export function ${me}(): void { const a: any = ${callee}; a(); ${callExpr(callee)}; }`;
        expectUnknown.add(me);
        break;
    }
  }
  const bystander = `export function zzBystander(n: number): number { return n * 2; }`;

  if (multiFile) {
    // one module per chain fn, importing the next — cross-file edges under test
    for (let i = 0; i <= n; i++) {
      const me = fnName(i);
      const imp = i < n ? `import { ${fnName(i + 1)} } from "./${fnName(i + 1)}.js";\n` : "";
      const sinkImp = i === n ? SINKS[sink].import + "\n" : "";
      files[`src/${me}.ts`] = sinkImp + imp + bodies[i] + "\n";
    }
    files["src/zz.ts"] = bystander + "\n";
  } else {
    files["src/all.ts"] = SINKS[sink].import + "\n" + bodies.slice().reverse().join("\n") + "\n" + bystander + "\n";
  }
  return { files, n, sink, forms, expectUnknown, multiFile };
}

function runSeed(seed) {
  const { files, n, sink, forms, expectUnknown, multiFile } = genProject(seed);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-fuzz-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const res = spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8" });
  const bad = [];
  const rp = path.join(d, ".candor", "report.json");
  if (!fs.existsSync(rp)) return [`seed ${seed}: scan produced no report: ${res.stderr?.slice(0, 200)}`];
  const report = JSON.parse(fs.readFileSync(rp, "utf8"));
  const by = new Map(report.functions.map((e) => [e.fn.split(".").pop(), e]));
  const eff = SINKS[sink].eff;
  // SOUNDNESS: every chain fn must read effect-or-Unknown — pure/omitted is the bug.
  for (let i = 0; i <= n; i++) {
    const me = i === n ? "sink" : `f${String(i).padStart(2, "0")}`;
    const e = by.get(me);
    if (!e) bad.push(`seed ${seed}: ${me} OMITTED (silent pure; sink=${sink}, form=${forms[i] ?? "-"}, multi=${multiFile})`);
    else if (!e.inferred.includes(eff) && !e.inferred.includes("Unknown"))
      bad.push(`seed ${seed}: ${me} lacks ${eff}/Unknown: ${e.inferred} (form=${forms[i] ?? "-"})`);
  }
  // the Unknown-required forms must actually carry the marker
  for (const me of expectUnknown) {
    const e = by.get(me);
    if (!e || !e.inferred.includes("Unknown"))
      bad.push(`seed ${seed}: ${me} should read Unknown (callback/any form): ${e ? e.inferred : "OMITTED"}`);
  }
  // PRECISION twin: the pure bystander stays out of the report.
  if (by.has("zzBystander")) bad.push(`seed ${seed}: bystander leaked: ${by.get("zzBystander").inferred}`);
  fs.rmSync(d, { recursive: true, force: true });
  return bad;
}

// PRECISION guard for the class-override CHA: the override fan-out must be scoped to the RECEIVER's
// static-type subtree. A SIBLING subclass's effectful override is type-impossible on a path whose
// receiver is statically a NON-overriding sibling, so it must NOT contaminate that path (over-
// reporting on an unreachable receiver — fabrication-adjacent). This is a STANDALONE differential
// (not chain-shaped, since the chain harness requires every fn to carry the effect): one base, one
// EFFECTFUL override (Dog), one PURE sibling (Cat). We assert, in one project:
//   viaBase(a: Animal)   -> Fs       (SOUNDNESS — Dog ∈ Animal-subtree; the override edge is kept)
//   noOverride(c: Cat)   -> PURE     (PRECISION — Dog ∉ Cat-subtree; the sibling override is dropped)
// If the fan-out regressed to ALL overrides, noOverride would wrongly read Fs and this fails.
function runOverrideSiblingPrecision() {
  const bad = [];
  const src = `import * as fsm from "node:fs";
class Animal { speak(): void {} }
class Dog extends Animal { speak(): void { fsm.readFileSync("/tmp/x"); } }
class Cat extends Animal {}
export function viaBase(a: Animal): void { a.speak(); }
export function noOverride(c: Cat): void { c.speak(); }
`;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-fuzz-sib-"));
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "sib.ts"), src);
  const res = spawnSync("node", [path.join(HERE, "scan.mjs"), d], { encoding: "utf8" });
  const rp = path.join(d, ".candor", "report.json");
  if (!fs.existsSync(rp)) {
    bad.push(`override-sibling: scan produced no report: ${res.stderr?.slice(0, 200)}`);
  } else {
    const by = new Map(JSON.parse(fs.readFileSync(rp, "utf8")).functions.map((e) => [e.fn.split(".").pop(), e]));
    const via = by.get("viaBase");
    if (!via || !via.inferred.includes("Fs")) // SOUNDNESS: base-typed receiver MUST keep the override effect
      bad.push(`override-sibling: viaBase lost the override effect (expected Fs): ${via ? via.inferred : "OMITTED"}`);
    if (by.has("noOverride")) // PRECISION: a non-overriding subclass receiver must NOT get the sibling's effect
      bad.push(`override-sibling: noOverride contaminated by sibling override (expected PURE): ${by.get("noOverride").inferred}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
  return bad;
}

const N = Number(process.argv[2] ?? 25);
let fails = [];
fails = fails.concat(runOverrideSiblingPrecision());
for (let seed = 1; seed <= N; seed++) fails = fails.concat(runSeed(seed));
for (const b of fails) console.log(`  ${b}`);
const failedSeeds = new Set(fails.map((f) => f.split(":")[0]));
console.log(`fuzz: ${N - failedSeeds.size} seeds passed, ${failedSeeds.size} failed`);
process.exit(fails.length ? 1 : 0);
