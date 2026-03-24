"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

interface Case {
  id: string;
  name: string;
}

export default function CasesPage() {
  const { addToast } = useToast();
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch("/v1/cases");
      setCases(data.items ?? []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to load cases";
      setError(errorMessage);
      setCases([]);
      captureException(err, { feature: "cases_page_list" });
      addToast(errorMessage, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCases();
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

  const handleStartRename = (caseItem: Case) => {
    setRenamingId(caseItem.id);
    setRenameValue(caseItem.name);
  };

  const handleRename = async () => {
    if (!renamingId || !renameValue.trim()) return;
    setRenamingId(null);
    addToast("Renaming case...", "info");
    try {
      await apiFetch(`/v1/cases/${renamingId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: renameValue.trim() })
      });
      setCases((prev) =>
        prev.map((c) => (c.id === renamingId ? { ...c, name: renameValue.trim() } : c))
      );
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to rename case";
      captureException(err, { feature: "cases_rename", caseId: renamingId });
      addToast(errorMessage, "error");
    }
  };

  const handleStartDelete = (caseId: string) => {
    setDeletingId(caseId);
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeletingId(null);
    addToast("Deleting case...", "info");
    try {
      await apiFetch(`/v1/cases/${deletingId}`, { method: "DELETE" });
      setCases((prev) => prev.filter((c) => c.id !== deletingId));
      addToast("Case deleted successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to delete case";
      captureException(err, { feature: "cases_delete", caseId: deletingId });
      addToast(errorMessage, "error");
    }
  };

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
              <Skeleton width="100%" height="80px" />
              <Skeleton width="100%" height="80px" />
              <Skeleton width="100%" height="80px" />
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
              />
            </Card>
          ) : (
            cases.map((caseItem) => (
              <Card key={caseItem.id}>
                <div style={{ padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                    <Link href={`/cases/${caseItem.id}`} style={{ textDecoration: "none", flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 500,
                          color: "#0F172A",
                          cursor: "pointer",
                          wordBreak: "break-word",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {caseItem.name}
                      </div>
                    </Link>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button
                        variant="secondary"
                        onClick={() => handleStartRename(caseItem)}
                        disabled={renamingId !== null || deletingId !== null}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleStartDelete(caseItem.id)}
                        disabled={renamingId !== null || deletingId !== null}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* Rename Modal */}
      {renamingId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000
          }}
          onClick={() => setRenamingId(null)}
        >
          <Card className="card-modal">
            <div style={{ padding: 24 }}>
              <h3 style={{ margin: "0 0 16px 0", fontSize: 18, fontWeight: 600 }}>Rename Case</h3>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Case name"
                maxLength={120}
                style={{
                  width: "100%",
                  padding: 10,
                  marginBottom: 16,
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  fontSize: 14,
                  boxSizing: "border-box",
                  fontFamily: "inherit"
                }}
                autoFocus
              />
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setRenamingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
                <div style={{ flex: 1 }}>
                  <Button
                    className="navy-btn"
                    onClick={handleRename}
                    disabled={!renameValue.trim()}
                  >
                    Rename
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000
          }}
          onClick={() => setDeletingId(null)}
        >
          <Card className="card-modal">
            <div style={{ padding: 24 }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 18, fontWeight: 600, color: "#DC2626" }}>
                Delete Case?
              </h3>
              <p style={{ margin: "0 0 16px 0", fontSize: 14, color: "#64748b" }}>
                The case will be deleted, but all evidence will remain in your dashboard.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeletingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
                <div style={{ flex: 1 }}>
                  <Button
                    onClick={handleDelete}
                    className="button-danger"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
