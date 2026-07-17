"use client";

/**
 * Billing Summary section (Settings IA refactor 2026-07-17).
 *
 * A read-only SUMMARY of the billing reality for the active context —
 * plan, scope, renewal, seats, and storage usage where the canonical
 * `/v1/billing/overview` read exposes them (best-effort: members of an
 * organization may not be authorized for the overview; the resolver-
 * derived plan/scope rows still render). Managing billing stays on the
 * dedicated `/billing` page via [Open Billing]. No values are invented.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { SettingsUiContext } from "../../../../lib/settings/settingsUiContext";
import { useActiveWorkspaceId } from "../../../../lib/platform-context";

type OverviewSlice = {
  workspaces?: {
    personal?: {
      plan?: string | null;
      storage?: { usedLabel?: string; limitLabel?: string } | null;
      subscription?: { status?: string | null; currentPeriodEnd?: string | null } | null;
      activeStorageAddonSummary?: { count?: number } | null;
    } | null;
    teams?: Array<{
      id: string;
      plan?: string | null;
      effectivePlan?: string | null;
      teamSeats?: number | null;
      storage?: { usedLabel?: string; limitLabel?: string } | null;
      subscription?: { status?: string | null; currentPeriodEnd?: string | null } | null;
      counts?: { members?: number } | null;
    }>;
  } | null;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-2 text-[13px]"
      style={{ borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.06))" }}
    >
      <span style={{ color: "var(--ink-secondary, #475569)" }}>{label}</span>
      <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

export function BillingSection({ ui }: { ui: SettingsUiContext }) {
  const activeWorkspaceId = useActiveWorkspaceId();
  const [overview, setOverview] = useState<OverviewSlice | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch("/v1/billing/overview")
      .then((r) => {
        if (alive) setOverview(r as OverviewSlice);
      })
      .catch(() => {
        /* best-effort — members without billing access keep the plan rows */
      });
    return () => {
      alive = false;
    };
  }, []);

  const personal = overview?.workspaces?.personal ?? null;
  const activeTeam =
    overview?.workspaces?.teams?.find((t) => t.id === activeWorkspaceId) ?? null;
  const scope = ui.isPersonalWorkspace ? personal : activeTeam;
  const subscription = scope?.subscription ?? null;
  const storage = scope?.storage ?? null;
  const seats = activeTeam?.teamSeats ?? null;
  const members = activeTeam?.counts?.members ?? null;

  return (
    <div style={{ maxWidth: 720 }} data-cc-billing-section data-cc-billing-context={ui.billing.contextType}>
      <Row label="Current plan" value={ui.billing.displayPlan} />
      <Row label="Scope" value={ui.billing.scopeLabel} />
      <Row label="Workspace" value={ui.activeWorkspaceName} />
      {subscription?.currentPeriodEnd ? (
        <Row
          label="Renews"
          value={formatUserDateTime(subscription.currentPeriodEnd)}
        />
      ) : null}
      {seats !== null || members !== null ? (
        <Row
          label="Seats"
          value={
            members !== null && seats !== null
              ? `${members} of ${seats}`
              : String(members ?? seats)
          }
        />
      ) : null}
      {storage?.usedLabel && storage?.limitLabel ? (
        <Row label="Storage" value={`${storage.usedLabel} of ${storage.limitLabel}`} />
      ) : null}

      {ui.billing.managedByOrgName ? (
        <p
          className="m-0 mt-3 text-[13px]"
          style={{ color: "var(--ink-secondary, #475569)" }}
        >
          {ui.billing.contextType === "enterprise-contract"
            ? `Managed under ${ui.billing.managedByOrgName}'s organization agreement. Contact your organization administrator for billing.`
            : ui.billing.canManageBilling
              ? `Billing for ${ui.billing.managedByOrgName}.`
              : `Billing is managed by ${ui.billing.managedByOrgName}'s administrators.`}
        </p>
      ) : null}

      {ui.billing.billingHref ? (
        <div className="mt-4">
          <Link href={ui.billing.billingHref}>
            <Button variant="secondary" size="sm" data-cc-open-billing>
              Open Billing
            </Button>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
