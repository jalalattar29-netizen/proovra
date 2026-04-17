"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  detectCurrency,
  formatMoney,
  normalizeCurrency,
  type SupportedCurrency,
} from "../../lib/currency";
import { Button, Card, useToast } from "../../components/ui";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { useAuth } from "../providers";
import type { PricingCatalogResponse } from "./types";
import { apiFetch } from "../../lib/api";
import { PricingComparisonTable } from "../../components/pricing/PricingComparisonTable";
import { PricingCheckoutGuide } from "../../components/pricing/PricingCheckoutGuide";

function getAppBase() {
  if (typeof window === "undefined") return "";
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return window.location.origin;
  }
  return (
    process.env.NEXT_PUBLIC_APP_BASE ??
    process.env.NEXT_PUBLIC_WEB_BASE ??
    ""
  );
}

type PlanKey = "FREE" | "PAYG" | "PRO" | "TEAM";

type PlanCard = {
  key: PlanKey;
  eyebrow: string;
  title: string;
  priceLabel: string | null;
  billingModel: "free" | "one_time" | "monthly";
  bestFor: string;
  summary: string;
  features: string[];
  limitations?: string[];
  helper?: string | null;
  tone: "neutral" | "teal" | "bronze" | "team";
  ctaLabel: string;
  ctaHref: string;
};

type StorageAddonItem = {
  key: string;
  label: string;
  storageBytes: number;
  priceCents: number;
  currency: string;
  workspaceType: "PERSONAL" | "TEAM";
};

function formatBytesCompact(value: number | null | undefined): string {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = n;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  const fixed = index === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fixed)} ${units[index]}`;
}

function formatCatalogMoney(
  amountCents: number | null | undefined,
  currency: SupportedCurrency | null
): string | null {
  if (!currency || amountCents == null) return null;
  return formatMoney(amountCents / 100, currency);
}

function formatAddonMoney(item: StorageAddonItem): string {
  const effectiveCurrency = normalizeCurrency(item.currency);
  return formatMoney(item.priceCents / 100, effectiveCurrency);
}

function getPlanToneStyles(tone: PlanCard["tone"]) {
  if (tone === "teal") {
    return {
      border: "1px solid rgba(158,216,207,0.22)",
      eyebrow: "#2f6965",
      title: "#18383d",
      dot: "#7fbdb4",
      halo:
        "radial-gradient(circle at top right, rgba(141,214,197,0.14), transparent 36%)",
    } as const;
  }

  if (tone === "bronze") {
    return {
      border: "1px solid rgba(183,157,132,0.18)",
      eyebrow: "#9b826b",
      title: "#23373b",
      dot: "#c9a98b",
      halo:
        "radial-gradient(circle at top right, rgba(214,184,157,0.14), transparent 38%)",
    } as const;
  }

  if (tone === "team") {
    return {
      border: "1px solid rgba(79,112,107,0.16)",
      eyebrow: "#50676a",
      title: "#23373b",
      dot: "#7ea9a2",
      halo:
        "radial-gradient(circle at top right, rgba(126,169,162,0.10), transparent 38%)",
    } as const;
  }

  return {
    border: "1px solid rgba(255,255,255,0.42)",
    eyebrow: "#405357",
    title: "#21353a",
    dot: "#7ea9a2",
    halo:
      "radial-gradient(circle at top right, rgba(255,255,255,0.12), transparent 36%)",
  } as const;
}

const sharedCardButtonStyle: React.CSSProperties = {
  borderColor: "rgba(79,112,107,0.22)",
  color: "#eef3f1",
  background:
    "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
};

export default function MarketingPricingPage() {
  const { addToast } = useToast();
  const { hasSession } = useAuth();

  const [hoveredPlan, setHoveredPlan] = useState<string | null>(null);
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
      .then((data) => setCatalog((data ?? null) as PricingCatalogResponse | null))
      .catch(() => setCatalog(null));
  }, [preferredCurrency]);

  const displayCurrency = useMemo<SupportedCurrency>(() => {
    return normalizeCurrency(catalog?.currency ?? preferredCurrency);
  }, [catalog?.currency, preferredCurrency]);

  const appBase = getAppBase();
  const appBilling = appBase ? `${appBase}/billing` : "/billing";
  const appRegister = appBase ? `${appBase}/register` : "/register";

  const buildCtaHref = (key: PlanKey) => {
    if (!hasSession) return appRegister;

    if (key === "TEAM") {
      return `${appBilling}?workspace=team&plan=TEAM`;
    }

    if (key === "FREE") {
      return `${appBilling}?workspace=personal`;
    }

    return `${appBilling}?workspace=personal&plan=${key}`;
  };

  const buildCtaLabel = (key: PlanKey) => {
    if (!hasSession) {
      if (key === "FREE") return "Create free account";
      return "Create account and continue";
    }

    if (key === "FREE") return "Open billing console";
    if (key === "TEAM") return "Open team checkout";
    if (key === "PAYG") return "Open PAYG checkout";
    if (key === "PRO") return "Open PRO checkout";
    return `Choose ${key}`;
  };

  const storageAddonSummary = useMemo(() => {
    if (!Array.isArray(catalog?.storageAddons) || catalog.storageAddons.length === 0) {
      return null;
    }

    const all = catalog.storageAddons as StorageAddonItem[];
    return {
      personal: all.filter((item) => item.workspaceType === "PERSONAL"),
      team: all.filter((item) => item.workspaceType === "TEAM"),
    };
  }, [catalog]);

  const plans: PlanCard[] = useMemo(
    () => [
      {
        key: "FREE",
        eyebrow: "Personal entry",
        title: "Free",
        priceLabel: formatCatalogMoney(0, displayCurrency),
        billingModel: "free",
        bestFor: "Initial evaluation and low-volume personal use",
        summary:
          "Start with a lightweight personal workflow and public verification access before moving into professional outputs.",
        features: [
          `${catalog?.free?.maxEvidenceRecords ?? 3} evidence records total`,
          `Storage included: ${catalog?.free?.storageLabel ?? "250 MB"}`,
          "Basic recorded integrity materials",
          "Public verification access",
        ],
        limitations: [
          "PDF reports not included",
          "Verification package not included",
          "No paid storage add-ons until base plan upgrade",
        ],
        helper:
          "Best when you want to test the workflow before stepping into paid evidence outputs.",
        tone: "neutral",
        ctaLabel: buildCtaLabel("FREE"),
        ctaHref: buildCtaHref("FREE"),
      },
      {
        key: "PAYG",
        eyebrow: "Usage-based professional output",
        title: "Pay-Per-Evidence",
        priceLabel:
          catalog?.payg?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.payg.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / evidence`
            : null,
        billingModel: "one_time",
        bestFor: "Occasional professional use",
        summary:
          "Use this when you want reviewer-facing outputs without committing to a recurring subscription.",
        features: [
          `Storage included: ${catalog?.payg?.storageLabel ?? "5 GB"}`,
          "PDF report included",
          "Verification package included",
          "Shareable verification link",
          "Supports selected personal one-time storage add-ons",
        ],
        helper:
          "Good for lawyers, investigators, or reviewers who need professional evidence output case by case.",
        tone: "teal",
        ctaLabel: buildCtaLabel("PAYG"),
        ctaHref: buildCtaHref("PAYG"),
      },
      {
        key: "PRO",
        eyebrow: "Recurring individual workflow",
        title: "Pro",
        priceLabel:
          catalog?.pro?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.pro.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / month`
            : null,
        billingModel: "monthly",
        bestFor: "Recurring professional use",
        summary:
          "For professionals who need ongoing evidence operations, recurring access, and stronger output coverage.",
        features: [
          `Storage included: ${catalog?.pro?.storageLabel ?? "100 GB"}`,
          "Unlimited evidence records",
          "PDF reports included",
          "Verification packages included",
          "Supports one-time personal storage top-ups",
        ],
        helper:
          "Best for solo legal, compliance, consulting, investigative, or claims workflows with recurring volume.",
        tone: "bronze",
        ctaLabel: buildCtaLabel("PRO"),
        ctaHref: buildCtaHref("PRO"),
      },
      {
        key: "TEAM",
        eyebrow: "Shared operational workspace",
        title: "Team",
        priceLabel:
          catalog?.team?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.team.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / month`
            : null,
        billingModel: "monthly",
        bestFor: "Firms, teams, investigations, and organizations",
        summary:
          "Built for shared review, member access, and team-based evidence operations inside one workspace.",
        features: [
          `Includes up to ${catalog?.team?.seats ?? 5} seats in the standard team subscription`,
          `Storage included: ${catalog?.team?.storageLabel ?? "500 GB"}`,
          "Shared workspace and member management",
          "Reports and verification packages included",
          "Supports one-time team storage top-ups",
        ],
        helper:
          "For larger procurement, governance review, rollout planning, or higher-volume operational needs, use Enterprise instead of the standard Team checkout.",
        tone: "team",
        ctaLabel: buildCtaLabel("TEAM"),
        ctaHref: buildCtaHref("TEAM"),
      },
    ],
    [displayCurrency, catalog, hasSession, appBilling, appRegister]
  );

  const enterprise = catalog?.enterprise ?? {
    displayName: "Enterprise",
    pricingModel: "CUSTOM" as const,
    ctaLabel: "Contact Sales",
    ctaHref: "/contact-sales",
    summary:
      "Custom commercial terms for larger organizations that need procurement handling, governance review, rollout planning, or higher-volume evidence operations.",
    capabilities: [
      "Custom seat volume and onboarding scope",
      "Custom storage envelope and rollout planning",
      "Shared review and multi-stakeholder workflow alignment",
      "Commercial discussion for legal, compliance, claims, or enterprise review teams",
    ],
    operationalFit: [
      "Procurement and security review",
      "Retention and governance alignment",
      "Departmental or organization-wide rollout",
      "Higher-volume evidence operations",
    ],
    supportWindow:
      "Enterprise inquiries are typically reviewed within 4 business hours, depending on workflow clarity and commercial fit.",
  };

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
        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[980px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0]">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Pricing
              </div>

              <h1 className="mt-5 max-w-[920px] text-[1.72rem] font-medium leading-[1.01] tracking-[-0.045em] text-[#edf1ef] md:text-[2.26rem] lg:text-[2.94rem]">
                Choose the evidence workflow that fits your
                <span className="text-[#bfe8df]">
                  {" "}
                  review volume, operational shape, and organizational scope
                </span>
              </h1>

              <p className="mt-5 max-w-[860px] text-[0.95rem] font-normal leading-[1.82] tracking-[-0.006em] text-[#c7cfcc] md:text-[1rem]">
                Use self-serve plans for individual and standard team workflows.
                Use the enterprise path when you need procurement discussion,
                retention alignment, governance review, rollout planning, shared
                review structure, or larger-volume evidence operations.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Link href="/contact-sales">
                  <Button
                    className="rounded-[999px] border px-6 py-3 text-[0.94rem] font-semibold"
                    style={{
                      borderColor: "rgba(79,112,107,0.22)",
                      color: "#eef3f1",
                      background:
                        "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
                    }}
                  >
                    Contact Sales
                  </Button>
                </Link>

                <Link href="/contact-sales">
                  <Button
                    variant="secondary"
                    className="rounded-[999px] border px-6 py-3 text-[0.94rem] font-semibold"
                    style={{
                      borderColor: "rgba(79,112,107,0.18)",
                      color: "#23373b",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(242,244,241,0.84) 100%)",
                      boxShadow:
                        "0 10px 22px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.78)",
                    }}
                  >
                    Request demo
                  </Button>
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
        <div className="container relative z-10 mx-auto max-w-7xl px-6 md:px-8">
          <div className="mb-4">
            <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#8a7562]">
              Self-serve plans
            </div>
            <div className="mt-2 max-w-[860px] text-[0.92rem] leading-[1.78] text-[#5d6d71]">
              Choose one of these plans when you can complete selection directly
              through standard billing without a sales-led procurement or rollout
              process.
            </div>
          </div>

          <div
            className="pricing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 18,
            }}
          >
            {plans.map((plan) => {
              const isHovered = hoveredPlan === plan.key;
              const tone = getPlanToneStyles(plan.tone);

              return (
                <div
                  key={plan.key}
                  onMouseEnter={() => setHoveredPlan(plan.key)}
                  onMouseLeave={() => setHoveredPlan(null)}
                  style={{
                    transform: isHovered ? "translateY(-4px)" : "none",
                    transition: "transform 180ms ease",
                  }}
                >
                  <Card
                    className="pricing-card relative h-full overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                    style={{
                      border: tone.border,
                      boxShadow:
                        "0 18px 38px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.48)",
                    }}
                  >
                    <div className="absolute inset-0">
                      <img
                        src="/images/panel-silver.webp.png"
                        alt=""
                        className="h-full w-full object-cover object-center"
                      />
                    </div>

                    <div
                      className="absolute inset-0"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(255,255,255,0.20) 0%, rgba(248,249,246,0.28) 42%, rgba(239,241,238,0.36) 100%)",
                      }}
                    />
                    <div
                      className="absolute inset-0"
                      style={{ background: tone.halo }}
                    />

                    <div className="relative z-10 flex h-full flex-col p-6 md:p-7">
                      <div>
                        <div
                          className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.16em]"
                          style={{
                            color: tone.eyebrow,
                            border: "1px solid rgba(79,112,107,0.10)",
                            background: "rgba(255,255,255,0.44)",
                          }}
                        >
                          {plan.eyebrow}
                        </div>

                        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                          <div>
                            <p
                              className="text-[1.42rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[1.62rem]"
                              style={{ color: tone.title, margin: 0 }}
                            >
                              {plan.title}
                            </p>

                            <p
                              className="mt-3 text-[1.42rem] font-medium leading-[1.02] tracking-[-0.03em] md:text-[1.56rem]"
                              style={{ color: tone.title }}
                            >
                              {plan.priceLabel ?? "—"}
                            </p>
                          </div>

                          <div
                            className="rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.16em]"
                            style={{
                              color: "#7a6a58",
                              border: "1px solid rgba(183,157,132,0.14)",
                              background:
                                "linear-gradient(180deg, rgba(247,242,237,0.80) 0%, rgba(255,255,255,0.65) 100%)",
                            }}
                          >
                            {plan.billingModel === "free"
                              ? "Free plan"
                              : plan.billingModel === "one_time"
                                ? "One-time checkout"
                                : "Recurring monthly"}
                          </div>
                        </div>

                        <p className="mt-4 text-[0.98rem] font-semibold tracking-[-0.02em] text-[#23373b]">
                          {plan.bestFor}
                        </p>

                        <p className="mt-2 text-[0.91rem] leading-[1.82] text-[#55686c]">
                          {plan.summary}
                        </p>
                      </div>

                      <div
                        className="mt-5 rounded-[20px] border px-4 py-4"
                        style={{
                          border: "1px solid rgba(79,112,107,0.10)",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(243,245,242,0.88) 100%)",
                        }}
                      >
                        <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                          Included
                        </div>

                        <ul
                          style={{
                            margin: "12px 0 0",
                            paddingLeft: 0,
                            listStyle: "none",
                          }}
                          className="flex flex-col gap-3"
                        >
                          {plan.features.map((feature, index) => (
                            <li
                              key={`${plan.key}-${index}`}
                              className="flex items-start gap-3 text-[0.93rem] leading-[1.76] text-[#415257]"
                            >
                              <span
                                className="inline-block shrink-0 rounded-full"
                                style={{
                                  marginTop: 8,
                                  width: 9,
                                  height: 9,
                                  background: tone.dot,
                                  flexShrink: 0,
                                }}
                              />
                              <span>{feature}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {plan.limitations?.length ? (
                        <div
                          className="mt-4 rounded-[20px] border px-4 py-4 text-[0.86rem] leading-[1.72] text-[#7a5b5b]"
                          style={{
                            border: "1px solid rgba(194,78,78,0.10)",
                            background: "rgba(194,78,78,0.04)",
                          }}
                        >
                          <div className="mb-2 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#9c6a6a]">
                            Not included
                          </div>
                          {plan.limitations.map((item, index) => (
                            <div key={index}>{item}</div>
                          ))}
                        </div>
                      ) : null}

                      {plan.helper ? (
                        <div
                          className="mt-4 rounded-[20px] border px-4 py-4 text-[0.86rem] leading-[1.76] text-[#5a6c70]"
                          style={{
                            border: "1px solid rgba(79,112,107,0.10)",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
                          }}
                        >
                          {plan.helper}
                        </div>
                      ) : null}

                      <div className="mt-5 flex items-center">
                        <Link
                          href={plan.ctaHref}
                          onClick={() =>
                            addToast(`Opening ${plan.title} flow...`, "info")
                          }
                          className="inline-flex"
                        >
                          <Button
                            variant="secondary"
                            className="min-h-[44px] rounded-[999px] border px-5 py-2.5 text-[0.9rem] font-semibold"
                            style={sharedCardButtonStyle}
                          >
                            {plan.ctaLabel}
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>

          <div className="mt-8">
            <div className="mb-4">
              <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#8a7562]">
                Sales-led enterprise path
              </div>
              <div className="mt-2 max-w-[860px] text-[0.92rem] leading-[1.78] text-[#5d6d71]">
                Use this route when the workflow is bigger than standard self-serve
                checkout and needs procurement, governance, rollout, retention, or
                larger-volume planning.
              </div>
            </div>

            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{
                border: "1px solid rgba(183,157,132,0.22)",
                boxShadow:
                  "0 18px 38px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.48)",
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.20) 0%, rgba(248,249,246,0.28) 42%, rgba(239,241,238,0.36) 100%)",
                }}
              />
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "radial-gradient(circle at top right, rgba(214,184,157,0.16), transparent 36%)",
                }}
              />

              <div className="relative z-10 p-6 md:p-7 lg:p-8">
                <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
                  <div>
                    <div
                      className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.16em]"
                      style={{
                        color: "#9b826b",
                        border: "1px solid rgba(183,157,132,0.16)",
                        background:
                          "linear-gradient(180deg, rgba(247,242,237,0.78) 0%, rgba(255,255,255,0.64) 100%)",
                      }}
                    >
                      Enterprise path
                    </div>

                    <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <p
                          className="text-[1.5rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[1.86rem]"
                          style={{ color: "#23373b", margin: 0 }}
                        >
                          {enterprise.displayName}
                        </p>

                        <p
                          className="mt-3 text-[1.42rem] font-medium leading-[1.02] tracking-[-0.03em] md:text-[1.56rem]"
                          style={{ color: "#23373b" }}
                        >
                          Custom
                        </p>
                      </div>

                      <div
                        className="rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.16em]"
                        style={{
                          color: "#7a6a58",
                          border: "1px solid rgba(183,157,132,0.14)",
                          background:
                            "linear-gradient(180deg, rgba(247,242,237,0.80) 0%, rgba(255,255,255,0.65) 100%)",
                        }}
                      >
                        Sales-led discussion
                      </div>
                    </div>

                    <p className="mt-4 text-[1rem] font-semibold tracking-[-0.02em] text-[#23373b]">
                      Procurement, governance, and larger organizational fit
                    </p>

                    <p className="mt-2 max-w-[760px] text-[0.92rem] leading-[1.82] text-[#55686c]">
                      {enterprise.summary}
                    </p>

                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <div
                        className="rounded-[20px] border px-4 py-4"
                        style={{
                          border: "1px solid rgba(79,112,107,0.10)",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(243,245,242,0.88) 100%)",
                        }}
                      >
                        <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                          Typical enterprise needs
                        </div>

                        <ul
                          style={{
                            margin: "12px 0 0",
                            paddingLeft: 0,
                            listStyle: "none",
                          }}
                          className="flex flex-col gap-3"
                        >
                          {enterprise.capabilities.map((feature, index) => (
                            <li
                              key={index}
                              className="flex items-start gap-3 text-[0.93rem] leading-[1.76] text-[#415257]"
                            >
                              <span
                                className="inline-block shrink-0 rounded-full"
                                style={{
                                  marginTop: 8,
                                  width: 9,
                                  height: 9,
                                  background: "#c9a98b",
                                  flexShrink: 0,
                                }}
                              />
                              <span>{feature}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="grid gap-4">
                        <div
                          className="rounded-[20px] border px-4 py-4 text-[0.86rem] leading-[1.76] text-[#5a6c70]"
                          style={{
                            border: "1px solid rgba(79,112,107,0.10)",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
                          }}
                        >
                          <div className="mb-2 text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                            Operational fit
                          </div>
                          {enterprise.operationalFit.join(" · ")}
                        </div>

                        <div
                          className="rounded-[20px] border px-4 py-4 text-[0.86rem] leading-[1.76] text-[#5a6c70]"
                          style={{
                            border: "1px solid rgba(183,157,132,0.14)",
                            background:
                              "linear-gradient(180deg, rgba(247,242,237,0.84) 0%, rgba(255,255,255,0.66) 100%)",
                          }}
                        >
                          {enterprise.supportWindow}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    className="rounded-[24px] border px-5 py-5 md:px-6 md:py-6"
                    style={{
                      border: "1px solid rgba(183,157,132,0.16)",
                      background:
                        "linear-gradient(180deg, rgba(247,242,237,0.90) 0%, rgba(255,255,255,0.74) 100%)",
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.62), 0 12px 24px rgba(92,69,50,0.05)",
                    }}
                  >
                    <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                      When to use this route
                    </div>

                    <div className="mt-3 text-[1rem] font-semibold tracking-[-0.02em] text-[#23373b]">
                      Not just more seats. A different commercial path.
                    </div>

                    <div className="mt-3 text-[0.9rem] leading-[1.82] text-[#5d6d71]">
                      Choose Enterprise when the decision includes procurement,
                      internal approvals, department rollout, retention-policy
                      alignment, or a broader review workflow than standard
                      checkout.
                    </div>

                    <div className="mt-5 flex flex-col gap-3">
                      <Link href={enterprise.ctaHref} className="block">
                        <Button
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-semibold"
                          style={{
                            borderColor: "rgba(79,112,107,0.22)",
                            color: "#eef3f1",
                            background:
                              "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
                            boxShadow:
                              "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
                          }}
                        >
                          {enterprise.ctaLabel}
                        </Button>
                      </Link>

                      <Link href="/contact-sales" className="block">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-semibold"
                          style={{
                            borderColor: "rgba(183,157,132,0.18)",
                            color: "#7a624d",
                            background:
                              "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.68) 100%)",
                            boxShadow:
                              "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
                          }}
                        >
                          Request demo
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {storageAddonSummary ? (
            <div
              className="mt-8 rounded-[30px] border px-6 py-6 md:px-7 md:py-7"
              style={{
                border: "1px solid rgba(79,112,107,0.14)",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.72) 0%, rgba(243,245,242,0.96) 100%)",
                boxShadow:
                  "0 18px 36px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.55)",
              }}
            >
              <div className="text-[1.18rem] font-semibold tracking-[-0.025em] text-[#21353a]">
                Extra storage add-ons
              </div>

              <div className="mt-2 max-w-[920px] text-[0.94rem] leading-[1.8] text-[#5d6d71]">
                Storage top-ups are purchased inside the Billing console as
                one-time expansions. Eligibility depends on workspace type and
                base plan. For larger commercial storage planning, use Contact
                Sales.
              </div>

              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <div
                  className="rounded-[24px] border px-5 py-5"
                  style={{
                    border: "1px solid rgba(79,112,107,0.10)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(243,245,242,0.88) 100%)",
                  }}
                >
                  <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#8a7562]">
                    Personal workspace top-ups
                  </div>

                  <div className="mt-4 grid gap-3">
                    {storageAddonSummary.personal.length === 0 ? (
                      <div className="text-[0.88rem] leading-[1.8] text-[#5d6d71]">
                        No personal storage add-ons published.
                      </div>
                    ) : (
                      storageAddonSummary.personal.map((item) => (
                        <div
                          key={item.key}
                          className="rounded-[18px] border px-4 py-4"
                          style={{
                            border: "1px solid rgba(79,112,107,0.10)",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.50) 0%, rgba(243,245,242,0.86) 100%)",
                          }}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-[0.96rem] font-semibold text-[#21353a]">
                                {item.label}
                              </div>
                              <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                                {formatBytesCompact(item.storageBytes)} extra
                                storage
                              </div>
                            </div>
                            <div className="text-[0.94rem] font-semibold text-[#23373b]">
                              {formatAddonMoney(item)}
                            </div>
                          </div>
                          <div className="mt-2 text-[0.8rem] text-[#7a878a]">
                            One-time purchase
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div
                  className="rounded-[24px] border px-5 py-5"
                  style={{
                    border: "1px solid rgba(79,112,107,0.10)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(243,245,242,0.88) 100%)",
                  }}
                >
                  <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#8a7562]">
                    Team workspace top-ups
                  </div>

                  <div className="mt-4 grid gap-3">
                    {storageAddonSummary.team.length === 0 ? (
                      <div className="text-[0.88rem] leading-[1.8] text-[#5d6d71]">
                        No team storage add-ons published.
                      </div>
                    ) : (
                      storageAddonSummary.team.map((item) => (
                        <div
                          key={item.key}
                          className="rounded-[18px] border px-4 py-4"
                          style={{
                            border: "1px solid rgba(79,112,107,0.10)",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.50) 0%, rgba(243,245,242,0.86) 100%)",
                          }}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-[0.96rem] font-semibold text-[#21353a]">
                                {item.label}
                              </div>
                              <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                                {formatBytesCompact(item.storageBytes)} extra
                                storage
                              </div>
                            </div>
                            <div className="text-[0.94rem] font-semibold text-[#23373b]">
                              {formatAddonMoney(item)}
                            </div>
                          </div>
                          <div className="mt-2 text-[0.8rem] text-[#7a878a]">
                            One-time purchase
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-8 grid gap-6">
            <PricingComparisonTable
              free={catalog?.free ?? null}
              payg={catalog?.payg ?? null}
              pro={catalog?.pro ?? null}
              team={catalog?.team ?? null}
              enterprise={catalog?.enterprise ?? null}
            />

            <PricingCheckoutGuide />
          </div>

          <div className="mt-6 text-[0.83rem] leading-[1.7] text-[#667174]">
            Prices shown in{" "}
            <span className="font-medium text-[#31464a]">
              {displayCurrency}
            </span>
            . VAT may apply depending on your country.
          </div>
        </div>

        <style jsx>{`
          @media (max-width: 1023px) {
            .pricing-grid {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}