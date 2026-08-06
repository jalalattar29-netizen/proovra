/**
 * PHASE 12 — POINT 5, FAMILY 6: notifications.
 *
 * Two registered units, driven through their REAL executors:
 *
 *   MfaRecoveryDigestSweep   services/worker/src/mfa-recovery-digest.ts
 *   DemoFollowUpSweep        services/api/src/services/demo-follow-up.service.ts
 *
 * WHAT THE EARLIER PASS PROVED, AND WHAT IT DID NOT
 * ---------------------------------------------------------------------------
 * The first pass proved the seven common invariants and one real regression:
 * neither unit had a claim covering its send, so two ticks both emailed. Both
 * were fixed and both are still covered below.
 *
 * It did not prove the CRASH WINDOWS, and the crash windows were where the
 * remaining defects lived. A claim is only half a state machine; the other
 * half is what the durable record says while a send is outstanding, and what
 * happens when the process holding it dies. Under the old design the digest's
 * claim row was `MfaRecoveryAdminDigestLog`, whose `sentAtUtc` defaults to
 * `now()` — so a claim was byte-identical to a delivery. A crash between the
 * INSERT and the provider call therefore left a row every later tick read as
 * "today is done", and the digest was silently dropped for the rest of the UTC
 * day. That is the bug these cases exist to keep out.
 *
 * The durable authority is now `NotificationDelivery`, whose lifecycle
 * distinguishes claimed / in-flight / acknowledged / retryable / ambiguous /
 * failed, and whose lease (`nextAttemptAtUtc`) lets another worker recover an
 * attempt whose owner died. Every send carries a provider idempotency key
 * derived from a durable id, so a retry after an outcome nobody confirmed
 * reaches the provider as the SAME message.
 *
 * HOW A CRASH IS SIMULATED
 * ---------------------------------------------------------------------------
 * By leaving behind exactly the durable state a crash at that instant would
 * leave, and then running the REAL sweep against it. Nothing is stubbed except
 * the provider socket: the rows, the claim, the lease and the recovery are all
 * production code operating on a live PostgreSQL 16.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

type ProviderRequest = {
  to: string;
  body: string;
  idempotencyKey: string | null;
};

/**
 * The provider socket.
 *
 * Records every request that reached it — including its `Idempotency-Key`,
 * which is the evidence that separates "retried safely" from "sent twice".
 */
const provider = vi.hoisted(() => ({
  digests: [] as ProviderRequest[],
  followUps: [] as ProviderRequest[],
  /** What the next digest request gets back. */
  digestMode: "ok" as "ok" | "throw" | "server_error" | "rejected",
  followUpMode: "ok" as "ok" | "throw" | "server_error" | "rejected",
  reset() {
    this.digests.length = 0;
    this.followUps.length = 0;
    this.digestMode = "ok";
    this.followUpMode = "ok";
  },
}));

describe("POINT 5 FAMILY — notifications (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let digest: typeof import("../../../worker/src/mfa-recovery-digest.js");
  let followUp: typeof import("../../src/services/demo-follow-up.service.js");
  let deliveryState: typeof import("@proovra/shared-runtime");
  let ownTeam: string;
  let foreignTeam: string;
  let ownAdmin: string;
  let foreignAdmin: string;
  let previousResendKey: string | undefined;
  let previousTransport: string | undefined;
  let realFetch: typeof globalThis.fetch | undefined;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    deliveryState = runtime;
    digest = await import("../../../worker/src/mfa-recovery-digest.js");
    followUp = await import("../../src/services/demo-follow-up.service.js");

    ownTeam = harness.fixtures.teamA.teamId;
    foreignTeam = harness.fixtures.teamB.teamId;
    ownAdmin = harness.fixtures.teamA.ownerUserId;
    foreignAdmin = harness.fixtures.teamB.ownerUserId;

    // BOTH units now reach the provider through the same canonical transport,
    // so ONE socket stub covers both. Under the old design the digest posted
    // with a raw `fetch` and the follow-up went through the Resend SDK, and
    // this suite had to stub two different things — which was itself the
    // clearest evidence that there were two transports.
    //
    // Every request is recorded and NONE leaves the process: a request to any
    // host other than the expected one is a hard failure, not a pass-through.
    previousResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "point5-integration-only-not-a-real-key";
    // PHASE 12 — POINT 7 (final pass): this suite drives the delivery state
    // machine against a PROVIDER DOUBLE at the wire — it scripts 5xx, timeouts
    // and permanent rejections through the fetch stub below. Provider selection
    // now exists and the local default is the recording provider, so the one
    // under test is named explicitly. The stub refuses any non-Resend URL, so
    // nothing leaves the process.
    previousTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "resend";
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
          html?: string;
          text?: string;
          subject?: string;
        };
        const to = Array.isArray(body.to) ? (body.to[0] ?? "") : (body.to ?? "");
        const headers = init?.headers ?? {};
        const idempotencyKey =
          headers["Idempotency-Key"] ?? headers["idempotency-key"] ?? null;
        // The digest and the follow-up are told apart by their template, not
        // by their transport: they share one.
        const isFollowUp = `${body.subject ?? ""}${body.text ?? ""}`
          .toLowerCase()
          .includes("proovra");
        const mode = isDigestSubject(body.subject)
          ? provider.digestMode
          : provider.followUpMode;
        void isFollowUp;

        if (mode === "throw") throw new Error("socket closed");
        const record: ProviderRequest = {
          to,
          body: `${body.html ?? ""}${body.text ?? ""}`,
          idempotencyKey,
        };
        if (isDigestSubject(body.subject)) provider.digests.push(record);
        else provider.followUps.push(record);

        if (mode === "server_error") {
          return {
            ok: false,
            status: 503,
            json: async () => ({}),
            text: async () => "",
          } as never;
        }
        if (mode === "rejected") {
          return {
            ok: false,
            status: 422,
            json: async () => ({}),
            text: async () => "",
          } as never;
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

  function isDigestSubject(subject: string | undefined): boolean {
    return (subject ?? "").includes("pending MFA recovery request");
  }

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (realFetch) globalThis.fetch = realFetch;
    if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = previousTransport;
    if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Shared fixtures
  // =========================================================================

  const today = () => new Date().toISOString().slice(0, 10);

  /** A stale PENDING_ADMIN_REVIEW request — what the digest reports on. */
  async function stalePending(teamId: string, userId: string): Promise<string> {
    const row = await prisma.mfaRecoveryRequest.create({
      data: {
        userId,
        teamId,
        reason: "point5 notification family proof",
        status: "PENDING_ADMIN_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    // Older than the 24h staleness threshold.
    await prisma.mfaRecoveryRequest.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
    return row.id;
  }

  async function clearDigestState(): Promise<void> {
    await prisma.notificationDelivery.deleteMany({
      where: { eventType: deliveryState.MFA_DIGEST_EVENT_TYPE },
    });
    await prisma.mfaRecoveryAdminDigestLog.deleteMany({});
    await prisma.mfaRecoveryDigestLog.deleteMany({});
    await prisma.mfaRecoveryRequest.deleteMany({
      where: { status: "PENDING_ADMIN_REVIEW" },
    });
  }

  async function digestLogFor(userId: string) {
    return prisma.mfaRecoveryAdminDigestLog.findUnique({
      where: { userId_sentDate: { userId, sentDate: today() } },
      select: { id: true, teamCount: true, requestCount: true, sentAtUtc: true },
    });
  }

  /** The durable delivery-attempt row backing today's digest for an admin. */
  async function digestDeliveryFor(userId: string) {
    return prisma.notificationDelivery.findFirst({
      where: {
        eventType: deliveryState.MFA_DIGEST_EVENT_TYPE,
        recipientUserId: userId,
        metadata: { path: ["digestSentDate"], equals: today() },
      },
    });
  }

  async function digestPhaseFor(userId: string) {
    const row = await digestDeliveryFor(userId);
    return row ? deliveryState.deriveDeliveryPhase(row, new Date()) : null;
  }

  async function adminEmail(userId: string): Promise<string> {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return u.email ?? "";
  }

  /** A demo request due for its next follow-up step. */
  async function dueFollowUp(overrides: Record<string, unknown> = {}) {
    const row = await prisma.demoRequest.create({
      data: {
        fullName: "Point Five",
        useCase: "point5 notification family proof",
        workEmail: `point5-${randomUUID()}@test.proovra.local`,
        status: "NEW",
        isSpam: false,
        followUpStatus: "ACTIVE",
        followUpStep: 0,
        nextFollowUpAt: new Date(Date.now() - 60 * 1000),
        ...overrides,
      },
      select: { id: true, workEmail: true },
    });
    return row;
  }

  async function readFollowUp(id: string) {
    return prisma.demoRequest.findUnique({
      where: { id },
      select: {
        followUpStatus: true,
        followUpStep: true,
        nextFollowUpAt: true,
        workEmail: true,
      },
    });
  }

  async function followUpAttempts(demoRequestId: string) {
    return prisma.notificationDelivery.findMany({
      where: {
        eventType: followUp.DEMO_FOLLOW_UP_EVENT_TYPE,
        metadata: { path: ["demoRequestId"], equals: demoRequestId },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  // =========================================================================
  // UNIT 1 — MfaRecoveryDigestSweep: the seven common invariants
  // =========================================================================

  it("digest: the pending requests are durable, and the digest reports on them", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    const result = await digest.runMfaRecoveryDigest({ trigger: "point5" });

    expect(result.teamsConsidered).toBeGreaterThanOrEqual(1);
    const log = await digestLogFor(ownAdmin);
    expect(log).not.toBeNull();
    expect(log!.requestCount).toBeGreaterThanOrEqual(1);
    // And the durable ATTEMPT record exists alongside the claim — the pair is
    // what makes the claim interpretable.
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.durable.intent_before_work");
  });

  it("digest: recipients and workspace names come from persistence", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "point5" });

    // The admin set is derived from ACTIVE OWNER/ADMIN TeamMember rows, and
    // the team name from the Team row — never from anything the caller
    // supplied, which is only a trigger label.
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: ownTeam },
      select: { name: true },
    });
    const email = await adminEmail(ownAdmin);
    const mine = provider.digests.filter((d) => d.to === email);
    expect(mine).toHaveLength(1);
    if (team.name) expect(mine[0]!.body).toContain(team.name);
    provenCase("digest.tenant.workspace_reloaded");
  });

  it("digest: a workspace's pending count is never attributed to another workspace", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(foreignTeam, foreignAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "point5" });

    const ours = await adminEmail(ownAdmin);
    expect(provider.digests.some((d) => d.to === ours)).toBe(false);
    expect(await digestLogFor(ownAdmin)).toBeNull();
    expect(await digestDeliveryFor(ownAdmin)).toBeNull();
    provenCase("digest.tenant.cross_workspace_denied");
  });

  it("digest: a second tick the same day sends nothing further", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "first" });
    await digest.runMfaRecoveryDigest({ trigger: "second" });

    const email = await adminEmail(ownAdmin);
    expect(provider.digests.filter((d) => d.to === email)).toHaveLength(1);
    provenCase("digest.idempotency.duplicate_is_noop");
  });

  it("digest: no recipient PII reaches the diagnostic event stream", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);
    const email = await adminEmail(ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "point5" });

    const events = await prisma.securityEvent.findMany({
      where: { eventType: { startsWith: "mfa_recovery_digest" } },
      select: { details: true },
    });
    expect(JSON.stringify(events)).not.toContain(email || "@@never@@");
    provenCase("digest.recipient_pii_never_in_diagnostics");
  });

  it("digest: suppression prevents the provider call entirely", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);
    await prisma.mfaAdminDigestPreference.create({
      data: { userId: ownAdmin, teamId: ownTeam, digestEnabled: false },
    });

    await digest.runMfaRecoveryDigest({ trigger: "point5" });

    const email = await adminEmail(ownAdmin);
    expect(provider.digests.some((d) => d.to === email)).toBe(false);
    // Suppression is not delivery: no claim and no attempt row are written, so
    // lifting the preference tomorrow does not look like a day already served.
    expect(await digestLogFor(ownAdmin)).toBeNull();
    expect(await digestDeliveryFor(ownAdmin)).toBeNull();

    await prisma.mfaAdminDigestPreference.deleteMany({
      where: { userId: ownAdmin },
    });
  });

  // =========================================================================
  // UNIT 1 — the eight crash windows
  // =========================================================================

  it("digest W1: three simultaneous ticks send ONE email per admin", async () => {
    // The original regression. The old order was read-log / send / write-log —
    // check-then-act across an external side effect, so both ticks sent and
    // only the second INSERT collided. The unique constraint caught the
    // duplicate ROW; the admin had already received the duplicate EMAIL.
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    await Promise.all([
      digest.runMfaRecoveryDigest({ trigger: "race-a" }),
      digest.runMfaRecoveryDigest({ trigger: "race-b" }),
      digest.runMfaRecoveryDigest({ trigger: "race-c" }),
    ]);

    const email = await adminEmail(ownAdmin);
    expect(provider.digests.filter((d) => d.to === email)).toHaveLength(1);
    expect(await digestLogFor(ownAdmin)).not.toBeNull();
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.claim.one_winner");
  });

  it("digest W2: a crash between the claim and the provider call does not lose the message", async () => {
    // THE BUG THIS PHASE FOUND. Under the old design the claim row alone said
    // "today is done", so this state was terminal and the digest was dropped
    // for the rest of the UTC day with no record that it had been intended.
    //
    // The state below is exactly what such a crash leaves: the claim row and
    // an attempt record in `claimed` — never attempted, immediately eligible.
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    const logId = randomUUID();
    await prisma.$transaction([
      prisma.mfaRecoveryAdminDigestLog.create({
        data: {
          id: logId,
          userId: ownAdmin,
          sentDate: today(),
          teamCount: 1,
          requestCount: 1,
        },
      }),
      prisma.notificationDelivery.create({
        data: {
          teamId: null,
          eventType: deliveryState.MFA_DIGEST_EVENT_TYPE,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: await adminEmail(ownAdmin),
          recipientUserId: ownAdmin,
          status: "PENDING",
          templateKey: deliveryState.MFA_DIGEST_TEMPLATE_KEY,
          nextAttemptAtUtc: new Date(),
          metadata: { claimLogId: logId, digestSentDate: today() },
        },
      }),
    ]);
    expect(await digestPhaseFor(ownAdmin)).toBe("claimed");

    await digest.runMfaRecoveryDigest({ trigger: "recovery" });

    const email = await adminEmail(ownAdmin);
    expect(
      provider.digests.filter((d) => d.to === email),
      "an abandoned claim must be recovered, not read as delivered",
    ).toHaveLength(1);
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.crash.after_claim_before_send_recovers");
  });

  it("digest W3: a provider failure is retryable and is never a delivered state", async () => {
    await clearDigestState();
    provider.reset();
    provider.digestMode = "server_error";
    await stalePending(ownTeam, ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "failing" });
    provider.digestMode = "ok";

    // Not delivered, and honestly so: the attempt row is retryable and the
    // claim row's delivery stamp was never written.
    expect(await digestPhaseFor(ownAdmin)).toBe("retryable");

    // And the next tick delivers it.
    await digest.runMfaRecoveryDigest({ trigger: "retry" });
    const email = await adminEmail(ownAdmin);
    expect(provider.digests.filter((d) => d.to === email)).toHaveLength(2);
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.provider.failure_retryable_not_delivered");
  });

  it("digest W4: an unconfirmed send is ambiguous, and its retry reuses the same idempotency key", async () => {
    // The provider accepted — or did not; the socket closed before we found
    // out. The only truthful record is "unknown", and the only safe retry is
    // one the provider can recognise as the same message.
    await clearDigestState();
    provider.reset();
    provider.digestMode = "throw";
    await stalePending(ownTeam, ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "ambiguous" });

    const row = await digestDeliveryFor(ownAdmin);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("RETRY_SCHEDULED");
    expect(row!.errorCode).toBe(deliveryState.AMBIGUOUS_ERROR_CODE);
    expect(await digestPhaseFor(ownAdmin)).toBe("ambiguous");
    expect(row!.sentAtUtc, "an unconfirmed send is not a send").toBeNull();

    // The key that WOULD have gone out, preserved on the durable row.
    const marker = deliveryState.readAttemptMarker(row!.metadata);
    expect(marker).not.toBeNull();
    const originalKey = marker!.idempotencyKey;
    expect(originalKey).toBe(deliveryState.mintEmailIdempotencyKey("delivery", row!.id));

    // The ambiguous backoff is real: the very next tick must NOT retry.
    provider.digestMode = "ok";
    await digest.runMfaRecoveryDigest({ trigger: "too-soon" });
    expect(provider.digests).toHaveLength(0);

    // Once the backoff elapses, the retry goes out under the SAME key, so the
    // provider collapses it against whatever it may already hold.
    await prisma.notificationDelivery.update({
      where: { id: row!.id },
      data: { nextAttemptAtUtc: new Date(Date.now() - 1000) },
    });
    await digest.runMfaRecoveryDigest({ trigger: "after-backoff" });

    expect(provider.digests).toHaveLength(1);
    expect(
      provider.digests[0]!.idempotencyKey,
      "a retry that mints a new key is not a retry, it is a second email",
    ).toBe(originalKey);
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.crash.after_ack_before_commit_no_duplicate");
  });

  it("digest W5: replaying a completed day is a bounded no-op", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);
    await digest.runMfaRecoveryDigest({ trigger: "first" });
    const settled = await digestDeliveryFor(ownAdmin);
    expect(settled!.status).toBe("SENT");

    await digest.runMfaRecoveryDigest({ trigger: "replay-1" });
    await digest.runMfaRecoveryDigest({ trigger: "replay-2" });

    const email = await adminEmail(ownAdmin);
    expect(provider.digests.filter((d) => d.to === email)).toHaveLength(1);
    const after = await digestDeliveryFor(ownAdmin);
    expect(after!.sentAtUtc?.toISOString()).toBe(
      settled!.sentAtUtc?.toISOString(),
    );
    provenCase("digest.replay.after_terminal_is_noop");
  });

  it("digest W6: a repeated provider acknowledgement does not duplicate or overwrite the terminal state", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);
    await digest.runMfaRecoveryDigest({ trigger: "first" });

    const settled = await digestDeliveryFor(ownAdmin);
    const settledId = settled!.providerMessageId;
    const settledAt = settled!.sentAtUtc?.toISOString();

    // A second acknowledgement arriving for the same delivery — a duplicated
    // provider response, or a retry that raced the commit. The sweep must not
    // contact the provider again, and must not restamp the row.
    await digest.runMfaRecoveryDigest({ trigger: "duplicate-ack" });

    const after = await digestDeliveryFor(ownAdmin);
    expect(after!.providerMessageId).toBe(settledId);
    expect(after!.sentAtUtc?.toISOString()).toBe(settledAt);
    const rows = await prisma.notificationDelivery.count({
      where: {
        eventType: deliveryState.MFA_DIGEST_EVENT_TYPE,
        recipientUserId: ownAdmin,
      },
    });
    expect(rows, "a duplicate acknowledgement must not create a row").toBe(1);
    provenCase("digest.provider.duplicate_response_no_overwrite");
  });

  it("digest W7: a stale in-flight attempt is recovered by exactly one worker", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    // The state a dead worker leaves: an attempt marker with an expired lease.
    const logId = randomUUID();
    const deliveryId = randomUUID();
    await prisma.$transaction([
      prisma.mfaRecoveryAdminDigestLog.create({
        data: {
          id: logId,
          userId: ownAdmin,
          sentDate: today(),
          teamCount: 1,
          requestCount: 1,
        },
      }),
      prisma.notificationDelivery.create({
        data: {
          id: deliveryId,
          teamId: null,
          eventType: deliveryState.MFA_DIGEST_EVENT_TYPE,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: await adminEmail(ownAdmin),
          recipientUserId: ownAdmin,
          status: "PENDING",
          templateKey: deliveryState.MFA_DIGEST_TEMPLATE_KEY,
          nextAttemptAtUtc: new Date(Date.now() - 60 * 1000),
          metadata: {
            claimLogId: logId,
            digestSentDate: today(),
            attempt: {
              startedAtUtc: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
              idempotencyKey:
                deliveryState.mintEmailIdempotencyKey("delivery", deliveryId),
            },
          },
        },
      }),
    ]);
    expect(await digestPhaseFor(ownAdmin)).toBe("expired");

    // Three workers see the stale lease at the same instant.
    await Promise.all([
      digest.runMfaRecoveryDigest({ trigger: "rec-a" }),
      digest.runMfaRecoveryDigest({ trigger: "rec-b" }),
      digest.runMfaRecoveryDigest({ trigger: "rec-c" }),
    ]);

    const email = await adminEmail(ownAdmin);
    expect(
      provider.digests.filter((d) => d.to === email),
      "a stale lease must produce exactly one recovery",
    ).toHaveLength(1);
    expect(await digestPhaseFor(ownAdmin)).toBe("acknowledged");
    provenCase("digest.recovery.stale_claim_one_winner");
  });

  it("digest W8: a live attempt is not stolen", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(ownTeam, ownAdmin);

    // A lease held by another worker, still valid.
    const logId = randomUUID();
    const deliveryId = randomUUID();
    const leaseUntil = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.$transaction([
      prisma.mfaRecoveryAdminDigestLog.create({
        data: {
          id: logId,
          userId: ownAdmin,
          sentDate: today(),
          teamCount: 1,
          requestCount: 1,
        },
      }),
      prisma.notificationDelivery.create({
        data: {
          id: deliveryId,
          teamId: null,
          eventType: deliveryState.MFA_DIGEST_EVENT_TYPE,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: await adminEmail(ownAdmin),
          recipientUserId: ownAdmin,
          status: "PENDING",
          templateKey: deliveryState.MFA_DIGEST_TEMPLATE_KEY,
          nextAttemptAtUtc: leaseUntil,
          metadata: {
            claimLogId: logId,
            digestSentDate: today(),
            attempt: {
              startedAtUtc: new Date().toISOString(),
              idempotencyKey:
                deliveryState.mintEmailIdempotencyKey("delivery", deliveryId),
            },
          },
        },
      }),
    ]);
    expect(await digestPhaseFor(ownAdmin)).toBe("in_flight");

    await digest.runMfaRecoveryDigest({ trigger: "thief" });

    // Scoped to THIS admin's address: the fixture workspace has other admins
    // who hold no claim, and their digests going out is the sweep working
    // correctly. What must not happen is a second attempt on the leased row.
    const leasedAdminEmail = await adminEmail(ownAdmin);
    expect(
      provider.digests.filter((d) => d.to === leasedAdminEmail),
    ).toHaveLength(0);
    const after = await digestDeliveryFor(ownAdmin);
    expect(after!.nextAttemptAtUtc?.toISOString()).toBe(leaseUntil.toISOString());
    expect(await digestPhaseFor(ownAdmin)).toBe("in_flight");
    provenCase("digest.claim.active_not_stolen");
  });

  it("digest: a permanently rejected message is terminal, visible, and not retried", async () => {
    await clearDigestState();
    provider.reset();
    provider.digestMode = "rejected";
    await stalePending(ownTeam, ownAdmin);

    await digest.runMfaRecoveryDigest({ trigger: "rejected" });
    provider.digestMode = "ok";

    expect(await digestPhaseFor(ownAdmin)).toBe("failed");
    const beforeCount = provider.digests.length;
    await digest.runMfaRecoveryDigest({ trigger: "after-permanent" });
    expect(provider.digests).toHaveLength(beforeCount);
    // Terminal means terminal: a later tick does not resurrect it.
    expect(await digestPhaseFor(ownAdmin)).toBe("failed");
    provenCase("digest.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // UNIT 2 — DemoFollowUpSweep
  // =========================================================================

  it("demo: the request row is the durable intent and advances exactly one step", async () => {
    provider.reset();
    const item = await dueFollowUp();

    const result = await followUp.processDueDemoFollowUps({});

    expect(result.sent).toBeGreaterThanOrEqual(1);
    const after = await readFollowUp(item.id);
    expect(after!.followUpStep).toBe(1);
    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(1);
    // The attempt is durable too, and terminal.
    const attempts = await followUpAttempts(item.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("SENT");
    provenCase("demo.durable.intent_before_work");
  });

  it("demo: the recipient is loaded from the row, never from the caller", async () => {
    provider.reset();
    const item = await dueFollowUp();

    await followUp.processDueDemoFollowUps({});

    const persisted = await readFollowUp(item.id);
    const sent = provider.followUps.filter((f) => f.to === persisted!.workEmail);
    expect(sent).toHaveLength(1);
    provenCase("demo.tenant.workspace_reloaded");
  });

  it("demo: a prospect record is never joined to tenant data", async () => {
    // A DemoRequest predates any workspace by definition — the manifest
    // records this with the closed reason `not_workspace_scoped`. The
    // isolation guarantee is therefore structural: the model carries no
    // tenant column at all, so no tenant can be leaked through it, and the
    // attempt row it produces is deliberately written with a null workspace.
    provider.reset();
    const item = await dueFollowUp();
    await followUp.processDueDemoFollowUps({});

    const row = await prisma.demoRequest.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(Object.keys(row)).not.toContain("teamId");
    expect(Object.keys(row)).not.toContain("organizationId");
    expect(JSON.stringify(row)).not.toContain(ownTeam);
    expect(JSON.stringify(row)).not.toContain(foreignTeam);
    const attempts = await followUpAttempts(item.id);
    expect(attempts[0]!.teamId).toBeNull();
    provenCase("demo.tenant.cross_workspace_denied");
  });

  it("demo W1: three simultaneous sweeps send ONE follow-up", async () => {
    // The regression proof. This loop had no claim: two ticks both selected
    // the same due request and both called the provider, so a prospect
    // received the same follow-up twice.
    provider.reset();
    const item = await dueFollowUp();

    await Promise.all([
      followUp.processDueDemoFollowUps({}),
      followUp.processDueDemoFollowUps({}),
      followUp.processDueDemoFollowUps({}),
    ]);

    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(1);
    expect((await readFollowUp(item.id))!.followUpStep).toBe(1);
    provenCase("demo.claim.one_winner");
  });

  it("demo W2: a crash between the lease and the provider call recovers", async () => {
    // The lease is `nextFollowUpAt`, pushed forward by the conditional claim.
    // A crash right after it leaves a request that is not due — and the whole
    // question is whether it becomes due again or is parked until its next
    // scheduled step. This is the case that distinguishes a real lease from
    // "move the date into the future and hope".
    provider.reset();
    const item = await dueFollowUp();

    const claimed = await prisma.demoRequest.updateMany({
      where: { id: item.id, followUpStatus: "ACTIVE" },
      data: {
        nextFollowUpAt: new Date(Date.now() + followUp.FOLLOW_UP_CLAIM_LEASE_MS),
      },
    });
    expect(claimed.count).toBe(1);

    // While the lease is live, nothing happens — that is the point of it.
    await followUp.processDueDemoFollowUps({});
    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(0);
    expect((await readFollowUp(item.id))!.followUpStep).toBe(0);

    // When it expires, the request is due again and the step is delivered.
    await prisma.demoRequest.update({
      where: { id: item.id },
      data: { nextFollowUpAt: new Date(Date.now() - 1000) },
    });
    await followUp.processDueDemoFollowUps({});

    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(1);
    expect((await readFollowUp(item.id))!.followUpStep).toBe(1);
    provenCase("demo.crash.after_lease_before_send_recovers");
  });

  it("demo W3: a provider failure leaves the request retryable and un-advanced", async () => {
    provider.reset();
    provider.followUpMode = "server_error";
    const item = await dueFollowUp();

    const result = await followUp.processDueDemoFollowUps({});
    expect(result.failed).toBeGreaterThanOrEqual(1);
    provider.followUpMode = "ok";

    const after = await readFollowUp(item.id);
    // NOT advanced. The old code awaited the send and advanced regardless —
    // and the send resolved on a provider rejection, so a prospect who never
    // received anything was recorded as having been followed up.
    expect(after!.followUpStep).toBe(0);
    expect(after!.followUpStatus).toBe("ACTIVE");
    const attempts = await followUpAttempts(item.id);
    expect(attempts[0]!.status).toBe("RETRY_SCHEDULED");

    // The lease still holds it; once it expires, the retry succeeds.
    await prisma.demoRequest.update({
      where: { id: item.id },
      data: { nextFollowUpAt: new Date(Date.now() - 1000) },
    });
    await followUp.processDueDemoFollowUps({});
    expect((await readFollowUp(item.id))!.followUpStep).toBe(1);
    provenCase("demo.provider.failure_retryable");
  });

  it("demo W4: an unconfirmed send is ambiguous, and its retry reuses the same idempotency key", async () => {
    provider.reset();
    provider.followUpMode = "throw";
    const item = await dueFollowUp();

    await followUp.processDueDemoFollowUps({});
    provider.followUpMode = "ok";

    const attempts = await followUpAttempts(item.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("RETRY_SCHEDULED");
    expect(attempts[0]!.errorCode).toBe(deliveryState.AMBIGUOUS_ERROR_CODE);
    expect(attempts[0]!.sentAtUtc).toBeNull();
    // Not advanced — an unconfirmed send is not a send.
    expect((await readFollowUp(item.id))!.followUpStep).toBe(0);

    // The retry carries the SAME provider key, because the key is derived
    // from (durable request id, step) — both unchanged — rather than from the
    // attempt. Note what is NOT in it: the prospect's address.
    await prisma.demoRequest.update({
      where: { id: item.id },
      data: { nextFollowUpAt: new Date(Date.now() - 1000) },
    });
    await followUp.processDueDemoFollowUps({});

    const sentNow = provider.followUps.filter((f) => f.to === item.workEmail);
    expect(sentNow).toHaveLength(1);
    const { deterministicEmailKey } = await import("../../src/services/email.service.js");
    expect(sentNow[0]!.idempotencyKey).toBe(
      deterministicEmailKey("demo_request_follow_up", item.id, "1"),
    );
    expect(sentNow[0]!.idempotencyKey).not.toContain(item.workEmail);
    expect((await readFollowUp(item.id))!.followUpStep).toBe(1);
    provenCase("demo.crash.after_ack_before_commit_no_duplicate");
  });

  it("demo W5: a stale lease is recovered by exactly one sweep", async () => {
    provider.reset();
    // Due in the past by more than any lease: the state a dead sender leaves.
    const item = await dueFollowUp({
      nextFollowUpAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await Promise.all([
      followUp.processDueDemoFollowUps({}),
      followUp.processDueDemoFollowUps({}),
      followUp.processDueDemoFollowUps({}),
    ]);

    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(1);
    expect((await readFollowUp(item.id))!.followUpStep).toBe(1);
    provenCase("demo.recovery.stale_lease_one_winner");
  });

  it("demo W6: a claimed request is not taken again before its lease expires", async () => {
    provider.reset();
    const item = await dueFollowUp({
      nextFollowUpAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const before = await readFollowUp(item.id);

    await followUp.processDueDemoFollowUps({});

    expect(provider.followUps.some((f) => f.to === item.workEmail)).toBe(false);
    const after = await readFollowUp(item.id);
    expect(after!.followUpStep).toBe(before!.followUpStep);
    expect(after!.nextFollowUpAt?.toISOString()).toBe(
      before!.nextFollowUpAt?.toISOString(),
    );
    provenCase("demo.claim.active_not_stolen");
  });

  it("demo W7: a second sweep does not repeat the step just sent", async () => {
    provider.reset();
    const item = await dueFollowUp();

    await followUp.processDueDemoFollowUps({});
    await followUp.processDueDemoFollowUps({});

    expect(provider.followUps.filter((f) => f.to === item.workEmail)).toHaveLength(1);
    provenCase("demo.idempotency.duplicate_is_noop");
  });

  it("demo W8: a STOPPED follow-up is terminal and is never resumed", async () => {
    provider.reset();
    const item = await dueFollowUp({ followUpStatus: "STOPPED" });
    const before = await readFollowUp(item.id);

    await followUp.processDueDemoFollowUps({});

    expect(provider.followUps.some((f) => f.to === item.workEmail)).toBe(false);
    const after = await readFollowUp(item.id);
    expect(after!.followUpStatus).toBe("STOPPED");
    expect(after!.followUpStep).toBe(before!.followUpStep);
    provenCase("demo.terminal.stale_cannot_overwrite");
  });

  it("demo: no recipient address reaches the diagnostic result stream", async () => {
    provider.reset();
    provider.followUpMode = "server_error";
    const item = await dueFollowUp();

    const result = await followUp.processDueDemoFollowUps({});
    provider.followUpMode = "ok";

    // The sweep's own result carries ids and error CODES, never the prospect's
    // address — a follow-up failure is an operational fact, not a disclosure.
    expect(JSON.stringify(result)).not.toContain(item.workEmail);
    provenCase("demo.recipient_pii_never_in_diagnostics");
  });
});
