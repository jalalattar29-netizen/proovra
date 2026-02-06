"use client";

import Link from "next/link";
import { useLocale } from "./providers";
import { Button, TopBar } from "../components/ui";

export default function HomePage() {
  const { t, locale, setLocale } = useLocale();
  const appBase = process.env.NEXT_PUBLIC_APP_BASE ?? "";
  const appHome = appBase ? `${appBase}/home` : "/home";
  const appLogin = appBase ? `${appBase}/login` : "/login";
  const appRegister = appBase ? `${appBase}/register` : "/register";

  return (
    <div className="page landing-page">
      <div className="landing-hero-wrap">
        <div className="landing-nav container">
          <TopBar
            title={t("brand")}
            logoSrc="/brand/logo-white.svg"
            right={
              <div className="nav-links">
                <Link href="#features">{t("navFeatures")}</Link>
                <Link href="/verify/demo">{t("navVerify")}</Link>
                <Link href="#about">{t("navAbout")}</Link>
                <a href={appHome}>{t("navDashboard")}</a>
                <a href={appLogin}>{t("login")}</a>
                <a href={appRegister}>{t("register")}</a>
                {locale !== "en" && (
                  <button type="button" className="lang-button" onClick={() => setLocale("en")}>
                    EN
                  </button>
                )}
              </div>
            }
          />
        </div>
        <section className="landing-hero container">
          <div>
            <h1 className="hero-title">{t("headline")}</h1>
            <p className="hero-subtitle">{t("bullets")}</p>
            <a href={appHome}>
              <Button>{t("ctaStart")}</Button>
            </a>
            <div className="hero-bullets">
              <span>Photos</span>
              <span>Videos</span>
              <span>Documents</span>
              <span>Signed</span>
              <span>Verified</span>
              <span>Trusted</span>
            </div>
          </div>
          <div className="hero-card">
            <div className="hero-card-title">Evidence Timeline</div>
            <div className="hero-card-list">
              <div className="hero-card-row">
                <span className="hero-dot success" />
                <div>
                  <div className="hero-card-row-title">Capture completed</div>
                  <div className="hero-card-row-sub">2 minutes ago</div>
                </div>
                <span className="hero-pill">SIGNED</span>
              </div>
              <div className="hero-card-row">
                <span className="hero-dot info" />
                <div>
                  <div className="hero-card-row-title">Report generated</div>
                  <div className="hero-card-row-sub">1 minute ago</div>
                </div>
                <span className="hero-pill">READY</span>
              </div>
              <div className="hero-card-row">
                <span className="hero-dot neutral" />
                <div>
                  <div className="hero-card-row-title">Share link created</div>
                  <div className="hero-card-row-sub">Just now</div>
                </div>
                <span className="hero-pill">ACTIVE</span>
              </div>
            </div>
            <div className="hero-card-actions">
              <button className="btn primary" type="button">
                View Evidence
              </button>
              <button className="btn secondary" type="button">
                Download Report
              </button>
            </div>
          </div>
        </section>
      </div>
      <section className="landing-strip container">
        <div className="landing-strip-item">
          <span className="landing-strip-icon" />
          <div>
            <div className="landing-strip-title">Capture</div>
            <div className="landing-strip-sub">Photos & videos</div>
          </div>
        </div>
        <div className="landing-strip-item">
          <span className="landing-strip-icon" />
          <div>
            <div className="landing-strip-title">Sign</div>
            <div className="landing-strip-sub">Cryptographic proofs</div>
          </div>
        </div>
        <div className="landing-strip-item">
          <span className="landing-strip-icon" />
          <div>
            <div className="landing-strip-title">Share</div>
            <div className="landing-strip-sub">Instant verification</div>
          </div>
        </div>
      </section>
      <section id="features" className="section container">
        <div className="grid-2">
          <div>
            <h2>Built for proof</h2>
            <p className="page-subtitle">
              Capture, sign, and verify evidence with a clear chain of custody.
            </p>
          </div>
          <div className="card">
            <ul style={{ margin: 0, paddingLeft: 18, color: "#475569", lineHeight: 1.7 }}>
              <li>Cryptographic signing</li>
              <li>Timestamped reports</li>
              <li>Shareable verification links</li>
            </ul>
          </div>
        </div>
      </section>
      <section id="about" className="section container">
        <h2>About Proovra</h2>
        <p className="page-subtitle" style={{ maxWidth: 720 }}>
          Proovra helps teams capture trusted evidence and generate verifiable reports for
          investigations, compliance, and dispute resolution.
        </p>
      </section>
      <footer className="landing-footer container">
        <div className="footer-left">
          <div className="footer-brand">Proovra</div>
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
