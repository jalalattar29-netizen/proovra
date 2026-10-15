/**
 * THE EIGHT-YEAR CONTRACT, AS THE WORKER'S WRITERS ASK FOR IT (2026-10-15).
 *
 * Every file the worker writes for an evidence record — a report, a package,
 * a preview, a derivative, a screen-intelligence frame — is locked to that
 * record's FIXED retention horizon, resolved by the one resolver in
 * `@proovra/shared-runtime`. Never "now + eight years" (which would extend a
 * record's preservation on every regeneration) and never a duration of its own.
 */
import { resolveEvidenceObjectRetention, newObjectLock } from "@proovra/shared-runtime";

import { prisma } from "./db.js";
import type { ResolvedObjectLock } from "./storage.js";

/** The ARTIFACT lock for one record; null when Object Lock is disabled. */
export async function artifactLockFor(evidenceId: string): Promise<ResolvedObjectLock | null> {
  const r = await resolveEvidenceObjectRetention(prisma, evidenceId, { kind: "ARTIFACT" });
  return r ? { mode: r.mode, retainUntil: r.retainUntil } : null;
}

/**
 * A file that serves several records (an exchange package): locked to the
 * LATEST horizon among them, so it never outlives none of them early.
 */
export async function artifactLockForAll(evidenceIds: readonly string[]): Promise<ResolvedObjectLock | null> {
  let latest: ResolvedObjectLock | null = null;
  for (const id of evidenceIds) {
    const lock = await artifactLockFor(id);
    if (lock && (!latest || lock.retainUntil.getTime() > latest.retainUntil.getTime())) latest = lock;
  }
  if (latest) return latest;
  const fresh = newObjectLock();
  return fresh ? { mode: fresh.mode, retainUntil: fresh.retainUntil } : null;
}
