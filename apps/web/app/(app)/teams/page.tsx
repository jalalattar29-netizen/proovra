"use client";

import { useEffect, useMemo, useState } from "react";
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

function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  return date.toLocaleString();
}

function roleTone(role?: string) {
  const normalized = (role ?? "").toUpperCase();

  if (normalized === "OWNER") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    } as const;
  }

  if (normalized === "ADMIN") {
    return {
      border: "1px solid rgba(79,112,107,0.18)",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.20) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#2d5b59",
    } as const;
  }

  return {
    border: "1px solid rgba(79,112,107,0.12)",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    color: "#4d6165",
  } as const;
}

export default function TeamsPage() {
  const { addToast } = useToast();
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const handleStartRename = (team: TeamListItem) => {
    setRenamingId(team.id);
    setRenameValue(team.name);
  };

  const handleRename = async () => {
    if (!renamingId || !renameValue.trim()) return;

    const targetId = renamingId;
    const nextName = renameValue.trim();

    setBusyId(targetId);

    try {
      const updated = await apiFetch(`/v1/teams/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName }),
      });

      setTeams((prev) =>
        prev.map((team) =>
          team.id === targetId
            ? { ...team, name: updated?.name ?? nextName }
            : team
        )
      );

      setRenamingId(null);
      setRenameValue("");
      addToast("Team renamed successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename team";
      captureException(err, { feature: "teams_page_rename", teamId: targetId });
      addToast(message, "error");
    } finally {
      setBusyId(null);
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
    setBusyId(teamId);

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
      setBusyId(null);
    }
  };

  const silverCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.12)",
        color: "#24373b",
        background:
          "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
        boxShadow:
          "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.70)",
        textShadow: "0 1px 0 rgba(255,255,255,0.30)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const tertiaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.16)",
        color: "#7a624d",
        background:
          "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.64) 100%)",
        boxShadow:
          "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
        textShadow: "0 1px 0 rgba(255,255,255,0.32)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const dangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(194,78,78,0.20)",
        color: "#fff3f3",
        background:
          "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,18,18,0.14)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        borderRadius: 24,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const noteCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.14)",
        background:
          "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(255,255,255,0.36))",
        color: "#7f6450",
        borderRadius: 18,
        lineHeight: 1.75,
      }) as const,
    []
  );

  const totalMembers = teams.reduce((sum, item) => sum + (item.memberCount ?? 0), 0);
  const totalCases = teams.reduce((sum, item) => sum + (item.caseCount ?? 0), 0);

  const disableRowActions =
    creating || busyId !== null || renamingId !== null || deleting !== null;

  return (
    <div className="section app-section teams-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
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
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Teams
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Organize shared <span style={{ color: "#c3ebe2" }}>team workspaces</span>{" "}
                with clarity.
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
                Manage <span style={{ color: "#cfd8d5" }}>members</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>invites</span>, shared{" "}
                <span style={{ color: "#d2dcd8" }}>cases</span>, and role-based{" "}
                <span style={{ color: "#d9ccbf" }}>access</span> from one polished workspace.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {teams.length} workspace{teams.length === 1 ? "" : "s"}
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  {totalMembers} total member{totalMembers === 1 ? "" : "s"}
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#c2a07f]">✓</span>
                  {totalCases} linked case{totalCases === 1 ? "" : "s"}
                </div>
              </div>
            </div>

<Button
  onClick={handleCreate}
  disabled={creating}
  className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px]"
  style={primaryButtonStyle}
>
                {creating ? "Creating..." : "Create Team"}
            </Button>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div
          className="container relative z-10"
          style={{
            display: "grid",
            gap: 20,
            paddingBottom: 72,
          }}
        >
          {loading ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="rounded-[28px] p-5" style={{ ...rowCardStyle, minHeight: 108 }}>
                <Skeleton width="100%" height="26px" />
              </div>
              <div className="rounded-[28px] p-5" style={{ ...rowCardStyle, minHeight: 108 }}>
                <Skeleton width="100%" height="26px" />
              </div>
              <div className="rounded-[28px] p-5" style={{ ...rowCardStyle, minHeight: 108 }}>
                <Skeleton width="100%" height="26px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...silverCardStyle, border: "1px solid rgba(194,78,78,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,243,243,0.90)_0%,rgba(248,239,235,0.86)_100%)]" />
              <div className="relative z-10 px-5 py-4 text-[0.95rem] text-[#b42318]">
                {error}
              </div>
            </Card>
          ) : teams.length === 0 ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={silverCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

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
                  style={silverCardStyle}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/panel-silver.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                  <div className="relative z-10 p-6 md:p-7">
<div className="app-card-top-row">
<div className="app-card-top-row__content">
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
                              color: "#21353a",
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
                                ...roleTone(item.role),
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
                            color: "#6a777b",
                          }}
                        >
                          <span>{item.memberCount ?? 0} members</span>
                          <span style={{ color: "#8a6e57" }}>
                            {item.pendingInviteCount ?? 0} pending invites
                          </span>
                          <span>{item.caseCount ?? 0} cases</span>
                        </div>

                        <div
                          style={{
                            marginTop: 12,
                            padding: 12,
                            maxWidth: 520,
                            ...noteCardStyle,
                          }}
                        >
                          Created {formatLocalDateTime(item.createdAt)}
                        </div>
                      </div>

<div className="app-card-top-row__actions">
                          <Link href={`/teams/${item.id}`} style={{ textDecoration: "none" }}>
                          <Button
className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={primaryButtonStyle}
                          >
                            Open Team
                          </Button>
                        </Link>

                        {item.role === "OWNER" ? (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() => handleStartRename(item)}
                              disabled={disableRowActions}
className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                              style={tertiaryButtonStyle}
                            >
                              Rename
                            </Button>

                            <Button
                              onClick={() => handleDelete(item.id, item.name)}
                              disabled={disableRowActions}
className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                              style={dangerButtonStyle}
                            >
                              {deleting === item.id ? "Deleting..." : "Delete"}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              <Card
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={silverCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                <div className="relative z-10 p-7">
                  <div className="empty-state">
                    <div
                      className="empty-state-icon empty-state-icon-svg"
                      style={{
                        width: 70,
                        height: 70,
                        borderRadius: 20,
                        background:
                          "linear-gradient(180deg, rgba(214,184,157,0.12) 0%, rgba(255,255,255,0.56) 100%)",
                        border: "1px solid rgba(183,157,132,0.18)",
                        color: "#8a6e57",
                      }}
                    >
                      <Icons.Teams />
                    </div>

                    <div style={{ color: "#5d6d71" }}>
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
            style={{ ...silverCardStyle, width: "100%", maxWidth: 520 }}
          >
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />

            <div
              style={{ padding: 24, position: "relative", zIndex: 1 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3
                style={{
                  color: "#21353a",
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: "-0.03em",
                }}
              >
                Rename Team
              </h3>

              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Team name"
                maxLength={120}
                autoFocus
                style={{
                  width: "100%",
                  minHeight: 52,
                  padding: "0 16px",
                  borderRadius: 18,
                  fontSize: 15,
                  background:
                    "linear-gradient(180deg, rgba(250,251,249,0.94) 0%, rgba(241,244,241,0.98) 100%)",
                  border: "1px solid rgba(79,112,107,0.14)",
                  color: "#23373b",
                  marginTop: 14,
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.68), 0 10px 22px rgba(0,0,0,0.05)",
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
                    className="w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                </div>

                <div style={{ flex: 1 }}>
                  <Button
                    onClick={handleRename}
                    disabled={!renameValue.trim() || busyId !== null}
                    className="w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
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
    </div>
  );
}