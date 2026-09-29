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
