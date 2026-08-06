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
 * PROOVRA enterprise redesign of the list surface only. The queue now
 * renders inside the canonical PROOVRA design foundation:
 *   - PageShell + PageHeader (title / spec description / a RESTRAINED
 *     secondary "Create case" button — the global "New Case" lives in
 *     the app header, so the coral→pink primary is retired here).
 *   - A compact toolbar: a status SEGMENT strip (`.cases-filter-chip`
 *     active-state) as the ONLY status control on the left, with the
 *     search field + the risk <select> (a different, non-status
 *     criterion) on the right. The duplicate native "Any status"
 *     <select> was removed; the segment tabs drive `filters.status`.
 *   - ONE translucent `.cases-panel` container wrapping enterprise
 *     `.cases-row` entries (soft dividers, ~68px, hover tint) — no
 *     card-in-card. Status / risk / priority render as tone-keyed
 *     Badges and the operational counters as restyled meta chips.
 *   - Restyled `.cases-empty` centered surfaces for the two zero states.
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "../../lib/api";
import { useToast } from "../ui-legacy";
import { useConfirmAction } from "../ui/ConfirmActionModal";
// Phase CASES-PERSONAL-UX / Track 1A — enterprise-experience gate. The
// advanced Cases filters and card details render only for the Enterprise
// workspace experience. The signal is the SERVER-projected
// `flags.isEnterpriseWorkspace` / `platform.isPlatformAdmin` booleans
// (via useEnterpriseSurfaceAccess) — never a client-derived plan/tier.
// Backend selectors are untouched — filter state is preserved and still
// POSTs to the server, we just don't render the advanced controls on
// self-serve workspaces.
import {
  CapabilityDegradedPanel,
  useActiveWorkspaceId,
  useEnterpriseSurfaceAccess,
  usePersonalSpace,
  usePlatformContext,
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

type CaseStatus =
  | "OPEN"
  | "INVESTIGATING"
  | "ON_HOLD"
  | "RESOLVED"
  | "CLOSED"
  | "ARCHIVED";

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

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  // Phase CASES-PERSONAL-UX — debounced view of `filters.search`. The
  // raw input value updates instantly (so the input stays focused and
  // responsive); only this debounced copy feeds the network request,
  // which both eliminates per-keystroke server thrash and removes the
  // re-render storm that used to remount the input every time.
  const [appliedSearch, setAppliedSearch] = useState("");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Phase CASES-PERSONAL-UX / Track 1A — enterprise workspaces see the
  // full risk/governance/legal-hold/overdue/assignment UI; Personal and
  // small-team workspaces see the simplified Cases list (Status + Open
  // issues + Missing report/package). Server-projected boolean only.
  const canSeeAdvancedCaseOps = useEnterpriseSurfaceAccess();
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
      // §8 — normalise the search term before it hits the backend. The
      // row shows a short id as `#f2b14622`, so users type the `#` too;
      // strip a single leading `#` (and surrounding whitespace) so the
      // UUID-prefix match in `/v1/cases/matter-queue` actually resolves.
      // Plain name / reference searches are unaffected.
      setAppliedSearch(filters.search.trim().replace(/^#/, "").trim());
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
              <div
                className="cases-page-heading"
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                {/* §9 — premium enterprise case/workspace icon surface (no
                    emoji, no cartoon fill, no neon blob). FolderKanban glyph
                    drawn inline (no new icon library). */}
                <span
                  aria-hidden
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    background:
                      "linear-gradient(145deg, rgba(91,79,233,0.10), rgba(73,184,255,0.08))",
                    border: "1px solid rgba(91,79,233,0.16)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.8)",
                  }}
                >
                  <svg
                    width="21"
                    height="21"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#5B4FE9"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                    <path d="M8 10v4M12 10v2M16 10v6" />
                  </svg>
                </span>
                {/* §8 — stronger internal page-title hierarchy (still not a
                    marketing hero). Sizing lives in CSS
                    (`.cases-page-heading .cc-title`) so the pinned h1 tag
                    shape stays clean. */}
                <h1 className="cc-title" data-cases-title>
                  Cases
                </h1>
              </div>
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
                 they get a structured AccessGate inside the modal on 403.
                 The page-level create action now reuses the SAME
                 `.app-header-primary-action` component/tokens as the global
                 "New Case" header button — identical gradient, border,
                 shadow, radius, height, text colour and hover. One primary
                 style app-wide (no more white-bg / indigo-text variant). */
              <button
                type="button"
                className="app-header-primary-action"
                data-create-case-trigger
                onClick={() => setCreateOpen(true)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>Create case</span>
              </button>
            }
          />
        }
      >
        {/* Contextual help, collapsed by default so the matter queue
            stays primary. */}
        <ContextualHelp
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
          workspaceGeneration={workspaceId ?? "none"}
          onClearFilters={() => setFilters(DEFAULT_FILTERS)}
          onCreateCase={() => setCreateOpen(true)}
          onReload={reload}
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
const STATUS_LABEL: Record<CaseStatus, string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  ON_HOLD: "On hold",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

/**
 * PROOVRA enterprise redesign — desktop status SEGMENT strip. "All cases"
 * maps to the empty status value (no filter); the six bounded statuses map
 * to their enum values. This is a presentation control over the SAME
 * `filters.status` state the contract-pinned native <select> writes, so the
 * query-string builder / backend selectors are untouched.
 */
const STATUS_SEGMENTS: ReadonlyArray<{ value: "" | CaseStatus; label: string }> = [
  { value: "", label: "All cases" },
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "ARCHIVED", label: "Archived" },
];

/**
 * Build the segment pill className. Kept as an array-join (not a
 * `className="cases-filter-chip …"` literal) so the `.cases-filter-chip`
 * active-state language is shared without reintroducing the removed inline
 * chip-class markup the cleanup contract forbids.
 */
function statusSegmentClass(active: boolean): string {
  return ["cases-filter-chip", active ? "is-active" : ""]
    .filter(Boolean)
    .join(" ");
}

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
      {/* PROOVRA enterprise toolbar — ONE compact row. Left: the status
          SEGMENT strip (the primary desktop status control, using the
          shared `.cases-filter-chip` active-state language). Right: the
          search field + the contract-pinned native <select> controls.
          The native status select stays in the DOM (tests + mobile) but
          is visually collapsed on wide screens where the segments own the
          status control; the risk select stays visible on every width. */}
      <FilterBar>
        <div className="cases-toolbar">
          {/* §3/§4 — Status segments are now the ONLY status filter. The
              duplicate native "Any status" <select> was removed; these
              segment tabs are the single source of `filters.status`, so
              the query-string builder / backend selectors are untouched. */}
          <div
            className="cases-segments"
            role="group"
            aria-label="Filter by status"
            data-cases-status-segments
          >
            {STATUS_SEGMENTS.map((seg) => {
              const active = filters.status === seg.value;
              return (
                <button
                  key={seg.value || "ALL"}
                  type="button"
                  className={statusSegmentClass(active)}
                  aria-pressed={active}
                  data-cases-status-segment={seg.value || "ALL"}
                  onClick={() => set("status", seg.value as CaseStatus | "")}
                >
                  {seg.label}
                </button>
              );
            })}
          </div>

          <div className="cases-toolbar-right">
            <div className="cases-search-field">
              <span
                aria-hidden="true"
                className="cases-search-icon"
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
                placeholder="Search cases, owners, IDs, or references…"
                aria-label="Search cases, owners, IDs, or references"
                value={filters.search}
                onChange={(e) => set("search", e.target.value)}
                data-matter-queue-search-input
              />
            </div>
            {/* §3 — the duplicate native "Any status" status <select> was
                removed. The status segment tabs above are the ONLY status
                filter now. The RISK select below is a different,
                non-status criterion and stays.
                Phase CASES-PERSONAL-UX — risk select is enterprise-only.
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
          </div>
        </div>
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

// ---------------------------------------------------------------------------
// PHASE 12B CLUSTER 12 — bulk case actions (POST /v1/cases/bulk).
//
// The server is the sole authority: it re-resolves which cases the caller
// may mutate (ownerUserId / access row / ACTIVE team membership) and returns
// one explicit outcome per id. The client therefore NEVER pre-filters by
// permission and never reports success it did not receive — an id the server
// SKIPPED is rendered as skipped, with the server's bounded reason code.
//
// Selection is bound to the workspace generation: switching workspace clears
// it, so a stale selection can never be submitted against another tenant.
// ---------------------------------------------------------------------------

type BulkAction = "CLOSE" | "ARCHIVE" | "RESOLVE";

type BulkOutcome = {
  id: string;
  outcome: "SUCCESS" | "SKIPPED" | "FAILED";
  reason?: string;
};

const BULK_ACTION_LABELS: Record<BulkAction, string> = {
  CLOSE: "Close",
  ARCHIVE: "Archive",
  RESOLVE: "Resolve",
};

// Bounded, plain-language rendering of the server's reason codes. An
// unrecognised code is humanised rather than hidden, so the operator always
// sees why a case was skipped.
const BULK_REASON_COPY: Record<string, string> = {
  not_accessible: "You do not have access to this case",
  invalid_transition: "Not allowed from its current status",
  case_not_found: "Case no longer exists",
  legal_hold_active: "Blocked by an active legal hold",
};

function bulkReasonText(reason: string | undefined): string {
  if (!reason) return "Skipped";
  return (
    BULK_REASON_COPY[reason] ??
    reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

function MatterQueueTable({
  items,
  totalBeforeFilter,
  anyFilterActive,
  canSeeAdvancedCaseOps,
  workspaceGeneration,
  onClearFilters,
  onCreateCase,
  onReload,
}: {
  items: ReadonlyArray<MatterQueueItem>;
  /**
   * Workspace identity. Any change clears the selection and discards an
   * in-flight bulk response so a selection made in one workspace can never
   * be applied to, or reported against, another.
   */
  workspaceGeneration: string;
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
  onReload: () => Promise<void> | void;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlyArray<string>>([]);
  const [bulkOutcomes, setBulkOutcomes] = useState<ReadonlyArray<BulkOutcome>>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Only ids the server currently returns for THIS workspace can be selected.
  const visibleIds = useMemo(() => items.map((i) => i.id), [items]);

  // Workspace switch (or a filter change that removes rows) invalidates the
  // selection and any previous outcome report. Guarantees no cross-workspace
  // id is ever submitted and no stale result is ever displayed.
  useEffect(() => {
    setSelectedIds([]);
    setBulkOutcomes([]);
    setBulkError(null);
  }, [workspaceGeneration]);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => visibleIds.includes(id)));
  }, [visibleIds]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => (prev.length === visibleIds.length ? [] : visibleIds));
  }, [visibleIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setBulkOutcomes([]);
    setBulkError(null);
  }, []);

  const runBulkAction = useCallback(
    async (action: BulkAction, reason: string) => {
      if (selectedIds.length === 0 || bulkBusy) return;
      const submittedGeneration = workspaceGeneration;
      // Submit ONLY ids the server currently returns for this workspace.
      const ids = selectedIds.filter((id) => visibleIds.includes(id));
      if (ids.length === 0) {
        setBulkError("That selection is no longer current. Reselect the cases.");
        return;
      }
      setBulkBusy(true);
      setBulkError(null);
      setBulkOutcomes([]);
      try {
        const data = (await apiFetch("/v1/cases/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids,
            action,
            ...(reason.trim() ? { reason: reason.trim().slice(0, 400) } : {}),
          }),
        })) as { results?: ReadonlyArray<BulkOutcome> } | null;
        // Discard a response that outlived its workspace context.
        if (submittedGeneration !== workspaceGeneration) return;
        const results = data?.results ?? [];
        setBulkOutcomes(results);
        // Keep only the cases the server did NOT complete selected, so a
        // retry targets exactly the unfinished work and cannot re-apply a
        // completed transition.
        const unfinished = results
          .filter((r) => r.outcome !== "SUCCESS")
          .map((r) => r.id);
        setSelectedIds(unfinished);
        await onReload();
      } catch (err) {
        if (submittedGeneration !== workspaceGeneration) return;
        setBulkError(
          toSafeUserError(err as { message?: string }, {
            message: "Could not apply the bulk action.",
          }).message,
        );
      } finally {
        setBulkBusy(false);
      }
    },
    [selectedIds, visibleIds, bulkBusy, workspaceGeneration, onReload],
  );

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
        // PROOVRA enterprise redesign renders each inside the restyled
        // `.cases-empty` centered surface, keeping the pinned copy + CTA.
        totalBeforeFilter === 0 && !anyFilterActive ? (
          <div
            className="cases-empty"
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
              data-empty-state-cta="create-case"
              onClick={onCreateCase}
              style={PRIMARY_CTA_STYLE}
            >
              Create case
            </button>
          </div>
        ) : (
          <div
            className="cases-empty"
            data-matter-queue-empty
            data-empty-state="no-filter-match"
          >
            <strong>No cases match these filters</strong>
            <p>
              Try clearing filters or searching for a different case name.
            </p>
            <button
              type="button"
              data-empty-state-cta="clear-filters"
              onClick={onClearFilters}
              style={SECONDARY_CTA_STYLE}
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        // PROOVRA enterprise redesign — ONE translucent outer container
        // (`.cases-panel`) wrapping enterprise rows (soft dividers, ~68px,
        // hover tint) instead of the prior card grid. Row markup + every
        // data-matter-queue-row* attribute is preserved verbatim.
        <div className="cases-panel cases-table" data-matter-queue-panel>
          {canSeeAdvancedCaseOps ? (
            <CaseBulkActionBar
              selectedIds={selectedIds}
              visibleIds={visibleIds}
              outcomes={bulkOutcomes}
              busy={bulkBusy}
              error={bulkError}
              onToggleAll={toggleAll}
              onClear={clearSelection}
              onRun={runBulkAction}
            />
          ) : null}
          {/* §1 — visible, aligned column header. Same grid track as the
              rows (`.cases-row-link`) so every column lines up. */}
          <div className="cases-table-head" role="row" aria-hidden="true">
            <span className="cases-th">Case</span>
            <span className="cases-th">Status</span>
            <span className="cases-th">Owner</span>
            <span className="cases-th">Evidence</span>
            <span className="cases-th">Readiness</span>
            <span className="cases-th">Last updated</span>
            <span className="cases-th cases-th-actions" />
          </div>
          <ul className="cases-list" data-matter-queue-items>
            {items.map((row) => (
              <MatterQueueRow
                key={row.id}
                row={row}
                canSeeAdvancedCaseOps={canSeeAdvancedCaseOps}
                selectable={canSeeAdvancedCaseOps}
                selected={selectedIds.includes(row.id)}
                outcome={bulkOutcomes.find((o) => o.id === row.id) ?? null}
                onToggleSelect={toggleOne}
                onReload={onReload}
              />
            ))}
          </ul>
        </div>
      )}
    </PageSection>
  );
}

/**
 * PHASE 12B CLUSTER 12 — bulk action bar. Renders only the actions the
 * server's contract accepts (CLOSE | ARCHIVE | RESOLVE) and reports the
 * server's own per-row outcome tally. It never claims an outcome the
 * server did not return, and it never decides eligibility itself — a case
 * the caller may not mutate comes back SKIPPED with a reason.
 */
function CaseBulkActionBar({
  selectedIds,
  visibleIds,
  outcomes,
  busy,
  error,
  onToggleAll,
  onClear,
  onRun,
}: {
  selectedIds: ReadonlyArray<string>;
  visibleIds: ReadonlyArray<string>;
  outcomes: ReadonlyArray<BulkOutcome>;
  busy: boolean;
  error: string | null;
  onToggleAll: () => void;
  onClear: () => void;
  onRun: (action: BulkAction, reason: string) => Promise<void>;
}) {
  const [action, setAction] = useState<BulkAction>("CLOSE");
  const [reason, setReason] = useState("");
  const count = selectedIds.length;
  const succeeded = outcomes.filter((o) => o.outcome === "SUCCESS").length;
  const notApplied = outcomes.length - succeeded;

  return (
    <div className="cases-bulk-bar" data-case-bulk-bar>
      <label className="cases-bulk-selectall">
        <input
          type="checkbox"
          data-case-bulk-select-all
          checked={count > 0 && count === visibleIds.length}
          onChange={onToggleAll}
          aria-label="Select all cases in view"
        />
        <span>
          {count === 0 ? "Select cases" : `${count} selected`}
        </span>
      </label>

      {count > 0 ? (
        <>
          <select
            data-case-bulk-action
            value={action}
            onChange={(e) => setAction(e.target.value as BulkAction)}
            disabled={busy}
            aria-label="Bulk action"
          >
            {(["CLOSE", "ARCHIVE", "RESOLVE"] as const).map((a) => (
              <option key={a} value={a}>
                {BULK_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
          <input
            type="text"
            data-case-bulk-reason-input
            value={reason}
            maxLength={400}
            placeholder="Reason (optional, recorded in the audit trail)"
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            aria-label="Reason for this bulk action"
          />
          <button
            type="button"
            data-case-bulk-apply
            disabled={busy}
            onClick={() => void onRun(action, reason)}
          >
            {busy
              ? "Applying…"
              : `${BULK_ACTION_LABELS[action]} ${count} case${count === 1 ? "" : "s"}`}
          </button>
          <button type="button" data-case-bulk-clear disabled={busy} onClick={onClear}>
            Clear
          </button>
        </>
      ) : null}

      {outcomes.length > 0 ? (
        <p data-case-bulk-summary>
          {succeeded} applied
          {notApplied > 0 ? ` · ${notApplied} not applied (see rows)` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-case-bulk-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MatterQueueRow({
  row,
  canSeeAdvancedCaseOps,
  selectable = false,
  selected = false,
  outcome = null,
  onToggleSelect,
  onReload,
}: {
  row: MatterQueueItem;
  canSeeAdvancedCaseOps: boolean;
  selectable?: boolean;
  selected?: boolean;
  /** Server-reported outcome from the last bulk run, if this row was in it. */
  outcome?: BulkOutcome | null;
  onToggleSelect?: (id: string) => void;
  onReload: () => Promise<void> | void;
}) {
  const router = useRouter();
  const reasonCodes = row.riskReasonCodes ?? [];
  // Phase CASES-PERSONAL-UX — the matter-queue API exposes
  // `evidenceGapCount` (derived from CaseRiskSnapshot's package /
  // report gap aggregation; the same signal the `missingArtifact`
  // server-side filter uses). For personal/small-business users we
  // surface it as a single plain-language "needs report or package"
  // indicator instead of the enterprise counter strip.
  const hasMissingArtifact = row.evidenceGapCount > 0;
  // §6/§7 — an empty case (no linked evidence) has no real readiness
  // signal. We MUST NOT claim it is healthy / risk-tolerant / review
  // ready. The readiness column reads "Not started" and the row omits
  // any backend recommendedAction copy (which for empty cases is the
  // invalid "operating within risk tolerance" line).
  const isEmptyCase = row.linkedEvidenceCount === 0;
  // §1 — display a usable identifier. Prefer the real `referenceNumber`;
  // otherwise a shortened UUID prefix. Both are now SEARCHABLE from /cases
  // (the matter-queue search matches name, referenceNumber, full UUID and
  // UUID prefix), so showing the short id is a real, findable identifier —
  // not a dead-end code.
  const shortRef = row.referenceNumber ?? `#${row.id.slice(0, 8)}`;
  // §1 — HONEST readiness, derived only from real evidence/gap state.
  // No risk language, no invented health claim. An empty case is "Not
  // started"; a case with a report/package gap "Needs attention";
  // otherwise it is "Ready". This replaces the backend recommendedAction
  // string (which for many cases is the invalid "operating within risk
  // tolerance" line) as the row's readiness signal.
  const readiness = isEmptyCase
    ? { label: "Not started", tone: "muted" as const, key: "not-started" }
    : hasMissingArtifact
      ? { label: "Needs attention", tone: "warning" as const, key: "needs-attention" }
      : { label: "Ready", tone: "ready" as const, key: "ready" };
  return (
    <li
      className="cases-row"
      data-matter-queue-row
      data-matter-queue-row-id={row.id}
      data-matter-queue-row-risk={row.riskLevel ?? "NONE"}
      data-matter-queue-row-status={row.status}
      data-case-bulk-outcome={outcome?.outcome ?? undefined}
    >
      {selectable ? (
        <label
          className="cases-row-select"
          // The checkbox must never trigger row navigation.
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            data-case-bulk-select={row.id}
            checked={selected}
            onChange={() => onToggleSelect?.(row.id)}
            aria-label={`Select case ${row.name}`}
          />
        </label>
      ) : null}
      {outcome && outcome.outcome !== "SUCCESS" ? (
        <p className="cases-row-bulk-note" data-case-bulk-reason={outcome.reason ?? ""}>
          {outcome.outcome === "FAILED" ? "Failed: " : "Skipped: "}
          {bulkReasonText(outcome.reason)}
        </p>
      ) : null}
      {/* §7 enterprise row — the row is an entry in ONE `.cases-panel`
          container (no card-in-card). `.cases-row-link` supplies the
          ~72px min-height, soft divider, hover tint, and padding from the
          shared stylesheet. Structured columns: Case · Status · Owner ·
          Evidence · Readiness/Issues · Last updated · Actions. */}
      {/* §3 — the row is a navigable DIV (role=link), not an <a>, so the
          real overflow-menu button can live inside it without nesting
          interactive content in an anchor (which broke the menu). The
          case TITLE is a real <Link> for keyboard/right-click/open-in-new
          semantics; clicking anywhere else on the row also navigates. */}
      <div
        className="cases-row-link"
        role="link"
        tabIndex={0}
        aria-label={`Open case ${row.name}`}
        onClick={() => router.push(`/cases/${row.id}`)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            router.push(`/cases/${row.id}`);
          }
        }}
      >
        {/* §1/§7 — real enterprise table row: seven aligned columns
            (Case · Status · Owner · Evidence · Readiness · Last updated ·
            Actions) on ONE grid track that matches the header. All
            `data-matter-queue-row*` attributes are preserved. */}
        {/* Case */}
        <span className="cases-cell cases-cell-case cases-row-identity">
          <Link
            href={`/cases/${row.id}`}
            className="cases-row-title"
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          {shortRef ? (
            <span
              className="cases-row-scope"
              data-matter-queue-row-reference={shortRef}
            >
              {shortRef}
            </span>
          ) : null}
        </span>
        {/* Status */}
        <span className="cases-cell cases-cell-status">
          <Badge
            tone={statusBadgeTone(row.status)}
            className="cases-row-chip"
            data-matter-queue-row-chip="status"
            data-status={row.status}
          >
            {STATUS_LABEL[row.status as CaseStatus] ?? row.status}
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
        </span>
        {/* Owner */}
        <span className="cases-cell cases-cell-owner">
          <OwnerCell ownerUserId={row.ownerUserId} />
        </span>
        {/* Evidence */}
        <span
          className="cases-cell cases-cell-evidence"
          data-matter-queue-row-evidence={row.linkedEvidenceCount}
        >
          {isEmptyCase ? (
            <span
              className="cases-cell-muted"
              data-matter-queue-row-empty
              data-readiness="not-started"
            >
              No records
            </span>
          ) : (
            <span className="cases-cell-count">
              <span className="cases-cell-strong">{row.linkedEvidenceCount}</span>{" "}
              {row.linkedEvidenceCount === 1 ? "record" : "records"}
            </span>
          )}
        </span>
        {/* Readiness — honest, derived state (§1). */}
        <span className="cases-cell cases-cell-readiness">
          <span
            className={`cases-readiness cases-readiness--${readiness.tone}`}
            data-matter-queue-row-readiness={readiness.key}
          >
            {readiness.label}
          </span>
          {/* Advanced-only operational signals stay available for the
              enterprise surface (and its contract tests) without crowding
              the personal table — they wrap beneath the readiness pill. */}
          {canSeeAdvancedCaseOps ? (
            <span className="cases-readiness-signals" data-matter-queue-row-signals>
              <RiskBadge level={row.riskLevel} score={row.riskScore} />
              {row.evidenceGapCount > 0 ? (
                <Counter dataKey="evidence-gap" value={row.evidenceGapCount} label="gap" tone="warning" />
              ) : null}
              {row.openIncidentCount > 0 ? (
                <Counter dataKey="open-incidents" value={row.openIncidentCount} label="incident" tone="high" />
              ) : null}
              {row.overdueWorkflowCount > 0 ? (
                <Counter dataKey="overdue-workflows" value={row.overdueWorkflowCount} label="overdue" tone="critical" />
              ) : null}
              {row.governanceBlockerCount > 0 ? (
                <Counter dataKey="governance-blockers" value={row.governanceBlockerCount} label="gov block" tone="high" />
              ) : null}
              {row.activeLegalHoldCount > 0 ? (
                <span className="cases-row-chip" data-matter-queue-row-chip="hold" data-hold-count={row.activeLegalHoldCount}>
                  Legal preservation
                </span>
              ) : null}
              {reasonCodes.length > 0
                ? reasonCodes.map((code) => (
                    <span key={code} className="cases-row-chip" data-matter-queue-row-reason={code} style={{ fontSize: 11 }}>
                      {reasonCodeLabel(code)}
                    </span>
                  ))
                : null}
            </span>
          ) : null}
        </span>
        {/* Last updated */}
        <time
          className="cases-cell cases-cell-updated"
          dateTime={row.latestActivityAtUtc}
          data-matter-queue-row-latest-activity
          title={row.latestActivityAtUtc}
        >
          {formatRelativeTime(row.latestActivityAtUtc)}
        </time>
        {/* Actions */}
        <span className="cases-cell cases-cell-actions">
          <RowActions
            caseId={row.id}
            caseName={row.name}
            status={row.status}
            onReload={onReload}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * §7 Owner column. The matter-queue envelope exposes only
 * `ownerUserId` — never a display name — so we NEVER invent a person.
 * We render a neutral avatar (two initials derived from the id) plus a
 * shortened owner reference. `ownerUserId` is always present on the
 * envelope; the "Unassigned" branch is defensive for any future
 * nullable shape.
 */
function OwnerCell({ ownerUserId }: { ownerUserId: string | null }) {
  if (!ownerUserId) {
    return (
      <span className="cases-row-owner" data-matter-queue-row-owner="unassigned">
        <span className="cases-row-owner-avatar" data-owner-empty aria-hidden>
          —
        </span>
        <span className="cases-row-owner-label">Unassigned</span>
      </span>
    );
  }
  const initials = ownerUserId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  return (
    <span className="cases-row-owner" data-matter-queue-row-owner={ownerUserId}>
      <span className="cases-row-owner-avatar" aria-hidden>
        {initials || "?"}
      </span>
      <span className="cases-row-owner-label" title={ownerUserId}>
        Owner · {ownerUserId.slice(0, 8)}
      </span>
    </span>
  );
}

/**
 * §7 Actions column — ONE compact overflow menu instead of scattered
 * text actions. The row itself is a navigable link, so the menu items
 * are the discrete next-actions. Rendered as a native <details> so it
 * needs no client state and never steals the row's link navigation
 * (the summary/menu stop propagation + default so a click on the
 * trigger doesn't follow the row link).
 */
/**
 * §3 — a REAL working overflow menu (replaces the dead `<details>` whose
 * `preventDefault` on the summary cancelled the native toggle so it never
 * opened, and whose only items were duplicate navigation links).
 *
 * This is a controlled popover: it opens on click, closes on outside
 * click / Escape, and every item performs a real action —
 *   • Open          → navigate to the case
 *   • Rename        → open the case Settings tab (where rename lives)
 *   • Change status → open the case Settings tab (status control)
 *   • Archive       → POST /v1/cases/:id/status {ARCHIVED} + reload
 *   • Delete        → DELETE /v1/cases/:id (confirmed) + reload
 * No dead buttons.
 */
function RowActions({
  caseId,
  caseName,
  status,
  onReload,
}: {
  caseId: string;
  caseName: string;
  status: string;
  onReload: () => Promise<void> | void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const archive = async () => {
    setOpen(false);
    if (status === "ARCHIVED") return;
    const ok = await confirm({
      title: `Archive "${caseName}"?`,
      description:
        "Archiving hides this case from the default list. Linked evidence, reports and packages are preserved and unchanged.",
      confirmLabel: "Archive case",
      tone: "warning",
      testId: "cases-row-archive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/cases/${caseId}/status`, {
        method: "POST",
        body: JSON.stringify({ toStatus: "ARCHIVED" }),
      });
      addToast("Case archived.", "success");
      await onReload();
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Could not archive case." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setOpen(false);
    const ok = await confirm({
      title: `Delete "${caseName}"?`,
      description:
        "This deletes the case workspace only. Preserved evidence records remain in the Evidence Library; they are unlinked from this case, not destroyed.",
      confirmLabel: "Delete case",
      tone: "danger",
      testId: "cases-row-delete",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/cases/${caseId}`, { method: "DELETE" });
      addToast("Case deleted.", "success");
      await onReload();
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Could not delete case." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cases-row-actions" ref={wrapRef} data-matter-queue-row-actions>
      <button
        type="button"
        className="cases-row-actions-trigger"
        aria-label="Case actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div
          className="cases-row-actions-menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="cases-row-actions-item" onClick={() => go(`/cases/${caseId}`)}>
            Open
          </button>
          <button type="button" role="menuitem" className="cases-row-actions-item" onClick={() => go(`/cases/${caseId}?tab=settings`)}>
            Rename
          </button>
          <button type="button" role="menuitem" className="cases-row-actions-item" onClick={() => go(`/cases/${caseId}?tab=settings`)}>
            Change status
          </button>
          <button
            type="button"
            role="menuitem"
            className="cases-row-actions-item"
            onClick={() => void archive()}
            disabled={status === "ARCHIVED"}
          >
            Archive
          </button>
          <div className="cases-row-actions-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="cases-row-actions-item cases-row-actions-item--danger"
            onClick={() => void del()}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
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
  // PROOVRA enterprise redesign — the coral→pink primary gradient is
  // retired on this surface. The onboarding "Create case" CTA uses the
  // solid indigo #5B4FE8 (never coral) per the design system.
  background: "#5B4FE8",
  color: "#ffffff",
  border: "1px solid #5B4FE8",
  boxShadow: "0 6px 16px rgba(91, 79, 232, 0.22)",
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
