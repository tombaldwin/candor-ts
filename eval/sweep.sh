#!/usr/bin/env bash
# Real-repo robustness/profile sweep — the Rust 1,294-crate calibration's TS analog (smaller: the
# npm install per repo is the cost). For each repo: clone @ HEAD, npm install (type resolution needs
# the deps' types), scan, record. A failure is a RESULT, not a skip.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${SWEEP_DIR:-$(mktemp -d)}"
REPOS=(
  isaacs/rimraf sindresorhus/execa sindresorhus/got sindresorhus/ky colinhacks/zod
  sindresorhus/p-queue sindresorhus/globby sindresorhus/del sindresorhus/conf
  ai/nanoid tj/commander chalk/chalk
)
printf "%-22s %6s %6s %6s %6s %7s %8s  %s\n" repo files fns eff unres time_s status effects
for full in "${REPOS[@]}"; do
  name="${full##*/}"
  d="$W/$name"
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$full" "$d" 2>/dev/null \
    || { printf "%-22s %s\n" "$name" "CLONE-FAILED"; continue; }
  ( cd "$d" && npm install --no-fund --no-audit --ignore-scripts >/dev/null 2>&1 ) || true
  start=$(python3 -c 'import time; print(time.time())')
  out=$(node "$HERE/scan.mjs" "$d" 2>&1)
  rcode=$?
  end=$(python3 -c 'import time; print(time.time())')
  t=$(python3 -c "print(f'{$end-$start:.1f}')")
  if [ ! -f "$d/.candor/report.json" ]; then
    printf "%-22s %6s %6s %6s %6s %7s %8s  %s\n" "$name" - - - - "$t" "FAIL" "$(echo "$out" | head -1 | cut -c1-60)"
    continue
  fi
  python3 - "$name" "$d/.candor/report.json" "$d/.candor/report.callgraph.json" "$out" "$t" <<'PY'
import json, sys, re
name, rp, cp, out, t = sys.argv[1:6]
r = json.load(open(rp)); g = json.load(open(cp))
fns = r["functions"]
m = re.search(r"\((\d+) analyzed, (\d+) files\)", out)
analyzed, files = (m.group(1), m.group(2)) if m else (len(g), "?")
unres = sum(1 for f in fns if f["unresolved"])
effs = {}
for f in fns:
    for e in f["inferred"]:
        effs[e] = effs.get(e, 0) + 1
eff_s = " ".join(f"{k}:{v}" for k, v in sorted(effs.items()))
print(f"{name:<22} {files:>6} {analyzed:>6} {len(fns):>6} {unres:>6} {t:>7} {'ok':>8}  {eff_s}")
PY
done
echo "workdir: $W"
