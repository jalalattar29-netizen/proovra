"use client";

/**
 * PHASE 12B C10 — Support Access and Break-Glass (RESTRICTED PLATFORM STAFF).
 *
 * These are internal staff capabilities, NOT ordinary Organization-admin
 * features, so this surface lives under the existing `/admin/*` internal shell:
 * `apps/web/app/(app)/admin/layout.tsx` gates every page beneath it with the
 * canonical `platform.admin` route gate (PLATFORM_ADMIN capability +
 * PLATFORM_ADMIN active space). The backend is the authoritative boundary — the
 * six support/break-glass routes now require platform-staff status resolved
 * from persistence and return a flat 404 to a customer admin, so this page can
 * never be the thing that grants access.
 *
 * What this surface is for:
 *   * see the support-access grant lifecycle (dual identity: which support
 *     actor, which customer Organization, what scope, why, until when);
 *   * enter support context for a grant the caller already holds — the server
 *     re-validates the grant and mints an opaque token BOUND to the caller's
 *     current session;
 *   * revoke a support grant;
 *   * see and revoke break-glass emergency grants.
 *
 * Secret discipline (hard rule):
 *   * the support-context token returned by `/v1/support-access/enter` is held
 *     in a React ref for the lifetime of the tab and NEVER written to state
 *     that renders, never to localStorage/sessionStorage, never to a URL, never
 *     logged. Only its presence and expiry are shown.
 *   * grant projections are secret-free by construction: the break-glass
 *     step-up proof id is reduced server-side to `stepUpProofRecorded`.
 *
 * This page mints nothing itself: starting a support grant requires a customer
 * approver identity and a reason, and activating break-glass requires a
 * pre-configured emergency identity — both are deliberately performed through
 * the incident workflow, not casually from a console. What this page adds is
 * VISIBILITY, ENTRY and REVOCATION, which is what an on-call responder needs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId, useTenantGuard } from "../../../../lib/platform-context";
import { ResultCount } from "../../../../components/ui/ResultCount";

// ---------------------------------------------------------------------------
// Server projections (secret-free by construction — see the route file).
// ---------------------------------------------------------------------------

type SupportGrant = {
  id: string;
  supportUserId: string;
  organizationId: string;
  teamId: string | null;
  reason: string;
  accessLevel: string;
  status: string;
  approvedByUserId: string | null;
  startedAtUtc: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  expired: boolean;
};

type EmergencyGrant = {
  id: string;
  organizationId: string;
  emergencyUserId: string;
  grantedRole: string;
  reason: string;
  status: string;
  requestedByUserId: string;
  stepUpProofRecorded: boolean;
  startedAtUtc: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  expired: boolean;
};

type SurfaceFailure = { kind: "denied" | "error"; message: string };

/**
 * A platform-staff denial on this surface is a flat 404 by design (a customer
 * admin must not learn the support surface exists), so 403 and 404 collapse to
 * the same operator-facing state.
 */
function classifyFailure(err: unknown, fallback: string): SurfaceFailure {
  const e = err as { statusCode?: number };
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return {
      kind: "denied",
      message:
        "This surface requires platform-staff access. Your account does not hold it in the current context.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, { message: fallback }).message,
  };
}

const STATUS_FILTERS = [
  { value: "ACTIVE", label: "Active" },
  { value: "", label: "All statuses" },
  { value: "REVOKED", label: "Revoked" },
  { value: "EXPIRED", label: "Expired" },
] as const;

export default function SupportAccessPage() {
  // The /admin/* layout applies the canonical `platform.admin` gate, but the
  // CR0 freeze baseline requires every (app) page to carry its own
  // <PageRouteGate> or a documented exemption — a layout gate is not visible to
  // that guard, and relying on it alone means a future move of this file out of
  // /admin/* would silently drop the gate. `platform.support_access` is the
  // route id registered for this page (PLATFORM_ADMIN capability +
  // PLATFORM_ADMIN active space), so this is the same gate stated explicitly.
  return (
    <PageRouteGate routeId="platform.support_access">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  // Support grants
  const [supportGrants, setSupportGrants] = useState<SupportGrant[] | null>(null);
  // Kept separate from the rows: `total` is a server count over the same
  // filter, `limit` the cap the request actually sent.
  const [supportGrantsTotal, setSupportGrantsTotal] = useState<number | null>(
    null,
  );
  const [supportGrantsLimit, setSupportGrantsLimit] = useState<number | null>(
    null,
  );
  const [supportFailure, setSupportFailure] = useState<SurfaceFailure | null>(null);
  const [supportStatus, setSupportStatus] = useState<string>("ACTIVE");
  const [showAllActors, setShowAllActors] = useState(false);

  // Break-glass grants
  const [emergencyGrants, setEmergencyGrants] = useState<EmergencyGrant[] | null>(
    null,
  );
  const [emergencyFailure, setEmergencyFailure] = useState<SurfaceFailure | null>(
    null,
  );
  const [emergencyStatus, setEmergencyStatus] = useState<string>("ACTIVE");

  const [mutating, setMutating] = useState(false);
  const [mutationFailure, setMutationFailure] = useState<SurfaceFailure | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * ADM-021 — MINTING a grant, which this console could not do.
   *
   * `/v1/support-access/start` and `/v1/break-glass/activate` were fully
   * implemented, platform-staff gated, workspace-authorized, step-up protected
   * and audited — and had no caller anywhere in the product. The console could
   * only ENTER and REVOKE grants that something else had already created, and
   * nothing else ever did: the page's own copy pointed at an "incident
   * workflow" that does not exist in this codebase.
   *
   * These forms add NO authority. Every decision — who may mint, over which
   * organization, with what second factor — still belongs to the route and the
   * services behind it. What changes is that the capability is reachable.
   */
  const [mintOrgId, setMintOrgId] = useState("");
  const [mintReason, setMintReason] = useState("");
  const [mintAccessLevel, setMintAccessLevel] = useState("READ_ONLY");
  const [emergencyUserId, setEmergencyUserId] = useState("");
  const [emergencyRole, setEmergencyRole] = useState("EMERGENCY_READ_ONLY");

  /**
   * SECRET HELD OFF-RENDER. The opaque support-context token never enters React
   * state, so it cannot land in a rendered attribute, a devtools state dump, or
   * a serialized component tree. Only the derived, non-secret metadata below is
   * stateful.
   */
  const supportContextTokenRef = useRef<string | null>(null);
  const [contextMeta, setContextMeta] = useState<{
    grantId: string;
    expiresInSeconds: number;
    enteredAtMs: number;
  } | null>(null);

  const loadSupportGrants = useCallback(async () => {
    const captured = stamp();
    setSupportGrants(null);
    setSupportFailure(null);
    const params = new URLSearchParams();
    if (supportStatus) params.set("status", supportStatus);
    if (showAllActors) params.set("mine", "false");
    const qs = params.toString();
    try {
      const res: { grants: SupportGrant[]; total?: number; limit?: number } =
        await apiFetch(
        `/v1/support-access/grants${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setSupportGrants(res.grants ?? []);
      setSupportGrantsTotal(res.total ?? null);
      setSupportGrantsLimit(res.limit ?? null);
    } catch (err) {
      if (isStale(captured)) return;
      setSupportGrants([]);
      setSupportFailure(
        classifyFailure(err, "Unable to load support-access grants."),
      );
    }
  }, [supportStatus, showAllActors, stamp, isStale]);

  const loadEmergencyGrants = useCallback(async () => {
    const captured = stamp();
    setEmergencyGrants(null);
    setEmergencyFailure(null);
    const params = new URLSearchParams();
    if (emergencyStatus) params.set("status", emergencyStatus);
    const qs = params.toString();
    try {
      const res: { grants: EmergencyGrant[] } = await apiFetch(
        `/v1/break-glass/grants${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setEmergencyGrants(res.grants ?? []);
    } catch (err) {
      if (isStale(captured)) return;
      setEmergencyGrants([]);
      setEmergencyFailure(
        classifyFailure(err, "Unable to load break-glass grants."),
      );
    }
  }, [emergencyStatus, stamp, isStale]);

  useEffect(() => {
    void loadSupportGrants();
  }, [loadSupportGrants]);

  useEffect(() => {
    void loadEmergencyGrants();
  }, [loadEmergencyGrants]);

  /**
   * Enter support context for a grant. The server re-validates the grant
   * (ACTIVE, unexpired, unrevoked, owned by the caller) and binds the minted
   * token to the caller's CURRENT session — a token minted in one session can
   * never be presented from another.
   */
  const enterContext = useCallback(
    async (grant: SupportGrant) => {
      if (!teamId) return;
      const confirmed = await confirm({
        title: "Enter support context?",
        description:
          "Every request you make while in support context is attributed to BOTH you and the customer Organization, is bounded by the grant's scope, and is recorded in the immutable support audit trail.",
        confirmLabel: "Enter support context",
        tone: "warning",
        testId: "support-access-enter",
      });
      if (!confirmed) return;
      setMutating(true);
      setMutationFailure(null);
      setNotice(null);
      const captured = stamp();
      try {
        const res: {
          supportContextToken: string;
          expiresInSeconds: number;
        } = await apiFetch("/v1/support-access/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, grantId: grant.id }),
        });
        if (isStale(captured)) return;
        // Token goes to the ref ONLY. Never to state, storage, or a URL.
        supportContextTokenRef.current = res.supportContextToken;
        setContextMeta({
          grantId: grant.id,
          expiresInSeconds: res.expiresInSeconds,
          enteredAtMs: Date.now(),
        });
        setNotice("Support context active for this tab.");
      } catch (err) {
        if (isStale(captured)) return;
        setMutationFailure(
          classifyFailure(err, "Could not enter support context."),
        );
      } finally {
        setMutating(false);
      }
    },
    [teamId, confirm, stamp, isStale],
  );

  /** Drop the in-memory token. Does not touch the grant — that is revoke. */
  const exitContext = useCallback(() => {
    supportContextTokenRef.current = null;
    setContextMeta(null);
    setNotice("Support context cleared for this tab. The grant is unchanged.");
  }, []);

  const revokeSupport = useCallback(
    async (grant: SupportGrant) => {
      if (!teamId) return;
      const confirmed = await confirm({
        title: "Revoke support access?",
        description:
          "The grant becomes unusable immediately, including for any support context already entered from it. The grant row is retained for audit.",
        confirmLabel: "Revoke grant",
        tone: "danger",
        testId: "support-access-revoke",
      });
      if (!confirmed) return;
      setMutating(true);
      setMutationFailure(null);
      setNotice(null);
      try {
        await apiFetch("/v1/support-access/revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, grantId: grant.id }),
        });
        if (contextMeta?.grantId === grant.id) exitContext();
        setNotice("Support grant revoked.");
        await loadSupportGrants();
      } catch (err) {
        setMutationFailure(classifyFailure(err, "Could not revoke the grant."));
      } finally {
        setMutating(false);
      }
    },
    [teamId, confirm, contextMeta, exitContext, loadSupportGrants],
  );


  const startSupportGrant = useCallback(async () => {
    if (!teamId) return;
    const confirmed = await confirm({
      title: "Grant support access to this customer?",
      description:
        "This mints a support grant over the named organization and is recorded against you. It does not enter support context — that is a separate, separately audited step.",
      confirmLabel: "Create grant",
      tone: "warning",
      testId: "support-access-start",
    });
    if (!confirmed) return;
    setMutating(true);
    setMutationFailure(null);
    setNotice(null);
    try {
      await apiFetch("/v1/support-access/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          organizationId: mintOrgId.trim(),
          reason: mintReason.trim(),
          accessLevel: mintAccessLevel,
        }),
      });
      setNotice("Support grant created.");
      setMintOrgId("");
      setMintReason("");
      await loadSupportGrants();
    } catch (err) {
      setMutationFailure(
        classifyFailure(err, "Could not create the support grant."),
      );
    } finally {
      setMutating(false);
    }
  }, [teamId, confirm, mintOrgId, mintReason, mintAccessLevel, loadSupportGrants]);

  const activateBreakGlass = useCallback(async () => {
    if (!teamId) return;
    const confirmed = await confirm({
      title: "Activate break-glass emergency access?",
      description:
        "Emergency access bypasses the ordinary permission model for the named identity. It is recorded against you, and it must be revoked as soon as the incident is contained.",
      confirmLabel: "Activate emergency access",
      tone: "danger",
      testId: "break-glass-activate",
    });
    if (!confirmed) return;
    setMutating(true);
    setMutationFailure(null);
    setNotice(null);
    try {
      await apiFetch("/v1/break-glass/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          organizationId: mintOrgId.trim(),
          emergencyUserId: emergencyUserId.trim(),
          reason: mintReason.trim(),
          grantedRole: emergencyRole,
        }),
      });
      setNotice("Break-glass access activated.");
      setEmergencyUserId("");
      setMintReason("");
      await loadEmergencyGrants();
    } catch (err) {
      setMutationFailure(
        classifyFailure(err, "Could not activate emergency access."),
      );
    } finally {
      setMutating(false);
    }
  }, [
    teamId,
    confirm,
    mintOrgId,
    emergencyUserId,
    mintReason,
    emergencyRole,
    loadEmergencyGrants,
  ]);
  const revokeEmergency = useCallback(
    async (grant: EmergencyGrant) => {
      if (!teamId) return;
      const confirmed = await confirm({
        title: "Revoke break-glass grant?",
        description:
          "Emergency access is cut immediately. This is the containment direction and is intentionally not gated by a second factor.",
        confirmLabel: "Revoke emergency access",
        tone: "danger",
        testId: "break-glass-revoke",
      });
      if (!confirmed) return;
      setMutating(true);
      setMutationFailure(null);
      setNotice(null);
      try {
        await apiFetch("/v1/break-glass/revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, grantId: grant.id }),
        });
        setNotice("Break-glass grant revoked.");
        await loadEmergencyGrants();
      } catch (err) {
        setMutationFailure(
          classifyFailure(err, "Could not revoke the emergency grant."),
        );
      } finally {
        setMutating(false);
      }
    },
    [teamId, confirm, loadEmergencyGrants],
  );

  const contextExpiresAt = useMemo(() => {
    if (!contextMeta) return null;
    return new Date(
      contextMeta.enteredAtMs + contextMeta.expiresInSeconds * 1000,
    ).toISOString();
  }, [contextMeta]);

  const supportColumns: DataTableColumn<SupportGrant>[] = [
    {
      key: "org",
      header: "Customer organization",
      render: (g) => (
        <div data-support-grant-row={g.id}>
          <code>{g.organizationId.slice(0, 8)}…</code>
          {g.teamId ? (
            <div style={muted}>Scoped to workspace {g.teamId.slice(0, 8)}…</div>
          ) : (
            <div style={muted}>Organization-wide scope</div>
          )}
        </div>
      ),
    },
    {
      key: "actor",
      header: "Support actor",
      render: (g) => (
        <div>
          <code>{g.supportUserId.slice(0, 8)}…</code>
          <div style={muted}>
            {g.approvedByUserId
              ? `Approved by ${g.approvedByUserId.slice(0, 8)}…`
              : "No customer approver recorded"}
          </div>
        </div>
      ),
    },
    {
      key: "level",
      header: "Access level",
      render: (g) => (
        <Badge tone={g.accessLevel === "ELEVATED" ? "risk" : "info"}>
          {g.accessLevel}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (g) => (
        <div>
          <StatusBadge status={g.expired ? "EXPIRED" : g.status} />
          {g.revokedAtUtc ? (
            <div style={muted}>Revoked {formatUserDateTime(g.revokedAtUtc)}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "window",
      header: "Window",
      render: (g) => (
        <div style={{ fontSize: 12, color: "#334155" }}>
          <div>{formatUserDateTime(g.startedAtUtc)}</div>
          <div style={muted}>until {formatUserDateTime(g.expiresAtUtc)}</div>
        </div>
      ),
    },
    { key: "reason", header: "Reason", render: (g) => <span style={{ fontSize: 12 }}>{g.reason}</span> },
  ];

  const emergencyColumns: DataTableColumn<EmergencyGrant>[] = [
    {
      key: "org",
      header: "Organization",
      render: (g) => (
        <code data-break-glass-row={g.id}>{g.organizationId.slice(0, 8)}…</code>
      ),
    },
    {
      key: "identity",
      header: "Emergency identity",
      render: (g) => (
        <div>
          <code>{g.emergencyUserId.slice(0, 8)}…</code>
          <div style={muted}>
            Requested by {g.requestedByUserId.slice(0, 8)}…
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Granted role",
      render: (g) => (
        <Badge tone={g.grantedRole === "EMERGENCY_OPERATOR" ? "risk" : "info"}>
          {g.grantedRole}
        </Badge>
      ),
    },
    {
      key: "proof",
      header: "Strong-auth proof",
      render: (g) =>
        g.stepUpProofRecorded ? (
          <Badge tone="verified" subtle>
            Recorded
          </Badge>
        ) : (
          <Badge tone="risk" subtle>
            Missing
          </Badge>
        ),
    },
    {
      key: "status",
      header: "Status",
      render: (g) => (
        <div>
          <StatusBadge status={g.expired ? "EXPIRED" : g.status} />
          {g.revokedAtUtc ? (
            <div style={muted}>
              Revoked {formatUserDateTime(g.revokedAtUtc)}
              {g.revokedByUserId ? ` by ${g.revokedByUserId.slice(0, 8)}…` : ""}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "window",
      header: "Window",
      render: (g) => (
        <div style={{ fontSize: 12, color: "#334155" }}>
          <div>{formatUserDateTime(g.startedAtUtc)}</div>
          <div style={muted}>until {formatUserDateTime(g.expiresAtUtc)}</div>
        </div>
      ),
    },
    { key: "reason", header: "Reason", render: (g) => <span style={{ fontSize: 12 }}>{g.reason}</span> },
  ];

  return (
    <PageShell
      data-support-access-page
      header={
        <PageHeader
          eyebrow="Platform staff"
          title="Support access and break-glass"
          subtitle="Restricted internal capabilities. Every action here carries dual identity — you and the customer organization — and is recorded in the immutable support audit trail."
          contextStrip={
            <a href="/admin" style={{ fontSize: 12 }}>← Back to platform administration</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-support-access-refresh
              disabled={mutating}
              onClick={() => {
                void loadSupportGrants();
                void loadEmergencyGrants();
              }}
            >
              Refresh
            </Button>
          }
        />
      }
    >
      {mutationFailure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-support-access-mutation-failure={mutationFailure.kind}
        >
          {mutationFailure.message}
        </Card>
      ) : null}
      {notice ? (
        <Card
          variant="status"
          tone="verified"
          padding="compact"
          data-support-access-notice
        >
          {notice}
        </Card>
      ) : null}

      {/* Active support context for THIS tab. The token itself is never shown —
          only that one is held and when it lapses. */}
      <PageSection title="Support context">
        {contextMeta ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-support-context-active={contextMeta.grantId}
          >
            <strong>Support context is active in this tab.</strong>
            <div style={{ ...muted, marginTop: 4 }}>
              Grant <code>{contextMeta.grantId.slice(0, 8)}…</code> · token held
              in memory only, expires{" "}
              {contextExpiresAt ? formatUserDateTime(contextExpiresAt) : "shortly"}
              . The token is bound to your current session and is never stored or
              displayed.
            </div>
            <div style={{ marginTop: 10 }}>
              <Button
                variant="secondary"
                size="sm"
                data-support-context-exit
                onClick={exitContext}
              >
                Leave support context
              </Button>
            </div>
          </Card>
        ) : (
          <EmptyState
            framed
            title="Not in support context"
            purpose="Enter support context from an active grant below. Until you do, you act only as yourself and see only your own platform surfaces."
          />
        )}
      </PageSection>

      <PageSection
        title="Support access grants"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Status"
              showLabel
              value={supportStatus}
              onChange={setSupportStatus}
              options={STATUS_FILTERS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
            />
            <Button
              variant="secondary"
              size="sm"
              data-support-access-toggle-actors
              onClick={() => setShowAllActors((v) => !v)}
            >
              {showAllActors ? "Show only mine" : "Show all support actors"}
            </Button>
          </FilterBar>
        }
      >
        <p style={{ ...muted, marginTop: 0 }}>
          {showAllActors
            ? "Every support grant on the platform. You can only enter context for grants issued to you."
            : "Grants issued to you. These are the only grants you can enter support context with."}
        </p>
        {supportFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-support-grants-failure={supportFailure.kind}
          >
            {supportFailure.message}
          </Card>
        ) : (
          <div data-support-grants-table>
            <DataTable<SupportGrant>
              ariaLabel="Support access grants"
              columns={supportColumns}
              rows={supportGrants ?? []}
              getRowId={(g) => g.id}
              loading={!supportGrants}
              emptyState={
                <EmptyState
                  title="No support grants"
                  purpose="No support-access grant matches this filter. Grants are minted through the incident workflow, not from this console."
                />
              }
              rowActions={(g) =>
                g.status === "ACTIVE" && !g.expired ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      data-support-access-enter={g.id}
                      disabled={mutating || contextMeta?.grantId === g.id}
                      onClick={() => void enterContext(g)}
                    >
                      {contextMeta?.grantId === g.id ? "In context" : "Enter"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      data-support-access-revoke={g.id}
                      disabled={mutating}
                      onClick={() => void revokeSupport(g)}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : (
                  <span style={muted}>—</span>
                )
              }
            />
              {/* Standing access is the thing this page exists to make
                  countable, and the request has always capped at 50. The count
                  now carries the server's own total for the same filter, so a
                  full page reads "Showing 50 of 137" rather than "50". */}
              <ResultCount
                shown={supportGrants?.length ?? 0}
                total={supportGrantsTotal ?? undefined}
                cap={supportGrantsLimit ?? undefined}
                noun="support grant"
                filtered={supportStatus !== ""}
                loading={supportGrants === null}
                data-testid="admin-support-grants-count"
              />
          </div>
        )}
      </PageSection>

      <PageSection
        title="Grant access"
        description="Mint a support grant, or activate break-glass emergency access, over a customer organization. Both are recorded against you and both remain revocable below."
      >
        <Card>
          <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={muted}>Organization ID</span>
              <input
                className="app-input"
                value={mintOrgId}
                onChange={(e) => setMintOrgId(e.target.value)}
                placeholder="The customer organization this access is over"
                data-testid="mint-organization-id"
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={muted}>Reason (recorded, minimum 8 characters)</span>
              <input
                className="app-input"
                value={mintReason}
                onChange={(e) => setMintReason(e.target.value)}
                placeholder="Why this access is needed"
                data-testid="mint-reason"
              />
            </label>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={muted}>Support access level</span>
                <select
                  className="app-input"
                  value={mintAccessLevel}
                  onChange={(e) => setMintAccessLevel(e.target.value)}
                  data-testid="mint-access-level"
                >
                  <option value="READ_ONLY">Read only</option>
                  <option value="ELEVATED">Elevated</option>
                </select>
              </label>
              <Button
                size="sm"
                onClick={() => void startSupportGrant()}
                disabled={
                  mutating || !mintOrgId.trim() || mintReason.trim().length < 8
                }
              >
                Create support grant
              </Button>
            </div>

            <hr style={{ border: 0, borderTop: "1px solid var(--rule, #e2e8f0)", margin: "4px 0" }} />

            <p style={{ ...muted, margin: 0 }}>
              Break-glass is for an incident in which the ordinary permission
              model cannot be used. It grants a pre-agreed emergency identity,
              not you.
            </p>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={muted}>Emergency user ID</span>
              <input
                className="app-input"
                value={emergencyUserId}
                onChange={(e) => setEmergencyUserId(e.target.value)}
                placeholder="The identity that will hold emergency access"
                data-testid="break-glass-user-id"
              />
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={muted}>Emergency role</span>
                <select
                  className="app-input"
                  value={emergencyRole}
                  onChange={(e) => setEmergencyRole(e.target.value)}
                  data-testid="break-glass-role"
                >
                  <option value="EMERGENCY_READ_ONLY">Emergency read only</option>
                  <option value="EMERGENCY_OPERATOR">Emergency operator</option>
                </select>
              </label>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void activateBreakGlass()}
                disabled={
                  mutating ||
                  !mintOrgId.trim() ||
                  !emergencyUserId.trim() ||
                  mintReason.trim().length < 8
                }
              >
                Activate break-glass
              </Button>
            </div>
          </div>
        </Card>
      </PageSection>

      <PageSection
        title="Break-glass emergency grants"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Status"
              showLabel
              value={emergencyStatus}
              onChange={setEmergencyStatus}
              options={STATUS_FILTERS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
            />
          </FilterBar>
        }
      >
        <p style={{ ...muted, marginTop: 0 }}>
          Emergency access grants across the platform. Activation is above and
          requires a recorded strong-auth proof; this console also shows the
          lifecycle and cuts access.
        </p>
        {emergencyFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-break-glass-failure={emergencyFailure.kind}
          >
            {emergencyFailure.message}
          </Card>
        ) : (
          <div data-break-glass-table>
            <DataTable<EmergencyGrant>
              ariaLabel="Break-glass emergency grants"
              columns={emergencyColumns}
              rows={emergencyGrants ?? []}
              getRowId={(g) => g.id}
              loading={!emergencyGrants}
              emptyState={
                <EmptyState
                  title="No emergency grants"
                  purpose="No break-glass grant matches this filter. That is the expected steady state."
                />
              }
              rowActions={(g) =>
                g.status === "ACTIVE" && !g.expired ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    data-break-glass-revoke={g.id}
                    disabled={mutating}
                    onClick={() => void revokeEmergency(g)}
                  >
                    Revoke
                  </Button>
                ) : (
                  <span style={muted}>—</span>
                )
              }
            />
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

const muted: React.CSSProperties = { fontSize: 12, color: "#64748b" };
