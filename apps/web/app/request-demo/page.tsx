"use client";

import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Briefcase,
  Building2,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Cpu,
  Eye,
  FileText,
  Landmark,
  Link2,
  Lock,
  Newspaper,
  Package,
  Plug,
  Scale,
  ScrollText,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RequestDemoForm } from "../../components/request-demo-form";
import { SALES_ASSETS } from "../../lib/sales-assets";

/* ─── Shared primitives ───────────────────────────────────────────────── */

function SectionBadge({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        {children}
      </span>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mx-auto mt-4 max-w-[860px] text-center text-[1.8rem] font-bold leading-[1.12] tracking-[-0.02em] text-[#0F172A] md:text-[2.2rem]">
      {children}
    </h2>
  );
}

function SectionSubheading({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto mt-4 max-w-[760px] text-center text-[14.5px] leading-[1.65] text-[#475569]">
      {children}
    </p>
  );
}

/* ─── Hero ────────────────────────────────────────────────────────────── */

function HeroSection({ isEnterpriseTrack }: { isEnterpriseTrack: boolean }) {
  // Each chip's icon badge uses a filled circular gradient that matches the
  // brand's PROOVRA hero-scene workflow icons — light-to-dark gradient inside,
  // white glyph, soft outer glow tied to the brand color.
  const chips: {
    label: string;
    Icon: LucideIcon;
    gradient: string;
    glow: string;
  }[] = [
    {
      label: "Capture",
      Icon: Camera,
      gradient: "linear-gradient(135deg,#FB923C 0%,#EA580C 100%)",
      glow: "rgba(234,88,12,0.32)",
    },
    {
      label: "Intake",
      Icon: Link2,
      gradient: "linear-gradient(135deg,#22D3EE 0%,#0891B2 100%)",
      glow: "rgba(8,145,178,0.32)",
    },
    {
      label: "Verify",
      Icon: ShieldCheck,
      gradient: "linear-gradient(135deg,#3B82F6 0%,#1E40AF 100%)",
      glow: "rgba(30,64,175,0.32)",
    },
    {
      label: "Review",
      Icon: Users,
      gradient: "linear-gradient(135deg,#2DD4BF 0%,#0F766E 100%)",
      glow: "rgba(15,118,110,0.32)",
    },
    {
      label: "Govern",
      Icon: Landmark,
      gradient: "linear-gradient(135deg,#F472B6 0%,#EC4899 100%)",
      glow: "rgba(236,72,153,0.34)",
    },
    {
      label: "AI Assist",
      Icon: Sparkles,
      gradient: "linear-gradient(135deg,#A78BFA 0%,#7C3AED 100%)",
      glow: "rgba(124,58,237,0.34)",
    },
  ];

  const trustBullets = [
    "Personalized walkthrough for your use case",
    "Secure intake, verification, and reporting review",
    "Governance, audit, retention, and legal hold walkthrough",
    "Enterprise deployment, integrations, and security discussion",
  ];

  const sourcePath = isEnterpriseTrack
    ? "/request-demo?track=enterprise"
    : "/request-demo";

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
            "linear-gradient(180deg, rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.44) 52%, rgba(255,255,255,0.22) 100%)",
        }}
      />

      <div className="relative mx-auto grid max-w-7xl gap-10 px-6 pb-12 pt-14 md:px-8 md:pb-16 md:pt-18 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:pt-20">
        <div className="lg:pt-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            {isEnterpriseTrack ? "Enterprise Inquiry" : "Request a Demo"}
          </div>

          <h1 className="mt-5 max-w-[620px] text-[2rem] font-bold leading-[1.06] tracking-[-0.03em] text-[#07132B] md:text-[2.4rem] lg:text-[2.7rem]">
            See the complete PROOVRA platform{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg,#2563EB 0%,#4F46E5 50%,#7C3AED 100%)",
              }}
            >
              in action.
            </span>
          </h1>

          <p className="mt-5 max-w-[600px] text-[0.96rem] leading-[1.7] text-[#475569] md:text-[1rem]">
            Book a personalized walkthrough of PROOVRA&apos;s evidence operations
            platform — from secure intake and capture to verification, review,
            reporting, governance, and enterprise deployment.
          </p>

          {/* Platform coverage chips — filled-gradient icon badges.
              Fixed 3 × 2 grid at all breakpoints so the row stays balanced:
              Capture | Intake | Verify  /  Review | Govern | AI Assist. */}
          <div className="mt-7 grid grid-cols-3 gap-2.5">
            {chips.map(({ label, Icon, gradient, glow }) => (
              <span
                key={label}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#E5E7EB] bg-white py-1 pl-1 pr-3.5 text-[12.5px] font-semibold text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
              >
                <span
                  className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: gradient,
                    boxShadow: `0 4px 10px ${glow}, inset 0 1px 0 rgba(255,255,255,0.35)`,
                  }}
                >
                  <Icon size={12} strokeWidth={2.4} className="text-white" />
                </span>
                {label}
              </span>
            ))}
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {trustBullets.map((b) => (
              <div
                key={b}
                className="flex items-start gap-2 text-[13px] text-[#475569]"
              >
                <CheckCircle2
                  size={16}
                  className="mt-[1px] shrink-0 text-[#15803D]"
                  strokeWidth={2.4}
                />
                {b}
              </div>
            ))}
          </div>
        </div>

        <div>
          <RequestDemoFormCard sourcePath={sourcePath} />
        </div>
      </div>
    </section>
  );
}

function RequestDemoFormCard({ sourcePath }: { sourcePath: string }) {
  return (
    <div
      id="request-demo-form"
      className="request-demo-card overflow-hidden rounded-[22px] border border-white/50 bg-white/[0.86] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-lg md:p-6"
    >
      <div className="text-[1.15rem] font-bold tracking-[-0.02em] text-[#07132B] md:text-[1.25rem]">
        Request a Demo
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.55] text-[#475569]">
        Tell us what you want to evaluate and our team will prepare a relevant
        walkthrough.
      </p>

      <RequestDemoForm sourcePath={sourcePath} submitButtonLabel="Request demo" />

      <p className="mt-3 inline-flex items-center gap-2 text-[11.5px] text-[#64748B]">
        <Lock size={12} />
        Your information is secure and will never be shared.
      </p>

      <style jsx>{`
        .request-demo-card :global(.input),
        .request-demo-card :global(input.input),
        .request-demo-card :global(textarea.input),
        .request-demo-card :global(select.input) {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          color: #0f172a;
          font-size: 13.5px;
          padding: 8px 12px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .request-demo-card :global(.input:hover) {
          border-color: #cbd5e1;
        }
        .request-demo-card :global(.input:focus),
        .request-demo-card :global(.input:focus-visible) {
          outline: none;
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
        }
        .request-demo-card :global(.input-has-error) {
          border-color: #ef4444;
        }
        .request-demo-card :global(.input-error) {
          color: #be123c;
          font-size: 12px;
          margin-top: 4px;
        }
      `}</style>
    </div>
  );
}

/* ─── Section 2 — What you can evaluate ───────────────────────────────── */

type EvaluateCard = {
  title: string;
  body: string;
  shows: string[];
  accent: string;
  accentSoft: string;
  Icon: LucideIcon;
  disclaimer?: string;
};

const EVALUATE_CARDS: EvaluateCard[] = [
  {
    title: "Capture & Secure Intake",
    body: "Collect evidence from uploads, devices, staff, clients, witnesses, vendors, or external contributors through controlled intake workflows.",
    shows: [
      "Mobile and web capture",
      "Secure intake links",
      "External submission requests",
      "Upload workflows",
      "Intake review before evidence enters the record",
    ],
    accent: "#EA580C",
    accentSoft: "rgba(234,88,12,0.10)",
    Icon: Camera,
  },
  {
    title: "Verification & Integrity",
    body: "Review integrity signals, timestamps, signatures, custody context, and independent verification results across each evidence record.",
    shows: [
      "SHA-256 integrity checks",
      "RFC 3161 timestamps",
      "OpenTimestamps anchoring",
      "Digital signatures",
      "Verification records",
      "Public verification pages",
    ],
    accent: "#1E40AF",
    accentSoft: "rgba(30,64,175,0.10)",
    Icon: ShieldCheck,
  },
  {
    title: "Reports & Verification Packages",
    body: "Generate review-ready reports and portable verification packages that include records, manifests, hashes, metadata, and audit context.",
    shows: [
      "Review-ready reports",
      "Verification packages",
      "Exportable evidence outputs",
      "Audit context",
      "Package verification workflow",
    ],
    accent: "#DB2777",
    accentSoft: "rgba(219,39,119,0.10)",
    Icon: FileText,
  },
  {
    title: "Cases & Reviewer Operations",
    body: "Organize evidence around claims, incidents, investigations, legal matters, reviewers, assignments, and operational review queues.",
    shows: [
      "Cases and matters",
      "Reviewer assignments",
      "Task workflows",
      "Review queues",
      "Investigation context",
      "Operational dashboards",
    ],
    accent: "#0F766E",
    accentSoft: "rgba(15,118,110,0.10)",
    Icon: Users,
  },
  {
    title: "Governance & Compliance",
    body: "Control retention, legal hold, access, policy enforcement, audit logs, and governance decisions across the evidence lifecycle.",
    shows: [
      "Retention policies",
      "Legal hold",
      "Audit logs",
      "Access controls",
      "Governance workflows",
      "Compliance-ready activity history",
    ],
    accent: "#047857",
    accentSoft: "rgba(4,120,87,0.10)",
    Icon: Landmark,
  },
  {
    title: "AI-Assisted Workflows",
    body: "Use AI assistance to guide evidence collection, detect missing context, prepare reviewers, and support workflow decisions without replacing human judgment.",
    shows: [
      "Capture guidance",
      "Submission review assistance",
      "Missing context detection",
      "Reviewer preparation",
      "Suggested next actions",
      "Advisory AI workflow support",
    ],
    accent: "#7C3AED",
    accentSoft: "rgba(124,58,237,0.10)",
    Icon: Sparkles,
    disclaimer:
      "AI assistance is advisory and does not determine truth, authorship, authenticity, identity, or legal admissibility.",
  },
];

function WhatYouCanEvaluate() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionBadge>Platform Areas Available For Demo</SectionBadge>
        <SectionHeading>
          Choose the workflows that matter to your team.
        </SectionHeading>
        <SectionSubheading>
          PROOVRA demos are tailored around the evidence workflows, review needs,
          governance requirements, and enterprise systems your organization uses.
        </SectionSubheading>

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {EVALUATE_CARDS.map((c) => {
            const Icon = c.Icon;
            return (
              <div
                key={c.title}
                className="relative flex flex-col overflow-hidden rounded-[22px] border border-[#E5E7EB] bg-white p-6 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.06)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                    style={{ background: c.accentSoft, color: c.accent }}
                  >
                    <Icon size={20} strokeWidth={2} />
                  </span>
                  <h3 className="text-[17px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                    {c.title}
                  </h3>
                </div>

                <p className="mt-4 text-[13.5px] leading-[1.6] text-[#475569]">
                  {c.body}
                </p>

                <div className="mt-5">
                  <div className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                    What we can show
                  </div>
                  <ul className="mt-2.5 space-y-1.5 pl-0">
                    {c.shows.map((s) => (
                      <li
                        key={s}
                        className="flex items-start gap-2 text-[12.5px] leading-[1.55] text-[#0F172A]"
                        style={{ listStyle: "none" }}
                      >
                        <span
                          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: c.accent }}
                        />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>

                {c.disclaimer ? (
                  <div className="mt-5 rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[11px] leading-[1.5] text-[#64748B]">
                    {c.disclaimer}
                  </div>
                ) : null}

                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-[3px]"
                  style={{ background: c.accent, opacity: 0.85 }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── Section 3 — Why teams request a demo ────────────────────────────── */

const OUTCOME_CARDS: {
  title: string;
  body: string;
  bestFor: string;
  Icon: LucideIcon;
  color: string;
  soft: string;
}[] = [
  {
    title: "Standardize evidence collection",
    body: "Move away from scattered files, emails, and manual uploads by using structured capture and secure intake workflows.",
    bestFor: "Claims teams, investigators, compliance teams, legal teams",
    Icon: Camera,
    color: "#EA580C",
    soft: "rgba(234,88,12,0.10)",
  },
  {
    title: "Improve review readiness",
    body: "Prepare evidence with metadata, verification signals, reports, packages, and reviewer context before it reaches decision-makers.",
    bestFor: "Review teams, legal operations, claim reviewers, audit teams",
    Icon: Eye,
    color: "#2563EB",
    soft: "rgba(37,99,235,0.10)",
  },
  {
    title: "Strengthen governance",
    body: "Apply retention, legal hold, access control, audit logs, and lifecycle policies across evidence records and workflows.",
    bestFor:
      "Enterprises, regulated organizations, legal departments, public sector teams",
    Icon: Landmark,
    color: "#047857",
    soft: "rgba(4,120,87,0.10)",
  },
  {
    title: "Connect operations at scale",
    body: "Bring capture, intake, verification, cases, reports, reviewers, AI assistance, and integrations into one operational workspace.",
    bestFor:
      "Enterprise teams, multi-location organizations, platform buyers",
    Icon: Plug,
    color: "#7C3AED",
    soft: "rgba(124,58,237,0.10)",
  },
];

function WhyTeamsRequest() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionBadge>Why Teams Request a Demo</SectionBadge>
        <SectionHeading>
          Built for teams that need evidence they can review, trace, and govern.
        </SectionHeading>
        <SectionSubheading>
          PROOVRA helps organizations reduce fragile evidence handling, improve
          review readiness, and create consistent evidence operations across
          people, systems, and workflows.
        </SectionSubheading>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          {OUTCOME_CARDS.map((c) => {
            const Icon = c.Icon;
            return (
              <div
                key={c.title}
                className="relative overflow-hidden rounded-[22px] border border-[#E5E7EB] bg-white p-6 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.06)] md:p-7"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                    style={{ background: c.soft, color: c.color }}
                  >
                    <Icon size={20} strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[18px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                      {c.title}
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-[1.6] text-[#475569]">
                      {c.body}
                    </p>
                  </div>
                </div>
                <div className="mt-5 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] px-3.5 py-2.5">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#64748B]">
                    Best for
                  </span>
                  <div className="mt-1 text-[12.5px] leading-[1.5] text-[#0F172A]">
                    {c.bestFor}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── Section 4 — Who this is for ─────────────────────────────────────── */

const AUDIENCE_CARDS: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
  {
    Icon: Shield,
    title: "Insurance",
    body: "Claims, fraud review, damage documentation, subrogation support.",
    color: "#EA580C",
  },
  {
    Icon: Scale,
    title: "Legal & eDiscovery",
    body: "Matter review, evidence organization, reports, verification packages, audit trails.",
    color: "#2563EB",
  },
  {
    Icon: Search,
    title: "Corporate Investigations",
    body: "Incident response, HR investigations, internal audits, policy violations.",
    color: "#7C3AED",
  },
  {
    Icon: Landmark,
    title: "Government & Public Sector",
    body: "Public records, citizen submissions, investigative evidence, accountability workflows.",
    color: "#0F766E",
  },
  {
    Icon: ClipboardCheck,
    title: "Compliance & Audit",
    body: "Retention, legal hold, audit readiness, policy enforcement, review history.",
    color: "#047857",
  },
  {
    Icon: Newspaper,
    title: "Journalism & Media",
    body: "Source material preservation, media verification, transparent public verification.",
    color: "#BE123C",
  },
  {
    Icon: Building2,
    title: "Enterprise Security",
    body: "Incident evidence, access history, operational review, internal investigations.",
    color: "#1E40AF",
  },
  {
    Icon: Users,
    title: "External Contributors",
    body: "Clients, witnesses, vendors, field teams, and third parties submitting evidence through intake links.",
    color: "#0891B2",
  },
];

function WhoThisIsFor() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionBadge>Who This Is For</SectionBadge>
        <SectionHeading>
          Designed for high-stakes evidence workflows.
        </SectionHeading>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCE_CARDS.map((c) => {
            const Icon = c.Icon;
            return (
              <div
                key={c.title}
                className="rounded-[20px] border border-[#E5E7EB] bg-white p-5 shadow-[0_2px_6px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(15,23,42,0.06)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC]"
                    style={{ color: c.color }}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                  </span>
                  <h3 className="text-[14.5px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                    {c.title}
                  </h3>
                </div>
                <p className="mt-3 text-[12.5px] leading-[1.55] text-[#64748B]">
                  {c.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── Section 5 — Enterprise ready ────────────────────────────────────── */

const ENTERPRISE_CARDS: {
  Icon: LucideIcon;
  title: string;
  body: string;
  color: string;
  soft: string;
}[] = [
  {
    Icon: ShieldCheck,
    title: "Security Review",
    body: "SSO, role-based access, secure architecture, and enterprise deployment discussion.",
    color: "#2563EB",
    soft: "rgba(37,99,235,0.10)",
  },
  {
    Icon: Landmark,
    title: "Governance Controls",
    body: "Retention, legal hold, approval workflows, and policy controls.",
    color: "#047857",
    soft: "rgba(4,120,87,0.10)",
  },
  {
    Icon: ScrollText,
    title: "Audit Trails",
    body: "Complete activity history across records, reviewers, access, reports, and packages.",
    color: "#0F766E",
    soft: "rgba(15,118,110,0.10)",
  },
  {
    Icon: Package,
    title: "Verification Packages",
    body: "Portable evidence outputs with manifests, hashes, reports, and verification metadata.",
    color: "#4F46E5",
    soft: "rgba(79,70,229,0.10)",
  },
  {
    Icon: Plug,
    title: "Integrations & APIs",
    body: "Connect identity, storage, webhooks, APIs, and operational systems your teams already use.",
    color: "#1E40AF",
    soft: "rgba(30,64,175,0.10)",
  },
  {
    Icon: Cpu,
    title: "AI Governance",
    body: "Advisory AI workflows designed to support intake, review preparation, and workflow guidance without determining truth or admissibility.",
    color: "#7C3AED",
    soft: "rgba(124,58,237,0.10)",
  },
];

function EnterpriseReady() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionBadge>Enterprise Ready</SectionBadge>
        <SectionHeading>
          Ready for security, governance, and deployment review.
        </SectionHeading>
        <SectionSubheading>
          PROOVRA is designed for organizations that need controlled access,
          auditability, evidence governance, secure deployment, and operational
          visibility.
        </SectionSubheading>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTERPRISE_CARDS.map((c) => {
            const Icon = c.Icon;
            return (
              <div
                key={c.title}
                className="rounded-[20px] border border-[#E5E7EB] bg-white p-5 shadow-[0_2px_6px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(15,23,42,0.06)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
                    style={{ background: c.soft, color: c.color }}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                  </span>
                  <h3 className="text-[15px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                    {c.title}
                  </h3>
                </div>
                <p className="mt-3 text-[12.5px] leading-[1.6] text-[#64748B]">
                  {c.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── Section 6 — What happens next ───────────────────────────────────── */

const NEXT_STEPS: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
  {
    Icon: FileText,
    title: "Request",
    body: "Submit your use case, organization type, and primary interest.",
    color: "#EA580C",
  },
  {
    Icon: Eye,
    title: "Review",
    body: "Our team reviews your workflow, security needs, and demo priorities.",
    color: "#2563EB",
  },
  {
    Icon: ClipboardCheck,
    title: "Prepare",
    body: "We tailor the walkthrough around your evidence operations, governance, and review needs.",
    color: "#7C3AED",
  },
  {
    Icon: Briefcase,
    title: "Live Demo",
    body: "See the platform in action and discuss next steps, deployment, and pricing.",
    color: "#0F766E",
  },
];

function WhatHappensNext() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionBadge>What Happens Next</SectionBadge>
        <SectionHeading>
          From request to relevant demo in four steps.
        </SectionHeading>

        <div className="relative mt-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-8 hidden border-t border-dashed border-[#E2E8F0] lg:block"
          />
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {NEXT_STEPS.map((s, i) => {
              const Icon = s.Icon;
              return (
                <div
                  key={s.title}
                  className="relative flex flex-col items-center text-center"
                >
                  <span
                    className="flex h-16 w-16 items-center justify-center rounded-2xl text-white shadow-[0_12px_24px_rgba(15,23,42,0.10)] ring-4 ring-[var(--proovra-page-bg)]"
                    style={{ background: s.color }}
                  >
                    <Icon size={26} strokeWidth={2.2} />
                  </span>
                  <div className="mt-5 text-[13.5px] font-extrabold text-[#07132B]">
                    {i + 1}. {s.title}
                  </div>
                  <p className="mt-1.5 max-w-[220px] text-[12.5px] leading-[1.55] text-[#475569]">
                    {s.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Section 7 — Bottom CTA ──────────────────────────────────────────── */

function BottomCTA() {
  return (
    <section className="bg-[var(--proovra-page-bg)] pb-16 md:pb-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div
          className="relative overflow-hidden rounded-[24px] p-7 shadow-[0_20px_44px_rgba(15,23,42,0.10)] md:p-9"
          style={{
            background:
              "linear-gradient(135deg,#1F8E8E 0%,#64717A 48%,#D83A3A 100%)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          {/* Subtle tone-down layer so the gradient feels calm rather than neon. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at 70% 110%, rgba(15,23,42,0.18), transparent 55%)",
              mixBlendMode: "soft-light",
            }}
          />
          <div className="relative grid gap-5 md:grid-cols-[1.1fr_0.9fr] md:items-center">
            <div>
              <h2 className="text-[1.5rem] font-bold tracking-[-0.02em] md:text-[1.85rem]" style={{ color: "#FFFFFF" }}>
                Modernize how your organization handles evidence.
              </h2>
              <p className="mt-2.5 max-w-[520px] text-[13.5px] leading-[1.65]" style={{ color: "#E2E8F0" }}>
                See how PROOVRA connects intake, verification, review, reporting,
                governance, and enterprise operations in one secure platform.
              </p>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-end">
              <Link
                href="#request-demo-form"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[14px] font-semibold text-[#0F172A] shadow-[0_10px_24px_rgba(15,23,42,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(15,23,42,0.30)]"
              >
                Request demo
                <ArrowRight size={14} />
              </Link>
              <Link
                href={SALES_ASSETS.contactSalesUrl}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border px-6 text-[14px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015]"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  borderColor: "rgba(255,255,255,0.35)",
                }}
              >
                Talk to sales
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Page composition ────────────────────────────────────────────────── */

function RequestDemoPageContent() {
  const searchParams = useSearchParams();
  const isEnterpriseTrack = searchParams.get("track") === "enterprise";

  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <MarketingHeader />
      <HeroSection isEnterpriseTrack={isEnterpriseTrack} />
      <WhatYouCanEvaluate />
      <WhyTeamsRequest />
      <WhoThisIsFor />
      <EnterpriseReady />
      <WhatHappensNext />
      <BottomCTA />
      <EnterpriseFooter />
    </div>
  );
}

export default function RequestDemoPage() {
  return (
    <Suspense
      fallback={
        <div className="page landing-page bg-[var(--proovra-page-bg)]">
          <MarketingHeader />
          <div className="mx-auto max-w-7xl px-6 py-20 md:px-8">
            <div className="h-8 w-40 animate-pulse rounded bg-[#E2E8F0]" />
            <div className="mt-4 h-12 w-3/4 animate-pulse rounded bg-[#E2E8F0]" />
          </div>
          <EnterpriseFooter />
        </div>
      }
    >
      <RequestDemoPageContent />
    </Suspense>
  );
}

