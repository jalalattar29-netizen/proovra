import Link from "next/link";
import { Linkedin, Twitter, Youtube } from "lucide-react";
import { MARKETING_COPY, MARKETING_LINKS } from "./tokens";

type FooterCol = {
  title: string;
  links: { label: string; href: string }[];
};

/**
 * Footer columns focus on enterprise trust, legal, governance, and
 * support — not on marketing nav already exposed in the header. Every
 * link below points at a real route (marketing `/security`, `/trust-center`
 * or the dynamic `/legal/[slug]` registry under `content/legal/en/*.md`).
 */
const COLUMNS: FooterCol[] = [
  {
    title: "Trust & Security",
    links: [
      { label: "Trust Center", href: MARKETING_LINKS.trustCenter },
      { label: "Security & Responsible Disclosure", href: "/legal/security" },
      { label: "Transparency", href: "/legal/transparency" },
      { label: "Verification Methodology", href: "/legal/verification-methodology" },
      { label: "Evidence Handling", href: "/legal/evidence-handling" },
      { label: "Incident Response", href: "/legal/incident-response" },
    ],
  },
  {
    title: "Legal & Compliance",
    links: [
      { label: "Privacy Policy", href: "/legal/privacy" },
      { label: "Terms of Service", href: "/legal/terms" },
      { label: "Cookies", href: "/legal/cookies" },
      { label: "Data Processing Addendum", href: "/legal/dpa" },
      { label: "Acceptable Use Policy", href: "/legal/aup" },
      { label: "Subprocessors", href: "/legal/subprocessors" },
      { label: "Technical & Organizational Measures", href: "/legal/toms" },
      { label: "Privacy Matrix", href: "/legal/privacy-matrix" },
      { label: "Legal Changelog", href: "/legal/legal-changelog" },
    ],
  },
  {
    title: "Governance & Requests",
    links: [
      { label: "Data Retention", href: "/legal/data-retention" },
      { label: "Law Enforcement Requests", href: "/legal/law-enforcement" },
      { label: "Abuse Reporting", href: "/legal/abuse-reporting" },
      { label: "DMCA", href: "/legal/dmca" },
      { label: "Impressum", href: "/legal/impressum" },
      { label: "Support", href: "/legal/support" },
    ],
  },
];

export function EnterpriseFooter() {
  return (
    <footer
      className="relative text-white"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        background: "linear-gradient(180deg, #0B1F5E 0%, #06112E 100%)",
      }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 pt-16 lg:px-10 2xl:px-12 lg:pt-20">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.1fr_3fr] lg:gap-16">
<div className="flex flex-col gap-4">
<Link
  href="/"
  aria-label={MARKETING_COPY.brandName}
  className="inline-flex w-fit items-center gap-1"
>
  <div className="relative flex h-[96px] w-[96px] shrink-0 items-center justify-center overflow-visible">
    <img
      src="/assets/branding/proovra-mark.png"
      alt=""
      aria-hidden="true"
      className="absolute left-1/2 top-1/2 h-[165px] w-[165px] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
    />
  </div>

  <div className="flex flex-col justify-center leading-none">
    <span className="text-[30px] font-extrabold tracking-[0.12em] text-white">
      PROOVRA
    </span>

    <span className="mt-2 text-[9.5px] font-semibold uppercase tracking-[0.26em] text-white/60">
      Integrity in Every Evidence
    </span>
  </div>
</Link>

<p className="max-w-[290px] text-[13px] leading-[1.65] text-white/65">
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
