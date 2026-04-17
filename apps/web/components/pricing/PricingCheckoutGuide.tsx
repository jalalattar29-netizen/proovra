"use client";

import Link from "next/link";
import { Button } from "../../components/ui";

export function PricingCheckoutGuide() {
  const items = [
    {
      title: "Self-serve plans",
      text: "Free, Pay-Per-Evidence, Pro, and Team are designed for direct selection from this page before continuing into the Billing console.",
    },
    {
      title: "Usage-based vs recurring billing",
      text: "Pay-Per-Evidence is a one-time evidence completion flow. Pro and Team use recurring monthly subscriptions after provider approval.",
    },
    {
      title: "Workspace context matters",
      text: "Free and PAYG are personal-only. PRO supports personal use plus limited team creation. TEAM is for larger multi-team operational usage.",
    },
    {
      title: "Team limits",
      text: "PRO supports up to 2 owned teams. TEAM supports up to 5 owned teams. Each individual team is capped at 5 actual members.",
    },
    {
      title: "Invites vs actual membership",
      text: "Invitations are not blocked just because a team is currently full. The hard limit is enforced when a user is actually added or accepts an invite.",
    },
    {
      title: "Storage top-ups",
      text: "Storage add-ons are purchased inside Billing as one-time top-ups and do not create a second monthly storage subscription.",
    },
    {
      title: "Provider state",
      text: "Stripe and PayPal start differently, but both follow the same workspace and plan rules. Provider approval may leave a subscription temporarily pending.",
    },
    {
      title: "Enterprise route",
      text: "If you need procurement discussion, governance review, retention alignment, larger rollout planning, or a higher-volume workflow, use Contact Sales instead of self-serve checkout.",
    },
  ];

  return (
    <div
      className="rounded-[30px] border p-6 md:p-7"
      style={{
        border: "1px solid rgba(79,112,107,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.72) 0%, rgba(243,245,242,0.96) 100%)",
        boxShadow:
          "0 18px 36px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.55)",
      }}
    >
      <div className="mb-2 text-[1.18rem] font-semibold tracking-[-0.025em] text-[#21353a]">
        How plan selection works
      </div>

      <div className="mb-5 max-w-[900px] text-[0.94rem] leading-[1.8] text-[#5d6d71]">
        Use this page to understand fit. Self-serve plans continue into the
        Billing console. Enterprise discussions continue through Contact Sales
        when the workflow is larger than a standard checkout path.
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item, index) => (
          <div
            key={index}
            className="rounded-[22px] border px-5 py-5"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(243,245,242,0.88) 100%)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.48), 0 10px 22px rgba(0,0,0,0.04)",
            }}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  marginTop: 7,
                  borderRadius: 999,
                  background: index === items.length - 1 ? "#b79d84" : "#6f9f97",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <div>
                <div className="text-[0.98rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                  {item.title}
                </div>
                <div className="mt-2 text-[0.89rem] leading-[1.8] text-[#4e6165]">
                  {item.text}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div
        className="mt-6 flex flex-col gap-3 rounded-[22px] border px-5 py-5 md:flex-row md:items-center md:justify-between"
        style={{
          border: "1px solid rgba(183,157,132,0.16)",
          background:
            "linear-gradient(180deg, rgba(247,242,237,0.92) 0%, rgba(255,255,255,0.72) 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.68), 0 12px 24px rgba(92,69,50,0.05)",
        }}
      >
        <div>
          <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
            Enterprise path
          </div>
          <div className="mt-2 text-[0.96rem] font-semibold tracking-[-0.02em] text-[#23373b]">
            Need procurement, governance review, or a larger rollout?
          </div>
          <div className="mt-1 text-[0.88rem] leading-[1.75] text-[#5d6d71]">
            Use Contact Sales for shared review workflows, retention alignment,
            organization rollout, and custom commercial discussion.
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/contact-sales">
            <Button
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={{
                borderColor: "rgba(79,112,107,0.20)",
                color: "#eef3f1",
                background:
                  "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
              }}
            >
              Contact Sales
            </Button>
          </Link>

          <Link href="/contact-sales">
            <Button
              variant="secondary"
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={{
                borderColor: "rgba(183,157,132,0.18)",
                color: "#7a624d",
                background:
                  "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.68) 100%)",
                boxShadow:
                  "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
              }}
            >
              Request demo
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}