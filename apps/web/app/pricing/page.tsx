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

  const plans: Plan[] = useMemo(
    () => [
      {
        key: "FREE",
        title: "FREE",
        priceLabel: formatCatalogMoney(0, displayCurrency),
        billingModel: "free",
        bestFor: "Occasional personal use",
        features: [
          `${catalog?.free?.maxEvidenceRecords ?? 3} evidence records total`,
          `Storage included: ${catalog?.free?.storageLabel ?? "250 MB"}`,
          "Basic recorded integrity materials",
          "Public verification access",
        ],
        exclusions: [
          "PDF reports not included",
          "Verification package not included",
          "No paid storage add-ons until base plan upgrade",
        ],
        note: "Good for initial evaluation and low-volume personal usage.",
        ctaLabel: buildCtaLabel("FREE"),
        ctaHref: buildCtaHref("FREE"),
      },
      {
        key: "PAYG",
        title: "PAY-PER-EVIDENCE",
        priceLabel:
          catalog?.payg?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.payg.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / evidence`
            : null,
        billingModel: "one_time",
        bestFor: "Occasional professional use",
        features: [
          `Storage included: ${catalog?.payg?.storageLabel ?? "5 GB"}`,
          "PDF report included",
          "Verification package included",
          "Shareable verification link",
          "Supports selected personal storage add-ons",
        ],
        note:
          "Best when you do not need a recurring subscription but still want professional evidence outputs.",
        accent: "teal",
        highlighted: true,
        ctaLabel: buildCtaLabel("PAYG"),
        ctaHref: buildCtaHref("PAYG"),
      },
      {
        key: "PRO",
        title: "PRO",
        priceLabel:
          catalog?.pro?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.pro.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / month`
            : null,
        billingModel: "monthly",
        bestFor: "Recurring individual professional use",
        features: [
          `Storage included: ${catalog?.pro?.storageLabel ?? "100 GB"}`,
          "Unlimited evidence records",
          "PDF reports included",
          "Verification packages included",
          "Supports recurring personal storage add-ons",
        ],
        note:
          "For professionals who need recurring access and higher ongoing volume.",
        accent: "bronze",
        ctaLabel: buildCtaLabel("PRO"),
        ctaHref: buildCtaHref("PRO"),
      },
      {
        key: "TEAM",
        title: "TEAM",
        priceLabel:
          catalog?.team?.monthlyPriceCents != null
            ? `${formatMoney(
                (catalog.team.monthlyPriceCents ?? 0) / 100,
                displayCurrency
              )} / month`
            : null,
        billingModel: "monthly",
        bestFor: "Firms, teams, investigations, and organizations",
        features: [
          `${catalog?.team?.seats ?? 5} seats included`,
          `Storage included: ${catalog?.team?.storageLabel ?? "500 GB"}`,
          "Shared workspace and member management",
          "Reports and verification packages included",
          "Supports recurring team storage add-ons",
        ],
        note: "Requires an owned team workspace before checkout.",
        ctaLabel: buildCtaLabel("TEAM"),
        ctaHref: buildCtaHref("TEAM"),
      },
    ],
    [displayCurrency, catalog, hasSession, appBilling, appRegister]
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
                <span className="text-[#bfe8df]">
                  {" "}
                  review and case volume needs
                </span>
              </h1>

              <p className="mt-5 max-w-[820px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                All plans include secure evidence storage. Report access,
                verification packages, recurring subscriptions, storage add-ons,
                and team capacity depend on the selected plan. Billing continues
                inside the workspace console where the correct personal or team
                context is enforced.
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
                            color: isHighlighted
                              ? "#2f6965"
                              : isBronze
                                ? "#9b826b"
                                : "#405357",
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
                        <Link
                          href={plan.ctaHref}
                          onClick={() =>
                            addToast(`Opening ${plan.title} flow...`, "info")
                          }
                          className="block"
                        >
                          <Button
                            variant="secondary"
                            className="w-full rounded-[16px] border px-5 py-3 text-[0.95rem] font-medium"
                          >
                            {plan.ctaLabel} ›
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>

          {storageAddonSummary ? (
            <div
              className="mt-8 rounded-[28px] border px-6 py-6"
              style={{
                border: "1px solid rgba(79,112,107,0.12)",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.62) 0%, rgba(243,245,242,0.92) 100%)",
              }}
            >
              <div className="text-[1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                Extra Storage Add-ons
              </div>

              <div className="mt-2 text-[0.9rem] leading-[1.75] text-[#5d6d71]">
                Add-ons are purchased inside the billing console and depend on
                workspace type and base plan eligibility.
              </div>

              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div>
                  <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                    Personal workspace add-ons
                  </div>
                  <div className="mt-3 grid gap-3">
                    {storageAddonSummary.personal.length === 0 ? (
                      <div
                        className="rounded-[18px] border px-4 py-4 text-[0.86rem] text-[#5d6d71]"
                        style={{
                          border: "1px solid rgba(79,112,107,0.10)",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                        }}
                      >
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
                              "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                          }}
                        >
                          <div className="text-[0.94rem] font-semibold text-[#21353a]">
                            {item.label}
                          </div>
                          <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                            {formatBytesCompact(item.storageBytes)} extra storage
                          </div>
                          <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                            {formatAddonMoney(item)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#8a7562]">
                    Team workspace add-ons
                  </div>
                  <div className="mt-3 grid gap-3">
                    {storageAddonSummary.team.length === 0 ? (
                      <div
                        className="rounded-[18px] border px-4 py-4 text-[0.86rem] text-[#5d6d71]"
                        style={{
                          border: "1px solid rgba(79,112,107,0.10)",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                        }}
                      >
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
                              "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                          }}
                        >
                          <div className="text-[0.94rem] font-semibold text-[#21353a]">
                            {item.label}
                          </div>
                          <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                            {formatBytesCompact(item.storageBytes)} extra storage
                          </div>
                          <div className="mt-1 text-[0.86rem] text-[#5d6d71]">
                            {formatAddonMoney(item)}
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
            />

            <PricingCheckoutGuide />
          </div>

          <div className="mt-5 text-[0.82rem] leading-[1.7] text-[#667174]">
            Prices shown in{" "}
            <span className="font-medium text-[#31464a]">
              {displayCurrency}
            </span>
            . VAT may apply depending on your country.
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}