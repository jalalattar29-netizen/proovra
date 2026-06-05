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
import {
  useTeamId,
  useActiveSpace,
} from "../../../lib/platform-context";
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
  // PHASE 2 — hardening + dual-active rotation surface.
  expiresAtUtc: string | null;
  rotationRequired: boolean;
  ipAllowlist: string[];
  previousKeyPrefix: string | null;
  previousValidUntilUtc: string | null;
  createdAt: string;
};

// PHASE 2 — projection of a single api_credential_usage_log row returned by
// GET /v1/integrations/api-keys/:id/usage. Mirrors `projectApiCredentialUsage`
// on the server (no raw key, no Authorization header, no request body).
type ApiKeyUsageRow = {
  id: string;
  routePath: string;
  method: string;
  action: string;
  statusCode: number;
  success: boolean;
  failureReason: string | null;
  requestId: string | null;
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
  // Phase 4 — dual-signing rotation window. NULL when no rotation is
  // in flight. The previous secret prefix is operator-visible (audit /
  // display only); the previous ciphertext is never projected.
  previousSecretPrefix: string | null;
  previousSecretValidUntilUtc: string | null;
  createdAt: string;
};

// Phase 3 — projection of a single integration_webhook_delivery row
// returned by GET /v1/integrations/webhooks/:id/deliveries. Mirrors
// `projectIntegrationDelivery` on the server (no payload, no signing
// secret, no raw response body beyond the bounded preview the server
// chose to surface).
type WebhookDelivery = {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  nextAttemptAtUtc: string | null;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  errorMessage: string | null;
  sentAtUtc: string | null;
  failedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
};

// Phase 3 — canonical test event type literal. Mirrors
// `TEST_EVENT_TYPE` on the server.
const WEBHOOK_TEST_EVENT_TYPE = "webhook.test" as const;

// Phase 6 / closure phase — operator-selectable event types are ONLY those
// with a canonical producer wired into the API process. Each entry here MUST
// correspond to an `emitWebhookEvent({ eventType: "..." })` call site in
// services/api/src/services/**.
//
// Phase closure additions:
//   - notification.failed — wired at the terminal FAILED transition inside
//     the canonical `dispatchDelivery` / `sendEmailNotification` helpers in
//     services/api/src/services/notifications/index.ts. Fires post-commit
//     (the DB row is already FAILED before emit). Payload is bounded:
//     recipient is sha256-hashed and the raw provider error message is
//     dropped — only the bounded `errorCode` sentinel crosses the wire.
//
// Deliberately NOT advertised in this list (no live producer):
//   - evidence.report_generated / evidence.package_generated — produced
//     by the worker (services/worker/src/processor.ts). The worker
//     reaches the API only over an internal HTTP channel
//     (internal-api-client.ts) which is purpose-built for the
//     media-intelligence extract path. Adding a second internal route
//     just to forward webhook emits would introduce a new architectural
//     boundary (per-event blocking HTTP round-trip from a hot worker
//     path) for events that the dispatcher's wildcard subscription
//     (`eventTypes: []`) already cannot serve. Deferred to a future phase
//     where the worker → API emit path is designed end-to-end.
//
// The dispatcher's wildcard subscription (`eventTypes: []`) still
// receives every event the dispatcher fires today, including any
// future-added event type, so existing all-events endpoints are
// unaffected.
const ALL_EVENT_TYPES = [
  "evidence.created",
  "evidence.completed",
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

type IntegrationsDiagnostics = {
  enabled: boolean;
  apiKeySecretBound: boolean;
  apiKeySecretLengthValid: boolean;
  cronSecretBound: boolean;
  reason: "feature_flag_off" | "secret_missing" | null;
  envSourceHint: string;
};

function IntegrationsPageInner() {
  const teamId = useTeamId();
  // Admin == OWNER or ADMIN on the active workspace, derived from the
  // canonical ENTERPRISE TENANT MODEL `activeSpace` (phase-37.95
  // non-regression test enforces no new consumers of the deprecated
  // legacy context field). Mirrors the API gate on
  // /v1/integrations/diagnostics — non-admins never see the reason
  // chip even when the disabled panel renders.
  const activeSpace = useActiveSpace();
  const isAdmin =
    activeSpace?.type === "ORGANIZATION"
      ? activeSpace.roleLabel === "OWNER" ||
        activeSpace.roleLabel === "ADMIN"
      : activeSpace?.type === "PERSONAL";
  const [apiKeys, setApiKeys] = useState<ApiKey[] | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // PHASE 7 — admin-only machine-code chip companion to `error`. The
  // raw response payload from `apiFetch` is NEVER surfaced verbatim;
  // only the structured code (when present) is rendered, and only to
  // operators with admin role.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] =
    useState<IntegrationsDiagnostics | null>(null);
  const [disclosed, setDisclosed] = useState<
    | { kind: "api_key"; rawKey: string; name: string }
    | {
        kind: "api_key_rotated";
        rawKey: string;
        name: string;
        previousKeyPrefix: string;
        previousValidUntilUtc: string;
      }
    | { kind: "webhook"; rawSecret: string; url: string }
    // Phase 4 — dual-signing rotation. The disclosure banner shows the
    // new raw secret EXACTLY ONCE and explains that the prior secret
    // keeps signing alongside the new one until the cutoff.
    | {
        kind: "webhook_rotated";
        rawSecret: string;
        url: string;
        previousSecretPrefix: string;
        previousSecretValidUntilUtc: string;
      }
    | null
  >(null);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [showCreateWebhook, setShowCreateWebhook] = useState(false);
  // PHASE 2 — modal coordination state for revoke (with reason), rotation,
  // expiry editing, and the per-key usage panel. Each is keyed by the api
  // credential id so only the one in focus opens.
  const [revokeReasonForId, setRevokeReasonForId] = useState<string | null>(
    null,
  );
  const [rotateForId, setRotateForId] = useState<string | null>(null);
  // Phase 4 — webhook rotation dialog state. Keyed by endpoint id; null
  // means no modal open. Distinct from `rotateForId` (api credentials)
  // so the two surfaces never collide.
  const [rotateWebhookForId, setRotateWebhookForId] = useState<string | null>(
    null,
  );
  const [expiryForId, setExpiryForId] = useState<string | null>(null);
  const [usageForId, setUsageForId] = useState<string | null>(null);
  const [usageRows, setUsageRows] = useState<ApiKeyUsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  // Phase 3 — webhook deliveries panel state. `expandedHookId` is the
  // id of the endpoint whose deliveries panel is currently visible
  // (only one at a time keeps the network footprint small + the UI
  // simple). `deliveriesByEndpoint` caches the last loaded list so
  // a re-open of the same panel does not re-fetch unless the operator
  // explicitly hits Refresh. Errors and in-flight markers live in
  // separate maps keyed by endpoint id so an error rendering one
  // endpoint never bleeds into another.
  const [expandedHookId, setExpandedHookId] = useState<string | null>(null);
  const [deliveriesByEndpoint, setDeliveriesByEndpoint] = useState<
    Record<string, WebhookDelivery[] | undefined>
  >({});
  const [deliveriesLoadingFor, setDeliveriesLoadingFor] = useState<
    string | null
  >(null);
  const [deliveriesErrorByEndpoint, setDeliveriesErrorByEndpoint] = useState<
    Record<string, string | undefined>
  >({});
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(
    null,
  );
  const [sendingTestForId, setSendingTestForId] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

useEffect(() => {
    if (!teamId) return;
    void loadAll(teamId);
  }, [teamId]);

  // When the page transitions into the disabled state AND the current user
  // is an admin of the workspace, fetch the safe diagnostics payload so the
  // disabled panel can render the reason chip. Non-admins skip the call —
  // the backend would reject them with 403 anyway.
  useEffect(() => {
    if (error !== "INTEGRATIONS_DISABLED") return;
    if (!teamId || !isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res: { diagnostics: IntegrationsDiagnostics } = await apiFetch(
          `/v1/integrations/diagnostics?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        );
        if (!cancelled) setDiagnostics(res.diagnostics);
      } catch {
        // Best-effort. If diagnostics fails we still render the panel
        // without the reason chip — never surface the diagnostics error
        // to normal users.
        if (!cancelled) setDiagnostics(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [error, teamId, isAdmin]);

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
      setErrorCode(null);
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
        setErrorCode(null);
      } else {
        setError(e?.message ?? "Could not load integrations.");
        // PHASE 7 — captured for the admin-only chip; never rendered to
        // non-admins. Never includes the body.
        setErrorCode(typeof e?.code === "string" ? e.code : null);
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

  // PHASE 2 — revoke now opens the structured RevokeApiKeyDialog so the
  // operator can attach an audit-grade reason; the dialog submits via this
  // handler. The reason is persisted on the api credential row AND in the
  // TeamActivity audit event (emitted server-side).
  async function submitRevokeApiKey(id: string, reason: string) {
    if (!teamId) return;
    try {
      const res: { apiKey: ApiKey } = await apiFetch(
        `/v1/integrations/api-keys/${id}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            reason: reason.trim().length === 0 ? null : reason.trim(),
          }),
        },
      );
      setApiKeys((prev) =>
        prev ? prev.map((k) => (k.id === id ? res.apiKey : k)) : prev,
      );
      setRevokeReasonForId(null);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not revoke key.");
    }
  }

  // PHASE 2 — true dual-active rotation. New raw key is shown EXACTLY ONCE
  // via the disclosure banner; the prior key remains valid for the grace
  // window. We surface both pieces of context to the operator so they
  // know how long they have to swap clients over.
  async function submitRotateApiKey(id: string, graceMinutes: number) {
    if (!teamId) return;
    try {
      const res: {
        apiKey: ApiKey;
        rawKey: string;
        previousKeyPrefix: string;
        previousValidUntilUtc: string;
      } = await apiFetch(`/v1/integrations/api-keys/${id}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, graceMinutes }),
      });
      setApiKeys((prev) =>
        prev ? prev.map((k) => (k.id === id ? res.apiKey : k)) : prev,
      );
      setDisclosed({
        kind: "api_key_rotated",
        rawKey: res.rawKey,
        name: res.apiKey.name,
        previousKeyPrefix: res.previousKeyPrefix,
        previousValidUntilUtc: res.previousValidUntilUtc,
      });
      setRotateForId(null);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not rotate key.");
    }
  }

  // PHASE 2 — expiry management. Passing `null` clears expiry. ISO datetime
  // string sets it. Both branches emit an integration.api_key.expiry_changed
  // audit event server-side.
  async function submitApiKeyExpiry(
    id: string,
    expiresAtUtc: string | null,
  ) {
    if (!teamId) return;
    try {
      const res: { apiKey: ApiKey } = await apiFetch(
        `/v1/integrations/api-keys/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, expiresAtUtc }),
        },
      );
      setApiKeys((prev) =>
        prev ? prev.map((k) => (k.id === id ? res.apiKey : k)) : prev,
      );
      setExpiryForId(null);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not update expiry.");
    }
  }

  // PHASE 2 — Usage details panel. Lazy-fetches usage rows the first time
  // the panel opens for a given credential id, then re-uses them until the
  // panel closes or a different credential id is opened.
  async function openUsageFor(id: string) {
    if (!teamId) return;
    setUsageForId(id);
    setUsageRows(null);
    setUsageError(null);
    try {
      const res: { usage: ApiKeyUsageRow[] } = await apiFetch(
        `/v1/integrations/api-keys/${id}/usage?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setUsageRows(res.usage ?? []);
    } catch (err) {
      const e = err as { message?: string };
      setUsageError(e?.message ?? "Could not load usage.");
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

  // Phase 4 — dual-signing rotation. The grace window comes from
  // `RotateWebhookDialog`; the prior signing secret stays valid for
  // `graceMinutes` and the dispatcher emits BOTH signatures in the
  // `X-Proovra-Signature` header during the window. The disclosure
  // banner shows the new raw secret EXACTLY ONCE.
  async function submitRotateWebhookSecret(
    id: string,
    url: string,
    graceMinutes: number,
  ) {
    if (!teamId) return;
    try {
      const res: {
        webhook: Webhook;
        rawSecret: string;
        previousSecretPrefix: string;
        previousSecretValidUntilUtc: string;
      } = await apiFetch(`/v1/integrations/webhooks/${id}/rotate-secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, graceMinutes }),
      });
      setWebhooks((prev) =>
        prev ? prev.map((w) => (w.id === id ? res.webhook : w)) : prev,
      );
      setDisclosed({
        kind: "webhook_rotated",
        rawSecret: res.rawSecret,
        url,
        previousSecretPrefix: res.previousSecretPrefix,
        previousSecretValidUntilUtc: res.previousSecretValidUntilUtc,
      });
      setRotateWebhookForId(null);
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

  // Phase 3 — re-enable a DISABLED endpoint. The canonical path is
  // PUT /v1/integrations/webhooks/:id with status=ACTIVE — there is
  // no separate /enable route. This wrapper keeps the UI symmetric
  // with `disableWebhook` so the operator does not have to know.
  async function enableWebhook(id: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Re-enable this webhook?",
      description:
        "Subscribers will start receiving events again. The signing secret is unchanged — receivers do not need to update anything.",
      confirmLabel: "Enable webhook",
      tone: "neutral",
      testId: "integrations-webhook-enable",
    });
    if (!ok) return;
    try {
      const res: { webhook: Webhook } = await apiFetch(
        `/v1/integrations/webhooks/${id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, status: "ACTIVE" }),
        },
      );
      setWebhooks((prev) =>
        prev ? prev.map((w) => (w.id === id ? res.webhook : w)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not enable webhook.");
    }
  }

  // Phase 3 — load the most recent 25 deliveries for an endpoint and
  // open the deliveries panel. If the panel is already open for the
  // same endpoint, this is treated as a refresh.
  async function openDeliveriesPanel(id: string) {
    if (!teamId) return;
    setExpandedHookId(id);
    setDeliveriesLoadingFor(id);
    setDeliveriesErrorByEndpoint((prev) => ({ ...prev, [id]: undefined }));
    try {
      const res: { deliveries: WebhookDelivery[] } = await apiFetch(
        `/v1/integrations/webhooks/${encodeURIComponent(id)}/deliveries?teamId=${encodeURIComponent(teamId)}&limit=25`,
        { method: "GET" },
      );
      setDeliveriesByEndpoint((prev) => ({
        ...prev,
        [id]: res.deliveries ?? [],
      }));
    } catch (err) {
      // Surface ONLY the operator-readable message; never a raw JSON
      // blob. The deliveries panel renders a styled error chip.
      const e = err as { message?: string };
      setDeliveriesErrorByEndpoint((prev) => ({
        ...prev,
        [id]: e?.message ?? "Could not load deliveries.",
      }));
    } finally {
      setDeliveriesLoadingFor((cur) => (cur === id ? null : cur));
    }
  }

  function closeDeliveriesPanel() {
    setExpandedHookId(null);
  }

  // Phase 3 — Retry a FAILED / RETRY_SCHEDULED delivery. The button
  // is disabled while the request is in flight so an operator cannot
  // double-click. On success we splice the updated row into the
  // cached list rather than re-fetching the whole panel.
  async function retryWebhookDelivery(
    endpointId: string,
    deliveryId: string,
  ) {
    if (!teamId) return;
    setRetryingDeliveryId(deliveryId);
    try {
      const res: { delivery: WebhookDelivery } = await apiFetch(
        `/v1/integrations/webhook-deliveries/${encodeURIComponent(deliveryId)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setDeliveriesByEndpoint((prev) => {
        const list = prev[endpointId];
        if (!list) return prev;
        return {
          ...prev,
          [endpointId]: list.map((d) =>
            d.id === deliveryId ? res.delivery : d,
          ),
        };
      });
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not retry delivery.");
    } finally {
      setRetryingDeliveryId((cur) => (cur === deliveryId ? null : cur));
    }
  }

  // Phase 3 — Send a synthetic test event to the endpoint. The
  // request body is intentionally empty (`{}`) — the server fills in
  // the canonical kind="test" payload. We then refresh the
  // deliveries panel so the operator sees the new row at the top.
  async function sendWebhookTestEvent(id: string) {
    if (!teamId) return;
    setSendingTestForId(id);
    try {
      const res: { deliveryId: string; eventId: string } = await apiFetch(
        `/v1/integrations/webhooks/${encodeURIComponent(id)}/test`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      // Ensure the deliveries panel is open for this endpoint so the
      // operator can see the result of their test event immediately.
      await openDeliveriesPanel(id);
      // Voiding the returned ids — they are surfaced via the
      // freshly-loaded deliveries list. We could highlight the row,
      // but keeping the UI simple is the safer baseline.
      void res.deliveryId;
      void res.eventId;
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not send test event.");
    } finally {
      setSendingTestForId((cur) => (cur === id ? null : cur));
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
        <IntegrationsDisabledPanel
          isAdmin={isAdmin}
          diagnostics={diagnostics}
        />
      ) : error ? (
        // PHASE 7 — typed error surface. The raw apiFetch error message
        // is already operator-readable (the server emits stable codes
        // like "credential_not_found" and never raw JSON envelopes); but
        // we belt-and-braces the rendering by stripping any accidental
        // JSON-looking payload before showing it to a non-admin. Admins
        // additionally see the machine code chip when the apiFetch
        // error carried one.
        <IntegrationsErrorBanner
          message={error}
          code={errorCode}
          isAdmin={isAdmin}
        />
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
          <PageStatusBanner
            disabled={error === "INTEGRATIONS_DISABLED"}
            webhooks={webhooks}
          />
          <HealthSummary teamId={teamId} />
          <SignatureDocsPanel />

          <section style={cardStyle} data-testid="integrations-api-keys-section">
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
              <p
                style={mutedStyle}
                data-testid="integrations-api-keys-empty-state"
              >
                No API keys yet. Create your first key to integrate with
                the Proovra API.
              </p>
            ) : (
              <ApiKeysTable
                rows={apiKeys}
                onRevoke={(id) => setRevokeReasonForId(id)}
                onRotate={(id) => setRotateForId(id)}
                onExpiry={(id) => setExpiryForId(id)}
                onUsage={(id) => void openUsageFor(id)}
              />
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
              <p
                style={mutedStyle}
                data-testid="integrations-webhooks-empty-state"
              >
                No webhook endpoints yet. Receive event notifications when
                evidence is captured, finalized, or requested.
              </p>
            ) : (
              <ul style={listStyle} data-testid="integrations-webhooks-list">
                {webhooks.map((w) => {
                  const isExpanded = expandedHookId === w.id;
                  return (
                    <li
                      key={w.id}
                      style={{
                        ...rowStyle,
                        flexDirection: "column",
                        alignItems: "stretch",
                      }}
                      data-testid={`integrations-webhook-row-${w.id}`}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          width: "100%",
                        }}
                      >
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
                            <code>{w.secretPrefix}…</code>
                            {" · "}
                            {w.eventTypes.length === 0
                              ? "All events"
                              : `${w.eventTypes.length} event type${w.eventTypes.length === 1 ? "" : "s"}`}{" "}
                            · failures: {w.failureCount}
                            {w.lastSuccessAtUtc
                              ? ` · last success ${new Date(w.lastSuccessAtUtc).toLocaleString()}`
                              : ""}
                          </div>
                          {/* Phase 4 — rotation history surface. While the
                              previous secret is still inside its grace window
                              we show the prior prefix + cutoff so the
                              operator knows receivers have until <cutoff> to
                              switch over. */}
                          {w.previousSecretPrefix &&
                          w.previousSecretValidUntilUtc ? (
                            <div
                              style={{
                                ...mutedStyle,
                                color: "#0369a1",
                              }}
                              data-testid={`integrations-webhook-grace-${w.id}`}
                            >
                              Previous secret{" "}
                              <code>{w.previousSecretPrefix}…</code> still
                              signing until{" "}
                              {new Date(
                                w.previousSecretValidUntilUtc,
                              ).toLocaleString()}
                            </div>
                          ) : null}
                        </div>
                        <span style={statusBadgeStyle(w.status)}>
                          {w.status}
                        </span>
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          onClick={() =>
                            isExpanded
                              ? closeDeliveriesPanel()
                              : void openDeliveriesPanel(w.id)
                          }
                          data-testid={`integrations-webhook-deliveries-toggle-${w.id}`}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? "Hide deliveries" : "Deliveries"}
                        </button>
                        {w.status === "ACTIVE" ? (
                          <>
                            <button
                              type="button"
                              style={secondaryButtonStyle}
                              disabled={sendingTestForId === w.id}
                              onClick={() => void sendWebhookTestEvent(w.id)}
                              data-testid={`integrations-webhook-test-${w.id}`}
                            >
                              {sendingTestForId === w.id
                                ? "Sending…"
                                : "Send test"}
                            </button>
                            <button
                              type="button"
                              style={secondaryButtonStyle}
                              onClick={() => setRotateWebhookForId(w.id)}
                              data-testid={`integrations-webhook-rotate-${w.id}`}
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
                        ) : (
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            onClick={() => void enableWebhook(w.id)}
                            data-testid={`integrations-webhook-enable-${w.id}`}
                          >
                            Enable
                          </button>
                        )}
                      </div>
                      {isExpanded ? (
                        <WebhookDeliveriesPanel
                          endpointId={w.id}
                          deliveries={deliveriesByEndpoint[w.id]}
                          loading={deliveriesLoadingFor === w.id}
                          error={deliveriesErrorByEndpoint[w.id] ?? null}
                          retryingDeliveryId={retryingDeliveryId}
                          onRefresh={() => void openDeliveriesPanel(w.id)}
                          onRetry={(deliveryId) =>
                            void retryWebhookDelivery(w.id, deliveryId)
                          }
                          onSendTest={
                            w.status === "ACTIVE"
                              ? () => void sendWebhookTestEvent(w.id)
                              : null
                          }
                          sendingTest={sendingTestForId === w.id}
                        />
                      ) : null}
                    </li>
                  );
                })}
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
      {revokeReasonForId ? (
        <RevokeApiKeyDialog
          credential={apiKeys?.find((k) => k.id === revokeReasonForId) ?? null}
          onCancel={() => setRevokeReasonForId(null)}
          onSubmit={(reason) =>
            void submitRevokeApiKey(revokeReasonForId, reason)
          }
        />
      ) : null}
      {rotateForId ? (
        <RotateApiKeyDialog
          credential={apiKeys?.find((k) => k.id === rotateForId) ?? null}
          onCancel={() => setRotateForId(null)}
          onSubmit={(graceMinutes) =>
            void submitRotateApiKey(rotateForId, graceMinutes)
          }
        />
      ) : null}
      {rotateWebhookForId ? (
        <RotateWebhookDialog
          webhook={
            webhooks?.find((w) => w.id === rotateWebhookForId) ?? null
          }
          onCancel={() => setRotateWebhookForId(null)}
          onSubmit={(graceMinutes) => {
            const hook = webhooks?.find((w) => w.id === rotateWebhookForId);
            if (!hook) return;
            void submitRotateWebhookSecret(hook.id, hook.url, graceMinutes);
          }}
        />
      ) : null}
      {expiryForId ? (
        <ApiKeyExpiryDialog
          credential={apiKeys?.find((k) => k.id === expiryForId) ?? null}
          onCancel={() => setExpiryForId(null)}
          onSubmit={(value) => void submitApiKeyExpiry(expiryForId, value)}
        />
      ) : null}
      {usageForId ? (
        <ApiKeyUsageDialog
          credential={apiKeys?.find((k) => k.id === usageForId) ?? null}
          rows={usageRows}
          error={usageError}
          onClose={() => {
            setUsageForId(null);
            setUsageRows(null);
            setUsageError(null);
          }}
        />
      ) : null}
    </main>
  );
}

// -----------------------------------------------------------------------------
// PHASE 5 — Health summary card.
//
// Fetches GET /v1/integrations/health every 60s and renders a tile per
// metric. EVERY value is sourced from the server snapshot — there is
// no derivation on the client. Fields that the server omits
// (an average-latency tile, intentionally absent because the deliveries
// table has no per-delivery latency column) are never rendered as
// zero or "Loading"; they simply do not appear.
//
// Display rules:
//   - A metric that is `null` on the server renders as the canonical
//     "—" placeholder, NOT "0" and NOT "Loading".
//   - A workspace with literally zero activity (no api keys, no
//     webhooks, no deliveries) renders the empty-state copy
//     "No activity in this workspace yet." rather than a wall of zeros.
//   - While the FIRST fetch is in flight we show "Loading…". After the
//     first successful response we never show "Loading…" again — even
//     during background refreshes we keep the last good values visible
//     so the dashboard never flickers.
// -----------------------------------------------------------------------------

// PHASE 5 — exact shape of the snapshot returned by GET /v1/integrations/health.
// Mirrors `IntegrationsHealthSnapshot` in integration-health.service.ts.
//
// Phase closure — `averageLatencyMsLast24h` is sourced from the new
// `response_duration_ms` column the dispatcher writes around each
// outbound HTTP attempt. Rows that never issued the outbound fetch
// (e.g. signing_key_unavailable) leave the column NULL and are
// excluded from the average. When no row in the window has a non-null
// duration the field is `null` and renders as the canonical "—"
// placeholder — NEVER "0 ms", which would falsely imply free latency.
type IntegrationsHealthSnapshot = {
  teamId: string;
  generatedAtUtc: string;
  windowHours: number;
  activeApiKeys: number;
  revokedApiKeys: number;
  keysUsedLast24h: number;
  activeWebhooks: number;
  disabledWebhooks: number;
  deliveriesLast24h: number;
  successRateLast24h: number | null;
  failedDeliveriesLast24h: number;
  endpointsCurrentlyFailing: number;
  pendingOrRetryScheduledCount: number;
  oldestPendingDeliveryAt: string | null;
  lastSuccessfulDeliveryAt: string | null;
  lastFailedDeliveryAt: string | null;
  averageLatencyMsLast24h: number | null;
};

// PHASE 5 — auto-refresh interval. Reuses a plain useEffect interval;
// no shared polling primitive existed in this surface area.
const INTEGRATIONS_HEALTH_REFRESH_MS = 60_000;

// PHASE 5 — canonical placeholder for absent / null metrics. Never "0",
// never "Loading". A test pins this so future copy edits cannot
// regress it to a misleading value.
const HEALTH_METRIC_MISSING_PLACEHOLDER = "—";

function HealthSummary({ teamId }: { teamId: string }) {
  const [snapshot, setSnapshot] =
    useState<IntegrationsHealthSnapshot | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    async function load() {
      try {
        const res: { health: IntegrationsHealthSnapshot } = await apiFetch(
          `/v1/integrations/health?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        );
        if (cancelled) return;
        setSnapshot(res.health);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        // We deliberately keep the previous snapshot visible on a
        // refresh failure — flicker-free dashboard. A one-line muted
        // hint replaces the chrome until the next interval succeeds.
        const e = err as { message?: string };
        setLoadError(e?.message ?? "Could not refresh health metrics.");
      } finally {
        if (!cancelled) setHasLoadedOnce(true);
      }
    }
    void load();
    const handle = window.setInterval(() => {
      void load();
    }, INTEGRATIONS_HEALTH_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [teamId]);

  if (!hasLoadedOnce && snapshot === null) {
    return (
      <section style={cardStyle} data-testid="integrations-health-card">
        <h2 style={sectionTitleStyle}>Health</h2>
        <p style={mutedStyle}>Loading…</p>
      </section>
    );
  }

  if (snapshot === null) {
    // First fetch failed AND no prior snapshot is cached. Render a
    // friendly empty state with the error reason as a muted hint.
    return (
      <section style={cardStyle} data-testid="integrations-health-card">
        <h2 style={sectionTitleStyle}>Health</h2>
        <p
          style={mutedStyle}
          data-testid="integrations-health-empty-state"
        >
          No activity in this workspace yet.
        </p>
        {loadError ? (
          <p
            style={{ ...mutedStyle, marginTop: 8 }}
            data-testid="integrations-health-load-error"
          >
            Could not load the latest snapshot. Retrying in the
            background.
          </p>
        ) : null}
      </section>
    );
  }

  const totalKeys = snapshot.activeApiKeys + snapshot.revokedApiKeys;
  const totalHooks = snapshot.activeWebhooks + snapshot.disabledWebhooks;
  const hasAnyActivity =
    totalKeys > 0 ||
    totalHooks > 0 ||
    snapshot.deliveriesLast24h > 0 ||
    snapshot.pendingOrRetryScheduledCount > 0 ||
    snapshot.lastSuccessfulDeliveryAt !== null ||
    snapshot.lastFailedDeliveryAt !== null;

  if (!hasAnyActivity) {
    return (
      <section style={cardStyle} data-testid="integrations-health-card">
        <h2 style={sectionTitleStyle}>Health</h2>
        <p
          style={mutedStyle}
          data-testid="integrations-health-empty-state"
        >
          No activity in this workspace yet.
        </p>
      </section>
    );
  }

  const successRateLabel = formatHealthRate(snapshot.successRateLast24h);
  const oldestPendingLabel = formatHealthInstant(
    snapshot.oldestPendingDeliveryAt,
  );
  const lastSuccessLabel = formatHealthInstant(
    snapshot.lastSuccessfulDeliveryAt,
  );
  const lastFailureLabel = formatHealthInstant(
    snapshot.lastFailedDeliveryAt,
  );
  const averageLatencyLabel = formatHealthLatencyMs(
    snapshot.averageLatencyMsLast24h,
  );

  return (
    <section style={cardStyle} data-testid="integrations-health-card">
      <h2 style={sectionTitleStyle}>Health</h2>
      <div style={summaryGridStyle}>
        <SummaryStat
          label="API keys (active)"
          value={String(snapshot.activeApiKeys)}
          testId="integrations-health-active-api-keys"
        />
        <SummaryStat
          label="API keys (revoked)"
          value={String(snapshot.revokedApiKeys)}
          testId="integrations-health-revoked-api-keys"
        />
        <SummaryStat
          label="Keys used (last 24h)"
          value={String(snapshot.keysUsedLast24h)}
          testId="integrations-health-keys-used-24h"
        />
        <SummaryStat
          label="Webhooks (active)"
          value={String(snapshot.activeWebhooks)}
          testId="integrations-health-active-webhooks"
        />
        <SummaryStat
          label="Webhooks (disabled)"
          value={String(snapshot.disabledWebhooks)}
          testId="integrations-health-disabled-webhooks"
        />
        <SummaryStat
          label="Deliveries (last 24h)"
          value={String(snapshot.deliveriesLast24h)}
          testId="integrations-health-deliveries-24h"
        />
        <SummaryStat
          label="Success rate (last 24h)"
          value={successRateLabel}
          tone={
            snapshot.successRateLast24h !== null &&
            snapshot.successRateLast24h < 0.9
              ? "warn"
              : "neutral"
          }
          testId="integrations-health-success-rate-24h"
        />
        <SummaryStat
          label="Failed deliveries (last 24h)"
          value={String(snapshot.failedDeliveriesLast24h)}
          tone={snapshot.failedDeliveriesLast24h > 0 ? "warn" : "neutral"}
          testId="integrations-health-failed-24h"
        />
        <SummaryStat
          label="Endpoints currently failing"
          value={String(snapshot.endpointsCurrentlyFailing)}
          tone={
            snapshot.endpointsCurrentlyFailing > 0 ? "warn" : "neutral"
          }
          testId="integrations-health-endpoints-failing"
        />
        <SummaryStat
          label="Pending or retry-scheduled"
          value={String(snapshot.pendingOrRetryScheduledCount)}
          testId="integrations-health-pending-or-retry"
        />
        <SummaryStat
          label="Oldest pending delivery"
          value={oldestPendingLabel}
          testId="integrations-health-oldest-pending"
        />
        <SummaryStat
          label="Last successful delivery"
          value={lastSuccessLabel}
          testId="integrations-health-last-success"
        />
        <SummaryStat
          label="Last failed delivery"
          value={lastFailureLabel}
          testId="integrations-health-last-failure"
        />
        <SummaryStat
          label="Avg latency (24h)"
          value={averageLatencyLabel}
          testId="integrations-health-avg-latency-24h"
        />
      </div>
      {loadError ? (
        <p
          style={{ ...mutedStyle, marginTop: 8 }}
          data-testid="integrations-health-refresh-error"
        >
          Could not refresh the snapshot just now. Last good values
          shown — retrying in the background.
        </p>
      ) : null}
    </section>
  );
}

// PHASE 5 — null-aware percentage formatter. Returns the canonical
// placeholder when the server signalled "no denominator yet", so the
// dashboard never displays a misleading "0%" rate.
function formatHealthRate(rate: number | null): string {
  if (rate === null) return HEALTH_METRIC_MISSING_PLACEHOLDER;
  const pct = Math.round(rate * 1000) / 10; // one decimal
  return `${pct}%`;
}

// PHASE 5 — null-aware ISO timestamp formatter. Returns the canonical
// placeholder when the server reported no row.
function formatHealthInstant(iso: string | null): string {
  if (iso === null) return HEALTH_METRIC_MISSING_PLACEHOLDER;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return HEALTH_METRIC_MISSING_PLACEHOLDER;
  return new Date(t).toLocaleString();
}

// PHASE closure — null-aware millisecond latency formatter. Returns
// the canonical placeholder when the server reported no measured
// duration in the window (no traffic, or every attempt failed before
// the outbound fetch). NEVER renders "0 ms" for a missing value — a
// real 0ms average would only appear if every receiver responded in
// under a millisecond, which the dispatcher's monotonic timer can
// distinguish from the no-data case.
function formatHealthLatencyMs(ms: number | null): string {
  if (ms === null) return HEALTH_METRIC_MISSING_PLACEHOLDER;
  if (!Number.isFinite(ms)) return HEALTH_METRIC_MISSING_PLACEHOLDER;
  return `${ms} ms`;
}

function SummaryStat({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
  testId?: string;
}) {
  return (
    <div style={summaryStatStyle} data-testid={testId}>
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

// PHASE 7 — canonical Node receiver verifier. Pinned by a copy-vs-doc
// regression test (services/api/test/phase7-integrations-ux-polish.test.ts)
// so the snippet on this page cannot drift from the documented
// header semantics (dual-signature parse + timingSafeEqual).
const NODE_VERIFIER_SNIPPET = `// Node.js (>=18) — minimal Proovra webhook receiver verifier.
// Compares each comma-separated signature entry in constant time so
// a malicious receiver cannot extract bytes by timing.
import crypto from "node:crypto";

const TIMESTAMP_TOLERANCE_MS = 5 * 60_000; // 5 minutes

export function verifyProovraWebhook({
  rawBody,         // Buffer or string — the EXACT bytes you received
  headers,         // req.headers
  rawSecret,       // your stored "pwhsec_v1_..." value
}) {
  const ts = headers["x-proovra-timestamp"];
  const sig = headers["x-proovra-signature"];
  if (typeof ts !== "string" || typeof sig !== "string") return false;
  // Replay protection — reject anything outside the tolerance window.
  const ageMs = Date.now() - Number.parseInt(ts, 10);
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > TIMESTAMP_TOLERANCE_MS) {
    return false;
  }
  // Canonical signing base: "<timestampMs>.<rawBody>".
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected =
    "v1=" + crypto.createHmac("sha256", rawSecret).update(ts + "." + body).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  // Multi-sig parse — during a rotation grace window the header is
  // "v1=<new>,v1=<old>". Accept the request if ANY entry matches.
  for (const entry of sig.split(",")) {
    const candidate = Buffer.from(entry.trim(), "utf8");
    if (
      candidate.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidate, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}`;

function SignatureDocsPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section style={cardStyle} data-testid="integrations-signature-docs-panel">
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
          data-testid="integrations-signature-docs-toggle"
          aria-expanded={open}
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
              <code>X-Proovra-Signature</code> —{" "}
              <code>v1=&lt;hex&gt;</code> in steady state, or{" "}
              <code>v1=&lt;new&gt;,v1=&lt;old&gt;</code> during a
              rotation grace window.
            </li>
          </ul>

          <h3 style={subHeadingStyle}>Verifier (Node.js)</h3>
          <p style={mutedStyle}>
            Conceptually: take{" "}
            <code>{`const entries = signature_header.split(",")`}</code>
            , compute the expected <code>v1=&lt;hex&gt;</code> for your
            stored raw secret, and accept the request if{" "}
            <code>entries.some(...)</code> matches in constant time.
            Below is a minimal reference implementation using{" "}
            <code>crypto.timingSafeEqual</code> — it keeps working
            through a rotation grace window without any code changes
            because it iterates over every entry.
          </p>
          <pre
            style={codeBlockStyle}
            data-testid="integrations-signature-docs-node-verifier"
          >
            {NODE_VERIFIER_SNIPPET}
          </pre>

          <h3 style={subHeadingStyle}>Idempotency</h3>
          <p style={mutedStyle}>
            The same event MAY be delivered more than once after a
            transient failure. Use <code>X-Proovra-Event-Id</code> as
            an idempotency key — if you have already processed an event
            id, ack with 2xx and discard the duplicate. Never trust a
            duplicate event id twice.
          </p>

          <h3 style={subHeadingStyle}>Timestamp tolerance</h3>
          <p style={mutedStyle}>
            Reject deliveries whose <code>X-Proovra-Timestamp</code> is
            older than 5 minutes (or from the future by more than 1
            minute) to prevent replay. The reference verifier above
            already enforces a 5-minute window in both directions.
          </p>

          <h3 style={subHeadingStyle}>Retry behavior</h3>
          <p style={mutedStyle}>
            Any non-2xx response (or a network error) marks the delivery
            as failed and schedules an exponential backoff retry. After
            enough consecutive failures the dispatcher auto-disables the
            endpoint and surfaces it in the &ldquo;Needs attention&rdquo;
            page banner. Always return a 2xx response as soon as you
            have persisted the event id; deferred work belongs on your
            own queue.
          </p>

          <h3 style={subHeadingStyle}>Delivery history</h3>
          <p style={mutedStyle}>
            Click <strong>Deliveries</strong> on any endpoint to see the
            last 25 attempts: status, attempt count, response code, and
            (when present) the error message. Use{" "}
            <strong>Retry</strong> on a FAILED row to force a fresh
            attempt without waiting for the scheduler.
          </p>

          <h3 style={subHeadingStyle}>Test events</h3>
          <p style={mutedStyle}>
            <strong>Send test</strong> dispatches a synthetic event
            (<code>webhook.test</code>) through the same signing and
            retry path as production traffic. The deliveries panel
            tags the row so it is easy to recognise. Subscription
            filters are bypassed — the test always goes to the targeted
            endpoint as long as it is ACTIVE.
          </p>

          <h3 style={subHeadingStyle}>Secret rotation</h3>
          <p style={mutedStyle}>
            <strong>Rotate secret</strong> issues a new raw signing
            secret and keeps the previous secret signing alongside it
            for the grace window you pick (default 60 minutes, max 24
            hours). During the window the{" "}
            <code>X-Proovra-Signature</code> header carries two
            comma-separated entries (<code>v1=&lt;new&gt;,v1=&lt;old&gt;</code>)
            so receivers can roll the new value into production without
            dropping events. After the cutoff only the new secret signs.
            The new raw secret is shown <strong>exactly once</strong>{" "}
            in the disclosure banner — store it in your own credential
            vault immediately.
          </p>
        </div>
      ) : (
        <p style={mutedStyle}>
          Verification scheme, multi-sig rotation grace window,
          idempotency, replay protection, retry/delivery history, test
          events, and a Node.js reference verifier.
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
    | {
        kind: "api_key_rotated";
        rawKey: string;
        name: string;
        previousKeyPrefix: string;
        previousValidUntilUtc: string;
      }
    | { kind: "webhook"; rawSecret: string; url: string }
    | {
        kind: "webhook_rotated";
        rawSecret: string;
        url: string;
        previousSecretPrefix: string;
        previousSecretValidUntilUtc: string;
      };
  onClose: () => void;
}) {
  const isWebhook =
    disclosed.kind === "webhook" || disclosed.kind === "webhook_rotated";
  const raw =
    disclosed.kind === "webhook" || disclosed.kind === "webhook_rotated"
      ? disclosed.rawSecret
      : disclosed.rawKey;
  const label = isWebhook ? "Webhook signing secret" : "API key";
  const context =
    disclosed.kind === "webhook" || disclosed.kind === "webhook_rotated"
      ? `for ${disclosed.url}`
      : `for "${disclosed.name}"`;
  return (
    <div style={disclosureBoxStyle} role="alert" data-testid="integrations-disclosure-banner">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Save this {label} now
      </div>
      <div style={mutedStyle}>
        {context}. This value is shown exactly once and cannot be
        recovered. Store it in your own credential vault.
      </div>
      <code style={codeBlockStyle}>{raw}</code>
      {disclosed.kind === "api_key_rotated" ? (
        <p
          style={{
            ...mutedStyle,
            marginTop: 8,
            marginBottom: 0,
          }}
          data-testid="integrations-rotation-grace-hint"
        >
          The previous key (
          <code>{disclosed.previousKeyPrefix}…</code>) will keep working
          until{" "}
          <strong>
            {new Date(disclosed.previousValidUntilUtc).toLocaleString()}
          </strong>
          . After that moment only the new key above is accepted.
        </p>
      ) : null}
      {disclosed.kind === "webhook_rotated" ? (
        <p
          style={{
            ...mutedStyle,
            marginTop: 8,
            marginBottom: 0,
          }}
          data-testid="integrations-webhook-rotation-grace-hint"
        >
          Outbound events will be signed with{" "}
          <strong>both</strong> the new secret above AND the previous
          secret (<code>{disclosed.previousSecretPrefix}…</code>) until{" "}
          <strong>
            {new Date(disclosed.previousSecretValidUntilUtc).toLocaleString()}
          </strong>
          . The <code>X-Proovra-Signature</code> header carries a
          comma-separated list <code>v1=&lt;new&gt;,v1=&lt;old&gt;</code>{" "}
          during the window so receivers can switch over without dropping
          events. After the cutoff only the new secret signs.
        </p>
      ) : null}
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
// PHASE 2 — API key list table.
//
// Renders the columns required by the operator runbook: name, prefix, status,
// scopes, created-by, createdAt, lastUsed, expiresAt, rotationRequired,
// ipAllowlist (when populated), and dual-active grace cutoff (when populated).
// The action buttons (Rotate / Expiry / Usage / Revoke) only render for
// non-REVOKED rows. Revoked rows surface the persisted reason inline so
// operators can see WHY the key was revoked without opening anything.
// -----------------------------------------------------------------------------

function ApiKeysTable({
  rows,
  onRevoke,
  onRotate,
  onExpiry,
  onUsage,
}: {
  rows: ApiKey[];
  onRevoke: (id: string) => void;
  onRotate: (id: string) => void;
  onExpiry: (id: string) => void;
  onUsage: (id: string) => void;
}) {
  return (
    <ul style={listStyle} data-testid="integrations-api-keys-list">
      {rows.map((k) => {
        const expiry = k.expiresAtUtc ? new Date(k.expiresAtUtc) : null;
        const expiryExpired = expiry !== null && expiry.getTime() < Date.now();
        const grace = k.previousValidUntilUtc
          ? new Date(k.previousValidUntilUtc)
          : null;
        const graceActive = grace !== null && grace.getTime() > Date.now();
        return (
          <li
            key={k.id}
            style={rowStyle}
            data-testid={`integrations-api-key-row-${k.id}`}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {k.name}{" "}
                {k.rotationRequired ? (
                  <span style={chipWarn} data-testid="api-key-rotation-required">
                    rotation required
                  </span>
                ) : null}
              </div>
              <div style={mutedStyle}>
                <code>{k.keyPrefix}…</code>{" "}
                {k.scopes.length > 0 ? (
                  <>
                    · <span title={k.scopes.join(", ")}>
                      {k.scopes.length} scope
                      {k.scopes.length === 1 ? "" : "s"}
                    </span>
                  </>
                ) : null}{" "}
                · created {new Date(k.createdAt).toLocaleDateString()}
                {k.lastUsedAtUtc ? (
                  <> · last used {new Date(k.lastUsedAtUtc).toLocaleString()}</>
                ) : (
                  <> · never used</>
                )}
              </div>
              <div style={mutedStyle}>
                {expiry ? (
                  <>
                    expires {expiry.toLocaleString()}
                    {expiryExpired ? " (expired)" : ""}
                  </>
                ) : (
                  <>no expiry</>
                )}
                {k.ipAllowlist.length > 0 ? (
                  <>
                    {" "}· IP allowlist: {k.ipAllowlist.length} entr
                    {k.ipAllowlist.length === 1 ? "y" : "ies"}
                  </>
                ) : null}
              </div>
              {graceActive && k.previousKeyPrefix ? (
                <div style={mutedStyle} data-testid="api-key-previous-grace">
                  Previous key <code>{k.previousKeyPrefix}…</code> accepted
                  until {grace!.toLocaleString()}.
                </div>
              ) : null}
              {k.status === "REVOKED" && k.revokedReason ? (
                <div style={mutedStyle} data-testid="api-key-revoked-reason">
                  Revoked reason: {k.revokedReason}
                </div>
              ) : null}
            </div>
            <span style={statusBadgeStyle(k.status)}>{k.status}</span>
            {k.status === "ACTIVE" ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => onUsage(k.id)}
                  data-testid={`api-key-usage-${k.id}`}
                >
                  Usage
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => onExpiry(k.id)}
                  data-testid={`api-key-expiry-${k.id}`}
                >
                  Expiry
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => onRotate(k.id)}
                  data-testid={`api-key-rotate-${k.id}`}
                >
                  Rotate
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => onRevoke(k.id)}
                  data-testid={`api-key-revoke-${k.id}`}
                >
                  Revoke
                </button>
              </div>
            ) : (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => onUsage(k.id)}
                data-testid={`api-key-usage-${k.id}`}
              >
                Usage
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// PHASE 2 — Revoke dialog with required reason field.
//
// The reason is OPTIONAL on the wire (the API accepts null) but the dialog
// strongly encourages providing one — operators are reminded that the
// reason is persisted to the audit log and is visible in the revoked-state
// row inline.
// -----------------------------------------------------------------------------

function RevokeApiKeyDialog({
  credential,
  onCancel,
  onSubmit,
}: {
  credential: ApiKey | null;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  if (!credential) return null;
  return (
    <div
      style={modalBackdropStyle}
      role="dialog"
      aria-modal
      data-testid="integrations-api-key-revoke-dialog"
    >
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>Revoke API key</h3>
        <p style={mutedStyle}>
          Revoking <strong>{credential.name}</strong> (
          <code>{credential.keyPrefix}…</code>) stops it from authenticating
          immediately. This is permanent — issue a new key to replace it.
        </p>
        <Field label="Reason (recorded in audit log)">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 400))}
            placeholder="e.g. Compromised in incident #1234"
            autoFocus
            data-testid="integrations-api-key-revoke-reason"
          />
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
            style={dangerButtonStyle}
            onClick={() => onSubmit(reason)}
            data-testid="integrations-api-key-revoke-confirm"
          >
            Revoke key
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PHASE 2 — Rotation dialog (true dual-active).
//
// The operator picks a grace window in minutes [1, 1440]. We pre-fill with
// 60 minutes (the server's default) and clamp the slider on the client.
// Confirming surfaces the new raw key via the disclosure banner ONCE.
// -----------------------------------------------------------------------------

const ROTATION_GRACE_PRESETS = [
  { label: "5 min", minutes: 5 },
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 360 },
  { label: "24 hours", minutes: 1440 },
] as const;

function RotateApiKeyDialog({
  credential,
  onCancel,
  onSubmit,
}: {
  credential: ApiKey | null;
  onCancel: () => void;
  onSubmit: (graceMinutes: number) => void;
}) {
  const [graceMinutes, setGraceMinutes] = useState<number>(60);
  if (!credential) return null;
  return (
    <div
      style={modalBackdropStyle}
      role="dialog"
      aria-modal
      data-testid="integrations-api-key-rotate-dialog"
    >
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>Rotate API key</h3>
        <p style={mutedStyle}>
          Generates a new raw key for <strong>{credential.name}</strong>. The
          old key (<code>{credential.keyPrefix}…</code>) will keep working
          alongside the new one for the grace window below, then stop. The new
          key is shown exactly once after you confirm.
        </p>
        <Field label="Grace window for the previous key">
          <div
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
            role="group"
            aria-label="Rotation grace window"
          >
            {ROTATION_GRACE_PRESETS.map((p) => (
              <button
                key={p.minutes}
                type="button"
                style={
                  graceMinutes === p.minutes
                    ? primaryButtonStyle
                    : secondaryButtonStyle
                }
                onClick={() => setGraceMinutes(p.minutes)}
                data-testid={`integrations-rotate-grace-${p.minutes}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={1}
            max={1440}
            value={graceMinutes}
            onChange={(e) => {
              const n = Math.max(
                1,
                Math.min(1440, Number.parseInt(e.target.value, 10) || 1),
              );
              setGraceMinutes(n);
            }}
            style={{ ...inputStyle, marginTop: 8 }}
            data-testid="integrations-rotate-grace-minutes"
          />
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
            onClick={() => onSubmit(graceMinutes)}
            data-testid="integrations-api-key-rotate-confirm"
          >
            Rotate key
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PHASE 4 — Webhook rotation dialog (dual-signing).
//
// The operator picks a grace window in minutes [1, 1440] (default 60,
// the server's default). During the window every outbound delivery is
// signed with BOTH the new secret and the previous secret, and the
// `X-Proovra-Signature` header carries a comma-separated multi-sig
// `v1=<new>,v1=<old>`. After the cutoff the dispatcher reverts to
// single-sign with the new secret.
// -----------------------------------------------------------------------------

function RotateWebhookDialog({
  webhook,
  onCancel,
  onSubmit,
}: {
  webhook: Webhook | null;
  onCancel: () => void;
  onSubmit: (graceMinutes: number) => void;
}) {
  const [graceMinutes, setGraceMinutes] = useState<number>(60);
  if (!webhook) return null;
  return (
    <div
      style={modalBackdropStyle}
      role="dialog"
      aria-modal
      data-testid="integrations-webhook-rotate-dialog"
    >
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>Rotate webhook signing secret</h3>
        <p style={mutedStyle}>
          Generates a new raw signing secret for{" "}
          <strong style={{ wordBreak: "break-all" }}>{webhook.url}</strong>.
          During the grace window below, outbound events will be signed
          with <strong>both</strong> the new secret and the previous
          secret (<code>{webhook.secretPrefix}…</code>) so receivers can
          roll the new value into production without dropping events.
          The new raw secret is shown exactly once after you confirm.
        </p>
        <p
          style={{
            ...mutedStyle,
            backgroundColor: "#ecfeff",
            border: "1px solid #a5f3fc",
            borderRadius: 6,
            padding: 8,
          }}
        >
          The <code>X-Proovra-Signature</code> header will carry
          a comma-separated list{" "}
          <code>v1=&lt;new&gt;,v1=&lt;old&gt;</code> while the window is
          open. Update your verifier to accept either entry before the
          cutoff. After the cutoff only the new secret signs.
        </p>
        <Field label="Grace window (both signatures will be emitted)">
          <div
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
            role="group"
            aria-label="Rotation grace window"
          >
            {ROTATION_GRACE_PRESETS.map((p) => (
              <button
                key={p.minutes}
                type="button"
                style={
                  graceMinutes === p.minutes
                    ? primaryButtonStyle
                    : secondaryButtonStyle
                }
                onClick={() => setGraceMinutes(p.minutes)}
                data-testid={`integrations-webhook-rotate-grace-${p.minutes}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={1}
            max={1440}
            value={graceMinutes}
            onChange={(e) => {
              const n = Math.max(
                1,
                Math.min(1440, Number.parseInt(e.target.value, 10) || 1),
              );
              setGraceMinutes(n);
            }}
            style={{ ...inputStyle, marginTop: 8 }}
            data-testid="integrations-webhook-rotate-grace-minutes"
          />
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
            onClick={() => onSubmit(graceMinutes)}
            data-testid="integrations-webhook-rotate-confirm"
          >
            Rotate secret
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PHASE 2 — Expiry management dialog.
//
// Operator can SET a future expiry (ISO datetime) or CLEAR it. The server
// emits an integration.api_key.expiry_changed audit event whichever branch
// runs. Past-dated expiries are accepted (operators sometimes want a key
// to expire immediately as a soft revoke) but the dialog highlights when
// the chosen value is already in the past.
// -----------------------------------------------------------------------------

function ApiKeyExpiryDialog({
  credential,
  onCancel,
  onSubmit,
}: {
  credential: ApiKey | null;
  onCancel: () => void;
  onSubmit: (expiresAtUtc: string | null) => void;
}) {
  const [value, setValue] = useState<string>(() => {
    if (!credential?.expiresAtUtc) return "";
    // Convert ISO to value compatible with <input type="datetime-local">
    const d = new Date(credential.expiresAtUtc);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  if (!credential) return null;
  const parsed = value ? new Date(value) : null;
  const parsedInPast =
    parsed !== null &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.getTime() < Date.now();
  return (
    <div
      style={modalBackdropStyle}
      role="dialog"
      aria-modal
      data-testid="integrations-api-key-expiry-dialog"
    >
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>Manage expiry</h3>
        <p style={mutedStyle}>
          When set, <strong>{credential.name}</strong> auto-rejects every
          authentication attempt after the chosen moment. Clear it to remove
          the cap.
        </p>
        <Field label="Expiry (local time)">
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={inputStyle}
            data-testid="integrations-api-key-expiry-input"
          />
        </Field>
        {parsedInPast ? (
          <p style={{ ...mutedStyle, color: "#b45309" }}>
            That moment is in the past — the credential will reject every call
            as soon as you save.
          </p>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => onSubmit(null)}
            data-testid="integrations-api-key-expiry-clear"
          >
            Clear expiry
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={value.trim().length === 0}
            onClick={() => {
              if (!parsed || Number.isNaN(parsed.getTime())) return;
              onSubmit(parsed.toISOString());
            }}
            data-testid="integrations-api-key-expiry-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PHASE 2 — Usage details dialog.
//
// Consumes GET /v1/integrations/api-keys/:id/usage. Shows the recent
// per-call audit trail: route + method + action + statusCode + success +
// failure reason + request id. Renders a clean placeholder if there are no
// rows; never surfaces raw JSON. On fetch failure the dialog shows an
// operator-readable message — the parent passes the message through
// directly, no raw error blob.
// -----------------------------------------------------------------------------

function ApiKeyUsageDialog({
  credential,
  rows,
  error,
  onClose,
}: {
  credential: ApiKey | null;
  rows: ApiKeyUsageRow[] | null;
  error: string | null;
  onClose: () => void;
}) {
  if (!credential) return null;
  return (
    <div
      style={modalBackdropStyle}
      role="dialog"
      aria-modal
      data-testid="integrations-api-key-usage-dialog"
    >
      <div style={{ ...modalStyle, maxWidth: 640 }}>
        <h3 style={sectionTitleStyle}>Usage — {credential.name}</h3>
        <p style={mutedStyle}>
          Recent calls authenticated by this credential. Limited to the last
          50 events.
        </p>
        {error ? (
          <p style={{ ...mutedStyle, color: "#7f1d1d" }}>{error}</p>
        ) : rows === null ? (
          <p style={mutedStyle}>Loading usage…</p>
        ) : rows.length === 0 ? (
          <p style={mutedStyle} data-testid="integrations-api-key-usage-empty">
            No recorded calls yet. The first authenticated request will appear
            here.
          </p>
        ) : (
          <ul
            style={{ ...listStyle, maxHeight: 320, overflowY: "auto" }}
            data-testid="integrations-api-key-usage-list"
          >
            {rows.map((u) => (
              <li
                key={u.id}
                style={{ padding: "8px 0", borderBottom: "1px solid #e2e8f0" }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <div
                    style={{ fontWeight: 600, fontSize: 13, minWidth: 0 }}
                  >
                    <code>{u.method}</code> <code>{u.routePath}</code>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <span style={u.success ? chipOk : chipDanger}>
                      {u.statusCode}
                    </span>
                  </div>
                </div>
                <div style={mutedStyle}>
                  {u.action}
                  {u.failureReason ? <> · reason: {u.failureReason}</> : null}{" "}
                  · {new Date(u.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button type="button" style={primaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Phase 3 — Webhook deliveries panel
//
// Renders the last 25 deliveries for a single endpoint with a Retry
// button on FAILED / RETRY_SCHEDULED rows and a Send-test-event
// button at the top for ACTIVE endpoints. Columns:
//
//   createdAt · eventType · eventId (truncated) · status ·
//   attempts · responseStatus · nextAttempt · errorMessage (truncated)
//
// We DO NOT render the payload — it is workspace-scoped and the
// server projection already drops it. The `errorMessage` and
// `responseBodyPreview` are bounded by the server projection.
// -----------------------------------------------------------------------------

function WebhookDeliveriesPanel({
  endpointId,
  deliveries,
  loading,
  error,
  retryingDeliveryId,
  onRefresh,
  onRetry,
  onSendTest,
  sendingTest,
}: {
  endpointId: string;
  deliveries: WebhookDelivery[] | undefined;
  loading: boolean;
  error: string | null;
  retryingDeliveryId: string | null;
  onRefresh: () => void;
  onRetry: (deliveryId: string) => void;
  onSendTest: (() => void) | null;
  sendingTest: boolean;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
      }}
      data-testid={`integrations-webhook-deliveries-panel-${endpointId}`}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          Recent deliveries (last 25)
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {onSendTest ? (
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={onSendTest}
              disabled={sendingTest}
              data-testid={`integrations-webhook-deliveries-panel-test-${endpointId}`}
            >
              {sendingTest ? "Sending…" : "Send test event"}
            </button>
          ) : null}
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={onRefresh}
            disabled={loading}
            data-testid={`integrations-webhook-deliveries-panel-refresh-${endpointId}`}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      {error ? (
        <div
          style={{
            ...mutedStyle,
            color: "#7f1d1d",
            padding: "6px 0",
          }}
          data-testid={`integrations-webhook-deliveries-error-${endpointId}`}
        >
          {error}
        </div>
      ) : loading && !deliveries ? (
        <p style={mutedStyle}>Loading deliveries…</p>
      ) : !deliveries || deliveries.length === 0 ? (
        <p
          style={mutedStyle}
          data-testid={`integrations-webhook-deliveries-empty-${endpointId}`}
        >
          No deliveries yet. Send a test event to validate this endpoint.
        </p>
      ) : (
        <ul style={{ ...listStyle, maxHeight: 360, overflowY: "auto" }}>
          {deliveries.map((d) => {
            const isRetryable =
              d.status === "FAILED" || d.status === "RETRY_SCHEDULED";
            const isInflight = retryingDeliveryId === d.id;
            const isTest = d.eventType === WEBHOOK_TEST_EVENT_TYPE;
            return (
              <li
                key={d.id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid #e2e8f0",
                }}
                data-testid={`integrations-webhook-delivery-row-${d.id}`}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <code
                        style={{
                          fontSize: 12,
                          background: "#e2e8f0",
                          padding: "1px 6px",
                          borderRadius: 4,
                        }}
                      >
                        {d.eventType}
                      </code>
                      {isTest ? (
                        <span
                          style={chipWarn}
                          data-testid={`integrations-webhook-delivery-test-chip-${d.id}`}
                        >
                          test
                        </span>
                      ) : null}
                      <span
                        style={
                          d.status === "SENT"
                            ? chipOk
                            : d.status === "FAILED"
                              ? chipDanger
                              : chipWarn
                        }
                      >
                        {d.status}
                      </span>
                      <span style={mutedStyle}>
                        attempts: {d.attemptCount}
                      </span>
                      {typeof d.responseStatus === "number" ? (
                        <span style={mutedStyle}>
                          HTTP {d.responseStatus}
                        </span>
                      ) : null}
                    </div>
                    <div style={mutedStyle}>
                      {new Date(d.createdAt).toLocaleString()} · event{" "}
                      <code>{d.eventId.slice(0, 8)}…</code>
                      {d.nextAttemptAtUtc ? (
                        <>
                          {" "}
                          · next attempt{" "}
                          {new Date(d.nextAttemptAtUtc).toLocaleString()}
                        </>
                      ) : null}
                    </div>
                    {d.errorMessage ? (
                      <div
                        style={{
                          ...mutedStyle,
                          color: "#7f1d1d",
                          marginTop: 4,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={d.errorMessage}
                        data-testid={`integrations-webhook-delivery-error-${d.id}`}
                      >
                        {d.errorMessage.length > 200
                          ? `${d.errorMessage.slice(0, 200)}…`
                          : d.errorMessage}
                      </div>
                    ) : null}
                  </div>
                  {isRetryable ? (
                    <button
                      type="button"
                      style={secondaryButtonStyle}
                      onClick={() => onRetry(d.id)}
                      disabled={isInflight}
                      data-testid={`integrations-webhook-delivery-retry-${d.id}`}
                    >
                      {isInflight ? "Retrying…" : "Retry"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
// PHASE 7 — used inside SignatureDocsPanel to break the new sections
// (idempotency / rotation / retry / etc.) so the panel reads as a
// reference rather than a wall of prose.
const subHeadingStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginTop: 16,
  marginBottom: 4,
  color: "#0f172a",
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
// PHASE 2 — destructive variant used by the revoke dialog. Mirrors the
// danger tone of useConfirmAction for visual consistency.
const dangerButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#b91c1c",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
const chipOk: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  background: "#dcfce7",
  color: "#166534",
  fontSize: 12,
  fontWeight: 600,
};
const chipDanger: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fee2e2",
  color: "#991b1b",
  fontSize: 12,
  fontWeight: 600,
};
const chipWarn: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 999,
  background: "#fef3c7",
  color: "#92400e",
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};
// PHASE 7 — admin-only chip carrying the structured error code beside
// the operator-readable message. Distinct visual treatment so it's
// obvious the code is a machine identifier, not part of the prose.
const errorCodeChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fee2e2",
  color: "#7f1d1d",
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  border: "1px solid #fca5a5",
};
// PHASE 7 — page status banner tones. Three deliberate variants
// matching the three states emitted by `PageStatusBanner`. No raw
// JSON, no unbounded copy.
const pageBannerOkStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  background: "#ecfdf5",
  color: "#065f46",
  border: "1px solid #6ee7b7",
  borderRadius: 8,
  fontSize: 14,
};
const pageBannerNeutralStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  background: "#f1f5f9",
  color: "#0f172a",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 14,
};
const pageBannerWarnStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 14,
};

// -----------------------------------------------------------------------------
// PHASE 7 — Page status banner.
//
// Three states, derived only from canonical signals already on the page:
//
//   - "Disabled"        → integrations feature flag / secret missing
//                         (we render the dedicated IntegrationsDisabledPanel
//                          elsewhere; the banner is rendered for parity so
//                          the top of the page still answers "what state am
//                          I in?" without scrolling).
//   - "Needs attention" → at least one ACTIVE webhook endpoint has
//                         failureCount > 0 (i.e. consecutive failures
//                         in flight). Count of failing endpoints is
//                         derived from the already-loaded `webhooks`
//                         list — no extra fetch, no fabricated metric.
//   - "Enabled"         → none of the above.
//
// The banner deliberately does NOT show the raw failing-endpoint URL
// — operators click into the webhook list for that detail.
// -----------------------------------------------------------------------------

const PAGE_STATUS_BANNER_TEST_ID = "integrations-page-status-banner" as const;

function PageStatusBanner({
  disabled,
  webhooks,
}: {
  disabled: boolean;
  webhooks: Webhook[] | null;
}) {
  // While webhooks are still loading, render nothing — the page already
  // shows the "Loading…" placeholder in the lists below. We don't want
  // a flicker between "Enabled" → "Needs attention" once data arrives.
  if (disabled) {
    return (
      <div
        data-testid={PAGE_STATUS_BANNER_TEST_ID}
        data-status="disabled"
        style={pageBannerNeutralStyle}
        role="status"
      >
        <strong>Disabled</strong> — admin configuration required.
      </div>
    );
  }
  if (webhooks === null) return null;
  const failing = webhooks.filter(
    (w) => w.status === "ACTIVE" && w.failureCount > 0,
  ).length;
  if (failing > 0) {
    return (
      <div
        data-testid={PAGE_STATUS_BANNER_TEST_ID}
        data-status="needs_attention"
        style={pageBannerWarnStyle}
        role="status"
      >
        <strong>Needs attention</strong> — {failing} endpoint
        {failing === 1 ? "" : "s"} failing.
      </div>
    );
  }
  return (
    <div
      data-testid={PAGE_STATUS_BANNER_TEST_ID}
      data-status="enabled"
      style={pageBannerOkStyle}
      role="status"
    >
      <strong>Enabled</strong>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PHASE 7 — Typed error banner.
//
// Renders a concise operator-readable message + an admin-only machine
// code chip. The raw message is never a JSON envelope (the page only
// sets `error` from `e.message` on apiFetch errors, which the API
// emits as a stable string); we belt-and-braces by stripping anything
// that *looks* like a JSON blob ("{" prefix) before render so even a
// future regression cannot leak the envelope to a normal user.
// -----------------------------------------------------------------------------

function IntegrationsErrorBanner({
  message,
  code,
  isAdmin,
}: {
  message: string;
  code: string | null;
  isAdmin: boolean;
}) {
  const safe = (() => {
    const trimmed = message.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return "Could not load integrations.";
    }
    return trimmed.length > 0 ? trimmed : "Could not load integrations.";
  })();
  return (
    <div
      style={errorBoxStyle}
      role="alert"
      data-testid="integrations-error-banner"
    >
      <span>{safe}</span>
      {isAdmin && code ? (
        <span
          style={errorCodeChipStyle}
          data-testid="integrations-error-code-chip"
        >
          code={code}
        </span>
      ) : null}
    </div>
  );
}

/**
 * PRODUCTION FIX: replaces the raw-JSON error banner that operators were
 * seeing when the deployment had INTEGRATIONS_ENABLED=false or API_KEY_SECRET
 * unset. The backend responds 503 with structured
 * `{ code: "INTEGRATIONS_DISABLED", reason: "secret_missing" | "feature_flag_off" }`
 * — this panel renders that state cleanly with operator-readable copy.
 *
 * Normal users see the title + body only. Workspace OWNER/ADMINs additionally
 * see a "reason=…" chip backed by the safe diagnostics endpoint, so support
 * staff can triage which deployment knob is misconfigured without surfacing
 * raw JSON or secret values.
 */
function IntegrationsDisabledPanel(props: {
  isAdmin: boolean;
  diagnostics:
    | {
        reason: "feature_flag_off" | "secret_missing" | null;
        apiKeySecretBound: boolean;
        apiKeySecretLengthValid: boolean;
        cronSecretBound: boolean;
        envSourceHint: string;
      }
    | null;
}): JSX.Element {
  const { isAdmin, diagnostics } = props;
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
        Integrations are not available on this workspace.
      </h2>
      <p
        style={{
          fontSize: 14,
          color: "#475569",
          marginTop: 8,
          marginBottom: 0,
        }}
      >
        Integrations are disabled because the API key signing secret is not
        configured in the running API environment.
      </p>
      {isAdmin && diagnostics ? (
        <div
          data-testid="integrations-disabled-admin-detail"
          style={{
            marginTop: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <span
            data-testid="integrations-disabled-reason-chip"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#e2e8f0",
              color: "#0f172a",
              fontSize: 12,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            }}
          >
            reason={diagnostics.reason ?? "unknown"}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#e2e8f0",
              color: "#0f172a",
              fontSize: 12,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            }}
          >
            apiKeySecret=
            {diagnostics.apiKeySecretBound
              ? diagnostics.apiKeySecretLengthValid
                ? "ok"
                : "too_short"
              : "unbound"}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#e2e8f0",
              color: "#0f172a",
              fontSize: 12,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            }}
          >
            cronSecret={diagnostics.cronSecretBound ? "ok" : "unbound"}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#e2e8f0",
              color: "#0f172a",
              fontSize: 12,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            }}
          >
            envSource={diagnostics.envSourceHint}
          </span>
        </div>
      ) : null}
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
