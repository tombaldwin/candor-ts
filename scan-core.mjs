/**
 * scan-core — the PURE classifier + literal-extraction leaves of scan.mjs, factored out so they can be
 * unit-tested directly (scan.mjs proper is the TS-compiler-driven walk; these take plain strings). No
 * TypeScript-AST dependency, no I/O, no scan state: the κ rules table + its two readers, the §6.2
 * Exec-head refinement, the bare host-literal matcher, the SPEC §2 SQL-table extraction, and the
 * test-path predicate. scan.mjs imports them; the behavior is identical (this is a move, not a rewrite).
 */

// A source path that is test/spec/dependency code, not the package's own production surface.
export function isTestPath(p) {
  return /(^|\/)(node_modules|__tests__|tests?|spec)(\/|$)/.test(p) || /\.(test|spec)\.[mc]?tsx?$/.test(p);
}

// ---- κ — the curated classifier (CLASSIFIER §2: the dispatch/execution boundary, not builders) ----
// Node builtins + a curated npm tier (the same under-report-and-say-so posture as the crate table:
// an unlisted package contributes nothing — never a guess).
// One rules TABLE, two readers: kappa() classifies a call; kappaKnows() answers "is this package
// curated at all?" for the coverage ledger (a κ-known package whose given call is pure — a TypeORM
// builder — is covered, not a blind spot). A single source so the two can never drift.
// [module-name regex, member regex (null = any member), effect]
// The member token a rule matches against is the resolved declaration's name, EXCEPT a constructor
// call (`new X()`), whose synthesized token is "new" (its decl `name` is empty — see CLASSIFY). This
// lets a rule keep the effect on the module's function/verb surface while exempting inert CONSTRUCTION.
export const KAPPA_RULES = [
  [/^(node:)?fs(\/promises)?$/, null, "Fs"],
  // The net cluster (net/dgram/tls/http/http2/https) is I/O on its FUNCTION/verb surface
  // (request/get/connect/createConnection/createServer/createSocket/listen…), but inert on
  // CONSTRUCTION: `new http.Agent()` is a connection-pool config object, `new http.Server()` /
  // `new net.Socket()` open nothing until a later `.listen()`/`.connect()`/request uses them — no
  // syscall, no fd. So Net for every member EXCEPT a constructor (token "new"); construction is pure.
  // Conservative by the cardinal rule: any NON-constructor member — listed verb or not — keeps Net,
  // so an unlisted effectful function can never under-report; only proven-inert construction is freed.
  // (The pure CONSTANTS http.STATUS_CODES/METHODS/maxHeaderSize and the https.globalAgent accessor are
  // property reads, not calls — they never reach κ and are already pure.)
  // Also exempt node:net's PURE STRING VALIDATORS isIP/isIPv4/isIPv6: they parse a string and return
  // 0/4/6 (or a boolean) with no socket, no fd, no syscall — pure functions. The whole-module Net rule
  // once fabricated Net onto them; a real-world sweep on node-fetch caught it (its trustworthy URL
  // predicates isOriginPotentiallyTrustworthy/isUrlPotentiallyTrustworthy call isIP() and inherited a
  // FABRICATED Net — the cardinal sin — purely from this classification, with no local Net edge). Only
  // these three named validators are freed; every genuine verb (connect/createConnection/createServer…)
  // stays Net (the matcher excludes ONLY new + the three validators, nothing else).
  [/^(node:)?(net|dgram|tls|http2?|https)$/, /^(?!(new|isIP|isIPv4|isIPv6)$)/, "Net"],
  // node:dns — name resolution is NETWORK I/O (lookup/lookupService hit the OS resolver; resolve*/
  // reverse query DNS servers directly). Was unclassified, so a `dns.resolve(...)` read silently pure.
  // Same construction-and-pure-accessor carve-out as the net cluster: `new dns.Resolver()` ("new") is
  // inert, and the SERVER-CONFIG accessors getServers/setServers/get|setDefaultResultOrder touch no
  // network (in-process config) — classifying them Net would FABRICATE the cardinal sin. Every genuine
  // resolver verb (lookup/resolve4/resolveMx/reverse/…) stays Net. Covers node:dns/promises too.
  [/^(node:)?dns(\/promises)?$/,
   /^(?!(new|getServers|setServers|getDefaultResultOrder|setDefaultResultOrder)$)/, "Net"],
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
export function kappa(moduleName, member) {
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
export const KAPPA_PURE = new Set([
  "@nestjs/common", "@nestjs/core", "@nestjs/swagger", "@nestjs/platform-express",
  "class-validator", "class-transformer", "reflect-metadata",
  "rxjs", "zod", "lodash", "ramda", "date-fns",
]);
export function kappaKnows(moduleName) {
  return KAPPA_PURE.has(moduleName) || KAPPA_RULES.some(([mre]) => mre.test(moduleName));
}

// Refine the Exec cliff (spec §4 ⟨0.5⟩): the effects a literal, statically-known subprocess head
// implies, matched by basename. ADDED to a caller that already carries Exec (a subprocess is still
// spawned — Exec is never dropped); an unrecognised head returns [] and keeps the bare cliff (never
// guess). A candor engine reads Fs/Env only — spec §7 item 12 (the analyzer self-boundary) guarantees
// it, so that case is spec-supplied. Only UNAMBIGUOUS single-effect tools belong here: a multi-modal
// head (git status local vs git push Net; rsync local vs remote; make/npm run project code) would
// fabricate the effect for its common case. The reference engines share this table verbatim.
export function commandHeadEffects(cmd) {
  const base = cmd.trim().split(/\s+/)[0].split(/[/\\]/).pop();
  if (["curl", "wget", "http", "ssh", "scp", "sftp", "ftp", "telnet"].includes(base)) return ["Net"];
  if (["psql", "mysql", "sqlite3", "mongosh", "mongo", "redis-cli", "cqlsh", "influx"].includes(base)) return ["Db"];
  if (["candor", "candor-run.sh", "candor-scan", "candor-query", "candor-java",
       "candor-classify", "candor-report", "cargo-candor"].includes(base)) return ["Env", "Fs"];
  return [];
}
// host[:port] from an address/URL literal; non-address strings yield nothing (never fabricate).
export function hostLiteral(s) {
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);   // scheme://host[:port]/…
  if (m) return m[1].replace(/^.*@/, "");
  if (/^[a-z0-9._-]+(:\d+)?$/i.test(s) && s.includes(".")) return s; // bare host[.tld][:port]
  return null;
}
// Table-position identifiers in a SQL string literal (SPEC §2 `tables`). Mirrors the Rust
// tables_in_sql exactly: must open with a statement keyword; FROM/JOIN/INTO anywhere,
// statement-leading UPDATE/TRUNCATE, TABLE (skipping ONLY/IF NOT EXISTS); a FOR UPDATE locking
// clause yields nothing. Conservative in the fabrication direction.
export function tablesInSql(sql) {
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
