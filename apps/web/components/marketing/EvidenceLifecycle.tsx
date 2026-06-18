import Link from "next/link";
import { FingerprintPattern, FileText, ArrowRight } from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";
import {
  CameraGlyph,
  LockGlyph,
  ProveGlyph,
} from "./RailIcons";

const STAGES = [
  {
    n: "01",
    title: "Capture",
    body: "Collect evidence from any device or source.",
    Icon: CameraGlyph,
    accent: "#F97316",
  },
  {
    n: "02",
    title: "Preserve",
    body: "Hash, encrypt, and timestamp records.",
    Icon: LockGlyph,
    accent: "#2563EB",
  },
  {
    n: "03",
    title: "Verify",
    body: "Check integrity signals in real time.",
    Icon: FingerprintPattern,
    accent: "#7C3AED",
  },
  {
    n: "04",
    title: "Report",
    body: "Generate audit-ready evidence reports.",
    Icon: FileText,
    accent: "#06B6D4",
  },
  {
    n: "05",
    title: "Prove",
    body: "Share verification by URL, hash, or package.",
    Icon: ProveGlyph,
    accent: "#EC4899",
  },
];

export function EvidenceLifecycle() {
  return (
    <section
      id="evidence-lifecycle"
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-20 lg:px-10 2xl:px-12 lg:py-30">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <SectionBadge>Complete evidence lifecycle</SectionBadge>
            <h2 className="mt-3 text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[42px]">
              From capture to proof. <span className="text-[#64748B]">We&apos;ve got every step covered.</span>
            </h2>
          </div>
          <Link
            href={MARKETING_LINKS.legal.methodology}
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-4 py-2 text-[13.5px] font-semibold text-[#0F172A] transition-all hover:border-[var(--proovra-border-warm-hover)] md:self-auto"
          >
            Explore the platform
            <ArrowRight size={14} />
          </Link>
        </div>

        <div className="relative mt-12">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 xl:gap-4">
            {STAGES.map(({ n, title, body, Icon, accent }, idx) => (
              <div key={n} className="relative">
                <div className="group relative flex h-full flex-col gap-3 rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-1 hover:border-[var(--proovra-border-warm-hover)] hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
                  <div className="flex items-center justify-between">
                    <span
                      className="flex h-12 w-12 items-center justify-center rounded-full"
                      style={{
                        background: accent,
                        boxShadow: `0 12px 24px ${accent}38`,
                      }}
                    >
                      <Icon size={22} className="text-white" strokeWidth={2.4} />
                    </span>
                    <span
                      className="rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider text-white"
                      style={{ background: accent }}
                    >
                      {n}
                    </span>
                  </div>
                  <h3 className="text-[17px] font-bold tracking-tight text-[#0F172A]">
                    {title}
                  </h3>
                  <p className="text-[13.5px] leading-[1.55] text-[#475569]">{body}</p>
                </div>
                {idx < STAGES.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-3 top-[44px] hidden h-px w-6 xl:block"
                    style={{
                      background:
                        "linear-gradient(90deg, #CBD5E1 0%, #CBD5E1 60%, transparent 100%)",
                    }}
                  />
                ) : null}
                {idx < STAGES.length - 1 ? (
                  <ArrowRight
                    size={14}
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-[14px] top-[37px] hidden text-[#94A3B8] xl:block"
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
