/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G1-REACH (live PostgreSQL).
 *
 * Record and case reach on the secondary reads and writes the audit found
 * outside the canonical authority (`services/access/record-reach.ts`), and the
 * existence leaks that answered a refused caller differently from a missing
 * resource. One fixture, real rows:
 *
 *   restricted case R, listed: `listed` (a MEMBER)
 *     hidden record H: linked to R only
 *     shared record S: linked to R and to the open case O
 *   open case O
 *     visible record V: linked to O
 *
 * `off` (MEMBER), `offViewer` (VIEWER) and `offAdmin` (ADMIN) are off R's list.
 * Every refusal has a positive control on the same rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateVerificationRef } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

const tag = () => randomUUID().slice(0, 8);
const RESTRICTED_NAME = `G1-SENTINEL-CASE-${tag()}`;
const HIDDEN_TITLE = `g1-hidden-${tag()}`;
const SHARED_TITLE = `g1-shared-${tag()}`;
const VISIBLE_TITLE = `g1-visible-${tag()}`;

describe("free-audit 0ea0 — API-G1-REACH (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let verificationShare: typeof import("../src/services/governance/verification-share.service.js");
  let policyViolations: typeof import("../src/services/lifecycle/policy-violation.service.js");
  let reachModule: typeof import("../src/services/access/record-reach.js");
  const A = () => h.fixtures.teamA;

  let listed: Person;
  let off: Person;
  let offViewer: Person;
  let offAdmin: Person;
  let restrictedCaseId: string;
  let openCaseId: string;
  let hiddenId: string;
  let sharedId: string;
  let visibleId: string;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, who: Person) => h.app.inject({ method: "GET", url, headers: bearer(who.token) });
  const send = (method: "POST" | "DELETE", url: string, who: Person, payload?: unknown) =>
    h.app.inject({ method, url, headers: bearer(who.token), ...(payload === undefined ? {} : { payload: payload as never }) });
  const teamQ = () => `teamId=${A().teamId}`;
  const owner = (): Person => ({ id: A().ownerUserId, token: A().ownerToken });

  async function person(role: Role, status: "ACTIVE" | "SUSPENDED" = "ACTIVE"): Promise<Person> {
    const email = `g1-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, currentWorkspaceId: A().teamId } as never,
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function record(title: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    verificationShare = await import("../src/services/governance/verification-share.service.js");
    policyViolations = await import("../src/services/lifecycle/policy-violation.service.js");
    reachModule = await import("../src/services/access/record-reach.js");
    await prisma.team.updateMany({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });

    [listed, off, offViewer, offAdmin] = await Promise.all([
      person("MEMBER"),
      person("MEMBER"),
      person("VIEWER"),
      person("ADMIN"),
    ]);

    restrictedCaseId = (
      await prisma.case.create({
        data: { name: RESTRICTED_NAME, teamId: A().teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listed.id } });
    openCaseId = (
      await prisma.case.create({
        data: { name: `g1-open-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId },
        select: { id: true },
      })
    ).id;

    hiddenId = await record(HIDDEN_TITLE);
    sharedId = await record(SHARED_TITLE);
    visibleId = await record(VISIBLE_TITLE);
    await link(restrictedCaseId, hiddenId);
    await link(restrictedCaseId, sharedId);
    await link(openCaseId, sharedId);
    await link(openCaseId, visibleId);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const absent = (body: string) => {
    expect(body).not.toContain(hiddenId);
    expect(body).not.toContain(sharedId);
    expect(body).not.toContain(HIDDEN_TITLE);
    expect(body).not.toContain(SHARED_TITLE);
  };

  // ===========================================================================
  // Medium rows
  // ===========================================================================

  it("B3C-F-002: the message list names no record, request or thread closed to the reader", async () => {
    const preview = `g1-msg-${tag()}`;
    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: A().teamId,
        title: `g1-req-${tag()}`,
        evidenceId: hiddenId,
        requestedByUserId: A().ownerUserId,
        requestType: "ADDITIONAL_EVIDENCE",
        recipientMode: "INTERNAL_USER",
      } as never,
      select: { id: true },
    });
    const base = {
      teamId: A().teamId,
      channel: "SMS",
      purpose: "EVIDENCE_REQUEST",
      recipientHash: `h-${tag()}`,
    };
    await prisma.communicationMessage.createMany({
      data: [
        { ...base, recipientPreview: `${preview}-record`, relatedEvidenceId: hiddenId },
        { ...base, recipientPreview: `${preview}-request`, relatedEvidenceRequestId: request.id },
        { ...base, recipientPreview: `${preview}-open`, relatedEvidenceId: visibleId },
      ] as never,
    });
    const theirs = await get(`/v1/communications/messages?${teamQ()}&limit=500`, off);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.body).toContain(`${preview}-open`);
    expect(theirs.body).not.toContain(`${preview}-record`);
    expect(theirs.body).not.toContain(`${preview}-request`);
    absent(theirs.body);
    const mine = await get(`/v1/communications/messages?${teamQ()}&limit=500`, listed);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain(`${preview}-record`);
    expect(mine.body).toContain(`${preview}-request`);
  });

  it("B5B-F-100: the legacy verify-link inventory neither lists nor counts a closed record", async () => {
    const until = new Date(Date.now() + 10 * 86_400_000);
    for (const id of [hiddenId, visibleId]) {
      await prisma.evidence.update({
        where: { id },
        data: { legacyVerifyUuidUntilUtc: until, verificationRef: generateVerificationRef() } as never,
      });
    }
    const theirs = await verificationShare.legacyVerifyLinkInventory({ teamId: A().teamId, actorUserId: offAdmin.id });
    const ids = theirs.records.map((r) => r.evidenceId);
    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);
    const mine = await verificationShare.legacyVerifyLinkInventory({ teamId: A().teamId, actorUserId: listed.id });
    expect(mine.records.map((r) => r.evidenceId)).toContain(hiddenId);
    expect(theirs.activeCount).toBe(mine.activeCount - 1);
  });

  it("B5B-F-304: the SIU worklist excludes a restricted case, from rows and total", async () => {
    await prisma.caseSiuProfile.create({
      data: { caseId: restrictedCaseId, teamId: A().teamId, claimType: "AUTO", investigationStatus: "intake" } as never,
    });
    await prisma.caseSiuProfile.create({
      data: { caseId: openCaseId, teamId: A().teamId, claimType: "AUTO", investigationStatus: "intake" } as never,
    });
    const theirs = await get(`/v1/siu/worklist?${teamQ()}`, off);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.body).not.toContain(restrictedCaseId);
    expect(theirs.body).toContain(openCaseId);
    const mine = await get(`/v1/siu/worklist?${teamQ()}`, listed);
    expect(mine.body).toContain(restrictedCaseId);
    expect((mine.json() as { total: number }).total).toBe((theirs.json() as { total: number }).total + 1);
  });

  it("B6-F-43: jobs and provider usage name no closed record; accept/revert on its correction writes nothing", async () => {
    await prisma.evidenceIntelligenceJob.createMany({
      data: [
        { evidenceId: hiddenId, teamId: A().teamId, kind: "OCR" },
        { evidenceId: visibleId, teamId: A().teamId, kind: "OCR" },
      ] as never,
    });
    await prisma.providerUsageEvent.createMany({
      data: [
        { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", evidenceId: hiddenId },
        { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", caseId: restrictedCaseId },
        { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", evidenceId: visibleId },
      ] as never,
    });
    const jobs = await get(`/v1/intelligence/jobs?${teamQ()}&limit=200`, off);
    expect(jobs.statusCode, jobs.body).toBe(200);
    expect(jobs.body).toContain(visibleId);
    absent(jobs.body);
    const usage = await get(`/v1/intelligence/providers/usage`, off);
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.body).toContain(visibleId);
    absent(usage.body);
    expect(usage.body).not.toContain(restrictedCaseId);
    const mineJobs = await get(`/v1/intelligence/jobs?${teamQ()}&limit=200`, listed);
    expect(mineJobs.body).toContain(hiddenId);

    const rec = await prisma.mediaIntelligenceRecord.create({
      data: { teamId: A().teamId, evidenceId: hiddenId, modality: "TEXT", kind: "ENTITY", provider: "LOCAL", providerRecordKey: `k-${tag()}` } as never,
      select: { id: true },
    });
    const correction = await prisma.reviewerCorrection.create({
      data: { teamId: A().teamId, recordId: rec.id, kind: "ENTITY_EDIT", authoredByUserId: listed.id } as never,
      select: { id: true },
    });
    for (const action of ["accept", "revert"]) {
      const closed = await send("POST", `/v1/intelligence/corrections/${correction.id}/${action}`, offAdmin, {});
      const unknown = await send("POST", `/v1/intelligence/corrections/${randomUUID()}/${action}`, offAdmin, {});
      expect(closed.statusCode, closed.body).toBe(409);
      expect(closed.json()).toEqual(unknown.json());
    }
    const after = await prisma.reviewerCorrection.findMany({ where: { recordId: rec.id }, select: { state: true } });
    expect(after).toEqual([{ state: "DRAFT" }]);
  });

  it("B4-F-203: a trust timeline is the session owner's, and its sealed record answers to the record rule", async () => {
    const mk = async (ownerUserId: string, finalizedEvidenceId: string | null) =>
      (
        await prisma.captureSession.create({
          data: { ownerUserId, teamId: A().teamId, status: "DRAFT", finalizedEvidenceId } as never,
          select: { id: true },
        })
      ).id;
    const ownerSession = await mk(A().ownerUserId, visibleId);
    const offSessionOnClosed = await mk(off.id, hiddenId);
    const unknown = await get(`/v1/capture/sessions/${randomUUID()}/trust-timeline?${teamQ()}`, offAdmin);
    expect(unknown.statusCode).toBe(404);
    const foreign = await get(`/v1/capture/sessions/${ownerSession}/trust-timeline?${teamQ()}`, offAdmin);
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    const closed = await get(`/v1/capture/sessions/${offSessionOnClosed}/trust-timeline?${teamQ()}`, off);
    expect(closed.statusCode, closed.body).toBe(404);
    expect(closed.json()).toEqual(unknown.json());
    const offSessionOnOpen = await mk(off.id, await record(`g1-session-${tag()}`));
    const mine = await get(`/v1/capture/sessions/${offSessionOnOpen}/trust-timeline?${teamQ()}`, off);
    expect(mine.statusCode, mine.body).toBe(200);
  });

  it("B3A-F-003 is proven in members-access-convergence.integration.test.ts (ROLE-02)", () => {
    expect(true).toBe(true);
  });

  // ===========================================================================
  // Low / Info rows
  // ===========================================================================

  it("B7B-F04 / B2A-F-05: a closed, a foreign and a missing record answer byte-identical 404s", async () => {
    const B = h.fixtures.teamB;
    const bTeam = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    const foreign = await prisma.evidence.create({
      data: {
        title: `g1-foreign-${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: B.teamId,
        organizationId: bTeam.organizationId,
        ownerUserId: B.ownerUserId,
      } as never,
      select: { id: true },
    });
    for (const path of [
      "/v1/governance/evidence/ID/status",
      "/v1/governance/evidence/ID/holds",
      "/v1/governance/evidence/ID/is-held",
      "/v1/provenance/ID",
    ]) {
      const bodies = [];
      for (const id of [hiddenId, foreign.id, randomUUID()]) {
        const r = await get(`${path.replace("ID", id)}?${teamQ()}`, offAdmin);
        expect(r.statusCode, `${path} ${r.body}`).toBe(404);
        bodies.push(r.body);
      }
      expect(new Set(bodies).size, path).toBe(1);
    }
  });

  it("B3C-F-004: unlinking a record also closed by another case is 404 for the record, removes nothing, names no case", async () => {
    const r = await send("DELETE", `/v1/cases/${openCaseId}/evidence/${sharedId}`, offAdmin);
    expect(r.statusCode, r.body).toBe(404);
    expect(r.body).not.toContain(restrictedCaseId);
    expect(await prisma.caseEvidenceLink.count({ where: { caseId: openCaseId, evidenceId: sharedId } })).toBe(1);
  });

  it("B3C-F-009: resolving a note the caller cannot read is 404 and returns no body", async () => {
    const body = `g1-internal-note-${tag()}`;
    const note = await prisma.caseComment.create({
      data: { teamId: A().teamId, caseId: openCaseId, authorUserId: A().ownerUserId, body, visibility: "INTERNAL" } as never,
      select: { id: true },
    });
    const refused = await send("POST", `/v1/cases/${openCaseId}/comments/${note.id}/resolve`, off, {});
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.body).not.toContain(body);
    expect((await prisma.caseComment.findUniqueOrThrow({ where: { id: note.id } })).resolvedAtUtc).toBeNull();
    const done = await send("POST", `/v1/cases/${openCaseId}/comments/${note.id}/resolve`, owner(), {});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).not.toContain(body);
  });

  it("B3C-F-003: case aggregates do not count a record closed through another case", async () => {
    const theirs = await get(`/v1/cases/${openCaseId}/link-reconciliation`, off);
    const mine = await get(`/v1/cases/${openCaseId}/link-reconciliation`, listed);
    expect(theirs.statusCode, theirs.body).toBe(200);
    const count = (r: typeof theirs) => (r.json() as { summary: { canonicalLinks: number } }).summary.canonicalLinks;
    expect(count(theirs)).toBe(count(mine) - 1);
  });

  it("B7B-F03: analytics counts follow record reach", async () => {
    const theirs = await get(`/v1/analytics/operations?${teamQ()}`, off);
    const mine = await get(`/v1/analytics/operations?${teamQ()}`, listed);
    expect(theirs.statusCode, theirs.body).toBe(200);
    const created = (r: typeof theirs) =>
      (r.json() as { metrics: { evidenceCreated: number | null } }).metrics.evidenceCreated ?? 0;
    expect(created(theirs)).toBe(created(mine) - 2);
  });

  it("B2A-F-08: the transparency timeline drops entries naming a closed record or case", async () => {
    const theirs = await get(`/v1/audit-transparency?category=PROVIDER_USAGE&limit=500`, off);
    expect(theirs.statusCode, theirs.body).toBe(200);
    absent(theirs.body);
    expect(theirs.body).not.toContain(restrictedCaseId);
    expect(theirs.body).toContain(visibleId);
  });

  it("B2B-F-05: history naming a record closed to the reader is redacted", async () => {
    const key = `intake_submission_pending_review:${randomUUID()}`;
    const secret = `g1-history-${tag()}`;
    for (const who of [off, listed]) {
      await prisma.operationsInboxSnapshot.create({
        data: {
          userId: who.id,
          itemKey: key,
          sourceType: "intake_submission_pending_review",
          sourceId: key.split(":")[1],
          teamId: A().teamId,
          category: "intake_submission_pending_review",
          severity: "warning",
          priority: "P3",
          title: secret,
          body: secret,
          href: `/evidence/${hiddenId}`,
          sourceOccurredAtUtc: new Date(Date.now() - 86_400_000),
          readAtUtc: new Date(),
          resolvedAtUtc: new Date(),
          resolutionSource: "SOURCE_STATE",
          metadataJson: { evidenceId: hiddenId },
        } as never,
      });
    }
    const page = async (who: Person) => {
      const r = await get(`/v1/me/inbox?include=resolved&sort=newest&pageSize=50`, who);
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { items: Array<{ itemKey: string; title: string; href: string }> }).items.find(
        (i) => i.itemKey === key,
      );
    };
    const theirs = await page(off);
    expect(theirs).toBeDefined();
    expect(theirs!.title).not.toContain(secret);
    expect(theirs!.href).toBe("");
    const mine = await page(listed);
    expect(mine!.title).toBe(secret);
  });

  it("B2A-F-10 / B3C-F-011: a suspended member is answered like a non-member on search and SIU case routes", async () => {
    const suspended = await person("MEMBER", "SUSPENDED");
    const outsiderEmail = `g1-out-${tag()}@test.proovra.local`;
    const outsiderUser = await prisma.user.create({
      data: { email: outsiderEmail, provider: "EMAIL", providerUserId: outsiderEmail } as never,
      select: { id: true },
    });
    const outsider: Person = {
      id: outsiderUser.id,
      token: signJwt(
        { sub: outsiderUser.id, provider: "EMAIL", email: outsiderEmail, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
    };
    for (const path of [`/v1/search?${teamQ()}&q=g1`, `/v1/cases/${openCaseId}/siu-profile`]) {
      const s = await get(path, suspended);
      const o = await get(path, outsider);
      expect(s.statusCode, `${path} ${s.body}`).toBe(404);
      expect(s.statusCode).toBe(o.statusCode);
      expect(s.json()).toEqual(o.json());
    }
  });

  it("B3C-F-010: graph diagnostics hide the cross-tenant queue depth from a workspace admin", async () => {
    const r = await get(`/v1/graph/diagnostics?${teamQ()}`, offAdmin);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { queueDepth: unknown }).queueDepth).toBeNull();
  });

  it("B4-F-204: a Viewer cannot register a capture signing device", async () => {
    const before = await prisma.device.count({ where: { teamId: A().teamId } });
    const r = await send("POST", `/v1/capture/devices?${teamQ()}`, offViewer, {
      label: "g1",
      signatureAlgorithm: "ECDSA_P256_SHA256",
      publicKeyHex: "04".padEnd(130, "a"),
      attestationProvider: "NONE",
    });
    expect(r.statusCode, r.body).toBe(403);
    expect(await prisma.device.count({ where: { teamId: A().teamId } })).toBe(before);
  });

  it("B5A-F-06 / B5A-F-09: record reads carrying presigned URLs are no-store; a Viewer gets no billing usage", async () => {
    for (const path of [`/v1/evidence/${visibleId}`, `/v1/evidence/${visibleId}/review-workspace`]) {
      const r = await get(path, owner());
      expect(r.statusCode, `${path} ${r.body.slice(0, 200)}`).toBe(200);
      expect(r.headers["cache-control"], path).toBe("no-store");
    }
    const viewer = await get(`/v1/evidence/${visibleId}/review-workspace`, offViewer);
    expect(viewer.statusCode, viewer.body.slice(0, 200)).toBe(200);
    const snap = (viewer.json() as { workspaceCapabilitySnapshot?: Record<string, unknown> }).workspaceCapabilitySnapshot;
    expect(snap?.storageUsedLabel ?? null).toBeNull();
    expect(snap?.seatsUsed ?? null).toBeNull();
    const own = await get(`/v1/evidence/${visibleId}/review-workspace`, owner());
    const ownSnap = (own.json() as { workspaceCapabilitySnapshot?: Record<string, unknown> }).workspaceCapabilitySnapshot;
    expect(ownSnap?.seatsUsed).not.toBeNull();
  });

  it("B6-F-45: run/text cannot record caller text the platform did not extract from the record", async () => {
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, contentIntelligenceEnabled: true, rawContentProcessingAllowed: true },
      update: { contentIntelligenceEnabled: true, rawContentProcessingAllowed: true },
    });
    const fresh = await record(`g1-runtext-${tag()}`);
    const r = await send("POST", `/v1/intelligence/evidence/${fresh}/run/text`, offAdmin, {
      provider: "LOCAL_ENTITY_EXTRACTION",
      operation: "EXTRACT_ENTITIES",
      text: "Jane Doe met John Roe in Paris.",
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(await prisma.mediaIntelligenceRecord.count({ where: { evidenceId: fresh } })).toBe(0);
    expect(await prisma.providerUsageEvent.count({ where: { evidenceId: fresh } as never })).toBe(0);
  });

  it("B5B-F-305: lifecycle reads name no closed record", async () => {
    const lifecycle = policyViolations;
    const reach = reachModule;
    await prisma.intelligenceActivityEvent.create({
      data: {
        teamId: A().teamId,
        category: "POLICY",
        code: policyViolations.POLICY_VIOLATION_CODES[0],
        evidenceId: hiddenId,
      } as never,
    });
    const theirs = await lifecycle.listPolicyViolations({
      teamId: A().teamId,
      hidden: await reach.hiddenRecordIdsInWorkspace(A().teamId, off.id),
    });
    expect(JSON.stringify(theirs)).not.toContain(hiddenId);
    const mine = await lifecycle.listPolicyViolations({
      teamId: A().teamId,
      hidden: await reach.hiddenRecordIdsInWorkspace(A().teamId, listed.id),
    });
    expect(JSON.stringify(mine)).toContain(hiddenId);
  });
});
