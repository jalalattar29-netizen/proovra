"use client";

import Link from "next/link";
import { Button } from "../components/ui";
import { SilverWatermarkSection } from "../components/SilverWatermarkSection";
import { MarketingHeader } from "../components/header";
import { Icons } from "../components/icons";
import { Footer } from "../components/Footer";

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

        <section className="landing-hero container" style={{ paddingTop: 48, paddingBottom: 52 }}>
          {/* LEFT: COPY */}
          <div className="landing-hero-copy">
            <div style={{ color: "rgba(255,255,255,0.82)", fontSize: 13, letterSpacing: 0.3 }}>
              Capture truth. Prove it forever.
            </div>

            <h1 className="hero-title">Verifiable digital evidence for legal, compliance, and investigations.</h1>

            <p className="hero-subtitle">
              PROO✓RA lets you capture photos, videos, and documents with cryptographic proof, verifiable timestamps,
              and an immutable chain of custody — ready for disputes, audits, and investigations.
            </p>

            {/* HERO BUTTONS */}
<div className="home-evidence-stack-pro">
                  <a href={appRegister}>
                {/* ✅ Primary CTA uses SAME styling as Register (gradient .proovra-cta-btn) */}
<Button className="proovra-cta-btn">Start capturing evidence</Button>
              </a>

              <Link href="/pricing">
                <Button variant="secondary" className="hero-cta-btn hero-cta-btn--secondary">
                  View pricing
                </Button>
              </Link>

              {/* Tertiary link */}
              <a className="hero-tertiary-link" href={sampleReportUrl} target="_blank" rel="noopener noreferrer">
                View sample report →
              </a>
            </div>

            {/* TRUST LINE */}
            <div className="hero-trustline">Free plan available — no credit card required.</div>

            {/* BADGES */}
            <div className="hero-badges" style={{ marginTop: 10 }}>
              <div className="hero-badge">
                <span>✓</span> Cryptographic integrity
              </div>
              <div className="hero-badge">
                <span>✓</span> Chain of custody
              </div>
              <div className="hero-badge">
                <span>✓</span> Audit-ready report
              </div>
            </div>
          </div>

          {/* RIGHT: MOCKUP (bigger ~20% but same style) */}
          <div className="hero-mockup">
            <div
              className="hero-mockup-card"
              style={{
                transform: "scale(1.2)",
                transformOrigin: "center",
              }}
            >
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
              <p>Photos, videos, and documents with context, metadata, and timestamps.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Fingerprint />
              </div>
              <h3>Fingerprint</h3>
              <p>SHA-256 hashes and Ed25519 signatures lock integrity for later verification.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Verify />
              </div>
              <h3>Verify</h3>
              <p>Anyone can confirm authenticity without exposing original private content.</p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Share />
              </div>
              <h3>Share</h3>
              <p>Verification links and PDF reports ready for audit, compliance, or dispute workflows.</p>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 72 }}>
          <h2 style={{ marginBottom: 8 }}>Who relies on PROO✓RA?</h2>
          <p className="page-subtitle" style={{ marginBottom: 32 }}>
            Built for professionals and organizations that need digital evidence to remain trustworthy — even under
            scrutiny.
          </p>

          <div className="who-it-for-grid">
            <div className="who-it-for-card">
              <Icons.Lawyers />
              <h3>Legal teams</h3>
              <p>
                Preserve photos, documents, and recordings with verifiable timestamps, integrity fingerprints, and a
                transparent chain-of-custody timeline — built for dispute and litigation workflows.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Compliance />
              <h3>Compliance &amp; risk</h3>
              <p>
                Capture audit-ready documentation for internal reviews and regulated environments, reducing uncertainty
                about what was recorded, when it existed, and whether it was modified.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Enterprises />
              <h3>Incident &amp; corporate disputes</h3>
              <p>
                Document operational incidents, customer disputes, or internal reports with structured evidence records
                that managers, auditors, and investigators can review later with confidence.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Journalists />
              <h3>Journalism &amp; investigations</h3>
              <p>
                Preserve the credibility of sensitive media and documents over time while keeping access to originals
                controlled — verification can happen independently.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Security />
              <h3>Insurance &amp; claims teams</h3>
              <p>
                Support claims, incident documentation, and case files with tamper-evident evidence packaging — useful
                when timelines and authenticity are questioned months or years later.
              </p>
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

          {/* ✅ Legal disclaimer */}
          <div
            style={{
              marginTop: 28,
              fontSize: 12,
              lineHeight: 1.6,
              color: "rgba(219,235,248,0.72)",
              maxWidth: 860,
            }}
          >
            <strong>Disclaimer:</strong> PROO✓RA is a technical evidence-integrity platform. It is not a court,
            law-enforcement authority, or legal service provider. Verification confirms the integrity and provenance of
            digital evidence, not the truthfulness or legal validity of the content itself.
          </div>
        </div>

        <div className="container" style={{ marginTop: 72, textAlign: "center" }}>
          <Link href="/pricing">
            {/* keep pricing CTA consistent */}
<Button className="proovra-cta-btn">View pricing</Button>
          </Link>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}