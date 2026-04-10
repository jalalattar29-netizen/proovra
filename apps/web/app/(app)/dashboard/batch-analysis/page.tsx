"use client";

import { useEffect, useMemo, useState } from "react";
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const softCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.14)",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.22) 0%, rgba(14,30,34,0.34) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.18)",
        color: "#aebbb6",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,20,24,0.78) 0%, rgba(7,18,22,0.88) 100%), url('/images/site-velvet-bg.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 28px rgba(0,0,0,0.10)",
      }) as const,
    []
  );

  const dangerButtonStyle = useMemo(
    () =>
      ({
        background: "linear-gradient(180deg,#8f2b2b 0%,#6f1f1f 100%)",
        border: "1px solid rgba(248,113,113,0.22)",
        color: "#fff",
        boxShadow: "0 12px 24px rgba(60,12,12,0.22)",
      }) as const,
    []
  );

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "completed":
        return {
          background: "rgba(95,170,110,0.14)",
          color: "#9fdfb2",
        };
      case "processing":
        return {
          background: "rgba(120,191,193,0.14)",
          color: "#a7dde0",
        };
      case "failed":
        return {
          background: "rgba(157,80,80,0.14)",
          color: "#e4a3a3",
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
            <div style={{ maxWidth: 780 }}>
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
                Batch Analysis
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Multi-item analysis{" "}
                <span className="text-[#c3ebe2]">at scale</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Loading batch processing jobs...
              </p>
            </div>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="60px" />
            </div>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="200px" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
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
                Batch Analysis
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Analyze multiple evidence items{" "}
                <span className="text-[#c3ebe2]">at once</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Create batch jobs, monitor progress, review outcomes, and export result sets
                for larger evidence workloads.
              </p>
            </div>

            <Button
              onClick={() => setShowNewJobForm(!showNewJobForm)}
              className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
              style={primaryButtonStyle}
            >
              + New Batch Job
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          {showNewJobForm && (
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
                <form onSubmit={handleCreateJob} style={{ display: "grid", gap: 14 }}>
                  <div>
                    <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(194,204,201,0.72)" }}>
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
                    <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(194,204,201,0.72)" }}>
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
                    <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(194,204,201,0.72)" }}>
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
                    <p style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                      Enter one evidence ID per line
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <Button
                      className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Create & Start Batch
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setShowNewJobForm(false)}
                      variant="secondary"
                      className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={secondaryButtonStyle}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </div>
            </Card>
          )}

          {jobs.length === 0 ? (
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
              <div className="relative z-10 p-6">
                <EmptyState
                  title="No Batch Jobs"
                  subtitle="Create your first batch job to analyze multiple evidence items"
                  action={() => (
                    <Button
                      onClick={() => setShowNewJobForm(true)}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Create Batch Job
                    </Button>
                  )}
                />
              </div>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {jobs.map((job) => (
                <Card
                  key={job.id}
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
                    <div style={{ display: "grid", gap: 16 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
                        <div>
                          <h3 style={{ fontSize: 18, fontWeight: 700, color: "#d8e0dd", margin: 0 }}>
                            {job.name}
                          </h3>
                          <p style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6, marginBottom: 0 }}>
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
                          <span style={{ color: "rgba(194,204,201,0.72)" }}>Progress</span>
                          <span style={{ color: "#d8e0dd", fontWeight: 600 }}>
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
                              background: "linear-gradient(90deg,#3f6664,#8dc7bc)",
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
                        <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Processed</div>
                          <div style={{ fontSize: 24, fontWeight: 800, color: "#9fdfb2", marginTop: 4 }}>
                            {job.processedItems}
                          </div>
                        </div>
                        <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Failed</div>
                          <div style={{ fontSize: 24, fontWeight: 800, color: "#e4a3a3", marginTop: 4 }}>
                            {job.failedItems}
                          </div>
                        </div>
                        <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Pending</div>
                          <div style={{ fontSize: 24, fontWeight: 800, color: "#d8e0dd", marginTop: 4 }}>
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
                          className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={primaryButtonStyle}
                        >
                          View Details
                        </Button>

                        {job.status === "completed" && (
                          <Button
                            onClick={() => handleExportResults(job.id)}
                            variant="secondary"
                            className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={secondaryButtonStyle}
                          >
                            Export CSV
                          </Button>
                        )}

                        {["pending", "processing"].includes(job.status) && (
                          <Button
                            onClick={() => handleCancelJob(job.id)}
                            className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={dangerButtonStyle}
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
              <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                How Batch Analysis Works
              </div>
              <ul style={{ margin: "18px 0 0", paddingLeft: 18, display: "grid", gap: 10, color: "rgba(194,204,201,0.78)" }}>
                <li>Create a batch job and provide evidence IDs</li>
                <li>The system will analyze each item sequentially</li>
                <li>Results are aggregated with statistics and insights</li>
                <li>Export results as CSV for further analysis</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}