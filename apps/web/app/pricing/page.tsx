"use client";

import { type CSSProperties, type ElementType, useEffect, useMemo, useState } from "react";
import Link from "next/link";
// Pricing page icon set — lucide-react only. The phosphor-named aliases
// below preserve the existing JSX so no in-page rename is required:
// e.g. <Sparkle/> still works because we alias lucide's Sparkles to it.
import {
  Anchor as AnchorSimple,
  Archive,
  Briefcase,
  Building2 as Buildings,
  Camera,
  CheckCircle2,
  CheckCircle2 as CheckCircle,
  FileText,
  Fingerprint,
  GitBranch,
  Globe,
  History as ClockCounterClockwise,
  Package,
  PenTool as PenNib,
  ShieldCheck,
  Sparkles as Sparkle,
  Layers as Stack,
  User,
  Users as UsersThree,
  Activity as Pulse,
  ScrollText as Scroll,
} from "lucide-react";
import {
  detectCurrency,
  normalizeCurrency,
  type SupportedCurrency,
} from "../../lib/currency";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { useAuth } from "../providers";
import type { PricingCatalogResponse } from "./types";
import { apiFetch } from "../../lib/api";

type MarketingIcon = ElementType;

type PlanId = "personal" | "payg" | "pro" | "team" | "enterprise";

type PricingPlan = {
  id: PlanId;
  title: string;
  subtitle: string;
  price: string;
  priceSuffix?: string;
  priceNote: string;
  badge?: string;
  icon: MarketingIcon;
  accent: { bg: string; ring: string };
  iconColor: string;
  ctaLabel: string;
  ctaHref: string;
  features: string[];
  featured?: boolean;
  enterprise?: boolean;
};

function formatPlanPrice(
  cents: number | null | undefined,
  currency: SupportedCurrency
): string | null {
  if (cents == null) return null;

  const value = cents / 100;
  const symbol = currency === "EUR" ? "€" : "$";

  return `${symbol}${value.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

function GradientIconFrame({
  children,
  size = "md",
}: {
  children: React.ReactNode;
  size?: "sm" | "md";
}) {
  const frameSize = size === "sm" ? "h-11 w-11" : "h-12 w-12";
  const innerRadius = size === "sm" ? "rounded-[14px]" : "rounded-[15px]";

  return (
    <span
      className={`inline-flex ${frameSize} shrink-0 items-center justify-center rounded-2xl p-[2.5px] shadow-[0_8px_18px_rgba(15,23,42,0.05)]`}
      style={{
        background:
          "linear-gradient(135deg,#2D2A7B 0%,#8A2F9B 48%,#E91E7A 100%)",
      }}
    >
      <span
        className={`flex h-full w-full items-center justify-center ${innerRadius} bg-white`}
      >
        {children}
      </span>
    </span>
  );
}

function ProovraGradientIcon({
  Icon,
  size = 24,
  strokeWidth = 3.1,
  weight = "regular",
}: {
  Icon: MarketingIcon;
  size?: number;
  strokeWidth?: number;
  weight?: "regular" | "bold" | "duotone";
}) {
  // weight kept on the wrapper's prop surface for backwards-compat;
  // lucide-react icons don't accept it, so we don't forward it.
  void weight;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      style={
        {
          color: "url(#proovraOutlineGradient)",
          stroke: "url(#proovraOutlineGradient)",
          strokeWidth,
        } as CSSProperties
      }
    />
  );
}

export default function MarketingPricingPage() {
  const { hasSession } = useAuth();
  const [preferredCurrency, setPreferredCurrency] =
    useState<SupportedCurrency>("USD");
  const [catalog, setCatalog] = useState<PricingCatalogResponse | null>(null);

  useEffect(() => {
    try {
      setPreferredCurrency(detectCurrency());
    } catch {
      setPreferredCurrency("USD");
    }
  }, []);

  useEffect(() => {
    apiFetch(
      `/v1/billing/pricing?currency=${preferredCurrency}`,
      { method: "GET" },
      { auth: false, retryAuthOnce: false }
    )
      .then((data) =>
        setCatalog((data ?? null) as PricingCatalogResponse | null)
      )
      .catch(() => setCatalog(null));
  }, [preferredCurrency]);

  const displayCurrency = useMemo<SupportedCurrency>(() => {
    return normalizeCurrency(catalog?.currency ?? preferredCurrency);
  }, [catalog?.currency, preferredCurrency]);

  const appBilling = "/billing";
  const appRegister = "/register";

  const buildCtaHref = (planId: PlanId): string => {
    if (planId === "enterprise") return "/contact-sales";
    if (!hasSession) return appRegister;
    if (planId === "personal") return `${appBilling}?workspace=personal`;
    if (planId === "team") return `${appBilling}?workspace=team&plan=TEAM`;
    return `${appBilling}?workspace=personal&plan=${planId.toUpperCase()}`;
  };

  const buildCtaLabel = (planId: PlanId): string => {
    if (planId === "enterprise") return "Talk to an expert";
    if (planId === "personal") return "Get started";
    if (planId === "payg") return "Open billing console";
    if (planId === "pro") return "Start Pro plan";
    if (planId === "team") return "Start Team plan";
    return "Choose plan";
  };

  const freePrice = displayCurrency === "EUR" ? "€0" : "$0";
  const paygPrice =
    formatPlanPrice(catalog?.payg?.monthlyPriceCents, displayCurrency) ??
    (displayCurrency === "EUR" ? "€" : "$");
  const proPrice =
    formatPlanPrice(catalog?.pro?.monthlyPriceCents, displayCurrency) ??
    (displayCurrency === "EUR" ? "€19" : "$19");
  const teamPrice =
    formatPlanPrice(catalog?.team?.monthlyPriceCents, displayCurrency) ??
    (displayCurrency === "EUR" ? "€79" : "$79");

  const plans: PricingPlan[] = [
    {
      id: "personal",
      title: "Personal",
      subtitle: "Get started with essential verification.",
      price: freePrice,
      priceNote: "Free forever",
      icon: User,
      accent: {
        bg: "linear-gradient(135deg,#FB923C 0%,#F97316 100%)",
        ring: "rgba(249,115,22,0.22)",
      },
      iconColor: "#F97316",
      ctaLabel: buildCtaLabel("personal"),
      ctaHref: buildCtaHref("personal"),
      features: [
        `${catalog?.free?.maxEvidenceRecords ?? 3} evidence records total`,
        `${catalog?.free?.storageLabel ?? "250 MB"} storage`,
        "Basic integrity signals",
        "Public verification access",
      ],
    },
    {
      id: "payg",
      title: "Per Evidence",
      subtitle: "Use only what you need with flexible pricing.",
      price: paygPrice,
      priceSuffix: "/ evidence",
      priceNote: "One-time checkout",
      icon: Briefcase,
      accent: {
        bg: "linear-gradient(135deg,#3B82F6 0%,#2563EB 100%)",
        ring: "rgba(37,99,235,0.18)",
      },
      iconColor: "#2563EB",
      ctaLabel: buildCtaLabel("payg"),
      ctaHref: buildCtaHref("payg"),
      features: [
        "Pay only when you complete evidence",
        "Verification package included",
        "Optional add-ons",
        "No subscription required",
      ],
    },
    {
      id: "pro",
      title: "Pro",
      subtitle: "For professionals who need more power and storage.",
      price: proPrice,
      priceSuffix: "/month",
      priceNote: "Billed monthly",
      badge: "Most popular",
      featured: true,
      icon: Sparkle,
      accent: {
        bg: "linear-gradient(135deg,#7E22CE 0%,#5B21B6 100%)",
        ring: "rgba(91,33,182,0.24)",
      },
      iconColor: "#5B21B6",
      ctaLabel: buildCtaLabel("pro"),
      ctaHref: buildCtaHref("pro"),
      features: [
        `${catalog?.pro?.maxEvidenceRecords ?? 100} evidence records included`,
        `${catalog?.pro?.storageLabel ?? "100 GB"} storage`,
        "Reports & verification packages included",
        `AI assistance: ${catalog?.pro?.aiAdvisoryMonthlyOperations ?? 100} operations / month`,
        "Personal workspace",
      ],
    },
    {
      id: "team",
      title: "Team",
      subtitle: "Collaborate securely across your team.",
      price: teamPrice,
      priceSuffix: "/month",
      priceNote: "Billed monthly",
      badge: "Best for teams",
      icon: UsersThree,
      accent: {
        bg: "linear-gradient(135deg,#22D3EE 0%,#06B6D4 100%)",
        ring: "rgba(6,182,212,0.22)",
      },
      iconColor: "#06B6D4",
      ctaLabel: buildCtaLabel("team"),
      ctaHref: buildCtaHref("team"),
      features: [
        `${catalog?.team?.maxEvidenceRecordsPerMonth ?? 500} evidence records / month`,
        `${catalog?.team?.storageLabel ?? "500 GB"} storage`,
        `AI assistance: ${catalog?.team?.aiAdvisoryMonthlyOperations ?? 500} operations / month`,
        "Shared workspace, review assignments, team governance",
        `Up to ${catalog?.team?.maxMembersPerTeam ?? 5} members per team`,
      ],
    },
    {
      id: "enterprise",
      title: "Enterprise",
      subtitle: "Custom for your organization's scale, security & governance.",
      price: "Custom",
      priceNote: "Tailored to your needs",
      icon: Buildings,
      accent: {
        bg: "linear-gradient(135deg,#7E22CE 0%,#5B21B6 100%)",
        ring: "rgba(91,33,182,0.34)",
      },
      iconColor: "#7E22CE",
      ctaLabel: "Talk to an expert",
      ctaHref: "/contact-sales",
      enterprise: true,
      features: [
        "Identity & Access",
        "Governance Controls",
        "Preservation Infrastructure",
        "Enterprise Security",
        "Procurement & SLA",
      ],
    },
  ];

  const lifecycleSteps: {
    label: string;
    icon: MarketingIcon;
    bg: string;
    shadow?: string;
  }[] = [
    {
      label: "Capture",
      icon: Camera,
      bg: "linear-gradient(135deg,#FB923C,#F97316)",
    },
    {
      label: "Preserve",
      icon: Archive,
      bg: "linear-gradient(135deg,#2563EB 0%,#1D4ED8 100%)",
      shadow:
        "0 14px 28px rgba(37,99,235,0.28), inset 0 1px 0 rgba(255,255,255,0.35)",
    },
    {
      label: "Verify",
      icon: ShieldCheck,
      bg: "linear-gradient(135deg,#7E22CE,#5B21B6)",
    },
    {
      label: "Report",
      icon: FileText,
      bg: "linear-gradient(135deg,#34D399,#10B981)",
    },
    {
      label: "Govern",
      icon: Scroll,
      bg: "linear-gradient(135deg,#F472B6,#EC4899)",
    },
  ];

  const everyPlanIncludes: { label: string; icon: MarketingIcon }[] = [
    { label: "Reports", icon: FileText },
    { label: "Verification Packages", icon: Package },
    { label: "Public Verification", icon: Globe },
    { label: "SHA-256 Hashing", icon: Fingerprint },
    { label: "RFC 3161 Timestamps", icon: ClockCounterClockwise },
    { label: "OpenTimestamps (OTS)", icon: AnchorSimple },
    { label: "Digital Signatures", icon: PenNib },
    { label: "Chain of Custody", icon: GitBranch },
{ label: "Evidence Lifecycle", icon: Pulse },
    { label: "Tamper-evident Records", icon: ShieldCheck },
  ];

  const enterpriseFeatures: {
    title: string;
    body: string;
    icon: MarketingIcon;
  }[] = [
    {
      title: "Enterprise Identity",
      body: "SAML SSO, SCIM provisioning, MFA enforcement, and centralized access governance.",
      icon: Fingerprint,
    },
    {
      title: "Governance & Compliance",
      body: "Legal hold, retention policies, audit logging, and operational governance controls.",
      icon: Scroll,
    },
    {
      title: "Preservation Infrastructure",
      body: "Immutable storage controls, cryptographic integrity, trusted timestamps, and chain of custody preservation.",
      icon: Archive,
    },
  ];

  const whyChoose: {
    title: string;
    body: string;
    icon: MarketingIcon;
  }[] = [
    {
      title: "Reduce review time",
      body: "Automated verification and audit-ready reports.",
      icon: Briefcase,
    },
    {
      title: "Improve evidence trust",
      body: "Cryptographic integrity and independent timestamps.",
      icon: ShieldCheck,
    },
    {
      title: "Centralize verification",
      body: "One platform for capture to proof.",
      icon: Stack,
    },
    {
      title: "Support audit readiness",
      body: "Governance, retention, and complete audit trails.",
      icon: CheckCircle,
    },
  ];

  const compareRows: (
    | {
        label: string;
        values: [string, string, string, string, string];
        group?: false;
      }
    | { label: string; group: true }
  )[] = [
    {
      label: "Evidence records",
      values: [
        `${catalog?.free?.maxEvidenceRecords ?? 3} total`,
        "Pay only when you complete evidence",
        `${catalog?.pro?.maxEvidenceRecords ?? 100} included`,
        `${catalog?.team?.maxEvidenceRecordsPerMonth ?? 500} / month`,
        "Custom operational volume",
      ],
    },
    {
      label: "Storage included",
      values: [
        catalog?.free?.storageLabel ?? "250 MB",
        catalog?.payg?.storageLabel ?? "5 GB",
        catalog?.pro?.storageLabel ?? "100 GB",
        catalog?.team?.storageLabel ?? "500 GB",
        "Custom storage envelope",
      ],
    },
    {
      label: "Storage add-ons",
      values: [
        "Not available",
        "Optional",
        "Personal top-ups",
        "Team storage top-ups",
        "Commercial planning",
      ],
    },
    {
      label: "Verification package",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "PDF reports",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Public verification page",
      values: ["Included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Workspace support",
      values: [
        "Personal only",
        "Personal only",
        "Personal + team support",
        "Team-first workspace support",
        "Organization deployment",
      ],
    },
    { label: "Platform Operations", group: true },
    {
      label: "Intake links",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Submission requests",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "AI assistance (advisory)",
      values: [
        "Not included",
        `${catalog?.payg?.aiAdvisoryMonthlyOperations ?? 50} ops / month`,
        `${catalog?.pro?.aiAdvisoryMonthlyOperations ?? 100} ops / month`,
        `${catalog?.team?.aiAdvisoryMonthlyOperations ?? 500} ops / month`,
        "Custom AI assistance",
      ],
    },
    {
      label: "Cases & matters",
      values: [
        "Not included",
        "Not included",
        "Personal cases",
        "Team cases",
        "Organization-wide matters",
      ],
    },
    {
      label: "Reviewer operations",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Review assignments",
        "Advanced reviewer workflows",
      ],
    },
    {
      label: "Tasks & review queues",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Included",
        "Advanced queues",
      ],
    },
    {
      label: "Governance controls",
      values: [
        "Not included",
        "Not included",
        "Personal-workspace controls",
        "Team governance",
        "Enterprise governance",
      ],
    },
    {
      label: "Retention policies",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Basic retention",
        "Custom retention policies",
      ],
    },
    {
      label: "Legal hold",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "Included",
      ],
    },
    {
      label: "SAML SSO, SCIM, MFA enforcement",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "Included",
      ],
    },
    {
      label: "Access reviews & session governance",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "Included",
      ],
    },
    {
      label: "Object Lock / immutable storage",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "Included",
      ],
    },
    {
      label: "Audit logs",
      values: [
        "Basic record history",
        "Basic record history",
        "Record audit history",
        "Team audit logs",
        "Organization audit logs",
      ],
    },
    {
      label: "Integrations & APIs",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Limited integrations",
        "APIs, webhooks, SSO, and integrations",
      ],
    },
    {
      label: "Owned teams allowed",
      values: ["0", "0", "2", "5", "Custom"],
    },
    {
      label: "Team members",
      values: [
        "0",
        "0",
        `Up to ${catalog?.pro?.maxMembersPerTeam ?? 5}`,
        `Up to ${catalog?.team?.maxMembersPerTeam ?? 5} per team`,
        "Custom",
      ],
    },
    {
      label: "Commercial path",
      values: ["Self-serve", "Self-serve", "Self-serve", "Self-serve", "Sales-led"],
    },
    {
      label: "Best fit",
      values: [
        "Evaluation and low volume",
        "Usage-based professional output",
        "Recurring use with small team support",
        "Shared operational multi-team usage",
        "Procurement, governance, or larger rollout",
      ],
    },
  ];

  const SectionKicker = ({ children }: { children: React.ReactNode }) => (
  <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_8px_20px_rgba(37,99,235,0.06)]">
    <span className="h-1.5 w-1.5 rounded-full bg-[#5B21B6]" />
    {children}
  </div>
);

  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient
            id="proovraOutlineGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#2D2A7B" />
            <stop offset="48%" stopColor="#8A2F9B" />
            <stop offset="100%" stopColor="#E91E7A" />
          </linearGradient>
        </defs>
      </svg>

      <div className="relative overflow-hidden">
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
              "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.40) 50%, rgba(255,255,255,0.20) 100%)",
          }}
        />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-14 pt-16 text-center md:px-8 md:pb-20 md:pt-20 lg:pt-24">
            <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#5B21B6]" />
              Pricing &amp; Plans
            </div>

            <h1 className="mx-auto mt-5 max-w-[820px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.035em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
              Choose the right operational model for your evidence program.
            </h1>

            <p className="mx-auto mt-5 max-w-[700px] text-[0.96rem] leading-[1.75] text-[#475569] md:text-[1.02rem]">
              Flexible plans for professionals, teams, and enterprise
              organizations that require trusted evidence operations.
            </p>

            <div className="mx-auto mt-8 flex max-w-[640px] flex-wrap items-center justify-center gap-x-6 gap-y-3">
              {lifecycleSteps.map((step) => {
                const Icon = step.icon;

                return (
                  <div key={step.label} className="flex items-center gap-2">
                    <span
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white"
                      style={{
                        background: step.bg,
                        boxShadow:
                          step.shadow ?? "0 8px 18px rgba(15,23,42,0.10)",
                      }}
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
          </section>
        </div>
      </div>

      <section className="relative mx-auto max-w-[1500px] px-6 pt-8 md:px-8 2xl:px-10">
        <div className="grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-5">
          {plans.map((plan) => {
            if (plan.enterprise) {
              return (
                <div
                  key={plan.id}
                  id={`plan-${plan.id}`}
                  className="relative flex h-full flex-col overflow-hidden rounded-[24px] border border-[#5B21B6]/35 p-6 text-white shadow-[0_24px_60px_rgba(15,23,42,0.32),0_0_0_1px_rgba(91,33,182,0.18)]"
                  style={{
                    background:
                      "linear-gradient(155deg,#0B1437 0%,#0E1E4A 55%,#15225E 100%)",
                  }}
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        "radial-gradient(circle at 80% 0%,rgba(91,33,182,0.30),transparent 55%),radial-gradient(circle at 0% 100%,rgba(34,211,238,0.18),transparent 50%)",
                    }}
                  />

                  <div className="relative z-10 flex h-full flex-col">
                    <h3 className="text-[1.45rem] font-bold tracking-[-0.025em] text-white">
                      {plan.title}
                    </h3>

                    <p className="mt-2 min-h-[68px] text-[0.9rem] leading-[1.6] text-[#CBD5F5]">
                      {plan.subtitle}
                    </p>

                    <div className="mt-5">
                      <div className="text-[2.1rem] font-semibold leading-none tracking-[-0.03em] text-white">
                        {plan.price}
                      </div>
                      <div className="mt-2 min-h-[18px] text-[0.8rem] text-[#AEB8D8]">
                        {plan.priceNote}
                      </div>
                    </div>

                    <div className="mt-5 grid gap-2">
                      <Link
                        href={plan.ctaHref}
                        className="flex h-11 items-center justify-center rounded-[13px] bg-gradient-to-r from-[#EC4899] via-[#6D28D9] to-[#5B21B6] text-[0.88rem] font-semibold text-white shadow-[0_10px_24px_rgba(91,33,182,0.45)] transition hover:translate-y-[-1px]"
                      >
                        Talk to an expert
                      </Link>
                      <Link
                        href="/request-demo"
                        className="flex h-11 items-center justify-center rounded-[13px] border border-white/25 bg-white/5 text-[0.88rem] font-semibold text-white transition hover:bg-white/10"
                      >
                        Request demo
                      </Link>
                    </div>

                    <div className="mt-5 rounded-[16px] bg-white/8 p-4 ring-1 ring-white/10">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">
                        Included
                      </div>
                      <ul className="mt-3 grid gap-2 pl-0">
                        {plan.features.map((feature) => (
                          <li
                            key={feature}
                            className="flex list-none items-start gap-2 text-[0.8rem] leading-[1.5] text-[#D8DEF5]"
                          >
                            <CheckCircle2
                              size={14}
                              className="mt-[2px] shrink-0 text-[#34D399]"
                              strokeWidth={2.4}
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={plan.id}
                id={`plan-${plan.id}`}
                className={`relative flex h-full flex-col overflow-hidden rounded-[24px] border bg-[var(--proovra-surface)] p-6 transition ${
                  plan.featured
                    ? "border-[#5B21B6]/30 shadow-[0_24px_60px_rgba(91,33,182,0.18)] ring-1 ring-[#5B21B6]/20"
                    : "border-[var(--proovra-border-warm)] shadow-[0_14px_30px_rgba(15,23,42,0.06)]"
                }`}
              >
                {plan.badge ? (
                  <div className="absolute right-4 top-4 rounded-full bg-[#F3EFFF] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5B21B6]">
                    {plan.badge}
                  </div>
                ) : null}

                <h3
                  className="text-[1.35rem] font-bold tracking-[-0.025em]"
                  style={{ color: plan.iconColor }}
                >
                  {plan.title}
                </h3>

                <p className="mt-2 min-h-[68px] text-[0.9rem] leading-[1.6] text-[#64748B]">
                  {plan.subtitle}
                </p>

                <div className="mt-5">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[2rem] font-semibold leading-none tracking-[-0.03em] text-[#0F172A]">
                      {plan.price}
                    </span>
                    {plan.priceSuffix ? (
                      <span className="text-[0.85rem] text-[#64748B]">
                        {plan.priceSuffix}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-2 min-h-[18px] text-[0.8rem] text-[#64748B]">
                    {plan.priceNote !== "Billed monthly" ? plan.priceNote : ""}
                  </div>
                </div>

                <Link
                  href={plan.ctaHref}
                  className={`mt-5 inline-flex h-[44px] w-full items-center justify-center rounded-[13px] px-4 text-sm font-bold transition hover:translate-y-[-1px] ${
                    plan.id === "personal"
                      ? "border-2 border-[#F97316] bg-[var(--proovra-surface)] text-[#F97316] hover:bg-[#FFF7ED]"
                      : plan.id === "payg"
                        ? "border-2 border-[#2563EB] bg-[var(--proovra-surface)] text-[#2563EB] hover:bg-[#EFF6FF]"
                        : plan.id === "pro"
                          ? "bg-gradient-to-r from-[#5B21B6] to-[#7E22CE] text-white shadow-[0_12px_26px_rgba(91,33,182,0.34)]"
                          : plan.id === "team"
                            ? "bg-gradient-to-r from-[#0891B2] to-[#06B6D4] text-white shadow-[0_12px_26px_rgba(6,182,212,0.28)]"
                            : "border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] text-[#0F172A] hover:border-[var(--proovra-border-warm-hover)]"
                  }`}
                >
                  {plan.ctaLabel}
                </Link>

                <div className="mt-5 rounded-[16px] bg-[var(--proovra-page-bg-soft)] p-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#64748B]">
                    Included
                  </div>
                  <ul className="mt-3 grid gap-2 pl-0">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex list-none items-start gap-2 text-[0.8rem] leading-[1.5] text-[#475569]"
                      >
                        <CheckCircle2
                          size={14}
                          className="mt-[2px] shrink-0"
                          style={{ color: plan.iconColor }}
                          strokeWidth={2.4}
                        />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="relative mx-auto max-w-[1500px] px-6 pt-8 md:px-8 2xl:px-10">
<div className="text-center">
  <SectionKicker>Every plan includes</SectionKicker>
</div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-10">
          {everyPlanIncludes.map((item) => {
            const Icon = item.icon;

            return (
              <div
                key={item.label}
                className="flex flex-col items-center gap-2 text-center"
              >
                <GradientIconFrame size="sm">
                  <ProovraGradientIcon
                    Icon={Icon}
                    size={22}
                    strokeWidth={3}
                    weight="regular"
                  />
                </GradientIconFrame>
                <span className="text-[0.74rem] font-medium leading-[1.3] text-[#0F172A]">
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="relative mx-auto max-w-[1500px] px-6 pt-8 md:px-8 2xl:px-10">
        <div className="rounded-[28px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-6 shadow-[0_20px_44px_rgba(15,23,42,0.06)] md:p-10">
          <div className="grid gap-10 lg:grid-cols-[1.25fr_0.75fr] lg:items-center">
            <div>
<SectionKicker>Built for enterprise</SectionKicker>

              <h2 className="mt-4 max-w-[640px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[1.85rem]">
                Built for procurement, governance, and large-scale evidence
                operations.
              </h2>

              <p className="mt-3 max-w-[600px] text-[0.94rem] leading-[1.7] text-[#475569]">
                We support complex organizational needs with security,
                compliance, and scalability.
              </p>

              <div className="mt-6 grid gap-4">
                {enterpriseFeatures.map((item) => {
                  const Icon = item.icon;

                  return (
                    <div key={item.title} className="flex gap-3.5">
                      <GradientIconFrame size="sm">
                        <ProovraGradientIcon
                          Icon={Icon}
                          size={22}
                          strokeWidth={3.05}
                          weight="regular"
                        />
                      </GradientIconFrame>

                      <div>
                        <div className="text-[0.96rem] font-semibold text-[#0F172A]">
                          {item.title}
                        </div>
                        <div className="mt-1 text-[0.86rem] leading-[1.6] text-[#475569]">
                          {item.body}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex w-full justify-end lg:self-center">
              <div className="grid w-full max-w-[320px] gap-3">
                <Link
                  href="/request-demo"
                  className="flex h-11 items-center justify-center rounded-[13px] bg-gradient-to-r from-[#EC4899] via-[#7E22CE] to-[#5B21B6] text-[0.9rem] font-semibold text-white shadow-[0_12px_28px_rgba(91,33,182,0.35)] transition hover:translate-y-[-1px]"
                >
                  Schedule a demo
                </Link>

                <Link
                  href="/contact-sales"
className="flex h-11 items-center justify-center rounded-[13px] border border-[#C45AD7] bg-white text-[0.9rem] font-semibold text-[#0F172A] shadow-[0_8px_18px_rgba(196,90,215,0.08)] transition duration-200 hover:-translate-y-[1px] hover:border-[#B24ACD] hover:bg-white hover:shadow-[0_12px_26px_rgba(196,90,215,0.16)]"
                >
                  Talk to Sales
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

{(() => {
        // Pricing-page UX refinement — Phase 4.
        // Split the single sprawling comparison table into two enterprise-grade
        // tables. The data still comes from `compareRows`; we just partition
        // at the existing "Platform Operations" group separator so capacity
        // and operations live in their own scannable surfaces.
        type RowType = Exclude<(typeof compareRows)[number], { group: true }>;
        const groupIdx = compareRows.findIndex(
          (r) => "group" in r && r.group,
        );
        const capacityRows = compareRows.slice(0, groupIdx) as RowType[];
        const operationsRows = compareRows.slice(groupIdx + 1) as RowType[];

        const TableBlock = ({ rows }: { rows: RowType[] }) => (
          <div className="mt-4 overflow-x-auto rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
            <table className="w-full min-w-[840px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--proovra-border-warm)] bg-[var(--proovra-page-bg-soft)]">
                  <th className="px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                    Capability
                  </th>
                  <th className="px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                    Free
                  </th>
                  <th className="px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                    Pay-Per-Evidence
                  </th>
                  <th className="px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                    Pro
                  </th>
                  <th className="px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                    Team
                  </th>
                  <th className="bg-[#F3EFFF] px-5 py-3.5 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#5B21B6]">
                    Enterprise
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, dataIdx) => (
                  <tr
                    key={row.label}
                    className={
                      dataIdx % 2 === 0
                        ? "bg-[var(--proovra-surface)]"
                        : "bg-[var(--proovra-surface-soft)]"
                    }
                  >
                    <td className="px-5 py-3.5 text-[0.86rem] font-semibold text-[#0F172A]">
                      {row.label}
                    </td>
                    {row.values.map((value, index) => {
                      const isEnterprise = index === 4;
                      const isMuted = value === "Not included";
                      const enterpriseBg = isEnterprise
                        ? "bg-[#F3EFFF]/60"
                        : "";
                      const textColor = isMuted
                        ? "text-[#94A3B8]"
                        : isEnterprise
                          ? "text-[#0F172A]"
                          : "text-[#475569]";
                      return (
                        <td
                          key={`${row.label}-${index}`}
                          className={`px-5 py-3.5 text-[0.84rem] leading-[1.55] ${enterpriseBg} ${textColor}`}
                        >
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

        return (
          <>
            <section className="relative mx-auto mt-8 max-w-7xl px-6 pb-8 md:mt-10 md:px-8 md:pb-10">
              <SectionKicker>Plans &amp; Capacity</SectionKicker>
              <TableBlock rows={capacityRows} />
              <div className="mt-3 text-[0.78rem] text-[#64748B]">
                Prices shown in{" "}
                <span className="font-medium text-[#0F172A]">
                  {displayCurrency}
                </span>
                . VAT may apply depending on your country.
              </div>
            </section>

            <section className="relative mx-auto max-w-7xl px-6 pb-12 md:px-8 md:pb-16">
              <SectionKicker>Operations &amp; Governance</SectionKicker>
              <TableBlock rows={operationsRows} />
            </section>
          </>
        );
      })()}

      <section className="relative mx-auto max-w-7xl px-6 pb-12 md:px-8 md:pb-16">
<SectionKicker>Why organizations choose PROOVRA</SectionKicker>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {whyChoose.map((card) => {
            const Icon = card.icon;

            return (
              <div
                key={card.title}
                className="rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]"
              >
                <GradientIconFrame>
                  <ProovraGradientIcon
                    Icon={Icon}
                    size={25}
                    strokeWidth={3.15}
                    weight="regular"
                  />
                </GradientIconFrame>

                <div className="mt-4 text-[1rem] font-semibold tracking-[-0.01em] text-[#0F172A]">
                  {card.title}
                </div>

                <div className="mt-2 text-[0.86rem] leading-[1.6] text-[#475569]">
                  {card.body}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-6 pb-16 md:px-8 md:pb-20">
        <div
          className="overflow-hidden rounded-[28px] p-8 text-white shadow-[0_24px_60px_rgba(91,33,182,0.26)] md:p-10"
          style={{
            background:
              "linear-gradient(90deg,#4C1D95 0%,#5B21B6 46%,#7E22CE 72%,#EC4899 90%,#F97316 100%)",
          }}
        >
          <div className="grid gap-6 md:grid-cols-[1.1fr_0.9fr] md:items-center">
            <div>
              <h2 className="text-[1.55rem] font-semibold tracking-[-0.02em] text-white md:text-[1.85rem]">
                Ready to modernize your evidence operations?
              </h2>

              <p className="mt-3 max-w-[520px] text-[0.96rem] leading-[1.7] text-white/90">
                Capture, verify, govern, and share digital evidence with
                confidence.
              </p>
            </div>

            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href="/request-demo"
                className="flex h-11 items-center justify-center rounded-full bg-white px-6 text-[0.88rem] font-semibold text-[#5B21B6] shadow-[0_10px_24px_rgba(15,23,42,0.18)] transition hover:translate-y-[-1px]"
              >
                Request demo →
              </Link>

              <Link
                href="/contact-sales"
                className="flex h-11 items-center justify-center rounded-full border border-white/40 bg-white/10 px-6 text-[0.88rem] font-semibold text-white transition hover:bg-white/20"
              >
                Talk to Sales →
              </Link>

              <Link
                href={hasSession ? appBilling : appRegister}
                className="flex h-11 items-center justify-center rounded-full border border-white/40 bg-white/10 px-6 text-[0.88rem] font-semibold text-white transition hover:bg-white/20"
              >
                Start free
              </Link>
            </div>
          </div>
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}