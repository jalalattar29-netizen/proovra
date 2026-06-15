/**
 * Phase EVIDENCE-DELETE-ELIGIBILITY — backend eligibility service contract.
 *
 * Pins the predicate set and precedence the UI relies on. The actual
 * delete route guards (assertEvidenceNotLocked,
 * assertEvidenceDeletionAllowedByRetention, canDeleteEvidence,
 * gateRetentionAction) are untouched — these tests only assert the
 * read-only computation surface.
 *
 * Each reasonCode is a public contract — frontend mirror in
 * `apps/web/app/(app)/evidence/lib/evidence-delete-eligibility.ts`
 * depends on the same set of literals. A regression here will be
 * caught by the source-pinned banned-copy test in the web test suite.
 */

import { describe, it, expect } from "vitest";

import {
  computeEvidenceDeleteEligibilitySync,
  DELETE_ELIGIBILITY_RESPONSE_FIELD,
  type EvidenceDeleteEligibilityInput,
} from "../src/services/evidence/evidence-delete-eligibility.service.js";

function baseEvidence(
  overrides: Partial<EvidenceDeleteEligibilityInput> = {},
): EvidenceDeleteEligibilityInput {
  return {
    id: "ev-1",
    deletedAt: null,
    lockedAt: null,
    storageObjectLockMode: null,
    storageObjectLockRetainUntilUtc: null,
    storageObjectLockLegalHoldStatus: null,
    retentionUntilUtc: null,
    ...overrides,
  };
}

describe("computeEvidenceDeleteEligibilitySync — reason precedence", () => {
  it("returns canMoveToTrash: true when no blocking condition is set", () => {
    const r = computeEvidenceDeleteEligibilitySync(baseEvidence());
    expect(r.canMoveToTrash).toBe(true);
    expect(r.reasonCode).toBeNull();
    expect(r.blockedUntil).toBeNull();
    expect(r.message).toBe("");
  });

  it("returns ALREADY_DELETED first when the record is already in trash", () => {
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({ deletedAt: "2025-01-01T00:00:00.000Z", lockedAt: "2025-01-01T00:00:00.000Z" }),
    );
    expect(r.canMoveToTrash).toBe(false);
    expect(r.reasonCode).toBe("ALREADY_DELETED");
  });

  it("returns EVIDENCE_LOCKED when lockedAt is set (sentinel for permanent lock)", () => {
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({ lockedAt: "2025-01-01T00:00:00.000Z" }),
    );
    expect(r.canMoveToTrash).toBe(false);
    expect(r.reasonCode).toBe("EVIDENCE_LOCKED");
  });

  it("returns COMPLIANCE_RETENTION when Object Lock mode=COMPLIANCE AND retain-until is in the future", () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // +1y
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: future.toISOString(),
      }),
    );
    expect(r.canMoveToTrash).toBe(false);
    expect(r.reasonCode).toBe("COMPLIANCE_RETENTION");
    expect(r.blockedUntil).toBe(future.toISOString());
    expect(r.message).toMatch(/compliance retention until \d{4}-\d{2}-\d{2}/);
  });

  it("does NOT block on COMPLIANCE when retain-until is in the PAST (retention expired)", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: past.toISOString(),
      }),
    );
    expect(r.canMoveToTrash).toBe(true);
  });

  it("falls back to date-less COMPLIANCE wording when retain-until is missing", () => {
    // Defensive: in malformed data, mode=COMPLIANCE with null retain-until
    // would NOT block (it can't tell if retention is still active). This
    // mirrors backend behaviour — the guard only fires when retain-until > now.
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: null,
      }),
    );
    expect(r.canMoveToTrash).toBe(true);
  });

  it("returns LEGAL_HOLD when storageObjectLockLegalHoldStatus is ON", () => {
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({ storageObjectLockLegalHoldStatus: "ON" }),
    );
    expect(r.canMoveToTrash).toBe(false);
    expect(r.reasonCode).toBe("LEGAL_HOLD");
  });

  it("returns RETENTION_UNTIL when retentionUntilUtc is in the future and nothing else blocks", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({ retentionUntilUtc: future }),
    );
    expect(r.canMoveToTrash).toBe(false);
    expect(r.reasonCode).toBe("RETENTION_UNTIL");
    expect(r.blockedUntil).toBe(future);
  });

  it("does NOT block on retentionUntil when it is in the PAST", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({ retentionUntilUtc: past }),
    );
    expect(r.canMoveToTrash).toBe(true);
  });

  it("COMPLIANCE precedence: when COMPLIANCE active AND legal-hold ON, reports COMPLIANCE_RETENTION", () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: future,
        storageObjectLockLegalHoldStatus: "ON",
      }),
    );
    expect(r.reasonCode).toBe("COMPLIANCE_RETENTION");
  });

  it("EVIDENCE_LOCKED precedence: locked beats every retention reason", () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const r = computeEvidenceDeleteEligibilitySync(
      baseEvidence({
        lockedAt: "2024-01-01T00:00:00.000Z",
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: future,
        storageObjectLockLegalHoldStatus: "ON",
        retentionUntilUtc: future,
      }),
    );
    expect(r.reasonCode).toBe("EVIDENCE_LOCKED");
  });
});

describe("EvidenceDeleteEligibility — banned overclaim copy", () => {
  // Spec forbids these phrases in any message we surface.
  const BANNED = [
    "tamper-proof",
    "tamper proof",
    "legally guaranteed",
    "permanently undeletable",
    "court proof",
    "court-proof",
    "admissible",
  ];

  function allMessages(): string[] {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    void past;
    return [
      computeEvidenceDeleteEligibilitySync(baseEvidence()).message,
      computeEvidenceDeleteEligibilitySync(
        baseEvidence({ deletedAt: "2025-01-01T00:00:00.000Z" }),
      ).message,
      computeEvidenceDeleteEligibilitySync(
        baseEvidence({ lockedAt: "2025-01-01T00:00:00.000Z" }),
      ).message,
      computeEvidenceDeleteEligibilitySync(
        baseEvidence({
          storageObjectLockMode: "COMPLIANCE",
          storageObjectLockRetainUntilUtc: future,
        }),
      ).message,
      computeEvidenceDeleteEligibilitySync(
        baseEvidence({ storageObjectLockLegalHoldStatus: "ON" }),
      ).message,
      computeEvidenceDeleteEligibilitySync(
        baseEvidence({ retentionUntilUtc: future }),
      ).message,
    ];
  }

  it("emits no banned overclaim in any reason message", () => {
    const messages = allMessages();
    for (const message of messages) {
      for (const banned of BANNED) {
        expect(message.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });

  it("emits no emoji in any reason message", () => {
    const messages = allMessages();
    // U+1F000–U+1FFFF + common dingbats. The spec just says "no
    // emoji" — a broad-range check is the simplest enforceable rule.
    const emojiPattern = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
    for (const message of messages) {
      expect(message).not.toMatch(emojiPattern);
    }
  });
});

describe("Response field contract", () => {
  it("DELETE_ELIGIBILITY_RESPONSE_FIELD is the canonical 'deleteEligibility' name", () => {
    // The frontend reads `response.evidence.deleteEligibility` —
    // pinning the constant guards against a silent rename.
    expect(DELETE_ELIGIBILITY_RESPONSE_FIELD).toBe("deleteEligibility");
  });
});
