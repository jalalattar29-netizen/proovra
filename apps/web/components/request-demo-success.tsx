import Link from "next/link";
import { SALES_ASSETS } from "../lib/sales-assets";
import { Button } from "./ui";

type RequestDemoSuccessProps = {
  title?: string;
  eyebrow?: string;
  responseWindowText?: string;
  isEnterprise?: boolean;
  showSecondaryActions?: boolean;
};

export function RequestDemoSuccess({
  title = "Your request has been received",
  eyebrow = "Request received",
  responseWindowText = SALES_ASSETS.expectedResponseWindowText,
  isEnterprise = false,
  showSecondaryActions = true,
}: RequestDemoSuccessProps) {
  const headline = isEnterprise
    ? "We’ll review your inquiry and route it for the right commercial, workflow, or enterprise discussion."
    : "We’ll review your request and follow up if your workflow is a good fit for a live walkthrough.";

  const secondaryCopy = isEnterprise
    ? "If your workflow involves shared access, retention, procurement, rollout planning, or internal review requirements, we will use that context to route the conversation appropriately."
    : "In the meantime, you can inspect the same sample assets that help prospects understand the product more clearly than a form alone.";

  return (
    <div className="rounded-[24px] border border-[rgba(79,112,107,0.22)] bg-[rgba(255,255,255,0.48)] p-6 shadow-[0_16px_36px_rgba(0,0,0,0.06)] md:p-7">
      <div className="text-[0.78rem] font-semibold uppercase tracking-[0.22em] text-[#8e7863]">
        {eyebrow}
      </div>

      <h2 className="mt-3 text-[1.2rem] font-semibold tracking-[-0.03em] text-[#1d3136] md:text-[1.4rem]">
        {title}
      </h2>

      <p className="mt-3 text-[0.98rem] leading-[1.85] text-[#55666a]">
        {headline}
      </p>

      <div className="mt-5 rounded-[18px] border border-[rgba(79,112,107,0.16)] bg-[rgba(255,255,255,0.34)] p-4">
        <div className="text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-[#8e7863]">
          What happens next
        </div>
        <p className="mt-3 text-[0.96rem] leading-[1.8] text-[#55666a]">
          You can expect an initial review response {responseWindowText}.
        </p>
        <p className="mt-3 text-[0.96rem] leading-[1.8] text-[#55666a]">
          {secondaryCopy}
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <a
          href={SALES_ASSETS.sampleReportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
        >
          View Sample Report
        </a>

        <Link
          href={SALES_ASSETS.verificationDemoUrl}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
        >
          Open Verification Demo
        </Link>

        <Link
          href={SALES_ASSETS.methodologyUrl}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
        >
          View Methodology
        </Link>

        {showSecondaryActions ? (
          <>
            <Link
              href={SALES_ASSETS.pricingUrl}
              className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
            >
              View Pricing
            </Link>

            <Link
              href={SALES_ASSETS.contactSalesUrl}
              className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
            >
              Contact Sales
            </Link>
          </>
        ) : null}
      </div>

      {SALES_ASSETS.bookingUrl ? (
        <div className="mt-6">
          <a
            href={SALES_ASSETS.bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button className="rounded-[16px] px-5 py-3 text-[0.95rem] font-medium hover-button-primary">
              Book a walkthrough
            </Button>
          </a>
        </div>
      ) : null}
    </div>
  );
}