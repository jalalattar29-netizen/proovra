/**
 * The step-up ceremony an integration test performs to satisfy
 * `requireStepUpForSensitiveAction` the way the StepUpModal does: enroll an
 * authenticator (TOTP), start a challenge for the purpose, check it with a
 * fresh code, then send the approved challenge id in
 * `x-proovra-step-up-challenge-id`. Real routes, real PostgreSQL — no bypass.
 */
import type { PrismaClient } from "@prisma/client";

type Inject = (opts: {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: unknown;
}) => Promise<{ statusCode: number; body: string; json: () => unknown }>;

export function createStepUpCeremony(deps: { prisma: PrismaClient; inject: Inject }) {
  const secrets = new Map<string, Buffer>();

  async function enroll(userId: string): Promise<void> {
    if (secrets.has(userId)) return;
    const totp = await import("../../src/services/security/mfa-totp.js");
    const { sealSecret } = await import("../../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await deps.prisma.mfaFactor.create({
      data: {
        userId,
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
    secrets.set(userId, secret);
  }

  async function freshCode(userId: string): Promise<string> {
    const totp = await import("../../src/services/security/mfa-totp.js");
    await deps.prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  /** Returns the header carrying an APPROVED challenge for this purpose. */
  async function approvedHeader(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind?: string;
    resourceId?: string;
  }): Promise<Record<string, string>> {
    await enroll(input.userId);
    const auth = { authorization: `Bearer ${input.token}` };
    const started = await deps.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: auth,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        ...(input.resourceKind ? { resourceKind: input.resourceKind } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      },
    });
    if (started.statusCode !== 200) throw new Error(`step-up start ${started.statusCode}: ${started.body}`);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    const checked = await deps.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      headers: auth,
      payload: { teamId: input.teamId, challengeId, code: await freshCode(input.userId) },
    });
    if (checked.statusCode !== 200) throw new Error(`step-up check ${checked.statusCode}: ${checked.body}`);
    return { "x-proovra-step-up-challenge-id": challengeId };
  }

  return { approvedHeader };
}
