/**
 * Platform Control Center P1 — Evidence Pipeline Health backend contract.
 *
 * Source-contract tests (the dominant convention for feature slices in
 * this repo — no DB, no Fastify). They pin the honesty invariants that
 * make this console trustworthy:
 *
 *   1. requirePlatformAdmin gates the endpoint (non-platform denied).
 *   2. Metrics are REAL DB counts / groupBy — not fabricated literals.
 *   3. Absent signals return `null` (honest "Not measured"), never a
 *      fake "healthy" / hard-coded 0.
 *   4. No evidence CONTENTS are exposed (no bytes, storage keys,
 *      signatures, fingerprints, GPS, titles, private notes).
 *   5. Queue numbers REUSE the existing queue-inventory service — this
 *      slice does not open its own Redis connection.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE = readSource(
  "../../../services/api/src/routes/admin-evidence-ops.routes.ts",
);
const SERVICE = readSource(
  "../../../services/api/src/services/operations/evidence-health.service.ts",
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("Phase P1 — evidence-ops route", () => {
  it("gates GET /v1/admin/evidence-health on requirePlatformAdmin", () => {
    expect(ROUTE).toMatch(
      /from\s+"\.\.\/middleware\/require-platform-admin\.js"/,
    );
    expect(ROUTE).toMatch(
      /"\/v1\/admin\/evidence-health"[\s\S]*?preHandler:\s*requirePlatformAdmin/,
    );
  });

  it("is READ-ONLY: only registers a GET, no mutating verbs", () => {
    expect(ROUTE).toMatch(/app\.get\(/);
    expect(ROUTE).not.toMatch(/app\.(post|patch|put|delete)\(/);
  });

  it("delegates aggregation to the evidence-health service (no inline evidence logic)", () => {
    expect(ROUTE).toMatch(/buildEvidenceHealthSnapshot/);
  });
});

describe("Phase P1 — evidence-health service honesty", () => {
  it("reuses the existing queue-inventory service (does NOT open its own Redis)", () => {
    expect(SERVICE).toMatch(
      /from\s+"\.\/queue-inventory\.service\.js"/,
    );
    expect(SERVICE).toMatch(/getQueueInventory/);
    // Must never construct a Redis / BullMQ connection of its own.
    const clean = stripComments(SERVICE);
    expect(clean).not.toMatch(/new\s+IORedis/);
    expect(clean).not.toMatch(/new\s+Queue\(/);
    expect(clean).not.toMatch(/REDIS_URL/);
  });

  it("metrics are REAL prisma counts, not fabricated numbers", () => {
    expect(SERVICE).toMatch(/prisma\.uploadSession\.count/);
    expect(SERVICE).toMatch(/prisma\.evidence\.count/);
    expect(SERVICE).toMatch(/prisma\.operationalIncident\.count/);
    // The core operational statuses are queried directly.
    expect(SERVICE).toMatch(/"STALLED"/);
    expect(SERVICE).toMatch(/"FAILED"/);
    expect(SERVICE).toMatch(/"SIGNED"/);
    expect(SERVICE).toMatch(/latestReportVersion:\s*null/);
    expect(SERVICE).toMatch(/verificationPackageVersion:\s*null/);
  });

  it("TSA/OTS failures come from REAL evidence status columns", () => {
    expect(SERVICE).toMatch(/tsaStatus:\s*"FAILED"/);
    expect(SERVICE).toMatch(/otsStatus:\s*"FAILED"/);
  });

  it("returns honest null for genuinely absent signals — never a fabricated healthy 0", () => {
    // The Measured type is `number | null`.
    expect(SERVICE).toMatch(/export type Measured\s*=\s*number\s*\|\s*null/);
    // Failed-count reads degrade to null on error, not to 0.
    expect(SERVICE).toMatch(/catch\s*\{[\s\S]*?return\s+null/);
    // Package failure has no independent signal → explicit null.
    expect(SERVICE).toMatch(/failed:\s*null/);
    // Queue-derived numbers become null when the inventory is unreadable.
    expect(SERVICE).toMatch(/queues\s*\?\s*queues\.[a-zA-Z]+\s*:\s*null/);
  });

  it("never fabricates a 'healthy' string or hard-codes fake positive metrics", () => {
    const clean = stripComments(SERVICE);
    expect(clean).not.toMatch(/status:\s*"healthy"/);
    expect(clean).not.toMatch(/health:\s*"healthy"/);
  });

  it("NEVER reads evidence contents — counts only", () => {
    const clean = stripComments(SERVICE);
    for (const forbidden of [
      "signatureBase64",
      "fileSha256",
      "fingerprintHash",
      "fingerprintCanonicalJson",
      "storageKey",
      "storageBucket",
      "otsProofBase64",
      "tsaTokenBase64",
      "internalNotes",
      "findMany",
    ]) {
      expect(clean).not.toContain(forbidden);
    }
  });

  it("is platform-wide read-only: no evidence mutation calls", () => {
    const clean = stripComments(SERVICE);
    expect(clean).not.toMatch(/prisma\.evidence\.(update|create|delete|upsert)/);
    expect(clean).not.toMatch(/prisma\.report\.(update|create|delete|upsert)/);
    // Aggregation surface is count / groupBy only.
    expect(clean).not.toMatch(/queue\.add\(/);
  });
});
