"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { Skeleton, Card } from "../../../../components/ui";

interface Quotas {
  analyses: { limit: number; used: number; remaining: number; resetDate: string };
  batchJobs: { limit: number; used: number; remaining: number };
  apiKeys: { limit: number; used: number; remaining: number };
  teamMembers: { limit: number; used: number; remaining: number };
}

interface UsageStats {
  dailyAnalyses: { today: number; thisWeek: number; thisMonth: number };
  costBreakdown: { totalCost: number; thisMonth: number; averagePerAnalysis: number };
  topEvidenceTypes: Record<string, number>;
  activeApiKeys: number;
  activeBatches: number;
}

export default function QuotasPage() {
  const { user } = useAuth();
  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    try {
      const [quotasData, statsData] = await Promise.all([
        apiFetch("/v1/quotas"),
        apiFetch("/v1/usage-stats"),
      ]);
      setQuotas(quotasData.data);
      setStats(statsData.data);
    } catch (err) {
      console.error("Failed to load quota data", err);
    } finally {
      setLoading(false);
    }
  };

  const getUsagePercent = (used: number, limit: number) => {
    return Math.round((used / limit) * 100);
  };

  const getUsageColor = (percent: number) => {
    if (percent >= 90) return "bg-red-500";
    if (percent >= 70) return "bg-yellow-500";
    return "bg-green-500";
  };

  const QuotaBar = ({
    label,
    used,
    limit,
  }: {
    label: string;
    used: number;
    limit: number;
  }) => {
    const percent = getUsagePercent(used, limit);
    return (
      <div>
        <div className="flex justify-between text-sm mb-2">
          <span className="text-gray-700 font-medium">{label}</span>
          <span className="text-gray-600">
            {used} / {limit}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${getUsageColor(percent)}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="text-xs text-gray-500 mt-1">{percent}% used</div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width="100%" height="300px" />
        <Skeleton width="100%" height="300px" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Usage & Quotas</h1>
        <p className="text-gray-600 mt-2">Monitor your API usage and quota limits</p>
      </div>

      {/* Usage Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Daily Usage */}
          <Card className="p-6">
            <h3 className="text-lg font-bold mb-4">Daily Usage</h3>
            <div className="space-y-4">
              <div>
                <div className="text-sm text-gray-600">Today</div>
                <div className="text-3xl font-bold text-blue-600">
                  {stats.dailyAnalyses.today}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">This Week</div>
                <div className="text-3xl font-bold text-blue-600">
                  {stats.dailyAnalyses.thisWeek}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">This Month</div>
                <div className="text-3xl font-bold text-blue-600">
                  {stats.dailyAnalyses.thisMonth}
                </div>
              </div>
            </div>
          </Card>

          {/* Cost */}
          <Card className="p-6">
            <h3 className="text-lg font-bold mb-4">Cost</h3>
            <div className="space-y-4">
              <div>
                <div className="text-sm text-gray-600">Total Cost</div>
                <div className="text-3xl font-bold text-green-600">
                  ${stats.costBreakdown.totalCost.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">This Month</div>
                <div className="text-2xl font-bold">
                  ${stats.costBreakdown.thisMonth.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Avg per Analysis</div>
                <div className="text-2xl font-bold">
                  ${stats.costBreakdown.averagePerAnalysis.toFixed(4)}
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Quotas */}
      {quotas && (
        <Card className="p-6">
          <h3 className="text-xl font-bold mb-6">Current Quotas</h3>
          <div className="space-y-6">
            <QuotaBar
              label="Analysis API Calls"
              used={quotas.analyses.used}
              limit={quotas.analyses.limit}
            />
            <QuotaBar
              label="Batch Jobs"
              used={quotas.batchJobs.used}
              limit={quotas.batchJobs.limit}
            />
            <QuotaBar
              label="API Keys"
              used={quotas.apiKeys.used}
              limit={quotas.apiKeys.limit}
            />
            <QuotaBar
              label="Team Members"
              used={quotas.teamMembers.used}
              limit={quotas.teamMembers.limit}
            />

            <div className="pt-4 border-t mt-6">
              <div className="text-sm text-gray-600">
                Quotas reset on{" "}
                <strong>{new Date(quotas.analyses.resetDate).toLocaleDateString()}</strong>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Evidence Types */}
      {stats && (
        <Card className="p-6">
          <h3 className="text-xl font-bold mb-6">Evidence Types Analyzed</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(stats.topEvidenceTypes).map(([type, count]) => (
              <div key={type} className="text-center">
                <div className="text-3xl font-bold text-blue-600">{count}</div>
                <div className="text-sm text-gray-600 capitalize mt-1">{type}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Active Services */}
      {stats && (
        <Card className="p-6 bg-blue-50 border border-blue-200">
          <h3 className="text-lg font-bold mb-4">Active Services</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-2xl font-bold">{stats.activeApiKeys}</div>
              <div className="text-sm text-gray-700">Active API Keys</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.activeBatches}</div>
              <div className="text-sm text-gray-700">Active Batch Jobs</div>
            </div>
          </div>
        </Card>
      )}

      {/* Pricing Info */}
      <Card className="p-6 bg-gray-50 border border-gray-200">
        <h3 className="text-lg font-bold mb-2">Pricing</h3>
        <ul className="text-sm space-y-2 text-gray-700">
          <li>• Each AI analysis: $0.10</li>
          <li>• Monthly quota: 10,000 analyses per month</li>
          <li>• Batch processing: Included in standard quota</li>
          <li>• API keys: Unlimited</li>
          <li>• Team members: Up to 10 per account</li>
        </ul>
      </Card>
    </div>
  );
}
