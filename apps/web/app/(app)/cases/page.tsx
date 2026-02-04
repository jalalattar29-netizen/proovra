"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";

export default function CasesPage() {
  const [cases, setCases] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/v1/cases")
      .then((data) => setCases(data.items ?? []))
      .catch(() => setCases([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>Cases</h1>
          <p className="page-subtitle">Organize evidence into cases.</p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading cases...</Card>
        ) : (
          (cases.length ? cases : [{ id: "1", name: "Unsorted" }]).map((item) => (
            <Card key={item.id}>
              <Link href={`/cases/${item.id}`}>{item.name}</Link>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
