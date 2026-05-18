/**
 * Web app ESLint config.
 *
 * Extends the root TypeScript config and registers the React Hooks
 * plugin so:
 *   - `react-hooks/exhaustive-deps` is a defined rule (next build runs
 *     ESLint and was failing because the rule was referenced by inline
 *     disable comments but not registered).
 *   - `react-hooks/rules-of-hooks` enforces hook usage correctness.
 *
 * We register the plugin manually and enable only the two canonical
 * rules. We DO NOT extend `plugin:react-hooks/recommended` because the
 * v7.x recommended set adds new lint rules (`set-state-in-effect`,
 * `purity`, etc.) that flag a large number of legitimate patterns the
 * existing codebase was authored against. Those rules are out of scope
 * for this build-stabilization pass; if we adopt them later it should
 * be a deliberate refactor, not a build gate.
 *
 * `eslint-plugin-react-hooks` is already declared in
 * apps/web/package.json devDependencies, so this config just wires it
 * up — no new dependency is added.
 */
module.exports = {
  root: false,
  extends: ["../../.eslintrc.cjs"],
  plugins: ["react-hooks"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    // Accept the standard "_-prefix means intentionally unused" convention
    // for function parameters and destructuring rest siblings. Matches
    // the convention already used elsewhere in the repo.
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
  },
};
