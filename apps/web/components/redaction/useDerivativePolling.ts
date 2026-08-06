"use client";

/**
 * Macro-Wave A1 — bounded derivative-render polling.
 *
 * While a redaction derivative is in flight (QUEUED / RENDERING) the
 * project workspace refreshes the projection on a fixed interval so the
 * operator sees QUEUED → RENDERING → READY/FAILED without reloading.
 *
 * Hard rules (PHASE 7 §10.F polling discipline):
 *   * The interval is disposed on unmount.
 *   * The interval stops as soon as no derivative is in flight.
 *   * The interval is keyed to the platform-context tenant generation
 *     (useTenantGuard) — a workspace switch mid-poll disposes the old
 *     interval; the caller's refresh() additionally stamps/discards
 *     stale responses so another tenant's data is never applied.
 */

import { useEffect, useRef } from "react";

import { useTenantGuard } from "../../lib/platform-context";

export const DERIVATIVE_POLL_INTERVAL_MS = 5000;

/** True when the derivative state means the worker still owes a result. */
export function isDerivativeInFlight(state: string | null | undefined): boolean {
  return state === "QUEUED" || state === "RENDERING";
}

export function useDerivativePolling(opts: {
  /** Poll only while true (some version's derivative is QUEUED/RENDERING). */
  active: boolean;
  /** Stable refresh callback — must itself guard against stale tenants. */
  refresh: () => void | Promise<void>;
  intervalMs?: number;
}): void {
  const { active, refresh } = opts;
  const intervalMs = opts.intervalMs ?? DERIVATIVE_POLL_INTERVAL_MS;
  // §10.3 — the surface being polled is bound to the tenant that mounted
  // it (the projectId belongs to ONE workspace). Capture the generation at
  // mount: the effect below is keyed on the live generation, so a
  // workspace switch disposes the running interval, and the mount-stamp
  // check refuses to start a NEW interval under the other tenant.
  const { generation } = useTenantGuard();
  const mountGenerationRef = useRef(generation);

  useEffect(() => {
    if (!active) return;
    if (generation !== mountGenerationRef.current) return; // tenant switched — stop
    const handle = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(handle);
  }, [active, refresh, intervalMs, generation]);
}
