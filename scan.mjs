#!/usr/bin/env node
/**
 * candor-ts — the TypeScript implementation of candor-spec 0.4.
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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parsePolicy, evaluatePolicy } from "./policy.mjs";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === "--agents") {
  // The agent contract for THE INSTALLED VERSION — AGENTS.md ships in the npm tarball, so doc
  // and engine cannot drift (the spec §2.1 version-trust rule applied to documentation).
  const semver = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "package.json"), "utf8")).version;
  console.log(`<!-- candor-ts ${semver} · the agent contract for this installed version -->`);
  process.stdout.write(fs.readFileSync(path.join(ENGINE_DIR, "AGENTS.md"), "utf8"));
  process.exit(0);
}
if (argv.length === 0) {
  console.error("usage: node scan.mjs <dir | file.ts | tsconfig.json> [--out <prefix>] [--policy <file>] [--agents]");
  process.exit(2);
}
const target = argv[0];
let outPrefix = null, policyPath = process.env.CANDOR_POLICY ?? null, allowJs = false;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--out") outPrefix = argv[++i];
  else if (argv[i] === "--policy") policyPath = argv[++i];
  else if (argv[i] === "--allow-js") allowJs = true;
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
// The scanner CLASSIFIES through the builtin typings, so `node` always rides in `types` — a
// project's `types: []` (legitimate for its own build) would blind the effect analysis itself.
function withNodeTypes(options) {
  const t = options.types && options.types.length ? options.types : [];
  return { ...options, types: [...new Set([...t, "node"])] };
}

function fromTsconfig(cfgPath, baseDir) {
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, baseDir);
  compilerOptions = withNodeTypes(parsed.options);
  let names = parsed.fileNames;
  // SOLUTION-STYLE configs (`files: [], references: [...]` — hono, most monorepo roots) list no
  // sources themselves; follow the references one level and union their file lists (skipping
  // test/bench configs by the same path rule). Found by the published-package probe: hono read
  // "no TypeScript sources".
  if (names.length === 0 && (parsed.projectReferences ?? []).length > 0) {
    for (const ref of parsed.projectReferences) {
      const refPath = ts.resolveProjectReferencePath(ref);
      if (!fs.existsSync(refPath) || isTestPath(path.relative(baseDir, refPath))) continue;
      const sub = ts.readConfigFile(refPath, ts.sys.readFile);
      const subParsed = ts.parseJsonConfigFileContent(sub.config ?? {}, ts.sys, path.dirname(refPath));
      if (names.length === 0) compilerOptions = withNodeTypes(subParsed.options);
      names = names.concat(subParsed.fileNames);
    }
    names = [...new Set(names)];
  }
  return names.filter((f) => !isTestPath(path.relative(baseDir, f)));
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
  if (fs.existsSync(tsconfig) && !allowJs) {
    fileNames = fromTsconfig(tsconfig, rootDir);
  } else {
    fileNames = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (isTestPath(path.relative(rootDir, p))) continue;
        if (ent.isDirectory()) walk(p);
        else if (/\.[mc]?tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) fileNames.push(p);
        else if (allowJs && /\.[mc]?jsx?$/.test(ent.name) && !/\.min\.js$/.test(ent.name)) fileNames.push(p);
      }
    })(rootDir);
  }
}
if (fileNames.length === 0) { console.error(`candor-ts: no TypeScript sources under ${target}`); process.exit(2); }
// Builtin typings FALLBACK: the engine ships @types/node as its own dependency, so a target that
// hasn't installed it still resolves node:fs/node:net/… (found by the first npx-distribution
// probe: a bare fixture read Unknown for fs.readFileSync because nothing supplied the builtin
// types). Resolved via the module system, NOT a fixed relative path — npm HOISTS dependencies, so
// in an npx/install tree @types/node sits BESIDE candor-ts, not inside it (the second probe's
// catch). The TARGET's own @types win when present.
if (!compilerOptions.typeRoots) {
  const roots = [path.join(rootDir, "node_modules", "@types")];
  try {
    const req = createRequire(path.join(ENGINE_DIR, "scan.mjs"));
    roots.push(path.dirname(path.dirname(req.resolve("@types/node/package.json"))));
  } catch {}
  compilerOptions.typeRoots = roots;
}
if (!outPrefix) outPrefix = path.join(rootDir, ".candor", "report");
// The scanned package's name — the first half of the cross-package join key (SPEC §2 `hash`).
let pkgName = path.basename(rootDir);
try {
  const pj = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (pj.name) pkgName = pj.name;
} catch {}
fs.mkdirSync(path.dirname(path.resolve(outPrefix)), { recursive: true });

// A target with declared dependencies but no node_modules resolves almost nothing — the scan
// would "succeed" with a near-total-Unknown report a fresh user could ship (CTA-dogfood finding).
// Warn LOUDLY; the report is still written (it is sound), but the cause must be visible.
{
  const pkg = path.join(rootDir, "package.json");
  if (fs.existsSync(pkg) && !fs.existsSync(path.join(rootDir, "node_modules"))) {
    try {
      const deps = JSON.parse(fs.readFileSync(pkg, "utf8")).dependencies ?? {};
      if (Object.keys(deps).length > 0)
        console.error("candor-ts: WARNING — the target declares dependencies but has no node_modules; " +
                      "imports will not resolve and most functions will read Unknown. " +
                      "Run `npm install` in the target first.");
    } catch {}
  }
  // Prisma's client types are GENERATED — a project with the prisma dependency but no generated
  // client resolves every db.* call to nothing (found on the first Next.js probe: a Prisma-backed
  // app read zero Db until `prisma generate` ran).
  if (fs.existsSync(path.join(rootDir, "node_modules", "@prisma", "client"))
      && !fs.existsSync(path.join(rootDir, "node_modules", ".prisma", "client"))) {
    console.error("candor-ts: WARNING — @prisma/client is installed but its client is not generated; " +
                  "db calls will not resolve. Run `npx prisma generate` in the target first.");
  }
}
// CANDOR_DEPS (SPEC §2): sibling/dependency reports whose effects a call into that package
// inherits — the cross-package join the workspace probe measured as missing (trpc client → server:
// zero edges). The key is the report's `hash` (`package#LocalName` — derivable from BOTH a source
// scan and a .d.ts resolution). Version-aware trust (§2.1): a report from a DIFFERENT engine
// version is downgraded to Unknown rather than silently trusted. Duplicate hashes (two same-named
// exports in one package) UNION — a sound over-approximation, documented.
const ENGINE_VERSION = "candor-ts-0.4.3";
const crossDeps = new Map(); // hash -> {inferred:Set, hosts:[], cmds:[], paths:[], tables:[]}
// Packages a loaded sibling report COVERS — exempt from the κ ledger even when a call joins no
// entry (reports omit pure functions: the silence is the purity claim, SPEC §2 rule 3 — the
// serde_json rule the Rust/JVM engines already carry; /code-review found TS missing it). Fed from
// the envelope's `package` field (works for an all-pure EMPTY report) and from entry hash prefixes.
const depCoveredPkgs = new Set();
{
  const spec = process.env.CANDOR_DEPS ?? "";
  const files = [];
  for (const tok of spec.split(/[\s:,]+/).filter(Boolean)) {
    try {
      if (fs.statSync(tok).isDirectory())
        for (const f of fs.readdirSync(tok)) if (f.endsWith(".json") && !f.endsWith(".callgraph.json")) files.push(path.join(tok, f));
      if (fs.statSync(tok).isFile()) files.push(tok);
    } catch { console.error(`candor-ts: CANDOR_DEPS entry unreadable, skipped: ${tok}`); }
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      // A report whose version can't be VERIFIED is not trusted (§2.1) — a missing header is as
      // untrustworthy as a mismatched one (the Rust engine's rule; the engines split on this).
      const stale = d.candor?.version !== ENGINE_VERSION;
      if (typeof d.package === "string" && d.package) depCoveredPkgs.add(d.package);
      for (const e of d.functions ?? []) {
        if (!e.hash) continue;
        const hashPkg = e.hash.split("#")[0];
        if (hashPkg) depCoveredPkgs.add(hashPkg);
        const cell = crossDeps.get(e.hash) ?? { inferred: new Set(), hosts: [], cmds: [], paths: [], tables: [] };
        for (const x of stale ? ["Unknown"] : e.inferred ?? []) cell.inferred.add(x);
        if (!stale) for (const m of ["hosts", "cmds", "paths", "tables"])
          for (const v of e[m] ?? []) if (!cell[m].includes(v)) cell[m].push(v);
        crossDeps.set(e.hash, cell);
      }
    } catch { console.error(`candor-ts: CANDOR_DEPS report unparsable, skipped: ${f}`); }
  }
}

if (allowJs) { compilerOptions.allowJs = true; compilerOptions.checkJs = false; }
const program = ts.createProgram(fileNames, compilerOptions);
const checker = program.getTypeChecker();
const projectFiles = new Set(fileNames.map((f) => path.resolve(f)));
const sources = program.getSourceFiles().filter((f) => projectFiles.has(path.resolve(f.fileName)));

// ---- κ — the curated classifier (CLASSIFIER §2: the dispatch/execution boundary, not builders) ----
// Node builtins + a curated npm tier (the same under-report-and-say-so posture as the crate table:
// an unlisted package contributes nothing — never a guess).
// One rules TABLE, two readers: kappa() classifies a call; kappaKnows() answers "is this package
// curated at all?" for the coverage ledger (a κ-known package whose given call is pure — a TypeORM
// builder — is covered, not a blind spot). A single source so the two can never drift.
// [module-name regex, member regex (null = any member), effect]
const KAPPA_RULES = [
  [/^(node:)?fs(\/promises)?$/, null, "Fs"],
  [/^(node:)?(net|dgram|tls|http2?|https)$/, null, "Net"],
  [/^(node:)?child_process$/, null, "Exec"],
  [/^(node:)?sqlite$/, null, "Db"],
  // the curated npm tier
  [/^(axios|got|node-fetch|undici|ws|socket\.io(-client)?|nodemailer)$/, null, "Net"],
  [/^(pg|mysql2?|mongodb|ioredis|redis|sqlite3|better-sqlite3|knex)$/, null, "Db"],
  [/^(execa|cross-spawn|shelljs)$/, null, "Exec"],
  [/^(fs-extra|graceful-fs|rimraf|glob|chokidar)$/, null, "Fs"],
  [/^dotenv$/, null, "Env"],
  [/^(winston|pino|bunyan|npmlog)$/, null, "Log"],
  // entropy: node:crypto's random surface + the password-hashing libs (salted -> Rand). Found by
  // the CTA dogfood on a Nest app: argon2.hash came out SILENTLY PURE (the curated-kappa caveat
  // landing on exactly the call a security review cares about).
  [/^(node:)?crypto$/, /^random/, "Rand"],
  [/^(argon2|bcrypt|bcryptjs)$/, null, "Rand"],
  // The ORM tier — VERB-PRECISE (the CLASSIFIER discipline: tag the execution boundary, not
  // builders; `createQueryBuilder` is pure, its `getMany`/`execute` is the I/O). Found on the
  // first framework-APP scan: a TypeORM/Nest application — Db-heavy by construction — read zero
  // Db because the ORM resolved into an unlisted package (the JVM's Spring-Data lesson, replayed).
  [/^(typeorm|@nestjs\/typeorm)$/,
   /^(find|save|remove|softRemove|recover|insert|update|upsert|delete|restore|count|exist|sum|average|minimum|maximum|query|clear|increment|decrement|getMany|getOne|getOneOrFail|getRawMany|getRawOne|getCount|getExists|execute|stream|transaction)/,
   "Db"],
  [/^(@prisma\/client|\.prisma|\.prisma\/client)$/,
   /^(\$?(queryRaw|executeRaw|transaction)|find(Many|Unique|First)|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|count|groupBy)/,
   "Db"],
  [/^mongoose$/,
   /^(find|save|create|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|aggregate|countDocuments|estimatedDocumentCount|distinct|exec|bulkWrite)/,
   "Db"],
  [/^(sequelize|drizzle-orm)$/,
   /^(find|create|update|destroy|upsert|count|max|min|sum|query|select|insert|delete|execute|transaction)/,
   "Db"],
  // Nest's HttpService wraps axios — the request verbs are Net.
  [/^@nestjs\/axios$/, /^(get|post|put|patch|delete|head|request)$/, "Net"],
];
function kappa(moduleName, member) {
  for (const [mre, vre, eff] of KAPPA_RULES) {
    if (mre.test(moduleName) && (!vre || vre.test(member))) return eff;
  }
  return null;
}
// Packages REVIEWED and ratified effect-free at the call boundary (decorator/metadata plumbing,
// pure computation, operator algebras whose side effects live in visible user callbacks). This is
// the ledger's triage outlet: an unlisted package either earns KAPPA_RULES entries or lands here —
// never silently. NOT for anything that mints entropy (uuid), reads clocks, or signs with RSA-PSS
// (jsonwebtoken stays unlisted on purpose).
const KAPPA_PURE = new Set([
  "@nestjs/common", "@nestjs/core", "@nestjs/swagger", "@nestjs/platform-express",
  "class-validator", "class-transformer", "reflect-metadata",
  "rxjs", "zod", "lodash", "ramda", "date-fns",
]);
function kappaKnows(moduleName) {
  return KAPPA_PURE.has(moduleName) || KAPPA_RULES.some(([mre]) => mre.test(moduleName));
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
  // `,` survives as its OWN token: it lets `FROM t1, t2` continue the table list without
  // fabricating from other comma-ridden positions (column lists, ON clauses).
  const toks = sql.toLowerCase().replace(/[();]/g, " ").replace(/,/g, " , ").trim().split(/\s+/);
  if (!toks.length || !stmt.has(toks[0])) return [];
  const out = [];
  const ident = (raw) => {
    const t = raw.replace(/^["'`]+|["'`]+$/g, "");
    if (!t || stop.has(t) || !/^[a-z_][a-z0-9_.$"`]*$/.test(t)) return null;
    return t.replace(/["`]/g, "");
  };
  for (let i = 0; i < toks.length; i++) {
    const tablePos = ["from","join","into","table"].includes(toks[i])
      || ((toks[i] === "update" || toks[i] === "truncate") && i === 0);
    if (!tablePos) continue;
    let j = i + 1;
    while (j < toks.length && skip.has(toks[j])) j++;
    if (j >= toks.length) continue;
    const first = ident(toks[j]);
    if (first === null) continue;
    if (!out.includes(first)) out.push(first);
    // Comma-ADJACENT continuation only: `FROM t1, t2, t3` takes all three, while an alias breaks
    // the chain (`FROM t1 a, t2` keeps just t1 — an under-report, never a guess: skipping an alias
    // to chase the comma would fabricate tables out of `INSERT INTO t (a, b)`'s column list, whose
    // parens are spaces by the time we tokenize).
    while (j + 2 < toks.length && toks[j + 1] === ",") {
      const more = ident(toks[j + 2]);
      if (more === null) break;
      if (!out.includes(more)) out.push(more);
      j += 2;
    }
  }
  return out;
}

// ---- pass 1: collect the analyzed functions across the project (SEMANTICS §2's F) -----------------
// Names are MODULE-QUALIFIED (`src.db.save` for save() in src/db.ts; separators → "." so the §6.2
// segment-scope rules apply naturally: `deny Net db` matches the db module). A single-file scan
// qualifies by the file's basename (`Cases.union_a`).
const fns = new Map();           // qualified name -> { direct, edges, hosts, tables, cmds, paths, loc }
const unlistedSeen = new Map();  // the κ-coverage ledger: unlisted npm package -> call-site count
const nodeName = new WeakMap();  // declaration node -> qualified name
// ORM table declarations: `@Entity("user")` on a class maps that class to its table — the JVM's
// read-the-declarations move (TypeORM tables live in decorators, not SQL strings, so the `tables`
// surface couldn't fire on the most common TS app shape). LITERAL decorator arg only; a no-arg
// `@Entity()` (naming-strategy-dependent) contributes nothing — never a guess.
const entityTables = new Map();    // ClassDeclaration node -> table name
const interfaceImpls = new Map();  // InterfaceDeclaration node -> implementing ClassDeclarations (CHA universe)
function moduleOf(sf) {
  const rel = path.relative(rootDir, path.resolve(sf.fileName)).replace(/\.[mc]?[tj]sx?$/, "");
  return rel.split(path.sep).join(".");
}
const cjsLocal = new Set(); // CJS export-surface units (spec 0.5 draft unitKind: "export")
const markCjs = (v) => { if (v) cjsLocal.add(v); return v; };
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
  // CJS export units (--allow-js, the npm half of report chaining): dist JS exports through
  // assignment, not declarations, so `module.exports = function …` / `exports.foo = …` /
  // `module.exports = { sign: fn }` were not units at all — a dep scan of jsonwebtoken yielded 4
  // shallow fns with the package's whole API invisible. The unit name mirrors what a CONSUMER's
  // resolution lands on: the fn's own name, the exported property, or the file's basename (the
  // `require('./sign')` shape).
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node) {
      const lhs = p.left.getText().replace(/\s+/g, "");
      if (lhs === "module.exports")
        return markCjs((ts.isFunctionExpression(node) && node.name?.text)
          || path.basename(node.getSourceFile().fileName).replace(/\.[mc]?jsx?$/, ""));
      const m = lhs.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
      if (m) return markCjs(m[1]);
    }
    if (ts.isPropertyAssignment(p) && p.initializer === node && ts.isObjectLiteralExpression(p.parent)) {
      const g = p.parent.parent;
      if (ts.isBinaryExpression(g) && g.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && g.right === p.parent && g.left.getText().replace(/\s+/g, "") === "module.exports")
        // .text, not getText(): a string-literal key keeps its quotes under getText, minting a
        // hash like pkg#"sign" the consumer's pkg#sign join can never hit (/code-review).
        return markCjs(p.name.text ?? p.name.getText());
    }
  }
  return null;
}
for (const sf of sources) {
  const mod = moduleOf(sf);
  (function collect(node) {
    // Every NAMED class gets a `Class.constructor` unit (synthesized when the ctor is implicit):
    // FIELD INITIALIZERS execute at construction (the JVM model — field inits belong to the ctor),
    // so their call sites need a unit to attribute to; without one, `class C { x = fs.readFileSync(…) }`
    // with an innocent explicit ctor was a SILENT-PURE hole (found chasing zod's Unknown profile).
    // The ClassDeclaration itself maps to the ctor unit, so `new C()` with an implicit ctor edges
    // there, and C passed AS A VALUE resolves as a callback target.
    if (ts.isClassDeclaration(node) && node.name) {
      for (const dec of ts.getDecorators?.(node) ?? []) {
        const e = dec.expression;
        if (ts.isCallExpression(e) && e.expression.getText() === "Entity"
            && e.arguments.length > 0 && ts.isStringLiteralLike(e.arguments[0]))
          entityTables.set(node, e.arguments[0].text);
      }
      // The interface-CHA universe (the Rust engine's local-trait move): `class PgStore
      // implements Store` is the edge a `store.save()` dispatch on the INTERFACE type resolves
      // through. Local interfaces only — flagging the lib.dom/lib.es surfaces would flood.
      for (const h of node.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of h.types) {
          // Register under EVERY declaration of the interface symbol: a merged interface (two
          // `interface Store` blocks / module augmentation) resolves a method to whichever block
          // declares it, and keying only declarations[0] silently missed the others (/code-review).
          const sym = checker.getSymbolAtLocation(t.expression);
          const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          for (const idecl of target?.declarations ?? []) {
            if (ts.isInterfaceDeclaration(idecl)
                && projectFiles.has(path.resolve(idecl.getSourceFile().fileName))) {
              if (!interfaceImpls.has(idecl)) interfaceImpls.set(idecl, []);
              interfaceImpls.get(idecl).push(node);
            }
          }
        }
      }
      const ctorQual = `${mod}.${node.name.text}.constructor`;
      if (!fns.has(ctorQual)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
        fns.set(ctorQual, { local: `${node.name.text}.constructor`, direct: new Set(), edges: new Set(),
                            hosts: new Set(), tables: new Set(), cmds: new Set(), paths: new Set(),
                            why: new Set(), entry: false,
                            loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}` });
      }
      nodeName.set(node, ctorQual);
    }
    const n = localName(node);
    if (n) {
      const qual = `${mod}.${n}`;
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      fns.set(qual, { local: n, direct: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
                      cmds: new Set(), paths: new Set(), why: new Set(), entry: false,
                      loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}` });
      nodeName.set(node, qual);
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer)
        nodeName.set(node.initializer, qual);
    }
    ts.forEachChild(node, collect);
  })(sf);
}

// callback-flow bookkeeping (the Rust engine's callback_named move, ported): for every call that
// edges to a LOCAL unit, record what each argument position received — a NAMED local unit (a
// resolvable callback target), or an opaque value (an inline closure stays attributed to the
// passer; a variable/property could be anything). A function that invokes a callback PARAMETER
// then resolves to the named targets IF every call site passed one — else honest Unknown.
const callbackArgs = new Map();    // calleeName -> Map(argIndex -> {targets:Set, opaque:boolean})
const paramInvokes = new Map();    // fnName -> Set(paramIndex) — this fn calls its own parameter

// ── entry points (SPEC §2 `entryPoint`): runtime-invoked roots the framework calls — their
// effects are never orphaned even with no in-project caller. Two populations for now:
// Nest HTTP handler decorators, and Next.js route-handler/middleware exports.
const HTTP_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Head", "Options"]);
const HTTP_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
for (const sf of sources) {
  const base = path.basename(sf.fileName).replace(/\.[mc]?[tj]sx?$/, "");
  (function mark(node) {
    const qual = nodeName.get(node);
    if (qual) {
      const rec = fns.get(qual);
      // Nest: a method carrying @Get()/@Post()/… is invoked by the framework router.
      for (const dec of ts.getDecorators?.(node) ?? []) {
        const e = dec.expression;
        const dn = ts.isCallExpression(e) ? e.expression.getText() : e.getText();
        if (HTTP_DECORATORS.has(dn)) rec.entry = true;
      }
      // Next: app-router route handlers (exported GET/POST/… in a `route` file) and middleware.
      const leaf = rec.local.split(".").pop();
      if (base === "route" && HTTP_EXPORTS.has(leaf)) rec.entry = true;
      if (base === "middleware" && leaf === "middleware") rec.entry = true;
    }
    ts.forEachChild(node, mark);
  })(sf);
}

// Resolve a use-site symbol through its IMPORT ALIAS to the real declaration: at `new X()` /
// `f(callback)` the symbol is the ImportSpecifier, not the class/function it names — without this,
// imported classes never edged to their ctor units and imported callback targets read opaque.
function realDecl(sym) {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch {}
  }
  return sym.valueDeclaration ?? sym.declarations?.[0];
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
        // `new C()` on a class with an IMPLICIT constructor resolves to no declaration — edge to
        // the class's (synthesized) ctor unit via the class identifier before concluding Unknown.
        let edged = false, externalClass = false;
        if (ts.isNewExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
          const cd = realDecl(checker.getSymbolAtLocation(node.expression));
          const t = cd && nodeName.get(cd);
          if (t) { rec.edges.add(t); edged = true; }
          // `new ExternalClass()` with an implicit ctor: same posture as an explicit external ctor
          // the classifier doesn't know — OPAQUE (contributes nothing), not Unknown. Consistency:
          // whether a library declares its ctor must not change the verdict.
          else if (cd && ts.isClassDeclaration(cd) && !projectFiles.has(path.resolve(cd.getSourceFile().fileName)))
            externalClass = true;
        }
        if (!edged && !externalClass) {
          rec.direct.add("Unknown"); // unresolvable call → Unknown, never silent-pure (SPEC §4)
          const callee = (node.expression?.getText?.() ?? "?").replace(/\s+/g, "").slice(0, 60);
          rec.why.add(`call:${callee}`); // an `any`-typed/indeterminate callee — named, so triage starts here
        }
      } else {
        const mod = declModule(decl);
        if (mod === "<local>") {
          const targetName = nodeName.get(decl);
          if (targetName) {
            rec.edges.add(targetName); // (EDGE) — cross-FILE edges resolve the same way
            // record what each argument position received (callback-flow, see callbackArgs)
            (node.arguments ?? []).forEach((a, i) => {
              const slot = (callbackArgs.get(targetName) ?? callbackArgs.set(targetName, new Map()).get(targetName));
              const cell = slot.get(i) ?? { targets: new Set(), opaque: false };
              if (ts.isIdentifier(a)) {
                const t = (() => { const d2 = realDecl(checker.getSymbolAtLocation(a)); return d2 && nodeName.get(d2); })();
                if (t) cell.targets.add(t);
                else cell.opaque = true;
              } else if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) {
                cell.opaque = true; // inline closure: body attributed to the PASSER; opaque to the callee
              } else {
                cell.opaque = true;
              }
              slot.set(i, cell);
            });
          } else if (!ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) {
            // Resolution landed on a TYPE (a function-type annotation, a method/property signature),
            // not a body. If that type belongs to a PARAMETER of a unit, defer to callback-flow
            // resolution (pass 2b) — all-named call sites resolve it; otherwise (a field, a
            // signature, a parameter of an un-collected function) the concrete callable is
            // genuinely indeterminate: (UNKNOWN), never silent-pure (SPEC §4). An arrow/fn-
            // expression is fine: its body is visible and already walked lexically (SEMANTICS §2).
            let p = decl;
            while (p && !ts.isParameter(p) && p !== p.parent) p = p.parent;
            const ownerUnit = p && ts.isParameter(p) && p.parent && nodeName.get(p.parent);
            if (ownerUnit) {
              const idx = p.parent.parameters.indexOf(p);
              (paramInvokes.get(ownerUnit) ?? paramInvokes.set(ownerUnit, new Set()).get(ownerUnit)).add(idx);
            } else {
              // Interface-CHA (the Rust engine's local-trait move, the JVM's bounded-CHA bound):
              // a method signature on a LOCAL interface resolves to the local implementing
              // classes' members when the dispatch is narrow (≤12 implementors) — `store.save()`
              // on an injected `Store` edges to `PgStore.save`. No implementor in sight, or too
              // many: honest Unknown, exactly as before.
              // Soundness rule (/code-review): the dispatch suppresses Unknown only when EVERY
              // implementor contributed an edge — an implementor whose member is inherited from a
              // base class (or otherwise not a unit) is genuinely unresolved here, and edging the
              // others while staying silent about it would drop its effects (a §4 regression: the
              // pre-CHA code always read Unknown at this site).
              let edged = false;
              if (ts.isMethodSignature(decl) && decl.parent && ts.isInterfaceDeclaration(decl.parent)) {
                const impls = interfaceImpls.get(decl.parent) ?? [];
                if (impls.length > 0 && impls.length <= 12) {
                  const member = decl.name?.getText?.();
                  let allResolved = true;
                  const targets = [];
                  for (const cls of impls) {
                    const m = (cls.members ?? []).find((x) =>
                      (ts.isMethodDeclaration(x) || ts.isPropertyDeclaration(x)) && x.name?.getText?.() === member);
                    const t = m && nodeName.get(m);
                    if (t) targets.push(t);
                    else allResolved = false;
                  }
                  for (const t of targets) rec.edges.add(t);
                  edged = targets.length > 0 && allResolved;
                }
              }
              if (!edged) {
                rec.direct.add("Unknown");
                const tn = decl.parent?.name?.getText?.() ?? decl.name?.getText?.() ?? "type";
                rec.why.add(`dispatch:${tn}`); // resolution landed on a type, not a body
              }
            }
          }
        } else if (mod === "<es-lib>") {
          // conventionally-pure ES surface (Array/String/…) — except the clock and entropy (SPEC §1).
          // `new Date()` (no args) captures the current time -> Clock; `Math.random()` -> Rand
          // (both missed on the first real-app dogfood: a JWT issuer's timestamps and a slugifier's
          // entropy were invisible).
          const name = decl.name ? decl.name.getText() : "";
          const parent = decl.parent && decl.parent.name ? decl.parent.name.getText() : "";
          if ((parent === "DateConstructor" && name === "now") || (parent === "Performance" && name === "now"))
            rec.direct.add("Clock");
          if (parent === "Math" && name === "random") rec.direct.add("Rand");
          if (ts.isNewExpression(node) && (node.arguments ?? []).length === 0
              && checker.getTypeAtLocation(node.expression)?.symbol?.name === "DateConstructor")
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
            // ORM route: `this.userRepository.find(…)` — the receiver's `Repository<UserEntity>`
            // type argument names the entity; its `@Entity("user")` decorator names the table.
            if (ts.isPropertyAccessExpression(node.expression)) {
              const rt = checker.getTypeAtLocation(node.expression.expression);
              for (const ta of checker.getTypeArguments?.(rt) ?? rt?.typeArguments ?? []) {
                const d = ta?.symbol?.declarations?.[0];
                const tbl = d && entityTables.get(d);
                if (tbl) rec.tables.add(tbl);
              }
            }
          }
          if (eff === "Exec") {
            const lit = firstStringLiteral(node);
            if (lit) rec.cmds.add(lit.trim().split(/\s+/)[0]); // the program of a command line
          }
          if (eff === "Fs") {
            const lit = firstStringLiteral(node);
            if (lit && /[\/\\]|^[.~]/.test(lit)) rec.paths.add(lit); // path-shaped literals only
          }
          // CANDOR_DEPS: an unclassified call into a package with a loaded sibling report inherits
          // that function's recorded transitive effects (+ literal surfaces) by `hash`.
          let inheritedFromDep = false;
          if (!eff && crossDeps.size > 0 && !mod.startsWith("<")) {
            let localTail = decl.name ? decl.name.getText() : null;
            const owner3 = decl.parent && decl.parent.name ? decl.parent.name.getText() : null;
            if (localTail && owner3 && (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl) || ts.isPropertySignature(decl)))
              localTail = `${owner3}.${localTail}`;
            // A typed consumer resolves into `@types/<pkg>`; the dep's report hashes under `<pkg>`.
            const depMod = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
            // Owner-prefixed first (Owner.member), bare member as the fallback: a CJS dist scan
            // hashes units under the bare export name, while interface/object-shaped typings (the
            // common @types style) resolve the consumer's call to Owner.member — without the
            // fallback exactly the typed-consumer shape the chain targets never joined.
            const hit = localTail && (crossDeps.get(`${depMod}#${localTail}`)
              ?? (decl.name ? crossDeps.get(`${depMod}#${decl.name.getText()}`) : undefined));
            if (hit) {
              inheritedFromDep = true;
              for (const x of hit.inferred) rec.direct.add(x);
              for (const v of hit.hosts) rec.hosts.add(v);
              for (const v of hit.cmds) rec.cmds.add(v);
              for (const v of hit.paths) rec.paths.add(v);
              for (const v of hit.tables) rec.tables.add(v);
            }
          }
          // unmatched external = (OPAQUE): contributes nothing — the curated-κ caveat C1. The
          // κ-coverage LEDGER makes the caveat per-scan evidence instead of a doc footnote: count
          // every npm package the code demonstrably calls that κ doesn't know and no sibling
          // report covers (the argon2 lesson — the blind spot landed on exactly the call a
          // security review cared about). Builtins are excluded: κ's builtin coverage is the
          // bounded frontier, and an unlisted builtin (path, util) is known-pure, not blind.
          if (!eff && !inheritedFromDep && !mod.startsWith("<")) {
            // The REAL package name first: a typed consumer of an untyped package resolves into
            // @types/<pkg>, and κ's tables/review lists hold the real name (/code-review: lodash
            // via @types/lodash was falsely disclosed — kappaKnows saw the unstripped name).
            const pkg = mod.startsWith("@types/") ? mod.slice("@types/".length) : mod;
            const file = decl.getSourceFile().fileName;
            if (!kappaKnows(pkg) && !depCoveredPkgs.has(pkg)
                && /node_modules\//.test(file) && !/node_modules\/(@types\/node|typescript)\//.test(file)) {
              unlistedSeen.set(pkg, (unlistedSeen.get(pkg) ?? 0) + 1);
            }
          }
        }
      }
      // the callee EXPRESSION being a plain identifier of function-typed parameter/field:
      // a PARAMETER defers to callback-flow resolution (below) — if every call site of this
      // function passes a NAMED local unit, the invocation resolves to those targets; otherwise
      // (or for fields/signatures) it is (UNKNOWN), never silent-pure (SPEC §4).
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        const d = sym && sym.valueDeclaration;
        if (d && ts.isParameter(d) && d.parent && nodeName.get(d.parent)) {
          const idx = d.parent.parameters.indexOf(d);
          const owner2 = nodeName.get(d.parent);
          (paramInvokes.get(owner2) ?? paramInvokes.set(owner2, new Set()).get(owner2)).add(idx);
        } else if (d && (ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d))) {
          rec.direct.add("Unknown"); // a callback value — genuinely indeterminate (SPEC §4)
          rec.why.add(`callback:${node.expression.getText()}`);
        }
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

// ---- pass 2b: callback-flow resolution (the callback_named move) ----------------------------------
// A fn invoking its parameter i resolves to the named targets IF this project shows call sites and
// EVERY one passed a named local unit at i. Any opaque arg — or NO visible call site (the fn may be
// exported; outside callers can pass anything) — keeps the honest Unknown.
for (const [fnName, idxs] of paramInvokes) {
  const rec = fns.get(fnName);
  if (!rec) continue;
  const slots = callbackArgs.get(fnName);
  for (const idx of idxs) {
    const cell = slots?.get(idx);
    if (cell && !cell.opaque && cell.targets.size > 0) {
      for (const t of cell.targets) rec.edges.add(t);
    } else {
      rec.direct.add("Unknown");
      rec.why.add(`callback:param#${idx}`); // an opaque (or externally-callable) callback parameter
    }
  }
}

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
  if (inf.length === 0 && !rec.entry) continue; // entry points stay visible even when pure
  const entry = {
    fn: name,
    loc: rec.loc,
    hash: `${pkgName}#${rec.local}`, // SPEC §2: the cross-package join key (package + local tail)
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
  if (rec.direct.has("Unknown") && rec.why.size) entry.unknownWhy = [...rec.why].sort();
  if (rec.entry) entry.entryPoint = true;
  if (cjsLocal.has(rec.local)) entry.unitKind = "export"; // spec 0.5 draft, informative
  functions.push(entry);
}
// `package` names what this report COVERS — a consumer chaining it registers coverage even when
// `functions` is empty (an all-pure package's report is its purity claim, SPEC §2 rule 3).
const envelope = { candor: { version: "candor-ts-0.4.3", toolchain: `node-${process.versions.node}`, spec: "0.4" },
                   package: pkgName, functions };
fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(envelope, null, 1));
const cg = {};
for (const [name, rec] of fns) cg[name] = [...rec.edges].sort();
fs.writeFileSync(`${outPrefix}.callgraph.json`, JSON.stringify(cg, null, 1));
console.error(`candor-ts: wrote ${functions.length} effectful functions (${fns.size} analyzed, ${sources.length} files) to ${outPrefix}.json`);
if (unlistedSeen.size > 0) {
  const top = [...unlistedSeen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = top.slice(0, 8).map(([p, n]) => `${p} (${n} call${n === 1 ? "" : "s"})`).join(", ");
  const more = top.length > 8 ? ` + ${top.length - 8} more` : "";
  console.error(`candor-ts: κ doesn't know ${top.length} package${top.length === 1 ? "" : "s"} this code calls into — `
    + `effects through ${top.length === 1 ? "it are" : "them are"} INVISIBLE (not Unknown): ${shown}${more}`);
}

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
