/**
 * TEAM REMEDIATION ROUND 2 (2026-11-25) — C H-3: the Enterprise review counters
 * read THE count definitions (review-count-definitions.ts), so the Team Inbox
 * figures, the Command Center tiles and Operations analytics agree on one
 * workspace, figure for figure. The fixture holds the statuses the old
 * private predicates disagreed on: NOT_STARTED and RESPONSE_RECEIVED (open,
 * left out by the Command Center and analytics), REJECTED_INSUFFICIENT
 * (finished, counted open by analytics), an ACKNOWLEDGED escalation (active,
 * left out by "status OPEN"), and a stored-SLA overdue review with no past
 * dueAt (overdue in the Inbox, missed by the dueAt windows).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

type Actor = { userId: string; token: string };
type Space = { teamId: string; owner: Actor };

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trem-r2c-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TremR2C", lastName: label, provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

async function teamSpace(label: string): Promise<Space> {
  const owner = await newUser(label);
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  return { teamId: space.teamId, owner };
}

type WfOpts = {
  status?: string;
  assignedToUserId?: string | null;
  assignedAtUtc?: Date | null;
  extra?: Record<string, unknown>;
};
async function workflow(s: Space, o: WfOpts = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: s.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: {
        title: `trem-r2c ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: s.teamId,
        organizationId: t.organizationId,
        ownerUserId: s.owner.userId,
      } as never,
      select: { id: true },
    })
  ).id;
  const row = await prisma.evidenceReviewWorkflow.create({
    data: {
      evidenceId,
      teamId: s.teamId,
      status: (o.status ?? "NOT_STARTED") as never,
      workspaceType: "TEAM",
      ...(o.assignedToUserId
        ? { assignedToUserId: o.assignedToUserId, assignedAtUtc: o.assignedAtUtc ?? new Date() }
        : {}),
      ...(o.extra ?? {}),
    } as never,
  });
  return { evidenceId, workflowId: row.id };
}

let reviewCounts: typeof import("../src/services/reviewer-ops/review-count-definitions.js");
let ccCounters: typeof import("../src/services/dashboard/command-center-counters.js");
let analytics: typeof import("../src/services/analytics/analytics.service.js");
let reachMod: typeof import("../src/services/access/record-reach.js");

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  reviewCounts = await import("../src/services/reviewer-ops/review-count-definitions.js");
  ccCounters = await import("../src/services/dashboard/command-center-counters.js");
  analytics = await import("../src/services/analytics/analytics.service.js");
  reachMod = await import("../src/services/access/record-reach.js");
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

const HOUR = 3_600_000;

describe("C H-3 — one set of review counts across Team and Enterprise surfaces", () => {
  it("Inbox figures, Command Center tiles and Operations analytics agree", async () => {
    const s = await teamSpace("counts");
    const later = new Date(Date.now() + 48 * HOUR);
    await workflow(s, { status: "NOT_STARTED", extra: { slaStatus: "BREACHED", firstResponseDueAtUtc: new Date(Date.now() - HOUR), dueAt: later } });
    await workflow(s, { status: "RESPONSE_RECEIVED", assignedToUserId: s.owner.userId, extra: { slaStatus: "DUE_SOON", dueAt: later } });
    const escalated = await workflow(s, { status: "IN_REVIEW", assignedToUserId: s.owner.userId, extra: { slaStatus: "ON_TRACK", dueAt: later } });
    await workflow(s, { status: "QUEUED", extra: { slaStatus: "ON_TRACK", dueAt: later } });
    await workflow(s, { status: "REJECTED_INSUFFICIENT", extra: { completedAtUtc: new Date(Date.now() - HOUR) } });
    await workflow(s, { status: "APPROVED_INTERNAL", extra: { completedAtUtc: new Date(Date.now() - 2 * HOUR) } });
    await prisma.reviewEscalation.create({
      data: {
        teamId: s.teamId,
        workflowId: escalated.workflowId,
        evidenceId: escalated.evidenceId,
        reason: "REVIEWER_ESCALATED",
        severity: "WARNING",
        status: "ACKNOWLEDGED",
        safeSummary: "acknowledged escalation",
        fingerprint: `r2c-${escalated.workflowId}`,
      } as never,
    });

    const team = await reviewCounts.countReviewFigures({ teamId: s.teamId, viewerUserId: s.owner.userId }, prisma as never);
    expect(team.openReviews).toBe(4);
    expect(team.activeEscalations).toBe(1);
    expect(team.completedReviews7d).toBe(2);

    const reach = await reachMod.viewerReachInWorkspace(s.teamId, s.owner.userId);
    const cc = await ccCounters.loadReviewQueueCounters(s.teamId, ccCounters.reviewQueueWindow(), reach);
    expect(cc.openReviews).toBe(team.openReviews);
    expect(cc.unassignedReviews).toBe(team.unassignedReviews);
    expect(cc.openEscalations).toBe(team.activeEscalations);
    expect(cc.closedLast7d).toBe(team.completedReviews7d);
    expect(cc.overdue).toBe(1);
    expect(cc.dueSoon).toBe(1);

    const ops = await analytics.getOperationsOverview({ teamId: s.teamId, scope: "SHARED", reach });
    expect(ops.metrics.openReviewWorkflows).toBe(team.openReviews);
    expect(ops.metrics.openEscalations).toBe(team.activeEscalations);
    const rev = await analytics.getReviewerAnalytics({ teamId: s.teamId, scope: "SHARED", reach });
    expect(rev.metrics.activeReviews).toBe(team.openReviews);
    expect(rev.metrics.overdueReviews).toBe(cc.overdue);
    expect(rev.metrics.openEscalations).toBe(team.activeEscalations);
  });
});
