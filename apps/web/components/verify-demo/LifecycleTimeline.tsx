"use client";

import {
  Camera,
  Clock3,
  Eye,
  FileText,
  Fingerprint,
  PenLine,
  Stamp,
  type LucideIcon,
} from "lucide-react";
import { SectionEyebrow, SectionTitle } from "./_shared";

const STAGES: { label: string; body: string; icon: LucideIcon; color: string }[] = [
  { label: "Capture", body: "Evidence is captured and a secure record is created.", icon: Camera, color: "#F97316" },
  { label: "Hash Generated", body: "A cryptographic hash represents the file.", icon: Fingerprint, color: "#7C3AED" },
  { label: "TSA Recorded", body: "The record is timestamped by trusted time sources.", icon: Clock3, color: "#06B6D4" },
  { label: "Signature Applied", body: "Digital signatures bind the record and metadata.", icon: PenLine, color: "#3B82F6" },
  { label: "Review Activity", body: "Reviewers access and interact with the record.", icon: Eye, color: "#14B8A6" },
  { label: "Verification Opened", body: "The record is opened for verification using a token.", icon: Stamp, color: "#EC4899" },
  { label: "Report Generated", body: "A reviewer-ready report is generated for inspection.", icon: FileText, color: "#06B6D4" },
];

export function LifecycleTimeline() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Record lifecycle timeline</SectionEyebrow>
        <SectionTitle>From capture to reviewer-ready.</SectionTitle>

        <div className="relative mt-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-7 hidden border-t border-dashed border-[#E2E8F0] lg:block"
          />
          <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7 lg:gap-4">
            {STAGES.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="relative flex flex-col items-center text-center">
                  <span
                    className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-[#E2E8F0]"
                    style={{ background: s.color }}
                  >
                    <Icon size={22} strokeWidth={2.2} />
                  </span>
                  <div className="mt-4 text-[13px] font-semibold text-[#0F172A]">
                    {i + 1}. {s.label}
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-[1.5] text-[#475569]">
                    {s.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
