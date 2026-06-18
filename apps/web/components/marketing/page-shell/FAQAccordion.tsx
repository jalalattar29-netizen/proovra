"use client";

import { useState } from "react";
import { Plus, Minus } from "lucide-react";

export type FAQItem = { q: string; a: string };

export type FAQAccordionProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  items: FAQItem[];
};

export function FAQAccordion({ eyebrow, title, description, items }: FAQAccordionProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <section className="relative bg-white">
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

        <div className="mt-10 overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-white">
          {items.map((item, idx) => {
            const open = openIdx === idx;
            return (
              <div
                key={item.q}
                className={`border-b border-[#EEF1F5] last:border-b-0 ${
                  open ? "bg-[#FAFBFD]" : "bg-white"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : idx)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left transition-colors hover:bg-[#F8FAFC]"
                  aria-expanded={open}
                >
                  <span className="text-[15.5px] font-semibold text-[#0F172A]">
                    {item.q}
                  </span>
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors ${
                      open
                        ? "bg-[#0B1F5E] text-white"
                        : "bg-[#F1F5F9] text-[#475569]"
                    }`}
                  >
                    {open ? <Minus size={14} /> : <Plus size={14} />}
                  </span>
                </button>
                {open ? (
                  <div className="px-5 pb-5 text-[14px] leading-[1.7] text-[#475569]">
                    {item.a}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
