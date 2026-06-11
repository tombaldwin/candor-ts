#!/usr/bin/env node
/**
 * candor-ts — the TypeScript implementation of candor-spec 0.3.
 *
 * Origin (kept honest): this engine began as the clean-room derivability proof — a single-file
 * slice written from SPEC.md/SEMANTICS.md/CLASSIFIER.md alone, frozen as that claim in git history
 * (`a29b152`). Product growth since (multi-file projects, the literal surfaces, the policy gate)
 * is spec-implemented but post-hoc; its guarantee is the cross-engine conformance suite.
 *
 * Resolve each call via the TypeScript compiler API (CLASSIFIER §1: resolve, don't pattern-match),
 * classify resolved external targets by the curated κ (§3; the I/O boundary), record local edges,
 * propagate to the least fixpoint (SEMANTICS §5), mark unresolvable calls Unknown (SPEC §4 — an
 * `any`-typed callee or a function-valued parameter/field IS the "could not resolve" case), and
 * emit the §2 report envelope + the §2.2 call-graph sidecar (every analyzed function a key). With
 * --policy (or CANDOR_POLICY), evaluate the §6.2 gate (AS-EFF-006/008/009) over the result: exit 1
 * on violation, exit 2 LOUDLY on an unreadable policy.
 *
 * Usage: node scan.mjs <dir | file.ts | tsconfig.json> [--out <prefix>] [--policy <file>]
 *        node scan.mjs <file.ts> <out-prefix>                  (legacy positional form)
 *   writes <prefix>.json (report) and <prefix>.callgraph.json
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { parsePolicy, evaluatePolicy } from "./policy.mjs";

// ---- args ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: node scan.mjs <dir | file.ts | tsconfig.json> [--out <prefix>] [--policy <file>]");
  process.exit(2);
}
const target = argv[0];
let outPrefix = null, policyPath = process.env.CANDOR_POLICY ?? null;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--out") outPrefix = argv[++i];
  else if (argv[i] === "--policy") policyPath = argv[++i];
  else if (!argv[i].startsWith("--") && !outPrefix) outPrefix = argv[i]; // legacy positional prefix
}

// ---- project discovery (a dir, a single file, or a tsconfig) --------------------------------------
function isTestPath(p) {
  return /(^|\/)(node_modules|__tests__|tests?|spec)(\/|$)/.test(p) || /\.(test|spec)\.[mc]?tsx?$/.test(p);
}
let rootDir, fileNames, compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ["node"],
  strict: true,
};
function fromTsconfig(cfgPath, baseDir) {
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, baseDir);
  compilerOptions = { ...parsed.options, types: parsed.options.types ?? ["node"] };
  return parsed.fileNames.filter((f) => !isTestPath(path.relative(baseDir, f)));
}
const stat = fs.existsSync(target) ? fs.statSync(target) : null;
if (!stat) { console.error(`candor-ts: no such path: ${target}`); process.exit(2); }
if (stat.isFile() && /tsconfig.*\.json$/.test(path.basename(target))) {
  rootDir = path.dirname(path.resolve(target));
  fileNames = fromTsconfig(path.resolve(target), rootDir);
} else if (stat.isFile()) {
  rootDir = path.dirname(path.resolve(target));
  fileNames = [path.resolve(target)];
} else {
  rootDir = path.resolve(target);
  const tsconfig = path.join(rootDir, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    fileNames = fromTsconfig(tsconfig, rootDir);
  } else {
    fileNames = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (isTestPath(path.relative(rootDir, p))) continue;
        if (ent.isDirectory()) walk(p);
        else if (/\.[mc]?tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) fileNames.push(p);
      }
    })(rootDir);
  }
}
if (fileNames.length === 0) { console.error(`candor-ts: no TypeScript sources under ${target}`); process.exit(2); }
if (!outPrefix) outPrefix = path.join(rootDir, ".candor", "report");
fs.mkdirSync(path.dirname(path.resolve(outPrefix)), { recursive: true });

const program = ts.createProgram(fileNames, compilerOptions);
const checker = program.getTypeChecker();
const projectFiles = new Set(fileNames.map((f) => path.resolve(f)));
const sources = program.getSourceFiles().filter((f) => projectFiles.has(path.resolve(f.fileName)));

// ---- κ — the curated classifier (CLASSIFIER §2: the dispatch/execution boundary, not builders) ----
// Node builtins + a curated npm tier (the same under-report-and-say-so posture as the crate table:
// an unlisted package contributes nothing — never a guess).
function kappa(moduleName, member) {
  if (/^(node:)?fs(\/promises)?$/.test(moduleName)) return "Fs";
  if (/^(node:)?(net|dgram|tls|http2?|https)$/.test(moduleName)) return "Net";
  if (/^(node:)?child_process$/.test(moduleName)) return "Exec";
  if (/^(node:)?sqlite$/.test(moduleName)) return "Db";
  // the curated npm tier
  if (/^(axios|got|node-fetch|undici|ws|socket\.io(-client)?|nodemailer)$/.test(moduleName)) return "Net";
  if (/^(pg|mysql2?|mongodb|ioredis|redis|sqlite3|better-sqlite3|knex)$/.test(moduleName)) return "Db";
  if (/^(execa|cross-spawn|shelljs)$/.test(moduleName)) return "Exec";
  if (/^(fs-extra|graceful-fs|rimraf|glob|chokidar)$/.test(moduleName)) return "Fs";
  if (/^dotenv$/.test(moduleName)) return "Env";
  if (/^(winston|pino|bunyan|npmlog)$/.test(moduleName)) return "Log";
  // The ORM tier — VERB-PRECISE (the CLASSIFIER discipline: tag the execution boundary, not
  // builders; `createQueryBuilder` is pure, its `getMany`/`execute` is the I/O). Found on the
  // first framework-APP scan: a TypeORM/Nest application — Db-heavy by construction — read zero
  // Db because the ORM resolved into an unlisted package (the JVM's Spring-Data lesson, replayed).
  if (/^(typeorm|@nestjs\/typeorm)$/.test(moduleName)
      && /^(find|save|remove|softRemove|recover|insert|update|upsert|delete|restore|count|exist|sum|average|minimum|maximum|query|clear|increment|decrement|getMany|getOne|getOneOrFail|getRawMany|getRawOne|getCount|getExists|execute|stream|transaction)/.test(member))
    return "Db";
  if (/^@prisma\/client$/.test(moduleName)
      && /^(\$?(queryRaw|executeRaw|transaction)|find(Many|Unique|First)|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|count|groupBy)/.test(member))
    return "Db";
  if (/^mongoose$/.test(moduleName)
      && /^(find|save|create|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|aggregate|countDocuments|estimatedDocumentCount|distinct|exec|bulkWrite)/.test(member))
    return "Db";
  if (/^(sequelize|drizzle-orm)$/.test(moduleName)
      && /^(find|create|update|destroy|upsert|count|max|min|sum|query|select|insert|delete|execute|transaction)/.test(member))
    return "Db";
  // Nest's HttpService wraps axios — the request verbs are Net.
  if (/^@nestjs\/axios$/.test(moduleName) && /^(get|post|put|patch|delete|head|request)$/.test(member)) return "Net";
  return null;
}

// The module a declaration came from: a project file → "<local>", @types/node → the builtin name,
// node_modules/<pkg> → the package name, the ES lib → "<es-lib>".
function declModule(decl) {
  const f = path.resolve(decl.getSourceFile().fileName);
  if (projectFiles.has(f)) return "<local>";
  let m = f.match(/@types\/node\/(\w+?)\.d\.ts$/);
  if (m) return m[1];
  if (/typescript\/lib\/lib\..*\.d\.ts$/.test(f)) return "<es-lib>";
  m = f.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
  if (m) return m[1];
  return f;
}

// ---- the literal surfaces (SPEC §2 hosts/cmds/paths/tables): the statically-decidable subset ------
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

// ---- pass 1: collect the analyzed functions across the project (SEMANTICS §2's F) -----------------
// Names are MODULE-QUALIFIED (`src.db.save` for save() in src/db.ts; separators → "." so the §6.2
// segment-scope rules apply naturally: `deny Net db` matches the db module). A single-file scan
// qualifies by the file's basename (`Cases.union_a`).
const fns = new Map();           // qualified name -> { direct, edges, hosts, tables, cmds, paths, loc }
const nodeName = new WeakMap();  // declaration node -> qualified name
function moduleOf(sf) {
  const rel = path.relative(rootDir, path.resolve(sf.fileName)).replace(/\.[mc]?tsx?$/, "");
  return rel.split(path.sep).join(".");
}
function localName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${node.name.getText()}`;
  // `const f = (…) => …` / `const f = function (…) {…}` at any binding site — the dominant style in
  // real TS (rimraf's whole API is arrow consts; the first dogfood analyzed 0 of 50 files without
  // this). The VARIABLE name is the function's name; nodeName is ALSO set on the initializer so a
  // resolved call (whose sig.declaration is the arrow itself) finds the same qualified name.
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    return node.name.text;
  // CLASS ARROW-PROPERTY methods (`private readonly onError = (e) => …`) — the event-handler idiom.
  // Without this they were not units AT ALL: no callgraph key (a §2.2 violation), body never walked
  // (a silent-pure hole — worse than Unknown), found by the PROVE-IT dogfood on got, where the
  // request pipeline's error handlers live in exactly this form.
  if (ts.isPropertyDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    return `${node.parent.name.text}.${node.name.getText()}`;
  // Constructors are units too (`new X()` edges to `X.constructor`): a constructor that wires
  // effectful state (got's Request reassigns this.flush to an effectful closure in its ctor) was
  // invisible — same dogfood.
  if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.constructor`;
  return null;
}
for (const sf of sources) {
  const mod = moduleOf(sf);
  (function collect(node) {
    const n = localName(node);
    if (n) {
      const qual = `${mod}.${n}`;
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      fns.set(qual, { direct: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
                      cmds: new Set(), paths: new Set(),
                      loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}` });
      nodeName.set(node, qual);
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer)
        nodeName.set(node.initializer, qual);
    }
    ts.forEachChild(node, collect);
  })(sf);
}

// nearest enclosing analyzed function (closures attribute to it — SEMANTICS §2)
function enclosing(node) {
  for (let p = node; p; p = p.parent) {
    const n = nodeName.get(p);
    if (n) return n;
  }
  return null;
}

// ---- pass 2: per call site, the (CLASSIFY)/(EDGE)/(UNKNOWN) resolution of SEMANTICS §4 ------------
function visitCalls(node) {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const owner = enclosing(node);
    if (owner) {
      const rec = fns.get(owner);
      const sig = checker.getResolvedSignature(node);
      const decl = sig && sig.declaration;
      if (!decl) {
        rec.direct.add("Unknown"); // unresolvable call → Unknown, never silent-pure (SPEC §4)
      } else {
        const mod = declModule(decl);
        if (mod === "<local>") {
          const targetName = nodeName.get(decl);
          if (targetName) {
            rec.edges.add(targetName); // (EDGE) — cross-FILE edges resolve the same way
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
          // the literal surfaces, read only at a CLASSIFIED call (SPEC §2)
          if (eff === "Net") {
            const lit = firstStringLiteral(node);
            const h = lit && hostLiteral(lit);
            if (h) rec.hosts.add(h);
          }
          if (eff === "Db") {
            const lit = firstStringLiteral(node);
            for (const t of lit ? tablesInSql(lit) : []) rec.tables.add(t);
          }
          if (eff === "Exec") {
            const lit = firstStringLiteral(node);
            if (lit) rec.cmds.add(lit.trim().split(/\s+/)[0]); // the program of a command line
          }
          if (eff === "Fs") {
            const lit = firstStringLiteral(node);
            if (lit && /[\/\\]|^[.~]/.test(lit)) rec.paths.add(lit); // path-shaped literals only
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
for (const sf of sources) visitCalls(sf);

// ---- pass 3: the least fixpoint (SEMANTICS §5a), effects + the literal surfaces -------------------
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
for (const m of ["hosts", "tables", "cmds", "paths"]) {
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
  if (inf.includes("Exec") && rec.cmds.size) entry.cmds = [...rec.cmds].sort();
  if (inf.includes("Fs") && rec.paths.size) entry.paths = [...rec.paths].sort();
  functions.push(entry);
}
const envelope = { candor: { version: "candor-ts-0.1.0", toolchain: `node-${process.versions.node}`, spec: "0.3" }, functions };
fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(envelope, null, 1));
const cg = {};
for (const [name, rec] of fns) cg[name] = [...rec.edges].sort();
fs.writeFileSync(`${outPrefix}.callgraph.json`, JSON.stringify(cg, null, 1));
console.error(`candor-ts: wrote ${functions.length} effectful functions (${fns.size} analyzed, ${sources.length} files) to ${outPrefix}.json`);

// ---- the standing §6.2 gate (--policy / CANDOR_POLICY) --------------------------------------------
if (policyPath) {
  let text;
  try {
    text = fs.readFileSync(policyPath, "utf8");
  } catch {
    // a set-but-unreadable policy must be LOUD — silently passing would let a violation ship
    console.error(`candor-ts: policy ${policyPath} could not be read; gate NOT enforced`);
    process.exit(2);
  }
  const v = evaluatePolicy(parsePolicy(text), functions, cg);
  for (const line of v) console.log(line);
  if (v.length) {
    console.error(`candor-ts: ${v.length} policy violation(s)`);
    process.exit(1);
  }
  console.error("candor-ts: policy ✓");
}
