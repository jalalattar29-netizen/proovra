/**
 * An in-memory destruction storage port that speaks VERSIONS (2026-09-29).
 *
 * The executor no longer deletes by key and checks by key: it inventories every
 * version, refuses when any is retained, deletes each by VersionId and verifies
 * that none remain. Test stores model one data version per key ("v1"); a store
 * can mark keys that refuse deletion, that silently survive a delete (the
 * versioned-bucket trap), or that are under retention until a date.
 */
import type { EvidenceDestructionStoragePort, ObjectVersionInfo } from "@proovra/shared-runtime";

export function versionedDestructionPort(store: {
  exists(id: string): boolean;
  remove(id: string): void;
  refuse?: (id: string) => boolean;
  survive?: (id: string) => boolean;
  retainUntil?: (id: string) => Date | null;
  onDelete?: (id: string) => void;
  /** Every stored id (bucket/key), for prefix listing (2026-09-29, H2). */
  ids?: () => string[];
}): EvidenceDestructionStoragePort {
  return {
    async listObjectVersions({ bucket, key }) {
      const id = `${bucket}/${key}`;
      if (!store.exists(id)) return [];
      const v: ObjectVersionInfo = {
        versionId: "v1",
        isDeleteMarker: false,
        isLatest: true,
        retainUntil: store.retainUntil?.(id) ?? null,
        lockMode: store.retainUntil?.(id) ? "COMPLIANCE" : null,
        legalHold: false,
      };
      return [v];
    },
    ...(store.ids
      ? {
          async listKeysUnderPrefix({ bucket, prefix }: { bucket: string; prefix: string }) {
            return store.ids!()
              .filter((id) => id.startsWith(`${bucket}/${prefix}`))
              .map((id) => id.slice(bucket.length + 1));
          },
        }
      : {}),
    async deleteObjectVersion({ bucket, key }) {
      const id = `${bucket}/${key}`;
      store.onDelete?.(id);
      if (store.refuse?.(id)) return { ok: false, error: "AccessDenied" };
      if (store.survive?.(id)) return { ok: true };
      store.remove(id);
      return { ok: true };
    },
  };
}
