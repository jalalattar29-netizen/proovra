import Link from "next/link";
import { Linkedin, Twitter, Youtube } from "lucide-react";
import { MARKETING_COPY, MARKETING_LINKS } from "./tokens";

type FooterCol = {
  title: string;
  links: { label: string; href: string }[];
};

/**
 * Enterprise legal/trust/compliance footer. Marketing nav (Platform,
 * Solutions, Pricing, etc.) lives in the marketing header — it is
 * intentionally NOT duplicated here. Three columns: Trust & Security,
 * Legal & Compliance, Governance & Requests.
 *
 * Trust Center (/trust) remains the complete hub for every doc surfaced
 * below — no orphan pages.
 *
 * "Security Overview" preserves the legacy entry-point label and points
 * at `/security-overview`, which 308s to the canonical
 * `/legal/security` document. Privacy Matrix is permanently deleted
 * and intentionally absent here.
 */
const COLUMNS: FooterCol[] = [
  {
    title: "Trust & Security",
    links: [
      { label: "Evidence Handling", href: "/legal/evidence-handling" },
      { label: "Incident Response", href: "/legal/incident-response" },
      { label: "Security Overview", href: "/security-overview" },
      { label: "Transparency", href: "/legal/transparency" },
      { label: "Trust Center", href: MARKETING_LINKS.trustCenter },
      { label: "Verification Disclaimer", href: "/legal/verification-disclaimer" },
      { label: "Verification Methodology", href: "/legal/verification-methodology" },
    ],
  },
  {
    title: "Legal & Compliance",
    links: [
      // The canonical slug for the Acceptable Use Policy is /legal/aup
      // (matches the markdown source file aup.md). The user spec
      // suggested /legal/acceptable-use; using the canonical avoids a
      // 308 hop and matches the existing source-of-truth registry.
      { label: "Acceptable Use Policy", href: "/legal/aup" },
      { label: "Accessibility Statement", href: "/legal/accessibility" },
      { label: "Cookies", href: "/legal/cookies" },
      { label: "Data Processing Addendum", href: "/legal/dpa" },
      { label: "Legal Changelog", href: "/legal/legal-changelog" },
      { label: "Privacy Policy", href: "/legal/privacy" },
      { label: "Subprocessors", href: "/legal/subprocessors" },
      { label: "Technical & Organizational Measures", href: "/legal/toms" },
      { label: "Terms of Service", href: "/legal/terms" },
    ],
  },
  {
    title: "Governance & Requests",
    links: [
      { label: "Abuse Reporting", href: "/legal/abuse-reporting" },
      { label: "AI Use Policy", href: "/legal/ai-use-policy" },
      { label: "Consumer Cancellation & Refund Policy", href: "/legal/refund-policy" },
      { label: "Contact", href: "/contact-sales" },
      { label: "Data Retention", href: "/legal/data-retention" },
      { label: "DMCA", href: "/legal/dmca" },
      { label: "Impressum", href: "/legal/impressum" },
      { label: "Law Enforcement Requests", href: "/legal/law-enforcement" },
      { label: "Privacy Requests", href: "/legal/privacy-requests" },
      { label: "Support", href: "/support" },
      { label: "Support Policy", href: "/legal/support" },
    ],
  },
];

export function EnterpriseFooter() {
  return (
    <footer
      className="relative overflow-hidden text-white"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
      }}
    >
      {/* Footer surface artwork — set as a layer so the cover/center
          rendering matches the natural composition of the asset and
          leaves the right edge "premium" without stretching. A subtle
          deepening wash sits on top to keep column text readable, but
          stays well below the threshold that would obscure the
          artwork. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/cards/footer-card.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "cover",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,17,46,0.32) 0%, rgba(6,17,46,0.48) 100%)",
        }}
      />

      <div className="relative mx-auto max-w-[1480px] px-5 md:px-7 pt-16 lg:px-10 2xl:px-12 lg:pt-20">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.1fr_3fr] lg:gap-16">
          <div className="flex flex-col gap-5">
            {/* Horizontal logo image carries the wordmark, so we no
                longer compose mark + typeset text inline. */}
            <Link
              href="/"
              aria-label={MARKETING_COPY.brandName}
              className="inline-flex w-fit items-center"
            >
              <img
                src="/assets/branding/footer-logo.png"
                alt={MARKETING_COPY.brandName}
                className="h-auto w-[220px] max-w-full object-contain"
                style={{ objectFit: "contain" }}
              />
            </Link>

            <p className="max-w-[290px] text-[13px] leading-[1.65] text-white/70">
              Enterprise infrastructure for digital evidence integrity,
              verification, and governance.
            </p>
            <a
              href={`mailto:${MARKETING_COPY.supportEmail}`}
              className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[12.5px] font-medium text-white/85 transition-all hover:bg-white/10"
            >
              {MARKETING_COPY.supportEmail}
            </a>
            <div className="mt-2 flex items-center gap-2">
              {[
                { Icon: Linkedin, href: "https://www.linkedin.com/", label: "LinkedIn" },
                { Icon: Twitter, href: "https://x.com/", label: "Twitter / X" },
                { Icon: Youtube, href: "https://www.youtube.com/", label: "YouTube" },
              ].map(({ Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/75 transition-all hover:border-white/25 hover:bg-white/10"
                >
                  <Icon size={15} />
                </a>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3 lg:gap-12">
            {COLUMNS.map((col) => (
              <div key={col.title} className="flex flex-col gap-3">
                <h4 className="text-[12px] font-bold uppercase tracking-[0.16em] text-white">
                  {col.title}
                </h4>
                <ul className="flex flex-col gap-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-[13px] text-white/65 transition-colors hover:text-white"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-white/10 py-6 text-[12.5px] text-white/55 md:flex-row md:items-center md:justify-between">
          <span>© {new Date().getFullYear()} {MARKETING_COPY.brandName}. All rights reserved.</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/legal/privacy" className="transition-colors hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/legal/terms" className="transition-colors hover:text-white">
              Terms of Service
            </Link>
            <Link href="/legal/security" className="transition-colors hover:text-white">
              Security
            </Link>
            <Link href={MARKETING_LINKS.trustCenter} className="transition-colors hover:text-white">
              Trust Center
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
