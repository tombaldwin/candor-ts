#!/usr/bin/env bash
# candor-ts self-gate (SPEC §7.12): candor-ts analyzes ITSELF and holds its own declared boundary.
# An effect-gate vendor whose own gate is red has no business gating anyone else.
#
# TWO HALVES, because a policy file cannot say "deny Exec everywhere except these three" (candor-java
# splits the same problem the same way, and .candor/policy explains why):
#   (1) the whole engine under .candor/policy — `deny Net Db Ipc`, no exceptions;
#   (2) the set of Exec-performing units is EXACTLY the declared self-invocation list below.
#
# Half (2) is a CARVE-OUT OF PROVEN-SAFE UNITS, not an allowlist of exempt files: an Exec appearing
# anywhere else — including in a module added tomorrow — fails, and so does a declared entry that
# STOPS performing Exec (a stale exemption is a gate that has quietly stopped asserting anything).
#
# WHAT IS SCANNED comes from ci/self-gate.tsconfig.json, which EXCLUDES the test harness rather than
# LISTING the engine. Same reason: a new engine module is gated by default. --allow-js is required
# because candor-ts's own implementation is `.mjs` — without it the scan reads ONE file (Cases.ts, the
# test fixture) and reports a confident all-clear about none of the engine.
#
# EVERY WRITE GOES TO A TEMP DIR — nothing under the working tree is touched (candor-rust's self-gate
# learned this the hard way: it deleted eight tracked report files and got caught in a `git add -A`).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/candor-ts-self-gate.XXXXXX")"
trap 'rm -rf "$WS"' EXIT

# The three self-invocation sites, by unit. `<module>` entries are the module initializers that inherit
# the effect from the import-time call graph — they are the same three files, not extra ones.
DECLARED_EXEC="scan.runRounds
scan.<module>
watch.scanOnce
watch.main
watch.<module>
verify.<module>"

node "$ROOT/scan.mjs" "$ROOT/ci/self-gate.tsconfig.json" --allow-js \
     --policy "$ROOT/.candor/policy" --out "$WS/report" > "$WS/scan.log" 2>&1
gate_rc=$?
# Trim the per-function Unknown advisory — 305 lines of `→ add deny … Unknown` suggestions that bury
# the verdict in CI. The COUNT stays (the summary line and the note's own header), so the advisory is
# still visible as a number; only the enumeration goes. Violations are never filtered.
grep -v '^    `' "$WS/scan.log"
[ -s "$WS/report.json" ] || { echo "self-gate: candor-ts produced no report"; exit 2; }

# Half (2). Unit names carry the tsconfig's relative-path prefix (`...scan.runRounds`), so compare on
# the trailing segment — pinned here rather than in the declared list, which stays readable.
DECLARED="$DECLARED_EXEC" python3 - "$WS/report.json" <<'PY'
import json, os, re, sys
declared = {l.strip() for l in os.environ["DECLARED"].splitlines() if l.strip()}
fns = json.load(open(sys.argv[1])).get("functions", [])
found = {re.sub(r"^[.]+", "", e["fn"]) for e in fns if "Exec" in e.get("inferred", [])}
new, stale = sorted(found - declared), sorted(declared - found)
for f in new:
    print(f"  AS-EFF-006  {f} performs Exec — not a declared self-invocation site.")
    print( "              candor-ts spawns a process in three places and says so in .candor/policy.")
    print( "              If this one is legitimate, add it there AND to ci/self-gate.sh's list.")
for f in stale:
    print(f"  STALE       {f} is declared Exec-exempt but no longer performs Exec — drop it.")
    print( "              An exemption nothing exercises is a gate that has stopped asserting.")
sys.exit(1 if (new or stale) else 0)
PY
exec_rc=$?

if [ "$gate_rc" -eq 0 ] && [ "$exec_rc" -eq 0 ]; then
  echo "self-gate: OK — candor-ts reaches no Net/Db/Ipc, and spawns a process only where it declares it does"
  exit 0
fi
# Exit 2 is NOT a violation — it is the ⟨0.21⟩ fail-closed "could not evaluate" verdict (unanalyzed source),
# and this project treats that distinction as load-bearing everywhere else. Reporting it as "the
# boundary is red" sends the reader hunting for a subprocess that does not exist, and collapsing it to
# exit 1 tells CI a violation was ESTABLISHED. Preserved as 2. (Found by review in the java arm first;
# all three self-gates were written with the same collapse.)
# …and ONLY when half (2) is clean. This branch used to fire regardless, so an ESTABLISHED
# AS-EFF-006 violation was announced as "not a violation, the boundary was never judged" and
# the FAILED line below became unreachable — the could-not-evaluate collapse INVERTED, by the
# change that fixed it in the other direction.
if [ "$gate_rc" -eq 2 ] && [ "$exec_rc" -eq 0 ]; then
  echo "self-gate: COULD NOT EVALUATE — candor-ts exited 2 over its own sources (the boundary was never"
  echo "  judged, so this is not a clean result and not a violation). Fix the input, then re-run."
  exit 2
fi
[ "$gate_rc" -ne 0 ] && echo "self-gate: FAILED — the declared boundary in .candor/policy is red (exit $gate_rc)"
[ "$exec_rc" -ne 0 ] && echo "self-gate: FAILED — the Exec set does not match the declared self-invocation list"
exit 1
