/**
 * The API host's storage adapter for the canonical destruction executor.
 *
 * Deliberately tiny, and deliberately NOT a decision surface: it translates two
 * operations onto this process's configured S3 client and nothing else. The
 * executor in `@proovra/shared-runtime` owns every rule about when a delete may
 * happen; this file owns only how a delete is spelled here.
 */

import {
  deleteObject as s3DeleteObject,
  headObject as s3HeadObject,
} from "../../storage.js";
import type { EvidenceDestructionStoragePort } from "@proovra/shared-runtime";

/**
 * True when the store still holds the object.
 *
 * The catch is narrow ON PURPOSE. A genuine "not found" is the only error that
 * proves absence; every other failure — a network error, a permission error, a
 * throttle — proves nothing, and this function is the input to a decision about
 * whether it is honest to certify that bytes are gone. Anything unrecognised is
 * re-thrown, and the executor treats a throw as "still there", which refuses the
 * certificate. Refusing a lawful destruction costs a retry; certifying an
 * unperformed one is a false record.
 */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const code = (err as { Code?: string; code?: string })?.Code ?? (err as { code?: string })?.code ?? "";
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

export const apiEvidenceDestructionStorage: EvidenceDestructionStoragePort = {
  async deleteObject(input) {
    return s3DeleteObject(input);
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
