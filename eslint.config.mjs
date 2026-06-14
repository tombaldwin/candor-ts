// The lint gate for candor-ts (run via `npm run lint`, enforced in CI). The code is deliberately
// UNTYPED .mjs — Tom's call — so `tsc --checkJs` is the wrong tool (134 false "errors" on scan.mjs
// alone, fighting the design). ESLint's recommended ruleset is the right altitude: it catches the
// real JS footguns (no-fallthrough, no-undef, no-unused-vars, no-unreachable, useless-escape) without
// asking for type annotations the project intentionally omits.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Empty `catch {}` is a DELIBERATE best-effort swallow throughout the scanner (a symbol the TS
      // checker can't resolve, an optional read that may fail) — the analysis degrades, it does not
      // crash. That intent is the pattern, not a bug, so allow the empty catch specifically.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
