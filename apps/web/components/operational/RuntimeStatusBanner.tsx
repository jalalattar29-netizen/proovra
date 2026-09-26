"use client";

/**
 * CONTEXTUAL SERVICE NOTICE — one line beside an action that a real service
 * incident affects.
 *
 * =============================================================================
 * WHAT THIS USED TO BE, AND WHY THAT WAS THE DEFECT
 * =============================================================================
 * A full-width "Runtime is in degraded mode" panel mounted unconditionally at
 * the top of Evidence detail, Home, Governance and the reviewer pages. It was
 * driven by a rollup of every platform readiness check — including Sentry
 * configuration, Object Lock posture, the reviewer reconcile sweep and
 * search-index lag — and it told the reader "the data on this page may be
 * partial or stale". A platform diagnostic was presented as a statement about
 * the evidence record in front of the user.
 *
 * =============================================================================
 * THE CONTRACT NOW
 * =============================================================================
 *   * `requires` is mandatory: the capabilities the adjacent action depends
 *     on. The notice renders ONLY when one of them is confirmed DEGRADED or
 *     UNAVAILABLE. Everything else — healthy, unmeasured, a failed status read,
 *     an unrelated capability — renders nothing. "Could not measure" is said
 *     once, by the header indicator, not beside every button.
 *   * The words describe the ACTION ("Report and package generation is
 *     delayed"), never the record. Existing artifacts stay downloadable unless
 *     downloads themselves are affected.
 *   * No subsystem names, no runbooks, no links: this is a sentence next to a
 *     button. Details live behind the header indicator and Workspace Health.
 *
 * Global service status belongs to `ServiceStatusIndicator` in the header;
 * record-specific processing and integrity belong to their own sections.
 */

import {
  contextualServiceNotices,
  type TenantServiceCapability,
} from "@proovra/shared";

import { useServiceStatus } from "../../lib/useServiceStatus";
import { OPS_TONES } from "./tokens";

export type RuntimeStatusBannerProps = {
  /** The capabilities the adjacent action depends on. Required on purpose. */
  requires: ReadonlyArray<TenantServiceCapability>;
};

export function RuntimeStatusBanner({ requires }: RuntimeStatusBannerProps) {
  const { status } = useServiceStatus();
  const notices = contextualServiceNotices(status, requires);
  if (notices.length === 0) return null;
  const unavailable = notices.some((n) => n.status === "UNAVAILABLE");
  const tone = unavailable ? OPS_TONES.warning : OPS_TONES.degraded;
  return (
    <div
      role="status"
      aria-live="polite"
      data-service-notice={notices.map((n) => n.capability).join(" ")}
      data-service-notice-status={unavailable ? "UNAVAILABLE" : "DEGRADED"}
      style={{
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.ink,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12.5,
        lineHeight: 1.45,
        display: "grid",
        gap: 2,
      }}
    >
      {notices.map((n) => (
        <span key={n.capability}>{n.message}</span>
      ))}
    </div>
  );
}

export default RuntimeStatusBanner;
