"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";

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
    loadKeys();
  }, [user]);

  const loadKeys = async () => {
    try {
      setLoading(true);
      const data = await apiFetch("/v1/api-keys");
      setKeys(data.data || []);
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

      if (data.data?.apiKey) {
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

      if (data.data?.apiKey) {
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

  if (loading) {
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
                API Keys
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Integration access and{" "}
                <span className="text-[#c3ebe2]">API credentials</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Loading API keys and integration access...
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
                API Keys
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Manage secure{" "}
                <span className="text-[#c3ebe2]">integration access</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Generate, rotate, revoke, and review API keys used for third-party
                integrations and automated workflows.
              </p>
            </div>

            <Button
              onClick={() => setShowNewKeyForm(!showNewKeyForm)}
              className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
              style={primaryButtonStyle}
            >
              + New API Key
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          {generatedKey && (
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
                <div style={{ display: "grid", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                      API Key Created
                    </div>
                    <p style={{ fontSize: 13, color: "rgba(194,204,201,0.68)", marginTop: 6, marginBottom: 0 }}>
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

                  <div style={{ display: "flex", gap: 10 }}>
                    <Button
                      onClick={() => {
                        navigator.clipboard.writeText(generatedKey.apiKey);
                        addToast("Copied to clipboard", "success");
                      }}
                      className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Copy Key
                    </Button>
                    <Button
                      onClick={() => setGeneratedKey(null)}
                      variant="secondary"
                      className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={secondaryButtonStyle}
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
                <form onSubmit={handleGenerateKey} style={{ display: "grid", gap: 14 }}>
                  <div>
                    <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(194,204,201,0.72)" }}>
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
                    <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(194,204,201,0.72)" }}>
                      Expires In (days)
                    </label>
                    <select
                      value={newKeyDays}
                      onChange={(e) => setNewKeyDays(parseInt(e.target.value))}
                      className="input"
                    >
                      <option value={30}>30 days</option>
                      <option value={90}>90 days</option>
                      <option value={365}>1 year</option>
                    </select>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <Button
                      className="flex-1 rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Generate Key
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setShowNewKeyForm(false)}
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

          {keys.length === 0 ? (
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
                  title="No API Keys"
                  subtitle="Create your first API key to integrate with third-party services"
                  action={() => (
                    <Button
                      onClick={() => setShowNewKeyForm(true)}
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      Create API Key
                    </Button>
                  )}
                />
              </div>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {keys.map((key) => (
                <Card
                  key={key.id}
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
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "#d8e0dd" }}>
                            {key.name}
                          </h3>
                          {!key.isActive && (
                            <span
                              style={{
                                padding: "6px 10px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 700,
                                background: "rgba(157,80,80,0.14)",
                                color: "#e4a3a3",
                                border: "1px solid rgba(239,68,68,0.16)",
                              }}
                            >
                              Revoked
                            </span>
                          )}
                        </div>

                        <div style={{ fontSize: 13, color: "rgba(194,204,201,0.58)", marginTop: 6, fontFamily: "monospace" }}>
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
                          <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                            <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Created</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#d8e0dd", marginTop: 4 }}>
                              {new Date(key.createdAt).toLocaleDateString()}
                            </div>
                          </div>

                          {key.lastUsedAt && (
                            <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                              <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Last Used</div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#d8e0dd", marginTop: 4 }}>
                                {new Date(key.lastUsedAt).toLocaleDateString()}
                              </div>
                            </div>
                          )}

                          {key.expiresAt && (
                            <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                              <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Expires</div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#d8e0dd", marginTop: 4 }}>
                                {new Date(key.expiresAt).toLocaleDateString()}
                              </div>
                            </div>
                          )}

                          <div style={{ ...softCardStyle, padding: 14, borderRadius: 16 }}>
                            <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Rate Limit</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#d8e0dd", marginTop: 4 }}>
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
                        {key.isActive && (
                          <Button
                            onClick={() => handleRotateKey(key.id, key.name)}
                            variant="secondary"
                            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={secondaryButtonStyle}
                          >
                            Rotate
                          </Button>
                        )}
                        <Button
                          onClick={() => handleRevokeKey(key.id)}
                          className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                          style={dangerButtonStyle}
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
                Usage
              </div>
              <div style={{ fontSize: 13, color: "rgba(194,204,201,0.76)", display: "grid", gap: 10, marginTop: 18 }}>
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
        </div>
      </div>
    </div>
  );
}