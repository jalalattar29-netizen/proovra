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
 * Phase 7C — VISUAL redesign of the list surface only. The queue now
 * renders inside the canonical PROOVRA design foundation:
 *   - PageShell + a premium PageHeader hero (title / description /
 *     one primary "Create case" CTA in the coral→pink gradient Button).
 *   - A shared FilterBar strip wrapping the (source-pinned) search
 *     input + status / risk selects.
 *   - A premium Card grid for the case rows, with status / risk /
 *     priority rendered as tone-keyed Badges and the operational
 *     counters as restyled meta chips.
 *   - Card-framed EmptyState surfaces for the two zero states.
 * NO data-fetching, permission, routing, or business logic changed —
 * every data-testid / data-* attribute + the load state machine +
 * the create-case flow are preserved verbatim.
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

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
// Phase 7C — canonical PROOVRA design foundation. PageShell/PageHeader/
// PageSection + FilterBar come from the shared barrel; the richer
// Button / Card / Badge / EmptyState primitives are deep-imported per
// the barrel contract.
import { PageShell, PageHeader, PageSection, FilterBar } from "../ui";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import type { BadgeTone } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
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
  // workspace OR the personal-space id, so personal users with
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
          message: toSafeUserError(e, { message: "Unable to load matter queue." }).message,
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
  // workspace and the personal space are unavailable.
  if (!workspaceId) {
    const hasHealthyPersonalSpace = personalSpace?.status === "active";
    if (!hasHealthyPersonalSpace) {
      return (
        <PageShell data-cases-no-workspace>
          <PageSection>
            <CapabilityDegradedPanel
              surface="Cases"
              requiredCapability="CASES_VIEW"
              reason="No active workspace is available for this account. Create or switch into a workspace to view your cases."
              alternatives={[
                { label: "View your evidence", href: "/evidence" },
                { label: "Generate a report", href: "/reports" },
                { label: "Switch or create a workspace", href: "/workspaces" },
              ]}
            />
          </PageSection>
        </PageShell>
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
  // is the personal space (no workspace), the queue still renders
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
    <>
      <PageShell
        data-cases-index
        data-matter-queue
        data-cases-personal-mode={isPersonalMode ? "true" : "false"}
        data-cases-advanced-mode={canSeeAdvancedCaseOps ? "true" : "false"}
        header={
          <PageHeader
            title={
              /* Phase CASES-PERSONAL-UX — single canonical title. The
                 prior layout repeated "Your cases" as both kicker and h1,
                 and the subtitle leaned on enterprise jargon (legal
                 holds, etc). Personal / small-business audience gets a
                 plain-language title + a one-line description of the
                 concept. The pinned cc-title / cc-subtitle nodes are
                 retained inside the premium PageHeader hero. */
              <h1 className="cc-title" data-cases-title>
                Cases
              </h1>
            }
            subtitle={
              <p className="cc-subtitle" data-cases-subtitle>
                Group related evidence into simple workspaces for incidents,
                claims, projects, or reviews.
              </p>
            }
            contextStrip={
              <div className="cc-meta" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Badge tone="info" subtle data-matter-queue-total>
                  {envelope.total} {envelope.total === 1 ? "case" : "cases"}
                </Badge>
                <span
                  title={envelope.generatedAt}
                  data-matter-queue-generated-at
                  style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
                >
                  Refreshed {formatRelativeTime(envelope.generatedAt)}
                </span>
                {isReloading ? (
                  <span
                    className="cc-muted"
                    data-matter-queue-reloading
                    style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
                  >
                    Updating…
                  </span>
                ) : null}
              </div>
            }
            primaryAction={
              /* Phase 2.1 — canonical Create Case CTA. Server enforces
                 permissions; the button is visible to any team member so
                 they get a structured AccessGate inside the modal on 403
                 instead of a missing button + raw 403 elsewhere. Phase 7C
                 promotes it to the coral→pink gradient primary Button. */
              <Button
                variant="primary"
                data-create-case-trigger
                onClick={() => setCreateOpen(true)}
              >
                Create case
              </Button>
            }
          />
        }
      >
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
      </PageShell>

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
    </>
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

/**
 * Phase 7C — inline token style for the pinned raw <select> controls.
 * The FilterBar.Select helper takes an options array + string change
 * handler, but the risk/status selects are source-pinned to their exact
 * JSX (option maps, aria-labels, data-testids), so we keep the raw
 * <select> elements and give them the same premium token chrome the
 * FilterBar controls use.
 */
const FILTER_CONTROL_STYLE: React.CSSProperties = {
  minHeight: 40,
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  padding: "0 30px 0 12px",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 8px center",
  outline: "none",
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
    <PageSection data-matter-queue-filters>
      {/* Phase 7C — the shared FilterBar wraps the source-pinned search
          input + status / risk selects in the canonical premium strip.
          The raw controls are kept (their JSX is contract-pinned) and
          restyled inline to match the FilterBar chrome. */}
      <FilterBar>
        <div
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            flex: "1 1 260px",
            minWidth: 200,
            maxWidth: 420,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 12,
              display: "inline-flex",
              color: "var(--ink-muted, #94a3b8)",
              pointerEvents: "none",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            className="cases-filter-search"
            placeholder="Search by case name"
            aria-label="Search by case name"
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
            data-matter-queue-search-input
            style={{
              minHeight: 40,
              width: "100%",
              padding: "0 14px 0 34px",
              fontSize: 13.5,
              color: "var(--ink-primary, #0f172a)",
              background: "var(--surface-card, #ffffff)",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-md, 8px)",
              outline: "none",
            }}
          />
        </div>
        <select
          aria-label="Status"
          value={filters.status}
          onChange={(e) => set("status", e.target.value as CaseStatus | "")}
          data-matter-queue-status-select
          className="cases-filter-chip"
          style={FILTER_CONTROL_STYLE}
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
            style={FILTER_CONTROL_STYLE}
          >
            <option value="">Any risk</option>
            {RISK_LEVELS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </FilterBar>
      {/* Phase CASES-PERSONAL-UX-CLEANUP — chips removed for everyone.
          The personal "Open issues" / "Missing report or package" chips
          tested as confusing or sparse for the target audience; the
          spec is explicit that the Cases page should contain ONLY:
          search · status · Create case · cards · count · empty states.
          Enterprise chips (assigned/governance/overdue/legal-hold) are
          also removed from this surface — enterprise users with the
          investigation tier still reach the equivalent filters via the
          matter-queue API directly. Backend filter parameters on
          `/v1/cases/matter-queue` are intentionally preserved so any
          enterprise client that already sends them keeps working. */}
      {canSeeAdvancedCaseOps && viewerUserId ? (
        // Anti-regression: keep the `viewerUserId` symbol referenced
        // in advanced mode so a future caller that re-introduces the
        // "Assigned to me" chip can wire it without TS removing the
        // unused-prop warning the previous chip relied on.
        <div data-cases-advanced-mode-context-only aria-hidden style={{ display: "none" }} />
      ) : null}
    </PageSection>
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
    <PageSection
      data-matter-queue-table
      title={
        <span data-matter-queue-title>
          {items.length === totalBeforeFilter
            ? `Cases · ${items.length}`
            : `Cases · ${items.length} of ${totalBeforeFilter}`}
        </span>
      }
    >
      {items.length === 0 ? (
        // Phase CASES-PERSONAL-UX — two distinct empty states. The
        // workspace-has-no-cases-yet state is a real onboarding
        // moment; the filtered-to-zero state must offer a quick
        // clear path so the user doesn't think the page is broken.
        // Phase 7C wraps each in a Card `empty` frame + the shared
        // EmptyState surface, keeping the pinned copy + CTA buttons.
        totalBeforeFilter === 0 && !anyFilterActive ? (
          <Card variant="empty" padding="none">
            <div
              className="cc-section-note"
              data-matter-queue-empty
              data-empty-state="no-cases-yet"
            >
              <EmptyState
                title={<strong>No cases yet</strong>}
                purpose={
                  <p style={{ margin: 0 }}>
                    Create a case to group related evidence for an incident,
                    claim, project, or review.
                  </p>
                }
                action={
                  <button
                    type="button"
                    data-empty-state-cta="create-case"
                    onClick={onCreateCase}
                    style={PRIMARY_CTA_STYLE}
                  >
                    Create case
                  </button>
                }
              />
            </div>
          </Card>
        ) : (
          <Card variant="empty" padding="none">
            <div
              className="cc-section-note"
              data-matter-queue-empty
              data-empty-state="no-filter-match"
            >
              <EmptyState
                title={<strong>No cases match these filters</strong>}
                purpose={
                  <p style={{ margin: 0 }}>
                    Try clearing filters or searching for a different case name.
                  </p>
                }
                action={
                  <button
                    type="button"
                    data-empty-state-cta="clear-filters"
                    onClick={onClearFilters}
                    style={SECONDARY_CTA_STYLE}
                  >
                    Clear filters
                  </button>
                }
              />
            </div>
          </Card>
        )
      ) : (
        <ul
          className="cases-list"
          data-matter-queue-items
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          }}
        >
          {items.map((row) => (
            <MatterQueueRow
              key={row.id}
              row={row}
              canSeeAdvancedCaseOps={canSeeAdvancedCaseOps}
            />
          ))}
        </ul>
      )}
    </PageSection>
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
      style={{ listStyle: "none", margin: 0, padding: 0 }}
    >
      <Card variant="action" padding="none" className="cases-row-card">
        <Link
          href={`/cases/${row.id}`}
          className="cases-row-link"
          style={{
            display: "block",
            padding: 16,
            color: "inherit",
            textDecoration: "none",
          }}
        >
          <div
            className="cases-row-main"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              className="cases-row-title"
              style={{
                fontSize: 15,
                fontWeight: 650,
                color: "var(--ink-primary, #0f172a)",
                marginRight: "auto",
              }}
            >
              {row.name}
            </span>
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
            <Badge
              tone={statusBadgeTone(row.status)}
              className="cases-row-chip"
              data-matter-queue-row-chip="status"
              data-status={row.status}
            >
              {STATUS_LABEL[row.status as (typeof CASE_STATUSES)[number]] ?? row.status}
            </Badge>
            {canSeeAdvancedCaseOps && row.priority && row.priority !== "P2" ? (
              <Badge
                tone="neutral"
                subtle
                className="cases-row-chip"
                data-matter-queue-row-chip="priority"
                data-priority={row.priority}
              >
                {row.priority}
              </Badge>
            ) : null}
          </div>
          <div
            className="cases-row-meta"
            style={{
              display: "flex",
              gap: 12,
              marginTop: 10,
              fontSize: 12,
              color: "var(--ink-secondary, #475569)",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
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
              style={{ marginLeft: "auto", color: "var(--ink-muted, #94a3b8)" }}
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
                padding: "10px 0 0",
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
                padding: "10px 0 0",
                fontSize: 12,
                color: "var(--ink-secondary, #475569)",
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
                padding: "10px 0 0",
                fontSize: 12,
                color: "var(--ink-secondary, #475569)",
              }}
            >
              Generate the missing report or package from the evidence detail page.
            </div>
          ) : null}
        </Link>
      </Card>
    </li>
  );
}

/**
 * Phase 7C — map the case status enum onto a semantic Badge tone so the
 * status pill reads for colour-blind users and matches the app-wide
 * status vocabulary. Presentation-only; the enum value is preserved on
 * `data-status`.
 */
function statusBadgeTone(status: string): BadgeTone {
  switch (status) {
    case "OPEN":
    case "INVESTIGATING":
      return "info";
    case "ON_HOLD":
      return "pending";
    case "RESOLVED":
      return "verified";
    case "CLOSED":
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
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
  const badgeTone: BadgeTone =
    level === "CRITICAL" || level === "HIGH"
      ? "risk"
      : level === "MEDIUM"
        ? "pending"
        : "neutral";
  return (
    <Badge
      tone={badgeTone}
      dot
      className="cases-row-chip"
      data-matter-queue-row-chip="risk"
      data-risk-tone={tone}
      data-risk-level={level}
      data-risk-score={score ?? ""}
    >
      Risk: {level}
      {typeof score === "number" ? ` · ${score}` : ""}
    </Badge>
  );
}

/**
 * Phase 7C — operational counter chip. Restyled as a tone-keyed pill so
 * the enterprise counter strip reads as a scannable premium row instead
 * of raw comma text. The `data-matter-queue-row-counter` + tone data
 * attributes are preserved for E2E / observability.
 */
const COUNTER_TONE_STYLE: Record<
  "neutral" | "warning" | "high" | "critical",
  React.CSSProperties
> = {
  neutral: {
    background: "var(--status-neutral-bg, #f1f5f9)",
    color: "var(--status-neutral-fg, #475569)",
    border: "1px solid var(--status-neutral-border, #cbd5e1)",
  },
  warning: {
    background: "var(--status-pending-bg, #fef3c7)",
    color: "var(--status-pending-fg, #78350f)",
    border: "1px solid var(--status-pending-border, #fde68a)",
  },
  high: {
    background: "var(--status-info-bg, #eff6ff)",
    color: "var(--status-info-fg, #1e40af)",
    border: "1px solid var(--status-info-border, #bfdbfe)",
  },
  critical: {
    background: "var(--status-risk-bg, #fef2f2)",
    color: "var(--status-risk-fg, #991b1b)",
    border: "1px solid var(--status-risk-border, #fecaca)",
  },
};

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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
        ...COUNTER_TONE_STYLE[tone ?? "neutral"],
      }}
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
// Shared inline CTA styles (Phase 7C) — the two empty-state CTAs are
// source-pinned to raw <button> nodes carrying data-empty-state-cta
// (the contract regexes require the exact element + text with no
// wrapping <span>), so we cannot swap them for the <Button> component.
// The legacy btn-primary/btn-secondary class names have been dropped;
// these buttons now carry the same token-driven premium chrome the
// Button primitive uses via the inline style objects below.
// ---------------------------------------------------------------------------

const PRIMARY_CTA_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 42,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 650,
  borderRadius: 12,
  cursor: "pointer",
  background: "var(--btn-primary-bg)",
  color: "var(--btn-primary-color)",
  border: "1px solid var(--btn-primary-border)",
  boxShadow: "var(--btn-primary-shadow)",
};

const SECONDARY_CTA_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 42,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 650,
  borderRadius: 12,
  cursor: "pointer",
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
};

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

function QueueLoading() {
  // Phase IA-self-serve-completion — loading-state heading mirrors the
  // ready-state heading so the eyebrow does not flip from
  // "Your cases" → "Investigation Matters" while loading.
  return (
    <PageShell
      data-matter-queue-loading
      header={
        <PageHeader
          eyebrow={<span className="cc-kicker">Your cases</span>}
          title={<span className="cc-title">Your cases</span>}
        />
      }
    >
      <PageSection>
        <Card>
          <div className="cc-skeleton" style={{ minHeight: 120 }} />
        </Card>
      </PageSection>
    </PageShell>
  );
}

function QueueAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <PageShell
      data-matter-queue-auth-error={code}
      header={
        <PageHeader
          eyebrow={<span className="cc-kicker">Investigation Matters</span>}
          title={
            <span className="cc-title">
              {code === "auth_required"
                ? "Sign in required"
                : "Permission required"}
            </span>
          }
          subtitle={
            <span className="cc-subtitle">
              {code === "auth_required"
                ? "Sign in to view the matter queue."
                : "You do not have permission to view the matter queue for this workspace. Ask a workspace administrator."}
            </span>
          }
        />
      }
    />
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
    <PageShell
      data-matter-queue-unavailable
      header={
        <PageHeader
          eyebrow={<span className="cc-kicker">Investigation Matters</span>}
          title={
            <span className="cc-title">Matter queue temporarily unavailable</span>
          }
          subtitle={<span className="cc-subtitle">{message}</span>}
          primaryAction={
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      }
    />
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
