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
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { FederationReadinessSection } from "./_sections/FederationReadinessSection";
import {
  AdmInline,
} from "../../../../../components/admin/AdminSurfaces";
import { TOKENS, successBoxStyle, statusBadgeStyle, formatDateTime } from "../ui-tokens";

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

/**
 * PHASE 12B — a 403/404 from the server is a DENIAL, and a denial must never be
 * rendered as "nothing here". `readDenial` classifies the sanitised error so the
 * surface can show an explicit not-authorised / not-entitled panel instead of an
 * empty state that invites the operator to "just create one".
 */
type Denial = { kind: "forbidden" | "not_found" | "entitlement"; detail: string };

function readDenial(err: unknown): Denial | null {
  const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  if (status === 402 || code.includes("enterprise_feature_required")) {
    return {
      kind: "entitlement",
      detail:
        "Single sign-on is part of the Enterprise plan. Your workspace's plan does not include it, so the server declined to return provider configuration.",
    };
  }
  if (status === 403 || code === "forbidden" || code === "permission_denied") {
    return {
      kind: "forbidden",
      detail:
        "Your role in this workspace does not allow managing identity providers. Nothing was loaded and nothing was changed.",
    };
  }
  if (status === 404 || code === "not_found") {
    return {
      kind: "not_found",
      detail:
        "This workspace's identity configuration is not available to your account. If you expected access, ask a workspace owner to grant it.",
    };
  }
  return null;
}

function DenialPanel({ denial }: { denial: Denial }) {
  return (
    <Card
      variant="status"
      tone="risk"
      padding="comfortable"
      data-testid="providers-denied"
      data-denial-kind={denial.kind}
    >
      <strong style={{ fontSize: 14 }}>
        {denial.kind === "entitlement"
          ? "Not included in this plan"
          : "You don't have access to identity providers"}
      </strong>
      <p className="adm-help" style={{ marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
        {denial.detail}
      </p>
    </Card>
  );
}

export default function ProvidersPage() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const [providers, setProviders] = useState<SsoConnection[] | null>(null);
  /** The server's list cap, reported alongside the connections. */
  const [providersCap, setProvidersCap] = useState<number | undefined>(
    undefined,
  );
  const [verifiedDomainCount, setVerifiedDomainCount] = useState<number>(0);
  const [denial, setDenial] = useState<Denial | null>(null);
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

  // PHASE 12B — every await is bracketed by the tenant guard: a workspace
  // switch mid-flight drops the result instead of painting another
  // Organization's identity configuration into this one.
  const load = useCallback(async () => {
    if (!teamId) return;
    const captured = stamp();
    try {
      const r = (await apiFetch(
        `/v1/admin/identity/providers?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as {
        providers?: SsoConnection[];
        verifiedDomainCount?: number;
        providersCap?: number;
      };
      if (isStale(captured)) return;
      setProviders(r.providers ?? []);
      setProvidersCap(r.providersCap);
      setVerifiedDomainCount(r.verifiedDomainCount ?? 0);
      setDenial(null);
      setError(null);
    } catch (err) {
      if (isStale(captured)) return;
      const d = readDenial(err);
      if (d) {
        setDenial(d);
        setProviders([]);
        setError(null);
        return;
      }
      setDenial(null);
      setError(
        toSafeUserError(err, { message: "Could not load providers." }).message,
      );
      setProviders([]);
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  // A one-time secret must never survive a workspace switch.
  useEffect(() => {
    setRevealedSecret(null);
  }, [teamId]);

  const submitCreate = useCallback(async () => {
    if (!teamId) return;
    setBusy("create");
    setRevealedSecret(null);
    setError(null);
    const captured = stamp();
    try {
      const allowedEmailDomains = createForm.allowedEmailDomains
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Creating a connection installs a credential that can mint sessions for
      // the whole workspace — it routes through step-up like every other
      // sensitive identity mutation.
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/admin/identity/providers", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
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
        }),
      )) as { clientSecretOnce?: unknown } | null;
      if (isStale(captured)) return;
      if (res && typeof res.clientSecretOnce === "string") {
        setRevealedSecret(res.clientSecretOnce);
      }
      setShowCreate(false);
      // Never keep the submitted secret in form state after the write.
      setCreateForm((p) => ({ ...p, clientSecret: "" }));
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — no connection was created.");
      } else {
        setError(
          toSafeUserError(err, { message: "Could not create connection." })
            .message,
        );
      }
    } finally {
      setBusy(null);
    }
  }, [teamId, createForm, load, stepUp, stamp, isStale]);

  const transition = useCallback(
    async (id: string, nextStatus: string) => {
      if (!teamId) return;
      // Disabling or revoking a live connection locks every user who signs in
      // through it out of the workspace — confirm explicitly.
      if (nextStatus === "REVOKED" || nextStatus === "DISABLED") {
        const ok = await confirm({
          title:
            nextStatus === "REVOKED"
              ? "Revoke this identity provider?"
              : "Disable this identity provider?",
          description:
            nextStatus === "REVOKED"
              ? "Revoking is permanent. Anyone who signs in through this provider will be unable to authenticate, and the connection cannot be re-activated — you would have to configure a new one."
              : "While disabled, nobody can sign in through this provider. You can re-activate it later.",
          confirmLabel:
            nextStatus === "REVOKED" ? "Revoke provider" : "Disable provider",
          tone: "danger",
          testId: `provider-transition-${nextStatus.toLowerCase()}`,
        });
        if (!ok) return;
      }
      setBusy(id);
      setError(null);
      const captured = stamp();
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/providers/${encodeURIComponent(id)}/transition`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId, nextStatus }),
            },
          ),
        );
        if (isStale(captured)) return;
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — the provider was not changed.");
        } else {
          setError(
            toSafeUserError(err, { message: "Transition failed." }).message,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stepUp, confirm, stamp, isStale],
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
      const captured = stamp();
      try {
        // The private key (if any) is sent write-only; the response projection
        // NEVER returns it back — we only re-read status + fingerprint.
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/providers/${encodeURIComponent(id)}/policy`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ teamId, ...patch }),
            },
          ),
        );
        if (isStale(captured)) return;
        await load();
      } catch (err) {
        if (isStale(captured)) return;
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
    [teamId, stepUp, load, stamp, isStale],
  );

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Identity Providers" />}>
        <EmptyState variant="inline"
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to configure its SSO identity providers."
        />
      </PageShell>
    );
  }

  const isOidc = OIDC_PROVIDERS.includes(createForm.provider);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Identity Providers"
          subtitle="SSO connections. Multiple providers per workspace supported. JIT provisioning + allowed-email-domains enforced at callback."
          primaryAction={
            <Button
              variant="enterprise"
              onClick={() => {
                setShowCreate(true);
                setRevealedSecret(null);
              }}
            >
              New connection
            </Button>
          }
        />
      }
            >
      {error ? <AdmInline state="error">{error}</AdmInline> : null}
      {revealedSecret ? (
        <div style={successBoxStyle}>
          <strong>Client secret created.</strong> Copy now — this is the
          only time it will be shown:{" "}
          <code style={{ fontFamily: "monospace" }}>{revealedSecret}</code>
          <Button variant="secondary" size="sm" style={{ marginInlineStart: 12 }}
            onClick={() => setRevealedSecret(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <PageSection
        title="Readiness"
        description="Whether each connection can actually sign someone in, which organization domains are DNS-verified, and whether this organization requires directory-managed identity. Every check is computed server-side."
      >
        <FederationReadinessSection teamId={teamId} />
      </PageSection>

      <PageSection
        title="Connections"
        description="Configuration and lifecycle for each identity provider."
      >
        {providers === null ? (
          <Card variant="summary" padding="comfortable" data-testid="providers-loading">
            <p className="adm-help">Loading identity providers…</p>
          </Card>
        ) : denial ? (
          <DenialPanel denial={denial} />
        ) : providers.length === 0 ? (
          <EmptyState variant="inline"
            framed
            title="No SSO provider configured"
            purpose="Connect an identity provider (Okta, Entra ID, Google Workspace, or generic OIDC/SAML) to enable single sign-on and just-in-time provisioning for this workspace."
            action={
              <Button
                variant="enterprise"
                onClick={() => {
                  setShowCreate(true);
                  setRevealedSecret(null);
                }}
              >
                New connection
              </Button>
            }
          />
        ) : (
          <div
            style={{
              width: "100%",
              overflowX: "auto",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-card)",
              background: "var(--surface-card)",
            }}
          >
          <table className="adm-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Name</th>
                <th>Status</th>
                <th>JIT</th>
                <th>Domains</th>
                <th>Last used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <React.Fragment key={p.id}>
                <tr>
                  <td>
                    <span style={{ fontWeight: 600 }}>
                      {PROVIDER_LABELS[p.provider]}
                    </span>
                  </td>
                  <td>
                    {p.displayName}
                    {p.clientSecretPreview ? (
                      <div
                        className="adm-help"
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        secret {p.clientSecretPreview}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span style={statusBadgeStyle(p.status)}>{p.status}</span>
                  </td>
                  <td>
                    <span className="adm-help">
                      {p.jitDefaultRole ?? "disabled"}
                    </span>
                  </td>
                  <td>
                    {p.allowedEmailDomains.length === 0 ? (
                      <span className="adm-help">any</span>
                    ) : (
                      <span className="adm-help" style={{ fontSize: 11 }}>
                        {p.allowedEmailDomains.join(", ")}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="adm-help">
                      {formatDateTime(p.lastUsedAtUtc)}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setExpanded((cur) => (cur === p.id ? null : p.id))
                        }
                      >
                        {expanded === p.id ? "Hide policy" : "Signing & policy"}
                      </Button>
                      {p.status === "PENDING" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "ACTIVE")}
                        >
                          Activate
                        </Button>
                      ) : null}
                      {p.status === "ACTIVE" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "DISABLED")}
                        >
                          Disable
                        </Button>
                      ) : null}
                      {p.status === "DISABLED" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "ACTIVE")}
                        >
                          Re-activate
                        </Button>
                      ) : null}
                      {p.status !== "REVOKED" ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy === p.id}
                          onClick={() => transition(p.id, "REVOKED")}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {expanded === p.id ? (
                  <tr>
                    <td style={{ padding: 0 }} colSpan={7}>
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
          {/* The connection list reads under a fixed server cap, which the
              route now ships rather than keeping to itself. */}
          <ResultCount
            shown={providers.length}
            cap={providersCap}
            noun="connection"
            data-testid="admin-providers-count"
          />
          </div>
        )}
      </PageSection>

      <StepUpModal control={stepUp} />

      {showCreate ? (
        <PageSection>
          <Card variant="admin" padding="comfortable" title="New SSO connection">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <Field label="Provider">
              <select
                className="adm-select"
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
                className="adm-input"
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
                    className="adm-input"
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
                    className="adm-input"
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
                    className="adm-input"
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
                className="adm-input"
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
                className="adm-select"
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
            <Button
              variant="enterprise"
              loading={busy === "create"}
              disabled={busy === "create"}
              onClick={submitCreate}
            >
              {busy === "create" ? "Creating…" : "Create connection"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Button>
          </div>
          </Card>
        </PageSection>
      ) : null}
    </PageShell>
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
          <div className="adm-help" style={{ fontSize: 12 }}>
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
            <div className="adm-help" style={{ fontSize: 12, color: "var(--warning-strong)" }}>
              Signing is enabled but no signing key is available. Add a
              per-connection key below or set the SAML_SP_PRIVATE_KEY
              environment variable — until then requests are sent unsigned.
            </div>
          ) : null}

          <div className="adm-help" style={{ fontSize: 12, marginTop: 4 }}>
            Replace signing key (PEM, write-only — never shown again):
          </div>
          <textarea
            value={keyDraft}
            disabled={busy}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"
            className="adm-input"
            style={{
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
            className="adm-input"
            style={{
              minHeight: 60,
              fontFamily: "monospace",
              fontSize: 11,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="enterprise"
              size="sm"
              loading={busy}
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
            </Button>
            {connection.samlSpKeyConfigured ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onUpdate({ samlSpPrivateKey: "" })}
              >
                Clear stored key
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="adm-help" style={{ fontSize: 12 }}>
          SP request signing applies to SAML connections only.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Verified-domain restriction</strong>
        <div className="adm-help" style={{ fontSize: 12 }}>
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
          <div className="adm-help" style={{ fontSize: 12, color: "var(--warning-strong)" }}>
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
