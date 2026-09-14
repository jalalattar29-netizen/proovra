import Link from "next/link";
import {
  ArrowRight,
  Camera,
  FileCheck,
  Fingerprint,
  Globe,
  Lock,
  ShieldCheck,
} from "lucide-react";

import { HeroTower3D } from "./HeroTower3D";

const HERO_BACKGROUND = "/assets/hero/proovra-hero-background.png";

type HeroSectionProps = {
  sampleReportHref: string;
  requestDemoHref: string;
  phoneScreenSrc?: string;
};

const TRUST_CHIPS = [
  { Icon: Fingerprint, label: "Cryptographic Records" },
  { Icon: ShieldCheck, label: "Independent Verification" },
  { Icon: Lock, label: "Enterprise Security" },
];

const RAIL_ITEMS = [
  {
    Icon: Camera,
    color: "#FF6B00",
    title: "CAPTURE",
    body: "Collect evidence from any source",
  },
  {
    Icon: Lock,
    color: "#2563EB",
    title: "PRESERVE",
    body: "Hash, encrypt & timestamp to prevent alteration",
  },
  {
    Icon: Fingerprint,
    color: "#6D28D9",
    title: "VERIFY",
    // Integrity checks do not establish the authenticity of captured content.
    body: "Cryptographic signatures & hash-linked integrity checks",
  },
  {
    Icon: FileCheck,
    color: "#06B6D4",
    title: "REPORT",
    body: "Generate review-ready reports with full audit trail",
  },
  {
    Icon: Globe,
    color: "#E91E63",
    title: "PROVE",
    body: "Share a package anyone can check, instantly",
  },
];

export function HeroSection({
  sampleReportHref,
  requestDemoHref,
  phoneScreenSrc,
}: HeroSectionProps) {
  return (
    <section className="proovra-hero">
      <img
        src={HERO_BACKGROUND}
        alt=""
        aria-hidden="true"
        className="proovra-hero-bg"
      />

      <div className="proovra-hero-layout">
        <div className="proovra-hero-copy">
          <div className="proovra-hero-badge">
            <span aria-hidden="true" />
            Digital Evidence Operations Platform
          </div>

          <h1 className="proovra-hero-heading">
            <span className="proovra-hero-heading-main">
              Evidence integrity.
              <br />
              Verification confidence.
              <br />
              Operational trust.
            </span>

            <span className="proovra-hero-heading-accent">
              Digital evidence infrastructure for high-trust operations.
            </span>
          </h1>

          <p className="proovra-hero-description">
            Digital evidence infrastructure for legal, insurance,
            investigation, compliance, and public-sector teams that require
            trusted records, verification, and audit-ready reporting.
          </p>

          <div className="proovra-hero-actions">
            <a
              href={sampleReportHref}
              target="_blank"
              rel="noopener noreferrer"
              className="proovra-hero-primary"
            >
              View sample report
              <ArrowRight size={16} aria-hidden="true" />
            </a>

            <Link
              href={requestDemoHref}
              className="proovra-hero-secondary"
            >
              Request a demo
            </Link>
          </div>

          <ul className="proovra-hero-trust" aria-label="Platform capabilities">
            {TRUST_CHIPS.map(({ Icon, label }) => (
              <li key={label} className="proovra-hero-trust-item">
                <span className="proovra-hero-trust-icon">
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="proovra-hero-visual">
          <HeroTower3D
            className="proovra-hero-tower"
            phoneScreenSrc={phoneScreenSrc}
            duration={9}
          />
        </div>

        <aside className="proovra-hero-rail" aria-label="Evidence workflow">
          <ol className="proovra-hero-rail-items">
            {RAIL_ITEMS.map(({ Icon, color, title, body }) => (
              <li key={title} className="proovra-hero-rail-item">
                <span
                  className="proovra-hero-rail-icon"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                >
                  <Icon size={25} strokeWidth={2.2} />
                </span>

                <div className="proovra-hero-rail-copy">
                  <h2 className="proovra-hero-rail-title">{title}</h2>
                  <p className="proovra-hero-rail-body">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <style>{styles}</style>
    </section>
  );
}

const styles = `
  .proovra-hero {
    --marketing-header-height: 76px;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    background: #fff;
    font-family: var(--font-jakarta), Inter, system-ui, sans-serif;
  }

  .proovra-hero *,
  .proovra-hero *::before,
  .proovra-hero *::after {
    box-sizing: border-box;
  }

  .proovra-hero-bg {
    position: absolute;
    inset: 0;
    z-index: -2;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center bottom;
    pointer-events: none;
  }

  .proovra-hero::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(
      110deg,
      rgba(255, 255, 255, .96),
      rgba(255, 255, 255, .8) 32%,
      rgba(255, 255, 255, .16) 70%
    );
    pointer-events: none;
  }

  .proovra-hero-layout {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 1680px;
    margin-inline: auto;
    padding:
      calc(var(--marketing-header-height) + 40px)
      20px
      32px;
  }

  .proovra-hero-copy {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 24px;
    min-width: 0;
    max-width: 680px;
  }

  .proovra-hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    max-width: 100%;
    padding: 9px 13px;
    border: 1px solid rgba(109, 40, 217, .14);
    border-radius: 999px;
    background: rgba(255, 255, 255, .8);
    color: #493176;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.5;
  }

  .proovra-hero-badge > span {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #8b5cf6;
    box-shadow: 0 0 0 4px #8b5cf614;
  }

  .proovra-hero-heading {
    margin: 0;
    color: #0f172a;
    font-weight: 800;
    letter-spacing: -.035em;
    overflow-wrap: anywhere;
  }

  .proovra-hero-heading-main {
    display: block;
    font-size: clamp(30px, 5.8vw, 44px);
    line-height: 1.09;
  }

  .proovra-hero-heading-accent {
    display: block;
    max-width: 580px;
    margin-top: 18px;
    background: linear-gradient(
      100deg,
      #f97316,
      #ec4899 48%,
      #7c3aed
    );
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    font-size: clamp(22px, 3.6vw, 30px);
    line-height: 1.22;
    letter-spacing: -.025em;
  }

  .proovra-hero-description {
    max-width: 560px;
    margin: 0;
    color: #475569;
    font-size: 16px;
    line-height: 1.7;
  }

  .proovra-hero-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .proovra-hero-primary,
  .proovra-hero-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 50px;
    padding: 14px 24px;
    border: 1px solid transparent;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
    transition:
      transform 180ms ease,
      box-shadow 180ms ease,
      background-color 180ms ease;
  }

  .proovra-hero-primary {
    background: #0b1f5e;
    color: #fff;
    box-shadow: 0 12px 30px rgba(11, 31, 94, .22);
  }

  .proovra-hero-secondary {
    background: rgba(255, 255, 255, .75);
    border-color: #d6dce9;
    color: #0b1f5e;
  }

  .proovra-hero-primary svg {
    transition: transform 180ms ease;
  }

  @media (hover: hover) {
    .proovra-hero-primary:hover {
      transform: translateY(-2px);
      background: #122c76;
      box-shadow: 0 18px 36px rgba(11, 31, 94, .28);
    }

    .proovra-hero-primary:hover svg {
      transform: translateX(3px);
    }

    .proovra-hero-secondary:hover {
      transform: translateY(-2px);
      background: #fff;
      box-shadow: 0 8px 20px #0b1f5e0d;
    }
  }

  .proovra-hero-actions a:focus-visible {
    outline: 3px solid #7c3aed;
    outline-offset: 5px;
  }

  .proovra-hero-trust {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 18px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }

  .proovra-hero-trust-item {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #0f172a;
    font-size: 12px;
    font-weight: 700;
  }

  .proovra-hero-trust-icon {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 27px;
    height: 27px;
    border-radius: 8px;
    background: #0b1f5e;
    color: #fff;
  }

  .proovra-hero-visual {
    position: relative;
    min-width: 0;
    width: 100%;
    height: clamp(480px, 110vw, 640px);
  }

  /* Size only the scene root; its internal geometry must stay untouched. */
  .proovra-hero .proovra-hero-tower {
    position: relative;
    width: 100%;
    height: 100%;
    margin: 0;
    pointer-events: auto;
  }

  .proovra-hero-rail {
    display: none;
    min-width: 0;
  }

  .proovra-hero-rail-items {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 28px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .proovra-hero-rail-items::before {
    content: "";
    position: absolute;
    top: 24px;
    bottom: 24px;
    left: 23px;
    width: 2px;
    background: linear-gradient(
      #ff6b0040,
      #2563eb40,
      #6d28d940,
      #06b6d440,
      #e91e6340
    );
  }

  .proovra-hero-rail-item {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .proovra-hero-rail-icon {
    position: relative;
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 48px;
    height: 48px;
    border: 3px solid rgba(255, 255, 255, .9);
    border-radius: 50%;
    color: #fff;
    box-shadow: 0 6px 16px rgba(31, 41, 55, .12);
  }

  .proovra-hero-rail-icon svg {
    display: block;
    width: 25px;
    height: 25px;
    color: inherit;
  }

  .proovra-hero-rail-copy {
    min-width: 0;
    padding-top: 5px;
  }

  .proovra-hero-rail-title {
    margin: 0 0 5px;
    color: #0f172a;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .06em;
    line-height: 1.2;
  }

  .proovra-hero-rail-body {
    margin: 0;
    color: #475569;
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1.5;
  }

  @media (max-width: 479px) {
    .proovra-hero-actions {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @media (min-width: 768px) {
    .proovra-hero {
      --marketing-header-height: 88px;
    }

    .proovra-hero-layout {
      padding-inline: 32px;
    }
  }

  @media (min-width: 1024px) {
    .proovra-hero {
      --marketing-header-height: 104px;
    }

    .proovra-hero-layout {
      grid-template-columns:
        minmax(0, 1.15fr)
        minmax(0, .85fr);
      gap: 20px;
      padding:
        calc(var(--marketing-header-height) + 16px)
        40px
        40px;
    }

    .proovra-hero-heading-main {
      font-size: clamp(36px, 3.2vw, 52px);
    }

    .proovra-hero-heading-accent {
      font-size: clamp(24px, 2vw, 32px);
    }

    .proovra-hero-visual {
      height: 640px;
    }
  }

  @media (min-width: 1280px) {
    .proovra-hero-layout {
      grid-template-columns:
        minmax(0, 1.3fr)
        minmax(0, 1fr)
        190px;
      gap: 24px;
    }

    .proovra-hero-rail {
      display: block;
    }

    .proovra-hero-heading-main {
      font-size: clamp(36px, 2.9vw, 48px);
    }

    .proovra-hero-description {
      font-size: 15px;
    }
  }

  @media (min-width: 1536px) {
    .proovra-hero-layout {
      grid-template-columns:
        minmax(0, 1.3fr)
        minmax(0, 1fr)
        220px;
      gap: 28px;
      padding-inline: 48px;
    }

    .proovra-hero-visual {
      height: 700px;
    }

    .proovra-hero-description {
      font-size: 17px;
    }

    .proovra-hero-rail-items {
      gap: 34px;
    }

    .proovra-hero-rail-title {
      font-size: 13px;
    }

    .proovra-hero-rail-body {
      font-size: 12px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .proovra-hero-primary,
    .proovra-hero-secondary,
    .proovra-hero-primary svg {
      transition: none;
    }

    .proovra-hero-primary:hover,
    .proovra-hero-secondary:hover,
    .proovra-hero-primary:hover svg {
      transform: none;
    }
  }
`;

export default HeroSection;