#!/usr/bin/env node
/**
 * candor-lsp — candor's effect map as a Language Server (AGENT-SURFACE-DESIGN bet 2, P1): the report,
 * rendered where the code is.
 *
 *   • CodeLens per effectful function: `⚡ Db, Net · blast radius 12` — the transitive effect set and
 *     how many functions transitively call it (who is affected if it changes).
 *   • Diagnostics: the repo's architecture-policy verdict (the §6.2 gate, resolved from CANDOR_POLICY
 *     or the checked-in .candor/config — spec §3.4) as squiggles at each violating function's line.
 *     CAVEAT — a report-computed gate is WEAKER than the engine's own --gate-json run: the scan-time
 *     gate also fails an allow rule whose literal surface is INCOMPLETE (a masked/invisible endpoint,
 *     kept internal per the java/rust engines — not a report field), so no-squiggle here can still be
 *     red in CI. The engine's --gate-json is the authoritative form (same caveat as MCP candor_gate).
 *     ⟨0.21⟩/⟨0.30⟩/⟨0.32⟩ — and where the report itself cannot support a green verdict (a declared
 *     `unanalyzed`, the producer's peek naming an out-of-scope denied effect, or a class the scan never
 *     OPENED), the squiggles are not the whole verdict and the gap is DISCLOSED on window/logMessage +
 *     window/showMessage. No diagnostic: code the scan never read has no line here to sit on. See
 *     `discloseIncompleteness`.
 *   • Hover: effect PROVENANCE — for each inherited effect, the `path` hop chain to the function that
 *     performs it directly ("Net via mid → leaf (source)"), plus unknownWhy when the fn discloses opacity.
 *   • CodeAction (pre-edit whatif): inside a function the report knows, one action per BOUNDARY effect
 *     the fn does NOT already perform — `candor: what if <fn> performed Net?`. Each resolves to the
 *     `candor.whatif` workspace/executeCommand, answered server-side with the SAME query-core whatif the
 *     CLI and MCP use (single-source): a window/showMessage one-liner (the policy rule that WOULD fire +
 *     the blast radius; no policy discovered → radius only, said so) and a transient Information
 *     diagnostic at the fn's line carrying the detail (rule + first callers), cleared on the next
 *     didOpen/didSave/didChange of that file or replaced by re-running the action. Plain LSP — works in
 *     helix/neovim/VS Code/JetBrains-via-LSP4IJ without client-side code.
 *
 *   Perf (measured on the 5k-fn synthetic fixture in test-lsp.mjs — 50 files × 100 fns, one 5k-deep
 *   call chain, worst-case doc): codeLens ≈ 63ms, codeAction ≈ 5ms per request, INCLUDING the
 *   per-request report re-read. No caching layer — the freshness contract stays "re-read per request".
 *
 * The server is a pure CONSUMER of the spec report envelope + callgraph sidecar (any engine — JVM /
 * Rust / TS / Swift / agents; the same read layer as candor-mcp), and it never scans (the analyzer
 * self-boundary, spec §7.12): whatever refreshes the report (candor-ts-watch, the Claude Code stop
 * hook, a build step) refreshes the lenses — reports are re-read per request, so freshness is free.
 * A stale report is a stale map, disclosed by its own provenance (§2.1), never re-derived here.
 *
 * Report prefix resolution: initializationOptions.report → $CANDOR_REPORT → <workspace>/.candor/report.
 * Transport: LSP stdio (Content-Length framed JSON-RPC 2.0).
 *
 * Editor wiring (no dedicated extension needed where the editor speaks LSP natively):
 *   helix   languages.toml:  language-server.candor = { command = "candor-lsp" }
 *   neovim  vim.lsp.start({ name = "candor", cmd = { "candor-lsp" } })
 *   VS Code needs a thin client extension — a later slice.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Q from "./query-core.mjs";
import { discoverConfigPolicy, evaluatePolicy, parsePolicy, scopeMatches, reportNetClasses, parseUnknownAliases, discoverConfigText, policyVocabularyAnchor, policyErrorText, unanswerableScoped, wholePolicyUnanswerable, resolveReasonClasses, fatalPolicyErrors, policyZeroRules, reportUnits } from "./policy.mjs";

// Version: from the sibling package.json when running inside the npm package; a single-file BUNDLE of
// this server (the IDE-plugin embedding) has no sibling package.json — fall back rather than crash.
let VERSION = "bundled";
try { VERSION = createRequire(import.meta.url)("./package.json").version; } catch { /* bundled */ }

// ---- state (set at initialize) ---------------------------------------------------------------------
let rootPath = null;
let reportPrefix = process.env.CANDOR_REPORT || process.argv[2] || null;

const hasReport = Q.hasReport; // single-sourced with the loader predicate (query-core) — see mcp.mjs

// ---- the activity push (AGENT-SURFACE-DESIGN.md P2) --------------------------------------------------
// The Stop hook / standalone reviews append to .candor/activity.jsonl (lib-candor-summary.sh's pinned
// record shape); the LSP tails it and surfaces each new BLOCKED record in-editor — the same payload the
// hook shows the agent, pushed to the human. This is the LSP's ONE watcher (everything else stays
// re-read-per-request): a small stat poll, unref'd so it never holds the process open, off-switchable
// (CANDOR_LSP_ACTIVITY=off). Only records appended AFTER startup push (no history replay); a SHRUNKEN
// log (the writer's cap trim-rewrite, or a rotation) skips to its end — never replays; a partial
// trailing line waits for its newline; corrupt lines are skipped.
let activityLog = null, activityOffset = 0, activityTimer = null;
// The activity gate overlay has its OWN store, SEPARATE from the whatif/fix `transient` map: the two
// are set by different actors (the tailer vs the client's executeCommand) and clear on different events
// (next clean record vs the file's next didOpen/didSave/didChange) — sharing one map let a blocked
// record clobber a live whatif overlay, and a clean record delete an unrelated whatif set afterwards.
// Keys are canonicalDocKey() paths, NOT uri strings: the setter's path is server-computed while the
// clearer's comes from the client's uri, and the two encodings diverge (Windows drive-case/%3A,
// symlinked workspaces) — a string-keyed overlay wedged, uncleanable by any didOpen/didSave.
const activityTransient = new Map();  // canonical doc key -> Diagnostic[] (the gate overlay)
const activityOverlaid = new Set();   // canonical doc keys carrying a gate overlay — cleared on the next clean record
// One canonical key for the activity overlay maps: the RESOLVED filesystem path — realpath when the
// file exists (symlinked workspaces: /var vs /private/var), case-folded on win32 (drive-letter case).
// Both the server-computed side (activity records' `edited` paths) and the client side (didOpen/
// didSave uris, via fileURLToPath) funnel through this, so an encoding divergence cannot wedge the
// overlay. The whatif/fix `transient` map deliberately does NOT get this treatment: its keys are only
// ever CLIENT-supplied uris on both sides (codeAction arguments echo the client's own uri back into
// executeCommand, and the clear reads the same client field), so set and clear already agree
// byte-for-byte — canonicalizing there would be motion without a divergence to fix.
function canonicalDocKey(p) {
  let abs = nodePath.resolve(p);
  try { abs = fs.realpathSync.native(abs); } catch { /* not on disk (yet) — resolve() is the best we have */ }
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}
function startActivityWatch() {
  if ((process.env.CANDOR_LSP_ACTIVITY || "").toLowerCase() === "off") return;
  const dir = rootPath ? nodePath.join(rootPath, ".candor")
            : reportPrefix ? nodePath.dirname(reportPrefix) : null;
  if (!dir) return;
  activityLog = nodePath.join(dir, "activity.jsonl");
  try { activityOffset = fs.statSync(activityLog).size; } catch { activityOffset = 0; }
  const ms = Math.max(50, parseInt(process.env.CANDOR_LSP_ACTIVITY_POLL_MS || "2000", 10) || 2000);
  activityTimer = setInterval(pollActivity, ms);
  activityTimer.unref();
}
function pollActivity() {
  let size;
  try { size = fs.statSync(activityLog).size; } catch { return; }   // absent — keep waiting
  if (size < activityOffset) {
    // Shrunk — NOT an exceptional rotation: the writer (lib-candor-summary.sh candor_log_activity)
    // rewrites the log via tail+mv on EVERY append once past its line cap, so past that point every
    // poll sees a smaller file. Restarting the tail at 0 replayed the whole trimmed rewrite (~cap
    // lines) each poll — a showMessage flood of historical blocked records. Skip to the END instead:
    // the rewrite's tail is overwhelmingly history we already pushed. Trade-off, made deliberately —
    // we may MISS the few genuinely-new records that arrived in the same rewrite, and that beats
    // flooding the editor with thousands of stale ones.
    activityOffset = size;
    return;
  }
  if (size === activityOffset) return;
  let text;
  try {
    const fd = fs.openSync(activityLog, "r");
    const buf = Buffer.alloc(size - activityOffset);
    fs.readSync(fd, buf, 0, buf.length, activityOffset);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch { return; }
  activityOffset = size;
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) { activityOffset -= Buffer.byteLength(text); return; }        // mid-write — retry next poll
  if (lastNl < text.length - 1) { activityOffset -= Buffer.byteLength(text.slice(lastNl + 1)); text = text.slice(0, lastNl + 1); }
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }            // corrupt line — skipped, like stats
    if (r && typeof r === "object" && !Array.isArray(r)) onActivityRecord(r);
  }
}
function onActivityRecord(r) {
  if (r.verdict === "clean") {
    // the gate went green again — drop the GATE overlays only (a live whatif/fix overlay on the same
    // file is the client's own question, not the gate's — it clears on the file's next open/save/edit,
    // never here). The message noise stays hook-side; quiet here.
    for (const key of activityOverlaid) { activityTransient.delete(key); publishDiagnostics(pathToFileURL(key).href); }
    activityOverlaid.clear();
    return;
  }
  if (r.verdict !== "blocked") return;                               // setup records aren't editor events
  const parts = [];
  if (Array.isArray(r.gained) && r.gained.length) parts.push(`introduces {${r.gained.join(", ")}}`);
  if (Number.isInteger(r.blastRadius) && r.blastRadius > 0) parts.push(`blast radius ${r.blastRadius} fn(s)`);
  if (Number.isInteger(r.maxHops)) parts.push(`deepest propagation ${r.maxHops} hop(s)`);
  const codes = Array.isArray(r.violations) && r.violations.length ? ` [${r.violations.join(", ")}]` : "";
  const msg = `candor gate: blocked — ${parts.join("; ") || "see the review output"}${codes}`;
  showMessage(2, msg);
  // pin the delta to the edited files as the gate's own transient overlay (activityTransient — cleared
  // on the file's next open/save, or by the next clean record above; a whatif/fix overlay on the same
  // file coexists rather than being overwritten). Hook records carry `edited`; standalone records have
  // edited=null — the showMessage above is then the whole push.
  for (const p of Array.isArray(r.edited) ? r.edited : []) {
    if (typeof p !== "string" || !p) continue;
    let key, uri;
    try {
      key = canonicalDocKey(nodePath.resolve(rootPath ?? process.cwd(), p));
      uri = pathToFileURL(key).href;
    } catch { continue; }
    activityTransient.set(key, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 200 } },
      severity: 2, source: "candor", code: "gate", message: msg,
    }]);
    activityOverlaid.add(key);
    publishDiagnostics(uri);
  }
}

// ---- fn → document mapping --------------------------------------------------------------------------
// A report `loc` is `<file>:<line>[:col…]` where <file> is either a repo-relative PATH (the scan-source
// engines) or a BARE filename (JVM bytecode SourceFile) — for the bare form the path is rebuilt from the
// fn's package segments, the same rule candor-sarif ships. Documents are matched by path SUFFIX (the
// workspace root need not equal the report's root).
function locParts(loc) {
  if (typeof loc !== "string") return null;
  const m = loc.match(/^(.*?):(\d+)/);
  return m ? { file: m[1], line: Math.max(0, parseInt(m[2], 10) - 1) } : null;
}
function candidatePaths(fn, file) {
  if (file.includes("/")) return [file];
  const parts = fn.split(".");
  const cands = [file];
  if (parts.length >= 3) cands.unshift(parts.slice(0, -2).join("/") + "/" + file);
  return cands;
}
function docMatches(docPath, fn, file) {
  const norm = docPath.split(nodePath.sep).join("/");
  return candidatePaths(fn, file).some((c) => norm === c || norm.endsWith("/" + c));
}
/** Every report entry whose loc maps into this document: [{ entry, line }]. Loaded FRESH per call
 *  (the per-request re-read is the freshness design); a caller that already has the report passes
 *  it via `fns` so one request never parses the same file twice. */
function entriesInDoc(docPath, fns = null) {
  if (!hasReport(reportPrefix)) return null;
  const out = [];
  for (const e of (fns ?? Q.loadReport(reportPrefix))) {
    const lp = e.loc && locParts(e.loc);
    if (lp && docMatches(docPath, e.fn, lp.file)) out.push({ entry: e, line: lp.line });
  }
  return out;
}

// The transitive-caller COUNT for an exact fn name over an already-inverted graph. The lenses used
// Q.callers per entry, and every callers() call rebuilt reverseGraph from scratch — a 50-fn document
// over a JVM-scale callgraph did 50 full graph inversions PER codeLens request (review find). One
// inversion per request + a plain BFS; report fn names are exact cg keys, so no match ladder needed.
function transitiveCallerCount(rev, fn) {
  const seen = new Set([fn]);
  const queue = [fn];
  while (queue.length) {
    const n = queue.pop();
    for (const c of rev.get(n) ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c); }
  }
  return seen.size - 1; // minus the target itself
}

// ---- CodeLens ---------------------------------------------------------------------------------------
function codeLenses(docPath) {
  const found = entriesInDoc(docPath);
  if (found === null) return [];
  let rev = null;
  try { rev = Q.reverseGraph(Q.loadCallgraph(reportPrefix)); } catch { /* no callgraph — effects-only lens */ }
  return found.map(({ entry, line }) => {
    const blast = rev ? ` · blast radius ${transitiveCallerCount(rev, entry.fn)}` : "";
    const eff = (entry.inferred || []).join(", ") || "pure";
    return {
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
      command: { title: `⚡ ${eff}${blast}`, command: "" },   // informational lens (no action) — P1
    };
  });
}

// The entry ENCLOSING a line: the report pins each fn at its declaration line, so the match is the
// greatest entry line ≤ the cursor (functions are sequential in a file — a sound approximation that
// needs no parser). Shared by hover and codeAction — one rule for "which function is the cursor in".
function enclosingEntry(docPath, line, fns = null) {
  const found = entriesInDoc(docPath, fns);
  if (!found || !found.length) return null;
  return found.filter((x) => x.line <= line).sort((a, b) => b.line - a.line)[0] ?? null;
}

// ---- Hover: effect provenance at the cursor ----------------------------------------------------------
// For each inferred effect: direct → "performed here"; inherited → the §3.1 `path` chain to the direct
// source. unknownWhy rides along when the fn introduces opacity.
function hoverAt(docPath, line) {
  if (!hasReport(reportPrefix)) return null;
  const fns = Q.loadReport(reportPrefix);          // ONE load per request (enclosingEntry reuses it)
  const at = enclosingEntry(docPath, line, fns);
  if (!at) return null;
  const { entry } = at;
  const cg = Q.loadCallgraph(reportPrefix);
  const lines = [`**${entry.fn}** — ⚡ { ${(entry.inferred || []).join(", ") || "pure"} }`];
  for (const eff of entry.inferred || []) {
    if (eff === "Unknown") continue;                          // covered by unknownWhy below
    if ((entry.direct || []).includes(eff)) {
      lines.push(`- **${eff}** — performed directly here`);
      continue;
    }
    try {
      const hops = (Q.path(fns, cg, entry.fn, eff)?.path || []).map((h) => h.fn.split(/[.:]+/).pop() + (h.source ? " (source)" : ""));
      lines.push(hops.length > 1 ? `- **${eff}** — via ${hops.slice(1).join(" → ")}` : `- **${eff}** — inherited (source is cross-boundary or framework-synthesised)`);
    } catch { lines.push(`- **${eff}** — inherited`); }
  }
  if (entry.unknownWhy?.length) lines.push(`- **Unknown** — ${entry.unknownWhy.join(", ")}`);
  if (entry.invisible?.length) lines.push(`- _invisible_: ${entry.invisible.join(", ")} (unmodeled — the effect set is a lower bound)`);
  try {
    const c = Q.callers(cg, entry.fn);
    lines.push(`\nBlast radius: **${(c?.transitive || []).length}** transitive caller(s)`);
  } catch { /* no callgraph */ }
  return {
    contents: { kind: "markdown", value: lines.join("\n") },
    range: { start: { line: at.line, character: 0 }, end: { line: at.line, character: 200 } },
  };
}

// ---- Diagnostics (the live gate) ---------------------------------------------------------------------
const warned = new Set();
function warnOnce(message) { if (!warned.has(message)) { warned.add(message); logMessage(message); } }
/**
 * ⟨0.32⟩ A LOUDER `warnOnce`, for the causes that are EXIT-BEARING on every other route.
 *
 * Everything `warnOnce` carries today is a disclosure the CLI makes AT EXIT 0 — ⟨0.24⟩ ruled count-0 "a
 * disclosure, not an exit code", the unevaluated-rule rows ride alongside a verdict, and `ignored` does
 * not move `ok`. The incompleteness causes below are the other kind: `gate --report` EXITS 2 over them,
 * `candor_gate` withholds `ok`, and `fix-gate`/`unverified --strict` exit 2. This surface has no exit
 * code and no verdict document, so the whole rung collapses onto messages — and putting the LOUDER cause
 * on the QUIETER channel (an output pane the developer has to go and open) would invert an ordering the
 * other four routes agree on. So: the log line carries the detail and the repair, and a `window/
 * showMessage` says that CI is red over these bytes. Both are `warnOnce`-deduped on the LOG text, which
 * is a function of the policy and the report rather than of the edit, so a save loop cannot turn either
 * into the per-keystroke noise that gets an advisory switched off.
 */
function warnLoudOnce(message, brief) {
  if (warned.has(message)) return;
  warned.add(message);
  logMessage(message);
  showMessage(2, brief);          // Warning — the same severity the activity push uses for a red gate
}
// ⟨0.24⟩ the file `activePolicy()` last read, so the vocabulary anchor can be the POLICY FILE's dir.
let activePolicyPath = null;
function activePolicy() {
  const env = process.env.CANDOR_POLICY;
  if (env) {
    if (fs.existsSync(env)) { activePolicyPath = env; return fs.readFileSync(env, "utf8"); }
    // Set-but-missing must be LOUD (the family's configured-but-unusable posture — scan exits 2 here).
    // This is an advisory surface, so: disclose the policy-source swap, then fall through to discovery.
    warnOnce(`candor-lsp: CANDOR_POLICY is set but ${env} does not exist — falling back to .candor/config discovery (diagnostics may reflect a different policy than you configured)`);
  }
  const from = reportPrefix ? nodePath.dirname(nodePath.resolve(reportPrefix)) : rootPath;
  const cfg = from ? discoverConfigPolicy(from) : null;
  if (cfg && fs.existsSync(cfg.policyPath)) { activePolicyPath = cfg.policyPath; return fs.readFileSync(cfg.policyPath, "utf8"); }
  activePolicyPath = null;
  return null;
}

/**
 * ⟨0.24⟩ ONE policy PARSE for this surface — the LSP twin of query.mjs's `loadPolicyOrDie` and mcp.mjs's
 * `policyOrThrow`, and it closes the same drift. Every call site here parsed with NO alias map, so a rule
 * written against a checked-in `unknown-alias` was silently WIDENED to the bare effect: the editor drew
 * squiggles for a class the operator had deliberately excluded, and drew none for the one they had named.
 * The vocabulary anchors at the POLICY FILE, as it does on both CLI routes, so the same policy means the
 * same thing in the editor and in the gate that judges the edit.
 *
 * On a policy this engine CANNOT HONOUR AS WRITTEN (§6.2 `be0b9a9`), it returns null and says so ONCE.
 * This surface has no exit code, so the enforcement posture cannot be borrowed wholesale — but evaluating
 * a policy the engine has silently rewritten is the fail-open the ruling exists to close, and it is worse
 * here than elsewhere because a squiggle that does not appear is invisible. What the disclosure buys is
 * that the empty editor is EXPLAINED rather than read as a clean bill of health, which is the same
 * argument this file already makes about a report that judged nothing.
 */
function activePolicyParsed(text) {
  const errs = [];
  const aliases = parseUnknownAliases(discoverConfigText(policyVocabularyAnchor(activePolicyPath, rootPath || process.cwd())), errs);
  const pol = parsePolicy(text, aliases);
  errs.push(...pol.errors);
  // ⟨0.24⟩ FATAL only: `errors` also carries every LINE the parser dropped whole (SPEC §3.1
  // `195d45a`) — additive to the `parsepolicy` witness, deliberately silent about the gate.
  const fatal = fatalPolicyErrors(errs);
  if (!fatal.length) return pol;
  warnOnce(`candor-lsp: ${policyErrorText(activePolicyPath ?? "(policy)", fatal)}\n  No gate diagnostics are produced from it — their ABSENCE here is the refusal, not an all-clear.`);
  return null;
}
// ⟨0.28⟩ SPEC §2/§6.2 — DID THIS CONFIGURED POLICY ASK ANYTHING AT ALL? Every rule vector, never a
// subset: keying on `deny` alone would call an ordinary allow-only or forbid-only gate empty.
const policyAskedNothing = (pol) => !!pol && !pol.deny.length && !pol.allow.length && !pol.forbid.length
  && !(pol.only ?? []).length;   // ⟨0.29⟩ an `only`-only policy is ARMED
// The editor has no exit code and no JSON document, so both of this rung's channels collapse onto the
// one it does have. Same `warnOnce` shape (and same reasoning) as the judged-nothing warning below: there
// is no line to pin it to, and a per-keystroke popup is how an advisory gets turned off.
const zeroRulePolicyWarn = (what) =>
  warnOnce(`candor-lsp: ${policyZeroRules(activePolicyPath ?? "(policy)").why} — every line was ignored, the `
    + `file is empty, or it holds only comments. ${what} A policy with no rules ASKS NOTHING, so the silence `
    + `here is NOT an all-clear: \`gate\` REFUSES over this policy outright (exit 2, SPEC §6.2). If you did `
    + `not mean to gate, remove the policy configuration rather than pointing it at a file with no rules.`);

/**
 * ⟨0.21⟩/⟨0.30⟩/⟨0.32⟩ THE INCOMPLETENESS CAUSES, ON THE ROUTE THAT CARRIED NONE OF THEM.
 *
 * MEASURED at `9f22581` — the commit titled "four routes, one rule", where there were FIVE. Over a
 * report whose `excluded` records a `dist/shipped.js` running `curl … | sh` that the scan never opened,
 * under a discovered `deny Exec`: `gate --report` exits 2 naming the class, the MCP `candor_gate` tool
 * withholds `ok`, and this server published `[]` — no diagnostic, no log line, no message. `lsp.mjs` had
 * zero occurrences of `excluded`, `peeked` or `unread`, and it is silent on the ⟨0.21⟩ and ⟨0.30⟩ causes
 * for the same reason: `diagnosticsFor` read NO completeness key at all. This is the SHIPPED EDITOR
 * EXPERIENCE — `integrations/vscode` and the JetBrains plugin both bundle this exact server — so the
 * cardinal sin arrived in the place with the fewest ways to notice it: an editor showing a clean file
 * over code nothing read. The argument was already in this file four lines below, about a different
 * cause: "an empty editor reads as 'the gate is green'".
 *
 * ONE RULE, NOT A SIXTH SPELLING OF IT. The condition is the CLI gate's, read off the same
 * `reportCompleteness` value the CLI and MCP routes read, applied ONCE:
 *
 *   · `unread` (⟨0.32⟩) is gated on `pol.deny.length` — only a `deny`/`pure` rule's answer depends on
 *     code outside the scan's scope, so refusing an `allow`/`forbid`/`only` policy for want of a peek
 *     would be an over-charge. `pure` RIDES the deny vector (parsePolicy pushes it there), so the test
 *     is `deny.length` and not a search for the token, and flattening that away would delete the rule
 *     for every `pure`-only policy.
 *   · `unanalyzed` (⟨0.21⟩) and `outOfScope` (⟨0.30⟩) are UNCONDITIONAL, exactly as they are on the CLI
 *     gate: a unit candor could not read is unread whatever the policy asks, and `outOfScope` is by
 *     construction the peek's findings UNDER the producer's own policy.
 *
 * ALL THREE, not just the one this rung is named for. They are one `gincomplete` disjunction on the CLI
 * and one `incomplete` on the MCP tool; carrying one of three into this route would have left the same
 * defect, in the same function, for the next audit to find — which is the habit this whole rung exists
 * to break. Each cause is NAMED ONLY WHEN IT FIRED, the MCP tool's rule: a sentence about unanalyzed
 * code beside an incompleteness that is really an unopened `dist/` sends the reader to the wrong repair.
 *
 * NO DIAGNOSTIC IS DRAWN, and that is the answer to "a squiggle on what". There is no source range for a
 * file the scan never opened: the code is absent from `functions` precisely because nothing looked, so
 * the only line available is line 0 of whatever document happens to be open — which would attribute the
 * hole to an innocent file, in every language the client maps, on every open. That is the fabrication
 * mirror of the silence being fixed. The ⟨0.24⟩ judged-nothing hedge reached the same conclusion for the
 * same reason ("there is no line to pin it to"); the activity overlay's line-0 diagnostic is not a
 * counter-example, because its record NAMES the edited file and this one names no file in the workspace.
 */
// `certainViolation`: SPEC §3.1's precedence (`query.mjs`'s `gate --report`: violation (1) > refusal (2) >
// incomplete (2)) means a policy violation ELSEWHERE in this same report makes the real exit 1, not the 2
// this function used to assert unconditionally. Measured: a report with an unread file AND a certain `Fs`
// violation exits 1 over `gate --report` — the incompleteness is still real and still unjudged, but "exits
// 2 (INCOMPLETE)" / "CI exits 2 over these bytes" is a wrong, checkable claim in exactly that case. Two
// fixtures with the identical unread-file cause differ only in whether a violation coexists, and only the
// violation-free one made this text true.
function discloseIncompleteness(unanalyzed, outOfScope, unread, unaskedRules, certainViolation) {
  const causes = [];
  // The CLI's order (`unanalyzed` → `outOfScope` → `unread` → `unaskedRules`), so a report tripping two
  // of them reads the same way here as it does in CI. The repairs genuinely differ — a parse to fix, a
  // selector that REACHES the code, a scan that was ASKED the question, a scan asked the SAME question —
  // so each cause carries its own.
  if (unanalyzed.length)
    causes.push(`the report DECLARES ${unanalyzed.length} unit(s) candor could not analyze, and a gate `
      + `cannot be green over unanalyzed code:\n`
      + unanalyzed.map((u) => `        ${u.path || "(unnamed unit)"}${u.reason ? `  (${u.reason})` : ""}`).join("\n"));
  if (outOfScope.length)
    causes.push(`the report names ${outOfScope.length} function(s) OUTSIDE the scan's scope performing `
      + `an effect this policy denies (the producer's peek found them). The gate did not judge them, so the verdict is `
      + `INCOMPLETE rather than a pass — re-scan with a selector that REACHES that code:\n`
      + outOfScope.map((o) => `        ${o.fn} performs ${(o.effects ?? []).join(", ")}`).join("\n"));
  if (unread.length)
    causes.push(`the scan did not READ ${unread.join(", ")}. Those files' effects are absent from the `
      + `report because nothing looked, not because there are none, so nothing in them can be squiggled `
      + `here — re-scan the sources WITH this policy (candor-ts <dir> --policy <file>); a scan that was `
      + `never asked cannot certify what it never opened.`);
  // ⟨0.33⟩ SPEC §2 ⟨0.33⟩ — a class the peek DID read, but under a deny set that does not cover this
  // policy's own. Distinct from `unread` above: that is "nothing looked", this is "something looked, for
  // a narrower question than the one this editor is asking now" — the peek is bounded to the PRODUCER's
  // denied effects (⟨0.29⟩), so an empty finding there answers nothing about a rule it was never put.
  if (unaskedRules?.length)
    causes.push(`this report's peek was bounded by the deny set its producing scan held, and that set `
      + `does not cover ${unaskedRules.length} rule(s) of this policy: ${unaskedRules.join(", ")}. The `
      + `excluded files it reports as read were searched for OTHER effects, so nothing in them can be `
      + `squiggled here — re-run the producing scan under THE SAME policy this editor is applying `
      + `(candor-ts <dir> --policy <file>), not merely under a policy.`);
  if (!causes.length) return;
  // ⟨lsp-precedence⟩ the exit-code claim is conditional on whether a certain violation ALSO fires: if one
  // does, Lemma 2 makes it dominate (exit 1), and the incompleteness below is true but not what CI is red
  // over. See `certainViolation`'s definition above.
  const exitClaim = certainViolation
    ? `a certain policy violation ELSEWHERE in this report makes \`gate --report\` over the same bytes exit `
      + `1 — SPEC §3.1's precedence has a firing rule dominate a refusal, so CI is red on THAT, not on this. `
      + `The incompleteness below is still real and still unjudged; it is just not what the exit code names`
    : `\`gate --report\` over the same bytes exits 2 (INCOMPLETE), so the squiggles in this editor are NOT `
      + `the whole verdict`;
  const briefClaim = certainViolation
    ? `candor gate: a certain violation elsewhere in this report already makes CI exit 1 over these bytes — `
      + `but this report ALSO has unjudged code (see the candor log); fixing the violation alone will not `
      + `make it complete.`
    : `candor gate: INCOMPLETE — this report cannot support a green verdict (CI exits 2 over these bytes). `
      + `See the candor log for what went unjudged and how to fix it.`;
  warnLoudOnce(
    `candor-lsp: this report cannot support a GREEN gate — ${exitClaim}:\n`
    + causes.map((c) => `    · ${c}`).join("\n")
    + `\n  NO diagnostic can be drawn for any of the above: the code it names is not in the report, so it `
    + `has no line in this editor to sit on. Its ABSENCE from the squiggles is the incompleteness itself, `
    + `not an all-clear.`,
    briefClaim);
}

function diagnosticsFor(docPath) {
  const text = activePolicy();
  if (text === null || !hasReport(reportPrefix)) return [];
  const fns = Q.loadReport(reportPrefix);
  // ⟨0.24⟩ A report that JUDGED NOTHING is not a clean bill of health, and this surface is where that is
  // hardest to notice: the live gate's whole vocabulary is squiggles, and a report with `analyzed.count: 0`
  // has no entries, so it produces none — an empty editor reads as "the gate is green" when the truth is
  // that nothing was ever judged. SPEC §2's three-row table, bound here by §3.1 ⟨0.24⟩ ("the obligation is
  // on the reading, not on the route by which the report arrived"); this route takes a `report` locator,
  // so a FOREIGN report arrives by it. The channel is the LOG and `warnOnce` rather than a diagnostic on
  // every publish, because there is no line to pin it to and a per-keystroke popup is how an advisory gets
  // turned off. The verdict is untouched: no effect is asserted that the report does not carry.
  if (Q.reportJudgedNothing(reportPrefix))
    warnOnce(`candor-lsp: the report at ${reportPrefix} judged NOTHING (⟨0.24⟩ \`analyzed.count\` is 0, absent with no `
      + `entries, or unreadable) — no gate diagnostics can come from it, and their absence is NOT an all-clear: `
      + `absence from \`functions\` licenses no purity claim about any unit. Re-scan the sources you meant to gate `
      + `(candor-ts <src> --out ${reportPrefix}).`);
  // ⟨0.24⟩ `netClass` VERBATIM off the wire — the same report-route rule as the MCP `candor_gate` tool and
  // `gate --report`; re-deriving it here would answer with the CONSUMER's `net-partner` evidence about the
  // producer's project, in both the fabricating and the fail-open direction (see reportNetClasses).
  const dpol = activePolicyParsed(text);
  if (dpol === null) return [];
  // ⟨0.28⟩ …and a CONFIGURED policy that parsed to ZERO RULES produces no squiggles either, which in an
  // editor is indistinguishable from a gate that ran and found nothing — §6.2's harm on the surface where
  // it is least visible, since the live gate's entire vocabulary IS the absence or presence of squiggles.
  if (policyAskedNothing(dpol))
    zeroRulePolicyWarn("No gate diagnostics can come from it.");
  // ⟨0.28⟩ SPEC §6.2 — …AND THE LINES THE PARSE DROPPED, which is the same clause one fraction down: the
  // zero-rule warning above fires only at ZERO survivors, so a policy where three of four lines were
  // dropped produced the surviving rule's squiggles and nothing else. In an editor that reads as the
  // whole gate, because squiggles ARE this surface's entire vocabulary. The CLI routes carry `ignored`
  // on the verdict document; here there is no document, so the log channel carries it — once, with the
  // line numbers, so the operator can go to them.
  else if (dpol.ignored?.length)
    warnOnce(`candor-lsp: ${dpol.ignored.length} line(s) of the configured policy were DROPPED by the `
      + `parse, so the gate you are seeing is SMALLER than the gate that was written (SPEC §6.2 ⟨0.28⟩):\n`
      + dpol.ignored.map((g) => `    line ${g.line}: ${g.text}`).join("\n"));
  // ⟨0.21⟩/⟨0.30⟩/⟨0.32⟩/⟨0.33⟩ …AND THE CAUSES THAT MAKE THE GATE ITSELF INCOMPLETE — see
  // `discloseIncompleteness` for the mechanism and the channel argument. Read through the SAME
  // `reportCompleteness` the CLI gate, `fix-gate`, `unverified` and the MCP tools read, so the editor
  // cannot come to a different view of one report from the CI job that judges the same commit. `dpol.deny`
  // rides along so `reportUnaskedRules` can compare THIS policy's own rules against the report's
  // `scannedUnder` — the identical value the CLI reads for the same bytes (SPEC §2 ⟨0.33⟩). The `unread`
  // condition is applied HERE, to the value, for the reason the CLI states at its own call site: one
  // list, one condition, so two consumers of it cannot disagree about a run.
  const dcomp = Q.reportCompleteness(reportPrefix, dpol.deny);
  // Cheap, side-effect-free pre-check for `discloseIncompleteness`'s exit-code wording (see its own
  // comment): does THIS report already carry a certain violation, over the WHOLE report the way
  // `gate --report` reads it, not just this one document? A redundant pass over an already-loaded report
  // — the real one runs again below, where its `dunevaluated`/`violations` are also needed for the
  // diagnostics themselves and for OTHER `warnOnce` lines whose relative order this must not disturb.
  const dwp0 = wholePolicyUnanswerable(dpol, "the editor's report route");
  const dunits0 = reportUnits(fns);
  const dnet0 = reportNetClasses(fns, { authoritative: true, units: dunits0 });
  const { withhold: dwithhold0 } = unanswerableScoped(dpol, fns,
    resolveReasonClasses(fns, Q.loadCallgraph(reportPrefix), dunits0), dnet0, dunits0);
  const certainViolation = evaluatePolicy(dwp0.answerable, fns, Q.loadCallgraph(reportPrefix),
    new Map(), new Set(), dnet0, dwithhold0, dunits0).length > 0;
  discloseIncompleteness(dcomp.unanalyzed ?? [], dcomp.outOfScope ?? [],
                         dpol.deny.length ? (dcomp.unread ?? []) : [], dcomp.unaskedRules ?? [], certainViolation);
  // ⟨0.24⟩ THE ANSWERABILITY WITHHOLD, which this surface ran WITHOUT — `evaluatePolicy` was called with no
  // `withhold` predicate and the DEFAULT netClass mode, so both directions of the §3.1 harm were live in the
  // editor. Measured against the CLI on one report and one policy: `deny Unknown[reflect]` drew NO squiggle
  // where `gate --report` exits 2 (a squiggle that does not appear is the least visible false all-clear this
  // project has), and `deny Net[unknown-host]` drew one whose message ASSERTS a destination class the report
  // never carried. `authoritative: true` for the same reason the MCP gate takes it: an entry without
  // `netClass` gets the EMPTY set rather than a derivation from `hosts`, so the report is the only source of
  // the class and nothing is re-classified with this machine's evidence about the producer's project.
  // ⟨0.32⟩ the same unit identity the CLI gate uses over these bytes (SPEC §2.2).
  const dunits = reportUnits(fns);
  const dnet = reportNetClasses(fns, { authoritative: true, units: dunits });
  const { unevaluated: dunevaluated, withhold: dwithhold } =
    unanswerableScoped(dpol, fns, resolveReasonClasses(fns, Q.loadCallgraph(reportPrefix), dunits), dnet, dunits);
  // ⟨0.29⟩ `forbid`/`allow` are STRIPPED and DISCLOSED here too. This path handed the whole policy to
  // `evaluatePolicy`, so an editor drew AS-EFF-009 squiggles from a report — evidence SPEC §3.1 rules
  // cannot support them — or, with no sidecar, drew nothing and said nothing, which reads as "no layering
  // problem here". `dunevaluated` was deny-only, so neither case produced even a log line. Same defect as
  // the MCP tool, same shared helper, because these two are each other's siblings as much as the CLI's.
  const dwp = wholePolicyUnanswerable(dpol, "the editor's report route");
  dunevaluated.push(...dwp.unevaluated);
  // The surface has no exit code, so the refusal is carried the way this file already carries its other two
  // (the unhonourable policy, the judged-nothing report): ONE log line naming the rules, so the missing
  // squiggle is EXPLAINED rather than read as a clean bill of health. Per rule, not per keystroke — warnOnce
  // keys on the message, and the message is a function of the policy and the report, not of the edit.
  // NAME THE RULE, not just its kind. The message used to carry `why` alone — "this policy has 1
  // `forbid` rule(s), which … cannot evaluate" — which tells a developer a category and leaves them to
  // guess which line of their policy went unenforced. In an editor that is the whole cost of the refusal:
  // the squiggle is absent either way, and the message is the only thing standing in for it.
  for (const u of dunevaluated)
    warnOnce(`candor-lsp: ${u.why}\n  NO diagnostics are drawn for that rule — their ABSENCE here is the refusal, not an all-clear.`);
  const violations = evaluatePolicy(dwp.answerable, fns, Q.loadCallgraph(reportPrefix),
                                    new Map(), new Set(), dnet, dwithhold, dunits);
  const locByFn = new Map(fns.filter((e) => e.loc).map((e) => [e.fn, locParts(e.loc)]));
  const out = [];
  for (const v of violations) {
    const lp = locByFn.get(v.fn);
    if (!lp || !docMatches(docPath, v.fn, lp.file)) continue;
    out.push({
      range: { start: { line: lp.line, character: 0 }, end: { line: lp.line, character: 200 } },
      severity: v.rule === "AS-EFF-007" ? 2 : 1,   // the advisory code is a warning, the rest errors
      source: "candor",
      code: v.rule,
      message: v.detail || `${v.fn} violates ${v.rule}`,
    });
  }
  return out;
}
function publishDiagnostics(uri) {
  let docPath;
  try { docPath = fileURLToPath(uri); } catch { return; }
  try {
    // three layers, merged: the standing gate verdict + the client's whatif/fix overlay (keyed by the
    // client's uri string) + the activity gate overlay (keyed by the canonical path derived from the
    // uri being published — so the lookup meets the tailer's server-computed key whatever the client's
    // uri encoding looks like).
    const diags = diagnosticsFor(docPath)
      .concat(transient.get(uri) ?? [])
      .concat(activityTransient.get(canonicalDocKey(docPath)) ?? []);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diags } });
  } catch (e) {
    logMessage(`candor-lsp: diagnostics failed for ${uri}: ${e.message}`);
  }
}
function logMessage(message) { send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 2, message } }); }
function showMessage(type, message) { send({ jsonrpc: "2.0", method: "window/showMessage", params: { type, message } }); }

// ---- CodeAction: the pre-edit whatif (spec §3.1 whatif, rendered as an editor action) -----------------
// From a position inside a function the report knows, offer "what if <fn> performed <E>?" for each
// BOUNDARY effect (Q.CONTAINED — ambient effects gate nothing) the fn does not already carry. The action
// carries a plain `command` (no client-side resolve, no edit) so it works in any LSP client verbatim.
const WHATIF_COMMAND = "candor.whatif";
const FIX_COMMAND = "candor.fix";
function codeActions(docPath, uri, range) {
  const at = enclosingEntry(docPath, range?.start?.line ?? 0);
  if (!at) return [];                                  // a fn the report doesn't know → no actions, never an error
  const have = new Set(at.entry.inferred || []);
  const out = [];
  for (const eff of Q.CONTAINED) {                     // ≤6 boundary effects — the natural cap
    if (have.has(eff)) continue;
    out.push({
      title: `candor: what if ${at.entry.fn} performed ${eff}?`,
      command: {
        title: `candor: what if ${at.entry.fn} performed ${eff}?`,
        command: WHATIF_COMMAND,
        arguments: [{ fn: at.entry.fn, effect: eff, uri, line: at.line }],
      },
    });
  }
  // The REMEDIAL companion (integrations/FIX-SPEC.md): for each BOUNDARY effect the fn ALREADY performs that
  // the active policy FORBIDS here, offer the FIX — where the effect belongs + the hoist. Only real crossings
  // are offered (Q.fix returns `crossing:false` otherwise), so this is empty unless the cursor sits in a
  // function that actually violates the boundary. Same policy source as the diagnostics + the whatif action.
  const policyText = activePolicy();
  if (policyText !== null && hasReport(reportPrefix)) {
    const pol = activePolicyParsed(policyText);
    if (pol === null) return out;
    const cg = Q.loadCallgraph(reportPrefix);
    const fns = Q.loadReport(reportPrefix);
    for (const eff of Q.CONTAINED) {
      if (!have.has(eff)) continue;
      const r = Q.fix(cg, fns, at.entry.fn, eff, pol, scopeMatches);
      if (r && r.crossing) {
        out.push({
          title: `candor fix: hoist ${eff} out of ${at.entry.fn}`,
          command: {
            title: `candor fix: hoist ${eff} out of ${at.entry.fn}`,
            command: FIX_COMMAND,
            arguments: [{ fn: at.entry.fn, effect: eff, uri, line: at.line }],
          },
        });
      }
    }
  }
  return out;
}

// Transient whatif/fix diagnostics (Information severity, appended to the gate diagnostics on publish):
// uri -> Diagnostic[]. Cleared on the next didOpen/didSave/didChange of that file; re-running the
// action replaces the previous answer (one live whatif overlay per file, not an accumulating pile).
// Keyed by the CLIENT's uri string on both sides (the set comes from executeCommand arguments that
// echo the client's own uri; the clear reads the same field) — no canonicalization needed here, unlike
// activityTransient whose setter computes its own paths (see canonicalDocKey).
const transient = new Map();
function clearTransient(uri) {
  if (transient.delete(uri)) publishDiagnostics(uri);   // republish without the overlay
}
// didOpen/didSave drop BOTH per-file overlays: the client's whatif/fix answer (a fresh look at the
// file invalidates a hypothetical answered against its previous state) and the activity gate overlay
// (same rationale — plus pruning activityOverlaid so a later clean record can't touch a file whose
// overlay the user already dismissed). The activity side goes through canonicalDocKey to meet the
// tailer's server-computed keys.
function clearOverlays(uri) {
  transient.delete(uri);
  try {
    const key = canonicalDocKey(fileURLToPath(uri));
    activityTransient.delete(key);
    activityOverlaid.delete(key);
  } catch { /* non-file uri — no activity overlay possible */ }
}

// The candor.whatif command: the SAME query-core whatif the CLI (`query.mjs whatif`) and MCP
// (`candor_whatif`) run — blast radius over the callgraph + the deny rules that WOULD fire, against the
// live policy (CANDOR_POLICY / .candor/config discovery, same source as the diagnostics). Everything is
// re-read per call (the freshness contract). Malformed args → logMessage + null, never a throw.
function runWhatif(a) {
  if (!a || typeof a !== "object" || typeof a.fn !== "string" || typeof a.effect !== "string") {
    logMessage(`candor-lsp: ${WHATIF_COMMAND} called with malformed arguments (expected [{ fn, effect, uri?, line? }]) — ignored`);
    return null;
  }
  if (!hasReport(reportPrefix)) {
    showMessage(2, "candor: no report found — scan first (candor-ts <dir> --out .candor/report)");
    return null;
  }
  const policyText = activePolicy();
  const wpol = policyText === null ? null : activePolicyParsed(policyText);
  const r = Q.whatif(Q.loadCallgraph(reportPrefix), a.fn, a.effect, wpol, scopeMatches);
  if (r === null) {
    showMessage(2, `candor: no function matching \`${a.fn}\` in the call graph — the report may be stale`);
    return null;
  }
  // ⟨0.28⟩ SPEC §2 — a CONFIGURED policy that yielded zero rules asked nothing, and `✓ no policy rule
  // fires` IS the prose spelling of `ok: true`. The pre-edit verdict is withheld on both this channel and
  // the executeCommand RESULT (a thick client renders that); the blast radius is not a policy claim, so it
  // is still counted in the message the operator gets. A policy that is NOT configured keeps its own
  // "no policy discovered" wording below — that is the honest way to say "I am not gating".
  if (policyAskedNothing(wpol)) {
    zeroRulePolicyWarn("No pre-edit verdict can come from it.");
    const zcallers = r.affected.filter((f) => !r.of.includes(f));
    showMessage(2, `candor: the configured policy has NO RULES — no pre-edit verdict (blast radius only: `
      + `${zcallers.length} caller(s) would inherit ${a.effect})`);
    return { unevaluated: policyZeroRules(activePolicyPath ?? "(policy)").unevaluated };
  }
  // PART 70 — this command returned the RAW `r` unconditionally, so the shipped editor experience
  // (VS Code + JetBrains both bundle this server) certified `ok` over bytes `gate --report` refuses on:
  // the ⟨0.30⟩/⟨0.32⟩/⟨0.33⟩ scope causes never reached this route at all. Read off the SAME
  // `reportCompleteness` the CLI whatif and `candor_whatif`/`diagnosticsFor` use, `unread` gated on this
  // call's OWN `deny`/`pure` rules exactly as those two gate it — so the three channels cannot disagree
  // about one report. `discloseIncompleteness` is the SAME log+showMessage channel `diagnosticsFor`
  // already uses for the standing gate squiggles (dedup on the message text), so a report already
  // disclosed there says nothing new here, and one not yet seen surfaces on the FIRST channel that asks.
  const wcomp = Q.reportCompleteness(reportPrefix, wpol?.deny ?? []);
  const wUnread = wpol?.deny?.length ? (wcomp.unread ?? []) : [];
  const wUnasked = wcomp.unaskedRules ?? [];
  discloseIncompleteness(wcomp.unanalyzed ?? [], wcomp.outOfScope ?? [], wUnread, wUnasked);
  const callers = r.affected.filter((f) => !r.of.includes(f));   // affected minus the target(s) themselves
  const rules = [...new Set(r.violations.map((v) => v.rule))];
  // ⟨0.24⟩ THE EDITOR IS A CHANNEL THIS VERB ANSWERS ON, so the `conditional` has to reach it or this
  // surface becomes the one place the defect still lives — and it is the sharpest place for it, because
  // `rules[0]` is now the operator's RAW line. Without the condition the squiggle would read
  // `✗ deny Net[unknown-host] app would fire`: a narrowed rule beside an unconditional verdict, which SPEC
  // §3.1 calls WORSE than printing the rule stripped of its filter, since it reads as a narrowing candor
  // evaluated and did not.
  const condOf = new Map(r.violations.filter((v) => v.conditional).map((v) => [v.rule, v.conditional]));
  const verdict = policyText === null
    ? `candor: no policy discovered — blast radius only: ${callers.length} caller(s) would inherit ${a.effect}`
    : rules.length
      ? `✗ ${rules[0]} would fire${condOf.has(rules[0]) ? ` IF ${condOf.get(rules[0])}` : ""} — ${callers.length} caller(s) inherit ${a.effect}`
      : `✓ no policy rule fires — ${callers.length} caller(s) would inherit ${a.effect}`;
  showMessage(rules.length ? 2 : 3, verdict);                    // warning when a rule fires, info otherwise
  if (typeof a.uri === "string" && Number.isInteger(a.line)) {   // the detail, pinned at the fn's line
    const head = callers.slice(0, 10);
    const lines = [`what if ${r.of.join(", ")} performed ${a.effect}? ${verdict}`];
    if (rules.length > 1) lines.push(`rules: ${rules.join("; ")}`);
    // The one-liner has room for the condition but not for WHY there is one; the pinned detail has room for
    // both, and the reason is the half that stops an operator reading a fail-closed hedge as a false alarm.
    for (const [rule, c] of condOf)
      lines.push(`conditional — \`${rule}\` fires IF ${c}. That rule NARROWS, and the effect you have not `
                 + "written yet has no class to match, so candor charges it fail-closed rather than guessing "
                 + "which class your edit would land in.");
    lines.push(head.length
      ? `callers: ${head.join(", ")}${callers.length > head.length ? ` +${callers.length - head.length} more` : ""}`
      : "no callers — the blast radius is the function itself");
    transient.set(a.uri, [{
      range: { start: { line: a.line, character: 0 }, end: { line: a.line, character: 200 } },
      severity: 3, source: "candor", code: "whatif", message: lines.join("\n"),
    }]);
    publishDiagnostics(a.uri);
  }
  // PART 70 — the executeCommand RESULT is the document a thick client renders, so it takes the SAME
  // `ok`-withdrawal the CLI and `candor_whatif` apply: `incomplete: true` in its place, `affected`/
  // `violations` (and the one-liner/diagnostic above, built off the raw `r`) unchanged. A no-op on a
  // complete report — byte-identical to the pre-fix `return r` — so every fixture without a scope cause
  // is untouched.
  return Q.advisoryAnswer(r, wcomp.unanalyzed, wcomp.judgedNothing, wcomp.unreadable, wcomp.noManifest,
                          wcomp.outOfScope ?? [], wUnread, wUnasked);
}

// The candor.fix command: the SAME query-core `fix` the CLI (`query.mjs fix`) and MCP (`candor_fix`) run —
// the boundary remedy (where the effect belongs + the hoist refactor), against the live policy (same source
// as the diagnostics). Re-read per call (the freshness contract). Malformed args → logMessage + null.
function runFix(a) {
  if (!a || typeof a !== "object" || typeof a.fn !== "string" || typeof a.effect !== "string") {
    logMessage(`candor-lsp: ${FIX_COMMAND} called with malformed arguments (expected [{ fn, effect, uri?, line? }]) — ignored`);
    return null;
  }
  if (!hasReport(reportPrefix)) {
    showMessage(2, "candor: no report found — scan first (candor-ts <dir> --out .candor/report)");
    return null;
  }
  const policyText = activePolicy();
  if (policyText === null) {
    showMessage(2, "candor: no policy discovered — a fix is defined relative to a boundary; set CANDOR_POLICY or check one into .candor/config");
    return null;
  }
  const fpol = activePolicyParsed(policyText);
  if (fpol === null) return null;
  // ⟨0.28⟩ SPEC §2 — the same caveat, before any `crossing` reading: `${a.effect} isn't forbidden here`
  // from a policy that forbids nothing is vacuously true, and this surface is the one that ASKED for a
  // fix. No `crossing` key on the result either — present exactly when the verb answered.
  if (policyAskedNothing(fpol)) {
    zeroRulePolicyWarn("No boundary fix can be computed from it.");
    showMessage(2, `candor: \`${a.fn}\` — no fix computed: the configured policy has NO RULES, so there is `
      + `no boundary to have crossed. The absence of a plan here is the caveat, not an all-clear.`);
    return { unevaluated: policyZeroRules(activePolicyPath ?? "(policy)").unevaluated };
  }
  const r = Q.fix(Q.loadCallgraph(reportPrefix), Q.loadReport(reportPrefix), a.fn, a.effect,
                  fpol, scopeMatches);
  if (r === null) {
    showMessage(2, `candor: no function matching \`${a.fn}\` in the call graph — the report may be stale`);
    return null;
  }
  // ⟨0.24⟩ SPEC §3.2 `4fd140c` — THE REFUSAL, BEFORE the `crossing` test and not folded into it. `Q.fix`
  // now returns `{refused:true, unevaluated}` with NO `crossing` key where the gate could not adjudicate the
  // boundary, and a falsy-`crossing` reading of that lands on "isn't forbidden here; no boundary fix
  // needed" — the derived second opinion, delivered as a clean bill of health, on the surface that ASKED
  // for a fix. Same disclosure the diagnostics path already makes (dunevaluated), repeated here because a
  // code action can be invoked on a file whose diagnostics were never published.
  if (r.refused) {
    showMessage(2, `candor: \`${a.fn}\` — no fix computed: the gate could NOT judge ${a.effect} here (this report does not carry the evidence the policy narrows on), and a hoist plan for a boundary the gate could not adjudicate would rest on a guess`);
    for (const u of r.unevaluated ?? [])
      logMessage(`candor-lsp: ${u.why}\n  NO fix is offered for that rule — the ABSENCE of a remedy here is the refusal, not an all-clear.`);
    return r;
  }
  if (!r.crossing) {
    showMessage(3, `candor: \`${a.fn}\` — ${a.effect} isn't forbidden here; no boundary fix needed`);
    return r;
  }
  const verdict = r.cleanHoist
    ? `candor fix: hoist ${a.effect} to ${r.hoistTo.join(", ")} — the ${r.deniedSpan.length} ${r.layer || "(root)"} function(s) then stay pure (or relax the boundary: ${r.policyAlternative})`
    : `candor fix: no clean hoist for ${a.effect} — introduce a port, or relax the boundary: ${r.policyAlternative}`;
  showMessage(2, verdict);
  if (typeof a.uri === "string" && Number.isInteger(a.line)) {   // the plan, pinned at the fn's line
    const lines = [`candor fix — hoist ${a.effect} out of the ${r.layer || "(root)"} boundary`];
    lines.push(`site: ${r.site.join(", ") || "(cross-module or Unknown source)"}`);
    if (r.cleanHoist) {
      lines.push(`hoist ${a.effect} to: ${r.hoistTo.join(", ")}`);
      lines.push(`then pure (thread the value): ${r.deniedSpan.join(", ")}`);
      if (r.hoistHigher?.length) {
        lines.push(`or hoist higher (up to ${r.hoistHigher.slice(0, 4).join(", ")}): keeps the frontier pure too, threads through more signatures`);
      }
    } else {
      lines.push(`no clean hoist — add a thin entry point ABOVE the layer and thread the value down as DATA (provably pure — recommended), OR inject a function/closure (clears deny ${a.effect} but reads as Unknown, which a \`deny ${a.effect} Unknown\` policy still flags; not a trait — candor charges the trait's impl back), OR relax the boundary`);
    }
    lines.push(`policy alternative: ${r.policyAlternative}`);
    transient.set(a.uri, [{
      range: { start: { line: a.line, character: 0 }, end: { line: a.line, character: 200 } },
      severity: 3, source: "candor", code: "fix", message: lines.join("\n"),
    }]);
    publishDiagnostics(a.uri);
  }
  return r;   // the raw remedy rides back as the executeCommand result (a thick client can render it)
}

// ---- the LSP method surface ---------------------------------------------------------------------------
function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    if (params?.rootUri) { try { rootPath = fileURLToPath(params.rootUri); } catch { /* keep null */ } }
    else if (params?.rootPath) rootPath = params.rootPath;
    if (params?.initializationOptions?.report) reportPrefix = params.initializationOptions.report;
    if (!reportPrefix && rootPath) {
      const cand = nodePath.join(rootPath, ".candor", "report");
      if (hasReport(cand)) reportPrefix = cand;
    }
    startActivityWatch();
    return result(id, {
      capabilities: {
        textDocumentSync: { openClose: true, save: true, change: 0 },  // report-backed: buffer edits don't move the map
        codeLensProvider: { resolveProvider: false },
        hoverProvider: true,
        codeActionProvider: { resolveProvider: false },                // actions carry their command inline
        executeCommandProvider: { commands: [WHATIF_COMMAND, FIX_COMMAND] },
      },
      serverInfo: { name: "candor-lsp", version: VERSION },
    });
  }
  if (method === "initialized" || method === "$/cancelRequest" || method === "$/setTrace") return;
  // didOpen/didSave drop the file's transient overlays (whatif/fix + activity gate — clearOverlays);
  // a fresh look at the file (or an edit) invalidates an answer given against its previous state.
  // didChange is not negotiated (change: 0) but is handled defensively for clients that send it anyway
  // (whatif overlay only — the activity overlay clears on open/save or the next clean record).
  if (method === "textDocument/didOpen") { clearOverlays(params.textDocument.uri); return publishDiagnostics(params.textDocument.uri); }
  if (method === "textDocument/didSave") { clearOverlays(params.textDocument.uri); return publishDiagnostics(params.textDocument.uri); }
  if (method === "textDocument/didChange") return clearTransient(params.textDocument.uri);
  if (method === "textDocument/didClose")
    return send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
  if (method === "textDocument/hover") {
    try { return result(id, hoverAt(fileURLToPath(params.textDocument.uri), params.position?.line ?? 0)); }
    catch { return result(id, null); }   // hover is best-effort — null, never a crash
  }
  if (method === "textDocument/codeLens") {
    try { return result(id, codeLenses(fileURLToPath(params.textDocument.uri))); }
    catch { return result(id, []); }   // a non-file URI / unreadable report → no lenses, never a crash
  }
  if (method === "textDocument/codeAction") {
    try { return result(id, codeActions(fileURLToPath(params.textDocument.uri), params.textDocument.uri, params.range)); }
    catch { return result(id, []); }   // unknown fn / non-file URI / unreadable report → no actions, never an error
  }
  if (method === "workspace/executeCommand") {
    const handlers = { [WHATIF_COMMAND]: runWhatif, [FIX_COMMAND]: runFix };
    const run = handlers[params?.command];
    if (!run) {
      logMessage(`candor-lsp: unknown command \`${params?.command}\` — this server provides ${WHATIF_COMMAND} and ${FIX_COMMAND}`);
      return result(id, null);
    }
    try { return result(id, run(params?.arguments?.[0])); }
    catch (e) { logMessage(`candor-lsp: ${params?.command} failed: ${e.message}`); return result(id, null); }
  }
  if (method === "shutdown" && activityTimer) clearInterval(activityTimer);
  if (method === "shutdown") return result(id, null);
  if (method === "exit") process.exit(0);
  if (id !== undefined) error(id, -32601, `method not found: ${method}`);
}

// ---- LSP stdio transport (Content-Length framed JSON-RPC) ---------------------------------------------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.slice(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }            // skip an unframed preamble
    const len = parseInt(m[1], 10);
    if (buf.length < headerEnd + 4 + len) return;                     // body not fully arrived
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
    buf = buf.slice(headerEnd + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    try { handle(msg); } catch (e) { if (msg.id !== undefined) error(msg.id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
