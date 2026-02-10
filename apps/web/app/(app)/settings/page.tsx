"use client";

import { Button, Card } from "../../../components/ui";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { PlanType } from "../../pricing/types";

type Subscription = {
  status?: string | null;
};

type PayPalLink = {
  rel: string;
  href: string;
};

export default function SettingsPage() {
  const { t } = useLocale();
  const { user, setToken } = useAuth();
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");
  const [credits, setCredits] = useState(0);
  const [teamSeats, setTeamSeats] = useState(0);
  const [subscription, setSubscription] = useState<Subscription | null>(null);

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
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {t("settings")}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Profile, plan, language, and security.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Profile</div>
          <div style={{ display: "grid", gap: 6 }}>
            {user?.email && (
              <div style={{ fontSize: 14, color: "#475569" }}>
                <span style={{ color: "#64748b" }}>Email:</span> {user.email}
              </div>
            )}
            {user?.displayName && (
              <div style={{ fontSize: 14, color: "#475569" }}>
                <span style={{ color: "#64748b" }}>Name:</span> {user.displayName}
              </div>
            )}
            {user?.provider && (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>
                Auth provider: {user.provider}
              </div>
            )}
            {!user?.email && !user?.displayName && (
              <div style={{ color: "#64748b", fontSize: 14 }}>Guest or minimal profile</div>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await apiFetch("/v1/auth/logout", { method: "POST" });
                } catch {
                  // ignore
                } finally {
                  setToken(null);
                  router.replace("/");
                }
              }}
            >
              Sign out
            </Button>
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Plan</div>
          <p style={{ margin: 0 }}>{plan} plan</p>
          {plan === "PAYG" && <p style={{ marginTop: 6 }}>Credits: {credits}</p>}
          {plan === "TEAM" && <p style={{ marginTop: 6 }}>Team seats: {teamSeats}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <Link href="/pricing">
              <Button className="navy-btn">View full pricing</Button>
            </Link>
            <Link href="/billing">
              <Button className="navy-btn" variant="secondary">Go to Billing</Button>
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
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("language")}</div>
          <p style={{ margin: 0 }}>English</p>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Security</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Link href="/legal/security" style={{ color: "#0369a1", textDecoration: "underline" }}>
              Security policy
            </Link>
            <a href="mailto:security@proovra.com" style={{ color: "#0369a1", textDecoration: "underline" }}>
              security@proovra.com
            </a>
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}
