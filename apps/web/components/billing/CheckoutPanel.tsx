"use client";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/ui";
import { apiFetch } from "../../lib/api";
import { captureException } from "../../lib/sentry";
import {
  detectCurrency,
  type SupportedCurrency,
} from "../../lib/currency";
import type {
  CheckoutPlan,
  CheckoutProvider,
  CheckoutTargetType,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
} from "./types";

type Props = {
  personal: PersonalWorkspaceSummary | null | undefined;
  teams: TeamWorkspaceSummary[];
  initialSelectedTeamId?: string;
  initialTargetType?: CheckoutTargetType;
  initialPlan?: CheckoutPlan;
  onCheckoutCompleted?: () => Promise<void> | void;
  /**
   * PHASE 10 CLOSURE FIX 3 (2026-07-23) — `false` when the server-projected
   * `personalSpaceAllowed` on the platform-context envelope is explicitly
   * false (managed enterprise identity, no Personal Space). Hides the
   * Personal-workspace checkout target/button entirely — CLIENT-HIDING
   * ONLY; the server independently rejects a personal checkout regardless.
   * Defaults to `true` (unaffected legacy behavior) when omitted.
   */
  personalSpaceAllowed?: boolean;
};

function hasOwnedTeams(teams: TeamWorkspaceSummary[]) {
  return teams.length > 0;
}

function normalizeCheckoutCurrency(
  value: SupportedCurrency | string | null | undefined
): "EUR" | "USD" {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "EUR") return "EUR";
  return "USD";
}

function normalizePlanLabel(value?: string | null): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || "FREE";
}

export function CheckoutPanel({
  personal,
  teams,
  initialSelectedTeamId = "",
  initialTargetType = "PERSONAL",
  initialPlan = "PAYG",
  onCheckoutCompleted,
  personalSpaceAllowed = true,
}: Props) {
  const { addToast } = useToast();

  // PHASE 10 CLOSURE FIX 3 — never initialize into a disallowed Personal
  // target, even if the caller (e.g. a stale `?workspace=personal` deep
  // link) requested it.
  const [targetType, setTargetType] = useState<CheckoutTargetType>(
    !personalSpaceAllowed && initialTargetType === "PERSONAL"
      ? "TEAM"
      : initialTargetType,
  );
  const [selectedTeamId, setSelectedTeamId] = useState(initialSelectedTeamId);
  const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan>(initialPlan);
  const [selectedProvider, setSelectedProvider] =
    useState<CheckoutProvider>("STRIPE");
  const [busy, setBusy] = useState(false);

  const checkoutCurrency = useMemo<"EUR" | "USD">(() => {
    try {
      return normalizeCheckoutCurrency(detectCurrency());
    } catch {
      return "USD";
    }
  }, []);

  useEffect(() => {
    if (targetType === "TEAM") {
      if (!selectedTeamId && teams[0]?.id) {
        setSelectedTeamId(teams[0].id);
      }

      if (selectedPlan !== "TEAM") {
        setSelectedPlan("TEAM");
      }

      return;
    }

    if (selectedPlan === "TEAM") {
      setSelectedPlan("PAYG");
    }
  }, [targetType, selectedPlan, selectedTeamId, teams]);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [teams, selectedTeamId]
  );

  const availablePlans = useMemo(() => {
    if (targetType === "TEAM") {
      /**
       * Important:
       * TEAM target here means "buy or activate a TEAM subscription
       * for this specific workspace".
       *
       * It does NOT mean that shared workspaces only exist on TEAM.
       * A workspace may already operate under the owner's PRO entitlement.
       */
      return ["TEAM"] as CheckoutPlan[];
    }

    return ["PAYG", "PRO"] as CheckoutPlan[];
  }, [targetType]);

  const availableProviders = useMemo(() => {
    return ["STRIPE", "PAYPAL"] as CheckoutProvider[];
  }, []);

  const personalPlanLabel = normalizePlanLabel(personal?.plan);

  const selectedTeamPlanLabel = normalizePlanLabel(selectedTeam?.plan);
  const selectedTeamEffectivePlanLabel = normalizePlanLabel(
    selectedTeam?.effectivePlan
  );
  const selectedTeamStatusLabel = normalizePlanLabel(selectedTeam?.billingStatus);

  const planDescription = useMemo(() => {
    if (selectedPlan === "PAYG") {
      return "One-time checkout for usage-based evidence completion on your personal workspace.";
    }

    if (selectedPlan === "PRO") {
      return "Recurring monthly subscription for your personal workspace. PRO also allows shared workspaces and raises your owned workspace limit to 2.";
    }

    return "Recurring monthly TEAM subscription for the selected workspace. TEAM raises the owned workspace limit to 5 while each single workspace still has a hard 5-member cap.";
  }, [selectedPlan]);

  const targetDescription = useMemo(() => {
    if (targetType === "TEAM") {
      if (!selectedTeam) {
        return "Choose a workspace you own before continuing.";
      }

      const effectivePlan =
        normalizePlanLabel(selectedTeam.effectivePlan) ||
        normalizePlanLabel(selectedTeam.plan);

      return `Checkout will apply to workspace: ${selectedTeam.name}. Current workspace plan view: ${normalizePlanLabel(
        selectedTeam.plan
      )}. Effective capability view: ${effectivePlan}.`;
    }

    return `Checkout will apply to your personal workspace (current plan: ${personalPlanLabel}).`;
  }, [targetType, selectedTeam, personalPlanLabel]);

  const rulesSummary = useMemo(() => {
    if (targetType === "TEAM") {
      return [
        "A workspace may already be valid under PRO.",
        "This checkout is specifically for activating or upgrading that workspace to TEAM billing.",
        "Each single workspace still has a hard limit of 5 actual members.",
        "Invitations themselves are not the limit; actual member addition is.",
      ];
    }

    // Phase IA-self-serve-completion — added the first line below to
    // make the per-user vs per-workspace distinction explicit. Solo lawyers
    // / journalists evaluating "PRO allows 2 workspaces" could not tell
    // whether PRO upgraded them or one workspace they were in.
    return [
      "PAYG, PRO, and TEAM apply to your personal account.",
      "Each workspace you own can also have its own dedicated TEAM subscription.",
      "PRO allows you to own up to 2 workspaces; TEAM raises that to 5.",
      "Each single workspace still has a hard limit of 5 actual members.",
    ];
  }, [targetType]);

  const canContinue = useMemo(() => {
    if (busy) return false;
    // PHASE 10 CLOSURE FIX 3 — a disallowed Personal target can never
    // remain selectable for checkout, regardless of how `targetType` got
    // set (initial prop, deep-link fallback, or a stale prior selection).
    if (!personalSpaceAllowed && targetType === "PERSONAL") return false;
    if (targetType === "TEAM" && !selectedTeamId) return false;
    if (targetType === "TEAM" && !hasOwnedTeams(teams)) return false;
    if (!availablePlans.includes(selectedPlan)) return false;
    if (!availableProviders.includes(selectedProvider)) return false;
    return true;
  }, [
    busy,
    personalSpaceAllowed,
    targetType,
    selectedTeamId,
    selectedPlan,
    selectedProvider,
    availablePlans,
    availableProviders,
    teams,
  ]);

  const handleTargetTypeChange = (next: CheckoutTargetType) => {
    // PHASE 10 CLOSURE FIX 3 — defensive: the Personal chip is not rendered
    // when disallowed, but never honor a PERSONAL selection either way.
    if (!personalSpaceAllowed && next === "PERSONAL") return;
    setTargetType(next);

    if (next === "TEAM") {
      setSelectedPlan("TEAM");
      if (!selectedTeamId && teams[0]?.id) {
        setSelectedTeamId(teams[0].id);
      }
      return;
    }

    if (selectedPlan === "TEAM") {
      setSelectedPlan("PAYG");
    }
  };

  const handlePlanChange = (plan: CheckoutPlan) => {
    setSelectedPlan(plan);
  };

  const handleProviderChange = (provider: CheckoutProvider) => {
    setSelectedProvider(provider);
  };

  const handleContinue = async () => {
    if (!canContinue) return;

    setBusy(true);
    try {
      addToast("Creating checkout session...", "info");

      const payload =
        targetType === "TEAM"
          ? {
              plan: selectedPlan,
              teamId: selectedTeamId,
              currency: checkoutCurrency,
            }
          : {
              plan: selectedPlan,
              currency: checkoutCurrency,
            };

      if (selectedProvider === "STRIPE") {
        const data = await apiFetch("/v1/billing/checkout/stripe", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        const url = data?.session?.url as string | undefined;
        if (!url) {
          throw new Error("Stripe checkout URL missing");
        }

        window.location.href = url;
        return;
      }

      const data = await apiFetch("/v1/billing/checkout/paypal", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (data?.mode === "order") {
        const approve = (
          data?.order?.links as Array<{ rel: string; href: string }> | undefined
        )?.find((item) => item.rel === "approve");

        if (!approve?.href) {
          throw new Error("PayPal approval URL missing");
        }

        window.location.href = approve.href;
        return;
      }

      if (data?.mode === "subscription") {
        const approve = (
          data?.subscription?.links as
            | Array<{ rel: string; href: string }>
            | undefined
        )?.find((item) => item.rel === "approve");

        if (!approve?.href) {
          throw new Error("PayPal subscription approval URL missing");
        }

        window.location.href = approve.href;
        return;
      }

      throw new Error("Unknown checkout response");
    } catch (err) {
      captureException(err, {
        feature: "billing_checkout_panel",
        targetType,
        selectedTeamId,
        selectedPlan,
        selectedProvider,
        currency: checkoutCurrency,
      });

      const message =
        toSafeUserError(err, { message: "Failed to create checkout session" }).message;
      addToast(message, "error");
    } finally {
      setBusy(false);
      await onCheckoutCompleted?.();
    }
  };

  return (
    <div className="cases-panel" style={{ overflow: "hidden" }}>
      <div className="relative z-10 p-6 md:p-7">
        <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#172033]">
          Checkout Console
        </div>

        <div className="text-[0.92rem] leading-[1.7] text-[#475569]">
          Choose workspace target, plan, then payment method. The same billing
          rules are enforced here and on the backend.
        </div>

        <div className="mt-2 text-[0.84rem] text-[#5F6878]">
          Preferred currency: <strong>{checkoutCurrency}</strong>
        </div>

        <div className="mt-5 grid gap-5">
          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              1. Workspace target
            </div>

            <div className="flex flex-wrap gap-3">
              {/* PHASE 10 CLOSURE FIX 3 (2026-07-23) — the Personal checkout
                  target is unavailable for a managed identity with no
                  Personal Space. Client-hiding only; the server
                  independently rejects a personal checkout regardless. */}
              {personalSpaceAllowed ? (
                <button
                  type="button"
                  className={chipClass(targetType === "PERSONAL")}
                  onClick={() => handleTargetTypeChange("PERSONAL")}
                  data-checkout-target="PERSONAL"
                >
                  Personal workspace
                </button>
              ) : null}

              <button
                type="button"
                className={chipClass(targetType === "TEAM")}
                onClick={() => handleTargetTypeChange("TEAM")}
                disabled={teams.length === 0}
                data-checkout-target="TEAM"
              >
                Workspace
              </button>
            </div>

            {!personalSpaceAllowed && teams.length === 0 ? (
              <p
                className="mt-3 text-[0.86rem] leading-[1.7] text-[#475569]"
                data-checkout-no-target
              >
                No workspace is available for checkout. Ask your organization
                administrator to assign you a workspace.
              </p>
            ) : null}

            {targetType === "TEAM" ? (
              <div className="mt-3">
                <select
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  className="cases-form-input"
                  style={{ padding: "12px 14px", fontSize: 14 }}
                >
                  <option value="">Select workspace...</option>
                  {teams.map((team) => {
                    const effectivePlan = normalizePlanLabel(team.effectivePlan);
                    const billingStatus = normalizePlanLabel(team.billingStatus);

                    return (
                      <option key={team.id} value={team.id}>
                        {team.name} · effective {effectivePlan} · {billingStatus}
                      </option>
                    );
                  })}
                </select>

                {selectedTeam ? (
                  <div className="cases-inner mt-3 px-4 py-4 text-[0.86rem] leading-[1.75] text-[#475569]">
                    Selected team: <strong>{selectedTeam.name}</strong>
                    <br />
                    Workspace plan: <strong>{selectedTeamPlanLabel}</strong>
                    <br />
                    Effective plan: <strong>{selectedTeamEffectivePlanLabel}</strong>
                    <br />
                    Billing status: <strong>{selectedTeamStatusLabel}</strong>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              2. Plan
            </div>

            <div className="flex flex-wrap gap-3">
              {availablePlans.map((plan) => (
                <button
                  key={plan}
                  type="button"
                  className={chipClass(selectedPlan === plan)}
                  onClick={() => handlePlanChange(plan)}
                >
                  {plan}
                </button>
              ))}
            </div>

            <div className="mt-3 text-[0.88rem] leading-[1.75] text-[#475569]">
              {planDescription}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              3. Payment method
            </div>

            <div className="flex flex-wrap gap-3">
              {availableProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={chipClass(selectedProvider === provider)}
                  onClick={() => handleProviderChange(provider)}
                >
                  {provider === "STRIPE" ? "Card / Stripe" : "PayPal"}
                </button>
              ))}
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[0.9rem] font-semibold text-[#172033]">
              Checkout summary
            </div>

            <div className="mt-2 text-[0.9rem] leading-[1.75] text-[#475569]">
              Target: {targetType === "TEAM" ? "Workspace" : "Personal workspace"}
              <br />
              Plan: {selectedPlan}
              <br />
              Payment: {selectedProvider}
              <br />
              Preferred currency: {checkoutCurrency}
            </div>

            <div className="mt-3 text-[0.86rem] leading-[1.75] text-[#475569]">
              {targetDescription}
            </div>

            <div className="mt-4 grid gap-2">
              {rulesSummary.map((item, index) => (
                <div
                  key={index}
                  className="text-[0.84rem] leading-[1.7] text-[#475569]"
                >
                  • {item}
                </div>
              ))}
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={handleContinue}
              disabled={!canContinue}
              className="app-header-primary-action"
              style={{ width: "100%" }}
            >
              <span>{busy ? "Creating checkout..." : "Continue to checkout"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Shared pill/segment style — the canonical `.cases-filter-chip`
// active-state language (indigo #4F46E5 active, neutral idle).
function chipClass(active: boolean): string {
  return ["cases-filter-chip", active ? "is-active" : ""]
    .filter(Boolean)
    .join(" ");
}