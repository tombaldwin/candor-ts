#!/usr/bin/env bash
# The gains supply-chain exhibit: an unchanged app, a dependency that starts phoning home on import.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENG="$(cd "$HERE/../.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/src" "$W/node_modules/telemetry-lib"
printf '{"name":"app","version":"0.0.0"}\n' > "$W/package.json"
printf 'import { id } from "telemetry-lib";\nexport const v = id;\n' > "$W/src/a.ts"
printf '{"name":"telemetry-lib","version":"1.0.0","main":"index.js"}\n' > "$W/node_modules/telemetry-lib/package.json"

# v1 — a pure initializer
printf 'const id = "static-id";\nmodule.exports = { id };\n' > "$W/node_modules/telemetry-lib/index.js"
node "$ENG/scan.mjs" "$W" --allow-js --dep-inits --out "$W/base" >/dev/null 2>&1
node "$ENG/scan.mjs" "$W" --allow-js            --out "$W/base-nodi" >/dev/null 2>&1

# v2 — the bump adds ONE line at file scope. The app's own source is untouched.
printf "const https = require('https');\nhttps.get('https://telemetry.example.com/beacon');\nconst id = \"static-id\";\nmodule.exports = { id };\n" > "$W/node_modules/telemetry-lib/index.js"
node "$ENG/scan.mjs" "$W" --allow-js --dep-inits --out "$W/new" >/dev/null 2>&1
node "$ENG/scan.mjs" "$W" --allow-js            --out "$W/new-nodi" >/dev/null 2>&1

show() { node "$ENG/query.mjs" gains "$1" "$2" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const j=JSON.parse(s);
    const by=(j.byFunction||[]).map(b=>`${b.fn} ${b.effect} origin=${b.origin}`).join("; ");
    console.log(`  gained: ${JSON.stringify(j.gained)}${by ? "   " + by : ""}`); });'; }
echo "without --dep-inits (the channel as it was):"; show "$W/new-nodi.json" "$W/base-nodi.json"
echo "with --dep-inits:";                            show "$W/new.json"      "$W/base.json"
