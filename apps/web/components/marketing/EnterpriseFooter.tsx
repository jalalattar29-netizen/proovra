import Link from "next/link";
import { Linkedin, Twitter, Youtube } from "lucide-react";
import { MARKETING_ASSETS, MARKETING_COPY, MARKETING_LINKS } from "./tokens";

type FooterCol = {
  title: string;
  links: { label: string; href: string }[];
};

const COLUMNS: FooterCol[] = [
  {
    title: "Platform",
    links: [
      { label: "Overview", href: "/" },
      { label: "Capture", href: "/#evidence-lifecycle" },
      { label: "Verify", href: MARKETING_LINKS.verify },
      { label: "Reports", href: MARKETING_LINKS.sampleReport },
      { label: "Verification Packages", href: "/#security-methodology" },
      { label: "Methodology", href: MARKETING_LINKS.legal.methodology },
    ],
  },
  {
    title: "Industries",
    links: [
      { label: "Insurance", href: MARKETING_LINKS.industries.insurance },
      { label: "Legal & eDiscovery", href: MARKETING_LINKS.industries.legal },
      { label: "Government", href: MARKETING_LINKS.industries.government },
      { label: "Corporate Investigations", href: MARKETING_LINKS.industries.investigations },
      { label: "Compliance & Audit", href: MARKETING_LINKS.industries.compliance },
      { label: "Journalism", href: MARKETING_LINKS.industries.journalism },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Trust Center", href: MARKETING_LINKS.trustCenter },
      { label: "Security", href: MARKETING_LINKS.legal.security },
      { label: "Verification Methodology", href: MARKETING_LINKS.legal.methodology },
      { label: "Sample Report", href: MARKETING_LINKS.sampleReport },
      { label: "Verification Demo", href: MARKETING_LINKS.verifyDemo },
      { label: "Support", href: MARKETING_LINKS.support },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact Sales", href: MARKETING_LINKS.contactSales },
      { label: "Privacy", href: MARKETING_LINKS.legal.privacy },
      { label: "Terms", href: MARKETING_LINKS.legal.terms },
      { label: "Subprocessors", href: MARKETING_LINKS.legal.subprocessors },
      { label: "DPA", href: MARKETING_LINKS.legal.dpa },
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
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.2fr_3.4fr] lg:gap-14">
          <div className="flex flex-col gap-5">
            <Link href="/" className="flex items-center gap-3">
              <img
                src={MARKETING_ASSETS.brand.mark}
                alt=""
                className="h-11 w-11 object-contain"
              />
              <div className="flex flex-col leading-tight">
                <span className="text-[20px] font-extrabold tracking-tight text-white">
                  {MARKETING_COPY.brandName}
                </span>
                <span className="text-[11px] font-medium text-white/60">
                  {MARKETING_COPY.brandTagline}
                </span>
              </div>
            </Link>
            <p className="max-w-sm text-[13px] leading-[1.65] text-white/65">
              Enterprise infrastructure for digital evidence operations,
              integrity, and verification.
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

          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            {COLUMNS.map((col) => (
              <div key={col.title} className="flex flex-col gap-3">
                <h4 className="text-[12px] font-bold uppercase tracking-[0.16em] text-white" style={{ color: "#FFFFFF" }}>
                  {col.title}
                </h4>
                <ul className="flex flex-col gap-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-[13.5px] text-white/65 transition-colors hover:text-white"
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

        <div className="mt-14 flex flex-col gap-4 border-t border-white/10 py-6 text-[12.5px] text-white/55 md:flex-row md:items-center md:justify-between">
          <span>© {new Date().getFullYear()} {MARKETING_COPY.brandName}. All rights reserved.</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href={MARKETING_LINKS.legal.privacy} className="hover:text-white">
              Privacy Policy
            </Link>
            <Link href={MARKETING_LINKS.legal.terms} className="hover:text-white">
              Terms of Service
            </Link>
            <Link href={MARKETING_LINKS.legal.security} className="hover:text-white">
              Security
            </Link>
            <Link href={MARKETING_LINKS.trustCenter} className="hover:text-white">
              Trust Center
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
