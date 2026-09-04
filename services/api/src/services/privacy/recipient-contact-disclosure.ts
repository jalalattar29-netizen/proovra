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
 *   REVEALED  A caller holding `workflow.intake_recipient_contact.reveal`
 *             sees the raw values on internal administration surfaces —
 *             the intake-links screen and the Evidence intake card —
 *             alongside the masked form.
 *
 *             This began stricter: raw came only from an audited reveal
 *             route, so the operator who typed the address had to click to
 *             see it again, on every row. On a screen listing fifty requests
 *             that is not privacy; it is an operator being made to click
 *             fifty times to answer "who did I send this to?", and what
 *             people do about that is keep a spreadsheet outside the
 *             product. The authority did not change — holding it is now
 *             enough. The reveal ROUTE remains for an explicit, audited
 *             disclosure, and MASKED and HIDDEN are untouched.
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
   * The raw values, present ONLY for a REVEALED caller. Null for everyone
   * else — not omitted, so a consumer reading the field on a masked payload
   * gets an absence rather than an undefined it might render.
   */
  recipientEmail: string | null;
  recipientPhone: string | null;
  /**
   * Whether this caller is seeing the raw values. The UI reads this and
   * nothing else, so it never has to guess whether a null means "no address"
   * or "not allowed to see it" — `hasRecipientEmail` answers the first.
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
 * The representation this caller is entitled to.
 *
 * The masked form is always present, for everybody, so a surface can render
 * provenance without asking who is looking. The raw form appears only for
 * REVEALED, and the ONLY way to reach REVEALED is
 * `resolveRecipientContactDisclosure` saying so — a caller cannot pass a
 * literal past this function's type and get an address out of it by accident,
 * because the decision is not theirs to write.
 */
export function projectRecipientContact(
  source: RecipientContactSource,
  disclosure: RecipientContactDisclosure,
): RecipientContactProjection {
  if (disclosure === "HIDDEN") {
    return {
      recipientEmailMasked: null,
      recipientPhoneMasked: null,
      recipientEmail: null,
      recipientPhone: null,
      hasRecipientEmail: false,
      hasRecipientPhone: false,
      recipientContactRevealAuthorized: false,
    };
  }

  const revealed = disclosure === "REVEALED";
  return {
    recipientEmailMasked: source.recipientEmail
      ? maskEmail(source.recipientEmail)
      : null,
    recipientPhoneMasked: source.recipientPhone
      ? maskPhonePreview(source.recipientPhone)
      : null,
    recipientEmail: revealed ? source.recipientEmail : null,
    recipientPhone: revealed ? source.recipientPhone : null,
    hasRecipientEmail: Boolean(source.recipientEmail),
    hasRecipientPhone: Boolean(source.recipientPhone),
    recipientContactRevealAuthorized: revealed,
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
