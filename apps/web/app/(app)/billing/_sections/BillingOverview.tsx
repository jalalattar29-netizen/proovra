"use client";

/**
 * THE BILLING OVERVIEW — one panel that answers the page's question.
 *
 * WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * Four full-width white cards stacked down the page: a plan card, a "Usage and
 * limits" card whose three columns held one line each beside a paragraph, a
 * "Workspaces and teams" card carrying a single "0 of 2", and a credits card
 * carrying a single number. Each was the width of the page and the height of a
 * paragraph, so the page was tall, the density was almost nil, and nothing on
 * it was more important than anything else.
 *
 * They are one panel now, because they are one answer: what am I on, what does
 * it cost, what have I used, and what can I do about it. The tier and its
 * status lead; the three meters sit beside them as facts rather than as
 * sections; the single management action is where the eye finishes.
 *
 * WHAT THE BROWSER DECIDES HERE
 * ---------------------------------------------------------------------------
 * Nothing. Every figure is a server projection rendered as given, every label
 * is the server's, and a value the server could not measure is ABSENT rather
 * than rendered as a zero — "we do not know" and "none" are different
 * statements and only one of them is ever true.
 */

import { Button } from "../../../../components/ui/Button";
import {
  AppStatusText,
  type AppTone,
} from "../../../../components/app-primitives";
import type { BillingAccountProjection } from "../../../../lib/api/billing-accounts";
import {
  describeEvidenceAdmission,
  describeMeter,
  formatDate,
  formatMoney,
  presentLifecycle,
} from "./format";

/** A meter reduced to what fits beside two others. */
type Metric = {
  label: string;
  value: string;
  /** One short line. Never a paragraph — the detail lives below. */
  note: string | null;
  /** 0..1, or null where there is no denominator to fill. */
  ratio: number | null;
  tone: "neutral" | "pending";
};

/**
 * Billing's lifecycle vocabulary → the product's canonical tone vocabulary.
 *
 * Billing says "verified / pending / risk / info / neutral" because that is
 * what its own meters and badges have always said. `AppStatusText` reads the
 * product-wide `AppTone`. Mapping here, in one place, is what lets the status
 * be the SAME colour as every other status in PROOVRA without Billing having
 * to rename a vocabulary its other surfaces still use.
 */
function statusTone(tone: "verified" | "pending" | "risk" | "neutral" | "info"): AppTone {
  switch (tone) {
    case "verified":
      return "green";
    case "pending":
      return "amber";
    case "risk":
      return "red";
    case "info":
      return "blue";
    default:
      // Slate is the product's fallback for an unmapped or neutral state, and
      // is a real declaration rather than whatever the base happens to paint.
      return "slate";
  }
}

export function BillingOverview({
  projection,
  onManagePlan,
  onStartSubscription,
  changeBusyPlan,
}: {
  projection: BillingAccountProjection;
  onManagePlan: () => void;
  /**
   * Open a NEW-subscription checkout on the given tier.
   *
   * Optional so a surface that has no checkout to open simply does not render
   * the action, rather than rendering a button that does nothing.
   */
  onStartSubscription?: (planKey: "PRO" | "TEAM") => void;
  changeBusyPlan: string | null;
}) {
  const { plan, account, actions, contract } = projection;
  const lifecycle = presentLifecycle(plan.lifecycle, {
    periodEndUtc: plan.currentPeriodEndUtc,
    graceEndsAtUtc: plan.graceEndsAtUtc,
  });
  const price = formatMoney(plan.priceCents ?? null, plan.currency ?? null);
  const periodEnd = formatDate(plan.currentPeriodEndUtc);

  /*
   * HOW the account is on this tier decides what may be said about money.
   *
   * A GRANTED tier is real access with no billing relationship, and the page
   * used to describe it as "Billed monthly · $19.00 per month" with a renewal
   * date, because the projection fell back to the catalogue price whenever a
   * paid tier had no subscription row. There is nothing to renew, nothing is
   * charged, and there is nothing for a provider to cancel.
   */
  const cadence =
    plan.accessKind === "SUBSCRIPTION"
      ? "Billed monthly"
      : plan.accessKind === "GRANTED"
        ? "Granted access — no active billing subscription"
        : plan.accessKind === "CONTRACT"
          ? "Billed by agreement"
          : plan.accessKind === "CREDIT"
            ? "Pay per evidence record"
            : "No subscription";

  const metrics = buildMetrics(projection);

  return (
    <section className="bill-overview" data-billing-overview>
      <header className="bill-overview__head">
        <div className="bill-overview__identity">
          <span className="bill-overview__eyebrow">Current plan</span>
          <h2 className="bill-overview__plan" data-billing-plan-name>
            {contract
              ? "Enterprise agreement"
              : plan.accessKind === "GRANTED"
                ? `${plan.displayName} access`
                : plan.displayName}
          </h2>
          <p className="bill-overview__meta">
            <bdi>{account.displayName}</bdi> · {cadence}
          </p>
        </div>

        <div className="bill-overview__commercials">
          {/* A price is only ever rendered for a real subscription: the
              server does not send one otherwise, and a figure a surface has
              been handed is a figure it will show. */}
          {price ? (
            <p className="bill-overview__price">
              <bdi className="bill-overview__amount">{price}</bdi>
              <span className="bill-overview__cadence"> / month</span>
            </p>
          ) : plan.accessKind === "FREE" ? (
            <p className="bill-overview__price">
              <bdi className="bill-overview__amount">
                {formatMoney(0, plan.currency ?? null) ?? "0"}
              </bdi>
            </p>
          ) : null}

          {/*
            BILLING UI REFINEMENT (2026-09-01) — the capsule is gone.

            "Trial" sat in a bordered, shadowed pill beside a plan name and a
            price, which gave a passive FACT the visual weight of a control —
            and on a card whose whole job is "what am I on, and what can I do
            about it", the one thing that was not a button looked the most like
            one.

            `AppStatusText` is the product's canonical no-capsule status: the
            SAME tone vocabulary as `AppStatusBadge`, so a surface chooses how
            a state looks without being able to change what its colour means.
            Reused rather than restyled locally, which is how the capsule came
            to differ from every other status in the product in the first place.
          */}
          <AppStatusText
            tone={statusTone(lifecycle.tone)}
            size="md"
            data-billing-plan-status=""
            data-tone-source={lifecycle.tone}
          >
            {lifecycle.label}
          </AppStatusText>
        </div>

        <div className="bill-overview__action">
          {/*
            ONE action, named by the server.

            FREE chooses, a real subscription is managed, a granted tier is
            explained, an agreement is viewed. The card used to render a button
            per plan offer, which is how a FREE account came to face "Subscribe
            to Pro" beside "Subscribe to Team" — both opening the same drawer.
          */}
          <Button
            variant="primary"
            size="md"
            onClick={onManagePlan}
            disabled={!actions.planManagement.enabled || changeBusyPlan !== null}
            data-billing-plan-management={actions.planManagement.mode}
          >
            {actions.planManagement.label}
          </Button>

          {/*
            The SECOND action, and only where the server composed one.

            A granted PRO account's first action is "View access details",
            which is truthful and buys nothing — so a customer who outgrew the
            tier they were given had nowhere to go. This is the way out, and it
            is a PURCHASE: it opens a new-subscription checkout for the tier
            the server named, never the plan-transition route, because there is
            no provider subscription to transition.

            The page does not work out that granted PRO can buy TEAM. It is
            handed a plan key and a label.
          */}
          {actions.secondaryPlanAction && onStartSubscription ? (
            <button
              type="button"
              className="app-secondary-action app-secondary-action--lg"
              onClick={() =>
                onStartSubscription(actions.secondaryPlanAction!.planKey)
              }
              disabled={!actions.planManagement.enabled || changeBusyPlan !== null}
              data-billing-start-subscription={actions.secondaryPlanAction.planKey}
            >
              {actions.secondaryPlanAction.label}
            </button>
          ) : null}
        </div>
      </header>

      {/* The dates and promises that qualify everything above, on one line
          each, and only when the server gave them. */}
      {(periodEnd && plan.accessKind === "SUBSCRIPTION") ||
      plan.scheduledChange ||
      (lifecycle.detail && plan.lifecycle !== "PAST_DUE") ? (
        <div className="bill-overview__notes">
          {periodEnd && plan.accessKind === "SUBSCRIPTION" ? (
            <p className="bill-overview__note">
              {plan.cancelAtPeriodEnd
                ? `Cancels on ${periodEnd} — you keep ${plan.displayName} until then.`
                : `Renews on ${periodEnd}.`}
            </p>
          ) : null}
          {plan.scheduledChange ? (
            <p className="bill-overview__note" data-billing-scheduled-change>
              {plan.scheduledChange.effectiveAtUtc
                ? `Moving to ${plan.scheduledChange.displayName} on ${formatDate(
                    plan.scheduledChange.effectiveAtUtc,
                  )}. You keep everything you have now until then.`
                : `Moving to ${plan.scheduledChange.displayName} at the end of this billing period. You keep everything you have now until then.`}
            </p>
          ) : null}
          {lifecycle.detail && plan.lifecycle !== "PAST_DUE" ? (
            <p className="bill-overview__note">{lifecycle.detail}</p>
          ) : null}
        </div>
      ) : null}

      <dl className="bill-metrics" data-billing-metrics>
        {metrics.map((m) => (
          <div className="bill-metric" key={m.label} data-billing-metric={m.label}>
            <dt className="bill-metric__label">{m.label}</dt>
            <dd className="bill-metric__value">
              <bdi>{m.value}</bdi>
            </dd>
            {/*
              BILLING UI REFINEMENT (2026-09-01) — the track is rendered for
              EVERY metric, not only the ones with a number behind them.

              "AI operations — Not included" had no track, so the three meters
              did not line up and the row read as two measurements and a
              leftover. The absence was not saying anything either: a customer
              cannot tell a metric with no track from one that failed to load.

              What changes with the state is the FILL and what is announced,
              never whether the track exists:

                measured    a real percentage, clamped so a bar cannot render
                            past its track while the VALUE above still states
                            the true overage
                unmeasured  an empty track and no `progressbar` role at all —
                            a progressbar with no value is a lie in the
                            accessibility tree, so the muted rail is left as
                            the decoration it is and the WORDS carry the state
            */}
            {m.ratio !== null ? (
              <div
                className="bill-metric__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(m.ratio * 100)}
                aria-label={`${m.label}: ${m.value}`}
              >
                <span
                  className="bill-metric__fill"
                  data-tone={m.tone}
                  style={{ width: `${Math.min(100, Math.round(m.ratio * 100))}%` }}
                />
              </div>
            ) : (
              <div
                className="bill-metric__track"
                data-billing-metric-track="empty"
                aria-hidden="true"
              />
            )}
            {m.note ? <p className="bill-metric__note">{m.note}</p> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The three meters, each reduced to a label, a value and ONE line.
 *
 * The card this replaces put a four-line explanation under the Evidence bar
 * while the two columns beside it held a single line each — so the row was as
 * tall as its longest paragraph and read as one column with two empty ones.
 * The explanation now lives in the Evidence detail panel, where there is room
 * for it; what belongs here is the number.
 */
function buildMetrics(projection: BillingAccountProjection): Metric[] {
  const out: Metric[] = [];

  const evidence = projection.usage.evidence;
  const admission = projection.evidenceAdmission;
  if (evidence.state === "MEASURED") {
    const over =
      evidence.limit !== null && evidence.used > evidence.limit
        ? evidence.used - evidence.limit
        : 0;
    out.push({
      label: "Evidence",
      /*
       * OVER the allowance, the count stands alone.
       *
       * "176 of 127" reads as a broken counter, and the first thing anyone
       * does with it is stop trusting the page. It is not broken — holding
       * more than the allowance is a real and legitimate state — but a ratio
       * is the wrong shape for saying so. The count is the fact; how far past
       * the limit it is goes on the line below, and the full breakdown (what
       * the plan includes, what this account is allowed) is in the Evidence
       * panel, which has room for it.
       */
      value:
        evidence.limit === null || over > 0
          ? `${evidence.used.toLocaleString()} records`
          : `${evidence.used.toLocaleString()} of ${evidence.limit.toLocaleString()}`,
      note:
        over > 0
          ? `${over.toLocaleString()} above the ${evidence.limit!.toLocaleString()} limit`
          : evidence.window === "ROLLING_30_DAYS"
            ? "In the last 30 days"
            : evidence.window === "CALENDAR_MONTH"
              ? "This month"
              : "Lifetime",
      ratio:
        evidence.limit === null || evidence.limit === 0
          ? null
          : evidence.used / evidence.limit,
      tone: over > 0 || (admission && !admission.next.allowed) ? "pending" : "neutral",
    });
  } else if (evidence.state === "CONTRACT_MANAGED") {
    out.push({
      label: "Evidence",
      value: "Contract-defined",
      note: "Your agreement sets this allowance.",
      ratio: null,
      tone: "neutral",
    });
  } else if (evidence.state === "NOT_INCLUDED") {
    out.push({
      label: "Evidence",
      value: "Not included",
      note: null,
      ratio: null,
      tone: "neutral",
    });
  } else {
    // UNAVAILABLE. Deliberately not a zero: an unreadable value is not a
    // used-nothing value.
    out.push({
      label: "Evidence",
      value: "Not available",
      note: evidence.reason,
      ratio: null,
      tone: "neutral",
    });
  }

  const storage = projection.usage.storage;
  out.push(
    storage.state === "MEASURED"
      ? {
          label: "Storage",
          value: `${storage.usedLabel} of ${storage.limitLabel}`,
          // A label the projection did not send is ABSENT, never the word
          // "undefined" next to the word "included".
          note: !storage.baseLabel
            ? null
            : storage.recurringAddonBytes !== "0" && storage.recurringAddonLabel
              ? `${storage.baseLabel} included · ${storage.recurringAddonLabel} added`
              : `${storage.baseLabel} included`,
          ratio: storage.usagePercent / 100,
          tone: storage.nearLimit || storage.limitReached ? "pending" : "neutral",
        }
      : {
          label: "Storage",
          value: "Not available",
          note: storage.reason,
          ratio: null,
          tone: "neutral",
        },
  );

  const ai = projection.usage.ai;
  out.push(
    ai.state === "MEASURED"
      ? {
          label: "AI operations",
          value:
            ai.limit === null
              ? `${ai.used.toLocaleString()}`
              : `${ai.used.toLocaleString()} of ${ai.limit.toLocaleString()}`,
          note: ai.window === "CALENDAR_MONTH" ? "Resets each month" : null,
          ratio: ai.limit === null || ai.limit === 0 ? null : ai.used / ai.limit,
          tone: ai.limit !== null && ai.used >= ai.limit ? "pending" : "neutral",
        }
      : ai.state === "CONTRACT_MANAGED"
        ? {
            label: "AI operations",
            value: "Contract-defined",
            note: "Your agreement sets this allowance.",
            ratio: null,
            tone: "neutral",
          }
        : ai.state === "NOT_INCLUDED"
          ? {
              label: "AI operations",
              value: "Not included",
              note: "Available on Pro and Team",
              ratio: null,
              tone: "neutral",
            }
          : {
              label: "AI operations",
              value: "Not available",
              note: ai.reason,
              ratio: null,
              tone: "neutral",
            },
  );

  return out;
}

/**
 * EVIDENCE — one card.
 *
 * WHAT THIS MERGED, AND WHY
 * ---------------------------------------------------------------------------
 * The page carried TWO cards about the same thing. "Evidence allowance" said
 * how many records were held, what the plan included and how many credits were
 * available; "Evidence credits" said the credit balance again, explained what
 * credits are, and offered the purchase. A customer reading down the page met
 * the number 0 twice, under two headings, with the action attached to the
 * second one — so the card that explained the shortage was not the card that
 * could fix it.
 *
 * They are one capacity question with one remedy, so they are one card with
 * ONE purchase action. Nothing was lost in the merge: the balance, the ledger
 * history and the purchase all moved here, and the second card was deleted
 * rather than hidden.
 *
 * WHAT IT RENDERS
 * ---------------------------------------------------------------------------
 * The server's projection. Which numbers exist, what the next record needs and
 * whether a purchase is authorized are all decided in
 * `billing-account-projection.service.ts`; nothing about the commercial policy
 * is derived here.
 */
export function EvidenceDetailCard({
  projection,
  onBuyCredits,
  onChoosePlan,
}: {
  projection: BillingAccountProjection;
  onBuyCredits?: () => void;
  onChoosePlan?: () => void;
}) {
  const admission = projection.evidenceAdmission;
  const meter = projection.usage.evidence;
  const wallet = projection.wallet;
  const canBuyCredits = projection.actions.canBuyEvidenceCredits === true;

  /*
   * The card exists when there is something true to put in it.
   *
   * The version this replaces returned null unless there was an ADMISSION
   * projection or a rolling meter already over its limit — so a TEAM account,
   * whose rolling window carries no admission, had its credit balance shown
   * only by the second card. Deleting that card without widening this
   * condition would have deleted the balance with it.
   */
  const hasMeter = meter.state === "MEASURED";
  if (!admission && !hasMeter && !wallet) return null;

  const described = hasMeter ? describeMeter(meter) : null;
  const offered = admission
    ? describeEvidenceAdmission(admission, {
        canBuyCredits,
        hasPlanOffer: (projection.planOffers ?? []).length > 0,
      })
    : null;

  /*
   * THE dominant number, chosen once.
   *
   * The admission projection is preferred where it exists because it knows the
   * difference between a plan's included allowance and a higher AGREED limit
   * for this account — a distinction the raw meter cannot make, and getting it
   * wrong tells a customer their plan is something it is not.
   */
  const headline = offered?.headline ?? described?.headline ?? null;

  const windowNote =
    meter.state === "MEASURED"
      ? meter.window === "ROLLING_30_DAYS"
        ? "Rolling 30-day window"
        : meter.window === "CALENDAR_MONTH"
          ? "Resets each month"
          : null
      : null;

  const grandfathered =
    admission &&
    admission.capSource === "LEGACY_RECORD_CAP_OVERRIDE" &&
    admission.planIncludedLifetime !== null &&
    admission.effectiveLifetimeCap !== null &&
    admission.planIncludedLifetime !== admission.effectiveLifetimeCap;

  const over =
    admission &&
    admission.effectiveLifetimeCap !== null &&
    admission.recordsHeld > admission.effectiveLifetimeCap
      ? admission.recordsHeld - admission.effectiveLifetimeCap
      : 0;

  /*
   * The credit balance comes from the ADMISSION where there is one and from
   * the wallet otherwise. They are the same number from the same authority;
   * the admission simply carries it alongside the allowance it funds.
   */
  const credits = admission?.creditsAvailable ?? wallet?.availableCredits ?? null;

  /*
   * ONE purchase entry point, and the SERVER decides whether it exists.
   *
   * `offered.action` is the admission's own answer for accounts that have one.
   * A wallet-holding account with no admission — the rolling-window tiers —
   * keeps the purchase, because credits fund records there too; what it does
   * not get is a shortage sentence it is not in.
   */
  const action: "BUY_CREDITS" | "SEE_PLANS" | null =
    offered?.action ?? (wallet && canBuyCredits ? "BUY_CREDITS" : null);

  return (
    <section className="bill-panel" data-billing-evidence-detail>
      <h3 className="bill-panel__title">Evidence</h3>

      {headline ? (
        <p className="bill-panel__lead">
          <bdi>{headline}</bdi>
        </p>
      ) : null}

      <dl className="bill-facts">
        {admission && admission.planIncludedLifetime !== null ? (
          <div className="bill-facts__row">
            <dt className="bill-facts__label">
              Included with {projection.plan.displayName}
            </dt>
            <dd className="bill-facts__value">
              <bdi>{admission.planIncludedLifetime.toLocaleString()}</bdi>
            </dd>
          </div>
        ) : null}
        {grandfathered ? (
          <div className="bill-facts__row">
            {/* Stated as what it is — an agreed limit for this account — and
                never as "what your plan includes", which is a different
                number and was the sentence the page used to print. */}
            <dt className="bill-facts__label">Agreed account limit</dt>
            <dd className="bill-facts__value">
              <bdi>{admission!.effectiveLifetimeCap!.toLocaleString()}</bdi>
            </dd>
          </div>
        ) : null}
        {over > 0 ? (
          <div className="bill-facts__row" data-tone="pending">
            <dt className="bill-facts__label">
              Above the {grandfathered ? "agreed limit" : "included allowance"}
            </dt>
            <dd className="bill-facts__value">
              <bdi>{over.toLocaleString()}</bdi>
            </dd>
          </div>
        ) : null}
        {windowNote ? (
          <div className="bill-facts__row" data-billing-evidence-window>
            {/* Records AGE OUT of a rolling window and never age out of a
                lifetime one, so waiting is a real answer in one case and never
                in the other. Saying which window this is costs a row. */}
            <dt className="bill-facts__label">Allowance period</dt>
            <dd className="bill-facts__value">{windowNote}</dd>
          </div>
        ) : null}
        {credits !== null ? (
          <div className="bill-facts__row">
            <dt className="bill-facts__label">Credits available</dt>
            <dd className="bill-facts__value" data-billing-credit-balance>
              <bdi>{credits.toLocaleString()}</bdi>
            </dd>
          </div>
        ) : null}
      </dl>

      {/* ONE supporting line. The two cards between them carried three: what
          the next record needs, what credits are, and that they do not
          expire. */}
      {offered?.next ?? described?.detail ? (
        <p className="bill-panel__note" data-billing-evidence-next>
          {offered?.next ?? described?.detail}
        </p>
      ) : null}

      {action === "BUY_CREDITS" && onBuyCredits ? (
        <div className="bill-panel__actions">
          <button
            type="button"
            className="app-secondary-action app-secondary-action--lg"
            onClick={onBuyCredits}
            data-billing-buy-credits
            data-billing-evidence-action="BUY_CREDITS"
          >
            Buy credits
          </button>
        </div>
      ) : action === "SEE_PLANS" && onChoosePlan ? (
        <div className="bill-panel__actions">
          <button
            type="button"
            className="app-secondary-action app-secondary-action--lg"
            onClick={onChoosePlan}
            data-billing-evidence-action="SEE_PLANS"
          >
            Choose a plan
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Plan capabilities — the tier facts that are not meters.
 *
 * A "Workspaces and teams" card the width of the page carried one value:
 * "0 of 2". Facts of that size belong in a row, beside their neighbours.
 */
export function PlanCapabilitiesCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const c = projection.collaboration;
  const rows: Array<{ label: string; value: string }> = [];

  if (c?.collaborationTeams) {
    rows.push({
      label: "Collaboration teams",
      value: `${c.collaborationTeams.used} of ${c.collaborationTeams.limit}`,
    });
  }
  if (c?.seats) {
    rows.push({
      label: "Members",
      value:
        c.seats.limit === null
          ? `${c.seats.used} accepted`
          : `${c.seats.used} of ${c.seats.limit}`,
    });
    if (c.seats.pendingInvites > 0) {
      rows.push({
        label: "Pending invites",
        value: String(c.seats.pendingInvites),
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <section className="bill-panel" data-billing-capabilities>
      <h3 className="bill-panel__title">Plan capabilities</h3>
      <dl className="bill-facts">
        {rows.map((r) => (
          <div className="bill-facts__row" key={r.label}>
            <dt className="bill-facts__label">{r.label}</dt>
            <dd className="bill-facts__value">
              <bdi>{r.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      <p className="bill-panel__note">
        {/* Named precisely: a Collaboration Team is a resource this tier
            includes, not a separately billed workspace. The model that said
            otherwise is retired, and the copy must not bring it back. */}
        Collaboration teams are part of your plan. They are not separately
        billed workspaces.
      </p>
    </section>
  );
}
