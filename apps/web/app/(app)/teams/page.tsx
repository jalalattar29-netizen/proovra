"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type TeamListItem = {
  id: string;
  name: string;
  legalName?: string | null;
  memberCount?: number;
  createdAt?: string;
};

export default function TeamsPage() {
  const { addToast } = useToast();

  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTeams = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/teams");
      setTeams(data?.teams ?? []);
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
        body: JSON.stringify({ name: name.trim() })
      });

      setTeams((prev) => [created, ...prev]);
      addToast("Team created successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create team";
      setError(message);
      captureException(err, { feature: "teams_create", teamName: name.trim() });
      addToast(message, "error");
    } finally {
      setCreating(false);
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
                Manage your team workspace, members, and shared access.
              </p>
            </div>

            <Button className="navy-btn" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating..." : "Create Team"}
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <Skeleton width="100%" height="92px" />
              <Skeleton width="100%" height="92px" />
              <Skeleton width="100%" height="92px" />
            </div>
          ) : error ? (
            <Card className="case-error-card">
              {error}
            </Card>
          ) : teams.length === 0 ? (
            <Card className="case-section-card">
              <EmptyState
                icon={
                  <div className="empty-state-icon empty-state-icon-svg team-empty-icon">
                    <span className="team-empty-icon__glyph">
                      <Icons.Teams />
                    </span>
                  </div>
                }
                title="No teams yet"
                subtitle="Create a team to manage members and collaborate around shared evidence and cases."
              />
              <div style={{ marginTop: 16 }}>
                <Button className="navy-btn" onClick={handleCreate} disabled={creating}>
                  {creating ? "Creating..." : "Create Team"}
                </Button>
              </div>
            </Card>
          ) : (
            teams.map((team) => (
              <Card key={team.id} className="case-section-card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 16,
                    padding: 16
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Link
                      href={`/teams/${team.id}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: "#E2E8F0",
                          wordBreak: "break-word"
                        }}
                      >
                        {team.name || "Untitled Team"}
                      </div>
                    </Link>

                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 13,
                        color: "#94A3B8",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 12
                      }}
                    >
                      {team.legalName ? <span>{team.legalName}</span> : null}
                      {typeof team.memberCount === "number" ? (
                        <span>{team.memberCount} member{team.memberCount === 1 ? "" : "s"}</span>
                      ) : null}
                      {team.createdAt ? (
                        <span>Created {new Date(team.createdAt).toLocaleDateString()}</span>
                      ) : null}
                    </div>
                  </div>

                  <Link href={`/teams/${team.id}`} style={{ textDecoration: "none" }}>
                    <Button variant="secondary">Open</Button>
                  </Link>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}