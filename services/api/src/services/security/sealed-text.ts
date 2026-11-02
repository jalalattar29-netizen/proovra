/**
 * SECRET TEXT AT REST (IDENT-002, IDENT-021).
 *
 * The same AES-256-GCM envelope MFA secrets use, for secrets the runtime has to
 * read back as text: an OIDC client secret and a SAML SP signing key. A one-way
 * hash cannot sign in to an IdP. One text column holds the whole envelope, and
 * the prefix says which form a stored value is in, so a value written before
 * sealing keeps working until it is next replaced.
 */
import { openSecret, sealSecret } from "./mfa-secret-storage.js";

const PREFIX = "sealed.v1";

export function isSealedText(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

export function sealText(plaintext: string): string {
  const sealed = sealSecret(Buffer.from(plaintext, "utf8"));
  const part = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  return [
    PREFIX,
    Buffer.from(sealed.kekId, "utf8").toString("base64url"),
    part(sealed.iv),
    part(sealed.authTag),
    part(sealed.ciphertext),
  ].join(".");
}

/** Throws on a tampered envelope or the wrong key. Never returns garbage. */
export function openSealedText(value: string): string {
  const parts = value.split(".");
  // "sealed", "v1", then kek id, iv, tag and ciphertext.
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== PREFIX) {
    throw new Error("sealed text: not a sealed value");
  }
  const [, , kekId, iv, authTag, ciphertext] = parts as [string, string, string, string, string, string];
  return openSecret({
    kekId: Buffer.from(kekId, "base64url").toString("utf8"),
    iv: Buffer.from(iv, "base64url"),
    authTag: Buffer.from(authTag, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
  }).toString("utf8");
}
