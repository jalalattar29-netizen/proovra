/**
 * AUD-0023 — a storage call that stalls fails within its bounds.
 *
 * The S3 clients set no connection or socket timeout, so a call to a storage
 * endpoint that accepted the connection and then went quiet never failed (the
 * audit's worker waited 5 min 12 s). Here the "storage endpoint" is a local TCP
 * server that accepts and never answers; with S3_SOCKET_TIMEOUT_MS at 500 the
 * call must fail in about half a second instead of waiting.
 */
import { createServer, type Server, type Socket } from "node:net";

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";

const sockets: Socket[] = [];
const server: Server = createServer((socket) => {
  sockets.push(socket); // accept, read nothing, answer nothing
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.S3_ALLOW_INSECURE = "true";
process.env.S3_REGION = process.env.S3_REGION || "us-east-1";
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "test-access";
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || "test-secret";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.S3_SOCKET_TIMEOUT_MS = "500";
process.env.S3_CONNECTION_TIMEOUT_MS = "500";

// The client is built when the module loads, from the settings above.
const { s3, storageTimeoutMs } = await import("../src/storage.js");

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("AUD-0023 — S3 calls are bounded", () => {
  it("a call to an endpoint that never answers fails within the socket timeout", async () => {
    const t0 = Date.now();
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: "b", Key: "k" }), { abortSignal: AbortSignal.timeout(8_000) }),
    ).rejects.toBeTruthy();
    // Well inside the 8 s abort: the socket timeout ended it, retries included.
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 15_000);

  it("settings: positive milliseconds, or the default", () => {
    expect(storageTimeoutMs("750", 5_000)).toBe(750);
    expect(storageTimeoutMs(undefined, 5_000)).toBe(5_000);
    expect(storageTimeoutMs("0", 5_000)).toBe(5_000);
    expect(storageTimeoutMs("nope", 60_000)).toBe(60_000);
  });
});
