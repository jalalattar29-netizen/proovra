"use client";

import Link from "next/link";
import { MarketingHeader } from "./header";
import { Footer } from "./Footer";
import { SilverWatermarkSection } from "./SilverWatermarkSection";
import type { UseCasePageContent } from "./use-case-data";
import { SALES_ASSETS } from "../lib/sales-assets";

function SectionCard({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-[28px] border border-[rgba(79,112,107,0.22)] shadow-[0_24px_60px_rgba(0,0,0,0.10)]">
      <img
        src="/images/panel-silver.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

      <div className="relative z-10 p-6 md:p-7">
        <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
          {eyebrow}
        </div>
        <h3 className="mt-3 text-[1.08rem] font-semibold tracking-[-0.03em] text-[#23373b]">
          {title}
        </h3>
        <p className="mt-3 text-[0.98rem] leading-[1.85] text-[#55666a]">
          {body}
        </p>
      </div>
    </div>
  );
}

function SectionHeading({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="max-w-[860px]">
      <h2 className="text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.1rem]">
        {title}
      </h2>
      <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
        {body}
      </p>
    </div>
  );
}

export function UseCasePage({ content }: { content: UseCasePageContent }) {
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
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[860px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                {content.eyebrow}
              </div>

              <h1 className="mt-5 max-w-[800px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                {content.title}
                <span className="text-[#bfe8df]"> {content.highlight}</span>
              </h1>

              <p className="mt-5 max-w-[780px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                {content.description}
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                {content.heroBullets.map((bullet) => (
                  <div
                    key={bullet}
                    className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md"
                  >
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    {bullet}
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href={SALES_ASSETS.requestDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Request Demo
                </Link>

                <a
                  href={SALES_ASSETS.sampleReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
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
              </div>
            </div>
          </section>
        </div>
      </div>

      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 48, paddingBottom: 64 }}
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
          <div className="grid gap-6">
            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 px-6 py-7 md:px-10 md:py-10">
                <SectionHeading
                  title={content.challengeTitle}
                  body={content.challengeBody}
                />
              </div>
            </div>

            <div>
              <SectionHeading
                title={content.workflowTitle}
                body={content.workflowBody}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
                {content.workflowSteps.map((card) => (
                  <SectionCard key={`${card.eyebrow}-${card.title}`} {...card} />
                ))}
              </div>
            </div>

            <div>
              <SectionHeading
                title={content.inspectTitle}
                body={content.inspectBody}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                {content.inspectCards.map((card) => (
                  <SectionCard key={`${card.eyebrow}-${card.title}`} {...card} />
                ))}
              </div>
            </div>

            <div>
              <SectionHeading
                title={content.outputTitle}
                body={content.outputBody}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                {content.outputCards.map((card) => (
                  <SectionCard key={`${card.eyebrow}-${card.title}`} {...card} />
                ))}
              </div>
            </div>

            <div>
              <SectionHeading
                title={content.betterTitle}
                body={content.betterBody}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                {content.betterCards.map((card) => (
                  <SectionCard key={`${card.eyebrow}-${card.title}`} {...card} />
                ))}
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

              <div className="relative z-10 px-6 py-7 md:px-10 md:py-10">
                <div className="max-w-[900px]">
                  <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                    Built for review-sensitive workflows
                  </div>

                  <h2 className="mt-4 text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                    {content.closingTitle}
                  </h2>

                  <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                    {content.closingBody}
                  </p>

                  <div className="mt-8 flex flex-wrap gap-3">
                    <Link
                      href={SALES_ASSETS.requestDemoUrl}
                      className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#b39b86]/42 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                    >
                      Request Demo
                    </Link>

                    <Link
                      href={SALES_ASSETS.verificationDemoUrl}
                      className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                    >
                      Open Verification Demo
                    </Link>

                    <a
                      href={SALES_ASSETS.sampleReportUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                    >
                      View Sample Report
                    </a>

                    <Link
                      href={SALES_ASSETS.contactSalesUrl}
                      className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                    >
                      Contact Sales
                    </Link>
                  </div>

                  <div className="mt-8 rounded-[22px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.34)] p-5 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                    <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                      Important limitation
                    </div>
                    <p className="mt-3 text-[0.96rem] leading-[1.85] text-[#55666a]">
                      PROOVRA verifies the recorded integrity state,
                      timestamp-related context, custody metadata, and
                      supporting review materials for an evidence record. It
                      does not by itself establish truth, authorship, identity,
                      or legal admissibility in a specific jurisdiction.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}