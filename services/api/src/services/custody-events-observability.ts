/**
 * Phase O-blockers / B-4 — observable custody-append failure handler.
 *
 * Multiple routes call `appendCustodyEvent(...)` as a best-effort,
 * non-blocking side-effect alongside their primary mutation. Prior to
 * this helper the failure handler was the silent
 *
 *   `appendCustodyEvent(...).catch(() => null)`
 *
 * pattern, which broke the tamper-evident promise: if the custody
 * append failed (DB outage, unique conflict, etc.) the surrounding
 * action still succeeded but no record of the failure existed
 * anywhere. Operators reviewing the custody chain could not
 * distinguish "no event" from "event swallowed".
 *
 * This helper preserves the non-blocking contract (the surrounding
 * mutation must NOT fail when custody append fails — Phase A0
 * integrity hard-gate handles real custody-on-finalize failure modes
 * separately) while producing three observable signals:
 *
 *   1. Bounded structured warn log (`custody.append.swallowed`).
 *   2. `custody_event_append_failed_total` counter bump.
 *   3. Optional Sentry capture via the shared sentry hook (gated to
 *      production by the existing sentry config — the wrapper is
 *      best-effort and never throws).
 *
 * Callers attach this as the rejection handler:
 *
 *   void appendCustodyEvent({...}).catch((err) =>
 *     swallowCustodyAppendError(err, {
 *       surface: "evidence.routes.ts:finalize",
 *       evidenceId,
 *     }),
 *   );
 *
 * For the bulk Phase O sweep the call sites use the lighter
 * `noteCustodyFailure(err)` shorthand which fills the surface label
 * with a generic value — this is acceptable because the structured
 * log emits the stack and the SRE team can correlate by
 * `requestId` / Sentry breadcrumb.
 */

import { captureException } from "../observability/sentry.js";

const MAX_ERR_PREVIEW = 240;

export interface CustodyAppendFailureContext {
  surface: string;
  evidenceId?: string | null;
  custodyEventType?: string | null;
  // Bounded request id from Fastify (req.id). NEVER log auth tokens
  // or PII here.
  requestId?: string | null;
}

function asMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown";
  }
}

export async function swallowCustodyAppendError(
  err: unknown,
  ctx: CustodyAppendFailureContext,
): Promise<null> {
  const preview = asMessage(err).slice(0, MAX_ERR_PREVIEW);
  const errName =
    err instanceof Error ? err.name : typeof err === "string" ? "string" : "unknown";

  // 1. Bounded structured log. We use console here rather than a
  //    request-scoped logger because some call sites are in
  //    promise.then chains that have already returned to the route
  //    layer — the request log context may have unwound.
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      surface: ctx.surface,
      level: "warn",
      msg: "custody.append.swallowed",
      evidenceId: ctx.evidenceId ?? null,
      custodyEventType: ctx.custodyEventType ?? null,
      requestId: ctx.requestId ?? null,
      errName,
      errPreview: preview,
    }),
  );

  // 2. Metric bump (best-effort).
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    mod.bump("custody_event_append_failed_total");
  } catch {
    /* best-effort */
  }

  // 3. Sentry capture (best-effort; existing Sentry init is no-op
  //    when SENTRY_DSN is unset).
  try {
    captureException(err, {
      tags: { surface: ctx.surface, signal: "custody_event_append_failed" },
      extra: {
        evidenceId: ctx.evidenceId ?? null,
        custodyEventType: ctx.custodyEventType ?? null,
        requestId: ctx.requestId ?? null,
      },
    });
  } catch {
    /* best-effort */
  }

  return null;
}

/**
 * Shorthand used by the Phase O sweep of `evidence.routes.ts` where
 * the call sites previously used `.catch(() => null)`. The surface
 * label is the file name — the stack in the structured log gives the
 * route handler.
 */
export function noteCustodyFailure(err: unknown): null {
  void swallowCustodyAppendError(err, { surface: "evidence.routes.ts" });
  return null;
}
