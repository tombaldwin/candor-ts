#!/usr/bin/env node
// Check candor-ts against the SAME expected.json oracle the Rust + Java engines answer to
// (conformance Part 1 logic: pair by bare leaf name; the expected set is the spec answer).
import fs from "node:fs";

const [, , reportPath, expectedPath] = process.argv;
const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const fns = Array.isArray(rep) ? rep : rep.functions;
const byLeaf = new Map(fns.map((e) => [e.fn.split(".").pop(), new Set(e.inferred)]));
const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

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
console.log(`${Object.keys(expected).filter((k) => !k.startsWith("_")).length} cases, ${fails} mismatch(es)`);
process.exit(fails ? 1 : 0);
