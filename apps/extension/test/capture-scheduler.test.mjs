/**
 * UC-EXT-003 — captureVisibleTab pacing. Chrome allows 2 calls per second
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); the full-page loop used to call it
 * every ~250 ms + capture time, and the third call's quota error aborted the
 * whole capture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_CAPTURE_INTERVAL_MS,
  createCaptureScheduler,
  isCaptureQuotaError,
  withQuotaRetry,
} from "./dist/capture-scheduler.js";

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

test("calls start at least 550 ms apart — never 3 inside one second", async () => {
  const clock = fakeClock();
  const s = createCaptureScheduler({ clock });
  const starts = [];
  for (let i = 0; i < 6; i += 1) {
    await s.schedule(async () => {
      starts.push(clock.now());
      clock.advance(40); // the capture itself is fast
    });
  }
  assert.ok(MIN_CAPTURE_INTERVAL_MS >= 500);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= MIN_CAPTURE_INTERVAL_MS, `gap ${starts[i] - starts[i - 1]}`);
  }
  for (let i = 2; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 2] >= 1000, "a third call inside one second would hit the quota");
  }
});

test("a lower requested interval cannot undercut the quota floor", async () => {
  const clock = fakeClock();
  const s = createCaptureScheduler({ clock, minIntervalMs: 100 });
  const starts = [];
  await s.schedule(async () => starts.push(clock.now()));
  await s.schedule(async () => starts.push(clock.now()));
  assert.ok(starts[1] - starts[0] >= MIN_CAPTURE_INTERVAL_MS);
});

test("concurrent callers are serialised through the same pacing", async () => {
  const clock = fakeClock();
  const s = createCaptureScheduler({ clock });
  const starts = [];
  await Promise.all([1, 2, 3].map(() => s.schedule(async () => starts.push(clock.now()))));
  assert.equal(starts.length, 3);
  assert.ok(starts[2] - starts[0] >= 2 * MIN_CAPTURE_INTERVAL_MS);
});

const QUOTA = new Error(
  "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.",
);

test("the quota error is retried with bounded backoff instead of aborting", async () => {
  const clock = fakeClock();
  let calls = 0;
  const out = await withQuotaRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw QUOTA;
      return "png";
    },
    { clock },
  );
  assert.equal(out, "png");
  assert.equal(calls, 3);
  assert.deepEqual(clock.sleeps, [600, 1200]);
});

test("retries are bounded: a persistent quota error is rethrown", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    withQuotaRetry(
      async () => {
        calls += 1;
        throw QUOTA;
      },
      { clock, retries: 3 },
    ),
    /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/,
  );
  assert.equal(calls, 4);
  assert.ok(clock.sleeps.every((ms) => ms <= 5000));
});

test("any other error is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    withQuotaRetry(async () => {
      calls += 1;
      throw new Error("Cannot access contents of the page");
    }, { clock: fakeClock() }),
  );
  assert.equal(calls, 1);
  assert.equal(isCaptureQuotaError(new Error("boom")), false);
  assert.equal(isCaptureQuotaError(QUOTA), true);
});
