// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH — EXISTING-DATA RECONCILIATION (live PostgreSQL).
 *
 * Rows in the shapes the old code wrote are seeded; the reconciliation must
 *   * change nothing in dry-run mode, and report bounded counts;
 *   * repair each class in apply mode — retire false signals, close the
 *     per-workspace heartbeat copies, close superseded provider-auth rows and
 *     routine 403 rows, re-scope a Personal record's failure only where its
 *     owner is proven, sanitize raw summaries, close what the canonical probe
 *     proves recovered, re-open premature automatic resolutions, and flag what
 *     needs the provider for owner review;
 *   * find nothing more to do on a second apply (idempotent);
 *   * never delete history.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootOps,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedEvidence,
  seedIncident,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations truth reconciliation (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("dry-run changes nothing; apply repairs every class; a second apply finds nothing; history is kept", async () => {
    const owner = await makeUser(c, "recon-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "recon-team", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const space = await personalSpace(c, owner.id);
    const t = Date.now();

    const retired = await seedIncident(c, w.teamId, { sourceId: "queue.retry_storm", category: "WORKER", fingerprint: `dashboard:reliability:retry_storms:${w.teamId}` });
    const telemetry = await seedIncident(c, w.teamId, { sourceId: null, category: "WORKER", fingerprint: `dashboard:telemetry:queue_stale:${w.teamId}` });
    const heartbeat = await seedIncident(c, w.teamId, { sourceId: "platform.worker_heartbeat_stale", category: "WORKER", fingerprint: `dashboard:worker:heartbeat_stale:${w.teamId}` });
    const providerHourly = await seedIncident(c, null, { sourceId: "billing.provider_authorization", category: "RECONCILIATION", fingerprint: `reconciliation:provider_auth:PAYPAL:${t}` });
    const denied = await seedIncident(c, w.teamId, { sourceId: "identity.security_condition", category: "IDENTITY_SECURITY", fingerprint: "identity_security:security_event:permission_denied" });

    // A Personal record's failure, stranded unscoped; and one whose record is gone.
    const personalEv = await seedEvidence(c, null, owner.id);
    const stranded = await seedIncident(c, null, {
      scope: "LEGACY_UNSCOPED",
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${personalEv.id}:RENDER_FAILED`,
      relatedEvidenceId: personalEv.id,
    });

    // A raw-message identity and summary.
    const teamEv = await seedEvidence(c, w.teamId, owner.id);
    const raw = await seedIncident(c, w.teamId, {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${teamEv.id}:S3_PUTOBJECT_DENIED FOR ARN:AWS:S3:::SECRET`,
      relatedEvidenceId: teamEv.id,
      safeSummary: "S3 PutObject denied for arn:aws:s3:::tenant-secret-bucket/originals/x.pdf",
    });

    // A TSA condition resolved early by the old "not FAILED" rule.
    const tsaEv = await seedEvidence(c, w.teamId, owner.id, { tsaStatus: "PENDING" });
    const premature = await seedIncident(c, w.teamId, {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `tsa_failure:${tsaEv.id}`,
      relatedEvidenceId: tsaEv.id,
      status: "RESOLVED",
    });
    await c.prisma.operationalIncident.update({ where: { id: premature.id }, data: { resolvedAtUtc: new Date(), resolvedByUserId: null } });

    // A billing condition whose add-on is gone.
    const orphanBilling = await seedIncident(c, space, {
      sourceId: "billing.dependent_cancellation_failed",
      category: "STORAGE",
      fingerprint: "billing_dependent_cancellation:44444444-4444-4444-8444-444444444444",
    });

    const ids = [retired, telemetry, heartbeat, providerHourly, denied, stranded, raw, premature, orphanBilling].map((r) => r.id);
    const snapshot = async () =>
      c.prisma.operationalIncident.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, teamId: true, scope: true, safeSummary: true, title: true },
        orderBy: { id: "asc" },
      });
    const eventCount = () => c.prisma.operationalIncidentEvent.count({ where: { incidentId: { in: ids } } });

    const { reconcileOperationsTruth } = await import("../src/services/operations/operations-truth-reconciliation.service.js");

    const before = await snapshot();
    const eventsBefore = await eventCount();
    const dry = await reconcileOperationsTruth({ apply: false, limitPerRule: 5000 });
    expect(dry.mode).toBe("dry-run");
    expect(await snapshot()).toEqual(before);
    expect(await eventCount()).toBe(eventsBefore);
    for (const rule of [
      "retired_false_signals",
      "workspace_heartbeat_copies",
      "provider_auth_superseded_rows",
      "routine_authorization_refusals",
      "legacy_unscoped_rescope",
      "raw_pipeline_messages",
      "premature_recoveries_reopened",
    ] as const) {
      expect(dry.rules[rule].changed, rule).toBeGreaterThanOrEqual(1);
    }
    expect(dry.rules.billing_owner_review.requiresOwnerReview).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(dry)).not.toContain("tenant-secret-bucket");

    const applied = await reconcileOperationsTruth({ apply: true, limitPerRule: 5000 });
    expect(applied.mode).toBe("apply");
    const after = new Map((await snapshot()).map((r) => [r.id, r]));
    for (const row of [retired, telemetry, heartbeat, providerHourly, denied]) {
      expect(after.get(row.id)!.status, row.fingerprint).toBe("RESOLVED");
    }
    expect(after.get(stranded.id)).toMatchObject({ teamId: space, scope: "WORKSPACE" });
    expect(after.get(raw.id)!.safeSummary).not.toContain("tenant-secret-bucket");
    expect(after.get(raw.id)!.title).toBe("Report generation failed");
    expect(after.get(premature.id)!.status).toBe("OPEN");
    expect(after.get(orphanBilling.id)!.status).toBe("OPEN");
    const review = await c.prisma.operationalIncidentEvent.findFirst({
      where: { incidentId: orphanBilling.id, eventType: "requires_owner_review" },
    });
    expect(review).not.toBeNull();
    // History is appended, never removed.
    expect(await eventCount()).toBeGreaterThan(eventsBefore);

    // Idempotent: a second apply has nothing left to do for these rows.
    const eventsAfterFirst = await eventCount();
    const again = await reconcileOperationsTruth({ apply: true, limitPerRule: 5000 });
    for (const rule of [
      "retired_false_signals",
      "workspace_heartbeat_copies",
      "provider_auth_superseded_rows",
      "routine_authorization_refusals",
      "raw_pipeline_messages",
    ] as const) {
      expect(again.rules[rule].changed, rule).toBe(0);
    }
    expect(await eventCount()).toBe(eventsAfterFirst);
    expect(await snapshot()).toEqual([...after.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
  });
});
