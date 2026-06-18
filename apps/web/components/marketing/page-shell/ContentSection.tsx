import type { ReactNode } from "react";

export type ContentSectionProps = {
  eyebrow?: string;
  eyebrowColor?: string;
  title?: string;
  description?: string;
  surface?: "white" | "soft";
  children?: ReactNode;
};

export function ContentSection({
  eyebrow,
  eyebrowColor = "#2563EB",
  title,
  description,
  surface = "white",
  children,
}: ContentSectionProps) {
  return (
    <section
      className={`relative ${surface === "soft" ? "bg-[#F8FAFC]" : "bg-white"}`}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-16 lg:px-10 2xl:px-12 lg:py-24">
        {eyebrow ? (
          <span
            className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.22em]"
            style={{ color: eyebrowColor }}
          >
            {eyebrow}
          </span>
        ) : null}
        {title ? (
          <h2 className="mt-3 max-w-3xl text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[34px] lg:text-[40px]">
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="mt-3 max-w-2xl text-[16px] leading-[1.6] text-[#475569]">
            {description}
          </p>
        ) : null}
        {children ? <div className="mt-10">{children}</div> : null}
      </div>
    </section>
  );
}
