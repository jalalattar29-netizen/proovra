# Remediation lane brief (read fully before touching code)

Repository: `D:/pv-ucc` — git worktree on branch `fix/universal-evidence-capture-closure`
(base origin/main `47034f45`, audit commits cherry-picked). Other lanes edit OTHER files in
this same worktree at the same time. The lead integrates and commits.

Canonical finding rows: `docs/evidence/audits/universal-evidence-capture/universal-capture-findings.json`
(each has rootCause, locations, reproduction, observed, expected, remediation, requiredTests).
Area evidence: `docs/evidence/audits/universal-evidence-capture/sources/*.json`.
Runtime evidence: `docs/evidence/audits/universal-evidence-capture/runtime/`.

## Hard rules
1. Edit ONLY files inside your lane's ownership list. If a fix needs a file you do not own,
   do not edit it — record it in your report under `crossLaneRequests` with the exact change.
2. NO database migrations and NO edits to `services/api/prisma/**`. If a finding truly needs a
   schema change, finish everything else, then record it under `migrationRequests` with the exact
   SQL + Prisma model diff. The lead writes and registers migrations.
3. Do NOT run `pnpm audit:architecture`, do not edit `audit-output/**`, `docs/architecture/**`
   generated files, capability-map manifests, route-dispositions, CONTINUATION-CHECKPOINT. The lead
   regenerates governance artifacts once at the end. If a governance/source-pin test fails ONLY
   because a count, line anchor or byte pin moved, note it under `governanceFollowUps`; do not edit it.
4. NEVER read any `.env` file. There are none in this worktree; keep it that way. Never contact
   any non-loopback host. No production credentials exist or are needed.
5. Do not spawn sub-agents. Do not start long-lived servers. Every command you run must terminate
   on its own (use `timeout`).
6. Do not git commit, stash, reset, checkout or rebase. The lead commits. Never `git stash`.
7. Do not weaken assertions, add skips/retries/longer timeouts to hide failures, or change an
   expected value to match broken behaviour. Do not build a parallel replacement system: fix the
   canonical authority. Delete dead code only after proving it has no consumer.
8. For EVERY finding in your lane:
   a. Re-read its row. Trace the real production path in the current tree.
   b. RED: write the smallest regression test that fails on the current code for the stated
      reason; run it; keep the failing output (first lines) for the report. For native Swift/Kotlin
      code that cannot compile here, the red proof is a contract/fixture test in TS/node that
      reproduces the defective contract (e.g. the exact Swift-produced JSON shape), or a
      source-structure test that reads the native file ONLY when no executable proof is possible —
      say which.
   c. Fix the root cause at the canonical authority, on both server and client if the contract is
      shared.
   d. GREEN: rerun the same test (and neighbouring suites) — must pass.
9. Keep the product honest: no copy may claim more than the code proves.

## Environment (all loopback, disposable)
- PostgreSQL 16: `postgresql://pv:pv@127.0.0.1:58811/proovra_ucc_<lane>_test` (already migrated;
  your lane letter is given in your task). Redis: `redis://127.0.0.1:58812/<lane-index>`.
  MinIO: `127.0.0.1:59711`, user `point7-local-minio`, secret `point7-local-minio-secret`,
  buckets `point7-local-bucket` and `uca-olc-locked` (Object Lock COMPLIANCE).
- API integration run (from services/api):
  `TEST_DATABASE_URL=<your db> RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1 P7_TEST_REDIS_URL=<your redis> P7_HOST_S3_PORT=59711 AUTH_JWT_SECRET=ucc-local-stub-secret-0123456789abcdef PROOVRA_ENV_BOOTSTRAPPED=1 timeout 1200 npx vitest run --config vitest.integration.config.ts test/<file>`
  Confirm the file reports executed (✓) tests, not skipped.
- API unit: `timeout 900 npx vitest run test/<file>` in services/api. Worker: `timeout 900 npx vitest run test/<file>`
  in services/worker (DB suites need TEST_DATABASE_URL + P7_TEST_REDIS_URL + P7_HOST_S3_PORT).
- Shared packages: after editing `packages/shared*/src`, rebuild that package's dist before other
  workspaces see it: `pnpm --filter @proovra/shared build` (or shared-runtime / shared-evidence-presentation).
  Rebuilding dist is allowed (dist is gitignored). If you change shared, rebuild before running API/worker tests.
- Typecheck: `pnpm --filter <pkg> typecheck` (API: `pnpm --filter proovra-api typecheck`, needs ~6 GB heap, set).
  Other lanes may have transient breakage; only fix errors in YOUR files.
- Web render tests: `npx vitest run --config vitest.render.config.ts <file>` in apps/web. Mobile: `node --test <file>` in apps/mobile.
- Extension: `pnpm --filter @proovra/extension test`, `lint`, `build` (build defaults to localhost:4000).

## Report (required, the lead builds the ledger from it)
Write `docs/evidence/audits/universal-evidence-capture/remediation/lanes/<LANE>.json`:
```json
{
  "lane": "<LANE>",
  "findings": {
    "UC-XXX-NNN": {
      "decision": "what was changed and why, at which authority (2-5 sentences)",
      "red": { "test": "path::name", "command": "...", "observed": "first failing assertion text" },
      "green": { "tests": ["path::name", "..."], "command": "...", "result": "N passed" },
      "filesChanged": ["..."],
      "proofKind": "runtime | integration-real-db | unit | contract-fixture | source-structure",
      "impacts": { "ui": "...|none", "api": "...|none", "worker": "...|none", "mobile": "...|none", "extension": "...|none", "security": "...|none", "deployment": "none | web redeploy | api+worker redeploy | native build | store submission" },
      "migration": "none | see migrationRequests",
      "externalProofRemaining": "none | exact unavailable proof (device/store/sandbox) — only if the code is complete",
      "status": "FIXED | NEEDS_MIGRATION | NEEDS_CROSS_LANE | BLOCKED_EXTERNAL_PROOF"
    }
  },
  "crossLaneRequests": [ { "finding": "...", "file": "...", "change": "..." } ],
  "migrationRequests": [ { "finding": "...", "sql": "...", "prisma": "..." } ],
  "governanceFollowUps": [ "..." ],
  "commandsRun": [ { "command": "...", "exit": 0 } ]
}
```
Every finding assigned to your lane must appear. `BLOCKED_EXTERNAL_PROOF` only when the code is
complete and the ONLY missing proof needs a physical device, store account, Apple/Google signing,
real TSA/OTS/AWS or payment sandbox. Final message: ≤15 lines + the report path.
