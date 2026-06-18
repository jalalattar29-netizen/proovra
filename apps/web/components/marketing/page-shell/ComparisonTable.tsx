import { Check, X } from "lucide-react";

export type ComparisonRow = {
  feature: string;
  left: string | boolean;
  right: string | boolean;
};

export type ComparisonTableProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  leftHeader: string;
  rightHeader: string;
  rows: ComparisonRow[];
};

export function ComparisonTable({
  eyebrow,
  title,
  description,
  leftHeader,
  rightHeader,
  rows,
}: ComparisonTableProps) {
  return (
    <section className="relative bg-[#F8FAFC]">
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-16 lg:px-10 2xl:px-12 lg:py-24">
        {eyebrow ? (
          <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.22em] text-[#2563EB]">
            {eyebrow}
          </span>
        ) : null}
        <h2 className="mt-3 max-w-3xl text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[34px] lg:text-[40px]">
          {title}
        </h2>
        {description ? (
          <p className="mt-3 max-w-2xl text-[16px] leading-[1.6] text-[#475569]">
            {description}
          </p>
        ) : null}

        <div className="mt-10 overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <div className="grid grid-cols-[1.5fr_1fr_1fr] gap-0 border-b border-[#E5E7EB] bg-[#F8FAFC]">
            <div className="px-5 py-4 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-[#475569]">
              Feature
            </div>
            <div className="px-5 py-4 text-[13.5px] font-bold text-[#0F172A]">
              {leftHeader}
            </div>
            <div
              className="px-5 py-4 text-[13.5px] font-bold"
              style={{ color: "#0B1F5E" }}
            >
              {rightHeader}
            </div>
          </div>
          {rows.map((row, idx) => (
            <div
              key={row.feature}
              className={`grid grid-cols-[1.5fr_1fr_1fr] gap-0 ${
                idx % 2 === 1 ? "bg-[#FAFBFD]" : "bg-white"
              }`}
            >
              <div className="border-b border-[#EEF1F5] px-5 py-4 text-[13.5px] font-semibold text-[#0F172A]">
                {row.feature}
              </div>
              <div className="flex items-start border-b border-[#EEF1F5] px-5 py-4 text-[13.5px] text-[#475569]">
                {typeof row.left === "boolean" ? (
                  row.left ? (
                    <Check size={16} className="text-[#10B981]" />
                  ) : (
                    <X size={16} className="text-[#94A3B8]" />
                  )
                ) : (
                  row.left
                )}
              </div>
              <div className="flex items-start border-b border-[#EEF1F5] px-5 py-4 text-[13.5px] text-[#0F172A]">
                {typeof row.right === "boolean" ? (
                  row.right ? (
                    <Check size={16} className="text-[#10B981]" />
                  ) : (
                    <X size={16} className="text-[#94A3B8]" />
                  )
                ) : (
                  row.right
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
