// AUDIT-ONLY runner. Mirrors services/api/vitest.integration.config.ts (the
// Point-7 bootstrap preload that scrubs credentials and guards outbound
// network, the safe-environment setup file, reconciler/billing timers off)
// but includes only the Operations audit cases under audit-operations/harness.
//
// Run from services/api:
//   TEST_DATABASE_URL=postgresql://pv:pv@127.0.0.1:55471/opsaudit_test \
//   RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1 \
//   P7_TEST_REDIS_URL=redis://127.0.0.1:56471 \
//   npx vitest run --config ../../audit-operations/harness/vitest.opsaudit.config.mjs
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const API = resolve(REPO, "services", "api");
const BOOT = pathToFileURL(resolve(API, "test", "setup", "test-bootstrap.mjs")).href;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${BOOT}`].filter(Boolean).join(" ");
const RUN = process.env.OPSAUDIT_RUN_ID ?? randomUUID();
const TMP = resolve(REPO, "audit-operations", ".tmp");

export default {
  root: API,
  test: {
    globals: true,
    environment: "node",
    dir: HERE,
    setupFiles: [resolve(API, "test", "setup", "safe-environment.ts")],
    include: ["**/*.opsaudit.test.ts"],
    hookTimeout: 900_000,
    testTimeout: 300_000,
    fileParallelism: false,
    env: {
      RUN_LIVE_INTEGRATION: "1",
      OPSAUDIT_RUN_ID: RUN,
      POINT5_RUN_ID: RUN,
      POINT7_RUN_ID: RUN,
      P7_NETWORK_LEDGER: `${TMP}/net.${RUN}.jsonl`,
      P7_CANARY_LEDGER: `${TMP}/canary.${RUN}.jsonl`,
      P7_PHASE: "product",
      P7_PROCESS: "vitest-integration",
      EMAIL_RECORDER_FILE: `${TMP}/emails.jsonl`,
      OPERATIONS_RECONCILER_ENABLED: "false",
      BILLING_ADDON_RETRY_ENABLED: "false",
      BILLING_RECONCILER_ENABLED: "false",
      AUTH_JWT_SECRET: "opsaudit-only-secret-0123456789abcdef",
    },
  },
};
