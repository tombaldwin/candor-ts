#!/usr/bin/env node
// Check candor-ts against the SAME expected.json oracle the Rust + Java engines answer to
// (conformance Part 1 logic: pair by bare leaf name; the expected set is the spec answer).
import fs from "node:fs";

const [, , reportPath, expectedPath] = process.argv;
const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const fns = Array.isArray(rep) ? rep : rep.functions;
// ⟨SOUNDNESS R531⟩ THE PAIRING KEY IS A BARE LEAF, SO TWO UNITS CAN SPELL IT THE SAME and `new Map`
// keeps the LAST — the oracle would then be answered by whichever declaration happened to come second,
// silently. Today `Cases.ts` has zero duplicated leaves (measured), so this is a latent collision, not a
// live one; a REFUSAL is the right answer either way, because the alternative is a green run over a case
// nobody compared. Exit 2 (a usage/setup error), never 1 (a real mismatch) — the two want different
// repairs. Build the map by hand rather than from `new Map(fns.map(…))`: the constructor form cannot see
// the collision it is performing.
const byLeaf = new Map();
const collided = new Set();
for (const e of fns) {
  const leaf = e.fn.split(".").pop();
  if (byLeaf.has(leaf)) collided.add(leaf);
  byLeaf.set(leaf, new Set(e.inferred));
}
const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
const cases = Object.keys(expected).filter((k) => !k.startsWith("_"));
// ⟨SOUNDNESS R531⟩ AN EMPTY ORACLE IS NOT A PASS. §H: ask of any aggregator what it prints when the
// thing it aggregates over is EMPTY — this one printed `0 cases, 0 mismatch(es)` and exited 0, which is
// indistinguishable from a full green run and is exactly the shape that let an empty gate list report
// `OK — every gate ran and passed` in the umbrella. A renamed, truncated or wrong-shaped
// `expected.json` parses fine and reaches here; `fails === 0` then says nothing at all.
if (cases.length === 0) {
  console.error(`check: REFUSED — \`${expectedPath}\` declares no cases (only \`_\`-prefixed keys, or none at all).`);
  console.error("       Zero mismatches over zero cases is not a pass. Check the oracle path and its shape.");
  process.exit(2);
}
const shadowed = cases.filter((c) => collided.has(c));
if (shadowed.length) {
  console.error(`check: REFUSED — ${shadowed.length} oracle case(s) pair to a leaf name declared by MORE THAN ONE unit `
               + `in the report: ${shadowed.join(", ")}.`);
  console.error("       The bare-leaf key cannot say which one the oracle meant, and the map keeps the last.");
  process.exit(2);
}

let fails = 0;
console.log(`${"case".padEnd(20)} ${"expected".padEnd(16)} ${"candor-ts".padEnd(16)} verdict`);
console.log("-".repeat(62));
for (const [name, exp] of Object.entries(expected)) {
  if (name.startsWith("_")) continue;
  const got = byLeaf.get(name) ?? new Set();
  const want = new Set(exp);
  const ok = got.size === want.size && [...want].every((e) => got.has(e));
  if (!ok) fails++;
  const f = (s) => [...s].sort().join(",") || "(pure)";
  console.log(`${name.padEnd(20)} ${f(want).padEnd(16)} ${f(got).padEnd(16)} ${ok ? "ok" : "MISMATCH"}`);
}
console.log("-".repeat(62));
console.log(`${cases.length} cases, ${fails} mismatch(es)`);
process.exit(fails ? 1 : 0);
