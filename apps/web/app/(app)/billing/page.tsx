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

  const primaryVelvetButtonStyle = {
    borderColor: "rgba(183,157,132,0.24)",
    color: "#eef4f2",
    background:
      "linear-gradient(180deg, rgba(64,106,104,0.94) 0%, rgba(26,52,55,0.98) 100%)",
    boxShadow: "0 14px 28px rgba(9,27,28,0.22)",
  } as const;

  const secondaryVelvetButtonStyle = {
    borderColor: "rgba(183,157,132,0.18)",
    color: "#edf2ef",
    background:
      "linear-gradient(180deg, rgba(42,72,74,0.82) 0%, rgba(20,39,42,0.92) 100%)",
    boxShadow: "0 10px 22px rgba(0,0,0,0.14)",
  } as const;

  const shellCardStyle = {
    border: "1px solid rgba(183,157,132,0.22)",
    boxShadow:
      "0 20px 38px rgba(0, 0, 0, 0.14), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const;

  return (
    <div className="section app-section">
      <style jsx global>{`
        .billing-page-shell .btn:disabled {
          opacity: 0.58 !important;
          cursor: not-allowed;
          filter: saturate(0.85);
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Billing
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Manage your plan and upgrade when you need more.
              </p>
            </div>

            <Link href="/pricing">
              <Button className="navy-btn" variant="secondary">
                View full pricing
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full billing-page-shell">
        <div className="container" style={{ display: "grid", gap: 24 }}>
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={shellCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.76)_0%,rgba(6,16,20,0.80)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div className="mb-5 text-[1.15rem] font-semibold tracking-[-0.03em] text-[#f0f4f1]">
                <span className="text-[#f3f6f4]">Current</span>{" "}
                <span className="text-[#d8dfdc]">Plan</span>
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
                  className="rounded-[24px] border px-5 py-5"
                  style={{
                    border: "1px solid rgba(183,157,132,0.14)",
                    background:
                      "linear-gradient(180deg, rgba(9,28,33,0.82) 0%, rgba(8,21,25,0.90) 100%)",
                    boxShadow: "0 14px 24px rgba(0,0,0,0.12)",
                  }}
                >
                  <div
                    style={{
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "#d6b89d",
                    }}
                  >
                    Active subscription
                  </div>

                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: 26,
                      fontWeight: 700,
                      letterSpacing: "-0.04em",
                      color: "#edf4f1",
                    }}
                  >
                    {plan} plan
                  </p>

                  {plan === "PAYG" && (
                    <p
                      style={{
                        marginTop: 10,
                        marginBottom: 0,
                        fontSize: 14,
                        lineHeight: 1.7,
                        color: "rgba(219,235,248,0.76)",
                      }}
                    >
                      Available usage credits:{" "}
                      <span style={{ color: "#f3f6f4", fontWeight: 700 }}>{credits}</span>
                    </p>
                  )}

                  {plan === "TEAM" && (
                    <p
                      style={{
                        marginTop: 10,
                        marginBottom: 0,
                        fontSize: 14,
                        lineHeight: 1.7,
                        color: "rgba(219,235,248,0.76)",
                      }}
                    >
                      Included team seats:{" "}
                      <span style={{ color: "#f3f6f4", fontWeight: 700 }}>{teamSeats}</span>
                    </p>
                  )}

                  {plan === "FREE" && (
                    <p
                      style={{
                        marginTop: 10,
                        marginBottom: 0,
                        fontSize: 14,
                        lineHeight: 1.7,
                        color: "rgba(219,235,248,0.76)",
                      }}
                    >
                      Upgrade when you need more reporting, sharing, and verification capacity.
                    </p>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={shellCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.76)_0%,rgba(6,16,20,0.80)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.06),transparent_28%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div className="mb-2 text-[1.15rem] font-semibold tracking-[-0.03em] text-[#f0f4f1]">
                <span className="text-[#f3f6f4]">Upgrade or</span>{" "}
                <span className="text-[#d8dfdc]">Switch Plan</span>
              </div>

              <p
                style={{
                  margin: "0 0 18px",
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: "rgba(219,235,248,0.72)",
                }}
              >
                Choose the billing path that matches how often you capture and verify evidence.
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
        </div>
      </div>
    </div>
  );
}