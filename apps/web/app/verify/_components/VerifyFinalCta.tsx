"use client";

import { ArrowRight } from "lucide-react";

export function VerifyFinalCta() {
  return (
    <section className="mx-auto max-w-[1320px] px-6 pb-16 pt-12 md:px-8 md:pb-20 md:pt-16">
      <div
        className="relative overflow-hidden rounded-[28px] p-8 text-white shadow-[0_32px_80px_rgba(6,20,46,0.40)] md:p-12"
        style={{
          background:
            "linear-gradient(120deg,#06142E 0%,#123B7A 35%,#2563EB 70%,#7C3AED 100%)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-[0.10]"
          style={{
            backgroundImage:
              "radial-gradient(circle, #FFFFFF 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(219,39,119,0.22) 0%, transparent 70%)",
          }}
        />

        <div className="relative grid items-center gap-8 md:grid-cols-[1fr_auto] md:gap-10">
          <div>
            <h2 className="text-[1.6rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[2rem]">
              Start reviewing a verification record.
            </h2>
            <p className="mt-3 max-w-[640px] text-[15px] leading-[1.7] text-white/85">
              Review a PROOVRA verification token online.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 md:flex-nowrap md:justify-end">
            <a
              href="#token-card"
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] bg-white px-6 text-[14px] font-semibold text-[#0B1E3A] shadow-[0_10px_24px_rgba(0,0,0,0.28)] transition hover:-translate-y-0.5"
            >
              Open Verification
              <ArrowRight size={14} />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
