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
  // FABRICATED Net — the precision failure — purely from this classification, with no local Net edge). Only
  // these three named validators are freed; every genuine verb (connect/createConnection/createServer…)
  // stays Net (the matcher excludes ONLY new + the three validators, nothing else).
  // ALSO exempt the pure CONFIG/METADATA members the whole-module rule fabricated Net on (sweep [9], the
  // precision failure — none touch a socket/fd/syscall): tls.getCiphers/createSecureContext/checkServerIdentity
  // (cipher-list + cert helpers), http.validateHeaderName/validateHeaderValue (string validators, like
  // isIP), and a Socket/Server's setKeepAlive/setNoDelay/ref/unref/address (TCP-option + bound-address
  // metadata — no I/O). Every genuine verb still classifies; only these proven-pure names are freed.
  [/^(node:)?(net|dgram|tls|http2?|https)$/,
   /^(?!(new|isIP|isIPv4|isIPv6|getCiphers|createSecureContext|checkServerIdentity|validateHeaderName|validateHeaderValue|setKeepAlive|setNoDelay|ref|unref|address)$)/,
   "Net"],
  // node:dns — name resolution is NETWORK I/O (lookup/lookupService hit the OS resolver; resolve*/
  // reverse query DNS servers directly). Was unclassified, so a `dns.resolve(...)` read silently pure.
  // Same construction-and-pure-accessor carve-out as the net cluster: `new dns.Resolver()` ("new") is
  // inert, and the SERVER-CONFIG accessors getServers/setServers/get|setDefaultResultOrder touch no
  // network (in-process config) — classifying them Net would be a FABRICATION (the precision failure). Every genuine
  // resolver verb (lookup/resolve4/resolveMx/reverse/…) stays Net. Covers node:dns/promises too.
  [/^(node:)?dns(\/promises)?$/,
   /^(?!(new|getServers|setServers|getDefaultResultOrder|setDefaultResultOrder)$)/, "Net"],
  [/^(node:)?child_process$/, null, "Exec"],
  // node:worker_threads — `postMessage` crosses a thread boundary (the canonical Node worker IPC);
  // `receiveMessageOnPort` reads it. Covers `worker.postMessage`, `parentPort.postMessage`, and a
  // `MessagePort`'s `.postMessage` (all typed from this module). `new Worker(...)` spawns the thread but
  // construction is inert here (like the net-cluster ctors) — the message verbs are the IPC boundary.
  [/^(node:)?worker_threads$/, /^(postMessage|receiveMessageOnPort)$/, "Ipc"],
  // node:cluster — `fork()` spawns a worker PROCESS and wires its IPC channel.
  [/^(node:)?cluster$/, /^fork$/, "Ipc"],
  // node:vm executes a runtime-supplied code STRING in-process — `runInThisContext`/`runInContext`/
  // `runInNewContext`/`compileFunction`, and the same verbs on a `new vm.Script(code)`. Like `eval`,
  // the effects are whatever the code does (opaque) → genuinely Unknown (NOT Exec: no subprocess).
  // Was unmodeled inside the κ-covered @types/node, so `vm.runInThisContext(code)` read SILENT-PURE
  // (a code-execution sink reported pure — found by real-world corpus testing). The why is attached at
  // the classify site (the only κ rule that resolves to the Unknown trust-marker, SPEC §4).
  [/^(node:)?vm$/, /^(runInThisContext|runInContext|runInNewContext|compileFunction)$/, "Unknown"],
  [/^(node:)?sqlite$/, null, "Db"],
  // the curated npm tier
  [/^(axios|got|node-fetch|undici|ws|socket\.io(-client)?|nodemailer)$/, null, "Net"],
  // gaxios is the axios-like HTTP client under googleapis (request/get/post/put/patch/delete/head do
  // the network; it has no notable pure surface, but be VERB-precise like the rest of the Net tier so a
  // future config accessor can't fabricate). `createAPIRequest` is googleapis-common's transport entry
  // (every googleapis service method funnels through it → the real network). The deeper `googleapis`
  // service chains (`calendar.events.insert()`) resolve their verb into the `googleapis` package, but
  // those verbs are GENERIC (insert/list/get/update) and shared with pure builders — modeling them by
  // name would fabricate; the actual network is the gaxios/createAPIRequest transport, modeled here, so
  // a googleapis call that reaches the wire does so through a modeled unit when its source is scanned.
  [/^gaxios$/, /^(request|get|post|put|patch|delete|head)$/, "Net"],
  [/^googleapis-common$/, /^createAPIRequest$/, "Net"],
  // google-auth-library mints/refreshes OAuth tokens and verifies ID tokens over the network. The
  // verb surface only (the GoogleAuth/OAuth2Client/JWT constructors are config — inert until a verb).
  [/^google-auth-library$/,
   /^(request|getClient|getAccessToken|getRequestHeaders|authorize|refreshAccessToken|refreshToken|getTokenInfo|verifyIdToken|fetchIdToken|getCredentials|getProjectId|getSignedJwt)$/,
   "Net"],
  // stripe: methods land on a `new Stripe()` instance's resource chains
  // (`stripe.customers.create()`, `stripe.checkout.sessions.create()`, `charges.*`, `paymentIntents.*`).
  // A chained member call resolves its verb's DECLARATION into the `stripe` package (declModule keys on
  // the source file, not the chain depth — verified), so keying on stripe's resource VERBS catches the
  // deep chains. VERB-precise: the I/O verbs only (the SDK's resources share these); pure helpers
  // (toString/JSON) and inert `new Stripe()` construction stay pure.
  [/^stripe$/,
   /^(create|retrieve|update|list|listLineItems|listPaymentMethods|del|delete|cancel|capture|confirm|expire|finalizeInvoice|pay|sendInvoice|markUncollectible|voidInvoice|refund|reverse|verify|search|approve|decline|attach|detach|deactivate)$/,
   "Net"],
  // error/telemetry SaaS — the capture/flush verbs ship the payload over the network. init/config are
  // inert. @sentry/* re-exports captureException etc. from @sentry/core/@sentry/browser, so a consumer's
  // import may resolve into any @sentry sub-package — match the whole scope, verb-precise.
  [/^@sentry\/[^/]+$/,
   /^(captureException|captureMessage|captureEvent|captureCheckIn|flush|close)$/, "Net"],
  // posthog-node: capture/identify/group enqueue then flush over HTTP; flush/shutdown/captureImmediate
  // and the feature-flag fetches (isFeatureEnabled/getFeatureFlag*) hit the API. Verb-precise; the
  // `new PostHog()` ctor is inert (config).
  [/^posthog-node$/,
   /^(capture|captureImmediate|identify|identifyImmediate|alias|groupIdentify|flush|shutdown|isFeatureEnabled|getFeatureFlag|getFeatureFlagPayload|getAllFlags|getAllFlagsAndPayloads|getRemoteConfigPayload|reloadFeatureFlags)$/,
   "Net"],
  [/^(pg|mysql2?|mongodb|ioredis|redis|sqlite3|better-sqlite3|knex)$/, null, "Db"],
  // bull/bullmq are Redis-backed job queues — the queue/worker/job ops issue Redis commands (Db). Their
  // surface is almost entirely I/O, but be VERB-precise (the I/O ops) so inert event-wiring
  // (`queue.on(...)`) and `new Queue()`/`new Worker()` construction (which only opens a lazy connection)
  // don't fabricate. The connection IS Redis — Db, consistent with the ioredis/redis classification.
  [/^(bull|bullmq)$/,
   /^(add|addBulk|getJob|getJobs|getJobCounts|getJobCountByTypes|getWaiting|getActive|getCompleted|getFailed|getDelayed|getWaitingChildren|getRepeatableJobs|removeRepeatable|removeRepeatableByKey|getMetrics|count|pause|resume|isPaused|drain|clean|obliterate|empty|close|remove|retry|retryJobs|promote|moveToCompleted|moveToFailed|updateData|updateProgress|process|waitUntilReady|getState|getDependencies|getChildrenValues)$/,
   "Db"],
  [/^(execa|cross-spawn|shelljs)$/, null, "Exec"],
  // the `open` package spawns the OS handler (xdg-open/open/start) — Exec. Default export `open(target)`
  // resolves to member `open` (its declared fn name — verified); `openApp` likewise. The `apps` const is
  // pure (a property read, never a call).
  [/^open$/, /^(open|openApp)$/, "Exec"],
  [/^(fs-extra|graceful-fs|rimraf|glob|chokidar)$/, null, "Fs"],
  [/^dotenv$/, null, "Env"],
  [/^(winston|pino|bunyan|npmlog)$/, null, "Log"],
  // nest-winston wraps winston; the injected logger's level verbs are the Log boundary (the
  // WinstonModule.createLogger/forRoot config is inert).
  [/^nest-winston$/, /^(log|info|warn|error|debug|verbose|silly|http)$/, "Log"],
  // entropy: node:crypto's random surface + the password-hashing libs (salted -> Rand). Found by
  // the CTA dogfood on a Nest app: argon2.hash came out SILENTLY PURE (the curated-kappa caveat
  // landing on exactly the call a security review cares about).
  // `generateKey*`/`generateKeyPair*`/`generatePrime*` draw from the CSPRNG just like `random*` — they
  // were silently pure inside the covered `crypto` module (the κ-coverage floor can't tell an unmodeled
  // entropy draw from a pure unmodeled member; the fix is to MODEL the member, not drop coverage).
  [/^(node:)?crypto$/, /^(random|getRandomValues|generateKey|generatePrime)/, "Rand"],
  // uuid: the random-based generators draw from the CSPRNG (v4) / clock+MAC+random (v1) / random (v6/v7).
  // v3 (MD5) and v5 (SHA-1) are DETERMINISTIC namespace hashes — same input, same UUID — so they are
  // PURE and excluded. parse/stringify/validate/version/NIL/MAX are pure too (not matched).
  [/^uuid$/, /^(v1|v4|v6|v7)$/, "Rand"],
  // nanoid: nanoid()/customRandom() draw from crypto.getRandomValues; customAlphabet() returns a
  // generator that does the same. `nanoid/non-secure` uses Math.random — still Rand. The `urlAlphabet`
  // const is pure (a property read). Sound over-approximation: the factory call is the resolvable site.
  [/^nanoid(\/non-secure)?$/, /^(nanoid|customAlphabet|customRandom)$/, "Rand"],
  // node:os identity reads — userInfo (the OS user record) and hostname (the machine name) are
  // environment/host reads (Env), like System.getenv's host-identity cousins. The rest of node:os
  // (platform/arch/cpus/totalmem/…) is inert host introspection, left pure.
  [/^(node:)?os$/, /^(userInfo|hostname)$/, "Env"],
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
  // Sequelize is EXECUTE-ON-CALL: `Model.findAll()/create()/update()/destroy()` issue the query and
  // return a promise — so its verbs are the I/O boundary.
  [/^sequelize$/,
   /^(find|create|update|destroy|upsert|count|max|min|sum|increment|decrement|reload|save|query|transaction)/,
   "Db"],
  // Drizzle is a BUILDER: `db.select().from().where()` / `db.insert().values()` / `db.update().set()` /
  // `db.delete().where()` issue NOTHING until a terminal `.execute()`/await/`.all()`/`.get()`/`.run()` (or
  // the relational `db.query.x.findMany/findFirst`). Listing select/insert/update/delete as Db fabricated
  // the effect onto a pure builder chain (the typeorm rule's `createQueryBuilder` discipline, violated).
  // VERB-PRECISE: only the terminal execution verbs; the builder heads under-report (sound) until executed.
  [/^drizzle-orm$/, /^(execute|transaction|findMany|findFirst|all|get|run)$/, "Db"],
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
