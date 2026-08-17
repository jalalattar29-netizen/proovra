/**
 * PHASE 13 (NEW-055, NEW-056) — the two verification defects, driven.
 *
 * Both were found while building the LOCAL RECORDING MESSAGING PROVIDER that
 * makes the enterprise step-up gate provable. Neither is exotic; both are the
 * same shape as defects this programme has already closed elsewhere:
 *
 *   NEW-055  a binding that is WRITTEN and never CHECKED. The step-up challenge
 *            persists `verificationAttemptId` at start, and the check path
 *            independently selected "the most recent STARTED attempt for this
 *            recipient" — so with two challenges in flight on one number, the
 *            code minted for the second approved the first.
 *
 *   NEW-056  a limiter that COUNTS ITS OWN REFUSALS. Every refusal writes a
 *            `FAILED`/`rate_limited` attempt row, and the window count had no
 *            predicate excluding them, so a tripped limit fed itself: each
 *            further attempt pushed the hour forward again.
 *
 * The doubles here are deliberately thin and are NOT stand-ins for behaviour:
 * each records the PREDICATE the service asked the database for. That is the
 * whole subject — the defect in both cases was a missing clause in a `where`,
 * and a test that asserted on a returned row could pass against either version
 * by choosing convenient fixtures. Asking "what did it actually query?" cannot.
 */

import { describe, expect, it } from "vitest";

import {
  checkVerification,
  startVerification,
} from "../src/services/communications/verification.service.js";

type Where = Record<string, unknown>;

/** Captures every predicate the service issues, and answers deterministically. */
function prismaDouble(options: {
  findFirstResult?: unknown;
  countResult?: number;
}) {
  const seen: { counts: Where[]; findFirsts: Where[]; created: unknown[] } = {
    counts: [],
    findFirsts: [],
    created: [],
  };
  const client = {
    verificationAttempt: {
      count: async (args: { where: Where }) => {
        seen.counts.push(args.where);
        return options.countResult ?? 0;
      },
      findFirst: async (args: { where: Where }) => {
        seen.findFirsts.push(args.where);
        return options.findFirstResult ?? null;
      },
      create: async (args: { data: unknown }) => {
        seen.created.push(args.data);
        return { id: "created-attempt", ...(args.data as object) };
      },
      update: async () => ({}),
    },
    securityEvent: { create: async () => ({}) },
  };
  return { client, seen };
}

const RECIPIENT = "+15550000001";

describe("PHASE 13 NEW-055 — a challenge's code may only approve ITS OWN attempt", () => {
  it("names the attempt id in the lookup when the caller supplies one", async () => {
    const { client, seen } = prismaDouble({ findFirstResult: null });

    await expect(
      checkVerification(
        {
          teamId: "team-1",
          phoneE164OrRaw: RECIPIENT,
          code: "000000",
          verificationAttemptId: "attempt-B",
        },
        client as never,
      ),
    ).rejects.toThrow();

    const where = seen.findFirsts.at(0);
    expect(where, "the service never queried for an attempt").toBeTruthy();
    expect(
      where?.id,
      "the caller named its own attempt and the lookup ignored it — the code " +
        "minted for one challenge can approve another on the same number",
    ).toBe("attempt-B");
  });

  it("still bounds by tenant and recipient even when an id is supplied", async () => {
    // An id handed in by a caller is not authority on its own: it must still
    // belong to the tenant and the number the check is for.
    const { client, seen } = prismaDouble({ findFirstResult: null });
    await expect(
      checkVerification(
        {
          teamId: "team-1",
          phoneE164OrRaw: RECIPIENT,
          code: "000000",
          verificationAttemptId: "attempt-B",
        },
        client as never,
      ),
    ).rejects.toThrow();

    const where = seen.findFirsts.at(0) ?? {};
    expect(where.teamId).toBe("team-1");
    expect(where.recipientHash, "the recipient predicate was dropped").toBeTruthy();
    expect(where.status, "the STARTED predicate was dropped").toBeTruthy();
  });

  it("omitting the id preserves today's behaviour exactly", async () => {
    // Callers with no challenge behind them legitimately want "the one in
    // flight". Supplying the id narrows; omitting it must change nothing.
    const { client, seen } = prismaDouble({ findFirstResult: null });
    await expect(
      checkVerification(
        { teamId: "team-1", phoneE164OrRaw: RECIPIENT, code: "000000" },
        client as never,
      ),
    ).rejects.toThrow();

    const where = seen.findFirsts.at(0) ?? {};
    expect(Object.prototype.hasOwnProperty.call(where, "id")).toBe(false);
  });
});

describe("PHASE 13 NEW-056 — the rate limiter does not count its own refusals", () => {
  it("excludes rate_limited rows from the window count", async () => {
    const { client, seen } = prismaDouble({ countResult: 0 });

    await startVerification(
      {
        teamId: "team-1",
        phoneE164OrRaw: RECIPIENT,
        channel: "SMS" as never,
      },
      client as never,
    ).catch(() => undefined);

    const where = seen.counts.at(0);
    expect(where, "the limiter never counted anything").toBeTruthy();
    expect(
      where?.NOT,
      "the window count has no exclusion, so the limiter's own refusals are " +
        "counted and a tripped limit extends itself by another hour on every " +
        "further attempt",
    ).toEqual({ errorCode: "rate_limited" });
  });

  it("still counts genuine starts — the exclusion is narrow", async () => {
    const { client, seen } = prismaDouble({ countResult: 0 });
    await startVerification(
      { teamId: "team-1", phoneE164OrRaw: RECIPIENT, channel: "SMS" as never },
      client as never,
    ).catch(() => undefined);

    const where = seen.counts.at(0) ?? {};
    expect(where.teamId).toBe("team-1");
    expect(where.recipientHash).toBeTruthy();
    expect(where.createdAt, "the one-hour window predicate was dropped").toBeTruthy();
  });
});
