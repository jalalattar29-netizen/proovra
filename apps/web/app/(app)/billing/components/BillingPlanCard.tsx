"use client";

import { ReactNode } from "react";
import { Badge } from "../../../../components/ui/Badge";

type BillingPlanCardProps = {
  title: string;
  subtitle: string;
  badge?: string | null;
  highlighted?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  stripeBusy?: boolean;
  paypalBusy?: boolean;
  onStripe?: (() => void) | null;
  onPayPal?: (() => void) | null;
  stripeLabel?: string;
  paypalLabel?: string;
  note?: string | null;
};

export function BillingPlanCard({
  title,
  subtitle,
  badge,
  highlighted = false,
  disabled = false,
  children,
  stripeBusy = false,
  paypalBusy = false,
  onStripe,
  onPayPal,
  stripeLabel = "Checkout with Stripe",
  paypalLabel = "Checkout with PayPal",
  note,
}: BillingPlanCardProps) {
  const showStripe = Boolean(onStripe);
  const showPayPal = Boolean(onPayPal);

  return (
    <div className="cases-inner" style={{ padding: 18 }} data-billing-plan-highlighted={highlighted ? "true" : "false"}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="text-[16px] font-bold text-[#172033]">{title}</div>
          <div className="mt-1.5 text-[13px] leading-[1.7] text-[#475569]">
            {subtitle}
          </div>
        </div>

        {badge ? (
          <Badge tone={highlighted ? "governance" : "neutral"} style={{ alignSelf: "flex-start" }}>
            {badge}
          </Badge>
        ) : null}
      </div>

      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}

      {(showStripe || showPayPal) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
          {showStripe ? (
            <button
              type="button"
              className="app-header-primary-action"
              disabled={disabled || stripeBusy || !onStripe}
              onClick={() => onStripe?.()}
            >
              <span>{stripeBusy ? "Processing..." : stripeLabel}</span>
            </button>
          ) : null}

          {showPayPal ? (
            <button
              type="button"
              className="cases-filter-chip"
              disabled={disabled || paypalBusy || !onPayPal}
              onClick={() => onPayPal?.()}
            >
              {paypalBusy ? "Processing..." : paypalLabel}
            </button>
          ) : null}
        </div>
      )}

      {note ? (
        <div className="mt-3 text-[12px] leading-[1.7] text-[#5F6878]">
          {note}
        </div>
      ) : null}
    </div>
  );
}
