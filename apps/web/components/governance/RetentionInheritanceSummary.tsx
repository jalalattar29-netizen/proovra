"use client";

/**
 * Phase F — Retention inheritance summary.
 *
 * Surfaces the Phase B0 resolver verdict
 * (`resolveTeamRetentionPolicy`) so operators see exactly where their
 * retention rule comes from:
 *
 *   * `team_policy` — local workspace policy (operator has full control)
 *   * `org_policy_inherited` — coming down from the parent organization
 *     (operator may override, subject to immutable floor)
 *   * `none` — no policy set; default behavior applies
 *
 * Hard rules:
 *   * Renders the backend resolver verdict verbatim. Never invents
 *     inheritance.
 *   * Vocabulary stays operational. No "compliance", "regulatory",
 *     "legally required" — those are workspace-policy semantics that
 *     belong on a different surface.
 *   * Read-only.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

type ResolutionPayload =
  | {
      source: "team_policy";
      teamId: string;
      policyId: string;
      retentionDays: number | null;
      immutable: boolean;
    }
  | {
      source: "org_policy_inherited";
      teamId: string;
      organizationId: string;
      template: {
        retentionDays: number | null;
        immutable: boolean;
        description: string | null;
      };
    }
  | { source: "none"; teamId: string };

type Response = { resolution: ResolutionPayload };

export function RetentionInheritanceSummary({
  teamId,
}: {
  teamId: string | null;
}) {
  const [data, setData] = useState<ResolutionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/governance/retention/inheritance?teamId=${encodeURIComponent(teamId)}`,
      )) as Response;
      setData(json.resolution);
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Could not resolve retention inheritance." }).message);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!teamId) {
    return (
      <div data-retention-inheritance-empty="no-workspace" style={panelStyle}>
        <strong>Retention inheritance</strong>
        <p style={mutedStyle}>A workspace context is required.</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div data-retention-inheritance-loading style={panelStyle}>
        Resolving retention inheritance…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div data-retention-inheritance-error role="alert" style={panelStyle}>
        <strong>Retention inheritance unavailable</strong>
        <p style={mutedStyle}>{error ?? "Not available."}</p>
      </div>
    );
  }

  return (
    <section
      data-retention-inheritance
      data-retention-source={data.source}
      style={panelStyle}
    >
      <strong style={{ fontSize: 14 }}>Retention inheritance</strong>

      {data.source === "team_policy" ? (
        <p style={{ marginTop: 6, fontSize: 13 }}>
          This workspace is governed by its <strong>local team policy</strong>.
          {" "}
          {data.retentionDays != null
            ? `Retention horizon: ${data.retentionDays} days.`
            : "Retention horizon: indefinite."}
          {data.immutable ? " The policy is marked immutable." : ""}
        </p>
      ) : null}

      {data.source === "org_policy_inherited" ? (
        <p style={{ marginTop: 6, fontSize: 13 }}>
          This workspace <strong>inherits</strong> the retention template
          published by the parent organization (
          <code>{data.organizationId.slice(0, 8)}…</code>).{" "}
          {data.template.retentionDays != null
            ? `Inherited retention horizon: ${data.template.retentionDays} days.`
            : "Inherited retention horizon: indefinite."}
          {data.template.immutable
            ? " The organization template is immutable — workspaces may not weaken it."
            : ""}
        </p>
      ) : null}

      {data.source === "none" ? (
        <p style={{ marginTop: 6, fontSize: 13 }}>
          No retention policy applies. The default (indefinite retention) is
          in effect. Configure a workspace policy or have the parent
          organization publish a retention template to surface a deterministic
          horizon.
        </p>
      ) : null}
    </section>
  );
}

const panelStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  padding: "0.75rem 1rem",
} as const;

const mutedStyle = {
  fontSize: 12,
  color: "#94a3b8",
  margin: "4px 0 0",
} as const;
