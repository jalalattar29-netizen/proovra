"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, useToast } from "../../components/ui";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { MarketingHeader } from "../../components/header";
import { useAuth } from "../providers";

function getAppBase() {
  if (typeof window === "undefined") return "";
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_BASE ?? process.env.NEXT_PUBLIC_WEB_BASE ?? "";
}

export default function MarketingPricingPage() {
  const { addToast } = useToast();
  const { hasSession } = useAuth();
  const [hoveredPlan, setHoveredPlan] = useState<string | null>(null);
  const appBase = getAppBase();
  const appBilling = appBase ? `${appBase}/billing` : "/billing";
  const appRegister = appBase ? `${appBase}/register` : "/register";

  const handlePlanSelect = (plan: string) => {
    if (hasSession) {
      addToast(`Redirecting to billing for ${plan} plan...`, "info");
    } else {
      addToast(`Creating account to select ${plan} plan...`, "info");
    }
  };

  return (
    <div className="page landing-page pricing-page">
      <div className="blue-shell">
        <MarketingHeader />
        <section className="section container hero-section-tight pricing-hero-section">
          <h1 className="hero-title pricing-hero-title">Pricing designed for real-world scrutiny.</h1>
          <p className="page-subtitle pricing-subtitle" style={{ maxWidth: 720 }}>
            PROO✓RA is built for situations where authenticity matters. Choose a plan based on how often you need
            verifiable reports and structured custody — not on storage limits.
          </p>
        </section>
      </div>

      <SilverWatermarkSection className="section section-body pricing-section" style={{ paddingTop: 48 }}>
        <div className="container">
          <div className="pricing-grid">
            {/* FREE */}
            <div
              className={`pricing-plan ${hoveredPlan === "FREE" ? "is-hovered" : ""}`}
              onMouseEnter={() => setHoveredPlan("FREE")}
              onMouseLeave={() => setHoveredPlan(null)}
            >
              <Card className="pricing-card">
                <div className="pricing-card-head">
                  <h3>FREE</h3>
                  <p className="pricing-price">$0</p>
                </div>

                <ul className="pricing-list">
                  <li>3 evidence limit</li>
                  <li>Cryptographic fingerprint and integrity record</li>
                  <li>Basic verification view</li>
                  <li>PDF reports not included</li>
                </ul>

                <div className="pricing-cta">
                  <a href={hasSession ? appBilling : appRegister} onClick={() => handlePlanSelect("FREE")}>
                    <Button variant="secondary" className="choose-btn">
                      {hasSession ? "Go to Billing" : "Sign up"} ›
                    </Button>
                  </a>
                </div>
              </Card>
            </div>

            {/* PAYG */}
            <div
              className={`pricing-plan is-featured ${hoveredPlan === "PAYG" ? "is-hovered" : ""}`}
              onMouseEnter={() => setHoveredPlan("PAYG")}
              onMouseLeave={() => setHoveredPlan(null)}
            >
              <Card className="pricing-card">
                <div className="pricing-card-head">
                  <h3>PAY-PER-EVIDENCE</h3>
                  <p className="pricing-price">$5 / evidence</p>
                </div>

                <ul className="pricing-list">
                  <li>Everything in Free</li>
                  <li>Verifiable PDF report per purchase</li>
                  <li>Shareable verification link</li>
                  <li>Audit-ready integrity fields</li>
                </ul>

                <div className="pricing-cta">
                  <a
                    href={hasSession ? appBilling : appRegister}
                    onClick={() => handlePlanSelect("PAY-PER-EVIDENCE")}
                  >
                    <Button className="choose-btn">{hasSession ? "Go to Billing" : "Sign up"} ›</Button>
                  </a>
                </div>
              </Card>
            </div>

            {/* PRO */}
            <div
              className={`pricing-plan ${hoveredPlan === "PRO" ? "is-hovered" : ""}`}
              onMouseEnter={() => setHoveredPlan("PRO")}
              onMouseLeave={() => setHoveredPlan(null)}
            >
              <Card className="pricing-card">
                <div className="pricing-card-head">
                  <h3>PRO</h3>
                  <p className="pricing-price">$19 / month</p>
                </div>

                <ul className="pricing-list">
                  <li>Unlimited evidence capture</li>
                  <li>PDF reports included</li>
                  <li>Faster workflows for frequent verification</li>
                  <li>Designed for individual professionals</li>
                </ul>

                <div className="pricing-cta">
                  <a href={hasSession ? appBilling : appRegister} onClick={() => handlePlanSelect("PRO")}>
                    <Button variant="secondary" className="choose-btn">
                      {hasSession ? "Go to Billing" : "Sign up"} ›
                    </Button>
                  </a>
                </div>
              </Card>
            </div>

            {/* TEAM */}
            <div
              className={`pricing-plan ${hoveredPlan === "TEAM" ? "is-hovered" : ""}`}
              onMouseEnter={() => setHoveredPlan("TEAM")}
              onMouseLeave={() => setHoveredPlan(null)}
            >
              <Card className="pricing-card">
                <div className="pricing-card-head">
                  <h3>TEAM (5 seats)</h3>
                  <p className="pricing-price">$79 / month</p>
                </div>

                <ul className="pricing-list">
                  <li>5 team members included</li>
                  <li>Shared ownership and access control</li>
                  <li>Team-ready evidence organization</li>
                  <li>PDF reports included</li>
                </ul>

                <div className="pricing-cta">
                  <a href={hasSession ? appBilling : appRegister} onClick={() => handlePlanSelect("TEAM")}>
                    <Button variant="secondary" className="choose-btn">
                      {hasSession ? "Go to Billing" : "Sign up"} ›
                    </Button>
                  </a>
                </div>
              </Card>
            </div>
          </div>

          <div className="pricing-disclaimer">
            PROO✓RA is a technical integrity platform. It does not provide legal advice.
          </div>
        </div>
      </SilverWatermarkSection>

      <footer className="landing-footer container">
        <div className="footer-left">
          <div className="footer-brand">PROO✓RA</div>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
        </div>
        <div className="footer-links">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/legal/cookies">Cookies</Link>
          <Link href="/legal/security">Security</Link>
          <Link href="/support">Support</Link>
        </div>
      </footer>
    </div>
  );
}