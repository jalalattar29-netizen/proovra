"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "../../../components/ui";
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
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>Teams</h1>
          <p className="page-subtitle">Manage access and members.</p>
        </div>
        <Button onClick={handleCreate}>Create Team</Button>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading teams...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : teams.length === 0 ? (
          <Card>
            <div style={{ display: "grid", gap: 12 }}>
              <div>No teams yet. Create one to manage members.</div>
              <Button onClick={handleCreate}>Create Team</Button>
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
  );
}
