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
import { RevealSection } from "../../components/motion";
import { useAuth } from "../providers";
import type { PricingCatalogResponse } from "./types";
import { apiFetch } from "../../lib/api";
import { buildBillingHref } from "../../lib/navigation/billingWorkspaceLocator";

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

/**
 * PHASE 12 REMEDIATION — COMM-002 (2026-08-06).
 *
 * The bounded "server has not told us yet" placeholder.
 *
 * What this replaces: every commercial figure on this page carried a
 * hard-coded literal fallback (`catalog?.pro?.maxOwnedTeams ?? 2`,
 * `?? "100 GB"`, `?? "$19"`, and twenty-odd more). When the pricing catalog
 * was unavailable — a failed fetch, a cold start, a currency the endpoint
 * rejects — the page did not say so. It ADVERTISED A NUMBER, silently, and
 * that number was a client-side copy of a server-authoritative limit that
 * could drift from what the server actually enforces.
 *
 * Enforcement is unchanged and stays server-side (`routes/teams.routes.ts`
 * against `@proovra/shared-billing`). What changes is that the marketing
 * surface no longer holds a SECOND copy of the commercial truth. It renders
 * what the server said, or it renders this — never an invented limit.
 */
const CATALOG_VALUE_UNAVAILABLE = "—";

/**
 * Render a served catalog value, or the bounded placeholder when the
 * catalog has not loaded. Deliberately accepts `string | number` and
 * nothing else: there is no "default" parameter, because a default is
 * precisely the client-side commercial authority being removed.
 */
function catalogValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return CATALOG_VALUE_UNAVAILABLE;
  return String(value);
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
    // PHASE 11 §5 — the ONE billing workspace locator produces every billing
    // link. No hand-written `?workspace=` / `?team=` vocabulary here.
    if (planId === "personal")
      return buildBillingHref({ kind: "personal" }, { basePath: appBilling });
    if (planId === "team")
      return buildBillingHref({ kind: "team" }, { plan: "TEAM", basePath: appBilling });
    return buildBillingHref(
      { kind: "personal" },
      { plan: planId.toUpperCase() as "PAYG" | "PRO" | "TEAM", basePath: appBilling },
    );
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
    CATALOG_VALUE_UNAVAILABLE;
  const proPrice =
    formatPlanPrice(catalog?.pro?.monthlyPriceCents, displayCurrency) ??
    CATALOG_VALUE_UNAVAILABLE;
  const teamPrice =
    formatPlanPrice(catalog?.team?.monthlyPriceCents, displayCurrency) ??
    CATALOG_VALUE_UNAVAILABLE;

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
        `${catalogValue(catalog?.free?.maxEvidenceRecords)} evidence records total`,
        `${catalogValue(catalog?.free?.storageLabel)} storage`,
        "Basic integrity signals",
        "Public verification access",
      ],
    },
    {
      id: "payg",
      title: "Pay per evidence",
      subtitle: "Use only what you need with flexible pricing.",
      price: paygPrice,
      priceSuffix: "/ credit",
      priceNote: "Per credit, one-time",
      icon: Briefcase,
      accent: {
        bg: "linear-gradient(135deg,#3B82F6 0%,#2563EB 100%)",
        ring: "rgba(37,99,235,0.18)",
      },
      iconColor: "#2563EB",
      ctaLabel: buildCtaLabel("payg"),
      ctaHref: buildCtaHref("payg"),
      features: [
        "One credit records one evidence item",
        "Report and verification package for each paid record",
        "Credits never expire",
        "No subscription — your account stays on Free",
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
        `${catalogValue(catalog?.pro?.maxEvidenceRecords)} evidence records included`,
        `${catalogValue(catalog?.pro?.storageLabel)} storage`,
        "Reports & verification packages included",
        `AI assistance: ${catalogValue(catalog?.pro?.aiAdvisoryMonthlyOperations)} operations / month`,
        "Personal account — additional workspaces need their own Team plan",
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
        `${catalogValue(catalog?.team?.maxEvidenceRecordsPerMonth)} evidence records in any 30 days`,
        `${catalogValue(catalog?.team?.storageLabel)} cumulative storage`,
        `AI assistance: ${catalogValue(catalog?.team?.aiAdvisoryMonthlyOperations)} operations / month`,
        "Shared workspace, review assignments, team governance",
        `Up to ${catalogValue(catalog?.team?.maxAcceptedMembersPerCollaborationTeam)} accepted members per Team`,
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

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — this list said "Reports" and
   * "Verification Packages" while the comparison table on the SAME PAGE said
   * "PDF reports: Free — Not included". The catalog agrees with the table:
   * `PLAN_CAPABILITIES.FREE.reportsIncluded` and
   * `verificationPackageIncluded` are both false.
   *
   * What genuinely IS plan-independent is the integrity layer — hashing,
   * trusted timestamps, signatures, custody — and that is what this row now
   * claims. It is also the stronger claim: it is the part no tier can weaken.
   */
  const everyPlanIncludes: { label: string; icon: MarketingIcon }[] = [
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
        `${catalogValue(catalog?.free?.maxEvidenceRecords)} total`,
        "Pay only when you complete evidence",
        `${catalogValue(catalog?.pro?.maxEvidenceRecords)} included`,
        `${catalogValue(catalog?.team?.maxEvidenceRecordsPerMonth)} in any 30 days`,
        "Custom operational volume",
      ],
    },
    {
      label: "Storage included",
      values: [
        catalogValue(catalog?.free?.storageLabel),
        catalogValue(catalog?.payg?.storageLabel),
        catalogValue(catalog?.pro?.storageLabel),
        catalogValue(catalog?.team?.storageLabel),
        "Custom storage envelope",
      ],
    },
    {
      label: "Storage add-ons",
      values: [
        "Not available",
        "Not available",
        "Monthly, from +10 GB",
        "Monthly, from +100 GB",
        "Contract storage",
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
      // P5 domain remediation (2026-07-21) — the self-service TEAM plan
      // funds user-OWNED team workspaces; it is NOT an Enterprise
      // Organization. "Organization" language is reserved for the
      // sales-provisioned Enterprise tier.
      label: "Workspace support",
      values: [
        "Personal only",
        "Personal only",
        "Personal + owned workspaces",
        "Owned team workspaces",
        "Enterprise Organization",
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
        `${catalogValue(catalog?.payg?.aiAdvisoryMonthlyOperations)} ops / month`,
        `${catalogValue(catalog?.pro?.aiAdvisoryMonthlyOperations)} ops / month`,
        `${catalogValue(catalog?.team?.aiAdvisoryMonthlyOperations)} ops / month`,
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
      // The governance ENTITLEMENTS that exist (legal hold, retention,
      // organization audit, Object Lock, SSO/SCIM, MFA enforcement) are all
      // Enterprise-only flags. "Personal-workspace controls" and "Team
      // governance" named none of them.
      label: "Governance controls",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "Enterprise governance",
      ],
    },
    {
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — "Basic retention" was
      // sold to TEAM and refused by the code: `enterpriseFeatures.retentionPolicy`
      // is false on TEAM, and `denyIfTeamNotEnterprise(..., "retentionPolicy")`
      // returns 402 to a TEAM workspace that tries to use it.
      label: "Retention policies",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
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
      // Enforcement note: `enterpriseFeatures.objectLock` has no gate consumer
      // in the codebase today. It is retained as an Enterprise row because
      // Object Lock is a real storage posture the platform configures, but no
      // per-plan gate turns it on or off — which is why it is not claimed as a
      // capability the customer switches.
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
      // Only `organizationAuditLogs` exists as an entitlement, and only on
      // ENTERPRISE. The four tier-specific strings this replaces named no flag
      // the product enforces. Record history itself is plan-independent.
      label: "Audit logs",
      values: [
        "Record history",
        "Record history",
        "Record history",
        "Record history",
        "Organization audit logs",
      ],
    },
    {
      // "Limited integrations" named no entitlement. No plan field governs
      // integrations, and the product-line engine that does is keyed on
      // something Pricing does not sell.
      label: "Integrations & APIs",
      values: [
        "Not included",
        "Not included",
        "Not included",
        "Not included",
        "APIs, webhooks, SSO, and integrations",
      ],
    },
    {
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — this row is the
      // COLLABORATION TEAM cap, served from
      // `PlanCapabilities.maxCollaborationTeamsPerWorkspace`. The comment it
      // replaces cited `COLLABORATION_TEAM_PLAN_LIMITS` (deleted, it carried
      // the overload) and a guard suite
      // `pricing-teams-entitlement-consistency.test.ts` that does not exist —
      // a pin that had rotted into a claim.
      label: "Teams",
      values: [
        "Not included",
        "Not included",
        `Up to ${catalogValue(catalog?.pro?.maxCollaborationTeamsPerWorkspace)} per workspace`,
        `Up to ${catalogValue(catalog?.team?.maxCollaborationTeamsPerWorkspace)} per workspace`,
        "Custom",
      ],
    },
    {
      // Teams Entitlement Alignment 2026-07-14 — "Up to N members"
      // ALWAYS means members per Team. Canonical values come from
      // COLLABORATION_TEAM_PLAN_LIMITS (PRO 5 / TEAM 5), mirrored by
      // the served catalog's maxMembersPerTeam.
      label: "Team members",
      values: [
        "Not included",
        "Not included",
        `Up to ${catalogValue(catalog?.pro?.maxAcceptedMembersPerCollaborationTeam)} accepted members per Team`,
        `Up to ${catalogValue(catalog?.team?.maxAcceptedMembersPerCollaborationTeam)} accepted members per Team`,
        "Custom",
      ],
    },
    {
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — its OWN row. This number
      // used to be published as "Teams" and enforced over BOTH `Team` rows and
      // `CollaborationTeam` rows, so one advertised "Up to 2" quietly granted a
      // PRO account two owned workspaces AND two collaboration teams.
      label: "Owned workspaces",
      values: [
        "Not included",
        "Not included",
        `Up to ${catalogValue(catalog?.pro?.maxOwnedWorkspaces)}`,
        `Up to ${catalogValue(catalog?.team?.maxOwnedWorkspaces)}`,
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

      <RevealSection direction="up">
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
      </RevealSection>

      <RevealSection direction="right">
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
      </RevealSection>

      <RevealSection direction="left">
      <section className="relative mx-auto max-w-[1500px] px-6 pt-8 md:px-8 2xl:px-10">
        {/* Enterprise card surface — icon-card.png. The asset is a dark
            navy/purple artwork with the brand mark embedded on the right;
            text + features below switch to white to read against it. A
            very low-opacity scrim sits over the artwork only to keep the
            left-side text column from competing with the embedded mark. */}
        <div
          className="relative overflow-hidden rounded-[28px] border border-white/10 shadow-[0_30px_70px_rgba(15,23,42,0.28)]"
          style={{
            backgroundImage: "url('/assets/cards/icon-card.png')",
            backgroundRepeat: "no-repeat",
            backgroundSize: "cover",
            backgroundPosition: "center center",
          }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, rgba(5,10,28,0.55) 0%, rgba(5,10,28,0.30) 38%, rgba(5,10,28,0.10) 62%, rgba(5,10,28,0) 100%)",
            }}
          />

          <div className="relative p-6 md:p-10">
            <div className="grid gap-10 lg:grid-cols-[1.25fr_0.75fr] lg:items-center">
              <div>
                <SectionKicker>Built for enterprise</SectionKicker>

                <h2 className="mt-4 max-w-[640px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[1.85rem]">
                  Built for procurement, governance, and large-scale evidence
                  operations.
                </h2>

                <p className="mt-3 max-w-[600px] text-[0.94rem] leading-[1.7] text-white/75">
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
                          <div className="text-[0.96rem] font-semibold text-white">
                            {item.title}
                          </div>
                          <div className="mt-1 text-[0.86rem] leading-[1.6] text-white/70">
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

                  {/* Secondary CTA restyled for the dark card surface:
                      semi-opaque white pill with brand-purple text — same
                      family as the hero "View Sample Report" pattern. */}
                  <Link
                    href="/contact-sales"
                    className="flex h-11 items-center justify-center rounded-[13px] border border-white/40 bg-white/95 text-[0.9rem] font-semibold text-[#5B21B6] shadow-[0_10px_22px_rgba(15,23,42,0.22)] transition duration-200 hover:-translate-y-[1px] hover:bg-white hover:shadow-[0_14px_28px_rgba(15,23,42,0.30)]"
                  >
                    Talk to Sales
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      </RevealSection>

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
                . Displayed prices exclude any taxes that may be handled by
                the payment provider where applicable.
              </div>
            </section>

            <section className="relative mx-auto max-w-7xl px-6 pb-12 md:px-8 md:pb-16">
              <SectionKicker>Operations &amp; Governance</SectionKicker>
              <TableBlock rows={operationsRows} />
            </section>
          </>
        );
      })()}

      <RevealSection direction="up">
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
      </RevealSection>

      <RevealSection direction="right">
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
      </RevealSection>

      <EnterpriseFooter />
    </div>
  );
}