"use client";

import { useCallback, useEffect, useState } from "react";
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
          <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
            Chain Status
          </div>

          <div style={{ marginTop: 18 }}>
            {verify === null ? (
              <div style={{ color: "rgba(194,204,201,0.72)" }}>Verification unavailable.</div>
            ) : verify.valid ? (
              <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#9fdfb2" }}>
                  ✅ Audit chain verified
                </div>
                <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                  {verify.partial ? "Tail verification" : "Full verification"}
                  {typeof verify.verifiedCount === "number"
                    ? ` · ${verify.verifiedCount} rows checked`
                    : ""}
                </div>
              </div>
            ) : (
              <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#fca5a5" }}>
                  ❌ Integrity issue detected
                </div>
                <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                  brokenAt: {verify.brokenAt}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>

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
          <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
            Recent Admin Actions
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              <Skeleton width="100%" height="120px" />
              <Skeleton width="100%" height="120px" />
              <Skeleton width="100%" height="120px" />
            </div>
          ) : items.length === 0 ? (
            <div style={{ color: "rgba(194,204,201,0.72)", marginTop: 18 }}>
              No audit entries found.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {items.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    ...dashboardStyles.softCard,
                    padding: 16,
                    borderRadius: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#d8e0dd" }}>
                        {entry.action}
                      </div>

                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                        {entry.category ?? "uncategorized"} · {entry.severity ?? "info"} ·{" "}
                        {entry.outcome ?? "success"}
                      </div>

                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                        user: {entry.userId ?? "public/system"} · ip: {entry.ipAddress ?? "—"}
                      </div>

                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                        request: {entry.requestId ?? "—"} · resource: {entry.resourceType ?? "—"} ·
                        id: {entry.resourceId ?? "—"}
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <div
                          style={{
                            fontSize: 12,
                            color: "rgba(194,204,201,0.68)",
                            lineHeight: 1.5,
                            wordBreak: "break-word",
                          }}
                        >
                          {isExpanded(entry.id)
                            ? "Full metadata shown below"
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
                          <pre
                            style={{
                              fontSize: 11,
                              color: "rgba(194,204,201,0.72)",
                              lineHeight: 1.45,
                              marginTop: 10,
                              marginBottom: 0,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              fontFamily: "ui-monospace, monospace",
                              background: "rgba(255,255,255,0.03)",
                              border: "1px solid rgba(255,255,255,0.06)",
                              borderRadius: 14,
                              padding: 12,
                            }}
                          >
                            {prettyMetadataJson(entry.metadata)}
                          </pre>
                        ) : null}
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(194,204,201,0.56)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatTimestamp(entry.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </DashboardShell>
  );
}