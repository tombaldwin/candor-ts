// SPEC §6.2 ⟨0.41⟩ — `accepts [--report <locator>] [--policy <file>] [--json] [--adopt --because <reason>]`:
// refreshing (or adopting) `accept` lines as a PROPOSED policy. Reference-led: candor-java first (`Accepts.java`).
//
// THE CARDINAL DIRECTION IS ACCEPTING A VIOLATION THAT IS NEW, AND THIS VERB CAN ONLY ACCEPT LESS. It therefore
// decides nothing itself: every fact it uses — which entry is stale, accepted, exceeded, ambiguous or unjudged, which
// rows each rule line produced, which rows an entry took — is read from THIS ENGINE'S OWN GATE (`gateCore` in
// query.mjs, run in-process over the same bytes through `runGate`), so "the same parse and the same matching" holds by
// construction and not by a second implementation that could drift. The proposed text is then gated again to report
// `after`. An entry whose state the gate did not name is KEPT, never deleted. Writes no file.
import { positionalKey } from "./policy.mjs";

const RULE_KINDS = new Set(["deny", "pure", "forbid", "allow", "only"]);
const MARK = "# candor-accepts:";
const REPLACE = " — REPLACE the line above with: ";
const ASCII_WS = /[ \t\n\v\f\r]+/;
const ASCII_WS_TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

const cp = (a, b) => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};
const sortedCp = (c) => [...c].sort(cp);

/** Split at LF, CRLF or a lone CR — the SAME terminators the gate's own parse splits at, because the gate's `line`
 *  numbers must be this verb's line numbers. Every byte lands in exactly one body or terminator. */
function split(buf) {
  const out = [];
  let start = 0;
  const n = buf.length;
  const mk = (body, term) => {
    let text = body.toString("utf8");
    if (out.length === 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // the gate drops a leading BOM
    return { body, term, text };
  };
  for (let i = 0; i < n;) {
    const c = buf[i];
    if (c === 0x0A || c === 0x0D) {
      const tl = (c === 0x0D && i + 1 < n && buf[i + 1] === 0x0A) ? 2 : 1;
      out.push(mk(buf.subarray(start, i), buf.subarray(i, i + tl)));
      i += tl;
      start = i;
    } else i++;
  }
  if (start < n) out.push(mk(buf.subarray(start, n), Buffer.alloc(0)));
  return out;
}

const lex = (text) => {
  const l = text.split("#")[0].replace(ASCII_WS_TRIM, "");
  return l ? l.split(ASCII_WS) : [];
};
const isMark = (text) => /^[ \t]*# candor-accepts:/.test(text);
const commentOf = (text) => { const i = text.indexOf("#"); return i < 0 ? "" : " " + text.slice(i); };

const canon = (concrete, classes) => {
  const t = [...concrete];
  if (classes) t.push(`Unknown[${sortedCp(new Set(classes)).join(",")}]`);
  return t.sort(cp);
};

const rowsOf = (doc) => {
  const out = [];
  if (!doc || !Array.isArray(doc.violations)) return out;
  for (const v of doc.violations) {
    if (v.rule !== "AS-EFF-006" && v.rule !== "AS-EFF-009") continue;
    out.push({ rule: v.rule, fn: v.fn, hash: v.hash ?? null, effects: v.effects ?? [], classes: v.reasonClass ?? [] });
  }
  return out;
};
const rowKey = (r) => `${r.rule}\0${r.fn}\0${sortedCp(new Set(r.effects)).join(",")}`;

const item = (line, fn, rule, because) => {
  const m = { line, fn, policyRule: rule };
  if (because !== null && because !== undefined) m.because = because;
  return m;
};

/** Validate `--because` per §6.2: one argument, lexed by ASCII whitespace; at least one token; no `#`.
 *  Returns the single-spaced reason, or null after printing the usage error. */
export function reasonOf(raw) {
  const toks = raw.split(ASCII_WS).filter((t) => t !== "");
  if (!toks.length) { console.error("candor-ts accepts: --because needs a reason — a value with at least one token."); return null; }
  if (raw.includes("#")) {
    console.error("candor-ts accepts: --because must not contain `#` — a `#` begins a comment on a policy line, so it would cut "
      + "the reason you wrote short. Reword it (the issue number without the hash, say).");
    return null;
  }
  return toks.join(" ");
}

/**
 * @param {{policyPath:string, raw:Buffer, adopt:boolean, because:string|null, json:boolean,
 *          runGate:(lines:string[], probe:boolean)=>{rc:number, doc:object|null, err:string, probe:object|null}}} o
 * @returns {{exit:number, stdout:Buffer|null, stderr:string}}
 */
export function accepts({ policyPath, raw, adopt, because, json, runGate }) {
  let stderr = "";
  const say = (s) => { stderr += s + "\n"; };
  try { new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { say(`candor-ts accepts: cannot read policy ${policyPath} (not valid UTF-8) — no proposal.`); return { exit: 2, stdout: null, stderr }; }
  const input = split(raw);
  const pol = input.map((l) => l.text);
  const n = pol.length;

  // ---- 1. the gate over the input bytes --------------------------------------------------------------
  const g0 = runGate(pol, true);
  const d = g0.doc;
  const answered = (g0.rc === 0 || g0.rc === 1) && d && Array.isArray(d.violations) && d.refused !== true;
  const incomplete = !!(d && d.incomplete === true);
  if (!answered || incomplete) {
    stderr += g0.err;
    say("candor-ts accepts: the gate over this policy and report " + (incomplete
      ? "is INCOMPLETE (a unit it did not read makes its entries look stale, and pruning them would delete the reasons for code that still exists)"
      : `refuses (exit ${g0.rc})`) + " — no proposal. The policy was not changed.");
    if (!pol.some((t) => { const k = lex(t); return k.length > 0 && RULE_KINDS.has(k[0]); }))
      say(`candor-ts accepts: this policy holds no rules. If it was empty because you ran \`candor-ts-query accepts > ${policyPath}\`, a shell `
        + `redirect onto the policy EMPTIES it before the verb reads it — the policy file is now empty; restore it `
        + `(e.g. \`git checkout -- ${policyPath}\`) and write the proposal to ANOTHER path, then diff.`);
    return { exit: 2, stdout: null, stderr };
  }
  const probe = g0.probe ?? { entries: [], directBy: new Map(), twin: new Set() };
  const entries = probe.entries;
  const direct = probe.directBy;
  const twins = probe.twin;

  // ---- 2. what each entry is -------------------------------------------------------------------------
  const ignored = new Set();
  for (const e of d.ignored ?? []) {
    const ln = e.line;
    if (Number.isInteger(ln) && ln >= 1 && ln <= n) { const k = lex(pol[ln - 1]); if (k.length > 0 && k[0] === "accept") ignored.add(ln); }
  }
  const staleLines = new Set();
  for (const v of d.violations) if (v.rule === "AS-EFF-012") { const m = /policy line (\d+) \(/.exec(v.detail ?? ""); if (m) staleLines.add(+m[1]); }
  const status = new Map();
  for (const it of d.accepted ?? []) { if (it.enclosing !== undefined) continue; status.set(it.line, it.status); }
  const ruleTok = new Map();            // rule line -> its tokens, single-spaced
  for (let i = 1; i <= n; i++) { const k = lex(pol[i - 1]); if (k.length > 0 && RULE_KINDS.has(k[0])) ruleTok.set(i, k.join(" ")); }
  // the rows each deny/pure rule line produced ALONE (accept lines and the other rules withheld)
  const per = new Map();
  for (const L of ruleTok.keys()) {
    const k0 = lex(pol[L - 1])[0];
    if (k0 !== "deny" && k0 !== "pure") { per.set(L, []); continue; }
    const lines = pol.map((t, idx) => {
      const k = lex(t);
      if (k.length > 0 && k[0] === "accept") return "# (accept line withheld)";
      if (k.length > 0 && RULE_KINDS.has(k[0]) && idx + 1 !== L) return "# (rule line withheld)";
      return t;
    });
    per.set(L, rowsOf(runGate(lines, false).doc));
  }

  // ---- 3. the changes --------------------------------------------------------------------------------
  const removed = new Map(), narrowed = new Map(), proposals = new Map();
  const unjudged = [];
  const newText = new Map(), proposalComment = new Map();
  for (const e of entries) {
    const L = e.line;
    // STALE only when the gate said so (an AS-EFF-012 row naming this line); an entry it named nowhere is KEPT.
    const st = status.get(L) ?? (staleLines.has(L) ? "stale" : "kept");
    const myLines = [...ruleTok].filter(([, v]) => v === e.ruleKey).map(([k]) => k);
    if (st === "stale") removed.set(L, item(L, e.fn, e.ruleKey, e.because));
    else if (st === "accepted") {
      const conc = new Set(), cls = new Set();
      let unk = false;
      for (const r of direct.get(L) ?? []) {
        for (const x of r.effects) { if (x === "Unknown") unk = true; else conc.add(x); }
        for (const c of r.reasonClass ?? []) cls.add(c);
      }
      const to = canon(conc, unk ? (cls.size === 0 && e.classes ? e.classes : cls) : null);
      const fromConc = new Set(e.effects); fromConc.delete("Unknown");
      const from = canon(fromConc, e.classes);
      const same = to.length === from.length && to.every((x) => from.includes(x)) && from.every((x) => to.includes(x));
      if (!same) {
        const text = `accept ${e.fn} ${to.join(" ")} for ${e.ruleKey} because ${e.because}${commentOf(pol[L - 1])}`;
        narrowed.set(L, { ...item(L, e.fn, e.ruleKey, e.because), from, to, text });
        newText.set(L, text);
      }
    } else if (st === "exceeded") {
      const conc = new Set(), cls = new Set();
      let unk = false;
      for (const ml of myLines)
        for (const r of per.get(ml) ?? [])
          if (r.fn === e.fn) {
            for (const x of r.effects) { if (x === "Unknown") unk = true; else conc.add(x); }
            for (const c of r.classes) cls.add(c);
          }
      const prop = canon(conc, unk ? cls : null);
      const have = new Set(e.effects); have.delete("Unknown");
      let adds = [...conc].filter((x) => !have.has(x));
      if (unk) {
        const extra = new Set(cls);
        for (const c of e.classes ?? []) extra.delete(c);
        if (extra.size) adds.push(`Unknown[${sortedCp(extra).join(",")}]`);
      }
      adds = sortedCp(adds);
      const text = `accept ${e.fn} ${prop.join(" ")} for ${e.ruleKey} because ${e.because}${commentOf(pol[L - 1])}`;
      proposals.set(L, { ...item(L, e.fn, e.ruleKey, e.because), adds, text });
      proposalComment.set(L, `${MARK} exceeded (adds ${adds.join(" ")})${REPLACE}${text}`);
    } else if (st === "unjudged") unjudged.push(item(L, e.fn, e.ruleKey, null));
    // ambiguous, or a state the gate did not name: kept byte for byte
  }
  const ignoredOut = [...ignored].sort((a, b) => a - b).map((line) => ({ line }));

  // ---- adoption candidates: the rows no entry names (computed in both modes: `unnamed`) ---------------
  const cands = [];
  const seen = new Set();
  for (const v of rowsOf(d)) {
    const prod = [];
    for (const [L, rows] of per) if (rows.some((w) => rowKey(w) === rowKey(v) && (w.hash ?? null) === (v.hash ?? null))) prod.push(L);
    prod.sort((a, b) => a - b);
    for (const L of prod) {
      const rule = ruleTok.get(L);
      const named = entries.some((e) => e.fn === v.fn && e.ruleKey === rule);
      if (named || seen.has(`${rule}\0${v.fn}`)) continue;
      seen.add(`${rule}\0${v.fn}`);
      if (twins.has(v.fn)) continue;
      if (positionalKey(v.fn) || /[#\t\n\v\f\r ]/.test(v.fn)) continue;
      const conc = new Set(v.effects);
      const unk = conc.delete("Unknown");
      if (unk && v.classes.length === 0) continue;
      cands.push({ line: L, fn: v.fn, hash: v.hash, rule, effects: canon(conc, unk ? v.classes : null) });
    }
  }
  cands.sort((a, b) => a.line - b.line || cp(a.fn, b.fn));
  const unnamed = [], created = [], createdText = [];
  for (const c of cands) {
    const base = { fn: c.fn, ...(c.hash ? { hash: c.hash } : {}), policyRule: c.rule };
    unnamed.push({ ...base, effects: c.effects });
    if (adopt) {
      const text = `accept ${c.fn} ${c.effects.join(" ")} for ${c.rule} because ${because}`;
      created.push({ ...base, because, effects: c.effects, text });
      createdText.push(text);
    }
  }

  // ---- 4. the proposed text --------------------------------------------------------------------------
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const l = input[i - 1];
    if (isMark(l.text) || removed.has(i)) continue;
    if (newText.has(i)) parts.push(Buffer.from(newText.get(i), "utf8"), l.term);
    else parts.push(l.body, l.term);
    if (proposalComment.has(i)) {
      if (l.term.length === 0) parts.push(Buffer.from("\n"));
      parts.push(Buffer.from(proposalComment.get(i), "utf8"));
      if (l.term.length > 0) parts.push(l.term);
    }
  }
  let body = Buffer.concat(parts);
  if (createdText.length) {
    const o2 = [body];
    if (body.length > 0 && body[body.length - 1] !== 0x0A && body[body.length - 1] !== 0x0D) o2.push(Buffer.from("\n"));
    for (const t of createdText) o2.push(Buffer.from(t + "\n", "utf8"));
    body = Buffer.concat(o2);
  }
  const text = body.toString("utf8");

  // ---- 5. `after`: the gate's verdict over the proposal ------------------------------------------------
  const g1 = runGate(split(body).map((l) => l.text), false);
  let viol = 0, acc = 0;
  if (g1.doc) {
    if (Array.isArray(g1.doc.violations)) viol = g1.doc.violations.length;
    for (const e of g1.doc.accepted ?? []) if (e.status === "accepted") acc++;
  }
  const after = { exit: g1.rc, violations: viol, accepted: acc };

  // ---- 6. output -------------------------------------------------------------------------------------
  let stdout;
  if (json) {
    const plan = { mode: adopt ? "adopt" : "refresh", text, removed: [...removed.values()], narrowed: [...narrowed.values()],
                   proposals: [...proposals.values()] };
    if (adopt) plan.created = created;
    plan.unnamed = unnamed; plan.unjudged = unjudged; plan.ignored = ignoredOut; plan.after = after;
    stdout = Buffer.from(JSON.stringify(plan, null, 1) + "\n", "utf8");
  } else stdout = body;
  say(`candor-ts accepts (${adopt ? "adopt" : "refresh"}): ${removed.size} stale line(s) removed, ${narrowed.size} narrowed, `
    + `${proposals.size} exceeded (proposed in a comment, NOT accepted), ${created.length} created; ${unnamed.length} violation(s) no entry names; `
    + `after the proposal the gate exits ${g1.rc} with ${viol} violation(s), ${acc} accepted.`);
  for (const u of unjudged)
    say(`candor-ts accepts: line ${u.line} (\`${u.fn}\` under \`${u.policyRule}\`) kept UNJUDGED — this route cannot evaluate that rule, so nothing is known about the entry. Gate at scan time.`);
  for (const L of ignored) say(`candor-ts accepts: line ${L} is IGNORED by the gate and kept as written — repairing it is yours.`);
  if (created.length) say("candor-ts accepts: --adopt wrote lines keyed by function name alone. A same-named unit in ANOTHER module gated under the same file "
    + "is accepted on this reason — keep one policy file per separately-gated module (and per engine).");
  say(`candor-ts accepts: nothing was written. To take the proposal: write it to ANOTHER path (not onto the policy — a shell redirect onto it `
    + `empties it first), then \`diff ${policyPath} <that path>\` and commit.`);
  return { exit: 0, stdout, stderr };
}
