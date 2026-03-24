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

  // UI State
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
      const [caseRes, evidenceRes, availableRes] = await Promise.all([
        apiFetch(`/v1/cases/${params.id}`),
        apiFetch(`/v1/evidence?caseId=${params.id}`),
        apiFetch(`/v1/cases/${params.id}/available-evidence`)
      ]);
      setCaseData(caseRes.case);
      setEvidence(evidenceRes.items ?? []);
      setAvailableEvidence(availableRes.items ?? []);
      setRenameValue(caseRes.case?.name ?? "");
      
      // Load team members if this is a team case
      if (caseRes.case?.teamId) {
        try {
          const membersRes = await apiFetch(`/v1/cases/${params.id}/team-members`);
          setTeamMembers(membersRes.items ?? []);
        } catch (err) {
          // Team members load may fail, but continue with case data
          console.error("Failed to load team members:", err);
        }
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
    setRenamingCase(true);
  };

  const handleRenameSubmit = async () => {
    if (!params?.id || !renameValue.trim()) return;
    setRenamingCase(false);
    setOperationLoading(true);
    addToast("Renaming case...", "info");
    try {
      const updated = await apiFetch(`/v1/cases/${params.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: renameValue.trim() })
      });
      setCaseData((prev) => prev ? { ...prev, name: updated.name } : null);
      addToast("Case renamed successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to rename case";
      captureException(err, { feature: "case_rename", caseId: params?.id });
      addToast(errorMessage, "error");
      setRenamingCase(true);
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
      setTimeout(() => router.push("/cases"), 500);
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
      setEvidence((prev) => [
        ...prev,
        availableEvidence.find((e) => e.id === evidenceId) || { id: evidenceId, type: "", status: "", createdAt: "" }
      ]);
      setAvailableEvidence((prev) => prev.filter((e) => e.id !== evidenceId));
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
      const removed = evidence.find((e) => e.id === evidenceId);
      setEvidence((prev) => prev.filter((e) => e.id !== evidenceId));
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
    setShowSharePanel(false);
    setOperationLoading(true);
    addToast("Sharing case...", "info");
    try {
      await apiFetch(`/v1/cases/${params.id}/share-team`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedTeamMemberId })
      });
      setSelectedTeamMemberId("");
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_team", caseId: params?.id });
      addToast(errorMessage, "error");
      setShowSharePanel(true);
    } finally {
      setOperationLoading(false);
    }
  };

  const handleShareEmail = async () => {
    if (!params?.id || !shareEmail) return;
    setShowSharePanel(false);
    setOperationLoading(true);
    addToast("Sharing case by email...", "info");
    try {
      await apiFetch(`/v1/cases/${params.id}/share-email`, {
        method: "POST",
        body: JSON.stringify({ email: shareEmail })
      });
      setShareEmail("");
      await loadData();
      addToast("Case shared successfully", "success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to share case";
      captureException(err, { feature: "case_share_email", caseId: params?.id });
      addToast(errorMessage, "error");
      setShowSharePanel(true);
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
            <h1 className="hero-title" style={{ margin: 0 }}>Loading case...</h1>
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
            <h1 className="hero-title" style={{ margin: 0 }}>Error</h1>
          </div>
        </div>
        <div className="app-body app-body-full">
          <div className="container">
            <Card style={{ padding: 16, background: "#FEE2E2", color: "#991B1B" }}>
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
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {renamingCase ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    maxLength={120}
                    style={{
                      fontSize: "inherit",
                      fontWeight: "inherit",
                      border: "1px solid #E2E8F0",
                      borderRadius: 8,
                      padding: 8,
                      fontFamily: "inherit"
                    }}
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
            <div style={{ display: "flex", gap: 8 }}>
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
                    style={{ color: "#DC2626" }}
                  >
                    Delete
                  </Button>
                  <Button className="navy-btn" onClick={handleExport} disabled={operationLoading}>
                    Export ZIP
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {/* Rename Confirmation */}
          {deleteConfirm && (
            <Card style={{ padding: 16, background: "#FEE2E2", borderRadius: 8 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#DC2626", marginBottom: 4 }}>Delete Case?</div>
                <p style={{ margin: "0 0 0 0", fontSize: 14, color: "#64748b" }}>
                  The case will be deleted, but all evidence will remain in your dashboard.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
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
                  style={{ backgroundColor: "#DC2626", color: "white" }}
                >
                  Delete Case
                </Button>
              </div>
            </Card>
          )}

          {/* Sharing */}
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Sharing</div>
            {caseData.access.length === 0 ? (
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
                Not shared with anyone yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
                {caseData.access.map((access) => {
                  const displayLabel = access.user?.displayName || access.user?.email || "User";
                  return (
                    <div
                      key={access.id}
                      style={{
                        padding: 8,
                        borderRadius: 6,
                        background: "#F1F5F9",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 12
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500 }}>{displayLabel}</div>
                        {access.user?.email && access.user.displayName && (
                          <div style={{ fontSize: 11, color: "#64748b" }}>{access.user.email}</div>
                        )}
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => handleRevokeAccess(access.id)}
                        disabled={operationLoading}
                        style={{ fontSize: 11, padding: "4px 8px", color: "#DC2626" }}
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
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: "block" }}>
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
                  <label style={{ fontSize: 12, fontWeight: 500, display: "block" }}>
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
                <div style={{ display: "grid", gap: 8 }}>
                  {shareMethod === "team" ? (
                    caseData.teamId ? (
                      <>
                        <select
                          value={selectedTeamMemberId}
                          onChange={(e) => setSelectedTeamMemberId(e.target.value)}
                          style={{
                            padding: 8,
                            borderRadius: 6,
                            border: "1px solid #E2E8F0",
                            fontSize: 12,
                            fontFamily: "inherit",
                            cursor: "pointer"
                          }}
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
                          style={{ fontSize: 12 }}
                        >
                          Share with Member
                        </Button>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: "#64748b", padding: 8, background: "#F1F5F9", borderRadius: 6 }}>
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
                        style={{
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #E2E8F0",
                          fontSize: 12,
                          fontFamily: "inherit"
                        }}
                      />
                      <Button
                        className="navy-btn"
                        onClick={handleShareEmail}
                        disabled={!shareEmail.trim() || operationLoading}
                        style={{ fontSize: 12 }}
                      >
                        Share by Email
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Add Existing Evidence */}
          {availableEvidence.length > 0 && (
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Add Existing Evidence</div>
              <Button
                variant="secondary"
                onClick={() => setShowAddEvidence(!showAddEvidence)}
                disabled={operationLoading}
              >
                {showAddEvidence ? "Hide" : "Show"} Available Evidence
              </Button>
              {showAddEvidence && (
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  {availableEvidence.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: 8,
                        borderRadius: 6,
                        background: "#F1F5F9",
                        fontSize: 12
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500 }}>{item.type}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <Button
                        className="navy-btn"
                        onClick={() => handleAddEvidenceToCase(item.id)}
                        disabled={operationLoading}
                        style={{ fontSize: 11, padding: "4px 8px" }}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Evidence in Case */}
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Evidence in Case</div>
            {evidence.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon empty-state-icon-svg">
                  <Icons.Evidence />
                </div>
                <div>No evidence in this case yet.</div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {evidence.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: 12,
                      borderRadius: 6,
                      border: "1px solid #E2E8F0"
                    }}
                  >
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
                      style={{ fontSize: 11, padding: "4px 8px", color: "#DC2626", marginLeft: 8 }}
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
