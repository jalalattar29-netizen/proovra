/**
 * Phase P2.1 — Object Lock status surface.
 *
 * Thin operational wrapper around `verifyObjectLockConfiguration()`
 * (which already exists in `storage.ts` and runs at startup). This
 * service surfaces the result to API consumers + the UI so operators
 * can see honestly:
 *
 *   * `verified`               — the bucket supports Object Lock and
 *                                we read its configuration. UI may
 *                                render the "Immutable storage"
 *                                badge.
 *   * `claimed-but-unsupported` — env says enabled; bucket does not
 *                                support it. UI MUST refuse to render
 *                                the immutable badge.
 *   * `disabled`               — env opt-out. UI MUST refuse to
 *                                render the immutable badge.
 *   * `skipped`                — startup probe could not run. UI
 *                                surfaces the reason; no badge.
 *
 * The shape returned is operator-safe: no AWS error stacks, no bucket
 * credentials, no IAM details.
 */

import { verifyObjectLockConfiguration } from "../../storage.js";

export type ObjectLockStatus =
  | {
      mode: "verified";
      bucket: string;
      defaultMode: "GOVERNANCE" | "COMPLIANCE" | null;
      defaultRetainDays: number | null;
      checkedAtUtc: string;
    }
  | {
      mode: "claimed-but-unsupported";
      bucket: string;
      reason: string;
      checkedAtUtc: string;
    }
  | {
      mode: "disabled";
      checkedAtUtc: string;
    }
  | {
      mode: "skipped";
      reason: string;
      checkedAtUtc: string;
    };

export async function getObjectLockStatus(): Promise<ObjectLockStatus> {
  const result = await verifyObjectLockConfiguration();
  const checkedAtUtc = new Date().toISOString();
  if (result.mode === "verified") {
    const cfg = result.configured;
    const defaultMode =
      cfg.defaultMode === "GOVERNANCE" || cfg.defaultMode === "COMPLIANCE"
        ? cfg.defaultMode
        : null;
    return {
      mode: "verified",
      bucket: cfg.bucket,
      defaultMode,
      defaultRetainDays: cfg.defaultRetainDays ?? null,
      checkedAtUtc,
    };
  }
  if (result.mode === "claimed-but-unsupported") {
    return {
      mode: "claimed-but-unsupported",
      bucket: result.bucket,
      reason: result.reason,
      checkedAtUtc,
    };
  }
  if (result.mode === "disabled") {
    return { mode: "disabled", checkedAtUtc };
  }
  return { mode: "skipped", reason: result.reason, checkedAtUtc };
}
