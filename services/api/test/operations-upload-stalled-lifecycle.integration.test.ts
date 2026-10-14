// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * UPLOAD STALLED — THE PRODUCTION REPRODUCTION AND THE TRUTHFUL LIFECYCLE
 * (live PostgreSQL 16).
 *
 * The production condition "Security signal: upload_stalled" (Intake delivery
 * failed, 4 occurrences in one tick, no subject) was four upload-session
 * shadows behind records that had already finalized, swept as stalled the
 * first time the reconciler ran, and filed by the security bridge as ONE
 * workspace-wide intake condition. Proven here:
 *
 *   1. The exact production shape — four stale shadows behind finalized
 *      records — settles the shadows and writes NO condition, no intake row.
 *   2. A shadow behind a deleted record is closed as abandoned, silently.
 *   3. A genuine stall is ONE condition per upload, "Upload appears stalled",
 *      about that record; repeated sweeps and repeated identical
 *      observations add no occurrence; concurrent sweeps write one row.
 *   4. The probe reads it ACTIVE while stalled, RECOVERED once the record
 *      finalizes, and the source-truth sweep closes it with a recorded reason.
 *   5. A live stall cannot be closed by hand (the source owns it); once it
 *      recovers, later sweeps of the same occurrence change nothing; a NEW
 *      stall of the same upload reopens it exactly once. A resolution note is
 *      trimmed and bounded, and a blank note is no note.
 *   6. The API presents it humanly: title, subject (confirmed for this
 *      workspace), no raw code outside Technical references, no Intake Links.
 *      A subject outside the workspace reads as unavailable and is not linked.
 *   7. The existing-data reconciliation closes the legacy workspace-wide row
 *      (dry run writes nothing; a rerun is a no-op) and carries a still-live
 *      stall over to its own per-upload condition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootOps, makeUser, makeWorkspace, seedEvidence, seedIncident, type Ctx } from "./operations-truth-fixtures.js";

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000);

describe("upload stalled — production reproduction and lifecycle (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  const recon = async () => {
    const { reconcileUploads } = await import("../src/services/reliability/upload-reconciliation.service.js");
    const s = await reconcileUploads({}, c.prisma as never);
    await settle();
    return s;
  };

  async function workspace(tag: string) {
    const owner = await makeUser(c, `${tag}-owner`, { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: `${tag}-ws`, billingPlan: "TEAM", billingStatus: "ACTIVE" });
    return { owner, ...w };
  }

  async function shadow(teamId: string, ownerId: string, evidence: Record<string, unknown>, session: Record<string, unknown>) {
    const ev = await seedEvidence(c, teamId, ownerId, evidence);
    await c.prisma.uploadSession.create({
      data: { evidenceId: ev.id, teamId, status: "UPLOADING", lastActivityAtUtc: HOURS_AGO(3), ...session } as never,
    });
    return ev;
  }

  const conditionsIn = (teamId: string) =>
    c.prisma.operationalIncident.findMany({ where: { teamId }, orderBy: { createdAt: "asc" } });

  it("1. the exact production shape: four shadows behind finalized records settle and write nothing", async () => {
    const w = await workspace("prod-shape");
    const evs = [];
    for (const [i, status] of (["PRESIGNED", "UPLOADING", "UPLOADING", "PRESIGNED"] as const).entries()) {
      evs.push(
        await shadow(w.teamId, w.owner.id, { status: i === 3 ? "REPORTED" : "SIGNED", title: `Finalized ${i}` }, { status }),
      );
    }
    const s = await recon();
    expect(s.settledSuperseded).toBeGreaterThanOrEqual(4);

    const sessions = await c.prisma.uploadSession.findMany({ where: { teamId: w.teamId } });
    expect(sessions.map((x) => x.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(await conditionsIn(w.teamId)).toEqual([]);
    expect(await c.prisma.securityEvent.count({ where: { teamId: w.teamId, eventType: "upload_stalled" } })).toBe(0);

    // A later tick finds nothing either.
    await recon();
    expect(await conditionsIn(w.teamId)).toEqual([]);
  });

  it("2. a shadow behind a deleted record is closed as abandoned, silently", async () => {
    const w = await workspace("deleted");
    await shadow(w.teamId, w.owner.id, { status: "UPLOADING", deletedAt: new Date() }, { status: "PRESIGNED" });
    await recon();
    const [session] = await c.prisma.uploadSession.findMany({ where: { teamId: w.teamId } });
    expect(session!.status).toBe("ABANDONED");
    expect(await conditionsIn(w.teamId)).toEqual([]);
  });

  it("3. a genuine stall is one condition per upload; repeated checks add no occurrence", async () => {
    const w = await workspace("genuine");
    const a = await shadow(w.teamId, w.owner.id, { status: "UPLOADING", title: "Site survey.mp4" }, { status: "UPLOADING" });
    const b = await shadow(w.teamId, w.owner.id, { status: "CREATED", title: "Floor plan" }, { status: "PRESIGNED" });
    const s = await recon();
    expect(s.markedStalled).toBeGreaterThanOrEqual(2);

    const rows = await conditionsIn(w.teamId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sourceId).toBe("capture.upload_stalled");
      expect(row.occurrenceCount).toBe(1);
      expect(row.status).toBe("OPEN");
      expect(row.messageCode).toBe("ops.capture.upload_stalled");
      expect(row.title).toBe("Upload appears stalled");
    }
    expect(rows.map((r) => r.relatedEvidenceId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.map((r) => r.fingerprint).sort()).toEqual([`upload_stalled:${a.id}`, `upload_stalled:${b.id}`].sort());
    // No workspace-wide intake row, ever.
    expect(rows.some((r) => r.sourceId === "intake.delivery_failed" || r.fingerprint.includes(":security_event:"))).toBe(false);
    // The security log keeps its audit entry per upload.
    expect(await c.prisma.securityEvent.count({ where: { teamId: w.teamId, eventType: "upload_stalled" } })).toBe(2);

    // Four further sweeps: the stalled session is not reselected.
    for (let i = 0; i < 4; i += 1) await recon();
    // Four identical observations of the same live state are not four increments.
    const { recordUploadStalledCondition } = await import("../src/services/reliability/upload-reconciliation.service.js");
    for (let i = 0; i < 4; i += 1) {
      await recordUploadStalledCondition(
        { teamId: w.teamId, evidenceId: a.id, recordTitle: "Site survey.mp4", minutes: 30, previousStatus: "UPLOADING", stalledAtUtc: new Date() },
        c.prisma as never,
      );
    }
    const after = await conditionsIn(w.teamId);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.occurrenceCount)).toEqual([1, 1]);
    const events = await c.prisma.operationalIncidentEvent.count({
      where: { incidentId: { in: after.map((r) => r.id) }, eventType: { in: ["incremented", "increment", "INCREMENTED"] } },
    });
    expect(events).toBe(0);
  });

  it("3b. concurrent sweeps of the same stall write one row with one occurrence", async () => {
    const w = await workspace("concurrent");
    await shadow(w.teamId, w.owner.id, { status: "UPLOADING" }, { status: "UPLOADING" });
    await Promise.all([recon(), recon(), recon()]);
    const rows = await conditionsIn(w.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(1);
  });

  it("4. the probe and the source-truth sweep agree; recovery records its reason", async () => {
    const w = await workspace("probe");
    const ev = await shadow(w.teamId, w.owner.id, { status: "UPLOADING" }, { status: "UPLOADING" });
    await recon();
    const [row] = await conditionsIn(w.teamId);
    const { probeConditionActivity } = await import("../src/services/observability/incident.service.js");
    const probe = () =>
      probeConditionActivity(
        { sourceId: row!.sourceId, category: row!.category, fingerprint: row!.fingerprint, teamId: w.teamId },
        c.prisma as never,
      );
    expect(await probe()).toBe("ACTIVE");

    // The record finalizes.
    await c.prisma.evidence.update({ where: { id: ev.id }, data: { status: "SIGNED" } });
    expect(await probe()).toBe("RECOVERED");

    const { sweepSourceTruthRecoveries } = await import("../src/services/operations/source-truth-recovery.service.js");
    await sweepSourceTruthRecoveries({ teamId: w.teamId, sourceId: "capture.upload_stalled" }, c.prisma as never);
    const closed = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolvedByUserId).toBeNull();
    const recovery = await c.prisma.operationalIncidentEvent.findFirst({
      where: { incidentId: row!.id },
      orderBy: { createdAt: "desc" },
    });
    expect(recovery?.safeMessage ?? "").not.toBe("");

    // …and the next sweep settles the shadow instead of re-stalling it.
    await recon();
    const session = await c.prisma.uploadSession.findUniqueOrThrow({ where: { evidenceId: ev.id } });
    expect(session.status).toBe("COMPLETED");
  });

  it("5. a live stall cannot be closed by hand; its recovery holds; a new stall reopens exactly once", async () => {
    const w = await workspace("reopen");
    const ev = await shadow(w.teamId, w.owner.id, { status: "UPLOADING" }, { status: "UPLOADING" });
    await recon();
    const [row] = await conditionsIn(w.teamId);

    // The source owns this resolution: while the upload is still stalled a
    // manual close is refused before any write.
    const refused = await c.inj("POST", `/v1/ops/incidents/${row!.id}/resolve`, w.owner.token, {
      teamId: w.teamId,
      resolutionNote: "Looks fine.",
    });
    expect(refused.statusCode).toBe(409);
    const untouched = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(untouched.status).toBe("OPEN");
    expect(untouched.resolutionNote).toBeNull();

    // The upload resumes: the probe reads RECOVERED and the sweep closes it.
    const { safeTransitionUploadSession } = await import("../src/services/reliability/upload-session.service.js");
    await safeTransitionUploadSession({ evidenceId: ev.id, to: "UPLOADING", reason: "resumed" }, c.prisma as never);
    const { sweepSourceTruthRecoveries } = await import("../src/services/operations/source-truth-recovery.service.js");
    await sweepSourceTruthRecoveries({ teamId: w.teamId, sourceId: "capture.upload_stalled" }, c.prisma as never);
    const recovered = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(recovered.status).toBe("RESOLVED");
    expect(recovered.occurrenceCount).toBe(1);

    // The same (recovered) occurrence is never counted again: further sweeps
    // of a live upload change nothing.
    for (let i = 0; i < 3; i += 1) {
      await recon();
      await sweepSourceTruthRecoveries({ teamId: w.teamId, sourceId: "capture.upload_stalled" }, c.prisma as never);
    }
    const still = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(still.status).toBe("RESOLVED");
    expect(still.occurrenceCount).toBe(1);

    // It stalls again: a new occurrence reopens the same condition…
    await c.prisma.uploadSession.update({ where: { evidenceId: ev.id }, data: { lastActivityAtUtc: HOURS_AGO(3) } });
    await recon();
    const reopened = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.occurrenceCount).toBe(2);
    expect(reopened.resolvedAtUtc).toBeNull();

    // …once.
    for (let i = 0; i < 3; i += 1) await recon();
    const once = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(once.occurrenceCount).toBe(2);
    const reopens = await c.prisma.operationalIncidentEvent.count({
      where: { incidentId: row!.id, eventType: { contains: "reopen" } },
    });
    expect(reopens).toBe(1);
    expect(await conditionsIn(w.teamId)).toHaveLength(1);
  });

  it("5b. a resolution note is trimmed and bounded; a blank note is no note", async () => {
    const w = await workspace("note");
    const a = await seedIncident(c, w.teamId, { sourceId: "governance.notification_escalated" });
    const b = await seedIncident(c, w.teamId, { sourceId: "governance.notification_escalated" });
    const tooLong = await c.inj("POST", `/v1/ops/incidents/${a.id}/resolve`, w.owner.token, {
      teamId: w.teamId,
      resolutionNote: "x".repeat(401),
    });
    expect(tooLong.statusCode).toBe(400);
    // This source requires a conclusion; whitespace is not one.
    const blank = await c.inj("POST", `/v1/ops/incidents/${b.id}/resolve`, w.owner.token, {
      teamId: w.teamId,
      resolutionNote: "    ",
    });
    expect(blank.statusCode).toBe(409);
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("OPEN");
    const ok = await c.inj("POST", `/v1/ops/incidents/${b.id}/resolve`, w.owner.token, {
      teamId: w.teamId,
      resolutionNote: "   The notice was answered by the records team.   ",
    });
    expect(ok.statusCode).toBe(200);
    const closed = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: b.id } });
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolutionNote).toBe("The notice was answered by the records team.");
  });

  it("6. the API presents the condition humanly and confirms its subject for this workspace", async () => {
    const w = await workspace("present");
    const ev = await shadow(w.teamId, w.owner.id, { status: "UPLOADING", title: "Site survey.mp4" }, { status: "UPLOADING" });
    await recon();
    const [row] = await conditionsIn(w.teamId);

    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${w.teamId}`, w.owner.token);
    expect(list.statusCode).toBe(200);
    const item = (list.json() as { incidents: Array<Record<string, unknown>> }).incidents.find((i) => i.id === row!.id)!;
    expect(item.title).toBe("Upload appears stalled");
    expect(String(item.safeSummary)).toContain("Site survey.mp4");
    expect(JSON.stringify([item.title, item.safeSummary])).not.toMatch(/upload_stalled|Security signal|fields:/);
    expect(item.subject).toMatchObject({ kind: "UPLOAD", name: "Site survey.mp4", state: "AVAILABLE" });

    const detail = await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${w.teamId}`, w.owner.token);
    expect(detail.statusCode).toBe(200);
    const full = detail.json() as { incident: unknown };
    const body = full.incident as Record<string, unknown> & {
      technicalReferences: Array<{ key: string; value: string }>;
      remediation?: { actions?: Array<{ deepLink?: { href: string } | null }> } | Array<unknown>;
    };
    expect(body.technicalReferences).toContainEqual({ key: "signalCode", value: "upload_stalled" });
    const bodyText = JSON.stringify(full);
    expect(bodyText).not.toMatch(/intake-links/);
    expect(bodyText).toContain(`/evidence/${ev.id}`);

    // A subject outside this workspace is never named and never linked.
    const other = await workspace("present-other");
    const foreign = await seedEvidence(c, other.teamId, other.owner.id, { status: "UPLOADING", title: "Other workspace secret" });
    const planted = await seedIncident(c, w.teamId, {
      sourceId: "capture.upload_stalled",
      category: "UPLOAD",
      severity: "WARNING",
      fingerprint: `upload_stalled:${foreign.id}`,
      relatedEvidenceId: foreign.id,
    });
    const pd = await c.inj("GET", `/v1/ops/incidents/${planted.id}?teamId=${w.teamId}`, w.owner.token);
    expect(pd.statusCode).toBe(200);
    const pdText = JSON.stringify(pd.json());
    expect(pdText).not.toContain("Other workspace secret");
    expect((pd.json() as { incident: { subject: { state: string } } }).incident.subject.state).toBe("UNAVAILABLE");
    expect(pdText).not.toContain(`/evidence/${foreign.id}`);
  });

  it("6b. the legacy production row reads truthfully through the API", async () => {
    const w = await workspace("legacy-read");
    const legacy = await seedIncident(c, w.teamId, {
      sourceId: "intake.delivery_failed",
      category: "UPLOAD",
      severity: "WARNING",
      status: "RESOLVED",
      fingerprint: "upload:security_event:upload_stalled",
      title: "Security signal: upload_stalled",
      safeSummary: "Severity WARNING · team 6488cb98… · fields: stalledThresholdMinutes, previousStatus",
      occurrenceCount: 4,
    });
    const d = await c.inj("GET", `/v1/ops/incidents/${legacy.id}?teamId=${w.teamId}`, w.owner.token);
    expect(d.statusCode).toBe(200);
    const body = (d.json() as { incident: unknown }).incident as {
      title: string;
      safeSummary: string;
      subject: { kind: string };
      technicalReferences: Array<{ key: string; value: string }>;
    };
    expect(body.title).toBe("Upload appears stalled");
    expect(body.safeSummary).not.toMatch(/fields:|team 6488|upload_stalled/);
    expect(body.subject.kind).toBe("UPLOADS");
    expect(body.technicalReferences).toContainEqual({ key: "signalCode", value: "upload_stalled" });
    expect(JSON.stringify(d.json())).not.toMatch(/intake-links|Open intake links/);
  });

  it("7. the existing-data reconciliation closes the legacy row and carries a live stall over, once", async () => {
    const w = await workspace("legacy-fix");
    const legacy = await seedIncident(c, w.teamId, {
      sourceId: "intake.delivery_failed",
      category: "UPLOAD",
      severity: "WARNING",
      status: "OPEN",
      fingerprint: "upload:security_event:upload_stalled",
      title: "Security signal: upload_stalled",
      occurrenceCount: 4,
    });
    // One upload is genuinely still stalled (its session was swept before the fix).
    const live = await shadow(w.teamId, w.owner.id, { status: "UPLOADING", title: "Still stalled" }, { status: "STALLED", stalledAtUtc: HOURS_AGO(2) });

    const { reconcileOperationsTruth } = await import("../src/services/operations/operations-truth-reconciliation.service.js");
    const dry = await reconcileOperationsTruth({ apply: false, teamId: w.teamId, rules: ["legacy_upload_stalled_rows"] }, c.prisma as never);
    expect(dry.rules.legacy_upload_stalled_rows.changed).toBe(1);
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("OPEN");
    expect(await conditionsIn(w.teamId)).toHaveLength(1);

    const applied = await reconcileOperationsTruth({ apply: true, teamId: w.teamId, rules: ["legacy_upload_stalled_rows"] }, c.prisma as never);
    expect(applied.rules.legacy_upload_stalled_rows.detail).toMatchObject({ carriedOver: 1 });
    const closed = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolutionNote).toMatch(/named no upload/);
    expect(closed.resolutionNote).not.toMatch(/repaired|fixed/i);
    // History is kept.
    expect(closed.occurrenceCount).toBe(4);
    const perUpload = await c.prisma.operationalIncident.findMany({ where: { teamId: w.teamId, sourceId: "capture.upload_stalled" } });
    expect(perUpload).toHaveLength(1);
    expect(perUpload[0]!.relatedEvidenceId).toBe(live.id);

    const again = await reconcileOperationsTruth({ apply: true, teamId: w.teamId, rules: ["legacy_upload_stalled_rows"] }, c.prisma as never);
    expect(again.rules.legacy_upload_stalled_rows.changed).toBe(0);
    expect(await conditionsIn(w.teamId)).toHaveLength(2);
  });
});
