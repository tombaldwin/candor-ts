// test-pack.mjs — the PUBLISHED package must load: every relative import of a file the tarball ships must
// itself be in the tarball.
//
// WHY THIS EXISTS. candor-ts 0.42.0 reached npm without `env.mjs` (added for SPEC ⟨0.42⟩ result-moving
// switches, imported by scan.mjs, query.mjs, gate-core.mjs and eleven more), because package.json's `files`
// list was not told about it. Every test ran from the git tree, where the file exists, so the whole battery,
// CI and publish.yml were green while `npx candor-ts@0.42.0` died on start with ERR_MODULE_NOT_FOUND. The
// IDE builds, which bundle the published package, were the first thing to notice.
//
// So this reads the list `npm pack` would publish (not the `files` array, which is the claim) and follows
// every static and dynamic relative import from each shipped module. It does not run the package; the
// release ladder's `npx candor-ts@<ver>` smoke does that against the real registry.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function shippedFiles(cwd = here) {
  // --ignore-scripts: prepack would copy package-lock.json to npm-shrinkwrap.json in the working tree.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8' });
  return new Set(JSON.parse(out)[0].files.map((f) => normalize(f.path)));
}

// Node's ESM loader needs the extension on a relative specifier, so a real import always carries one; requiring
// it keeps out the import-SHAPED strings scan.mjs analyses (`'./impl'`, `'../vendor/shim'`), which are data.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+\.(?:mjs|js|json))\1/g;

export function missingImports(files, read = (p) => readFileSync(join(here, p), 'utf8')) {
  const missing = [];
  for (const f of files) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    for (const m of read(f).matchAll(IMPORT)) {
      const target = normalize(join(dirname(f), m[2]));
      if (!files.has(target)) missing.push(`${f} imports ${m[2]}, which the tarball does not ship`);
    }
  }
  return missing;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  // Calibration first: the checker must be able to fail. Drop a file a shipped module imports and require a
  // finding; a checker that finds nothing on its own seeded hole proves nothing when it finds nothing below.
  const files = shippedFiles();
  if (!files.has('scan.mjs')) { console.error('test-pack: scan.mjs is not shipped at all'); process.exit(1); }
  const seeded = new Set(files); seeded.delete('spec-version.mjs');
  if (missingImports(seeded).length === 0) {
    console.error('test-pack: CALIBRATION FAILED — removing spec-version.mjs from the list produced no finding');
    process.exit(1);
  }
  const missing = missingImports(files);
  if (missing.length) {
    console.error(`test-pack: FAILED — the published package would not load:\n  ${missing.join('\n  ')}\n` +
      '  Add each file to package.json "files".');
    process.exit(1);
  }
  console.log(`test-pack: OK — ${files.size} shipped file(s); every relative import resolves inside the tarball (calibrated: a seeded hole is found)`);
}
