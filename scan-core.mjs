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
  // …AND `postMessageToThread`, node 22's MODULE-LEVEL send. The name is anchored, so the newer API
  // slipped past a rule that already covered every other spelling: `parentPort.postMessage`,
  // `worker.postMessage`, a `MessagePort`'s `.postMessage` and `receiveMessageOnPort` were all Ipc while
  // `postMessageToThread(id, value)` — the same channel, addressed by thread id — read PURE. Found by
  // enumerating each builtin's EXPORTS and diffing them against what the table charges, rather than by
  // testing the spellings someone already thought of.
  [/^(node:)?worker_threads$/, /^(postMessage|postMessageToThread|receiveMessageOnPort)$/, "Ipc"],
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
  // ── ⟨0.32⟩ THE NAMED NODE-CORE MISSES. Every one of these read SILENT-PURE, found by enumerating each
  // builtin's EXPORTS against what this table charges (the method that found `postMessageToThread`), not
  // by testing spellings someone had already thought of. They are modelled rather than left to the
  // NODE_CORE_REVIEWED floor below because a concrete effect is a better answer than `Unknown`, and a
  // floor that swallows the cases we CAN name is honest and useless.
  //
  // node:v8 — `writeHeapSnapshot(file)` writes a multi-hundred-megabyte heap dump to disk;
  // `takeCoverage`/`stopCoverage` flush V8 coverage into $NODE_V8_COVERAGE. All three are Fs.
  // (`serialize`/`deserialize`/`getHeap*Statistics` are in-process and stay pure — see the floor.)
  [/^(node:)?v8$/, /^(writeHeapSnapshot|takeCoverage|stopCoverage)$/, "Fs"],
  // node:inspector — `open(port, host)` starts the inspector's WebSocket SERVER and binds a port. That
  // is a listening network socket in a process that never mentioned the network: Net.
  [/^(node:)?inspector(\/promises)?$/, /^open$/, "Net"],
  // `process` — the global's own surface (declModule reads it from @types/node/process.d.ts). MIXED, so
  // member-precise like every other mixed module here:
  //   Fs   `loadEnvFile()` reads a .env off disk; `report.writeReport()` writes a diagnostic report.
  //        Both unambiguously touch a file.
  //   Env  the OS identity reads, for the reason `os.userInfo`/`os.hostname` are Env (same fact, other
  //        spelling) — this table was inconsistent with itself until that pair was fixed. Confirmed a
  //        true positive on the corpus: isexe's `checkMode` calls `process.getuid()`.
  // Everything else (cwd/argv/env/hrtime/memoryUsage/nextTick/exit/emitWarning/…) is introspection or
  // scheduling and is reviewed pure in the floor below; `dlopen`, `binding`, `kill`, `chdir`, `umask`
  // and the `set*id` privilege verbs are deliberately in NEITHER list, so they reach the floor and
  // fail closed as `Unknown[native:…]`.
  //
  // `kill`, `chdir` and `umask` WERE classified here — Exec, Fs and Fs — and the SELF-GATE caught it:
  // `scratch.<module>` calls `process.kill(process.pid, sig)` to re-raise a signal after cleaning up,
  // and that appeared as a new AS-EFF-006 "performs Exec — not a declared self-invocation site". It is
  // not a subprocess. `deny Exec` exists to answer "can this code run a program", and answering yes for
  // a `kill(2)` makes the effect mean something else — the fabrication direction, introduced while
  // closing an under-report, which is the exact shape this project has measured four times. `Unknown`
  // is the honest answer for an operation §1 has no name for: it is no longer silent, and it does not
  // claim an effect this engine cannot defend against the other three.
  [/^(node:)?process$/, /^(loadEnvFile|writeReport)$/, "Fs"],
  [/^(node:)?process$/, /^(getuid|geteuid|getgid|getegid|getgroups)$/, "Env"],
  // node:module — the compile cache is a real on-disk cache directory.
  [/^(node:)?module$/, /^(enableCompileCache|flushCompileCache|getCompileCacheDir)$/, "Fs"],
  // node:util — `debuglog(section)`/`debug(section)` READ $NODE_DEBUG to decide whether the returned
  // logger is live. An environment read behind a convenience name, exactly like `os.homedir()`.
  [/^(node:)?util$/, /^(debuglog|debug)$/, "Env"],
  // The Web Crypto RNG reached through @types/node's own global typings rather than through lib.dom
  // (the es-lib arm at the classify site covers the `Crypto` interface; this covers the node spelling).
  [/^web-globals\/crypto$/, /^(getRandomValues|randomUUID|generateKey)/, "Rand"],
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
  // Template-literal SQL clients that EXECUTE the query through a `sql`…`` tag: postgres.js (porsager),
  // @vercel/postgres, slonik. Whole-module Db (the client factory + the tag both reach the connection, like
  // pg's `new Pool()`). NOT `sql-template-tag` — that only BUILDS a query object (executed via pg), so it is
  // a pure builder and stays uncurated. The tag call is classified through the TaggedTemplateExpression arm.
  [/^(postgres|@vercel\/postgres|slonik)$/, null, "Db"],
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
  // CLI-tool packages surfaced by the 0.9 dogfood on `zx` (read `invisible` before — a κ-coverage gap, not
  // a cardinal sin; modeled against each package's SOURCE, not its name):
  // - `which`: resolves an executable by stat-ing PATH candidates (via `isexe`) — Fs. Both the async default
  //   `which(cmd)` and `which.sync(cmd)` hit the filesystem; no pure member → whole-module Fs.
  [/^which$/, null, "Fs"],
  // - `@webpod/ps`: process listing/kill — kill/lookup/lookupSync/tree/treeSync ALL spawn the OS via
  //   `exec({...})` (zurk/spawn) — verified in ps.js. Uniform process surface, no pure member → Exec.
  [/^@webpod\/ps$/, null, "Exec"],
  // - `envapi` (a dotenv variant): MIXED — `parse`/`stringify` are pure string transforms; `load`/`loadSafe`/
  //   `config` READ the .env file (`fs.readFileSync`). Member-precise so `parse` never fabricates Fs (the
  //   argon2 curated-κ lesson: model the effectful member, never blanket-grant a mixed package).
  [/^envapi$/, /^(load|loadSafe|config)$/, "Fs"],
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
  // …AND `tmpdir`/`homedir`, which this list read as pure until a cross-engine parity sweep asked why.
  // They are not introspection: node resolves `homedir()` from `$HOME` and `tmpdir()` from
  // `$TMPDIR`/`$TMP`/`$TEMP`, so they are ENVIRONMENT VARIABLE READS behind a convenience name — the
  // rule this line already applies to `userInfo`/`hostname`, and the reason `platform`/`arch` stay out.
  // candor-rust charges the identical operations (`std::env::temp_dir`, `env::var("HOME")`,
  // `env::current_dir`) as Env, so ts was the outlier AND inconsistent with ITSELF: `os.hostname()` was
  // Env while `os.homedir()` was pure. MEASURED 2026-08-18: `deny Env` answered exit 0 over
  // `os.homedir()`. `platform`/`arch`/`cpus` are untouched — they read no variable.
  // …and `networkInterfaces()`, added with the ⟨0.32⟩ core floor rather than left implicitly pure: it
  // reads the host's network configuration (addresses, MACs), which is the same host-identity family as
  // `hostname`. The floor below marks the REST of node:os reviewed-pure, and that is a positive claim —
  // so a member nobody believes is inert must not be swept into it.
  [/^(node:)?os$/, /^(userInfo|hostname|tmpdir|homedir|networkInterfaces)$/, "Env"],
  [/^(argon2|bcrypt|bcryptjs)$/, null, "Rand"],
  // The ORM tier — VERB-PRECISE (the CLASSIFIER discipline: tag the execution boundary, not
  // builders; `createQueryBuilder` is pure, its `getMany`/`execute` is the I/O). Found on the
  // first framework-APP scan: a TypeORM/Nest application — Db-heavy by construction — read zero
  // Db because the ORM resolved into an unlisted package (the JVM's Spring-Data lesson, replayed).
  // The verb set is the QUERY surface PLUS the DataSource lifecycle that performs connection/DDL I/O:
  // `initialize`/`connect` OPEN the pool (a real round-trip to the server), and
  // `synchronize`/`runMigrations`/`undoLastMigration`/`dropDatabase` execute DDL/migration SQL — all Db.
  // (Found dogfooding ukri-tfs: `buildPostgresDataSource` did `new DataSource(o).initialize()` and read
  // PURE — a false all-clear on a fn that opens a database connection.) Still module-gated to typeorm, so
  // these generic-looking verbs only fire on a typeorm-typed receiver; the pure builder heads stay pure.
  [/^(typeorm|@nestjs\/typeorm)$/,
   /^(find|save|remove|softRemove|recover|insert|update|upsert|delete|restore|count|exist|sum|average|minimum|maximum|query|clear|increment|decrement|getMany|getOne|getOneOrFail|getRawMany|getRawOne|getCount|getExists|execute|stream|transaction|initialize|connect|synchronize|runMigrations|undoLastMigration|dropDatabase)/,
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
  // SPEC §1 ⟨0.13⟩ `Llm` model-SDK surface — the curated model-provider clients (Rules.MODEL_SDK_PACKAGES
  // in the java reference). These are SINGLE-PURPOSE: any call into them dispatches a model request, which
  // IS network I/O — so they classify Net here (the whole-module Net machinery: host literals, the masking
  // gate) and the classify site adds `Llm` on top via isModelSdkPackage() (Net is never dropped). NO
  // method-name gating (java parity #1: any call into a model-SDK package is Llm+Net). Sub-path imports
  // (`openai/resources`, `@langchain/core/language_models`) are covered by the `(/|$)` tail. Curated
  // STARTER list — the §7 coverage ledger discloses an uncovered provider package like any other.
  [/^(openai|@anthropic-ai\/sdk|@google\/generative-ai|@aws-sdk\/client-bedrock-runtime|ai|@mistralai\/mistralai|cohere-ai|groq-sdk|ollama|langchain|@langchain\/core)(\/|$)/,
   null, "Net"],
];
// SPEC §1 ⟨0.13⟩ `Llm` model-SDK packages — the curated model-provider clients whose calls refine Net to
// Llm (mirrors Literals.modelHostEffects on the SDK side; matched by the same regex the KAPPA_RULES Net
// entry uses, so the two can never drift). isModelSdkPackage answers "is this resolved module a model
// SDK?" — a call into it is Llm+Net (Net comes from the κ rule above; the classify site adds Llm).
export const MODEL_SDK_RE =
  /^(openai|@anthropic-ai\/sdk|@google\/generative-ai|@aws-sdk\/client-bedrock-runtime|ai|@mistralai\/mistralai|cohere-ai|groq-sdk|ollama|langchain|@langchain\/core)(\/|$)/;
export function isModelSdkPackage(moduleName) {
  return MODEL_SDK_RE.test(moduleName);
}
/// SPEC §2 `fs` — for a call ALREADY classified `Fs`, the read/write direction its verb implies.
/// Returns ["read"], ["write"], ["read","write"], or [] when the verb does not say.
///
/// THE EMPTY CASE IS THE POINT. §2: "when `Fs` is reached but its kind is unknown … the field MUST be
/// omitted rather than guessed. An empty or partial `fs` would be read as a positive claim ('reads but
/// never writes'), which is the §4 trust contract's forbidden direction." So an unrecognised verb
/// contributes nothing and the field stays absent — absence means "kind undetermined", never "read-only".
///
/// A syntactic refinement of an effect candor already proved, NOT a soundness claim: a wrong direction
/// misreports a detail, a wrong EFFECT is the cardinal sin, and those are different failures. Deliberately
/// the same vocabulary and shape as candor-java's `fsKind` and candor-swift's — the surface is spec'd
/// four-way, and three engines inventing three verb tables for one field is how a shared field stops
/// meaning one thing. Node's sync/promise variants are handled by stripping the `Sync` suffix rather than
/// by listing every pair.
export function fsKind(moduleName, member) {
  if (!member) return [];
  const m = member.endsWith("Sync") ? member.slice(0, -4) : member;
  // Reads the source AND writes the destination, in one call.
  if (m === "copyFile" || m === "cp") return ["read", "write"];
  const WRITE = new Set([
    "writeFile", "appendFile", "write", "writev", "mkdir", "mkdtemp", "rmdir", "rm", "unlink",
    "rename", "truncate", "ftruncate", "chmod", "fchmod", "lchmod", "chown", "fchown", "lchown",
    "utimes", "futimes", "lutimes", "symlink", "link", "createWriteStream", "outputFile", "ensureDir",
    "ensureFile", "emptyDir", "remove", "move", "outputJson", "writeJson", "writeJSON",
  ]);
  const READ = new Set([
    "readFile", "readdir", "read", "readv", "stat", "lstat", "fstat", "statfs", "access", "exists",
    "realpath", "readlink", "createReadStream", "opendir", "watch", "watchFile", "readJson",
    "readJSON", "pathExists", "lstatSync",
  ]);
  if (WRITE.has(m)) return ["write"];
  if (READ.has(m)) return ["read"];
  // `open`/`openSync` take a MODE — "r", "w", "a" — so the verb alone does not say. Deliberately no claim
  // rather than a guess at the common case.
  if (m.startsWith("write") || m.startsWith("append")) return ["write"];
  if (m.startsWith("read")) return ["read"];
  return [];
}

export function kappa(moduleName, member) {
  for (const [mre, vre, eff] of KAPPA_RULES) {
    if (mre.test(moduleName) && (!vre || vre.test(member))) return eff;
  }
  return null;
}

// ---- ⟨0.32⟩ THE NODE-CORE FLOOR: reviewed-effect-free surface, and everything else fails closed ----
//
// WHY THIS EXISTS. The κ table is an ALLOWLIST, and the classify site used to read a miss inside node
// core as PURE — written down, at the coverage-ledger site, as "an unlisted builtin (path, util) is
// known-pure, not blind". That is true of `path` and `util` and false of `v8.writeHeapSnapshot`,
// `inspector.open`, `process.dlopen`, `repl.start()` and `new worker_threads.Worker(file)`, every one of
// which reported nothing at all — which under SPEC §2 rule 3 is a positive purity claim, over a heap
// dump, a listening socket, a native-code load and two code-execution boundaries. A limitation written
// as a comment reads as CONSIDERED, which is what stopped it being measured for as long as it stood.
//
// THE SHAPE IS A DENYLIST, for the reason stated at the net cluster: an allowlist under-reports whatever
// you forgot, and "whatever you forgot" is precisely what node adds every six months. This inverts it —
// node core is FINITE and enumerable, each module's export surface was read, and a member that is
// neither classified by κ above nor named here is `Unknown[native:<mod>.<member>]`. The cost of being
// wrong flips with it: forgetting something here now over-charges (visible, complainable) instead of
// under-reporting (silent, and the cardinal sin).
//
// AND IT IS THE HALF THAT NEEDS THE CONTROL. "Unmodelled ⇒ Unknown" is trivially achievable by making
// everything Unknown, which deletes the product — `path.join`, `crypto.createHash().digest()`,
// `util.format`, `new EventEmitter()`, `Buffer.from`, `process.cwd()` are the ordinary furniture of
// every Node program. test.mjs pins them PURE in the same block that pins the misses Unknown.
//
// `[module regex, member regex — null = the whole module]`. Read against the same token κ is read
// against, except that a CONSTRUCTION is asked about by its CLASS NAME rather than the synthesized
// `new`: `new worker_threads.Worker(f)` has to be separable from `new worker_threads.MessageChannel()`,
// and κ's module-wide `new` exemptions are what make that necessary (they are precision decisions about
// construction, not statements that every class in the module is inert).
export const NODE_CORE_REVIEWED = [
  // ── wholly reviewed, effect-free at the call boundary ──
  // Deterministic in-process computation and string manipulation: assert (throws), async_hooks (in-process
  // hook registration), buffer, constants, diagnostics_channel (in-process pub/sub), domain, events, path,
  // perf_hooks (in-process timing), punycode, querystring, string_decoder, url, util/types, zlib.
  // Console/TTY I/O — `console`, `readline`, `tty`: §1 has no Console effect and this engine already
  // suppresses the fabricated `Net` on `process.stdout.write` for the same reason; classifying them here
  // would contradict that decision one door along.
  // `stream` and its submodules: transport plumbing. A stream's effect belongs to the concrete source or
  // sink, and is charged where THAT was constructed (`fs.createReadStream` → Fs) — charging `.pipe()` too
  // would double-count the same open.
  // `timers`: scheduling. §1's `Clock` is a clock READ; arming a timer reads nothing.
  // The typings-layout files — `globals`, `globals.typedarray`, `buffer.buffer`, `index`,
  // `compatibility/*`, `ts5.x/*`, `stream/iter`, `zlib/iter` — are the same surfaces under other file
  // names; `test`/`test/reporters` is the test runner, whose files this engine excludes anyway.
  [/^(node:)?(assert(\/strict)?|async_hooks|buffer|console|constants|diagnostics_channel|domain|events|path(\/(posix|win32))?|perf_hooks|punycode|querystring|readline(\/promises)?|stream(\/(consumers|promises|web|iter))?|string_decoder|timers(\/promises)?|tty|url|util\/types|zlib(\/iter)?)$/, null],
  [/^(buffer\.buffer|globals(\.typedarray)?|index|compatibility\/.*|ts5\.[0-9]+\/.*|test(\/.*)?)$/, null],
  // The Node-supplied web globals. Inert or in-process: AbortController, Blob, console, DOMException,
  // TextEncoder/TextDecoder, EventTarget, `import.meta`, structuredClone/MessageChannel, navigator,
  // performance, ReadableStream/WritableStream, setTimeout, URL/URLSearchParams.
  // `web-globals/fetch` holds `fetch` itself — classified `Net` by the GLOBAL-NAME classifier in scan.mjs
  // (which also captures the host literal), before this floor is consulted; the rest of that file
  // (Request/Response/Headers/FormData) is inert construction. It is listed here so the floor does not
  // stack a second, reasonless `Unknown` on top of a call this engine already answers precisely.
  // `web-globals/storage` is DELIBERATELY ABSENT: Node's `localStorage`/`sessionStorage` persist to a
  // file, so it is not inert and has not been modelled — it fails closed.
  [/^web-globals\/(abortcontroller|blob|console|crypto|domexception|encoding|events|fetch|importmeta|messaging|navigator|performance|streams|timers|url)$/, null],
  // ── mixed modules: the reviewed-pure half, member by member ──
  // node:crypto is deterministic computation plus entropy; κ above takes the entropy (`random*`,
  // `generateKey*`, `generatePrime*`). Written as a denylist of ONE: `setEngine` loads a shared OpenSSL
  // engine library into the process, which is a native-code load, not a hash.
  [/^(node:)?crypto$/, /^(?!setEngine$)/],
  // node:os — the host-identity reads are Env above; the rest is inert introspection
  // (platform/arch/cpus/freemem/uptime/EOL/…).
  [/^(node:)?os$/, null],
  // node:util — everything but `debuglog`/`debug`, which κ takes as Env above.
  [/^(node:)?util$/, null],
  // The net cluster's own carve-outs, verbatim from the κ rule that exempts them, PLUS the classes whose
  // construction that rule proves inert. `new` is the synthesized token; the class names are what a
  // construction is asked about here. `WebSocket` is deliberately absent — it CONNECTS.
  [/^(node:)?(net|dgram|tls|http2?|https)$/,
   /^(new|isIP|isIPv4|isIPv6|getCiphers|createSecureContext|checkServerIdentity|validateHeaderName|validateHeaderValue|setKeepAlive|setNoDelay|ref|unref|address|Agent|Server|Socket|Stream|BlockList|SocketAddress|TLSSocket|SecureContext|IncomingMessage|OutgoingMessage|ServerResponse|ClientRequest|Http2ServerRequest|Http2ServerResponse|METHODS|STATUS_CODES|globalAgent|maxHeaderSize|rootCertificates|convertALPNProtocols|createSecurePair|getDefaultSettings|getPackedSettings|getUnpackedSettings|sensitiveHeaders|constants|getDefaultAutoSelectFamily|setDefaultAutoSelectFamily|getDefaultAutoSelectFamilyAttemptTimeout|setDefaultAutoSelectFamilyAttemptTimeout)$/],
  // node:dns — the same: the κ rule's exemptions plus the inert `Resolver` construction.
  [/^(node:)?dns(\/promises)?$/,
   /^(new|getServers|setServers|getDefaultResultOrder|setDefaultResultOrder|Resolver|promises)$/],
  // node:worker_threads — the message verbs are Ipc above. `Worker` is deliberately ABSENT: `new
  // Worker(file)` loads and runs a file this scan never analysed, which is a boundary, not construction.
  // A spawned Worker's own handle members are in-process: `terminate` stops a THREAD (there is no §1
  // effect for that, and `process.kill` is Exec because it signals another PROCESS, which is a different
  // operation), `ref`/`unref` move it in and out of the event-loop keepalive, and the stream/heap
  // accessors return objects. Found by the corpus round: eslint's real `worker.terminate()` came back
  // Unknown beside the genuine `new Worker` finding, which buries the one that matters under the one
  // that does not.
  [/^(node:)?worker_threads$/,
   /^(new|isMainThread|threadId|resourceLimits|workerData|parentPort|SHARE_ENV|MessagePort|MessageChannel|BroadcastChannel|markAsUncloneable|markAsUntransferable|isMarkedAsUntransferable|moveMessagePortToContext|setEnvironmentData|getEnvironmentData|terminate|ref|unref|performance|getHeapSnapshot|stdin|stdout|stderr)$/],
  // node:cluster — `fork`/`disconnect` are the Ipc boundary; the rest is configuration and state.
  [/^(node:)?cluster$/,
   /^(new|isWorker|isMaster|isPrimary|workers|settings|schedulingPolicy|SCHED_NONE|SCHED_RR|setupPrimary|setupMaster|Worker)$/],
  // node:vm — the four evaluation verbs are Unknown above. `new vm.Script(code)` only COMPILES; the
  // execution is a later `runInContext`, which κ catches. `createContext`/`isContext`/`measureMemory`
  // touch nothing outside the process.
  [/^(node:)?vm$/, /^(new|createContext|createScript|isContext|measureMemory|constants|Script)$/],
  // node:v8 — the disk-writing verbs are Fs above. What remains is in-process: the structured-clone
  // serializer, the heap STATISTICS (numbers, not files), `getHeapSnapshot` (returns a Readable; the
  // caller decides where it goes), and `queryObjects`. `setFlagsFromString`, `promiseHooks`,
  // `startupSnapshot`, `setHeapSnapshotNearHeapLimit` and `GCProfiler` are absent on purpose.
  [/^(node:)?v8$/,
   /^(new|cachedDataVersionTag|getHeapSnapshot|getHeapStatistics|getHeapSpaceStatistics|getHeapCodeStatistics|serialize|deserialize|queryObjects|Serializer|Deserializer|DefaultSerializer|DefaultDeserializer)$/],
  // node:inspector — `open` is Net above. `url`/`close`/`waitForDebugger` touch no new resource. The
  // `Session` surface (`connect`, `post`) drives the V8 inspector protocol, which can write heap
  // snapshots and start profilers, so it is absent and fails closed — as is `inspector.generated`, the
  // protocol-domain typings its `post` resolves through.
  [/^(node:)?inspector(\/promises)?$/, /^(new|url|close|waitForDebugger)$/],
  // node:module — the compile cache is Fs above. `createRequire` MINTS a require function (inert; the
  // load happens at the returned function's call, which resolves back into this module under a name
  // that is not listed, so it fails closed). `register`, `runMain` and the `_`-prefixed loader internals
  // are absent on purpose: they run module code.
  // …and `require` itself, plus `""` — the token an interface CALL SIGNATURE resolves to, which is how
  // `NodeRequire` declares `require(id)`. That is not a concession: scan.mjs already decided this, in
  // the `require(<non-literal>)` arm, and decided it the other way for the case that matters — a
  // LITERAL `require('./x')` is a static, resolvable load whose module TypeScript resolves and whose
  // top-level effects this scan attributes to the loaded file's own `<module>` unit, while a DYNAMIC
  // `require(v)` already discloses `Unknown[reflect:require]`. MEASURED when the floor first ran without
  // this: 410 findings across 51 of 85 corpus packages, every one of them an ordinary CJS `require` of a
  // module the engine had in fact read. An `Unknown` over evidence the engine holds is not caution, it
  // is a second answer contradicting the first.
  [/^(node:)?module$/,
   /^(|new|require|isBuiltin|builtinModules|constants|createRequire|syncBuiltinESMExports|findSourceMap|SourceMap|Module|wrap|globalPaths|stripTypeScriptTypes)$/],
  // `process` — the introspection, scheduling and stream surface. `dlopen` (loads a native addon),
  // `binding`/`_linkedBinding` (internal C++ bindings), the `set*id`/`setgroups`/`initgroups` privilege
  // verbs and the `_`-prefixed internals are absent on purpose. `""` is the token a CALL SIGNATURE on an
  // interface resolves to — `process.memoryUsage()` is declared that way — and it is reviewed pure here
  // rather than left to fail closed, because the alternative is an `Unknown` on a call that returns a
  // number.
  [/^(node:)?process$/,
  // `bigint` is `process.hrtime.bigint()` — a monotonic clock READ, declared on the `HRTime` interface
  // in the same file, so it arrives here under its own bare name. Pure for the reason `Date.now()` is
  // pure in this engine: nothing charges `Clock` for reading a timer, and charging one spelling of it
  // and not the other is the inconsistency the `os.homedir`/`os.hostname` fix was about.
   /^(|new|version|versions|arch|platform|release|config|features|moduleLoadList|uptime|getActiveResourcesInfo|cpuUsage|resourceUsage|memoryUsage|constrainedMemory|availableMemory|exit|exitCode|abort|finalization|hrtime|bigint|allowedNodeEnvironmentFlags|assert|emitWarning|nextTick|sourceMapsEnabled|setSourceMapsEnabled|getBuiltinModule|hasUncaughtExceptionCaptureCallback|setUncaughtExceptionCaptureCallback|cwd|env|argv|argv0|execArgv|execPath|pid|ppid|title|debugPort|stdout|stdin|stderr|openStdin|ref|unref|getReport|report|throwDeprecation|traceDeprecation|noDeprecation)$/],
  // The EventEmitter surface, wherever a core module RE-DECLARES it for typed events instead of
  // inheriting it. `process.on("exit", …)` resolves to an overload declared in `process.d.ts`, not to
  // `events.d.ts`, so the module-wide `events` entry above never saw it and an inert listener
  // registration read Unknown (measured on eslint, twice). Registering, removing or counting listeners
  // reaches nothing outside the process; `emit` runs local handlers this engine analyses lexically.
  // (Only the modules whose κ rule can return null. The net cluster and dns classify every non-exempt
  // member `Net`, including these, so listing them there would state something this table does not mean.)
  [/^(node:)?(process|worker_threads|cluster|inspector(\/promises)?|v8|module|vm|repl|trace_events|wasi)$/,
   /^(on|once|off|addListener|prependListener|prependOnceListener|removeListener|removeAllListeners|emit|listeners|rawListeners|listenerCount|eventNames|setMaxListeners|getMaxListeners)$/],
];

/**
 * ⟨0.32⟩ Is this node-core member one κ does not classify AND nobody has reviewed effect-free?
 *
 * The caller has already asked `kappa()` and got null, and has already established that the declaration
 * came from `@types/node` — the check is on the FILE, never on the module name, because an npm package
 * may legitimately be called `util`, `path` or `process` (the browserify shims are) and a name-keyed
 * test would hand those packages node's review by accident.
 *
 * True ⇒ the call site charges `Unknown` with a `native:` reason. That is §4's definition verbatim: a
 * boundary to code this engine cannot analyse, which is the class java spells `native:<method>` and rust
 * `native:extern fn`.
 */
export function nodeCoreUnreviewed(moduleName, member) {
  const m = member ?? "";
  for (const [mre, vre] of NODE_CORE_REVIEWED) {
    if (mre.test(moduleName) && (!vre || vre.test(m))) return false;
  }
  return true;
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
// SPEC §1 ⟨0.13⟩ `Llm` HOST-LITERAL refinement — the known machine-learning model-provider hosts. A
// statically-known Net request to one of these classifies `Llm` IN ADDITION to `Net` (Net is never
// dropped — a model call IS network I/O), just as a jdbc URL classifies `Db`. The four reference engines
// share this table VERBATIM (java Literals.MODEL_HOSTS). Matched by host, case-insensitive; a SUBDOMAIN
// of a listed host counts. Curated STARTER set; the §7 coverage ledger discloses an uncovered provider.
export const MODEL_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.cohere.ai", "api.cohere.com",
  "api.groq.com",
  "api.together.xyz",
  "api.perplexity.ai",
  "openrouter.ai",
]);
// Whether an endpoint HOST literal is a known model provider (case-insensitive; a subdomain of a
// MODEL_HOSTS entry counts). Strips a `:port` suffix first. Two special forms carry their own rule (java
// Literals.isModelHost parity): any host whose port is 11434 is a local Ollama endpoint
// (`localhost:11434`, `127.0.0.1:11434`); and an AWS Bedrock runtime host `*.bedrock*.amazonaws.com`
// (host CONTAINS "bedrock" AND ends `.amazonaws.com` — java parity #4).
// Ollama is a LOCAL endpoint: :11434 → Llm ONLY on a loopback host (max-review r3 parity fix — "any host
// on :11434" fabricated Llm on an unrelated internal service). Bedrock matches the EXACT model-inference
// service label, not the substring "bedrock" (which caught `bedrock-backups.s3.amazonaws.com`, an S3 bucket).
const OLLAMA_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BEDROCK_RUNTIME_LABELS = new Set(["bedrock-runtime", "bedrock-agent-runtime"]);
export function isModelHost(hostLiteral) {
  if (hostLiteral == null) return false;
  // hostPart: strip a trailing :port (keep a bracketed/unbracketed IPv6 intact, like policy.hostPart);
  // also recover the port for the Ollama loopback check.
  let host = hostLiteral, port = null;
  if (host.startsWith("[")) { const e = host.indexOf("]"); if (e >= 0) { const rest = host.slice(e + 1); if (rest.startsWith(":")) port = rest.slice(1); host = host.slice(1, e); } }
  else if ((host.match(/:/g) ?? []).length === 1) { const p = host.split(":"); host = p[0]; port = p[1]; }
  host = host.toLowerCase();
  if (port === "11434") return OLLAMA_LOCAL_HOSTS.has(host);   // Ollama: loopback only
  if (MODEL_HOSTS.has(host)) return true;
  for (const m of MODEL_HOSTS) if (host.endsWith("." + m)) return true; // a subdomain counts
  // AWS Bedrock runtime: the FIRST label is the model-inference service (bedrock-runtime.<region>.amazonaws.com).
  if (host.endsWith(".amazonaws.com") && BEDROCK_RUNTIME_LABELS.has(host.split(".")[0])) return true;
  return false;
}
// The effects a model-host literal implies: ["Llm"] for a known model host, else []. Shared with the
// sibling engines like commandHeadEffects; `Net` is added by the caller (the host was captured on a
// Net-bearing call), so this returns ONLY the refinement.
export function modelHostEffects(hostLiteral) {
  return isModelHost(hostLiteral) ? ["Llm"] : [];
}
// ⟨0.20⟩ Curated telemetry / analytics / APM hosts — the `Net` destination-class `known-telemetry` set
// (NET-DESTINATION-CLASS-DESIGN.md), shared VERBATIM with the sibling engines (java Literals.TELEMETRY_HOSTS
// / rust TELEMETRY_HOSTS), like MODEL_HOSTS. A benign observability endpoint. Matched by host,
// case-insensitive; a SUBDOMAIN of a listed host counts. Tight, high-precision STARTER set — mis-including
// an exfil-capable host would under-gate `deny Net[unknown-host]`.
export const TELEMETRY_HOSTS = new Set([
  "sentry.io",
  "bugsnag.com",
  "rollbar.com",
  "segment.io", "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "google-analytics.com", "analytics.google.com",
  "datadoghq.com", "datadoghq.eu",
  "newrelic.com", "nr-data.net",
  "honeycomb.io",
  "logtail.com",
  // ⟨0.20.1⟩ corpus-grown (a real-repo dogfood): more single-purpose analytics / session-replay / RUM
  // providers — vendor-specific product domains only (no general-purpose host), so no under-gate risk.
  "posthog.com", "plausible.io", "usefathom.com", "heapanalytics.com",
  "fullstory.com", "hotjar.com", "logrocket.com",
  "cloudflareinsights.com",
]);
// Normalize a `host[:port]` literal to a bare lowercase hostname (the MODEL_HOSTS stripping), for the
// destination-class membership tests.
function normHost(hostLiteral) {
  if (hostLiteral == null) return "";
  let host = hostLiteral;
  if (host.startsWith("[")) { const e = host.indexOf("]"); if (e >= 0) host = host.slice(1, e); }
  else if ((host.match(/:/g) ?? []).length === 1) host = host.split(":")[0];
  return host.toLowerCase();
}
// Subdomain-aware membership of `hostLiteral` in a host `set` (mirrors java Literals.hostInSet).
function hostInSet(hostLiteral, set) {
  const host = normHost(hostLiteral);
  if (set.has(host)) return true;
  for (const e of set) if (host.endsWith("." + e)) return true;
  return false;
}
export function isTelemetryHost(hostLiteral) { return hostInSet(hostLiteral, TELEMETRY_HOSTS); }
// ⟨0.20⟩ The `Net` DESTINATION CLASS of a host literal (NET-DESTINATION-CLASS-DESIGN.md): `known-telemetry`
// (curated), `known-partner` (config `net-partner` OR a model host — a declared-ish external API), else
// `unknown-host` — the HONEST default (candor makes no claim; the security gate bites this). `partners` is a
// per-project Set (config-declared). Never fabricated: a null/unresolved host is unknown-host. Mirrors java
// Literals.netDestClass.
export function netDestClass(hostLiteral, partners) {
  if (isTelemetryHost(hostLiteral)) return "known-telemetry";
  if (partnerFor(hostLiteral, partners) !== null || isModelHost(hostLiteral)) return "known-partner";
  return "unknown-host";
}
/**
 * ⟨0.31⟩ WHICH declared partner a host matched, or null — the SAME match `netDestClass` decides on,
 * extracted so the DISCLOSURE and the DECISION cannot use different rules.
 *
 * That is not a stylistic preference. The first attempt at the `net-partner` disclosure re-implemented
 * this match and normalised differently from the classifier — `partner.example:443` never equalled the
 * declared `partner.example` — so the disclosure came back SILENTLY EMPTY on every real run while the
 * verdict it was reporting on had flipped. A disclosure normalised differently from the decision it
 * reports can only be wrong, and the way to make that impossible is one function with two callers.
 */
export function partnerFor(hostLiteral, partners) {
  if (!partners || !partners.size) return null;
  const host = normHost(hostLiteral);
  if (partners.has(host)) return host;
  for (const p of partners) if (host.endsWith("." + p)) return p;
  return null;
}
// ⟨0.20⟩ The closed `Net` destination-class vocabulary, for the `deny Net[<dest…>]` policy filter.
export const NET_DEST_CLASSES = ["known-telemetry", "known-partner", "unknown-host"];
// ⟨0.20⟩ The `Net` destination classes an fn reaches — the SINGLE derivation shared by the report's
// `netClass` field (scan.mjs) and the gate (policy.mjs), so they can never drift: an exact host-literal
// match (netDestClass) for the visible (transitive) hosts, plus the fail-closed `unknown-host` when the Net
// surface is masked (`netIncomplete`) OR carries no visible host (a runtime endpoint). `hostsArr` is an
// array; call only for an fn with Net. Returns sorted. Mirrors java Policy.netClassesOf / rust net_classes_of.
export function netClassesOf(hostsArr, netIncomplete, partners) {
  const classes = new Set(hostsArr.map((h) => netDestClass(h, partners)));
  if (netIncomplete || hostsArr.length === 0) classes.add("unknown-host");
  return [...classes].sort();
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
