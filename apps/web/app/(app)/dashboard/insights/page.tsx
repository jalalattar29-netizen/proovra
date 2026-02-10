"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";
import Link from "next/link";

interface Insights {
  total_analyzed: number;
  total_evidence: number;
  classification_distribution: Record<string, number>;
  moderation_distribution: Record<string, number>;
  top_tags: Array<{ tag: string; count: number }>;
  api_usage: {
    total_calls: number;
    total_cost_usd: string;
    average_cost_per_call: string;
  };
  recent_analyses: Array<{
    id: string;
    evidenceId: string;
    classification: string;
    riskLevel: string;
    createdAt: string;
  }>;
}

export default function InsightsPage() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchInsights = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await apiFetch("/v1/insights");
        setInsights(data.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load insights";
        setError(message);
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchInsights();
    }
  }, [user, addToast]);

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton width="100%" height="200px" />
        <Skeleton width="100%" height="200px" />
        <Skeleton width="100%" height="200px" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="Error Loading Insights"
        subtitle={error}
        action={() => window.location.reload()}
      />
    );
  }

  if (!insights) {
    return (
      <EmptyState
        title="No Insights Yet"
        subtitle="Start analyzing your evidence to see insights and AI-powered analytics."
        action={() => (
          <Link href="/dashboard">
            <Button>Go to Dashboard</Button>
          </Link>
        )}
      />
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">AI Insights</h1>
        <p className="text-gray-600 mt-2">
          Analytics and insights powered by AI analysis
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Analyzed Evidence */}
        <Card className="p-6">
          <div className="text-gray-600 text-sm font-medium">Analyzed Evidence</div>
          <div className="text-3xl font-bold mt-2">{insights.total_analyzed}</div>
          <div className="text-gray-500 text-xs mt-2">
            {insights.total_evidence > 0
              ? ((insights.total_analyzed / insights.total_evidence) * 100).toFixed(0)
              : 0}
            % of total
          </div>
        </Card>

        {/* Total Evidence */}
        <Card className="p-6">
          <div className="text-gray-600 text-sm font-medium">Total Evidence</div>
          <div className="text-3xl font-bold mt-2">{insights.total_evidence}</div>
          <div className="text-gray-500 text-xs mt-2">Items stored</div>
        </Card>

        {/* API Calls */}
        <Card className="p-6">
          <div className="text-gray-600 text-sm font-medium">API Calls</div>
          <div className="text-3xl font-bold mt-2">{insights.api_usage.total_calls}</div>
          <div className="text-gray-500 text-xs mt-2">Total analyses</div>
        </Card>

        {/* Cost */}
        <Card className="p-6">
          <div className="text-gray-600 text-sm font-medium">AI Cost</div>
          <div className="text-3xl font-bold mt-2">
            ${insights.api_usage.total_cost_usd}
          </div>
          <div className="text-gray-500 text-xs mt-2">
            Avg: ${insights.api_usage.average_cost_per_call}/call
          </div>
        </Card>
      </div>

      {/* Classification Distribution */}
      {Object.keys(insights.classification_distribution).length > 0 && (
        <Card className="p-6">
          <h2 className="text-xl font-bold mb-4">Classification Distribution</h2>
          <div className="space-y-3">
            {Object.entries(insights.classification_distribution)
              .sort(([, a], [, b]) => b - a)
              .map(([category, count]) => (
                <div key={category} className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="text-sm font-medium capitalize">{category}</div>
                    <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                      <div
                        className="bg-blue-600 h-2 rounded-full"
                        style={{
                          width: `${(count / insights.total_analyzed) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-sm font-bold ml-4">{count}</div>
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* Moderation Summary */}
      {Object.keys(insights.moderation_distribution).length > 0 && (
        <Card className="p-6">
          <h2 className="text-xl font-bold mb-4">Content Safety Distribution</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(insights.moderation_distribution)
              .sort(([, a], [, b]) => b - a)
              .map(([risk, count]) => (
                <div key={risk} className="text-center">
                  <div
                    className={`text-3xl font-bold ${
                      risk === "safe"
                        ? "text-green-600"
                        : risk === "low_risk"
                        ? "text-yellow-600"
                        : risk === "medium_risk"
                        ? "text-orange-600"
                        : "text-red-600"
                    }`}
                  >
                    {count}
                  </div>
                  <div className="text-sm text-gray-600 mt-2 capitalize">
                    {risk.replace(/_/g, " ")}
                  </div>
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* Top Tags */}
      {insights.top_tags.length > 0 && (
        <Card className="p-6">
          <h2 className="text-xl font-bold mb-4">Top Tags</h2>
          <div className="flex flex-wrap gap-2">
            {insights.top_tags.map(({ tag, count }) => (
              <div
                key={tag}
                className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium"
              >
                {tag}
                <span className="ml-2 bg-blue-800 text-white px-2 rounded-full text-xs font-bold">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recent Analyses */}
      {insights.recent_analyses.length > 0 && (
        <Card className="p-6">
          <h2 className="text-xl font-bold mb-4">Recent Analyses</h2>
          <div className="space-y-3">
            {insights.recent_analyses.map((analysis) => (
              <div
                key={analysis.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div>
                  <div className="text-sm font-medium">{analysis.classification}</div>
                  <div className="text-xs text-gray-500">
                    {new Date(analysis.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      analysis.riskLevel === "safe"
                        ? "bg-green-100 text-green-800"
                        : analysis.riskLevel === "low_risk"
                        ? "bg-yellow-100 text-yellow-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {analysis.riskLevel.replace(/_/g, " ")}
                  </span>
                  <Link href={`/dashboard/evidence/${analysis.evidenceId}`}>
                    <Button className="text-xs">View</Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
