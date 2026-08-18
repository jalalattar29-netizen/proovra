"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useToast, Skeleton, PageShell, PageHeader, PageSection } from "../../../components/ui";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../lib/api";
import { useBillingSummary } from "../../../lib/api/billing-summary";
import { listTeams } from "../../../lib/api/collaboration-teams";
import { captureException } from "../../../lib/sentry";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { usePlatformContext } from "../../../lib/platform-context";
import { parseBillingWorkspaceLocator } from "../../../lib/navigation/billingWorkspaceLocator";
import { PersonalWorkspaceCard } from "../../../components/billing/PersonalWorkspaceCard";
import { TeamWorkspaceCard } from "../../../components/billing/TeamWorkspaceCard";
import { CheckoutPanel } from "../../../components/billing/CheckoutPanel";
import { StorageAddonsPanel } from "../../../components/billing/StorageAddonsPanel";
// PHASE 12 VERTICAL A (2026-07-30) — payment ledger + entitlement re-sync.
// Owns GET /v1/billing/payments and POST /v1/billing/restore, and reloads
// this page's overview projection after a successful re-sync.
import { PaymentsSection } from "./_sections/PaymentsSection";
import type {
  BillingOverviewResponse,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
  BillingPaymentSummary,
  CheckoutPlan,
  CheckoutTargetType,
  WorkspaceStorageAddonSummary,
} from "../../../components/billing/types";

function readInitialPlan(value: string | null): CheckoutPlan | null {
  if (value === "PAYG" || value === "PRO" || value === "TEAM") return value;
  return null;
}

function normalizePlanLabel(value?: string | null, fallback = "FREE"): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || fallback;
}

// Phase 38.9 — wrap in canonical PageRouteGate. `account.billing` is
// an ACCOUNT-domain route (NONE active-space).
export default function BillingPage() {
  return (
    <PageRouteGate routeId="account.billing">
      <BillingPageInner />
    </PageRouteGate>
  );
}

function BillingPageInner() {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const searchParams = useSearchParams();
  // PHASE 10 CLOSURE FIX 3 (2026-07-23) — client-hiding signal only; the
  // server independently rejects a personal checkout regardless.
  const { envelope } = usePlatformContext();
  const personalSpaceAllowed = envelope?.personalSpaceAllowed !== false;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [personal, setPersonal] = useState<PersonalWorkspaceSummary | null>(null);
  const [teams, setTeams] = useState<TeamWorkspaceSummary[]>([]);
  const [payments, setPayments] = useState<BillingPaymentSummary[]>([]);
  const [storageAddons, setStorageAddons] = useState<WorkspaceStorageAddonSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const [cancelBusyTeamId, setCancelBusyTeamId] = useState<string | null>(null);
  const [cancelBusyAddonId, setCancelBusyAddonId] = useState<string | null>(null);

  // Teams Entitlement Alignment 2026-07-14 — the Teams section reads
  // the canonical billing summary (plan / teamsUsed / teamsMax /
  // membersMax, sourced from COLLABORATION_TEAM_PLAN_LIMITS). The
  // used-count comes from the Collaboration Teams list; a fetch
  // failure keeps the count at 0 rather than blocking the page.
  const [collabTeamsUsed, setCollabTeamsUsed] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    listTeams()
      .then((collabTeams) => {
        if (!cancelled) setCollabTeamsUsed(collabTeams.length);
      })
      .catch(() => {
        // Teams list unavailable (e.g. plan without Teams) — keep 0.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const teamsSummary = useBillingSummary(collabTeamsUsed);

  // PHASE 11 §5 — the ONE billing workspace locator is the single parser of
  // the workspace-naming query param. Both the checkout KIND and the specific
  // workspace id come from `?workspace=` (personal | team | team:<id>); the
  // retired `?team=<uuid>` alias is no longer read.
  const workspaceLocator = useMemo(
    () => parseBillingWorkspaceLocator(searchParams),
    [searchParams],
  );

  const initialTargetType = useMemo<CheckoutTargetType>(() => {
    const fromParam: CheckoutTargetType =
      workspaceLocator.kind === "team" ? "TEAM" : "PERSONAL";
    // PHASE 10 CLOSURE FIX 3 — a Personal deep link (`?workspace=personal`)
    // can never select a disallowed Personal checkout target; fall back to
    // Workspace rather than silently attempting a personal checkout the
    // server would reject anyway.
    if (fromParam === "PERSONAL" && !personalSpaceAllowed) return "TEAM";
    return fromParam;
  }, [workspaceLocator, personalSpaceAllowed]);

  const initialPlan = useMemo(() => {
    if (initialTargetType === "TEAM") return "TEAM" satisfies CheckoutPlan;
    const plan = readInitialPlan(searchParams.get("plan"));
    return plan ?? "PAYG";
  }, [initialTargetType, searchParams]);

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = (await apiFetch("/v1/billing/overview")) as BillingOverviewResponse;

      const nextPersonal = data?.workspaces?.personal ?? null;
      const nextTeams = Array.isArray(data?.workspaces?.teams)
        ? data.workspaces.teams
        : [];
      const nextPayments = Array.isArray(data?.payments) ? data.payments : [];
      const nextStorageAddons = Array.isArray(data?.storageAddons?.all)
        ? data.storageAddons.all
        : Array.isArray(
              (data as BillingOverviewResponse & {
                storageAddons?: WorkspaceStorageAddonSummary[];
              }).storageAddons
            )
          ? (((data as BillingOverviewResponse & {
              storageAddons?: WorkspaceStorageAddonSummary[];
            }).storageAddons) ?? [])
          : [];

      setPersonal(nextPersonal);
      setTeams(nextTeams);
      setPayments(nextPayments);
      setStorageAddons(nextStorageAddons);

      setSelectedTeamId((current) => {
        // §5 — the team id comes ONLY from the canonical locator
        // (`?workspace=team:<id>`), never the retired `?team=<uuid>` alias.
        const queryTeamId =
          workspaceLocator.kind === "team" ? (workspaceLocator.teamId ?? null) : null;

        if (queryTeamId && nextTeams.some((team) => team.id === queryTeamId)) {
          return queryTeamId;
        }

        if (!nextTeams.length) return "";
        if (current && nextTeams.some((team) => team.id === current)) {
          return current;
        }

        return nextTeams[0]?.id ?? "";
      });
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to load billing overview" }).message;
      setError(message);
      captureException(err, { feature: "billing_overview_page" });
    } finally {
      setLoading(false);
    }
    // The locator IS the parsed form of `searchParams` (memoised on it above),
    // so depending on the locator is both honest and exactly as stable.
  }, [workspaceLocator]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleSelectTeamForCheckout = useCallback((teamId: string) => {
    setSelectedTeamId(teamId);
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      window.scrollTo(0, 0);
    }
  }, []);

  const handleCancelSubscription = useCallback(
    async (teamId: string) => {
      const teamName =
        teams.find((team) => team.id === teamId)?.name ?? "this workspace";
      const ok = await confirm({
        title: `Cancel subscription for "${teamName}"?`,
        description:
          "This cancels the dedicated TEAM subscription for this workspace. The workspace stays visible and can be reactivated later, but paid TEAM capability ends at the current period.",
        confirmLabel: "Cancel subscription",
        cancelLabel: "Keep subscription",
        tone: "danger",
        testId: "billing-cancel-subscription",
      });
      if (!ok) return;

      try {
        setCancelBusyTeamId(teamId);
        addToast("Cancelling team subscription...", "info");

        await apiFetch("/v1/billing/subscription/cancel", {
          method: "POST",
          body: JSON.stringify({ teamId }),
        });

        addToast("Team subscription cancelled", "success");
        await loadOverview();
      } catch (err) {
        captureException(err, {
          feature: "billing_cancel_team_subscription",
          teamId,
        });
        const message =
          toSafeUserError(err, { message: "Failed to cancel team subscription" }).message;
        addToast(message, "error");
      } finally {
        setCancelBusyTeamId(null);
      }
    },
    [addToast, loadOverview, confirm, teams]
  );

  const handleCancelStorageAddon = useCallback(
    async (addonId: string) => {
      const ok = await confirm({
        title: "Cancel recurring storage add-on?",
        description:
          "This cancels the legacy recurring storage add-on. Storage already included in your base plan is unaffected; only this recurring add-on stops renewing.",
        confirmLabel: "Cancel add-on",
        cancelLabel: "Keep add-on",
        tone: "danger",
        testId: "billing-cancel-storage-addon",
      });
      if (!ok) return;

      try {
        setCancelBusyAddonId(addonId);
        addToast("Cancelling recurring storage add-on...", "info");

        await apiFetch("/v1/billing/storage-addons/cancel", {
          method: "POST",
          body: JSON.stringify({ addonId }),
        });

        addToast("Storage add-on cancelled", "success");
        await loadOverview();
      } catch (err) {
        captureException(err, {
          feature: "billing_cancel_storage_addon",
          addonId,
        });
        const message =
          toSafeUserError(err, { message: "Failed to cancel storage add-on" }).message;
        addToast(message, "error");
      } finally {
        setCancelBusyAddonId(null);
      }
    },
    [addToast, loadOverview, confirm]
  );

  const allTeams = useMemo(() => teams, [teams]);

  const summaryCards = useMemo(() => {
    const personalPlan = normalizePlanLabel(personal?.plan, "FREE");
    const totalTeams = allTeams.length;
    const totalPayments = payments.length;
    const activeAddons = storageAddons.filter((item) =>
      ["ACTIVE", "PENDING", "PAST_DUE"].includes(String(item.status ?? "").toUpperCase())
    ).length;

    return [
      {
        label: "Personal plan",
        value: personalPlan,
      },
      {
        label: "Workspaces",
        value: String(totalTeams),
      },
      {
        label: "Payments",
        value: String(totalPayments),
      },
      {
        label: "Storage add-ons",
        value: String(activeAddons),
      },
    ];
  }, [personal, allTeams, payments, storageAddons]);

  return (
    <PageShell
      data-billing-page
      header={
        <PageHeader
          title={
            <div
              className="cases-page-heading"
              style={{ display: "flex", alignItems: "center", gap: 12 }}
            >
              <span
                aria-hidden
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  background:
                    "linear-gradient(145deg, rgba(91,79,233,0.10), rgba(73,184,255,0.08))",
                  border: "1px solid rgba(91,79,233,0.16)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.8)",
                }}
              >
                <svg
                  width="21"
                  height="21"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B4FE9"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <path d="M2 10h20" />
                </svg>
              </span>
              <h1 className="cc-title" data-billing-title>
                Billing
              </h1>
            </div>
          }
          subtitle={
            // INLINE element — see the PageHeader `subtitle` contract. A <p>
            // here nested inside PageHeader's own <p>, which is invalid HTML
            // and a React validateDOMNesting hydration error.
            <span className="cc-subtitle" data-billing-subtitle>
              Review storage, members, subscriptions, add-ons, and payment
              history in one place. Workspaces stay visible here even when their
              TEAM subscription is canceled, so you can review and reactivate
              them from the same console.
            </span>
          }
          primaryAction={
            <Link href="/pricing" className="app-header-primary-action" data-billing-view-pricing>
              <span>View pricing</span>
            </Link>
          }
        />
      }
    >
      {loading ? (
        <PageSection>
          <div style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="220px" />
            <Skeleton width="100%" height="220px" />
            <Skeleton width="100%" height="220px" />
          </div>
        </PageSection>
      ) : error ? (
        <PageSection>
          <div
            className="cases-panel"
            role="alert"
            style={{
              padding: "16px 18px",
              fontSize: "0.95rem",
              color: "#991b1b",
            }}
          >
            {error}
          </div>
        </PageSection>
      ) : (
        <>
          <PageSection data-billing-summary>
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              }}
            >
              {summaryCards.map((item) => (
                <div
                  key={item.label}
                  className="cases-inner"
                  style={{ padding: "16px 18px" }}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
                    {item.label}
                  </div>
                  <div className="mt-2 text-[1.05rem] font-semibold text-[#172033]">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </PageSection>

          {/* Teams Entitlement Alignment 2026-07-14 — canonical Teams
              entitlement section. Values mirror
              COLLABORATION_TEAM_PLAN_LIMITS via useBillingSummary:
              FREE/PAYG 0 Teams, PRO 2, TEAM 5, ENTERPRISE Custom.
              Invitations are email-only. */}
          {teamsSummary ? (
            <PageSection data-billing-teams>
              <div className="cases-panel" style={{ padding: "20px 22px" }}>
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
                  Teams
                </div>
                {(() => {
                  const numericTeamsMax =
                    teamsSummary.teamsMax === "unlimited"
                      ? null
                      : teamsSummary.teamsMax;
                  const teamsMaxLabel =
                    numericTeamsMax === null
                      ? "Custom"
                      : String(numericTeamsMax);
                  const membersLabel =
                    teamsSummary.membersMax === "unlimited"
                      ? "Custom"
                      : `up to ${teamsSummary.membersMax}`;
                  const grandfathered =
                    numericTeamsMax !== null &&
                    teamsSummary.teamsUsed > numericTeamsMax;
                  const teamsIncluded =
                    numericTeamsMax === null || numericTeamsMax > 0;

                  if (grandfathered) {
                    return (
                      <div
                        className="mt-2 text-[0.92rem] leading-[1.7] text-[#475569]"
                        data-billing-teams-grandfathered
                      >
                        <div className="text-[1.05rem] font-semibold text-[#172033]">
                          {teamsSummary.teamsUsed} Teams ·{" "}
                          {numericTeamsMax} included in your plan
                        </div>
                        <p className="mt-1">
                          Plan-restricted — existing Teams stay
                          accessible; upgrading restores invitations and
                          member management.
                        </p>
                        <Link
                          href="/pricing#plan-pro"
                          className="app-header-primary-action mt-3 inline-flex"
                          data-billing-teams-upgrade
                        >
                          <span>Upgrade to Pro</span>
                        </Link>
                      </div>
                    );
                  }

                  if (!teamsIncluded) {
                    return (
                      <div
                        className="mt-2 text-[0.92rem] leading-[1.7] text-[#475569]"
                        data-billing-teams-not-included
                      >
                        <p>Teams are not included in your current plan.</p>
                        <Link
                          href="/pricing#plan-pro"
                          className="app-header-primary-action mt-3 inline-flex"
                          data-billing-teams-upgrade
                        >
                          <span>Upgrade to Pro</span>
                        </Link>
                      </div>
                    );
                  }

                  return (
                    <div
                      className="mt-2 text-[0.92rem] leading-[1.7] text-[#475569]"
                      data-billing-teams-included
                    >
                      Teams — Current usage: {teamsSummary.teamsUsed} of{" "}
                      {teamsMaxLabel} · Members per Team: {membersLabel} ·
                      Email invitations: Included
                    </div>
                  );
                })()}
              </div>
            </PageSection>
          ) : null}

          <PageSection>
            <CheckoutPanel
              key={`${initialTargetType}-${initialPlan}-${selectedTeamId || "no-team-selected"}`}
              personal={personal}
              teams={allTeams}
              initialSelectedTeamId={selectedTeamId}
              initialTargetType={initialTargetType}
              initialPlan={initialPlan}
              onCheckoutCompleted={loadOverview}
              personalSpaceAllowed={personalSpaceAllowed}
            />
          </PageSection>

          <PageSection>
            <PersonalWorkspaceCard workspace={personal} />
          </PageSection>

          <PageSection>
            {allTeams.length > 0 ? (
              <div style={{ display: "grid", gap: 20 }}>
                {allTeams.map((team) => (
                  <TeamWorkspaceCard
                    key={team.id}
                    workspace={team}
                    onSelectForCheckout={handleSelectTeamForCheckout}
                    onCancelSubscription={handleCancelSubscription}
                    busy={cancelBusyTeamId === team.id}
                  />
                ))}
              </div>
            ) : (
              <div className="cases-empty" data-billing-no-workspaces>
                {/* Phase IA-self-serve-completion — "operate shared
                    evidence workflows" replaced with plain-language
                    copy. /workflows is ENTERPRISE_ONLY in the tier
                    table; advertising workflow features to a
                    self-serve user on the Billing page misleads them
                    about what's included. */}
                <strong>No workspaces yet</strong>
                <p>
                  Create one to share cases and evidence with collaborators, or
                  activate a dedicated TEAM subscription later to raise your
                  owned-workspace limit.
                </p>
              </div>
            )}
          </PageSection>

          <PageSection>
            <StorageAddonsPanel
              items={storageAddons}
              cancelBusyId={cancelBusyAddonId}
              onCancelRecurring={handleCancelStorageAddon}
              onBuyMore={() => {
                try {
                  window.scrollTo({ top: 0, behavior: "smooth" });
                } catch {
                  window.scrollTo(0, 0);
                }
              }}
            />
          </PageSection>

          <PageSection>
            <PaymentsSection onEntitlementRestored={loadOverview} />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}