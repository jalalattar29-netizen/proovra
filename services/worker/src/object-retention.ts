/**
 * THE EIGHT-YEAR CONTRACT, AS THE WORKER'S WRITERS ASK FOR IT (2026-10-15).
 *
 * Every file the worker writes for an evidence record — a report, a package,
 * a preview, a derivative, a screen-intelligence frame — is locked to that
 * record's FIXED retention horizon, resolved by the one resolver in
 * `@proovra/shared-runtime`. Never "now + eight years" (which would extend a
 * record's preservation on every regeneration) and never a duration of its own.
 * A record whose horizon has ended is refused (`RetentionHorizonEndedError`).
 */
import { RetentionHorizonEndedError } from "@proovra/shared";
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
 * LATEST horizon among them, in the strongest mode among them. A record whose
 * horizon has ended contributes nothing; when every record's has ended the
 * write is refused rather than given an invented horizon.
 */
export async function artifactLockForAll(evidenceIds: readonly string[]): Promise<ResolvedObjectLock | null> {
  let latest: ResolvedObjectLock | null = null;
  let compliance = false;
  let ended: unknown = null;
  for (const id of evidenceIds) {
    let lock: ResolvedObjectLock | null;
    try {
      lock = await artifactLockFor(id);
    } catch (err) {
      if (err instanceof RetentionHorizonEndedError) {
        ended = err;
        continue;
      }
      throw err;
    }
    if (!lock) continue;
    if (lock.mode === "COMPLIANCE") compliance = true;
    if (!latest || lock.retainUntil.getTime() > latest.retainUntil.getTime()) latest = lock;
  }
  if (latest) return { mode: compliance ? "COMPLIANCE" : latest.mode, retainUntil: latest.retainUntil };
  if (ended) throw ended;
  if (evidenceIds.length > 0) return null; // Object Lock disabled
  const fresh = newObjectLock();
  return fresh ? { mode: fresh.mode, retainUntil: fresh.retainUntil } : null;
}
