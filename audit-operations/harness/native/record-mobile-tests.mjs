// AUDIT-ONLY: run every Operations-related mobile test file with the package's
// own runner (node --test) and record the result as native evidence.
//   node audit-operations/harness/native/record-mobile-tests.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MOBILE = resolve(REPO, "apps", "mobile");
const FILES = [
  "test/ops-console.test.mjs", "test/ops-parity.render.test.mjs", "test/ops-remediation-reason.test.mjs",
  "test/operations.test.mjs", "test/operations-batch-analysis.render.test.mjs", "test/operations-quotas.render.test.mjs",
  "test/navigation-model.test.mjs", "test/shell-gates.test.mjs", "test/shell-navigation.render.test.mjs",
  "test/product-manifest-coverage.test.mjs", "test/home-operations.test.mjs",
];
const SRC = ["apps/mobile/src/product/ops-console.ts", "apps/mobile/app/(stack)/operations/index.tsx", "apps/mobile/src/ui/ops-surfaces.tsx", "apps/mobile/src/product/navigation.ts"];
const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...FILES], { cwd: MOBILE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const tap = `${r.stdout}\n${r.stderr}`;
const num = (k) => Number((tap.match(new RegExp(`^# ${k} (\\d+)`, "m")) ?? [])[1] ?? NaN);
const failures = [...tap.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const sha = (rel) => createHash("sha256").update(readFileSync(resolve(REPO, rel))).digest("hex");
const out = resolve(REPO, "audit-operations", "evidence", "native");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "PR-N01-mobile-ops-tests.json"), JSON.stringify({
  proofId: "PR-N01-mobile-ops-tests",
  title: "Native Operations logic: package test runner (node --test) over every Operations-related mobile test file",
  proofType: "SOURCE_AND_TEST_PROVEN",
  findingIds: [],
  command: `cd apps/mobile && node --test ${FILES.join(" ")}`,
  exitCode: r.status,
  observed: { tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped"), failures },
  limits: "Pure TypeScript/React logic under node. No device, simulator or emulator executed. JVM (Kotlin) and Swift native-module tests not run on this host (no Java runtime / Android SDK; no iOS toolchain on Windows); those modules do not touch Operations.",
  sourceFingerprints: Object.fromEntries([...SRC, ...FILES.map((f) => `apps/mobile/${f}`)].sort().map((f) => [f, sha(f)])),
}, null, 2) + "\n");
console.log(JSON.stringify({ exit: r.status, tests: num("tests"), pass: num("pass"), fail: num("fail") }));
