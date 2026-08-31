"use client";

/**
 * Settings — Overview.
 *
 * The landing pane, and now the ONLY personal-account destination: Profile &
 * preferences was a second page that restated the workspace, the plan, the
 * sign-in method and the two-factor state this pane already summarised, then
 * added a language control and a timezone control. Two destinations, one
 * subject. The identity and its preferences live here, beside the summaries
 * they belong to, and `#profile` resolves here.
 *
 * The navigation cards that used to fill the lower half — Account / Workspace /
 * System grids whose only job was to open a pane the rail already lists — are
 * gone. One local navigation authority, and the Overview is an overview.
 *
 * Nothing here fetches or decides. Every figure comes from a canonical source
 * the shell already loaded, and a value that has not loaded, or that this
 * deployment does not project, is omitted rather than guessed at.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  Building2,
  Clock,
  CreditCard,
  ShieldCheck,
} from "lucide-react";

import { useAuth } from "../../../providers";
import { describeUserAgent } from "../../../../lib/security/sessionPresentation";

import type { SettingsUiContext } from "../../../../lib/settings/settingsUiContext";
import type { AccountSecuritySummary } from "../../../../lib/security/useAccountSecuritySummary";
import type {
  SettingsNavModel,
  SettingsPaneId,
} from "../../../../lib/settings/settingsNavigation";
import { OverviewSection } from "./OverviewSection";
import { PreferencesSection } from "./PreferencesSection";

export type OverviewFact = { label: string; value: ReactNode };

function SummaryCard({
  icon,
  title,
  headline,
  facts,
  children,
  action,
  testId,
}: {
  icon: ReactNode;
  title: string;
  headline?: ReactNode;
  facts?: OverviewFact[];
  children?: ReactNode;
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

      {facts && facts.length > 0 ? (
        <dl className="set-facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children}

      {action ? <div className="set-card__action">{action}</div> : null}
    </section>
  );
}

/**
 * A country code as a readable place, using the browser's own data. Falls back
 * to the code itself rather than to an invented country name.
 */
function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    const display = new Intl.DisplayNames(undefined, { type: "region" });
    return display.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
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
  roleLabel: string | null;
  workspaceStatus: string | null;
}) {
  const can = (pane: SettingsPaneId) => model.allowed.has(pane);
  const workspaceFacts: OverviewFact[] = [];
  if (roleLabel) workspaceFacts.push({ label: "Role", value: roleLabel });
  workspaceFacts.push({
    label: "Type",
    value: ui.isPersonalWorkspace ? "Personal space" : "Organization",
  });

  const planFacts: OverviewFact[] = [
    { label: "Scope", value: ui.billing.scopeLabel },
  ];
  if (ui.billing.managedByOrgName) {
    planFacts.push({ label: "Managed by", value: ui.billing.managedByOrgName });
  }

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

  const billingHref = ui.billing.billingHref;

  // The SAVED account timezone — the same `User.timezone` Preferences edits
  // below. Never the browser's: this card reports what digests and quiet
  // hours will actually use.
  const { user } = useAuth();
  const accountTimezone = user?.timezone?.trim() ? user.timezone.trim() : null;

  return (
    <div className="set-overview" data-settings-pane="overview">
      <header className="set-pane-head">
        <h2>Overview</h2>
        <p>
          Your account, its preferences, and the workspace you are working in.
        </p>
      </header>

      {/* IDENTITY — the account, stated properly.
          Profile & preferences is no longer a destination, so this pane owns
          the person: the canonical `OverviewSection` still supplies the
          avatar, the name, the email and the display-name form with its save
          and cancel semantics, WITHOUT its account-facts table (the summary
          cards below state those). The context chips beside it answer "as whom,
          and where" without repeating the cards' own figures. */}
      <section className="set-hero" data-settings-identity>
        <div className="set-hero__identity">
          <OverviewSection ui={ui} security={security} showFacts={false} />
        </div>

        <ul className="set-hero__context" aria-label="Account context">
          {roleLabel ? (
            <li>
              <span>Role</span>
              <strong>{roleLabel}</strong>
            </li>
          ) : null}
          {/* CONTEXT AUTHORITY (2026-09-03) — the labels name the CONTEXT.
              In an organization, `activeWorkspaceName` IS the organization,
              and calling it "Workspace" left an Enterprise administrator
              unable to tell which of the two they were looking at. "Plan" had
              the same problem: an agreement is not a plan, and
              `deriveSettingsUiContext` already computes the word for it
              (`scopeLabel` — "Organization agreement" / "Organization plan" /
              "Personal plan") and was the only thing here not using it. No new
              field, no second commercial calculation. */}
          <li>
            <span>
              {ui.billing.contextType === "personal"
                ? "Workspace"
                : "Organization"}
            </span>
            <strong>{ui.activeWorkspaceName}</strong>
          </li>
          <li>
            <span>{ui.billing.scopeLabel}</span>
            <strong>{ui.billing.displayPlan}</strong>
          </li>
        </ul>
      </section>

      {/* ----------------------------------------------------------------
          SUMMARIES
      ---------------------------------------------------------------- */}
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
            /* No action where there is nothing to open: a personal space has
               no workspace settings destination, and a button that opens
               nothing is worse than no button. */
            can("members") ? (
              <button
                type="button"
                className="set-action set-action--ink"
                onClick={() => onOpen("members")}
                data-settings-open="members"
              >
                Manage members
              </button>
            ) : can("workspace") ? (
              <button
                type="button"
                className="set-action set-action--ink"
                onClick={() => onOpen("workspace")}
                data-settings-open="workspace"
              >
                Open workspace settings
              </button>
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
              <Link
                className="set-action set-action--ink"
                href={billingHref}
                data-settings-billing-link
              >
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
            <button
              type="button"
              className="app-secondary-action app-secondary-action--lg"
              onClick={() => onOpen("security")}
              data-settings-open="security"
            >
              Review security
            </button>
          }
        />

        {/* TIMEZONE — a READOUT. The editing surface stays in Preferences
            below; this card states what the account is currently set to, in
            the same words that section uses when it is unset. */}
        <SummaryCard
          testId="timezone"
          icon={<Clock size={16} strokeWidth={2} />}
          title="Timezone"
          headline={accountTimezone ?? "UTC"}
          facts={[
            {
              label: "Source",
              value: accountTimezone
                ? "Account timezone"
                : "Not set — UTC fallback",
            },
          ]}
        />
      </div>

      {/* ----------------------------------------------------------------
          RECENT SIGN-INS — a ROW, not a fourth column.

          It carried the raw `User-Agent` as its headline, which is 120
          characters of syntax; in a 221px column that wrapped into a card
          twice the height of its neighbours and made the whole summary row
          look accidental. The device name now comes from
          `describeUserAgent`, the parser the Security pane already uses for
          exactly this string — no second parser, and it never returns the raw
          value. The full agent stays available as the row's title attribute
          for anyone who needs it.
      ---------------------------------------------------------------- */}
      <section
        className="set-card set-card--wide"
        data-settings-summary="activity"
      >
        <div className="set-card__head">
          <span className="set-card__icon" aria-hidden="true">
            <Activity size={16} strokeWidth={2} />
          </span>
          <h3 className="set-card__title">Recent sign-ins</h3>
        </div>
        {security.recentSignIns.length > 0 ? (
          <ul className="set-signins set-signins--row" data-settings-recent-signins>
            {security.recentSignIns.map((entry) => {
              const place = countryName(entry.countryCode);
              return (
                <li key={entry.id} title={entry.device ?? undefined}>
                  <span className="set-signins__device">
                    {describeUserAgent(entry.device)}
                    {entry.isCurrent ? (
                      <span className="set-state" data-tone="ok">
                        This device
                      </span>
                    ) : null}
                  </span>
                  <span className="set-signins__when">
                    {new Date(entry.lastSeenAtUtc).toLocaleString()}
                    {place ? ` · ${place}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="set-muted set-signins__empty">
            No recent sign-in activity available.
          </p>
        )}
      </section>

      {/* ----------------------------------------------------------------
          PREFERENCES. The language and timezone controls that were the only
          unique content on the retired Profile page, on the pane that now
          owns the account.
      ---------------------------------------------------------------- */}
      <section className="set-section" data-settings-preferences>
        <h3 className="set-section__title">Preferences</h3>
        <PreferencesSection />
      </section>
    </div>
  );
}

export default SettingsOverview;
