"use client";

import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import Link from "next/link";

export default function AboutPage() {
  return (
    <div className="page landing-page about-page">
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
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[820px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                About
              </div>

              <h1 className="mt-5 max-w-[720px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                PROO✓RA helps teams create
                <span className="text-[#bfe8df]"> verifiable digital evidence records</span>
              </h1>

              <p className="mt-5 max-w-[760px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                PROO✓RA is built for workflows where ordinary files are not enough.
                We help professionals preserve the recorded integrity state of digital
                material, produce structured verification output, and support later review
                under disputes, audits, investigations, and claims scrutiny.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Verification-first platform
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Review-ready evidence workflows
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Built for scrutiny
                </div>
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
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Why it exists
                </div>
                <p className="mt-4 text-[0.98rem] leading-[1.88] text-[#55666a]">
                  In workflows where files may later be challenged, ordinary uploads and screenshots
                  often do not carry enough review context. PROO✓RA exists to preserve the recorded
                  integrity state and make later review clearer.
                </p>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  What it does
                </div>
                <ul className="mt-4 grid gap-3">
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Creates structured evidence records from uploaded or captured files
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Preserves integrity materials and timestamp context
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Produces verification pages and structured reports for later review
                  </li>
                </ul>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Important limitation
                </div>
                <p className="mt-4 text-[0.98rem] leading-[1.88] text-[#55666a]">
                  PROO✓RA verifies the recorded integrity state of an evidence record.
                  It does not by itself establish factual truth, authorship, identity,
                  or legal admissibility in a specific jurisdiction.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

            <div className="relative z-10 px-6 py-7 md:px-10 md:py-10 lg:px-12 lg:py-12 text-[#33464a]">
              <h2 className="mb-4 text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                What makes PROO✓RA different
              </h2>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                  <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                    Product principles
                  </div>
                  <ul className="mt-4 grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Verification-first, not camera-first
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Designed for later review, not just upload convenience
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Built for scrutiny, not trust-by-appearance
                    </li>
                  </ul>
                </div>

                <div className="rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                  <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                    Built for
                  </div>
                  <ul className="mt-4 grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Legal and dispute-sensitive workflows
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Compliance, audit, and internal investigations
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Claims, incident review, journalism, and sensitive documentation
                    </li>
                  </ul>
                </div>
              </div>

              <div className="my-8 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(79,112,107,0.18)_18%,rgba(183,157,132,0.26)_50%,rgba(79,112,107,0.18)_82%,transparent_100%)]" />

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/request-demo"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#b39b86]/42 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Request Demo
                </Link>

                <Link
                  href="/brand/sample-report.pdf"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </Link>
              </div>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}