import { prisma } from "../db.js";

/**
 * ADM-001 (P0, 2026-08-27) — PLATFORM-ADMIN AUTHORITY IS THE DATABASE, NOT THE
 * TOKEN.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * This resolver used to open with
 *
 *     if (jwtRole === "admin") return true;
 *
 * and return BEFORE reading anything. The `role: "admin"` claim is minted
 * server-side from `User.platformRole` at login (`auth.routes.ts`
 * `jwtPayloadFromUser`), so it could not be forged — but it is a SNAPSHOT, and
 * access tokens are signed with a `60 * 60 * 24 * 30` lifetime. Clearing
 * `User.platformRole` — an offboarding, a compromise response, a mistaken
 * grant — therefore had NO EFFECT on the holder of an already-issued token for
 * up to thirty days. There is no admin surface that revokes a platform admin's
 * session either, so in practice the only remedy was rotating the JWT secret
 * and signing every user out.
 *
 * A privilege that cannot be withdrawn is not a privilege that was granted; it
 * is one that was given away.
 *
 * THE RULE NOW
 * ---------------------------------------------------------------------------
 * A POSITIVE platform-admin decision is ALWAYS derived from current
 * authoritative state:
 *
 *   1. the deployment allow-list `PLATFORM_ADMIN_USER_IDS` — configuration is
 *      authoritative by definition and is revoked by redeploy; or
 *   2. `User.platformRole === "admin"` read from the database on this request.
 *
 * The JWT claim is ADVISORY. It never grants. It is retained only as a
 * diagnostic (`claimedAdmin` in the decision below) so a stale-claim denial is
 * distinguishable in the audit trail from an ordinary non-admin denial.
 *
 * WHY NOT A "FAST NEGATIVE" ON THE MISSING CLAIM
 * ---------------------------------------------------------------------------
 * Rejecting early when the token does NOT carry `role: "admin"` looks free and
 * is wrong twice over: a user PROMOTED after their token was minted would be
 * refused until they signed out and back in, and an operator listed only in
 * `PLATFORM_ADMIN_USER_IDS` carries no claim at all and would never be admitted.
 * Both are silent lockouts of a legitimate operator, which is the failure mode
 * that gets a security control disabled. The cost avoided is a single indexed
 * primary-key lookup; correctness wins.
 *
 * FAIL CLOSED
 * ---------------------------------------------------------------------------
 * A missing user row (deleted account) and a database error both resolve to
 * NOT admin. The caller receives a denial, never an exception that some outer
 * `catch` could convert into a permissive default.
 */

/** Why a platform-admin decision came out the way it did. Audit-safe. */
export type PlatformAdminSource =
  | "ENV_ALLOWLIST"
  | "DATABASE_ROLE"
  | "NOT_ADMIN"
  | "USER_NOT_FOUND"
  | "LOOKUP_FAILED";

export type PlatformAdminDecision = {
  /** The ONLY field an authorization gate may branch on. */
  allowed: boolean;
  /** Which authority decided, for logging and audit. Never sent to a client. */
  source: PlatformAdminSource;
  /**
   * True when the request's JWT asserted `role: "admin"`.
   *
   * `claimedAdmin && !allowed` is precisely the stale-privilege case this
   * finding exists for — a token minted while the user was an admin, presented
   * after the grant was withdrawn. Surfacing it lets the gate log a demotion
   * that is still being exercised rather than silently 403-ing.
   */
  claimedAdmin: boolean;
};

function parsePlatformAdminEnvIds(): string[] {
  const raw = process.env.PLATFORM_ADMIN_USER_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve platform-admin authority against CURRENT authoritative state.
 *
 * `knownPlatformRole` lets a caller that has ALREADY read the user row pass the
 * column instead of provoking a second identical query — `platform-context`
 * selects `platformRole` for its own projection on every context load. Pass it
 * ONLY when it came from the database on this request; passing a token claim
 * here would reintroduce the defect this function exists to close.
 */
export async function resolvePlatformAdmin(
  userId: string,
  jwtRole?: string | null,
  knownPlatformRole?: string | null | undefined,
): Promise<PlatformAdminDecision> {
  const claimedAdmin = jwtRole === "admin";

  if (parsePlatformAdminEnvIds().includes(userId)) {
    return { allowed: true, source: "ENV_ALLOWLIST", claimedAdmin };
  }

  // `undefined` means "not supplied"; `null` is a real database value meaning
  // "this user has no platform role" and must NOT trigger a second read.
  if (knownPlatformRole !== undefined) {
    return {
      allowed: knownPlatformRole === "admin",
      source: knownPlatformRole === "admin" ? "DATABASE_ROLE" : "NOT_ADMIN",
      claimedAdmin,
    };
  }

  let row: { platformRole: string | null } | null;
  try {
    row = await prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
  } catch {
    // Fail closed. An unreachable database denies; it never admits.
    return { allowed: false, source: "LOOKUP_FAILED", claimedAdmin };
  }

  if (!row) {
    return { allowed: false, source: "USER_NOT_FOUND", claimedAdmin };
  }

  return {
    allowed: row.platformRole === "admin",
    source: row.platformRole === "admin" ? "DATABASE_ROLE" : "NOT_ADMIN",
    claimedAdmin,
  };
}

/**
 * Boolean convenience over {@link resolvePlatformAdmin}, kept because a dozen
 * call sites only need the verdict. Same authority, same fail-closed rule — the
 * `jwtRole` argument is accepted for signature compatibility and is NEVER
 * sufficient on its own.
 */
export async function isPlatformAdmin(
  userId: string,
  jwtRole?: string | null,
  knownPlatformRole?: string | null | undefined,
): Promise<boolean> {
  const decision = await resolvePlatformAdmin(userId, jwtRole, knownPlatformRole);
  return decision.allowed;
}
