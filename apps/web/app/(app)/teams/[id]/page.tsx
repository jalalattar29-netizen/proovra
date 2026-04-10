"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Button,
  Card,
  useToast,
  Skeleton,
} from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

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
};

type MeResponse = {
  user?: {
    id?: string;
  };
  id?: string;
};

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

const ROLE_OPTIONS = ["ADMIN", "MEMBER", "VIEWER"] as const;

export default function TeamDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const teamId = params?.id;

  const [team, setTeam] = useState<Team | null>(null);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [teamCases, setTeamCases] = useState<TeamCase[]>([]);
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [teamName, setTeamName] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [inviting, setInviting] = useState(false);

  const [roleSavingKey, setRoleSavingKey] = useState<string | null>(null);
  const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingTeam, setDeletingTeam] = useState(false);

  const [showAddCase, setShowAddCase] = useState(false);
  const [availableCases, setAvailableCases] = useState<AvailableCaseItem[]>([]);
  const [loadingAvailableCases, setLoadingAvailableCases] = useState(false);
  const [linkingCaseId, setLinkingCaseId] = useState<string | null>(null);

  const loadData = async () => {
    if (!teamId) return;

    setLoading(true);
    setError(null);

    try {
      const [meRes, teamRes, invitesRes, casesRes, activitiesRes] = await Promise.all([
        apiFetch("/v1/users/me") as Promise<MeResponse>,
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

      const meId = meRes?.user?.id ?? meRes?.id ?? "";
      setCurrentUserId(meId);
      setTeam(teamRes ?? null);
      setInvites(invitesRes?.invites ?? []);
      setTeamCases(casesRes?.items ?? []);
      setActivities(activitiesRes?.activities ?? []);
      setTeamName(teamRes?.name ?? "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load team";
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

  const displayMemberName = (member: TeamMember) => {
    return member.user?.displayName || member.label || member.user?.email || member.userId;
  };

  const displayMemberEmail = (member: TeamMember) => {
    return member.user?.email || "";
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

      addToast("Team name updated", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update team name";
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
      addToast(data?.message || "Invitation created successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to invite member";
      captureException(err, { feature: "team_invite_create", teamId });
      addToast(message, "error");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (member: TeamMember, nextRole: string) => {
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
      const message = err instanceof Error ? err.message : "Failed to update role";
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

  const handleRemoveMember = async (member: TeamMember) => {
    if (!teamId || !canManageTeam || !member.userId) return;

    const confirmed = window.confirm("Remove this member from the team?");
    if (!confirmed) return;

    setRemovingMemberId(member.userId);

    try {
      await apiFetch(`/v1/teams/${teamId}/members/${member.userId}`, {
        method: "DELETE",
      });

      setTeam((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members?.filter((m) => m.userId !== member.userId) ?? [],
          stats: prev.stats
            ? {
                ...prev.stats,
                memberCount: Math.max(0, prev.stats.memberCount - 1),
              }
            : prev.stats,
        };
      });

      addToast("Member removed", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove member";
      captureException(err, { feature: "team_member_remove", teamId, memberId: member.userId });
      addToast(message, "error");
    } finally {
      setRemovingMemberId(null);
    }
  };

  const handleDeleteInvite = async (inviteId: string) => {
    if (!teamId || !canManageTeam) return;

    const confirmed = window.confirm("Delete this pending invite?");
    if (!confirmed) return;

    setDeletingInviteId(inviteId);

    try {
      await apiFetch(`/v1/teams/${teamId}/invites/${inviteId}`, {
        method: "DELETE",
      });

      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
      addToast("Invite deleted", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete invite";
      captureException(err, { feature: "team_invite_delete", teamId, inviteId });
      addToast(message, "error");
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

      addToast("Team deleted successfully", "success");
      setTimeout(() => {
        router.push("/teams");
      }, 300);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete team";
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

      addToast("Team case created successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create team case";
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
      const message = err instanceof Error ? err.message : "Failed to load available cases";
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
      const message = err instanceof Error ? err.message : "Failed to link case";
      captureException(err, { feature: "team_case_link", teamId, caseId });
      addToast(message, "error");
    } finally {
      setLinkingCaseId(null);
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
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.18)",
        color: "#aebbb6",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,20,24,0.78) 0%, rgba(7,18,22,0.88) 100%), url('/images/site-velvet-bg.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 28px rgba(0,0,0,0.10)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const dangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(220,120,120,0.22)",
        color: "#f3d9d9",
        background:
          "linear-gradient(180deg, rgba(130,43,43,0.82) 0%, rgba(92,24,24,0.92) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 12px 24px rgba(60,12,12,0.22)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const inputStyle = useMemo(
    () =>
      ({
        width: "100%",
        minHeight: 52,
        padding: "0 16px",
        borderRadius: 18,
        fontSize: 15,
        lineHeight: 1.2,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(183,157,132,0.16)",
        boxShadow: "0 12px 24px rgba(0,0,0,0.10)",
        color: "#d8e0dd",
        outline: "none",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.14)",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.24) 0%, rgba(14,30,34,0.36) 100%)",
        borderRadius: 22,
        padding: 14,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
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
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.8,
                  display: "inline-block",
                }}
              />
              Team
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Loading <span style={{ color: "#c3ebe2" }}>team workspace</span>.
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
              Preparing members, cases, invites, and access controls.
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="120px" />
            <Skeleton width="100%" height="180px" />
            <Skeleton width="100%" height="180px" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !team) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
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
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.8,
                  display: "inline-block",
                }}
              />
              Team
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Team details <span style={{ color: "#c3ebe2" }}>could not load</span>.
            </h1>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

              <div className="relative z-10 p-6">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 10,
                    color: "#d8e0dd",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Unable to load team
                </div>

                <div style={{ color: "rgba(194,204,201,0.76)", lineHeight: 1.7 }}>
                  {error || "Team not found."}
                </div>

                <div style={{ marginTop: 16 }}>
                  <Link href="/teams" style={{ textDecoration: "none" }}>
                    <Button
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={secondaryButtonStyle}
                    >
                      Back to Teams
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
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
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.8,
                    display: "inline-block",
                  }}
                />
                Team Workspace
              </div>

              <h1
                className="mt-5 max-w-[820px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                {team.name ?? "Team"}{" "}
                <span style={{ color: "#c3ebe2" }}>access and collaboration</span>.
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
                Manage <span style={{ color: "#cfd8d5" }}>members</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>invites</span>, shared{" "}
                <span style={{ color: "#d2dcd8" }}>team cases</span>, and recent{" "}
                <span style={{ color: "#d9ccbf" }}>activity</span> inside one controlled
                workspace.
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span
                style={{
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
                  border: "1px solid rgba(158,216,207,0.20)",
                  background:
                    "linear-gradient(180deg, rgba(158,216,207,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                  color: "#bfe8df",
                }}
              >
                {team.stats?.memberCount ?? team.members?.length ?? 0} member
                {(team.stats?.memberCount ?? team.members?.length ?? 0) === 1 ? "" : "s"}
              </span>

              <span
                style={{
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
                  border: "1px solid rgba(214,184,157,0.20)",
                  background:
                    "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                  color: "#dcc0a5",
                }}
              >
                {currentRole}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div
          className="container"
          style={{
            display: "grid",
            gap: 18,
            paddingBottom: 72,
          }}
        >
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 16,
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      marginBottom: 14,
                      color: "#d8e0dd",
                      letterSpacing: "-0.02em",
                      fontSize: 20,
                    }}
                  >
                    Team overview
                  </div>

                  <label style={{ display: "grid", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "rgba(194,204,201,0.76)" }}>
                      Team name
                    </span>
                    <input
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      disabled={!canManageTeam || savingName}
                      style={inputStyle}
                    />
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {canManageTeam && (
                    <Button
                      onClick={handleSaveTeamName}
                      disabled={savingName || !teamName.trim()}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      {savingName ? "Saving..." : "Save name"}
                    </Button>
                  )}

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
          </Card>

          {deleteConfirm && isOwner && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{
                ...outerCardStyle,
                border: "1px solid rgba(220,120,120,0.24)",
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />

              <div className="relative z-10 p-6">
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: "#ffe5e5",
                    letterSpacing: "-0.03em",
                  }}
                >
                  Delete team?
                </div>

                <p
                  style={{
                    marginTop: 10,
                    color: "rgba(255,224,224,0.78)",
                    lineHeight: 1.75,
                  }}
                >
                  This will permanently delete the team, its members list, and all pending invites.
                </p>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={deletingTeam}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleDeleteTeam}
                    disabled={deletingTeam}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dangerButtonStyle}
                  >
                    {deletingTeam ? "Deleting..." : "Delete Team"}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {canManageTeam && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 14,
                    color: "#d8e0dd",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Invite member
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <input
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    disabled={inviting}
                    style={inputStyle}
                  />

                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    disabled={inviting}
                    style={inputStyle}
                  >
                    {["OWNER", "ADMIN", "MEMBER", "VIEWER"].map((role) => (
                      <option key={role} value={role} style={{ color: "#102126" }}>
                        {role}
                      </option>
                    ))}
                  </select>

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
          )}

          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#d8e0dd",
                  letterSpacing: "-0.02em",
                  fontSize: 20,
                }}
              >
                Members
              </div>

              {!team.members || team.members.length === 0 ? (
                <div style={{ color: "rgba(194,204,201,0.76)" }}>No members found.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {team.members.map((member) => {
                    const name = displayMemberName(member);
                    const email = displayMemberEmail(member);
                    const isSelf = member.userId === currentUserId;
                    const memberIsOwner = member.role === "OWNER";

                    return (
                      <div key={member.userId} style={rowCardStyle}>
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
                            <div style={{ color: "#d8e0dd", fontWeight: 700 }}>
                              {name} {isSelf ? "(You)" : ""}
                            </div>
                            <div
                              style={{
                                color: "rgba(194,204,201,0.72)",
                                fontSize: 13,
                                marginTop: 4,
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
                                <select
                                  value={member.role}
                                  onChange={(e) => handleRoleChange(member, e.target.value)}
                                  disabled={roleSavingKey === member.userId}
                                  style={{ ...inputStyle, minWidth: 130, minHeight: 44 }}
                                >
                                  {ROLE_OPTIONS.map((role) => (
                                    <option key={role} value={role} style={{ color: "#102126" }}>
                                      {role}
                                    </option>
                                  ))}
                                </select>

                                <Button
                                  variant="secondary"
                                  onClick={() => handleRemoveMember(member)}
                                  disabled={removingMemberId === member.userId}
                                  className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                                  style={dangerButtonStyle}
                                >
                                  {removingMemberId === member.userId ? "Removing..." : "Remove"}
                                </Button>
                              </>
                            ) : (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  minHeight: 30,
                                  padding: "6px 12px",
                                  borderRadius: 999,
                                  fontSize: 11,
                                  fontWeight: 800,
                                  letterSpacing: "0.12em",
                                  textTransform: "uppercase",
                                  border: "1px solid rgba(214,184,157,0.20)",
                                  background:
                                    "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                                  color: "#dcc0a5",
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

          {canManageTeam && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 14,
                    color: "#d8e0dd",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Pending invites
                </div>

                {invites.length === 0 ? (
                  <div style={{ color: "rgba(194,204,201,0.76)" }}>No pending invites.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
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
                            <div style={{ color: "#d8e0dd", fontWeight: 700 }}>{invite.email}</div>
                            <div
                              style={{
                                color: "rgba(194,204,201,0.72)",
                                fontSize: 13,
                                marginTop: 4,
                              }}
                            >
                              {invite.role}
                              {invite.expiresAt
                                ? ` • expires ${new Date(invite.expiresAt).toLocaleString()}`
                                : ""}
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {invite.inviteUrl ? (
                              <Button
                                variant="secondary"
                                onClick={() => copyInviteLink(invite)}
                                className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                                style={secondaryButtonStyle}
                              >
                                Copy link
                              </Button>
                            ) : null}

                            <Button
                              variant="secondary"
                              onClick={() => handleDeleteInvite(invite.id)}
                              disabled={deletingInviteId === invite.id}
                              className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
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
          )}

          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#d8e0dd",
                  letterSpacing: "-0.02em",
                  fontSize: 20,
                }}
              >
                Team cases
              </div>

              {teamCases.length === 0 ? (
                <div style={{ color: "rgba(194,204,201,0.76)" }}>
                  No cases linked to this team yet.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {teamCases.map((item) => (
                    <Link
                      key={item.id}
                      href={`/cases/${item.id}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div style={{ ...rowCardStyle, cursor: "pointer" }}>
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
                            <div style={{ color: "#d8e0dd", fontWeight: 700 }}>{item.name}</div>
                            <div
                              style={{
                                color: "rgba(194,204,201,0.72)",
                                fontSize: 13,
                                marginTop: 4,
                              }}
                            >
                              {item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}
                            </div>
                          </div>

                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              minHeight: 30,
                              padding: "6px 12px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 800,
                              letterSpacing: "0.12em",
                              textTransform: "uppercase",
                              border: "1px solid rgba(158,216,207,0.20)",
                              background:
                                "linear-gradient(180deg, rgba(158,216,207,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                              color: "#bfe8df",
                            }}
                          >
                            Open
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              {canManageTeam && (
                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: "1px solid rgba(183,157,132,0.14)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                      {showAddCase ? "Cancel" : "Add Existing Case"}
                    </Button>
                  </div>

                  {showAddCase && (
                    <div
                      style={{
                        marginTop: 14,
                        paddingTop: 14,
                        borderTop: "1px solid rgba(183,157,132,0.14)",
                      }}
                    >
                      <div
                        style={{
                          color: "rgba(194,204,201,0.76)",
                          marginBottom: 12,
                          lineHeight: 1.7,
                        }}
                      >
                        {loadingAvailableCases
                          ? "Loading available cases..."
                          : availableCases.length === 0
                            ? "No available personal cases"
                            : "Select a case to link"}
                      </div>

                      {!loadingAvailableCases && availableCases.length > 0 && (
                        <div style={{ display: "grid", gap: 10 }}>
                          {availableCases.map((item) => (
                            <div key={item.id} style={rowCardStyle}>
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
                                  <div style={{ color: "#d8e0dd", fontWeight: 700 }}>
                                    {item.name}
                                  </div>
                                  <div
                                    style={{
                                      color: "rgba(194,204,201,0.72)",
                                      fontSize: 13,
                                      marginTop: 4,
                                    }}
                                  >
                                    {item.createdAt
                                      ? new Date(item.createdAt).toLocaleString()
                                      : ""}
                                  </div>
                                </div>

                                <Button
                                  onClick={() => handleAddExistingCase(item.id)}
                                  disabled={linkingCaseId === item.id}
                                  className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
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
              )}
            </div>
          </Card>

          {activities.length > 0 && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 14,
                    color: "#d8e0dd",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Recent activity
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  {activities.slice(0, 10).map((activity) => (
                    <div
                      key={activity.id}
                      style={{
                        ...rowCardStyle,
                        padding: 14,
                      }}
                    >
                      <div style={{ color: "#d8e0dd", fontWeight: 700 }}>
                        {activity.eventType.replace(/_/g, " ")}
                      </div>
                      <div
                        style={{
                          color: "rgba(194,204,201,0.72)",
                          fontSize: 13,
                          marginTop: 4,
                        }}
                      >
                        {activity.actor?.displayName || activity.actor?.email || "System"} •{" "}
                        {activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}
                      </div>
                      {activity.metadata && (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: "rgba(194,204,201,0.62)",
                            lineHeight: 1.65,
                          }}
                        >
                          {JSON.stringify(activity.metadata).substring(0, 60)}
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
    </div>
  );
}