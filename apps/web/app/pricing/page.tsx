"use client";

import Link from "next/link";
import { Button, Card, TopBar } from "../../components/ui";
import { useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import { PlanType } from "./types";

function resolveCurrency() {
  const lang = navigator.language?.toLowerCase() ?? "en";
  if (lang.startsWith("de")) return "EUR";
  if (lang.startsWith("en-gb")) return "GBP";
  return "USD";
}

async function startCheckout(plan: PlanType) {
  const data = await apiFetch("/v1/billing/checkout/stripe", {
    method: "POST",
    body: JSON.stringify({ plan, currency: resolveCurrency() })
  });
  const url = data.session?.url as string | undefined;
  if (url) {
    window.location.href = url;
  }
}

async function startPayPal(plan: PlanType) {
  const data = await apiFetch("/v1/billing/checkout/paypal", {
    method: "POST",
    body: JSON.stringify({ plan, currency: resolveCurrency() })
  });
  const approve = data.order?.links?.find((link: { rel: string }) => link.rel === "approve");
  if (approve?.href) {
    window.location.href = approve.href;
  }
}

export default function PricingPage() {
  const { t } = useLocale();
  const appBase = process.env.NEXT_PUBLIC_APP_BASE ?? "";
  const appLogin = appBase ? `${appBase}/login` : "/login";
  const appRegister = appBase ? `${appBase}/register` : "/register";
  return (
    <div className="page">
      <div className="container">
        <TopBar
          title={t("brand")}
          right={
            <div className="nav-links">
              <Link href="/">{t("home")}</Link>
              <a href={appLogin}>{t("login")}</a>
              <a href={appRegister}>{t("register")}</a>
            </div>
          }
        />
      </div>
      <div className="section container">
        <h2 style={{ marginTop: 0 }}>Pricing</h2>
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}
        >
        <Card>
          <h3>Free</h3>
          <p>Limited evidence per month</p>
          <Button>{t("ctaCapture")}</Button>
        </Card>
        <Card>
          <h3>Pay-per-evidence</h3>
          <p>Buy credits as needed</p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => startCheckout("PAYG")}>Stripe</Button>
            <Button variant="secondary" onClick={() => startPayPal("PAYG")}>
              PayPal
            </Button>
          </div>
        </Card>
        <Card>
          <h3>Pro</h3>
          <p>Unlimited evidence, priority signing</p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => startCheckout("PRO")}>Stripe</Button>
            <Button variant="secondary" onClick={() => startPayPal("PRO")}>
              PayPal
            </Button>
          </div>
        </Card>
        <Card>
          <h3>Team</h3>
          <p>5 seats with team management</p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => startCheckout("TEAM")}>Stripe</Button>
            <Button variant="secondary" onClick={() => startPayPal("TEAM")}>
              PayPal
            </Button>
          </div>
        </Card>
      </div>
    </div>
    </div>
  );
}
