import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";

export type PageCTAProps = {
  eyebrow?: string;
  title: string;
  highlight?: string;
  body?: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
};

export function PageCTA({
  eyebrow = "Enterprise digital evidence",
  title,
  highlight,
  body = "Talk to a PROOVRA expert about how verification, reporting, and trusted evidence workflows fit your operations.",
  primary,
  secondary,
}: PageCTAProps) {
  return (
    <section className="relative bg-[var(--proovra-page-bg)]">
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 pb-20 lg:px-10 2xl:px-12 lg:pb-28">
        <div
          className="relative overflow-hidden rounded-[28px] px-8 py-12 shadow-[0_24px_60px_rgba(11,31,94,0.30)] md:px-14 md:py-16"
          style={{
            background: "linear-gradient(135deg, #0B1F5E 0%, #1E1B4B 50%, #2E1065 100%)",
            color: "#FFFFFF",
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full opacity-50 blur-3xl"
            style={{ background: "radial-gradient(closest-side, rgba(124,58,237,0.55), transparent 70%)" }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(closest-side, rgba(6,182,212,0.50), transparent 70%)" }}
          />
          <div className="relative grid grid-cols-1 items-center gap-8 md:grid-cols-[1.5fr_1fr]">
            <div className="flex flex-col gap-5">
              <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-white/85">
                <ShieldCheck size={13} />
                {eyebrow}
              </span>
              <h2
                className="text-[26px] font-extrabold leading-[1.1] tracking-[-0.02em] md:text-[32px] lg:text-[36px]"
                style={{ color: "#FFFFFF" }}
              >
                {title}
                {highlight ? (
                  <>
                    {" "}
                    <span className="text-[#C4B5FD]">{highlight}</span>
                  </>
                ) : null}
              </h2>
              <p className="max-w-md text-[15px] leading-[1.65] text-white/80">{body}</p>
            </div>
            <div className="flex flex-col gap-3 md:items-end">
              <Link
                href={primary.href}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[var(--proovra-surface)] px-6 py-3.5 text-[15px] font-semibold text-[#0B1F5E] shadow-[0_12px_28px_rgba(15,23,42,0.30)] transition-all hover:bg-[var(--proovra-page-bg-soft)]"
              >
                {primary.label}
                <ArrowRight size={16} />
              </Link>
              {secondary ? (
                <Link
                  href={secondary.href}
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-white/20 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white transition-all hover:bg-white/10"
                >
                  {secondary.label}
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
