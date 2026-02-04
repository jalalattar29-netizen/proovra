"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";

export default function TeamDetailPage() {
  const params = useParams<{ id: string }>();
  const [name, setName] = useState("Team");

  useEffect(() => {
    if (!params?.id) return;
    apiFetch(`/v1/teams/${params.id}`)
      .then((data) => setName(data.name ?? "Team"))
      .catch(() => setName("Team"));
  }, [params?.id]);
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{name}</h1>
          <p className="page-subtitle">Manage members and roles.</p>
        </div>
      </div>
      <Card>
        <div style={{ fontWeight: 600 }}>Members (5 seats)</div>
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <div>Owner — you</div>
          <div>Member — investigator@example.com</div>
        </div>
      </Card>
    </div>
  );
}
