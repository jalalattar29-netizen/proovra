"use client";

/**
 * PHASE 12B — Permission matrix + temporary elevation.
 *
 *   GET  /v1/admin/identity/role-matrix        (authoritative projection)
 *   GET  /v1/admin/identity/permission-matrix  (one member's effective access)
 *   POST /v1/admin/identity/elevations         (bounded temporary elevation)
 *
 * Two questions, one surface:
 *
 *   1. "What does each role grant here?" — answered by the ROLE MATRIX, which
 *      is the server's authoritative role → permission projection. This page
 *      does not derive, infer or cache role precedence; it renders that matrix.
 *   2. "What can this specific member do, and why?" — answered by the member
 *      snapshot, which names the SOURCE of every outcome (role default,
 *      capability grant, delegated scope, temporary elevation).
 *
 * From (2) an administrator can grant a BOUNDED temporary elevation: one
 * permission, for a limited window, step-up confirmed, audited, and visible as
 * a temporary-elevation source the next time the snapshot is read. The elevation
 * count on the snapshot is the honest indicator of standing exceptions.
 *
 * The workspace is SERVER-derived on every request; the page passes back only
 * the workspace the API itself echoed, so it can never point an elevation at
 * another organization.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  classifyFailure,
  isStepUpCancel,
  shortId,
  type SurfaceFailure,
} from "../_sections/identity-admin-shared";
import {
  inputStyle,
  mutedStyle,
  selectStyle,
  statusBadgeStyle,
  TOKENS,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { ResultCount } from "../../../../../components/ui/ResultCount";

type Outcome = "ALLOW" | "DENY" | "STEP_UP_REQUIRED" | "NOT_APPLICABLE";

type PermissionRow = {
  permission: string;
  outcome: Outcome;
  source: string;
  sourceLabel: string;
  reason: string;
};

type Snapshot = {
  teamId: string;
  userId: string;
  canonicalRole: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  permissions: PermissionRow[];
  capabilityGrantCount: number;
  delegatedScopeCount: number;
  temporaryElevationCount: number;
  computedAtUtc: string;
};

type RoleMatrixRow = {
  role: string;
  permissions: ReadonlyArray<{ permission: string; allowed: boolean }>;
};

const ELEVATION_TTL_OPTIONS = [
  { value: "900", label: "15 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "14400", label: "4 hours" },
  { value: "28800", label: "8 hours" },
] as const;

export default function PermissionMatrixPage() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  // --- Authoritative role matrix -------------------------------------------
  const [matrix, setMatrix] = useState<ReadonlyArray<RoleMatrixRow> | null>(null);
  const [matrixTeamId, setMatrixTeamId] = useState<string | null>(null);
  const [matrixFailure, setMatrixFailure] = useState<SurfaceFailure | null>(null);
  const [roleFilter, setRoleFilter] = useState<string>("");

  // --- Member snapshot ------------------------------------------------------
  const [subjectUserId, setSubjectUserId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotFailure, setSnapshotFailure] = useState<SurfaceFailure | null>(
    null,
  );
  const [filter, setFilter] = useState<string>("");
  const [outcomeFilter, setOutcomeFilter] = useState<Outcome | "">("");

  // --- Temporary elevation -------------------------------------------------
  const [elevationPermission, setElevationPermission] = useState<string>("");
  const [elevationTtl, setElevationTtl] = useState<string>("3600");
  const [elevationReason, setElevationReason] = useState<string>("");
  const [elevationBusy, setElevationBusy] = useState(false);
  const [elevationFailure, setElevationFailure] = useState<SurfaceFailure | null>(
    null,
  );
  const [elevationNotice, setElevationNotice] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const loadMatrix = useCallback(async () => {
    const captured = stamp();
    setMatrixFailure(null);
    try {
      const res = await apiFetch("/v1/admin/identity/role-matrix", {
        method: "GET",
      });
      if (isStale(captured)) return;
      setMatrix((res?.matrix ?? []) as ReadonlyArray<RoleMatrixRow>);
      setMatrixTeamId(
        typeof res?.teamId === "string" ? (res.teamId as string) : null,
      );
    } catch (err) {
      if (isStale(captured)) return;
      setMatrix([]);
      setMatrixTeamId(null);
      setMatrixFailure(classifyFailure(err, "Unable to load the role matrix."));
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  const loadSnapshot = useCallback(async () => {
    if (!subjectUserId) return;
    const captured = stamp();
    setBusy(true);
    setSnapshotFailure(null);
    setElevationNotice(null);
    try {
      // teamId is still accepted by this (older) inspector route; the value
      // passed is the one the ROLE-MATRIX response echoed — never one this
      // page chose.
      const qs = new URLSearchParams({ subjectUserId });
      if (matrixTeamId) qs.set("teamId", matrixTeamId);
      const res = await apiFetch(
        `/v1/admin/identity/permission-matrix?${qs.toString()}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setSnapshot(res.snapshot as Snapshot);
    } catch (err) {
      if (isStale(captured)) return;
      setSnapshot(null);
      setSnapshotFailure(
        classifyFailure(err, "Unable to load the member's effective access."),
      );
    } finally {
      if (!isStale(captured)) setBusy(false);
    }
  }, [subjectUserId, matrixTeamId, stamp, isStale]);

  // -------------------------------------------------------------------------
  // Temporary elevation
  // -------------------------------------------------------------------------

  const grantElevation = useCallback(async () => {
    if (!snapshot || !matrixTeamId) return;
    const permission = elevationPermission.trim();
    if (!permission || elevationReason.trim().length === 0) {
      setElevationFailure({
        kind: "error",
        message:
          "Choose the permission to elevate and record why — the reason is written to the audit entry.",
      });
      return;
    }
    const ok = await confirm({
      title: "Grant a temporary elevation?",
      description:
        "The member gains this single permission for the chosen window only. It expires on its own, is visible as a temporary-elevation source, and is recorded against your identity.",
      confirmLabel: "Grant elevation",
      tone: "danger",
      testId: "identity-temporary-elevation",
    });
    if (!ok) return;
    const captured = stamp();
    setElevationBusy(true);
    setElevationFailure(null);
    setElevationNotice(null);
    try {
      await stepUp.runStepUpAction((headers) =>
        apiFetch("/v1/admin/identity/elevations", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            // The strict server schema requires teamId; the value sent is the
            // workspace the API itself resolved, and the server re-derives and
            // rejects a mismatch rather than trusting it.
            teamId: matrixTeamId,
            userId: snapshot.userId,
            permission,
            reason: elevationReason.trim(),
            ttlSeconds: Number(elevationTtl),
          }),
        }),
      );
      if (isStale(captured)) return;
      setElevationReason("");
      // Re-read the authoritative snapshot instead of patching it locally —
      // and only THEN announce. loadSnapshot clears the notice as part of
      // resetting the panel, so announcing first meant the handler's own
      // re-read erased its success message before anyone could read it.
      await loadSnapshot();
      if (isStale(captured)) return;
      setElevationNotice(
        "Elevation granted. The snapshot below now shows it as a temporary-elevation source.",
      );
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) return;
      setElevationFailure(
        classifyFailure(err, "Could not grant the temporary elevation."),
      );
    } finally {
      if (!isStale(captured)) setElevationBusy(false);
    }
  }, [
    snapshot,
    matrixTeamId,
    elevationPermission,
    elevationReason,
    elevationTtl,
    confirm,
    stepUp,
    loadSnapshot,
    stamp,
    isStale,
  ]);

  // -------------------------------------------------------------------------
  // Derived views
  // -------------------------------------------------------------------------

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.permissions.filter((p) => {
      if (outcomeFilter && p.outcome !== outcomeFilter) return false;
      if (filter && !p.permission.toLowerCase().includes(filter.toLowerCase()))
        return false;
      return true;
    });
  }, [snapshot, filter, outcomeFilter]);

  const matrixRows = useMemo(() => {
    const rows = matrix ?? [];
    const needle = filter.trim().toLowerCase();
    const selected = roleFilter
      ? rows.filter((r) => r.role === roleFilter)
      : rows;
    return selected.map((r) => ({
      role: r.role,
      allowed: r.permissions.filter(
        (p) => p.allowed && (!needle || p.permission.toLowerCase().includes(needle)),
      ),
      total: r.permissions.length,
    }));
  }, [matrix, roleFilter, filter]);

  if (!teamId) {
    return (
      <PageShell
        header={
          <PageHeader eyebrow="Identity operations" title="Permission matrix" />
        }
      >
        <EmptyState variant="inline"
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to inspect what its roles grant and what a specific member can do."
        />
      </PageShell>
    );
  }

  const columns: DataTableColumn<PermissionRow>[] = [
    {
      key: "permission",
      header: "Permission",
      render: (r) => (
        <span
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {r.permission}
        </span>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      render: (r) => (
        <span style={statusBadgeStyle(r.outcome)}>
          {r.outcome.toLowerCase().replace("_", " ")}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      render: (r) => <span style={mutedStyle}>{r.sourceLabel}</span>,
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => <span style={mutedStyle}>{r.reason}</span>,
    },
    {
      key: "elevate",
      header: "",
      render: (r) =>
        snapshot && r.outcome !== "ALLOW" ? (
          <Button
            variant="ghost"
            size="sm"
            data-identity-elevation-pick={r.permission}
            onClick={() => setElevationPermission(r.permission)}
          >
            Elevate…
          </Button>
        ) : null,
    },
  ];

  return (
    <PageShell
      data-permission-matrix-page
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Permission matrix"
          subtitle="The authoritative role → permission projection, plus one member's effective access with the source of every outcome. Nothing on this page is computed in the browser."
          contextStrip={
            <Link
              href="/admin/identity"
              // 44px hit box; the header keeps its height (admin-console.css).
              className="admin-hit-link"
              style={{ fontSize: 12 }}
            >
              ← Back to identity administration
            </Link>
          }
          secondaryActions={
            <Button
              variant="secondary"
              data-permission-matrix-refresh
              onClick={() => void loadMatrix()}
            >
              Refresh matrix
            </Button>
          }
        />
      }
    >
      {/* ------------------------------------------------------------------ */}
      {/* 1 — the authoritative role matrix.                                  */}
      {/* ------------------------------------------------------------------ */}
      <PageSection
        title="What each role grants"
        description="The server's authoritative projection of the canonical roles. If a role is missing a permission here, no amount of UI state changes that — grant a capability or a bounded elevation instead."
      >
        {matrixFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-role-matrix-failure={matrixFailure.kind}
          >
            <strong>
              {matrixFailure.kind === "denied"
                ? "Not available to you"
                : "Could not load"}
            </strong>
            <div style={{ marginTop: 4 }}>{matrixFailure.message}</div>
          </Card>
        ) : matrix === null ? (
          <p style={mutedStyle} data-role-matrix-loading>
            Loading the role matrix…
          </p>
        ) : matrix.length === 0 ? (
          <EmptyState variant="inline"
            framed
            title="Role matrix unavailable"
            purpose="The server returned no roles for this workspace. Refresh, or check that your session is still in the workspace you expect."
          />
        ) : (
          <>
            <FilterBar>
              <FilterBar.Search
                value={filter}
                onChange={setFilter}
                label="Filter by permission name"
                placeholder="Filter by permission name…"
              />
              <FilterBar.Select
                label="Role"
                showLabel
                value={roleFilter}
                onChange={setRoleFilter}
                options={[
                  { value: "", label: "All roles" },
                  ...matrix.map((r) => ({ value: r.role, label: r.role })),
                ]}
              />
            </FilterBar>
            <div
              data-role-matrix
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 12,
                marginTop: 12,
              }}
            >
              {matrixRows.map((r) => (
                <Card
                  key={r.role}
                  variant="admin"
                  padding="compact"
                  title={r.role}
                  subtitle={`${r.allowed.length} of ${r.total} permissions`}
                  data-role-matrix-role={r.role}
                >
                  {r.allowed.length === 0 ? (
                    <p style={mutedStyle}>
                      No permissions match the current filter for this role.
                    </p>
                  ) : (
                    <ul
                      style={{
                        margin: 0,
                        paddingInlineStart: 16,
                        maxHeight: 180,
                        overflowY: "auto",
                      }}
                    >
                      {r.allowed.map((p) => (
                        <li
                          key={p.permission}
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                            fontSize: 11,
                            color: TOKENS.inkMuted,
                          }}
                        >
                          {p.permission}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </PageSection>

      {/* ------------------------------------------------------------------ */}
      {/* 2 — one member's effective access.                                  */}
      {/* ------------------------------------------------------------------ */}
      <PageSection
        title="Inspect a member"
        description="Paste a member's user id (the member list on the identity administration console shows them) to see every permission outcome and where it comes from."
      >
        <Card variant="admin" padding="comfortable">
          <div
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <input
              data-permission-matrix-subject
              aria-label="Member user id (UUID) to inspect"
              style={{ ...inputStyle, maxWidth: 360 }}
              placeholder="Member user id (UUID)"
              value={subjectUserId}
              onChange={(e) => setSubjectUserId(e.target.value.trim())}
            />
            <Button
              variant="enterprise"
              data-permission-matrix-inspect
              onClick={() => void loadSnapshot()}
              loading={busy}
              disabled={busy || !subjectUserId}
            >
              {busy ? "Loading…" : "Inspect"}
            </Button>
          </div>
        </Card>

        {snapshotFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-permission-matrix-failure={snapshotFailure.kind}
            style={{ marginTop: 12 }}
          >
            <strong>
              {snapshotFailure.kind === "denied"
                ? "Not available to you"
                : snapshotFailure.kind === "blocked"
                  ? "Refused"
                  : "Could not load"}
            </strong>
            <div style={{ marginTop: 4 }}>{snapshotFailure.message}</div>
          </Card>
        ) : null}
      </PageSection>

      {snapshot ? (
        <>
          <PageSection>
            <Card variant="summary" padding="comfortable" data-permission-snapshot>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <KV k="Member" v={shortId(snapshot.userId)} mono />
                <KV k="Canonical role" v={snapshot.canonicalRole} />
                <KV k="Status" v={snapshot.status} />
                <KV
                  k="Capability grants"
                  v={String(snapshot.capabilityGrantCount)}
                />
                <KV
                  k="Delegated scopes"
                  v={String(snapshot.delegatedScopeCount)}
                />
                <KV
                  k="Temporary elevations"
                  v={String(snapshot.temporaryElevationCount)}
                />
              </div>
            </Card>
          </PageSection>

          {/* -------------------------------------------------------------- */}
          {/* 3 — bounded temporary elevation.                                */}
          {/* -------------------------------------------------------------- */}
          <PageSection
            title="Temporary elevation"
            description="One permission, one bounded window. It expires by itself — there is no standing exception, and the grant is step-up confirmed and audited."
          >
            <Card variant="admin" padding="comfortable" data-elevation-form>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <input
                  data-elevation-permission
                  style={{ ...inputStyle, maxWidth: 280 }}
                  placeholder="Permission (use Elevate… in the table)"
                  value={elevationPermission}
                  onChange={(e) => setElevationPermission(e.target.value.trim())}
                />
                <select
                  aria-label="Elevation window"
                  data-elevation-ttl
                  style={selectStyle}
                  value={elevationTtl}
                  onChange={(e) => setElevationTtl(e.target.value)}
                >
                  {ELEVATION_TTL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  data-elevation-reason
                  style={{ ...inputStyle, maxWidth: 320 }}
                  placeholder="Reason (required, audited)"
                  maxLength={400}
                  value={elevationReason}
                  onChange={(e) => setElevationReason(e.target.value)}
                />
                <Button
                  variant="enterprise"
                  data-elevation-submit
                  loading={elevationBusy}
                  disabled={
                    elevationBusy ||
                    !elevationPermission.trim() ||
                    !elevationReason.trim()
                  }
                  onClick={() => void grantElevation()}
                >
                  Grant elevation
                </Button>
              </div>
              {elevationFailure ? (
                <div
                  data-elevation-failure={elevationFailure.kind}
                  style={{ ...mutedStyle, marginTop: 8, color: "var(--danger-strong)" }}
                >
                  {elevationFailure.message}
                </div>
              ) : null}
              {elevationNotice ? (
                <div
                  data-elevation-notice
                  style={{ ...mutedStyle, marginTop: 8, color: "var(--success-strong)" }}
                >
                  {elevationNotice}
                </div>
              ) : null}
            </Card>
          </PageSection>

          <PageSection>
            <FilterBar
              actions={
                <>
                  <span style={mutedStyle}>
                    {filtered.length} / {snapshot.permissions.length} permissions
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFilter("");
                      setOutcomeFilter("");
                    }}
                  >
                    Clear
                  </Button>
                </>
              }
            >
              <FilterBar.Search
                value={filter}
                onChange={setFilter}
                label="Filter by permission name"
                placeholder="Filter by permission name…"
              />
              <FilterBar.Select
                label="Outcome"
                value={outcomeFilter}
                onChange={(v) => setOutcomeFilter(v as Outcome | "")}
                options={[
                  { value: "", label: "All outcomes" },
                  { value: "ALLOW", label: "Allow" },
                  { value: "DENY", label: "Deny" },
                  { value: "STEP_UP_REQUIRED", label: "Step-up required" },
                  { value: "NOT_APPLICABLE", label: "Not applicable" },
                ]}
              />
            </FilterBar>
            <div style={{ marginTop: 12 }}>
              <DataTable
                columns={columns}
                rows={filtered}
                getRowId={(r) => r.permission}
                ariaLabel="Permission matrix"
                emptyState={
                  <EmptyState variant="inline"
                    title="No permissions match"
                    purpose="Adjust the permission-name filter or outcome filter to see entries."
                  />
                }
              />
              {/* The matrix is the product's compiled-in roles crossed with
                  its compiled-in capabilities — nothing queried, nothing
                  capped. Declared in scripts/admin-complete-lists.mjs, where
                  the API test asserts the handler has no take. */}
              <ResultCount
                shown={filtered.length}
                complete
                noun="role"
                filtered={filtered.length !== (matrix ?? []).length}
                data-testid="admin-permission-matrix-count"
              />
            </div>
          </PageSection>
        </>
      ) : null}

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: TOKENS.inkSubtle, textTransform: "uppercase" }}>
        {k}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          ...(mono
            ? {
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
              }
            : {}),
        }}
      >
        {v}
      </span>
    </div>
  );
}
