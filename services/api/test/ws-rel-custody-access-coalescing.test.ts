/**
 * WS-REL / PRO-O1-03 — repeatable access events do not grow a record's custody
 * chain without bound.
 *
 *  - 100 anonymous Verify answers that issue originals through one link append
 *    ONE VERIFY_VIEWED release event; concurrent first answers append one;
 *  - 100 refused downloads by one member append ONE EXPORT_BLOCKED_BY_POLICY;
 *    a different refusal reason or another member is its own event;
 *  - authenticated original downloads are still recorded every time.
 *
 * The real gate service; the custody writer and the db are doubles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ appended: [] as Array<{ evidenceId: string; eventType: string; payload: Record<string, unknown> }> }));

vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: async (e: { evidenceId: string; eventType: string; payload: Record<string, unknown> }) => {
    H.appended.push(e);
  },
}));
vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => async (args?: { where?: { id?: string } }) =>
              model === "evidence" && method === "findUnique"
                ? // A personal record owned by someone else: the gate refuses.
                  { id: args?.where?.id ?? "x", teamId: null, ownerUserId: "owner-1", retentionUntilUtc: null }
                : null,
          },
        ),
    },
  ),
}));

import { evaluateArtifactDownload, recordOriginalRelease } from "../src/services/evidence/artifact-download-gate.service.js";
import { clearAllRateLimitBuckets } from "../src/services/rate-limit.js";

beforeEach(async () => {
  H.appended.length = 0;
  await clearAllRateLimitBuckets();
});

const rec = () => `rec-${Math.random().toString(36).slice(2)}`;

describe("PRO-O1-03 Public Verify original release is coalesced per link", () => {
  it("100 answers through one link append one release event", async () => {
    const evidenceId = rec();
    for (let i = 0; i < 100; i += 1) {
      await recordOriginalRelease({ evidenceId, actorUserId: null, channel: "public_verify", originalUrlsIssued: 1, coalesceKey: "link-1" });
    }
    expect(H.appended.filter((e) => e.evidenceId === evidenceId)).toHaveLength(1);
  });

  it("two concurrent first answers append exactly one", async () => {
    const evidenceId = rec();
    await Promise.all([
      recordOriginalRelease({ evidenceId, actorUserId: null, channel: "public_verify", originalUrlsIssued: 1, coalesceKey: "l" }),
      recordOriginalRelease({ evidenceId, actorUserId: null, channel: "public_verify", originalUrlsIssued: 1, coalesceKey: "l" }),
    ]);
    expect(H.appended).toHaveLength(1);
  });

  it("an authenticated original download is recorded every time", async () => {
    const evidenceId = rec();
    for (let i = 0; i < 3; i += 1) {
      await recordOriginalRelease({ evidenceId, actorUserId: "u1", channel: "original", originalUrlsIssued: 1 });
    }
    expect(H.appended).toHaveLength(3);
  });
});

describe("PRO-O1-03 identical download refusals are coalesced per actor", () => {
  const refuse = (evidenceId: string, actorUserId: string, message = "Forbidden") =>
    evaluateArtifactDownload({
      evidenceId,
      actorUserId,
      kind: "original",
      // Read access passes; the download itself is refused (owner-only).
      readAccess: async () => ({ ok: true, message }),
    });

  it("100 refused downloads by one member append one refusal event", async () => {
    const evidenceId = rec();
    for (let i = 0; i < 100; i += 1) {
      const d = await refuse(evidenceId, "viewer-1");
      expect(d.allowed).toBe(false);
    }
    const blocked = H.appended.filter((e) => e.eventType === "EXPORT_BLOCKED_BY_POLICY");
    expect(blocked).toHaveLength(1);
  });

  it("another member's refusal is its own event", async () => {
    const evidenceId = rec();
    await refuse(evidenceId, "viewer-1");
    await refuse(evidenceId, "viewer-2");
    await refuse(evidenceId, "viewer-2");
    expect(H.appended.filter((e) => e.eventType === "EXPORT_BLOCKED_BY_POLICY")).toHaveLength(2);
  });
});
