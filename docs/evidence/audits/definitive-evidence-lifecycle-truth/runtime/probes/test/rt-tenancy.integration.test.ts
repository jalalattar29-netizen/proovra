/**
 * RUNTIME PROBE RT-TENANCY — audit-only. Disposable loopback PostgreSQL 16,
 * real Fastify inject through the product's integration harness.
 *
 *   SEC-09  a LEGACY NULL-team case owned by user X can link user Y's LEGACY
 *           NULL-team evidence; X can then read Y's record.
 *           Precondition rows are seeded directly because the current API
 *           no longer mints NULL-team cases (cases.routes.ts:356-360); such
 *           rows exist historically and SEC-02 manufactures NULL-team evidence.
 *   SEC-02  detaching workspace evidence from its last case clears teamId.
 *   SEC-01  the destruction executor decides legal hold from the caller's
 *           pre-claim boolean: a hold that is ACTIVE in the database when the
 *           executor runs does not stop destruction. The storage port is an
 *           in-memory recorder (the S3 boundary); the DB behaviour is real.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../../services/api/test/integration-harness.js";

const RESULTS = path.resolve(__dirname, "..", "..", "results");
const record = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};
const API = "../../../../../../../services/api";

describe("RT-TENANCY (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  it("SEC-09: cross-user read through a legacy NULL-team case link", async () => {
    const victimUserId = h.fixtures.personal.userId;
    const attacker = { userId: h.fixtures.teamB.memberUserId, token: h.fixtures.teamB.memberToken };
    const victimEv = await prisma.evidence.create({
      data: { title: `ET victim private record ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: null, ownerUserId: victimUserId } as never,
      select: { id: true },
    });
    const attackerCase = await prisma.case.create({
      data: { name: `ET attacker legacy case ${randomUUID().slice(0, 6)}`, teamId: null, ownerUserId: attacker.userId } as never,
      select: { id: true },
    });
    const readBefore = await h.app.inject({ method: "GET", url: `/v1/evidence/${victimEv.id}`, headers: auth(attacker.token) });
    const link = await h.app.inject({ method: "POST", url: `/v1/cases/${attackerCase.id}/evidence-links`, headers: auth(attacker.token), payload: { evidenceId: victimEv.id } });
    const readAfter = await h.app.inject({ method: "GET", url: `/v1/evidence/${victimEv.id}`, headers: auth(attacker.token) });
    const dbLink = await prisma.caseEvidenceLink.findFirst({ where: { caseId: attackerCase.id, evidenceId: victimEv.id }, select: { id: true } });
    const out = {
      probe: "RT-TENANCY/SEC-09",
      readBeforeLink: readBefore.statusCode,
      linkStatus: link.statusCode,
      linkRowCreated: Boolean(dbLink),
      readAfterLink: readAfter.statusCode,
      victimTitleVisibleToAttacker: readAfter.body.includes("ET victim private record"),
    };
    record("rt-tenancy-sec09", out);
    expect(readBefore.statusCode).toBe(404);
  });

  it("SEC-02: detaching workspace evidence from its last case moves it out of the workspace", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const c = await prisma.case.findUniqueOrThrow({ where: { id: A.caseId }, select: { id: true, ownerUserId: true } });
    // The attach route requires the actor to own the evidence; the case owner captured it.
    const ev = await prisma.evidence.create({
      data: { title: `ET workspace record ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: c.ownerUserId } as never,
      select: { id: true },
    });
    const ownerToken = c.ownerUserId === A.ownerUserId ? A.ownerToken : c.ownerUserId === A.adminUserId ? A.adminToken : A.memberToken;
    const attach = await h.app.inject({ method: "POST", url: `/v1/cases/${c.id}/evidence`, headers: auth(ownerToken), payload: { evidenceId: ev.id } });
    const adminBefore = await h.app.inject({ method: "GET", url: `/v1/evidence/${ev.id}`, headers: auth(A.adminToken) });
    const detach = await h.app.inject({ method: "DELETE", url: `/v1/cases/${c.id}/evidence/${ev.id}`, headers: auth(ownerToken) });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { teamId: true, ownerUserId: true } });
    const adminAfter = await h.app.inject({ method: "GET", url: `/v1/evidence/${ev.id}`, headers: auth(A.adminToken) });
    const creatorAfter = await h.app.inject({ method: "GET", url: `/v1/evidence/${ev.id}`, headers: auth(ownerToken) });
    const out = {
      probe: "RT-TENANCY/SEC-02",
      attachStatus: attach.statusCode,
      attachBody: attach.body.slice(0, 300),
      detachBody: detach.body.slice(0, 300),
      workspaceAdminReadBefore: adminBefore.statusCode,
      detachStatus: detach.statusCode,
      teamIdAfterDetach: row.teamId,
      workspaceAdminReadAfter: adminAfter.statusCode,
      creatorReadAfter: creatorAfter.statusCode,
    };
    record("rt-tenancy-sec02", out);
    expect(attach.statusCode).toBeLessThan(300);
  });

  it("SEC-01: an ACTIVE legal hold does not stop the executor when the caller's verdict predates it", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const ev = await prisma.evidence.create({
      data: {
        title: "ET trashed record", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId,
        lifecycleState: "TRASHED", deletedAt: past, deleteScheduledForUtc: new Date(Date.now() - 24 * 3600 * 1000),
        storageBucket: "fixture-bucket", storageKey: `evidence/${randomUUID()}/original.png`,
      } as never,
      select: { id: true, storageKey: true },
    });
    // 1. The orchestrator gathers facts: no hold yet.
    const { placeCanonicalLegalHold } = await import(`${API}/src/services/governance/legal-hold.service.js`);
    const holdsAtGather = await prisma.evidenceLegalHold.count({ where: { evidenceId: ev.id, status: "ACTIVE" } as never });
    // 2. A hold is placed through the production service before the executor runs.
    const hold = await placeCanonicalLegalHold({ teamId: A.teamId, scope: "EVIDENCE", evidenceId: ev.id, actorUserId: A.ownerUserId, title: "ET hold placed mid-execution" });
    const holdsAtExecute = await prisma.evidenceLegalHold.count({ where: { evidenceId: ev.id, status: "ACTIVE" } as never });
    // 3. The executor runs with the verdict gathered in step 1.
    const { executeEvidenceDestruction } = await import("../../../../../../../packages/shared-runtime/src/evidence-destruction/executor.ts");
    const deleted: string[] = [];
    // Honest in-memory store: one data version per key until it is deleted.
    const storage = {
      async listObjectVersions({ key }: { bucket: string; key: string }) {
        return deleted.includes(`${key}@v1`) ? [] : [{ versionId: "v1", isDeleteMarker: false, isLatest: true, retainUntil: null, lockMode: null, legalHold: false }];
      },
      async listKeysUnderPrefix() { return []; },
      async deleteObjectVersion({ key, versionId }: { bucket: string; key: string; versionId: string }) {
        deleted.push(`${key}@${versionId}`);
        return { ok: true };
      },
    };
    let result: unknown;
    let error: string | null = null;
    try {
      result = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "destruction_review", legalHold: holdsAtGather > 0 }, storage as never);
    } catch (e) {
      error = String((e as Error).message ?? e);
    }
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { lifecycleState: true, destroyedAtUtc: true } });
    const out = {
      probe: "RT-TENANCY/SEC-01",
      activeHoldsAtGather: holdsAtGather,
      activeHoldsWhenExecutorRan: holdsAtExecute,
      holdId: hold.id,
      executorResult: result ?? null,
      executorError: error,
      storageVersionsDeleted: deleted,
      lifecycleStateAfter: after.lifecycleState,
      destroyedAtUtcSet: Boolean(after.destroyedAtUtc),
    };
    record("rt-tenancy-sec01", out);
    expect(holdsAtExecute).toBe(1);
  });
});
