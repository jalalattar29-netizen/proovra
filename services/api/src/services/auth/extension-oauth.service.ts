/**
 * UC-1 — first-party extension OAuth (Authorization Code + PKCE S256).
 *
 * This is NOT a second auth system. The authorize step runs behind the
 * canonical `requireAuth` (the user is already signed in to PROOVRA), issues a
 * single-use, short-lived, PKCE-bound authorization code, and the token step
 * exchanges it for an ordinary short-lived AUTH_JWT the canonical `requireAuth`
 * already accepts. The extension therefore never holds a long-lived credential,
 * no secret is embedded, and the server reauthorizes every capture call.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export const EXTENSION_OAUTH_CODE_TTL_SECONDS = 60;
export const EXTENSION_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const EXTENSION_OAUTH_SCOPES = ["capture.direct", "offline"] as const;

/**
 * The single first-party public client. A redirect URI is accepted when it is a
 * Chrome/Edge extension redirect (`https://<32-char-id>.chromiumapp.org/...`),
 * or is explicitly allowlisted via EXTENSION_OAUTH_REDIRECT_ALLOW (comma list)
 * for a pinned extension id. Never an arbitrary redirect.
 */
export const EXTENSION_OAUTH_CLIENT_ID = "proovra-extension";
const CHROMIUMAPP_REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9._-]*$/;

export function isAllowedExtensionRedirect(clientId: string, redirectUri: string): boolean {
  if (clientId !== EXTENSION_OAUTH_CLIENT_ID) return false;
  if (typeof redirectUri !== "string" || redirectUri.length > 512) return false;
  const explicit = (process.env.EXTENSION_OAUTH_REDIRECT_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit.includes(redirectUri);
  return CHROMIUMAPP_REDIRECT.test(redirectUri);
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class ExtensionOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(code);
    this.name = "ExtensionOAuthError";
  }
}

/** S256 verification: base64url(sha256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const computed = base64Url(sha256(codeVerifier));
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createExtensionAuthCode(input: {
  prisma?: PrismaClient;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  now?: Date;
}): Promise<{ code: string }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  if (input.codeChallengeMethod !== "S256") {
    throw new ExtensionOAuthError("UNSUPPORTED_CODE_CHALLENGE_METHOD", 400);
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeChallenge)) {
    throw new ExtensionOAuthError("INVALID_CODE_CHALLENGE", 400);
  }
  if (!isAllowedExtensionRedirect(input.clientId, input.redirectUri)) {
    throw new ExtensionOAuthError("INVALID_CLIENT_OR_REDIRECT", 400);
  }
  const code = base64Url(randomBytes(32));
  await db.extensionAuthCode.create({
    data: {
      codeHash: sha256(code).toString("hex"),
      userId: input.userId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope.slice(0, 120),
      expiresAtUtc: new Date(now.getTime() + EXTENSION_OAUTH_CODE_TTL_SECONDS * 1000),
    } as never,
  });
  return { code };
}

/**
 * Exchange a code for the user id, enforcing every binding: the code exists, is
 * unexpired, is claimed exactly once (atomic), and the client, redirect and
 * PKCE verifier all match. Any failure throws a bounded error.
 */
export async function exchangeExtensionAuthCode(input: {
  prisma?: PrismaClient;
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  now?: Date;
}): Promise<{ userId: string; scope: string }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  if (typeof input.code !== "string" || input.code.length < 10 || input.code.length > 200) {
    throw new ExtensionOAuthError("INVALID_CODE", 400);
  }
  const codeHash = sha256(input.code).toString("hex");

  // Atomic single-use claim: only the caller that flips used_at wins.
  const claimed = await db.extensionAuthCode.updateMany({
    where: { codeHash, usedAtUtc: null, expiresAtUtc: { gt: now } },
    data: { usedAtUtc: now },
  });
  if (claimed.count !== 1) {
    throw new ExtensionOAuthError("CODE_INVALID_OR_USED", 400);
  }
  const row = await db.extensionAuthCode.findUnique({
    where: { codeHash },
    select: { userId: true, clientId: true, redirectUri: true, codeChallenge: true, scope: true },
  });
  if (!row) throw new ExtensionOAuthError("CODE_INVALID_OR_USED", 400);
  if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) {
    throw new ExtensionOAuthError("CLIENT_OR_REDIRECT_MISMATCH", 400);
  }
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    throw new ExtensionOAuthError("PKCE_VERIFICATION_FAILED", 400);
  }
  return { userId: row.userId, scope: row.scope };
}
