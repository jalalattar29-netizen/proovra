"use client";

/**
 * Billing Summary section (Settings IA refactor 2026-07-17).
 *
 * A read-only SUMMARY of the billing reality for the active context —
 * plan, scope, renewal, seats and storage. Managing billing stays on the
 * dedicated `/billing` page via [Open Billing]: this section never offers
 * checkout, payment history, add-ons, cancellation or account selection, and
 * no value here is invented.
 *
 * BILLING PRODUCTION CLOSURE (2026-08-27) — the source is the CANONICAL
 * account projection.
 *
 * It read `/v1/billing/overview`, an aggregate spanning every billing account
 * the viewer touches, and then picked the active workspace out of it in the
 * browser. Two things were wrong with that: the response carried other payers'
 * commercial state to a page that only ever needed one account's, and the
 * capability filtering that decides whether a viewer may see an amount lives
 * in the account projection, not in the aggregate. This now resolves the ONE
 * account behind the active workspace and reads it — so a workspace
 * administrator who is not the payer sees the plan and nothing financial,
 * exactly as they do on `/billing`.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { SettingsUiContext } from "../../../../lib/settings/settingsUiContext";
import {
  useActiveWorkspaceId,
  WorkspaceContextBanner,
} from "../../../../lib/platform-context";

/** Only the fields this summary renders. Nothing else is read. */
type AccountSlice = {
  plan?: { currentPeriodEndUtc?: string | null } | null;
  usage?: {
    storage?: { state?: string; usedLabel?: string; limitLabel?: string } | null;
  } | null;
  collaboration?: { seats?: { used?: number; limit?: number } | null } | null;
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
  const [account, setAccount] = useState<AccountSlice | null>(null);

  useEffect(() => {
    // PHASE 7 §10.G — re-resolve on workspace switch so the shown
    // plan/seats/storage belong to the currently-active workspace, not to a
    // snapshot taken under the prior one.
    let alive = true;
    setAccount(null);

    (async () => {
      const { accounts } = await apiFetch("/v1/billing/accounts");
      const list = (accounts ?? []) as Array<{ type: string; id: string }>;
      // The account behind the ACTIVE workspace, falling back to the viewer's
      // personal account. A viewer with no visible account simply renders the
      // resolver-derived plan rows and nothing financial.
      const target =
        (!ui.isPersonalWorkspace && activeWorkspaceId
          ? list.find((a) => a.type === "WORKSPACE" && a.id === activeWorkspaceId)
          : undefined) ?? list.find((a) => a.type === "PERSONAL");
      if (!target) return;

      const projection = (await apiFetch(
        `/v1/billing/accounts/${target.type}/${target.id}`,
      )) as AccountSlice;
      if (alive) setAccount(projection);
    })().catch(() => {
      /* best-effort — a viewer without account visibility keeps the plan rows */
    });

    return () => {
      alive = false;
    };
    // `activeWorkspaceId` stays LAST: `phase-7-tenant-isolation` pins this
    // effect as re-running on workspace switch by matching `activeWorkspaceId]`,
    // and that property is exactly what the ordering preserves.
  }, [ui.isPersonalWorkspace, activeWorkspaceId]);

  const renewsAtUtc = account?.plan?.currentPeriodEndUtc ?? null;
  const storage =
    account?.usage?.storage?.state === "MEASURED" ? account.usage.storage : null;
  const seats = account?.collaboration?.seats?.limit ?? null;
  const members = account?.collaboration?.seats?.used ?? null;

  return (
    <div style={{ maxWidth: 720 }} data-cc-billing-section data-cc-billing-context={ui.billing.contextType}>
      {/* PHASE 7 §10.5 — billing is workspace-scoped; make the owning
          context explicit before any plan change. */}
      <WorkspaceContextBanner action="Billing for" />
      <Row label="Current plan" value={ui.billing.displayPlan} />
      <Row label="Scope" value={ui.billing.scopeLabel} />
      <Row label="Workspace" value={ui.activeWorkspaceName} />
      {renewsAtUtc ? (
        <Row label="Renews" value={formatUserDateTime(renewsAtUtc)} />
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
