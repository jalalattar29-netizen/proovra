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
          className="relative overflow-hidden rounded-[24px] p-7 shadow-[0_20px_44px_rgba(15,23,42,0.10)] md:p-9"
          style={{
            background:
              "linear-gradient(135deg,#1F8E8E 0%,#64717A 48%,#D83A3A 100%)",
            border: "1px solid rgba(255,255,255,0.10)",
            color: "#FFFFFF",
          }}
        >
          {/* Subtle tone-down layer so the gradient feels calm rather than neon — matches the Request Demo BottomCTA treatment. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at 70% 110%, rgba(15,23,42,0.18), transparent 55%)",
              mixBlendMode: "soft-light",
            }}
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
                    <span style={{ color: "#FFFFFF" }}>{highlight}</span>
                  </>
                ) : null}
              </h2>
              <p className="max-w-md text-[15px] leading-[1.65] text-white/80">{body}</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap md:flex-col md:items-end">
              <Link
                href={primary.href}
                className="inline-flex h-12 min-w-[160px] items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[var(--proovra-surface)] px-6 text-sm font-semibold text-[#0B1F5E] shadow-[0_12px_28px_rgba(15,23,42,0.30)] transition-all hover:bg-[var(--proovra-page-bg-soft)]"
              >
                {primary.label}
                <ArrowRight size={16} />
              </Link>
              {secondary ? (
                <Link
                  href={secondary.href}
                  className="inline-flex h-12 min-w-[160px] items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white/20 bg-white/5 px-6 text-sm font-semibold text-white transition-all hover:bg-white/10"
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
