/**
 * UC-TRUST-002 / UC-TRUST-004 / UC-DER-007 — the provenance-chain projection
 * (`loadProvenanceChain`, shared by the API route and the package's
 * provenance/chain.json) on live PostgreSQL 16.
 *
 *   TRUST-002  a PENDING OTS proof (with its OTS_APPLIED custody event) is not
 *              "anchored"; a legacy STAMPED token never validated is not an
 *              applied timestamp.
 *   TRUST-004  the capture trust-event sub-chain is verified on read: an
 *              edited payload or a deleted middle row breaks it, and a broken
 *              chain is provenance class C. v2 hashes recompute from stored
 *              rows, nested payloads included.
 *   DER-007    the derived lineage reports its true total and a truncation flag.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("provenance chain truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(over: Record<string, unknown> = {}) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "provenance truth",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        signedAtUtc: new Date(),
        ...over,
      } as never,
      select: { id: true },
    });
  }

  /** Append trust events the way the writer chains them, with the v2 formula. */
  async function appendV2(evidenceId: string, payloads: Array<Record<string, unknown>>) {
    const teamId = h.fixtures.teamA.teamId;
    let prev: string | null = null;
    let seq = 0;
    for (const payload of payloads) {
      seq += 1;
      const atUtc = new Date(Date.now() + seq);
      const eventHash = runtime.buildTrustEventHashV2({
        teamId,
        code: "CAPTURE_ARTIFACT_RECEIVED",
        captureSessionId: null,
        evidenceId,
        deviceId: null,
        sequence: seq,
        atUtc,
        payload,
        prevEventHash: prev,
      });
      await prisma.captureTrustEventRecord.create({
        data: {
          teamId,
          evidenceId,
          code: "CAPTURE_ARTIFACT_RECEIVED",
          sequence: seq,
          atUtc,
          payload: payload as never,
          eventHash,
          prevEventHash: prev,
        } as never,
      });
      prev = eventHash;
    }
  }

  it("TRUST-002: PENDING OTS + unvalidated legacy STAMPED -> not anchored, not an applied timestamp", async () => {
    const ev = await record({
      otsStatus: "PENDING",
      otsProofBase64: Buffer.from("proof").toString("base64"),
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: null,
      tsaGenTimeUtc: new Date(),
    });
    // The custody events the old projection read as states.
    await prisma.$transaction(async (tx) => {
      await runtime.appendCustodyEventTx(tx as never, {
        evidenceId: ev.id,
        eventType: "TIMESTAMP_APPLIED" as never,
        payload: { tsaUrl: "https://tsa.invalid" },
      });
      await runtime.appendCustodyEventTx(tx as never, {
        evidenceId: ev.id,
        eventType: "OTS_APPLIED" as never,
        payload: { otsStatus: "PENDING", otsPhase: "proof_created" },
      });
    });
    const chain = await runtime.loadProvenanceChain(prisma as never, ev.id);
    expect(chain.time.ots.applied).toBe(false);
    expect(chain.time.ots.status).toBe("SUBMITTED");
    expect(chain.time.rfc3161.applied).toBe(false);
    expect(chain.time.rfc3161.status).toBe("RECORDED_NOT_VALIDATED");
  });

  it("TRUST-002: a chain-verified anchor is the only 'applied' OTS layer", async () => {
    const ev = await record({
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: new Date(),
      otsAnchorCheck: "BITCOIN_VERIFIED",
      otsBitcoinTxid: "a".repeat(64),
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: new Date(),
      tsaGenTimeUtc: new Date(),
    });
    const chain = await runtime.loadProvenanceChain(prisma as never, ev.id);
    expect(chain.time.ots).toMatchObject({ applied: true, status: "VERIFIED", anchorTxId: "a".repeat(64) });
    expect(chain.time.rfc3161).toMatchObject({ applied: true, status: "VALIDATED" });
  });

  it("TRUST-004: v2 chain (nested payload) verifies; an edited payload and a deleted middle row break it -> class C", async () => {
    const ev = await record();
    await appendV2(ev.id, [{ stage: "a", nested: { z: 1, b: { y: 2, a: 3 } } }, { stage: "b" }, { stage: "c" }]);
    const good = await runtime.loadProvenanceChain(prisma as never, ev.id);
    expect(good.trustEventChain).toMatchObject({ valid: true, checked: 3, unverifiableLegacy: 0 });

    // The table is append-only (migration 20281001000500): an ordinary UPDATE
    // and DELETE are refused by the trigger.
    const second = await prisma.captureTrustEventRecord.findFirstOrThrow({ where: { evidenceId: ev.id, sequence: 2 } });
    await expect(
      prisma.captureTrustEventRecord.update({ where: { id: second.id }, data: { payload: { stage: "EDITED" } } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.captureTrustEventRecord.delete({ where: { id: second.id } })).rejects.toThrow(/append-only/);

    // A privileged attacker who bypasses triggers (session_replication_role =
    // replica, superuser) edits a payload: the verifier still detects it.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE "capture_trust_event_records" SET "payload" = '{"stage":"EDITED"}'::jsonb WHERE "id" = ${second.id}::uuid`;
    });
    const edited = await runtime.loadProvenanceChain(prisma as never, ev.id);
    expect(edited.trustEventChain.valid).toBe(false);
    expect(edited.trustEventChain.failures).toContainEqual({ sequence: 2, reason: "HASH_MISMATCH" });
    expect(edited.capture.provenanceClass).toBe("C");

    // Delete a middle row from another chain.
    const ev2 = await record();
    await appendV2(ev2.id, [{ s: 1 }, { s: 2 }, { s: 3 }]);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`DELETE FROM "capture_trust_event_records" WHERE "evidence_id" = ${ev2.id}::uuid AND "sequence" = 2`;
    });
    const gap = await runtime.loadProvenanceChain(prisma as never, ev2.id);
    expect(gap.trustEventChain.valid).toBe(false);
    expect(gap.trustEventChain.failures.map((f) => f.reason)).toEqual(
      expect.arrayContaining(["SEQUENCE_GAP", "PREV_LINK_BROKEN"]),
    );
  });

  it("TRUST-004: the package variant carries the rows so the sub-chain recomputes externally", async () => {
    const ev = await record();
    await appendV2(ev.id, [{ k: { b: 1, a: 2 } }]);
    const chain = await runtime.loadProvenanceChain(prisma as never, ev.id, new Date(), { includeTrustEventRecords: true });
    const row = chain.trustEventRecords![0]!;
    const recomputed = runtime.buildTrustEventHashV2({
      teamId: row.teamId,
      code: row.code,
      captureSessionId: row.captureSessionId,
      evidenceId: row.evidenceId,
      deviceId: row.deviceId,
      sequence: row.sequence,
      atUtc: new Date(row.atUtc!),
      payload: row.payload as Record<string, unknown>,
      prevEventHash: row.prevEventHash,
    });
    expect(recomputed).toBe(row.eventHash);
  });

  it("DER-007: the derived lineage states its true total and that it was truncated", async () => {
    const ev = await record();
    const part = await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: 0,
        storageBucket: "b",
        storageKey: `k/${randomUUID()}`,
        mimeType: "video/mp4",
        sizeBytes: 10n,
        sha256: "c".repeat(64),
      } as never,
      select: { id: true },
    });
    const rows = Array.from({ length: 503 }, (_, i) => ({
      evidenceId: ev.id,
      evidencePartId: part.id,
      teamId: h.fixtures.teamA.teamId,
      assetKind: "video_keyframe",
      variantKey: `kf-${i}`,
      status: "COMPLETED",
      storageBucket: "b",
      storageKey: `derived/${ev.id}/${i}`,
      derivedSha256: "d".repeat(64),
    }));
    try {
      await prisma.evidencePartDerivedAsset.createMany({ data: rows as never });
    } catch (err) {
      // Schema drift in a fixture is not the behaviour under test; report it.
      throw new Error(`fixture insert failed: ${(err as Error).message.slice(0, 400)}`);
    }
    const chain = await runtime.loadProvenanceChain(prisma as never, ev.id);
    expect(chain.derivedArtifacts.length).toBe(500);
    expect(chain.derivedArtifactsTotalCount).toBe(503);
    expect(chain.derivedArtifactsTruncated).toBe(true);
  });
});
