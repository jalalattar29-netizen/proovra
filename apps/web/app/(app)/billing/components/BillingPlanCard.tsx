"use client";

import { ReactNode, useMemo } from "react";
import { Button } from "../../../../components/ui";

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
  const outerCardStyle = useMemo(
    () =>
      ({
        border: highlighted
          ? "1px solid rgba(158,216,207,0.22)"
          : "1px solid rgba(79,112,107,0.10)",
        borderRadius: 24,
        padding: 18,
        background: highlighted
          ? "linear-gradient(180deg, rgba(244,255,252,0.88) 0%, rgba(243,245,242,0.95) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        boxShadow: highlighted
          ? "0 14px 30px rgba(19,66,63,0.08), inset 0 1px 0 rgba(255,255,255,0.68)"
          : "0 10px 22px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.60)",
      }) as const,
    [highlighted]
  );

  const stripeButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.18)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 14px 30px rgba(20,48,52,0.20)",
      }) as const,
    []
  );

  const paypalButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.22)",
        color: "#6f5948",
        background:
          "linear-gradient(180deg, rgba(250,248,245,0.78) 0%, rgba(243,238,233,0.94) 100%)",
        boxShadow:
          "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.66)",
      }) as const,
    []
  );

  return (
    <div style={outerCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, color: "#21353a", fontSize: 16 }}>{title}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#5d6d71", lineHeight: 1.7 }}>
            {subtitle}
          </div>
        </div>

        {badge ? (
          <div
            style={{
              alignSelf: "flex-start",
              borderRadius: 999,
              padding: "6px 10px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: highlighted ? "#245955" : "#7a624d",
              background: highlighted
                ? "rgba(191,232,223,0.45)"
                : "rgba(214,184,157,0.20)",
              border: highlighted
                ? "1px solid rgba(127,189,180,0.32)"
                : "1px solid rgba(183,157,132,0.20)",
            }}
          >
            {badge}
          </div>
        ) : null}
      </div>

      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
        <Button
          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.95rem] font-semibold"
          style={stripeButtonStyle}
          disabled={disabled || stripeBusy || !onStripe}
          onClick={() => onStripe?.()}
        >
          {stripeBusy ? "Processing..." : stripeLabel}
        </Button>

        <Button
          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.95rem] font-semibold"
          style={paypalButtonStyle}
          disabled={disabled || paypalBusy || !onPayPal}
          onClick={() => onPayPal?.()}
        >
          {paypalBusy ? "Processing..." : paypalLabel}
        </Button>
      </div>

      {note ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "#6a777b", lineHeight: 1.7 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}