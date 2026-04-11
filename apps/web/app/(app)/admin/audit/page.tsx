"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Skeleton } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";

type AuditRow = {
  id: string;
  userId: string | null;
  isPublic: boolean;
  action: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
  anchoredAt: string | null;
};

type VerifyState =
  | { valid: true; partial?: boolean; verifiedCount?: number }
  | { valid: false; brokenAt: string }
  | null;

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function prettyMetadataJson(metadata: unknown): string {
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

function metadataPreview(metadata: unknown): string {
  const raw = prettyMetadataJson(metadata).replace(/\s+/g, " ").trim();
  if (raw.length <= 180) return raw;
  return `${raw.slice(0, 180)}…`;
}

function severityTone(severity?: string | null) {
  const value = (severity ?? "").toLowerCase();

  if (value === "critical" || value === "high") {
    return {
      border: "1px solid rgba(194,78,78,0.20)",
      background:
        "linear-gradient(180deg, rgba(164,84,84,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8f4c4c",
    } as const;
  }

  if (value === "medium" || value === "warning") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    } as const;
  }

  return {
    border: "1px solid rgba(79,112,107,0.16)",
    background:
      "linear-gradient(180deg, rgba(191,232,223,0.18) 0%, rgba(255,255,255,0.44) 100%)",
    color: "#2d5b59",
  } as const;
}

function outcomeTone(outcome?: string | null) {
  const value = (outcome ?? "").toLowerCase();

  if (value === "failed" || value === "error" || value === "denied") {
    return {
      border: "1px solid rgba(194,78,78,0.20)",
      background:
        "linear-gradient(180deg, rgba(164,84,84,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8f4c4c",
    } as const;
  }

  if (value === "warning" || value === "partial") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    } as const;
  }

  return {
    border: "1px solid rgba(79,112,107,0.16)",
    background:
      "linear-gradient(180deg, rgba(191,232,223,0.18) 0%, rgba(255,255,255,0.44) 100%)",
    color: "#2d5b59",
  } as const;
}

export default function AdminAuditPage() {
  const { addToast } = useToast();
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<VerifyState>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const isExpanded = (id: string) => Boolean(expandedRows[id]);

  const loadAudit = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch("/v1/admin/audit-log?limit=25");
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load admin audit log";
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const verifyChain = useCallback(async () => {
    try {
      setVerifying(true);
      const data = await apiFetch("/v1/admin/audit-log/verify?limit=1000");
      setVerify(data ?? null);
      addToast("Audit chain verification completed", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to verify audit chain";
      addToast(message, "error");
    } finally {
      setVerifying(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadAudit();
    void verifyChain();
  }, [loadAudit, verifyChain]);

  const summary = useMemo(() => {
    let publicCount = 0;
    let anchoredCount = 0;
    let failureCount = 0;
    let highSeverityCount = 0;

    for (const item of items) {
      if (item.isPublic) publicCount += 1;
      if (item.anchoredAt) anchoredCount += 1;

      const outcome = (item.outcome ?? "").toLowerCase();
      const severity = (item.severity ?? "").toLowerCase();

      if (outcome === "failed" || outcome === "error" || outcome === "denied") {
        failureCount += 1;
      }

      if (severity === "high" || severity === "critical") {
        highSeverityCount += 1;
      }
    }

    return {
      total: items.length,
      publicCount,
      anchoredCount,
      failureCount,
      highSeverityCount,
    };
  }, [items]);

  const statPillBase = useMemo(
    () =>
      ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }) as const,
    []
  );

  return (
    <DashboardShell
      eyebrow="Admin Audit"
      title="Tamper-evident audit log and"
      highlight="chain integrity."
      description={
        <>
          Review privileged actions, exported audit entries, and the integrity state
          of the administrative audit chain.
        </>
      }
      action={
        <div className="flex gap-3">
          <Button
            className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
            style={dashboardStyles.secondaryButton}
            onClick={() => void loadAudit()}
          >
            Refresh
          </Button>
          <Button
            className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
            style={dashboardStyles.primaryButton}
            onClick={() => void verifyChain()}
          >
            {verifying ? "Verifying..." : "Verify Chain"}
          </Button>
        </div>
      }
    >
      <style jsx global>{`
        .admin-audit-page .audit-grid {
          display: grid;
          gap: 18px;
        }

        .admin-audit-page .audit-summary-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-audit-page .audit-top-grid {
          display: grid;
          grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
          gap: 18px;
          align-items: stretch;
        }

        .admin-audit-page .audit-card {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79, 112, 107, 0.16);
          background: transparent;
          box-shadow:
            0 18px 38px rgba(0, 0, 0, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .admin-audit-page .audit-card-overlay {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.24) 0%,
              rgba(248, 249, 246, 0.34) 42%,
              rgba(239, 241, 238, 0.42) 100%
            );
        }

        .admin-audit-page .audit-card-shine {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            circle at 16% 12%,
            rgba(255, 255, 255, 0.34),
            transparent 28%
          );
          opacity: 0.9;
        }

        .admin-audit-page .audit-card-inner {
          position: relative;
          z-index: 10;
          padding: 24px;
        }

        .admin-audit-page .audit-section-title {
          font-size: 1.08rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #21353a;
        }

        .admin-audit-page .audit-section-copy {
          margin-top: 8px;
          color: #5d6d71;
          line-height: 1.7;
          font-size: 0.94rem;
        }

        .admin-audit-page .audit-summary-card {
          min-height: 146px;
        }

        .admin-audit-page .audit-summary-label {
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #708085;
        }

        .admin-audit-page .audit-summary-value {
          margin-top: 10px;
          font-size: 2rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.05em;
          color: #21353a;
        }

        .admin-audit-page .audit-summary-note {
          margin-top: 10px;
          font-size: 0.84rem;
          color: #6b7b7f;
          line-height: 1.6;
        }

        .admin-audit-page .audit-status-panel {
          display: grid;
          gap: 14px;
          margin-top: 18px;
        }

        .admin-audit-page .audit-status-box {
          border: 1px solid rgba(79, 112, 107, 0.12);
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.58) 0%,
              rgba(243, 245, 242, 0.9) 100%
            );
          border-radius: 20px;
          padding: 16px;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.42),
            0 12px 26px rgba(0, 0, 0, 0.06);
        }

        .admin-audit-page .audit-row-list {
          display: grid;
          gap: 12px;
          margin-top: 18px;
        }

        .admin-audit-page .audit-row-card {
          border: 1px solid rgba(79, 112, 107, 0.1);
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.58) 0%,
              rgba(243, 245, 242, 0.9) 100%
            );
          border-radius: 22px;
          padding: 16px;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.42),
            0 12px 26px rgba(0, 0, 0, 0.06);
        }

        .admin-audit-page .audit-row-top {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
          flex-wrap: wrap;
        }

        .admin-audit-page .audit-row-title {
          font-size: 1rem;
          font-weight: 800;
          color: #21353a;
          letter-spacing: -0.02em;
        }

        .admin-audit-page .audit-row-time {
          font-size: 0.8rem;
          color: #6e7e83;
          white-space: nowrap;
        }

        .admin-audit-page .audit-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }

        .admin-audit-page .audit-meta-lines {
          display: grid;
          gap: 6px;
          margin-top: 12px;
        }

        .admin-audit-page .audit-meta-line {
          font-size: 0.82rem;
          color: #67777c;
          line-height: 1.6;
          word-break: break-word;
        }

        .admin-audit-page .audit-preview-box {
          margin-top: 12px;
          border-radius: 16px;
          padding: 14px;
          border: 1px solid rgba(183, 157, 132, 0.14);
          background: linear-gradient(
            135deg,
            rgba(214, 184, 157, 0.1),
            rgba(255, 255, 255, 0.36)
          );
        }

        .admin-audit-page .audit-preview-text {
          font-size: 0.82rem;
          color: #6d6257;
          line-height: 1.65;
          word-break: break-word;
        }

        .admin-audit-page .audit-pre {
          font-size: 11px;
          color: #55656a;
          line-height: 1.5;
          margin-top: 10px;
          margin-bottom: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, monospace;
          background: rgba(255, 255, 255, 0.55);
          border: 1px solid rgba(79, 112, 107, 0.08);
          border-radius: 14px;
          padding: 12px;
        }

        @media (max-width: 1180px) {
          .admin-audit-page .audit-summary-grid,
          .admin-audit-page .audit-top-grid {
            grid-template-columns: 1fr 1fr;
          }
        }

        @media (max-width: 860px) {
          .admin-audit-page .audit-summary-grid,
          .admin-audit-page .audit-top-grid {
            grid-template-columns: 1fr;
          }

          .admin-audit-page .audit-card-inner {
            padding: 20px;
          }
        }
      `}</style>

      <div className="admin-audit-page audit-grid">
        <div className="audit-summary-grid">
          <Card className="audit-card audit-summary-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />
            <div className="audit-card-inner">
              <div className="audit-summary-label">Audit Entries</div>
              <div className="audit-summary-value" style={{ color: "#2d5b59" }}>
                {summary.total}
              </div>
              <div className="audit-summary-note">
                Recent administrative actions currently visible in this log view.
              </div>
            </div>
          </Card>

          <Card className="audit-card audit-summary-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />
            <div className="audit-card-inner">
              <div className="audit-summary-label">Anchored Rows</div>
              <div className="audit-summary-value" style={{ color: "#8a6e57" }}>
                {summary.anchoredCount}
              </div>
              <div className="audit-summary-note">
                Entries that include an anchor timestamp in the current result set.
              </div>
            </div>
          </Card>

          <Card className="audit-card audit-summary-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />
            <div className="audit-card-inner">
              <div className="audit-summary-label">Failures</div>
              <div className="audit-summary-value" style={{ color: "#9a5757" }}>
                {summary.failureCount}
              </div>
              <div className="audit-summary-note">
                Requests marked with failed, denied, or error outcomes.
              </div>
            </div>
          </Card>

          <Card className="audit-card audit-summary-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />
            <div className="audit-card-inner">
              <div className="audit-summary-label">High Severity</div>
              <div className="audit-summary-value" style={{ color: "#7b6475" }}>
                {summary.highSeverityCount}
              </div>
              <div className="audit-summary-note">
                Actions classified as high or critical severity.
              </div>
            </div>
          </Card>
        </div>

        <div className="audit-top-grid">
          <Card className="audit-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />

            <div className="audit-card-inner">
              <div className="audit-section-title">Chain Status</div>
              <div className="audit-section-copy">
                Verify whether the administrative audit chain is still intact and whether
                the currently checked segment passed validation.
              </div>

              <div className="audit-status-panel">
                {verify === null ? (
                  <div className="audit-status-box">
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 800,
                        color: "#6b7b7f",
                      }}
                    >
                      Verification unavailable
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#728287",
                        marginTop: 6,
                        lineHeight: 1.65,
                      }}
                    >
                      Chain status could not be determined yet. Refresh or re-run
                      verification to fetch the latest integrity result.
                    </div>
                  </div>
                ) : verify.valid ? (
                  <div className="audit-status-box">
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 800,
                        color: "#2f6a55",
                      }}
                    >
                      Audit chain verified
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#6a7b7f",
                        marginTop: 6,
                        lineHeight: 1.65,
                      }}
                    >
                      {verify.partial ? "Tail verification" : "Full verification"}
                      {typeof verify.verifiedCount === "number"
                        ? ` · ${verify.verifiedCount} rows checked`
                        : ""}
                    </div>
                  </div>
                ) : (
                  <div className="audit-status-box">
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 800,
                        color: "#9a5757",
                      }}
                    >
                      Integrity issue detected
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#7f6e6e",
                        marginTop: 6,
                        lineHeight: 1.65,
                      }}
                    >
                      brokenAt: {verify.brokenAt}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    ...dashboardStyles.softCard,
                    padding: 16,
                    borderRadius: 20,
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    border: "1px solid rgba(79,112,107,0.10)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: "#738287",
                    }}
                  >
                    Current Snapshot
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 12,
                      marginTop: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, color: "#738287" }}>Loaded rows</div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 20,
                          fontWeight: 800,
                          color: "#21353a",
                          letterSpacing: "-0.04em",
                        }}
                      >
                        {summary.total}
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: 12, color: "#738287" }}>Public/system</div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 20,
                          fontWeight: 800,
                          color: "#8a6e57",
                          letterSpacing: "-0.04em",
                        }}
                      >
                        {summary.publicCount}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="audit-card" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="audit-card-overlay" />
            <div className="audit-card-shine" />

            <div className="audit-card-inner">
              <div className="audit-section-title">Audit Overview</div>
              <div className="audit-section-copy">
                Use this page to inspect administrative actions, review metadata, and
                quickly identify elevated severity or failed outcomes.
              </div>

              <div
                style={{
                  display: "grid",
                  gap: 12,
                  marginTop: 18,
                }}
              >
                <div
                  style={{
                    ...dashboardStyles.softCard,
                    padding: 16,
                    borderRadius: 20,
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    border: "1px solid rgba(79,112,107,0.10)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#21353a",
                    }}
                  >
                    What you can check here
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 8,
                      marginTop: 12,
                      fontSize: 13,
                      color: "#67777c",
                      lineHeight: 1.7,
                    }}
                  >
                    <div>• action names and categories</div>
                    <div>• outcome and severity markers</div>
                    <div>• linked request, resource, and user identifiers</div>
                    <div>• raw metadata for deeper investigation</div>
                  </div>
                </div>

                <div
                  style={{
                    ...dashboardStyles.softCard,
                    padding: 16,
                    borderRadius: 20,
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    border: "1px solid rgba(79,112,107,0.10)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ ...statPillBase, ...severityTone("low") }}>Low / Info</span>
                    <span style={{ ...statPillBase, ...severityTone("medium") }}>Medium</span>
                    <span style={{ ...statPillBase, ...severityTone("high") }}>High</span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      marginTop: 10,
                    }}
                  >
                    <span style={{ ...statPillBase, ...outcomeTone("success") }}>Success</span>
                    <span style={{ ...statPillBase, ...outcomeTone("warning") }}>Warning</span>
                    <span style={{ ...statPillBase, ...outcomeTone("failed") }}>Failed</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>

        <Card className="audit-card" style={dashboardStyles.outerCard}>
          <div className="absolute inset-0">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="h-full w-full object-cover object-center"
            />
          </div>
          <div className="audit-card-overlay" />
          <div className="audit-card-shine" />

          <div className="audit-card-inner">
            <div className="audit-section-title">Recent Admin Actions</div>
            <div className="audit-section-copy">
              Latest audit rows with expandable metadata, consistent status badges, and
              quick visual scanning for important events.
            </div>

            {loading ? (
              <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                <Skeleton width="100%" height="120px" />
                <Skeleton width="100%" height="120px" />
                <Skeleton width="100%" height="120px" />
              </div>
            ) : items.length === 0 ? (
              <div style={{ color: "#6f7f84", marginTop: 18 }}>No audit entries found.</div>
            ) : (
              <div className="audit-row-list">
                {items.map((entry) => (
                  <div key={entry.id} className="audit-row-card">
                    <div className="audit-row-top">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="audit-row-title">{entry.action}</div>

                        <div className="audit-pills">
                          <span style={{ ...statPillBase, ...severityTone(entry.severity) }}>
                            {entry.severity ?? "info"}
                          </span>
                          <span style={{ ...statPillBase, ...outcomeTone(entry.outcome) }}>
                            {entry.outcome ?? "success"}
                          </span>
                          <span
                            style={{
                              ...statPillBase,
                              border: "1px solid rgba(79,112,107,0.12)",
                              background:
                                "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
                              color: "#4d6165",
                            }}
                          >
                            {entry.category ?? "uncategorized"}
                          </span>
                        </div>

                        <div className="audit-meta-lines">
                          <div className="audit-meta-line">
                            user: {entry.userId ?? "public/system"} · ip:{" "}
                            {entry.ipAddress ?? "—"}
                          </div>
                          <div className="audit-meta-line">
                            request: {entry.requestId ?? "—"} · resource:{" "}
                            {entry.resourceType ?? "—"} · id: {entry.resourceId ?? "—"}
                          </div>
                          <div className="audit-meta-line">
                            source: {entry.source ?? "—"} · public:{" "}
                            {entry.isPublic ? "yes" : "no"} · anchored:{" "}
                            {entry.anchoredAt ? formatTimestamp(entry.anchoredAt) : "—"}
                          </div>
                        </div>

                        <div className="audit-preview-box">
                          <div className="audit-preview-text">
                            {isExpanded(entry.id)
                              ? "Full metadata shown below."
                              : metadataPreview(entry.metadata)}
                          </div>

                          <div style={{ marginTop: 10 }}>
                            <Button
                              type="button"
                              className="rounded-[999px] border px-4 py-2 text-[0.8rem] font-semibold"
                              style={dashboardStyles.secondaryButton}
                              onClick={() => toggleExpanded(entry.id)}
                            >
                              {isExpanded(entry.id) ? "Hide metadata" : "Show metadata"}
                            </Button>
                          </div>

                          {isExpanded(entry.id) ? (
                            <pre className="audit-pre">{prettyMetadataJson(entry.metadata)}</pre>
                          ) : null}
                        </div>
                      </div>

                      <div className="audit-row-time">{formatTimestamp(entry.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </DashboardShell>
  );
}