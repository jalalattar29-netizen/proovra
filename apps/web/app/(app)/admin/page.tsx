"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, Skeleton } from "../../../components/ui";
import { useAuth } from "../../providers";

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalEvidence: number;
  reportsGenerated: number;
  subscriptionBreakdown: {
    free: number;
    payg: number;
    pro: number;
    team: number;
  };
  evidenceByType: {
    photos: number;
    videos: number;
    documents: number;
    other: number;
  };
}

export default function AdminPage() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check if user is admin (simple check for now - can be enhanced with roles later)
  const isAdmin = user?.id === "admin" || user?.email?.includes("admin");

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      setError("Access denied - admin only");
      addToast("You don't have access to this page", "error");
      return;
    }

    setLoading(true);
    setError(null);
    addToast("Loading admin dashboard...", "info");

    // Mock stats for now - will be replaced with real API calls
    setTimeout(() => {
      setStats({
        totalUsers: 12345,
        activeUsers: 2345,
        totalEvidence: 45678,
        reportsGenerated: 8234,
        subscriptionBreakdown: {
          free: 8234,
          payg: 2456,
          pro: 1234,
          team: 234
        },
        evidenceByType: {
          photos: 32456,
          videos: 8234,
          documents: 3456,
          other: 1234
        }
      });
      addToast("Admin dashboard loaded", "success");
      setLoading(false);
    }, 500);
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="section app-section">
        <div className="container" style={{ paddingTop: 40 }}>
          <Card>
            <div style={{
              padding: 24,
              textAlign: "center",
              background: "#FEE2E2",
              borderRadius: 8,
              color: "#991B1B"
            }}>
              <h2 style={{ margin: 0, marginBottom: 8 }}>Access Denied</h2>
              <p style={{ margin: 0, fontSize: 14 }}>This page is only accessible to administrators.</p>
              <Link href="/" style={{ marginTop: 16, display: "inline-block" }}>
                <Button>Go Home</Button>
              </Link>
            </div>
          </Card>
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
                Admin Dashboard
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                System overview and analytics
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          {error && (
            <Card>
              <div style={{
                padding: 16,
                background: "#FEE2E2",
                borderRadius: 8,
                color: "#991B1B",
                fontSize: 12,
                marginBottom: 16
              }}>
                {error}
              </div>
            </Card>
          )}

          {loading ? (
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <Skeleton width="100%" height="100px" />
              <Skeleton width="100%" height="100px" />
              <Skeleton width="100%" height="100px" />
              <Skeleton width="100%" height="100px" />
            </div>
          ) : stats ? (
            <>
              {/* Key Metrics Grid */}
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 24 }}>
                <Card>
                  <div style={{ fontSize: 12, color: "#999", fontWeight: 600, marginBottom: 8 }}>
                    Total Users
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#0B1F2A" }}>
                    {stats.totalUsers.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                    Active (30d): {stats.activeUsers.toLocaleString()}
                  </div>
                </Card>

                <Card>
                  <div style={{ fontSize: 12, color: "#999", fontWeight: 600, marginBottom: 8 }}>
                    Total Evidence
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#0B1F2A" }}>
                    {stats.totalEvidence.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                    Reports: {stats.reportsGenerated.toLocaleString()}
                  </div>
                </Card>

                <Card>
                  <div style={{ fontSize: 12, color: "#999", fontWeight: 600, marginBottom: 8 }}>
                    Avg Evidence/User
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#0B1F2A" }}>
                    {(stats.totalEvidence / stats.totalUsers).toFixed(1)}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                    Per registered user
                  </div>
                </Card>

                <Card>
                  <div style={{ fontSize: 12, color: "#999", fontWeight: 600, marginBottom: 8 }}>
                    Report Generation Rate
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#0B1F2A" }}>
                    {(stats.reportsGenerated / stats.totalEvidence * 100).toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                    Of evidence has reports
                  </div>
                </Card>
              </div>

              {/* Subscription Breakdown */}
              <Card>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 600 }}>
                  Subscription Breakdown
                </h3>
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Free Plan</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Users: {stats.subscriptionBreakdown.free.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#0B7BE5" }}>
                      {((stats.subscriptionBreakdown.free / stats.totalUsers) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Pay-Per-Evidence</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Users: {stats.subscriptionBreakdown.payg.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1F9D55" }}>
                      {((stats.subscriptionBreakdown.payg / stats.totalUsers) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Pro Plan</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Users: {stats.subscriptionBreakdown.pro.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#F59E0B" }}>
                      {((stats.subscriptionBreakdown.pro / stats.totalUsers) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Team Plan</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Users: {stats.subscriptionBreakdown.team.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#D64545" }}>
                      {((stats.subscriptionBreakdown.team / stats.totalUsers) * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>
              </Card>

              {/* Evidence by Type */}
              <div style={{ marginTop: 16 }}>
                <Card>
                  <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 600 }}>
                    Evidence by Type
                  </h3>
                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>Photos</div>
                        <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{stats.evidenceByType.photos.toLocaleString()} items</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#0B7BE5" }}>
                        {((stats.evidenceByType.photos / stats.totalEvidence) * 100).toFixed(1)}%
                      </div>
                    </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Videos</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{stats.evidenceByType.videos.toLocaleString()} items</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1F9D55" }}>
                      {((stats.evidenceByType.videos / stats.totalEvidence) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Documents</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{stats.evidenceByType.documents.toLocaleString()} items</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#F59E0B" }}>
                      {((stats.evidenceByType.documents / stats.totalEvidence) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ height: 1, backgroundColor: "#E2E8F0" }} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>Other</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{stats.evidenceByType.other.toLocaleString()} items</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#D64545" }}>
                      {((stats.evidenceByType.other / stats.totalEvidence) * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>
              </Card>
            </div>

              {/* System Info */}
              <div style={{ marginTop: 16 }}>
                <Card>
                  <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 600 }}>
                    System Information
                  </h3>
                  <div style={{ display: "grid", gap: 8, fontSize: 12, color: "#666" }}>
                    <div>
                      <strong>API Version:</strong> v1
                    </div>
                    <div>
                      <strong>Database:</strong> PostgreSQL
                    </div>
                    <div>
                      <strong>Last Updated:</strong> {new Date().toLocaleString()}
                    </div>
                    <div>
                      <strong>Status:</strong> <span style={{ color: "#1F9D55", fontWeight: 600 }}>Healthy</span>
                    </div>
                  </div>
                </Card>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
