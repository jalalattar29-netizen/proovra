import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { MARKETING_LINKS } from "./tokens";

export function FinalCTA() {
  return (
    <section
      className="relative bg-white"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 pb-20 lg:px-10 2xl:px-12 lg:pb-30">
        <div
          className="relative overflow-hidden rounded-[28px] px-8 py-12 text-white shadow-[0_24px_60px_rgba(11,31,94,0.30)] md:px-14 md:py-16"
          style={{
            background:
              "linear-gradient(135deg, #0B1F5E 0%, #1E1B4B 50%, #2E1065 100%)",
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full opacity-50 blur-3xl"
            style={{
              background:
                "radial-gradient(closest-side, rgba(124,58,237,0.55), transparent 70%)",
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full opacity-40 blur-3xl"
            style={{
              background:
                "radial-gradient(closest-side, rgba(6,182,212,0.50), transparent 70%)",
            }}
          />

          <div className="relative grid grid-cols-1 items-center gap-8 md:grid-cols-[1.5fr_1fr]">
            <div className="flex flex-col gap-5">
              <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-white/85">
                <ShieldCheck size={13} />
                Enterprise digital evidence
              </span>
              <h2
                className="text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-white md:text-[34px] lg:text-[40px]"
                style={{ color: "#FFFFFF" }}
              >
                Ready to transform your{" "}
                <span className="text-[#C4B5FD]">evidence operations?</span>
              </h2>
              <p className="max-w-md text-[15.5px] leading-[1.65] text-white/80">
                Book a personalized walkthrough and see how PROOVRA supports
                verification, reporting, and trusted evidence workflows.
              </p>
            </div>
            <div className="flex flex-col gap-3 md:items-end">
              <Link
                href={MARKETING_LINKS.requestDemo}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-3.5 text-[15px] font-semibold text-[#0B1F5E] shadow-[0_12px_28px_rgba(15,23,42,0.30)] transition-all hover:bg-[#F8FAFC]"
              >
                Request a demo
                <ArrowRight size={16} />
              </Link>
              <Link
                href={MARKETING_LINKS.contactSales}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white transition-all hover:bg-white/10"
              >
                Contact sales
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
