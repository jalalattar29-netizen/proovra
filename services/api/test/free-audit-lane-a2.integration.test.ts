/**
 * FREE-USER AUDIT 0ea0 — RESIDUAL LANE A2 (live PostgreSQL).
 *
 * The five rows left FIXED-PARTIAL / PRODUCT-DECISION after the G1/G2 passes,
 * closed on the owner directives:
 *
 *   B5A-F-13   exact capture location needs the original-content authority
 *   B3C-F-002  the Messaging console is an operator read
 *   B2A-F-08   the transparency timeline is the UI's Enterprise-organization surface
 *   B7A-F-005  staff rosters carry no record title / owner email without a grant
 *   B7B-F03    the remaining executive and governance-analytics counts follow reach
 *
 * One fixture, real rows, the same shape as the G1 suite:
 *
 *   restricted case R, listed: `listed` (a MEMBER)
 *     hidden record H: linked to R only
 *   open case O
 *     visible record V: linked to O
 *
 * `off` (MEMBER), `offViewer` (VIEWER) and `offAdmin` (ADMIN) are off R's list.
 * Every refusal has a positive control on the same rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

const tag = () => randomUUID().slice(0, 8);

describe("free-audit 0ea0 — residual lane A2 (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let fx: typeof import("./point7/product-fixtures.js");
  let supportAccess: typeof import("../src/services/identity/support-access.service.js");
  let deps: FixtureDeps;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  let listed: Person;
  let off: Person;
  let offViewer: Person;
  let offAdmin: Person;
  let restrictedCaseId: string;
  let openCaseId: string;
  let hiddenId: string;
  let visibleId: string;
  let ip = 1;

  const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  const get = (url: string, who: Person, extra: Record<string, string> = {}) =>
    h.app.inject({ method: "GET", url, remoteAddress: `198.51.100.${(ip++ % 250) + 1}`, headers: bearer(who.token, extra) });
  const post = (url: string, who: Person, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: bearer(who.token), payload: payload as never });
  const teamQ = () => `teamId=${A().teamId}`;
  const owner = (): Person => ({ id: A().ownerUserId, token: A().ownerToken });

  async function person(role: Role, teamId: string = A().teamId): Promise<Person> {
    const email = `a2-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, currentWorkspaceId: teamId } as never,
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
    await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function record(title: string, extra: Record<string, unknown> = {}, teamId: string = A().teamId, ownerUserId: string = A().ownerUserId): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId,
          organizationId: team.organizationId,
          ownerUserId,
          sizeBytes: 1_000n,
          ...extra,
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
    fx = await import("./point7/product-fixtures.js");
    supportAccess = await import("../src/services/identity/support-access.service.js");
    deps = {
      prisma: prisma as never,
      tag: `a2-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
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
        data: { name: `a2-restricted-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listed.id } });
    openCaseId = (
      await prisma.case.create({
        data: { name: `a2-open-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId },
        select: { id: true },
      })
    ).id;

    hiddenId = await record(`a2-hidden-${tag()}`);
    visibleId = await record(`a2-visible-${tag()}`);
    await link(restrictedCaseId, hiddenId);
    await link(openCaseId, visibleId);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // B5A-F-13 — exact capture location
  // ===========================================================================

  describe("B5A-F-13: exact coordinates and the map link need the original-content authority", () => {
    const LAT = "52.520008";
    const LNG = "13.404954";
    let located: string;

    beforeAll(async () => {
      located = await record(`a2-located-${tag()}`, {
        lat: Number(LAT),
        lng: Number(LNG),
        accuracyMeters: 12,
        locationSource: "CAPTURE",
      });
      await link(openCaseId, located);
    });

    it("owner, admin and member (evidence.download_original) receive the coordinates and the map link", async () => {
      for (const who of [owner(), offAdmin, off]) {
        const detail = await get(`/v1/evidence/${located}`, who);
        expect(detail.statusCode, detail.body.slice(0, 300)).toBe(200);
        expect((detail.json() as { evidence: { lat: number | null } }).evidence.lat).toBe(Number(LAT));
        const rw = await get(`/v1/evidence/${located}/review-workspace`, who);
        expect(rw.statusCode, rw.body.slice(0, 300)).toBe(200);
        const body = rw.json() as {
          locationState: { state: string };
          sourceCaptureLocation: { lat: number; externalMapUrl: string | null } | null;
          evidence: { lat: number | null };
        };
        expect(body.locationState.state).toBe("RECORDED");
        expect(body.sourceCaptureLocation?.lat).toBe(Number(LAT));
        expect(body.sourceCaptureLocation?.externalMapUrl).toContain(LAT);
        expect(body.evidence.lat).toBe(Number(LAT));
      }
    });

    it("a Viewer gets the canonical WITHHELD state and no coordinate, accuracy or map link in any payload", async () => {
      const detail = await get(`/v1/evidence/${located}`, offViewer);
      expect(detail.statusCode, detail.body.slice(0, 300)).toBe(200);
      const ev = (detail.json() as { evidence: { lat: unknown; lng: unknown; accuracyMeters: unknown } }).evidence;
      expect([ev.lat, ev.lng, ev.accuracyMeters]).toEqual([null, null, null]);
      expect(detail.body).not.toContain(LAT);
      expect(detail.body).not.toContain(LNG);

      const rw = await get(`/v1/evidence/${located}/review-workspace`, offViewer);
      expect(rw.statusCode, rw.body.slice(0, 300)).toBe(200);
      const body = rw.json() as {
        locationState: { state: string };
        sourceCaptureLocation: unknown;
        evidence: { lat: unknown; lng: unknown; accuracyMeters: unknown };
        sourceContext?: { locationIncluded?: boolean };
      };
      expect(body.locationState.state).toBe("WITHHELD");
      expect(body.sourceCaptureLocation).toBeNull();
      expect([body.evidence.lat, body.evidence.lng, body.evidence.accuracyMeters]).toEqual([null, null, null]);
      expect(rw.body).not.toContain(LAT);
      expect(rw.body).not.toContain(LNG);
      expect(rw.body).not.toContain("openstreetmap");
    });

    // Residual pass 2026-11-17 — the issued report PDF prints the exact
    // location, and issued artifacts are never rewritten. A reader without the
    // location authority is refused the REPORT of a record that holds a
    // location, and pointed at the external disclosure package (coordinates
    // rounded to ~1 km). The full forensic package already needs
    // evidence.download_original (it embeds the originals).
    it("a Viewer is refused the report of a located record; other records and authorized readers are not affected", async () => {
      const refused = await get(`/v1/evidence/${located}/report/latest`, offViewer);
      expect(refused.statusCode, refused.body.slice(0, 300)).toBe(403);
      expect((refused.json() as { code?: string }).code).toBe("REPORT_REQUIRES_LOCATION_ACCESS");
      expect(refused.body).not.toContain(LAT);

      // The same Viewer on a record with no location: the location rule does not apply.
      const unlocated = await get(`/v1/evidence/${visibleId}/report/latest`, offViewer);
      expect((unlocated.json() as { code?: string }).code).not.toBe("REPORT_REQUIRES_LOCATION_ACCESS");

      // Authorized readers of the located record pass the location rule.
      for (const who of [owner(), off]) {
        const ok = await get(`/v1/evidence/${located}/report/latest`, who);
        expect((ok.json() as { code?: string }).code, `${ok.statusCode} ${ok.body.slice(0, 200)}`).not.toBe(
          "REPORT_REQUIRES_LOCATION_ACCESS",
        );
      }
    });
  });

  // ===========================================================================
  // B3C-F-002 — Messaging console
  // ===========================================================================

  describe("B3C-F-002: the Messaging console is an operator read; a Viewer gets a record-scoped, minimized summary", () => {
    let preview: string;
    let openLinkId: string;
    let closedLinkId: string;
    let requestId: string;

    const intakeLink = async (caseId: string | null) =>
      (
        await prisma.workflowIntakeLink.create({
          data: {
            teamId: A().teamId,
            workflowTemplateSlug: "general-evidence-record",
            workflowTemplateVersion: 1,
            workflowTemplateSnapshot: {},
            intakeMode: "EXTERNAL_ONE_TIME",
            allowedAcceptedKinds: [],
            ipAllowlistCidrs: [],
            tokenHash: `a2-${randomUUID()}`,
            expiresAtUtc: new Date(Date.now() + 86_400_000),
            createdByUserId: A().ownerUserId,
            caseId,
          } as never,
          select: { id: true },
        })
      ).id;

    beforeAll(async () => {
      preview = `a2-msg-${tag()}`;
      openLinkId = await intakeLink(openCaseId);
      closedLinkId = await intakeLink(restrictedCaseId);
      requestId = (
        await prisma.evidenceRequest.create({
          data: {
            teamId: A().teamId,
            title: `a2-req-${tag()}`,
            evidenceId: visibleId,
            requestedByUserId: A().ownerUserId,
            requestType: "ADDITIONAL_EVIDENCE",
            recipientMode: "INTERNAL_USER",
          } as never,
          select: { id: true },
        })
      ).id;
      const base = { teamId: A().teamId, channel: "SMS", purpose: "INTAKE_LINK", recipientHash: `h-${tag()}` };
      await prisma.communicationMessage.createMany({
        data: [
          { ...base, recipientPreview: `${preview}-open-link`, bodyPreview: `${preview}-body`, relatedIntakeLinkId: openLinkId, errorCode: null },
          { ...base, recipientPreview: `${preview}-closed-link`, relatedIntakeLinkId: closedLinkId },
          { ...base, recipientPreview: `${preview}-request`, bodyPreview: `${preview}-req-body`, relatedEvidenceRequestId: requestId, purpose: "EVIDENCE_REQUEST" },
          { ...base, recipientPreview: `${preview}-unbound`, purpose: "OTP" },
        ] as never,
      });
    });

    it("the workspace-wide console refuses a Viewer and serves the operator roles", async () => {
      const viewer = await get(`/v1/communications/messages?${teamQ()}&limit=500`, offViewer);
      expect(viewer.statusCode, viewer.body).toBe(403);
      expect(viewer.body).not.toContain(preview);

      for (const who of [off, offAdmin, owner()]) {
        const r = await get(`/v1/communications/messages?${teamQ()}&limit=500`, who);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.body).toContain(`${preview}-open-link`);
        expect(r.body).toContain(`${preview}-body`);
        expect(r.body).toContain(`${preview}-unbound`);
      }
    });

    it("an intake link bound to a restricted case is that case's row on the console", async () => {
      const theirs = await get(`/v1/communications/messages?${teamQ()}&limit=500`, off);
      expect(theirs.body).not.toContain(`${preview}-closed-link`);
      expect(theirs.body).not.toContain(closedLinkId);
      const mine = await get(`/v1/communications/messages?${teamQ()}&limit=500`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(`${preview}-closed-link`);
    });

    it("a Viewer's record-scoped read is minimized: no recipient, body or provider detail; no closed or unbound rows", async () => {
      const scoped = await get(`/v1/communications/messages?${teamQ()}&relatedIntakeLinkId=${openLinkId}`, offViewer);
      expect(scoped.statusCode, scoped.body).toBe(200);
      const rows = (scoped.json() as { messages: Array<Record<string, unknown>> }).messages;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipientPreview).toBeNull();
      expect(rows[0]!.bodyPreview).toBeNull();
      expect(rows[0]!.provider ?? null).toBeNull();
      expect(rows[0]!.contentWithheld).toBe(true);
      expect(scoped.body).not.toContain(preview);

      const byRequest = await get(`/v1/communications/messages?${teamQ()}&relatedEvidenceRequestId=${requestId}`, offViewer);
      expect(byRequest.statusCode, byRequest.body).toBe(200);
      expect((byRequest.json() as { messages: unknown[] }).messages).toHaveLength(1);
      expect(byRequest.body).not.toContain(preview);

      const closed = await get(`/v1/communications/messages?${teamQ()}&relatedIntakeLinkId=${closedLinkId}`, offViewer);
      expect(closed.statusCode, closed.body).toBe(200);
      expect((closed.json() as { messages: unknown[] }).messages).toHaveLength(0);

      // The operator's scoped read keeps the full projection (positive control).
      const operator = await get(`/v1/communications/messages?${teamQ()}&relatedIntakeLinkId=${openLinkId}`, off);
      expect(operator.body).toContain(`${preview}-open-link`);
    });

    it("dispatch and retry stay with the workspace administrators", async () => {
      const msg = await prisma.communicationMessage.findFirstOrThrow({
        where: { teamId: A().teamId, relatedIntakeLinkId: openLinkId },
        select: { id: true },
      });
      for (const who of [offViewer, off]) {
        const r = await post(`/v1/communications/messages/${msg.id}/retry`, who, { teamId: A().teamId });
        expect(r.statusCode, r.body).toBe(403);
      }
    });
  });

  // ===========================================================================
  // B2A-F-08 — audit transparency
  // ===========================================================================

  describe("B2A-F-08: the transparency timeline answers only an Enterprise organization workspace", () => {
    it("an Enterprise organization member is served, and a restricted record stays out of it", async () => {
      await prisma.providerUsageEvent.createMany({
        data: [
          { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", evidenceId: hiddenId },
          { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", evidenceId: visibleId },
        ] as never,
      });
      const theirs = await get(`/v1/audit-transparency?category=PROVIDER_USAGE&limit=500`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).toContain(visibleId);
      expect(theirs.body).not.toContain(hiddenId);
      const mine = await get(`/v1/audit-transparency?category=PROVIDER_USAGE&limit=500`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(hiddenId);
    });

    it("a Free and an ordinary Team organization workspace are refused; the same workspace on Enterprise is served", async () => {
      const bMember = await person("MEMBER", B().teamId);
      const header = { "x-proovra-workspace-id": B().teamId };
      for (const plan of ["FREE", "TEAM"]) {
        await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } as never });
        const r = await get(`/v1/audit-transparency?limit=5`, bMember, header);
        expect(r.statusCode, `${plan}: ${r.body}`).toBe(403);
        expect(r.body).not.toContain("entries");
      }
      await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
      const enterprise = await get(`/v1/audit-transparency?limit=5`, bMember, header);
      expect(enterprise.statusCode, enterprise.body).toBe(200);
      await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: "FREE" } as never });
    });

    it("a Personal Space is not an organization workspace", async () => {
      const p = h.fixtures.personal;
      const r = await get(`/v1/audit-transparency?limit=5`, { id: p.userId, token: p.token }, { "x-proovra-workspace-id": p.teamId });
      expect(r.statusCode, r.body).toBe(403);
    });
  });

  // ===========================================================================
  // B7A-F-005 — staff rosters
  // ===========================================================================

  describe("B7A-F-005: staff record rosters and search carry no title or owner email without a support grant", () => {
    let staff: Person;
    let title: string;
    let recordId: string;
    let foreignTitle: string;
    let foreignId: string;
    let ownerEmail: string;

    beforeAll(async () => {
      const u = await fx.seedUser(deps, "a2-staff");
      await prisma.user.update({ where: { id: u.userId }, data: { platformRole: "admin" } });
      const token = await h.mintSessionToken(u.userId, u.email, { mfaVerified: true });
      await fx.registerSessionForToken(deps, u.userId, token);
      staff = { id: u.userId, token };
      title = `a2-customer-title-${tag()}`;
      foreignTitle = `a2-foreign-title-${tag()}`;
      recordId = await record(title, { verificationStatus: "FAILED" });
      foreignId = await record(foreignTitle, { verificationStatus: "FAILED" }, B().teamId, B().ownerUserId);
      ownerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: A().ownerUserId }, select: { email: true } })).email!;
    });

    const roster = (q: string) => get(`/v1/admin/evidence-health/records?${q}`, staff);

    it("without a grant: ids, status and counts only — on the roster, the record lookup and search", async () => {
      const list = await roster(`signal=VERIFICATION_FAILED&teamId=${A().teamId}&limit=200`);
      expect(list.statusCode, list.body).toBe(200);
      const items = (list.json() as { items: Array<{ id: string; title: unknown; ownerEmail: unknown; recordDetailWithheld?: boolean }>; total: number }).items;
      const row = items.find((i) => i.id === recordId);
      expect(row).toBeDefined();
      expect(row!.title).toBeNull();
      expect(row!.ownerEmail).toBeNull();
      expect(row!.recordDetailWithheld).toBe(true);
      expect(list.body).not.toContain(title);
      expect(list.body).not.toContain(ownerEmail);

      const one = await roster(`evidenceId=${recordId}`);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.body).toContain(recordId);
      expect(one.body).not.toContain(title);
      expect(one.body).not.toContain(ownerEmail);

      const byTitle = await get(`/v1/admin/search?q=${encodeURIComponent(title)}&types=evidence`, staff);
      expect(byTitle.statusCode, byTitle.body).toBe(200);
      // The response echoes the operator's own term as `query`; the RESULTS
      // must neither match nor name the record.
      expect(JSON.stringify((byTitle.json() as { groups: unknown }).groups)).not.toContain(title);
      expect(byTitle.body).not.toContain(recordId);
      const byId = await get(`/v1/admin/search?q=${recordId}&types=evidence`, staff);
      expect(byId.statusCode, byId.body).toBe(200);
      expect(byId.body).toContain(recordId);
      expect(byId.body).not.toContain(title);
    });

    it("an active support grant discloses its own organization's titles and emails, and the read is audited with the grant", async () => {
      const grant = await supportAccess.startSupportAccess(
        {
          supportUserId: staff.id,
          organizationId: (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId!,
          teamId: A().teamId,
          reason: "a2 failed verification triage for the customer",
          approvedByUserId: A().ownerUserId,
        },
        prisma as never,
      );
      try {
        const list = await roster(`signal=VERIFICATION_FAILED&limit=200`);
        expect(list.statusCode, list.body).toBe(200);
        const items = (list.json() as { items: Array<{ id: string; title: unknown; ownerEmail: unknown }> }).items;
        expect(items.find((i) => i.id === recordId)?.title).toBe(title);
        expect(items.find((i) => i.id === recordId)?.ownerEmail).toBe(ownerEmail);
        // The grant covers organization A only.
        expect(items.find((i) => i.id === foreignId)?.title ?? null).toBeNull();
        expect(list.body).not.toContain(foreignTitle);

        const audit = await prisma.adminAuditLog.findFirstOrThrow({
          where: { userId: staff.id, action: "admin.evidence_records_listed" },
          orderBy: { createdAt: "desc" },
        });
        expect(JSON.stringify(audit)).toContain(grant.id);

        const byTitle = await get(`/v1/admin/search?q=${encodeURIComponent(title)}&types=evidence`, staff);
        expect(byTitle.body).toContain(recordId);
        expect(byTitle.body).toContain(title);
        const foreign = await get(`/v1/admin/search?q=${encodeURIComponent(foreignTitle)}&types=evidence`, staff);
        expect(JSON.stringify((foreign.json() as { groups: unknown }).groups)).not.toContain(foreignTitle);
        expect(foreign.body).not.toContain(foreignId);
      } finally {
        await supportAccess.revokeSupportAccess({ grantId: grant.id, revokedByUserId: staff.id }, prisma as never);
      }
      const after = await roster(`evidenceId=${recordId}`);
      expect(after.body).not.toContain(title);
    });

    it("a workspace member who is not platform staff is refused the roster", async () => {
      const r = await get(`/v1/admin/evidence-health/records?signal=VERIFICATION_FAILED`, offAdmin);
      expect([401, 403, 404]).toContain(r.statusCode);
      expect(r.body).not.toContain(title);
    });
  });

  // ===========================================================================
  // B7B-F03 — remaining aggregates
  // ===========================================================================

  describe("B7B-F03: executive AI/review counts and governance-analytics lifecycle, export, notification and immutable-check counts follow reach", () => {
    beforeAll(async () => {
      const now = new Date();
      for (const evidenceId of [hiddenId, visibleId]) {
        const workflow = await prisma.evidenceReviewWorkflow.create({
          data: { evidenceId, teamId: A().teamId, workspaceType: "TEAM", status: "APPROVED_INTERNAL", completedAtUtc: now } as never,
          select: { id: true },
        });
        await prisma.reviewEscalation.create({
          data: {
            teamId: A().teamId,
            workflowId: workflow.id,
            evidenceId,
            reason: "SLA_BREACH",
            safeSummary: "a2",
            fingerprint: `a2-${randomUUID()}`,
          } as never,
        });
        await prisma.securityEvent.create({
          data: {
            teamId: A().teamId,
            eventType: "lifecycle_transition_blocked",
            severity: "WARNING",
            details: { fromState: "PURGED", toState: "ACTIVE", reason: "terminal_state", evidenceId },
          } as never,
        });
        const rec = await prisma.mediaIntelligenceRecord.create({
          data: { teamId: A().teamId, evidenceId, modality: "TEXT", kind: "ENTITY", provider: "LOCAL", providerRecordKey: `k-${tag()}` } as never,
          select: { id: true },
        });
        await prisma.reviewerCorrection.create({
          data: { teamId: A().teamId, recordId: rec.id, kind: "ENTITY_EDIT", authoredByUserId: listed.id } as never,
        });
        await prisma.providerUsageEvent.create({
          data: { teamId: A().teamId, provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", unit: "call", evidenceId } as never,
        });
        await prisma.immutableStorageCheck.create({
          data: { teamId: A().teamId, evidenceId, outcome: "MISSING_LOCK" } as never,
        });
        await prisma.evidenceLifecycleEvent.create({
          data: { teamId: A().teamId, evidenceId, toState: "ACTIVE", eventType: "lifecycle_transition", summary: "a2" } as never,
        });
        await prisma.governanceExportSnapshot.create({
          data: {
            teamId: A().teamId,
            evidenceId,
            snapshotKind: "EVIDENCE_PACKAGE",
            lifecycleState: "ACTIVE",
            exportEligibilityOutcome: "BLOCKED_BY_HOLD",
            exportEligibilityReason: "a2",
            snapshotHash: `a2-${randomUUID()}`,
            snapshotPayload: {},
          } as never,
        });
        await prisma.governanceNotification.create({
          data: {
            teamId: A().teamId,
            kind: "REVIEW_OVERDUE",
            dedupeKey: `a2-${randomUUID()}`,
            title: "a2",
            summary: "a2",
            relatedEvidenceId: evidenceId,
          } as never,
        });
      }
    });

    type Exec = { metrics: { review: { reviewedLast7d: number }; ai: { providerCallsLast7d: number; correctionsLast7d: number } } };

    it("executive metrics: completed workflows, provider calls and corrections of a closed record are not counted", async () => {
      const read = async (who: Person) => {
        const r = await get(`/v1/executive/metrics`, who);
        expect(r.statusCode, r.body).toBe(200);
        return (r.json() as Exec).metrics;
      };
      const theirs = await read(off);
      const mine = await read(listed);
      // Every provider call naming the closed record (this block's and the
      // B2A-F-08 block's) is the difference.
      const closedCalls = await prisma.providerUsageEvent.count({ where: { teamId: A().teamId, evidenceId: hiddenId } as never });
      expect(closedCalls).toBeGreaterThan(0);
      expect(theirs.review.reviewedLast7d).toBe(mine.review.reviewedLast7d - 1);
      expect(theirs.ai.providerCallsLast7d).toBe(mine.ai.providerCallsLast7d - closedCalls);
      expect(theirs.ai.correctionsLast7d).toBe(mine.ai.correctionsLast7d - 1);

      const trends = async (who: Person) => {
        const r = await get(`/v1/executive/trends?range=7d`, who);
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as { trends: { ai: { providerCalls: { current: number }; corrections: { current: number } } } };
      };
      const tTheirs = await trends(off);
      const tMine = await trends(listed);
      expect(tTheirs.trends.ai.providerCalls.current).toBe(tMine.trends.ai.providerCalls.current - closedCalls);
      expect(tTheirs.trends.ai.corrections.current).toBe(tMine.trends.ai.corrections.current - 1);
    });

    it("governance analytics: lifecycle events, export blocks, overdue notifications and immutable drift of a closed record are not counted", async () => {
      const read = async (who: Person) => {
        const r = await get(`/v1/governance/analytics?${teamQ()}&window=7d`, who);
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as { metrics: Record<string, number>; immutableDriftByOutcome: Record<string, number> };
      };
      const theirs = await read(off);
      const mine = await read(listed);
      for (const m of ["lifecycle_transitions", "lifecycle_blocked_transitions", "immutable_drift_count", "export_blocks", "review_overdue"]) {
        expect(theirs.metrics[m], m).toBe((mine.metrics[m] ?? 0) - 1);
      }
      expect(theirs.immutableDriftByOutcome.MISSING_LOCK).toBe((mine.immutableDriftByOutcome.MISSING_LOCK ?? 0) - 1);
    });

    it("operational analytics: an escalation of a closed record is not counted", async () => {
      const read = async (who: Person) => {
        const r = await get(`/v1/analytics/reviewer?${teamQ()}`, who);
        expect(r.statusCode, r.body).toBe(200);
        return (r.json() as { metrics: { openEscalations: number } }).metrics.openEscalations;
      };
      expect(await read(off)).toBe((await read(listed)) - 1);
    });

    it("the related drill-down (export snapshots) agrees with the count", async () => {
      const theirs = await get(`/v1/governance/export-snapshots?${teamQ()}&limit=500`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(hiddenId);
      expect(theirs.body).toContain(visibleId);
    });
  });
});
