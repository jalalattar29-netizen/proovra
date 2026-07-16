"use client";

/**
 * Privacy & Legal Records (2026-07-16 Settings IA remediation).
 *
 * Account-relevant privacy content ONLY:
 *
 *   A. Cookie preferences — manage via the consent modal; the latest
 *      recorded consent (version + timestamp + categories) is shown.
 *   B. Legal acceptance history — a STRUCTURED list from
 *      GET /v1/users/legal-acceptance, with the semantic TYPE made
 *      explicit per record. Consent, contract acceptance, and
 *      acknowledgement are legally distinct and are never conflated:
 *        terms   → Contract acceptance
 *        privacy → Acknowledgement
 *        cookies → Consent
 *      (The backend records rows only on explicit acceptance actions —
 *      never on merely viewing a policy.)
 *   C. Privacy actions — only REAL existing flows are linked (privacy
 *      requests). No invented deletion/export buttons: those flows do
 *      not exist in the product today.
 *   D. Essential references — Privacy Policy, Terms, Cookie Policy only.
 *      The full public legal library stays in the footer and the public
 *      Trust Center; the old ~25-link dump does not belong here.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { openCookiePreferences } from "../../../../lib/consent";
import { useAuth } from "../../../providers";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

type LegalAcceptanceItem = {
  id: string;
  policyKey: string;
  policyVersion: string;
  acceptedAt: string;
  source?: string | null;
};

type CookieConsentRecord = {
  id: string;
  consentVersion: string;
  necessary: boolean;
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
  createdAt: string;
};

/**
 * Semantic classification per policy key — consent, contract acceptance,
 * and acknowledgement are NOT legally equivalent and are labeled apart.
 */
const POLICY_PRESENTATION: Record<
  string,
  { title: string; kind: string }
> = {
  terms: { title: "Terms of Service accepted", kind: "Contract acceptance" },
  privacy: { title: "Privacy notice acknowledged", kind: "Acknowledgement" },
  cookies: { title: "Cookie policy accepted", kind: "Consent" },
};

function presentPolicy(key: string): { title: string; kind: string } {
  return (
    POLICY_PRESENTATION[key] ?? {
      title: `${key} accepted`,
      kind: "Acceptance",
    }
  );
}

const sectionTitle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--ink-primary, #0f172a)",
};

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

export default function PrivacyPage() {
  return (
    <div data-testid="account-privacy-page">
      <PageRouteGate routeId="account.privacy">
        <PrivacyInner />
      </PageRouteGate>
    </div>
  );
}

function PrivacyInner() {
  const { user } = useAuth();
  const [acceptances, setAcceptances] = useState<LegalAcceptanceItem[] | null>(null);
  const [cookieConsent, setCookieConsent] = useState<CookieConsentRecord | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    apiFetch("/v1/users/legal-acceptance")
      .then((data: { items?: LegalAcceptanceItem[] }) =>
        setAcceptances(Array.isArray(data.items) ? data.items : []),
      )
      .catch(() => setAcceptances([]));
    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: { record?: CookieConsentRecord | null }) =>
        setCookieConsent(data.record ?? null),
      )
      .catch(() => setCookieConsent(null));
  }, [user?.id]);

  const consentCategories = cookieConsent
    ? (
        [
          ["Necessary", cookieConsent.necessary],
          ["Preferences", cookieConsent.preferences],
          ["Analytics", cookieConsent.analytics],
          ["Marketing", cookieConsent.marketing],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([label]) => label)
        .join(", ")
    : null;

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Account"
          title="Privacy & legal records"
          subtitle="Your cookie preferences and recorded policy acceptances. Consent, contract acceptance, and acknowledgements are recorded — and shown — as distinct record types."
        />
      }
    >
      <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
        {/* A. Cookie preferences */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-cookies>
          <h2 style={sectionTitle}>Cookie preferences</h2>
          {cookieConsent ? (
            <div className="grid gap-1.5 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Consent version</span>
                <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                  v{cookieConsent.consentVersion}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Recorded</span>
                <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                  {formatUserDateTime(cookieConsent.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Allowed categories</span>
                <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                  {consentCategories || "Necessary only"}
                </span>
              </div>
            </div>
          ) : (
            <p style={muted}>No cookie consent recorded on this account yet.</p>
          )}
          <div className="mt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openCookiePreferences()}
              data-cc-privacy-manage-cookies
            >
              Manage Cookie Preferences
            </Button>
          </div>
        </Card>

        {/* B. Legal acceptance history — structured, typed rows */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-acceptances>
          <h2 style={sectionTitle}>Policy acceptance history</h2>
          <p style={muted}>
            Records are written only when you explicitly accept — viewing a
            policy is never recorded as consent.
          </p>
          {acceptances === null ? (
            <p style={{ ...muted, marginTop: 10 }}>Loading…</p>
          ) : acceptances.length === 0 ? (
            <p style={{ ...muted, marginTop: 10 }}>
              No acceptance records on this account yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
              {acceptances.map((item) => {
                const p = presentPolicy(item.policyKey);
                return (
                  <li
                    key={item.id}
                    data-cc-privacy-acceptance-row={item.policyKey}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "9px 2px",
                      borderBottom:
                        "1px solid var(--border-default, rgba(15,23,42,0.07))",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                      {p.title}
                      <Badge tone="neutral" subtle style={{ marginLeft: 8 }}>
                        {p.kind}
                      </Badge>
                    </span>
                    <span style={muted}>
                      v{item.policyVersion} · {formatUserDateTime(item.acceptedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* C+D. Privacy actions + essential references. Only REAL flows —
            no invented deletion/export buttons. */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-references>
          <h2 style={sectionTitle}>Privacy actions &amp; references</h2>
          <div className="grid gap-2 text-[13.5px]">
            <Link href="/legal/privacy-requests" style={{ color: "var(--ink-primary, #0f172a)" }}>
              Submit a privacy request →
            </Link>
            <Link href="/privacy" style={{ color: "var(--ink-secondary, #475569)" }}>
              Privacy Policy
            </Link>
            <Link href="/terms" style={{ color: "var(--ink-secondary, #475569)" }}>
              Terms of Service
            </Link>
            <Link href="/legal/cookies" style={{ color: "var(--ink-secondary, #475569)" }}>
              Cookie Policy
            </Link>
          </div>
          <p style={{ ...muted, marginTop: 10 }}>
            The full legal library (DPA, subprocessors, retention, disclosure
            policies, …) lives in the public Trust Center and site footer.
          </p>
        </Card>
      </div>
    </PageShell>
  );
}
