import Link from "next/link";
import { Clock, Link2, Package, ScrollText, ArrowRight } from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";
import { CameraGlyph } from "./RailIcons";

const CAPABILITIES = [
  {
    title: "Cryptographic integrity",
    body: "SHA-256 fingerprints + ED25519 signatures on every record.",
    Icon: CameraGlyph,
    accent: "#F97316",
  },
  {
    title: "Timestamp verification",
    body: "RFC 3161 trusted timestamps anchored to Bitcoin via OTS.",
    Icon: Clock,
    accent: "#2563EB",
  },
  {
    title: "Tamper-evident custody",
    body: "Linked-hash custody log with prior-event binding.",
    Icon: Link2,
    accent: "#7C3AED",
  },
  {
    title: "Verification packages",
    body: "Portable signed bundles with manifest and chain.",
    Icon: Package,
    accent: "#06B6D4",
  },
  {
    title: "Governance-ready records",
    body: "Legal-hold, retention, and reviewable destruction controls.",
    Icon: ScrollText,
    accent: "#EC4899",
  },
];

export function CapabilityImpact() {
  return (
    <section
      className="relative bg-white"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-16 lg:px-10 2xl:px-12 lg:py-24">
        <div className="mb-8 flex items-center gap-3">
          <SectionBadge>PROOVRA Capabilities</SectionBadge>
          <span className="h-px flex-1 bg-[#E5E7EB]" />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_1.4fr] lg:gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-3">
            {CAPABILITIES.map(({ title, body, Icon, accent }) => (
              <div
                key={title}
                className="flex flex-col gap-3 rounded-[20px] border border-[#E5E7EB] bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.03)] transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,23,42,0.07)]"
              >
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-full"
                  style={{
                    background: accent,
                    boxShadow: `0 12px 24px ${accent}38`,
                  }}
                >
                  <Icon size={22} strokeWidth={2.4} className="text-white" />
                </span>
                <h3 className="text-[14px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                  {title}
                </h3>
                <p className="text-[12px] leading-[1.55] text-[#475569]">
                  {body}
                </p>
              </div>
            ))}
          </div>

          <Link
            href={MARKETING_LINKS.contactSales}
            className="group relative flex flex-col justify-between gap-4 overflow-hidden rounded-[24px] p-6 shadow-[0_18px_40px_rgba(124,58,237,0.30)] transition-all hover:-translate-y-0.5"
            style={{
              background:
                "linear-gradient(135deg, #F97316 0%, #EC4899 45%, #7C3AED 100%)",
              color: "#FFFFFF",
            }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-50 blur-2xl"
              style={{ background: "rgba(255,255,255,0.25)" }}
            />
            <div className="relative">
              <span
                className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: "rgba(255,255,255,0.92)" }}
              >
                Ready to transform your evidence operations?
              </span>
              <h3
                className="mt-3 text-[19px] font-extrabold leading-[1.2] tracking-tight"
                style={{ color: "#FFFFFF" }}
              >
                Request a personalized demo or speak with an expert.
              </h3>
            </div>
            <span className="relative inline-flex w-fit items-center gap-2 rounded-2xl bg-white px-5 py-2.5 text-[13.5px] font-semibold text-[#7C3AED] shadow-[0_8px_22px_rgba(15,23,42,0.10)] transition-all group-hover:bg-[#F8FAFC]">
              Talk to an expert
              <ArrowRight size={14} />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
