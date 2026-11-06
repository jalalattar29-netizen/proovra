/**
 * PRO-034 (AUTH-28) — A GOOGLE OR APPLE ID_TOKEN SIGNS IN ONCE, FOR AN ATTEMPT
 * THIS API STARTED.
 *
 * The verifiers checked signature, audience, issuer and expiry only, so any
 * id_token minted for an allowed audience — replayed, minted for another flow
 * or app, carrying a nonce PROOVRA never issued, or issued a month ago — signed
 * in until it expired, and could be injected into a victim's browser (login
 * CSRF). Now:
 *
 *   1. Before the provider ceremony the client asks for a nonce
 *      (`POST /v1/auth/oauth/nonce`) and hands it to Google / Apple, which sign
 *      it into the id_token. Only its hash is stored, with a 10-minute life.
 *   2. The id_token must carry an issued, unexpired, unconsumed nonce for the
 *      same provider, and it is consumed in one guarded write: a replay, a
 *      foreign nonce and a second use all fail. A web nonce is also bound to an
 *      HTTP-only cookie in the browser that asked for it, so a token obtained in
 *      another browser cannot be injected into this one.
 *   3. The token's `iat` must be recent (the verifiers enforce the window).
 *
 * Native builds released before this change send no nonce. Their tokens are
 * refused unless the operator sets SOCIAL_NONCELESS_ID_TOKENS=accept for the
 * rollout window; even then only from non-web clients, and each such token is
 * still single-use (its hash is recorded) and inside the iat window.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { isProovraProductionRequest } from "../../http/cors-origin-policy.js";

export const SOCIAL_NONCE_TTL_SECONDS = 10 * 60;
export const SOCIAL_BIND_COOKIE = "proovra_oauth_bind";
export type SocialProvider = "GOOGLE" | "APPLE";

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function readCookie(req: FastifyRequest): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  const v = cookies?.[SOCIAL_BIND_COOKIE];
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

export function isWebClientRequest(req: FastifyRequest): boolean {
  return req.headers["x-web-client"] === "1";
}

/**
 * Issue a nonce for one sign-in or link attempt. A web client gets (or keeps)
 * one binding cookie per browser, so Google and Apple nonces issued side by
 * side share it.
 */
export async function issueSocialSignInNonce(
  req: FastifyRequest,
  reply: FastifyReply,
  provider: SocialProvider,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ nonce: string; expiresAt: Date }> {
  let bindingHash: string | null = null;
  if (isWebClientRequest(req)) {
    const secret = readCookie(req) ?? randomBytes(32).toString("base64url");
    bindingHash = sha256(`bind:${secret}`);
    const secure = isProovraProductionRequest(
      req.headers.host,
      typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    );
    reply.setCookie(SOCIAL_BIND_COOKIE, secret, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/v1",
      maxAge: SOCIAL_NONCE_TTL_SECONDS,
    });
  }
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SOCIAL_NONCE_TTL_SECONDS * 1000);
  await client.socialSignInNonce.create({
    data: { nonceHash: sha256(`nonce:${nonce}`), provider, purpose: "ISSUED", bindingHash, expiresAtUtc: expiresAt },
  });
  // Housekeeping: rows long past their expiry carry nothing anyone can use.
  await client.socialSignInNonce
    .deleteMany({ where: { expiresAtUtc: { lt: new Date(now.getTime() - 60 * 60 * 1000) } } })
    .catch(() => null);
  return { nonce, expiresAt };
}

export type IdTokenBindingRefusal = "nonce_required" | "nonce_invalid" | "token_replayed";

/**
 * Consume the attempt an id_token answers. Call after the provider verifier
 * accepted the token (signature, audience, issuer, exp, iat window).
 */
export async function bindIdTokenToAttempt(
  req: FastifyRequest,
  input: {
    provider: SocialProvider;
    idToken: string;
    claims: { nonce: string | null; iat: number; exp: number };
  },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: IdTokenBindingRefusal }> {
  const { nonce, iat, exp } = input.claims;
  if (nonce) {
    const cookie = readCookie(req);
    const claimed = await client.socialSignInNonce.updateMany({
      where: {
        nonceHash: sha256(`nonce:${nonce}`),
        provider: input.provider,
        purpose: "ISSUED",
        consumedAtUtc: null,
        expiresAtUtc: { gt: now },
        // A token cannot answer an attempt that began after it was issued.
        createdAtUtc: { lte: new Date((iat + 60) * 1000) },
        OR: [{ bindingHash: null }, ...(cookie ? [{ bindingHash: sha256(`bind:${cookie}`) }] : [])],
      },
      data: { consumedAtUtc: now },
    });
    return claimed.count === 1 ? { ok: true } : { ok: false, reason: "nonce_invalid" };
  }
  if (process.env["SOCIAL_NONCELESS_ID_TOKENS"] !== "accept" || isWebClientRequest(req)) {
    return { ok: false, reason: "nonce_required" };
  }
  try {
    await client.socialSignInNonce.create({
      data: {
        nonceHash: sha256(`token:${input.idToken}`),
        provider: input.provider,
        purpose: "TOKEN_USE",
        expiresAtUtc: new Date(exp * 1000),
        consumedAtUtc: now,
      },
    });
    return { ok: true };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "P2002") return { ok: false, reason: "token_replayed" };
    throw err;
  }
}
