"use client";

import { useEffect, useMemo, useState } from "react";
import {
  convertUsd,
  detectCurrency,
  formatMoney,
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
  if (hostname === "localhost" || hostname === "127.0.0.1") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_BASE ?? process.env.NEXT_PUBLIC_WEB_BASE ?? "";
}

type PlanKey = "FREE" | "PAYG" | "PRO" | "TEAM";

type Plan = {
  key: PlanKey;
  title: string;
  priceLabel: string | null;
  billingModel: "free" | "one_time" | "monthly";
  bestFor: string;
  features: string[];
  exclusions?: string[];
  note?: string | null;
  accent?: "bronze" | "teal";
  highlighted?: boolean;
  ctaLabel: string;
  ctaHref: string;
};

export default function MarketingPricingPage() {
  const { addToast } = useToast();
  const { hasSession } = useAuth();
  const [hoveredPlan, setHoveredPlan] = useState<string | null>(null);
  const [currency, setCurrency] = useState<SupportedCurrency | null>(null);
  const [catalog, setCatalog] = useState<PricingCatalogResponse | null>(null);

  useEffect(() => {
    setCurrency(detectCurrency() as SupportedCurrency);
  }, []);

  useEffect(() => {
    apiFetch("/v1/billing/pricing", { method: "GET" }, { auth: false, retryAuthOnce: false })
      .then((data) => setCatalog((data ?? null) as PricingCatalogResponse | null))
      .catch(() => setCatalog(null));
  }, []);

  const appBase = getAppBase();
  const appBilling = appBase ? `${appBase}/billing` : "/billing";
  const appRegister = appBase ? `${appBase}/register` : "/register";

  const formatCatalogPrice = (monthlyPriceCents?: number | null) => {
    if (!currency || monthlyPriceCents == null) return null;
    return formatMoney(convertUsd(monthlyPriceCents / 100, currency), currency);
  };

  const buildCtaHref = (key: PlanKey) => {
    if (!hasSession) return appRegister;
    if (key === "TEAM") return `${appBilling}?workspace=team&plan=TEAM`;
    if (key === "FREE") return `${appBilling}?workspace=personal`;
    return `${appBilling}?workspace=personal&plan=${key}`;
  };

  const buildCtaLabel = (key: PlanKey) => {
    if (!hasSession) {
      if (key === "FREE") return "Create free account";
      return "Create account and continue";
    }

    if (key === "FREE") return "Open billing console";
    if (key === "TEAM") return "Open team checkout";
    return `Choose ${key}`;
  };

  const plans: Plan[] = useMemo(
    () => [
      {
        key: "FREE",
        title: "FREE",
        priceLabel: currency ? formatMoney(convertUsd(0, currency), currency) : null,
        billingModel: "free",
        bestFor: "Occasional personal use",
        features: [
          `${catalog?.free?.maxEvidenceRecords ?? 3} evidence records total`,
          `Storage included: ${catalog?.free?.storageLabel ?? "250 MB"}`,
          "Basic integrity record",
          "Public verification access",
        ],
        exclusions: ["PDF reports not included", "Verification package not included"],
        note: "Good for initial evaluation and low-volume personal usage.",
        ctaLabel: buildCtaLabel("FREE"),
        ctaHref: buildCtaHref("FREE"),
      },
      {
        key: "PAYG",
        title: "PAY-PER-EVIDENCE",
        priceLabel:
          currency && catalog?.payg?.monthlyPriceCents != null
            ? `${formatMoney(
                convertUsd((catalog.payg.monthlyPriceCents ?? 500) / 100, currency),
                currency
              )} / evidence`
            : null,
        billingModel: "one_time",
        bestFor: "Occasional professional use",
        features: [
          `Storage included: ${catalog?.payg?.storageLabel ?? "5 GB"}`,
          "PDF report included",
          "Verification package included",
          "Shareable verification link",
        ],
        note: "One-time purchase flow. Best when you do not need a recurring subscription.",
        accent: "teal",
        highlighted: true,
        ctaLabel: buildCtaLabel("PAYG"),
        ctaHref: buildCtaHref("PAYG"),
      },
      {
        key: "PRO",
        title: "PRO",
        priceLabel: currency
          ? `${formatCatalogPrice(catalog?.pro?.monthlyPriceCents)} / month`
          : null,
        billingModel: "monthly",
        bestFor: "Recurring individual professional use",
        features: [
          `Storage included: ${catalog?.pro?.storageLabel ?? "100 GB"}`,
          "Unlimited evidence records",
          "PDF reports included",
          "Verification packages included",
        ],
        note: "For professionals who need recurring access and higher ongoing volume.",
        accent: "bronze",
        ctaLabel: buildCtaLabel("PRO"),
        ctaHref: buildCtaHref("PRO"),
      },
      {
        key: "TEAM",
        title: "TEAM",
        priceLabel: currency
          ? `${formatCatalogPrice(catalog?.team?.monthlyPriceCents)} / month`
          : null,
        billingModel: "monthly",
        bestFor: "Firms, teams, investigations, and organizations",
        features: [
          `${catalog?.team?.seats ?? 5} seats included`,
          `Storage included: ${catalog?.team?.storageLabel ?? "500 GB"}`,
          "Shared workspace and member management",
          "Reports and verification packages included",
        ],
        note: "Requires an owned team workspace before checkout.",
        ctaLabel: buildCtaLabel("TEAM"),
        ctaHref: buildCtaHref("TEAM"),
      },
    ],
    [currency, catalog, hasSession, appBilling, appRegister]
  );

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
            <div className="max-w-[880px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0]">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Pricing
              </div>

              <h1 className="mt-5 max-w-[860px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                Choose the evidence workflow that fits your
                <span className="text-[#bfe8df]"> review and case volume needs</span>
              </h1>

              <p className="mt-5 max-w-[820px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                All plans include secure evidence storage. Report access, verification
                packages, recurring subscriptions, and team capacity depend on the
                selected plan. Billing continues inside the workspace console where
                the correct personal or team context is enforced.
              </p>
            </div>
          </section>
        </div>
      </div>

      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 48, paddingBottom: 56 }}
      >
        <div className="container relative z-10 mx-auto max-w-7xl px-6 md:px-8">
          <div
            className="pricing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
              gap: 18,
            }}
          >
            {plans.map((plan) => {
              const isHovered = hoveredPlan === plan.key;
              const isHighlighted = !!plan.highlighted;
              const isBronze = plan.accent === "bronze";

              return (
                <div
                  key={plan.key}
                  onMouseEnter={() => setHoveredPlan(plan.key)}
                  onMouseLeave={() => setHoveredPlan(null)}
                  style={{ transform: isHovered ? "translateY(-4px)" : "none" }}
                >
                  <Card
                    className="pricing-card relative h-full overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
                    style={{
                      border: isHighlighted
                        ? "1px solid rgba(158,216,207,0.22)"
                        : isBronze
                          ? "1px solid rgba(183,157,132,0.18)"
                          : "1px solid rgba(255,255,255,0.42)",
                      boxShadow:
                        "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)",
                    }}
                  >
                    <div className="absolute inset-0">
                      <img
                        src="/images/panel-silver.webp.png"
                        alt=""
                        className="h-full w-full object-cover object-center"
                      />
                    </div>

                    <div className="relative z-10 flex h-full flex-col p-6 md:p-7">
                      <div>
                        <p
                          className="text-[0.72rem] font-medium uppercase tracking-[0.18em]"
                          style={{
                            color: isHighlighted ? "#2f6965" : isBronze ? "#9b826b" : "#405357",
                          }}
                        >
                          {plan.title}
                        </p>

                        <p
                          className="mt-4 text-[1.36rem] font-medium leading-[1.02] tracking-[-0.03em] md:text-[1.48rem]"
                          style={{
                            color: isHighlighted ? "#18383d" : "#21353a",
                          }}
                        >
                          {plan.priceLabel ?? "—"}
                        </p>

                        <p className="mt-3 text-[0.9rem] leading-[1.7] text-[#516367]">
                          {plan.bestFor}
                        </p>

                        <p className="mt-2 text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                          {plan.billingModel === "free"
                            ? "Free plan"
                            : plan.billingModel === "one_time"
                              ? "One-time checkout"
                              : "Recurring monthly subscription"}
                        </p>
                      </div>

                      <ul
                        style={{
                          margin: "18px 0 14px",
                          paddingLeft: 0,
                          listStyle: "none",
                          color: "#475569",
                          lineHeight: 1.75,
                        }}
                        className="flex flex-col gap-3"
                      >
                        {plan.features.map((feature, index) => (
                          <li
                            key={`${plan.key}-${index}`}
                            className="flex items-start gap-3 text-[0.94rem] leading-[1.68] text-[#415257]"
                          >
                            <span
                              className="mt-[0.40rem] inline-block h-[8px] w-[8px] shrink-0 rounded-full"
                              style={{
                                background: isHighlighted
                                  ? "#7fbdb4"
                                  : isBronze
                                    ? "#c9a98b"
                                    : "#7ea9a2",
                              }}
                            />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>

                      {plan.exclusions?.length ? (
                        <div className="mb-3 rounded-[16px] border border-[rgba(194,78,78,0.10)] bg-[rgba(194,78,78,0.04)] px-4 py-3 text-[0.84rem] leading-[1.7] text-[#7a5b5b]">
                          {plan.exclusions.map((item, index) => (
                            <div key={index}>{item}</div>
                          ))}
                        </div>
                      ) : null}

                      {plan.note ? (
                        <div className="mb-4 rounded-[16px] border border-[rgba(79,112,107,0.10)] bg-[rgba(255,255,255,0.45)] px-4 py-3 text-[0.84rem] leading-[1.7] text-[#5a6c70]">
                          {plan.note}
                        </div>
                      ) : null}

                      <div className="mt-auto">
                        <a
                          href={plan.ctaHref}
                          onClick={() => addToast(`Opening ${plan.title} flow...`, "info")}
                          className="block"
                        >
                          <Button
                            variant="secondary"
                            className="w-full rounded-[16px] border px-5 py-3 text-[0.95rem] font-medium"
                          >
                            {plan.ctaLabel} ›
                          </Button>
                        </a>
                      </div>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>

          <div className="mt-8 grid gap-6">
            <PricingComparisonTable
              free={catalog?.free ?? null}
              payg={catalog?.payg ?? null}
              pro={catalog?.pro ?? null}
              team={catalog?.team ?? null}
            />

            <PricingCheckoutGuide />
          </div>

          <div className="mt-5 text-[0.82rem] leading-[1.7] text-[#667174]">
            Prices shown in <span className="font-medium text-[#31464a]">{currency ?? "..."}</span>.
            VAT may apply depending on your country.
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}