/**
 * The API host's storage adapter for the canonical destruction executor.
 *
 * Deliberately tiny, and deliberately NOT a decision surface. Since 2026-09-29
 * the executor speaks object VERSIONS (a key-only delete on an Object Lock
 * bucket writes a delete marker and leaves the locked version), so the adapter
 * is the shared version-aware port bound to this process's S3 client. The
 * executor in `@proovra/shared-runtime` owns every rule about when a delete may
 * happen; this file owns only which client it runs on.
 */
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import {
  createVersionAwareDestructionPort,
  type EvidenceDestructionStoragePort,
} from "@proovra/shared-runtime";

import { s3 } from "../../storage.js";

export const apiEvidenceDestructionStorage: EvidenceDestructionStoragePort =
  createVersionAwareDestructionPort({
    client: s3,
    ListObjectVersionsCommand: ListObjectVersionsCommand as never,
    HeadObjectCommand: HeadObjectCommand as never,
    DeleteObjectCommand: DeleteObjectCommand as never,
  });
