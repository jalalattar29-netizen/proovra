"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Anchor,
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Eye,
  FileText,
  Fingerprint,
  Folder,
  Layers,
  Lock,
  PenLine,
  ScrollText,
  Share2,
  ShieldCheck,
  Stamp,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Archive as PArchive,
  CheckCircle as PCheckCircle,
  ClockCounterClockwise as PClock,
  Eye as PEye,
  FilePdf as PFilePdf,
  FileText as PFileText,
  Fingerprint as PFingerprint,
  GitBranch as PGitBranch,
  Package as PPackage,
  PenNib as PPenNib,
  SealCheck as PSealCheck,
  ShieldCheck as PShieldCheck,
  XCircle as PXCircle,
} from "@phosphor-icons/react";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";
import { SALES_ASSETS } from "../../../lib/sales-assets";

const DEMO_RECORD = {
  fileName: "Document_Contract.pdf",
  fileType: "PDF",
  fileSize: "2.4 MB",
  verificationId: "vf_9f7a2b3c",
  createdAt: "May 17, 2026 09:14:22 UTC",
  verifiedAt: "May 18, 2026 14:36:45 UTC",
  hash: "d2f0e7a3b6c4ec9b7102fa8d63c5...",
  signer: "Jane Doe",
  tsaTime: "May 17, 2026 09:15:22 UTC",
  reviewer: "alex@company.com",
  reviewerAction: "Viewed Overview",
  reviewerTime: "May 18, 2026 11:02 UTC",
  custodyEvents: 17,
};

const DEMO_VERIFY_URL = `${SALES_ASSETS.verificationDemoUrl}#example-record`;

type TabId =
  | "overview"
  | "integrity"
  | "signatures"
  | "timestamps"
  | "opentimestamp"
  | "custody"
  | "access"
  | "resources"
  | "reports";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: Layers },
  { id: "integrity", label: "Integrity", icon: ShieldCheck },
  { id: "signatures", label: "Signatures", icon: PenLine },
  { id: "timestamps", label: "Timestamps", icon: Clock3 },
  { id: "opentimestamp", label: "OpenTimestamp", icon: Anchor },
  { id: "custody", label: "Custody", icon: ScrollText },
  { id: "access", label: "Access Activity", icon: Eye },
  { id: "resources", label: "Resources", icon: Folder },
  { id: "reports", label: "Reports", icon: FileText },
];

type StatusTone = "valid" | "verified" | "published" | "consistent" | "protected";

function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  const colors: Record<StatusTone, { dot: string; text: string }> = {
    valid: { dot: "#16A34A", text: "#15803D" },
    verified: { dot: "#16A34A", text: "#15803D" },
    published: { dot: "#06B6D4", text: "#0891B2" },
    consistent: { dot: "#16A34A", text: "#15803D" },
    protected: { dot: "#16A34A", text: "#15803D" },
  };
  const c = colors[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[13px] font-semibold"
      style={{ color: c.text }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: c.dot }}
      />
      {label}
    </span>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        {children}
      </span>
    </div>
  );
}

function InlineEyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mx-auto mt-3 max-w-[760px] text-center text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[2rem]">
      {children}
    </h2>
  );
}

function ProductMockup() {
  return (
    <div className="relative w-full overflow-hidden rounded-[20px] border border-[#E2E8F0] bg-white shadow-[0_30px_70px_rgba(15,23,42,0.10)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#7C3AED] to-[#3B82F6] text-white">
            <ShieldCheck size={14} strokeWidth={2.6} />
          </div>
          <span className="text-[11px] font-bold tracking-[0.18em] text-[#0F172A]">
            PROOVRA
          </span>
        </div>
        <div className="hidden items-center gap-2 text-[11.5px] text-[#64748B] sm:flex">
          <ChevronRight size={12} />
          Demo Record
          <ChevronRight size={12} />
          <span className="text-[#0F172A]">{DEMO_RECORD.fileName}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[#475569]">
          <span className="hidden sm:inline">Verified on </span>
          {DEMO_RECORD.verifiedAt}
          <CheckCircle2 size={14} className="text-[#16A34A]" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr]">
        <nav className="hidden border-r border-[#E2E8F0] bg-[#F8FAFC] p-2 sm:block">
          <ul className="space-y-0.5">
            {TABS.map((tab, i) => {
              const Icon = tab.icon;
              const active = i === 0;
              return (
                <li key={tab.id}>
                  <div
                    className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] ${
                      active
                        ? "bg-white font-semibold text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                        : "text-[#475569]"
                    }`}
                  >
                    <Icon size={13} strokeWidth={2.2} />
                    {tab.label}
                  </div>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="p-5">
          <div className="flex items-baseline gap-2.5">
            <h3 className="text-[1.05rem] font-semibold text-[#0F172A]">
              {DEMO_RECORD.fileName}
            </h3>
            <span className="rounded-md bg-[#EEF2FF] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[#4338CA]">
              PDF
            </span>
            <span className="text-[11.5px] text-[#64748B]">
              {DEMO_RECORD.fileSize}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {[
              { title: "Integrity", value: "Valid", helper: "SHA-256", tone: "valid" as const },
              { title: "Signature", value: "Valid", helper: "Digital signature", tone: "valid" as const },
              { title: "TSA Timestamp", value: "Verified", helper: "Trusted time", tone: "verified" as const },
              { title: "OpenTimestamp", value: "Published", helper: "Blockchain anchored", tone: "published" as const },
              { title: "Custody", value: "Consistent", helper: `${DEMO_RECORD.custodyEvents} events`, tone: "consistent" as const },
              { title: "Storage Protection", value: "Protected", helper: "AES-256 · Encrypted", tone: "protected" as const },
            ].map((s) => (
              <div
                key={s.title}
                className="rounded-lg border border-[#E2E8F0] bg-white p-2.5"
              >
                <div className="text-[10.5px] font-medium text-[#64748B]">
                  {s.title}
                </div>
                <div className="mt-1">
                  <StatusPill tone={s.tone} label={s.value} />
                </div>
                <div className="mt-1 text-[10.5px] text-[#94A3B8]">
                  {s.helper}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <div className="text-[10.5px] font-semibold text-[#64748B]">
              Custody Timeline ({DEMO_RECORD.custodyEvents} events)
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {[
                { label: "Captured", time: "May 17, 09:14 UTC", icon: Camera, color: "#F97316" },
                { label: "Hash Generated", time: "May 17, 09:15 UTC", icon: Fingerprint, color: "#3B82F6" },
                { label: "TSA Recorded", time: "May 17, 09:15 UTC", icon: Clock3, color: "#06B6D4" },
                { label: "Signature Applied", time: "May 17, 09:16 UTC", icon: PenLine, color: "#7C3AED" },
                { label: "Access Reviewed", time: "May 18, 11:02 UTC", icon: Eye, color: "#14B8A6" },
                { label: "Report Generated", time: "May 18, 14:36 UTC", icon: FileText, color: "#EC4899" },
              ].map((step) => {
                const Icon = step.icon;
                return (
                  <div key={step.label} className="flex flex-col items-center text-center">
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full text-white"
                      style={{ background: step.color }}
                    >
                      <Icon size={13} strokeWidth={2.4} />
                    </span>
                    <div className="mt-1.5 text-[10px] font-semibold text-[#0F172A]">
                      {step.label}
                    </div>
                    <div className="text-[9.5px] text-[#94A3B8]">{step.time}</div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function HeroChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] font-medium text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <CheckCircle2 size={13} className="text-[#16A34A]" strokeWidth={2.6} />
      {label}
    </span>
  );
}

function HeroSection() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            "url('/assets/backgrounds/proovra-page-hero-bg.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "100% 100%",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(255,255,255,0.42) 52%, rgba(255,255,255,0.22) 100%)",
        }}
      />

      <div className="relative mx-auto grid max-w-7xl gap-10 px-6 pb-16 pt-20 md:px-8 md:pb-20 md:pt-24 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:pt-28">
        <div className="lg:pt-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            Verification Demo
          </div>

          <h1 className="mt-5 text-[2.1rem] font-semibold leading-[1.05] tracking-[-0.03em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
            See a verification record{" "}
            <span className="bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
              in action.
            </span>
          </h1>

          <p className="mt-5 max-w-[560px] text-[0.96rem] leading-[1.7] text-[#475569]">
            Explore a real verification record to see how PROOVRA presents
            integrity signals, timestamps, custody history, access activity,
            and supporting review materials.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {[
              "Integrity Signals",
              "Custody Timeline",
              "TSA & OpenTimestamp",
              "Reviewer Context",
              "Report Output",
            ].map((c) => (
              <HeroChip key={c} label={c} />
            ))}
          </div>

          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="#interactive-walkthrough"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#081A3D] px-6 text-[14px] font-semibold text-white shadow-[0_10px_24px_rgba(8,26,61,0.32)] transition hover:translate-y-[-1px]"
            >
              Explore demo record
              <ArrowRight size={15} />
            </Link>
            <a
              href={SALES_ASSETS.sampleReportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-6 text-[14px] font-semibold text-[#0F172A] transition hover:border-[#CBD5E1]"
            >
              View sample report
              <FileText size={14} />
            </a>
          </div>

          <p className="mt-5 inline-flex items-center gap-2 text-[12px] text-[#64748B]">
            <Lock size={13} />
            This is a read-only demo. No data is modified.
          </p>
        </div>

        <div className="relative">
          <ProductMockup />
        </div>
      </div>
    </section>
  );
}

function WhatReviewerSees() {
  type PhosphorIcon = typeof PFingerprint;
  const cards: {
    icon: PhosphorIcon;
    title: string;
    preview: ReactNode;
    body: string;
  }[] = [
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
              <PCheckCircle size={16} weight="fill" className="text-[#16A34A]" />
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

  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>What a reviewer sees</SectionEyebrow>
        <SectionTitle>Comprehensive visibility into every signal.</SectionTitle>

        <div className="mx-auto mt-10 grid max-w-7xl gap-5 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => {
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
                    <Icon size={18} weight="duotone" />
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

function OverviewPanel(_props: { onCopyLink: () => void }) {
  const summary: { label: string; value: string }[] = [
    { label: "File Name", value: DEMO_RECORD.fileName },
    { label: "File Size", value: DEMO_RECORD.fileSize },
    { label: "Created", value: DEMO_RECORD.createdAt },
    { label: "Verification ID", value: DEMO_RECORD.verificationId },
    { label: "Verified On", value: DEMO_RECORD.verifiedAt },
  ];
  const signals: { label: string; tone: StatusTone; value: string }[] = [
    { label: "Integrity State", tone: "valid", value: "Valid" },
    { label: "Signatures", tone: "valid", value: "Valid" },
    { label: "TSA Timestamp", tone: "verified", value: "Verified" },
    { label: "OpenTimestamp", tone: "published", value: "Published" },
    { label: "Custody", tone: "consistent", value: "Consistent" },
    { label: "Storage Protection", tone: "protected", value: "Protected" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Verification Summary
        </h4>
        <dl className="mt-3 divide-y divide-[#E2E8F0]">
          {summary.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <dt className="text-[12.5px] text-[#475569]">{r.label}</dt>
              <dd className="text-right text-[12.5px] font-medium text-[#0F172A]">
                {r.value}
              </dd>
            </div>
          ))}
          <div className="flex items-center justify-between py-2.5">
            <dt className="text-[12.5px] text-[#475569]">Status</dt>
            <dd>
              <StatusPill tone="verified" label="Verified" />
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Key Signals
        </h4>
        <dl className="mt-3 divide-y divide-[#E2E8F0]">
          {signals.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <dt className="text-[12.5px] text-[#475569]">{s.label}</dt>
              <dd className="flex items-center gap-1.5">
                <StatusPill tone={s.tone} label={s.value} />
                <ChevronRight size={12} className="text-[#94A3B8]" />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div
        className="rounded-2xl border border-[#E2E8F0] bg-white p-5"
        aria-label="Quick actions — demo only, not interactive"
      >
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Quick Actions
        </h4>
        <div className="mt-3 grid gap-2.5">
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg bg-[#081A3D] text-[12.5px] font-semibold text-white select-none"
          >
            <Download size={13} />
            Download sample report
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Download size={13} />
            Download evidence package
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Copy size={13} />
            Copy verification link
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Share2 size={13} />
            Share with reviewer
          </div>
        </div>
      </div>
    </div>
  );
}

function IntegrityPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Recorded Integrity State
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Cryptographic fingerprint captured at evidence intake. Compared on each
        verification request.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Algorithm", value: "SHA-256" },
          { label: "Digest", value: DEMO_RECORD.hash, mono: true },
          { label: "File Size", value: DEMO_RECORD.fileSize },
          { label: "Captured At", value: DEMO_RECORD.createdAt },
          { label: "Status", value: "Valid" },
          { label: "Last Check", value: DEMO_RECORD.verifiedAt },
        ].map((r) => (
          <div
            key={r.label}
            className="rounded-xl bg-[#F8FAFC] p-3"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div
              className={`mt-1 text-[12.5px] text-[#0F172A] ${
                r.mono ? "font-mono break-all" : "font-medium"
              }`}
            >
              {r.label === "Status" ? (
                <StatusPill tone="valid" label="Valid" />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SignaturesPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Digital Signature Review
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Signature materials, signer identity, and trust chain associated with
        the record.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Signer", value: DEMO_RECORD.signer },
          { label: "Algorithm", value: "RSA-PSS / SHA-256" },
          { label: "Signed At", value: DEMO_RECORD.tsaTime },
          { label: "Certificate Authority", value: "Demo CA · Org Trust" },
          { label: "Chain Status", value: "Trusted" },
          { label: "Verification Result", value: "Valid" },
        ].map((r) => (
          <div key={r.label} className="rounded-xl bg-[#F8FAFC] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div className="mt-1 text-[12.5px] font-medium text-[#0F172A]">
              {r.label === "Verification Result" ? (
                <StatusPill tone="valid" label={r.value} />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TimestampsPanel() {
  const events = [
    { source: "TSA · trusted-time-1.example", time: "May 17, 2026 09:15:22 UTC", status: "verified" as const },
    { source: "TSA · trusted-time-2.example", time: "May 17, 2026 09:15:24 UTC", status: "verified" as const },
    { source: "Internal sealing record", time: "May 17, 2026 09:15:28 UTC", status: "verified" as const },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        TSA Timestamp Evidence
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Timestamps issued by trusted RFC 3161 time authorities and matched at
        verification time.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Source
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Time
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.source} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] text-[#0F172A]">
                  {e.source}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {e.time}
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={e.status} label="Verified" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpenTimestampPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        OpenTimestamps Anchoring
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Public blockchain anchoring snapshot for independent timing context.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Status", value: "Published" },
          { label: "Calendars", value: "alice.btc.calendar.opentimestamps.org · finney.calendar.eternitywall.com" },
          { label: "Submitted", value: "May 17, 2026 09:16 UTC" },
          { label: "Confirmed Block Height", value: "841,927" },
          { label: "Network", value: "Bitcoin" },
          { label: "Result", value: "Anchored" },
        ].map((r) => (
          <div key={r.label} className="rounded-xl bg-[#F8FAFC] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div className="mt-1 text-[12.5px] font-medium text-[#0F172A]">
              {r.label === "Status" ? (
                <StatusPill tone="published" label={r.value} />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CustodyPanel() {
  const events = [
    { event: "Captured", actor: "intake.service", time: "May 17, 09:14 UTC" },
    { event: "Hash Generated", actor: "fingerprint.engine", time: "May 17, 09:15 UTC" },
    { event: "TSA Recorded", actor: "tsa.publisher", time: "May 17, 09:15 UTC" },
    { event: "Signature Applied", actor: DEMO_RECORD.signer, time: "May 17, 09:16 UTC" },
    { event: "Sealed", actor: "storage.attestation", time: "May 17, 09:16 UTC" },
    { event: "Reviewer Accessed", actor: DEMO_RECORD.reviewer, time: "May 18, 11:02 UTC" },
    { event: "Report Generated", actor: "reports.service", time: "May 18, 14:36 UTC" },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Custody Trail (sample of {DEMO_RECORD.custodyEvents} events)
      </h4>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Event
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Actor
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] font-medium text-[#0F172A]">
                  {e.event}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {e.actor}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {e.time}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccessPanel() {
  const rows = [
    { reviewer: "alex@company.com", action: "Viewed Overview", time: "May 18, 11:02 UTC" },
    { reviewer: "alex@company.com", action: "Opened Signatures tab", time: "May 18, 11:04 UTC" },
    { reviewer: "alex@company.com", action: "Downloaded sample report", time: "May 18, 11:08 UTC" },
    { reviewer: "review@firm.example", action: "Viewed Overview", time: "May 18, 13:21 UTC" },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Reviewer Access Log
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Access activity is recorded separately from forensic custody events.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Reviewer
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Action
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] text-[#0F172A]">
                  {r.reviewer}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {r.action}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {r.time}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourcesPanel() {
  const files: {
    name: string;
    type: string;
    size: string;
    role: string;
    icon: typeof PFilePdf;
  }[] = [
    { name: "Document_Contract.pdf", type: "PDF", size: "2.4 MB", role: "Original file", icon: PFilePdf },
    { name: "verification-package.zip", type: "ZIP", size: "3.1 MB", role: "Disclosure package", icon: PArchive },
    { name: "signature.p7s", type: "PKCS#7", size: "8 KB", role: "Signature blob", icon: PSealCheck },
    { name: "tsa-response.tsr", type: "TSR", size: "5 KB", role: "TSA response", icon: PClock },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Supporting Materials
      </h4>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {files.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.name}
              className="flex items-start gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] text-[#2563EB]">
                <Icon size={20} weight="duotone" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-[#0F172A]">
                  {f.name}
                </div>
                <div className="text-[11.5px] text-[#475569]">
                  {f.role} · {f.type} · {f.size}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Generated Reports
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Reviewer-facing report outputs for {DEMO_RECORD.fileName}.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {[
          {
            title: "Verification Report",
            body: "Reviewer-ready PDF summarizing integrity state, timestamps, custody, and access.",
            icon: PFileText,
            cta: "View PDF",
          },
          {
            title: "Verification Package",
            body: "Disclosure ZIP containing the original file, signature blob, TSA response, and audit trail.",
            icon: PPackage,
            cta: "View package",
          },
        ].map((r) => {
          const Icon = r.icon;
          return (
            <div
              key={r.title}
              role="presentation"
              aria-label="Demo only — not interactive"
              className="rounded-xl border border-[#E2E8F0] bg-white p-4 select-none"
            >
              <div className="flex items-center gap-2.5">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#2563EB]">
                  <Icon size={16} weight="duotone" />
                </span>
                <span className="text-[13px] font-semibold text-[#0F172A]">
                  {r.title}
                </span>
              </div>
              <p className="mt-2 text-[12px] leading-[1.55] text-[#475569]">
                {r.body}
              </p>
              <span className="mt-3 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold text-[#2563EB]">
                {r.cta}
                <ArrowRight size={12} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InteractiveWalkthrough({ onCopyLink }: { onCopyLink: () => void }) {
  const [active, setActive] = useState<TabId>("overview");

  return (
    <section
      id="interactive-walkthrough"
      className="bg-[#F8FAFC] py-16 md:py-20"
    >
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Interactive record walkthrough</SectionEyebrow>
        <SectionTitle>Explore a verification record step by step.</SectionTitle>

        <div className="mt-10 grid gap-4 lg:grid-cols-[220px_1fr]">
          <nav className="h-fit rounded-2xl border border-[#E2E8F0] bg-white p-2">
            <ul className="space-y-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === active;
                return (
                  <li key={tab.id}>
                    <button
                      type="button"
                      onClick={() => setActive(tab.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                        isActive
                          ? "bg-[#EFF6FF] font-semibold text-[#2563EB]"
                          : "text-[#475569] hover:bg-[#F8FAFC]"
                      }`}
                    >
                      <Icon
                        size={14}
                        strokeWidth={isActive ? 2.6 : 2.2}
                      />
                      {tab.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13.5px] font-semibold text-[#0F172A]">
                {TABS.find((t) => t.id === active)?.label}
              </div>
              <div className="text-[11.5px] text-[#64748B]">
                Demo record · {DEMO_RECORD.verificationId}
              </div>
            </div>

            {active === "overview" && <OverviewPanel onCopyLink={onCopyLink} />}
            {active === "integrity" && <IntegrityPanel />}
            {active === "signatures" && <SignaturesPanel />}
            {active === "timestamps" && <TimestampsPanel />}
            {active === "opentimestamp" && <OpenTimestampPanel />}
            {active === "custody" && <CustodyPanel />}
            {active === "access" && <AccessPanel />}
            {active === "resources" && <ResourcesPanel />}
            {active === "reports" && <ReportsPanel />}
          </div>
        </div>
      </div>
    </section>
  );
}

function LifecycleTimeline() {
  const stages: { label: string; body: string; icon: LucideIcon; color: string }[] = [
    { label: "Capture", body: "Evidence is captured and a secure record is created.", icon: Camera, color: "#F97316" },
    { label: "Hash Generated", body: "A cryptographic hash represents the file.", icon: Fingerprint, color: "#7C3AED" },
    { label: "TSA Recorded", body: "The record is timestamped by trusted time sources.", icon: Clock3, color: "#06B6D4" },
    { label: "Signature Applied", body: "Digital signatures bind the record and metadata.", icon: PenLine, color: "#3B82F6" },
    { label: "Review Activity", body: "Reviewers access and interact with the record.", icon: Eye, color: "#14B8A6" },
    { label: "Verification Opened", body: "The record is opened for verification using a token.", icon: Stamp, color: "#EC4899" },
    { label: "Report Generated", body: "A reviewer-ready report is generated for inspection.", icon: FileText, color: "#06B6D4" },
  ];
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
            {stages.map((s, i) => {
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

function ExampleRecordAndOutputs() {
  return (
    <section className="bg-[var(--proovra-page-bg)] py-16 md:py-20">
      <div className="mx-auto grid max-w-7xl gap-5 px-6 md:px-8 lg:grid-cols-2 lg:items-start">
        <div>
          <InlineEyebrow>Example Verification Record</InlineEyebrow>
          <div className="mt-5 rounded-2xl border border-[#E2E8F0] bg-white p-6">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-[1.1rem] font-semibold text-[#0F172A]">
              {DEMO_RECORD.fileName}
            </h3>
            <span className="rounded-md bg-[#EEF2FF] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[#4338CA]">
              PDF
            </span>
            <span className="text-[12px] text-[#64748B]">
              {DEMO_RECORD.fileSize}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-[#64748B]">
            Verified on {DEMO_RECORD.verifiedAt}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { label: "Integrity", tone: "valid" as const, value: "Valid" },
              { label: "Signature", tone: "valid" as const, value: "Valid" },
              { label: "TSA Timestamp", tone: "verified" as const, value: "Verified" },
              { label: "OpenTimestamp", tone: "published" as const, value: "Published" },
              { label: "Custody", tone: "consistent" as const, value: "Consistent" },
              { label: "Storage Protection", tone: "protected" as const, value: "Protected" },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-[#F8FAFC] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
                  {s.label}
                </div>
                <div className="mt-1">
                  <StatusPill tone={s.tone} label={s.value} />
                </div>
              </div>
            ))}
          </div>

          <div
            role="presentation"
            className="mt-5 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold text-[#2563EB] select-none"
          >
            View full sample verification
            <ArrowRight size={12} />
          </div>
          </div>
        </div>

        <div>
          <InlineEyebrow>Related Outputs</InlineEyebrow>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              {
                title: "Verification Record",
                body: "Open the full reviewer-facing verification record.",
                icon: PShieldCheck,
                cta: "Open record",
                chipBg: "#DCFCE7",
                chipBorder: "#BBF7D0",
                chipText: "#16A34A",
                ctaText: "#16A34A",
                halo: "rgba(22,163,74,0.07)",
              },
              {
                title: "Sample Report",
                body: "View the generated PDF report.",
                icon: PFilePdf,
                cta: "View report",
                chipBg: "#FFF1F2",
                chipBorder: "#FECDD3",
                chipText: "#E11D48",
                ctaText: "#E11D48",
                halo: "rgba(225,29,72,0.07)",
              },
              {
                title: "Verification Package",
                body: "Download the disclosure package with all materials.",
                icon: PPackage,
                cta: "View package",
                chipBg: "#F5F3FF",
                chipBorder: "#DDD6FE",
                chipText: "#7C3AED",
                ctaText: "#7C3AED",
                halo: "rgba(124,58,237,0.07)",
              },
            ].map((o) => {
              const Icon = o.icon;
              return (
                <div
                  key={o.title}
                  role="presentation"
                  aria-label="Demo only — not interactive"
                  className="relative flex flex-col overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white p-5 select-none"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background: `radial-gradient(circle at 92% 0%, ${o.halo}, transparent 55%)`,
                    }}
                  />
                  <span
                    className="relative flex h-11 w-11 items-center justify-center rounded-xl border"
                    style={{
                      background: o.chipBg,
                      borderColor: o.chipBorder,
                      color: o.chipText,
                    }}
                  >
                    <Icon size={22} weight="duotone" />
                  </span>
                  <div className="relative mt-4 text-[13.5px] font-semibold text-[#0F172A]">
                    {o.title}
                  </div>
                  <p className="relative mt-1.5 flex-1 text-[12px] leading-[1.55] text-[#475569]">
                    {o.body}
                  </p>
                  <span
                    className="relative mt-4 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold"
                    style={{ color: o.ctaText }}
                  >
                    {o.cta}
                    <ArrowRight size={12} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ImportantClarification() {
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
              <PCheckCircle size={26} weight="fill" />
              PROOVRA verifies:
            </div>
            <ul className="relative mt-5 grid gap-3 pl-7">
              {[
                "Recorded integrity state",
                "Timestamp context",
                "Custody metadata",
                "Storage-protection indicators",
                "Supporting review materials",
              ].map((i) => (
                <li
                  key={i}
                  className="flex list-none items-start gap-2.5 text-[14.5px] leading-[1.6] text-[#0F172A]"
                >
                  <PCheckCircle
                    size={18}
                    weight="fill"
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
              <PXCircle size={26} weight="fill" />
              PROOVRA does not independently establish:
            </div>
            <ul className="relative mt-5 grid grid-cols-1 gap-3 pl-7 sm:grid-cols-2">
              {[
                "Truth of content",
                "Legal admissibility",
                "Authorship",
                "Evidentiary weight",
                "Identity of persons",
              ].map((i) => (
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

function BottomCTA() {
  return (
    <section className="bg-[var(--proovra-page-bg)] pb-12 md:pb-16">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <div
          className="overflow-hidden rounded-[20px] p-6 text-white shadow-[0_24px_60px_rgba(8,26,61,0.22)] md:p-7"
style={{
background:
  "linear-gradient(115deg,#4C0D7A 0%,#7B1FA2 25%,#E6007A 55%,#B517FF 82%,#7C3AED 100%)"
}}
        >
          <div className="grid items-center gap-5 md:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="text-[1.05rem] font-semibold tracking-[-0.01em] md:text-[1.18rem]">
                Want a guided walkthrough?
              </div>
              <p className="mt-1.5 max-w-[480px] text-[13.5px] leading-[1.55] text-white/80">
                Request a personalized demo and see how PROOVRA fits your review
                workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[13.5px] font-semibold text-[#081A3D] shadow-[0_8px_18px_rgba(15,23,42,0.18)] transition hover:translate-y-[-1px]"
              >
                Request a demo
                <ArrowRight size={14} />
              </Link>
              <Link
                href={SALES_ASSETS.contactSalesUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-white/30 bg-white/10 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/20"
              >
                Talk to sales
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function VerificationDemoPage() {
  const handleCopyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(
          typeof window !== "undefined"
            ? `${window.location.origin}${DEMO_VERIFY_URL}`
            : DEMO_VERIFY_URL
        )
        .then(() => {
          alert("Demo verification link copied to clipboard.");
        })
        .catch(() => {
          alert("Could not copy. This is a demo link.");
        });
    } else {
      alert("Demo verification link: " + DEMO_VERIFY_URL);
    }
  };

  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <MarketingHeader />
      <HeroSection />
      <WhatReviewerSees />
      <InteractiveWalkthrough onCopyLink={handleCopyLink} />
      <LifecycleTimeline />
      <ExampleRecordAndOutputs />
      <ImportantClarification />
      <BottomCTA />
      <EnterpriseFooter />
    </div>
  );
}
