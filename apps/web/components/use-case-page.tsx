"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Briefcase,
  Database,
  Eye,
  FileBadge,
  Inbox,
  Lock,
  Search,
  Users,
} from "lucide-react";
import { MarketingHeader } from "./marketing/MarketingHeader";
import { EnterpriseFooter } from "./marketing/EnterpriseFooter";
import type { FaqItem, ListItem, UseCasePageContent } from "./use-case-data";
import { SALES_ASSETS } from "../lib/sales-assets";
import { MARKETING_BTN } from "../lib/marketing-buttons";
import { RevealSection } from "./motion";

// =========================================================================
// SHARED DESIGN-SYSTEM TOKENS — exact match for Pricing + Platform pages
// =========================================================================

const CARD_SHADOW = "shadow-[0_18px_40px_rgba(15,23,42,0.06)]";

const LIMITATION_COPY =
  "PROOVRA verifies recorded integrity signals, timestamp-related context, custody metadata, and supporting review materials. It does not determine factual truth, authorship, identity, or legal admissibility.";

// =========================================================================
// SECTION ACCENT SYSTEM — one palette consumed by every section. Each
// accent is exposed as CSS variables on the section root so the
// existing markup can reference them via Tailwind arbitrary values like
// border-l-[color:var(--section-accent)]. Opacities are kept very low
// (≤ 0.07 backgrounds, ≤ 0.18 borders) so the page reads enterprise,
// not landing-page.
// =========================================================================

type SectionAccent =
  | "problem"
  | "workflow"
  | "platform"
  | "comparison"
  | "operations"
  | "governance"
  | "reporting"
  | "faq";

const SECTION_ACCENTS: Record<
  SectionAccent,
  {
    accent: string; // strong line / dot / icon stroke
    accentSoft: string; // 0.04–0.06 wash for backgrounds
    accentBorder: string; // 0.14–0.18 for hairline borders
    eyebrowText: string; // eyebrow label colour
    eyebrowBg: string; // eyebrow pill background
    eyebrowBorder: string; // eyebrow pill border
  }
> = {
  // Problem sections: very soft coral. Calm, not alarming.
  problem: {
    accent: "#F97316",
    accentSoft: "rgba(249,115,22,0.05)",
    accentBorder: "rgba(249,115,22,0.18)",
    eyebrowText: "#9A3412",
    eyebrowBg: "#FFF7ED",
    eyebrowBorder: "#FED7AA",
  },
  // Workflow / pipeline: PROOVRA governance green (matches the governance
  // accent below). Previously cyan — standardising on green makes the
  // workflow / pipeline / verification surfaces read as governance-
  // oriented rather than generic SaaS.
  workflow: {
    accent: "#10B981",
    accentSoft: "rgba(16,185,129,0.05)",
    accentBorder: "rgba(16,185,129,0.18)",
    eyebrowText: "#047857",
    eyebrowBg: "#ECFDF5",
    eyebrowBorder: "#A7F3D0",
  },
  // Platform matrix: blue.
  platform: {
    accent: "#3B82F6",
    accentSoft: "rgba(59,130,246,0.04)",
    accentBorder: "rgba(59,130,246,0.18)",
    eyebrowText: "#1D4ED8",
    eyebrowBg: "#EEF4FF",
    eyebrowBorder: "#BFDBFE",
  },
  // Comparison: handled per-column (warm vs blue) — see ComparisonSection.
  comparison: {
    accent: "#3B82F6",
    accentSoft: "rgba(59,130,246,0.04)",
    accentBorder: "rgba(59,130,246,0.18)",
    eyebrowText: "#1D4ED8",
    eyebrowBg: "#EEF4FF",
    eyebrowBorder: "#BFDBFE",
  },
  // Operations: indigo.
  operations: {
    accent: "#4F46E5",
    accentSoft: "rgba(79,70,229,0.04)",
    accentBorder: "rgba(79,70,229,0.18)",
    eyebrowText: "#3730A3",
    eyebrowBg: "#EEF2FF",
    eyebrowBorder: "#C7D2FE",
  },
  // Governance: emerald — trust / correct-state semantics.
  governance: {
    accent: "#10B981",
    accentSoft: "rgba(16,185,129,0.04)",
    accentBorder: "rgba(16,185,129,0.18)",
    eyebrowText: "#047857",
    eyebrowBg: "#ECFDF5",
    eyebrowBorder: "#A7F3D0",
  },
  // Reporting / verification output: PROOVRA burgundy / oxblood. Applied
  // to the Reporting & verification section eyebrow, accent lines, left-
  // card top accents, and the three right-rail output panels (Verification
  // Page, Verification Package, PDF Report). Scoped to this one section.
  reporting: {
    accent: "#7A1F3D",
    accentSoft: "rgba(122,31,61,0.06)",
    accentBorder: "rgba(122,31,61,0.22)",
    eyebrowText: "#5E1730",
    eyebrowBg: "#F8EEF3",
    eyebrowBorder: "rgba(122,31,61,0.22)",
  },
  // FAQ: subtle indigo — reference / utility surface.
  faq: {
    accent: "#4F46E5",
    accentSoft: "rgba(79,70,229,0.03)",
    accentBorder: "rgba(79,70,229,0.16)",
    eyebrowText: "#3730A3",
    eyebrowBg: "#EEF2FF",
    eyebrowBorder: "#C7D2FE",
  },
};

function accentVars(accent: SectionAccent): React.CSSProperties {
  const a = SECTION_ACCENTS[accent];
  return {
    ["--section-accent" as string]: a.accent,
    ["--section-accent-soft" as string]: a.accentSoft,
    ["--section-accent-border" as string]: a.accentBorder,
  };
}

// Section-aware eyebrow pill — same shape as <Eyebrow> but coloured per
// section accent so each section's purpose is visually anchored. Used
// inline by sections that opt in; <Eyebrow> stays for the default
// blue/violet pill the original markup relies on elsewhere.
function AccentEyebrow({
  accent,
  children,
}: {
  accent: SectionAccent;
  children: ReactNode;
}) {
  const a = SECTION_ACCENTS[accent];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
      style={{
        color: a.eyebrowText,
        background: a.eyebrowBg,
        borderColor: a.eyebrowBorder,
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: a.accent }}
      />
      {children}
    </span>
  );
}

// =========================================================================
// SHARED COMPONENTS — Eyebrow / SectionTitle / SectionSubtitle
// (mirrors the helpers in apps/web/app/platform/page.tsx)
// =========================================================================

function Eyebrow({
  children,
  center,
  tone = "light",
}: {
  children: ReactNode;
  center?: boolean;
  tone?: "light" | "dark";
}) {
  const wrapClass = center ? "flex justify-center" : "";
  const inner =
    tone === "dark"
      ? "border-white/14 bg-white/[0.07] text-[#9dd2ca]"
      : "border-[#E0E7FF] bg-[#F8FAFC] text-[#2563EB]";
  const dot = tone === "dark" ? "bg-[#7A3CFF]" : "bg-[#7A3CFF]";
  return (
    <div className={wrapClass}>
      <span
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${inner}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {children}
      </span>
    </div>
  );
}

function SectionTitle({
  children,
  center,
  tone = "light",
}: {
  children: ReactNode;
  center?: boolean;
  tone?: "light" | "dark";
}) {
  const color = tone === "dark" ? "text-[#edf3f0]" : "text-[#0F172A]";
  return (
    <h2
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[760px] text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] ${color} md:text-[2rem]`}
    >
      {children}
    </h2>
  );
}

function SectionSubtitle({
  children,
  center,
  tone = "light",
}: {
  children: ReactNode;
  center?: boolean;
  tone?: "light" | "dark";
}) {
  const color = tone === "dark" ? "text-[#c2cdc6]" : "text-[#475569]";
  return (
    <p
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[680px] text-[14.5px] leading-[1.65] ${color}`}
    >
      {children}
    </p>
  );
}

// SectionHeader removed — each section now composes <AccentEyebrow> +
// <SectionTitle> + <SectionSubtitle> directly so it can supply its own
// section-tinted eyebrow palette.

// =========================================================================
// PLATFORM CAPABILITIES — global 15-capability matrix
// =========================================================================

type PlatformCapability = {
  tag: "Evidence" | "Integrity" | "Output" | "Governance" | "Workflow";
  name: string;
  description: string;
};

const PLATFORM_CAPABILITIES: PlatformCapability[] = [
  {
    tag: "Evidence",
    name: "Evidence Intake",
    description:
      "Controlled intake links and capture flows that take submissions straight into the verification workflow.",
  },
  {
    tag: "Evidence",
    name: "Evidence Records",
    description:
      "Structured records bound to a matter, case, claim, or control — not loose files in a folder.",
  },
  {
    tag: "Evidence",
    name: "Chain of Custody",
    description:
      "A structured custody history attached to every record, including creation, upload, report, and reviewer access events.",
  },
  {
    tag: "Integrity",
    name: "SHA-256 Hashing",
    description:
      "Cryptographic fingerprints captured at completion and re-checkable later by any reviewer.",
  },
  {
    tag: "Integrity",
    name: "RFC 3161 Timestamps",
    description:
      "Trusted-timestamp authority signals attached to the record where the configured TSA is available.",
  },
  {
    tag: "Integrity",
    name: "OpenTimestamps",
    description:
      "Public blockchain anchoring through OpenTimestamps where available, surfaced inside the verification surface.",
  },
  {
    tag: "Integrity",
    name: "Digital Signatures",
    description:
      "Signatures on records, reports, and verification packages, with key context captured in the audit trail.",
  },
  {
    tag: "Output",
    name: "Verification Pages",
    description:
      "Reviewer-facing pages that expose integrity state, custody history, and the supporting verification materials.",
  },
  {
    tag: "Output",
    name: "Verification Packages",
    description:
      "Bundled packages of the record, the report, and supporting verification materials for reviewers and stakeholders.",
  },
  {
    tag: "Output",
    name: "PDF Reports",
    description:
      "Consolidated structured PDF reports suitable for internal handoff, external review, and stakeholder briefing.",
  },
  {
    tag: "Governance",
    name: "Audit Logs",
    description:
      "Structured access, generation, and review events on every record — visible to operators and governance.",
  },
  {
    tag: "Governance",
    name: "Governance Controls",
    description:
      "Workspace-scoped access controls, role-based permissions, and review surfaces for operational discipline.",
  },
  {
    tag: "Governance",
    name: "Retention Policies",
    description:
      "Retention rules attached to records so review answers what was kept, for how long, and why.",
  },
  {
    tag: "Governance",
    name: "Legal Hold",
    description:
      "Records can be placed on legal hold to suspend retention rules and preserve evidence under active matter.",
  },
  {
    tag: "Workflow",
    name: "AI Assistance",
    description:
      "Advisory-only AI inside the workflow that surfaces observations and prompts — never truth, authorship, or identity claims.",
  },
];

// Capability tag colors map to Pricing/Platform palette: blue / violet / green / pink.
const CAPABILITY_TAG_STYLE: Record<
  PlatformCapability["tag"],
  { dot: string; tagText: string }
> = {
  Evidence: { dot: "#10B981", tagText: "#047857" },
  Integrity: { dot: "#2563EB", tagText: "#1D4ED8" },
  Output: { dot: "#7C3AED", tagText: "#5B21B6" },
  Governance: { dot: "#EC4899", tagText: "#9D174D" },
  Workflow: { dot: "#A855F7", tagText: "#7E22CE" },
};

// =========================================================================
// Icon mapping — workflow + operations
// =========================================================================

// iconForLifecycleLabel removed — the workflow pipeline now uses
// numbered step circles instead of icon tiles.

function iconForOperationTitle(title: string) {
  const t = title.toLowerCase();
  if (t.includes("legal hold") || t.includes("hold")) return Lock;
  if (t.includes("escalation") || t.includes("referral")) return ArrowUpRight;
  if (t.includes("intake") || t.includes("submission") || t.includes("fnol"))
    return Inbox;
  if (t.includes("expert") || t.includes("collaboration") || t.includes("hr"))
    return Users;
  if (t.includes("audit") || t.includes("oversight") || t.includes("regulatory"))
    return FileBadge;
  if (
    t.includes("publication") ||
    t.includes("editorial") ||
    t.includes("fact-check")
  )
    return BookOpen;
  if (t.includes("fraud") || t.includes("supervisor") || t.includes("approval"))
    return BadgeCheck;
  if (t.includes("review")) return Eye;
  if (
    t.includes("evidence") ||
    t.includes("preservation") ||
    t.includes("documentation") ||
    t.includes("records")
  )
    return Database;
  if (t.includes("inspection")) return Search;
  return Briefcase;
}

// =========================================================================
// HERO — dark image (soloutions-hero.png — sic, matches disk filename),
// brand-gradient highlight
// =========================================================================

function Hero({ content }: { content: UseCasePageContent }) {
  // Sizing strategy copied from PlatformHero (apps/web/app/platform/page.tsx
  // L91-103): no forced height (content-driven section), and the background
  // image is sized with backgroundSize: "100% 100%" — NOT "cover".
  //
  // Why this matters: "cover" + a viewport-tall hero forces the artwork to
  // scale up until both axes fill — which on a 720-860px-tall container is
  // an aggressive zoom that crops the centerpiece badly. Platform avoids
  // that by letting content drive the section height and stretching the
  // image to exactly the rendered container (100% × 100%). Solutions now
  // uses the identical strategy.
  return (
    <div className="relative overflow-hidden">
      {/* Hero image — Platform pattern: 100% × 100% so the artwork
          renders at the container's exact dimensions without the zoom
          / crop behaviour cover produces on tall heroes. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/hero/soloutions-hero.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "100% 100%",
        }}
      />
      {/* Local readability overlay — soft white/pearl wash behind the
          LEFT text column only. Sits above the hero image but below the
          text. Improves contrast without dimming the right-side
          illustration. Peak opacity 0.86 → 0 by ~72% of width. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(255,255,255,0.86) 0%, rgba(255,255,255,0.58) 42%, rgba(255,255,255,0) 72%)",
        }}
      />

      <div className="relative z-10 flex flex-col">
        <MarketingHeader />

        {/* Content-driven section (Platform pattern) — left-aligned text
            block stays anchored, no flex-1/justify-center forcing extra
            vertical space. */}
        <section className="mx-auto flex w-full max-w-7xl flex-col items-start px-6 pb-16 pt-14 text-left md:px-8 md:pb-20 md:pt-20 lg:pb-24 lg:pt-24">
          <div className="w-full max-w-[720px]">
            {/* Eyebrow — deep navy text on near-white pill for strong
                contrast against the bright illustrated background. */}
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
              style={{
                color: "#0B1F3A",
                background: "rgba(255,255,255,0.72)",
                borderColor: "rgba(11,31,58,0.14)",
              }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#6D28D9]" />
              {content.eyebrow}
            </span>

            <h1
              className="mt-5 text-[2.05rem] font-semibold leading-[1.06] tracking-[-0.025em] md:text-[2.7rem] lg:text-[3.05rem]"
              style={{ color: "#07152E" }}
            >
              {content.headline}{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg,#F97316 0%,#DB2777 50%,#6D28D9 100%)",
                }}
              >
                {content.headlineHighlight}
              </span>
            </h1>

            <p
              className="mt-5 max-w-[640px] text-[15px] leading-[1.65] md:text-[15.5px]"
              style={{ color: "#24324A", fontWeight: 500 }}
            >
              {content.subhead}
            </p>

            <div className="mt-7 flex flex-wrap items-center justify-start gap-x-2.5 gap-y-2">
              {content.proofPoints.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium"
                  style={{
                    color: "#0B1F3A",
                    background: "rgba(255,255,255,0.82)",
                    borderColor: "rgba(11,31,58,0.14)",
                  }}
                >
                  <span className="mr-2 text-[#0F766E]">✓</span>
                  {p}
                </span>
              ))}
            </div>

            <div className="mt-9 flex flex-wrap items-center justify-start gap-3">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className={MARKETING_BTN.secondaryLight}
              >
                Request Demo
              </Link>
              <a
                href={SALES_ASSETS.sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={MARKETING_BTN.primaryDark}
              >
                View Sample Report
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// =========================================================================
// SECTION 1 — INDUSTRY CHALLENGES (slate-50)
// =========================================================================

function IndustryChallengesSection({
  content,
}: {
  content: UseCasePageContent;
}) {
  return (
    <section
      className="relative bg-[#F5F7FA] py-20 md:py-24"
      style={accentVars("problem")}
    >
      {/* Architectural top hairline — almost invisible until you look. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: "var(--section-accent-border)" }}
      />
      {/* Section corner label — frames the failure chain as a risk map,
          not a generic problem list. Mobile-hidden to keep density. */}
      <div className="absolute inset-x-0 top-6 hidden justify-center text-[10.5px] font-semibold uppercase tracking-[0.22em] text-[#94A3B8] md:flex">
        Failure chain · risk map
      </div>
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        {/* PROBLEM MAP — left narrative, right vertical "failure chain".
            Each challenge is a node on a connected chain, NOT an isolated
            card. The chain reads top-to-bottom: each failure compounds the
            next, creating review risk by the bottom of the section. */}
        <div className="grid gap-12 lg:grid-cols-[38fr_62fr] lg:items-start lg:gap-16">
          <div className="lg:sticky lg:top-24">
            <AccentEyebrow accent="problem">
              {content.challengesEyebrow}
            </AccentEyebrow>
            <SectionTitle>{content.challengesTitle}</SectionTitle>

            <div className="mt-7 space-y-4">
              {content.challengesNarrative.map((p, i) => (
                <p
                  key={i}
                  className="text-[15px] leading-[1.7] text-[#475569]"
                >
                  {p}
                </p>
              ))}
            </div>

            {/* Small caption that frames the failure chain on the right
                as a connected sequence, not a card grid. */}
            <div className="mt-7 hidden items-center gap-3 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8] lg:flex">
              <span
                aria-hidden="true"
                className="h-px w-8"
                style={{ background: "var(--section-accent-border)" }}
              />
              Failure chain · how risk compounds
            </div>
          </div>

          {/* Vertical failure chain — single column. A thin connector line
              runs the full height; each node has a numbered marker that
              breaks the line into segments, then a stacked title + body. */}
          <ol className="relative">
            {/* Connector line — sits behind the markers. */}
            <span
              aria-hidden="true"
              className="absolute left-[15px] top-3 bottom-3 w-px"
              style={{ background: "var(--section-accent-border)" }}
            />
            <div className="space-y-9">
              {content.challenges.map((c, i) => (
                <li
                  key={i}
                  className="relative grid grid-cols-[32px_1fr] items-start gap-x-5"
                >
                  {/* Numbered marker — white halo over the connector line
                      so the chain visibly breaks at each node. */}
                  <span
                    aria-hidden="true"
                    className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-[#F8FAFC] text-[12px] font-semibold tracking-[-0.01em]"
                  >
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full border"
                      style={{
                        borderColor: "var(--section-accent)",
                        color: "var(--section-accent)",
                        background:
                          "linear-gradient(180deg, #FFFFFF 0%, var(--section-accent-soft) 100%)",
                      }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </span>
                  <div>
                    <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                      {c.title}
                    </h3>
                    <p className="mt-2.5 text-[14.5px] leading-[1.75] text-[#526173]">
                      {c.body}
                    </p>
                  </div>
                </li>
              ))}
            </div>
          </ol>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 2 — WORKFLOW (white, horizontal process diagram)
// =========================================================================

function WorkflowSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative bg-white py-20 md:py-24"
      style={accentVars("workflow")}
    >
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        {/* Workflow intro centered above the pipeline. Pipeline stays
            full-width underneath. */}
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <AccentEyebrow accent="workflow">
            {content.workflowEyebrow}
          </AccentEyebrow>
          <SectionTitle center>{content.workflowTitle}</SectionTitle>

          <div className="mt-7 space-y-4">
            {content.workflowNarrative.map((p, i) => (
              <p
                key={i}
                className="text-[15px] leading-[1.7] text-[#475569]"
              >
                {p}
              </p>
            ))}
          </div>
        </div>

        {/* EVIDENCE LIFECYCLE DIAGRAM — wider, more substantial. Each
            step lives in its own quiet panel; a single elegant connector
            line runs through every step on desktop, and becomes a left
            rail on mobile. Restrained accent, no neon, no icon clutter. */}
        <div
          className={`mt-14 rounded-[24px] border border-[#E2E8F0] bg-white px-6 py-10 md:px-10 md:py-12 ${CARD_SHADOW}`}
        >
          <div className="mb-10 flex items-center justify-center gap-3">
            <span
              aria-hidden="true"
              className="h-px w-10"
              style={{ background: "var(--section-accent-border)" }}
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#64748B]">
              Evidence handling pipeline
            </span>
            <span
              aria-hidden="true"
              className="h-px w-10"
              style={{ background: "var(--section-accent-border)" }}
            />
          </div>

          <div className="relative">
            {/* Desktop connector — single elegant line through the
                step row. The circles draw a halo so the line breaks
                cleanly at each step. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-0 right-0 top-[22px] hidden h-px lg:block"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, var(--section-accent) 10%, var(--section-accent) 90%, transparent 100%)",
                opacity: 0.5,
              }}
            />

            <div className="flex flex-col gap-9 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
              {content.lifecycle.map((step, i) => (
                <div
                  key={step.label}
                  className="relative flex flex-1 items-start gap-4 lg:flex-col lg:items-center lg:gap-0"
                >
                  <div className="relative z-10 flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-white">
                    <div
                      className="flex h-[44px] w-[44px] items-center justify-center rounded-full border text-[13.5px] font-semibold tracking-[-0.01em]"
                      style={{
                        borderColor: "var(--section-accent-border)",
                        background:
                          "linear-gradient(180deg, #FFFFFF 0%, var(--section-accent-soft) 100%)",
                        color: "var(--section-accent)",
                      }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </div>
                  </div>

                  <div className="flex-1 lg:mt-6 lg:px-2 lg:text-center">
                    <div className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#071124]">
                      {step.label}
                    </div>
                    <p className="mt-2 text-[13.5px] leading-[1.6] text-[#526173] lg:max-w-[200px]">
                      {step.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 3 — PLATFORM CAPABILITIES (slate-50, grouped bands)
// =========================================================================

function PlatformCapabilitiesSection() {
  const groups = (
    ["Evidence", "Integrity", "Output", "Governance", "Workflow"] as const
  ).map((tag) => ({
    tag,
    style: CAPABILITY_TAG_STYLE[tag],
    items: PLATFORM_CAPABILITIES.filter((c) => c.tag === tag),
  }));

  return (
    <section
      className="relative bg-[#F5F7FA] py-20 md:py-24"
      style={accentVars("platform")}
    >
      <div className="relative mx-auto max-w-[1240px] px-6 md:px-8">
        {/* Intro centered above the architecture map. */}
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <AccentEyebrow accent="platform">Platform capabilities</AccentEyebrow>
          <SectionTitle center>
            The full platform behind every evidence record.
          </SectionTitle>
          <SectionSubtitle center>
            PROOVRA is the same platform on every page — what changes is how
            each team uses it. The operational capability matrix below applies
            to every record.
          </SectionSubtitle>

          {/* Single clean architecture caption above the panel — replaces
              the prior dark-bar header strip + duplicated labels. */}
          <div className="mt-7 flex flex-col items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.20em] text-[#475569]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#475569]" />
              Architecture view
            </span>
            <p className="text-center text-[13.5px] leading-[1.6] text-[#475569]">
              PROOVRA evidence operations architecture — every record carries these layers.
            </p>
          </div>
        </div>

        {/* CAPABILITY ARCHITECTURE MAP — five layered bands. The platform
            reads as a stack of architectural layers (Evidence at the
            base, Workflow at the top), not a flat spreadsheet. Each
            layer has a large category anchor on the left and its
            capability rows on the right. A thin vertical rail ties the
            bands together so the page reads as one architecture, not
            five disconnected cards. */}
        <div className="relative mt-12">
          {/* Vertical architecture rail — sits behind the left-column
              anchors and visually connects the five layers. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-[19px] top-6 bottom-6 hidden w-px md:block"
            style={{ background: "#E2E8F0" }}
          />

          <div className="space-y-4">
            {groups.map((g) => (
              <div
                key={g.tag}
                className={`relative overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
              >
                {/* Layer accent bar on the left edge — colored per layer
                    so each band still reads distinctly inside the unified
                    rail. */}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: g.style.dot }}
                />
                <div
                  className="grid gap-y-5 px-6 py-7 md:grid-cols-[220px_1fr] md:gap-x-10 md:px-9 md:py-8"
                  style={{
                    background: `linear-gradient(90deg, ${g.style.dot}08 0%, ${g.style.dot}03 22%, transparent 38%)`,
                  }}
                >
                  {/* LEFT — layer anchor: rail node + dot + label.
                      The 38px node sits on the architecture rail so each
                      layer feels like a step on a single stack. */}
                  <div className="flex items-start gap-3.5">
                    <span
                      aria-hidden="true"
                      className="relative z-10 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-white"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: g.style.dot }}
                      />
                      <span
                        className="absolute inset-0 rounded-full border"
                        style={{ borderColor: `${g.style.dot}33` }}
                      />
                    </span>
                    <div className="md:pt-1.5">
                      <div
                        className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: g.style.tagText }}
                      >
                        {g.tag}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT — capability rows for this layer. */}
                  <ul className="space-y-3.5 md:pl-2">
                    {g.items.map((cap) => (
                      <li
                        key={cap.name}
                        className="grid gap-y-1 md:grid-cols-[230px_1fr] md:gap-x-6"
                      >
                        <span className="text-[15px] font-semibold tracking-[-0.01em] text-[#071124]">
                          {cap.name}
                        </span>
                        <span className="text-[14px] leading-[1.65] text-[#526173]">
                          {cap.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 4 — COMPARISON TABLE (white)
// =========================================================================

function ComparisonSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative overflow-hidden py-20 md:py-24"
      style={{
        ...accentVars("comparison"),
        backgroundImage: "url('/assets/cards/icon-card.png')",
        backgroundSize: "cover",
        backgroundPosition: "center center",
        backgroundRepeat: "no-repeat",
        backgroundColor: "#050F33",
      }}
    >
      {/* Readability scrim — keeps the comparison columns legible
          without flattening the icon-card artwork. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(5,15,51,0.62) 0%, rgba(5,15,51,0.74) 100%)",
        }}
      />
      <div className="relative mx-auto max-w-[1240px] px-6 md:px-8">
        {/* Intro centered above the transformation model per spec. */}
        <div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
          <AccentEyebrow accent="comparison">
            {content.comparisonEyebrow}
          </AccentEyebrow>
          <h2 className="mx-auto mt-3 max-w-[760px] text-center text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#F1F5FF] md:text-[2rem]">
            {content.comparisonTitle}
          </h2>
          {content.comparisonIntro ? (
            <p className="mx-auto mt-3 max-w-[680px] text-center text-[14.5px] leading-[1.65] text-[#CBD5F5]">
              {content.comparisonIntro}
            </p>
          ) : null}
        </div>

        {/* TRANSFORMATION MODEL — left column reads as a fragmented
            "traditional" chain (warm muted tint, irregular dot column);
            center is a PROOVRA bridge (vertical pill that says PROOVRA
            replaces the ad-hoc chain); right column reads as a structured
            "PROOVRA" stack (cool muted tint, aligned check column). The
            page reads at-a-glance as Before → PROOVRA → After. */}
        <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-8">
          {/* LEFT — Traditional approach. Dark translucent panel with
              warm amber accent and light readable text. */}
          <div
            className="relative overflow-hidden rounded-[20px] border shadow-[0_18px_42px_rgba(0,0,0,0.32)] backdrop-blur-[2px]"
            style={{
              borderColor: "rgba(251,191,36,0.28)",
              background: "rgba(15,23,42,0.55)",
            }}
          >
            <div
              className="border-b px-6 py-4 text-[12px] font-bold uppercase tracking-[0.16em] text-[#FCD34D]"
              style={{
                borderColor: "rgba(251,191,36,0.28)",
                background: "rgba(251,191,36,0.10)",
              }}
            >
              Traditional approach
            </div>
            <ul
              className="divide-y"
              style={{ borderColor: "rgba(255,255,255,0.10)" }}
            >
              {content.comparisonRows.map((row, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 border-t-0 px-6 py-4 text-[14.5px] leading-[1.65] text-[#E5E7EB]"
                  style={{ borderColor: "rgba(255,255,255,0.10)" }}
                >
                  <span
                    aria-hidden="true"
                    className="mt-[0.55em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                    style={{ background: "rgba(251,191,36,0.18)", color: "#FBBF24" }}
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                      <path d="M2 4.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span>{row.traditional}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* CENTER — PROOVRA bridge. A vertical pill / divider that
              labels what the platform is doing between the two columns.
              On mobile it collapses into a single horizontal divider. */}
          <div className="relative flex items-center justify-center lg:w-[64px]">
            {/* Mobile divider — short rule + small label. Tuned for the
                dark icon-card backdrop. */}
            <div className="flex items-center gap-3 py-1 lg:hidden">
              <span
                aria-hidden="true"
                className="h-px w-12"
                style={{ background: "rgba(255,255,255,0.22)" }}
              />
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white">
                PROOVRA replaces the ad-hoc chain
              </span>
              <span
                aria-hidden="true"
                className="h-px w-12"
                style={{ background: "rgba(255,255,255,0.22)" }}
              />
            </div>

            {/* Desktop bridge — vertical pill with rotated label.
                Background and stroke tuned for the dark icon-card backdrop. */}
            <div className="hidden h-full w-full flex-col items-center justify-center lg:flex">
              <span
                aria-hidden="true"
                className="h-full w-px"
                style={{
                  background:
                    "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.28) 18%, rgba(255,255,255,0.28) 82%, transparent 100%)",
                }}
              />
              <div className="absolute top-1/2 -translate-y-1/2 rotate-180 [writing-mode:vertical-rl]">
                <div
                  className="rounded-full border px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white shadow-[0_8px_22px_rgba(0,0,0,0.32)]"
                  style={{
                    borderColor: "rgba(255,255,255,0.22)",
                    background: "rgba(5,15,51,0.55)",
                    backdropFilter: "blur(2px)",
                  }}
                >
                  PROOVRA replaces the ad-hoc chain
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT — PROOVRA evidence layer. Dark translucent panel with
              emerald accent and light readable text. */}
          <div
            className="relative overflow-hidden rounded-[20px] border shadow-[0_18px_42px_rgba(0,0,0,0.32)] backdrop-blur-[2px]"
            style={{
              borderColor: "rgba(16,185,129,0.32)",
              background: "rgba(15,23,42,0.55)",
            }}
          >
            <div
              className="border-b px-6 py-4 text-[12px] font-bold uppercase tracking-[0.16em] text-[#6EE7B7]"
              style={{
                borderColor: "rgba(16,185,129,0.32)",
                background: "rgba(16,185,129,0.12)",
              }}
            >
              PROOVRA evidence layer
            </div>
            <ul
              className="divide-y"
              style={{ borderColor: "rgba(255,255,255,0.10)" }}
            >
              {content.comparisonRows.map((row, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 px-6 py-4 text-[14.5px] font-medium leading-[1.65] text-white"
                  style={{ borderColor: "rgba(255,255,255,0.10)" }}
                >
                  <span
                    aria-hidden="true"
                    className="mt-[0.5em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                    style={{ background: "rgba(16,185,129,0.22)", color: "#10B981" }}
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                      <path
                        d="M1 4.5L3.5 7L8 1.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>{row.proovra}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 5 — OPERATIONS (slate-50)
// Numbered badge REMOVED — icon + title + description only
// =========================================================================

function OperationsSection({ content }: { content: UseCasePageContent }) {
  // OPERATIONAL USE MODEL — present operations as a single board where
  // each operation is a row in a structured ledger, not an isolated card
  // in a grid. The board is two columns wide so the page rhythm matches
  // the architecture map above it. Every operation item preserved.
  const half = Math.ceil(content.operationsItems.length / 2);
  const left = content.operationsItems.slice(0, half);
  const right = content.operationsItems.slice(half);

  const Row = ({ it }: { it: ListItem }) => {
    const Icon = iconForOperationTitle(it.title);
    return (
      <div className="grid grid-cols-[48px_1fr] items-start gap-4 px-6 py-5">
        <div className="flex flex-col items-center gap-2">
          <span
            className="flex h-11 w-11 items-center justify-center rounded-[12px] border"
            style={{
              borderColor: "var(--section-accent-border)",
              background:
                "linear-gradient(180deg, #FFFFFF 0%, var(--section-accent-soft) 100%)",
              color: "var(--section-accent)",
            }}
          >
            <Icon size={20} strokeWidth={1.75} />
          </span>
        </div>
        <div>
          <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[#071124]">
            {it.title}
          </h3>
          <p className="mt-2 text-[14.5px] leading-[1.7] text-[#526173]">
            {it.body}
          </p>
        </div>
      </div>
    );
  };

  return (
    <section
      className="relative bg-[#F8FAFC] py-20 md:py-24"
      style={accentVars("operations")}
    >
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        {/* Intro centered above the operations board. */}
        <div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
          <AccentEyebrow accent="operations">
            {content.operationsEyebrow}
          </AccentEyebrow>
          <SectionTitle center>{content.operationsTitle}</SectionTitle>
          {content.operationsIntro ? (
            <SectionSubtitle center>
              {content.operationsIntro}
            </SectionSubtitle>
          ) : null}
        </div>

        {/* Operations board — a single unified panel with two columns
            of rows. A thin accent rule at the top reads as a board header;
            an internal divider separates the two columns; each row is a
            numbered, icon-led operation entry. Reads like an operations
            ledger, not a card grid. */}
        <div
          className={`mt-12 relative overflow-hidden rounded-[20px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-[2px]"
            style={{ background: "var(--section-accent)" }}
          />
          <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8FAFC] px-6 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--section-accent)" }}>
              Operations board
            </span>
            <span className="font-mono text-[11px] text-[#64748B]">
              {String(content.operationsItems.length).padStart(2, "0")} operations
            </span>
          </div>

          <div className="grid md:grid-cols-2 md:divide-x md:divide-[#E2E8F0]">
            <div className="divide-y divide-[#E2E8F0]">
              {left.map((it, i) => (
                <Row key={i} it={it} />
              ))}
            </div>
            <div className="divide-y divide-[#E2E8F0] border-t border-[#E2E8F0] md:border-t-0">
              {right.map((it, i) => (
                <Row key={i} it={it} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 6 — GOVERNANCE (light premium surface)
// =========================================================================

function GovernanceSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative bg-[#F5F7FA] py-20 md:py-24"
      style={accentVars("governance")}
    >
      <div className="mx-auto max-w-[1240px] px-6 md:px-8">
        {/* Intro centered above the items + panel grid per spec. */}
        <div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
          <AccentEyebrow accent="governance">
            {content.governanceEyebrow}
          </AccentEyebrow>
          <SectionTitle center>{content.governanceTitle}</SectionTitle>
          {content.governanceIntro ? (
            <SectionSubtitle center>
              {content.governanceIntro}
            </SectionSubtitle>
          ) : null}
        </div>

        {/* Single clean centered caption above the governance composition
            (replaces the prior dark-bar header strip + 3 duplicated
            labels that lived inside the panel). */}
        <p className="mx-auto mt-7 max-w-[680px] text-center text-[13.5px] leading-[1.6] text-[#475569]">
          Governance is attached to the evidence record, not added later.
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
          {/* GOVERNANCE STACK — vertical layered stack with subtle
              connectors. Each layer is one governance concept, ordered
              from foundational (access/roles) at the bottom to applied
              (reviewer access, audit history) at the top. A thin rail
              ties the layers together so the page reads as a stack, not
              a card grid. */}
          <ol className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-[15px] top-3 bottom-3 w-px"
              style={{ background: "var(--section-accent-border)" }}
            />
            <div className="space-y-6">
              {content.governanceItems.map((it, i) => (
                <li
                  key={i}
                  className="relative grid grid-cols-[32px_1fr] items-start gap-x-5"
                >
                  <span
                    aria-hidden="true"
                    className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white"
                  >
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold tracking-[-0.01em]"
                      style={{
                        borderColor: "var(--section-accent)",
                        color: "var(--section-accent)",
                        background:
                          "linear-gradient(180deg, #FFFFFF 0%, var(--section-accent-soft) 100%)",
                      }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </span>
                  <div className="rounded-[14px] border border-[#E2E8F0] bg-white px-5 py-4 shadow-[0_6px_18px_rgba(15,23,42,0.04)]">
                    <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[#071124]">
                      {it.title}
                    </h3>
                    <p className="mt-2 text-[14.5px] leading-[1.75] text-[#526173]">
                      {it.body}
                    </p>
                  </div>
                </li>
              ))}
            </div>
          </ol>

          {/* Governance-controls mockup — soft white→slate gradient with a
              more deliberate shadow so the right panel feels like a real
              product surface rather than a flat card. */}
          <div
            className="relative rounded-[20px] border border-[#E2E8F0] p-6 shadow-[0_30px_70px_rgba(15,23,42,0.10)]"
            style={{
              background:
                "linear-gradient(180deg, #FFFFFF 0%, #F4F7FB 100%)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#5B21B6]">
                Governance controls
              </span>
              <span className="font-mono text-[12px] text-[#64748B]">
                Workspace · matter-014
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-[12px] border border-[#E2E8F0] bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Retention policy
                  </span>
                  <span
                    className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{
                      color: SECTION_ACCENTS.governance.eyebrowText,
                      background: SECTION_ACCENTS.governance.eyebrowBg,
                      borderColor: SECTION_ACCENTS.governance.eyebrowBorder,
                    }}
                  >
                    7 years
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] text-[#64748B]">
                  Disposition · matter-aligned
                </p>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Legal hold
                  </span>
                  <span
                    className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{
                      color: SECTION_ACCENTS.governance.eyebrowText,
                      background: SECTION_ACCENTS.governance.eyebrowBg,
                      borderColor: SECTION_ACCENTS.governance.eyebrowBorder,
                    }}
                  >
                    Active
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] text-[#64748B]">
                  Retention suspended · placed 2026-04-08
                </p>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Access roles
                  </span>
                  <span className="text-[12.5px] text-[#64748B]">5 roles</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    "Reviewer",
                    "Counsel",
                    "Expert",
                    "Auditor",
                    "Admin",
                  ].map((r) => (
                    <span
                      key={r}
                      className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-0.5 text-[11.5px] text-[#0F172A]"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Audit trail
                  </span>
                  <span className="text-[12.5px] text-[#64748B]">
                    Last 30 days · 142 events
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-[12px] text-[#64748B]">
                  <li>· reviewer.access · 14:32 UTC</li>
                  <li>· report.generated · 09:18 UTC</li>
                  <li>· retention.applied · 09:14 UTC</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 7 — VERIFICATION SURFACE (signature dark band — single dark interior)
// =========================================================================

function VerificationSurfacePanel({
  content,
}: {
  content: UseCasePageContent;
}) {
  return (
    <section
      className="relative overflow-hidden py-24 md:py-28"
      style={{
        backgroundImage: "url('/assets/cards/icon-card.png')",
        backgroundRepeat: "no-repeat",
        backgroundSize: "cover",
        backgroundPosition: "center center",
      }}
    >
      {/* Subtle scrim — keeps left-column copy and the right-column
          Evidence-record detail card readable against the dark artwork,
          without tinting the embedded brand mark. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(5,10,28,0.42) 0%, rgba(5,10,28,0.55) 100%)",
        }}
      />

      <div className="relative z-10 mx-auto max-w-[1280px] px-6 md:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <Eyebrow tone="dark">The verification surface</Eyebrow>
            <h2 className="mt-3 max-w-[640px] text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#edf3f0] md:text-[2.1rem]">
              One reviewer-facing layer for every record.
            </h2>
            <p className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#CBD5F5]">
              {content.visualCaption}
            </p>

            <div className="mt-8 overflow-hidden rounded-[20px] border border-white/12 bg-white shadow-[0_30px_80px_rgba(0,0,0,0.40)]">
              <img
                src={content.verificationImage}
                alt=""
                className="block h-auto w-full object-contain"
              />
            </div>
          </div>

          <div>
            {/* Glass / backdrop-blur removed — the underlying card image
                now reads clearly behind a transparent table surface.
                Subtle white hairline border kept for structure only. */}
            <div className="rounded-[20px] border border-white/12 bg-transparent p-6">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00D4FF]">
                  Evidence record
                </span>
                <span className="font-mono text-[12px] text-[#CBD5F5]">
                  ER-2026-04812
                </span>
              </div>

              <div className="mt-5 grid gap-4">
                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                  <span className="text-[14px] font-medium text-[#edf3f0]">
                    Integrity state
                  </span>
                  <span className="ml-auto text-[13px] text-[#CBD5F5]">
                    Match · captured at completion
                  </span>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                  <span className="text-[14px] font-medium text-[#edf3f0]">
                    Hash · SHA-256
                  </span>
                  <span className="ml-auto font-mono text-[12px] text-[#CBD5F5]">
                    9e3a…f04b
                  </span>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                  <span className="text-[14px] font-medium text-[#edf3f0]">
                    Timestamp context
                  </span>
                  <span className="ml-auto text-[13px] text-[#CBD5F5]">
                    RFC 3161 · OpenTimestamps
                  </span>
                </div>

                <div className="border-b border-white/8 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                    <span className="text-[14px] font-medium text-[#edf3f0]">
                      Custody history
                    </span>
                    <span className="ml-auto text-[13px] text-[#CBD5F5]">
                      4 events
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1 pl-5 text-[12.5px] text-[#CBD5F5]">
                    <li>Created · 2026-04-12 09:14</li>
                    <li>Upload completed · 2026-04-12 09:14</li>
                    <li>Report generated · 2026-04-12 09:18</li>
                    <li>Reviewer accessed · 2026-04-12 14:32</li>
                  </ul>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                  <span className="text-[14px] font-medium text-[#edf3f0]">
                    Report
                  </span>
                  <span className="ml-auto text-[13px] text-[#CBD5F5]">
                    PDF · ready
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#00D4FF]" />
                  <span className="text-[14px] font-medium text-[#edf3f0]">
                    Verification package
                  </span>
                  <span className="ml-auto text-[13px] text-[#CBD5F5]">
                    Shareable
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 8 — REPORTING & VERIFICATION (slate-50, three product mockups)
// Numbered badge REMOVED from list rows
// =========================================================================

function ReportingSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative bg-[#F8FAFC] py-20 md:py-24"
      style={accentVars("reporting")}
    >
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        {/* Intro centered above the layout per spec. */}
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <AccentEyebrow accent="reporting">
            {content.reportingEyebrow}
          </AccentEyebrow>
          <SectionTitle center>{content.reportingTitle}</SectionTitle>
          {content.reportingIntro ? (
            <SectionSubtitle center>
              {content.reportingIntro}
            </SectionSubtitle>
          ) : null}
        </div>

        {/* DELIVERABLES FLOW BAR — labels above the artifact column
            frame what reviewers receive as a connected sequence rather
            than disconnected card outputs. */}
        <div className="mx-auto mt-10 flex flex-wrap items-center justify-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.20em] text-[#94A3B8]">
          {["Record", "Page", "Package", "Report", "Review"].map((label, i) => (
            <span key={label} className="flex items-center gap-2">
              <span className="rounded-full border border-[#E2E8F0] bg-white px-2.5 py-1 text-[#475569]">
                {label}
              </span>
              {i < 4 ? (
                <span aria-hidden className="text-[#CBD5E1]">→</span>
              ) : null}
            </span>
          ))}
        </div>

        {/* Restored two-column layout: descriptions (reportingItems) on
            the LEFT, mini-preview cards on the RIGHT. Stacks on mobile.
            Every existing card and description preserved. */}
        <div className="mt-8 grid gap-8 lg:grid-cols-2 lg:items-start lg:gap-10">
          {/* LEFT — descriptions */}
          <ul className="grid gap-5">
            {content.reportingItems.map((it, i) => (
              <li
                key={i}
                className={`relative overflow-hidden rounded-[16px] border border-[#E2E8F0] bg-white p-5 ${CARD_SHADOW}`}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[2px]"
                  style={{ background: "var(--section-accent)" }}
                />
                <h3 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[#071124]">
                  {it.title}
                </h3>
                <p className="mt-2 text-[14.5px] leading-[1.7] text-[#526173]">
                  {it.body}
                </p>
              </li>
            ))}
          </ul>

          {/* RIGHT — mini-preview cards */}
          <div className="grid gap-5">
          {/* Verification Page — burgundy accent (Reporting section) */}
          <div className="overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white shadow-[0_22px_48px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8EEF3] px-5 py-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[#7A1F3D]"
                />
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5E1730]">
                  Output · Verification Page
                </div>
              </div>
              <span className="font-mono text-[10.5px] text-[#5E1730]/80">
                Live
              </span>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#071124]">
                  Record
                </span>
                <span className="font-mono text-[12px] text-[#64748B]">
                  ER-04812
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[13.5px] text-[#526173]">
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>Integrity</span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(122,31,61,0.22)] bg-[#F8EEF3] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.10em] text-[#5E1730]">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-[#7A1F3D]"
                    />
                    Match
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>Timestamp</span>
                  <span className="font-medium text-[#071124]">RFC 3161</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>Custody</span>
                  <span className="font-medium text-[#071124]">4 events</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Re-check</span>
                  <span className="font-medium text-[#5E1730]">Available →</span>
                </div>
              </div>
            </div>
          </div>

          {/* Verification Package — burgundy accent (Reporting section) */}
          <div className="overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white shadow-[0_22px_48px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8EEF3] px-5 py-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[#7A1F3D]"
                />
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5E1730]">
                  Output · Verification Package
                </div>
              </div>
              <span className="font-mono text-[10.5px] text-[#5E1730]/80">
                Signed
              </span>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#071124]">
                  Bundle
                </span>
                <span className="font-mono text-[12px] text-[#64748B]">
                  PKG-1042
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[13.5px] text-[#526173]">
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>· Evidence record</span>
                  <span className="font-medium text-[#071124]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>· PDF report</span>
                  <span className="font-medium text-[#071124]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-2">
                  <span>· Technical materials</span>
                  <span className="font-medium text-[#071124]">3</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>· Verification page link</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(122,31,61,0.22)] bg-[#F8EEF3] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.10em] text-[#5E1730]">
                    Shareable
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* PDF Report — burgundy accent (Reporting section) */}
          <div className="overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white shadow-[0_22px_48px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8EEF3] px-5 py-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[#7A1F3D]"
                />
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5E1730]">
                  Output · PDF Report
                </div>
              </div>
              <span className="font-mono text-[10.5px] text-[#5E1730]/80">
                7 pp
              </span>
            </div>
            <div className="p-5">
              <div className="rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#071124]">
                  Evidence Record Report
                </div>
                <div className="mt-1 font-mono text-[11.5px] text-[#64748B]">
                  ER-2026-04812 · 7 pages
                </div>
                <div className="mt-4 space-y-1.5">
                  <div className="h-1.5 w-[88%] rounded bg-[#CBD5E1]" />
                  <div className="h-1.5 w-[74%] rounded bg-[#CBD5E1]" />
                  <div className="h-1.5 w-[82%] rounded bg-[#CBD5E1]" />
                  <div className="h-1.5 w-[68%] rounded bg-[#CBD5E1]" />
                  <div className="h-1.5 w-[78%] rounded bg-[#CBD5E1]" />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-[#E2E8F0] pt-2.5 text-[11.5px] text-[#64748B]">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-[#7A1F3D]"
                    />
                    Signed · digital signature
                  </span>
                  <span className="font-mono">9e3a…f04b</span>
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

// =========================================================================
// SECTION 9 — FAQ (white)
// =========================================================================

function FAQSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative py-20 md:py-24"
      style={{
        ...accentVars("faq"),
        background:
          "linear-gradient(180deg, #FFFFFF 0%, var(--section-accent-soft) 100%)",
      }}
    >
      {/* FAQ uses a wider container so two side-by-side columns get
          breathing room on desktop. The header still anchors at the
          top in a single column above the grid (consistent with the
          rest of the page's left/right rhythm — header reads as a
          full-width anchor for the two FAQ columns underneath). */}
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        {/* Intro centered above the two-column accordion. */}
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <AccentEyebrow accent="faq">{content.faqEyebrow}</AccentEyebrow>
          <SectionTitle center>{content.faqTitle}</SectionTitle>
          {content.faqIntro ? (
            <SectionSubtitle center>{content.faqIntro}</SectionSubtitle>
          ) : null}
        </div>

        {/* FAQ — two INDEPENDENT column containers on desktop so that
            opening an item in one column does NOT stretch the
            corresponding item in the other column. Even indices fall in
            the left column, odd indices in the right column. Mobile
            stacks into one column. All accordion behaviour, copy, and
            animations preserved. */}
        {(() => {
          const left = content.faqs.filter((_, i) => i % 2 === 0);
          const right = content.faqs.filter((_, i) => i % 2 === 1);
          const FaqItem = ({ f }: { f: FaqItem }) => (
            <details
              className="group rounded-[14px] border bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)] transition-all open:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
              style={{ borderColor: "var(--section-accent-border)" }}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-[#071124] transition-colors hover:text-[#0F172A]">
                <span>{f.q}</span>
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[15px] font-semibold transition-all duration-200 group-open:rotate-45 group-open:text-white"
                  style={{
                    borderColor: "var(--section-accent-border)",
                    background: "var(--section-accent-soft)",
                    color: "var(--section-accent)",
                  }}
                >
                  +
                </span>
              </summary>
              <div className="border-t border-[#EEF2F6] px-5 py-4 text-[14.5px] leading-[1.7] text-[#526173]">
                {f.a}
              </div>
            </details>
          );
          return (
            <div className="mt-10 grid items-start gap-3 lg:grid-cols-2 lg:gap-x-6">
              <div className="flex flex-col gap-3">
                {left.map((f, i) => (
                  <FaqItem key={`l-${i}`} f={f} />
                ))}
              </div>
              <div className="flex flex-col gap-3">
                {right.map((f, i) => (
                  <FaqItem key={`r-${i}`} f={f} />
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </section>
  );
}

function LimitationNote() {
  // Top spacing reserved so the bordered notice no longer touches the
  // section above it — purely additive padding above the existing box.
  return (
    <section className="bg-white pt-8 pb-14 md:pt-10">
      <div className="mx-auto max-w-[820px] px-6 md:px-8">
        <div className="rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
            Important limitation
          </div>
          <p className="mt-2 text-[13.5px] leading-[1.7] text-[#475569]">
            {LIMITATION_COPY}
          </p>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 10 — FINAL CTA (dark — consistent with all marketing-site CTAs)
// =========================================================================

function FinalCTA({ content }: { content: UseCasePageContent }) {
  // Final CTA — matches the Platform-page CTA design system exactly
  // (apps/web/app/platform/page.tsx ~L2030-2086): navy → indigo → wine
  // → violet gradient, rounded-[28px], compact p-7/md:p-9, navy chip
  // eyebrow, white primary button with violet text, outlined secondary.
  // All copy preserved unchanged. Top spacing kept from the prior pass
  // so the panel never butts against the FAQ/LimitationNote above.
  return (
    <section className="relative bg-white pt-12 pb-14 md:pt-16 md:pb-20">
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
                className="mt-3 max-w-[560px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] md:text-[1.85rem]"
                style={{ color: "#FFFFFF" }}
              >
                {content.ctaTitle}
              </h2>
              <p
                className="mt-2.5 max-w-[560px] text-[13.5px] leading-[1.6]"
                style={{ color: "rgba(255,255,255,0.88)" }}
              >
                {content.ctaBody}
              </p>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:justify-end">
              <Link
                href={SALES_ASSETS.requestDemoUrl}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#6A35C9] transition-all duration-200 hover:-translate-y-0.5 hover:text-[#5A2CC0]"
                style={{ fontWeight: 600 }}
              >
                Request Demo
                <ArrowRight size={14} />
              </Link>
              <a
                href={SALES_ASSETS.sampleReportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/40 px-5 text-[13.5px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10"
              >
                View Sample Report
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// PAGE
// =========================================================================

export function UseCasePage({ content }: { content: UseCasePageContent }) {
  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <Hero content={content} />
      <RevealSection direction="up"><IndustryChallengesSection content={content} /></RevealSection>
      <RevealSection direction="right"><WorkflowSection content={content} /></RevealSection>
      <RevealSection direction="left"><PlatformCapabilitiesSection /></RevealSection>
      <RevealSection direction="up"><ComparisonSection content={content} /></RevealSection>
      <RevealSection direction="right"><OperationsSection content={content} /></RevealSection>
      <RevealSection direction="left"><GovernanceSection content={content} /></RevealSection>
      <RevealSection direction="up"><VerificationSurfacePanel content={content} /></RevealSection>
      <RevealSection direction="right"><ReportingSection content={content} /></RevealSection>
      <RevealSection direction="left"><FAQSection content={content} /></RevealSection>
      <RevealSection direction="up"><LimitationNote /></RevealSection>
      <RevealSection direction="right"><FinalCTA content={content} /></RevealSection>
      <EnterpriseFooter />
    </div>
  );
}
