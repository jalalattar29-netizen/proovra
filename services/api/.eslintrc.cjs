/**
 * API ESLint config — the root rules, with two narrowly-scoped exceptions for
 * the STATIC-ANALYSIS suites and their ambient declarations.
 *
 * `scripts/capability-authority/*.mjs` is the canonical audit engine. It is
 * plain `.mjs` on purpose: it runs under bare Node during generation and in CI,
 * with no build step between an edit and a regenerated map. The adversarial
 * suites that hold it honest therefore drive UNTYPED modules and hand them
 * hand-built TypeScript AST fixtures, and the compiler cannot know the shape of
 * either.
 *
 * Two rules fail on that, and only there:
 *
 *   - `no-explicit-any` — the fixtures ARE `any`: a hand-written type for a
 *     `ts.Node` fragment or an analyzer return value would be a second
 *     description of the analyzer, free to drift from the first. That is the
 *     failure mode `test/capability-authority-modules.d.ts` already documents.
 *   - `no-require-imports` — `typescript` is loaded with `createRequire` in
 *     these suites because the engine loads it the same way, and the point of a
 *     suite that verifies the engine is to run the engine's own code path.
 *
 * The scope is deliberately three globs, not "tests". Everything the service
 * ships, and every behavioural test, is held to the root rules unchanged — a
 * relaxation wide enough to cover product code would be the kind of allowlist
 * that quietly turns a gate off.
 */
module.exports = {
  root: false,
  extends: ["../../.eslintrc.cjs"],
  overrides: [
    {
      files: [
        "test/capability-authority-modules.d.ts",
        "test/phase-12-capability-analyzer-adversarial.test.ts",
        "test/phase-12a-reconciliation-gate.test.ts",
        "test/phase-13-mutation-closure-adversarial.test.ts",
        "test/phase-13-tenant-binding-adversarial.test.ts",
        "test/phase-13-closure-evaluator-adversarial.test.ts",
      ],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-require-imports": "off",
      },
    },
  ],
};
