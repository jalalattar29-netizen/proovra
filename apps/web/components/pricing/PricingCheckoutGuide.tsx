"use client";

export function PricingCheckoutGuide() {
  const items = [
    "Choose a plan on this page first, then finish payment inside the Billing console.",
    "Pay-Per-Evidence uses a one-time checkout flow and is intended for usage-based purchases.",
    "Pro and Team use recurring monthly subscriptions after provider approval.",
    "Team checkout only works for a team workspace you own.",
    "Storage add-ons are purchased inside Billing and depend on workspace type and eligibility.",
    "Stripe and PayPal start differently, but both follow the same plan and workspace rules.",
    "Provider approval may temporarily leave a subscription or add-on in a pending state before it becomes active.",
    "Final billing state is reflected back in Billing after the provider confirms the checkout.",
  ];

  return (
    <div
      className="rounded-[28px] border p-5 md:p-6"
      style={{
        border: "1px solid rgba(79,112,107,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(243,245,242,0.96) 100%)",
      }}
    >
      <div className="mb-2 text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
        How checkout works
      </div>

      <div className="mb-4 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
        The pricing page helps you choose. The Billing console is where you confirm
        workspace target, provider, live subscription status, and storage add-ons.
      </div>

      <div className="grid gap-3">
        {items.map((item, index) => (
          <div
            key={index}
            className="flex items-start gap-3 rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
            }}
          >
            <span
              style={{
                marginTop: 3,
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "#7ea9a2",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                color: "#415257",
                fontSize: 14,
                lineHeight: 1.75,
              }}
            >
              {item}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}