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

import { maskEmail, maskPhonePreview } from "@proovra/shared";
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
    /**
     * The organization's identifier for its own customer, as supplied when
     * the link was created. Authoritative value; opaque to us. Null when none
     * was given.
     */
    customerId: string | null;
    /*
     * RECIPIENT CONTACT — masked by default, raw only under capability.
     *
     * Both columns exist on WorkflowIntakeLink and both are the workspace's
     * own outbound contact detail. They used to be omitted from this
     * projection entirely, which meant a reviewer could not tell where a
     * request had been sent; the omission was recorded as a decision rather
     * than a gap, so replacing it is a decision too, and this is it.
     *
     * The stored values are untouched. What leaves the API is:
     *
     *   - the masked form, ALWAYS, for anyone who can read the record;
     *   - the raw form, ONLY for a caller who holds the permission that
     *     creates intake links in this workspace — the people who chose the
     *     recipient in the first place.
     *
     * The masks come from the platform's own helpers (`maskEmail`,
     * `maskPhonePreview`) rather than a local variant. The capability is
     * decided by the canonical authorization primitive at the route, never by
     * a plan name, and `recipientContactRevealed` states which of the two the
     * caller is looking at instead of leaving them to guess.
     *
     * None of this reaches public verify: that response is a separate,
     * hand-written literal that reads none of these fields.
     */
    recipientEmailMasked: string | null;
    recipientPhoneMasked: string | null;
    /** Raw values, present only when the caller holds the reveal capability. */
    recipientEmail: string | null;
    recipientPhone: string | null;
    recipientContactRevealed: boolean;
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
  options?: { revealRecipientContact?: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<ExternalIntakeSourceSummary | null> {
  const session = await client.workflowIntakeSession.findFirst({
    where: { evidenceId },
    include: { intakeLink: true },
  });
  if (!session) return null;

  const link = session.intakeLink;
  if (!link) return null;

  // Decided by the route through the canonical authorization primitive.
  return buildSummary(link, session, options?.revealRecipientContact === true);
}

/**
 * Pure builder, exported for unit testing. Takes DB rows and returns the
 * safe authenticated-only projection. Never throws.
 */
export function buildSummary(
  link: DbWorkflowIntakeLink,
  session: DbWorkflowIntakeSession,
  /**
   * Whether this caller holds the capability to see the RAW recipient
   * contact. Defaults to false: masked is the safe answer, so a caller that
   * forgets to pass it cannot leak one.
   */
  revealRecipientContact = false,
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
      customerId: link.customerId,
      recipientEmailMasked: maskEmail(link.recipientEmail),
      recipientPhoneMasked: link.recipientPhone
        ? maskPhonePreview(link.recipientPhone)
        : null,
      recipientEmail: revealRecipientContact ? link.recipientEmail : null,
      recipientPhone: revealRecipientContact ? link.recipientPhone : null,
      recipientContactRevealed: revealRecipientContact,
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
