"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — storage add-ons and billing
 * history.
 *
 * Storage add-ons
 * ---------------------------------------------------------------------------
 * Removed from the panel these replace: a second currency badge, a third
 * workspace target picker, a "Jump to plan checkout" link, two raw
 * `err.message` toasts, and a "Cancel recurring add-on" button wired to a route
 * that could not be reached — it demanded a MONTHLY cycle while nothing in the
 * product could create one.
 *
 * Added: the price is stated as MONTHLY, because that is now what it is; and
 * grandfathered one-time purchases are labelled as such rather than mixed in
 * with recurring ones.
 *
 * Billing history
 * ---------------------------------------------------------------------------
 * NOT "Invoices". PROOVRA has no `Invoice` model, issues no invoice numbers and
 * hosts no invoice PDFs, so an Invoices section would name a document the
 * product does not produce. There is likewise no payment-method card: no
 * provider customer id is stored anywhere, so a card brand and last-4 would be
 * invented.
 *
 * Every row is scoped to the SELECTED account. The list this replaces merged
 * personal and every workspace payment into one array and labelled them by
 * `teamId`, so one payer's spending appeared under another payer's plan.
 */

import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import type {
  BillingAccountProjection,
  BillingHistoryEntry,
} from "../../../../lib/api/billing-accounts";
import { formatDate, formatMoney, statusLabel, statusTone } from "./format";

export function StorageAddonsSection({
  projection,
  onBuy,
  onCancelAddon,
  cancelBusyId,
}: {
  projection: BillingAccountProjection;
  onBuy: () => void;
  onCancelAddon: (addonId: string) => void;
  cancelBusyId: string | null;
}) {
  const addons = projection.storageAddons;
  if (!addons) return null;

  const hasOffers = addons.offers.length > 0;
  const hasActive = addons.active.length > 0;
  if (!hasOffers && !hasActive) return null;

  return (
    <Card
      variant="summary"
      title="Storage add-ons"
      subtitle="Extra capacity, billed monthly alongside your plan."
      headerAction={
        hasOffers ? (
          <Button variant="secondary" size="sm" onClick={onBuy} data-billing-buy-storage>
            Add storage
          </Button>
        ) : null
      }
      data-billing-storage-addons
    >
      {hasActive ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {addons.active.map((addon) => {
            const price = formatMoney(addon.priceCents ?? null, addon.currency ?? null);
            const renews = formatDate(addon.currentPeriodEndUtc);
            return (
              <li
                key={addon.id}
                data-billing-addon={addon.addonKey}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                  background: "var(--surface-muted, #f8fafc)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      color: "var(--text-strong, #172033)",
                    }}
                  >
                    {addon.storageLabel}
                    {price ? (
                      <>
                        {" · "}
                        <bdi>{price}</bdi>
                        {addon.legacyOneTime ? "" : " / month"}
                      </>
                    ) : null}
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: "0.84rem",
                      color: "var(--text-muted, #5F6878)",
                    }}
                  >
                    {addon.legacyOneTime
                      ? // Named honestly: it never renews and it is never taken
                        // away. It is capacity already paid for outright.
                        "One-time purchase from before add-ons became monthly — kept, and never charged again."
                      : renews
                        ? `Renews ${renews}`
                        : "Recurring monthly"}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Badge tone={statusTone(addon.status)} dot>
                    {statusLabel(addon.status)}
                  </Badge>
                  {/* The SERVER decides whether this add-on can be
                      cancelled: it depends on the viewer's capability, on
                      whether the row is a grandfathered one-time purchase,
                      and on the subscription's state. */}
                  {addon.canCancel ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCancelAddon(addon.id)}
                      loading={cancelBusyId === addon.id}
                      disabled={cancelBusyId === addon.id}
                      data-billing-cancel-addon={addon.id}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: "0.9rem",
            lineHeight: 1.65,
            color: "var(--text-muted, #475569)",
          }}
          data-billing-no-addons
        >
          No extra storage yet. Your plan&apos;s included capacity is shown above.
        </p>
      )}
    </Card>
  );
}

export function BillingHistorySection({
  entries,
  state,
  onRetry,
  onRecheck,
  recheckBusy,
}: {
  entries: BillingHistoryEntry[];
  state: "LOADING" | "READY" | "DENIED" | "ERROR";
  onRetry: () => void;
  /**
   * "Re-check my purchases" — the entitlement re-sync.
   *
   * Kept from the section this replaces, because it answers a question a
   * customer really has: a provider confirms a purchase moments after checkout,
   * so returning early shows the old plan. It is safe to repeat — the server
   * recomputes from persisted subscription rows and accepts nothing from the
   * client — and that is said in the copy.
   */
  onRecheck: () => void;
  recheckBusy: boolean;
}) {
  if (state === "DENIED") {
    return (
      <Card variant="summary" title="Billing history" data-billing-history-denied>
        <p
          style={{
            margin: 0,
            fontSize: "0.9rem",
            lineHeight: 1.65,
            color: "var(--text-muted, #475569)",
          }}
        >
          Payment records for this account are visible to its billing owner.
        </p>
      </Card>
    );
  }

  if (state === "ERROR") {
    return (
      <Card variant="summary" title="Billing history" data-billing-history-error>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: "0.9rem",
            color: "var(--text-muted, #475569)",
          }}
        >
          We could not load payment history just now.
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card
      variant="summary"
      title="Billing history"
      subtitle="Just paid and still seeing the old plan? Re-check — nothing is charged again."
      headerAction={
        <Button
          variant="secondary"
          size="sm"
          onClick={onRecheck}
          loading={recheckBusy}
          disabled={recheckBusy}
          data-billing-recheck
        >
          Re-check my purchases
        </Button>
      }
      data-billing-history
    >
      {state === "LOADING" ? (
        <p style={{ margin: 0, color: "var(--text-muted, #5F6878)" }}>Loading…</p>
      ) : entries.length === 0 ? (
        <EmptyState
          compact
          title="No payments yet"
          purpose="Payments for this account will appear here."
        />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {entries.map((entry) => {
            const amount = formatMoney(entry.amountCents, entry.currency);
            const when = formatDate(entry.occurredAtUtc);
            return (
              <li
                key={entry.id}
                data-billing-history-row
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "10px 0",
                  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-strong, #172033)", fontWeight: 500 }}>
                    {entry.description}
                  </div>
                  <div style={{ fontSize: "0.84rem", color: "var(--text-muted, #5F6878)" }}>
                    {when ?? "Date unavailable"}
                    {entry.providerLabel ? ` · ${entry.providerLabel}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {amount ? (
                    <bdi
                      style={{
                        fontWeight: 600,
                        color: "var(--text-strong, #172033)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {amount}
                    </bdi>
                  ) : null}
                  <Badge tone={statusTone(entry.status)} dot>
                    {statusLabel(entry.status)}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
