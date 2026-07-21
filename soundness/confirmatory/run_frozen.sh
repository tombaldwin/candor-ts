#!/usr/bin/env bash
# The GENUINELY-FROZEN Node/TS confirmatory run (see FROZEN.md). The analog of the JVM arm's run_frozen.sh:
# enforces the pinned classifier hash, then per manifest row — clone@tag, install deps, static-scan, run the
# package's OWN test suite under `candor verify` (the language-level Node preload oracle) IN ONE node process
# — and tabulates EVERY row with a disposition. Aborts if the engine isn't the frozen one. A violation is
# REPORTED (never fixed here).
#
#   ENGINE=/path/to/candor-ts  bash run_frozen.sh            # defaults to ../../ (this checkout)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${ENGINE:-$(cd "$HERE/../.." && pwd)}"
SCOPE="${SCOPE:-all}"          # all = Fs/Net/Exec + Env/Clock/Rand/… (the language-level set the preload sees)
SUITE_TIMEOUT="${SUITE_TIMEOUT:-240}"
WORK="${WORK:-$(mktemp -d)}"
RESULTS="$HERE/results"; mkdir -p "$RESULTS"

# ── FREEZE GATE: the classifier + oracle sources are hashed; abort on drift. candor-ts is a set of .mjs
# files (not a compiled jar), so the "frozen binary" is the sha256 of the concatenated engine sources.
ENGINE_FILES=(scan.mjs scan-core.mjs query-core.mjs policy.mjs surface.mjs \
  verify.mjs verify-core.mjs verify-preload.mjs verify-emit.mjs verify-loader.mjs verify-syscall.mjs)
EXPECT="27b0fe3901bea6aa47ebf80bb9e8665594843dbd0cc98fdbc958e88bf5753293"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"|cut -d' ' -f1; else shasum -a 256 "$1"|cut -d' ' -f1; fi; }
GOT="$( (cd "$ENGINE" && cat "${ENGINE_FILES[@]}") | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | cut -d' ' -f1)"
if [ "$GOT" != "$EXPECT" ]; then
  echo "FROZEN ABORT: engine source hash mismatch"; echo "  got  $GOT"; echo "  want $EXPECT (FROZEN.md)"; exit 1
fi
echo "FROZEN: engine hash verified ($EXPECT)"
echo "engine: $ENGINE   scope: $SCOPE   work: $WORK"

SUMMARY="$RESULTS/FROZEN-SUMMARY.tsv"
printf 'name\tdisposition\tanalyzed\tchecked\tsound_complete\tdisclosed\tviolations\tsha\n' > "$SUMMARY"

grep -vE '^\s*#|^\s*$' "$HERE/manifest.tsv" | while IFS=$'\t' read -r name url tag testbin testargs why; do
  [ -n "$name" ] || continue
  echo; echo "======================= $name ($tag) ======================="
  d="$WORK/$name"; rm -rf "$d"
  if ! git clone -q --depth 1 --branch "$tag" "$url" "$d" 2>/dev/null; then
    echo "  CLONE-FAILED"; printf '%s\tclone-failed\t-\t-\t-\t-\t-\t-\n' "$name" >> "$SUMMARY"; continue
  fi
  sha_commit="$(git -C "$d" rev-parse HEAD)"
  echo "  cloned @ $sha_commit"

  # deps: the test runner + the package's own deps. --ignore-scripts (no lifecycle build) keeps it hermetic.
  if ! ( cd "$d" && timeout "$SUITE_TIMEOUT" npm install --no-fund --no-audit --ignore-scripts >/dev/null 2>"$d/install.err" ); then
    echo "  INSTALL-FAILED"; printf '%s\tinstall-failed\t-\t-\t-\t-\t-\t%s\n' "$name" "$sha_commit" >> "$SUMMARY"; continue
  fi
  if [ ! -x "$d/$testbin" ]; then
    echo "  NO-TEST-RUNNER ($testbin absent after install)"; printf '%s\tno-test-runner\t-\t-\t-\t-\t-\t%s\n' "$name" "$sha_commit" >> "$SUMMARY"; continue
  fi

  # STATIC: scan the package source → per-fn (S,D) + the full-universe loc index (.candor/report.locs.json,
  # required for sound per-function attribution). --allow-js: these packages are plain JS/mixed.
  if ! node "$ENGINE/scan.mjs" "$d" --allow-js >"$d/scan.out" 2>"$d/scan.err"; then
    echo "  SCAN-FAILED: $(head -1 "$d/scan.err")"; printf '%s\tscan-failed\t-\t-\t-\t-\t-\t%s\n' "$name" "$sha_commit" >> "$SUMMARY"; continue
  fi
  analyzed="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).analyzed.count))}catch{process.stdout.write("?")}' "$d/.candor/report.json")"
  echo "  scanned: analyzed=$analyzed"

  # DYNAMIC: run the package's OWN suite under the preload oracle, one node process. --json → metrics.
  vj="$RESULTS/$name.verify.json"
  timeout "$SUITE_TIMEOUT" node "$ENGINE/verify.mjs" "$d" \
    --run "cd $(printf %q "$d") && node --experimental-vm-modules $testbin $testargs" \
    --scope "$SCOPE" --json >"$vj" 2>"$d/verify.err"
  vexit=$?
  if [ $vexit -eq 124 ]; then
    echo "  SUITE-TIMEOUT (${SUITE_TIMEOUT}s)"; printf '%s\ttimeout\t%s\t-\t-\t-\t-\t%s\n' "$name" "$analyzed" "$sha_commit" >> "$SUMMARY"; continue
  fi
  if [ ! -s "$vj" ] || ! node -e 'require(process.argv[1])' "$vj" 2>/dev/null; then
    echo "  VERIFY-NO-JSON (exit $vexit): $(tail -1 "$d/verify.err")"; printf '%s\tverify-failed\t%s\t-\t-\t-\t-\t%s\n' "$name" "$analyzed" "$sha_commit" >> "$SUMMARY"; continue
  fi

  # Extract the disposition + counts and PRINT any violation prominently.
  node -e '
    const j = require(process.argv[1]); const m = j.metrics || {};
    const checked = m.executedFunctionsChecked ?? 0, sc = m.soundCompleteOk ?? 0;
    const disc = m.disclosedPartial ?? 0, viol = m.cardinalSinViolations ?? 0;
    let disp;
    if (viol > 0) disp = "VIOLATION";
    else if (checked === 0) disp = "no-in-scope-effect";
    else if (m.attributionComplete === false) disp = (sc > 0 ? "disclosed-partial(attr-incomplete)" : "vacuous(attr-incomplete)");
    else if (sc === 0) disp = "vacuous-all-disclosed";
    else disp = "sound-complete";
    process.stderr.write(`  checked=${checked} sound-complete=${sc} disclosed=${disc} violations=${viol} attrComplete=${m.attributionComplete} unattributed=${m.unattributedSites ?? "-"}\n`);
    if (m.attributionNote) process.stderr.write(`  attr-note: ${m.attributionNote}\n`);
    for (const v of (j.violations||[])) process.stderr.write(`  ✘ VIOLATION ${v.fn}: ran {${v.observed.join(",")}} but candor declared complete {${(v.inferred.join(",")||"pure")}} → escaped {${v.escaped.join(",")}}\n`);
    require("fs").appendFileSync(process.argv[2],
      [process.argv[3], disp, process.argv[4], checked, sc, disc, viol, process.argv[5]].join("\t")+"\n");
  ' "$vj" "$SUMMARY" "$name" "$analyzed" "$sha_commit"
done

echo; echo "======================= FROZEN PER-PACKAGE DISPOSITION ======================="
column -t -s "$(printf '\t')" "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
echo
awk -F'\t' 'NR>1{n++; if($4 ~ /^[0-9]+$/)ck+=$4; if($5 ~ /^[0-9]+$/)sc+=$5; if($7 ~ /^[0-9]+$/)vi+=$7}
  END{printf "packages: %d   checked(total): %d   sound-complete(total): %d   violations(total): %d\n", n, ck, sc, vi}' "$SUMMARY"
echo "results: $SUMMARY  (+ per-package <name>.verify.json)"
