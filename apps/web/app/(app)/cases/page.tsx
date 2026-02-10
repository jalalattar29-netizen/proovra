"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card } from "../../../components/ui";
import { Icons } from "../../../components/icons";
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

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Cases
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Organize evidence into cases.
              </p>
            </div>
            <Button className="navy-btn" onClick={handleCreate}>Create Case</Button>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading cases...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : cases.length === 0 ? (
          <Card>
            <div className="empty-state">
              <div className="empty-state-icon empty-state-icon-svg"><Icons.Evidence /></div>
              <div>No cases yet. Create one to organize evidence.</div>
              <div style={{ marginTop: 16 }}>
                <Button className="navy-btn" onClick={handleCreate}>Create Case</Button>
              </div>
            </div>
          </Card>
        ) : (
          cases.map((item) => (
            <Card key={item.id}>
              {isUuid(item.id) ? <Link href={`/cases/${item.id}`}>{item.name}</Link> : item.name}
            </Card>
          ))
        )}
        </div>
      </div>
    </div>
  );
}
