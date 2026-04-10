"use client";

import { useEffect, useMemo, useState } from "react";
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.18)",
        color: "#aebbb6",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,20,24,0.78) 0%, rgba(7,18,22,0.88) 100%), url('/images/site-velvet-bg.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 28px rgba(0,0,0,0.10)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const dangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(220,120,120,0.22)",
        color: "#f3d9d9",
        background:
          "linear-gradient(180deg, rgba(130,43,43,0.82) 0%, rgba(92,24,24,0.92) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 12px 24px rgba(60,12,12,0.22)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.10)",
        background:
          "linear-gradient(180deg, rgba(8,23,30,0.86) 0%, rgba(7,18,24,0.94) 100%)",
        borderRadius: 24,
        boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
      }) as const,
    []
  );

  return (
    <div className="section app-section cases-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.8,
                    display: "inline-block",
                  }}
                />
                Cases
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Organize evidence into{" "}
                <span style={{ color: "#c3ebe2" }}>clean case workspaces</span>.
              </h1>

              <p
                style={{
                  marginTop: 20,
                  maxWidth: 720,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Separate your <span style={{ color: "#cfd8d5" }}>personal</span> and{" "}
                <span style={{ color: "#bbc7c3" }}>team</span> investigations, keep
                linked evidence organized, and move between case workflows more clearly.
              </p>

              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                <Button
                  variant={filter === "all" ? "primary" : "secondary"}
                  onClick={() => setFilter("all")}
                  className="proovra-velvet-primary rounded-[999px] border px-4 py-2 text-[0.82rem] font-semibold"
                  style={filter === "all" ? primaryButtonStyle : secondaryButtonStyle}
                >
                  All ({cases.length})
                </Button>
                <Button
                  variant={filter === "personal" ? "primary" : "secondary"}
                  onClick={() => setFilter("personal")}
                  className="proovra-velvet-primary rounded-[999px] border px-4 py-2 text-[0.82rem] font-semibold"
                  style={filter === "personal" ? primaryButtonStyle : secondaryButtonStyle}
                >
                  Personal ({personalCases.length})
                </Button>
                <Button
                  variant={filter === "team" ? "primary" : "secondary"}
                  onClick={() => setFilter("team")}
                  className="proovra-velvet-primary rounded-[999px] border px-4 py-2 text-[0.82rem] font-semibold"
                  style={filter === "team" ? primaryButtonStyle : secondaryButtonStyle}
                >
                  Team ({teamCases.length})
                </Button>
              </div>
            </div>

            <Button
              onClick={handleCreate}
              disabled={creating || busyId !== null}
              className="proovra-velvet-primary rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
              style={primaryButtonStyle}
            >
              {creating ? "Creating..." : "Create Case"}
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ ...rowCardStyle, padding: 22 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 22 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 22 }}>
                <Skeleton width="100%" height="40px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />
              <div className="relative z-10 p-6 text-[#ffd7d7]">{error}</div>
            </Card>
          ) : filteredCases.length === 0 ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <EmptyState
                  title={filter === "all" ? "No cases yet" : `No ${filter} cases`}
                  subtitle={
                    filter === "all"
                      ? "Create one to organize your evidence by investigation."
                      : `Try a different filter or create a new ${filter} case.`
                  }
                  action={handleCreate}
                  actionLabel={creating ? "Creating..." : "Create Case"}
                />
              </div>
            </Card>
          ) : (
            filteredCases.map((caseItem) => (
              <Card
                key={caseItem.id}
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={outerCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/site-velvet-bg.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center scale-[1.12]"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

                <div className="relative z-10 p-6 md:p-7">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 16,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <Link
                      href={`/cases/${caseItem.id}`}
                      style={{ textDecoration: "none", color: "inherit", flex: 1 }}
                    >
                      <div
                        style={{
                          color: "#d8e0dd",
                          fontWeight: 800,
                          fontSize: 18,
                          letterSpacing: "-0.02em",
                          display: "flex",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 8,
                        }}
                      >
                        {caseItem.name}
                        {caseItem.teamId && (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              minHeight: 28,
                              padding: "5px 10px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 800,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                              border: "1px solid rgba(158,216,207,0.20)",
                              background:
                                "linear-gradient(180deg, rgba(158,216,207,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                              color: "#bfe8df",
                            }}
                          >
                            Team
                          </span>
                        )}
                      </div>
                    </Link>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        variant="secondary"
                        onClick={() => handleStartRename(caseItem)}
                        disabled={disableRowActions}
                        className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={secondaryButtonStyle}
                      >
                        Rename
                      </Button>

                      <Button
                        variant="secondary"
                        onClick={() => handleStartDelete(caseItem.id)}
                        disabled={disableRowActions}
                        className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dangerButtonStyle}
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

      {renamingId && (
        <div
          onClick={() => {
            if (busyId) return;
            setRenamingId(null);
            setRenameValue("");
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(2,6,23,0.62)",
            backdropFilter: "blur(10px)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={{ ...outerCardStyle, width: "100%", maxWidth: 520 }}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.84)_0%,rgba(7,18,22,0.90)_100%)]" />

            <div
              style={{ padding: 24, position: "relative", zIndex: 1 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ color: "#d8e0dd", fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em" }}>
                Rename Case
              </h3>

              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Case name"
                maxLength={120}
                autoFocus
                style={{
                  width: "100%",
                  minHeight: 52,
                  padding: "0 16px",
                  borderRadius: 18,
                  fontSize: 15,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(183,157,132,0.16)",
                  color: "#d8e0dd",
                  marginTop: 14,
                }}
              />

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenamingId(null);
                      setRenameValue("");
                    }}
                    disabled={busyId !== null}
                    className="proovra-velvet-primary w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                </div>

                <div style={{ flex: 1 }}>
                  <Button
                    onClick={handleRename}
                    disabled={!renameValue.trim() || busyId !== null}
                    className="proovra-velvet-primary w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={primaryButtonStyle}
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
          onClick={() => {
            if (busyId) return;
            setDeletingId(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(2,6,23,0.62)",
            backdropFilter: "blur(10px)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={{ ...outerCardStyle, width: "100%", maxWidth: 520, border: "1px solid rgba(220,120,120,0.24)" }}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />

            <div
              style={{ padding: 24, position: "relative", zIndex: 1 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ color: "#ffe5e5", fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em" }}>
                Delete Case?
              </h3>

              <p style={{ marginTop: 10, color: "rgba(255,224,224,0.78)", lineHeight: 1.75 }}>
                The case will be deleted, but all evidence will remain in your dashboard.
              </p>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <div style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeletingId(null)}
                    disabled={busyId !== null}
                    className="proovra-velvet-primary w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                </div>

                <div style={{ flex: 1 }}>
                  <Button
                    onClick={handleDelete}
                    disabled={busyId !== null}
                    className="proovra-velvet-primary w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dangerButtonStyle}
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