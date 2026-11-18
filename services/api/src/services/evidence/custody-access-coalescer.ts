/**
 * PRO-O1-03 / B5B-F-505 — REPEATABLE ACCESS EVENTS DO NOT GROW THE CUSTODY
 * CHAIN WITHOUT BOUND.
 *
 * Two writers appended one permanent, hash-chained custody row per request:
 *   - a Public Verify answer that issued original URLs (VERIFY_VIEWED, channel
 *     public_verify) — an anonymous link holder could append ~30 per minute;
 *   - a refused download (EXPORT_BLOCKED_BY_POLICY) — a member without the
 *     download capability appended one per click, with no route limiter.
 * Every later anonymous Verify view reads and re-verifies the whole chain, and
 * every later report or package embeds it, so the cost compounded.
 *
 * The route already coalesces the ordinary VERIFY_VIEWED to one per 24 h; the
 * same rule now applies to these two. The FIRST identical event in a window is
 * appended (so the fact is recorded before anything else is issued in that
 * window); the rest are counted (`custody_access_event_coalesced_total`). The
 * window is a shared lease, so concurrent first requests on every replica
 * append exactly one. Chain semantics are unchanged: fewer access events, never
 * a rewritten one.
 */
import { createHash } from "node:crypto";

import { bump } from "../ops/metrics.service.js";
import { acquireLease } from "../rate-limit.js";

export const DEFAULT_CUSTODY_ACCESS_COALESCE_MS = 60 * 60_000;

export function custodyAccessCoalesceMs(): number {
  const raw = Number.parseInt(process.env.CUSTODY_ACCESS_COALESCE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.min(raw, 24 * 60 * 60_000) : DEFAULT_CUSTODY_ACCESS_COALESCE_MS;
}

/** True when this access event is the window's first and must be appended. */
export async function claimCustodyAccessSlot(parts: ReadonlyArray<string | null | undefined>): Promise<boolean> {
  const fingerprint = createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 40);
  try {
    const lease = await acquireLease(`custody-access:${fingerprint}`, custodyAccessCoalesceMs());
    if (lease.acquired) return true;
  } catch {
    // Store threw outright: append rather than lose the window's only event.
    return true;
  }
  bump("custody_access_event_coalesced_total");
  return false;
}

/** Stable text of a refusal payload, for the coalescing key. */
export function stablePayloadKey(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(keys.map((k) => [k, payload[k]]));
}
