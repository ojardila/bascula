import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `src/api/schema.ts` is generated from `services/api/openapi.yaml` by
  // `npm run types:api` and is never edited. Linting it would mean either
  // hand-editing a generated file to satisfy a rule, or carrying a
  // permanently-red lint — both worse than not looking.
  {
    ignores: [
      "dist",
      "public/mockServiceWorker.js",
      "node_modules",
      "src/api/schema.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react-hooks 7 folds React Compiler diagnostics into
      // "recommended". This app does not run the compiler, and the patterns
      // these flag (reading a ref while rendering, resetting state in an
      // effect) work today; rewriting ~40 sites in screens that move money is
      // a behaviour change with no user-visible gain. Warnings, so they stay
      // visible and can be paid down one screen at a time.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // eslint-plugin-security: injection-shaped patterns (non-literal RegExp,
  // eval-like calls, timing-unsafe comparisons, ...). Warnings, so `npm run
  // lint` stays the gate it was; SonarQube imports them as external issues
  // (eslint-report.json, .github/workflows/sonarqube.yml) and its quality gate
  // counts new ones. Off, after review on the whole console:
  //   detect-object-injection        flags every obj[key]; TypeScript types them.
  //   detect-unsafe-regex            flagged only linear patterns (digit
  //                                  grouping, slugs); SonarQube's own ReDoS
  //                                  rule (S5852) does the real analysis.
  //   detect-possible-timing-attacks a browser comparing what the user typed
  //                                  twice has no timing oracle to protect.
  // Tests build regexps and read fixtures on purpose, so they are left out.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "src/test/**", "e2e/**"],
    plugins: { security },
    rules: {
      ...Object.fromEntries(
        Object.keys(security.configs.recommended.rules).map((r) => [r, "warn"]),
      ),
      "security/detect-object-injection": "off",
      "security/detect-unsafe-regex": "off",
      "security/detect-possible-timing-attacks": "off",
    },
  },
);
