#!/bin/bash
# The call-target matrix, end to end, in one command:
#
#   bash calltarget/run.sh <work-dir>            generate, build, execute ground truth, scan, gate, compare
#   bash calltarget/run.sh <work-dir> --reuse    skip generate/build/ground truth (an existing <work-dir>/m)
#
# 8,762 generated programs over lang × location × call kind × receiver typing × implementors × effect — 8,099 hook
# cells plus (round 2) 663 NON-INVOKING LOOK-ALIKES with their positive twins (`la_*`/`pos_*`/`cp_*`: `const` vs
# `using`, object spread vs iteration and vs a copy of an own getter, `in`/`===`/`typeof`, a stored function value,
# a data property, a reassigned parameter) and dispatch CONTROLS (`wx_*`: an unrelated class with the same member, an
# exact-type value, the re-key leg); each
# one EXECUTED under node to observe whether the effect really happens, then scanned on 13 arms (one tree,
# split modules, a dependency unchained / chained flat / chained pnpm) and every gated unit judged by the GATE
# (`deny E <unit>` and `deny E Unknown <unit>`), not by the row. Verdicts: CHARGED / DISCLOSED / DISC-INV /
# SILENT where the effect ran, CLEAN / OVERDISC / FABRICATED where it did not. `compare.py` diffs them against
# the committed baseline and FAILS on any unit that moved toward SILENT or FABRICATED, or any control
# (`N=pure`/`N=sib`) cell that moved at all.
#
# Not wired into per-commit CI: a full run is ~25 min (ground truth ~20 of it; `--reuse` ~2.5 min) and needs
# port 47361 free. Heavy: hold the shared
# machine's A/B lock if one exists. Environment: CT_SCAN / CT_QUERY override the scanner and the gate
# (hold the gate constant when comparing two scanners); CANDOR_CT_ORACLE_OFF=1 is the oracle's same-file
# control; CT_OUT names the output directory (default <work-dir>/out).
set -u
WORK=${1:?usage: run.sh <work-dir> [--reuse]}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$WORK"
if [ "${2:-}" != "--reuse" ]; then
  python3 "$HERE/gen.py" "$WORK/m" || exit 2
  bash "$HERE/build.sh" "$WORK" > "$WORK/build.log" 2>&1 || exit 2
  python3 "$HERE/run_gt.py" "$WORK" | tail -3 || exit 2
fi
python3 "$HERE/measure.py" "$WORK" > "$WORK/measure.log" 2>&1 || { tail -5 "$WORK/measure.log"; exit 2; }
python3 "$HERE/analyze.py" "$WORK" > "${CT_OUT:-$WORK/out}/analyze.txt" || exit 2
python3 "$HERE/buckets.py" "$WORK" > "${CT_OUT:-$WORK/out}/buckets.txt" || exit 2
python3 "$HERE/compare.py" "$HERE/baseline-verdicts.tsv.gz" "${CT_OUT:-$WORK/out}/verdicts.jsonl"
