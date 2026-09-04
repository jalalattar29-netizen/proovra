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

function envValue(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : null;
}

/** Must match `buildSignerId` in the API's signer registry, exactly. */
function providerToken(): string {
  const raw = (process.env.SIGNER_PROVIDER ?? "local_pem")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "aws_kms") return "aws_kms";
  if (raw === "disabled") return "disabled";
  return "local_pem";
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
}
