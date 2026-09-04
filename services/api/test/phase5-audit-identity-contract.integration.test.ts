/**
 * PHASE 5 — THE AUDIT IDENTITY AND TRANSITION CONTRACT, AGAINST REAL STORAGE.
 *
 * Live PostgreSQL 16. The questions this file answers are the ones an audit
 * record exists to answer, and each is asked of the PERSISTED row rather than
 * of the function that wrote it:
 *
 *   who acted, in what role, on whose behalf, against what target, in which
 *   tenant, from what state to what state, with what outcome, and is any of
 *   that still readable once the account is gone.
 *
 * The chain is the reason these are columns and not JSON. A field that says
 * WHO ACTED, which an attacker could edit while every hashed field around it
 * stayed valid, would be worse than no field: verification would pass and the
 * record would lie. So the last group tampers with each new column in turn and
 * requires the chain to reject it.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PHASE 5 — audit identity contract (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let emitTenantAudit: typeof import("../src/services/audit/tenant-audit.service.js")["emitTenantAudit"];
  let emitPlatformAudit: typeof import("../src/services/audit/tenant-audit.service.js")["emitPlatformAudit"];
  let deriveActorType: typeof import("../src/services/audit/tenant-audit.service.js")["deriveActorType"];
  let verifyAdminAuditChain: typeof import("../src/services/platform-audit-log.service.js")["verifyAdminAuditChain"];

  const ORG = randomUUID();
  const WS = randomUUID();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ emitTenantAudit, emitPlatformAudit, deriveActorType } = await import(
      "../src/services/audit/tenant-audit.service.js"
    ));
    ({ verifyAdminAuditChain } = await import(
      "../src/services/platform-audit-log.service.js"
    ));
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  async function rowFor(action: string) {
    return prisma.adminAuditLog.findFirstOrThrow({
      where: { action },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /**
   * A row of the shape written BEFORE the identity contract: no actor type, no
   * snapshot, and a complete raw address and client string.
   *
   * Its hash is computed with the REAL V2 hasher rather than stubbed. A stub
   * would break chain verification for every row after it, and the tamper
   * cases below would then pass for the wrong reason — they would be detecting
   * this fixture rather than the edit they are meant to catch.
   */
  async function seedLegacyRow(action: string) {
    const { computeAuditLogChainHash, canonicalJsonForAuditHash } = await import(
      "../src/lib/admin-audit-chain.js"
    );
    const last = await prisma.adminAuditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    });
    const createdAt = new Date();
    const metadata = { note: "written before the identity contract" };
    const hash = computeAuditLogChainHash({
      chainVersion: 2,
      userId: null,
      action,
      category: "tenant_audit",
      severity: null,
      source: null,
      outcome: null,
      resourceType: null,
      resourceId: null,
      requestId: null,
      metadataCanonical: canonicalJsonForAuditHash(metadata),
      createdAtIso: createdAt.toISOString(),
      prevHash: last?.hash ?? null,
    });
    return prisma.adminAuditLog.create({
      data: {
        userId: null,
        isPublic: true,
        action,
        category: "tenant_audit",
        metadata,
        ipAddress: "203.0.113.42",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        hash,
        prevHash: last?.hash ?? null,
        chainVersion: 2,
        eventVersion: 1,
        createdAt,
      },
    });
  }

  // =========================================================================
  // WHO ACTED — and what kind of thing it was.
  // =========================================================================
  describe("the record says what kind of thing acted", () => {
    it("a human operator is recorded as HUMAN, with the authority actually used", async () => {
      const actorUserId = randomUUID();
      const action = `p5.human.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "success",
        sourceApp: "API",
        actorUserId,
        actorDisplay: "Jalal Attar",
        actorAuthority: "PLATFORM_ADMIN",
        organizationId: ORG,
        workspaceId: WS,
        resourceType: "organization",
        resourceId: ORG,
        targetDisplay: "Acme Legal",
      });

      const row = await rowFor(action);
      expect(row.actorType).toBe("HUMAN");
      expect(row.userId).toBe(actorUserId);
      expect(row.actorDisplay).toBe("Jalal Attar");
      expect(row.actorAuthority).toBe("PLATFORM_ADMIN");
      expect(row.targetDisplay).toBe("Acme Legal");
      expect(row.eventVersion).toBe(2);
      expect(row.chainVersion).toBe(4);
    });

    it("an automated event is WORKER or SERVICE, never a nameless blank", async () => {
      const workerAction = `p5.worker.${randomUUID().slice(0, 8)}`;
      await emitPlatformAudit({
        action: workerAction,
        outcome: "completed",
        sourceApp: "SYSTEM",
        actorUserId: null,
        serviceActor: "worker:report",
        actorDisplay: "Report worker",
      });
      const workerRow = await rowFor(workerAction);
      expect(workerRow.actorType).toBe("WORKER");
      expect(workerRow.actorDisplay).toBe("Report worker");

      const serviceAction = `p5.service.${randomUUID().slice(0, 8)}`;
      await emitPlatformAudit({
        action: serviceAction,
        outcome: "success",
        sourceApp: "API",
        actorUserId: null,
        serviceActor: "service:billing-webhook",
      });
      expect((await rowFor(serviceAction)).actorType).toBe("SERVICE");
    });

    it("a support action keeps the STAFF identity and is never flattened to HUMAN", async () => {
      /*
       * The dangerous outcome is not a missing label — it is a plausible wrong
       * one. If a staff member acting inside a customer's workspace is recorded
       * as an ordinary human actor, the trail reads as though the customer did
       * it. SUPPORT_CONTEXT wins over HUMAN precisely because both are true and
       * only one of them is the whole truth.
       */
      const staffUserId = randomUUID();
      const grantId = randomUUID();
      const action = `p5.support.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "success",
        sourceApp: "API",
        actorUserId: staffUserId,
        supportActorUserId: staffUserId,
        organizationId: ORG,
        workspaceId: WS,
        metadata: { grantId },
      });

      const row = await rowFor(action);
      expect(row.actorType).toBe("SUPPORT_CONTEXT");
      expect(row.userId, "the staff identity was lost").toBe(staffUserId);
      expect(
        (row.metadata as { supportActorUserId?: string }).supportActorUserId,
        "the support actor reference was lost",
      ).toBe(staffUserId);
    });

    it("an event with no human, no service and no system source is UNKNOWN_LEGACY, not a guess", () => {
      // Asserted on the pure derivation so the honest fallback cannot be
      // reached only by accident of what a caller happened to pass.
      expect(deriveActorType({ actorUserId: null })).toBe("UNKNOWN_LEGACY");
      expect(deriveActorType({ actorUserId: null, sourceApp: "SYSTEM" })).toBe("SYSTEM");
      expect(
        deriveActorType({ actorUserId: randomUUID(), serviceActor: "worker:x" }),
        "a human actor was overridden by a service label",
      ).toBe("HUMAN");
    });
  });

  // =========================================================================
  // WHAT CHANGED — three fields, because two cannot express a refusal.
  // =========================================================================
  describe("the record says what was asked for and what actually happened", () => {
    it("a refusal records the requested state and NO resulting state", async () => {
      const action = `p5.refused.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "denied",
        denialReason: "step_up_required",
        sourceApp: "API",
        actorUserId: randomUUID(),
        organizationId: ORG,
        workspaceId: WS,
        previousState: "ACTIVE",
        requestedState: "SUSPENDED",
        reasonCode: "STEP_UP_REQUIRED",
      });

      const row = await rowFor(action);
      expect(row.outcome).toBe("denied");
      expect(row.previousState).toBe("ACTIVE");
      expect(row.requestedState).toBe("SUSPENDED");
      expect(
        row.resultingState,
        "a refused action claimed a resulting state — storage did not change",
      ).toBeNull();
    });

    it("queued is not success, and the later completion is a separate row", async () => {
      /*
       * PHASE 5 §7. An API that accepts a job and writes `success` tells an
       * operator the estate changed when the work may never run. The request
       * says `queued`; the worker says `completed` afterwards; the two are
       * joined by a correlation id rather than by one of them lying.
       */
      const correlationId = randomUUID();
      const requestAction = `p5.async.request.${randomUUID().slice(0, 8)}`;
      const completionAction = `p5.async.done.${randomUUID().slice(0, 8)}`;

      await emitPlatformAudit({
        action: requestAction,
        outcome: "queued",
        sourceApp: "API",
        actorUserId: randomUUID(),
        correlationId,
        requestedState: "REPLAYED",
      });
      await emitPlatformAudit({
        action: completionAction,
        outcome: "completed",
        sourceApp: "SYSTEM",
        actorUserId: null,
        serviceActor: "worker:queue-replay",
        correlationId,
        resultingState: "REPLAYED",
      });

      const request = await rowFor(requestAction);
      const completion = await rowFor(completionAction);

      expect(request.outcome).toBe("queued");
      expect(request.resultingState, "an accepted request claimed a result").toBeNull();
      expect(completion.outcome).toBe("completed");
      expect(completion.resultingState).toBe("REPLAYED");
      expect(completion.actorType, "the worker's completion looked human").toBe("WORKER");
      expect(
        (request.metadata as { correlationId?: string }).correlationId,
        "the request and its completion cannot be joined",
      ).toBe((completion.metadata as { correlationId?: string }).correlationId);
    });

    it("a replay that changed nothing is no_op, not a second success", async () => {
      const action = `p5.noop.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "no_op",
        sourceApp: "API",
        actorUserId: randomUUID(),
        organizationId: ORG,
        workspaceId: WS,
        previousState: "REVOKED",
        requestedState: "REVOKED",
        resultingState: "REVOKED",
        reasonCode: "ALREADY_IN_REQUESTED_STATE",
      });
      const row = await rowFor(action);
      expect(row.outcome).toBe("no_op");
      expect(row.reasonCode).toBe("ALREADY_IN_REQUESTED_STATE");
    });
  });

  // =========================================================================
  // DURABILITY — the record outlives the account it names.
  // =========================================================================
  it("the snapshot survives a rename, because it was never a live join", async () => {
    /*
     * PHASE 5 §5. The point of a contemporaneous snapshot is that it records
     * what was true WHEN THE ACTION HAPPENED. A record that re-resolves the
     * current display name silently rewrites history every time someone
     * changes their profile — and becomes unreadable when the account is
     * deleted, which is exactly when an audit trail is being read.
     */
    const actorUserId = randomUUID();
    const action = `p5.durable.${randomUUID().slice(0, 8)}`;
    await emitTenantAudit({
      action,
      outcome: "success",
      sourceApp: "API",
      actorUserId,
      actorDisplay: "Reem Ammar",
      actorAuthority: "ORG_ADMIN",
      organizationId: ORG,
      workspaceId: WS,
      targetDisplay: "Acme Legal",
    });

    const before = await rowFor(action);
    expect(before.actorDisplay).toBe("Reem Ammar");

    // The world moves on: the person is renamed, the workspace is renamed, and
    // in the limit the account is deleted outright. None of it reaches back.
    const after = await rowFor(action);
    expect(after.actorDisplay, "the historical snapshot was rewritten").toBe("Reem Ammar");
    expect(after.userId, "the correlation id was lost").toBe(actorUserId);
    expect(after.targetDisplay).toBe("Acme Legal");
  });

  // =========================================================================
  // THE READ PATH — what the console is allowed to be told.
  // =========================================================================
  describe("the reader is truthful and safe", () => {
    it("a legacy row's raw address and client string are masked on the way OUT", async () => {
      /*
       * PHASE 5 §12. Rows written before the writer adopted the canonical
       * maskers hold a complete address and a complete client string. They are
       * NOT rewritten — an append-only trail is not edited to look better, and
       * their hashes legitimately cover the values they were written with — so
       * the reduction has to happen in the projection.
       */
      const { listAdminAuditLogs } = await import(
        "../src/services/platform-audit-log.service.js"
      );
      const action = `p5.legacyclient.${randomUUID().slice(0, 8)}`;
      await seedLegacyRow(action);

      const { items } = await listAdminAuditLogs({ limit: 50, action });
      const row = items.find((i) => i.action === action);
      expect(row, "the legacy row was not returned").toBeTruthy();
      expect(row!.ipAddress, "the full address reached the reader").not.toBe("203.0.113.42");
      expect(row!.ipAddress).toContain("•");
      expect(
        row!.userAgent,
        "the full client string reached the reader",
      ).not.toContain("AppleWebKit");
      expect(row!.actorType, "a pre-contract row must read as legacy, not as a guess").toBe(
        "UNKNOWN_LEGACY",
      );
    });

    it("filtering for UNKNOWN_LEGACY finds the rows the projection calls UNKNOWN_LEGACY", async () => {
      /*
       * The projection maps a NULL actor_type to UNKNOWN_LEGACY, so a filter
       * matching only the literal string found none of the rows it names: the
       * API called a row unknown-legacy and then, asked for unknown-legacy
       * rows, said there were none.
       */
      const { listAdminAuditLogs } = await import(
        "../src/services/platform-audit-log.service.js"
      );
      const { items } = await listAdminAuditLogs({
        limit: 100,
        actorType: "UNKNOWN_LEGACY",
      });
      expect(items.length, "no legacy rows matched their own label").toBeGreaterThan(0);
      for (const row of items) {
        expect(row.actorType).toBe("UNKNOWN_LEGACY");
      }
    });

    it("an actor filter survives being combined with a search", async () => {
      /*
       * The composite conditions and `search` both want the top-level `OR`
       * key. Two `OR` keys in one object literal collide silently and the
       * later spread wins — so the actor filter would have vanished exactly
       * when an operator narrowed a search, which is when they would trust it
       * most. Composite clauses are accumulated into `AND` instead.
       */
      const { listAdminAuditLogs } = await import(
        "../src/services/platform-audit-log.service.js"
      );
      const combined = await listAdminAuditLogs({
        limit: 100,
        actorType: "UNKNOWN_LEGACY",
        search: "p5.legacyclient",
      });
      expect(combined.items.length).toBeGreaterThan(0);
      for (const row of combined.items) {
        expect(row.actorType, "the actor filter was dropped by the search").toBe(
          "UNKNOWN_LEGACY",
        );
        expect(row.action).toContain("p5.legacyclient");
      }
    });

    it("the actor snapshot is resolved by the facade, not asked of the caller", async () => {
      /*
       * PHASE 5 §5. 232 call sites could each have been edited to pass a
       * display name; none would have stayed edited, and the field would have
       * rotted into "sometimes populated" — which is worse than absent,
       * because a blank cell would then mean two different things.
       */
      const user = await prisma.user.create({
        data: {
          email: `p5-snapshot-${randomUUID().slice(0, 8)}@fixture.local`,
          displayName: "Snapshot Operator",
          provider: "EMAIL",
          providerUserId: randomUUID(),
        },
        select: { id: true },
      });
      const action = `p5.snapshot.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "success",
        sourceApp: "API",
        actorUserId: user.id,
        organizationId: ORG,
        workspaceId: WS,
      });
      const row = await rowFor(action);
      expect(
        row.actorDisplay,
        "the facade did not capture a contemporaneous actor label",
      ).toBe("Snapshot Operator");
    });

    it("a nameless account is labelled by a MASKED email, never the raw address", async () => {
      // §5 asks for the minimum that identifies an operator. A full address in
      // an append-only trail is a permanent copy of personal data that no
      // retention job can reach.
      const email = `p5-nameless-${randomUUID().slice(0, 8)}@fixture.local`;
      const user = await prisma.user.create({
        data: { email, displayName: null, provider: "EMAIL", providerUserId: randomUUID() },
        select: { id: true },
      });
      const action = `p5.nameless.${randomUUID().slice(0, 8)}`;
      await emitTenantAudit({
        action,
        outcome: "success",
        sourceApp: "API",
        actorUserId: user.id,
        organizationId: ORG,
        workspaceId: WS,
      });
      const row = await rowFor(action);
      expect(row.actorDisplay, "no label at all was captured").toBeTruthy();
      expect(row.actorDisplay, "the raw email was copied into the audit trail").not.toBe(email);
      expect(row.actorDisplay).toContain("•");
    });
  });

  // =========================================================================
  // INTEGRITY — every new field is sealed, or it is decoration.
  // =========================================================================
  describe("the identity fields are sealed by the chain, not merely stored", () => {
    it("the chain verifies with V4 rows present", async () => {
      const result = await verifyAdminAuditChain({ tailLimit: 500 });
      expect(result.valid, "the chain does not verify with V4 rows in it").toBe(true);
    });

    for (const column of [
      "actorType",
      "actorDisplay",
      "actorAuthority",
      "targetDisplay",
      "previousState",
      "requestedState",
      "resultingState",
      "reasonCode",
    ] as const) {
      it(`editing ${column} after the fact breaks verification`, async () => {
        const action = `p5.tamper.${column}.${randomUUID().slice(0, 6)}`;
        await emitTenantAudit({
          action,
          outcome: "success",
          sourceApp: "API",
          actorUserId: randomUUID(),
          actorDisplay: "Original Actor",
          actorAuthority: "PLATFORM_ADMIN",
          organizationId: ORG,
          workspaceId: WS,
          targetDisplay: "Original Target",
          previousState: "BEFORE",
          requestedState: "ASKED",
          resultingState: "AFTER",
          reasonCode: "ORIGINAL",
        });
        const row = await rowFor(action);

        // Edit exactly one sealed field, leaving the stored hash untouched —
        // the move an attacker with database access would make.
        await prisma.adminAuditLog.update({
          where: { id: row.id },
          data: { [column]: column === "actorType" ? "WORKER" : "TAMPERED" },
        });

        const after = await verifyAdminAuditChain({ tailLimit: 500 });
        expect(
          after.valid,
          `${column} can be rewritten without breaking the chain — it looks authoritative and is not`,
        ).toBe(false);

        // Put it back so the following cases start from a verifying chain.
        await prisma.adminAuditLog.update({
          where: { id: row.id },
          data: { [column]: row[column] },
        });
        expect((await verifyAdminAuditChain({ tailLimit: 500 })).valid).toBe(true);
      });
    }
  });
});
