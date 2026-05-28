"use client";

/**
 * Phase R8.2 / R8.2.1 / R8.2.2 — SAML SSO Connection Management.
 *
 * Admin surface for managing SAML 2.0 SP connections:
 *   - List configured SSO providers and their SAML status
 *   - Show SP metadata URL and explicit ACS URL (for IdP registration)
 *   - Ingest IdP metadata XML to configure SAML endpoints
 *   - Surface health warnings when consecutive auth failures are detected
 *   - Link to SP-initiated login test flow
 *   - R8.2.1: Test-connection preflight check with recorded PASSED/FAILED status
 *   - R8.2.1: Certificate rotation — add next cert, promote when IdP rotates
 *   - R8.2.1: Show cert fingerprints for both primary and next cert
 *   - R8.2.2: Show IdP Entity ID, NameID format, cert expiry date
 *   - R8.2.2: SCIM-managed JIT suppression warning
 *   - R8.2.2: Honest request signing status label
 *   - R8.2.2: Cert expiry warning banner (30/60/90-day thresholds)
 *
 * Hard rules:
 *   - Reads from /v1/admin/identity/sso/providers?teamId=...
 *   - Ingests via POST /v1/auth/saml/:connectionId/ingest-metadata
 *   - Test-connection via POST /v1/auth/saml/:connectionId/test-connection
 *   - Cert rotation via PUT/DELETE /v1/auth/saml/:connectionId/certificate-next
 *   - Never stores or logs raw SAML assertions client-side
 *   - Shows only GENERIC_SAML connections in the SAML config panel
 *   - No raw certificate contents displayed — fingerprints only
 *   - ACS URL is derived from window.location, not hard-coded
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
// Phase P1.4 — step-up gating on certificate rotation. Cert
// promotion replaces the active IdP cert; mistakes lock users out
// of SSO. The backend's `enforceStepUpIfFlagged` returns 401
// STEP_UP_REQUIRED when the workspace flag is set; the hook
// surfaces the modal + retries once.
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
// Phase 2.3 — adopt AccessGate for the workspace-required + permission
// states. Previously these rendered bare grey text with no next step.
import { AccessGate } from "../../../../components/access/AccessGate";

type SsoProvider = {
  id: string;
  provider: string;
  status: "ACTIVE" | "INACTIVE" | "REVOKED";
  samlSsoUrl?: string | null;
  samlCertFingerprint?: string | null;
  samlCertNextFingerprint?: string | null;
  samlEntityId?: string | null;
  consecutiveFailureCount?: number;
  outageDetectedAtUtc?: string | null;
  lastUsedAtUtc?: string | null;
  // R8.2.1 — test-connection fields
  samlLastTestedAt?: string | null;
  samlLastTestStatus?: "PASSED" | "FAILED" | null;
  samlLastTestError?: string | null;
  // R8.2.2 — compliance completeness fields
  samlIdpEntityId?: string | null;
  samlCertNotAfter?: string | null;
  samlNameIdFormat?: string | null;
  samlScimManaged?: boolean;
  jitDefaultRole?: string | null;
};

type TestConnectionResult = {
  ok: boolean;
  status: "PASSED" | "FAILED";
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  errorCode: string | null;
  certFingerprint: string | null;
  certNextFingerprint: string | null;
};

type IngestResult = {
  ok: boolean;
  extracted: {
    ssoUrl: string;
    certFingerprint: string;
    nameIdFormat: string | null;
    entityId: string;
    // R8.2.2 — cert expiry parsed from the IdP cert X.509 NotAfter
    certNotAfter: string | null;
  };
};

export default function SsoAdminPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <SsoAdminContent />
    </PageRouteGate>
  );
}

function SsoAdminContent() {
  const teamId = useTeamId();
  // P1.4 — step-up control wraps SAML certificate rotation. A 401
  // STEP_UP_REQUIRED surfaces the modal + retries with the
  // challenge header. Cert promotion replaces the live IdP cert
  // and is the most dangerous SAML mutation; this is the right
  // gate.
  const stepUp = useStepUpAction({ teamId });
  const [providers, setProviders] = useState<SsoProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metadataXml, setMetadataXml] = useState<Record<string, string>>({});
  const [ingestResult, setIngestResult] = useState<Record<string, IngestResult | null>>({});
  const [ingestError, setIngestError] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  // R8.2.1 — test-connection state
  const [testResult, setTestResult] = useState<Record<string, TestConnectionResult | null>>({});
  const [testError, setTestError] = useState<Record<string, string | null>>({});
  const [testBusy, setTestBusy] = useState<Record<string, boolean>>({});
  // R8.2.1 — cert rotation state
  const [nextCertPem, setNextCertPem] = useState<Record<string, string>>({});
  const [certBusy, setCertBusy] = useState<Record<string, boolean>>({});
  const [certResult, setCertResult] = useState<Record<string, string | null>>({});
  const [certError, setCertError] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/admin/identity/sso/providers?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((res: { providers: SsoProvider[] }) => {
        if (cancelled) return;
        setProviders(res.providers ?? []);
        setLoadError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setLoadError(err?.message ?? "Could not load SSO providers.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  function spMetadataUrl(connectionId: string): string {
    const base =
      typeof window !== "undefined" ? window.location.origin : "https://api.proovra.com";
    return `${base}/v1/auth/saml/metadata/${encodeURIComponent(connectionId)}`;
  }

  // R8.2.2 — ACS URL is the HTTP-POST binding endpoint the IdP POSTs assertions to.
  // Shown explicitly so operators can copy it into their IdP's SP configuration.
  function acsUrl(req?: { origin?: string }): string {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (req?.origin ?? "https://api.proovra.com");
    return `${base}/v1/auth/saml/acs`;
  }

  function loginTestUrl(connectionId: string): string {
    const base =
      typeof window !== "undefined" ? window.location.origin : "https://api.proovra.com";
    return `${base}/v1/auth/saml/${encodeURIComponent(connectionId)}/login`;
  }

  // R8.2.2 — Human-readable cert expiry status label for the admin UI.
  function certExpiryLabel(certNotAfter: string | null | undefined): {
    label: string;
    style: "ok" | "warn" | "error";
  } {
    if (!certNotAfter) return { label: "Expiry unknown (ingest metadata to populate)", style: "warn" };
    const ms = new Date(certNotAfter).getTime() - Date.now();
    if (ms <= 0) return { label: `Expired ${new Date(certNotAfter).toLocaleDateString()}`, style: "error" };
    const days = Math.floor(ms / 86400000);
    if (days <= 30) return { label: `Expires in ${days} day${days !== 1 ? "s" : ""} — rotate immediately`, style: "error" };
    if (days <= 60) return { label: `Expires in ${days} days — rotation recommended`, style: "warn" };
    if (days <= 90) return { label: `Expires in ${days} days — plan rotation`, style: "warn" };
    return { label: `Expires ${new Date(certNotAfter).toLocaleDateString()}`, style: "ok" };
  }

  // R8.2.1 — Test-connection handler
  async function handleTestConnection(connectionId: string) {
    setTestBusy((prev) => ({ ...prev, [connectionId]: true }));
    setTestResult((prev) => ({ ...prev, [connectionId]: null }));
    setTestError((prev) => ({ ...prev, [connectionId]: null }));
    try {
      const result: TestConnectionResult = await apiFetch(
        `/v1/auth/saml/${encodeURIComponent(connectionId)}/test-connection`,
        { method: "POST" },
      );
      setTestResult((prev) => ({ ...prev, [connectionId]: result }));
      // Refresh provider list so samlLastTestedAt / samlLastTestStatus are current
      if (teamId) {
        apiFetch(`/v1/admin/identity/sso/providers?teamId=${encodeURIComponent(teamId)}`, {
          method: "GET",
        })
          .then((res: { providers: SsoProvider[] }) => {
            setProviders(res.providers ?? []);
          })
          .catch(() => null);
      }
    } catch (err) {
      setTestError((prev) => ({
        ...prev,
        [connectionId]: (err as { message?: string })?.message ?? "Test-connection failed.",
      }));
    } finally {
      setTestBusy((prev) => ({ ...prev, [connectionId]: false }));
    }
  }

  // R8.2.1 — Add next certificate (rotation phase 1)
  async function handleAddNextCert(connectionId: string) {
    const rawPem = nextCertPem[connectionId] ?? "";
    if (!rawPem.trim()) return;
    // Strip PEM headers if present — API expects base64-only
    const base64 = rawPem
      .replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\s+/g, "");
    if (base64.length < 100) {
      setCertError((prev) => ({ ...prev, [connectionId]: "Certificate is too short. Paste the full PEM or base64 certificate." }));
      return;
    }
    setCertBusy((prev) => ({ ...prev, [connectionId]: true }));
    setCertResult((prev) => ({ ...prev, [connectionId]: null }));
    setCertError((prev) => ({ ...prev, [connectionId]: null }));
    try {
      const result = await apiFetch(
        `/v1/auth/saml/${encodeURIComponent(connectionId)}/certificate-next`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ certificate: base64 }),
        },
      ) as { ok: boolean; certNextFingerprint: string };
      setCertResult((prev) => ({
        ...prev,
        [connectionId]: `Next cert added. Fingerprint: ${result.certNextFingerprint}`,
      }));
      setNextCertPem((prev) => ({ ...prev, [connectionId]: "" }));
    } catch (err) {
      setCertError((prev) => ({
        ...prev,
        [connectionId]: (err as { message?: string })?.message ?? "Failed to add next certificate.",
      }));
    } finally {
      setCertBusy((prev) => ({ ...prev, [connectionId]: false }));
    }
  }

  // R8.2.1 — Promote next cert to primary (rotation phase 3)
  async function handlePromoteNextCert(connectionId: string) {
    if (!window.confirm(
      "Promote the rotation certificate to primary? The current primary cert will be replaced. " +
      "Only do this after confirming the IdP has switched to the new certificate.",
    )) return;
    setCertBusy((prev) => ({ ...prev, [connectionId]: true }));
    setCertResult((prev) => ({ ...prev, [connectionId]: null }));
    setCertError((prev) => ({ ...prev, [connectionId]: null }));
    try {
      // P1.4 — step-up wraps the promotion. Cert promotion replaces
      // the active IdP cert on a live connection; if the workspace
      // step-up flag is set the backend returns 401 STEP_UP_REQUIRED
      // and the modal collects the re-auth before the operation
      // proceeds.
      const result = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(
          `/v1/auth/saml/${encodeURIComponent(connectionId)}/certificate-next`,
          { method: "DELETE", headers: { ...(headers ?? {}) } },
        ),
      )) as { ok: boolean; certFingerprint: string };
      setCertResult((prev) => ({
        ...prev,
        [connectionId]: `Certificate promoted. New primary fingerprint: ${result.certFingerprint}`,
      }));
      // Refresh to show updated fingerprints
      if (teamId) {
        apiFetch(`/v1/admin/identity/sso/providers?teamId=${encodeURIComponent(teamId)}`, {
          method: "GET",
        })
          .then((res: { providers: SsoProvider[] }) => setProviders(res.providers ?? []))
          .catch(() => null);
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      setCertError((prev) => ({
        ...prev,
        [connectionId]:
          code === "STEP_UP_CANCEL"
            ? "Step-up cancelled — certificate was not promoted."
            : (err as { message?: string })?.message ?? "Failed to promote certificate.",
      }));
    } finally {
      setCertBusy((prev) => ({ ...prev, [connectionId]: false }));
    }
  }

  async function handleIngest(connectionId: string) {
    const xml = metadataXml[connectionId] ?? "";
    if (!xml.trim()) return;
    setBusy((prev) => ({ ...prev, [connectionId]: true }));
    setIngestResult((prev) => ({ ...prev, [connectionId]: null }));
    setIngestError((prev) => ({ ...prev, [connectionId]: null }));
    try {
      const result: IngestResult = await apiFetch(
        `/v1/auth/saml/${encodeURIComponent(connectionId)}/ingest-metadata`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ metadataXml: xml }),
        },
      );
      setIngestResult((prev) => ({ ...prev, [connectionId]: result }));
    } catch (err) {
      setIngestError((prev) => ({
        ...prev,
        [connectionId]: (err as { message?: string })?.message ?? "Metadata ingest failed.",
      }));
    } finally {
      setBusy((prev) => ({ ...prev, [connectionId]: false }));
    }
  }

  async function handleCopy(connectionId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied((prev) => ({ ...prev, [connectionId]: true }));
      setTimeout(() => setCopied((prev) => ({ ...prev, [connectionId]: false })), 2000);
    } catch {
      // clipboard not available — noop
    }
  }

  const isSaml = (p: SsoProvider) => p.provider === "GENERIC_SAML";
  const isConfigured = (p: SsoProvider) =>
    Boolean(p.samlCertFingerprint && p.samlSsoUrl);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>SAML SSO Configuration</h1>
        <p style={mutedStyle}>
          Manage SAML 2.0 Service Provider connections for this workspace.
          Paste your Identity Provider metadata XML to configure endpoints and
          certificate fingerprints. The SP metadata URL below must be registered
          with your IdP.
        </p>
        {/* Phase P1.1 — links to the new SSO Health + Visual Mapping pages.
            These are sibling routes; this main page stays the canonical
            place to ingest metadata / rotate certs. */}
        <nav
          aria-label="SSO operations"
          style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 13 }}
        >
          <a
            href="/security-center/sso/health"
            style={{ color: "#1e40af", textDecoration: "underline" }}
          >
            SSO Health dashboard →
          </a>
          <a
            href="/security-center/sso/mapping"
            style={{ color: "#1e40af", textDecoration: "underline" }}
          >
            Visual attribute mapping →
          </a>
        </nav>
      </header>

      {loadError ? <div style={errorBoxStyle}>{loadError}</div> : null}

      {!teamId ? (
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="SSO"
          headline="Switch to a team workspace to manage SSO"
          reason="SAML connections are per-workspace. Open a team workspace you administer to configure or test SSO."
          actions={[
            { label: "Open team workspaces", href: "/teams", variant: "primary" },
            { label: "Review plans", href: "/billing", variant: "secondary" },
          ]}
          testid="sso-access-gate-no-workspace"
        />
      ) : providers === null && !loadError ? (
        <p style={mutedStyle}>Loading SSO providers…</p>
      ) : providers && providers.length === 0 ? (
        <div style={cardStyle}>
          <p style={mutedStyle}>
            No SSO providers configured for this workspace. Contact support to
            provision a SAML connection.
          </p>
        </div>
      ) : (
        providers?.map((p) => (
          <section key={p.id} style={cardStyle}>
            <div style={providerHeaderStyle}>
              <div>
                <h2 style={sectionTitleStyle}>
                  {p.provider.replace("_", " ")}
                  <span style={chipStyle}>{p.id.slice(0, 8)}…</span>
                </h2>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <span style={statusBadgeStyle(p.status)}>{p.status}</span>
                  {isSaml(p) ? (
                    <span style={isConfigured(p) ? configuredBadgeStyle : unconfiguredBadgeStyle}>
                      {isConfigured(p) ? "SAML configured" : "SAML not configured"}
                    </span>
                  ) : null}
                </div>
              </div>
              {p.lastUsedAtUtc ? (
                <div style={mutedStyle}>
                  Last used: {new Date(p.lastUsedAtUtc).toLocaleString()}
                </div>
              ) : null}
            </div>

            {/* Health warning */}
            {p.outageDetectedAtUtc ? (
              <div style={warnBoxStyle}>
                <strong>Auth outage detected</strong> — consecutive failures
                recorded since {new Date(p.outageDetectedAtUtc).toLocaleString()}.
                {p.consecutiveFailureCount
                  ? ` ${p.consecutiveFailureCount} consecutive failure(s).`
                  : null}{" "}
                Re-ingest IdP metadata or verify IdP availability.
              </div>
            ) : null}

            {isSaml(p) ? (
              <>
                {/* SP Metadata URL + ACS URL */}
                <div style={fieldGroupStyle}>
                  <label style={labelStyle}>SP Metadata URL</label>
                  <p style={{ ...mutedStyle, marginBottom: 6 }}>
                    Register this URL with your Identity Provider to configure the
                    SAML trust. The endpoint serves the SP EntityDescriptor XML.
                  </p>
                  <div style={copyRowStyle}>
                    <input
                      readOnly
                      value={spMetadataUrl(p.id)}
                      style={readonlyInputStyle}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      style={secondaryButtonStyle}
                      onClick={() => void handleCopy(p.id, spMetadataUrl(p.id))}
                    >
                      {copied[p.id] ? "Copied" : "Copy"}
                    </button>
                  </div>

                  {/* R8.2.2 — ACS URL shown explicitly so operators can configure it in IdP
                      without relying solely on metadata upload */}
                  <div style={{ marginTop: 10 }}>
                    <label style={labelStyle}>ACS URL (HTTP-POST Binding)</label>
                    <p style={{ ...mutedStyle, marginBottom: 4 }}>
                      The endpoint your IdP will POST SAML assertions to. Use this if
                      your IdP requires the ACS URL entered manually.
                    </p>
                    <div style={copyRowStyle}>
                      <input
                        readOnly
                        value={acsUrl()}
                        style={readonlyInputStyle}
                        onFocus={(e) => e.target.select()}
                      />
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={() => void handleCopy(`${p.id}_acs`, acsUrl())}
                      >
                        {copied[`${p.id}_acs`] ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>

                  {/* R8.2.2 — Honest request signing status. Unsigned until R8.3 wires
                      SP private key and signing. Never claim signed if it is not. */}
                  <p style={{ ...mutedStyle, marginTop: 8, fontStyle: "italic" }}>
                    Request signing: unsigned AuthnRequests (signed requests not yet enabled —
                    planned for a future release). Assertions must be signed by the IdP.
                  </p>
                </div>

                {/* R8.2.2 — SCIM-managed warning */}
                {p.samlScimManaged ? (
                  <div style={{ ...warnBoxStyle, marginTop: 12 }}>
                    <strong>SCIM-managed org:</strong> Just-In-Time (JIT) user provisioning
                    is suppressed for this connection because the organisation is managed by
                    SCIM. Users must be provisioned by the SCIM directory sync, not by SAML
                    login. Logins from unknown users will be rejected.
                  </div>
                ) : null}

                {/* Existing SAML config summary — R8.2.2 extended */}
                {isConfigured(p) ? (
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>Current SAML Configuration</label>

                    {/* R8.2.2 — cert expiry warning banner */}
                    {(() => {
                      const expiry = certExpiryLabel(p.samlCertNotAfter);
                      if (expiry.style !== "ok") {
                        return (
                          <div style={expiry.style === "error" ? { ...warnBoxStyle, borderColor: "#fecaca", background: "#fef2f2", color: "#7f1d1d" } : warnBoxStyle}>
                            <strong>Certificate expiry warning:</strong> {expiry.label}.
                            {" "}Use the certificate rotation panel below to add and promote a
                            new IdP signing certificate before expiry.
                          </div>
                        );
                      }
                      return null;
                    })()}

                    <div style={configSummaryStyle}>
                      <div>
                        <span style={mutedStyle}>SSO URL: </span>
                        <code style={codeStyle}>{p.samlSsoUrl}</code>
                      </div>
                      {/* R8.2.2 — SP Entity ID (what the SP sends in AuthnRequests) */}
                      {p.samlEntityId ? (
                        <div>
                          <span style={mutedStyle}>SP Entity ID: </span>
                          <code style={codeStyle}>{p.samlEntityId}</code>
                        </div>
                      ) : null}
                      {/* R8.2.2 — IdP Entity ID (from the IdP's metadata EntityDescriptor) */}
                      {p.samlIdpEntityId ? (
                        <div>
                          <span style={mutedStyle}>IdP Entity ID: </span>
                          <code style={codeStyle}>{p.samlIdpEntityId}</code>
                        </div>
                      ) : null}
                      {/* R8.2.2 — NameID format */}
                      {p.samlNameIdFormat ? (
                        <div>
                          <span style={mutedStyle}>NameID format: </span>
                          <code style={codeStyle}>{p.samlNameIdFormat}</code>
                        </div>
                      ) : null}
                      <div>
                        <span style={mutedStyle}>Cert fingerprint (SHA-256): </span>
                        <code style={codeStyle}>{p.samlCertFingerprint}</code>
                      </div>
                      {/* R8.2.2 — Cert expiry date */}
                      {p.samlCertNotAfter ? (
                        <div>
                          <span style={mutedStyle}>Cert expiry: </span>
                          <code style={{
                            ...codeStyle,
                            color: certExpiryLabel(p.samlCertNotAfter).style === "error"
                              ? "#7f1d1d"
                              : certExpiryLabel(p.samlCertNotAfter).style === "warn"
                                ? "#92400e"
                                : undefined,
                          }}>
                            {certExpiryLabel(p.samlCertNotAfter).label}
                          </code>
                        </div>
                      ) : (
                        <div>
                          <span style={mutedStyle}>Cert expiry: </span>
                          <code style={{ ...codeStyle, color: "#92400e" }}>
                            Unknown — re-ingest metadata to populate
                          </code>
                        </div>
                      )}
                      {/* R8.2.2 — JIT provisioning status */}
                      <div>
                        <span style={mutedStyle}>JIT provisioning: </span>
                        <code style={codeStyle}>
                          {p.samlScimManaged
                            ? "disabled (SCIM-managed)"
                            : p.jitDefaultRole
                              ? `enabled (role: ${p.jitDefaultRole})`
                              : "disabled"}
                        </code>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* R8.2.1 — Test-connection preflight */}
                {isConfigured(p) ? (
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>Connection Health Check</label>
                    <p style={{ ...mutedStyle, marginBottom: 8 }}>
                      Verify that your SAML configuration is complete and internally
                      consistent. This check is performed locally — no browser redirect
                      to your IdP occurs and no session is created.
                    </p>

                    {/* Last test status from DB */}
                    {p.samlLastTestedAt ? (
                      <div style={lastTestBannerStyle(p.samlLastTestStatus ?? null)}>
                        Last tested: {new Date(p.samlLastTestedAt).toLocaleString()}
                        {" — "}
                        <strong>{p.samlLastTestStatus ?? "unknown"}</strong>
                        {p.samlLastTestError ? (
                          <span style={{ marginLeft: 8, fontFamily: "monospace", fontSize: 11 }}>
                            ({p.samlLastTestError})
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    <button
                      type="button"
                      style={{ ...primaryButtonStyle, marginTop: 8 }}
                      disabled={testBusy[p.id]}
                      onClick={() => void handleTestConnection(p.id)}
                    >
                      {testBusy[p.id] ? "Running check…" : "Run health check"}
                    </button>

                    {testError[p.id] ? (
                      <div style={{ ...errorBoxStyle, marginTop: 10 }}>{testError[p.id]}</div>
                    ) : null}

                    {testResult[p.id] ? (
                      <div style={{
                        ...(testResult[p.id]!.ok ? successBoxStyle : errorBoxStyle),
                        marginTop: 10,
                      }}>
                        <strong>
                          {testResult[p.id]!.ok ? "✓ All checks passed" : "✗ Some checks failed"}
                        </strong>
                        <ul style={{ margin: "8px 0 0 0", paddingLeft: 20, fontSize: 12 }}>
                          {testResult[p.id]!.checks.map((c) => (
                            <li key={c.name}>
                              {c.ok ? "✓" : "✗"} {c.name.replace(/_/g, " ")}
                              {c.detail ? <span style={{ color: "#92400e" }}> — {c.detail}</span> : null}
                            </li>
                          ))}
                        </ul>
                        {testResult[p.id]!.certNextFingerprint ? (
                          <div style={{ marginTop: 6, fontSize: 11 }}>
                            <span style={mutedStyle}>Rotation cert fingerprint: </span>
                            <code style={codeStyle}>{testResult[p.id]!.certNextFingerprint}</code>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* R8.2.1 — Certificate rotation */}
                {isConfigured(p) ? (
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>Certificate Rotation (Zero-Downtime)</label>
                    <p style={{ ...mutedStyle, marginBottom: 8 }}>
                      Add a secondary certificate before your IdP rotates its signing cert.
                      Both certs will be accepted during the transition window.
                      Once confirmed, promote the new cert to primary.
                    </p>

                    {/* Show current cert fingerprints */}
                    <div style={configSummaryStyle}>
                      <div>
                        <span style={mutedStyle}>Primary cert fingerprint: </span>
                        <code style={codeStyle}>{p.samlCertFingerprint ?? "(not set)"}</code>
                      </div>
                      {p.samlCertNextFingerprint ? (
                        <div style={{ marginTop: 4 }}>
                          <span style={{ ...mutedStyle, color: "#166534" }}>Rotation cert fingerprint: </span>
                          <code style={{ ...codeStyle, color: "#166534" }}>{p.samlCertNextFingerprint}</code>
                          <span style={{ marginLeft: 8, fontSize: 11, color: "#166534" }}>
                            (both certs accepted)
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* Add next cert */}
                    <div style={{ marginTop: 12 }}>
                      <label style={{ ...labelStyle, fontWeight: 500 }}>
                        Add rotation certificate
                      </label>
                      <textarea
                        rows={4}
                        placeholder="-----BEGIN CERTIFICATE-----&#10;MIICxD...&#10;-----END CERTIFICATE-----&#10;(PEM or base64-only both accepted)"
                        value={nextCertPem[p.id] ?? ""}
                        onChange={(e) =>
                          setNextCertPem((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        style={textareaStyle}
                      />
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          disabled={certBusy[p.id] || !(nextCertPem[p.id] ?? "").trim()}
                          onClick={() => void handleAddNextCert(p.id)}
                        >
                          {certBusy[p.id] ? "Saving…" : "Add rotation cert"}
                        </button>
                        {p.samlCertNextFingerprint ? (
                          <button
                            type="button"
                            style={{ ...secondaryButtonStyle, color: "#166534", borderColor: "#86efac" }}
                            disabled={certBusy[p.id]}
                            onClick={() => void handlePromoteNextCert(p.id)}
                          >
                            Promote to primary →
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {certError[p.id] ? (
                      <div style={{ ...errorBoxStyle, marginTop: 10 }}>{certError[p.id]}</div>
                    ) : null}
                    {certResult[p.id] ? (
                      <div style={{ ...successBoxStyle, marginTop: 10 }}>{certResult[p.id]}</div>
                    ) : null}
                  </div>
                ) : null}

                {/* Ingest IdP metadata */}
                <div style={fieldGroupStyle}>
                  <label style={labelStyle}>
                    {isConfigured(p) ? "Re-ingest IdP Metadata" : "Ingest IdP Metadata"}
                  </label>
                  <p style={{ ...mutedStyle, marginBottom: 6 }}>
                    Paste the XML metadata document from your Identity Provider.
                    The SSO URL, certificate, NameID format, and EntityID will be
                    extracted automatically.
                  </p>
                  <textarea
                    rows={6}
                    placeholder="<?xml version=&quot;1.0&quot;?><EntityDescriptor ...>...</EntityDescriptor>"
                    value={metadataXml[p.id] ?? ""}
                    onChange={(e) =>
                      setMetadataXml((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                    style={textareaStyle}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      style={primaryButtonStyle}
                      disabled={busy[p.id] || !(metadataXml[p.id] ?? "").trim()}
                      onClick={() => void handleIngest(p.id)}
                    >
                      {busy[p.id] ? "Ingesting…" : "Ingest metadata"}
                    </button>
                    <a
                      href={loginTestUrl(p.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={testLinkStyle}
                    >
                      Test SP-initiated login →
                    </a>
                  </div>

                  {ingestError[p.id] ? (
                    <div style={{ ...errorBoxStyle, marginTop: 10 }}>{ingestError[p.id]}</div>
                  ) : null}

                  {ingestResult[p.id] ? (
                    <div style={{ ...successBoxStyle, marginTop: 10 }}>
                      <strong>Metadata ingested successfully.</strong>
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                        <div>
                          <span style={mutedStyle}>SSO URL: </span>
                          <code style={codeStyle}>{ingestResult[p.id]!.extracted.ssoUrl}</code>
                        </div>
                        <div>
                          <span style={mutedStyle}>IdP Entity ID: </span>
                          <code style={codeStyle}>{ingestResult[p.id]!.extracted.entityId}</code>
                        </div>
                        <div>
                          <span style={mutedStyle}>Cert fingerprint: </span>
                          <code style={codeStyle}>{ingestResult[p.id]!.extracted.certFingerprint}</code>
                        </div>
                        {ingestResult[p.id]!.extracted.nameIdFormat ? (
                          <div>
                            <span style={mutedStyle}>NameID format: </span>
                            <code style={codeStyle}>{ingestResult[p.id]!.extracted.nameIdFormat}</code>
                          </div>
                        ) : null}
                        {/* R8.2.2 — show cert expiry immediately after ingest */}
                        <div>
                          <span style={mutedStyle}>Cert expiry: </span>
                          <code style={{
                            ...codeStyle,
                            color: ingestResult[p.id]!.extracted.certNotAfter
                              ? certExpiryLabel(ingestResult[p.id]!.extracted.certNotAfter).style === "error"
                                ? "#7f1d1d"
                                : certExpiryLabel(ingestResult[p.id]!.extracted.certNotAfter).style === "warn"
                                  ? "#92400e"
                                  : undefined
                              : "#92400e",
                          }}>
                            {certExpiryLabel(ingestResult[p.id]!.extracted.certNotAfter).label}
                          </code>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
        ))
      )}
      {/* P1.4 — step-up modal surfaces only when a destructive SAML
          operation (cert promotion) triggers 401 STEP_UP_REQUIRED.
          Otherwise dormant. */}
      <StepUpModal control={stepUp} />
    </main>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  maxWidth: 860,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b", margin: 0 };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const providerHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 16,
  flexWrap: "wrap",
  gap: 8,
};
const fieldGroupStyle: React.CSSProperties = {
  marginTop: 16,
  paddingTop: 16,
  borderTop: "1px solid #f1f5f9",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 4,
};
const copyRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};
const readonlyInputStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "monospace",
  fontSize: 12,
  padding: "6px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f8fafc",
  color: "#0f172a",
  minWidth: 0,
};
const textareaStyle: React.CSSProperties = {
  width: "100%",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "8px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  resize: "vertical",
  background: "#f8fafc",
  color: "#0f172a",
  boxSizing: "border-box",
};
const configSummaryStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "10px 12px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 12,
};
const codeStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "#0f172a",
  wordBreak: "break-all",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 8,
  fontFamily: "monospace",
};
const errorBoxStyle: React.CSSProperties = {
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 13,
};
const successBoxStyle: React.CSSProperties = {
  padding: 12,
  background: "#f0fdf4",
  color: "#166534",
  border: "1px solid #86efac",
  borderRadius: 8,
  fontSize: 13,
};
const warnBoxStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: 12,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 13,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "7px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};
const testLinkStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#2563eb",
  textDecoration: "none",
};

function lastTestBannerStyle(status: "PASSED" | "FAILED" | null): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 6,
    fontSize: 12,
    marginBottom: 8,
    border: "1px solid",
  };
  if (status === "PASSED")
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  if (status === "FAILED")
    return { ...base, background: "#fef2f2", borderColor: "#fecaca", color: "#7f1d1d" };
  return { ...base, background: "#f8fafc", borderColor: "#e2e8f0", color: "#64748b" };
}

function statusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "ACTIVE")
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  if (status === "REVOKED")
    return { ...base, background: "#fef2f2", borderColor: "#fecaca", color: "#7f1d1d" };
  return { ...base, background: "#f8fafc", borderColor: "#e2e8f0", color: "#64748b" };
}

const configuredBadgeStyle: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 999,
  border: "1px solid #86efac",
  background: "#f0fdf4",
  color: "#166534",
  whiteSpace: "nowrap",
};

const unconfiguredBadgeStyle: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 999,
  border: "1px solid #fcd34d",
  background: "#fffbeb",
  color: "#92400e",
  whiteSpace: "nowrap",
};
