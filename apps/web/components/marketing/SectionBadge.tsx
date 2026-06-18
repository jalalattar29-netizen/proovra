import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

/**
 * Single source of truth for marketing section eyebrow labels. Visual
 * style mirrors the hero badge exactly — every section that opens with a
 * short uppercase label should render it through this component so the
 * marketing site keeps one consistent label shape.
 */
export function SectionBadge({ children }: Props) {
  return (
    <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
      {children}
    </span>
  );
}
