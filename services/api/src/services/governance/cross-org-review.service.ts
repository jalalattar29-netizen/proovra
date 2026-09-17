/**
 * PROOVRA Phase 4A — Cross-org review grants.
 *
 * Org-A invites Org-B → controlled review. Integrates with the
 * existing External Reviewer Portal (Phase 2B) so the actual review
 * surface + watermarking + decision recording is reused — this
 * service governs the org-to-org binding layer.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  CROSS_ORG_REVIEW_STATES,
  type CrossOrgReviewGrantProjection,
  type CrossOrgReviewState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { externalReviewTargetBelongsToTeam } from "../external-review/external-review-grant.service.js";
import {
  issueInvitation,
  revokeInvitation,
} from "../external-review/portal-invitation.service.js";
import {
  emitCrossOrgEvent,
  emitTrustEvent,
} from "../trust/trust-and-governance-audit.service.js";

/**
 * D17 — what the invited organization reviews. The portal invitation issued on
 * acceptance is scoped to exactly this record of the inviting workspace.
 */
export type CrossOrgReviewSubject = {
  kind: "EVIDENCE" | "CASE" | "PACKAGE";
  id: string;
};

const SUBJECT_KINDS: ReadonlyArray<CrossOrgReviewSubject["kind"]> = ["EVIDENCE", "CASE", "PACKAGE"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the structured subject stored in the grant's `scope` JSON, if any. */
export function readCrossOrgReviewSubject(scope: unknown): CrossOrgReviewSubject | null {
  if (!scope || typeof scope !== "object") return null;
  const subject = (scope as { subject?: unknown }).subject;
  if (!subject || typeof subject !== "object") return null;
  const { kind, id } = subject as { kind?: unknown; id?: unknown };
  if (typeof kind !== "string" || !(SUBJECT_KINDS as ReadonlyArray<string>).includes(kind)) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { kind: kind as CrossOrgReviewSubject["kind"], id };
}

/** Portal invitations live at most this long (the grant service's bound is 30 days). */
const PORTAL_INVITATION_MAX_MS = 30 * 24 * 60 * 60 * 1000 - 60 * 1000;

export type InviteCrossOrgReviewInput = {
  prisma?: PrismaClient;
  teamId: string;
  invitingOrganizationId: string;
  invitedOrgSlug: string;
  scope: string;
  /** D17 — the record under review; required for acceptance to issue a portal invitation. */
  subject?: CrossOrgReviewSubject | null;
  expiresAtUtc?: Date | null;
  createdByUserId: string;
};

export type InviteCrossOrgReviewResult =
  | { ok: true; grantId: string }
  | { ok: false; denial: "POLICY_REJECTED" | "SUBJECT_NOT_IN_WORKSPACE" };

export async function inviteCrossOrgReview(
  input: InviteCrossOrgReviewInput,
): Promise<InviteCrossOrgReviewResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(input.invitedOrgSlug)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.subject && readCrossOrgReviewSubject({ subject: input.subject }) === null) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  // D17 — the subject must be a record of the inviting workspace, checked
  // with the rule the portal invitation is later issued under.
  if (input.subject && !(await externalReviewTargetBelongsToTeam(prisma, input.teamId, input.subject))) {
    return { ok: false, denial: "SUBJECT_NOT_IN_WORKSPACE" };
  }
  const row = await prisma.crossOrgReviewGrant.create({
    data: {
      teamId: input.teamId,
      invitingOrganizationId: input.invitingOrganizationId,
      invitedOrgSlug: input.invitedOrgSlug,
      state: "INVITED",
      // R7-governance: scope is a Json column; service input is a bounded string description. Wrap as
      // { text: ... } so the audit/dashboard layer can read the structured form. Pre-Phase 4A scope
      // was inline text — preserved via .text for back-compat consumers.
      // D17 — plus the structured subject, when the caller names one.
      scope: {
        text: input.scope.slice(0, 600),
        ...(input.subject ? { subject: { kind: input.subject.kind, id: input.subject.id } } : {}),
      } as Prisma.InputJsonValue,
      expiresAtUtc: input.expiresAtUtc ?? null,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_CREATED",
    actorUserId: input.createdByUserId,
  }).catch(() => {});
  return { ok: true, grantId: row.id };
}

export type AcceptCrossOrgReviewResult =
  | { ok: true }
  | {
      ok: false;
      denial?:
        | "EXTERNAL_GRANT_NOT_FOUND"
        | "EXTERNAL_GRANT_REVOKED"
        | "SUBJECT_REQUIRED"
        | "PORTAL_INVITATION_REFUSED"
        | "POLICY_REJECTED";
    };

export async function acceptCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  acceptingOrganizationId: string;
  externalReviewGrantId: string | null;
  actorUserId?: string | null;
}): Promise<AcceptCrossOrgReviewResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state !== "INVITED") return { ok: false };

  // Issue a portal invitation for the cross-org reviewer, OR — when the
  // caller supplied an externalReviewGrantId — validate that the grant
  // actually exists under THIS workspace and is not already REVOKED.
  // Without this check the caller could bind any UUID into the cross-org
  // grant, including one belonging to another tenant.
  let portalGrantId: string | null = input.externalReviewGrantId;
  if (portalGrantId) {
    type GrantProbe = { id: string; state: string };
    const probe = await prisma.$queryRawUnsafe<ReadonlyArray<GrantProbe>>(
      `SELECT "id", "state"
         FROM "external_review_grants"
        WHERE "id" = $1::uuid
          AND "team_id" = $2::uuid
        LIMIT 1`,
      portalGrantId,
      input.teamId,
    );
    const grant = probe[0] ?? null;
    if (!grant) {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_invalid_external_grant",
      }).catch(() => {});
      return { ok: false, denial: "EXTERNAL_GRANT_NOT_FOUND" };
    }
    if (grant.state === "REVOKED") {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_invalid_external_grant",
      }).catch(() => {});
      return { ok: false, denial: "EXTERNAL_GRANT_REVOKED" };
    }
  } else {
    // D17 (2026-09-17) — this issued `{ kind: "PACKAGE" }` with no package
    // id, which the grant service always refuses; the refusal was swallowed
    // and the review was marked ACCEPTED with no portal invitation behind it.
    // The invitation is now scoped to the review's own subject, and a review
    // that cannot be given one is not accepted.
    const subject = readCrossOrgReviewSubject(row.scope);
    if (!subject || !input.actorUserId) {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId ?? null,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_subject_required",
      }).catch(() => {});
      return { ok: false, denial: "SUBJECT_REQUIRED" };
    }
    const reviewerEmail = `cross-org-${row.invitedOrgSlug}@cross-org.invalid`;
    const latest = Date.now() + PORTAL_INVITATION_MAX_MS;
    const expiresAtMs = row.expiresAtUtc ? Math.min(row.expiresAtUtc.getTime(), latest) : latest;
    const issued = await issueInvitation({
      prisma,
      teamId: input.teamId,
      invitedByUserId: input.actorUserId,
      reviewerEmail,
      role: "EXTERNAL_REVIEWER",
      scope:
        subject.kind === "EVIDENCE"
          ? { kind: "EVIDENCE", evidenceId: subject.id }
          : subject.kind === "CASE"
            ? { kind: "CASE", caseId: subject.id }
            : { kind: "PACKAGE", packageId: subject.id },
      expiresAtUtc: new Date(expiresAtMs).toISOString(),
    }).catch(() => null);
    if (!issued?.ok) {
      void emitTrustEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION",
        actorUserId: input.actorUserId,
        targetType: "CROSS_ORG_REVIEW",
        targetId: row.id,
        reason: "cross_org_portal_invitation_refused",
      }).catch(() => {});
      return { ok: false, denial: "PORTAL_INVITATION_REFUSED" };
    }
    portalGrantId = issued.grantId;
  }

  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: {
      state: "ACCEPTED",
      invitedOrganizationId: input.acceptingOrganizationId,
      externalReviewGrantId: portalGrantId,
    },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_ACCEPTED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export async function declineCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  actorUserId?: string | null;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state !== "INVITED") return { ok: false };
  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: { state: "DECLINED" },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_DECLINED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export type RevokeCrossOrgReviewResult =
  | { ok: true }
  | { ok: false; denial?: "ACTOR_REQUIRED" | "POLICY_REJECTED" };

export async function revokeCrossOrgReview(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  actorUserId?: string | null;
}): Promise<RevokeCrossOrgReviewResult> {
  const prisma = input.prisma ?? defaultPrisma;
  // An actor is REQUIRED for revoke — never silently substitute a
  // zero-UUID. The downstream portal-invitation revoke writes this id
  // into the audit trail as the "who", so a missing actor would corrupt
  // the chain of accountability.
  if (!input.actorUserId) {
    void emitTrustEvent({
      prisma,
      teamId: input.teamId,
      code: "POLICY_VIOLATION",
      actorUserId: null,
      targetType: "CROSS_ORG_REVIEW",
      targetId: input.grantId,
      reason: "cross_org_revoke_missing_actor",
    }).catch(() => {});
    return { ok: false, denial: "ACTOR_REQUIRED" };
  }
  const row = await prisma.crossOrgReviewGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
  });
  if (!row) return { ok: false };
  if (row.state === "REVOKED") return { ok: true };

  // Revoke the underlying portal invitation if one was issued.
  if (row.externalReviewGrantId) {
    await revokeInvitation({
      prisma,
      teamId: input.teamId,
      grantId: row.externalReviewGrantId,
      revokedByUserId: input.actorUserId,
      reason: "cross_org_review_revoked",
    }).catch(() => {});
  }

  await prisma.crossOrgReviewGrant.update({
    where: { id: row.id },
    data: { state: "REVOKED" },
  });
  void emitCrossOrgEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "CROSS_ORG_REVIEW_REVOKED",
    actorUserId: input.actorUserId ?? null,
  }).catch(() => {});
  return { ok: true };
}

export async function listCrossOrgGrants(input: {
  prisma?: PrismaClient;
  teamId: string;
  invitingOrganizationId?: string;
  state?: CrossOrgReviewState;
}): Promise<ReadonlyArray<CrossOrgReviewGrantProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.crossOrgReviewGrant.findMany({
    where: {
      teamId: input.teamId,
      ...(input.invitingOrganizationId
        ? { invitingOrganizationId: input.invitingOrganizationId }
        : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    // R7-governance: invitingOrganizationId is R7-additive nullable. Coalesce to "" so projection
    // contract stays string. Cross-org enforcement reads the column directly (not projection).
    invitingOrganizationId: r.invitingOrganizationId ?? "",
    invitedOrganizationId: r.invitedOrganizationId,
    // R7-governance: invitedOrgSlug is R7-additive nullable. Coalesce to "" for non-null projection.
    invitedOrgSlug: r.invitedOrgSlug ?? "",
    externalReviewGrantId: r.externalReviewGrantId,
    state: r.state as CrossOrgReviewState,
    // R7-governance: scope is a Json column; project it as a string by extracting `.text` (set by
    // inviteCrossOrgReview) with fallback to JSON.stringify for legacy untyped rows.
    scope: typeof (r.scope as { text?: string } | null)?.text === "string"
      ? (r.scope as { text: string }).text
      : JSON.stringify(r.scope ?? ""),
    expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
    createdByUserId: r.createdByUserId,
    createdAtUtc: r.createdAt.toISOString(),
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _s: CrossOrgReviewState = "INVITED";
  void _s;
  void CROSS_ORG_REVIEW_STATES;
}
void _assertEnumsIntact;
