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
import {
  projectRecipientContact,
  type RecipientContactDisclosure,
} from "./privacy/recipient-contact-disclosure.js";

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
     * RECIPIENT CONTACT — masked, always, for everyone.
     *
     * Both columns exist on WorkflowIntakeLink and both are the workspace's
     * own outbound contact detail. They were originally omitted from this
     * projection entirely, then briefly returned raw to a caller holding
     * `workflow.intake_link.create` — which the DB role MEMBER holds, so
     * "authorized" was a wider circle than it read as.
     *
     * Now this projection cannot emit a raw value at all. It carries the
     * masked form and a flag saying whether this caller MAY ask for the raw
     * one; the asking happens at
     * POST /v1/workflow/intake-links/:id/recipient-contact, which is gated on
     * `workflow.intake_recipient_contact.reveal` and audits the disclosure.
     *
     * The shape below is `RecipientContactProjection` from the canonical
     * policy module, spread in, so this surface cannot drift from the intake
     * administration surface.
     */
    recipientEmailMasked: string | null;
    recipientPhoneMasked: string | null;
    /** Raw, for a caller the disclosure policy resolved as REVEALED. */
    recipientEmail: string | null;
    recipientPhone: string | null;
    hasRecipientEmail: boolean;
    hasRecipientPhone: boolean;
    recipientContactRevealAuthorized: boolean;
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
  options?: { recipientContactDisclosure?: RecipientContactDisclosure },
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
  return buildSummary(link, session, options?.recipientContactDisclosure ?? "MASKED");
}

/**
 * Pure builder, exported for unit testing. Takes DB rows and returns the
 * safe authenticated-only projection. Never throws.
 */
export function buildSummary(
  link: DbWorkflowIntakeLink,
  session: DbWorkflowIntakeSession,
  /**
   * What this caller may be shown. MASKED by default, because a caller that
   * forgets to pass it should disclose less, not more. Note that neither
   * value makes this function emit a raw address — REVEALED only records
   * that the caller may go and ASK for one.
   */
  disclosure: RecipientContactDisclosure = "MASKED",
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
      ...projectRecipientContact(link, disclosure),
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
