"use client";

import { Suspense, useId, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  Archive,
  ArrowRight,
  Calendar,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileText,
  Globe2,
  Landmark,
  Lock,
  Monitor,
  Package,
  ScrollText,
  Scale,
  Search,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RequestDemoForm } from "../../components/request-demo-form";
import { SALES_ASSETS } from "../../lib/sales-assets";

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        {children}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mx-auto mt-4 max-w-[820px] text-center text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[2rem]">
      {children}
    </h2>
  );
}

function HeroSection({ isEnterpriseTrack }: { isEnterpriseTrack: boolean }) {
  const lifecycle: { label: string; icon: LucideIcon; bg: string }[] = [
    { label: "Capture", icon: Camera, bg: "linear-gradient(135deg,#FB923C,#F97316)" },
    { label: "Preserve", icon: Archive, bg: "linear-gradient(135deg,#2563EB,#1D4ED8)" },
    { label: "Verify", icon: ShieldCheck, bg: "linear-gradient(135deg,#A78BFA,#7C3AED)" },
    { label: "Report", icon: FileText, bg: "linear-gradient(135deg,#22D3EE,#06B6D4)" },
    { label: "Govern", icon: ScrollText, bg: "linear-gradient(135deg,#F472B6,#EC4899)" },
  ];

  const trustBullets = [
    "Tailored to your use case",
    "Live platform walkthrough",
    "Security & governance review",
    "Enterprise deployment guidance",
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
          backgroundImage:
            "url('/assets/backgrounds/proovra-page-hero-bg.png')",
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
            "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(255,255,255,0.42) 52%, rgba(255,255,255,0.22) 100%)",
        }}
      />

      <div className="relative mx-auto grid max-w-7xl gap-10 px-6 pb-12 pt-14 md:px-8 md:pb-16 md:pt-18 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:pt-20">
        <div className="lg:pt-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            {isEnterpriseTrack ? "Enterprise Inquiry" : "Request a Demo"}
          </div>

          <h1 className="mt-5 max-w-[620px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.03em] text-[#0F172A] md:text-[2.5rem] lg:text-[2.9rem]">
            Request a personalized{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, #F97316 0%, #EC4899 50%, #7C3AED 100%)",
              }}
            >
              PROOVRA walkthrough.
            </span>
          </h1>

          <p className="mt-5 max-w-[540px] text-[0.96rem] leading-[1.7] text-[#475569] md:text-[1rem]">
            See how capture, verification, reporting, and governance fit your
            review workflow.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
            {lifecycle.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.label} className="flex items-center gap-2">
                  <span
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white shadow-[0_8px_18px_rgba(15,23,42,0.10)]"
                    style={{ background: step.bg }}
                  >
                    <Icon size={16} strokeWidth={2.4} />
                  </span>
                  <span className="text-[0.86rem] font-medium text-[#0F172A]">
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {trustBullets.map((b) => (
              <div
                key={b}
                className="flex items-start gap-2 text-[13px] text-[#475569]"
              >
                <CheckCircle2
                  size={16}
                  className="mt-[1px] shrink-0 text-[#2563EB]"
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
      className="request-demo-card overflow-hidden rounded-[22px] border border-white/50 bg-white/[0.82] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-lg md:p-6"
    >
      <div className="text-[1.15rem] font-semibold tracking-[-0.02em] text-[#0F172A] md:text-[1.25rem]">
        Request a Demo
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.5] text-[#475569]">
        Fill out the form and our team will get back to you within 1 business
        day.
      </p>

      <RequestDemoForm
        sourcePath={sourcePath}
        submitButtonLabel="Request demo"
      />

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

function WhatYoullSee() {
  const cards: {
    icon: LucideIcon;
    title: string;
    body: string;
    chipBg: string;
    chipText: string;
  }[] = [
    {
      icon: Camera,
      title: "Evidence Capture",
      body: "See how records are captured and converted into structured evidence with integrity signals.",
      chipBg: "linear-gradient(135deg,#FB923C,#F97316)",
      chipText: "#F97316",
    },
    {
      icon: ShieldCheck,
      title: "Verification",
      body: "Explore how integrity, context, and provenance are verified and reviewed with confidence.",
      chipBg: "linear-gradient(135deg,#A78BFA,#7C3AED)",
      chipText: "#7C3AED",
    },
    {
      icon: FileText,
      title: "Reports",
      body: "See how reviewer-ready reports, audit trails, and disclosure packages are generated.",
      chipBg: "linear-gradient(135deg,#22D3EE,#06B6D4)",
      chipText: "#06B6D4",
    },
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <Eyebrow>What you&apos;ll see</Eyebrow>
        <SectionTitle>
          A tailored walkthrough of the platform in action.
        </SectionTitle>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.title}
                className="relative overflow-hidden rounded-[22px] border border-white/40 bg-white/50 p-6 shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-white/60 hover:bg-white/60 hover:shadow-[0_18px_44px_rgba(15,23,42,0.07)]"
              >
                <span
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-[0_8px_18px_rgba(15,23,42,0.10)]"
                  style={{ background: c.chipBg }}
                >
                  <Icon size={22} strokeWidth={2.2} />
                </span>
                <h3 className="mt-5 text-[1.1rem] font-semibold tracking-[-0.01em] text-[#0F172A]">
                  {c.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-[1.6] text-[#475569]">
                  {c.body}
                </p>
                <div
                  className="mt-5 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold"
                  style={{ color: c.chipText }}
                >
                  Learn more
                  <ArrowRight size={12} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GradientIconFrame({
  Icon,
  size = "md",
}: {
  Icon: LucideIcon;
  size?: "sm" | "md";
}) {
  const rawId = useId();
  const gradientId = `proovraIconGradient-${rawId.replace(/:/g, "")}`;

  const box =
    size === "sm"
      ? "h-11 w-11 rounded-[12px]"
      : "h-12 w-12 rounded-[14px]";

  const inner =
    size === "sm"
      ? "rounded-[10.5px]"
      : "rounded-[12.5px]";

  const iconSize = size === "sm" ? 19 : 21;

  return (
    <span
      className={`relative inline-flex ${box} items-center justify-center p-[1.5px] shadow-[0_8px_18px_rgba(124,58,237,0.08)]`}
      style={{
        background: "linear-gradient(135deg,#5B21B6 0%,#EC4899 100%)",
      }}
    >
      <svg width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#5B21B6" />
            <stop offset="55%" stopColor="#7C3AED" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
      </svg>

      <span
        className={`flex h-full w-full items-center justify-center ${inner}`}
        style={{
          background: "rgba(255,255,255,0.72)",
        }}
      >
        <Icon
          size={iconSize}
          strokeWidth={2.6}
          fill="none"
          style={{
            stroke: `url(#${gradientId})`,
          }}
        />
      </span>
    </span>
  );
}

function WhoThisIsFor() {
  const cards: { icon: LucideIcon; label: string }[] = [
    { icon: Shield, label: "Insurance" },
    { icon: Scale, label: "Legal" },
    { icon: Landmark, label: "Government" },
    { icon: ClipboardCheck, label: "Compliance" },
    { icon: Camera, label: "Journalism" },
    { icon: Search, label: "Corporate Investigations" },
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <Eyebrow>Who this is for</Eyebrow>
        <SectionTitle>
          Built for teams with high-stakes review needs.
        </SectionTitle>

        <div className="mx-auto mt-10 grid max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.label}
className="flex flex-col items-center justify-center rounded-[16px] border border-white/40 bg-white/40 p-4 text-center shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-white/70 hover:bg-white/60 hover:shadow-[0_14px_40px_rgba(15,23,42,0.06)]"
              >
<GradientIconFrame Icon={Icon} />
                <div className="mt-3 text-[12.5px] font-semibold leading-[1.3] text-[#0F172A]">
                  {c.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WhatHappensNext() {
  const steps: { icon: LucideIcon; title: string; body: string; bg: string }[] = [
    {
      icon: FileText,
      title: "Request",
      body: "Submit the form and tell us about your use case.",
      bg: "linear-gradient(135deg,#FB923C,#F97316)",
    },
    {
      icon: Eye,
      title: "Review",
      body: "We review your needs and prepare a tailored demo.",
      bg: "linear-gradient(135deg,#3B82F6,#2563EB)",
    },
    {
      icon: Calendar,
      title: "Schedule",
      body: "Pick a time that works best for your team.",
      bg: "linear-gradient(135deg,#A78BFA,#7C3AED)",
    },
    {
      icon: Monitor,
      title: "Live Demo",
      body: "See PROOVRA in action and get your questions answered.",
      bg: "linear-gradient(135deg,#22D3EE,#06B6D4)",
    },
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <Eyebrow>What happens next</Eyebrow>
        <SectionTitle>From request to results in four simple steps.</SectionTitle>

        <div className="relative mt-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-8 hidden border-t border-dashed border-[#E2E8F0] lg:block"
          />
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <div
                  key={s.title}
                  className="relative flex flex-col items-center text-center"
                >
                  <span
                    className="flex h-16 w-16 items-center justify-center rounded-2xl text-white shadow-[0_12px_24px_rgba(15,23,42,0.10)] ring-4 ring-[var(--proovra-page-bg)]"
                    style={{ background: s.bg }}
                  >
                    <Icon size={26} strokeWidth={2.2} />
                  </span>
                  <div className="mt-5 text-[13px] font-semibold text-[#0F172A]">
                    {i + 1}. {s.title}
                  </div>
                  <p className="mt-1.5 max-w-[200px] text-[12.5px] leading-[1.55] text-[#475569]">
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

function EnterpriseReady() {
  const features: {
    icon: LucideIcon;
    title: string;
    body: string;
    tint: string;
    border: string;
    iconColor: string;
  }[] = [
    {
      icon: ShieldCheck,
      title: "Security Review",
      body: "SLA-backed uptime, SSO, and role-based access.",
      tint: "linear-gradient(180deg,#EFF6FF 0%,#FFFFFF 100%)",
      border: "#BFDBFE",
      iconColor: "#2563EB",
    },
    {
      icon: ScrollText,
      title: "Governance Controls",
      body: "Audit trails, approval flows, and retention policies.",
      tint: "linear-gradient(180deg,#F5F3FF 0%,#FFFFFF 100%)",
      border: "#DDD6FE",
      iconColor: "#7C3AED",
    },
    {
      icon: Archive,
      title: "Retention Policies",
      body: "Customizable data retention and legal hold support.",
      tint: "linear-gradient(180deg,#FDF2F8 0%,#FFFFFF 100%)",
      border: "#FBCFE8",
      iconColor: "#DB2777",
    },
    {
      icon: Activity,
      title: "Audit Trails",
      body: "Complete visibility into every action and data change.",
      tint: "linear-gradient(180deg,#EFF6FF 0%,#FFFFFF 100%)",
      border: "#BFDBFE",
      iconColor: "#2563EB",
    },
    {
      icon: Package,
      title: "Verification Packages",
      body: "Exportable packages for legal, compliance, and disclosure.",
      tint: "linear-gradient(180deg,#F5F3FF 0%,#FFFFFF 100%)",
      border: "#DDD6FE",
      iconColor: "#7C3AED",
    },
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div className="relative overflow-hidden rounded-[24px] border border-[#E2E8F0] bg-white p-6 shadow-[0_20px_44px_rgba(15,23,42,0.06)] md:p-9">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 92% 12%, rgba(124,58,237,0.07), transparent 45%), radial-gradient(circle at 8% 88%, rgba(37,99,235,0.05), transparent 40%)",
            }}
          />
          <div className="relative grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
                Enterprise ready
              </div>
              <h2 className="mt-4 max-w-[420px] text-[1.5rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[1.75rem]">
                Enterprise-ready from day one.
              </h2>
              <p className="mt-3 max-w-[400px] text-[0.94rem] leading-[1.7] text-[#475569]">
                PROOVRA is designed to meet the security, compliance, and
                governance requirements of the world&apos;s most demanding
                organizations.
              </p>
              <Link
                href="/why-proovra"
                className="group mt-5 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition-all duration-200 hover:gap-1.5"
              >
                Learn about our enterprise capabilities
                <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {features.map((f) => {
                const Icon = f.icon;
                return (
                  <div
                    key={f.title}
                    className="rounded-[16px] border p-4"
                    style={{ background: f.tint, borderColor: f.border }}
                  >
                    <div className="flex items-center gap-2.5">
<GradientIconFrame Icon={Icon} size="sm" />
                      <div className="text-[13.5px] font-semibold text-[#0F172A]">
                        {f.title}
                      </div>
                    </div>
                    <div className="mt-2.5 text-[12.5px] leading-[1.55] text-[#475569]">
                      {f.body}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function _UnusedTrustedByStrip() {
  const items: { icon: LucideIcon; label: string }[] = [
    { icon: Scale, label: "Legal Partners" },
    { icon: Globe2, label: "Global Insurance" },
    { icon: CheckCircle2, label: "Compliance Solutions" },
    { icon: Landmark, label: "Public Sector Network" },
  ];

  return (
    <section className="bg-[var(--proovra-page-bg)] pb-12 md:pb-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div className="text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
          Trusted by review-sensitive teams
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <div
                key={it.label}
                className="flex items-center justify-center gap-3 opacity-70 transition hover:opacity-100"
              >
                <Icon size={22} className="text-[#94A3B8]" strokeWidth={1.8} />
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                  {it.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function BottomCTA() {
  return (
    <section className="bg-[var(--proovra-page-bg)] pb-16 md:pb-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div
          className="relative overflow-hidden rounded-[24px] border border-[#E2E8F0] bg-white p-7 shadow-[0_20px_44px_rgba(15,23,42,0.06)] md:p-9"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "url('/assets/backgrounds/proovra-page-hero-bg.png')",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right center",
              backgroundSize: "cover",
              opacity: 0.6,
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.75) 45%, rgba(255,255,255,0.50) 100%)",
            }}
          />
          <div className="relative grid gap-5 md:grid-cols-[1.1fr_0.9fr] md:items-center">
            <div>
              <h2 className="text-[1.4rem] font-semibold tracking-[-0.02em] text-[#0F172A] md:text-[1.65rem]">
                Ready to modernize your evidence operations?
              </h2>
              <p className="mt-2 max-w-[460px] text-[13.5px] leading-[1.6] text-[#475569]">
                Capture, verify, govern, and share digital evidence with
                confidence.
              </p>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-end">
              <Link
                href="#request-demo-form"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#081A3D] px-6 text-[14px] font-semibold text-white shadow-[0_10px_24px_rgba(8,26,61,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(8,26,61,0.36)]"
              >
                Request demo
                <ArrowRight size={14} />
              </Link>
              <Link
                href={SALES_ASSETS.contactSalesUrl}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-6 text-[14px] font-semibold text-[#0F172A] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-[#CBD5E1] hover:shadow-[0_10px_20px_rgba(15,23,42,0.06)]"
              >
                Talk to Sales
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function RequestDemoPageContent() {
  const searchParams = useSearchParams();
  const isEnterpriseTrack = searchParams.get("track") === "enterprise";

  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <MarketingHeader />
      <HeroSection isEnterpriseTrack={isEnterpriseTrack} />
      <WhatYoullSee />
      <WhoThisIsFor />
      <WhatHappensNext />
      <EnterpriseReady />
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
