import { prisma } from "../db.js";

/**
 * PHASE 10 §4 — LEGACY GUEST EVIDENCE CUSTODY (non-interactive persistence).
 *
 * This module is NOT an authentication feature. Guest Login was physically
 * removed from PROOVRA (2026-07-23): no new `provider=GUEST` User is ever
 * minted, and a legacy guest token can never establish an interactive session
 * (the canonical provenance rule in `requireAuth` rejects it → reauthenticate).
 *
 * `AuthProvider.GUEST` survives ONLY as historical persistence: rows created
 * before removal. Some historical Evidence is owned by such a `GUEST`-provider
 * User and is linked to a `GuestIdentity` custody row. This helper ensures that
 * custody linkage exists for a HISTORICAL guest-owned Evidence write. It is a
 * pure Prisma row operation — it CANNOT mint a JWT, set a cookie, create a
 * session, bootstrap Personal Space, or switch Workspace. It never authenticates
 * anyone; it only preserves the ownership/custody chain of pre-existing data.
 *
 * New external submissions (Intake / Evidence Request) do NOT use this path:
 * they bind custody to the resource-scoped submission identity — the link
 * creator (`createdByUserId`) owns the Evidence and the external submitter is
 * recorded via session/submitter fields, never as a `User`. See
 * `external-intake-orchestration.service.ts`.
 *
 * Historical `GuestIdentity` row retirement is registered as Phase 12 debt.
 *
 * @param userId a HISTORICAL `provider=GUEST` User id (the Evidence owner).
 *               Callers MUST gate this behind `owner.provider === GUEST`.
 */
export async function ensureLegacyGuestCustodyIdentity(userId: string) {
  const existing = await prisma.guestIdentity.findUnique({
    where: { userId },
  });
  if (existing) return existing;
  return prisma.guestIdentity.create({
    data: { userId },
  });
}
