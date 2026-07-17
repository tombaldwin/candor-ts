// candor verify — an ESM customization loader (registered by verify-preload.mjs via module.register).
//
// Why this exists: an ESM DESTRUCTURED named import of a builtin — `import { readFileSync } from "node:fs"` —
// SNAPSHOTS the original binding at import time, so the preload's in-place patch (`fs.readFileSync = wrapped`)
// is invisible to it (the app keeps calling the un-wrapped original → the oracle would silently under-observe,
// the one failure an honesty tool must not make). This loader redirects each wrapped-builtin import to a tiny
// wrapper module that RE-EXPORTS the builtin's CURRENT (already-patched) values — breaking the snapshot. It
// contains NO recording logic: the preload's method patch still does the emit; this only defeats the snapshot,
// so an ESM-named call goes through the same single wrapped function as a CJS / namespace call (no double-count).

const WRAPPED = new Set([
  "fs", "fs/promises", "net", "http", "https", "http2", "dns", "dns/promises", "child_process", "dgram",
]);
const WRAP = "candorverify-wrap:";   // the redirected wrapper module
const ORIG = "candorverify-orig:";   // the bypass back to the REAL builtin (resolve handles it without redirecting)

export async function resolve(specifier, context, next) {
  // the wrapper's own `import * as __o from "candorverify-orig:<base>"` → the REAL builtin, no redirect.
  if (specifier.startsWith(ORIG)) return next("node:" + specifier.slice(ORIG.length), context);
  // candor's OWN verify modules import node:fs etc. — never redirect those, or verify-emit (imported by the
  // generated wrapper) would recurse into a wrapper that imports verify-emit → a load-time deadlock.
  const parent = context.parentURL || "";
  if (/\/verify-(emit|preload|loader)\.mjs$/.test(parent)) return next(specifier, context);
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (WRAPPED.has(bare)) return { url: WRAP + bare, shortCircuit: true };
  return next(specifier, context);
}

// The verify-emit module (shared emit + effectOf), imported by the GENERATED wrapper source in the app thread.
const EMIT_URL = new URL("./verify-emit.mjs", import.meta.url).href;

export async function load(url, context, next) {
  if (!url.startsWith(WRAP)) return next(url, context);
  const base = url.slice(WRAP.length);
  // Enumerate the builtin's export names via the ORIG bypass (resolve maps it straight to node:<base>, so
  // this does NOT re-enter the WRAPPED redirect → no recursion). Then generate a wrapper that RE-EXPORTS every
  // name, WRAPPING the effectful named exports with emit — because node:fs's named `statSync` is a distinct
  // binding from the default object's `statSync` the preload patched, so re-export alone would miss it.
  const { effectOf } = await import(EMIT_URL);
  const real = await import(ORIG + base);
  const names = Object.keys(real).filter((n) => n !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
  const B = JSON.stringify(base);
  let src = `import * as __o from ${JSON.stringify(ORIG + base)};\n`;
  // Route through the SAME re-entrancy-guarded helpers as the preload, so a named-export call's internal
  // wrapped calls don't fabricate an escape (and a Net destination is classified → Net/Llm/Db).
  src += `import { traced as __t, tracedNet as __tn } from ${JSON.stringify(EMIT_URL)};\n`;
  src += "export default __o.default ?? __o;\n";
  for (const n of names) {
    const eff = effectOf(base, n);
    const N = JSON.stringify(n);
    if (eff === "Net" && typeof real[n] === "function") {
      src += `const __f_${n} = __o[${N}];\n`;
      src += `export const ${n} = function (...a) { return __tn(${B}, ${N}, this, __f_${n}, a); };\n`;
    } else if (eff && typeof real[n] === "function") {
      src += `const __f_${n} = __o[${N}];\n`;
      src += `export const ${n} = function (...a) { return __t(${JSON.stringify(eff)}, this, __f_${n}, a); };\n`;
    } else {
      src += `export const ${n} = __o[${N}];\n`;
    }
  }
  return { format: "module", source: src, shortCircuit: true };
}
