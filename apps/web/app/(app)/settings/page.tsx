"use client";

import { Button, Card } from "../../../components/ui";
import { useLocale } from "../../providers";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { PlanType } from "../../pricing/types";

type Subscription = {
  status?: string | null;
};

type PaymentItem = {
  id: string;
  provider: string;
  status: string;
  amountCents: number;
  currency: string;
};

type PayPalLink = {
  rel: string;
  href: string;
};

export default function SettingsPage() {
  const { t } = useLocale();
  const [plan, setPlan] = useState("FREE");
  const [credits, setCredits] = useState(0);
  const [teamSeats, setTeamSeats] = useState(0);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [payments, setPayments] = useState<PaymentItem[]>([]);

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data) => {
        setPlan(data.entitlement?.plan ?? "FREE");
        setCredits(data.entitlement?.credits ?? 0);
        setTeamSeats(data.entitlement?.teamSeats ?? 0);
      })
      .catch(() => setPlan("FREE"));
    apiFetch("/v1/billing/subscription")
      .then((data) => setSubscription(data.subscription ?? null))
      .catch(() => setSubscription(null));
    apiFetch("/v1/billing/payments")
      .then((data) => setPayments(data.items ?? []))
      .catch(() => setPayments([]));
  }, []);

  const startCheckout = async (planType: PlanType) => {
    const data = await apiFetch("/v1/billing/checkout/stripe", {
      method: "POST",
      body: JSON.stringify({ plan: planType, currency: "USD" })
    });
    const url = data.session?.url as string | undefined;
    if (url) window.location.href = url;
  };

  const startPayPal = async (planType: PlanType) => {
    const data = await apiFetch("/v1/billing/checkout/paypal", {
      method: "POST",
      body: JSON.stringify({ plan: planType, currency: "USD" })
    });
    const approve = (data.order?.links as PayPalLink[] | undefined)?.find(
      (link) => link.rel === "approve"
    );
    if (approve?.href) window.location.href = approve.href;
  };
  return (
    <div className="section app-section">
      <div className="app-hero app-hero-contained">
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ margin: 0 }}>{t("settings")}</h1>
            <p className="page-subtitle">Manage your plan, language, and sign-in.</p>
          </div>
        </div>
      </div>
      <div className="app-body" style={{ display: "grid", gap: 16 }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("language")}</div>
          <div style={{ color: "#64748b" }}>English only</div>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Subscription</div>
          <p style={{ margin: 0 }}>{plan} plan</p>
          {plan === "PAYG" && <p style={{ marginTop: 6 }}>Credits: {credits}</p>}
          {plan === "TEAM" && <p style={{ marginTop: 6 }}>Team seats: {teamSeats}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <Link href="/pricing">
              <Button className="navy-btn">View Pricing</Button>
            </Link>
            <Button className="navy-btn" variant="secondary" onClick={() => startCheckout("PAYG")}>
              Buy Pay‑Per‑Evidence
            </Button>
            <Button className="navy-btn" variant="secondary" onClick={() => startCheckout("PRO")}>
              Upgrade to Pro
            </Button>
            <Button className="navy-btn" variant="secondary" onClick={() => startCheckout("TEAM")}>
              Upgrade to Team
            </Button>
            <Button className="navy-btn" variant="secondary" onClick={() => startPayPal("PAYG")}>
              PayPal PAYG
            </Button>
            <Button
              className="navy-btn"
              variant="secondary"
              onClick={() => apiFetch("/v1/billing/restore", { method: "POST" })}
            >
              Restore Purchases
            </Button>
            {subscription?.status === "ACTIVE" && (
              <Button
                className="navy-btn"
                variant="secondary"
                onClick={() => apiFetch("/v1/billing/subscription/cancel", { method: "POST" })}
              >
                Cancel Subscription
              </Button>
            )}
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Payments</div>
          {payments.length === 0 ? (
            <div>No payments yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {payments.map((item) => (
                <div key={item.id} style={{ fontSize: 12 }}>
                  {item.provider} · {item.status} · {(item.amountCents / 100).toFixed(2)}{" "}
                  {item.currency}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Sign in</div>
          <div style={{ display: "grid", gap: 8 }}>
            <Link href="/login">
              <Button>Manage sign‑in</Button>
            </Link>
            <Button variant="secondary" onClick={() => apiFetch("/v1/auth/logout", { method: "POST" })}>
              Logout
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
