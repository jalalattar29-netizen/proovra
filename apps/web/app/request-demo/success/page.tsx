import Link from "next/link";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
import { RequestDemoSuccess } from "../../../components/request-demo-success";
import { SALES_ASSETS } from "../../../lib/sales-assets";

export default function RequestDemoSuccessPage() {
  return (
    <div className="page landing-page">
      <div className="relative overflow-hidden">
        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto w-full max-w-7xl px-6 pb-16 pt-28 md:px-8 md:pb-20 md:pt-32">
            <div className="max-w-[820px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-[#E0E7FF] bg-white px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#475569] shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#7C3AED] opacity-95" />
                Demo request received
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#0F172A] md:text-[2.18rem] lg:text-[2.7rem]">
                Your request is in review
              </h1>

              <p className="mt-5 max-w-[760px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#475569] md:text-[0.98rem]">
                While we review your request, you can already inspect the sample
                report, verification demo, and methodology that explain how the
                workflow is presented for later review.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href={SALES_ASSETS.sampleReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#6D28D9] bg-[#6D28D9] px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(109,40,217,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </a>

                <Link
                  href={SALES_ASSETS.verificationDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 py-3 text-sm font-semibold text-[#0F172A] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Open Verification Demo
                </Link>

                <Link
                  href={SALES_ASSETS.methodologyUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 py-3 text-sm font-semibold text-[#0F172A] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Methodology
                </Link>

                <Link
                  href={SALES_ASSETS.contactSalesUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 py-3 text-sm font-semibold text-[#0F172A] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Contact Sales
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>

      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 48, paddingBottom: 56 }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          {/*
            PHASE 13 (NEW-071) — the second of the two dangling references left
            behind when `/images/landing-network-bg.png` was deleted in commit
            c0057941. See `app/(app)/teams/[id]/page.tsx` for the full note.
          */}
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
        </div>

        <div className="container relative z-10">
          <div className="mx-auto max-w-[900px]">
            <RequestDemoSuccess />
          </div>
        </div>
      </SilverWatermarkSection>

      <EnterpriseFooter />
    </div>
  );
}