#!/usr/bin/env node
// The SITE TABLE oracle (call-target round 2). Answers, by EXECUTING the platform, the question the implicit readers
// used to answer from hand lists: at which syntax forms and which builtin call positions does ECMAScript invoke a
// member the program may supply (a coercion hook, an iterator, `then`, `toJSON`, an own getter, a looked-up accessor,
// a setter, `[Symbol.hasInstance]`)?
//
// A PROBE is an object whose every hook records that it ran. The oracle puts it in each position of each syntax form
// (operator grids come from TypeScript's own SyntaxKind ranges) and each argument / receiver-element position of each
// ECMA-262 builtin reachable from the global object (static members, prototype members, call and construct
// signatures), drains the microtask queue, and records which hooks RAN. Every row of the table is an observed
// invocation; a position where nothing ran is absent. Run under the pinned node.
//
//   node oracle.cjs            print the table as JSON
//   node oracle.cjs --check F  regenerate and compare with the table embedded in F (scan.mjs); exit 1 on a difference
"use strict";
const path = require("path");
const fs = require("fs");
const ts = require(path.join(__dirname, "..", "..", "node_modules", "typescript"));

// ------------------------------------------------------------------ the probe
// Variants, unioned: P has `[Symbol.toPrimitive]`; V's `valueOf` returns an object so `toString` runs after it; S's
// `toString` returns an object so `valueOf` runs after it. Own enumerable getter `g` (a copy runs it), prototype getter
// `h` and setter `h` (a lookup runs them, a copy does not).
let LOG = null;
const rec = (h) => { if (LOG) LOG.add(h); };
const PROTO = {
  get h() { rec("get:proto"); return 1; },
  set h(v) { rec("set:proto"); },
};
function probe(variant) {
  const o = Object.create(PROTO);
  Object.defineProperty(o, "g", { enumerable: true, configurable: true, get() { rec("get:own"); return 1; }, set(v) { rec("set:own"); } });
  o.valueOf = function () { rec("valueOf"); return variant === "V" ? {} : 1; };
  o.toString = function () { rec("toString"); return variant === "S" ? {} : "s"; };
  o.toLocaleString = function () { rec("toLocaleString"); return "s"; };
  o.toJSON = function () { rec("toJSON"); return 1; };
  o.then = function (r) { rec("then"); if (typeof r === "function") r(1); };
  o[Symbol.iterator] = function* () { rec("[Symbol.iterator]"); yield 1; };
  o[Symbol.asyncIterator] = async function* () { rec("[Symbol.asyncIterator]"); yield 1; };
  o[Symbol.hasInstance] = function () { rec("[Symbol.hasInstance]"); return false; };
  for (const sy of ["match", "matchAll", "replace", "search", "split"])
    o[Symbol[sy]] = function () { rec(`[Symbol.${sy}]`); return sy === "split" ? [] : null; };
  if (variant === "A") delete o[Symbol.asyncIterator];
  if (variant === "J") delete o.toJSON;
  if (variant === "L") delete o.toLocaleString;
  if (variant === "P") o[Symbol.toPrimitive] = function () { rec("[Symbol.toPrimitive]"); return 1; };
  // the copy hooks are recorded only for own ENUMERABLE members: the probe's method hooks are own and enumerable,
  // which a copy reads as data (never calling them) — what a copy RUNS is only `get:own`.
  return o;
}
// A: no `[Symbol.asyncIterator]` (for-await falls back to the sync iterator); J: no `toJSON` (JSON.stringify then reads
// the own enumerable properties); L: no own `toLocaleString` (the inherited one calls `toString`).
const VARIANTS = ["P", "V", "S", "A", "J", "L"];
const tick = () => new Promise((r) => setImmediate(r));
async function observe(fn) {
  const out = new Set();
  for (const v of VARIANTS) {
    LOG = new Set();
    // a returned PROMISE is drained; a returned probe is not touched (calling its `then` here would be the oracle's
    // own invocation, not the platform's)
    try { const r = fn(probe(v)); if (r instanceof Promise) r.then(() => {}, () => {}); } catch { /* a throw after a hook ran still counts */ }
    await tick(); await tick();
    for (const h of LOG) out.add(h);
    LOG = null;
  }
  return [...out].sort();
}

// ------------------------------------------------------------------ syntax grid
// Each row: [table key, role, source of a function of (x) that places the probe in that role]. The operator rows come
// from TypeScript's own binary / prefix / postfix operator ranges; the rest is ECMA-262's statement and expression
// grid for forms that take an operand value.
const syntaxRows = [];
const K = ts.SyntaxKind;
// the SyntaxKind NAME of a token (the enum carries range aliases — FirstBinaryOperator, LastCompoundAssignment — on
// the same values; the table keys on the token's own name, which is what `ts.SyntaxKind[op]` means to a reader)
const kindName = (k) => Object.keys(K).find((n) => K[n] === k && !/^(First|Last)/.test(n));
for (let k = K.FirstBinaryOperator; k <= K.LastBinaryOperator; k++) {
  const t = ts.tokenToString(k);
  if (!t || t === "=" || t === ",") continue;
  // only a token TypeScript itself parses as the operator of a BinaryExpression (the range also holds `</`, `=>`, …)
  const e = ts.createSourceFile("o.ts", `x ${t} 1`, ts.ScriptTarget.Latest).statements[0]?.expression;
  if (!e || !ts.isBinaryExpression(e) || e.operatorToken.kind !== k) continue;
  const name = `BinaryExpression:${kindName(k)}`;
  const isAssign = k >= K.FirstCompoundAssignment && k <= K.LastCompoundAssignment;
  if (isAssign) {
    syntaxRows.push([name, "left", `let v = x; v ${t} 1;`]);
    syntaxRows.push([name, "right", `let v = 1; v ${t} x;`]);
  } else {
    syntaxRows.push([name, "left", `void (x ${t} 1);`]);
    syntaxRows.push([name, "right", `void (1 ${t} x);`]);
  }
}
// `in` and `instanceof` are binary operators outside the token range
syntaxRows.push(["BinaryExpression:InKeyword", "left", "void (x in {});"], ["BinaryExpression:InKeyword", "right", 'void ("g" in x);'],
  ["BinaryExpression:InstanceOfKeyword", "left", "void (x instanceof Object);"], ["BinaryExpression:InstanceOfKeyword", "right", "void ({} instanceof x);"]);
for (const [k, t] of [[K.PlusToken, "+"], [K.MinusToken, "-"], [K.TildeToken, "~"], [K.ExclamationToken, "!"]])
  syntaxRows.push([`PrefixUnaryExpression:${kindName(k)}`, "operand", `void (${t}x);`]);
for (const [k, t] of [[K.PlusPlusToken, "++"], [K.MinusMinusToken, "--"]]) {
  syntaxRows.push([`PrefixUnaryExpression:${kindName(k)}`, "operand", `let v = x; ${t}v;`]);
  syntaxRows.push([`PostfixUnaryExpression:${kindName(k)}`, "operand", `let v = x; v${t};`]);
}
syntaxRows.push(
  ["TypeOfExpression", "expression", "void (typeof x);"],
  ["VoidExpression", "expression", "void x;"],
  ["TemplateExpression", "span", "void `${x}`;"],
  ["TaggedTemplateExpression", "span", "void ((s, ...a) => 0)`${x}`;"],
  ["ForOfStatement", "expression", "for (const v of x) void v;"],
  ["ForInStatement", "expression", "for (const k in x) void k;"],
  ["SpreadElement", "expression", "void [...x];"],
  ["SpreadElement:call", "expression", "((...a) => 0)(...x);"],
  ["SpreadAssignment", "expression", "void ({ ...x });"],
  ["ArrayBindingPattern", "initializer", "const [a] = x; void a;"],
  ["ArrayLiteralExpression:assign", "right", "let a; [a] = x; void a;"],
  ["ObjectBindingPattern:key-own", "initializer", "const { g } = x; void g;"],
  ["ObjectBindingPattern:key-proto", "initializer", "const { h } = x; void h;"],
  ["ObjectBindingPattern:rest", "initializer", "const { ...r } = x; void r;"],
  ["ObjectLiteralExpression:assign-rest", "right", "let r; ({ ...r } = x); void r;"],
  ["PropertyAccessExpression:own", "expression", "void x.g;"],
  ["PropertyAccessExpression:proto", "expression", "void x.h;"],
  ["PropertyAccessExpression:assign", "expression", "x.h = 1;"],
  ["ElementAccessExpression", "argumentExpression", "void ({})[x];"],
  ["ComputedPropertyName", "expression", "void ({ [x]: 1 });"],
  ["ConditionalExpression", "condition", "void (x ? 1 : 2);"],
  ["IfStatement", "expression", "if (x) {}"],
  ["SwitchStatement", "expression", "switch (x) { case 1: break; }"],
  ["CaseClause", "expression", "switch (1) { case x: break; }"],
  ["ReturnStatement", "expression", "return x;"],
  ["ThrowStatement", "expression", "try { throw x; } catch {}"],
  ["ArrayLiteralExpression", "element", "void [x];"],
  ["ObjectLiteralExpression", "value", "void ({ a: x });"],
);
const asyncRows = [
  ["AwaitExpression", "expression", "await x;"],
  ["ForOfStatement:await", "expression", "for await (const v of x) void v;"],
  ["ReturnStatement:async", "expression", "return x;"],
];
const genRows = [["YieldExpression:asterisk", "expression", "yield* x;"], ["YieldExpression", "expression", "yield x;"]];

async function syntaxTable() {
  const out = {};
  const put = (key, role, hooks) => { if (hooks.length) (out[key] ??= {})[role] = hooks; };
  for (const [key, role, src] of syntaxRows) put(key, role, await observe(new Function("x", src)));
  // eslint-disable-next-line no-new-func
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  for (const [key, role, src] of asyncRows) put(key, role, await observe(new AsyncFn("x", src)));
  const GenFn = Object.getPrototypeOf(function* () {}).constructor;
  for (const [key, role, src] of genRows) put(key, role, await observe((x) => [...new GenFn("x", src)(x)]));
  return out;
}

// ------------------------------------------------------------------ builtins
// The ECMA-262 globals and the lib.d.ts interface that declares each (static side `XConstructor`, prototype side
// `X`). Host functions that schedule callbacks (timers, queueMicrotask) are the HOF reader's, not a site here;
// `eval`/`Function` compile their argument; `Atomics` can block.
const STATIC = [["Object", "ObjectConstructor"], ["Array", "ArrayConstructor"], ["String", "StringConstructor"],
  ["Number", "NumberConstructor"], ["Boolean", "BooleanConstructor"], ["Symbol", "SymbolConstructor"],
  ["BigInt", "BigIntConstructor"], ["Promise", "PromiseConstructor"], ["Map", "MapConstructor"], ["Set", "SetConstructor"],
  ["WeakMap", "WeakMapConstructor"], ["WeakSet", "WeakSetConstructor"], ["WeakRef", "WeakRefConstructor"],
  ["Date", "DateConstructor"], ["RegExp", "RegExpConstructor"], ["Error", "ErrorConstructor"],
  ["ArrayBuffer", "ArrayBufferConstructor"], ["JSON", "JSON"], ["Math", "Math"], ["Reflect", "Reflect"]];
const PROTO_OF = [["Array", "Array", () => []], ["Array", "ReadonlyArray", () => []], ["String", "String", () => "abc"],
  ["Number", "Number", () => 1], ["Map", "Map", () => new Map()], ["Set", "Set", () => new Set()],
  ["Promise", "Promise", () => Promise.resolve(1)], ["Date", "Date", () => new Date(0)], ["RegExp", "RegExp", () => /a/],
  ["Object", "Object", () => ({})]];
const GLOBAL_FNS = ["parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI",
  "decodeURIComponent", "escape", "unescape", "structuredClone"];
const NOT_CALLABLE_CTORS = new Set(["Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "ArrayBuffer"]);
const FILLERS = [() => undefined, () => ({ g: 1, h: 1 }), () => "h", () => "g", () => 1];
const SHAPES = [["", (p) => p], ["[]", (p) => [p]], ["{}", (p) => ({ a: p })]];

// One position of one builtin: union over fillers and shapes. `call(args)` performs the invocation.
// `length` is the function's declared parameter count: a hook observed at the LAST probed position when that
// position is past `length` means the tail is variadic (`Object.assign`'s sources, `Math.max`, `String.prototype.concat`),
// and the row is marked `rest` — it binds every argument from its position on.
async function positions(arity, call, length = arity) {
  const res = [];
  for (let i = 0; i < arity; i++) {
    for (const [shape, wrap] of SHAPES) {
      const hooks = new Set();
      let keyArgOnly = null;
      for (const fill of FILLERS) {
        const hs = await observe((p) => { const a = Array.from({ length: arity }, fill); a[i] = wrap(p); return call(a); });
        hs.forEach((h) => hooks.add(h));
      }
      // A LOOKUP / SET is keyed: say which argument names the key — the one position where "g"/"h" runs the accessor and
      // "zz" (a name the probe does not carry) runs nothing. A copy runs its getters whatever the other arguments say.
      const accessorHook = (h) => /^(get|set):/.test(h);
      if ([...hooks].some(accessorHook)) {
        for (let j = 0; j < arity; j++) {
          if (j === i) continue;
          const run = (key) => observe((p) => { const a = Array.from({ length: arity }, () => ({ g: 1, h: 1 })); a[i] = wrap(p); a[j] = key; return call(a); });
          const withKey = [...(await run("g")), ...(await run("h"))], withOther = await run("zz");
          if (withKey.some(accessorHook) && !withOther.some(accessorHook)) { keyArgOnly = j; break; }
        }
      }
      if (hooks.size) res.push({ arg: i, shape, hooks: [...hooks].sort(), ...(keyArgOnly != null ? { keyArg: keyArgOnly } : {}),
        ...(i === arity - 1 && i >= length && shape === "" ? { rest: true } : {}) });
    }
  }
  return res;
}
async function builtinTable() {
  const out = {};
  const put = (key, rows) => { if (rows.length) out[key] = rows; };
  // one position past the declared count (to see a variadic tail), at least 2, at most 8 (`Date.UTC` declares 7)
  const arityOf = (f) => Math.max(2, Math.min(8, (f.length | 0) + 1));
  for (const [g, iface] of STATIC) {
    const obj = globalThis[g];
    for (const m of Object.getOwnPropertyNames(obj).sort()) {
      if (["prototype", "length", "name", "caller", "arguments"].includes(m)) continue;
      const d = Object.getOwnPropertyDescriptor(obj, m);
      if (!d || typeof d.value !== "function") continue;
      const f = d.value;
      put(`${iface}.${m}`, await positions(arityOf(f), (a) => f.apply(obj, a), f.length | 0));
    }
    if (typeof obj === "function") {
      if (!NOT_CALLABLE_CTORS.has(g)) put(`${iface}.(call)`, await positions(2, (a) => obj(...a)));
      if (g !== "Symbol" && g !== "BigInt") put(`${iface}.(new)`, await positions(2, (a) => new obj(...a)));
    }
  }
  for (const [g, iface, recv] of PROTO_OF) {
    const proto = globalThis[g].prototype;
    for (const m of Object.getOwnPropertyNames(proto).sort()) {
      if (m === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, m);
      if (!d || typeof d.value !== "function") continue;
      const f = d.value;
      const rows = await positions(arityOf(f), (a) => f.apply(recv(), a), f.length | 0);
      // The receiver's ELEMENTS (an array method coercing or iterating what it holds — `join`, `sort`).
      if (g === "Array") {
        const hooks = new Set();
        for (const fill of FILLERS) (await observe((p) => f.apply([p, p], Array.from({ length: arityOf(f) - 1 }, fill)))).forEach((h) => hooks.add(h));
        if (hooks.size) rows.unshift({ arg: "this", shape: "[]", hooks: [...hooks].sort() });
      }
      put(`${iface}.${m}`, rows);
    }
  }
  for (const g of GLOBAL_FNS) {
    const f = globalThis[g];
    if (typeof f === "function") put(g, await positions(arityOf(f), (a) => f(...a), f.length | 0));
  }
  return out;
}

// The rows ECMA-262 states that this node cannot execute: explicit resource management (`using`, `await using` —
// DisposeResources calls `[Symbol.dispose]` / `[Symbol.asyncDispose]` at scope exit). Declared, not observed, and
// marked so.
const DECLARED = {
  "VariableDeclarationList:using": { initializer: ["[Symbol.dispose]"], source: "ECMA-262 DisposeResources (not executable on this node)" },
  "VariableDeclarationList:await-using": { initializer: ["[Symbol.asyncDispose]", "[Symbol.dispose]"], source: "ECMA-262 DisposeResources (not executable on this node)" },
};

async function generate() {
  return { generatedBy: "calltarget/sitetable/oracle.cjs", node: process.version, syntax: { ...(await syntaxTable()), ...DECLARED }, builtins: await builtinTable() };
}
const BEGIN = "// <<CT-SITE-TABLE", END = "// CT-SITE-TABLE>>";
function embedded(file) {
  const s = fs.readFileSync(file, "utf8");
  const a = s.indexOf(BEGIN), b = s.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`no ${BEGIN} … ${END} block in ${file}`);
  const body = s.slice(s.indexOf("\n", a) + 1, b);
  const t = JSON.parse(body.replace(/^const CT_SITE_TABLE = /, "").replace(/;\s*$/, ""));
  // the embed's calibration marks (`r0`: a row 0.40.17's hand lists recognised) are not oracle output
  for (const v of Object.values(t.syntax)) delete v.r0;
  for (const rows of Object.values(t.builtins)) for (const r of rows) delete r.r0;
  return t;
}
(async () => {
  const t = await generate();
  const i = process.argv.indexOf("--check");
  if (i < 0) { process.stdout.write(JSON.stringify(t, null, 1) + "\n"); return; }
  const have = embedded(process.argv[i + 1]);
  const norm = (x) => JSON.stringify({ syntax: x.syntax, builtins: x.builtins });
  if (norm(have) === norm(t)) { console.log(`site table OK (${Object.keys(t.syntax).length} syntax rows, ${Object.keys(t.builtins).length} builtins, ${process.version})`); return; }
  for (const part of ["syntax", "builtins"]) {
    const keys = new Set([...Object.keys(have[part]), ...Object.keys(t[part])]);
    for (const k of [...keys].sort()) if (JSON.stringify(have[part][k]) !== JSON.stringify(t[part][k]))
      console.log(`DIFF ${part} ${k}\n  embedded: ${JSON.stringify(have[part][k])}\n  oracle:   ${JSON.stringify(t[part][k])}`);
  }
  console.log("site table STALE: regenerate with `node calltarget/sitetable/oracle.cjs` and re-embed (calltarget/sitetable/embed.py)");
  process.exit(1);
})();
