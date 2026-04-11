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

function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  return date.toLocaleString();
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
      const [meRes, teamRes, invitesRes, casesRes, activitiesRes] =
        await Promise.all([
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

  const displayMemberName = (member: TeamMember) =>
    member.user?.displayName || member.label || member.user?.email || member.userId;

  const displayMemberEmail = (member: TeamMember) => member.user?.email || "";

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
      const message =
        err instanceof Error ? err.message : "Failed to update team name";
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
      const message =
        err instanceof Error ? err.message : "Failed to invite member";
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
      const message =
        err instanceof Error ? err.message : "Failed to remove member";
      captureException(err, {
        feature: "team_member_remove",
        teamId,
        memberId: member.userId,
      });
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
      const message =
        err instanceof Error ? err.message : "Failed to delete invite";
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
      const message =
        err instanceof Error ? err.message : "Failed to create team case";
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
        err instanceof Error ? err.message : "Failed to load available cases";
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

  const tertiaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.16)",
        color: "#7a624d",
        background:
          "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.64) 100%)",
        boxShadow:
          "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
        textShadow: "0 1px 0 rgba(255,255,255,0.32)",
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

  const noteCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.14)",
        background:
          "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(255,255,255,0.36))",
        color: "#7f6450",
        borderRadius: 18,
        lineHeight: 1.75,
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
              Team Workspace
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
              Team Workspace
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Team details <span style={{ color: "#c3ebe2" }}>could not load</span>.
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
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

              <div className="relative z-10 p-6">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 10,
                    color: "#21353a",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Unable to load team
                </div>

                <div style={{ color: "#5d6d71", lineHeight: 1.7 }}>
                  {error || "Team not found."}
                </div>

                <div style={{ marginTop: 16 }}>
                  <Link href="/teams" style={{ textDecoration: "none" }}>
                    <Button
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
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
    <div className="section app-section teams-detail-page-shell">
      <style jsx global>{`
        .teams-detail-page-shell .team-field,
        .teams-detail-page-shell .team-select {
          width: 100%;
          min-height: 52px;
          padding: 0 16px;
          border-radius: 18px;
          border: 1px solid rgba(79, 112, 107, 0.14);
          background: linear-gradient(
            180deg,
            rgba(250, 251, 249, 0.94) 0%,
            rgba(241, 244, 241, 0.98) 100%
          );
          color: #23373b;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.68),
            0 10px 22px rgba(0, 0, 0, 0.05);
          outline: none;
        }

        .teams-detail-page-shell .team-field::placeholder {
          color: rgba(93, 109, 113, 0.62);
        }

        .teams-detail-page-shell .team-field:focus,
        .teams-detail-page-shell .team-select:focus {
          border-color: rgba(79, 112, 107, 0.22);
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
              rgba(250, 251, 249, 0.94) 0%,
              rgba(241, 244, 241, 0.98) 100%
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

        @media (max-width: 1100px) {
          .teams-detail-page-shell .team-main-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
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

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {(team.stats?.memberCount ?? team.members?.length ?? 0).toString()} active
                  member
                  {(team.stats?.memberCount ?? team.members?.length ?? 0) === 1 ? "" : "s"}
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
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Link href="/teams" style={{ textDecoration: "none" }}>
                <Button
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={secondaryButtonStyle}
                >
                  Back to Teams
                </Button>
              </Link>

              <Link href="/cases" style={{ textDecoration: "none" }}>
                <Button
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={primaryButtonStyle}
                >
                  Open Cases
                </Button>
              </Link>
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
          className="container relative z-10"
          style={{
            display: "grid",
            gap: 18,
            paddingBottom: 72,
          }}
        >
          <div
            className="team-main-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.18fr) minmax(0, 0.82fr)",
              gap: 18,
              alignItems: "start",
            }}
          >
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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
                        marginBottom: 6,
                        color: "#21353a",
                        letterSpacing: "-0.02em",
                        fontSize: 20,
                      }}
                    >
                      Team overview
                    </div>

                    <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                      Control team identity, membership permissions, and workspace ownership.
                    </div>

                    <label style={{ display: "grid", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "#6a777b" }}>Team name</span>
                      <input
                        value={teamName}
                        onChange={(e) => setTeamName(e.target.value)}
                        disabled={!canManageTeam || savingName}
                        className="team-field"
                      />
                    </label>
                  </div>

                  <div style={{ display: "grid", gap: 10, minWidth: 220 }}>
                    <div
                      style={{
                        ...noteCardStyle,
                        padding: 14,
                      }}
                    >
                      <strong>Owner:</strong>{" "}
                      {team.ownerUserId === currentUserId ? "You" : "Team owner"}
                      <br />
                      <strong>Pending invites:</strong>{" "}
                      {team.stats?.pendingInviteCount ?? invites.length}
                    </div>

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

            {canManageTeam ? (
              <Card
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

                <div className="relative z-10 p-6 md:p-7">
                  <div
                    style={{
                      fontWeight: 700,
                      marginBottom: 6,
                      color: "#21353a",
                      letterSpacing: "-0.02em",
                      fontSize: 20,
                    }}
                  >
                    Invite member
                  </div>

                  <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                    Add a collaborator with the right access level for this workspace.
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <input
                      placeholder="Email address"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      disabled={inviting}
                      className="team-field"
                    />

                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      disabled={inviting}
                      className="team-select"
                    >
                      {["OWNER", "ADMIN", "MEMBER", "VIEWER"].map((role) => (
                        <option key={role} value={role}>
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
            ) : (
              <Card
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

                <div className="relative z-10 p-6 md:p-7">
                  <div
                    style={{
                      fontWeight: 700,
                      marginBottom: 6,
                      color: "#21353a",
                      letterSpacing: "-0.02em",
                      fontSize: 20,
                    }}
                  >
                    Access summary
                  </div>

                  <div
                    style={{
                      ...noteCardStyle,
                      padding: 14,
                    }}
                  >
                    You currently have <strong>{currentRole}</strong> access. Contact an owner
                    or admin to manage members, invitations, or linked team cases.
                  </div>
                </div>
              </Card>
            )}
          </div>

          {deleteConfirm && isOwner && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

              <div className="relative z-10 p-6">
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

                <p
                  style={{
                    marginTop: 10,
                    color: "#8b4a4a",
                    lineHeight: 1.75,
                  }}
                >
                  This will permanently delete the team, its members list, and all pending
                  invites.
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

          <div
            className="team-main-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 0.95fr)",
              gap: 18,
              alignItems: "start",
            }}
          >
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 6,
                    color: "#21353a",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Members
                </div>

                <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                  Review every collaborator in this team and adjust access where allowed.
                </div>

                {!team.members || team.members.length === 0 ? (
                  <div style={{ color: "#5d6d71" }}>No members found.</div>
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
                                  <select
                                    value={member.role}
                                    onChange={(e) =>
                                      handleRoleChange(member, e.target.value)
                                    }
                                    disabled={roleSavingKey === member.userId}
                                    className="team-select"
                                    style={{ minWidth: 132, minHeight: 44 }}
                                  >
                                    {ROLE_OPTIONS.map((role) => (
                                      <option key={role} value={role}>
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

            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 6,
                    color: "#21353a",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Pending invites
                </div>

                <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                  Monitor invitation links, expiry timing, and unaccepted team access.
                </div>

                {invites.length === 0 ? (
                  <div style={{ color: "#5d6d71" }}>No pending invites.</div>
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
          </div>

          <div
            className="team-main-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.02fr) minmax(0, 0.98fr)",
              gap: 18,
              alignItems: "start",
            }}
          >
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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

              <div className="relative z-10 p-6 md:p-7">
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 6,
                    color: "#21353a",
                    letterSpacing: "-0.02em",
                    fontSize: 20,
                  }}
                >
                  Team cases
                </div>

                <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                  Shared cases linked to this team and available to the permitted members.
                </div>

                {teamCases.length === 0 ? (
                  <div style={{ color: "#5d6d71" }}>
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
                                  ? new Date(item.createdAt).toLocaleString()
                                  : ""}
                              </div>
                            </div>

                            <span
                              style={{
                                ...statPillBase,
                                border: "1px solid rgba(79,112,107,0.16)",
                                background:
                                  "linear-gradient(180deg, rgba(191,232,223,0.20) 0%, rgba(255,255,255,0.42) 100%)",
                                color: "#2d5b59",
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
                      borderTop: "1px solid rgba(79,112,107,0.10)",
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
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                <div className="relative z-10 p-6 md:p-7">
                  <div
                    style={{
                      fontWeight: 700,
                      marginBottom: 6,
                      color: "#21353a",
                      letterSpacing: "-0.02em",
                      fontSize: 20,
                    }}
                  >
                    Recent activity
                  </div>

                  <div style={{ color: "#5d6d71", lineHeight: 1.7, marginBottom: 16 }}>
                    Latest actions captured inside the team workspace.
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
      </div>
    </div>
  );
}