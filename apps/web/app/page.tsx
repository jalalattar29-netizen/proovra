"use client";

import Link from "next/link";
import { Button } from "../components/ui";
import { SilverWatermarkSection } from "../components/SilverWatermarkSection";
import { MarketingHeader } from "../components/header";
import { Icons } from "../components/icons";
import { LEGAL_LINKS } from "../lib/legalLinks";

function getAppBase(): string {
  if (typeof window === "undefined") return "";
  const { hostname } = window.location;

  // local dev
  if (hostname === "localhost" || hostname === "127.0.0.1") return window.location.origin;

  // prod: prefer APP_BASE for the app domain
  return process.env.NEXT_PUBLIC_APP_BASE ?? "";
}

export default function HomePage() {
  const appBase = getAppBase();
  const appRegister = appBase ? `${appBase}/register` : "/register";
  const sampleReportUrl = "/brand/sample-report.pdf";

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <MarketingHeader />

        <section className="landing-hero container" style={{ paddingTop: 48, paddingBottom: 64 }}>
          <div className="landing-hero-copy">
            <div style={{ color: "rgba(255,255,255,0.82)", fontSize: 13, letterSpacing: 0.3 }}>
              Capture truth. Prove it forever.
            </div>

            <h1 className="hero-title">
              Verifiable digital evidence for legal, compliance, and investigations.
            </h1>

            <p className="hero-subtitle">
              PROO✓RA preserves integrity with cryptographic fingerprints, custody timelines, and
              verifiable reports. Built for teams who need audit-ready proof.
            </p>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a href={appRegister}>
                <Button>Start capturing evidence</Button>
              </a>

              <a href={sampleReportUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary">View sample report</Button>
              </a>
            </div>
          </div>

          <div className="hero-mockup">
            <div className="hero-mockup-card">
              <div className="hero-mockup-title">Dashboard</div>
              <div className="hero-mockup-row">
                <span className="hero-dot success" />
                <span>Capture completed</span>
              </div>
              <div className="hero-mockup-row">
                <span className="hero-dot info" />
                <span>Report generated</span>
              </div>
              <div className="hero-mockup-row">
                <span className="hero-dot neutral" />
                <span>Share link created</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <SilverWatermarkSection className="section" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div id="how-it-works" className="container">
          <h2 style={{ marginBottom: 8 }}>How PROO✓RA works</h2>
          <p className="page-subtitle" style={{ marginBottom: 32 }}>
            Four steps from capture to verification.
          </p>

          <div className="how-it-works-grid">
            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Capture />
              </div>
              <h3>Capture</h3>
              <p>Photos, videos, and documents with metadata and timestamps.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Fingerprint />
              </div>
              <h3>Fingerprint</h3>
              <p>SHA-256 hashes and Ed25519 signatures lock integrity.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Verify />
              </div>
              <h3>Verify</h3>
              <p>Anyone can confirm authenticity without exposing originals.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Share />
              </div>
              <h3>Share</h3>
              <p>Verification links and PDF reports for audit and compliance.</p>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 72 }}>
          <h2 style={{ marginBottom: 8 }}>Who is it for?</h2>
          <p className="page-subtitle" style={{ marginBottom: 32 }}>
            Built for teams who need verifiable proof.
          </p>

          <div className="who-it-for-grid">
            <div className="who-it-for-card">
              <Icons.Lawyers />
              <h3>Lawyers</h3>
              <p>Evidence that stands up in court.</p>
            </div>
            <div className="who-it-for-card">
              <Icons.Journalists />
              <h3>Journalists</h3>
              <p>Source verification and provenance.</p>
            </div>
            <div className="who-it-for-card">
              <Icons.Compliance />
              <h3>Compliance teams</h3>
              <p>Audit-ready documentation.</p>
            </div>
            <div className="who-it-for-card">
              <Icons.Enterprises />
              <h3>Enterprises</h3>
              <p>Internal investigations and disputes.</p>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 72 }}>
          <h2 style={{ marginBottom: 8 }}>Trust indicators</h2>
          <p className="page-subtitle" style={{ marginBottom: 32 }}>
            Enterprise-grade integrity and security.
          </p>

          <div className="trust-indicators">
            <div className="trust-item">
              <Icons.Security />
              <span>Security</span>
            </div>
            <div className="trust-item">
              <Icons.Evidence />
              <span>Chain of custody</span>
            </div>
            <div className="trust-item">
              <Icons.Verify />
              <span>Audit-ready</span>
            </div>
            <div className="trust-item">
              <Icons.Fingerprint />
              <span>Tamper-proof</span>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 72, textAlign: "center" }}>
          <Link href="/pricing">
            <Button>View pricing</Button>
          </Link>
        </div>
      </SilverWatermarkSection>

      <footer className="landing-footer container">
        <div className="footer-left">
          <div className="footer-brand">PROO✓RA</div>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
        </div>

        <div className="footer-links">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
          <Link href="/support">Support</Link>
        </div>
      </footer>
    </div>
  );
}