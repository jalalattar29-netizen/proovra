/**
 * External Intake identity, for the search index — read by BOTH hosts.
 *
 * The API indexes a record inline when it changes; the Worker indexes it from
 * the search-indexing queue. Both compose the same `EvidenceSearchDocument`
 * through the same shared projection, so both need the same four values, read
 * the same way. One reader, so the two cannot index different bodies for the
 * same record and leave search answering differently depending on which host
 * happened to touch it last.
 *
 * WHY IT LIVES HERE. It was written in `services/api/src/services/search/` and
 * imported by the Worker with a relative path across the service boundary —
 * which is the exact violation this package was created to end. The API's
 * `tsconfig.json` has no `rootDir`, so a plain typecheck resolved it happily;
 * the Worker's `tsconfig.build.json` pins `rootDir: "src"`, so the production
 * build refused it, and in Docker the API source is not in the Worker's build
 * context at all. Three different answers to the same import, which is what a
 * boundary is for.
 *
 * It takes the client as a parameter and constructs nothing, in keeping with
 * the rest of this package: each host owns its own PrismaClient.
 */

/** The four identifiers, as the search projection expects them. */
export type IntakeIdentityForIndex = {
  /** The organization's own identifier for its customer. */
  customerId: string | null;
  /** The name the operator wrote on the request. */
  recipientLabel: string | null;
  /** The address it was delivered to. */
  recipientEmail: string | null;
  /** The number as typed. */
  recipientPhone: string | null;
  /** The canonical form, so one number written three ways matches. */
  recipientPhoneE164: string | null;
};

/**
 * The minimum a caller must provide. Structural rather than `PrismaClient`, so
 * this module needs no Prisma dependency of its own — and a test can pass a
 * plain object without standing up a client.
 */
export type IntakeIdentityReader = {
  workflowIntakeSession: {
    findFirst: (args: unknown) => Promise<unknown>;
  };
};

/**
 * The intake identity behind one evidence record.
 *
 * Reached through the 1:1 `evidenceId` unique on the session, so this is a
 * keyed lookup rather than a scan. Returns null for every record that did not
 * arrive through an intake link — which is most of them, and costs one indexed
 * miss.
 */
export async function loadIntakeIdentityForIndex(
  evidenceId: string,
  client: IntakeIdentityReader,
): Promise<IntakeIdentityForIndex | null> {
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
  })) as { intakeLink: IntakeIdentityForIndex | null } | null;
  return session?.intakeLink ?? null;
}
