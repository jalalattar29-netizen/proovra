"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2 as PCheckCircle,
  Eye as PEye,
  FileText as PFileText,
  Fingerprint as PFingerprint,
  GitBranch as PGitBranch,
  History as PClock,
  PenTool as PPenNib,
} from "lucide-react";
import {
  DEMO_RECORD,
  SectionEyebrow,
  SectionTitle,
  StatusPill,
} from "./_shared";

type PhosphorIcon = typeof PFingerprint;

const CARDS: { icon: PhosphorIcon; title: string; preview: ReactNode; body: string }[] = [
  {
    icon: PFingerprint,
    title: "Integrity Overview",
    preview: (
      <div className="space-y-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          File Integrity
        </div>
        <div className="text-[12px] font-medium text-[#475569]">SHA-256</div>
        <div className="font-mono text-[11.5px] text-[#0F172A] break-all">
          {DEMO_RECORD.hash}
        </div>
        <div className="pt-1">
          <StatusPill tone="valid" label="Valid" />
        </div>
      </div>
    ),
    body: "Review recorded file state, hash values, and verification results.",
  },
  {
    icon: PPenNib,
    title: "Signature Review",
    preview: (
      <div className="space-y-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          Digital Signature
        </div>
        <div className="text-[12px] text-[#475569]">Signer</div>
        <div className="text-[13px] font-semibold text-[#0F172A]">
          {DEMO_RECORD.signer}
        </div>
        <div className="pt-1 text-[12px] text-[#475569]">Status</div>
        <StatusPill tone="valid" label="Valid" />
      </div>
    ),
    body: "Inspect digital signatures and validate the trust chain.",
  },
  {
    icon: PClock,
    title: "Timestamp Validation",
    preview: (
      <div className="space-y-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          TSA Timestamp
        </div>
        <div className="text-[13px] font-semibold text-[#0F172A]">
          {DEMO_RECORD.tsaTime}
        </div>
        <div className="pt-1">
          <StatusPill tone="verified" label="Verified" />
        </div>
      </div>
    ),
    body: "Validate timestamps from trusted time authorities (TSA).",
  },
  {
    icon: PGitBranch,
    title: "Custody Timeline",
    preview: (
      <ul className="space-y-2 pl-0">
        {["Captured", "Accessed", "Reviewed", "Exported"].map((e) => (
          <li
            key={e}
            className="flex list-none items-center gap-2.5 text-[13px] text-[#0F172A]"
          >
            <PCheckCircle size={16} className="text-[#16A34A]" />
            {e}
          </li>
        ))}
      </ul>
    ),
    body: "See the complete lifecycle and custody events in order.",
  },
  {
    icon: PEye,
    title: "Access Activity",
    preview: (
      <div className="space-y-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          Access Activity
        </div>
        <div className="text-[12px] text-[#475569]">Reviewer</div>
        <div className="text-[13px] font-medium text-[#0F172A]">
          {DEMO_RECORD.reviewer}
        </div>
        <div className="pt-1 text-[12px] text-[#475569]">Action</div>
        <div className="text-[13px] font-medium text-[#0F172A]">
          {DEMO_RECORD.reviewerAction}
        </div>
        <div className="text-[11.5px] text-[#94A3B8]">
          {DEMO_RECORD.reviewerTime}
        </div>
      </div>
    ),
    body: "Review who accessed the evidence and what they did.",
  },
  {
    icon: PFileText,
    title: "Supporting Materials",
    preview: (
      <div className="space-y-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          Resources
        </div>
        <div className="text-[12px] text-[#475569]">Original File</div>
        <div className="text-[13px] font-medium text-[#0F172A]">
          {DEMO_RECORD.fileName}
        </div>
        <div className="pt-1 text-[12px] text-[#475569]">Size</div>
        <div className="text-[13px] font-medium text-[#0F172A]">
          {DEMO_RECORD.fileSize}
        </div>
      </div>
    ),
    body: "Access supporting files, metadata, and verification materials.",
  },
];

export function WhatReviewerSees() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>What a reviewer sees</SectionEyebrow>
        <SectionTitle>Comprehensive visibility into every signal.</SectionTitle>

        <div className="mx-auto mt-10 grid max-w-7xl gap-5 md:grid-cols-2 xl:grid-cols-3">
          {CARDS.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.title}
                className="relative flex flex-col overflow-hidden rounded-[22px] border border-[#E2E8F0] bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:border-[#CBD5E1]"
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(circle at 92% 0%, rgba(37,99,235,0.06), transparent 50%)",
                  }}
                />
                <div className="relative flex items-center gap-2.5">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFF6FF] text-[#2563EB]">
                    <Icon size={18} />
                  </span>
                  <span className="text-[14.5px] font-semibold text-[#0F172A]">
                    {c.title}
                  </span>
                </div>
                <div className="relative mt-4 flex-1 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                  {c.preview}
                </div>
                <p className="relative mt-4 text-[13px] leading-[1.6] text-[#475569]">
                  {c.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
