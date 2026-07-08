"use client";
/**
 * WORKSPACE-ADMIN DETAIL (INTENTIONAL — final product model classification).
 *
 * This page is the per-WORKSPACE administration detail: workspace profile,
 * billing/seats/storage, WORKSPACE members + invites (TeamMember/TeamInvite),
 * case linkage, and access review — all via the `/v1/teams/*` (workspace /
 * tenancy) API. It is gated by `admin.teams` (capability TEAM_VIEW).
 *
 * It is NOT the user-facing collaboration Teams product and is NOT a
 * duplicate of `/collaboration-teams/[teamId]` (which manages CollaborationTeam
 * groups via `/v1/collaboration-teams`). It is retained because it is the
 * unique per-workspace admin surface; the workspace overview at `/workspaces`
 * delegates here / to `/organizations/[id]/admin` for detail. Backend
 * migration of `/v1/teams` (tenancy) is out of scope — it backs billing,
 * seats, and evidence ownership.
 */
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  Button,
  Card,
  useToast,
  Skeleton,
} from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { formatUserDateTime } from "../../../../lib/date";
// CR1.6 Part 4 — Replace the legacy /v1/users/me self-fetch with the
// canonical PlatformContextEnvelope user identity. The team detail
// page only needed `currentUserId` to derive role-from-membership;
// the envelope already carries `user.id` (and is authoritative).
import { usePlatformContext } from "../../../../lib/platform-context";
import { MemberRemovalDialog } from "./components/MemberRemovalDialog";
import { TeamPermissionMatrix } from "./components/TeamPermissionMatrix";
import { DangerConfirmModal } from "./components/DangerConfirmModal";
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
  inviteUrl?: string;
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
};

type Team = {
  id: string;
  name?: string | null;
  ownerUserId?: string;
  currentUserRole?: string;
  canManageMembers?: boolean;
  stats?: TeamStats;
  members?: TeamMember[];
  billingPlan?: string | null;
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

function formatLocalDateTime(value: string | null | undefined): string {
  return formatUserDateTime(value);
}

function normalizePlanLabel(value?: string | null, fallback = "FREE"): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || fallback;
}

function roleTone(role: string) {
  const normalized = role.toUpperCase();

  if (normalized === "OWNER") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    };
  }

  if (normalized === "ADMIN") {
    return {
      border: "1px solid rgba(79,112,107,0.18)",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.20) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#2d5b59",
    };
  }

  return {
    border: "1px solid rgba(79,112,107,0.12)",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    color: "#4d6165",
  };
}

function billingTone(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") {
    return {
      border: "1px solid rgba(79,112,107,0.18)",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.20) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#2d5b59",
    };
  }

  if (normalized === "PAST_DUE") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    };
  }

  if (normalized === "CANCELED") {
    return {
      border: "1px solid rgba(194,78,78,0.20)",
      background:
        "linear-gradient(180deg, rgba(194,78,78,0.10) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8b3e3e",
    };
  }

  return {
    border: "1px solid rgba(79,112,107,0.12)",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    color: "#4d6165",
  };
}

type TeamRoleValue = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

function TeamRoleDropdown({
  value,
  options,
  onChange,
  disabled,
  minWidth = 0,
}: {
  value: TeamRoleValue;
  options: readonly TeamRoleValue[];
  onChange: (value: TeamRoleValue) => void;
  disabled?: boolean;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
  }>({
    top: 0,
    left: 0,
    width: minWidth,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  const updateMenuPosition = () => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const width = Math.max(rect.width, minWidth);

    setMenuPos({
      top: rect.bottom + 8,
      left: rect.left,
      width,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, minWidth]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      const clickedInsideButton = buttonRef.current?.contains(target);
      const clickedInsideMenu = menuRef.current?.contains(target);

      if (clickedInsideButton || clickedInsideMenu) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    const handleReposition = () => {
      updateMenuPosition();
    };

    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const menu =
    mounted && open && !disabled
      ? createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              zIndex: 9999,
              borderRadius: 18,
              overflow: "hidden",
              border: "1px solid rgba(79,112,107,0.14)",
              background:
                "linear-gradient(180deg, rgba(252,253,251,0.98) 0%, rgba(243,245,242,0.99) 100%)",
              boxShadow:
                "0 20px 44px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.72)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              padding: 8,
            }}
          >
            {options.map((option) => {
              const active = option === value;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                  style={{
                    width: "100%",
                    minHeight: 46,
                    border: "none",
                    background: active
                      ? "linear-gradient(180deg, rgba(58,92,95,0.12) 0%, rgba(20,38,42,0.08) 100%)"
                      : "transparent",
                    color: "#23373b",
                    borderRadius: 14,
                    textAlign: "left",
                    padding: "0 14px",
                    fontSize: 14,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span>{option}</span>

                  {active ? (
                    <span
                      style={{
                        color: "#3a5d61",
                        fontWeight: 700,
                        fontSize: 13,
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div
        ref={rootRef}
        style={{
          position: "relative",
          width: "100%",
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            setOpen((prev) => !prev);
          }}
          className="team-select"
          style={{
            minWidth,
            minHeight: 44,
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            position: "relative",
            width: "100%",
          }}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {value}
          </span>
        </button>
      </div>

      {menu}
    </>
  );
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
  const [loadingAvailableCases, setLoadingAvailableCases] = useState(false);
  const [linkingCaseId, setLinkingCaseId] = useState<string | null>(null);
  const [unlinkingCaseId, setUnlinkingCaseId] = useState<string | null>(null);

  const loadData = async () => {
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
  };

  useEffect(() => {
    void loadData();
  }, [teamId]);

  const myMemberRecord = useMemo(() => {
    if (!team?.members || !currentUserId) return null;
    return team.members.find((member) => member.userId === currentUserId) ?? null;
  }, [team?.members, currentUserId]);

  const currentRole = team?.currentUserRole || myMemberRecord?.role || "VIEWER";
  const isOwner = currentRole === "OWNER";
  const canManageTeam =
    team?.canManageMembers ?? (currentRole === "OWNER" || currentRole === "ADMIN");

  const billingConsoleHref = useMemo(() => {
    if (!teamId) return "/billing?workspace=team&plan=TEAM";
    return `/billing?workspace=team&plan=TEAM&team=${encodeURIComponent(teamId)}`;
  }, [teamId]);

  const displayBillingPlan = useMemo(() => {
    return normalizePlanLabel(team?.billingPlan, "FREE");
  }, [team?.billingPlan]);

  const effectivePlan = useMemo(() => {
    return normalizePlanLabel(team?.effectivePlan ?? team?.billingPlan, "FREE");
  }, [team?.effectivePlan, team?.billingPlan]);

  const effectiveBillingStatus = useMemo(() => {
    const normalized = String(team?.billingStatus ?? "").trim().toUpperCase();
    if (normalized) return normalized;
    return effectivePlan === "TEAM" ? "ACTIVE" : "INACTIVE";
  }, [team?.billingStatus, effectivePlan]);

  const teamMembersUsed = team?.stats?.memberCount ?? team?.members?.length ?? 0;
  const teamMembersIncluded =
    team?.maxMembersPerTeam ?? team?.includedSeats ?? 5;
  const teamMembersRemaining =
    teamMembersIncluded > 0
      ? Math.max(0, teamMembersIncluded - teamMembersUsed)
      : 0;

  const displayMemberName = (member: TeamMember) =>
    member.user?.displayName || member.label || member.user?.email || member.userId;

  const displayMemberEmail = (member: TeamMember) => member.user?.email || "";

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
              inviteUrl: data.inviteUrl ?? copy[existingIndex].inviteUrl,
            };
            return copy;
          }

          return [
            {
              ...data.invite,
              inviteUrl: data.inviteUrl,
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
    if (!teamId || !canManageTeam || !member.userId) return;

    setRoleSavingKey(member.userId);

    try {
      const data = await apiFetch(`/v1/teams/${teamId}/members/${member.userId}`, {
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

  const handleCreateTeamCase = async () => {
    if (!teamId || !canManageTeam) return;

    const caseName = window.prompt("Enter case name");
    if (!caseName?.trim()) return;

    try {
      const created = await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({
          name: caseName.trim(),
          teamId,
        }),
      });

      setTeamCases((prev) => [
        {
          id: created.id,
          name: created.name,
          createdAt: created.createdAt,
          ownerUserId: created.ownerUserId,
          teamId,
        },
        ...prev,
      ]);

      addToast("Case created successfully", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to create case" }).message;
      captureException(err, { feature: "team_case_create", teamId });
      addToast(message, "error");
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

  const copyInviteLink = async (invite: TeamInvite) => {
    const url = invite.inviteUrl;
    if (!url) {
      addToast("Invite link not available", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      addToast("Invite link copied", "success");
    } catch {
      addToast("Failed to copy invite link", "error");
    }
  };

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.12)",
        color: "#24373b",
        background:
          "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
        boxShadow:
          "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.70)",
        textShadow: "0 1px 0 rgba(255,255,255,0.30)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const dangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(194,78,78,0.20)",
        color: "#fff3f3",
        background:
          "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,18,18,0.14)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        borderRadius: 24,
        padding: 16,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const statPillBase = useMemo(
    () =>
      ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 34,
        padding: "7px 14px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }) as const,
    []
  );

  if (loading) {
    return (
      <div className="section app-section teams-detail-page-shell">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.72rem",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
                padding: "8px 16px",
                fontSize: "0.68rem",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.28em",
                color: "#afbbb7",
                boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.95,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              Workspace
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Loading <span style={{ color: "#c3ebe2" }}>workspace</span>.
            </h1>

            <p
              style={{
                marginTop: 20,
                maxWidth: 720,
                fontSize: "0.95rem",
                lineHeight: 1.8,
                letterSpacing: "-0.006em",
                color: "#aab5b2",
              }}
            >
              Preparing members, invites, linked workspace cases, and billing context.
            </p>
          </div>
        </div>

        <div
          className="app-body app-body-full pt-8 md:pt-10"
          style={{
            position: "relative",
            overflow: "hidden",
            background:
              "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
          }}
        >
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="140px" />
            <Skeleton width="100%" height="220px" />
            <Skeleton width="100%" height="220px" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !team) {
    return (
      <div className="section app-section teams-detail-page-shell">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.72rem",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
                padding: "8px 16px",
                fontSize: "0.68rem",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.28em",
                color: "#afbbb7",
                boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.95,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              Workspace
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Workspace details <span style={{ color: "#c3ebe2" }}>could not load</span>.
            </h1>
          </div>
        </div>

        <div
          className="app-body app-body-full pt-8 md:pt-10"
          style={{
            position: "relative",
            overflow: "hidden",
            background:
              "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
          }}
        >
          <div className="container">
            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="team-card-inner p-6">
                <div className="team-card-header">
                  <div className="team-card-title">Unable to load team</div>
                  <div className="team-card-copy">{error || "Team not found."}</div>
                </div>

                <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Link href="/workspaces" style={{ textDecoration: "none" }}>
                    <Button
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Back to Workspaces
                    </Button>
                  </Link>

                  {teamId ? (
                    <Link href={billingConsoleHref} style={{ textDecoration: "none" }}>
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={secondaryButtonStyle}
                      >
                        Open Team Billing
                      </Button>
                    </Link>
                  ) : null}
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section teams-detail-page-shell">
      <style jsx global>{`
        .teams-detail-page-shell .container {
          max-width: 1360px !important;
        }

        .teams-detail-page-shell .team-field,
        .teams-detail-page-shell .team-select {
          width: 100%;
          min-height: 54px;
          padding: 0 16px;
          border-radius: 18px;
          border: 1px solid rgba(79, 112, 107, 0.14);
          background: linear-gradient(
            180deg,
            rgba(250, 251, 249, 0.96) 0%,
            rgba(241, 244, 241, 0.99) 100%
          );
          color: #23373b;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.7),
            0 10px 22px rgba(0, 0, 0, 0.05);
          outline: none;
        }

        .teams-detail-page-shell .team-field::placeholder {
          color: rgba(93, 109, 113, 0.62);
        }

        .teams-detail-page-shell .team-field:focus,
        .teams-detail-page-shell .team-select:focus {
          border-color: rgba(79, 112, 107, 0.24);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.78),
            0 0 0 3px rgba(79, 112, 107, 0.08),
            0 12px 24px rgba(0, 0, 0, 0.06);
        }

        .teams-detail-page-shell .team-select {
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          padding-right: 46px;
          background-image:
            linear-gradient(
              180deg,
              rgba(250, 251, 249, 0.96) 0%,
              rgba(241, 244, 241, 0.99) 100%
            ),
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%238a6e57' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
          background-repeat: no-repeat, no-repeat;
          background-position: left top, right 16px center;
          background-size: auto, 16px;
          cursor: pointer;
        }

        .teams-detail-page-shell .team-select option {
          background: #f7f8f5;
          color: #23373b;
        }

        .teams-detail-page-shell .team-section-spacer {
          display: grid;
          gap: 28px;
        }

        .teams-detail-page-shell .team-card {
          height: 100%;
          isolation: isolate;
        }

        .teams-detail-page-shell .team-card-inner {
          position: relative;
          z-index: 10;
          height: 100%;
          display: flex;
          flex-direction: column;
          gap: 22px;
          padding: 30px !important;
        }

        .teams-detail-page-shell .team-card-header {
          margin-bottom: 0;
          max-width: 760px;
        }

        .teams-detail-page-shell .team-card-title {
          margin: 0 0 8px;
          font-weight: 700;
          color: #21353a;
          letter-spacing: -0.03em;
          font-size: 1.65rem;
          line-height: 1.08;
        }

        .teams-detail-page-shell .team-card-copy {
          color: #5d6d71;
          line-height: 1.72;
          font-size: 0.98rem;
          max-width: 62ch;
        }

        .teams-detail-page-shell .team-stack {
          display: grid;
          gap: 14px;
        }

        .teams-detail-page-shell .team-top-grid,
        .teams-detail-page-shell .team-secondary-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 28px;
          align-items: stretch;
        }

        .teams-detail-page-shell .team-top-grid > .team-card,
        .teams-detail-page-shell .team-secondary-grid > .team-card {
          min-height: 320px;
        }

        .teams-detail-page-shell .team-top-grid > .team-card .team-card-inner,
        .teams-detail-page-shell .team-secondary-grid > .team-card .team-card-inner {
          justify-content: space-between;
        }

        .teams-detail-page-shell .team-top-grid > .team-card .team-stack,
        .teams-detail-page-shell .team-secondary-grid > .team-card .team-stack {
          flex: 1;
          align-content: start;
        }

        .teams-detail-page-shell .team-hero-title-row {
          display: flex;
          align-items: center;
          gap: 18px;
          flex-wrap: wrap;
          margin-top: 22px;
        }

        .teams-detail-page-shell .team-hero-editbar {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 18px;
        }

        .teams-detail-page-shell .team-hero-name-input {
          min-width: 260px;
          max-width: 420px;
        }

        .teams-detail-page-shell .team-hero-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-items: flex-start;
        }

        .teams-detail-page-shell .team-cases-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-items: center;
        }

        .teams-detail-page-shell .team-row-flex {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .teams-detail-page-shell .team-row-flex > :first-child {
          flex: 1 1 260px;
          min-width: 0;
        }

        .teams-detail-page-shell .team-row-flex > :last-child {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
        }

        .teams-detail-page-shell .team-card .rounded-\\[999px\\] {
          white-space: nowrap;
        }

        .teams-detail-page-shell .team-card a {
          text-decoration: none;
        }

        .teams-detail-page-shell .team-card .team-stack > div[style] {
          border-radius: 24px !important;
        }

        @media (max-width: 1180px) {
          .teams-detail-page-shell .team-top-grid,
          .teams-detail-page-shell .team-secondary-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 860px) {
          .teams-detail-page-shell .team-card-inner {
            padding: 24px !important;
          }

          .teams-detail-page-shell .team-card-title {
            font-size: 1.35rem;
          }

          .teams-detail-page-shell .team-card-copy {
            font-size: 0.95rem;
          }

          .teams-detail-page-shell .team-hero-name-input {
            width: 100%;
            max-width: 100%;
          }
        }

        @media (max-width: 720px) {
          .teams-detail-page-shell .team-card-inner {
            padding: 20px !important;
            gap: 18px;
          }

          .teams-detail-page-shell .team-card-title {
            font-size: 1.16rem;
            line-height: 1.1;
          }

          .teams-detail-page-shell .team-hero-actions,
          .teams-detail-page-shell .team-cases-actions {
            justify-content: stretch;
            width: 100%;
          }

          .teams-detail-page-shell .team-hero-actions > *,
          .teams-detail-page-shell .team-cases-actions > * {
            width: 100%;
          }

          .teams-detail-page-shell .team-row-flex {
            flex-direction: column;
            align-items: stretch;
          }

          .teams-detail-page-shell .team-row-flex > :first-child,
          .teams-detail-page-shell .team-row-flex > :last-child {
            width: 100%;
          }

          .teams-detail-page-shell .team-row-flex > :last-child {
            justify-content: stretch;
          }

          .teams-detail-page-shell .team-row-flex > :last-child > * {
            width: 100%;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 900 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Workspace
              </div>

              {!isEditingName ? (
                <div className="team-hero-title-row">
                  <h1
                    className="max-w-[820px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                    style={{ margin: 0 }}
                  >
                    <span style={{ color: "#c3ebe2" }}>{team.name ?? "Workspace"}</span>
                  </h1>

                  {canManageTeam && (
                    <Button
                      variant="secondary"
                      onClick={handleStartEditName}
                      className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                      style={secondaryButtonStyle}
                    >
                      Rename
                    </Button>
                  )}
                </div>
              ) : (
                <div className="team-hero-editbar">
                  <input
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    disabled={savingName}
                    className="team-field team-hero-name-input"
                  />

                  <Button
                    onClick={handleSaveTeamName}
                    disabled={savingName || !teamName.trim()}
                    className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                    style={primaryButtonStyle}
                  >
                    {savingName ? "Saving..." : "Save"}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleCancelEditName}
                    disabled={savingName}
                    className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <p
                style={{
                  marginTop: 20,
                  maxWidth: 760,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Manage <span style={{ color: "#cfd8d5" }}>ownership</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>members</span>,{" "}
                <span style={{ color: "#d2dcd8" }}>pending invites</span>, linked{" "}
                <span style={{ color: "#d9ccbf" }}>workspace cases</span>, and open the{" "}
                <span style={{ color: "#c3ebe2" }}>workspace billing workflow</span>{" "}
                from the same workspace.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {(team.stats?.memberCount ?? team.members?.length ?? 0).toString()} active
                  member
                  {(team.stats?.memberCount ?? team.members?.length ?? 0) === 1 ? "" : "s"}
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {team.stats?.pendingInviteCount ?? invites.length} pending invite
                  {(team.stats?.pendingInviteCount ?? invites.length) === 1 ? "" : "s"}
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {team.stats?.caseCount ?? teamCases.length} linked case
                  {(team.stats?.caseCount ?? teamCases.length) === 1 ? "" : "s"}
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#c2a07f]">✓</span>
                  Current role: {currentRole}
                </div>

                <div className="rounded-full border border-[rgba(158,216,207,0.18)] bg-[linear-gradient(180deg,rgba(158,216,207,0.10)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#c3ebe2] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9ad1c6]">✓</span>
                  Plan view: {displayBillingPlan} · Effective: {effectivePlan} · Status:{" "}
                  {effectiveBillingStatus}
                </div>
              </div>
            </div>

            <div className="team-hero-actions">
              <Link href="/workspaces" style={{ textDecoration: "none" }}>
                <Button
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={secondaryButtonStyle}
                >
                  Back to Workspaces
                </Button>
              </Link>

              {canManageTeam ? (
                <Link href={billingConsoleHref} style={{ textDecoration: "none" }}>
                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={primaryButtonStyle}
                  >
                    Open Team Billing
                  </Button>
                </Link>
              ) : null}

              {isOwner && (
                <Button
                  variant="secondary"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={deletingTeam}
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={dangerButtonStyle}
                >
                  Delete Team
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div
          className="container relative z-10 team-section-spacer"
          style={{
            paddingBottom: 72,
          }}
        >
          {deleteConfirm && isOwner && (
            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{
                ...outerCardStyle,
                border: "1px solid rgba(194,78,78,0.24)",
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,243,243,0.90)_0%,rgba(248,239,235,0.86)_100%)]" />

              <div className="team-card-inner p-6">
                <div className="team-card-header">
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: "#7b1e1e",
                      letterSpacing: "-0.03em",
                    }}
                  >
                    Delete team?
                  </div>

                  <div
                    style={{
                      marginTop: 10,
                      color: "#8b4a4a",
                      lineHeight: 1.75,
                    }}
                  >
                    This will permanently delete the team, its members list, and all
                    pending invites.
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={deletingTeam}
                    className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleDeleteTeam}
                    disabled={deletingTeam}
                    className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                    style={dangerButtonStyle}
                  >
                    {deletingTeam ? "Deleting..." : "Delete Team"}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <div className="team-top-grid">
            {canManageTeam ? (
              <Card
                className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={outerCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                <div className="team-card-inner p-6 md:p-6">
                  <div className="team-card-header">
                    <div className="team-card-title">Invite member</div>
                    <div className="team-card-copy">
                      Create an invitation before the user joins the workspace. Pending
                      invites do not count as active members. The actual member cap is{" "}
                      <strong>{teamMembersIncluded}</strong> per team.
                    </div>
                  </div>

                  <div className="team-stack">
                    <input
                      placeholder="Email address"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      disabled={inviting}
                      className="team-field"
                    />

                    <TeamRoleDropdown
                      value={inviteRole}
                      options={INVITE_ROLE_OPTIONS}
                      onChange={(value) =>
                        setInviteRole(value as (typeof INVITE_ROLE_OPTIONS)[number])
                      }
                      disabled={inviting}
                      minWidth={180}
                    />

                    <Button
                      onClick={handleInvite}
                      disabled={inviting || !inviteEmail.trim()}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      {inviting ? "Sending..." : "Send invite"}
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <Card
                className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={outerCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                <div className="team-card-inner p-6 md:p-6">
                  <div className="team-card-header">
                    <div className="team-card-title">Access summary</div>
                    <div className="team-card-copy">
                      Your current access, workspace permissions, and billing entry point.
                    </div>
                  </div>

                  <div style={rowCardStyle}>
                    <div
                      style={{
                        display: "grid",
                        gap: 8,
                        color: "#5d6d71",
                        lineHeight: 1.7,
                      }}
                    >
                      <div>
                        <strong style={{ color: "#7f6450" }}>Owner:</strong>{" "}
                        {team.ownerUserId === currentUserId ? "You" : "Team owner"}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Your access:</strong>{" "}
                        {currentRole}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Pending invites:</strong>{" "}
                        {team.stats?.pendingInviteCount ?? invites.length}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Plan view:</strong>{" "}
                        {displayBillingPlan}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Effective plan:</strong>{" "}
                        {effectivePlan}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Status:</strong>{" "}
                        {effectiveBillingStatus}
                      </div>
                    </div>
                  </div>

                  <Link href={billingConsoleHref} style={{ textDecoration: "none" }}>
                    <Button
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={secondaryButtonStyle}
                    >
                      Open Team Billing
                    </Button>
                  </Link>
                </div>
              </Card>
            )}

            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="team-card-inner p-6 md:p-6">
                <div className="team-card-header">
                  <div className="team-card-title">Workspace & billing summary</div>
                  <div className="team-card-copy">
                    Core team status, plan view, effective capability, member capacity,
                    and ownership at a glance.
                  </div>
                </div>

                <div className="team-stack">
                  <div style={rowCardStyle}>
                    <div
                      style={{
                        display: "grid",
                        gap: 8,
                        color: "#5d6d71",
                        lineHeight: 1.7,
                      }}
                    >
                      <div>
                        <strong style={{ color: "#7f6450" }}>Owner:</strong>{" "}
                        {team.ownerUserId === currentUserId ? "You" : "Team owner"}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Your access:</strong>{" "}
                        {currentRole}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Linked cases:</strong>{" "}
                        {team.stats?.caseCount ?? teamCases.length}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Plan view:</strong>{" "}
                        {displayBillingPlan}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Effective plan:</strong>{" "}
                        {effectivePlan}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Billing status:</strong>{" "}
                        {effectiveBillingStatus}
                      </div>
                      <div>
                        <strong style={{ color: "#7f6450" }}>Members:</strong>{" "}
                        {teamMembersUsed} / {teamMembersIncluded}
                        {` · ${teamMembersRemaining} remaining`}
                      </div>
                    </div>
                  </div>

                  <div style={rowCardStyle}>
                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <span style={{ ...statPillBase, ...roleTone(currentRole) }}>
                        {currentRole}
                      </span>

                      <span
                        style={{
                          ...statPillBase,
                          ...billingTone(effectiveBillingStatus),
                        }}
                      >
                        {effectiveBillingStatus}
                      </span>

                      <span
                        style={{
                          ...statPillBase,
                          border: "1px solid rgba(79,112,107,0.12)",
                          background:
                            "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
                          color: "#4d6165",
                        }}
                      >
                        {team.stats?.memberCount ?? team.members?.length ?? 0} members
                      </span>

                      {team?.overSeatLimit ? (
                        <span
                          style={{
                            ...statPillBase,
                            border: "1px solid rgba(194,78,78,0.20)",
                            background:
                              "linear-gradient(180deg, rgba(194,78,78,0.10) 0%, rgba(255,255,255,0.44) 100%)",
                            color: "#8b3e3e",
                          }}
                        >
                          Over member limit
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div style={rowCardStyle}>
                    <div
                      style={{
                        display: "grid",
                        gap: 8,
                        color: "#5d6d71",
                        lineHeight: 1.7,
                      }}
                    >
                      <div>
                        This workspace may remain valid even when it is not on a dedicated
                        TEAM subscription.
                      </div>
                      <div>
                        Use billing when you specifically want to start, reactivate, or
                        manage a dedicated <strong>TEAM</strong> subscription for this
                        workspace.
                      </div>
                      <div>
                        Pending invites are not the same thing as active member count.
                        The actual member cap is enforced on joined members.
                      </div>
                    </div>

                    <div style={{ marginTop: 14 }}>
                      <Link href={billingConsoleHref} style={{ textDecoration: "none" }}>
                        <Button
                          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={primaryButtonStyle}
                        >
                          Open Team Billing
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <div className="team-secondary-grid">
            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="team-card-inner p-6 md:p-6">
                <div className="team-card-header">
                  <div className="team-card-title">Members</div>
                  <div className="team-card-copy">
                    A clear view of who belongs to the team, who owns it, and who can
                    manage access.
                  </div>
                </div>

                {!team.members || team.members.length === 0 ? (
                  <div style={{ color: "#5d6d71" }}>No members found.</div>
                ) : (
                  <div className="team-stack">
                    {team.members.map((member) => {
                      const name = displayMemberName(member);
                      const email = displayMemberEmail(member);
                      const isSelf = member.userId === currentUserId;
                      const memberIsOwner = member.role === "OWNER";

                      return (
                        <div key={member.userId} style={rowCardStyle}>
                          <div className="team-row-flex">
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  color: "#21353a",
                                  fontWeight: 700,
                                  fontSize: 16,
                                }}
                              >
                                {name} {isSelf ? "(You)" : ""}
                              </div>
                              <div
                                style={{
                                  color: "#6a777b",
                                  fontSize: 13,
                                  marginTop: 4,
                                  lineHeight: 1.6,
                                }}
                              >
                                {email || member.userId}
                              </div>
                            </div>

                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                                alignItems: "center",
                              }}
                            >
                              {canManageTeam && !memberIsOwner ? (
                                <>
                                  <TeamRoleDropdown
                                    value={member.role as TeamRoleValue}
                                    options={MANAGEABLE_ROLE_OPTIONS}
                                    onChange={(value) =>
                                      handleRoleChange(
                                        member,
                                        value as (typeof MANAGEABLE_ROLE_OPTIONS)[number]
                                      )
                                    }
                                    disabled={roleSavingKey === member.userId}
                                    minWidth={150}
                                  />
                                  <Button
                                    variant="secondary"
                                    onClick={() => handleRemoveMember(member)}
                                    disabled={removingMemberId === member.userId}
                                    className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                                    style={dangerButtonStyle}
                                  >
                                    {removingMemberId === member.userId
                                      ? "Removing..."
                                      : "Remove"}
                                  </Button>
                                </>
                              ) : (
                                <span
                                  style={{
                                    ...statPillBase,
                                    ...roleTone(member.role),
                                  }}
                                >
                                  {member.role}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>

            {/* Phase 2.6 — Permission matrix. Read-only governance
                reference; mirrors backend rbac enforcement so admins
                understand what each role can actually do today. */}
            <TeamPermissionMatrix
              currentRole={
                (currentRole as "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") ?? null
              }
            />

            {/* Phase 2.6C — Access review card. Consumes the Phase
                2.6B aggregator endpoint (/v1/teams/:id/access-review)
                to surface internal members + pending invites + external
                collaborators in one operator-readable list. ADMIN+
                gated by the backend; non-admin viewers see an
                AccessGate panel explaining the restriction. */}
            {teamId ? <TeamAccessReviewCard teamId={teamId} /> : null}

            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="team-card-inner p-6 md:p-6">
                <div className="team-card-header">
                  <div className="team-card-title">Pending invites</div>
                  <div className="team-card-copy">
                    All invitations waiting for acceptance, with quick actions to manage
                    them. Pending invites are informational and are shown separately from
                    active member count.
                  </div>
                </div>

                {invites.length === 0 ? (
                  <div
                    style={{
                      color: "#5d6d71",
                      minHeight: 132,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    No pending invites.
                  </div>
                ) : (
                  <div className="team-stack">
                    {invites.map((invite) => (
                      <div key={invite.id} style={rowCardStyle}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                color: "#21353a",
                                fontWeight: 700,
                                fontSize: 16,
                              }}
                            >
                              {invite.email}
                            </div>
                            <div
                              style={{
                                color: "#6a777b",
                                fontSize: 13,
                                marginTop: 4,
                                lineHeight: 1.6,
                              }}
                            >
                              {invite.role}
                              {invite.expiresAt
                                ? ` • expires ${formatUserDateTime(invite.expiresAt)}`
                                : ""}
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {invite.inviteUrl ? (
                              <Button
                                variant="secondary"
                                onClick={() => copyInviteLink(invite)}
                                className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                                style={secondaryButtonStyle}
                              >
                                Copy link
                              </Button>
                            ) : null}

                            <Button
                              variant="secondary"
                              onClick={() => handleDeleteInvite(invite.id)}
                              disabled={deletingInviteId === invite.id}
                              className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                              style={dangerButtonStyle}
                            >
                              {deletingInviteId === invite.id ? "Deleting..." : "Delete"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card
            className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

            <div className="team-card-inner p-6 md:p-6">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 18,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginBottom: 18,
                }}
              >
                <div>
                  <div className="team-card-title">Team cases</div>
                  <div className="team-card-copy">
                    Cases currently attached to this team, with clear actions to open or
                    remove them.
                  </div>
                </div>

                {canManageTeam && (
                  <div className="team-cases-actions">
                    <Button
                      onClick={handleCreateTeamCase}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Create Team Case
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => {
                        const next = !showAddCase;
                        setShowAddCase(next);
                        if (next) {
                          void loadAvailableCases();
                        }
                      }}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={secondaryButtonStyle}
                    >
                      {showAddCase ? "Close" : "Add Existing Case"}
                    </Button>
                  </div>
                )}
              </div>

              {teamCases.length === 0 ? (
                <div style={{ color: "#5d6d71" }}>
                  No cases linked to this team yet.
                </div>
              ) : (
                <div className="team-stack">
                  {teamCases.map((item) => (
                    <div key={item.id} style={rowCardStyle}>
                      <div className="team-row-flex">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              color: "#21353a",
                              fontWeight: 700,
                              fontSize: 16,
                            }}
                          >
                            {item.name}
                          </div>
                          <div
                            style={{
                              color: "#6a777b",
                              fontSize: 13,
                              marginTop: 4,
                              lineHeight: 1.6,
                            }}
                          >
                            {item.createdAt
                              ? formatUserDateTime(item.createdAt)
                              : "Creation date not available"}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <Link
                            href={`/cases/${item.id}`}
                            style={{ textDecoration: "none" }}
                          >
                            <Button
                              className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                              style={primaryButtonStyle}
                            >
                              Open
                            </Button>
                          </Link>

                          {canManageTeam && (
                            <Button
                              variant="secondary"
                              onClick={() => handleUnlinkTeamCase(item.id)}
                              disabled={unlinkingCaseId === item.id}
                              className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                              style={dangerButtonStyle}
                            >
                              {unlinkingCaseId === item.id
                                ? "Removing..."
                                : "Remove from Workspace"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showAddCase && canManageTeam && (
                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: "1px solid rgba(79,112,107,0.10)",
                  }}
                >
                  <div
                    style={{
                      color: "#5d6d71",
                      marginBottom: 12,
                      lineHeight: 1.7,
                    }}
                  >
                    {loadingAvailableCases
                      ? "Loading available cases..."
                      : availableCases.length === 0
                        ? "No available personal cases to link."
                        : "Choose a personal case to attach to this team."}
                  </div>

                  {!loadingAvailableCases && availableCases.length > 0 && (
                    <div className="team-stack">
                      {availableCases.map((item) => (
                        <div key={item.id} style={rowCardStyle}>
                          <div className="team-row-flex">
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  color: "#21353a",
                                  fontWeight: 700,
                                  fontSize: 16,
                                }}
                              >
                                {item.name}
                              </div>
                              <div
                                style={{
                                  color: "#6a777b",
                                  fontSize: 13,
                                  marginTop: 4,
                                }}
                              >
                                {item.createdAt
                                  ? formatUserDateTime(item.createdAt)
                                  : ""}
                              </div>
                            </div>

                            <Button
                              onClick={() => handleAddExistingCase(item.id)}
                              disabled={linkingCaseId === item.id}
                              className="app-responsive-btn rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                              style={primaryButtonStyle}
                            >
                              {linkingCaseId === item.id ? "Linking..." : "Link"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {activities.length > 0 && (
            <Card
              className="team-card relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="team-card-inner p-6 md:p-6">
                <div className="team-card-header">
                  <div className="team-card-title">Recent activity</div>
                  <div className="team-card-copy">
                    Latest actions captured inside the team workspace.
                  </div>
                </div>

                <div className="team-stack">
                  {activities.slice(0, 10).map((activity) => (
                    <div
                      key={activity.id}
                      style={{
                        ...rowCardStyle,
                        padding: 14,
                      }}
                    >
                      <div style={{ color: "#21353a", fontWeight: 700 }}>
                        {activity.eventType.replace(/_/g, " ")}
                      </div>
                      <div
                        style={{
                          color: "#6a777b",
                          fontSize: 13,
                          marginTop: 4,
                          lineHeight: 1.6,
                        }}
                      >
                        {activity.actor?.displayName ||
                          activity.actor?.email ||
                          "System"}{" "}
                        • {formatLocalDateTime(activity.createdAt)}
                      </div>
                      {activity.metadata && (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: "#7a878b",
                            lineHeight: 1.65,
                          }}
                        >
                          {JSON.stringify(activity.metadata).substring(0, 90)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
      {/* Phase 2.6B — DangerConfirmModal mounts for the two remaining
          destructive flows: invite revocation + case unlink. Each
          modal opens when its `pending*` state is non-null; the
          handler closes the state on success and re-throws on
          failure so the modal can surface the error inline. */}
      <DangerConfirmModal
        open={pendingInviteDelete !== null}
        title="Revoke this invite?"
        description={
          pendingInviteDelete
            ? `${pendingInviteDelete.email} will no longer be able to accept the invite link.`
            : ""
        }
        caveat="The email recipient won't be notified. If you want to re-invite them, send a fresh invite."
        confirmLabel="Revoke invite"
        testid="invite-revoke-confirm"
        onCancel={() => setPendingInviteDelete(null)}
        onConfirm={handleConfirmDeleteInvite}
      />
      <DangerConfirmModal
        open={pendingCaseUnlink !== null}
        title="Remove case from team?"
        description={
          pendingCaseUnlink
            ? `"${pendingCaseUnlink.name}" will be detached from this team workspace. The case itself is not deleted; its owner retains it.`
            : ""
        }
        caveat="Existing case access grants stay on the case. To revoke individual members, manage access on the case itself."
        confirmLabel="Remove from workspace"
        testid="case-unlink-confirm"
        onCancel={() => setPendingCaseUnlink(null)}
        onConfirm={handleConfirmUnlinkCase}
      />

      {/* Phase 2.2 — Offboarding transfer dialog. Mounted at root so
          the focus-trap and overlay aren't constrained by sidebar /
          card scroll containers. Closed = dialog is unmounted.
          NOTE: we pass `TeamMember.id` (the row PK) as `memberId`, NOT
          `userId`. The Fastify route `:memberId` resolves by
          TeamMember.id — passing userId there returns 404. We also
          pass `userId` separately for telemetry / display. If
          `member.id` is missing on a row (legacy payloads), we cannot
          safely call the route and the dialog stays closed. */}
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