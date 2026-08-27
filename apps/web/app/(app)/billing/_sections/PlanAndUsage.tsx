"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the plan summary, the
 * action-required banner, and the three usage meters.
 *
 * What was removed from the surface these replace, and why:
 *   * "Workspace plan view" / "Effective capability view" / "Billing status" —
 *     three internal resolver outputs printed as customer copy.
 *   * "This workspace is currently operating under the owner's PRO
 *     entitlement" — factually wrong since §9.4: an Owned Workspace never
 *     inherits its owner's Personal plan.
 *   * "Billing ownership: Assigned / Not assigned" — a nullable foreign key
 *     rendered as prose, for a field that authorized nothing.
 *   * "Workspace health: Near limit: No / Limit reached: No" — two booleans a
 *     customer cannot act on.
 *   * Storage shown five different ways on one card.
 *   * "Projects" — a metric PROOVRA has no concept of.
 *
 * The meters are Evidence, Storage and AI, and nothing else. Each renders the
 * SERVER's state: a plan that excludes a capability says "Not included", a
 * contract that governs one says "Contract-managed", and a value that could not
 * be read says "Unavailable" — never a zero standing in for any of them.
 */

import Link from "next/link";

import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import type {
  BillingAccountProjection,
  StorageMeter,
  UsageMeter,
} from "../../../../lib/api/billing-accounts";
import {
  describeMeter,
  describeModel,
  formatDate,
  formatMoney,
  presentLifecycle,
} from "./format";

/** A bar that only fills when there is a real denominator to fill. */
function Meter({
  label,
  headline,
  detail,
  ratio,
  tone = "neutral",
  testId,
}: {
  label: string;
  headline: string;
  detail: string | null;
  ratio: number | null;
  tone?: "neutral" | "pending" | "risk";
  testId?: string;
}) {
  const fill =
    tone === "risk"
      ? "var(--status-risk-solid, #dc2626)"
      : tone === "pending"
        ? "var(--status-pending-solid, #f59e0b)"
        : "var(--status-info-solid, #2563eb)";

  return (
    <div data-testid={testId} style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-muted, #5F6878)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: "1.02rem",
          fontWeight: 600,
          color: "var(--text-strong, #172033)",
          overflowWrap: "anywhere",
        }}
      >
        {headline}
      </div>
      {ratio !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label={`${label}: ${headline}`}
          style={{
            marginTop: 10,
            height: 6,
            borderRadius: 999,
            background: "var(--surface-muted, #eef2f7)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.round(ratio * 100)}%`,
              height: "100%",
              background: fill,
            }}
          />
        </div>
      ) : null}
      {detail ? (
        <div
          style={{
            marginTop: 8,
            fontSize: "0.84rem",
            lineHeight: 1.6,
            color: "var(--text-muted, #475569)",
          }}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function storageMeterProps(meter: StorageMeter) {
  if (meter.state === "UNAVAILABLE") {
    return {
      headline: "Unavailable",
      detail: meter.reason,
      ratio: null,
      tone: "neutral" as const,
    };
  }
  const extras: string[] = [];
  if (meter.recurringAddonBytes !== "0") {
    extras.push(`${meter.recurringAddonLabel} from add-ons`);
  }
  if (meter.legacyAddonBytes !== "0") {
    // Named, because it is a different commercial object: a one-time purchase
    // that is grandfathered and never renews.
    extras.push(`${meter.legacyAddonLabel} from earlier one-time purchases`);
  }
  return {
    headline: `${meter.usedLabel} of ${meter.limitLabel}`,
    detail: [`${meter.baseLabel} included`, ...extras].join(" · "),
    ratio: Math.min(1, meter.usagePercent / 100),
    tone: meter.limitReached
      ? ("risk" as const)
      : meter.nearLimit
        ? ("pending" as const)
        : ("neutral" as const),
  };
}

/**
 * The banner. Rendered ONLY when the SERVER says something needs doing.
 *
 * This used to branch on the raw lifecycle value and re-read the storage
 * meter to decide whether to appear and what to say. Both are
 * commercial judgements — the grace clock especially — and the server holds
 * every input to them. It now renders a decision rather than making one.
 */
export function ActionRequiredBanner({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const banner = projection.actionRequired;
  if (!banner) return null;

  return (
    <Card
      variant="status"
      tone={banner.severity === "CRITICAL" ? "risk" : "pending"}
      role="alert"
      data-billing-action-required
      title={banner.title}
    >
      <div style={{ display: "grid", gap: 6 }}>
        {banner.messages.map((m) => (
          <p
            key={m}
            style={{
              margin: 0,
              fontSize: "0.9rem",
              lineHeight: 1.65,
              color: "var(--text-muted, #475569)",
            }}
          >
            {m}
          </p>
        ))}
      </div>
      {banner.reassurance ? (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: "0.85rem",
            color: "var(--text-muted, #5F6878)",
          }}
        >
          {banner.reassurance}
        </p>
      ) : null}
    </Card>
  );
}

export function PlanSummaryCard({
  projection,
  onManage,
  onCancel,
  cancelBusy,
}: {
  projection: BillingAccountProjection;
  onManage: () => void;
  onCancel: () => void;
  cancelBusy: boolean;
}) {
  const { plan, account, actions, contract } = projection;
  const lifecycle = presentLifecycle(plan.lifecycle, {
    periodEndUtc: plan.currentPeriodEndUtc,
    graceEndsAtUtc: plan.graceEndsAtUtc,
  });
  const price = formatMoney(plan.priceCents ?? null, plan.currency ?? null);
  const renews = formatDate(plan.currentPeriodEndUtc);

  return (
    <Card
      variant="summary"
      data-billing-plan-summary
      header={
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--text-muted, #5F6878)",
              }}
            >
              Current plan
            </div>
            <h2
              style={{
                margin: "6px 0 0",
                fontSize: "1.5rem",
                fontWeight: 650,
                letterSpacing: "-0.02em",
                color: "var(--text-strong, #172033)",
              }}
              data-billing-plan-name
            >
              {contract ? "Enterprise agreement" : plan.displayName}
            </h2>
            <div
              style={{
                marginTop: 4,
                fontSize: "0.9rem",
                color: "var(--text-muted, #475569)",
              }}
            >
              {account.displayName} · {describeModel(plan.model)}
            </div>
          </div>
          <Badge tone={lifecycle.tone} dot data-billing-plan-status>
            {lifecycle.label}
          </Badge>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        {price ? (
          <div style={{ fontSize: "0.95rem", color: "var(--text-strong, #172033)" }}>
            {/* Isolated so the currency symbol cannot reorder in RTL. */}
            <bdi style={{ fontWeight: 600 }}>{price}</bdi>
            {plan.model === "MONTHLY" ? " per month" : null}
          </div>
        ) : null}

        {/* A renewal date is shown only when the provider gave one. A credit
            purchase has none, and inventing one was how the old card implied a
            subscription that did not exist. */}
        {renews && plan.model === "MONTHLY" ? (
          <div style={{ fontSize: "0.9rem", color: "var(--text-muted, #475569)" }}>
            {plan.cancelAtPeriodEnd
              ? `Access continues until ${renews}.`
              : `Renews on ${renews}.`}
          </div>
        ) : null}

        {lifecycle.detail && plan.lifecycle !== "PAST_DUE" ? (
          <div style={{ fontSize: "0.9rem", color: "var(--text-muted, #475569)" }}>
            {lifecycle.detail}
          </div>
        ) : null}

        {plan.paymentProviderLabel ? (
          <div style={{ fontSize: "0.86rem", color: "var(--text-muted, #5F6878)" }}>
            Paid by {plan.paymentProviderLabel}
          </div>
        ) : null}
      </div>

      <div
        style={{
          marginTop: 18,
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        {actions.canStartCheckout && actions.manageLabel ? (
          <Button variant="primary" size="sm" onClick={onManage} data-billing-manage-plan>
            {/* The SERVER chose this word. "Upgrade" and "Change" are different
                claims about the account's commercial state, and choosing
                between them in the browser is the browser holding commercial
                logic. */}
            {actions.manageLabel}
          </Button>
        ) : null}

        {actions.canRequestCancellation && !plan.cancelAtPeriodEnd ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onCancel}
            loading={cancelBusy}
            disabled={cancelBusy}
            data-billing-cancel-plan
          >
            Cancel subscription
          </Button>
        ) : null}

        {actions.contactAccountManager ? (
          <Link
            href="/contact-sales"
            className="app-header-primary-action"
            data-billing-contact-account-manager
          >
            <span>Contact your account manager</span>
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

export function UsageAndLimits({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const evidence = describeMeter(projection.usage.evidence);
  const ai = describeMeter(projection.usage.ai);
  const storage = storageMeterProps(projection.usage.storage);
  const wallet = projection.wallet;

  return (
    <Card variant="summary" title="Usage and limits" data-billing-usage>
      <div
        style={{
          display: "grid",
          gap: 24,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <Meter
          label="Evidence"
          headline={evidence.headline}
          detail={
            // Credits are shown WITH the evidence meter, because they are what
            // continues the same activity once the included allowance is gone.
            wallet && wallet.availableCredits > 0
              ? `${wallet.availableCredits} evidence credit${
                  wallet.availableCredits === 1 ? "" : "s"
                } available after that.`
              : evidence.detail
          }
          ratio={evidence.ratio}
          tone={
            evidence.ratio !== null && evidence.ratio >= 1 ? "risk" : "neutral"
          }
          testId="billing-meter-evidence"
        />
        <Meter
          label="Storage"
          headline={storage.headline}
          detail={storage.detail}
          ratio={storage.ratio}
          tone={storage.tone}
          testId="billing-meter-storage"
        />
        <Meter
          label="AI operations"
          headline={ai.headline}
          detail={
            ai.detail ??
            (projection.usage.ai.state === "MEASURED" &&
            projection.usage.ai.window === "CALENDAR_MONTH"
              ? "Resets at the start of each month."
              : null)
          }
          ratio={ai.ratio}
          tone={ai.ratio !== null && ai.ratio >= 1 ? "risk" : "neutral"}
          testId="billing-meter-ai"
        />
      </div>
    </Card>
  );
}

export function CollaborationUsageCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const c = projection.collaboration;
  if (!c || (!c.ownedWorkspaces && !c.collaborationTeams && !c.seats)) {
    return null;
  }

  return (
    <Card
      variant="summary"
      title={projection.account.type === "PERSONAL" ? "Workspaces and teams" : "Members"}
      data-billing-collaboration
    >
      <div
        style={{
          display: "grid",
          gap: 20,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        }}
      >
        {/* Three independently-named values. The metric these replace —
            "Teams — Current usage: N of M" — compared a Collaboration Team
            membership count against the account's Owned Workspace cap. */}
        {c.ownedWorkspaces ? (
          <Meter
            label="Owned workspaces"
            headline={`${c.ownedWorkspaces.used} of ${c.ownedWorkspaces.limit}`}
            detail={null}
            ratio={
              c.ownedWorkspaces.limit > 0
                ? Math.min(1, c.ownedWorkspaces.used / c.ownedWorkspaces.limit)
                : null
            }
            testId="billing-meter-owned-workspaces"
          />
        ) : null}

        {c.collaborationTeams ? (
          <Meter
            label="Collaboration teams"
            headline={`${c.collaborationTeams.used} of ${c.collaborationTeams.limit}`}
            detail="In this workspace."
            ratio={
              c.collaborationTeams.limit > 0
                ? Math.min(
                    1,
                    c.collaborationTeams.used / c.collaborationTeams.limit,
                  )
                : null
            }
            testId="billing-meter-collaboration-teams"
          />
        ) : null}

        {c.seats ? (
          <Meter
            label="Accepted members"
            headline={`${c.seats.used} of ${c.seats.limit}`}
            // Pending invitations are named separately and never folded into
            // the seat count — an invitation is not a member.
            detail={
              c.seats.pendingInvites > 0
                ? `${c.seats.pendingInvites} invitation${
                    c.seats.pendingInvites === 1 ? "" : "s"
                  } pending — not counted here.`
                : null
            }
            ratio={
              c.seats.limit > 0 ? Math.min(1, c.seats.used / c.seats.limit) : null
            }
            testId="billing-meter-seats"
          />
        ) : null}
      </div>
    </Card>
  );
}

export function EnterpriseContractCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const contract = projection.contract;
  if (!contract) return null;

  const rows: Array<[string, string]> = [];
  const effective = formatDate(contract.effectiveAtUtc);
  const ends = formatDate(contract.endsAtUtc);
  if (effective) rows.push(["Effective from", effective]);
  if (ends) rows.push(["Term ends", ends]);
  if (contract.seatCount !== null) {
    rows.push(["Contracted seats", String(contract.seatCount)]);
  }
  if (contract.storageGb !== null) {
    rows.push(["Contracted storage", `${contract.storageGb} GB`]);
  }
  if (contract.region) rows.push(["Region", contract.region]);

  return (
    <Card variant="summary" title="Agreement" data-billing-contract>
      {contract.derivedFromLegacyFallback ? (
        // Honest rather than confident: this projection was derived, not read
        // from a contract record, so no number here is published as a term.
        <p
          style={{
            margin: "0 0 12px",
            fontSize: "0.9rem",
            lineHeight: 1.65,
            color: "var(--text-muted, #475569)",
          }}
          data-billing-contract-legacy
        >
          We do not have your full agreement on file here. Your account manager
          holds the authoritative terms.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <dl
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            margin: 0,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--text-muted, #5F6878)",
                }}
              >
                {label}
              </dt>
              <dd
                style={{
                  margin: "4px 0 0",
                  fontSize: "0.95rem",
                  color: "var(--text-strong, #172033)",
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

export type { UsageMeter };
