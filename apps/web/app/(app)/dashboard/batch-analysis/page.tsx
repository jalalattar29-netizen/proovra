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
    const interval = setInterval(loadJobs, 2000); // Refresh every 2 seconds
    return () => clearInterval(interval);
  }, [user]);

  const loadJobs = async () => {
    try {
      const data = await apiFetch("/v1/batch-analysis");
      setJobs(data.data || []);
    } catch (err) {
      // Silently fail for polling
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
        // Start processing immediately
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-600";
      case "processing":
        return "text-blue-600";
      case "failed":
        return "text-red-600";
      case "cancelled":
        return "text-gray-600";
      default:
        return "text-gray-600";
    }
  };

  const getStatusBg = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-100";
      case "processing":
        return "bg-blue-100";
      case "failed":
        return "bg-red-100";
      case "cancelled":
        return "bg-gray-100";
      default:
        return "bg-gray-100";
    }
  };

  if (loading && jobs.length === 0) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width="100%" height="60px" />
        <Skeleton width="100%" height="200px" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Batch Analysis</h1>
          <p className="text-gray-600 mt-2">Analyze multiple evidence items at once</p>
        </div>
        <Button onClick={() => setShowNewJobForm(!showNewJobForm)}>
          + New Batch Job
        </Button>
      </div>

      {/* New Job Form */}
      {showNewJobForm && (
        <Card className="p-6">
          <form onSubmit={handleCreateJob} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Batch Name
              </label>
              <input
                type="text"
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                placeholder="e.g., Q1 2025 Review"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description (optional)
              </label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Add notes about this batch"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Evidence IDs (one per line)
              </label>
              <textarea
                value={evidenceIds}
                onChange={(e) => setEvidenceIds(e.target.value)}
                placeholder="e.g.&#10;abc-123&#10;def-456&#10;ghi-789"
                rows={6}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Enter one evidence ID per line
              </p>
            </div>

            <div className="flex gap-2">
              <Button className="flex-1">
                Create & Start Batch
              </Button>
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

      {/* Jobs List */}
      {jobs.length === 0 ? (
        <EmptyState
          title="No Batch Jobs"
          subtitle="Create your first batch job to analyze multiple evidence items"
          action={() => <Button onClick={() => setShowNewJobForm(true)}>Create Batch Job</Button>}
        />
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <Card key={job.id} className="p-6">
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">{job.name}</h3>
                    <p className="text-sm text-gray-500">
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusBg(
                      job.status
                    )} ${getStatusColor(job.status)}`}
                  >
                    {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                  </span>
                </div>

                {/* Progress Bar */}
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-600">Progress</span>
                    <span className="font-medium">
                      {job.processedItems + job.failedItems} / {job.totalItems}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs text-gray-600">Processed</div>
                    <div className="text-lg font-bold text-green-600">
                      {job.processedItems}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600">Failed</div>
                    <div className="text-lg font-bold text-red-600">
                      {job.failedItems}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600">Pending</div>
                    <div className="text-lg font-bold text-gray-600">
                      {job.totalItems - job.processedItems - job.failedItems}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-2 border-t">
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
                      className="flex-1 bg-red-600 hover:bg-red-700"
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

      {/* Help Section */}
      <Card className="p-6 bg-blue-50 border border-blue-200">
        <h3 className="text-lg font-semibold mb-2">How Batch Analysis Works</h3>
        <ul className="text-sm space-y-2 list-disc list-inside">
          <li>Create a batch job and provide evidence IDs</li>
          <li>The system will analyze each item sequentially</li>
          <li>Results are aggregated with statistics and insights</li>
          <li>Export results as CSV for further analysis</li>
        </ul>
      </Card>
    </div>
  );
}
