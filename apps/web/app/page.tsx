"use client";

import { MarketingHeader } from "../components/header";
import { Hero } from "../components/hero";
import { Features } from "../components/features";
import { TrustBadges } from "../components/trust-badges";
import { LandingBody } from "../components/landing-body";
import { Footer } from "../components/Footer";

export default function HomePage() {
  const appRegister = "/register";
  const appLogin = "/login";
  const sampleReportUrl = "/brand/sample-report.pdf";

  return (
    <main className="min-h-screen w-full overflow-x-hidden">
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
          <Hero appRegister={appRegister} sampleReportUrl={sampleReportUrl} />
          <Features />
          <TrustBadges />
        </div>
      </section>

      <LandingBody
        appLogin={appLogin}
        appRegister={appRegister}
        sampleReportUrl={sampleReportUrl}
      />

      <Footer />
    </main>
  );
}