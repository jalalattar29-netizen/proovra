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

export function BillingOverview({
  projection,
  onManagePlan,
  changeBusyPlan,
}: {
  projection: BillingAccountProjection;
  onManagePlan: () => void;
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

          <span
            className="bill-overview__status"
            data-billing-plan-status
            data-tone={lifecycle.tone}
          >
            {lifecycle.label}
          </span>
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
            {m.ratio !== null ? (
              <div
                className="bill-metric__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(m.ratio * 100)}
                aria-label={`${m.label}: ${m.value}`}
              >
                {/* Clamped at 100% so a bar cannot render past its track,
                    while the VALUE above still says the real overage. */}
                <span
                  className="bill-metric__fill"
                  data-tone={m.tone}
                  style={{ width: `${Math.min(100, Math.round(m.ratio * 100))}%` }}
                />
              </div>
            ) : null}
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
 * The Evidence allowance in full, where there is room for it.
 *
 * This is the paragraph that used to sit under a progress bar in a
 * three-column row. It says the same things — what the plan includes, what
 * this account is allowed, how far past it is, and what the next record needs
 * — as facts on their own lines rather than as prose in a column.
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

  /*
   * A ROLLING allowance has no admission projection — it is not funded by the
   * credit wallet — but it still needs the panel when it is over, because the
   * resolution is the one thing the number does not say.
   *
   * The two windows resolve differently, and saying the wrong one is worse
   * than saying nothing: records AGE OUT of a rolling window, so waiting is a
   * real answer, while a lifetime allowance never refills and waiting would be
   * waiting for ever. `describeMeter` is the canonical formatter for that
   * distinction and is used rather than restated here.
   */
  const overRolling =
    !admission &&
    meter.state === "MEASURED" &&
    meter.limit !== null &&
    meter.used > meter.limit;

  if (!admission && !overRolling) return null;

  if (!admission) {
    const described = describeMeter(meter);
    return (
      <section className="bill-panel" data-billing-evidence-detail>
        <h3 className="bill-panel__title">Evidence allowance</h3>
        <p className="bill-panel__lead">
          <bdi>{described.headline}</bdi>
        </p>
        {described.detail ? (
          <p className="bill-panel__note" data-billing-evidence-next>
            {described.detail}
          </p>
        ) : null}
      </section>
    );
  }

  const offered = describeEvidenceAdmission(admission, {
    canBuyCredits: projection.actions.canBuyEvidenceCredits === true,
    hasPlanOffer: (projection.planOffers ?? []).length > 0,
  });

  const grandfathered =
    admission.capSource === "LEGACY_RECORD_CAP_OVERRIDE" &&
    admission.planIncludedLifetime !== null &&
    admission.effectiveLifetimeCap !== null &&
    admission.planIncludedLifetime !== admission.effectiveLifetimeCap;

  const over =
    admission.effectiveLifetimeCap !== null &&
    admission.recordsHeld > admission.effectiveLifetimeCap
      ? admission.recordsHeld - admission.effectiveLifetimeCap
      : 0;

  return (
    <section className="bill-panel" data-billing-evidence-detail>
      <h3 className="bill-panel__title">Evidence allowance</h3>
      <dl className="bill-facts">
        <div className="bill-facts__row">
          <dt className="bill-facts__label">Records</dt>
          <dd className="bill-facts__value">
            <bdi>{admission.recordsHeld.toLocaleString()}</bdi>
          </dd>
        </div>
        {admission.planIncludedLifetime !== null ? (
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
              <bdi>{admission.effectiveLifetimeCap!.toLocaleString()}</bdi>
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
        <div className="bill-facts__row">
          <dt className="bill-facts__label">Credits available</dt>
          <dd className="bill-facts__value">
            <bdi>{admission.creditsAvailable.toLocaleString()}</bdi>
          </dd>
        </div>
      </dl>

      <p className="bill-panel__note" data-billing-evidence-next>
        {offered.next}
      </p>

      {offered.action === "BUY_CREDITS" && onBuyCredits ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onBuyCredits}
          data-billing-evidence-action="BUY_CREDITS"
        >
          Buy evidence credits
        </Button>
      ) : offered.action === "SEE_PLANS" && onChoosePlan ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onChoosePlan}
          data-billing-evidence-action="SEE_PLANS"
        >
          Choose a plan
        </Button>
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
