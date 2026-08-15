#!/usr/bin/env bash
# Sharding test.mjs is only safe if the shards TOGETHER run every block exactly once. This asserts it.
#
# WHY IT IS NOT OPTIONAL. `--shard=I/N` filters by a running block index, and the failure mode of a
# filter is silence: a block that no shard claims does not error, it simply never runs, and CI shows N
# green shards. "All shards passed" and "one shard quietly ran nothing" are the same observation from
# the outside — the shape this project keeps finding in its own gates. So the count is the check:
#
#   sum(pass over the N shards) == pass from an unsharded run
#
# WHAT THIS DOES NOT CATCH, stated because an earlier version of this comment claimed it did: a modulus
# mistake that runs one block TWICE and drops another keeps the sum equal and passes here. Catching that
# needs each shard to report the indices it claimed, which test.mjs has no flag for. Nor can the sum see
# a shard filter that is CORRECT but not concurrent — the totals are identical whether the children run
# together or in a queue, which is how a `spawnSync`-in-a-map driver measured 289s against 286s and
# passed this gate cleanly. Only the clock catches that one.
#
# Slow by construction — it runs the suite N+1 times — so it is a CHANGE gate, not a per-push one: run
# it whenever the sharding logic or the block structure changes.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${1:-4}"
cd "$HERE" || exit 2

echo "== unsharded baseline =="
# ANCHOR ON THE SUMMARY, not on the last line. scratch.mjs's exit sweep prints
# "  (N fixture tree(s) kept for inspection …)" AFTER the summary on any FAILING run, so
# `tail -1` came back with that instead — both red branches below were dead code, and a
# genuine failure was reported as "could not parse", the could-not-evaluate collapse this
# same release fixed in the self-gates. `2>&1` compounded it: any trailing stderr byte did
# the same. Also drops 2>&1 — stderr has no summary line to contribute.
base="$(node test.mjs 2>/dev/null | grep -E '^test: [0-9]+ passed' | tail -1)"
echo "  $base"
base_pass="$(printf '%s' "$base" | sed -nE 's/^test: ([0-9]+) passed, ([0-9]+) failed$/\1/p')"
base_fail="$(printf '%s' "$base" | sed -nE 's/^test: ([0-9]+) passed, ([0-9]+) failed$/\2/p')"
[ -n "$base_pass" ] || { echo "shard-check: could not parse the baseline summary line"; exit 2; }
[ "$base_fail" = "0" ] || { echo "shard-check: the baseline itself is RED ($base_fail failed) — fix that first"; exit 1; }

echo "== $N shards =="
total=0; anyfail=0
for i in $(seq 0 $((N-1))); do
  line="$(node test.mjs --shard="$i/$N" 2>/dev/null | grep -E '^test: [0-9]+ passed' | tail -1)"
  p="$(printf '%s' "$line" | sed -nE 's/^test: ([0-9]+) passed, ([0-9]+) failed$/\1/p')"
  f="$(printf '%s' "$line" | sed -nE 's/^test: ([0-9]+) passed, ([0-9]+) failed$/\2/p')"
  [ -n "$p" ] || { echo "  shard $i/$N: unparseable summary '$line'"; exit 2; }
  printf '  shard %s/%s: %s passed, %s failed\n' "$i" "$N" "$p" "$f"
  total=$((total + p)); [ "$f" = "0" ] || anyfail=1
done

echo
if [ "$anyfail" != 0 ]; then echo "shard-check: FAILED — a shard is red"; exit 1; fi
if [ "$total" != "$base_pass" ]; then
  echo "shard-check: FAILED — shards ran $total assertions, unsharded runs $base_pass."
  echo "  A block is claimed by no shard (or by two). N green shards prove nothing on their own;"
  echo "  this difference is the only thing that can see it."
  exit 1
fi
echo "shard-check: OK — $N shards run exactly the unsharded $base_pass assertions, no block lost or doubled"
