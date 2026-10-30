import { Worker } from "node:worker_threads";

/**
 * The capability-map generator's `build()`, run on a worker THREAD.
 *
 * `build()` is synchronous: it parses ~1,700 source files through the compiler
 * API, 96–125s on a fast machine and longer on a 4-vCPU runner. Called on the
 * vitest worker it blocks that thread for all of it, and a runner
 * `onTaskUpdate` RPC sent just before it started cannot be answered: when the
 * thread resumes, the timers phase runs before the reply is read, birpc's
 * FIXED 60s timeout fires, and vitest reports
 *
 *     [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * as an unhandled error over a run in which every test passed. Whether an RPC
 * is in flight at that moment is timing, which is why it failed some runs and
 * not others. The same defect was fixed for the audit engine by awaiting its
 * child process (phase-0-audit-engine-governance); this is that fix for the
 * in-process generator. Same `build()`, same result, the event loop stays free.
 */
export function buildCapabilityMapOffThread<T = unknown>(): Promise<T> {
  const generator = new URL("../../scripts/generate-runtime-capability-map.mjs", import.meta.url).href;
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       import(workerData).then((m) => parentPort.postMessage(m.build()));`,
      { eval: true, workerData: generator },
    );
    worker.once("message", (map: T) => resolve(map));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`capability-map generator thread exited ${code}`));
    });
  });
}
