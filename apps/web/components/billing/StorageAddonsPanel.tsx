"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, useToast } from "../ui";
import { apiFetch } from "../../lib/api";
import { captureException } from "../../lib/sentry";
import { detectCurrency, type SupportedCurrency } from "../../lib/currency";
import type { WorkspaceStorageAddonSummary } from "./types";

function formatAddonStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (!normalized) return "Unknown";
  if (normalized === "ACTIVE") return "Active";
  if (normalized === "PENDING") return "Pending";
  if (normalized === "PAST_DUE") return "Past due";
  if (normalized === "CANCELED") return "Canceled";
  if (normalized === "EXPIRED") return "Expired";
  if (normalized === "FAILED") return "Failed";
  return normalized;
}

function toneForAddonStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") {
    return {
      color: "#2b6a55",
      background: "rgba(127,189,180,0.16)",
      border: "1px solid rgba(127,189,180,0.20)",
    } as const;
  }

  if (normalized === "PENDING" || normalized === "PAST_DUE") {
    return {
      color: "#8a6a2b",
      background: "rgba(201,169,139,0.18)",
      border: "1px solid rgba(201,169,139,0.22)",
    } as const;
  }

  if (
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "EXPIRED"
  ) {
    return {
      color: "#8b3e3e",
      background: "rgba(194,78,78,0.10)",
      border: "1px solid rgba(194,78,78,0.16)",
    } as const;
  }

  return {
    color: "#415257",
    background: "rgba(79,112,107,0.08)",
    border: "1px solid rgba(79,112,107,0.12)",
  } as const;
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

function formatDateLabel(value?: string | null): string {
  const text = String(value ?? "").trim();
  if (!text) return "—";

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  return date.toLocaleString();
}

function normalizeCurrency(
  value: SupportedCurrency | string | null | undefined
): "EUR" | "USD" {
  return String(value ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";
}

function formatMoney(amountCents: number, currency: string) {
  const safeCurrency =
    String(currency ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: safeCurrency,
  }).format(amountCents / 100);
}

type CheckoutProvider = "STRIPE" | "PAYPAL";
type CheckoutTarget = "PERSONAL" | "TEAM";

type StorageAddonCatalogItem = {
  key: string;
  label: string;
  storageBytes: string | number;
  priceCents: number;
  currency: string;
  workspaceType: CheckoutTarget;
  billingCycle?: "ONE_TIME" | "MONTHLY";
};

type TeamOption = {
  id: string;
  name: string;
  plan?: string | null;
  effectivePlan?: string | null;
  billingStatus?: string | null;
};

type StorageAddonsPanelProps = {
  items: WorkspaceStorageAddonSummary[];
  cancelBusyId?: string | null;
  onCancelRecurring?: ((addonId: string) => void | Promise<void>) | null;
  onBuyMore?: (() => void) | null;
};

export function StorageAddonsPanel({
  items,
  cancelBusyId = null,
  onCancelRecurring = null,
  onBuyMore = null,
}: StorageAddonsPanelProps) {
  const { addToast } = useToast();

  const [preferredCurrency, setPreferredCurrency] = useState<"EUR" | "USD">("USD");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogItems, setCatalogItems] = useState<StorageAddonCatalogItem[]>([]);
  const [teamOptions, setTeamOptions] = useState<TeamOption[]>([]);
  const [targetType, setTargetType] = useState<CheckoutTarget>("PERSONAL");
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [selectedProvider, setSelectedProvider] =
    useState<CheckoutProvider>("STRIPE");
  const [checkoutBusyKey, setCheckoutBusyKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      setPreferredCurrency(normalizeCurrency(detectCurrency()));
    } catch {
      setPreferredCurrency("USD");
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadCatalogAndTeams() {
      try {
        setCatalogLoading(true);
        setCatalogError(null);

        const [storageResponse, overviewResponse] = await Promise.all([
          apiFetch(`/v1/billing/storage-addons?currency=${preferredCurrency}`),
          apiFetch("/v1/billing/overview"),
        ]);

        if (!isMounted) return;

        const nextCatalog = Array.isArray(storageResponse?.catalog)
          ? (storageResponse.catalog as StorageAddonCatalogItem[])
          : [];

        const nextTeams = Array.isArray(overviewResponse?.workspaces?.teams)
          ? (overviewResponse.workspaces.teams as TeamOption[])
          : [];

        setCatalogItems(nextCatalog);
        setTeamOptions(nextTeams);

        setSelectedTeamId((current) => {
          if (current && nextTeams.some((team) => team.id === current)) {
            return current;
          }
          return nextTeams[0]?.id ?? "";
        });
      } catch (err) {
        if (!isMounted) return;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load storage add-on catalog";
        setCatalogError(message);
        setCatalogItems([]);
        setTeamOptions([]);
        captureException(err, {
          feature: "billing_storage_addons_catalog",
          preferredCurrency,
        });
      } finally {
        if (isMounted) {
          setCatalogLoading(false);
        }
      }
    }

    void loadCatalogAndTeams();

    return () => {
      isMounted = false;
    };
  }, [preferredCurrency]);

  useEffect(() => {
    if (targetType === "TEAM" && !selectedTeamId && teamOptions[0]?.id) {
      setSelectedTeamId(teamOptions[0].id);
    }
  }, [targetType, selectedTeamId, teamOptions]);

  const personalCatalog = useMemo(
    () =>
      catalogItems.filter(
        (item) =>
          item.workspaceType === "PERSONAL" &&
          String(item.billingCycle ?? "ONE_TIME").toUpperCase() === "ONE_TIME"
      ),
    [catalogItems]
  );

  const teamCatalog = useMemo(
    () =>
      catalogItems.filter(
        (item) =>
          item.workspaceType === "TEAM" &&
          String(item.billingCycle ?? "ONE_TIME").toUpperCase() === "ONE_TIME"
      ),
    [catalogItems]
  );

  const visibleCatalog = targetType === "TEAM" ? teamCatalog : personalCatalog;

  const canCheckoutForTarget =
    targetType === "PERSONAL" || Boolean(selectedTeamId && teamOptions.length > 0);

  async function startCheckout(item: StorageAddonCatalogItem) {
    if (checkoutBusyKey) return;
    if (targetType === "TEAM" && !selectedTeamId) {
      addToast("Select a team workspace first", "error");
      return;
    }

    const payload = {
      addonKey: item.key,
      billingCycle: "ONE_TIME" as const,
      currency: preferredCurrency,
      ...(targetType === "TEAM" ? { teamId: selectedTeamId } : {}),
    };

    const busyKey = `${selectedProvider}:${targetType}:${item.key}`;
    setCheckoutBusyKey(busyKey);

    try {
      addToast("Creating storage checkout...", "info");

      if (selectedProvider === "STRIPE") {
        const data = await apiFetch("/v1/billing/storage-addons/checkout/stripe", {
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

      const data = await apiFetch("/v1/billing/storage-addons/checkout/paypal", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (data?.mode === "order") {
        const approve = (
          data?.order?.links as Array<{ rel: string; href: string }> | undefined
        )?.find((itemLink) => itemLink.rel === "approve");

        if (!approve?.href) {
          throw new Error("PayPal approval URL missing");
        }

        window.location.href = approve.href;
        return;
      }

      throw new Error("Unexpected storage checkout response");
    } catch (err) {
      captureException(err, {
        feature: "billing_storage_addon_checkout",
        addonKey: item.key,
        provider: selectedProvider,
        targetType,
        selectedTeamId,
        currency: preferredCurrency,
      });

      const message =
        err instanceof Error
          ? err.message
          : "Failed to start storage checkout";
      addToast(message, "error");
    } finally {
      setCheckoutBusyKey(null);
    }
  }

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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
              Storage Add-ons
            </div>

            <div className="text-[0.9rem] leading-[1.7] text-[#5d6d71]">
              Buy extra storage as a <strong>one-time top-up</strong>. Your base
              <strong> PRO</strong> or <strong>TEAM</strong> subscription stays
              unchanged. Legacy recurring entries, if any, are still shown below.
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {onBuyMore ? (
              <Button
                onClick={() => onBuyMore()}
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={{
                  borderColor: "rgba(79,112,107,0.18)",
                  color: "#23373b",
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
                }}
              >
                Jump to plan checkout
              </Button>
            ) : null}

            <div
              className="rounded-[999px] border px-4 py-3 text-[0.84rem] font-semibold"
              style={{
                border: "1px solid rgba(79,112,107,0.12)",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.70) 0%, rgba(243,245,242,0.94) 100%)",
                color: "#415257",
              }}
            >
              Preferred currency: <strong>{preferredCurrency}</strong>
            </div>
          </div>
        </div>

        <div
          className="mt-5 rounded-[22px] border px-4 py-4"
          style={{
            border: "1px solid rgba(79,112,107,0.10)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
          }}
        >
          <div className="mb-3 text-[0.84rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
            Buy extra storage now
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={
                targetType === "PERSONAL"
                  ? {
                      borderColor: "rgba(79,112,107,0.18)",
                      color: "#eef3f1",
                      background:
                        "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                    }
                  : {
                      borderColor: "rgba(79,112,107,0.14)",
                      color: "#23373b",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
                    }
              }
              onClick={() => setTargetType("PERSONAL")}
            >
              Personal workspace
            </Button>

            <Button
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={
                targetType === "TEAM"
                  ? {
                      borderColor: "rgba(79,112,107,0.18)",
                      color: "#eef3f1",
                      background:
                        "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                    }
                  : {
                      borderColor: "rgba(79,112,107,0.14)",
                      color: "#23373b",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
                    }
              }
              onClick={() => setTargetType("TEAM")}
              disabled={teamOptions.length === 0}
            >
              Team workspace
            </Button>
          </div>

          {targetType === "TEAM" ? (
            <div className="mt-3">
              {teamOptions.length === 0 ? (
                <div className="text-[0.88rem] leading-[1.7] text-[#8b3e3e]">
                  No owned team workspace found yet. Create a team first, then
                  come back to purchase TEAM storage or start a TEAM subscription.
                </div>
              ) : (
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
                  {teamOptions.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null}

          <div className="mt-4">
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Payment method
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={
                  selectedProvider === "STRIPE"
                    ? {
                        borderColor: "rgba(79,112,107,0.18)",
                        color: "#eef3f1",
                        background:
                          "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                      }
                    : {
                        borderColor: "rgba(79,112,107,0.14)",
                        color: "#23373b",
                        background:
                          "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
                      }
                }
                onClick={() => setSelectedProvider("STRIPE")}
              >
                Card / Stripe
              </Button>

              <Button
                className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                style={
                  selectedProvider === "PAYPAL"
                    ? {
                        borderColor: "rgba(79,112,107,0.18)",
                        color: "#eef3f1",
                        background:
                          "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                      }
                    : {
                        borderColor: "rgba(79,112,107,0.14)",
                        color: "#23373b",
                        background:
                          "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(243,245,242,0.95) 100%)",
                      }
                }
                onClick={() => setSelectedProvider("PAYPAL")}
              >
                PayPal
              </Button>
            </div>
          </div>

          <div className="mt-4 text-[0.86rem] leading-[1.75] text-[#5d6d71]">
            Storage add-ons are processed as <strong>one-time purchases</strong>.
            They do <strong>not</strong> create a second monthly subscription for
            storage.
          </div>

          {catalogLoading ? (
            <div className="mt-4 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
              Loading available storage offers...
            </div>
          ) : catalogError ? (
            <div
              className="mt-4 rounded-[18px] border px-4 py-4 text-[0.9rem] leading-[1.7]"
              style={{
                border: "1px solid rgba(194,78,78,0.18)",
                background: "rgba(164,84,84,0.10)",
                color: "#9f3535",
              }}
            >
              {catalogError}
            </div>
          ) : visibleCatalog.length === 0 ? (
            <div className="mt-4 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
              No one-time storage offers are currently available for this workspace
              type.
            </div>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleCatalog.map((item) => {
                const busy =
                  checkoutBusyKey ===
                  `${selectedProvider}:${targetType}:${item.key}`;

                return (
                  <div
                    key={`${targetType}-${item.key}`}
                    className="rounded-[18px] border px-4 py-4"
                    style={{
                      border: "1px solid rgba(79,112,107,0.10)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    }}
                  >
                    <div className="text-[0.96rem] font-semibold text-[#21353a]">
                      {item.label}
                    </div>

                    <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                      {formatBytesCompact(item.storageBytes)} extra storage
                    </div>

                    <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                      {formatMoney(item.priceCents, item.currency)}
                    </div>

                    <div className="mt-1 text-[0.80rem] text-[#7a878a]">
                      One-time purchase · {item.workspaceType.toLowerCase()} workspace
                    </div>

                    <div className="mt-4">
                      <Button
                        onClick={() => void startCheckout(item)}
                        disabled={!canCheckoutForTarget || busy}
                        className="w-full rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={{
                          borderColor: "rgba(79,112,107,0.18)",
                          color: "#eef3f1",
                          background:
                            "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                        }}
                      >
                        {busy
                          ? "Creating checkout..."
                          : `Buy with ${selectedProvider === "STRIPE" ? "Stripe" : "PayPal"}`}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-6">
          <div className="mb-2 text-[1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
            Recorded storage add-ons
          </div>

          <div className="text-[0.88rem] leading-[1.7] text-[#5d6d71]">
            This list includes active, pending, canceled, expired, failed, and any
            legacy recurring entries already stored in billing history.
          </div>
        </div>

        {items.length === 0 ? (
          <div className="mt-5 text-[0.94rem] leading-[1.7] text-[#5d6d71]">
            No storage add-ons recorded yet.
          </div>
        ) : (
          <div className="mt-5 grid gap-3">
            {items.map((item) => {
              const tone = toneForAddonStatus(item.status);
              const isRecurring =
                String(item.billingCycle ?? "").trim().toUpperCase() === "MONTHLY";
              const canCancelRecurring =
                isRecurring &&
                (String(item.status ?? "").toUpperCase() === "ACTIVE" ||
                  String(item.status ?? "").toUpperCase() === "PAST_DUE");

              const busy = cancelBusyId === item.id;

              return (
                <div
                  key={item.id}
                  className="rounded-[18px] border px-4 py-4"
                  style={{
                    border: "1px solid rgba(79,112,107,0.10)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[0.96rem] font-semibold text-[#21353a]">
                          {item.addonKey}
                        </div>

                        <div
                          className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                          style={{
                            color: tone.color,
                            background: tone.background,
                            border: tone.border,
                          }}
                        >
                          {formatAddonStatus(item.status)}
                        </div>

                        {isRecurring ? (
                          <div
                            className="rounded-full px-3 py-1.5 text-[0.72rem] font-semibold"
                            style={{
                              color: "#8a6a2b",
                              background: "rgba(201,169,139,0.18)",
                              border: "1px solid rgba(201,169,139,0.22)",
                            }}
                          >
                            Legacy recurring
                          </div>
                        ) : (
                          <div
                            className="rounded-full px-3 py-1.5 text-[0.72rem] font-semibold"
                            style={{
                              color: "#415257",
                              background: "rgba(79,112,107,0.08)",
                              border: "1px solid rgba(79,112,107,0.12)",
                            }}
                          >
                            One-time
                          </div>
                        )}
                      </div>

                      <div className="mt-2 text-[0.85rem] leading-[1.7] text-[#5d6d71]">
                        {item.teamId
                          ? `Team workspace add-on${item.teamName ? ` · ${item.teamName}` : ""}`
                          : "Personal workspace add-on"}
                        {" · "}
                        {item.paymentProvider ?? "Unknown provider"}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#7a878a]">
                        Extra storage: {formatBytesCompact(item.extraStorageBytes)}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#7a878a]">
                        Current period end: {formatDateLabel(item.currentPeriodEnd)}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#7a878a]">
                        Activated: {formatDateLabel(item.activatedAtUtc)}
                      </div>
                    </div>

                    {canCancelRecurring && onCancelRecurring ? (
                      <div className="flex shrink-0 items-start">
                        <Button
                          variant="secondary"
                          onClick={() => onCancelRecurring(item.id)}
                          disabled={busy}
                          className="rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
                          style={{
                            borderColor: "rgba(194,78,78,0.20)",
                            color: "#fff3f3",
                            background:
                              "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
                          }}
                        >
                          {busy ? "Cancelling..." : "Cancel recurring add-on"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}