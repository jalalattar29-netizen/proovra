"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";

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
  const { user, token } = useAuth();
  const { addToast } = useToast();
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewJobForm, setShowNewJobForm] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [jobName, setJobName] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 2000);
    return () => clearInterval(interval);
  }, [user]);

  const loadJobs = async () => {
    try {
      const data = await apiFetch("/v1/batch-analysis");
      setJobs(data.data || []);
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
          name: jobName,
          description: jobDescription || undefined,
        }),
      });

      if (data.data?.id) {
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
      const message = err instanceof Error ? err.message : "Failed to create batch job";
      addToast(message, "error");
    }
  };

  const handleCancelJob = async (jobId: string) => {
    if (!confirm("Cancel this batch job?")) return;

    try {
      await apiFetch(`/v1/batch-analysis/${jobId}/cancel`, {
        method: "POST",
      });
      await loadJobs();
      addToast("Batch job cancelled", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel batch job";
      addToast(message, "error");
    }
  };

  const handleExportResults = async (jobId: string) => {
    try {
      const response = await fetch(
        `/api/v1/batch-analysis/${jobId}/export`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
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
      const message = err instanceof Error ? err.message : "Failed to export results";
      addToast(message, "error");
    }
  };

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "completed":
        return {
          background: "rgba(34,197,94,0.14)",
          color: "#86efac",
        };
      case "processing":
        return {
          background: "rgba(59,130,246,0.14)",
          color: "#93c5fd",
        };
      case "failed":
        return {
          background: "rgba(239,68,68,0.14)",
          color: "#fca5a5",
        };
      case "cancelled":
        return {
          background: "rgba(148,163,184,0.14)",
          color: "#cbd5e1",
        };
      default:
        return {
          background: "rgba(148,163,184,0.14)",
          color: "#cbd5e1",
        };
    }
  };

  if (loading && jobs.length === 0) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Batch Analysis
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Loading batch processing jobs...
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="60px" />
            <Skeleton width="100%" height="200px" />
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
                Batch Analysis
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Analyze multiple evidence items at once.
              </p>
            </div>
            <Button onClick={() => setShowNewJobForm(!showNewJobForm)}>
              + New Batch Job
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {showNewJobForm && (
            <Card className="app-card">
              <form onSubmit={handleCreateJob} style={{ display: "grid", gap: 14 }}>
                <div>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(219,235,248,0.72)" }}>
                    Batch Name
                  </label>
                  <input
                    type="text"
                    value={jobName}
                    onChange={(e) => setJobName(e.target.value)}
                    placeholder="e.g., Q1 2025 Review"
                    className="input"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(219,235,248,0.72)" }}>
                    Description (optional)
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Add notes about this batch"
                    rows={2}
                    className="input"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(219,235,248,0.72)" }}>
                    Evidence IDs (one per line)
                  </label>
                  <textarea
                    value={evidenceIds}
                    onChange={(e) => setEvidenceIds(e.target.value)}
                    placeholder={"e.g.\nabc-123\ndef-456\nghi-789"}
                    rows={6}
                    className="input"
                    style={{ fontFamily: "monospace", fontSize: 13 }}
                  />
                  <p style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 6 }}>
                    Enter one evidence ID per line
                  </p>
                </div>

                <div style={{ display: "flex", gap: 10 }}>
                  <Button className="flex-1">Create & Start Batch</Button>
                  <Button
                    onClick={() => setShowNewJobForm(false)}
                    variant="secondary"
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {jobs.length === 0 ? (
            <EmptyState
              title="No Batch Jobs"
              subtitle="Create your first batch job to analyze multiple evidence items"
              action={() => <Button onClick={() => setShowNewJobForm(true)}>Create Batch Job</Button>}
            />
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {jobs.map((job) => (
                <Card key={job.id} className="app-card">
                  <div style={{ display: "grid", gap: 16 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
                      <div>
                        <h3 style={{ fontSize: 18, fontWeight: 700, color: "rgba(246,252,255,0.96)", margin: 0 }}>
                          {job.name}
                        </h3>
                        <p style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 6, marginBottom: 0 }}>
                          {new Date(job.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span
                        style={{
                          ...getStatusStyle(job.status),
                          padding: "8px 12px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                          textTransform: "capitalize",
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {job.status}
                      </span>
                    </div>

                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginBottom: 8 }}>
                        <span style={{ color: "rgba(219,235,248,0.72)" }}>Progress</span>
                        <span style={{ color: "rgba(246,252,255,0.96)", fontWeight: 600 }}>
                          {job.processedItems + job.failedItems} / {job.totalItems}
                        </span>
                      </div>
                      <div
                        style={{
                          width: "100%",
                          height: 9,
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.08)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${job.progress}%`,
                            height: "100%",
                            background: "linear-gradient(90deg,#2f686d,#78bfc1)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: 14,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Processed</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#86efac", marginTop: 4 }}>
                          {job.processedItems}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Failed</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#fca5a5", marginTop: 4 }}>
                          {job.failedItems}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Pending</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "rgba(246,252,255,0.96)", marginTop: 4 }}>
                          {job.totalItems - job.processedItems - job.failedItems}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        paddingTop: 12,
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        flexWrap: "wrap",
                      }}
                    >
                      <Button
                        onClick={() => {
                          /* Load details */
                        }}
                        className="flex-1"
                      >
                        View Details
                      </Button>

                      {job.status === "completed" && (
                        <Button
                          onClick={() => handleExportResults(job.id)}
                          variant="secondary"
                          className="flex-1"
                        >
                          Export CSV
                        </Button>
                      )}

                      {["pending", "processing"].includes(job.status) && (
                        <Button
                          onClick={() => handleCancelJob(job.id)}
                          className="flex-1"
                          style={{
                            background: "linear-gradient(180deg,#991b1b 0%,#7f1d1d 100%)",
                            border: "1px solid rgba(248,113,113,0.22)",
                            color: "#fff",
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <Card
            className="app-card"
            style={{
              border: "1px solid rgba(158,216,207,0.16)",
              background:
                "linear-gradient(135deg, rgba(158,216,207,0.08), rgba(214,184,157,0.06))",
            }}
          >
            <div className="app-card-title">How Batch Analysis Works</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10, color: "rgba(219,235,248,0.78)" }}>
              <li>Create a batch job and provide evidence IDs</li>
              <li>The system will analyze each item sequentially</li>
              <li>Results are aggregated with statistics and insights</li>
              <li>Export results as CSV for further analysis</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}