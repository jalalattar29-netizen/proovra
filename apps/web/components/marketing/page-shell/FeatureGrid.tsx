import type { LucideIcon } from "lucide-react";

export type FeatureItem = {
  title: string;
  body: string;
  Icon: LucideIcon;
  accent?: string;
};

export type FeatureGridProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  items: FeatureItem[];
  surface?: "white" | "soft";
  columns?: 2 | 3 | 4;
};

export function FeatureGrid({
  eyebrow,
  title,
  description,
  items,
  surface = "white",
  columns = 3,
}: FeatureGridProps) {
  const gridCols =
    columns === 2
      ? "sm:grid-cols-2"
      : columns === 4
        ? "sm:grid-cols-2 lg:grid-cols-4"
        : "sm:grid-cols-2 lg:grid-cols-3";

  return (
    <section className={`relative ${surface === "soft" ? "bg-[#F8FAFC]" : "bg-white"}`}>
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-16 lg:px-10 2xl:px-12 lg:py-24">
        {eyebrow ? (
          <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.22em] text-[#7C3AED]">
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

        <div className={`mt-10 grid grid-cols-1 gap-5 ${gridCols}`}>
          {items.map(({ title: itemTitle, body, Icon, accent = "#2563EB" }) => (
            <div
              key={itemTitle}
              className="flex flex-col gap-3 rounded-[20px] border border-[#E5E7EB] bg-white p-5 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:border-[#CBD5E1] hover:shadow-[0_14px_32px_rgba(15,23,42,0.06)]"
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-2xl"
                style={{ background: `${accent}14` }}
              >
                <Icon size={20} style={{ color: accent }} />
              </span>
              <h3 className="text-[16px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                {itemTitle}
              </h3>
              <p className="text-[13.5px] leading-[1.6] text-[#475569]">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
