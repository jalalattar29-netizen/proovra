"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

export default function CasesPage() {
  const { addToast } = useToast();
  const [cases, setCases] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    
    apiFetch("/v1/cases")
      .then((data) => {
        setCases(data.items ?? []);
        addToast("Cases loaded successfully", "success");
      })
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : "Failed to load cases";
        setError(errorMessage);
        setCases([]);
        captureException(err, { feature: "cases_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    const name = window.prompt("Case name");
    if (!name) return;
    
    setCreating(true);
    addToast("Creating case...", "info");
    
    try {
      const created = await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setCases((prev) => [created, ...prev]);
      addToast(`Case "${name}" created successfully`, "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create case";
      captureException(err, { feature: "cases_create", caseName: name });
      addToast(errorMessage, "error");
    } finally {
      setCreating(false);
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
            <Button 
              className="navy-btn" 
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? "Creating..." : "Create Case"}
            </Button>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 8 }}>
              <Skeleton width="100%" height="40px" />
              <Skeleton width="100%" height="40px" />
              <Skeleton width="100%" height="40px" />
            </div>
          ) : error ? (
            <Card>
              <div style={{
                padding: 16,
                background: "#FEE2E2",
                borderRadius: 8,
                color: "#991B1B",
                fontSize: 12
              }}>
                {error}
              </div>
            </Card>
          ) : cases.length === 0 ? (
            <Card>
              <EmptyState
                title="No cases yet"
                subtitle="Create one to organize your evidence by investigation."
                action={() => (
                  <Button 
                    onClick={handleCreate}
                    disabled={creating}
                  >
                    {creating ? "Creating..." : "Create Case"}
                  </Button>
                )}
              </EmptyState>
            </Card>
          ) : (
            cases.map((item) => (
              <Card key={item.id} style={{ padding: 16, cursor: "pointer", transition: "all 0.2s" }}>
                {isUuid(item.id) ? (
                  <Link href={`/cases/${item.id}`} style={{ textDecoration: "none" }}>
                    <div style={{ fontWeight: 600, fontSize: 16, color: "#0B1F2A" }}>
                      {item.name}
                    </div>
                  </Link>
                ) : (
                  <div style={{ fontWeight: 600, fontSize: 16, color: "#0B1F2A" }}>
                    {item.name}
                  </div>
                )}
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
