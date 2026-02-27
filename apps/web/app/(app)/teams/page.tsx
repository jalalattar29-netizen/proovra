"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";

export default function TeamsPage() {
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/v1/teams")
      .then((data) => setTeams(data.teams ?? []))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load teams");
        setTeams([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    const name = window.prompt("Team name");
    if (!name) return;
    try {
      const created = await apiFetch("/v1/teams", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setTeams((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create team");
    }
  };

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
                Manage access and members.
              </p>
            </div>
            <Button className="navy-btn" onClick={handleCreate}>Create Team</Button>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading teams...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : teams.length === 0 ? (
          <Card>
            <div className="empty-state">
<div className="empty-state-icon empty-state-icon-svg team-empty-icon">
  <span className="team-empty-icon__glyph">
    <Icons.Teams />
  </span>
</div>              <div>No teams yet. Create one to manage members.</div>
              <div style={{ marginTop: 16 }}>
                <Button className="navy-btn" onClick={handleCreate}>Create Team</Button>
              </div>
            </div>
          </Card>
        ) : (
          teams.map((item) => (
            <Card key={item.id}>
              {isUuid(item.id) ? <Link href={`/teams/${item.id}`}>{item.name}</Link> : item.name}
            </Card>
          ))
        )}
        </div>
      </div>
    </div>
  );
}
