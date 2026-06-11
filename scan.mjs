#!/usr/bin/env node
/**
 * candor-ts — a minimal TypeScript implementation slice of candor-spec 0.3.
 *
 * Built ONLY from the spec (SPEC.md + SEMANTICS.md + CLASSIFIER.md) as the derivability proof:
 * resolve each call via the TypeScript compiler API (CLASSIFIER §1: resolve, don't pattern-match),
 * classify resolved external targets by a curated κ (§3 classifier; the I/O boundary), record local
 * edges, propagate to the least fixpoint (SEMANTICS §5), mark unresolvable calls Unknown (SPEC §4 —
 * an `any`-typed callee or a function-valued parameter/field IS the "could not resolve" case), and
 * emit the §2 report envelope + the §2.2 call-graph sidecar (every analyzed function a key).
 *
 * Usage: node scan.mjs <file.ts> <out-prefix>
 *   writes <out-prefix>.json (report) and <out-prefix>.callgraph.json
 */
import ts from "typescript";
import fs from "node:fs";

const [, , srcPath, outPrefix] = process.argv;
if (!srcPath || !outPrefix) {
  console.error("usage: node scan.mjs <file.ts> <out-prefix>");
  process.exit(2);
}

const program = ts.createProgram([srcPath], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ["node"],
  strict: true,
});
const checker = program.getTypeChecker();
const sf = program.getSourceFile(srcPath);

// κ — the curated classifier (CLASSIFIER §2: tag the dispatch/execution boundary, not builders).
// Keyed on the resolved declaration's module + member name. Std-only core for the conformance scope.
function kappa(moduleName, member) {
  if (/^(node:)?fs(\/promises)?$/.test(moduleName)) return "Fs";
  if (/^(node:)?net$/.test(moduleName)) return "Net";
  if (/^(node:)?http s?$/.test(moduleName) || /^(node:)?https?$/.test(moduleName)) return "Net";
  if (/^(node:)?child_process$/.test(moduleName)) return "Exec";
  if (/^(node:)?dgram$/.test(moduleName)) return "Net";
  if (/^(node:)?sqlite$/.test(moduleName) || /^(pg|sqlite3|better-sqlite3|mysql2?)$/.test(moduleName)) return "Db";
  return null;
}

// ---- the literal surfaces (SPEC §2 hosts/cmds/paths/tables): the statically-decidable subset -----
// Read ONLY from string literals at a classified call — informative, never complete, never inferred.
function firstStringLiteral(node) {
  for (const a of node.arguments ?? []) {
    if (ts.isStringLiteralLike(a)) return a.text;
  }
  return null;
}
// host[:port] from an address/URL literal; non-address strings yield nothing (never fabricate).
function hostLiteral(s) {
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);   // scheme://host[:port]/…
  if (m) return m[1].replace(/^.*@/, "");
  if (/^[a-z0-9._-]+(:\d+)?$/i.test(s) && s.includes(".")) return s; // bare host[.tld][:port]
  return null;
}
// Table-position identifiers in a SQL string literal (SPEC §2 `tables`). Mirrors the Rust
// tables_in_sql exactly: must open with a statement keyword; FROM/JOIN/INTO anywhere,
// statement-leading UPDATE/TRUNCATE, TABLE (skipping ONLY/IF NOT EXISTS); a FOR UPDATE locking
// clause yields nothing. Conservative in the fabrication direction.
function tablesInSql(sql) {
  const stmt = new Set(["select","insert","update","delete","create","drop","alter","truncate","merge","replace","with"]);
  const skip = new Set(["only","if","not","exists","table"]);
  const stop = new Set(["select","set","where","values","on","using","group","order","by","limit",
    "returning","as","inner","outer","left","right","cross","lateral","natural","union","all",
    "distinct","case","when","null","default","skip","nowait","of","from","join","into","update",
    "delete","insert"]);
  const toks = sql.toLowerCase().replace(/[(),;]/g, " ").trim().split(/\s+/);
  if (!toks.length || !stmt.has(toks[0])) return [];
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tablePos = ["from","join","into","table"].includes(toks[i])
      || ((toks[i] === "update" || toks[i] === "truncate") && i === 0);
    if (!tablePos) continue;
    let j = i + 1;
    while (j < toks.length && skip.has(toks[j])) j++;
    if (j >= toks.length) continue;
    const t = toks[j].replace(/^["'`]+|["'`]+$/g, "");
    if (!t || stop.has(t) || !/^[a-z_][a-z0-9_.$"`]*$/.test(t)) continue;
    const clean = t.replace(/["`]/g, "");
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

// The module specifier a declaration came from ("node:fs" via @types/node fs.d.ts → "fs").
function declModule(decl) {
  const f = decl.getSourceFile().fileName;
  const m = f.match(/@types\/node\/(\w+?)\.d\.ts$/);
  if (m) return m[1];
  const amb = decl.getSourceFile().fileName.match(/typescript\/lib\/lib\..*\.d\.ts$/);
  if (amb) return "<es-lib>";
  return f === sf.fileName ? "<local>" : f;
}

// ---- pass 1: collect the analyzed functions (named fns + class methods; SEMANTICS §2's F) --------
const fns = new Map(); // name -> { node, direct:Set, edges:Set, hosts:Set, tables:Set, loc }
function fnName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${node.name.getText()}`;
  return null;
}
function collect(node) {
  const n = fnName(node);
  if (n) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
    fns.set(n, { node, direct: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(), loc: `${srcPath}:${line + 1}:${character + 1}` });
  }
  ts.forEachChild(node, collect);
}
collect(sf);

// nearest enclosing analyzed function (closures attribute to it — SEMANTICS §2)
function enclosing(node) {
  for (let p = node; p; p = p.parent) {
    const n = fnName(p);
    if (n && fns.has(n)) return n;
  }
  return null;
}

// ---- pass 2: per call site, the (CLASSIFY)/(EDGE)/(UNKNOWN) resolution of SEMANTICS §4 -----------
function visitCalls(node) {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const owner = enclosing(node);
    if (owner) {
      const rec = fns.get(owner);
      const sig = checker.getResolvedSignature(node);
      const decl = sig && sig.declaration;
      if (!decl) {
        // unresolvable call → Unknown, never silent-pure (SPEC §4)
        rec.direct.add("Unknown");
      } else {
        const mod = declModule(decl);
        if (mod === "<local>") {
          const target = fnName(decl);
          if (target && fns.has(target)) {
            rec.edges.add(target); // (EDGE)
          } else if (!ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) {
            // Resolution landed on a TYPE (a function-type annotation, a method/property signature),
            // not a body: the concrete callable is genuinely indeterminate — a callback value, a
            // DI-wired field. (UNKNOWN), never silent-pure (SPEC §4). An arrow/fn-expression is fine:
            // its body is visible and already walked lexically (closure attribution, SEMANTICS §2).
            rec.direct.add("Unknown");
          }
        } else if (mod === "<es-lib>") {
          // conventionally-pure ES surface (Array/String/Math/…) — except the clock (SPEC §1)
          const name = decl.name ? decl.name.getText() : "";
          const parent = decl.parent && decl.parent.name ? decl.parent.name.getText() : "";
          if ((parent === "DateConstructor" && name === "now") || (parent === "Performance" && name === "now"))
            rec.direct.add("Clock");
        } else {
          const member = decl.name ? decl.name.getText() : "";
          const eff = kappa(mod, member); // (CLASSIFY)
          if (eff) rec.direct.add(eff);
          // the literal surfaces, read only at a CLASSIFIED call (SPEC §2): the Net host or the
          // Db tables a string-literal argument names; a runtime-computed value yields nothing.
          if (eff === "Net") {
            const lit = firstStringLiteral(node);
            const h = lit && hostLiteral(lit);
            if (h) rec.hosts.add(h);
          }
          if (eff === "Db") {
            const lit = firstStringLiteral(node);
            for (const t of lit ? tablesInSql(lit) : []) rec.tables.add(t);
          }
          // unmatched external = (OPAQUE): contributes nothing — the curated-κ caveat C1
        }
      }
      // the callee EXPRESSION being a plain identifier of function-typed parameter/field → (UNKNOWN)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        const d = sym && sym.valueDeclaration;
        if (d && (ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)))
          rec.direct.add("Unknown"); // a callback value — genuinely indeterminate (SPEC §4)
      }
    }
  }
  // process.env.X — a property READ, not a call (the JVM's System.getenv twin) → Env
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "process.env") {
    const owner = enclosing(node);
    if (owner) fns.get(owner).direct.add("Env");
  }
  ts.forEachChild(node, visitCalls);
}
visitCalls(sf);

// ---- pass 3: the least fixpoint (SEMANTICS §5a) ---------------------------------------------------
const inferred = new Map([...fns.keys()].map((k) => [k, new Set(fns.get(k).direct)]));
let changed = true;
while (changed) {
  changed = false;
  for (const [name, rec] of fns) {
    const mine = inferred.get(name);
    for (const callee of rec.edges)
      for (const e of inferred.get(callee) ?? [])
        if (!mine.has(e)) { mine.add(e); changed = true; }
  }
}

// literal surfaces propagate along the same edges as effects (SEMANTICS §5)
for (const m of ["hosts", "tables"]) {
  let moved = true;
  while (moved) {
    moved = false;
    for (const [, rec] of fns)
      for (const callee of rec.edges)
        for (const v of fns.get(callee)?.[m] ?? [])
          if (!rec[m].has(v)) { rec[m].add(v); moved = true; }
  }
}

// ---- emit: the §2 envelope (effect-free items omitted) + the §2.2 sidecar (EVERY fn a key) --------
const functions = [];
for (const [name, rec] of fns) {
  const inf = [...inferred.get(name)].sort();
  if (inf.length === 0) continue;
  const entry = {
    fn: name,
    loc: rec.loc,
    inferred: inf,
    direct: [...rec.direct].sort(),
    declared: [],
    undeclared: [],
    overdeclared: [],
    unresolved: inf.includes("Unknown"),
  };
  if (inf.includes("Net") && rec.hosts.size) entry.hosts = [...rec.hosts].sort();
  if (inf.includes("Db") && rec.tables.size) entry.tables = [...rec.tables].sort();
  functions.push(entry);
}
const envelope = { candor: { version: "candor-ts-0.0.1", toolchain: `node-${process.versions.node}`, spec: "0.3" }, functions };
fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(envelope, null, 1));
const cg = {};
for (const [name, rec] of fns) cg[name] = [...rec.edges].sort();
fs.writeFileSync(`${outPrefix}.callgraph.json`, JSON.stringify(cg, null, 1));
console.error(`candor-ts: wrote ${functions.length} effectful functions to ${outPrefix}.json`);
