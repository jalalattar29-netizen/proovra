/**
 * AUD-011 follow-up — a store that accepts connections but never answers (a
 * paused or overloaded endpoint) must not hang the routes and read models that
 * probe a stored artifact.
 *
 * The CI storage-outage journey paused MinIO while the evidence status read
 * model probed the latest report: the SDK has no request timeout, so the HEAD
 * hung and the status endpoint with it. The probe is now bounded and answers
 * TRANSIENT — never "missing", never "available".
 *
 * Real sockets: a loopback TCP server that accepts and stays silent.
 */
import { createServer, type Server, type Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
const sockets = new Set<Socket>();
let port = 0;

beforeAll(async () => {
  server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    // Accept, read, never answer.
    s.on("data", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
});

async function loadStorageAgainstSilentStore() {
  vi.resetModules();
  vi.stubEnv("S3_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("S3_ACCESS_KEY", "probe-test");
  vi.stubEnv("S3_SECRET_KEY", "probe-test-secret");
  vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
  return import("../src/storage.js");
}

describe("probeStoredObject against a store that never answers", () => {
  it("answers TRANSIENT within its bound instead of hanging", async () => {
    const { probeStoredObject } = await loadStorageAgainstSilentStore();
    const started = Date.now();
    const probe = await probeStoredObject({ bucket: "b", key: "k", versionId: "v1", timeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(probe).toEqual({ state: "TRANSIENT" });
    expect(elapsed).toBeLessThan(5_000);
  });

  it("the default bound is finite and short enough for an interactive read", async () => {
    const { STORED_OBJECT_PROBE_TIMEOUT_MS } = await loadStorageAgainstSilentStore();
    expect(STORED_OBJECT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STORED_OBJECT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
