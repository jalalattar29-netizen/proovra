"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";

export default function CasesPage() {
  const [cases, setCases] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/v1/cases")
      .then((data) => setCases(data.items ?? []))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load cases");
        setCases([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    const name = window.prompt("Case name");
    if (!name) return;
    try {
      const created = await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setCases((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create case");
    }
  };

  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>Cases</h1>
          <p className="page-subtitle">Organize evidence into cases.</p>
        </div>
        <Button onClick={handleCreate}>Create Case</Button>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading cases...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : cases.length === 0 ? (
          <Card>No cases yet. Create one to organize evidence.</Card>
        ) : (
          cases.map((item) => (
            <Card key={item.id}>
              <Link href={`/cases/${item.id}`}>{item.name}</Link>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
