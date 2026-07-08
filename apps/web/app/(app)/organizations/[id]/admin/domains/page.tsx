"use client";

/**
 * Phase 3 (Enterprise Identity) — Org admin / Domains tab.
 *
 * Organization Security > Domains. Lists claimed domains + verification
 * status, lets an org security admin add a domain (surfacing the DNS TXT
 * challenge returned by the backend), verify it (DNS TXT re-check), and
 * remove a claim.
 *
 * Backend (services/api/src/routes/organization-domains.routes.ts):
 *   GET    /v1/orgs/:orgId/domains            — list + status.
 *   POST   /v1/orgs/:orgId/domains            — add; returns DNS challenge.
 *   POST   /v1/orgs/:orgId/domains/:id/verify — DNS TXT check (step-up).
 *   DELETE /v1/orgs/:orgId/domains/:id        — remove claim (step-up).
 *
 * Gating: the backend enforces ORG_SECURITY_ADMIN / ORG_ADMIN on the org
 * plus the enterprise `ssoScim` feature gate. The web surface is
 * ENTERPRISE-tier (path-prefix `/organizations` in lib/surface/tiers.ts,
 * plus the org-admin shell only renders for org members). Verify + remove
 * route through the shared step-up modal because they change the identity
 * boundary that gates SSO logins.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm — destructive remove uses ConfirmActionModal.
 *   - toSafeUserError is the ONLY error-display path.
 *   - Strong TypeScript types throughout.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../components/identity-security/StepUpModal";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";

// ---------------------------------------------------------------------------
// Wire types — mirror /v1/orgs/:orgId/domains.
// ---------------------------------------------------------------------------

type DnsChallenge = {
  recordName: string;
  recordType: "TXT";
  recordValue: string;
};

type OrgDomain = {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  /** Present only while the domain is unverified. */
  challenge: DnsChallenge | null;
};

type ListResponse = { domains: OrgDomain[] };

type AddResponse = OrgDomain & { challenge: DnsChallenge };

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export default function OrganizationAdminDomainsPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <DomainsTab />
    </PageRouteGate>
  );
}

const cardBaseStyle = {
  padding: "1rem 1.1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
} as const;

function DomainsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  // Step-up challenges are workspace-scoped; bind to the active workspace.
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();

  const [domains, setDomains] = useState<OrgDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [addDomain, setAddDomain] = useState("");
  const [lastChallenge, setLastChallenge] = useState<{
    domain: string;
    challenge: DnsChallenge;
  } | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = (await apiFetch(`/v1/orgs/${orgId}/domains`, {
        method: "GET",
      })) as ListResponse | null;
      setDomains(res?.domains ?? []);
      setError(null);
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Couldn't load domains." }).message,
      );
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitAdd = useCallback(async () => {
    const value = addDomain.trim();
    if (!value || !orgId) return;
    setBusy("add");
    setError(null);
    setNotice(null);
    try {
      const res = (await apiFetch(`/v1/orgs/${orgId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: value }),
      })) as AddResponse | null;
      if (res?.challenge) {
        setLastChallenge({ domain: res.domain, challenge: res.challenge });
        setNotice(
          `Added ${res.domain}. Publish the DNS TXT record below, then click Verify.`,
        );
      }
      setAddDomain("");
      await load();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Couldn't add domain." }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [addDomain, orgId, load]);

  const verify = useCallback(
    async (domain: OrgDomain) => {
      if (!orgId) return;
      setBusy(domain.id);
      setError(null);
      setNotice(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/orgs/${orgId}/domains/${domain.id}/verify`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({}),
            },
          );
        });
        setNotice(`${domain.domain} is now verified.`);
        await load();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — domain was not verified.");
        } else {
          setError(
            toSafeUserError(err, {
              message:
                "Verification failed. Confirm the DNS TXT record is published and try again.",
            }).message,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [orgId, load, stepUp],
  );

  const remove = useCallback(
    async (domain: OrgDomain) => {
      if (!orgId) return;
      const ok = await confirm({
        title: `Remove ${domain.domain}?`,
        description:
          "Removing a verified domain drops the identity claim that gates SSO logins for its users. This requires step-up authentication and is audited.",
        confirmLabel: "Remove domain",
        tone: "danger",
        testId: "org-domain-remove",
      });
      if (!ok) return;
      setBusy(domain.id);
      setError(null);
      setNotice(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(`/v1/orgs/${orgId}/domains/${domain.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          });
        });
        setNotice(`${domain.domain} removed.`);
        if (lastChallenge?.domain === domain.domain) setLastChallenge(null);
        await load();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — domain was not removed.");
        } else {
          setError(
            toSafeUserError(err, { message: "Remove failed." }).message,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [orgId, load, stepUp, confirm, lastChallenge],
  );

  return (
    <section data-testid="org-admin-domains" data-org-id={orgId}>
      {/* Intro + add form */}
      <section data-section="domains-add" style={{ ...cardBaseStyle, marginBottom: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Verified domains</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Claim the email domains your organization owns. Verified domains let
          you enforce SSO and auto-associate members. Verification is proven by
          publishing a DNS <strong>TXT</strong> record we generate for you.
        </p>

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            data-testid="org-domain-input"
            value={addDomain}
            onChange={(e) => setAddDomain(e.target.value)}
            placeholder="example.com"
            aria-label="Domain to add"
            style={{
              flex: "1 1 260px",
              minWidth: 200,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid rgba(127,127,127,0.4)",
              fontSize: 14,
            }}
          />
          <button
            type="button"
            data-testid="org-domain-add-submit"
            className="cases-filter-chip"
            disabled={busy === "add" || !addDomain.trim()}
            onClick={submitAdd}
          >
            {busy === "add" ? "Adding…" : "Add domain"}
          </button>
        </div>
      </section>

      {error ? (
        <div
          data-testid="org-domains-error"
          role="alert"
          style={{
            ...cardBaseStyle,
            marginBottom: "1rem",
            borderColor: "rgba(220,38,38,0.4)",
            background: "rgba(220,38,38,0.08)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          data-testid="org-domains-notice"
          style={{
            ...cardBaseStyle,
            marginBottom: "1rem",
            borderColor: "rgba(16,185,129,0.4)",
            background: "rgba(16,185,129,0.08)",
            fontSize: 13,
          }}
        >
          {notice}
        </div>
      ) : null}

      {/* DNS challenge callout (from the most recent add). */}
      {lastChallenge ? (
        <ChallengeCallout
          domain={lastChallenge.domain}
          challenge={lastChallenge.challenge}
        />
      ) : null}

      {/* Domain list */}
      <section data-section="domains-list" style={cardBaseStyle}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Claimed domains</h2>
        {domains === null ? (
          <p style={{ fontSize: 13, opacity: 0.75, marginTop: 12 }}>Loading…</p>
        ) : domains.length === 0 ? (
          <p
            data-testid="org-domains-empty"
            style={{ fontSize: 13, opacity: 0.75, marginTop: 12 }}
          >
            No domains claimed yet. Add one above to get started.
          </p>
        ) : (
          <ul
            data-testid="org-domains-list"
            style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0" }}
          >
            {domains.map((d) => (
              <li
                key={d.id}
                data-testid={`org-domain-row-${d.id}`}
                data-verified={d.verified ? "true" : "false"}
                style={{
                  padding: "0.6rem 0",
                  borderBottom: "1px solid rgba(127,127,127,0.18)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 600 }}>{d.domain}</div>
                  <StatusPill verified={d.verified} verifiedAt={d.verifiedAt} />
                  {!d.verified && d.challenge ? (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        opacity: 0.8,
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                      }}
                    >
                      TXT {d.challenge.recordName} = {d.challenge.recordValue}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {!d.verified ? (
                    <button
                      type="button"
                      data-testid={`org-domain-verify-${d.id}`}
                      className="cases-filter-chip"
                      disabled={busy === d.id}
                      onClick={() => verify(d)}
                    >
                      {busy === d.id ? "Verifying…" : "Verify"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`org-domain-remove-${d.id}`}
                    className="cases-filter-chip"
                    disabled={busy === d.id}
                    onClick={() => remove(d)}
                    style={{ color: "#991b1b" }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <StepUpModal control={stepUp} />
    </section>
  );
}

function StatusPill({
  verified,
  verifiedAt,
}: {
  verified: boolean;
  verifiedAt: string | null;
}) {
  return (
    <div
      data-state={verified ? "verified" : "unverified"}
      style={{
        fontSize: 11,
        marginTop: 4,
        padding: "1px 8px",
        borderRadius: 999,
        background: verified
          ? "rgba(16,185,129,0.18)"
          : "rgba(245,158,11,0.18)",
        display: "inline-block",
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
      }}
    >
      {verified
        ? verifiedAt
          ? `Verified ${new Date(verifiedAt).toLocaleDateString()}`
          : "Verified"
        : "Unverified"}
    </div>
  );
}

function ChallengeCallout({
  domain,
  challenge,
}: {
  domain: string;
  challenge: DnsChallenge;
}) {
  return (
    <section
      data-testid="org-domain-challenge"
      style={{
        ...cardBaseStyle,
        marginBottom: "1rem",
        background: "rgba(59,130,246,0.06)",
        borderColor: "rgba(59,130,246,0.35)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14 }}>
        Publish this DNS record for {domain}
      </h3>
      <p style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
        Add the following <strong>TXT</strong> record at your DNS provider, then
        click <em>Verify</em> on the domain below. DNS changes can take a few
        minutes to propagate.
      </p>
      <dl
        style={{
          margin: "10px 0 0",
          fontSize: 12,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
        }}
      >
        <dt style={{ opacity: 0.7 }}>Type</dt>
        <dd style={{ margin: 0, fontFamily: "monospace" }}>
          {challenge.recordType}
        </dd>
        <dt style={{ opacity: 0.7 }}>Name</dt>
        <dd
          data-testid="org-domain-challenge-name"
          style={{ margin: 0, fontFamily: "monospace", wordBreak: "break-all" }}
        >
          {challenge.recordName}
        </dd>
        <dt style={{ opacity: 0.7 }}>Value</dt>
        <dd
          data-testid="org-domain-challenge-value"
          style={{ margin: 0, fontFamily: "monospace", wordBreak: "break-all" }}
        >
          {challenge.recordValue}
        </dd>
      </dl>
    </section>
  );
}
