"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card, useToast, Skeleton } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

type TeamMemberUser = {
  id?: string;
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
};

type TeamMember = {
  id?: string;
  userId: string;
  role: string;
  createdAt?: string;
  joinedAt?: string;
  user?: TeamMemberUser;
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
};

type TeamInvite = {
  id: string;
  email: string;
  role: string;
  createdAt?: string;
  invitedAt?: string;
  expiresAt?: string;
  acceptedAt?: string | null;
  inviteUrl?: string;
};

type Team = {
  id: string;
  name?: string | null;
  ownerUserId?: string;
  legalName?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  timezone?: string | null;
  legalEmail?: string | null;
  retentionPolicy?: string | null;
  createdAt?: string;
  members?: TeamMember[];
};

type MeResponse = {
  user?: {
    id?: string;
  };
  id?: string;
};

const ROLE_OPTIONS = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
const RETENTION_OPTIONS = [
  { value: "YEAR_1", label: "1 year" },
  { value: "YEAR_5", label: "5 years" },
  { value: "FOREVER", label: "Forever" }
] as const;

export default function TeamDetailPage() {
  const params = useParams<{ id: string }>();
  const { addToast } = useToast();

  const [team, setTeam] = useState<Team | null>(null);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [savingField, setSavingField] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [inviting, setInviting] = useState(false);
  const [roleSavingKey, setRoleSavingKey] = useState<string | null>(null);

  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [timezone, setTimezone] = useState("");
  const [legalEmail, setLegalEmail] = useState("");
  const [retentionPolicy, setRetentionPolicy] = useState("FOREVER");

  const teamId = params?.id;

  const loadData = async () => {
    if (!teamId) return;

    setLoading(true);
    setError(null);

    try {
      const [meRes, teamRes, invitesRes] = await Promise.all([
        apiFetch("/v1/users/me") as Promise<MeResponse>,
        apiFetch(`/v1/teams/${teamId}`) as Promise<Team>,
        apiFetch(`/v1/teams/${teamId}/invites`).catch(() => ({ invites: [] as TeamInvite[] }))
      ]);

      const meId = meRes?.user?.id ?? meRes?.id ?? "";
      setCurrentUserId(meId);
      setTeam(teamRes ?? null);
      setInvites(invitesRes?.invites ?? []);

      setLegalName(teamRes?.legalName ?? "");
      setAddress(teamRes?.address ?? "");
      setLogoUrl(teamRes?.logoUrl ?? "");
      setTimezone(teamRes?.timezone ?? "");
      setLegalEmail(teamRes?.legalEmail ?? "");
      setRetentionPolicy(teamRes?.retentionPolicy ?? "FOREVER");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load team";
      setError(message);
      setTeam(null);
      setInvites([]);
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

  const canManageTeam = useMemo(() => {
    const role = myMemberRecord?.role;
    return role === "OWNER" || role === "ADMIN";
  }, [myMemberRecord?.role]);

  const displayMemberName = (member: TeamMember) => {
    return (
      member.user?.displayName ||
      member.displayName ||
      member.user?.name ||
      member.name ||
      member.user?.email ||
      member.email ||
      member.userId
    );
  };

  const displayMemberEmail = (member: TeamMember) => {
    return member.user?.email || member.email || "";
  };

  const handleProfileSave = async (field: keyof Team, value: string) => {
    if (!teamId || !canManageTeam) return;

    setSavingField(field);

    try {
      const updated = await apiFetch(`/v1/teams/${teamId}`, {
        method: "PATCH",
        body: JSON.stringify({
          [field]: value.trim() ? value.trim() : undefined
        })
      });

      setTeam(updated);
      addToast("Team updated successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update team";
      captureException(err, { feature: "team_profile_update", teamId, field });
      addToast(message, "error");
    } finally {
      setSavingField(null);
    }
  };

  const handleRetentionSave = async (value: string) => {
    if (!teamId || !canManageTeam) return;

    setSavingField("retentionPolicy");

    try {
      const updated = await apiFetch(`/v1/teams/${teamId}`, {
        method: "PATCH",
        body: JSON.stringify({ retentionPolicy: value })
      });

      setTeam(updated);
      setRetentionPolicy(value);
      addToast("Retention policy updated", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update retention policy";
      captureException(err, { feature: "team_retention_update", teamId });
      addToast(message, "error");
    } finally {
      setSavingField(null);
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
          role: inviteRole
        })
      });

      if (data?.invite) {
        setInvites((prev) => {
          const existingIndex = prev.findIndex((item) => item.id === data.invite.id);
          if (existingIndex >= 0) {
            const copy = [...prev];
            copy[existingIndex] = {
              ...copy[existingIndex],
              ...data.invite,
              inviteUrl: data.inviteUrl ?? copy[existingIndex].inviteUrl
            };
            return copy;
          }

          return [
            {
              ...data.invite,
              inviteUrl: data.inviteUrl
            },
            ...prev
          ];
        });
      }

      setInviteEmail("");
      setInviteRole("MEMBER");
      addToast("Invitation created successfully", "success");
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

    const key = member.userId;
    setRoleSavingKey(key);

    try {
      const data = await apiFetch(`/v1/teams/${teamId}/members/${member.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole })
      });

      setTeam((prev) => {
        if (!prev) return prev;

        return {
          ...prev,
          members:
            prev.members?.map((m) =>
              m.userId === member.userId
                ? {
                    ...m,
                    role: data?.member?.role ?? nextRole
                  }
                : m
            ) ?? []
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
            <Skeleton width="100%" height="160px" />
            <Skeleton width="100%" height="220px" />
            <Skeleton width="100%" height="220px" />
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
            <Card className="case-error-card">
              {error || "Team not found"}
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
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {team.name ?? "Team"}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Centralize members, invitations, and shared operational settings.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                justifyContent: "flex-end"
              }}
            >
              <span className="badge ready">
                {team.members?.length ?? 0} member{(team.members?.length ?? 0) === 1 ? "" : "s"}
              </span>
              <span className="badge processing">
                {myMemberRecord?.role ?? "VIEWER"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          <Card className="case-section-card">
            <div style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: "#E2E8F0" }}>
                Team profile
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Legal name</span>
                  <input
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    onBlur={() => handleProfileSave("legalName", legalName)}
                    disabled={!canManageTeam || savingField === "legalName"}
                    className="case-text-input"
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Address</span>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    onBlur={() => handleProfileSave("address", address)}
                    disabled={!canManageTeam || savingField === "address"}
                    className="case-text-input"
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Logo URL</span>
                  <input
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    onBlur={() => handleProfileSave("logoUrl", logoUrl)}
                    disabled={!canManageTeam || savingField === "logoUrl"}
                    className="case-text-input"
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Timezone</span>
                  <input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    onBlur={() => handleProfileSave("timezone", timezone)}
                    disabled={!canManageTeam || savingField === "timezone"}
                    className="case-text-input"
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Legal email</span>
                  <input
                    value={legalEmail}
                    onChange={(e) => setLegalEmail(e.target.value)}
                    onBlur={() => handleProfileSave("legalEmail", legalEmail)}
                    disabled={!canManageTeam || savingField === "legalEmail"}
                    className="case-text-input"
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Retention policy</span>
                  <select
                    value={retentionPolicy}
                    onChange={(e) => handleRetentionSave(e.target.value)}
                    disabled={!canManageTeam || savingField === "retentionPolicy"}
                    className="case-select"
                  >
                    {RETENTION_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </Card>

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
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>

                  <Button className="navy-btn" onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
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
                    const isOwner = member.role === "OWNER";

                    return (
                      <div
                        key={member.userId}
                        className="case-share-row"
                        style={{ alignItems: "center" }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="case-share-name">
                            {name} {isSelf ? "(You)" : ""}
                          </div>

                          <div className="case-share-email">
                            {email || member.userId}
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {canManageTeam && !isOwner ? (
                            <select
                              value={member.role}
                              onChange={(e) => handleRoleChange(member, e.target.value)}
                              disabled={roleSavingKey === member.userId}
                              className="case-select"
                              style={{ minWidth: 120 }}
                            >
                              {ROLE_OPTIONS.filter((role) => role !== "OWNER").map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
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

                          <span className="badge ready">Pending</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}