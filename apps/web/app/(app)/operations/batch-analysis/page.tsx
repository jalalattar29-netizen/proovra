"use client";
import { identifierLabel } from "@proovra/shared";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useToast, Skeleton } from "../../../../components/ui";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import {
  dashboardStyles,
  getStatusPillStyle,
} from "../../../../components/dashboard/styles";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { SurfaceGate } from "../../../../components/surface/SurfaceGate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

interface BatchJob {
  id: string;
  name: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  totalItems: number;
  processedItems: number;
  failedItems: number;
  createdAt: string;
  completedAt?: string;
  progress: number;
}

// Phase 38.14 — wrap in canonical PageRouteGate.
// F-21 — and in the surface gate: this page's PROFESSIONAL tier rule was keyed
// to the retired /dashboard/batch-analysis URL, so a Free account loaded it.
export default function BatchAnalysisPage() {
  return (
    <SurfaceGate>
      <PageRouteGate routeId="dashboard.batch_analysis">
        <BatchAnalysisPageInner />
      </PageRouteGate>
    </SurfaceGate>
  );
}

/** F-21 — poll cadence while a job is running; none once every job has settled. */
const BATCH_POLL_INTERVAL_MS = 4_000;

function BatchAnalysisPageInner() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNewJobForm, setShowNewJobForm] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [jobName, setJobName] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  /*
   * F-21 — POLL ONLY WHILE SOMETHING CAN CHANGE, AND ONLY WHILE VISIBLE.
   *
   * This polled every 4 s for as long as the page was mounted — hidden tab or
   * not, and with every job long finished — and each poll is an audited list
   * read. A settled list changes only when the person acts here (create,
   * process, cancel), and each of those reloads the list itself.
   */
  const hasActiveJobs = jobs.some((j) => j.status === "pending" || j.status === "processing");

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void loadJobs();
    }, BATCH_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadJobs();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveJobs, user?.id]);

  const loadJobs = async () => {
    try {
      const data = await apiFetch("/v1/batch-analysis");
      setJobs(Array.isArray(data?.data) ? data.data : []);
      setTruncated(data?.truncated === true);
    } catch (err) {
      console.debug("Failed to load jobs", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!jobName.trim() || !evidenceIds.trim()) {
      addToast("Please fill in all required fields", "error");
      return;
    }

    const ids = evidenceIds
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      addToast("Please enter at least one evidence ID", "error");
      return;
    }

    try {
      const data = await apiFetch("/v1/batch-analysis", {
        method: "POST",
        body: JSON.stringify({
          evidenceIds: ids,
          name: jobName.trim(),
          description: jobDescription.trim() || undefined,
        }),
      });

      if (data?.data?.id) {
        await apiFetch(`/v1/batch-analysis/${data.data.id}/process`, {
          method: "POST",
        });

        setJobName("");
        setEvidenceIds("");
        setJobDescription("");
        setShowNewJobForm(false);

        await loadJobs();
        addToast("Batch job created and processing started", "success");
      }
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to create batch job" }).message;
      addToast(message, "error");
    }
  };

  const handleCancelJob = async (jobId: string) => {
    const ok = await confirm({
      title: "Cancel this batch job?",
      description:
        "In-progress items will stop. Already completed items keep their results.",
      confirmLabel: "Cancel job",
      cancelLabel: "Keep running",
      tone: "warning",
      testId: "batch-cancel",
    });
    if (!ok) return;

    try {
      await apiFetch(`/v1/batch-analysis/${jobId}/cancel`, {
        method: "POST",
      });

      await loadJobs();
      addToast("Batch job cancelled", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to cancel batch job" }).message;
      addToast(message, "error");
    }
  };

  const handleExportResults = async (jobId: string) => {
    try {
      // AUDIT-003 (2026-08-15): this re-derived the API origin inline, which
      // duplicated the production default and meant changing it required
      // finding every copy. It now reads the ONE authority in lib/api.
      const { apiBaseUrl } = await import("../../../../lib/api");
      const apiBase = apiBaseUrl();

      // Authentication carried by the HttpOnly `proovra_session` cookie.
      // The in-memory token (if present, e.g. immediately after OAuth) is
      // attached as a defensive fallback for callers without cookies.
      const { readApiToken } = await import("../../../../lib/api");
      const memToken = readApiToken();
      const headers: Record<string, string> = { "x-web-client": "1" };
      if (memToken) headers["Authorization"] = `Bearer ${memToken}`;

      const response = await fetch(`${apiBase}/v1/batch-analysis/${jobId}/export`, {
        headers,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Export failed");
      }

      const csv = await response.text();
      const blob = new Blob([csv], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = `batch-${jobId}.csv`;
      a.click();

      window.URL.revokeObjectURL(url);
      addToast("Results exported successfully", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to export results" }).message;
      addToast(message, "error");
    }
  };

  const pendingJobs = useMemo(
    () => jobs.filter((job) => ["pending", "processing"].includes(job.status)).length,
    [jobs]
  );

  return (
    <DashboardShell
      eyebrow="Batch Analysis"
      title="Analyze multiple evidence items"
      highlight="at once."
      description={
        <>
          Create batch jobs, monitor progress, review outcomes, and export result
          sets for larger evidence workloads.
        </>
      }
      action={
        <Button
          variant="primary"
          onClick={() => setShowNewJobForm((prev) => !prev)}
          className="dashboard-batch-responsive-btn"
        >
          + New Batch Job
        </Button>
      }
    >
      <style jsx global>{`
        .dashboard-batch-page {
          display: grid;
          gap: 16px;
        }

        .dashboard-batch-page .dashboard-batch-metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }

        .dashboard-batch-page .dashboard-batch-job-list {
          display: grid;
          gap: 16px;
        }

        .dashboard-batch-page .dashboard-batch-job-card-inner {
          display: grid;
          gap: 16px;
          min-width: 0;
        }

        .dashboard-batch-page .dashboard-batch-job-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
        }

        .dashboard-batch-page .dashboard-batch-job-header-main {
          min-width: 0;
          flex: 1 1 320px;
        }

        .dashboard-batch-page .dashboard-batch-job-title {
          font-size: 18px;
          font-weight: 700;
          color: var(--app-ink-heading);
          margin: 0;
          line-height: 1.35;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-batch-page .dashboard-batch-job-date {
          font-size: 12px;
          color: var(--app-ink-secondary);
          margin-top: 6px;
          margin-bottom: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-batch-page .dashboard-batch-job-status {
          flex-shrink: 0;
          max-width: 100%;
          white-space: normal;
          text-align: center;
          line-height: 1.35;
        }

        .dashboard-batch-page .dashboard-batch-progress-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          font-size: 13px;
          margin-bottom: 8px;
        }

        .dashboard-batch-page .dashboard-batch-progress-row span {
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-batch-page .dashboard-batch-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 14px;
        }

        .dashboard-batch-page .dashboard-batch-actions-row {
          display: flex;
          gap: 10px;
          padding-top: 12px;
          border-top: 1px solid var(--border-default);
          flex-wrap: wrap;
        }

        .dashboard-batch-page .dashboard-batch-form-grid {
          display: grid;
          gap: 14px;
          min-width: 0;
        }

        .dashboard-batch-page .dashboard-batch-form-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .dashboard-batch-page .dashboard-batch-form-actions > * {
          flex: 1 1 220px;
        }

        .dashboard-batch-page .dashboard-batch-mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 13px;
        }

        .dashboard-batch-page .dashboard-batch-card-metric-value {
          font-size: 34px;
          font-weight: 800;
          margin-top: 8px;
          line-height: 1;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-batch-page .dashboard-batch-card-metric-sub {
          font-size: 12px;
          color: var(--app-ink-secondary);
          margin-top: 8px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        @media (max-width: 760px) {
          .dashboard-batch-page .dashboard-batch-form-actions {
            flex-direction: column;
          }

          .dashboard-batch-page .dashboard-batch-form-actions > * {
            width: 100%;
            flex: 1 1 100%;
          }

          .dashboard-batch-page .dashboard-batch-actions-row {
            flex-direction: column;
            align-items: stretch;
          }

          .dashboard-batch-page .dashboard-batch-actions-row > * {
            width: 100%;
          }

          .dashboard-batch-page .dashboard-batch-job-header {
            flex-direction: column;
            align-items: stretch;
          }

          .dashboard-batch-page .dashboard-batch-job-status {
            align-self: flex-start;
          }

          .dashboard-batch-page .dashboard-batch-responsive-btn {
            width: 100%;
            min-width: 0;
          }
        }
      `}</style>

      <div className="dashboard-batch-page">
        {showNewJobForm && (
          <Card
            padding="none"
          >
            <div className="p-6 md:p-7">
              <form onSubmit={handleCreateJob} className="dashboard-batch-form-grid">
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "var(--app-ink-secondary)",
                    }}
                  >
                    Batch Name
                  </label>
                  <input
                    type="text"
                    value={jobName}
                    onChange={(e) => setJobName(e.target.value)}
                    placeholder="e.g., Q1 2026 Review"
                    className="app-form-input"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "var(--app-ink-secondary)",
                    }}
                  >
                    Description (optional)
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Add notes about this batch"
                    rows={2}
                    className="app-form-input"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "var(--app-ink-secondary)",
                    }}
                  >
                    Evidence IDs (one per line)
                  </label>
                  <textarea
                    value={evidenceIds}
                    onChange={(e) => setEvidenceIds(e.target.value)}
                    placeholder={"e.g.\nabc-123\ndef-456\nghi-789"}
                    rows={6}
                    className="app-form-input dashboard-batch-mono"
                  />
                </div>

                <div className="dashboard-batch-form-actions">
                  <Button type="submit" variant="primary">
                    Create & Start Batch
                  </Button>

                  <Button
                    type="button"
                    onClick={() => setShowNewJobForm(false)}
                    variant="secondary"
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </Card>
        )}

        <div className="dashboard-batch-metrics-grid">
          {[
            {
              label: "Total Jobs",
              value: jobs.length,
              sub: "All batch jobs",
              color: "var(--app-ink-heading)",
            },
            {
              label: "Active Jobs",
              value: pendingJobs,
              sub: "Pending or processing",
              color: "var(--app-ink-heading)",
            },
          ].map((item) => (
            <Card
              key={item.label}
              padding="none"
            >
              <div className="p-6">
                <div style={{ fontSize: 13, color: "var(--app-ink-secondary)" }}>
                  {item.label}
                </div>
                <div
                  className="dashboard-batch-card-metric-value"
                  style={{ color: item.color }}
                >
                  {item.value}
                </div>
                <div className="dashboard-batch-card-metric-sub">{item.sub}</div>
              </div>
            </Card>
          ))}
        </div>

        {loading && jobs.length === 0 ? (
          <div style={{ display: "grid", gap: 16 }}>
            <Card
              padding="none"
            >
              <div className="p-6">
                <Skeleton width="100%" height="200px" />
              </div>
            </Card>
          </div>
        ) : jobs.length === 0 ? (
          <Card
            padding="none"
          >
            <div className="p-6">
              <EmptyState
                title="No Batch Jobs"
                purpose="Create your first batch job to analyze multiple evidence items."
                action={
                  <Button variant="primary" onClick={() => setShowNewJobForm(true)}>
                    Create Batch Job
                  </Button>
                }
              />
            </div>
          </Card>
        ) : (
          <div className="dashboard-batch-job-list">
            {truncated ? (
              <p className="text-sm" data-batch-list-truncated>
                Showing your {jobs.length} most recent jobs.
              </p>
            ) : null}
            {jobs.map((job) => (
              <Card
                key={job.id}
                padding="none"
              >
                <div className="p-6 md:p-7">
                  <div className="dashboard-batch-job-card-inner">
                    <div className="dashboard-batch-job-header">
                      <div className="dashboard-batch-job-header-main">
                        <h3 className="dashboard-batch-job-title">{job.name}</h3>
                        <p className="dashboard-batch-job-date">
                          {formatUserDateTime(job.createdAt)}
                        </p>
                      </div>

                      <span
                        className="dashboard-batch-job-status"
                        style={{
                          ...getStatusPillStyle(job.status),
                          padding: "8px 12px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                          textTransform: "capitalize",
                        }}
                      >
                        {identifierLabel(job.status)}
                      </span>
                    </div>

                    <div>
                      <div className="dashboard-batch-progress-row">
                        <span style={{ color: "var(--app-ink-secondary)" }}>Progress</span>
                        <span style={{ color: "var(--app-ink-heading)", fontWeight: 600 }}>
                          {job.processedItems + job.failedItems} / {job.totalItems}
                        </span>
                      </div>

                      <div style={dashboardStyles.progressTrack}>
                        <div
                          style={{
                            width: `${job.progress}%`,
                            height: "100%",
                            background: "var(--accent-500)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>

                    <div className="dashboard-batch-stats-grid">
                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 14,
                          borderRadius: 16,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}>
                          Processed
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "var(--success-ink)",
                            marginTop: 4,
                          }}
                        >
                          {job.processedItems}
                        </div>
                      </div>

                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 14,
                          borderRadius: 16,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}>
                          Failed
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "var(--error)",
                            marginTop: 4,
                          }}
                        >
                          {job.failedItems}
                        </div>
                      </div>

                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 14,
                          borderRadius: 16,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}>
                          Pending
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "var(--app-ink-heading)",
                            marginTop: 4,
                          }}
                        >
                          {Math.max(
                            0,
                            job.totalItems - job.processedItems - job.failedItems
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="dashboard-batch-actions-row">
                      {job.status === "completed" && (
                        <Button
                          onClick={() => handleExportResults(job.id)}
                          variant="secondary"
                        >
                          Export CSV
                        </Button>
                      )}

                      {["pending", "processing"].includes(job.status) && (
                        <Button
                          onClick={() => handleCancelJob(job.id)}
                          variant="destructive"
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardShell>
  );
}