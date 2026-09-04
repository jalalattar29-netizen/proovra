/**
 * Phase 6 — External intake source summary.
 *
 * Returns an authenticated-only safe projection of how an Evidence row
 * arrived through external intake. Used by the authenticated Evidence
 * page to render a "Source: External intake" card.
 *
 * Safety contract:
 *   - Returns null when the Evidence did not come from external intake.
 *   - Returns null when the caller is not a workspace member of the
 *     Evidence's team (the caller is responsible for the membership check
 *     and passes the resolved teamId; the service only enforces "no
 *     leakage" once authorized).
 *   - NEVER returns: tokenHash, contributor IP hash, raw user agent,
 *     recipient phone, link's revoked reason, link's consent disclosure
 *     raw text — all of which are operator-internal or reviewer-internal.
 *   - Returns ONLY: intake mode, anonymous flag, workflow template slug
 *     + name + version (from snapshot), case binding, link status, link
 *     used count, session status, session timestamps, consent acceptance
 *     yes/no + timestamp.
 *
 * Public verify never reads this — it is mounted on an authenticated
 * route only.
 */

import type {
  PrismaClient,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
  WorkflowIntakeSession as DbWorkflowIntakeSession,
} from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";

export type ExternalIntakeSourceSummary = {
  // High-level "where it came from"
  source: "external_intake";
  intakeMode: string;
  isAnonymous: boolean;

  // Workflow template snapshot facts
  workflowTemplateSlug: string;
  workflowTemplateName: string;
  workflowTemplateVersion: number;

  // Optional case/claim/matter reference
  caseId: string | null;

  // Link facts (safe-only)
  link: {
    id: string;
    status: string;
    expiresAtUtc: string;
    usedCount: number;
    maxUses: number;
    createdAt: string;
    createdByUserId: string;
    recipientLabel: string | null;
    /*
     * DELIBERATELY NOT PROJECTED: recipientEmail / recipientPhone.
     *
     * Both columns exist on WorkflowIntakeLink and both are the workspace's
     * own outbound contact detail, so surfacing them to a reviewer who can
     * already read the record is arguable. But the omission here is not an
     * oversight — the summary service test names both
     * fields as forbidden in this projection, which makes it a recorded
     * privacy decision rather than a gap.
     *
     * `recipientLabel` is the projected, human-readable stand-in and is what
     * the evidence card renders as the delivery destination. Widening this to
     * the raw address is a product decision for whoever owns that contract,
     * and it is one line here plus the two assertions that guard it.
     */
    revokedAtUtc: string | null;
  };

  // Session facts (safe-only)
  session: {
    id: string;
    status: string;
    submitterDisplayName: string | null;
    submitterEmail: string | null;
    /** Submitter-PROVIDED, like the two above. Masked for anonymous modes. */
    submitterPhone: string | null;
    pseudonym: string | null;
    openedAtUtc: string | null;
    uploadStartedAtUtc: string | null;
    uploadCompletedAtUtc: string | null;
    submittedAtUtc: string | null;
    consentAcceptedAtUtc: string | null;
    consentPolicyVersion: string | null;
  };
};

export async function loadExternalIntakeSourceSummary(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ExternalIntakeSourceSummary | null> {
  const session = await client.workflowIntakeSession.findFirst({
    where: { evidenceId },
    include: { intakeLink: true },
  });
  if (!session) return null;

  const link = session.intakeLink;
  if (!link) return null;

  return buildSummary(link, session);
}

/**
 * Pure builder, exported for unit testing. Takes DB rows and returns the
 * safe authenticated-only projection. Never throws.
 */
export function buildSummary(
  link: DbWorkflowIntakeLink,
  session: DbWorkflowIntakeSession,
): ExternalIntakeSourceSummary {
  const snapshot = link.workflowTemplateSnapshot as {
    name?: string;
  } | null;

  // Anonymous flag is derived from intake mode. The session row's
  // submitter fields are already null for anonymous modes (Phase 4
  // openIntakeSession scrubs them) but we also enforce the masking
  // at projection time as defense-in-depth: an anonymous session can
  // never leak a submitter email even if some upstream code mistakenly
  // wrote one.
  const isAnonymous =
    link.intakeMode === "EXTERNAL_ANONYMOUS" ||
    link.intakeMode === "EXTERNAL_PSEUDONYMOUS";

  return {
    source: "external_intake",
    intakeMode: link.intakeMode,
    isAnonymous,
    workflowTemplateSlug: link.workflowTemplateSlug,
    workflowTemplateName:
      typeof snapshot?.name === "string"
        ? snapshot.name
        : link.workflowTemplateSlug,
    workflowTemplateVersion: link.workflowTemplateVersion,
    caseId: link.caseId,
    link: {
      id: link.id,
      status: link.status,
      expiresAtUtc: link.expiresAtUtc.toISOString(),
      usedCount: link.usedCount,
      maxUses: link.maxUses,
      createdAt: link.createdAt.toISOString(),
      createdByUserId: link.createdByUserId,
      recipientLabel: link.recipientLabel,
      revokedAtUtc: link.revokedAtUtc?.toISOString() ?? null,
    },
    session: {
      id: session.id,
      status: session.status,
      submitterDisplayName: isAnonymous ? null : session.submitterDisplayName,
      submitterEmail: isAnonymous ? null : session.submitterEmail,
      submitterPhone: isAnonymous ? null : session.submitterPhone,
      pseudonym:
        link.intakeMode === "EXTERNAL_PSEUDONYMOUS" ? session.pseudonym : null,
      openedAtUtc: session.openedAtUtc?.toISOString() ?? null,
      uploadStartedAtUtc: session.uploadStartedAtUtc?.toISOString() ?? null,
      uploadCompletedAtUtc:
        session.uploadCompletedAtUtc?.toISOString() ?? null,
      submittedAtUtc: session.submittedAtUtc?.toISOString() ?? null,
      consentAcceptedAtUtc: session.consentAcceptedAtUtc?.toISOString() ?? null,
      consentPolicyVersion: link.consentPolicyVersion,
    },
  };
}
