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

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return window.location.origin;
  }

  return process.env.NEXT_PUBLIC_APP_BASE ?? "";
}

type TrustCardProps = {
  icon: React.ReactNode;
  title: string;
  body: string;
};

function TrustCard({ icon, title, body }: TrustCardProps) {
  return (
    <div className="landing-trust-card">
      <div className="landing-trust-card__icon">{icon}</div>
      <div className="landing-trust-card__title">{title}</div>
      <div className="landing-trust-card__body">{body}</div>
    </div>
  );
}

type ProofLayerCardProps = {
  eyebrow: string;
  title: string;
  body: string;
};

function ProofLayerCard({ eyebrow, title, body }: ProofLayerCardProps) {
  return (
    <div className="proof-layer-card">
      <div className="proof-layer-card__eyebrow">{eyebrow}</div>
      <h3 className="proof-layer-card__title">{title}</h3>
      <p className="proof-layer-card__body">{body}</p>
    </div>
  );
}

export default function HomePage() {
  const appBase = getAppBase();
  const appRegister = appBase ? `${appBase}/register` : "/register";
  const appLogin = appBase ? `${appBase}/login` : "/login";
  const sampleReportUrl = "/brand/sample-report.pdf";

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <MarketingHeader />

        <section
          className="landing-hero container"
          style={{ paddingTop: 48, paddingBottom: 60 }}
        >
          <div className="landing-hero-copy">
            <div className="landing-kicker">
              Secure Digital Evidence Platform
            </div>

            <h1 className="hero-title">
              Verifiable digital evidence with cryptographic integrity,
              chain-of-custody records, and independent verification.
            </h1>

            <p className="hero-subtitle">
              PROOVRA helps you capture photos, videos, audio, and documents,
              preserve their integrity with cryptographic fingerprints and
              signatures, generate audit-ready reports, and share a dedicated
              verification page without exposing the original file publicly.
            </p>

            <div className="home-evidence-stack-pro">
              <a href={appRegister}>
                <Button className="proovra-cta-btn">
                  Start capturing evidence
                </Button>
              </a>

              <Link href="/verify">
                <Button
                  variant="secondary"
                  className="hero-cta-btn hero-cta-btn--secondary"
                >
                  Open verification portal
                </Button>
              </Link>

              <a
                className="hero-tertiary-link"
                href={sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View sample report →
              </a>
            </div>

            <div className="hero-trustline">
              Free plan available — no credit card required.
            </div>

            <div className="hero-badges" style={{ marginTop: 10 }}>
              <div className="hero-badge">
                <span>✓</span> SHA-256 fingerprinting
              </div>
              <div className="hero-badge">
                <span>✓</span> Ed25519 signatures
              </div>
              <div className="hero-badge">
                <span>✓</span> Verification page + report
              </div>
              <div className="hero-badge">
                <span>✓</span> Chain of custody timeline
              </div>
            </div>
          </div>

          <div className="hero-mockup">
            <div className="hero-mockup-card hero-mockup-card--enterprise">
              <div className="hero-mockup-title">Evidence Verification</div>

              <div className="hero-mockup-row">
                <span className="hero-dot success" />
                <span>Fingerprint hash recorded</span>
              </div>

              <div className="hero-mockup-row">
                <span className="hero-dot success" />
                <span>Signature verified</span>
              </div>

              <div className="hero-mockup-row">
                <span className="hero-dot info" />
                <span>Custody chain available</span>
              </div>

              <div className="hero-mockup-row">
                <span className="hero-dot info" />
                <span>Verification page generated</span>
              </div>

              <div className="hero-mockup-row">
                <span className="hero-dot neutral" />
                <span>Immutable storage metadata reported</span>
              </div>

              <div className="hero-mockup-row">
                <span className="hero-dot neutral" />
                <span>OpenTimestamps / TSA status visible</span>
              </div>
            </div>
          </div>
        </section>

        <section className="container" style={{ paddingBottom: 54 }}>
          <div className="quick-steps">
            <div className="quick-step">
              <div className="quick-step-title">1. Capture the original file</div>
              <div className="quick-step-sub">
                Upload photos, videos, audio, and documents into a dedicated
                evidence record.
              </div>
            </div>

            <div className="quick-step">
              <div className="quick-step-title">2. Preserve integrity</div>
              <div className="quick-step-sub">
                PROOVRA records hashes, signatures, timestamps, and custody
                events tied to the evidence record.
              </div>
            </div>

            <div className="quick-step">
              <div className="quick-step-title">3. Verify later</div>
              <div className="quick-step-sub">
                Share a verification page and report so reviewers can inspect
                integrity materials without relying on plain screenshots.
              </div>
            </div>
          </div>
        </section>
      </div>

      <SilverWatermarkSection
        className="section"
        style={{ paddingTop: 64, paddingBottom: 64 }}
      >
        <div id="how-it-works" className="container">
          <div className="landing-section-heading">
            <h2>How PROOVRA works</h2>
            <p className="page-subtitle">
              A practical workflow from original capture to later review.
            </p>
          </div>

          <div className="how-it-works-grid">
            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Capture />
              </div>
              <h3>Capture</h3>
              <p>
                Create an evidence record for photos, videos, audio, or
                documents and preserve the original submitted material.
              </p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Fingerprint />
              </div>
              <h3>Fingerprint</h3>
              <p>
                Record file hashes and signed fingerprint data so later review
                can detect integrity issues and mismatches.
              </p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Reports />
              </div>
              <h3>Report</h3>
              <p>
                Generate a structured PDF report with verification details,
                timestamps, custody events, and cryptographic references.
              </p>
            </div>

            <div className="how-it-works-step">
              <div className="how-it-works-icon">
                <Icons.Verify />
              </div>
              <h3>Verify</h3>
              <p>
                Open a dedicated verification page to review integrity status,
                custody history, storage protection, and proof materials.
              </p>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 76 }}>
          <div className="landing-section-heading">
            <h2>What reviewers can actually inspect</h2>
            <p className="page-subtitle">
              The verification workflow is not just a download link. It exposes
              the technical materials needed for later integrity review.
            </p>
          </div>

          <div className="proof-layers-grid">
            <ProofLayerCard
              eyebrow="Integrity"
              title="File hash and fingerprint materials"
              body="Reviewers can inspect the recorded file SHA-256 hash, fingerprint hash, and related verification status checks."
            />
            <ProofLayerCard
              eyebrow="Cryptography"
              title="Digital signature references"
              body="The system surfaces the signature material and signing-key metadata used to verify the evidence record."
            />
            <ProofLayerCard
              eyebrow="Timeline"
              title="Chain of custody history"
              body="Forensic custody events and access-related events are recorded separately so later review stays clearer and more structured."
            />
            <ProofLayerCard
              eyebrow="Timestamping"
              title="TSA and OpenTimestamps status"
              body="Where available, reviewers can inspect timestamp details, OpenTimestamps state, calendar information, and proof progress."
            />
            <ProofLayerCard
              eyebrow="Storage"
              title="Immutable storage indicators"
              body="Storage protection metadata such as Object Lock mode, retention windows, legal hold, and region can be surfaced in verification."
            />
            <ProofLayerCard
              eyebrow="Output"
              title="Verification page and report"
              body="Share a dedicated verification page and an audit-ready PDF report for structured review across disputes, audits, and investigations."
            />
          </div>
        </div>

        <div className="container" style={{ marginTop: 76 }}>
          <div className="landing-section-heading">
            <h2>Why teams use PROOVRA instead of ordinary files or screenshots</h2>
            <p className="page-subtitle">
              When evidence is challenged later, ordinary exports usually do not
              show enough provenance, integrity, or review history.
            </p>
          </div>

          <div className="landing-trust-grid">
            <TrustCard
              icon={<Icons.Fingerprint />}
              title="Cryptographic integrity"
              body="Evidence records are tied to cryptographic hashes and signed verification materials rather than relying on appearance alone."
            />
            <TrustCard
              icon={<Icons.Evidence />}
              title="Structured chain of custody"
              body="Capture, report generation, verification, restoration, archival, and related record events can be surfaced in a clear timeline."
            />
            <TrustCard
              icon={<Icons.Verify />}
              title="Independent review workflow"
              body="Reviewers can inspect a dedicated verification page instead of depending only on the person who originally collected the file."
            />
            <TrustCard
              icon={<Icons.Security />}
              title="Storage protection visibility"
              body="Immutable storage and retention metadata can be presented when available, helping teams understand preservation posture."
            />
          </div>
        </div>

        <div className="container" style={{ marginTop: 76 }}>
          <div className="landing-section-heading">
            <h2>Built for evidence-sensitive workflows</h2>
            <p className="page-subtitle">
              Designed for people who need digital material to remain reviewable,
              traceable, and harder to dispute later.
            </p>
          </div>

          <div className="who-it-for-grid">
            <div className="who-it-for-card">
              <Icons.Lawyers />
              <h3>Legal teams</h3>
              <p>
                Preserve media and documents with integrity records, report
                outputs, and a clearer verification trail for dispute workflows.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Compliance />
              <h3>Compliance &amp; internal reviews</h3>
              <p>
                Document internal findings, regulated workflows, and audit
                evidence with better integrity visibility and retention context.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Enterprises />
              <h3>Corporate incidents &amp; claims</h3>
              <p>
                Track supporting material for investigations, operational
                incidents, complaints, and case files across teams.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Journalists />
              <h3>Journalism &amp; investigations</h3>
              <p>
                Preserve sensitive source material while keeping a verification
                workflow separate from public exposure of the original content.
              </p>
            </div>

            <div className="who-it-for-card">
              <Icons.Security />
              <h3>Insurance &amp; risk review</h3>
              <p>
                Support claims and incident documentation with evidence records
                that remain easier to review later under scrutiny.
              </p>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 76 }}>
          <div className="landing-proof-banner">
            <div className="landing-proof-banner__copy">
              <div className="landing-proof-banner__eyebrow">
                Verification-first workflow
              </div>
              <h2 className="landing-proof-banner__title">
                Share evidence with more confidence
              </h2>
              <p className="landing-proof-banner__body">
                Instead of sending only a file, send an evidence record with a
                dedicated verification page, integrity materials, timestamp
                status, and a structured PDF report.
              </p>
            </div>

            <div className="landing-proof-banner__actions">
              <a href={appLogin}>
                <Button className="proovra-cta-btn">Open dashboard</Button>
              </a>

              <Link href="/verify">
                <Button variant="secondary">Go to verification portal</Button>
              </Link>
            </div>
          </div>
        </div>

        <div className="container" style={{ marginTop: 76 }}>
          <h2 style={{ marginBottom: 8 }}>Important clarification</h2>
          <p className="page-subtitle" style={{ marginBottom: 18 }}>
            PROOVRA is a technical integrity and verification platform.
          </p>

          <div className="landing-disclaimer-card">
            <p style={{ margin: 0 }}>
              PROOVRA is not a court, law-enforcement authority, or legal
              service provider. Verification confirms recorded integrity,
              signature, timestamp, custody, and preservation-related metadata
              for a digital evidence record. It does not by itself establish
              factual truth, authorship, identity, or legal admissibility in a
              specific jurisdiction.
            </p>
          </div>
        </div>

        <div className="container" style={{ marginTop: 76, textAlign: "center" }}>
          <div className="landing-final-cta">
            <h2>Start building stronger digital evidence records</h2>
            <p className="page-subtitle">
              Capture originals, preserve integrity, and verify later with a
              clearer review trail.
            </p>

            <div className="landing-final-cta__actions">
              <a href={appRegister}>
                <Button className="proovra-cta-btn">
                  Start capturing evidence
                </Button>
              </a>

              <a
                href={sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="secondary">View sample report</Button>
              </a>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}