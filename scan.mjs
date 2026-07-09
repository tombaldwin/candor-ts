#!/usr/bin/env node
/**
 * candor-ts — the TypeScript implementation of candor-spec 0.5.
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
 * on violation, exit 2 LOUDLY on an unreadable policy. With CANDOR_BASELINE (or a config `baseline`
 * key), run the AS-EFF-005 regression guard against a saved report: an existing fn gaining an effect
 * is a violation (exit 1); an unparseable or different-build baseline is invalid gate input (exit 2).
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
import { printAgents } from "./contract.mjs";
import { isTestPath, kappa, kappaKnows, commandHeadEffects, hostLiteral, tablesInSql } from "./scan-core.mjs";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

// The single version + spec sources, read once. PKG_VERSION is the bare semver from package.json
// (e.g. "0.5.0"); ENGINE_VERSION (below) prefixes it for the report envelope's `version` field, and
// `--version` prints the bare form. SPEC_VERSION is the spec contract this build speaks — the SAME
// literal stamped into the envelope's `spec` field, so the doc lines and the report can never drift.
// Reused, never re-littered.
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "package.json"), "utf8")).version;
const SPEC_VERSION = "0.8";

// --version: a print-and-exit MODE, handled before the main arg walk so it never depends on a target.
// Fully OFFLINE — candor never phones home. Staying current is the AGENT's job: read the installed
// build + upgrade line here, then (the agent has the network) compare against npm and upgrade.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`candor-ts ${PKG_VERSION} (spec ${SPEC_VERSION})`);
  console.log("upgrade: npm install -g candor-ts@latest");
  process.exit(0);
}

// -h / --help: a print-and-exit MODE (like --version), handled before the arg walk so `-h` (a single
// dash) is never mistaken for the scan target by the positional fallthrough below.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`candor-ts ${PKG_VERSION} — TypeScript/JavaScript effect scanner (candor-spec ${SPEC_VERSION})

USAGE: candor-ts <dir | file.ts | tsconfig.json> [--out <prefix>] [--json] [--policy <file>] [--gate-json <file>] [--allow-js] [--agents] [--version]

  <target>          a dir, a .ts file, or a tsconfig.json to scan
  --out <prefix>    write the report to <prefix>.json + <prefix>.callgraph.json
  --json            print the report as JSON to stdout (instead of writing files)
  --policy <file>   enforce a policy file (deny/pure/allow/forbid, candor-spec §6.2) — exit 1 on a
                    violation, 2 if unreadable; honours $CANDOR_POLICY when the flag is absent
  --gate-json <f>   write the structured gate verdict { spec, ok, violations } as JSON (candor-spec §3.3)
  --allow-js        also scan plain JS/Node (.js/.mjs/.cjs), not just TypeScript
  --agents          print the agent contract for this build (AGENTS.md)
  -V, --version     print the build and spec version (offline)
  -h, --help        show this help

CANDOR_BASELINE=<report.json> (or a .candor/config \`baseline\` key) runs the AS-EFF-005 regression
guard against a saved same-build report: exit 1 when an existing function gained an effect, exit 2
on an unparseable or different-build baseline (never evaluated), a stderr note when absent.

See https://github.com/tombaldwin/candor`);
  process.exit(0);
}

// ---- args ----------------------------------------------------------------------------------------
// ONE pass: the first non-flag is the target; value-taking flags consume the next arg and FAIL on a
// missing/flag-shaped value; an unknown flag fails; flags may precede the target. `--agents` is a
// flag (a print-and-exit MODE) — it must NOT fire when it is the VALUE of --out/--policy, which the
// value-consuming skip handles, nor produce a "lying unknown flag" error for a real flag given first.
const usage = "usage: candor-ts <dir | file.ts | tsconfig.json> [--out <prefix>] [--json] [--policy <file>] [--gate-json <file>] [--allow-js] [--agents] [--version] [--help]";
const argv = process.argv.slice(2);
let target = null, outPrefix = null, policyPath = process.env.CANDOR_POLICY ?? null, gateJsonPath = null, allowJs = false, wantAgents = false, wantJson = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--agents") wantAgents = true;
  else if (a === "--json") wantJson = true;
  else if (a === "--allow-js") allowJs = true;
  else if (a === "--out" || a === "--policy" || a === "--gate-json") {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) { console.error(`candor-ts: ${a} requires a value (${usage})`); process.exit(2); }
    if (a === "--out") outPrefix = v; else if (a === "--policy") policyPath = v; else gateJsonPath = v;
    i++;
  }
  // Any leading-dash token that isn't a recognized flag is an unknown flag — NOT a positional target
  // (SPEC §6.2/§7). `-h`/`-V`/`--help`/`--version` are print-and-exit modes consumed above, so by here
  // a single-dash token (`-x`, the typo `-policy`) can only be a mistake; treating it as the scan
  // target would silently scan the wrong thing.
  else if (a.startsWith("-")) { console.error(`candor-ts: unknown flag ${a} (${usage})`); process.exit(2); }
  else if (target === null) target = a;
  else if (outPrefix === null) outPrefix = a; // legacy positional prefix
  else { console.error(`candor-ts: unexpected extra argument ${a} (${usage})`); process.exit(2); }
}
if (wantAgents) { printAgents(); process.exit(0); }
if (target === null) { console.error(usage); process.exit(2); }

// ---- .candor/config (candor-spec §config; the checked-in alternative to the CANDOR_* env vars) -----
// Discovery is anchored to the SCAN TARGET (walk up from the target dir to the repo root's
// .candor/config), never the CWD; $CANDOR_CONFIG overrides discovery entirely. Precedence: CLI flag →
// CANDOR_* env → this file → default. FAIL-CLOSED: a configured-but-unusable file (a set CANDOR_CONFIG
// naming a missing path; a discovered file that exists but can't be read) exits 2 — a gate source must
// never vanish silently (the §6.2 unreadable-policy posture). Only genuine absence is an empty config.
// Keys are the shared vocabulary (policy/baseline/strict/no-ambient/closed-world/taint/deps); candor-ts
// implements `policy` + `deps` — the others are inert here (they drive other engines' gates), and a key
// OUTSIDE the vocabulary warns (typo protection: a misspelt `policy` must not silently drop the gate).
const CONFIG_KEYS = new Set(["policy", "baseline", "strict", "no-ambient", "closed-world", "taint", "deps"]);
// The ANCHOR a config file's RELATIVE path values (policy/deps) resolve against: the repo the config
// belongs to — the parent of its `.candor/` directory (the standard layout; candor-init scaffolds
// `policy arch.policy` meaning the repo root's), else the config file's own directory. NEVER the
// process CWD (family rule, matching policy.mjs discoverConfigPolicy's repoRoot): a checked-in config
// must mean the same file whether the scan is launched from the repo, from $HOME, or from a CI step's
// working-directory. Env/CLI values stay CWD-relative — they're per-invocation, not checked in.
function configAnchor(file) {
  const dir = path.dirname(path.resolve(file));
  return path.basename(dir) === ".candor" ? path.dirname(dir) : dir;
}
function loadCandorConfig(targetPath) {
  let file = process.env.CANDOR_CONFIG ?? null;
  if (file !== null) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error(`candor-ts: CANDOR_CONFIG set but ${file} is not a readable file — failing (exit 2)`);
      process.exit(2);
    }
  } else {
    let dir = path.resolve(targetPath);
    try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
    for (let d = dir; ; d = path.dirname(d)) {
      const cand = path.join(d, ".candor", "config");
      if (fs.existsSync(cand)) { file = cand; break; }
      if (path.dirname(d) === d) break;                       // filesystem root
    }
    if (file === null && fs.existsSync(".candor/config")) file = ".candor/config";
    if (file === null) return {};
  }
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    console.error(`candor-ts: config ${file} exists but could not be read (${e.message}) — failing (exit 2)`);
    process.exit(2);
  }
  const cfg = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();                 // strip inline comments (§6.2 lexical)
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(.*)$/);
    const key = m[1].toLowerCase(), val = (m[2] ?? "").trim();
    if (!CONFIG_KEYS.has(key)) {
      console.error(`candor-ts: ignoring unknown config key '${key}' in ${file}`);
      continue;
    }
    cfg[key] = val;
  }
  // Resolve the PATH-valued keys against the config's anchor (see configAnchor). `deps` is a path
  // LIST — each token resolves; an empty value stays empty (configured-with-empty fails loud below).
  const anchor = configAnchor(file);
  if (cfg.policy) cfg.policy = path.resolve(anchor, cfg.policy);
  if (cfg.baseline) cfg.baseline = path.resolve(anchor, cfg.baseline);
  if (cfg.deps) cfg.deps = cfg.deps.split(/[\s:,]+/).filter(Boolean).map((t) => path.resolve(anchor, t)).join(":");
  return cfg;
}
const candorConfig = loadCandorConfig(target);
// precedence: the --policy flag / CANDOR_POLICY env already populated policyPath; the config is the floor.
// A BARE `policy` line ("" value) means configured-with-empty → the unreadable-policy path fails loud.
if (policyPath === null && candorConfig.policy !== undefined) policyPath = candorConfig.policy;
// baseline (the AS-EFF-005 regression guard, SPEC §7 item 5): CANDOR_BASELINE env → config `baseline`
// (path-valued keys are already resolved against the config's anchor above). No CLI flag — matching
// candor-java, the reference engine (env/config only). A BARE `baseline` line ("") fails loud below.
let baselinePath = process.env.CANDOR_BASELINE ?? null;
if (baselinePath === null && candorConfig.baseline !== undefined) baselinePath = candorConfig.baseline;

// ---- project discovery (a dir, a single file, or a tsconfig) --------------------------------------
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
// --json prints the report to stdout and writes NOTHING, so skip creating the (otherwise default) .candor/ dir.
// The scanned package's name — the first half of the cross-package join key (SPEC §2 `hash`).
let pkgName = path.basename(rootDir);
try {
  const pj = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (pj.name) pkgName = pj.name;
} catch {}
if (!wantJson) fs.mkdirSync(path.dirname(path.resolve(outPrefix)), { recursive: true });

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
                      "imports won't resolve, so calls into those packages read pure/invisible (not Unknown) " +
                      "and effects through them are silently dropped. Run `npm install` in the target first.");
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
// ONE version source: package.json. A second hardcoded literal (the envelope's, the --agents
// banner's) that drifted from this would make the engine distrust its OWN reports at the §2.1
// staleness check (`d.candor?.version !== ENGINE_VERSION`), silently downgrading every chained dep.
const ENGINE_VERSION = `candor-ts-${PKG_VERSION}`;
const crossDeps = new Map(); // hash -> {inferred:Set, hosts:[], cmds:[], paths:[], tables:[]}
// Packages a loaded sibling report COVERS — exempt from the κ ledger even when a call joins no
// entry (reports omit pure functions: the silence is the purity claim, SPEC §2 rule 3 — the
// serde_json rule the Rust/JVM engines already carry; /code-review found TS missing it). Fed from
// the envelope's `package` field (works for an all-pure EMPTY report) and from entry hash prefixes.
const depCoveredPkgs = new Set();
{
  const spec = process.env.CANDOR_DEPS ?? candorConfig.deps ?? "";   // env overrides the config `deps` key
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


// The module a declaration came from: a project file → "<local>", @types/node → the builtin name,
// node_modules/<pkg> → the package name, the ES lib → "<es-lib>".
function declModule(decl) {
  const f = path.resolve(decl.getSourceFile().fileName);
  if (projectFiles.has(f)) return "<local>";
  // `(.+?)` not `(\w+?)`: a SUBPATH typing (`@types/node/fs/promises.d.ts`, `dns/promises.d.ts`) carries
  // a `/` that `\w` can't cross, so the module collapsed to `@types/node` (via the node_modules branch
  // below) and the `fs(\/promises)?` / `dns(\/promises)?` κ rules — written to cover exactly these — could
  // never fire (`fs/promises` is the dominant modern Node FS API: a silent-pure under-report). Keep the
  // slash so the module reads `fs/promises`, which the rules match.
  let m = f.match(/@types\/node\/(.+?)\.d\.ts$/);
  if (m) return m[1];
  if (/typescript\/lib\/lib\..*\.d\.ts$/.test(f)) return "<es-lib>";
  m = f.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
  if (m) {
    // `@types/X` (DefinitelyTyped) provides types for the RUNTIME package X — map it to X so the curated κ
    // tier (keyed by the runtime name: pg/ws/…) fires. Without this a package typed via @types resolved to
    // "@types/pg", the `pg`→Db rule never matched, and the resolved-but-unmodeled external decl read
    // SILENT-PURE — `pool.query()` in a real TS Postgres app (which MUST have @types/pg installed to use
    // pg) reported pure (found by a node_modules corpus run). Scoped runtime pkgs use the `__` convention:
    // `@types/babel__core` → `@babel/core`.
    const tm = m[1].match(/^@types\/(.+)$/);
    if (tm) return tm[1].includes("__") ? "@" + tm[1].replace("__", "/") : tm[1];
    return m[1];
  }
  return f;
}

// SPEC §5.1 — the effect manifest. An uncurated package MAY declare its effect surface in its
// package.json (`"candorEffects": ["Net"]`), read as the declared-not-verified tier: it kills the
// silent pure/blind-spot the package would otherwise carry, exactly like a cap type (and unlike
// candor's own analysis, which is checked). A name outside §1 VOIDS the declaration loudly — a typo
// must never silently narrow a surface. Cached per package. `file` is the resolved declaration source.
const EFFECT_VOCAB = new Set(["Net", "Fs", "Db", "Exec", "Env", "Clock", "Ipc", "Log", "Rand", "Clipboard"]);
const _manifestCache = new Map();
// Returns the declared effect array (possibly EMPTY — `[]` is an explicit "declared pure", covered, not
// a blind spot), or `null` for no/invalid declaration (still a blind spot). A name outside §1 voids the
// declaration loudly; a non-array `candorEffects` is malformed and warned.
function packageManifestEffects(file) {
  const m = file && file.match(/^(.*\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))\//);
  if (!m) return null;
  let dir = m[1];
  // A manifest read from an `@types/<pkg>` directory is a TRUST-BOUNDARY HOLE: the @types stub is a
  // type-only package published by DefinitelyTyped/anyone — NOT the effect-owning package. Honoring its
  // `candorEffects` let an attacker's `@types/realpkg` declare `[]` to SILENCE the real realpkg's effects
  // AND its κ-ledger disclosure (defeating the spec's "a missing manifest is visible via κ" safety net).
  // Redirect to the REAL package's own dir, whose author controls it (`@types/babel__core` → `@babel/core`,
  // `@types/foo` → `foo`); if that has no manifest, it stays an honest κ-ledger blind spot, never silenced.
  const at = dir.match(/^(.*\/node_modules\/)@types\/([^/]+)$/);
  if (at) {
    const real = at[2].includes("__") ? "@" + at[2].replace("__", "/") : at[2];
    dir = at[1] + real;
  }
  if (_manifestCache.has(dir)) return _manifestCache.get(dir);
  let result = null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).candorEffects;
    if (Array.isArray(d)) {
      const bad = d.filter((e) => !EFFECT_VOCAB.has(e));
      if (bad.length) console.error(`candor-ts: ${path.basename(dir)} candorEffects has an invalid effect '${bad[0]}' — declaration voided (SPEC §1)`);
      else result = d; // a valid declaration, including [] = declared pure
    } else if (d !== undefined) {
      console.error(`candor-ts: ${path.basename(dir)} candorEffects must be an array of §1 effect names — ignored`);
    }
  } catch { /* no/unreadable manifest → undeclared */ }
  _manifestCache.set(dir, result);
  return result;
}

// ---- the literal surfaces (SPEC §2 hosts/cmds/paths/tables): the statically-decidable subset ------
// Read ONLY from string literals at a classified call — informative, never complete, never inferred.
function firstStringLiteral(node) {
  for (const a of node.arguments ?? []) {
    if (ts.isStringLiteralLike(a)) return a.text;
  }
  return null;
}

// Is this property/element access a SETTER target reached through a destructuring assignment —
// `({ k: x.prop } = src)` or `[x.prop] = arr` (sweep [32])? Walk up through PropertyAssignment /
// Object|ArrayLiteral wrappers to the enclosing `=`; it is a target only when the wrapping literal is the
// LHS (`.left`) of the assignment. A property access on the RHS (`src = { k: x.prop }`) walks to a literal
// that is `.right`, so it stays a getter READ — no false setter attribution.
function isDestructuringAssignTarget(node) {
  let cur = node, parent = node.parent;
  while (parent) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === cur) { cur = parent; parent = parent.parent; continue; }
    if (ts.isShorthandPropertyAssignment(parent)) return false; // `{prop}` has no access node to attribute
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) { cur = parent; parent = parent.parent; continue; }
    if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) { cur = parent; parent = parent.parent; continue; }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return parent.left === cur;
    return false;
  }
  return false;
}

// The literal PROGRAM head a subprocess call NAMES — argv[0] specifically, never a later argument.
// Unlike firstStringLiteral (the first literal ANYWHERE in the args), this refuses to refine when
// the program (arg0) is a runtime value but a trailing arg is a literal whose basename hits the head
// table: `spawn(toolVar, "curl")` must NOT fabricate Net — the literal is an argument, not the
// program (spec §4 ⟨0.5⟩: the head is argv[0]). Mirrors candor-java programHeadLiteral and the Rust
// is_cmd_naming_method gate. Returns null when arg0 is not a static string literal — the safe
// direction. Used ONLY for the effect refinement, never to widen it; the cosmetic `cmds` surface
// keeps firstStringLiteral.
function programHeadLiteral(node) {
  const a0 = (node.arguments ?? [])[0];
  return a0 && ts.isStringLiteralLike(a0) ? a0.text : null;
}
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
const classOverrides = new Map();  // base-method MemberDeclaration node -> overriding subclass member nodes (class-CHA)
// `Object.defineProperty(target, key, { get/set })` runtime accessors (the silent-pure defineProperty
// hole): the TS checker types `target.key` as a plain DATA property (defineProperty is a runtime
// construct), so `accessorAt` finds no get-accessor and the forcing site `target.key` reads
// silent-pure. We index, keyed by the TARGET's symbol → key string → { get, set } descriptor function
// node, every such accessor seen in the project. The forcing-site arm consults this when the type-level
// accessor resolution comes up empty (precise edge when target+key resolve; else honest Unknown).
const definePropAccessors = new Map(); // targetSymbol -> Map(key -> { get?: fnNode, set?: fnNode })
// A descriptor accessor with a COMPUTED key (`Object.defineProperty(o, k, {get})`) on a RESOLVABLE
// target: the target symbol is known but the key isn't, so a forcing site `o.anything` MIGHT hit it. We
// record the target symbol → kinds present, and disclose Unknown at any access onto that target whose
// type-level / precise-key resolution missed — never silent-pure (matching the syntactic object-literal-
// getter posture). A descriptor whose TARGET itself is unresolvable can't be tied to any forcing site;
// its unit is still minted (effects classified, callgraph-visible), and there is nothing more to disclose.
const definePropDynamicKey = new Map(); // targetSymbol -> Set("get"|"set")
// Resolve `extends X` to X's LOCAL ClassDeclaration (through an import alias), or null. Module-level
// so both the class-CHA INDEX (below) and the dispatch site's RECEIVER-SUBTREE scoping share one
// definition of the local inheritance edge.
function localBaseClassOf(cls) {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const t = h.types?.[0];
    if (!t) continue;
    let sym = checker.getSymbolAtLocation(t.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
    const bd = (sym?.declarations ?? []).find((d) => ts.isClassDeclaration(d));
    if (bd && projectFiles.has(path.resolve(bd.getSourceFile().fileName))) return bd;
  }
  return null;
}
// Is `cls` in the subtree rooted at `root` (i.e. cls === root, or cls transitively `extends` root
// through LOCAL classes)? Used to scope a base-member override fan-out to the RECEIVER's static type
// — a sibling subclass's override lives OUTSIDE this subtree and must not contaminate the verdict.
function classInSubtree(cls, root) {
  let cur = cls, guard = 0;
  while (cur && guard++ < 64) {
    if (cur === root) return true;
    cur = localBaseClassOf(cur);
  }
  return false;
}
function moduleOf(sf) {
  const rel = path.relative(rootDir, path.resolve(sf.fileName)).replace(/\.[mc]?[tj]sx?$/, "");
  return rel.split(path.sep).join(".");
}
// Enclosing `namespace`/`module` blocks are NAME SEGMENTS (the family ruling: §6.2 scope segments
// split on the same boundaries as the §3.1 query name ladder, and a namespace is a segment — rust
// modules and swift enum-namespaces already qualify this way). A unit declared in
// `export namespace app { … }` is `mod.app.fn`, so a layer policy authored against namespace layers
// (`forbid app -> repo`, `deny Db app`) bites in TS instead of being silently inert. Returns the
// dotted prefix ("app." / "a.b.") or "". Dotted (`namespace a.b`) and nested forms both contribute
// each identifier segment; ambient string-named modules (`declare module "x"`) and `declare global`
// augmentations contribute nothing (not lexical layers of THIS module).
function namespacePrefixOf(node) {
  const segs = [];
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (!ts.isModuleBlock(p)) continue;
    // `namespace a.b { … }` nests ModuleDeclarations (a -> b -> block); walk the chain so every
    // dotted segment lands, innermost-first up.
    for (let d = p.parent; d && ts.isModuleDeclaration(d); d = ts.isModuleDeclaration(d.parent) ? d.parent : null) {
      if (d.name && ts.isIdentifier(d.name) && !(d.flags & ts.NodeFlags.GlobalAugmentation))
        segs.unshift(d.name.text);
    }
  }
  return segs.length ? `${segs.join(".")}.` : "";
}
// Is `node` (a function-expression / method-declaration / arrow) the `get` or `set` member of an
// accessor DESCRIPTOR object passed to `Object.defineProperty(target, key, desc)` /
// `Object.defineProperties(target, { key: desc, … })` / `Object.create(proto, { key: desc, … })`?
// Returns { kind:"get"|"set", targetExpr, keyText } when so (keyText is null for a non-literal key),
// or null. Only an accessor (`get`/`set`) descriptor qualifies — a `value:` (data) descriptor is NOT
// a function-property-named get/set, so it never matches (no fabrication on data props). The descriptor
// member may be `get(){}` (method), `get: function(){}` / `get: () => {}` (property-assignment): both
// have a parent PropertyAssignment-or-MethodDeclaration whose name is the identifier `get`/`set`.
function definePropertyAccessor(node) {
  let memberName = null, propParent = null;
  const p = node.parent;
  if (!p) return null;
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isObjectLiteralExpression(node.parent)) {
    // `{ get(){…} }` / `{ get x(){…} }` — but a real get/set-accessor here is the SYNTACTIC object
    // literal getter (already handled honestly); only a plain METHOD named `get`/`set` is a descriptor
    // member. A GetAccessor/SetAccessor inside a descriptor object is not how defineProperty descriptors
    // are written, so restrict to a method whose name is literally `get`/`set`.
    if (ts.isMethodDeclaration(node)) { memberName = node.name?.getText?.(); propParent = node; }
  } else if (ts.isPropertyAssignment(p) && p.initializer === node && ts.isObjectLiteralExpression(p.parent)) {
    memberName = p.name?.getText?.(); propParent = p;
  }
  if (memberName !== "get" && memberName !== "set") return null;
  const descObj = ts.isMethodDeclaration(propParent) ? propParent.parent : propParent.parent; // ObjectLiteral
  // Two shapes for the enclosing call:
  //   defineProperty(target, key, descObj)        — descObj is arg #2
  //   defineProperties(target, { key: descObj })  — descObj is a property value of arg #1
  //   create(proto, { key: descObj })             — descObj is a property value of arg #1
  const callOf = (n) => {
    let c = n.parent;
    while (c && !ts.isCallExpression(c)) c = c.parent;
    return c;
  };
  // Walk out at most: descObj -> (its parent is either the defineProperty call's arg, OR a
  // PropertyAssignment in a properties-map -> ObjectLiteral -> defineProperties/create call).
  const fnName = (call) => call && call.expression && call.expression.getText().replace(/\s+/g, "");
  // Case A: descObj is the 3rd argument of Object.defineProperty(target, key, descObj).
  if (descObj.parent && ts.isCallExpression(descObj.parent)) {
    const call = descObj.parent;
    if (fnName(call) === "Object.defineProperty" && call.arguments[2] === descObj) {
      const keyArg = call.arguments[1];
      const keyText = keyArg && ts.isStringLiteralLike(keyArg) ? keyArg.text : null;
      return { kind: memberName, targetExpr: call.arguments[0], keyText };
    }
    return null;
  }
  // Case B: descObj is a property value in a properties-map for defineProperties / create.
  if (descObj.parent && ts.isPropertyAssignment(descObj.parent)
      && ts.isObjectLiteralExpression(descObj.parent.parent)) {
    const keyProp = descObj.parent;            // `key: descObj`
    const propsMap = descObj.parent.parent;    // `{ key: descObj, … }`
    const call = callOf(propsMap);
    const fn = fnName(call);
    if (call && (fn === "Object.defineProperties" || fn === "Object.create")
        && (call.arguments[1] === propsMap)) {
      const keyText = ts.isStringLiteralLike(keyProp.name) ? keyProp.name.text
        : ts.isIdentifier(keyProp.name) ? keyProp.name.text : null;
      // For defineProperties the target is arg0. For create the NEW object IS the call's result; the
      // forcing site reads it through the binding the call is assigned to (`const o = Object.create(…)`),
      // so the stable target is that VariableDeclaration's name. When create's result isn't bound to a
      // simple identifier, there's no joinable target — targetExpr stays null (unit still minted; the
      // unpinnable marker drives the Unknown disclosure, never silent-pure).
      let targetExpr = null;
      if (fn === "Object.defineProperties") targetExpr = call.arguments[0];
      else if (fn === "Object.create" && call.parent
               && ts.isVariableDeclaration(call.parent) && call.parent.initializer === call
               && ts.isIdentifier(call.parent.name))
        targetExpr = call.parent.name;
      return { kind: memberName, targetExpr, keyText };
    }
  }
  return null;
}
// `_lastCjs` is set by markCjs when localName() returns a CJS export-surface name, read right after
// the call to tag THAT unit (spec 0.5 draft unitKind: "export"). Keyed to the unit, not a project-
// wide name set — a same-named ordinary TS function in another file must NOT be mislabeled.
let _lastCjs = false;
const markCjs = (v) => { if (v) _lastCjs = true; return v; };
function localName(node) {
  _lastCjs = false;
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${node.name.getText()}`;
  // GET/SET ACCESSORS are units too — a property read/assignment that resolves to one edges here, so
  // an accessor body that does I/O classifies normally instead of being a SILENT-PURE hole (and its
  // effect is no longer misattributed to the enclosing class's synthesized ctor, which `enclosing()`
  // would otherwise pick as the nearest unit). get/set are DISTINCT units (a class may have both for
  // one name): `Class.get raw` / `Class.set raw`, mirroring how the checker keeps them apart.
  if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isClassDeclaration(node.parent) && node.parent.name)
    return `${node.parent.name.text}.${ts.isGetAccessorDeclaration(node) ? "get" : "set"} ${node.name.getText()}`;
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
  // `Object.defineProperty(target,"key",{ get(){…}/set(){…} })` descriptor accessors — the runtime
  // accessor the TS checker can't see as a get/set (it types target.key as a data prop). Mint the
  // descriptor body as a UNIT so its effects classify normally instead of being a silent-pure hole;
  // the forcing-site arm edges target.key to it. Name keyed by target + key + kind so the same name a
  // forcing site computes joins here. Both shapes (`get(){}` method, `get:fn` property) land here.
  {
    const da = definePropertyAccessor(node);
    if (da) {
      const tn = da.targetExpr ? da.targetExpr.getText().replace(/\s+/g, "") : "<create>";
      const key = da.keyText ?? `[computed@${node.getStart()}]`;
      return `defineProperty(${tn}).${da.kind} ${key}`;
    }
  }
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
// True when `node` is lexically inside a FUNCTION body — so its bare local name can collide with a
// module-level or sibling-scope unit of the same name (see the qual disambiguation below). A namespace/
// module block and the source file are NOT function scopes (their members are top-level units).
function isFunctionScoped(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isSourceFile(p) || ts.isModuleBlock(p)) return false;
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)
        || ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)
        || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
      return true;
  }
  return false;
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
      const ctorQual = `${mod}.${namespacePrefixOf(node)}${node.name.text}.constructor`;
      if (!fns.has(ctorQual)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
        fns.set(ctorQual, { local: `${node.name.text}.constructor`, direct: new Set(), edges: new Set(),
                            hosts: new Set(), tables: new Set(), cmds: new Set(), paths: new Set(),
                            blind: new Set(), incomplete: new Set(), why: new Set(), entry: false,
                            loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}` });
      }
      nodeName.set(node, ctorQual);
    }
    const n = localName(node);
    const isCjsExport = _lastCjs; // captured immediately: localName set it for THIS node only
    if (n) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      // Disambiguate FUNCTION-SCOPED local function units by position. A `const persist = () => …` (or a
      // nested `function persist(){}`) inside a fn body shares the bare `mod.name` key with a module-level
      // OR sibling-scope unit of the same name, so the second `fns.set` CLOBBERS the first and a call that
      // resolves (correctly, via the checker) to the LOCAL decl reads the OTHER unit's effects off the
      // shared entry — FABRICATING them onto a pure caller. `nodeName` is keyed by NODE identity, so a
      // per-node-unique key keeps resolution exact; only TOP-LEVEL units need the stable bare name a
      // consumer's hash-join targets (a function-scoped local is never an export, so nothing joins to it).
      // Namespace segments go in the QUAL only; `local` (and so the §2 hash `pkg#local`) stays the
      // bare name — a consumer's cross-package join resolves the callee's own name, never the
      // producer's namespace nesting, so widening the hash would break report chaining.
      const nsp = namespacePrefixOf(node);
      const qual = isFunctionScoped(node) ? `${mod}.${nsp}${n}#${line + 1}:${character + 1}` : `${mod}.${nsp}${n}`;
      fns.set(qual, { local: n, direct: new Set(), edges: new Set(), hosts: new Set(), tables: new Set(),
                      cmds: new Set(), paths: new Set(), blind: new Set(), incomplete: new Set(), why: new Set(), entry: false, isCjsExport,
                      loc: `${path.relative(rootDir, sf.fileName)}:${line + 1}:${character + 1}` });
      nodeName.set(node, qual);
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer)
        nodeName.set(node.initializer, qual);
      // Index a `Object.defineProperty` descriptor accessor by its target SYMBOL + key, so a forcing
      // site `target.key` (which the checker types as a plain data prop) can edge to this unit. When
      // the target/key can't be pinned to a static symbol/literal, the unit still exists (named above)
      // but no precise edge is possible — record an UNRESOLVED marker so an access onto such a target
      // is disclosed Unknown rather than silently dropped.
      const da = definePropertyAccessor(node);
      if (da) {
        const tsym = da.targetExpr ? checker.getSymbolAtLocation(da.targetExpr) : null;
        if (tsym && da.keyText !== null) {
          if (!definePropAccessors.has(tsym)) definePropAccessors.set(tsym, new Map());
          const byKey = definePropAccessors.get(tsym);
          if (!byKey.has(da.keyText)) byKey.set(da.keyText, {});
          byKey.get(da.keyText)[da.kind] = node;
        } else if (tsym) {
          // computed key on a known target — any access onto this target may hit it: disclose Unknown.
          if (!definePropDynamicKey.has(tsym)) definePropDynamicKey.set(tsym, new Set());
          definePropDynamicKey.get(tsym).add(da.kind);
        }
        // (a wholly-unresolvable target leaves only the minted unit — nothing to join a forcing site to.)
      }
    }
    ts.forEachChild(node, collect);
  })(sf);
}

// Class-CHA universe (the override half of the Rust engine's local-trait / bounded-CHA move): a
// method call on a BASE-class-typed receiver resolves statically to the base method, but a SUBCLASS
// may override it with an effectful body — `class Dog extends Animal { speak(){ fs.readFileSync() } }`.
// Without fanning out to the override, `a.speak()` on an `Animal`-typed `a` comes back concrete-PURE
// (a silent-pure soundness hole, strictly worse than Unknown). We index, for every LOCAL base-class
// member, the overriding members in its LOCAL subclasses (walking the full `extends` chain so a
// grand-subclass override is attributed to the right ancestor declaration). The dispatch site (below)
// edges to the base PLUS these overrides, bounded by the same ≤12 family limit the interface path
// uses, with the same allResolved honesty gate. Local subclasses only (an external base/override
// surface stays OPAQUE, never fabricated). Mirrors interfaceImpls' merged-decl posture.
{
  const memberName = (m) => (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)
    || ts.isSetAccessorDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name?.getText?.();
  const baseClassOf = localBaseClassOf;
  for (const sf of sources) {
    (function scan(node) {
      if (ts.isClassDeclaration(node)) {
        for (const m of node.members ?? []) {
          const name = memberName(m);
          if (!name) continue;
          // Walk the base chain; register this subclass member as an override of the NEAREST
          // ancestor member of the same name (one edge per (name) — TS forbids two declarations of
          // one accessor-kind/method on a class, so the first match up the chain is the override
          // target). Stop after the first ancestor declares the name: that is the unit a base-typed
          // dispatch lands on; higher ancestors are reached transitively via their own override edges.
          let base = baseClassOf(node), guard = 0;
          while (base && guard++ < 64) {
            const ancestor = (base.members ?? []).find((x) => memberName(x) === name
              && (ts.isMethodDeclaration(x) === ts.isMethodDeclaration(m))
              && (ts.isGetAccessorDeclaration(x) === ts.isGetAccessorDeclaration(m))
              && (ts.isSetAccessorDeclaration(x) === ts.isSetAccessorDeclaration(m)));
            if (ancestor) {
              if (!classOverrides.has(ancestor)) classOverrides.set(ancestor, []);
              classOverrides.get(ancestor).push(m);
              break;
            }
            base = baseClassOf(base);
          }
        }
      }
      ts.forEachChild(node, scan);
    })(sf);
  }
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

// Resolve a value-reference NODE (`expr` in `expr.call(…)`/`expr.apply(…)`) to the qualified name of the
// FUNCTION UNIT it ultimately denotes — following ONE OR MORE local-variable aliases. The `.call`/`.apply`
// arm lands on the es-lib member so `getResolvedSignature` never sees the real fn; for a direct identifier
// (`effectful.call`) `realDecl` → the fn decl → a minted unit. But `const m = effectful; m.call(…)` resolves
// `m` to its VARIABLE declaration, whose initializer is the bare identifier `effectful` — the variable node
// itself is NOT a minted unit (only var-decls whose initializer is an arrow/fn-expr are), so the edge was
// dropped → silent-pure (the cardinal sin). Here we chase the variable's initializer identifier/member to
// the function it aliases. Returns the unit name, or null if the chain can't be pinned to a function unit.
// Bounded depth guards a pathological `const a=b, b=a` cycle. NO fabrication: a non-fn binding (or any link
// that doesn't resolve to a minted fn unit) returns null and the caller adds nothing / discloses Unknown.
function resolveFnRefUnit(refNode, depth = 0) {
  if (!refNode || depth > 8) return null;
  if (!ts.isIdentifier(refNode) && !ts.isPropertyAccessExpression(refNode)) return null;
  const d = realDecl(checker.getSymbolAtLocation(refNode));
  if (!d) return null;
  // Already a minted unit (the function itself, an arrow/fn-expr const, a class method/property)?
  const direct = nodeName.get(d);
  if (direct) return direct;
  // A local variable / parameter bound to a function reference — follow the initializer alias.
  if ((ts.isVariableDeclaration(d) || ts.isBindingElement(d) || ts.isParameter(d)) && d.initializer
      && (ts.isIdentifier(d.initializer) || ts.isPropertyAccessExpression(d.initializer)))
    return resolveFnRefUnit(d.initializer, depth + 1);
  return null;
}

// Unwrap a `<ref>.bind(…)` partial-application chain to the underlying function-reference RECEIVER.
// `setTimeout(this.flush.bind(this), 0)` / `effFs.bind(null)` / `cb.bind(null,a).bind(null,b)` schedule the
// BOUND function, but the argument node is a CallExpression (callee = PropertyAccessExpression `.bind`), so
// the HOF-ref arm — which only edges identifier / property-access args — dropped it (silent-pure: the
// cardinal sin). `.bind` is the third reflective-invoke member alongside `.call`/`.apply`. Given an arg
// node, returns:
//   { ref }     — it IS a `.bind` chain and the root receiver is a resolvable id/property-access ref
//                 (recursing through chained `.bind().bind()`); the caller resolves it to its fn unit.
//   { ref:null }— it IS a `.bind` chain but the root receiver is NOT a plain ref (`getCallback().bind(null)`,
//                 a parenthesized/`any` holder) — still INVOKED by the HOF, so the caller discloses Unknown.
//   null        — not a `.bind` call at all; the caller's id/property-access path handles it.
// A `.bind` on a PURE fn resolves to a pure unit (no fabrication); the bind-unresolvable case never goes
// silent-pure.
function unwrapBind(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== "bind") return null;
  let recv = node.expression.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  // chained `.bind().bind()` — recurse only when the receiver is ITSELF a `.bind` call, else it's an
  // arbitrary call (`getCallback().bind`) whose result we can't pin → unresolvable bind.
  if (ts.isCallExpression(recv)) {
    const inner = unwrapBind(recv, depth + 1);
    return inner ?? { ref: null };
  }
  return { ref: (ts.isIdentifier(recv) || ts.isPropertyAccessExpression(recv)) ? recv : null };
}

// Accessor resolution (the silent-pure-accessor fix): a property READ (`x.raw`) or property
// ASSIGNMENT target (`x.path = v`) may resolve to a getter/setter whose body performs effects. We
// resolve the property-name symbol to its declarations and look for an accessor of the matching
// kind (get for a read, set for an assignment LHS). Returns { decl, local } where `local` is true
// when the accessor's declaration lives in a project file (a UNIT we minted; edge to it). A resolved
// accessor we CAN'T see (external/typed-only declaration) returns local:false so the caller follows
// the existing Unknown/curated-κ posture — never silent-pure for a resolved-but-unseen accessor.
// A property SYMBOL → its accessor declaration of the wanted kind (or null). `local` is true when that
// declaration lives in a project file (a unit we minted; edge to it). Shared by every property-read
// shape: dot access, element access, and object destructuring.
function accessorFromSym(sym, kind /* "get" | "set" */) {
  if (!sym) return null;
  const want = kind === "get" ? ts.isGetAccessorDeclaration : ts.isSetAccessorDeclaration;
  // A symbol is an accessor only if its declarations include an accessor of the wanted kind.
  const decl = (sym.declarations ?? []).find((d) => want(d));
  if (!decl) return null;
  return { decl, local: projectFiles.has(path.resolve(decl.getSourceFile().fileName)) };
}
function accessorAt(propNode, kind /* "get" | "set" */) {
  let sym;
  if (ts.isElementAccessExpression(propNode)) {
    // `c["prop"]` carries no `.name`; resolve the LITERAL key as a property on the receiver's type.
    // A dynamic key (`c[k]`) can't be pinned to one property — leave it unresolved (the existing
    // dynamic-access posture stands; resolving it would guess, never fabricate here).
    const arg = propNode.argumentExpression;
    sym = arg && ts.isStringLiteralLike(arg)
      ? checker.getTypeAtLocation(propNode.expression)?.getProperty?.(arg.text)
      : null;
  } else {
    sym = checker.getSymbolAtLocation(propNode.name ?? propNode);
  }
  return accessorFromSym(sym, kind);
}
// A `Object.defineProperty` descriptor accessor for the forcing site `recv.key` (read → get, assign →
// set), consulted ONLY when the type-level `accessorAt` came up empty (the checker types target.key as
// a data prop, so defineProperty accessors are invisible to it). Resolve the receiver expression to its
// binding symbol and the key to a static string; look both up in `definePropAccessors`. Returns the
// descriptor function NODE (a minted unit) when found, or null. NO fabrication: a data (`value:`)
// descriptor was never indexed, an absent target/key returns null.
function definePropForceTarget(propNode, kind /* "get" | "set" */) {
  if (definePropAccessors.size === 0) return null;
  let recvExpr, keyText;
  if (ts.isElementAccessExpression(propNode)) {
    recvExpr = propNode.expression;
    const arg = propNode.argumentExpression;
    keyText = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  } else if (ts.isPropertyAccessExpression(propNode)) {
    recvExpr = propNode.expression;
    keyText = propNode.name?.getText?.();
  } else return null;
  if (keyText == null) return null;
  // Resolve the receiver to the SAME symbol the defineProperty target identifier resolved to. Follow an
  // import alias so a cross-module `import { config }` access joins the defining module's index entry.
  const rsym0 = checker.getSymbolAtLocation(recvExpr);
  if (!rsym0) return null;
  const rsym = rsym0.flags & ts.SymbolFlags.Alias ? (() => { try { return checker.getAliasedSymbol(rsym0); } catch { return rsym0; } })() : rsym0;
  const byKey = definePropAccessors.get(rsym) ?? definePropAccessors.get(rsym0);
  const entry = byKey?.get(keyText);
  return entry?.[kind] ?? null;
}
// Record a resolved accessor HIT (read or write) as an edge from `owner`: into the accessor UNIT when
// it's a local declaration we minted; otherwise Unknown (a resolved-but-unseen accessor body — never
// silent-pure, SPEC §4). `label` tags the §-why disclosure.
function recordAccessorHit(owner, hit, label) {
  const rec = fns.get(owner);
  const t = nodeName.get(hit.decl);
  if (hit.local && t) {
    rec.edges.add(t); // (EDGE) into the accessor unit — effects propagate
  } else {
    rec.direct.add("Unknown");
    rec.why.add(`reflect:accessor:${label}`); // a defineProperty runtime accessor (descriptor get/set unseen) — metaprogramming, canonical `reflect:`
  }
}

// Object PROPERTY-ENUMERATION (`{...obj}`, `const {...rest} = obj`, `Object.assign(t, obj)`): copying an
// object's own enumerable props INVOKES each source getter — the whole-object analog of `obj.prop`,
// invisible to the property-access arm (no PropertyAccess node per key). Edge `owner` to every LOCAL
// getter on the source type. A rest/spread can't name one key, so ALL getters are enumerated (sound
// over-approximation); a plain prop resolves to no accessor and adds nothing (no fabrication).
function enumerateGetters(owner, type) {
  if (!owner || !type || !type.getProperties) return;
  for (const p of type.getProperties()) {
    const hit = accessorFromSym(p, "get");
    if (hit) recordAccessorHit(owner, hit, p.getName());
  }
}

// nearest enclosing analyzed function (closures attribute to it — SEMANTICS §2)
function enclosing(node) {
  for (let p = node; p; p = p.parent) {
    // A call/effect lexically inside a DECORATOR (`@factory(arg)`) runs at class-DEFINITION time, NOT in
    // the decorated declaration's body. The parent chain of a decorator's expression is
    // CallExpression → Decorator → MethodDeclaration/ClassDeclaration/Parameter, so `enclosing` otherwise
    // lands on the decorated unit and FABRICATES the factory's effects onto that method/class/param and
    // every transitive caller (a cardinal sin — @Entity/@Injectable factories that touch I/O would
    // poison every decorated handler). Stop at the Decorator: the factory's own effects live in its own
    // function unit; the application site attributes to nothing (load-time, like a no-arg decorator).
    if (ts.isDecorator(p)) return null;
    const n = nodeName.get(p);
    if (n) return n;
  }
  return null;
}

// True when a receiver expression's chain ROOTS at process.stdout/stderr/stdin — including method chains
// (`process.stdin.on("data",f).on("end",g)`, `process.stdout.write(x).on(...)`). The std streams are typed
// tty.ReadStream/WriteStream which EXTEND net.Socket, so `.on`/`.write`/`.end` resolve to net.Socket members
// and the whole-module Net rule paints them — but console fd 0/1/2 I/O is not Net (§1 has no Console effect).
// `net.Socket.on`/`.write` return the stream (`this`), so a chained call's receiver is still the std stream;
// the exact-string check missed it (the receiver is the inner CallExpression). Walk the chain to its head.
function rootsAtStdStream(expr) {
  let e = expr;
  for (;;) {
    if (!e) return false;
    const t = e.getText().replace(/\s+/g, "");
    if (t === "process.stdout" || t === "process.stderr" || t === "process.stdin") return true;
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)
        || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) { e = e.expression; continue; }
    return false;
  }
}

// ---- the implicit/desugared-call surface (the silent-pure holes the AST walk misses) -------------
// CLASSIFIER §1 says resolve, don't pattern-match — but the walk only sees CallExpression/
// NewExpression (+ accessor access). Effects reached through a DESUGARED call (a `for-of` lowering to
// `it[Symbol.iterator]().next()`, a `using` to `r[Symbol.dispose]()`, a tagged template to `tag(...)`)
// were invisible: reported concrete-PURE (omitted), not even Unknown. We model the desugaring exactly
// as the spec demands — resolve the implicit target via the compiler API and edge to it when LOCAL.
// A resolved-but-unseen target follows the existing external/κ posture (OPAQUE + ledger), and a
// BUILT-IN iterator/disposer (es-lib/@types/node — a plain array's iterator, a stdlib disposable)
// resolves to a non-local declaration and edges nothing, so it correctly stays pure.

// The member symbol for a WELL-KNOWN symbol (`Symbol.iterator`, `Symbol.dispose`, …) on a type. The
// checker mangles these to an escaped name `__@iterator@<globalId>`; match by the `__@<name>@` prefix
// (the trailing id is the unique Symbol's identity, not part of the name). `prefixes` is tried in
// order so a sync site prefers the sync method and an async site its async twin (falling back to sync).
function wellKnownSymbolMember(type, prefixes) {
  if (!type || !type.getProperties) return null;
  for (const p of type.getProperties()) {
    const n = p.getName();
    for (const pre of prefixes) if (n === pre || n.startsWith(pre + "@")) return p;
  }
  return null;
}
function declOfSym(sym) { return sym && (sym.valueDeclaration ?? sym.declarations?.[0]); }
const declIsLocal = (decl) => decl && projectFiles.has(path.resolve(decl.getSourceFile().fileName));

// The LOCAL units an ITERATION over `expr` implicitly calls: the iterable's `[Symbol.iterator]` (or
// `[Symbol.asyncIterator]` for `for await`) method AND the produced iterator's `next()`. The generator
// case rolls `next`'s body into the iterator-method unit (lexical attribution), and the self-iterator
// case (`[Symbol.iterator]() { return this }` + a separate effectful `next()`) needs the `next` edge —
// so we edge to BOTH whenever each is a LOCAL unit. A built-in iterable (plain array/string/Map: the
// es-lib/@types iterator) resolves non-local → no edge → stays pure (the precision invariant).
function iterationTargets(expr, isAsync) {
  const t = checker.getTypeAtLocation(expr);
  const iterPrefixes = isAsync ? ["__@asyncIterator", "__@iterator"] : ["__@iterator"];
  const iterDecl = declOfSym(wellKnownSymbolMember(t, iterPrefixes));
  if (!iterDecl) return [];
  const out = [];
  if (declIsLocal(iterDecl)) out.push(iterDecl);
  // the iterator's next(): the return type of the [Symbol.iterator] method
  try {
    const sig = checker.getSignatureFromDeclaration(iterDecl);
    const ret = sig && checker.getReturnTypeOfSignature(sig);
    const nextDecl = declOfSym(ret && ret.getProperties().find((p) => p.getName() === "next"));
    if (nextDecl && declIsLocal(nextDecl) && !out.includes(nextDecl)) out.push(nextDecl);
  } catch { /* unresolved iterator shape — the iterator-method edge already covers the common case */ }
  return out;
}
// Edge `rec` to each LOCAL desugared target that is a minted unit. Local-only by design: an external
// iterable/disposer is OPAQUE (the curated-κ caveat — same as an unmatched external call), never a
// fabricated edge; the existing call machinery + κ ledger already cover any EXPLICIT calls into it.
function edgeToTargets(rec, decls) {
  for (const d of decls) { const t = nodeName.get(d); if (t) rec.edges.add(t); }
}

// ---- implicit VALUE-COERCION desugaring (the silent-pure holes where the JS coercion protocol calls a
// user method the AST walk never visits) ----------------------------------------------------------
// JS coerces an object to a primitive by INVOKING a method on it: `a + b`/`` `${x}` ``/`String(x)` call
// `toString` (or `[Symbol.toPrimitive]`); `x + 1`/`-x`/`+x`/relational call `valueOf` (or
// `[Symbol.toPrimitive]`); `JSON.stringify(x)` calls `toJSON`. None of these surface as a
// CallExpression on the user method, so an effectful `toString`/`valueOf`/`toJSON`/`[Symbol.toPrimitive]`
// reached this way read SILENT-PURE (the cardinal sin). We model the desugar EXACTLY as the spec demands:
// resolve the operand's type's coercion member via the checker and edge to it ONLY when it is a LOCAL
// unit. A built-in/external member (lib.es `Object.prototype.toString`, a stdlib `toJSON`) resolves
// non-local → no edge → stays pure (the precision invariant); a PURE local member edges to a pure unit
// (contributes nothing). NEVER a fabricated edge: a non-object operand, or a type with no such member,
// resolves to nothing.

// Resolve coercion members of `expr`'s type to their LOCAL decls. `names` is the ordered set of plain
// member names to try; `withPrimitive` also consults the well-known `[Symbol.toPrimitive]` (which JS
// prefers over toString/valueOf when present). A union operand is widened to its constituents so a
// `A | B` value edges to whichever side declares a LOCAL coercion member. Returns LOCAL member decls.
function coercionTargets(expr, names, withPrimitive) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return [];
  // Widen unions/intersections so each branch's coercion member is considered (a `Foo | string` operand
  // can be a Foo at runtime → its local toString runs). A primitive/literal constituent has no LOCAL
  // member and contributes nothing.
  const parts = t.isUnionOrIntersection?.() ? t.types : [t];
  const out = [];
  for (const part of parts) {
    if (!part || !part.getProperty) continue;
    if (withPrimitive) {
      const pd = declOfSym(wellKnownSymbolMember(part, ["__@toPrimitive"]));
      if (pd && declIsLocal(pd) && !out.includes(pd)) out.push(pd);
    }
    for (const n of names) {
      const md = declOfSym(part.getProperty(n));
      // A METHOD (or function-valued property) member — not a getter/data field of an unrelated shape.
      if (md && declIsLocal(md)
          && (ts.isMethodDeclaration(md) || ts.isMethodSignature(md)
              || ts.isPropertyDeclaration(md) || ts.isPropertyAssignment(md)
              || ts.isFunctionDeclaration(md) || ts.isFunctionExpression(md) || ts.isArrowFunction(md))
          && !out.includes(md))
        out.push(md);
    }
  }
  return out;
}
// True when `expr`'s type is an OBJECT type that could carry a coercion method (so `a + b` may trigger
// one). A pure primitive operand (string/number/boolean/bigint/null/undefined) never invokes
// toString/valueOf in `+` (string+string concatenates, number+number adds — no method call), so we skip
// it: edging there would be at best inert and the type-narrowing keeps `coercionTargets` from widening a
// huge `string | Foo` into spurious work. An object/union-containing-object is a candidate.
function mayCoerceObject(expr) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return false;
  const parts = t.isUnionOrIntersection?.() ? t.types : [t];
  const PRIM = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
    | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.VoidLike
    | ts.TypeFlags.ESSymbolLike;
  for (const part of parts) {
    if (!part) continue;
    if (part.flags & PRIM) continue;           // a pure primitive branch never coerces via a method
    if (part.flags & ts.TypeFlags.Object) return true;
    if (part.isUnionOrIntersection?.()) return true; // nested — let coercionTargets sort it out
  }
  return false;
}
// Does iterating `expr` FORCE an OPAQUE (caller-supplied) iterable? Forcing an iterable runs its
// `[Symbol.iterator]`/`next` body, which — when the iterable is a PARAMETER / `any` / a bare type-
// parameter — is caller-chosen code that can perform arbitrary I/O. This is epistemically identical to
// invoking an opaque callback parameter (the `call:param` → Unknown posture, scan.mjs ~1145-1158): a
// silent-pure verdict would be the cardinal sin. Mirror that decision exactly. Returns a `why` string
// (→ record Unknown) or null. By design this fires ONLY for genuinely caller-supplied iterables; a
// CONCRETE built-in (array/string/Map/Set: the value resolves to a concrete type, not a param) stays
// PURE, and a LOCAL iterable/generator (a local call result, a local class instance) is handled by the
// existing local-edge path (iterationTargets / the call machinery) — neither is flagged here.
// Opaque iterable INTERFACE names: a value whose TYPE is literally one of these is caller-supplied
// iterator code (its `next` body is unknowable). A CONCRETE built-in (Array/Set/Map/String) has its own
// symbol (`Array`/…) and runs a built-in iterator (no user code) → NOT opaque; a LOCAL class implementing
// Iterable is handled by the local-edge path. So we key on the type's SYMBOL NAME, NOT on "is a parameter"
// (the earlier param-identity check fabricated Unknown when iterating a concrete-typed array PARAM — the
// conformance `loop_elem` regression: `(items: T[]) => { for (const c of items) … }`).
const OPAQUE_ITERABLE_TYPES = new Set([
  "Iterable", "Iterator", "IterableIterator", "Generator",
  "AsyncIterable", "AsyncIterator", "AsyncIterableIterator", "AsyncGenerator",
]);
function opaqueIterableWhy(expr) {
  const t = checker.getTypeAtLocation(expr);
  if (!t) return null;
  // (a) `any` or a bare TYPE PARAMETER (`<T extends Iterable<…>>(x: T)`): the concrete iterable is
  // indeterminate, so its iterator body is unknowable — never silently pure.
  if (t.flags & ts.TypeFlags.Any) return "callback:opaque-iterable:any";
  if (t.flags & ts.TypeFlags.TypeParameter) return "callback:opaque-iterable:typeparam";
  // (b) the type IS an opaque iterable INTERFACE *and* the value is CALLER-SUPPLIED (a parameter / binding
  // element): `collect(source: Iterable<T>)`, `nexts(it: Iterator<T>)`, `drain(g: Generator<T>)`. The
  // caller chooses the concrete iterator (arbitrary I/O), identical to invoking an opaque callback. BOTH
  // conditions are required: a LOCAL generator/iterable CALL result (`for (const x of gen())`) also has a
  // Generator/IterableIterator type but is NOT a param → excluded, so the local-edge path edges its real
  // effect (no spurious Unknown); a concrete Array/Set/Map/String PARAM has its own symbol (not in the
  // set) → excluded → PURE (built-in iterator, no user code; the conformance `loop_elem` case).
  const sym = t.getSymbol && t.getSymbol();
  if (sym && OPAQUE_ITERABLE_TYPES.has(sym.name) && ts.isIdentifier(expr)) {
    const d = realDecl(checker.getSymbolAtLocation(expr));
    if (d && (ts.isParameter(d) || ts.isBindingElement(d))) {
      const idx = ts.isParameter(d) && d.parent ? d.parent.parameters.indexOf(d) : -1;
      return idx >= 0 ? `callback:opaque-iterable:param#${idx}` : "callback:opaque-iterable:param";
    }
  }
  return null;
}
// Record an opaque-iterable force as Unknown on the enclosing fn, UNLESS iteration already resolved a
// LOCAL desugar target (then the real effect is edged — no Unknown needed). `localResolved` = the
// non-empty result of iterationTargets (a local `[Symbol.iterator]`/`next` unit was found).
function noteOpaqueIteration(node, iterExpr, localResolved) {
  if (localResolved) return;
  const owner = enclosing(node);
  if (!owner) return;
  const why = opaqueIterableWhy(iterExpr);
  if (!why) return;
  const rec = fns.get(owner);
  if (!rec) return;
  rec.direct.add("Unknown");
  rec.why.add(why);
}

// Callee names that INVOKE a function/method argument (so a fn-reference passed to one is reachable
// through it). Array/iterable HOFs, the timer/microtask schedulers, and Promise continuations. A
// STORE/compare/log sink (`set`/`push`/`add`/`includes`/`indexOf`/`concat`/`log`/`stringify`/…) is
// deliberately ABSENT — edging there would fabricate the fn's effects on a pure path (the cardinal sin).
const HOF_INVOKERS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "flatMap", "sort", "group", "groupBy", "partition", "mapValues", "flatMapDeep",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame", "requestIdleCallback",
  "then", "catch", "finally", "nextTick",
]);

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
          else if (cd && ts.isClassDeclaration(cd) && !projectFiles.has(path.resolve(cd.getSourceFile().fileName))) {
            externalClass = true;
            // …but the construction DOES reach the class's package — disclose it as `invisible` (sweep
            // [13]) so the pure verdict is qualified, exactly like an unmodeled METHOD call below. Without
            // this, `new Pool()` from an unmodeled pkg read plain pure with no disclosure, no κ-ledger.
            const cfile = cd.getSourceFile().fileName;
            const cmod = declModule(cd);
            const cpkg = cmod.startsWith("@types/") ? cmod.slice("@types/".length) : cmod;
            const cdeclared = packageManifestEffects(cfile);
            if (cdeclared !== null) { for (const e of cdeclared) rec.direct.add(e); }
            else if (!cmod.startsWith("<") && !kappaKnows(cpkg) && !depCoveredPkgs.has(cpkg)
                && /node_modules\//.test(cfile) && !/node_modules\/(@types\/node|typescript)\//.test(cfile)) {
              unlistedSeen.set(cpkg, (unlistedSeen.get(cpkg) ?? 0) + 1);
              rec.blind.add(cpkg);
            }
          }
        }
        if (!edged && !externalClass) {
          // Blind PACKAGE member call: the receiver is a NAMESPACE import from a bare specifier
          // (`import * as winstonm from "winston"; winstonm.info()`) that didn't resolve — typically the
          // package isn't installed in this tree. The κ table may still MODEL it, so classify by the import
          // SPECIFIER (the syntactic path, mirroring how the Rust scanner classifies a crate path without
          // building). Only fires for κ-modeled packages (winston/pino/pg/…); everything else still → Unknown.
          let kEff = null;
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
              && ts.isIdentifier(node.expression.expression)) {
            const sym = checker.getSymbolAtLocation(node.expression.expression);
            for (const d of sym?.declarations ?? []) {
              if (ts.isNamespaceImport(d)) {
                const spec = d.parent?.parent?.moduleSpecifier;
                if (spec && ts.isStringLiteralLike(spec)) kEff = kappa(spec.text, node.expression.name.text);
                break;
              }
            }
          }
          if (kEff) {
            rec.direct.add(kEff); // κ-modeled package reached via an uninstalled namespace import
          } else {
            rec.direct.add("Unknown"); // unresolvable call → Unknown, never silent-pure (SPEC §4)
            const callee = (node.expression?.getText?.() ?? "?").replace(/\s+/g, "").slice(0, 60);
            rec.why.add(`callback:${callee}`); // an `any`-typed/indeterminate callee (a function VALUE) — canonical `callback:`
          }
        }
      } else {
        const mod = declModule(decl);
        // A LOCAL function/method passed BY REFERENCE to a NON-LOCAL (opaque) callee — `xs.map(loadFree)`,
        // `arr.forEach(this.m)`, `setTimeout(handler)`, `external(cb)` — may be INVOKED by that callee, so
        // its effects are reachable here. The precise callback-flow below only resolves a LOCAL callee's
        // params; a non-local HOF dropped the reference entirely (a silent-pure hole — confirmed for
        // `map`/`forEach`/`reduce`). Edge to the referenced unit: the sound over-approximation, matching
        // the Rust engine's fn-as-value edge. An inline closure is already charged lexically; a non-fn
        // argument resolves to no minted unit (`nodeName` miss) and adds nothing — no fabrication. Gated
        // on a non-local callee so a local callee that merely STORES (never invokes) keeps its precision.
        // ONLY a callee that actually INVOKES its fn argument makes the reference reachable here. The
        // earlier version edged for ANY non-local callee — fabricating the fn's effects onto a pure path
        // (the cardinal sin) for STORE/compare/log sinks that never call it (`map.set(k, fn)`,
        // `arr.push(fn)`, `arr.includes(fn)`, `console.log(fn)`, `[fn]`). Gate on a known INVOKING HOF by
        // callee name; a custom non-local HOF that invokes its arg is an honest under-report (sound),
        // never a fabrication. (A LOCAL callee keeps its precise callback-flow below.)
        const calleeName = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : null;
        if (mod !== "<local>" && calleeName && HOF_INVOKERS.has(calleeName)) {
          for (const a of node.arguments ?? []) {
            // A `<ref>.bind(…)` partial-application is a CallExpression (skipped by the id/property-access
            // gate below) but the INVOKING HOF calls the bound fn → its effects are reachable. Unwrap the
            // `.bind` chain to the root receiver and resolve it like a bare ref (`resolveFnRefUnit` follows
            // local aliases too). A `.bind` whose receiver can't be pinned to a fn unit (`getCallback().bind`,
            // a param/`any` holder) still INVOKES whatever it wraps — disclose Unknown, never silent-pure.
            const bound = unwrapBind(a);
            if (bound) {
              const bref = bound.ref;
              const d3 = bref && realDecl(checker.getSymbolAtLocation(bref));
              const tb = (d3 && nodeName.get(d3)) || (bref && resolveFnRefUnit(bref));
              if (tb) rec.edges.add(tb);
              else {
                rec.direct.add("Unknown");
                rec.why.add(`callback:bind:${(bref ?? a).getText().replace(/\s+/g, "").slice(0, 40)}`); // `.bind(...)` yields a function VALUE — canonical `callback:`
              }
              continue;
            }
            if (!ts.isIdentifier(a) && !ts.isPropertyAccessExpression(a)) continue;
            const d2 = realDecl(checker.getSymbolAtLocation(a));
            const t = d2 && nodeName.get(d2);
            if (t) rec.edges.add(t);
          }
        }
        // `fn.call(thisArg, …)` / `fn.apply(thisArg, args)` INVOKE the receiver function reference, and
        // `Reflect.apply(fn, …)` / `Reflect.construct(Ctor, …)` invoke their FIRST ARGUMENT. The resolved
        // signature lands on the es-lib `CallableFunction.call/apply` / `Reflect.apply` member, so the
        // function actually invoked (the receiver, or arg0) was never followed → the caller read
        // silent-pure (HIGH: a common reflective-invoke shape). Edge to the referenced unit, mirroring the
        // HOF-ref arm: a pure ref edges to a pure unit (no fabrication); a non-fn receiver/arg resolves to
        // no minted unit (`nodeName` miss) and adds nothing; an unresolvable ref stays opaque/Unknown.
        if (ts.isPropertyAccessExpression(node.expression)) {
          const m = node.expression.name.text;
          const recv = node.expression.expression;
          const recvText = recv.getText().replace(/\s+/g, "");
          let invokedRef = null;
          if ((m === "call" || m === "apply") && recvText !== "Reflect") invokedRef = recv;
          else if (recvText === "Reflect" && (m === "apply" || m === "construct"))
            invokedRef = (node.arguments ?? [])[0] ?? null;
          if (invokedRef && (ts.isIdentifier(invokedRef) || ts.isPropertyAccessExpression(invokedRef))) {
            const d2 = realDecl(checker.getSymbolAtLocation(invokedRef));
            // Resolve the receiver/arg0 to its function unit, FOLLOWING local-variable aliases
            // (`const m = effectful; m.call(…)`) — the direct-identifier form already landed on a minted
            // unit, but an aliased local var resolves to its VARIABLE decl (not a unit), which dropped the
            // edge silent-pure. `resolveFnRefUnit` chases the initializer alias to the real fn.
            const t = (d2 && nodeName.get(d2)) || resolveFnRefUnit(invokedRef);
            if (t) rec.edges.add(t);
            // HONESTY: the receiver IS a local variable/parameter (it resolved to a value declaration)
            // but we could NOT pin it to a function unit — e.g. bound to a param, a reassigned/branched
            // value, an `any`-typed holder. The `.call`/`.apply` still INVOKES whatever it holds, so a
            // silent-pure verdict would be the cardinal sin. Disclose Unknown instead. (A direct fn
            // identifier / known fn always resolves above, so this never fires for the precise forms; a
            // non-value receiver — a type, a literal — resolves to no decl and stays out, no fabrication.)
            else if (d2 && (ts.isVariableDeclaration(d2) || ts.isBindingElement(d2) || ts.isParameter(d2))) {
              rec.direct.add("Unknown");
              rec.why.add(`callback:${recvText.slice(0, 40)}.${m}`); // method on an indeterminate-valued receiver (no resolvable owner TYPE) — canonical `callback:`, not the frontier's `dispatch:OWNER.member`
            }
          }
          // EXPLICIT iterator force: `it.next()` / `it.return()` / `it.throw()` on an OPAQUE iterator
          // (a parameter / `any` / type-parameter typed as the `Iterator`/`Generator` protocol) runs
          // caller-supplied iterator code — epistemically identical to forcing a for-of over an opaque
          // iterable, and to invoking an opaque callback. The method resolves to the non-local es-lib
          // `Iterator.next` signature, so the desugar above never sees it and the call lands here pure.
          // Disclose Unknown (cardinal-sin guard). Gated on the iterator-protocol type symbol so an
          // unrelated `.next()` on some other opaque param is not flagged; a LOCAL iterator's `next`
          // resolves `<local>` (edged below), never reaching this non-local arm.
          if ((m === "next" || m === "return" || m === "throw")) {
            const why = opaqueIterableWhy(recv);
            const rt = checker.getTypeAtLocation(recv);
            const sn = rt?.getSymbol?.()?.getName?.()
              ?? (rt?.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(rt)?.getSymbol?.()?.getName?.() : undefined);
            const ITER_PROTO = new Set([
              "Iterator", "AsyncIterator", "Iterable", "AsyncIterable",
              "IterableIterator", "AsyncIterableIterator", "Generator", "AsyncGenerator",
            ]);
            if (why && sn && ITER_PROTO.has(sn)) {
              rec.direct.add("Unknown");
              rec.why.add(why); // `callback:opaque-iterable:param#i` / `:any` / `:typeparam` (opaque iteration ≈ opaque callback)
            }
          }
        }
        if (mod === "<local>") {
          const targetName = nodeName.get(decl);
          if (targetName) {
            rec.edges.add(targetName); // (EDGE) — cross-FILE edges resolve the same way
            // Class-CHA fan-out: resolution landed on a base-class member that LOCAL subclasses
            // override. A base-typed receiver (`a: Animal`, or a branch-merged `Animal|Dog`) could be
            // any subclass at runtime, so the override bodies' effects must propagate — else the caller
            // reads concrete-PURE while a `Dog.speak` does I/O (the silent-pure base-dispatch hole). We
            // edge to the overrides too, bounded by the same ≤12 family limit the interface path uses,
            // with the same honesty gate: if any override isn't a resolvable unit (not minted), or the
            // family is too large, fall to Unknown rather than silently dropping it. A monomorphic
            // receiver already resolved to the leaf (`new Dog()` -> Dog.speak, no overrides) so this is
            // inert there — no double-count. A base method NO subclass overrides has no entry: today's
            // behavior (just the base) is preserved exactly.
            const allOverrides = classOverrides.get(decl);
            if (allOverrides && allOverrides.length > 0) {
              // PRECISION: scope the fan-out to the RECEIVER's static-type subtree. A base-member
              // dispatch on a receiver statically typed as subclass `Cat` can only ever bind to a
              // `Cat`-subtree body — a SIBLING `Dog.speak` override is type-impossible on this path,
              // so propagating its effect over-reports on an unreachable receiver (fabrication-
              // adjacent). When we can pin the receiver's static class (a property/element access
              // whose receiver-expression type is a LOCAL class), keep only overrides whose owning
              // class lies in that class's subtree; `viaBase(a: Animal)` keeps Dog (Dog ∈ Animal-
              // subtree, the soundness edge), `noOverride(c: Cat)` drops Dog (Dog ∉ Cat-subtree) and
              // stays pure. SOUNDNESS-PRESERVING FALLBACK: if the receiver's static class can't be
              // pinned to a LOCAL class (no property access, a union/interface/`any` receiver, an
              // external/unresolved type), we do NOT narrow — the full override set is kept, exactly
              // the pre-precision behavior, so we never silently drop an effect we can't rule out.
              let overrides = allOverrides;
              const recvExpr = (ts.isPropertyAccessExpression(node.expression)
                || ts.isElementAccessExpression(node.expression)) ? node.expression.expression : null;
              if (recvExpr) {
                const rt = checker.getTypeAtLocation(recvExpr);
                const rootClass = (rt?.symbol?.declarations ?? []).find((d) =>
                  ts.isClassDeclaration(d) && projectFiles.has(path.resolve(d.getSourceFile().fileName)));
                if (rootClass) overrides = allOverrides.filter((om) =>
                  ts.isClassDeclaration(om.parent) && classInSubtree(om.parent, rootClass));
              }
              if (overrides.length > 0) {
                if (overrides.length <= 12) {
                  let allResolved = true;
                  const oTargets = [];
                  for (const om of overrides) {
                    const ot = nodeName.get(om);
                    if (ot) oTargets.push(ot);
                    else allResolved = false;
                  }
                  for (const ot of oTargets) rec.edges.add(ot);
                  if (!allResolved) {
                    rec.direct.add("Unknown");
                    rec.why.add(`dispatch:${decl.parent?.name ? `${moduleOf(decl.parent.getSourceFile())}.${decl.parent.name.getText()}` : "type"}.${decl.name?.getText?.() ?? "member"}`); // class-override dispatch — canonical `dispatch:QUALIFIED-OWNER.member`, frontier-relevant
                  }
                } else {
                  rec.direct.add("Unknown"); // override family too wide to enumerate soundly
                  rec.why.add(`dispatch:${decl.parent?.name?.getText?.() ?? "type"}.${decl.name?.getText?.() ?? "member"}`); // class-override dispatch (overridable member, unresolved/too-wide family) — canonical `dispatch:OWNER.member`, frontier-relevant
                }
              }
            }
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
                // QUALIFIED owner (module.Type), matching the `mod.Class.member` fn quals so the
                // dispatch-frontier (callers --include-unknown) can resolve overrides against the
                // hierarchy sidecar. Bare `decl.parent.name` would not match a reacher's declaringType.
                const tn = decl.parent?.name
                  ? `${moduleOf(decl.parent.getSourceFile())}.${namespacePrefixOf(decl.parent)}${decl.parent.name.getText()}`
                  : "type";
                const mn = decl.name?.getText?.() ?? "member";
                rec.why.add(`dispatch:${tn}.${mn}`); // resolution landed on a type, not a body — canonical `dispatch:OWNER.member` (frontier-relevant)
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
          // `eval(code)` executes an arbitrary code string — it can perform ANY effect, so it is genuinely
          // Unknown (the same posture as `new Function(s)`, which already reads Unknown via the no-decl
          // path). The es-lib declares `eval` as a top-level ambient function (parent is the global/source
          // file, no type name), and `globalThis.eval`/`window.eval`/`self.eval` all resolve to the same
          // `eval` declaration — so keying on the resolved name catches every access form. Without this it
          // resolved to a benign es-lib member and read SILENT-PURE (a code-execution sink reported pure).
          if (name === "eval" && parent !== "Math" && parent !== "JSON") {
            rec.direct.add("Unknown");
            rec.why.add("reflect:eval"); // eval executes a runtime-supplied string — canonical `reflect:`
          }
          if ((parent === "DateConstructor" && name === "now") || (parent === "Performance" && name === "now"))
            rec.direct.add("Clock");
          if (parent === "Math" && name === "random") rec.direct.add("Rand");
          if (ts.isNewExpression(node) && (node.arguments ?? []).length === 0
              && checker.getTypeAtLocation(node.expression)?.symbol?.name === "DateConstructor")
            rec.direct.add("Clock");
          // Browser/runtime NETWORK globals declared in lib.dom — no importable module for the κ table to
          // key on, so they read SILENT-PURE. `XMLHttpRequest.send`/`.open` issue the HTTP request; the
          // `EventSource`/`WebSocket` constructors open a connection on construction. Net. (Found by a
          // Net-deep sweep. The npm `ws` package is already κ-covered; this is the bare browser global.)
          if (parent === "XMLHttpRequest" && (name === "send" || name === "open")) rec.direct.add("Net");
          // `new EventSource(url)` / `new WebSocket(url)`: the constructor is declared on an anonymous
          // `declare var` object type (symbol `__type`, no usable parent name), but reaching the es-lib
          // branch already proves the ctor resolved to lib.dom (not a project class shadowing the name),
          // so the constructed identifier is the real browser global.
          if (ts.isNewExpression(node)) {
            const ctorName = node.expression.getText();
            if (ctorName === "EventSource" || ctorName === "WebSocket") rec.direct.add("Net");
          }
        } else {
          // The member token κ matches: the resolved declaration's name, EXCEPT a `new X()` call,
          // whose declaration is a Constructor (empty name) — synthesize "new" so a rule can exempt
          // inert construction from its module-wide effect (the net cluster: `new http.Agent()` etc.).
          // BUT a CONNECTING constructor is NOT inert: `new http.ClientRequest(url)` performs the
          // network I/O on construction (it is what `http.request()` returns and dispatches), so the
          // blanket `new`-exemption would convert a real Net source into pure (a cardinal-sin under-
          // report). For such a ctor we synthesize the CLASS name instead of "new", so the net-cluster
          // rule's `/^(?!new$)/` matcher keeps the effect. The set is the net cluster's documented
          // public connecting ctors; http2 connects via `connect()` (a function, not a ctor) so it
          // needs no entry here. Inert ctors (Agent/Server/Socket/TLSSocket/Http2Server*/message shells)
          // still synthesize "new" and stay pure.
          const CONNECTING_CTORS = new Set(["ClientRequest"]);
          // Host-ESTABLISHING Net call names (the masking-fix allowlist): a Net call by one of these whose
          // host is not a captured literal leaves the host invisible. Excludes use-verbs (write/end/send on
          // a connected socket). `post/put/patch/delete/head/options` cover the axios/got/undici tier whose
          // URL is the call arg (sweep [18]); `dgram.send(buf,port,host)` is added module-aware below (UDP
          // has no connect, so send carries the destination — sweep [12]).
          const NET_ESTABLISHING = new Set(["request", "get", "post", "put", "patch", "delete", "head",
            "options", "connect", "createConnection", "fetch"]);
          // Fs/Exec USE-verbs whose LOCATOR was fixed earlier, not an arg of THIS call — so a missing literal
          // here is the legitimate split-construct/use shape, never the masking signal (the establishing-
          // allowlist discipline, generalized from Net to all 4 effects; sweep [11]). Fs: the fd/FileHandle
          // ops (fd came from open()); the path-taking fs.* fns are establishing. Exec: ChildProcess methods
          // (the command was fixed at spawn); the spawn fns are establishing.
          const FS_USE_VERBS = new Set(["write", "writeSync", "read", "readSync", "close", "closeSync",
            "fsync", "fsyncSync", "fdatasync", "fdatasyncSync", "ftruncate", "ftruncateSync", "fchmod",
            "fchmodSync", "fchown", "fchownSync", "futimes", "futimesSync", "fstat", "fstatSync"]);
          const EXEC_USE_VERBS = new Set(["kill", "send", "disconnect", "ref", "unref"]);
          const netEstablishing = (member) =>
            CONNECTING_CTORS.has(ctorClassName) || NET_ESTABLISHING.has(member)
            || (/^(node:)?dgram$/.test(mod) && member === "send");
          const ctorClassName = ts.isNewExpression(node)
            ? (ts.isConstructorDeclaration(decl) ? decl.parent?.name?.getText?.()
               : (decl.name ? decl.name.getText() : ""))
            : "";
          const isConstruction = ts.isConstructorDeclaration(decl) || ts.isNewExpression(node);
          // The κ member token. A named decl (function/method declaration) carries its own name; but a
          // VALUE-BINDING export — `export const v4 = (...) => ...` (the shape REAL uuid v9+/nanoid ship,
          // and the `type v4 = v4Buffer & v4String` callable type-alias of @types/uuid v8) resolves to an
          // ANONYMOUS arrow/function-type whose `decl.name` is empty, so κ saw `""` and the package's
          // entropy/net verb read silent-pure (verified against installed uuid/nanoid). Fall back to the
          // BINDING name: an arrow/fn-expr's parent VariableDeclaration / PropertyAssignment / property,
          // or a callable type-alias's TypeAliasDeclaration. Precision no-op where the old path already
          // had a name (this only fills a former `""`); never synthesizes a name for `new`.
          const bindingName = (d) => {
            const p = d.parent;
            if (!p) return "";
            if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)
                 || ts.isPropertySignature(p) || ts.isBindingElement(p) || ts.isTypeAliasDeclaration(p))
                && p.name && ts.isIdentifier(p.name)) return p.name.getText();
            return "";
          };
          const member = isConstruction
            ? (CONNECTING_CTORS.has(ctorClassName) ? ctorClassName : "new")
            : (decl.name ? decl.name.getText() : bindingName(decl));
          let eff = kappa(mod, member); // (CLASSIFY)
          // process.stdout/stderr/stdin are typed `tty.WriteStream`, which EXTENDS `net.Socket`, so a
          // `.write()`/`.end()` on them resolves to `net.Socket.write` and the whole-module Net rule
          // paints it Net. But a console write to fd 0/1/2 is TTY/console I/O, NOT network — there is no
          // "Console" effect in §1, so it must be PURE. Suppress the fabricated effect for these receivers
          // (a real `net.Socket` you constructed and `.write()` to still classifies Net — only the three
          // std streams are freed). Real-world sweep: nanoid/commander(×43)/bunyan/pino fabricated Net
          // purely from a `process.stdout.write` — the cardinal sin.
          if (eff && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
              && rootsAtStdStream(node.expression.expression))
            eff = null;
          if (eff) {
            rec.direct.add(eff);
            // a κ rule that resolves to the Unknown trust-marker (node:vm code execution) is a direct
            // Unknown SOURCE — SPEC §4 requires a why on it, like eval's `reflect:eval`. (The rest of
            // the κ table is concrete effects, which carry no why.)
            if (eff === "Unknown") rec.why.add(`reflect:${mod.replace(/^node:/, "")}.${member}`);
          }
          // the literal surfaces, read only at a CLASSIFIED call (SPEC §2)
          if (eff === "Net") {
            const lit = firstStringLiteral(node);
            const h = lit && hostLiteral(lit);
            if (h) rec.hosts.add(h);
            // MASKING fix: a host-ESTABLISHING Net call whose host is NOT a captured literal (runtime URL, or
            // built elsewhere) leaves the host invisible to the gate → mark the surface incomplete so a
            // benign literal can't mask it. ALLOWLIST of establishing forms only — NEVER use-calls
            // (write/end/non-dgram send), which would false-positive on `socket.connect("h").write(data)`
            // (the host is captured at connect). Under-catches an unlisted establishing verb (safe
            // direction); never over-flags a use-call.
            else if (netEstablishing(member))
              rec.incomplete.add("Net");
          }
          if (eff === "Db") {
            const lit = firstStringLiteral(node);
            const before = rec.tables.size;
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
            // masking: a Db call that surfaced NO table (no SQL literal, no entity-typed receiver) reaches a
            // runtime/invisible table — a benign sibling query's literal table must not mask it. The entity
            // route above is NOT a literal so it still counts as visible (a captured table); only a fully
            // invisible query marks incomplete. `new` (a connection ctor) carries no table — skip it.
            if (rec.tables.size === before && member !== "new") rec.incomplete.add("Db");
          }
          if (eff === "Exec") {
            const lit = firstStringLiteral(node);
            if (lit) rec.cmds.add(lit.trim().split(/\s+/)[0]); // cosmetic cmds surface (any literal)
            // a known literal head refines the cliff (curl→Net, candor→Fs/Env); Exec stays. The head
            // MUST be argv[0] (programHeadLiteral), NOT any literal arg: `spawn(toolVar, "curl")`
            // names no static program, so its trailing literal must not fabricate Net (spec §4).
            const head = programHeadLiteral(node);
            if (head) for (const e of commandHeadEffects(head)) rec.direct.add(e);
            // masking (sweep [11]): an Exec call whose program head is NOT a static literal (runtime
            // command) leaves the command invisible. Establishing = the spawn fns; ChildProcess use-verbs
            // (kill/send/disconnect/ref/unref) carry no command and are excluded.
            else if (!EXEC_USE_VERBS.has(member)) rec.incomplete.add("Exec");
          }
          if (eff === "Fs") {
            const lit = firstStringLiteral(node);
            const pathCaptured = lit && /[/\\]|^[.~]/.test(lit); // path-shaped literals only
            if (pathCaptured) rec.paths.add(lit);
            // masking (sweep [11]): a path-taking fs.* call whose path is NOT a captured literal (runtime
            // path) leaves it invisible. fd/FileHandle USE-verbs (fd came from a prior open()) are excluded.
            else if (!FS_USE_VERBS.has(member)) rec.incomplete.add("Fs");
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
            // SPEC §5.1: a package that DECLARES its effects (candorEffects in package.json) is read
            // at the declared-not-verified tier — its effects are attributed and it is NOT a blind
            // spot. Otherwise the κ ledger names it (an uncurated dependency the review must read).
            const declared = packageManifestEffects(file);
            if (declared !== null) {
              for (const e of declared) rec.direct.add(e); // [] = declared pure: covered, adds nothing
            } else if (!kappaKnows(pkg) && !depCoveredPkgs.has(pkg)
                && /node_modules\//.test(file) && !/node_modules\/(@types\/node|typescript)\//.test(file)) {
              unlistedSeen.set(pkg, (unlistedSeen.get(pkg) ?? 0) + 1);
              // Per-fn HONESTY: this fn calls into a genuinely-blind package (κ-unknown, not dep-covered).
              // Recorded per fn, propagated transitively, emitted as `invisible` — so `inferred` is never an
              // unqualified completeness claim. This branch already IS the global-blind condition, so no
              // post-filter is needed (κ either knows a package or it doesn't).
              rec.blind.add(pkg);
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
  // Runtime GLOBALS reached as CALLS with no import for the κ resolver to classify: `process.hrtime()`/
  // `.hrtime.bigint()` is a monotonic clock read (Clock); `process.send(...)` is the child↔parent IPC
  // channel (Ipc); the global `fetch(...)` is the standard modern HTTP client (Net). Matched on the
  // callee — `process.*` by exact text (mirroring the process.env match), `fetch` by identifier whose
  // symbol is NOT a local declaration (so a project's own `fetch` shadow never fabricates Net).
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const ctext = callee.getText().replace(/\s+/g, "");
    let geff = null;
    // `process.*` is matched by exact text, so a project's OWN `const process = {…}` shadow would
    // fabricate Clock/Ipc on a pure local method (sweep [31]) — guard it like the `fetch` arm: resolve the
    // ROOT `process` identifier and fire only when it is NOT a project-local declaration (i.e. the global).
    const processIsGlobal = () => {
      if (!ts.isPropertyAccessExpression(callee)) return false;
      let root = callee.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression; // process.hrtime.bigint → process
      if (!ts.isIdentifier(root) || root.text !== "process") return false;
      return !(checker.getSymbolAtLocation(root)?.declarations ?? [])
        .some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName)));
    };
    if ((ctext === "process.hrtime" || ctext === "process.hrtime.bigint") && processIsGlobal()) geff = "Clock";
    else if (ctext === "process.send" && processIsGlobal()) geff = "Ipc";
    else if (ts.isIdentifier(callee) && callee.text === "fetch"
             && !(checker.getSymbolAtLocation(callee)?.declarations ?? [])
                  .some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName))))
      geff = "Net";
    // the fully-qualified global fetch — `globalThis.fetch`/`window.fetch`/`self.fetch` — is a
    // PropertyAccess callee the bare-identifier guard above misses, so it read silent-pure. Mirror the
    // `eval` global-qualifier handling (a runtime global a project would not shadow).
    else if (ctext === "globalThis.fetch" || ctext === "window.fetch" || ctext === "self.fetch")
      geff = "Net";
    if (geff) {
      const owner = enclosing(node);
      if (owner) fns.get(owner).direct.add(geff);
    }
    // dynamic `require(<non-literal>)` — the CJS twin of `import(m)` (which already discloses Unknown):
    // it loads an arbitrary module and runs its top-level code, so the effects are opaque → Unknown. A
    // LITERAL `require('fs')` is a static, resolvable load (pure until a member call), so ONLY a
    // non-literal arg is the escape. Gated like `fetch`: a bare `require` whose symbol is NOT a project
    // declaration (a project's own `function require()` shadow never fabricates). Under-disclose Unknown,
    // never a concrete effect. (Found by real-world corpus testing; sibling of the node:vm fix.)
    if (ts.isIdentifier(callee) && callee.text === "require"
        && node.arguments?.length === 1 && !ts.isStringLiteralLike(node.arguments[0])
        && !(checker.getSymbolAtLocation(callee)?.declarations ?? [])
             .some((d) => projectFiles.has(path.resolve(d.getSourceFile().fileName)))) {
      const owner = enclosing(node);
      if (owner) { fns.get(owner).direct.add("Unknown"); fns.get(owner).why.add("reflect:require"); }
    }
    // Object.assign(target, ...sources) copies each SOURCE's own enumerable props → invokes their
    // getters (the object-spread twin). Enumerate the sources' local getters.
    if (callee.getText().replace(/\s+/g, "") === "Object.assign") {
      const owner = enclosing(node);
      for (const src of (node.arguments ?? []).slice(1)) {
        enumerateGetters(owner, checker.getTypeAtLocation(src));
      }
    }
  }
  // GET/SET ACCESSOR access (the silent-pure-accessor fix): a property read that resolves to a
  // getter, or a property assignment whose target resolves to a setter, is effectively a call into
  // the accessor body — model it as a call EDGE so the accessor's effects propagate (like a method
  // call), never silently pure. A resolved-but-UNSEEN accessor (external declaration) reads Unknown,
  // following the same posture as an unresolvable call (SPEC §4).
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    // Is this property access an assignment TARGET? A simple `x.prop = v` invokes the SETTER only. A
    // COMPOUND/LOGICAL assignment (`+=`,`-=`,`??=`,`||=`,`&&=`,…) reads the current value AND writes — both
    // the getter and the setter run (sweep [10]; pre-fix only a bare `=` was a setter site, so an effectful
    // setter under `+=`/`??=` read PURE). A DESTRUCTURING-assignment target (`({k: x.prop} = src)` /
    // `[x.prop] = arr`) is also a setter site, invisible to the simple-LHS test (sweep [32]).
    const p = node.parent;
    const isBinAssign = p && ts.isBinaryExpression(p) && p.left === node;
    const simpleAssign = isBinAssign && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const compoundAssign = isBinAssign && !simpleAssign
      && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const recordKind = (kind) => {
      const hit = accessorAt(node, kind);
      if (hit) {
        const owner = enclosing(node);
        if (!owner) return;
        const an = hit.decl.parent?.name?.getText?.() ?? "?";
        const pn = node.name?.getText?.() ?? node.argumentExpression?.getText?.() ?? "?";
        recordAccessorHit(owner, hit, `${an}.${pn}`);
        return;
      }
      // No type-level accessor — try the `Object.defineProperty` runtime-accessor index. The checker
      // types target.key as a data prop, so an effectful defineProperty getter/setter is invisible to
      // accessorAt; consult definePropForceTarget so the forcing site edges to the descriptor unit
      // (precise) instead of reading silent-pure (the cardinal sin). A descriptor we minted is always
      // local, so this is an EDGE; never Unknown for a resolved-and-seen descriptor.
      const dpNode = definePropForceTarget(node, kind);
      if (dpNode) {
        const owner = enclosing(node);
        const t = owner && nodeName.get(dpNode);
        if (t) fns.get(owner).edges.add(t);
        return;
      }
      // A computed-key descriptor accessor on this receiver's target means `recv.<anything>` MIGHT
      // invoke an effectful accessor whose key we couldn't pin — disclose Unknown (never silent-pure),
      // matching the syntactic object-literal-getter posture. Only when the receiver binds to a target
      // that carries a dynamic-key descriptor of the right kind.
      if (definePropDynamicKey.size > 0) {
        const rsym0 = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          ? checker.getSymbolAtLocation(node.expression) : null;
        const rsym = rsym0 && (rsym0.flags & ts.SymbolFlags.Alias)
          ? (() => { try { return checker.getAliasedSymbol(rsym0); } catch { return rsym0; } })() : rsym0;
        const kinds = (rsym && definePropDynamicKey.get(rsym)) || (rsym0 && definePropDynamicKey.get(rsym0));
        if (kinds && kinds.has(kind)) {
          const owner = enclosing(node);
          if (owner) { fns.get(owner).direct.add("Unknown"); fns.get(owner).why.add(`reflect:defineProperty:dynamic-key`); } // dynamic-key descriptor install — metaprogramming, canonical `reflect:`
        }
      }
    };
    if (simpleAssign || isDestructuringAssignTarget(node)) recordKind("set");
    else if (compoundAssign) { recordKind("get"); recordKind("set"); }
    else recordKind("get");
  }
  // OBJECT-DESTRUCTURING getter read (`const { prop } = obj`): each bound property is a READ that may
  // resolve to a getter whose body does I/O — the binding-pattern analog of `obj.prop`, invisible to
  // the property-access arm above because there is no PropertyAccess/ElementAccess node. (ARRAY
  // destructuring is ITERATION, handled below; object destructuring copies named own/inherited props,
  // invoking each getter.) Resolve every bound key as a property on the initializer's type; a rest
  // element / computed key can't be pinned to one accessor, so it's skipped (no fabrication).
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    const owner = enclosing(node);
    if (owner) {
      const recvType = checker.getTypeAtLocation(node.initializer);
      for (const el of node.name.elements) {
        if (el.dotDotDotToken) { enumerateGetters(owner, recvType); continue; } // `...rest` copies every
        // remaining prop → invokes every (remaining) getter; enumerate all (the bound ones double-handle).
        const key = el.propertyName ?? el.name; // `{prop}` shorthand, or `{prop: alias}`
        const keyName = ts.isIdentifier(key) ? key.text
          : ts.isStringLiteralLike(key) ? key.text : null;
        if (keyName === null) continue; // computed key (`{[k]: v}`) — unresolvable to one property
        const hit = accessorFromSym(recvType?.getProperty?.(keyName), "get");
        if (hit) recordAccessorHit(owner, hit, keyName);
      }
    }
  }
  // ITERATION desugaring (HIGH): `for (const x of bag)`, `for await (…)`, `[...bag]`, `const [a]=bag`,
  // `Array.from(bag)` all lower to `bag[Symbol.iterator]().next()`. Edge the enclosing fn to the
  // iterable's local `[Symbol.iterator]`/`[Symbol.asyncIterator]` method (and the produced iterator's
  // local `next`). A built-in iterable (array/string/Map) resolves non-local → no edge → stays pure.
  {
    let iterExpr = null, iterAsync = false;
    if (ts.isForOfStatement(node)) { iterExpr = node.expression; iterAsync = !!node.awaitModifier; }
    else if (ts.isSpreadElement(node)) iterExpr = node.expression; // [...bag] / f(...bag)
    else if (ts.isSpreadAssignment(node)) {
      iterExpr = node.expression; // {...bag} — object spread is NOT iteration (copies own enumerable
      // props, no [Symbol.iterator]); wellKnownSymbolMember finds none and edges nothing for iteration.
      // But the copy DOES invoke each source getter — enumerate them (the silent-pure object-spread hole).
      enumerateGetters(enclosing(node), checker.getTypeAtLocation(node.expression));
    }
    else if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer)
      iterExpr = node.initializer; // const [a] = bag
    else if (ts.isCallExpression(node) && node.arguments?.[0]
             && node.expression.getText() === "Array.from")
      iterExpr = node.arguments[0]; // Array.from(bag) — the iterable form (arg0 is iterated)
    if (iterExpr) {
      const owner = enclosing(node);
      if (owner) {
        const targets = iterationTargets(iterExpr, iterAsync);
        edgeToTargets(fns.get(owner), targets);
        // Opaque-iterable honesty: a param/`any`/type-parameter iterable runs caller-supplied iterator
        // code — disclose Unknown, mirroring the opaque-callback `call:param` posture (cardinal-sin
        // guard). Skipped when iteration already resolved a LOCAL unit (real effect already edged).
        noteOpaqueIteration(node, iterExpr, targets.length > 0);
      }
    }
  }
  // `using r = expr` / `await using r = expr` (MED): the scope-exit guarantees `r[Symbol.dispose]()` /
  // `r[Symbol.asyncDispose]()`. Edge the enclosing fn to the resolved LOCAL dispose method.
  if (ts.isVariableStatement(node)) {
    const fl = node.declarationList.flags;
    const isUsing = (fl & ts.NodeFlags.Using) || (fl & ts.NodeFlags.AwaitUsing);
    if (isUsing) {
      const isAwait = !!(fl & ts.NodeFlags.AwaitUsing);
      const prefixes = isAwait ? ["__@asyncDispose", "__@dispose"] : ["__@dispose"];
      const owner = enclosing(node);
      for (const d of node.declarationList.declarations) {
        if (!d.initializer || !owner) continue;
        const t = checker.getTypeAtLocation(d.initializer);
        const disposeDecl = declOfSym(wellKnownSymbolMember(t, prefixes));
        if (disposeDecl && declIsLocal(disposeDecl)) edgeToTargets(fns.get(owner), [disposeDecl]);
      }
    }
  }
  // IMPLICIT VALUE-COERCION desugaring (HIGH): the JS coercion protocol invokes a user method the AST
  // walk never visits as a CallExpression. Resolve the operand's type's coercion member and edge to it
  // when LOCAL (a built-in/external member resolves non-local → no edge → stays pure). NEVER fabricate.
  {
    const owner = enclosing(node);
    const recOf = () => owner && fns.get(owner);
    // 1+2. BINARY operators. `+` with an OBJECT operand triggers toString/valueOf (string+string,
    // number+number have no coercion method — stay pure, gated by mayCoerceObject). Arithmetic
    // (`-`/`*`/`/`/`%`/`**`) and relational (`<`/`>`/`<=`/`>=`) coerce to a NUMBER → valueOf (then
    // toString). `[Symbol.toPrimitive]` is preferred by JS over both — always consulted.
    if (ts.isBinaryExpression(node) && owner) {
      const op = node.operatorToken.kind;
      const K = ts.SyntaxKind;
      const ARITH = new Set([K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken,
        K.AsteriskAsteriskToken, K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken,
        K.GreaterThanEqualsToken, K.AmpersandToken, K.BarToken, K.CaretToken,
        K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken]);
      const COMPOUND_ARITH = new Set([K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken,
        K.PercentEqualsToken, K.AsteriskAsteriskEqualsToken]);
      if (op === K.PlusToken || op === K.PlusEqualsToken) {
        // string concat / `+` arithmetic: an OBJECT operand is coerced via toString OR valueOf (the
        // order depends on the hint, but EITHER may run — edge to both when local). string+string and
        // number+number have only primitive operands → mayCoerceObject false → no edge (pure).
        for (const operand of [node.left, node.right]) {
          if (mayCoerceObject(operand))
            edgeToTargets(recOf(), coercionTargets(operand, ["valueOf", "toString"], true));
        }
      } else if (ARITH.has(op) || COMPOUND_ARITH.has(op)) {
        for (const operand of [node.left, node.right]) {
          if (mayCoerceObject(operand))
            edgeToTargets(recOf(), coercionTargets(operand, ["valueOf", "toString"], true));
        }
      }
    }
    // 2. UNARY arithmetic `-x` / `+x` / `~x` coerces the operand to a number → valueOf (then toString /
    // [Symbol.toPrimitive]). (`!x` is boolean coercion — no method call; excluded.)
    if (ts.isPrefixUnaryExpression(node) && owner
        && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken
            || node.operator === ts.SyntaxKind.TildeToken)
        && mayCoerceObject(node.operand)) {
      edgeToTargets(recOf(), coercionTargets(node.operand, ["valueOf", "toString"], true));
    }
    // 1. TEMPLATE expression `` `${x}` ``: each interpolated substitution is string-coerced → toString
    // (then [Symbol.toPrimitive]/valueOf). (A TaggedTemplate is handled separately below — the tag fn
    // receives the raw substitution values, no per-sub coercion, so we exclude tagged templates here.)
    if (ts.isTemplateExpression(node) && owner && !ts.isTaggedTemplateExpression(node.parent)) {
      for (const span of node.templateSpans)
        if (mayCoerceObject(span.expression))
          edgeToTargets(recOf(), coercionTargets(span.expression, ["toString", "valueOf"], true));
    }
    // 1+4. CALL forms `String(x)` (→ toString) and `JSON.stringify(x)` (→ toJSON). These resolve to the
    // es-lib `StringConstructor`/`JSON.stringify` signature (not the user method), so the CallExpression
    // walk above never follows the coercion. Edge to the argument's LOCAL toString / toJSON.
    if (ts.isCallExpression(node) && owner && node.arguments?.[0]) {
      const callee = node.expression.getText().replace(/\s+/g, "");
      const arg0 = node.arguments[0];
      if (callee === "String" && ts.isIdentifier(node.expression) && mayCoerceObject(arg0))
        edgeToTargets(recOf(), coercionTargets(arg0, ["toString", "valueOf"], true));
      // `"" + x` is covered by the binary arm; `String(x)` is the explicit conversion form.
      else if (callee === "JSON.stringify")
        // toJSON is consulted regardless of operand shape (JSON.stringify checks for it on any value);
        // a plain object with no LOCAL toJSON resolves to nothing → pure (no fabrication). NO Symbol-
        // toPrimitive here — JSON.stringify uses toJSON only, not the primitive-coercion protocol.
        edgeToTargets(recOf(), coercionTargets(arg0, ["toJSON"], false));
    }
  }
  // TAGGED TEMPLATE (LOW): `` tag`…` `` calls `tag(strings, ...subs)`. getResolvedSignature resolves
  // the TaggedTemplateExpression to the tag fn cleanly — a node form the CallExpression walk never
  // visits. Edge to the tag when LOCAL; a built-in/external tag (`String.raw`) resolves non-local and
  // edges nothing (pure), matching the external-call posture.
  if (ts.isTaggedTemplateExpression(node)) {
    const owner = enclosing(node);
    if (owner) {
      const sig = checker.getResolvedSignature(node);
      const decl = sig && sig.declaration;
      if (decl && declIsLocal(decl)) edgeToTargets(fns.get(owner), [decl]);
    }
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
for (const m of ["hosts", "tables", "cmds", "paths", "blind", "incomplete"]) {
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
  // entry points stay visible even when pure; a BLIND fn stays too, so the honesty disclosure survives
  // on exactly the `inferred: []` fns that need it.
  if (inf.length === 0 && !rec.entry && rec.blind.size === 0) continue;
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
  // ⟨0.6⟩ unknownWhy — REQUIRED on a DIRECT Unknown SOURCE (this fn's own body has the unresolvable call,
  // so `rec.direct` carries Unknown), absent on a purely-transitive Unknown. The rich per-site reasons
  // (rec.why: callback:/dispatch:/dynamic-key:) when recorded, else a generic fallback so a source is
  // never left un-tagged — the source/transitive split the `blindspots` query needs (SPEC §3.1/§4).
  if (rec.direct.has("Unknown")) entry.unknownWhy = rec.why.size ? [...rec.why].sort() : ["unresolved"];
  // HONESTY: the npm packages this fn transitively reaches that κ couldn't see through — effects through
  // them are NOT in `inferred`, so it is a LOWER BOUND when this is non-empty. Omitted when none.
  if (rec.blind.size) entry.invisible = [...rec.blind].sort();
  if (rec.entry) entry.entryPoint = true;
  if (rec.isCjsExport) entry.unitKind = "export"; // spec 0.5 draft, informative — per-unit, not by name
  functions.push(entry);
}
// `package` names what this report COVERS — a consumer chaining it registers coverage even when
// `functions` is empty (an all-pure package's report is its purity claim, SPEC §2 rule 3).
const envelope = { candor: { version: ENGINE_VERSION, toolchain: `node-${process.versions.node}`, spec: SPEC_VERSION },
                   package: pkgName, functions };
const cg = {};
for (const [name, rec] of fns) cg[name] = [...rec.edges].sort();
// Write ATOMICALLY (temp + rename): a concurrent reader — the MCP server or another `query` while
// `candor-ts-watch` re-scans (the recommended agent setup runs both) — must never observe a
// half-written report. An in-place writeFileSync leaves a truncation window where JSON.parse throws;
// rename(2) is atomic within a filesystem, so a reader sees either the old report or the new one whole.
const writeAtomic = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };
// --json: print the §2 envelope to STDOUT instead of writing the report files (matches candor-scan/Rust).
if (wantJson) {
  console.log(JSON.stringify(envelope, null, 1));
} else {
  writeAtomic(`${outPrefix}.json`, JSON.stringify(envelope, null, 1));
  writeAtomic(`${outPrefix}.callgraph.json`, JSON.stringify(cg, null, 1));
}
// Type-hierarchy sidecar (SPEC §4 / 0.7): each project class/interface (qualified `mod.Name`, matching
// the `mod.Class.member` fn quals) -> its qualified direct supertypes/interfaces. Compact (O(types)),
// lets `callers --include-unknown` resolve whether a confirmed reacher is an override of a `dispatch:`
// owner WITHOUT storing the dropped candidate edges (which would re-encode the flood bounded-CHA prevents).
const hierarchy = {};
for (const sf of sources) {
  const mod = moduleOf(sf);
  (function walk(node) {
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      const supers = [];
      for (const h of node.heritageClauses ?? []) {
        for (const t of h.types ?? []) {
          let sym = checker.getSymbolAtLocation(t.expression);
          if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
          const d = (sym?.declarations ?? []).find((x) => ts.isClassDeclaration(x) || ts.isInterfaceDeclaration(x));
          supers.push(d && d.name ? `${moduleOf(d.getSourceFile())}.${namespacePrefixOf(d)}${d.name.getText()}` : t.expression.getText());
        }
      }
      if (supers.length) hierarchy[`${mod}.${namespacePrefixOf(node)}${node.name.getText()}`] = supers;
    }
    ts.forEachChild(node, walk);
  })(sf);
}
if (!wantJson) {
  writeAtomic(`${outPrefix}.hierarchy.json`, JSON.stringify(hierarchy, null, 1));
  console.error(`candor-ts: wrote ${functions.length} effectful functions (${fns.size} analyzed, ${sources.length} files) to ${outPrefix}.json`);
}
{
  // Effect breakdown — make the result visible at a glance, not just a count + a file path.
  const counts = {};
  for (const e of functions) for (const x of e.inferred) counts[x] = (counts[x] || 0) + 1;
  const breakdown = ["Net", "Fs", "Db", "Exec", "Ipc", "Env", "Clipboard", "Clock", "Log", "Rand"]
    .filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(" · ");
  const unknown = counts.Unknown || 0;
  if (breakdown || unknown) {
    console.error(`  ${breakdown}${unknown ? `${breakdown ? "   ·   " : ""}Unknown ${unknown} (disclosed)` : ""}`);
  }
}
if (unlistedSeen.size > 0) {
  const top = [...unlistedSeen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = top.slice(0, 8).map(([p, n]) => `${p} (${n} call${n === 1 ? "" : "s"})`).join(", ");
  const more = top.length > 8 ? ` + ${top.length - 8} more` : "";
  console.error(`candor-ts: κ doesn't know ${top.length} package${top.length === 1 ? "" : "s"} this code calls into — `
    + `effects through ${top.length === 1 ? "it are" : "them are"} INVISIBLE (not Unknown): ${shown}${more}`);
}

// ---- the gate surfaces: the AS-EFF-005 baseline guard + the standing §6.2 policy gate --------------
// When stdout carries a JSON document — the §2 envelope (--json) OR the streamed gate verdict
// (--gate-json -) — it must stay pure JSON: route the gate's [AS-EFF-…] violation lines to stderr so
// a `… | jq` / `… | candor-sarif` pipe never breaks.
const emitViolation = (wantJson || gateJsonPath === "-") ? (l) => console.error(l) : (l) => console.log(l);
let gateViolations = [];

// ---- the AS-EFF-005 baseline guard (CANDOR_BASELINE / config `baseline`; SPEC §7 item 5) -----------
// Semantics mirror the reference engine (candor-java Policy.checkBaseline) exactly:
//  · ABSENT file → one stderr note, guard inactive (ratchet not adopted; exit unchanged).
//  · PRESENT but unparseable (corrupt/truncated/not-a-report) → exit 2 WITHOUT evaluating — the guard
//    must never silently pass on unreadable gate input (the unreadable-policy class, §6.2).
//  · A missing provenance header (legacy bare array) OR a producing `candor.version` ≠ this build →
//    exit 2 WITHOUT evaluating (§2.1: a baseline is comparable only to its OWN producing version —
//    evaluating a stale one yields a bogus AS-EFF-005 wave; skipping is an unbounded fail-open window).
//    The read-only `diff`/`gains` QUERIES disclose a mismatch instead of failing — a comparison the
//    user explicitly asked for should inform; this scan-time guard is the gate and fails closed.
//  · Valid + same build → per-fn compare: an EXISTING fn gaining an effect is an [AS-EFF-005]
//    violation (exit 1, joins --gate-json); a fn absent from the baseline is NEW code, reviewed as
//    such, not a regression. Baselines omit pure fns (spec §2), so absent-prior means no prior claim.
if (baselinePath !== null) {
  const shownB = baselinePath === "" ? "(configured empty)" : baselinePath;
  if (baselinePath !== "" && !fs.existsSync(baselinePath)) {
    console.error(`candor-ts: CANDOR_BASELINE ${baselinePath} does not exist — the regression guard is `
      + `not active (record one: candor-ts <target> --out <prefix>, then point at the report .json).`);
  } else {
    let root = null;
    try { root = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch { /* root stays null → exit 2 */ }
    const arr = Array.isArray(root) ? root : (root && typeof root === "object" ? root.functions : null);
    if (!Array.isArray(arr)) {
      console.error(`candor-ts: baseline ${shownB} exists but could not be parsed (corrupt/truncated?) — `
        + `failing (exit 2); the guard must not silently pass on an unreadable baseline. Regenerate it with this build.`);
      process.exit(2);
    }
    const baseVersion = !Array.isArray(root) && root.candor && typeof root.candor === "object"
      && typeof root.candor.version === "string" ? root.candor.version : null;
    if (baseVersion === null) {
      console.error(`candor-ts: the baseline ${shownB} has no provenance header (a legacy/bare-array report) — `
        + `a baseline is comparable only to its producing build (§2.1). Failing (exit 2); regenerate it with this build.`);
      process.exit(2);
    }
    if (baseVersion !== ENGINE_VERSION) {
      console.error(`candor-ts: the baseline ${shownB} was produced by engine build ${baseVersion} but this is `
        + `build ${ENGINE_VERSION} — an engine swap is baseline-invalidating and the gate cannot evaluate `
        + `(exit 2; never a silent skip, never a bogus AS-EFF-005 wave). Regenerate deliberately with this build.`);
      process.exit(2);
    }
    const base = new Map();
    for (const e of arr) {
      if (e && typeof e.fn === "string" && e.fn) base.set(e.fn, new Set(Array.isArray(e.inferred) ? e.inferred : []));
    }
    for (const name of [...inferred.keys()].sort()) {
      const prior = base.get(name);
      if (prior === undefined) continue;                    // new function — not a regression
      const gained = [...inferred.get(name)].filter((x) => !prior.has(x)).sort();
      if (gained.length) {
        gateViolations.push({ rule: "AS-EFF-005", fn: name, effects: gained,
          detail: `\`${name}\` gained effect { ${gained.join(", ")} } not present in the baseline` });
      }
    }
  }
}

// ---- the standing §6.2 gate (--policy / CANDOR_POLICY) --------------------------------------------
// `!== null`, not truthiness: a CONFIGURED-but-EMPTY policy (a bare `policy` config line, a set-but-
// empty CANDOR_POLICY) is "" — falsy, so a truthy check silently skipped the gate, the exact quiet
// drop the config comment above promises fails loud. "" now reaches the read, which fails → exit 2
// (the Rust engine's behavior on the same input).
if (policyPath !== null) {
  let text;
  try {
    text = fs.readFileSync(policyPath, "utf8");
  } catch {
    // a set-but-unreadable policy must be LOUD — silently passing would let a violation ship
    console.error(`candor-ts: policy ${policyPath === "" ? "(configured empty)" : policyPath} could not be read; gate NOT enforced`);
    process.exit(2);
  }
  // The masking-incompleteness map (fn -> effects whose surface is incomplete), kept INTERNAL like the
  // java/rust engines (not a report field) — passed to the gate so an incomplete surface fails closed.
  const incompleteMap = new Map();
  for (const [name, rec] of fns) if (rec.incomplete.size) incompleteMap.set(name, rec.incomplete);
  gateViolations = gateViolations.concat(evaluatePolicy(parsePolicy(text), functions, cg, incompleteMap));
}
for (const x of gateViolations) emitViolation(`[${x.rule}] ${x.detail}`);
// --gate-json ⟨0.8⟩: the structured gate verdict { spec, ok, violations:[{rule,fn,effects,detail}] }, from
// the SAME gateViolations that set the exit code (so it can't disagree). Written whenever the flag is set —
// ok:true,[] when no gate is configured. Must precede the exit(1) below.
if (gateJsonPath) {
  const verdict = JSON.stringify({ spec: SPEC_VERSION, ok: gateViolations.length === 0, violations: gateViolations }, null, 1);
  if (gateJsonPath === "-") console.log(verdict);
  else {
    // The verdict is a SURFACING side-output: an unwritable path must be one stderr line, never a raw
    // ENOENT crash whose exit 1 reads as a policy violation on a clean run (max-review find).
    try { writeAtomic(gateJsonPath, verdict + "\n"); }
    catch (e) { console.error(`candor-ts: could not write --gate-json ${gateJsonPath}: ${e.message}`); }
  }
}
// gateViolations is non-empty only when a gate surface (policy / baseline) was active and fired.
if (gateViolations.length) {
  console.error(`candor-ts: ${gateViolations.length} policy violation(s)`);
  process.exit(1);
}
if (policyPath !== null) console.error("candor-ts: policy ✓");
if (baselinePath !== null && fs.existsSync(baselinePath)) console.error("candor-ts: baseline ✓"); // absent = inactive (noted above)
