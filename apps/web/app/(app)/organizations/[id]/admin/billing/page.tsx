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
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

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
    <section data-testid="org-admin-billing" data-org-id={orgId}>
      {/* Plan status + seat rollup */}
      <section
        data-section="billing-rollup"
        style={cardStyle}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Billing &amp; seats</h2>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
              Enterprise plan + seat usage across all workspaces. Requires
              ORG_BILLING_ADMIN or higher.
            </div>
          </div>
        </header>

        {state.kind === "loading" ? (
          <div data-state="loading" style={{ fontSize: 13, opacity: 0.7 }}>
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
                  opacity: 0.7,
                }}
              >
                Request id: {state.requestId}
              </div>
            ) : null}
          </div>
        ) : (
          <RollupBody data={state.data} />
        )}
      </section>

      {/* Billing contact */}
      {state.kind === "ready" ? (
        <section data-section="billing-contact" style={cardStyle}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Billing contact</h2>
          {state.data.billingOwner ? (
            <div
              data-testid="billing-owner"
              style={{ fontSize: 13, marginTop: 8 }}
            >
              <div style={{ fontWeight: 600 }}>
                {state.data.billingOwner.displayName ??
                  state.data.billingOwner.email ??
                  state.data.billingOwner.userId}
              </div>
              {state.data.billingOwner.email ? (
                <div style={{ opacity: 0.75 }}>
                  {state.data.billingOwner.email}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              data-testid="billing-owner-empty"
              style={{ fontSize: 13, opacity: 0.75, marginTop: 8 }}
            >
              No billing owner is set for this organization.
            </div>
          )}
        </section>
      ) : null}

      {/* Enterprise account-manager CTA — NOT self-serve checkout */}
      <section
        data-section="billing-account-manager"
        style={cardStyle}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Contract changes</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Enterprise plans and seat counts are set by contract. To change your
          plan, add seats, or discuss billing, contact your account manager —
          enterprise contracts are not modified through the self-serve pricing
          flow.
        </p>
        <a
          href={ACCOUNT_MANAGER_HREF}
          data-testid="billing-contact-account-manager"
          className="cases-filter-chip"
          style={{ display: "inline-block", marginTop: 4 }}
        >
          Contact your account manager →
        </a>
      </section>
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

      <div style={{ fontSize: 12, opacity: 0.75, margin: "0.5rem 0 0.75rem" }}>
        Plans in use: <strong>{planLabel}</strong>
      </div>

      <h3 style={{ margin: "0.5rem 0 0.25rem", fontSize: 14 }}>
        Per-workspace summary
      </h3>
      {data.workspaces.length === 0 ? (
        <div
          data-testid="billing-workspaces-empty"
          style={{ fontSize: 13, opacity: 0.75 }}
        >
          No workspaces are bound to this organization yet.
        </div>
      ) : (
        <ul
          data-testid="billing-workspaces-list"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {data.workspaces.map((w) => (
            <li
              key={w.id}
              data-workspace-id={w.id}
              data-over-seat={w.overSeat ? "true" : "false"}
              style={{
                padding: "0.45rem 0",
                borderBottom: "1px solid rgba(127,127,127,0.18)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                fontSize: 13,
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ fontWeight: 500 }}>{w.name}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {w.billingPlan ?? "FREE"} · {w.billingStatus ?? "NONE"}
                </div>
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                  color: w.overSeat ? "#b45309" : undefined,
                  fontWeight: w.overSeat ? 600 : 400,
                }}
              >
                {w.usedSeats} / {w.includedSeats} seats
                {w.overSeat ? " · over" : ""}
              </div>
            </li>
          ))}
        </ul>
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
    <div data-testid={testId} style={statCardStyle}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "warn" ? "#b45309" : undefined,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — mirror the sibling admin tabs (security/overview) so the tab
// bar renders a visually-consistent card surface.
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
  marginBottom: "1rem",
};

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
  marginTop: 4,
};

const statCardStyle: React.CSSProperties = {
  padding: "0.6rem 0.75rem",
  border: "1px solid rgba(127,127,127,0.2)",
  borderRadius: 6,
};
