"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  Button,
  EmptyState,
  Skeleton,
  useToast,
} from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type TeamListItem = {
  id: string;
  name: string;
  role?: string;
  memberCount?: number;
  pendingInviteCount?: number;
  caseCount?: number;
  createdAt?: string;
};

export default function TeamsPage() {
  const { addToast } = useToast();
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadTeams = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/teams");
      setTeams(data.teams ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load teams";
      setError(message);
      setTeams([]);
      captureException(err, { feature: "teams_page_list" });
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTeams();
  }, []);

  const handleCreate = async () => {
    const name = window.prompt("Team name");
    if (!name?.trim()) return;

    setCreating(true);

    try {
      const created = await apiFetch("/v1/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });

      setTeams((prev) => [
        {
          id: created.id,
          name: created.name,
          role: "OWNER",
          memberCount: 1,
          pendingInviteCount: 0,
          caseCount: 0,
          createdAt: created.createdAt,
        },
        ...prev,
      ]);

      addToast("Team created successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create team";
      captureException(err, { feature: "teams_page_create" });
      addToast(message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (teamId: string, teamName: string) => {
    if (
      !window.confirm(
        `Are you sure you want to delete "${teamName}"? Team cases will be converted to personal cases.`
      )
    ) {
      return;
    }

    setDeleting(teamId);

    try {
      await apiFetch(`/v1/teams/${teamId}`, { method: "DELETE" });
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      addToast("Team deleted successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete team";
      captureException(err, { feature: "teams_page_delete" });
      addToast(message, "error");
    } finally {
      setDeleting(null);
    }
  };

  const velvetCardStyle = {
    border: "1px solid rgba(183,157,132,0.20)",
    boxShadow:
      "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const;

  const primaryButtonStyle = {
    borderColor: "rgba(183,157,132,0.24)",
    color: "#eef4f2",
    background:
      "linear-gradient(180deg, rgba(72,114,111,0.96) 0%, rgba(28,55,57,0.98) 100%)",
    boxShadow: "0 14px 28px rgba(9,27,28,0.22)",
  } as const;

  const secondaryButtonStyle = {
    borderColor: "rgba(183,157,132,0.18)",
    color: "#e6ece9",
    background:
      "linear-gradient(180deg, rgba(43,73,75,0.84) 0%, rgba(18,37,39,0.94) 100%)",
    boxShadow: "0 10px 22px rgba(0,0,0,0.14)",
  } as const;

  const dangerButtonStyle = {
    borderColor: "rgba(220,120,120,0.22)",
    color: "#ffe3e3",
    background:
      "linear-gradient(180deg, rgba(130,43,43,0.92) 0%, rgba(92,24,24,0.96) 100%)",
    boxShadow: "0 12px 24px rgba(60, 12, 12, 0.22)",
  } as const;

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
              <div
                style={{
                  display: "inline-flex",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.055)",
                  padding: "8px 16px",
                  fontSize: "0.74rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.2em",
                  color: "#dce3e0",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.10)",
                  backdropFilter: "blur(10px)",
                }}
              >
                Teams
              </div>

              <h1
                style={{
                  margin: "16px 0 0",
                  maxWidth: 760,
                  fontSize: "clamp(2rem, 4vw, 3.15rem)",
                  lineHeight: 1.02,
                  letterSpacing: "-0.05em",
                  fontWeight: 600,
                  color: "#edf1ef",
                }}
              >
                Organize shared{" "}
                <span style={{ color: "#bfe8df" }}>team workspaces</span>{" "}
                with clarity.
              </h1>

              <p
                style={{
                  marginTop: 16,
                  maxWidth: 720,
                  fontSize: "0.98rem",
                  lineHeight: 1.82,
                  color: "#c7cfcc",
                }}
              >
                Manage <span style={{ color: "#e7ece9" }}>members</span>,{" "}
                <span style={{ color: "#bfe8df" }}>invites</span>, shared{" "}
                <span style={{ color: "#e6ebe8" }}>cases</span>, and role-based{" "}
                <span style={{ color: "#d6b89d" }}>access</span> from one premium
                workspace.
              </p>
            </div>

            <Button
              onClick={handleCreate}
              disabled={creating}
              className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px]"
              style={primaryButtonStyle}
            >
              {creating ? "Creating..." : "Create Team"}
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div
          className="container"
          style={{
            display: "grid",
            gap: 20,
            paddingBottom: 72,
          }}
        >
          {loading ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div
                className="rounded-[28px] border border-white/6 bg-white/[0.03] p-5"
                style={{ minHeight: 108 }}
              >
                <Skeleton width="100%" height="26px" />
              </div>
              <div
                className="rounded-[28px] border border-white/6 bg-white/[0.03] p-5"
                style={{ minHeight: 108 }}
              >
                <Skeleton width="100%" height="26px" />
              </div>
              <div
                className="rounded-[28px] border border-white/6 bg-white/[0.03] p-5"
                style={{ minHeight: 108 }}
              >
                <Skeleton width="100%" height="26px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={velvetCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(90,20,20,0.22)_0%,rgba(20,10,10,0.52)_100%)]" />
              <div className="relative z-10 px-5 py-4 text-[0.95rem] text-[#ffd7d7]">
                {error}
              </div>
            </Card>
          ) : teams.length === 0 ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={velvetCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.80)_0%,rgba(7,18,22,0.90)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

              <div className="relative z-10 p-6 md:p-8">
                <EmptyState
                  title="No teams yet"
                  subtitle="Create a team to collaborate on shared cases, member roles, and controlled access."
                  action={() => (
                    <Button
                      onClick={handleCreate}
                      disabled={creating}
                      className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      {creating ? "Creating..." : "Create Team"}
                    </Button>
                  )}
                />
              </div>
            </Card>
          ) : (
            <>
              {teams.map((item) => (
                <Card
                  key={item.id}
                  className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                  style={velvetCardStyle}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.80)_0%,rgba(7,18,22,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

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
                      <div style={{ flex: 1, minWidth: 260 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 22,
                              fontWeight: 700,
                              color: "#edf4f1",
                              letterSpacing: "-0.03em",
                            }}
                          >
                            {item.name}
                          </div>

                          {item.role ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minHeight: 30,
                                padding: "6px 12px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 800,
                                letterSpacing: "0.12em",
                                textTransform: "uppercase",
                                border: "1px solid rgba(214,184,157,0.20)",
                                background:
                                  "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                                color: "#dcc0a5",
                              }}
                            >
                              {item.role}
                            </span>
                          ) : null}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            flexWrap: "wrap",
                            marginTop: 10,
                            fontSize: 13,
                            color: "rgba(219,235,248,0.72)",
                          }}
                        >
                          <span>{item.memberCount ?? 0} members</span>
                          <span style={{ color: "#d6b89d" }}>
                            {item.pendingInviteCount ?? 0} pending invites
                          </span>
                          <span>{item.caseCount ?? 0} cases</span>
                        </div>

                        {item.createdAt ? (
                          <div
                            style={{
                              marginTop: 10,
                              fontSize: 12,
                              color: "rgba(196,206,203,0.60)",
                            }}
                          >
                            Created {new Date(item.createdAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Link href={`/teams/${item.id}`} style={{ textDecoration: "none" }}>
                          <Button
                            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={secondaryButtonStyle}
                          >
                            Open Team
                          </Button>
                        </Link>

                        {item.role === "OWNER" ? (
                          <Button
                            onClick={() => handleDelete(item.id, item.name)}
                            disabled={deleting === item.id}
                            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={dangerButtonStyle}
                          >
                            {deleting === item.id ? "Deleting..." : "Delete"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              <Card
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={velvetCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/site-velvet-bg.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center scale-[1.12]"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.80)_0%,rgba(7,18,22,0.90)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

                <div className="relative z-10 p-7">
                  <div className="empty-state">
                    <div
                      className="empty-state-icon empty-state-icon-svg"
                      style={{
                        width: 70,
                        height: 70,
                        borderRadius: 20,
                        background:
                          "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                        border: "1px solid rgba(183,157,132,0.18)",
                        color: "#d6b89d",
                      }}
                    >
                      <Icons.Teams />
                    </div>

                    <div style={{ color: "rgba(219,235,248,0.82)" }}>
                      Create another team when you need a separate collaborative workspace.
                    </div>

                    <div style={{ marginTop: 16 }}>
                      <Button
                        onClick={handleCreate}
                        disabled={creating}
                        className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                        style={primaryButtonStyle}
                      >
                        {creating ? "Creating..." : "Create Team"}
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}