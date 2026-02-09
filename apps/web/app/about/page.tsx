"use client";

import Link from "next/link";
import { useLocale } from "../providers";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";

export default function AboutPage() {
  const { t, locale, setLocale } = useLocale();
  const appBase =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_BASE ?? "";
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
                <Link href="/about">About</Link>
                <Link href="/pricing">Pricing</Link>
                <Link href="/verify">Verify</Link>
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

        <section className="section container" style={{ paddingTop: 36 }}>
          <h1 className="hero-title" style={{ color: "#ffffff" }}>
            ABOUT PROO✓RA
          </h1>
        </section>
      </div>

      <SilverWatermarkSection className="section">
        <div className="container">
          <p>
            In a world where digital content can be altered, disputed, or dismissed in seconds, trust has
            become fragile.
          </p>
          <p>PROO✓RA exists to restore that trust.</p>
          <p>
            We built PROO✓RA for moments that matter — when facts are questioned, when timelines are
            challenged, and when the integrity of digital evidence must withstand scrutiny. Whether it’s a
            legal dispute, an internal investigation, a compliance review, or journalistic documentation,
            PROO✓RA helps individuals and organizations capture, preserve, and verify digital truth.
          </p>
          <p>
            Modern evidence is no longer paper. It’s photos, videos, files, and data — often created under
            pressure, across devices, and shared instantly. Yet proving when something existed, what exactly
            it was, and whether it has been altered remains a complex and risky challenge.
          </p>
          <p>
            PROO✓RA solves this by combining secure capture, cryptographic integrity, immutable custody
            timelines, and verifiable reports — all designed to be understandable not only by engineers, but
            also by lawyers, investigators, compliance officers, and decision-makers.
          </p>

          <h3>What makes PROO✓RA different</h3>
          <p>PROO✓RA is not just a storage platform.</p>
          <p>It is not a file-sharing tool.</p>
          <p>And it is not a legal shortcut.</p>
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
            We focus on integrity, transparency, and auditability, not assumptions or promises. PROO✓RA does
            not decide truth — it preserves it.
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
            From individuals capturing a single critical moment, to organizations managing evidence across
            teams, PROO✓RA scales without compromising trust.
          </p>

          <h3>Our principles</h3>
          <ul>
            <li>Integrity first – Evidence must speak for itself.</li>
            <li>No silent modifications – Changes are visible or impossible.</li>
            <li>User control – You decide what to capture and what to share.</li>
            <li>Neutral by design – We don’t judge content; we preserve its integrity.</li>
            <li>Built for scrutiny – Every output is designed to be questioned and verified.</li>
          </ul>

          <h3>What PROO✓RA is not</h3>
          <p>PROO✓RA does not provide legal advice.</p>
          <p>PROO✓RA does not guarantee admissibility in any jurisdiction.</p>
          <p>PROO✓RA does not replace legal, forensic, or investigative professionals.</p>
          <p>
            Instead, PROO✓RA provides the technical foundation that allows facts to be examined with
            confidence.
          </p>

          <h3>Our mission</h3>
          <p>To make digital evidence trustworthy by default, not by explanation.</p>
          <p>
            To give individuals and organizations the tools to prove integrity — even years later.
          </p>
          <p>To raise the standard of how digital truth is captured, preserved, and verified.</p>
        </div>
      </SilverWatermarkSection>

      <SilverWatermarkSection
        className="section"
        style={{
          background: "#f1f5f9",
          borderRadius: 24,
          padding: "28px 28px 18px"
        }}
      >
        <div className="container">
          <h2 style={{ marginTop: 0 }}>Built for High-Stakes Environments</h2>
          <p>
            When outcomes carry legal, financial, or reputational consequences, evidence cannot rely on
            trust alone — it must withstand examination.
          </p>
          <p>
            PROO✓RA is built for environments where documentation is challenged, timelines are questioned,
            and digital materials are expected to hold up under professional scrutiny. We support
            organizations that operate in high-risk, high-responsibility contexts, where the integrity of
            information is critical to decision-making.
          </p>

          <h3>Legal and dispute-driven use cases</h3>
          <p>For legal professionals, evidence is only as strong as its integrity.</p>
          <p>
            PROO✓RA helps law firms, in-house legal teams, and external counsel establish a clear, verifiable
            chain of custody for digital materials, reducing uncertainty around when and how evidence was
            created.
          </p>
          <p>
            PROO✓RA does not interpret evidence or replace legal judgment. Instead, it provides a technical
            foundation that allows legal teams to focus on arguments, not authenticity.
          </p>
          <p>Typical use cases include:</p>
          <ul>
            <li>documenting incidents prior to litigation,</li>
            <li>preserving time-sensitive digital materials,</li>
            <li>supporting internal or external investigations,</li>
            <li>preparing materials for review, disclosure, or expert analysis.</li>
          </ul>

          <h3>Corporate, compliance, and internal investigations</h3>
          <p>
            Organizations face increasing pressure to demonstrate accountability, compliance, and
            transparency. PROO✓RA supports internal audit teams, compliance officers, and risk management
            functions by enabling consistent, auditable evidence capture across individuals and teams.
          </p>
          <p>
            By standardizing how digital materials are recorded and verified, PROO✓RA reduces reliance on
            informal practices such as screenshots, shared folders, or manual logs — methods that often fail
            under review.
          </p>
          <p>Use cases include:</p>
          <ul>
            <li>internal investigations and incident reviews,</li>
            <li>regulatory or compliance documentation,</li>
            <li>whistleblower-related evidence handling,</li>
            <li>post-incident reporting and audits.</li>
          </ul>

          <h3>Journalism, investigations, and sensitive documentation</h3>
          <p>
            For journalists and investigators, the credibility of digital material is essential. PROO✓RA
            provides a way to preserve the integrity of photos, videos, and documents without publicly
            exposing sources or raw content.
          </p>
          <p>
            Verification can occur independently, while access to original materials remains controlled by
            the owner. This allows sensitive documentation to be validated without unnecessary disclosure.
          </p>

          <h3>Designed for scrutiny, not convenience alone</h3>
          <p>
            Many tools prioritize speed and ease of sharing. PROO✓RA prioritizes verifiability, transparency,
            and long-term integrity.
          </p>
          <p>Our systems are designed so that:</p>
          <ul>
            <li>evidence fingerprints remain stable over time,</li>
            <li>custody events are recorded immutably,</li>
            <li>verification does not depend on private access,</li>
            <li>and integrity can be assessed independently of PROO✓RA itself.</li>
          </ul>

          <h3>Neutral by design</h3>
          <p>PROO✓RA is intentionally content-neutral.</p>
          <p>
            We do not evaluate, judge, or classify the meaning of captured materials. Our role is to
            preserve how and when digital content existed, not to decide what it represents. This
            neutrality is critical for legal, corporate, and investigative environments where impartiality
            matters.
          </p>

          <h3>Enterprise-ready, without enterprise friction</h3>
          <p>PROO✓RA supports:</p>
          <ul>
            <li>individual users and teams,</li>
            <li>controlled access and role-based ownership,</li>
            <li>optional team structures without mandatory complexity,</li>
            <li>and scalable workflows without forcing organizational lock-in.</li>
          </ul>
          <p>
            From a single verified capture to organization-wide documentation practices, PROO✓RA adapts
            without compromising its core principles.
          </p>

          <p style={{ fontSize: 12, color: "#64748b", marginTop: 16 }}>
            Final disclaimer (small text):
          </p>
          <p style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>
            PROO✓RA is a technical integrity platform. It does not provide legal advice and does not
            guarantee admissibility of evidence in any jurisdiction. Legal evaluation remains the
            responsibility of qualified professionals.
          </p>
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
