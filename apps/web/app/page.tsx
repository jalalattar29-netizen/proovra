"use client";

import Link from "next/link";
import { useLocale } from "./providers";
import { Button } from "../components/ui";

export default function HomePage() {
  const { t, locale, setLocale } = useLocale();

  const appBase =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_BASE ?? "";

  const appHome = appBase ? `${appBase}/home` : "/home";
  const appLogin = appBase ? `${appBase}/login` : "/login";
  const appRegister = appBase ? `${appBase}/register` : "/register";

  return (
    <div className="page landing-page">
      {/* BLUE HERO SHELL (with paper overlay via globals.css) */}
      <div className="blue-shell">
        {/* FULL WIDTH NAV BAR */}
        <div className="landing-nav-bar">
          <div className="container">
            <div className="nav">
              <div className="nav-left">
                <Link href="/" className="logo">
                  <img src="/brand/logo-white.svg" alt="Proovra" />
                  <span>{t("brand")}</span>
                </Link>
              </div>

              <div className="nav-links">
                <Link href="#features">{t("navFeatures")}</Link>
                <Link href="/verify/demo">{t("navVerify")}</Link>
                <Link href="#about">{t("navAbout")}</Link>
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

        {/* HERO */}
        <section className="landing-hero container">
          <div className="landing-hero-copy">
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

          {/* RIGHT CARD */}
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

      {/* ICON STRIP */}
      <section className="landing-strip container">
        <div className="landing-strip-item">
          <span className="landing-strip-icon" aria-hidden="true">
            {/* camera */}
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
            {/* shield */}
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
            {/* share */}
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
