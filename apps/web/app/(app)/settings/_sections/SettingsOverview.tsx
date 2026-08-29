"use client";

/**
 * Settings — Overview.
 *
 * The landing pane, and deliberately a SUMMARY. Settings used to open on every
 * domain at once: the profile form, the whole security console, notifications,
 * AI governance, privacy, billing, and seven role×capability matrices, all
 * expanded, in one scroll. A reader arriving to change their timezone met the
 * entire administration surface of the product.
 *
 * This answers three questions per card — what is this, what is its current
 * state, what can I do — and hands off. Every figure is read from a canonical
 * source already loaded by the shell:
 *
 *   workspace   the platform-context envelope
 *   plan        `deriveSettingsUiContext`, which owns the billing reality
 *   security    `useAccountSecuritySummary`, the account security read
 *   activity    the same summary's `lastLoginAtUtc`
 *
 * Nothing here fetches. Nothing here decides. A value that has not loaded — or
 * that this deployment does not project — is omitted rather than guessed at,
 * because a fabricated seat count on a settings page is worse than an absent
 * one.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  Building2,
  CreditCard,
  ShieldCheck,
} from "lucide-react";

import type { SettingsUiContext } from "../../../../lib/settings/settingsUiContext";
import type { AccountSecuritySummary } from "../../../../lib/security/useAccountSecuritySummary";
import type { SettingsNavModel, SettingsPaneId } from "../../../../lib/settings/settingsNavigation";

export type OverviewFact = { label: string; value: ReactNode };

function SummaryCard({
  icon,
  title,
  headline,
  facts,
  action,
  testId,
}: {
  icon: ReactNode;
  title: string;
  headline?: ReactNode;
  facts: OverviewFact[];
  action?: ReactNode;
  testId: string;
}) {
  return (
    <section className="set-card" data-settings-summary={testId}>
      <header className="set-card__head">
        <span className="set-card__icon" aria-hidden="true">
          {icon}
        </span>
        <h3>{title}</h3>
      </header>

      {headline ? <p className="set-card__headline">{headline}</p> : null}

      <dl className="set-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {action ? <div className="set-card__action">{action}</div> : null}
    </section>
  );
}

/** A destination inside the Settings shell. */
function PaneLink({
  pane,
  onOpen,
  children,
}: {
  pane: SettingsPaneId;
  onOpen: (pane: SettingsPaneId) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="set-action"
      onClick={() => onOpen(pane)}
      data-settings-open={pane}
    >
      {children}
    </button>
  );
}

export function SettingsOverview({
  ui,
  security,
  model,
  onOpen,
  roleLabel,
  workspaceStatus,
}: {
  ui: SettingsUiContext;
  security: AccountSecuritySummary;
  model: SettingsNavModel;
  onOpen: (pane: SettingsPaneId) => void;
  /** SERVER-projected membership role; null when there is none to state. */
  roleLabel: string | null;
  /** SERVER-projected workspace status; null when not projected. */
  workspaceStatus: string | null;
}) {
  const can = (pane: SettingsPaneId) => model.allowed.has(pane);
  const hrefFor = (pane: SettingsPaneId): string | null => {
    for (const group of model.groups) {
      const item = group.items.find((i) => i.id === pane);
      if (item) return item.href;
    }
    return null;
  };

  // ---------------------------------------------------------------------
  // WORKSPACE — what workspace am I in, and as what?
  // ---------------------------------------------------------------------
  const workspaceFacts: OverviewFact[] = [];
  if (roleLabel) workspaceFacts.push({ label: "Role", value: roleLabel });
  workspaceFacts.push({
    label: "Type",
    value: ui.isPersonalWorkspace ? "Personal space" : "Organization",
  });

  // ---------------------------------------------------------------------
  // PLAN — the commercial reality of the ACTIVE context, from the one
  // resolver that owns it. Storage and renewal live on Billing and are not
  // restated here from a second source.
  // ---------------------------------------------------------------------
  const planFacts: OverviewFact[] = [
    { label: "Scope", value: ui.billing.scopeLabel },
  ];
  if (ui.billing.managedByOrgName) {
    planFacts.push({ label: "Managed by", value: ui.billing.managedByOrgName });
  }

  // ---------------------------------------------------------------------
  // SECURITY — account security state, summarised. The Security Center owns
  // the controls; this is the entry point, not a second security product.
  // ---------------------------------------------------------------------
  const securityFacts: OverviewFact[] = [
    {
      label: "Two-factor",
      value:
        security.mfaConfigured === null ? (
          <span className="set-muted">Checking…</span>
        ) : security.mfaConfigured ? (
          <span className="set-state" data-tone="ok">
            Configured
          </span>
        ) : (
          <span className="set-state" data-tone="attention">
            Not configured
          </span>
        ),
    },
  ];
  if (security.loginMethods) {
    securityFacts.push({ label: "Sign-in", value: security.loginMethods });
  }
  if (typeof security.activeSessions === "number") {
    securityFacts.push({
      label: "Active sessions",
      value: `${security.activeSessions}`,
    });
  }

  // ---------------------------------------------------------------------
  // ACTIVITY — one fact the account read already carries. No new telemetry,
  // and no IP or location: this deployment does not project them here, and
  // inventing them would be inventing a security signal.
  // ---------------------------------------------------------------------
  const activityFacts: OverviewFact[] = [
    {
      label: "Last sign-in",
      value: security.lastLoginAtUtc ? (
        new Date(security.lastLoginAtUtc).toLocaleString()
      ) : (
        <span className="set-muted">Not available</span>
      ),
    },
  ];

  const auditHref = hrefFor("audit");
  const billingHref = ui.billing.billingHref;

  return (
    <div className="set-overview" data-settings-pane="overview">
      <header className="set-pane-head">
        <h2>Overview</h2>
        <p>A summary of your account and workspace.</p>
      </header>

      <div className="set-grid set-grid--summary">
        <SummaryCard
          testId="workspace"
          icon={<Building2 size={16} strokeWidth={2} />}
          title="Workspace"
          headline={
            <>
              {ui.activeWorkspaceName}
              {workspaceStatus ? (
                <span className="set-state" data-tone="ok">
                  {workspaceStatus}
                </span>
              ) : null}
            </>
          }
          facts={workspaceFacts}
          action={
            can("members") ? (
              <PaneLink pane="members" onOpen={onOpen}>
                Manage members
              </PaneLink>
            ) : can("workspace") ? (
              <PaneLink pane="workspace" onOpen={onOpen}>
                Open workspace settings
              </PaneLink>
            ) : null
          }
        />

        <SummaryCard
          testId="plan"
          icon={<CreditCard size={16} strokeWidth={2} />}
          title="Plan"
          headline={ui.billing.displayPlan}
          facts={planFacts}
          action={
            billingHref ? (
              <Link className="set-action" href={billingHref} data-settings-billing-link>
                View billing
              </Link>
            ) : null
          }
        />

        <SummaryCard
          testId="security"
          icon={<ShieldCheck size={16} strokeWidth={2} />}
          title="Security"
          facts={securityFacts}
          action={
            <PaneLink pane="security" onOpen={onOpen}>
              Review security
            </PaneLink>
          }
        />

        <SummaryCard
          testId="activity"
          icon={<Activity size={16} strokeWidth={2} />}
          title="Activity"
          facts={activityFacts}
          action={
            auditHref ? (
              <Link className="set-action" href={auditHref} data-settings-audit-link>
                View audit log
              </Link>
            ) : null
          }
        />
      </div>

      {/* The rest of the shell, as a map rather than as its contents. Each
          group here mirrors the navigation exactly, so the page and the nav
          can never offer different sets of destinations. */}
      {model.groups.map((group) => (
        <section key={group.id} className="set-section" data-settings-group={group.id}>
          <h3 className="set-section__title">{group.label}</h3>
          <div className="set-grid set-grid--links">
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="set-link-card"
                onClick={() => onOpen(item.id)}
                data-settings-open={item.id}
              >
                <span className="set-link-card__label">{item.label}</span>
                <span className="set-link-card__hint">
                  {DESTINATION_HINT[item.id]}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * One line per destination: what it is, in the reader's terms. Deliberately
 * short — §25. No implementation names, no phase labels, no entity names.
 */
const DESTINATION_HINT: Record<SettingsPaneId, string> = {
  overview: "A summary of your account and workspace.",
  profile: "Your name, contact details, language and timezone.",
  security: "Password, two-factor, sessions and devices.",
  notifications: "Which updates reach you, and how.",
  workspace: "Workspace name, defaults and assistance settings.",
  members: "Invite people and manage who belongs to this workspace.",
  roles: "What each role can do here.",
  "cases-evidence": "Defaults for how cases and evidence are handled.",
  retention: "How long records are kept, and how they are archived.",
  integrations: "API access, keys and connected services.",
  sso: "Single sign-on and directory provisioning.",
  audit: "A record of what happened in this workspace.",
  billing: "Plan, seats, storage and payment.",
};

export default SettingsOverview;
