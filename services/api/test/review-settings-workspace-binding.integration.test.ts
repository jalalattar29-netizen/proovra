/**
 * Stage B — Review settings workspace binding (T-041, T-042; MEM-05, SEC-06).
 *
 * Promotes `zz-audit2-sec-reconcile` Q4 and `zz-audit2-members-matrix`
 * `sla_cross` to assertions. On e4e908e88 a save with the active-workspace
 * header naming A and a body naming B (a valid B challenge) wrote B's policy
 * (200), and the GET carried no version a client could send back.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let sealSecret: typeof import("../src/services/security/mfa-secret-storage.js").sealSecret;
let totp: typeof import("../src/services/security/mfa-totp.js");
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: any; raw: string };
type User = { userId: string; email: string; token: string; factorId: string | null };
type Space = { teamId: string; owner: User };

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
async function newUser(label: string, mfa = false): Promise<User> {
  seq += 1;
  const email = `stageb-ws-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "Ws", lastName: label, provider: "EMAIL", providerUserId: email },
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
  let factorId: string | null = null;
  if (mfa) {
    const sealed = sealSecret(totp.generateTotpSecretBytes());
    const now = new Date();
    factorId = (
      await prisma.mfaFactor.create({
        data: {
          userId: user.id,
          kind: "TOTP",
          status: "ACTIVE",
          label: "Authenticator",
          secretCiphertext: Buffer.from(sealed.ciphertext),
          secretIv: Buffer.from(sealed.iv),
          secretAuthTag: Buffer.from(sealed.authTag),
          secretKekId: sealed.kekId,
          verifiedAtUtc: now,
          enrolledAt: now,
        },
        select: { id: true },
      })
    ).id;
  }
  return { userId: user.id, email, token: await harness.mintSessionToken(user.id, email), factorId };
}

async function teamSpace(label: string, mfa = false): Promise<Space> {
  const owner = await newUser(label, mfa);
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  await prisma.user.update({ where: { id: owner.userId }, data: { currentWorkspaceId: space.teamId } });
  return { teamId: space.teamId, owner };
}

async function challenge(u: User, teamId: string, purpose: string, resourceKind: string, resourceId: string): Promise<string> {
  const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: u.factorId! } });
  return (
    await prisma.stepUpChallenge.create({
      data: {
        teamId,
        initiatedByUserId: u.userId,
        purpose,
        resourceKind,
        resourceId,
        status: "APPROVED" as never,
        factorId: factor.id,
        factorGeneration: factor.generation,
        approvedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000),
      } as never,
    })
  ).id;
}

const policyChallenge = (u: User, teamId: string) =>
  challenge(u, teamId, "GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", teamId);

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ sealSecret } = await import("../src/services/security/mfa-secret-storage.js"));
  totp = await import("../src/services/security/mfa-totp.js");
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("T-042 a mutation naming another workspace than the active-workspace header answers 409", () => {
  it("Review settings: header A + body B (valid B challenge) → 409 WORKSPACE_MISMATCH, B unchanged; header B + body B → 200", async () => {
    const a = await teamSpace("a", true);
    const u = a.owner;
    const b = await teamSpace("b");
    await prisma.teamMember.create({ data: { teamId: b.teamId, userId: u.userId, role: "ADMIN", status: "ACTIVE" } });
    await placeInCollaborationTeam(prisma, { workspaceId: b.teamId, createdByUserId: b.owner.userId, userIds: [u.userId] });
    const overrides = { assignmentHours: 2, firstReviewHours: 6, escalationHours: 12, completionHours: 30 };

    const crossed = await call(
      u.token,
      "POST",
      "/v1/reviewer-ops/sla-policy",
      { teamId: b.teamId, overrides, flags: { requireStepUpForApprove: true } },
      { "x-proovra-workspace-id": a.teamId, "x-proovra-step-up-challenge-id": await policyChallenge(u, b.teamId) },
    );
    expect(crossed.status, crossed.raw.slice(0, 300)).toBe(409);
    expect(crossed.body.error.code).toBe("WORKSPACE_MISMATCH");
    const bRow = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: b.teamId }, select: { requireStepUpForApprove: true } });
    expect(bRow?.requireStepUpForApprove ?? false).toBe(false);

    const same = await call(
      u.token,
      "POST",
      "/v1/reviewer-ops/sla-policy",
      { teamId: b.teamId, flags: { requireStepUpForApprove: true } },
      { "x-proovra-workspace-id": b.teamId, "x-proovra-step-up-challenge-id": await policyChallenge(u, b.teamId) },
    );
    expect(same.status, same.raw.slice(0, 300)).toBe(200);

    // A read naming another workspace is unchanged (reads are not refused).
    const read = await call(u.token, "GET", `/v1/reviewer-ops/sla-policy?teamId=${b.teamId}`, undefined, { "x-proovra-workspace-id": a.teamId });
    expect(read.status).toBe(200);
    // No header: unchanged (older clients and scripts).
    const noHeader = await call(
      u.token,
      "POST",
      "/v1/reviewer-ops/sla-policy",
      { teamId: b.teamId, flags: { requireStepUpForApprove: false } },
      { "x-proovra-step-up-challenge-id": await policyChallenge(u, b.teamId) },
    );
    expect(noHeader.status).toBe(200);
  });

  it("review mutations: assign with header B naming workspace A → 409, nothing assigned", async () => {
    const a = await teamSpace("assign-a");
    const b = await teamSpace("assign-b");
    await prisma.teamMember.create({ data: { teamId: b.teamId, userId: a.owner.userId, role: "ADMIN", status: "ACTIVE" } });
    const t = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } });
    const evidenceId = (
      await prisma.evidence.create({
        data: { title: `stage-b ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: a.teamId, organizationId: t.organizationId, ownerUserId: a.owner.userId } as never,
        select: { id: true },
      })
    ).id;
    const workflowId = (
      await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId, teamId: a.teamId, status: "QUEUED" as never, workspaceType: "TEAM" } as never,
        select: { id: true },
      })
    ).id;
    const r = await call(
      a.owner.token,
      "POST",
      `/v1/reviewer-ops/reviews/${workflowId}/assign`,
      { teamId: a.teamId, assignedToUserId: a.owner.userId, note: null },
      { "x-proovra-workspace-id": b.teamId },
    );
    expect(r.status, r.raw.slice(0, 300)).toBe(409);
    expect(r.body.error.code).toBe("WORKSPACE_MISMATCH");
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId }, select: { assignedToUserId: true } });
    expect(wf.assignedToUserId).toBeNull();
    const ok = await call(
      a.owner.token,
      "POST",
      `/v1/reviewer-ops/reviews/${workflowId}/assign`,
      { teamId: a.teamId, assignedToUserId: a.owner.userId, note: null },
      { "x-proovra-workspace-id": a.teamId },
    );
    expect(ok.status, ok.raw.slice(0, 300)).toBe(200);
  });
});

describe("T-041 the policy read carries the version a save sends back", () => {
  it("GET returns version and teamId; a save with the version it read succeeds and a stale one answers 409", async () => {
    const a = await teamSpace("ver", true);
    const u = a.owner;
    const read = await call(u.token, "GET", `/v1/reviewer-ops/sla-policy?teamId=${a.teamId}`);
    expect(read.status).toBe(200);
    expect(typeof read.body.version).toBe("number");
    expect(read.body.teamId).toBe(a.teamId);
    const v0 = read.body.version as number;

    const saved = await call(
      u.token,
      "POST",
      "/v1/reviewer-ops/sla-policy",
      { teamId: a.teamId, expectedVersion: v0, flags: { reviewerInactivityHours: 48 } },
      { "x-proovra-workspace-id": a.teamId, "x-proovra-step-up-challenge-id": await policyChallenge(u, a.teamId) },
    );
    expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
    expect(saved.body.version).toBeGreaterThan(v0);

    const stale = await call(
      u.token,
      "POST",
      "/v1/reviewer-ops/sla-policy",
      { teamId: a.teamId, expectedVersion: v0, flags: { reviewerInactivityHours: 72 } },
      { "x-proovra-workspace-id": a.teamId, "x-proovra-step-up-challenge-id": await policyChallenge(u, a.teamId) },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("POLICY_VERSION_CONFLICT");
  });
});
