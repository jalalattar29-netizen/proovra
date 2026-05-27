"use client";

/**
 * Phase A.1C — Account-level operational priorities banner.
 *
 * Sits ABOVE the workspace-scoped CommandCenter on /home. Surfaces the
 * cross-workspace, identity-level signals the CommandCenter cannot see
 * because it is anchored to a single teamId:
 *
 *   - Pending org invites the caller is being asked to accept
 *   - Org-admin governance hotspots (pending invites the caller can
 *     resend / revoke as an admin)
 *   - First-time onboarding signals (no org joined yet, no email)
 *
 * Hard rules:
 *
 *   - All content is sourced from `GET /v1/me/operational-priorities`
 *     — the API decides what the caller can see and what is
 *     governance-safe to surface. The component does NOT do its own
 *     RBAC.
 *
 *   - When the endpoint has 0 priority items AND the caller is fully
 *     onboarded, the banner does not render (no decorative empty
 *     state on /home — the CommandCenter is the operational surface).
 *
 *   - When the endpoint returns a non-2xx (rare, 401/legal-pending
 *     handled upstream by PageRouteGate), the banner renders a small
 *     unavailable state, NOT a blank gap.
 *
 *   - Every CTA is a deep-link to an EXISTING route. No invented
 *     destinations.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";

type PriorityTone = "info" | "warning" | "high";

type PriorityItem = {
  id: string;
  label: string;
  meaning: string;
  href: string;
  tone: PriorityTone;
};

type PriorityEnvelope = {
  generatedAt: string;
  caller: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
  summary: {
    totalOrgs: number;
    pendingOrgInviteCount: number;
    adminPendingInviteCount: number;
    adminOrgsWithPending: number;
    priorityItemCount: number;
  };
  onboarding: {
    legalAccepted: boolean;
    hasEmailIdentity: boolean;
    hasAnyOrganization: boolean;
    hasOwnedOrganization: boolean;
  };
  orgs: ReadonlyArray<{
    organizationId: string;
    name: string;
    status: string;
    role: string;
  }>;
  pendingOrgInvites: ReadonlyArray<{
    inviteId: string;
    organizationId: string;
    organizationName: string;
    role: string;
    expiresAt: string;
    createdAt: string;
  }>;
  items: ReadonlyArray<PriorityItem>;
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: PriorityEnvelope }
  | { kind: "unavailable"; status: number; message: string };

const TONE_STYLES: Record<
  PriorityTone,
  { border: string; background: string; chipBg: string; chipFg: string }
> = {
  high: {
    border: "rgba(239, 68, 68, 0.55)",
    background: "rgba(239, 68, 68, 0.08)",
    chipBg: "rgba(239, 68, 68, 0.22)",
    chipFg: "#7f1d1d",
  },
  warning: {
    border: "rgba(245, 158, 11, 0.55)",
    background: "rgba(245, 158, 11, 0.08)",
    chipBg: "rgba(245, 158, 11, 0.22)",
    chipFg: "#78350f",
  },
  info: {
    border: "rgba(99, 102, 241, 0.45)",
    background: "rgba(99, 102, 241, 0.06)",
    chipBg: "rgba(99, 102, 241, 0.18)",
    chipFg: "#312e81",
  },
};

export function AccountPrioritiesBanner() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await apiFetch("/v1/me/operational-priorities");
      const data = (await res.json()) as PriorityEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        err instanceof Error
          ? err.message
          : "Could not load operational priorities.";
      setState({ kind: "unavailable", status, message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------------------------------------------------------------------------
  // Loading: lightweight skeleton, no spinner — the CommandCenter has its
  // own. This banner is a hint above it; it must not block.
  // ---------------------------------------------------------------------------
  if (state.kind === "loading") {
    return (
      <section
        data-account-priorities-banner
        data-state="loading"
        aria-busy="true"
        style={{
          padding: "0.6rem 0.9rem",
          border: "1px dashed rgba(127,127,127,0.3)",
          borderRadius: 8,
          margin: "0 0 0.75rem",
          fontSize: 12,
          opacity: 0.6,
        }}
      >
        Loading operational priorities…
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Unavailable: rare. Keep small and honest. Never hide the page.
  // 401 / 403 are usually handled by the parent PageRouteGate before we
  // get here; we treat any error as soft-degraded.
  // ---------------------------------------------------------------------------
  if (state.kind === "unavailable") {
    return (
      <section
        data-account-priorities-banner
        data-state="unavailable"
        role="status"
        style={{
          padding: "0.6rem 0.9rem",
          border: "1px dashed rgba(127,127,127,0.4)",
          borderRadius: 8,
          margin: "0 0 0.75rem",
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        Account-level priorities unavailable
        {state.status ? ` (HTTP ${state.status})` : ""}.
        <button
          type="button"
          onClick={() => void load()}
          data-action="retry-priorities"
          style={{
            marginLeft: 8,
            fontSize: 12,
            background: "transparent",
            border: "1px solid currentColor",
            borderRadius: 4,
            padding: "1px 6px",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </section>
    );
  }

  const { data } = state;

  // ---------------------------------------------------------------------------
  // Banner is hidden when the caller has 0 priority items AND has any
  // organization. For a fully-onboarded user in a stable state, /home is
  // the workspace command center and we don't add decoration. The
  // exception is the first-time path (no orgs), which always renders so
  // the user has somewhere to go.
  // ---------------------------------------------------------------------------
  const showOnboardingBlock =
    !data.onboarding.hasAnyOrganization;

  if (!showOnboardingBlock && data.items.length === 0) {
    // Render a single-line "no priority items right now" hint so the
    // banner DOM is always present (E2E uses the marker to assert
    // operational signal availability), but visually minimal.
    return (
      <section
        data-account-priorities-banner
        data-state="empty"
        data-priority-count={0}
        aria-label="Operational priorities"
        style={{
          padding: "0.5rem 0.9rem",
          border: "1px dashed rgba(127,127,127,0.25)",
          borderRadius: 8,
          margin: "0 0 0.75rem",
          fontSize: 12,
          opacity: 0.75,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          No account-level priorities right now. The workspace command
          center below shows operational state.
        </span>
        <Link
          href="/organizations"
          data-action="banner-open-organizations"
          style={{ fontSize: 12 }}
        >
          Organizations →
        </Link>
      </section>
    );
  }

  return (
    <section
      data-account-priorities-banner
      data-state="ready"
      data-priority-count={data.items.length}
      data-pending-org-invites={data.summary.pendingOrgInviteCount}
      data-admin-pending-invites={data.summary.adminPendingInviteCount}
      data-has-any-organization={
        data.onboarding.hasAnyOrganization ? "true" : "false"
      }
      data-has-email-identity={
        data.onboarding.hasEmailIdentity ? "true" : "false"
      }
      aria-label="Operational priorities"
      style={{
        margin: "0 0 0.9rem",
        display: "grid",
        gap: 8,
      }}
    >
      {/* ---- header ---- */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            What needs your attention
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {data.items.length === 0
              ? "Get started"
              : data.items.length === 1
                ? "1 priority"
                : `${data.items.length} priorities`}
          </div>
        </div>
        <Link
          href="/organizations"
          data-action="banner-open-organizations"
          style={{ fontSize: 12 }}
        >
          Open Organizations →
        </Link>
      </div>

      {/* ---- onboarding-only block (no orgs yet) ---- */}
      {showOnboardingBlock && data.items.length === 0 && (
        <div
          data-onboarding-block
          style={{
            padding: "0.9rem 1rem",
            border: "1px solid rgba(99,102,241,0.45)",
            borderRadius: 8,
            background: "rgba(99,102,241,0.06)",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Welcome to PROOVRA — three operational steps
          </div>
          <ol
            data-onboarding-steps
            style={{
              margin: 0,
              paddingLeft: "1.2rem",
              fontSize: 13,
              display: "grid",
              gap: 4,
            }}
          >
            <li>
              <strong>Create or join an organization.</strong>{" "}
              <Link
                href="/organizations"
                data-action="onboarding-create-org"
              >
                Open Organizations →
              </Link>
            </li>
            <li>
              <strong>Capture evidence.</strong> Personal workspace is
              ready immediately —{" "}
              <Link href="/capture" data-action="onboarding-capture">
                start a capture →
              </Link>
            </li>
            <li>
              <strong>Generate a report from finalized evidence.</strong>{" "}
              <Link href="/reports" data-action="onboarding-reports">
                Open Reports →
              </Link>
            </li>
          </ol>
        </div>
      )}

      {/* ---- priority items ---- */}
      {data.items.length > 0 && (
        <ul
          data-priority-items
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 6,
          }}
        >
          {data.items.map((item) => {
            const tone = TONE_STYLES[item.tone];
            return (
              <li
                key={item.id}
                data-priority-item={item.id}
                data-priority-tone={item.tone}
                style={{
                  padding: "0.55rem 0.8rem",
                  border: `1px solid ${tone.border}`,
                  background: tone.background,
                  borderRadius: 6,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      data-tone-chip={item.tone}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: tone.chipBg,
                        color: tone.chipFg,
                      }}
                    >
                      {item.tone}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                      {item.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    {item.meaning}
                  </div>
                </div>
                <Link
                  href={item.href}
                  data-action="open-priority"
                  data-priority-href={item.href}
                  style={{
                    padding: "0.3rem 0.7rem",
                    border: "1px solid currentColor",
                    borderRadius: 4,
                    fontSize: 12.5,
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  Act
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
