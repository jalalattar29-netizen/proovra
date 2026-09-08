/**
 * PROOVRA Phase 6 — Teams overview page.
 *
 * Route: `/collaboration-teams` (sidebar label "Teams")
 *
 * Lists every Collaboration Team the active user can see inside the
 * active workspace. Personal users see this page (constitutional
 * rule 7); organization users see it too. No Organization required.
 *
 * Page wraps in <PageRouteGate routeId="workspace.collaboration_teams">.
 * The gate's `requiredActiveSpace: "PERSONAL_OR_ORG"` plus the
 * personal-first rescue mean a fresh personal user lands here without
 * any "Activate an organization" wall.
 *
 * VISUAL redesign — migrated onto the neutral `app-*` internal-product
 * design system (Home/Cases visual language): `.app-page-header`,
 * the Cases filter bar (`.cases-toolbar`/`.cases-segments`/`.cases-search-
 * field`), `.app-table-surface` + `.app-table[data-responsive]`,
 * `AppListbox`, `AppStatusBadge`, `.app-empty`. No data-fetching,
 * permission, billing-limit, route or behaviour changes — every
 * data-testid / data-* and the plan-capacity logic are preserved
 * verbatim. Client-side search / filter / sort operate purely on the
 * ALREADY-FETCHED teams array (no new API calls).
 */

"use client";

import Link from "next/link";
// The canonical Members & Access path. Imported rather than written inline so
// the route has exactly one definition — the locator is what makes renaming it
// a one-file change if that ever becomes worth doing.
import { WORKSPACE_PEOPLE_PATH } from "../../../lib/navigation/workspacePeopleLocator";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import {
  PageShell,
  useToast,
} from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { AppListbox } from "../../../components/app-primitives/AppListbox";
import { AppStatusBadge } from "../../../components/app-primitives/AppStatusBadge";
import { AppStatusText } from "../../../components/app-primitives/AppStatusText";
import { PlanLimitBadge } from "../../../components/billing/PlanLimitBadge";
import { ApiError } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import {
  TEAMS_PLAN_LOCKED_COPY,
  formatTeamLimitReachedMessage,
} from "../../../lib/feedback/team-entitlement-copy";
import { formatUserDate } from "../../../lib/date";
import {
  createTeam,
  getCollaborationEntitlement,
  listTeams,
  type CollaborationEntitlement,
  type CollaborationTeamSummary,
  type CollaborationWorkspaceRollup,
} from "../../../lib/api/collaboration-teams";
import { useActiveSpace, usePlatformContext } from "../../../lib/platform-context";
import type { WorkspacePlan } from "../../../lib/platform-context/types";
import {
  COLLABORATION_TEAM_TYPES,
  type CollaborationTeamType,
  type CollaborationTeamStatus,
} from "@proovra/shared";

export default function TeamsOverviewPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_teams">
      <TeamsOverview />
    </PageRouteGate>
  );
}

// =============================================================================
// Client-side controls — search / filter / sort operate on the already-loaded
// teams array in memory. No new API calls are made.
// =============================================================================

type StatusFilter = "ALL" | CollaborationTeamStatus;
type TypeFilter = "ALL" | CollaborationTeamType;
type SortKey = "ACTIVITY_DESC" | "ACTIVITY_ASC" | "NAME_ASC" | "MEMBERS_DESC";

const TEAM_TYPE_LABELS: Record<CollaborationTeamType, string> = {
  GENERAL: "General",
  INVESTIGATION: "Investigation",
  LEGAL: "Legal",
  REVIEW: "Review",
  COMPLIANCE: "Compliance",
};

// Entitlement Alignment (2026-07-14) — honest plan-locked copy. FREE and
// PAYG include zero Teams; the shared sentence is the single source for
// the landing, the empty state, and the disabled affordances.
const PLAN_LOCKED_COPY = TEAMS_PLAN_LOCKED_COPY;

function TeamsOverview() {
  const router = useRouter();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );
  const [teams, setTeams] = useState<ReadonlyArray<CollaborationTeamSummary>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /**
   * WCR-06 — THE commercial projection, and the only place this page learns a
   * limit or an affordance from.
   *
   * It read `useWorkspaceLimits()`, which projects raw `PLAN_CAPABILITIES`
   * integers with no contract, no seat state, no lifecycle and no restriction
   * reason — so an Enterprise workspace was told it may have 1000 groups
   * whatever its contract said. `/v1/collaboration-teams/entitlement` had been
   * built for exactly this and had zero consumers.
   *
   * `null` means UNKNOWN (loading or degraded). The page renders no capacity
   * claim at all in that state rather than substituting a number.
   */
  const [entitlement, setEntitlement] = useState<CollaborationEntitlement | null>(
    null,
  );
  /**
   * WCR-6A — participation view vs workspace governance view.
   *
   * The list answers "which groups am I in?", which is right for doing the
   * work and wrong for governing it: a workspace OWNER could not enumerate the
   * groups in their own tenant. The server grants `ALL` only to an actor
   * holding the workspace governance capability and degrades silently
   * otherwise, so this is a request, not a claim.
   */
  const [scope, setScope] = useState<"PARTICIPATING" | "ALL">("PARTICIPATING");
  const [canGovern, setCanGovern] = useState(false);
  /** Applied once — the governor default must not fight a later choice. */
  const governorDefaultApplied = useRef(false);
  const [grantedScope, setGrantedScope] =
    useState<"PARTICIPATING" | "ALL">("PARTICIPATING");
  /**
   * The workspace-wide cross-group position. Server-sent, and only for a
   * governor — the client never derives it from `teams`, because `teams` is a
   * PAGE and a supervision number computed from a page is wrong the moment
   * there is a second one.
   */
  const [rollup, setRollup] =
    useState<CollaborationWorkspaceRollup | null>(null);

  // Client-side control state (no new fetches — filters/sorts operate on the
  // already-fetched `teams` array).
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("ACTIVITY_DESC");

  /**
   * WCR-05 / WCR-06 — EVERY NUMBER AND EVERY AFFORDANCE BELOW IS THE SERVER'S.
   *
   * The page previously derived all of this itself, from two wrong inputs:
   *
   *   * the CAP came from `useWorkspaceLimits()`, a projection of raw catalog
   *     integers with no contract, no lifecycle and no restriction reason, so
   *     an Enterprise workspace was told it may have 1000 groups regardless of
   *     what its contract actually said;
   *   * the USAGE came from `totalActive`, which counts the groups the VIEWER
   *     belongs to. On a PRO workspace holding both of its two groups, a member
   *     of one saw "1 of 2", got an enabled Create button, and met a 409.
   *
   * `canCreateCollaborationTeam` is computed server-side by the same predicate
   * `assertCanCreateCollaborationTeam` enforces, so the button and the route
   * cannot disagree. `null` still means UNKNOWN and the page shows no capacity
   * claim at all rather than a fabricated one.
   */
  const planForCapacity: WorkspacePlan | null = useActiveSpace()?.plan ?? null;
  // WCR-09 — the tenant this page is bound to. Every loader below depends on
  // it, so a workspace switch re-issues the fetch instead of leaving the
  // previous tenant painted.
  const { activeWorkspaceId } = usePlatformContext();
  const planContextReady = entitlement !== null;
  const ownedTeamCount = entitlement?.collaborationTeams.used ?? 0;
  const maxTeams = entitlement?.collaborationTeams.limit ?? 0;
  const planLocked = planContextReady && !entitlement!.featureIncluded;
  const atCapacity =
    planContextReady && !planLocked && !entitlement!.canCreateCollaborationTeam;
  /**
   * WCR-12 — a restriction is not a lock.
   *
   * A workspace that has been downgraded, or whose payment has lapsed, keeps
   * its existing groups and keeps them READABLE. What it loses is growth. The
   * two states render differently and must not be collapsed: "your plan does
   * not include this" and "you already have as many as your plan sells" send a
   * customer to different places.
   */
  const restricted =
    planContextReady && !entitlement!.mutationsAllowed;
  const createDisabledReason: string | null = !planContextReady
    ? null
    : planLocked
      ? PLAN_LOCKED_COPY
      : restricted
        ? "This workspace's billing needs attention before new Teams can be created."
        : atCapacity
          ? `Your ${planForCapacity} plan allows up to ${maxTeams} active Team${
              maxTeams === 1 ? "" : "s"
            }. Upgrade to add more.`
          : null;

  /**
   * SEARCH IS A FETCH NOW.
   *
   * The page used to filter an already-loaded array, and the array was whatever
   * fitted under a server-side cap of 100 — so on a workspace with more groups
   * than that, typing a name that existed found nothing and the truncation was
   * invisible. `search` and the archived filter go to the database; the type
   * filter and the sort stay local because they operate on the page in hand.
   */
  const refresh = useCallback(
    async (
      opts?: { cursor?: string | null; append?: boolean; isStale?: () => boolean },
    ) => {
    setLoading(true);
    setError(null);
    /**
     * WCR-09 — the tenant this call is FOR, captured before any await.
     *
     * Comparing it afterwards is what makes the guard real rather than
     * decorative: a switch that happens mid-flight changes the request header
     * for the NEXT call but cannot un-send this one, so the response has to be
     * discarded on arrival by the id it was issued under.
     */
    const issuedFor = activeWorkspaceId;
    try {
      const [page, projection] = await Promise.all([
        listTeams({
          search,
          includeArchived: statusFilter === "ARCHIVED" || statusFilter === "ALL",
          cursor: opts?.cursor ?? null,
          scope,
        }),
        // The projection is workspace-wide and does not change between pages,
        // so it is only fetched for a fresh load, not for "load more".
        opts?.append
          ? Promise.resolve(null)
          : getCollaborationEntitlement().catch(() => null),
      ]);
      // WCR-09 — a response for the PREVIOUS workspace must never paint under
      // the newly selected one. Checked after every await, not just the first.
      if (opts?.isStale?.() || issuedFor !== activeWorkspaceId) return;
      setNextCursor(page.nextCursor);
      setCanGovern(page.canGovernWorkspace);
      /*
        A GOVERNOR DEFAULTS TO THE WORKSPACE THEY GOVERN (§C).

        The page opened on the participation view for everyone, so an admin
        landed on "my teams" and had to discover a toggle to see the workspace
        they administer. The server decides who MAY see it; the product should
        not also make the operator ask. Applied once, on the first response
        that reports the capability — never re-forced, so choosing "My teams"
        from the filter afterwards sticks.
      */
      if (page.canGovernWorkspace && !governorDefaultApplied.current) {
        governorDefaultApplied.current = true;
        if (scope !== "ALL") setScope("ALL");
      }
      setGrantedScope(page.scope);
      // Workspace-wide and identical for every page, so "load more" must not
      // clear it — and a participation-scoped response legitimately carries
      // null, which is the value that hides the band.
      if (!opts?.append) setRollup(page.rollup ?? null);
      if (projection) setEntitlement(projection);
      setTeams((prev) =>
        opts?.append ? [...prev, ...page.teams] : page.teams,
      );
    } catch (err) {
      if (opts?.isStale?.()) return;
      /*
       * SAFE FEEDBACK, NOT THE BACKEND SENTENCE.
       *
       * This branch used to render `err.message` — the raw string the API
       * happened to send — which is the one thing the platform contract says
       * never reaches a person. The canonical mapper answers every shape,
       * including this one, and keeps the request id off the sentence and on
       * the copyable support reference.
       */
      const safe = toSafeUserError(err, { message: "Couldn't load Teams. Try again." });
      setError({ message: safe.message, requestId: safe.supportReference });
    } finally {
      if (!opts?.isStale?.()) setLoading(false);
    }
    },
    // WCR-09 — KEYED ON THE ACTIVE WORKSPACE.
    //
    // The effect below depended on [search, statusFilter] only, so switching
    // workspace re-ingested the envelope, changed the request header, and left
    // the PREVIOUS tenant's groups on screen until something else happened to
    // re-fetch. No cross-tenant data was ever served — the server refuses —
    // but the display was another tenant's, which on an evidence platform is a
    // trust failure whether or not a byte leaked.
    [search, statusFilter, scope, activeWorkspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    // Debounced: a keystroke is not a request.
    const handle = setTimeout(() => {
      void refresh({ isStale: () => cancelled });
    }, search ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [refresh, search]);

  /**
   * WCR-09 — clear the previous tenant's rows IMMEDIATELY on a switch.
   *
   * Waiting for the new fetch to resolve would leave workspace A's group names
   * under workspace B's header for the duration of a network round trip. An
   * empty list with a loading state is honest; the wrong tenant's list is not.
   */
  useEffect(() => {
    setTeams([]);
    setEntitlement(null);
    setNextCursor(null);
    setScope("PARTICIPATING");
    setCanGovern(false);
  }, [activeWorkspaceId]);

  // Derived, in-memory view of the fetched teams. Never triggers a fetch.
  const visibleTeams = useMemo(() => {
    const q = search.trim().toLowerCase();
    // `search` was applied by the database; re-applying it here would only
    // narrow a page the server already narrowed. Status and type still filter
    // the page in hand, and the sort orders it.
    void q;
    const filtered = teams.filter((t) => {
      if (statusFilter !== "ALL" && t.status !== statusFilter) return false;
      if (typeFilter !== "ALL" && t.teamType !== typeFilter) return false;
      return true;
    });
    const activityMs = (t: CollaborationTeamSummary) =>
      t.lastActivityAt ? new Date(t.lastActivityAt).getTime() : 0;
    const sorted = [...filtered];
    switch (sortKey) {
      case "ACTIVITY_ASC":
        sorted.sort((a, b) => activityMs(a) - activityMs(b));
        break;
      case "NAME_ASC":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "MEMBERS_DESC":
        sorted.sort((a, b) => b.memberCount - a.memberCount);
        break;
      case "ACTIVITY_DESC":
      default:
        sorted.sort((a, b) => activityMs(b) - activityMs(a));
        break;
    }
    return sorted;
  }, [teams, search, statusFilter, typeFilter, sortKey]);

  const controlsActive =
    search.trim().length > 0 ||
    statusFilter !== "ALL" ||
    typeFilter !== "ALL";

  const header = (
    <div className="app-page-header" data-testid="collaboration-teams-header">
      <div className="app-page-header__lead">
        <span className="app-page-header__icon" aria-hidden="true">
          <TeamsGlyph />
        </span>
        <div className="app-page-header__text">
          <h1 className="app-page-header__title">Collaboration Teams</h1>
          <p className="app-page-header__subtitle">
            {/*
              The counterpart sentence to Members &amp; Access. That surface
              decides WHO can reach this workspace; this one decides HOW those
              members work together. Saying "members who already have access"
              rather than "people" is the whole distinction in three words:
              a Collaboration Team groups existing membership, it never grants
              it.
            */}
            Organise workspace members into operational teams for cases,
            evidence, assignments, reviews and workload. Teams group members who
            already have access — they do not grant it.{" "}
            <Link
              href={WORKSPACE_PEOPLE_PATH}
              data-testid="teams-to-members-and-access"
            >
              Manage members &amp; access
            </Link>
          </p>
        </div>
      </div>
      <div className="app-page-header__actions">
        {planLocked ? (
          // Plan-locked landing: NO Create button at all — a fillable /
          // clickable create affordance that is known to 402 would be
          // dishonest. Only the honest state + upgrade CTA render.
          <Link
            href="/billing"
            className="app-primary-action"
            data-testid="teams-plan-locked-upgrade-cta"
            aria-label={`Upgrade plan — ${PLAN_LOCKED_COPY}`}
            title={PLAN_LOCKED_COPY}
          >
            Upgrade plan
          </Link>
        ) : (
          <>
            {planForCapacity !== null && !loading && !error ? (
              <PlanLimitBadge
                kind="TEAMS_USED"
                current={ownedTeamCount}
                max={maxTeams}
                planLabel={planForCapacity}
              />
            ) : null}
            {atCapacity && planForCapacity !== null ? (
              <UpgradeCTA
                ownedTeamCount={ownedTeamCount}
                maxTeams={maxTeams}
                plan={planForCapacity}
              />
            ) : null}
            <button
              type="button"
              className="app-primary-action"
              data-testid="create-team-button"
              onClick={() => setCreateOpen(true)}
              disabled={atCapacity}
              aria-disabled={atCapacity || undefined}
              aria-label={
                createDisabledReason
                  ? `Create Team — ${createDisabledReason}`
                  : "Create Team"
              }
              title={createDisabledReason ?? undefined}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>Create team</span>
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <PageShell data-testid="collaboration-teams-overview" header={header}>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState
          message={error.message}
          requestId={error.requestId}
          onRetry={() => void refresh()}
        />
      ) : teams.length === 0 && planLocked ? (
        /*
          THE ONLY STATE THAT MAY HIDE THE CONTROLS.
          A plan that includes zero Teams has nothing to filter, so the
          honest landing is the upgrade one with no affordances at all.
        */
        <TeamsEmptyState
          onCreate={() => setCreateOpen(true)}
          requiresUpgrade
          plan={planForCapacity}
        />
      ) : (
        <>
          {planLocked ? <PlanRestrictedNotice /> : null}

          {/*
            CROSS-GROUP POSITION — the workspace, not the page.

            The supervision question is "where is the work, and what is in
            trouble?", and the table below could not answer it: its columns
            describe the rows currently loaded, so every number moved when the
            operator paged or searched. These four come from the server
            computed over the whole workspace and hold still.

            ATTENTION is deliberately not `overdue + high priority`. An urgent
            item that is also late is one problem, and summing the columns
            would report it twice — inflating the only number anyone triages
            on. The server counts the distinct rows.
          */}
          {rollup ? (
            <ul
              className="app-grid-kpis"
              data-testid="teams-rollup"
              style={{ marginBottom: "0.75rem" }}
            >
              {/*
                THE SAME CARD FAMILY AS NOTIFICATIONS AND MEMBERS (§21) —
                `.app-metric-card`: near-white surface, 3px semantic rail, the
                colour in the number rather than in the background.

                TONES ARE THE CARD'S SUBJECT, NOT ITS CURRENT VALUE. An earlier
                pass made them conditional, so a healthy workspace showed four
                grey cards and the strip lost the ranking colour exists to
                give. What a card is ABOUT does not change when its number
                reaches zero: unassigned work is an amber KIND of number at 0
                and at 40.

                Attention keeps a real severity escalation, which is the one
                place the value legitimately changes the tone: it reads as the
                canonical `--orange-500` "High" orange normally and escalates
                to red only when something is actually LATE. That is a
                severity step, not a zero check.
              */}
              <li>
                <div className="app-metric-card" data-app-metric-tone="info">
                  <div className="app-metric-card__value">{rollup.work.open}</div>
                  <div className="app-metric-card__label">Open work</div>
                  <div className="app-metric-card__meta">
                    across {rollup.groups.withOpenWork} of {rollup.groups.active}{" "}
                    {rollup.groups.active === 1 ? "Team" : "Teams"}
                  </div>
                </div>
              </li>
              {/*
                Amber, not red: unowned work needs picking up, it is not yet a
                failure. Red is reserved for the attention card beside it,
                which counts work that is already late or already urgent. And
                the meta line says what "unassigned" actually means here — a
                group holding work is not a person doing it.
              */}
              <li>
                <div className="app-metric-card" data-app-metric-tone="warning">
                  <div className="app-metric-card__value">
                    {rollup.work.unassigned}
                  </div>
                  <div className="app-metric-card__label">Unassigned</div>
                  <div className="app-metric-card__meta">
                    held by a Team, not by a person
                  </div>
                </div>
              </li>
              <li>
                <div
                  className="app-metric-card"
                  data-app-metric-tone={
                    rollup.work.overdue > 0 ? "danger" : "warning"
                  }
                >
                  <div className="app-metric-card__value">
                    {rollup.work.attention}
                  </div>
                  <div className="app-metric-card__label">Needs attention</div>
                  <div className="app-metric-card__meta">
                    {rollup.work.overdue} overdue · {rollup.work.highPriority} high
                    priority
                  </div>
                </div>
              </li>
              <li>
                <div className="app-metric-card" data-app-metric-tone="success">
                  <div className="app-metric-card__value">
                    {rollup.workload.people}
                  </div>
                  <div className="app-metric-card__label">
                    People carrying work
                  </div>
                  <div className="app-metric-card__meta">
                    {rollup.workload.busiest
                      ? `heaviest load ${rollup.workload.busiest.open} open`
                      : "nothing assigned to an individual"}
                  </div>
                </div>
              </li>
            </ul>
          ) : null}
          {grantedScope === "ALL" ? (
            <p
              className="app-panel__hint"
              data-testid="teams-governance-notice"
              style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}
            >
              Showing every Team in this workspace. You can see them because you
              administer this workspace; you are not a member of the ones
              without a role below, and opening one does not join it.
            </p>
          ) : null}
          <TeamsToolbar
            search={search}
            onSearch={setSearch}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            scope={canGovern ? scope : null}
            onScope={canGovern ? setScope : undefined}
            typeFilter={typeFilter}
            onTypeFilter={setTypeFilter}
            sortKey={sortKey}
            onSort={setSortKey}
          />
          {visibleTeams.length === 0 ? (
            /*
              THE PAGE MUST NEVER GO BLANK, AND MUST NEVER LIE (§9, §10).

              This branch used to be unreachable in the case that mattered:
              when the SERVER returned zero rows the whole block above —
              toolbar included — was replaced by "No teams yet". So archiving
              the last active team could leave an operator on a page that said
              no team had ever existed, with the status filter that would have
              revealed the archived one no longer on screen.

              The toolbar now always renders (except under a plan that
              includes zero Teams, which has nothing to filter), so the way out
              is always reachable, and the empty state below distinguishes
              "nothing matches what you asked for" from "nothing exists".
            */
            <NoMatchesState onReset={() => {
              setSearch("");
              setStatusFilter("ALL");
              setTypeFilter("ALL");
            }} controlsActive={controlsActive} onCreate={() => setCreateOpen(true)} />
          ) : (
            <>
              <TeamsTable teams={visibleTeams} />
              {nextCursor ? (
                <div className="app-table-footer">
                  <button
                    type="button"
                    className="app-secondary-action"
                    disabled={loading}
                    onClick={() => void refresh({ cursor: nextCursor, append: true })}
                    data-testid="teams-load-more"
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      {createOpen ? (
        <CreateTeamModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            addToast("Team created.", "success");
            router.push(`/collaboration-teams/${id}`);
          }}
        />
      ) : null}
    </PageShell>
  );
}

// =============================================================================
// Controls toolbar
// =============================================================================

function TeamsToolbar({
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  scope = null,
  onScope,
  typeFilter,
  onTypeFilter,
  sortKey,
  onSort,
}: {
  search: string;
  onSearch: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (v: StatusFilter) => void;
  /** Governors only. `null` hides the control entirely. */
  scope?: "PARTICIPATING" | "ALL" | null;
  onScope?: (v: "PARTICIPATING" | "ALL") => void;
  typeFilter: TypeFilter;
  onTypeFilter: (v: TypeFilter) => void;
  sortKey: SortKey;
  onSort: (v: SortKey) => void;
}) {
  const statusOptions = [
    { value: "ALL", label: "All statuses" },
    { value: "ACTIVE", label: "Active", markerColor: "#45B27D" },
    { value: "ARCHIVED", label: "Archived", markerColor: "#94A3B8" },
  ] as const;

  const typeOptions: Array<{ value: TypeFilter; label: string }> = [
    { value: "ALL", label: "All types" },
    ...COLLABORATION_TEAM_TYPES.map((t) => ({
      value: t as TypeFilter,
      label: TEAM_TYPE_LABELS[t],
    })),
  ];

  const sortOptions = [
    { value: "ACTIVITY_DESC", label: "Last activity (newest)" },
    { value: "ACTIVITY_ASC", label: "Last activity (oldest)" },
    { value: "NAME_ASC", label: "Name (A–Z)" },
    { value: "MEMBERS_DESC", label: "Most members" },
  ] as const;

  return (
    // §1 — reuse the EXACT Cases filter-bar styling: the `.cases-toolbar`
    // row, the translucent `.cases-segments` control tray (background /
    // border / radius / height / spacing / hover / active / typography /
    // transitions / focus all inherited from the approved Cases page), and
    // the `.cases-search-field` + `.cases-filter-search` search. No new /
    // duplicate styles are introduced.
    <div className="cases-toolbar" data-testid="teams-toolbar">
      {/*
        A FILTER GROUP, not a segmented chip tray — the same correction the
        Work tab needed. `.cases-segments` caps itself at `max-content` and
        scrolls internally, which squeezes real dropdowns.
      */}
      <div
        className="app-filter-group"
        role="group"
        aria-label="Filter teams"
      >
        {/*
          WHICH TEAMS — a normal filter, not a segmented security toggle.

          This was a prominent two-button tray above the toolbar reading
          "Teams I'm in" / "All Teams in this workspace", which asked the
          operator to understand a view-scope decision the product can make for
          them: a governor's default is the workspace they govern. It survives
          as an ordinary filter beside status and type because narrowing to
          one's own teams is a genuine daily need — it is simply not a headline
          control, and it appears only for callers the SERVER has already
          authorised for the workspace view.
        */}
        {scope && onScope ? (
          <div style={{ width: 190 }} data-testid="teams-scope-filter">
            <AppListbox<"PARTICIPATING" | "ALL">
              value={scope}
              options={[
                { value: "ALL", label: "All workspace teams" },
                { value: "PARTICIPATING", label: "My teams" },
              ]}
              onChange={onScope}
              ariaLabel="Which teams to show"
            />
          </div>
        ) : null}
        <div style={{ width: 168 }}>
          <AppListbox<StatusFilter>
            value={statusFilter}
            options={statusOptions.map((o) => ({ ...o }))}
            onChange={onStatusFilter}
            ariaLabel="Filter by status"
          />
        </div>
        <div style={{ width: 180 }}>
          <AppListbox<TypeFilter>
            value={typeFilter}
            options={typeOptions}
            onChange={onTypeFilter}
            ariaLabel="Filter by team type"
          />
        </div>
        <div style={{ width: 210 }}>
          <AppListbox<SortKey>
            value={sortKey}
            options={sortOptions.map((o) => ({ ...o }))}
            onChange={onSort}
            ariaLabel="Sort teams"
          />
        </div>
      </div>

      <div className="cases-toolbar-right">
        <div className="cases-search-field">
          <span className="cases-search-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            className="cases-filter-search"
            placeholder="Search teams…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Search teams by name or description"
            data-testid="teams-search-input"
          />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Teams table
// =============================================================================

function TeamsTable({
  teams,
}: {
  teams: ReadonlyArray<CollaborationTeamSummary>;
}) {
  return (
    <div className="app-table-surface" data-testid="teams-list">
      <table className="app-table" data-responsive>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Type</th>
            <th scope="col">Members</th>
            <th scope="col">Open work</th>
            <th scope="col">Overdue</th>
            <th scope="col">High priority</th>
            <th scope="col">Your role</th>
            <th scope="col">Last activity</th>
            <th scope="col" style={{ textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <TeamRow key={t.id} team={t} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamRow({ team }: { team: CollaborationTeamSummary }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const lastActivity = useMemo(() => {
    if (!team.lastActivityAt) return "No activity yet";
    try {
      return formatUserDate(team.lastActivityAt);
    } catch {
      return "Recent";
    }
  }, [team.lastActivityAt]);

  const href = `/collaboration-teams/${team.id}`;

  return (
    <tr data-testid={`team-card-${team.id}`}>
      <td data-label="Team">
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <Link
            href={href}
            className="app-table__primary"
            data-testid={`team-link-${team.id}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            {team.name}
          </Link>
          {team.description ? (
            <span
              className="app-table__muted"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {team.description}
            </span>
          ) : (
            <span className="app-table__muted">No description</span>
          )}
        </div>
      </td>
      {/*
        TYPE, ROLE AND THE THREE COUNTS ARE TEXT NOW (§3, §20).

        Seven of this row's nine cells rendered a filled capsule, so a list of
        groups read as a wall of chips and nothing in it was primary. The
        SEMANTICS are unchanged — `AppStatusText` takes the same `AppTone`
        vocabulary, so red still means overdue and amber still means high
        priority — the capsule is simply gone, which is what an operational
        table is supposed to look like.
      */}
      <td data-label="Type">
        <AppStatusText tone="slate">{TEAM_TYPE_LABELS[team.teamType]}</AppStatusText>
      </td>
      <td data-label="Members">
        <strong style={{ color: "#172033", fontWeight: 650 }}>
          {team.memberCount}
        </strong>
      </td>
      {/*
        "Pending invites" counted RETIRED CollaborationTeamInvite rows — a
        writer that no longer exists, so the number is structurally zero for
        every workspace created since it was removed, and for older ones it
        counts group invitations while sitting in a column an operator reads as
        workspace invitations. A column that can only ever say "—" is not
        information; the space goes to the two numbers that tell a supervisor
        which group needs them.
      */}
      <td data-label="Open work">
        {team.openAssignmentCount > 0 ? (
          <AppStatusText tone="indigo">{team.openAssignmentCount}</AppStatusText>
        ) : (
          <span className="app-table__muted" aria-label="No open work">—</span>
        )}
      </td>
      <td data-label="Overdue">
        {team.overdueAssignmentCount > 0 ? (
          <AppStatusText tone="red">
            {team.overdueAssignmentCount}
          </AppStatusText>
        ) : (
          <span className="app-table__muted" aria-label="Nothing overdue">—</span>
        )}
      </td>
      <td data-label="High priority">
        {team.highPriorityAssignmentCount > 0 ? (
          <AppStatusText tone="amber">
            {team.highPriorityAssignmentCount}
          </AppStatusText>
        ) : (
          <span className="app-table__muted" aria-label="No high priority work">
            —
          </span>
        )}
      </td>
      <td data-label="Your role">
        {team.viewerRole ? (
          <AppStatusText tone="indigo">{team.viewerRole}</AppStatusText>
        ) : (
          <span className="app-table__muted">—</span>
        )}
      </td>
      <td data-label="Last activity">
        <span className="app-table__muted">{lastActivity}</span>
      </td>
      <td data-label="" style={{ textAlign: "right" }}>
        <div className="app-table__actions">
          <Link
            href={href}
            className="app-secondary-action"
            data-testid={`team-open-${team.id}`}
            style={{ height: 30, padding: "0 12px" }}
          >
            Open
          </Link>
          <RowOverflowMenu
            teamId={team.id}
            teamName={team.name}
            open={menuOpen}
            onOpenChange={setMenuOpen}
          />
        </div>
      </td>
    </tr>
  );
}

function RowOverflowMenu({
  teamId,
  teamName,
  open,
  onOpenChange,
}: {
  teamId: string;
  teamName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Enterprise context-menu behaviour: the popup renders through a portal
  // into <body> with `position: fixed` (reusing the shared
  // `.app-listbox__popup` surface) so it escapes the table's
  // `overflow: hidden` and every stacking context — it can never be clipped
  // or sit behind the following section. Anchored to the trigger's rect,
  // right-aligned, auto-flips near the viewport bottom, follows on
  // scroll/resize, and closes on outside click and Escape (focus returns
  // to the trigger).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{
    right: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const MENU_HEIGHT_ESTIMATE = 150;

  const position = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < MENU_HEIGHT_ESTIMATE && r.top > spaceBelow;
    setCoords(
      openUp
        ? { right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 6 }
        : { right: window.innerWidth - r.right, top: r.bottom + 6 },
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    position();
    const onReflow = () => position();
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, position, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="app-ghost-action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${teamName}`}
        data-testid={`team-actions-${teamId}`}
        onClick={() => onOpenChange(!open)}
        style={{ padding: "6px 8px" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={`Actions for ${teamName}`}
              data-testid={`team-actions-menu-${teamId}`}
              className="app-listbox__popup"
              style={{
                position: "fixed",
                right: coords.right,
                left: "auto",
                top: coords.top,
                bottom: coords.bottom,
                width: 200,
                zIndex: 100000,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <Link
                href={`/collaboration-teams/${teamId}`}
                role="menuitem"
                className="app-ghost-action"
                style={{ justifyContent: "flex-start", width: "100%" }}
              >
                Open team
              </Link>
              {/*
                "Invite member" → "Add people", `?tab=invites` → `?tab=members`.

                The Invites tab was deleted with the group invitation writer:
                `invites` is no longer in the detail page's `TABS`, so this
                link silently fell back to Overview — a menu item that named an
                action the product no longer has, landing somewhere else
                without saying so.

                A group does not invite anyone. It is assembled from people who
                already hold workspace access, so the honest action is "Add
                people" and the honest destination is the Members tab, which is
                where someone is actually added (and which now carries the
                handoff to the canonical workspace invitation for anyone who is
                not in the workspace yet).
              */}
              <Link
                href={`/collaboration-teams/${teamId}?tab=members`}
                role="menuitem"
                className="app-ghost-action"
                style={{ justifyContent: "flex-start", width: "100%" }}
              >
                Add people
              </Link>
              <Link
                href={`/collaboration-teams/${teamId}?tab=settings`}
                role="menuitem"
                className="app-ghost-action"
                style={{ justifyContent: "flex-start", width: "100%" }}
              >
                Settings
              </Link>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// =============================================================================
// Plan capacity badge + Upgrade CTA — Phase 10 UX surface.
//
// Mirrors the badge pattern used on /workspaces: a small inline pill that
// reports current owned-team capacity against the plan limit. Counts come
// from the canonical platform-context envelope (plan) and the already-loaded
// `listTeams()` payload (owned-team count) — never fabricated. When the
// page is at capacity the Create-Team button is disabled with an
// explanatory aria-label/title and an inline UpgradeCTA points to /billing
// (the canonical billing surface — see COLLABORATION_TEAM_BILLING_UPGRADE_CTA).
//
// NOTE: the SINGLE plan-usage indicator on this page is the canonical
// `PlanLimitBadge` (kind="TEAMS_USED"), matching the team-detail and
// collaboration-hub surfaces. The previously-duplicated local capacity badge
// was removed as part of the app-* redesign (spec §2A — exactly one compact
// plan-usage chip, consistent across every Teams surface).
// =============================================================================

function UpgradeCTA({
  ownedTeamCount,
  maxTeams,
  plan,
}: {
  ownedTeamCount: number;
  maxTeams: number;
  plan: WorkspacePlan;
}) {
  return (
    <Link
      href="/billing"
      className="app-secondary-action"
      data-testid="collaboration-teams-upgrade-cta"
      aria-label={`Upgrade — your ${plan} plan allows up to ${maxTeams} Teams (currently using ${ownedTeamCount})`}
    >
      Upgrade plan
    </Link>
  );
}

// =============================================================================
// Empty / loading / error
// =============================================================================

/**
 * Entitlement Alignment (2026-07-14) — restriction notice rendered above
 * the grandfathered-Teams list when the active plan includes zero Teams.
 * Existing Teams remain readable; all membership growth is locked.
 */
function PlanRestrictedNotice() {
  return (
    <div
      data-testid="teams-plan-restricted-notice"
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        margin: "0 0 12px",
      }}
    >
      <AppStatusBadge tone="amber" dot>
        <span data-testid="teams-plan-restricted-chip">
          Plan-restricted — read-only membership
        </span>
      </AppStatusBadge>
      <span style={{ color: "#667085", fontSize: 13 }}>
        {PLAN_LOCKED_COPY} Existing Teams and their data remain accessible.
      </span>
      <Link href="/billing" className="app-secondary-action">
        Upgrade plan
      </Link>
    </div>
  );
}

function TeamsEmptyState({
  onCreate,
  requiresUpgrade = false,
  plan = null,
}: {
  onCreate: () => void;
  /**
   * Entitlement Alignment (2026-07-14) — when true, the active plan
   * (FREE/PAYG) includes ZERO Teams. The empty state renders the honest
   * plan-locked landing: no Create-Team affordance at all, just the
   * canonical copy + upgrade CTA pointing at /billing.
   */
  requiresUpgrade?: boolean;
  plan?: WorkspacePlan | null;
}) {
  if (requiresUpgrade) {
    return (
      <div
        className="app-empty"
        data-testid="teams-empty-state"
        data-requires-upgrade="true"
      >
        <span className="app-empty__icon" aria-hidden="true">
          <TeamsGlyph />
        </span>
        <strong>{PLAN_LOCKED_COPY}</strong>
        <p>
          {plan ? `Your ${plan} plan doesn't include Teams. ` : ""}
          Teams give you shared assignments, member invites, and
          collaborative review on cases and evidence. Upgrade to create one.
        </p>
        <div
          style={{
            display: "inline-flex",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 4,
          }}
        >
          <Link
            href="/billing"
            className="app-primary-action"
            data-testid="teams-empty-upgrade-cta"
            aria-label={`Upgrade plan — ${PLAN_LOCKED_COPY}`}
          >
            Upgrade plan
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="app-empty" data-testid="teams-empty-state">
      <span className="app-empty__icon" aria-hidden="true">
        <TeamsGlyph />
      </span>
      <strong>No teams yet</strong>
      <p>
        A team is worth creating once more than one person is working the same
        cases: it gives that work one place to be assigned and discussed.
      </p>
      <button
        type="button"
        className="app-primary-action"
        onClick={onCreate}
        style={{ marginTop: 4 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>Create team</span>
      </button>
    </div>
  );
}

/**
 * The one empty state, which must say which kind of empty this is (§10).
 *
 * With a search or filter narrowing the list, "no teams yet" would be false:
 * teams may well exist, including ARCHIVED ones the status filter is currently
 * excluding. Saying so — and offering the reset that reveals them — is the
 * difference between a dead end and a page an operator can get out of.
 *
 * With nothing narrowing it, the workspace genuinely has none, and the
 * onboarding invitation to create the first one is the honest content.
 */
function NoMatchesState({
  onReset,
  controlsActive,
  onCreate,
}: {
  onReset: () => void;
  controlsActive: boolean;
  onCreate: () => void;
}) {
  if (!controlsActive) {
    return (
      <div className="app-empty" data-testid="teams-empty-state">
        <span className="app-empty__icon" aria-hidden="true">
          <TeamsGlyph />
        </span>
        <strong>No teams yet</strong>
        <p>
          A team is worth creating once more than one person is working the same
          cases: it gives that work one place to be assigned and discussed.
        </p>
        <button
          type="button"
          className="app-primary-action"
          onClick={onCreate}
          style={{ marginTop: 4 }}
        >
          Create team
        </button>
      </div>
    );
  }
  return (
    <div className="app-empty" data-testid="teams-no-matches">
      <span className="app-empty__icon" aria-hidden="true">
        <TeamsGlyph />
      </span>
      <strong>No teams match the current filters</strong>
      <p>
        Archived teams are excluded unless the status filter includes them — an
        archived team still exists, and still holds its history.
      </p>
      <button
        type="button"
        className="app-secondary-action"
        onClick={onReset}
        style={{ marginTop: 4 }}
      >
        Show all teams
      </button>
    </div>
  );
}

function TeamsGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function LoadingState() {
  return (
    <div className="app-table-surface" data-testid="teams-loading">
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 16 }}
          >
            <div className="app-skeleton" style={{ height: 14, flex: "2 1 0" }} />
            <div className="app-skeleton" style={{ height: 14, flex: "1 1 0" }} />
            <div className="app-skeleton" style={{ height: 14, flex: "1 1 0" }} />
            <div className="app-skeleton" style={{ height: 14, width: 72 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry: () => void;
}) {
  return (
    <div className="app-panel" data-testid="teams-error">
      <div className="app-panel__head">
        <h2 className="app-panel__title">Couldn&apos;t load Teams</h2>
        <AppStatusBadge tone="red" dot>
          Error
        </AppStatusBadge>
      </div>
      <div className="app-panel__body">
        <p style={{ color: "#475569", margin: "0 0 8px", fontSize: 13.5 }}>
          {message}
        </p>
        {requestId ? (
          <p
            style={{
              color: "var(--app-ink-secondary)",
              fontSize: 12,
              fontFamily: "monospace",
              margin: "0 0 12px",
            }}
            data-testid="error-request-id"
          >
            Request id: {requestId}
          </p>
        ) : null}
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Create-Team modal
// =============================================================================

function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (teamId: string) => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamType, setTeamType] = useState<CollaborationTeamType>("GENERAL");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  const canSubmit = name.trim().length > 0 && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createTeam({
        name: name.trim(),
        description: description.trim() || null,
        teamType,
      });
      onCreated(id);
    } catch (err) {
      const safe = toSafeUserError(err, {
        message: "We couldn't create the team. Please try again.",
      });
      // Entitlement Alignment (2026-07-14): TEAM_LIMIT_REACHED carries the
      // authoritative cap in `details` — surface the exact plan + limit
      // ("Your Pro plan includes up to 2 Teams. Upgrade to create another
      // Team.") instead of the generic sentence. Numbers are NEVER
      // fabricated: when details are missing we keep the safe generic copy.
      const message =
        err instanceof ApiError && err.code === "TEAM_LIMIT_REACHED"
          ? formatTeamLimitReachedMessage(err.details) ?? safe.message
          : safe.message;
      setError({ message, requestId: safe.supportReference });
      addToast(
        message,
        safe.severity,
        undefined,
        safe.supportReference ? { supportReference: safe.supportReference } : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-team-title"
      data-testid="create-team-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={onSubmit} className="app-dialog">
        <header className="app-dialog__head">
          <h2 id="create-team-title" className="app-dialog__title">
            Create a team
          </h2>
          <p className="app-dialog__subtitle">
            A team groups people who already have access to this workspace, so
            you can assign work to them and keep the discussion together.
          </p>
        </header>

        <div className="app-dialog__body">
          <label style={{ display: "block" }}>
            <span className="app-field-label">Name</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              data-testid="create-team-name-input"
              className="app-form-input"
              placeholder="e.g. Claim Investigations"
            />
          </label>

          <label style={{ display: "block" }}>
            <span className="app-field-label">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={600}
              rows={3}
              data-testid="create-team-description-input"
              className="app-form-input"
              placeholder="What does this team work on?"
            />
          </label>

          <label style={{ display: "block" }}>
            <span className="app-field-label">Template</span>
            <input
              type="hidden"
              value={teamType}
              data-testid="create-team-type-select"
              readOnly
            />
            <AppListbox<CollaborationTeamType>
              value={teamType}
              options={COLLABORATION_TEAM_TYPES.map((t) => ({
                value: t,
                label: TEAM_TYPE_LABELS[t],
                description: teamTypeHint(t),
              }))}
              onChange={setTeamType}
              ariaLabel="Team template"
            />
            <span className="app-field-help">
              A label for what this team works on. It changes nothing about
              permissions or behaviour — it helps you find the team later.
            </span>
          </label>

          {error ? (
            <div
              data-testid="create-team-error"
              style={{
                background: "#FFF1F2",
                border: "1px solid rgba(178, 52, 66, 0.18)",
                borderRadius: 10,
                padding: "0.75rem",
                color: "#B23442",
                fontSize: "0.9rem",
              }}
            >
              {error.message}
              {error.requestId ? (
                <div
                  style={{
                    marginTop: 4,
                    color: "var(--app-ink-secondary)",
                    fontSize: "0.75rem",
                    fontFamily: "monospace",
                  }}
                >
                  Request id: {error.requestId}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="app-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <button
            type="submit"
            className="app-primary-action"
            disabled={!canSubmit}
            data-testid="create-team-submit"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>{submitting ? "Creating…" : "Create team"}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function teamTypeHint(t: CollaborationTeamType): string {
  switch (t) {
    case "GENERAL":
      return "Flexible team for any work";
    case "INVESTIGATION":
      return "Reconstruction & timeline work";
    case "LEGAL":
      return "Matter & disclosure";
    case "REVIEW":
      return "Reviewer ops & QC";
    case "COMPLIANCE":
      return "Governance & audit";
  }
}
