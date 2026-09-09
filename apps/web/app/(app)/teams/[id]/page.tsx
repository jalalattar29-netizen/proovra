"use client";
/**
 * WORKSPACE PEOPLE — the per-WORKSPACE membership surface.
 *
 * `/people` resolves here for the caller's active workspace (see
 * `lib/navigation/workspacePeopleLocator`), so this file IS the People page;
 * the `/teams/[id]` path is retained because the same surface has to be
 * addressable per workspace from `/workspaces` and from org admin.
 *
 * What it owns: workspace profile, seats, WORKSPACE members + invitations
 * (`TeamMember` / `TeamInvite` — the ACCESS authority), case linkage, access
 * review, and the workspace lifecycle actions. All via the `/v1/teams/*`
 * (workspace / tenancy) API, gated by `admin.teams` (capability TEAM_VIEW).
 *
 * What it is NOT: the collaboration Teams product. `/collaboration-teams/[id]`
 * manages `CollaborationTeam` GROUPS via `/v1/collaboration-teams`; those are
 * operational groupings and confer no access. Membership here decides who is
 * in the workspace; membership there decides who is on the hook for work.
 * Backend migration of `/v1/teams` (tenancy) is out of scope — it backs
 * billing, seats, and evidence ownership.
 */
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useToast } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
// THE canonical primitives. This page used to carry its own listbox, its own
// badge treatment and three per-render button styles; every one of those is a
// shared component now, so the surface follows the product rather than drifting
// beside it.
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
// The accessible dialog (focus trap, Escape, focus restoration) — NOT the
// legacy `Modal` re-exported from `components/ui`.
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
// CR1.6 Part 4 — Replace the legacy /v1/users/me self-fetch with the
// canonical PlatformContextEnvelope user identity. The team detail
// page only needed `currentUserId` to derive role-from-membership;
// the envelope already carries `user.id` (and is authoritative).
import { usePlatformContext } from "../../../../lib/platform-context";
import { buildBillingHref } from "../../../../lib/navigation/billingWorkspaceLocator";
import { MemberRemovalDialog } from "./components/MemberRemovalDialog";
import { TeamPermissionMatrix } from "./components/TeamPermissionMatrix";
import { DangerConfirmModal } from "./components/DangerConfirmModal";
import { WorkspaceClosureCard } from "./components/WorkspaceClosureCard";
import { WorkspaceOwnershipTransferCard } from "./components/WorkspaceOwnershipTransferCard";
import { TeamAccessReviewCard } from "./components/TeamAccessReviewCard";
// Closure verification Part C — the per-team detail page (workspace
// admin: members, invites, danger actions) must use the canonical
// PageRouteGate, matching the gated list page at /teams (routeId
// `admin.teams`, capability TEAM_VIEW).
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

type TeamMemberUser = {
  id?: string;
  email?: string | null;
  displayName?: string | null;
};

type TeamMember = {
  id?: string;
  userId: string;
  role: string;
  /**
   * ACTIVE / SUSPENDED / REVOKED.
   *
   * `GET /v1/teams/:id` includes members with no `select`, so the whole row —
   * status included — has always been on the wire; this type simply never
   * declared it, and the old page therefore could not show that somebody's
   * access was suspended. On an access-management surface that is the single
   * most important thing a row can say after the person's name.
   */
  status?: string;
  createdAt?: string;
  user?: TeamMemberUser;
  label?: string;
};

type TeamInvite = {
  id: string;
  email: string;
  role: string;
  createdAt?: string;
  expiresAt?: string;
  acceptedAt?: string | null;
};

type TeamCase = {
  id: string;
  name: string;
  createdAt?: string;
  ownerUserId?: string;
  teamId?: string | null;
};

type AvailableCaseItem = {
  id: string;
  name: string;
  createdAt?: string;
  ownerUserId?: string;
  teamId?: string | null;
};

type TeamActivity = {
  id: string;
  eventType: string;
  targetType: string;
  targetId?: string;
  actor?: {
    id: string;
    email?: string | null;
    displayName?: string | null;
  };
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

type TeamStats = {
  memberCount: number;
  pendingInviteCount: number;
  caseCount: number;
  /**
   * The SERVER's seat projection — the same numbers the invitation gate
   * enforces. Optional on the wire so a degraded response is representable;
   * absent means UNKNOWN and is rendered as such, never as a default.
   */
  seatLimit?: number;
  seatUsed?: number;
  seatAvailable?: number;
};

type Team = {
  id: string;
  name?: string | null;
  ownerUserId?: string;
  currentUserRole?: string;
  canManageMembers?: boolean;
  /** SERVER-projected OWNER-level workspace authority (delete / closure). */
  canManageWorkspace?: boolean;
  stats?: TeamStats;
  members?: TeamMember[];
  /**
   * RAW persisted column, ADMIN-only on the wire. Declared so the shape
   * matches the response, NOT so it can be rendered: it is meaningless on a
   * Personal Workspace. Render `effectivePlan`.
   */
  billingPlan?: string | null;
  /** The server-resolved effective commercial plan. The ONLY plan to render. */
  effectivePlan?: string | null;
  billingStatus?: string | null;
  billingOwnerUserId?: string | null;
  includedSeats?: number | null;
  maxMembersPerTeam?: number | null;
  overSeatLimit?: boolean | null;
  billingActivatedAt?: string | null;
  billingCanceledAt?: string | null;
};

// CR1.6 Part 4 — `MeResponse` removed alongside the self-fetch. The
// current user id is now sourced from the canonical platform envelope
// (`envelope.user.id`).

type TeamInvitesResponse = {
  invites: TeamInvite[];
};

type TeamCasesResponse = {
  items: TeamCase[];
};

type TeamActivitiesResponse = {
  activities: TeamActivity[];
};

type CasesListResponse = {
  items?: AvailableCaseItem[];
};

const MANAGEABLE_ROLE_OPTIONS = ["ADMIN", "MEMBER", "VIEWER"] as const;
const INVITE_ROLE_OPTIONS = ["ADMIN", "MEMBER", "VIEWER"] as const;
/**
 * The roles a manager may SET on somebody else.
 *
 * OWNER is absent by construction, not by omission: ownership moves through
 * `POST /v1/teams/:id/transfer-ownership`, which is gated on `Team.ownerUserId`
 * and requires step-up. A dropdown is not an authorization boundary — the
 * server refuses an OWNER grant regardless — but offering it would advertise a
 * transition this control cannot perform.
 */
const ROLE_OPTIONS = MANAGEABLE_ROLE_OPTIONS;

/**
 * WORKSPACE role labels — DISPLAY ONLY (§15.12, §15.33).
 *
 * The selector offered raw enum values: ADMIN, MEMBER, VIEWER. Those are the
 * wire vocabulary, not product language, and shouting them at an operator in a
 * control that decides someone's access is the kind of detail that makes a
 * governance surface read like a database console.
 *
 * The VALUE stays the enum — the API contract is untouched, and other surfaces
 * compare against the raw string — so this changes what a person reads and
 * nothing about what is sent.
 *
 * The help line names the SCOPE, which is the distinction §15.12 exists for: a
 * WORKSPACE role governs access across the whole workspace, while a
 * Collaboration Team role governs responsibility inside one group. Two
 * different questions, and the same four words could otherwise answer either.
 */
const WORKSPACE_ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

function workspaceRoleLabel(role: string): string {
  return WORKSPACE_ROLE_LABEL[role] ?? role;
}

/** A person's display name, never falling back to a raw id in the primary slot. */
function memberLabel(member: {
  user?: { displayName?: string | null; email?: string | null } | null;
  label?: string | null;
  userId: string;
}): string {
  return (
    member.user?.displayName?.trim() ||
    member.user?.email ||
    member.label ||
    "Workspace member"
  );
}

/**
 * Activity rows in plain language.
 *
 * The stored `eventType` is a bounded machine vocabulary and is never shown
 * raw — an operator reading "invite_created" is reading the database, not the
 * product. Anything unmapped degrades to a humanised form rather than being
 * hidden, so a new event type is legible before anyone writes copy for it.
 */
const ACTIVITY_LABELS: Record<string, string> = {
  invite_created: "Invitation sent",
  invite_revoked: "Invitation revoked",
  invite_accepted: "Invitation accepted",
  member_added: "Person added",
  member_removed: "Person removed",
  member_role_changed: "Role changed",
  team_renamed: "Workspace renamed",
  case_linked: "Case linked",
  case_unlinked: "Case removed",
  /**
   * THE REST OF WHAT `team_activities` ACTUALLY HOLDS (§10).
   *
   * The nine above were the only mapped types, so every other writer to this
   * table fell through to the humaniser and rendered its raw enum. Three of
   * them are SHOUTY — the reviewer-ops writers store `DECISION_LOGGED`,
   * `STAGE_CHANGED` and `REVIEWER_NOTE_CREATED` — which the old fallback
   * passed through untouched, so the feed shouted database vocabulary at an
   * operator. These are the real event types emitted by the workspace
   * lifecycle, reviewer-ops, and integrations writers; nothing here is
   * invented, and an unmapped type still degrades legibly rather than hiding.
   */
  DECISION_LOGGED: "Review decision recorded",
  STAGE_CHANGED: "Review stage changed",
  REVIEWER_NOTE_CREATED: "Reviewer note added",
  reviewer_governance_flags_updated: "Reviewer governance updated",
  reviewer_sla_policy_updated: "Reviewer SLA policy updated",
  workspace_closed: "Workspace closed",
  workspace_reopened: "Workspace reopened",
  workspace_suspended: "Workspace suspended",
  workspace_resumed: "Workspace resumed",
  workspace_ownership_transferred: "Ownership transferred",
  "integration.api_key.created": "API key created",
  "integration.api_key.revoked": "API key revoked",
  "integration.api_key.rotated": "API key rotated",
  "integration.api_key.expiry_changed": "API key expiry changed",
  "integration.webhook.secret_rotated": "Webhook secret rotated",
  "integration.webhook.test_sent": "Webhook test sent",
  "integration.webhook.delivery_retried": "Webhook delivery retried",
};

function humanizeActivity(activity: {
  eventType: string;
  actor?: { displayName?: string | null; email?: string | null } | null;
}): string {
  /**
   * The fallback LOWERCASES first. It used to only capitalise the first
   * character, so a stored `DECISION_LOGGED` came through as
   * "DECISION LOGGED" — a raw enum, shouted. Sentence case is legible for a
   * type nobody has written copy for yet, which is the whole point of having
   * a fallback rather than hiding the row.
   */
  const what =
    ACTIVITY_LABELS[activity.eventType] ??
    activity.eventType
      .replace(/[_.]/g, " ")
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  const who =
    activity.actor?.displayName?.trim() || activity.actor?.email || null;
  return who ? `${what} — ${who}` : what;
}

/**
 * The marker colour beside an activity row.
 *
 * DELIBERATELY COARSE, and never the only carrier of meaning — the sentence
 * beside it always says what happened. Green is access GAINED, red is access
 * REMOVED, purple is a change to the workspace itself, and anything unmapped
 * stays neutral rather than being guessed at. Colouring every row differently
 * would turn a history into a chart nobody asked for.
 */
function activityTone(eventType: string): "success" | "danger" | "accent" | "info" | undefined {
  switch (eventType) {
    case "member_added":
    case "invite_accepted":
    case "workspace_reopened":
    case "workspace_resumed":
      return "success";
    case "member_removed":
    case "invite_revoked":
    case "workspace_closed":
    case "workspace_suspended":
    case "integration.api_key.revoked":
      return "danger";
    case "member_role_changed":
    case "team_renamed":
    case "invite_created":
    case "workspace_ownership_transferred":
      return "accent";
    case "DECISION_LOGGED":
    case "STAGE_CHANGED":
    case "REVIEWER_NOTE_CREATED":
      return "info";
    default:
      return undefined;
  }
}

/**
 * WHICH ICON AN EVENT GETS (§10).
 *
 * SIX FAMILIES, not one glyph per event type. An icon is a category cue that
 * lets the eye group a scrolling list; a unique drawing per event would be a
 * second vocabulary to learn, and it would go stale the moment a writer added
 * a type nobody drew for. Anything unrecognised falls back to the neutral dot,
 * which is what the whole list used before this.
 *
 * The icon and the row's tone come from the same `eventType`, so colour and
 * shape never disagree, and the sentence beside them always says what actually
 * happened — the icon is never the only carrier of meaning.
 */
type ActivityGlyph = "invite" | "member" | "role" | "workspace" | "review" | "key" | "dot";

function activityGlyph(eventType: string): ActivityGlyph {
  if (eventType.startsWith("invite_")) return "invite";
  if (eventType.startsWith("member_") && eventType !== "member_role_changed") return "member";
  if (eventType === "member_role_changed") return "role";
  if (eventType.startsWith("workspace_") || eventType === "team_renamed") return "workspace";
  if (
    eventType === "DECISION_LOGGED" ||
    eventType === "STAGE_CHANGED" ||
    eventType === "REVIEWER_NOTE_CREATED" ||
    eventType.startsWith("reviewer_")
  ) {
    return "review";
  }
  if (eventType.startsWith("integration.")) return "key";
  return "dot";
}

function ActivityIcon({ glyph }: { glyph: ActivityGlyph }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (glyph) {
    case "invite":
      return (
        <svg {...common}>
          <path d="M4 5h16v14H4z" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      );
    case "member":
      return (
        <svg {...common}>
          <path d="M18 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
          <circle cx="10.5" cy="7" r="4" />
        </svg>
      );
    case "role":
      return (
        <svg {...common}>
          <path d="M12 3 4 6v6c0 4.5 3.2 8.3 8 9 4.8-.7 8-4.5 8-9V6z" />
        </svg>
      );
    case "workspace":
      return (
        <svg {...common}>
          <path d="M3 9h18M3 9V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M3 9v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9" />
        </svg>
      );
    case "review":
      return (
        <svg {...common}>
          <path d="M9 11.5 11 13.5 15.5 9" />
          <path d="M5 4h14v16l-7-3-7 3z" />
        </svg>
      );
    case "key":
      return (
        <svg {...common}>
          <circle cx="8" cy="15" r="4" />
          <path d="m11 12 8-8 3 3-2 2-2-2-2 2" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}

/**
 * COMMERCIAL TRUTH CLOSURE (2026-09-08) — NO FABRICATED PLAN.
 *
 * This took a `fallback = "FREE"`, and the call site passed the raw
 * `billingPlan` column as its input. On a Personal Workspace that column is
 * always FREE (its only writer is Enterprise provisioning), and when the
 * server withheld it entirely — a VIEWER, or a response that predates
 * `effectivePlan` — the fallback invented FREE anyway. Two independent routes
 * to the same wrong sentence.
 *
 * A plan we were not told is `null`, and the caller renders nothing.
 */
function normalizePlanLabel(value?: string | null): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}

function TeamDetailPageBody() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const teamId = params?.id;

  // CR1.6 Part 4 — `currentUserId` is read directly from the canonical
  // platform envelope; no parallel /v1/users/me self-fetch.
  const platformCtx = usePlatformContext();
  const currentUserId = platformCtx.envelope?.user?.id ?? "";

  const [team, setTeam] = useState<Team | null>(null);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [teamCases, setTeamCases] = useState<TeamCase[]>([]);
  const [activities, setActivities] = useState<TeamActivity[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [teamName, setTeamName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<(typeof INVITE_ROLE_OPTIONS)[number]>("MEMBER");
  const [inviting, setInviting] = useState(false);

  const [roleSavingKey, setRoleSavingKey] = useState<string | null>(null);
  const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  // Phase 2.2 — Offboarding dialog. Holds the member the operator is
  // about to remove; `null` means "dialog closed". We keep a separate
  // state for the membership because the dialog needs the label/role
  // even after the parent's `team.members` array has been mutated.
  const [removalDialogMember, setRemovalDialogMember] = useState<
    TeamMember | null
  >(null);
  // Phase 2.6B — replace 2 remaining window.confirm calls with the
  // shared DangerConfirmModal. Each pending action holds its own
  // identifier so the modal knows which target to mutate.
  const [pendingInviteDelete, setPendingInviteDelete] = useState<{
    inviteId: string;
    email: string;
  } | null>(null);
  const [pendingCaseUnlink, setPendingCaseUnlink] = useState<{
    caseId: string;
    name: string;
  } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingTeam, setDeletingTeam] = useState(false);

  const [showAddCase, setShowAddCase] = useState(false);
  const [availableCases, setAvailableCases] = useState<AvailableCaseItem[]>([]);
  /**
   * PHASE 13 (NEW-049) — the ownership-transfer outcome, held at PAGE level.
   *
   * The transfer card is owner-gated and a successful transfer demotes the
   * actor, so the card unmounts on the refresh that follows its own success.
   * The sentence has to outlive it.
   */
  const [ownershipNotice, setOwnershipNotice] = useState<string | null>(null);
  const [loadingAvailableCases, setLoadingAvailableCases] = useState(false);
  const [linkingCaseId, setLinkingCaseId] = useState<string | null>(null);
  const [unlinkingCaseId, setUnlinkingCaseId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!teamId) return;

    setLoading(true);
    setError(null);

    try {
      // CR1.6 Part 4 — Dropped the /v1/users/me self-fetch. The
      // current user id now comes from `platformCtx.envelope.user.id`
      // (read above into `currentUserId`), eliminating a parallel
      // authority source that could disagree with the envelope.
      const [teamRes, invitesRes, casesRes, activitiesRes] =
        await Promise.all([
          apiFetch(`/v1/teams/${teamId}`) as Promise<Team>,
          (apiFetch(`/v1/teams/${teamId}/invites`).catch(() => ({
            invites: [],
          })) as Promise<TeamInvitesResponse>),
          (apiFetch(`/v1/teams/${teamId}/cases`).catch(() => ({
            items: [],
          })) as Promise<TeamCasesResponse>),
          (apiFetch(`/v1/teams/${teamId}/activity`).catch(() => ({
            activities: [],
          })) as Promise<TeamActivitiesResponse>),
        ]);

      setTeam(teamRes ?? null);
      setInvites(invitesRes?.invites ?? []);
      setTeamCases(casesRes?.items ?? []);
      setActivities(activitiesRes?.activities ?? []);
      setTeamName(teamRes?.name ?? "");
    } catch (err) {
      const message = toSafeUserError(err, { message: "Failed to load workspace" }).message;
      setError(message);
      setTeam(null);
      setInvites([]);
      setTeamCases([]);
      setActivities([]);
      captureException(err, { feature: "team_detail_load", teamId });
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [teamId, addToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const myMemberRecord = useMemo(() => {
    if (!team?.members || !currentUserId) return null;
    return team.members.find((member) => member.userId === currentUserId) ?? null;
  }, [team?.members, currentUserId]);

  const currentRole = team?.currentUserRole || myMemberRecord?.role || "VIEWER";
  // PHASE 12 POINT 4 STEP 1 — owner-only affordances (delete workspace,
  // workspace closure) read the SERVER projection, not a client role string.
  // DELETE /v1/teams/:id and the closure routes enforce OWNER themselves.
  const isOwner = team?.canManageWorkspace === true;
  // PHASE 12 POINT 4 STEP 1 — `canManageMembers` is the SERVER projection and
  // the ONLY authority here. The former `?? (currentRole === "OWNER" ||
  // currentRole === "ADMIN")` fallback made the browser the decision-maker
  // whenever the projection was missing, and `currentRole` itself defaults to
  // a client-side "VIEWER" guess. Absent projection now FAILS CLOSED; the
  // team routes enforce membership authority on every call regardless.
  const canManageTeam = team?.canManageMembers === true;

  // PHASE 11 §5 — the ONE billing workspace locator. The specific workspace
  // id is folded into the single canonical `?workspace=team:<id>` vocabulary;
  // the retired `?team=<uuid>` alias is gone.
  const billingConsoleHref = useMemo(
    () =>
      buildBillingHref(
        { kind: "team", teamId: teamId || null },
        { plan: "TEAM" },
      ),
    [teamId],
  );


  /**
   * ==========================================================================
   * THE PAGE'S DERIVED READS — all from the SERVER's projection.
   * ==========================================================================
   * Seat capacity comes from `team.stats`, which is the same seat state the
   * invitation gate enforces on. It is deliberately NOT counted from the rows
   * on screen: the roster is a page, and a capacity claim derived from a page
   * is wrong the moment there is a second one. `null` means UNKNOWN — the KPI
   * renders an em dash rather than substituting a number.
   */
  const billingHref = billingConsoleHref;

  const seatLimit = team?.stats?.seatLimit ?? null;
  const seatUsed = team?.stats?.seatUsed ?? null;
  const seatsAvailable =
    typeof team?.stats?.seatAvailable === "number"
      ? team.stats.seatAvailable
      : seatLimit !== null && seatUsed !== null
        ? Math.max(0, seatLimit - seatUsed)
        : null;

  const activeMemberCount = useMemo(
    () =>
      team?.stats?.memberCount ??
      (team?.members ?? []).filter((m) => m.status !== "SUSPENDED").length,
    [team?.stats?.memberCount, team?.members],
  );

  /** Only invitations still awaiting a decision belong in the pending list. */
  const pendingInvites = useMemo(
    () => invites.filter((i) => !i.acceptedAt),
    [invites],
  );

  const [memberSearch, setMemberSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  /**
   * Client-side search over the roster.
   *
   * Honest about its scope: `/v1/teams/:id/members` pages, and this filters
   * what the detail payload returned. It is labelled "Search people" rather
   * than implying a workspace-wide query, and the count beside it is the
   * SERVER's `memberCount`, so the two numbers never pretend to describe the
   * same set.
   */
  const visibleMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    const rows = team?.members ?? [];
    if (!q) return rows;
    return rows.filter((m) =>
      [m.user?.displayName, m.user?.email, m.label, m.role]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [team?.members, memberSearch]);

  /**
   * THE SERVER'S RESOLVED PLAN, OR NOTHING. UNKNOWN IS NOT FREE.
   *
   * This read `effectivePlan ?? billingPlan` and defaulted to `"FREE"`. Both
   * halves were wrong. `effectivePlan` was not projected by any route, so the
   * first operand was always undefined; `billingPlan` is the ADMIN-only raw
   * column the API itself documents as NOT the effective plan (meaningless on
   * a PERSONAL workspace). The result was that a MEMBER or VIEWER on a PRO
   * workspace read "FREE" — a commercial claim the page invented.
   *
   * `effectivePlan` is now projected by `GET /v1/teams/:id` from
   * `resolveCommercialContext`, the canonical authority. `billingPlan` is NOT
   * a fallback: a raw column that disagrees with the resolver must never win,
   * and a caller who cannot see it must not silently get a different answer
   * from one who can.
   *
   * `null` means UNKNOWN — loading, degraded, or an older server. Every
   * consumer below renders that as absence or an em dash. Nothing here may
   * substitute a plan name for a plan we do not have.
   */
  const effectivePlan = useMemo(() => {
    const resolved = team?.effectivePlan;
    return typeof resolved === "string" && resolved.trim()
      ? normalizePlanLabel(resolved)
      : null;
  }, [team?.effectivePlan]);

  /**
   * The owner's name for the Workspace overview, RESOLVED rather than assumed.
   *
   * `ownerUserId` is an id, and an id is not a fact a reader can use. The
   * roster already carries the display name and email for everyone with
   * access, so the owner is looked up there. If the owner is not in the loaded
   * roster — a paged roster is a page — this returns null and the row is not
   * rendered at all. An "Owner: unknown" row would be worse than no row.
   */
  const ownerLabel = useMemo(() => {
    const ownerId = team?.ownerUserId;
    if (!ownerId) return null;
    const owner = (team?.members ?? []).find((m) => m.userId === ownerId);
    return (
      owner?.user?.displayName?.trim() || owner?.user?.email?.trim() || null
    );
  }, [team?.ownerUserId, team?.members]);

  /**
   * SEATS COME FROM THE SERVER, NOT FROM RAW COLUMNS.
   *
   * This was `team?.maxMembersPerTeam ?? team?.includedSeats ?? 5`.
   * `maxMembersPerTeam` is not in the response at all, and `includedSeats` is a
   * raw column that only Enterprise provisioning ever writes — so every
   * self-service workspace fell through to 0 and this page told a 1,005-member
   * TEAM workspace "Members: 1005 / 0 · 0 remaining" and "the actual member cap
   * is 0 per team".
   *
   * `stats.seatLimit` / `seatUsed` / `seatAvailable` are the API's own
   * projection of the canonical seat resolver — the same numbers the invitation
   * gate enforces. A page that computes its own capacity will always eventually
   * disagree with the gate; the only fix is to stop computing it.
   *
   * `null` means the projection has not arrived. It is rendered as unknown
   * rather than as a fabricated number.
   */

  // PHASE 13 — POST /v1/teams/:id/transfer-ownership can only target an
  // ACTIVE member who is not already the owner; the roster the page already
  // read is the source, so the control never offers an ineligible target.
  const ownershipTransferCandidates = useMemo(
    () =>
      (team?.members ?? [])
        .filter(
          (member) =>
            member.userId !== team?.ownerUserId &&
            member.userId !== currentUserId,
        )
        .map((member) => ({
          userId: member.userId,
          label:
            member.user?.displayName ||
            member.label ||
            member.user?.email ||
            member.userId,
        })),
    [team?.members, team?.ownerUserId, currentUserId],
  );

  const handleStartEditName = () => {
    setTeamName(team?.name ?? "");
    setIsEditingName(true);
  };

  const handleCancelEditName = () => {
    setTeamName(team?.name ?? "");
    setIsEditingName(false);
  };

  const handleSaveTeamName = async () => {
    if (!teamId || !canManageTeam || !teamName.trim()) return;

    setSavingName(true);
    try {
      const updated = await apiFetch(`/v1/teams/${teamId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: teamName.trim() }),
      });

      setTeam((prev) =>
        prev
          ? {
              ...prev,
              name: updated?.name ?? teamName.trim(),
            }
          : prev
      );

      setIsEditingName(false);
      addToast("Workspace name updated", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to update workspace name" }).message;
      captureException(err, { feature: "team_name_update", teamId });
      addToast(message, "error");
    } finally {
      setSavingName(false);
    }
  };

  const handleInvite = async () => {
    if (!teamId || !inviteEmail.trim() || !canManageTeam) return;

    setInviting(true);
    try {
      const data = await apiFetch(`/v1/teams/${teamId}/invites`, {
        method: "POST",
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
        }),
      });

      if (data?.invite) {
        setInvites((prev) => {
          const existingIndex = prev.findIndex((item) => item.id === data.invite.id);

          if (existingIndex >= 0) {
            const copy = [...prev];
            copy[existingIndex] = {
              ...copy[existingIndex],
              ...data.invite,
            };
            return copy;
          }

          return [
            {
              ...data.invite,
            },
            ...prev,
          ];
        });
      }

      setInviteEmail("");
      setInviteRole("MEMBER");
      addToast("Invitation created successfully", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to invite member" }).message;
      captureException(err, { feature: "team_invite_create", teamId });
      addToast(message, "error");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (
    member: TeamMember,
    nextRole: (typeof MANAGEABLE_ROLE_OPTIONS)[number]
  ) => {
    /**
     * WCR-02 (2026-09-07) — THE ROUTE WANTS THE MEMBERSHIP ID.
     *
     * This sent `member.userId` to `/v1/teams/:id/members/:memberId`, and the
     * route resolves `:memberId` against `TeamMember.id`. Both are uuids, so
     * zod accepted it, the lookup matched nothing, and EVERY role change
     * returned 404 "Member not found".
     *
     * Workspace role administration was therefore non-functional in the
     * product, and `changeWorkspaceMemberRole` — the canonical authority wired
     * in specifically to close the ADMIN→OWNER escalation — had no working
     * caller. `MemberRemovalDialog` documents this exact trap in a comment
     * ("Passing `userId` here would return 404") and uses the right field;
     * this handler did not.
     *
     * `member.id` is optional on the type because the projection predates the
     * field, so a row without one is refused here rather than being sent to a
     * URL that would 404 anyway.
     */
    if (!teamId || !canManageTeam || !member.id) return;

    setRoleSavingKey(member.userId);

    try {
      const data = await apiFetch(`/v1/teams/${teamId}/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });

      setTeam((prev) => {
        if (!prev) return prev;

        return {
          ...prev,
          members:
            prev.members?.map((m) =>
              m.userId === member.userId
                ? { ...m, role: data?.member?.role ?? nextRole }
                : m
            ) ?? [],
        };
      });

      addToast("Member role updated", "success");
    } catch (err) {
      const message = toSafeUserError(err, { message: "Failed to update role" }).message;
      captureException(err, {
        feature: "team_member_role_update",
        teamId,
        memberId: member.userId,
      });
      addToast(message, "error");
    } finally {
      setRoleSavingKey(null);
    }
  };

  // Phase 2.2 — replaces the bare `window.confirm` flow. The actual
  // DELETE now happens inside <MemberRemovalDialog>, which fetches
  // `/removal-impact`, requires a transfer target if the member owns
  // active records, and passes `transferToUserId` to the DELETE call.
  // We keep the `removingMemberId` UI state so the row-level button
  // can show "Removing..." once the dialog reports success and we
  // start applying the optimistic local removal.
  const handleRemoveMember = (member: TeamMember) => {
    if (!teamId || !canManageTeam || !member.userId) return;
    setRemovalDialogMember(member);
  };

  const handleRemovalConfirmed = (member: TeamMember) => {
    if (!member.userId) return;
    // The DELETE already succeeded inside the dialog — just apply the
    // optimistic local update + toast here. We do NOT issue another
    // DELETE.
    setRemovingMemberId(member.userId);
    try {
      setTeam((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members:
            prev.members?.filter((m) => m.userId !== member.userId) ?? [],
          stats: prev.stats
            ? {
                ...prev.stats,
                memberCount: Math.max(0, prev.stats.memberCount - 1),
              }
            : prev.stats,
        };
      });
      addToast("Member removed", "success");
    } finally {
      setRemovingMemberId(null);
      setRemovalDialogMember(null);
    }
  };

  // Phase 2.6B — entry point. The actual DELETE now runs inside the
  // DangerConfirmModal's onConfirm handler (handleConfirmDeleteInvite).
  const handleDeleteInvite = (inviteId: string) => {
    if (!teamId || !canManageTeam) return;
    const invite = invites.find((i) => i.id === inviteId);
    setPendingInviteDelete({
      inviteId,
      email: invite?.email ?? "this invite",
    });
  };

  const handleConfirmDeleteInvite = async () => {
    if (!teamId || !canManageTeam || !pendingInviteDelete) return;
    const inviteId = pendingInviteDelete.inviteId;

    setDeletingInviteId(inviteId);

    try {
      await apiFetch(`/v1/teams/${teamId}/invites/${inviteId}`, {
        method: "DELETE",
      });

      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
      addToast("Invite deleted", "success");
      // Close the modal on success. On failure the modal stays open
      // so the operator can retry — DangerConfirmModal surfaces the
      // error inline via its onConfirm rejection contract.
      setPendingInviteDelete(null);
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to delete invite" }).message;
      captureException(err, { feature: "team_invite_delete", teamId, inviteId });
      // Re-throw so DangerConfirmModal can surface the error inline.
      throw new Error(message);
    } finally {
      setDeletingInviteId(null);
    }
  };

  const handleDeleteTeam = async () => {
    if (!teamId || !isOwner) return;

    setDeletingTeam(true);

    try {
      await apiFetch(`/v1/teams/${teamId}`, {
        method: "DELETE",
      });

      addToast("Workspace deleted successfully", "success");
      setTimeout(() => {
        router.push("/workspaces");
      }, 300);
    } catch (err) {
      const message = toSafeUserError(err, { message: "Failed to delete workspace" }).message;
      captureException(err, { feature: "team_delete", teamId });
      addToast(message, "error");
    } finally {
      setDeletingTeam(false);
      setDeleteConfirm(false);
    }
  };

  const loadAvailableCases = async () => {
    if (!teamId || !canManageTeam) return;

    setLoadingAvailableCases(true);

    try {
      const data = (await apiFetch("/v1/cases")) as CasesListResponse;
      const existing = new Set(teamCases.map((c) => c.id));

      const available = (data.items ?? []).filter(
        (item) => !existing.has(item.id) && !item.teamId
      );

      setAvailableCases(available);
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to load available cases" }).message;
      captureException(err, { feature: "team_available_cases_load", teamId });
      addToast(message, "error");
    } finally {
      setLoadingAvailableCases(false);
    }
  };

  const handleAddExistingCase = async (caseId: string) => {
    if (!teamId || !canManageTeam) return;

    setLinkingCaseId(caseId);

    try {
      await apiFetch(`/v1/teams/${teamId}/cases/link`, {
        method: "POST",
        body: JSON.stringify({ caseId }),
      });

      const linkedCase = availableCases.find((c) => c.id === caseId);
      if (linkedCase) {
        setTeamCases((prev) => [{ ...linkedCase, teamId }, ...prev]);
        setAvailableCases((prev) => prev.filter((c) => c.id !== caseId));
      }

      addToast("Case linked successfully", "success");
    } catch (err) {
      const message = toSafeUserError(err, { message: "Failed to link case" }).message;
      captureException(err, { feature: "team_case_link", teamId, caseId });
      addToast(message, "error");
    } finally {
      setLinkingCaseId(null);
    }
  };

  // Phase 2.6B — entry point. The actual DELETE runs inside the
  // DangerConfirmModal's onConfirm handler (handleConfirmUnlinkCase).
  const handleUnlinkTeamCase = (caseId: string) => {
    if (!teamId || !canManageTeam) return;
    const c = teamCases.find((item) => item.id === caseId);
    setPendingCaseUnlink({ caseId, name: c?.name ?? "this case" });
  };

  const handleConfirmUnlinkCase = async () => {
    if (!teamId || !canManageTeam || !pendingCaseUnlink) return;
    const caseId = pendingCaseUnlink.caseId;

    setUnlinkingCaseId(caseId);

    try {
      await apiFetch(`/v1/teams/${teamId}/cases/${caseId}`, {
        method: "DELETE",
      });

      const removedCase = teamCases.find((item) => item.id === caseId) ?? null;

      setTeamCases((prev) => prev.filter((item) => item.id !== caseId));

      if (removedCase) {
        setAvailableCases((prev) => {
          const exists = prev.some((item) => item.id === removedCase.id);
          if (exists) return prev;
          return [{ ...removedCase, teamId: null }, ...prev];
        });
      }

      addToast("Case removed from workspace", "success");
      setPendingCaseUnlink(null);
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to remove case from workspace" }).message;
      captureException(err, { feature: "team_case_unlink", teamId, caseId });
      throw new Error(message);
    } finally {
      setUnlinkingCaseId(null);
    }
  };

  /*
   * WCR-24 (2026-09-07) — `copyInviteLink` and the "Copy link" button DELETED.
   *
   * The API stopped returning `inviteUrl` when the invitation token became
   * hash-only: the raw token exists just long enough to be put in an email and
   * is never persisted or projected, because a create response carrying it
   * turns every operator with API access into a holder of live workspace
   * credentials. The field has been `undefined` on every response since, so the
   * button's own `invite.inviteUrl ?` guard meant it never rendered.
   *
   * Dead either way — but dead code that reads like a feature is how a feature
   * gets "restored" by putting the token back in the response.
   */

  /**
   * ==========================================================================
   * NON-CONTENT STATES — the same grammar as the page they stand in for.
   * ==========================================================================
   * These two used to be a separate design entirely: a dark `app-hero` band
   * with an uppercase letter-spaced eyebrow, a 2.72rem two-tone headline, and
   * a silver photographic panel behind a 30px-radius card. A person who hit a
   * load failure was shown a different product from the one they had asked
   * for, and the recovery buttons were the page-local gradient pair rather
   * than anything the rest of the app uses.
   *
   * They now render inside the SAME `.app-section` / `.app-section-stack`
   * shell and behind the SAME `.app-page-header` as the loaded page, so the
   * frame does not move when the data arrives — only the body swaps. That is
   * also why the header here carries no actions: there is nothing yet to act
   * on, and a disabled "Invite person" would be a promise the state cannot
   * keep.
   *
   * The error state offers `Try again` (`loadData` re-arms both `loading` and
   * `error`, and is safe to call repeatedly) and a way out to Workspaces. It
   * deliberately does NOT link Billing: a failed read says nothing about the
   * subscription, and sending someone to a payment surface to explain a fetch
   * error invents a commercial cause the page has no evidence for.
   */
  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-section-stack">
          <div className="app-page-header" data-testid="people-header">
            <div className="app-page-header__lead">
              <span className="app-page-header__icon" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <div className="app-page-header__text">
                <h1 className="app-page-header__title">Members &amp; Access</h1>
                <p className="app-page-header__subtitle">
                  Loading members, invitations and workspace cases…
                </p>
              </div>
            </div>
          </div>

          <div
            className="app-grid-kpis"
            aria-hidden="true"
            data-testid="people-kpis-loading"
          >
            {[0, 1, 2, 3].map((i) => (
              <div className="app-kpi-card" key={i}>
                <div
                  className="app-skeleton"
                  style={{ width: "44%", height: 26, borderRadius: 8 }}
                />
                <div
                  className="app-skeleton"
                  style={{
                    width: "68%",
                    height: 12,
                    borderRadius: 6,
                    marginTop: 10,
                  }}
                />
              </div>
            ))}
          </div>

          <div
            className="app-table-surface"
            aria-busy="true"
            aria-live="polite"
            aria-label="Loading members"
            data-testid="people-table-loading"
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="app-skeleton-row">
                <div
                  className="app-skeleton"
                  style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0 }}
                />
                <div
                  className="app-skeleton"
                  style={{ flex: "1 1 auto", height: 12, borderRadius: 6 }}
                />
                <div
                  className="app-skeleton"
                  style={{ width: 120, height: 12, borderRadius: 6 }}
                />
                <div
                  className="app-skeleton"
                  style={{ width: 84, height: 22, borderRadius: 999 }}
                />
              </div>
            ))}
            <span className="app-visually-hidden">Loading members…</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !team) {
    return (
      <div className="section app-section">
        <div className="app-section-stack">
          <div className="app-page-header" data-testid="people-header">
            <div className="app-page-header__lead">
              <span className="app-page-header__icon" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <div className="app-page-header__text">
                <h1 className="app-page-header__title">Members &amp; Access</h1>
              </div>
            </div>
          </div>

          <div
            className="app-empty"
            data-tone="danger"
            role="alert"
            data-testid="people-error"
          >
            <strong>Couldn&apos;t load this workspace</strong>
            <p>
              {error ||
                "Workspace not found, or you no longer have access to it."}
            </p>
            <div className="app-empty__actions">
              <button
                type="button"
                className="app-primary-action"
                onClick={() => void loadData()}
                data-testid="people-error-retry"
              >
                Try again
              </button>
              <Link
                href="/workspaces"
                className="app-secondary-action"
                data-testid="people-error-workspaces"
              >
                Back to workspaces
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /**
   * WORKSPACE PEOPLE — rebuilt on the canonical `app-*` grammar.
   *
   * ==========================================================================
   * WHAT WAS REMOVED, AND WHY
   * ==========================================================================
   * This surface carried a visual language from an earlier generation of the
   * product and shared it with nothing: ~270 lines of page-local `<style jsx
   * global>`, silver photographic panel textures behind every card
   * (`/images/panel-silver.webp.png`), 18px radii, a green-grey gradient form
   * control with a brown chevron drawn as an inline data-URI, and three button
   * styles built per-render with `useMemo` so no two cards agreed on what a
   * primary action looked like.
   *
   * None of it was a token. It could not follow a theme change, it duplicated
   * primitives the rest of the product already had, and it made the page read
   * as a different application from Evidence, Home and Intake Links.
   *
   * Every one of those is replaced by the canonical primitive that already
   * existed: `.app-page-header`, `.app-panel`, `.app-grid-kpis`/`.app-kpi-card`,
   * `.app-table-surface`/`.app-table[data-responsive]`, `.app-empty`,
   * `.app-search-field`, `AppListbox`, `AppStatusText`, and the ONE action
   * hierarchy — `.app-primary-action` (purple), `.app-secondary-action--filled`
   * (dark), `.app-secondary-action` (light), `.app-secondary-action--danger`
   * (outlined destructive). No new class is invented here.
   *
   * ==========================================================================
   * WHAT THE PAGE IS FOR
   * ==========================================================================
   * Identity, access, membership, invitations and roles. The people table is
   * the primary object and everything else is subordinate to it.
   *
   * Three things that used to compete with it no longer do:
   *   - the role/permission matrix was a full-width grid that dominated the
   *     page; it is behind "Role permissions" now, in a dialog, unchanged;
   *   - the workspace/billing block reproduced a billing dashboard; it is a
   *     seat KPI and a link to the surface that owns billing;
   *   - case linkage and activity are workspace ADMINISTRATION rather than
   *     people management, so they sit below the roster instead of beside it.
   *     They are kept rather than dropped because `POST /v1/teams/:id/cases/link`
   *     has no other surface in the product, and removing the only door to a
   *     capability is not a redesign.
   *
   * Ownership transfer, workspace closure and deletion stay reachable and are
   * separated into their own region, because a control that ends a workspace
   * should not sit in the same visual rank as changing somebody's role.
   */
  return (
    <div className="section app-section">
      <div className="app-section-stack">
        {/* HEADER — who am I managing, as what, and the one primary action. */}
        <div className="app-page-header" data-testid="people-header">
          <div className="app-page-header__lead">
            <span className="app-page-header__icon" aria-hidden="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
            <div className="app-page-header__text">
              <h1 className="app-page-header__title">Members &amp; Access</h1>
              <p className="app-page-header__subtitle">
                {/*
                  WHAT THIS SURFACE DECIDES, in one line.

                  The page used to name only the workspace and the reader's
                  role, which said who was looking rather than what the page
                  is for. Beside "Collaboration Teams" the two surfaces have to
                  be tellable apart at a glance: this one governs ACCESS to the
                  workspace, that one governs how members work once they have
                  it. Kept to a sentence — the distinction is taught by the
                  wording and the cross-link below, not by a banner.
                */}
                Who can access {team.name} — members, invitations, roles and
                access governance. You are {currentRole}
                {effectivePlan ? ` · ${effectivePlan} plan` : ""}
              </p>
            </div>
          </div>
          <div className="app-page-header__actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setPermissionsOpen(true)}
              data-testid="people-open-permissions"
            >
              Role permissions
            </button>
            {canManageTeam ? (
              <button
                type="button"
                className="app-primary-action"
                onClick={() => setInviteOpen(true)}
                data-testid="people-invite-open"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Invite person
              </button>
            ) : null}
          </div>
        </div>

        {/* SUMMARY — the four numbers a person managing access needs. Seats
            come from the SERVER's projection (`team.stats`), never counted
            from the rows on screen: the roster is a page, and a capacity claim
            derived from a page is wrong the moment there is a second one. */}
        {/*
          THE NOTIFICATIONS CARD ITSELF (§10), NOT AN APPROXIMATION OF IT.

          A previous pass read "use the Notifications card language" as "tint
          the card" and painted four pastel rectangles. That is the opposite of
          what Notifications does. Its summary strip is `.app-metric-card`: a
          near-white translucent surface, a 3px semantic rail down the inline
          start, the NUMBER carrying the colour, a dark label and a muted
          caption. The colour is in the accent and the figure; the surface stays
          out of the way. These cards are that component — the same class, the
          same rail, the same typography — not a second design that resembles it.

          They are <div>s inside a <ul>, because unlike Notifications these
          figures are read rather than clicked; the primitive drops its pointer
          affordances for anything that is not a control.

          TONE IS CONDITIONAL WHERE THE CONDITION IS THE POINT: seats go red
          only at zero, invitations amber only while some are waiting. A
          permanent warning colour on a healthy workspace is decoration, and
          decoration is what makes a real warning unreadable.
        */}
        <ul className="app-grid-kpis" data-testid="people-kpis">
          <li>
            <div className="app-metric-card" data-app-metric-tone="success">
              <span className="app-metric-card__value">{activeMemberCount}</span>
              <span className="app-metric-card__label">Active members</span>
              <span className="app-metric-card__meta">
                With access to this workspace
              </span>
            </div>
          </li>
          <li>
            <div
              className="app-metric-card"
              /*
               * UI POLISH (2026-09-09) — the tone is the SUBJECT, not the count.
               *
               * This flipped to neutral at zero, so the card changed colour
               * depending on its own value. The metric is "invitations sent and
               * not yet accepted" either way, and greying it at zero makes a
               * reader look twice to work out whether the card means something
               * different today. Notifications uses the same canonical warning
               * tone for its High metric and does not grey it at zero.
               */
              data-app-metric-tone="warning"
            >
              <span className="app-metric-card__value">
                {pendingInvites.length}
              </span>
              <span className="app-metric-card__label">Pending invitations</span>
              <span className="app-metric-card__meta">
                Sent, not yet accepted
              </span>
            </div>
          </li>
          <li>
            <div
              className="app-metric-card"
              data-app-metric-tone={
                seatsAvailable === 0
                  ? "danger"
                  : seatsAvailable === null
                    ? "neutral"
                    : "info"
              }
            >
              <span className="app-metric-card__value">
                {seatsAvailable === null ? "—" : seatsAvailable}
              </span>
              <span className="app-metric-card__label">Seats available</span>
              <span className="app-metric-card__meta">
                {seatLimit === null
                  ? "Capacity unavailable"
                  : `${seatUsed ?? activeMemberCount} of ${seatLimit} used`}
              </span>
            </div>
          </li>
          <li>
            <div className="app-metric-card" data-app-metric-tone="accent">
              <span className="app-metric-card__value">{teamCases.length}</span>
              <span className="app-metric-card__label">
                Cases in this workspace
              </span>
              <span className="app-metric-card__meta">
                <Link href="/cases" className="app-table__link">
                  Open Cases
                </Link>
              </span>
            </div>
          </li>
        </ul>

        {/* A seat-full workspace says so once, here, rather than letting the
            operator discover it from a refusal after composing an invitation. */}
        {seatsAvailable === 0 ? (
          <div className="app-panel" data-testid="people-seats-full">
            <div className="app-panel__body">
              <strong>Every seat is in use.</strong>{" "}
              <span className="app-table__muted">
                A new person can be invited once a seat frees up, or when the
                plan is changed.{" "}
                <Link href={billingHref} className="app-table__link">
                  Review plan and seats
                </Link>
                .
              </span>
            </div>
          </div>
        ) : null}

        {/*
          THE ASYMMETRIC WORKING GRID (§3).

          Every panel on this page used to be full-page-width, stacked, in a
          single column — which is why a workspace with four members read as a
          long administration form with a great deal of nothing in it. The
          roster is the primary working surface and keeps roughly three
          quarters of the row; the rail beside it carries the two things an
          operator reaches for WHILE reading the roster, at a size that says
          they are secondary.

          The rail holds only capabilities this page already has. There is no
          "Copy invite link" (the canonical invitation flow delivers by email
          and mints no shareable link), no export, no access-request queue and
          no permission matrix — none of those exist behind this surface, and a
          control that looks real and does nothing is worse than an empty
          column.
        */}
        {/*
          THE PAGE IS ONE GRID NOW (§14, §15).

          It used to be a grid for the roster and its rail, then a full-width
          panel, then a THREE-column grid of unrelated cards, then another
          two-column grid — four different column counts down one page, so
          nothing lined up with anything and the eye had no left edge to
          follow. Panels also changed rank between sections: the Collaboration
          Teams bridge (a signpost) sat at the same width as the roster.

          There are two columns for the whole page. The LEFT column carries
          what an operator works IN — the roster, outstanding invitations,
          the activity trail, the workspace facts and the lifecycle
          operations. The RIGHT rail carries what they refer TO while doing
          it: how to invite, who holds what access, and the two contextual
          links out. Every rail card is the same width and the two columns
          share one top edge.
        */}
        <div className="app-grid-primary">
        <div className="app-main-column">
        {/* MEMBERS — the primary object on the page. */}
        <div className="app-panel" data-testid="people-roster">
          <div className="app-panel__head app-panel__head-row">
            <h2 className="app-panel__title">Members</h2>
            <div className="app-search-field">
              <span className="app-search-icon" aria-hidden="true">
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
                className="app-search-input"
                placeholder="Search members"
                aria-label="Search members"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                data-testid="people-search"
              />
            </div>
          </div>
          <div className="app-table-surface">
            {visibleMembers.length === 0 ? (
              <div className="app-empty" data-testid="people-empty">
                <span className="app-empty__icon" aria-hidden>
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                </span>
                <strong>
                  {memberSearch.trim()
                    ? "Nobody here matches that"
                    : "You are the only person in this workspace"}
                </strong>
                <p>
                  {memberSearch.trim()
                    ? "Try a different name or address."
                    : "Invite a colleague to give them access to this workspace's evidence, cases and reports."}
                </p>
                {!memberSearch.trim() && canManageTeam ? (
                  <div className="app-empty__actions">
                    <button
                      type="button"
                      className="app-primary-action"
                      onClick={() => setInviteOpen(true)}
                      data-testid="people-empty-invite"
                    >
                      Invite person
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <table className="app-table" data-responsive>
                {/*
                  PROPORTION, DECLARED (§11).

                  Without a colgroup the browser sizes these columns from their
                  CONTENT, so a four-letter role and a date each claimed as much
                  room as the person — the identity, the only column anyone
                  scans, got whatever was left. `auto` on Person means it takes
                  the remainder; every other column is pinned to what its
                  content actually needs. `data-responsive` drops the whole
                  table to stacked rows on a narrow viewport, where a colgroup
                  no longer applies.
                */}
                <colgroup>
                  <col style={{ width: "auto" }} />
                  <col style={{ width: 168 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 108 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Joined</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMembers.map((member) => {
                    const label = memberLabel(member);
                    const isSelf = member.userId === currentUserId;
                    const isTeamOwner = member.role === "OWNER";
                    /**
                     * The row offers a role control only where the server would
                     * accept the change: OWNER moves by transfer, and nobody
                     * edits their own role. The server re-checks both — this
                     * only avoids showing a control whose use is refused.
                     */
                    const roleEditable =
                      canManageTeam && !isSelf && !isTeamOwner;
                    return (
                      <tr key={member.id ?? member.userId}>
                        <td data-label="Person">
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 10,
                              minWidth: 0,
                            }}
                          >
                            <span className="app-avatar" aria-hidden>
                              {(label.trim()[0] ?? "?").toUpperCase()}
                            </span>
                            <span
                              className="app-table__identity"
                              title={
                                member.user?.email
                                  ? `${label} · ${member.user.email}`
                                  : label
                              }
                            >
                              <span className="app-table__primary">
                                {label}
                                {isSelf ? " (you)" : ""}
                              </span>
                              {member.user?.email ? (
                                <span className="app-table__muted app-identity">
                                  {member.user.email}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        <td data-label="Role">
                          {roleEditable ? (
                            <div style={{ maxWidth: 150 }}>
                              <AppListbox
                                value={member.role}
                                options={ROLE_OPTIONS.map((r) => ({
                                  value: r,
                                  label: workspaceRoleLabel(r),
                                }))}
                                onChange={(next) =>
                                  void handleRoleChange(
                                    member,
                                    next as (typeof MANAGEABLE_ROLE_OPTIONS)[number],
                                  )
                                }
                                ariaLabel={`Workspace role for ${label}`}
                                id={`member-role-${member.id ?? member.userId}`}
                                disabled={
                                  roleSavingKey === (member.id ?? member.userId)
                                }
                              />
                            </div>
                          ) : (
                            <AppStatusText
                              tone={isTeamOwner ? "indigo" : "slate"}
                            >
                              {workspaceRoleLabel(member.role)}
                            </AppStatusText>
                          )}
                        </td>
                        <td data-label="Status">
                          <AppStatusText
                            tone={
                              member.status === "SUSPENDED" ? "amber" : "green"
                            }
                          >
                            {member.status === "SUSPENDED"
                              ? "Suspended"
                              : "Active"}
                          </AppStatusText>
                        </td>
                        <td data-label="Joined" className="app-table__muted">
                          {member.createdAt
                            ? formatUserDate(member.createdAt)
                            : "—"}
                        </td>
                        <td data-label="" style={{ textAlign: "right" }}>
                          {canManageTeam && !isSelf && !isTeamOwner ? (
                            <button
                              type="button"
                              className="app-secondary-action app-secondary-action--danger"
                              onClick={() => handleRemoveMember(member)}
                              disabled={
                                removingMemberId === (member.id ?? member.userId)
                              }
                              data-testid={`member-remove-${member.id ?? member.userId}`}
                            >
                              Remove
                            </button>
                          ) : (
                            <span className="app-table__muted" aria-hidden>
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* THE RAIL. */}

        {/* PENDING INVITATIONS — only rendered when there are any, or when the
            viewer can create one. An empty panel on a one-person workspace is
            noise. */}
        {pendingInvites.length > 0 || canManageTeam ? (
          <div className="app-panel" data-testid="people-invites">
            <div className="app-panel__head">
              <h2 className="app-panel__title">Pending invitations</h2>
            </div>
            {/*
              ZERO IS A SENTENCE, NOT A SLAB (§6).

              The empty case used to render `.app-empty` inside a table
              surface — a centred illustration-scale empty state, at full page
              width, for the most common state this panel has. It said nothing
              a single line could not, and it pushed everything below it most
              of a screen down.

              The panel is still here at zero, on purpose: it is where an
              operator looks to confirm nothing is outstanding, and a section
              that vanishes when empty cannot answer that question. It just
              costs one row now. The delivery channel is stated because it is
              the thing an operator needs to know and cannot see — invitations
              go out by EMAIL, and there is no other channel.
            */}
            {pendingInvites.length === 0 ? (
              <div className="app-panel__body" data-testid="people-invites-empty">
                <p className="app-table__muted" style={{ margin: 0 }}>
                  No invitations outstanding — everyone invited has either
                  joined or had their invitation withdrawn. New invitations are
                  delivered by email.
                </p>
              </div>
            ) : (
              <div className="app-table-surface">
                {(
                <table className="app-table" data-responsive>
                  <thead>
                    <tr>
                      <th scope="col">Invited</th>
                      <th scope="col">Role</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Expires</th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingInvites.map((invite) => (
                      <tr key={invite.id}>
                        <td data-label="Invited">
                          <span className="app-table__primary app-identity">
                            {invite.email}
                          </span>
                        </td>
                        <td data-label="Role">
                          <AppStatusText tone="slate">
                            {workspaceRoleLabel(invite.role)}
                          </AppStatusText>
                        </td>
                        <td data-label="Sent" className="app-table__muted">
                          {invite.createdAt
                            ? formatUserDate(invite.createdAt)
                            : "—"}
                        </td>
                        <td data-label="Expires" className="app-table__muted">
                          {invite.expiresAt
                            ? formatUserDate(invite.expiresAt)
                            : "—"}
                        </td>
                        <td data-label="" style={{ textAlign: "right" }}>
                          {canManageTeam ? (
                            <button
                              type="button"
                              className="app-secondary-action app-secondary-action--danger"
                              onClick={() => handleDeleteInvite(invite.id)}
                              disabled={deletingInviteId === invite.id}
                              data-testid={`invite-revoke-${invite.id}`}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span className="app-table__muted" aria-hidden>
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                )}
              </div>
            )}
          </div>
        ) : null}

        {/*
          THE GIANT "WORKSPACE" CARD IS GONE (§5).

          It was a full-width panel carrying a Rename button and one sentence
          saying billing lives somewhere else. That is two facts, and it claimed
          the same footprint as the roster. Neither fact was lost: Rename is now
          an action on the Workspace overview below, where the name it renames
          is actually displayed, and the billing sentence is one row of that
          overview with a link out. A panel earns its width from what is inside
          it, and this one never had anything to put there.
        */}


        {/*
          RECENT ACTIVITY — THE FULL WIDTH OF THE COLUMN IT LIVES IN (§10).

          It shared a two-column row with the workspace facts, which made the
          page's most chronological surface half as wide as the roster above
          it and squeezed its timestamps into a 300px column. Workspace
          overview is a rail card now, so activity takes the main column
          outright and its rows line up with the roster and the invitations.
        */}
          {/*
            RECENT ACTIVITY — a marker, a sentence, a time (§7).

            The events themselves are unchanged and still come from the server;
            nothing is invented to pad the list. What changed is that an event
            is now a two-line entry with a semantic dot rather than a full-width
            flex row whose timestamp was pushed to the far edge of the page. The
            list keeps its shape whether it holds one event or twelve, which is
            the case that made the old panel look broken.
          */}
          {activities.length > 0 ? (
            <div className="app-panel" data-testid="people-activity">
              <div className="app-panel__head">
                <h2 className="app-panel__title">Recent activity</h2>
              </div>
              <div className="app-panel__body">
                <ul className="app-activity-list">
                  {activities.slice(0, 12).map((a) => (
                    <li
                      key={a.id}
                      className="app-activity-item"
                      data-activity-tone={activityTone(a.eventType)}
                    >
                      <span
                        className="app-activity-item__marker"
                        aria-hidden="true"
                      >
                        <ActivityIcon glyph={activityGlyph(a.eventType)} />
                      </span>
                      <span className="app-activity-item__text">
                        {humanizeActivity(a)}
                        <span className="app-activity-item__time">
                          {a.createdAt ? formatUserDateTime(a.createdAt) : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}


        {/*
          LIFECYCLE — separated on purpose.

          Transferring ownership, closing a workspace and deleting it are not
          the same kind of act as changing somebody's role, and they used to
          sit in the same visual rank as everything else. They keep their own
          region, their own heading and the outlined destructive treatment the
          design system defines, so the difference is visible before the click
          rather than after it.
        */}
        {/*
          THE TRANSFER OUTCOME LIVES OUTSIDE THE OWNER GATE, ON PURPOSE.

          A successful transfer demotes the caller: the refresh that follows it
          returns `canManageWorkspace: false`, `isOwner` flips, and the whole
          lifecycle region below unmounts — taking any message rendered inside
          it with it. The one moment the sentence matters is the moment the
          card that produced it disappears, so it is announced here, above the
          gate, in a live region.
        */}
        {ownershipNotice ? (
          <div
            className="app-panel"
            data-testid="people-ownership-notice"
            data-workspace-ownership-notice
            role="status"
            aria-live="polite"
          >
            <div className="app-panel__body">{ownershipNotice}</div>
          </div>
        ) : null}

        {isOwner ? (
          <div data-testid="people-lifecycle" className="app-section-stack">
            <h2 className="app-panel__title" style={{ marginBottom: 0 }}>
              Workspace lifecycle
            </h2>
            {/*
              THREE FULL-WIDTH SLABS BECAME A GRID (§5).

              Transfer, close and delete each held a paragraph and one button
              and each took the whole page width, so the most consequential
              region on the surface was also the emptiest — an operator scrolled
              past several hundred pixels of white to reach three short
              controls. They are the same panels with the same copy and the
              same canonical danger treatment; only the layout changed.

              The region STAYS separated at the bottom under its own heading,
              because these are the operations that end things. Compact is not
              the same as hidden.
            */}
            {/*
              Each card repeats the `isOwner` condition the region already
              applies. That redundancy is deliberate: these are the page's
              authorization boundaries, and a reader should be able to see that
              a card is owner-only from the card's own line rather than by
              walking up the tree to find out.
            */}
            <div className="app-grid-panels app-grid-panels--stretch">
            {isOwner && teamId ? (
              <WorkspaceOwnershipTransferCard
                teamId={teamId}
                teamName={team?.name ?? "this workspace"}
                candidates={ownershipTransferCandidates}
                onTransferred={async (notice) => {
                  setOwnershipNotice(notice);
                  await loadData();
                }}
              />
            ) : null}
            {isOwner && teamId ? <WorkspaceClosureCard teamId={teamId} /> : null}
            <div
              className="app-panel app-panel--actions-bottom"
              data-testid="people-delete-workspace"
            >
              <div className="app-panel__head">
                <h3 className="app-panel__title">Delete this workspace</h3>
              </div>
              <div className="app-panel__body">
                <p className="app-table__muted" style={{ margin: "0 0 10px" }}>
                  Deleting removes the workspace and everybody&rsquo;s access to
                  it. Evidence retention and legal holds are governed
                  separately and are not overridden by this action.
                </p>
                <button
                  type="button"
                  className="app-secondary-action app-secondary-action--danger"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={deletingTeam}
                  data-testid="workspace-delete"
                >
                  {deletingTeam ? "Deleting…" : "Delete workspace"}
                </button>
              </div>
            </div>
            </div>
          </div>
        ) : null}
        </div>

        {/* THE RAIL — compact, secondary, one width. */}
        <div className="app-rail">
          {/*
            INVITE PEOPLE — one purpose, stated, with the one action.

            The delivery channel is the fact worth the space: invitations go out
            by EMAIL and by nothing else. That is not a limitation being
            apologised for, it is the thing an operator needs to know before
            they wonder where the link is. There is no SMS path and no copyable
            link, so neither is offered.
          */}
          {canManageTeam ? (
            <div className="app-panel" data-testid="people-rail-invite">
              <div className="app-panel__head">
                <h2 className="app-panel__title">Invite people</h2>
              </div>
              <div className="app-panel__body">
                <p
                  className="app-table__muted"
                  style={{ margin: "0 0 12px", fontSize: 12.5 }}
                >
                  Send someone an invitation to join this workspace. They are
                  delivered <strong>by email</strong>, and the recipient joins
                  by following the link in that message.
                </p>
                <button
                  type="button"
                  className="app-primary-action app-primary-action--block"
                  onClick={() => setInviteOpen(true)}
                  data-testid="people-rail-invite-open"
                >
                  Invite person
                </button>
              </div>
            </div>
          ) : null}

          {/*
            THE ROLE LEGEND IS GONE (§3).

            It listed the four workspace roles and what each can do — which is
            exactly what the "Role permissions" dialog in the page header
            already shows, in more detail, from the same vocabulary. Two
            descriptions of one permission model is how they drift apart, and
            the header action is the canonical one.

            WORKSPACE OVERVIEW TAKES ITS PLACE (§7), directly under Invite
            people: the workspace's own facts are reference material an
            operator glances at while working the roster, which is what the
            rail is for.
          */}
            {/*
              WORKSPACE OVERVIEW — the facts the removed giant card never showed.

              Every row is a value the server already sends. Nothing is displayed
              that this page cannot answer truthfully: there is no created date on
              the wire, so there is no Created row. Seats read from the SERVER's
              projection, the same numbers the invitation gate enforces.

              Rename lives here, next to the name it changes, instead of being a
              button on a panel that did not display the name at all.
            */}
            <div className="app-panel" data-testid="people-workspace-overview">
              <div className="app-panel__head app-panel__head-row">
                <h2 className="app-panel__title">Workspace overview</h2>
                {canManageTeam ? (
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() =>
                      isEditingName
                        ? handleCancelEditName()
                        : handleStartEditName()
                    }
                    data-testid="workspace-rename-toggle"
                  >
                    {isEditingName ? "Cancel" : "Rename"}
                  </button>
                ) : null}
              </div>
              <div className="app-panel__body">
                {isEditingName ? (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      marginBottom: 12,
                    }}
                  >
                    <input
                      className="app-form-input"
                      style={{ maxWidth: 340, flex: "1 1 200px" }}
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      aria-label="Workspace name"
                      data-testid="workspace-name-input"
                    />
                    <button
                      type="button"
                      className="app-secondary-action app-secondary-action--filled"
                      onClick={() => void handleSaveTeamName()}
                      disabled={savingName}
                      data-testid="workspace-name-save"
                    >
                      {savingName ? "Saving…" : "Save name"}
                    </button>
                  </div>
                ) : null}
                <dl className="app-kv-list">
                  <div className="app-kv-row">
                    <dt className="app-kv-key">Name</dt>
                    <dd className="app-kv-value" data-testid="overview-name">
                      {team?.name ?? "—"}
                    </dd>
                  </div>
                  {/*
                    The row STAYS when the plan is unknown, and says so with an
                    em dash. Hiding it would be the quieter version of the same
                    defect: a reader who saw "Plan: FREE" yesterday and no Plan
                    row today has no way to tell that the answer is missing
                    rather than that the workspace changed.
                  */}
                  <div className="app-kv-row">
                    <dt className="app-kv-key">Plan</dt>
                    <dd className="app-kv-value" data-testid="overview-plan">
                      {effectivePlan ?? "—"}
                    </dd>
                  </div>
                  {ownerLabel ? (
                    <div className="app-kv-row">
                      <dt className="app-kv-key">Owner</dt>
                      <dd className="app-kv-value">{ownerLabel}</dd>
                    </div>
                  ) : null}
                  <div className="app-kv-row">
                    <dt className="app-kv-key">Members</dt>
                    <dd className="app-kv-value">
                      {seatLimit === null
                        ? `${activeMemberCount} active`
                        : `${seatUsed ?? activeMemberCount} of ${seatLimit} seats used`}
                    </dd>
                  </div>
                  <div className="app-kv-row">
                    <dt className="app-kv-key">Billing</dt>
                    <dd className="app-kv-value">
                      <Link
                        href={billingHref}
                        className="app-secondary-action"
                        data-testid="people-open-billing"
                      >
                        Open billing
                      </Link>
                    </dd>
                  </div>
                </dl>
                <p
                  className="app-table__muted"
                  style={{ margin: "10px 0 0", fontSize: 11.5 }}
                >
                  Storage, subscription and payment for this workspace are managed
                  in Billing.
                </p>
              </div>
            </div>
        {/*
          THE BRIDGE — A SIGNPOST, NOT DOCUMENTATION (§8).

          It carried the full Workspace-vs-Team architecture paragraph: what a
          Collaboration Team is, what it is for, and that it grants no access of
          its own. All true, and all established on the surface it points AT.
          A rail card's job is to say where to go and why, in the two seconds
          somebody spends deciding — the sentence that used to be here was
          longer than the roster row it sat beside.
        */}
        <div className="app-panel" data-testid="people-collaboration-bridge">
          <div className="app-panel__head app-panel__head-row">
            <h2 className="app-panel__title">
              <span className="app-panel__title-icon" aria-hidden="true">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              Collaboration Teams
            </h2>
          </div>
          <div className="app-panel__body">
            <p
              className="app-table__muted"
              style={{ margin: "0 0 12px", fontSize: 12.5 }}
            >
              Organise existing workspace members into operational groups for
              cases, evidence and work.
            </p>
            <Link
              href="/collaboration-teams"
              className="app-secondary-action app-secondary-action--block app-secondary-action--filled"
              data-testid="people-to-collaboration-teams"
            >
              Organise members
            </Link>
          </div>
        </div>

        {/*
          EXTERNAL COLLABORATORS — WHAT WAS ACTUALLY UNIQUE HERE (§3).

          This was a large "Member roles" card holding three counts, a search
          box, a kind filter and a row per person. Two of its three counts and
          every internal row restated the roster and the invitations panel
          directly above it, so the page said the same thing three times and
          the roster stopped being the primary object.

          One thing in it was NOT available anywhere else on this surface:
          EXTERNAL COLLABORATORS — people who are not members and hold
          case-scoped grants. Deleting the card would have removed the only
          door to that, so the card keeps exactly that and drops the rest.
          Nothing about the access-review endpoint, its authority, or the
          external-grant model changed.
        */}
        {teamId ? <TeamAccessReviewCard teamId={teamId} /> : null}

        {/* Case linkage. Not people management, and it stays because
            `POST /v1/teams/:id/cases/link` has no other surface in the product
            — removing the only door to a capability is not a redesign. */}
        <div className="app-panel" data-testid="people-cases">
          <div className="app-panel__head app-panel__head-row">
            <h2 className="app-panel__title">Cases in this workspace</h2>
            {canManageTeam ? (
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => {
                  const next = !showAddCase;
                  setShowAddCase(next);
                  // Candidates are fetched when the picker OPENS, not on page
                  // load: an unlinked-case list is a whole extra read that
                  // most visits to this page never need.
                  if (next) void loadAvailableCases();
                }}
                data-testid="workspace-case-add-toggle"
              >
                {showAddCase ? "Close" : "Link a case"}
              </button>
            ) : null}
          </div>
          <div className="app-panel__body">
            {showAddCase ? (
              <div style={{ marginBottom: 12 }}>
                {loadingAvailableCases ? (
                  <p className="app-table__muted" style={{ margin: 0 }}>
                    Loading cases…
                  </p>
                ) : availableCases.length === 0 ? (
                  <p className="app-table__muted" style={{ margin: 0 }}>
                    No unlinked cases are available to add.
                  </p>
                ) : (
                  <ul
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      display: "grid",
                      gap: 6,
                      maxHeight: 220,
                      overflowY: "auto",
                    }}
                    data-testid="workspace-case-candidates"
                  >
                    {availableCases.map((c) => (
                      <li
                        key={c.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
                        <button
                          type="button"
                          className="app-secondary-action"
                          onClick={() => void handleAddExistingCase(c.id)}
                          disabled={linkingCaseId === c.id}
                          data-testid={`workspace-case-link-${c.id}`}
                        >
                          {linkingCaseId === c.id ? "Linking…" : "Link"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {teamCases.length === 0 ? (
              <p className="app-table__muted" style={{ margin: 0 }}>
                No cases are linked to this workspace yet.
              </p>
            ) : (
              <ul
                style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
                data-testid="workspace-case-list"
              >
                {teamCases.map((c) => (
                  <li
                    key={c.id}
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <Link
                      href={`/cases/${encodeURIComponent(c.id)}`}
                      className="app-table__link"
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {c.name}
                    </Link>
                    {canManageTeam ? (
                      <button
                        type="button"
                        className="app-secondary-action app-secondary-action--danger"
                        onClick={() => handleUnlinkTeamCase(c.id)}
                        disabled={unlinkingCaseId === c.id}
                        data-testid={`workspace-case-unlink-${c.id}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        </div>
        </div>
      </div>

      {/* INVITE — the canonical workspace invitation, in a dialog rather than a
          permanently-open card. Email only, because that is the only channel
          `createWorkspaceInvitation` + `deliverWorkspaceInvite` support. */}
      {inviteOpen ? (
        <Modal
          open
          onClose={() => setInviteOpen(false)}
          title="Invite a person to this workspace"
          description="They receive an email with a secure link. A pending invitation does not use a seat — the seat is claimed when they accept."
          testid="people-invite-modal"
          footer={
            <>
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="app-primary-action"
                disabled={inviting || !inviteEmail.trim()}
                onClick={() => void handleInvite()}
                data-testid="people-invite-submit"
              >
                {inviting ? "Sending…" : "Send invitation"}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <label className="app-field-label" htmlFor="people-invite-email">
                Email address
              </label>
              <input
                id="people-invite-email"
                type="email"
                className="app-form-input"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@example.com"
                data-testid="people-invite-email"
              />
            </div>
            <div>
              <label className="app-field-label" htmlFor="people-invite-role">
                Workspace role
              </label>
              <AppListbox
                value={inviteRole}
                options={INVITE_ROLE_OPTIONS.map((r) => ({
                  value: r,
                  label: workspaceRoleLabel(r),
                }))}
                onChange={(v) =>
                  setInviteRole(v as (typeof INVITE_ROLE_OPTIONS)[number])
                }
                ariaLabel="Workspace role"
                id="people-invite-role"
              />
              <p className="app-field__help">
                Access across this whole workspace. Roles inside a Collaboration
                Team are separate. Ownership is not granted by invitation — it
                moves by transfer.
              </p>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ROLE PERMISSIONS — the same server-authoritative matrix, moved off the
          page. It answers a question people ask occasionally and it was taking
          the space the roster needed. */}
      {permissionsOpen ? (
        <Modal
          open
          onClose={() => setPermissionsOpen(false)}
          title="What each role can do"
          description="Roles are enforced by the server. This is the capability catalog the API itself publishes."
          testid="people-permissions-modal"
          footer={
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setPermissionsOpen(false)}
            >
              Close
            </button>
          }
        >
          <TeamPermissionMatrix
            currentRole={
              (currentRole as "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") ?? null
            }
          />
        </Modal>
      ) : null}

      <DangerConfirmModal
        open={pendingInviteDelete !== null}
        title="Revoke this invitation?"
        description={
          pendingInviteDelete
            ? `${pendingInviteDelete.email} will no longer be able to accept the invitation link.`
            : ""
        }
        caveat="The recipient is not notified. To invite them again, send a fresh invitation."
        confirmLabel="Revoke invitation"
        testid="invite-revoke-confirm"
        onCancel={() => setPendingInviteDelete(null)}
        onConfirm={handleConfirmDeleteInvite}
      />
      <DangerConfirmModal
        open={pendingCaseUnlink !== null}
        title="Remove case from this workspace?"
        description={
          pendingCaseUnlink
            ? `"${pendingCaseUnlink.name}" will be detached from this workspace. The case itself is not deleted; its owner retains it.`
            : ""
        }
        caveat="Existing case access grants stay on the case. To revoke individual members, manage access on the case itself."
        confirmLabel="Remove from workspace"
        testid="case-unlink-confirm"
        onCancel={() => setPendingCaseUnlink(null)}
        onConfirm={handleConfirmUnlinkCase}
      />
      <DangerConfirmModal
        open={deleteConfirm}
        title="Delete this workspace?"
        description="Everybody loses access to this workspace."
        caveat="Evidence retention and legal holds are governed separately and are not overridden by deleting a workspace."
        confirmLabel="Delete workspace"
        testid="workspace-delete-confirm"
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={handleDeleteTeam}
      />

      {/* Offboarding transfer dialog. Mounted at root so the focus trap and
          overlay are not constrained by a card's scroll container. We pass
          `TeamMember.id` (the row PK) as `memberId`, NOT `userId`: the Fastify
          route `:memberId` resolves by TeamMember.id. */}
      {removalDialogMember && teamId && removalDialogMember.id ? (
        <MemberRemovalDialog
          open
          teamId={teamId}
          member={{
            memberId: removalDialogMember.id,
            userId: removalDialogMember.userId,
            label:
              removalDialogMember.user?.displayName?.trim() ||
              removalDialogMember.user?.email ||
              removalDialogMember.label ||
              "this member",
            role: removalDialogMember.role,
          }}
          onCancel={() => setRemovalDialogMember(null)}
          onRemoved={() => handleRemovalConfirmed(removalDialogMember)}
        />
      ) : null}
    </div>
  );
}

// Closure verification Part C — canonical PageRouteGate wrapper.
export default function TeamDetailPage() {
  return (
    <PageRouteGate routeId="admin.teams">
      <TeamDetailPageBody />
    </PageRouteGate>
  );
}