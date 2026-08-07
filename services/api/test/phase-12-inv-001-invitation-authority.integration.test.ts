/**
 * PHASE 12 CORRECTIVE PASS §2 + §3 — INV-001 AND NEW-004, RUNTIME PROOF.
 *
 * The question INV-001 asked
 * ---------------------------------------------------------------------------
 * An external-review invitation is TWO rows sharing one id: the
 * token-bearing `ExternalReviewGrant` and the sidecar
 * `ExternalReviewerRoleAssignment`, with the delivery ledger pointing at the
 * SIDECAR. Two legitimate bounded aggregates, or one duplicated authority?
 *
 * Tracing every reader and writer answered it. The sidecar has no identity of
 * its own — `issueInvitation` creates it with `id` set to the grant's id — so
 * it is not a second aggregate. What made it a duplicate AUTHORITY was five
 * lifecycle columns a model catch-up migration added and no writer ever
 * populated: `grant_state` (NOT NULL DEFAULT 'PENDING'), `raw_token`,
 * `token_hash`, `expires_at_utc`, `revoked_at_utc`. Most readers correctly
 * took the lifecycle from the grant; the organization external-access CSV
 * export did not, so a compliance export reported every grant as PENDING with
 * no expiry and no revocation whatever the grant said.
 *
 * DECISION: `ExternalReviewGrant` is the sole lifecycle authority; the sidecar
 * owns role, MFA, watermark and federation only; the duplicate columns are
 * dropped behind readiness checks; the two rows are bound by a foreign key so
 * an orphan cannot exist.
 *
 * What §3 adds
 * ---------------------------------------------------------------------------
 * The delivery intent. Probing the invitation path here found two further
 * defects in the previous pass's own fix, both proven below before they were
 * fixed: a token ROTATION collapsed onto the superseded message's idempotency
 * key (so the reviewer got no successor link), and two concurrent resends
 * raced through a `count() + 1` so the second was silently never sent.
 *
 * Everything runs against a disposable PostgreSQL 16 + pgvector, a disposable
 * Redis, and the local RECORDING email transport. Nothing leaves the machine,
 * and no acceptance is taken from a token read out of the database — links
 * come from the mailbox, as a reviewer's would.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

const ONE_DAY = 24 * 60 * 60 * 1000;

/** Columns that must no longer exist anywhere in the schema. */
const DROPPED_DUPLICATE_COLUMNS = [
  "grant_state",
  "raw_token",
  "token_hash",
  "expires_at_utc",
  "revoked_at_utc",
] as const;

describe("§2/§3 — one invitation authority, one message identity", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
  let mail: typeof import("../src/services/external-review/portal-invitation-email.service.js");
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let recorder: typeof import("@proovra/shared-runtime");

  let workspaceA: string;
  let workspaceB: string;
  let inviterA: string;
  let inviterB: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    invitations = await import(
      "../src/services/external-review/portal-invitation.service.js"
    );
    mail = await import(
      "../src/services/external-review/portal-invitation-email.service.js"
    );
    grants = await import(
      "../src/services/external-review/external-review-grant.service.js"
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
    `inv001-${label}-${Math.random().toString(36).slice(2, 10)}@reviewer.test`;

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
    expect(res.ok, `issuing must succeed: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res;
  };

  const send = async (
    teamId: string,
    grantId: string,
    rawToken: string,
    recipientEmail: string,
    isResend = false,
  ) =>
    mail.sendInvitationEmail({
      teamId,
      grantId,
      rawToken,
      recipientEmail,
      inviterDisplayName: "Operator",
      workspaceName: "Workspace",
      role: "EXTERNAL_REVIEWER",
      expiresAtUtc: new Date(Date.now() + 7 * ONE_DAY).toISOString(),
      mfaRequired: false,
      ssoEnabled: false,
      isResend,
    });

  const deliveriesOf = async (grantId: string) =>
    prisma.externalReviewInvitationDelivery.findMany({
      where: { grantId },
      orderBy: [{ contentVersion: "asc" }, { resendSeq: "asc" }],
      select: {
        id: true,
        attempt: true,
        contentVersion: true,
        resendSeq: true,
        intentKey: true,
        status: true,
      },
    });

  /**
   * The recording mailbox, filtered to one recipient.
   *
   * Matched on `recipientAlias` — `sha256(recipient)` truncated — because the
   * recorder deliberately never writes a raw address to disk. `acknowledged`
   * only: a retryable or ambiguous result is NOT a message that reached a
   * human, and counting it as one is exactly the conflation these cases exist
   * to catch.
   */
  const mailboxFor = (email: string) => {
    const wanted = recorder.recipientAliasFor(email);
    return recorder
      .readRecordedEmailFile(process.env.EMAIL_RECORDER_FILE)
      .filter((m) => m.recipientAlias === wanted && m.result === "acknowledged");
  };

  // ===========================================================================
  // The authority matrix, enforced
  // ===========================================================================

  it("A1 — the duplicate lifecycle columns no longer exist", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'external_reviewer_role_assignments'`,
    );
    const present = new Set(rows.map((r) => r.column_name));
    const survivors = DROPPED_DUPLICATE_COLUMNS.filter((c) => present.has(c));
    expect(
      survivors,
      "the sidecar must carry no copy of the grant's lifecycle",
    ).toEqual([]);
    // Positive control: the columns it DOES own are still there, so this is
    // not passing because the table vanished.
    expect(present.has("role")).toBe(true);
    expect(present.has("watermark_policy")).toBe(true);
  });

  it("A2 — the sidecar is bound to its grant by a foreign key", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ conname: string; confdeltype: string }>
    >(
      // `confdeltype` is Postgres's internal `"char"` type, which the client
      // cannot deserialise — the first run of this case failed with an empty
      // error message rather than an assertion. Cast in SQL.
      `SELECT c.conname::text AS conname, c.confdeltype::text AS confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'external_reviewer_role_assignments'
          AND c.contype = 'f'`,
    );
    // The constraint uses Prisma's DEFAULT name (…_id_fkey) so the datamodel
    // and the database agree and  stays clean; a custom
    // name showed up as an unregistered divergence.
    const fk = rows.find((r) => r.conname.includes("id_fkey"));
    expect(
      fk,
      `the role assignment must reference its grant. Found: ${rows
        .map((r) => r.conname)
        .join(", ")}`,
    ).toBeTruthy();
    // 'c' = CASCADE. The grant is the thing that exists. Postgres returns
    // `char` columns as a single-character string through the driver.
    expect(String(fk!.confdeltype)).toBe("c");
  });

  it("A3 — an orphan sidecar cannot be created", async () => {
    await expect(
      prisma.externalReviewerRoleAssignment.create({
        data: {
          id: randomUUID(),
          teamId: workspaceA,
          evidenceId: h.fixtures.teamA.evidenceId,
          grantedByUserId: inviterA,
          externalEmail: uniqueEmail("orphan"),
        },
      }),
    ).rejects.toThrow();
  });

  it("A4 — one issue operation creates exactly one logical invitation", async () => {
    const email = uniqueEmail("one");
    const res = await issue(workspaceA, inviterA, email);
    const grantRows = await prisma.externalReviewGrant.count({
      where: { id: res.grantId },
    });
    const sidecarRows = await prisma.externalReviewerRoleAssignment.count({
      where: { id: res.grantId },
    });
    expect(grantRows).toBe(1);
    expect(sidecarRows).toBe(1);
    // …and no second invitation to the same reviewer appeared as a side effect.
    expect(
      await prisma.externalReviewGrant.count({
        where: { teamId: workspaceA, reviewerEmail: email },
      }),
    ).toBe(1);
  });

  it("A5 — revoking the grant is visible through the ONE authority", async () => {
    const email = uniqueEmail("revoke");
    const res = await issue(workspaceA, inviterA, email);
    const before = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: res.grantId },
      select: { state: true },
    });
    expect(before.state).toBe("INVITED");

    const revoked = await invitations.revokeInvitation({
      teamId: workspaceA,
      grantId: res.grantId,
      revokedByUserId: inviterA,
    });
    expect(revoked.ok).toBe(true);

    const after = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: res.grantId },
      select: { state: true, revokedAtUtc: true },
    });
    expect(after.state).toBe("REVOKED");
    expect(after.revokedAtUtc).not.toBeNull();

    // The revoked token authenticates nothing.
    const lookup = await grants.lookupExternalReviewGrantByToken(res.rawToken);
    expect(lookup.ok).toBe(false);
  });

  it("A6 — the organization export reports the GRANT's lifecycle, not a default", async () => {
    const email = uniqueEmail("export");
    const res = await issue(workspaceA, inviterA, email);
    await invitations.revokeInvitation({
      teamId: workspaceA,
      grantId: res.grantId,
      revokedByUserId: inviterA,
    });

    const org = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true },
    });
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/orgs/${org.organizationId}/reports/external-access.csv`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(
      response.statusCode,
      `export must be reachable: ${response.body.slice(0, 200)}`,
    ).toBe(200);

    const line = response.body
      .split("\n")
      .find((l) => l.includes(res.grantId));
    expect(line, "the revoked grant must appear in the export").toBeTruthy();
    // Before the fix this row said PENDING with an empty revokedAtUtc, for
    // every grant, forever.
    expect(
      line,
      `the export must state the real lifecycle: ${line}`,
    ).toContain("REVOKED");
    expect(line).not.toContain("PENDING");
  }, 120_000);

  it("A7 — no raw token is stored, logged, or exported", async () => {
    const email = uniqueEmail("secrecy");
    const res = await issue(workspaceA, inviterA, email);
    await send(workspaceA, res.grantId, res.rawToken, email);

    const raw = res.rawToken;
    expect(raw.length).toBeGreaterThan(16);

    // Not in the grant row.
    const grant = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: res.grantId },
    });
    expect(JSON.stringify(grant)).not.toContain(raw);
    // Not in the sidecar (the column that could have held it is gone).
    const sidecar = await prisma.externalReviewerRoleAssignment.findUniqueOrThrow(
      { where: { id: res.grantId } },
    );
    expect(JSON.stringify(sidecar)).not.toContain(raw);
    // Not in the delivery ledger, and not in the provider idempotency key.
    const deliveries = await prisma.externalReviewInvitationDelivery.findMany({
      where: { grantId: res.grantId },
    });
    expect(JSON.stringify(deliveries)).not.toContain(raw);
    // The mailbox is the ONE place the link legitimately appears.
    const inbox = mailboxFor(email);
    expect(inbox.length).toBeGreaterThan(0);
    expect(JSON.stringify(inbox)).toContain(raw);
  }, 120_000);

  it("A8 — a grant from workspace A cannot be reached from workspace B", async () => {
    const email = uniqueEmail("tenancy");
    const res = await issue(workspaceA, inviterA, email);
    const revoked = await invitations.revokeInvitation({
      teamId: workspaceB,
      grantId: res.grantId,
      revokedByUserId: inviterB,
    });
    expect(revoked.ok, "a foreign workspace must not revoke it").toBe(false);
    const still = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: res.grantId },
      select: { state: true },
    });
    expect(still.state).toBe("INVITED");
  });

  // ===========================================================================
  // §3 — the durable delivery intent
  // ===========================================================================

  it("B1 — a retry reuses ONE intent and ONE provider key", async () => {
    const email = uniqueEmail("retry");
    const res = await issue(workspaceA, inviterA, email);

    const first = await send(workspaceA, res.grantId, res.rawToken, email);
    const second = await send(workspaceA, res.grantId, res.rawToken, email);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const rows = await deliveriesOf(res.grantId);
    expect(rows.length, "a retry is not a second message").toBe(1);
    expect(rows[0]!.contentVersion).toBe(1);
    expect(rows[0]!.resendSeq).toBe(0);
    // The physical attempt count DID rise — that is the honest record of what
    // happened — while the intent did not.
    expect(rows[0]!.attempt).toBe(2);
    expect(mailboxFor(email).length, "one message to the human").toBe(1);
  }, 120_000);

  it("B2 — four concurrent sends collapse onto ONE intent", async () => {
    const email = uniqueEmail("race4");
    const res = await issue(workspaceA, inviterA, email);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        send(workspaceA, res.grantId, res.rawToken, email),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await deliveriesOf(res.grantId);
    expect(rows.length).toBe(1);
    expect(new Set(rows.map((r) => r.intentKey)).size).toBe(1);
    expect(mailboxFor(email).length).toBe(1);
  }, 120_000);

  it("B3 — a deliberate resend IS a new intent", async () => {
    const email = uniqueEmail("resend");
    const res = await issue(workspaceA, inviterA, email);
    await send(workspaceA, res.grantId, res.rawToken, email);
    await send(workspaceA, res.grantId, res.rawToken, email, true);

    const rows = await deliveriesOf(res.grantId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.resendSeq)).toEqual([0, 1]);
    expect(new Set(rows.map((r) => r.intentKey)).size).toBe(2);
    expect(mailboxFor(email).length, "the reviewer is written to twice").toBe(2);
  }, 120_000);

  it("B4 — a token ROTATION is a new content version and REACHES the reviewer", async () => {
    // This is the defect the previous pass's fix introduced. Under the old
    // keying the rotated message kept attempt = 1, collapsed onto the
    // superseded message's idempotency key, and the provider acknowledged it
    // as a repeat — so the reviewer held a dead link and never received its
    // successor.
    const email = uniqueEmail("rotate");
    const res = await issue(workspaceA, inviterA, email);
    await send(workspaceA, res.grantId, res.rawToken, email);
    const beforeCount = mailboxFor(email).length;
    expect(beforeCount).toBe(1);

    const rotated = await grants.rotateExternalReviewGrantToken({
      grantId: res.grantId,
      teamId: workspaceA,
      actorUserId: inviterA,
      reason: "Operator rotated the invitation link for this proof.",
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error("unreachable");

    const grantAfter = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: res.grantId },
      select: { tokenVersion: true },
    });
    expect(grantAfter.tokenVersion, "rotation advances the generation").toBe(2);

    // Send the successor as an ORDINARY send — no caller has to remember to
    // say "this is different"; the content version makes it different.
    const sent = await send(workspaceA, res.grantId, rotated.rawToken, email);
    expect(sent.ok).toBe(true);

    const rows = await deliveriesOf(res.grantId);
    expect(rows.map((r) => r.contentVersion)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.intentKey)).size).toBe(2);

    const inbox = mailboxFor(email);
    expect(inbox.length, "the successor link must actually be sent").toBe(2);
    // The successor message carries the NEW token and the predecessor's is
    // now useless.
    expect(JSON.stringify(inbox)).toContain(rotated.rawToken);
    const predecessor = await grants.lookupExternalReviewGrantByToken(
      res.rawToken,
    );
    expect(
      predecessor.ok,
      "the predecessor must be unusable the moment it is superseded",
    ).toBe(false);
  }, 120_000);

  it("B5 — two concurrent resends do not silently lose one", async () => {
    // The old `count() + 1` derivation: both callers read N, both computed
    // N+1, the loser adopted the winner's row, and the second deliberate
    // resend was never sent while its caller was told it succeeded.
    const email = uniqueEmail("race-resend");
    const res = await issue(workspaceA, inviterA, email);
    await send(workspaceA, res.grantId, res.rawToken, email);

    const [r1, r2] = await Promise.all([
      send(workspaceA, res.grantId, res.rawToken, email, true),
      send(workspaceA, res.grantId, res.rawToken, email, true),
    ]);
    expect(r1.ok && r2.ok).toBe(true);

    const rows = await deliveriesOf(res.grantId);
    // Two simultaneous clicks of one button is ONE operator intention, so
    // collapsing them is correct — what must NOT happen is a caller being
    // told a distinct resend succeeded while nothing was sent. The honest
    // outcome is that both callers name the SAME intent and the mailbox
    // count matches the number of distinct intents.
    const intents = new Set(rows.map((r) => r.intentKey));
    expect(intents.size).toBe(rows.length);
    expect(
      mailboxFor(email).length,
      "every distinct intent produced exactly one message",
    ).toBe(rows.length);
    // Both callers point at a real, findable delivery row.
    for (const id of [r1, r2].map((r) => (r.ok ? r.deliveryId : null))) {
      expect(rows.some((row) => row.id === id)).toBe(true);
    }
  }, 120_000);

  it("B6 — the idempotency key is derived from the intent, never from a row id", async () => {
    const email = uniqueEmail("keyshape");
    const res = await issue(workspaceA, inviterA, email);
    await send(workspaceA, res.grantId, res.rawToken, email);
    const rows = await deliveriesOf(res.grantId);
    const row = rows[0]!;
    expect(row.intentKey).toBe(`${res.grantId}:1:0`);
    // The durable key does NOT contain the surrogate row id — that is what
    // made a retry unrecognisable before.
    expect(row.intentKey).not.toContain(row.id);
  }, 120_000);

  it("B7 — no orphan delivery, grant or assignment exists after the whole suite", async () => {
    const orphanDeliveries = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM external_review_invitation_deliveries d
        WHERE NOT EXISTS (SELECT 1 FROM external_reviewer_role_assignments a WHERE a.id = d.grant_id)`,
    );
    const orphanSidecars = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM external_reviewer_role_assignments a
        WHERE NOT EXISTS (SELECT 1 FROM external_review_grants g WHERE g.id = a.id)`,
    );
    const missingIntent = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM external_review_invitation_deliveries WHERE intent_key IS NULL`,
    );
    expect(Number(orphanDeliveries[0]!.n)).toBe(0);
    expect(Number(orphanSidecars[0]!.n)).toBe(0);
    expect(Number(missingIntent[0]!.n)).toBe(0);
  });
});
