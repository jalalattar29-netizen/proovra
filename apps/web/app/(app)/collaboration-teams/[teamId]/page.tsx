/**
 * PROOVRA Phase 6 — Team detail page (with tabs).
 *
 * Route: `/collaboration-teams/[teamId]?tab=overview|members|invites|assignments|activity|settings`
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
 */

"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell } from "../../../../components/ui";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  type CollaborationTeamDetail,
  getTeam,
} from "../../../../lib/api/collaboration-teams";
import { collaborationTeamRoleHasPermission } from "@proovra/shared";
import { useCan } from "../../../../lib/platform-context";
import { useBillingSummary } from "../../../../lib/api/billing-summary";
import { PlanLimitBadge } from "../../../../components/billing/PlanLimitBadge";
import { OverviewTab } from "./_tabs/OverviewTab";
import { MembersTab } from "./_tabs/MembersTab";
import { InvitesTab } from "./_tabs/InvitesTab";
import { AssignmentsTab } from "./_tabs/AssignmentsTab";
import { ActivityTab } from "./_tabs/ActivityTab";
import { SettingsTab } from "./_tabs/SettingsTab";

const TABS = [
  "overview",
  "members",
  "invites",
  "assignments",
  "activity",
  "settings",
] as const;
export type TabId = (typeof TABS)[number];

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
    const t = (search?.get("tab") as TabId) ?? "overview";
    return (TABS as ReadonlyArray<string>).includes(t)
      ? t
      : "overview";
  }, [search]);

  const [team, setTeam] = useState<CollaborationTeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  // `isStale` lets the effect drop a detail response that arrived after the
  // team changed (or the page unmounted) — the previous team must never paint.
  const refresh = useCallback(async (isStale?: () => boolean) => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getTeam(teamId);
      if (isStale?.()) return;
      setTeam(detail);
    } catch (err) {
      if (isStale?.()) return;
      const safe = toSafeUserError(err, { message: "We couldn't load the team." });
      setError({ message: safe.message, requestId: safe.supportReference });
    } finally {
      if (!isStale?.()) setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // PROOVRA Phase 10 — header billing summary hook MUST be called at the
  // top level of the component, before any early return / loading / error
  // branch, so React's Rules of Hooks holds (hook call order must be
  // identical across renders regardless of which branch we take).
  // Consumed below in the header chips once `team` is loaded.
  const headerBillingSummary = useBillingSummary();

  // SCOPE J (Phase 6 collaboration finalization) — deep-link to the
  // EXISTING external-reviewer management console (`/review/external`).
  // This is a REUSE link, never a second portal: the console is the
  // Phase-2B grant/identity/audit surface. We gate the link on the
  // same authority the console's PageRouteGate enforces
  // (`REVIEWER_OPS_VIEW`, ORGANIZATION_ONLY) so a self-serve /
  // personal team never sees a link that would only redirect. The
  // capability check MUST be a top-level hook call (Rules of Hooks),
  // so it lives here with the other pre-return hooks.
  const canManageExternalReviewers = useCan("REVIEWER_OPS_VIEW");

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

  const canManage = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.update_settings",
  );
  const canInvite = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.member.invite",
  );
  const canAssign = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.assignment.create",
  );

  // PROOVRA Phase 10 — header-level MEMBERS_USED chip + SMS_STATUS chip.
  // Read the same canonical envelope helper used across collaboration-teams
  // pages. The `MembersTab` keeps its own at-capacity logic; this is purely
  // an additive header surface so the user sees the cap before drilling in.
  //
  // NOTE: `headerBillingSummary` is captured by `useBillingSummary()` at the
  // top of the component (before early returns) per the React Rules of
  // Hooks. Only `activeMemberCountForBadge` (a plain derived value that
  // depends on `team`) is computed here.
  const activeMemberCountForBadge = team.members.filter(
    (m) => m.status === "ACTIVE",
  ).length;
  const pendingInviteCount = team.invites.filter(
    (i) => i.status === "PENDING",
  ).length;
  const openAssignmentCount = team.assignmentCount;

  // Per-tab count badges — only where a real count exists on `team`.
  const tabCounts: Partial<Record<TabId, number>> = {
    members: activeMemberCountForBadge,
    invites: pendingInviteCount,
    assignments: openAssignmentCount,
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
        // action. The header "Settings" button is removed; only Invite people
        // (primary) + Collaboration hub (secondary) remain (external-reviewers
        // stays as a gated deep-link where the viewer can manage them).
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
              {headerBillingSummary ? (
                <PlanLimitBadge
                  kind="MEMBERS_USED"
                  current={activeMemberCountForBadge}
                  max={headerBillingSummary.membersMax}
                  planLabel={headerBillingSummary.plan}
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
              flexWrap: "wrap",
              marginRight: "clamp(72px, 10%, 210px)",
            }}
          >
            {canInvite ? (
              <button
                type="button"
                className="app-primary-action"
                onClick={() => goTab("invites")}
                data-testid="quick-invite-button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>Invite people</span>
              </button>
            ) : null}
            <Link
              href={`/collaboration-teams/${team.id}/collaboration`}
              data-testid="collaboration-hub-link"
              className="home-exec-action"
            >
              Collaboration hub
            </Link>
            {canManageExternalReviewers ? (
              <Link
                href="/review/external"
                data-testid="external-reviewers-link"
                title="Invite and manage external reviewers via the External Review console"
                className="home-exec-action"
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
        {TABS.map((t) => {
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

      <div>
        {activeTab === "overview" ? (
          <OverviewTab team={team} onJumpTab={goTab} />
        ) : activeTab === "members" ? (
          <MembersTab
            team={team}
            onRefresh={refresh}
            canManage={canManage}
            canInvite={canInvite}
            onJumpTab={goTab}
          />
        ) : activeTab === "invites" ? (
          <InvitesTab team={team} onRefresh={refresh} canInvite={canInvite} />
        ) : activeTab === "assignments" ? (
          <AssignmentsTab team={team} canAssign={canAssign} />
        ) : activeTab === "activity" ? (
          <ActivityTab team={team} />
        ) : activeTab === "settings" ? (
          <SettingsTab
            team={team}
            onChange={refresh}
            canManage={canManage}
            canArchive={collaborationTeamRoleHasPermission(
              team.viewerRole,
              "team.archive",
            )}
          />
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
