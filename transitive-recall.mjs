#!/usr/bin/env node
// candor — the TRANSITIVE-RECALL battery: which CALLERS can the Node oracle actually falsify?
//
// The sibling of sensitivity.mjs. That battery asks whether the oracle catches an effect at the function
// that PERFORMS it, with candor's disclosure stripped away, and answers 8/8. This one asks the question one
// level up, which is the one the honesty invariant actually turns on:
//
//   candor's signatures are TRANSITIVE — a function that REACHES an effect is effectful. So a false
//   all-clear can sit on a CALLER: `leaf` is honest, `entry` reaches it through an edge the analyzer
//   dropped, and `entry` is reported complete-pure. Can the oracle see that?
//
// It can only see it if `entry` is on the captured stack when the effect fires. The preload walks the stack
// and records the effect at EVERY project frame (verify-emit.mjs), so for a plain synchronous chain the
// answer is yes. But a JS stack is cut at every asynchronous boundary: once the chain crosses a timer, a
// detached promise continuation, a stored callback or an event listener, the callers that scheduled the work
// are simply gone by the time the effect runs. A lie on one of those callers is then not merely missed — it
// is UNFALSIFIABLE, and a clean run over such code says nothing about it.
//
// So this battery does not report a pass rate. It reports, per chain shape and per frame, which of three
// things is true — and the third is the one that matters:
//
//   CHARGED         the oracle attributed the effect here -> a lie at this frame would be caught
//   UNCORROBORATED  the oracle could not reach the frame, but candor discloses -> H holds by the CONTRACT
//                   only; the falsifier offers no independent check, so this is trust, not evidence
//   BLIND           the oracle could not reach it AND candor claims complete-pure -> a lie here is invisible
//   NO-REACH        the control's callers, which do not reach the effect at all -> nothing to check
//
// Every fixture writes a sentinel file, so "the effect ran" is witnessed out of band and a path not taken is
// reported INCONCLUSIVE rather than counted as anything.
//
//   node transitive-recall.mjs [--json] [--keep]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scratch } from "./scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wantJson = process.argv.includes("--json");
const keep = process.argv.includes("--keep");

// Every shape builds the same three-deep chain entry -> mid -> leaf with the same effect in the leaf, and
// varies only the boundary the chain crosses. Holding effect and depth fixed is what makes the frames
// comparable: any difference in what the oracle can charge is caused by the boundary alone.
//
// The callers AWAIT the work in every shape but the last. That matters more than it looks: an awaited caller
// is provably still on the causal path when the effect fires — it cannot have returned — so if the oracle
// fails to charge it, that is the instrument's reach and not the program's shape. The final `fire-and-forget`
// shape is the control for exactly that confusion: there the caller schedules and returns, so it genuinely
// does not reach the effect and reporting it pure is correct, not blind. A battery that could not tell those
// two apart would manufacture blind spots out of correct answers.
const SHAPES = [
  {
    id: "sync",
    desc: "plain synchronous calls (baseline: the whole chain is on the stack)",
    src: `
export function leaf() { fs.writeFileSync(OUT, "ran"); }
export function mid() { leaf(); }
export function entry() { mid(); }
entry();`,
    awaited: true,
  },
  {
    id: "await-direct",
    desc: "async chain, each level awaited, no scheduler in between",
    src: `
export async function leaf() { fs.writeFileSync(OUT, "ran"); }
export async function mid() { await leaf(); }
export async function entry() { await mid(); }
await entry();`,
    awaited: true,
  },
  {
    id: "await-timer",
    desc: "the effect fires from a timer the caller is suspended awaiting",
    src: `
export function leaf() { fs.writeFileSync(OUT, "ran"); }
export function mid() { return new Promise((res) => setTimeout(() => { leaf(); res(); }, 0)); }
export async function entry() { await mid(); }
await entry();`,
    awaited: true,
  },
  {
    id: "await-emitter",
    desc: "the effect fires from an event listener the caller is suspended awaiting",
    src: `
const { EventEmitter } = require("node:events");
export function leaf() { fs.writeFileSync(OUT, "ran"); }
export function mid() {
  const bus = new EventEmitter();
  const done = new Promise((res) => bus.on("go", () => { leaf(); res(); }));
  setTimeout(() => bus.emit("go"), 0);
  return done;
}
export async function entry() { await mid(); }
await entry();`,
    awaited: true,
  },
  {
    id: "await-queue",
    desc: "the effect fires from a stored callback the caller is suspended awaiting",
    src: `
const QUEUE = [];
export function leaf() { fs.writeFileSync(OUT, "ran"); }
export function mid() {
  QUEUE.push(leaf);
  return new Promise((res) => setTimeout(() => { for (const f of QUEUE.splice(0)) f(); res(); }, 0));
}
export async function entry() { await mid(); }
await entry();`,
    awaited: true,
  },
  {
    id: "await-detached-helper",
    desc: "the continuation lives OUTSIDE the caller's source span (tests the lexical-containment mechanism)",
    src: `
export function leaf() { fs.writeFileSync(OUT, "ran"); }
function schedule() { return new Promise((res) => setTimeout(() => { leaf(); res(); }, 0)); }
export function mid() { return schedule(); }
export async function entry() { await mid(); }
await entry();`,
    awaited: true,
  },
  {
    id: "fire-and-forget",
    desc: "CONTROL — the caller schedules and returns, so it never reaches the effect",
    src: `
export function leaf() { fs.writeFileSync(OUT, "ran"); }
export function mid() { setTimeout(leaf, 0); }
export function entry() { mid(); }
entry();
await new Promise((r) => setTimeout(r, 30));`,
    awaited: false,
  },
];

// `fs` is a STATIC import, not a computed require: a dynamic require would make candor disclose Unknown at
// every frame, and a frame that discloses has nothing to falsify. With the static form candor's claim at each
// caller is a real claim, so HONEST means it genuinely charged the frame.
const FIXTURE = (shape) => `// transitive-recall fixture: ${shape.desc}
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OUT = ${JSON.stringify("__OUT__")};
${shape.src}
`;

const FRAMES = ["leaf", "mid", "entry"];

function scan(dir, prefix) {
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), dir, "--allow-js", "--out", prefix], { encoding: "utf8" });
  const rep = fs.existsSync(`${prefix}.json`) ? JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")) : null;
  return { ok: r.status === 0, rep };
}

/** candor's own claim at a frame: does it already say Fs, or disclose Unknown? */
function staticClaim(rep, frame) {
  const f = (rep?.functions ?? []).find((x) => x.fn === frame || x.fn.endsWith("." + frame));
  if (!f) return { honest: false, how: "absent (claimed pure)" };
  const inf = f.inferred ?? [];
  if (inf.includes("Fs")) return { honest: true, how: "inferred Fs" };
  if (inf.includes("Unknown")) return { honest: true, how: "disclosed Unknown" };
  return { honest: false, how: `claimed { ${inf.join(", ") || "pure"} }` };
}

/** Falsify every signature to complete-pure, so the oracle is the only net (sensitivity.mjs's strip, reused
 *  here to ask about callers rather than the performing frame). The span index is kept — real attribution. */
function stripDisclosure(prefix) {
  const stripped = prefix + ".stripped";
  const rep = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  for (const f of rep.functions ?? []) f.inferred = [];
  fs.writeFileSync(`${stripped}.json`, JSON.stringify(rep));
  for (const ext of [".callgraph.json", ".locs.json"]) {
    if (fs.existsSync(`${prefix}${ext}`)) fs.copyFileSync(`${prefix}${ext}`, `${stripped}${ext}`);
  }
  return stripped;
}

function runVerify(dir, prefix, appPath, outPath, asyncStacks = false) {
  try { fs.rmSync(outPath, { force: true }); } catch { /* fresh */ }
  const env = { ...process.env };
  if (asyncStacks) env.CANDOR_VERIFY_ASYNC_STACKS = "1"; else delete env.CANDOR_VERIFY_ASYNC_STACKS;
  const t0 = Date.now();
  const r = spawnSync("node", [path.join(HERE, "verify.mjs"), dir, "--report", prefix,
    "--run", `node ${JSON.stringify(appPath)}`, "--json"], { encoding: "utf8", env });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { j, ran: fs.existsSync(outPath), ms: Date.now() - t0, raw: r };
}

/** Which frames did the oracle charge with Fs, given a verify --json result? */
function chargedFrames(j) {
  return new Set((j?.violations ?? []).filter((v) => v.escaped?.includes("Fs")).map((v) => v.fn.split(".").pop()));
}

// ── DEPTH probe ───────────────────────────────────────────────────────────────────────────────────────
// Orthogonal to the boundary shapes and the reason they were all measuring the wrong thing at first: V8
// captures at most `Error.stackTraceLimit` frames and the default is TEN, several of which the patched
// builtin and Node's internals consume before app code. A deep SYNCHRONOUS chain therefore loses its
// outermost callers with no boundary crossed at all. Before the fix a 16-deep chain charged 5 of 16 frames.
// This probe is a standing gate on that, because the failure is silent in both directions: nothing in the
// oracle's output says "your outer callers were truncated away".
const DEPTH = 16;
function depthProbe(root) {
  const dir = path.join(root, "depth");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "OUT.marker");
  const src = ['import fs from "node:fs";', `const OUT = ${JSON.stringify(outPath)};`,
    'export function f0() { fs.writeFileSync(OUT, "ran"); }'];
  for (let i = 1; i < DEPTH; i++) src.push(`export function f${i}() { f${i - 1}(); }`);
  src.push(`f${DEPTH - 1}();`);
  fs.writeFileSync(path.join(dir, "app.mjs"), src.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"depth","version":"0.0.0","type":"module"}');
  const prefix = path.join(dir, ".candor", "report");
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  scan(dir, prefix);
  const { j, ran } = runVerify(dir, stripDisclosure(prefix), path.join(dir, "app.mjs"), outPath, false);
  const charged = chargedFrames(j);
  const reached = [];
  for (let i = 0; i < DEPTH; i++) if (charged.has(`f${i}`)) reached.push(i);
  return { depth: DEPTH, reached: reached.length, ran, deepest: reached.length ? Math.max(...reached) : -1 };
}

const root = scratch("candor-transitive-recall-");
const results = [];
for (const shape of SHAPES) {
  const dir = path.join(root, shape.id);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "OUT.marker");
  fs.writeFileSync(path.join(dir, "app.mjs"), FIXTURE(shape).replace("__OUT__", outPath));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"trec","version":"0.0.0","type":"module"}');

  const prefix = path.join(dir, ".candor", "report");
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const { rep } = scan(dir, prefix);
  const claims = Object.fromEntries(FRAMES.map((f) => [f, staticClaim(rep, f)]));

  const stripped = stripDisclosure(prefix);
  const base = runVerify(dir, stripped, path.join(dir, "app.mjs"), outPath, false);
  const { j, ran } = base;
  const charged = chargedFrames(j);

  // The same run with continuation tracking on. Two things are measured, not one: how many previously
  // unreachable callers it recovers, and whether it charges a caller that had already RETURNED — which the
  // fire-and-forget control is built to expose, since charging there is a fabricated effect on a pure
  // function. A capture mode that buys reach with fabrication has not closed the gap, it has moved it.
  const asyncRun = runVerify(dir, stripped, path.join(dir, "app.mjs"), outPath, true);
  const chargedAsync = chargedFrames(asyncRun.j);

  const frames = {};
  for (const f of FRAMES) {
    // The control's callers schedule and return, so they are off the causal path by construction and neither
    // the analyzer nor the oracle owes anything at those frames. Scoring them alongside the awaited shapes
    // would credit the instrument for a frame there was never anything to find at.
    frames[f] = !ran ? "INCONCLUSIVE"
      : charged.has(f) ? "CHARGED"
      : (!shape.awaited && f !== "leaf") ? "NO-REACH"
      : claims[f].honest ? "UNCORROBORATED"
      : "BLIND";
  }
  // With continuation tracking on, a caller frame is either RECOVERED (it was out of reach and now is) or,
  // on the control, FABRICATED (charged although it left the dynamic extent before the effect fired).
  const asyncFrames = {};
  for (const f of FRAMES) {
    asyncFrames[f] = !ran ? "INCONCLUSIVE"
      : chargedAsync.has(f) ? (charged.has(f) ? "CHARGED" : (shape.awaited || f === "leaf" ? "RECOVERED" : "FABRICATED"))
      : frames[f];
  }
  results.push({ shape: shape.id, desc: shape.desc, awaited: shape.awaited, effectRan: ran, frames, asyncFrames,
    ms: { base: base.ms, async: asyncRun.ms },
    claims: Object.fromEntries(FRAMES.map((f) => [f, claims[f].how])) });
}

const depth = depthProbe(root);

if (!keep) fs.rmSync(root, { recursive: true, force: true });

// A caller is BLIND when candor claims it complete-pure and the oracle cannot reach it: a lie there is not
// missed by this run, it is untestable by this instrument. That set is the result.
const blind = [];
const uncorroborated = [];
for (const r of results) for (const f of FRAMES) {
  if (r.frames[f] === "BLIND") blind.push(`${r.shape}:${f}`);
  if (r.frames[f] === "UNCORROBORATED") uncorroborated.push(`${r.shape}:${f}`);
}
const inconclusive = results.filter((r) => !r.effectRan).map((r) => r.shape);
// The denominator is the caller frames that are actually on the causal path — the awaited shapes only.
const onPath = results.filter((r) => r.effectRan && r.awaited);
const callerFrames = onPath.length * 2; // mid + entry per shape
const callersCharged = onPath
  .reduce((n, r) => n + ["mid", "entry"].filter((f) => r.frames[f] === "CHARGED").length, 0);

// The two numbers that decide whether continuation tracking is worth turning on.
const recovered = [];
const fabricated = [];
for (const r of results) for (const f of FRAMES) {
  if (r.asyncFrames[f] === "RECOVERED") recovered.push(`${r.shape}:${f}`);
  if (r.asyncFrames[f] === "FABRICATED") fabricated.push(`${r.shape}:${f}`);
}
const totBase = results.reduce((n, r) => n + r.ms.base, 0);
const totAsync = results.reduce((n, r) => n + r.ms.async, 0);

const summary = {
  shapes: results.length,
  inconclusive,
  callerFramesOnCausalPath: callerFrames,
  callerFramesCharged: callersCharged,
  uncorroboratedFrames: uncorroborated,
  blindFrames: blind,
  asyncStacks: { recovered, fabricated, overhead: totBase ? +(totAsync / totBase).toFixed(2) : null },
  depth,
  results,
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("candor — TRANSITIVE-RECALL battery (which CALLERS can the Node oracle falsify?)\n");
  console.log("  Same three-deep chain in every shape, same effect in the leaf; only the boundary between");
  console.log("  mid and leaf changes. With every signature stripped to complete-pure, a frame reads:");
  console.log("    CHARGED        = the oracle reached it (a lie here would be caught)");
  console.log("    UNCORROBORATED = out of the oracle's reach; candor discloses, so this frame rests on the");
  console.log("                     ANALYZER'S OWN CLAIM with no independent check");
  console.log("    BLIND          = out of reach AND claimed pure -> a lie here would be invisible");
  console.log("    NO-REACH       = the control's callers; off the causal path by construction\n");
  const w = Math.max(...results.map((r) => r.shape.length));
  console.log(`  ${"shape".padEnd(w)}  ${"leaf".padEnd(16)}${"mid".padEnd(16)}${"entry".padEnd(16)}ran`);
  for (const r of results) {
    console.log(`  ${r.shape.padEnd(w)}  ${r.frames.leaf.padEnd(16)}${r.frames.mid.padEnd(16)}${r.frames.entry.padEnd(16)}${r.effectRan ? "yes" : "NO"}`);
  }
  console.log(`\n  with CANDOR_VERIFY_ASYNC_STACKS=1 (continuation tracking, opt-in):`);
  console.log(`  ${"shape".padEnd(w)}  ${"leaf".padEnd(16)}${"mid".padEnd(16)}${"entry".padEnd(16)}overhead`);
  for (const r of results) {
    const ov = r.ms.base > 0 ? `${(r.ms.async / r.ms.base).toFixed(2)}x` : "-";
    console.log(`  ${r.shape.padEnd(w)}  ${r.asyncFrames.leaf.padEnd(16)}${r.asyncFrames.mid.padEnd(16)}${r.asyncFrames.entry.padEnd(16)}${ov}`);
  }
  console.log(`\n  caller frames on the causal path : ${callerFrames}`);
  console.log(`  of those, reachable by the oracle: ${callersCharged}`);
  if (inconclusive.length) console.log(`  INCONCLUSIVE shapes     : ${inconclusive.join(", ")} (effect did not run — no evidence either way)`);
  if (uncorroborated.length) {
    console.log(`\n  UNCORROBORATED (${uncorroborated.length}): ${uncorroborated.join(", ")}`);
    console.log("  H holds at these frames because candor SAYS SO, not because the falsifier confirmed it. The");
    console.log("  oracle's transitive reach stops at the innermost asynchronous boundary — it charges the");
    console.log("  function that lexically CONTAINS the continuation, and nothing above it, because those");
    console.log("  callers are suspended and off the stack when the effect fires. Report the boundary, not a rate.");
  }
  console.log(`\n  continuation tracking recovers ${recovered.length} frame(s) previously out of reach` +
    (recovered.length ? `: ${recovered.join(", ")}` : ""));
  if (fabricated.length) {
    console.log(`  but FABRICATES on ${fabricated.length} frame(s): ${fabricated.join(", ")}`);
    console.log("  Those callers scheduled the work and RETURNED — they had left the dynamic extent before the");
    console.log("  effect fired, so charging them invents an effect on a genuinely pure function. Trigger-chain");
    console.log("  inheritance cannot tell a caller that is SUSPENDED AWAITING the work from one that is merely");
    console.log("  its ancestor. That is why the mode stays OFF by default: it buys reach with the cardinal");
    console.log("  sin's mirror, and the whole point of the falsifier is not to trade one for the other.");
  } else {
    console.log("  and fabricates on none — the control's returned callers stayed uncharged.");
  }
  console.log(`  overhead: ${totBase ? (totAsync / totBase).toFixed(2) + "x" : "-"} wall-clock across the battery`);
  console.log(`\n  depth probe: ${depth.reached}/${depth.depth} frames of a plain synchronous chain charged` +
    (depth.reached < depth.depth ? "  <-- TRUNCATED" : ""));
  if (depth.reached < depth.depth) {
    console.log("  The capture is dropping outer callers with no async boundary crossed — Error.stackTraceLimit.");
    console.log("  Nothing in the oracle's output announces this, so a false all-clear on a truncated-away");
    console.log("  caller is invisible and every 'H held' below this depth is weaker than it reads.");
  }
  if (blind.length) {
    console.log(`\n  BLIND frames (${blind.length}): ${blind.join(", ")}`);
    console.log("  Here the analyzer claims complete purity and the oracle cannot contradict it: a clean run");
    console.log("  over code shaped like this is not evidence that H held at these frames.");
  } else {
    console.log("\n  BLIND frames: none — every on-path caller was either charged or disclosed.");
  }
}

// This battery mostly MEASURES a bound rather than passing or failing one — the UNCORROBORATED count is a
// property of JavaScript, not a defect, and driving it to zero would need a different capture mechanism.
// Two conditions do red it:
//   · a BLIND frame. Every awaited shape guarantees its callers are on the causal path, so a complete-pure
//     claim there is a false all-clear that no oracle in this arm could catch — the cardinal sin, arriving
//     in the one place the falsifier cannot see it.
//   · an INCONCLUSIVE shape. A fixture whose effect never ran measured nothing, and must not read clean.
//   · a truncated DEPTH probe. A plain synchronous chain has no boundary to excuse a missing caller, so any
//     shortfall there is the capture silently losing frames — the defect this battery was built on top of.
process.exit(blind.length || inconclusive.length || depth.reached < depth.depth ? 1 : 0);
