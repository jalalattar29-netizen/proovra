import Link from "next/link";
import { ArrowRight } from "lucide-react";

export type PageHeroProps = {
  eyebrow: string;
  eyebrowColor?: string;
  title: string;
  highlight?: string;
  description: string;
  primaryCta?: { label: string; href: string };
  secondaryCta?: { label: string; href: string };
  align?: "center" | "left";
};

export function PageHero({
  eyebrow,
  eyebrowColor = "#2563EB",
  title,
  highlight,
  description,
  primaryCta,
  secondaryCta,
  align = "left",
}: PageHeroProps) {
  return (
    <section className="relative overflow-hidden bg-[var(--proovra-surface)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-20 h-[420px]"
        style={{
          background:
            "radial-gradient(60% 70% at 50% 0%, rgba(124,58,237,0.08) 0%, rgba(37,99,235,0.06) 35%, transparent 70%)",
        }}
      />
      <div
        className={`relative mx-auto max-w-[1480px] px-5 md:px-7 pb-16 pt-28 lg:px-10 2xl:px-12 lg:pb-20 lg:pt-32 ${
          align === "center" ? "text-center" : ""
        }`}
      >
        <span
          className={`inline-flex items-center gap-2 rounded-full bg-[#F1F5F9] px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.18em] ${
            align === "center" ? "mx-auto" : ""
          }`}
          style={{ color: eyebrowColor }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: eyebrowColor }} />
          {eyebrow}
        </span>
        <h1
          className={`mt-5 text-[36px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] sm:text-[44px] lg:text-[56px] ${
            align === "center" ? "mx-auto max-w-3xl" : "max-w-3xl"
          }`}
        >
          {title}
          {highlight ? (
            <>
              {" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, #F97316 0%, #EC4899 50%, #7C3AED 100%)",
                }}
              >
                {highlight}
              </span>
            </>
          ) : null}
        </h1>
        <p
          className={`mt-5 text-[17px] leading-[1.6] text-[#475569] lg:text-[18px] ${
            align === "center" ? "mx-auto max-w-2xl" : "max-w-2xl"
          }`}
        >
          {description}
        </p>
        {(primaryCta || secondaryCta) && (
          <div
            className={`mt-7 flex flex-col gap-3 sm:flex-row ${
              align === "center" ? "justify-center" : ""
            }`}
          >
            {primaryCta && (
              <Link
                href={primaryCta.href}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#0B1F5E] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_30px_rgba(11,31,94,0.28)] transition-all hover:bg-[#0a1c54]"
              >
                {primaryCta.label}
                <ArrowRight size={16} />
              </Link>
            )}
            {secondaryCta && (
              <Link
                href={secondaryCta.href}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-6 py-3.5 text-[15px] font-semibold text-[#0F172A] hover:border-[var(--proovra-border-warm-hover)]"
              >
                {secondaryCta.label}
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
