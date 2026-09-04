/**
 * A RESPONSE MUST NOT CARRY CREDENTIAL MATERIAL.
 *
 * Written because `POST /v1/auth/email/login` returned the user's scrypt
 * `passwordHash` in its 200 body for as long as the route existed. Nothing
 * failed, because nothing looked.
 *
 * The check is deliberately in two halves, and both are needed:
 *
 * KEYS, recursively, because that is the actual invariant — a secret reaches a
 * client as a FIELD, at any depth, and a key check cannot be fooled by prose.
 *
 * TEXT, as a backstop, because a secret can also arrive as a value under an
 * innocent key (`{ detail: "passwordHash=..." }`) or inside a message. Matched
 * narrowly, against the specific patterns that would indicate a real leak, so
 * that a body legitimately explaining "your password was changed" does not
 * fail.
 */

/**
 * Field names that may never appear in a response body.
 *
 * Matched case-insensitively against the WHOLE key, so `passwordHash` is
 * refused while `hasPassword`, `passwordUpdatedAt` and `requiresPassword` —
 * all legitimate, all boolean or timestamp facts ABOUT a credential rather
 * than the credential — are not.
 */
const FORBIDDEN_KEYS = [
  "passwordhash",
  "password",
  "passwordsalt",
  "mfasecret",
  "totpsecret",
  "otpsecret",
  "recoverycodes",
  "recoverycodehashes",
  "refreshtokenhash",
  "sessionhash",
  "verificationtoken",
  "resettoken",
  "passwordresettoken",
  "apisecret",
  "clientsecret",
  "privatekey",
];

/**
 * Values that betray a leak wherever they appear.
 *
 * `scrypt$` is the prefix this codebase's `hashPassword` emits, so its presence
 * anywhere in a body is a hash escaping regardless of the key that carried it.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /scrypt\$/i,
  /\$2[aby]\$\d{2}\$/, // bcrypt, in case a hash format ever changes
  /\bsk-[A-Za-z0-9_-]{16,}/, // an OpenAI-style key
];

function walk(node: unknown, path: string, hits: string[]): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, hits));
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      hits.push(here);
    }
    walk(value, here, hits);
  }
}

/**
 * Throw if `body` carries credential material at any depth.
 *
 * @param label names the response under test, so a failure says which route.
 */
export function assertNoCredentialMaterial(body: unknown, label: string): void {
  const keyHits: string[] = [];
  walk(body, "", keyHits);

  if (keyHits.length > 0) {
    throw new Error(
      `${label}: response carries credential field(s): ${keyHits.join(", ")}`,
    );
  }

  const serialized = JSON.stringify(body ?? null);
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(serialized)) {
      // The match itself is a secret, so it is described, never printed.
      throw new Error(
        `${label}: response body contains a value matching ${pattern} — a credential is leaking under a non-obvious key`,
      );
    }
  }
}

/** Exposed so a test can state the contract it is relying on. */
export const FORBIDDEN_CREDENTIAL_KEYS: readonly string[] = FORBIDDEN_KEYS;
