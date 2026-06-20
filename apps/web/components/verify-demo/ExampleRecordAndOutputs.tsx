"use client";

import {
  ArrowRight,
  FileText as PFilePdf,
  Package as PPackage,
  ShieldCheck as PShieldCheck,
} from "lucide-react";
import {
  DEMO_RECORD,
  InlineEyebrow,
  StatusPill,
} from "./_shared";

const SIGNALS = [
  { label: "Integrity", tone: "valid" as const, value: "Valid" },
  { label: "Signature", tone: "valid" as const, value: "Valid" },
  { label: "TSA Timestamp", tone: "verified" as const, value: "Verified" },
  { label: "OpenTimestamp", tone: "published" as const, value: "Published" },
  { label: "Custody", tone: "consistent" as const, value: "Consistent" },
  { label: "Storage Protection", tone: "protected" as const, value: "Protected" },
];

const OUTPUTS = [
  {
    title: "Verification Record",
    body: "Open the full reviewer-facing verification record.",
    icon: PShieldCheck,
    cta: "Open record",
    chipBg: "#DCFCE7",
    chipBorder: "#BBF7D0",
    chipText: "#16A34A",
    ctaText: "#16A34A",
    halo: "rgba(22,163,74,0.07)",
  },
  {
    title: "Sample Report",
    body: "View the generated PDF report.",
    icon: PFilePdf,
    cta: "View report",
    chipBg: "#FFF1F2",
    chipBorder: "#FECDD3",
    chipText: "#E11D48",
    ctaText: "#E11D48",
    halo: "rgba(225,29,72,0.07)",
  },
  {
    title: "Verification Package",
    body: "Download the disclosure package with all materials.",
    icon: PPackage,
    cta: "View package",
    chipBg: "#F5F3FF",
    chipBorder: "#DDD6FE",
    chipText: "#7C3AED",
    ctaText: "#7C3AED",
    halo: "rgba(124,58,237,0.07)",
  },
];

export function ExampleRecordAndOutputs() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto grid max-w-7xl gap-5 px-6 md:px-8 lg:grid-cols-2 lg:items-start">
        <div>
          <InlineEyebrow>Example Verification Record</InlineEyebrow>
          <div className="mt-5 rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-[1.1rem] font-semibold text-[#0F172A]">
                {DEMO_RECORD.fileName}
              </h3>
              <span className="rounded-md bg-[#EEF2FF] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[#4338CA]">
                PDF
              </span>
              <span className="text-[12px] text-[#64748B]">
                {DEMO_RECORD.fileSize}
              </span>
            </div>
            <div className="mt-1 text-[12px] text-[#64748B]">
              Verified on {DEMO_RECORD.verifiedAt}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {SIGNALS.map((s) => (
                <div key={s.label} className="rounded-lg bg-[#F8FAFC] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
                    {s.label}
                  </div>
                  <div className="mt-1">
                    <StatusPill tone={s.tone} label={s.value} />
                  </div>
                </div>
              ))}
            </div>

            <div
              role="presentation"
              className="mt-5 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold text-[#2563EB] select-none"
            >
              View full sample verification
              <ArrowRight size={12} />
            </div>
          </div>
        </div>

        <div>
          <InlineEyebrow>Related Outputs</InlineEyebrow>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {OUTPUTS.map((o) => {
              const Icon = o.icon;
              return (
                <div
                  key={o.title}
                  role="presentation"
                  aria-label="Sample record — not interactive"
                  className="relative flex flex-col overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white p-5 select-none"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background: `radial-gradient(circle at 92% 0%, ${o.halo}, transparent 55%)`,
                    }}
                  />
                  <span
                    className="relative flex h-11 w-11 items-center justify-center rounded-xl border"
                    style={{
                      background: o.chipBg,
                      borderColor: o.chipBorder,
                      color: o.chipText,
                    }}
                  >
                    <Icon size={22} />
                  </span>
                  <div className="relative mt-4 text-[13.5px] font-semibold text-[#0F172A]">
                    {o.title}
                  </div>
                  <p className="relative mt-1.5 flex-1 text-[12px] leading-[1.55] text-[#475569]">
                    {o.body}
                  </p>
                  <span
                    className="relative mt-4 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold"
                    style={{ color: o.ctaText }}
                  >
                    {o.cta}
                    <ArrowRight size={12} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
