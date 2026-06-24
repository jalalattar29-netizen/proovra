"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import {
  Anchor,
  ArrowRight,
  BadgeCheck,
  Briefcase,
  Calendar,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Cloud,
  FileText,
  Fingerprint,
  Folder,
  Gavel,
  GitBranch,
  Hash,
  HelpCircle,
  Landmark,
  Layers,
  Link2,
  Lock,
  Mic,
  Network,
  Package,
  Paperclip,
  PenLine,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  UserCheck,
  Users,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { PlatformDashboardShowcase } from "../../components/marketing/PlatformDashboardShowcase";
import { PlatformDashboardPreview } from "../../components/marketing/PlatformDashboardPreview";
import { IntegrationsComplianceSection } from "../../components/marketing/IntegrationsComplianceSection";
import { SALES_ASSETS } from "../../lib/sales-assets";
import { RevealSection } from "../../components/motion";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

const BRAND_GRADIENT_TEXT =
  "linear-gradient(90deg,#FF2DBD 0%,#7A3CFF 50%,#00D4FF 100%)";

const CARD_SHADOW =
  "shadow-[0_18px_40px_rgba(15,23,42,0.06)]";

function Eyebrow({ children, center }: { children: ReactNode; center?: boolean }) {
  const wrapClass = center ? "flex justify-center" : "";
  return (
    <div className={wrapClass}>
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-[#F8FAFC] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
        {children}
      </span>
    </div>
  );
}

function SectionTitle({ children, center }: { children: ReactNode; center?: boolean }) {
  return (
    <h2
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[760px] text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[2rem]`}
    >
      {children}
    </h2>
  );
}

function SectionSubtitle({ children, center }: { children: ReactNode; center?: boolean }) {
  return (
    <p
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[680px] text-[14.5px] leading-[1.65] text-[#475569]`}
    >
      {children}
    </p>
  );
}

function PlatformHero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/backgrounds/proovra-page-hero-bg.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "100% 100%",
        }}
      />

      <div className="relative mx-auto grid max-w-[1320px] gap-10 px-6 pb-16 pt-14 md:px-8 md:pb-20 md:pt-20 lg:grid-cols-[46fr_54fr] lg:items-center lg:pb-24 lg:pt-24">
        <div>
          <Eyebrow>Platform</Eyebrow>
          <h1 className="mt-4 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
            The evidence platform built for{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: BRAND_GRADIENT_TEXT }}
            >
              high-trust operations.
            </span>
          </h1>
          <p className="mt-4 max-w-[540px] text-[15px] leading-[1.65] text-[#475569]">
            PROOVRA secures the entire evidence lifecycle — capture, preserve,
            verify, report, and govern — with cryptographic integrity,
            tamper-evident custody, and review-ready outputs.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={SALES_ASSETS.requestDemoUrl}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition-all duration-200 hover:-translate-y-0.5"
            >
              Request a demo
              <ArrowRight size={14} />
            </Link>
            {/* CTA cleanup: replaced "Explore the platform" (in-page anchor)
                with "View sample report" pointing at the canonical sample
                report PDF (/brand/sample-report.pdf). Same secondary visual
                treatment, opens in a new tab as a downloadable asset. */}
            <a
              href="/brand/sample-report.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className={MARKETING_BTN.heroSecondary}
            >
              View sample report
            </a>
          </div>
        </div>

        <div className="relative flex justify-center lg:justify-end">
          <div className="relative w-full max-w-[960px]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-6 rounded-[36px]"
              style={{
                background:
                  "radial-gradient(circle at 50% 50%, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0.04) 35%, transparent 70%)",
                filter: "blur(10px)",
              }}
            />
            <span
              className="absolute -top-3 right-5 z-10 inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-white px-3 py-1 text-[12px] font-semibold text-[#0F172A] shadow-[0_4px_12px_rgba(15,23,42,0.06)]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A]" />
              Live Platform View
            </span>
            <PlatformDashboardShowcase />
          </div>
        </div>
      </div>
    </section>
  );
}

function StageColumn({
  number,
  label,
  color,
  children,
}: {
  number: string;
  label: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex flex-col items-center">
      <span
        className="flex items-center justify-center rounded-full text-[11px] font-extrabold text-white shadow-[0_8px_16px_rgba(15,23,42,0.10)]"
        style={{ width: 30, height: 30, background: color }}
      >
        {number}
      </span>
      <span
        className="mt-2 text-[15px] font-bold tracking-[-0.005em]"
        style={{ color }}
      >
        {label}
      </span>
      <div className="mt-6 flex justify-center">{children}</div>
    </div>
  );
}

function LifecycleRowKV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
        {label}
      </div>
      <div
        className={`mt-1 text-[13.5px] font-semibold leading-[1.35] text-[#0F172A] ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function OrbitNode({
  Icon,
  label,
  positionStyle,
}: {
  Icon: LucideIcon;
  label: string;
  positionStyle: React.CSSProperties;
}) {
  return (
    <div
      className="absolute flex flex-col items-center gap-1"
      style={positionStyle}
    >
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#E5E7EB] bg-white text-[#7A3CFF] shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
        <Icon size={18} strokeWidth={1.85} />
      </span>
      <span className="whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-[11.5px] font-bold text-[#0F172A] shadow-[0_4px_10px_rgba(15,23,42,0.06)]">
        {label}
      </span>
    </div>
  );
}

function LifecycleSection() {
  const STAGE_COLOR = {
    capture: "#F97316",
    record: "#7A3CFF",
    integrity: "#6D28D9",
    verification: "#2563EB",
    outputs: "#DB2777",
    cases: "#0F766E",
    governance: "#64748B",
  };

  return (
    <section id="lifecycle" className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[1600px] px-6 md:px-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#DBEAFE] bg-[#F8FAFC] px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#2563EB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
            The Evidence Lifecycle
          </span>
          <h2 className="mt-5 max-w-[820px] text-[2.1rem] font-bold leading-[1.05] tracking-[-0.025em] text-[#0F172A] md:text-[2.8rem] lg:text-[3.4rem]">
            One record. Every step covered.
          </h2>
          <p className="mt-4 max-w-[760px] text-[17px] leading-[1.65] text-[#475569]">
            PROOVRA connects capture, intake, integrity, verification, reporting,
            packaging, review, and governance into one continuous evidence
            workflow. Secure intake links and guided submissions bring evidence
            in from clients, witnesses, staff, and third parties.
          </p>
        </div>

        {/* Diagram */}
        <div className="relative mx-auto mt-14 max-w-[1540px]">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.035]"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <pattern
                id="lifecycle-grid"
                width="44"
                height="44"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 44 0 L 0 0 0 44"
                  fill="none"
                  stroke="#0F172A"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#lifecycle-grid)" />
          </svg>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.035]"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <line x1="0" y1="50" x2="100" y2="50" stroke="#2563EB" strokeWidth="0.15" strokeDasharray="0.6 1.2" />
            <line x1="20" y1="0" x2="20" y2="100" stroke="#7A3CFF" strokeWidth="0.15" strokeDasharray="0.6 1.2" />
            <line x1="80" y1="0" x2="80" y2="100" stroke="#7A3CFF" strokeWidth="0.15" strokeDasharray="0.6 1.2" />
          </svg>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 50% 55%, rgba(122,60,255,0.038), transparent 45%), radial-gradient(circle at 18% 80%, rgba(37,99,235,0.030), transparent 42%), radial-gradient(circle at 82% 28%, rgba(0,212,255,0.025), transparent 42%)",
            }}
          />

          <div className="relative grid grid-cols-1 gap-10 lg:grid-cols-7 lg:gap-2">
            {/* 01 — Capture */}
            <StageColumn number="01" label="Capture" color={STAGE_COLOR.capture}>
              <div className="flex flex-col items-center gap-3">
                <div
                  className="overflow-hidden rounded-[20px] border border-[#E5E7EB] shadow-[0_18px_45px_rgba(15,23,42,0.10)]"
                  style={{ width: 218, height: 167 }}
                >
                  <img
                    src="/assets/use-cases/verification-car-rental-return.png"
                    alt="Capture intake"
                    className="h-full w-full object-cover"
                    style={{ objectPosition: "50% 30%", transform: "scale(1.25)" }}
                  />
                </div>
                <div
                  className="rounded-[18px] border border-[#E5E7EB] bg-white p-3.5 shadow-[0_8px_22px_rgba(15,23,42,0.05)]"
                  style={{ width: 180 }}
                >
                  {[
                    { label: "Photos", icon: Camera },
                    { label: "Video", icon: Video },
                    { label: "Documents", icon: FileText },
                    { label: "Audio", icon: Mic },
                    { label: "Any source", icon: Cloud },
                  ].map(({ label, icon: Icon }) => (
                    <div
                      key={label}
                      className="flex items-center gap-2 py-1 text-[13px] text-[#0F172A]"
                    >
                      <Icon
                        size={14}
                        strokeWidth={1.85}
                        className="text-[#F97316]"
                      />
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </StageColumn>

            {/* 02 — Evidence Record */}
            <StageColumn
              number="02"
              label="Evidence Record"
              color={STAGE_COLOR.record}
            >
              <div
                className="flex flex-col gap-3 rounded-[26px] border bg-white p-5 shadow-[0_22px_55px_rgba(122,60,255,0.10)]"
                style={{
                  width: 230,
                  minHeight: 310,
                  borderColor: "rgba(122,60,255,0.28)",
                }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
                      Evidence ID
                    </div>
                    <div className="mt-1 text-[14.5px] font-bold text-[#0F172A]">
                      EV-2024-00128
                    </div>
                  </div>
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#F5F3FF] text-[#7A3CFF]">
                    <Lock size={13} strokeWidth={2} />
                  </span>
                </div>
                <div className="h-px bg-[#E5E7EB]" />
                <LifecycleRowKV label="SHA-256" value="a3f7c2…9d8e1b" mono />
                <div className="h-px bg-[#E5E7EB]" />
                <LifecycleRowKV
                  label="Timestamp (UTC)"
                  value="May 19, 2026 10:41:32"
                />
                <div className="h-px bg-[#E5E7EB]" />
                <LifecycleRowKV label="Source Device" value="iPhone 15 Pro" />
                <div className="h-px bg-[#E5E7EB]" />
                <LifecycleRowKV
                  label="Metadata"
                  value="Location, Device, App, User, and more"
                />
              </div>
            </StageColumn>

            {/* 03 — Integrity Layer Core */}
            <StageColumn
              number="03"
              label="Integrity Layer"
              color={STAGE_COLOR.integrity}
            >
              <div
                className="relative"
                style={{ width: 340, height: 340 }}
              >
                {/* Halo glow behind core */}
                <div
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    width: 380,
                    height: 380,
                    background:
                      "radial-gradient(circle at 50% 50%, rgba(122,60,255,0.18) 0%, rgba(122,60,255,0.10) 30%, transparent 65%)",
                    filter: "blur(2px)",
                  }}
                />
                {/* Outer gradient ring (thicker) */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full"
                  style={{
                    padding: 3,
                    background:
                      "conic-gradient(from 0deg, #EDE9FE, #C4B5FD, #7A3CFF, #2563EB, #C4B5FD, #EDE9FE)",
                    boxShadow:
                      "0 0 0 1px rgba(122,60,255,0.10), 0 30px 60px -20px rgba(122,60,255,0.25)",
                  }}
                >
                  <div className="h-full w-full rounded-full bg-white" />
                </div>

                {/* Dashed orbit line */}
                <svg
                  aria-hidden="true"
                  className="absolute inset-0"
                  viewBox="0 0 340 340"
                  width="340"
                  height="340"
                >
                  <circle
                    cx="170"
                    cy="170"
                    r="148"
                    fill="none"
                    stroke="rgba(122,60,255,0.25)"
                    strokeWidth="1"
                    strokeDasharray="3 4"
                  />
                </svg>

                {/* Inner circle with PROOVRA mark — subtle radial gradient + stronger glow */}
                <div
                  className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full"
                  style={{
                    width: 200,
                    height: 200,
                    background:
                      "radial-gradient(circle at 50% 38%, rgba(196,181,253,0.18) 0%, #FFFFFF 65%)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -1px 0 rgba(122,60,255,0.08), 0 24px 60px rgba(122,60,255,0.36), 0 0 0 1px rgba(122,60,255,0.08)",
                  }}
                >
                  <img
                    src="/assets/branding/proovra-mark.png"
                    alt=""
                    width={96}
                    height={96}
                    className="object-contain drop-shadow-[0_8px_18px_rgba(122,60,255,0.30)]"
                  />
                  <div className="mt-1.5 text-center text-[18px] font-bold leading-[1.05] tracking-[-0.01em] text-[#0F172A]">
                    Integrity
                    <br />
                    Layer
                  </div>
                </div>

                {/* Orbit nodes */}
                <OrbitNode
                  Icon={Hash}
                  label="Hashing"
                  positionStyle={{
                    top: -22,
                    left: "50%",
                    transform: "translateX(-50%)",
                  }}
                />
                <OrbitNode
                  Icon={Clock3}
                  label="Timestamping"
                  positionStyle={{
                    top: "50%",
                    right: -30,
                    transform: "translateY(-50%)",
                  }}
                />
                <OrbitNode
                  Icon={PenLine}
                  label="Digital Signature"
                  positionStyle={{
                    bottom: -14,
                    right: 16,
                  }}
                />
                <OrbitNode
                  Icon={GitBranch}
                  label="Chain of Custody"
                  positionStyle={{
                    bottom: -14,
                    left: 16,
                  }}
                />
                <OrbitNode
                  Icon={Anchor}
                  label="Anchoring"
                  positionStyle={{
                    top: "50%",
                    left: -28,
                    transform: "translateY(-50%)",
                  }}
                />
              </div>
            </StageColumn>

            {/* 04 — Verification */}
            <StageColumn
              number="04"
              label="Verification"
              color={STAGE_COLOR.verification}
            >
              <div
                className="flex flex-col rounded-[24px] border bg-white p-6 shadow-[0_22px_55px_rgba(37,99,235,0.12)]"
                style={{
                  width: 220,
                  minHeight: 320,
                  borderColor: "#DBEAFE",
                }}
              >
                <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-[#64748B]">
                  Verification Result
                </div>
                <div className="mt-4 flex items-center gap-2.5">
                  <CheckCircle2
                    size={26}
                    className="text-[#16A34A]"
                    strokeWidth={2.6}
                  />
                  <span className="text-[28px] font-extrabold tracking-[0.04em] text-[#16A34A]">
                    VALID
                  </span>
                </div>
                <div className="mt-4 h-px bg-[#E5E7EB]" />
                <ul className="mt-4 grid gap-3 pl-0">
                  {[
                    "Hash Match",
                    "Timestamp Verified",
                    "Signature Verified",
                    "Anchoring Verified",
                  ].map((t) => (
                    <li
                      key={t}
                      className="flex list-none items-center gap-2.5 text-[13.5px] font-semibold text-[#0F172A]"
                    >
                      <CheckCircle2
                        size={16}
                        className="text-[#16A34A]"
                        strokeWidth={2.6}
                      />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </StageColumn>

            {/* 05 — Outputs */}
            <StageColumn
              number="05"
              label="Outputs"
              color={STAGE_COLOR.outputs}
            >
              <div
                className="flex flex-col gap-3 rounded-[24px] border bg-white p-5 shadow-[0_20px_50px_rgba(219,39,119,0.08)]"
                style={{
                  width: 230,
                  minHeight: 300,
                  borderColor: "rgba(219,39,119,0.22)",
                }}
              >
                {[
                  {
                    title: "Report",
                    body: "Professional report with audit trail",
                    icon: FileText,
                    badge: "PDF",
                    badgeBg: "#FDF2F8",
                  },
                  {
                    title: "Verification Package",
                    body: "Sealed package with manifest & hashes",
                    icon: Package,
                    badge: "ZIP",
                    badgeBg: "#F5F3FF",
                  },
                  {
                    title: "API Export",
                    body: "Structured data for integrations",
                    icon: Code2,
                    badge: "JSON",
                    badgeBg: "#EFF6FF",
                  },
                ].map((o) => {
                  const Icon = o.icon;
                  return (
                    <div key={o.title} className="flex items-start gap-2.5">
                      <span
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E5E7EB] text-[#DB2777]"
                        style={{ background: o.badgeBg }}
                      >
                        <Icon size={16} strokeWidth={1.85} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-bold text-[#0F172A]">
                            {o.title}
                          </span>
                          <span
                            className="rounded-md px-1.5 py-0.5 text-[9px] font-bold tracking-[0.05em] text-[#0F172A]"
                            style={{ background: o.badgeBg }}
                          >
                            {o.badge}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-[1.4] text-[#64748B]">
                          {o.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </StageColumn>

            {/* 06 — Cases & Matters */}
            <StageColumn
              number="06"
              label="Cases & Matters"
              color={STAGE_COLOR.cases}
            >
              <div
                className="flex flex-col rounded-[24px] border bg-white p-5 shadow-[0_20px_50px_rgba(15,118,110,0.08)]"
                style={{
                  width: 230,
                  minHeight: 300,
                  borderColor: "rgba(15,118,110,0.24)",
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="text-[12px] font-bold text-[#0F172A]">
                    Case: CLM-2024-5567
                  </div>
                  <span className="inline-flex items-center rounded-full bg-[#ECFDF5] px-2 py-0.5 text-[10px] font-bold text-[#047857]">
                    Active
                  </span>
                </div>
                <ul className="mt-4 grid gap-2.5 pl-0">
                  {[
                    { label: "Evidence", icon: Folder, count: 24 },
                    { label: "Reports", icon: FileText, count: 6 },
                    { label: "Reviewers", icon: Users, count: 5 },
                    { label: "Tasks", icon: CheckCircle2, count: 3 },
                    { label: "Notes", icon: ScrollText, count: 12 },
                  ].map(({ label, icon: Icon, count }) => (
                    <li
                      key={label}
                      className="flex list-none items-center justify-between text-[13px] text-[#475569]"
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          size={13}
                          className="text-[#0F766E]"
                          strokeWidth={1.85}
                        />
                        {label}
                      </span>
                      <span className="font-bold text-[#0F172A]">{count}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-4">
                  <div className="rounded-lg border border-[#E5E7EB] bg-[#F8FAFC] py-2 text-center text-[12px] font-bold text-[#0F172A]">
                    View case details →
                  </div>
                </div>
              </div>
            </StageColumn>

            {/* 07 — Governance */}
            <StageColumn
              number="07"
              label="Governance"
              color={STAGE_COLOR.governance}
            >
              <div
                className="flex flex-col rounded-[24px] border bg-white p-5 shadow-[0_20px_50px_rgba(100,116,139,0.10)]"
                style={{
                  width: 230,
                  minHeight: 300,
                  borderColor: "#CBD5E1",
                }}
              >
                {[
                  { label: "Retention Policy", value: "7 years" },
                  { label: "Legal Hold", value: "Enabled" },
                  { label: "Audit Logs", value: "12,842 events" },
                  { label: "Access Control", value: "Role-based" },
                  { label: "Disposition", value: "Scheduled" },
                ].map((r, i, arr) => (
                  <div key={r.label}>
                    <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
                      {r.label}
                    </div>
                    <div className="mt-0.5 text-[14px] font-bold text-[#0F172A]">
                      {r.value}
                    </div>
                    {i < arr.length - 1 && (
                      <div className="my-2.5 h-px bg-[#E5E7EB]" />
                    )}
                  </div>
                ))}
              </div>
            </StageColumn>
          </div>
        </div>

        {/* Bottom infrastructure strip */}
        <div className="mx-auto mt-14 max-w-[1540px] rounded-[24px] border border-[#E5E7EB] bg-[#F8FAFC] px-7 py-6">
          <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            {[
              {
                title: "End-to-End Encryption",
                body: "AES-256 encryption at rest and in transit",
                icon: Lock,
                color: "#2563EB",
              },
              {
                title: "Tamper-Evident",
                body: "Records with cryptographic proofs",
                icon: ShieldAlert,
                color: "#7A3CFF",
              },
              {
                title: "Retention & Legal Hold",
                body: "Policy-driven retention and disposition",
                icon: Calendar,
                color: "#4F46E5",
              },
              {
                title: "Access Control",
                body: "Role-based permissions and least privilege",
                icon: UserCheck,
                color: "#0F766E",
              },
              {
                title: "Independent Verification",
                body: "Third-party verifiable signals",
                icon: BadgeCheck,
                color: "#2563EB",
              },
              {
                title: "Secure Cloud",
                body: "Enterprise-grade cloud infrastructure",
                icon: Cloud,
                color: "#64748B",
              },
            ].map((it) => {
              const Icon = it.icon;
              return (
                <div key={it.title} className="flex items-start gap-3">
                  <Icon
                    size={26}
                    strokeWidth={1.85}
                    className="shrink-0"
                    style={{ color: it.color }}
                  />
                  <div>
                    <div className="text-[14px] font-bold text-[#0F172A]">
                      {it.title}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-[1.4] text-[#64748B]">
                      {it.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ComparisonRow({
  Icon,
  title,
  body,
  status,
  iconColor,
  iconBg,
}: {
  Icon: LucideIcon;
  title: string;
  body: string;
  status: "traditional" | "proovra";
  iconColor: string;
  iconBg: string;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b border-[#E5E7EB] py-4 last:border-b-0">
      {status === "traditional" ? (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#FEF2F2]"
          style={{ width: 44, height: 44 }}
        >
          <X size={22} strokeWidth={2.6} className="text-[#EF4444]" />
        </span>
      ) : (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#ECFDF5]"
          style={{ width: 44, height: 44 }}
        >
          <CheckCircle2
            size={22}
            strokeWidth={2.6}
            className="text-[#22C55E]"
          />
        </span>
      )}
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[14px]"
        style={{ width: 54, height: 54, background: iconBg }}
      >
        <Icon size={22} strokeWidth={1.8} style={{ color: iconColor }} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold leading-[1.3] text-[#0F172A]">
          {title}
        </div>
        <div className="mt-1 text-[13.5px] leading-[1.45] text-[#475569]">
          {body}
        </div>
      </div>
    </div>
  );
}

function OutcomeRow({
  Icon,
  title,
  body,
  iconColor,
  iconBg,
}: {
  Icon: LucideIcon;
  title: string;
  body: string;
  iconColor: string;
  iconBg: string;
}) {
  return (
    <div className="flex items-start gap-4 border-b border-[#E5E7EB] py-4 last:border-b-0">
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full"
        style={{ width: 58, height: 58, background: iconBg }}
      >
        <Icon size={24} strokeWidth={1.8} style={{ color: iconColor }} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold leading-[1.3] text-[#0F172A]">
          {title}
        </div>
        <div className="mt-1 text-[13px] leading-[1.45] text-[#475569]">
          {body}
        </div>
      </div>
    </div>
  );
}

function PlatformWorkspaceSection() {
  const modules: {
    title: string;
    body: string;
    pill: string;
    icon: LucideIcon;
    color: string;
    bg: string;
    border: string;
  }[] = [
    {
      title: "Capture",
      body: "Collect evidence from devices, apps, uploads, and field teams.",
      pill: "Source intake",
      icon: Camera,
      color: "#EA580C",
      bg: "rgba(234,88,12,0.08)",
      border: "rgba(234,88,12,0.18)",
    },
    {
      title: "Secure Intake",
      body: "Request submissions from clients, witnesses, staff, or third parties.",
      pill: "Intake links",
      icon: Link2,
      color: "#0891B2",
      bg: "rgba(8,145,178,0.08)",
      border: "rgba(8,145,178,0.18)",
    },
    {
      title: "Evidence Records",
      body: "Create structured records with metadata, hashes, source context, and custody.",
      pill: "Structured records",
      icon: FileText,
      color: "#2563EB",
      bg: "rgba(37,99,235,0.08)",
      border: "rgba(37,99,235,0.18)",
    },
    {
      title: "AI Assistance",
      body: "Guide evidence collection, detect missing context, and prepare reviewers.",
      pill: "Advisory only",
      icon: Sparkles,
      color: "#7C3AED",
      bg: "rgba(124,58,237,0.08)",
      border: "rgba(124,58,237,0.18)",
    },
    {
      title: "Verification",
      body: "Check integrity, timestamps, signatures, custody, and preservation signals.",
      pill: "Independent checks",
      icon: ShieldCheck,
      color: "#1E40AF",
      bg: "rgba(30,64,175,0.08)",
      border: "rgba(30,64,175,0.18)",
    },
    {
      title: "TSA & OpenTimestamps",
      body: "Support trusted timestamping and blockchain anchoring where available.",
      pill: "Time proof",
      icon: Clock3,
      color: "#0F766E",
      bg: "rgba(15,118,110,0.08)",
      border: "rgba(15,118,110,0.18)",
    },
    {
      title: "Reports",
      body: "Generate review-ready reports with integrity results and audit context.",
      pill: "Review-ready",
      icon: FileText,
      color: "#DB2777",
      bg: "rgba(219,39,119,0.08)",
      border: "rgba(219,39,119,0.18)",
    },
    {
      title: "Verification Packages",
      body: "Bundle records, manifests, reports, hashes, and verification metadata.",
      pill: "Portable outputs",
      icon: Package,
      color: "#4F46E5",
      bg: "rgba(79,70,229,0.08)",
      border: "rgba(79,70,229,0.18)",
    },
    {
      title: "Cases & Matters",
      body: "Organize evidence by claims, incidents, investigations, and legal matters.",
      pill: "Case context",
      icon: Folder,
      color: "#2563EB",
      bg: "rgba(37,99,235,0.08)",
      border: "rgba(37,99,235,0.18)",
    },
    {
      title: "Reviewer Operations",
      body: "Assign reviewers, track queues, manage tasks, and prepare review workflows.",
      pill: "Queues & tasks",
      icon: Users,
      color: "#15803D",
      bg: "rgba(21,128,61,0.08)",
      border: "rgba(21,128,61,0.18)",
    },
    {
      title: "Governance",
      body: "Manage roles, access control, policies, retention, and lifecycle controls.",
      pill: "Policy controls",
      icon: Landmark,
      color: "#047857",
      bg: "rgba(4,120,87,0.08)",
      border: "rgba(4,120,87,0.18)",
    },
    {
      title: "Legal Hold & Audit",
      body: "Preserve records, enforce holds, and export complete activity history.",
      pill: "Audit-ready",
      icon: Gavel,
      color: "#BE123C",
      bg: "rgba(190,18,60,0.08)",
      border: "rgba(190,18,60,0.18)",
    },
  ];

  return (
    <section id="platform-workspace" className="bg-[var(--proovra-page-bg)] py-20 md:py-24">
      <div className="mx-auto max-w-[1400px] px-6 md:px-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#DBEAFE] bg-white px-3.5 py-2 text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#2563EB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            Platform Workspace
          </span>
          <h2 className="mt-5 max-w-[900px] text-[2rem] font-bold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
            One workspace. Every evidence operation.
          </h2>
          <p className="mt-4 max-w-[760px] text-[16px] leading-[1.65] text-[#475569]">
            PROOVRA brings capture, intake, verification, review, reporting,
            governance, and AI assistance into one connected evidence operations
            workspace.
          </p>
        </div>

        {/* 4 × 3 module map */}
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {modules.map((m) => {
            const Icon = m.icon;
            return (
              <div
                key={m.title}
                className="relative flex flex-col rounded-[22px] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.06)]"
                style={{ border: "1px solid rgba(15,23,42,0.08)" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <span
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
                    style={{ background: m.bg, color: m.color }}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                  </span>
                  <span
                    className="rounded-full px-2.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[0.10em]"
                    style={{
                      background: m.bg,
                      color: m.color,
                      border: `1px solid ${m.border}`,
                    }}
                  >
                    {m.pill}
                  </span>
                </div>
                <h3 className="mt-4 text-[16px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                  {m.title}
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#64748B]">
                  {m.body}
                </p>
                <span
                  aria-hidden="true"
                  className="absolute inset-x-5 bottom-0 h-[2px] rounded-full"
                  style={{ background: m.color, opacity: 0.7 }}
                />
              </div>
            );
          })}
        </div>

        {/* Subtle center caption */}
        <div className="mt-10 flex flex-col items-center gap-2 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3.5 py-1.5 text-[11.5px] font-semibold text-[#0F172A]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            Evidence Operations Workspace
          </span>
          <p className="max-w-[640px] text-[12.5px] leading-[1.5] text-[#64748B]">
            Every module connects through the same record, custody, and
            governance layer — so teams move between capture, review, and
            reporting without context loss.
          </p>
        </div>
      </div>
    </section>
  );
}

function PlatformGovernanceControlLayer() {
  const leftList = [
    "Identity & access controls",
    "Legal hold and retention enforcement",
    "Complete audit visibility",
    "Immutable preservation controls",
    "Workspace and session governance",
  ];

  const groups: { title: string; items: string[]; accent: string; soft: string }[] = [
    {
      title: "Identity",
      items: [
        "SAML SSO",
        "SCIM Provisioning",
        "MFA",
        "Adaptive Authentication",
      ],
      accent: "#2563EB",
      soft: "rgba(37,99,235,0.08)",
    },
    {
      title: "Governance",
      items: [
        "Legal Hold",
        "Retention Policies",
        "Access Reviews",
        "Workspace Controls",
      ],
      accent: "#0F766E",
      soft: "rgba(15,118,110,0.08)",
    },
    {
      title: "Auditability",
      items: [
        "Complete Audit Logs",
        "Reviewer Activity",
        "Export History",
        "Custody Events",
      ],
      accent: "#7C3AED",
      soft: "rgba(124,58,237,0.08)",
    },
    {
      title: "Preservation",
      items: [
        "Object Lock",
        "Immutable Storage",
        "Hash Integrity",
        "Timestamp Anchoring",
      ],
      accent: "#DB2777",
      soft: "rgba(219,39,119,0.08)",
    },
  ];

  return (
    <section
      id="platform-governance"
      className="bg-[var(--proovra-page-bg)] py-20 md:py-24"
    >
      <div className="mx-auto max-w-[1400px] px-6 md:px-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#DBEAFE] bg-white px-3.5 py-2 text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#2563EB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            Platform Governance
          </span>
          <h2 className="mt-5 max-w-[900px] text-[2rem] font-bold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[2.5rem] lg:text-[2.85rem]">
            The enterprise control layer behind every record.
          </h2>
          <p className="mt-4 max-w-[820px] text-[15.5px] leading-[1.65] text-[#475569]">
            Evidence operations do not stop at verification. PROOVRA connects
            identity, access, retention, legal hold, audit logs, and storage
            controls into the same workflow that captures, verifies, reviews,
            and reports evidence.
          </p>
        </div>

        {/* Split-panel card — backdrop now uses /assets/cards/icon-card.png.
            Inner left panel + control-matrix sub-cards remain solid surfaces
            so the governance content stays fully readable against the
            artwork. A readability scrim sits between the image and the
            content layer. */}
        <div
          className="relative mt-12 overflow-hidden rounded-[24px] border shadow-[0_24px_60px_rgba(15,23,42,0.12)]"
          style={{
            borderColor: "rgba(255,255,255,0.10)",
            backgroundImage: "url('/assets/cards/icon-card.png')",
            backgroundSize: "cover",
            backgroundPosition: "center center",
            backgroundRepeat: "no-repeat",
            backgroundColor: "#050F33",
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, rgba(5,15,51,0.46) 0%, rgba(5,15,51,0.60) 100%)",
            }}
          />
          <div className="relative grid gap-0 lg:grid-cols-[44fr_56fr]">
            {/* Left side — supporting copy + list. Transparent so the
                icon-card backdrop runs unbroken across the whole card.
                Right edge keeps a translucent divider. */}
            <div
              className="border-b p-7 lg:border-b-0 lg:border-r lg:p-9"
              style={{
                borderColor: "rgba(255,255,255,0.12)",
                background: "transparent",
              }}
            >
              <h3 className="text-[1.25rem] font-extrabold leading-[1.18] tracking-[-0.015em] text-white md:text-[1.4rem]">
                Controls that make PROOVRA operational, not just verifiable.
              </h3>
              <p className="mt-4 text-[14px] leading-[1.7] text-[#CBD5F5]">
                Built for organizations that need structured evidence workflows,
                defensible oversight, and repeatable governance across teams,
                cases, and records.
              </p>
              <ul className="mt-6 grid gap-2.5 pl-0">
                {leftList.map((item) => (
                  <li
                    key={item}
                    className="flex items-center gap-2.5 text-[13px] font-semibold text-white"
                    style={{ listStyle: "none" }}
                  >
                    <span
                      aria-hidden="true"
                      className="block h-[2px] w-5 shrink-0 rounded-full"
                      style={{
                        background:
                          "linear-gradient(90deg,#60A5FA 0%,#A78BFA 100%)",
                      }}
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Right side — control matrix. Sub-cards are now translucent
                dark glass tinted with each group accent so they read as
                part of the unified governance card, not floating white
                panels. */}
            <div className="p-6 md:p-7 lg:p-8">
              <div className="grid gap-4 sm:grid-cols-2">
                {groups.map((g) => (
                  <div
                    key={g.title}
                    className="rounded-[16px] border p-4 backdrop-blur-[2px] shadow-[0_8px_22px_rgba(0,0,0,0.18)]"
                    style={{
                      borderColor: `${g.accent}55`,
                      background: "rgba(15,23,42,0.55)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="block h-[3px] w-6 shrink-0 rounded-full"
                        style={{ background: g.accent }}
                      />
                      <h4
                        className="text-[11.5px] font-extrabold uppercase tracking-[0.16em]"
                        style={{ color: g.accent }}
                      >
                        {g.title}
                      </h4>
                    </div>
                    <ul className="mt-3 grid gap-1.5 pl-0">
                      {g.items.map((it) => (
                        <li
                          key={it}
                          className="flex items-center gap-2 text-[12.5px] text-[#E5E7EB]"
                          style={{ listStyle: "none" }}
                        >
                          <span
                            aria-hidden="true"
                            className="block h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: g.accent, opacity: 0.85 }}
                          />
                          {it}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <p className="mt-5 text-[12px] leading-[1.6] text-white/80">
                Every control is connected to the evidence lifecycle — from
                intake and preservation to verification, reporting, and
                governance.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SwitchSection() {
  const traditional: {
    icon: LucideIcon;
    title: string;
    body: string;
  }[] = [
    {
      icon: Folder,
      title: "Files stored in folders, emails, or devices",
      body: "Hard to find, easy to lose, not provable.",
    },
    {
      icon: UserCheck,
      title: "Manual verification (if any)",
      body: "Slow, inconsistent, and not defensible.",
    },
    {
      icon: Paperclip,
      title: "Emailed attachments and loose files",
      body: "No control, no integrity, no audit trail.",
    },
    {
      icon: Network,
      title: "Scattered evidence across people and tools",
      body: "Silos, duplication, and version confusion.",
    },
    {
      icon: HelpCircle,
      title: "No clear custody or history",
      body: "Unclear who accessed or changed what.",
    },
    {
      icon: Gavel,
      title: "Difficult to prepare for review or court",
      body: "Time-consuming and high effort.",
    },
    {
      icon: ShieldAlert,
      title: "Limited auditability and governance",
      body: "Policies not enforced, high risk exposure.",
    },
  ];

  const proovra: {
    icon: LucideIcon;
    title: string;
    body: string;
    iconColor: string;
    iconBg: string;
  }[] = [
    {
      icon: FileText,
      title: "Structured Evidence Records with rich metadata",
      body: "Everything is organized, searchable, and provable.",
      iconColor: "#7C3AED",
      iconBg: "#F5F3FF",
    },
    {
      icon: ShieldCheck,
      title: "Independent, automated verification",
      body: "Cryptographic verification with tamper-evident proofs.",
      iconColor: "#2563EB",
      iconBg: "#EFF6FF",
    },
    {
      icon: Package,
      title: "Sealed Verification Packages",
      body: "Complete integrity with manifest, hashes, and signatures.",
      iconColor: "#7C3AED",
      iconBg: "#F5F3FF",
    },
    {
      icon: Briefcase,
      title: "Organized Cases & Matters",
      body: "All evidence in the right context, always.",
      iconColor: "#0891B2",
      iconBg: "#ECFEFF",
    },
    {
      icon: Link2,
      title: "Tamper-evident Chain of Custody",
      body: "Full history of every action, every time.",
      iconColor: "#2563EB",
      iconBg: "#EFF6FF",
    },
    {
      icon: FileText,
      title: "Court-review-ready Reports in minutes",
      body: "Professional reports with audit trail and proof.",
      iconColor: "#EC4899",
      iconBg: "#FDF2F8",
    },
    {
      icon: Landmark,
      title: "Full governance, retention, legal hold & audit logs",
      body: "Policies enforced. Risk reduced. Always audit-ready.",
      iconColor: "#64748B",
      iconBg: "#F8FAFC",
    },
  ];

  const outcomes: {
    icon: LucideIcon;
    title: string;
    body: string;
    iconColor: string;
    iconBg: string;
  }[] = [
    {
      icon: Clock3,
      title: "Designed to reduce claim review time",
      body: "Resolve faster with trusted evidence.",
      iconColor: "#2563EB",
      iconBg: "#EFF6FF",
    },
    {
      icon: ShieldCheck,
      title: "Increase evidence acceptance and defensibility",
      body: "Stronger integrity. Fewer disputes.",
      iconColor: "#2563EB",
      iconBg: "#EFF6FF",
    },
    {
      icon: Landmark,
      title: "Strengthen compliance and audit readiness",
      body: "Always ready for regulators and audits.",
      iconColor: "#0891B2",
      iconBg: "#ECFEFF",
    },
    {
      icon: Users,
      title: "Lower risk with custody traceability",
      body: "Full visibility. Less operational risk.",
      iconColor: "#7C3AED",
      iconBg: "#F5F3FF",
    },
    {
      icon: Star,
      title: "Save time and cost across the entire lifecycle",
      body: "Automate. Standardize. Scale efficiently.",
      iconColor: "#F59E0B",
      iconBg: "#FFFBEB",
    },
  ];

  const trustCapabilities: {
    icon: LucideIcon;
    title: string;
    body: string;
    iconColor: string;
    iconBg: string;
  }[] = [
    {
      icon: Hash,
      title: "Cryptographic Integrity",
      body: "SHA-256 • RFC 3161",
      iconColor: "#F59E0B",
      iconBg: "#FFFBEB",
    },
    {
      icon: Lock,
      title: "Tamper-Evident by Design",
      body: "Records with cryptographic proofs",
      iconColor: "#7C3AED",
      iconBg: "#F5F3FF",
    },
    {
      icon: Users,
      title: "End-to-End Custody",
      body: "Full chain of custody",
      iconColor: "#0891B2",
      iconBg: "#ECFEFF",
    },
    {
      icon: FileText,
      title: "Audit-Ready Reporting",
      body: "Court-review-ready outputs",
      iconColor: "#EC4899",
      iconBg: "#FDF2F8",
    },
    {
      icon: Lock,
      title: "Enterprise-Grade Security",
      body: "Encryption, MFA, SSO",
      iconColor: "#64748B",
      iconBg: "#F8FAFC",
    },
  ];

  const PANEL =
    "rounded-[24px] border border-[#DBEAFE] bg-white p-8 md:p-9 shadow-[0_20px_55px_rgba(15,23,42,0.06)]";

  return (
    <section id="switch" className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1560px] px-6 md:px-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#DBEAFE] bg-[#F8FAFC] px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2563EB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            Why organizations switch to PROOVRA
          </span>
          <h2 className="mt-5 max-w-[1100px] text-[2.1rem] font-bold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[2.8rem] lg:text-[3.4rem]">
            From manual and scattered to trusted and provable.
          </h2>
          <p className="mt-4 max-w-[760px] text-[17px] leading-[1.65] text-[#475569]">
            PROOVRA replaces fragile evidence handling with structured records,
            verification, custody, reporting, and governance.
          </p>
        </div>

        {/* 3 comparison cards */}
        <div className="mt-12 grid gap-7 lg:grid-cols-[34fr_38fr_28fr]">
          {/* Left — Traditional */}
          <div className={PANEL}>
            <div className="text-[15px] font-extrabold uppercase tracking-[0.08em] text-[#DC2626]">
              Traditional Evidence Process
            </div>
            <div className="mt-4">
              {traditional.map((r) => (
                <ComparisonRow
                  key={r.title}
                  Icon={r.icon}
                  title={r.title}
                  body={r.body}
                  status="traditional"
                  iconColor="#475569"
                  iconBg="#F3F4F6"
                />
              ))}
            </div>
          </div>

          {/* Middle — With PROOVRA */}
          <div className={PANEL}>
            <div className="text-[15px] font-extrabold uppercase tracking-[0.08em] text-[#2563EB]">
              With PROOVRA
            </div>
            <div className="mt-4">
              {proovra.map((r) => (
                <ComparisonRow
                  key={r.title}
                  Icon={r.icon}
                  title={r.title}
                  body={r.body}
                  status="proovra"
                  iconColor={r.iconColor}
                  iconBg={r.iconBg}
                />
              ))}
            </div>
          </div>

          {/* Right — Real Outcomes */}
          <div className={PANEL}>
            <div className="text-[15px] font-extrabold uppercase tracking-[0.08em] text-[#2563EB]">
              Real Outcomes
            </div>
            <div className="mt-4">
              {outcomes.map((o) => (
                <OutcomeRow
                  key={o.title}
                  Icon={o.icon}
                  title={o.title}
                  body={o.body}
                  iconColor={o.iconColor}
                  iconBg={o.iconBg}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Bottom trust strip */}
        <div className="mt-8 rounded-[24px] border border-[#DBEAFE] bg-white px-7 py-7 shadow-[0_18px_50px_rgba(15,23,42,0.05)] md:px-9">
          <div className="grid items-center gap-6 lg:grid-cols-[240px_1fr]">
            <div className="flex items-center gap-4">
              <span
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#EFF6FF]"
                style={{ width: 72, height: 72 }}
              >
                <ShieldCheck
                  size={36}
                  strokeWidth={1.85}
                  className="text-[#2563EB]"
                />
              </span>
              <div>
                <div className="text-[17px] font-bold leading-[1.2] text-[#0F172A]">
                  Built for trust.
                </div>
                <div className="mt-1 text-[12.5px] leading-[1.45] text-[#64748B]">
                  Every layer. Every record. Every time.
                </div>
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              {trustCapabilities.map((c) => {
                const Icon = c.icon;
                return (
                  <div key={c.title} className="flex items-start gap-3">
                    <span
                      className="inline-flex shrink-0 items-center justify-center rounded-[12px]"
                      style={{ width: 44, height: 44, background: c.iconBg }}
                    >
                      <Icon
                        size={20}
                        strokeWidth={1.8}
                        style={{ color: c.iconColor }}
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-bold leading-[1.3] text-[#0F172A]">
                        {c.title}
                      </div>
                      <div className="mt-0.5 text-[11.5px] leading-[1.4] text-[#64748B]">
                        {c.body}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function IndustriesSection() {
  const industries: {
    title: string;
    image: string;
    body: string;
    workflow: string[];
    cases: string[];
  }[] = [
    {
      title: "Insurance Claims",
      image: "/assets/industries/industry-insurance.png",
      body: "Capture, verify, and report claim evidence with structured records, integrity verification, and review-ready reporting.",
      workflow: ["Capture", "Verify", "Report", "Claim Review"],
      cases: ["FNOL documentation", "Damage assessments", "Fraud investigations", "Subrogation"],
    },
    {
      title: "Legal Matters",
      image: "/assets/industries/industry-legal.png",
      body: "Preserve, organize, verify, and produce evidence for litigation, dispute resolution, and legal review workflows.",
      workflow: ["Collect", "Preserve", "Verify", "Produce"],
      cases: ["Litigation support", "E-discovery", "Depositions", "Expert reports"],
    },
    {
      title: "Compliance Investigations",
      image: "/assets/industries/industry-compliance.png",
      body: "Collect and review evidence with defensible chain-of-custody and audit-ready governance controls.",
      workflow: ["Collect", "Review", "Govern", "Report"],
      cases: ["Internal investigations", "Policy violations", "Regulatory audits", "Employee conduct"],
    },
    {
      title: "Corporate Investigations",
      image: "/assets/industries/industry-investigations.png",
      body: "Centralize evidence collection, review, reporting, and governance for internal investigations and operational reviews.",
      workflow: ["Capture", "Audit", "Review", "Report"],
      cases: ["Incident response", "Internal audits", "HR investigations", "Risk management"],
    },
    {
      title: "Public Sector",
      image: "/assets/industries/industry-government.png",
      body: "Secure evidence management with transparency, governance, retention controls, and public accountability.",
      workflow: ["Capture", "Verify", "Retain", "Disclose"],
      cases: ["Public records", "Citizen complaints", "Law enforcement support", "Regulatory oversight"],
    },
    {
      title: "Journalism & Media",
      image: "/assets/industries/industry-journalism.png",
      body: "Collect, preserve, verify, and disclose media evidence with transparent integrity verification workflows.",
      workflow: ["Capture", "Verify", "Review", "Publish"],
      cases: ["Source documentation", "Media verification", "Investigative reporting", "Editorial review"],
    },
  ];

  return (
    <section id="industries" className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1180px] px-6 md:px-8">
        <Eyebrow center>Built for real operations</Eyebrow>
        <SectionTitle center>Built for the way evidence is actually used.</SectionTitle>
        <SectionSubtitle center>
          PROOVRA supports real-world evidence operations across insurance,
          legal, compliance, investigations, government, and journalism
          workflows.
        </SectionSubtitle>

        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {industries.map((ind) => (
            <div
              key={ind.title}
              className={`flex flex-col overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-white ${CARD_SHADOW} transition-all duration-200 hover:-translate-y-0.5 hover:border-[#CBD5E1]`}
            >
              <div className="relative w-full overflow-hidden p-3">
                <img
                  src={ind.image}
                  alt={ind.title}
                  className="h-[180px] w-full rounded-[18px] object-cover"
                />
              </div>
              <div className="flex flex-1 flex-col p-5 pt-2">
                <h3 className="text-[1.05rem] font-semibold tracking-[-0.015em] text-[#0F172A]">
                  {ind.title}
                </h3>
                <p className="mt-2 text-[12.5px] leading-[1.55] text-[#475569]">
                  {ind.body}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {ind.workflow.map((step, i) => (
                    <span key={step} className="flex items-center gap-1.5">
                      <span className="rounded-md bg-[#EEF4FF] px-1.5 py-0.5 text-[10px] font-semibold text-[#2563EB]">
                        {step}
                      </span>
                      {i < ind.workflow.length - 1 && (
                        <ChevronRight size={10} className="text-[#94A3B8]" />
                      )}
                    </span>
                  ))}
                </div>

                <ul className="mt-3 grid gap-1 pl-0">
                  {ind.cases.map((c) => (
                    <li
                      key={c}
                      className="flex list-none items-center gap-2 text-[12px] text-[#475569]"
                    >
                      <span className="h-1 w-1 rounded-full bg-[#94A3B8]" />
                      {c}
                    </li>
                  ))}
                </ul>

                <Link
                  href={SALES_ASSETS.requestDemoUrl}
                  className="group mt-4 inline-flex items-center gap-1 text-[12px] font-semibold text-[#2563EB]"
                >
                  Learn more
                  <ArrowRight size={11} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScreensSection() {
  const tabs: { id: string; label: string; icon: LucideIcon; color: string }[] = [
    { id: "overview", label: "Overview", icon: Layers, color: "#2563EB" },
    { id: "capture", label: "Capture", icon: Camera, color: "#0891B2" },
    { id: "verification", label: "Verification", icon: ShieldCheck, color: "#16A34A" },
    { id: "reports", label: "Reports", icon: FileText, color: "#DB2777" },
    { id: "cases", label: "Cases", icon: Folder, color: "#2563EB" },
    { id: "governance", label: "Governance", icon: Landmark, color: "#0F766E" },
    { id: "packages", label: "Packages", icon: Package, color: "#6D28D9" },
  ];

  const capabilities: { title: string; body: string; icon: LucideIcon; color: string; bg: string }[] = [
    { title: "Verification", body: "Independent integrity validation for every record.", icon: ShieldCheck, color: "#16A34A", bg: "#ECFDF5" },
    { title: "Chain of Custody", body: "Every action recorded. Every transfer tracked.", icon: Link2, color: "#6D28D9", bg: "#F5F3FF" },
    { title: "Reports", body: "Court-review-ready reports in minutes.", icon: FileText, color: "#DB2777", bg: "#FDF2F8" },
    { title: "Cases", body: "Organized matters. Clear context. Always.", icon: Folder, color: "#2563EB", bg: "#EFF6FF" },
    { title: "Governance", body: "Retention, legal hold, and audit controls.", icon: Landmark, color: "#0F766E", bg: "#ECFDF5" },
    { title: "Security", body: "Enterprise-grade security. Encryption, MFA, SSO.", icon: Lock, color: "#D97706", bg: "#FFFBEB" },
  ];

  const overviewPills = [
    "Verified Records",
    "Priority Alerts",
    "Evidence Activity",
    "Verification Summary",
    "Workspace Health",
    "Storage Visibility",
  ];

  return (
    <section id="screens" className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[1560px] px-6 md:px-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#DBEAFE] bg-[#F8FAFC] px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2563EB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            Real product. Real visibility.
          </span>
          <h2 className="mt-5 max-w-[1100px] text-[2.1rem] font-bold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[2.8rem] lg:text-[3.2rem]">
            Built for reviewers, investigators, and administrators.
          </h2>
          <p className="mt-4 max-w-[900px] text-[17px] leading-[1.65] text-[#475569]">
            Give teams a clear operational view of evidence records, intake
            activity, verification results, reports, packages, cases, reviewers,
            tasks, and governance decisions.
          </p>
        </div>

        {/* Tab bar */}
        <div className="mx-auto mt-10 max-w-[1280px] overflow-x-auto">
          <div className="flex min-w-fit items-stretch rounded-[16px] border border-[#E5E7EB] bg-white p-1">
            {tabs.map((t, i) => {
              const Icon = t.icon;
              const active = t.id === "overview";
              return (
                <div
                  key={t.id}
                  className={`relative flex flex-1 items-center justify-center gap-2 rounded-[12px] px-4 text-[13.5px] font-semibold transition ${
                    active
                      ? "shadow-[0_8px_20px_rgba(37,99,235,0.08)]"
                      : "text-[#0F172A]"
                  }`}
                  style={{
                    minHeight: 56,
                    color: active ? "#2563EB" : "#0F172A",
                  }}
                >
                  <Icon size={18} strokeWidth={1.85} style={{ color: t.color }} />
                  <span>{t.label}</span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-4 right-4 h-[2px] rounded-full bg-[#2563EB]"
                    />
                  )}
                  {i < tabs.length - 1 && !active && tabs[i + 1].id !== "overview" && (
                    <span
                      aria-hidden="true"
                      className="absolute right-0 top-1/2 h-5 w-px -translate-y-1/2 bg-[#E5E7EB]"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Dashboard frame — shared component */}
        <div className="mt-8">
          <PlatformDashboardPreview />
        </div>
        {/* Capability strip */}
        <div className="mx-auto mt-4 max-w-[1500px] rounded-[20px] border border-[#E5E7EB] bg-white px-7 py-5 shadow-[0_16px_45px_rgba(15,23,42,0.05)] md:px-8">
          <div className="grid items-center gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 lg:divide-x lg:divide-[#E5E7EB]">
            {capabilities.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.title} className="flex items-start gap-3 lg:pl-5 lg:first:pl-0">
                  <span
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: c.bg }}
                  >
                    <Icon size={18} strokeWidth={1.85} style={{ color: c.color }} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold leading-[1.25] text-[#0F172A]">
                      {c.title}
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-[1.4] text-[#64748B]">
                      {c.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail panel */}
        <div className="mx-auto mt-4 max-w-[1500px] rounded-[20px] border border-[#E5E7EB] bg-white px-7 py-6 md:px-8">
          <div className="grid gap-5 md:grid-cols-[1fr_1.4fr]">
            <div>
              <div className="text-[15px] font-bold text-[#0F172A]">
                Operational Visibility
              </div>
              <p className="mt-2 text-[13px] leading-[1.55] text-[#475569]">
                Monitor evidence health, verification status, reports, packages,
                matters, alerts, storage, and activity from one command center.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {overviewPills.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-[#F8FAFC] px-3.5 py-2 text-[12px] font-semibold text-[#0F172A]"
                >
                  <CheckCircle2 size={13} className="text-[#16A34A]" strokeWidth={2.6} />
                  {p}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustCard({
  title,
  body,
  Icon,
  color,
  bg,
  border,
}: {
  title: string;
  body: string;
  Icon: LucideIcon;
  color: string;
  bg: string;
  border: string;
}) {
  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-[22px] border bg-white/85 p-8 shadow-[0_14px_36px_rgba(15,23,42,0.04)] backdrop-blur-[2px]"
      style={{ borderColor: "#E2E8F0", minHeight: 220 }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-7 right-7 top-0 h-[3px] rounded-full"
        style={{ background: color, opacity: 0.85 }}
      />
      <span
        className="inline-flex h-[68px] w-[68px] items-center justify-center rounded-full"
        style={{ background: bg, color, border: `1px solid ${border}` }}
      >
        <Icon size={30} strokeWidth={1.85} />
      </span>
      <div className="mt-5 text-[17px] font-extrabold leading-[1.2] tracking-[-0.01em] text-[#0F172A]">
        {title}
      </div>
      <div className="mt-2 text-[12.5px] leading-[1.55] text-[#475569]">
        {body}
      </div>
      <div className="mt-auto flex items-center justify-end pt-3">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-full"
          style={{ background: bg, color }}
        >
          <CheckCircle2 size={15} strokeWidth={2.6} />
        </span>
      </div>
    </div>
  );
}

function TrustSection() {
  return (
    <section id="trust" className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1320px] px-6 md:px-8">
        <div className="rounded-[28px] border border-[#E5E7EB] bg-white px-6 py-10 shadow-[0_28px_80px_rgba(15,23,42,0.07)] md:px-10 md:py-12">
          <div className="flex flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#EFF6FF] px-3.5 py-1.5 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#2563EB]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
              Trust & Security
            </span>
            <h2 className="mt-4 max-w-[900px] text-[2rem] font-bold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[2.5rem] lg:text-[2.95rem]">
              Trust signals across the record lifecycle
            </h2>
            <p className="mt-3 max-w-[760px] text-[16px] leading-[1.65] text-[#475569]">
              Every layer of every record is protected, verified, and provable.
            </p>
          </div>

          {/* 7 trust cards — 4 + 3 layout */}
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <TrustCard
              Icon={Fingerprint}
              title="SHA-256 Integrity"
              body="Cryptographic hashing detects any file modification."
              color="#0F766E"
              bg="rgba(15,118,110,0.08)"
              border="rgba(15,118,110,0.22)"
            />
            <TrustCard
              Icon={Clock3}
              title="RFC 3161 Timestamp"
              body="Trusted timestamps from independent timestamp authorities."
              color="#2563EB"
              bg="rgba(37,99,235,0.08)"
              border="rgba(37,99,235,0.22)"
            />
            <TrustCard
              Icon={Anchor}
              title="OpenTimestamp Anchor"
              body="Blockchain anchoring for independent proof of existence."
              color="#15803D"
              bg="rgba(21,128,61,0.08)"
              border="rgba(21,128,61,0.22)"
            />
            <TrustCard
              Icon={PenLine}
              title="Digital Signatures"
              body="Signed outputs for reports, packages, and verification records."
              color="#4F46E5"
              bg="rgba(79,70,229,0.08)"
              border="rgba(79,70,229,0.22)"
            />
            <TrustCard
              Icon={GitBranch}
              title="Chain of Custody"
              body="Every action recorded, time-stamped, and traceable."
              color="#7C3AED"
              bg="rgba(124,58,237,0.08)"
              border="rgba(124,58,237,0.22)"
            />
            <TrustCard
              Icon={ShieldCheck}
              title="Independent Verification"
              body="Verification performed independently from capture and storage."
              color="#BE123C"
              bg="rgba(190,18,60,0.08)"
              border="rgba(190,18,60,0.22)"
            />
            <TrustCard
              Icon={Landmark}
              title="Governance Controls"
              body="Retention, legal hold, access control, and audit oversight."
              color="#EA580C"
              bg="rgba(234,88,12,0.08)"
              border="rgba(234,88,12,0.22)"
            />
          </div>

          {/* Bottom 5-statement enterprise strip */}
          <div className="mt-8 rounded-[22px] border border-[#E5E7EB] bg-[#F8FAFC] px-7 py-6">
            <div className="grid items-center gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-[#E5E7EB]">
              {[
                { icon: ShieldCheck, title: "Tamper-Evident", body: "Every record protected.", color: "#0F766E" },
                { icon: BadgeCheck, title: "Independent Verification", body: "Verification outside capture workflow.", color: "#2563EB" },
                { icon: Clock3, title: "RFC 3161 Timestamped", body: "Trusted time proof.", color: "#2563EB" },
                { icon: GitBranch, title: "Chain of Custody", body: "Complete activity history.", color: "#2563EB" },
                { icon: Landmark, title: "Governance Ready", body: "Built for policy enforcement.", color: "#0F766E" },
              ].map((m) => {
                const Icon = m.icon;
                return (
                  <div key={m.title} className="flex items-center gap-3 lg:pl-6 lg:first:pl-0">
                    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#E5E7EB] bg-white" style={{ color: m.color }}>
                      <Icon size={18} strokeWidth={1.85} />
                    </span>
                    <div>
                      <div className="text-[13px] font-extrabold text-[#0F172A]">{m.title}</div>
                      <div className="mt-0.5 text-[11px] leading-[1.4] text-[#64748B]">{m.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="bg-white pb-16 pt-2 md:pb-20">
      <div className="mx-auto max-w-[1180px] px-6 md:px-8">
        <div
          className="relative overflow-hidden rounded-[28px] p-7 shadow-[0_18px_50px_rgba(11,31,91,0.18)] md:p-9"
          style={{
            background:
              "linear-gradient(90deg,#0B1F5B 0%,#1D2E7A 25%,#8E1F3D 55%,#6A35C9 80%,#7C4DFF 100%)",
            color: "#FFFFFF",
          }}
        >
          <div className="relative grid gap-5 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <div
                className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                style={{ background: "rgba(11,31,91,0.35)", color: "#FFFFFF" }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                Enterprise digital evidence
              </div>
              <h2
                className="mt-3 max-w-[500px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] md:text-[1.85rem]"
                style={{ color: "#FFFFFF" }}
              >
                Modernize your evidence operations.
              </h2>
              <p
                className="mt-2.5 max-w-[500px] text-[13.5px] leading-[1.6]"
                style={{ color: "rgba(255,255,255,0.88)" }}
              >
                Increase trust. Reduce risk. Prove every step with verifiable
                evidence workflows.
              </p>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:justify-end">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#6A35C9] transition-all duration-200 hover:-translate-y-0.5 hover:text-[#5A2CC0]"
                style={{ fontWeight: 600 }}
              >
                Request a demo
                <ArrowRight size={14} />
              </Link>
              <Link
                href={SALES_ASSETS.contactSalesUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/40 px-5 text-[13.5px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10"
              >
                Contact sales
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function PlatformPage() {
  return (
    <div className="page landing-page bg-white">
      <MarketingHeader />
      <PlatformHero />
      <RevealSection direction="up"><LifecycleSection /></RevealSection>
      <RevealSection direction="right"><PlatformWorkspaceSection /></RevealSection>
      <RevealSection direction="left"><PlatformGovernanceControlLayer /></RevealSection>
      <RevealSection direction="up"><SwitchSection /></RevealSection>
      <RevealSection direction="right"><IndustriesSection /></RevealSection>
      <RevealSection direction="left"><ScreensSection /></RevealSection>
      <RevealSection direction="up"><TrustSection /></RevealSection>
      <RevealSection direction="right"><IntegrationsComplianceSection /></RevealSection>
      <RevealSection direction="left"><FinalCTA /></RevealSection>
      <EnterpriseFooter />
    </div>
  );
}
