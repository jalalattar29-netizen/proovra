"use client";

import { useMemo, useState } from "react";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { Button, Input, Select, useToast } from "../../components/ui";

function DemoCard({
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

type FormState = {
  fullName: string;
  workEmail: string;
  organization: string;
  jobTitle: string;
  country: string;
  teamSize: string;
  useCase: string;
  message: string;
  website: string;
};

type FormErrors = Partial<Record<keyof FormState, string>>;

const TEAM_SIZE_OPTIONS = [
  { value: "1-5", label: "1–5" },
  { value: "6-20", label: "6–20" },
  { value: "21-50", label: "21–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-1000", label: "201–1000" },
  { value: "1000+", label: "1000+" },
];

function validateForm(values: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!values.fullName.trim()) {
    errors.fullName = "Full name is required.";
  } else if (values.fullName.trim().length < 2) {
    errors.fullName = "Enter a valid full name.";
  }

  if (!values.workEmail.trim()) {
    errors.workEmail = "Work email is required.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.workEmail.trim())) {
    errors.workEmail = "Enter a valid email address.";
  }

  if (!values.useCase.trim()) {
    errors.useCase = "Use case is required.";
  } else if (values.useCase.trim().length < 10) {
    errors.useCase = "Please provide a bit more detail.";
  }

  if (values.message.trim().length > 5000) {
    errors.message = "Message is too long.";
  }

  return errors;
}

export default function RequestDemoPage() {
  const { addToast } = useToast();

  const [form, setForm] = useState<FormState>({
    fullName: "",
    workEmail: "",
    organization: "",
    jobTitle: "",
    country: "",
    teamSize: "",
    useCase: "",
    message: "",
    website: "",
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const methodologyUrl = "/legal/verification-methodology";
  const sampleReportUrl = "/brand/sample-report.pdf";

  const payload = useMemo(
    () => ({
      fullName: form.fullName.trim(),
      workEmail: form.workEmail.trim(),
      organization: form.organization.trim() || null,
      jobTitle: form.jobTitle.trim() || null,
      country: form.country.trim() || null,
      teamSize: form.teamSize.trim() || null,
      useCase: form.useCase.trim(),
      message: form.message.trim() || null,
      website: form.website.trim() || null,
      source:
        typeof window !== "undefined"
          ? document.referrer
            ? "website_referral"
            : "website_direct"
          : "website",
      sourcePath: "/request-demo",
      referrer:
        typeof window !== "undefined" ? document.referrer || null : null,
      utmSource:
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("utm_source")
          : null,
      utmMedium:
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("utm_medium")
          : null,
      utmCampaign:
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("utm_campaign")
          : null,
      utmTerm:
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("utm_term")
          : null,
      utmContent:
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("utm_content")
          : null,
    }),
    [form]
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const nextErrors = validateForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      addToast("Please fix the highlighted fields.", "warning");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/request-demo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
const errorMessage =
  data?.error?.message ||
  data?.error ||
  data?.message ||
  "Unable to submit your request right now.";
          addToast(errorMessage, "error");
        return;
      }

      setIsSubmitted(true);
      setForm({
        fullName: "",
        workEmail: "",
        organization: "",
        jobTitle: "",
        country: "",
        teamSize: "",
        useCase: "",
        message: "",
        website: "",
      });
      setErrors({});
      addToast("Demo request submitted successfully.", "success");
    } catch {
      addToast("Network error while submitting the demo request.", "error");
    } finally {
      setIsSubmitting(false);
    }
  }

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
            <div className="max-w-[820px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Request Demo
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                See how PROOVRA fits into
                <span className="text-[#bfe8df]"> high-scrutiny evidence workflows</span>
              </h1>

              <p className="mt-5 max-w-[760px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                Request a walkthrough for legal, compliance, claims,
                investigations, journalism, or review-sensitive operational
                workflows. We will show how evidence records, verification
                pages, and structured reports fit together.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href={sampleReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </a>

                <a
                  href={methodologyUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Methodology
                </a>
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
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
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
                  Request a demo
                </h2>

                <p className="mt-3 max-w-[760px] text-[0.98rem] leading-[1.85] text-[#55666a]">
                  Share your use case and we will route your request for review.
                </p>

                {isSubmitted ? (
                  <div className="mt-8 rounded-[22px] border border-[rgba(79,112,107,0.22)] bg-[rgba(255,255,255,0.45)] p-6 text-[#33464a] shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                    <div className="text-[0.82rem] font-semibold uppercase tracking-[0.22em] text-[#8e7863]">
                      Received
                    </div>
                    <h3 className="mt-3 text-[1.1rem] font-semibold text-[#1d3136]">
                      Your request has been submitted
                    </h3>
                    <p className="mt-3 text-[0.98rem] leading-[1.8] text-[#55666a]">
                      Our team will review your request and follow up if your
                      workflow is a good fit for a live demo.
                    </p>
                    <div className="mt-6">
                      <Button
                        onClick={() => setIsSubmitted(false)}
                        className="rounded-[16px] px-5 py-3 text-[0.95rem] font-medium hover-button-secondary"
                      >
                        Submit another request
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="mt-8 grid gap-5">
                    <div className="grid gap-5 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Full name *
                        </label>
                        <Input
                          value={form.fullName}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, fullName: value }))
                          }
                          error={errors.fullName}
                          placeholder="Jane Doe"
                          className="min-h-[48px]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Work email *
                        </label>
                        <Input
                          value={form.workEmail}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, workEmail: value }))
                          }
                          error={errors.workEmail}
                          placeholder="jane@company.com"
                          type="email"
                          className="min-h-[48px]"
                        />
                      </div>
                    </div>

                    <div className="grid gap-5 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Organization
                        </label>
                        <Input
                          value={form.organization}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, organization: value }))
                          }
                          placeholder="Company name"
                          className="min-h-[48px]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Job title
                        </label>
                        <Input
                          value={form.jobTitle}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, jobTitle: value }))
                          }
                          placeholder="Legal Counsel"
                          className="min-h-[48px]"
                        />
                      </div>
                    </div>

                    <div className="grid gap-5 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Country
                        </label>
                        <Input
                          value={form.country}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, country: value }))
                          }
                          placeholder="Germany"
                          className="min-h-[48px]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                          Team size
                        </label>
                        <Select
                          value={form.teamSize}
                          onChange={(value) =>
                            setForm((prev) => ({ ...prev, teamSize: value }))
                          }
                          options={TEAM_SIZE_OPTIONS}
                          className="min-h-[48px]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                        Primary use case *
                      </label>
                      <textarea
                        value={form.useCase}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, useCase: e.target.value }))
                        }
                        placeholder="Describe your review, compliance, legal, claims, or investigation workflow."
                        className={`input min-h-[140px] w-full resize-y ${
                          errors.useCase ? "input-has-error" : ""
                        }`}
                      />
                      {errors.useCase ? (
                        <div className="input-error">{errors.useCase}</div>
                      ) : null}
                    </div>

                    <div>
                      <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
                        Additional context
                      </label>
                      <textarea
                        value={form.message}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, message: e.target.value }))
                        }
                        placeholder="Anything else we should know before reviewing the request?"
                        className={`input min-h-[120px] w-full resize-y ${
                          errors.message ? "input-has-error" : ""
                        }`}
                      />
                      {errors.message ? (
                        <div className="input-error">{errors.message}</div>
                      ) : null}
                    </div>

                    <div className="hidden" aria-hidden="true">
                      <label htmlFor="website">Website</label>
                      <input
                        id="website"
                        name="website"
                        type="text"
                        value={form.website}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, website: e.target.value }))
                        }
                        autoComplete="off"
                        tabIndex={-1}
                      />
                    </div>

                    <div className="flex flex-col gap-3 sm:flex-row">
                      <Button
                        type="submit"
                        disabled={isSubmitting}
                        className="rounded-[16px] px-6 py-3 text-[0.95rem] font-medium hover-button-primary"
                      >
                        {isSubmitting ? "Submitting..." : "Submit demo request"}
                      </Button>

                      <a
                        href="/pricing"
                        className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                      >
                        View Pricing
                      </a>
                    </div>
                  </form>
                )}
              </div>
            </div>

            <div className="grid gap-6">
              <DemoCard
                eyebrow="What we show"
                title="Real verification workflow"
                body="We show how a file becomes a structured evidence record, what the verification page exposes, and how the report supports later review."
              />
              <DemoCard
                eyebrow="Best for"
                title="Review-sensitive teams"
                body="This is most relevant for legal, compliance, internal investigations, insurance, claims, journalism, and incident-sensitive teams."
              />
              <DemoCard
                eyebrow="Important limitation"
                title="Verification is not legal advice"
                body="PROOVRA verifies the recorded integrity state and supporting review materials. It does not by itself establish truth, authorship, or legal admissibility."
              />
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}