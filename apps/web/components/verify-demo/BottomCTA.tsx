"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SALES_ASSETS } from "../../lib/sales-assets";

export function BottomCTA() {
  return (
    <section className="bg-[var(--proovra-page-bg)] pb-12 md:pb-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div
          className="overflow-hidden rounded-[20px] p-6 text-white shadow-[0_24px_60px_rgba(8,26,61,0.22)] md:p-7"
          style={{
            background:
              "linear-gradient(115deg,#4C0D7A 0%,#7B1FA2 25%,#E6007A 55%,#B517FF 82%,#7C3AED 100%)",
          }}
        >
          <div className="grid items-center gap-5 md:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="text-[1.05rem] font-semibold tracking-[-0.01em] md:text-[1.18rem]">
                Want a guided walkthrough?
              </div>
              <p className="mt-1.5 max-w-[480px] text-[13.5px] leading-[1.55] text-white/80">
                Request a personalized demo and see how PROOVRA fits your review
                workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[13.5px] font-semibold text-[#081A3D] shadow-[0_8px_18px_rgba(15,23,42,0.18)] transition hover:translate-y-[-1px]"
              >
                Request a demo
                <ArrowRight size={14} />
              </Link>
              <Link
                href={SALES_ASSETS.contactSalesUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-white/30 bg-white/10 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/20"
              >
                Talk to sales
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
