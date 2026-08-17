/**
 * PHASE 13 (NEW-058) — ACCOUNT-BOUND STEP-UP, DRIVEN AGAINST A REAL DATABASE.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The enterprise step-up gate took its destination from the REQUEST BODY, so
 * an approved challenge proved possession of a handset the CALLER chose rather
 * than of a factor the ACCOUNT enrolled. A stolen session supplied the
 * attacker's own number and approved its own challenge; every step-up-gated
 * mutation in the product inherited that.
 *
 * WHY THESE CASES AND NOT OTHERS
 * ---------------------------------------------------------------------------
 * Each one is a way the old design could be walked around, or a way the NEW
 * design could be walked around if a binding were written and never enforced —
 * which is precisely the shape of NEW-055, found in this same subsystem. So the
 * suite is mostly NEGATIVE: a small number of positive cases prove the gate can
 * be satisfied at all, and the rest prove it cannot be satisfied any other way.
 *
 * The database-level cases at the end matter as much as the service ones: the
 * CHECK constraints are what stop a future writer creating an ACTIVE factor
 * that was never verified, which would be an elevation credential that nobody
 * proved possession of.
 *
 * The suite skips ONLY when the live-integration environment is absent, which
 * is the harness's own contract — never per-case, and never to hide a failure.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const HANDSET_A = "+14155550101";
const HANDSET_B = "+14155550202";

describe("PHASE 13 §NEW-058 — account-bound step-up (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let factors: typeof import("../src/services/security/verified-contact-factor.service.js");
  let userA = "";
  let userB = "";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    factors = await import(
      "../src/services/security/verified-contact-factor.service.js"
    );
    userA = harness.fixtures.teamA.ownerUserId;
    userB = harness.fixtures.teamB.ownerUserId;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // 1. Enrollment
  // =========================================================================

  describe("1. an enrolment is not a factor until it is proven", () => {
    it("starts PENDING, and a PENDING enrolment cannot elevate", async () => {
      const { factor } = await factors.startContactFactorEnrollment({
        userId: userA,
        kind: "SMS",
        destinationRaw: HANDSET_A,
      });
      expect(factor.status).toBe("ENROLLING");
      expect(factor.verifiedAtUtc).toBeNull();

      // The whole point of the fix: an unverified enrolment is not yet
      // something the step-up gate will send to.
      expect(
        await factors.resolveActiveContactFactor({ userId: userA }),
        "an ENROLLING factor must not resolve as active",
      ).toBeNull();

      await expect(
        factors.resolveStepUpDestination({
          userId: userA,
          factorId: factor.factorId,
        }),
      ).rejects.toBeInstanceOf(factors.VerifiedContactFactorError);
    });

    it("never stores the destination in the clear and never projects it", async () => {
      const rows = await prisma.mfaFactor.findMany({
        where: { userId: userA, kind: "SMS" },
        select: { destinationMask: true, destinationCiphertext: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          Buffer.from(row.destinationCiphertext ?? Buffer.alloc(0)).toString("utf8"),
          "the sealed bytes must not contain the plaintext destination",
        ).not.toContain(HANDSET_A);
        expect(row.destinationMask).not.toBe(HANDSET_A);
      }
      const projected = await factors.listContactFactors(userA);
      expect(
        JSON.stringify(projected),
        "no projection may carry the destination",
      ).not.toContain(HANDSET_A);
    });

    it("activates exactly once — two concurrent completions produce one winner", async () => {
      const { factor } = await factors.startContactFactorEnrollment({
        userId: userB,
        kind: "SMS",
        destinationRaw: HANDSET_B,
      });

      // The transition is a conditional UPDATE on `status = 'ENROLLING'`, not a
      // read-then-write, so the second caller loses rather than double-writing.
      const results = await Promise.allSettled([
        factors.completeContactFactorEnrollment({
          userId: userB,
          factorId: factor.factorId,
        }),
        factors.completeContactFactorEnrollment({
          userId: userB,
          factorId: factor.factorId,
        }),
      ]);
      expect(
        results.filter((r) => r.status === "fulfilled").length,
        "exactly one completion may succeed",
      ).toBe(1);

      const active = await factors.resolveActiveContactFactor({ userId: userB });
      expect(active?.factorId).toBe(factor.factorId);
      expect(active?.verifiedAtUtc).not.toBeNull();
    });
  });

  // =========================================================================
  // 2. Ownership — the defect, stated as tests
  // =========================================================================

  describe("2. a factor belongs to an ACCOUNT, not to whoever names it", () => {
    it("another user's factor id does not resolve", async () => {
      const bFactor = await factors.resolveActiveContactFactor({ userId: userB });
      expect(bFactor).not.toBeNull();

      // userA naming userB's factor: ownership is part of the predicate, so it
      // does not match — it is not an error path, it is a non-match.
      expect(
        await factors.resolveActiveContactFactor({
          userId: userA,
          factorId: bFactor!.factorId,
        }),
        "a factor id from another account must not resolve",
      ).toBeNull();

      await expect(
        factors.resolveStepUpDestination({
          userId: userA,
          factorId: bFactor!.factorId,
        }),
      ).rejects.toBeInstanceOf(factors.VerifiedContactFactorError);
    });

    it("a pending enrolment is not readable by another user", async () => {
      const pending = await prisma.mfaFactor.findFirst({
        where: { userId: userA, status: "ENROLLING", kind: "SMS" },
        select: { id: true },
      });
      expect(pending).not.toBeNull();

      expect(
        (await factors.resolveEnrollingDestination({
          userId: userA,
          factorId: pending!.id,
        }))?.destination,
      ).toBe(HANDSET_A);

      expect(
        await factors.resolveEnrollingDestination({
          userId: userB,
          factorId: pending!.id,
        }),
        "a pending enrolment is not readable by another user",
      ).toBeNull();
    });
  });

  // =========================================================================
  // 3. Revocation and generation — the approval must be perishable
  // =========================================================================

  describe("3. an elevation dies with the enrolment that authorised it", () => {
    it("revocation moves the generation and stops the factor resolving", async () => {
      const before = await factors.resolveActiveContactFactor({ userId: userB });
      expect(before).not.toBeNull();

      const revoked = await factors.revokeContactFactor({
        userId: userB,
        factorId: before!.factorId,
        reason: "test_revocation",
      });
      expect(revoked.status).toBe("REVOKED");
      expect(
        revoked.generation,
        "revocation must move the generation so a pending challenge dies with it",
      ).toBeGreaterThan(before!.generation);

      expect(
        await factors.resolveActiveContactFactor({ userId: userB }),
        "a revoked factor must not resolve as active",
      ).toBeNull();
      await expect(
        factors.resolveStepUpDestination({
          userId: userB,
          factorId: before!.factorId,
        }),
      ).rejects.toBeInstanceOf(factors.VerifiedContactFactorError);
    });

    it("re-enrolling the same destination moves the generation again", async () => {
      const { factor } = await factors.startContactFactorEnrollment({
        userId: userB,
        kind: "SMS",
        destinationRaw: HANDSET_B,
      });
      // One destination per user per channel, so the row is REUSED — and its
      // generation has moved past the revoked value, which is what makes any
      // challenge minted against the old generation unspendable.
      expect(factor.status).toBe("ENROLLING");
      expect(factor.generation).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  // 4. The database refuses the shapes the code must never write
  // =========================================================================

  describe("4. the invariants are enforced by the database, not by memory", () => {
    it("refuses an ACTIVE factor that was never verified", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO mfa_factors
             (id, user_id, kind, status, label,
              destination_ciphertext, destination_iv, destination_auth_tag,
              destination_kek_id, destination_hash, destination_mask,
              created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'SMS', 'ACTIVE', 'bad',
              '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea,
              'k', $2, '***', NOW(), NOW())`,
          userA,
          `hash-${randomUUID()}`,
        ),
        "ACTIVE without verified_at_utc must violate mfa_factors_active_is_verified_chk",
      ).rejects.toThrow();
    });

    it("refuses a contact factor carrying a TOTP shared secret", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO mfa_factors
             (id, user_id, kind, status, label,
              secret_ciphertext, secret_iv, secret_auth_tag, secret_kek_id,
              destination_ciphertext, destination_iv, destination_auth_tag,
              destination_kek_id, destination_hash, destination_mask,
              created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'SMS', 'ENROLLING', 'bad',
              '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 'k',
              '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea,
              'k', $2, '***', NOW(), NOW())`,
          userA,
          `hash-${randomUUID()}`,
        ),
        "a contact factor with a shared secret must violate mfa_factors_kind_payload_chk",
      ).rejects.toThrow();
    });

    it("refuses a TOTP factor with no sealed secret", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO mfa_factors
             (id, user_id, kind, status, label, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'TOTP', 'ENROLLING', 'bad', NOW(), NOW())`,
          userA,
        ),
        "a TOTP factor with no sealed secret must violate mfa_factors_kind_payload_chk",
      ).rejects.toThrow();
    });
  });
});
