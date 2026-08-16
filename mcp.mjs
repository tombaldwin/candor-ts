#!/usr/bin/env node
/**
 * candor-mcp — candor's read-only query surface as an MCP server (roadmap direction #1: candor as
 * agent infrastructure). An agent asks "if I change X, what's the runtime blast radius?" or "what
 * reaches the network?" and gets DETERMINISTIC ground truth from a precomputed report in ~zero
 * exploration tokens — the measured ~700-2000x token win over grepping to the same answer.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio framing), implemented directly
 * so candor-ts's `npx` scan/query path stays dependency-free. Query logic is the shared query-core.mjs
 * (one source of truth with the CLI). The server is QUERY-ONLY (it never scans — the analyzer self-
 * boundary, SPEC §7.12; an agent/hook produces the report, the server reads it: Fs only).
 *
 * The report to query is resolved per call from the tool's `report` arg, else $CANDOR_REPORT, else
 * the first CLI arg. A `<prefix>` names `<prefix>.json` + `<prefix>.callgraph.json`.
 *
 *   CANDOR_REPORT=.candor/report.myCrate.scan  npx -y candor-ts mcp
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";
import * as Q from "./query-core.mjs";
import { discoverConfigPolicy, evaluatePolicy, parsePolicy, scopeMatches, reportNetClasses,
         parseUnknownAliases, discoverConfigText, policyVocabularyAnchor, policyErrorText,
         unanswerableScoped, wholePolicyUnanswerable, resolveReasonClasses, fatalPolicyErrors,
         policyZeroRules } from "./policy.mjs";

const VERSION = createRequire(import.meta.url)("./package.json").version; // single-sourced, like scan.mjs

// CLI: [prefix] [--root <dir>]. `--root` LOCKS the server to a workspace: every report prefix (and
// therefore every policy read, whose confinement root derives from the prefix) must live inside it.
// Without it the confinement is only RELATIVE — the `report` arg is client-chosen, so a client that can
// also plant a parseable report in a target tree could anchor policy reads there (review find).
const CLI_ARGS = process.argv.slice(2);
let WORKSPACE_ROOT = null;
{
  const i = CLI_ARGS.indexOf("--root");
  if (i >= 0) { WORKSPACE_ROOT = nodePath.resolve(CLI_ARGS[i + 1] ?? "."); CLI_ARGS.splice(i, 2); }
}
const DEFAULT_PREFIX = process.env.CANDOR_REPORT || CLI_ARGS[0]
  || (fs.existsSync(".candor") ? ".candor/report" : null);   // the engines' default --out convention

const within = (abs, root) => abs === root || abs.startsWith(root + nodePath.sep);
// hasReport is the shared query-core check — the SAME predicate (Q.isReport) the loader uses, so a
// prefix whose only sibling is `.encountered-*`/`.calibrated.json` can't pass existence yet load zero
// functions (an authoritative-empty result — a silent under-report; review find).
function resolvePrefix(args) {
  const p = args?.report || DEFAULT_PREFIX;
  if (!p) throw new Error("no report prefix: pass `report`, set $CANDOR_REPORT, or give one as the CLI arg");
  if (WORKSPACE_ROOT && !within(nodePath.resolve(p), WORKSPACE_ROOT))
    throw new Error(`report prefix \`${clip(p)}\` is outside the served workspace (--root ${WORKSPACE_ROOT}) — refusing`);
  if (!Q.hasReport(p)) throw new Error(`no report at \`${p}\` (.json or .<crate>.scan.json) — run a candor scan first`);
  return p;
}
// Resolve a BASELINE prefix (candor_diff / candor_gains): the EXISTENCE check stays loud — a typo'd
// baseline that loads [] would diff/gain as an authoritative empty, a silent all-clear on the
// supply-chain alarm — but the --root confinement deliberately does NOT apply. A baseline is read-only
// comparison input the agent explicitly names (a prior-release report is routinely, and correctly, kept
// OUTSIDE the repo tree so the new scan can't clobber it), not a served-workspace resource: nothing is
// anchored to it that --root defends — its policy is never read, only its function/effect rows and
// callgraph sidecar are compared. Confining it broke that legitimate out-of-tree workflow.
function resolveBaseline(p) {
  if (!Q.hasReport(p)) throw new Error(`no report at \`${clip(p)}\` (.json or .<crate>.scan.json) — run a candor scan first`);
  return p;
}
// Truncate a caller-supplied value echoed back in an error (a multi-MB `fn` would otherwise be reflected
// verbatim — token/memory amplification over the agent transport, the opposite of the list-cap thrift).
const clip = (s, n = 120) => { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; };
// Load a report but FAIL LOUD (a thrown tool-level error) when files were FOUND yet nothing parsed —
// Q.loadReport discloses-and-tolerates, returning [] with the non-enumerable `hardFail` tag there, and
// an empty SUCCESSFUL result ({gained:[],byFunction:[]}, [] show, {} map) reads as an all-clear over a
// corrupt report — the §4 cardinal sin, exactly what the CLI's loadReportOrDie exits 2 on. The throw
// surfaces as the same isError result shape every other tool failure uses. EVERY tool that loads a
// report (main prefix or baseline) goes through this — never bare Q.loadReport.
// `partialIsFatal` raises the bar from "NOTHING parsed" to "not EVERYTHING parsed", and `candor_gate`
// passes it because that tool emits a VERDICT: `{ok: true, violations: []}` over a multi-report prefix
// with one clean sibling and one truncated one is a green document over a package half of whose signature
// never loaded, and the disclosure Q.loadReport writes goes to the SERVER's stderr — a channel the calling
// agent never reads. Same rule, same argument as the CLI `gate --report` (see query.mjs). The read-only
// tools keep the looser bar deliberately: they return what they found rather than asserting a clean bill
// of health, so the partial answer is a smaller claim than a green gate.
function loadReportLoud(p, { partialIsFatal = false } = {}) {
  const fns = Q.loadReport(p);
  if (fns.hardFail && (partialIsFatal || fns.length === 0))
    throw new Error(fns.length === 0
      ? `every report found at prefix \`${clip(p)}\` failed to load — refusing to report an empty (all-clear) answer over a corrupt report; re-run the scan`
      : `a report found at prefix \`${clip(p)}\` failed to load — refusing to gate over a report that did not load cleanly; a partial signature makes a green verdict meaningless (the effects of the report that did not load are exactly the ones a violation would come from). Re-run the scan`);
  return fns;
}
// The confinement root for a caller-supplied policy path: the repo the report belongs to — the
// .candor/config-discovered repo root when there is one, else the parent of a `.candor/` report
// directory, else the report's own directory. The old default (always dirname(prefix)) was the
// `.candor/` dir itself under the standard `.candor/report` layout, so a legitimate repo-root policy —
// the very layout candor_gate resolves via cfg.repoRoot — was refused (review find).
function policyRoot(prefix) {
  const cfg = configPolicy(prefix);
  if (cfg) return cfg.repoRoot;
  const dir = nodePath.resolve(nodePath.dirname(prefix));
  return nodePath.basename(dir) === ".candor" ? nodePath.dirname(dir) : dir;
}
// Read a caller-supplied policy file CONFINED to the report's repo tree. The MCP surface is
// report-query-only (spec §7.12); an arbitrary `policy` path (/etc/passwd, ~/.aws/credentials) whose
// parsed deny-rule scopes are reflected back in violations[].rule is an arbitrary-file-read exfiltration
// channel — tie the policy to the project it gates. FAIL CLOSED on an unreadable path: the thrown error
// surfaces as the tool-level isError — a typo'd policy must be LOUD, never a clean no-policy verdict
// (the gateless-green shape the CLI's whatif exits 2 on).
function confinedPolicyRead(policyPath, prefix, root = policyRoot(prefix)) {
  const abs = nodePath.resolve(policyPath);
  if (!within(abs, root) || (WORKSPACE_ROOT && !within(abs, WORKSPACE_ROOT)))
    throw new Error(`policy must be within the report's repo (${root}) — refusing to read \`${clip(policyPath)}\``);
  try { return fs.readFileSync(abs, "utf8"); }
  catch { throw new Error(`policy \`${clip(policyPath)}\` could not be read — NOT evaluated (a missing gate source must be loud, never a clean verdict)`); }
}
/**
 * ⟨0.24⟩ ONE policy PARSE for every tool here that consults one — the MCP twin of query.mjs's
 * `loadPolicyOrDie`, and it closes the same two defects on the agent-facing surface.
 *
 * These tools called `parsePolicy(text)` with NO alias map, so a rule written against a checked-in
 * `unknown-alias` was silently REWRITTEN — widened to the bare effect — in the very tools an agent
 * consults before and after an edit, while the CLI gate honoured it. And with ⟨0.24⟩ making an
 * unrecognised value token a POLICY ERROR (§6.2 `382a7e0`/`be0b9a9`), `candor_gate` would otherwise
 * have kept enforcing a policy it cannot honour as written — the narrowing case stops gating what the
 * operator spelled while the gate still looks armed, which is the fail-open the ruling exists to
 * close, arriving here through the surface an agent trusts most.
 *
 * The vocabulary anchors at the POLICY FILE (§3.1 `99eb4e9`), as it does on both CLI routes, so the
 * same policy means the same thing however it is reached. A policy error throws, which the tool layer
 * renders as `isError` — the MCP shape of the CLI's exit 2.
 */
function policyOrThrow(text, policyPath) {
  const errs = [];
  const aliases = parseUnknownAliases(discoverConfigText(policyVocabularyAnchor(policyPath, process.cwd())), errs);
  const pol = parsePolicy(text, aliases);
  errs.push(...pol.errors);
  // ⟨0.24⟩ FATAL only: `errors` also carries every LINE the parser dropped whole (SPEC §3.1
  // `195d45a`) — additive to the `parsepolicy` witness, deliberately silent about the gate.
  const fatal = fatalPolicyErrors(errs);
  if (fatal.length) throw new Error(policyErrorText(policyPath ?? "(policy)", fatal));
  return pol;
}
// ⟨0.28⟩ SPEC §2 — AN ADVISORY TOOL OVER A CONFIGURED ZERO-RULE POLICY ANSWERS WITH THE CAVEAT DOCUMENT,
// RESULT KEYS WITHHELD. The CLI half is `emitZeroRuleCaveat` in query.mjs and this is the SAME document
// through the same builder (`policyZeroRules`), because the agent surface is a channel these verbs answer
// on and a caveat that exists on one of them is a caveat the other silently drops. MEASURED on the CLI
// twins before this: `{"ok": true, "unverified": []}` / `{"crossing": false, "reason": "not-forbidden"}`
// over `# no rules yet` — an all-clear produced by deleting the question, handed to a consumer that
// cannot ask a follow-up. `fix` emits NO `crossing` key: that key is present exactly when the verb
// answered. §6.2's gate REFUSES over the same policy (exit 2); these are advisory, so they disclose.
const policyAskedNothing = (pol) => !!pol && !pol.deny.length && !pol.allow.length && !pol.forbid.length
  && !(pol.only ?? []).length;   // ⟨0.29⟩ an `only`-only policy is ARMED
// `policyZeroRules` also returns a `why` — the HUMAN sentence the gate's refusal puts in `reason`. The
// caveat document carries only `unevaluated`, so it is not spread here rather than minted as a wire key.
const zeroRuleCaveat = (policyPath, prefix) => {
  const { unevaluated } = policyZeroRules(policyPath ?? "(policy)");
  return { unevaluated, ...Q.completenessFields(Q.reportCompleteness(prefix)) };
};

// The repo's .candor/config (spec §3.4), from the report's directory upward — shared impl in policy.mjs.
function configPolicy(prefix) {
  return discoverConfigPolicy(nodePath.dirname(nodePath.resolve(prefix)) || ".");
}

// ---- the tools: name -> {description, schema, run} ------------------------------------------------
const reportArg = { report: { type: "string", description: "report prefix (optional; defaults to $CANDOR_REPORT)" } };

// Bound a blast-radius/caller LIST for the agent transport: on a large repo a single fn can have
// hundreds-to-thousands of transitive callers, an unbounded multi-thousand-token answer. The agent's
// question ("how big is the blast radius / where does it surface") is answered by the COUNT + the entry
// points + the top names — so cap the list to MCP_LIST_CAP, keep the exact count, and flag truncation.
// The full list stays available from the CLI / `--json` (the spec-pinned §3.1 shape is UNCHANGED — this
// only shapes the MCP result for its token-sensitive transport). Small results are returned verbatim.
const MCP_LIST_CAP = 50;
function capImpact(r) {
  let out = r;
  if (Array.isArray(r.affected) && r.affected.length > MCP_LIST_CAP)   // affectedCount is the full count
    out = { ...out, affected: r.affected.slice(0, MCP_LIST_CAP), affectedTruncated: true };
  if (Array.isArray(r.entryPoints) && r.entryPoints.length > MCP_LIST_CAP)
    out = { ...out, entryPointCount: r.entryPoints.length, entryPoints: r.entryPoints.slice(0, MCP_LIST_CAP), entryPointsTruncated: true };
  return out;
}
// The same token-amplification argument as capImpact, for the other unbounded lists: `where` on a
// pervasive effect (Log, Unknown) lists most of a large repo; a blindspot source's `affected` is a
// transitive-caller list. Counts stay exact; truncation is flagged.
function capWhere(r) {
  const cap = (k) => Array.isArray(r[k]) && r[k].length > MCP_LIST_CAP;
  if (!cap("directly") && !cap("inherited")) return r;
  return {
    effect: r.effect,
    directlyCount: r.directly.length, directly: r.directly.slice(0, MCP_LIST_CAP),
    inheritedCount: r.inherited.length, inherited: r.inherited.slice(0, MCP_LIST_CAP),
    truncated: true,
  };
}
function capBlindspots(r) {
  const sources = (r.sources ?? []).map((s) =>
    Array.isArray(s.affected) && s.affected.length > MCP_LIST_CAP
      ? { ...s, affected: s.affected.slice(0, MCP_LIST_CAP), affectedTruncated: true }  // `reaches` is the full count
      : s);
  return { ...r, sources };
}
function capCallers(r) {
  const d = r.direct ?? [], t = r.transitive ?? [];
  if (d.length <= MCP_LIST_CAP && t.length <= MCP_LIST_CAP) return r;
  return {
    of: r.of,
    directCount: d.length, direct: d.slice(0, MCP_LIST_CAP),
    transitiveCount: t.length, transitive: t.slice(0, MCP_LIST_CAP),
    truncated: true,
  };
}
// ⟨0.28⟩ SPEC §2 — THE COMPLETENESS CAVEAT, ON THE AGENT-FACING CHANNEL. The same reader and the same key
// set as the CLI (`query-core`), never a second mechanism: the CLI and this server are one implementation,
// and a caveat that exists on one of them is a caveat the other silently drops. MEASURED here, over the
// standard post-⟨0.28⟩ artifact (`analyzed.count: 0` + a non-empty `unanalyzed`), before this wrapper:
// `candor_where` → `{"effect":"Fs","directly":[],"inherited":[]}`, `candor_map` → `{}`,
// `candor_blindspots` → `{"sources":[],"totalUnknown":0}`, `candor_reachable` →
// `{"entryPoints":0,"effects":{}}`, `candor_containment` → `{"contained":[],"ambient":{}}` — five flat
// all-clears with no hedge. `candor_show`/`candor_impact` already fail closed on the fn-existence guard.
//
// THE AGENT IS THE CONSUMER THAT CANNOT ASK A FOLLOW-UP QUESTION. A human running the CLI at least sees an
// oddly bare answer; a loop reading `blindspots.sources.length === 0` records "no blind spots" and moves on.
// Additive and a no-op on a complete report (`completenessFields` returns `{}`), so every pinned tool shape
// is unchanged on an ordinary one.
// The collision loop this used to carry is gone with ⟨0.28⟩ Rung A: `candor_map` was its only possible
// trigger and now takes `caveatInstead`, where nothing is displaced. Every remaining caller has a fixed
// key set, so the condition is not constructible — and a guard whose condition cannot arise reads as
// coverage.
const withCompleteness = (p, doc) => ({ ...doc, ...Q.completenessFields(Q.reportCompleteness(p)) });
// ⟨0.28⟩ RUNG A, ON THE AGENT CHANNEL — SPEC §2: a verb whose pinned shape cannot carry the caveat emits
// the CAVEAT DOCUMENT INSTEAD of its result document. Two tools qualify and both are handled here,
// because THE MCP HALF HAS BEEN THE MISSED ROUTE TWICE IN THIS REPO — and it is the worse one: an agent
// reading `Object.keys(map).length === 0` records "this codebase performs no effects" and moves on, with
// no follow-up question available to it.
//
//   candor_show  the CLI's `show` is pinned to an ARRAY; this tool returns `Q.show(...)`, the same array,
//                and had no completeness reader at all.
//   candor_map   keyed by the operator's own MODULE names. The merged shape it used to take displaced a
//                real module row to make space for the hedge, and the `@`-prefix escape is unavailable
//                for the reason the ruling names candor-ts for: `@scope/name` is a key a module owns.
//
// A no-op on a complete report, so both pinned tool shapes are unchanged on an ordinary one.
// ⟨0.28⟩ THE DOC ARRIVES AS A THUNK, and that is the whole fix rather than a style preference.
// This took `doc` by value, so JavaScript evaluated `Q.show(loadReportLoud(p), a.fn)` BEFORE
// `caveatInstead` was ever called — and `Q.show`'s fn-existence guard throws. Over a judged-nothing
// report `candor_show <anything>` therefore answered "no function matching …" to an AGENT: a
// determined negative about the code, produced by a report that examined none of it, on the surface
// where a wrong answer is acted on rather than read. The CLI was already correct (measured: it emits
// the caveat document), so this was the MCP half of a rung the CLI had shipped — the third time today
// that half was the one nobody checked.
//
// Hedging is now decided BEFORE the answer is computed, so no guard inside the verb can pre-empt it.
// AND CORRUPTION IS NOT A HEDGE — the deferral made that distinction load-bearing where it had been
// free. `mustHedge` is true on the `unreadable` arm too, so simply deferring turned `candor_map` over a
// CORRUPT report from a loud tool error into `{"incomplete": true}`: a disclosure where the contract
// says refuse (§2 ⟨0.24⟩ — a signature key that cannot be read impeaches the document, it does not
// qualify it). Caught by the existing row, which is the second time today that fixing a false negative
// introduced a wrong downgrade in the same edit.
//
// So the loud causes fall THROUGH to the thunk, whose loader throws; only the qualifying causes
// substitute a caveat. Corruption anywhere in the set wins over a hedge elsewhere in it.
const caveatInstead = (p, doc) => {
  const comp = Q.reportCompleteness(p);
  const call = () => (typeof doc === "function" ? doc() : doc);
  if (comp?.unreadable?.length) return call();          // refuse loudly, via the loader
  if (Q.mustHedge(comp)) return Q.completenessFields(comp);
  return call();
};
// ⟨0.28⟩ The graph the three graph verbs answer over: the §2.2 sidecar when there is one, else the
// report's own embedded `calls` edges (Q.reportCallsGraph) — the same fallback the CLI and rust/java
// run, so this surface cannot refuse a report the CLI answers. The fn-existence guard below already
// unions the report's names, so a sidecar-less locator passed the guard and then computed over an
// EMPTY graph: `candor_callers` returned `{of:[],direct:[],transitive:[]}` — "nobody calls this,
// safe to edit" — to an agent, over a pair whose graph was present one key over. An ARMED pair (no
// sidecar, report judged nothing) still fails closed: both sets are empty and the guard refuses.
const graphOrReportEdges = (p, fns) => {
  const cg = Q.loadCallgraph(p);
  return Object.keys(cg).length ? cg : Q.reportCallsGraph(fns);
};
const TOOLS = {
  candor_impact: {
    description: "Backward blast radius: every effectful function that transitively calls `fn`, and which runtime entry points are downstream. Answers 'if I change this, what surfaces at runtime?' — the cheapest possible alternative to tracing callers by hand.",
    schema: { type: "object", properties: { fn: { type: "string", description: "the function/unit to assess" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => { const fns = loadReportLoud(p); return capImpact(Q.impact(fns, graphOrReportEdges(p, fns), a.fn)); },
  },
  candor_where: {
    description: "Which functions perform a given effect (e.g. Net, Db, Exec, Fs) — `directly` vs `inherited` via a callee. The effect-surface map.",
    schema: { type: "object", properties: { effect: { type: "string", description: "Net|Fs|Db|Exec|Env|Clock|Ipc|Log|Rand|Clipboard|Unknown" }, ...reportArg }, required: ["effect"] },
    run: (a, p) => withCompleteness(p, capWhere(Q.where(loadReportLoud(p), a.effect))),
  },
  candor_reachable: {
    description: "What the program/fleet actually DOES at runtime: effects unioned over the entry points, with how many roots reach each and via which.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => withCompleteness(p, Q.reachable(loadReportLoud(p))),
  },
  candor_path: {
    description: "Forward provenance: the shortest call chain from `fn` to the nearest function that performs `effect` DIRECTLY — 'this reaches Net through WHAT?'.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => { const fns = loadReportLoud(p); return Q.path(fns, graphOrReportEdges(p, fns), a.fn, a.effect); },
  },
  candor_callers: {
    description: "Who calls `fn` — direct (one hop) and transitive callers over the effect-relevant call graph.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => capCallers(Q.callers(graphOrReportEdges(p, loadReportLoud(p)), a.fn)),
  },
  candor_show: {
    description: "A function's effects (inferred = transitive, direct = own body) plus its literal surfaces (hosts/cmds/paths/tables) when present.",
    schema: { type: "object", properties: { fn: { type: "string" }, ...reportArg }, required: ["fn"] },
    run: (a, p) => caveatInstead(p, () => Q.show(loadReportLoud(p), a.fn)),
  },
  candor_map: {
    description: "Per-module effect overview: each module's union of effects and function count. The architecture-at-a-glance.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => caveatInstead(p, () => Q.map(loadReportLoud(p))),
  },
  candor_whatif: {
    description: "Hypothetically add `effect` to `fn` and report the blast radius; with `policy`, also the deny-rule violations it would cause. Pre-edit gate check.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, policy: { type: "string", description: "path to a CANDOR_POLICY file (optional)" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => {
      // A GIVEN policy path is always read (confined, fail-closed) — the old `existsSync` guard made a
      // typo'd/missing path silently evaluate with NO policy → `ok:true, violations:[]`, a false green
      // on the agent-facing pre-edit gate (exactly what the CLI whatif exits 2 to prevent). The read's
      // throw lands as the tool-level isError, mirroring the CLI's fail-closed posture.
      const pol = a.policy ? policyOrThrow(confinedPolicyRead(a.policy, p), a.policy) : null;
      const r = Q.whatif(Q.loadCallgraph(p), a.fn, a.effect, pol, scopeMatches);
      if (r === null) throw new Error(`no function matching \`${clip(a.fn)}\` in the call graph`);
      // ⟨0.28⟩ a CONFIGURED policy that parsed to zero rules asked nothing — the pre-edit verdict and the
      // blast radius it qualifies are withheld for the caveat document (see `zeroRuleCaveat`). A policy
      // that is NOT configured stays untouched: that is the honest way to say "I am not gating".
      if (policyAskedNothing(pol)) return zeroRuleCaveat(a.policy, p);
      return r;
    },
  },
  candor_fix: {
    description: "THE BOUNDARY FIX: when `fn` performs `effect` in a layer the policy forbids (a violation candor_whatif/candor_gate reports), compute the architectural REMEDY — not just 'the domain can't do Net', but WHERE the effect belongs and the refactor to put it there: the direct call site to hoist, the forbidden-layer functions that become pure and thread the value as a parameter, and the nearest allowed-layer caller to perform the effect ({ crossing, site, deniedSpan, hoistTo, policyAlternative }). The remedial inverse of candor_whatif. Call this INSTEAD OF guessing a fix (adding `allow` to the domain, moving the I/O one call up, threading a handle the wrong way). Advisory: it names the structure, you write the code; the gate re-scan verifies. Uses `policy` if given, else the repo's checked-in .candor/config policy (spec §3.4). ALWAYS CHECK `refused` BEFORE `crossing`: where the policy narrows on evidence this report does not carry, candor_gate REFUSES and no remedy is computed — the result is `{ fn, effect, refused:true, unevaluated:[{rule, why}] }` WITH NO `crossing` KEY, an absent key rather than `crossing:false`, because 'no boundary fix needed' is a claim and that is the one thing the tool cannot claim here (spec §3.2: an advisory verb may be LESS certain than the gate, never MORE). Re-scan so the report carries the narrowing evidence, or widen the rule; do not read the missing plan as an all-clear.",
    schema: { type: "object", properties: { fn: { type: "string" }, effect: { type: "string" }, policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: ["fn", "effect"] },
    run: (a, p) => {
      // The fix is defined relative to a boundary — a policy is required. Given → confined fail-closed read;
      // else the repo's checked-in policy (same resolution as candor_gate), so it works zero-config.
      let text, polPath = a.policy ?? null;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        polPath = cfg?.policyPath ?? null;
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4) — the fix is defined relative to the boundary it crosses");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      const cg = Q.loadCallgraph(p);
      // The sidecar is the only graph a candor-ts report carries — fail loud (tool error) when it's absent,
      // never a degenerate empty-graph remedy. (/code-review.)
      if (!cg || Object.keys(cg).length === 0) throw new Error(`no call-graph sidecar for the report — fix needs it (re-scan with --out)`);
      const fpol = policyOrThrow(text, polPath);
      const r = Q.fix(cg, loadReportLoud(p), a.fn, a.effect, fpol, scopeMatches);
      if (r === null) throw new Error(`no function matching \`${clip(a.fn)}\` in the call graph`);
      // ⟨0.28⟩ …and NO `crossing` key over a zero-rule policy: this tool's own description tells an agent
      // to read `crossing` as the answer, and `crossing: false` from a policy that forbids nothing is
      // vacuously true. Present exactly when the verb answered.
      if (policyAskedNothing(fpol)) return zeroRuleCaveat(polPath, p);
      return r;
    },
  },
  candor_gate: {
    description: "The policy verdict over this report: { ok, violations:[{rule, fn, effects, detail}] } — 'would this repo pass its architecture gate?'. Uses `policy` if given, else the repo's checked-in .candor/config policy (spec §3.4). ALWAYS CHECK `ok`, never the length of `violations`: a rule whose narrowing evidence the report does not carry is NOT EVALUATED, and then the result is `{ ok:false, refused:true, reason, unevaluated:[{rule, why}] }` WITH NO `violations` KEY — an absent key, not an empty list, because the gate is making no claim there. `unevaluated` also rides a firing verdict (a certain violation dominates a refusal). `{ incomplete:true, unanalyzed }` means the report declares code candor could not analyze, so the gate cannot be green. Computed from the report — the engine's own --gate-json run is the authoritative CI form: it additionally fails an allow rule whose literal surface is INCOMPLETE (a masked/invisible endpoint), which is not a report field, so a green here can still be red in CI.",
    schema: { type: "object", properties: { policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: [] },
    run: (a, p) => {
      let text, polPath = a.policy ?? null;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        polPath = cfg?.policyPath ?? null;
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4)");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      // ⟨0.24⟩ THE SAME THREE-PIECE GATE THE CLI RUNS, because this tool is a REPORT route exactly as
      // `gate --report` is, and the two pieces it was missing were BOTH live harms on the surface an
      // agent trusts and no human reads. Measured, same report, same policy, against the CLI:
      //
      //   deny Unknown[reflect] app   -> CLI exit 2 (refused);  here {"ok":true,"violations":[]}
      //   deny Net[unknown-host] app  -> CLI exit 2 (refused);  here FIRES, asserting
      //                                                         "netClass":["unknown-host"] the report never carried
      //
      // (1) `authoritative` netClass. The DEFAULT mode maps only entries that CARRY the field and lets the
      // rest fall back to `netClassesOf`, which floors an empty surface at `unknown-host`. That was chosen
      // as a hedge because "neither surface can refuse a question" — but a hedge that ASSERTS a destination
      // class in the violation record is not a hedge, it is the re-derivation §3.1 ⟨0.24⟩ forbids, in a
      // field a consumer reads as the PRODUCER's judgment. Now that the tool discloses (3), it can refuse,
      // so the authoritative mode is the correct one and the two routes read one report identically.
      // (2) `withhold` (unanswerableScoped). A scoped `deny` whose narrowing evidence the wire does not
      // carry is NOT EVALUATED, per (rule, function, effect) — never scored as a filter that succeeded for
      // lack of evidence, and never fired on `reasonClassesMatch`'s empty-set floor, which is right for a
      // MATCHER and wrong for a FIRING.
      // (3) the disclosure, which is what makes (1) and (2) safe here: an unevaluated rule rides the tool
      // result, so the agent sees WHICH part of its policy went unenforced rather than an empty list.
      //
      // ONE PASS over the report files (`loadGateReport`), the same reader `gate --report` uses: it yields
      // the entries AND the ⟨0.21⟩/⟨0.15⟩ envelope out of the same bytes. Three separate reads (functions,
      // judged-nothing, and — newly — `unanalyzed`) could disagree with each other on a file another
      // process rewrites between them.
      const pol = policyOrThrow(text, polPath);
      const g = Q.loadGateReport(p);
      if (g.hardFail)
        throw new Error((g.corrupt.length
            ? `the report at prefix \`${clip(p)}\` has ${g.corrupt.length} present-but-unparseable §2 key(s) — a key that is THERE but of the wrong shape is corrupt input, not an empty one (SPEC §2 ⟨0.24⟩); coercing it to its empty value would turn corruption into a purity claim: ${g.corrupt.join("; ")}. `
            : "")
          + (g.functions.length === 0
            ? `every report found at prefix \`${clip(p)}\` failed to load — refusing to report an empty (all-clear) answer over a corrupt report; re-run the scan`
            : `a report found at prefix \`${clip(p)}\` failed to load — refusing to gate over a report that did not load cleanly; a partial signature makes a green verdict meaningless (the effects of the report that did not load are exactly the ones a violation would come from). Re-run the scan`));
      const gfns = g.functions;
      const cg = Q.loadCallgraph(p);
      const gnet = reportNetClasses(gfns, { authoritative: true });
      const { unevaluated, withhold } = unanswerableScoped(pol, gfns, resolveReasonClasses(gfns, cg), gnet);
      // ⟨0.29⟩ …AND THE TWO WHOLE-POLICY UNANSWERABLE KINDS. This tool passed the WHOLE policy to
      // `evaluatePolicy`, so `forbid` was answered from a report — MEASURED: with no callgraph sidecar,
      // `violations: 0` and nothing disclosed (a silent green over a rule that was never enforced); with a
      // sidecar, an AS-EFF-009 violation from evidence SPEC §3.1 says cannot support one. Both outcomes the
      // MUST forbids, on the channel an agent reads. The CLI sibling had stripped and disclosed these since
      // ⟨0.24⟩; the shared helper is so the third route cannot drift from the first two again.
      const wp = wholePolicyUnanswerable(pol, "`candor_gate` (a report route)");
      unevaluated.push(...wp.unevaluated);
      // …and a policy that is NOTHING BUT unanswerable kinds has no verdict to stand beside the refusal,
      // so it refuses outright — the same split `gate --report` makes. Where other rules CAN fire, they
      // decide and these ride along disclosed (§3.1 `1503368`: whole-policy granularity is not a licence
      // to suppress a certain violation).
      if (wp.onlyUnanswerable)
        throw new Error(`this policy asks only questions a report cannot answer — ${wp.unevaluated[0].why}`);
      const v = evaluatePolicy(wp.answerable, gfns, cg, new Map(), new Set(), gnet, withhold);
      // ⟨0.21⟩ COMPLETENESS MANIFEST — this tool implemented no incompleteness rule at all: it answered
      // `{ok:true, violations:[]}` over a report DECLARING `unanalyzed`, where the CLI exits 2. A gate
      // cannot be green over code candor never analyzed, and the manifest travels ON the report, so the
      // same verdict follows from it here. Additive to the pinned `{ok, violations}` shape.
      const incomplete = g.unanalyzed.length > 0;
      // ⟨0.24⟩ …and a report that JUDGED NOTHING is not an all-clear (SPEC §2's three-row table, bound to
      // every report-reading route by §3.1: "the obligation is on the reading, not on the route by which
      // the report arrived"). This tool is exactly such a route — it gates whatever `report` points at,
      // which is how a FOREIGN report arrives here — and `{ok: true, violations: []}` over a report with
      // `analyzed.count: 0` tells an agent the code is clean when nothing in it was ever judged. The
      // caveat is ADDITIVE (the two existing keys keep their shape and meaning, and the field is absent
      // on every ordinary report) because the verdict itself must not move: the report asserts no effect,
      // so asserting one here would be the fabrication mirror of the silence being disclosed.
      //
      // `judgedNothing` IS THE ARRAY HERE TOO, and it used to be a boolean. The old comment defended the
      // boolean on one premise — "this tool's document is ONE gate verdict about ONE locator" — and that
      // premise is contradicted in this very file: `report` is a PREFIX (DEFAULT_PREFIX, and
      // `loadReportLoud`, whose own message reads "every report found at prefix … failed to load" and
      // whose header says "over a multi-report prefix"). ONE VERDICT IS NOT ONE REPORT. SPEC §2 gives
      // precisely that reason for the array: "a verb reading a prefix answers over many sibling reports,
      // and WHICH of them judged nothing is the whole of the actionable content".
      //
      // The boolean did not merely lose "which". `loadGateReport` computes it as an AND over the siblings
      // (`let judgedNothing = true`, cleared by the first report with content), so the PARTIAL case — the
      // common one — emitted `false` and therefore NO CAVEAT AT ALL. MEASURED 2026-08-13 on a two-report
      // prefix, one judged-nothing and one carrying a real function: the boolean said `false` while
      // `reportCompleteness` named `r.empty.json`. A green gate with NO disclosure over a surface half of
      // which was never judged — on the one channel whose consumer cannot ask a follow-up question, which
      // is the argument this file already makes immediately below about `ignored`.
      //
      // ⟨0.28⟩ `noManifest` (SPEC §2 row 3) rides with it, for the reason that row exists: a report with
      // no `analyzed` key declares nothing, and listing it under `judgedNothing` would be the false
      // disclosure the rung split out. The `unverified` route in this same file already emitted both;
      // this route is its sibling and was never brought along.
      //
      // ADDITIVE STILL: `ok` does not consult either key. ⟨0.24⟩'s carve-out keeps the gate verdict's
      // `ok`, and the report asserts no effect — asserting one here would be the fabrication mirror of
      // the silence being disclosed.
      // ⟨0.28⟩ SPEC §6.2 `ignored` — THE LINES THE PARSE DROPPED, on the surface where their absence is
      // worst. MEASURED here 2026-08-12 over a policy whose 3 of 4 lines were dropped: this tool returned
      // `{"ok":true,"violations":[]}` while the per-line warnings went to the SERVER's stderr, a channel
      // the calling agent never reads — so the one consumer that cannot ask a follow-up question was
      // handed a green verdict from a gate three-quarters of which was never asked. Same shape and same
      // builder as both CLI routes; omitted when nothing was dropped, and `ok` does not consult it.
      const ignored = pol.ignored?.length ? { ignored: pol.ignored } : {};
      const gcomp = Q.reportCompleteness(p);
      const judged = (gcomp.judgedNothing?.length || gcomp.noManifest?.length)
        ? { ...(gcomp.judgedNothing?.length ? { judgedNothing: gcomp.judgedNothing } : {}),
            ...(gcomp.noManifest?.length ? { noManifest: gcomp.noManifest } : {}),
        caveat: "⟨0.24⟩ report(s) under this locator judged NOTHING (`analyzed.count` is 0, or absent with no "
              + "entries) — a green verdict does not certify them: absence from `functions` licenses no purity "
              + "claim about any unit they contain. The named report(s) are the gap; the verdict above covers "
              + "only the siblings that DID judge. Re-scan those sources, or point `report` at the package that "
              + "has them." } : {};
      const inc = incomplete ? { incomplete: true, unanalyzed: g.unanalyzed } : {};
      // ⟨0.24⟩ PRECEDENCE (SPEC §3.1 `7271c69`/`4c79958`): violation (1) > refusal (2) > incomplete (2), and
      // the REFUSAL SHAPE is the one the CLI writes — `ok:false`, `refused:true`, and NO `violations` KEY AT
      // ALL, because the gate is making no claim about violations and `[]` is precisely the claim it cannot
      // make. THE TOOL-RESULT SHAPE DECISION, stated: a refusal is returned as this structured document and
      // NOT as `isError`. `isError` flattens to a text blob, and the machine-actionable half of a refusal is
      // `unevaluated` — WHICH rules went unenforced and why — which is exactly what an agent needs to fix it.
      // The document is still fail-closed to the naivest possible reader (`ok` is false), and it is the same
      // shape the agent would get from `--gate-json`, so one consumer parses both routes.
      if (v.length) return { ok: false, violations: v, ...(unevaluated.length ? { unevaluated } : {}), ...ignored, ...inc, ...judged };
      if (unevaluated.length)
        return { ok: false, refused: true,
                 reason: `${unevaluated.length} policy rule(s) could not be evaluated against this report`,
                 unevaluated, ...inc, ...judged };
      return { ok: !incomplete, violations: v, ...ignored, ...inc, ...judged };
    },
  },
  candor_unverified: {
    description: "PROVABLE-PURITY check (INSTANT): a `pure`/`deny <E>` policy layer PASSES a function that has "
                 + "no such effect — but if that function is Unknown (candor couldn't resolve one of its calls), "
                 + "the pass is UNVERIFIED: the Unknown could hide the very effect the rule forbids. The classic "
                 + "case is a fn/closure-injected 'port' — the domain reads as Unknown, so `deny Net domain`/`pure "
                 + "domain` clear it though it may reach Net at runtime. Returns each such function + the `deny <E> "
                 + "Unknown <scope>` upgrade that makes the layer PROVABLY clean. Uses `policy` if given, else the "
                 + "repo's checked-in .candor/config policy. ALWAYS CHECK `ok`, never the length of `unverified`: "
                 + "over a report declaring code candor could NOT analyze, `ok` IS ABSENT and `{incomplete:true, "
                 + "unanalyzed}` takes its place — a function in an unanalyzed file is missing from the report "
                 + "entirely, so it cannot be enumerated as an unverified pass, and an empty array there is not "
                 + "an all-clear (spec §3.2). `ok` is ABSENT for a second reason too, and the entries that come "
                 + "with it are the sharpest ones: where the policy narrows on evidence this report does not carry, "
                 + "candor_gate REFUSES — and this verb then NAMES each function the gate could not judge, as "
                 + "`{fn, rule, why}` where `why` is THE MISSING EVIDENCE and never a derived class, plus the gate's "
                 + "own `unevaluated:[{rule, why}]`. Those entries carry no `upgrade`: whether they pass at all is "
                 + "the open question, so there is nothing to upgrade yet — re-scan so the report carries the "
                 + "evidence, or widen the rule (spec §3.2: an advisory verb may be LESS certain than the gate, "
                 + "never MORE).",
    schema: { type: "object", properties: { policy: { type: "string", description: "path to a §6.2 policy file (optional; defaults to the repo's .candor/config `policy`)" }, ...reportArg }, required: [] },
    run: (a, p) => {
      let text, polPath = a.policy ?? null;
      if (a.policy) text = confinedPolicyRead(a.policy, p);
      else {
        const cfg = configPolicy(p);
        polPath = cfg?.policyPath ?? null;
        if (!cfg) throw new Error("no policy: pass `policy`, or check one into the repo's .candor/config (spec §3.4)");
        text = confinedPolicyRead(cfg.policyPath, p, cfg.repoRoot);
      }
      // ⟨0.24⟩ SPEC §3.2 — the agent surface is a CHANNEL this verb answers on, and the rule binds every
      // one of them. `candor_gate` already refuses to read green over `unanalyzed`; this returned
      // `ok:true` with an empty array over the identical bytes, on the surface an agent trusts and no
      // human reads. Same `advisoryAnswer` the CLI applies, so the two cannot drift.
      // ⟨0.28⟩ …and the `analyzed.count: 0` cause on the same terms (SPEC §2), read through the SAME
      // `reportCompleteness` the CLI and the descriptive tools use — one reader, so the two channels
      // cannot disagree about which reports judged nothing.
      const ucomp = Q.reportCompleteness(p);
      const upol = policyOrThrow(text, polPath);
      // ⟨0.28⟩ the sharpest of the three: the verb whose job is "your green gate is not provably green"
      // answered `{ok: true, unverified: []}` over a policy that asked nothing. The empty list is withheld
      // for ⟨0.27⟩'s reason — a document that made no evaluation must not carry the finding key.
      if (policyAskedNothing(upol)) return zeroRuleCaveat(polPath, p);
      // ⟨0.28⟩ `noManifest` (SPEC §2 row 3) rides here too — a report with no `analyzed` key declares
      // nothing, and listing it under `judgedNothing` would be the false disclosure the rung split out.
      return Q.advisoryAnswer(Q.unverified(loadReportLoud(p), upol, scopeMatches),
                              ucomp.unanalyzed, ucomp.judgedNothing, ucomp.unreadable, ucomp.noManifest);
    },
  },
  candor_containment: {
    description: "Per boundary effect (Db/Net/Exec/Fs/Ipc/Clipboard): how contained it is in one architectural layer — the dispersion diagnostic (spec §6.1). Not a score; per-effect facts.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => withCompleteness(p, Q.containment(loadReportLoud(p))),
  },
  candor_blindspots: {
    description: "The Unknown SOURCES — calls the engine genuinely could not resolve (reflection, wide dispatch, fn-pointers) — ranked by how many functions inherit Unknown through each. Turns a high-Unknown report into a short worklist.",
    schema: { type: "object", properties: { ...reportArg } },
    run: (_a, p) => withCompleteness(p, capBlindspots(Q.blindspots(loadReportLoud(p), Q.loadCallgraph(p)))),
  },
  candor_diff: {
    description: "The per-function effect delta versus a baseline report: gained (introduced vs inherited) and lost effects. 'What did this change do to the effect surface?'.",
    schema: { type: "object", properties: { baseline: { type: "string", description: "the baseline report prefix" }, ...reportArg }, required: ["baseline"] },
    run: (a, p) => {
      // Baseline existence is loud (a typo'd baseline loaded [] with hardFail=false and diffed as an
      // authoritative empty {changes:[]}; the CLI exits 2 on the same miss) — but NOT --root-confined:
      // see resolveBaseline for the out-of-tree-baseline trust argument.
      const b = resolveBaseline(a.baseline);
      return { baseline_version: Q.reportVersion(b) ?? "", engine_version: Q.reportVersion(p) ?? "",
               ...Q.diff(loadReportLoud(p), loadReportLoud(b)) };
    },
  },
  candor_gains: {
    description: "The supply-chain alarm: effects the surface GAINED versus a baseline (package-level + per-function) — 'did this dependency bump add Net/Exec somewhere?'.",
    schema: { type: "object", properties: { baseline: { type: "string", description: "the baseline report prefix" }, ...reportArg }, required: ["baseline"] },
    run: (a, p) => {
      // Same baseline posture as candor_diff (loud existence, no --root confinement — resolveBaseline):
      // an empty {gained:[]} over a typo'd baseline is a silent all-clear on the supply-chain ALARM
      // tool, while a prior-release baseline legitimately lives outside the served tree.
      const b = resolveBaseline(a.baseline);
      // ⟨spec 0.12 staged⟩ baseline callgraph → byFunction[].origin, same as the CLI (parity). The
      // loader's non-enumerable `partial` tag rides along: a corrupt baseline sidecar (edges dropped,
      // disclosed) downgrades origin to "unknown", never a fabricated "new" over a truncated graph.
      // ⟨0.15 staged⟩ coverage disclosure — the SAME gainsCoverage the CLI verb spreads (the parity
      // rule): optional `coverage` (current envelope's ledger) + `coverageDelta` (baseline names
      // differ), both omitted when nothing applies — no other field of the tool result changes.
      // ⟨0.28⟩ …and the ⟨0.21⟩ manifest on the same terms, BOTH SIDES separately (`gainsCompleteness`,
      // the same one the CLI verb spreads). SPEC §2 puts the obligation on the READING, not the route the
      // report arrived by, and this is the route an agent takes: an "it gained nothing" over a report that
      // judged nothing is the false all-clear, and no human sees this channel.
      return { baseline_version: Q.reportVersion(b) ?? "", engine_version: Q.reportVersion(p) ?? "",
               ...Q.gains(loadReportLoud(p), loadReportLoud(b), Q.loadCallgraph(b)),
               ...Q.gainsCoverage(p, b), ...Q.gainsCompleteness(p, b) };
    },
  },
  candor_activity: {
    description: "What the edit-time gate caught: MEASURED activity from .candor/activity.jsonl (the Stop-hook / standalone review log) — edits checked, verdicts, violations by AS-EFF code, effects introduced, largest blast radius, deepest propagation (hops), plus the most recent records. Counted from the log, no model. A missing log is an empty result (the loop isn't wired here — not an error); corrupt lines are skipped.",
    schema: { type: "object", properties: {
      log: { type: "string", description: "activity log path (default .candor/activity.jsonl under --root, else beside the served report prefix, else cwd)" },
      session: { type: "string", description: "filter to one sessionId" },
      since: { type: "string", description: "ISO timestamp lower bound (records with no ts are kept)" },
      limit: { type: "number", description: "how many recent records to return (default 5, max 50)" },
    } },
    noReport: true,   // reads the activity log, not a report — usable before any scan exists
    run: (a) => readActivity(a),
  },
};

// The candor_activity reader. Field SEMANTICS mirror `candor-agents stats` (the two count the same
// pinned record shape — lib-candor-summary.sh's writer — so they cannot tell different stories):
// non-object lines skipped, bool-typed numerics ignored, `since` keeps null-ts records, verdict
// buckets clean/blocked/setup. The `edited` paths in `recent` are the hook's local-only fields —
// the MCP transport is the same machine (the agent already reads those files), so serving them is
// not the off-box transmission FEEDBACK-SPEC's privacy note forbids.
// The anchor a relative/default activity-log path resolves against — a LADDER, mirroring how the LSP
// derives its watch dir (rootPath ?? dirname(reportPrefix)):
//   1. --root: the served workspace is the explicit truth when one is declared;
//   2. the served report prefix ($CANDOR_REPORT / CLI arg): the documented
//      `CANDOR_REPORT=/repo/.candor/report npx candor-ts-mcp` invocation runs from ANY cwd, and the
//      activity log lives beside the report — anchoring at cwd found nothing. A `<repo>/.candor/report`
//      prefix anchors at `<repo>` (so the `.candor/activity.jsonl` default lands beside the report);
//      any other prefix anchors at its own directory (its `.candor/` sits with it);
//   3. cwd — nothing else to go on.
function activityAnchor() {
  if (WORKSPACE_ROOT) return WORKSPACE_ROOT;
  if (DEFAULT_PREFIX) {
    const dir = nodePath.resolve(nodePath.dirname(DEFAULT_PREFIX));
    return nodePath.basename(dir) === ".candor" ? nodePath.dirname(dir) : dir;
  }
  return process.cwd();
}
function readActivity(a) {
  const log = nodePath.resolve(activityAnchor(), a?.log || ".candor/activity.jsonl");
  if (WORKSPACE_ROOT && !within(log, WORKSPACE_ROOT))
    throw new Error(`activity log \`${clip(a?.log)}\` is outside the served workspace (--root ${WORKSPACE_ROOT}) — refusing`);
  let lines = [];
  try { lines = fs.readFileSync(log, "utf8").split("\n"); }
  catch { return { log: null, edits: 0, note: "no activity log — the edit-time loop isn't wired here (integrations/claude-code)" }; }
  const recs = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && typeof r === "object" && !Array.isArray(r)) recs.push(r); } catch { /* corrupt line — skipped, like stats */ }
  }
  const since = a?.since;
  // `since` compares TEMPORALLY when the caller's value parses: a bytewise ISO compare mis-filters the
  // offset/millis variants an agent naturally supplies ("…T11:30:00+01:00" sorts after "…T11:00:00Z"
  // lexicographically yet is the earlier instant). The log's own ts format is pinned, but records are
  // read tolerantly: a record whose ts doesn't parse is KEPT, matching the null-ts posture (a filter
  // must never silently hide records it can't place). Only when the caller's `since` itself doesn't
  // parse do we fall back to the old lexicographic compare (best effort over refusing).
  const sinceMs = since ? Date.parse(since) : NaN;
  const afterSince = (r) => {
    if (!since || typeof r.ts !== "string") return true;
    if (Number.isNaN(sinceMs)) return r.ts >= since;      // unparseable bound — lexicographic fallback
    const tsMs = Date.parse(r.ts);
    return Number.isNaN(tsMs) ? true : tsMs >= sinceMs;   // unparseable record ts — kept, like null ts
  };
  const kept = recs.filter((r) => (!a?.session || r.sessionId === a.session) && afterSince(r));
  const summary = { log, edits: kept.length, clean: 0, blocked: 0, setup: 0,
                    violations: {}, effectsIntroduced: new Set(),
                    largestBlastRadius: 0, deepestPropagation: 0, from: null, to: null };
  for (const r of kept) {
    const v = r.verdict === "clean" || r.verdict === "blocked" ? r.verdict : "setup";
    summary[v]++;
    for (const code of Array.isArray(r.violations) ? r.violations : []) summary.violations[code] = (summary.violations[code] ?? 0) + 1;
    for (const e of Array.isArray(r.gained) ? r.gained : []) summary.effectsIntroduced.add(e);
    if (typeof r.blastRadius === "number" && Number.isInteger(r.blastRadius)) summary.largestBlastRadius = Math.max(summary.largestBlastRadius, r.blastRadius);
    if (typeof r.maxHops === "number" && Number.isInteger(r.maxHops)) summary.deepestPropagation = Math.max(summary.deepestPropagation, r.maxHops);
    if (typeof r.ts === "string") { if (!summary.from || r.ts < summary.from) summary.from = r.ts; if (!summary.to || r.ts > summary.to) summary.to = r.ts; }
  }
  summary.effectsIntroduced = [...summary.effectsIntroduced].sort();
  const limit = Math.min(Math.max(1, Number.isInteger(a?.limit) ? a.limit : 5), 50);
  return { ...summary, recent: kept.slice(-limit) };
}

// ---- MCP resources: the report + the checked-in policy, readable directly --------------------------
function listResources(prefix) {
  const res = [{ uri: `candor://report?prefix=${encodeURIComponent(prefix)}`, name: "candor report",
                 description: "the spec §2 report envelope (all packages under the prefix)", mimeType: "application/json" }];
  const cfg = prefix ? configPolicy(prefix) : null;
  if (cfg && fs.existsSync(cfg.policyPath))
    res.push({ uri: `candor://policy?prefix=${encodeURIComponent(prefix)}`, name: "candor policy",
               description: "the repo's checked-in §6.2 architecture policy (via .candor/config)", mimeType: "text/plain" });
  return res;
}
function readResource(uri, prefix) {
  if (uri.startsWith("candor://report")) return { mimeType: "application/json", text: JSON.stringify(loadReportLoud(prefix)) };
  if (uri.startsWith("candor://policy")) {
    const cfg = configPolicy(prefix);
    if (!cfg) throw new Error("no checked-in policy (no .candor/config with a `policy` key)");
    return { mimeType: "text/plain", text: confinedPolicyRead(cfg.policyPath, prefix, cfg.repoRoot) };
  }
  throw new Error(`unknown resource: ${uri}`);
}

// ---- JSON-RPC 2.0 over stdio (newline-delimited; the MCP stdio framing) ---------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "candor-mcp", version: VERSION },
      instructions: "candor's read-only effect queries. Prefer candor_impact/candor_reachable/candor_where over manually tracing the call graph — they return deterministic ground truth from a precomputed report. Run a candor scan first to produce the report.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notifications: no reply
  if (method === "ping") return result(id, {});
  if (method === "resources/list") {
    try { return result(id, { resources: DEFAULT_PREFIX && Q.hasReport(DEFAULT_PREFIX) ? listResources(DEFAULT_PREFIX) : [] }); }
    catch { return result(id, { resources: [] }); }
  }
  if (method === "resources/read") {
    try {
      // Honor the prefix ENCODED in the resource URI (resources/list mints `?prefix=…`) — it was
      // decorative before, always resolving the default (review find). resolvePrefix keeps the
      // existence + --root checks on whatever the client asked for.
      const uri = params?.uri || "";
      let encoded = null;
      try { encoded = new URL(uri).searchParams.get("prefix"); } catch { /* not URL-shaped — default */ }
      const prefix = resolvePrefix(encoded ? { report: encoded } : {});
      const r = readResource(uri, prefix);
      return result(id, { contents: [{ uri: params?.uri, ...r }] });
    } catch (e) { return error(id, -32602, `candor: ${e.message}`); }
  }
  if (method === "tools/list") {
    return result(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })),
    });
  }
  if (method === "tools/call") {
    const t = TOOLS[params?.name];
    if (!t) return error(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const args = params.arguments || {};
      // Enforce the tool's declared required args server-side — a missing `fn` must be a clear error,
      // not a silently-empty result (a defensive server doesn't trust the client to validate).
      const missing = (t.schema.required || []).filter((k) => args[k] === undefined || args[k] === "");
      if (missing.length)
        return result(id, { content: [{ type: "text", text: `candor: missing required argument(s): ${missing.join(", ")}` }], isError: true });
      // A log-only tool (candor_activity) needs no report — resolving one would wrongly demand a
      // scan before the gate's own activity can be read.
      const prefix = t.noReport ? null : resolvePrefix(args);
      // A tool that targets a `fn` gets a clear "not found" rather than a silently-empty result —
      // an agent must distinguish "no such function" from "found, nothing calls it".
      //
      // ⟨0.28⟩ …BUT THE HEDGE OUTRANKS THE EXISTENCE GUARD, and this guard sits in the DISPATCHER, so it
      // pre-empted the caveat for EVERY fn-taking tool rather than one. Over a judged-nothing report
      // `candor_show`/`candor_impact`/`candor_callers`/`candor_path` answered "no function matching …"
      // — a determined negative about the code, asserted by a report that examined none of it, to an
      // agent that acts on it. "Found, nothing calls it" and "no such function" are indeed different
      // answers and the guard is right to separate them; what it cannot do is choose between them from
      // a report that judged nothing. Skipping it here hands the case to each tool's own completeness
      // reader, which emits the caveat document (Rung A).
      //
      // CORRUPTION IS NOT A HEDGE and must stay loud: `unreadable` falls through to the guard, whose
      // `loadReportLoud` throws — §2 ⟨0.24⟩ impeaches a document whose signature keys cannot be read
      // rather than qualifying it.
      const fnComp = t.noReport ? null : Q.reportCompleteness(prefix);
      const fnHedges = !!fnComp && !fnComp.unreadable?.length && Q.mustHedge(fnComp);
      if (args.fn !== undefined && !fnHedges) {
        const names = [...new Set([...Object.keys(Q.loadCallgraph(prefix)), ...loadReportLoud(prefix).map((e) => e.fn)])];
        if (Q.matches(names, args.fn).length === 0)
          return result(id, { content: [{ type: "text", text: `candor: no function matching \`${clip(args.fn)}\` in this report` }], isError: true });
      }
      const out = t.run(args, prefix);
      // Minified, not pretty-printed: the consumer is an AGENT (it parses the JSON), so the indentation
      // was ~25-30% of every result's tokens for no benefit. The CLI keeps its human-readable shapes.
      return result(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      // A tool-level failure is reported in the result (isError), not as a protocol error.
      return result(id, { content: [{ type: "text", text: `candor: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) error(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // ignore unparseable frames
    // A JSON-RPC frame is a (non-null, non-array) object. `null`, a bare primitive, or a batch array
    // would crash `handle`'s destructure — and the catch's own `msg.id` deref re-threw OUTSIDE the
    // handler, killing the whole server (and the agent's session) on a single `null\n` line (review find).
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    try { handle(msg); } catch (e) { if (msg.id !== undefined) error(msg.id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
