"use client";

/**
 * PHASE 12B — Members, roles, capabilities and delegated administration.
 *
 * The operational core of the identity administration console. It consumes the
 * canonical member projection and drives every member-scoped mutation the
 * platform ships:
 *
 *   GET    /v1/identity/members
 *   POST   /v1/identity/members/:id/role
 *   POST   /v1/identity/members/:id/suspend | /restore | /revoke
 *   POST   /v1/identity/members/:id/capabilities
 *   DELETE /v1/identity/capabilities/:id
 *   POST   /v1/identity/members/:id/delegated-admin
 *   DELETE /v1/identity/delegated-admin/:id
 *
 * Discipline enforced here:
 *   * The workspace is NEVER declared by this surface. The API derives it from
 *     the operator's active workspace and echoes it back; the console renders
 *     what it was given.
 *   * Effective access is NEVER computed locally: role, status, grants and
 *     scopes are read from the server projection, and the list is RELOADED
 *     from the server after every mutation (no optimistic edits).
 *   * Every mutation runs through `useStepUpAction`, so the structured 401
 *     opens the challenge modal and the ORIGINAL request is retried once with
 *     the verified challenge id.
 *   * Responses that land after a workspace switch are dropped (tenant
 *     generation guard), so one organization's members can never paint into
 *     another's console.
 *   * Destructive transitions confirm first, and feedback is PER ROW — the
 *     operator sees which member the outcome belongs to.
 *   * Only opaque ids and bounded enums are rendered — never names or emails.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DELEGATED_ADMIN_SCOPE_KINDS,
  PERMISSIONS,
  type DelegatedAdminScopeKind,
  type Permission,
} from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { useTenantGuard } from "../../../../../lib/platform-context";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { PageSection } from "../../../../../components/ui/PageShell";
import { StatusBadge } from "../../../../../components/ui/StatusBadge";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  classifyFailure,
  isStepUpCancel,
  shortId,
  type RowResult,
  type SurfaceFailure,
} from "./identity-admin-shared";
import { inputStyle, mutedStyle, selectStyle } from "../ui-tokens";

type StepUpControl = {
  runStepUpAction: <T>(action: (headers?: Record<string, string>) => Promise<T>) => Promise<T>;
};

type CapabilityGrant = {
  id: string;
  permission: string;
  grantedAtUtc: string;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
};

type DelegatedScope = {
  id: string;
  scopeKind: string;
  grantedAtUtc: string;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
};

export type MemberProjection = {
  teamMemberId: string;
  userId: string;
  role: string;
  status: string;
  accessGrantedAtUtc: string | null;
  accessExpiresAtUtc: string | null;
  suspendedAtUtc: string | null;
  revokedAtUtc: string | null;
  lastSeenAtUtc: string | null;
  capabilityGrants: ReadonlyArray<CapabilityGrant>;
  delegatedAdminScopes: ReadonlyArray<DelegatedScope>;
};

const ASSIGNABLE_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const;

const STATUS_FILTERS = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
  { value: "REVOKED", label: "Revoked" },
] as const;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

function activeOnly<T extends { revokedAtUtc: string | null }>(
  rows: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return rows.filter((r) => r.revokedAtUtc === null);
}

export function MembersSection({
  stepUp,
  onWorkspaceResolved,
  onMembersLoaded,
}: {
  stepUp: StepUpControl;
  /** Reports the SERVER-derived workspace so the page can render its scope. */
  onWorkspaceResolved?: (teamId: string | null) => void;
  /**
   * Hands the SAME server projection to sibling sections that need a member
   * roster (external mappings), so no section invents or accepts a typed
   * subject id.
   */
  onMembersLoaded?: (members: ReadonlyArray<MemberProjection>) => void;
}) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [members, setMembers] = useState<ReadonlyArray<MemberProjection> | null>(
    null,
  );
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowResult, setRowResult] = useState<RowResult | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, string>>({});
  const [permissionDraft, setPermissionDraft] = useState<Permission>(
    PERMISSIONS[0] as Permission,
  );
  const [scopeDraft, setScopeDraft] = useState<DelegatedAdminScopeKind>(
    DELEGATED_ADMIN_SCOPE_KINDS[0] as DelegatedAdminScopeKind,
  );
  const [reason, setReason] = useState("");

  // ---------------------------------------------------------------------------
  // Read — the ONE projection this surface renders.
  // ---------------------------------------------------------------------------

  const load = useCallback(async () => {
    const captured = stamp();
    setFailure(null);
    try {
      const res = await apiFetch("/v1/identity/members", { method: "GET" });
      if (isStale(captured)) return;
      const rows = (res?.members ?? []) as ReadonlyArray<MemberProjection>;
      setMembers(rows);
      onMembersLoaded?.(rows);
      onWorkspaceResolved?.(
        typeof res?.teamId === "string" ? (res.teamId as string) : null,
      );
    } catch (err) {
      if (isStale(captured)) return;
      setMembers([]);
      onMembersLoaded?.([]);
      onWorkspaceResolved?.(null);
      setFailure(classifyFailure(err, "Unable to load the member list."));
    }
  }, [stamp, isStale, onWorkspaceResolved, onMembersLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => members?.find((m) => m.teamMemberId === selectedId) ?? null,
    [members, selectedId],
  );

  const visible = useMemo(() => {
    const rows = members ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter((m) => {
      if (statusFilter !== "ALL" && m.status !== statusFilter) return false;
      if (needle && !m.userId.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [members, statusFilter, search]);

  // ---------------------------------------------------------------------------
  // Writes — one runner: step-up, per-row feedback, server reload.
  // ---------------------------------------------------------------------------

  const run = useCallback(
    async (
      rowId: string,
      successMessage: string,
      fallbackMessage: string,
      request: (headers?: Record<string, string>) => Promise<unknown>,
    ) => {
      const captured = stamp();
      setBusyRow(rowId);
      setRowResult(null);
      try {
        await stepUp.runStepUpAction(request);
        if (isStale(captured)) return;
        setRowResult({ rowId, ok: true, message: successMessage });
        // Always re-read the authoritative projection; never patch locally.
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        if (isStepUpCancel(err)) return;
        const classified = classifyFailure(err, fallbackMessage);
        setRowResult({ rowId, ok: false, message: classified.message });
      } finally {
        if (!isStale(captured)) setBusyRow(null);
      }
    },
    [stepUp, load, stamp, isStale],
  );

  const changeRole = useCallback(
    async (member: MemberProjection) => {
      const nextRole = roleDraft[member.teamMemberId];
      if (!nextRole || nextRole === member.role) return;
      const ok = await confirm({
        title: `Change role to ${nextRole}?`,
        description:
          "The member's effective permissions change immediately. Step-up confirmation is required, and the change is recorded against your identity in the audit trail.",
        confirmLabel: "Change role",
        tone: "warning",
        testId: "identity-member-role-change",
      });
      if (!ok) return;
      await run(
        member.teamMemberId,
        `Role changed to ${nextRole}.`,
        "Could not change the role.",
        (headers) =>
          apiFetch(`/v1/identity/members/${member.teamMemberId}/role`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              role: nextRole,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            }),
          }),
      );
    },
    [roleDraft, confirm, run, reason],
  );

  const lifecycle = useCallback(
    async (member: MemberProjection, action: "suspend" | "restore" | "revoke") => {
      const copy = {
        suspend: {
          title: "Suspend this member?",
          description:
            "Access stops immediately and every active session is revoked. The held role is preserved so the member can be restored.",
          confirmLabel: "Suspend member",
          tone: "danger" as const,
          success: "Member suspended.",
        },
        restore: {
          title: "Restore this member?",
          description:
            "The member regains the role they held before suspension. Step-up confirmation is required.",
          confirmLabel: "Restore member",
          tone: "warning" as const,
          success: "Member restored.",
        },
        revoke: {
          title: "Revoke this member?",
          description:
            "Access is removed for good and every grant source (invite, SSO, SCIM) is closed. Re-admitting them needs a new invitation.",
          confirmLabel: "Revoke member",
          tone: "danger" as const,
          success: "Member revoked.",
        },
      }[action];
      const ok = await confirm({
        title: copy.title,
        description: copy.description,
        confirmLabel: copy.confirmLabel,
        tone: copy.tone,
        testId: `identity-member-${action}`,
      });
      if (!ok) return;
      await run(
        member.teamMemberId,
        copy.success,
        `Could not ${action} the member.`,
        (headers) =>
          apiFetch(`/v1/identity/members/${member.teamMemberId}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(
              reason.trim() ? { reason: reason.trim() } : {},
            ),
          }),
      );
    },
    [confirm, run, reason],
  );

  const grantCapability = useCallback(async () => {
    if (!selected) return;
    await run(
      selected.teamMemberId,
      `Capability ${permissionDraft} granted.`,
      "Could not grant the capability.",
      (headers) =>
        apiFetch(`/v1/identity/members/${selected.teamMemberId}/capabilities`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            permission: permissionDraft,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          }),
        }),
    );
  }, [selected, permissionDraft, reason, run]);

  const revokeCapability = useCallback(
    async (grant: CapabilityGrant) => {
      if (!selected) return;
      const ok = await confirm({
        title: "Revoke this capability?",
        description:
          "The member loses this permission immediately unless their role already grants it.",
        confirmLabel: "Revoke capability",
        tone: "danger",
        testId: "identity-capability-revoke",
      });
      if (!ok) return;
      await run(
        selected.teamMemberId,
        `Capability ${grant.permission} revoked.`,
        "Could not revoke the capability.",
        (headers) =>
          apiFetch(`/v1/identity/capabilities/${grant.id}`, {
            method: "DELETE",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(
              reason.trim() ? { reason: reason.trim() } : {},
            ),
          }),
      );
    },
    [selected, confirm, run, reason],
  );

  const grantDelegated = useCallback(async () => {
    if (!selected) return;
    await run(
      selected.teamMemberId,
      `Delegated scope ${scopeDraft} granted.`,
      "Could not grant the delegated-admin scope.",
      (headers) =>
        apiFetch(
          `/v1/identity/members/${selected.teamMemberId}/delegated-admin`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              scopeKind: scopeDraft,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            }),
          },
        ),
    );
  }, [selected, scopeDraft, reason, run]);

  const revokeDelegated = useCallback(
    async (scope: DelegatedScope) => {
      if (!selected) return;
      const ok = await confirm({
        title: "Revoke this delegated-admin scope?",
        description:
          "The member loses the administrative surface this scope opened, immediately.",
        confirmLabel: "Revoke scope",
        tone: "danger",
        testId: "identity-delegated-admin-revoke",
      });
      if (!ok) return;
      await run(
        selected.teamMemberId,
        `Delegated scope ${scope.scopeKind} revoked.`,
        "Could not revoke the delegated-admin scope.",
        (headers) =>
          apiFetch(`/v1/identity/delegated-admin/${scope.id}`, {
            method: "DELETE",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(
              reason.trim() ? { reason: reason.trim() } : {},
            ),
          }),
      );
    },
    [selected, confirm, run, reason],
  );

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------

  const columns: DataTableColumn<MemberProjection>[] = [
    {
      key: "member",
      header: "Member",
      render: (m) => (
        <div data-identity-member-row={m.teamMemberId}>
          <code style={{ fontSize: 12 }}>{shortId(m.userId)}</code>
          {rowResult && rowResult.rowId === m.teamMemberId ? (
            <div
              data-identity-member-result={rowResult.ok ? "ok" : "failed"}
              style={{
                ...mutedStyle,
                marginTop: 2,
                color: rowResult.ok ? "#065f46" : "#991b1b",
              }}
            >
              {rowResult.message}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (m) => <Badge tone="governance">{m.role}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      render: (m) => <StatusBadge status={m.status} />,
    },
    {
      key: "grants",
      header: "Extra access",
      render: (m) => (
        <span style={mutedStyle}>
          {activeOnly(m.capabilityGrants).length} capabilit
          {activeOnly(m.capabilityGrants).length === 1 ? "y" : "ies"},{" "}
          {activeOnly(m.delegatedAdminScopes).length} scope
          {activeOnly(m.delegatedAdminScopes).length === 1 ? "" : "s"}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Access expires",
      nowrap: true,
      render: (m) => <span style={mutedStyle}>{fmt(m.accessExpiresAtUtc)}</span>,
    },
    {
      key: "lastseen",
      header: "Last seen",
      nowrap: true,
      render: (m) => <span style={mutedStyle}>{fmt(m.lastSeenAtUtc)}</span>,
    },
  ];

  return (
    <>
      <PageSection
        title="Members"
        description="Everyone with an operational membership in the workspace you are administering. Role, status and extra access come from the server's access projection — this console never computes them."
        action={
          <Button
            variant="secondary"
            size="sm"
            data-identity-members-refresh
            onClick={() => void load()}
          >
            Refresh
          </Button>
        }
      >
        {failure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-identity-members-failure={failure.kind}
          >
            <strong>
              {failure.kind === "denied"
                ? "Not available to you"
                : failure.kind === "blocked"
                  ? "Refused"
                  : "Could not load"}
            </strong>
            <div style={{ marginTop: 4 }}>{failure.message}</div>
          </Card>
        ) : null}

        <FilterBar>
          <FilterBar.Search
            value={search}
            onChange={setSearch}
            label="Filter by member id"
            placeholder="Filter by member id…"
          />
          <FilterBar.Select
            label="Status"
            showLabel
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTERS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
          />
        </FilterBar>

        <div style={{ marginTop: 12 }} data-identity-members-table>
          <DataTable<MemberProjection>
            ariaLabel="Workspace members"
            columns={columns}
            rows={visible as MemberProjection[]}
            getRowId={(m) => m.teamMemberId}
            loading={members === null}
            emptyState={
              failure ? (
                <EmptyState
                  title="Member list unavailable"
                  purpose={failure.message}
                />
              ) : (
                <EmptyState
                  title="No members match"
                  purpose="Adjust the status filter or the member-id filter. Newly invited people appear once they accept."
                />
              )
            }
            rowActions={(m) => (
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  alignItems: "center",
                }}
              >
                <select
                  aria-label="Role"
                  data-identity-member-role-select={m.teamMemberId}
                  style={selectStyle}
                  value={roleDraft[m.teamMemberId] ?? m.role}
                  disabled={busyRow === m.teamMemberId}
                  onChange={(e) =>
                    setRoleDraft((prev) => ({
                      ...prev,
                      [m.teamMemberId]: e.target.value,
                    }))
                  }
                >
                  {[m.role, ...ASSIGNABLE_ROLES.filter((r) => r !== m.role)].map(
                    (r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ),
                  )}
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  data-identity-member-role-apply={m.teamMemberId}
                  disabled={
                    busyRow === m.teamMemberId ||
                    (roleDraft[m.teamMemberId] ?? m.role) === m.role
                  }
                  onClick={() => void changeRole(m)}
                >
                  Apply role
                </Button>
                {m.status === "ACTIVE" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    data-identity-member-suspend={m.teamMemberId}
                    disabled={busyRow === m.teamMemberId}
                    onClick={() => void lifecycle(m, "suspend")}
                  >
                    Suspend
                  </Button>
                ) : null}
                {m.status === "SUSPENDED" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    data-identity-member-restore={m.teamMemberId}
                    disabled={busyRow === m.teamMemberId}
                    onClick={() => void lifecycle(m, "restore")}
                  >
                    Restore
                  </Button>
                ) : null}
                {m.status !== "REVOKED" ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    data-identity-member-revoke={m.teamMemberId}
                    disabled={busyRow === m.teamMemberId}
                    onClick={() => void lifecycle(m, "revoke")}
                  >
                    Revoke
                  </Button>
                ) : null}
                <Button
                  variant={selectedId === m.teamMemberId ? "enterprise" : "ghost"}
                  size="sm"
                  data-identity-member-manage-access={m.teamMemberId}
                  onClick={() =>
                    setSelectedId(
                      selectedId === m.teamMemberId ? null : m.teamMemberId,
                    )
                  }
                >
                  {selectedId === m.teamMemberId ? "Managing" : "Access"}
                </Button>
              </div>
            )}
          />
          {/* listTeamMembersWithAccess runs findMany with no take, so the
              browser holds EVERY member. That is what makes the filters above
              honest client-side controls, and it is declared and proved in
              scripts/admin-complete-lists.mjs. */}
          <ResultCount
            shown={visible.length}
            complete
            noun="member"
            filtered={visible.length !== (members ?? []).length}
            loading={members === null}
            failed={failure !== null}
            data-testid="admin-identity-members-count"
          />
        </div>

        <Card variant="admin" padding="compact" style={{ marginTop: 12 }}>
          <label
            htmlFor="identity-admin-reason"
            style={{ ...mutedStyle, display: "block", marginBottom: 4 }}
          >
            Reason (optional) — recorded on the audit entry for the next action
            you take on this surface.
          </label>
          <input
            id="identity-admin-reason"
            data-identity-admin-reason
            style={{ ...inputStyle, maxWidth: 520 }}
            value={reason}
            maxLength={400}
            placeholder="e.g. offboarding ticket OPS-1421"
            onChange={(e) => setReason(e.target.value)}
          />
        </Card>
      </PageSection>

      {/* ------------------------------------------------------------------ */}
      {/* Extra access for ONE member: capability grants + delegated scopes.  */}
      {/* ------------------------------------------------------------------ */}
      <PageSection
        title={
          selected
            ? `Extra access — ${shortId(selected.userId)}`
            : "Extra access"
        }
        description="Capabilities and delegated-admin scopes stack on top of the member's role. Both are time-bounded when the grant carries an expiry, and both are revocable here."
      >
        {!selected ? (
          <EmptyState
            framed
            title="No member selected"
            purpose="Choose Access on a member above to review and change the capabilities and delegated-admin scopes they hold."
          />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            <Card
              variant="admin"
              padding="comfortable"
              title="Capability grants"
              data-identity-capabilities-panel
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <select
                  aria-label="Capability"
                  data-identity-capability-select
                  style={{ ...selectStyle, maxWidth: 260 }}
                  value={permissionDraft}
                  onChange={(e) =>
                    setPermissionDraft(e.target.value as Permission)
                  }
                >
                  {PERMISSIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <Button
                  variant="enterprise"
                  size="sm"
                  data-identity-capability-grant
                  disabled={busyRow === selected.teamMemberId}
                  onClick={() => void grantCapability()}
                >
                  Grant
                </Button>
              </div>
              {activeOnly(selected.capabilityGrants).length === 0 ? (
                <p style={mutedStyle}>
                  No capability grants. This member has exactly what their role
                  gives them.
                </p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {activeOnly(selected.capabilityGrants).map((g) => (
                    <li
                      key={g.id}
                      data-identity-capability-row={g.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                      }}
                    >
                      <span>
                        <code style={{ fontSize: 12 }}>{g.permission}</code>
                        <span style={{ ...mutedStyle, display: "block" }}>
                          granted {fmt(g.grantedAtUtc)}
                          {g.expiresAtUtc ? ` · expires ${fmt(g.expiresAtUtc)}` : ""}
                        </span>
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        data-identity-capability-revoke={g.id}
                        disabled={busyRow === selected.teamMemberId}
                        onClick={() => void revokeCapability(g)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              variant="admin"
              padding="comfortable"
              title="Delegated administration"
              data-identity-delegated-panel
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <select
                  aria-label="Delegated-admin scope"
                  data-identity-delegated-select
                  style={{ ...selectStyle, maxWidth: 260 }}
                  value={scopeDraft}
                  onChange={(e) =>
                    setScopeDraft(e.target.value as DelegatedAdminScopeKind)
                  }
                >
                  {DELEGATED_ADMIN_SCOPE_KINDS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button
                  variant="enterprise"
                  size="sm"
                  data-identity-delegated-grant
                  disabled={busyRow === selected.teamMemberId}
                  onClick={() => void grantDelegated()}
                >
                  Grant
                </Button>
              </div>
              {activeOnly(selected.delegatedAdminScopes).length === 0 ? (
                <p style={mutedStyle}>
                  No delegated-admin scopes. Administrative surfaces stay with
                  the owner and administrators.
                </p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {activeOnly(selected.delegatedAdminScopes).map((s) => (
                    <li
                      key={s.id}
                      data-identity-delegated-row={s.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                      }}
                    >
                      <span>
                        <code style={{ fontSize: 12 }}>{s.scopeKind}</code>
                        <span style={{ ...mutedStyle, display: "block" }}>
                          granted {fmt(s.grantedAtUtc)}
                          {s.expiresAtUtc ? ` · expires ${fmt(s.expiresAtUtc)}` : ""}
                        </span>
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        data-identity-delegated-revoke={s.id}
                        disabled={busyRow === selected.teamMemberId}
                        onClick={() => void revokeDelegated(s)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </PageSection>
    </>
  );
}
