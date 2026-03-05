// D:\digital-witness\apps\web\app\about\page.tsx
"use client";

import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";

export default function AboutPage() {
  return (
    <div className="page landing-page about-page">
      <div className="blue-shell">
        <MarketingHeader />

        <section className="section container hero-section-tight">
          <h1 className="hero-title">About PROO✓RA</h1>
          <p className="page-subtitle" style={{ marginTop: 10, maxWidth: 820 }}>
            PROO✓RA is a technical evidence-integrity platform that helps you capture digital content with verifiable
            timestamps, cryptographic fingerprints, and a transparent chain of custody — so integrity can be proven later
            with confidence.
          </p>
        </section>
      </div>

      <SilverWatermarkSection className="section section-body">
        <div className="container">
          {/* Top summary grid */}
          <div className="about-grid">
            <div className="about-card">
              <div className="about-kicker">At a glance</div>
              <ul className="about-list">
                <li>Capture evidence with context and timestamps.</li>
                <li>Lock integrity using cryptographic fingerprints.</li>
                <li>Review custody events in a clear timeline.</li>
                <li>Verify &amp; share via a neutral verification view or PDF report.</li>
              </ul>
            </div>

            <div className="about-card">
              <div className="about-kicker">How it works</div>
              <ol className="about-list about-list--ordered">
                <li>
                  <strong>Capture</strong> a photo, video, document, or file with context.
                </li>
                <li>
                  <strong>Fingerprint</strong> it cryptographically to create a verifiable integrity record.
                </li>
                <li>
                  <strong>Custody</strong> events form a timeline that can be reviewed later.
                </li>
                <li>
                  <strong>Verify &amp; report</strong> through a shareable verification view or PDF output.
                </li>
              </ol>
            </div>

            <div className="about-card">
              <div className="about-kicker">Important note</div>
              <p className="about-muted" style={{ marginTop: 10 }}>
                PROO✓RA is not a court, a law-enforcement authority, or a legal service provider. Verification confirms
                the integrity and provenance of digital evidence — not the truthfulness or legal validity of the content
                itself.
              </p>
            </div>
          </div>

          {/* Main content (clean typography) */}
          <div className="about-prose">
            <h3>Why PROO✓RA exists</h3>
            <p>
              In a world where digital content can be altered, disputed, or dismissed in seconds, trust has become
              fragile. PROO✓RA exists to restore that trust — by making integrity provable.
            </p>

            <h3>What makes PROO✓RA different</h3>
            <p>
              PROO✓RA is not just storage. It is not file sharing. And it is not a legal shortcut. It is an evidence
              integrity system.
            </p>

            <div className="about-card about-card--inline">
              <div className="about-kicker">Every supported file can be</div>
              <ul className="about-list">
                <li>cryptographically fingerprinted,</li>
                <li>securely stored,</li>
                <li>time-bound to a verifiable moment,</li>
                <li>linked to an immutable custody record,</li>
                <li>independently verified without exposing the original content.</li>
              </ul>
            </div>

            <h3>Who PROO✓RA is built for</h3>
            <p className="about-muted">Teams that need proof that stands up to scrutiny — not screenshots.</p>

            <div className="about-two-col">
              <div className="about-card about-card--inline">
                <div className="about-kicker">Common users</div>
                <ul className="about-list">
                  <li>legal professionals preparing or defending cases,</li>
                  <li>compliance and risk teams documenting critical events,</li>
                  <li>journalists and investigators protecting source material,</li>
                  <li>companies safeguarding sensitive operational evidence,</li>
                  <li>insurance and claims teams handling disputes.</li>
                </ul>
              </div>

              <div className="about-card about-card--inline">
                <div className="about-kicker">Principles</div>
                <ul className="about-list">
                  <li>Integrity first — evidence must speak for itself.</li>
                  <li>No silent modifications — changes are visible or impossible.</li>
                  <li>User control — you decide what to capture and what to share.</li>
                  <li>Neutral by design — we preserve integrity, not meaning.</li>
                  <li>Built for scrutiny — outputs are designed to be questioned.</li>
                </ul>
              </div>
            </div>

            <h3>Limitations</h3>
            <ul className="about-list">
              <li>PROO✓RA does not provide legal advice.</li>
              <li>PROO✓RA does not guarantee admissibility in any jurisdiction.</li>
              <li>PROO✓RA does not replace legal, forensic, or investigative professionals.</li>
            </ul>
          </div>
        </div>
      </SilverWatermarkSection>

      {/* High-stakes section: same card style */}
      <SilverWatermarkSection className="section">
        <div className="container">
          <div className="about-card about-card--big">
            <h2 style={{ marginTop: 0 }}>Built for High-Stakes Environments</h2>
            <p className="about-muted">
              When outcomes carry legal, financial, or reputational consequences, evidence cannot rely on trust alone —
              it must withstand examination.
            </p>

            <div className="about-two-col">
              <div>
                <h3>Legal &amp; dispute-driven use cases</h3>
                <ul className="about-list">
                  <li>Documenting incidents prior to litigation</li>
                  <li>Preserving time-sensitive materials</li>
                  <li>Supporting investigations and disclosure workflows</li>
                  <li>Preparing evidence for review or expert analysis</li>
                </ul>
              </div>

              <div>
                <h3>Corporate, compliance &amp; investigations</h3>
                <ul className="about-list">
                  <li>Incident reviews and internal investigations</li>
                  <li>Regulatory / compliance documentation</li>
                  <li>Whistleblower-related evidence handling</li>
                  <li>Post-incident reporting and audits</li>
                </ul>
              </div>
            </div>

            <h3>Journalism &amp; sensitive documentation</h3>
            <p className="about-muted" style={{ marginBottom: 0 }}>
              Preserve integrity without publicly exposing sources or raw content — verification can happen
              independently, while access stays controlled by the owner.
            </p>

            <div className="about-divider" />

            <p className="about-footnote">
              PROO✓RA is a technical integrity platform. It does not provide legal advice and does not guarantee
              admissibility of evidence in any jurisdiction.
            </p>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}