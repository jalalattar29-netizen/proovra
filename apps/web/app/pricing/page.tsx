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
  pricePlaceholder: string;
  features: string[];
  accent?: "bronze" | "teal";
  highlighted?: boolean;
};

export default function MarketingPricingPage() {
  const { addToast } = useToast();
  const { hasSession } = useAuth();
  const [hoveredPlan, setHoveredPlan] = useState<string | null>(null);
  const [currency, setCurrency] = useState<SupportedCurrency | null>(null);

  useEffect(() => {
    setCurrency(detectCurrency() as SupportedCurrency);
  }, []);

  const appBase = getAppBase();
  const appBilling = appBase ? `${appBase}/billing` : "/billing";
  const appRegister = appBase ? `${appBase}/register` : "/register";
  const requestDemoUrl = "/request-demo";

  const price = (usd: number) => {
    if (!currency) return null;
    return formatMoney(convertUsd(usd, currency), currency);
  };

  const handlePlanSelect = (plan: string) => {
    if (hasSession) {
      addToast(`Redirecting to billing for ${plan} plan...`, "info");
    } else {
      addToast(`Creating account to select ${plan} plan...`, "info");
    }
  };

  const plans: Plan[] = useMemo(
    () => [
      {
        key: "FREE",
        title: "FREE",
        priceLabel: price(0),
        pricePlaceholder: "$0",
        features: [
          "3 evidence records total",
          "Basic integrity record",
          "Basic verification access",
          "No included PDF report workflow",
          "Good for initial evaluation",
        ],
      },
      {
        key: "PAYG",
        title: "PAY-PER-EVIDENCE",
        priceLabel: currency ? `${price(5)} / evidence` : null,
        pricePlaceholder: "$5 / evidence",
        features: [
          "Everything in Free",
          "Verification-ready PDF report for the purchased record",
          "Shareable verification link for that record",
          "Useful for occasional high-value evidence workflows",
          "Good for disputes, claims, and one-off reviews",
        ],
        accent: "teal",
        highlighted: true,
      },
      {
        key: "PRO",
        title: "PRO",
        priceLabel: currency ? `${price(19)} / month` : null,
        pricePlaceholder: "$19 / month",
        features: [
          "Unlimited evidence records",
          "Reports included",
          "Verification links included",
          "Designed for recurring professional use",
          "Best for individual legal, risk, and review workflows",
        ],
        accent: "bronze",
      },
      {
        key: "TEAM",
        title: "TEAM (5 seats)",
        priceLabel: currency ? `${price(79)} / month` : null,
        pricePlaceholder: "$79 / month",
        features: [
          "5 team members included",
          "Shared access and ownership controls",
          "Team-ready evidence organization",
          "Reports and verification links included",
          "Best for internal reviews, investigations, and claims teams",
        ],
      },
    ],
    [currency]
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
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[820px]">
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Pricing
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                Pricing for
                <span className="text-[#bfe8df]"> review-ready evidence workflows</span>
              </h1>

              <p className="mt-5 max-w-[760px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                Choose a plan based on how often you need review-ready evidence
                records, verification output, structured reports, and
                team-facing review workflows.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Built for individuals and teams
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Verification-first workflow
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Reports and reviewer-facing outputs included where needed
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="/brand/sample-report.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
                >
                  View Sample Report
                </a>

                <a
                  href={requestDemoUrl}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
                >
                  Request Demo
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

        <div className="container relative z-10 mx-auto max-w-7xl px-6 md:px-8">
          <div
            className="pricing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 18,
            }}
          >
            {plans.map((plan) => {
              const isHovered = hoveredPlan === plan.key;
              const isHighlighted = !!plan.highlighted;
              const isBronze = plan.accent === "bronze";
              const ctaHref = hasSession ? appBilling : appRegister;
              const ctaLabel = hasSession ? "Go to Billing" : "Sign up";

              return (
                <div
                  key={plan.key}
                  onMouseEnter={() => setHoveredPlan(plan.key)}
                  onMouseLeave={() => setHoveredPlan(null)}
                  className="ui-transition"
                  style={{
                    transform: isHovered ? "translateY(-4px)" : "none",
                  }}
                >
                  <Card
                    className="pricing-card relative h-full overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
                    style={{
                      border: isHighlighted
                        ? "1px solid rgba(158,216,207,0.22)"
                        : isBronze
                          ? "1px solid rgba(183,157,132,0.18)"
                          : "1px solid rgba(255,255,255,0.42)",
                      boxShadow: isHighlighted
                        ? isHovered
                          ? "0 24px 42px rgba(11, 31, 36, 0.12), 0 0 0 1px rgba(158,216,207,0.08)"
                          : "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)"
                        : isBronze
                          ? isHovered
                            ? "0 24px 42px rgba(50, 34, 22, 0.10), 0 0 0 1px rgba(183,157,132,0.08)"
                            : "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)"
                          : "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)",
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
                        background: isHighlighted
                          ? "linear-gradient(180deg, rgba(191,232,223,0.10) 0%, rgba(255,255,255,0.18) 100%)"
                          : isBronze
                            ? "linear-gradient(180deg, rgba(214,184,157,0.08) 0%, rgba(255,255,255,0.18) 100%)"
                            : "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.18) 100%)",
                      }}
                    />

                    {isHighlighted ? (
                      <div className="absolute right-4 top-4 rounded-full border border-[#9ed8cf]/24 bg-[linear-gradient(180deg,rgba(158,216,207,0.16)_0%,rgba(255,255,255,0.08)_100%)] px-3 py-1.5 text-[0.72rem] font-medium uppercase tracking-[0.18em] text-[#2c5b58] shadow-[0_8px_18px_rgba(0,0,0,0.06)]">
                        Most flexible
                      </div>
                    ) : null}

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
                            minHeight: "2.8rem",
                          }}
                        >
                          {plan.priceLabel ? (
                            plan.priceLabel
                          ) : (
                            <span className="opacity-0" aria-hidden="true">
                              {plan.pricePlaceholder}
                            </span>
                          )}
                        </p>
                      </div>

                      <ul
                        style={{
                          margin: "18px 0 22px",
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
                                boxShadow: isHighlighted
                                  ? "0 0 5px rgba(127,189,180,0.14)"
                                  : isBronze
                                    ? "0 0 5px rgba(201,169,139,0.12)"
                                    : "0 0 4px rgba(126,169,162,0.08)",
                              }}
                            />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-auto">
                        <div className="pricing-cta">
                          <a href={ctaHref} onClick={() => handlePlanSelect(plan.title)} className="block">
                            <Button
                              variant="secondary"
                              className={`pricing-billing-btn w-full rounded-[16px] border px-5 py-3 text-[0.95rem] font-medium ui-transition ${
                                isHighlighted
                                  ? "hover-button-primary"
                                  : isBronze
                                    ? "hover-button-bronze"
                                    : "hover-button-secondary"
                              }`}
                              style={{
                                borderColor: isHighlighted
                                  ? "rgba(158,216,207,0.22)"
                                  : isBronze
                                    ? "rgba(183,157,132,0.24)"
                                    : "rgba(36,55,59,0.10)",
                                color: isHighlighted ? "#214648" : isBronze ? "#8f7257" : "#2a3b40",
                                background: isHighlighted
                                  ? "linear-gradient(180deg, rgba(191,232,223,0.22) 0%, rgba(255,255,255,0.52) 100%)"
                                  : isBronze
                                    ? "linear-gradient(180deg, rgba(214,184,157,0.16) 0%, rgba(255,255,255,0.52) 100%)"
                                    : "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                              }}
                            >
                              {ctaLabel} ›
                            </Button>
                          </a>
                        </div>
                      </div>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>

          <div className="mt-6 max-w-[980px] text-[0.9rem] leading-[1.75] text-[#55666a]">
            For procurement, team rollout, governance review, or higher-volume
            workflows, use the enterprise path instead of self-serve plan
            selection.
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <a
              href={requestDemoUrl}
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#b39b86]/42 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] px-6 py-3 text-sm font-semibold text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] transition duration-300 hover:translate-y-[-1px]"
            >
              Request Demo
            </a>

            <a
              href="/legal/verification-methodology"
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
            >
              View Verification Methodology
            </a>

            <a
              href="/contact-sales"
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
            >
              Contact Sales
            </a>
          </div>

          <div className="mt-5 text-[0.82rem] leading-[1.7] text-[#667174]">
            Prices shown in <span className="font-medium text-[#31464a]">{currency ?? "..."}</span>. VAT may apply depending
            on your country.
          </div>

          <div className="mt-5 max-w-[980px] text-[0.82rem] leading-[1.7] text-[#667174]">
            <span className="font-medium text-[#31464a]">PROOVRA</span> is a technical
            integrity and verification platform. It does not provide legal advice,
            and use of the platform does not by itself guarantee admissibility in any jurisdiction.
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}