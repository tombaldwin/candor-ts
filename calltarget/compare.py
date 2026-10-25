#!/usr/bin/env python3
"""Compare a matrix run's verdicts with a baseline, unit by unit (cell id, arm, role).

    compare.py <baseline.tsv[.gz] | verdicts.jsonl> <verdicts.jsonl> [--write <baseline.tsv.gz>]

Prints every transition with its count and, at the CALLER (the site when it is in the scanned consumer, else Q),
the SILENT / FABRICATED totals before and after. Exit 1 when any unit moved TOWARD silence (CHARGED/DISCLOSED/
DISC-INV -> SILENT, CHARGED -> DISCLOSED/DISC-INV) or toward fabrication (-> FABRICATED), or when any control
cell (N=pure, N=sib) moved anywhere but between CLEAN and OVERDISC. A control's CLEAN <-> OVERDISC move is a
disclosure-cost change, counted and printed (price it by reach), not a failure. `--write` stores the second
argument as the new baseline (do that in the commit that changes the engine, so the baseline moves with it)."""
import gzip, json, sys, collections

def load(p):
    if p.endswith(".jsonl"):
        out = {}
        for l in open(p):
            r = json.loads(l)
            out[(r["id"], r["arm"], r["role"])] = (r["v"], r["L"], r["N"], r["K"], r["R"], r["lang"])
        return out
    op = gzip.open if p.endswith(".gz") else open
    out = {}
    with op(p, "rt") as fh:
        for l in fh:
            if l.startswith("#"): continue
            i, arm, role, v, L, N, K, R, lang = l.rstrip("\n").split("\t")
            out[(i, arm, role)] = (v, L, N, K, R, lang)
    return out

def caller(k, meta): return k[2] == ("site" if meta[1] != "dsite" else "q")
WORSE = {("CHARGED", "SILENT"), ("DISCLOSED", "SILENT"), ("DISC-INV", "SILENT"), ("CHARGED", "DISCLOSED"),
         ("CHARGED", "DISC-INV")}
def main():
    a, b = load(sys.argv[1]), load(sys.argv[2])
    if set(a) != set(b):
        print(f"UNIT SETS DIFFER: {len(set(a) - set(b))} only in baseline, {len(set(b) - set(a))} only in run")
    tr = collections.Counter(); bad = []; warn = []
    for k in sorted(set(a) & set(b)):
        va, vb = a[k][0], b[k][0]
        if va == vb: continue
        tr[(va, vb)] += 1
        ctl = a[k][2] in ("pure", "sib")
        if (va, vb) in WORSE or vb == "FABRICATED" or (ctl and {va, vb} != {"OVERDISC", "CLEAN"}):
            bad.append((k, a[k], va, vb))
        elif ctl: warn.append((k, a[k], va, vb))
    for side, d in (("baseline", a), ("run", b)):
        cs = [k for k in d if caller(k, d[k])]
        c = collections.Counter(d[k][0] for k in cs)
        print(f"{side:9s} caller units {len(cs)}: SILENT {c['SILENT']}  FABRICATED {c['FABRICATED']}  CHARGED {c['CHARGED']}"
              f"  DISCLOSED {c['DISCLOSED']}  DISC-INV {c['DISC-INV']}  CLEAN {c['CLEAN']}  OVERDISC {c['OVERDISC']}")
    print("transitions (all units):")
    for (va, vb), n in sorted(tr.items(), key=lambda x: -x[1]): print(f"  {va:>10s} -> {vb:<10s} {n}")
    print("control (pure/sib) CLEAN<->OVERDISC moves (disclosure cost):", dict(collections.Counter((va, vb) for k, m, va, vb in warn)) or 0)
    print("  by (lang, L, A, K, R):", dict(collections.Counter((m[5], m[1], k[1][-1], m[3], m[4]) for k, m, va, vb in warn)))
    for k, m, va, vb in bad[:40]: print("  BAD", k, m[1:], va, "->", vb)
    if "--write" in sys.argv:
        out = sys.argv[sys.argv.index("--write") + 1]
        with gzip.open(out, "wt") as fh:
            fh.write("# id\tarm\trole\tverdict\tL\tN\tK\tR\tlang\n")
            for k in sorted(b): fh.write("\t".join([*k, *b[k]]) + "\n")
        print("baseline written:", out, len(b), "units")
    print("RESULT:", "FAIL" if bad else "OK", f"({len(bad)} unit(s) toward silence/fabrication or a control moved)")
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
