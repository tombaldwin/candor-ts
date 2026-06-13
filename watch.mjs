#!/usr/bin/env node
/**
 * candor-ts-watch — keep a candor report FRESH as an agent edits, so candor-ts-mcp serves live ground
 * truth (roadmap #1, the freshness half). It tracks the project's TS sources by content hash and
 * re-scans only when a tracked source ACTUALLY changed — a no-op save, a touched node_modules file, or
 * an unrelated write never triggers work. The MCP server reads the same `--out` prefix, so the loop is:
 * agent edits → watcher refreshes the report → agent asks candor_impact and gets the post-edit answer.
 *
 * v1 re-runs a FULL scan on a real change — sound (the report always equals a clean scan), and fast
 * enough for the edit loop on small/mid projects. The deeper optimisation — re-analysing only the
 * changed file's subgraph and re-propagating incrementally (the part that needs candor-ts's scanner
 * factored for per-file extraction) — is the staged next step; the content-hash gate here is the first
 * increment of it (don't redo work when nothing relevant changed).
 *
 *   candor-ts-watch <dir> [--out <prefix>] [--interval <ms>]
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = /\.[mc]?[jt]sx?$/;            // .ts/.tsx/.mts/.cts/.js/.jsx — what candor-ts analyses
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".candor"]);

// The tracked source set: every analysable file under `target` (a dir), or the single file itself.
export function trackedFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return SRC.test(target) ? [path.resolve(target)] : [];
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") && ent.name !== ".") continue;
      if (SKIP.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (SRC.test(ent.name)) out.push(path.resolve(p));
    }
  })(target);
  return out.sort();
}

// file -> content hash; a missing file is dropped (so deletes register as a change).
export function hashFiles(files) {
  const h = {};
  for (const f of files) {
    try { h[f] = crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); } catch { /* gone */ }
  }
  return h;
}

// The set of files whose hash differs between two snapshots (added, removed, or modified).
export function changedFiles(prev, cur) {
  const names = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  return [...names].filter((f) => prev[f] !== cur[f]).sort();
}

// One sound scan into `<out>` (the prefix the MCP server reads). Returns {ok, ms}.
export function scanOnce(target, out) {
  const t0 = Date.now();
  const r = spawnSync("node", [path.join(HERE, "scan.mjs"), target, "--out", out], { encoding: "utf8" });
  return { ok: r.status === 0, ms: Date.now() - t0, stderr: r.stderr };
}

function rel(f, target) { return path.relative(fs.statSync(target).isFile() ? path.dirname(target) : target, f) || f; }

async function main() {
  const args = process.argv.slice(2);
  let target = null, out = null, interval = 400;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--interval") interval = Number(args[++i]) || interval;
    else if (!args[i].startsWith("--")) target = args[i];
    else { console.error(`candor-ts-watch: unknown flag ${args[i]}`); process.exit(2); }
  }
  if (!target) { console.error("usage: candor-ts-watch <dir> [--out <prefix>] [--interval <ms>]"); process.exit(2); }
  out ??= path.join(fs.statSync(target).isFile() ? path.dirname(target) : target, ".candor", "report");

  let prev = hashFiles(trackedFiles(target));
  const first = scanOnce(target, out);
  console.error(`candor-ts-watch: ${Object.keys(prev).length} source(s) → ${out}.json (${first.ms}ms). Watching… (Ctrl-C to stop)`);
  if (!first.ok) console.error(first.stderr?.trim());

  setInterval(() => {
    const cur = hashFiles(trackedFiles(target));
    const changed = changedFiles(prev, cur);
    if (!changed.length) return; // the freshness gate: nothing relevant changed, do nothing
    prev = cur;
    const r = scanOnce(target, out);
    const names = changed.slice(0, 4).map((f) => rel(f, target)).join(", ") + (changed.length > 4 ? `, +${changed.length - 4}` : "");
    console.error(r.ok ? `candor-ts-watch: re-scanned (${changed.length} changed: ${names}) in ${r.ms}ms`
                       : `candor-ts-watch: scan FAILED after a change in ${names}: ${r.stderr?.trim()}`);
  }, interval).unref?.();
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) main();
