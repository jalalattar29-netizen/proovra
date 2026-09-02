"use client";

/**
 * Phase 4 (Enterprise Administration) — Org admin / Billing & Seats tab.
 *
 * Consumes the read-only rollup GET /v1/orgs/:id/billing/rollup
 * (organizations-governance.routes.ts). Renders enterprise plan status,
 * an org-wide seat rollup (included vs. used, over-seat), a per-workspace
 * seat/plan summary, the billing contact, and an enterprise
 * "Contact your account manager" CTA for contract changes.
 *
 * Deliberately NOT a self-serve checkout / pricing / upgrade surface —
 * enterprise contract changes route through the account manager, not the
 * self-serve Stripe/PayPal flow. This tab never touches checkout or
 * webhooks; it is a pure read of the counts-only rollup.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only).
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - 403/404 maps to an honest "Billing admin only" empty state.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Badge / Button / DataTable / EmptyState). This tab
 * renders INSIDE the org admin layout shell (which owns the org title +
 * tab bar), so it uses Card headings — not a second PageHeader — to
 * avoid a duplicate <h1>. All data reads, gating, testids, data-section
 * markers and honest "—"/empty behaviour are unchanged.
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";

// ---------------------------------------------------------------------------
// Wire type — mirrors GET /v1/orgs/:id/billing/rollup. Counts only; the
// endpoint NEVER returns card tokens, Stripe subscription ids, or customer
// ids, so there is nothing sensitive to model here.
// ---------------------------------------------------------------------------

interface RollupWorkspace {
  id: string;
  name: string;
  billingPlan: string | null;
  billingStatus: string | null;
  includedSeats: number;
  usedSeats: number;
  overSeat: boolean;
}

interface BillingRollup {
  organizationId: string;
  workspaceCount: number;
  activeWorkspaceCount: number;
  totalIncludedSeats: number;
  totalUsedSeats: number;
  overSeatWorkspaceCount: number;
  planCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  billingOwner: {
    userId: string;
    email: string | null;
    displayName: string | null;
  } | null;
  workspaces: RollupWorkspace[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

// Enterprise contract changes route through the account manager. This is
// intentionally a mailto / support deep-link, NOT the self-serve pricing
// page — enterprise seats are contractual, not self-serve.
const ACCOUNT_MANAGER_HREF = "mailto:enterprise@proovra.com";

export default function OrganizationAdminBillingPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <BillingTab />
    </PageRouteGate>
  );
}

function BillingTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [state, setState] = useState<Loadable<BillingRollup>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/orgs/${orgId}/billing/rollup`,
      )) as BillingRollup;
      setState({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = toSafeUserError(err, {
          message: "Failed to load billing rollup.",
        }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      data-testid="org-admin-billing"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      {/* Plan status + seat rollup */}
      <Card
        variant="summary"
        data-section="billing-rollup"
        title="Billing & seats"
        subtitle="Enterprise plan + seat usage across all workspaces. Requires ORG_BILLING_ADMIN or higher."
      >
        {state.kind === "loading" ? (
          <div data-state="loading" style={mutedText}>
            Loading…
          </div>
        ) : state.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
            {state.status === 403 || state.status === 404
              ? "You don't have access to billing (requires ORG_BILLING_ADMIN or higher)."
              : state.message}
            {state.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: "var(--ink-muted, #94a3b8)",
                }}
              >
                Request id: {state.requestId}
              </div>
            ) : null}
          </div>
        ) : (
          <RollupBody data={state.data} />
        )}
      </Card>

      {/* Billing contact */}
      {state.kind === "ready" ? (
        <Card
          variant="admin"
          data-section="billing-contact"
          title="Billing contact"
        >
          {state.data.billingOwner ? (
            <div data-testid="billing-owner" style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>
                {state.data.billingOwner.displayName ??
                  state.data.billingOwner.email ??
                  state.data.billingOwner.userId}
              </div>
              {state.data.billingOwner.email ? (
                <div style={{ color: "var(--ink-secondary, #475569)" }}>
                  {state.data.billingOwner.email}
                </div>
              ) : null}
            </div>
          ) : (
            <div data-testid="billing-owner-empty" style={mutedText}>
              No billing owner is set for this organization.
            </div>
          )}
        </Card>
      ) : null}

      {/* Enterprise account-manager CTA — NOT self-serve checkout */}
      <Card
        variant="status"
        tone="governance"
        data-section="billing-account-manager"
        title="Contract changes"
      >
        <p style={{ ...mutedText, lineHeight: 1.6 }}>
          Enterprise plans and seat counts are set by contract. To change your
          plan, add seats, or discuss billing, contact your account manager —
          enterprise contracts are not modified through the self-serve pricing
          flow.
        </p>
        <a
          href={ACCOUNT_MANAGER_HREF}
          data-testid="billing-contact-account-manager"
          style={{ textDecoration: "none", display: "inline-block", marginTop: 12 }}
        >
          <Button variant="enterprise" size="sm">
            Contact your account manager →
          </Button>
        </a>
      </Card>
    </section>
  );
}

function RollupBody({ data }: { data: BillingRollup }) {
  const planLabel =
    Object.keys(data.planCounts).length === 0
      ? "—"
      : Object.entries(data.planCounts)
          .map(([plan, count]) => `${plan} × ${count}`)
          .join(", ");

  const columns: DataTableColumn<RollupWorkspace>[] = [
    {
      key: "name",
      header: "Workspace",
      render: (w) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{w.name}</div>
          <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
            {w.billingPlan ?? "FREE"} · {w.billingStatus ?? "NONE"}
          </div>
        </div>
      ),
    },
    {
      key: "seats",
      header: "Seats",
      align: "right",
      nowrap: true,
      render: (w) => (
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            color: w.overSeat ? "var(--status-pending-fg, #EA580C)" : undefined,
            fontWeight: w.overSeat ? 600 : 400,
          }}
        >
          {w.usedSeats} / {w.includedSeats} seats
          {w.overSeat ? " · over" : ""}
        </span>
      ),
    },
  ];

  return (
    <div data-testid="billing-rollup-body">
      <div style={statGridStyle}>
        <Stat
          testId="billing-stat-active-workspaces"
          label="Active workspaces"
          value={`${data.activeWorkspaceCount} / ${data.workspaceCount}`}
        />
        <Stat
          testId="billing-stat-included-seats"
          label="Included seats"
          value={String(data.totalIncludedSeats)}
        />
        <Stat
          testId="billing-stat-used-seats"
          label="Used seats"
          value={String(data.totalUsedSeats)}
        />
        <Stat
          testId="billing-stat-over-seat"
          label="Over-seat workspaces"
          value={String(data.overSeatWorkspaceCount)}
          tone={data.overSeatWorkspaceCount > 0 ? "warn" : "neutral"}
        />
      </div>

      <div
        style={{
          fontSize: 12,
          color: "var(--ink-secondary, #475569)",
          margin: "12px 0",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        Plans in use: <Badge tone="neutral" subtle>{planLabel}</Badge>
      </div>

      <h3
        style={{
          margin: "12px 0 8px",
          fontSize: 14,
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        Per-workspace summary
      </h3>
      {data.workspaces.length === 0 ? (
        <div data-testid="billing-workspaces-empty">
          <EmptyState
            compact
            framed
            title="No workspaces on this plan"
            purpose="Workspaces bound to this organization appear here with their plan and seat usage."
          />
        </div>
      ) : (
        <div data-testid="billing-workspaces-list">
          <DataTable
            ariaLabel="Per-workspace seat summary"
            columns={columns}
            rows={data.workspaces}
            getRowId={(w) => w.id}
          />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
  tone,
}: {
  label: string;
  value: string;
  testId: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <Card variant="summary" padding="compact" data-testid={testId}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color:
            tone === "warn" ? "var(--status-pending-fg, #EA580C)" : undefined,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
        {label}
      </div>
    </Card>
  );
}

const mutedText: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};
