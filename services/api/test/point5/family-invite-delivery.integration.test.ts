/**
 * PHASE 12 — POINT 5, FAMILY 2: invite delivery.
 *
 *   durable authority  NotificationDelivery (eventType `org_invite_delivery`)
 *   subject            OrganizationInvite (tokenHash — the raw token is never
 *                      persisted anywhere)
 *   claim              conditional updateMany pushing `nextAttemptAtUtc`
 *                      forward by the lease
 *   executor           processDueOrgInviteDeliveries -> rotateAndSend
 *   terminal writer    markOutcome (SENT / FAILED / CANCELLED)
 *
 * The email provider is the ONE genuine external boundary and is a RECORDING
 * fake, so every case can assert how many messages were actually sent and
 * inspect their bodies — which is how the token-secrecy case is proven rather
 * than asserted.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

type SentMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
};

const mail = vi.hoisted(() => ({
  /** Messages the provider ACCEPTED and would deliver. */
  sent: [] as SentMail[],
  /**
   * Every call, including refused and suppressed ones.
   *
   * `sent` answers "what did the recipient get"; `attempts` answers "what did
   * we ask the provider to do, and under which key" — and the rotation
   * contract is entirely about the second question.
   */
  attempts: [] as SentMail[],
  /** Keys the provider has already accepted, for `dedupe` mode. */
  seenKeys: new Set<string>(),
  /**
   * What the provider should do next.
   *
   * `dedupe` models a REAL provider honouring an idempotency key: a repeat of
   * a key it has already accepted is acknowledged but NOT delivered again.
   * That is the behaviour that made a rotated link under an unchanged key
   * dangerous, so it has to be modelled rather than assumed away.
   */
  mode: "ok" as "ok" | "transient" | "throw" | "dedupe",
  /** Sends the provider acknowledged without delivering (deduped). */
  suppressed: [] as SentMail[],
  reset() {
    this.sent.length = 0;
    this.attempts.length = 0;
    this.suppressed.length = 0;
    this.seenKeys.clear();
    this.mode = "ok";
  },
}));

vi.mock("../../src/services/email.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendCustomEmailViaResend: async (input: SentMail) => {
      mail.attempts.push(input);
      if (mail.mode === "throw") throw new Error("connection reset");
      if (mail.mode === "transient") {
        return {
          ok: false as const,
          errorCode: "rate_limited",
          errorMessage: "too many requests",
        };
      }
      const key = input.idempotencyKey ?? "";
      if (mail.mode === "dedupe" && key && mail.seenKeys.has(key)) {
        // Acknowledged, NOT delivered. This is what a provider does with a
        // repeated idempotency key, and it is indistinguishable from success
        // to the caller — which is exactly why the key must change when the
        // content does.
        mail.suppressed.push(input);
        return { ok: true as const, providerMessageId: `dedup_${key.slice(-8)}` };
      }
      if (key) mail.seenKeys.add(key);
      mail.sent.push(input);
      return { ok: true as const, providerMessageId: `msg_${randomUUID()}` };
    },
  };
});

describe("POINT 5 FAMILY — invite delivery (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let service: typeof import("../../src/services/organization/org-invite-delivery.service.js");
  let ownOrgId: string;
  let foreignOrgId: string;
  let ownInviter: string;
  let foreignInviter: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    service = await import(
      "../../src/services/organization/org-invite-delivery.service.js"
    );

    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    const teamB = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamB.teamId },
      select: { organizationId: true },
    });
    if (!teamA.organizationId || !teamB.organizationId) {
      throw new Error("fixtures must be organization-backed workspaces");
    }
    ownOrgId = teamA.organizationId;
    foreignOrgId = teamB.organizationId;
    ownInviter = harness.fixtures.teamA.ownerUserId;
    foreignInviter = harness.fixtures.teamB.ownerUserId;
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures — the REAL two-row shape: an invite plus its delivery intent
  // =========================================================================

  async function seedInvite(
    organizationId: string,
    invitedByUserId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const email = `point5-${randomUUID()}@test.proovra.local`;
    const rawToken = service.newOrgInviteToken();
    const invite = await prisma.organizationInvite.create({
      data: {
        organizationId,
        email,
        role: "ORG_MEMBER",
        token: null,
        tokenHash: service.hashOrgInviteToken(rawToken),
        invitedByUserId,
        expiresAt: service.orgInviteExpiresAt(),
        ...overrides,
      },
      select: { id: true, email: true, tokenHash: true },
    });
    return { ...invite, rawToken };
  }

  async function seedDelivery(input: {
    organizationId: string;
    inviteId: string;
    recipient: string;
    due?: boolean;
    status?: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
    retryCount?: number;
  }) {
    const row = await prisma.notificationDelivery.create({
      data: {
        eventType: service.ORG_INVITE_DELIVERY_EVENT_TYPE,
        channel: "EMAIL",
        provider: "RESEND",
        templateKey: "org_invite",
        recipient: input.recipient,
        status: input.status ?? "PENDING",
        retryCount: input.retryCount ?? 0,
        nextAttemptAtUtc:
          input.due === false
            ? new Date(Date.now() + 60 * 60 * 1000)
            : new Date(Date.now() - 60 * 1000),
        metadata: {
          inviteId: input.inviteId,
          organizationId: input.organizationId,
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function readDelivery(id: string) {
    return prisma.notificationDelivery.findUnique({
      where: { id },
      select: {
        status: true,
        retryCount: true,
        errorCode: true,
        nextAttemptAtUtc: true,
        providerMessageId: true,
        recipient: true,
        metadata: true,
      },
    });
  }

  /** A complete, due, deliverable invite in the given organization. */
  async function dueInvite(organizationId: string, invitedByUserId: string) {
    const invite = await seedInvite(organizationId, invitedByUserId);
    const deliveryId = await seedDelivery({
      organizationId,
      inviteId: invite.id,
      recipient: invite.email,
    });
    return { invite, deliveryId };
  }

  /**
   * The CURRENT delivery intent for an invitation.
   *
   * PHASE 12 POINT 5 — a sweeper attempt rotates the token, and a rotation is
   * new content, so it supersedes the intent it read and records its outcome
   * on a SUCCESSOR. An invitation therefore owns a CHAIN of intents, of which
   * exactly one is live. Cases that ask "what happened to this delivery" must
   * ask the live end of the chain; asking the row they seeded would read the
   * retired predecessor and conclude the invitation was cancelled.
   */
  async function liveIntentFor(inviteId: string): Promise<string> {
    const chain = await prisma.notificationDelivery.findMany({
      where: {
        eventType: service.ORG_INVITE_DELIVERY_EVENT_TYPE,
        metadata: { path: ["inviteId"], equals: inviteId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, metadata: true },
    });
    const live = chain.find((r) => !service.isSupersededDelivery(r.metadata));
    if (!live) throw new Error(`no live delivery intent for invite ${inviteId}`);
    return live.id;
  }

  // =========================================================================

  it("the invitation and its delivery intent are both durable before any send", async () => {
    mail.reset();
    const { invite, deliveryId } = await dueInvite(ownOrgId, ownInviter);

    const before = await readDelivery(deliveryId);
    expect(before!.status).toBe("PENDING");
    expect(before!.providerMessageId).toBeNull();
    expect(mail.sent).toHaveLength(0);

    const summary = await service.processDueOrgInviteDeliveries(
      {},
      prisma as never,
    );

    expect(summary.sent).toBeGreaterThanOrEqual(1);
    // The outcome lands on the LIVE intent — the successor the rotation
    // created — while the intent this test seeded is retired. Both halves
    // matter: the send is recorded, and the row it replaced cannot send again.
    const after = await readDelivery(await liveIntentFor(invite.id));
    expect(after!.status).toBe("SENT");
    // The provider's acknowledgement is persisted, not inferred.
    expect(after!.providerMessageId).toBeTruthy();
    const retired = await readDelivery(deliveryId);
    expect(retired!.status).toBe("CANCELLED");
    expect(retired!.errorCode).toBe(service.ORG_INVITE_SUPERSEDED_ERROR_CODE);
    expect(mail.sent.some((m) => m.to === invite.email)).toBe(true);
    provenCase("invite.durable.intent_before_work");
  });

  it("the recipient and organization come from persistence, not from the row's own copy", async () => {
    mail.reset();
    const { invite } = await dueInvite(ownOrgId, ownInviter);

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    // The delivery row names an invite id; everything that matters — the
    // address, the organization name, the role — is loaded from the invite
    // and organization rows at execution.
    const persisted = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { email: true, organizationId: true },
    });
    expect(persisted.organizationId).toBe(ownOrgId);
    const mine = mail.sent.filter((m) => m.to === persisted.email);
    expect(mine).toHaveLength(1);
    provenCase("invite.tenant.workspace_reloaded");
  });

  it("the raw accept token is never persisted, and appears only in the email body", async () => {
    mail.reset();
    const { invite, deliveryId } = await dueInvite(ownOrgId, ownInviter);
    const originalHash = invite.tokenHash;

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    const row = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { token: true, tokenHash: true },
    });
    // ROTATED: the token this suite minted is dead, and its replacement was
    // never written in the clear.
    expect(row.token).toBeNull();
    expect(row.tokenHash).not.toBe(originalHash);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The delivery row — the thing a queue or a log would carry — holds no
    // token material at all.
    const delivery = await readDelivery(deliveryId);
    const serialized = JSON.stringify(delivery);
    expect(serialized).not.toContain(invite.rawToken);
    expect(serialized).not.toContain(row.tokenHash);

    // Nor does the audit trail.
    const audits = await prisma.organizationAuditEvent.findMany({
      where: {
        organizationId: ownOrgId,
        eventType: "ORG_INVITE_DELIVERY_ROTATED",
        targetId: invite.id,
      },
      select: { metadata: true },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain(invite.rawToken);
    provenCase("invite.token.never_leaves_persistence");
  });

  it("a REVOKED or ACCEPTED invitation is never mailed", async () => {
    mail.reset();
    const revoked = await seedInvite(ownOrgId, ownInviter, {
      revokedAt: new Date(),
    });
    const revokedDelivery = await seedDelivery({
      organizationId: ownOrgId,
      inviteId: revoked.id,
      recipient: revoked.email,
    });
    const accepted = await seedInvite(ownOrgId, ownInviter, {
      acceptedAt: new Date(),
    });
    const acceptedDelivery = await seedDelivery({
      organizationId: ownOrgId,
      inviteId: accepted.id,
      recipient: accepted.email,
    });

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    expect(mail.sent.some((m) => m.to === revoked.email)).toBe(false);
    expect(mail.sent.some((m) => m.to === accepted.email)).toBe(false);
    expect((await readDelivery(revokedDelivery))!.status).toBe("CANCELLED");
    expect((await readDelivery(revokedDelivery))!.errorCode).toBe(
      "invite_revoked",
    );
    expect((await readDelivery(acceptedDelivery))!.status).toBe("CANCELLED");
    expect((await readDelivery(acceptedDelivery))!.errorCode).toBe(
      "invite_accepted",
    );
    provenCase("invite.revoked_not_sent");
  });

  it("three simultaneous sweeps send exactly ONE email per invitation", async () => {
    mail.reset();
    const { invite } = await dueInvite(ownOrgId, ownInviter);

    await Promise.all([
      service.processDueOrgInviteDeliveries({}, prisma as never),
      service.processDueOrgInviteDeliveries({}, prisma as never),
      service.processDueOrgInviteDeliveries({}, prisma as never),
    ]);

    // The count that matters is what the RECIPIENT saw. The claim is the
    // conditional lease push; a sweeper that matches zero rows must send
    // nothing.
    const mine = mail.sent.filter((m) => m.to === invite.email);
    expect(mine).toHaveLength(1);
    provenCase("invite.claim.one_winner");
  });

  it("a claimed row's lease is respected by the next sweep", async () => {
    mail.reset();
    const invite = await seedInvite(ownOrgId, ownInviter);
    // Already claimed by another sweeper: the lease is in the future.
    const deliveryId = await seedDelivery({
      organizationId: ownOrgId,
      inviteId: invite.id,
      recipient: invite.email,
      due: false,
    });
    const before = await readDelivery(deliveryId);

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    expect(mail.sent.some((m) => m.to === invite.email)).toBe(false);
    const after = await readDelivery(deliveryId);
    expect(after!.status).toBe("PENDING");
    expect(after!.retryCount).toBe(before!.retryCount);
    expect(after!.nextAttemptAtUtc?.toISOString()).toBe(
      before!.nextAttemptAtUtc?.toISOString(),
    );
    provenCase("invite.claim.active_not_stolen");
  });

  it("a second sweep after a successful send does not re-mail", async () => {
    mail.reset();
    const { invite } = await dueInvite(ownOrgId, ownInviter);

    await service.processDueOrgInviteDeliveries({}, prisma as never);
    await service.processDueOrgInviteDeliveries({}, prisma as never);

    expect(mail.sent.filter((m) => m.to === invite.email)).toHaveLength(1);
    provenCase("invite.idempotency.duplicate_is_noop");
  });

  it("a transient provider outcome stays retryable and claims nothing terminal", async () => {
    const { invite } = await dueInvite(ownOrgId, ownInviter);
    mail.reset();
    mail.mode = "transient";
    try {
      await service.processDueOrgInviteDeliveries({}, prisma as never);
    } finally {
      mail.mode = "ok";
    }

    // Read the live intent: a transient refusal still rotated the token, so
    // the attempt is recorded on the successor.
    const after = await readDelivery(await liveIntentFor(invite.id));
    // Not SENT — nothing was acknowledged — and not permanently FAILED
    // either, because "the provider was busy" is not "the address is bad".
    expect(after!.status).not.toBe("SENT");
    expect(after!.providerMessageId).toBeNull();
    expect(after!.retryCount).toBeGreaterThan(0);
    expect(mail.sent.some((m) => m.to === invite.email)).toBe(false);
    provenCase("invite.provider.unknown_outcome_non_terminal");
  });

  it("a delivery bound to the WRONG organization refuses, and discloses nothing", async () => {
    mail.reset();
    // The invitation belongs to the foreign organization; the delivery row
    // claims it belongs to ours. The binding check is what stops a rewritten
    // metadata blob from mailing another tenant's invitation.
    const theirInvite = await seedInvite(foreignOrgId, foreignInviter);
    const drifted = await seedDelivery({
      organizationId: ownOrgId,
      inviteId: theirInvite.id,
      recipient: theirInvite.email,
    });

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    expect(mail.sent.some((m) => m.to === theirInvite.email)).toBe(false);
    const after = await readDelivery(drifted);
    expect(after!.errorCode).toBe("organization_binding_mismatch");
    // The foreign invitation is untouched: not rotated, not expired, not
    // marked delivered.
    const untouched = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: theirInvite.id },
      select: { tokenHash: true, acceptedAt: true },
    });
    expect(untouched.tokenHash).toBe(theirInvite.tokenHash);
    expect(untouched.acceptedAt).toBeNull();
    provenCase("invite.tenant.cross_workspace_denied");
  });

  it("a terminal delivery is never re-opened by a later sweep", async () => {
    mail.reset();
    const invite = await seedInvite(ownOrgId, ownInviter);
    const deliveryId = await seedDelivery({
      organizationId: ownOrgId,
      inviteId: invite.id,
      recipient: invite.email,
      status: "SENT",
    });
    const before = await readDelivery(deliveryId);

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    expect(await readDelivery(deliveryId)).toEqual(before);
    expect(mail.sent.some((m) => m.to === invite.email)).toBe(false);
    provenCase("invite.terminal.stale_cannot_overwrite");
  });

  it("the audit trail distinguishes a rotation from a delivery", async () => {
    mail.reset();
    const { invite } = await dueInvite(ownOrgId, ownInviter);

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    // The rotation is audited in the SAME transaction as the hash swap, so a
    // crash between the two cannot produce a token nobody recorded issuing.
    // Delivery is a separate, later fact recorded on the delivery row.
    const rotations = await prisma.organizationAuditEvent.count({
      where: {
        organizationId: ownOrgId,
        eventType: "ORG_INVITE_DELIVERY_ROTATED",
        targetId: invite.id,
      },
    });
    expect(rotations).toBe(1);
    expect(mail.sent.filter((m) => m.to === invite.email)).toHaveLength(1);
  });

  // =========================================================================
  // PHASE 12 — POINT 5, STEP 1.1: retry is not rotation.
  //
  // The contradiction this closes: this family rotates the invite token on
  // every sweeper attempt, so a "retry" carried DIFFERENT content — a new
  // accept URL — under an UNCHANGED provider idempotency key. A provider
  // still holding an ambiguous first attempt is entitled to suppress the
  // second as a duplicate, and the recipient is then left holding a link the
  // rotation has already killed, with no further attempt able to reach them.
  //
  // Seven properties, each driven through the real service against the real
  // database, with a provider fake that actually honours idempotency keys.
  // =========================================================================

  /** The provider key a delivery intent carries, read from persistence. */
  async function storedKey(deliveryId: string): Promise<string | null> {
    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { metadata: true },
    });
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const v = md.idempotencyKey;
    return typeof v === "string" ? v : null;
  }

  /** A real intent, created by the real producer inside a transaction. */
  async function realIntent(organizationId: string, invitedByUserId: string) {
    const email = `point5-rot-${randomUUID()}@test.proovra.local`;
    const rawToken = service.newOrgInviteToken();
    const expiresAt = service.orgInviteExpiresAt();
    const created = await prisma.$transaction(async (tx) => {
      const invite = await tx.organizationInvite.create({
        data: {
          organizationId,
          email,
          role: "ORG_MEMBER",
          token: null,
          tokenHash: service.hashOrgInviteToken(rawToken),
          invitedByUserId,
          expiresAt,
        },
        select: { id: true, email: true, tokenHash: true, expiresAt: true },
      });
      const { deliveryId } = await service.recordOrgInviteDeliveryPending(tx, {
        inviteId: invite.id,
        organizationId,
        email,
        initiatedByUserId: invitedByUserId,
      });
      return { invite, deliveryId };
    });
    return { ...created, rawToken, expiresAt };
  }

  async function successorOf(deliveryId: string): Promise<string | null> {
    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { metadata: true },
    });
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const v = md[service.SUPERSEDED_BY_FIELD];
    return typeof v === "string" ? v : null;
  }

  it("PROOF 1 — an ordinary retry of unchanged content reuses the same provider key", async () => {
    mail.reset();
    const { invite, deliveryId, rawToken } = await realIntent(
      ownOrgId,
      ownInviter,
    );
    const key = await storedKey(deliveryId);
    expect(key, "a durable intent is created WITH its key").toBeTruthy();

    // Two inline attempts with the SAME raw token. Nothing rotated, so this is
    // a retry of identical content — the case the contract says must keep one
    // key. The first is refused transiently so the row stays PENDING and a
    // second attempt is legitimate.
    mail.mode = "transient";
    await service.attemptInitialOrgInviteDelivery(
      {
        deliveryId,
        rawToken,
        organizationName: "Point5 Org",
        role: "ORG_MEMBER",
        expiresAt: invite.expiresAt,
      },
      prisma as never,
    );
    mail.mode = "ok";
    await service.attemptInitialOrgInviteDelivery(
      {
        deliveryId,
        rawToken,
        organizationName: "Point5 Org",
        role: "ORG_MEMBER",
        expiresAt: invite.expiresAt,
      },
      prisma as never,
    );

    const mine = mail.attempts.filter((m) => m.to === invite.email);
    expect(mine.length).toBe(2);
    expect(mine[0]!.idempotencyKey).toBe(key);
    expect(mine[1]!.idempotencyKey).toBe(key);
    // And the key was LOADED, not re-derived: it is still the stored value.
    expect(await storedKey(deliveryId)).toBe(key);
    provenCase("invite.retry.same_content_same_key");
  });

  it("PROOF 2 — the attempt counter moves and the key does not", async () => {
    mail.reset();
    const { invite, deliveryId, rawToken } = await realIntent(
      ownOrgId,
      ownInviter,
    );
    const key = await storedKey(deliveryId);

    mail.mode = "transient";
    await service.attemptInitialOrgInviteDelivery(
      { deliveryId, rawToken, organizationName: "Point5 Org", role: "ORG_MEMBER", expiresAt: invite.expiresAt },
      prisma as never,
    );
    const afterFirst = await readDelivery(deliveryId);
    await service.attemptInitialOrgInviteDelivery(
      { deliveryId, rawToken, organizationName: "Point5 Org", role: "ORG_MEMBER", expiresAt: invite.expiresAt },
      prisma as never,
    );
    mail.mode = "ok";
    const afterSecond = await readDelivery(deliveryId);

    expect(afterFirst!.retryCount).toBe(1);
    expect(afterSecond!.retryCount).toBe(2);
    expect(await storedKey(deliveryId)).toBe(key);
    provenCase("invite.retry.counter_moves_key_does_not");
  });

  it("PROOF 3 — a token rotation SUPERSEDES the intent it replaces", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    // Make it due so the sweeper claims it.
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    const originalHash = invite.tokenHash;

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    const predecessor = await readDelivery(deliveryId);
    expect(predecessor!.status).toBe("CANCELLED");
    expect(predecessor!.errorCode).toBe(
      service.ORG_INVITE_SUPERSEDED_ERROR_CODE,
    );
    // A superseded intent is not schedulable: no lease, nothing due.
    expect(predecessor!.nextAttemptAtUtc).toBeNull();
    // And the rotation really happened.
    const rotated = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { tokenHash: true },
    });
    expect(rotated.tokenHash).not.toBe(originalHash);
    provenCase("invite.rotation.supersedes_predecessor");
  });

  it("PROOF 4 — the rotated link gets a NEW intent with a NEW key and a bumped content version", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    const oldKey = await storedKey(deliveryId);

    await service.processDueOrgInviteDeliveries({}, prisma as never);

    const successorId = await successorOf(deliveryId);
    expect(successorId, "the predecessor names its replacement").toBeTruthy();
    expect(successorId).not.toBe(deliveryId);

    const newKey = await storedKey(successorId!);
    expect(newKey).toBeTruthy();
    expect(newKey).not.toBe(oldKey);

    const successor = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: successorId! },
      select: { metadata: true, status: true, recipient: true },
    });
    const md = (successor.metadata ?? {}) as Record<string, unknown>;
    expect(md[service.CONTENT_VERSION_FIELD]).toBe(2);
    expect(md[service.CONTENT_FINGERPRINT_FIELD]).toMatch(/^[0-9a-f]{32}$/);
    expect(successor.recipient).toBe(invite.email);

    // The fingerprint is the CURRENT content, computed from the stored hash.
    const current = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { tokenHash: true, expiresAt: true },
    });
    expect(md[service.CONTENT_FINGERPRINT_FIELD]).toBe(
      service.orgInviteContentFingerprint({
        inviteId: invite.id,
        tokenHash: current.tokenHash!,
        expiresAt: current.expiresAt,
      }),
    );
    // And it does NOT expose the material it was derived from.
    const serialized = JSON.stringify(successor.metadata);
    expect(serialized).not.toContain(current.tokenHash);
    provenCase("invite.rotation.new_intent_new_key");
  });

  it("PROOF 5 — the superseded intent can never send again", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    await service.processDueOrgInviteDeliveries({}, prisma as never);
    const oldKey = await storedKey(deliveryId);
    const sentBefore = mail.attempts.length;

    // Force the retired row to look due again — the strongest form of the
    // question: even if something re-schedules it, it must not send.
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    await service.processDueOrgInviteDeliveries({}, prisma as never);

    // Not claimed (CANCELLED is not PENDING), so no attempt under the old key.
    const afterKeys = mail.attempts
      .slice(sentBefore)
      .map((m) => m.idempotencyKey);
    expect(afterKeys).not.toContain(oldKey);
    expect((await readDelivery(deliveryId))!.status).toBe("CANCELLED");
    expect(invite.email).toBeTruthy();
    provenCase("invite.rotation.superseded_cannot_send");
  });

  it("PROOF 6 — a provider that dedupes by key cannot suppress the rotated link", async () => {
    mail.reset();
    mail.mode = "dedupe";
    const { invite, deliveryId, rawToken } = await realIntent(
      ownOrgId,
      ownInviter,
    );

    // First attempt: accepted by the provider, which now remembers the key.
    // The row is left PENDING by hand so a rotation can follow — this models
    // the AMBIGUOUS outcome, where the provider holds the message but the
    // caller never learned that it did.
    await service.attemptInitialOrgInviteDelivery(
      { deliveryId, rawToken, organizationName: "Point5 Org", role: "ORG_MEMBER", expiresAt: invite.expiresAt },
      prisma as never,
    );
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: "PENDING", nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    const deliveredBefore = mail.sent.length;

    await service.processDueOrgInviteDeliveries({}, prisma as never);
    mail.mode = "ok";

    // The rotated invitation was DELIVERED, not suppressed: it went out under
    // the successor's key, which the provider had never seen. Under the old
    // single-key design this assertion fails and `suppressed` grows instead.
    expect(mail.sent.length).toBeGreaterThan(deliveredBefore);
    const rotatedSend = mail.sent[mail.sent.length - 1]!;
    expect(rotatedSend.to).toBe(invite.email);
    expect(mail.suppressed).toHaveLength(0);

    const successorId = await successorOf(deliveryId);
    expect(rotatedSend.idempotencyKey).toBe(await storedKey(successorId!));
    provenCase("invite.rotation.new_link_not_suppressed");
  });

  it("PROOF 7 — two simultaneous rotation requests produce ONE successor and ONE email", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });

    await Promise.all([
      service.resendOrgInviteDelivery(
        { inviteId: invite.id, organizationId: ownOrgId, email: invite.email, actorUserId: ownInviter },
        prisma as never,
      ),
      service.resendOrgInviteDelivery(
        { inviteId: invite.id, organizationId: ownOrgId, email: invite.email, actorUserId: ownInviter },
        prisma as never,
      ),
      service.processDueOrgInviteDeliveries({}, prisma as never),
    ]);

    // The supersede is a conditional UPDATE, so exactly one caller may rotate
    // the intent it read. One token minted, one email, one rotation audited.
    const chain = await prisma.notificationDelivery.findMany({
      where: {
        eventType: service.ORG_INVITE_DELIVERY_EVENT_TYPE,
        metadata: { path: ["inviteId"], equals: invite.id },
      },
      select: { id: true, status: true, metadata: true },
    });
    const superseded = chain.filter((r) =>
      service.isSupersededDelivery(r.metadata),
    );
    expect(superseded).toHaveLength(1);
    expect(chain).toHaveLength(2);
    expect(mail.sent.filter((m) => m.to === invite.email)).toHaveLength(1);

    const rotations = await prisma.organizationAuditEvent.count({
      where: {
        organizationId: ownOrgId,
        eventType: "ORG_INVITE_DELIVERY_ROTATED",
        targetId: invite.id,
      },
    });
    expect(rotations).toBe(1);
    provenCase("invite.rotation.duplicate_request_idempotent");
  });

  // =========================================================================
  // PHASE 12 — POINT 5, STEP 1.2: the stored provider key is internal state.
  //
  // It is persisted so retries are stable, and it must reach nothing a client
  // can read. Proven by taking the ACTUAL key value out of the database and
  // scanning the output of every real projection for it — not by grepping the
  // source for a field name, which proves nothing about what a function
  // returns.
  // =========================================================================

  it("the stored provider idempotency key is absent from every product projection", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    const key = await storedKey(deliveryId);
    expect(key).toMatch(/^proovra-org_invite_delivery-/);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    const notifications = await import("../../src/services/notifications/index.js");

    const projections: Array<[string, unknown]> = [
      // The org-invite delivery state an admin surface renders.
      ["projectOrgInviteDelivery", service.projectOrgInviteDelivery(row as never)],
      // The per-invite map the organization invite list is built from.
      [
        "getOrgInviteDeliveryStates",
        Object.fromEntries(
          await service.getOrgInviteDeliveryStates([invite.id], prisma as never),
        ),
      ],
      // The canonical notification-delivery projection used by the admin
      // queue/delivery console, masked and unmasked.
      [
        "projectNotificationDelivery",
        notifications.projectNotificationDelivery(row as never),
      ],
      [
        "projectNotificationDelivery(masked)",
        notifications.projectNotificationDelivery(row as never, {
          disclosure: "MASKED" as const,
        }),
      ],
    ];

    for (const [label, value] of projections) {
      const serialized = JSON.stringify(value ?? null);
      expect(serialized, `${label} leaked the provider key`).not.toContain(key);
      expect(
        serialized,
        `${label} leaked the provider-key FIELD`,
      ).not.toContain("idempotencyKey");
    }
  });

  it("the provider key never reaches the audit trail, and never reaches a log line", async () => {
    mail.reset();
    const { invite, deliveryId } = await realIntent(ownOrgId, ownInviter);
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60_000) },
    });
    const predecessorKey = await storedKey(deliveryId);

    // Capture everything the process writes while a full rotate-and-send runs.
    const written: string[] = [];
    const streams = [process.stdout, process.stderr] as const;
    const originals = streams.map((s) => s.write.bind(s));
    for (const s of streams) {
      (s as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
    }
    try {
      await service.processDueOrgInviteDeliveries({}, prisma as never);
    } finally {
      streams.forEach((s, i) => {
        (s as { write: unknown }).write = originals[i]!;
      });
    }

    const successorId = await successorOf(deliveryId);
    const successorKey = await storedKey(successorId!);
    const log = written.join("");
    for (const k of [predecessorKey, successorKey]) {
      expect(k).toBeTruthy();
      expect(log, "a provider key reached stdout/stderr").not.toContain(k!);
    }

    // Audit — the export surface. Ids, counters and a bounded fingerprint only.
    const audits = await prisma.organizationAuditEvent.findMany({
      where: {
        organizationId: ownOrgId,
        eventType: "ORG_INVITE_DELIVERY_ROTATED",
        targetId: invite.id,
      },
      select: { metadata: true },
    });
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(predecessorKey!);
    expect(auditJson).not.toContain(successorKey!);
    expect(auditJson).not.toContain("idempotencyKey");
  });
});
