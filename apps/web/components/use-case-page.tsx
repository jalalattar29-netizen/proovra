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
  FileText,
  Inbox,
  Lock,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { MarketingHeader } from "./marketing/MarketingHeader";
import { EnterpriseFooter } from "./marketing/EnterpriseFooter";
import type { UseCasePageContent } from "./use-case-data";
import { SALES_ASSETS } from "../lib/sales-assets";

// =========================================================================
// SHARED DESIGN-SYSTEM TOKENS — exact match for Pricing + Platform pages
// =========================================================================

// Solutions-pages hero highlight gradient — warm orange → coral → magenta.
// Scoped to this file only (Pricing/Platform define their own brand gradient).
const BRAND_GRADIENT_TEXT =
  "linear-gradient(90deg,#FF7A1A 0%,#FF4D5E 50%,#E83FAE 100%)";

const CARD_SHADOW = "shadow-[0_18px_40px_rgba(15,23,42,0.06)]";

const LIMITATION_COPY =
  "PROOVRA verifies recorded integrity signals, timestamp-related context, custody metadata, and supporting review materials. It does not determine factual truth, authorship, identity, or legal admissibility.";

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

function SectionHeader({
  eyebrow,
  title,
  intro,
  tone = "light",
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  tone?: "light" | "dark";
}) {
  return (
    <div className="max-w-[760px]">
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <SectionTitle tone={tone}>{title}</SectionTitle>
      {intro ? (
        <SectionSubtitle tone={tone}>{intro}</SectionSubtitle>
      ) : null}
    </div>
  );
}

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

// Capability tag colors map to Pricing/Platform palette: blue / violet / cyan / pink.
const CAPABILITY_TAG_STYLE: Record<
  PlatformCapability["tag"],
  { dot: string; tagText: string }
> = {
  Evidence: { dot: "#06B6D4", tagText: "#0E7490" },
  Integrity: { dot: "#2563EB", tagText: "#1D4ED8" },
  Output: { dot: "#7C3AED", tagText: "#5B21B6" },
  Governance: { dot: "#EC4899", tagText: "#9D174D" },
  Workflow: { dot: "#A855F7", tagText: "#7E22CE" },
};

// =========================================================================
// Icon mapping — workflow + operations
// =========================================================================

function iconForLifecycleLabel(label: string) {
  const l = label.toLowerCase();
  if (
    l.includes("intake") ||
    l.includes("submission") ||
    l.includes("fnol") ||
    l.includes("incident") ||
    l.includes("source")
  )
    return Inbox;
  if (
    l.includes("record") ||
    l.includes("capture") ||
    l.includes("preserv") ||
    l.includes("archive") ||
    l.includes("public record")
  )
    return Database;
  if (l.includes("verification") || l.includes("verify")) return ShieldCheck;
  if (l.includes("review") || l.includes("editorial") || l.includes("adjuster"))
    return Eye;
  if (
    l.includes("report") ||
    l.includes("publication") ||
    l.includes("resolution")
  )
    return FileText;
  if (
    l.includes("govern") ||
    l.includes("oversight") ||
    l.includes("escalation")
  )
    return Lock;
  return Database;
}

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
  return (
    <div className="relative min-h-[640px] overflow-hidden md:min-h-[720px] lg:min-h-[760px]">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/hero/soloutions-hero.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "cover",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,12,22,0.28) 0%, rgba(6,12,22,0.18) 38%, rgba(6,12,22,0.50) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(122,60,255,0.14),transparent_45%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_82%_28%,rgba(0,212,255,0.10),transparent_45%)]"
      />

      <div className="relative z-10 flex min-h-[640px] flex-col md:min-h-[720px] lg:min-h-[760px]">
        <MarketingHeader />

        <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-6 pb-20 pt-24 text-center md:px-8 md:pb-28 md:pt-28 lg:pt-32">
          <Eyebrow center tone="dark">
            {content.eyebrow}
          </Eyebrow>

          <h1 className="mx-auto mt-5 max-w-[940px] text-[2.05rem] font-semibold leading-[1.06] tracking-[-0.025em] text-white md:text-[2.85rem] lg:text-[3.25rem]">
            {content.headline}{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: BRAND_GRADIENT_TEXT }}
            >
              {content.headlineHighlight}
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-[760px] text-[15px] leading-[1.65] text-[#dfe7e2] md:text-[15.5px]">
            {content.subhead}
          </p>

          <div className="mx-auto mt-7 flex max-w-[860px] flex-wrap items-center justify-center gap-x-3 gap-y-2.5">
            {content.proofPoints.map((p) => (
              <span
                key={p}
                className="inline-flex items-center rounded-full border border-white/14 bg-white/[0.07] px-3.5 py-1.5 text-[12.5px] text-[#eef3f1] backdrop-blur-md"
              >
                <span className="mr-2 text-[#00D4FF]">✓</span>
                {p}
              </span>
            ))}
          </div>

          <div className="mx-auto mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={SALES_ASSETS.requestDemoUrl}
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-transparent px-7 py-3 text-[14px] font-semibold text-white shadow-[0_18px_38px_rgba(232,63,174,0.32)] transition duration-300 hover:translate-y-[-1px] hover:brightness-110"
              style={{
                background:
                  "linear-gradient(120deg,#E83FAE 0%,#6D28D9 100%)",
              }}
            >
              Request Demo
            </Link>
            <a
              href={SALES_ASSETS.sampleReportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/40 bg-white px-7 py-3 text-[14px] font-semibold text-[#5B21B6] shadow-[0_10px_22px_rgba(15,23,42,0.18)] transition duration-300 hover:translate-y-[-1px] hover:bg-[#F5F3FF]"
            >
              View Sample Report
            </a>
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
    <section className="bg-[#F8FAFC] py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.challengesEyebrow}
          title={content.challengesTitle}
        />

        <div className="mt-7 max-w-[760px] space-y-4">
          {content.challengesNarrative.map((p, i) => (
            <p
              key={i}
              className="text-[15px] leading-[1.7] text-[#475569]"
            >
              {p}
            </p>
          ))}
        </div>

        <dl className="mt-12 grid gap-x-12 gap-y-7 md:grid-cols-2">
          {content.challenges.map((c, i) => (
            <div key={i} className="border-t border-[#E2E8F0] pt-5">
              <dt className="text-[15.5px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                {c.title}
              </dt>
              <dd className="mt-2 text-[14.5px] leading-[1.7] text-[#475569]">
                {c.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 2 — WORKFLOW (white, horizontal process diagram)
// =========================================================================

function WorkflowSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.workflowEyebrow}
          title={content.workflowTitle}
        />

        <div className="mt-7 max-w-[760px] space-y-4">
          {content.workflowNarrative.map((p, i) => (
            <p
              key={i}
              className="text-[15px] leading-[1.7] text-[#475569]"
            >
              {p}
            </p>
          ))}
        </div>

        <div
          className={`mt-12 rounded-[20px] border border-[#E2E8F0] bg-white p-6 md:p-9 ${CARD_SHADOW}`}
        >
          <div className="mb-7 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
            Evidence handling pipeline
          </div>

          <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch lg:justify-between lg:gap-3">
            {content.lifecycle.map((step, i) => {
              const Icon = iconForLifecycleLabel(step.label);
              const isLast = i === content.lifecycle.length - 1;
              return (
                <div
                  key={step.label}
                  className="flex flex-1 items-start gap-4 lg:flex-col lg:items-center lg:gap-0"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border border-[#E0E7FF] bg-[#F8FAFC] text-[#2563EB]">
                    <Icon size={20} strokeWidth={1.8} />
                  </div>

                  <div className="flex-1 lg:mt-4 lg:px-2 lg:text-center">
                    <div className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                      {step.label}
                    </div>
                    <p className="mt-2 text-[13.5px] leading-[1.55] text-[#475569] lg:max-w-[200px]">
                      {step.body}
                    </p>
                  </div>

                  {!isLast ? (
                    <div
                      aria-hidden="true"
                      className="hidden self-center lg:flex"
                    >
                      <ArrowRight
                        size={16}
                        className="text-[#CBD5E1]"
                        strokeWidth={2}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
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
    <section className="bg-[#F8FAFC] py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow="Platform capabilities"
          title="The full platform behind every evidence record."
          intro="PROOVRA is the same platform on every page — what changes is how each team uses it. The operational capability matrix below applies to every record."
        />

        <div
          className={`mt-12 overflow-hidden rounded-[20px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
        >
          {groups.map((g, gi) => (
            <div
              key={g.tag}
              className={`grid gap-y-4 px-6 py-6 md:grid-cols-[200px_1fr] md:gap-x-10 md:px-9 md:py-7 ${
                gi !== groups.length - 1 ? "border-b border-[#E2E8F0]" : ""
              }`}
            >
              <div className="flex items-center gap-2.5 md:pt-1">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: g.style.dot }}
                />
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                  style={{ color: g.style.tagText }}
                >
                  {g.tag}
                </span>
              </div>
              <ul className="space-y-3.5">
                {g.items.map((cap) => (
                  <li
                    key={cap.name}
                    className="grid gap-y-1 md:grid-cols-[230px_1fr] md:gap-x-6"
                  >
                    <span className="text-[15px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                      {cap.name}
                    </span>
                    <span className="text-[14px] leading-[1.65] text-[#475569]">
                      {cap.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
    <section className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.comparisonEyebrow}
          title={content.comparisonTitle}
          intro={content.comparisonIntro}
        />

        <div
          className={`mt-12 overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
        >
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th className="border-b border-[#E2E8F0] bg-[#FFF7ED] px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9A3412]">
                  Traditional approach
                </th>
                <th className="border-b border-[#E2E8F0] bg-[#EEF2FF] px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1D4ED8]">
                  PROOVRA
                </th>
              </tr>
            </thead>
            <tbody>
              {content.comparisonRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-[#E2E8F0] last:border-b-0"
                >
                  <td className="bg-[#FFFBF5] px-6 py-4 align-top text-[14.5px] leading-[1.65] text-[#7C6F5E]">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#F59E0B]"
                      />
                      <span>{row.traditional}</span>
                    </div>
                  </td>
                  <td className="bg-white px-6 py-4 align-top text-[14.5px] font-medium leading-[1.65] text-[#0F172A]">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-[#2563EB]"
                      />
                      <span>{row.proovra}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  return (
    <section className="bg-[#F8FAFC] py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.operationsEyebrow}
          title={content.operationsTitle}
          intro={content.operationsIntro}
        />

        <ul className="mt-12 grid gap-5 md:grid-cols-2">
          {content.operationsItems.map((it, i) => {
            const Icon = iconForOperationTitle(it.title);
            return (
              <li
                key={i}
                className={`flex gap-4 rounded-[18px] border border-[#E2E8F0] bg-white p-6 ${CARD_SHADOW}`}
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#E0E7FF] bg-[#F8FAFC] text-[#2563EB]">
                  <Icon size={18} strokeWidth={1.9} />
                </div>
                <div className="flex-1">
                  <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                    {it.title}
                  </h3>
                  <p className="mt-2 text-[14.5px] leading-[1.7] text-[#475569]">
                    {it.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 6 — GOVERNANCE (light premium surface)
// =========================================================================

function GovernanceSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.governanceEyebrow}
          title={content.governanceTitle}
          intro={content.governanceIntro}
        />

        <div className="mt-12 grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
          <dl className="grid gap-x-10 gap-y-7 md:grid-cols-2 lg:grid-cols-1">
            {content.governanceItems.map((it, i) => (
              <div key={i} className="border-t border-[#E2E8F0] pt-5">
                <dt className="text-[15.5px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                  {it.title}
                </dt>
                <dd className="mt-2 text-[14.5px] leading-[1.7] text-[#475569]">
                  {it.body}
                </dd>
              </div>
            ))}
          </dl>

          {/* Premium governance-controls mockup, light surface */}
          <div
            className={`rounded-[20px] border border-[#E2E8F0] bg-white p-6 ${CARD_SHADOW}`}
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
              <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Retention policy
                  </span>
                  <span className="rounded-full border border-[#FCE7F3] bg-[#FDF2F8] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9D174D]">
                    7 years
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] text-[#64748B]">
                  Disposition · matter-aligned
                </p>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#0F172A]">
                    Legal hold
                  </span>
                  <span className="rounded-full border border-[#E9D5FF] bg-[#F5F3FF] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#7E22CE]">
                    Active
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] text-[#64748B]">
                  Retention suspended · placed 2026-04-08
                </p>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
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
                      className="rounded-full border border-[#E2E8F0] bg-white px-2.5 py-0.5 text-[11.5px] text-[#0F172A]"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
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
        background:
          "linear-gradient(160deg,#0B1437 0%,#0E1E4A 55%,#15225E 100%)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_22%,rgba(0,212,255,0.12),transparent_45%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_78%,rgba(122,60,255,0.14),transparent_45%)]" />

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
            <div className="rounded-[20px] border border-white/12 bg-white/[0.04] p-6 backdrop-blur-md">
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
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#7A3CFF]" />
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
    <section className="bg-[#F8FAFC] py-20 md:py-24">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.reportingEyebrow}
          title={content.reportingTitle}
          intro={content.reportingIntro}
        />

        {/* Product output mockups */}
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {/* Verification Page */}
          <div
            className={`overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
          >
            <div className="border-b border-[#E2E8F0] bg-[#ECFEFF] px-5 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#0E7490]">
                Output · Verification Page
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#0F172A]">
                  Record
                </span>
                <span className="font-mono text-[12px] text-[#64748B]">
                  ER-04812
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[13.5px] text-[#475569]">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>Integrity</span>
                  <span className="font-medium text-[#0F9B6C]">Match</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>Timestamp</span>
                  <span>RFC 3161</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>Custody</span>
                  <span>4 events</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Re-check</span>
                  <span className="text-[#1D4ED8]">Available →</span>
                </div>
              </div>
            </div>
          </div>

          {/* Verification Package */}
          <div
            className={`overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
          >
            <div className="border-b border-[#E2E8F0] bg-[#F5F3FF] px-5 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5B21B6]">
                Output · Verification Package
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#0F172A]">
                  Bundle
                </span>
                <span className="font-mono text-[12px] text-[#64748B]">
                  PKG-1042
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[13.5px] text-[#475569]">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>· Evidence record</span>
                  <span className="text-[#64748B]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>· PDF report</span>
                  <span className="text-[#64748B]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span>· Technical materials</span>
                  <span className="text-[#64748B]">3</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>· Verification page link</span>
                  <span className="text-[#5B21B6]">Shareable</span>
                </div>
              </div>
            </div>
          </div>

          {/* PDF Report */}
          <div
            className={`overflow-hidden rounded-[18px] border border-[#E2E8F0] bg-white ${CARD_SHADOW}`}
          >
            <div className="border-b border-[#E2E8F0] bg-[#FDF2F8] px-5 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9D174D]">
                Output · PDF Report
              </div>
            </div>
            <div className="p-5">
              <div className="rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0F172A]">
                  Evidence Record Report
                </div>
                <div className="mt-2 text-[12px] text-[#64748B]">
                  ER-2026-04812 · 7 pages
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1.5 w-[88%] rounded bg-[#E2E8F0]" />
                  <div className="h-1.5 w-[74%] rounded bg-[#E2E8F0]" />
                  <div className="h-1.5 w-[82%] rounded bg-[#E2E8F0]" />
                  <div className="h-1.5 w-[68%] rounded bg-[#E2E8F0]" />
                  <div className="h-1.5 w-[78%] rounded bg-[#E2E8F0]" />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-[#E2E8F0] pt-2 text-[12px] text-[#64748B]">
                  <span>Signed · digital signature</span>
                  <span className="font-mono">9e3a…f04b</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Reporting items — no numbered badges, just title + body */}
        <ul className="mt-10 grid gap-5 md:grid-cols-2">
          {content.reportingItems.map((it, i) => (
            <li
              key={i}
              className={`rounded-[16px] border border-[#E2E8F0] bg-white p-5 ${CARD_SHADOW}`}
            >
              <h3 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[#0F172A]">
                {it.title}
              </h3>
              <p className="mt-2 text-[14.5px] leading-[1.7] text-[#475569]">
                {it.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 9 — FAQ (white)
// =========================================================================

function FAQSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-white py-20 md:py-24">
      <div className="mx-auto max-w-[820px] px-6 md:px-8">
        <SectionHeader
          eyebrow={content.faqEyebrow}
          title={content.faqTitle}
          intro={content.faqIntro}
        />

        <div className="mt-10 space-y-3">
          {content.faqs.map((f, i) => (
            <details
              key={i}
              className={`group rounded-[14px] border border-[#E2E8F0] bg-white open:${CARD_SHADOW}`}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-[#0F172A]">
                <span>{f.q}</span>
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0] text-[15px] text-[#475569] transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <div className="border-t border-[#E2E8F0] px-5 py-4 text-[14.5px] leading-[1.7] text-[#475569]">
                {f.a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function LimitationNote() {
  return (
    <section className="bg-white pb-14">
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
  return (
    <section className="relative overflow-hidden bg-[#0B1437] py-20 md:py-24">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(122,60,255,0.18),transparent_45%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_78%,rgba(0,212,255,0.14),transparent_45%)]" />

      <div className="relative z-10 mx-auto max-w-[820px] px-6 text-center md:px-8">
        <h2 className="text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[2.1rem]">
          {content.ctaTitle}
        </h2>
        <p className="mx-auto mt-4 max-w-[640px] text-[15px] leading-[1.65] text-[#CBD5F5]">
          {content.ctaBody}
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={SALES_ASSETS.requestDemoUrl}
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/14 px-7 py-3 text-[14px] font-semibold text-white shadow-[0_18px_36px_rgba(91,33,182,0.32)] transition duration-300 hover:translate-y-[-1px]"
            style={{
              background:
                "linear-gradient(120deg,#2D2A7B 0%,#5B21B6 48%,#A21CAF 100%)",
            }}
          >
            Request Demo
          </Link>
          <a
            href={SALES_ASSETS.sampleReportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/22 bg-white/[0.045] px-7 py-3 text-[14px] font-semibold text-[#eef3f1] backdrop-blur-md transition duration-300 hover:translate-y-[-1px] hover:bg-white/[0.08]"
          >
            View Sample Report
          </a>
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
      <IndustryChallengesSection content={content} />
      <WorkflowSection content={content} />
      <PlatformCapabilitiesSection />
      <ComparisonSection content={content} />
      <OperationsSection content={content} />
      <GovernanceSection content={content} />
      <VerificationSurfacePanel content={content} />
      <ReportingSection content={content} />
      <FAQSection content={content} />
      <LimitationNote />
      <FinalCTA content={content} />
      <EnterpriseFooter />
    </div>
  );
}
