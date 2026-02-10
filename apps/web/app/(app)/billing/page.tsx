"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { PlanType } from "../../pricing/types";

type PayPalLink = { rel: string; href: string };

export default function BillingPage() {
  const [plan, setPlan] = useState("FREE");
  const [credits, setCredits] = useState(0);
  const [teamSeats, setTeamSeats] = useState(0);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data) => {
        setPlan(data.entitlement?.plan ?? "FREE");
        setCredits(data.entitlement?.credits ?? 0);
        setTeamSeats(data.entitlement?.teamSeats ?? 0);
      })
      .catch(() => setPlan("FREE"));
  }, []);

  const startStripeCheckout = async (planType: PlanType) => {
    setCheckoutBusy(planType);
    try {
      const data = await apiFetch("/v1/billing/checkout/stripe", {
        method: "POST",
        body: JSON.stringify({ plan: planType, currency: "USD" })
      });
      const url = data.session?.url as string | undefined;
      if (url) window.location.href = url;
    } finally {
      setCheckoutBusy(null);
    }
  };

  const startPayPalCheckout = async (planType: PlanType) => {
    setCheckoutBusy(planType);
    try {
      const data = await apiFetch("/v1/billing/checkout/paypal", {
        method: "POST",
        body: JSON.stringify({ plan: planType, currency: "USD" })
      });
      const approve = (data.order?.links as PayPalLink[] | undefined)?.find((l) => l.rel === "approve");
      if (approve?.href) window.location.href = approve.href;
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
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Current plan</div>
            <p style={{ margin: 0 }}>{plan} plan</p>
            {plan === "PAYG" && <p style={{ marginTop: 6 }}>Credits: {credits}</p>}
            {plan === "TEAM" && <p style={{ marginTop: 6 }}>Team seats: {teamSeats}</p>}
          </Card>

          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Upgrade</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button
                className="navy-btn"
                variant="secondary"
                disabled={!!checkoutBusy}
                onClick={() => startStripeCheckout("PAYG")}
              >
                {checkoutBusy === "PAYG" ? "..." : "Buy Pay‑Per‑Evidence"}
              </Button>
              <Button
                className="navy-btn"
                variant="secondary"
                disabled={!!checkoutBusy}
                onClick={() => startStripeCheckout("PRO")}
              >
                {checkoutBusy === "PRO" ? "..." : "Upgrade to Pro"}
              </Button>
              <Button
                className="navy-btn"
                variant="secondary"
                disabled={!!checkoutBusy}
                onClick={() => startStripeCheckout("TEAM")}
              >
                {checkoutBusy === "TEAM" ? "..." : "Upgrade to Team"}
              </Button>
              <Button
                className="navy-btn"
                variant="secondary"
                disabled={!!checkoutBusy}
                onClick={() => startPayPalCheckout("PAYG")}
              >
                PayPal PAYG
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
