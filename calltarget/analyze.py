#!/usr/bin/env python3
"""Join executed ground truth with the gate verdicts. Verdict per (cell, arm, unit):
  effect happened:  CHARGED (deny E fires) / DISCLOSED (only deny E Unknown fires) / SILENT (neither fires)
  effect did not:   CLEAN / OVERDISC (only deny E Unknown) / FABRICATED (deny E fires; N=pure has NO effectful body
                    in the cell, N=sib has one only in a sibling outside the receiver's static subtree)
Ground truth for the P (pnpm) arms is the flat run unless gt-pnpm.jsonl exists (same source bytes)."""
import json, os, sys, collections
S = sys.argv[1]; M = os.path.join(S, "m"); O = os.environ.get("CT_OUT", os.path.join(S, "out"))
cells = {json.loads(l)["id"]: json.loads(l) for l in open(os.path.join(M, "cells.jsonl"))}
gt = {json.loads(l)["id"]: json.loads(l) for l in open(os.path.join(M, "gt.jsonl"))}
res = [json.loads(l) for l in open(os.path.join(O, "results.jsonl"))]
out = []
for r in res:
    g = gt.get(r["id"])
    if not g or g["err"] or g["pre"]:
        v = "INVALID"
    elif g["post"]:
        v = "CHARGED" if r["gateE"] else ("DISCLOSED" if r["gateEU"] else ("DISC-INV" if r["invisible"] else "SILENT"))
    else:
        v = "FABRICATED" if r["gateE"] else ("OVERDISC" if r["gateEU"] else "CLEAN")
    r["v"] = v
    r["rowgate_mismatch"] = (r["charged"] != r["gateE"])
    out.append(r)
with open(os.path.join(O, "verdicts.jsonl"), "w") as fh:
    for r in out: fh.write(json.dumps(r) + "\n")
tot = collections.Counter(r["v"] for r in out)
print("TOTAL units", len(out), dict(tot))
print("row/gate mismatches (row charged != deny E fired):", sum(r["rowgate_mismatch"] for r in out))
inv = [r for r in out if r["v"] == "INVALID"]
print("INVALID", len(inv), collections.Counter((r["lang"], r["L"], r["K"], r["R"]) for r in inv).most_common(5))
def table(key, filt=lambda r: True, vs=("CHARGED", "DISCLOSED", "DISC-INV", "SILENT", "CLEAN", "OVERDISC", "FABRICATED")):
    t = collections.defaultdict(collections.Counter)
    for r in out:
        if filt(r): t[key(r)][r["v"]] += 1
    print("%-40s" % "key", " ".join("%10s" % v for v in vs))
    for k in sorted(t):
        print("%-40s" % (k,), " ".join("%10d" % t[k][v] for v in vs))
if __name__ == "__main__":
    print("\n== by arm"); table(lambda r: r["arm"])
    print("\n== by arm x role"); table(lambda r: (r["arm"], r["role"]))
    print("\n== by K (all arms)"); table(lambda r: r["K"])
    print("\n== by R (all arms)"); table(lambda r: (r["lang"], r["R"]))
    print("\n== by E"); table(lambda r: (r["E"], r["L"]))
