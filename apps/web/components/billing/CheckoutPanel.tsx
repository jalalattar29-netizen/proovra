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

type StorageAddonBillingCycle = "ONE_TIME" | "MONTHLY";

type StorageAddonCatalogItem = {
  key: string;
  workspaceType: "PERSONAL" | "TEAM";
  label: string;
  storageBytes: string;
  priceCents: number;
  currency: string;
};

type PricingCatalogResponseLite = {
  storageAddons?: StorageAddonCatalogItem[];
};

type CheckoutMode = "PLAN" | "ADDON";

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

function parseMaybeNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatBytesCompact(value?: string | number | null): string {
  const n = parseMaybeNumber(value);
  if (!Number.isFinite(n) || n == null || n <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = n;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  const fixed = index === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fixed)} ${units[index]}`;
}

function formatMoneyFromCents(priceCents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 2,
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${currency || "EUR"}`;
  }
}

function getPersonalPlan(personal: PersonalWorkspaceSummary | null | undefined) {
  return String(personal?.plan ?? "FREE").toUpperCase();
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

  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("PLAN");
  const [targetType, setTargetType] = useState<CheckoutTargetType>(initialTargetType);
  const [selectedTeamId, setSelectedTeamId] = useState(initialSelectedTeamId);
  const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan>(initialPlan);
  const [selectedProvider, setSelectedProvider] =
    useState<CheckoutProvider>("STRIPE");
  const [busy, setBusy] = useState(false);

  const [pricingCatalog, setPricingCatalog] =
    useState<PricingCatalogResponseLite | null>(null);

  const [selectedAddonKey, setSelectedAddonKey] = useState("");
  const [selectedAddonBillingCycle, setSelectedAddonBillingCycle] =
    useState<StorageAddonBillingCycle>("MONTHLY");

  useEffect(() => {
    apiFetch("/v1/billing/pricing", { method: "GET" }, { auth: false, retryAuthOnce: false })
      .then((data) => {
        setPricingCatalog((data ?? null) as PricingCatalogResponseLite | null);
      })
      .catch(() => {
        setPricingCatalog(null);
      });
  }, []);

  useEffect(() => {
    if (targetType === "TEAM") {
      if (!selectedTeamId && teams[0]?.id) {
        setSelectedTeamId(teams[0].id);
      }
      if (selectedPlan !== "TEAM") {
        setSelectedPlan("TEAM");
      }
      if (selectedAddonBillingCycle !== "MONTHLY") {
        setSelectedAddonBillingCycle("MONTHLY");
      }
      return;
    }

    if (selectedPlan === "TEAM") {
      setSelectedPlan("PAYG");
    }
  }, [
    targetType,
    selectedPlan,
    selectedTeamId,
    teams,
    selectedAddonBillingCycle,
  ]);

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

  const personalPlan = useMemo(() => getPersonalPlan(personal), [personal]);

  const addonCatalog = useMemo(() => {
    const items = Array.isArray(pricingCatalog?.storageAddons)
      ? pricingCatalog?.storageAddons ?? []
      : [];

    return items.filter((item) =>
      targetType === "TEAM"
        ? item.workspaceType === "TEAM"
        : item.workspaceType === "PERSONAL"
    );
  }, [pricingCatalog, targetType]);

  const allowedAddonKeys = useMemo(() => {
    if (targetType === "TEAM") {
      return addonCatalog.map((item) => item.key);
    }

    if (personalPlan === "PAYG") {
      return addonCatalog
        .filter(
          (item) =>
            item.key === "PERSONAL_10_GB" || item.key === "PERSONAL_50_GB"
        )
        .map((item) => item.key);
    }

    if (personalPlan === "PRO") {
      return addonCatalog.map((item) => item.key);
    }

    return [] as string[];
  }, [addonCatalog, targetType, personalPlan]);

  const availableAddons = useMemo(() => {
    return addonCatalog.filter((item) => allowedAddonKeys.includes(item.key));
  }, [addonCatalog, allowedAddonKeys]);

  useEffect(() => {
    if (!availableAddons.length) {
      setSelectedAddonKey("");
      return;
    }

    if (!selectedAddonKey || !availableAddons.some((item) => item.key === selectedAddonKey)) {
      setSelectedAddonKey(availableAddons[0].key);
    }
  }, [availableAddons, selectedAddonKey]);

  useEffect(() => {
    if (targetType === "TEAM") {
      setSelectedAddonBillingCycle("MONTHLY");
      return;
    }

    if (personalPlan === "PRO") {
      setSelectedAddonBillingCycle("MONTHLY");
      return;
    }

    if (personalPlan === "PAYG") {
      if (
        selectedAddonBillingCycle !== "ONE_TIME" &&
        selectedAddonBillingCycle !== "MONTHLY"
      ) {
        setSelectedAddonBillingCycle("ONE_TIME");
      }
      return;
    }

    setSelectedAddonBillingCycle("MONTHLY");
  }, [targetType, personalPlan, selectedAddonBillingCycle]);

  const selectedAddon = useMemo(
    () => availableAddons.find((item) => item.key === selectedAddonKey) ?? null,
    [availableAddons, selectedAddonKey]
  );

  const addonBillingCycleOptions = useMemo(() => {
    if (targetType === "TEAM") {
      return ["MONTHLY"] as StorageAddonBillingCycle[];
    }

    if (personalPlan === "PRO") {
      return ["MONTHLY"] as StorageAddonBillingCycle[];
    }

    if (personalPlan === "PAYG") {
      return ["ONE_TIME", "MONTHLY"] as StorageAddonBillingCycle[];
    }

    return [] as StorageAddonBillingCycle[];
  }, [targetType, personalPlan]);

  const planDescription = useMemo(() => {
    if (selectedPlan === "PAYG") {
      return "One-time checkout for usage-based evidence completion on your personal workspace.";
    }
    if (selectedPlan === "PRO") {
      return "Recurring monthly subscription for personal professional usage.";
    }
    return "Recurring monthly subscription for a team workspace you own.";
  }, [selectedPlan]);

  const addonDescription = useMemo(() => {
    if (targetType === "TEAM") {
      return "Team storage add-ons are recurring monthly and stack on top of the active TEAM plan.";
    }
    if (personalPlan === "PAYG") {
      return "PAYG supports only +10 GB and +50 GB storage add-ons. You can use a one-time or recurring add-on flow.";
    }
    if (personalPlan === "PRO") {
      return "PRO supports recurring personal storage add-ons.";
    }
    return "Upgrade your base personal plan before purchasing extra storage.";
  }, [targetType, personalPlan]);

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
    if (!availableProviders.includes(selectedProvider)) return false;

    if (checkoutMode === "PLAN") {
      return availablePlans.includes(selectedPlan);
    }

    if (!selectedAddonKey) return false;
    if (!selectedAddon) return false;
    if (!addonBillingCycleOptions.includes(selectedAddonBillingCycle)) return false;
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
    checkoutMode,
    selectedAddonKey,
    selectedAddon,
    addonBillingCycleOptions,
    selectedAddonBillingCycle,
  ]);

  const handleTargetTypeChange = (next: CheckoutTargetType) => {
    setTargetType(next);

    if (next === "TEAM") {
      setSelectedPlan("TEAM");
      if (!selectedTeamId && teams[0]?.id) {
        setSelectedTeamId(teams[0].id);
      }
      setSelectedAddonBillingCycle("MONTHLY");
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

      if (checkoutMode === "PLAN") {
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
      }

      const addonPayload =
        targetType === "TEAM"
          ? {
              addonKey: selectedAddonKey,
              billingCycle: selectedAddonBillingCycle,
              teamId: selectedTeamId,
            }
          : {
              addonKey: selectedAddonKey,
              billingCycle: selectedAddonBillingCycle,
            };

      if (selectedProvider === "STRIPE") {
        const data = await apiFetch("/v1/billing/storage-addons/checkout/stripe", {
          method: "POST",
          body: JSON.stringify(addonPayload),
        });

        const url = data?.session?.url as string | undefined;
        if (!url) {
          throw new Error("Stripe checkout URL missing");
        }

        window.location.href = url;
        return;
      }

      const data = await apiFetch("/v1/billing/storage-addons/checkout/paypal", {
        method: "POST",
        body: JSON.stringify(addonPayload),
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
        checkoutMode,
        selectedAddonKey,
        selectedAddonBillingCycle,
      });

      const message =
        err instanceof Error ? err.message : "Failed to create checkout session";
      addToast(message, "error");
    } finally {
      setBusy(false);
      await onCheckoutCompleted?.();
    }
  };

  const upgradeHint =
    checkoutMode === "ADDON" &&
    targetType === "PERSONAL" &&
    selectedAddonKey === "PERSONAL_200_GB"
      ? "If you need substantially more collaboration features or larger long-term workspace capacity, upgrading your base plan may be more cost-effective than stacking many add-ons."
      : checkoutMode === "ADDON" &&
          targetType === "TEAM" &&
          (selectedAddonKey === "TEAM_500_GB" || selectedAddonKey === "TEAM_1_TB")
        ? "For larger team growth, compare extra storage against broader workspace expansion needs before stacking multiple large add-ons."
        : null;

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
          Choose workspace target, purchase mode, then payment method. Base plan
          rules and storage add-on rules are enforced both here and on the backend.
        </div>

        <div className="mt-5 grid gap-5">
          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              1. Workspace target
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={targetType === "PERSONAL" ? activePillStyle : inactivePillStyle}
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
              2. Purchase mode
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={checkoutMode === "PLAN" ? activePillStyle : inactivePillStyle}
                onClick={() => setCheckoutMode("PLAN")}
              >
                Base plan
              </Button>

              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={checkoutMode === "ADDON" ? activePillStyle : inactivePillStyle}
                onClick={() => setCheckoutMode("ADDON")}
                disabled={
                  targetType === "PERSONAL" && (personalPlan === "FREE" || !pricingCatalog)
                }
              >
                Extra storage
              </Button>
            </div>

            {checkoutMode === "ADDON" &&
            targetType === "PERSONAL" &&
            personalPlan === "FREE" ? (
              <div className="mt-3 text-[0.88rem] leading-[1.75] text-[#8b3e3e]">
                Upgrade your base personal plan before purchasing extra storage.
              </div>
            ) : null}
          </div>

          {checkoutMode === "PLAN" ? (
            <div>
              <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
                3. Plan
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
          ) : (
            <div>
              <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
                3. Storage add-on
              </div>

              <div className="grid gap-3">
                {availableAddons.length === 0 ? (
                  <div
                    className="rounded-[18px] border px-4 py-4 text-[0.9rem] leading-[1.75]"
                    style={{
                      border: "1px solid rgba(79,112,107,0.10)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                      color: "#5d6d71",
                    }}
                  >
                    No eligible storage add-ons are available for the current workspace context.
                  </div>
                ) : (
                  availableAddons.map((addon) => {
                    const active = addon.key === selectedAddonKey;
                    return (
                      <button
                        key={addon.key}
                        type="button"
                        onClick={() => setSelectedAddonKey(addon.key)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          borderRadius: 18,
                          padding: 16,
                          border: active
                            ? "1px solid rgba(79,112,107,0.22)"
                            : "1px solid rgba(79,112,107,0.10)",
                          background: active
                            ? "linear-gradient(180deg, rgba(230,245,241,0.92) 0%, rgba(243,245,242,0.96) 100%)"
                            : "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                          boxShadow: active
                            ? "0 12px 28px rgba(20,48,52,0.08)"
                            : "0 8px 20px rgba(0,0,0,0.04)",
                          color: "#21353a",
                          cursor: "pointer",
                        }}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-[0.96rem] font-semibold">
                              {addon.label}
                            </div>
                            <div className="mt-1 text-[0.85rem] leading-[1.7] text-[#5d6d71]">
                              {formatBytesCompact(addon.storageBytes)} extra storage
                            </div>
                          </div>

                          <div className="text-[0.92rem] font-semibold text-[#245955]">
                            {formatMoneyFromCents(addon.priceCents, addon.currency)}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="mt-3 text-[0.88rem] leading-[1.75] text-[#5d6d71]">
                {addonDescription}
              </div>

              {addonBillingCycleOptions.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
                    4. Billing cycle
                  </div>

                  <div className="flex flex-wrap gap-3">
                    {addonBillingCycleOptions.map((cycle) => (
                      <Button
                        key={cycle}
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={
                          selectedAddonBillingCycle === cycle
                            ? activePillStyle
                            : inactivePillStyle
                        }
                        onClick={() => setSelectedAddonBillingCycle(cycle)}
                      >
                        {cycle === "ONE_TIME" ? "One-time" : "Monthly recurring"}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              {upgradeHint ? (
                <div
                  className="mt-4 rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
                  style={{
                    border: "1px solid rgba(183,157,132,0.16)",
                    background:
                      "linear-gradient(180deg, rgba(250,248,245,0.72) 0%, rgba(243,239,234,0.90) 100%)",
                    color: "#7a624d",
                  }}
                >
                  {upgradeHint}
                </div>
              ) : null}
            </div>
          )}

          <div>
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              {checkoutMode === "PLAN" ? "4. Payment method" : "5. Payment method"}
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
              Mode: {checkoutMode === "PLAN" ? "Base plan" : "Extra storage"}
              <br />
              {checkoutMode === "PLAN" ? (
                <>
                  Plan: {selectedPlan}
                  <br />
                </>
              ) : (
                <>
                  Add-on: {selectedAddon?.label ?? "—"}
                  <br />
                  Billing cycle:{" "}
                  {selectedAddonBillingCycle === "ONE_TIME"
                    ? "One-time"
                    : "Monthly recurring"}
                  <br />
                </>
              )}
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