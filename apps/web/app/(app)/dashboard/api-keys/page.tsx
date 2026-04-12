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

interface APIKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  scopes: string[];
  isActive: boolean;
  preview: string;
}

interface GeneratedKey {
  id: string;
  name: string;
  apiKey: string;
}

function isExpiringSoon(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;

  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  return expiry > now && expiry - now <= sevenDays;
}

export default function APIKeysPage() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [keys, setKeys] = useState<APIKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatedKey, setGeneratedKey] = useState<GeneratedKey | null>(null);
  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyDays, setNewKeyDays] = useState(90);

  useEffect(() => {
    void loadKeys();
  }, [user?.id]);

  const loadKeys = async () => {
    try {
      setLoading(true);
      const data = await apiFetch("/v1/api-keys");
      setKeys(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load API keys";
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newKeyName.trim()) {
      addToast("Please enter a key name", "error");
      return;
    }

    try {
      const data = await apiFetch("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: newKeyName.trim(),
          scopes: ["analyze:read", "batch:write"],
          expiresInDays: newKeyDays,
        }),
      });

      if (data?.data?.apiKey) {
        setGeneratedKey({
          id: data.data.id,
          name: data.data.name,
          apiKey: data.data.apiKey,
        });

        setNewKeyName("");
        setShowNewKeyForm(false);
        await loadKeys();
        addToast("API key generated successfully", "success");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate API key";
      addToast(message, "error");
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!window.confirm("Are you sure? This API key will stop working immediately.")) {
      return;
    }

    try {
      await apiFetch(`/v1/api-keys/${keyId}`, { method: "DELETE" });
      await loadKeys();
      addToast("API key revoked successfully", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to revoke API key";
      addToast(message, "error");
    }
  };

  const handleRotateKey = async (keyId: string, keyName: string) => {
    if (!window.confirm("This will revoke the old key and create a new one.")) {
      return;
    }

    try {
      const data = await apiFetch(`/v1/api-keys/${keyId}/rotate`, {
        method: "POST",
        body: JSON.stringify({ name: `${keyName} (rotated)` }),
      });

      if (data?.data?.apiKey) {
        setGeneratedKey({
          id: data.data.id,
          name: data.data.name,
          apiKey: data.data.apiKey,
        });

        await loadKeys();
        addToast("API key rotated successfully", "success");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rotate API key";
      addToast(message, "error");
    }
  };

  const summaryCards = useMemo(() => {
    const activeKeys = keys.filter((key) => key.isActive).length;
    const revokedKeys = keys.filter((key) => !key.isActive).length;
    const expiringSoonCount = keys.filter(
      (key) => key.isActive && isExpiringSoon(key.expiresAt)
    ).length;
    const recentlyUsed = keys.filter((key) => Boolean(key.lastUsedAt)).length;

    return [
      {
        label: "Active Keys",
        value: activeKeys,
        sub: "Currently usable",
        color: "#bfe8df",
      },
      {
        label: "Revoked Keys",
        value: revokedKeys,
        sub: "No longer active",
        color: "#f0b4b4",
      },
      {
        label: "Expiring Soon",
        value: expiringSoonCount,
        sub: "Within 7 days",
        color: "#dcc0a5",
      },
      {
        label: "Used Keys",
        value: recentlyUsed,
        sub: "Have last activity",
        color: "#d8e0dd",
      },
    ];
  }, [keys]);

  if (loading) {
    return (
      <DashboardShell
        eyebrow="API Keys"
        title="Manage secure"
        highlight="integration access."
        description={
          <>
            Generate, rotate, revoke, and review API keys used for third-party
            integrations and automated workflows.
          </>
        }
      >
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={dashboardStyles.outerCard}
        >
          <div className="relative z-10 p-6">
            <Skeleton width="100%" height="260px" />
          </div>
        </Card>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      eyebrow="API Keys"
      title="Manage secure"
      highlight="integration access."
      description={
        <>
          Generate, rotate, revoke, and review API keys used for third-party
          integrations and automated workflows.
        </>
      }
      action={
        <Button
          onClick={() => setShowNewKeyForm((prev) => !prev)}
          className="dashboard-api-keys-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
          style={dashboardStyles.primaryButton}
        >
          + New API Key
        </Button>
      }
    >
      <style jsx global>{`
        .dashboard-api-keys-page {
          display: grid;
          gap: 16px;
        }

        .dashboard-api-keys-page .dashboard-api-keys-metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }

        .dashboard-api-keys-page .dashboard-api-keys-list {
          display: grid;
          gap: 16px;
        }

        .dashboard-api-keys-page .dashboard-api-keys-card-metric-value {
          font-size: 34px;
          font-weight: 800;
          margin-top: 8px;
          line-height: 1;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-api-keys-page .dashboard-api-keys-card-metric-sub {
          font-size: 12px;
          color: rgba(194, 204, 201, 0.56);
          margin-top: 8px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-api-keys-page .dashboard-api-keys-key-box {
          background: rgba(7, 20, 38, 0.55);
          padding: 14px;
          border-radius: 14px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 13px;
          word-break: break-all;
          overflow-wrap: anywhere;
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #dff4ef;
        }

        .dashboard-api-keys-page .dashboard-api-keys-form-grid {
          display: grid;
          gap: 14px;
          min-width: 0;
        }

        .dashboard-api-keys-page .dashboard-api-keys-form-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .dashboard-api-keys-page .dashboard-api-keys-form-actions > * {
          flex: 1 1 220px;
        }

        .dashboard-api-keys-page .dashboard-api-keys-field {
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

        .dashboard-api-keys-page .dashboard-api-keys-field::placeholder {
          color: rgba(194, 204, 201, 0.52);
        }

        .dashboard-api-keys-page .dashboard-api-keys-field:focus {
          border-color: rgba(236, 238, 234, 0.24);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            inset 0 0 20px rgba(236, 238, 234, 0.05),
            0 0 0 3px rgba(236, 238, 234, 0.08),
            0 12px 24px rgba(0, 0, 0, 0.14);
        }

        .dashboard-api-keys-page .dashboard-api-keys-item-shell {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }

        .dashboard-api-keys-page .dashboard-api-keys-item-main {
          flex: 1 1 420px;
          min-width: 0;
        }

        .dashboard-api-keys-page .dashboard-api-keys-title-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          min-width: 0;
        }

        .dashboard-api-keys-page .dashboard-api-keys-title {
          font-size: 18px;
          font-weight: 700;
          margin: 0;
          color: #d8e0dd;
          line-height: 1.35;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-api-keys-page .dashboard-api-keys-badge {
          max-width: 100%;
          white-space: normal;
          text-align: center;
          line-height: 1.35;
        }

        .dashboard-api-keys-page .dashboard-api-keys-preview {
          font-size: 13px;
          color: rgba(194, 204, 201, 0.58);
          margin-top: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          overflow-wrap: anywhere;
          word-break: break-all;
        }

        .dashboard-api-keys-page .dashboard-api-keys-meta-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 14px;
          margin-top: 16px;
        }

        .dashboard-api-keys-page .dashboard-api-keys-scopes {
          display: flex;
          gap: 8px;
          margin-top: 16px;
          flex-wrap: wrap;
        }

        .dashboard-api-keys-page .dashboard-api-keys-scope {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 11px;
          background: rgba(255, 255, 255, 0.06);
          color: rgba(194, 204, 201, 0.76);
          border: 1px solid rgba(255, 255, 255, 0.08);
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.35;
        }

        .dashboard-api-keys-page .dashboard-api-keys-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .dashboard-api-keys-page .dashboard-api-keys-usage-code {
          display: block;
          background: rgba(7, 20, 38, 0.55);
          padding: 14px;
          border-radius: 14px;
          font-size: 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          overflow: auto;
          color: #dff4ef;
          white-space: pre-wrap;
          word-break: break-word;
        }

        @media (max-width: 760px) {
          .dashboard-api-keys-page .dashboard-api-keys-form-actions {
            flex-direction: column;
          }

          .dashboard-api-keys-page .dashboard-api-keys-form-actions > * {
            width: 100%;
            flex: 1 1 100%;
          }

          .dashboard-api-keys-page .dashboard-api-keys-actions {
            flex-direction: column;
            align-items: stretch;
            width: 100%;
          }

          .dashboard-api-keys-page .dashboard-api-keys-actions > * {
            width: 100%;
          }

          .dashboard-api-keys-page .dashboard-api-keys-responsive-btn {
            width: 100%;
            min-width: 0;
          }
        }
      `}</style>

      <div className="dashboard-api-keys-page">
        <div className="dashboard-api-keys-metrics-grid">
          {summaryCards.map((item) => (
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
                  className="dashboard-api-keys-card-metric-value"
                  style={{ color: item.color }}
                >
                  {item.value}
                </div>
                <div className="dashboard-api-keys-card-metric-sub">{item.sub}</div>
              </div>
            </Card>
          ))}
        </div>

        {generatedKey && (
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
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                    API Key Created
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      color: "rgba(194,204,201,0.68)",
                      marginTop: 6,
                      marginBottom: 0,
                    }}
                  >
                    Save this key securely. You won't be able to see it again.
                  </p>
                </div>

                <div className="dashboard-api-keys-key-box">{generatedKey.apiKey}</div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Button
                    onClick={() => {
                      navigator.clipboard.writeText(generatedKey.apiKey);
                      addToast("Copied to clipboard", "success");
                    }}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dashboardStyles.primaryButton}
                  >
                    Copy Key
                  </Button>

                  <Button
                    onClick={() => setGeneratedKey(null)}
                    variant="secondary"
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dashboardStyles.secondaryButton}
                  >
                    Done
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {showNewKeyForm && (
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
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <form onSubmit={handleGenerateKey} className="dashboard-api-keys-form-grid">
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 13,
                      marginBottom: 6,
                      color: "rgba(194,204,201,0.72)",
                    }}
                  >
                    Key Name
                  </label>
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g., Webhook Integration"
                    className="dashboard-api-keys-field"
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
                    Expires In (days)
                  </label>
                  <select
                    value={newKeyDays}
                    onChange={(e) => setNewKeyDays(parseInt(e.target.value, 10))}
                    className="dashboard-api-keys-field"
                  >
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={365}>1 year</option>
                  </select>
                </div>

                <div className="dashboard-api-keys-form-actions">
                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={dashboardStyles.primaryButton}
                  >
                    Generate Key
                  </Button>

                  <Button
                    type="button"
                    onClick={() => setShowNewKeyForm(false)}
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

        {keys.length === 0 ? (
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
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />
            <div className="relative z-10 p-6">
              <EmptyState
                title="No API Keys"
                subtitle="Create your first API key to integrate with third-party services"
                action={() => setShowNewKeyForm(true)}
                actionLabel="Create API Key"
              />
            </div>
          </Card>
        ) : (
          <div className="dashboard-api-keys-list">
            {keys.map((key) => (
              <Card
                key={key.id}
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
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

                <div className="relative z-10 p-6 md:p-7">
                  <div className="dashboard-api-keys-item-shell">
                    <div className="dashboard-api-keys-item-main">
                      <div className="dashboard-api-keys-title-row">
                        <h3 className="dashboard-api-keys-title">{key.name}</h3>

                        <span
                          className="dashboard-api-keys-badge"
                          style={{
                            ...getStatusPillStyle(key.isActive ? "active" : "revoked"),
                            padding: "6px 10px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: "capitalize",
                          }}
                        >
                          {key.isActive ? "Active" : "Revoked"}
                        </span>

                        {isExpiringSoon(key.expiresAt) && key.isActive ? (
                          <span
                            className="dashboard-api-keys-badge"
                            style={{
                              ...getStatusPillStyle("warning"),
                              padding: "6px 10px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: "capitalize",
                            }}
                          >
                            Expiring Soon
                          </span>
                        ) : null}
                      </div>

                      <div className="dashboard-api-keys-preview">{key.preview}</div>

                      <div className="dashboard-api-keys-meta-grid">
                        <div
                          style={{
                            ...dashboardStyles.softCard,
                            padding: 14,
                            borderRadius: 16,
                          }}
                        >
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                            Created
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "#d8e0dd",
                              marginTop: 4,
                            }}
                          >
                            {new Date(key.createdAt).toLocaleDateString()}
                          </div>
                        </div>

                        {key.lastUsedAt ? (
                          <div
                            style={{
                              ...dashboardStyles.softCard,
                              padding: 14,
                              borderRadius: 16,
                            }}
                          >
                            <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                              Last Used
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#d8e0dd",
                                marginTop: 4,
                              }}
                            >
                              {new Date(key.lastUsedAt).toLocaleDateString()}
                            </div>
                          </div>
                        ) : null}

                        {key.expiresAt ? (
                          <div
                            style={{
                              ...dashboardStyles.softCard,
                              padding: 14,
                              borderRadius: 16,
                            }}
                          >
                            <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                              Expires
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#d8e0dd",
                                marginTop: 4,
                              }}
                            >
                              {new Date(key.expiresAt).toLocaleDateString()}
                            </div>
                          </div>
                        ) : null}

                        <div
                          style={{
                            ...dashboardStyles.softCard,
                            padding: 14,
                            borderRadius: 16,
                          }}
                        >
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                            Rate Limit
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "#d8e0dd",
                              marginTop: 4,
                            }}
                          >
                            {key.rateLimit.requestsPerMinute}/min
                          </div>
                        </div>
                      </div>

                      <div className="dashboard-api-keys-scopes">
                        {key.scopes.map((scope) => (
                          <span key={scope} className="dashboard-api-keys-scope">
                            {scope}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="dashboard-api-keys-actions">
                      {key.isActive ? (
                        <Button
                          onClick={() => handleRotateKey(key.id, key.name)}
                          variant="secondary"
                          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                        >
                          Rotate
                        </Button>
                      ) : null}

                      <Button
                        onClick={() => handleRevokeKey(key.id)}
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.dangerButton}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

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
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

          <div className="relative z-10 p-6 md:p-7">
            <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
              Usage
            </div>

            <div
              style={{
                fontSize: 13,
                color: "rgba(194,204,201,0.76)",
                display: "grid",
                gap: 10,
                marginTop: 18,
              }}
            >
              <p style={{ margin: 0 }}>
                Include your API key in the Authorization header:
              </p>

              <code className="dashboard-api-keys-usage-code">
                {`curl -H "Authorization: Bearer YOUR_API_KEY" \\
https://api.proovra.com/v1/batch-analysis`}
              </code>
            </div>
          </div>
        </Card>
      </div>
    </DashboardShell>
  );
}