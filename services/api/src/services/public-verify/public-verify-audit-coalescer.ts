/**
 * PRO-O1-02 / PRO-S1-01 / B5B-F-505 — ANONYMOUS PUBLIC VERIFY AUDITS ARE
 * COALESCED.
 *
 * Every admitted anonymous Verify request (each success and seven denial
 * branches) appended one row to the platform-wide audit hash chain, which
 * takes ONE advisory lock shared by every tenant. The per-client limiter bounds
 * one address, not the population, so a widely shared page or a refresh storm
 * queued transactions behind that lock while authenticated mutations whose
 * audit must commit waited behind them.
 *
 * The audit facade is kept; its cost per anonymous view is not. For one
 * (action, outcome, reason, record) the FIRST occurrence in a window is
 * chained; the rest of the window is counted
 * (`public_verify_view_audit_coalesced_total`). The window is a shared lease
 * (Redis `SET NX PX`, the limiter's keyspace), so concurrent first views on
 * every replica produce exactly one row; with the store unavailable each
 * process coalesces in its own memory, which is still bounded. Per-view
 * analytics remain in `verification_views`; a denial for a record is still
 * recorded — once per window, not once per request.
 */
import { createHash } from "node:crypto";

import { bump } from "../ops/metrics.service.js";
import { acquireLease } from "../rate-limit.js";

export const DEFAULT_PUBLIC_VERIFY_AUDIT_COALESCE_MS = 10 * 60_000;

export function publicVerifyAuditCoalesceMs(): number {
  const raw = Number.parseInt(process.env.PUBLIC_VERIFY_AUDIT_COALESCE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.min(raw, 24 * 60 * 60_000) : DEFAULT_PUBLIC_VERIFY_AUDIT_COALESCE_MS;
}

/** True when this anonymous Verify audit is the window's first and must be chained. */
export async function claimPublicVerifyAuditSlot(input: {
  action: string;
  outcome: string;
  reason: string | null;
  resourceId: string | null;
}): Promise<boolean> {
  const fingerprint = createHash("sha256")
    .update([input.action, input.outcome, input.reason ?? "", input.resourceId ?? ""].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32);
  try {
    const lease = await acquireLease(`verify-audit:${fingerprint}`, publicVerifyAuditCoalesceMs());
    if (lease.acquired) return true;
  } catch {
    // The lease store threw outright (it normally falls back to memory): chain
    // this one rather than lose the only row of a window.
    return true;
  }
  bump("public_verify_view_audit_coalesced_total");
  return false;
}
