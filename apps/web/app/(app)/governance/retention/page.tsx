"use client";

/**
 * Phase 27 — Retention Policies console.
 *
 * Operator surface for creating, updating, and transitioning versioned
 * retention policies (Phase 27 `EvidenceRetentionPolicy`). Replaces the
 * legacy default-retention-days field from Phase 14 with first-class
 * scoped policies (workspace / evidence-type / case / regulatory).
 *
 * Hard rules:
 *   - Free-form change notes are required on every mutation (audit
 *     trail), but the page NEVER displays privileged legal text from
 *     legal-hold rows. Notes shown here are operator-readable only.
 *   - SUPERSEDED / ARCHIVED policies cannot be re-edited (the API
 *     refuses with RETENTION_POLICY_TERMINAL).
 *   - Conflict warnings come from the dashboard route, not derived
 *     client-side.
 *
 * Tone: enterprise / SOC. No emoji, no playful copy. The header carries
 * a compliance-grade tagline; mutating buttons read PAUSE / SUPERSEDE /
 * ARCHIVE — explicit verbs.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useTeamId, useTenantGuard } from "../../../../lib/platform-context";
import { Card } from "../../../../components/ui/Card";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../../components/navigation/OperationalBreadcrumb";
import { RetentionInheritanceSummary } from "../../../../components/governance/RetentionInheritanceSummary";
import { RetentionConflictAlert } from "../../../../components/governance/RetentionConflictAlert";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";

type PolicyStatus = "ACTIVE" | "PAUSED" | "SUPERSEDED" | "ARCHIVED";
type PolicyScope = "WORKSPACE" | "EVIDENCE_TYPE" | "CASE" | "REGULATORY";

type Policy = {
  id: string;
  teamId: string;
  displayName: string;
  description: string | null;
  status: PolicyStatus;
  scope: PolicyScope;
  scopeQualifier: string | null;
  caseId: string | null;
  retentionDays: number | null;
  immutable: boolean;
  autoExtensionEnabled: boolean;
  autoExtensionDays: number | null;
  supersededByPolicyId: string | null;
  currentVersion: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAtUtc: string | null;
};

type Version = {
  version: number;
  retentionDays: number | null;
  immutable: boolean;
  diffJson: unknown;
  authoredByUserId: string;
  changeNote: string | null;
  authoredAtUtc: string;
};

const SCOPE_LABEL: Record<PolicyScope, string> = {
  WORKSPACE: "Workspace",
  EVIDENCE_TYPE: "Evidence type",
  CASE: "Case",
  REGULATORY: "Regulatory",
};

// -----------------------------------------------------------------------------
// PHASE 12B CLUSTER 10 — server projections wired below.
//
// Both are READ-ONLY. This page renders exactly what the governance engine
// decided; it NEVER recomputes which policy wins, whether a record is held,
// or when a record becomes destroyable. `reason` / `source` / `conflicts`
// are the engine's own bounded vocabulary.
// -----------------------------------------------------------------------------

/** `GET /v1/governance/retention-policies/effective` */
type EffectiveRetentionDecision = {
  policy: Policy | null;
  reason: string;
  source: "team_policy" | "org_policy_inherited" | "none";
  inheritedTemplate?: {
    organizationId: string;
    retentionDays: number | null;
    immutable: boolean;
    description: string | null;
  };
  conflicts: ReadonlyArray<{ code: string; detail: string }>;
};

/** `GET /v1/governance/retention-candidates` */
type RetentionCandidate = {
  id: string;
  retentionUntilUtc: string;
  retentionPolicySource: string | null;
  flaggedAtUtc: string | null;
  caseId: string | null;
  publicVerifyState: string;
};

const RETENTION_SOURCE_LABEL: Record<
  EffectiveRetentionDecision["source"],
  string
> = {
  team_policy: "Workspace policy",
  org_policy_inherited: "Inherited organization template",
  none: "No policy — indefinite retention",
};

/** Deterministic page sizes. The API caps at 200. */
const CANDIDATE_PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * Bounded resolution of an unknown fetch failure into the three states this
 * page renders differently: denial (authorization), error (everything else).
 * Never surfaces a raw backend message — `toSafeUserError` is the only
 * sanctioned display path.
 */
function classifyReadFailure(err: unknown): {
  kind: "denied" | "error";
  message: string;
} {
  const e = err as { statusCode?: number; message?: string };
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return {
      kind: "denied",
      message:
        "You do not have the governance permission required to read this in the current workspace.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, {
      message: "Unable to load this governance projection.",
    }).message,
  };
}

// Phase 38.9 — wrap in canonical PageRouteGate. `governance.retention`
// is organization-only.
export default function RetentionPoliciesPage() {
  return (
    <PageRouteGate routeId="governance.retention">
      <RetentionPoliciesPageInner />
    </PageRouteGate>
  );
}

function RetentionPoliciesPageInner() {
  const teamId = useTeamId();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | "ALL">("ALL");
  const [selectedVersionsFor, setSelectedVersionsFor] = useState<string | null>(
    null,
  );
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // PHASE 12B CLUSTER 10 — tenant generation guard. Every async read below
  // captures the generation before awaiting and drops the response if the
  // operator switched workspace mid-flight, so one workspace's retention
  // projection can never paint into another's console.
  const { stamp, isStale } = useTenantGuard();

  // --- Effective retention resolution (server decision) --------------------
  const [effective, setEffective] = useState<EffectiveRetentionDecision | null>(
    null,
  );
  const [effectiveLoading, setEffectiveLoading] = useState(false);
  const [effectiveFailure, setEffectiveFailure] = useState<{
    kind: "denied" | "error";
    message: string;
  } | null>(null);
  const [evidenceTypeFilter, setEvidenceTypeFilter] = useState("");
  const [jurisdictionFilter, setJurisdictionFilter] = useState("");

  // --- Retention reconciliation candidates ---------------------------------
  const [candidates, setCandidates] = useState<RetentionCandidate[] | null>(
    null,
  );
  const [candidatesFailure, setCandidatesFailure] = useState<{
    kind: "denied" | "error";
    message: string;
  } | null>(null);
  const [candidateLimit, setCandidateLimit] = useState<number>(
    CANDIDATE_PAGE_SIZES[1],
  );

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const status = statusFilter === "ALL" ? "" : `&status=${statusFilter}`;
    apiFetch(
      `/v1/governance/retention-policies?teamId=${encodeURIComponent(teamId)}${status}`,
      { method: "GET" },
    )
      .then((res: { policies: Policy[] }) => {
        if (cancelled) return;
        setPolicies(res.policies);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Unable to load policies." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, statusFilter]);

  const loadEffective = useCallback(async () => {
    if (!teamId) return;
    const captured = stamp();
    setEffectiveLoading(true);
    setEffectiveFailure(null);
    const params = new URLSearchParams({ teamId });
    if (evidenceTypeFilter) params.set("evidenceType", evidenceTypeFilter);
    if (jurisdictionFilter.trim()) {
      params.set("jurisdiction", jurisdictionFilter.trim());
    }
    try {
      const res: EffectiveRetentionDecision = await apiFetch(
        `/v1/governance/retention-policies/effective?${params.toString()}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setEffective(res);
    } catch (err) {
      if (isStale(captured)) return;
      setEffective(null);
      setEffectiveFailure(classifyReadFailure(err));
    } finally {
      if (!isStale(captured)) setEffectiveLoading(false);
    }
  }, [teamId, evidenceTypeFilter, jurisdictionFilter, stamp, isStale]);

  useEffect(() => {
    void loadEffective();
  }, [loadEffective]);

  const loadCandidates = useCallback(async () => {
    if (!teamId) return;
    const captured = stamp();
    setCandidates(null);
    setCandidatesFailure(null);
    try {
      const res: { candidates: RetentionCandidate[] } = await apiFetch(
        `/v1/governance/retention-candidates?teamId=${encodeURIComponent(teamId)}&limit=${candidateLimit}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setCandidates(res.candidates);
    } catch (err) {
      if (isStale(captured)) return;
      setCandidates([]);
      setCandidatesFailure(classifyReadFailure(err));
    }
  }, [teamId, candidateLimit, stamp, isStale]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  async function refresh() {
    if (!teamId) return;
    const status = statusFilter === "ALL" ? "" : `&status=${statusFilter}`;
    const res: { policies: Policy[] } = await apiFetch(
      `/v1/governance/retention-policies?teamId=${encodeURIComponent(teamId)}${status}`,
      { method: "GET" },
    );
    setPolicies(res.policies);
  }

  async function loadVersions(policyId: string) {
    if (!teamId) return;
    setSelectedVersionsFor(policyId);
    setVersions(null);
    try {
      const res: { versions: Version[] } = await apiFetch(
        `/v1/governance/retention-policies/${policyId}/versions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setVersions(res.versions);
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not load policy versions." }).message);
      setSelectedVersionsFor(null);
    }
  }

  async function transition(
    policy: Policy,
    nextStatus: PolicyStatus,
  ): Promise<void> {
    if (!teamId) return;
    const note = window.prompt(
      `Change note for ${nextStatus} — required for audit trail.`,
    );
    if (!note || !note.trim()) return;
    try {
      await apiFetch(
        `/v1/governance/retention-policies/${policy.id}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            nextStatus,
            changeNote: note.trim(),
          }),
        },
      );
      await refresh();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: `Could not transition policy to ${nextStatus}.` }).message);
    }
  }

  const visiblePolicies = useMemo(() => policies ?? [], [policies]);

  const columns: DataTableColumn<Policy>[] = [
    {
      key: "policy",
      header: "Policy",
      render: (p) => (
        <div>
          <div style={{ fontWeight: 600 }}>{p.displayName}</div>
          {p.description ? (
            <div style={mutedStyle}>{p.description}</div>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {p.immutable ? (
              <Badge tone="governance" subtle>
                Immutable
              </Badge>
            ) : null}
            {p.autoExtensionEnabled ? (
              <Badge tone="info" subtle>
                Auto-extend
              </Badge>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: "scope",
      header: "Scope",
      render: (p) => (
        <div>
          {SCOPE_LABEL[p.scope]}
          {p.scopeQualifier ? (
            <div style={mutedStyle}>{p.scopeQualifier}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "retention",
      header: "Retention",
      nowrap: true,
      render: (p) =>
        p.retentionDays === null
          ? "Indefinite"
          : `${p.retentionDays.toLocaleString()} days`,
    },
    {
      key: "status",
      header: "Status",
      render: (p) => <StatusBadge status={p.status} />,
    },
    {
      key: "version",
      header: "Version",
      nowrap: true,
      render: (p) => `v${p.currentVersion}`,
    },
  ];

  // PHASE 12B CLUSTER 10 — candidate columns. Drill-down goes to the
  // canonical evidence record; the queue itself never mutates anything.
  const candidateColumns: DataTableColumn<RetentionCandidate>[] = [
    {
      key: "evidence",
      header: "Evidence",
      render: (c) => (
        <Link
          href={`/evidence/${c.id}`}
          style={{ ...monoLinkStyle }}
          data-retention-candidate-row={c.id}
        >
          {c.id.slice(0, 8)}…
        </Link>
      ),
    },
    {
      key: "retentionUntil",
      header: "Retention until",
      nowrap: true,
      render: (c) => formatUserDateTime(c.retentionUntilUtc),
    },
    {
      key: "flagged",
      header: "Flagged",
      nowrap: true,
      render: (c) =>
        c.flaggedAtUtc ? (
          formatUserDateTime(c.flaggedAtUtc)
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
    {
      key: "source",
      header: "Policy source",
      render: (c) =>
        c.retentionPolicySource ? (
          <code style={{ fontSize: 12 }}>{c.retentionPolicySource}</code>
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
    {
      key: "verifyState",
      header: "Verify state",
      render: (c) => <StatusBadge status={c.publicVerifyState} />,
    },
    {
      key: "case",
      header: "Matter",
      render: (c) =>
        c.caseId ? (
          <Link href={`/cases/${c.caseId}`} style={monoLinkStyle}>
            {c.caseId.slice(0, 8)}…
          </Link>
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Governance"
          title="Retention policies"
          subtitle="Versioned retention rules. Most-specific scope wins (CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE). Mutations are append-only — every change writes a new immutable version row."
          contextStrip={
            <OperationalBreadcrumb
              routeId="governance.retention"
              items={[
                { label: "Governance", href: "/governance" },
                { label: "Retention policies" },
              ]}
            />
          }
          primaryAction={
            <Button
              variant="enterprise"
              onClick={() => setShowCreate(true)}
              disabled={!teamId}
            >
              New policy
            </Button>
          }
        />
      }
    >
      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/destruction" style={navLinkStyle}>
          Destruction queue →
        </Link>
      </nav>

      {/* Phase F — surface the Phase B0 inheritance resolver so
          operators see at a glance whether this workspace is
          governed by a local policy, an inherited org template, or
          no policy at all. */}
      <div>
        <RetentionInheritanceSummary teamId={teamId ?? null} />
      </div>

      {/* Phase G1 (F.4) — surface retention policy conflicts so
          governance admins see them at the top of the page instead
          of buried in the dashboard signal. */}
      <RetentionConflictAlert teamId={teamId ?? null} />

      {/* PHASE 12B CLUSTER 10 — effective retention resolution. The engine
          decides; this section only reports the decision, its source, and
          the bounded conflict codes it emitted. */}
      <PageSection
        title="Effective retention"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Evidence type"
              showLabel
              value={evidenceTypeFilter}
              onChange={setEvidenceTypeFilter}
              options={[
                { value: "", label: "Any" },
                { value: "PHOTO", label: "Photo" },
                { value: "VIDEO", label: "Video" },
                { value: "AUDIO", label: "Audio" },
                { value: "DOCUMENT", label: "Document" },
              ]}
            />
            <FilterBar.Select
              label="Jurisdiction"
              showLabel
              value={jurisdictionFilter}
              onChange={setJurisdictionFilter}
              options={[
                { value: "", label: "Any" },
                { value: "EU", label: "EU" },
                { value: "UK", label: "UK" },
                { value: "US", label: "US" },
              ]}
            />
          </FilterBar>
        }
      >
        {!teamId ? (
          <EmptyState
            framed
            title="No workspace selected"
            purpose="Switch to an organization workspace to resolve its effective retention rule."
          />
        ) : effectiveFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-effective-retention-failure={effectiveFailure.kind}
          >
            {effectiveFailure.message}
          </Card>
        ) : effectiveLoading && !effective ? (
          <p style={mutedStyle} data-effective-retention-loading>
            Resolving effective retention…
          </p>
        ) : !effective ? (
          <EmptyState
            title="No retention decision available"
            purpose="The governance engine returned no decision for this scope."
          />
        ) : (
          <Card
            variant="admin"
            padding="compact"
            data-effective-retention-source={effective.source}
          >
            <div style={effectiveGridStyle}>
              <div>
                <div style={fieldLabelTextStyle}>Source</div>
                <div style={{ fontWeight: 600 }}>
                  {RETENTION_SOURCE_LABEL[effective.source]}
                </div>
              </div>
              <div>
                <div style={fieldLabelTextStyle}>Retention</div>
                <div style={{ fontWeight: 600 }}>
                  {effective.policy
                    ? effective.policy.retentionDays === null
                      ? "Indefinite"
                      : `${effective.policy.retentionDays.toLocaleString()} days`
                    : effective.inheritedTemplate
                      ? effective.inheritedTemplate.retentionDays === null
                        ? "Indefinite"
                        : `${effective.inheritedTemplate.retentionDays.toLocaleString()} days`
                      : "Indefinite"}
                </div>
              </div>
              <div>
                <div style={fieldLabelTextStyle}>Governing policy</div>
                <div>
                  {effective.policy ? (
                    <>
                      <span style={{ fontWeight: 600 }}>
                        {effective.policy.displayName}
                      </span>{" "}
                      <span style={mutedStyle}>
                        ({SCOPE_LABEL[effective.policy.scope]} · v
                        {effective.policy.currentVersion})
                      </span>
                    </>
                  ) : (
                    <span style={mutedStyle}>None</span>
                  )}
                </div>
              </div>
              <div>
                <div style={fieldLabelTextStyle}>Immutable</div>
                <div>
                  {effective.policy?.immutable ||
                  effective.inheritedTemplate?.immutable ? (
                    <Badge tone="governance" subtle>
                      Immutable
                    </Badge>
                  ) : (
                    <span style={mutedStyle}>No</span>
                  )}
                </div>
              </div>
            </div>
            <p style={{ ...mutedStyle, marginTop: 10, marginBottom: 0 }}>
              Engine reason: <code>{effective.reason}</code>
            </p>
            {effective.conflicts.length > 0 ? (
              <ul style={{ ...listStyle, marginTop: 10 }}>
                {effective.conflicts.map((c) => (
                  <li
                    key={`${c.code}:${c.detail}`}
                    style={{ fontSize: 13, marginTop: 4 }}
                    data-effective-retention-conflict={c.code}
                  >
                    <Badge tone="risk" subtle>
                      {c.code}
                    </Badge>{" "}
                    {c.detail}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        )}
      </PageSection>

      {/* PHASE 12B CLUSTER 10 — retention reconciliation candidates. The
          reconciliation worker flags these; the console is read-only and
          offers drill-down only. Approving destruction happens in the
          destruction queue, behind its own review + step-up gate. */}
      <PageSection
        title="Reconciliation candidates"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Page size"
              showLabel
              value={String(candidateLimit)}
              onChange={(v) => setCandidateLimit(Number(v))}
              options={CANDIDATE_PAGE_SIZES.map((n) => ({
                value: String(n),
                label: `${n} rows`,
              }))}
            />
          </FilterBar>
        }
      >
        <p style={{ ...mutedStyle, marginTop: 0 }}>
          Sealed records the retention worker flagged as past their effective
          horizon, newest flag first. Records under legal hold are excluded by
          the engine and never appear here. This view proposes nothing — it
          reports what the worker found.
        </p>
        {!teamId ? (
          <EmptyState
            framed
            title="No workspace selected"
            purpose="Switch to an organization workspace to view its reconciliation candidates."
          />
        ) : candidatesFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-retention-candidates-failure={candidatesFailure.kind}
          >
            {candidatesFailure.message}
          </Card>
        ) : (
          <div data-retention-candidates-table>
            <DataTable
              ariaLabel="Retention reconciliation candidates"
              columns={candidateColumns}
              rows={candidates ?? []}
              getRowId={(c) => c.id}
              loading={!candidates}
              emptyState={
                <EmptyState
                  title="No records flagged"
                  purpose="The retention worker has not flagged any sealed record as past its effective retention horizon."
                />
              }
            />
          </div>
        )}
      </PageSection>

      <PageSection
        title="Policies"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Status"
              showLabel
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as PolicyStatus | "ALL")}
              options={[
                { value: "ALL", label: "All" },
                { value: "ACTIVE", label: "Active" },
                { value: "PAUSED", label: "Paused" },
                { value: "SUPERSEDED", label: "Superseded" },
                { value: "ARCHIVED", label: "Archived" },
              ]}
            />
          </FilterBar>
        }
      >
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        {!teamId ? (
          <EmptyState
            framed
            title="No workspace selected"
            purpose="Switch to an organization workspace to view and manage its retention policies."
          />
        ) : (
          <DataTable
            ariaLabel="Retention policies"
            columns={columns}
            rows={visiblePolicies}
            getRowId={(p) => p.id}
            loading={!policies}
            rowActions={(p) => (
              <div style={actionRowStyle}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => loadVersions(p.id)}
                >
                  Versions
                </Button>
                {p.status === "ACTIVE" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => transition(p, "PAUSED")}
                  >
                    Pause
                  </Button>
                ) : null}
                {p.status === "PAUSED" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => transition(p, "ACTIVE")}
                  >
                    Resume
                  </Button>
                ) : null}
                {p.status === "ACTIVE" || p.status === "PAUSED" ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => transition(p, "SUPERSEDED")}
                    >
                      Supersede
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => transition(p, "ARCHIVED")}
                    >
                      Archive
                    </Button>
                  </>
                ) : null}
                {p.status === "SUPERSEDED" ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => transition(p, "ARCHIVED")}
                  >
                    Archive
                  </Button>
                ) : null}
              </div>
            )}
            emptyState={
              <EmptyState
                title="No retention policy configured"
                purpose="No policies match the current filter. Create a scoped retention policy to govern how long sealed evidence is preserved."
                action={
                  <Button
                    variant="enterprise"
                    onClick={() => setShowCreate(true)}
                    disabled={!teamId}
                  >
                    New policy
                  </Button>
                }
              />
            }
          />
        )}
      </PageSection>

      {selectedVersionsFor ? (
        <VersionsModal
          versions={versions}
          onClose={() => {
            setSelectedVersionsFor(null);
            setVersions(null);
          }}
        />
      ) : null}

      {showCreate && teamId ? (
        <CreatePolicyModal
          teamId={teamId}
          onCancel={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refresh();
          }}
        />
      ) : null}
    </PageShell>
  );
}

function VersionsModal({
  versions,
  onClose,
}: {
  versions: Version[] | null;
  onClose: () => void;
}) {
  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 720 }}>
        <h3 style={sectionTitleStyle}>Policy versions</h3>
        <p style={{ ...mutedStyle, marginBottom: 12 }}>
          Append-only history. Each row is the snapshot of the policy at that
          version, with the structured diff against the previous version.
        </p>
        {!versions ? (
          <p style={mutedStyle}>Loading versions…</p>
        ) : versions.length === 0 ? (
          <p style={mutedStyle}>No versions to show.</p>
        ) : (
          <ul style={listStyle}>
            {versions.map((v) => (
              <li key={v.version} style={versionRowStyle}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <strong>v{v.version}</strong>
                  <span style={mutedStyle}>
                    {formatUserDateTime(v.authoredAtUtc)}
                  </span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Retention:{" "}
                  <strong>
                    {v.retentionDays === null
                      ? "Indefinite"
                      : `${v.retentionDays} days`}
                  </strong>
                  {v.immutable ? (
                    <span style={{ marginLeft: 8 }}>· Immutable</span>
                  ) : null}
                </div>
                {v.changeNote ? (
                  <div style={mutedStyle}>{v.changeNote}</div>
                ) : null}
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: "#475569" }}>
                    Structured diff
                  </summary>
                  <pre style={preStyle}>
                    {JSON.stringify(v.diffJson, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CreatePolicyModal({
  teamId,
  onCancel,
  onCreated,
}: {
  teamId: string;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<PolicyScope>("WORKSPACE");
  const [scopeQualifier, setScopeQualifier] = useState("");
  const [caseId, setCaseId] = useState("");
  const [retentionDays, setRetentionDays] = useState<string>("");
  const [immutable, setImmutable] = useState(false);
  const [autoExtensionEnabled, setAutoExtensionEnabled] = useState(false);
  const [autoExtensionDays, setAutoExtensionDays] = useState<string>("");
  const [changeNote, setChangeNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        teamId,
        displayName: displayName.trim(),
        description: description.trim() ? description.trim() : null,
        scope,
        scopeQualifier:
          scope === "EVIDENCE_TYPE" || scope === "REGULATORY"
            ? scopeQualifier.trim() || null
            : null,
        caseId: scope === "CASE" ? caseId.trim() || null : null,
        retentionDays: retentionDays.trim() ? Number(retentionDays) : null,
        immutable,
        autoExtensionEnabled,
        autoExtensionDays:
          autoExtensionEnabled && autoExtensionDays.trim()
            ? Number(autoExtensionDays)
            : null,
        changeNote: changeNote.trim() || undefined,
      };
      await apiFetch("/v1/governance/retention-policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await onCreated();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not create policy." }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 560 }}>
        <h3 style={sectionTitleStyle}>New retention policy</h3>

        <Field label="Display name">
          <input
            style={inputStyle}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, 180))}
            placeholder="e.g. EU GDPR Standard 30d"
            autoFocus
          />
        </Field>

        <Field label="Description (operator-readable only)">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            placeholder="Optional description. Never store privileged legal text."
          />
        </Field>

        <Field label="Scope">
          <select
            style={inputStyle}
            value={scope}
            onChange={(e) => setScope(e.target.value as PolicyScope)}
          >
            <option value="WORKSPACE">Workspace</option>
            <option value="EVIDENCE_TYPE">Evidence type</option>
            <option value="CASE">Case</option>
            <option value="REGULATORY">Regulatory</option>
          </select>
        </Field>

        {scope === "EVIDENCE_TYPE" ? (
          <Field label="Evidence type qualifier">
            <input
              style={inputStyle}
              value={scopeQualifier}
              onChange={(e) =>
                setScopeQualifier(e.target.value.slice(0, 40))
              }
              placeholder="PHOTO | VIDEO | AUDIO | DOCUMENT"
            />
          </Field>
        ) : null}

        {scope === "REGULATORY" ? (
          <Field label="Jurisdiction code">
            <input
              style={inputStyle}
              value={scopeQualifier}
              onChange={(e) =>
                setScopeQualifier(e.target.value.slice(0, 40))
              }
              placeholder="e.g. EU, US-NY, UK"
            />
          </Field>
        ) : null}

        {scope === "CASE" ? (
          <Field label="Case ID">
            <input
              style={inputStyle}
              value={caseId}
              onChange={(e) => setCaseId(e.target.value.trim())}
              placeholder="uuid"
            />
          </Field>
        ) : null}

        <Field label="Retention (days). Empty = indefinite.">
          <input
            type="number"
            min={0}
            max={36500}
            style={inputStyle}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </Field>

        <Toggle
          label="Immutable — block destruction even after expiry"
          value={immutable}
          onChange={setImmutable}
        />
        <Toggle
          label="Auto-extend on custody activity"
          value={autoExtensionEnabled}
          onChange={setAutoExtensionEnabled}
        />
        {autoExtensionEnabled ? (
          <Field label="Auto-extension window (days)">
            <input
              type="number"
              min={1}
              max={36500}
              style={inputStyle}
              value={autoExtensionDays}
              onChange={(e) => setAutoExtensionDays(e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Change note (required for audit)">
          <input
            style={inputStyle}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value.slice(0, 2000))}
            placeholder="Initial policy"
          />
        </Field>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || !displayName.trim()}
            onClick={submit}
          >
            {busy ? "Creating…" : "Create policy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={fieldLabelStyle}>
      <div style={fieldLabelTextStyle}>{label}</div>
      {children}
    </label>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={toggleStyle}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
};
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 16,
  marginBottom: 8,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const monoLinkStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: "#4338ca",
  textDecoration: "none",
};
const effectiveGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 16,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
  width: "100%",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 12,
};
const fieldLabelTextStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#334155",
  marginBottom: 4,
};
const toggleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 12,
  fontSize: 14,
  color: "#334155",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
  overflow: "auto",
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  width: "100%",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
  maxHeight: "90vh",
  overflow: "auto",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "12px 0 0",
};
const versionRowStyle: React.CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid #f1f5f9",
};
const preStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  background: "#f8fafc",
  padding: 10,
  borderRadius: 6,
  border: "1px solid #e2e8f0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginTop: 4,
};
// Phase Final-Closure — local statusBadgeStyle removed; canonical
// version lives in components/ui/StatusBadge.tsx.
