/**
 * VERSION-AWARE DESTRUCTION STORAGE (2026-09-29).
 *
 * THE DEFECT: the executor deleted each object by KEY and then verified with a
 * HEAD by KEY. On a versioned bucket — and every Object Lock bucket is
 * versioned — a key-only DeleteObject writes a delete marker and succeeds
 * even under COMPLIANCE retention; the locked version stays. The HEAD then
 * saw the marker, answered 404, and the executor minted a certificate saying
 * the bytes were gone while every locked version remained.
 *
 * THE PORT NOW SPEAKS VERSIONS:
 *   listObjectVersions(key)   every version and delete marker for EXACTLY that
 *                             key, with each data version's retain-until date
 *                             and legal-hold status read by VersionId;
 *   deleteObjectVersion(...)  a delete of ONE version by its VersionId.
 *
 * One implementation for both hosts; each injects its own S3 client and the
 * command constructors, because the two hosts configure storage separately.
 */
import type { EvidenceDestructionStoragePort, ObjectVersionInfo } from "./executor.js";

// Method syntax on purpose: parameters are compared bivariantly, so a real
// S3Client (whose send takes its own Command type) is accepted.
type S3Like = { send(command: never): Promise<unknown> };
type Ctor = new (input: Record<string, unknown>) => unknown;

export function createVersionAwareDestructionPort(deps: {
  client: S3Like;
  ListObjectVersionsCommand: Ctor;
  HeadObjectCommand: Ctor;
  DeleteObjectCommand: Ctor;
}): EvidenceDestructionStoragePort {
  const send = (command: unknown) => deps.client.send(command as never);
  return {
    async listObjectVersions({ bucket, key }) {
      const out: ObjectVersionInfo[] = [];
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const res = (await send(
          new deps.ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        )) as {
          Versions?: Array<{ Key?: string; VersionId?: string; IsLatest?: boolean }>;
          DeleteMarkers?: Array<{ Key?: string; VersionId?: string; IsLatest?: boolean }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextVersionIdMarker?: string;
        };
        for (const v of res.Versions ?? []) {
          if (v.Key !== key) continue; // Prefix matches longer keys too.
          const versionId = v.VersionId ?? "null";
          const head = (await send(
            new deps.HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
          )) as {
            ObjectLockRetainUntilDate?: Date;
            ObjectLockMode?: string;
            ObjectLockLegalHoldStatus?: string;
          };
          out.push({
            versionId,
            isDeleteMarker: false,
            isLatest: v.IsLatest === true,
            retainUntil: head.ObjectLockRetainUntilDate ?? null,
            lockMode: head.ObjectLockMode ?? null,
            legalHold: String(head.ObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON",
          });
        }
        for (const m of res.DeleteMarkers ?? []) {
          if (m.Key !== key) continue;
          out.push({
            versionId: m.VersionId ?? "null",
            isDeleteMarker: true,
            isLatest: m.IsLatest === true,
            retainUntil: null,
            lockMode: null,
            legalHold: false,
          });
        }
        if (!res.IsTruncated) return out;
        // A truncated page with no continuation is a PARTIAL inventory: the
        // versions not returned may carry a later retain-until or a legal
        // hold. Refuse rather than re-read page one or decide on a fragment.
        if (!res.NextKeyMarker && !res.NextVersionIdMarker) throw new Error("OBJECT_VERSION_LISTING_PARTIAL");
        keyMarker = res.NextKeyMarker;
        versionIdMarker = res.NextVersionIdMarker;
      }
      // A listing that never ends is not an inventory; the executor treats a
      // throw as "could not verify" and refuses to certify.
      throw new Error("OBJECT_VERSION_LISTING_UNBOUNDED");
    },
    async listKeysUnderPrefix({ bucket, prefix }) {
      const keys = new Set<string>();
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const res = (await send(
          new deps.ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        )) as {
          Versions?: Array<{ Key?: string }>;
          DeleteMarkers?: Array<{ Key?: string }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextVersionIdMarker?: string;
        };
        for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
          if (v.Key && v.Key.startsWith(prefix)) keys.add(v.Key);
        }
        if (!res.IsTruncated) return [...keys];
        if (!res.NextKeyMarker && !res.NextVersionIdMarker) throw new Error("OBJECT_PREFIX_LISTING_PARTIAL");
        keyMarker = res.NextKeyMarker;
        versionIdMarker = res.NextVersionIdMarker;
      }
      throw new Error("OBJECT_PREFIX_LISTING_UNBOUNDED");
    },
    async deleteObjectVersion({ bucket, key, versionId }) {
      try {
        await send(
          new deps.DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown_delete_error",
        };
      }
    },
  };
}

/**
 * VERSION-AWARE OBJECT REMOVAL FOR HOUSEKEEPING (2026-10-15, AUD-028).
 *
 * THE DEFECT: the worker's cleanup paths (capture reaper, staging reconciler,
 * exchange-package and screen-intelligence residue) deleted by KEY and
 * reported `deleted: true`. On a versioned / Object Lock bucket that writes a
 * delete marker and succeeds even under COMPLIANCE retention: the locked
 * version stays, now hidden behind the marker, and the caller counted it gone.
 *
 * This removes through the SAME port the destruction executor uses — every
 * delete names a VersionId — and then LISTS AGAIN to prove the postcondition.
 * A version under retention or legal hold is never attempted: it is reported
 * as retained. A key holding only delete markers stored nothing and is
 * reported as such, never as a deletion. `deleted` is true only when the key
 * had data and none of it remains.
 */
export type VersionedObjectRemoval = {
  /** Every targeted data version is verifiably gone (and there was one). */
  deleted: boolean;
  /** Data versions removed, as proven by the post-delete listing. */
  deletedVersions: number;
  /** Data versions kept because retention or a legal hold protects them (never attempted). */
  retainedVersions: number;
  /** The key held only delete markers: nothing was stored, nothing was removed. */
  deleteMarkerOnly: boolean;
  /** Versions whose removal failed or could not be verified (listing failures included). */
  failed: number;
};

export async function removeObjectVersions(
  port: Pick<EvidenceDestructionStoragePort, "listObjectVersions" | "deleteObjectVersion">,
  input: {
    bucket: string;
    key: string;
    /** Remove only this version (the one a caller wrote); otherwise every version of the key. */
    versionId?: string | null;
    now?: Date;
  },
): Promise<VersionedObjectRemoval> {
  const nowMs = (input.now ?? new Date()).getTime();
  const target = { bucket: input.bucket, key: input.key };
  const result: VersionedObjectRemoval = {
    deleted: false,
    deletedVersions: 0,
    retainedVersions: 0,
    deleteMarkerOnly: false,
    failed: 0,
  };
  let before: ObjectVersionInfo[];
  try {
    before = await port.listObjectVersions(target);
  } catch {
    result.failed = 1;
    return result;
  }
  const wanted = input.versionId?.trim() || null;
  const data = before.filter((v) => !v.isDeleteMarker && (wanted == null || v.versionId === wanted));
  const markers = before.filter((v) => v.isDeleteMarker);
  if (data.length === 0) {
    result.deleteMarkerOnly = wanted == null && markers.length > 0;
    return result;
  }
  const attempted = new Set<string>();
  for (const v of data) {
    const locked = v.legalHold || (v.retainUntil != null && v.retainUntil.getTime() > nowMs);
    if (locked) {
      result.retainedVersions += 1;
      continue;
    }
    const del = await port.deleteObjectVersion({ ...target, versionId: v.versionId });
    if (del.ok) attempted.add(v.versionId);
    else result.failed += 1;
  }
  // THE POSTCONDITION, answered by the store — not by the delete's 204.
  let after: ObjectVersionInfo[];
  try {
    after = await port.listObjectVersions(target);
  } catch {
    result.failed += attempted.size;
    return result;
  }
  const remaining = new Set(after.filter((v) => !v.isDeleteMarker).map((v) => v.versionId));
  for (const id of attempted) {
    if (remaining.has(id)) result.failed += 1;
    else result.deletedVersions += 1;
  }
  result.deleted = result.retainedVersions === 0 && result.failed === 0 && result.deletedVersions === data.length;
  // With no data left at the key, its delete markers are noise; remove them
  // by VersionId (best effort, never counted as a deletion).
  if (wanted == null && result.deleted && remaining.size === 0) {
    for (const m of after.filter((v) => v.isDeleteMarker)) {
      await port.deleteObjectVersion({ ...target, versionId: m.versionId }).catch(() => undefined);
    }
  }
  return result;
}
