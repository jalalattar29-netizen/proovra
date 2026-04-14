import Link from "next/link";
import { MarketingHeader } from "../../../components/header";
import { Footer } from "../../../components/Footer";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
import { RequestDemoSuccess } from "../../../components/request-demo-success";
import { SALES_ASSETS } from "../../../lib/sales-assets";

export default function RequestDemoSuccessPage() {
  return (
    <div className="page landing-page">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.66)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[820px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Demo request received
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                Your request is in review
              </h1>

              <p className="mt-5 max-w-[760px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                While we review your request, you can already inspect the sample
                report, verification demo, and methodology that power the
                workflow.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href={SALES_ASSETS.sampleReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </a>

                <Link
                  href={SALES_ASSETS.verificationDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Open Verification Demo
                </Link>

                <Link
                  href={SALES_ASSETS.methodologyUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Methodology
                </Link>

                <Link
                  href={SALES_ASSETS.contactSalesUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
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
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div className="container relative z-10">
          <div className="mx-auto max-w-[900px]">
            <RequestDemoSuccess />
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}