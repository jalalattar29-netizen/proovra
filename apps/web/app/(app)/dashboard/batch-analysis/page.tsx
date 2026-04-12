"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import {
  useToast,
  Skeleton,
  EmptyState,
  Card,
  Button,
} from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import {
  dashboardStyles,
  getStatusPillStyle,
} from "../../../../components/dashboard/styles";

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

export default function BatchAnalysisPage() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewJobForm, setShowNewJobForm] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [jobName, setJobName] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  useEffect(() => {
    void loadJobs();

    const interval = window.setInterval(() => {
      void loadJobs();
    }, 4000);

    return () => window.clearInterval(interval);
  }, [user?.id]);

  const loadJobs = async () => {
    try {
      const data = await apiFetch("/v1/batch-analysis");
      setJobs(Array.isArray(data?.data) ? data.data : []);
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
        err instanceof Error ? err.message : "Failed to create batch job";
      addToast(message, "error");
    }
  };

  const handleCancelJob = async (jobId: string) => {
    if (!window.confirm("Cancel this batch job?")) return;

    try {
      await apiFetch(`/v1/batch-analysis/${jobId}/cancel`, {
        method: "POST",
      });

      await loadJobs();
      addToast("Batch job cancelled", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to cancel batch job";
      addToast(message, "error");
    }
  };

  const handleExportResults = async (jobId: string) => {
    try {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("proovra-token")
          : null;

      if (!token) {
        throw new Error("Missing session token");
      }

      const apiBase = process.env.NEXT_PUBLIC_API_BASE || "https://api.proovra.com";

      const response = await fetch(`${apiBase}/v1/batch-analysis/${jobId}/export`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
        err instanceof Error ? err.message : "Failed to export results";
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
          onClick={() => setShowNewJobForm((prev) => !prev)}
          className="dashboard-batch-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
          style={dashboardStyles.primaryButton}
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
          color: #d8e0dd;
          margin: 0;
          line-height: 1.35;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-batch-page .dashboard-batch-job-date {
          font-size: 12px;
          color: rgba(194, 204, 201, 0.56);
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
          border-top: 1px solid rgba(255, 255, 255, 0.08);
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

        .dashboard-batch-page .dashboard-batch-field {
          width: 100%;
          min-width: 0;
          min-height: 52px;
          padding: 0 16px;
          border-radius: 18px;
          font-size: 15px;
          line-height: 1.2;
          background: linear-gradient(
            180deg,
            rgba(20, 39, 42, 0.94) 0%,
            rgba(13, 27, 30, 0.98) 100%
          );
          border: 1px solid rgba(232, 236, 233, 0.16);
          color: #d8e0dd;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.06),
            inset 0 0 0 1px rgba(244, 245, 242, 0.02),
            0 10px 22px rgba(0, 0, 0, 0.14),
            0 0 0 1px rgba(236, 238, 234, 0.03);
          outline: none;
          transition:
            border-color 220ms ease,
            box-shadow 220ms ease,
            background-color 220ms ease;
        }

        .dashboard-batch-page .dashboard-batch-field::placeholder {
          color: rgba(194, 204, 201, 0.52);
        }

        .dashboard-batch-page .dashboard-batch-field:focus {
          border-color: rgba(236, 238, 234, 0.24);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            inset 0 0 20px rgba(236, 238, 234, 0.05),
            0 0 0 3px rgba(236, 238, 234, 0.08),
            0 12px 24px rgba(0, 0, 0, 0.14);
        }

        .dashboard-batch-page textarea.dashboard-batch-field {
          min-height: 120px;
          padding: 14px 16px;
          resize: vertical;
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
          color: rgba(194, 204, 201, 0.56);
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
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={dashboardStyles.outerCard}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
            <div className="relative z-10 p-6 md:p-7">
              <form onSubmit={handleCreateJob} className="dashboard-batch-form-grid">
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "rgba(194,204,201,0.72)",
                    }}
                  >
                    Batch Name
                  </label>
                  <input
                    type="text"
                    value={jobName}
                    onChange={(e) => setJobName(e.target.value)}
                    placeholder="e.g., Q1 2026 Review"
                    className="dashboard-batch-field"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "rgba(194,204,201,0.72)",
                    }}
                  >
                    Description (optional)
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Add notes about this batch"
                    rows={2}
                    className="dashboard-batch-field"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "rgba(194,204,201,0.72)",
                    }}
                  >
                    Evidence IDs (one per line)
                  </label>
                  <textarea
                    value={evidenceIds}
                    onChange={(e) => setEvidenceIds(e.target.value)}
                    placeholder={"e.g.\nabc-123\ndef-456\nghi-789"}
                    rows={6}
                    className="dashboard-batch-field dashboard-batch-mono"
                  />
                </div>

                <div className="dashboard-batch-form-actions">
                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dashboardStyles.primaryButton}
                  >
                    Create & Start Batch
                  </Button>

                  <Button
                    type="button"
                    onClick={() => setShowNewJobForm(false)}
                    variant="secondary"
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dashboardStyles.secondaryButton}
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
              color: "#d8e0dd",
            },
            {
              label: "Active Jobs",
              value: pendingJobs,
              sub: "Pending or processing",
              color: "#bfe8df",
            },
          ].map((item) => (
            <Card
              key={item.label}
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={dashboardStyles.outerCard}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="relative z-10 p-6">
                <div style={{ fontSize: 13, color: "rgba(194,204,201,0.64)" }}>
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
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={dashboardStyles.outerCard}
            >
              <div className="relative z-10 p-6">
                <Skeleton width="100%" height="200px" />
              </div>
            </Card>
          </div>
        ) : jobs.length === 0 ? (
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={dashboardStyles.outerCard}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
            <div className="relative z-10 p-6">
              <EmptyState
                title="No Batch Jobs"
                subtitle="Create your first batch job to analyze multiple evidence items"
                action={() => setShowNewJobForm(true)}
                actionLabel="Create Batch Job"
              />
            </div>
          </Card>
        ) : (
          <div className="dashboard-batch-job-list">
            {jobs.map((job) => (
              <Card
                key={job.id}
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={dashboardStyles.outerCard}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/site-velvet-bg.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center scale-[1.12]"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

                <div className="relative z-10 p-6 md:p-7">
                  <div className="dashboard-batch-job-card-inner">
                    <div className="dashboard-batch-job-header">
                      <div className="dashboard-batch-job-header-main">
                        <h3 className="dashboard-batch-job-title">{job.name}</h3>
                        <p className="dashboard-batch-job-date">
                          {new Date(job.createdAt).toLocaleString()}
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
                        {job.status}
                      </span>
                    </div>

                    <div>
                      <div className="dashboard-batch-progress-row">
                        <span style={{ color: "rgba(194,204,201,0.72)" }}>Progress</span>
                        <span style={{ color: "#d8e0dd", fontWeight: 600 }}>
                          {job.processedItems + job.failedItems} / {job.totalItems}
                        </span>
                      </div>

                      <div style={dashboardStyles.progressTrack}>
                        <div
                          style={{
                            width: `${job.progress}%`,
                            height: "100%",
                            background: "linear-gradient(90deg,#3f6664,#8dc7bc)",
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
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                          Processed
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "#9fdfb2",
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
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                          Failed
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "#e4a3a3",
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
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                          Pending
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: "#d8e0dd",
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
                          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                        >
                          Export CSV
                        </Button>
                      )}

                      {["pending", "processing"].includes(job.status) && (
                        <Button
                          onClick={() => handleCancelJob(job.id)}
                          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={dashboardStyles.dangerButton}
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