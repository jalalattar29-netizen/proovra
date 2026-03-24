"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, ListRow, Badge, useToast } from "../../../../components/ui";
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
  type: string;
  status: string;
  createdAt: string;
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
        apiFetch(`/v1/evidence?caseId=${caseId}`) as Promise<{ items?: EvidenceItem[] }>
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
      const errorMessage = err instanceof Error ? err.message : "Failed to load case";
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
        body: JSON.stringify({ name: renameValue.trim() })
      })) as { name: string };

      setCaseData((prev) => (prev ? { ...prev, name: updated.name } : prev));
      setRenamingCase(false);
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to rename case";
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
      const errorMessage = err instanceof Error ? err.message : "Failed to delete case";
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
        method: "DELETE"
      });

      setEvidence((prev) => prev.filter((item) => item.id !== evidenceId));
      addToast("Evidence removed from case", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to remove evidence";
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
        body: JSON.stringify({ userId: selectedTeamMemberId })
      });

      setSelectedTeamMemberId("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
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
        body: JSON.stringify({ email: shareEmail.trim() })
      });

      setShareEmail("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
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
        method: "DELETE"
      });

      await loadData();
      addToast("Access removed", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to remove access";
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

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title case-detail-title">Loading case...</h1>
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
            <h1 className="hero-title case-detail-title">Error</h1>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
            <Card className="case-error-card">
              {error || "Case not found"}
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title case-header-row">
            <div>
              <h1 className="hero-title pricing-hero-title case-detail-title">
                {renamingCase ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    maxLength={120}
                    className="case-rename-input"
                    autoFocus
                  />
                ) : (
                  caseData.name
                )}
              </h1>

              <p className="page-subtitle pricing-subtitle case-detail-subtitle">
                {isOwner
                  ? "Manage this case and the evidence already linked to it."
                  : "You can view this shared case and the evidence inside it."}
              </p>
            </div>

            <div className="case-detail-actions">
              {renamingCase ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenamingCase(false);
                      setRenameValue(caseData.name);
                    }}
                    disabled={operationLoading}
                  >
                    Cancel
                  </Button>

                  <Button
                    className="navy-btn"
                    onClick={handleRenameSubmit}
                    disabled={!renameValue.trim() || operationLoading}
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
                      >
                        Rename
                      </Button>

                      <Button
                        variant="secondary"
                        onClick={() => setDeleteConfirm(true)}
                        disabled={operationLoading}
                        className="case-danger-btn"
                      >
                        Delete
                      </Button>
                    </>
                  )}

                  <Button
                    className="navy-btn"
                    onClick={handleExport}
                    disabled={operationLoading}
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
        <div className="container case-detail-grid">
          {deleteConfirm && isOwner && (
            <Card className="case-delete-card">
              <div className="case-delete-title">Delete Case?</div>
              <p className="case-delete-subtitle">
                The case will be deleted, but all evidence will remain in your dashboard.
              </p>

              <div className="case-inline-actions">
                <Button
                  variant="secondary"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={operationLoading}
                >
                  Cancel
                </Button>

                <Button
                  onClick={handleDeleteCase}
                  disabled={operationLoading}
                  className="case-delete-confirm-btn"
                >
                  Delete Case
                </Button>
              </div>
            </Card>
          )}

          <Card className="case-section-card">
            <div className="case-section-title">Sharing</div>

            {caseData.access.length === 0 ? (
              <div className="case-muted-text">Not shared with anyone yet.</div>
            ) : (
              <div className="case-share-list">
                {caseData.access.map((access) => {
                  const displayLabel =
                    access.user?.displayName || access.user?.email || "User";

                  return (
                    <div key={access.id} className="case-share-row">
                      <div>
                        <div className="case-share-name">{displayLabel}</div>
                        {access.user?.email && access.user.displayName && (
                          <div className="case-share-email">{access.user.email}</div>
                        )}
                      </div>

                      {isOwner && (
                        <Button
                          variant="secondary"
                          onClick={() => handleRevokeAccess(access.id)}
                          disabled={operationLoading}
                          className="case-danger-btn case-small-btn"
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
                >
                  {showSharePanel ? "Close" : "Share Case"}
                </Button>

                {showSharePanel && (
                  <div className="case-panel">
                    <div className="case-radio-group">
                      <label className="case-radio-label">
                        <input
                          type="radio"
                          value="team"
                          checked={shareMethod === "team"}
                          onChange={(e) => setShareMethod(e.target.value as "team")}
                          disabled={!caseData.teamId || operationLoading}
                        />
                        <span>Share with Team Member</span>
                      </label>

                      <label className="case-radio-label">
                        <input
                          type="radio"
                          value="email"
                          checked={shareMethod === "email"}
                          onChange={(e) => setShareMethod(e.target.value as "email")}
                          disabled={operationLoading}
                        />
                        <span>Share by Email</span>
                      </label>
                    </div>

                    <div className="case-panel-grid">
                      {shareMethod === "team" ? (
                        caseData.teamId ? (
                          <>
                            <select
                              value={selectedTeamMemberId}
                              onChange={(e) => setSelectedTeamMemberId(e.target.value)}
                              className="case-select"
                              disabled={operationLoading}
                            >
                              <option value="">Select a team member...</option>
                              {teamMembers.map((member) => (
                                <option key={member.userId} value={member.userId}>
                                  {member.label}
                                </option>
                              ))}
                            </select>

                            <Button
                              className="navy-btn"
                              onClick={handleShareTeam}
                              disabled={!selectedTeamMemberId || operationLoading}
                            >
                              Share with Member
                            </Button>
                          </>
                        ) : (
                          <div className="case-info-box">
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
                            className="case-text-input"
                            disabled={operationLoading}
                          />

                          <Button
                            className="navy-btn"
                            onClick={handleShareEmail}
                            disabled={!shareEmail.trim() || operationLoading}
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
          </Card>

          <Card className="case-section-card">
            <div className="case-section-title">Evidence in Case</div>

            {evidence.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon empty-state-icon-svg">
                  <Icons.Evidence />
                </div>
                <div>No evidence in this case yet.</div>
              </div>
            ) : (
              <div className="case-evidence-list">
                {evidence.map((item) => (
                  <div key={item.id} className="case-evidence-row">
                    <Link
                      href={`/evidence/${item.id}`}
                      className="case-evidence-main case-evidence-link"
                    >
                      <ListRow
                        title={item.type}
                        subtitle={new Date(item.createdAt).toLocaleString()}
                        badge={
                          <Badge
                            tone={
                              item.status === "SIGNED"
                                ? "signed"
                                : item.status === "REPORTED"
                                  ? "ready"
                                  : "processing"
                            }
                          >
                            {item.status}
                          </Badge>
                        }
                      />
                    </Link>

                    {isOwner && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="case-evidence-action"
                      >
                        <Button
                          variant="secondary"
                          onClick={() => handleRemoveEvidence(item.id)}
                          disabled={operationLoading}
                          className="case-danger-btn case-small-btn"
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}