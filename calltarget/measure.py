#!/usr/bin/env python3
"""Scan every arm with the engine under test (CT_SCAN; default this repo's scan.mjs) and classify each gated unit (SITE, Q) per cell.
Arms: <lang>-<L>-<U|C|P>: U = unchained, C = chained via CANDOR_DEPS (flat npm-style copy), P = chained, pnpm layout.
Then gate EVERY gated unit twice through candor-ts-query (`deny <E> <fn>` and `deny <E> Unknown <fn>`) — the gate
verdict, not the row, is the primary classification. Writes out/results.jsonl."""
import json, os, subprocess, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); S = sys.argv[1]; M = os.path.join(S, "m"); O = os.environ.get("CT_OUT", os.path.join(S, "out"))
# The scanner and the gate under test. Hold the GATE constant when comparing two scanners (CT_QUERY), so a
# verdict change is the scanner's alone.
SCAN = os.environ.get("CT_SCAN", "").split() or ["node", os.path.join(HERE, "..", "scan.mjs")]
QUERY = os.environ.get("CT_QUERY", "").split() or ["node", os.path.join(HERE, "..", "query.mjs")]
cells = [json.loads(l) for l in open(os.path.join(M, "cells.jsonl"))]

def run(argv, cwd, deps=None):
    env = dict(os.environ); env.pop("CANDOR_DEPS", None); env.pop("CANDOR_POLICY", None)
    if deps: env["CANDOR_DEPS"] = deps
    return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)

def scan(projdir, pre, js, deps=None):
    argv = SCAN + ["tsconfig.json", "--out", pre] + (["--allow-js"] if js else [])
    r = run(argv, projdir, deps)
    open(pre + ".log", "w").write(r.stdout + r.stderr)
    if not os.path.exists(pre + ".json"): sys.exit("no report " + pre + " " + r.stderr[-800:])
    return pre + ".json"

def main():
    os.makedirs(O, exist_ok=True)
    deprep = {}
    for dep in sorted(os.listdir(os.path.join(M, "dep"))):
        d = os.path.join(M, "dep", dep)
        if not os.path.isdir(d): continue
        if os.environ.get("CT_ARMS") and not any(a.split("-")[1] in dep and a.endswith(("C", "P")) for a in os.environ["CT_ARMS"].split(",")): continue
        deprep[dep] = scan(d, os.path.join(O, "dep-" + dep), dep.endswith("js"))
        print("dep", dep, deprep[dep], flush=True)
    arms = []
    for lang in ("ts", "js"):
        for L in ("same", "mod", "dimp", "dsite"):
            p = os.path.join(M, f"src-{lang}-{L}")
            if not os.path.isdir(p): continue
            if L in ("same", "mod"):
                arms.append((lang, L, "U", p, None))
            else:
                dr = deprep.get(f"dep{L}{lang}")
                arms += [(lang, L, "U", p, None), (lang, L, "C", p, dr), (lang, L, "P", p + "-pnpm", dr)]
    results = []
    only = set(filter(None, os.environ.get("CT_ARMS", "").split(",")))   # a subset, e.g. CT_ARMS=ts-same-U,js-same-U
    for lang, L, A, p, dr in arms:
        tag = f"{lang}-{L}-{A}"
        if only and tag not in only: continue
        rep = scan(p, os.path.join(O, tag), lang == "js", dr)
        d = json.load(open(rep))
        rows = {}
        for e in d["functions"]:
            rows.setdefault(e["fn"], []).append(e)
        by_suffix = {}
        for fn in rows:
            by_suffix.setdefault(fn.split(".", 2)[-1] if fn.count(".") >= 2 else fn, []).append(fn)
        mine = [c for c in cells if c["lang"] == lang and c["L"] == L]
        units = []
        for c in mine:
            for role in (("site", "q") if c["site_in_consumer"] else ("q",)):
                name = c["site_fn"] if role == "site" else c["q_fn"]
                fqs = [fn for fn in rows if fn.endswith("." + name) or fn == name]
                units.append((c, role, name, fqs))
        # gate: one policy per (effect, form) over every unit; violations give the fired set
        fired = collections.defaultdict(set)
        for form in ("E", "EU"):
            for E in ("Fs", "Net", "Exec"):
                us = [u for u in units if u[0]["E"] == E]
                if not us: continue
                pol = os.path.join(O, f"{tag}.{E}.{form}.pol")
                with open(pol, "w") as fh:
                    for c, role, name, fqs in us:
                        scope = fqs[0] if fqs else f"src.c{c['id']}_x.{name}"
                        fh.write(f"deny {E}{' Unknown' if form == 'EU' else ''} {scope}\n")
                gj = pol + ".gj.json"
                r = run(QUERY + ["gate", "--report", rep, "--policy", pol, "--gate-json", gj], p)
                g = json.load(open(gj))
                for v in g.get("violations", []):
                    fired[(form, v.get("fn"))].add(v.get("rule"))
                open(pol + ".log", "w").write(f"exit={r.returncode}\n" + r.stdout[-3000:] + r.stderr[-3000:])
        for c, role, name, fqs in units:
            row = rows[fqs[0]][0] if fqs else None
            E = c["E"]
            inf = set(row.get("inferred", [])) if row else set()
            res = dict(id=c["id"], arm=tag, lang=lang, L=L, A=A, K=c["K"], R=c["R"], N=c["N"], E=E, role=role,
                       unit=fqs[0] if fqs else name, nrows=len(fqs) and len(rows[fqs[0]]),
                       present=bool(row), charged=E in inf, unknown="Unknown" in inf,
                       invisible=bool(row and row.get("invisible")), incomplete=bool(row and row.get("incomplete")),
                       inferred=sorted(inf), why=(row or {}).get("unknownWhy", []), inv=(row or {}).get("invisible", []),
                       disp=(row or {}).get("dispatchesOn", []),
                       gateE=any(fqs and (fq == fqs[0]) for fm, fq in fired if fm == "E" and fq == (fqs[0] if fqs else None)),
                       gateEU=any(fm == "EU" and fq == (fqs[0] if fqs else None) for fm, fq in fired))
            results.append(res)
        print("arm", tag, "units", len(units), flush=True)
    with open(os.path.join(O, "results.jsonl"), "w") as fh:
        for r in results: fh.write(json.dumps(r) + "\n")
    print("=== measure done ===")

if __name__ == "__main__":
    main()
