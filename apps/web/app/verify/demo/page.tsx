import Link from "next/link";
import { MarketingHeader } from "../../../components/header";
import { Footer } from "../../../components/Footer";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
import { SALES_ASSETS } from "../../../lib/sales-assets";

function DemoInfoCard({
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

function DemoStep({
  step,
  title,
  body,
}: {
  step: string;
  title: string;
  body: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-[rgba(79,112,107,0.20)] bg-[rgba(255,255,255,0.42)] p-5 shadow-[0_16px_36px_rgba(0,0,0,0.06)]">
      <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
        {step}
      </div>
      <h3 className="mt-3 text-[1.02rem] font-semibold tracking-[-0.03em] text-[#23373b]">
        {title}
      </h3>
      <p className="mt-3 text-[0.96rem] leading-[1.8] text-[#55666a]">
        {body}
      </p>
    </div>
  );
}

export default function VerificationDemoPage() {
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
            <div className="max-w-[900px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Verification Demo
              </div>

              <h1 className="mt-5 max-w-[860px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                See how a verification-first evidence workflow is presented for
                <span className="text-[#bfe8df]"> later review</span>
              </h1>

              <p className="mt-5 max-w-[800px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                This guided demo shows the same reviewer-facing structure serious
                workflows need: recorded integrity state, timestamp-related
                context, custody visibility, access activity, and structured
                report output.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                {[
                  "Integrity visibility",
                  "Traceable review flow",
                  "Report-ready output",
                  "Built for later scrutiny",
                ].map((item) => (
                  <div
                    key={item}
                    className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md"
                  >
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    {item}
                  </div>
                ))}
              </div>

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
                  href={SALES_ASSETS.methodologyUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Methodology
                </Link>

                <Link
                  href={SALES_ASSETS.requestDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Request Demo
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
        <div
          className="pointer-events-none absolute inset-0 z-0"
          aria-hidden="true"
        >
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
            <div>
              <div className="max-w-[900px]">
                <h2 className="text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                  What this demo is meant to show
                </h2>
                <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                  This is not just a product teaser. It is meant to show how a
                  review-sensitive workflow is presented once evidence has been
                  preserved, verified, and prepared for later scrutiny.
                </p>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <DemoStep
                  step="Step 1"
                  title="Capture and preserve"
                  body="A file becomes a structured evidence record instead of remaining a loose upload with limited downstream review value."
                />
                <DemoStep
                  step="Step 2"
                  title="Inspect integrity and context"
                  body="Reviewers can inspect recorded integrity state, timing-related context, and a clearer sequence of important lifecycle events."
                />
                <DemoStep
                  step="Step 3"
                  title="Present with report output"
                  body="The same workflow can be paired with a structured report so the record is easier to review, escalate, and discuss later."
                />
              </div>
            </div>

            <div>
              <div className="max-w-[900px]">
                <h2 className="text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                  What reviewers can inspect
                </h2>
                <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                  The verification layer is designed to expose the information
                  later reviewers actually care about, rather than forcing them
                  to infer too much from a file alone.
                </p>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
                <DemoInfoCard
                  eyebrow="Integrity"
                  title="Recorded integrity state"
                  body="Reviewers can see whether the current evidence state still matches the recorded completion state and whether mismatch handling is required."
                />
                <DemoInfoCard
                  eyebrow="Timing"
                  title="Timestamp visibility"
                  body="The verification layer exposes timing-related context, timestamp status, and supporting evidence review details where available."
                />
                <DemoInfoCard
                  eyebrow="Custody"
                  title="Traceable review history"
                  body="Important evidence lifecycle events remain visible in a clearer sequence for review, escalation, and later scrutiny."
                />
                <DemoInfoCard
                  eyebrow="Access"
                  title="Review activity context"
                  body="A stronger workflow exposes view and review-related activity instead of leaving later reviewers with only a loose file."
                />
                <DemoInfoCard
                  eyebrow="Output"
                  title="Report-ready by design"
                  body="The verification workflow is paired with a structured report so the same record can travel across legal, compliance, claims, or internal review."
                />
                <DemoInfoCard
                  eyebrow="Limitation"
                  title="Verification is not legal advice"
                  body="PROOVRA verifies the recorded integrity state and supporting review materials. It does not by itself establish truth, authorship, identity, or legal admissibility."
                />
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-[rgba(255,255,255,0.42)] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.10)] md:p-8">
              <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                Best fit
              </div>
              <h2 className="mt-4 text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                Most relevant for workflows where later challenge matters
              </h2>
              <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                This workflow is most relevant when digital material may later
                need review, escalation, dispute handling, or internal scrutiny,
                including legal, compliance, claims, internal investigations,
                journalism, or enterprise evidence handling.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href={SALES_ASSETS.sampleReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </a>

                <Link
                  href={SALES_ASSETS.methodologyUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Methodology
                </Link>

                <Link
                  href={SALES_ASSETS.pricingUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Pricing
                </Link>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-[rgba(255,255,255,0.42)] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.10)] md:p-8">
              <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                Next step
              </div>
              <h2 className="mt-4 text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                Want the full workflow walkthrough?
              </h2>
              <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                The live walkthrough connects the request-demo flow, the
                verification layer, and the report output to your exact use
                case: legal, compliance, claims, internal investigations,
                journalism, or enterprise evidence handling.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link
                  href={SALES_ASSETS.requestDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#b39b86]/42 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Request Demo
                </Link>

                <Link
                  href={SALES_ASSETS.contactSalesUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Contact Sales
                </Link>

                {SALES_ASSETS.bookingUrl ? (
                  <a
                    href={SALES_ASSETS.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                  >
                    Book a Walkthrough
                  </a>
                ) : null}
              </div>

              <div className="mt-8 rounded-[22px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.34)] p-5 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Important limitation
                </div>
                <p className="mt-3 text-[0.96rem] leading-[1.85] text-[#55666a]">
                  PROOVRA verifies the recorded integrity state,
                  timestamp-related context, custody metadata, and supporting
                  review materials for an evidence record. It does not by itself
                  establish truth, authorship, identity, or legal admissibility
                  in a specific jurisdiction.
                </p>
              </div>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}