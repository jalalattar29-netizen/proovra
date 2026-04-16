"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Card, useToast } from "../../components/ui";
import { apiFetch } from "../../lib/api";
import { captureException } from "../../lib/sentry";
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
};

function hasOwnedTeams(teams: TeamWorkspaceSummary[]) {
  return teams.length > 0;
}

export function CheckoutPanel({
  personal,
  teams,
  initialSelectedTeamId = "",
  initialTargetType = "PERSONAL",
  initialPlan = "PAYG",
  onCheckoutCompleted,
}: Props) {
  const { addToast } = useToast();

  const [targetType, setTargetType] = useState<CheckoutTargetType>(initialTargetType);
  const [selectedTeamId, setSelectedTeamId] = useState(initialSelectedTeamId);
  const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan>(initialPlan);
  const [selectedProvider, setSelectedProvider] =
    useState<CheckoutProvider>("STRIPE");
  const [busy, setBusy] = useState(false);

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
      return ["TEAM"] as CheckoutPlan[];
    }
    return ["PAYG", "PRO"] as CheckoutPlan[];
  }, [targetType]);

  const availableProviders = useMemo(() => {
    return ["STRIPE", "PAYPAL"] as CheckoutProvider[];
  }, []);

  const planDescription = useMemo(() => {
    if (selectedPlan === "PAYG") {
      return "One-time checkout for usage-based evidence completion on your personal workspace.";
    }
    if (selectedPlan === "PRO") {
      return "Recurring monthly subscription for personal professional usage.";
    }
    return "Recurring monthly subscription for a team workspace you own.";
  }, [selectedPlan]);

  const targetDescription = useMemo(() => {
    if (targetType === "TEAM") {
      return selectedTeam
        ? `Checkout will apply to team workspace: ${selectedTeam.name}.`
        : "Choose a team workspace you own before continuing.";
    }

    return `Checkout will apply to your personal workspace${
      personal?.plan ? ` (current plan: ${personal.plan})` : ""
    }.`;
  }, [targetType, selectedTeam, personal]);

  const canContinue = useMemo(() => {
    if (busy) return false;
    if (targetType === "TEAM" && !selectedTeamId) return false;
    if (targetType === "TEAM" && !hasOwnedTeams(teams)) return false;
    if (!availablePlans.includes(selectedPlan)) return false;
    if (!availableProviders.includes(selectedProvider)) return false;
    return true;
  }, [
    busy,
    targetType,
    selectedTeamId,
    selectedPlan,
    selectedProvider,
    availablePlans,
    availableProviders,
    teams,
  ]);

  const handleTargetTypeChange = (next: CheckoutTargetType) => {
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
            }
          : {
              plan: selectedPlan,
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
          data?.subscription?.links as Array<{ rel: string; href: string }> | undefined
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
      });

      const message =
        err instanceof Error ? err.message : "Failed to create checkout session";
      addToast(message, "error");
    } finally {
      setBusy(false);
      await onCheckoutCompleted?.();
    }
  };

  return (
    <Card
      className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
      style={{
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }}
    >
      <div className="relative z-10 p-6 md:p-7">
        <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Checkout Console
        </div>

        <div className="text-[0.92rem] leading-[1.7] text-[#5d6d71]">
          Choose workspace target, plan, then payment method. The same billing
          rules are enforced here and on the backend.
        </div>

        <div className="mt-5 grid gap-5">
          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              1. Workspace target
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={
                  targetType === "PERSONAL"
                    ? activePillStyle
                    : inactivePillStyle
                }
                onClick={() => handleTargetTypeChange("PERSONAL")}
              >
                Personal workspace
              </Button>

              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={targetType === "TEAM" ? activePillStyle : inactivePillStyle}
                onClick={() => handleTargetTypeChange("TEAM")}
                disabled={teams.length === 0}
              >
                Team workspace
              </Button>
            </div>

            {targetType === "TEAM" ? (
              <div className="mt-3">
                <select
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  style={{
                    width: "100%",
                    borderRadius: 14,
                    border: "1px solid rgba(79,112,107,0.16)",
                    padding: "12px 14px",
                    background: "rgba(255,255,255,0.86)",
                    color: "#21353a",
                    fontSize: 14,
                  }}
                >
                  <option value="">Select team workspace...</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              2. Plan
            </div>

            <div className="flex flex-wrap gap-3">
              {availablePlans.map((plan) => (
                <Button
                  key={plan}
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={selectedPlan === plan ? activePillStyle : inactivePillStyle}
                  onClick={() => handlePlanChange(plan)}
                >
                  {plan}
                </Button>
              ))}
            </div>

            <div className="mt-3 text-[0.88rem] leading-[1.75] text-[#5d6d71]">
              {planDescription}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              3. Payment method
            </div>

            <div className="flex flex-wrap gap-3">
              {availableProviders.map((provider) => (
                <Button
                  key={provider}
                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                  style={
                    selectedProvider === provider ? activePillStyle : inactivePillStyle
                  }
                  onClick={() => handleProviderChange(provider)}
                >
                  {provider === "STRIPE" ? "Card / Stripe" : "PayPal"}
                </Button>
              ))}
            </div>
          </div>

          <div
            className="rounded-[20px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[0.9rem] font-semibold text-[#21353a]">
              Checkout summary
            </div>
            <div className="mt-2 text-[0.9rem] leading-[1.75] text-[#5d6d71]">
              Target: {targetType === "TEAM" ? "Team workspace" : "Personal workspace"}
              <br />
              Plan: {selectedPlan}
              <br />
              Payment: {selectedProvider}
            </div>

            <div className="mt-3 text-[0.86rem] leading-[1.75] text-[#5d6d71]">
              {targetDescription}
            </div>
          </div>

          <div>
            <Button
              onClick={handleContinue}
              disabled={!canContinue}
              className="w-full rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
              style={{
                borderColor: "rgba(79,112,107,0.18)",
                color: "#eef3f1",
                background:
                  "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
              }}
            >
              {busy ? "Creating checkout..." : "Continue to checkout"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

const activePillStyle: CSSProperties = {
  borderColor: "rgba(79,112,107,0.18)",
  color: "#eef3f1",
  background:
    "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
};

const inactivePillStyle: CSSProperties = {
  borderColor: "rgba(79,112,107,0.14)",
  color: "#23373b",
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
};