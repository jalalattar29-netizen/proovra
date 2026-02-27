// D:\digital-witness\apps\web\app\(app)\billing\page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, Skeleton } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { PlanType } from "../../pricing/types";

type PayPalLink = { rel: string; href: string };

export default function BillingPage() {
  const { addToast } = useToast();

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
  }, []);

  const startStripeCheckout = async (planType: PlanType) => {
    setCheckoutBusy(planType);
    addToast("Starting Stripe checkout...", "info");

    try {
      const data = await apiFetch("/v1/billing/checkout/stripe", {
        method: "POST",
        body: JSON.stringify({ plan: planType, currency: "USD" }),
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
        body: JSON.stringify({ plan: planType, currency: "USD" }),
      });

      const approve = (data.order?.links as PayPalLink[] | undefined)?.find((l) => l.rel === "approve");
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

  return (
    <div className="section app-section">
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

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 24 }}>
          <Card className="app-card">
            <div className="app-card-title">Current plan</div>

            {loading ? (
              <div style={{ display: "grid", gap: 8 }}>
                <Skeleton width="100%" height="20px" />
                <Skeleton width="60%" height="16px" />
              </div>
            ) : error ? (
              <div className="app-inline-error">{error}</div>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{plan} plan</p>
                {plan === "PAYG" && <p className="app-muted" style={{ marginTop: 8 }}>Credits: {credits}</p>}
                {plan === "TEAM" && <p className="app-muted" style={{ marginTop: 8 }}>Team seats: {teamSeats}</p>}
                {plan === "FREE" && <p className="app-muted" style={{ marginTop: 8 }}>Upgrade to unlock more features</p>}
              </>
            )}
          </Card>

          <Card className="app-card">
            <div className="app-card-title">Upgrade or switch plan</div>

            {loading ? (
              <div style={{ display: "grid", gap: 8 }}>
                <Skeleton width="100%" height="40px" />
                <Skeleton width="100%" height="40px" />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button
                  className="navy-btn"
                  variant="secondary"
                  disabled={!!checkoutBusy || plan === "PAYG"}
                  onClick={() => startStripeCheckout("PAYG")}
                >
                  {checkoutBusy === "PAYG" ? "Processing..." : "Pay-Per-Evidence"}
                </Button>

                <Button
                  className="navy-btn"
                  variant="secondary"
                  disabled={!!checkoutBusy || plan === "PRO"}
                  onClick={() => startStripeCheckout("PRO")}
                >
                  {checkoutBusy === "PRO" ? "Processing..." : "Upgrade to Pro"}
                </Button>

                <Button
                  className="navy-btn"
                  variant="secondary"
                  disabled={!!checkoutBusy || plan === "TEAM"}
                  onClick={() => startStripeCheckout("TEAM")}
                >
                  {checkoutBusy === "TEAM" ? "Processing..." : "Upgrade to Team"}
                </Button>

                <Button
                  className="navy-btn"
                  variant="secondary"
                  disabled={!!checkoutBusy}
                  onClick={() => startPayPalCheckout("PAYG")}
                >
                  {checkoutBusy === "PAYG" ? "Processing..." : "PayPal"}
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}