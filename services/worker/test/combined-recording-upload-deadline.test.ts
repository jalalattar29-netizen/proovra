/**
 * PRO-W1C-08 — the combined-recording multipart upload is bounded by a
 * deadline. A stalled part is aborted when the deadline passes, no further
 * part and no completion are sent, and the multipart upload is aborted at the
 * store. The S3 transport is a stub that records the commands it is sent and
 * honours the SDK's `abortSignal` the way the real client does; the upload
 * code under test is the real `uploadFileMultipart`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  MIN_MULTIPART_PART_BYTES,
  MultipartUploadDeadlineExceeded,
  uploadFileMultipart,
} from "../src/combined-recording/multipart-upload.js";

type Sent = { name: string; aborted: boolean };

function stubClient(opts: { stallPart?: number } = {}) {
  const sent: Sent[] = [];
  const client = {
    send(command: { constructor: { name: string }; input: { PartNumber?: number } }, options?: { abortSignal?: AbortSignal }) {
      const name = command.constructor.name;
      const signal = options?.abortSignal;
      sent.push({ name, aborted: false });
      if (name === "CreateMultipartUploadCommand") return Promise.resolve({ UploadId: "up-1" });
      if (name === "UploadPartCommand") {
        if (command.input.PartNumber === opts.stallPart) {
          // A part that never answers: only the abort ends it.
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => {
              sent[sent.length - 1]!.aborted = true;
              reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
            });
          });
        }
        return Promise.resolve({ ETag: `"e${command.input.PartNumber}"` });
      }
      if (name === "CompleteMultipartUploadCommand") return Promise.resolve({ VersionId: "v1" });
      if (name === "AbortMultipartUploadCommand") return Promise.resolve({});
      return Promise.reject(new Error(`unexpected ${name}`));
    },
  };
  return { client: client as never, sent };
}

let dir = "";
let file = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "proovra-w1c08-"));
  file = path.join(dir, "combined.mp4");
  // Two full parts and a short third.
  await writeFile(file, randomBytes(MIN_MULTIPART_PART_BYTES * 2 + 1024));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const base = () => ({
  bucket: "b",
  key: "derived-assets/x.mp4",
  file,
  contentType: "video/mp4",
  partBytes: MIN_MULTIPART_PART_BYTES,
  lock: null,
  objectLockEnabled: false,
  maxBytes: 640 * 1024 * 1024,
});

describe("PRO-W1C-08 multipart upload deadline", () => {
  it("a part still in flight at the deadline is aborted, nothing more is sent, and the upload is aborted at the store", async () => {
    const { client, sent } = stubClient({ stallPart: 2 });
    const started = Date.now();
    await expect(uploadFileMultipart({ ...base(), client, deadlineAt: Date.now() + 150 })).rejects.toBeInstanceOf(
      MultipartUploadDeadlineExceeded,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sent.map((s) => s.name)).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "AbortMultipartUploadCommand",
    ]);
    expect(sent[2]!.aborted).toBe(true);
    expect(sent.some((s) => s.name === "CompleteMultipartUploadCommand")).toBe(false);
  });

  it("a deadline already passed sends nothing", async () => {
    const { client, sent } = stubClient();
    await expect(uploadFileMultipart({ ...base(), client, deadlineAt: Date.now() - 1 })).rejects.toThrow(
      "multipart_upload_deadline_exceeded",
    );
    expect(sent).toEqual([]);
  });

  it("an upload that finishes inside its deadline completes as before", async () => {
    const { client, sent } = stubClient();
    const res = await uploadFileMultipart({ ...base(), client, deadlineAt: Date.now() + 60_000 });
    expect(res).toMatchObject({ versionId: "v1", partCount: 3, sizeBytes: MIN_MULTIPART_PART_BYTES * 2 + 1024 });
    expect(sent.map((s) => s.name)).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
    ]);
  });

  it("without a deadline the upload is unbounded, as before", async () => {
    const { client } = stubClient();
    await expect(uploadFileMultipart({ ...base(), client })).resolves.toMatchObject({ partCount: 3 });
  });
});
