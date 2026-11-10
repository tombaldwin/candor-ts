// SOURCE LINT: no environment access outside `env.mjs` (SPEC §3.4 ⟨0.42⟩, SOUNDNESS R1634).
//
// §3.4: "the registration is the read" — an engine that reads a result-moving variable by any route other than the
// one function that records it has a silent switch. This lint is the gate that keeps that true, and it is an AST
// walk, not a grep: a regex over `process.env` matches the comments and strings in scan.mjs that DISCUSS the
// environment (the engine analyses `process.env` in other people's code, and says so in ~200 lines of prose), and a
// check that fires on prose is a check somebody learns to ignore. Calibrated by `test-env-lint.mjs`, which seeds
// every spelling below and a real shipped file with one read appended, and requires each to fail.
//
// WHAT COUNTS (the process object, however it is reached):
//   · `process.env` / `process?.env` / `process["env"]` / `process[<dynamic>]`      property or element access
//   · `globalThis.process.env`, `global.process.env`, `(process as any).env`        the same object off the global
//   · `const p = process` / `foo(process)` / `return process`                       the object ESCAPES: `p.env` follows
//   · `const { env } = process` / `({ env }) => …` over process                      destructuring
//   · `import { env } from "node:process"` / `import p from "node:process"`         the module binding
//   · `require("process")` / `require("node:process")`                              CJS spelling
// `process.argv`, `process.exit`, `process.on(…)`, `process.stderr` … are member accesses on the process object and are
// not environment reads, so they stay legal.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENV_MODULE = "env.mjs";

// Files that are NOT shipped engine code: test harnesses (they spawn the engine with a built environment and read the
// parent's), the fuzz/probe drivers, and this lint. A DENYLIST on purpose: a new root `.mjs` is linted until someone
// names it here, so the failure direction of forgetting is a red test, not an unchecked file.
export const HARNESS = /^(test[^/]*\.mjs|fuzz\.mjs|fabrication_probe\.mjs|scratch\.mjs|env-lint\.mjs|eslint\.config\.mjs)$/;

const isProcessName = (n) => n === "process";
const unwrap = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
              || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
  return e;
};
/** Is `e` an expression whose VALUE is the process object? */
function isProcessExpr(e, aliases) {
  e = unwrap(e);
  if (!e) return false;
  if (ts.isIdentifier(e)) return isProcessName(e.text) || aliases.has(e.text);
  if (ts.isPropertyAccessExpression(e)) {
    const o = unwrap(e.expression);
    return e.name.text === "process" && ts.isIdentifier(o) && (o.text === "globalThis" || o.text === "global" || o.text === "self" || o.text === "window");
  }
  if (ts.isElementAccessExpression(e)) {
    const o = unwrap(e.expression), k = e.argumentExpression;
    return ts.isIdentifier(o) && (o.text === "globalThis" || o.text === "global") && ts.isStringLiteralLike(k) && k.text === "process";
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "require"
      && e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0])
      && (e.arguments[0].text === "process" || e.arguments[0].text === "node:process")) return true;
  return false;
}

/** @returns {{line:number, text:string, why:string}[]} every environment access in `text` */
export function findEnvAccess(text, file = "x.mjs") {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const aliases = new Set();   // local names bound to the process object (a first pass, so use-before-bind still counts)
  const at = (n, why) => out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).split("\n")[0].slice(0, 100), why });
  // pass 1: aliases and module bindings
  (function pre(n) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)
        && (n.moduleSpecifier.text === "process" || n.moduleSpecifier.text === "node:process")) {
      const ic = n.importClause;
      if (ic?.name) aliases.add(ic.name.text);
      const nb = ic?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) aliases.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const s of nb.elements) {
        if ((s.propertyName ?? s.name).text === "env") at(s, "imports `env` from the process module");
        if ((s.propertyName ?? s.name).text === "default") aliases.add(s.name.text);
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isProcessExpr(n.initializer, aliases))
      aliases.add(n.name.text);
    ts.forEachChild(n, pre);
  })(sf);
  // pass 2: accesses
  (function walk(n) {
    if (ts.isPropertyAccessExpression(n) && isProcessExpr(n.expression, aliases) && n.name.text === "env")
      at(n, "reads `process.env`");
    else if (ts.isElementAccessExpression(n) && isProcessExpr(n.expression, aliases)) {
      const k = n.argumentExpression;
      if (!ts.isStringLiteralLike(k)) at(n, "indexes the process object with a computed key (could be \"env\")");
      else if (k.text === "env") at(n, "reads `process[\"env\"]`");
    } else if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBinaryExpression(n)) ) {
      // destructuring `{ env } = process`
      const pat = ts.isBinaryExpression(n) ? (ts.isObjectLiteralExpression(n.left) ? n.left : null) : (n.name && ts.isObjectBindingPattern(n.name) ? n.name : null);
      const init = ts.isBinaryExpression(n) ? n.right : n.initializer;
      if (pat && init && isProcessExpr(init, aliases)) {
        const names = ts.isObjectLiteralExpression(pat)
          ? pat.properties.map((p) => (p.name?.getText(sf) ?? ""))
          : pat.elements.map((el) => (el.propertyName ?? el.name).getText(sf));
        const spread = ts.isObjectLiteralExpression(pat) ? pat.properties.some(ts.isSpreadAssignment) : pat.elements.some((el) => el.dotDotDotToken);
        if (names.includes("env") || spread) at(n, "destructures `env` (or the rest) off the process object");
      }
    } else if (ts.isIdentifier(n) && (isProcessName(n.text) || aliases.has(n.text))) {
      // a bare `process` that is not the receiver of a member access escapes: `const p = process`, `f(process)`
      const p = n.parent;
      const receiver = (ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n);
      const declName = (ts.isVariableDeclaration(p) && p.name === n) || (ts.isParameter(p) && p.name === n)
        || (ts.isImportClause(p) && p.name === n) || (ts.isImportSpecifier(p) && p.name === n) || ts.isNamespaceImport(p)
        || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.name === n)
        || (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isTypeOfExpression(p))
        || (ts.isShorthandPropertyAssignment(p));
      const initOfAlias = ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name);
      if (!receiver && !declName && !initOfAlias && !ts.isImportDeclaration(p)) {
        // a call like `fn(process)` or `return process` or `x = process` hands the object (and its env) to code we do not see
        const destructured = (ts.isVariableDeclaration(p) && p.initializer === n) || (ts.isBinaryExpression(p) && p.right === n);
        if (!destructured) at(n, "lets the process object escape (its `.env` is then unreachable to this lint)");
      }
    }
    ts.forEachChild(n, walk);
  })(sf);
  return out;
}

/** The shipped files: every root-level `.mjs` except `env.mjs` itself and the harnesses. */
export function shippedFiles(dir = HERE) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== ENV_MODULE && !HARNESS.test(f)).sort();
}

export function lintTree(dir = HERE) {
  const bad = [];
  for (const f of shippedFiles(dir))
    for (const h of findEnvAccess(fs.readFileSync(path.join(dir, f), "utf8"), f)) bad.push({ file: f, ...h });
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = lintTree();
  for (const b of bad) console.error(`${b.file}:${b.line}: ${b.why}: ${b.text}`);
  if (bad.length) { console.error(`env-lint: ${bad.length} environment access(es) outside ${ENV_MODULE} — route them through envSwitch/envTrace/envOperator/childEnv`); process.exit(1); }
  console.log(`env-lint: OK — ${shippedFiles().length} file(s), no environment access outside ${ENV_MODULE}`);
}
