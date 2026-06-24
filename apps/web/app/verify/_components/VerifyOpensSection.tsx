"use client";

import {
  Fingerprint,
  Link2,
  Clock3,
  FileText,
  Lock,
  Database,
} from "lucide-react";
import { SectionEyebrow, SECTION_BORDER, SECTION_INK, SECTION_MUTED } from "./shared";

const CARDS = [
  {
    Icon: Fingerprint,
    title: "Integrity state",
    body: "Review whether the inspected record matches the recorded fingerprint and integrity materials.",
    color: "#2563EB",
  },
  {
    Icon: Link2,
    title: "Custody context",
    body: "Inspect custody events, access activity, review activity, and handling context where available.",
    color: "#7C3AED",
  },
  {
    Icon: Clock3,
    title: "Timing context",
    body: "Review timestamp, OpenTimestamps, or anchoring context where enabled and recorded.",
    color: "#DB2777",
  },
  {
    Icon: FileText,
    title: "Review materials",
    body: "Open reviewer-facing reports, verification summaries, and supporting materials where shared.",
    color: "#10A37F",
  },
  {
    Icon: Lock,
    title: "Access boundaries",
    body: "See only the materials made available through the public verification route.",
    color: "#F97316",
  },
  {
    Icon: Database,
    title: "Technical details",
    body: "Inspect hashes, signatures, metadata, storage-protection indicators, and verification status where available.",
    color: "#2563EB",
  },
];

export function VerifyOpensSection() {
  return (
    <section className="bg-[#F7FAFC] py-16 md:py-20">
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionEyebrow>What it opens</SectionEyebrow>
          <h2
            className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.2rem]"
            style={{ color: SECTION_INK }}
          >
            What Public Verify opens.
          </h2>
          <p
            className="mt-3 max-w-[680px] text-[15px] leading-[1.7]"
            style={{ color: SECTION_MUTED }}
          >
            A reviewer-facing read of the recorded evidence record. Public
            Verify exposes the materials shared on that record — nothing more.
          </p>
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
