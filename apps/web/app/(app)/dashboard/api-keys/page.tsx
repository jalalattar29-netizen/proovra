"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles, getStatusPillStyle } from "../../../../components/dashboard/styles";

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
  }, [user]);

  const loadKeys = async () => {
    try {
      setLoading(true);
      const data = await apiFetch("/v1/api-keys");
      setKeys(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load API keys";
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
          name: newKeyName,
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
      const message = err instanceof Error ? err.message : "Failed to generate API key";
      addToast(message, "error");
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm("Are you sure? This API key will stop working immediately.")) {
      return;
    }

    try {
      await apiFetch(`/v1/api-keys/${keyId}`, { method: "DELETE" });
      await loadKeys();
      addToast("API key revoked successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke API key";
      addToast(message, "error");
    }
  };

  const handleRotateKey = async (keyId: string, keyName: string) => {
    if (!confirm("This will revoke the old key and create a new one.")) {
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
      const message = err instanceof Error ? err.message : "Failed to rotate API key";
      addToast(message, "error");
    }
  };

  const summaryCards = useMemo(() => {
    const activeKeys = keys.filter((key) => key.isActive).length;
    const revokedKeys = keys.filter((key) => !key.isActive).length;
    const expiringSoon = keys.filter((key) => key.isActive && isExpiringSoon(key.expiresAt)).length;
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
        value: expiringSoon,
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
          className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
          style={dashboardStyles.primaryButton}
        >
          + New API Key
        </Button>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
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
              <div style={{ fontSize: 13, color: "rgba(194,204,201,0.64)" }}>{item.label}</div>
              <div style={{ ...dashboardStyles.metricValue, color: item.color }}>{item.value}</div>
              <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 8 }}>
                {item.sub}
              </div>
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

              <div
                style={{
                  background: "rgba(7,20,38,0.55)",
                  padding: 14,
                  borderRadius: 14,
                  fontFamily: "monospace",
                  fontSize: 13,
                  wordBreak: "break-all",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#dff4ef",
                }}
              >
                {generatedKey.apiKey}
              </div>

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
            <form onSubmit={handleGenerateKey} style={{ display: "grid", gap: 14 }}>
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
                  className="input"
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
                  className="input"
                >
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={365}>1 year</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
        <div style={{ display: "grid", gap: 16 }}>
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
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 16,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <h3
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          margin: 0,
                          color: "#d8e0dd",
                        }}
                      >
                        {key.name}
                      </h3>

                      <span
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

                    <div
                      style={{
                        fontSize: 13,
                        color: "rgba(194,204,201,0.58)",
                        marginTop: 6,
                        fontFamily: "monospace",
                      }}
                    >
                      {key.preview}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: 14,
                        marginTop: 16,
                      }}
                    >
                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 14,
                          borderRadius: 16,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Created</div>
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
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Last Used</div>
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
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Expires</div>
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
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Rate Limit</div>
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

                    <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                      {key.scopes.map((scope) => (
                        <span
                          key={scope}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 999,
                            fontSize: 11,
                            background: "rgba(255,255,255,0.06)",
                            color: "rgba(194,204,201,0.76)",
                            border: "1px solid rgba(255,255,255,0.08)",
                          }}
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
            <p style={{ margin: 0 }}>Include your API key in the Authorization header:</p>
            <code
              style={{
                display: "block",
                background: "rgba(7,20,38,0.55)",
                padding: 14,
                borderRadius: 14,
                fontSize: 12,
                border: "1px solid rgba(255,255,255,0.08)",
                overflow: "auto",
                color: "#dff4ef",
              }}
            >
              curl -H "Authorization: Bearer YOUR_API_KEY" \
              https://api.proovra.com/v1/batch-analysis
            </code>
          </div>
        </div>
      </Card>
    </DashboardShell>
  );
}