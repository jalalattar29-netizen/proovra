/* eslint-disable @typescript-eslint/no-explicit-any -- test support reads Prisma delegates and JSON bodies of many shapes. */
/**
 * Real actors for the coverage suites: a user row, legal acceptance, a membership
 * where one is asked for, and a signed session. Each suite states who may act, so
 * a refusal is read against a positive control on the same resource.
 */
import { randomUUID } from "node:crypto";

import type { IntegrationHarness } from "../integration-harness.js";

export type Person = { id: string; email: string; token: string };
export type Injected = { statusCode: number; body: string; json: () => any };

export type CoverageKit = {
  tag: () => string;
  /** A user with legal acceptance and a session; `role` adds an ACTIVE membership. */
  /** `mfaVerified` models a session that completed a second factor (platform authority needs one, AUD-0021). */
  person: (teamId: string | null, role?: string, opts?: { mfaVerified?: boolean }) => Promise<Person>;
  call: (
    method: string,
    url: string,
    who: { token: string } | null,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Injected>;
};

export async function coverageKit(h: IntegrationHarness): Promise<CoverageKit> {
  const { prisma } = await import("../../src/db.js");
  const { signJwt } = await import("../../src/services/jwt.js");
  const { REQUIRED_LEGAL_VERSIONS } = (await import("../../src/legal/legal-versioning.js")) as unknown as {
    REQUIRED_LEGAL_VERSIONS: Record<string, string>;
  };
  const tag = () => randomUUID().slice(0, 8);

  async function person(teamId: string | null, role?: string, opts?: { mfaVerified?: boolean }): Promise<Person> {
    const email = `cov-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, currentWorkspaceId: teamId } as never,
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    if (teamId && role) {
      await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } as never });
    }
    const token = signJwt(
      {
        sub: user.id,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        ...(opts?.mfaVerified ? { mfaAt: Math.floor(Date.now() / 1000) } : {}),
      },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, email, token };
  }

  const call: CoverageKit["call"] = async (method, url, who, payload, headers) => {
    const res = await h.app.inject({
      method: method as never,
      url,
      headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...(headers ?? {}) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return res as unknown as Injected;
  };

  return { tag, person, call };
}
