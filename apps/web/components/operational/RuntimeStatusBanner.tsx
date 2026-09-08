"use client";

/**
 * Phase 28-G — Runtime Status Banner.
 *
 * A concise top-of-page banner shown on TENANT pages when the platform runtime
 * is not serving normally. When everything is healthy it renders nothing, so
 * operational pages stay uncluttered.
 *
 * =============================================================================
 * WHAT IT USED TO READ, AND WHY THAT WAS THE DEFECT (ADM-P1-003 / OWN-1)
 * =============================================================================
 * It consumed `GET /admin/runtime/readiness` — the full platform aggregator,
 * authorised by workspace membership plus `audit.read` — and rendered, to
 * ordinary tenant users on `/evidence/:id`, `/governance/policy`,
 * `/reviewer-ops/*` and the command centre:
 *
 *   - the ids of failing platform subsystems,
 *   - their `reasonCode` and operator `detail`,
 *   - their `remediationHint`.
 *
 * Those are instructions for repairing PROOVRA's deployment, and the tenant
 * pages showing them belong to customers. OWN-1 settles the boundary: full
 * runtime, migrations, schema drift, worker state and global queue detail are
 * platform-admin only.
 *
 * =============================================================================
 * WHAT IT READS NOW
 * =============================================================================
 * `GET /v1/runtime/status`, whose entire body is:
 *
 *     { "status": "HEALTHY" | "DEGRADED" | "UNAVAILABLE" }
 *
 * That is enough for the only thing this banner is for — telling a customer
 * that what they are looking at may be incomplete — and it carries none of the
 * detail above.
 *
 * THE `forDomains` PROP IS GONE, not left inert. It scoped the banner to
 * subsystems affecting a named domain (`reviewer_ops`, `search_discovery`, …).
 * That mapping lives in the platform payload, and the domain names are internal
 * service topology, which the tenant-safe projection deliberately withholds. A
 * prop that silently stopped filtering would be a permanently-true condition
 * dressed as a control, so the callers lost it too. The consequence is stated
 * plainly: a degraded platform now shows this banner on every page that mounts
 * it, rather than only on the pages whose domain was affected.
 *
 * FAIL-CLOSED: when the status read itself fails, an UNKNOWN banner renders.
 * Rendering nothing would be visually indistinguishable from HEALTHY.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { useHealthDestination } from "../../lib/navigation/healthDestination";
import { RuntimeDegradedNotice } from "./OperationalEmptyState";
import { OPS_TONES } from "./tokens";

/** Exactly the three values the tenant-safe projection can answer. */
type TenantRuntimeStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export type RuntimeStatusBannerProps = {
  /** Poll interval in ms. 0 disables polling (single read on mount). */
  pollMs?: number;
};

export function RuntimeStatusBanner({ pollMs = 60_000 }: RuntimeStatusBannerProps) {
  const [status, setStatus] = useState<TenantRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADM-013 PHASE 1 — `useHealthDestination()` is the ONE authority for where
  // "check the health" goes for THIS actor. It returns the label with the href,
  // so a link can never name a scope it does not open, and null when the actor
  // holds neither authority — in which case no link is rendered at all.
  const healthDestination = useHealthDestination();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = (await apiFetch("/v1/runtime/status")) as {
          status: TenantRuntimeStatus;
        };
        if (!cancelled) {
          setStatus(data?.status ?? "UNAVAILABLE");
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setStatus(null);
          setError(
            toSafeUserError(err, { message: "readiness_unavailable" }).message,
          );
        }
      }
    }
    void load();

    if (pollMs > 0) {
      const interval = setInterval(() => void load(), pollMs);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [pollMs]);

  // FAIL-CLOSED: the status read failed → show UNKNOWN. Rendering nothing here
  // would be visually indistinguishable from HEALTHY.
  if (error) {
    return (
      <div
        role="status"
        data-runtime-status="UNKNOWN"
        style={{
          border: `1px solid ${OPS_TONES.unknown.border}`,
          background: OPS_TONES.unknown.bg,
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 13,
          color: OPS_TONES.unknown.ink,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <span>
          Runtime readiness could not be loaded — treat dashboard as unknown
          state.
        </span>
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.5,
            fontWeight: 700,
            color: OPS_TONES.unknown.kicker,
          }}
        >
          UNKNOWN
        </span>
      </div>
    );
  }

  // HEALTHY → render nothing (operational pages stay clean).
  if (!status || status === "HEALTHY") {
    return null;
  }

  if (status === "DEGRADED") {
    /*
     * NO SUBSYSTEM IDS. `RuntimeDegradedNotice` takes a list and names it; the
     * tenant projection has none to give, and inventing one would be the leak
     * this change removed, restated. An empty list makes the notice say that
     * the platform is degraded without saying which part of it.
     */
    return <RuntimeDegradedNotice failingSubsystems={[]} />;
  }

  // UNAVAILABLE — the platform could not measure its own readiness.
  return (
    <div
      role="status"
      data-runtime-status="UNKNOWN"
      style={{
        border: `1px solid ${OPS_TONES.warning.border}`,
        background: OPS_TONES.warning.bg,
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 13,
        color: OPS_TONES.warning.ink,
        fontWeight: 500,
        marginBottom: 12,
      }}
    >
      Runtime status is currently unknown.
      {healthDestination ? (
        <>
          {" "}
          <a
            href={healthDestination.href}
            style={{
              color: OPS_TONES.warning.link,
              fontWeight: 700,
              textDecoration: "underline",
            }}
          >
            {healthDestination.label}
          </a>{" "}
          for detail.
        </>
      ) : null}
    </div>
  );
}

export default RuntimeStatusBanner;
