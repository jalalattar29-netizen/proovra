/**
 * AUD-41 (2026-10-20) — the worker's Sentry filter drops a refused connection
 * ONLY when it is the configured Redis endpoint. A refused TSA, S3 or database
 * connection is an outage an operator must see.
 */
import { afterEach, describe, expect, it } from "vitest";

import { isRedisEndpointRefusal, workerSentryBeforeSend } from "../src/sentry.js";

const before = process.env.REDIS_URL;
afterEach(() => {
  if (before === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = before;
});

const send = (message: string) => workerSentryBeforeSend({ message: "e" }, { originalException: new Error(message) });

describe("AUD-41 Sentry ECONNREFUSED scope", () => {
  it("drops a refusal from the configured Redis endpoint", () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    expect(isRedisEndpointRefusal("connect ECONNREFUSED 127.0.0.1:6379")).toBe(true);
    expect(send("connect ECONNREFUSED 127.0.0.1:6379")).toBeNull();
    process.env.REDIS_URL = "redis://redis.internal:6380";
    expect(send("connect ECONNREFUSED redis.internal:6380")).toBeNull();
  });

  it("keeps a refused TSA, S3 or database connection", () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    for (const m of [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "connect ECONNREFUSED 10.0.0.7:443",
      "connect ECONNREFUSED 127.0.0.1:9000",
      "ECONNREFUSED",
    ]) {
      expect(isRedisEndpointRefusal(m)).toBe(false);
      expect(send(m)).not.toBeNull();
    }
  });

  it("keeps every refusal when no Redis endpoint is configured", () => {
    delete process.env.REDIS_URL;
    expect(send("connect ECONNREFUSED 127.0.0.1:6379")).not.toBeNull();
  });

  it("still drops the ioredis-only connection-state messages", () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    expect(send("Connection is closed.")).toBeNull();
    expect(send("Stream isn't writeable and enableOfflineQueue options is false")).toBeNull();
  });
});
