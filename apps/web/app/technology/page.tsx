"use client";

// =========================================================================
// /technology — premium enterprise architecture page.
//
// Single, in-depth page. Section anchors (#ai-architecture,
// #verification-architecture, #security-architecture,
// #governance-architecture) are preserved so the redirects from the
// retired detail subpages (cryptographic-hashing, digital-signatures,
// trusted-timestamps, opentimestamps, chain-of-custody) land cleanly.
//
// Safe-language contract:
//   - records integrity signals
//   - preserves verification context
//   - exposes custody history
//   - supports reviewer inspection
//   - advisory AI assistance
//   - governance-ready evidence operations
//
// Safe-language contract: this page must NOT claim any external
// certification status, qualified trust service status, legal
// admissibility, court acceptance, truth determination, identity
// verification, authorship, intent, liability, or credibility.
// Use generic phrasing only: security review, vendor assessment,
// enterprise evaluation, governance documentation, compliance review.
// =========================================================================

import { Fragment } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  RevealSection as SharedRevealSection,
} from "../../components/motion";
import {
  Sparkles,
  ShieldCheck,
  Lock,
  Building2,
  Fingerprint,
  Clock3,
  Anchor,
  PenLine,
  Link2,
  PackageCheck,
  Inbox,
  Database,
  FileCheck2,
  Eye,
  FileText,
  Workflow,
  KeyRound,
  Server,
  Users,
  Briefcase,
  Search,
  Building,
  UserCircle2,
  Scale,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  BadgeCheck,
  FileBadge,
  ArrowRight,
  Globe,
  Camera,
  Upload,
  Check,
  Box,
  Settings,
  Play,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { SALES_ASSETS } from "../../lib/sales-assets";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

// =========================================================================
// Shared primitives
// =========================================================================

// =========================================================================
// HERO
// =========================================================================

function Hero() {
  // Trust row — 6 signals as Pricing-style filled colored circles with
  // white icons. No white card wrappers; just icon + label.
  const SIGNALS: { label: string; Icon: LucideIcon; color: string }[] = [
    { label: "Cryptographic integrity", Icon: Fingerprint, color: "bg-cyan-500 shadow-cyan-500/25" },
    { label: "Timestamp context", Icon: Clock3, color: "bg-orange-500 shadow-orange-500/25" },
    { label: "Custody history", Icon: Link2, color: "bg-violet-600 shadow-violet-600/25" },
    { label: "Independent verification", Icon: ShieldCheck, color: "bg-emerald-500 shadow-emerald-500/25" },
    { label: "Reviewer-ready reports", Icon: FileText, color: "bg-pink-500 shadow-pink-500/25" },
    { label: "Governed access", Icon: Lock, color: "bg-blue-600 shadow-blue-600/25" },
  ];


  return (
    <section className="relative overflow-hidden bg-white">
      {/* FULL HERO BACKGROUND — technology-hero.png covers the entire hero
          section across both columns. className-only so SSR/CSR stay in
          sync (no inline style → no hydration mismatch). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-[url('/assets/hero/technology-hero.png')] bg-cover bg-[position:center_right] bg-no-repeat"
      />
      {/* Very subtle uniform readability wash. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-white/20"
      />

      <div className="relative z-10">
        <MarketingHeader />

        <div
          className="mx-auto grid max-w-[1520px] gap-12 px-6 pb-12 pt-14 md:px-8 md:pb-14 md:pt-20 lg:grid-cols-[minmax(0,640px)_1fr] lg:items-center lg:gap-16 lg:pb-16 lg:pt-24"
          style={{ minHeight: "min(720px, calc(100vh - 96px))" }}
        >
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#DDE7F3] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
              Technology
            </span>
            <h1 className="mt-5 max-w-[640px] text-[2.1rem] font-semibold leading-[1.06] tracking-[-0.028em] text-[#071326] md:text-[2.85rem] lg:text-[3.4rem]">
              Technology built for evidence you can{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: "linear-gradient(90deg,#2563EB 0%,#7C3AED 60%,#DB2777 100%)" }}
              >
                verify.
              </span>
            </h1>
            <p className="mt-5 max-w-[600px] text-[15.5px] leading-[1.7] text-[#526176] md:text-[16.5px]">
              PROOVRA combines cryptographic fingerprints, trusted timestamp
              context, custody history, governed access, independent
              verification, and reviewer-ready reporting into one evidence
              operations architecture.
            </p>

            {/* Trust row — 6 filled colored circular icons with white
                glyphs, matching the Pricing hero treatment. No card box
                around each item. */}
            <ul className="mt-8 grid max-w-[680px] grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
              {SIGNALS.map(({ label, Icon, color }) => (
                <li key={label} className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white shadow-lg ${color}`}
                  >
                    <Icon className="h-5 w-5" strokeWidth={2.2} />
                  </span>
                  <span className="text-[15px] font-semibold leading-tight text-slate-950">
                    {label}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#0B1E3A] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_30px_rgba(11,30,58,0.32)] transition-all hover:bg-[#091628] hover:-translate-y-0.5"
              >
                Request a demo
                <ArrowRight size={16} />
              </Link>
              <a
                href={SALES_ASSETS.sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={MARKETING_BTN.heroSecondary}
              >
                View sample report
              </a>
            </div>
          </div>

          {/* Right column intentionally empty — the hero image is now the
              full-section background. This second grid track keeps the
              left text constrained to ~640px and lets the photo dominate
              the right half of the hero unobstructed. */}
          <div aria-hidden className="hidden lg:block" />
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// 12 — FINAL CTA
// =========================================================================

function FinalCTA() {
  // Flagship enterprise CTA per the reference spec — deep navy→blue→violet
  // gradient with subtle dotted-mesh background and white-on-navy + outlined
  // buttons on the right. Generous top padding separates this card from the
  // FAQ section above so the CTA reads as a fresh major section, not a
  // continuation of the FAQ list.
  return (
    <section className="relative mx-auto max-w-[1320px] px-6 pt-16 pb-12 md:px-8 md:pt-20 md:pb-16">
      <div
        className="relative overflow-hidden rounded-[28px] p-8 text-white shadow-[0_32px_80px_rgba(6,20,46,0.40)] md:p-12"
        style={{
          background:
            "linear-gradient(120deg,#06142E 0%,#123B7A 35%,#2563EB 70%,#7C3AED 100%)",
        }}
      >
        {/* Subtle dotted grid mesh at the bottom for technical depth. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-[0.10]"
          style={{
            backgroundImage:
              "radial-gradient(circle, #FFFFFF 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
          }}
        />
        {/* Floating radial accent on the right. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(219,39,119,0.22) 0%, transparent 70%)",
          }}
        />

        <div className="relative grid items-center gap-8 md:grid-cols-[1fr_auto] md:gap-10">
          <div>
            <h2 className="text-[1.6rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[2rem]">
              See PROOVRA&apos;s evidence operations architecture in action.
            </h2>
            <p className="mt-3 max-w-[640px] text-[15px] leading-[1.7] text-white/85">
              Book a demo to see how capture, integrity signals, custody
              history, reports, governance controls, and reviewer access work
              together across an evidence record.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 md:flex-nowrap md:justify-end">
            <Link
              href={SALES_ASSETS.requestDemoUrl}
              className="inline-flex h-11 items-center justify-center whitespace-nowrap rounded-[14px] bg-white px-6 text-[14px] font-semibold text-[#0B1E3A] shadow-[0_10px_24px_rgba(0,0,0,0.28)] transition hover:-translate-y-0.5"
            >
              Request a demo
            </Link>
            <a
              href={SALES_ASSETS.sampleReportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center justify-center whitespace-nowrap rounded-[14px] border border-white/40 bg-transparent px-6 text-[14px] font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/10"
            >
              View sample report
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// V44 — NEW TECHNOLOGY PAGE BODY (14 SECTIONS)
// Real product images, controlled palette, image-led editorial sections.
// Hero, header, and footer are NOT touched.
// =========================================================================

const TECH = {
  bg: "#F6F8FB",
  bgSoft: "#EEF4FA",
  card: "#FFFFFF",
  border: "#DDE6F0",
  text: "#0B1220",
  muted: "#5B6B82",
  blue: "#2563EB",
  blueDark: "#0B2A66",
  green: "#10A37F",
  orange: "#F97316",
  red: "#DC2626",
} as const;

function TechEyebrow({ children, color = TECH.blue }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]"
      style={{ color, borderColor: TECH.border }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

// ───── Animation primitives — delegate to the shared IntersectionObserver
// based motion components in `components/motion`. No external animation
// library dependency. The wrappers below preserve the original public
// signatures used throughout this file so every existing call site keeps
// working unchanged.

function SectionScene({
  children,
  direction = "up",
  className,
}: {
  children: ReactNode;
  direction?: "up" | "left" | "right";
  className?: string;
}) {
  return (
    <SharedRevealSection direction={direction} className={className} amount={0.18}>
      {children}
    </SharedRevealSection>
  );
}

// AnimatedHeading + TechH2 + TechBody render as plain semantic elements.
//
// 2026-06-24: the previous implementation delegated to
// `SharedAnimatedHeading` / `SharedRevealText`, both of which wrap their
// content in a `<div style="display: contents">` ref so the
// IntersectionObserver could attach without a polymorphic ref. The trade-off
// is that `display: contents` boxes have a zero-area bounding rect, and
// most browsers' IntersectionObserver therefore never reports them as
// `isIntersecting`. The net effect was that every TechH2 + TechBody
// rendered at `opacity: 0` permanently — the headings WERE there, but
// invisible, which read on screen as a giant blank gap between the
// eyebrow chip and the section content. The shared motion components
// are still used elsewhere; only this page bypasses them.
function AnimatedHeading({
  children,
  center,
  className,
}: {
  children: ReactNode;
  center?: boolean;
  className?: string;
}) {
  const base = `${center ? "mx-auto text-center" : ""} mt-3 max-w-[860px] text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.4rem]`;
  const finalClass = className ?? base;
  return (
    <h2 className={finalClass} style={{ color: TECH.text }}>
      {children}
    </h2>
  );
}

function TechH2({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <AnimatedHeading center={center}>{children}</AnimatedHeading>;
}

function TechBody({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return (
    <p
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[760px] text-[15.5px] leading-[1.7]`}
      style={{ color: TECH.muted }}
    >
      {children}
    </p>
  );
}

// Shared gradient treatment matching the homepage "Complete Evidence Lifecycle"
// heading. Use on the emphasized phrase inside every main section title on
// /technology so all headings share the same color hierarchy.
function TechGradient({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg,#2563EB 0%,#7C3AED 50%,#DB2777 100%)",
      }}
    >
      {children}
    </span>
  );
}

// 1 — TECHNOLOGY NARRATIVE / EVIDENCE OPERATIONS INTRO ----------------------
const TECH_PURPLE = "#7C3AED";
const TECH_BORDER_PLAT = "#DDE7F3";

function LifecycleStrip({
  steps,
  className = "",
  iconSize = 52,
  cardPad = "px-6 py-8 md:px-10 md:py-10",
}: {
  steps: { label: string; Icon: LucideIcon; color: string }[];
  className?: string;
  iconSize?: number;
  cardPad?: string;
}) {
  return (
    <div
      className={`rounded-[28px] border bg-white ${cardPad} ${className}`}
      style={{
        borderColor: TECH_BORDER_PLAT,
        boxShadow: "0 18px 48px rgba(15, 23, 42, 0.06)",
      }}
    >
      <ol className="flex flex-wrap items-start justify-center gap-y-6 md:flex-nowrap md:justify-between">
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            <li className="flex min-w-[84px] flex-col items-center text-center">
              <span
                aria-hidden
                className="flex items-center justify-center rounded-full"
                style={{
                  width: iconSize,
                  height: iconSize,
                  background: `${s.color}12`,
                  border: `1px solid ${s.color}3D`,
                }}
              >
                <s.Icon
                  size={Math.round(iconSize * 0.42)}
                  strokeWidth={1.85}
                  style={{ color: s.color }}
                />
              </span>
              <span
                className="mt-3 text-[13px] font-semibold tracking-tight"
                style={{ color: TECH.text }}
              >
                {s.label}
              </span>
            </li>
            {i < steps.length - 1 ? (
              <li
                aria-hidden
                className="hidden flex-1 items-center md:flex"
                style={{ marginTop: iconSize / 2 - 1 }}
              >
                <span
                  className="h-px w-full"
                  style={{ background: "#C9D7EA" }}
                />
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
    </div>
  );
}

// 2 — HOW THE TECHNOLOGY WORKS ----------------------------------------------
function HowTechnologyWorks() {
  const ORANGE = "#FF9F43";
  const BLUE = "#4F8DFF";
  const GREEN = "#38D39F";

  const HERO_BULLETS: { Icon: LucideIcon; title: string; body: string }[] = [
    {
      Icon: Link2,
      title: "Secure Intake Links",
      body: "Guided evidence requests delivered through secure links.",
    },
    {
      Icon: Fingerprint,
      title: "Integrity Signals",
      body: "Hashing, timestamps, and verification context attached to records.",
    },
    {
      Icon: BadgeCheck,
      title: "Reviewer Ready",
      body: "Evidence packages prepared for review, sharing, and case workflows.",
    },
  ];
  const RECORD_ROWS: { l: string; v: string; verified?: boolean; link?: boolean }[] = [
    { l: "Capture Source", v: "Mobile Submission" },
    { l: "Timestamp", v: "Jun 22, 2026" },
    { l: "Integrity", v: "Verified", verified: true },
    { l: "SHA-256", v: "Verified", verified: true },
    { l: "Custody Events", v: "7 Events" },
    { l: "Verification Page", v: "Available", link: true },
  ];
  const TIMELINE: { n: number; Icon: LucideIcon; label: string; color: string }[] = [
    { n: 1, Icon: Inbox, label: "Intake", color: ORANGE },
    { n: 2, Icon: Camera, label: "Capture", color: ORANGE },
    { n: 3, Icon: Fingerprint, label: "Integrity", color: BLUE },
    { n: 4, Icon: Clock3, label: "Custody", color: BLUE },
    { n: 5, Icon: ShieldCheck, label: "Verification", color: GREEN },
    { n: 6, Icon: FileText, label: "Report", color: ORANGE },
    { n: 7, Icon: Box, label: "Package", color: BLUE },
    { n: 8, Icon: Eye, label: "Review", color: GREEN },
  ];
  const TRUST_BAR: { Icon: LucideIcon; title: string; body: string }[] = [
    { Icon: ShieldCheck, title: "End-to-End Integrity", body: "Cryptographic verification attached" },
    { Icon: FileCheck2, title: "Structured Review", body: "Evidence prepared for inspection" },
    { Icon: Lock, title: "Tamper-Evident Workflow", body: "Verification context preserved" },
    { Icon: Eye, title: "Full Traceability", body: "Custody history retained" },
    { Icon: Building2, title: "Enterprise Ready", body: "Built for organizational workflows" },
  ];

  return (
    <section
      className="relative overflow-hidden py-16 md:py-20"
      style={{
        backgroundColor: "#0B1420",
        backgroundImage:
          "radial-gradient(60% 50% at 30% 0%, rgba(79,141,255,0.10) 0%, rgba(79,141,255,0) 70%), radial-gradient(50% 50% at 90% 60%, rgba(255,159,67,0.08) 0%, rgba(255,159,67,0) 70%), linear-gradient(180deg, rgba(8,16,24,0.72) 0%, rgba(11,20,32,0.68) 50%, rgba(16,24,38,0.70) 100%), url('/assets/cards/icon-card.png')",
        backgroundSize: "auto, auto, auto, cover",
        backgroundPosition: "center, center, center, center",
        backgroundRepeat: "no-repeat, no-repeat, no-repeat, no-repeat",
      }}
    >

      <div
        className="relative mx-auto"
        style={{ width: "min(100% - 32px, 1600px)" }}
      >
        {/* 3-column hero */}
        <div className="grid items-stretch gap-10 lg:grid-cols-[0.95fr_1.55fr_0.95fr] lg:gap-12">
          {/* LEFT — Headline */}
          <div>
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em]"
              style={{
                color: ORANGE,
                background: "rgba(249,115,22,0.10)",
                border: "1px solid rgba(249,115,22,0.32)",
              }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: ORANGE }} />
              Verified evidence workflow
            </span>
            <h2
              className="mt-6 text-[40px] font-extrabold leading-[1.05] tracking-[-0.025em] sm:text-[48px] md:text-[54px] lg:text-[58px]"
              style={{ color: "#FFFFFF" }}
            >
              From secure intake to{" "}
              <TechGradient>review-ready evidence.</TechGradient>
            </h2>
            <p
              className="mt-6 max-w-[480px] text-[16px] leading-[1.7]"
              style={{ color: "rgba(203,213,225,0.85)" }}
            >
              PROOVRA transforms evidence requests into structured records
              with integrity verification, custody tracking, verification
              surfaces, reports, and reviewer-ready packages.
            </p>

            <ul className="mt-8 grid gap-5">
              {HERO_BULLETS.map((b) => (
                <li key={b.title} className="flex items-start gap-4">
                  <span
                    aria-hidden
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                    style={{
                      background: "rgba(249,115,22,0.10)",
                      border: "1px solid rgba(249,115,22,0.35)",
                    }}
                  >
                    <b.Icon size={19} strokeWidth={1.9} style={{ color: ORANGE }} />
                  </span>
                  <div>
                    <div
                      className="text-[14px] font-bold uppercase tracking-[0.06em]"
                      style={{ color: "#FFFFFF" }}
                    >
                      {b.title}
                    </div>
                    <p className="mt-1 text-[13.5px] leading-[1.55]" style={{ color: "rgba(203,213,225,0.75)" }}>
                      {b.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* CENTER — Hero image dominant. Fills the column height so it
              extends down toward the timeline row instead of sitting as
              a small thumbnail at the top. */}
          <div className="relative flex">
            <div
              className="relative w-full overflow-hidden rounded-[28px] lg:min-h-[560px]"
              style={{
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 36px 90px rgba(0,0,0,0.50)",
                background: "#000",
                minHeight: 420,
              }}
            >
              <img
                src="/images/property-condition-capture-intake-request.png"
                alt="Mobile evidence capture of a damaged property ceiling through a PROOVRA secure intake link"
                className="absolute inset-0 h-full w-full object-cover"
                style={{ objectPosition: "center" }}
              />
            </div>
          </div>

          {/* RIGHT — Evidence record card */}
          <div
            className="rounded-[22px] p-6 md:p-7"
            style={{
              background: "rgba(15,23,42,0.65)",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 28px 70px rgba(0,0,0,0.40)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="flex h-6 w-6 items-center justify-center rounded-full"
                style={{
                  background: "rgba(16,185,129,0.16)",
                  border: "1px solid rgba(16,185,129,0.40)",
                }}
              >
                <CheckCircle2 size={13} strokeWidth={2.6} style={{ color: GREEN }} />
              </span>
              <span
                className="text-[11px] font-bold uppercase tracking-[0.22em]"
                style={{ color: "rgba(203,213,225,0.85)" }}
              >
                Property condition verified
              </span>
            </div>
            <div className="mt-5 flex items-center justify-between gap-3">
              <div
                className="text-[22px] font-extrabold tracking-[-0.01em] md:text-[24px]"
                style={{ color: "#FFFFFF" }}
              >
                ER-2026-04812
              </div>
              <span
                className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em]"
                style={{
                  color: GREEN,
                  background: "rgba(16,185,129,0.12)",
                  border: "1px solid rgba(16,185,129,0.38)",
                }}
              >
                Verified
              </span>
            </div>
            <ul className="mt-5 grid gap-3">
              {RECORD_ROWS.map((r) => (
                <li
                  key={r.l}
                  className="flex items-center justify-between pb-2.5 text-[13px]"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span style={{ color: "rgba(148,163,184,0.85)" }}>{r.l}</span>
                  <span
                    className={r.verified || r.link ? "font-semibold" : ""}
                    style={{
                      color: r.verified ? GREEN : r.link ? "#60A5FA" : "#FFFFFF",
                    }}
                  >
                    {r.v}
                  </span>
                </li>
              ))}
            </ul>
            <div
              className="mt-5 flex items-center gap-2.5 rounded-[12px] px-4 py-3"
              style={{
                background: "rgba(16,185,129,0.10)",
                border: "1px solid rgba(16,185,129,0.30)",
              }}
            >
              <CheckCircle2 size={15} strokeWidth={2.4} style={{ color: GREEN }} />
              <span className="text-[12.5px] font-semibold" style={{ color: GREEN }}>
                Verified &amp; Secured
              </span>
            </div>
          </div>
        </div>

        {/* MIDDLE — 8-stage workflow timeline */}
        <div className="mt-8 md:mt-10">
          <div
            className="rounded-[20px] px-6 py-7 md:px-8 md:py-8"
            style={{
              background: "rgba(15,23,42,0.55)",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 22px 60px rgba(0,0,0,0.35)",
            }}
          >
            <div className="-mx-2 overflow-x-auto md:mx-0 md:overflow-visible">
              <ol className="flex min-w-[820px] items-start justify-between gap-2 md:min-w-0">
                {TIMELINE.map((s, i) => (
                  <Fragment key={s.label}>
                    <li className="flex min-w-[80px] flex-col items-center text-center">
                      <span
                        aria-hidden
                        className="relative flex h-[56px] w-[56px] items-center justify-center rounded-full"
                        style={{
                          background: `${s.color}1A`,
                          border: `1.5px solid ${s.color}66`,
                          boxShadow: `0 10px 26px ${s.color}33`,
                        }}
                      >
                        <s.Icon size={22} strokeWidth={1.85} style={{ color: s.color }} />
                        <span
                          className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9.5px] font-bold"
                          style={{ background: "#FFFFFF", color: "#0B1420" }}
                        >
                          {s.n}
                        </span>
                      </span>
                      <div
                        className="mt-3 text-[13px] font-bold tracking-tight"
                        style={{ color: "#FFFFFF" }}
                      >
                        {s.label}
                      </div>
                    </li>
                    {i < TIMELINE.length - 1 ? (
                      <li
                        aria-hidden
                        className="flex flex-1 items-start justify-center pt-[22px]"
                      >
                        <span
                          className="h-px w-full"
                          style={{
                            background:
                              "linear-gradient(90deg, rgba(96,165,250,0.45) 0%, rgba(16,185,129,0.45) 50%, rgba(249,115,22,0.45) 100%)",
                          }}
                        />
                      </li>
                    ) : null}
                  </Fragment>
                ))}
              </ol>
            </div>
          </div>
        </div>

        {/* BOTTOM TRUST BAR — 5 items */}
        <div
          className="mt-8 grid gap-0 rounded-[18px] sm:grid-cols-2 lg:grid-cols-5"
          style={{
            background: "rgba(15,23,42,0.45)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {TRUST_BAR.map((t, i) => (
            <div
              key={t.title}
              className="flex items-start gap-3.5 px-5 py-5"
              style={{
                borderLeft:
                  i === 0 ? "none" : "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                style={{
                  background: "rgba(249,115,22,0.10)",
                  border: "1px solid rgba(249,115,22,0.35)",
                }}
              >
                <t.Icon size={16} strokeWidth={1.9} style={{ color: ORANGE }} />
              </span>
              <div>
                <div
                  className="text-[13.5px] font-bold tracking-[-0.005em]"
                  style={{ color: "#FFFFFF" }}
                >
                  {t.title}
                </div>
                <div
                  className="mt-0.5 text-[11.5px] leading-[1.45]"
                  style={{ color: "rgba(148,163,184,0.8)" }}
                >
                  {t.body}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// 2b — HOW IT WORKS (restored approved light design) ------------------------
function HowItWorksRestored() {
  const STEPS: { title: string; body: string }[] = [
    { title: "Capture", body: "Evidence enters through guided intake links, mobile capture, upload flows, or system integrations." },
    { title: "Integrity", body: "SHA-256 fingerprints and timestamp context are attached to the record." },
    { title: "Custody", body: "Meaningful actions are recorded as custody events with actor and timing context." },
    { title: "Verification", body: "Integrity status, timing context, custody history, and outputs become inspectable." },
    { title: "Report", body: "Structured reports summarize the record, signals, custody history, and review context." },
    { title: "Package", body: "Evidence packages bundle reports, metadata, integrity references, and supporting materials." },
  ];
  const FLOW: { label: string; Icon: LucideIcon; color: string }[] = [
    { label: "Request", Icon: Inbox, color: TECH.blue },
    { label: "Capture", Icon: FileBadge, color: TECH.orange },
    { label: "Integrity", Icon: Fingerprint, color: TECH.blue },
    { label: "Custody", Icon: Link2, color: TECH.blue },
    { label: "Verification", Icon: ShieldCheck, color: TECH.green },
    { label: "Report", Icon: FileText, color: TECH.blue },
    { label: "Package", Icon: PackageCheck, color: TECH_PURPLE },
    { label: "Review", Icon: Eye, color: TECH.green },
  ];
  const FEATURES: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
    {
      Icon: ShieldCheck,
      title: "Defensible by design",
      body: "Cryptographic integrity, verifiable timestamps, and an unbroken chain of custody.",
      color: TECH.blue,
    },
    {
      Icon: Users,
      title: "Built for enterprise",
      body: "Role-based access, audit logs, data residency, and policy enforcement at scale.",
      color: TECH.blue,
    },
    {
      Icon: Lock,
      title: "Trusted everywhere",
      body: "Verification pages give anyone the right view, without exposing sensitive data.",
      color: TECH.green,
    },
    {
      Icon: PackageCheck,
      title: "Evidence that travels",
      body: "Packages bundle everything needed for sharing, production, or downstream systems.",
      color: TECH_PURPLE,
    },
  ];
  return (
    <section className="relative overflow-hidden bg-white py-16 md:py-20">
      {/* Soft radial glow behind the main image */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[260px] mx-auto"
        style={{
          width: "60%",
          height: 520,
          background:
            "radial-gradient(60% 60% at 30% 50%, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0) 70%)",
          filter: "blur(40px)",
        }}
      />
      <div className="relative mx-auto max-w-[1240px] px-6 md:px-8">
        {/* Top centered title block */}
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <TechEyebrow>How it works</TechEyebrow>
          <TechH2 center>
            How PROOVRA turns captured material into{" "}
            <TechGradient>reviewable evidence.</TechGradient>
          </TechH2>
          <TechBody center>
            Every record moves through accountable technical layers. Each layer
            creates context the next layer can reference.
          </TechBody>
        </div>

        {/* Main content grid */}
        <div className="mt-6 grid gap-12 md:mt-8 lg:grid-cols-[1.38fr_1fr] lg:items-center lg:gap-[64px]">
          <div
            className="overflow-hidden rounded-[28px]"
            style={{
              border: "1px solid rgba(15, 23, 42, 0.08)",
              boxShadow: "0 28px 80px rgba(15, 23, 42, 0.16)",
            }}
          >
            <img
              src="/images/evidence-review-workspace.png"
              alt="Reviewer inspecting a PROOVRA evidence dashboard with integrity signals, custody events, and reviewer surfaces"
              className="block h-auto w-full object-cover"
            />
          </div>
          <ol className="relative">
            <span
              aria-hidden
              className="absolute left-[23px] top-5 bottom-5 w-px"
              style={{ background: "#BCD4FF" }}
            />
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                className="relative grid grid-cols-[48px_1fr] items-start gap-5 pb-[30px] last:pb-0"
              >
                <span
                  aria-hidden
                  className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full"
                  style={{
                    background: "#EEF5FF",
                    border: "1px solid #BCD4FF",
                  }}
                >
                  <span
                    className="font-mono text-[13px] font-semibold tracking-[0.04em]"
                    style={{ color: "#2563EB" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </span>
                <div className="pt-1">
                  <h3
                    className="text-[17px] font-semibold tracking-[-0.005em]"
                    style={{ color: TECH.text }}
                  >
                    {s.title}
                  </h3>
                  <p
                    className="mt-1.5 text-[14.5px] leading-[1.65]"
                    style={{ color: TECH.muted }}
                  >
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Bottom lifecycle strip */}
        <LifecycleStrip
          steps={FLOW}
          className="mt-8 md:mt-10"
          iconSize={48}
          cardPad="px-5 py-7 md:px-8 md:py-8"
        />

        {/* Bottom 4 capability cards */}
        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="flex h-full flex-col rounded-[22px] border bg-white px-6 py-7"
              style={{
                borderColor: TECH_BORDER_PLAT,
                boxShadow: "0 10px 30px rgba(15, 23, 42, 0.05)",
              }}
            >
              <span
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-full"
                style={{
                  background: `${f.color}14`,
                  border: `1px solid ${f.color}3D`,
                }}
              >
                <f.Icon size={20} strokeWidth={1.9} style={{ color: f.color }} />
              </span>
              <h3
                className="mt-5 text-[16.5px] font-semibold tracking-[-0.005em]"
                style={{ color: f.color }}
              >
                {f.title}
              </h3>
              <p
                className="mt-2 text-[14px] leading-[1.65]"
                style={{ color: TECH.muted }}
              >
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// 3 — EVIDENCE INTAKE & GUIDED CAPTURE ---------------------------------------
function EvidenceIntakeCapture() {
  const HERO_CHECKS: string[] = [
    "Incident evidence captured",
    "Witness context attached",
    "Timeline preserved",
    "Ready for review",
  ];
  const EXAMPLES: {
    img: string;
    industry: string;
    title: string;
    body: string;
    alt: string;
  }[] = [
    {
      img: "/images/insurance-intake-request.png",
      industry: "Insurance",
      title: "Insurance Claim Example",
      body: "Example workflow showing how claimants can submit structured evidence through guided intake links.",
      alt: "Example evidence workflow — claimant capturing incident evidence through a PROOVRA intake request",
    },
    {
      img: "/images/construction-progress-capture.png",
      industry: "Construction",
      title: "Construction Documentation Example",
      body: "Example workflow showing how field teams can collect evidence and project records directly from the job site.",
      alt: "Example evidence workflow — contractor capturing progress on a construction site with PROOVRA",
    },
    {
      img: "/images/logistics-damage-capture.png",
      industry: "Logistics",
      title: "Logistics Incident Example",
      body: "Example workflow showing how organizations document damaged deliveries and prepare records for review.",
      alt: "Example evidence workflow — logistics worker documenting a damaged delivery with PROOVRA",
    },
  ];
  const PILLARS: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
    {
      Icon: Workflow,
      title: "One workflow",
      body: "Capture, review, and package evidence through a consistent process.",
      color: TECH.orange,
    },
    {
      Icon: Fingerprint,
      title: "Integrity attached",
      body: "Cryptographic references travel with every record.",
      color: TECH.blue,
    },
    {
      Icon: CheckCircle2,
      title: "Review ready",
      body: "Records move directly into verification and reviewer workflows.",
      color: TECH.green,
    },
    {
      Icon: Globe,
      title: "Industry agnostic",
      body: "The same workflow adapts to many evidence scenarios.",
      color: TECH_PURPLE,
    },
  ];

  return (
    <section
      style={{ background: "#F7FAFC" }}
      className="py-12 md:py-14 lg:py-16"
    >
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        {/* Heading area — compact */}
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <TechEyebrow color={TECH.orange}>Intake &amp; capture</TechEyebrow>
          <TechH2 center>
            One intake workflow.
            <br />
            <TechGradient>Many evidence scenarios.</TechGradient>
          </TechH2>
          <TechBody center>
            Organizations use the same PROOVRA intake, capture, integrity,
            custody, verification, reporting, and packaging workflow across
            many types of evidence operations. The examples below demonstrate
            different scenarios — not different products.
          </TechBody>
        </div>

        {/* HERO SHOWCASE CARD — single composed enterprise card with
            aspect-ratio constrained image + overlay; no fixed pixel heights
            that push content below the fold. */}
        <div className="mt-6 md:mt-8">
          <div
            className="relative overflow-hidden rounded-[28px]"
            style={{
              border: "1px solid rgba(15, 23, 42, 0.08)",
              boxShadow: "0 24px 60px rgba(15, 23, 42, 0.10)",
              background: "#0B1220",
              aspectRatio: "16 / 7",
              maxHeight: 520,
            }}
          >
            <img
              src="/images/workplace-incident-capture.png"
              alt="Example evidence workflow — workplace incident capture with structured context through a PROOVRA intake request"
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: "center" }}
            />
            {/* Right-to-left dark scrim so the overlay panel sits legibly
                on the bottom-left without dominating the image. */}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(90deg, rgba(7,21,47,0.78) 0%, rgba(7,21,47,0.40) 36%, rgba(7,21,47,0) 62%)",
              }}
            />
            {/* Overlay panel bottom-left — kept inside the image card. */}
            <div className="absolute bottom-4 left-4 right-4 md:bottom-6 md:left-6 md:right-auto md:max-w-[480px]">
              <div
                className="rounded-[20px] p-5 md:p-6"
                style={{
                  background: "rgba(7, 21, 47, 0.74)",
                  backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <span
                  className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                  style={{
                    color: "#FFFFFF",
                    borderColor: "rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: TECH.orange }}
                  />
                  Example
                </span>
                <h3 className="mt-2.5 text-[19px] font-bold tracking-[-0.01em] text-white md:text-[22px]">
                  Workplace Incident Example
                </h3>
                <p className="mt-1.5 hidden text-[13px] leading-[1.55] text-white/85 md:block md:text-[13.5px]">
                  A workplace incident can be captured with structured
                  context, supporting evidence, and a review-ready timeline
                  for internal investigation.
                </p>
                <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
                  {HERO_CHECKS.map((c) => (
                    <li
                      key={c}
                      className="flex items-center gap-2 text-[12.5px] text-white/95"
                    >
                      <span
                        aria-hidden
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: `${TECH.green}26`,
                          border: `1px solid ${TECH.green}66`,
                        }}
                      >
                        <CheckCircle2
                          size={9}
                          strokeWidth={2.6}
                          style={{ color: TECH.green }}
                        />
                      </span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Example evidence workflows — compact gap, tighter intro */}
        <div className="mt-8 md:mt-10">
          <div className="mx-auto flex max-w-[680px] flex-col items-center text-center">
            <span
              className="text-[11px] font-semibold uppercase tracking-[0.22em]"
              style={{ color: TECH.muted }}
            >
              Example evidence workflows
            </span>
            <h3
              className="mt-3 text-[22px] font-bold tracking-[-0.015em] md:text-[26px]"
              style={{ color: "#07152F" }}
            >
              Three scenarios, one platform.
            </h3>
            <p
              className="mt-3 text-[14px] leading-[1.65]"
              style={{ color: TECH.muted }}
            >
              Industry tags below describe each example — not a product
              category. The underlying evidence lifecycle is identical.
            </p>
          </div>
          <div className="mt-8 grid gap-6 md:mt-10 md:grid-cols-3">
            {EXAMPLES.map((e) => (
              <article
                key={e.title}
                className="flex h-full flex-col overflow-hidden rounded-[22px] bg-white"
                style={{
                  border: "1px solid #DCE7F3",
                  boxShadow: "0 12px 28px rgba(15, 23, 42, 0.05)",
                }}
              >
                <div
                  className="relative w-full"
                  style={{ aspectRatio: "16 / 10" }}
                >
                  <img
                    src={e.img}
                    alt={e.alt}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-1 flex-col p-5 md:p-6">
                  <span
                    className="inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.16em]"
                    style={{
                      color: TECH.muted,
                      background: "#EEF2F7",
                      border: "1px solid #E2EAF4",
                    }}
                  >
                    {e.industry}
                  </span>
                  <h4
                    className="mt-3 text-[16.5px] font-semibold tracking-[-0.005em]"
                    style={{ color: "#07152F" }}
                  >
                    {e.title}
                  </h4>
                  <p
                    className="mt-2 text-[13.5px] leading-[1.6]"
                    style={{ color: TECH.muted }}
                  >
                    {e.body}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>

        {/* Enterprise message band — 4 trust pillars, compact */}
        <div
          className="mt-12 rounded-[26px] px-6 py-7 md:mt-14 md:px-10 md:py-8"
          style={{
            background:
              "linear-gradient(180deg, #EEF4FB 0%, #F7FAFC 100%)",
            border: "1px solid #DCE7F3",
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.05)",
          }}
        >
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {PILLARS.map((p) => (
              <div key={p.title} className="flex flex-col">
                <span
                  aria-hidden
                  className="flex h-10 w-10 items-center justify-center rounded-full"
                  style={{
                    background: `${p.color}14`,
                    border: `1px solid ${p.color}3D`,
                  }}
                >
                  <p.Icon size={17} strokeWidth={1.9} style={{ color: p.color }} />
                </span>
                <h4
                  className="mt-3 text-[15.5px] font-semibold tracking-[-0.005em]"
                  style={{ color: "#07152F" }}
                >
                  {p.title}
                </h4>
                <p
                  className="mt-1 text-[13px] leading-[1.6]"
                  style={{ color: TECH.muted }}
                >
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// 5 — CHAIN OF CUSTODY TECHNOLOGY --------------------------------------------
function CustodyTechnology() {
  const NODES: {
    Icon: LucideIcon;
    action: string;
    actor: string;
    t: string;
    status: "complete" | "review";
  }[] = [
    { Icon: Camera, action: "Capture", actor: "by intake user", t: "14:11:21 UTC", status: "complete" },
    { Icon: Upload, action: "Upload", actor: "by system", t: "14:11:34 UTC", status: "complete" },
    { Icon: Check, action: "Complete", actor: "by system", t: "14:12:18 UTC", status: "complete" },
    { Icon: FileText, action: "Report Generated", actor: "by system", t: "14:33:19 UTC", status: "complete" },
    { Icon: Box, action: "Package Created", actor: "by system", t: "14:14:08 UTC", status: "complete" },
    { Icon: UserCircle2, action: "Reviewer Accessed", actor: "by external", t: "09:18:12 UTC", status: "review" },
    { Icon: Eye, action: "Verification Opened", actor: "by external", t: "09:22:03 UTC", status: "review" },
  ];

  return (
    <section style={{ background: "#FAFCFE" }} className="py-16 md:py-20">
      <div className="mx-auto max-w-[1320px] px-6 md:px-8">
        <div className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:items-start lg:gap-20">
          {/* LEFT — Content */}
          <div className="lg:pt-4">
            <TechEyebrow color={TECH.green}>Chain of custody</TechEyebrow>
            <TechH2>
              Chain of custody is built into the{" "}
              <TechGradient>record lifecycle.</TechGradient>
            </TechH2>
            <TechBody>
              PROOVRA records meaningful actions around evidence handling so
              reviewers can inspect how a record moved from capture to
              reporting, packaging, and reviewer access.
            </TechBody>

            {/* Green/teal disclosure note */}
            <div
              className="mt-8 flex items-start gap-3 rounded-[14px] px-5 py-4"
              style={{
                background: "#ECFDF5",
                border: "1px solid #A7F3D0",
              }}
            >
              <span
                aria-hidden
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: "rgba(16, 185, 129, 0.14)",
                  border: "1px solid rgba(16, 185, 129, 0.35)",
                }}
              >
                <ShieldCheck size={13} strokeWidth={2.2} style={{ color: "#047857" }} />
              </span>
              <div>
                <p
                  className="text-[13.5px] font-semibold"
                  style={{ color: "#065F46" }}
                >
                  Custody history shows recorded platform activity.
                </p>
                <p
                  className="mt-1 text-[12.5px] leading-[1.6]"
                  style={{ color: "#047857" }}
                >
                  It does not prove intent, liability, or real-world truth.
                </p>
              </div>
            </div>
          </div>

          {/* RIGHT — Timeline panel */}
          <div
            className="relative overflow-hidden rounded-[28px] bg-white p-6 md:p-8"
            style={{
              border: "1px solid #DDE8F7",
              boxShadow: "0 24px 70px rgba(15, 23, 42, 0.10)",
            }}
          >
            <ol className="relative">
              {/* Vertical rail with gradient transition */}
              <span
                aria-hidden
                className="absolute left-[19px] top-3 bottom-3 w-px"
                style={{
                  background:
                    "linear-gradient(180deg, #10B981 0%, #10B981 60%, #7C3AED 100%)",
                  opacity: 0.55,
                }}
              />
              {NODES.map((n, i) => {
                const isReview = n.status === "review";
                const accent = isReview ? TECH_PURPLE : TECH.green;
                return (
                  <li
                    key={i}
                    className="relative grid grid-cols-[40px_1fr] items-center gap-4 py-2.5 first:pt-0 last:pb-0"
                  >
                    {/* Rail icon */}
                    <span
                      aria-hidden
                      className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white"
                      style={{
                        border: `1.5px solid ${accent}55`,
                      }}
                    >
                      <n.Icon size={16} strokeWidth={1.9} style={{ color: accent }} />
                    </span>

                    {/* Row card */}
                    <div
                      className="flex items-center justify-between gap-3 rounded-[14px] bg-white px-4 py-3"
                      style={{
                        border: "1px solid #E5ECF5",
                        boxShadow: "0 4px 12px rgba(15, 23, 42, 0.04)",
                      }}
                    >
                      <div className="min-w-0">
                        <div
                          className="text-[14.5px] font-semibold tracking-[-0.005em]"
                          style={{ color: "#07142F" }}
                        >
                          {n.action}
                        </div>
                        <div className="mt-1 flex items-center gap-2.5">
                          <span
                            className="text-[12px]"
                            style={{ color: "#64748B" }}
                          >
                            {n.actor}
                          </span>
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                            style={{
                              color: isReview ? "#5B21B6" : "#047857",
                              background: isReview
                                ? "rgba(124, 58, 237, 0.10)"
                                : "rgba(16, 185, 129, 0.12)",
                              border: `1px solid ${isReview ? "rgba(124, 58, 237, 0.30)" : "rgba(16, 185, 129, 0.32)"}`,
                            }}
                          >
                            {isReview ? "Reviewer" : "Complete"}
                          </span>
                        </div>
                      </div>
                      <span
                        className="shrink-0 font-mono text-[11.5px] tabular-nums"
                        style={{ color: "#64748B" }}
                      >
                        {n.t}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

// 6 — VERIFICATION EXPERIENCE ------------------------------------------------
function VerificationExperience() {
  return (
    <section style={{ background: TECH.bgSoft }} className="py-16 md:py-20">
      <div className="mx-auto max-w-[1440px] px-6 md:px-8">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:items-center lg:gap-14">
          <div>
            <TechEyebrow color={TECH.green}>Verification</TechEyebrow>
            <TechH2>
              Verification pages give reviewers one place to{" "}
              <TechGradient>inspect the record.</TechGradient>
            </TechH2>
            <TechBody>
              Reviewers should not need a PROOVRA account or informal file
              handoffs to understand what was recorded. Verification surfaces
              expose integrity status, timestamp context, custody events,
              reports, and packages in a structured view.
            </TechBody>
            <ul className="mt-7 grid gap-2.5">
              {[
                "Integrity match or mismatch",
                "Timestamp and anchoring context",
                "Custody timeline",
                "Signed reports and packages",
                "Reviewer access history",
                "Downloadable verification materials",
              ].map((b) => (
                <li key={b} className="flex items-start gap-3 text-[14px]" style={{ color: TECH.text }}>
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" style={{ color: TECH.green }} strokeWidth={2.4} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 rounded-[12px] border px-4 py-3 text-[12.5px] leading-[1.6]" style={{ borderColor: `${TECH.red}33`, background: `${TECH.red}06`, color: "#7F1D1D" }}>
              Verification surfaces make recorded signals inspectable. They do
              not decide factual truth or legal admissibility.
            </p>
          </div>
          <div
            className="overflow-hidden rounded-[30px] border bg-white shadow-[0_36px_80px_rgba(11,30,58,0.16)]"
            style={{ borderColor: TECH.border }}
          >
            <img
              src="/images/verification-workspace.png"
              alt="PROOVRA verification workspace showing integrity status, timestamp, custody timeline, report, and reviewer access details"
              className="block h-auto w-full object-cover"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// 7 — TRUST SIGNALS ---------------------------------------------------------
function NewTrustSignals() {
  const CARDS: { Icon: LucideIcon; title: string; body: string }[] = [
    { Icon: Fingerprint, title: "SHA-256 Fingerprint", body: "Cryptographic digest detects whether inspected content matches the record." },
    { Icon: Clock3, title: "Timestamp Context", body: "RFC 3161 and recorded timing context attached to every record." },
    { Icon: Anchor, title: "OpenTimestamps / Public Anchoring", body: "External anchoring context where supported by the deployment." },
    { Icon: PenLine, title: "Digital Signatures", body: "Reports and packages can be signed for reviewer-visible consistency." },
    { Icon: Link2, title: "Chain of Custody", body: "Lifecycle actions recorded so reviewers can inspect handling context." },
    { Icon: PackageCheck, title: "Verification Packages", body: "Reviewer-facing bundles of the record, reports, and supporting materials." },
  ];
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <TechEyebrow>Trust signals</TechEyebrow>
          <TechH2 center>
            Trust signals exposed on{" "}
            <TechGradient>every evidence record.</TechGradient>
          </TechH2>
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => (
            <article
              key={c.title}
              className="rounded-[18px] border bg-white p-6"
              style={{ borderColor: TECH.border }}
            >
              <span
                aria-hidden
                className="flex h-11 w-11 items-center justify-center rounded-[12px]"
                style={{ background: `${TECH.blue}10`, border: `1px solid ${TECH.blue}30`, color: TECH.blue }}
              >
                <c.Icon size={20} strokeWidth={1.9} />
              </span>
              <h3 className="mt-4 text-[15.5px] font-semibold tracking-[-0.005em]" style={{ color: TECH.text }}>
                {c.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: TECH.muted }}>
                {c.body}
              </p>
            </article>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-[820px] text-center text-[12.5px] leading-[1.7]" style={{ color: TECH.muted }}>
          Trust signals are inspection aids. They do not determine factual
          truth, authorship, identity, intent, liability, or court acceptance.
        </p>
      </div>
    </section>
  );
}

// 8 — GOVERNANCE ARCHITECTURE ------------------------------------------------
function NewGovernanceArchitecture() {
  const TOP_CARDS: { Icon: LucideIcon; title: string; sub: string; color: string }[] = [
    { Icon: Building2, title: "Workspace", sub: "Organize teams and data", color: TECH.blue },
    { Icon: Briefcase, title: "Cases / Matters", sub: "Group related work", color: TECH_PURPLE },
    { Icon: FileBadge, title: "Evidence Records", sub: "Capture. Preserve. Link.", color: TECH.green },
  ];
  const WORKFLOW: { Icon: LucideIcon; label: string; sub: string; color: string }[] = [
    { Icon: Camera, label: "Capture", sub: "Intake & collection", color: TECH.orange },
    { Icon: Fingerprint, label: "Integrity", sub: "Signals & verification", color: TECH.blue },
    { Icon: Clock3, label: "Custody", sub: "Timeline & actions", color: TECH_PURPLE },
    { Icon: ShieldCheck, label: "Verification", sub: "Review & validation", color: TECH.green },
    { Icon: FileText, label: "Report", sub: "Review & report", color: TECH.orange },
    { Icon: Box, label: "Package", sub: "Bundle & export", color: "#DB2777" },
    { Icon: Users, label: "Review", sub: "Reviewer access", color: TECH_PURPLE },
  ];
  const CONTROLS: { Icon: LucideIcon; title: string; sub: string; color: string }[] = [
    { Icon: Database, title: "Retention Policies", sub: "Automated retention rules", color: TECH.green },
    { Icon: Scale, title: "Legal Hold", sub: "Preserve what matters", color: TECH.orange },
    { Icon: Lock, title: "Access Control", sub: "Role-based permissions", color: TECH.blue },
    { Icon: FileCheck2, title: "Audit Logs", sub: "Every action recorded", color: TECH_PURPLE },
    { Icon: Users, title: "Reviewer Access", sub: "Controlled & monitored", color: TECH.green },
  ];
  const HIGHLIGHTS = [
    "Role-based access",
    "Retention policies",
    "Audit visibility",
    "Case-level organization",
    "Reviewer access control",
  ];
  const MINI: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
    {
      Icon: Building,
      title: "Centralized control",
      body: "One place to govern all evidence workflows.",
      color: TECH.blue,
    },
    {
      Icon: Lock,
      title: "Consistent policy",
      body: "Retention, legal hold, and access aligned.",
      color: TECH.orange,
    },
    {
      Icon: Eye,
      title: "Full audit visibility",
      body: "Every action recorded and traceable.",
      color: TECH.green,
    },
    {
      Icon: Users,
      title: "Enterprise ready",
      body: "Built for scale, security, and compliance.",
      color: TECH.orange,
    },
  ];
  const AI_CAN = [
    "Draft case summaries",
    "Detect missing related evidence",
    "Explain verification results",
    "Suggest relevant evidence",
    "Surface inconsistencies",
    "Support reviewer decision actions",
  ];
  const AI_DOES_NOT = [
    "Determine factual truth",
    "Determine authorship",
    "Determine intent",
    "Determine liability or fault",
    "Determine legal admissibility",
    "Replace human or legal review",
  ];
  const NAV: { Icon: LucideIcon; label: string; active?: boolean }[] = [
    { Icon: Eye, label: "Overview" },
    { Icon: FileBadge, label: "Evidence", active: true },
    { Icon: Briefcase, label: "Cases" },
    { Icon: FileText, label: "Reports" },
    { Icon: Box, label: "Packages" },
    { Icon: Users, label: "Reviewers" },
    { Icon: FileCheck2, label: "Audit Logs" },
    { Icon: Settings, label: "Settings" },
  ];
  const REVIEWER_STEPS: { label: string; status: "Complete" | "In Review" | "Pending" }[] = [
    { label: "Capture", status: "Complete" },
    { label: "Integrity", status: "Complete" },
    { label: "Custody", status: "Complete" },
    { label: "Verification", status: "In Review" },
    { label: "Report", status: "Pending" },
    { label: "Package", status: "Pending" },
    { label: "Reviewer Access", status: "Pending" },
  ];
  const AI_INSIGHTS: { Icon: LucideIcon; title: string; sub: string; color: string }[] = [
    { Icon: AlertTriangle, title: "Missing context detected", sub: "Location metadata is incomplete", color: TECH.orange },
    { Icon: Search, title: "Related evidence found", sub: "3 related records may be relevant", color: TECH.blue },
    { Icon: BadgeCheck, title: "Capture quality analysis", sub: "Resolution and stability look good", color: TECH.green },
    { Icon: Sparkles, title: "Suggested next step", sub: "Add context notes before review", color: TECH_PURPLE },
  ];
  const statusStyle = (status: string) => {
    if (status === "Complete") return { color: "#047857", bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.35)" };
    if (status === "In Review") return { color: "#92400E", bg: "rgba(245,158,11,0.14)", border: "rgba(245,158,11,0.40)" };
    return { color: "#64748B", bg: "rgba(100,116,139,0.10)", border: "rgba(100,116,139,0.28)" };
  };

  return (
    <section className="bg-white py-12 md:py-16">
      <div
        className="mx-auto"
        style={{ width: "min(100% - 48px, 1600px)" }}
      >
        <div
          className="overflow-hidden rounded-[32px]"
          style={{
            background:
              "linear-gradient(180deg, #F8FBFF 0%, #EEF6FF 45%, #FFF7FE 100%)",
            border: "1px solid #D9E7FA",
            boxShadow: "0 30px 90px rgba(15, 23, 42, 0.08)",
          }}
        >
          {/* ================== GOVERNANCE BLOCK ================== */}
          <div className="px-6 pt-12 pb-10 md:px-12 md:pt-14 md:pb-12 lg:px-16 lg:pt-16 lg:pb-14">
            {/* Heading */}
            <div className="mx-auto flex max-w-[1080px] flex-col items-center text-center">
              <TechEyebrow color={TECH.green}>Governance</TechEyebrow>
              <h2
                className="mt-5 text-[40px] font-extrabold leading-[1.05] tracking-[-0.025em] sm:text-[48px] md:text-[56px] lg:text-[58px]"
                style={{ color: "#07142F" }}
              >
                Governance scales{" "}
                <TechGradient>evidence operations.</TechGradient>
              </h2>
              <p
                className="mx-auto mt-5 max-w-[820px] text-[16px] leading-[1.7] md:text-[17px]"
                style={{ color: "#526173" }}
              >
                Enterprise evidence workflows need more than files. PROOVRA
                connects records to workspaces, cases, policies, retention,
                legal hold, access controls, and audit logs.
              </p>
            </div>

            {/* Architecture — main + right sidebar */}
            <div className="mt-8 grid gap-8 lg:grid-cols-[3fr_1fr] lg:gap-8">
              {/* MAIN COLUMN */}
              <div className="grid gap-6">
                {/* 3 top cards with dotted connectors */}
                <div className="grid items-stretch gap-3 sm:grid-cols-[1fr_24px_1fr_24px_1fr]">
                  {TOP_CARDS.map((c, i) => (
                    <Fragment key={c.title}>
                      <div
                        className="flex items-center gap-4 rounded-[18px] bg-white/95 px-5 py-4"
                        style={{
                          border: "1px solid #D9E7FA",
                          boxShadow: "0 10px 26px rgba(15,23,42,0.05)",
                          minHeight: 80,
                        }}
                      >
                        <span
                          aria-hidden
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                          style={{
                            background: `${c.color}14`,
                            border: `1px solid ${c.color}3D`,
                          }}
                        >
                          <c.Icon size={20} strokeWidth={1.9} style={{ color: c.color }} />
                        </span>
                        <div className="min-w-0">
                          <div
                            className="text-[15.5px] font-bold tracking-[-0.005em]"
                            style={{ color: "#07142F" }}
                          >
                            {c.title}
                          </div>
                          <div className="mt-0.5 text-[12.5px]" style={{ color: "#526173" }}>
                            {c.sub}
                          </div>
                        </div>
                      </div>
                      {i < TOP_CARDS.length - 1 ? (
                        <div
                          aria-hidden
                          className="hidden items-center justify-center sm:flex"
                        >
                          <span
                            className="h-px w-full"
                            style={{
                              borderTop: "1.5px dashed rgba(37,99,235,0.40)",
                            }}
                          />
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>

                {/* Main workflow card */}
                <div
                  className="rounded-[24px] bg-white/95 px-6 py-8 md:px-8 md:py-10"
                  style={{
                    border: "1px solid #D9E7FA",
                    boxShadow: "0 18px 42px rgba(15,23,42,0.06)",
                  }}
                >
                  {/* Title */}
                  <div className="flex justify-center">
                    <span
                      className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.22em]"
                      style={{
                        color: TECH_PURPLE,
                        border: "1px dashed rgba(124,58,237,0.35)",
                      }}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: TECH_PURPLE }}
                      />
                      Evidence operations workflow
                    </span>
                  </div>

                  {/* 7-step horizontal flow */}
                  <div className="mt-8 -mx-2 overflow-x-auto md:mx-0 md:overflow-visible">
                    <ol className="flex min-w-[920px] items-start justify-between gap-2 md:min-w-0">
                      {WORKFLOW.map((s, i) => (
                        <Fragment key={s.label}>
                          <li className="flex min-w-[110px] flex-col items-center text-center">
                            <span
                              aria-hidden
                              className="flex h-[68px] w-[68px] items-center justify-center rounded-full bg-white"
                              style={{
                                background: `${s.color}14`,
                                border: `1.5px solid ${s.color}55`,
                                boxShadow: `0 12px 28px ${s.color}26`,
                              }}
                            >
                              <s.Icon size={26} strokeWidth={1.85} style={{ color: s.color }} />
                            </span>
                            <div
                              className="mt-3 text-[14px] font-bold tracking-[-0.005em]"
                              style={{ color: "#07142F" }}
                            >
                              {s.label}
                            </div>
                            <div className="mt-0.5 text-[11.5px] leading-[1.45]" style={{ color: "#526173" }}>
                              {s.sub}
                            </div>
                          </li>
                          {i < WORKFLOW.length - 1 ? (
                            <li
                              aria-hidden
                              className="flex flex-1 items-start justify-center pt-[26px]"
                            >
                              <span
                                className="h-px w-full max-w-[40px]"
                                style={{
                                  borderTop: "1.5px dashed rgba(124,58,237,0.32)",
                                }}
                              />
                              <ArrowRight
                                size={14}
                                strokeWidth={2}
                                className="-ml-1"
                                style={{ color: "rgba(124,58,237,0.55)" }}
                              />
                            </li>
                          ) : null}
                        </Fragment>
                      ))}
                    </ol>
                  </div>

                  {/* Divider */}
                  <div
                    className="mt-10"
                    style={{ borderTop: "1px dashed rgba(37,99,235,0.20)" }}
                  />

                  {/* Governance controls row */}
                  <div className="mt-8 grid items-stretch gap-3 lg:grid-cols-[auto_repeat(5,1fr)]">
                    <div
                      className="flex items-center gap-3 rounded-[14px] px-4 py-3"
                      style={{
                        background: "rgba(37,99,235,0.06)",
                        border: "1px solid rgba(37,99,235,0.22)",
                      }}
                    >
                      <ShieldCheck size={18} strokeWidth={2} style={{ color: TECH.blue }} />
                      <div
                        className="text-[11px] font-bold uppercase leading-tight tracking-[0.18em]"
                        style={{ color: TECH.blue }}
                      >
                        Governance
                        <br />
                        controls
                      </div>
                    </div>
                    {CONTROLS.map((c, i) => (
                      <div
                        key={c.title}
                        className="flex items-center gap-3 px-3 py-3"
                        style={{
                          borderLeft:
                            i === 0 ? "none" : "1px solid rgba(15,23,42,0.08)",
                        }}
                      >
                        <span
                          aria-hidden
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                          style={{
                            background: `${c.color}14`,
                            border: `1px solid ${c.color}3D`,
                          }}
                        >
                          <c.Icon size={16} strokeWidth={1.9} style={{ color: c.color }} />
                        </span>
                        <div className="min-w-0">
                          <div
                            className="text-[13px] font-bold tracking-[-0.005em]"
                            style={{ color: "#07142F" }}
                          >
                            {c.title}
                          </div>
                          <div className="mt-0.5 text-[11.5px] leading-[1.35]" style={{ color: "#526173" }}>
                            {c.sub}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT SIDEBAR */}
              <aside className="grid gap-4">
                {/* Highlights */}
                <div
                  className="rounded-[20px] bg-white px-6 py-6"
                  style={{
                    border: "1px solid #D9E7FA",
                    boxShadow: "0 18px 40px rgba(15,23,42,0.06)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <ArrowRight
                      size={13}
                      strokeWidth={2.4}
                      style={{ color: TECH.blue }}
                    />
                    <span
                      className="text-[11px] font-bold uppercase tracking-[0.22em]"
                      style={{ color: TECH.blue }}
                    >
                      Governance highlights
                    </span>
                  </div>
                  <ul className="mt-5 grid gap-3">
                    {HIGHLIGHTS.map((c) => (
                      <li
                        key={c}
                        className="flex items-center gap-3 text-[14px] font-medium"
                        style={{ color: "#07142F" }}
                      >
                        <span
                          aria-hidden
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                          style={{ background: TECH.blue }}
                        >
                          <Check size={11} strokeWidth={3} className="text-white" />
                        </span>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 2x2 mini cards */}
                <div className="grid grid-cols-2 gap-3">
                  {MINI.map((m) => (
                    <div
                      key={m.title}
                      className="flex flex-col items-center rounded-[18px] bg-white px-3 py-5 text-center"
                      style={{
                        border: "1px solid #D9E7FA",
                        boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
                        minHeight: 168,
                      }}
                    >
                      <span
                        aria-hidden
                        className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                        style={{
                          background: `${m.color}14`,
                          border: `1px solid ${m.color}3D`,
                        }}
                      >
                        <m.Icon size={18} strokeWidth={1.9} style={{ color: m.color }} />
                      </span>
                      <h4
                        className="mt-3 text-[13.5px] font-bold leading-[1.2] tracking-[-0.005em]"
                        style={{ color: "#07142F" }}
                      >
                        {m.title}
                      </h4>
                      <p
                        className="mt-1.5 text-[11.5px] leading-[1.45]"
                        style={{ color: "#526173" }}
                      >
                        {m.body}
                      </p>
                    </div>
                  ))}
                </div>
              </aside>
            </div>
          </div>

          {/* Divider between Governance and AI */}
          <div style={{ borderTop: "1px solid #E5ECF5" }} />

          {/* ================== AI ARCHITECTURE BLOCK ================== */}
          <div
            className="px-6 pt-12 pb-12 md:px-12 md:pt-16 md:pb-16 lg:px-16"
            style={{
              background:
                "linear-gradient(135deg, #FFFFFF 0%, #F8FAFF 55%, #FFF5FE 100%)",
            }}
          >
            <div className="grid items-start gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-14">
              {/* LEFT — Heading + AI CAN/DOES NOT */}
              <div>
                <span
                  className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.22em]"
                  style={{
                    color: TECH_PURPLE,
                    border: "1px solid rgba(124,58,237,0.30)",
                  }}
                >
                  <Sparkles size={12} strokeWidth={2.4} />
                  AI architecture
                </span>
                <h2
                  className="mt-5 text-[34px] font-extrabold leading-[1.05] tracking-[-0.022em] sm:text-[40px] md:text-[46px] lg:text-[50px]"
                  style={{ color: "#07142F" }}
                >
                  AI assistance for{" "}
                  <TechGradient>evidence preparation</TechGradient>{" "}
                  — not truth determination.
                </h2>
                <p
                  className="mt-5 text-[15.5px] leading-[1.7]"
                  style={{ color: "#526173" }}
                >
                  PROOVRA AI helps users and reviewers understand records,
                  identify missing context, prepare review workflows, and
                  explain verification results. It stays{" "}
                  <em className="not-italic font-semibold" style={{ color: "#07142F" }}>
                    advisory
                  </em>{" "}
                  and does not replace human or legal judgment.
                </p>

                <div className="mt-8 grid gap-4 sm:grid-cols-2">
                  {/* AI CAN */}
                  <div
                    className="rounded-[18px] px-5 py-5"
                    style={{
                      background: "#F0FDF4",
                      border: "1px solid #BBF7D0",
                    }}
                  >
                    <div
                      className="text-[11px] font-bold uppercase tracking-[0.22em]"
                      style={{ color: "#047857" }}
                    >
                      AI can
                    </div>
                    <ul className="mt-4 grid gap-2.5">
                      {AI_CAN.map((c) => (
                        <li
                          key={c}
                          className="flex items-start gap-2.5 text-[13.5px] leading-[1.55]"
                          style={{ color: "#065F46" }}
                        >
                          <span
                            aria-hidden
                            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                            style={{ background: "#10B981" }}
                          >
                            <Check size={9} strokeWidth={3} className="text-white" />
                          </span>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {/* AI DOES NOT */}
                  <div
                    className="rounded-[18px] px-5 py-5"
                    style={{
                      background: "#FEF2F2",
                      border: "1px solid #FECACA",
                    }}
                  >
                    <div
                      className="text-[11px] font-bold uppercase tracking-[0.22em]"
                      style={{ color: "#B91C1C" }}
                    >
                      AI does not
                    </div>
                    <ul className="mt-4 grid gap-2.5">
                      {AI_DOES_NOT.map((c) => (
                        <li
                          key={c}
                          className="flex items-start gap-2.5 text-[13.5px] leading-[1.55]"
                          style={{ color: "#7F1D1D" }}
                        >
                          <span
                            aria-hidden
                            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                            style={{ background: "#DC2626" }}
                          >
                            <XCircle size={10} strokeWidth={2.4} className="text-white" />
                          </span>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Bottom disclaimer pill */}
                <div
                  className="mt-6 flex items-start gap-2.5 rounded-[12px] px-4 py-3"
                  style={{
                    background: "rgba(37,99,235,0.06)",
                    border: "1px solid rgba(37,99,235,0.22)",
                  }}
                >
                  <AlertTriangle
                    size={14}
                    strokeWidth={2}
                    className="mt-0.5 shrink-0"
                    style={{ color: TECH.blue }}
                  />
                  <p className="text-[12.5px] leading-[1.55]" style={{ color: "#526173" }}>
                    AI assistance is advisory and does not determine factual
                    truth, authorship, intent, or legal admissibility.
                  </p>
                </div>
              </div>

              {/* RIGHT — Product mockup */}
              <div
                className="overflow-hidden rounded-[28px] bg-white"
                style={{
                  border: "1px solid #DDE8F7",
                  boxShadow: "0 30px 90px rgba(79,70,229,0.14)",
                  minHeight: 480,
                }}
              >
                <div className="grid grid-cols-[170px_1fr_180px]">
                  {/* SIDEBAR */}
                  <nav
                    className="flex flex-col gap-1 px-3 py-5"
                    style={{
                      background: "#FAFCFE",
                      borderRight: "1px solid #E5ECF5",
                    }}
                  >
                    <div className="flex items-center gap-2 px-2 pb-4">
                      <span
                        aria-hidden
                        className="flex h-5 w-5 items-center justify-center rounded-[5px]"
                        style={{
                          background:
                            "linear-gradient(160deg, #2563EB, #7C3AED)",
                        }}
                      >
                        <span className="block h-2 w-2 rounded-[1px] bg-white" />
                      </span>
                      <span
                        className="text-[12px] font-extrabold tracking-[0.18em]"
                        style={{ color: "#07142F" }}
                      >
                        PROOVRA
                      </span>
                    </div>
                    {NAV.map((n) => (
                      <div
                        key={n.label}
                        className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[12px]"
                        style={
                          n.active
                            ? {
                                background: "rgba(37,99,235,0.10)",
                                color: TECH.blue,
                                fontWeight: 600,
                              }
                            : { color: "#526173" }
                        }
                      >
                        <n.Icon
                          size={14}
                          strokeWidth={1.9}
                          style={{ color: n.active ? TECH.blue : "#94A3B8" }}
                        />
                        {n.label}
                      </div>
                    ))}
                  </nav>

                  {/* MAIN */}
                  <div className="px-5 py-5">
                    <div className="flex items-center justify-between gap-3">
                      <div
                        className="text-[14px] font-bold tracking-[-0.005em]"
                        style={{ color: "#07142F" }}
                      >
                        Evidence Record · ER-2024-04583
                      </div>
                      <span
                        className="rounded-full px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.18em]"
                        style={{
                          color: "#047857",
                          background: "rgba(16,185,129,0.12)",
                          border: "1px solid rgba(16,185,129,0.36)",
                        }}
                      >
                        Integrity intact
                      </span>
                    </div>

                    {/* Record Summary */}
                    <div className="mt-4 grid grid-cols-[1fr_140px] gap-3">
                      <div
                        className="rounded-[14px] bg-white px-4 py-3"
                        style={{ border: "1px solid #E5ECF5" }}
                      >
                        <div
                          className="text-[10.5px] font-bold uppercase tracking-[0.16em]"
                          style={{ color: "#526173" }}
                        >
                          Record summary
                        </div>
                        <div className="mt-3 grid gap-1.5 text-[11.5px]">
                          {[
                            ["Type", "Video"],
                            ["Captured", "Jun 18, 2024 14:11 UTC"],
                            ["Source", "Mobile Device"],
                            ["Size", "2.48 GB"],
                          ].map(([k, v]) => (
                            <div
                              key={k}
                              className="flex items-center justify-between"
                            >
                              <span style={{ color: "#94A3B8" }}>{k}</span>
                              <span style={{ color: "#07142F" }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* Video thumbnail */}
                      <div
                        className="relative overflow-hidden rounded-[12px]"
                        style={{
                          background:
                            "linear-gradient(135deg, #1E293B 0%, #334155 100%)",
                          minHeight: 100,
                        }}
                      >
                        <div
                          aria-hidden
                          className="absolute inset-0"
                          style={{
                            background:
                              "radial-gradient(60% 50% at 50% 50%, rgba(96,165,250,0.30) 0%, rgba(96,165,250,0) 70%)",
                          }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/95"
                            style={{
                              boxShadow: "0 6px 14px rgba(0,0,0,0.30)",
                            }}
                          >
                            <Play
                              size={14}
                              strokeWidth={2.4}
                              style={{ color: "#0F172A", marginLeft: 2 }}
                              fill="#0F172A"
                            />
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* AI Review Insights */}
                    <div
                      className="mt-4 rounded-[14px] px-4 py-4"
                      style={{
                        background:
                          "linear-gradient(180deg, #F6F4FF 0%, #FAF8FF 100%)",
                        border: "1px solid rgba(124,58,237,0.20)",
                      }}
                    >
                      <div
                        className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.20em]"
                        style={{ color: TECH_PURPLE }}
                      >
                        <Sparkles size={12} strokeWidth={2.2} />
                        AI Review Insights (Advisory)
                      </div>
                      <ul className="mt-3 grid gap-2.5">
                        {AI_INSIGHTS.map((ins) => (
                          <li
                            key={ins.title}
                            className="flex items-start gap-2.5"
                          >
                            <span
                              aria-hidden
                              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px]"
                              style={{
                                background: `${ins.color}14`,
                                border: `1px solid ${ins.color}3D`,
                              }}
                            >
                              <ins.Icon
                                size={12}
                                strokeWidth={2}
                                style={{ color: ins.color }}
                              />
                            </span>
                            <div className="min-w-0">
                              <div
                                className="text-[12px] font-semibold tracking-[-0.005em]"
                                style={{ color: "#07142F" }}
                              >
                                {ins.title}
                              </div>
                              <div
                                className="mt-0.5 text-[11px] leading-[1.4]"
                                style={{ color: "#64748B" }}
                              >
                                {ins.sub}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* RIGHT RAIL */}
                  <div
                    className="px-4 py-5"
                    style={{
                      background: "#FAFCFE",
                      borderLeft: "1px solid #E5ECF5",
                    }}
                  >
                    <div
                      className="text-[10.5px] font-bold tracking-[-0.005em]"
                      style={{ color: "#07142F" }}
                    >
                      Reviewer Workflow
                    </div>
                    <ol className="mt-3 grid gap-2">
                      {REVIEWER_STEPS.map((s, i) => {
                        const st = statusStyle(s.status);
                        return (
                          <li
                            key={s.label}
                            className="flex items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8.5px] font-bold"
                                style={{
                                  background: "rgba(37,99,235,0.10)",
                                  color: TECH.blue,
                                }}
                              >
                                {i + 1}
                              </span>
                              <span className="text-[11px]" style={{ color: "#07142F" }}>
                                {s.label}
                              </span>
                            </div>
                            <span
                              className="rounded-full px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.08em]"
                              style={{
                                color: st.color,
                                background: st.bg,
                                border: `1px solid ${st.border}`,
                              }}
                            >
                              {s.status}
                            </span>
                          </li>
                        );
                      })}
                    </ol>

                    {/* Reviewer Notes */}
                    <div
                      className="mt-5 text-[10.5px] font-bold"
                      style={{ color: "#07142F" }}
                    >
                      Reviewer Notes
                    </div>
                    <div
                      className="mt-2 rounded-[10px] bg-white px-3 py-3 text-[10.5px]"
                      style={{
                        border: "1px solid #E5ECF5",
                        color: "#94A3B8",
                        minHeight: 72,
                      }}
                    >
                      Add notes for this evidence...
                    </div>
                    <button
                      type="button"
                      className="mt-2 w-full rounded-[10px] px-3 py-2 text-[11px] font-bold text-white"
                      style={{
                        background:
                          "linear-gradient(160deg, #7C3AED, #6D28D9)",
                        boxShadow: "0 8px 18px rgba(124,58,237,0.30)",
                      }}
                    >
                      Save Note
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// 10 — ENTERPRISE USE CASES --------------------------------------------------
function NewEnterpriseUseCases() {
  const CARDS: { img: string; title: string; copy: string; label: string; alt: string }[] = [
    { img: "/images/insurance-intake-request.png", title: "Insurance Claims", copy: "Request structured evidence from claimants and prepare verification-ready claim files.", label: "Intake", alt: "Insurance claims intake on PROOVRA" },
    { img: "/images/property-condition-capture-intake-request.png", title: "Property Disputes", copy: "Capture property damage, attach context, and generate review-ready evidence packages.", label: "Intake", alt: "Property condition intake on PROOVRA" },
    { img: "/images/construction-progress-capture.png", title: "Construction & Contractors", copy: "Document progress, completion, and site conditions with structured capture.", label: "Capture", alt: "Construction progress capture on PROOVRA" },
    { img: "/images/logistics-damage-capture.png", title: "Logistics & Delivery", copy: "Record damaged deliveries and keep custody context attached from intake to claim review.", label: "Capture", alt: "Logistics damage capture on PROOVRA" },
    { img: "/images/workplace-incident-capture.png", title: "Workplace Incidents", copy: "Collect incident evidence, witness context, and review timelines for internal investigations.", label: "Capture", alt: "Workplace incident capture on PROOVRA" },
    { img: "/images/evidence-review-workspace.png", title: "Legal / Reviewer Workflows", copy: "Give reviewers and legal teams a structured surface for integrity, custody, and reports.", label: "Review", alt: "Reviewer workspace on PROOVRA" },
  ];
  const labelColor = (l: string) => l === "Capture" ? TECH.orange : l === "Verify" ? TECH.blue : TECH.green;
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <TechEyebrow>Enterprise use cases</TechEyebrow>
          <TechH2 center>
            Built for <TechGradient>evidence workflows</TechGradient> across industries.
          </TechH2>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => (
            <article
              key={c.title}
              className="overflow-hidden rounded-[20px] border bg-white shadow-[0_8px_22px_rgba(15,23,42,0.06)] transition-transform hover:-translate-y-0.5"
              style={{ borderColor: TECH.border }}
            >
              <div className="relative aspect-[16/9] w-full overflow-hidden">
                <img src={c.img} alt={c.alt} className="block h-full w-full object-cover" />
                <span
                  className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                  style={{ background: "rgba(255,255,255,0.92)", color: labelColor(c.label) }}
                >
                  {c.label}
                </span>
              </div>
              <div className="p-5">
                <h3 className="text-[16px] font-semibold tracking-[-0.005em]" style={{ color: TECH.text }}>
                  {c.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: TECH.muted }}>
                  {c.copy}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// 11 — SECURITY ARCHITECTURE -------------------------------------------------
function NewSecurityArchitecture() {
  const COL_LEFT = [
    { label: "Mobile capture", Icon: Inbox },
    { label: "File upload", Icon: Database },
    { label: "Intake link", Icon: Link2 },
  ];
  const COL_CENTER = [
    { label: "Evidence record", Icon: FileBadge },
    { label: "Metadata", Icon: FileText },
    { label: "Hashing", Icon: Fingerprint },
    { label: "Timestamp context", Icon: Clock3 },
    { label: "Custody log", Icon: Link2 },
  ];
  const COL_RIGHT = [
    { label: "Verification page", Icon: Eye },
    { label: "Signed report", Icon: PenLine },
    { label: "Evidence package", Icon: PackageCheck },
    { label: "External reviewer", Icon: Users },
  ];
  const BOTTOM = [
    { label: "Access control", Icon: KeyRound },
    { label: "Audit log", Icon: FileCheck2 },
    { label: "Retention / legal hold", Icon: Lock },
    { label: "Storage controls", Icon: Server },
  ];
  // Dark glass node — vivid filled gradient icon tile + white label.
  const Node = ({
    label,
    Icon,
    gradient,
  }: {
    label: string;
    Icon: LucideIcon;
    gradient: string;
  }) => (
    <div
      className="flex items-center gap-3 rounded-2xl px-4 py-3 text-white shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-md"
      style={{
        background: "rgba(8, 18, 38, 0.72)",
        border: "1px solid rgba(125, 170, 255, 0.20)",
      }}
    >
      <span
        aria-hidden
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-lg bg-gradient-to-br ${gradient}`}
      >
        <Icon size={16} strokeWidth={2.2} className="text-white" />
      </span>
      <span className="text-[13px] font-medium text-slate-100">{label}</span>
    </div>
  );

  // Column descriptors — title color + node gradient match.
  const COLUMNS: {
    title: string;
    titleColor: string;
    gradient: string;
    items: { label: string; Icon: LucideIcon }[];
  }[] = [
    { title: "Inputs", titleColor: "#FB923C", gradient: "from-orange-500 to-amber-400", items: COL_LEFT },
    { title: "Core", titleColor: "#60A5FA", gradient: "from-blue-600 to-cyan-400", items: COL_CENTER },
    { title: "Outputs", titleColor: "#34D399", gradient: "from-emerald-500 to-cyan-400", items: COL_RIGHT },
  ];

  return (
    <section
      className="relative py-16 md:py-20"
      style={{
        backgroundColor: "#0B1220",
        backgroundImage: "url('/assets/cards/icon-card.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div className="relative mx-auto max-w-[1240px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <span
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]"
            style={{ color: "#A5B4FC", borderColor: "rgba(165,180,252,0.30)", background: "rgba(99,102,241,0.10)" }}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#A5B4FC]" />
            Security architecture
          </span>
          <h2 className="mt-4 max-w-[860px] text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.4rem]">
            Security architecture for{" "}
            <TechGradient>evidence operations.</TechGradient>
          </h2>
          <p className="mt-4 max-w-[760px] text-[15.5px] leading-[1.7] text-[#CBD5F5]">
            PROOVRA separates capture, access, storage, audit, verification,
            and output workflows so evidence records stay controlled and
            inspectable.
          </p>
        </div>

        {/* Three-column architecture diagram with subtle flow connectors */}
        <div className="relative mt-6">
          {/* Horizontal Inputs → Core → Outputs flow line (desktop only) */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-[16%] right-[16%] top-[68px] hidden h-px md:block"
            style={{
              background:
                "linear-gradient(90deg, rgba(96,165,250,0) 0%, rgba(96,165,250,0.35) 25%, rgba(96,165,250,0.35) 75%, rgba(96,165,250,0) 100%)",
            }}
          />
          <div className="grid gap-4 md:grid-cols-3">
            {COLUMNS.map((col) => (
              <div
                key={col.title}
                className="rounded-[28px] p-6 backdrop-blur-md"
                style={{
                  background: "rgba(15, 23, 42, 0.35)",
                  border: "1px solid rgba(255, 255, 255, 0.10)",
                }}
              >
                <div
                  className="text-xs font-semibold uppercase tracking-[0.22em]"
                  style={{ color: col.titleColor }}
                >
                  {col.title}
                </div>
                <div className="mt-4 grid gap-3">
                  {col.items.map((n) => (
                    <Node key={n.label} label={n.label} Icon={n.Icon} gradient={col.gradient} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Platform controls — same dark glass language */}
        <div
          className="mt-4 rounded-[28px] p-6 backdrop-blur-md"
          style={{
            background: "rgba(15, 23, 42, 0.35)",
            border: "1px solid rgba(255, 255, 255, 0.10)",
          }}
        >
          <div
            className="text-xs font-semibold uppercase tracking-[0.22em]"
            style={{ color: "#C4B5FD" }}
          >
            Platform controls
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BOTTOM.map((b) => (
              <Node
                key={b.label}
                label={b.label}
                Icon={b.Icon}
                gradient="from-violet-600 to-blue-500"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// 12 — TRADITIONAL VS PROOVRA ------------------------------------------------
function NewComparison() {
  const LEFT = [
    "Loose photos and documents",
    "Manual context tracking",
    "Weak custody visibility",
    "Reports created separately",
    "Informal handoffs",
    "Hard to re-check later",
  ];
  const RIGHT = [
    "Structured evidence records",
    "Integrity signals attached",
    "Custody events recorded",
    "Reports and packages generated",
    "Verification pages for reviewers",
    "Audit and access context preserved",
  ];
  return (
    <section style={{ background: TECH.bg }} className="py-16 md:py-20">
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <TechEyebrow>Before / After</TechEyebrow>
          <TechH2 center>
            From scattered files to{" "}
            <TechGradient>evidence records.</TechGradient>
          </TechH2>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <article
            className="overflow-hidden rounded-[22px] border bg-white p-7 md:p-8"
            style={{ borderColor: `${TECH.red}33` }}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                style={{ background: `${TECH.red}10`, border: `1px solid ${TECH.red}30`, color: TECH.red }}
              >
                <AlertTriangle size={18} strokeWidth={2} />
              </span>
              <h3 className="text-[18px] font-semibold tracking-[-0.005em]" style={{ color: TECH.text }}>
                Traditional file handling
              </h3>
            </div>
            <ul className="mt-5 grid gap-2.5">
              {LEFT.map((l) => (
                <li key={l} className="flex items-start gap-2.5 text-[14px]" style={{ color: "#7F1D1D" }}>
                  <XCircle size={15} className="mt-0.5 shrink-0" style={{ color: TECH.red }} strokeWidth={2.2} />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          </article>
          <article
            className="overflow-hidden rounded-[22px] border bg-white p-7 md:p-8"
            style={{ borderColor: `${TECH.green}33` }}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                style={{ background: `${TECH.green}10`, border: `1px solid ${TECH.green}30`, color: TECH.green }}
              >
                <ShieldCheck size={18} strokeWidth={2} />
              </span>
              <h3 className="text-[18px] font-semibold tracking-[-0.005em]" style={{ color: TECH.text }}>
                PROOVRA evidence operations
              </h3>
            </div>
            <ul className="mt-5 grid gap-2.5">
              {RIGHT.map((r) => (
                <li key={r} className="flex items-start gap-2.5 text-[14px]" style={{ color: TECH.text }}>
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" style={{ color: TECH.green }} strokeWidth={2.2} />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

// 13 — TECHNICAL FAQ ---------------------------------------------------------
function NewTechnicalFaq() {
  const FAQ: { q: string; a: string }[] = [
    {
      q: "How does PROOVRA verify file integrity?",
      a: "Every evidence record stores a SHA-256 fingerprint. Reviewers can compare the inspected content against the recorded reference. If the bytes differ, the fingerprint no longer matches.",
    },
    {
      q: "Does PROOVRA prove that an event actually happened?",
      a: "No. Integrity, timestamp, and custody signals describe what was recorded by the platform. They do not determine factual truth, authorship, identity, intent, or liability.",
    },
    {
      q: "Can external reviewers inspect evidence without an account?",
      a: "Yes. Verification pages and signed packages are designed for reviewer inspection on reviewer-facing surfaces, with access governed by the deployment configuration.",
    },
    {
      q: "What happens if timestamping or anchoring is unavailable?",
      a: "PROOVRA does not fail the whole record. Available signals remain visible, and signals that could not be confirmed are explicitly disclosed on the verification page.",
    },
    {
      q: "Does AI inspect raw evidence content?",
      a: "AI runs in an advisory mode focused on metadata, integrity, custody, and workflow context. It does not determine truth, authorship, identity, or legal admissibility.",
    },
    {
      q: "How are reports and packages used?",
      a: "Reports summarize the record, signals, custody, and review context. Packages bundle the record, reports, and supporting materials so reviewers can re-check independently.",
    },
    {
      q: "Can teams organize evidence by case or matter?",
      a: "Yes. Records can be organized into workspaces and cases with role-based access, retention concepts, legal hold concepts, reviewer access controls, and audit logging.",
    },
    {
      q: "What should legal or compliance teams understand before relying on reports?",
      a: "Reports surface platform-recorded signals. They are not admissibility opinions. Legal and compliance teams should evaluate each record's signals against their own standards and seek legal review when required.",
    },
  ];
  return (
    <section style={{ background: TECH.bg }} className="py-16 md:py-20">
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <TechEyebrow>FAQ</TechEyebrow>
          <TechH2 center>
            Questions <TechGradient>enterprise buyers</TechGradient> ask.
          </TechH2>
        </div>
        <div className="mx-auto mt-6 grid max-w-[960px] gap-3">
          {FAQ.map((f) => (
            <details
              key={f.q}
              className="group rounded-[16px] border bg-white px-5 py-4 transition-all open:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
              style={{ borderColor: TECH.border }}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold tracking-[-0.005em]" style={{ color: TECH.text }}>
                <span>{f.q}</span>
                <span
                  aria-hidden
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[14px] font-semibold transition-all duration-200 group-open:rotate-45"
                  style={{ borderColor: `${TECH.blue}40`, color: TECH.blue, background: `${TECH.blue}08` }}
                >
                  +
                </span>
              </summary>
              <p className="mt-4 border-t pt-4 text-[14px] leading-[1.7]" style={{ borderColor: TECH.border, color: TECH.muted }}>
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// PAGE
// =========================================================================

export default function TechnologyPage() {
  return (
    <div className="bg-white">
      <Hero />
      {/* Each post-hero section is wrapped in a SectionScene that
          reveals on scroll. Directions alternate so the page reads as
          a sequence of polished enterprise scenes rather than a long
          static document. AnimatedHeading + TechBody inside each
          section provide word-by-word title and paragraph reveal. */}
      <SectionScene direction="up">
        <EvidenceIntakeCapture />
      </SectionScene>
      <SectionScene direction="right">
        <HowTechnologyWorks />
      </SectionScene>
      <SectionScene direction="left">
        <HowItWorksRestored />
      </SectionScene>
      <SectionScene direction="up">
        <CustodyTechnology />
      </SectionScene>
      <SectionScene direction="right">
        <VerificationExperience />
      </SectionScene>
      <SectionScene direction="left">
        <NewTrustSignals />
      </SectionScene>
      <SectionScene direction="up">
        <NewGovernanceArchitecture />
      </SectionScene>
      <SectionScene direction="right">
        <NewEnterpriseUseCases />
      </SectionScene>
      <SectionScene direction="left">
        <NewSecurityArchitecture />
      </SectionScene>
      <SectionScene direction="up">
        <NewComparison />
      </SectionScene>
      <SectionScene direction="right">
        <NewTechnicalFaq />
      </SectionScene>
      <SectionScene direction="up">
        <FinalCTA />
      </SectionScene>
      <EnterpriseFooter />
    </div>
  );
}
