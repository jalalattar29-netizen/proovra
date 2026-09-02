"use client";

/**
 * PROOVRA Phase 2B Closure — External Review Management Console.
 *
 * Operator surface for the External Reviewer Portal. Replaces the
 * single-issue page with a tabbed console:
 *
 *   • Active / Pending / Accepted / Expired / Revoked tabs render
 *     grant lifecycle states filtered from the workspace-anchored
 *     listInvitationsForTeam projection.
 *   • Bulk Invite tab — multi-row paste (CSV or one-per-line), per-row
 *     validation, per-row outcome table, summary chips.
 *   • Per-grant detail drawer:
 *       - Delivery status panel (most recent + history).
 *       - Activity timeline.
 *       - Resend, Revoke, Bulk Revoke.
 *       - SSO controls — auth method, ssoConnectionId, allowedDomains.
 *       - MFA required toggle (display only — change at issue time).
 *       - Watermark policy chip.
 *   • Token reveal is hidden behind an explicit break-glass toggle.
 *
 * The console is **NEVER** a second portal — it consumes the same
 * REST endpoints behind /v1/external-review/* added by Phase 2B
 * Closure and does NOT duplicate any grant/identity/audit storage.
 *
 * Workspace-anchored at the API boundary — every read includes the
 * caller's session, which the API resolves to a teamId.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  BULK_INVITATION_MAX_ROWS,
  EXTERNAL_REVIEWER_ROLES,
  PORTAL_AUTH_METHODS,
  WATERMARK_POLICIES,
  type ExternalReviewerRole,
  type PortalAuthMethod,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useToast, PageShell, PageHeader } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  useActiveSpace,
  useCan,
  useTeamId,
} from "../../../../lib/platform-context";

// ---------------------------------------------------------------------------
// PHASE 4 — Per-action capability gating.
//
// Phase 0 confirmed every admin button rendered unconditionally and
// every mutation catch collapsed 403 into the misleading "RATE_LIMITED"
// banner. The hook below derives the bounded gate set from the
// canonical platform-context envelope:
//
//   - REVIEWER_OPS_ACT — required for any external-review mutation
//     (Invite / Bulk Invite / Resend / Revoke / Bulk Revoke). The
//     PageRouteGate already requires REVIEWER_OPS_VIEW; ACT is the
//     reviewer-ops mutation cap on the canonical CapabilityMap.
//
//   - canRevealToken — manual token reveal is a stronger split-of-duty
//     gate: REVIEWER_OPS_ACT alone is NOT enough. We additionally
//     require the active space role to be OWNER (workspace owner has
//     break-glass authority). ADMIN/SUPERVISOR can see the button but
//     it stays disabled, with a tooltip explaining the split-of-duty.
//
// Buttons are NEVER hidden — disabled-with-explanation, per brief.
// The server is still the authority — a click that slips through
// (e.g. a stale envelope) is surfaced via the bounded NOT_PERMITTED
// banner rather than the legacy "RATE_LIMITED" collapse.
// ---------------------------------------------------------------------------

type ExternalReviewCapabilities = {
  canInvite: boolean;
  canBulkInvite: boolean;
  canBulkRevoke: boolean;
  canResend: boolean;
  canRevoke: boolean;
  canRevealToken: boolean;
};

function useExternalReviewCapabilities(): ExternalReviewCapabilities {
  const canAct = useCan("REVIEWER_OPS_ACT");
  const activeSpace = useActiveSpace();
  // Reveal-token is split-of-duty: require workspace OWNER role on
  // top of REVIEWER_OPS_ACT. ADMIN / MEMBER never get this even
  // when they otherwise have the act capability.
  const isOwner =
    activeSpace?.type === "ORGANIZATION" && activeSpace.roleLabel === "OWNER";
  return {
    canInvite: canAct,
    canBulkInvite: canAct,
    canBulkRevoke: canAct,
    canResend: canAct,
    canRevoke: canAct,
    canRevealToken: canAct && isOwner,
  };
}

// Map the apiFetch error shape to a bounded denial string the UI
// surfaces. Phase 0 finding: the previous catch{} defaulted to
// "RATE_LIMITED" for every error, including 403 NOT_PERMITTED. We
// now distinguish NOT_PERMITTED + FORBIDDEN from rate-limit collapse.
function denialFromError(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e?.code === "string" ? e.code : "";
  const denial = typeof e?.body?.denial === "string" ? e.body.denial : "";
  const details = e?.details;
  const detailsDenial =
    details && typeof details === "object" && typeof details.denial === "string"
      ? (details.denial as string)
      : "";
  if (denial) return denial;
  if (detailsDenial) return detailsDenial;
  if (status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") {
    return "NOT_PERMITTED";
  }
  if (code === "RATE_LIMITED" || status === 429) return "RATE_LIMITED";
  return code || "REFUSED";
}

// ---------------------------------------------------------------------------
// Types — mirror /v1/external-review/invitations response shape
// ---------------------------------------------------------------------------

type LatestDelivery = {
  status: string;
  sentAtUtc: string | null;
  queuedAtUtc: string;
  failureReason: string | null;
  attempt: number;
};

type InvitationRow = {
  grantId: string;
  role: ExternalReviewerRole;
  organization: string | null;
  inviteEmail: string;
  mfaRequired: boolean;
  watermarkPolicy: string;
  inviteSentAtUtc: string;
  inviteAcceptedAtUtc: string | null;
  inviteResentAtUtc: string | null;
  activityCount: number;
  grantState: string | null;
  expiresAtUtc: string | null;
  expired: boolean;
  authMethod: PortalAuthMethod;
  ssoConnectionId: string | null;
  allowedDomains: string[];
  ssoSubjectHash: string | null;
  ssoNameId: string | null;
  ssoBoundAtUtc: string | null;
  mfaSatisfiedAtUtc: string | null;
  latestDelivery: LatestDelivery | null;
};

type ActivityRow = {
  id: string;
  code: string;
  sessionId: string | null;
  payload: unknown;
  occurredAtUtc: string;
  ip?: string | null;
};

type DeliveryRow = {
  id: string;
  status: string;
  provider: string;
  recipientEmail: string;
  subject: string;
  attempt: number;
  queuedAtUtc: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  openedAtUtc: string | null;
  failedAtUtc: string | null;
  revokedAtUtc: string | null;
  expiredAtUtc: string | null;
  failureReason: string | null;
  bulkBatchId: string | null;
};

type BulkOutcomeRow = {
  inviteEmail: string;
  outcome: string;
  grantId: string | null;
  denial: string | null;
};

type TabId =
  | "active"
  | "pending"
  | "accepted"
  | "expired"
  | "revoked"
  | "bulk";

const TAB_ORDER: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "active", label: "Active" },
  { id: "pending", label: "Pending" },
  { id: "accepted", label: "Accepted" },
  { id: "expired", label: "Expired" },
  { id: "revoked", label: "Revoked" },
  { id: "bulk", label: "Bulk Invite" },
];

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export default function ExternalInvitationsPage() {
  return (
    <PageRouteGate routeId="workspace.review_external">
      <ExternalReviewManagementConsole />
    </PageRouteGate>
  );
}

function ExternalReviewManagementConsole() {
  const caps = useExternalReviewCapabilities();
  const teamId = useTeamId();
  // Reuse the canonical step-up flow (same hook + modal as
  // admin/provisioning). Sensitive external-review mutations (bulk
  // issue, break-glass token reveal) run through `runStepUpAction` so a
  // 401 STEP_UP_REQUIRED response surfaces the modal and resumes the
  // original request once the challenge is verified. NEVER a parallel
  // step-up implementation.
  const stepUp = useStepUpAction({ teamId });
  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [listDenied, setListDenied] = useState(false);
  const [tab, setTab] = useState<TabId>("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<{
    tone: "info" | "ok" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/v1/external-review/invitations", {
        method: "GET",
      });
      setRows((res?.invitations ?? []) as InvitationRow[]);
      setListDenied(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] invitations list refresh failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(err);
      setRows([]);
      setListDenied(denial === "NOT_PERMITTED");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(
    () => (rows ? filterRowsForTab(rows, tab) : []),
    [rows, tab],
  );

  const counts = useMemo(() => deriveCounts(rows ?? []), [rows]);

  const selectedRow =
    selected !== null
      ? (rows ?? []).find((r) => r.grantId === selected) ?? null
      : null;

  const onToggleMulti = useCallback((grantId: string) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(grantId)) next.delete(grantId);
      else next.add(grantId);
      return next;
    });
  }, []);

  const onBulkRevoke = useCallback(async () => {
    if (!caps.canBulkRevoke) {
      setBanner({
        tone: "warn",
        text: "Bulk revoke refused: NOT_PERMITTED",
      });
      return;
    }
    const ids = Array.from(multiSelected);
    if (ids.length === 0) return;
    if (ids.length > BULK_INVITATION_MAX_ROWS) {
      setBanner({
        tone: "warn",
        text: `Bulk revoke is bounded to ${BULK_INVITATION_MAX_ROWS} per call.`,
      });
      return;
    }
    try {
      const res = await apiFetch(
        "/v1/external-review/invitations/bulk/revoke",
        {
          method: "POST",
          body: JSON.stringify({ grantIds: ids, reason: "Operator bulk revoke" }),
        },
      );
      const revokedCount =
        (res?.rows as Array<{ outcome: string }> | undefined)?.filter(
          (r) => r.outcome === "REVOKED",
        ).length ?? 0;
      setBanner({
        tone: "ok",
        text: `Bulk revoke: ${revokedCount}/${ids.length} grants revoked.`,
      });
      setMultiSelected(new Set());
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] bulk revoke failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(err);
      setBanner({ tone: "warn", text: `Bulk revoke refused: ${denial}` });
    }
  }, [caps.canBulkRevoke, multiSelected, refresh]);

  return (
    <PageShell
      data-external-review-console
      header={
        <PageHeader
          eyebrow="Enterprise"
          title="External Review Management Console"
          subtitle="Bounded enterprise surface for external reviewer invitations, delivery, federation, and audit. Workspace-anchored — every action you take here is recorded on the grant's audit timeline."
          primaryAction={
            <button
              type="button"
              data-bulk-revoke-action
              data-capability-allowed={caps.canBulkRevoke ? "true" : "false"}
              onClick={onBulkRevoke}
              disabled={!caps.canBulkRevoke || multiSelected.size === 0}
              title={
                !caps.canBulkRevoke
                  ? "You do not have permission to bulk revoke invitations"
                  : multiSelected.size === 0
                  ? "Select at least one row to bulk revoke"
                  : undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 42,
                padding: "0 18px",
                borderRadius: "var(--radius-md, 12px)",
                border: "1px solid var(--status-risk-solid, #dc2626)",
                background:
                  !caps.canBulkRevoke || multiSelected.size === 0
                    ? "var(--status-risk-bg, #fee2e2)"
                    : "var(--status-risk-solid, #dc2626)",
                color:
                  !caps.canBulkRevoke || multiSelected.size === 0
                    ? "var(--status-risk-fg, #7f1d1d)"
                    : "#fff",
                fontSize: 14,
                fontWeight: 650,
                cursor:
                  !caps.canBulkRevoke || multiSelected.size === 0
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              Bulk revoke ({multiSelected.size})
            </button>
          }
        />
      }
    >
      <nav
        data-console-tabs
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border-default, #e2e8f0)",
        }}
      >
        {TAB_ORDER.map((t) => (
          <button
            type="button"
            key={t.id}
            data-tab={t.id}
            data-tab-active={tab === t.id ? "true" : "false"}
            onClick={() => {
              setTab(t.id);
              setSelected(null);
            }}
            style={{
              padding: "9px 14px",
              border: "none",
              background: "transparent",
              borderBottom:
                tab === t.id
                  ? "2px solid var(--ink-primary, #0f172a)"
                  : "2px solid transparent",
              color:
                tab === t.id
                  ? "var(--ink-primary, #0f172a)"
                  : "var(--ink-secondary, #475569)",
              fontWeight: tab === t.id ? 650 : 500,
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            {t.label}
            {t.id !== "bulk" ? (
              <span
                data-tab-count={t.id}
                style={{
                  marginLeft: 6,
                  background: "var(--surface-muted, rgba(15, 23, 42, 0.06))",
                  color: "var(--ink-secondary, #475569)",
                  borderRadius: 999,
                  padding: "1px 7px",
                  fontSize: 11,
                  fontWeight: 650,
                }}
              >
                {counts[t.id] ?? 0}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {listDenied ? (
        <Card
          data-external-review-list-denied
          variant="status"
          tone="neutral"
          padding="compact"
          style={{ fontSize: 13 }}
        >
          You do not have permission to view external reviewer
          invitations. Ask a workspace administrator or supervisor.
        </Card>
      ) : null}

      {banner ? (
        <Card
          data-console-banner
          variant="status"
          tone={
            banner.tone === "ok"
              ? "verified"
              : banner.tone === "warn"
              ? "risk"
              : "info"
          }
          padding="compact"
          style={{ fontSize: 13 }}
        >
          {banner.text}
        </Card>
      ) : null}

      {tab === "bulk" ? (
        <BulkInvitePanel
          caps={caps}
          stepUp={stepUp}
          onCompleted={(text) => {
            setBanner({ tone: "ok", text });
            void refresh();
            setTab("active");
          }}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: selected ? "1.4fr 1fr" : "1fr",
            gap: 14,
          }}
        >
          <InvitationsTable
            rows={filtered}
            multiSelected={multiSelected}
            onSelect={(id) => setSelected(id)}
            onToggleMulti={onToggleMulti}
            selectedId={selected}
          />
          {selectedRow ? (
            <InvitationDetailDrawer
              row={selectedRow}
              caps={caps}
              stepUp={stepUp}
              onClose={() => setSelected(null)}
              onChanged={(text) => {
                setBanner({ tone: "ok", text });
                void refresh();
              }}
              onRefuse={(text) =>
                setBanner({ tone: "warn", text: `Refused: ${text}` })
              }
            />
          ) : null}
        </div>
      )}

      {/* Single centrally-hosted step-up modal — drives the challenge
          flow for bulk issue + break-glass reveal. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab filtering
// ---------------------------------------------------------------------------

function filterRowsForTab(rows: InvitationRow[], tab: TabId): InvitationRow[] {
  switch (tab) {
    case "active":
      return rows.filter(
        (r) =>
          r.grantState !== "REVOKED" &&
          !r.expired &&
          r.inviteAcceptedAtUtc !== null,
      );
    case "pending":
      return rows.filter(
        (r) =>
          r.grantState !== "REVOKED" &&
          !r.expired &&
          r.inviteAcceptedAtUtc === null,
      );
    case "accepted":
      return rows.filter((r) => r.inviteAcceptedAtUtc !== null);
    case "expired":
      return rows.filter((r) => r.expired && r.grantState !== "REVOKED");
    case "revoked":
      return rows.filter((r) => r.grantState === "REVOKED");
    case "bulk":
      return [];
  }
}

function deriveCounts(rows: InvitationRow[]): Record<TabId, number> {
  return {
    active: filterRowsForTab(rows, "active").length,
    pending: filterRowsForTab(rows, "pending").length,
    accepted: filterRowsForTab(rows, "accepted").length,
    expired: filterRowsForTab(rows, "expired").length,
    revoked: filterRowsForTab(rows, "revoked").length,
    bulk: 0,
  };
}

// ---------------------------------------------------------------------------
// Invitations table
// ---------------------------------------------------------------------------

function InvitationsTable({
  rows,
  multiSelected,
  selectedId,
  onSelect,
  onToggleMulti,
}: {
  rows: InvitationRow[];
  multiSelected: Set<string>;
  selectedId: string | null;
  onSelect: (grantId: string) => void;
  onToggleMulti: (grantId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <section data-invitations-empty>
        <EmptyState
          framed
          title="No invitations match this tab"
          purpose="External reviewer invitations in this lifecycle state will appear here."
        />
      </section>
    );
  }
  return (
    <section
      data-invitations-table-wrap
      style={{
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--border-default, rgba(15, 23, 42, 0.08))",
        borderRadius: "var(--radius-card, 12px)",
        padding: 8,
        overflowX: "auto",
      }}
    >
      <table
        data-invitations-table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "var(--ink-muted, #94a3b8)" }}>
            <th style={th}></th>
            <th style={th}>Email</th>
            <th style={th}>Role</th>
            <th style={th}>Auth</th>
            <th style={th}>MFA</th>
            <th style={th}>Watermark</th>
            <th style={th}>Delivery</th>
            <th style={th}>Sent</th>
            <th style={th}>Expires</th>
            <th style={th}>Activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSelected = selectedId === r.grantId;
            return (
              <tr
                key={r.grantId}
                data-invitation-row={r.grantId}
                data-row-selected={isSelected ? "true" : "false"}
                onClick={() => onSelect(r.grantId)}
                style={{
                  cursor: "pointer",
                  background: isSelected
                    ? "var(--surface-muted, rgba(15, 23, 42, 0.04))"
                    : undefined,
                }}
              >
                <td style={td} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    data-row-multi={r.grantId}
                    checked={multiSelected.has(r.grantId)}
                    onChange={() => onToggleMulti(r.grantId)}
                  />
                </td>
                <td style={td}>{r.inviteEmail}</td>
                <td style={td}>
                  <code>{r.role}</code>
                </td>
                <td style={td}>
                  <Chip
                    data-auth-chip={r.authMethod}
                    tone={r.authMethod === "SSO" ? "info" : "muted"}
                    label={r.authMethod}
                  />
                </td>
                <td style={td}>{r.mfaRequired ? "Yes" : "No"}</td>
                <td style={td}>{r.watermarkPolicy}</td>
                <td style={td}>
                  {r.latestDelivery ? (
                    <Chip
                      data-delivery-chip={r.latestDelivery.status}
                      tone={deliveryTone(r.latestDelivery.status)}
                      label={r.latestDelivery.status}
                    />
                  ) : (
                    <span style={{ color: "var(--ink-muted, #94a3b8)" }}>—</span>
                  )}
                </td>
                <td style={td}>
                  {formatUserDate(r.inviteSentAtUtc)}
                </td>
                <td style={td}>
                  {r.expiresAtUtc
                    ? formatUserDate(r.expiresAtUtc)
                    : "—"}
                </td>
                <td style={td}>{r.activityCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function InvitationDetailDrawer({
  row,
  caps,
  stepUp,
  onClose,
  onChanged,
  onRefuse,
}: {
  row: InvitationRow;
  caps: ExternalReviewCapabilities;
  stepUp: ReturnType<typeof useStepUpAction>;
  onClose: () => void;
  onChanged: (msg: string) => void;
  onRefuse: (msg: string) => void;
}) {
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null>(null);
  const [revealed, setRevealed] = useState<{
    rawToken: string;
    issuedFor: "operator-break-glass";
  } | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const a = await apiFetch(
          `/v1/external-review/invitations/${row.grantId}/activity`,
          { method: "GET" },
        );
        setActivity((a?.activity ?? []) as ActivityRow[]);
      } catch {
        setActivity([]);
      }
      try {
        const d = await apiFetch(
          `/v1/external-review/invitations/${row.grantId}/delivery`,
          { method: "GET" },
        );
        setDeliveries((d?.deliveries ?? []) as DeliveryRow[]);
      } catch {
        setDeliveries([]);
      }
    })();
  }, [row.grantId]);

  const onResend = useCallback(async () => {
    if (!caps.canResend) {
      onRefuse("NOT_PERMITTED");
      return;
    }
    try {
      await apiFetch(
        `/v1/external-review/invitations/${row.grantId}/resend`,
        { method: "POST", body: "{}" },
      );
      onChanged(`Resent invitation email for ${row.inviteEmail}.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] resend invitation failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      onRefuse(denialFromError(err));
    }
  }, [caps.canResend, row.grantId, row.inviteEmail, onChanged, onRefuse]);

  const onRevoke = useCallback(async () => {
    if (!caps.canRevoke) {
      onRefuse("NOT_PERMITTED");
      return;
    }
    try {
      await apiFetch(
        `/v1/external-review/invitations/${row.grantId}/revoke`,
        { method: "POST", body: "{}" },
      );
      onChanged(`Revoked invitation ${row.grantId.slice(0, 8)}…`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] revoke invitation failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      onRefuse(denialFromError(err));
    }
  }, [caps.canRevoke, row.grantId, onChanged, onRefuse]);

  return (
    <aside
      data-invitation-detail-drawer
      data-grant-id={row.grantId}
      style={{
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--border-default, rgba(15, 23, 42, 0.1))",
        borderRadius: "var(--radius-card, 12px)",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 15, margin: 0, flex: 1, color: "var(--ink-primary, #0f172a)" }}>
          {row.inviteEmail}
        </h2>
        <button
          type="button"
          data-drawer-close
          onClick={onClose}
          style={drawerCloseStyle}
        >
          Close
        </button>
      </div>

      <div style={chipsRowStyle}>
        <Chip
          tone={row.grantState === "REVOKED" ? "warn" : row.expired ? "warn" : "ok"}
          label={`State: ${row.grantState ?? "—"}`}
        />
        <Chip tone="muted" label={`Role: ${row.role}`} />
        <Chip tone="info" label={`Auth: ${row.authMethod}`} />
        {row.mfaRequired ? <Chip tone="warn" label="MFA required" /> : null}
        <Chip tone="muted" label={`Watermark: ${row.watermarkPolicy}`} />
        {row.expiresAtUtc ? (
          <Chip
            tone={row.expired ? "warn" : "muted"}
            label={`Expires ${formatUserDateTime(row.expiresAtUtc)}`}
          />
        ) : null}
        {row.ssoConnectionId ? (
          <Chip
            tone="info"
            label={`SSO bound: ${row.ssoConnectionId.slice(0, 8)}…`}
          />
        ) : null}
        {row.ssoSubjectHash ? (
          <Chip
            tone="ok"
            label={`SSO subject pinned`}
          />
        ) : null}
      </div>

      <section
        data-drawer-actions
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          data-invitation-resend={row.grantId}
          data-capability-allowed={caps.canResend ? "true" : "false"}
          onClick={onResend}
          disabled={!caps.canResend}
          title={
            !caps.canResend
              ? "You do not have permission to resend invitations"
              : undefined
          }
          style={{
            ...primaryActionStyle,
            ...(caps.canResend
              ? {}
              : {
                  background: "var(--ink-muted, #94a3b8)",
                  border: "1px solid var(--ink-muted, #94a3b8)",
                  cursor: "not-allowed",
                }),
          }}
        >
          Resend invitation email
        </button>
        <button
          type="button"
          data-invitation-revoke={row.grantId}
          data-capability-allowed={caps.canRevoke ? "true" : "false"}
          onClick={onRevoke}
          disabled={!caps.canRevoke}
          title={
            !caps.canRevoke
              ? "You do not have permission to revoke invitations"
              : undefined
          }
          style={{
            ...dangerActionStyle,
            ...(caps.canRevoke
              ? {}
              : {
                  color: "var(--ink-muted, #94a3b8)",
                  borderColor: "var(--border-default, #cbd5e1)",
                  cursor: "not-allowed",
                }),
          }}
        >
          Revoke
        </button>
      </section>

      <section
        data-drawer-break-glass
        style={{
          background: "var(--status-pending-bg, rgba(245, 158, 11, 0.08))",
          border: "1px dashed var(--status-pending-solid, rgba(245, 158, 11, 0.5))",
          borderRadius: "var(--radius-md, 8px)",
          padding: 8,
          fontSize: 11,
          color: "var(--status-pending-fg, #EA580C)",
        }}
      >
        <strong style={{ display: "block", marginBottom: 4 }}>
          Break-glass: manual token reveal
        </strong>
        <p style={{ margin: 0, marginBottom: 6 }}>
          Manual token reveal is for fallback only — the normal
          enterprise flow is the invitation email + optional SSO. Use
          this only when the recipient cannot receive the email.
        </p>
        {!revealed && !confirmReveal ? (
          <button
            type="button"
            data-break-glass-arm
            data-capability-allowed={caps.canRevealToken ? "true" : "false"}
            onClick={() => {
              if (!caps.canRevealToken) return;
              setConfirmReveal(true);
            }}
            disabled={!caps.canRevealToken}
            title={
              caps.canRevealToken
                ? undefined
                : "You do not have permission to reveal raw invitation tokens. Token reveal is restricted to the workspace OWNER as a split-of-duty control — workspace ADMIN and SUPERVISOR cannot perform it."
            }
            style={{
              ...subtleActionStyle,
              ...(caps.canRevealToken
                ? {}
                : {
                    color: "var(--ink-muted, #94a3b8)",
                    cursor: "not-allowed",
                    background: "var(--surface-muted, #f8fafc)",
                  }),
            }}
          >
            Enable token reveal
          </button>
        ) : null}
        {confirmReveal && !revealed && caps.canRevealToken ? (
          <BreakGlassReveal
            grantId={row.grantId}
            stepUp={stepUp}
            onCancel={() => setConfirmReveal(false)}
            onRevealed={(rawToken) => {
              setRevealed({
                rawToken,
                issuedFor: "operator-break-glass",
              });
              setConfirmReveal(false);
            }}
          />
        ) : null}
        {revealed ? (
          <div style={{ marginTop: 6 }}>
            <strong>Raw token (shown ONCE):</strong>
            <textarea
              data-break-glass-token
              readOnly
              rows={2}
              value={revealed.rawToken}
              style={{
                width: "100%",
                marginTop: 4,
                padding: 6,
                border: "1px solid var(--status-pending-border, #fcd34d)",
                borderRadius: "var(--radius-sm, 6px)",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 11,
                background: "var(--surface-card, #fff)",
              }}
            />
            <button
              type="button"
              data-break-glass-clear
              onClick={() => setRevealed(null)}
              style={{ ...subtleActionStyle, marginTop: 4 }}
            >
              I have copied the token
            </button>
          </div>
        ) : null}
      </section>

      <section
        data-drawer-delivery-panel
        style={cardStyle}
      >
        <strong style={cardTitleStyle}>Delivery status</strong>
        {deliveries === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : deliveries.length === 0 ? (
          <p style={mutedStyle}>No invitation emails have been sent yet.</p>
        ) : (
          <table
            data-deliveries-table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-muted, #94a3b8)" }}>
                <th style={th}>Status</th>
                <th style={th}>Attempt</th>
                <th style={th}>Provider</th>
                <th style={th}>Queued</th>
                <th style={th}>Sent</th>
                <th style={th}>Failure</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} data-delivery-row={d.id}>
                  <td style={td}>
                    <Chip
                      data-delivery-status={d.status}
                      tone={deliveryTone(d.status)}
                      label={d.status}
                    />
                  </td>
                  <td style={td}>{d.attempt}</td>
                  <td style={td}>
                    <code>{d.provider}</code>
                  </td>
                  <td style={td}>
                    {formatUserDateTime(d.queuedAtUtc)}
                  </td>
                  <td style={td}>
                    {d.sentAtUtc
                      ? formatUserDateTime(d.sentAtUtc)
                      : "—"}
                  </td>
                  <td style={td}>
                    {d.failureReason ? (
                      <code style={{ color: "var(--status-risk-fg, #991b1b)" }}>
                        {d.failureReason}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        data-drawer-sso-panel
        style={cardStyle}
      >
        <strong style={cardTitleStyle}>SSO federation</strong>
        <div style={{ fontSize: 12, color: "var(--ink-primary, #0f172a)" }}>
          <p style={{ margin: 0, marginBottom: 4 }}>
            Auth method: <code data-sso-auth-method>{row.authMethod}</code>
          </p>
          <p style={{ margin: 0, marginBottom: 4 }}>
            SSO connection:{" "}
            <code data-sso-connection-id>
              {row.ssoConnectionId ?? "(none)"}
            </code>
          </p>
          <p style={{ margin: 0, marginBottom: 4 }}>
            Allowed domains:{" "}
            {row.allowedDomains.length === 0 ? (
              <span style={mutedStyle}>(exact email match required)</span>
            ) : (
              <span data-sso-allowed-domains>
                {row.allowedDomains.map((d) => (
                  <Chip key={d} tone="info" label={d} />
                ))}
              </span>
            )}
          </p>
          {row.ssoBoundAtUtc ? (
            <p style={{ margin: 0, marginBottom: 4 }}>
              SSO bound at:{" "}
              <span data-sso-bound-at>
                {formatUserDateTime(row.ssoBoundAtUtc)}
              </span>
            </p>
          ) : null}
          {row.ssoSubjectHash ? (
            <p style={{ margin: 0 }}>
              Subject hash pinned ({row.ssoSubjectHash.slice(0, 8)}…). Any
              future SSO assertion with a different nameId will be
              refused.
            </p>
          ) : null}
        </div>
      </section>

      <section
        data-drawer-activity-panel
        style={cardStyle}
      >
        <strong style={cardTitleStyle}>Activity timeline</strong>
        {activity === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : activity.length === 0 ? (
          <p style={mutedStyle}>No activity recorded yet.</p>
        ) : (
          <ul
            data-activity-timeline
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {activity.map((a) => (
              <li
                key={a.id}
                data-activity-row={a.code}
                style={{
                  borderTop: "1px solid var(--border-subtle, #f1f5f9)",
                  padding: "4px 0",
                  fontSize: 11,
                  display: "flex",
                  gap: 8,
                }}
              >
                <code style={{ minWidth: 220 }}>{a.code}</code>
                <span style={{ color: "var(--ink-secondary, #475569)" }}>
                  {formatUserDateTime(a.occurredAtUtc)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function BreakGlassReveal({
  grantId,
  stepUp,
  onCancel,
  onRevealed,
}: {
  grantId: string;
  stepUp: ReturnType<typeof useStepUpAction>;
  onCancel: () => void;
  onRevealed: (rawToken: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onConfirm = useCallback(async () => {
    if (reason.trim().length < 10) {
      setErr("Provide a brief operator reason (≥ 10 chars).");
      return;
    }
    setBusy(true);
    try {
      // Break-glass reveal ROTATES the grant token and returns a fresh
      // raw token — sensitive, so it is step-up gated on the backend.
      // Wrap in `runStepUpAction`: a 401 STEP_UP_REQUIRED surfaces the
      // modal and the request resumes (with the challenge header) once
      // verified. This deliberately requires a confirmed reason so it
      // is auditable.
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(
          `/v1/external-review/invitations/${grantId}/reveal-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(headers ?? {}),
            },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        ),
      )) as { rawToken?: string } | null;
      if (typeof res?.rawToken === "string") {
        onRevealed(res.rawToken);
      } else {
        setErr("Reveal denied — see audit timeline.");
      }
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setErr("Step-up cancelled — token was not revealed.");
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("[external-review] reveal token failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (e as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (e as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(e);
      setErr(denial === "REFUSED" ? "REVEAL_REFUSED" : denial);
    } finally {
      setBusy(false);
    }
  }, [grantId, reason, onRevealed, stepUp]);
  return (
    <div data-break-glass-form>
      <textarea
        data-break-glass-reason
        rows={2}
        placeholder="Operator reason (e.g. reviewer cannot receive email — Acme Co.)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{
          width: "100%",
          padding: 6,
          marginBottom: 4,
          border: "1px solid var(--status-pending-border, #fcd34d)",
          borderRadius: "var(--radius-sm, 6px)",
          fontSize: 11,
        }}
      />
      {err ? (
        <p style={{ color: "var(--status-risk-fg, #991b1b)", fontSize: 11, margin: "0 0 4px" }}>
          {err}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          data-break-glass-confirm
          onClick={onConfirm}
          disabled={busy}
          style={{
            ...primaryActionStyle,
            background: busy ? "var(--ink-muted, #94a3b8)" : "#b45309",
            border: "1px solid #b45309",
          }}
        >
          {busy ? "Revealing…" : "Reveal raw token"}
        </button>
        <button
          type="button"
          data-break-glass-cancel
          onClick={onCancel}
          style={subtleActionStyle}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Invite panel
// ---------------------------------------------------------------------------

function BulkInvitePanel({
  caps,
  stepUp,
  onCompleted,
}: {
  caps: ExternalReviewCapabilities;
  stepUp: ReturnType<typeof useStepUpAction>;
  onCompleted: (msg: string) => void;
}) {
  const { addToast } = useToast();
  const [pasted, setPasted] = useState("");
  const [hours, setHours] = useState(72);
  const [defaultRole, setDefaultRole] = useState<ExternalReviewerRole>(
    "EXTERNAL_REVIEWER",
  );
  const [defaultWatermark, setDefaultWatermark] = useState<
    "ALWAYS" | "BYTES_ONLY" | "NEVER"
  >("ALWAYS");
  const [defaultMfa, setDefaultMfa] = useState(false);
  const [authMethod, setAuthMethod] = useState<PortalAuthMethod>("TOKEN");
  const [ssoConnectionId, setSsoConnectionId] = useState("");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<{
    bulkBatchId: string;
    summary: Record<string, number>;
    rows: BulkOutcomeRow[];
  } | null>(null);

  const parsed = useMemo(() => parseBulkPaste(pasted), [pasted]);

  const onIssueBulk = useCallback(async () => {
    if (!caps.canBulkInvite) {
      setOutcomes({
        bulkBatchId: "",
        summary: {},
        rows: parsed.map((p) => ({
          inviteEmail: p.email,
          outcome: "FAILED",
          grantId: null,
          denial: "NOT_PERMITTED",
        })),
      });
      return;
    }
    if (parsed.length === 0) return;
    if (parsed.length > BULK_INVITATION_MAX_ROWS) return;
    setBusy(true);
    try {
      const allowedDomainList = allowedDomains
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean);
      // Bulk issue grants multiple outside reviewers access to sensitive
      // evidence — step-up gated on the backend. Wrap in
      // `runStepUpAction`: a 401 STEP_UP_REQUIRED surfaces the modal and
      // the request resumes (with the challenge header) once verified.
      const res = await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/external-review/invitations/bulk", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(headers ?? {}),
          },
          body: JSON.stringify({
            expiresAtUtc: new Date(
              Date.now() + hours * 3600 * 1000,
            ).toISOString(),
            defaultRole,
            defaultWatermarkPolicy: defaultWatermark,
            defaultMfaRequired: defaultMfa,
            defaultScope: { kind: "PACKAGE" },
            rows: parsed.map((p) => ({
              inviteEmail: p.email,
              displayName: p.displayName,
              organization: p.organization,
            })),
            // Federation defaults — surfaced for honest UX but the
            // closure SSO binding actually flips authMethod when the
            // first successful SSO bind occurs (server-side).
            defaultAuthMethod: authMethod,
            defaultSsoConnectionId: ssoConnectionId || undefined,
            defaultAllowedDomains: allowedDomainList,
          }),
        }),
      );
      setOutcomes({
        bulkBatchId: res.bulkBatchId,
        summary: res.summary as Record<string, number>,
        rows: res.rows as BulkOutcomeRow[],
      });
      const invited =
        (res.rows as BulkOutcomeRow[]).filter((r) => r.outcome === "INVITED")
          .length ?? 0;
      onCompleted(
        `Bulk invite: ${invited}/${parsed.length} invitations sent.`,
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        // Operator cancelled the step-up challenge — nothing was issued.
        // The modal already conveyed the cancel; surface a bounded
        // per-row outcome so the table doesn't look silently stuck.
        setOutcomes({
          bulkBatchId: "",
          summary: {},
          rows: parsed.map((p) => ({
            inviteEmail: p.email,
            outcome: "FAILED",
            grantId: null,
            denial: "STEP_UP_CANCELLED",
          })),
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("[external-review] bulk invite failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      notifyApiError(addToast, err, {
        message: toSafeUserError(err, {
          message: "We couldn't issue these invitations.",
        }).message,
      });
      const denial = denialFromError(err);
      setOutcomes({
        bulkBatchId: "",
        summary: {},
        rows: parsed.map((p) => ({
          inviteEmail: p.email,
          outcome: "FAILED",
          grantId: null,
          denial,
        })),
      });
    } finally {
      setBusy(false);
    }
  }, [
    caps.canBulkInvite,
    parsed,
    hours,
    defaultRole,
    defaultWatermark,
    defaultMfa,
    authMethod,
    ssoConnectionId,
    allowedDomains,
    onCompleted,
    stepUp,
    addToast,
  ]);

  return (
    <section
      data-bulk-invite-panel
      style={{
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--border-default, rgba(15, 23, 42, 0.08))",
        borderRadius: "var(--radius-card, 12px)",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h2 style={{ fontSize: 15, margin: 0, color: "var(--ink-primary, #0f172a)" }}>Bulk invite external reviewers</h2>
        <p style={{ color: "var(--ink-secondary, #475569)", fontSize: 12, margin: "4px 0 0" }}>
          Paste one reviewer per line. Accepted formats:
        </p>
        <ul
          style={{
            margin: "4px 0",
            paddingLeft: 18,
            fontSize: 11,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          <li>
            <code>reviewer@example.com</code>
          </li>
          <li>
            <code>reviewer@example.com,Display Name</code>
          </li>
          <li>
            <code>reviewer@example.com,Display Name,Organization</code>
          </li>
        </ul>
        <p style={{ color: "var(--ink-secondary, #475569)", fontSize: 11, margin: 0 }}>
          Bounded ≤ {BULK_INVITATION_MAX_ROWS} rows per call. One failing
          row never aborts the batch.
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: 12,
        }}
      >
        <Field label={`Reviewers (≤ ${BULK_INVITATION_MAX_ROWS})`}>
          <textarea
            data-bulk-paste
            rows={10}
            placeholder={"reviewer@example.com\nsue@acme.com,Sue Q.,Acme"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            style={{
              width: "100%",
              padding: 8,
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              border: "1px solid var(--border-default, #cbd5e1)",
              borderRadius: "var(--radius-md, 8px)",
              background: "var(--surface-card, #fff)",
              color: "var(--ink-primary, #0f172a)",
              boxSizing: "border-box",
            }}
          />
          <small
            data-bulk-paste-count
            style={{ color: "var(--ink-secondary, #475569)", fontSize: 11 }}
          >
            {parsed.length} rows parsed · invalid rows are flagged inline.
          </small>
          {parsed.length > 0 ? (
            <table
              data-bulk-paste-preview
              style={{
                width: "100%",
                marginTop: 4,
                borderCollapse: "collapse",
                fontSize: 11,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-muted, #94a3b8)" }}>
                  <th style={th}>Email</th>
                  <th style={th}>Display</th>
                  <th style={th}>Org</th>
                  <th style={th}>Validity</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((p, idx) => (
                  <tr
                    key={`${idx}-${p.email}`}
                    data-bulk-paste-row={idx}
                    data-bulk-paste-valid={p.valid ? "true" : "false"}
                  >
                    <td style={td}>{p.email}</td>
                    <td style={td}>{p.displayName ?? "—"}</td>
                    <td style={td}>{p.organization ?? "—"}</td>
                    <td style={td}>
                      {p.valid ? (
                        <Chip tone="ok" label="VALID" />
                      ) : (
                        <Chip tone="warn" label="INVALID_EMAIL" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Field>

        <div style={{ display: "grid", gap: 8 }}>
          <Field label="Default role">
            <select
              data-bulk-default-role
              value={defaultRole}
              onChange={(e) =>
                setDefaultRole(e.target.value as ExternalReviewerRole)
              }
              style={inputStyle}
            >
              {EXTERNAL_REVIEWER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Default watermark policy">
            <select
              data-bulk-default-watermark
              value={defaultWatermark}
              onChange={(e) =>
                setDefaultWatermark(e.target.value as typeof defaultWatermark)
              }
              style={inputStyle}
            >
              {WATERMARK_POLICIES.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Expires in (hours)">
            <input
              data-bulk-default-hours
              type="number"
              min={1}
              max={720}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              style={inputStyle}
            />
          </Field>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
            }}
          >
            <input
              data-bulk-default-mfa
              type="checkbox"
              checked={defaultMfa}
              onChange={(e) => setDefaultMfa(e.target.checked)}
            />
            Require MFA for each row
          </label>

          <hr
            style={{
              border: "none",
              borderTop: "1px solid var(--border-default, #e2e8f0)",
              margin: "4px 0",
            }}
          />
          <strong style={{ fontSize: 12, color: "var(--ink-primary, #0f172a)" }}>
            SSO controls
          </strong>
          <Field label="Auth method">
            <select
              data-bulk-auth-method
              value={authMethod}
              onChange={(e) =>
                setAuthMethod(e.target.value as PortalAuthMethod)
              }
              style={inputStyle}
            >
              {PORTAL_AUTH_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="SSO connection id (optional)">
            <input
              data-bulk-sso-connection
              placeholder="00000000-0000-0000-0000-000000000000"
              value={ssoConnectionId}
              onChange={(e) => setSsoConnectionId(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Allowed SSO domains (comma-separated)">
            <input
              data-bulk-allowed-domains
              placeholder="acme.com, acme.co.uk"
              value={allowedDomains}
              onChange={(e) => setAllowedDomains(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>
      </div>

      <div>
        <button
          type="button"
          data-bulk-issue-submit
          data-capability-allowed={caps.canBulkInvite ? "true" : "false"}
          onClick={onIssueBulk}
          disabled={
            !caps.canBulkInvite ||
            busy ||
            parsed.length === 0 ||
            parsed.length > BULK_INVITATION_MAX_ROWS
          }
          title={
            !caps.canBulkInvite
              ? "You do not have permission to bulk issue invitations"
              : undefined
          }
          style={{
            ...primaryActionStyle,
            background:
              !caps.canBulkInvite ||
              busy ||
              parsed.length === 0 ||
              parsed.length > BULK_INVITATION_MAX_ROWS
                ? "var(--ink-muted, #94a3b8)"
                : "var(--ink-primary, #0f172a)",
            cursor:
              !caps.canBulkInvite ||
              busy ||
              parsed.length === 0 ||
              parsed.length > BULK_INVITATION_MAX_ROWS
                ? "not-allowed"
                : "pointer",
          }}
        >
          {busy
            ? "Issuing…"
            : `Issue ${parsed.length} invitation${parsed.length === 1 ? "" : "s"}`}
        </button>
      </div>

      {outcomes ? (
        <section data-bulk-outcomes>
          <strong style={{ fontSize: 12 }}>
            Batch <code>{outcomes.bulkBatchId.slice(0, 8) || "(no batch)"}…</code>
          </strong>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {Object.entries(outcomes.summary).map(([k, v]) => (
              <Chip
                key={k}
                tone={k === "INVITED" ? "ok" : k === "FAILED" ? "warn" : "muted"}
                label={`${k}: ${v}`}
              />
            ))}
          </div>
          <table
            data-bulk-outcome-table
            style={{
              width: "100%",
              marginTop: 6,
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-muted, #94a3b8)" }}>
                <th style={th}>Email</th>
                <th style={th}>Outcome</th>
                <th style={th}>Grant</th>
                <th style={th}>Denial</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.rows.map((r, idx) => (
                <tr
                  key={`${idx}-${r.inviteEmail}`}
                  data-bulk-outcome-row={r.inviteEmail}
                  data-bulk-outcome={r.outcome}
                >
                  <td style={td}>{r.inviteEmail}</td>
                  <td style={td}>
                    <Chip
                      tone={
                        r.outcome === "INVITED"
                          ? "ok"
                          : r.outcome === "DUPLICATE"
                          ? "info"
                          : "warn"
                      }
                      label={r.outcome}
                    />
                  </td>
                  <td style={td}>
                    {r.grantId ? <code>{r.grantId.slice(0, 8)}…</code> : "—"}
                  </td>
                  <td style={td}>
                    {r.denial ? <code>{r.denial}</code> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParsedBulkRow = {
  email: string;
  displayName?: string;
  organization?: string;
  valid: boolean;
};

function parseBulkPaste(text: string): ParsedBulkRow[] {
  if (!text || !text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return lines.slice(0, BULK_INVITATION_MAX_ROWS).map((line) => {
    const parts = line.split(",").map((p) => p.trim());
    const email = parts[0] ?? "";
    const displayName = parts[1] ? parts[1] : undefined;
    const organization = parts[2] ? parts[2] : undefined;
    return {
      email,
      displayName,
      organization,
      valid: isEmail(email),
    };
  });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function deliveryTone(status: string): "ok" | "info" | "muted" | "warn" {
  switch (status) {
    case "SENT":
    case "DELIVERED":
    case "OPENED":
      return "ok";
    case "PENDING":
      return "info";
    case "REVOKED":
    case "EXPIRED":
      return "muted";
    case "FAILED":
    default:
      return "warn";
  }
}

function Chip({
  label,
  tone,
  ...rest
}: {
  label: string;
  tone: "ok" | "info" | "muted" | "warn";
} & React.HTMLAttributes<HTMLSpanElement>) {
  const palette = {
    ok: {
      bg: "var(--status-verified-bg, #ecfdf5)",
      fg: "var(--status-verified-fg, #065f46)",
      border: "var(--status-verified-border, #a7f3d0)",
    },
    info: {
      bg: "var(--status-info-bg, #eff6ff)",
      fg: "var(--status-info-fg, #1e40af)",
      border: "var(--status-info-border, #bfdbfe)",
    },
    muted: {
      bg: "var(--status-neutral-bg, #f1f5f9)",
      fg: "var(--status-neutral-fg, #475569)",
      border: "var(--status-neutral-border, #cbd5e1)",
    },
    warn: {
      bg: "var(--status-risk-bg, #fef2f2)",
      fg: "var(--status-risk-fg, #991b1b)",
      border: "var(--status-risk-border, #fecaca)",
    },
  }[tone];
  return (
    <span
      {...rest}
      style={{
        display: "inline-block",
        padding: "1px 8px",
        marginRight: 4,
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <small style={{ fontSize: 11, color: "var(--ink-secondary, #475569)", fontWeight: 600 }}>
        {label}
      </small>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Inline style constants
// ---------------------------------------------------------------------------

const inputStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid var(--border-default, #cbd5e1)",
  borderRadius: "var(--radius-sm, 6px)",
  fontSize: 12,
  background: "var(--surface-card, #fff)",
  color: "var(--ink-primary, #0f172a)",
  boxSizing: "border-box" as const,
};

const th = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-default, #e2e8f0)",
} as const;
const td = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-subtle, #f1f5f9)",
} as const;

const cardStyle = {
  background: "var(--surface-muted, rgba(15, 23, 42, 0.03))",
  border: "1px solid var(--border-subtle, rgba(15, 23, 42, 0.06))",
  borderRadius: "var(--radius-md, 10px)",
  padding: 10,
} as const;
const cardTitleStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 650,
  marginBottom: 6,
  color: "var(--ink-primary, #0f172a)",
} as const;
const mutedStyle = {
  color: "var(--ink-secondary, #475569)",
  fontSize: 12,
  margin: 0,
} as const;
const chipsRowStyle = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap" as const,
};
const drawerCloseStyle = {
  background: "transparent",
  border: "1px solid var(--border-default, #cbd5e1)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: "3px 10px",
  fontSize: 11,
  color: "var(--ink-secondary, #475569)",
  cursor: "pointer",
} as const;
const primaryActionStyle = {
  padding: "8px 14px",
  border: "1px solid var(--ink-primary, #0f172a)",
  background: "var(--ink-primary, #0f172a)",
  color: "var(--ink-inverse, #fafafa)",
  fontWeight: 650,
  fontSize: 12.5,
  borderRadius: "var(--radius-md, 8px)",
  cursor: "pointer",
} as const;
const dangerActionStyle = {
  padding: "8px 14px",
  border: "1px solid var(--status-risk-solid, #dc2626)",
  background: "var(--surface-card, #fff)",
  color: "var(--status-risk-solid, #dc2626)",
  fontWeight: 650,
  fontSize: 12.5,
  borderRadius: "var(--radius-md, 8px)",
  cursor: "pointer",
} as const;
const subtleActionStyle = {
  padding: "5px 10px",
  border: "1px solid var(--border-default, #cbd5e1)",
  background: "var(--surface-card, #fff)",
  color: "var(--ink-primary, #0f172a)",
  fontSize: 11,
  borderRadius: "var(--radius-sm, 6px)",
  cursor: "pointer",
} as const;
