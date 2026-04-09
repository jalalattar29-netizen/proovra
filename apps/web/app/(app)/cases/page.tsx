"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  useToast,
  EmptyState,
  Skeleton
} from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

interface Case {
  id: string;
  name: string;
  teamId?: string | null;
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "personal" | "team">("all");

  const loadCases = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/cases");
      setCases(data.items ?? []);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load cases";
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
    if (!name?.trim()) return;

    setCreating(true);
    addToast("Creating case...", "info");

    try {
      const created = await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() })
      });

      setCases((prev) => [created, ...prev]);
      addToast(`Case "${name.trim()}" created successfully`, "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create case";
      captureException(err, {
        feature: "cases_create",
        caseName: name.trim()
      });
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

    const targetId = renamingId;
    const nextName = renameValue.trim();

    setBusyId(targetId);
    addToast("Renaming case...", "info");

    try {
      await apiFetch(`/v1/cases/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName })
      });

      setCases((prev) =>
        prev.map((c) => (c.id === targetId ? { ...c, name: nextName } : c))
      );

      setRenamingId(null);
      setRenameValue("");
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to rename case";
      captureException(err, { feature: "cases_rename", caseId: targetId });
      addToast(errorMessage, "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleStartDelete = (caseId: string) => {
    setDeletingId(caseId);
  };

  const handleDelete = async () => {
    if (!deletingId) return;

    const targetId = deletingId;

    setBusyId(targetId);
    addToast("Deleting case...", "info");

    try {
      await apiFetch(`/v1/cases/${targetId}`, { method: "DELETE" });
      setCases((prev) => prev.filter((c) => c.id !== targetId));
      setDeletingId(null);
      addToast("Case deleted successfully", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to delete case";
      captureException(err, { feature: "cases_delete", caseId: targetId });
      addToast(errorMessage, "error");
    } finally {
      setBusyId(null);
    }
  };

  const disableRowActions =
    creating || busyId !== null || renamingId !== null || deletingId !== null;

  const filteredCases = cases.filter((c) => {
    if (filter === "personal") return !c.teamId;
    if (filter === "team") return c.teamId;
    return true;
  });

  const personalCases = cases.filter((c) => !c.teamId);
  const teamCases = cases.filter((c) => c.teamId);

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

              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <Button
                  variant={filter === "all" ? "primary" : "secondary"}
                  onClick={() => setFilter("all")}
                  className={filter === "all" ? "navy-btn" : "case-badge-btn"}
                  style={{
                    padding: "7px 14px",
                    fontSize: 12,
                    borderRadius: 999,
                  }}
                >
                  All ({cases.length})
                </Button>
                <Button
                  variant={filter === "personal" ? "primary" : "secondary"}
                  onClick={() => setFilter("personal")}
                  className={filter === "personal" ? "navy-btn" : "case-badge-btn"}
                  style={{
                    padding: "7px 14px",
                    fontSize: 12,
                    borderRadius: 999,
                  }}
                >
                  Personal ({personalCases.length})
                </Button>
                <Button
                  variant={filter === "team" ? "primary" : "secondary"}
                  onClick={() => setFilter("team")}
                  className={filter === "team" ? "navy-btn" : "case-badge-btn"}
                  style={{
                    padding: "7px 14px",
                    fontSize: 12,
                    borderRadius: 999,
                  }}
                >
                  Team ({teamCases.length})
                </Button>
              </div>
            </div>

            <Button
              className="navy-btn"
              onClick={handleCreate}
              disabled={creating || busyId !== null}
            >
              {creating ? "Creating..." : "Create Case"}
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container case-list-grid" style={{ display: "grid", gap: 16 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <Skeleton width="100%" height="84px" />
              <Skeleton width="100%" height="84px" />
              <Skeleton width="100%" height="84px" />
            </div>
          ) : error ? (
            <Card className="case-error-card app-card">
              <div className="case-error-text">{error}</div>
            </Card>
          ) : filteredCases.length === 0 ? (
            <Card className="case-section-card app-card">
              <EmptyState
                title={filter === "all" ? "No cases yet" : `No ${filter} cases`}
                subtitle={filter === "all" ? "Create one to organize your evidence by investigation." : `Try a different filter or create a new ${filter} case.`}
                action={handleCreate}
                actionLabel={creating ? "Creating..." : "Create Case"}
              />
            </Card>
          ) : (
            filteredCases.map((caseItem) => (
              <Card key={caseItem.id} className="case-list-card app-card">
                <div className="case-list-row">
                  <Link
                    href={`/cases/${caseItem.id}`}
                    className="case-list-link"
                    style={{ textDecoration: "none", color: "inherit", flex: 1 }}
                  >
                    <div className="case-list-name" style={{ color: "rgba(246,252,255,0.96)", fontWeight: 800 }}>
                      {caseItem.name}
                      {caseItem.teamId && (
                        <span
                          className="badge ready"
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            background: "rgba(158,216,207,0.12)",
                            borderColor: "rgba(158,216,207,0.22)",
                            color: "#bfe8df",
                          }}
                        >
                          TEAM
                        </span>
                      )}
                    </div>
                  </Link>

                  <div className="case-list-actions">
                    <Button
                      variant="secondary"
                      onClick={() => handleStartRename(caseItem)}
                      disabled={disableRowActions}
                    >
                      Rename
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => handleStartDelete(caseItem.id)}
                      disabled={disableRowActions}
                      className="case-danger-btn"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>

      {renamingId && (
        <div
          className="case-modal-backdrop"
          onClick={() => {
            if (busyId) return;
            setRenamingId(null);
            setRenameValue("");
          }}
        >
          <Card className="card-modal case-modal-card app-card">
            <div
              style={{ padding: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="case-modal-title" style={{ color: "rgba(246,252,255,0.96)" }}>Rename Case</h3>

              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Case name"
                maxLength={120}
                className="case-text-input"
                autoFocus
              />

              <div className="case-inline-actions" style={{ marginTop: 16 }}>
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenamingId(null);
                      setRenameValue("");
                    }}
                    disabled={busyId !== null}
                  >
                    Cancel
                  </Button>
                </div>

                <div style={{ flex: 1 }}>
                  <Button
                    className="navy-btn"
                    onClick={handleRename}
                    disabled={!renameValue.trim() || busyId !== null}
                  >
                    Rename
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {deletingId && (
        <div
          className="case-modal-backdrop"
          onClick={() => {
            if (busyId) return;
            setDeletingId(null);
          }}
        >
          <Card className="card-modal case-modal-card app-card">
            <div
              style={{ padding: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="case-delete-title">Delete Case?</h3>

              <p className="case-delete-subtitle">
                The case will be deleted, but all evidence will remain in your dashboard.
              </p>

              <div className="case-inline-actions">
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeletingId(null)}
                    disabled={busyId !== null}
                  >
                    Cancel
                  </Button>
                </div>

                <div style={{ flex: 1 }}>
                  <Button
                    onClick={handleDelete}
                    className="button-danger"
                    disabled={busyId !== null}
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