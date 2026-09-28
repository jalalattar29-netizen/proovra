/**
 * The worker host's storage adapter for the canonical destruction executor.
 *
 * Mirror of the API's adapter, against this process's S3 client: the shared
 * version-aware port (2026-09-29). The DECISION is shared, the client is not.
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

import { s3 } from "../storage.js";

export const workerEvidenceDestructionStorage: EvidenceDestructionStoragePort =
  createVersionAwareDestructionPort({
    client: s3,
    ListObjectVersionsCommand: ListObjectVersionsCommand as never,
    HeadObjectCommand: HeadObjectCommand as never,
    DeleteObjectCommand: DeleteObjectCommand as never,
  });
