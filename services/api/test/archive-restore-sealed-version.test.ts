/**
 * GOV-016 — a restore and a tier read name the sealed version. By key alone they
 * reach the current version, which is not the sealed one once anything newer was
 * written to the key.
 */
import { HeadObjectCommand, RestoreObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { headObjectStorageClass, restoreObject, s3 } from "../src/storage.js";

afterEach(() => vi.restoreAllMocks());

describe("archive storage calls name the version", () => {
  it("restore sends the version id it is given, and none when there is none", async () => {
    const send = vi.spyOn(s3, "send").mockResolvedValue({} as never);
    await restoreObject({ bucket: "b", key: "k", versionId: "v-sealed", days: 3 });
    await restoreObject({ bucket: "b", key: "k" });
    const inputs = send.mock.calls.map(([cmd]) => (cmd as RestoreObjectCommand).input);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(RestoreObjectCommand);
    expect(inputs[0]).toMatchObject({ Bucket: "b", Key: "k", VersionId: "v-sealed" });
    expect(inputs[1]).not.toHaveProperty("VersionId");
  });

  it("the storage-class read asks about the sealed version", async () => {
    const send = vi.spyOn(s3, "send").mockResolvedValue({ StorageClass: "GLACIER" } as never);
    expect(await headObjectStorageClass({ bucket: "b", key: "k", versionId: "v-sealed" })).toBe("GLACIER");
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0]![0] as HeadObjectCommand).input).toMatchObject({ VersionId: "v-sealed" });
  });
});
