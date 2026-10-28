/**
 * PASSKEYS IN THE BROWSER (2026-10-28) — the two WebAuthn ceremonies the web
 * app runs, wrapped so no caller has to know the library's error shapes.
 *
 *   getPasskeyAssertion(options)      — answer a step-up challenge
 *                                       (navigator.credentials.get)
 *   createPasskeyCredential(options)  — register a new passkey
 *                                       (navigator.credentials.create)
 *
 * Both take the server's options JSON VERBATIM and return the response JSON
 * the server verifies; nothing is interpreted here. The person dismissing the
 * system sheet (NotAllowedError — which is also what the browser reports when
 * the ceremony times out — or AbortError) is an ordinary outcome and comes
 * back as `{ status: "cancelled" }`, never as an exception, so a surface can
 * stay calm about it. "unsupported" means this browser has no WebAuthn at
 * all; "already_registered" (registration only) means the authenticator
 * already holds one of this account's passkeys; anything else is "error".
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

type Json = Record<string, unknown>;

export type PasskeyAssertionResult =
  | { status: "ok"; assertion: Json }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "error" };

export type PasskeyCreationResult =
  | { status: "ok"; credential: Json }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "already_registered" }
  | { status: "error" };

function errorNames(err: unknown): { code?: string; names: Array<string | undefined> } {
  const e = err as { name?: string; code?: string; cause?: { name?: string } } | null;
  return { code: e?.code, names: [e?.name, e?.cause?.name] };
}

function isCancellation(err: unknown): boolean {
  const { code, names } = errorNames(err);
  return code === "ERROR_CEREMONY_ABORTED" || names.includes("NotAllowedError") || names.includes("AbortError");
}

function supported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export async function getPasskeyAssertion(
  passkeyOptions: Record<string, unknown>,
): Promise<PasskeyAssertionResult> {
  if (!supported()) return { status: "unsupported" };
  try {
    const response = await startAuthentication({ optionsJSON: passkeyOptions as never });
    return { status: "ok", assertion: response as unknown as Json };
  } catch (err) {
    return isCancellation(err) ? { status: "cancelled" } : { status: "error" };
  }
}

export async function createPasskeyCredential(
  creationOptions: Record<string, unknown>,
): Promise<PasskeyCreationResult> {
  if (!supported()) return { status: "unsupported" };
  try {
    const response = await startRegistration({ optionsJSON: creationOptions as never });
    return { status: "ok", credential: response as unknown as Json };
  } catch (err) {
    if (isCancellation(err)) return { status: "cancelled" };
    const { code, names } = errorNames(err);
    if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || names.includes("InvalidStateError")) {
      return { status: "already_registered" };
    }
    return { status: "error" };
  }
}
