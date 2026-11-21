/**
 * PRO-WZ-01 (WS-OUT RG-03) — a record whose first outputs were held by policy
 * was never released once its finalizing actor left the workspace: every
 * release path re-decided for the departed actor (no_workspace_membership for
 * ever). Live PostgreSQL, the real upload -> /complete route and the real
 * member-removal route; only the object store, signer and TSA are doubled
 * (the output-hold-release.integration.test.ts pattern).
 *
 *   * allowed: a departed held actor -> the record's current owner decides;
 *     under a permissive policy the release issues exactly one first request;
 *   * allowed: removal WITH a records transfer moves the held actor with the
 *     records (the transfer target decides from then on);
 *   * refused: a departed actor under a policy that still refuses stays held,
 *     nothing issued;
 *   * refused/control: an ACTIVE held actor is still the one asked (a viewer
 *     without the output permission keeps the hold even under a permissive
 *     policy — no substitution while the actor is a current member).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://wz01-store.invalid/${encodeURIComponent(id(p))}?n=${randomBytes(4).toString("hex")}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`wz01-sig:${hex}`).toString("base64"),
        keyId: "wz01-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

process.env.S3_BUCKET = "wz01-test-bucket";

describe("PRO-WZ-01 — held first outputs are released for a CURRENT actor (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let release: typeof import("../src/services/governance/output-hold-release.service.js");
  let hold: typeof import("../src/services/governance/output-hold.service.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legal: typeof import("../src/legal/legal-versioning.js");
  let clearRates: () => Promise<unknown>;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    release = await import("../src/services/governance/output-hold-release.service.js");
    hold = await import("../src/services/governance/output-hold.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    legal = await import("../src/legal/legal-versioning.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await prisma.team.update({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    await prisma?.workspaceGovernancePolicy.deleteMany({ where: { teamId: h.fixtures.teamA.teamId } }).catch(() => undefined);
    await h?.cleanup();
  }, 120_000);

  function call(method: "GET" | "POST", url: string, token: string, payload?: unknown) {
    return h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  }
  async function policy(over: Record<string, boolean>) {
    const base = {
      allowReportDownload: true,
      allowPackageDownload: true,
      allowPublicVerify: true,
      requireReviewBeforeReport: false,
      requireReviewBeforePackage: false,
    };
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, ...base, ...over } as never,
      update: { ...base, ...over } as never,
    });
  }
  async function member(role: "MEMBER" | "VIEWER") {
    const email = `wz01-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "WZ-01", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legal.REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const m = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return { id: user.id, token, memberId: m.id };
  }
  /** A sealed record whose first outputs the restrictive policy held. */
  async function heldRecord(): Promise<string> {
    await clearRates();
    await policy({ allowReportDownload: false, allowPublicVerify: false });
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "PHOTO", mimeType: "image/jpeg", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const bytes = Buffer.from(`wz01-${randomBytes(8).toString("hex")}`);
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "photo.jpg",
      sizeBytes: bytes.length,
    });
    expect(part.statusCode, part.body).toBe(201);
    const u = new URL(part.json().upload.putUrl as string);
    objects.set(decodeURIComponent(u.pathname.slice(1)), bytes);
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true, outputsHeldAtUtc: true } });
    expect(ev.status).toBe("SIGNED");
    expect(ev.outputsHeldAtUtc).not.toBeNull();
    return id;
  }
  const requests = (evidenceId: string) => prisma.reportGenerationRequest.count({ where: { evidenceId } });
  const heldAt = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { outputsHeldAtUtc: true } })).outputsHeldAtUtc;

  it("allowed: the finalizing actor left the workspace -> the record's owner decides and the release issues exactly once", async () => {
    const id = await heldRecord();
    const leaver = await member("MEMBER");
    await prisma.evidence.update({ where: { id }, data: { outputsHeldActorUserId: leaver.id } });
    await prisma.teamMember.update({ where: { id: leaver.memberId }, data: { status: "REVOKED" } });
    await policy({});
    expect(await release.releaseHeldOutputs(id)).toBe("released");
    expect(await heldAt(id)).toBeNull();
    expect(await requests(id)).toBe(1);
  });

  it("refused: a departed actor under a policy that still refuses stays held and nothing is issued", async () => {
    const id = await heldRecord();
    const leaver = await member("MEMBER");
    await prisma.evidence.update({ where: { id }, data: { outputsHeldActorUserId: leaver.id } });
    await prisma.teamMember.update({ where: { id: leaver.memberId }, data: { status: "SUSPENDED" } });
    // still refusing
    expect(await hold.tryLiftOutputHold(id)).toBe("still_held");
    expect(await heldAt(id)).not.toBeNull();
    expect(await requests(id)).toBe(0);
  });

  it("control: an ACTIVE held actor is still the one asked (a viewer keeps the hold under a permissive policy)", async () => {
    const id = await heldRecord();
    const viewer = await member("VIEWER");
    await prisma.evidence.update({ where: { id }, data: { outputsHeldActorUserId: viewer.id } });
    await policy({});
    expect(await hold.tryLiftOutputHold(id)).toBe("still_held");
    expect(await requests(id)).toBe(0);
  });

  it("allowed: removal WITH a records transfer moves the held actor to the transfer target with the records", async () => {
    const id = await heldRecord();
    const leaver = await member("MEMBER");
    await prisma.evidence.update({ where: { id }, data: { ownerUserId: leaver.id, outputsHeldActorUserId: leaver.id } });
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${A().teamId}/members/${leaver.memberId}`,
      headers: {
        authorization: `Bearer ${A().ownerToken}`,
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "MEMBER_REVOKE",
          resourceKind: "team_member",
          resourceId: leaver.memberId,
        })),
      },
      payload: { transferToUserId: A().ownerUserId },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { ownerUserId: true, outputsHeldActorUserId: true, outputsHeldAtUtc: true },
    });
    expect(ev.ownerUserId).toBe(A().ownerUserId);
    expect(ev.outputsHeldActorUserId).toBe(A().ownerUserId);
    expect(ev.outputsHeldAtUtc).not.toBeNull();
  });
});
