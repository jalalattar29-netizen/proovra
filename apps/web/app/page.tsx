"use client";

import Link from "next/link";
import { MarketingHeader } from "../components/header";
import { Hero } from "../components/hero";
import { Features } from "../components/features";
import { TrustBadges } from "../components/trust-badges";
import { LandingBody } from "../components/landing-body";
import { Footer } from "../components/Footer";
import { SilverWatermarkSection } from "../components/SilverWatermarkSection";
import { SALES_ASSETS } from "../lib/sales-assets";

export default function HomePage() {
  const appRegister = "/register";
  const appLogin = "/login";
  const demoUrl = "/request-demo";
  const sampleReportUrl = "/brand/sample-report.pdf";

  return (
    <main className="min-h-screen w-full">
      <section className="relative w-full overflow-hidden bg-[#16262d] shadow-[0_28px_70px_rgba(0,0,0,0.16)]">
        <div className="pointer-events-none absolute inset-0">
          <img
            src="/images/hero-bg.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-[88%_45%]"
          />

          <div className="absolute inset-0 bg-[#0c1820]/28" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_32%_34%,rgba(170,186,190,0.05),transparent_34%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_38%,rgba(255,255,255,0.035),transparent_14%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_58%_74%,rgba(0,0,0,0.22),transparent_34%)]" />
          <div className="absolute inset-0 opacity-[0.03] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.016)_0px,rgba(255,255,255,0.016)_1px,transparent_1px,transparent_3px)]" />
          <div className="absolute inset-y-0 right-0 w-[33%] bg-[linear-gradient(135deg,transparent_0%,transparent_45%,rgba(8,18,22,0.20)_45%,rgba(8,18,22,0.20)_58%,transparent_58%)]" />
          <div className="absolute bottom-0 right-0 h-[44%] w-[42%] bg-[linear-gradient(135deg,transparent_0%,transparent_50%,rgba(255,255,255,0.02)_50%,rgba(255,255,255,0.02)_63%,transparent_63%)]" />
        </div>

        <div className="relative z-10">
          <MarketingHeader />
          <Hero
            appRegister={appRegister}
            demoUrl={demoUrl}
            sampleReportUrl={sampleReportUrl}
          />
          <Features />
          <TrustBadges />
        </div>
      </section>

      <LandingBody
        appLogin={appLogin}
        appRegister={appRegister}
        demoUrl={demoUrl}
        sampleReportUrl={sampleReportUrl}
      />

      {/* 🔥 ENTERPRISE CTA SECTION */}
      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 40, paddingBottom: 64 }}
      >
        <div className="container relative z-10">
          <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center"
            />

            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

            <div className="relative z-10 px-6 py-7 md:px-10 md:py-10">
              <div className="max-w-[900px]">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Enterprise workflows
                </div>

                <h2 className="mt-4 text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                  Need a commercial or enterprise discussion instead of a standard walkthrough?
                </h2>

                <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                  Use this route when you need shared access, internal review workflows,
                  retention alignment, procurement discussion, or rollout planning.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  {/* Primary Button */}
                  <Link
                    href={SALES_ASSETS.contactSalesUrl}
                    className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                  >
                    Contact Sales
                  </Link>

                  {/* Secondary Button */}
                  <Link
                    href={SALES_ASSETS.pricingUrl}
                    className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                  >
                    View Pricing
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </main>
  );
}