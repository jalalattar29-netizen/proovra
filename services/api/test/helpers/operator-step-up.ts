/**
 * A platform operator exactly as production has one: a DB platform role, a
 * verified authenticator app, and a workspace to stand in, plus a step-up
 * approved through the real routes.
 */
import { expect } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { registerSessionForToken, seedUser, type FixtureDeps } from "../point7/product-fixtures.js";

type Prisma = import("@prisma/client").PrismaClient;

export type Operator = {
  userId: string;
  email: string;
  token: string;
  stepUpTeamId: string;
  nextCode: () => string;
};

export async function seedOperator(
  harness: IntegrationHarness,
  deps: FixtureDeps,
  prisma: Prisma,
  label = "operator",
): Promise<Operator> {
  const totp = await import("../../src/services/security/mfa-totp.js");
  const { sealSecret } = await import("../../src/services/security/mfa-secret-storage.js");
  const { signJwt } = await import("../../src/services/jwt.js");

  const user = await seedUser(deps, label);
  await prisma.user.update({ where: { id: user.userId }, data: { platformRole: "admin" } });
  const token = signJwt(
    {
      sub: user.userId,
      provider: "EMAIL",
      email: user.email,
      authMethod: "PASSWORD",
      authAt: Math.floor(Date.now() / 1000),
      role: "admin" as const,
    },
    process.env.AUTH_JWT_SECRET as string,
    3600,
  );
  await registerSessionForToken(deps, user.userId, token);
  const stepUpTeamId = harness.fixtures.teamA.teamId;
  await prisma.teamMember.create({
    data: { teamId: stepUpTeamId, userId: user.userId, role: "ADMIN", status: "ACTIVE" },
  });

  const secret = totp.generateTotpSecretBytes();
  const sealed = sealSecret(secret);
  const now = new Date();
  await prisma.mfaFactor.create({
    data: {
      userId: user.userId,
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
  });

  // The next code the replay guard accepts: later than the last one spent.
  let lastStep = -Infinity;
  const nextCode = (): string => {
    const nowSeconds = Date.now() / 1000;
    const current = totp.timeStep(Math.floor(nowSeconds));
    // The server accepts current ±1. The previous step leaves the window at the next boundary, so it is
    // used only while at least 5 s of the current step remain; otherwise a boundary crossed in flight
    // (CI load) turns a correct code into a denial.
    const oldest = nowSeconds % 30 < 25 ? current - 1 : current;
    const step = Math.max(lastStep + 1, oldest);
    if (step > current + 1) throw new Error("no unspent TOTP step left in the window");
    lastStep = step;
    return totp.computeTotpCode(secret, step);
  };
  return { ...user, token, stepUpTeamId, nextCode };
}

/** Start and approve a step-up through the real routes; returns the challenge id. */
export async function approvedStepUp(
  harness: IntegrationHarness,
  operator: Operator,
  purpose: string,
  resourceKind: string,
  resourceId: string | null,
): Promise<string> {
  const headers = { authorization: `Bearer ${operator.token}` };
  const started = await harness.app.inject({
    method: "POST",
    url: "/v1/identity-security/step-up/start",
    headers,
    payload: {
      teamId: operator.stepUpTeamId,
      purpose,
      resourceKind,
      ...(resourceId ? { resourceId } : {}),
    },
  });
  expect(started.statusCode, started.body).toBe(200);
  const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
  const checked = await harness.app.inject({
    method: "POST",
    url: "/v1/identity-security/step-up/check",
    headers,
    payload: { teamId: operator.stepUpTeamId, challengeId, code: operator.nextCode() },
  });
  expect(checked.statusCode, checked.body).toBe(200);
  return challengeId;
}
