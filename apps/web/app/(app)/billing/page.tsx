"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, EmptyState, Skeleton } from "../../../components/ui";
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
        body: JSON.stringify({ plan: planType, currency: "USD" })
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
        body: JSON.stringify({ plan: planType, currency: "USD" })
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
          <div className="page-title" style={{ marginBottom: 0 }}>
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
          {loading ? (
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Current plan</div>
              <div style={{ display: "grid", gap: 8 }}>
                <Skeleton width="100%" height={20} />
                <Skeleton width="60%" height={16} />
              </div>
            </Card>
          ) : error ? (
            <Card>
              <div style={{
                padding: 16,
                background: "#FEE2E2",
                borderRadius: 8,
                color: "#991B1B",
                fontSize: 12
              }}>
                {error}
              </div>
            </Card>
          ) : (
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Current plan</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>{plan} plan</p>
              {plan === "PAYG" && <p style={{ marginTop: 6, fontSize: 14, color: "#666" }}>Credits: {credits}</p>}
              {plan === "TEAM" && <p style={{ marginTop: 6, fontSize: 14, color: "#666" }}>Team seats: {teamSeats}</p>}
              {plan === "FREE" && <p style={{ marginTop: 6, fontSize: 14, color: "#666" }}>Upgrade to unlock more features</p>}
            </Card>
          )}

          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Upgrade or switch plan</div>
            {loading ? (
              <div style={{ display: "grid", gap: 8 }}>
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button
                  className="navy-btn"
                  variant="secondary"
                  disabled={!!checkoutBusy || plan === "PAYG"}
                  onClick={() => startStripeCheckout("PAYG")}
                >
                  {checkoutBusy === "PAYG" ? "Processing..." : "Pay‑Per‑Evidence"}
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
