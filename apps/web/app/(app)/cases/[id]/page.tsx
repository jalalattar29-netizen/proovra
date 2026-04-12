"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, useToast } from "../../../../components/ui";
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

function getDisplayStatusMeta(
  rawStatus: string | null | undefined
): {
  label: string;
  tone: "reportReady" | "signed" | "processing" | "ready";
} {
  const status = (rawStatus ?? "").trim().toUpperCase();

  switch (status) {
    case "REPORTED":
      return {
        label: "Report Ready",
        tone: "reportReady",
      };
    case "SIGNED":
      return {
        label: "Signed",
        tone: "signed",
      };
    case "UPLOADING":
    case "CREATED":
      return {
        label: "Processing",
        tone: "processing",
      };
    case "UPLOADED":
      return {
        label: "Uploaded",
        tone: "ready",
      };
    default:
      return {
        label: status || "Unknown",
        tone: "ready",
      };
  }
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
  const [teamMemberMenuOpen, setTeamMemberMenuOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [operationLoading, setOperationLoading] = useState(false);

  const caseId = params?.id;

  const isOwner = useMemo(() => {
    if (!caseData?.ownerUserId || !currentUserId) return false;
    return caseData.ownerUserId === currentUserId;
  }, [caseData?.ownerUserId, currentUserId]);

  const selectedTeamMember = useMemo(
  () => teamMembers.find((member) => member.userId === selectedTeamMemberId) ?? null,
  [teamMembers, selectedTeamMemberId]
);

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
    void loadData();
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
    border: "1px solid rgba(79,112,107,0.16)",
    boxShadow:
      "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
  } as const;

  const primaryButtonStyle = {
    borderColor: "rgba(79,112,107,0.22)",
    color: "#eef3f1",
    background:
      "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
    textShadow: "0 1px 0 rgba(0,0,0,0.22)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  } as const;

  const secondaryButtonStyle = {
    borderColor: "rgba(79,112,107,0.12)",
    color: "#24373b",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    boxShadow:
      "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.70)",
    textShadow: "0 1px 0 rgba(255,255,255,0.30)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  } as const;

  const tertiaryButtonStyle = {
    borderColor: "rgba(183,157,132,0.16)",
    color: "#7a624d",
    background:
      "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.64) 100%)",
    boxShadow:
      "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
    textShadow: "0 1px 0 rgba(255,255,255,0.32)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  } as const;

  const dangerButtonStyle = {
    borderColor: "rgba(194,78,78,0.20)",
    color: "#fff3f3",
    background:
      "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,18,18,0.14)",
    textShadow: "0 1px 0 rgba(0,0,0,0.22)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  } as const;

  const rowCardStyle = {
    border: "1px solid rgba(79,112,107,0.10)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
    borderRadius: 24,
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  } as const;

  const caseEvidenceSurfaceStyle = {
    background:
      "linear-gradient(135deg, rgba(14,34,38,0.98) 0%, rgba(16,39,45,0.98) 38%, rgba(12,31,37,0.99) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(90,124,118,0.08), 0 16px 28px rgba(7,18,22,0.18)",
  } as const;

  const caseEvidenceIconStyle = {
    width: 42,
    height: 42,
    borderRadius: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    background:
      "linear-gradient(180deg, rgba(22,47,54,0.95) 0%, rgba(18,35,41,0.98) 100%)",
    border: "1px solid rgba(83,120,118,0.20)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 20px rgba(0,0,0,0.18)",
    color: "#dce8e4",
    fontSize: 14,
    fontWeight: 800,
    letterSpacing: "0.04em",
  } as const;

  const caseEvidenceTitleStyle = {
    color: "#eef3f1",
    fontWeight: 700,
    fontSize: 15,
    lineHeight: 1.25,
    letterSpacing: "-0.01em",
  } as const;

  const caseEvidenceSubtitleStyle = {
    color: "#9baeab",
    fontSize: 13,
    lineHeight: 1.5,
    marginTop: 4,
  } as const;

  const reportReadyBadgeStyle = {
    color: "#dcefeb",
    background:
      "linear-gradient(180deg, rgba(61,91,95,0.82) 0%, rgba(31,52,57,0.92) 100%)",
    border: "1px solid rgba(157,207,197,0.18)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 18px rgba(10,26,30,0.18)",
    textShadow: "0 1px 0 rgba(0,0,0,0.24)",
  } as const;

  const signedBadgeStyle = {
    color: "#e8f7f2",
    background:
      "linear-gradient(180deg, rgba(72,120,112,0.88) 0%, rgba(28,53,50,0.94) 100%)",
    border: "1px solid rgba(144,214,195,0.22)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.09), 0 8px 18px rgba(12,34,31,0.20)",
    textShadow: "0 1px 0 rgba(0,0,0,0.24)",
  } as const;

  const processingBadgeStyle = {
    color: "#fff2cf",
    background:
      "linear-gradient(180deg, rgba(147,105,34,0.90) 0%, rgba(76,52,17,0.95) 100%)",
    border: "1px solid rgba(241,194,94,0.22)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 18px rgba(47,31,7,0.22)",
    textShadow: "0 1px 0 rgba(0,0,0,0.24)",
  } as const;

  const readyBadgeStyle = {
    color: "#e3ecea",
    background:
      "linear-gradient(180deg, rgba(84,103,108,0.80) 0%, rgba(38,54,59,0.92) 100%)",
    border: "1px solid rgba(189,199,202,0.16)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.07), 0 8px 18px rgba(10,18,22,0.18)",
    textShadow: "0 1px 0 rgba(0,0,0,0.22)",
  } as const;

  const resolveCaseStatusStyle = (
    tone: "reportReady" | "signed" | "processing" | "ready"
  ) => {
    if (tone === "reportReady") return reportReadyBadgeStyle;
    if (tone === "signed") return signedBadgeStyle;
    if (tone === "processing") return processingBadgeStyle;
    return readyBadgeStyle;
  };

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
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
              Case
            </div>

            <h1
              className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
              style={{ margin: "20px 0 0" }}
            >
              Loading <span style={{ color: "#c3ebe2" }}>case</span>.
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

        <div
          className="app-body app-body-full pt-8 md:pt-10"
          style={{
            position: "relative",
            overflow: "hidden",
            background:
              "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
          }}
        >
          <div className="container">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(194,78,78,0.16)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,243,243,0.92)_0%,rgba(248,239,235,0.86)_100%)]" />

              <div className="relative z-10 p-6 text-[#b42318]">
                {error || "Case not found"}
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section case-detail-page-shell">
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
                Case
              </div>

<div
  style={{
    marginTop: 20,
    display: "flex",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  }}
>
  {renamingCase ? (
    <>
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
          minHeight: 52,
          fontSize: "1.18rem",
          fontWeight: 600,
        }}
      />

      <Button
        onClick={handleRenameSubmit}
        disabled={!renameValue.trim() || operationLoading}
        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
        style={primaryButtonStyle}
      >
        Save
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          setRenamingCase(false);
          setRenameValue(caseData.name);
        }}
        disabled={operationLoading}
        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
        style={secondaryButtonStyle}
      >
        Cancel
      </Button>
    </>
  ) : (
    <>
      <h1
        className="max-w-[820px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
        style={{ margin: 0 }}
      >
        <span style={{ color: "#c3ebe2" }}>{caseData.name}</span>
      </h1>

      {isOwner && (
        <Button
          variant="secondary"
          onClick={handleRenameStart}
          disabled={operationLoading}
          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
          style={secondaryButtonStyle}
        >
          Rename
        </Button>
      )}
    </>
  )}
</div>

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

<div
  style={{
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
  }}
>
  {!renamingCase && (
    <>
      <Link href="/cases" style={{ textDecoration: "none" }}>
        <Button
          variant="secondary"
          disabled={operationLoading}
          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
          style={secondaryButtonStyle}
        >
          Back to Cases
        </Button>
      </Link>

      <Button
        onClick={handleExport}
        disabled={operationLoading}
        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
        style={primaryButtonStyle}
      >
        Export ZIP
      </Button>

      {isOwner && (
        <Button
          variant="secondary"
          onClick={() => setDeleteConfirm(true)}
          disabled={operationLoading}
          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
          style={dangerButtonStyle}
        >
          Delete
        </Button>
      )}
    </>
  )}
</div>
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

        <div className="container relative z-10" style={{ display: "grid", gap: 18, paddingBottom: 72 }}>
          {deleteConfirm && isOwner && (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(194,78,78,0.16)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,243,243,0.92)_0%,rgba(248,239,235,0.86)_100%)]" />

              <div className="relative z-10 p-6">
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: "#8f2d2d",
                    letterSpacing: "-0.03em",
                  }}
                >
                  Delete case?
                </div>

                <p
                  style={{
                    marginTop: 10,
                    color: "#a65353",
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
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </Button>

                  <Button
                    onClick={handleDeleteCase}
                    disabled={operationLoading}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
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
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

            <div className="relative z-10 p-6 md:p-7">
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#21353a",
                  letterSpacing: "-0.02em",
                  fontSize: 20,
                }}
              >
                Sharing
              </div>

              {caseData.access.length === 0 ? (
                <div style={{ color: "#5d6d71" }}>Not shared with anyone yet.</div>
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
                          <div style={{ color: "#23373b", fontWeight: 700 }}>{displayLabel}</div>
                          {access.user?.email && access.user.displayName && (
                            <div style={{ color: "#6a777b", fontSize: 13, marginTop: 4 }}>
                              {access.user.email}
                            </div>
                          )}
                        </div>

                        {isOwner && (
                          <Button
                            variant="secondary"
                            onClick={() => handleRevokeAccess(access.id)}
                            disabled={operationLoading}
                            className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
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
onClick={() => {
  setShowSharePanel((prev) => {
    const next = !prev;
    if (!next) {
      setTeamMemberMenuOpen(false);
    }
    return next;
  });
}}
                    disabled={operationLoading}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={tertiaryButtonStyle}
                  >
                    {showSharePanel ? "Close" : "Share Case"}
                  </Button>

                  {showSharePanel && (
                    <div
                      style={{
                        marginTop: 14,
                        padding: 16,
                        ...rowCardStyle,
                      }}
                    >
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
                        <label
                          style={{
                            color: "#42565b",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <input
                            type="radio"
                            value="team"
                            checked={shareMethod === "team"}
onChange={(e) => {
  setShareMethod(e.target.value as "team");
  setTeamMemberMenuOpen(false);
}}
                            disabled={!caseData.teamId || operationLoading}
                          />
                          <span>Share with Team Member</span>
                        </label>

                        <label
                          style={{
                            color: "#42565b",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <input
                            type="radio"
                            value="email"
                            checked={shareMethod === "email"}
onChange={(e) => {
  setShareMethod(e.target.value as "email");
  setTeamMemberMenuOpen(false);
}}
                            disabled={operationLoading}
                          />
                          <span>Share by Email</span>
                        </label>
                      </div>

                      <div style={{ display: "grid", gap: 12 }}>
                        {shareMethod === "team" ? (
                          caseData.teamId ? (
                            <>
<div style={{ position: "relative" }}>
  <button
    type="button"
    onClick={() => {
      if (operationLoading) return;
      setTeamMemberMenuOpen((prev) => !prev);
    }}
    disabled={operationLoading}
    style={{
      width: "100%",
      minHeight: 52,
      padding: "0 48px 0 16px",
      borderRadius: 18,
      fontSize: 15,
      textAlign: "left",
      background:
        "linear-gradient(180deg, rgba(250,251,249,0.96) 0%, rgba(241,244,241,0.99) 100%)",
      border: teamMemberMenuOpen
        ? "1px solid rgba(79,112,107,0.24)"
        : "1px solid rgba(79,112,107,0.14)",
      color: selectedTeamMember ? "#23373b" : "rgba(93,109,113,0.72)",
      boxShadow: teamMemberMenuOpen
        ? "inset 0 1px 0 rgba(255,255,255,0.78), 0 0 0 3px rgba(79,112,107,0.08), 0 12px 24px rgba(0,0,0,0.06)"
        : "inset 0 1px 0 rgba(255,255,255,0.7), 0 10px 22px rgba(0,0,0,0.05)",
      outline: "none",
      cursor: operationLoading ? "not-allowed" : "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      transition: "all 180ms ease",
    }}
  >
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {selectedTeamMember?.label || "Select a team member..."}
    </span>

    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        right: 16,
        top: "50%",
        transform: teamMemberMenuOpen
          ? "translateY(-50%) rotate(180deg)"
          : "translateY(-50%) rotate(0deg)",
        color: "#8a6e57",
        fontSize: 14,
        transition: "transform 180ms ease",
        pointerEvents: "none",
      }}
    >
      ▾
    </span>
  </button>

  {teamMemberMenuOpen && (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        left: 0,
        right: 0,
        zIndex: 50,
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid rgba(79,112,107,0.12)",
        background:
          "linear-gradient(180deg, rgba(252,253,251,0.98) 0%, rgba(243,245,242,0.99) 100%)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.7)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        padding: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
setSelectedTeamMemberId("");
setTeamMemberMenuOpen(false);
setShowSharePanel(false);
        }}
        style={{
          width: "100%",
          minHeight: 46,
          border: "none",
          background:
            selectedTeamMemberId === ""
              ? "linear-gradient(180deg, rgba(58,92,95,0.10) 0%, rgba(20,38,42,0.08) 100%)"
              : "transparent",
          color: selectedTeamMemberId === "" ? "#23373b" : "#5d6d71",
          borderRadius: 14,
          textAlign: "left",
          padding: "0 14px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Select a team member...
      </button>

      {teamMembers.map((member) => {
        const active = selectedTeamMemberId === member.userId;

        return (
          <button
            key={member.userId}
            type="button"
            onClick={() => {
              setSelectedTeamMemberId(member.userId);
              setTeamMemberMenuOpen(false);
            }}
            style={{
              width: "100%",
              minHeight: 48,
              border: "none",
              background: active
                ? "linear-gradient(180deg, rgba(58,92,95,0.12) 0%, rgba(20,38,42,0.08) 100%)"
                : "transparent",
              color: "#23373b",
              borderRadius: 14,
              textAlign: "left",
              padding: "0 14px",
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {member.label}
            </span>

            {active ? (
              <span
                style={{
                  color: "#3a5d61",
                  fontWeight: 700,
                  fontSize: 13,
                  flexShrink: 0,
                }}
              >
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  )}
</div>
                              <Button
                                onClick={handleShareTeam}
                                disabled={!selectedTeamMemberId || operationLoading}
                                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                                style={primaryButtonStyle}
                              >
                                Share with Member
                              </Button>
                            </>
                          ) : (
                            <div style={{ color: "#5d6d71" }}>
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
                                background:
                                  "linear-gradient(180deg, rgba(250,251,249,0.94) 0%, rgba(241,244,241,0.98) 100%)",
                                border: "1px solid rgba(79,112,107,0.14)",
                                color: "#23373b",
                                boxShadow:
                                  "inset 0 1px 0 rgba(255,255,255,0.68), 0 10px 22px rgba(0,0,0,0.05)",
                              }}
                            />

                            <Button
                              onClick={handleShareEmail}
                              disabled={!shareEmail.trim() || operationLoading}
                              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
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
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

            <div className="relative z-10 p-6 md:p-7">
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 14,
                  color: "#21353a",
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
                        "linear-gradient(180deg, rgba(214,184,157,0.12) 0%, rgba(255,255,255,0.56) 100%)",
                      border: "1px solid rgba(183,157,132,0.18)",
                      color: "#8a6e57",
                      boxShadow: "0 10px 22px rgba(0,0,0,0.08)",
                    }}
                  >
                    <Icons.Evidence />
                  </div>
                  <div style={{ color: "#5d6d71" }}>
                    No evidence in this case yet.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {evidence.map((item) => {
                    const statusMeta = getDisplayStatusMeta(item.status);

                    return (
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
                          <div
                            style={{
                              ...caseEvidenceSurfaceStyle,
                              borderRadius: 20,
                              minHeight: 74,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 14,
                              padding: "12px 16px 12px 14px",
                            }}
                          >
                            <div
                              style={{
                                minWidth: 0,
                                display: "flex",
                                alignItems: "center",
                                gap: 14,
                                flex: 1,
                              }}
                            >
                              <div style={caseEvidenceIconStyle}>EV</div>

                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    ...caseEvidenceTitleStyle,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {resolveEvidenceTitle(item)}
                                </div>

                                <div
                                  style={{
                                    ...caseEvidenceSubtitleStyle,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {resolveEvidenceSubtitle(item)}
                                </div>
                              </div>
                            </div>

                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                flexShrink: 0,
                              }}
                            >
                              <span
                                className="inline-flex min-h-[32px] items-center justify-center rounded-full px-3.5 py-[6px] text-[10.5px] font-semibold uppercase tracking-[0.14em]"
                                style={resolveCaseStatusStyle(statusMeta.tone)}
                              >
                                {statusMeta.label}
                              </span>

                              <span
                                aria-hidden="true"
                                style={{
                                  color: "rgba(193,205,202,0.58)",
                                  fontSize: 18,
                                  lineHeight: 1,
                                  transform: "translateY(-1px)",
                                }}
                              >
                                ›
                              </span>
                            </div>
                          </div>
                        </Link>

                        {isOwner && (
                          <div onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="secondary"
                              onClick={() => handleRemoveEvidence(item.id)}
                              disabled={operationLoading}
                              className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                              style={dangerButtonStyle}
                            >
                              Remove
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}