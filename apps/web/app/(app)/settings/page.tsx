"use client";

/**
 * Settings — a shell with a map, not a scroll.
 *
 * WHAT THIS REPLACED (IA redesign 2026-09-03)
 * ---------------------------------------------------------------------------
 * The 2026-07-17 refactor merged the former child routes into ONE scrollable
 * console: overview, security, preferences, notifications, AI, privacy,
 * billing and seven role x capability matrices, all mounted and all expanded,
 * every time anyone opened Settings. It solved a routing problem and created a
 * reading one — a person arriving to change their timezone met the entire
 * administration surface of the product, and the densest thing in it (the
 * permission matrices) rendered below the fold of every visit.
 *
 * This keeps the single canonical route and replaces the scroll with panes.
 * One destination renders at a time, chosen from a map that is resolved once,
 * from the envelope, by `resolveSettingsNavigation`.
 *
 * WHAT DID NOT CHANGE
 * ---------------------------------------------------------------------------
 * Every section component is the one that was already here, unchanged in what
 * it does: `PersonalSecuritySections`, `PreferencesSection`,
 * `NotificationsSection`, `AiSection`, `PrivacySection`, `BillingSection`,
 * `OverviewSection`, `RolesSection`. No API changed, no permission changed, no
 * authority moved. Settings summarises and hands off; the Security Center,
 * Billing, Audit, Retention and Integrations remain the surfaces that own
 * their domains.
 *
 * WHY PANES AND NOT SEVEN ROUTES
 * ---------------------------------------------------------------------------
 * `/settings` is the canonical route and other surfaces deep-link into its
 * anchors. Panes keep that contract — `/settings#security` still lands on
 * Security — and give the thing the scroll could not: only the selected
 * destination mounts, so opening Settings no longer fetches the RBAC catalog,
 * the AI policy and the privacy record together.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader } from "../../../components/ui/PageShell";
import { useAuth } from "../../providers";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { deriveSettingsUiContext } from "../../../lib/settings/settingsUiContext";
import { useAccountSecuritySummary } from "../../../lib/security/useAccountSecuritySummary";
import { useEnterpriseSurfaceAccess } from "../../../lib/platform-context";
import {
  resolvePaneFromHash,
  resolveSettingsNavigation,
  type SettingsPaneId,
} from "../../../lib/settings/settingsNavigation";
import { PersonalSecuritySections } from "../security-center/components/PersonalSecuritySections";
import { NotificationsSection } from "./_sections/NotificationsSection";
import { AiSection } from "./_sections/AiSection";
import { PrivacySection } from "./_sections/PrivacySection";
import { BillingSection } from "./_sections/BillingSection";
import { RolesSection } from "./_sections/RolesSection";
import { SettingsNav } from "./_sections/SettingsNav";
import { SettingsOverview } from "./_sections/SettingsOverview";

export default function SettingsPage() {
  return (
    <div data-testid="account-settings-page">
      <PageRouteGate routeId="account.settings">
        <SettingsWorkspace />
      </PageRouteGate>
    </div>
  );
}

/** A pane's heading and one line of orientation. */
const PANE_COPY: Record<
  SettingsPaneId,
  { title: string; description: string }
> = {
  overview: {
    title: "Overview",
    description: "A summary of your account and workspace.",
  },
  security: {
    title: "Security",
    description:
      "Sign-in methods, two-factor authentication, active sessions and recent security activity.",
  },
  notifications: {
    title: "Notifications",
    description:
      "Which updates reach you in-app and by email, plus quiet hours and digest cadence.",
  },
  privacy: {
    title: "Privacy & data",
    description:
      "Manage consent, policy records, data export, and account lifecycle.",
  },
  workspace: {
    title: "General",
    description: "Workspace settings and defaults for everyone working here.",
  },
  members: {
    title: "Members",
    description: "Who belongs to this workspace, and how they are invited.",
  },
  roles: {
    title: "Roles & permissions",
    description: "Understand workspace roles and what each role can do.",
  },
  retention: {
    title: "Retention & lifecycle",
    description: "How long records are kept, and how they are archived.",
  },
  integrations: {
    title: "API & integrations",
    description: "API access, keys and connected services.",
  },
  sso: {
    title: "SCIM & SSO",
    description: "Single sign-on and directory provisioning for this workspace.",
  },
  audit: {
    title: "Audit log",
    description: "A record of what happened in this workspace.",
  },
  billing: {
    title: "Billing & plan",
    description: "Your plan, seats and storage. Payment is managed on Billing.",
  },
};

function SettingsWorkspace() {
  const { user } = useAuth();
  const { envelope } = usePlatformContext();
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

  // The map. Resolved from the envelope by the one resolver that owns it; the
  // shell never asks a second question about who may see what.
  const model = useMemo(
    () =>
      resolveSettingsNavigation({
        activeSpace:
          envelope?.activeSpace && envelope.activeSpace.id
            ? {
                type: envelope.activeSpace.type,
                id: envelope.activeSpace.id,
                displayName: envelope.activeSpace.displayName,
              }
            : null,
        isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
        capabilities: envelope?.capabilities ?? null,
        accountPlan: envelope?.account?.accountPlan ?? null,
        personalSpace: envelope?.personalSpace
          ? { id: envelope.personalSpace.id ?? null }
          : null,
        orgAdminOrgId: ui.orgAdminOrgId,
        isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
      }),
    [envelope, ui.orgAdminOrgId],
  );

  const [pane, setPane] = useState<SettingsPaneId>("overview");

  // Deep links, including the pre-redesign anchors other surfaces still use.
  useEffect(() => {
    setPane(resolvePaneFromHash(window.location.hash, model));
    // `model` is the dependency that matters: the hash can name a pane that
    // only becomes allowed once the envelope has loaded.
  }, [model]);

  const openPane = useCallback((next: SettingsPaneId) => {
    setPane(next);
    window.history.replaceState(null, "", `#${next}`);
    // A pane change is a navigation: start it at the top, and announce it.
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const copy = PANE_COPY[pane];
  const paneHref = useMemo(() => {
    for (const group of model.groups) {
      const item = group.items.find((i) => i.id === pane);
      if (item) return item.href;
    }
    return null;
  }, [model, pane]);

  return (
    <PageShell
      className="settings-page-shell"
      header={
        <PageHeader
          title="Settings"
          subtitle="Manage your personal preferences, workspace settings, security, and integrations."
        />
      }
    >
      <div className="set-shell" data-settings-shell>
        <SettingsNav model={model} active={pane} onSelect={openPane} />

        <main className="set-main" aria-live="polite">
          {pane === "overview" ? (
            <SettingsOverview
              ui={ui}
              security={security}
              model={model}
              onOpen={openPane}
              roleLabel={envelope?.workspace?.membership?.role ?? null}
              workspaceStatus={
                envelope?.activeSpace?.type === "ORGANIZATION" ? "Active" : null
              }
            />
          ) : (
            <>
              <header className="set-pane-head">
                <h2>{copy.title}</h2>
                <p>{copy.description}</p>
              </header>

              {pane === "security" ? (
                <div className="set-stack">
                  <PersonalSecuritySections />
                  {canSeeWorkspaceSecurity ? (
                    <p className="set-note" data-cc-security-link-card>
                      Workspace identity operations — MFA policy, trusted
                      devices, session revocations and recovery approvals — are
                      managed in{" "}
                      <Link href="/security-center">Identity &amp; Security</Link>.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {pane === "notifications" ? <NotificationsSection /> : null}

              {pane === "privacy" ? <PrivacySection /> : null}

              {pane === "workspace" ? (
                <div className="set-stack">
                  <AiSection />
                </div>
              ) : null}

              {pane === "roles" ? <RolesSection /> : null}

              {pane === "billing" ? <BillingSection ui={ui} /> : null}

              {/* Panes whose whole job is to hand off to the surface that owns
                  the domain. Settings states what it knows and links; it does
                  not re-implement Members, Retention, Integrations, SSO or the
                  Audit log. */}
              {paneHref &&
              (pane === "members" ||
                pane === "retention" ||
                pane === "integrations" ||
                pane === "sso" ||
                pane === "audit") ? (
                <section className="set-card" data-settings-handoff={pane}>
                  <p className="set-card__headline">
                    {HANDOFF_COPY[pane]}
                  </p>
                  <div className="set-card__action">
                    <Link className="set-action set-action--primary" href={paneHref}>
                      {HANDOFF_ACTION[pane]}
                    </Link>
                  </div>
                </section>
              ) : null}
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
}

/**
 * One sentence per hand-off: what the destination owns, so the link is a
 * decision rather than a jump. Written in the reader's terms — no route ids,
 * no service names, no phase labels.
 */
const HANDOFF_COPY: Partial<Record<SettingsPaneId, string>> = {
  members:
    "Invitations, roles and removals are managed in organization administration, where membership changes are recorded.",
  retention:
    "Retention schedules, archival and legal holds are governed centrally, so a policy applies the same way to every record it covers.",
  integrations:
    "API keys, webhook endpoints and connected services are managed together. Keys are shown once when created and never again.",
  sso: "Single sign-on and directory provisioning are configured in the identity console, alongside certificate rotation and connection health.",
  audit: "The full record of workspace activity, with filters, lives in the Audit & Transparency Center.",
};

const HANDOFF_ACTION: Partial<Record<SettingsPaneId, string>> = {
  members: "Manage members",
  retention: "Manage policies",
  integrations: "Manage integrations",
  sso: "Manage SSO",
  audit: "View audit log",
};
