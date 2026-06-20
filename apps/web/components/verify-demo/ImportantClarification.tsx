"use client";

import { CheckCircle2 as PCheckCircle, X, XCircle as PXCircle } from "lucide-react";
import { SectionEyebrow, SectionTitle } from "./_shared";

const VERIFIES = [
  "Recorded integrity state",
  "Timestamp context",
  "Custody metadata",
  "Storage-protection indicators",
  "Supporting review materials",
];

const DOES_NOT_ESTABLISH = [
  "Truth of content",
  "Legal admissibility",
  "Authorship",
  "Evidentiary weight",
  "Identity of persons",
];

export function ImportantClarification() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Important clarification</SectionEyebrow>
        <SectionTitle>
          What verification does — and does not — establish.
        </SectionTitle>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <div className="relative overflow-hidden rounded-[22px] border border-[#E2E8F0] bg-white p-7 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 90% 8%, rgba(22,163,74,0.07), transparent 55%)",
              }}
            />
            <div className="relative flex items-center gap-3 text-[16px] font-bold text-[#15803D]">
              <PCheckCircle size={26} />
              PROOVRA verifies:
            </div>
            <ul className="relative mt-5 grid gap-3 pl-7">
              {VERIFIES.map((i) => (
                <li
                  key={i}
                  className="flex list-none items-start gap-2.5 text-[14.5px] leading-[1.6] text-[#0F172A]"
                >
                  <PCheckCircle
                    size={18}
                    className="mt-[2px] shrink-0 text-[#16A34A]"
                  />
                  {i}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative overflow-hidden rounded-[22px] border border-[#FECDD3] bg-[#FFF1F2] p-7 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 90% 8%, rgba(190,18,60,0.06), transparent 55%)",
              }}
            />
            <div className="relative flex items-center gap-3 text-[16px] font-bold text-[#BE123C]">
              <PXCircle size={26} />
              PROOVRA does not independently establish:
            </div>
            <ul className="relative mt-5 grid grid-cols-1 gap-3 pl-7 sm:grid-cols-2">
              {DOES_NOT_ESTABLISH.map((i) => (
                <li
                  key={i}
                  className="flex list-none items-start gap-2.5 text-[14.5px] leading-[1.6] text-[#0F172A]"
                >
                  <X
                    size={17}
                    className="mt-[2px] shrink-0 text-[#BE123C]"
                    strokeWidth={3}
                  />
                  {i}
                </li>
              ))}
            </ul>
            <p className="relative mt-6 text-[13.5px] leading-[1.65] text-[#475569]">
              These determinations remain subject to legal, judicial,
              administrative, or expert assessment.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
