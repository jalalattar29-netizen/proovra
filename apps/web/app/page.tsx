"use client";

import Link from "next/link";
import { useLocale } from "./providers";
import { Button } from "../components/ui";
import { SilverWatermarkSection } from "../components/SilverWatermarkSection";

export default function HomePage() {
  const { t, locale, setLocale } = useLocale();

  const webBase =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? window.location.origin
      : process.env.NEXT_PUBLIC_WEB_BASE ?? "";

  const appHome = webBase ? `${webBase}/home` : "/home";
  const appLogin = webBase ? `${webBase}/login` : "/login";
  const appRegister = webBase ? `${webBase}/register` : "/register";

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <div className="landing-nav-bar">
          <div className="container">
            <div className="nav">
              <div className="nav-left">
                <Link href="/" className="logo">
                  <img src="/brand/logo-white.svg" alt="PROO✓RA" />
                  <span>{t("brand")}</span>
                </Link>
              </div>

              <div className="nav-links">
                <Link href="#features">{t("navFeatures")}</Link>
                <Link href="/about">About</Link>
                <Link href="/pricing">Pricing</Link>
                <Link href="/verify">{t("navVerify")}</Link>
                <a className="pill" href={appHome}>
                  {t("navDashboard")}
                </a>
                <a href={appLogin}>{t("login")}</a>
                <a href={appRegister}>{t("register")}</a>

                {locale !== "en" && (
                  <button type="button" className="lang-button" onClick={() => setLocale("en")}>
                    EN
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <section className="landing-hero container">
          <div className="landing-hero-copy">
            <div style={{ color: "rgba(255,255,255,0.82)", fontSize: 13, letterSpacing: 0.3 }}>
              Capture truth. Prove it forever.
            </div>

            <h1 className="hero-title">Capture digital evidence that can stand up to scrutiny.</h1>

            <p className="hero-subtitle">
              PROO✓RA preserves the integrity of photos, videos, and documents with cryptographic
              fingerprints, transparent custody timelines, and verifiable reports — designed for legal,
              compliance, investigations, and journalism.
            </p>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a href={appHome}>
                <Button className="navy-btn">Open Dashboard</Button>
              </a>
              <Link href="/verify">
                <Button variant="secondary">Verify Evidence</Button>
              </Link>
            </div>

            <div className="hero-bullets">
              <span>Verifiable integrity — not just storage</span>
              <span>Chain-of-custody built for review</span>
              <span>Shareable verification without exposing originals</span>
            </div>
          </div>

          {/* Phone Mock */}
          <div className="phone-mock" aria-label="Phone mock evidence timeline">
            <div className="phone-notch" />

            <div className="phone-header">
              <div>
                <div className="phone-title">Evidence Timeline</div>
                <div className="phone-sub">A clean, reviewable custody trail.</div>
              </div>
              <span className="phone-pill">LIVE</span>
            </div>

            <div className="phone-list">
              <div className="phone-row">
                <span className="phone-dot success" />
                <div>
                  <div className="phone-row-title">Capture completed</div>
                  <div className="phone-row-sub">2 minutes ago</div>
                </div>
                <span className="phone-pill">SIGNED</span>
              </div>

              <div className="phone-row">
                <span className="phone-dot info" />
                <div>
                  <div className="phone-row-title">Report generated</div>
                  <div className="phone-row-sub">1 minute ago</div>
                </div>
                <span className="phone-pill">READY</span>
              </div>

              <div className="phone-row">
                <span className="phone-dot neutral" />
                <div>
                  <div className="phone-row-title">Share link created</div>
                  <div className="phone-row-sub">Just now</div>
                </div>
                <span className="phone-pill">ACTIVE</span>
              </div>
            </div>

            {/* Stacked connected buttons (NO purple) */}
            <div className="phone-actions">
              <button type="button" className="phone-action-btn phone-action-capture">
                Capture
              </button>
              <button type="button" className="phone-action-btn phone-action-report">
                Generate Report
              </button>
              <button type="button" className="phone-action-btn phone-action-share">
                Share Link
              </button>
            </div>
          </div>
        </section>
      </div>

      <SilverWatermarkSection className="section">
        <div className="landing-strip container">
          <div className="landing-strip-item">
            <span className="landing-strip-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 7l1.3-2h5.4L16 7h2a3 3 0 013 3v7a3 3 0 01-3 3H6a3 3 0 01-3-3v-7a3 3 0 013-3h2z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M12 17a4 4 0 100-8 4 4 0 000 8z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
            </span>
            <div>
              <div className="landing-strip-title">Capture</div>
              <div className="landing-strip-sub">Photos & videos</div>
            </div>
          </div>

          <div className="landing-strip-item">
            <span className="landing-strip-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2l8 4v7c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V6l8-4z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8.5 12.5l2.2 2.2L15.8 9.6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
            </span>
            <div>
              <div className="landing-strip-title">Sign</div>
              <div className="landing-strip-sub">Cryptographic proofs</div>
            </div>
          </div>

          <div className="landing-strip-item">
            <span className="landing-strip-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M15 8a3 3 0 10-2.8-4H12a3 3 0 003 3zM6 14a3 3 0 10.2 6H6a3 3 0 000-6zm12-1a3 3 0 10.2 6H18a3 3 0 000-6z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8.6 14.6l6.8-3.6M8.6 18l6.8 3.4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
            </span>
            <div>
              <div className="landing-strip-title">Share</div>
              <div className="landing-strip-sub">Instant verification</div>
            </div>
          </div>
        </div>

        <div id="features" className="section">
          <div className="container">
            <div>
              <h2>Built for proof</h2>
              <p className="page-subtitle">
                Capture, sign, and verify evidence with a clear chain of custody.
              </p>

              <div className="card" style={{ marginTop: 16, width: "100%", maxWidth: 520 }}>
                <ul style={{ margin: 0, paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
                  <li>Cryptographic signing</li>
                  <li>Timestamped reports</li>
                  <li>Shareable verification links</li>
                  <li>Audit-friendly chain-of-custody</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div id="about" className="section">
          <div className="container">
            <h2>About PROO✓RA</h2>
            <p className="page-subtitle" style={{ maxWidth: 720 }}>
              PROO✓RA helps teams capture trusted evidence and generate verifiable reports for
              investigations, compliance, and dispute resolution.
            </p>
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
