"use client";

/**
 * Phase 10 — Integration platform admin UI.
 *
 * Lets an OWNER/ADMIN issue & revoke API keys and configure webhook
 * endpoints for the current workspace. Public verify, external intake,
 * and report-v2 do NOT read or write any of this — the page is strictly
 * workspace-internal.
 *
 * Raw API keys and webhook signing secrets are shown EXACTLY ONCE on
 * creation/rotation. We do not store them client-side beyond the lifetime
 * of the disclosure banner; the operator must copy them out themselves.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";

type ApiKey = {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdByUserId: string;
  lastUsedAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  createdAt: string;
};

type Webhook = {
  id: string;
  teamId: string;
  url: string;
  description: string | null;
  status: string;
  secretPrefix: string;
  eventTypes: string[];
  failureCount: number;
  lastSuccessAtUtc: string | null;
  lastFailureAtUtc: string | null;
  createdAt: string;
};

const ALL_EVENT_TYPES = [
  "evidence.created",
  "evidence.completed",
  "evidence.report_generated",
  "evidence.package_generated",
  "evidence_request.created",
  "evidence_request.sent",
  "evidence_request.response_received",
  "external_intake.submitted",
  "notification.failed",
  "governance.legal_hold_placed",
  "governance.export_blocked",
] as const;

const COMMON_SCOPES = [
  "integration.evidence.read",
  "integration.evidence.create",
  "integration.intake_link.create",
  "integration.evidence_request.create",
  "integration.evidence_request.read",
] as const;

// Phase 38.9 — wrap in canonical PageRouteGate.
export default function IntegrationsPage() {
  return (
    <PageRouteGate routeId="workspace.integrations">
      <IntegrationsPageInner />
    </PageRouteGate>
  );
}

function IntegrationsPageInner() {
  const teamId = useTeamId();
  const [apiKeys, setApiKeys] = useState<ApiKey[] | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disclosed, setDisclosed] = useState<
    | { kind: "api_key"; rawKey: string; name: string }
    | { kind: "webhook"; rawSecret: string; url: string }
    | null
  >(null);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [showCreateWebhook, setShowCreateWebhook] = useState(false);
  const { confirm } = useConfirmAction();

useEffect(() => {
    if (!teamId) return;
    void loadAll(teamId);
  }, [teamId]);

  async function loadAll(workspaceId: string) {
    try {
      const [keys, hooks]: [
        { apiKeys: ApiKey[] },
        { webhooks: Webhook[] },
      ] = await Promise.all([
        apiFetch(
          `/v1/integrations/api-keys?teamId=${encodeURIComponent(workspaceId)}`,
          { method: "GET" },
        ),
        apiFetch(
          `/v1/integrations/webhooks?teamId=${encodeURIComponent(workspaceId)}`,
          { method: "GET" },
        ),
      ]);
      setApiKeys(keys.apiKeys ?? []);
      setWebhooks(hooks.webhooks ?? []);
      setError(null);
    } catch (err) {
      // PRODUCTION FIX: previously this catch surfaced the raw apiFetch
      // error message verbatim, which made the operator see a JSON-style
      // string ("INTEGRATIONS_DISABLED secret_missing") in the error
      // banner. Detect the structured FEATURE_DISABLED code on ApiError
      // and switch to the disabled-state marker that renders a clean
      // panel below. All other errors keep the original message path.
      const e = err as { code?: string; message?: string };
      if (e?.code === "INTEGRATIONS_DISABLED") {
        setError("INTEGRATIONS_DISABLED");
      } else {
        setError(e?.message ?? "Could not load integrations.");
      }
    }
  }

  async function createApiKey(form: {
    name: string;
    description: string;
    scopes: string[];
  }) {
    if (!teamId) return;
    try {
      const res: { apiKey: ApiKey; rawKey: string } = await apiFetch(
        "/v1/integrations/api-keys",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            name: form.name,
            description: form.description || null,
            scopes: form.scopes,
          }),
        },
      );
      setApiKeys((prev) => (prev ? [res.apiKey, ...prev] : [res.apiKey]));
      setDisclosed({
        kind: "api_key",
        rawKey: res.rawKey,
        name: res.apiKey.name,
      });
      setShowCreateKey(false);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not create API key.");
    }
  }

  async function revokeApiKey(id: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Revoke this API key?",
      description:
        "Requests using this key will start failing immediately. This cannot be undone.",
      confirmLabel: "Revoke key",
      tone: "danger",
      testId: "integrations-api-key-revoke",
    });
    if (!ok) return;
    try {
      const res: { apiKey: ApiKey } = await apiFetch(
        `/v1/integrations/api-keys/${id}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setApiKeys((prev) =>
        prev ? prev.map((k) => (k.id === id ? res.apiKey : k)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not revoke key.");
    }
  }

  async function createWebhook(form: {
    url: string;
    description: string;
    eventTypes: string[];
  }) {
    if (!teamId) return;
    try {
      const res: { webhook: Webhook; rawSecret: string } = await apiFetch(
        "/v1/integrations/webhooks",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            url: form.url,
            description: form.description || null,
            eventTypes: form.eventTypes,
          }),
        },
      );
      setWebhooks((prev) => (prev ? [res.webhook, ...prev] : [res.webhook]));
      setDisclosed({
        kind: "webhook",
        rawSecret: res.rawSecret,
        url: res.webhook.url,
      });
      setShowCreateWebhook(false);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not create webhook.");
    }
  }

  async function rotateWebhookSecret(id: string, url: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Rotate this signing secret?",
      description:
        "The old secret will stop signing immediately. You will see the new raw secret once — save it somewhere safe.",
      confirmLabel: "Rotate secret",
      tone: "warning",
      testId: "integrations-webhook-rotate",
    });
    if (!ok) return;
    try {
      const res: { webhook: Webhook; rawSecret: string } = await apiFetch(
        `/v1/integrations/webhooks/${id}/rotate-secret`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setWebhooks((prev) =>
        prev ? prev.map((w) => (w.id === id ? res.webhook : w)) : prev,
      );
      setDisclosed({ kind: "webhook", rawSecret: res.rawSecret, url });
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not rotate secret.");
    }
  }

  async function disableWebhook(id: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Disable this webhook?",
      description:
        "Subscribers will stop receiving events from this endpoint until it is re-enabled.",
      confirmLabel: "Disable webhook",
      tone: "warning",
      testId: "integrations-webhook-disable",
    });
    if (!ok) return;
    try {
      const res: { webhook: Webhook } = await apiFetch(
        `/v1/integrations/webhooks/${id}/disable`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setWebhooks((prev) =>
        prev ? prev.map((w) => (w.id === id ? res.webhook : w)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not disable webhook.");
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Integrations</h1>
        <p style={mutedStyle}>
          API keys authenticate machine-to-machine access to the workspace.
          Webhook endpoints receive event notifications. Keys and signing
          secrets are shown exactly once at creation — capture them then
          and store them in your own credential vault.
        </p>
      </header>

      {error === "INTEGRATIONS_DISABLED" ? (
        <IntegrationsDisabledPanel />
      ) : error ? (
        <div style={errorBoxStyle}>{error}</div>
      ) : null}

      {disclosed ? (
        <DisclosureBanner
          disclosed={disclosed}
          onClose={() => setDisclosed(null)}
        />
      ) : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to manage integrations.</p>
      ) : (
        <>
          <HealthSummary apiKeys={apiKeys} webhooks={webhooks} />
          <SignatureDocsPanel />

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>API keys</h2>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => setShowCreateKey(true)}
              >
                New API key
              </button>
            </div>
            {apiKeys === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : apiKeys.length === 0 ? (
              <p style={mutedStyle}>No API keys issued.</p>
            ) : (
              <ul style={listStyle}>
                {apiKeys.map((k) => (
                  <li key={k.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{k.name}</div>
                      <div style={mutedStyle}>
                        <code>{k.keyPrefix}…</code> · {k.scopes.length} scope
                        {k.scopes.length === 1 ? "" : "s"} · created{" "}
                        {new Date(k.createdAt).toLocaleDateString()}
                        {k.lastUsedAtUtc
                          ? ` · last used ${new Date(k.lastUsedAtUtc).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(k.status)}>{k.status}</span>
                    {k.status === "ACTIVE" ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={() => revokeApiKey(k.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Webhook endpoints</h2>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => setShowCreateWebhook(true)}
              >
                New webhook
              </button>
            </div>
            {webhooks === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : webhooks.length === 0 ? (
              <p style={mutedStyle}>No webhook endpoints configured.</p>
            ) : (
              <ul style={listStyle}>
                {webhooks.map((w) => (
                  <li key={w.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {w.url}
                      </div>
                      <div style={mutedStyle}>
                        {w.eventTypes.length === 0
                          ? "All events"
                          : `${w.eventTypes.length} event type${w.eventTypes.length === 1 ? "" : "s"}`}{" "}
                        · failures: {w.failureCount}
                        {w.lastSuccessAtUtc
                          ? ` · last success ${new Date(w.lastSuccessAtUtc).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(w.status)}>{w.status}</span>
                    {w.status === "ACTIVE" ? (
                      <>
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          onClick={() => rotateWebhookSecret(w.id, w.url)}
                        >
                          Rotate secret
                        </button>
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          onClick={() => disableWebhook(w.id)}
                        >
                          Disable
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {showCreateKey ? (
        <CreateApiKeyDialog
          onCancel={() => setShowCreateKey(false)}
          onCreate={createApiKey}
        />
      ) : null}
      {showCreateWebhook ? (
        <CreateWebhookDialog
          onCancel={() => setShowCreateWebhook(false)}
          onCreate={createWebhook}
        />
      ) : null}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Phase 10.5 — Health summary card. Aggregates active/revoked counts,
// recent failures, and oldest "last used" timestamp from the lists the
// page already has. No new fetches; if the lists are still loading we
// show a placeholder.
// -----------------------------------------------------------------------------

function HealthSummary({
  apiKeys,
  webhooks,
}: {
  apiKeys: ApiKey[] | null;
  webhooks: Webhook[] | null;
}) {
  if (apiKeys === null || webhooks === null) {
    return (
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Health</h2>
        <p style={mutedStyle}>Loading summary…</p>
      </section>
    );
  }

  const activeKeys = apiKeys.filter((k) => k.status === "ACTIVE").length;
  const revokedKeys = apiKeys.length - activeKeys;
  const lastUsedAt = apiKeys
    .map((k) => (k.lastUsedAtUtc ? Date.parse(k.lastUsedAtUtc) : 0))
    .reduce((max, t) => (t > max ? t : max), 0);
  const activeHooks = webhooks.filter((w) => w.status === "ACTIVE").length;
  const disabledHooks = webhooks.length - activeHooks;
  const hookFailureCount = webhooks.reduce(
    (sum, w) => sum + (w.failureCount ?? 0),
    0,
  );
  const recentlyFailingHooks = webhooks.filter(
    (w) => (w.failureCount ?? 0) >= 5 && w.status === "ACTIVE",
  ).length;

  return (
    <section style={cardStyle}>
      <h2 style={sectionTitleStyle}>Health</h2>
      <div style={summaryGridStyle}>
        <SummaryStat label="API keys (active)" value={String(activeKeys)} />
        <SummaryStat label="API keys (revoked)" value={String(revokedKeys)} />
        <SummaryStat
          label="API key last used"
          value={
            lastUsedAt > 0
              ? new Date(lastUsedAt).toLocaleString()
              : "never"
          }
        />
        <SummaryStat label="Webhooks (active)" value={String(activeHooks)} />
        <SummaryStat
          label="Webhooks (disabled)"
          value={String(disabledHooks)}
        />
        <SummaryStat
          label="Webhook failures (lifetime)"
          value={String(hookFailureCount)}
        />
        <SummaryStat
          label="Endpoints with ≥5 consecutive failures"
          value={String(recentlyFailingHooks)}
          tone={recentlyFailingHooks > 0 ? "warn" : "neutral"}
        />
      </div>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div style={summaryStatStyle}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "warn" ? "#b45309" : "#0f172a",
        }}
      >
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Phase 10.5 — Signature verification + idempotency docs panel.
// Pure prose, no fetches. The signature pseudocode mirrors the
// canonical scheme implemented in webhooks.service.ts.
// -----------------------------------------------------------------------------

function SignatureDocsPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section style={cardStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={sectionTitleStyle}>How to verify webhooks</h2>
        <button
          type="button"
          style={secondaryButtonStyle}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <div style={{ marginTop: 8 }}>
          <p style={mutedStyle}>
            Each outbound webhook delivery includes these headers:
          </p>
          <ul style={{ ...mutedStyle, paddingLeft: 20 }}>
            <li>
              <code>X-Proovra-Event</code> — event type
            </li>
            <li>
              <code>X-Proovra-Event-Id</code> — unique delivery id
            </li>
            <li>
              <code>X-Proovra-Timestamp</code> — unix milliseconds
            </li>
            <li>
              <code>X-Proovra-Signature</code> — <code>v1=&lt;hex&gt;</code>
            </li>
          </ul>
          <p style={mutedStyle}>To verify a request on your server:</p>
          <pre style={codeBlockStyle}>{`// pseudocode
const expected =
  "v1=" +
  hmac_sha256_hex(
    raw_secret,
    timestamp_header + "." + raw_request_body
  );

if (!constant_time_equals(expected, signature_header))
  reject(401);

if (now_ms() - parse_int(timestamp_header) > 5 * 60_000)
  reject(401); // outside 5-minute tolerance`}</pre>
          <p style={{ ...mutedStyle, marginTop: 8 }}>
            <strong>Idempotency:</strong> the same event MAY be delivered more
            than once after a transient failure. Use <code>X-Proovra-Event-Id</code>{" "}
            as an idempotency key — if you have already processed an event id,
            ack with 2xx and discard the duplicate. Never trust a duplicate
            event id twice.
          </p>
          <p style={{ ...mutedStyle, marginTop: 8 }}>
            <strong>Timestamp tolerance:</strong> reject deliveries whose
            timestamp is older than 5 minutes (and from the future by more
            than 1 minute) to prevent replay.
          </p>
        </div>
      ) : (
        <p style={mutedStyle}>
          Verification scheme, idempotency, and replay protection notes.
        </p>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Disclosure banner — surfaces the one-time raw value.
// -----------------------------------------------------------------------------

function DisclosureBanner({
  disclosed,
  onClose,
}: {
  disclosed:
    | { kind: "api_key"; rawKey: string; name: string }
    | { kind: "webhook"; rawSecret: string; url: string };
  onClose: () => void;
}) {
  const isKey = disclosed.kind === "api_key";
  const raw = isKey ? disclosed.rawKey : disclosed.rawSecret;
  const label = isKey ? "API key" : "Webhook signing secret";
  const context = isKey
    ? `for "${disclosed.name}"`
    : `for ${disclosed.url}`;
  return (
    <div style={disclosureBoxStyle} role="alert">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Save this {label} now
      </div>
      <div style={mutedStyle}>
        {context}. This value is shown exactly once and cannot be
        recovered. Store it in your own credential vault.
      </div>
      <code style={codeBlockStyle}>{raw}</code>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            void navigator.clipboard.writeText(raw);
          }}
        >
          Copy
        </button>
        <button type="button" style={secondaryButtonStyle} onClick={onClose}>
          I&apos;ve stored it
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Create dialogs
// -----------------------------------------------------------------------------

function CreateApiKeyDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (form: {
    name: string;
    description: string;
    scopes: string[];
  }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<string[]>([COMMON_SCOPES[0]]);

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>New API key</h3>
        <Field label="Name">
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 180))}
            placeholder="e.g. Production data sync"
            autoFocus
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            placeholder="What is this key for?"
          />
        </Field>
        <Field label="Scopes">
          <div>
            {COMMON_SCOPES.map((s) => (
              <label
                key={s}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                />
                <code>{s}</code>
              </label>
            ))}
          </div>
        </Field>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={name.trim().length === 0 || scopes.length === 0}
            onClick={() => onCreate({ name: name.trim(), description, scopes })}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateWebhookDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (form: {
    url: string;
    description: string;
    eventTypes: string[];
  }) => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>([]);

  function toggleEvent(e: string) {
    setEventTypes((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e],
    );
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 560 }}>
        <h3 style={sectionTitleStyle}>New webhook</h3>
        <Field label="URL (HTTPS only)">
          <input
            style={inputStyle}
            value={url}
            onChange={(e) => setUrl(e.target.value.slice(0, 2048))}
            placeholder="https://example.com/proovra/webhook"
            autoFocus
          />
        </Field>
        <Field label="Description (optional)">
          <input
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 400))}
            placeholder="What is this endpoint for?"
          />
        </Field>
        <Field label="Event types (leave all unchecked to subscribe to all)">
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {ALL_EVENT_TYPES.map((e) => (
              <label
                key={e}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={eventTypes.includes(e)}
                  onChange={() => toggleEvent(e)}
                />
                <code>{e}</code>
              </label>
            ))}
          </div>
        </Field>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!/^https:\/\//.test(url.trim())}
            onClick={() =>
              onCreate({ url: url.trim(), description, eventTypes })
            }
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
};
const summaryStatStyle: React.CSSProperties = {
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  color: "#334155",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};

/**
 * PRODUCTION FIX: replaces the raw-JSON error banner that operators were
 * seeing when the deployment had INTEGRATIONS_ENABLED=false or API_KEY_SECRET
 * unset. The backend responds 503 with structured
 * `{ code: "INTEGRATIONS_DISABLED", reason: "secret_missing" | "feature_flag_off" }`
 * — this panel renders that state cleanly with operator-readable copy.
 * The panel deliberately does NOT name the env vars (deployment-internal
 * configuration; consult the deployment runbook instead).
 */
function IntegrationsDisabledPanel(): JSX.Element {
  return (
    <section
      data-testid="integrations-disabled-panel"
      style={{
        marginTop: 12,
        padding: 16,
        background: "#f8fafc",
        border: "1px solid #cbd5e1",
        borderRadius: 8,
        maxWidth: 640,
      }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "#0f172a", margin: 0 }}>
        Integrations are not available on this workspace
      </h2>
      <p
        style={{
          fontSize: 14,
          color: "#475569",
          marginTop: 8,
          marginBottom: 0,
        }}
      >
        API keys and webhooks have not been enabled here yet. A platform
        administrator must finish deployment configuration before this
        surface can manage keys or endpoints.
      </p>
      <p
        style={{
          fontSize: 13,
          color: "#64748b",
          marginTop: 12,
          marginBottom: 0,
        }}
      >
        If you expected integrations to be available, contact your platform
        administrator or consult the deployment runbook for next steps.
      </p>
    </section>
  );
}
const disclosureBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: "#fff7ed",
  border: "1px solid #fed7aa",
  borderRadius: 12,
};
const codeBlockStyle: React.CSSProperties = {
  display: "block",
  marginTop: 8,
  padding: "10px 12px",
  background: "#0f172a",
  color: "#f8fafc",
  fontSize: 13,
  borderRadius: 6,
  fontFamily: "Menlo, Consolas, monospace",
  wordBreak: "break-all",
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  maxWidth: 480,
  width: "100%",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
};

function statusBadgeStyle(status: string): React.CSSProperties {
  const active = status === "ACTIVE";
  return {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: active ? "#dcfce7" : "#f1f5f9",
    border: `1px solid ${active ? "#86efac" : "#cbd5e1"}`,
    color: active ? "#166534" : "#475569",
    borderRadius: 999,
  };
}
