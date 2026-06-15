"use client";

/**
 * Phase 32.8D-frontend — Cases list surface.
 *
 * The /cases route is no longer a CRUD card list. It is the
 * team-scoped cases queue, sourced from
 * `GET /v1/cases/matter-queue`. Each row surfaces:
 *
 *   - case identity (name, reference number)
 *   - status / priority chips
 *   - operational counters (linked evidence, evidence gaps, open
 *     incidents, active + overdue workflows, governance blockers,
 *     legal hold count)
 *   - risk score / risk level / risk reason codes / recommended
 *     action
 *   - latest activity time
 *
 * Hard rules:
 *
 *   1. Authority is read from the canonical platform context only.
 *      NO useActiveWorkspaceId, NO /v1/users/me authority fetch,
 *      NO /v1/teams authority fetch, NO local role/scope derivation.
 *   2. Personal workspace renders the canonical
 *      CapabilityDegradedPanel — the matter queue is team-scoped.
 *   3. Browsing is side-effect free. No signed URLs, no audit
 *      events, no report/package generation on render.
 *   4. NO fabricated metrics — every count comes verbatim from the
 *      envelope.
 *   5. Filters are wired client-side as query parameters; the
 *      server is the only authority on which rows are visible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "../../lib/api";
// Phase CASES-PERSONAL-UX — capability gate. The investigation surface
// (ENTERPRISE-tier) is the existing signal for evidence-graph /
// reviewer-ops / legal-ops workflows. We reuse it as the on/off switch
// for the advanced Cases filters and card details so Personal /
// small-team users see a simple list and enterprise users keep every
// existing counter. Backend selectors are untouched — filter state is
// preserved and still POSTs to the server, we just don't render the
// advanced controls on personal workspaces.
import { canAccessSurface } from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";
import {
  CapabilityDegradedPanel,
  useActiveWorkspaceId,
  usePersonaProfile,
  usePersonalSpace,
  usePlatformContext,
  workflowFromPersona,
} from "../../lib/platform-context";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
// Phase 2.1 — surfaces `POST /v1/cases` from the canonical Cases page.
import { CreateCaseModal } from "./matter-modals";
import type {
  MatterQueueEnvelope,
  MatterQueueItem,
  MatterRiskLevel,
} from "./types";

// ---------------------------------------------------------------------------
// Bounded filter vocabularies (mirror MatterQueueQuery on the backend)
// ---------------------------------------------------------------------------

const CASE_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
  "ARCHIVED",
] as const;
type CaseStatus = (typeof CASE_STATUSES)[number];

const RISK_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

type QueueFilters = {
  search: string;
  status: CaseStatus | "";
  riskLevel: MatterRiskLevel | "";
  assignedToMe: boolean;
  hasOpenIncidents: boolean;
  hasGovernanceBlockers: boolean;
  hasOverdueWorkflows: boolean;
  hasLegalHold: boolean;
  missingArtifact: boolean;
};

const DEFAULT_FILTERS: QueueFilters = {
  search: "",
  status: "",
  riskLevel: "",
  assignedToMe: false,
  hasOpenIncidents: false,
  hasGovernanceBlockers: false,
  hasOverdueWorkflows: false,
  hasLegalHold: false,
  missingArtifact: false,
};

// ---------------------------------------------------------------------------
// Load state
// ---------------------------------------------------------------------------

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: MatterQueueEnvelope; isReloading?: boolean }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CasesIndex() {
  const ctx = usePlatformContext();
  // STAGE 3 — personal-aware workspace id. Resolves to the active
  // team workspace OR the personal-space id, so personal users with
  // CASES_VIEW + CASES_MANAGE can actually load the queue instead of
  // being locked out behind a CapabilityDegradedPanel. The server is
  // still the authority on visibility / capabilities.
  const workspaceId = useActiveWorkspaceId();
  const personalSpace = usePersonalSpace();
  // Phase CASES-PERSONAL-UX — persona terminology is no longer
  // applied to the Cases page header. The audience is personal /
  // small-business users for whom "Cases" is the plain-language
  // term; persona-tuned aliases (Matters / Claims / Investigations)
  // were jargon for this surface. Persona terminology is still used
  // elsewhere (Home, Evidence pages); only this header opted out.
  const viewerUserId = ctx.envelope?.user.id ?? null;
  // Phase 38.17 — workflow-aware contextual help.
  const personaProfile = usePersonaProfile();
  const workflowCode = workflowFromPersona(personaProfile.primaryProfile).code;

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  // Phase CASES-PERSONAL-UX — debounced view of `filters.search`. The
  // raw input value updates instantly (so the input stays focused and
  // responsive); only this debounced copy feeds the network request,
  // which both eliminates per-keystroke server thrash and removes the
  // re-render storm that used to remount the input every time.
  const [appliedSearch, setAppliedSearch] = useState("");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Phase CASES-PERSONAL-UX — capability gate. ENTERPRISE-tier
  // workspaces see the full risk/governance/legal-hold/overdue/
  // assignment UI; Personal and small-team workspaces see the
  // simplified Cases list (Status + Open issues + Missing
  // report/package). Backend filter state still posts everything;
  // hiding the controls just stops surfacing them.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeAdvancedCaseOps = canAccessSurface(
    surfaceUserCtx,
    "/investigation",
  );
  // Phase 2.1 — Create Case modal local state. Toggled by the new
  // "Create case" button in the header and by the empty-state CTA.
  const [createOpen, setCreateOpen] = useState(false);
  const router = useRouter();

  // Phase CASES-PERSONAL-UX — debounce the search input (300ms). The
  // raw `filters.search` updates immediately on each keystroke (the
  // controlled input renders the user's typed text); `appliedSearch`
  // lags behind and is the only thing that triggers a refetch. This
  // is the actual fix for "input loses focus after the first
  // character" — the previous code remounted the whole tree on every
  // keystroke because reload() flipped state to "loading".
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(filters.search.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  // Build the canonical query string from the applied (debounced)
  // filter state. The matter-queue endpoint takes the bounded params
  // verbatim.
  const queryString = useMemo(() => {
    if (!workspaceId) return "";
    const qs = new URLSearchParams();
    qs.set("teamId", workspaceId);
    if (appliedSearch) qs.set("search", appliedSearch);
    if (filters.status) qs.set("status", filters.status);
    if (filters.riskLevel) qs.set("riskLevel", filters.riskLevel);
    if (filters.assignedToMe && viewerUserId)
      qs.set("assignedToUserId", viewerUserId);
    if (filters.hasOpenIncidents) qs.set("hasOpenIncidents", "true");
    if (filters.hasGovernanceBlockers) qs.set("hasGovernanceBlockers", "true");
    if (filters.hasOverdueWorkflows) qs.set("hasOverdueWorkflows", "true");
    if (filters.hasLegalHold) qs.set("hasLegalHold", "true");
    if (filters.missingArtifact) qs.set("missingArtifact", "true");
    return qs.toString();
  }, [workspaceId, appliedSearch, filters, viewerUserId]);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    // Phase CASES-PERSONAL-UX — persist the previous successful
    // envelope across reloads so the page chrome (header + filters
    // + input) stays mounted with stable React identity. Previously
    // every reload flipped state to {status:"loading"} which made
    // the parent return <QueueLoading/> and remount the input.
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", envelope: prev.envelope, isReloading: true }
        : { status: "loading" },
    );
    try {
      const envelope = (await apiFetch(`/v1/cases/matter-queue?${queryString}`, {
        method: "GET",
      })) as MatterQueueEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 401) {
        setState({ status: "auth_error", code: "auth_required" });
      } else if (e.statusCode === 403) {
        setState({ status: "auth_error", code: "permission_denied" });
      } else {
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load matter queue.",
        });
      }
    }
  }, [workspaceId, queryString]);

  useEffect(() => {
    if (!workspaceId) return;
    void reload();
  }, [reload, workspaceId]);

  // STAGE 3 — genuine no-workspace case only. Personal users with an
  // active personalSpace fall through to the queue UI (the server is
  // the authority on capability + visibility). The structured
  // CapabilityDegradedPanel is reserved for the case where BOTH the
  // team workspace and the personal space are unavailable.
  if (!workspaceId) {
    const hasHealthyPersonalSpace = personalSpace?.status === "active";
    if (!hasHealthyPersonalSpace) {
      return (
        <main className="cc-page" data-cases-no-workspace>
          <CapabilityDegradedPanel
            surface="Cases"
            requiredCapability="CASES_VIEW"
            reason="No active workspace is available for this account. Create or switch into a workspace to view your cases."
            alternatives={[
              { label: "View your evidence", href: "/evidence" },
              { label: "Generate a report", href: "/reports" },
              { label: "Switch or create a workspace", href: "/teams" },
            ]}
          />
        </main>
      );
    }
    // Healthy personal space but no resolved id yet — surface the
    // standard loading skeleton rather than locking the user out.
    return <QueueLoading />;
  }

  // Phase CASES-PERSONAL-UX — terminal error states (auth / outage)
  // still take over the whole page. The loading-on-first-load case
  // ALSO takes over the page (no envelope yet to render around). On
  // subsequent reloads (envelope already present in state), we keep
  // the page chrome mounted so the search input never loses focus.
  if (state.status === "auth_error") return <QueueAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <QueueUnavailable message={state.message} onRetry={reload} />;
  if (state.status === "loading") return <QueueLoading />;

  const { envelope, isReloading } = state;
  // Phase 32.8D + R9 personal-first rescue: when the active workspace
  // is the personal space (no team workspace), the queue still renders
  // the full matter view (personal users have CASES_VIEW). We mark the
  // container with `data-cases-personal-mode` so observability + e2e
  // can distinguish the personal-view rendering path from the team
  // workspace path without changing the operator-facing UI.
  const isPersonalMode =
    !!personalSpace?.id && personalSpace.id === workspaceId;
  // Active-filter detection so the empty state can pick the right
  // message ("No cases yet" vs "No cases match these filters").
  const anyFilterActive =
    appliedSearch.length > 0 ||
    filters.status !== "" ||
    filters.riskLevel !== "" ||
    filters.assignedToMe ||
    filters.hasOpenIncidents ||
    filters.hasGovernanceBlockers ||
    filters.hasOverdueWorkflows ||
    filters.hasLegalHold ||
    filters.missingArtifact;
  return (
    <main
      className="cc-page"
      data-cases-index
      data-matter-queue
      data-cases-personal-mode={isPersonalMode ? "true" : "false"}
      data-cases-advanced-mode={canSeeAdvancedCaseOps ? "true" : "false"}
    >
      <header className="cc-page-header">
        <div>
          {/* Phase CASES-PERSONAL-UX — single canonical title. The
              prior layout repeated "Your cases" as both kicker and h1,
              and the subtitle leaned on enterprise jargon (legal
              holds, etc). Personal / small-business audience gets a
              plain-language title + a one-line description of the
              concept. */}
          <h1 className="cc-title" data-cases-title>
            Cases
          </h1>
          <p className="cc-subtitle" data-cases-subtitle>
            Group related evidence into simple workspaces for incidents,
            claims, projects, or reviews.
          </p>
        </div>
        <div className="cc-meta">
          <span data-matter-queue-total>
            {envelope.total} {envelope.total === 1 ? "case" : "cases"}
          </span>
          <span title={envelope.generatedAt} data-matter-queue-generated-at>
            Refreshed {formatRelativeTime(envelope.generatedAt)}
          </span>
          {isReloading ? (
            <span
              className="cc-muted"
              data-matter-queue-reloading
              style={{ marginLeft: 8, fontSize: 12 }}
            >
              Updating…
            </span>
          ) : null}
          {/* Phase 2.1 — canonical Create Case CTA. Server enforces
              permissions; the button is visible to any team member so
              they get a structured AccessGate inside the modal on 403
              instead of a missing button + raw 403 elsewhere. */}
          <button
            type="button"
            className="btn-primary"
            data-create-case-trigger
            onClick={() => setCreateOpen(true)}
            style={{ marginLeft: 12 }}
          >
            + Create case
          </button>
        </div>
      </header>

      {/* Phase 38.17 — workflow-aware contextual help, collapsed by
          default so the matter queue stays primary. */}
      <ContextualHelp
        workflow={workflowCode}
        surface="cases"
        collapsedByDefault
        stateNotes={
          envelope.total === 0
            ? [
                "No cases yet — use the Create case button above, or link evidence into an existing case.",
              ]
            : undefined
        }
      />

      <MatterQueueFilters
        filters={filters}
        viewerUserId={viewerUserId}
        onChange={setFilters}
        canSeeAdvancedCaseOps={canSeeAdvancedCaseOps}
      />

      <MatterQueueTable
        items={envelope.items}
        totalBeforeFilter={envelope.total}
        anyFilterActive={anyFilterActive}
        canSeeAdvancedCaseOps={canSeeAdvancedCaseOps}
        onClearFilters={() => setFilters(DEFAULT_FILTERS)}
        onCreateCase={() => setCreateOpen(true)}
      />

      {/* Phase 2.1 — Create Case modal. Mounted at the page level so
          the focus trap restores focus to the trigger button after
          close. Navigation to the new case workspace happens on
          successful create. */}
      <CreateCaseModal
        open={createOpen}
        teamId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={(newCase) => {
          setCreateOpen(false);
          // The matter-queue envelope is read-only and team-scoped;
          // navigating to the new case workspace gives the operator
          // the next-action surface (assign reviewer, link evidence,
          // change status) without an intermediate refresh.
          router.push(`/cases/${newCase.id}`);
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Phase CASES-PERSONAL-UX — human-readable status labels for the
 * Status select. The underlying enum values stay UPPER_SNAKE_CASE for
 * the API contract.
 */
const STATUS_LABEL: Record<(typeof CASE_STATUSES)[number], string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  ON_HOLD: "On hold",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

function MatterQueueFilters({
  filters,
  viewerUserId,
  onChange,
  canSeeAdvancedCaseOps,
}: {
  filters: QueueFilters;
  viewerUserId: string | null;
  onChange: (f: QueueFilters) => void;
  /**
   * Phase CASES-PERSONAL-UX — when false (Personal Workspace and
   * non-investigation tiers), the risk select + assigned/governance/
   * overdue/legal-hold chips are NOT rendered. Backend selectors are
   * unchanged; existing filter state is still serialised to the URL
   * for users who arrive via a deep link.
   */
  canSeeAdvancedCaseOps: boolean;
}) {
  const set = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) =>
    onChange({ ...filters, [key]: value });
  return (
    <section className="cc-section" data-matter-queue-filters>
      <header className="cc-section-header">
        <h2 className="cc-section-title">Filters</h2>
      </header>
      <div className="cases-filter-row">
        <input
          type="search"
          className="cases-filter-search"
          placeholder="Search by case name"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
          data-matter-queue-search-input
        />
        <select
          aria-label="Status"
          value={filters.status}
          onChange={(e) => set("status", e.target.value as CaseStatus | "")}
          data-matter-queue-status-select
          className="cases-filter-chip"
        >
          <option value="">Any status</option>
          {CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {/* Phase CASES-PERSONAL-UX — risk select is enterprise-only.
            On personal workspaces the CaseRiskSnapshot table is
            mostly unpopulated so this filter would always return
            "NONE" results, and the vocabulary is unfamiliar to the
            target audience. Backend filter param + selector intact. */}
        {canSeeAdvancedCaseOps ? (
          <select
            aria-label="Risk level"
            value={filters.riskLevel}
            onChange={(e) =>
              set("riskLevel", e.target.value as MatterRiskLevel | "")
            }
            data-matter-queue-risk-select
            className="cases-filter-chip"
          >
            <option value="">Any risk</option>
            {RISK_LEVELS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="cases-filter-chips" role="group" aria-label="Filters">
        {/* Phase CASES-PERSONAL-UX — chips visible to ALL audiences.
            Both map to real fields on every case envelope and answer
            the question "is there anything I should do here?". */}
        <FilterToggle
          dataKey="has-open-incidents"
          label="Open issues"
          active={filters.hasOpenIncidents}
          onToggle={() => set("hasOpenIncidents", !filters.hasOpenIncidents)}
        />
        <FilterToggle
          dataKey="missing-artifact"
          label="Missing report or package"
          active={filters.missingArtifact}
          onToggle={() => set("missingArtifact", !filters.missingArtifact)}
        />
        {/* Phase CASES-PERSONAL-UX — enterprise-only chips. Hidden on
            Personal / small-team workspaces. State + backend filter
            params unchanged so a deep link with these params set
            still works for enterprise users. */}
        {canSeeAdvancedCaseOps ? (
          <>
            <FilterToggle
              dataKey="assigned-to-me"
              label="Assigned to me"
              active={filters.assignedToMe}
              disabled={!viewerUserId}
              onToggle={() => set("assignedToMe", !filters.assignedToMe)}
            />
            <FilterToggle
              dataKey="has-governance-blockers"
              label="Governance blockers"
              active={filters.hasGovernanceBlockers}
              onToggle={() =>
                set("hasGovernanceBlockers", !filters.hasGovernanceBlockers)
              }
            />
            <FilterToggle
              dataKey="has-overdue-workflows"
              label="Overdue workflows"
              active={filters.hasOverdueWorkflows}
              onToggle={() =>
                set("hasOverdueWorkflows", !filters.hasOverdueWorkflows)
              }
            />
            <FilterToggle
              dataKey="has-legal-hold"
              label="Active legal hold"
              active={filters.hasLegalHold}
              onToggle={() => set("hasLegalHold", !filters.hasLegalHold)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}

function FilterToggle({
  dataKey,
  label,
  active,
  disabled,
  onToggle,
}: {
  dataKey: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`cases-filter-chip ${active ? "is-active" : ""}`}
      data-matter-queue-filter={dataKey}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Queue table
// ---------------------------------------------------------------------------

function MatterQueueTable({
  items,
  totalBeforeFilter,
  anyFilterActive,
  canSeeAdvancedCaseOps,
  onClearFilters,
  onCreateCase,
}: {
  items: ReadonlyArray<MatterQueueItem>;
  totalBeforeFilter: number;
  /**
   * Phase CASES-PERSONAL-UX — drives which of the two spec-locked
   * empty-state messages renders. When the workspace genuinely has
   * no cases (totalBeforeFilter === 0 AND no filters are active),
   * we show the "create your first case" empty state. When the user
   * narrowed an existing list to zero, we show the "no matches" one
   * with a Clear filters affordance.
   */
  anyFilterActive: boolean;
  canSeeAdvancedCaseOps: boolean;
  onClearFilters: () => void;
  onCreateCase: () => void;
}) {
  return (
    <section className="cc-section" data-matter-queue-table>
      <header className="cc-section-header">
        <h2 className="cc-section-title" data-matter-queue-title>
          {items.length === totalBeforeFilter
            ? `Cases · ${items.length}`
            : `Cases · ${items.length} of ${totalBeforeFilter}`}
        </h2>
      </header>
      {items.length === 0 ? (
        // Phase CASES-PERSONAL-UX — two distinct empty states. The
        // workspace-has-no-cases-yet state is a real onboarding
        // moment; the filtered-to-zero state must offer a quick
        // clear path so the user doesn't think the page is broken.
        totalBeforeFilter === 0 && !anyFilterActive ? (
          <div
            className="cc-section-note"
            data-matter-queue-empty
            data-empty-state="no-cases-yet"
          >
            <strong>No cases yet</strong>
            <p>
              Create a case to group related evidence for an incident,
              claim, project, or review.
            </p>
            <button
              type="button"
              className="btn-primary"
              data-empty-state-cta="create-case"
              onClick={onCreateCase}
            >
              Create case
            </button>
          </div>
        ) : (
          <div
            className="cc-section-note"
            data-matter-queue-empty
            data-empty-state="no-filter-match"
          >
            <strong>No cases match these filters</strong>
            <p>
              Try clearing filters or searching for a different case name.
            </p>
            <button
              type="button"
              className="btn-secondary"
              data-empty-state-cta="clear-filters"
              onClick={onClearFilters}
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <ul className="cases-list" data-matter-queue-items>
          {items.map((row) => (
            <MatterQueueRow
              key={row.id}
              row={row}
              canSeeAdvancedCaseOps={canSeeAdvancedCaseOps}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MatterQueueRow({
  row,
  canSeeAdvancedCaseOps,
}: {
  row: MatterQueueItem;
  canSeeAdvancedCaseOps: boolean;
}) {
  const reasonCodes = row.riskReasonCodes ?? [];
  // Phase CASES-PERSONAL-UX — the matter-queue API exposes
  // `evidenceGapCount` (derived from CaseRiskSnapshot's package /
  // report gap aggregation; the same signal the `missingArtifact`
  // server-side filter uses). For personal/small-business users we
  // surface it as a single plain-language "needs report or package"
  // indicator instead of the enterprise counter strip.
  const hasMissingArtifact = row.evidenceGapCount > 0;
  return (
    <li
      className="cases-row"
      data-matter-queue-row
      data-matter-queue-row-id={row.id}
      data-matter-queue-row-risk={row.riskLevel ?? "NONE"}
      data-matter-queue-row-status={row.status}
    >
      <Link href={`/cases/${row.id}`} className="cases-row-link">
        <div className="cases-row-main">
          <span className="cases-row-title">{row.name}</span>
          {row.referenceNumber ? (
            <span
              className="cases-row-scope"
              data-matter-queue-row-reference={row.referenceNumber}
            >
              {row.referenceNumber}
            </span>
          ) : null}
          {/* Phase CASES-PERSONAL-UX — risk badge is enterprise-only.
              The CaseRiskSnapshot table is mostly unpopulated on
              personal workspaces so the badge would either be hidden
              by the `if (!level)` guard or read "Risk: NONE", both
              of which are noise. */}
          {canSeeAdvancedCaseOps ? (
            <RiskBadge level={row.riskLevel} score={row.riskScore} />
          ) : null}
          {/* Status pill uses the human-readable label for both
              audiences. data-status keeps the enum value for E2E. */}
          <span
            className="cases-row-chip"
            data-matter-queue-row-chip="status"
            data-status={row.status}
          >
            {STATUS_LABEL[row.status as (typeof CASE_STATUSES)[number]] ?? row.status}
          </span>
          {canSeeAdvancedCaseOps && row.priority && row.priority !== "P2" ? (
            <span
              className="cases-row-chip"
              data-matter-queue-row-chip="priority"
              data-priority={row.priority}
            >
              {row.priority}
            </span>
          ) : null}
        </div>
        <div className="cases-row-meta">
          <Counter
            dataKey="linked-evidence"
            value={row.linkedEvidenceCount}
            label={row.linkedEvidenceCount === 1 ? "evidence record" : "evidence records"}
          />
          {/* Phase CASES-PERSONAL-UX — for personal users, collapse the
              full operational counter strip into a single
              plain-language "Needs report or package" chip when there
              are gaps. Enterprise users still see the granular
              counters below. */}
          {!canSeeAdvancedCaseOps && hasMissingArtifact ? (
            <span
              className="cases-row-chip"
              data-matter-queue-row-chip="needs-artifact"
              data-missing-count={row.evidenceGapCount}
            >
              {row.evidenceGapCount === 1
                ? "1 record needs report or package"
                : `${row.evidenceGapCount} records need report or package`}
            </span>
          ) : null}
          {canSeeAdvancedCaseOps && row.evidenceGapCount > 0 ? (
            <Counter
              dataKey="evidence-gap"
              value={row.evidenceGapCount}
              label="gap"
              tone="warning"
            />
          ) : null}
          {canSeeAdvancedCaseOps && row.openIncidentCount > 0 ? (
            <Counter
              dataKey="open-incidents"
              value={row.openIncidentCount}
              label="incident"
              tone="high"
            />
          ) : null}
          {canSeeAdvancedCaseOps && row.activeWorkflowCount > 0 ? (
            <Counter
              dataKey="active-workflows"
              value={row.activeWorkflowCount}
              label="wf"
            />
          ) : null}
          {canSeeAdvancedCaseOps && row.overdueWorkflowCount > 0 ? (
            <Counter
              dataKey="overdue-workflows"
              value={row.overdueWorkflowCount}
              label="overdue"
              tone="critical"
            />
          ) : null}
          {canSeeAdvancedCaseOps && row.governanceBlockerCount > 0 ? (
            <Counter
              dataKey="governance-blockers"
              value={row.governanceBlockerCount}
              label="gov block"
              tone="high"
            />
          ) : null}
          {canSeeAdvancedCaseOps && row.activeLegalHoldCount > 0 ? (
            <span
              className="cases-row-chip"
              data-matter-queue-row-chip="hold"
              data-hold-count={row.activeLegalHoldCount}
            >
              Legal preservation
            </span>
          ) : null}
          {canSeeAdvancedCaseOps && row.activeAssignmentCount > 0 ? (
            <Counter
              dataKey="assignments"
              value={row.activeAssignmentCount}
              label="assigned"
            />
          ) : null}
          <time
            dateTime={row.latestActivityAtUtc}
            data-matter-queue-row-latest-activity
            title={row.latestActivityAtUtc}
          >
            Last updated {formatRelativeTime(row.latestActivityAtUtc)}
          </time>
        </div>
        {/* Phase CASES-PERSONAL-UX — risk-reason codes are enterprise
            taxonomy; hidden for personal users. */}
        {canSeeAdvancedCaseOps && reasonCodes.length > 0 ? (
          <div
            className="cases-row-reasons"
            data-matter-queue-row-reason-codes
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              padding: "6px 0 0",
            }}
          >
            {reasonCodes.map((code) => (
              <span
                key={code}
                className="cases-row-chip"
                data-matter-queue-row-reason={code}
                style={{ fontSize: 11 }}
              >
                {reasonCodeLabel(code)}
              </span>
            ))}
          </div>
        ) : null}
        {/* Recommended action surfaces for both audiences when present
            — it's the closest thing to a "next simple action" hint
            the user spec asks for, and it's plain language. */}
        {row.recommendedAction ? (
          <div
            className="cases-row-recommendation"
            data-matter-queue-row-recommendation
            style={{
              padding: "6px 0 0",
              fontSize: 12,
              color: "#b8c7c3",
            }}
          >
            Recommended: {row.recommendedAction}
          </div>
        ) : !canSeeAdvancedCaseOps && hasMissingArtifact ? (
          // Personal-friendly fallback hint when the backend hasn't
          // computed a recommendedAction but there's still a gap.
          <div
            className="cases-row-recommendation"
            data-matter-queue-row-recommendation
            data-recommendation-source="personal-fallback"
            style={{
              padding: "6px 0 0",
              fontSize: 12,
              color: "#b8c7c3",
            }}
          >
            Generate the missing report or package from the evidence detail page.
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function RiskBadge({
  level,
  score,
}: {
  level: string | null;
  score: number | null;
}) {
  if (!level) return null;
  const tone =
    level === "CRITICAL"
      ? "critical"
      : level === "HIGH"
        ? "high"
        : level === "MEDIUM"
          ? "warning"
          : "neutral";
  return (
    <span
      className="cases-row-chip"
      data-matter-queue-row-chip="risk"
      data-risk-tone={tone}
      data-risk-level={level}
      data-risk-score={score ?? ""}
    >
      Risk: {level}
      {typeof score === "number" ? ` · ${score}` : ""}
    </span>
  );
}

function Counter({
  dataKey,
  value,
  label,
  tone,
}: {
  dataKey: string;
  value: number;
  label: string;
  tone?: "warning" | "high" | "critical";
}) {
  return (
    <span
      data-matter-queue-row-counter={dataKey}
      data-counter-tone={tone ?? "neutral"}
    >
      {value} {label}
    </span>
  );
}

function reasonCodeLabel(code: string): string {
  switch (code) {
    case "EVIDENCE_GAP":
      return "Evidence gap";
    case "INCIDENT_OPEN":
      return "Open incident";
    case "WORKFLOW_OVERDUE":
      return "Workflow overdue";
    case "WORKFLOW_ACTIVE":
      return "Active workflow";
    case "INTEGRITY_FAILED":
      return "Integrity failed";
    case "INTEGRITY_REVIEW_REQUIRED":
      return "Integrity review";
    case "GOVERNANCE_BLOCKER":
      return "Governance blocker";
    case "LEGAL_HOLD_ACTIVE":
      return "Legal preservation";
    case "REVIEWER_OVERLOAD":
      return "Reviewer overload";
    case "AUDIT_GAP":
      return "Audit gap";
    case "PACKAGE_MISSING":
      return "Package missing";
    case "REPORT_MISSING":
      return "Report missing";
    case "CUSTODY_CONCERN":
      return "Custody concern";
    default:
      return code;
  }
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

function QueueLoading() {
  // Phase IA-self-serve-completion — loading-state heading mirrors the
  // ready-state heading so the eyebrow does not flip from
  // "Your cases" → "Investigation Matters" while loading.
  return (
    <main className="cc-page" data-matter-queue-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Your cases</div>
          <h1 className="cc-title">Your cases</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function QueueAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-matter-queue-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view the matter queue."
              : "You do not have permission to view the matter queue for this workspace. Ask a workspace administrator."}
          </p>
        </div>
      </header>
    </main>
  );
}

function QueueUnavailable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="cc-page" data-matter-queue-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">Matter queue temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
        <div className="cc-meta">
          <button type="button" onClick={onRetry} className="cases-filter-chip">
            Retry
          </button>
        </div>
      </header>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Time helper
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
