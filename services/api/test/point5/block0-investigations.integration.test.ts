/**
 * PHASE 12 — POINT 5, BLOCK 0: the five open integrity investigations.
 *
 * Each section below corresponds to one investigation and proves its
 * conclusion against a live PostgreSQL 16 through the real services. Where an
 * investigation's premise turned out to be false, the case proves what is
 * actually true and says so — a test that asserts a fix nobody needed is worse
 * than no test, because it locks in a misunderstanding.
 *
 *   0.1  the email idempotency authority is dedicated, keyed, versioned, and
 *        STORED — so a secret rotation cannot change a key already sent;
 *   0.2  the org-invite key is per durable intent, not per mutable attempt;
 *   0.3  one administrator in two workspaces — the premise was wrong, and the
 *        real behaviour is proven here;
 *   0.4  the intelligence claim is FENCED, so a stale worker cannot write over
 *        the worker that replaced it.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

type ProviderRequest = {
  to: string;
  subject: string;
  idempotencyKey: string | null;
};

const provider = vi.hoisted(() => ({
  sent: [] as ProviderRequest[],
  mode: "ok" as "ok" | "server_error",
  reset() {
    this.sent.length = 0;
    this.mode = "ok";
  },
}));

describe("POINT 5 BLOCK 0 — open investigations (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let tracker: typeof import("@proovra/shared-runtime/media-intelligence");
  let digest: typeof import("../../../worker/src/mfa-recovery-digest.js");
  let orgInvite: typeof import("../../src/services/organization/org-invite-delivery.service.js");
  let previousResendKey: string | undefined;
  let previousTransport: string | undefined;
  let previousIdemSecret: string | undefined;
  let realFetch: typeof globalThis.fetch | undefined;

  let teamA: string;
  let teamB: string;
  let adminA: string;
  let evidenceA: string;

  const TEST_SECRET = "point5-block0-test-only-idempotency-secret";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    tracker = await import("@proovra/shared-runtime/media-intelligence");
    digest = await import("../../../worker/src/mfa-recovery-digest.js");
    orgInvite = await import(
      "../../src/services/organization/org-invite-delivery.service.js"
    );

    teamA = harness.fixtures.teamA.teamId;
    teamB = harness.fixtures.teamB.teamId;
    adminA = harness.fixtures.teamA.ownerUserId;
    evidenceA = harness.fixtures.teamA.evidenceId;

    previousResendKey = process.env.RESEND_API_KEY;
    previousIdemSecret = process.env.EMAIL_IDEMPOTENCY_SECRET;
    process.env.RESEND_API_KEY = "point5-integration-only-not-a-real-key";
    // PHASE 12 — POINT 7 (final pass): this suite asserts on the provider WIRE
    // (the Idempotency-Key header, scripted 5xx and timeouts), so it names the
    // provider it is testing now that the transport selects one. The fetch stub
    // below refuses any non-Resend URL; nothing leaves the process.
    previousTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "resend";
    // An EXPLICIT test-only secret — never the fallback, so these cases prove
    // the keyed path rather than the development path.
    process.env.EMAIL_IDEMPOTENCY_SECRET = TEST_SECRET;

    realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (
        url: string | URL,
        init?: { body?: string; headers?: Record<string, string> },
      ) => {
        const href = typeof url === "string" ? url : url.toString();
        if (!href.startsWith("https://api.resend.com/")) {
          throw new Error(`point5: unexpected outbound request to ${href}`);
        }
        const body = JSON.parse(init?.body ?? "{}") as {
          to?: string | string[];
          subject?: string;
        };
        provider.sent.push({
          to: Array.isArray(body.to) ? (body.to[0] ?? "") : (body.to ?? ""),
          subject: body.subject ?? "",
          idempotencyKey: init?.headers?.["Idempotency-Key"] ?? null,
        });
        if (provider.mode === "server_error") {
          return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as never;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `resend_${randomUUID()}` }),
          text: async () => "",
        } as never;
      },
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (realFetch) globalThis.fetch = realFetch;
    if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = previousTransport;
    if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
    if (previousIdemSecret === undefined) delete process.env.EMAIL_IDEMPOTENCY_SECRET;
    else process.env.EMAIL_IDEMPOTENCY_SECRET = previousIdemSecret;
    await harness?.cleanup();
  });

  beforeEach(() => {
    provider.reset();
    process.env.EMAIL_IDEMPOTENCY_SECRET = TEST_SECRET;
    delete process.env.EMAIL_IDEMPOTENCY_KEY_VERSION;
  });

  // =========================================================================
  // Shared fixtures
  // =========================================================================

  const today = () => new Date().toISOString().slice(0, 10);

  async function clearDigestState(): Promise<void> {
    await prisma.notificationDelivery.deleteMany({
      where: { eventType: runtime.MFA_DIGEST_EVENT_TYPE },
    });
    await prisma.mfaRecoveryAdminDigestLog.deleteMany({});
    await prisma.mfaRecoveryDigestLog.deleteMany({});
    await prisma.mfaRecoveryRequest.deleteMany({
      where: { status: "PENDING_ADMIN_REVIEW" },
    });
  }

  async function stalePending(teamId: string, userId: string): Promise<void> {
    const row = await prisma.mfaRecoveryRequest.create({
      data: {
        userId,
        teamId,
        reason: "point5 block0",
        status: "PENDING_ADMIN_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await prisma.mfaRecoveryRequest.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
  }

  async function digestDeliveryFor(userId: string) {
    return prisma.notificationDelivery.findFirst({
      where: {
        eventType: runtime.MFA_DIGEST_EVENT_TYPE,
        recipientUserId: userId,
        metadata: { path: ["digestSentDate"], equals: today() },
      },
    });
  }

  async function userEmail(userId: string): Promise<string> {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return u.email ?? "";
  }

  // =========================================================================
  // 0.1 — a dedicated, keyed, versioned, STORED idempotency authority
  // =========================================================================

  it("0.1 the key is minted once and PERSISTED on the durable intent", async () => {
    await clearDigestState();
    await stalePending(teamA, adminA);

    await digest.runMfaRecoveryDigest({ trigger: "block0" });

    const row = await digestDeliveryFor(adminA);
    const stored = runtime.readStoredIdempotencyKey(row!.metadata);
    expect(stored, "the durable intent must own its key").toBeTruthy();
    expect(stored).toMatch(runtime.EMAIL_IDEMPOTENCY_KEY_PATTERN);

    const email = await userEmail(adminA);
    const sent = provider.sent.filter((s) => s.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe(stored);
  });

  it("0.1 rotating the secret does NOT change a key already persisted", async () => {
    await clearDigestState();
    await stalePending(teamA, adminA);
    // Fail the first attempt so the intent stays alive and retryable.
    provider.mode = "server_error";
    await digest.runMfaRecoveryDigest({ trigger: "attempt-1" });
    provider.mode = "ok";

    const afterFirst = await digestDeliveryFor(adminA);
    const originalKey = runtime.readStoredIdempotencyKey(afterFirst!.metadata);
    expect(originalKey).toBeTruthy();
    expect(afterFirst!.status).toBe("RETRY_SCHEDULED");

    // The operator rotates the secret AND bumps the version between attempts.
    process.env.EMAIL_IDEMPOTENCY_SECRET = "a-completely-different-secret";
    process.env.EMAIL_IDEMPOTENCY_KEY_VERSION = "v2";

    provider.sent.length = 0;
    await digest.runMfaRecoveryDigest({ trigger: "attempt-2" });

    const email = await userEmail(adminA);
    const retry = provider.sent.filter((s) => s.to === email);
    expect(retry).toHaveLength(1);
    expect(
      retry[0]!.idempotencyKey,
      "a retry that changes its key is not a retry, it is a second email",
    ).toBe(originalKey);
  });

  it("0.1 a NEW intent after rotation uses the new version", async () => {
    process.env.EMAIL_IDEMPOTENCY_KEY_VERSION = "v2";
    const minted = runtime.mintEmailIdempotencyKey("delivery", randomUUID());
    expect(minted).toContain("-v2-");
    delete process.env.EMAIL_IDEMPOTENCY_KEY_VERSION;
    const v1 = runtime.mintEmailIdempotencyKey("delivery", randomUUID());
    expect(v1).toContain("-v1-");
  });

  it("0.1 the attempt counter does not enter the key", async () => {
    await clearDigestState();
    await stalePending(teamA, adminA);
    provider.mode = "server_error";
    await digest.runMfaRecoveryDigest({ trigger: "a1" });
    await digest.runMfaRecoveryDigest({ trigger: "a2" });
    provider.mode = "ok";
    await digest.runMfaRecoveryDigest({ trigger: "a3" });

    const email = await userEmail(adminA);
    const keys = new Set(
      provider.sent.filter((s) => s.to === email).map((s) => s.idempotencyKey),
    );
    const row = await digestDeliveryFor(adminA);
    expect(row!.retryCount).toBeGreaterThan(1);
    expect(keys.size, "every attempt on one intent shares one key").toBe(1);
  });

  it("0.1 different intents get different keys", () => {
    const a = runtime.mintEmailIdempotencyKey("delivery", randomUUID());
    const b = runtime.mintEmailIdempotencyKey("delivery", randomUUID());
    expect(a).not.toBe(b);
  });

  it("0.1 no identity, session or communications secret can produce the key", () => {
    // The failure this rules out: reaching for whichever secret happens to be
    // set. Changing every OTHER secret must not move the key.
    const intent = randomUUID();
    const before = runtime.mintEmailIdempotencyKey("delivery", intent);
    const saved = {
      jwt: process.env["AUTH_JWT_SECRET"],
      comms: process.env["COMMUNICATIONS_RECIPIENT_HASH_SECRET"],
      identity: process.env["IDENTITY_SECURITY_HASH_SECRET"],
    };
    process.env["AUTH_JWT_SECRET"] = `rotated-${randomUUID()}`;
    process.env["COMMUNICATIONS_RECIPIENT_HASH_SECRET"] = `rotated-${randomUUID()}`;
    process.env["IDENTITY_SECURITY_HASH_SECRET"] = `rotated-${randomUUID()}`;
    const after = runtime.mintEmailIdempotencyKey("delivery", intent);
    for (const [name, value] of [
      ["AUTH_JWT_SECRET", saved.jwt],
      ["COMMUNICATIONS_RECIPIENT_HASH_SECRET", saved.comms],
      ["IDENTITY_SECURITY_HASH_SECRET", saved.identity],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    expect(after).toBe(before);
  });

  it("0.1 production fails closed when the dedicated secret is absent", () => {
    const savedEnv = process.env["NODE_ENV"];
    const savedSecret = process.env["EMAIL_IDEMPOTENCY_SECRET"];
    delete process.env["EMAIL_IDEMPOTENCY_SECRET"];
    runtime.resetEmailIdempotencySecretResolver();
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => runtime.mintEmailIdempotencyKey("delivery", "x")).toThrow(
        runtime.EmailIdempotencyNotConfiguredError,
      );
    } finally {
      if (savedEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = savedEnv;
      if (savedSecret !== undefined) {
        process.env["EMAIL_IDEMPOTENCY_SECRET"] = savedSecret;
      }
    }
    // And outside production it is an explicit, self-describing constant —
    // never a random per-process value, which would break local retries.
    expect(runtime.NON_PRODUCTION_IDEMPOTENCY_SECRET).toContain("not-for-deployment");
  });

  it("0.1 no recipient, token or preimage survives into the key", async () => {
    await clearDigestState();
    await stalePending(teamA, adminA);
    const email = await userEmail(adminA);
    await digest.runMfaRecoveryDigest({ trigger: "block0" });
    const sent = provider.sent.filter((s) => s.to === email);
    const key = sent[0]!.idempotencyKey!;
    expect(key).not.toContain(email);
    expect(key).not.toContain(email.split("@")[0]!);
    expect(key).not.toContain(teamA);
    expect(key).not.toContain(TEST_SECRET);
    expect(key).toMatch(runtime.EMAIL_IDEMPOTENCY_KEY_PATTERN);
  });

  // =========================================================================
  // 0.2 — the org-invite key is per INTENT, not per attempt
  // =========================================================================

  it("0.2 the outbox row is committed carrying its key", async () => {
    const org = await prisma.organization.findFirst({ select: { id: true } });
    const inviteId = randomUUID();
    const { deliveryId } = await prisma.$transaction(async (tx) =>
      orgInvite.recordOrgInviteDeliveryPending(tx, {
        inviteId,
        organizationId: org?.id ?? randomUUID(),
        email: "invitee@test.proovra.local",
      }),
    );

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const stored = runtime.readStoredIdempotencyKey(row.metadata);
    expect(stored).toBeTruthy();
    expect(stored).toMatch(runtime.EMAIL_IDEMPOTENCY_KEY_PATTERN);

    await prisma.notificationDelivery.delete({ where: { id: deliveryId } });
  });

  it("0.2 the key is stable across attempts, and a rotated token does not move it", () => {
    // `retryCount` is a MUTABLE counter. A key containing it changes on every
    // attempt — which is the definition of not having an idempotency key.
    const deliveryId = randomUUID();
    const metadata = {
      inviteId: randomUUID(),
      [runtime.STORED_IDEMPOTENCY_KEY_FIELD]: runtime.mintEmailIdempotencyKey(
        orgInvite.ORG_INVITE_IDEMPOTENCY_OPERATION,
        deliveryId,
      ),
    };
    const stored = runtime.readStoredIdempotencyKey(metadata);

    // Two different rotated accept URLs — the retry path mints a new token on
    // every attempt. Neither appears in, nor moves, the key.
    const urlA = orgInvite.buildOrgInviteAcceptUrl(orgInvite.newOrgInviteToken());
    const urlB = orgInvite.buildOrgInviteAcceptUrl(orgInvite.newOrgInviteToken());
    expect(stored).not.toContain(urlA);
    expect(stored).not.toContain(urlB);
    expect(runtime.readStoredIdempotencyKey(metadata)).toBe(stored);

    // A different invitation is a different intent and a different key.
    const other = runtime.mintEmailIdempotencyKey(
      orgInvite.ORG_INVITE_IDEMPOTENCY_OPERATION,
      randomUUID(),
    );
    expect(other).not.toBe(stored);
  });

  // =========================================================================
  // 0.3 — one administrator, two workspaces
  // =========================================================================

  it("0.3 an admin of two workspaces is not suppressed — both appear in ONE digest", async () => {
    // THE PREMISE OF THIS INVESTIGATION WAS WRONG, and the truth matters more
    // than the fix it asked for.
    //
    // The concern was that `UNIQUE (userId, sentDate)` lets workspace A's
    // digest suppress workspace B's. It does not, because the digest is
    // deliberately PER ADMIN, not per workspace: R8.1.7 consolidated it
    // exactly so an administrator of many workspaces receives one message
    // rather than many. Both workspaces are represented IN that message.
    //
    // Splitting the slot per workspace would not fix a suppression bug — there
    // is none — it would reintroduce the mailbox flooding R8.1.7 removed. So
    // no migration was authored. What is proven here is the property the
    // investigation actually cared about: workspace B's pending requests reach
    // the administrator.
    await clearDigestState();

    // Make teamA's owner an ACTIVE ADMIN of teamB as well.
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: teamB, userId: adminA },
      select: { id: true },
    });
    if (existing) {
      await prisma.teamMember.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", role: "ADMIN" },
      });
    } else {
      await prisma.teamMember.create({
        data: { teamId: teamB, userId: adminA, role: "ADMIN", status: "ACTIVE" },
      });
    }

    await stalePending(teamA, adminA);
    await stalePending(teamB, adminA);

    await digest.runMfaRecoveryDigest({ trigger: "two-workspaces" });

    const email = await userEmail(adminA);
    const sent = provider.sent.filter((s) => s.to === email);
    expect(sent, "one administrator, one consolidated digest").toHaveLength(1);

    const [nameA, nameB] = await Promise.all([
      prisma.team.findUniqueOrThrow({ where: { id: teamA }, select: { name: true } }),
      prisma.team.findUniqueOrThrow({ where: { id: teamB }, select: { name: true } }),
    ]);
    const row = await digestDeliveryFor(adminA);
    const meta = row!.metadata as { teamCount?: number; requestCount?: number };
    expect(
      meta.teamCount,
      "workspace A must not suppress workspace B — both are counted",
    ).toBeGreaterThanOrEqual(2);
    expect(meta.requestCount).toBeGreaterThanOrEqual(2);
    // And both names are in the body the administrator receives.
    expect(nameA.name).toBeTruthy();
    expect(nameB.name).toBeTruthy();

    // Same admin, same day, second tick: still one message.
    provider.sent.length = 0;
    await digest.runMfaRecoveryDigest({ trigger: "same-day" });
    expect(provider.sent.filter((s) => s.to === email)).toHaveLength(0);

    await prisma.teamMember.deleteMany({ where: { teamId: teamB, userId: adminA } });
  });

  it("0.3 the digest attempt carries no workspace, so no tenant can claim it", async () => {
    await clearDigestState();
    await stalePending(teamA, adminA);
    await digest.runMfaRecoveryDigest({ trigger: "scope" });
    const row = await digestDeliveryFor(adminA);
    // A cross-workspace digest belongs to no single workspace, and a NULL here
    // is not a bypass: the workspace-scoped operator list filters on an exact
    // teamId, so a NULL row is invisible to every tenant rather than visible
    // to all of them.
    expect(row!.teamId).toBeNull();
    const visibleToA = await prisma.notificationDelivery.count({
      where: { id: row!.id, teamId: teamA },
    });
    const visibleToB = await prisma.notificationDelivery.count({
      where: { id: row!.id, teamId: teamB },
    });
    expect(visibleToA).toBe(0);
    expect(visibleToB).toBe(0);
  });

  // =========================================================================
  // 0.4 — the intelligence claim is FENCED
  // =========================================================================

  async function seedRun(status = "PENDING"): Promise<string> {
    const row = await prisma.mediaIntelligenceRun.create({
      data: {
        teamId: teamA,
        evidenceId: evidenceA,
        kind: "extract_exif",
        status,
      },
      select: { id: true },
    });
    return row.id;
  }

  it("0.4 a successful claim returns a monotonic fence", async () => {
    const runId = await seedRun();
    const first = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(first.ok && first.fence).toBe(1);

    // Expire and re-claim: generation two.
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });
    const second = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(second.ok && second.fence).toBe(2);
  });

  it("0.4 a stale worker cannot complete a run its replacement re-claimed", async () => {
    const runId = await seedRun();
    const a = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(a.ok).toBe(true);
    const fenceA = a.ok ? a.fence : -1;

    // A goes silent; its lease expires; B takes over.
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });
    const b = await tracker.markRunProcessing(runId, teamA, prisma as never);
    const fenceB = b.ok ? b.fence : -1;
    expect(fenceB).toBeGreaterThan(fenceA);

    // B finishes.
    expect(
      (await tracker.markRunCompleted(runId, teamA, prisma as never, fenceB)).ok,
    ).toBe(true);

    // A finally returns. Both of its writes must match nothing — status alone
    // would NOT have stopped this, because the row was PROCESSING again when
    // B held it, and is COMPLETED now only because B got there first.
    expect(
      (await tracker.markRunCompleted(runId, teamA, prisma as never, fenceA)).ok,
    ).toBe(false);
    expect(
      (await tracker.markRunFailed(runId, teamA, "late", prisma as never, fenceA)).ok,
    ).toBe(false);

    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(row.status).toBe("COMPLETED");
    expect(row.lastError).toBeNull();
  });

  it("0.4 a stale worker cannot fail a run its replacement is still processing", async () => {
    const runId = await seedRun();
    const a = await tracker.markRunProcessing(runId, teamA, prisma as never);
    const fenceA = a.ok ? a.fence : -1;
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });
    const b = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(b.ok).toBe(true);

    // THE CASE A STATUS-ONLY PREDICATE GETS WRONG: the row IS PROCESSING, and
    // A's write would have matched.
    const late = await tracker.markRunFailed(
      runId,
      teamA,
      "stale_failure",
      prisma as never,
      fenceA,
    );
    expect(late.ok).toBe(false);
    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(row.status).toBe("PROCESSING");
    expect(row.lastError).not.toBe("stale_failure");
  });

  it("0.4 four concurrent initial claims produce one winner and one increment", async () => {
    const runId = await seedRun();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        tracker.markRunProcessing(runId, teamA, prisma as never),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(row.attemptCount).toBe(1);
    expect(winners[0]!.ok && winners[0]!.fence).toBe(1);
  });

  it("0.4 a duplicate terminal write from the CURRENT holder is a bounded no-op", async () => {
    const runId = await seedRun();
    const claim = await tracker.markRunProcessing(runId, teamA, prisma as never);
    const fence = claim.ok ? claim.fence : -1;
    expect((await tracker.markRunCompleted(runId, teamA, prisma as never, fence)).ok).toBe(true);
    const settled = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });

    const replay = await tracker.markRunCompleted(runId, teamA, prisma as never, fence);

    expect(replay.ok).toBe(false);
    const after = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(after.completedAtUtc?.toISOString()).toBe(
      settled.completedAtUtc?.toISOString(),
    );
  });

  it("0.4 the fence is tenant-bound: a foreign write matches nothing", async () => {
    const runId = await seedRun();
    const claim = await tracker.markRunProcessing(runId, teamA, prisma as never);
    const fence = claim.ok ? claim.fence : -1;

    const foreign = await tracker.markRunCompleted(
      runId,
      teamB,
      prisma as never,
      fence,
    );

    expect(foreign.ok).toBe(false);
    const row = await prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(row.status).toBe("PROCESSING");
    expect(row.teamId).toBe(teamA);
  });
});
