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
          <h1 className="hero-title">ABOUT PROO✓RA</h1>
        </section>
      </div>

      <SilverWatermarkSection className="section section-body">
        <div className="container">
          {/* TL;DR */}
          <div
            style={{
              marginBottom: 18,
              padding: "14px 14px",
              borderRadius: 14,
              border: "1px solid rgba(15, 23, 42, 0.12)",
              background: "rgba(255,255,255,0.65)",
              backdropFilter: "blur(10px)"
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.8, color: "#0f172a", opacity: 0.7 }}>
              TL;DR
            </div>

            <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "#0f172a", lineHeight: 1.7 }}>
              <li>Capture evidence with context and timestamps.</li>
              <li>Lock integrity using cryptographic fingerprints and custody events.</li>
              <li>Verify and share using a neutral, audit-ready report and verification view.</li>
            </ul>
          </div>

          {/* How it works */}
          <div
            style={{
              marginBottom: 24,
              padding: "14px 14px",
              borderRadius: 14,
              border: "1px solid rgba(15, 23, 42, 0.10)",
              background: "rgba(255,255,255,0.55)",
              backdropFilter: "blur(10px)"
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.8, color: "#0f172a", opacity: 0.7 }}>
              HOW IT WORKS (30 seconds)
            </div>

            <ol style={{ margin: "10px 0 0", paddingLeft: 18, color: "#0f172a", lineHeight: 1.7 }}>
              <li>
                <b>Capture</b> a photo, video, document, or file with context.
              </li>
              <li>
                <b>Fingerprint</b> it cryptographically to create a verifiable integrity record.
              </li>
              <li>
                <b>Custody</b> events form a timeline that can be reviewed later.
              </li>
              <li>
                <b>Verify &amp; report</b> through a shareable verification view or PDF output.
              </li>
            </ol>
          </div>

          <p>
            In a world where digital content can be altered, disputed, or dismissed in seconds, trust has become fragile.
          </p>
          <p>PROO✓RA exists to restore that trust.</p>
          <p>
            We built PROO✓RA for moments that matter — when facts are questioned, when timelines are challenged, and when
            the integrity of digital evidence must withstand scrutiny. Whether it’s a legal dispute, an internal
            investigation, a compliance review, or journalistic documentation, PROO✓RA helps individuals and
            organizations capture, preserve, and verify digital truth.
          </p>
          <p>
            Modern evidence is no longer paper. It’s photos, videos, files, and data — often created under pressure,
            across devices, and shared instantly. Yet proving when something existed, what exactly it was, and whether it
            has been altered remains a complex and risky challenge.
          </p>
          <p>
            PROO✓RA solves this by combining secure capture, cryptographic integrity, immutable custody timelines, and
            verifiable reports — all designed to be understandable not only by engineers, but also by lawyers,
            investigators, compliance officers, and decision-makers.
          </p>

          <h3>What makes PROO✓RA different</h3>
          <p>PROO✓RA is not just a storage platform. It is not a file-sharing tool. And it is not a legal shortcut.</p>
          <p>PROO✓RA is an evidence integrity system.</p>
          <p>Every supported file can be:</p>
          <ul>
            <li>cryptographically fingerprinted,</li>
            <li>securely stored,</li>
            <li>time-bound to a verifiable moment,</li>
            <li>linked to an immutable custody record,</li>
            <li>and independently verified without exposing the original content.</li>
          </ul>
          <p>
            We focus on integrity, transparency, and auditability, not assumptions or promises. PROO✓RA does not decide
            truth — it preserves it.
          </p>

          <h3>Who PROO✓RA is built for</h3>
          <p>PROO✓RA is used by:</p>
          <ul>
            <li>legal professionals preparing or defending cases,</li>
            <li>compliance and risk teams documenting critical events,</li>
            <li>journalists and investigators protecting source material,</li>
            <li>companies safeguarding sensitive operational evidence,</li>
            <li>teams that need proof, not screenshots.</li>
          </ul>
          <p>
            From individuals capturing a single critical moment, to organizations managing evidence across teams,
            PROO✓RA scales without compromising trust.
          </p>

          <h3>Our principles</h3>
          <ul>
            <li>Integrity first – Evidence must speak for itself.</li>
            <li>No silent modifications – Changes are visible or impossible.</li>
            <li>User control – You decide what to capture and what to share.</li>
            <li>Neutral by design – We don’t judge content; we preserve its integrity.</li>
            <li>Built for scrutiny – Every output is designed to be questioned and verified.</li>
          </ul>

          {/* ✅ دمج what it’s not + disclaimer مرة واحدة */}
          <h3>Limitations and disclaimers</h3>
          <ul>
            <li>PROO✓RA does not provide legal advice.</li>
            <li>PROO✓RA does not guarantee admissibility in any jurisdiction.</li>
            <li>PROO✓RA does not replace legal, forensic, or investigative professionals.</li>
          </ul>
          <p>
            PROO✓RA provides the technical foundation that allows facts to be examined with confidence — while legal
            evaluation remains the responsibility of qualified professionals.
          </p>

          <h3>Our mission</h3>
          <p>To make digital evidence trustworthy by default, not by explanation.</p>
          <p>To give individuals and organizations the tools to prove integrity — even years later.</p>
          <p>To raise the standard of how digital truth is captured, preserved, and verified.</p>
        </div>
      </SilverWatermarkSection>

      {/* القسم الثاني "glass" — خففناه شوي لتقليل التكرار */}
      <SilverWatermarkSection className="section about-glass-section">
        <div className="container about-glass-card">
          <h2 style={{ marginTop: 0 }}>Built for High-Stakes Environments</h2>
          <p>
            When outcomes carry legal, financial, or reputational consequences, evidence cannot rely on trust alone — it
            must withstand examination.
          </p>

          <h3>Legal and dispute-driven use cases</h3>
          <ul>
            <li>Documenting incidents prior to litigation</li>
            <li>Preserving time-sensitive materials</li>
            <li>Supporting investigations and disclosure workflows</li>
            <li>Preparing evidence for review or expert analysis</li>
          </ul>

          <h3>Corporate, compliance, and internal investigations</h3>
          <ul>
            <li>Incident reviews and internal investigations</li>
            <li>Regulatory/compliance documentation</li>
            <li>Whistleblower-related evidence handling</li>
            <li>Post-incident reporting and audits</li>
          </ul>

          <h3>Journalism and sensitive documentation</h3>
          <p style={{ marginBottom: 0 }}>
            Preserve integrity without publicly exposing sources or raw content — verification can happen independently,
            while access stays controlled by the owner.
          </p>

          <h3>Designed for scrutiny</h3>
          <ul>
            <li>Stable evidence fingerprints over time</li>
            <li>Immutable custody events</li>
            <li>Verification that does not depend on private access</li>
            <li>Integrity assessment independent of PROO✓RA itself</li>
          </ul>

          <h3>Neutral by design</h3>
          <p style={{ marginBottom: 0 }}>
            PROO✓RA is intentionally content-neutral. We preserve how and when digital content existed — not what it
            means.
          </p>

          <p style={{ fontSize: 12, color: "rgba(219,235,248,0.72)", marginTop: 16 }}>
            PROO✓RA is a technical integrity platform. It does not provide legal advice and does not guarantee
            admissibility of evidence in any jurisdiction.
          </p>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}