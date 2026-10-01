/**
 * UC-DER-006 (version half) — putObjectBuffer returns the VersionId the store
 * assigned, so a producer can record the exact object version it wrote.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  env: { S3_ENDPOINT: "http://127.0.0.1:1", S3_REGION: "us-east-1", S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s", S3_BUCKET: "b" },
}));

const storage = await import("../src/storage.js");

describe("putObjectBuffer", () => {
  it("returns { versionId } from the PutObject response", async () => {
    const send = vi.spyOn(storage.s3, "send").mockResolvedValue({ VersionId: "v-123" } as never);
    await expect(
      storage.putObjectBuffer({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" }),
    ).resolves.toEqual({ versionId: "v-123" });
    send.mockResolvedValue({} as never);
    await expect(
      storage.putObjectBuffer({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" }),
    ).resolves.toEqual({ versionId: null });
    send.mockRestore();
  });
});
