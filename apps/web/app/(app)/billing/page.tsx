"use client";

import { useEffect, useMemo, useState } from "react";
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 18px 36px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.45)",
      }) as const,
    []
  );

const primaryVelvetButtonStyle = useMemo(
  () =>
    ({
      borderColor: "rgba(79,112,107,0.14)",
      color: "#1e3237",
      background:
        "linear-gradient(180deg, rgba(255,255,255,0.82) 0%, rgba(242,245,242,0.96) 100%)",
      boxShadow:
        "0 10px 22px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.72)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      textShadow: "0 1px 0 rgba(255,255,255,0.35)",
    }) as const,
  []
);

const secondaryVelvetButtonStyle = useMemo(
  () =>
    ({
      borderColor: "rgba(183,157,132,0.18)",
      color: "#5f4c3d",
      background:
        "linear-gradient(180deg, rgba(250,249,246,0.74) 0%, rgba(239,236,232,0.92) 100%)",
      boxShadow:
        "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.62)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      textShadow: "0 1px 0 rgba(255,255,255,0.28)",
    }) as const,
  []
);

  const innerVelvetCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const renderCurrentPlanMeta = () => {
    if (plan === "PAYG") {
      return (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 14,
            lineHeight: 1.72,
            color: "#5d6d71",
          }}
        >
          Available usage credits:{" "}
          <span style={{ color: "#1f3438", fontWeight: 700 }}>{credits}</span>
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
            color: "#5d6d71",
          }}
        >
          Included team seats:{" "}
          <span style={{ color: "#1f3438", fontWeight: 700 }}>{teamSeats}</span>
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
            color: "#5d6d71",
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
          color: "#5d6d71",
        }}
      >
        Your subscription is active and ready for continued evidence workflows.
      </p>
    );
  };

return (
  <div
    className="section app-section"
    style={{
      background:
        "linear-gradient(180deg, rgba(241,243,240,0.76) 0%, rgba(236,239,236,0.92) 100%)",
      position: "relative",
      overflow: "hidden",
    }}
  >
    <div className="absolute inset-0 pointer-events-none">
  <img
    src="/images/landing-network-bg.png"
    alt=""
    className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.10] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
  />
  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.06)_24%,rgba(255,255,255,0.06)_76%,rgba(255,255,255,0.14)_100%)]" />
  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0)_24%,rgba(255,255,255,0)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.12)_100%)]" />
</div>

          <style jsx global>{`
        .billing-page-shell .btn:disabled {
          opacity: 0.58 !important;
          cursor: not-allowed;
          filter: saturate(0.86);
        }
      `}</style>

<div className="app-hero app-hero-full relative z-10">
          <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.055)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#dce3e0",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Billing
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#e7ece9] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Manage your billing workspace{" "}
                <span style={{ color: "#c3ebe2" }}>with more clarity</span>.
              </h1>

              <p
                className="page-subtitle pricing-subtitle"
                style={{
                  marginTop: 20,
                  maxWidth: 720,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#c7cfcc",
                }}
              >
                Review your{" "}
                <span style={{ color: "#e6ebe8" }}>current subscription</span>,
                switch between plans when needed, and manage{" "}
                <span style={{ color: "#bfe8df" }}>credits</span>,{" "}
                <span style={{ color: "#e6ebe8" }}>team access</span>, and{" "}
                <span style={{ color: "#d6b89d" }}>payment upgrades</span> from one
                place.
              </p>
            </div>
          </div>
        </div>
      </div>

<div className="app-body app-body-full billing-page-shell relative z-10">
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
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.22)_0%,rgba(245,247,244,0.38)_45%,rgba(236,239,236,0.48)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(255,255,255,0.32),transparent_30%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div className="mb-5 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                <span style={{ color: "#21353a" }}>Current</span>{" "}
                <span style={{ color: "#9b826b" }}>Plan</span>
              </div>

              {loading ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div
                    className="rounded-[22px] p-4"
                    style={{
                      ...innerVelvetCardStyle,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    }}
                  >
                    <Skeleton width="100%" height="20px" />
                  </div>
                  <div
                    className="rounded-[22px] p-4"
                    style={{
                      ...innerVelvetCardStyle,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    }}
                  >
                    <Skeleton width="60%" height="16px" />
                  </div>
                </div>
              ) : error ? (
                <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                  {error}
                </div>
              ) : (
                <div
                  className="relative overflow-hidden rounded-[26px] px-5 py-5"
                  style={innerVelvetCardStyle}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/panel-silver.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.20)_0%,rgba(245,247,244,0.42)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(255,255,255,0.30),transparent_30%)]" />

                  <div className="relative z-10">
                    <div
                      style={{
                        margin: 0,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: "0.16em",
                        textTransform: "uppercase",
                        color: "#9b826b",
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
                        color: "#1f3438",
                      }}
                    >
                      <span style={{ color: "#1f3438" }}>{plan}</span>{" "}
                      <span style={{ color: "#3e6b68" }}>plan</span>
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
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.22)_0%,rgba(245,247,244,0.38)_45%,rgba(236,239,236,0.48)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(255,255,255,0.32),transparent_30%)]" />

            <div className="relative z-10 p-6 md:p-7">
              <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                <span style={{ color: "#21353a" }}>Upgrade or</span>{" "}
                <span style={{ color: "#9b826b" }}>Switch Plan</span>
              </div>

              <p
                style={{
                  margin: "0 0 18px",
                  fontSize: 14,
                  lineHeight: 1.75,
                  color: "#5d6d71",
                  maxWidth: 700,
                }}
              >
                Choose the billing path that matches how often you capture and verify
                evidence.
              </p>

              {loading ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div
                    className="rounded-[22px] p-4"
                    style={{
                      ...innerVelvetCardStyle,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    }}
                  >
                    <Skeleton width="100%" height="40px" />
                  </div>
                  <div
                    className="rounded-[22px] p-4"
                    style={{
                      ...innerVelvetCardStyle,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                    }}
                  >
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