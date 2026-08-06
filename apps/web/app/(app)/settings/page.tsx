"use client";

/**
 * Settings — SINGLE unified enterprise settings workspace
 * (IA refactor 2026-07-17).
 *
 * The former child pages (/settings/profile, /security, /preferences,
 * /privacy, /notifications, /ai) are merged into ONE scrollable
 * administration console. Every section reuses its existing, unchanged
 * implementation (extracted into `_sections/*` or already-shared
 * components); permissions, APIs, and backend behavior are untouched —
 * this is navigation + composition only.
 *
 *   Overview      — identity + profile editing + account facts
 *   Security      — login methods · MFA · sessions · activity
 *                   (`PersonalSecuritySections`, unchanged)
 *   Preferences   — language · account timezone
 *   Notifications — matrix · quiet hours · digest cadence
 *   AI            — assistance / governance via the canonical
 *                   `deriveAiSettingsMode` views (plan/role-correct)
 *   Privacy       — cookies · policy history · data export · close account
 *   Billing       — read-only summary + [Open Billing]
 *
 * Internal navigation is anchor-based with a scrollspy sidebar; the old
 * child routes 301-redirect to `/settings#<section>` (next.config.js).
 * Free / PAYG / Pro / Team / Enterprise all share this layout — only the
 * visible controls differ, resolved by the same context resolvers as
 * before (organization policies still override personal settings where
 * they always did, inside the unchanged section components).
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { PageShell, PageHeader } from "../../../components/ui/PageShell";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { useAuth } from "../../providers";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { deriveSettingsUiContext } from "../../../lib/settings/settingsUiContext";
import { useAccountSecuritySummary } from "../../../lib/security/useAccountSecuritySummary";
import { useEnterpriseSurfaceAccess } from "../../../lib/platform-context";
import { PersonalSecuritySections } from "../security-center/components/PersonalSecuritySections";
import {
  SETTINGS_SECTIONS,
  SettingsSection,
  type SettingsSectionId,
} from "./_sections/SettingsSection";
import { OverviewSection } from "./_sections/OverviewSection";
import { PreferencesSection } from "./_sections/PreferencesSection";
import { NotificationsSection } from "./_sections/NotificationsSection";
import { AiSection } from "./_sections/AiSection";
import { PrivacySection } from "./_sections/PrivacySection";
import { BillingSection } from "./_sections/BillingSection";
import { RolesSection } from "./_sections/RolesSection";

// Phase 38.9 — canonical PageRouteGate. `account.settings` is an
// ACCOUNT-domain route (NONE active-space) so it loads for every
// authenticated user. The `data-testid` marker is a stable Playwright
// mount anchor (Phase G5).
export default function SettingsPage() {
  return (
    <div data-testid="account-settings-page">
      <PageRouteGate routeId="account.settings">
        <SettingsWorkspace />
      </PageRouteGate>
    </div>
  );
}

/** Quick actions — SHORTCUTS ONLY: each scrolls to its section. */
const QUICK_ACTIONS: ReadonlyArray<{ label: string; target: SettingsSectionId }> = [
  { label: "Edit profile", target: "overview" },
  { label: "Manage login methods", target: "security" },
  { label: "Configure MFA", target: "security" },
  { label: "Export data", target: "privacy" },
  { label: "Open Billing", target: "billing" },
];

function scrollToSection(id: SettingsSectionId) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // Keep the URL shareable without triggering a navigation.
  window.history.replaceState(null, "", `#${id}`);
}

function SettingsWorkspace() {
  const { user } = useAuth();
  const { envelope } = usePlatformContext();
  // Track 1A (surface-tier removal) — the workspace Identity & Security
  // operator console belongs to the Enterprise workspace experience;
  // gate on the SERVER-projected enterprise/admin booleans only.
  const canSeeWorkspaceSecurity = useEnterpriseSurfaceAccess();

  const ui = deriveSettingsUiContext({
    activeSpace: envelope?.activeSpace
      ? {
          type: envelope.activeSpace.type,
          id: envelope.activeSpace.id,
          displayName: envelope.activeSpace.displayName,
        }
      : null,
    workspacePlan: envelope?.personalSpace?.plan ?? null,
    accountPlan: envelope?.account?.accountPlan ?? null,
    // PHASE 12 POINT 4 STEP 1 — SERVER capability projections for the ACTIVE
    // workspace. `null` while the envelope is loading/degraded so the
    // resolver fails closed instead of guessing from a role name.
    canManageBilling:
      typeof envelope?.capabilities?.BILLING_MANAGE === "boolean"
        ? envelope.capabilities.BILLING_MANAGE
        : null,
    canManageWorkspaceSettings:
      typeof envelope?.capabilities?.SETTINGS_MANAGE === "boolean"
        ? envelope.capabilities.SETTINGS_MANAGE
        : null,
    isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
    organizations: envelope?.organizations ?? [],
    planFeatures: envelope?.planFeatures ?? null,
  });

  const security = useAccountSecuritySummary(Boolean(user?.id));

  // ---------------------------------------------------------------------
  // Scrollspy — highlight the section currently in view. The observer
  // tracks headings against a band near the top of the viewport.
  // ---------------------------------------------------------------------
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("overview");
  const visibleRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const sections = SETTINGS_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleRef.current.set(e.target.id, e.boundingClientRect.top);
          else visibleRef.current.delete(e.target.id);
        }
        // Active = the visible section closest to the top of the band.
        let best: { id: string; top: number } | null = null;
        for (const [id, top] of visibleRef.current) {
          if (!best || top < best.top) best = { id, top };
        }
        if (best) setActiveSection(best.id as SettingsSectionId);
      },
      { rootMargin: "-80px 0px -55% 0px", threshold: 0 },
    );
    for (const el of sections) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Deep links: /settings#security (incl. redirects from the removed
  // child routes) scroll to their section after mount.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (SETTINGS_SECTIONS.some((s) => s.id === hash)) {
      // Sections render immediately; defer one frame so layout settles.
      requestAnimationFrame(() =>
        document.getElementById(hash)?.scrollIntoView({ block: "start" }),
      );
    }
  }, []);

  return (
    <PageShell
      className="settings-page-shell"
      header={
        <PageHeader
          eyebrow="Account"
          title="Settings"
          subtitle="Your account, security, preferences, notifications, AI, privacy, and billing — one workspace."
          contextStrip={
            <>
              <Badge tone="info">Account</Badge>
              <Badge tone="neutral">{ui.activeWorkspaceName}</Badge>
            </>
          }
          primaryAction={
            <div
              style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}
              data-cc-settings-quick-actions
              aria-label="Quick actions"
            >
              {QUICK_ACTIONS.map((a) => (
                <Button
                  key={a.label}
                  variant="ghost"
                  size="sm"
                  onClick={() => scrollToSection(a.target)}
                  data-cc-quick-action={a.target}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          }
        />
      }
    >
      <div
        style={{ maxWidth: 1120 }}
        className="settings-workspace grid grid-cols-1 gap-6 md:grid-cols-[180px_minmax(0,1fr)]"
      >
        {/* Internal navigation — sticky on desktop, scrollspy-highlighted. */}
        <nav
          aria-label="Settings sections"
          data-cc-settings-nav
          className="max-md:overflow-x-auto"
          style={{ minWidth: 0 }}
        >
          <ul
            className="max-md:flex max-md:gap-2 md:sticky md:top-20 md:grid md:gap-1"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection(s.id);
                  }}
                  aria-current={activeSection === s.id ? "true" : undefined}
                  data-cc-settings-nav-item={s.id}
                  data-active={activeSection === s.id ? "true" : "false"}
                  style={{
                    display: "block",
                    padding: "6px 10px",
                    borderRadius: 8,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    textDecoration: "none",
                    fontWeight: activeSection === s.id ? 700 : 500,
                    color:
                      activeSection === s.id
                        ? "var(--ink-primary, #0f172a)"
                        : "var(--ink-secondary, #475569)",
                    background:
                      activeSection === s.id
                        ? "rgba(79,70,229,0.08)"
                        : "transparent",
                  }}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div style={{ minWidth: 0 }}>
          <SettingsSection
            id="overview"
            title="Account overview"
            description="Your identity and the account facts at a glance."
          >
            <OverviewSection ui={ui} security={security} />
          </SettingsSection>

          <SettingsSection
            id="security"
            title="Security"
            description="Login methods, two-factor authentication, active sessions, and your recent security activity."
          >
            <PersonalSecuritySections />
            {canSeeWorkspaceSecurity ? (
              <p
                className="m-0 mt-2 text-[13px]"
                style={{ color: "var(--ink-secondary, #475569)" }}
                data-cc-security-link-card
              >
                Workspace identity operations (MFA policy, trusted devices,
                session revocations, recovery approvals) live in{" "}
                <Link href="/security-center"
                  style={{
                    color: "var(--ink-primary, #0f172a)",
                    fontWeight: 600,
                    textDecoration: "underline",
                  }}
                >
                  Identity &amp; Security
                </Link>
                .
              </p>
            ) : null}
          </SettingsSection>

          <SettingsSection
            id="preferences"
            title="Preferences"
            description="UI language and your account timezone — the default for digests, quiet hours, and local-time displays."
          >
            <PreferencesSection />
          </SettingsSection>

          <SettingsSection
            id="notifications"
            title="Notifications"
            description="Which operational categories reach you in-app and by email for the current workspace, plus quiet hours and digest cadence."
          >
            <NotificationsSection />
          </SettingsSection>

          <SettingsSection
            id="ai"
            title="AI"
            description="AI-assisted features for this workspace. Advisory only — AI never determines truth, authenticity, or admissibility."
          >
            <AiSection />
          </SettingsSection>

          <SettingsSection
            id="privacy"
            title="Privacy & legal records"
            description="Cookie preferences, policy acceptance history, your personal data export, and account closure."
          >
            <PrivacySection />
          </SettingsSection>

          <SettingsSection
            id="billing"
            title="Billing summary"
            description="The billing reality for your active context. Manage plans, payments, and add-ons on the Billing page."
          >
            <BillingSection ui={ui} />
          </SettingsSection>

          {/* PHASE 12 VERTICAL A (2026-07-30) — role/capability reference
              rendered from the API's OWN catalog, never a bundled copy. */}
          <SettingsSection
            id="roles"
            title="Roles & permissions"
            description="What each role can do in this workspace, answered by the API itself. Read-only — roles are changed by a workspace administrator."
          >
            <RolesSection />
          </SettingsSection>

          {/* Related administration — contextual LINKS only, gated exactly
              as before; controls stay in their canonical surfaces. */}
          {(ui.showOrgAdminLinks && ui.orgAdminOrgId) || ui.showReviewerCriteria ? (
            <section
              aria-label="Related administration"
              data-cc-settings-related-admin
              style={{
                borderTop: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                padding: "18px 0 8px",
                fontSize: 13,
                color: "var(--ink-secondary, #475569)",
                display: "grid",
                gap: 6,
              }}
            >
              {ui.showOrgAdminLinks && ui.orgAdminOrgId ? (
                <div data-cc-overview-org-admin>
                  Organization administration —{" "}
                  <Link
                    href={`/organizations/${ui.orgAdminOrgId}/admin`}
                    style={{
                      color: "var(--ink-primary, #0f172a)",
                      fontWeight: 600,
                      textDecoration: "underline",
                    }}
                  >
                    open organization admin
                  </Link>
                </div>
              ) : null}
              {ui.showReviewerCriteria ? (
                <div>
                  Reviewer criteria —{" "}
                  <Link
                    href="/settings/reviewer-criteria"
                    style={{
                      color: "var(--ink-primary, #0f172a)",
                      fontWeight: 600,
                      textDecoration: "underline",
                    }}
                  >
                    open reviewer criteria
                  </Link>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
