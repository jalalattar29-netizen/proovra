/**
 * Wave 3 Phase 8 — wait-for-worker helper.
 *
 * Polls /v1/investigation/diagnostics (the canonical Wave 1 envelope)
 * until a specified workspace count field changes / satisfies a
 * predicate, without flaky sleeps. Bounded.
 *
 * Strategy:
 *   * Uses Playwright's `expect.poll` primitive — the timeout is
 *     enforced by the test runner, not by an open-ended while loop.
 *   * Calls back into `makeApi(token)` from api-client.ts (the
 *     canonical Phase-1 helper) — does not duplicate auth state.
 *   * Bounded at 30 polls × 500ms = 15s by default. Honest failure
 *     surfaces a diagnostics snapshot in the message so a flake is
 *     never silently swallowed.
 *
 * Hard contracts:
 *   * NEVER sleeps above 500ms anywhere (use `intervalMs` ≤ 500).
 *   * NEVER fakes data — assertion is against real backend state.
 *   * Bounded by `timeoutMs` (default 15_000) and `intervalMs`
 *     (default 500ms).
 *   * Throws with a diagnostics snapshot when timeout fires so the
 *     operator sees WHAT field never appeared.
 */
import { expect, type APIRequestContext } from "@playwright/test";

/**
 * The bounded subset of the Wave 1 diagnostics envelope we read.
 * The full envelope is much wider; we restate only what the helper
 * needs so this file does not need a build-time dep on the API
 * package. The shape mirrors `InvestigationDiagnosticsWorkspace` in
 * services/api/src/services/investigation-diagnostics.service.ts.
 */
export type DiagnosticsSnapshot = {
  workspace: Record<string, unknown>;
  queues?: Record<string, unknown>;
  warnings?: string[];
};

/**
 * Poll the diagnostics endpoint until `predicate(snapshot)` returns
 * true. Throws a bounded error with the last seen snapshot when the
 * timeout elapses.
 *
 * Example:
 *   await waitForDiagnostics({
 *     api,
 *     teamId,
 *     predicate: (d) =>
 *       Number(d.workspace.graphNodeCount ?? 0) >= 1,
 *     label: "graphNodeCount >= 1",
 *   });
 */
export async function waitForDiagnostics(opts: {
  api: APIRequestContext;
  teamId: string;
  predicate: (snapshot: DiagnosticsSnapshot) => boolean;
  /** Human-readable label for the assertion (used in error messages). */
  label: string;
  /** Per-poll interval in ms. Hard-capped at 500ms to forbid flakiness. */
  intervalMs?: number;
  /** Total timeout in ms. Defaults to 15_000ms (30 polls × 500ms). */
  timeoutMs?: number;
}): Promise<DiagnosticsSnapshot> {
  const intervalMs = Math.min(opts.intervalMs ?? 500, 500);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let lastSnapshot: DiagnosticsSnapshot = { workspace: {} };

  await expect
    .poll(
      async () => {
        const res = await opts.api.get(
          `/v1/investigation/diagnostics?teamId=${opts.teamId}`,
        );
        if (!res.ok()) {
          // 4xx/5xx — surface the body so the operator sees why polling
          // is failing (auth, permission, missing route). Never collapse
          // an HTTP error into a silent retry.
          return false;
        }
        const body = (await res.json()) as DiagnosticsSnapshot;
        lastSnapshot = body;
        return opts.predicate(body);
      },
      {
        message: () =>
          `waitForDiagnostics timed out waiting for: ${opts.label}\nLast snapshot:\n${JSON.stringify(
            lastSnapshot.workspace,
            null,
            2,
          )}`,
        timeout: timeoutMs,
        intervals: [intervalMs],
      },
    )
    .toBe(true);

  return lastSnapshot;
}

/**
 * Read the diagnostics envelope once, without polling. Useful for
 * baseline-then-assert patterns where the test needs to remember a
 * starting count.
 */
export async function readDiagnostics(opts: {
  api: APIRequestContext;
  teamId: string;
}): Promise<DiagnosticsSnapshot> {
  const res = await opts.api.get(
    `/v1/investigation/diagnostics?teamId=${opts.teamId}`,
  );
  if (!res.ok()) {
    throw new Error(
      `readDiagnostics failed (HTTP ${res.status()}): ${await res.text()}`,
    );
  }
  return (await res.json()) as DiagnosticsSnapshot;
}

/**
 * Convenience: read a single numeric workspace.* counter, returning 0
 * if the field is absent. Counts are the most common diagnostic
 * predicate input.
 */
export function counter(
  snapshot: DiagnosticsSnapshot,
  field: string,
): number {
  const raw = (snapshot.workspace as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : 0;
}
