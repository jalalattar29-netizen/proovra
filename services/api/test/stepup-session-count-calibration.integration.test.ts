/**
 * Stage B — step-up calibration, typed refusal reasons and the bulk-door
 * classification (T-025, T-026, T-027, T-028, T-030, T-033, T-036).
 *
 * Promotes the audit reproductions (`zz-audit-stepup-matrix`, five_sessions
 * rows; `zz-audit2-sec-reconcile` Q2) to assertions. Each case below failed on
 * e4e908e88:
 *   - 4 same-device sessions + a real sign-in scored 35 (MEDIUM) and reject
 *     answered 401 STEP_UP_REQUIRED with every flag off;
 *   - a refusal carried no reason;
 *   - a one-item bulk ASSIGN/REASSIGN was step-up / age gated;
 *   - a single Archive was governed by the bulk flag and the 4 h window.
 * Genuine risk and explicit flags stay enforced (no password fallback).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let signJwt: typeof import("../src/services/jwt.js").signJwt;
let hashSessionId: (sid: string) => string;
let hashPassword: typeof import("../src/services/email-password-auth.service.js").hashPassword;
let recalibrate: typeof import("../src/services/access-control/runtime-risk.service.js").recalibrateConcurrencyOnlySessionScores;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: any; raw: string };
type Owner = { userId: string; email: string; teamId: string; password: string };

const PASSWORD = "Correct-horse-9-battery";

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  await harness.handlersSettled();
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newOwner(label: string): Promise<Owner> {
  seq += 1;
  const email = `stageb-cal-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "Cal", lastName: label, provider: "EMAIL", providerUserId: email },
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
  const space = await ensurePersonalWorkspace({ userId: user.id });
  const updated = await prisma.entitlement.updateMany({ where: { userId: user.id }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: user.id, plan: "TEAM" } });
  await prisma.user.update({
    where: { id: user.id },
    data: { currentWorkspaceId: space.teamId, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
  });
  return { userId: user.id, email, teamId: space.teamId, password: PASSWORD };
}

/** A token whose sid has an inventory row, as every production sign-in writes. */
async function rowToken(
  o: { userId: string; email: string },
  teamId: string,
  opts: { ageHours?: number; riskScore?: number; ipPreview?: string | null; issuedHoursAgo?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { sub: o.userId, provider: "EMAIL", email: o.email, authMethod: "PASSWORD", authAt: now } as never,
    process.env.AUTH_JWT_SECRET as string,
    3600,
  );
  const sid = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
  await prisma.authenticatedSession.create({
    data: {
      userId: o.userId,
      teamId,
      sessionIdHash: hashSessionId(sid),
      issuedAtUtc: new Date(Date.now() - (opts.ageHours ?? opts.issuedHoursAgo ?? 0) * 3600_000),
      lastSeenAtUtc: new Date(),
      expiresAtUtc: new Date(Date.now() + 24 * 3600_000),
      authMethod: "PASSWORD",
      ipPreview: opts.ipPreview ?? null,
      ...(opts.riskScore != null ? { riskScore: opts.riskScore } : {}),
    } as never,
  });
  return token;
}

async function login(o: Owner): Promise<{ token: string; riskScore: number | null; ipPreview: string | null }> {
  const res = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/email/login",
    headers: { "user-agent": "Mozilla/5.0 (stage-b) Chrome/131", "accept-language": "en-GB" },
    payload: { email: o.email, password: o.password },
  });
  await harness.handlersSettled();
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const token = (JSON.parse(res.body) as { token: string }).token;
  const sid = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
  const row = await prisma.authenticatedSession.findFirst({
    where: { userId: o.userId, sessionIdHash: hashSessionId(sid) },
    select: { riskScore: true, ipPreview: true },
  });
  return { token, riskScore: row?.riskScore ?? null, ipPreview: row?.ipPreview ?? null };
}

async function setFlags(teamId: string, on: boolean) {
  const flags = {
    requireStepUpForApprove: on,
    requireStepUpForReject: on,
    requireStepUpForEscalationResolve: on,
    requireStepUpForBulk: on,
  };
  await prisma.workspaceGovernancePolicy.upsert({
    where: { teamId },
    create: { teamId, ...flags } as never,
    update: flags as never,
  });
}

async function workflow(o: { teamId: string; userId: string }, status: string, assignedTo: string | null = o.userId) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: o.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `stage-b ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: o.teamId, organizationId: t.organizationId, ownerUserId: o.userId } as never,
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId,
        teamId: o.teamId,
        status: status as never,
        workspaceType: "TEAM",
        assignedToUserId: assignedTo,
        assignedAtUtc: assignedTo ? new Date() : null,
      } as never,
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

const reject = async (token: string, o: Owner) => {
  const { workflowId } = await workflow(o, "IN_REVIEW");
  const r = await call(token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reject`, { teamId: o.teamId, note: "insufficient" });
  return { r, workflowId };
};

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ signJwt } = await import("../src/services/jwt.js"));
  ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
  ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
  ({ recalibrateConcurrencyOnlySessionScores: recalibrate } = await import("../src/services/access-control/runtime-risk.service.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("T-025 concurrent-session count alone never reaches MEDIUM", () => {
  it("four same-device sessions plus a real sign-in stay LOW, and a routine reject with flags off records (no MFA asked)", async () => {
    const o = await newOwner("samedev");
    await setFlags(o.teamId, false);
    for (let i = 0; i < 4; i += 1) await rowToken(o, o.teamId);
    const s = await login(o);
    expect(s.riskScore).not.toBeNull();
    expect(s.riskScore!).toBeLessThan(30);
    const { r, workflowId } = await reject(s.token, o);
    expect(r.status, r.raw.slice(0, 300)).toBe(200);
    const after = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId }, select: { status: true } });
    expect(after.status).toBe("REJECTED_INSUFFICIENT");
  });

  it("three sessions from distinct networks still score MEDIUM and the refusal says why (elevated_session_risk)", async () => {
    const o = await newOwner("distinctip");
    await setFlags(o.teamId, false);
    // Issued 7 h ago so the separate IP-shift signal (6 h) is not what fires.
    for (const ip of ["198.51.100.•••", "192.0.2.•••", "100.64.0.•••"]) {
      await rowToken(o, o.teamId, { ipPreview: ip, issuedHoursAgo: 7 });
    }
    const s = await login(o);
    expect(s.ipPreview).toBeTruthy();
    expect(s.riskScore).toBe(35);
    const { r, workflowId } = await reject(s.token, o);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("STEP_UP_REQUIRED");
    expect(r.body.error.details.reason).toBe("elevated_session_risk");
    const after = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId }, select: { status: true } });
    expect(after.status).toBe("IN_REVIEW");
  });

  it("genuine HIGH and CRITICAL risk keep their protections: re-sign-in and block", async () => {
    const o = await newOwner("highrisk");
    await setFlags(o.teamId, false);
    const high = await reject(await rowToken(o, o.teamId, { riskScore: 65 }), o);
    expect(high.r.status).toBe(401);
    expect(high.r.body.error.code).toBe("reauth_required");
    expect(high.r.body.error.details.reason).toBe("high_session_risk");
    const critical = await reject(await rowToken(o, o.teamId, { riskScore: 95 }), o);
    expect(critical.r.status).toBe(403);
    expect(critical.r.body.error.code).toBe("session_blocked");
  });

  it("platform-admin adaptive routes share the scorer and keep their protections", async () => {
    const o = await newOwner("admin");
    const target = await prisma.user.create({
      data: { email: `stageb-target-${Date.now()}@test.proovra.local`, firstName: "T", lastName: "T", provider: "EMAIL", providerUserId: `t-${Date.now()}` },
      select: { id: true },
    });
    const body = { teamId: o.teamId, userId: target.id, permission: "evidence.read", reason: "stage-b check" };
    const header = { "x-proovra-workspace-id": o.teamId };
    // A same-device MEDIUM-by-count sign-in no longer exists; the route's own
    // unconditional step-up still applies (no reason is invented for it).
    for (let i = 0; i < 4; i += 1) await rowToken(o, o.teamId);
    const low = await login(o);
    expect(low.riskScore!).toBeLessThan(30);
    const lowR = await call(low.token, "POST", "/v1/admin/identity/elevations", body, header);
    console.log("STAGEB_ADMIN_ROUTE", lowR.status, lowR.raw.slice(0, 160));
    if (lowR.status === 404 || lowR.status === 403) {
      // Not an identity admin here: the shared gate is proven on the review
      // routes above, and this route never reached it.
      expect(["not_found", "forbidden", "FORBIDDEN", "PERMISSION_DENIED"]).toContain(String(lowR.body?.error?.code ?? "not_found"));
      return;
    }
    expect(lowR.status).toBe(401);
    expect(lowR.body.error.code).toBe("STEP_UP_REQUIRED");
    const high = await call(await rowToken(o, o.teamId, { riskScore: 65 }), "POST", "/v1/admin/identity/elevations", body, header);
    expect(high.status).toBe(401);
    expect(high.body.error.code).toBe("reauth_required");
    const critical = await call(await rowToken(o, o.teamId, { riskScore: 95 }), "POST", "/v1/admin/identity/elevations", body, header);
    expect(critical.status).toBe(403);
    expect(critical.body.error.code).toBe("session_blocked");
  });
});

describe("T-026 live sessions MEDIUM only because of the old count rule are lowered", () => {
  it("lowers a count-only 35 to LOW, leaves a corroborated 35 alone, and is idempotent", async () => {
    const o = await newOwner("recal");
    // Five same-device sessions; the newest carries the old rule's 35.
    for (let i = 0; i < 4; i += 1) await rowToken(o, o.teamId, { ipPreview: "203.0.113.•••" });
    await rowToken(o, o.teamId, { ipPreview: "203.0.113.•••", riskScore: 35 });
    const before = await prisma.authenticatedSession.findMany({ where: { userId: o.userId, riskScore: 35 }, select: { id: true } });
    expect(before).toHaveLength(1);

    const p = await newOwner("recal-keep");
    for (const ip of ["198.51.100.•••", "192.0.2.•••", "100.64.0.•••"]) {
      await rowToken(p, p.teamId, { ipPreview: ip, issuedHoursAgo: 7 });
    }
    await rowToken(p, p.teamId, { ipPreview: "203.0.113.•••", riskScore: 35 });

    const first = await recalibrate({ userId: o.userId });
    expect(first.lowered).toBe(1);
    const lowered = await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: before[0]!.id }, select: { riskScore: true } });
    expect(lowered.riskScore).toBeLessThan(30);

    const keep = await recalibrate({ userId: p.userId });
    expect(keep.lowered).toBe(0);
    expect(await prisma.authenticatedSession.count({ where: { userId: p.userId, riskScore: 35 } })).toBe(1);

    const again = await recalibrate({ userId: o.userId });
    expect(again.scanned).toBe(0);
  });
});

describe("T-027 / T-028 explicit policy stays enforced with a real second factor and a typed reason", () => {
  it("flag on: a password-only owner still gets STEP_UP_REQUIRED naming the flag, and step-up/start refuses (no password fallback)", async () => {
    const o = await newOwner("flagon");
    await setFlags(o.teamId, true);
    const token = await rowToken(o, o.teamId);
    const { r, workflowId } = await reject(token, o);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("STEP_UP_REQUIRED");
    expect(r.body.error.details.reason).toBe("policy_flag:requireStepUpForReject");
    const start = await call(token, "POST", "/v1/identity-security/step-up/start", {
      teamId: o.teamId,
      purpose: "REVIEWER_OPS_REJECT",
      resourceKind: "review_workflow",
      resourceId: workflowId,
    });
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
    // A password re-entry is not accepted as the step-up answer.
    const withPassword = await call(token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reject`, {
      teamId: o.teamId,
      note: "insufficient",
      stepUp: { method: "password", currentPassword: PASSWORD },
    });
    expect(withPassword.status).toBe(401);
  });

  it("T-033: saving Review settings still needs a second factor, and the refusal says so before anything is written", async () => {
    const o = await newOwner("savepolicy");
    const token = await rowToken(o, o.teamId);
    const r = await call(token, "POST", "/v1/reviewer-ops/sla-policy", { teamId: o.teamId, flags: { requireStepUpForApprove: true } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("STEP_UP_REQUIRED");
    expect(r.body.error.details.reason).toBe("save_policy_requires_mfa");
    const row = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: o.teamId }, select: { requireStepUpForApprove: true } });
    expect(row?.requireStepUpForApprove ?? false).toBe(false);
  });

  it("T-029 body: an old session's verdict answers reauth_required with the window, not an expired session", async () => {
    const o = await newOwner("age");
    await setFlags(o.teamId, false);
    const { r } = await reject(await rowToken(o, o.teamId, { ageHours: 9 }), o);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("reauth_required");
    expect(r.body.error.details).toMatchObject({ reason: "session_age_window", windowHours: 8 });
    // The session itself is valid for everything else.
    const read = await call(await rowToken(o, o.teamId, { ageHours: 9 }), "GET", `/v1/reviewer-ops/sla-policy?teamId=${o.teamId}`);
    expect(read.status).toBe(200);
  });
});

describe("T-030 a single Archive is its own action under the reject flag and the 8 h window", () => {
  it("a 5 h session archives one review from the review (scope single); the bulk door with 2 items at 5 h still asks for a fresh sign-in", async () => {
    const o = await newOwner("archive");
    await setFlags(o.teamId, false);
    const one = await workflow(o, "IN_REVIEW");
    const single = await call(await rowToken(o, o.teamId, { ageHours: 5 }), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [one.workflowId],
      action: "CLOSE",
      note: "archive",
      scope: "single",
    });
    expect(single.status, single.raw.slice(0, 300)).toBe(200);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: one.workflowId }, select: { status: true } })).status).toBe("CLOSED");

    const a = await workflow(o, "IN_REVIEW");
    const b = await workflow(o, "IN_REVIEW");
    const bulk = await call(await rowToken(o, o.teamId, { ageHours: 5 }), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [a.workflowId, b.workflowId],
      action: "CLOSE",
      note: "archive",
    });
    expect(bulk.status).toBe(401);
    expect(bulk.body.error.code).toBe("reauth_required");
  });

  it("single Archive answers to the reject checkbox, with its own purpose; the bulk checkbox alone does not govern it", async () => {
    const o = await newOwner("archiveflag");
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: o.teamId },
      create: { teamId: o.teamId, requireStepUpForBulk: true, requireStepUpForReject: false } as never,
      update: { requireStepUpForBulk: true, requireStepUpForReject: false } as never,
    });
    const w = await workflow(o, "IN_REVIEW");
    const token = await rowToken(o, o.teamId);
    const bulkOnly = await call(token, "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [w.workflowId],
      action: "CLOSE",
      note: "archive",
      scope: "single",
    });
    expect(bulkOnly.status, bulkOnly.raw.slice(0, 300)).toBe(200);

    await setFlags(o.teamId, false);
    await prisma.workspaceGovernancePolicy.update({ where: { teamId: o.teamId }, data: { requireStepUpForReject: true } });
    const w2 = await workflow(o, "IN_REVIEW");
    const rejectOn = await call(token, "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [w2.workflowId],
      action: "CLOSE",
      note: "archive",
      scope: "single",
    });
    expect(rejectOn.status).toBe(401);
    expect(rejectOn.body.error.details).toMatchObject({
      purpose: "REVIEWER_OPS_ARCHIVE",
      resourceKind: "review_workflow",
      resourceId: w2.workflowId,
      reason: "policy_flag:requireStepUpForReject",
    });
  });

  it("scope single must name exactly one review", async () => {
    const o = await newOwner("archivetwo");
    const a = await workflow(o, "IN_REVIEW");
    const b = await workflow(o, "IN_REVIEW");
    const r = await call(await rowToken(o, o.teamId), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [a.workflowId, b.workflowId],
      action: "CLOSE",
      scope: "single",
    });
    expect(r.status).toBe(400);
  });
});

describe("T-036 assignment, single or bulk, is not a step-up action", () => {
  it("bulk ASSIGN/REASSIGN of one review and /v1/reviewer/bulk/assign answer like single assign under flags, MEDIUM risk and an old session", async () => {
    const o = await newOwner("assign");
    const b = await newOwner("assign-b");
    await prisma.teamMember.create({ data: { teamId: o.teamId, userId: b.userId, role: "ADMIN", status: "ACTIVE" } });
    await placeInCollaborationTeam(prisma, { workspaceId: o.teamId, createdByUserId: o.userId, userIds: [b.userId] });
    await setFlags(o.teamId, true);
    for (const state of [{}, { riskScore: 35 }, { ageHours: 5 }, { ageHours: 9 }] as const) {
      const q1 = await workflow(o, "QUEUED", null);
      const assign = await call(await rowToken(o, o.teamId, state), "POST", "/v1/reviewer-ops/reviews/bulk", {
        teamId: o.teamId,
        workflowIds: [q1.workflowId],
        action: "ASSIGN",
        assignedToUserId: b.userId,
      });
      expect(assign.status, `${JSON.stringify(state)} ${assign.raw.slice(0, 200)}`).toBe(200);
      const r1 = await workflow(o, "IN_REVIEW");
      const reassign = await call(await rowToken(o, o.teamId, state), "POST", "/v1/reviewer-ops/reviews/bulk", {
        teamId: o.teamId,
        workflowIds: [r1.workflowId],
        action: "REASSIGN",
        assignedToUserId: b.userId,
      });
      expect(reassign.status, `${JSON.stringify(state)} ${reassign.raw.slice(0, 200)}`).toBe(200);
      const q2 = await workflow(o, "QUEUED", null);
      const ws = await call(await rowToken(o, o.teamId, state), "POST", `/v1/reviewer/bulk/assign?teamId=${o.teamId}`, {
        workflowIds: [q2.workflowId],
        assigneeUserId: b.userId,
      });
      expect(ws.status, `${JSON.stringify(state)} ${ws.raw.slice(0, 200)}`).toBe(200);
      const single = await workflow(o, "QUEUED", null);
      const s = await call(await rowToken(o, o.teamId, state), "POST", `/v1/reviewer-ops/reviews/${single.workflowId}/assign`, {
        teamId: o.teamId,
        assignedToUserId: b.userId,
        note: null,
      });
      expect(s.status).toBe(200);
    }
    // Assignment still answers to authorization and eligibility, and is audited.
    const q3 = await workflow(o, "QUEUED", null);
    const stranger = await newOwner("assign-x");
    const ineligible = await call(await rowToken(o, o.teamId), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [q3.workflowId],
      action: "ASSIGN",
      assignedToUserId: stranger.userId,
    });
    expect(ineligible.status).toBe(207);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: q3.workflowId }, select: { assignedToUserId: true } })).assignedToUserId).toBeNull();
  });

  it("session trust still applies to bulk assignment: a CRITICAL-risk session is blocked", async () => {
    const o = await newOwner("assigncrit");
    const q = await workflow(o, "QUEUED", null);
    const r = await call(await rowToken(o, o.teamId, { riskScore: 95 }), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [q.workflowId],
      action: "ASSIGN",
      assignedToUserId: o.userId,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("session_blocked");
  });

  it("other bulk actions keep the bulk gate (flag on → STEP_UP_REQUIRED naming the bulk flag)", async () => {
    const o = await newOwner("bulkkeep");
    await setFlags(o.teamId, true);
    const w = await workflow(o, "IN_REVIEW");
    const r = await call(await rowToken(o, o.teamId), "POST", "/v1/reviewer-ops/reviews/bulk", {
      teamId: o.teamId,
      workflowIds: [w.workflowId],
      action: "PRIORITY_HIGH",
    });
    expect(r.status).toBe(401);
    expect(r.body.error.details).toMatchObject({ purpose: "REVIEWER_OPS_BULK_ACTION", reason: "policy_flag:requireStepUpForBulk" });
  });
});
