"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "../ui";
import { Badge, type BadgeTone } from "../ui/Badge";
import { apiFetch } from "../../lib/api";
import { captureException } from "../../lib/sentry";
import { detectCurrency, type SupportedCurrency } from "../../lib/currency";
import { formatUserDate } from "../../lib/date";
import type { WorkspaceStorageAddonSummary } from "./types";

function formatAddonStatus(status?: string | null) {
  // R4 — use the canonical operational vocabulary. The empty/missing
  // case is "Not configured" (operationally neutral). Unmapped
  // backend enums fall back to "Status pending" rather than exposing
  // raw ALL_CAPS values.
  const normalized = String(status ?? "").trim().toUpperCase();
  if (!normalized) return "Not configured";
  if (normalized === "ACTIVE") return "Active";
  if (normalized === "PENDING") return "Pending";
  if (normalized === "PAST_DUE") return "Past due";
  if (normalized === "CANCELED") return "Canceled";
  if (normalized === "EXPIRED") return "Expired";
  if (normalized === "FAILED") return "Failed";
  return "Status pending";
}

// Semantic add-on status → canonical Badge tone. green=active,
// amber=pending/past-due, red=failed/canceled/expired, slate=neutral.
function toneForAddonStatus(status?: string | null): BadgeTone {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "verified";
  if (normalized === "PENDING" || normalized === "PAST_DUE") return "pending";
  if (
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "EXPIRED"
  ) {
    return "risk";
  }
  return "neutral";
}

// Shared pill/segment style — canonical `.cases-filter-chip` active state.
function chipClass(active: boolean): string {
  return ["cases-filter-chip", active ? "is-active" : ""]
    .filter(Boolean)
    .join(" ");
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
  const formatted = formatUserDate(value);
  return formatted === "Not available" ? "—" : formatted;
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
  /** ARCH-001 — the COMMERCIAL shape the server sells this add-on for. */
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
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
          item.billingShape === "SINGLE_OCCUPANT" &&
          String(item.billingCycle ?? "ONE_TIME").toUpperCase() === "ONE_TIME"
      ),
    [catalogItems]
  );

  const teamCatalog = useMemo(
    () =>
      catalogItems.filter(
        (item) =>
          item.billingShape === "SHARED" &&
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
      addToast("Select a workspace first", "error");
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
    <div className="cases-panel" style={{ overflow: "hidden" }}>
      <div className="relative z-10 p-6 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#172033]">
              Storage Add-ons
            </div>

            <div className="text-[0.9rem] leading-[1.7] text-[#475569]">
              Buy extra storage as a <strong>one-time top-up</strong>. Your base
              <strong> PRO</strong> or <strong>TEAM</strong> subscription stays
              unchanged. Legacy recurring entries, if any, are still shown below.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {onBuyMore ? (
              <button
                type="button"
                onClick={() => onBuyMore()}
                className="cases-filter-chip"
              >
                Jump to plan checkout
              </button>
            ) : null}

            <Badge tone="neutral" data-storage-preferred-currency>
              Preferred currency: {preferredCurrency}
            </Badge>
          </div>
        </div>

        <div className="cases-inner mt-5 px-4 py-4">
          <div className="mb-3 text-[0.84rem] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
            Buy extra storage now
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={chipClass(targetType === "PERSONAL")}
              onClick={() => setTargetType("PERSONAL")}
            >
              Personal workspace
            </button>

            <button
              type="button"
              className={chipClass(targetType === "TEAM")}
              onClick={() => setTargetType("TEAM")}
              disabled={teamOptions.length === 0}
            >
              Workspace
            </button>
          </div>

          {targetType === "TEAM" ? (
            <div className="mt-3">
              {teamOptions.length === 0 ? (
                <div className="text-[0.88rem] leading-[1.7] text-[#B23442]">
                  No owned workspace found yet. Create a workspace first, then
                  come back to purchase TEAM storage or start a TEAM subscription.
                </div>
              ) : (
                <select
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  className="cases-form-input"
                  style={{ padding: "12px 14px", fontSize: 14 }}
                >
                  <option value="">Select workspace...</option>
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
            <div className="mb-2 text-[0.82rem] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Payment method
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={chipClass(selectedProvider === "STRIPE")}
                onClick={() => setSelectedProvider("STRIPE")}
              >
                Card / Stripe
              </button>

              <button
                type="button"
                className={chipClass(selectedProvider === "PAYPAL")}
                onClick={() => setSelectedProvider("PAYPAL")}
              >
                PayPal
              </button>
            </div>
          </div>

          <div className="mt-4 text-[0.86rem] leading-[1.75] text-[#475569]">
            Storage add-ons are processed as <strong>one-time purchases</strong>.
            They do <strong>not</strong> create a second monthly subscription for
            storage.
          </div>

          {catalogLoading ? (
            <div className="mt-4 text-[0.9rem] leading-[1.7] text-[#475569]">
              Loading available storage offers...
            </div>
          ) : catalogError ? (
            <div
              className="cases-inner mt-4 px-4 py-4 text-[0.9rem] leading-[1.7]"
              role="alert"
              style={{ color: "#991b1b" }}
            >
              {catalogError}
            </div>
          ) : visibleCatalog.length === 0 ? (
            <div className="mt-4 text-[0.9rem] leading-[1.7] text-[#475569]">
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
                    className="cases-inner px-4 py-4"
                  >
                    <div className="text-[0.96rem] font-semibold text-[#172033]">
                      {item.label}
                    </div>

                    <div className="mt-1 text-[0.86rem] text-[#475569]">
                      {formatBytesCompact(item.storageBytes)} extra storage
                    </div>

                    <div className="mt-1 text-[0.86rem] text-[#475569]">
                      {formatMoney(item.priceCents, item.currency)}
                    </div>

                    <div className="mt-1 text-[0.80rem] text-[#5F6878]">
                      One-time purchase ·{" "}
                      {item.billingShape === "SINGLE_OCCUPANT"
                        ? "Personal Space"
                        : "shared workspace"}
                    </div>

                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => void startCheckout(item)}
                        disabled={!canCheckoutForTarget || busy}
                        className="app-header-primary-action"
                        style={{ width: "100%" }}
                      >
                        <span>
                          {busy
                            ? "Creating checkout..."
                            : `Buy with ${selectedProvider === "STRIPE" ? "Stripe" : "PayPal"}`}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-6">
          <div className="mb-2 text-[1rem] font-semibold tracking-[-0.02em] text-[#172033]">
            Recorded storage add-ons
          </div>

          <div className="text-[0.88rem] leading-[1.7] text-[#475569]">
            This list includes active, pending, canceled, expired, failed, and any
            legacy recurring entries already stored in billing history.
          </div>
        </div>

        {items.length === 0 ? (
          <div className="cases-empty mt-5" data-storage-addons-empty>
            <strong>No storage add-ons yet</strong>
            <p>One-time storage top-ups you purchase will be listed here.</p>
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
                <div key={item.id} className="cases-inner px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[0.96rem] font-semibold text-[#172033]">
                          {item.addonKey}
                        </div>

                        <Badge tone={tone} data-addon-status>
                          {formatAddonStatus(item.status)}
                        </Badge>

                        {isRecurring ? (
                          <Badge tone="pending" subtle data-addon-cycle="recurring">
                            Legacy recurring
                          </Badge>
                        ) : (
                          <Badge tone="neutral" subtle data-addon-cycle="one-time">
                            One-time
                          </Badge>
                        )}
                      </div>

                      <div className="mt-2 text-[0.85rem] leading-[1.7] text-[#475569]">
                        {item.teamId
                          ? `Workspace add-on${item.teamName ? ` · ${item.teamName}` : ""}`
                          : "Personal workspace add-on"}
                        {" · "}
                        {item.paymentProvider ?? "Unknown provider"}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#5F6878]">
                        Extra storage: {formatBytesCompact(item.extraStorageBytes)}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#5F6878]">
                        Current period end: {formatDateLabel(item.currentPeriodEnd)}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#5F6878]">
                        Activated: {formatDateLabel(item.activatedAtUtc)}
                      </div>
                    </div>

                    {canCancelRecurring && onCancelRecurring ? (
                      <div className="flex shrink-0 items-start">
                        <button
                          type="button"
                          onClick={() => onCancelRecurring(item.id)}
                          disabled={busy}
                          className="cases-remove-action"
                        >
                          {busy ? "Cancelling..." : "Cancel recurring add-on"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}