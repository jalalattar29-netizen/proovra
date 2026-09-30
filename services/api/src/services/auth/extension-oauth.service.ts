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
/** Random part (43) + "." + provenance segment; bounded well under the column-free transport limits. */
export const EXTENSION_OAUTH_CODE_MAX_LENGTH = 512;
/**
 * UC-EXT-008 — "offline" is gone: there is no refresh token, so advertising
 * offline access was false. A request still carrying it (an older extension
 * build) is accepted and the grant is narrowed to capture.direct.
 */
export const EXTENSION_OAUTH_SCOPES = ["capture.direct"] as const;

/** The scope actually granted: capture.direct, whatever else was requested. */
export function normalizeExtensionScope(_requested: string | null | undefined): string {
  return "capture.direct";
}

/**
 * The single first-party public client. A redirect URI is accepted only when it
 * is EXPLICITLY allowlisted via EXTENSION_OAUTH_REDIRECT_ALLOW (comma list) for
 * the pinned PROOVRA extension id, and is itself a Chrome/Edge extension
 * redirect (`https://<32-char-id>.chromiumapp.org/...`). Never an arbitrary
 * redirect.
 *
 * ET-DC-04 — FAIL CLOSED. With the variable unset this accepted ANY
 * chromiumapp.org extension id, and authorize issues a code from the ambient
 * session and redirects at once: a third-party extension could silently obtain
 * a capture.direct token. Unset (or holding no valid entry) now refuses every
 * redirect — the state the release docs already describe ("fails closed
 * server-side until registered").
 */
export const EXTENSION_OAUTH_CLIENT_ID = "proovra-extension";
const CHROMIUMAPP_REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9._-]*$/;

export function isAllowedExtensionRedirect(clientId: string, redirectUri: string): boolean {
  if (clientId !== EXTENSION_OAUTH_CLIENT_ID) return false;
  if (typeof redirectUri !== "string" || redirectUri.length > 512) return false;
  const explicit = (process.env.EXTENSION_OAUTH_REDIRECT_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => CHROMIUMAPP_REDIRECT.test(s));
  return explicit.includes(redirectUri);
}

/**
 * UC-SEC-002 — the extension ORIGINS the API's CORS policy may admit. Derived
 * from the same pinned configuration as the OAuth redirect, so the two cannot
 * disagree: each allow-listed `https://<id>.chromiumapp.org/...` redirect names
 * extension `<id>`, whose pages and service worker send
 * `Origin: chrome-extension://<id>`. EXTENSION_ALLOWED_ORIGINS (comma list of
 * `chrome-extension://<32 a-p chars>`) adds origins explicitly. FAIL CLOSED:
 * anything that is not exactly an extension origin is ignored, and with neither
 * variable set the list is empty.
 */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
export function extensionAllowedOrigins(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const out = new Set<string>();
  for (const raw of (env.EXTENSION_OAUTH_REDIRECT_ALLOW ?? "").split(",")) {
    const s = raw.trim();
    if (!CHROMIUMAPP_REDIRECT.test(s)) continue;
    out.add(`chrome-extension://${new URL(s).hostname.split(".")[0]}`);
  }
  for (const raw of (env.EXTENSION_ALLOWED_ORIGINS ?? "").split(",")) {
    const s = raw.trim();
    if (EXTENSION_ORIGIN.test(s)) out.add(s);
  }
  return [...out].sort();
}

export function isAllowedExtensionOrigin(
  origin: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return typeof origin === "string" && extensionAllowedOrigins(env).includes(origin);
}

/**
 * UC-SEC-004 / UC-EXT-008 — the AUTHORIZING session's real provenance, carried
 * from authorize to token so the extension token states how the user actually
 * authenticated (it used to hard-code SOCIAL_OAUTH) and is anchored to the same
 * workspace session row, so organization session policy, the role
 * session-timeout and per-session revocation all apply to it.
 *
 * It rides INSIDE the authorization code, after the random part:
 * `<43 random chars>.<base64url JSON>`. No schema change is needed and it cannot
 * be forged: the code row stores sha256 of the WHOLE code string, so any edit to
 * the provenance segment finds no row and the exchange fails. The values are
 * the same claims the resulting access token carries in its readable payload,
 * so the code discloses nothing the token would not.
 */
export type ExtensionAuthProvenance = {
  /** Supported authentication ceremony of the authorizing session. */
  authMethod: "PASSWORD" | "MAGIC_LINK" | "SOCIAL_OAUTH" | "SAML" | "OIDC";
  /** Epoch seconds of the PRIMARY authentication (never reset). */
  authAt: number | null;
  ssoConnId: string | null;
  mfaAt: number | null;
  /** The authorizing session's workspace anchor (its session row's teamId). */
  teamId: string | null;
};

const PROVENANCE_METHODS: ReadonlySet<string> = new Set(["PASSWORD", "MAGIC_LINK", "SOCIAL_OAUTH", "SAML", "OIDC"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeProvenance(p: ExtensionAuthProvenance): string {
  return Buffer.from(
    JSON.stringify({ m: p.authMethod, a: p.authAt, s: p.ssoConnId, f: p.mfaAt, t: p.teamId }),
    "utf8",
  ).toString("base64url");
}

/** Parse the provenance segment of a code the DB has already matched. */
export function decodeProvenanceFromCode(code: string): ExtensionAuthProvenance | null {
  const dot = code.indexOf(".");
  if (dot < 0) return null;
  try {
    const raw = JSON.parse(Buffer.from(code.slice(dot + 1), "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof raw.m !== "string" || !PROVENANCE_METHODS.has(raw.m)) return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
    const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
    return {
      authMethod: raw.m as ExtensionAuthProvenance["authMethod"],
      authAt: num(raw.a),
      ssoConnId: id(raw.s),
      mfaAt: num(raw.f),
      teamId: id(raw.t),
    };
  } catch {
    return null;
  }
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
  /** The authorizing session (UC-SEC-004). Required: a code without it cannot mint a token. */
  provenance: ExtensionAuthProvenance;
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
  const code = `${base64Url(randomBytes(32))}.${encodeProvenance(input.provenance)}`;
  await db.extensionAuthCode.create({
    data: {
      codeHash: sha256(code).toString("hex"),
      userId: input.userId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: normalizeExtensionScope(input.scope),
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
}): Promise<{ userId: string; scope: string; provenance: ExtensionAuthProvenance }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  if (typeof input.code !== "string" || input.code.length < 10 || input.code.length > EXTENSION_OAUTH_CODE_MAX_LENGTH) {
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
  // The row matched the hash of the WHOLE code, so this segment is exactly what
  // authorize issued. A code without one (issued before this change, at most a
  // minute old) carries no provenance and cannot mint a token.
  const provenance = decodeProvenanceFromCode(input.code);
  if (!provenance) throw new ExtensionOAuthError("CODE_INVALID_OR_USED", 400);
  return { userId: row.userId, scope: row.scope, provenance };
}
