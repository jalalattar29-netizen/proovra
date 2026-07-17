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
// Phase IA-self-serve-simplification — gate the workspace-level
// Identity & Security card on /security-center eligibility. Self-
// serve users see only Account Security (/settings/security).
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
import { useAuth, useLocale } from "../../providers";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { deriveSettingsUiContext } from "../../../lib/settings/settingsUiContext";
import { useAccountSecuritySummary } from "../../../lib/security/useAccountSecuritySummary";
import { useActiveWorkspaceId } from "../../../lib/platform-context";
import {
  deriveAiSettingsMode,
  enabledPersonalFeatureCount,
  showAiOverviewCard,
  type PersonalAiPolicySlice,
} from "../../../lib/ai/aiAssistanceView";

type CookieConsentLatest = {
  record?: {
    id: string;
    consentVersion: string;
    createdAt: string;
  } | null;
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
  const [policyRecordCount, setPolicyRecordCount] = useState<number | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: CookieConsentLatest) => setLatestCookieConsent(data.record ?? null))
      .catch(() => setLatestCookieConsent(null));
    apiFetch("/v1/users/legal-acceptance")
      .then((data: { items?: unknown[] }) =>
        setPolicyRecordCount(Array.isArray(data.items) ? data.items.length : null),
      )
      .catch(() => setPolicyRecordCount(null));
  }, [user?.id]);

  // §1.1 — the Account Security card shows a REAL summary from the same
  // canonical security APIs the security page consumes. Never hardcoded.
  const security = useAccountSecuritySummary(Boolean(user?.id));

  // §1.3 — AI card mode + summary. The card renders only when the plan
  // actually includes AI assistance (or the workspace is an organization).
  const activeWorkspaceId = useActiveWorkspaceId();
  const aiMode = deriveAiSettingsMode({
    workspaceKind: ui.isPersonalWorkspace ? "PERSONAL" : "ORGANIZATION",
    monthlyAllowance: envelope?.planFeatures?.aiAssistanceMonthlyOperations,
    orgRole: null, // overview card copy does not depend on the org role
  });
  const [aiPolicy, setAiPolicy] = useState<PersonalAiPolicySlice | null>(null);
  const [aiAllowance, setAiAllowance] = useState<{
    monthlyOperations: number | null;
    consumed: number;
  } | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || !ui.showAiSettings || !ui.isPersonalWorkspace) return;
    let alive = true;
    apiFetch(`/v1/workspaces/ai-policy?teamId=${activeWorkspaceId}`)
      .then((r) => {
        if (alive) setAiPolicy((r as { policy: PersonalAiPolicySlice }).policy ?? null);
      })
      .catch(() => undefined);
    apiFetch(`/v1/workspaces/ai-usage?teamId=${activeWorkspaceId}`)
      .then((r) => {
        const a = (r as {
          allowance?: { monthlyOperations: number | null; consumed: number } | null;
        }).allowance;
        if (alive && a) setAiAllowance(a);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [activeWorkspaceId, ui.showAiSettings, ui.isPersonalWorkspace]);

  const enabledAiFeatures = enabledPersonalFeatureCount(aiPolicy);

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
      {/* §1.4 — bounded content width + balanced card grid so the lower
          half of the page never reads as an unfinished empty region. */}
      <div style={{ display: "grid", gap: 14, maxWidth: 1080 }}>
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
            description="Your display name and account identity used across evidence reviews, reports, and invitations."
            values={[
              { label: "Name", value: user?.displayName || user?.email || "—" },
              { label: "Email", value: user?.email ?? "—" },
            ]}
            actionLabel="Open profile"
            href="/settings/profile"
            marker={{ "data-cc-overview-profile": "true" }}
          />
          <OverviewCard
            icon={<Icons.Security />}
            title="Account security"
            description="Login methods, two-factor authentication, active sessions, and your recent security activity."
            values={[
              {
                label: "Login method",
                value: security.loginMethods ?? "…",
              },
              {
                label: "Two-factor",
                value:
                  security.mfaConfigured === null
                    ? "…"
                    : security.mfaConfigured
                      ? "Enabled"
                      : "Not configured",
              },
              {
                label: "Active sessions",
                value:
                  security.activeSessions === null
                    ? "…"
                    : String(security.activeSessions),
              },
            ]}
            actionLabel="Open Account security"
            href="/settings/security"
            marker={{ "data-cc-account-security-link-card": "true" }}
          />
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
            description="Cookie preferences, recorded policy acceptances, your personal data export, and account closure."
            values={[
              {
                label: "Cookie preferences",
                value: latestCookieConsent ? "Configured" : "Not configured",
              },
              ...(policyRecordCount !== null
                ? [{ label: "Policy records", value: String(policyRecordCount) }]
                : []),
            ]}
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
          {ui.showAiSettings && showAiOverviewCard(aiMode) ? (
            ui.isPersonalWorkspace ? (
              <OverviewCard
                icon={<Icons.Settings />}
                title="AI assistance"
                description="Manage the AI-assisted features available in your Personal Space and review your monthly usage."
                values={[
                  ...(aiPolicy
                    ? [
                        {
                          label: "AI assistance",
                          value: aiPolicy.aiEnabled ? "On" : "Off",
                        },
                        {
                          label: "Enabled features",
                          value: String(enabledAiFeatures ?? 0),
                        },
                      ]
                    : []),
                  ...(aiAllowance && aiAllowance.monthlyOperations !== null
                    ? [
                        {
                          label: "Monthly usage",
                          value: `${aiAllowance.consumed} of ${aiAllowance.monthlyOperations} operations`,
                        },
                      ]
                    : []),
                ]}
                actionLabel="Open AI assistance"
                href="/settings/ai"
                marker={{ "data-cc-overview-ai": "personal" }}
              />
            ) : (
              <OverviewCard
                icon={<Icons.Settings />}
                title="AI & automation"
                description="Organization AI governance — capability policy, data-class controls, and usage."
                actionLabel="Open AI settings"
                href="/settings/ai"
                marker={{ "data-cc-overview-ai": "organization" }}
              />
            )
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
