/**
 * THE SERVER, AS THE TEAM REVIEW SURFACES SEE IT (TEAM-SPEC 2026-11-23).
 *
 * REAL: the production Next.js bundle, its stylesheet order and cascade, the
 * real PageShell, sidebar, ReviewHubNav, inspector and canonical Modal.
 *
 * INTERCEPTED: every `/v1/**` call. Nothing leaves the browser and no
 * production system is contacted. All data is synthetic.
 *
 * CONTEXTS are defined by what the server resolves, never by a plan name
 * alone. Each capability set below is the one
 * `services/api/src/services/platform-context/capability-registry.ts`
 * grants for that role when `reviewerOperationsIncluded` is true (lines
 * ~258-268): every role views; writers (OWNER/ADMIN/MEMBER) act and escalate;
 * OWNER/ADMIN also assign, reassign and bulk. A PRO personal workspace gets
 * none of the reviewer-ops keys. Plan features come from the plan catalog
 * (`packages/shared-billing/src/plan-catalog.ts`): TEAM and ENTERPRISE include
 * reviewer operations, review queues and External Review; PRO includes only
 * External Review.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
export const OWNER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const PEER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const WF = "8e8db933-f972-4423-98b0-11f7eb0096ed";
export const EV = "a557dc83-6863-4536-8b8d-2ae5d69a0b1c";

export type ReviewContext =
  | "team-owner"
  | "team-member"
  | "team-viewer"
  | "enterprise-owner"
  | "pro-owner";

type Shape = {
  type: "PERSONAL" | "ORGANIZATION";
  plan: "PRO" | "TEAM" | "ENTERPRISE";
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  shared: boolean;
  name: string;
  actorId: string;
};

const SHAPES: Record<ReviewContext, Shape> = {
  "team-owner": { type: "PERSONAL", plan: "TEAM", role: "OWNER", shared: false, name: "Personal Space", actorId: OWNER_ID },
  "team-member": { type: "PERSONAL", plan: "TEAM", role: "MEMBER", shared: true, name: "Rivera Legal (shared)", actorId: PEER_ID },
  "team-viewer": { type: "PERSONAL", plan: "TEAM", role: "VIEWER", shared: true, name: "Rivera Legal (shared)", actorId: PEER_ID },
  "enterprise-owner": { type: "ORGANIZATION", plan: "ENTERPRISE", role: "OWNER", shared: false, name: "Meridian Compliance", actorId: OWNER_ID },
  "pro-owner": { type: "PERSONAL", plan: "PRO", role: "OWNER", shared: false, name: "Personal Space", actorId: OWNER_ID },
};

export function shapeOf(ctx: ReviewContext): Shape {
  return SHAPES[ctx];
}

function capabilities(s: Shape): Record<string, boolean> {
  const isAdmin = s.role === "OWNER" || s.role === "ADMIN";
  const isWriter = s.role !== "VIEWER";
  const reviewerOps = s.plan !== "PRO";
  const caps: Record<string, boolean> = {
    EVIDENCE_VIEW: true,
    REPORTS_VIEW: true,
    WORKSPACE_HEALTH_VIEW: true,
  };
  if (isWriter) Object.assign(caps, { EVIDENCE_MANAGE: true, CASES_MANAGE: true, REPORTS_GENERATE: true });
  if (isAdmin) caps.SETTINGS_MANAGE = true;
  if (reviewerOps) {
    Object.assign(caps, { REVIEWER_OPS_VIEW: true, SLA_VIEW: true, ESCALATIONS_VIEW: true });
    if (isWriter) Object.assign(caps, { REVIEWER_OPS_ACT: true, REVIEW_ESCALATE: true });
    if (isWriter && isAdmin) Object.assign(caps, { REVIEW_ASSIGN: true, REVIEW_REASSIGN: true });
    if (isAdmin) Object.assign(caps, { CASE_ASSIGN: true, BULK_ACTIONS: true });
  }
  if (s.type === "ORGANIZATION") {
    Object.assign(caps, { TEAM_VIEW: true, GOVERNANCE_VIEW: true });
    if (isAdmin) caps.GOVERNANCE_ACT = true;
  }
  return caps;
}

export function envelopeFor(ctx: ReviewContext): Record<string, unknown> {
  const s = SHAPES[ctx];
  const team = s.plan !== "PRO";
  const roleLabel = s.type === "PERSONAL" && !s.shared ? "Owner" : s.role;
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: capabilities(s),
    diagnostics: { requestId: `review-layout-${ctx}` },
    workspace: { id: WORKSPACE_ID, name: s.name, status: "active", scope: s.type, membership: { role: s.role } },
    activeSpace: {
      type: s.type,
      id: WORKSPACE_ID,
      displayName: s.name,
      roleLabel,
      shared: s.shared,
    },
    contextOptions: {
      personalSpace: s.type === "PERSONAL" && !s.shared ? { workspaceId: WORKSPACE_ID } : null,
      ownedWorkspaces: [],
      sharedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WORKSPACE_ID, kind: s.type, organizationId: null, displayName: s.name },
    },
    account: { accountPlan: s.type === "PERSONAL" && !s.shared ? s.plan : "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: s.plan === "ENTERPRISE" },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      intakeIncluded: true,
      reportsIncluded: true,
      basicRecordReviewIncluded: true,
      externalReviewIncluded: true,
      reviewerOperationsIncluded: team,
      reviewQueuesIncluded: team,
      teamCollaborationIncluded: team,
    },
    user: { id: s.actorId, email: "reviewer@example.invalid", name: "Fixture Reviewer" },
  };
}

// ---------------------------------------------------------------------------
// Synthetic review data. Long labels and IDs on purpose.
// ---------------------------------------------------------------------------

const iso = (d: string) => `${d}T12:00:00.000Z`;

function projection(ctx: ReviewContext, over: Record<string, unknown> = {}) {
  return {
    workflowId: WF,
    evidenceId: EV,
    teamId: WORKSPACE_ID,
    lifecycleState: "ESCALATED",
    assignedToUserId: SHAPES[ctx].actorId,
    assignedAtUtc: iso("2026-10-29"),
    priority: "NORMAL",
    slaPausedAtUtc: null,
    pausedReason: null,
    slaRollupState: "BREACHED",
    slaDimensions: [
      { dimension: "assignment", dueAtUtc: iso("2026-11-08"), dueSoonAtUtc: null, state: "COMPLETED", timeRemainingMs: null, breachDurationMs: null },
      { dimension: "first_review", dueAtUtc: iso("2026-11-09"), dueSoonAtUtc: null, state: "BREACHED", timeRemainingMs: null, breachDurationMs: 1_100_000_000 },
      { dimension: "completion", dueAtUtc: iso("2026-11-11"), dueSoonAtUtc: null, state: "BREACHED", timeRemainingMs: null, breachDurationMs: 900_000_000 },
      { dimension: "escalation", dueAtUtc: iso("2026-11-10"), dueSoonAtUtc: null, state: "COMPLETED", timeRemainingMs: null, breachDurationMs: null },
    ],
    legacy: { dueAt: iso("2026-11-11"), status: "ASSIGNED" },
    ...over,
  };
}

const escalation = (status: string) => ({
  id: "e5c00000-0000-4000-8000-000000000003",
  teamId: WORKSPACE_ID,
  workflowId: WF,
  workflowInstanceId: null,
  evidenceId: EV,
  reason: "REVIEW_OVERDUE",
  severity: "HIGH",
  status,
  safeSummary: "Review past due — escalated automatically after the first-review deadline passed.",
  createdByUserId: null,
  assignedToUserId: null,
  acknowledgedAtUtc: status === "ACKNOWLEDGED" ? iso("2026-11-10") : null,
  acknowledgedByUserId: status === "ACKNOWLEDGED" ? OWNER_ID : null,
  resolvedAtUtc: null,
  resolvedByUserId: null,
  resolutionNote: null,
  suppressedAtUtc: null,
  suppressionReason: null,
  incidentId: null,
  createdAt: iso("2026-11-09"),
});

const queued = Array.from({ length: 6 }, (_, i) => ({
  workflowId: `0000000${i}-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
  evidenceId: `0000000${i}-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
  teamId: WORKSPACE_ID,
  lifecycleState: i % 3 === 0 ? "IN_REVIEW" : "QUEUED",
  assignedToUserId: i % 3 === 0 ? PEER_ID : null,
  assignedAtUtc: null,
  priority: i === 1 ? "HIGH" : "NORMAL",
  slaPausedAtUtc: null,
  pausedReason: null,
  slaRollupState: i === 2 ? "DUE_SOON" : "HEALTHY",
  slaDimensions: [],
  legacy: { dueAt: iso(`2026-11-${String(24 + i).padStart(2, "0")}`) },
}));

function viewerActions(ctx: ReviewContext) {
  const s = SHAPES[ctx];
  const assignee = true; // the fixture review is assigned to the actor
  const writer = s.role !== "VIEWER";
  const admin = s.role === "OWNER" || s.role === "ADMIN";
  const a = (action: string, allowed: boolean, reason?: string) => ({ action, allowed, ...(reason ? { reason } : {}) });
  return {
    userId: s.actorId,
    isAssignee: assignee && writer,
    actions: [
      a("start", false, "invalid_transition"),
      a("pause", writer, writer ? undefined : "reviewer_required"),
      a("resume", false, "not_paused"),
      a("request_info", writer, writer ? undefined : "reviewer_required"),
      a("record_response", false, "not_awaiting_information"),
      a("approve", writer, writer ? undefined : "reviewer_required"),
      a("reject", writer, writer ? undefined : "reviewer_required"),
      a("reassign", admin, admin ? undefined : "review_assign_required"),
      a("adjudicate", false, "no_conflict"),
      a("archive", admin, admin ? undefined : "review_assign_required"),
    ],
  };
}

export const unhandled = new Set<string>();

function respond(ctx: ReviewContext, url: URL): unknown {
  const p = url.pathname;
  const q = url.searchParams;
  const s = SHAPES[ctx];
  if (p.endsWith("/v1/reviewer-ops/queue")) {
    const rows = q.get("queue") === "ASSIGNED_TO_ME" ? [projection(ctx)] : queued;
    return { rows, items: rows, nextCursor: null };
  }
  if (p.endsWith("/v1/reviewer-ops/console")) {
    return {
      generatedAt: iso("2026-11-23"),
      teamId: WORKSPACE_ID,
      reviewer: { userId: s.actorId, isReviewerCapable: s.role !== "VIEWER" },
      queue: { rows: queued, status: "ok", count: queued.length },
      mine: { rows: [projection(ctx)], status: "ok", count: 1 },
      escalations: { rows: [escalation("ACKNOWLEDGED")], status: "ok", count: 1 },
      sla: { status: "ok", snapshot: null },
      workload: { rows: [], status: "ok", count: 0 },
      savedViews: { rows: [], status: "ok", count: 0 },
      diagnostics: {
        sectionStatus: { queue: "ok", mine: "ok", escalations: "ok", sla: "ok", workload: "ok", savedViews: "ok" },
        sectionLimit: 25,
      },
    };
  }
  if (p.endsWith("/v1/reviewer-ops/escalations")) {
    const st = q.get("status");
    const rows = st === "OPEN" ? [] : st === "RESOLVED" || st === "SUPPRESSED" ? [] : [escalation("ACKNOWLEDGED")];
    return { escalations: rows, total: rows.length };
  }
  if (p.endsWith("/v1/reviewer-ops/qc/pending-count")) return { count: 2 };
  if (p.endsWith("/v1/reviewer-ops/assignable-reviewers")) {
    return {
      reviewers: [
        { userId: OWNER_ID, displayName: "Alexandra Konstantinopoulou-Whitfield", role: "OWNER" },
        { userId: PEER_ID, displayName: "Sam Rivera", role: "MEMBER" },
      ],
    };
  }
  if (p.endsWith("/v1/review/queue")) return { items: [], nextCursor: null };
  if (p.endsWith("/v1/reviewer-ops/decisions/summary")) {
    return {
      summary: { windowDays: 90, workflowsInWindow: 7, byState: { first_required: 5, second_required: 1, conflict_detected: 0, resolved: 1 } },
      preview: { first_required: [], second_required: [], conflict_detected: [], resolved: [] },
    };
  }
  if (/\/v1\/reviewer-ops\/workspace\/[^/]+\/notes$/.test(p)) return { summary: { total: 0 }, items: [] };
  if (/\/v1\/reviewer-ops\/workspace\/[^/]+\/decisions$/.test(p)) {
    return {
      workflowId: WF,
      evidenceId: EV,
      decisions: [],
      state: "first_required",
      secondReviewRequirement: { required: true, reason: "escalation" },
      callerContext: {
        userId: s.actorId,
        teamRole: s.role,
        isAdjudicator: s.role === "OWNER" || s.role === "ADMIN",
        callerIsFirstReviewer: false,
        nextAction: s.role === "VIEWER" ? "blocked_not_reviewer" : "submit_first",
      },
    };
  }
  if (/\/v1\/reviewer-ops\/workspace\/[^/]+$/.test(p)) {
    return {
      projection: projection(ctx),
      openEscalation: escalation("ACKNOWLEDGED"),
      allowedLifecycleTransitions: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_INFORMATION", "ARCHIVED"],
      viewer: viewerActions(ctx),
    };
  }
  if (p.endsWith("/v1/reviewer-ops/sla-policy")) {
    return {
      // resolveEffectiveSlaPolicy + loadWorkspaceReviewerOpsFlags
      // (services/api/src/services/reviewer-ops/sla-policy.service.ts).
      policy: {
        policy: { assignmentHours: 4, firstReviewHours: 24, completionHours: 72, escalationHours: 48, dueSoonHours: 6 },
        sources: {
          workspace: { firstReviewHours: 24 },
          env: { assignmentHours: 4, firstReviewHours: 24, completionHours: 72, escalationHours: 48, dueSoonHours: 6 },
        },
      },
      flags: {
        requireStepUpForApprove: false,
        requireStepUpForReject: false,
        requireStepUpForEscalationResolve: true,
        requireStepUpForBulk: true,
        reviewerInactivityHours: null,
      },
    };
  }
  if (p.endsWith("/v1/reviewer-ops/dashboard")) {
    return {
      counts: { unassigned: 4, assignedToMe: 1, dueSoon: 0, overdue: 1, inReview: 1, needsMoreInfo: 0, escalated: 0, total: 6, byStage: { QUEUED: 4, ASSIGNED: 1, CLOSED: 1 } },
      openEscalations: 1,
      criticalEscalationsOpen: 0,
      workloadTop: [],
      suggestions: [],
    };
  }
  if (p.endsWith("/v1/reviewer-ops/analytics/escalations")) {
    // analytics.service.ts getEscalationAnalytics return shape.
    return {
      range: { startUtc: iso("2026-11-09"), endUtc: iso("2026-11-23") },
      totalOpen: 1,
      totalOpenedInRange: 1,
      totalResolvedInRange: 0,
      meanResolutionMs: null,
      byDay: [],
      hotspots: [{ reason: "REVIEW_OVERDUE", openCount: 1, resolvedCount: 0, meanResolutionMs: null }],
    };
  }
  if (p.endsWith("/v1/reviewer-ops/analytics/reviewers")) {
    // ReviewerPerformanceProjection (packages/shared/src/reviewer-ops.ts) with
    // the nullable wire fields from analytics.service.ts.
    return {
      range: { startUtc: iso("2026-11-09"), endUtc: iso("2026-11-23") },
      rows: [
        { reviewerUserId: PEER_ID, active: 1, completedInRange: 0, approvedInRange: 0, rejectedInRange: 0, overdue: 1, escalated: 1, meanResolutionMs: null, slaComplianceRate: null, capacityScore: null },
      ],
    };
  }
  if (p.endsWith("/v1/reviewer-ops/reminders")) return { reminders: [] };
  if (p.endsWith("/v1/reviewer/routing-recommendations")) return { recommendations: [] };
  if (p.endsWith("/v1/ai/qc/samples")) return { samples: [] };
  if (p.endsWith("/v1/reviewer-ops/queue-intelligence")) return { items: [], rows: [] };
  if (p.endsWith("/v1/reviewer-criteria")) return { criteria: [] };
  if (p.endsWith("/coding")) return { schema: null, values: [] };
  if (p.endsWith("/v1/reviewer/workspace")) return { items: [] };
  if (p.endsWith("/v1/reviewer/qc/samples")) return { samples: [], items: [] };
  if (p.endsWith("/v1/me/inbox/summary")) return { unread: 0 };
  if (p.endsWith("/v1/external-review/invitations")) return { invitations: [], viewerCanIssue: s.role === "OWNER" || s.role === "ADMIN" };
  if (p.endsWith("/v1/external-review/grants")) return { grants: [], viewerCanIssue: s.role === "OWNER" || s.role === "ADMIN" };
  if (p.endsWith("/v1/runtime/status")) return { status: "ok" };
  if (p.endsWith("/v1/billing/accounts")) return { accounts: [] };
  unhandled.add(p);
  return {};
}

export async function installApi(page: Page, ctx: ReviewContext, errors?: string[]): Promise<void> {
  const env = envelopeFor(ctx);
  page.on("pageerror", (e) => errors?.push(`pageerror ${page.url()} ${String(e).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      errors?.push(`console ${page.url()} ${m.text().slice(0, 300)}`);
    }
  });
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.endsWith("/v1/platform/context")) return json(env);
    if (url.pathname.endsWith("/v1/auth/me") || url.pathname.endsWith("/v1/users/me")) {
      return json({ id: SHAPES[ctx].actorId, email: "reviewer@example.invalid" });
    }
    if (route.request().method() !== "GET") return json({ ok: true });
    return json(respond(ctx, url));
  });
}

export const VIEWPORTS = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024-landscape", width: 1024, height: 700 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "short-1280x600", width: 1280, height: 600 },
  { name: "phone-landscape-844x390", width: 844, height: 390 },
  // 200% browser zoom of a 1280x800 window is a 640x400 CSS viewport.
  { name: "zoom200-640x400", width: 640, height: 400 },
] as const;

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - window.innerWidth;
  });
}
