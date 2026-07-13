// Surface the single most SURPRISING transitive reach (the cold-repo hook).
//
// After the effect summary + coverage ledger, candor-ts emits ONE more stderr line: the most surprising
// transitive reach in the project + a ready-to-run `candor path` command. Port of candor-rust's
// crates/candor-scan/src/surface.rs — same behavior, idiomatic JS. See SURFACE-BEST-FIND-DESIGN.md.
//
// Fully deterministic — pure call-graph + name analysis, NO LLM. A CANDIDATE is a function `F` that
// INHERITS an effect `E` (E ∈ inferred[F] but E ∉ direct[F]); we BFS to the nearest local direct SOURCE
// `S` and score by how surprising the reach is (a benign-named function reaching a scary effect). The
// find is never *wrong*: `candor path` re-derives the chain and the gate is ground truth. When nothing
// clears the bar we emit an honest "nothing hidden" fallback — never a manufactured surprise.

// Name tokens that read as local / pure / config — a function whose leaf is named like this reaching a
// scary effect is the core surprise signal. Copied verbatim from surface.rs BENIGN.
const BENIGN = new Set([
  "settings", "config", "conf", "options", "opts", "util", "utils", "helper", "helpers", "model",
  "models", "dto", "entity", "format", "fmt", "parse", "get", "load", "new", "default", "validate",
  "valid", "render", "view", "build", "builder", "item", "entry", "record", "state", "context",
  "ctx", "info", "meta", "data", "value", "node", "field", "name", "key", "id", "path", "kind",
  "type", "status", "check", "init", "setup",
]);

// Name tokens that are effect-suggestive — a function in/near an effect-flavored context reaching that
// effect is EXPECTED, not surprising, so we EXCLUDE it. Copied verbatim from surface.rs EFFECTY.
const EFFECTY = new Set([
  "fetch", "http", "https", "client", "api", "sync", "request", "req", "download", "upload", "query",
  "sql", "store", "save", "persist", "connect", "conn", "socket", "send", "recv", "read", "write",
  "open", "file", "fs", "io", "net", "tcp", "udp", "dns", "url", "host", "port", "cmd", "command",
  "shell", "process", "proc", "exec", "spawn", "env", "clock", "time", "now", "rand", "random",
  "log", "logger", "trace", "db",
]);

// The qualified-name separator. Rust uses `::`; candor-ts quals are `mod.Class.member`.
const SEP = ".";

// Split a qualified name (or a leaf) into lowercase tokens on the separator, `_`, and camelCase
// boundaries. Mirrors surface.rs::tokenize (which splits on `_`, `:` and camelCase).
export function tokenize(name) {
  const out = [];
  let cur = "";
  let prevLower = false;
  for (const ch of name) {
    if (ch === "_" || ch === "." || ch === ":") {
      if (cur) { out.push(cur); cur = ""; }
      prevLower = false;
      continue;
    }
    // Unicode-aware uppercase (matches surface.rs's `ch.is_uppercase()`): a letter that differs from
    // its lowercase form and equals its uppercase form. ASCII-only for the digit check (surface.rs uses
    // `is_ascii_digit`), so a non-ASCII uppercase letter STILL starts a new token.
    const lower = ch.toLowerCase();
    const isUpper = ch !== lower && ch === ch.toUpperCase();
    const isLower = ch !== ch.toUpperCase() && ch === lower;
    // camelCase boundary: a lower/digit followed by an upper starts a new token.
    if (isUpper && prevLower && cur) { out.push(cur); cur = ""; }
    cur += lower;
    prevLower = isLower || (ch >= "0" && ch <= "9");
  }
  if (cur) out.push(cur);
  return out;
}

// The leaf (final segment) of a qualified name.
function leaf(qual) {
  const i = qual.lastIndexOf(SEP);
  return i < 0 ? qual : qual.slice(i + SEP.length);
}

// The module portion of a qualified name (everything before the leaf).
function moduleOf(qual) {
  const i = qual.lastIndexOf(SEP);
  return i < 0 ? "" : qual.slice(0, i);
}

// The first token of `name` that appears in `lexicon`, or null.
function hasToken(name, lexicon) {
  for (const t of tokenize(name)) if (lexicon.has(t)) return t;
  return null;
}

// Salience of an effect — the boundary/security-relevant effects a reviewer cares about score higher.
// Clock/Log/Rand are DELIBERATELY 0 (not surfaced): a mundane clock/log reach isn't "the most
// surprising reach", and a repo whose only reaches are mundane should honestly say "nothing hidden".
// Matches the Rust reference (candor-classify/src/surface.rs) + the java/swift ports.
function salience(effect) {
  switch (effect) {
    case "Net": case "Exec": case "Db": case "Ipc": return 5;
    case "Fs": case "Env": return 3;
    default: return 0; // Clock/Log/Rand/Unknown/everything-else — mundane, never surfaced
  }
}

function hopsFactor(hops) {
  if (hops === 1) return 2;
  if (hops >= 2 && hops <= 4) return 3;
  if (hops >= 5 && hops <= 6) return 2;
  return 1; // ≥7 (hops is always ≥1 for an inherited reach)
}

// BFS from `func` over `calls` (follow callees, shortest hops) to the nearest function `S` with
// `effect` ∈ direct[S]. Returns { hops≥1, source } or null. Only traverses through callees that
// transitively carry the effect, so the frontier stays on-effect (matches `candor path`'s walk).
function nearestSource(func, effect, direct, inferred, calls) {
  const seen = new Set([func]);
  const q = [[func, 0]];
  let head = 0;
  while (head < q.length) {
    const [cur, d] = q[head++];
    // A direct source found at distance d≥1 is the nearest (BFS). The start `func` itself is an
    // INHERITED reach (E ∉ direct[func]) so it never matches at d==0.
    if (d >= 1 && direct.get(cur)?.has(effect)) return { hops: d, source: cur };
    const cs = calls.get(cur);
    if (cs) {
      // Iterate callees in SORTED order — surface.rs/Java/Swift walk a BTreeSet<String> (sorted), so at
      // an equal-distance tie the SAME source/score/`candor path` is chosen on every engine. Raw Map/JSON
      // insertion order here would let a tie resolve differently (non-determinism vs the reference).
      for (const c of [...cs].sort()) {
        if (!seen.has(c) && inferred.get(c)?.has(effect)) {
          seen.add(c);
          q.push([c, d + 1]);
        }
      }
    }
  }
  return null;
}

// Collect EVERY scored candidate reach (unranked), plus whether the project is effectful at all. The
// single source of the candidate pool for both bestFind (top-1) and bestFinds (top-N) — one heuristic,
// no drift. `loc` is a Map<qual, "file:line"> for the source callout ("" when absent). Returns
// { cands: <Find[]>, anyEffectful }.
function collectCandidates(inferred, direct, calls, loc, isTest) {
  // Any function carrying a real (non-Unknown) effect makes the project "effectful" — governs
  // whether the caller emits the fallback vs nothing.
  let anyEffectful = false;

  // Deterministic iteration: sort quals ascending so the tie-break (qual ascending) is stable and
  // Map insertion order never leaks into the result.
  const quals = [...inferred.keys()].sort();

  const cands = [];

  for (const f of quals) {
    const inf = inferred.get(f);
    for (const e of inf) if (e !== "Unknown") { anyEffectful = true; break; }
    if (isTest(f)) continue;
    const fLeaf = leaf(f);
    const fMod = moduleOf(f);
    // EXCLUDE the whole function if its leaf OR module reads effecty — its reach is obvious.
    if (hasToken(fLeaf, EFFECTY) || hasToken(fMod, EFFECTY)) continue;
    const dir = direct.get(f) ?? new Set();
    // Candidate effects: inherited (in inferred, not direct), not Unknown; sorted ascending.
    const effects = [...inf].filter((e) => e !== "Unknown" && !dir.has(e)).sort();
    for (const e of effects) {
      const sal = salience(e);
      if (sal === 0) continue;
      const ns = nearestSource(f, e, direct, inferred, calls);
      if (!ns) continue; // no LOCAL direct source — nothing to show
      const benign = hasToken(fLeaf, BENIGN);
      const benignity = benign ? 3 : 1;
      const crossing = moduleOf(ns.source) !== fMod ? 2 : 1;
      const score = sal * benignity * hopsFactor(ns.hops) * crossing;
      if (score === 0) continue;
      cands.push({
        func: f, effect: e, hops: ns.hops, source: ns.source,
        sourceLoc: loc?.get(ns.source) ?? "", benignToken: benign ?? "", score,
      });
    }
  }
  return { cands, anyEffectful };
}

// Compute the top-`n` most surprising reaches, most-surprising first. DEDUPED by function — each
// function appears at most once (its single highest-scoring reach). The list is empty when nothing
// clears the bar. Each Find carries { func, effect, hops, source, sourceLoc, benignToken, score }.
//
// Ranking (the tie-break, applied to the whole candidate pool before the per-function dedup + take):
// score DESC → hops ASC → qualified name ASC. With `n === 1` the result is BYTE-IDENTICAL to the old
// bestFind's winner — the shared candidate pool + this same tie-break, one implementation. Port of
// surface.rs::best_finds. `loc` is a Map<qual, "file:line"> for the source callout (optional).
export function bestFinds(inferred, direct, calls, loc, n, isTest = () => false) {
  const { cands } = collectCandidates(inferred, direct, calls, loc, isTest);
  // Rank the whole pool: score DESC, hops ASC, qual ASC. Quals were iterated ascending and effects
  // ascending, so on a full tie the first-pushed (smallest qual) candidate sorts first — matching the
  // old bestFind's "keep the earliest winner on an exact tie" (a stable sort preserves push order).
  cands.sort((a, b) => (b.score - a.score) || (a.hops - b.hops) || (a.func < b.func ? -1 : a.func > b.func ? 1 : 0));
  // DEDUP by function — each appears at most once (its highest-scoring reach, first in ranked order).
  // Then take up to `n` distinct functions.
  const seenFns = new Set();
  const out = [];
  for (const c of cands) {
    if (out.length >= n) break;
    if (!seenFns.has(c.func)) { seenFns.add(c.func); out.push(c); }
  }
  return out;
}

// Compute the single most surprising reach (the scan-time note).
//   · returns null                      — ZERO effectful functions (caller emits nothing)
//   · returns { winner: null }          — effectful, but none cleared the bar (honest fallback)
//   · returns { winner: <Find> }        — the winning reach
//
// `inferred`/`direct` are Map<qual, Set<effect>>; `calls` is Map<qual, Iterable<qual>>; `isTest` is an
// optional (qual) => bool predicate (defaults to false — the caller supplies path-based test detection).
// ONE implementation with bestFinds — the winner is exactly bestFinds(…, 1)[0] (the scan-note output
// stays byte-identical, verified by the surface tests + conformance).
export function bestFind(inferred, direct, calls, isTest = () => false) {
  const { anyEffectful } = collectCandidates(inferred, direct, calls, undefined, isTest);
  if (!anyEffectful) return null;
  const top = bestFinds(inferred, direct, calls, undefined, 1, isTest);
  return { winner: top.length ? top[0] : null };
}

// Emit the surface note to STDERR. `loc` is a Map<qual, "file:line"> for the source callout; `log` is
// the sink (defaults to console.error). Mirrors surface.rs::emit exactly.
export function emitSurface(inferred, direct, calls, loc, isTest = () => false, log = console.error) {
  const res = bestFind(inferred, direct, calls, isTest);
  if (res === null) return; // zero effectful functions — emit nothing
  if (res.winner === null) {
    log("candor: nothing hidden — every effect sits where its name says it should.");
    return;
  }
  const f = res.winner;
  const whereS = loc.get(f.source) ?? "?";
  const hopWord = f.hops === 1 ? "hop" : "hops";
  const benignNote = f.benignToken
    ? `          a "${f.benignToken}"-named function reaching ${f.effect}.\n`
    : "";
  log(
    `candor: most surprising reach — \`${f.func}\` performs ${f.effect}, ${f.hops} ${hopWord} away via `
    + `\`${f.source}\` (${whereS}).\n${benignNote}          →  candor path ${f.func} ${f.effect}`,
  );
}
