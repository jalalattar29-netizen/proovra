import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "../db.js";
import { AuthProvider, PlanType } from "@prisma/client";

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
