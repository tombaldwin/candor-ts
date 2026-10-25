#!/usr/bin/env python3
"""Bucket every SILENT (cell, arm) at the CALLER (site when it is in the consumer, else Q) by mechanism, and map buckets
to register rows. A bucket is a hypothesis about mechanism read from the code; each is backed by an isolated re-scan
of one representative (iso/). Prints the table used in REPORT.md."""
import json, collections, os, sys
S = sys.argv[1]
V = [json.loads(l) for l in open(os.path.join(os.environ.get("CT_OUT", os.path.join(S, "out")), "verdicts.jsonl"))]
CLS = {"cls", "abs", "jcls_doc", "jcls_untyped", "jproto_doc", "jproto_untyped", "jmixin_untyped"}
IFACE = {"iface", "objlit", "struct", "gen", "field"}
REF = {"callm", "defer", "hofref", "thenref"}
NOSITE = {"eqeq", "numcall", "jsonnest", "await"}
COERCE = {"tpl", "str", "plus", "unplus", "json", "xtostr_u", "tpl_u"}
def bucket(r):
    K, R, L, lang = r["K"], r["R"], r["L"], r["lang"]
    if K in NOSITE: return "S1 no site arm (==, Number(), nested JSON, await thenable)", "R1248"
    if lang == "js" and R in ("jproto_doc", "jproto_untyped", "jmixin_untyped") and K in COERCE | {"getter", "iter", "spread"}:
        return "J1 JS prototype/Object.assign member is no coercion/iteration/accessor target", "-"
    if lang == "js" and R in ("jproto_doc", "jproto_untyped") and K in REF:
        return "J2 JS prototype member passed by reference", "-"
    if L == "dsite" and R == "cls":
        return "T7 dep site dispatching on a dep CONCRETE class, consumer subclass overrides (chained)", "-"
    if K in REF and R in CLS: return "T1 member REFERENCE through a class receiver: no override fan-out", "-"
    if K == "getter" and R in IFACE: return "T2 getter through an interface/type-literal receiver", "-"
    if K in ("iter", "spread"): return "T3 iteration target: own [Symbol.iterator] only, no CHA/override", "-"
    if K in ("xtostr_u", "tpl_u"):
        if L in ("dimp",) and K == "tpl_u": return "T4c `${x}` over a DEP abstraction lacking toString (chained/split)", "R1309-shape"
        return "T4 hook member NOT declared on the abstraction (x.toString() on I)", "R1311 c_expl"
    if R == "gen" and K in COERCE: return "T5 coercion over a type parameter `T extends I`", "R1311 c_gentostr"
    if L == "dsite" and K in COERCE | {"getter", "xtostr"}: return "T8 dep-side hook over a dep interface, consumer implementor (chained)", "R1309"
    return "T9 other", "?"
def caller(r): return r["role"] == ("site" if r["L"] != "dsite" else "q")
sil = [r for r in V if r["v"] == "SILENT" and caller(r)]
eff = [r for r in V if caller(r) and r["v"] in ("CHARGED", "DISCLOSED", "DISC-INV", "SILENT")]
print("caller units with the effect executed:", len(eff), " SILENT:", len(sil))
print("by arm:", dict(collections.Counter(r["arm"] for r in sil)))
t = collections.defaultdict(collections.Counter)
for r in sil:
    b, row = bucket(r)
    t[(b, row)][r["arm"]] += 1
arms = sorted({r["arm"] for r in sil})
print("\n%-95s %-18s %s" % ("bucket", "row", " ".join(a for a in arms)))
for (b, row), c in sorted(t.items()):
    print("%-95s %-18s %s" % (b, row, " ".join("%*d" % (len(a), c[a]) for a in arms)), "| total", sum(c.values()))
# distinct (K,R,L,A) shapes per bucket, E collapsed
shapes = collections.defaultdict(set)
for r in sil: shapes[bucket(r)[0]].add((r["lang"], r["K"], r["R"], r["L"], r["A"]))
print("\ndistinct shapes (E and N collapsed) per bucket:")
for b in sorted(shapes): print("  %3d  %s" % (len(shapes[b]), b))
# effect axis invariance: same (lang,K,R,N,L,A,role) differ across E?
g = collections.defaultdict(set)
for r in V: g[(r["lang"], r["K"], r["R"], r["N"], r["L"], r["A"], r["role"])].add((r["E"], r["v"]))
diff = [(k, sorted(v)) for k, v in g.items() if len({x[1] for x in v}) > 1]
print("\nE-axis: shapes whose verdict differs by effect:", len(diff))
for k, v in diff[:20]: print("  ", k, v)
