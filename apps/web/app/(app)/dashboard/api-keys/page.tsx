"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/src/auth-context";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui";
import { Skeleton, EmptyState, Card, Button } from "@/components/ui";

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
      addToast("Failed to load API keys", "error");
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
      addToast("Failed to generate API key", "error");
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
      addToast("Failed to revoke API key", "error");
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
      addToast("Failed to rotate API key", "error");
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width="100%" height={60} />
        <Skeleton width="100%" height={200} />
        <Skeleton width="100%" height={200} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">API Keys</h1>
          <p className="text-gray-600 mt-2">Manage API keys for third-party integrations</p>
        </div>
        <Button onClick={() => setShowNewKeyForm(!showNewKeyForm)}>
          + New API Key
        </Button>
      </div>

      {/* Generated Key Display */}
      {generatedKey && (
        <Card className="p-6 bg-blue-50 border-2 border-blue-200">
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold text-gray-700">API Key Created</div>
              <p className="text-sm text-gray-600 mt-1">
                Save this key securely. You won't be able to see it again.
              </p>
            </div>
            <div className="bg-white p-3 rounded font-mono text-sm break-all border border-gray-300">
              {generatedKey.apiKey}
            </div>
            <div className="flex gap-2">
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

      {/* New Key Form */}
      {showNewKeyForm && (
        <Card className="p-6">
          <form onSubmit={handleGenerateKey} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Key Name
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Webhook Integration"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Expires In (days)
              </label>
              <select
                value={newKeyDays}
                onChange={(e) => setNewKeyDays(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
            </div>

            <div className="flex gap-2">
              <Button type="submit" className="flex-1">
                Generate Key
              </Button>
              <Button
                type="button"
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

      {/* Keys List */}
      {keys.length === 0 ? (
        <EmptyState
          title="No API Keys"
          description="Create your first API key to integrate with third-party services"
          action={
            <Button onClick={() => setShowNewKeyForm(true)}>Create API Key</Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {keys.map((key) => (
            <Card key={key.id} className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{key.name}</h3>
                    {!key.isActive && (
                      <span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 mt-1 font-mono">{key.preview}</div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                    <div>
                      <div className="text-xs text-gray-600">Created</div>
                      <div className="text-sm font-medium">
                        {new Date(key.createdAt).toLocaleDateString()}
                      </div>
                    </div>

                    {key.lastUsedAt && (
                      <div>
                        <div className="text-xs text-gray-600">Last Used</div>
                        <div className="text-sm font-medium">
                          {new Date(key.lastUsedAt).toLocaleDateString()}
                        </div>
                      </div>
                    )}

                    {key.expiresAt && (
                      <div>
                        <div className="text-xs text-gray-600">Expires</div>
                        <div className="text-sm font-medium">
                          {new Date(key.expiresAt).toLocaleDateString()}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="text-xs text-gray-600">Rate Limit</div>
                      <div className="text-sm font-medium">
                        {key.rateLimit.requestsPerMinute}/min
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-1 mt-4 flex-wrap">
                    {key.scopes.map((scope) => (
                      <span
                        key={scope}
                        className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 ml-4">
                  {key.isActive && (
                    <Button
                      onClick={() => handleRotateKey(key.id, key.name)}
                      variant="secondary"
                      className="text-sm"
                    >
                      Rotate
                    </Button>
                  )}
                  <Button
                    onClick={() => handleRevokeKey(key.id)}
                    className="text-sm bg-red-600 hover:bg-red-700"
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Documentation */}
      <Card className="p-6 bg-blue-50 border border-blue-200">
        <h3 className="text-lg font-semibold mb-2">Usage</h3>
        <div className="text-sm space-y-2">
          <p>Include your API key in the Authorization header:</p>
          <code className="block bg-white p-3 rounded text-xs border border-gray-300 overflow-auto">
            curl -H "Authorization: Bearer YOUR_API_KEY" \
            https://api.proovra.com/v1/batch-analysis
          </code>
        </div>
      </Card>
    </div>
  );
}
