"use client";

import { useCallback, useEffect, useState } from "react";

import {
  GOVERNANCE_POLICY_KINDS,
  type DepartmentProjection,
  type GovernancePolicyKind,
  type GovernancePolicyProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { GovernancePolicyForm } from "../../../../components/governance/GovernancePolicyForm";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../lib/platform-context";

/**
 * PHASE 12B CLUSTER 10 — `GET /v1/governance/policies/effective`.
 *
 * The ORGANIZATION and WORKSPACE legs of the inheritance chain are derived
 * SERVER-side from the caller's resolved workspace; the client may only
 * narrow by department. `scope` echoes what the server actually resolved, so
 * this page never has to (and never does) infer the chain itself.
 */
type EffectivePoliciesResponse = {
  effective: ReadonlyArray<GovernancePolicyProjection>;
  scope: {
    organizationId: string;
    departmentId: string | null;
    workspaceId: string;
  };
};

type ReadFailure = { kind: "denied" | "error"; message: string };

function classifyReadFailure(err: unknown): ReadFailure {
  const e = err as { statusCode?: number };
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return {
      kind: "denied",
      message:
        "You do not have the governance permission required to resolve the effective policy chain in the current workspace.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, {
      message: "Unable to resolve the effective policy chain.",
    }).message,
  };
}

type PermissionDenialState = {
  denial: string;
  tier: string;
} | null;

export default function PoliciesPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<GovernancePolicyProjection>>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // PHASE 12B CLUSTER 10 — tenant generation guard for the effective-chain
  // reads: a response that lands after a workspace switch is dropped.
  const { stamp, isStale } = useTenantGuard();

  const [effective, setEffective] = useState<EffectivePoliciesResponse | null>(
    null,
  );
  const [effectiveFailure, setEffectiveFailure] = useState<ReadFailure | null>(
    null,
  );
  const [kindFilter, setKindFilter] = useState<GovernancePolicyKind | "ALL">(
    "ALL",
  );
  const [departmentFilter, setDepartmentFilter] = useState<string>("");
  const [departments, setDepartments] = useState<
    ReadonlyArray<DepartmentProjection>
  >([]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = await apiFetch("/v1/governance/policies", { method: "GET" });
      setRows((res?.policies ?? []) as ReadonlyArray<GovernancePolicyProjection>);
    } catch (err) {
      setRows([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const activate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/activate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const deprecate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/deprecate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const loadEffective = useCallback(async () => {
    const captured = stamp();
    setEffective(null);
    setEffectiveFailure(null);
    const params = new URLSearchParams();
    if (kindFilter !== "ALL") params.set("kind", kindFilter);
    if (departmentFilter) params.set("departmentId", departmentFilter);
    const qs = params.toString();
    try {
      const res: EffectivePoliciesResponse = await apiFetch(
        `/v1/governance/policies/effective${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setEffective(res);
    } catch (err) {
      if (isStale(captured)) return;
      setEffectiveFailure(classifyReadFailure(err));
    }
  }, [kindFilter, departmentFilter, stamp, isStale]);

  // Departments only narrow the chain; a failure here must not blank the
  // effective resolution, so it degrades to "no department narrowing".
  const loadDepartments = useCallback(async () => {
    const captured = stamp();
    try {
      const res = await apiFetch("/v1/governance/departments", { method: "GET" });
      if (isStale(captured)) return;
      setDepartments(
        (res?.departments ?? []) as ReadonlyArray<DepartmentProjection>,
      );
    } catch {
      if (isStale(captured)) return;
      setDepartments([]);
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    void loadEffective();
  }, [loadEffective]);

  const effectiveColumns: DataTableColumn<GovernancePolicyProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (p) => (
        <span data-effective-policy-row={p.id} data-effective-policy-kind={p.kind}>
          {p.name}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (p) => <code>{p.kind}</code> },
    { key: "slug", header: "Slug", render: (p) => <code>{p.slug}</code> },
    {
      key: "enforcementMode",
      header: "Enforcement",
      render: (p) => <Badge tone="governance">{p.enforcementMode}</Badge>,
    },
    { key: "version", header: "Version", render: (p) => `v${p.version}` },
    {
      key: "summary",
      header: "Summary",
      render: (p) =>
        p.summary ? (
          <span style={{ fontSize: 12 }}>{p.summary}</span>
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
  ];

  const columns: DataTableColumn<GovernancePolicyProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (p) => (
        <span
          data-governance-policy-row={p.id}
          data-governance-policy-state={p.state}
          data-governance-policy-kind={p.kind}
        >
          {p.name}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (p) => <code>{p.kind}</code> },
    { key: "slug", header: "Slug", render: (p) => <code>{p.slug}</code> },
    {
      key: "state",
      header: "State",
      render: (p) => <Badge tone="governance">{p.state}</Badge>,
    },
    { key: "enforcementMode", header: "Enforcement", render: (p) => p.enforcementMode },
    { key: "version", header: "Version", render: (p) => `v${p.version}` },
    { key: "createdAtUtc", header: "Created", render: (p) => formatUserDate(p.createdAtUtc) },
  ];

  return (
    <PageShell
      data-governance-policies-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance Policies"
          subtitle={`Policy registry. Kinds: ${GOVERNANCE_POLICY_KINDS.join(", ")}. Inheritance + override + audit. Enforcement: BLOCK / WARN / AUDIT_ONLY.`}
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-governance-policies-refresh
              disabled={busy}
              loading={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      {denial ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-permission-denied={denial.denial}
        >
          <strong>Permission required:</strong> {denial.tier}
        </Card>
      ) : null}

      {/* PHASE 13 — POST /v1/governance/policies. Activate / deprecate /
          assign / audit all existed; the DRAFT row they act on could only be
          authored through a REST client. */}
      <GovernancePolicyForm
        onCreated={async () => {
          await refresh();
          await loadEffective();
        }}
      />

      <div data-governance-policies-table>
        <DataTable<GovernancePolicyProjection>
          ariaLabel="Governance policies"
          columns={columns}
          rows={rows as GovernancePolicyProjection[]}
          getRowId={(p) => p.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No governance policies defined"
              purpose="Retention, access and compliance policies for this organization appear here once they are created."
            />
          }
          rowActions={(p) =>
            p.state === "DRAFT" ? (
              <Button
                variant="secondary"
                size="sm"
                data-governance-policy-activate={p.id}
                onClick={() => void activate(p.id)}
              >
                Activate
              </Button>
            ) : p.state === "ACTIVE" ? (
              <Button
                variant="secondary"
                size="sm"
                data-governance-policy-deprecate={p.id}
                onClick={() => void deprecate(p.id)}
              >
                Deprecate
              </Button>
            ) : (
              <span>—</span>
            )
          }
        />
      </div>

      {/* PHASE 12B CLUSTER 10 — effective policy chain. What actually applies
          after ORGANIZATION → DEPARTMENT → WORKSPACE inheritance and
          overrides are resolved by the engine. This section reports the
          engine's resolution; it never re-derives precedence client-side. */}
      <PageSection
        title="Effective policy"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Kind"
              showLabel
              value={kindFilter}
              onChange={(v) => setKindFilter(v as GovernancePolicyKind | "ALL")}
              options={[
                { value: "ALL", label: "All kinds" },
                ...GOVERNANCE_POLICY_KINDS.map((k) => ({ value: k, label: k })),
              ]}
            />
            <FilterBar.Select
              label="Department"
              showLabel
              value={departmentFilter}
              onChange={setDepartmentFilter}
              options={[
                { value: "", label: "No department narrowing" },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
          </FilterBar>
        }
      >
        {effectiveFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-effective-policies-failure={effectiveFailure.kind}
          >
            {effectiveFailure.message}
          </Card>
        ) : (
          <>
            {effective ? (
              <p
                style={{ ...mutedStyle, marginTop: 0 }}
                data-effective-policy-scope-organization={
                  effective.scope.organizationId
                }
                data-effective-policy-scope-workspace={
                  effective.scope.workspaceId
                }
                data-effective-policy-scope-department={
                  effective.scope.departmentId ?? ""
                }
              >
                Resolved for organization{" "}
                <code>{effective.scope.organizationId.slice(0, 8)}…</code>,
                workspace <code>{effective.scope.workspaceId.slice(0, 8)}…</code>
                {effective.scope.departmentId ? (
                  <>
                    , department{" "}
                    <code>{effective.scope.departmentId.slice(0, 8)}…</code>
                  </>
                ) : null}
                . Organization and workspace are derived server-side from your
                active session.
              </p>
            ) : null}
            <div data-effective-policies-table>
              <DataTable<GovernancePolicyProjection>
                ariaLabel="Effective governance policies"
                columns={effectiveColumns}
                rows={(effective?.effective ?? []) as GovernancePolicyProjection[]}
                getRowId={(p) => p.id}
                loading={!effective}
                emptyState={
                  <EmptyState
                    title="No policy applies at this scope"
                    purpose="No ACTIVE governance policy is assigned anywhere on this inheritance chain, so nothing is enforced at this scope."
                  />
                }
              />
            </div>
          </>
        )}
      </PageSection>
    </PageShell>
  );
}

const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };

function applyDenial(
  err: unknown,
  setDenial: (v: PermissionDenialState) => void,
): void {
  if (err instanceof ApiError) {
    const detailsDenial =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const tier =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (err.statusCode === 403 && detailsDenial === "DELEGATED_ADMIN_REQUIRED") {
      setDenial({ denial: detailsDenial, tier });
      return;
    }
  }
  const generic = err as {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
  const detailsDenial =
    generic && generic.details && typeof generic.details["denial"] === "string"
      ? (generic.details["denial"] as string)
      : null;
  const tier =
    generic && generic.details && typeof generic.details["requiredTier"] === "string"
      ? (generic.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    generic &&
    generic.statusCode === 403 &&
    detailsDenial === "DELEGATED_ADMIN_REQUIRED"
  ) {
    setDenial({ denial: detailsDenial, tier });
  }
}
