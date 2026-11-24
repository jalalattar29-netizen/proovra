/**
 * T-040 (P9) — REVOCATION STAYS FRICTIONLESS: a pin, by design.
 *
 * Revoking an External Review invitation reduces exposure, so it needs no
 * second factor and no fresh sign-in, even when every Review step-up checkbox
 * is on, the session is MEDIUM risk and older than every privileged window.
 * Issuing keeps its step-up. A future gate on revoke must be a conscious
 * decision that changes this test and docs/security/review-step-up-action-matrix.md.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import { signJwt } from "../src/services/jwt.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let stepUp: ReturnType<typeof createStepUpCeremony>;
let hashSessionId: (sid: string) => string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: any; raw: string };
const P = () => h.fixtures.personal;

async function call(token: string, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await h.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-proovra-workspace-id": P().teamId,
      ...headers,
    },
    payload: JSON.stringify(payload),
  });
  await h.handlersSettled();
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

/** MEDIUM risk (35) and issued 9 h ago: past every privileged window. */
async function riskyOldToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { sub: P().userId, provider: "EMAIL", authMethod: "PASSWORD", authAt: now } as never,
    process.env.AUTH_JWT_SECRET as string,
    3600,
  );
  const sid = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
  await prisma.authenticatedSession.create({
    data: {
      userId: P().userId,
      teamId: P().teamId,
      sessionIdHash: hashSessionId(sid),
      issuedAtUtc: new Date(Date.now() - 9 * 3600_000),
      lastSeenAtUtc: new Date(),
      expiresAtUtc: new Date(Date.now() + 24 * 3600_000),
      authMethod: "PASSWORD",
      riskScore: 35,
    } as never,
  });
  return token;
}

const issueBody = () => ({
  expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  defaultScope: { kind: "EVIDENCE", evidenceId: P().evidenceId },
  rows: [{ inviteEmail: `pin-${randomUUID().slice(0, 8)}@test.proovra.local` }],
});

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
  stepUp = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
  await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
  await prisma.entitlement.create({ data: { userId: P().userId, plan: "TEAM", active: true, credits: 0 } });
  const flags = {
    requireStepUpForApprove: true,
    requireStepUpForReject: true,
    requireStepUpForEscalationResolve: true,
    requireStepUpForBulk: true,
  };
  await prisma.workspaceGovernancePolicy.upsert({
    where: { teamId: P().teamId },
    create: { teamId: P().teamId, ...flags } as never,
    update: flags as never,
  });
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

describe("T-040 revocation needs no step-up; issuing keeps it", () => {
  it("issue without a challenge → 401 STEP_UP_REQUIRED; revoke from a MEDIUM-risk, 9 h old session with every flag on → 200", async () => {
    const unchallenged = await call(P().token, "/v1/external-review/invitations/bulk", issueBody());
    expect(unchallenged.status).toBe(401);
    expect(unchallenged.body.error.code).toBe("STEP_UP_REQUIRED");

    const header = await stepUp.approvedHeader({
      token: P().token,
      userId: P().userId,
      teamId: P().teamId,
      purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
      resourceKind: "external_review_grant_bulk",
    });
    const issued = await call(P().token, "/v1/external-review/invitations/bulk", issueBody(), header);
    expect(issued.status, issued.raw.slice(0, 300)).toBe(201);
    const grantId = issued.body.rows[0].grantId as string;

    const revoked = await call(await riskyOldToken(), `/v1/external-review/invitations/${grantId}/revoke`, {
      workspaceId: P().teamId,
    });
    expect(revoked.status, revoked.raw.slice(0, 300)).toBe(200);
  });
});
