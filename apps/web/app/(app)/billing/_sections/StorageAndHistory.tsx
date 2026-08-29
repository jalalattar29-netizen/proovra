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
  onChoosePlan,
  onCancelAddon,
  cancelBusyId,
}: {
  projection: BillingAccountProjection;
  /**
   * Buy ONE named capacity. The offer is chosen on the PAGE and the drawer
   * opens on it already selected — a customer who has read three prices and
   * picked one should not be asked to pick again.
   */
  onBuy: (addonKey: string) => void;
  /**
   * Opens the ONE plan chooser — the same surface the plan card opens.
   *
   * FREE has no add-on catalogue, and pressing "Add storage" there used to
   * open a purchase drawer with an empty "Capacity" heading, a payment method
   * and a dead button. Storage on FREE is a PLAN question, so it is answered
   * with the plan chooser.
   */
  onChoosePlan: () => void;
  onCancelAddon: (addonId: string) => void;
  cancelBusyId: string | null;
}) {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — when add-ons are not
  // available, say why and offer the move that changes it, rather than
  // rendering nothing and leaving the customer to guess whether the feature is
  // missing, broken, or simply not theirs.
  // When add-ons are not available, say why and offer the move that changes
  // it, rather than rendering nothing and leaving the customer to guess
  // whether the feature is missing, broken, or simply not theirs.
  const locked = projection.storageAddonsLocked;
  const meter = projection.usage.storage;
  if (locked) {
    return (
      <Card variant="summary" title="Storage" data-billing-storage-locked>
        <div className="bill-storage-upgrade">
          <div className="bill-storage-upgrade__facts">
            {meter.state === "MEASURED" ? (
              <div className="bill-storage-upgrade__included">
                <bdi>{meter.limitLabel}</bdi> included
              </div>
            ) : null}
            <p className="bill-storage-upgrade__copy">{locked.reason}</p>
          </div>
          {locked.unlockedByPlan ? (
            <div className="bill-actions">
              {/*
                The PLAN chooser, not a purchase drawer. This used to open the
                storage checkout, which on FREE has no offers in it — the page
                told a customer to upgrade and then showed them an empty
                "Capacity" section above a payment button that could not be
                pressed.
              */}
              <Button
                variant="primary"
                size="sm"
                onClick={onChoosePlan}
                data-billing-storage-upgrade
              >
                Choose a plan
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    );
  }

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
      data-billing-storage-addons
    >
      {/*
        The OFFERS are on the page, not behind a button.

        "Add storage" opened a drawer whose only content was the list of
        capacities and their prices — so the one thing a customer needed in
        order to decide was the one thing they had to open something to see.
        The prices are the server's, the cards are the page's, and pressing one
        opens the confirmation with that capacity already chosen.
      */}
      {hasOffers ? (
        <div className="bill-offer-grid" data-billing-storage-offers>
          {addons.offers.map((offer) => {
            const price = formatMoney(offer.priceCents, offer.currency);
            return (
              <div
                key={offer.key}
                className="bill-offer"
                data-billing-storage-offer={offer.key}
              >
                <div className="bill-offer__capacity">
                  <bdi>{offer.storageLabel}</bdi>
                </div>
                {/*
                  The WHOLE phrase is isolated, not just the amount: in an RTL
                  paragraph "US$59.99 / month" reorders to "month / US$59.99"
                  unless the run is kept together.
                */}
                {price ? (
                  <bdi className="bill-offer__price">
                    {price}
                    <span className="bill-offer__cadence"> / month</span>
                  </bdi>
                ) : null}
                <div className="bill-offer__cadence">Billed monthly</div>
                <div className="bill-actions bill-offer__action">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => onBuy(offer.key)}
                    data-billing-buy-storage={offer.key}
                  >
                    Add storage
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {hasActive ? (
        <ul
          className="bill-active-addons"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
        >
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

                <div className="bill-actions">
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
  onRecheckPayment,
  onCancelPayment,
  onAbandonPayment,
  rowBusyId,
  resumeUrls,
}: {
  entries: BillingHistoryEntry[];
  state: "LOADING" | "READY" | "DENIED" | "ERROR";
  onRetry: () => void;
  /**
   * "Re-check purchases and billing" — REAL provider reconciliation.
   *
   * BILLING RECONCILIATION (2026-08-27) — the label promises a provider check
   * again, because the action now performs one. Its two previous names were
   * both accurate at the time: "Re-check my purchases" over-promised against a
   * local re-read, so it became "Refresh billing status"; the server now asks
   * Stripe or PayPal about the bindings it stored for the selected account, so
   * the promise is true again.
   *
   * The request names the ACCOUNT and nothing else — no session, no
   * subscription, no amount — so it cannot reach another customer's purchase.
   */
  onRecheck: () => void;
  recheckBusy: boolean;
  /**
   * BILLING SURFACE CORRECTION (2026-08-29) — ONE row's own actions.
   *
   * Separate from the account-wide re-check above, which sweeps every binding.
   * A customer looking at a single stuck "Pending" line wants to know about
   * THAT line, and the account sweep's summary counts cannot tell them.
   */
  onRecheckPayment: (entry: BillingHistoryEntry) => void;
  onCancelPayment: (entry: BillingHistoryEntry) => void;
  /**
   * Give up on a checkout the provider cannot be asked to stop.
   *
   * Offered INSTEAD of cancellation, never beside it: a provider that can
   * really be asked to stop is asked.
   */
  onAbandonPayment: (entry: BillingHistoryEntry) => void;
  /** The row currently talking to the provider, if any. */
  rowBusyId: string | null;
  /**
   * Resume links learned from a re-check, by payment id.
   *
   * Not part of the history payload: a continuation URL is only valid while
   * the provider still holds the flow open, so it is only ever known for as
   * long as the answer that produced it is fresh.
   */
  resumeUrls: Record<string, string>;
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
      subtitle="Checks your payment provider for anything we have not recorded on this account. Nothing is charged again."
      headerAction={
        <Button
          variant="secondary"
          size="sm"
          onClick={onRecheck}
          loading={recheckBusy}
          disabled={recheckBusy}
          data-billing-recheck
        >
          Re-check purchases and billing
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
        /*
          BILLING SURFACE CORRECTION (2026-08-29) — history is a TABLE.

          It was a flex list whose every row rendered "description · date ·
          provider" as one run of text with the amount and a status pill
          pushed to the far edge. At 390px the description wrapped under the
          date, the amount landed beside a status word it did not belong to,
          and there was nowhere for a row's actions to go.

          This is the canonical `app-table[data-responsive]`, which is a real
          table with real column headers on a wide screen and stacked labelled
          cards below 720px. It is not a Billing table: it is the same surface
          the rest of the product lists records in.
        */
        <div className="app-table-surface app-table-surface--scroll">
          <table className="app-table" data-responsive data-billing-history-table>
            <thead>
              <tr>
                <th scope="col">Payment</th>
                <th scope="col">Method</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">
                  {/* The actions column has no useful label, and an empty
                      header is announced as such rather than guessed at. */}
                  <span className="app-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const amount = formatMoney(entry.amountCents, entry.currency);
                const when = formatDate(entry.occurredAtUtc);
                const resumeUrl = resumeUrls[entry.id] ?? null;
                const busy = rowBusyId === entry.id;
                /*
                  A pending payment the provider has just told us is still
                  open, and where, is not simply "Pending" — it is waiting for
                  the customer. The word changes with the fact; the underlying
                  status does not, because nothing about the payment changed.
                */
                const awaitingCustomer =
                  resumeUrl !== null && entry.status.toUpperCase() === "PENDING";

                return (
                  <tr key={entry.id} data-billing-history-row>
                    <td data-label="Payment">
                      <div className="bill-history__what">
                        <span className="app-table__primary">
                          {entry.description}
                        </span>
                        <span className="bill-history__when">
                          {when ?? "Date unavailable"}
                        </span>
                      </div>
                    </td>
                    <td data-label="Method" className="app-table__muted">
                      {entry.providerLabel ?? "—"}
                    </td>
                    <td data-label="Amount">
                      {amount ? (
                        <bdi className="bill-history__amount">{amount}</bdi>
                      ) : (
                        <span className="app-table__muted">—</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <Badge
                        tone={
                          awaitingCustomer ? "pending" : statusTone(entry.status)
                        }
                        dot
                      >
                        {awaitingCustomer
                          ? "Action needed"
                          : statusLabel(entry.status)}
                      </Badge>
                    </td>
                    <td data-label="">
                      <div className="bill-history__actions">
                        {resumeUrl ? (
                          <a
                            href={resumeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bill-resume-link"
                            data-billing-payment-resume
                          >
                            Resume payment
                          </a>
                        ) : null}
                        {entry.actions?.canRecheck ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onRecheckPayment(entry)}
                            loading={busy}
                            disabled={busy}
                            data-billing-payment-recheck={entry.id}
                          >
                            Re-check
                          </Button>
                        ) : null}
                        {entry.actions?.canCancel ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onCancelPayment(entry)}
                            disabled={busy}
                            data-billing-payment-cancel={entry.id}
                          >
                            Cancel payment
                          </Button>
                        ) : null}
                        {entry.actions?.canAbandon ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onAbandonPayment(entry)}
                            disabled={busy}
                            data-billing-payment-abandon={entry.id}
                          >
                            {/*
                              NOT "Cancel payment". PayPal has no operation
                              that cancels an unapproved order, and a button
                              claiming otherwise would be telling a customer
                              their provider had stopped something it had not.
                              This is the customer's own decision, and the
                              words say whose it is.
                            */}
                            Abandon payment attempt
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
