import { createPublicKey, createVerify } from "node:crypto";
import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { prisma } from "../db.js";
import * as prismaPkg from "@prisma/client";

type AuthProfile = {
  provider: prismaPkg.AuthProvider;
  providerUserId: string;
  email?: string | null;
  displayName?: string | null;
};

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };

let googleJwksCache: Jwk[] | null = null;
let appleJwksCache: Jwk[] | null = null;

async function fetchJwks(url: string): Promise<Jwk[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${url}`);
  const data = (await res.json()) as { keys: Jwk[] };
  return data.keys;
}

function decodeBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(input.length / 4) * 4,
    "="
  );
  return Buffer.from(padded, "base64");
}

function parseJwt(token: string) {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error("Invalid JWT format");
  }
  const header = JSON.parse(decodeBase64Url(headerB64).toString("utf8")) as {
    kid?: string;
    alg?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error("Unsupported JWT alg");
  }
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString("utf8")) as {
    sub?: string;
    aud?: string | string[];
    iss?: string;
    exp?: number;
    email?: string;
    name?: string;
  };
  return { header, payload, signatureB64, signingInput: `${headerB64}.${payloadB64}` };
}

function verifyJwtSignature(jwk: Jwk, signingInput: string, signatureB64: string) {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const signature = decodeBase64Url(signatureB64);
  return verifier.verify(key, signature);
}

function assertAudience(payloadAud: string | string[] | undefined, expected: string) {
  if (!payloadAud) throw new Error("Missing aud");
  const values = Array.isArray(payloadAud) ? payloadAud : [payloadAud];
  if (!values.includes(expected)) throw new Error("Invalid aud");
}

function assertIssuer(payloadIss: string | undefined, expected: string | string[]) {
  const issuers = Array.isArray(expected) ? expected : [expected];
  if (!payloadIss || !issuers.includes(payloadIss)) throw new Error("Invalid iss");
}

function assertNotExpired(payloadExp: number | undefined) {
  if (!payloadExp) throw new Error("Missing exp");
  if (Date.now() / 1000 >= payloadExp) throw new Error("Token expired");
}

export async function verifyGoogleIdToken(idToken: string): Promise<AuthProfile> {
  if (!googleJwksCache) {
    googleJwksCache = await fetchJwks("https://www.googleapis.com/oauth2/v3/certs");
  }
  const { header, payload, signatureB64, signingInput } = parseJwt(idToken);
  let jwk = googleJwksCache.find((key) => key.kid === header.kid);
  if (!jwk) {
    googleJwksCache = await fetchJwks("https://www.googleapis.com/oauth2/v3/certs");
    jwk = googleJwksCache.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("Unknown key id");
  if (!verifyJwtSignature(jwk, signingInput, signatureB64)) {
    throw new Error("Invalid signature");
  }
  assertAudience(payload.aud, must("GOOGLE_CLIENT_ID"));
  assertIssuer(payload.iss, ["https://accounts.google.com", "accounts.google.com"]);
  assertNotExpired(payload.exp);
  return {
    provider: prismaPkg.AuthProvider.GOOGLE,
    providerUserId: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    displayName: payload.name ? String(payload.name) : null
  };
}

export async function verifyAppleIdToken(idToken: string): Promise<AuthProfile> {
  if (!appleJwksCache) {
    try {
      appleJwksCache = await fetchJwks("https://appleid.apple.com/auth/keys");
    } catch {
      throw new Error("apple_jwks_fetch_failed");
    }
  }
  const { header, payload, signatureB64, signingInput } = parseJwt(idToken);
  let jwk = appleJwksCache.find((key) => key.kid === header.kid);
  if (!jwk) {
    try {
      appleJwksCache = await fetchJwks("https://appleid.apple.com/auth/keys");
    } catch {
      throw new Error("apple_jwks_fetch_failed");
    }
    jwk = appleJwksCache.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("Unknown key id");
  if (!verifyJwtSignature(jwk, signingInput, signatureB64)) {
    throw new Error("invalid_id_token");
  }
  try {
    assertAudience(payload.aud, must("APPLE_CLIENT_ID"));
    assertIssuer(payload.iss, "https://appleid.apple.com");
    assertNotExpired(payload.exp);
  } catch {
    throw new Error("invalid_id_token");
  }
  return {
    provider: prismaPkg.AuthProvider.APPLE,
    providerUserId: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    displayName: payload.name ? String(payload.name) : null
  };
}

function normalizeApplePrivateKey(raw: string) {
  if (raw.includes("\\n")) {
    return raw.replace(/\\n/g, "\n");
  }
  return raw;
}

export async function createAppleClientSecret(): Promise<string> {
  const teamId = must("APPLE_TEAM_ID");
  const keyId = must("APPLE_KEY_ID");
  const clientId = must("APPLE_CLIENT_ID");
  const privateKey = normalizeApplePrivateKey(must("APPLE_PRIVATE_KEY"));

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 24 * 180;
  const key = await importPKCS8(privateKey, "ES256");

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setAudience("https://appleid.apple.com")
    .setIssuer(teamId)
    .setSubject(clientId)
    .sign(key);
}

export async function exchangeAppleCodeForIdToken(code: string): Promise<string> {
  const clientId = must("APPLE_CLIENT_ID");
  const redirectUri = must("APPLE_REDIRECT_URI");
  const clientSecret = await createAppleClientSecret();

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("redirect_uri", redirectUri);

  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const json = (await res.json()) as { id_token?: string; error?: string };
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new Error("invalid_code");
    throw new Error("token_exchange_failed");
  }
  if (!json.id_token) throw new Error("token_exchange_failed");
  return json.id_token;
}

export async function createGuestProfile(): Promise<AuthProfile> {
  return {
    provider: prismaPkg.AuthProvider.GUEST,
    providerUserId: randomUUID(),
    email: null,
    displayName: "Guest"
  };
}

export async function ensureGuestIdentity(userId: string) {
  const existing = await prisma.guestIdentity.findUnique({
    where: { userId }
  });
  if (existing) return existing;
  return prisma.guestIdentity.create({
    data: { userId }
  });
}

export async function upsertUser(profile: AuthProfile) {
  return upsertUserWithEmailLink(profile);
}

export async function upsertUserWithEmailLink(profile: AuthProfile) {
  let user = await prisma.user.findUnique({
    where: {
      provider_providerUserId: {
        provider: profile.provider,
        providerUserId: profile.providerUserId
      }
    }
  });

  if (!user && profile.email) {
    const guest = await prisma.user.findFirst({
      where: { email: profile.email, provider: prismaPkg.AuthProvider.GUEST }
    });
    if (guest) {
      user = await prisma.user.update({
        where: { id: guest.id },
        data: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          displayName: profile.displayName ?? guest.displayName,
          email: profile.email ?? guest.email
        }
      });
    }
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        provider: profile.provider,
        providerUserId: profile.providerUserId,
        email: profile.email ?? null,
        displayName: profile.displayName ?? null
      }
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        email: profile.email ?? user.email,
        displayName: profile.displayName ?? user.displayName
      }
    });
  }

  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: user.id, active: true }
  });

  if (!entitlement) {
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        plan: prismaPkg.PlanType.FREE,
        credits: 0,
        teamSeats: 0,
        active: true
      }
    });
  }

  return user;
}
