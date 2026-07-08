"use client";

/**
 * Phase 26 — Identity Providers (SSO) admin page.
 *
 * Lists existing SsoConnection rows and supports create + status
 * transitions (PENDING → ACTIVE → DISABLED → REVOKED).
 *
 * Hard rules:
 *   - Client secret is shown ONCE on create (the API returns
 *     `clientSecretOnce`). We render it inline with a copy hint and
 *     drop it from state after the modal closes.
 *   - Subsequent reads only show the preview (`ck-***-abcd`).
 *   - Saving / transitioning may trigger a step-up challenge.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import React, { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  inputStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  selectStyle,
  statusBadgeStyle,
  subtitleStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type SsoProvider =
  | "GENERIC_OIDC"
  | "GENERIC_SAML"
  | "GENERIC_SCIM"
  | "OKTA"
  | "AZURE_AD"
  | "GOOGLE_WORKSPACE";

type SsoConnection = {
  id: string;
  provider: SsoProvider;
  displayName: string;
  status: "PENDING" | "ACTIVE" | "DISABLED" | "REVOKED";
  issuerUrl: string | null;
  clientId: string | null;
  clientSecretPreview: string | null;
  allowedEmailDomains: string[];
  jitDefaultRole: "MEMBER" | "VIEWER" | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  // Phase 3 — SAML SP signing + verified-domain policy STATUS. The private
  // key is NEVER present here — only status + fingerprint.
  samlSignRequests: boolean;
  restrictToVerifiedDomains: boolean;
  samlSpKeyConfigured: boolean;
  samlSpKeyFingerprint: string | null;
  samlSpEnvKeyAvailable: boolean;
  samlSpSigningKeySource: "stored" | "env" | "none";
  samlSpCertificateConfigured: boolean;
};

const SAML_PROVIDERS: SsoProvider[] = ["GENERIC_SAML"];

const PROVIDER_LABELS: Record<SsoProvider, string> = {
  GENERIC_OIDC: "Generic OIDC",
  GENERIC_SAML: "Generic SAML",
  GENERIC_SCIM: "Generic SCIM",
  OKTA: "Okta",
  AZURE_AD: "Microsoft Entra ID",
  GOOGLE_WORKSPACE: "Google Workspace",
};

const OIDC_PROVIDERS: SsoProvider[] = [
  "GENERIC_OIDC",
  "OKTA",
  "AZURE_AD",
  "GOOGLE_WORKSPACE",
];

export default function ProvidersPage() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [providers, setProviders] = useState<SsoConnection[] | null>(null);
  const [verifiedDomainCount, setVerifiedDomainCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    provider: "GOOGLE_WORKSPACE" as SsoProvider,
    displayName: "",
    issuerUrl: "https://accounts.google.com/.well-known/openid-configuration",
    clientId: "",
    clientSecret: "",
    allowedEmailDomains: "",
    jitDefaultRole: "MEMBER" as "MEMBER" | "VIEWER" | "",
  });
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  
const load = useCallback(() => {
    if (!teamId) return;
    apiFetch(
      `/v1/admin/identity/providers?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then(
        (r: {
          providers: SsoConnection[];
          verifiedDomainCount?: number;
        }) => {
          setProviders(r.providers ?? []);
          setVerifiedDomainCount(r.verifiedDomainCount ?? 0);
          setError(null);
        },
      )
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load providers." }).message),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = useCallback(async () => {
    if (!teamId) return;
    setBusy("create");
    setRevealedSecret(null);
    try {
      const allowedEmailDomains = createForm.allowedEmailDomains
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const res = await apiFetch("/v1/admin/identity/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          provider: createForm.provider,
          displayName: createForm.displayName,
          issuerUrl: createForm.issuerUrl || undefined,
          clientId: createForm.clientId || undefined,
          clientSecret: createForm.clientSecret || undefined,
          allowedEmailDomains,
          jitDefaultRole: createForm.jitDefaultRole || undefined,
        }),
      });
      if (res?.clientSecretOnce) {
        setRevealedSecret(res.clientSecretOnce as string);
      }
      setShowCreate(false);
      load();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Could not create connection." }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, createForm, load]);

  const transition = useCallback(
    async (id: string, nextStatus: string) => {
      if (!teamId) return;
      setBusy(id);
      try {
        await apiFetch(
          `/v1/admin/identity/providers/${encodeURIComponent(id)}/transition`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, nextStatus }),
          },
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Transition failed." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  const updatePolicy = useCallback(
    async (
      id: string,
      patch: {
        samlSignRequests?: boolean;
        restrictToVerifiedDomains?: boolean;
        samlSpPrivateKey?: string | null;
        samlSpCertificate?: string | null;
      },
    ) => {
      if (!teamId) return;
      setBusy(id);
      setError(null);
      try {
        // The private key (if any) is sent write-only; the response projection
        // NEVER returns it back — we only re-read status + fingerprint.
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/providers/${encodeURIComponent(id)}/policy`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ teamId, ...patch }),
            },
          ),
        );
        load();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — no changes were saved.");
        } else {
          setError(
            toSafeUserError(err, {
              message: "Could not update signing policy.",
            }).message,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [teamId, stepUp, load],
  );

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <p style={mutedStyle}>Switch to a workspace.</p>
      </main>
    );
  }

  const isOidc = OIDC_PROVIDERS.includes(createForm.provider);

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Identity Providers</h1>
          <p style={subtitleStyle}>
            SSO connections. Multiple providers per workspace supported. JIT
            provisioning + allowed-email-domains enforced at callback.
          </p>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            setShowCreate(true);
            setRevealedSecret(null);
          }}
        >
          New connection
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {revealedSecret ? (
        <div style={successBoxStyle}>
          <strong>Client secret created.</strong> Copy now — this is the
          only time it will be shown:{" "}
          <code style={{ fontFamily: "monospace" }}>{revealedSecret}</code>
          <button
            type="button"
            style={{ ...ghostButtonStyle, marginLeft: 12 }}
            onClick={() => setRevealedSecret(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {providers === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : providers.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>
            No SSO connections yet.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>JIT</th>
                <th style={thStyle}>Domains</th>
                <th style={thStyle}>Last used</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <React.Fragment key={p.id}>
                <tr>
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 600 }}>
                      {PROVIDER_LABELS[p.provider]}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {p.displayName}
                    {p.clientSecretPreview ? (
                      <div
                        style={{
                          ...mutedStyle,
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        secret {p.clientSecretPreview}
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(p.status)}>{p.status}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {p.jitDefaultRole ?? "disabled"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {p.allowedEmailDomains.length === 0 ? (
                      <span style={mutedStyle}>any</span>
                    ) : (
                      <span style={{ ...mutedStyle, fontSize: 11 }}>
                        {p.allowedEmailDomains.join(", ")}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(p.lastUsedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() =>
                          setExpanded((cur) => (cur === p.id ? null : p.id))
                        }
                      >
                        {expanded === p.id ? "Hide policy" : "Signing & policy"}
                      </button>
                      {p.status === "PENDING" ? (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "ACTIVE")}
                        >
                          Activate
                        </button>
                      ) : null}
                      {p.status === "ACTIVE" ? (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "DISABLED")}
                        >
                          Disable
                        </button>
                      ) : null}
                      {p.status === "DISABLED" ? (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "ACTIVE")}
                        >
                          Re-activate
                        </button>
                      ) : null}
                      {p.status !== "REVOKED" ? (
                        <button
                          type="button"
                          style={{
                            ...ghostButtonStyle,
                            color: "#991b1b",
                            borderColor: "#fecaca",
                            background: "#fef2f2",
                          }}
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "REVOKED")}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {expanded === p.id ? (
                  <tr>
                    <td style={{ ...tdStyle, padding: 0 }} colSpan={7}>
                      <PolicyPanel
                        connection={p}
                        verifiedDomainCount={verifiedDomainCount}
                        busy={busy === p.id}
                        onUpdate={(patch) => updatePolicy(p.id, patch)}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <StepUpModal control={stepUp} />

      {showCreate ? (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h3
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: 0,
              marginBottom: 8,
            }}
          >
            New SSO connection
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <Field label="Provider">
              <select
                style={selectStyle}
                value={createForm.provider}
                onChange={(e) =>
                  setCreateForm((p) => ({
                    ...p,
                    provider: e.target.value as SsoProvider,
                  }))
                }
              >
                {(Object.keys(PROVIDER_LABELS) as SsoProvider[]).map((k) => (
                  <option key={k} value={k}>
                    {PROVIDER_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Display name">
              <input
                style={inputStyle}
                value={createForm.displayName}
                onChange={(e) =>
                  setCreateForm((p) => ({ ...p, displayName: e.target.value }))
                }
                placeholder="Acme Corp Okta"
              />
            </Field>
            {isOidc ? (
              <>
                <Field label="Issuer URL (OIDC discovery)">
                  <input
                    style={inputStyle}
                    value={createForm.issuerUrl}
                    onChange={(e) =>
                      setCreateForm((p) => ({
                        ...p,
                        issuerUrl: e.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Client ID">
                  <input
                    style={inputStyle}
                    value={createForm.clientId}
                    onChange={(e) =>
                      setCreateForm((p) => ({
                        ...p,
                        clientId: e.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Client secret">
                  <input
                    type="password"
                    style={inputStyle}
                    value={createForm.clientSecret}
                    onChange={(e) =>
                      setCreateForm((p) => ({
                        ...p,
                        clientSecret: e.target.value,
                      }))
                    }
                  />
                </Field>
              </>
            ) : null}
            <Field label="Allowed email domains (comma-separated)">
              <input
                style={inputStyle}
                value={createForm.allowedEmailDomains}
                onChange={(e) =>
                  setCreateForm((p) => ({
                    ...p,
                    allowedEmailDomains: e.target.value,
                  }))
                }
                placeholder="acme.com, ops.acme.com"
              />
            </Field>
            <Field label="JIT default role">
              <select
                style={selectStyle}
                value={createForm.jitDefaultRole}
                onChange={(e) =>
                  setCreateForm((p) => ({
                    ...p,
                    jitDefaultRole: e.target.value as "MEMBER" | "VIEWER" | "",
                  }))
                }
              >
                <option value="">JIT disabled</option>
                <option value="MEMBER">Member</option>
                <option value="VIEWER">Viewer</option>
              </select>
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy === "create"}
              onClick={submitCreate}
            >
              {busy === "create" ? "Creating…" : "Create connection"}
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function PolicyPanel({
  connection,
  verifiedDomainCount,
  busy,
  onUpdate,
}: {
  connection: SsoConnection;
  verifiedDomainCount: number;
  busy: boolean;
  onUpdate: (patch: {
    samlSignRequests?: boolean;
    restrictToVerifiedDomains?: boolean;
    samlSpPrivateKey?: string | null;
    samlSpCertificate?: string | null;
  }) => void;
}) {
  const isSaml = SAML_PROVIDERS.includes(connection.provider);
  const noVerifiedDomains = verifiedDomainCount === 0;
  const [keyDraft, setKeyDraft] = useState("");
  const [certDraft, setCertDraft] = useState("");

  const signingSourceLabel =
    connection.samlSpSigningKeySource === "stored"
      ? "Stored (per-connection key)"
      : connection.samlSpSigningKeySource === "env"
        ? "Configured via environment (SAML_SP_PRIVATE_KEY)"
        : "Not configured";

  return (
    <div
      style={{
        background: TOKENS.surfaceMuted,
        borderTop: `1px solid ${TOKENS.border}`,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {isSaml ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>SAML SP request signing</strong>
          <div style={{ ...mutedStyle, fontSize: 12 }}>
            Signing key source: <strong>{signingSourceLabel}</strong>
            {connection.samlSpKeyFingerprint ? (
              <>
                {" · "}fingerprint (SHA-256):{" "}
                <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                  {connection.samlSpKeyFingerprint.slice(0, 16)}…
                </code>
              </>
            ) : null}
            {" · "}SP certificate:{" "}
            {connection.samlSpCertificateConfigured ? "configured" : "none"}
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={connection.samlSignRequests}
              disabled={busy}
              onChange={(e) =>
                onUpdate({ samlSignRequests: e.target.checked })
              }
            />
            <span>Sign AuthnRequests</span>
          </label>
          {connection.samlSignRequests &&
          connection.samlSpSigningKeySource === "none" ? (
            <div style={{ ...mutedStyle, fontSize: 12, color: "#92400e" }}>
              Signing is enabled but no signing key is available. Add a
              per-connection key below or set the SAML_SP_PRIVATE_KEY
              environment variable — until then requests are sent unsigned.
            </div>
          ) : null}

          <div style={{ ...mutedStyle, fontSize: 12, marginTop: 4 }}>
            Replace signing key (PEM, write-only — never shown again):
          </div>
          <textarea
            value={keyDraft}
            disabled={busy}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"
            style={{
              ...inputStyle,
              minHeight: 80,
              fontFamily: "monospace",
              fontSize: 11,
            }}
          />
          <textarea
            value={certDraft}
            disabled={busy}
            onChange={(e) => setCertDraft(e.target.value)}
            placeholder="SP certificate (base64, no PEM header) — optional"
            style={{
              ...inputStyle,
              minHeight: 60,
              fontFamily: "monospace",
              fontSize: 11,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy || (keyDraft.trim() === "" && certDraft.trim() === "")}
              onClick={() => {
                const patch: {
                  samlSpPrivateKey?: string;
                  samlSpCertificate?: string;
                } = {};
                if (keyDraft.trim() !== "") patch.samlSpPrivateKey = keyDraft;
                if (certDraft.trim() !== "")
                  patch.samlSpCertificate = certDraft;
                onUpdate(patch);
                setKeyDraft("");
                setCertDraft("");
              }}
            >
              {busy ? "Saving…" : "Install / rotate key"}
            </button>
            {connection.samlSpKeyConfigured ? (
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={busy}
                onClick={() => onUpdate({ samlSpPrivateKey: "" })}
              >
                Clear stored key
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ ...mutedStyle, fontSize: 12 }}>
          SP request signing applies to SAML connections only.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Verified-domain restriction</strong>
        <div style={{ ...mutedStyle, fontSize: 12 }}>
          Verified organization domains:{" "}
          <strong>{verifiedDomainCount}</strong>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={connection.restrictToVerifiedDomains}
            disabled={
              busy ||
              (noVerifiedDomains && !connection.restrictToVerifiedDomains)
            }
            onChange={(e) =>
              onUpdate({ restrictToVerifiedDomains: e.target.checked })
            }
          />
          <span>Restrict SSO logins to verified domains</span>
        </label>
        {noVerifiedDomains && !connection.restrictToVerifiedDomains ? (
          <div style={{ ...mutedStyle, fontSize: 12, color: "#92400e" }}>
            Verify at least one organization domain before enabling this
            restriction.
          </div>
        ) : null}
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
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: TOKENS.inkMuted,
      }}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}
