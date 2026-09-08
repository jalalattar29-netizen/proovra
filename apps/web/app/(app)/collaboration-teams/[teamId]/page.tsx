/**
 * PROOVRA Phase 6 — Team detail page (with tabs).
 *
 * Route: `/collaboration-teams/[teamId]?tab=overview|work|members|discussion|settings`
 * (`assignments`, `activity` and `invites` still resolve — see
 * `RETIRED_TAB_ALIASES`.)
 *
 * Single-page detail with query-string-driven tabs (Linear/GitHub
 * pattern). Permission gating is server-enforced; the UI reads
 * `viewerRole` from the detail response and disables actions the
 * viewer can't perform.
 *
 * VISUAL redesign only. The page chrome (wrapper, operational header,
 * loading/error states, tab bar) is built on the neutral `app-*`
 * internal-product design system (translucent `.app-panel` header,
 * `.app-tabs` segmented tab bar, `.app-empty` states) inside the shared
 * PageShell. No data-fetching, permission, billing, or tab-body
 * behaviour changed — every data-testid / data-* is preserved, including
 * the test-pinned `external-reviewers-link` deep-link to /review/external.
 *
 * Discussion arrived here from the retired Collaboration Hub; Invites left
 * because a Collaboration Team does not invite anyone.
 */

"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, useToast } from "../../../../components/ui";
import type { SafeErrorFallback } from "../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  getCollaborationEntitlement,
  getTeam,
  type CollaborationEntitlement,
  type CollaborationTeamDetail,
} from "../../../../lib/api/collaboration-teams";
import { collaborationTeamRoleHasPermission } from "@proovra/shared";
import { useCan, usePlanFeature, usePlatformContext } from "../../../../lib/platform-context";
import { PlanLimitBadge } from "../../../../components/billing/PlanLimitBadge";
import { OverviewTab } from "./_tabs/OverviewTab";
import { MembersTab } from "./_tabs/MembersTab";
import { DiscussionPanel } from "./_tabs/DiscussionTab";
import { AssignmentsTab } from "./_tabs/AssignmentsTab";
import { ActivityTab } from "./_tabs/ActivityTab";
import { SettingsTab } from "./_tabs/SettingsTab";

// WORKSPACE AND COLLABORATION RECONCILIATION — Discussion joined the tabs and
// Invites left them.
//
// Discussion arrived from the retired Collaboration Hub, which was a second
// destination for one group. Invites left because a Collaboration Team no
// longer invites anyone: it is built from people who already hold authority in
// the workspace, so the Members tab is where someone is added, and the
// workspace People surface is where someone is brought in.
/**
 * FIVE TABS, EACH ANSWERING A JOB SOMEBODY ACTUALLY HAS.
 *
 * `assignments` → `work`. The tab is the group's operational surface — what it
 * is responsible for, who is carrying it, what is late — and "Work" is what an
 * operator calls that. "Assignments" named the row type, not the job.
 *
 * `activity` is no longer a tab. Its twenty-three event types are almost
 * entirely membership and settings administration; "what administrative
 * changes happened" is not a daily job, and giving it equal billing with Work
 * and Members implied it was one. NOTHING IS DELETED — every activity row is
 * still written, still audited, and still readable at
 * `?tab=settings`, which is where the group's administrative history belongs.
 *
 * `assignments` and `activity` stay ACCEPTED as URL values below, because both
 * are in people's history and in links they sent each other.
 */
const TABS = [
  "overview",
  "work",
  "members",
  "discussion",
  "settings",
] as const;
export type TabId = (typeof TABS)[number];

/**
 * Retired tab slugs, mapped to where their content lives now. A link someone
 * sent last week must still land somewhere sensible rather than silently
 * falling back to Overview, which is what `?tab=invites` did for months after
 * the Invites tab was deleted.
 */
const RETIRED_TAB_ALIASES: Record<string, TabId> = {
  // Quoted deliberately: these slugs are the contract with links already sent,
  // and quoting keeps them greppable by the tab-set contract test rather than
  // hiding a retired vocabulary behind bare object keys.
  "assignments": "work",
  "activity": "settings",
  "invites": "members",
};

/**
 * Group ids are `gen_random_uuid()` values (see `CollaborationTeam.id`). This
 * is the shape check the `[teamId]` segment never had — see `refresh()`.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TeamDetailPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_team_detail">
      <TeamDetail />
    </PageRouteGate>
  );
}

function TeamDetail() {
  const params = useParams<{ teamId: string }>();
  const teamId = params?.teamId ?? "";
  const search = useSearchParams();
  const router = useRouter();

  const activeTab: TabId = useMemo(() => {
    const t = search?.get("tab") ?? "overview";
    if ((TABS as ReadonlyArray<string>).includes(t)) return t as TabId;
    // A retired slug lands where its content actually went, rather than
    // silently falling back to Overview and leaving the operator to wonder
    // why the link they were sent did not work.
    return RETIRED_TAB_ALIASES[t] ?? "overview";
  }, [search]);

  // WCR-09 — the tenant this page is bound to; every loader below depends on it.
  const { activeWorkspaceId } = usePlatformContext();
  const [team, setTeam] = useState<
    (CollaborationTeamDetail & { viaWorkspaceGovernance: boolean }) | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  // `isStale` lets the effect drop a detail response that arrived after the
  // team changed (or the page unmounted) — the previous team must never paint.
  const refresh = useCallback(async (isStale?: () => boolean) => {
    if (!teamId) return;
    /**
     * A GROUP ID IS A UUID. ANYTHING ELSE IS NOT A TEAM, AND MUST NOT BE ASKED
     * FOR AS ONE.
     *
     * `[teamId]` matches every single segment under `/collaboration-teams/`,
     * including the API's own vocabulary. `/collaboration-teams/entitlement`
     * is the case that reached production: the segment was passed through as a
     * group id, and because the API has a STATIC
     * `GET /v1/collaboration-teams/entitlement` that Fastify prefers over the
     * parametric route, the request came back `200 OK` with an entitlement
     * projection. Nothing threw; the page rendered "Couldn't load team".
     *
     * Refusing here is better than repairing the response: a non-uuid segment
     * cannot name a group under any circumstance, so the correct behaviour is
     * to issue NO request at all and say plainly that the address is not a
     * team. That also means a mistyped or crawled URL can never spend a
     * round-trip against an unrelated endpoint.
     */
    if (!UUID_RE.test(teamId)) {
      setLoading(false);
      setTeam(null);
      setError({
        message:
          "That address isn't a team. Open a team from the Teams list to see its members, work and discussion.",
      });
      return;
    }
    setLoading(true);
    setError(null);
    // WCR-09 — the tenant this call is FOR, captured before the await and
    // compared after it. A workspace switch mid-flight cannot un-send the
    // request, so the response is discarded by the id it was issued under.
    const issuedFor = activeWorkspaceId;
    try {
      const detail = await getTeam(teamId);
      if (isStale?.() || issuedFor !== activeWorkspaceId) return;
      setTeam(detail);
    } catch (err) {
      if (isStale?.()) return;
      const safe = toSafeUserError(err, { message: "We couldn't load the team." });
      setError({ message: safe.message, requestId: safe.supportReference });
    } finally {
      if (!isStale?.()) setLoading(false);
    }
    /**
     * WCR-09 (2026-09-07) — KEYED ON THE WORKSPACE AS WELL AS THE GROUP.
     *
     * This depended on `teamId` alone. Switching workspace re-ingested the
     * envelope and changed the request header, but the effect did not re-run —
     * so the PREVIOUS tenant's group detail stayed on screen under the new
     * tenant's header, and the next mutation carried the new workspace id and
     * met a 404 the operator could not explain.
     *
     * No cross-tenant data was ever served: `authorizeCollaborationTeam`
     * refuses a group that does not belong to the proven workspace. What was
     * wrong was the display, which on an evidence platform is its own kind of
     * failure.
     */
  }, [teamId, activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /**
   * Drop the previous tenant's group IMMEDIATELY on a switch, rather than
   * leaving it painted for the duration of a network round trip.
   */
  useEffect(() => {
    setTeam(null);
  }, [activeWorkspaceId]);

  // PROOVRA Phase 10 — header billing summary hook MUST be called at the
  // top level of the component, before any early return / loading / error
  // branch, so React's Rules of Hooks holds (hook call order must be
  // identical across renders regardless of which branch we take).
  // Consumed below in the header chips once `team` is loaded.
  /**
   * THE CONTRACT-AWARE CAPACITY, NOT THE CATALOG'S GUESS.
   *
   * This read `useBillingSummary()`, which projects raw `PLAN_CATALOG`
   * integers and returns the literal string "unlimited" for ENTERPRISE. So an
   * Enterprise workspace whose contract caps a group at 300 members was told
   * "unlimited members" on the header of every group — the exact defect WCR-06
   * and WCR-07 removed from the Teams LIST by moving it onto
   * `/v1/collaboration-teams/entitlement`, left in place one route away on the
   * DETAIL page.
   *
   * `resolveCollaborationEntitlement` is contract-first and status-checked (a
   * DRAFT, SUSPENDED or TERMINATED contract cannot raise a ceiling), and it is
   * the same projection the list page and the create gate read. `null` means
   * UNKNOWN — loading or degraded — and the header renders no capacity claim
   * at all rather than substituting a number.
   */
  const [headerEntitlement, setHeaderEntitlement] =
    useState<CollaborationEntitlement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getCollaborationEntitlement()
      .then((e) => {
        if (!cancelled) setHeaderEntitlement(e);
      })
      // A capacity chip must never break the page it decorates.
      .catch(() => {
        if (!cancelled) setHeaderEntitlement(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // One error path for every tab panel: the sanctioned safe-feedback helper,
  // never a raw message.
  const { addToast } = useToast();
  /*
   * ONE SAFE-ERROR BOUNDARY FOR EVERY TAB, AND IT NOW RECEIVES THE ERROR.
   *
   * The tabs used to hand this a rebuilt `{ message, requestId }`, so by the
   * time it arrived `toSafeUserError` had no code and no status to resolve and
   * answered GENERIC for every refusal. They pass the error itself now; the
   * optional `fallback` is the per-action sentence, used only when nothing
   * recognises the failure.
   */
  const onTabError = useCallback(
    (err: unknown, fallback?: SafeErrorFallback) =>
      notifyApiError(addToast, err, fallback),
    [addToast],
  );

  // SCOPE J (Phase 6 collaboration finalization) — deep-link to the
  // EXISTING external-reviewer management console (`/review/external`).
  // This is a REUSE link, never a second portal: the console is the
  // Phase-2B grant/identity/audit surface. We gate the link on the
  // same authority the console's PageRouteGate enforces
  // (`REVIEWER_OPS_VIEW`, ORGANIZATION_ONLY) so a self-serve /
  // personal team never sees a link that would only redirect. The
  // capability check MUST be a top-level hook call (Rules of Hooks),
  // so it lives here with the other pre-return hooks.
  /**
   * WCR-10 (2026-09-07) — CAPABILITY *AND* ENTITLEMENT.
   *
   * This gated the "External reviewers" link on `REVIEWER_OPS_VIEW` alone — a
   * ROLE capability. Issuing an external-review grant is additionally gated by
   * a COMMERCIAL entitlement, which is a different question with a different
   * answer. So an operator holding the role followed a link into a console
   * whose first mutation answers `403 ENTITLEMENT_REQUIRED`.
   *
   * PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — the entitlement was
   * the packaging engine's `FEATURE_EXTERNAL_PORTAL`, which defaulted to false
   * and which no purchase path granted, so this link was correctly hidden from
   * everyone. It now reads `externalReviewIncluded`, the projection of the
   * plan the workspace actually bought, so PRO and above see it and are not
   * refused when they follow it.
   *
   * A surface must not promise a capability the gate will refuse.
   * `externalReviewIncluded` is the SAME resolver's answer, projected per
   * workspace by the platform context. `null` means UNKNOWN and the link stays
   * hidden — fail closed, rather than promising on a degraded envelope.
   */
  const externalReviewIncluded = usePlanFeature("externalReviewIncluded");
  const canManageExternalReviewers =
    useCan("REVIEWER_OPS_VIEW") && externalReviewIncluded === true;

  if (loading && !team) {
    return (
      <PageShell
        data-testid="team-detail-loading"
        header={
          <div className="app-page-header">
            <div className="app-page-header__lead">
              <span className="app-page-header__icon" aria-hidden="true">
                <TeamGlyph />
              </span>
              <div className="app-page-header__text">
                <h1 className="app-page-header__title">Loading team…</h1>
                <p className="app-page-header__subtitle">
                  Fetching members, invites, and assignments.
                </p>
              </div>
            </div>
          </div>
        }
      >
        <div className="app-panel">
          <div
            style={{
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div className="app-skeleton" style={{ height: 14, width: "40%" }} />
            <div className="app-skeleton" style={{ height: 14, width: "70%" }} />
            <div className="app-skeleton" style={{ height: 14, width: "55%" }} />
          </div>
        </div>
      </PageShell>
    );
  }
  if (error || !team) {
    const safeError = toSafeUserError(error, {
      message: "We couldn't load this page. Please try again.",
    });
    return (
      <PageShell
        data-testid="team-detail-error"
        header={
          <div className="app-page-header">
            <div className="app-page-header__lead">
              <span className="app-page-header__icon" aria-hidden="true">
                <TeamGlyph />
              </span>
              <div className="app-page-header__text">
                <h1 className="app-page-header__title">Couldn&apos;t load team</h1>
                <p className="app-page-header__subtitle">{safeError.message}</p>
              </div>
            </div>
          </div>
        }
      >
        <div className="app-empty">
          <span className="app-empty__icon" aria-hidden="true">
            <TeamGlyph />
          </span>
          <strong>We couldn&apos;t load this team</strong>
          <p>{safeError.message}</p>
          {error?.requestId ? (
            <p
              style={{
                color: "var(--app-ink-secondary)",
                fontSize: 12,
                fontFamily: "monospace",
                margin: 0,
              }}
            >
              Request id: {error.requestId}
            </p>
          ) : null}
          <Link href="/collaboration-teams" className="app-secondary-action">
            Back to Teams
          </Link>
        </div>
      </PageShell>
    );
  }

  /*
   * A CAPABILITY IS A ROLE **AND** A LIFECYCLE STATE (§11).
   *
   * These were role-only, so on an archived team every member, work and
   * settings control rendered fully enabled and the server refused each one.
   * The operator discovered the team was archived by failing at it — the page
   * had `team.status` the whole time and never asked.
   *
   * `isArchived` is folded in HERE, once, rather than in each tab: the tabs
   * receive a capability that is already true or already false, so no tab can
   * forget the lifecycle half. What remains available on an archived team is
   * exactly what the server still accepts — reopening it, and deleting a
   * group that carries no record.
   *
   * THIS IS NOT AUTHORIZATION. Every one of these mutations is still gated
   * server-side by `authorizeCollaborationTeam` with `requireActiveTeam`, and
   * that gate remains the only thing that decides. This stops the console
   * offering an action that cannot succeed, and says why instead.
   */
  const isArchived = team.status !== "ACTIVE";
  const canManage =
    !isArchived &&
    collaborationTeamRoleHasPermission(team.viewerRole, "team.update_settings");
  const canInvite =
    !isArchived &&
    collaborationTeamRoleHasPermission(team.viewerRole, "team.member.invite");
  const canAssign =
    !isArchived &&
    collaborationTeamRoleHasPermission(team.viewerRole, "team.assignment.create");
  /** Reopen and delete are the two writes an archived team still accepts. */
  const canArchive = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.archive",
  );
  const canDelete = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.delete",
  );
  const canTransferLead =
    !isArchived &&
    collaborationTeamRoleHasPermission(team.viewerRole, "team.transfer_lead");

  // PROOVRA Phase 10 — header-level MEMBERS_USED chip + SMS_STATUS chip.
  // Read the same canonical envelope helper used across collaboration-teams
  // pages. The `MembersTab` keeps its own at-capacity logic; this is purely
  // an additive header surface so the user sees the cap before drilling in.
  //
  // NOTE: `headerBillingSummary` is captured by `useBillingSummary()` at the
  // top of the component (before early returns) per the React Rules of
  // Hooks. Only `activeMemberCountForBadge` (a plain derived value that
  // depends on `team`) is computed here.
  /**
   * WCR-08 (2026-09-07) — THE SERVER'S COUNT, NOT THE PREVIEW'S LENGTH.
   *
   * `team.members` is a BOUNDED PREVIEW of at most `memberPreviewLimit` rows.
   * Filtering it and calling the result "how many members are there" makes the
   * header under-report on every group larger than the preview, and the same
   * derivation drove the Members tab's capacity check — so "Add member" stayed
   * enabled past the real ceiling until the server refused it.
   *
   * A bounded preview is never an authoritative population. `activeMemberCount`
   * is the population, and the server has always sent it.
   */
  const activeMemberCountForBadge = team.activeMemberCount;
  const openAssignmentCount = team.assignmentCount;

  // Per-tab count badges — only where a real count exists on `team`.
  const tabCounts: Partial<Record<TabId, number>> = {
    members: activeMemberCountForBadge,
    work: openAssignmentCount,
  };

  const goTab = (tab: TabId) =>
    router.push(`/collaboration-teams/${team.id}?tab=${tab}`);

  return (
    <PageShell
      data-testid="team-detail"
      data-team-id={team.id}
      data-team-status={team.status}
      header={
        // §7 — the Team header renders on the SHARED `.ops-banner-card` shell
        // (the exact accepted Home critical-card / Case-detail banner surface:
        // dark navy base, the `icon-card.png` artwork at `right center / auto
        // 260%`, radius, shadow and [content | action] flex row). Only a
        // restrained purple left rail differs. Same implementation pattern as
        // SimpleCaseHeader — light text, light status pills, a glass secondary
        // action. The header "Settings" button is removed; only Add people
        // (primary) + Discussion (secondary) remain (external-reviewers stays as
        // a gated deep-link where the viewer can manage them).
        <header
          data-testid="team-detail-header"
          className="ops-banner-card"
          style={{
            borderLeft: "4px solid rgba(139,124,246,0.55)",
            padding: "26px 28px",
          }}
        >
          {/* LEFT content zone */}
          <div
            style={{
              flex: 1,
              minWidth: 240,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <nav
              aria-label="Breadcrumb"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                marginBottom: 16,
                fontSize: 12,
                lineHeight: 1.35,
                fontWeight: 500,
                color: "rgba(255,255,255,0.58)",
              }}
            >
              <Link
                href="/collaboration-teams"
                style={{ color: "rgba(255,255,255,0.62)", textDecoration: "none" }}
              >
                Collaboration Teams
              </Link>
              <span aria-hidden style={{ color: "rgba(255,255,255,0.34)" }}>
                ›
              </span>
              <span aria-current="page" style={{ color: "rgba(255,255,255,0.9)" }}>
                {team.name}
              </span>
            </nav>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: team.description ? 10 : 14,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  color: "#E7E3FF",
                  flexShrink: 0,
                }}
              >
                <TeamGlyph />
              </span>
              <h1
                style={{
                  margin: 0,
                  fontSize: 21,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  letterSpacing: "-0.015em",
                  color: "#ffffff",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {team.name}
              </h1>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 22,
                  padding: "0 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: "rgba(231,227,255,0.16)",
                  border: "1px solid rgba(231,227,255,0.26)",
                  color: "#E7E3FF",
                }}
              >
                {templateLabel(team.teamType)}
              </span>
              {/*
                LIFECYCLE, BESIDE THE NAME (§9B).

                `data-team-status` was on the page shell for tests and nowhere a
                person could see it, so the only visible signal that a team was
                archived lived on the Settings tab — and an operator normally
                met it as a failed action instead.

                ACTIVE is deliberately not labelled. A chip on every team would
                be a badge that means nothing on the overwhelming majority of
                them; the state worth interrupting for is the exceptional one.
              */}
              {isArchived ? (
                <span
                  data-testid="team-detail-status"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    height: 22,
                    padding: "0 10px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.02em",
                    background: "rgba(234,88,12,0.20)",
                    border: "1px solid rgba(253,186,116,0.45)",
                    color: "#FFD9BE",
                  }}
                >
                  Archived
                </span>
              ) : null}
            </div>

            {team.description ? (
              <p
                style={{
                  margin: "0 0 14px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "rgba(255,255,255,0.72)",
                  maxWidth: "64ch",
                }}
              >
                {team.description}
              </p>
            ) : null}

            {/* Metadata: plan usage · role · members · last activity */}
            <div
              style={{
                display: "flex",
                columnGap: 10,
                rowGap: 6,
                flexWrap: "wrap",
                alignItems: "center",
                fontSize: 12.5,
                lineHeight: 1.4,
                color: "rgba(255,255,255,0.68)",
              }}
            >
              {headerEntitlement ? (
                <PlanLimitBadge
                  kind="MEMBERS_USED"
                  current={activeMemberCountForBadge}
                  max={headerEntitlement.collaborationTeamMembers.limit}
                  planLabel={headerEntitlement.plan}
                />
              ) : null}
              <span>
                Your role:{" "}
                <strong style={{ color: "rgba(255,255,255,0.86)", fontWeight: 650 }}>
                  {team.viewerRole}
                </strong>
              </span>
              <span aria-hidden style={{ color: "rgba(255,255,255,0.36)" }}>
                ·
              </span>
              <span>
                {activeMemberCountForBadge}{" "}
                {activeMemberCountForBadge === 1 ? "member" : "members"}
              </span>
              <span aria-hidden style={{ color: "rgba(255,255,255,0.36)" }}>
                ·
              </span>
              <span style={{ color: "rgba(255,255,255,0.56)" }}>
                Last activity {formatRelative(team.updatedAt)}
              </span>
            </div>
          </div>

          {/* RIGHT action cluster — Invite people (primary) + Collaboration
              hub (secondary glass). Positioned with a right reserve so it
              clears the decorative icon-card artwork, like the Home/Case
              banners. */}
          {/*
            THE ACTIONS MUST BE REACHABLE ON A PHONE.

            `.ops-banner-card` is `overflow: hidden`, and this row carried a
            right margin of up to 210px to clear the card's artwork. At 390px
            that left a 293px content box holding 591px of buttons: "Add people"
            fitted, "Collaboration hub" was cut in half, and "External
            reviewers" sat entirely outside the clip and could not be reached at
            all — measured, not guessed.

            The margin exists to avoid the artwork, which is a DESKTOP concern;
            below the wrap point there is no artwork to avoid because the row
            has already wrapped underneath the title. So the clearance is
            applied only where it is needed, and the row is allowed to fill the
            width and wrap everywhere else.
          */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 1,
              flexWrap: "wrap",
              minWidth: 0,
              marginRight: "var(--team-header-action-clearance, 0px)",
            }}
          >
            {canInvite ? (
              <button
                type="button"
                className="app-primary-action"
                onClick={() => goTab("members")}
                data-testid="quick-invite-button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>Add people</span>
              </button>
            ) : null}
            {/*
              The Collaboration Hub was a second destination holding five
              panels, three of which did nothing. What survived is the
              discussion, and it is a tab on this page — so the header opens
              that tab rather than a page which now only redirects back here.
            */}
            <button
              type="button"
              onClick={() => goTab("discussion")}
              data-testid="collaboration-hub-link"
              /*
                THE CANONICAL SECONDARY, not the shell glass button.

                `home-exec-action` is a translucent overlay treatment built for
                the Home executive banner — 16% white on a dark ground. Beside
                "Add people", which is the canonical `app-primary-action`, it
                read as unfinished rather than as the second action: the eye
                could not tell a real control from a decorative one. The
                canonical secondary is a solid light surface with dark-neutral
                label text, which is exactly the contrast this dark header needs
                and the same treatment every other polished surface uses.
              */
              className="app-secondary-action"
            >
              Discussion
            </button>
            {canManageExternalReviewers ? (
              <Link
                href="/review/external"
                data-testid="external-reviewers-link"
                title="Invite and manage external reviewers via the External Review console"
                // Same hierarchy — a peer secondary action, not a third style.
                className="app-secondary-action"
              >
                External reviewers
              </Link>
            ) : null}
          </div>
        </header>
      }
    >
      <nav
        aria-label="Team sections"
        data-testid="team-tabs"
        className="app-tabs is-sticky"
      >
        {TABS.filter((t) =>
          /*
            DISCUSSION IS PARTICIPATION, AND A GOVERNOR IS NOT A PARTICIPANT.

            The comments endpoints deliberately do NOT grant the governor read
            state — a group's conversation is the one thing supervision should
            not silently include, and reading it is not needed to see whether
            the group is coping. Showing a tab that would answer 404 would look
            like a fault, so it is not offered.
          */
          t === "discussion" ? !team.viaWorkspaceGovernance : true,
        ).map((t) => {
          const count = tabCounts[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => goTab(t)}
              data-testid={`tab-${t}`}
              data-active={t === activeTab}
              aria-current={t === activeTab ? "page" : undefined}
              className={`app-tab${t === activeTab ? " is-active" : ""}`}
            >
              <span style={{ textTransform: "capitalize" }}>{t}</span>
              {typeof count === "number" ? (
                <span className="app-tab__count">{count}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/*
        SAY WHY THE ACTIONS ARE MISSING.

        A workspace OWNER or ADMIN can now open a group they are not a member
        of — previously every such group 404'd, so they could enumerate twenty
        groups in their own tenant and inspect none of them. They arrive with
        no group role, so every mutation affordance resolves away on its own.

        Without this line that reads as a broken page. With it, it reads as
        what it is: supervision. Membership is still the only way to
        participate, and joining is a deliberate act rather than a side effect
        of being an administrator.
      */}
      {team.viaWorkspaceGovernance ? (
        <div
          className="app-panel"
          data-testid="team-governance-notice"
          style={{ marginBottom: 12 }}
        >
          <div className="app-panel__body">
            <strong>Viewing as a workspace administrator.</strong>{" "}
            <span className="app-table__muted">
              You are not a member of this team, so you can see its work,
              members and history but cannot change them or take part in the
              discussion. A team lead or admin can add you if you need to
              participate.
            </span>
          </div>
        </div>
      ) : null}

      {/*
        THE ARCHIVED STATE, SAID ONCE, ABOVE EVERY TAB (§10).

        It says three things in the order an operator needs them: what the
        state is, that nothing was lost, and what to do about it. "Archived"
        alone reads as "deleted" to somebody who did not archive it, which is
        the reading that makes people panic about evidence.

        It appears on every tab because every tab's writes are refused, and it
        is a single compact row rather than a slab — the tabs below it are
        still the page.
      */}
      {isArchived ? (
        <div
          className="app-alert app-alert--warn"
          data-testid="team-archived-banner"
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <span>
            <strong>This team is archived.</strong> Its members, work and
            history stay readable, but changes are disabled.
            {canArchive ? " Reopen it to make changes." : ""}
          </span>
          {canArchive ? (
            <button
              type="button"
              className="app-secondary-action"
              data-testid="team-archived-banner-reopen"
              onClick={() => goTab("settings")}
            >
              Reopen in Settings
            </button>
          ) : null}
        </div>
      ) : null}

      <div>
        {activeTab === "overview" ? (
          <OverviewTab team={team} onJumpTab={goTab} />
        ) : activeTab === "members" ? (
          <MembersTab
            team={team}
            onRefresh={refresh}
            canManage={canManage}
            canInvite={canInvite}
          />
        ) : activeTab === "work" ? (
          <AssignmentsTab team={team} canAssign={canAssign} />
        ) : activeTab === "discussion" ? (
          // Reachable by URL even though the tab is hidden above, so the
          // refusal is stated rather than surfacing as a load failure.
          team.viaWorkspaceGovernance ? (
            <div className="app-empty" data-testid="discussion-governance-blocked">
              <strong>Discussion is for members of this team</strong>
              <p>
                You are viewing this team as a workspace administrator. Joining
                the team is what grants a place in its conversation.
              </p>
            </div>
          ) : (
            <DiscussionPanel team={team} onError={onTabError} />
          )
        ) : activeTab === "settings" ? (
          <>
            <SettingsTab
              team={team}
              onChange={refresh}
              canManage={canManage}
              canArchive={canArchive}
              canDelete={canDelete}
              canTransferLead={canTransferLead}
              onError={onTabError}
            />
            {/*
              ACTIVITY IS PRESERVED, NOT PROMOTED.
              Its event vocabulary is almost entirely membership and settings
              administration, which is a thing an operator audits occasionally
              and not a daily job — giving it a tab beside Work and Members
              implied otherwise. Every row is still written and still read
              here; nothing was deleted, and `?tab=activity` still lands on it.
            */}
            <ActivityTab team={team} />
          </>
        ) : null}
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Header helpers (presentation only — no data / permission logic).
// ---------------------------------------------------------------------------

/** People/team line-SVG used in the header + empty states. */
function TeamGlyph() {
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

/** Title-case the raw team-type/template enum for display. */
function templateLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/** Compact relative time for the "last activity" meta chip. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
