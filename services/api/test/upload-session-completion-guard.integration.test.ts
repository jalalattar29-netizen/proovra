// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * AN UPLOAD SESSION NEVER COMPLETES BECAUSE SOMEONE ASKED (live PostgreSQL 16 + MinIO).
 *
 * The generic transition refuses COMPLETED outright; the only writer is
 * `settleCompletedUploadSession`, which proves completion from the record's
 * own finalization truth and the stored bytes. Proven here against a real
 * object store:
 *
 *   NEGATIVE — a PRESIGNED / UPLOADING / VERIFYING session cannot be completed
 *   by a generic request; a record that is not finalized, deleted, failed its
 *   integrity check, belongs to another workspace, has no digest, is missing
 *   parts, or whose stored bytes are missing or the wrong size cannot complete
 *   it; a terminal or held session is never promoted.
 *
 *   POSITIVE — a finalized record with its bytes closes its stranded live
 *   session; repeated settlement is idempotent; concurrent settlement makes
 *   one transition; the reconciler settles shadows through it and no false
 *   stalled-upload condition or event appears.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootOps, makeUser, makeWorkspace, seedEvidence, type Ctx } from "./operations-truth-fixtures.js";
import { tamperSealedEvidence } from "./helpers/sealed-identity-tamper.js";

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000);

describe("upload-session completion guard (live PostgreSQL 16 + MinIO)", () => {
  let c: Ctx;
  let owner: { id: string };
  let teamId: string;
  let otherTeamId: string;
  beforeAll(async () => {
    c = await bootOps();
    const u = await makeUser(c, "guard-owner", { plan: "PRO" });
    owner = u;
    teamId = (await makeWorkspace(c, u.id, { name: "guard-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" })).teamId;
    otherTeamId = (await makeWorkspace(c, u.id, { name: "guard-other", billingPlan: "TEAM", billingStatus: "ACTIVE" })).teamId;
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  const bucket = () => process.env.S3_BUCKET!;

  /** A record whose bytes really are in the store, as finalization leaves it. */
  async function finalizedRecord(opts: { bytes?: Buffer; declaredSize?: number; store?: boolean; status?: string; team?: string } = {}) {
    const body = opts.bytes ?? Buffer.from(`evidence-${randomUUID()}`);
    const key = `guard/${randomUUID()}.bin`;
    if (opts.store !== false) {
      const { putObjectBuffer } = await import("../src/storage.js");
      await putObjectBuffer({ bucket: bucket(), key, body, contentType: "application/octet-stream" });
    }
    return seedEvidence(c, opts.team ?? teamId, owner.id, {
      status: opts.status ?? "SIGNED",
      fileSha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: BigInt(opts.declaredSize ?? body.length),
      storageBucket: bucket(),
      storageKey: key,
    });
  }

  async function session(evidenceId: string, status: string, extra: Record<string, unknown> = {}, team = teamId) {
    await c.prisma.uploadSession.create({
      data: { evidenceId, teamId: team, status, lastActivityAtUtc: HOURS_AGO(3), ...extra } as never,
    });
  }
  const statusOf = async (evidenceId: string) =>
    (await c.prisma.uploadSession.findUniqueOrThrow({ where: { evidenceId } })).status;
  const settle = async (evidenceId: string) => {
    const { settleCompletedUploadSession } = await import("../src/services/reliability/upload-session.service.js");
    return settleCompletedUploadSession(evidenceId, c.prisma as never);
  };

  // ======================================================================
  // NEGATIVE
  // ======================================================================

  it("a generic request can never complete a session — from PRESIGNED, UPLOADING or VERIFYING", async () => {
    const { safeTransitionUploadSession, transitionUploadSession, UploadSessionTransitionError } = await import(
      "../src/services/reliability/upload-session.service.js"
    );
    for (const from of ["PRESIGNED", "UPLOADING", "VERIFYING"]) {
      const ev = await finalizedRecord();
      await session(ev.id, from);
      expect(await safeTransitionUploadSession({ evidenceId: ev.id, to: "COMPLETED" }, c.prisma as never), from).toBeNull();
      await expect(
        transitionUploadSession({ evidenceId: ev.id, to: "COMPLETED", strict: true }, c.prisma as never),
        from,
      ).rejects.toBeInstanceOf(UploadSessionTransitionError);
      expect(await statusOf(ev.id), from).toBe(from);
    }
  });

  it("a record that is not finalized cannot complete its session (PRESIGNED, UPLOADING)", async () => {
    for (const [from, recordStatus] of [["PRESIGNED", "CREATED"], ["UPLOADING", "UPLOADING"], ["UPLOADING", "UPLOADED"]] as const) {
      const ev = await finalizedRecord({ status: recordStatus });
      await session(ev.id, from);
      expect(await settle(ev.id)).toEqual({ outcome: "REFUSED", reason: "record_not_finalized" });
      expect(await statusOf(ev.id)).toBe(from);
    }
  });

  it("missing expected parts refuse completion", async () => {
    const ev = await finalizedRecord();
    await session(ev.id, "UPLOADING", { isMultipart: true, expectedPartCount: 3 });
    const { putObjectBuffer } = await import("../src/storage.js");
    for (const partIndex of [0, 1]) {
      const body = Buffer.from(`part-${partIndex}-${randomUUID()}`);
      const key = `guard/${randomUUID()}.part`;
      await putObjectBuffer({ bucket: bucket(), key, body, contentType: "application/octet-stream" });
      await c.prisma.evidencePart.create({
        data: {
          evidenceId: ev.id,
          partIndex,
          storageBucket: bucket(),
          storageKey: key,
          sizeBytes: BigInt(body.length),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      });
    }
    expect(await settle(ev.id)).toEqual({ outcome: "REFUSED", reason: "parts_incomplete" });
    expect(await statusOf(ev.id)).toBe("UPLOADING");
  });

  it("missing stored bytes refuse completion", async () => {
    const ev = await finalizedRecord({ store: false });
    await session(ev.id, "PRESIGNED");
    expect(await settle(ev.id)).toEqual({ outcome: "REFUSED", reason: "object_missing" });
    expect(await statusOf(ev.id)).toBe("PRESIGNED");
  });

  it("stored bytes of the wrong size refuse completion", async () => {
    const ev = await finalizedRecord({ bytes: Buffer.from("ten bytes!"), declaredSize: 99 });
    await session(ev.id, "UPLOADING");
    expect(await settle(ev.id)).toEqual({ outcome: "REFUSED", reason: "object_size_mismatch" });
    expect(await statusOf(ev.id)).toBe("UPLOADING");
  });

  it("a record that failed its integrity check, has no digest, or was deleted refuses completion", async () => {
    const failed = await finalizedRecord({ status: "FAILED_HASH_MISMATCH" });
    await session(failed.id, "UPLOADING");
    expect(await settle(failed.id)).toEqual({ outcome: "REFUSED", reason: "record_not_finalized" });

    const noDigest = await finalizedRecord();
    await tamperSealedEvidence(c.prisma, noDigest.id, { fileSha256: null });
    await session(noDigest.id, "UPLOADING");
    expect(await settle(noDigest.id)).toEqual({ outcome: "REFUSED", reason: "digest_missing" });

    const deleted = await finalizedRecord();
    await c.prisma.evidence.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await session(deleted.id, "PRESIGNED");
    expect(await settle(deleted.id)).toEqual({ outcome: "REFUSED", reason: "record_deleted" });

    for (const id of [failed.id, noDigest.id, deleted.id]) expect(await statusOf(id)).not.toBe("COMPLETED");
  });

  it("a terminal or held session is never promoted", async () => {
    for (const [from, reason] of [["ABANDONED", "session_terminal"], ["FAILED", "session_terminal"], ["REVIEW_REQUIRED", "session_held"]] as const) {
      const ev = await finalizedRecord();
      await session(ev.id, from);
      expect(await settle(ev.id), from).toEqual({ outcome: "REFUSED", reason });
      expect(await statusOf(ev.id), from).toBe(from);
    }
  });

  it("a record from another workspace cannot complete the session", async () => {
    const ev = await finalizedRecord({ team: otherTeamId });
    await session(ev.id, "UPLOADING", {}, teamId);
    expect(await settle(ev.id)).toEqual({ outcome: "REFUSED", reason: "record_not_in_session_workspace" });
    expect(await statusOf(ev.id)).toBe("UPLOADING");
  });

  it("no route can complete a session: the only COMPLETED writers are the guarded settlement", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          if (/TransitionUploadSession\(\s*\{[^}]*to:\s*"COMPLETED"/s.test(src)) offenders.push(p);
          if (/uploadSession\.update(Many)?\([\s\S]{0,300}?status:\s*"COMPLETED"/.test(src) && !p.endsWith("upload-session.service.ts")) {
            offenders.push(p);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  // ======================================================================
  // POSITIVE
  // ======================================================================

  it("a finalized record with its bytes closes its stranded live session; settling again is idempotent", async () => {
    for (const from of ["CREATED", "PRESIGNED", "UPLOADING", "PARTIAL", "STALLED", "VERIFYING"]) {
      const ev = await finalizedRecord();
      await session(ev.id, from);
      const first = await settle(ev.id);
      expect(first.outcome, from).toBe("COMPLETED");
      const row = await c.prisma.uploadSession.findUniqueOrThrow({ where: { evidenceId: ev.id } });
      expect(row.status, from).toBe("COMPLETED");
      expect(row.completedAtUtc, from).not.toBeNull();
      expect(await settle(ev.id), from).toEqual({ outcome: "ALREADY_COMPLETED" });
    }
  });

  it("concurrent settlement makes exactly one transition", async () => {
    const ev = await finalizedRecord();
    await session(ev.id, "UPLOADING");
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => settle(ev.id)));
    expect(outcomes.filter((o) => o.outcome === "COMPLETED")).toHaveLength(1);
    expect(outcomes.every((o) => o.outcome === "COMPLETED" || o.outcome === "ALREADY_COMPLETED")).toBe(true);
    expect(await statusOf(ev.id)).toBe("COMPLETED");
  });

  it("the reconciler settles finalized and deleted shadows truthfully, with no false stall", async () => {
    const ws = await makeWorkspace(c, owner.id, { name: "guard-recon", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const finalized = await finalizedRecord({ team: ws.teamId });
    await session(finalized.id, "PRESIGNED", {}, ws.teamId);
    const reported = await finalizedRecord({ team: ws.teamId, status: "REPORTED" });
    await session(reported.id, "UPLOADING", {}, ws.teamId);
    const deleted = await finalizedRecord({ team: ws.teamId });
    await c.prisma.evidence.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await session(deleted.id, "UPLOADING", {}, ws.teamId);
    // A finalized record whose bytes are gone: never completed, never "stalled".
    const lost = await finalizedRecord({ team: ws.teamId, store: false });
    await session(lost.id, "UPLOADING", {}, ws.teamId);

    const { reconcileUploads } = await import("../src/services/reliability/upload-reconciliation.service.js");
    await reconcileUploads({}, c.prisma as never);
    await reconcileUploads({}, c.prisma as never);
    await new Promise((r) => setTimeout(r, 200));

    expect(await statusOf(finalized.id)).toBe("COMPLETED");
    expect(await statusOf(reported.id)).toBe("COMPLETED");
    expect(await statusOf(deleted.id)).toBe("ABANDONED");
    expect(await statusOf(lost.id)).toBe("UPLOADING");
    expect(await c.prisma.operationalIncident.count({ where: { teamId: ws.teamId } })).toBe(0);
    expect(await c.prisma.securityEvent.count({ where: { teamId: ws.teamId, eventType: "upload_stalled" } })).toBe(0);
  });
});
