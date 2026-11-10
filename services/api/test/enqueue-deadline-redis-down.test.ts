/**
 * AUD-0057 — with Redis unreachable, an api producer answers within its
 * deadline instead of waiting on the connection's offline queue.
 *
 * Evidence completion awaited the search-index enqueue in its fan-out, and that
 * producer built its own queue with no deadline: with Redis stopped, a
 * completion committed the record and then gave no answer for minutes. Every
 * producer is now bounded by ENQUEUE_TIMEOUT_MS. Redis here is a closed port,
 * so the connection can never be established.
 */
import { afterAll, describe, expect, it } from "vitest";

// Static: both modules read REDIS_URL when they first enqueue, not on import.
import { withEnqueueDeadline } from "../src/queue/canonical-queue-client.js";
import { enqueueSearchIndexingJob } from "../src/queue/search-queue.js";

const env = { url: process.env.REDIS_URL, timeout: process.env.ENQUEUE_TIMEOUT_MS };

// Set inside each test: the safe-environment hook re-pins REDIS_URL to the
// local Redis before every test.
function redisDown() {
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  process.env.ENQUEUE_TIMEOUT_MS = "600";
}

afterAll(() => {
  if (env.url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = env.url;
  if (env.timeout === undefined) delete process.env.ENQUEUE_TIMEOUT_MS;
  else process.env.ENQUEUE_TIMEOUT_MS = env.timeout;
});

describe("AUD-0057 — enqueue answers within its deadline while Redis is down", () => {
  it("the search-index producer (completion fan-out) settles as queue_unavailable", async () => {
    redisDown();
    const t0 = Date.now();
    const outcome = await enqueueSearchIndexingJob({
      kind: "evidence",
      sourceId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      reason: "aud-0057",
    } as never);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ enqueued: false });
    expect(String((outcome as { reason: string }).reason)).toMatch(/^queue_unavailable/);
  }, 15_000);

  it("the shared deadline resolves a never-settling enqueue as a timeout", async () => {
    redisDown();
    const t0 = Date.now();
    const outcome = await withEnqueueDeadline(new Promise(() => {}));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(outcome).toEqual({ enqueued: false, reason: "queue_unavailable:timeout" });
  }, 10_000);
});
