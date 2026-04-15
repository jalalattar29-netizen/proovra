import Link from "next/link";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { RequestDemoForm } from "../../components/request-demo-form";
import { SALES_ASSETS } from "../../lib/sales-assets";

function SalesCard({
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

export default function ContactSalesPage() {
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
            <div className="max-w-[860px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Contact Sales
              </div>

              <h1 className="mt-5 max-w-[820px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                For enterprise, procurement, shared review, and high-volume
                evidence workflows
              </h1>

              <p className="mt-5 max-w-[780px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                Use this route when you need shared access, team review
                workflows, retention-policy alignment, procurement discussion,
                governance review, or enterprise rollout planning.
              </p>

              <div className="mt-5 rounded-[20px] border border-white/10 bg-white/[0.05] p-4 backdrop-blur-sm">
                <div className="text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#dce3e0]">
                  Enterprise review window
                </div>
                <p className="mt-2 text-[0.94rem] leading-[1.75] text-[#c7cfcc]">
                  Complete enterprise inquiries are typically reviewed{" "}
                  {SALES_ASSETS.expectedEnterpriseResponseWindowText}, depending
                  on workflow clarity, urgency, and commercial fit.
                </p>
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
                  href={SALES_ASSETS.pricingUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Pricing
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
        <div className="container relative z-10">
          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
            <SalesCard
              eyebrow="Teams"
              title="Shared workflows and internal review"
              body="Best for teams that need shared access, handoff clarity, reviewer visibility, and a cleaner evidence review process across departments or stakeholders."
            />
            <SalesCard
              eyebrow="Governance"
              title="Retention and control questions"
              body="Use this track when retention, security review, governance controls, or operational policy alignment matter before rollout."
            />
            <SalesCard
              eyebrow="Commercial"
              title="Procurement and rollout planning"
              body="Use this track when the discussion is no longer just product discovery, but evaluation, pricing, rollout fit, procurement, and team adoption."
            />
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
            <div className="rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-[rgba(255,255,255,0.42)] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.10)] md:p-8">
              <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                Best used when
              </div>
              <h2 className="mt-4 text-[1.42rem] font-semibold leading-[1.12] tracking-[-0.03em] text-[#1d3136] md:text-[1.75rem] lg:text-[2.08rem]">
                Your workflow is bigger than a simple product walkthrough
              </h2>
              <p className="mt-4 max-w-[900px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                Choose this route if you need answers around team review,
                organization setup, evidence retention, governance
                requirements, procurement questions, or deployment planning.
              </p>

              <div className="mt-8 rounded-[22px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.34)] p-5 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                <div className="text-[0.78rem] font-semibold uppercase tracking-[0.2em] text-[#8e7863]">
                  Before you submit
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div>
                    <div className="text-[0.9rem] font-semibold text-[#23373b]">
                      What we discuss
                    </div>
                    <p className="mt-2 text-[0.94rem] leading-[1.75] text-[#55666a]">
                      Shared review roles, deployment shape, retention needs,
                      enterprise constraints, and workflow fit.
                    </p>
                  </div>
                  <div>
                    <div className="text-[0.9rem] font-semibold text-[#23373b]">
                      Best for
                    </div>
                    <p className="mt-2 text-[0.94rem] leading-[1.75] text-[#55666a]">
                      Teams evaluating PROOVRA across departments, procurement,
                      governance, audit, or operational rollout.
                    </p>
                  </div>
                  <div>
                    <div className="text-[0.9rem] font-semibold text-[#23373b]">
                      Important limitation
                    </div>
                    <p className="mt-2 text-[0.94rem] leading-[1.75] text-[#55666a]">
                      PROOVRA provides verification and evidence workflow
                      structure. It does not by itself constitute legal advice
                      or jurisdiction-specific admissibility analysis.
                    </p>
                  </div>
                </div>
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
                <h2 className="text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                  Submit enterprise inquiry
                </h2>
                <p className="mt-3 max-w-[760px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                  Share your team, review flow, rollout constraints, and use
                  case. We route these submissions for enterprise handling.
                </p>

                <RequestDemoForm
                  sourcePath="/contact-sales"
                  submitButtonLabel="Submit enterprise inquiry"
                />
              </div>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}