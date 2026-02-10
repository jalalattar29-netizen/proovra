"use client";

import Link from "next/link";
import { Button, Card } from "../../../components/ui";
import { useLocale } from "../../providers";

export default function AppPricingPage() {
  const { t } = useLocale();
  const webBase =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? window.location.origin
      : process.env.NEXT_PUBLIC_WEB_BASE ?? "";
  const appLogin = webBase ? `${webBase}/login` : "/login";
  const appRegister = webBase ? `${webBase}/register` : "/register";

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Pricing designed for real-world scrutiny.
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                PROO✓RA is built for situations where authenticity matters. Choose a plan based on
                how often you need verifiable reports and structured custody — not on storage limits.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 24 }}>
          <div
            className="pricing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16
            }}
          >
            <Card className="pricing-card">
              <h3>FREE</h3>
              <p>$0</p>
              <ul style={{ margin: "12px 0 16px", paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
                <li>Capture photos, videos, and documents</li>
                <li>Cryptographic fingerprint and integrity record</li>
                <li>Basic verification view</li>
                <li>Ownership and organization basics</li>
                <li>PDF reports not included</li>
              </ul>
              <div className="pricing-cta">
                <a href={appRegister}>
                  <Button variant="secondary" className="choose-btn">
                    Choose Free <span className="choose-icon">›</span>
                  </Button>
                </a>
              </div>
            </Card>
            <Card className="pricing-card">
              <h3>PAY-PER-EVIDENCE</h3>
              <p>$5 / evidence</p>
              <ul style={{ margin: "12px 0 16px", paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
                <li>Everything in Free</li>
                <li>Verifiable PDF report for the purchased evidence</li>
                <li>Shareable verification link</li>
                <li>Audit-ready integrity fields (hashes, signatures)</li>
                <li>Ideal for occasional high-stakes captures</li>
              </ul>
              <div className="pricing-cta">
                <a href={appLogin}>
                  <Button variant="secondary" className="choose-btn">
                    Choose Pay-per-evidence <span className="choose-icon">›</span>
                  </Button>
                </a>
              </div>
            </Card>
            <Card className="pricing-card">
              <h3>PRO</h3>
              <p>$19 / month</p>
              <ul style={{ margin: "12px 0 16px", paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
                <li>Unlimited evidence capture</li>
                <li>PDF reports included</li>
                <li>Faster workflows for frequent verification needs</li>
                <li>Designed for individual professionals</li>
                <li>Priority reliability features as they ship</li>
              </ul>
              <div className="pricing-cta">
                <a href={appLogin}>
                  <Button variant="secondary" className="choose-btn">
                    Choose Pro <span className="choose-icon">›</span>
                  </Button>
                </a>
              </div>
            </Card>
            <Card className="pricing-card">
              <h3>TEAM (5 seats)</h3>
              <p>$79 / month</p>
              <ul style={{ margin: "12px 0 16px", paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
                <li>5 team members included</li>
                <li>Shared ownership and structured access control</li>
                <li>Team-ready evidence organization</li>
                <li>PDF reports included</li>
                <li>Built for organizations and high-responsibility workflows</li>
              </ul>
              <div className="pricing-cta">
                <a href={appLogin}>
                  <Button variant="secondary" className="choose-btn">
                    Choose Team <span className="choose-icon">›</span>
                  </Button>
                </a>
              </div>
            </Card>
          </div>

          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
            PROO✓RA is a technical integrity platform. It does not provide legal advice and does
            not guarantee admissibility of evidence in any jurisdiction.
          </div>

          <div>
            <h3 style={{ marginBottom: 8 }}>FAQ</h3>
            <div style={{ display: "grid", gap: 12 }}>
              <Card>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  Q: Does verification require sharing the original file?
                </div>
                <div style={{ color: "#475569", lineHeight: 1.7 }}>
                  A: No. Verification can confirm integrity using fingerprints and signed records
                  without publicly exposing the original content.
                </div>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Q: Is a PROO✓RA report "legal proof"?</div>
                <div style={{ color: "#475569", lineHeight: 1.7 }}>
                  A: PROO✓RA provides technical integrity data and a custody timeline. Legal
                  admissibility and interpretation depend on jurisdiction and qualified professionals.
                </div>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Q: Can I start free and upgrade later?</div>
                <div style={{ color: "#475569", lineHeight: 1.7 }}>
                  A: Yes. You can capture and verify on Free, then upgrade when you need reports and
                  higher-volume workflows.
                </div>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  Q: What's the difference between Pay-per-evidence and Pro?
                </div>
                <div style={{ color: "#475569", lineHeight: 1.7 }}>
                  A: Pay-per-evidence is for occasional reports. Pro is for consistent usage with
                  reports included.
                </div>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Q: Do teams have to use cases?</div>
                <div style={{ color: "#475569", lineHeight: 1.7 }}>
                  A: No. Cases are optional. You can organize evidence in the way that fits your
                  workflow.
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
