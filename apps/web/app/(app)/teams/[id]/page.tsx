"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, useToast, Skeleton } from "../../../../components/ui";
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
  const [availableCases, setAvailableCases] = useState<TeamCase[]>([]);
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
        apiFetch(`/v1/teams/${teamId}/invites`).catch(() => ({ invites: [] as TeamInvite[] })),
        apiFetch(`/v1/teams/${teamId}/cases`).catch(() => ({ items: [] as TeamCase[] })),
        apiFetch(`/v1/teams/${teamId}/activity`).catch(() => ({ activities: [] as TeamActivity[] })),
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
    loadData();
  }, [teamId]);

  const myMemberRecord = useMemo(() => {
    if (!team?.members || !currentUserId) return null;
    return team.members.find((member) => member.userId === currentUserId) ?? null;
  }, [team?.members, currentUserId]);

  const currentRole = team?.currentUserRole || myMemberRecord?.role || "VIEWER";
  const isOwner = currentRole === "OWNER";
  const canManageTeam = team?.canManageMembers ?? (currentRole === "OWNER" || currentRole === "ADMIN");

  const displayMemberName = (member: TeamMember) => {
    return (
      member.user?.displayName ||
      member.label ||
      member.user?.email ||
      member.userId
    );
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
    if (!teamId || !canManageTeam) return;
    if (!member.userId) return;

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
      captureException(err, { feature: "team_member_role_update", teamId, memberId: member.userId });
      addToast(message, "error");
    } finally {
      setRoleSavingKey(null);
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    if (!teamId || !canManageTeam) return;
    if (!member.userId) return;

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
const data = await apiFetch("/v1/cases");
const existing = new Set(teamCases.map((c) => c.id));

const available = ((data.items ?? []) as AvailableCaseItem[]).filter(
  (item) => !existing.has(item.id) && !item.teamId
);      type AvailableCaseItem = {
  id: string;
  name: string;
  createdAt?: string;
  ownerUserId?: string;
  teamId?: string | null;
};
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
        setTeamCases((prev) => [linkedCase, ...prev]);
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

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Loading team...
            </h1>
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
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Team
            </h1>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
            <Card className="case-error-card">{error || "Team not found"}</Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {team.name ?? "Team"}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Manage team access, members, invitations, and shared case visibility.
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span className="badge ready">
                {team.stats?.memberCount ?? team.members?.length ?? 0} member
                {(team.stats?.memberCount ?? team.members?.length ?? 0) === 1 ? "" : "s"}
              </span>
              <span className="badge processing">{currentRole}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          <Card className="case-section-card">
            <div style={{ padding: 16 }}>
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
                  <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                    Team overview
                  </div>

                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#94A3B8" }}>Team name</span>
                    <input
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      disabled={!canManageTeam || savingName}
                      className="case-text-input"
                    />
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {canManageTeam && (
                    <Button
                      className="navy-btn"
                      onClick={handleSaveTeamName}
                      disabled={savingName || !teamName.trim()}
                    >
                      {savingName ? "Saving..." : "Save name"}
                    </Button>
                  )}

                  {isOwner && (
                    <Button
                      variant="secondary"
                      onClick={() => setDeleteConfirm(true)}
                      disabled={deletingTeam}
                      className="case-danger-btn"
                    >
                      Delete Team
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>

          {deleteConfirm && isOwner && (
            <Card className="case-delete-card">
              <div style={{ padding: 16 }}>
                <div className="case-delete-title">Delete Team?</div>
                <p className="case-delete-subtitle">
                  This will permanently delete the team, its members list, and pending invites.
                </p>

                <div className="case-inline-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={deletingTeam}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleDeleteTeam}
                    disabled={deletingTeam}
                    className="case-delete-confirm-btn"
                  >
                    {deletingTeam ? "Deleting..." : "Delete Team"}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {canManageTeam && (
            <Card className="case-section-card">
              <div style={{ padding: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                  Invite member
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <input
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="case-text-input"
                    disabled={inviting}
                  />

                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="case-select"
                    disabled={inviting}
                  >
                    {["OWNER", "ADMIN", "MEMBER", "VIEWER"].map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>

                  <Button
                    className="navy-btn"
                    onClick={handleInvite}
                    disabled={inviting || !inviteEmail.trim()}
                  >
                    {inviting ? "Sending..." : "Send invite"}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <Card className="case-section-card">
            <div style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                Members
              </div>

              {!team.members || team.members.length === 0 ? (
                <div className="case-muted-text">No members found.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {team.members.map((member) => {
                    const name = displayMemberName(member);
                    const email = displayMemberEmail(member);
                    const isSelf = member.userId === currentUserId;
                    const memberIsOwner = member.role === "OWNER";

                    return (
                      <div key={member.userId} className="case-share-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="case-share-name">
                            {name} {isSelf ? "(You)" : ""}
                          </div>
                          <div className="case-share-email">{email || member.userId}</div>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          {canManageTeam && !memberIsOwner ? (
                            <>
                              <select
                                value={member.role}
                                onChange={(e) => handleRoleChange(member, e.target.value)}
                                disabled={roleSavingKey === member.userId}
                                className="case-select"
                                style={{ minWidth: 120 }}
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
                                className="case-danger-btn case-small-btn"
                              >
                                {removingMemberId === member.userId ? "Removing..." : "Remove"}
                              </Button>
                            </>
                          ) : (
                            <span className="badge processing">{member.role}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          {canManageTeam && (
            <Card className="case-section-card">
              <div style={{ padding: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                  Pending invites
                </div>

                {invites.length === 0 ? (
                  <div className="case-muted-text">No pending invites.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {invites.map((invite) => (
                      <div key={invite.id} className="case-share-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="case-share-name">{invite.email}</div>
                          <div className="case-share-email">
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
                              className="case-small-btn"
                            >
                              Copy link
                            </Button>
                          ) : null}

                          <Button
                            variant="secondary"
                            onClick={() => handleDeleteInvite(invite.id)}
                            disabled={deletingInviteId === invite.id}
                            className="case-danger-btn case-small-btn"
                          >
                            {deletingInviteId === invite.id ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card className="case-section-card">
            <div style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                Team cases
              </div>

              {teamCases.length === 0 ? (
                <div className="case-muted-text">No cases linked to this team yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {teamCases.map((item) => (
                    <Link
                      key={item.id}
                      href={`/cases/${item.id}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div className="case-evidence-row" style={{ cursor: "pointer" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="case-share-name">{item.name}</div>
                          <div className="case-share-email">
                            {item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}
                          </div>
                        </div>

                        <span className="badge ready">Open</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              {canManageTeam && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(148, 163, 184, 0.16)" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button className="navy-btn" onClick={handleCreateTeamCase}>
                      Create Team Case
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => {
                        setShowAddCase(!showAddCase);
                        if (!showAddCase) loadAvailableCases();
                      }}
                    >
                      {showAddCase ? "Cancel" : "Add Existing Case"}
                    </Button>
                  </div>

                  {showAddCase && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(148, 163, 184, 0.16)" }}>
                      <div className="case-muted-text" style={{ marginBottom: 10 }}>
                        {loadingAvailableCases ? "Loading available cases..." : availableCases.length === 0 ? "No available personal cases" : "Select a case to link"}
                      </div>

                      {!loadingAvailableCases && availableCases.length > 0 && (
                        <div style={{ display: "grid", gap: 10 }}>
                          {availableCases.map((item: TeamCase) => (
                            <div key={item.id} className="case-evidence-row">
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="case-share-name">{item.name}</div>
                                <div className="case-share-email">
                                  {item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}
                                </div>
                              </div>

                              <Button
                                className="navy-btn case-small-btn"
                                onClick={() => handleAddExistingCase(item.id)}
                                disabled={linkingCaseId === item.id}
                              >
                                {linkingCaseId === item.id ? "Linking..." : "Link"}
                              </Button>
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
            <Card className="case-section-card">
              <div style={{ padding: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                  Recent activity
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  {activities.slice(0, 10).map((activity) => (
                    <div key={activity.id} style={{ padding: 8, borderRadius: 4, backgroundColor: "rgba(148, 163, 184, 0.05)" }}>
                      <div className="case-share-name">
                        {activity.eventType.replace(/_/g, " ")}
                      </div>
                      <div className="case-share-email">
                        {activity.actor?.displayName || activity.actor?.email || "System"} •{" "}
                        {activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}
                      </div>
                      {activity.metadata && (
                        <div className="case-muted-text" style={{ marginTop: 4, fontSize: 11 }}>
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