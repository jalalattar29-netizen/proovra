/**
 * EXTERNAL INTAKE RECIPIENT CONTACT — the one disclosure decision.
 *
 * `WorkflowIntakeLink.recipientEmail` / `recipientPhone` are the address and
 * number an intake request was DELIVERED to. They belong to a third party who
 * never agreed to be visible to the workspace at large, and they are not:
 *
 *   - the submitter (who answered may not be who was asked);
 *   - the customer (`customerId` is the organization's own business
 *     identifier and follows its own rules);
 *   - proof of anybody's identity.
 *
 * Before this module the same two columns had two different answers depending
 * on which projection you asked. `projectWorkflowIntakeLink` returned them
 * raw to anyone holding `evidence.read`; the intake-link LIST masked them with
 * a locally written helper; the Evidence Detail summary masked them and gated
 * the raw on `workflow.intake_link.create`. Three surfaces, three rules, one
 * data class. That is the defect this closes.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *
 *   HIDDEN    Public and token-gated contributor surfaces. No contact fields
 *             at all — not even a mask, because a mask still confirms that a
 *             particular channel was used.
 *
 *   MASKED    Every authorized reader of the resource. Provenance is
 *             preserved: an operator can see WHERE the request went and
 *             recognise it, without the platform handing out the address.
 *
 *   REVEALED  A caller holding `workflow.intake_recipient_contact.reveal` may
 *             obtain the raw values — through the canonical reveal path,
 *             which audits the disclosure. It does NOT mean the raw values
 *             travel in ordinary projections: they never do, for anyone. A
 *             projection is not a reveal, and a payload nobody asked for is
 *             the easiest thing in the world to leak.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUTHORITY IS ITS OWN PERMISSION
 * ---------------------------------------------------------------------------
 *
 * `evidence.read` is held by VIEWER. `workflow.intake_link.create` is held by
 * canonical REVIEWER — and the DB role MEMBER maps to REVIEWER, so gating on
 * it meant every ordinary team member received the stored contact details.
 * Neither is a statement about disclosure; both are statements about
 * something else that would silently move this boundary the next time
 * somebody edited them.
 *
 * MASKING AND AUTHORIZATION ARE SEPARATE. This module decides WHAT may be
 * disclosed. `maskEmail` / `maskPhonePreview` from @proovra/shared decide HOW
 * the safe representation is written, and they decide nothing else — they are
 * pure formatters and are never consulted about authority.
 */

import type { FastifyRequest } from "fastify";

import { maskEmail, maskPhonePreview } from "@proovra/shared";

import { evaluateAuthorize } from "../../middleware/authorize.js";

export const RECIPIENT_CONTACT_DISCLOSURES = [
  "HIDDEN",
  "MASKED",
  "REVEALED",
] as const;

export type RecipientContactDisclosure =
  (typeof RECIPIENT_CONTACT_DISCLOSURES)[number];

/** The only shape recipient contact may take in a projection. */
export type RecipientContactProjection = {
  /** Masked address, or null when the link has none. Never the raw value. */
  recipientEmailMasked: string | null;
  /** Masked number, or null when the link has none. Never the raw value. */
  recipientPhoneMasked: string | null;
  /**
   * Whether a channel was configured at all. Presence is not disclosure, and
   * the send/resend flows need to know without being told the address.
   */
  hasRecipientEmail: boolean;
  hasRecipientPhone: boolean;
  /**
   * Whether this caller may ask for the raw values through the reveal route.
   * The UI renders its reveal control from this and nothing else, so a reader
   * without the authority is never offered an action that would fail.
   */
  recipientContactRevealAuthorized: boolean;
};

/** The two columns, from wherever they were read. */
export type RecipientContactSource = {
  recipientEmail: string | null;
  recipientPhone: string | null;
};

/**
 * The disclosure a request is entitled to for one workspace.
 *
 * `teamId` null means a personal workspace with no membership to check: the
 * caller reached the resource through its own authorization, and there is
 * nobody else there whose contact could be exposed to. Anything else asks the
 * canonical primitive, which fails closed.
 */
export async function resolveRecipientContactDisclosure(
  req: FastifyRequest,
  options: { teamId: string | null | undefined },
): Promise<RecipientContactDisclosure> {
  if (!options.teamId) return "REVEALED";

  const outcome = await evaluateAuthorize(req, {
    teamId: options.teamId,
    permission: "workflow.intake_recipient_contact.reveal",
    antiEnumeration: true,
  });

  return outcome.allowed ? "REVEALED" : "MASKED";
}

/**
 * The safe representation, for every authorized surface.
 *
 * Note what this CANNOT do: there is no argument that makes it emit a raw
 * value. A caller that wants one has to go through `revealRecipientContact`,
 * which is a different function, on a different route, that writes an audit
 * record. That asymmetry is the point — a projection cannot leak what it has
 * no way to produce.
 */
export function projectRecipientContact(
  source: RecipientContactSource,
  disclosure: RecipientContactDisclosure,
): RecipientContactProjection {
  if (disclosure === "HIDDEN") {
    return {
      recipientEmailMasked: null,
      recipientPhoneMasked: null,
      hasRecipientEmail: false,
      hasRecipientPhone: false,
      recipientContactRevealAuthorized: false,
    };
  }

  return {
    recipientEmailMasked: source.recipientEmail
      ? maskEmail(source.recipientEmail)
      : null,
    recipientPhoneMasked: source.recipientPhone
      ? maskPhonePreview(source.recipientPhone)
      : null,
    hasRecipientEmail: Boolean(source.recipientEmail),
    hasRecipientPhone: Boolean(source.recipientPhone),
    recipientContactRevealAuthorized: disclosure === "REVEALED",
  };
}

/**
 * The raw values. Call this ONLY from the audited reveal route, and only
 * after `resolveRecipientContactDisclosure` answered REVEALED.
 *
 * It takes the decision as an argument rather than trusting the caller to
 * have checked, so a future caller that forgets cannot get a raw value out of
 * it by accident.
 */
export function revealRecipientContact(
  source: RecipientContactSource,
  disclosure: RecipientContactDisclosure,
): RecipientContactSource {
  if (disclosure !== "REVEALED") {
    return { recipientEmail: null, recipientPhone: null };
  }
  return {
    recipientEmail: source.recipientEmail,
    recipientPhone: source.recipientPhone,
  };
}
