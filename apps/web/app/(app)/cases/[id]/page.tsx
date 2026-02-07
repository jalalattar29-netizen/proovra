"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card, ListRow, Badge } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const [name, setName] = useState("Case");
  const [evidence, setEvidence] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);
  const [accessList, setAccessList] = useState<Array<{ userId: string }>>([]);
  const [accessUserId, setAccessUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`/v1/cases/${params.id}`),
      apiFetch(`/v1/evidence?caseId=${params.id}`)
    ])
      .then(([caseData, evidenceData]) => {
        setName(caseData.case?.name ?? "Case");
        setAccessList(caseData.case?.access ?? []);
        setEvidence(evidenceData.items ?? []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load case");
      })
      .finally(() => setLoading(false));
  }, [params?.id]);

  const handleGrantAccess = async () => {
    if (!params?.id || !accessUserId) return;
    try {
      const data = await apiFetch(`/v1/cases/${params.id}/access`, {
        method: "POST",
        body: JSON.stringify({ userId: accessUserId })
      });
      setAccessList((prev) => [data.access, ...prev]);
      setAccessUserId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant access");
    }
  };

  const handleExport = () => {
    if (!params?.id) return;
    window.open(`/v1/cases/${params.id}/export`, "_blank");
  };
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{name}</h1>
          <p className="page-subtitle">Evidence grouped under this case.</p>
        </div>
        <Button onClick={handleExport}>Export ZIP</Button>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {loading ? (
          <Card>Loading case...</Card>
        ) : error ? (
          <Card>{error}</Card>
        ) : (
          <>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Case access</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input
                  placeholder="User ID"
                  value={accessUserId}
                  onChange={(e) => setAccessUserId(e.target.value)}
                  style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
                />
                <Button variant="secondary" onClick={handleGrantAccess}>
                  Grant access
                </Button>
                {accessList.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    No explicit access grants.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 6 }}>
                    {accessList.map((item) => (
                      <div key={item.userId} style={{ fontSize: 12 }}>
                        {item.userId}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Evidence</div>
              {evidence.length === 0 ? (
                <div>No evidence in this case yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {evidence.map((item) => (
                    <ListRow
                      key={item.id}
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
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
