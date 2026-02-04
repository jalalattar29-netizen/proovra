"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";

export default function TeamsPage() {
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/v1/teams")
      .then((data) => setTeams(data.teams ?? []))
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }, []);
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>Teams</h1>
          <p className="page-subtitle">Manage access and members.</p>
        </div>
        <Button>Create Team</Button>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading teams...</Card>
        ) : (
          (teams.length ? teams : [{ id: "1", name: "Proovra Core" }]).map((item) => (
            <Card key={item.id}>
              <Link href={`/teams/${item.id}`}>{item.name}</Link>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
