"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";

type TeamMember = {
  userId: string;
  role: string;
};

type Team = {
  id: string;
  name?: string | null;
  legalName?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  timezone?: string | null;
  legalEmail?: string | null;
  retentionPolicy?: string | null;
  members?: TeamMember[];
};

type TeamInvite = {
  id: string;
  email: string;
  role: string;
};

export default function TeamDetailPage() {
  const params = useParams<{ id: string }>();
  const [team, setTeam] = useState<Team | null>(null);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [saving, setSaving] = useState(false);

  const roles = useMemo(() => ["OWNER", "ADMIN", "MEMBER", "VIEWER"], []);

  useEffect(() => {
    if (!params?.id) return;
    setLoading(true);
    setError(null);
    Promise.all([apiFetch(`/v1/teams/${params.id}`), apiFetch(`/v1/teams/${params.id}/invites`)])
      .then(([teamData, invitesData]) => {
        setTeam(teamData ?? null);
        setInvites(invitesData.invites ?? []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load team");
        setTeam(null);
      })
      .finally(() => setLoading(false));
  }, [params?.id]);

  const handleInvite = async () => {
    if (!params?.id || !inviteEmail) return;
    setSaving(true);
    try {
      const data = await apiFetch(`/v1/teams/${params.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole })
      });
      setInvites((prev) => [data.invite, ...prev]);
      setInviteEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite member");
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    if (!params?.id) return;
    setSaving(true);
    try {
      const data = await apiFetch(`/v1/teams/${params.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      setTeam((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members?.map((m) =>
            m.userId === userId ? { ...m, role: data.member.role } : m
          ) ?? []
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setSaving(false);
    }
  };

  const handleProfileSave = async (field: string, value: string) => {
    if (!params?.id) return;
    setSaving(true);
    try {
      const updated = await apiFetch(`/v1/teams/${params.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value || undefined })
      });
      setTeam(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update team");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{team?.name ?? "Team"}</h1>
          <p className="page-subtitle">Manage members and roles.</p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading team...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : (
          <>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Organization profile</div>
              <div style={{ display: "grid", gap: 10 }}>
                {[
                  { label: "Legal name", key: "legalName" },
                  { label: "Address", key: "address" },
                  { label: "Logo URL", key: "logoUrl" },
                  { label: "Timezone", key: "timezone" },
                  { label: "Legal email", key: "legalEmail" }
                ].map((item) => (
                  <label key={item.key} style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#64748b" }}>{item.label}</span>
                    <input
                      defaultValue={team?.[item.key] ?? ""}
                      onBlur={(e) => handleProfileSave(item.key, e.currentTarget.value)}
                      style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
                    />
                  </label>
                ))}
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "#64748b" }}>Retention policy</span>
                  <select
                    defaultValue={team?.retentionPolicy ?? "FOREVER"}
                    onChange={(e) => handleProfileSave("retentionPolicy", e.currentTarget.value)}
                    style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
                  >
                    <option value="YEAR_1">1 year</option>
                    <option value="YEAR_5">5 years</option>
                    <option value="FOREVER">Forever</option>
                  </select>
                </label>
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Invite member</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input
                  placeholder="Email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <Button onClick={handleInvite} disabled={saving}>
                  Send invite
                </Button>
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Members</div>
              <div style={{ display: "grid", gap: 8 }}>
                {team?.members?.map((member) => (
                  <div
                    key={member.userId}
                    style={{ display: "flex", alignItems: "center", gap: 12 }}
                  >
                    <div style={{ flex: 1 }}>{member.userId}</div>
                    <select
                      value={member.role}
                      onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                      disabled={saving}
                      style={{ padding: 6, borderRadius: 8 }}
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Pending invites</div>
              {invites.length === 0 ? (
                <div>No pending invites.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {invites.map((invite) => (
                    <div key={invite.id}>
                      {invite.email} — {invite.role}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
