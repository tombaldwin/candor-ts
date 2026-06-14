#!/usr/bin/env node
/**
 * Fabrication probe for candor-ts — a precision regression guard (sibling of the soundness fuzzer
 * fuzz.mjs, and the family probes soundness/fabrication_probe.{py} in candor-rust / candor-java).
 *
 * candor's CARDINAL SIN is FABRICATION: classifying a PURE call as effectful. Several node builtins
 * are classified at WHOLE-MODULE level in scan.mjs's κ table (`[moduleRegex, null, effect]` — the
 * `null` member-matcher paints one effect onto EVERY member). That over-paints the module's
 * provably-pure members: inert CONSTRUCTION (`new http.Agent()` is a connection-pool config object;
 * `new http.Server()` / `new net.Socket()` open nothing until a later `.listen()`/`.connect()`),
 * pure constants (`http.STATUS_CODES`), and config accessors (`https.globalAgent`) all perform no
 * I/O. This probe pins the precise PURE-vs-EFFECTFUL split so the rule can never silently regress
 * to whole-module.
 *
 * Two directions, both guarded:
 *   PURE — a member that is PROVABLY free of I/O (inert construction, a pure constant/accessor).
 *          candor MUST report it pure (omitted from `functions` / empty `inferred`). An effect here
 *          => FABRICATION (the cardinal sin).
 *   CTRL — a genuinely-effectful member (the request/connect/listen/spawn surface, an I/O verb).
 *          candor MUST still report the effect. Pure/omitted here => a LOST CONTROL (an
 *          under-report), the OTHER failure direction — so the fix can only REMOVE fabrication,
 *          never introduce a blind spot.
 *
 * candor-ts uses the TS checker, so each fixture imports the builtin (`import * as http from
 * "node:http"`) and the import resolves against @types/node. The fixture dir needs a package.json.
 * A function inferred effect-free is OMITTED from `functions`, so "absent" == pure.
 *
 * DISCIPLINE (why this probe has no false alarms): every PURE call is a member whose semantics are
 * verified pure (rationale in the comment beside it); when in doubt a member is left OUT (asserted
 * neither pure nor effectful) — never asserted pure on a guess. Each fixture body is a SINGLE bare
 * call/construction so the assertion tests the κ rule and nothing else.
 *
 * Run: node fabrication_probe.mjs        # generate fixtures, run scan, gate (exit non-zero on any
 *                                          fabrication or lost control)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Each case: { id, imports, recv, pure: [[stmt, why], …], ctrl: [[stmt, why], …], effect }
//   imports : the `import` lines the fixture needs (so the checker resolves the builtin's members)
//   recv    : a function PARAMETER naming an instance WITHOUT performing the effect (so the only
//             classified call is the probe call); "" => only module-level (no receiver) calls.
//   pure    : each [stmt, why] MUST classify pure (gets its own `pure<i>` fn)
//   ctrl    : each [stmt, why] MUST classify <effect> (gets its own `ctrl<i>` fn)
//   {r} in a stmt is replaced with the receiver name.
const CASES = [
  // ── net: connect/createConnection/createServer + socket.connect/server.listen do I/O; constructing
  //         a Socket/Server is inert (opens nothing until connect/listen); isIP is a pure validator ──
  {
    id: "net",
    imports: [`import * as net from "node:net";`],
    recv: "s: net.Socket",
    pure: [
      [`const x = new net.Socket(); void x;`, "inert socket object — no fd, no connect until .connect()"],
      [`const x = new net.Server(); void x;`, "inert server object — binds nothing until .listen()"],
      // The pure VALIDATORS: isIP/isIPv4/isIPv6 parse a string and return 0/4/6 (or a bool) — no socket,
      // no fd, no syscall. The whole-module Net rule once FABRICATED Net here (caught by a node-fetch
      // sweep: its trustworthy URL predicates call isIP and inherited a phantom Net). These three controls
      // are the missing assertions that let the hole ship silently — they pin the validators pure.
      [`const x = net.isIP("1.2.3.4"); void x;`, "pure string validator — returns 0/4/6, no socket/fd/syscall"],
      [`const x = net.isIPv4("1.2.3.4"); void x;`, "pure string validator — returns a boolean, no I/O"],
      [`const x = net.isIPv6("::1"); void x;`, "pure string validator — returns a boolean, no I/O"],
    ],
    ctrl: [
      [`const x = net.connect(80, "h"); void x;`, "opens a TCP connection (connect syscall)"],
      [`const x = net.createConnection(80, "h"); void x;`, "opens a TCP connection"],
      [`const x = net.createServer(); void x;`, "creates+arms a listening server"],
      [`const x = {r}.connect(80, "h"); void x;`, "connects the socket — the connect syscall"],
    ],
    effect: "Net",
  },
  // ── process.stdout/stderr/stdin: typed `tty.WriteStream` which EXTENDS `net.Socket`, so `.write()`
  //    resolves to `net.Socket.write` and the whole-module Net rule FABRICATED Net (a node-pkg sweep
  //    caught nanoid/commander/bunyan/pino over-claiming Net purely from a console write). A console
  //    write to fd 0/1/2 is NOT network — no §1 effect — so it MUST be pure. The ctrl proves a REAL
  //    net.Socket.write still classifies Net (only the three std streams are freed). ──
  {
    id: "process-streams",
    imports: [`import * as net from "node:net";`],
    recv: "s: net.Socket",
    pure: [
      [`process.stdout.write("x");`, "console write to fd 1 — TTY I/O, not network"],
      [`process.stderr.write("x");`, "console write to fd 2 — TTY I/O, not network"],
      [`const x = process.stdout.write("x"); void x;`, "stdout write result — still pure console I/O"],
      // CHAINED calls: `.on`/`.write` return the stream, so the chain's receiver is still the std stream.
      // The exact-string suppression missed this (terser's `process.stdin.on().on()` fabricated Net).
      [`process.stdin.on("data", (_c) => {});`, "stdin .on — console input listener, not a socket"],
      [`process.stdin.on("data", (_c) => {}).on("end", () => {});`, "CHAINED .on().on() on stdin — still console I/O"],
    ],
    ctrl: [
      [`{r}.write("x");`, "write to a REAL constructed socket — genuine network egress"],
      [`{r}.on("data", (_d) => {});`, "a REAL socket .on — genuine network listener"],
    ],
    effect: "Net",
  },
  // ── http: request/get issue the HTTP request; new Agent()/new Server() are inert config objects.
  //         (STATUS_CODES/METHODS/maxHeaderSize/globalAgent are property READS — pure, never reach κ;
  //         this case proves construction, the only callable that fabricated.) ──
  {
    id: "http",
    imports: [`import * as http from "node:http";`],
    recv: "srv: http.Server",
    pure: [
      [`const x = new http.Agent(); void x;`, "connection-pool CONFIG object — no I/O until a request uses it"],
      [`const x = new http.Server(); void x;`, "inert server — listens to nothing until .listen()"],
    ],
    ctrl: [
      [`const x = http.request("http://h/"); void x;`, "dispatches an HTTP request over the network"],
      [`const x = http.get("http://h/"); void x;`, "dispatches an HTTP GET over the network"],
      [`const x = {r}.listen(80); void x;`, "binds + listens on the port — the listen syscall"],
      // The CONNECTING-CTOR control: unlike Agent/Server, `new http.ClientRequest(url)` performs the
      // network I/O ON CONSTRUCTION (it is what http.request() returns and dispatches). The probe
      // once had ONLY inert-ctor PURE cases here, so the blanket `new`-exemption that converted this
      // real Net source into pure regressed SILENTLY. This control pins that a connecting ctor stays Net.
      [`const x = new http.ClientRequest("http://h/"); void x;`, "performs the HTTP request on construction (what http.request() returns)"],
    ],
    effect: "Net",
  },
  // ── https: request/get over TLS; globalAgent is a config accessor (a property read — pure). ──
  {
    id: "https",
    imports: [`import * as https from "node:https";`],
    recv: "",
    pure: [
      [`const x = new https.Agent(); void x;`, "inert TLS connection-pool config — no I/O until used"],
      [`const x = new https.Server(); void x;`, "inert server — listens to nothing until .listen()"],
    ],
    ctrl: [
      [`const x = https.request("https://h/"); void x;`, "dispatches an HTTPS request over the network"],
      [`const x = https.get("https://h/"); void x;`, "dispatches an HTTPS GET over the network"],
    ],
    effect: "Net",
  },
  // ── tls: connect/createServer do I/O; the cluster's constructors are inert. ──
  {
    id: "tls",
    imports: [`import * as tls from "node:tls";`],
    recv: "",
    pure: [
      [`const x = new tls.TLSSocket(undefined as any); void x;`, "wraps a stream — no handshake until connect/data"],
    ],
    ctrl: [
      [`const x = tls.connect(443, "h"); void x;`, "opens a TLS connection — connect + handshake"],
      [`const x = tls.createServer(); void x;`, "creates+arms a TLS server"],
    ],
    effect: "Net",
  },
  // ── dgram: createSocket builds + the UDP socket object that performs sends/binds. createSocket is
  //          the documented entry; treated as the effectful surface (it returns a live socket). ──
  {
    id: "dgram",
    imports: [`import * as dgram from "node:dgram";`],
    recv: "",
    pure: [],
    ctrl: [
      [`const x = dgram.createSocket("udp4"); void x;`, "creates a UDP socket (the I/O entry point)"],
    ],
    effect: "Net",
  },
  // ── http2: connect/createServer do I/O; new Http2Server() / the message objects are inert. ──
  {
    id: "http2",
    imports: [`import * as http2 from "node:http2";`],
    recv: "",
    pure: [
      [`const x = new http2.Http2ServerResponse(undefined as any); void x;`, "an inert response shell — writes nothing on construction"],
    ],
    ctrl: [
      [`const x = http2.connect("http://h/"); void x;`, "opens an HTTP/2 session over the network"],
      [`const x = http2.createServer(); void x;`, "creates+arms an HTTP/2 server"],
    ],
    effect: "Net",
  },
  // ── child_process: spawn/exec run a program; ChildProcess construction is not a public pure ctor,
  //   so this case is control-only (asserting a pure ctor here would be a guess). ──
  {
    id: "child_process",
    imports: [`import * as cp from "node:child_process";`],
    recv: "",
    pure: [],
    ctrl: [
      [`const x = cp.spawn("echo"); void x;`, "spawns a child process"],
      [`try { cp.execSync("true"); } catch {}`, "runs a program synchronously"],
    ],
    effect: "Exec",
  },
  // ── fs: read/write/stat touch the disk; the whole-module rule is intentionally broad here (fs has
  //   no inert-construction surface candor models), so this is control-only — its presence proves the
  //   probe's CTRL direction holds for the Fs cluster too (no over-narrowing crept in). ──
  {
    id: "fs",
    imports: [`import * as fsm from "node:fs";`],
    recv: "",
    pure: [],
    ctrl: [
      [`const x = fsm.readFileSync("/etc/hosts"); void x;`, "reads a file from disk"],
      [`fsm.writeFileSync("/tmp/x", "y");`, "writes a file to disk"],
    ],
    effect: "Fs",
  },
  // ── dns: lookup/resolve query the resolver (Net). Control-only — dns has no pure-construction
  //   surface; this guards that the Net classification reaches dns at all. (dns is NOT in κ today;
  //   if it ever lands as a whole-module Net rule, the pure direction can be added here.) ──
  {
    id: "dns",
    imports: [`import * as dns from "node:dns";`],
    recv: "",
    pure: [],
    // dns is not curated in κ, so these are EXPECTED to be Unknown/absent today — declaring them
    // controls would be a lost-control false alarm. Left empty on purpose (documented), so the case
    // is a no-op placeholder making the intent explicit rather than a silent omission.
    ctrl: [],
    effect: "Net",
  },
];

function emitFixture(c) {
  const lines = [
    "// GENERATED by fabrication_probe.mjs — do not edit.",
    "/* eslint-disable */",
    ...c.imports,
  ];
  const meta = {}; // fnName -> { kind, effect, stmt, why }
  const rname = c.recv ? c.recv.split(":", 1)[0].trim() : "";
  for (const [kind, calls] of [["pure", c.pure], ["ctrl", c.ctrl]]) {
    calls.forEach(([stmt, why], i) => {
      const name = `${kind}${i}`;
      const usesRecv = stmt.includes("{r}");
      const body = stmt.replaceAll("{r}", rname);
      const params = usesRecv ? c.recv : "";
      meta[`f.${name}`] = { kind, effect: c.effect, stmt: body, why };
      lines.push(`export function ${name}(${params}): void { ${body} }`);
    });
  }
  return { src: lines.join("\n") + "\n", meta };
}

function runCase(c, work) {
  const { src, meta } = emitFixture(c);
  const dir = path.join(work, c.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `probe_${c.id}`, version: "0.0.0", private: true }) + "\n");
  fs.writeFileSync(path.join(dir, "f.ts"), src);
  const out = path.join(dir, "report");
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), dir, "--out", out], { encoding: "utf8" });
  const jsonPath = `${out}.json`;
  if (!fs.existsSync(jsonPath)) {
    return { failures: [`SCAN FAILED for ${c.id}: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`], checked: 0 };
  }
  const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const inferred = new Map(report.functions.map((e) => [e.fn, e.inferred ?? []]));
  const failures = [];
  let checked = 0;
  for (const [fn, m] of Object.entries(meta)) {
    checked++;
    const inf = inferred.get(fn); // undefined => omitted => candor judged it pure
    if (m.kind === "pure") {
      if (inf && inf.length)
        failures.push(`FABRICATION ${c.id}::${fn} [${m.stmt}] -> ${JSON.stringify(inf)}  (provably pure: ${m.why})`);
    } else {
      if (!inf || !inf.includes(m.effect))
        failures.push(`LOST CONTROL ${c.id}::${fn} [${m.stmt}] -> ${inf ? JSON.stringify(inf) : "pure/omitted"}  (must report ${m.effect}: ${m.why})`);
    }
  }
  return { failures, checked };
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "candor-ts-fab-"));
  const allFailures = [];
  let total = 0;
  try {
    for (const c of CASES) {
      const { failures, checked } = runCase(c, work);
      total += checked;
      allFailures.push(...failures);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`fabrication-probe: ${total} probe functions checked across ${CASES.length} builtins`);
  if (allFailures.length) {
    console.log(`fabrication-probe: ${allFailures.length} FAILURE(S):`);
    for (const f of allFailures) console.log("  " + f);
    process.exit(1);
  }
  console.log("fabrication-probe: OK — no fabrication, no lost control");
}

main();
