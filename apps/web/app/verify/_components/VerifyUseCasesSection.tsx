"use client";

import {
  Scale,
  ShieldCheck,
  FileText,
  Search,
  Users,
  Briefcase,
} from "lucide-react";
import { SectionEyebrow, SECTION_BORDER, SECTION_INK, SECTION_MUTED } from "./shared";

const CARDS = [
  {
    Icon: Scale,
    title: "Legal review",
    body: "Inspect verification context during matter assessment or external disclosure.",
    color: "#2563EB",
  },
  {
    Icon: ShieldCheck,
    title: "Compliance review",
    body: "Walk through recorded materials when audit or governance inquiries arise.",
    color: "#10A37F",
  },
  {
    Icon: FileText,
    title: "Claims review",
    body: "Examine evidence in insurance, warranty, or liability assessment workflows.",
    color: "#F97316",
  },
  {
    Icon: Search,
    title: "Internal investigations",
    body: "Use the read-only view during internal escalation or post-incident handling.",
    color: "#7C3AED",
  },
  {
    Icon: Users,
    title: "External disclosure",
    body: "Share a reviewer-facing record without granting account access.",
    color: "#DB2777",
  },
  {
    Icon: Briefcase,
    title: "Technical verification",
    body: "Inspect hashes, signatures, and verification materials independently.",
    color: "#2563EB",
  },
];

export function VerifyUseCasesSection() {
  return (
    <section className="bg-[#F7FAFC] py-16 md:py-20">
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionEyebrow color="#10A37F">For reviewers and organizations</SectionEyebrow>
          <h2
            className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.2rem]"
            style={{ color: SECTION_INK }}
          >
            Built for review across functions.
          </h2>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => (
            <article
              key={c.title}
              className="rounded-[16px] border bg-white p-5"
              style={{
                borderColor: SECTION_BORDER,
                boxShadow: "0 8px 22px rgba(15,23,42,0.05)",
              }}
            >
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                style={{ background: `${c.color}14`, border: `1px solid ${c.color}3D` }}
              >
                <c.Icon size={18} style={{ color: c.color }} strokeWidth={2} />
              </span>
              <h3
                className="mt-4 text-[15px] font-semibold tracking-[-0.005em]"
                style={{ color: SECTION_INK }}
              >
                {c.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: SECTION_MUTED }}>
                {c.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
