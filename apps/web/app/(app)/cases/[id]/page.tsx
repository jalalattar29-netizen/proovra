"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Button,
  Card,
  ListRow,
  Badge,
  useToast,
} from "../../../../components/ui";
import { Icons } from "../../../../components/icons";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

interface CaseAccessUser {
  id: string;
  email?: string;
  displayName?: string;
}

interface CaseAccessItem {
  id: string;
  userId: string;
  createdAt: string;
  user?: CaseAccessUser;
}

interface CaseData {
  id: string;
  name: string;
  ownerUserId?: string;
  teamId?: string | null;
  access: CaseAccessItem[];
}

interface EvidenceItem {
  id: string;
  title?: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount?: number;
  displaySubtitle?: string;
}

interface TeamMember {
  userId: string;
  email?: string;
  displayName?: string;
  label: string;
}

interface MeResponse {
  user?: {
    id: string;
  };
}

function resolveEvidenceTitle(item: EvidenceItem): string {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (title) return title;

  switch ((item.type ?? "").toUpperCase()) {
    case "PHOTO":
      return "Photo Evidence";
    case "VIDEO":
      return "Video Evidence";
    case "AUDIO":
      return "Audio Evidence";
    case "DOCUMENT":
      return "Document Evidence";
    default:
      return "Digital Evidence Record";
  }
}

function resolveEvidenceSubtitle(item: EvidenceItem): string {
  const subtitle =
    typeof item.displaySubtitle === "string" ? item.displaySubtitle.trim() : "";
  if (subtitle) return subtitle;

  const count =
    typeof item.itemCount === "number" && item.itemCount > 0
      ? item.itemCount
      : 1;

  return `${count} item${count === 1 ? "" : "s"} • ${new Date(
    item.createdAt
  ).toLocaleString()}`;
}

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [renamingCase, setRenamingCase] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [shareMethod, setShareMethod] = useState<"team" | "email">("team");
  const [selectedTeamMemberId, setSelectedTeamMemberId] = useState("");
  const [shareEmail, setShareEmail] = useState("");
  const [operationLoading, setOperationLoading] = useState(false);

  const caseId = params?.id;

  const isOwner = useMemo(() => {
    if (!caseData?.ownerUserId || !currentUserId) return false;
    return caseData.ownerUserId === currentUserId;
  }, [caseData?.ownerUserId, currentUserId]);

  const loadData = async () => {
    if (!caseId) return;

    setLoading(true);
    setError(null);

    try {
      const [meRes, caseRes, evidenceRes] = await Promise.all([
        apiFetch("/v1/users/me") as Promise<MeResponse>,
        apiFetch(`/v1/cases/${caseId}`) as Promise<{ case?: CaseData }>,
        apiFetch(`/v1/evidence?caseId=${caseId}`) as Promise<{
          items?: EvidenceItem[];
        }>,
      ]);

      setCurrentUserId(meRes?.user?.id ?? "");
      setCaseData(caseRes.case ?? null);
      setEvidence(evidenceRes.items ?? []);
      setRenameValue(caseRes.case?.name ?? "");

      if (caseRes.case?.teamId) {
        try {
          const membersRes = (await apiFetch(
            `/v1/cases/${caseId}/team-members`
          )) as { items?: TeamMember[] };

          setTeamMembers(membersRes.items ?? []);
        } catch (teamErr) {
          console.error("Failed to load team members:", teamErr);
          setTeamMembers([]);
        }
      } else {
        setTeamMembers([]);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load case";
      setError(errorMessage);
      captureException(err, { feature: "case_detail_load", caseId });
      addToast(errorMessage, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [caseId]);

  const handleRenameStart = () => {
    if (!caseData || !isOwner) return;
    setRenameValue(caseData.name);
    setRenamingCase(true);
  };

  const handleRenameSubmit = async () => {
    if (!caseId || !renameValue.trim() || !isOwner) return;

    setOperationLoading(true);
    addToast("Renaming case...", "info");

    try {
      const updated = (await apiFetch(`/v1/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: renameValue.trim() }),
      })) as { name: string };

      setCaseData((prev) => (prev ? { ...prev, name: updated.name } : prev));
      setRenamingCase(false);
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to rename case";
      captureException(err, { feature: "case_rename", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDeleteCase = async () => {
    if (!caseId || !isOwner) return;

    setDeleteConfirm(false);
    setOperationLoading(true);
    addToast("Deleting case...", "info");

    try {
      await apiFetch(`/v1/cases/${caseId}`, { method: "DELETE" });
      addToast("Case deleted successfully", "success");
      setTimeout(() => router.push("/cases"), 400);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to delete case";
      captureException(err, { feature: "case_delete", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleRemoveEvidence = async (evidenceId: string) => {
    if (!caseId || !isOwner) return;

    setOperationLoading(true);
    addToast("Removing evidence from case...", "info");

    try {
      await apiFetch(`/v1/cases/${caseId}/evidence/${evidenceId}`, {
        method: "DELETE",
      });

      setEvidence((prev) => prev.filter((item) => item.id !== evidenceId));
      addToast("Evidence removed from case", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to remove evidence";
      captureException(err, { feature: "case_remove_evidence", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleShareTeam = async () => {
    if (!caseId || !selectedTeamMemberId || !isOwner) return;

    setOperationLoading(true);
    addToast("Sharing case...", "info");

    try {
      await apiFetch(`/v1/cases/${caseId}/share-team`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedTeamMemberId }),
      });

      setSelectedTeamMemberId("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_team", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleShareEmail = async () => {
    if (!caseId || !shareEmail.trim() || !isOwner) return;

    setOperationLoading(true);
    addToast("Sharing case by email...", "info");

    try {
      await apiFetch(`/v1/cases/${caseId}/share-email`, {
        method: "POST",
        body: JSON.stringify({ email: shareEmail.trim() }),
      });

      setShareEmail("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_email", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleRevokeAccess = async (accessId: string) => {
    if (!caseId || !isOwner) return;

    setOperationLoading(true);
    addToast("Removing access...", "info");

    try {
      await apiFetch(`/v1/cases/${caseId}/access/${accessId}`, {
        method: "DELETE",
      });

      await loadData();
      addToast("Access removed", "success");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to remove access";
      captureException(err, { feature: "case_revoke_access", caseId });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleExport = () => {
    if (!caseId) return;
    window.open(`/v1/cases/${caseId}/export`, "_blank");
  };

  const outerCardStyle = {
    border: "1px solid rgba(183,157,132,0.18)",
    boxShadow:
      "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const;

  const primaryButtonStyle = {
    borderColor: "rgba(158,216,207,0.14)",
    color: "#aebbb6",
    background:
      "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
  } as const;

  const secondaryButtonStyle = {
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
  } as const;

  const dangerButtonStyle = {
    borderColor: "rgba(220,120,120,0.22)",
    color: "#f3d9d9",
    background:
      "linear-gradient(180deg, rgba(130,43,43,0.82) 0%, rgba(92,24,24,0.92) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.03), 0 12px 24px rgba(60,12,12,0.22)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
  } as const;

  const rowCardStyle = {
    border: "1px solid rgba(158,216,207,0.10)",
    background:
      "linear-gradient(180deg, rgba(8,23,30,0.86) 0%, rgba(7,18,24,0.94) 100%)",
    borderRadius: 24,
    boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
  } as const;

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
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
              Case
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Loading <span style={{ color: "#c3ebe2" }}>case workspace</span>.
            </h1>
          </div>
        </div>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
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
              Case
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Case details <span style={{ color: "#c3ebe2" }}>could not load</span>.
            </h1>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
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
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />
              <div className="relative z-10 p-6 text-[#ffd7d7]">
                {error || "Case not found"}
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section case-detail-page-shell home-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
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
                Case
              </div>

              <h1
                className="mt-5 max-w-[820px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                {renamingCase ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    maxLength={120}
                    autoFocus
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(214,184,157,0.16)",
                      borderRadius: 14,
                      color: "#d8e0dd",
                      padding: "10px 14px",
                      width: "100%",
                      maxWidth: 540,
                    }}
                  />
                ) : (
                  <>
                    {caseData.name}{" "}
                    <span style={{ color: "#c3ebe2" }}>
                      {isOwner ? "management workspace" : "shared workspace"}
                    </span>
                    .
                  </>
                )}
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
                {isOwner
                  ? "Manage sharing, review evidence, export the case, and control access from one premium workspace."
                  : "You can review this shared case and the evidence already linked to it."}
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {renamingCase ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenamingCase(false);
                      setRenameValue(caseData.name);
                    }}
                    disabled={operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleRenameSubmit}
                    disabled={!renameValue.trim() || operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={primaryButtonStyle}
                  >
                    Save
                  </Button>
                </>
              ) : (
                <>
                  {isOwner && (
                    <>
                      <Button
                        variant="secondary"
                        onClick={handleRenameStart}
                        disabled={operationLoading}
                        className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={secondaryButtonStyle}
                      >
                        Rename
                      </Button>

                      <Button
                        variant="secondary"
                        onClick={() => setDeleteConfirm(true)}
                        disabled={operationLoading}
                        className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dangerButtonStyle}
                      >
                        Delete
                      </Button>
                    </>
                  )}

                  <Button
                    onClick={handleExport}
                    disabled={operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={primaryButtonStyle}
                  >
                    Export ZIP
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 18, paddingBottom: 72 }}>
          {deleteConfirm && isOwner && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.24)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />

              <div className="relative z-10 p-6">
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: "#ffe5e5",
                    letterSpacing: "-0.03em",
                  }}
                >
                  Delete case?
                </div>

                <p
                  style={{
                    marginTop: 10,
                    color: "rgba(255,224,224,0.78)",
                    lineHeight: 1.75,
                  }}
                >
                  The case will be deleted, but all evidence will remain in your dashboard.
                </p>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleDeleteCase}
                    disabled={operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dangerButtonStyle}
                  >
                    Delete Case
                  </Button>
                </div>
              </div>
            </Card>
          )}

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
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#d8e0dd",
                  letterSpacing: "-0.02em",
                  fontSize: 20,
                }}
              >
                Sharing
              </div>

              {caseData.access.length === 0 ? (
                <div style={{ color: "rgba(194,204,201,0.76)" }}>Not shared with anyone yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 10, marginBottom: isOwner ? 16 : 0 }}>
                  {caseData.access.map((access) => {
                    const displayLabel =
                      access.user?.displayName || access.user?.email || "User";

                    return (
                      <div
                        key={access.id}
                        style={{
                          ...rowCardStyle,
                          padding: 14,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div style={{ color: "#d8e0dd", fontWeight: 700 }}>{displayLabel}</div>
                          {access.user?.email && access.user.displayName && (
                            <div style={{ color: "rgba(194,204,201,0.72)", fontSize: 13, marginTop: 4 }}>
                              {access.user.email}
                            </div>
                          )}
                        </div>

                        {isOwner && (
                          <Button
                            variant="secondary"
                            onClick={() => handleRevokeAccess(access.id)}
                            disabled={operationLoading}
                            className="proovra-velvet-primary rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                            style={dangerButtonStyle}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {isOwner && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setShowSharePanel(!showSharePanel)}
                    disabled={operationLoading}
                    className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    {showSharePanel ? "Close" : "Share Case"}
                  </Button>

                  {showSharePanel && (
                    <div
                      style={{
                        marginTop: 14,
                        padding: 16,
                        borderRadius: 20,
                        background:
                          "linear-gradient(180deg, rgba(62,98,96,0.18) 0%, rgba(14,30,34,0.28) 100%)",
                        border: "1px solid rgba(158,216,207,0.14)",
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
                        <label style={{ color: "#c7d1ce", display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="radio"
                            value="team"
                            checked={shareMethod === "team"}
                            onChange={(e) =>
                              setShareMethod(e.target.value as "team")
                            }
                            disabled={!caseData.teamId || operationLoading}
                          />
                          <span>Share with Team Member</span>
                        </label>

                        <label style={{ color: "#c7d1ce", display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="radio"
                            value="email"
                            checked={shareMethod === "email"}
                            onChange={(e) =>
                              setShareMethod(e.target.value as "email")
                            }
                            disabled={operationLoading}
                          />
                          <span>Share by Email</span>
                        </label>
                      </div>

                      <div style={{ display: "grid", gap: 12 }}>
                        {shareMethod === "team" ? (
                          caseData.teamId ? (
                            <>
                              <select
                                value={selectedTeamMemberId}
                                onChange={(e) =>
                                  setSelectedTeamMemberId(e.target.value)
                                }
                                disabled={operationLoading}
                                style={{
                                  width: "100%",
                                  minHeight: 52,
                                  padding: "0 16px",
                                  borderRadius: 18,
                                  fontSize: 15,
                                  background: "rgba(255,255,255,0.05)",
                                  border: "1px solid rgba(183,157,132,0.16)",
                                  color: "#d8e0dd",
                                }}
                              >
                                <option value="">Select a team member...</option>
                                {teamMembers.map((member) => (
                                  <option
                                    key={member.userId}
                                    value={member.userId}
                                    style={{ color: "#102126" }}
                                  >
                                    {member.label}
                                  </option>
                                ))}
                              </select>

                              <Button
                                onClick={handleShareTeam}
                                disabled={!selectedTeamMemberId || operationLoading}
                                className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                                style={primaryButtonStyle}
                              >
                                Share with Member
                              </Button>
                            </>
                          ) : (
                            <div style={{ color: "rgba(194,204,201,0.76)" }}>
                              This case is not associated with a team.
                            </div>
                          )
                        ) : (
                          <>
                            <input
                              type="email"
                              placeholder="Email address"
                              value={shareEmail}
                              onChange={(e) => setShareEmail(e.target.value)}
                              disabled={operationLoading}
                              style={{
                                width: "100%",
                                minHeight: 52,
                                padding: "0 16px",
                                borderRadius: 18,
                                fontSize: 15,
                                background: "rgba(255,255,255,0.05)",
                                border: "1px solid rgba(183,157,132,0.16)",
                                color: "#d8e0dd",
                              }}
                            />

                            <Button
                              onClick={handleShareEmail}
                              disabled={!shareEmail.trim() || operationLoading}
                              className="proovra-velvet-primary rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                              style={primaryButtonStyle}
                            >
                              Share by Email
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

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
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#d8e0dd",
                  letterSpacing: "-0.02em",
                  fontSize: 20,
                }}
              >
                Evidence in Case
              </div>

              {evidence.length === 0 ? (
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
                    <Icons.Evidence />
                  </div>
                  <div style={{ color: "rgba(194,204,201,0.76)" }}>
                    No evidence in this case yet.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {evidence.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        ...rowCardStyle,
                        padding: 6,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <Link
                        href={`/evidence/${item.id}`}
                        style={{ textDecoration: "none", color: "inherit", flex: 1 }}
                      >
                        <ListRow
                          title={resolveEvidenceTitle(item)}
                          subtitle={resolveEvidenceSubtitle(item)}
                          badge={
                            item.status === "SIGNED" ? (
                              <Badge tone="signed">Signed</Badge>
                            ) : item.status === "PROCESSING" ? (
                              <Badge tone="processing">Processing</Badge>
                            ) : item.status === "REPORTED" ? (
                              <span
                                className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                                style={{
                                  color: "#c3ebe2",
                                  background:
                                    "linear-gradient(180deg, rgba(195,235,226,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                                  border: "1px solid rgba(195,235,226,0.22)",
                                  boxShadow:
                                    "inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 10px rgba(60,110,102,0.10)",
                                }}
                              >
                                Report Ready
                              </span>
                            ) : (
                              <Badge tone="ready">Ready</Badge>
                            )
                          }
                        />
                      </Link>

                      {isOwner && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="secondary"
                            onClick={() => handleRemoveEvidence(item.id)}
                            disabled={operationLoading}
                            className="proovra-velvet-primary rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                            style={dangerButtonStyle}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}