/**
 * Stage B — row-less legacy session tokens (T-038, T-039; SEC-01).
 *
 * Promotes `zz-audit2-sec-reconcile` Q1.3/Q1.4 to assertions. On e4e908e88:
 *   - a row-less token issued 9 h ago approved (200): no age window, no risk,
 *     no quarantine;
 *   - a row-less token was never listed under "My sessions";
 *   - "Sign out other sessions" and "change password + sign out others" left
 *     a row-less token working (200).
 * Now: the token is adopted into the inventory on its next request with its
 * real issue time (age windows apply), and both self-serve revocations write an
 * iat cut-off that ends every older token while the caller stays signed in.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let signJwt: typeof import("../src/services/jwt.js").signJwt;
let hashSessionId: (sid: string) => string;
let hashPassword: typeof import("../src/services/email-password-auth.service.js").hashPassword;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: any; raw: string };
type Owner = { userId: string; email: string; teamId: string };

const PASSWORD = "Correct-horse-9-battery";
const SECRET = () => process.env.AUTH_JWT_SECRET as string;

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
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
  const email = `stageb-rowless-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "Row", lastName: label, provider: "EMAIL", providerUserId: email },
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
  return { userId: user.id, email, teamId: space.teamId };
}

/** A token with an inventory row (every production sign-in since 2026-11-22). */
async function rowToken(o: Owner): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: o.userId, provider: "EMAIL", email: o.email, authMethod: "PASSWORD", authAt: now } as never, SECRET(), 3600);
  const sid = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
  await prisma.authenticatedSession.create({
    data: {
      userId: o.userId,
      teamId: o.teamId,
      sessionIdHash: hashSessionId(sid),
      issuedAtUtc: new Date(now * 1000),
      lastSeenAtUtc: new Date(),
      expiresAtUtc: new Date(Date.now() + 24 * 3600_000),
      authMethod: "PASSWORD",
    } as never,
  });
  return token;
}

/** The pre-2026-11-22 residue: a validly signed token whose sid has no row, issued `ageHours` ago. */
function rowlessToken(o: Owner, ageHours: number): string {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const iat = Math.floor(Date.now() / 1000) - Math.round(ageHours * 3600);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({ sub: o.userId, provider: "EMAIL", email: o.email, authMethod: "PASSWORD", authAt: iat, iat, exp: iat + 30 * 86400, sid: randomBytes(16).toString("hex") }),
  );
  const sig = b64(createHmac("sha256", SECRET()).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function sidOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
}

async function inReviewWorkflow(o: Owner): Promise<string> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: o.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `stage-b ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: o.teamId, organizationId: t.organizationId, ownerUserId: o.userId } as never,
      select: { id: true },
    })
  ).id;
  return (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: o.teamId, status: "IN_REVIEW" as never, workspaceType: "TEAM", assignedToUserId: o.userId, assignedAtUtc: new Date() } as never,
      select: { id: true },
    })
  ).id;
}

const probe = (o: Owner, token: string) => call(token, "GET", `/v1/reviewer-ops/sla-policy?teamId=${o.teamId}`);

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ signJwt } = await import("../src/services/jwt.js"));
  ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
  ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("T-038 row-less tokens are adopted and held to the privileged checks", () => {
  it("a row-less token issued 9 h ago is refused a verdict with reauth_required (session_age_window) and nothing is written", async () => {
    const o = await newOwner("old");
    const workflowId = await inReviewWorkflow(o);
    const r = await call(rowlessToken(o, 9), "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: o.teamId, note: "ok" });
    expect(r.status, r.raw.slice(0, 300)).toBe(401);
    expect(r.body.error.code).toBe("reauth_required");
    expect(r.body.error.details.reason).toBe("session_age_window");
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId }, select: { status: true } });
    expect(wf.status).toBe("IN_REVIEW");
  });

  it("a row-less token's first request writes its inventory row (issue time = iat), visible in My sessions and marked adopted", async () => {
    const o = await newOwner("adopt");
    const legacy = rowlessToken(o, 2);
    const hash = hashSessionId(sidOf(legacy));
    expect(await prisma.authenticatedSession.count({ where: { userId: o.userId, sessionIdHash: hash } })).toBe(0);
    const first = await probe(o, legacy);
    expect(first.status).toBe(200);
    const row = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: o.userId, sessionIdHash: hash },
      select: { authMethod: true, issuedAtUtc: true, teamId: true, revokedAtUtc: true },
    });
    expect(row.authMethod).toBe("ADOPTED_LEGACY");
    expect(row.teamId).toBe(o.teamId);
    expect(Math.abs(row.issuedAtUtc.getTime() - (Date.now() - 2 * 3600_000))).toBeLessThan(60_000);
    // Visible to the person from another session.
    const list = await call(await rowToken(o), "GET", "/v1/identity-security/my-sessions");
    expect(list.status).toBe(200);
    expect((list.body.sessions as unknown[]).length).toBe(2);
    // A second request reuses the same row.
    await probe(o, legacy);
    expect(await prisma.authenticatedSession.count({ where: { userId: o.userId, sessionIdHash: hash } })).toBe(1);
  });
});

describe("T-039 'sign out other sessions' and a password change end every other token", () => {
  it("revoke-others ends a never-adopted row-less token and an adopted one; the caller stays signed in", async () => {
    const o = await newOwner("revoke");
    const neverSeen = rowlessToken(o, 1);
    const adopted = rowlessToken(o, 1.5);
    expect((await probe(o, adopted)).status).toBe(200);
    const caller = await rowToken(o);
    const ro = await call(caller, "POST", "/v1/identity-security/my-sessions/revoke-others", {
      stepUp: { method: "password", currentPassword: PASSWORD },
    });
    expect(ro.status, ro.raw.slice(0, 300)).toBe(200);
    expect((await probe(o, neverSeen)).status).toBe(401);
    expect((await probe(o, adopted)).status).toBe(401);
    expect((await probe(o, caller)).status).toBe(200);
    // A sign-in after the action is unaffected.
    const later = await rowToken(o);
    expect((await probe(o, later)).status).toBe(200);
  });

  it("password change with sign-out-others ends a row-less token; the caller stays signed in", async () => {
    const o = await newOwner("pw");
    const victim = rowlessToken(o, 1);
    const caller = await rowToken(o);
    const pw = await call(caller, "POST", "/v1/identity-security/password", {
      currentPassword: PASSWORD,
      newPassword: "Another-horse-7-battery-x",
      revokeOtherSessions: true,
    });
    expect(pw.status, pw.raw.slice(0, 300)).toBe(200);
    expect((await probe(o, victim)).status).toBe(401);
    expect((await probe(o, caller)).status).toBe(200);
  });

  it("a caller that is itself an adopted legacy token survives its own revoke-others", async () => {
    const o = await newOwner("legacycaller");
    const older = rowlessToken(o, 3);
    const callerLegacy = rowlessToken(o, 2);
    const ro = await call(callerLegacy, "POST", "/v1/identity-security/my-sessions/revoke-others", {
      stepUp: { method: "password", currentPassword: PASSWORD },
    });
    expect(ro.status, ro.raw.slice(0, 300)).toBe(200);
    expect((await probe(o, callerLegacy)).status).toBe(200);
    expect((await probe(o, older)).status).toBe(401);
  });
});
