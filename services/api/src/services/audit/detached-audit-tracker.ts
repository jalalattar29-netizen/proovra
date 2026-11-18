/**
 * PRO-S1-02 — DETACHED AUDIT APPENDS ARE ACCOUNTED FOR.
 *
 * About fifty call sites start an audit append without awaiting it
 * (`void emitPlatformAudit(...).catch(() => null)`), so the response is not
 * delayed. Three things were wrong with that:
 *
 *   1. a failure was swallowed with no counter, so a lost row was invisible;
 *   2. shutdown closed the pool without waiting for appends still running, so
 *      every deploy could cut rows that were seconds from committing;
 *   3. an identified sign-in outcome — evidence of account access — was as
 *      disposable as a page view.
 *
 * Every append the canonical facade (`emitTenantAudit` / `emitPlatformAudit`)
 * starts is registered here. A failed append is counted
 * (`platform_audit_append_failed_total`) and logged without identifiers.
 * Graceful shutdown awaits the pending set within its deadline, after the
 * server stopped taking requests and before the pool closes. A route can also
 * HOLD its response for a security-relevant append (`holdResponseForAudit`),
 * so the row is written — or its failure counted — before the client is told
 * the outcome, and the work is inside the overload gate's in-flight slot.
 *
 * No durable outbox is built here (the remediation brief rules that out): the
 * guarantee is "written, or counted as failed", never silence.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import { warn as logWarn } from "../../utils/logger.js";
import { bump } from "../ops/metrics.service.js";

const pending = new Set<Promise<unknown>>();
const stats = { started: 0, failed: 0 };

/** Register one append. Returns the same promise (caller handling unchanged). */
export function trackAuditAppend<T>(work: Promise<T>): Promise<T> {
  stats.started += 1;
  pending.add(work);
  work.then(
    () => {
      pending.delete(work);
    },
    (err: unknown) => {
      pending.delete(work);
      stats.failed += 1;
      bump("platform_audit_append_failed_total");
      logWarn("audit.append_failed", {
        errorName: err instanceof Error ? err.name : typeof err,
        errorCode: String((err as { code?: unknown } | null)?.code ?? "").slice(0, 64) || null,
      });
    },
  );
  return work;
}

export function detachedAuditStats(): { started: number; failed: number; pending: number } {
  return { ...stats, pending: pending.size };
}

/**
 * Await every append still running, up to `deadlineMs`. Never throws; reports
 * how many were still pending when the deadline passed (they are counted as
 * lost by the caller's log, not silently dropped).
 */
export async function drainPendingAuditAppends(
  deadlineMs: number,
): Promise<{ drained: boolean; stillPending: number }> {
  if (pending.size === 0) return { drained: true, stillPending: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineMs));
    (timer as { unref?: () => void }).unref?.();
  });
  const settled = Promise.allSettled([...pending]).then(() => "settled" as const);
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return { drained: result === "settled" && pending.size === 0, stillPending: pending.size };
}

const HELD = new WeakMap<object, Promise<unknown>[]>();

/**
 * Hold this request's response until `work` settles (success or counted
 * failure). Use for security-relevant appends only; the hook that honours it
 * is installed by {@link installAuditResponseHold} on the plugin that calls it.
 */
export function holdResponseForAudit(req: FastifyRequest, work: Promise<unknown>): void {
  const list = HELD.get(req) ?? [];
  list.push(work.catch(() => undefined));
  HELD.set(req, list);
}

export function installAuditResponseHold(app: FastifyInstance): void {
  app.addHook("onSend", async (req, _reply, payload) => {
    const list = HELD.get(req);
    if (list && list.length > 0) {
      HELD.delete(req);
      await Promise.all(list);
    }
    return payload;
  });
}

/** Test seam. */
export function __resetDetachedAuditTrackerForTests(): void {
  pending.clear();
  stats.started = 0;
  stats.failed = 0;
}
