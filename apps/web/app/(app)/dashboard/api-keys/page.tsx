"use client";

import { useEffect, useState } from "react";
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

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              API Keys
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Loading API keys and integration access...
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="60px" />
            <Skeleton width="100%" height="200px" />
            <Skeleton width="100%" height="200px" />
          </div>
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
                API Keys
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Manage API keys for third-party integrations.
              </p>
            </div>
            <Button onClick={() => setShowNewKeyForm(!showNewKeyForm)}>
              + New API Key
            </Button>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {generatedKey && (
            <Card
              className="app-card"
              style={{
                border: "1px solid rgba(158,216,207,0.20)",
                background:
                  "linear-gradient(135deg, rgba(158,216,207,0.10), rgba(255,255,255,0.03))",
              }}
            >
              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(246,252,255,0.96)" }}>
                    API Key Created
                  </div>
                  <p style={{ fontSize: 13, color: "rgba(219,235,248,0.68)", marginTop: 6, marginBottom: 0 }}>
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
                    className="flex-1"
                  >
                    Copy Key
                  </Button>
                  <Button onClick={() => setGeneratedKey(null)} variant="secondary" className="flex-1">
                    Done
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {showNewKeyForm && (
            <Card className="app-card">
              <form onSubmit={handleGenerateKey} style={{ display: "grid", gap: 14 }}>
                <div>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(219,235,248,0.72)" }}>
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
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "rgba(219,235,248,0.72)" }}>
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
                  <Button className="flex-1">Generate Key</Button>
                  <Button
                    onClick={() => setShowNewKeyForm(false)}
                    variant="secondary"
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {keys.length === 0 ? (
            <EmptyState
              title="No API Keys"
              subtitle="Create your first API key to integrate with third-party services"
              action={() => <Button onClick={() => setShowNewKeyForm(true)}>Create API Key</Button>}
            />
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {keys.map((key) => (
                <Card key={key.id} className="app-card">
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "rgba(246,252,255,0.96)" }}>
                          {key.name}
                        </h3>
                        {!key.isActive && (
                          <span
                            style={{
                              padding: "6px 10px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 700,
                              background: "rgba(239,68,68,0.14)",
                              color: "#fca5a5",
                              border: "1px solid rgba(239,68,68,0.16)",
                            }}
                          >
                            Revoked
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: 13, color: "rgba(219,235,248,0.58)", marginTop: 6, fontFamily: "monospace" }}>
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
                        <div>
                          <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Created</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(246,252,255,0.92)", marginTop: 4 }}>
                            {new Date(key.createdAt).toLocaleDateString()}
                          </div>
                        </div>

                        {key.lastUsedAt && (
                          <div>
                            <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Last Used</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(246,252,255,0.92)", marginTop: 4 }}>
                              {new Date(key.lastUsedAt).toLocaleDateString()}
                            </div>
                          </div>
                        )}

                        {key.expiresAt && (
                          <div>
                            <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Expires</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(246,252,255,0.92)", marginTop: 4 }}>
                              {new Date(key.expiresAt).toLocaleDateString()}
                            </div>
                          </div>
                        )}

                        <div>
                          <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)" }}>Rate Limit</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(246,252,255,0.92)", marginTop: 4 }}>
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
                              color: "rgba(219,235,248,0.76)",
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
                        >
                          Rotate
                        </Button>
                      )}
                      <Button
                        onClick={() => handleRevokeKey(key.id)}
                        style={{
                          background: "linear-gradient(180deg,#991b1b 0%,#7f1d1d 100%)",
                          border: "1px solid rgba(248,113,113,0.22)",
                          color: "#fff",
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <Card
            className="app-card"
            style={{
              border: "1px solid rgba(214,184,157,0.18)",
              background:
                "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(255,255,255,0.03))",
            }}
          >
            <div className="app-card-title">Usage</div>
            <div style={{ fontSize: 13, color: "rgba(219,235,248,0.76)", display: "grid", gap: 10 }}>
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
          </Card>
        </div>
      </div>
    </div>
  );
}