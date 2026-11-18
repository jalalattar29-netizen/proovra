/**
 * THE WORKER'S HALF OF THE SIGNING BOUNDARY.
 *
 * An operator revokes a signer in the Admin console, which writes
 * `signer_control_state` in PostgreSQL. The API refuses to sign with it from
 * that moment. The worker must refuse too, and for a reason the API side does
 * not have to worry about: the worker executes jobs that were QUEUED EARLIER.
 *
 * A report generation job enqueued at 10:00 and executed at 10:05, with a
 * revocation at 10:02, must not sign. That is only true if the status is read
 * at EXECUTION time, from the database, on every job — never from a value
 * captured when the job was created and never from a process-lifetime cache.
 * A worker that cached this on boot would keep signing with a revoked key until
 * someone thought to restart it, which is the failure this whole change exists
 * to remove.
 */

import { isKeyIdentityCompromised, signerProviderToken } from "@proovra/shared-runtime";
import { prisma } from "../db.js";

export type WorkerSignerPurpose =
  | "report_pdf"
  | "verification_package"
  | "export_manifest"
  | "custody_event";

export class SignerRevokedError extends Error {
  readonly code = "signer_not_usable";
  constructor(
    readonly signerId: string,
    readonly status: string,
  ) {
    super(`Signer ${signerId} is ${status} and may not be used for new signatures.`);
    this.name = "SignerRevokedError";
  }
}

/**
 * B7A-F-006 — the key this worker would sign with is held by material PROOVRA
 * declared compromised (`signing_keys.revoked_at`, under any identity or
 * purpose). TERMINAL: retrying cannot make that key trustworthy, so the
 * request fails with this bounded reason instead of being retried — and no
 * report or package is issued, signed or sealed by compromised material. The
 * API's replacement offer reads the API process's signing env
 * (`replacementSignersUsable`); this is the worker's own re-check of the env
 * it actually signs with, at execution time.
 */
export class SigningKeyCompromisedError extends Error {
  readonly code = "SIGNING_KEY_COMPROMISED" as const;
  readonly retriable = false as const;
  constructor(
    readonly signerId: string,
    readonly purpose: WorkerSignerPurpose,
  ) {
    super(`SIGNING_KEY_COMPROMISED: the ${purpose} signing key was declared compromised and may not sign.`);
    this.name = "SigningKeyCompromisedError";
  }
}

function envKeyIdentity(purpose: WorkerSignerPurpose): { keyId: string; version: number } | null {
  const keyId =
    purpose === "verification_package"
      ? envValue("PACKAGE_SIGNING_KEY_ID") ?? envValue("SIGNING_KEY_ID")
      : envValue("SIGNING_KEY_ID");
  const version = Number(
    purpose === "verification_package"
      ? envValue("PACKAGE_SIGNING_KEY_VERSION") ?? envValue("SIGNING_KEY_VERSION")
      : envValue("SIGNING_KEY_VERSION"),
  );
  return keyId && Number.isInteger(version) && version >= 1 ? { keyId, version } : null;
}

function envValue(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : null;
}

/** Must match `buildSignerId` in the API's signer registry, exactly. */
function providerToken(): string {
  return signerProviderToken(process.env.SIGNER_PROVIDER);
}

export function workerSignerId(purpose: WorkerSignerPurpose): string {
  const keyId =
    purpose === "verification_package"
      ? envValue("PACKAGE_SIGNING_KEY_ID") ?? envValue("SIGNING_KEY_ID")
      : envValue("SIGNING_KEY_ID");
  const keyVersion =
    purpose === "verification_package"
      ? envValue("PACKAGE_SIGNING_KEY_VERSION") ?? envValue("SIGNING_KEY_VERSION")
      : envValue("SIGNING_KEY_VERSION");
  return `${purpose}:${providerToken()}:${keyId ?? "_"}:${keyVersion ?? "_"}`;
}

/**
 * Throws when the signer for this purpose has been retired or revoked.
 * A signer with no row is ACTIVE — the discovery default, so a deployment that
 * has never opened the console keeps working.
 */
export async function assertWorkerSignerUsable(
  purpose: WorkerSignerPurpose,
): Promise<void> {
  const signerId = workerSignerId(purpose);
  const row = await prisma.signerControlState.findUnique({
    where: { signerId },
    select: { status: true },
  });
  const status = row?.status ?? "ACTIVE";
  if (status !== "ACTIVE") throw new SignerRevokedError(signerId, status);
  // B7A-F-006 — and its key is not compromised material (read now, from the
  // registry every verifier reads; never cached).
  const identity = envKeyIdentity(purpose);
  if (identity && (await isKeyIdentityCompromised(prisma as never, identity))) {
    throw new SigningKeyCompromisedError(signerId, purpose);
  }
}
