import { evaluateExistingAccountLink } from "./security/enterprise-account-linking.service.js";
import { randomBytes, scrypt, timingSafeEqual, createHash, type ScryptOptions } from "node:crypto";
import { prisma } from "../db.js";
import { AuthProvider, type User } from "@prisma/client";
import { ensurePersonalWorkspace } from "./platform-context/workspace-bootstrap.service.js";
import { ensureEntitlement } from "./billing.service.js";
import { error as logError } from "../utils/logger.js";
import { closedAccountProviderId } from "./identity/account-closed.js";

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

/**
 * D24 — a registration password below the account password policy. Carries
 * the SAME bounded code a password change and a password reset answer with,
 * so every surface that sets a password refuses a weak one identically.
 */
export class WeakPasswordError extends Error {
  readonly code = "weak_new_password" as const;
  constructor() {
    super("Password does not meet the password policy");
    this.name = "WeakPasswordError";
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
 *
 * F-21 — the derivation runs on the libuv thread pool (`crypto.scrypt`), not on
 * the event loop (`scryptSync` used to block every other request for the whole
 * derivation). The parameters, salt length, key length and encoding are exactly
 * the ones every stored hash was written with, so old and new hashes are the
 * same bytes in the same format.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
/**
 * Bounded work. N=16384, r=8 needs 128·N·r = 16 MiB; the ceiling leaves room for
 * that and refuses a stored hash whose parameters would ask for more, so a row
 * cannot make one verification allocate without limit.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** A stored key longer than this is not one this codebase wrote. */
const SCRYPT_MAX_STORED_KEY_BYTES = 64;

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { ...options, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const N = SCRYPT_N;
  const r = SCRYPT_R;
  const p = SCRYPT_P;

  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveScrypt(password, salt, SCRYPT_KEY_BYTES, { N, r, p });

  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * A real hash of a value nobody can present, derived once per process.
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
let absentAccountHash: Promise<string> | null = null;
function getAbsentAccountHash(): Promise<string> {
  absentAccountHash ??= hashPassword(randomBytes(32).toString("hex"));
  return absentAccountHash;
}

/** Do the same work as a real verification and discard the answer. */
async function burnPasswordVerification(password: string): Promise<void> {
  await verifyPassword(password, await getAbsentAccountHash());
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");

  if (parts.length !== 6) return false;
  if (parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  // An empty or oversized stored key is not a hash this codebase wrote; an
  // empty one would otherwise compare equal to an empty derivation.
  if (expected.length === 0 || expected.length > SCRYPT_MAX_STORED_KEY_BYTES) return false;

  let actual: Buffer;
  try {
    actual = await deriveScrypt(password, salt, expected.length, { N, r, p });
  } catch {
    // Parameters scrypt refuses, or above the memory ceiling.
    return false;
  }

  return timingSafeEqual(actual, expected);
}

/**
 * F-22 — the registration result. `resumed` is true when the address already
 * held an unfinished signup by the same registrant (see
 * {@link isResumableSignup}) and this call finished it instead of refusing.
 */
export type RegisterWithEmailPasswordResult = {
  user: User;
  resumed: boolean;
};

/**
 * F-22 — an earlier attempt committed the User row and then failed (the
 * entitlement bootstrap threw, the verification token could not be written,
 * the process died before answering). Answering that registrant's retry with
 * 409 "already exists" was a dead end: sign-in says "verify your email" and no
 * link was ever sent.
 *
 * The retry is resumable only when the account is still unverified AND the
 * retry presents the password the account was registered with — the same
 * proof a verification link needs beside it (PROV-001), so it grants nothing a
 * stranger lacks today: no session is minted, and the only effect is a fresh
 * link to the address's own mailbox. A verified account, or a different
 * password, is refused with the unchanged 409, so an owner's account is never
 * touched by someone else's sign-up.
 *
 * One verification always runs, so a verified and an unverified collision cost
 * the same.
 */
async function isResumableSignup(
  existing: Pick<User, "emailVerifiedAt" | "passwordHash">,
  password: string,
): Promise<boolean> {
  const matches = await verifyPassword(
    password,
    existing.passwordHash ?? (await getAbsentAccountHash()),
  );
  return matches && !existing.emailVerifiedAt && Boolean(existing.passwordHash);
}

/**
 * The bootstrap a new account needs beyond its User row. Both steps are
 * idempotent, so a resumed signup simply runs them again.
 */
async function bootstrapRegisteredAccount(user: User): Promise<void> {
  // UC-COM-004 — the ONE entitlement bootstrap (create, then re-read the winner on a unique
  // violation of entitlements_user_id_active_key). Never check-then-create here.
  await ensureEntitlement(user.id);

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
}

export async function registerWithEmailPassword(params: {
  email: string;
  password: string;
  displayName?: string | null;
}): Promise<RegisterWithEmailPasswordResult> {
  const email = normalizeEmail(params.email);

  // D24 — the same floor as reset and change. The register form enforces
  // it; the server accepted any eight characters from a direct call.
  if (!isPasswordPolicyCompliant(params.password)) {
    throw new WeakPasswordError();
  }

  const provider = AuthProvider.EMAIL;
  const providerUserId = email;

  // Security: refuse registration when an EMAIL provider account
  // already exists for this address. The prior implementation silently
  // upserted, which (a) overwrote the existing passwordHash on every
  // re-submission and (b) gave the frontend no way to surface a real
  // "account already exists" affordance. We now read first, then
  // create — Prisma's @@unique(provider, providerUserId) catches the
  // race condition (two concurrent registrations) and translates to
  // the same EmailAlreadyExistsError below. F-22: an unfinished signup by
  // the same registrant is resumed instead (isResumableSignup).
  const resumeOrRefuse = async (): Promise<RegisterWithEmailPasswordResult | null> => {
    const existing = await prisma.user.findFirst({ where: { provider, providerUserId } });
    if (!existing) return null;
    if (!(await isResumableSignup(existing, params.password))) {
      throw new EmailAlreadyExistsError();
    }
    await bootstrapRegisteredAccount(existing);
    return { user: existing, resumed: true };
  };

  const resumed = await resumeOrRefuse();
  if (resumed) return resumed;

  const passwordHash = await hashPassword(params.password);

  let user: User;
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
    // findFirst above and this create — the winner's row decides, exactly
    // as if it had been there at the read (a double-submitted form resumes,
    // anyone else gets the conflict).
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      const winner = await resumeOrRefuse();
      if (winner) return winner;
      throw new EmailAlreadyExistsError();
    }
    throw err;
  }

  await bootstrapRegisteredAccount(user);

  return { user, resumed: false };
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
   * Every failure costs the same. See getAbsentAccountHash above: an account
   * that does not exist, and one that exists without a password, both run a
   * full scrypt verification against a hash that cannot match, so the three
   * ways to fail are indistinguishable by response AND by duration.
   *
   * The comparison result is deliberately unused; `void` says so to the
   * reader and to the linter.
   */
  if (!user || !user.passwordHash) {
    await burnPasswordVerification(params.password);
    return null;
  }

  if (!(await verifyPassword(params.password, user.passwordHash))) {
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
  if (!(await verifyPassword(params.currentPassword, user.passwordHash))) {
    return { ok: false, reason: "current_password_mismatch" };
  }
  if (await verifyPassword(params.newPassword, user.passwordHash)) {
    return { ok: false, reason: "same_as_current" };
  }
  if (!isPasswordPolicyCompliant(params.newPassword)) {
    return { ok: false, reason: "weak_new_password" };
  }

  const newHash = await hashPassword(params.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });
  return { ok: true };
}

/**
 * IDENT-013 — an IdP or directory can create a row for any address its
 * organization names. A reset on such a row would hand the mailbox owner a
 * working account the organization's IdP can also sign in to, so it is refused
 * until that organization has proved the domain. A row with a password, or one
 * from an organization holding the domain, is an ordinary account.
 */
async function isUnprovenDirectoryAccount(user: {
  id: string;
  email: string | null;
  passwordHash: string | null;
  providerUserId: string;
}): Promise<boolean> {
  if (user.passwordHash || !/^(sso|saml|scim)-/.test(user.providerUserId)) return false;
  const mapping = await prisma.externalIdentityMapping.findFirst({
    where: { userId: user.id, unlinkedAtUtc: null },
    select: { teamId: true },
  });
  if (!mapping || !user.email) return true;
  const proven = await evaluateExistingAccountLink({ teamId: mapping.teamId, email: user.email });
  return !proven.ok;
}

export async function createPasswordResetTokenForEmail(emailRaw: string) {
  const email = normalizeEmail(emailRaw);

  // `email` is not unique: one address can sit on an EMAIL row and a GOOGLE row,
  // and an IdP can create a second EMAIL row. Reset belongs to the EMAIL row, so
  // the owner of a mailbox can take back a password somebody else set on their
  // address, and among EMAIL rows the one with a password is the person's own, so
  // a row an IdP created cannot divert their reset.
  const user = await prisma.user.findFirst({
    where: { provider: AuthProvider.EMAIL, email },
    orderBy: [{ passwordHash: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
  });

  if (!user) return null;

  // PRO-011 (AUTH-05) — a closed account keeps its address until anonymisation,
  // which a legal hold can defer; it is not reopened through a reset.
  if (user.providerUserId === closedAccountProviderId(user.id)) return null;

  if (await isUnprovenDirectoryAccount(user)) return null;

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

  // D24 — the same floor as a password change. The reset form enforces it;
  // the server did not, so a direct call could set an eight-character password.
  if (!isPasswordPolicyCompliant(params.newPassword)) {
    return {
      ok: false as const,
      reason: "weak_new_password" as const
    };
  }

  const newHash = await hashPassword(params.newPassword);

  /*
   * PRO-004 — ONE TOKEN, ONE PASSWORD.
   *
   * The token used to be read as unused above and then marked used by id in a
   * later batch, so two confirms of one link could both pass the read and both
   * write: each was told success, the second-dispatched password won, and the
   * caller whose password lost could no longer sign in. The claim is now the
   * first write of the transaction that sets the password, guarded on the same
   * conditions the read checked (unused, unexpired). Postgres serialises the two
   * UPDATEs on the row: the loser re-evaluates `used_at IS NULL` after the
   * winner commits, matches nothing, and its transaction rolls back without
   * writing — it gets the same refusal as a used link. The route revokes
   * sessions and step-ups only for the winner, so that happens once.
   *
   * PRO-011 (AUTH-05) — and a closed account is not reopened: closure retires
   * outstanding links in its access phase, and the password write is guarded on
   * the account not being closed, so a link issued before closure (or racing
   * it) finds nothing to write and refuses.
   */
  const outcome = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: rec.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claim.count === 0) return "invalid_or_expired" as const;

    const owner = await tx.user.findUnique({
      where: { id: rec.userId },
      select: { email: true, emailVerifiedAt: true, providerUserId: true },
    });
    if (!owner || owner.providerUserId === closedAccountProviderId(rec.userId)) {
      throw new ResetRefused("invalid_or_expired");
    }

    // PROV-001 — the link came out of the mailbox and the password is new, so
    // this one act proves both together. It also retires any password a stranger
    // set on this address, which is why a reset is the way back for someone who
    // finds an account they never opened: it verifies the address and ends the
    // verification links still waiting on the old password.
    const written = await tx.user.updateMany({
      where: { id: rec.userId, providerUserId: { not: closedAccountProviderId(rec.userId) } },
      data: {
        passwordHash: newHash,
        provider: AuthProvider.EMAIL,
        providerUserId: owner.email ?? undefined,
        emailVerifiedAt: owner.emailVerifiedAt ?? now,
        credentialProvenAtUtc: now,
      },
    });
    if (written.count === 0) throw new ResetRefused("invalid_or_expired");

    await tx.emailVerificationToken.updateMany({
      where: { userId: rec.userId, usedAt: null },
      data: { usedAt: now },
    });
    return "ok" as const;
  }).catch((err: unknown) => {
    // A refusal found after the claim rolls the claim back with everything else.
    if (err instanceof ResetRefused) return err.reason;
    throw err;
  });

  if (outcome !== "ok") {
    return { ok: false as const, reason: outcome };
  }

  return {
    ok: true as const,
    userId: rec.userId
  };
}

/** A reset refused inside its transaction, after the token claim. */
class ResetRefused extends Error {
  constructor(readonly reason: "invalid_or_expired") {
    super(reason);
  }
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

export async function createEmailVerificationToken(
  userId: string,
  options: {
    /**
     * F-06 — false leaves earlier unused links working until the provider has
     * accepted the new one ({@link settleEmailVerificationTokenDelivery}), so a
     * resend the provider refuses does not kill a link already in the inbox.
     */
    retirePriorTokens?: boolean;
  } = {},
) {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS);
  const retirePriorTokens = options.retirePriorTokens ?? true;

  const create = prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
    select: { id: true, createdAt: true },
  });

  // Invalidate any prior unused tokens for this user, then issue a
  // fresh one. Wrapped in a transaction so a flooded resend can never
  // race two valid tokens for the same user.
  const row = retirePriorTokens
    ? (
        await prisma.$transaction([
          prisma.emailVerificationToken.updateMany({
            where: {
              userId,
              usedAt: null,
            },
            data: { usedAt: now },
          }),
          create,
        ])
      )[1]
    : await create;

  return { rawToken, expiresAt, tokenId: row.id, createdAt: row.createdAt };
}

/**
 * F-06 — record what the provider said about the link just minted.
 *
 *   - `acknowledged`: the new link is the working one; every OLDER unused link
 *     is retired (the "only the most recent link works" rule, applied once the
 *     most recent link is known to exist in the mailbox).
 *   - `ambiguous`: the message may or may not have gone out. The new link stays
 *     (it may be in the inbox) and so do the older ones (it may not be).
 *   - `refused`: the provider refused, or no transport exists. The link never
 *     left this process, so the row is removed: it cannot be used by anyone,
 *     and it must not count as a recent send for the resend cooldown.
 */
export async function settleEmailVerificationTokenDelivery(
  token: { tokenId: string; userId: string; createdAt: Date },
  outcome: "acknowledged" | "ambiguous" | "refused",
): Promise<void> {
  if (outcome === "refused") {
    await prisma.emailVerificationToken.deleteMany({
      where: { id: token.tokenId, usedAt: null },
    });
    return;
  }
  if (outcome === "acknowledged") {
    await prisma.emailVerificationToken.updateMany({
      where: {
        userId: token.userId,
        usedAt: null,
        id: { not: token.tokenId },
        createdAt: { lt: token.createdAt },
      },
      data: { usedAt: new Date() },
    });
  }
}

/**
 * F-06 — when the newest link that may have reached the mailbox was minted.
 * Refused sends leave no row ({@link settleEmailVerificationTokenDelivery}), so
 * this is the honest basis for the per-address resend cooldown.
 */
export async function latestDeliverableVerificationTokenAt(userId: string): Promise<Date | null> {
  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return latest?.createdAt ?? null;
}

// Returns either the freshly verified user or a structured failure.
// The failure reasons are deliberately coarse — the route layer maps
// them to neutral, non-enumerating client messages.
export type ConsumeEmailVerificationTokenResult =
  | { ok: true; user: { id: string; email: string | null; provider: string; emailVerifiedAt: Date } }
  | {
      ok: false;
      reason: "invalid" | "expired" | "already_used" | "password_required" | "password_incorrect";
    };

export async function consumeEmailVerificationToken(
  rawTokenInput: string,
  options: { password?: string | null } = {},
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

  /*
   * PROV-001 — VERIFYING AN ADDRESS MUST NOT ACTIVATE A STRANGER'S PASSWORD.
   *
   * Registration stores a password for an address nobody has proven. The link
   * goes to the real mailbox, so if the mailbox owner clicks a message they
   * never asked for, the account goes live with a password chosen by whoever
   * registered it, and that person signs in from then on. An ownership grant
   * made to this account later lands on both of them, and it is exactly how an
   * organization ended up with an attacker for an owner.
   *
   * So the first verification of an account with a password needs both halves
   * at once: the emailed token and the password. The registrant has both. The
   * attacker has only the password; the mailbox owner has only the token, and
   * uses "forgot password" instead, which replaces the password and ends every
   * session. A refused attempt leaves the token live, so a mistyped password is
   * not a dead link.
   */
  const account = await prisma.user.findUnique({
    where: { id: rec.userId },
    select: { emailVerifiedAt: true, passwordHash: true },
  });
  const firstVerificationOfPassword = Boolean(
    account && !account.emailVerifiedAt && account.passwordHash,
  );
  if (firstVerificationOfPassword) {
    if (!options.password) return { ok: false, reason: "password_required" };
    if (!(await verifyPassword(options.password, account?.passwordHash as string))) {
      return { ok: false, reason: "password_incorrect" };
    }
  }

  // Atomic: mark token used + stamp user emailVerifiedAt in one txn.
  // If the user was already verified out-of-band (e.g. via a separate
  // email-link click that landed first), keep the older timestamp so
  // audit-log queries show the actual moment ownership was proven.
  // D15 — the stamp is written only where none exists; it used to be
  // overwritten unconditionally, contradicting the rule above.
  const [, , user] = await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: rec.id },
      data: { usedAt: now },
    }),
    prisma.user.updateMany({
      where: { id: rec.userId, emailVerifiedAt: null },
      data: {
        emailVerifiedAt: now,
        ...(firstVerificationOfPassword ? { credentialProvenAtUtc: now } : {}),
      },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: rec.userId },
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
  // By address, not providerUserId: a directory-created row is an EMAIL account
  // with a synthetic provider id, and it needs a verified address to accept an
  // invitation like anyone else.
  const user = await prisma.user.findFirst({
    where: {
      provider: AuthProvider.EMAIL,
      email,
      emailVerifiedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  return user;
}
