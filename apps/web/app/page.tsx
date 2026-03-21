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
      <div className="blue-shell landing-shell-pro">
        <MarketingHeader />

        <section className="landing-hero landing-hero-pro container">
          <div className="landing-hero-copy landing-hero-copy-pro">
            <div className="hero-kicker-pro">Capture truth. Prove it forever.</div>

            <h1 className="hero-title hero-title-pro">
              Verifiable digital evidence for legal, compliance, and investigations.
            </h1>

            <p className="hero-subtitle hero-subtitle-pro">
              PROO✓RA lets you capture photos, videos, and documents with cryptographic proof,
              verifiable timestamps, and an immutable chain of custody — ready for disputes,
              audits, and investigations.
            </p>

            <div className="hero-actions-pro">
              <a href={appRegister}>
                <Button className="proovra-cta-btn hero-cta-btn-pro">Start capturing evidence</Button>
              </a>

              <Link href="/pricing">
                <Button variant="secondary" className="hero-cta-btn hero-cta-btn--secondary hero-cta-btn-pro-secondary">
                  View pricing
                </Button>
              </Link>

              <a
                className="hero-tertiary-link hero-tertiary-link-pro"
                href={sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View sample report →
              </a>
            </div>

            <div className="hero-trustline hero-trustline-pro">
              Free plan available — no credit card required.
            </div>

            <div className="hero-badges hero-badges-pro">
              <div className="hero-badge hero-badge-pro">
                <span>✓</span> Cryptographic integrity
              </div>
              <div className="hero-badge hero-badge-pro">
                <span>✓</span> Chain of custody
              </div>
              <div className="hero-badge hero-badge-pro">
                <span>✓</span> Audit-ready report
              </div>
            </div>
          </div>

          <div className="hero-mockup hero-mockup-pro">
            <div className="hero-product-stage">
              <div className="hero-dashboard-shell">
                <div className="hero-dashboard-topline">
                  <div className="hero-dashboard-brand">ProovRa</div>
                  <div className="hero-dashboard-tabs">
                    <span className="active">Active</span>
                    <span>Archived</span>
                    <span>All</span>
                  </div>
                </div>

                <div className="hero-dashboard-card">
                  <div className="hero-dashboard-card-header">
                    <h3>Recent Evidence</h3>
                    <button type="button">Capture Evidence</button>
                  </div>

                  <div className="hero-dashboard-list">
                    <div className="hero-dashboard-row">
                      <div className="hero-dashboard-row-left">
                        <span className="hero-dashboard-row-icon" />
                        <strong>Photo</strong>
                      </div>
                      <span>2022/3/21</span>
                      <span>1:00:20 AM</span>
                    </div>

                    <div className="hero-dashboard-row">
                      <div className="hero-dashboard-row-left">
                        <span className="hero-dashboard-row-icon" />
                        <strong>Photo</strong>
                      </div>
                      <span>2006/3/21</span>
                      <span>5:56:00 AM</span>
                    </div>

                    <div className="hero-dashboard-row">
                      <div className="hero-dashboard-row-left">
                        <span className="hero-dashboard-row-icon" />
                        <strong>Photo</strong>
                      </div>
                      <span>2006/5/16</span>
                      <span>3:95:22 AM</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hero-phone-mockup">
                <div className="hero-phone-screen">
                  <div className="hero-phone-brand">PROOVRA</div>

                  <div className="hero-phone-evidence-card">
                    <div className="hero-phone-evidence-title">Evidence #4589</div>
                    <div className="hero-phone-evidence-sub">Evidence Upload</div>

                    <div className="hero-phone-status-orb">
                      <div className="hero-phone-status-check">✓</div>
                    </div>

                    <div className="hero-phone-signed">Signed</div>
                    <div className="hero-phone-time">1:31 PM 70/pgainy 21</div>
                  </div>

                  <div className="hero-phone-toggles">
                    <div className="hero-phone-toggle-row">
                      <span className="hero-toggle-pill on" />
                      <span>Locked</span>
                    </div>
                    <div className="hero-phone-toggle-row">
                      <span className="hero-toggle-pill muted" />
                      <span>Archived</span>
                    </div>
                  </div>

                  <div className="hero-phone-nav">
                    <span>Cases</span>
                    <span>Upload</span>
                    <span>Scan</span>
                    <span>Settings</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <SilverWatermarkSection className="section landing-content-pro" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div id="how-it-works" className="container">
          <h2 style={{ marginBottom: 8 }}>How PROO✓RA works</h2>
          <p className="page-subtitle" style={{ marginBottom: 32 }}>
            Four steps from capture to verification.
          </p>

          <div className="how-it-works-grid how-it-works-grid-pro">
            <div className="how-it-works-step how-it-works-step-pro">
              <div className="how-it-works-icon">
                <Icons.Capture />
              </div>
              <h3>Capture</h3>
              <p>Photos, videos, and documents with context, metadata, and timestamps.</p>
            </div>

            <div className="how-it-works-step how-it-works-step-pro">
              <div className="how-it-works-icon">
                <Icons.Fingerprint />
              </div>
              <h3>Fingerprint</h3>
              <p>SHA-256 hashes and Ed25519 signatures lock integrity for later verification.</p>
            </div>

            <div className="how-it-works-step how-it-works-step-pro">
              <div className="how-it-works-icon">
                <Icons.Verify />
              </div>
              <h3>Verify</h3>
              <p>Anyone can confirm authenticity without exposing original private content.</p>
            </div>

            <div className="how-it-works-step how-it-works-step-pro">
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

          <div className="who-it-for-grid who-it-for-grid-pro">
            <div className="who-it-for-card who-it-for-card-pro">
              <Icons.Lawyers />
              <h3>Legal teams</h3>
              <p>
                Preserve photos, documents, and recordings with verifiable timestamps, integrity fingerprints, and a
                transparent chain-of-custody timeline — built for dispute and litigation workflows.
              </p>
            </div>

            <div className="who-it-for-card who-it-for-card-pro">
              <Icons.Compliance />
              <h3>Compliance &amp; risk</h3>
              <p>
                Capture audit-ready documentation for internal reviews and regulated environments, reducing uncertainty
                about what was recorded, when it existed, and whether it was modified.
              </p>
            </div>

            <div className="who-it-for-card who-it-for-card-pro">
              <Icons.Enterprises />
              <h3>Incident &amp; corporate disputes</h3>
              <p>
                Document operational incidents, customer disputes, or internal reports with structured evidence records
                that managers, auditors, and investigators can review later with confidence.
              </p>
            </div>

            <div className="who-it-for-card who-it-for-card-pro">
              <Icons.Journalists />
              <h3>Journalism &amp; investigations</h3>
              <p>
                Preserve the credibility of sensitive media and documents over time while keeping access to originals
                controlled — verification can happen independently.
              </p>
            </div>

            <div className="who-it-for-card who-it-for-card-pro">
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

          <div className="trust-indicators trust-indicators-pro">
            <div className="trust-item trust-item-pro">
              <Icons.Security />
              <span>Security</span>
            </div>
            <div className="trust-item trust-item-pro">
              <Icons.Evidence />
              <span>Chain of custody</span>
            </div>
            <div className="trust-item trust-item-pro">
              <Icons.Verify />
              <span>Audit-ready</span>
            </div>
            <div className="trust-item trust-item-pro">
              <Icons.Fingerprint />
              <span>Tamper-proof</span>
            </div>
          </div>

          <div
            className="landing-disclaimer-pro"
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
            <Button className="proovra-cta-btn hero-cta-btn-pro">View pricing</Button>
          </Link>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}