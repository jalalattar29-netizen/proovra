import Link from "next/link";
import {
  ArrowRight,
  FingerprintPattern,
  ShieldCheck,
  FileCheck,
  Fingerprint,
  Lock,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

const HERO_BACKGROUND = "/assets/hero/proovra-hero-background.png";
const HERO_TOWER = "/assets/hero/proovra-hero-tower-trimmed.png";

const TRUST_CHIPS = [
  { Icon: FingerprintPattern, label: "Cryptographic Records" },
  { Icon: ShieldCheck, label: "Independent Verification" },
  { Icon: Lock, label: "Enterprise Security" },
];

const RailCameraIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8.2 6.5 9.5 4.8h5l1.3 1.7H18a3 3 0 0 1 3 3v6.7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9.5a3 3 0 0 1 3-3h2.2Zm3.8 10a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4Zm0-2.1a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z"
    />
  </svg>
);

const RailLockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M7 10V8a5 5 0 0 1 10 0v2h1.2A1.8 1.8 0 0 1 20 11.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19.2v-7.4A1.8 1.8 0 0 1 5.8 10H7Zm2.5 0h5V8a2.5 2.5 0 0 0-5 0v2Z"
    />
  </svg>
);

const RailProveIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle
      cx="12"
      cy="12"
      r="8"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
    />
    <path
      d="M4.5 12h15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M12 4c2.2 2.2 3.3 4.9 3.3 8s-1.1 5.8-3.3 8c-2.2-2.2-3.3-4.9-3.3-8s1.1-5.8 3.3-8Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinejoin="round"
    />
  </svg>
);

const RAIL_ITEMS = [
  { Icon: RailCameraIcon, color: "#FF6B00", title: "CAPTURE", body: ["Collect evidence from", "any source"] },
  { Icon: RailLockIcon, color: "#2563EB", title: "PRESERVE", body: ["Hash, encrypt & timestamp", "to prevent alteration"] },
{
  Icon: Fingerprint,
  color: "#6D28D9",
  title: "VERIFY",
  body: ["AI-powered verification &", "real-time integrity checks"],
},
{
  Icon: FileCheck,
  color: "#06B6D4",
  title: "REPORT",
  body: ["Generate review-ready", "reports with full audit trail"],
},
{
  Icon: RailProveIcon,
  color: "#E91E63",
  title: "PROVE",
  body: ["Share or verify authenticity", "instantly, anywhere"],
},
];

export function HeroSection() {
  return (
    <section
      className="proovra-hero relative overflow-hidden"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        backgroundColor: "#ffffff",
      }}
    >
      <style>{`
        /* Header-height variable + hero height ladder.
           Mobile/tablet (<1024) use natural content height (no fixed
           min-height) so the in-flow tower below the text never gets
           clipped and the next section can never bleed over the hero. */
        .proovra-hero { --marketing-header-height: 76px; }
        @media (min-width: 768px) {
          .proovra-hero { --marketing-header-height: 88px; }
        }
        @media (min-width: 1024px) {
          .proovra-hero {
            --marketing-header-height: 104px;
            height: 680px;
            min-height: 680px;
          }
        }
        @media (min-width: 1440px) {
          .proovra-hero { height: 720px; min-height: 720px; }
        }
        @media (min-width: 1920px) {
          .proovra-hero { height: 780px; min-height: 780px; }
        }

        /* Content padding ladder. */
        .proovra-hero-content {
          padding-top: calc(var(--marketing-header-height, 76px) + 56px);
        }
        @media (min-width: 1024px) {
          .proovra-hero-content {
            padding-top: calc(var(--marketing-header-height, 104px) + 24px);
          }
        }
        @media (min-width: 1440px) {
          .proovra-hero-content {
            padding-top: calc(var(--marketing-header-height, 104px) + 28px);
          }
        }
        @media (min-width: 1920px) {
          .proovra-hero-content {
            padding-top: calc(var(--marketing-header-height, 104px) + 32px);
          }
        }

        /* Background image — stretch horizontally to the hero edges; no
           transform, no scale. */
.proovra-hero-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center bottom;
  transform: none;
  z-index: 0;
  pointer-events: none;
}

        /* Tower (trimmed transparent PNG) — explicit pixel widths per
           breakpoint. Tablet uses a viewport-aware sizing with reduced
           opacity; phones hide it entirely. Desktop tiers step up cleanly
           through 1024/1280/1440/1600/1920 to stay zoom-safe. */
.proovra-hero-tower {
  /* Mobile/tablet (<1024): the tower renders in normal flow as a centered
     block beneath the CTAs and trust chips. The split-hero composition is
     reserved for desktop only — the tower never sits behind text. */
  display: block;
  position: relative;
  z-index: 2;
  margin: 28px auto 4px;
  width: min(70%, 280px);
  height: auto;
  object-fit: contain;
  pointer-events: none;
}

@media (min-width: 1024px) {
  .proovra-hero-tower {
    /* Desktop split-hero: tower absolute-positioned on the right side. */
    display: block;
    position: absolute;
    margin: 0;
    z-index: 4;
    max-width: none;
    width: auto;
    height: 490px;
    right: 27%;
    top: 100px;
    bottom: auto !important;
    transform: none !important;
  }
}

@media (min-width: 1280px) {
  .proovra-hero-tower {
    height: 520px;
    right: 27%;
    top: 90px;
  }
}

@media (min-width: 1440px) {
  .proovra-hero-tower {
    height: 555px;
    right: 26%;
    top: 80px;
  }
}

@media (min-width: 1600px) {
  .proovra-hero-tower {
    height: 590px;
    right: 26%;
    top: 85px;
  }
}

@media (min-width: 1920px) {
  .proovra-hero-tower {
    height: 630px;
    right: 25%;
    top: 70px;
  }
}

        /* Process rail — HTML right-side timeline of 5 steps. Hidden below lg. */
        .proovra-hero-rail {
          display: none;
          position: absolute;
          top: 50%;
          right: 5%;
          width: 285px;
          transform: translateY(-50%);
          pointer-events: none;
          z-index: 5;
        }
        @media (min-width: 1024px) {
          .proovra-hero-rail { display: block; }
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail { right: 5.5%; }
        }
        @media (min-width: 1920px) {
          .proovra-hero-rail { right: 6%; }
        }

        /* Vertical line behind the icon circles */
        .proovra-hero-rail-line {
          position: absolute;
          top: 22px;
          bottom: 22px;
          width: 2px;
          background: rgba(31, 41, 55, 0.22);
          left: 21px;
        }
        @media (min-width: 1280px) {
          .proovra-hero-rail-line { left: 23px; }
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-line { left: 26px; }
        }

        .proovra-hero-rail-items {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 26px;
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-items { gap: 30px; }
        }

        .proovra-hero-rail-item {
          position: relative;
          display: flex;
          align-items: flex-start;
          gap: 14px;
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-item { gap: 16px; }
        }

        .proovra-hero-rail-icon {
          position: relative;
          z-index: 1;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 9999px;
          width: 50px;
          height: 50px;
        }
        @media (min-width: 1280px) {
          .proovra-hero-rail-icon { width: 48px; height: 48px; }
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-icon { width: 54px; height: 54px; }
        }

.proovra-hero-rail-icon svg {
  width: 30px;
  height: 30px;
  color: #ffffff;
  display: block;
}

@media (min-width: 1440px) {
  .proovra-hero-rail-icon svg {
    width: 34px;
    height: 34px;
  }
}

        .proovra-hero-rail-title {
          font-weight: 800;
          letter-spacing: 0.05em;
          color: #0F172A;
          font-size: 12.5px;
          line-height: 1.2;
          margin-bottom: 2px;
        }
        @media (min-width: 1280px) {
          .proovra-hero-rail-title { font-size: 13px; }
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-title { font-size: 14px; }
        }

        .proovra-hero-rail-icon svg {
  width: 30px;
  height: 30px;
  color: #ffffff;
  display: block;
}

        .proovra-hero-rail-body {
          font-weight: 500;
          color: #1F2937;
          font-size: 11px;
          line-height: 1.35;
          margin: 0;
        }
        @media (min-width: 1280px) {
          .proovra-hero-rail-body { font-size: 11.5px; }
        }
        @media (min-width: 1440px) {
          .proovra-hero-rail-body { font-size: 12.5px; }
        }
      `}</style>

      <img
        src={HERO_BACKGROUND}
        alt=""
        aria-hidden="true"
        className="proovra-hero-bg"
      />

      <div className="proovra-hero-wave" aria-hidden="true" />


      <div className="proovra-hero-rail" aria-hidden="true">
        <div className="proovra-hero-rail-line" />
        <div className="proovra-hero-rail-items">
          {RAIL_ITEMS.map(({ Icon, color, title, body }) => (
            <div key={title} className="proovra-hero-rail-item">
              <div
                className="proovra-hero-rail-icon"
                style={{ background: color }}
              >
<Icon
  size={24}
  color="#FFFFFF"
  strokeWidth={2.4}
/>
              </div>
              <div>
                <div className="proovra-hero-rail-title">{title}</div>
                <p className="proovra-hero-rail-body">
{(body ?? []).map((line, i) => (
  <span key={i} className="block">
    {line}
  </span>
))}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Content layer — text on the left, above the visual layers. */}
      <div
        className="proovra-hero-content relative mx-auto max-w-[1480px] px-5 pb-16 md:px-7 lg:px-10 lg:pb-10 min-[1440px]:pb-12 2xl:px-12"
        style={{ zIndex: 10 }}
      >
<div className="flex max-w-[800px] flex-col gap-6 lg:max-w-[800px]">
            <SectionBadge>Digital Evidence Operations Platform</SectionBadge>

<h1 className="font-extrabold tracking-[-0.02em] text-[#0F172A]">
<span className="block text-[36px] leading-[1.06] sm:text-[44px] lg:text-[46px] min-[1440px]:text-[54px] min-[1920px]:text-[64px]">
  Evidence integrity.
  <br />
  Verification confidence.
  <br />
  Operational trust.
</span>
<span className="mt-3 block bg-clip-text text-transparent text-[24px] leading-[1.15] sm:text-[28px] lg:text-[30px] min-[1440px]:text-[34px] min-[1920px]:text-[40px]"
    style={{
      backgroundImage:
        "linear-gradient(90deg, #F97316 0%, #EC4899 50%, #7C3AED 100%)",
    }}
  >
    Digital evidence infrastructure for high-trust operations.
  </span>
</h1>

          <p className="max-w-[620px] text-[16px] leading-[1.65] text-[#475569] lg:max-w-[520px] lg:text-[15px] lg:leading-[1.55] min-[1440px]:max-w-[620px] min-[1440px]:text-[17px] min-[1440px]:leading-[1.65]">
Digital evidence infrastructure for legal, insurance, investigation, compliance, and public-sector teams that require trusted records, verification, and audit-ready reporting.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {/* CTA cleanup: replaced "Try live verification" with
                "View sample report" pointing at the canonical sample
                report PDF. Same primary navy-pill treatment, opens in a
                new tab as a downloadable asset. */}
            <a
              href={MARKETING_LINKS.sampleReport}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#0B1F5E] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_30px_rgba(11,31,94,0.28)] transition-all hover:bg-[#0a1c54] hover:shadow-[0_18px_36px_rgba(11,31,94,0.34)]"
            >
              View sample report
              <ArrowRight size={16} />
            </a>
            <Link
              href={MARKETING_LINKS.requestDemo}
              className={MARKETING_BTN.heroSecondary}
            >
              Request a demo
            </Link>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:mt-5 lg:flex lg:max-w-[760px] lg:flex-wrap lg:items-center lg:gap-3 min-[1440px]:mt-8">
          {TRUST_CHIPS.map(({ Icon, label }) => (
            <div key={label} className="flex items-center gap-2 lg:shrink-0 lg:gap-1.5 min-[1440px]:gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0B1F5E] lg:h-6 lg:w-6 min-[1440px]:h-7 min-[1440px]:w-7">
                <Icon size={14} className="text-white" />
              </span>
              <span className="text-[12.5px] font-bold text-[#0F172A] lg:whitespace-nowrap min-[1440px]:text-[13px]">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <img
        src={HERO_TOWER}
        alt=""
        aria-hidden="true"
        className="proovra-hero-tower"
      />
    </section>
  );
}
