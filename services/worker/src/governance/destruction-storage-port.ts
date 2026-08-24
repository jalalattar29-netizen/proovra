/**
 * The worker host's storage adapter for the canonical destruction executor.
 *
 * Mirror of the API's adapter, against this process's S3 client. The two hosts
 * configure storage independently, which is exactly why the executor takes a
 * port instead of importing one of them: the DECISION is shared, the client is
 * not.
 */

import {
  deleteObject as s3DeleteObject,
  headObject as s3HeadObject,
} from "../storage.js";
import type { EvidenceDestructionStoragePort } from "@proovra/shared-runtime";

/**
 * See the API adapter for why this catch is narrow: only a genuine "not found"
 * proves absence, and absence is what the destruction certificate attests to.
 * Every other error is re-thrown and read by the executor as "still there".
 */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const code =
    (err as { Code?: string })?.Code ?? (err as { code?: string })?.code ?? "";
  const status =
    (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode ?? 0;
  return (
    name === "NotFound" ||
    name === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchKey" ||
    status === 404
  );
}

export const workerEvidenceDestructionStorage: EvidenceDestructionStoragePort =
  {
    async deleteObject(input) {
      try {
        await s3DeleteObject(input);
        return { ok: true };
      } catch (err) {
        // The worker's `deleteObject` throws where the API's returns a result.
        // Normalising here rather than changing either client keeps this a
        // translation layer.
        if (isNotFound(err)) return { ok: true };
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message.slice(0, 200)
              : "unknown_delete_error",
        };
      }
    },
    async objectExists(input) {
      try {
        await s3HeadObject(input);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
