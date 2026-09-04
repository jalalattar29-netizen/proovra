/**
 * EXTERNAL INTAKE IDENTITY — one matching rule, every surface.
 *
 * Four identifiers can locate a record that arrived through an intake link:
 *
 *   customerId      the ORGANIZATION's own identifier for its customer
 *   recipientLabel  the name the operator wrote on the request
 *   recipientEmail  the address it was delivered to
 *   recipientPhone  the number it was texted to
 *
 * They are four different facts and every one of them is something an operator
 * genuinely types into a search box. They are NOT interchangeable, and none of
 * them is a verified identity — a Customer ID is business metadata, and a
 * recipient is a destination, not proof of who answered.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE MODULE
 * ---------------------------------------------------------------------------
 *
 * Three surfaces search records that can carry this identity — the intake-link
 * list, the Evidence list, and the Reports aggregator — and each owns its own
 * `where` clause. Written four times in three places, the twelve
 * implementations drift: one lower-cases, one does not; one understands a
 * phone number with spaces, two do not; a fifth surface appears and copies
 * whichever it found first. So the ARMS are built here, once, and each surface
 * spreads them into its own tenant-scoped clause.
 *
 * The scope is deliberately NOT this module's job. Every caller already has a
 * workspace filter and applies it in the same `where`; a search helper that
 * also decided scope would be a second authority on tenancy, which is the last
 * thing that should have two opinions.
 *
 * ---------------------------------------------------------------------------
 * SEARCHABILITY IS NOT DISCLOSURE
 * ---------------------------------------------------------------------------
 *
 * Matching on a value the caller already knows tells them nothing they did not
 * bring with them. Being SHOWN that value is a different act, governed by
 * `recipient-contact-disclosure`, and this module does not touch it. The two
 * are wired together at the routes: a caller who may not see the raw contact
 * does not get the contact arms either, because for them the search box would
 * otherwise become an oracle — "is this address in this workspace?" answered
 * by a row count.
 */

import type { Prisma } from "@prisma/client";

import { normaliseToE164 } from "@proovra/shared";

/** The bound on a needle. Long enough for any real identifier. */
export const INTAKE_SEARCH_NEEDLE_MAX = 120;

/**
 * The digit-only form of whatever the operator typed, or null when there are
 * not enough digits for the question to be about a phone number.
 *
 * Four digits is the floor because it is where a partial number stops being a
 * search and starts being a filter that returns everything.
 */
export function intakePhoneDigits(needle: string): string | null {
  const digits = needle.replace(/[^\d]/g, "");
  return digits.length >= 4 ? digits : null;
}

/**
 * The E.164 form of a needle that is plausibly a phone number, using the
 * platform's own normaliser rather than a second interpretation of what a
 * country code is.
 *
 * `+49 176 12345678`, `+4917612345678` and `0049 176 12345678` are the same
 * number written three ways, and an operator who has one of them in front of
 * them should not have to guess which one we stored.
 */
export function intakePhoneE164(needle: string): string | null {
  const trimmed = needle.trim();
  if (!/\d/.test(trimmed)) return null;
  // `00` is how most of the world writes the international prefix on paper.
  const withPlus = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
  return normaliseToE164(withPlus);
}

export type IntakeIdentityArmOptions = {
  /**
   * Whether the caller may match on the raw recipient contact. False leaves
   * the address and number out of the query entirely — see the disclosure note
   * in the header.
   */
  matchRecipientContact: boolean;
};

/**
 * The arms that match an intake LINK row.
 *
 * Spread into a caller's `OR`, inside its own tenant-scoped `where`.
 */
export function intakeLinkIdentityArms(
  needle: string,
  options: IntakeIdentityArmOptions,
): Prisma.WorkflowIntakeLinkWhereInput[] {
  const trimmed = needle.trim().slice(0, INTAKE_SEARCH_NEEDLE_MAX);
  if (!trimmed) return [];

  const like = { contains: trimmed, mode: "insensitive" as const };
  const arms: Prisma.WorkflowIntakeLinkWhereInput[] = [
    // Business metadata and the operator's own label: always matchable by
    // anyone who can read the record. Neither is a contact detail.
    { customerId: like },
    { recipientLabel: like },
  ];

  if (!options.matchRecipientContact) return arms;

  // Case-insensitive, so JOHN.SEARCH@EXAMPLE.TEST finds what was stored in
  // lower case — an email address is not case-sensitive and pretending
  // otherwise only ever produces a "no results" for a correct query.
  arms.push({ recipientEmail: like });

  // The number as typed, in case the operator is pasting back exactly what
  // they entered...
  arms.push({ recipientPhone: like });

  // ...and the canonical form, which is what makes the three ways of writing
  // one number resolve to the same row. `recipientPhoneE164` is derived at
  // write time and indexed, so this is a lookup rather than a scan over every
  // row's punctuation.
  const e164 = intakePhoneE164(trimmed);
  if (e164) arms.push({ recipientPhoneE164: e164 });

  const digits = intakePhoneDigits(trimmed);
  if (digits) {
    // A partial number — the last eight digits off a case file, typically.
    arms.push({ recipientPhoneE164: { contains: digits } });
  }

  return arms;
}

/**
 * The same four facts, reached from an EVIDENCE row.
 *
 * Evidence carries `intakeCustomerId` directly — a snapshot taken at
 * submission, because provenance is historical and because search needs an
 * indexed column rather than two joins per query. The recipient fields are NOT
 * snapshotted: they are contact details, copying them into a second table
 * multiplies the places a disclosure decision has to be got right, and the
 * relation is 1:1 through a unique key, so the join is cheap.
 */
export function evidenceIntakeIdentityArms(
  needle: string,
  options: IntakeIdentityArmOptions & {
    /**
     * The workspaces in which this caller may match on the raw recipient
     * contact.
     *
     * The Evidence list spans every workspace the caller belongs to, and the
     * disclosure answer is per workspace — an admin in one and a viewer in
     * another is an ordinary situation, not an edge case. A single boolean
     * across that set would either over-disclose in the workspace where they
     * are a viewer, or refuse a search they are entitled to run. So the
     * contact arms carry their own scope, and the surfaces that ARE
     * single-workspace simply pass the one id.
     */
    revealedTeamIds?: string[];
  },
): Prisma.EvidenceWhereInput[] {
  const trimmed = needle.trim().slice(0, INTAKE_SEARCH_NEEDLE_MAX);
  if (!trimmed) return [];

  const arms: Prisma.EvidenceWhereInput[] = [
    // The snapshot on the row itself, indexed as (teamId, intakeCustomerId).
    { intakeCustomerId: { contains: trimmed, mode: "insensitive" } },
  ];

  // The name is not a contact detail: anyone who can read the record can
  // match on the label their own workspace wrote on the request.
  const openArms = intakeLinkIdentityArms(trimmed, {
    matchRecipientContact: false,
  }).filter((arm) => !("customerId" in arm));
  if (openArms.length > 0) {
    arms.push({ workflowIntakeSession: { intakeLink: { OR: openArms } } });
  }

  if (!options.matchRecipientContact) return arms;

  const contactArms = intakeLinkIdentityArms(trimmed, {
    matchRecipientContact: true,
  }).filter((arm) => !("customerId" in arm) && !("recipientLabel" in arm));
  if (contactArms.length === 0) return arms;

  const scoped: Prisma.EvidenceWhereInput = {
    workflowIntakeSession: { intakeLink: { OR: contactArms } },
  };
  arms.push(
    options.revealedTeamIds
      ? { AND: [{ teamId: { in: options.revealedTeamIds } }, scoped] }
      : scoped,
  );

  return arms;
}

/**
 * The intake identity behind one evidence record, for the search index.
 *
 * Reached through the 1:1 `evidenceId` unique on the session, so this is a
 * keyed lookup rather than a scan. Returns null for every record that did not
 * arrive through an intake link — which is most of them, and costs one indexed
 * miss.
 */
export async function loadIntakeIdentityForIndex(
  evidenceId: string,
  client: { workflowIntakeSession: { findFirst: (args: unknown) => Promise<unknown> } },
): Promise<{
  customerId: string | null;
  recipientLabel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientPhoneE164: string | null;
} | null> {
  const session = (await client.workflowIntakeSession.findFirst({
    where: { evidenceId },
    select: {
      intakeLink: {
        select: {
          customerId: true,
          recipientLabel: true,
          recipientEmail: true,
          recipientPhone: true,
          recipientPhoneE164: true,
        },
      },
    },
  })) as {
    intakeLink: {
      customerId: string | null;
      recipientLabel: string | null;
      recipientEmail: string | null;
      recipientPhone: string | null;
      recipientPhoneE164: string | null;
    } | null;
  } | null;
  return session?.intakeLink ?? null;
}
