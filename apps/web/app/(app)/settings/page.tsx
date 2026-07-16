"use client";

/**
 * Settings Overview (2026-07-16 IA remediation).
 *
 * `/settings` is a COMPACT, navigational account-management index — not an
 * editing surface. The old 851-line page (always-open profile form, a
 * hardcoded "Session: Active", a ~25-link legal-document dump, a
 * context-blind "Current plan: FREE" card) is replaced by summary cards
 * that deep-link to canonical dedicated pages:
 *
 *   ACCOUNT    → /settings/profile, /settings/security,
 *                /settings/preferences, /settings/privacy
 *   WORKSPACE  → /settings/notifications, /settings/ai,
 *                /settings/reviewer-criteria (entitled plans only)
 *   BILLING    → context-aware (personal vs organization vs enterprise
 *                contract) via the canonical settings UI-context resolver
 *   ORG ADMIN  → links to existing organization surfaces for authorized
 *                admins/owners only (controls are NOT embedded here)
 *
 * Every summary value is backend-derived (auth user, platform envelope,
 * cookie-consent record). No fake status, no controls the viewer cannot
 * use. Section relevance comes from `deriveSettingsUiContext` — relevance
 * only; authorization stays on the backend.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { PageShell, PageHeader } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
// Phase IA-self-serve-simplification — gate the workspace-level
// Identity & Security card on /security-center eligibility. Self-
// serve users see only Account Security (/settings/security).
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
import { useAuth, useLocale } from "../../providers";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { deriveSettingsUiContext } from "../../../lib/settings/settingsUiContext";

type CookieConsentLatest = {
  record?: {
    id: string;
    consentVersion: string;
    createdAt: string;
  } | null;
};

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: "6px 0 0",
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "var(--ink-secondary, #475569)",
      }}
    >
      {children}
    </h2>
  );
}

function OverviewCard({
  icon,
  title,
  description,
  values,
  actionLabel,
  href,
  marker,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  values?: Array<{ label: string; value: string }>;
  actionLabel: string;
  href: string;
  marker?: Record<string, string>;
}) {
  return (
    <Card variant="admin" padding="comfortable" {...(marker ?? {})}>
      <div className="mb-4 flex items-center gap-3">
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 38,
            height: 38,
            borderRadius: 12,
            background: "var(--surface-card, #ffffff)",
            border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
            color: "var(--ink-secondary, #475569)",
          }}
        >
          {icon}
        </span>
        <div
          style={{
            fontSize: 15,
            fontWeight: 650,
            letterSpacing: "-0.01em",
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {title}
        </div>
      </div>
      <p className="m-0 text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
        {description}
      </p>
      {values && values.length > 0 ? (
        <div className="mt-3 grid gap-1.5">
          {values.slice(0, 3).map((v) => (
            <div
              key={v.label}
              className="flex items-center justify-between gap-3 text-[13px]"
            >
              <span style={{ color: "var(--ink-secondary, #475569)" }}>
                {v.label}
              </span>
              <span
                style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}
              >
                {v.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-4">
        <Link href={href}>
          <Button variant="secondary" size="sm">
            {actionLabel}
          </Button>
        </Link>
      </div>
    </Card>
  );
}

// Phase 38.9 — wrap in canonical PageRouteGate. `account.settings`
// is an ACCOUNT-domain route (NONE active-space) so it loads for every
// authenticated user. The `data-testid="account-settings-page"` marker
// is a stable Playwright mount anchor (Phase G5).
export default function SettingsPage() {
  return (
    <div data-testid="account-settings-page">
      <PageRouteGate routeId="account.settings">
        <SettingsOverview />
      </PageRouteGate>
    </div>
  );
}

function SettingsOverview() {
  const { t, locale } = useLocale();
  const { user } = useAuth();
  const { envelope } = usePlatformContext();
  // Phase IA-self-serve-simplification contract — the workspace-level
  // Identity & Security entry renders only for /security-center-eligible
  // operators.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeWorkspaceSecurity = canAccessSurface(
    surfaceUserCtx,
    "/security-center",
  );

  const ui = deriveSettingsUiContext({
    activeSpace: envelope?.activeSpace
      ? {
          type: envelope.activeSpace.type,
          id: envelope.activeSpace.id,
          displayName: envelope.activeSpace.displayName,
        }
      : null,
    // Canonical envelope fields only (the legacy workspace fragment is
    // deliberately not read): personalSpace.plan is populated exactly when
    // the active space is PERSONAL; organization plans come from
    // envelope.organizations inside the resolver.
    workspacePlan: envelope?.personalSpace?.plan ?? null,
    accountPlan: envelope?.account?.accountPlan ?? null,
    organizations: envelope?.organizations ?? [],
    planFeatures: envelope?.planFeatures ?? null,
  });

  const [latestCookieConsent, setLatestCookieConsent] =
    useState<CookieConsentLatest["record"]>(null);
  useEffect(() => {
    if (!user?.id) return;
    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: CookieConsentLatest) => setLatestCookieConsent(data.record ?? null))
      .catch(() => setLatestCookieConsent(null));
  }, [user?.id]);

  const providerKey = (user?.provider ?? "").toLowerCase();
  const providerLabel =
    OAUTH_PROVIDER_LABELS[providerKey] ?? (providerKey ? "Email & password" : "—");

  return (
    <PageShell
      className="settings-page-shell"
      header={
        <PageHeader
          eyebrow={t("settings")}
          title="Account settings"
          subtitle="A compact overview of your account. Each section opens its dedicated page — profile, security, preferences, privacy, notifications, and billing."
          contextStrip={
            <>
              <Badge tone="info">Account</Badge>
              <Badge tone="neutral">{ui.activeWorkspaceName}</Badge>
            </>
          }
        />
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <SectionHeading>Account</SectionHeading>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          }}
        >
          <OverviewCard
            icon={<Icons.Dashboard />}
            title="Profile & identity"
            description="Your display name, avatar, and account identity used across evidence reviews, reports, and invitations."
            values={[
              { label: "Name", value: user?.displayName || user?.email || "—" },
              { label: "Email", value: user?.email ?? "—" },
              { label: "Login method", value: providerLabel },
            ]}
            actionLabel="Open profile"
            href="/settings/profile"
            marker={{ "data-cc-overview-profile": "true" }}
          />
          <Card
            variant="admin"
            padding="comfortable"
            data-cc-account-security-link-card
          >
            <div className="mb-4 flex items-center gap-3">
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: "var(--surface-card, #ffffff)",
                  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                <Icons.Security />
              </span>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Account security
              </div>
            </div>
            <p
              className="m-0 text-[13px]"
              style={{ color: "var(--ink-secondary, #475569)" }}
            >
              Password, two-factor authentication, active sessions, and your
              recent security activity.
            </p>
            <div className="mt-4">
              <Link href="/settings/security">
                <Button variant="secondary" size="sm">
                  Open Account security
                </Button>
              </Link>
            </div>
          </Card>
          <OverviewCard
            icon={<Icons.Settings />}
            title="Preferences"
            description="UI language and your account timezone — the default used for digests, quiet hours, and local-time displays."
            values={[
              { label: "Language", value: String(locale ?? "en").toUpperCase() },
              { label: "Timezone", value: user?.timezone || "Not set" },
            ]}
            actionLabel="Open preferences"
            href="/settings/preferences"
            marker={{ "data-cc-overview-preferences": "true" }}
          />
          <OverviewCard
            icon={<Icons.Security />}
            title="Privacy & legal records"
            description="Cookie preferences and your recorded policy acceptances — consent, contract acceptance, and acknowledgements, kept distinct."
            values={
              latestCookieConsent
                ? [
                    {
                      label: "Cookie consent",
                      value: `v${latestCookieConsent.consentVersion} · ${formatUserDateTime(latestCookieConsent.createdAt)}`,
                    },
                  ]
                : undefined
            }
            actionLabel="Open privacy"
            href="/settings/privacy"
            marker={{ "data-cc-overview-privacy": "true" }}
          />
        </div>

        <SectionHeading>Workspace</SectionHeading>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          }}
        >
          {ui.showNotifications ? (
            // PRODUCT CONTRACT (Option B, 2026-07-16): this card is
            // NAVIGATION-ONLY by decision. It shows the current workspace and
            // routes to the canonical per-workspace preferences page; it does
            // NOT summarize digest/quiet-hours state (no read API exposes an
            // aggregated summary, and a half-rich card with missing values
            // would mislead). If a canonical summary endpoint ever exists,
            // revisit deliberately — do not add partial values here.
            <OverviewCard
              icon={<Icons.Settings />}
              title="Notification preferences"
              description="Manage in-app, email, digest and quiet-hour preferences for each workspace."
              values={[{ label: "Workspace", value: ui.activeWorkspaceName }]}
              actionLabel="Open notification preferences"
              href="/settings/notifications"
              marker={{ "data-cc-overview-notifications": "true" }}
            />
          ) : null}
          {ui.showAiSettings ? (
            <OverviewCard
              icon={<Icons.Settings />}
              title="AI & automation"
              description="Workspace AI governance — enable or disable AI capabilities and data-class limits."
              actionLabel="Open AI settings"
              href="/settings/ai"
            />
          ) : null}
          {ui.showReviewerCriteria ? (
            <OverviewCard
              icon={<Icons.Settings />}
              title="Reviewer criteria"
              description="Versioned, human-authored reviewer criteria sets for this workspace."
              actionLabel="Open reviewer criteria"
              href="/settings/reviewer-criteria"
            />
          ) : null}
        </div>

        <SectionHeading>Billing</SectionHeading>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          }}
        >
          <Card
            variant="admin"
            padding="comfortable"
            data-cc-billing-context={ui.billing.contextType}
          >
            <div className="mb-4 flex items-center gap-3">
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: "var(--surface-card, #ffffff)",
                  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                <Icons.Billing />
              </span>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Subscription
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span style={{ color: "var(--ink-secondary, #475569)" }}>
                {ui.billing.scopeLabel}
              </span>
              <span style={{ color: "#4F46E5", fontWeight: 650 }}>
                {ui.billing.displayPlan}
              </span>
            </div>
            {ui.billing.managedByOrgName ? (
              <p
                className="m-0 mt-2 text-[13px]"
                style={{ color: "var(--ink-secondary, #475569)" }}
              >
                {ui.billing.contextType === "enterprise-contract"
                  ? `Managed under ${ui.billing.managedByOrgName}'s organization agreement. Contact your organization administrator for billing.`
                  : ui.billing.canManageBilling
                    ? `Billing for ${ui.billing.managedByOrgName}.`
                    : `Billing is managed by ${ui.billing.managedByOrgName}'s administrators.`}
              </p>
            ) : null}
            {ui.billing.billingHref ? (
              <div className="mt-4">
                <Link href={ui.billing.billingHref}>
                  <Button variant="secondary" size="sm">
                    Go to Billing
                  </Button>
                </Link>
              </div>
            ) : null}
          </Card>
        </div>

        {/* ORGANIZATION ADMINISTRATION — contextual LINKS only, for
            authorized org admins/owners. Controls stay in their canonical
            organization surfaces; nothing is embedded here. */}
        {(ui.showOrgAdminLinks || canSeeWorkspaceSecurity) ? (
          <>
            <SectionHeading>Organization administration</SectionHeading>
            <div
              style={{
                display: "grid",
                gap: 14,
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              }}
            >
              {ui.showOrgAdminLinks && ui.orgAdminOrgId ? (
                <OverviewCard
                  icon={<Icons.Settings />}
                  title="Organization settings"
                  description="Members, roles, governance, access reviews, retention, audit, and organization policy."
                  actionLabel="Open organization admin"
                  href={`/organizations/${ui.orgAdminOrgId}/admin`}
                  marker={{ "data-cc-overview-org-admin": "true" }}
                />
              ) : null}
              {/* Phase Final-D5-PT2 contract — the workspace identity console
                  entry point (renders only for eligible operators). */}
              {canSeeWorkspaceSecurity ? (
                <Card
                  variant="admin"
                  padding="comfortable"
                  data-cc-security-link-card
                >
                  <div
                    className="mb-3"
                    style={{
                      fontSize: 15,
                      fontWeight: 650,
                      color: "var(--ink-primary, #0f172a)",
                    }}
                  >
                    Identity &amp; Security
                  </div>
                  <p
                    className="m-0 text-[13px]"
                    style={{ color: "var(--ink-secondary, #475569)" }}
                  >
                    Workspace identity operations: MFA policy, trusted devices,
                    session revocations, and MFA recovery approvals.
                    Operator/admin access required.
                  </p>
                  <div className="mt-4">
                    <Link href="/security-center" data-cc-security-link-card>
                      <Button variant="secondary" size="sm">
                        Open Security Center
                      </Button>
                    </Link>
                  </div>
                </Card>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </PageShell>
  );
}
