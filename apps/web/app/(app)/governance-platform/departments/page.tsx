"use client";

/**
 * PHASE 12B CLUSTER 14 — Department membership governance console.
 *
 * Departments are the isolation boundary the evidence-visibility resolver
 * (`resolveUserDepartmentScope`) reads: an operator without an unrestricted
 * scope sees only evidence tagged to a department they hold an ACTIVE
 * membership in. Granting a membership therefore WIDENS someone's evidence
 * visibility, and revoking one NARROWS it — both are governance decisions,
 * not administrative bookkeeping.
 *
 * Hard rules enforced on this surface:
 *
 *   * Organization is SERVER-derived. The listing endpoint returns the
 *     Organization for the caller's resolved workspace; this page never asks
 *     an operator to type an Organization UUID and never derives tenancy
 *     from a row it rendered.
 *   * Role/capability is SERVER-derived. The page renders whatever denial the
 *     API returns (`DELEGATED_ADMIN_REQUIRED`, `permission_denied`); it never
 *     decides locally whether the operator may grant or revoke.
 *   * Grant and revoke are step-up gated. Both go through
 *     `useStepUpAction`, which surfaces the challenge modal on the
 *     structured 401 and retries the ORIGINAL request exactly once with the
 *     verified challenge id.
 *   * Every mutation declares the state it observed (`expectedState`). If the
 *     row moved underneath the console, the API refuses with STALE_STATE
 *     rather than overwriting another operator's decision.
 *   * Revoke requires explicit confirmation before the request is sent.
 *   * Responses that land after a workspace switch are dropped (tenant
 *     generation guard), so one Organization's memberships can never paint
 *     into another's console.
 *
 * The membership list shows user ids + bounded role/state enums only — never
 * names, emails, or any other subject PII.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEPARTMENT_MEMBERSHIP_ROLES,
  type DepartmentMembershipProjection,
  type DepartmentMembershipRole,
  type DepartmentMembershipState,
  type DepartmentProjection,
  type DepartmentScopeEnvelope,
} from "@proovra/shared";

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
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId, useTenantGuard } from "../../../../lib/platform-context";

// ---------------------------------------------------------------------------
// Bounded failure vocabulary.
// ---------------------------------------------------------------------------

type SurfaceFailure = {
  /**
   *   denied — the API refused on authorization (capability, delegated tier,
   *            membership status, or anti-enumeration 404).
   *   stale  — the row moved underneath the console; reload and retry.
   *   error  — anything else, rendered via the sanctioned safe-error path.
   */
  kind: "denied" | "stale" | "error";
  message: string;
};

/** Bounded denial → operator copy. Never a raw backend string. */
const DENIAL_COPY: Record<string, string> = {
  DELEGATED_ADMIN_REQUIRED:
    "This action requires the DEPARTMENT_ADMIN delegated-admin tier in this organization.",
  DEPARTMENT_NOT_FOUND:
    "That department is not part of your current organization.",
  USER_NOT_A_MEMBER:
    "That user is not an active member of this workspace, so they cannot hold a department membership here.",
  ALREADY_REVOKED: "That membership was already revoked.",
  NOT_FOUND: "That membership no longer exists in this organization.",
  POLICY_REJECTED: "The requested role is not permitted.",
  STALE_STATE:
    "This membership changed while the page was open. The list has been reloaded — review it and try again.",
  ENTITLEMENT_REQUIRED:
    "Department isolation is not enabled on your current plan.",
};

function readDenialCode(err: unknown): string | null {
  const details =
    err instanceof ApiError
      ? err.details
      : (err as { details?: Record<string, unknown> })?.details;
  if (details && typeof details["denial"] === "string") {
    return details["denial"] as string;
  }
  // Several governance routes send `{ denial: "..." }` at the body root; the
  // client normalizer promotes root fields into `details`, but fall through to
  // the top-level shape defensively.
  const root = err as { denial?: unknown };
  return typeof root?.denial === "string" ? root.denial : null;
}

function classifyFailure(err: unknown, fallback: string): SurfaceFailure {
  const e = err as { statusCode?: number; code?: string };
  // A cancelled step-up is the operator's own choice, not a failure worth
  // shouting about — the caller filters it out before reaching here.
  const denial = readDenialCode(err);
  if (denial === "STALE_STATE") {
    return { kind: "stale", message: DENIAL_COPY.STALE_STATE };
  }
  if (denial && DENIAL_COPY[denial]) {
    return {
      kind: e?.statusCode === 403 || e?.statusCode === 404 ? "denied" : "error",
      message: DENIAL_COPY[denial],
    };
  }
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return {
      kind: "denied",
      message:
        "You do not have the governance permission required for this action in the current workspace.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, { message: fallback }).message,
  };
}

function isStepUpCancel(err: unknown): boolean {
  return (err as { code?: string })?.code === "STEP_UP_CANCEL";
}

const MEMBERSHIP_STATE_FILTERS = [
  { value: "ALL", label: "All states" },
  { value: "ACTIVE", label: "Active" },
  { value: "REVOKED", label: "Revoked" },
] as const;

export default function DepartmentsPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();
  // Step-up is bound to the active workspace so the challenge is issued
  // against the right tenant.
  const stepUp = useStepUpAction({ teamId });

  // --- Departments ---------------------------------------------------------
  const [rows, setRows] = useState<ReadonlyArray<DepartmentProjection>>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [departmentsLoaded, setDepartmentsLoaded] = useState(false);
  const [departmentsFailure, setDepartmentsFailure] =
    useState<SurfaceFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  // --- Effective department scope (self) -----------------------------------
  const [scope, setScope] = useState<DepartmentScopeEnvelope | null>(null);
  const [scopeFailure, setScopeFailure] = useState<SurfaceFailure | null>(null);

  // --- Memberships ---------------------------------------------------------
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<
    string | null
  >(null);
  const [memberships, setMemberships] = useState<
    ReadonlyArray<DepartmentMembershipProjection> | null
  >(null);
  const [membershipsFailure, setMembershipsFailure] =
    useState<SurfaceFailure | null>(null);
  const [stateFilter, setStateFilter] = useState<"ALL" | DepartmentMembershipState>(
    "ACTIVE",
  );
  const [grantUserId, setGrantUserId] = useState("");
  const [grantRole, setGrantRole] = useState<DepartmentMembershipRole>("MEMBER");
  const [mutating, setMutating] = useState(false);
  const [mutationFailure, setMutationFailure] = useState<SurfaceFailure | null>(
    null,
  );
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);

  const selectedDepartment = useMemo(
    () => rows.find((d) => d.id === selectedDepartmentId) ?? null,
    [rows, selectedDepartmentId],
  );

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    const captured = stamp();
    setBusy(true);
    setDepartmentsFailure(null);
    try {
      const res = await apiFetch("/v1/governance/departments", { method: "GET" });
      if (isStale(captured)) return;
      const departments = (res?.departments ??
        []) as ReadonlyArray<DepartmentProjection>;
      setRows(departments);
      // SERVER-DERIVED Organization — never typed by the operator, never
      // inferred from a rendered row.
      setOrganizationId(
        typeof res?.organizationId === "string" ? res.organizationId : null,
      );
      setDepartmentsLoaded(true);
    } catch (err) {
      if (isStale(captured)) return;
      setRows([]);
      setOrganizationId(null);
      setDepartmentsLoaded(true);
      setDepartmentsFailure(
        classifyFailure(err, "Unable to load departments."),
      );
    } finally {
      if (!isStale(captured)) setBusy(false);
    }
  }, [stamp, isStale]);

  const loadScope = useCallback(async () => {
    const captured = stamp();
    setScopeFailure(null);
    try {
      const res: { scope: DepartmentScopeEnvelope } = await apiFetch(
        "/v1/governance/me/department-scope",
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setScope(res.scope);
    } catch (err) {
      if (isStale(captured)) return;
      setScope(null);
      setScopeFailure(
        classifyFailure(err, "Unable to resolve your department scope."),
      );
    }
  }, [stamp, isStale]);

  const loadMemberships = useCallback(async () => {
    if (!selectedDepartmentId) {
      setMemberships(null);
      setMembershipsFailure(null);
      return;
    }
    const captured = stamp();
    setMemberships(null);
    setMembershipsFailure(null);
    const params = new URLSearchParams();
    if (stateFilter !== "ALL") params.set("state", stateFilter);
    const qs = params.toString();
    try {
      const res: {
        memberships: ReadonlyArray<DepartmentMembershipProjection>;
      } = await apiFetch(
        `/v1/governance/departments/${selectedDepartmentId}/memberships${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setMemberships(res.memberships ?? []);
    } catch (err) {
      if (isStale(captured)) return;
      setMemberships([]);
      setMembershipsFailure(
        classifyFailure(err, "Unable to load department memberships."),
      );
    }
  }, [selectedDepartmentId, stateFilter, stamp, isStale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadScope();
  }, [loadScope]);

  useEffect(() => {
    void loadMemberships();
  }, [loadMemberships]);

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  const create = useCallback(async () => {
    setBusy(true);
    setDepartmentsFailure(null);
    try {
      // organizationId is deliberately NOT sent — the API derives it from the
      // resolved workspace.
      await apiFetch("/v1/governance/departments", {
        method: "POST",
        body: JSON.stringify({ name, slug }),
        headers: { "content-type": "application/json" },
      });
      setName("");
      setSlug("");
      await refresh();
    } catch (err) {
      setDepartmentsFailure(
        classifyFailure(err, "Could not create the department."),
      );
    } finally {
      setBusy(false);
    }
  }, [name, slug, refresh]);

  /**
   * Grant. Declares the state the console observed for this (department,
   * user) pair so a concurrent change is refused rather than overwritten,
   * and routes through step-up so the structured 401 opens the challenge
   * modal and the ORIGINAL grant is retried once after verification.
   */
  const grant = useCallback(async () => {
    if (!selectedDepartmentId || !grantUserId.trim()) return;
    const subjectUserId = grantUserId.trim();
    const observed =
      memberships?.find((m) => m.userId === subjectUserId)?.state ?? "NONE";
    setMutating(true);
    setMutationFailure(null);
    setMutationNotice(null);
    try {
      const res = await stepUp.runStepUpAction(async (headers) =>
        apiFetch(
          `/v1/governance/departments/${selectedDepartmentId}/memberships`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              userId: subjectUserId,
              role: grantRole,
              expectedState: observed,
            }),
          },
        ),
      );
      setGrantUserId("");
      setMutationNotice(
        (res as { unchanged?: boolean })?.unchanged
          ? "No change — that membership was already active with this role."
          : "Membership granted.",
      );
      // Reload after mutation so the rendered state is the server's, not an
      // optimistic guess.
      await loadMemberships();
      await loadScope();
    } catch (err) {
      if (!isStepUpCancel(err)) {
        setMutationFailure(
          classifyFailure(err, "Could not grant the membership."),
        );
        // A stale-state refusal means the console was out of date; pull the
        // authoritative list before the operator retries.
        if (readDenialCode(err) === "STALE_STATE") await loadMemberships();
      }
    } finally {
      setMutating(false);
    }
  }, [
    selectedDepartmentId,
    grantUserId,
    grantRole,
    memberships,
    stepUp,
    loadMemberships,
    loadScope,
  ]);

  /**
   * Revoke. Explicit confirmation first (it removes evidence visibility and
   * can strand in-flight review work), then step-up, then the state-guarded
   * request.
   */
  const revoke = useCallback(
    async (membership: DepartmentMembershipProjection) => {
      const confirmed = await confirm({
        title: "Revoke department membership?",
        description:
          "This removes the member's department-scoped evidence visibility immediately. The membership row is retained as REVOKED for audit. Step-up authentication is required on the next request.",
        confirmLabel: "Revoke membership",
        tone: "danger",
        testId: "department-membership-revoke",
      });
      if (!confirmed) return;
      setMutating(true);
      setMutationFailure(null);
      setMutationNotice(null);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/governance/departments/memberships/${membership.id}/revoke`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ expectedState: membership.state }),
            },
          ),
        );
        setMutationNotice("Membership revoked.");
        await loadMemberships();
        await loadScope();
      } catch (err) {
        if (!isStepUpCancel(err)) {
          setMutationFailure(
            classifyFailure(err, "Could not revoke the membership."),
          );
          if (readDenialCode(err) === "STALE_STATE") await loadMemberships();
        }
      } finally {
        setMutating(false);
      }
    },
    [confirm, stepUp, loadMemberships, loadScope],
  );

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const columns: DataTableColumn<DepartmentProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (d) => (
        <span data-department-row={d.id} data-department-state={d.state}>
          {d.name}
        </span>
      ),
    },
    { key: "slug", header: "Slug", render: (d) => <code>{d.slug}</code> },
    { key: "state", header: "State", render: (d) => <StatusBadge status={d.state} /> },
    { key: "created", header: "Created", render: (d) => formatUserDate(d.createdAtUtc) },
  ];

  const membershipColumns: DataTableColumn<DepartmentMembershipProjection>[] = [
    {
      key: "user",
      header: "Member",
      render: (m) => (
        <code data-department-membership-row={m.id}>
          {m.userId.slice(0, 8)}…
        </code>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (m) => <Badge tone="governance">{m.role}</Badge>,
    },
    {
      key: "state",
      header: "State",
      render: (m) => <StatusBadge status={m.state} />,
    },
    {
      key: "grantedBy",
      header: "Granted by",
      render: (m) =>
        m.grantedByUserId ? (
          <code>{m.grantedByUserId.slice(0, 8)}…</code>
        ) : (
          <span style={muted}>—</span>
        ),
    },
    {
      key: "granted",
      header: "Granted",
      render: (m) => formatUserDate(m.createdAtUtc),
    },
    {
      key: "revoked",
      header: "Revoked",
      render: (m) =>
        m.revokedAtUtc ? (
          formatUserDate(m.revokedAtUtc)
        ) : (
          <span style={muted}>—</span>
        ),
    },
  ];

  return (
    <PageShell
      data-departments-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Departments"
          subtitle="Department isolation for evidence visibility and governance separation. Membership decides what a scoped operator can see."
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-departments-refresh
              disabled={busy}
              loading={busy}
              onClick={() => {
                void refresh();
                void loadMemberships();
                void loadScope();
              }}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      {departmentsFailure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-departments-failure={departmentsFailure.kind}
        >
          {departmentsFailure.message}
        </Card>
      ) : null}

      {/* PHASE 12B CLUSTER 10 — the caller's own effective department scope,
          as resolved by the server. Explains WHY the operator sees what they
          see; it is never used to gate anything client-side. */}
      <PageSection title="Your effective scope">
        {scopeFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-department-scope-failure={scopeFailure.kind}
          >
            {scopeFailure.message}
          </Card>
        ) : !scope ? (
          <p style={muted} data-department-scope-loading>
            Resolving your department scope…
          </p>
        ) : (
          <Card
            variant="admin"
            padding="compact"
            data-department-scope-unrestricted={String(scope.unrestricted)}
          >
            {scope.unrestricted ? (
              <>
                <strong>Unrestricted.</strong>{" "}
                <span style={muted}>
                  Your workspace role sees evidence across every department in
                  this organization. Cross-department reads by an unrestricted
                  role are recorded in the trust audit trail.
                </span>
              </>
            ) : scope.allowedDepartmentIds.length === 0 ? (
              <>
                <strong>No department memberships.</strong>{" "}
                <span style={muted}>
                  Department-tagged evidence is not visible to you until an
                  administrator grants you a membership below.
                </span>
              </>
            ) : (
              <>
                <strong>
                  {scope.allowedDepartmentIds.length} department
                  {scope.allowedDepartmentIds.length === 1 ? "" : "s"}.
                </strong>{" "}
                <span style={muted}>
                  You see evidence tagged to:{" "}
                  {scope.allowedDepartmentIds
                    .map(
                      (id) =>
                        rows.find((d) => d.id === id)?.name ??
                        `${id.slice(0, 8)}…`,
                    )
                    .join(", ")}
                  .
                </span>
              </>
            )}
          </Card>
        )}
      </PageSection>

      <PageSection title="Create department">
        <Card variant="admin" padding="compact" data-department-create-form>
          <p style={{ ...muted, marginTop: 0 }}>
            The organization is taken from your active workspace
            {organizationId ? (
              <>
                {" "}
                (<code>{organizationId.slice(0, 8)}…</code>)
              </>
            ) : null}
            . It is not something you set here.
          </p>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              data-department-name
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={input}
            />
            <input
              data-department-slug
              placeholder="slug (lowercase)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={input}
            />
            <Button
              variant="enterprise"
              data-department-create-submit
              disabled={busy || !name || !slug}
              onClick={() => void create()}
            >
              Create
            </Button>
          </div>
        </Card>
      </PageSection>

      <PageSection title="Departments">
        <div data-departments-table>
          <DataTable<DepartmentProjection>
            ariaLabel="Departments"
            columns={columns}
            rows={rows as DepartmentProjection[]}
            getRowId={(d) => d.id}
            loading={!departmentsLoaded}
            emptyState={
              <EmptyState
                title="No departments"
                purpose="Departments isolate evidence visibility and governance within an organization. Create one above to get started."
              />
            }
            rowActions={(d) => (
              <Button
                variant={selectedDepartmentId === d.id ? "enterprise" : "secondary"}
                size="sm"
                data-department-manage-members={d.id}
                onClick={() =>
                  setSelectedDepartmentId(
                    selectedDepartmentId === d.id ? null : d.id,
                  )
                }
              >
                {selectedDepartmentId === d.id ? "Managing" : "Members"}
              </Button>
            )}
          />
        </div>
      </PageSection>

      {/* PHASE 12B CLUSTER 14 — membership governance for the selected
          department. Grant and revoke are step-up gated, state-guarded, and
          reload from the server after every mutation. */}
      <PageSection
        title={
          selectedDepartment
            ? `Memberships — ${selectedDepartment.name}`
            : "Memberships"
        }
        action={
          selectedDepartmentId ? (
            <FilterBar>
              <FilterBar.Select
                label="State"
                showLabel
                value={stateFilter}
                onChange={(v) =>
                  setStateFilter(v as "ALL" | DepartmentMembershipState)
                }
                options={MEMBERSHIP_STATE_FILTERS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
              />
            </FilterBar>
          ) : undefined
        }
      >
        {!selectedDepartmentId ? (
          <EmptyState
            framed
            title="No department selected"
            purpose="Choose Members on a department above to review and change who holds a membership in it."
          />
        ) : (
          <>
            {mutationFailure ? (
              <Card
                variant="status"
                tone="risk"
                padding="compact"
                data-department-membership-failure={mutationFailure.kind}
              >
                {mutationFailure.message}
              </Card>
            ) : null}
            {mutationNotice ? (
              <Card
                variant="status"
                tone="verified"
                padding="compact"
                data-department-membership-notice
              >
                {mutationNotice}
              </Card>
            ) : null}

            <Card variant="admin" padding="compact" data-department-grant-form>
              <p style={{ ...muted, marginTop: 0 }}>
                Granting a membership widens what this member can see. The
                request requires step-up confirmation.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <input
                  data-department-grant-user-id
                  placeholder="Member user UUID"
                  value={grantUserId}
                  onChange={(e) => setGrantUserId(e.target.value)}
                  style={input}
                />
                <select
                  data-department-grant-role
                  value={grantRole}
                  onChange={(e) =>
                    setGrantRole(e.target.value as DepartmentMembershipRole)
                  }
                  style={input}
                >
                  {DEPARTMENT_MEMBERSHIP_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Button
                  variant="enterprise"
                  data-department-grant-submit
                  disabled={mutating || !grantUserId.trim()}
                  loading={mutating}
                  onClick={() => void grant()}
                >
                  Grant membership
                </Button>
              </div>
            </Card>

            {membershipsFailure ? (
              <Card
                variant="status"
                tone="risk"
                padding="compact"
                data-department-memberships-failure={membershipsFailure.kind}
              >
                {membershipsFailure.message}
              </Card>
            ) : (
              <div data-department-memberships-table>
                <DataTable<DepartmentMembershipProjection>
                  ariaLabel="Department memberships"
                  columns={membershipColumns}
                  rows={
                    (memberships ?? []) as DepartmentMembershipProjection[]
                  }
                  getRowId={(m) => m.id}
                  loading={!memberships}
                  emptyState={
                    <EmptyState
                      title="No memberships"
                      purpose="Nobody holds a membership in this department under the current filter."
                    />
                  }
                  rowActions={(m) =>
                    m.state === "ACTIVE" ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        data-department-membership-revoke={m.id}
                        disabled={mutating}
                        onClick={() => void revoke(m)}
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
          </>
        )}
      </PageSection>

      {/* Step-up challenge host. Renders nothing until a mutation hits the
          structured 401. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

const muted: React.CSSProperties = { fontSize: 12, color: "#64748b" };

const input = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  minWidth: 180,
} as const;
