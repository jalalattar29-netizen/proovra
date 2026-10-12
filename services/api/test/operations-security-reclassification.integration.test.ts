// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPS-13 PHASE 3 — SECURITY-EVENT RECLASSIFICATION, END TO END (live PostgreSQL).
 *
 *   1. An outsider's REFUSED switch into another workspace answers 403 and
 *      writes NO condition in the target workspace (the audit's reproduction);
 *      the security-log entry is bound to the actor, not the target.
 *   2. The read-only export-eligibility preflight writes no condition.
 *   3. An unrecognised WARNING event writes the security log and no tenant row.
 *   4. A webhook destination auto-disable opens the per-destination
 *      `integration.webhook_destination_disabled` condition; the probe reads
 *      ACTIVE; re-enabling resets the counters and closes it; the probe and
 *      the source-truth sweep agree.
 *   5. Revoking an SSO connection clears its outage and closes the IdP-outage
 *      condition; the probe answers NOT_APPLICABLE for a revoked connection.
 *   6. The existing-data reconciliation: dry-run writes nothing; apply closes
 *      only the proven rows (with a note and an audit event); a second apply
 *      is a no-op; a --team bound outside the rows touches nothing.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootOps,
  makeUser,
  makeWorkspace,
  seedEvidence,
  seedIncident,
  type Ctx,
} from "./operations-truth-fixtures.js";

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe("OPS-13 security reclassification (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("1. an outsider's denied switch into a workspace writes no condition there", async () => {
    const owner = await makeUser(c, "target-owner", { plan: "PRO" });
    const target = await makeWorkspace(c, owner.id, { name: "target-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const outsider = await makeUser(c, "outsider", { plan: "PRO" });

    const r = await c.inj("POST", "/v1/platform/context/switch-workspace", outsider.token, {
      workspaceId: target.teamId,
    });
    expect(r.statusCode).toBe(403);
    await settle();

    expect(await c.prisma.operationalIncident.count({ where: { teamId: target.teamId } })).toBe(0);
    // The refusal is in the security log — of the actor, never the target.
    const ev = await c.prisma.securityEvent.findFirst({
      where: { eventType: "workspace_context_switched", details: { path: ["actorUserId"], equals: outsider.id } },
      orderBy: { createdAt: "desc" },
    });
    expect(ev).not.toBeNull();
    expect(ev!.teamId).not.toBe(target.teamId);
    expect(await c.prisma.securityEvent.count({ where: { teamId: target.teamId, eventType: "workspace_context_switched" } })).toBe(0);
  });

  it("2. the export-eligibility preflight answers BLOCKED and writes no condition", async () => {
    const owner = await makeUser(c, "preflight-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "preflight-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const ev = await seedEvidence(c, w.teamId, owner.id, { deletedAt: new Date() });
    const r = await c.inj(
      "GET",
      `/v1/governance/export-eligibility?teamId=${w.teamId}&evidenceId=${ev.id}`,
      owner.token,
    );
    expect(r.statusCode).toBe(200);
    expect((r.json() as { outcome: string }).outcome).toBe("BLOCKED_BY_LIFECYCLE");
    await settle();
    expect(await c.prisma.operationalIncident.count({ where: { teamId: w.teamId } })).toBe(0);
    // Recorded at INFO: a question was asked, nothing was attempted.
    const se = await c.prisma.securityEvent.findFirst({
      where: { teamId: w.teamId, eventType: "export_blocked_by_lifecycle" },
    });
    expect(se?.severity).toBe("INFO");
  });

  it("3. an unrecognised WARNING event writes the security log and no tenant row", async () => {
    const owner = await makeUser(c, "unknown-owner");
    const w = await makeWorkspace(c, owner.id, { name: "unknown-ws" });
    const { safeEmitSecurityEvent } = await import("../src/services/security/security-event.service.js");
    safeEmitSecurityEvent({ teamId: w.teamId, eventType: "session_inventory_viewed", severity: "WARNING" });
    safeEmitSecurityEvent({ teamId: w.teamId, eventType: "destruction_blocked_by_hold", severity: "WARNING" });
    await settle();
    expect(await c.prisma.securityEvent.count({ where: { teamId: w.teamId } })).toBe(2);
    expect(await c.prisma.operationalIncident.count({ where: { teamId: w.teamId } })).toBe(0);
  });

  it("4. webhook auto-disable opens the per-destination condition; re-enable resets and resolves it", async () => {
    const owner = await makeUser(c, "hook-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "hook-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const mk = (n: string) =>
      c.prisma.automationWebhookDestination.create({
        data: {
          teamId: w.teamId,
          name: n,
          url: `https://${n}.example/hook`,
          urlOrigin: `https://${n}.example`,
          encryptedSecret: randomBytes(16).toString("hex"),
          secretFingerprint: "fp-test",
          enabled: true,
          createdByUserId: owner.id,
          updatedByUserId: owner.id,
          consecutiveFailureCount: 9,
        },
      });
    const d1 = await mk("one");
    const d2 = await mk("two");
    const { markDestinationFailure, webhookDestinationDisabledFingerprint } = await import(
      "../src/services/automation/automation-delivery-runtime.service.js"
    );
    await markDestinationFailure(c.prisma, d1.id, "http_500", Date.now());
    await markDestinationFailure(c.prisma, d2.id, "http_500", Date.now());
    await settle();

    const rows = await c.prisma.operationalIncident.findMany({
      where: { teamId: w.teamId, sourceId: "integration.webhook_destination_disabled" },
      orderBy: { fingerprint: "asc" },
    });
    // ONE condition PER DESTINATION, not one per event type.
    expect(rows.map((r) => r.fingerprint).sort()).toEqual(
      [webhookDestinationDisabledFingerprint(d1.id), webhookDestinationDisabledFingerprint(d2.id)].sort(),
    );
    expect(rows.every((r) => r.status === "OPEN")).toBe(true);
    // …and no generic unclassified row beside them.
    expect(
      await c.prisma.operationalIncident.count({ where: { teamId: w.teamId, sourceId: "security.unclassified_signal" } }),
    ).toBe(0);

    const { probeConditionActivity } = await import("../src/services/observability/incident.service.js");
    const probe = (id: string) =>
      probeConditionActivity(
        {
          sourceId: "integration.webhook_destination_disabled",
          category: "INTEGRATION",
          fingerprint: webhookDestinationDisabledFingerprint(id),
          teamId: w.teamId,
        },
        c.prisma,
      );
    expect(await probe(d1.id)).toBe("ACTIVE");

    // Re-enable through the route: the counters reset and the condition closes.
    const r = await c.inj("POST", `/v1/automation/webhooks/${d1.id}/enable`, owner.token);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { enabled: boolean; autoDisabledAt: string | null; disabledReason: string | null; consecutiveFailureCount: number };
    expect(body).toMatchObject({ enabled: true, autoDisabledAt: null, disabledReason: null, consecutiveFailureCount: 0 });
    const after = await c.prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: d1.id } });
    expect(after.consecutiveFailureCount).toBe(0);
    expect(after.autoDisabledAt).toBeNull();
    expect(await probe(d1.id)).toBe("RECOVERED");
    const closed = await c.prisma.operationalIncident.findFirstOrThrow({
      where: { teamId: w.teamId, fingerprint: webhookDestinationDisabledFingerprint(d1.id) },
    });
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolvedByUserId).toBeNull();

    // The second destination recovers by its ROW alone: the source-truth sweep
    // reads the probe and closes it — no route involved.
    await c.prisma.automationWebhookDestination.update({
      where: { id: d2.id },
      data: { enabled: true, autoDisabledAt: null, disabledReason: null, consecutiveFailureCount: 0 },
    });
    const { sweepSourceTruthRecoveries } = await import("../src/services/operations/source-truth-recovery.service.js");
    const sweep = await sweepSourceTruthRecoveries(
      { teamId: w.teamId, sourceId: "integration.webhook_destination_disabled" },
      c.prisma,
    );
    expect(sweep.resolved).toBe(1);

    // A destination that is gone answers NOT_APPLICABLE.
    expect(
      await probeConditionActivity(
        {
          sourceId: "integration.webhook_destination_disabled",
          category: "INTEGRATION",
          fingerprint: webhookDestinationDisabledFingerprint("99999999-9999-4999-8999-999999999999"),
          teamId: w.teamId,
        },
        c.prisma,
      ),
    ).toBe("NOT_APPLICABLE");
  });

  it("5. revoking an SSO connection clears its outage and closes the IdP-outage condition", async () => {
    const owner = await makeUser(c, "sso-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "sso-ws", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const conn = await c.prisma.ssoConnection.create({
      data: {
        teamId: w.teamId,
        provider: "GENERIC_OIDC",
        displayName: "IdP",
        status: "ACTIVE",
        createdByUserId: owner.id,
        allowedEmailDomains: [],
        consecutiveFailureCount: 7,
        outageDetectedAtUtc: new Date(),
      },
    });
    const fingerprint = `idp-outage:${conn.id}`;
    await seedIncident(c, w.teamId, { sourceId: "identity.idp_outage", category: "IDENTITY_SECURITY", fingerprint });
    const { probeConditionActivity } = await import("../src/services/observability/incident.service.js");
    const probe = () =>
      probeConditionActivity(
        { sourceId: "identity.idp_outage", category: "IDENTITY_SECURITY", fingerprint, teamId: w.teamId },
        c.prisma,
      );
    expect(await probe()).toBe("ACTIVE");

    const { transitionSsoConnection } = await import("../src/services/access-control/sso.service.js");
    await transitionSsoConnection(
      { teamId: w.teamId, id: conn.id, nextStatus: "REVOKED", actorUserId: owner.id },
      c.prisma,
    );
    const after = await c.prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.outageDetectedAtUtc).toBeNull();
    expect(after.consecutiveFailureCount).toBe(0);
    expect(await probe()).toBe("NOT_APPLICABLE");
    const row = await c.prisma.operationalIncident.findFirstOrThrow({ where: { teamId: w.teamId, fingerprint } });
    expect(row.status).toBe("RESOLVED");
  });

  it("6. reconciliation: dry-run writes nothing; apply closes only proven rows; second apply is a no-op", async () => {
    const owner = await makeUser(c, "recon3-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "recon3-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const outsider = await makeUser(c, "recon3-outsider");
    const unc = (type: string) =>
      seedIncident(c, w.teamId, {
        sourceId: "security.unclassified_signal",
        category: "WORKER",
        fingerprint: `worker:security_event:${type}`,
      });

    // (1) reclassified event types; one written by an outsider's denied switch.
    const routine = await unc("export_blocked_by_lifecycle");
    const deniedSwitch = await unc("workspace_context_switched");
    await c.prisma.securityEvent.create({
      data: {
        teamId: w.teamId,
        eventType: "workspace_context_switched",
        severity: "WARNING",
        details: { actorUserId: outsider.id, result: "denied", reason: "workspace_membership_required" },
      },
    });
    const dedicated = await unc("automation_webhook_destination_auto_disabled");
    const stillUnknown = await unc("session_inventory_viewed");
    // A legacy row with no source id, same fingerprint family.
    const legacyNull = await seedIncident(c, w.teamId, {
      sourceId: null,
      category: "WORKER",
      fingerprint: "worker:security_event:multipart_complete_failed",
    });

    // (2) IdP outages: revoked connection (closed) vs. live outage (left).
    const revoked = await c.prisma.ssoConnection.create({
      data: { teamId: w.teamId, provider: "OKTA", displayName: "old", status: "REVOKED", createdByUserId: owner.id, allowedEmailDomains: [], outageDetectedAtUtc: new Date() },
    });
    const live = await c.prisma.ssoConnection.create({
      data: { teamId: w.teamId, provider: "GENERIC_OIDC", displayName: "live", status: "ACTIVE", createdByUserId: owner.id, allowedEmailDomains: [], outageDetectedAtUtc: new Date() },
    });
    const staleIdp = await seedIncident(c, w.teamId, { sourceId: "identity.idp_outage", category: "IDENTITY_SECURITY", fingerprint: `idp-outage:${revoked.id}` });
    const liveIdp = await seedIncident(c, w.teamId, { sourceId: "identity.idp_outage", category: "IDENTITY_SECURITY", fingerprint: `idp-outage:${live.id}` });

    // (3) dead sources.
    const retired = await seedIncident(c, w.teamId, {
      sourceId: "pipeline.signed_without_report_aged",
      category: "GOVERNANCE",
      fingerprint: `dashboard:integrity:unsigned_aged:${w.teamId}`,
    });
    const evUnavailable = await seedEvidence(c, w.teamId, owner.id);
    const evRealDrift = await seedEvidence(c, w.teamId, owner.id);
    await c.prisma.immutableStorageCheck.createMany({
      data: [
        { teamId: w.teamId, evidenceId: evUnavailable.id, outcome: "STORAGE_UNAVAILABLE", checkedAtUtc: new Date(Date.now() - 60_000) },
        { teamId: w.teamId, evidenceId: evUnavailable.id, outcome: "STORAGE_UNAVAILABLE" },
        { teamId: w.teamId, evidenceId: evRealDrift.id, outcome: "MISSING_LOCK", checkedAtUtc: new Date(Date.now() - 60_000) },
        { teamId: w.teamId, evidenceId: evRealDrift.id, outcome: "STORAGE_UNAVAILABLE" },
      ],
    });
    const driftUnavailable = await seedIncident(c, w.teamId, {
      sourceId: "storage.immutable_drift",
      category: "GOVERNANCE",
      fingerprint: `immutable_storage_drift:STORAGE_UNAVAILABLE:${evUnavailable.id}`,
      relatedEvidenceId: evUnavailable.id,
    });
    const driftReal = await seedIncident(c, w.teamId, {
      sourceId: "storage.immutable_drift",
      category: "GOVERNANCE",
      fingerprint: `immutable_storage_drift:MISSING_LOCK:${evRealDrift.id}`,
      relatedEvidenceId: evRealDrift.id,
    });

    // (4) a held CRITICAL row: reported, never mutated.
    const held = await seedIncident(c, w.teamId, {
      sourceId: "identity.idp_outage",
      category: "IDENTITY_SECURITY",
      severity: "CRITICAL",
      status: "ACKNOWLEDGED",
      fingerprint: `idp-outage:${live.id}:held`,
    });

    // (5) a source-truth row whose source has recovered.
    const dest = await c.prisma.automationWebhookDestination.create({
      data: {
        teamId: w.teamId, name: "rec", url: "https://rec.example/hook", urlOrigin: "https://rec.example",
        encryptedSecret: "x", secretFingerprint: "fp", enabled: true, createdByUserId: owner.id, updatedByUserId: owner.id,
      },
    });
    const recovered = await seedIncident(c, w.teamId, {
      sourceId: "integration.webhook_destination_disabled",
      category: "INTEGRATION",
      fingerprint: `webhook-destination-disabled:${dest.id}`,
    });

    const all = [routine, deniedSwitch, dedicated, stillUnknown, legacyNull, staleIdp, liveIdp, retired, driftUnavailable, driftReal, held, recovered];
    const ids = all.map((r) => r.id);
    const snapshot = () =>
      c.prisma.operationalIncident.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, resolvedAtUtc: true, resolutionNote: true },
        orderBy: { id: "asc" },
      });
    const eventCount = () => c.prisma.operationalIncidentEvent.count({ where: { incidentId: { in: ids } } });

    const { reconcileOperationsTruth } = await import("../src/services/operations/operations-truth-reconciliation.service.js");
    const newRules = [
      "reclassified_security_signals",
      "stale_idp_outages",
      "retired_unreachable_signals",
      "disabled_immutable_drift",
      "critical_held_conditions_report",
      "source_truth_recovery",
    ] as const;

    // A --team bound elsewhere touches nothing and reports nothing for these rows.
    const other = await makeWorkspace(c, owner.id, { name: "recon3-other" });
    const elsewhere = await reconcileOperationsTruth({ apply: true, teamId: other.teamId, rules: [...newRules] });
    for (const r of newRules) expect(elsewhere.rules[r].matched, r).toBe(0);

    const before = await snapshot();
    const eventsBefore = await eventCount();
    const dry = await reconcileOperationsTruth({ apply: false, teamId: w.teamId, rules: [...newRules] });
    expect(dry.mode).toBe("dry-run");
    expect(await snapshot()).toEqual(before);
    expect(await eventCount()).toBe(eventsBefore);
    expect(dry.rules.reclassified_security_signals.changed).toBe(4);
    expect(dry.rules.reclassified_security_signals.detail).toMatchObject({ stillUnclassified: 1, deniedOutsiderSwitch: 1 });
    expect(dry.rules.stale_idp_outages.changed).toBe(1);
    expect(dry.rules.retired_unreachable_signals.changed).toBe(1);
    expect(dry.rules.disabled_immutable_drift.changed).toBe(1);
    expect(dry.rules.critical_held_conditions_report).toMatchObject({ matched: 1, changed: 0 });
    expect(dry.rules.critical_held_conditions_report.detail).toMatchObject({ sourceActive: 1 });
    expect(dry.rules.source_truth_recovery.changed).toBe(1);
    expect(dry.rules.source_truth_recovery.detail).toMatchObject({
      "integration.webhook_destination_disabled:recovered": 1,
    });

    const now = new Date();
    const applied = await reconcileOperationsTruth({ apply: true, teamId: w.teamId, rules: [...newRules], now });
    expect(applied.mode).toBe("apply");
    const after = new Map((await snapshot()).map((r) => [r.id, r]));
    for (const r of [routine, deniedSwitch, dedicated, legacyNull, staleIdp, retired, driftUnavailable, recovered]) {
      expect(after.get(r.id)!.status, r.fingerprint).toBe("RESOLVED");
    }
    for (const r of [stillUnknown, liveIdp, driftReal]) {
      expect(after.get(r.id)!.status, r.fingerprint).toBe("OPEN");
    }
    // Held CRITICAL row: untouched.
    expect(after.get(held.id)!.status).toBe("ACKNOWLEDGED");
    // Truthful timestamps: the reconciliation's own time, never back-dated.
    expect(after.get(routine.id)!.resolvedAtUtc!.getTime()).toBe(now.getTime());
    expect(after.get(deniedSwitch.id)!.resolutionNote).toContain("not a member of this workspace");
    expect(after.get(routine.id)!.resolutionNote).toContain("reclassified");
    expect(after.get(dedicated.id)!.resolutionNote).toContain("integration.webhook_destination_disabled");
    // Every closure is audited with the reconciliation event; source-truth via domain truth.
    const audit = await c.prisma.operationalIncidentEvent.findMany({
      where: { incidentId: { in: ids } },
      select: { incidentId: true, eventType: true },
    });
    for (const r of [routine, deniedSwitch, dedicated, legacyNull, staleIdp, retired, driftUnavailable]) {
      expect(audit.some((e) => e.incidentId === r.id && e.eventType === "resolved_by_reconciliation"), r.fingerprint).toBe(true);
    }
    expect(audit.some((e) => e.incidentId === recovered.id && e.eventType === "resolved_by_domain_truth")).toBe(true);
    expect(await c.prisma.operationalIncident.count({ where: { id: { in: ids } } })).toBe(ids.length);

    // Idempotent: nothing left to do, no new history.
    const eventsAfterFirst = await eventCount();
    const again = await reconcileOperationsTruth({ apply: true, teamId: w.teamId, rules: [...newRules] });
    for (const r of newRules) expect(again.rules[r].changed, r).toBe(0);
    expect(await eventCount()).toBe(eventsAfterFirst);
  });
});
