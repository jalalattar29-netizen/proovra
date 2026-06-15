/**
 * Phase EVIDENCE-LIFECYCLE-UNLOCK — POST /v1/evidence/:id/unlock contract.
 *
 * Source-pinned (no DB roundtrip) so the contract holds even when the
 * full route test infra is offline. Asserts:
 *
 *   1. The route exists with the canonical path + requireAuth gate.
 *   2. Same auth/ownership entry path as `/lock` (uses
 *      `getEvidenceWithOwnerAccess` and Zod-validated UUID param).
 *   3. Accepts an optional `reason` body (string, ≤500 chars).
 *   4. Rejects with 409 EVIDENCE_NOT_LOCKED when the record is not
 *      currently locked (the only short-circuit that doesn't touch
 *      the database state).
 *   5. On the success path: writes `lockedAt: null` + `lockedByUserId:
 *      null` and emits an `evidence.unlock` audit event with the
 *      reason in metadata.
 *   6. Does NOT write a custody event — the CustodyEventType enum
 *      has no EVIDENCE_UNLOCKED member and the spec forbids schema
 *      changes without approval. The audit log is the authoritative
 *      surface.
 *   7. Does NOT touch any integrity field: storage object lock mode,
 *      retention, legal hold, file hash, signature, custody chain.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROUTES = readFileSync(
  resolve(__dirname, "..", "src", "routes", "evidence.routes.ts"),
  "utf8",
);

// Extract just the unlock route body — match from `app.post(` through
// the route's terminating `);`.
function unlockRouteBody(): string {
  const anchor = ROUTES.indexOf('"/v1/evidence/:id/unlock"');
  expect(anchor).toBeGreaterThan(0);
  // Walk forward until we hit the closing `);` of the route block.
  // Most route handlers in this file close with `},\n  );`.
  const after = ROUTES.slice(anchor);
  const end = after.indexOf("\n  );");
  expect(end).toBeGreaterThan(0);
  return after.slice(0, end + 5);
}

describe("POST /v1/evidence/:id/unlock — contract", () => {
  it("route exists with requireAuth preHandler (same gate as /lock)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/preHandler:\s*requireAuth/);
  });

  it("validates :id as UUID via Zod (same param shape as /lock)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/z\.string\(\)\.uuid\(\)\.parse\(\(req\.params as ParamsId\)\.id\)/);
  });

  it("accepts an optional `reason` string body (≤500 chars)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(
      /z\s*\.object\(\{\s*reason:\s*z\.string\(\)\.trim\(\)\.max\(500\)\.optional\(\)\s*\}\)/,
    );
  });

  it("uses getEvidenceWithOwnerAccess (same ownership gate as /lock)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/getEvidenceWithOwnerAccess\(ownerUserId, id\)/);
  });

  it("rejects with 409 EVIDENCE_NOT_LOCKED when lockedAt is null", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/if \(!evidence\.lockedAt\)/);
    expect(block).toMatch(/reply\.code\(409\)\.send\(\{\s*\n?\s*code:\s*"EVIDENCE_NOT_LOCKED"/);
  });

  it("on success: writes lockedAt:null AND lockedByUserId:null (clears both columns)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(
      /prisma\.evidence\.update\(\{\s*\n?\s*where:\s*\{\s*id\s*\},\s*\n?\s*data:\s*\{\s*lockedAt:\s*null,\s*lockedByUserId:\s*null\s*\}/,
    );
  });

  it("emits an `evidence.unlock` audit event with success outcome + reason in metadata", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/action:\s*"evidence\.unlock"/);
    expect(block).toMatch(/outcome:\s*"success"/);
    expect(block).toMatch(/reason:\s*body\.reason \?\? null/);
  });

  it("does NOT write a custody event (no EVIDENCE_UNLOCKED enum member; no schema change)", () => {
    const block = unlockRouteBody();
    expect(block).not.toMatch(/appendCustodyEvent/);
  });

  it("does NOT touch any storage / retention / signature / hash field", () => {
    const block = unlockRouteBody();
    // The prisma.evidence.update `data:` block must contain ONLY
    // lockedAt and lockedByUserId. Anything else would be a quiet
    // integrity-state mutation — which the spec forbids.
    const updateMatch = block.match(
      /prisma\.evidence\.update\(\{[\s\S]*?data:\s*\{([^}]*)\}/,
    );
    expect(updateMatch).not.toBeNull();
    const dataFields = updateMatch![1];
    expect(dataFields).toMatch(/lockedAt:\s*null/);
    expect(dataFields).toMatch(/lockedByUserId:\s*null/);
    // Anti-regression list: any of these would weaken integrity.
    for (const forbidden of [
      "storageObjectLockMode",
      "storageObjectLockRetainUntilUtc",
      "storageObjectLockLegalHoldStatus",
      "retentionUntilUtc",
      "fileSha256",
      "signatureBase64",
      "tsaStatus",
      "otsStatus",
      "deletedAt",
      "archivedAt",
      "verificationStatus",
      "status:",
    ]) {
      expect(dataFields).not.toContain(forbidden);
    }
  });

  it("on success: returns the updated evidence wrapped under `evidence` key (matches /lock response shape)", () => {
    const block = unlockRouteBody();
    expect(block).toMatch(/reply\.code\(200\)\.send\(\{\s*\n?\s*evidence:\s*\{/);
  });

  it("regression — `/lock` endpoint with body.locked:false STILL returns 400 (this route does not replace that gate)", () => {
    // The original /lock route's else branch must still reply 400
    // "Unlock is not allowed" for clients that send {locked:false}.
    // Anyone wanting to unlock must hit the dedicated /unlock route.
    expect(ROUTES).toMatch(/return reply\.code\(400\)\.send\(\{\s*message:\s*"Unlock is not allowed"\s*\}\);/);
  });
});

describe("Backend lock guard — NOT weakened by the unlock addition", () => {
  it("/lock route still requires evidence to be SIGNED or REPORTED before locking", () => {
    expect(ROUTES).toMatch(
      /evidence\.status !== prismaPkg\.EvidenceStatus\.SIGNED\s*&&\s*evidence\.status !== prismaPkg\.EvidenceStatus\.REPORTED/,
    );
  });

  it("/lock route still writes the EVIDENCE_LOCKED custody event", () => {
    expect(ROUTES).toMatch(/eventType:\s*prismaPkg\.CustodyEventType\.EVIDENCE_LOCKED/);
  });

  it("/lock route still writes the `evidence.lock` audit event on success", () => {
    expect(ROUTES).toMatch(/action:\s*"evidence\.lock"[\s\S]{0,200}?outcome:\s*"success"/);
  });
});
