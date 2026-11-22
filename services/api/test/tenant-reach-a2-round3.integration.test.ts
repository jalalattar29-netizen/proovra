/**
 * FREE-USER AUDIT ROUND 3 — A2-12 … A2-17 (live PostgreSQL, real routes).
 *
 *   A2-12  Governance export snapshots, immutable-storage checks and governance
 *          notifications read by workspace only: ids, hashes and hold state of
 *          records on a restricted case reached anyone holding
 *          `governance.policy.read` (VIEWER included), and capture was a 201/404
 *          existence oracle for a closed record.
 *   A2-13  PATCH /v1/evidence/:id/reviewer-workflow handed a review to ANOTHER
 *          member on BASIC_RECORD_REVIEW alone; the reviewer-ops assignment
 *          routes require REVIEW_ASSIGNMENTS.
 *   A2-14  A case creator demoted to VIEWER kept every case mutation through the
 *          synthetic case OWNER role (product decision: a Viewer is read-only).
 *   A2-15  External-review renew / break-glass reveal / resend did not re-check
 *          the plan or the operator's reach to the grant's subject; renew had
 *          no step-up.
 *   A2-16  POST /v1/workflow/intake-links/:id/send mailed a caller-supplied URL
 *          and token to the stored recipient.
 *   A2-17  The API-key evidence-request create skipped record reach.
 *
 * Each refusal asserts the status AND the body AND that no durable row (or
 * message) was produced; each has a positive control on the same route. Every
 * workspace here is created by this file, so plan changes touch nobody else.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tenant = { teamId: string; orgId: string; owner: Person };

const CANONICAL_ORIGIN = "https://intake-origin.canonical.test";

describe("free-user audit round 3: A2-12 … A2-17 (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let recorder: typeof import("@proovra/shared-runtime");
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");

  // The restricted-case world (A2-12 / A2-15 / A2-17), on a TEAM workspace.
  let T: Tenant;
  let listed: Person; // MEMBER on the restricted case's access list
  let offViewer: Person; // VIEWER, off the list
  let offAdmin: Person; // ADMIN, off the list
  let offOwner: Person; // a second workspace OWNER, off the list
  let restrictedCaseId: string;
  let hiddenId: string; // linked to the restricted case only
  let visibleId: string; // on no restricted case

  const tag = () => randomUUID().slice(0, 8);
  const ws = (teamId: string) => ({ "x-proovra-workspace-id": teamId });
  const call = (method: string, url: string, who: Person | null, payload?: unknown, headers?: Record<string, string>) =>
    kit.call(method, url, who, payload, headers);

  async function tenant(plan: "TEAM" | "ENTERPRISE"): Promise<Tenant> {
    const owner = await kit.person(null);
    const org = await prisma.organization.create({
      data: { name: `r3-${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `r3-${tag()}`,
        ownerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: plan,
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, teamId: team.id } as never });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: team.id } as never });
    return { teamId: team.id, orgId: org.id, owner };
  }

  async function record(t: Tenant, title: string): Promise<string> {
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.teamId,
          organizationId: t.orgId,
          ownerUserId: t.owner.id,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = randomBytes(32).toString("hex");
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? randomBytes(32).toString("hex");
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WEB_BASE_URL = CANONICAL_ORIGIN;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    recorder = await import("@proovra/shared-runtime");
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    invitations = await import("../src/services/external-review/portal-invitation.service.js");

    T = await tenant("TEAM");
    [listed, offViewer, offAdmin, offOwner] = await Promise.all([
      kit.person(T.teamId, "MEMBER"),
      kit.person(T.teamId, "VIEWER"),
      kit.person(T.teamId, "ADMIN"),
      kit.person(T.teamId, "OWNER"),
    ]);
    restrictedCaseId = (
      await prisma.case.create({
        data: { name: `R-${tag()}`, teamId: T.teamId, ownerUserId: T.owner.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listed.id } });
    hiddenId = await record(T, `hidden-${tag()}`);
    visibleId = await record(T, `visible-${tag()}`);
    await prisma.caseEvidenceLink.create({ data: { caseId: restrictedCaseId, evidenceId: hiddenId, teamId: T.teamId } as never });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // A2-12 — governance export snapshots, immutable-storage checks, notifications
  // ===========================================================================
  describe("A2-12: governance reads and capture follow record reach", () => {
    const snapshots = "/v1/governance/export-snapshots";

    it("capture: a closed record answers exactly like a missing one and writes nothing; the case owner captures it", async () => {
      const before = await prisma.governanceExportSnapshot.count({ where: { teamId: T.teamId, evidenceId: hiddenId } });
      const closed = await call("POST", snapshots, offAdmin, { teamId: T.teamId, evidenceId: hiddenId, snapshotKind: "EVIDENCE_PACKAGE" });
      const missing = await call("POST", snapshots, offAdmin, { teamId: T.teamId, evidenceId: randomUUID(), snapshotKind: "EVIDENCE_PACKAGE" });
      expect(closed.statusCode, closed.body).toBe(404);
      expect(closed.json()).toEqual(missing.json());
      expect(closed.json()).toEqual({ error: { code: "EXPORT_SNAPSHOT_EVIDENCE_NOT_FOUND" } });
      expect(await prisma.governanceExportSnapshot.count({ where: { teamId: T.teamId, evidenceId: hiddenId } })).toBe(before);

      const allowed = await call("POST", snapshots, T.owner, { teamId: T.teamId, evidenceId: hiddenId, snapshotKind: "EVIDENCE_PACKAGE" });
      expect(allowed.statusCode, allowed.body).toBe(201);
      expect(allowed.json().snapshot.evidenceId).toBe(hiddenId);
    });

    it("list / detail / verify: a snapshot of a closed record is not listed and answers like a missing one; the listed member reads it", async () => {
      const created = await call("POST", snapshots, T.owner, { teamId: T.teamId, evidenceId: hiddenId, snapshotKind: "EVIDENCE_PACKAGE" });
      expect(created.statusCode, created.body).toBe(201);
      const snap = created.json().snapshot as { id: string; snapshotHash: string };

      const list = await call("GET", `${snapshots}?teamId=${T.teamId}&limit=500`, offViewer);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(snap.id);
      expect(list.body).not.toContain(snap.snapshotHash);
      expect(list.body).not.toContain(hiddenId);
      const filtered = await call("GET", `${snapshots}?teamId=${T.teamId}&evidenceId=${hiddenId}`, offViewer);
      expect(filtered.json().snapshots).toEqual([]);

      const missing = await call("GET", `${snapshots}/${randomUUID()}?teamId=${T.teamId}`, offViewer);
      for (const suffix of ["", "/verify"]) {
        const closed = await call("GET", `${snapshots}/${snap.id}${suffix}?teamId=${T.teamId}`, offViewer);
        expect(closed.statusCode).toBe(404);
        expect(closed.json()).toEqual(missing.json());
        expect(closed.body).not.toContain(snap.snapshotHash);
      }

      const listedList = await call("GET", `${snapshots}?teamId=${T.teamId}&limit=500`, listed);
      expect(listedList.body).toContain(snap.id);
      const listedVerify = await call("GET", `${snapshots}/${snap.id}/verify?teamId=${T.teamId}`, listed);
      expect(listedVerify.statusCode).toBe(200);
      expect(listedVerify.json()).toEqual({ snapshotId: snap.id, valid: true, snapshotHash: snap.snapshotHash });
    });

    it("workspace snapshot: holds on a closed record and on a restricted case are withheld (and not captured by an off-list creator); the stored hash still verifies", async () => {
      const directHold = await prisma.evidenceLegalHold.create({
        data: { teamId: T.teamId, evidenceId: hiddenId, scope: "EVIDENCE", title: "sentinel direct", status: "ACTIVE", placedByUserId: T.owner.id } as never,
        select: { id: true },
      });
      const caseHold = await prisma.evidenceLegalHold.create({
        data: { teamId: T.teamId, caseId: restrictedCaseId, scope: "CASE", title: "sentinel case", status: "ACTIVE", placedByUserId: T.owner.id } as never,
        select: { id: true },
      });
      const openHold = await prisma.evidenceLegalHold.create({
        data: { teamId: T.teamId, evidenceId: visibleId, scope: "EVIDENCE", title: "open", status: "ACTIVE", placedByUserId: T.owner.id } as never,
        select: { id: true },
      });

      const byOwner = await call("POST", snapshots, T.owner, { teamId: T.teamId, snapshotKind: "AUDIT_EXPORT" });
      expect(byOwner.statusCode, byOwner.body).toBe(201);
      const ownerSnap = byOwner.json().snapshot as { id: string; activeHoldIds: string[]; snapshotHash: string };
      expect(ownerSnap.activeHoldIds).toEqual(expect.arrayContaining([directHold.id, caseHold.id, openHold.id]));

      const read = await call("GET", `${snapshots}/${ownerSnap.id}?teamId=${T.teamId}`, offViewer);
      expect(read.statusCode).toBe(200);
      const seen = read.json().snapshot;
      expect(seen.activeHoldIds).toContain(openHold.id);
      expect(seen.payloadRedacted).toBe(true);
      expect(read.body).not.toContain(directHold.id);
      expect(read.body).not.toContain(caseHold.id);
      expect(read.body).not.toContain(restrictedCaseId);
      const verify = await call("GET", `${snapshots}/${ownerSnap.id}/verify?teamId=${T.teamId}`, offViewer);
      expect(verify.json()).toEqual({ snapshotId: ownerSnap.id, valid: true, snapshotHash: ownerSnap.snapshotHash });
      // The owner (who reaches everything) sees the stored row unredacted.
      const ownerRead = await call("GET", `${snapshots}/${ownerSnap.id}?teamId=${T.teamId}`, T.owner);
      expect(ownerRead.json().snapshot.payloadRedacted).toBe(false);

      const byOffAdmin = await call("POST", snapshots, offAdmin, { teamId: T.teamId, snapshotKind: "AUDIT_EXPORT" });
      expect(byOffAdmin.statusCode, byOffAdmin.body).toBe(201);
      const stored = await prisma.governanceExportSnapshot.findUniqueOrThrow({ where: { id: byOffAdmin.json().snapshot.id } });
      expect(stored.activeHoldIds).toContain(openHold.id);
      expect(stored.activeHoldIds).not.toContain(directHold.id);
      expect(stored.activeHoldIds).not.toContain(caseHold.id);
      expect(JSON.stringify(stored.snapshotPayload)).not.toContain(restrictedCaseId);
    });

    it("immutable-storage checks: a closed record's checks are not listed, filtered or not; the case owner sees them", async () => {
      const hiddenCheck = await prisma.immutableStorageCheck.create({
        data: { teamId: T.teamId, evidenceId: hiddenId, outcome: "LEGAL_HOLD_MISMATCH", dbLegalHoldActive: true } as never,
        select: { id: true },
      });
      const openCheck = await prisma.immutableStorageCheck.create({
        data: { teamId: T.teamId, evidenceId: visibleId, outcome: "OK" } as never,
        select: { id: true },
      });
      const url = `/v1/governance/immutable-storage-checks?teamId=${T.teamId}&limit=500`;
      const viewerList = await call("GET", url, offViewer);
      expect(viewerList.statusCode).toBe(200);
      expect(viewerList.body).toContain(openCheck.id);
      expect(viewerList.body).not.toContain(hiddenCheck.id);
      expect(viewerList.body).not.toContain(hiddenId);
      const viewerFiltered = await call("GET", `${url}&evidenceId=${hiddenId}`, offViewer);
      expect(viewerFiltered.json()).toEqual({ checks: [] });
      const unknownFiltered = await call("GET", `${url}&evidenceId=${randomUUID()}`, offViewer);
      expect(viewerFiltered.json()).toEqual(unknownFiltered.json());

      const ownerFiltered = await call("GET", `${url}&evidenceId=${hiddenId}`, T.owner);
      expect(ownerFiltered.body).toContain(hiddenCheck.id);
    });

    it("notifications: one naming a closed record is neither listed nor counted, and is acknowledged like a missing one; the owner acknowledges it", async () => {
      const hiddenNote = await prisma.governanceNotification.create({
        data: {
          teamId: T.teamId,
          kind: "DESTRUCTION_PENDING",
          dedupeKey: `r3-hidden-${tag()}`,
          title: "Destruction review pending",
          summary: `Retention has expired on evidence ${hiddenId.slice(0, 8)}`,
          relatedEvidenceId: hiddenId,
        } as never,
        select: { id: true },
      });
      const openNote = await prisma.governanceNotification.create({
        data: {
          teamId: T.teamId,
          kind: "DESTRUCTION_PENDING",
          dedupeKey: `r3-open-${tag()}`,
          title: "Destruction review pending",
          summary: "open record",
          relatedEvidenceId: visibleId,
        } as never,
        select: { id: true },
      });
      const url = `/v1/governance/notifications?teamId=${T.teamId}&limit=500`;
      const viewerList = await call("GET", url, offViewer);
      expect(viewerList.statusCode).toBe(200);
      expect(viewerList.body).toContain(openNote.id);
      expect(viewerList.body).not.toContain(hiddenNote.id);
      expect(viewerList.body).not.toContain(hiddenId);
      const ownerList = await call("GET", url, T.owner);
      expect(ownerList.body).toContain(hiddenNote.id);
      // Both rows are PENDING: the closed one is not counted for the viewer.
      expect(ownerList.json().counts.pending - viewerList.json().counts.pending).toBe(1);

      const ack = (id: string, who: Person) =>
        call("POST", `/v1/governance/notifications/${id}/acknowledge`, who, { teamId: T.teamId });
      const closed = await ack(hiddenNote.id, offAdmin);
      const missing = await ack(randomUUID(), offAdmin);
      expect(closed.statusCode).toBe(404);
      expect(closed.json()).toEqual(missing.json());
      expect((await prisma.governanceNotification.findUniqueOrThrow({ where: { id: hiddenNote.id } })).acknowledgedAtUtc).toBeNull();
      const ok = await ack(hiddenNote.id, T.owner);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await prisma.governanceNotification.findUniqueOrThrow({ where: { id: hiddenNote.id } })).acknowledgedByUserId).toBe(T.owner.id);
    });
  });

  // ===========================================================================
  // A2-13 — assigning ANOTHER member is REVIEW_ASSIGNMENTS
  // ===========================================================================
  describe("A2-13: reviewer-workflow assignment of another member needs REVIEW_ASSIGNMENTS", () => {
    const patch = (evidenceId: string, who: Person, payload: unknown) =>
      call("PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, who, payload);

    // A shared (ORGANIZATION) workspace resolves only TEAM or ENTERPRISE (a
    // PRO string there is FREE, `resolveWorkspaceEffectivePlan`); the shared
    // workspace holding BASIC_RECORD_REVIEW without REVIEW_ASSIGNMENTS is an
    // ENTERPRISE one whose ACTIVE contract excludes reviewer operations.
    it("basic review only (ENTERPRISE, contract excludes reviewer operations): assigning another member is refused (reviewer-ops body) and nothing is written; self-review still works", async () => {
      const P = await tenant("ENTERPRISE");
      const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
      await upsertEnterpriseContract(prisma as never, {
        organizationId: P.orgId,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: 25,
        reviewerOperationsEnabled: false,
      });
      const member = await kit.person(P.teamId, "MEMBER");
      await placeInCollaborationTeam(prisma, { workspaceId: P.teamId, createdByUserId: P.owner.id, userIds: [member.id] });
      const evidenceId = await record(P, `basic-${tag()}`);

      const refused = await patch(evidenceId, P.owner, { assignedToUserId: member.id });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error, refused.body).toMatchObject({
        code: "ENTITLEMENT_REQUIRED",
        reason: "reviewer_operations_not_included",
        entitlement: "REVIEW_ASSIGNMENTS",
      });
      expect(await prisma.evidenceReviewWorkflow.count({ where: { evidenceId } })).toBe(0);

      const self = await patch(evidenceId, P.owner, { assignedToUserId: P.owner.id });
      expect(self.statusCode, self.body).toBe(200);
      const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
      expect(row.assignedToUserId).toBe(P.owner.id);
      // Re-stating the current assignee hands nobody anything (basic tier).
      expect((await patch(evidenceId, P.owner, { assignedToUserId: P.owner.id, priority: "HIGH" })).statusCode).toBe(200);
    });

    it("TEAM: the same assignment is allowed and recorded", async () => {
      const member = await kit.person(T.teamId, "MEMBER");
      // On PRO / TEAM a non-owner member is given reviews once placed.
      await placeInCollaborationTeam(prisma, { workspaceId: T.teamId, createdByUserId: T.owner.id, userIds: [member.id] });
      const evidenceId = await record(T, `team-${tag()}`);
      const allowed = await patch(evidenceId, T.owner, { assignedToUserId: member.id });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } })).assignedToUserId).toBe(member.id);
    });
  });

  // ===========================================================================
  // A2-14 — a Viewer is read-only, whoever created the case
  // ===========================================================================
  describe("A2-14: a case creator demoted to VIEWER keeps reading and mutates nothing", () => {
    let creator: Person;
    let other: Person;
    let caseId: string;

    beforeAll(async () => {
      creator = await kit.person(T.teamId, "MEMBER");
      other = await kit.person(T.teamId, "MEMBER");
      // The case is created by the member through the real route.
      const created = await call("POST", "/v1/cases", creator, { name: `creator-${tag()}`, teamId: T.teamId });
      expect(created.statusCode, created.body).toBe(201);
      caseId = (created.json().case ?? created.json()).id as string;
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).ownerUserId).toBe(creator.id);
    });

    it("as a MEMBER, the creator holds the synthetic case OWNER (manages access, changes status)", async () => {
      const projection = await call("GET", `/v1/cases/${caseId}/matter-workspace`, creator);
      expect(projection.statusCode).toBe(200);
      expect(projection.json().viewer).toMatchObject({ canChangeStatus: true, canManageAccess: true });
      const status = await call("POST", `/v1/cases/${caseId}/status`, creator, { toStatus: "INVESTIGATING" });
      expect(status.statusCode, status.body).toBe(200);
    });

    it("demoted to VIEWER: direct API mutations are refused with nothing written; the projection hides them; reads still work", async () => {
      await prisma.teamMember.updateMany({ where: { teamId: T.teamId, userId: creator.id }, data: { role: "VIEWER" } as never });
      try {
        const before = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { status: true, name: true } });
        const commentsBefore = await prisma.caseComment.count({ where: { caseId } });

        const status = await call("POST", `/v1/cases/${caseId}/status`, creator, { toStatus: "ON_HOLD" });
        expect(status.statusCode, status.body).toBe(403);
        expect(status.json()).toEqual({ error: { code: "forbidden", reason: "VIEWER role cannot perform case mutations." } });
        const comment = await call("POST", `/v1/cases/${caseId}/comments`, creator, { body: "viewer comment" });
        expect(comment.statusCode).toBe(403);
        const link = await call("POST", `/v1/cases/${caseId}/evidence-links`, creator, { evidenceId: visibleId });
        expect(link.statusCode).toBe(403);
        const grant = await call("POST", `/v1/cases/${caseId}/access`, creator, { userId: other.id });
        expect(grant.statusCode, grant.body).toBe(403);
        expect(grant.json()).toEqual({ message: "Forbidden" });
        const rename = await call("PATCH", `/v1/cases/${caseId}`, creator, { name: "renamed by viewer" });
        expect(rename.statusCode).toBe(403);

        expect(await prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { status: true, name: true } })).toEqual(before);
        expect(await prisma.caseComment.count({ where: { caseId } })).toBe(commentsBefore);
        expect(await prisma.caseEvidenceLink.count({ where: { caseId, evidenceId: visibleId } })).toBe(0);
        expect(await prisma.caseAccess.count({ where: { caseId, userId: other.id } })).toBe(0);

        // UI visibility comes from the server's projection (web MatterWorkspace /
        // SimpleCaseDetail and mobile case-workspace.ts read `viewer`).
        const projection = await call("GET", `/v1/cases/${caseId}/matter-workspace`, creator);
        expect(projection.statusCode).toBe(200);
        expect(projection.json().viewer).toMatchObject({
          canMutate: false,
          canChangeStatus: false,
          canLinkEvidence: false,
          canComment: false,
          canManageAccess: false,
          canAssign: false,
        });
        expect((await call("GET", `/v1/cases/${caseId}`, creator)).statusCode).toBe(200);
      } finally {
        await prisma.teamMember.updateMany({ where: { teamId: T.teamId, userId: creator.id }, data: { role: "MEMBER" } as never });
      }
    });

    it("authorized roles still mutate; an unreachable case stays a 404, not a 403", async () => {
      const byAdmin = await call("POST", `/v1/cases/${caseId}/comments`, offAdmin, { body: "admin note" });
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      const unreachable = await call("POST", `/v1/cases/${restrictedCaseId}/status`, offViewer, { toStatus: "ON_HOLD" });
      expect(unreachable.statusCode).toBe(404);
      const unreachableAdmin = await call("POST", `/v1/cases/${restrictedCaseId}/status`, offAdmin, { toStatus: "ON_HOLD" });
      expect(unreachableAdmin.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // A2-15 — renew / reveal / resend re-check plan and reach
  // ===========================================================================
  describe("A2-15: external-review re-disclosure re-checks the plan, the operator's reach and step-up", () => {
    async function invitation(t: Tenant, evidenceId: string, invitedBy: string) {
      const issued = await invitations.issueInvitation({
        teamId: t.teamId,
        invitedByUserId: invitedBy,
        reviewerEmail: `r3-reviewer-${tag()}@outside.test`,
        role: "EXTERNAL_REVIEWER",
        mfaRequired: false,
        scope: { kind: "EVIDENCE", evidenceId },
        expiresAtUtc: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      });
      if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
      return issued;
    }
    const grantRow = (id: string) =>
      prisma.externalReviewGrant.findUniqueOrThrow({ where: { id }, select: { expiresAtUtc: true, tokenHash: true, tokenVersion: true } });
    const deliveries = (grantId: string) => prisma.externalReviewInvitationDelivery.count({ where: { grantId } });
    const renew = async (t: Tenant, grantId: string, who: Person, withStepUp: boolean) =>
      call(
        "POST",
        `/v1/external-review/grants/${grantId}/renew`,
        who,
        { teamId: t.teamId, days: 20 },
        withStepUp
          ? await stepUp.approvedHeader({
              token: who.token,
              userId: who.id,
              teamId: t.teamId,
              purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
              resourceKind: "external_review_grant",
              resourceId: grantId,
            })
          : {},
      );

    it("revoked reach: once the subject is restricted away from the operator, renew / reveal / resend answer like a missing grant and change nothing", async () => {
      const subject = await record(T, `subject-${tag()}`);
      const issued = await invitation(T, subject, offAdmin.id);
      // The subject joins the restricted case: offAdmin and offOwner lose reach.
      await prisma.caseEvidenceLink.create({ data: { caseId: restrictedCaseId, evidenceId: subject, teamId: T.teamId } as never });
      const before = await grantRow(issued.grantId);
      const deliveriesBefore = await deliveries(issued.grantId);

      const renewed = await renew(T, issued.grantId, offAdmin, false);
      expect(renewed.statusCode, renewed.body).toBe(404);
      expect(renewed.json()).toEqual({ error: { code: "EXTERNAL_REVIEW_GRANT_NOT_FOUND" } });
      const renewMissing = await renew(T, randomUUID(), offAdmin, false);
      expect(renewMissing.json()).toEqual(renewed.json());

      const reveal = await call("POST", `/v1/external-review/invitations/${issued.grantId}/reveal-token`, offOwner, { reason: "reviewer lost the email" }, ws(T.teamId));
      expect(reveal.statusCode, reveal.body).toBe(409);
      expect(reveal.json()).toEqual({ denial: "token_unknown" });

      const resend = await call("POST", `/v1/external-review/invitations/${issued.grantId}/resend`, offAdmin, {}, ws(T.teamId));
      expect(resend.statusCode, resend.body).toBe(409);
      expect(resend.json()).toEqual({ denial: "INVITE_NOT_FOUND" });
      const sendEmail = await call("POST", `/v1/external-review/invitations/${issued.grantId}/send-email`, offAdmin, {}, ws(T.teamId));
      // Closure phase 2 (EP-0446) — retired: a typed 410 that touches nothing.
      expect(sendEmail.statusCode, sendEmail.body).toBe(410);
      expect(sendEmail.json().error.code).toBe("EXTERNAL_REVIEW_SEND_EMAIL_RETIRED");

      expect(await grantRow(issued.grantId)).toEqual(before);
      expect(await deliveries(issued.grantId)).toBe(deliveriesBefore);

      // The case owner still reaches the subject: renew (with step-up) works.
      const byOwner = await renew(T, issued.grantId, T.owner, true);
      expect(byOwner.statusCode, byOwner.body).toBe(200);

      // PRO-R1-11 — the invitation's activity trail follows the same reach.
      const offActivity = await call("GET", `/v1/external-review/invitations/${issued.grantId}/activity`, offAdmin, undefined, ws(T.teamId));
      expect(offActivity.statusCode, offActivity.body).toBe(404);
      expect(offActivity.json()).toEqual({ denial: "GRANT_NOT_FOUND" });
      const missingActivity = await call("GET", `/v1/external-review/invitations/${randomUUID()}/activity`, offAdmin, undefined, ws(T.teamId));
      expect(missingActivity.json()).toEqual(offActivity.json());
      const ownerActivity = await call("GET", `/v1/external-review/invitations/${issued.grantId}/activity`, T.owner, undefined, ws(T.teamId));
      expect(ownerActivity.statusCode, ownerActivity.body).toBe(200);
      expect(Array.isArray(ownerActivity.json().activity)).toBe(true);
    });

    it("renew now requires the step-up; with it the expiry moves", async () => {
      const issued = await invitation(T, visibleId, T.owner.id);
      const before = await grantRow(issued.grantId);
      const without = await renew(T, issued.grantId, offAdmin, false);
      expect(without.statusCode, without.body).toBe(401);
      expect((await grantRow(issued.grantId)).expiresAtUtc).toEqual(before.expiresAtUtc);
      const withStepUp = await renew(T, issued.grantId, offAdmin, true);
      expect(withStepUp.statusCode, withStepUp.body).toBe(200);
      expect((await grantRow(issued.grantId)).expiresAtUtc.getTime()).toBeGreaterThan(before.expiresAtUtc.getTime());
    });

    it("downgrade: renew / reveal / resend are refused with the entitlement body and change nothing; the reviewer's existing grant keeps working", async () => {
      const D = await tenant("TEAM");
      const admin = await kit.person(D.teamId, "ADMIN");
      const subject = await record(D, `downgrade-${tag()}`);
      const issued = await invitation(D, subject, D.owner.id);
      await prisma.team.update({ where: { id: D.teamId }, data: { billingPlan: "FREE" } as never });
      const before = await grantRow(issued.grantId);

      const renewed = await renew(D, issued.grantId, D.owner, false);
      expect(renewed.statusCode, renewed.body).toBe(403);
      expect(renewed.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", entitlement: "EXTERNAL_REVIEW", error: { code: "ENTITLEMENT_REQUIRED" } });
      const reveal = await call("POST", `/v1/external-review/invitations/${issued.grantId}/reveal-token`, D.owner, { reason: "reviewer lost the email" }, ws(D.teamId));
      expect(reveal.statusCode, reveal.body).toBe(403);
      expect(reveal.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "EXTERNAL_REVIEW" });
      const resend = await call("POST", `/v1/external-review/invitations/${issued.grantId}/resend`, admin, {}, ws(D.teamId));
      expect(resend.statusCode, resend.body).toBe(403);
      expect(resend.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "EXTERNAL_REVIEW" });

      expect(await grantRow(issued.grantId)).toEqual(before);
      expect(await deliveries(issued.grantId)).toBe(0);
      // Historical disclosure preserved: the token issued before the downgrade
      // still resolves under the grant's own state and expiry.
      const lookup = await grants.lookupExternalReviewGrantByToken(issued.rawToken, prisma as never, { acceptInvited: true, deferAcceptance: true });
      expect(lookup.ok).toBe(true);
      // Revoke stays ungated.
      const revoke = await call("POST", `/v1/external-review/grants/${issued.grantId}/revoke`, D.owner, { teamId: D.teamId });
      expect(revoke.statusCode, revoke.body).toBe(200);
    });
  });

  // ===========================================================================
  // A2-16 — the intake send builds its own URL and binds the token
  // ===========================================================================
  describe("A2-16: intake-link send carries the canonical link and refuses a foreign token", () => {
    async function link(recipientEmail: string) {
      const res = await call("POST", "/v1/workflow/intake-links", T.owner, {
        teamId: T.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_ONE_TIME",
        recipientEmail,
        deliveryMethod: "MANUAL",
        expiresAtUtc: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
      expect(res.statusCode, res.body).toBe(201);
      return { id: res.json().link.id as string, token: res.json().rawToken as string };
    }
    const messages = (intakeLinkId: string) => prisma.communicationMessage.count({ where: { relatedIntakeLinkId: intakeLinkId } });
    const mailbox = (email: string) => recorder.recordedEmails().filter((m) => m.recipientAlias === recorder.recipientAliasFor(email));

    it("a token that is not this link's (or is malformed) is refused before dispatch: no message row, no email", async () => {
      const email = `r3-contributor-${tag()}@test.proovra.local`;
      const target = await link(email);
      const other = await link(`r3-other-${tag()}@test.proovra.local`);
      for (const rawToken of [other.token, `${target.token.slice(0, -4)}AAAA`, "not-a-real-token-value"]) {
        const res = await call("POST", `/v1/workflow/intake-links/${target.id}/send`, T.owner, {
          channel: "EMAIL",
          rawToken,
          intakeUrl: `https://attacker.example/intake/${rawToken}`,
          idempotencyKey: `r3-${tag()}`,
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json()).toEqual({ error: { code: "token_mismatch" } });
      }
      expect(await messages(target.id)).toBe(0);
      expect(mailbox(email)).toHaveLength(0);
    });

    it("the link's own token is sent, and the message carries the configured-origin URL, never the caller's", async () => {
      const email = `r3-contributor-${tag()}@test.proovra.local`;
      const target = await link(email);
      const res = await call("POST", `/v1/workflow/intake-links/${target.id}/send`, T.owner, {
        channel: "EMAIL",
        rawToken: target.token,
        intakeUrl: "https://attacker.example/phish",
        idempotencyKey: `r3-${tag()}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await messages(target.id)).toBe(1);
      const sent = mailbox(email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.actionableLink).toBe(`${CANONICAL_ORIGIN}/intake/${encodeURIComponent(target.token)}`);
      const row = await prisma.communicationMessage.findFirstOrThrow({ where: { relatedIntakeLinkId: target.id } });
      expect(row.bodyPreview ?? "").not.toContain("attacker.example");
      expect(row.bodyPreview ?? "").toContain(CANONICAL_ORIGIN);
    });
  });

  // ===========================================================================
  // A2-17 — the API-key evidence-request create follows record reach
  // ===========================================================================
  describe("A2-17: an API key cannot create an evidence request on a restricted record or case", () => {
    let key = "";
    const requestBody = (extra: Record<string, unknown>) => ({
      requestType: "ADDITIONAL_EVIDENCE",
      title: `r3-api-${tag()}`,
      instructions: "Please photograph the damaged panel in daylight.",
      priority: "NORMAL",
      dueAtUtc: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      recipientLabel: "Claimant",
      recipientEmail: "claimant@test.proovra.local",
      createIntakeLink: false,
      deliverables: [
        { title: "Primary", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 },
      ],
      ...extra,
    });
    const post = (payload: unknown, withKey = key) =>
      h.app.inject({
        method: "POST",
        url: "/v1/integrations/api/evidence-requests",
        headers: { authorization: `Bearer ${withKey}`, "content-type": "application/json" },
        payload: payload as never,
      });

    beforeAll(async () => {
      const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
      await upsertEntitlementGrant({ teamId: T.teamId, key: "INTEGRATION_API_KEYS_MAX", value: 3, kind: "LIMIT", source: "CUSTOM", grantedByUserId: T.owner.id });
      const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
      key = (await createApiCredential({ teamId: T.teamId, name: "r3 a2-17", scopes: ["integration.evidence_request.create"], actorUserId: T.owner.id })).rawKey;
    });

    it("a restricted record / case answers exactly like a foreign one and writes nothing; an open record is created", async () => {
      const before = await prisma.evidenceRequest.count({ where: { teamId: T.teamId } });
      const closedRecord = await post(requestBody({ evidenceId: hiddenId }));
      const foreignRecord = await post(requestBody({ evidenceId: randomUUID() }));
      expect(closedRecord.statusCode, closedRecord.body).toBe(404);
      expect(closedRecord.json()).toEqual(foreignRecord.json());
      const closedCase = await post(requestBody({ caseId: restrictedCaseId }));
      const foreignCase = await post(requestBody({ caseId: randomUUID() }));
      expect(closedCase.statusCode, closedCase.body).toBe(404);
      expect(closedCase.json()).toEqual(foreignCase.json());
      expect(await prisma.evidenceRequest.count({ where: { teamId: T.teamId } })).toBe(before);

      const open = await post(requestBody({ evidenceId: visibleId }));
      expect(open.statusCode, open.body).toBe(201);
      expect(open.json().evidenceRequest.evidenceId).toBe(visibleId);
    });
  });

  // ===========================================================================
  // Round-3 follow-up — every per-link intake route follows case reach (A2-08)
  // ===========================================================================
  describe("A2-08 follow-up: per-link intake reveal / revoke / archive / unarchive follow case reach", () => {
    it("a link on a restricted case answers exactly like a missing link to an off-list ADMIN and nothing changes; the case owner reveals, archives, unarchives and revokes", async () => {
      const email = `r3-restricted-${tag()}@test.proovra.local`;
      const created = await call("POST", "/v1/workflow/intake-links", T.owner, {
        teamId: T.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_ONE_TIME",
        caseId: restrictedCaseId,
        recipientEmail: email,
        deliveryMethod: "MANUAL",
        expiresAtUtc: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
      expect(created.statusCode, created.body).toBe(201);
      const linkId = created.json().link.id as string;
      const snapshot = () =>
        prisma.workflowIntakeLink.findUniqueOrThrow({
          where: { id: linkId },
          select: { status: true, revokedAtUtc: true, archivedAtUtc: true },
        });
      const before = await snapshot();
      const missingId = randomUUID();

      for (const [suffix, payload] of [
        ["recipient-contact", {}],
        ["revoke", { reason: "off-list attempt" }],
        ["archive", {}],
        ["unarchive", {}],
      ] as const) {
        const closed = await call("POST", `/v1/workflow/intake-links/${linkId}/${suffix}`, offAdmin, payload);
        const missing = await call("POST", `/v1/workflow/intake-links/${missingId}/${suffix}`, offAdmin, payload);
        expect(closed.statusCode, `${suffix}: ${closed.body}`).toBe(404);
        expect(closed.json()).toEqual(missing.json());
        expect(closed.body).not.toContain(email);
      }
      expect(await snapshot()).toEqual(before);

      // The case owner reaches the link: every action still works, revoke last.
      // OBS-INTAKE-REVEAL-STEPUP — the reveal is stepped up, bound to this link.
      const reveal = await call(
        "POST",
        `/v1/workflow/intake-links/${linkId}/recipient-contact`,
        T.owner,
        {},
        await stepUp.approvedHeader({
          token: T.owner.token,
          userId: T.owner.id,
          teamId: T.teamId,
          purpose: "INTAKE_LINK_CONTACT_REVEAL",
          resourceKind: "workflow_intake_link",
          resourceId: linkId,
        }),
      );
      expect(reveal.statusCode, reveal.body).toBe(200);
      expect(reveal.json().recipientContact.recipientEmail).toBe(email);
      expect((await call("POST", `/v1/workflow/intake-links/${linkId}/archive`, T.owner, {})).statusCode).toBe(200);
      expect((await snapshot()).archivedAtUtc).not.toBeNull();
      // Off-list unarchive of an archived link: still a missing link, still archived.
      expect((await call("POST", `/v1/workflow/intake-links/${linkId}/unarchive`, offAdmin, {})).statusCode).toBe(404);
      expect((await snapshot()).archivedAtUtc).not.toBeNull();
      expect((await call("POST", `/v1/workflow/intake-links/${linkId}/unarchive`, T.owner, {})).statusCode).toBe(200);
      const revoked = await call("POST", `/v1/workflow/intake-links/${linkId}/revoke`, T.owner, { reason: "owner closes it" });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await snapshot()).revokedAtUtc).not.toBeNull();
    });

    it("a link with no case stays revocable by any authorized operator (no lock-out)", async () => {
      const created = await call("POST", "/v1/workflow/intake-links", T.owner, {
        teamId: T.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_ONE_TIME",
        deliveryMethod: "MANUAL",
        expiresAtUtc: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
      expect(created.statusCode, created.body).toBe(201);
      const linkId = created.json().link.id as string;
      const revoked = await call("POST", `/v1/workflow/intake-links/${linkId}/revoke`, offAdmin, { reason: "admin closes it" });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: linkId } })).revokedAtUtc).not.toBeNull();
    });
  });

  // ===========================================================================
  // Round-3 follow-up — a case-access grant names a CURRENT member (A2-05)
  // ===========================================================================
  describe("A2-05 follow-up: case-access grant targets are judged by the canonical membership engine", () => {
    it("an expired member cannot be granted case access (access / share-team / share-email), nothing written; a current member can", async () => {
      const caseId = (
        await prisma.case.create({
          data: { name: `grant-${tag()}`, teamId: T.teamId, ownerUserId: T.owner.id } as never,
          select: { id: true },
        })
      ).id;
      const expired = await kit.person(T.teamId, "MEMBER");
      // The row still says ACTIVE: nothing flips it when access expires.
      await prisma.teamMember.updateMany({
        where: { teamId: T.teamId, userId: expired.id },
        data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } as never,
      });
      const current = await kit.person(T.teamId, "MEMBER");

      const notMember = { message: "User is not in this team", code: "CASE_ACCESS_TARGET_NOT_MEMBER" };
      const viaAccess = await call("POST", `/v1/cases/${caseId}/access`, T.owner, { userId: expired.id });
      expect(viaAccess.statusCode, viaAccess.body).toBe(400);
      expect(viaAccess.json()).toEqual(notMember);
      const viaTeam = await call("POST", `/v1/cases/${caseId}/share-team`, T.owner, { userId: expired.id });
      expect(viaTeam.statusCode, viaTeam.body).toBe(400);
      expect(viaTeam.json()).toEqual(notMember);
      const viaEmail = await call("POST", `/v1/cases/${caseId}/share-email`, T.owner, { email: expired.email });
      expect(viaEmail.statusCode, viaEmail.body).toBe(202);
      expect(await prisma.caseAccess.count({ where: { caseId, userId: expired.id } })).toBe(0);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).restrictedAtUtc).toBeNull();

      const granted = await call("POST", `/v1/cases/${caseId}/access`, T.owner, { userId: current.id });
      expect(granted.statusCode, granted.body).toBe(201);
      expect(await prisma.caseAccess.count({ where: { caseId, userId: current.id } })).toBe(1);
    });
  });
});
