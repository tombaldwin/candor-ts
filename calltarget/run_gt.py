#!/usr/bin/env python3
"""Execute every cell's Q under node in a fresh cwd and record whether the effect happened (ground truth).
Fs/Exec cells run 2-wide; Net cells run serially (one fixed port, 47361). Writes <work>/m/gt.jsonl.
Usage: run_gt.py <work-dir> [pnpm]
The dimp/dsite consumer runs against the flat install; the pnpm copy is the same source (checked by spot run)."""
import json, os, subprocess, sys, tempfile, shutil
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__)); S = sys.argv[1]; M = os.path.join(S, "m")
cells = [json.loads(l) for l in open(os.path.join(M, "cells.jsonl"))]
only = sys.argv[2:]  # optional list of L values (e.g. dimp-pnpm) — runs pnpm layout variants

def run(c, variant=""):
    modp = os.path.join(M, c["q_module"])
    if variant: modp = modp.replace(f"src-{c['lang']}-{c['L']}/", f"src-{c['lang']}-{c['L']}-{variant}/")
    d = tempfile.mkdtemp(prefix="gt", dir=os.path.join(S, "gtcwd"))
    try:
        r = subprocess.run(["node", os.path.join(HERE, "drv.cjs"), modp, c["q_fn"], c["E"], str(c["wait"])], cwd=d,
                           capture_output=True, text=True, timeout=30)
        try: o = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception: o = {"pre": None, "post": None, "err": "driver: " + (r.stderr or r.stdout)[:200]}
    finally:
        shutil.rmtree(d, ignore_errors=True)
    o["id"] = c["id"]; o["variant"] = variant or "flat"
    return o

os.makedirs(os.path.join(S, "gtcwd"), exist_ok=True)
variant = "pnpm" if "pnpm" in only else ""
todo = [c for c in cells if (not variant or c["L"] in ("dimp", "dsite"))]
res = []
with ThreadPoolExecutor(2) as ex:
    res += list(ex.map(lambda c: run(c, variant), [c for c in todo if c["E"] != "Net"]))
for c in [c for c in todo if c["E"] == "Net"]:
    res.append(run(c, variant))
out = os.path.join(M, "gt%s.jsonl" % ("-" + variant if variant else ""))
with open(out, "w") as fh:
    for o in res: fh.write(json.dumps(o) + "\n")
bad = [o for o in res if o["err"] or o["pre"]]
byid = {c["id"]: c for c in cells}
mism = [o for o in res if o["post"] != byid[o["id"]]["expect_effect"]]
print("ran", len(res), "errors/pre-effects", len(bad), "post!=expected", len(mism))
for o in (bad + mism)[:30]: print("  ", byid[o["id"]]["lang"], byid[o["id"]]["L"], byid[o["id"]]["K"], byid[o["id"]]["R"], byid[o["id"]]["N"], byid[o["id"]]["E"], o)
print("=== gt done ===")
