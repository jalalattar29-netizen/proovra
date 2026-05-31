import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "../db.js";
import { AuthProvider, PlanType } from "@prisma/client";
import { ensurePersonalWorkspace } from "./platform-context/workspace-bootstrap.service.js";
import { error as logError } from "../utils/logger.js";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

  const passwordHash = hashPassword(params.password);

  const user = await prisma.user.upsert({
    where: {
      provider_providerUserId: {
        provider,
        providerUserId
      }
    },
    create: {
      provider,
      providerUserId,
      email,
      displayName: params.displayName ?? null,
      passwordHash
    },
    update: {
      email,
      displayName: params.displayName ?? undefined,
      passwordHash
    }
  });

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

  if (!user) return null;
  if (!user.passwordHash) return null;

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
