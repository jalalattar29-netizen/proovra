"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import {
  ArrowRight,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Cloud,
  FileSearch,
  Fingerprint,
  Globe,
  KeyRound,
  Lock,
  Quote,
  Scale,
  Server,
  Settings2,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { ContactSalesForm } from "../../components/contact-sales-form";
import { SALES_ASSETS } from "../../lib/sales-assets";

/* ─── Pricing-style gradient icon system ──────────────────────────────── */

/**
 * Mirrors the Pricing page treatment: outer gradient ring → white inset →
 * outline lucide icon whose stroke is filled with the same gradient via
 * SVG `url(#id)` reference. Sizes target a 30-40% bump over the previous
 * solid-tinted icons so visual weight matches Pricing feature icons.
 */
type IconSize = "table" | "quote" | "stake" | "deploy";

const ICON_SIZE_TABLE: Record<
  IconSize,
  { frame: string; inset: string; icon: number }
> = {
  table: { frame: "h-11 w-11", inset: "rounded-[13px]", icon: 22 },
  quote: { frame: "h-12 w-12", inset: "rounded-[14px]", icon: 22 },
  stake: { frame: "h-14 w-14", inset: "rounded-[16px]", icon: 26 },
  deploy: { frame: "h-16 w-16", inset: "rounded-[18px]", icon: 30 },
};

function GradientIconFrame({
  Icon,
  gradientId,
  ringGradientCss,
  size = "stake",
}: {
  Icon: LucideIcon;
  gradientId: string;
  ringGradientCss: string;
  size?: IconSize;
}) {
  const s = ICON_SIZE_TABLE[size];
  return (
    <span
      className={`inline-flex ${s.frame} shrink-0 items-center justify-center rounded-2xl p-[2.5px] shadow-[0_8px_18px_rgba(15,23,42,0.06)]`}
      style={{ background: ringGradientCss }}
    >
      <span
        className={`cs-grad-icon flex h-full w-full items-center justify-center ${s.inset} bg-white`}
        style={{ ["--cs-grad" as string]: `url(#${gradientId})` } as CSSProperties}
      >
        <Icon size={s.icon} strokeWidth={1.85} />
      </span>
    </span>
  );
}

/** Single SVG defs block with every gradient the page references. */
function ContactSalesIconGradients() {
  const grads: { id: string; stops: string[] }[] = [
    { id: "csDeployCloud", stops: ["#06B6D4", "#2563EB", "#4F46E5"] },
    { id: "csDeployDedicated", stops: ["#14B8A6", "#06B6D4", "#2563EB"] },
    { id: "csDeployPrivate", stops: ["#8B5CFF", "#7C3AED", "#4F46E5"] },
    { id: "csDeployRegional", stops: ["#FB7185", "#EC4899", "#F97316"] },
    { id: "csStakeLegal", stops: ["#2563EB", "#4F46E5"] },
    { id: "csStakeCompliance", stops: ["#0F766E", "#06B6D4"] },
    { id: "csStakeSecurity", stops: ["#8B5CFF", "#7C3AED"] },
    { id: "csStakeProcurement", stops: ["#FB7185", "#F97316"] },
    { id: "csStakeOperations", stops: ["#F000E8", "#C026D3"] },
    { id: "csReviewSSO", stops: ["#49B8FF", "#6E7BFF"] },
    { id: "csReviewSCIM", stops: ["#14B8A6", "#06B6D4"] },
    { id: "csReviewAudit", stops: ["#8B5CFF", "#7C3AED"] },
    { id: "csReviewRetention", stops: ["#C43DFF", "#8B5CFF"] },
    { id: "csReviewAccess", stops: ["#F000E8", "#C026D3"] },
    { id: "csQuote", stops: ["#4F46E5", "#7C3AED", "#C026D3"] },
  ];
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute" }}
    >
      <defs>
        {grads.map((g) => (
          <linearGradient
            key={g.id}
            id={g.id}
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            {g.stops.map((stop, i) => (
              <stop
                key={i}
                offset={`${(i / (g.stops.length - 1)) * 100}%`}
                stopColor={stop}
              />
            ))}
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}

/* Build the inline CSS gradient that mirrors a given <linearGradient> id. */
function ringCss(stops: string[]): string {
  const segs = stops
    .map((c, i) => `${c} ${(i / (stops.length - 1)) * 100}%`)
    .join(", ");
  return `linear-gradient(135deg, ${segs})`;
}

const RING = {
  csDeployCloud: ringCss(["#06B6D4", "#2563EB", "#4F46E5"]),
  csDeployDedicated: ringCss(["#14B8A6", "#06B6D4", "#2563EB"]),
  csDeployPrivate: ringCss(["#8B5CFF", "#7C3AED", "#4F46E5"]),
  csDeployRegional: ringCss(["#FB7185", "#EC4899", "#F97316"]),
  csStakeLegal: ringCss(["#2563EB", "#4F46E5"]),
  csStakeCompliance: ringCss(["#0F766E", "#06B6D4"]),
  csStakeSecurity: ringCss(["#8B5CFF", "#7C3AED"]),
  csStakeProcurement: ringCss(["#FB7185", "#F97316"]),
  csStakeOperations: ringCss(["#F000E8", "#C026D3"]),
  csReviewSSO: ringCss(["#49B8FF", "#6E7BFF"]),
  csReviewSCIM: ringCss(["#14B8A6", "#06B6D4"]),
  csReviewAudit: ringCss(["#8B5CFF", "#7C3AED"]),
  csReviewRetention: ringCss(["#C43DFF", "#8B5CFF"]),
  csReviewAccess: ringCss(["#F000E8", "#C026D3"]),
  csQuote: ringCss(["#4F46E5", "#7C3AED", "#C026D3"]),
} as const;

/* ─── Shared primitives ───────────────────────────────────────────────── */

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        {children}
      </span>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mx-auto mt-4 max-w-[880px] text-center text-[1.75rem] font-bold leading-[1.14] tracking-[-0.02em] text-[#07132B] md:text-[2.15rem]">
      {children}
    </h2>
  );
}

function SectionBody({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto mt-5 max-w-[820px] text-center text-[14.5px] leading-[1.75] text-[#475569]">
      {children}
    </p>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 1 — Hero + enterprise contact form
   ─────────────────────────────────────────────────────────────────────── */

function HeroSection() {
  const supportPoints = [
    "Rollout planning and team structure",
    "Security, SSO, and governance review",
    "Procurement and commercial planning",
    "Integrations, APIs, and operational fit",
  ];

  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/backgrounds/proovra-page-hero-bg.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "100% 100%",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(255,255,255,0.48) 52%, rgba(255,255,255,0.26) 100%)",
        }}
      />

      <div className="relative mx-auto grid max-w-7xl gap-10 px-6 pb-12 pt-14 md:px-8 md:pb-16 md:pt-18 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:pt-20">
        <div className="lg:pt-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            Contact Sales
          </div>

          <h1 className="mt-5 max-w-[640px] text-[2rem] font-bold leading-[1.06] tracking-[-0.03em] text-[#07132B] md:text-[2.35rem] lg:text-[2.65rem]">
            Let&apos;s discuss deployment, governance, and{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg,#06B6D4 0%,#4F46E5 50%,#DB2777 100%)",
              }}
            >
              enterprise adoption.
            </span>
          </h1>

          <p className="mt-5 max-w-[600px] text-[0.96rem] leading-[1.7] text-[#475569] md:text-[1rem]">
            Talk with PROOVRA about rollout planning, procurement, security
            review, governance requirements, integrations, reviewer workflows,
            and operational fit.
          </p>

          {/* Subtle inline check rows — no cards */}
          <ul className="mt-6 grid gap-2.5 pl-0 sm:grid-cols-2">
            {supportPoints.map((p) => (
              <li
                key={p}
                className="flex items-start gap-2 text-[13px] leading-[1.55] text-[#475569]"
                style={{ listStyle: "none" }}
              >
                <CheckCircle2
                  size={15}
                  className="mt-[2px] shrink-0 text-[#15803D]"
                  strokeWidth={2.4}
                />
                {p}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <ContactSalesFormCard />
        </div>
      </div>
    </section>
  );
}

function ContactSalesFormCard() {
  return (
    <div
      id="contact-sales-form"
      className="contact-sales-card overflow-hidden rounded-[22px] border border-white/60 bg-white/[0.88] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-lg md:p-6"
    >
      <div className="text-[1.15rem] font-bold tracking-[-0.02em] text-[#07132B] md:text-[1.25rem]">
        Start an enterprise conversation
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.55] text-[#475569]">
        Tell us what you want to discuss and we&apos;ll route your request to
        the right commercial, security, governance, or deployment contact.
      </p>

      <ContactSalesForm submitButtonLabel="Contact sales" />

      <p className="mt-3 inline-flex items-center gap-2 text-[11.5px] text-[#64748B]">
        <Lock size={12} />
        Your information is secure and only used to respond to your inquiry.
      </p>

      <style jsx>{`
        .contact-sales-card :global(.input),
        .contact-sales-card :global(input.input),
        .contact-sales-card :global(textarea.input),
        .contact-sales-card :global(select.input) {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          color: #0f172a;
          font-size: 13.5px;
          padding: 8px 12px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .contact-sales-card :global(.input:hover) {
          border-color: #cbd5e1;
        }
        .contact-sales-card :global(.input:focus),
        .contact-sales-card :global(.input:focus-visible) {
          outline: none;
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
        }
        .contact-sales-card :global(.input-has-error) {
          border-color: #ef4444;
        }
        .contact-sales-card :global(.input-error) {
          color: #be123c;
          font-size: 12px;
          margin-top: 4px;
        }
      `}</style>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 2 — Why Contact Sales
   ─────────────────────────────────────────────────────────────────────── */

function WhyContactSales() {
  const columns: { title: string; body: string }[] = [
    {
      title: "Commercial fit",
      body: "Pricing model, procurement path, contract needs, expected usage, and purchasing process.",
    },
    {
      title: "Operational fit",
      body: "How PROOVRA maps to cases, teams, reviewers, reports, verification packages, and evidence workflows.",
    },
    {
      title: "Governance fit",
      body: "Access control, legal hold, retention, audit logs, permissions, review responsibilities, and policy expectations.",
    },
  ];

  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1080px] px-6 md:px-8">
        <SectionEyebrow>Why Contact Sales</SectionEyebrow>
        <SectionHeading>
          When evidence operations become organizational, sales becomes the
          right conversation.
        </SectionHeading>
        <SectionBody>
          Contact Sales is for teams that already understand PROOVRA&apos;s
          value and now need to evaluate organizational fit: rollout model,
          governance requirements, security review, procurement, integrations,
          team structure, and operational readiness.
        </SectionBody>

        <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-[#E2E8F0]">
          {columns.map((c) => (
            <div key={c.title} className="md:px-7 lg:px-9">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[0.18em] text-[#0F766E]">
                {c.title}
              </div>
              <span
                aria-hidden="true"
                className="mt-2 block h-[2px] w-9 rounded-full"
                style={{ background: "#14B8A6" }}
              />
              <p className="mt-3 text-[13.5px] leading-[1.7] text-[#475569]">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


/* ───────────────────────────────────────────────────────────────────────
   SECTION 5 — Real questions teams bring to sales
   ─────────────────────────────────────────────────────────────────────── */

const REAL_QUESTIONS = [
  "We need SSO and SCIM before rollout.",
  "We need legal hold and retention policies.",
  "We need reviewer workflows across departments.",
  "We need to understand how verification packages fit our external process.",
  "We need procurement, security, and governance teams in the same conversation.",
  "We need AI assistance, but it must not make legal or factual determinations.",
];

function RealQuestions() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-[1080px] px-6 md:px-8">
        <SectionEyebrow>Real Enterprise Questions</SectionEyebrow>
        <SectionHeading>
          Real questions. Real organizations. Real operating constraints.
        </SectionHeading>
        <SectionBody>
          Enterprise conversations are rarely about one feature. They are
          usually about how evidence workflows, governance controls, security
          requirements, and operational responsibilities come together inside
          an organization.
        </SectionBody>

        <ol className="mx-auto mt-12 max-w-[880px] divide-y divide-[#E5E7EB] border-y border-[#E5E7EB] pl-0">
          {REAL_QUESTIONS.map((q, i) => (
            <li
              key={q}
              className={`relative flex items-start gap-4 px-2 py-6 ${
                i % 2 === 1 ? "bg-white/60" : ""
              }`}
              style={{ listStyle: "none" }}
            >
              <GradientIconFrame
                Icon={Quote}
                gradientId="csQuote"
                ringGradientCss={RING.csQuote}
                size="quote"
              />
              <blockquote className="text-[16px] font-semibold leading-[1.55] tracking-[-0.005em] text-[#0F172A] md:text-[17.5px]">
                &ldquo;{q}&rdquo;
              </blockquote>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}


/* ───────────────────────────────────────────────────────────────────────
   SECTION 6 — Deployment Models  (cyan / blue accents)
   ─────────────────────────────────────────────────────────────────────── */

const DEPLOYMENT_MODELS: {
  label: string;
  fits: string;
  why: string;
  requirement: string;
  Icon: LucideIcon;
  gradientId: keyof typeof RING;
  borderColor: string;
  accentBar: string;
}[] = [
  {
    label: "Cloud Deployment",
    fits: "Teams that need fast onboarding without managing infrastructure.",
    why: "Reduced operational burden, managed updates, and a standard security baseline maintained by PROOVRA.",
    requirement: "Speed to value, predictable operational footprint, and a centrally managed environment.",
    Icon: Cloud,
    gradientId: "csDeployCloud",
    borderColor: "rgba(37,99,235,0.18)",
    accentBar: "#2563EB",
  },
  {
    label: "Dedicated Environment",
    fits: "Organizations needing workspace isolation for operational or risk reasons.",
    why: "Dedicated capacity, isolated data boundaries, and tighter operational separation.",
    requirement: "Stricter workspace isolation and performance predictability for sensitive workflows.",
    Icon: Server,
    gradientId: "csDeployDedicated",
    borderColor: "rgba(20,184,166,0.20)",
    accentBar: "#14B8A6",
  },
  {
    label: "Private Deployment",
    fits: "Organizations with internal-network constraints or specific control requirements.",
    why: "Maximum control over network boundaries, identity scope, and operational policies.",
    requirement: "Restricted network access, internal control of identity, and policy ownership inside the organization.",
    Icon: Lock,
    gradientId: "csDeployPrivate",
    borderColor: "rgba(124,58,237,0.18)",
    accentBar: "#7C3AED",
  },
  {
    label: "Regional / Jurisdictional Deployment",
    fits: "Organizations with data-residency, regulatory, or jurisdictional constraints.",
    why: "Operational alignment with regional data-handling and oversight requirements.",
    requirement: "Data residency, regional regulatory alignment, and clear jurisdictional boundaries.",
    Icon: Globe,
    gradientId: "csDeployRegional",
    borderColor: "rgba(251,113,133,0.22)",
    accentBar: "#FB7185",
  },
];

function DeploymentModels() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Deployment Models</SectionEyebrow>
        <SectionHeading>
          Deployment models for different operational requirements.
        </SectionHeading>
        <SectionBody>
          Organizations adopt PROOVRA in different ways depending on
          operational, jurisdictional, and risk constraints. The sales
          conversation helps identify the right deployment shape before
          rollout.
        </SectionBody>

        <div className="mx-auto mt-12 grid max-w-[1120px] gap-5 md:grid-cols-2">
          {DEPLOYMENT_MODELS.map((m) => (
            <div
              key={m.label}
              className="relative overflow-hidden rounded-[24px] border bg-white p-6 shadow-[0_8px_28px_rgba(15,23,42,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)] md:p-7"
              style={{ borderColor: m.borderColor }}
            >
              <GradientIconFrame
                Icon={m.Icon}
                gradientId={m.gradientId}
                ringGradientCss={RING[m.gradientId]}
                size="deploy"
              />

              <h3 className="mt-5 text-[18px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                {m.label}
              </h3>

              <dl className="mt-4 grid gap-3">
                <div>
                  <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                    Who it fits
                  </dt>
                  <dd className="mt-1 text-[13px] leading-[1.6] text-[#475569]">
                    {m.fits}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                    Why organizations choose it
                  </dt>
                  <dd className="mt-1 text-[13px] leading-[1.6] text-[#475569]">
                    {m.why}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                    Operational requirement addressed
                  </dt>
                  <dd className="mt-1 text-[13px] leading-[1.6] text-[#475569]">
                    {m.requirement}
                  </dd>
                </div>
              </dl>

              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-[3px]"
                style={{
                  background: `linear-gradient(90deg, ${m.accentBar} 0%, ${m.accentBar}77 100%)`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 7 — Enterprise Engagement Path  (blue / indigo accents)
   ─────────────────────────────────────────────────────────────────────── */

const ENGAGEMENT_STAGES: {
  title: string;
  objective: string;
  stakeholders: string;
  outcome: string;
  color: string;
}[] = [
  {
    title: "Discovery",
    objective:
      "Understand current evidence operations, primary workflows, and high-level requirements.",
    stakeholders:
      "Operations lead, evidence team owner, line-of-business sponsor.",
    outcome:
      "A clear picture of which workflows and capabilities to evaluate.",
    color: "#2563EB",
  },
  {
    title: "Security Review",
    objective:
      "Evaluate data handling, access boundaries, audit posture, and operational safeguards.",
    stakeholders: "Security, IT, and compliance leads.",
    outcome:
      "Security review path with documented controls and next-step requirements.",
    color: "#0F766E",
  },
  {
    title: "Pilot Evaluation",
    objective:
      "Validate operational fit with a controlled team, workflow, or evidence type.",
    stakeholders:
      "Pilot team, reviewers, governance owner, executive sponsor.",
    outcome:
      "Decision on operational fit and target adoption scope.",
    color: "#7C3AED",
  },
  {
    title: "Rollout Planning",
    objective:
      "Align on rollout scope, phased adoption, contract terms, and onboarding plan.",
    stakeholders:
      "Procurement, legal, executive sponsor, operations owner.",
    outcome: "Adoption plan with phased rollout, timeline, and accountabilities.",
    color: "#F97316",
  },
];

function EnterpriseEngagementPath() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Enterprise Engagement Path</SectionEyebrow>
        <SectionHeading>
          A structured path from first conversation to rollout plan.
        </SectionHeading>
        <SectionBody>
          Enterprise engagements typically move through four stages. Each one
          has a clear objective, defined stakeholders, and an expected outcome
          that informs the next step.
        </SectionBody>

        <div className="relative mt-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-6 right-6 top-7 hidden border-t border-dashed border-[#CBD5E1] lg:block"
          />
          <ol className="grid gap-10 pl-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
            {ENGAGEMENT_STAGES.map((s, i) => (
              <li
                key={s.title}
                className="relative flex flex-col items-start"
                style={{ listStyle: "none" }}
              >
                <span
                  className="inline-flex h-14 w-14 items-center justify-center rounded-full text-[15px] font-extrabold text-white shadow-[0_10px_22px_rgba(15,23,42,0.12)] ring-4 ring-[var(--proovra-page-bg)]"
                  style={{ background: s.color }}
                >
                  {i + 1}
                </span>
                <div className="mt-4 text-[15px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                  {s.title}
                </div>
                <dl className="mt-3 grid gap-2.5">
                  <div>
                    <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                      Objective
                    </dt>
                    <dd className="mt-1 text-[12.5px] leading-[1.6] text-[#475569]">
                      {s.objective}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                      Stakeholders
                    </dt>
                    <dd className="mt-1 text-[12.5px] leading-[1.6] text-[#475569]">
                      {s.stakeholders}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                      Expected outcome
                    </dt>
                    <dd className="mt-1 text-[12.5px] leading-[1.6] text-[#475569]">
                      {s.outcome}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 8 — Stakeholders typically involved  (indigo / violet accents)
   ─────────────────────────────────────────────────────────────────────── */

const STAKEHOLDERS: {
  role: string;
  joins: string;
  questions: string;
  decisions: string;
  Icon: LucideIcon;
  gradientId: keyof typeof RING;
  borderColor: string;
  accentBar: string;
}[] = [
  {
    role: "Legal",
    joins:
      "Owns evidence-handling responsibilities, legal hold, and contract review.",
    questions:
      "Retention obligations, contract terms, jurisdictional fit, and liability boundaries.",
    decisions:
      "Contract execution and legal review of platform handling and retention.",
    Icon: Scale,
    gradientId: "csStakeLegal",
    borderColor: "rgba(37,99,235,0.20)",
    accentBar: "#2563EB",
  },
  {
    role: "Compliance",
    joins:
      "Owns policy enforcement, audit readiness, and ongoing governance posture.",
    questions:
      "How retention, legal hold, audit logs, and access controls align with policy frameworks.",
    decisions:
      "Approval against compliance frameworks and ongoing governance oversight.",
    Icon: ClipboardCheck,
    gradientId: "csStakeCompliance",
    borderColor: "rgba(15,118,110,0.20)",
    accentBar: "#0F766E",
  },
  {
    role: "Security",
    joins:
      "Owns access boundaries, identity integration, and operational safeguards.",
    questions:
      "Identity provider compatibility, encryption posture, logging, and access controls.",
    decisions: "Security review sign-off and deployment approval.",
    Icon: ShieldCheck,
    gradientId: "csStakeSecurity",
    borderColor: "rgba(124,58,237,0.20)",
    accentBar: "#7C3AED",
  },
  {
    role: "Procurement",
    joins:
      "Owns commercial terms, vendor onboarding, and the purchasing process.",
    questions:
      "Pricing model, contract structure, vendor risk, and renewal terms.",
    decisions: "Vendor selection and contract execution timeline.",
    Icon: Briefcase,
    gradientId: "csStakeProcurement",
    borderColor: "rgba(251,113,133,0.22)",
    accentBar: "#FB7185",
  },
  {
    role: "Operations",
    joins:
      "Owns day-to-day workflow ownership, team rollout, and ongoing operational fit.",
    questions:
      "Workflow fit, training needs, rollout sequencing, and change-management impact.",
    decisions:
      "Adoption scope, team onboarding, and operational change management.",
    Icon: Settings2,
    gradientId: "csStakeOperations",
    borderColor: "rgba(240,0,232,0.22)",
    accentBar: "#F000E8",
  },
];

function StakeholdersInvolved() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Stakeholders Typically Involved</SectionEyebrow>
        <SectionHeading>
          The right people in the conversation make adoption smoother.
        </SectionHeading>
        <SectionBody>
          Enterprise adoption rarely sits in one department. Including the
          right stakeholders early shortens the path from evaluation to a
          confident rollout decision.
        </SectionBody>

        <div className="mx-auto mt-12 grid max-w-[1200px] gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {STAKEHOLDERS.map((s) => (
            <div
              key={s.role}
              className="relative flex h-full flex-col overflow-hidden rounded-[22px] border bg-white p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(15,23,42,0.08)]"
              style={{ borderColor: s.borderColor }}
            >
              <div
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-[3px]"
                style={{
                  background: `linear-gradient(90deg, ${s.accentBar} 0%, ${s.accentBar}77 100%)`,
                }}
              />

              <GradientIconFrame
                Icon={s.Icon}
                gradientId={s.gradientId}
                ringGradientCss={RING[s.gradientId]}
                size="stake"
              />

              <h3 className="mt-4 text-[16px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                {s.role}
              </h3>

              <dl className="mt-4 grid gap-3 text-[12.5px] leading-[1.55] text-[#475569]">
                <div>
                  <dt className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#64748B]">
                    Why they join
                  </dt>
                  <dd className="mt-1">{s.joins}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#64748B]">
                    Questions they bring
                  </dt>
                  <dd className="mt-1">{s.questions}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#64748B]">
                    Decisions they influence
                  </dt>
                  <dd className="mt-1">{s.decisions}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 9 — Security Review Scope  (purple / magenta accents)
   ─────────────────────────────────────────────────────────────────────── */

const SECURITY_REVIEW: {
  topic: string;
  matters: string;
  evaluates: string;
  affects: string;
  Icon: LucideIcon;
  gradientId: keyof typeof RING;
}[] = [
  {
    topic: "SSO",
    matters:
      "Centralized identity management reduces password risk and standardizes access.",
    evaluates:
      "Compatibility with your IdP (Okta, Azure AD, Google), SAML/OIDC support, and session controls.",
    affects:
      "IdP configuration scope, session-policy alignment, and rollout sequencing per directory.",
    Icon: KeyRound,
    gradientId: "csReviewSSO",
  },
  {
    topic: "SCIM",
    matters:
      "Automated user provisioning supports role lifecycle and clean offboarding.",
    evaluates:
      "Sync model, role-mapping rules, and how deprovisioning is handled across teams.",
    affects:
      "Directory integration scope and ownership boundaries between IT and operations.",
    Icon: Users,
    gradientId: "csReviewSCIM",
  },
  {
    topic: "Audit Logs",
    matters:
      "Activity transparency supports investigations, governance, and regulatory evidence.",
    evaluates:
      "Log scope, retention, export options, and integration with SIEM or log pipelines.",
    affects:
      "Logging integration plan, retention configuration, and ongoing review cadence.",
    Icon: FileSearch,
    gradientId: "csReviewAudit",
  },
  {
    topic: "Retention Policies",
    matters:
      "Lifecycle management aligns evidence with regulatory and storage requirements.",
    evaluates:
      "Policy granularity, time-based vs event-based controls, and override authorities.",
    affects:
      "Policy configuration, retention envelope sizing, and exception handling.",
    Icon: CalendarClock,
    gradientId: "csReviewRetention",
  },
  {
    topic: "Access Controls",
    matters:
      "Least-privilege enforcement protects data boundaries and reviewer separation.",
    evaluates:
      "Role granularity, permission model, and external contributor boundaries.",
    affects:
      "Role taxonomy, workspace configuration, and ongoing access-review cadence.",
    Icon: Fingerprint,
    gradientId: "csReviewAccess",
  },
];

function SecurityReviewScope() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Security Review Scope</SectionEyebrow>
        <SectionHeading>
          Typical security and governance review topics.
        </SectionHeading>
        <SectionBody>
          The security review portion of an enterprise conversation moves
          through a focused set of operational topics. Each topic informs
          deployment planning and ongoing governance.
        </SectionBody>

        <div className="mx-auto mt-12 max-w-[1120px] overflow-hidden rounded-[22px] border border-[#E5E7EB] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <div className="hidden grid-cols-[180px_1fr_1fr_1fr] gap-6 border-b border-[#E5E7EB] bg-[#F8FAFC] px-6 py-3 text-[10.5px] font-extrabold uppercase tracking-[0.18em] text-[#64748B] lg:grid">
            <div>Topic</div>
            <div>Why it matters</div>
            <div>What organizations evaluate</div>
            <div>How it affects deployment</div>
          </div>
          <dl className="divide-y divide-[#E5E7EB]">
            {SECURITY_REVIEW.map((r) => (
              <div
                key={r.topic}
                className="grid grid-cols-1 gap-3 px-6 py-5 lg:grid-cols-[200px_1fr_1fr_1fr] lg:gap-6 lg:py-6"
              >
                <dt className="flex items-center gap-3">
                  <GradientIconFrame
                    Icon={r.Icon}
                    gradientId={r.gradientId}
                    ringGradientCss={RING[r.gradientId]}
                    size="table"
                  />
                  <span className="text-[14px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                    {r.topic}
                  </span>
                </dt>
                <dd>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#64748B] lg:hidden">
                    Why it matters
                  </div>
                  <div className="mt-1 text-[13px] leading-[1.6] text-[#475569] lg:mt-0">
                    {r.matters}
                  </div>
                </dd>
                <dd>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#64748B] lg:hidden">
                    What organizations evaluate
                  </div>
                  <div className="mt-1 text-[13px] leading-[1.6] text-[#475569] lg:mt-0">
                    {r.evaluates}
                  </div>
                </dd>
                <dd>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#64748B] lg:hidden">
                    How it affects deployment
                  </div>
                  <div className="mt-1 text-[13px] leading-[1.6] text-[#475569] lg:mt-0">
                    {r.affects}
                  </div>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 10 — Designed for integrity workflows, not legal conclusions
   ─────────────────────────────────────────────────────────────────────── */

function IntegrityClarification() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div className="mx-auto max-w-[1020px] overflow-hidden rounded-[22px] border border-[#E2E8F0] bg-white p-7 shadow-[0_12px_36px_rgba(15,23,42,0.05)] md:p-9">
          <div className="flex flex-col items-start gap-5 md:flex-row md:items-start md:gap-6">
            <span
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px]"
              style={{
                background:
                  "linear-gradient(135deg, rgba(6,182,212,0.16) 0%, rgba(79,70,229,0.12) 100%)",
                color: "#1D4ED8",
              }}
            >
              <ShieldCheck size={22} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB]">
                Important clarification
              </div>
              <h3 className="mt-2 text-[1.25rem] font-bold tracking-[-0.015em] text-[#07132B] md:text-[1.45rem]">
                Designed for integrity workflows, not legal conclusions.
              </h3>
              <p className="mt-3 text-[13.5px] leading-[1.7] text-[#475569]">
                PROOVRA helps organizations preserve evidence integrity
                signals, maintain custody visibility, structure review
                workflows, generate reports, and support verification
                packages. PROOVRA does not determine factual truth,
                authorship, identity, evidentiary weight, or legal
                admissibility. AI assistance is advisory and does not replace
                human review or legal judgment.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   SECTION 9 — Final CTA
   ─────────────────────────────────────────────────────────────────────── */

function FinalCTA() {
  const trustNotes = [
    "Tailored guidance",
    "Confidential and secure",
    "No obligation",
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] pb-16 md:pb-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div
          className="relative overflow-hidden rounded-[24px] p-8 shadow-[0_20px_44px_rgba(15,23,42,0.12)] md:p-10"
          style={{
            background:
              "linear-gradient(120deg,#06B6D4 0%,#2563EB 28%,#4F46E5 55%,#7C3AED 80%,#DB2777 100%)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at 80% 110%, rgba(15,23,42,0.18), transparent 55%)",
              mixBlendMode: "soft-light",
            }}
          />
          <div className="relative grid gap-6 md:grid-cols-[1.1fr_0.9fr] md:items-center">
            <div>
              <h2
                className="text-[1.55rem] font-bold tracking-[-0.02em] md:text-[1.95rem]"
                style={{ color: "#FFFFFF" }}
              >
                Ready to discuss enterprise fit?
              </h2>
              <p
                className="mt-3 max-w-[560px] text-[14px] leading-[1.7]"
                style={{ color: "rgba(248,250,252,0.92)" }}
              >
                Talk with PROOVRA about rollout planning, governance, security
                review, procurement, integrations, and operational readiness
                for your organization.
              </p>
              <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 pl-0">
                {trustNotes.map((t) => (
                  <li
                    key={t}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold"
                    style={{
                      listStyle: "none",
                      color: "rgba(255,255,255,0.92)",
                    }}
                  >
                    <CheckCircle2 size={13} strokeWidth={2.4} />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-end">
              {/* CTA cleanup: removed duplicate "Contact sales" button — the
                  whole /contact-sales page IS the contact-sales flow. The
                  remaining "Request a demo" button inherits the original
                  primary white-pill treatment. */}
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[14px] font-semibold text-[#0F172A] shadow-[0_10px_24px_rgba(15,23,42,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02]"
              >
                Request a demo
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────────
   Page composition
   ─────────────────────────────────────────────────────────────────────── */

export default function ContactSalesPage() {
  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <ContactSalesIconGradients />
      <style jsx global>{`
        .cs-grad-icon svg path,
        .cs-grad-icon svg line,
        .cs-grad-icon svg circle,
        .cs-grad-icon svg polyline,
        .cs-grad-icon svg polygon,
        .cs-grad-icon svg rect,
        .cs-grad-icon svg ellipse {
          stroke: var(--cs-grad);
        }
      `}</style>
      <MarketingHeader />
      <HeroSection />
      <WhyContactSales />
      <RealQuestions />
      <DeploymentModels />
      <EnterpriseEngagementPath />
      <StakeholdersInvolved />
      <SecurityReviewScope />
      <IntegrityClarification />
      <FinalCTA />
      <EnterpriseFooter />
    </div>
  );
}
