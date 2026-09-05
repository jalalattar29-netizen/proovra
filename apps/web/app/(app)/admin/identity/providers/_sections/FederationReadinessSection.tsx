"use client";

/**
 * PHASE 12B — Federation readiness + domain binding + managed-identity
 * enforcement visibility.
 *
 * Backed by GET /v1/auth/sso/readiness, which computes EVERY decision
 * server-side (readiness, blockers, verified-domain binding, whether the
 * Organization enforces managed identity). This component renders what the
 * server states and derives no policy of its own.
 *
 * It carries NO secret material: the projection contains client-secret and
 * signing-key *status* only — never a value, never a private key.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../../../lib/platform-context";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";

export type FederationReadiness = {
  teamId: string;
  organizationId: string | null;
  policyProvisioned: boolean;
  /** null = the server could not resolve the policy. NEVER read as "false". */
  managedIdentityRequired: boolean | null;
  domains: Array<{
    id: string;
    domain: string;
    verified: boolean;
    verifiedAtUtc: string | null;
  }>;
  verifiedDomainCount: number;
  connections: Array<{
    id: string;
    provider: string;
    displayName: string;
    status: string;
    ready: boolean;
    blockers: string[];
    restrictToVerifiedDomains: boolean;
    boundDomains: string[];
    unverifiedBoundDomains: string[];
    consecutiveFailureCount: number;
    inOutage: boolean;
    lastUsedAtUtc: string | null;
  }>;
};

const BLOCKER_COPY: Record<string, string> = {
  IDP_SSO_URL_MISSING: "The identity provider's sign-in URL has not been set.",
  SP_ENTITY_ID_MISSING: "This connection has no service-provider entity ID yet.",
  IDP_CERTIFICATE_MISSING:
    "The identity provider's signing certificate is missing, so assertions cannot be verified.",
  SP_CERTIFICATE_MISSING:
    "Request signing is on but no service-provider certificate is installed.",
  ISSUER_URL_MISSING: "The OIDC issuer / discovery URL has not been set.",
  CLIENT_ID_MISSING: "The OIDC client ID has not been set.",
  NO_VERIFIED_DOMAIN:
    "This connection is restricted to verified domains, but no organization domain has been verified.",
  NOT_ACTIVE: "The connection is not active, so nobody can sign in through it.",
};

const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary)",
} as const;

type Phase =
  | { kind: "loading" }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "ready"; readiness: FederationReadiness };

export function FederationReadinessSection({ teamId }: { teamId: string }) {
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const r = (await apiFetch(
        `/v1/auth/sso/readiness?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { readiness: FederationReadiness };
      if (isStale(captured)) return;
      setPhase({ kind: "ready", readiness: r.readiness });
    } catch (err) {
      if (isStale(captured)) return;
      const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown };
      const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
      const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
      if (
        status === 403 ||
        status === 404 ||
        code === "forbidden" ||
        code === "not_found" ||
        code === "permission_denied"
      ) {
        setPhase({
          kind: "denied",
          detail:
            "Your role in this workspace does not allow reading its federation configuration. Nothing was loaded.",
        });
        return;
      }
      setPhase({
        kind: "error",
        detail: toSafeUserError(err, {
          message: "Could not load federation readiness.",
        }).message,
      });
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === "loading") {
    return (
      <Card variant="summary" padding="comfortable" data-testid="federation-readiness-loading">
        <p style={mutedStyle}>Checking federation readiness…</p>
      </Card>
    );
  }

  if (phase.kind === "denied") {
    return (
      <Card
        variant="status"
        tone="risk"
        padding="comfortable"
        data-testid="federation-readiness-denied"
 >
        <strong style={{ fontSize: 14 }}>Readiness not available to you</strong>
        <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0 }}>{phase.detail}</p>
      </Card>
    );
  }

  if (phase.kind === "error") {
    return (
      <Card
        variant="status"
        tone="risk"
        padding="comfortable"
        data-testid="federation-readiness-error"
 >
        <strong style={{ fontSize: 14 }}>Readiness check didn't complete</strong>
        <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const { readiness } = phase;
  const notReady = readiness.connections.filter((c) => !c.ready);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
      data-testid="federation-readiness"
 >
      <Card
        variant="status"
        tone={notReady.length > 0 ? "risk" : "governance"}
        padding="comfortable"
 >
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={mutedStyle}>Connections ready to sign in</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {readiness.connections.length - notReady.length} of{" "}
              {readiness.connections.length}
            </div>
          </div>
          <div>
            <div style={mutedStyle}>Verified organization domains</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {readiness.verifiedDomainCount}
            </div>
          </div>
          <div>
            <div style={mutedStyle}>Managed identity</div>
            <div style={{ marginTop: 4 }} data-testid="managed-identity-enforcement">
              {readiness.managedIdentityRequired === null ? (
                <Badge tone="risk" subtle>
                  {readiness.policyProvisioned
                    ? "Could not be confirmed"
                    : "No organization policy"}
                </Badge>
              ) : readiness.managedIdentityRequired ? (
                <Badge tone="governance" subtle>
                  Required for every member
                </Badge>
              ) : (
                <Badge tone="neutral" subtle>
                  Not required
                </Badge>
              )}
            </div>
          </div>
          <div style={{ marginInlineStart: "auto" }}>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Re-check
            </Button>
          </div>
        </div>
        {readiness.managedIdentityRequired === null ? (
          <p style={{ ...mutedStyle, marginTop: 12, marginBottom: 0, maxWidth: 640 }}>
            The server could not confirm this organization&apos;s managed-identity
            requirement, so we are not claiming it is switched off. Resolve the
            organization security policy before relying on directory ownership.
          </p>
        ) : null}
      </Card>

      <Card
        variant="admin"
        padding="comfortable"
        title="Domain binding"
        data-testid="federation-domain-binding"
 >
        {readiness.domains.length === 0 ? (
          <EmptyState variant="inline"
            title="No organization domain claimed"
            purpose="Claim and verify a domain to bind single sign-on to email addresses your organization actually controls. Until then, verified-domain restriction cannot be switched on."
          />
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {readiness.domains.map((d) => (
              <li
                key={d.id}
                style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                data-domain-verified={d.verified ? "true" : "false"}
 >
                <code style={{ fontFamily: "monospace", fontSize: 12.5 }}>{d.domain}</code>
                {d.verified ? (
                  <Badge tone="verified" subtle>
                    DNS verified
                  </Badge>
                ) : (
                  <Badge tone="risk" subtle>
                    Not verified
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {notReady.length > 0 ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          title="These connections cannot sign anyone in yet"
          data-testid="federation-readiness-blockers"
 >
          <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 10 }}>
            {notReady.map((c) => (
              <li key={c.id}>
                <strong style={{ fontSize: 13 }}>{c.displayName}</strong>{" "}
                <span style={mutedStyle}>({c.status.toLowerCase()})</span>
                <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
                  {c.blockers.map((b) => (
                    <li key={b} style={mutedStyle}>
                      {BLOCKER_COPY[b] ?? "This connection needs more configuration."}
                    </li>
                  ))}
                  {c.unverifiedBoundDomains.length > 0 ? (
                    <li style={mutedStyle}>
                      Bound to {c.unverifiedBoundDomains.length} domain
                      {c.unverifiedBoundDomains.length === 1 ? "" : "s"} that
                      have not been DNS-verified.
                    </li>
                  ) : null}
                  {c.inOutage ? (
                    <li style={mutedStyle}>
                      The identity provider is currently flagged as unavailable
                      ({c.consecutiveFailureCount} consecutive failures).
                    </li>
                  ) : null}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
