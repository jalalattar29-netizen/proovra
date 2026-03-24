"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, ListRow, Badge, useToast } from "../../../../components/ui";
import { Icons } from "../../../../components/icons";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

interface CaseData {
  id: string;
  name: string;
  teamId?: string;
  access: Array<{
    id: string;
    userId: string;
    createdAt: string;
    user?: { id: string; email?: string; displayName?: string };
  }>;
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

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [availableEvidence, setAvailableEvidence] = useState<EvidenceItem[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [renamingCase, setRenamingCase] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [shareMethod, setShareMethod] = useState<"team" | "email">("team");
  const [selectedTeamMemberId, setSelectedTeamMemberId] = useState<string>("");
  const [shareEmail, setShareEmail] = useState("");
  const [showAddEvidence, setShowAddEvidence] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);

  const loadData = async () => {
    if (!params?.id) return;

    setLoading(true);
    setError(null);

    try {
      const [caseRes, evidenceRes] = await Promise.all([
        apiFetch(`/v1/cases/${params.id}`),
        apiFetch(`/v1/evidence?caseId=${params.id}`)
      ]);

      setCaseData(caseRes.case ?? null);
      setEvidence(evidenceRes.items ?? []);
      setRenameValue(caseRes.case?.name ?? "");

      try {
        const availableRes = await apiFetch(`/v1/cases/${params.id}/available-evidence`);
        setAvailableEvidence(availableRes.items ?? []);
      } catch (err) {
        console.error("Failed to load available evidence:", err);
        setAvailableEvidence([]);
      }

      if (caseRes.case?.teamId) {
        try {
          const membersRes = await apiFetch(`/v1/cases/${params.id}/team-members`);
          setTeamMembers(membersRes.items ?? []);
        } catch (err) {
          console.error("Failed to load team members:", err);
          setTeamMembers([]);
        }
      } else {
        setTeamMembers([]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to load case";
      setError(errorMessage);
      captureException(err, { feature: "case_detail_load", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

  }, [params?.id]);

  const handleRenameStart = () => {
    if (!caseData) return;
    setRenameValue(caseData.name);
    setRenamingCase(true);
  };

  const handleRenameSubmit = async () => {
    if (!params?.id || !renameValue.trim()) return;

    setOperationLoading(true);
    addToast("Renaming case...", "info");

    try {
      const updated = await apiFetch(`/v1/cases/${params.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: renameValue.trim() })
      });

      setCaseData((prev) => (prev ? { ...prev, name: updated.name } : prev));
      setRenamingCase(false);
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to rename case";
      captureException(err, { feature: "case_rename", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDeleteCase = async () => {
    if (!params?.id) return;

    setDeleteConfirm(false);
    setOperationLoading(true);
    addToast("Deleting case...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}`, { method: "DELETE" });
      addToast("Case deleted successfully", "success");
      setTimeout(() => router.push("/cases"), 400);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to delete case";
      captureException(err, { feature: "case_delete", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleAddEvidenceToCase = async (evidenceId: string) => {
    if (!params?.id) return;

    setOperationLoading(true);
    addToast("Adding evidence to case...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidenceId })
      });

      const addedItem =
        availableEvidence.find((item) => item.id === evidenceId) ?? null;

      if (addedItem) {
        setEvidence((prev) => [addedItem, ...prev]);
      }

      setAvailableEvidence((prev) => prev.filter((item) => item.id !== evidenceId));
      addToast("Evidence added to case", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to add evidence";
      captureException(err, { feature: "case_add_evidence", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleRemoveEvidence = async (evidenceId: string) => {
    if (!params?.id) return;

    setOperationLoading(true);
    addToast("Removing evidence from case...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}/evidence/${evidenceId}`, {
        method: "DELETE"
      });

      const removed = evidence.find((item) => item.id === evidenceId) ?? null;

      setEvidence((prev) => prev.filter((item) => item.id !== evidenceId));

      if (removed) {
        setAvailableEvidence((prev) => [removed, ...prev]);
      }

      addToast("Evidence removed from case", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to remove evidence";
      captureException(err, { feature: "case_remove_evidence", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleShareTeam = async () => {
    if (!params?.id || !selectedTeamMemberId) return;

    setOperationLoading(true);
    addToast("Sharing case...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}/share-team`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedTeamMemberId })
      });

      setSelectedTeamMemberId("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_team", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleShareEmail = async () => {
    if (!params?.id || !shareEmail.trim()) return;

    setOperationLoading(true);
    addToast("Sharing case by email...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}/share-email`, {
        method: "POST",
        body: JSON.stringify({ email: shareEmail.trim() })
      });

      setShareEmail("");
      setShowSharePanel(false);
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_email", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleRevokeAccess = async (accessId: string) => {
    if (!params?.id) return;

    setOperationLoading(true);
    addToast("Removing access...", "info");

    try {
      await apiFetch(`/v1/cases/${params.id}/access/${accessId}`, {
        method: "DELETE"
      });

      await loadData();
      addToast("Access removed", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to remove access";
      captureException(err, { feature: "case_revoke_access", caseId: params?.id });
      addToast(errorMessage, "error");
    } finally {
      setOperationLoading(false);
    }
  };

  const handleExport = () => {
    if (!params?.id) return;
    window.open(`/v1/cases/${params.id}/export`, "_blank");
  };

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title" style={{ margin: 0 }}>
              Loading case...
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
            <h1 className="hero-title" style={{ margin: 0 }}>
              Error
            </h1>
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
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title case-detail-title" style={{ margin: 0 }}>
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

              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                {renamingCase ? null : "Evidence grouped under this case."}
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
          {deleteConfirm && (
            <Card className="case-delete-card">
              <div style={{ marginBottom: 12 }}>
                <div className="case-delete-title">Delete Case?</div>
                <p className="case-delete-subtitle">
                  The case will be deleted, but all evidence will remain in your dashboard.
                </p>
              </div>

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

                      <Button
                        variant="secondary"
                        onClick={() => handleRevokeAccess(access.id)}
                        disabled={operationLoading}
                        className="case-danger-btn case-small-btn"
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            <Button
              variant="secondary"
              onClick={() => setShowSharePanel(!showSharePanel)}
              disabled={operationLoading}
            >
              {showSharePanel ? "Close" : "Share Case"}
            </Button>

            {showSharePanel && (
              <div className="case-panel">
                <div style={{ marginBottom: 8 }}>
                  <label className="case-radio-label">
                    <input
                      type="radio"
                      value="team"
                      checked={shareMethod === "team"}
                      onChange={(e) => setShareMethod(e.target.value as "team")}
                      style={{ marginRight: 6 }}
                      disabled={!caseData.teamId || operationLoading}
                    />
                    Share with Team Member
                  </label>

                  <label className="case-radio-label">
                    <input
                      type="radio"
                      value="email"
                      checked={shareMethod === "email"}
                      onChange={(e) => setShareMethod(e.target.value as "email")}
                      style={{ marginRight: 6 }}
                    />
                    Share by Email
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
          </Card>

          {availableEvidence.length > 0 && (
            <Card className="case-section-card">
              <div className="case-section-title">Add Existing Evidence</div>

              <Button
                variant="secondary"
                onClick={() => setShowAddEvidence(!showAddEvidence)}
                disabled={operationLoading}
              >
                {showAddEvidence ? "Hide" : "Show"} Available Evidence
              </Button>

              {showAddEvidence && (
                <div className="case-available-list">
                  {availableEvidence.map((item) => (
                    <div key={item.id} className="case-available-row">
                      <div>
                        <div className="case-available-type">{item.type}</div>
                        <div className="case-available-date">
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                      </div>

                      <Button
                        className="navy-btn case-small-btn"
                        onClick={() => handleAddEvidenceToCase(item.id)}
                        disabled={operationLoading}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

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
                    <div style={{ flex: 1, minWidth: 0 }}>
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
                    </div>

                    <Button
                      variant="secondary"
                      onClick={() => handleRemoveEvidence(item.id)}
                      disabled={operationLoading}
                      className="case-danger-btn case-small-btn"
                    >
                      Remove
                    </Button>
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
