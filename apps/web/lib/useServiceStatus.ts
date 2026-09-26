"use client";

/**
 * THE ONE READER OF `GET /v1/runtime/status` IN THE WEB APP.
 *
 * Every surface that needs tenant service status — the header indicator, the
 * operator runtime pill, contextual notices beside an action — subscribes to
 * this store. One poll serves them all, so mounting three consumers on a page
 * costs one request per interval rather than three, and they can never show
 * three different answers for the same moment.
 *
 * The response is parsed by the shared `parseTenantServiceStatus`, the same
 * interpreter the native app uses.
 *
 * Polling: every 60s while at least one consumer is mounted; stops when the
 * last one unmounts. The first read waits for browser idle time (bounded at
 * 800ms) so status never competes with the page's own requests. A failed read
 * is `error: true` — never an all-clear.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  parseTenantServiceStatus,
  type TenantServiceStatus,
} from "@proovra/shared";

import { apiFetch } from "./api";

export const SERVICE_STATUS_PATH = "/v1/runtime/status";
export const SERVICE_STATUS_POLL_MS = 60_000;
const FIRST_READ_DEADLINE_MS = 800;

export type ServiceStatusSnapshot = {
  /** Null until the first successful read, and after a failed one. */
  status: TenantServiceStatus | null;
  /** The last read failed (network, 5xx). Consumers treat it as unknown. */
  error: boolean;
  /** At least one read has settled (success or failure). */
  settled: boolean;
};

const INITIAL: ServiceStatusSnapshot = { status: null, error: false, settled: false };

let snapshot: ServiceStatusSnapshot = INITIAL;
const listeners = new Set<() => void>();
let consumers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let firstPending = false;
let inFlight = false;

function emit(next: ServiceStatusSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export async function refreshServiceStatus(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const status = parseTenantServiceStatus(await apiFetch(SERVICE_STATUS_PATH));
    emit({ status, error: false, settled: true });
  } catch {
    emit({ status: null, error: true, settled: true });
  } finally {
    inFlight = false;
  }
}

function start() {
  if (timer) return;
  firstPending = true;
  const firstRun = () => {
    if (!firstPending) return;
    firstPending = false;
    if (consumers > 0) void refreshServiceStatus();
  };
  const idle = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") idle(firstRun, { timeout: FIRST_READ_DEADLINE_MS });
  else setTimeout(firstRun, 0);
  timer = setInterval(() => void refreshServiceStatus(), SERVICE_STATUS_POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  firstPending = false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to tenant service status. Every caller shares one poll. */
export function useServiceStatus(options?: { enabled?: boolean }): ServiceStatusSnapshot {
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    consumers += 1;
    start();
    return () => {
      consumers -= 1;
      if (consumers <= 0) {
        consumers = 0;
        stop();
      }
    };
  }, [enabled]);
  const current = useSyncExternalStore(subscribe, () => snapshot, () => INITIAL);
  return enabled ? current : INITIAL;
}

/** Tests only: forget every read and stop polling. */
export function resetServiceStatusForTests(): void {
  stop();
  consumers = 0;
  inFlight = false;
  snapshot = INITIAL;
  for (const l of listeners) l();
}
