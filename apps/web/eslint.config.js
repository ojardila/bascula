import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
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
);
