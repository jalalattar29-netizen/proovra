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
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import type { AppTone } from "../../../../components/app-primitives/AppStatusBadge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import type {
  BillingAccountProjection,
  BillingHistoryEntry,
} from "../../../../lib/api/billing-accounts";
import { formatDate, formatMoney, statusLabel, statusTone } from "./format";

/**
 * The billing tone vocabulary, said in the app-primitive vocabulary.
 *
 * `statusTone` returns the Badge tones this page has always used; the
 * canonical text primitive reads `AppTone`. This maps one onto the other and
 * changes no meaning: succeeded stays success, pending stays the product's
 * "needs attention" amber, failed stays error, abandoned stays neutral.
 */
function toStatusTextTone(
  tone: "verified" | "pending" | "risk" | "neutral",
): AppTone {
  if (tone === "verified") return "green";
  if (tone === "pending") return "amber";
  if (tone === "risk") return "red";
  return "slate";
}

export function StorageAddonsSection({
  projection,
  onManageStorage,
  onChoosePlan,
  onCancelAddon,
  cancelBusyId,
}: {
  projection: BillingAccountProjection;
  /**
   * ONE entry point into the capacity catalogue.
   *
   * What this replaces: an offer card per capacity, each with its own "Add
   * storage" button — three buttons calling one handler, so the page asked the
   * customer to choose twice and looked like three different purchases.
   */
  onManageStorage: () => void;
  /**
   * FREE has no add-on catalogue, so its card offers the PLAN chooser rather
   * than a purchase drawer with an empty "Capacity" section and a dead button.
   */
  onChoosePlan: () => void;
  onCancelAddon: (addonId: string) => void;
  cancelBusyId: string | null;
}) {
  const meter = projection.usage.storage;
  const locked = projection.storageAddonsLocked;

  if (locked) {
    return (
      <section className="bill-panel" data-billing-storage-locked>
        <h3 className="bill-panel__title">Storage</h3>
        {/* One isolated run: "0 B of 100 GB" reorders to "100 GB of 0 B" in an
            RTL paragraph when only the numbers are isolated. */}
        {meter.state === "MEASURED" ? (
          <p className="bill-panel__lead">
            <bdi>{`${meter.usedLabel} of ${meter.limitLabel} used`}</bdi>
          </p>
        ) : null}
        <p className="bill-panel__note">{locked.reason}</p>
        {locked.unlockedByPlan ? (
          <div className="bill-panel__actions">
            <Button
              /*
               * "View plans", not "Add storage" or "Manage storage".
               *
               * This button does not open the capacity catalogue and must not
               * pretend to: FREE cannot buy a recurring storage add-on at all,
               * so the destination is the plan chooser and the label says so.
               * A customer who presses "Add storage" and lands on a list of
               * plans has been told something untrue about their own account.
               *
               * It stays SECONDARY. Storage is not the page's primary action —
               * the plan action in the overview is — and two primaries beside
               * each other is how the overview stopped reading as one
               * decision.
               */
              variant="secondary"
              size="sm"
              className="bill-secondary-action"
              onClick={onChoosePlan}
              data-billing-storage-upgrade
            >
              View plans
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  const addons = projection.storageAddons;
  if (!addons) return null;

  const hasOffers = addons.offers.length > 0;
  const hasActive = addons.active.length > 0;
  if (!hasOffers && !hasActive) return null;

  return (
    <section className="bill-panel" data-billing-storage-addons>
      <h3 className="bill-panel__title">Storage</h3>

      {/* What the account HAS, before what it could buy. */}
      {meter.state === "MEASURED" ? (
        <>
          {/* One isolated run: "0 B of 100 GB" reorders to "100 GB of 0 B"
              in an RTL paragraph when only the numbers are isolated. */}
          <p className="bill-panel__lead">
            <bdi>{`${meter.usedLabel} of ${meter.limitLabel}`}</bdi>
          </p>
          <dl className="bill-facts">
            <div className="bill-facts__row">
              <dt className="bill-facts__label">Included with your plan</dt>
              <dd className="bill-facts__value">
                <bdi>{meter.baseLabel}</bdi>
              </dd>
            </div>
            {meter.recurringAddonBytes !== "0" ? (
              <div className="bill-facts__row">
                <dt className="bill-facts__label">Add-ons</dt>
                <dd className="bill-facts__value">
                  <bdi>{meter.recurringAddonLabel}</bdi>
                </dd>
              </div>
            ) : null}
            {meter.legacyAddonBytes !== "0" ? (
              <div className="bill-facts__row">
                <dt className="bill-facts__label">Kept from earlier purchases</dt>
                <dd className="bill-facts__value">
                  <bdi>{meter.legacyAddonLabel}</bdi>
                </dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : null}

      {/* The ACTIVE add-ons, each with the action the server allows on it. */}
      {hasActive ? (
        <ul className="bill-addon-list">
          {addons.active.map((addon) => {
            const price = formatMoney(addon.priceCents ?? null, addon.currency ?? null);
            const renews = formatDate(addon.currentPeriodEndUtc);
            return (
              <li
                key={addon.id}
                className="bill-addon"
                data-billing-addon={addon.addonKey}
              >
                <div className="bill-addon__facts">
                  <span className="bill-addon__size">
                    <bdi>{addon.storageLabel}</bdi>
                    {price ? (
                      <>
                        {" · "}
                        <bdi>
                          {price}
                          {addon.legacyOneTime ? "" : " / month"}
                        </bdi>
                      </>
                    ) : null}
                  </span>
                  <span className="bill-addon__meta">
                    {addon.legacyOneTime
                      ? // Named honestly: it never renews and it is never taken
                        // away. It is capacity already paid for outright.
                        "One-time purchase from before add-ons became monthly — kept, and never charged again."
                      : renews
                        ? `Renews ${renews}`
                        : "Recurring monthly"}
                  </span>
                </div>
                <div className="bill-addon__actions">
                  <Badge tone={statusTone(addon.status)} dot>
                    {statusLabel(addon.status)}
                  </Badge>
                  {/* The SERVER decides whether this add-on can be cancelled:
                      it depends on the viewer's capability, on whether the row
                      is a grandfathered one-time purchase, and on the
                      subscription's state. */}
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
      ) : null}

      {hasOffers ? (
        <div className="bill-panel__actions">
          {/*
            ONE button into ONE selection flow. The capacities and their prices
            are shown inside it, where the choice is made — rather than as
            three cards each carrying its own button that called this same
            handler.
          */}
          <Button
            /*
             * The SAME treatment as "Buy credits" in the card beside it.
             *
             * These two are the same act — a purchase entry point on an
             * allowance card — and they sit in one row, so painting one a
             * filled violet and the other white made the row read as a main
             * card and an afterthought. The page's single filled CTA is the
             * plan action in the overview above.
             */
            variant="secondary"
            size="sm"
            className="bill-secondary-action"
            onClick={onManageStorage}
            data-billing-manage-storage
          >
            {hasActive ? "Manage storage" : "Add storage"}
          </Button>
        </div>
      ) : null}

      {!hasActive && !hasOffers ? (
        <p className="bill-panel__note" data-billing-no-addons>
          No extra storage yet.
        </p>
      ) : null}
    </section>
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
          className="bill-secondary-action"
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
                      {/* WORDS, NOT A CAPSULE.
                          A filled pill per row turned the status column into a
                          column of shapes: down twenty rows the capsule becomes
                          the pattern and the word inside it stops being read.
                          `AppStatusText` is the canonical no-surface sibling of
                          `AppStatusBadge` and shares its tone vocabulary, so
                          what each colour MEANS is unchanged — pending is the
                          same amber the rest of the product uses for "needs
                          attention", and no new colour is introduced here. */}
                      <AppStatusText
                        tone={toStatusTextTone(
                          awaitingCustomer ? "pending" : statusTone(entry.status),
                        )}
                        data-billing-history-status={
                          awaitingCustomer ? "ACTION_NEEDED" : entry.status
                        }
                      >
                        {awaitingCustomer
                          ? "Action needed"
                          : statusLabel(entry.status)}
                      </AppStatusText>
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
                            className="bill-secondary-action"
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
