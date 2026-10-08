// AUDIT-ONLY proof recorder. Every executed case writes ONE JSON record to
// audit-operations/evidence/runtime/<proofId>.json carrying the observed facts
// and the sha256 of every Product file the claim depends on, so the generator
// can refuse a proof whose source has since changed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..");
export const API = resolve(REPO, "services", "api");
export const apiUrl = (rel: string) => "file:///" + resolve(API, rel).replace(/\\/g, "/");
export const repoUrl = (rel: string) => "file:///" + resolve(REPO, rel).replace(/\\/g, "/");
const OUT = resolve(REPO, "audit-operations", "evidence", "runtime");

export function sha256File(rel: string): string {
  return createHash("sha256").update(readFileSync(resolve(REPO, rel))).digest("hex");
}

export type ProofType =
  | "RUNTIME_PROVEN"
  | "BROWSER_PROVEN"
  | "REAL_DB_PROVEN"
  | "NATIVE_RUNTIME_PROVEN";

export function recordProof(p: {
  proofId: string;
  title: string;
  proofType: ProofType;
  findingIds: string[];
  sources: string[]; // repo-relative Product files the claim depends on
  persona?: string;
  plan?: string;
  workspaceType?: string;
  expected: string;
  observed: unknown;
  outcome: "DEFECT_OBSERVED" | "BEHAVIOUR_CORRECT" | "INFORMATIONAL";
}): void {
  mkdirSync(OUT, { recursive: true });
  const record = {
    proofId: p.proofId,
    title: p.title,
    proofType: p.proofType,
    findingIds: p.findingIds,
    persona: p.persona ?? null,
    plan: p.plan ?? null,
    workspaceType: p.workspaceType ?? null,
    expected: p.expected,
    observed: p.observed,
    outcome: p.outcome,
    sourceFingerprints: Object.fromEntries(p.sources.sort().map((s) => [s, sha256File(s)])),
    harnessFile: (expect.getState().testPath ?? "").replace(/\\/g, "/").replace(/^.*audit-operations\//, "audit-operations/"),
    command:
      "cd services/api && TEST_DATABASE_URL=postgresql://pv:pv@127.0.0.1:55471/opsaudit_test RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1 P7_TEST_REDIS_URL=redis://127.0.0.1:56471 npx vitest run --config ../../audit-operations/harness/vitest.opsaudit.config.mjs",
  };
  writeFileSync(resolve(OUT, `${p.proofId}.json`), JSON.stringify(record, null, 2) + "\n");
}

/** Normalise volatile values (uuids, timestamps) so evidence diffs stay readable. */
export function scrub<T>(v: T): T {
  return JSON.parse(
    JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>"),
  );
}
