// SPEC §2 `switches` / §3.4 / §3.3 cause (e) ⟨0.42⟩ (SOUNDNESS R1634), end to end through the real CLIs. Conformance PART 109
// pins the cross-engine cells for ONE switch (`CANDOR_CT2_OFF`); this file pins what that part cannot reach for this
// engine: all three result-moving switches, the lazy-read rule, a malformed `switches`, the chained advisory (PART 109 has
// no ts chained arm), and the advisory verbs. Every cell has its control, because a refusal test with no unset arm is vacuous.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, "scan.mjs"), QUERY = path.join(HERE, "query.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "candor-switches-"));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

// a fixture on which CANDOR_CT2_OFF demonstrably moves a result (PART 109's `live` cell, same source)
const SRC = `import * as fs from "fs";
export interface G2 { readonly g: number; }
export class GC2 implements G2 { get g(): number { fs.writeFileSync("/tmp/candor-switches-never-run", "y"); return 1; } }
export function destrIface(x: G2) { const { g } = x; return g; }
`;
const proj = path.join(ROOT, "proj");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.writeFileSync(path.join(proj, "package.json"), '{"name":"switchesfx","version":"1.0.0"}');
fs.writeFileSync(path.join(proj, "src", "a.ts"), SRC);
const POLICY = path.join(ROOT, "p.candor");
fs.writeFileSync(POLICY, "deny Fs src.a.destrIface\n");

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CANDOR_")));
const run = (script, args, extra = {}) => {
  const r = spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...cleanEnv(), ...extra }, cwd: ROOT });
  return { rc: r.status, out: r.stdout, err: r.stderr };
};
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
let n = 0;
const scanReport = (extra = {}) => { const p = path.join(ROOT, `r${n++}`); const r = run(SCAN, [proj, "--out", p], extra); return { ...r, p, doc: fs.existsSync(`${p}.json`) ? json(`${p}.json`) : null }; };
const scanGate = (extra = {}) => {
  const p = path.join(ROOT, `g${n++}`), gj = `${p}.gate.json`;
  const r = run(SCAN, [proj, "--out", p, "--policy", POLICY, "--gate-json", gj], extra);
  return { ...r, p, doc: fs.existsSync(`${p}.json`) ? json(`${p}.json`) : null, gdoc: fs.existsSync(gj) ? json(gj) : null };
};

test("control: no switch set -> no `switches` key, the policy fires (exit 1), no refusal", () => {
  const r = scanGate();
  assert.equal("switches" in r.doc, false);
  assert.equal(r.rc, 1);
  assert.equal(r.gdoc.refused, undefined);
  assert.ok(r.gdoc.violations.length > 0);
});

test("CT2_OFF: the report names it, the gate refuses at exit 2, the report is still written, a violation does not dominate", () => {
  const r = scanGate({ CANDOR_CT2_OFF: "1" });
  assert.deepEqual(r.doc.switches, ["CANDOR_CT2_OFF"]);
  assert.equal(r.doc.candor.spec, scanReport().doc.candor.spec, "spec is not changed (§3.4 (b))");
  assert.equal(r.rc, 2);
  assert.equal(r.gdoc.ok, false); assert.equal(r.gdoc.refused, true);
  assert.equal("violations" in r.gdoc, false);
  assert.deepEqual(r.gdoc.switches, ["CANDOR_CT2_OFF"]);
  assert.match(r.gdoc.reason, /CANDOR_CT2_OFF/);
});

test("CT_ORACLE_OFF is registered the same way", () => {
  const r = scanReport({ CANDOR_CT_ORACLE_OFF: "1" });
  assert.deepEqual(r.doc.switches, ["CANDOR_CT_ORACLE_OFF"]);
  assert.equal(scanGate({ CANDOR_CT_ORACLE_OFF: "1" }).rc, 2);
});

test("CT_SITE_FALLBACK is SET only when its value selects a branch (A or B); any other value is the unset branch", () => {
  for (const v of ["A", "B"]) assert.deepEqual(scanReport({ CANDOR_CT_SITE_FALLBACK: v }).doc.switches, ["CANDOR_CT_SITE_FALLBACK"], v);
  for (const v of ["", "x", "0"]) assert.equal("switches" in scanReport({ CANDOR_CT_SITE_FALLBACK: v }).doc, false, `value ${JSON.stringify(v)}`);
});

test("two switches: names sorted by code point, each once", () => {
  const r = scanReport({ CANDOR_CT_ORACLE_OFF: "1", CANDOR_CT2_OFF: "1", CANDOR_CT_SITE_FALLBACK: "A" });
  assert.deepEqual(r.doc.switches, ["CANDOR_CT2_OFF", "CANDOR_CT_ORACLE_OFF", "CANDOR_CT_SITE_FALLBACK"]);
});

test("diagnostics and unconsulted CANDOR_ variables are NOT switches (trace reads record nothing)", () => {
  const r = scanReport({ CANDOR_R519_REACH: "1", CANDOR_HOF_REACH: "1", CANDOR_R0_OFF: "1", CANDOR_CT_REACH: "1" });
  assert.equal("switches" in r.doc, false);
  assert.equal(scanGate({ CANDOR_R519_REACH: "1" }).rc, 1);
});

test("`gate --report`: a switched report refuses (exit 2, refusal doc naming it); a clean report under a scan-time switch in the GATE's environment does not (no eager reads)", () => {
  const sw = scanReport({ CANDOR_CT2_OFF: "1" }), clean = scanReport();
  const gj = path.join(ROOT, "gr.json");
  let r = run(QUERY, ["gate", "--report", sw.p, "--policy", POLICY, "--gate-json", gj]);
  assert.equal(r.rc, 2);
  assert.deepEqual(json(gj), { spec: json(gj).spec, ok: false, refused: true, reason: json(gj).reason, switches: ["CANDOR_CT2_OFF"] });
  r = run(QUERY, ["gate", "--report", clean.p, "--policy", POLICY, "--gate-json", gj], { CANDOR_CT2_OFF: "1" });
  assert.equal(r.rc, 1, "an evaluator that ran no analysis consulted no analysis switch");
  assert.equal(json(gj).refused, undefined);
});

test("the two routes refuse with the SAME document (§3.1 byte-equality over a switched scan)", () => {
  const s = scanGate({ CANDOR_CT2_OFF: "1" });
  const gj = path.join(ROOT, "eq.json");
  run(QUERY, ["gate", "--report", s.p, "--policy", POLICY, "--gate-json", gj]);
  assert.deepEqual(json(gj), s.gdoc);
});

test("a malformed `switches` is corrupt input (refuse), never coerced to 'none'", () => {
  const clean = scanReport();
  for (const bad of ["CANDOR_CT2_OFF", 7, [1], [""], { a: 1 }]) {
    const p = path.join(ROOT, `bad${n++}`);
    fs.writeFileSync(`${p}.json`, JSON.stringify({ ...clean.doc, switches: bad }));
    fs.copyFileSync(`${clean.p}.callgraph.json`, `${p}.callgraph.json`);
    assert.equal(run(QUERY, ["gate", "--report", p, "--policy", POLICY]).rc, 2, JSON.stringify(bad));
  }
});

test("advisory verbs: `unverified` refuses over a switched report (and not over a clean one)", () => {
  const sw = scanReport({ CANDOR_CT2_OFF: "1" }), clean = scanReport();
  assert.notEqual(run(QUERY, ["unverified", "--report", clean.p, "--policy", POLICY]).rc, 2);
  const r = run(QUERY, ["unverified", "--report", sw.p, "--policy", POLICY]);
  assert.equal(r.rc, 2);
  assert.deepEqual(JSON.parse(r.out).switches, ["CANDOR_CT2_OFF"]);
  assert.equal(run(QUERY, ["fix-gate", "--report", sw.p, "--policy", POLICY]).rc, 2);
  assert.equal(run(QUERY, ["whatif", "src.a.destrIface", "--report", sw.p, "--policy", POLICY]).rc, 2);
});

// (d) chained: the producer report is hand-written (PART 109 has no ts chained arm), carrying `switches`
const consumer = path.join(ROOT, "consumer");
fs.mkdirSync(path.join(consumer, "src"), { recursive: true });
fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"consumerfx","version":"1.0.0"}');
fs.writeFileSync(path.join(consumer, "src", "b.ts"), `import * as fs from "fs";\nexport function writes() { fs.writeFileSync("/tmp/candor-switches-never-run", "z"); }\n`);
const producer = (switches) => {
  const d = path.join(ROOT, `deps${n++}`); fs.mkdirSync(d);
  const ver = scanReport().doc.candor.version;
  const rep = { candor: { version: ver, toolchain: "x", spec: "0.41" }, package: "depfx", functions: [], analyzed: { count: 1, digest: "0" } };
  if (switches) rep.switches = switches;
  fs.writeFileSync(path.join(d, "depfx.json"), JSON.stringify(rep));
  return d;
};
const chained = (deps) => {
  const p = path.join(ROOT, `c${n++}`), gj = `${p}.gate.json`, pol = path.join(ROOT, "cp.candor");
  fs.writeFileSync(pol, "deny Fs src.b.writes\n");
  const r = run(SCAN, [consumer, "--out", p, "--policy", pol, "--gate-json", gj], { CANDOR_DEPS: deps });
  return { ...r, gdoc: json(gj), doc: json(`${p}.json`) };
};

test("(d) a chained report carrying `switches`: stderr advisory + `switchedDependencies`, exit and the rest of the document unchanged", () => {
  const plain = chained(producer(null)), sw = chained(producer(["CANDOR_Z", "CANDOR_A"]));
  assert.equal(plain.rc, 1); assert.equal(sw.rc, 1, "the exit is untouched");
  assert.equal("switchedDependencies" in plain.gdoc, false);
  assert.deepEqual(sw.gdoc.switchedDependencies, [{ package: "depfx", switches: ["CANDOR_A", "CANDOR_Z"] }]);
  const rest = { ...sw.gdoc }; delete rest.switchedDependencies;
  assert.deepEqual(rest, plain.gdoc);
  assert.match(sw.err, /depfx.*CANDOR_A, CANDOR_Z/);
  assert.equal(sw.err.split("\n").filter((l) => /depfx/.test(l) && /result-moving switch/.test(l)).length, 1, "one advisory per package");
  assert.equal("switches" in sw.doc, false, "the consumer's own run is not switched");
});
