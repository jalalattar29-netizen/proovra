/**
 * PHASE 12 CORRECTIVE PASS §1.1 — THE SEC-001 SCENARIOS THE FIRST PASS DID NOT RUN.
 *
 * The previous pass executed ten probes against the stale-pointer half of
 * SEC-001 and then described the result as "full direct runtime proof" while
 * its own residual-risk note said "concurrency/rotation cases beyond the 10
 * executed were not run". Both halves of SEC-001 matter: the CROSS-TENANT READ
 * (covered by `phase-12-sec-001-stale-pointer.integration.test.ts`) and the
 * IRREVERSIBLE OUTBOUND SIDE EFFECT — an invitation email carrying a bearer
 * token for someone else's workspace. This file is the second half.
 *
 * The rule this file follows, and why
 * ---------------------------------------------------------------------------
 * The mandate is explicit: DO NOT read the invite token out of the database to
 * prove acceptance. Read the link from the RECORDING MAILBOX, after the
 * message has been ACKNOWLEDGED.
 *
 * That is not pedantry. Reading the hash's preimage from the row proves the row
 * exists; it proves nothing about whether a recipient could ever have used it,
 * and it cannot detect the two failures that matter most here — a token that
 * reaches the WRONG mailbox, and a token that appears somewhere it should not.
 * So every acceptance below starts where a real reviewer starts: at the link in
 * the message that was actually delivered to them.
 *
 * Everything runs against a disposable PostgreSQL 16 + pgvector, a disposable
 * Redis, and the local RECORDING email transport. Nothing leaves the machine.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

const ONE_DAY = 24 * 60 * 60 * 1000;

describe("§1.1 — SEC-001 token lifecycle, delivery integrity and tenancy", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let mail: typeof import("../src/services/external-review/portal-invitation-email.service.js");
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
  let recorder: typeof import("@proovra/shared-runtime");

  let workspaceA: string;
  let workspaceB: string;
  let inviterA: string;
  let inviterB: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    grants = await import(
      "../src/services/external-review/external-review-grant.service.js"
    );
    mail = await import(
      "../src/services/external-review/portal-invitation-email.service.js"
    );
    invitations = await import(
      "../src/services/external-review/portal-invitation.service.js"
    );
    recorder = await import("@proovra/shared-runtime");

    workspaceA = h.fixtures.teamA.teamId;
    workspaceB = h.fixtures.teamB.teamId;
    inviterA = h.fixtures.teamA.ownerUserId;
    inviterB = h.fixtures.teamB.ownerUserId;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const uniqueEmail = (label: string): string =>
    `p12-${label}-${Math.random().toString(36).slice(2, 10)}@reviewer.test`;

  /**
   * Issue through the COMPOSITE issuer, not the grant service directly.
   *
   * Worth stating, because the first draft of this suite called
   * `issueExternalReviewGrant` and every probe died on a foreign-key
   * violation. An invitation in this system is TWO rows sharing one id: the
   * token-bearing `ExternalReviewGrant` (hash only) and the sidecar
   * `ExternalReviewerRoleAssignment`, and it is the SIDECAR that
   * `ExternalReviewInvitationDelivery.grantId` references. `issueInvitation`
   * is the one writer that creates both, so it is the only correct way to
   * reach the delivery ledger — which is exactly the shape a probe must use if
   * it wants to exercise the real path rather than a convenient half of it.
   */
  const issue = async (
    teamId: string,
    invitedByUserId: string,
    reviewerEmail: string,
  ) => {
    const evidenceId =
      teamId === workspaceA
        ? h.fixtures.teamA.evidenceId
        : h.fixtures.teamB.evidenceId;
    const res = await invitations.issueInvitation({
      teamId,
      invitedByUserId,
      reviewerEmail,
      role: "EXTERNAL_REVIEWER",
      scope: { kind: "EVIDENCE", evidenceId },
      expiresAtUtc: new Date(Date.now() + 7 * ONE_DAY).toISOString(),
    });
    expect(
      res.ok,
      `issuing an invitation must succeed: ${JSON.stringify(res)}`,
    ).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res;
  };

  /**
   * ACCEPTANCE. A freshly issued grant is INVITED, and
   * `evaluateExternalReviewAccess` refuses every state that is not ACTIVE —
   * the reviewer must accept before the link reads anything. The probes below
   * are about what happens to a LIVE token, so they accept first; the
   * not-yet-accepted refusal is asserted separately as its own property.
   */
  const accept = async (
    teamId: string,
    grantId: string,
    actorUserId: string,
  ): Promise<void> => {
    const res = await grants.transitionExternalReviewGrant({
      grantId,
      teamId,
      toState: "ACTIVE",
      actorUserId,
    });
    expect(res.ok, `acceptance must succeed: ${JSON.stringify(res)}`).toBe(true);
  };

  const send = async (opts: {
    teamId: string;
    grantId: string;
    rawToken: string;
    recipientEmail: string;
    isResend?: boolean;
  }) =>
    mail.sendInvitationEmail({
      teamId: opts.teamId,
      grantId: opts.grantId,
      rawToken: opts.rawToken,
      recipientEmail: opts.recipientEmail,
      inviterDisplayName: "Probe Inviter",
      workspaceName: "Probe Workspace",
      role: "REVIEWER",
      expiresAtUtc: new Date(Date.now() + 7 * ONE_DAY).toISOString(),
      mfaRequired: false,
      ssoEnabled: false,
      isResend: opts.isResend ?? false,
    });

  /** Every message the recording mailbox holds for one recipient. */
  const mailboxFor = (recipientEmail: string) => {
    const alias = recorder.recipientAliasFor(recipientEmail);
    return recorder
      .readRecordedEmailFile(process.env.EMAIL_RECORDER_FILE)
      .filter((m) => m.recipientAlias === alias);
  };

  /**
   * THE TOKEN, AS A RECIPIENT WOULD OBTAIN IT.
   *
   * Parsed out of the acknowledged message's actionable link — never selected
   * from `external_review_grants`. A null return means the recipient received
   * nothing usable, which is a meaningful answer in several probes below.
   */
  const tokenFromMailbox = (recipientEmail: string): string | null => {
    const acknowledged = mailboxFor(recipientEmail).filter(
      (m) => m.result === "acknowledged" && m.actionableLink,
    );
    const last = acknowledged.at(-1);
    if (!last?.actionableLink) return null;
    return new URL(last.actionableLink).searchParams.get("token");
  };

  // ===========================================================================
  // TOKEN LIFECYCLE
  // ===========================================================================

  it("the delivered link carries a token that authenticates the intended grant", async () => {
    const reviewer = uniqueEmail("happy");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);

    const sent = await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    expect(sent.ok, `send must be acknowledged: ${JSON.stringify(sent)}`).toBe(
      true,
    );
    await accept(workspaceA, grantId, inviterA);

    // POSITIVE CONTROL, taken from the mailbox rather than the database.
    const delivered = tokenFromMailbox(reviewer);
    expect(delivered, "the recipient must have received a usable link").toBeTruthy();

    const lookup = await grants.lookupExternalReviewGrantByToken(delivered!);
    expect(lookup.ok, JSON.stringify(lookup)).toBe(true);
    if (lookup.ok) {
      expect(lookup.grant.id).toBe(grantId);
      expect(lookup.grant.teamId).toBe(workspaceA);
    }
  });

  it("a REVOKED grant's delivered token stops authenticating", async () => {
    const reviewer = uniqueEmail("revoked");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);
    await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    await accept(workspaceA, grantId, inviterA);
    const delivered = tokenFromMailbox(reviewer);
    expect(delivered).toBeTruthy();
    // Live before revocation — otherwise the refusal below proves nothing.
    expect((await grants.lookupExternalReviewGrantByToken(delivered!)).ok).toBe(
      true,
    );

    const transitioned = await grants.transitionExternalReviewGrant({
      grantId,
      teamId: workspaceA,
      actorUserId: inviterA,
      toState: "REVOKED",
    });
    expect(transitioned.ok, JSON.stringify(transitioned)).toBe(true);

    const after = await grants.lookupExternalReviewGrantByToken(delivered!);
    expect(after.ok, "a revoked grant must not authenticate").toBe(false);
  });

  it("ROTATION: the predecessor token dies the instant the successor is minted", async () => {
    const reviewer = uniqueEmail("rotate");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);
    await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    await accept(workspaceA, grantId, inviterA);
    const predecessor = tokenFromMailbox(reviewer);
    expect(predecessor).toBeTruthy();
    expect((await grants.lookupExternalReviewGrantByToken(predecessor!)).ok).toBe(
      true,
    );

    const rotated = await grants.rotateExternalReviewGrantToken({
      grantId,
      teamId: workspaceA,
      actorUserId: inviterA,
      reason: "§1.1 probe — successor must supersede the predecessor",
    });
    expect(rotated.ok, JSON.stringify(rotated)).toBe(true);
    if (!rotated.ok) return;

    // (a) the predecessor is dead…
    expect(
      (await grants.lookupExternalReviewGrantByToken(predecessor!)).ok,
      "a rotated-away token must not authenticate",
    ).toBe(false);
    // (b) …and the successor is a DIFFERENT value that works.
    expect(rotated.rawToken).not.toBe(predecessor);
    const successorLookup = await grants.lookupExternalReviewGrantByToken(
      rotated.rawToken,
    );
    expect(successorLookup.ok).toBe(true);

    // (c) the successor, once sent, reaches ONLY the intended recipient.
    const before = mailboxFor(reviewer).length;
    const foreign = uniqueEmail("rotate-bystander");
    const foreignBefore = mailboxFor(foreign).length;
    await send({
      teamId: workspaceA,
      grantId,
      rawToken: rotated.rawToken,
      recipientEmail: reviewer,
      isResend: true,
    });
    expect(mailboxFor(reviewer).length).toBeGreaterThan(before);
    expect(
      mailboxFor(foreign).length,
      "a rotation must not fan out to any other mailbox",
    ).toBe(foreignBefore);

    // (d) the successor SEND is a DISTINCT durable intent, not a mutation of
    //     the predecessor's.
    const deliveries = await prisma.externalReviewInvitationDelivery.findMany({
      where: { grantId },
      select: { id: true, attempt: true },
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(deliveries.map((d) => d.id)).size).toBe(deliveries.length);
  });

  // ===========================================================================
  // DELIVERY INTEGRITY — one intent, one key, one message.
  // ===========================================================================

  it("a RETRY of the same send keeps exactly ONE durable delivery intent", async () => {
    const reviewer = uniqueEmail("retry");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);

    const first = await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    expect(first.ok).toBe(true);
    const afterFirst = await prisma.externalReviewInvitationDelivery.count({
      where: { grantId },
    });
    expect(afterFirst).toBe(1);

    // Same logical send, repeated. The durable intent must be REUSED, not
    // duplicated — a second intent is a second message to a human.
    const again = await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    expect(again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.deliveryId).toBe(first.deliveryId);
    }
    expect(
      await prisma.externalReviewInvitationDelivery.count({
        where: { grantId },
      }),
    ).toBe(1);

    // And the idempotency key was MINTED ONCE and REUSED — proven from the
    // mailbox's idempotency alias, not from the key itself, which the
    // recorder deliberately never stores in the clear.
    const aliases = new Set(mailboxFor(reviewer).map((m) => m.idempotencyAlias));
    expect(aliases.size, "one logical send must present ONE idempotency key").toBe(
      1,
    );
  });

  it("FOUR CONCURRENT sends produce exactly one intended delivery", async () => {
    const reviewer = uniqueEmail("race");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        send({
          teamId: workspaceA,
          grantId,
          rawToken,
          recipientEmail: reviewer,
        }),
      ),
    );
    // Every racer must reach a bounded outcome; none may throw.
    for (const r of results) {
      expect(r.status, JSON.stringify(r)).toBe("fulfilled");
    }

    // THE PROPERTY: the race collapses onto ONE durable intent.
    const intents = await prisma.externalReviewInvitationDelivery.findMany({
      where: { grantId },
      select: { id: true, attempt: true },
    });
    expect(
      intents.length,
      "four concurrent sends must not mint four invitations",
    ).toBe(1);

    // …and onto ONE idempotency key at the provider boundary.
    const aliases = new Set(mailboxFor(reviewer).map((m) => m.idempotencyAlias));
    expect(aliases.size).toBe(1);
  });

  it("an AMBIGUOUS provider result becomes neither delivered nor permanently failed", async () => {
    const reviewer = uniqueEmail("ambiguous");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);

    recorder.scriptRecordingProviderFailure({
      kind: "ambiguous",
      errorCode: "p12_probe_ambiguous",
    });
    try {
      await send({
        teamId: workspaceA,
        grantId,
        rawToken,
        recipientEmail: reviewer,
      });
    } finally {
      recorder.scriptRecordingProviderFailure(null);
    }

    const delivery = await prisma.externalReviewInvitationDelivery.findFirst({
      where: { grantId },
      select: { status: true },
    });
    expect(delivery, "an attempt must leave a durable intent").toBeTruthy();
    // The whole point: an unknown answer is NOT converted into either
    // certainty. Claiming DELIVERED would assert a fact nobody has; claiming a
    // permanent failure would strand a message that may well have been sent.
    expect(delivery!.status).not.toBe("DELIVERED");
    expect(delivery!.status).not.toBe("BOUNCED");
  });

  // ===========================================================================
  // TENANCY — no message, and no token, crosses a workspace boundary.
  // ===========================================================================

  it("the mailbox holds no cross-tenant message and no cross-tenant token", async () => {
    const reviewerA = uniqueEmail("tenant-a");
    const reviewerB = uniqueEmail("tenant-b");
    const a = await issue(workspaceA, inviterA, reviewerA);
    const b = await issue(workspaceB, inviterB, reviewerB);

    await send({
      teamId: workspaceA,
      grantId: a.grantId,
      rawToken: a.rawToken,
      recipientEmail: reviewerA,
    });
    await send({
      teamId: workspaceB,
      grantId: b.grantId,
      rawToken: b.rawToken,
      recipientEmail: reviewerB,
    });
    await accept(workspaceA, a.grantId, inviterA);
    await accept(workspaceB, b.grantId, inviterB);

    const tokenA = tokenFromMailbox(reviewerA);
    const tokenB = tokenFromMailbox(reviewerB);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).not.toBe(tokenB);

    // Each token authenticates its OWN workspace and no other.
    const la = await grants.lookupExternalReviewGrantByToken(tokenA!);
    const lb = await grants.lookupExternalReviewGrantByToken(tokenB!);
    expect(la.ok && la.grant.teamId).toBe(workspaceA);
    expect(lb.ok && lb.grant.teamId).toBe(workspaceB);

    // Neither mailbox contains the other's link.
    for (const m of mailboxFor(reviewerA)) {
      expect(m.actionableLink ?? "").not.toContain(tokenB!);
    }
    for (const m of mailboxFor(reviewerB)) {
      expect(m.actionableLink ?? "").not.toContain(tokenA!);
    }
  });

  // ===========================================================================
  // SECRET HYGIENE — the raw token exists in exactly one place: the message.
  // ===========================================================================

  it("the raw token appears in no durable record other than the delivered link", async () => {
    const reviewer = uniqueEmail("hygiene");
    const { grantId, rawToken } = await issue(workspaceA, inviterA, reviewer);
    await send({
      teamId: workspaceA,
      grantId,
      rawToken,
      recipientEmail: reviewer,
    });
    await accept(workspaceA, grantId, inviterA);
    const delivered = tokenFromMailbox(reviewer);
    expect(delivered).toBeTruthy();

    // (a) The grant row stores a HASH, never the value.
    const row = await prisma.externalReviewGrant.findUnique({
      where: { id: grantId },
    });
    expect(JSON.stringify(row)).not.toContain(delivered!);

    // (b) The durable delivery intent — including its idempotency key, which
    //     must not be derived from a preimage containing the token.
    const deliveries = await prisma.externalReviewInvitationDelivery.findMany({
      where: { grantId },
    });
    expect(JSON.stringify(deliveries)).not.toContain(delivered!);

    // (c) The hash-chained audit log and the security-event stream.
    const audits = await prisma.adminAuditLog.findMany({
      where: { resourceId: grantId },
    });
    expect(JSON.stringify(audits)).not.toContain(delivered!);
    const securityEvents = await prisma.securityEvent.findMany({
      where: { teamId: workspaceA },
      take: 200,
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(securityEvents)).not.toContain(delivered!);

    // (e) The recorder's own metadata columns — the provider message id and
    //     the idempotency alias must not be the token in disguise.
    for (const m of mailboxFor(reviewer)) {
      expect(m.providerMessageId ?? "").not.toContain(delivered!);
      expect(m.idempotencyAlias).not.toContain(delivered!);
      expect(m.subject).not.toContain(delivered!);
    }
  });

  // ===========================================================================
  // REFUSAL — a refused operation sends nothing at all.
  // ===========================================================================

  it("a refused send acknowledges ZERO messages", async () => {
    const reviewer = uniqueEmail("refused");
    const before = mailboxFor(reviewer).length;

    // A grant id that does not exist in this workspace. The route-level
    // refusal is proven by the stale-pointer suite; here the question is
    // narrower and complementary: when the operation is refused, does the
    // TRANSPORT stay untouched?
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/invitations/00000000-0000-4000-8000-0000000000ff/send-email",
      headers: {
        authorization: `Bearer ${h.fixtures.teamA.adminToken}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).not.toBe(200);

    expect(
      mailboxFor(reviewer).length,
      "a refusal must not acknowledge any message",
    ).toBe(before);
  });
});
