// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS DIAGNOSTICS STAY BEHIND THE PLATFORM BOUNDARY, AND A SIGNAL IS
 * FILED ONLY UNDER ITS OWN SOURCE (live PostgreSQL 16) — 2026-10-14.
 *
 * The reproduced row: a resolved workspace condition written by the old
 * security-event bridge — fingerprint `upload:security_event:upload_stalled`,
 * declared under `intake.delivery_failed`, carrying a job id, a runbook slug,
 * system prose with raw field names, and a person's resolution note. Proven:
 *
 *   1. Workspace Owners and Admins on PRO / TEAM / ENTERPRISE read it as
 *      history — one support reference, localized title and source, status,
 *      timestamps, the person's note exactly — and NO signal code, source key,
 *      job id, fingerprint, runbook or system prose anywhere in list, detail,
 *      groups or drill-down. No intake remediation.
 *   2. The platform admin route keeps the raw diagnostics.
 *   3. Another workspace gets 404.
 *   4. The write boundary refuses the legacy identity and a dedicated event
 *      through the bridge shape, normalizes a message/source mismatch, and a
 *      genuine upload stall and an upload-START failure stay distinct sources.
 *   6. `intake.delivery_failed` is the upload service failing to start or
 *      resume an upload (its id is historical): written by the real producer,
 *      it reads as that failure — never as an intake link that was not
 *      delivered — offers no intake-link action, and a genuine intake-link
 *      delivery failure files under communications.provider_failure instead.
 *   5. The `legacy_upload_session_source` rule: dry run writes nothing, apply
 *      corrects only the source, a second dry run reports zero, the note and
 *      status are untouched, nothing is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootOps, makeUser, makeWorkspace, addMember, personalSpace, seedEvidence, type Ctx } from "./operations-truth-fixtures.js";

const JOB_ID = "73f4ec87-6d39-46c7-aee4-ecf0b8c8a85b";
const NOTE = "Reviewed with the team on Tuesday — the uploads had completed; nothing to repair.";
const RAW = [
  "upload_stalled",
  "intake.delivery_failed",
  JOB_ID,
  "upload:security_event",
  "stuck-upload",
  "stalledThresholdMinutes",
  "previousStatus",
  "signalCode",
  "relatedJobId",
  "runbookSlug",
];

describe("operations diagnostics boundary (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  /** The reproduced row, exactly as the old bridge persisted it. */
  async function legacyRow(teamId: string) {
    const row = await c.prisma.operationalIncident.create({
      data: {
        teamId,
        scope: "WORKSPACE",
        sourceId: "intake.delivery_failed",
        category: "UPLOAD",
        severity: "WARNING",
        status: "RESOLVED",
        fingerprint: "upload:security_event:upload_stalled",
        title: "Security signal: upload_stalled",
        safeSummary: "Severity WARNING · team 6488cb98… · fields: stalledThresholdMinutes, previousStatus",
        messageCode: "ops.security.signal",
        messageParams: { eventType: "upload_stalled", severity: "WARNING", teamRef: "6488cb98", fields: "stalledThresholdMinutes, previousStatus" },
        occurrenceCount: 4,
        relatedJobId: JOB_ID,
        runbookSlug: "stuck-upload",
        resolutionNote: NOTE,
        resolvedAtUtc: new Date(),
        updatedAt: new Date(),
      } as never,
    });
    await c.prisma.operationalIncidentEvent.createMany({
      data: [
        { incidentId: row.id, eventType: "opened", safeMessage: "Security signal: upload_stalled — fields: stalledThresholdMinutes, previousStatus" },
        { incidentId: row.id, eventType: "increment", safeMessage: `job ${JOB_ID} upload_stalled` },
        { incidentId: row.id, eventType: "resolved", safeMessage: NOTE },
      ],
    });
    return row;
  }

  async function workspaceFor(plan: "PRO" | "TEAM" | "ENTERPRISE", tag: string) {
    const owner = await makeUser(c, `${tag}-owner`, { plan });
    const w = await makeWorkspace(c, owner.id, { name: `${tag}-ws`, billingPlan: plan, billingStatus: "ACTIVE" });
    const admin = await makeUser(c, `${tag}-admin`, { plan });
    await addMember(c, w.teamId, admin.id, "ADMIN");
    return { owner, admin, teamId: w.teamId };
  }

  async function readsWithoutDiagnostics(teamId: string, token: string, id: string) {
    const urls = [
      `/v1/ops/incidents?teamId=${teamId}&status=RESOLVED`,
      `/v1/ops/incidents?teamId=${teamId}&status=RESOLVED&q=upload`,
      `/v1/ops/incidents/${id}?teamId=${teamId}`,
      `/v1/ops/incident-groups?teamId=${teamId}&status=RESOLVED`,
      `/v1/ops/incident-groups/source:capture.legacy_upload_session_signal/affected?teamId=${teamId}&status=RESOLVED`,
    ];
    for (const url of urls) {
      const r = await c.inj("GET", url, token);
      // The drill-down may refuse a group it does not offer; it never leaks.
      if (url.includes("/affected") && r.statusCode !== 200) {
        expect([400, 404], url).toContain(r.statusCode);
      } else {
        expect(r.statusCode, url).toBe(200);
      }
      const text = r.body;
      for (const raw of RAW) expect(text, `${url} leaks ${raw}`).not.toContain(raw);
      expect(text, url).not.toMatch(/technicalReferences/);
    }
    const d = await c.inj("GET", `/v1/ops/incidents/${id}?teamId=${teamId}`, token);
    return d.json() as {
      incident: {
        title: string;
        status: string;
        supportReference: string;
        timeline: Array<{ eventType: string; safeMessage: string | null }>;
        lifecycle: { sourceId: string };
      };
      remediation: { actions: unknown[]; deepLink: unknown };
    };
  }

  it("1. Owner and Admin on PRO, TEAM and ENTERPRISE read history, never diagnostics", async () => {
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
      const w = await workspaceFor(plan, `diag-${plan.toLowerCase()}`);
      const row = await legacyRow(w.teamId);
      for (const who of [w.owner, w.admin]) {
        const body = await readsWithoutDiagnostics(w.teamId, who.token, row.id);
        expect(body.incident.title).toBe("Legacy upload-session signal");
        expect(body.incident.status).toBe("RESOLVED");
        expect(body.incident.supportReference).toBe(`OPS-${row.id.slice(0, 8).toUpperCase()}`);
        expect(body.incident.lifecycle.sourceId).toBe("capture.legacy_upload_session_signal");
        // The person's note, exactly; system prose is not shown.
        expect(body.incident.timeline.find((e) => e.eventType === "resolved")?.safeMessage).toBe(NOTE);
        for (const e of body.incident.timeline.filter((x) => x.eventType !== "resolved")) expect(e.safeMessage).toBeNull();
        // No intake remediation, nowhere to go.
        expect(body.remediation.actions).toEqual([]);
        expect(body.remediation.deepLink).toBeNull();
        expect(JSON.stringify(body)).not.toMatch(/intake-links/);
      }
    }
  });

  it("1b. the reproduced persona: a TEAM owner in their Personal Space", async () => {
    const owner = await makeUser(c, "diag-personal", { plan: "TEAM" });
    const teamId = await personalSpace(c, owner.id);
    const row = await legacyRow(teamId);
    const body = await readsWithoutDiagnostics(teamId, owner.token, row.id);
    expect(body.incident.title).toBe("Legacy upload-session signal");
    expect(body.incident.timeline.find((e) => e.eventType === "resolved")?.safeMessage).toBe(NOTE);
  });

  it("2. the platform admin route keeps the raw diagnostics", async () => {
    const w = await workspaceFor("TEAM", "diag-admin");
    const row = await legacyRow(w.teamId);
    const admin = await makeUser(c, "diag-platform", { platformRole: "admin" });
    const r = await c.inj("GET", `/v1/admin/incidents/${row.id}`, admin.token);
    expect(r.statusCode).toBe(200);
    const refs = (r.json() as { incident: { technicalReferences: Array<{ key: string; value: string }> } }).incident.technicalReferences;
    expect(refs).toContainEqual({ key: "signalCode", value: "upload_stalled" });
    expect(refs).toContainEqual({ key: "jobId", value: JOB_ID });
    // … and a workspace Owner cannot reach it.
    expect((await c.inj("GET", `/v1/admin/incidents/${row.id}`, w.owner.token)).statusCode).toBe(403);
  });

  it("3. another workspace gets 404", async () => {
    const a = await workspaceFor("TEAM", "diag-a");
    const b = await workspaceFor("TEAM", "diag-b");
    const row = await legacyRow(a.teamId);
    const r = await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${b.teamId}`, b.owner.token);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain(JOB_ID);
  });

  it("4. the write boundary refuses or normalizes incompatible pairs; a stall and a start failure stay distinct", async () => {
    const { recordIncident } = await import("../src/services/observability/incident.service.js");
    const w = await workspaceFor("TEAM", "diag-write");

    // The legacy identity is never written again, whatever source is declared.
    for (const sourceId of ["intake.delivery_failed", "capture.legacy_upload_session_signal"]) {
      await expect(
        recordIncident({ teamId: w.teamId, sourceId: sourceId as never, category: "UPLOAD", severity: "WARNING", fingerprint: "upload:security_event:upload_stalled", title: "x", safeSummary: "x" }, c.prisma as never),
      ).rejects.toMatchObject({ code: "SIGNAL_SOURCE_INCOMPATIBLE" });
    }
    // A ROUTINE event through the bridge shape is refused: it is never a tenant condition.
    await expect(
      recordIncident({ teamId: w.teamId, sourceId: "identity.security_condition" as never, category: "IDENTITY_SECURITY", severity: "WARNING", fingerprint: `auth:security_event:permission_denied`, title: "x", safeSummary: "x" }, c.prisma as never),
    ).rejects.toMatchObject({ code: "SIGNAL_SOURCE_INCOMPATIBLE" });

    // An upload-stall sentence declared under the intake source is filed under its own source.
    const ev = await seedEvidence(c, w.teamId, w.owner.id, { status: "UPLOADING", title: "Site survey.mp4" });
    const { incident: stall } = await recordIncident(
      {
        teamId: w.teamId,
        sourceId: "intake.delivery_failed" as never,
        category: "UPLOAD",
        severity: "WARNING",
        fingerprint: `upload_stalled:${ev.id}`,
        relatedEvidenceId: ev.id,
        message: { code: "ops.capture.upload_stalled", params: { recordTitle: "Site survey.mp4", recordRef: ev.id.slice(0, 8), minutes: 90 } },
      } as never,
      c.prisma as never,
    );
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: stall.id } })).sourceId).toBe("capture.upload_stalled");

    // The upload service failing to START an upload stays its own source
    // (historical id `intake.delivery_failed`), never an upload stall.
    const { incident: startFailure } = await recordIncident(
      {
        teamId: w.teamId,
        sourceId: "intake.delivery_failed" as never,
        category: "UPLOAD",
        severity: "WARNING",
        fingerprint: `upload:security_event:upload_session_create_failed`,
        title: "Uploads could not be started",
        safeSummary: "An upload could not be started.",
      } as never,
      c.prisma as never,
    );
    const startRow = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: startFailure.id } });
    expect(startRow.sourceId).toBe("intake.delivery_failed");
    expect(startRow.id).not.toBe(stall.id);
  });

  it("6. intake.delivery_failed is an upload-start/resume failure end to end; an intake-link delivery failure is not", async () => {
    const w = await workspaceFor("TEAM", "diag-upload-start");
    const { safeEmitSecurityEvent } = await import("../src/services/security/security-event.service.js");
    const settle = () => new Promise((r) => setTimeout(r, 400));

    // The REAL producers: the upload service failing to start, then to resume.
    for (const eventType of ["upload_session_create_failed", "upload_session_resume_failed"]) {
      safeEmitSecurityEvent({ teamId: w.teamId, eventType, severity: "WARNING", details: { reason: "storage_unavailable" } } as never);
    }
    await settle();
    const rows = await c.prisma.operationalIncident.findMany({ where: { teamId: w.teamId }, orderBy: { fingerprint: "asc" } });
    expect(rows.map((r) => [r.sourceId, r.fingerprint])).toEqual([
      ["intake.delivery_failed", "upload:security_event:upload_session_create_failed"],
      ["intake.delivery_failed", "upload:security_event:upload_session_resume_failed"],
    ]);

    const titles: Record<string, string> = {
      "upload:security_event:upload_session_create_failed": "An upload could not be started",
      "upload:security_event:upload_session_resume_failed": "An upload could not be resumed",
    };
    const INTAKE = /intake|invitation|resend|copy link|link could not|recipient|not delivered/i;
    for (const row of rows) {
      const d = await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${w.teamId}`, w.owner.token);
      expect(d.statusCode).toBe(200);
      const body = d.json() as {
        incident: { title: string; safeSummary: string; message: { code: string; params: Record<string, unknown> } };
        remediation: { disposition: string; actions: unknown[]; deepLink: unknown; guidance: string };
      };
      expect(body.incident.title).toBe(titles[row.fingerprint]);
      expect(body.incident.message.code).toBe("ops.security.signal");
      expect(body.incident.safeSummary).toMatch(/^The upload service failed while (starting|resuming)/);
      // Guidance only: nothing to press, nowhere to go.
      expect(body.remediation.disposition).toBe("READ_ONLY_GUIDANCE");
      expect(body.remediation.actions).toEqual([]);
      expect(body.remediation.deepLink).toBeNull();
      expect(body.remediation.guidance).toMatch(/^The upload service failed while starting or resuming an upload/);
      // No customer-facing word of an intake link, and no intake route.
      const words = [body.incident.title, body.incident.safeSummary, body.remediation.guidance].join(" ");
      expect(words).not.toMatch(INTAKE);
      expect(d.body).not.toMatch(/\/intake-links|intakeLink/);
    }
    // The grouped view names the source by its upload-specific label.
    const g = await c.inj("GET", `/v1/ops/incident-groups?teamId=${w.teamId}`, w.owner.token);
    expect(g.statusCode).toBe(200);
    expect(g.body).not.toMatch(/\/intake-links|Intake link/i);

    // A GENUINE intake-link delivery failure: the messaging provider failed to
    // deliver the link. It is a communications condition, never this source.
    safeEmitSecurityEvent({ teamId: w.teamId, eventType: "communication_message_failed", severity: "WARNING", details: { purpose: "INTAKE_LINK", channel: "EMAIL", reason: "provider_rejected", attempt: 1, retry: false } } as never);
    await settle();
    const delivery = await c.prisma.operationalIncident.findFirstOrThrow({ where: { teamId: w.teamId, fingerprint: { endsWith: ":security_event:communication_message_failed" } } });
    expect(delivery.sourceId).toBe("communications.provider_failure");
    expect(await c.prisma.operationalIncident.count({ where: { teamId: w.teamId, sourceId: "intake.delivery_failed" } })).toBe(2);
  });

  it("5. the legacy_upload_session_source rule: dry run, apply, zero on a second dry run, note untouched", async () => {
    const w = await workspaceFor("TEAM", "diag-recon");
    const row = await legacyRow(w.teamId);
    const before = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } });
    const eventsBefore = await c.prisma.operationalIncidentEvent.count({ where: { incidentId: row.id } });
    const { reconcileOperationsTruth } = await import("../src/services/operations/operations-truth-reconciliation.service.js");
    const rule = { teamId: w.teamId, rules: ["legacy_upload_session_source"] } as const;

    const dry = await reconcileOperationsTruth({ apply: false, ...rule } as never, c.prisma as never);
    expect(dry.rules.legacy_upload_session_source).toMatchObject({ matched: 1, changed: 1 });
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } })).sourceId).toBe("intake.delivery_failed");

    const applied = await reconcileOperationsTruth({ apply: true, ...rule } as never, c.prisma as never);
    expect(applied.rules.legacy_upload_session_source).toMatchObject({ matched: 1, changed: 1 });
    const after = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.sourceId).toBe("capture.legacy_upload_session_signal");
    expect(after.status).toBe("RESOLVED");
    expect(after.resolutionNote).toBe(NOTE);
    expect(after.resolvedAtUtc?.toISOString()).toBe(before.resolvedAtUtc?.toISOString());
    expect(after.occurrenceCount).toBe(4);
    expect(after.fingerprint).toBe(before.fingerprint);
    // One appended event; nothing deleted or rewritten.
    const events = await c.prisma.operationalIncidentEvent.findMany({ where: { incidentId: row.id }, orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.find((e) => e.eventType === "resolved")?.safeMessage).toBe(NOTE);
    expect(events.at(-1)!.eventType).toBe("source_corrected_by_reconciliation");

    const second = await reconcileOperationsTruth({ apply: false, ...rule } as never, c.prisma as never);
    expect(second.rules.legacy_upload_session_source).toMatchObject({ matched: 0, changed: 0 });

    // Still reads the same to the workspace afterwards.
    const body = await readsWithoutDiagnostics(w.teamId, w.owner.token, row.id);
    expect(body.incident.title).toBe("Legacy upload-session signal");
    expect(body.incident.timeline.find((e) => e.eventType === "resolved")?.safeMessage).toBe(NOTE);
  });
});
