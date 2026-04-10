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
          "3 evidence total (lifetime)",
          "Cryptographic fingerprint and integrity record",
          "Basic verification view",
          "PDF reports not included",
          "No shareable report package included",
        ],
      },
      {
        key: "PAYG",
        title: "PAY-PER-EVIDENCE",
        priceLabel: currency ? `${price(5)} / evidence` : null,
        pricePlaceholder: "$5 / evidence",
        features: [
          "Everything in Free",
          "Verifiable PDF report for the purchased evidence item",
          "Shareable verification link for that evidence item",
          "Audit-ready integrity fields",
          "Designed for occasional high-value evidence workflows",
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
          "Unlimited evidence capture",
          "PDF reports included",
          "Shareable verification links included",
          "Faster workflows for frequent verification",
          "Designed for individual professionals",
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
          "Shared ownership and access control",
          "Team-ready evidence organization",
          "PDF reports included",
          "Shareable verification links included",
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
            <div className="max-w-[760px]">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="h-1.5 w-1.5 rounded-full bg-[#b79d84] opacity-90" />
                Pricing
              </div>

              <h1 className="mt-5 max-w-[640px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                Pricing designed for{" "}
                <span className="text-[#bfe8df]">real-world scrutiny</span>.
              </h1>

              <p className="mt-5 max-w-[650px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                <span className="text-[#e7ece9]">PROOVRA</span> is built for situations where{" "}
                <span className="text-[#bfe8df]">integrity matters</span>. Choose a plan based on how
                often you need <span className="text-[#e6ebe8]">verification outputs</span>,{" "}
                <span className="text-[#d6b89d]">PDF reports</span>, and structured custody records.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Flexible for individuals and teams
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Built for verification workflows
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Audit-ready reporting options
                </div>
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
              const isTeam = plan.key === "TEAM";
              const isFree = plan.key === "FREE";
              const ctaHref = hasSession ? appBilling : appRegister;
              const ctaLabel = hasSession ? "Go to Billing" : "Sign up";

              const pricingButtonStyle = isHighlighted
                ? {
                    borderColor: "rgba(183,157,132,0.40)",
                    color: "#edf3f0",
                    backgroundImage:
                      "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.03) 34%, transparent 100%), url('/images/site-velvet-bg.webp.png')",
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    boxShadow:
                      isHovered
                        ? "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,46,49,0.24)"
                        : "inset 0 1px 0 rgba(255,255,255,0.07), 0 12px 26px rgba(18,46,49,0.18)",
                  }
                : isBronze
                  ? {
                      borderColor: "rgba(183,157,132,0.46)",
                      color: "#d9c1ab",
                      backgroundImage:
                        "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.025) 34%, transparent 100%), url('/images/site-velvet-bg.webp.png')",
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                      boxShadow:
                        isHovered
                          ? "inset 0 1px 0 rgba(255,255,255,0.06), 0 15px 32px rgba(58,39,25,0.20)"
                          : "inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(58,39,25,0.16)",
                    }
                  : isTeam
                    ? {
                        borderColor: "rgba(183,157,132,0.40)",
                        color: "#e5ece8",
                        backgroundImage:
                          "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.025) 34%, transparent 100%), url('/images/site-velvet-bg.webp.png')",
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        boxShadow:
                          isHovered
                            ? "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 32px rgba(15,40,43,0.22)"
                            : "inset 0 1px 0 rgba(255,255,255,0.06), 0 11px 24px rgba(15,40,43,0.17)",
                      }
                    : isFree
                      ? {
                          borderColor: "rgba(36,55,59,0.14)",
                          color: "#294047",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(245,247,245,0.92) 100%)",
                          boxShadow:
                            isHovered
                              ? "inset 0 1px 0 rgba(255,255,255,0.90), 0 12px 26px rgba(0,0,0,0.08)"
                              : "inset 0 1px 0 rgba(255,255,255,0.88), 0 8px 18px rgba(0,0,0,0.06)",
                        }
                      : {
                          borderColor: "rgba(36,55,59,0.10)",
                          color: "#2a3b40",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          boxShadow:
                            isHovered
                              ? "inset 0 1px 0 rgba(255,255,255,0.78), 0 12px 24px rgba(0,0,0,0.07)"
                              : "inset 0 1px 0 rgba(255,255,255,0.72), 0 8px 18px rgba(0,0,0,0.05)",
                        };

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
                              className={`pricing-billing-btn w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-semibold ui-transition ${
                                isHighlighted
                                  ? "hover-button-primary"
                                  : isBronze || isTeam
                                    ? "hover-button-secondary"
                                    : "hover-button-secondary"
                              }`}
                              style={pricingButtonStyle}
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

          <div className="mt-5 text-[0.82rem] leading-[1.7] text-[#667174]">
            Prices shown in{" "}
            <span className="font-medium text-[#31464a]">{currency ?? "..."}</span>. VAT may apply depending
            on your country.
          </div>

          <div className="mt-5 max-w-[980px] text-[0.82rem] leading-[1.7] text-[#667174]">
            <span className="font-medium text-[#31464a]">PROOVRA</span> is a technical evidence-integrity platform.
            It does not provide legal advice, and use of the platform does not guarantee admissibility in any
            jurisdiction.
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}