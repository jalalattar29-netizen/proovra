"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { detectCurrency } from "../../../lib/currency";
import { Button, Card, useToast, Skeleton } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { PlanType } from "../../pricing/types";

type PayPalLink = { rel: string; href: string };

export default function BillingPage() {
  const { addToast } = useToast();
  const currency = detectCurrency();

  const [plan, setPlan] = useState("FREE");
  const [credits, setCredits] = useState(0);
  const [teamSeats, setTeamSeats] = useState(0);

  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/billing/status")
      .then((data) => {
        setPlan(data.entitlement?.plan ?? "FREE");
        setCredits(data.entitlement?.credits ?? 0);
        setTeamSeats(data.entitlement?.teamSeats ?? 0);
        addToast("Billing information loaded", "success");
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load billing information";
        setError(errorMessage);
        setPlan("FREE");
        captureException(err, { feature: "billing_page_status" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  const startStripeCheckout = async (planType: PlanType) => {
    setCheckoutBusy(planType);
    addToast("Starting Stripe checkout...", "info");

    try {
      const data = await apiFetch("/v1/billing/checkout/stripe", {
        method: "POST",
        body: JSON.stringify({ plan: planType, currency }),
      });

      const url = data.session?.url as string | undefined;
      if (url) {
        addToast("Redirecting to payment...", "success");
        window.location.href = url;
      } else {
        addToast("Failed to create checkout session", "error");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Checkout failed";
      captureException(err, { feature: "stripe_checkout", plan: planType });
      addToast(errorMessage, "error");
    } finally {
      setCheckoutBusy(null);
    }
  };

  const startPayPalCheckout = async (planType: PlanType) => {
    setCheckoutBusy(planType);
    addToast("Starting PayPal checkout...", "info");

    try {
      const data = await apiFetch("/v1/billing/checkout/paypal", {
        method: "POST",
        body: JSON.stringify({ plan: planType, currency }),
      });

      const approve = (data.order?.links as PayPalLink[] | undefined)?.find(
        (l) => l.rel === "approve"
      );

      if (approve?.href) {
        addToast("Redirecting to PayPal...", "success");
        window.location.href = approve.href;
      } else {
        addToast("Failed to create PayPal order", "error");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Checkout failed";
      captureException(err, { feature: "paypal_checkout", plan: planType });
      addToast(errorMessage, "error");
    } finally {
      setCheckoutBusy(null);
    }
  };

  const outerCardStyle = {
    border: "1px solid rgba(183,157,132,0.24)",
    boxShadow:
      "0 22px 40px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const;

  const primaryVelvetButtonStyle = {
    borderColor: "rgba(183,157,132,0.24)",
    color: "#eef4f2",
    background:
      "linear-gradient(180deg, rgba(69,118,115,0.96) 0%, rgba(29,58,60,0.98) 100%)",
    boxShadow: "0 14px 28px rgba(9,27,28,0.22)",
  } as const;

  const secondaryVelvetButtonStyle = {
    borderColor: "rgba(183,157,132,0.18)",
    color: "#eef2ef",
    background:
      "linear-gradient(180deg, rgba(46,79,80,0.84) 0%, rgba(18,37,39,0.94) 100%)",
    boxShadow: "0 10px 22px rgba(0,0,0,0.14)",
  } as const;

  const renderCurrentPlanMeta = () => {
    if (plan === "PAYG") {
      return (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 14,
            lineHeight: 1.72,
            color: "rgba(219,235,248,0.78)",
          }}
        >
          Available usage credits:{" "}
          <span style={{ color: "#f3f6f4", fontWeight: 700 }}>{credits}</span>
        </p>
      );
    }

    if (plan === "TEAM") {
      return (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 14,
            lineHeight: 1.72,
            color: "rgba(219,235,248,0.78)",
          }}
        >
          Included team seats:{" "}
          <span style={{ color: "#f3f6f4", fontWeight: 700 }}>{teamSeats}</span>
        </p>
      );
    }

    if (plan === "FREE") {
      return (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 14,
            lineHeight: 1.72,
            color: "rgba(219,235,248,0.78)",
          }}
        >
          Upgrade when you need more verification, reporting, and sharing capacity.
        </p>
      );
    }

    return (
      <p
        style={{
          marginTop: 12,
          marginBottom: 0,
          fontSize: 14,
          lineHeight: 1.72,
          color: "rgba(219,235,248,0.78)",
        }}
      >
        Your subscription is active and ready for continued evidence workflows.
      </p>
    );
  };

  return (
    <div className="section app-section">
      <style jsx global>{`
        .billing-page-shell .btn:disabled {
          opacity: 0.58 !important;
          cursor: not-allowed;
          filter: saturate(0.86);
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.055)",
                  padding: "8px 16px",
                  fontSize: "0.74rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.2em",
                  color: "#dce3e0",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.10)",
                  backdropFilter: "blur(10px)",
                }}
              >
                Billing
              </div>

              <h1
                className="hero-title pricing-hero-title"
                style={{
                  margin: "16px 0 0",
                  maxWidth: 760,
                  fontSize: "clamp(2rem, 4vw, 3.2rem)",
                  lineHeight: 1.02,
                  letterSpacing: "-0.05em",
                  fontWeight: 600,
                  color: "#edf1ef",
                }}
              >
                Manage your{" "}
                <span style={{ color: "#bfe8df" }}>billing workspace</span>{" "}
                with more clarity.
              </h1>

              <p
                className="page-subtitle pricing-subtitle"
                style={{
                  marginTop: 16,
                  maxWidth: 720,
                  fontSize: "0.98rem",
                  lineHeight: 1.82,
                  color: "#c7cfcc",
                }}
              >
                Review your{" "}
                <span style={{ color: "#e7ece9" }}>current subscription</span>, switch
                between plans when needed, and manage{" "}
                <span style={{ color: "#bfe8df" }}>credits</span>,{" "}
                <span style={{ color: "#e6ebe8" }}>team access</span>, and{" "}
                <span style={{ color: "#d6b89d" }}>payment upgrades</span> from one
                place.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full billing-page-shell">
        <div
          className="container"
          style={{
            display: "grid",
            gap: 24,
            paddingBottom: 72,
          }}
        >
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.76)_0%,rgba(6,16,20,0.84)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

            <div className="relative z-10 p-6 md:p-8">
              <div
                className="mb-5 text-[1.24rem] font-semibold tracking-[-0.03em]"
                style={{ color: "#f0f4f1" }}
              >
                <span style={{ color: "#f3f6f4" }}>Current</span>{" "}
                <span style={{ color: "#d6b89d" }}>Plan</span>
              </div>

              {loading ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                    <Skeleton width="100%" height="20px" />
                  </div>
                  <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                    <Skeleton width="60%" height="16px" />
                  </div>
                </div>
              ) : error ? (
                <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                  {error}
                </div>
              ) : (
                <div
                  className="relative overflow-hidden rounded-[26px] border px-5 py-5"
                  style={{
                    border: "1px solid rgba(183,157,132,0.18)",
                    boxShadow:
                      "0 16px 30px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.03)",
                  }}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(14,31,34,0.74)_0%,rgba(8,20,24,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(158,216,207,0.08),transparent_30%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgba(214,184,157,0.06),transparent_24%)]" />

                  <div className="relative z-10">
                    <div
                      style={{
                        margin: 0,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: "0.16em",
                        textTransform: "uppercase",
                        color: "#d6b89d",
                      }}
                    >
                      Active subscription
                    </div>

                    <p
                      style={{
                        margin: "12px 0 0",
                        fontSize: 30,
                        fontWeight: 700,
                        letterSpacing: "-0.05em",
                        color: "#eef4f1",
                      }}
                    >
                      <span style={{ color: "#f3f6f4" }}>{plan}</span>{" "}
                      <span style={{ color: "#bfe8df" }}>plan</span>
                    </p>

                    {renderCurrentPlanMeta()}
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.76)_0%,rgba(6,16,20,0.84)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

            <div className="relative z-10 p-6 md:p-8">
              <div
                className="mb-2 text-[1.24rem] font-semibold tracking-[-0.03em]"
                style={{ color: "#f0f4f1" }}
              >
                <span style={{ color: "#f3f6f4" }}>Upgrade or</span>{" "}
                <span style={{ color: "#d6b89d" }}>Switch Plan</span>
              </div>

              <p
                style={{
                  margin: "0 0 18px",
                  fontSize: 14,
                  lineHeight: 1.75,
                  color: "rgba(219,235,248,0.74)",
                  maxWidth: 700,
                }}
              >
                Choose the billing path that matches how often you capture and verify
                evidence.
              </p>

              {loading ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                    <Skeleton width="100%" height="40px" />
                  </div>
                  <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                    <Skeleton width="100%" height="40px" />
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 12,
                  }}
                >
                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                    style={secondaryVelvetButtonStyle}
                    disabled={!!checkoutBusy || plan === "PAYG"}
                    onClick={() => startStripeCheckout("PAYG")}
                  >
                    {checkoutBusy === "PAYG" ? "Processing..." : "Pay-Per-Evidence"}
                  </Button>

                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                    style={primaryVelvetButtonStyle}
                    disabled={!!checkoutBusy || plan === "PRO"}
                    onClick={() => startStripeCheckout("PRO")}
                  >
                    {checkoutBusy === "PRO" ? "Processing..." : "Upgrade to Pro"}
                  </Button>

                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                    style={primaryVelvetButtonStyle}
                    disabled={!!checkoutBusy || plan === "TEAM"}
                    onClick={() => startStripeCheckout("TEAM")}
                  >
                    {checkoutBusy === "TEAM" ? "Processing..." : "Upgrade to Team"}
                  </Button>

                  <Button
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                    style={secondaryVelvetButtonStyle}
                    disabled={!!checkoutBusy}
                    onClick={() => startPayPalCheckout("PAYG")}
                  >
                    {checkoutBusy === "PAYG" ? "Processing..." : "PayPal"}
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingTop: 4,
            }}
          >
            <Link href="/pricing">
              <Button
                className="min-w-[220px] rounded-[999px] border px-7 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                style={primaryVelvetButtonStyle}
              >
                View full pricing
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}