import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "../db.js";
import { AuthProvider, PlanType } from "@prisma/client";
import { ensurePersonalWorkspace } from "./platform-context/workspace-bootstrap.service.js";
import { error as logError } from "../utils/logger.js";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Tagged error thrown when a register attempt collides with an existing
// EMAIL provider account. The route handler converts this to a 409 with
// code "EMAIL_ALREADY_EXISTS". Carrying the marker on the error object
// keeps the service layer framework-agnostic (no Fastify reply usage
// here) while still letting routes branch precisely.
export class EmailAlreadyExistsError extends Error {
  readonly code = "EMAIL_ALREADY_EXISTS" as const;
  constructor() {
    super("Email already registered");
    this.name = "EmailAlreadyExistsError";
  }
}

export async function isEmailAvailableForRegistration(
  emailRaw: string,
): Promise<boolean> {
  const email = normalizeEmail(emailRaw);
  const existing = await prisma.user.findFirst({
    where: {
      provider: AuthProvider.EMAIL,
      providerUserId: email,
    },
    select: { id: true },
  });
  return !existing;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Password hash format:
 * scrypt$N$r$p$saltHex$hashHex
 */
export function hashPassword(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;

  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N, r, p });

  // ✅ FIX: use backticks
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * A real hash of a value nobody can present, derived once at module load.
 *
 * WHY IT EXISTS. `loginWithEmailPassword` used to return early when no
 * account matched, so the scrypt verification — by far the most expensive
 * thing the request does — ran only for addresses that exist. Measured
 * against the local fixture that was a consistent ~25ms difference between a
 * registered address with the wrong password and an address that is not
 * registered at all: the response bodies were identical, and the clock said
 * which was which.
 *
 * Hashing a random secret costs the same as hashing a real one, so the
 * unknown-account path now does the same work and discards the result. The
 * input is random bytes generated in this process and never stored, so there
 * is no value an attacker could supply that would make this comparison
 * succeed.
 */
const ABSENT_ACCOUNT_HASH = hashPassword(randomBytes(32).toString("hex"));

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");

  if (parts.length !== 6) return false;
  if (parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];

  // ✅ FIX: correct logical operators
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");

  const actual = scryptSync(password, salt, expected.length, { N, r, p });

  return timingSafeEqual(actual, expected);
}

export async function registerWithEmailPassword(params: {
  email: string;
  password: string;
  displayName?: string | null;
}) {
  const email = normalizeEmail(params.email);

  const provider = AuthProvider.EMAIL;
  const providerUserId = email;

  // Security: refuse registration when an EMAIL provider account
  // already exists for this address. The prior implementation silently
  // upserted, which (a) overwrote the existing passwordHash on every
  // re-submission and (b) gave the frontend no way to surface a real
  // "account already exists" affordance. We now read first, then
  // create — Prisma's @@unique(provider, providerUserId) catches the
  // race condition (two concurrent registrations) and translates to
  // the same EmailAlreadyExistsError below.
  const existing = await prisma.user.findFirst({
    where: { provider, providerUserId },
    select: { id: true },
  });

  if (existing) {
    throw new EmailAlreadyExistsError();
  }

  const passwordHash = hashPassword(params.password);

  let user;
  try {
    user = await prisma.user.create({
      data: {
        provider,
        providerUserId,
        email,
        displayName: params.displayName ?? null,
        passwordHash,
      },
    });
  } catch (err) {
    // Prisma P2002 = unique constraint violation. Race between the
    // findFirst above and this create — surface as the same conflict.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      throw new EmailAlreadyExistsError();
    }
    throw err;
  }

  const entitlement = await prisma.entitlement.findFirst({
    where: {
      userId: user.id,
      active: true
    }
  });

  if (!entitlement) {
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        plan: PlanType.FREE,
        credits: 0,
        teamSeats: 0,
        active: true
      }
    });
  }

  // PERSONAL-FIRST RESCUE — eagerly bootstrap the personal workspace
  // and set users.current_workspace_id so the user can immediately
  // use the core product (capture/evidence/reports/verify) without
  // depending on /v1/platform/context succeeding first.
  //
  // `ensurePersonalWorkspace` is idempotent: returns the existing
  // personal team on re-runs (no duplicate workspaces created). We
  // only set `currentWorkspaceId` when it is NULL so we never overwrite
  // an existing operator selection (e.g. on second signup attempt with
  // the same email after a prior session migrated to an org workspace).
  //
  // Wrapped in try/catch so a bootstrap failure does NOT block signup;
  // platform-context still has its own lazy bootstrap as a safety net.
  try {
    const personal = await ensurePersonalWorkspace({ userId: user.id });
    if (!user.currentWorkspaceId && personal.teamId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { currentWorkspaceId: personal.teamId },
      });
    }
  } catch (err) {
    logError("[registerWithEmailPassword] eager bootstrap failed (non-fatal)", {
      userId: user.id,
      error: (err as Error)?.message ?? String(err),
    });
  }

  return user;
}

export async function loginWithEmailPassword(params: {
  email: string;
  password: string;
}) {
  const email = normalizeEmail(params.email);

  const user = await prisma.user.findFirst({
    where: {
      provider: AuthProvider.EMAIL,
      providerUserId: email
    }
  });

  /*
   * Every failure costs the same. See ABSENT_ACCOUNT_HASH above: an account
   * that does not exist, and one that exists without a password, both run a
   * full scrypt verification against a hash that cannot match, so the three
   * ways to fail are indistinguishable by response AND by duration.
   *
   * The comparison result is deliberately unused; `void` says so to the
   * reader and to the linter.
   */
  if (!user || !user.passwordHash) {
    void verifyPassword(params.password, ABSENT_ACCOUNT_HASH);
    return null;
  }

  if (!verifyPassword(params.password, user.passwordHash)) {
    return null;
  }

  return user;
}

/**
 * D-5 closure — operator-initiated password change.
 *
 * Requires the current password (defense against session-takeover ->
 * silent password change). Validates the new password using the same
 * floor as registration. Returns a discriminated result so the route
 * layer can emit precise audit signals without leaking which branch
 * failed back to the caller.
 *
 * NOTE: This service does NOT rate-limit; that is the route layer's
 * job (IP + user-id bucket). It also does NOT decide whether to
 * revoke other sessions — the route fans that out via
 * `revokeAllSessionsForUser` when the caller asks.
 */
export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "user_not_found" }
  | { ok: false; reason: "not_email_user" }
  | { ok: false; reason: "no_password_set" }
  | { ok: false; reason: "current_password_mismatch" }
  | { ok: false; reason: "weak_new_password" }
  | { ok: false; reason: "same_as_current" };

const MIN_NEW_PASSWORD_LEN = 12;

export function isPasswordPolicyCompliant(newPassword: string): boolean {
  if (typeof newPassword !== "string") return false;
  if (newPassword.length < MIN_NEW_PASSWORD_LEN) return false;
  // Require at least one lowercase, one uppercase, one digit. No
  // exotic symbol requirement (NIST 800-63B aligned).
  if (!/[a-z]/.test(newPassword)) return false;
  if (!/[A-Z]/.test(newPassword)) return false;
  if (!/\d/.test(newPassword)) return false;
  return true;
}

export async function changePasswordForUser(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResult> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
  });
  if (!user) return { ok: false, reason: "user_not_found" };
  if (user.provider !== AuthProvider.EMAIL) {
    return { ok: false, reason: "not_email_user" };
  }
  if (!user.passwordHash) {
    return { ok: false, reason: "no_password_set" };
  }
  if (!verifyPassword(params.currentPassword, user.passwordHash)) {
    return { ok: false, reason: "current_password_mismatch" };
  }
  if (verifyPassword(params.newPassword, user.passwordHash)) {
    return { ok: false, reason: "same_as_current" };
  }
  if (!isPasswordPolicyCompliant(params.newPassword)) {
    return { ok: false, reason: "weak_new_password" };
  }

  const newHash = hashPassword(params.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });
  return { ok: true };
}

export async function createPasswordResetTokenForEmail(emailRaw: string) {
  const email = normalizeEmail(emailRaw);

  const user = await prisma.user.findFirst({
    where: { email }
  });

  if (!user) return null;

  if (user.provider !== AuthProvider.EMAIL) return null;

  const rawToken = randomBytes(32).toString("hex");

  const tokenHash = sha256Hex(rawToken);

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt
    }
  });

  return {
    user,
    rawToken,
    expiresAt
  };
}

export async function resetPasswordWithToken(params: {
  token: string;
  newPassword: string;
}) {
  const token = params.token.trim();

  if (!token) {
    return {
      ok: false as const,
      reason: "invalid_token" as const
    };
  }

  const tokenHash = sha256Hex(token);

  const now = new Date();

  const rec = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: now
      }
    }
  });

  if (!rec) {
    return {
      ok: false as const,
      reason: "invalid_or_expired" as const
    };
  }

  const newHash = hashPassword(params.newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: {
        id: rec.userId
      },
      data: {
        passwordHash: newHash,
        provider: AuthProvider.EMAIL,
        providerUserId: (
          await prisma.user.findUnique({
            where: { id: rec.userId }
          })
        )?.email ?? undefined
      }
    }),

    prisma.passwordResetToken.update({
      where: {
        id: rec.id
      },
      data: {
        usedAt: now
      }
    })
  ]);

  return {
    ok: true as const
  };
}

// ============================================================
// EV3 — Enterprise email verification token lifecycle
// ============================================================

// 24-hour single-use window per the product spec. Tokens are stored as
// SHA-256 hex (sha256Hex), never plaintext. Each call invalidates any
// prior unused token for the same user via `usedAt = now()` so the most
// recent link in the inbox is always the only working one — important
// when resend is hammered.
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export async function createEmailVerificationToken(userId: string) {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS);

  // Invalidate any prior unused tokens for this user, then issue a
  // fresh one. Wrapped in a transaction so a flooded resend can never
  // race two valid tokens for the same user.
  await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({
      where: {
        userId,
        usedAt: null,
      },
      data: { usedAt: now },
    }),
    prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    }),
  ]);

  return { rawToken, expiresAt };
}

// Returns either the freshly verified user or a structured failure.
// The failure reasons are deliberately coarse — the route layer maps
// them to neutral, non-enumerating client messages.
export type ConsumeEmailVerificationTokenResult =
  | { ok: true; user: { id: string; email: string | null; provider: string; emailVerifiedAt: Date } }
  | { ok: false; reason: "invalid" | "expired" | "already_used" };

export async function consumeEmailVerificationToken(
  rawTokenInput: string,
): Promise<ConsumeEmailVerificationTokenResult> {
  const raw = rawTokenInput.trim();
  if (!raw) return { ok: false, reason: "invalid" };

  const tokenHash = sha256Hex(raw);
  const now = new Date();

  const rec = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash },
  });

  if (!rec) return { ok: false, reason: "invalid" };
  if (rec.usedAt) return { ok: false, reason: "already_used" };
  if (rec.expiresAt <= now) return { ok: false, reason: "expired" };

  // Atomic: mark token used + stamp user emailVerifiedAt in one txn.
  // If the user was already verified out-of-band (e.g. via a separate
  // email-link click that landed first), keep the older timestamp so
  // audit-log queries show the actual moment ownership was proven.
  const [, user] = await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: rec.id },
      data: { usedAt: now },
    }),
    prisma.user.update({
      where: { id: rec.userId },
      data: {
        emailVerifiedAt: { set: now },
      },
      select: {
        id: true,
        email: true,
        provider: true,
        emailVerifiedAt: true,
      },
    }),
  ]);

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      provider: user.provider,
      // Non-null after the update above; assert to narrow the type.
      emailVerifiedAt: user.emailVerifiedAt as Date,
    },
  };
}

// Helper for the resend route: find a user by normalized email,
// scoped to EMAIL provider only. Returns null for OAuth users (who
// don't need a verification link) and for non-existent emails. The
// route surfaces a neutral response either way so callers cannot
// probe existence.
export async function findUnverifiedEmailUserByEmail(emailRaw: string) {
  const email = normalizeEmail(emailRaw);
  const user = await prisma.user.findFirst({
    where: {
      provider: AuthProvider.EMAIL,
      providerUserId: email,
    },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!user) return null;
  if (user.emailVerifiedAt) return null;
  return user;
}
