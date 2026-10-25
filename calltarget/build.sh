#!/bin/bash
# Build the generated matrix: compile the dependency packages, install them flat (npm-style copy) and pnpm-style
# (nested + symlink) into their consumers, compile the consumers. A handful of deliberately loose cells raise tsc
# errors; `noEmitOnError: false` keeps their output, and ground truth checks every cell executes as designed.
# Usage: build.sh <work-dir>   (TSC and TYPES default to this repo's node_modules)
set -u
WORK=$1
HERE=$(cd "$(dirname "$0")" && pwd)
M=$WORK/m
TSC=${CT_TSC:-$HERE/../node_modules/.bin/tsc}
TYPES=${CT_TYPES:-$HERE/../node_modules/@types}
for d in "$M"/dep/*; do
  [ -d "$d" ] || continue
  mkdir -p "$d/node_modules"; ln -sfn "$TYPES" "$d/node_modules/@types"
  "$TSC" -p "$d" > "$d.tsc.log" 2>&1; echo "dep $(basename "$d") tsc-exit=$? errors=$(grep -c 'error TS' "$d.tsc.log")"
done
install_flat() {  # consumer dep
  local c=$1 dep=$2
  mkdir -p "$c/node_modules/$dep"; ln -sfn "$TYPES" "$c/node_modules/@types"
  cp "$M/dep/$dep/package.json" "$c/node_modules/$dep/"; rm -rf "$c/node_modules/$dep/build"; cp -R "$M/dep/$dep/build" "$c/node_modules/$dep/build"
}
install_pnpm() {
  local c=$1 dep=$2
  local real="$c/node_modules/.pnpm/$dep@1.0.0/node_modules/$dep"
  mkdir -p "$real"; ln -sfn "$TYPES" "$c/node_modules/@types"
  cp "$M/dep/$dep/package.json" "$real/"; rm -rf "$real/build"; cp -R "$M/dep/$dep/build" "$real/build"
  ln -sfn ".pnpm/$dep@1.0.0/node_modules/$dep" "$c/node_modules/$dep"
}
for lang in ts js; do
  for L in same mod dimp dsite; do
    c=$M/src-$lang-$L; [ -d "$c" ] || continue
    mkdir -p "$c/node_modules"; ln -sfn "$TYPES" "$c/node_modules/@types"
    if [ "$L" = dimp ] || [ "$L" = dsite ]; then
      dep=dep$L$lang
      install_flat "$c" "$dep"
      p=$M/src-$lang-$L-pnpm; rm -rf "$p"; mkdir -p "$p"; cp -R "$c/src" "$c/package.json" "$c/tsconfig.json" "$p/"
      install_pnpm "$p" "$dep"
    fi
  done
done
for c in "$M"/src-*; do
  [ -d "$c" ] || continue
  "$TSC" -p "$c" > "$c.tsc.log" 2>&1; echo "app $(basename "$c") tsc-exit=$? errors=$(grep -c 'error TS' "$c.tsc.log")"
done
echo "=== build done ==="
