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
    <section className="relative bg-[var(--proovra-page-bg)]">
      <div className="mx-auto max-w-[1040px] px-5 py-16 md:px-7 lg:py-24">
        {/* Centered section header (eyebrow + heading + optional description) */}
        <div className="mx-auto max-w-[900px] text-center">
          {eyebrow ? (
            <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.22em] text-[#7C3AED]">
              {eyebrow}
            </span>
          ) : null}
          <h2 className="mt-3 text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[34px] lg:text-[40px]">
            {title}
          </h2>
          {description ? (
            <p className="mx-auto mt-3 max-w-[760px] text-[16px] leading-[1.6] text-[#475569]">
              {description}
            </p>
          ) : null}
        </div>

        <div className="mt-10 overflow-hidden rounded-[24px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)]">
          {items.map((item, idx) => {
            const open = openIdx === idx;
            return (
              <div
                key={item.q}
                className={`border-b border-[var(--proovra-border-warm)] last:border-b-0 ${
                  open ? "bg-[var(--proovra-surface-soft)]" : "bg-[var(--proovra-surface)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : idx)}
                  className="flex w-full items-center justify-between gap-6 px-6 py-5 text-left transition-colors hover:bg-[var(--proovra-page-bg-soft)] md:px-8 md:py-6"
                  aria-expanded={open}
                >
                  <span className="flex-1 text-left text-[15.5px] font-semibold leading-snug text-[#0F172A]">
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
                  <div className="px-6 pb-7 text-[14px] leading-[1.7] text-[#475569] md:px-8">
                    <p className="max-w-[900px] text-left">{item.a}</p>
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
