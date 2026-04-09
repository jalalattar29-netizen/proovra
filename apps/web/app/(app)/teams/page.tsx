"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, EmptyState, Skeleton, useToast } from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type TeamListItem = {
  id: string;
  name: string;
  role?: string;
  memberCount?: number;
  pendingInviteCount?: number;
  caseCount?: number;
  createdAt?: string;
};

export default function TeamsPage() {
  const { addToast } = useToast();
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadTeams = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/teams");
      setTeams(data.teams ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load teams";
      setError(message);
      setTeams([]);
      captureException(err, { feature: "teams_page_list" });
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, []);

  const handleCreate = async () => {
    const name = window.prompt("Team name");
    if (!name?.trim()) return;

    setCreating(true);

    try {
      const created = await apiFetch("/v1/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });

      setTeams((prev) => [
        {
          id: created.id,
          name: created.name,
          role: "OWNER",
          memberCount: 1,
          pendingInviteCount: 0,
          caseCount: 0,
          createdAt: created.createdAt,
        },
        ...prev,
      ]);

      addToast("Team created successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create team";
      captureException(err, { feature: "teams_page_create" });
      addToast(message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (teamId: string, teamName: string) => {
    if (!window.confirm(`Are you sure you want to delete "${teamName}"? Team cases will be converted to personal cases.`)) {
      return;
    }

    setDeleting(teamId);

    try {
      await apiFetch(`/v1/teams/${teamId}`, { method: "DELETE" });
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      addToast("Team deleted successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete team";
      captureException(err, { feature: "teams_page_delete" });
      addToast(message, "error");
    } finally {
      setDeleting(null);
    }
  };

return (
  <div className="section app-section">
    <div className="app-hero app-hero-full">
      <div className="container">
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Teams
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Manage collaborative workspaces, members, invites, and shared cases.
            </p>
          </div>

          <Button
            className="navy-btn"
            onClick={handleCreate}
            disabled={creating}
            style={{
              borderColor: "rgba(214,184,157,0.20)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 100%)",
              color: "#f3f7f5",
            }}
          >
            {creating ? "Creating..." : "Create Team"}
          </Button>
        </div>
      </div>
    </div>

    <div className="app-body app-body-full">
      <div className="container" style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <div style={{ display: "grid", gap: 12 }}>
            <Skeleton width="100%" height="96px" />
            <Skeleton width="100%" height="96px" />
            <Skeleton width="100%" height="96px" />
          </div>
        ) : error ? (
          <Card className="case-error-card">{error}</Card>
        ) : teams.length === 0 ? (
          <Card className="app-card">
            <EmptyState
              title="No teams yet"
              subtitle="Create a team to collaborate on shared cases and controlled access."
              action={() => (
                <Button className="navy-btn" onClick={handleCreate} disabled={creating}>
                  {creating ? "Creating..." : "Create Team"}
                </Button>
              )}
            />
          </Card>
        ) : (
          teams.map((item) => (
            <Card key={item.id} className="case-section-card app-card">
              <div style={{ padding: 18 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 16,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div
                        style={{
                          fontSize: 19,
                          fontWeight: 700,
                          color: "rgba(246,252,255,0.96)",
                          letterSpacing: "-0.02em",
                        }}
                      >
                        {item.name}
                      </div>

                      {item.role ? (
                        <span
                          className="badge processing"
                          style={{
                            background: "rgba(214,184,157,0.12)",
                            borderColor: "rgba(214,184,157,0.22)",
                            color: "#e6c9ae",
                          }}
                        >
                          {item.role}
                        </span>
                      ) : null}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        marginTop: 9,
                        fontSize: 12,
                        color: "rgba(219,235,248,0.72)",
                      }}
                    >
                      <span>{item.memberCount ?? 0} members</span>
                      <span style={{ color: "rgba(214,184,157,0.88)" }}>
                        {item.pendingInviteCount ?? 0} pending invites
                      </span>
                      <span>{item.caseCount ?? 0} cases</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Link href={`/teams/${item.id}`} style={{ textDecoration: "none" }}>
                      <Button className="navy-btn">Open</Button>
                    </Link>

                    {item.role === "OWNER" ? (
                      <Button
                        className="danger-btn"
                        onClick={() => handleDelete(item.id, item.name)}
                        disabled={deleting === item.id}
                      >
                        {deleting === item.id ? "Deleting..." : "Delete"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </Card>
          ))
        )}

        {!loading && !error && teams.length > 0 ? (
          <Card className="app-card">
            <div className="empty-state">
              <div className="empty-state-icon empty-state-icon-svg team-empty-icon">
                <span className="team-empty-icon__glyph">
                  <Icons.Teams />
                </span>
              </div>
              <div style={{ color: "rgba(219,235,248,0.82)" }}>
                Create another team when you need a separate workspace.
              </div>
              <div style={{ marginTop: 16 }}>
                <Button className="navy-btn" onClick={handleCreate} disabled={creating}>
                  {creating ? "Creating..." : "Create Team"}
                </Button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  </div>
);
}