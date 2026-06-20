"use client";

import { FileText, Lock } from "lucide-react";
import { PlatformDashboardShowcase } from "../marketing/PlatformDashboardShowcase";
import { SALES_ASSETS } from "../../lib/sales-assets";
import { HeroChip } from "./_shared";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            "url('/assets/backgrounds/proovra-page-hero-bg.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "100% 100%",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(255,255,255,0.42) 52%, rgba(255,255,255,0.22) 100%)",
        }}
      />

      <div className="relative mx-auto grid max-w-[1320px] gap-10 px-6 pb-16 pt-20 md:px-8 md:pb-20 md:pt-24 lg:grid-cols-[46fr_54fr] lg:items-center lg:pb-24 lg:pt-28">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            Verification Demo
          </div>

          <h1 className="mt-5 text-[2.1rem] font-semibold leading-[1.05] tracking-[-0.03em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
            See a verification record{" "}
            <span className="bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
              in action.
            </span>
          </h1>

          <p className="mt-5 max-w-[560px] text-[0.96rem] leading-[1.7] text-[#475569]">
            Explore a real verification record to see how PROOVRA presents
            integrity signals, timestamps, custody history, access activity,
            and supporting review materials.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {[
              "Integrity Signals",
              "Custody Timeline",
              "TSA & OpenTimestamp",
              "Reviewer Context",
              "Report Output",
            ].map((c) => (
              <HeroChip key={c} label={c} />
            ))}
          </div>

          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href={SALES_ASSETS.sampleReportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-6 text-[14px] font-semibold text-[#0F172A] transition hover:border-[#CBD5E1]"
            >
              View sample report
              <FileText size={14} />
            </a>
          </div>

          <p className="mt-5 inline-flex items-center gap-2 text-[12px] text-[#64748B]">
            <Lock size={13} />
            This is a read-only demo. No data is modified.
          </p>
        </div>

        <div className="relative flex justify-center lg:justify-end">
          <div className="relative w-full max-w-[960px]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-6 rounded-[36px]"
              style={{
                background:
                  "radial-gradient(circle at 50% 50%, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0.04) 35%, transparent 70%)",
                filter: "blur(10px)",
              }}
            />
            <span className="absolute -top-3 right-5 z-10 inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-white px-3 py-1 text-[12px] font-semibold text-[#0F172A] shadow-[0_4px_12px_rgba(15,23,42,0.06)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A]" />
              Live Platform View
            </span>
            <PlatformDashboardShowcase />
          </div>
        </div>
      </div>
    </section>
  );
}
