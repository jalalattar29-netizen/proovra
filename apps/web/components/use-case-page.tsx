"use client";

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

const LIMITATION_COPY =
  "PROOVRA verifies recorded integrity signals, timestamp-related context, custody metadata, and supporting review materials. It does not determine factual truth, authorship, identity, or legal admissibility.";

const HEADLINE_ACCENT = "#67e8f9"; // solid brand cyan — enterprise, restrained

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

const CAPABILITY_TAG_STYLE: Record<
  PlatformCapability["tag"],
  { dot: string; tagText: string; band: string }
> = {
  Evidence: { dot: "#06b6d4", tagText: "#0e7490", band: "rgba(6,182,212,0.04)" },
  Integrity: { dot: "#2563eb", tagText: "#1d4ed8", band: "rgba(37,99,235,0.04)" },
  Output: { dot: "#7c3aed", tagText: "#5b21b6", band: "rgba(124,58,237,0.04)" },
  Governance: { dot: "#ec4899", tagText: "#9d174d", band: "rgba(236,72,153,0.04)" },
  Workflow: { dot: "#a855f7", tagText: "#7e22ce", band: "rgba(168,85,247,0.04)" },
};

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
  const eyebrowColor = tone === "dark" ? "#9dd2ca" : "#8e7863";
  const titleColor = tone === "dark" ? "#e9eee9" : "#1d3136";
  const introColor = tone === "dark" ? "#c2cdc6" : "#3d4f53";
  return (
    <div className="max-w-3xl">
      <div
        className="text-[0.76rem] font-semibold uppercase tracking-[0.24em]"
        style={{ color: eyebrowColor }}
      >
        {eyebrow}
      </div>
      <h2
        className="mt-4 text-[1.6rem] font-semibold leading-[1.14] tracking-[-0.03em] md:text-[2.1rem]"
        style={{ color: titleColor }}
      >
        {title}
      </h2>
      {intro ? (
        <p
          className="mt-5 text-[1.02rem] leading-[1.78]"
          style={{ color: introColor }}
        >
          {intro}
        </p>
      ) : null}
    </div>
  );
}

// =========================================================================
// HERO
// =========================================================================

function Hero({ content }: { content: UseCasePageContent }) {
  return (
    <div className="relative min-h-[640px] overflow-hidden md:min-h-[720px] lg:min-h-[760px]">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/assets/hero/legal-hero.png')",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center center",
          backgroundSize: "cover",
        }}
      />
      {/* much lighter overlay — keep image colors visible, ensure text legibility */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,12,22,0.28) 0%, rgba(6,12,22,0.18) 38%, rgba(6,12,22,0.48) 100%)",
        }}
      />

      <div className="relative z-10 flex min-h-[640px] flex-col md:min-h-[720px] lg:min-h-[760px]">
        <MarketingHeader />

        <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-6 pb-20 pt-12 text-center md:px-8 md:pb-28 md:pt-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/[0.07] px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-[#dfe7e2] shadow-[0_8px_22px_rgba(0,0,0,0.18)] backdrop-blur-md">
            <span className="h-1.5 w-1.5 rounded-full bg-[#a78bfa]" />
            {content.eyebrow}
          </div>

          <h1 className="mt-7 max-w-[960px] text-[2.15rem] font-semibold leading-[1.06] tracking-[-0.035em] text-white md:text-[3rem] lg:text-[3.5rem]">
            {content.headline}{" "}
            <span style={{ color: HEADLINE_ACCENT }}>
              {content.headlineHighlight}
            </span>
          </h1>

          <p className="mt-7 max-w-[800px] text-[1.04rem] leading-[1.78] text-[#e6ecea] md:text-[1.12rem]">
            {content.subhead}
          </p>

          <div className="mt-8 flex max-w-[860px] flex-wrap items-center justify-center gap-x-3 gap-y-2.5">
            {content.proofPoints.map((p) => (
              <span
                key={p}
                className="inline-flex items-center rounded-full border border-white/14 bg-white/[0.07] px-3.5 py-1.5 text-[0.78rem] text-[#eef3f1] backdrop-blur-md"
              >
                <span className="mr-2 text-[#9dd2ca]">✓</span>
                {p}
              </span>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={SALES_ASSETS.requestDemoUrl}
              className="inline-flex min-h-[50px] items-center justify-center rounded-full border border-white/14 px-8 py-3 text-[14px] font-semibold text-white shadow-[0_18px_38px_rgba(91,33,182,0.32)] transition duration-300 hover:translate-y-[-1px]"
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
              className="inline-flex min-h-[50px] items-center justify-center rounded-full border border-white/22 bg-white/[0.06] px-8 py-3 text-[14px] font-semibold text-[#eef3f1] backdrop-blur-md transition duration-300 hover:translate-y-[-1px] hover:bg-white/[0.10]"
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
// SECTION 1 — INDUSTRY CHALLENGES
// =========================================================================

function IndustryChallengesSection({
  content,
}: {
  content: UseCasePageContent;
}) {
  return (
    <section className="bg-[#f4f5f1] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.challengesEyebrow}
          title={content.challengesTitle}
        />
        <div className="mt-8 max-w-3xl space-y-5">
          {content.challengesNarrative.map((p, i) => (
            <p key={i} className="text-[1.02rem] leading-[1.85] text-[#3d4f53]">
              {p}
            </p>
          ))}
        </div>

        <dl className="mt-12 grid gap-x-12 gap-y-7 md:grid-cols-2">
          {content.challenges.map((c, i) => (
            <div
              key={i}
              className="border-t border-[rgba(79,112,107,0.22)] pt-5"
            >
              <dt className="text-[1.02rem] font-semibold tracking-[-0.01em] text-[#23373b]">
                {c.title}
              </dt>
              <dd className="mt-2 text-[0.96rem] leading-[1.78] text-[#55666a]">
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
// SECTION 2 — WORKFLOW (horizontal process diagram)
// =========================================================================

function WorkflowSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-[#fbfbf8] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.workflowEyebrow}
          title={content.workflowTitle}
        />
        <div className="mt-8 max-w-3xl space-y-5">
          {content.workflowNarrative.map((p, i) => (
            <p key={i} className="text-[1.02rem] leading-[1.85] text-[#3d4f53]">
              {p}
            </p>
          ))}
        </div>
      </div>

      {/* Horizontal process diagram with arrow connectors */}
      <div className="mx-auto mt-14 max-w-[1280px] px-6 md:px-8">
        <div className="rounded-[24px] border border-[rgba(79,112,107,0.22)] bg-white p-6 shadow-[0_18px_44px_rgba(8,18,22,0.06)] md:p-9">
          <div className="mb-7 text-center text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
            Evidence handling pipeline
          </div>

          {/* Mobile: vertical stack. Desktop: horizontal row with arrows */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:justify-between lg:gap-2">
            {content.lifecycle.map((step, i) => {
              const Icon = iconForLifecycleLabel(step.label);
              const isLast = i === content.lifecycle.length - 1;
              return (
                <div
                  key={step.label}
                  className="flex flex-1 items-start gap-4 lg:flex-col lg:items-center lg:gap-0"
                >
                  <div className="flex flex-col items-center">
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-[14px] border text-[#0e7490] shadow-[0_8px_20px_rgba(6,182,212,0.10)]"
                      style={{
                        borderColor: "rgba(6,182,212,0.22)",
                        background: "rgba(6,182,212,0.06)",
                      }}
                    >
                      <Icon size={20} strokeWidth={1.8} />
                    </div>
                    <span className="mt-2 text-[0.66rem] font-mono font-semibold tracking-[0.14em] text-[#8e7863]">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>

                  <div className="flex-1 lg:mt-3 lg:px-2 lg:text-center">
                    <div className="text-[0.86rem] font-semibold uppercase tracking-[0.14em] text-[#23373b]">
                      {step.label}
                    </div>
                    <p className="mt-2 text-[0.86rem] leading-[1.6] text-[#55666a] lg:max-w-[180px]">
                      {step.body}
                    </p>
                  </div>

                  {!isLast ? (
                    <>
                      {/* Mobile arrow (vertical, below) */}
                      <div
                        aria-hidden="true"
                        className="absolute hidden h-0 w-0 lg:hidden"
                      />
                      {/* Desktop arrow */}
                      <div
                        aria-hidden="true"
                        className="hidden self-center lg:flex"
                      >
                        <ArrowRight
                          size={18}
                          className="text-[#cbd5e1]"
                          strokeWidth={2}
                        />
                      </div>
                    </>
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
// SECTION 3 — PLATFORM CAPABILITIES (grouped-band matrix)
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
    <section className="bg-[#f4f5f1] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow="What PROOVRA provides"
          title="The full platform behind every evidence record."
          intro="PROOVRA is the same platform on every page — what changes is how each team uses it. The operational capability matrix below applies to every record."
        />

        <div className="mt-12 overflow-hidden rounded-[20px] border border-[rgba(79,112,107,0.22)] bg-white shadow-[0_18px_48px_rgba(8,18,22,0.06)]">
          {groups.map((g, gi) => (
            <div
              key={g.tag}
              className={`grid gap-y-4 px-6 py-6 md:grid-cols-[200px_1fr] md:gap-x-10 md:px-9 md:py-7 ${
                gi !== groups.length - 1
                  ? "border-b border-[rgba(79,112,107,0.14)]"
                  : ""
              }`}
              style={{ background: g.style.band }}
            >
              <div className="flex items-center gap-2.5 md:pt-1">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    background: g.style.dot,
                    boxShadow: `0 0 0 4px ${g.style.dot}22`,
                  }}
                />
                <span
                  className="text-[0.78rem] font-semibold uppercase tracking-[0.2em]"
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
                    <span className="text-[0.96rem] font-semibold tracking-[-0.01em] text-[#23373b]">
                      {cap.name}
                    </span>
                    <span className="text-[0.92rem] leading-[1.7] text-[#55666a]">
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
// SECTION 4 — COMPARISON TABLE
// =========================================================================

function ComparisonSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-[#fbfbf8] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.comparisonEyebrow}
          title={content.comparisonTitle}
          intro={content.comparisonIntro}
        />

        <div className="mt-12 overflow-hidden rounded-[18px] border border-[rgba(79,112,107,0.22)] bg-white shadow-[0_14px_36px_rgba(8,18,22,0.05)]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th className="border-b border-[rgba(79,112,107,0.22)] bg-[rgba(190,116,46,0.06)] px-6 py-4 text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#9c6b25]">
                  Traditional approach
                </th>
                <th className="border-b border-[rgba(79,112,107,0.22)] bg-[rgba(37,99,235,0.04)] px-6 py-4 text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">
                  PROOVRA
                </th>
              </tr>
            </thead>
            <tbody>
              {content.comparisonRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-[rgba(79,112,107,0.14)] last:border-b-0"
                >
                  <td className="bg-[rgba(190,116,46,0.025)] px-6 py-4 align-top text-[0.94rem] leading-[1.7] text-[#7a7066]">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#bc8a4c]"
                      />
                      <span>{row.traditional}</span>
                    </div>
                  </td>
                  <td className="bg-[rgba(37,99,235,0.02)] px-6 py-4 align-top text-[0.96rem] font-medium leading-[1.7] text-[#1a2f47]">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-[#2563eb]"
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
// SECTION 5 — OPERATIONS
// =========================================================================

function OperationsSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-[#f4f5f1] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.operationsEyebrow}
          title={content.operationsTitle}
          intro={content.operationsIntro}
        />

        <ol className="mt-12 grid gap-6 md:grid-cols-2">
          {content.operationsItems.map((it, i) => {
            const Icon = iconForOperationTitle(it.title);
            return (
              <li
                key={i}
                className="flex gap-5 rounded-[18px] border border-[rgba(79,112,107,0.22)] bg-white p-6 shadow-[0_10px_28px_rgba(8,18,22,0.04)] transition-shadow hover:shadow-[0_14px_36px_rgba(8,18,22,0.08)]"
              >
                <div className="flex flex-col items-center gap-2">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-[14px] border text-[#1d4ed8] shadow-[0_8px_20px_rgba(37,99,235,0.10)]"
                    style={{
                      borderColor: "rgba(37,99,235,0.22)",
                      background: "rgba(37,99,235,0.06)",
                    }}
                  >
                    <Icon size={20} strokeWidth={1.8} />
                  </div>
                  <span className="font-mono text-[0.72rem] font-semibold tracking-[0.12em] text-[#8e7863]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <div className="flex-1">
                  <h3 className="text-[1.06rem] font-semibold tracking-[-0.01em] text-[#23373b]">
                    {it.title}
                  </h3>
                  <p className="mt-2 text-[0.96rem] leading-[1.8] text-[#55666a]">
                    {it.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 6 — GOVERNANCE (DARK PREMIUM)
// =========================================================================

function GovernanceSection({ content }: { content: UseCasePageContent }) {
  return (
    <section
      className="relative overflow-hidden py-20 md:py-24"
      style={{
        background:
          "linear-gradient(165deg,#0c1024 0%,#13164a 55%,#1c1850 100%)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(124,58,237,0.20),transparent_48%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_82%,rgba(236,72,153,0.14),transparent_48%)]" />

      <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.governanceEyebrow}
          title={content.governanceTitle}
          intro={content.governanceIntro}
          tone="dark"
        />

        <div className="mt-12 grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
          <dl className="grid gap-x-10 gap-y-7 md:grid-cols-2 lg:grid-cols-1">
            {content.governanceItems.map((it, i) => (
              <div
                key={i}
                className="border-t border-white/12 pt-5"
              >
                <dt className="text-[1.02rem] font-semibold tracking-[-0.01em] text-[#e9eee9]">
                  {it.title}
                </dt>
                <dd className="mt-2 text-[0.95rem] leading-[1.78] text-[#b9c4be]">
                  {it.body}
                </dd>
              </div>
            ))}
          </dl>

          {/* Governance controls mockup — product visibility inside Governance band */}
          <div className="rounded-[22px] border border-white/12 bg-white/[0.04] p-6 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <span className="text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#f9a8d4]">
                Governance controls
              </span>
              <span className="font-mono text-[0.72rem] text-[#a8b6b0]">
                Workspace · matter-014
              </span>
            </div>

            <div className="mt-5 space-y-4">
              <div className="rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[0.86rem] font-medium text-[#e2e9e4]">
                    Retention policy
                  </span>
                  <span className="rounded-full bg-[rgba(236,72,153,0.18)] px-2.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[#f9a8d4]">
                    7 years
                  </span>
                </div>
                <p className="mt-2 text-[0.8rem] text-[#a8b6b0]">
                  Disposition · matter-aligned
                </p>
              </div>

              <div className="rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[0.86rem] font-medium text-[#e2e9e4]">
                    Legal hold
                  </span>
                  <span className="rounded-full bg-[rgba(168,85,247,0.18)] px-2.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[#c4b5fd]">
                    Active
                  </span>
                </div>
                <p className="mt-2 text-[0.8rem] text-[#a8b6b0]">
                  Retention suspended · placed 2026-04-08
                </p>
              </div>

              <div className="rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[0.86rem] font-medium text-[#e2e9e4]">
                    Access roles
                  </span>
                  <span className="text-[0.8rem] text-[#a8b6b0]">5 roles</span>
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
                      className="rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 text-[0.72rem] text-[#dfe7e2]"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[0.86rem] font-medium text-[#e2e9e4]">
                    Audit trail
                  </span>
                  <span className="text-[0.8rem] text-[#a8b6b0]">
                    Last 30 days · 142 events
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-[0.78rem] text-[#a8b6b0]">
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
// SECTION 7 — VERIFICATION SURFACE (signature dark band)
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
          "linear-gradient(160deg,#06222a 0%,#0a2f3a 55%,#063040 100%)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_22%,rgba(158,216,207,0.14),transparent_45%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_78%,rgba(214,184,157,0.10),transparent_45%)]" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 md:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#9dd2ca]">
              The verification surface
            </div>
            <h2 className="mt-4 text-[1.7rem] font-semibold leading-[1.14] tracking-[-0.03em] text-[#edf3f0] md:text-[2.2rem]">
              One reviewer-facing layer for every record.
            </h2>
            <p className="mt-5 text-[1.04rem] leading-[1.78] text-[#c2cdc6]">
              {content.visualCaption}
            </p>

            <div className="relative mt-9 overflow-hidden rounded-[28px] border border-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.40)]">
              <img
                src={content.industryImage}
                alt=""
                className="block h-[300px] w-full object-cover object-center md:h-[380px]"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,26,29,0.0)_50%,rgba(15,26,29,0.62)_100%)]" />
            </div>
          </div>

          <div>
            <div className="rounded-[22px] border border-white/12 bg-white/[0.04] p-6 backdrop-blur-md">
              <div className="flex items-center justify-between">
                <span className="text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9dd2ca]">
                  Evidence record
                </span>
                <span className="font-mono text-[0.74rem] text-[#a8b6b0]">
                  ER-2026-04812
                </span>
              </div>

              <div className="mt-5 grid gap-4">
                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#9dd2ca]" />
                  <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                    Integrity state
                  </span>
                  <span className="ml-auto text-[0.82rem] text-[#a8b6b0]">
                    Match · captured at completion
                  </span>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#9dd2ca]" />
                  <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                    Hash · SHA-256
                  </span>
                  <span className="ml-auto font-mono text-[0.78rem] text-[#a8b6b0]">
                    9e3a…f04b
                  </span>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#d6b89d]" />
                  <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                    Timestamp context
                  </span>
                  <span className="ml-auto text-[0.82rem] text-[#a8b6b0]">
                    RFC 3161 · OpenTimestamps
                  </span>
                </div>

                <div className="border-b border-white/8 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#9dd2ca]" />
                    <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                      Custody history
                    </span>
                    <span className="ml-auto text-[0.82rem] text-[#a8b6b0]">
                      4 events
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1 pl-5 text-[0.8rem] text-[#a8b6b0]">
                    <li>Created · 2026-04-12 09:14</li>
                    <li>Upload completed · 2026-04-12 09:14</li>
                    <li>Report generated · 2026-04-12 09:18</li>
                    <li>Reviewer accessed · 2026-04-12 14:32</li>
                  </ul>
                </div>

                <div className="flex items-center gap-3 border-b border-white/8 pb-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#9dd2ca]" />
                  <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                    Report
                  </span>
                  <span className="ml-auto text-[0.82rem] text-[#a8b6b0]">
                    PDF · ready
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#9dd2ca]" />
                  <span className="text-[0.9rem] font-medium text-[#e2e9e4]">
                    Verification package
                  </span>
                  <span className="ml-auto text-[0.82rem] text-[#a8b6b0]">
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
// SECTION 8 — REPORTING & VERIFICATION (with product output mockups)
// =========================================================================

function ReportingSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-[#fbfbf8] py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.reportingEyebrow}
          title={content.reportingTitle}
          intro={content.reportingIntro}
        />

        {/* Product output mockups: Verification Page, Verification Package, PDF Report */}
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {/* Verification Page mockup */}
          <div className="overflow-hidden rounded-[18px] border border-[rgba(79,112,107,0.22)] bg-white shadow-[0_12px_30px_rgba(8,18,22,0.05)]">
            <div className="border-b border-[rgba(79,112,107,0.14)] bg-[rgba(6,182,212,0.05)] px-5 py-3">
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-[#0e7490]">
                Output · Verification Page
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-[#23373b]">
                  Record
                </span>
                <span className="font-mono text-[0.72rem] text-[#8e8e8e]">
                  ER-04812
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[0.82rem] text-[#55666a]">
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>Integrity</span>
                  <span className="font-medium text-[#0f9b6c]">Match</span>
                </div>
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>Timestamp</span>
                  <span>RFC 3161</span>
                </div>
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>Custody</span>
                  <span>4 events</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Re-check</span>
                  <span className="text-[#1d4ed8]">Available →</span>
                </div>
              </div>
            </div>
          </div>

          {/* Verification Package mockup */}
          <div className="overflow-hidden rounded-[18px] border border-[rgba(79,112,107,0.22)] bg-white shadow-[0_12px_30px_rgba(8,18,22,0.05)]">
            <div className="border-b border-[rgba(79,112,107,0.14)] bg-[rgba(124,58,237,0.05)] px-5 py-3">
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-[#5b21b6]">
                Output · Verification Package
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-[#23373b]">
                  Bundle
                </span>
                <span className="font-mono text-[0.72rem] text-[#8e8e8e]">
                  PKG-1042
                </span>
              </div>
              <div className="mt-4 space-y-2 text-[0.82rem] text-[#55666a]">
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>· Evidence record</span>
                  <span className="text-[#8e8e8e]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>· PDF report</span>
                  <span className="text-[#8e8e8e]">1</span>
                </div>
                <div className="flex items-center justify-between border-b border-[rgba(79,112,107,0.10)] pb-2">
                  <span>· Technical materials</span>
                  <span className="text-[#8e8e8e]">3</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>· Verification page link</span>
                  <span className="text-[#5b21b6]">Shareable</span>
                </div>
              </div>
            </div>
          </div>

          {/* PDF Report mockup */}
          <div className="overflow-hidden rounded-[18px] border border-[rgba(79,112,107,0.22)] bg-white shadow-[0_12px_30px_rgba(8,18,22,0.05)]">
            <div className="border-b border-[rgba(79,112,107,0.14)] bg-[rgba(236,72,153,0.05)] px-5 py-3">
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-[#9d174d]">
                Output · PDF Report
              </div>
            </div>
            <div className="p-5">
              <div className="rounded-[10px] border border-[rgba(79,112,107,0.16)] bg-[#fafaf7] p-4">
                <div className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-[#23373b]">
                  Evidence Record Report
                </div>
                <div className="mt-2 text-[0.7rem] text-[#8e8e8e]">
                  ER-2026-04812 · 7 pages
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1.5 w-[88%] rounded bg-[rgba(79,112,107,0.18)]" />
                  <div className="h-1.5 w-[74%] rounded bg-[rgba(79,112,107,0.16)]" />
                  <div className="h-1.5 w-[82%] rounded bg-[rgba(79,112,107,0.16)]" />
                  <div className="h-1.5 w-[68%] rounded bg-[rgba(79,112,107,0.14)]" />
                  <div className="h-1.5 w-[78%] rounded bg-[rgba(79,112,107,0.14)]" />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-[rgba(79,112,107,0.12)] pt-2 text-[0.7rem] text-[#8e8e8e]">
                  <span>Signed · digital signature</span>
                  <span className="font-mono">9e3a…f04b</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Reporting items list */}
        <ol className="mt-12 space-y-4">
          {content.reportingItems.map((it, i) => (
            <li
              key={i}
              className="flex gap-5 rounded-[16px] border border-[rgba(79,112,107,0.22)] bg-white p-5 shadow-[0_8px_22px_rgba(8,18,22,0.04)]"
            >
              <span className="mt-[2px] flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[rgba(183,157,132,0.42)] bg-[#fcfbf6] text-[0.78rem] font-semibold text-[#8e7863]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="text-[1.04rem] font-semibold tracking-[-0.01em] text-[#23373b]">
                  {it.title}
                </h3>
                <p className="mt-2 text-[0.96rem] leading-[1.78] text-[#55666a]">
                  {it.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 9 — FAQ
// =========================================================================

function FAQSection({ content }: { content: UseCasePageContent }) {
  return (
    <section className="bg-[#f4f5f1] py-20 md:py-24">
      <div className="mx-auto max-w-4xl px-6 md:px-8">
        <SectionHeader
          eyebrow={content.faqEyebrow}
          title={content.faqTitle}
          intro={content.faqIntro}
        />

        <div className="mt-12 space-y-3">
          {content.faqs.map((f, i) => (
            <details
              key={i}
              className="group rounded-[14px] border border-[rgba(79,112,107,0.22)] bg-white open:shadow-[0_10px_28px_rgba(8,18,22,0.05)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[0.98rem] font-semibold text-[#23373b]">
                <span>{f.q}</span>
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[rgba(79,112,107,0.32)] text-[0.9rem] text-[#4f706b] transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <div className="border-t border-[rgba(79,112,107,0.14)] px-5 py-4 text-[0.94rem] leading-[1.78] text-[#55666a]">
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
    <section className="bg-[#f4f5f1] pb-12">
      <div className="mx-auto max-w-3xl px-6 md:px-8">
        <div className="rounded-[16px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.55)] px-5 py-4">
          <div className="text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#8e7863]">
            Important limitation
          </div>
          <p className="mt-2 text-[0.92rem] leading-[1.75] text-[#55666a]">
            {LIMITATION_COPY}
          </p>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 10 — FINAL CTA
// =========================================================================

function FinalCTA({ content }: { content: UseCasePageContent }) {
  return (
    <section className="relative overflow-hidden bg-[#0c1820] py-20 md:py-24">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(124,58,237,0.18),transparent_45%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_78%,rgba(6,182,212,0.14),transparent_45%)]" />

      <div className="relative z-10 mx-auto max-w-4xl px-6 text-center md:px-8">
        <h2 className="text-[1.75rem] font-semibold leading-[1.14] tracking-[-0.03em] text-[#edf1ef] md:text-[2.25rem]">
          {content.ctaTitle}
        </h2>
        <p className="mx-auto mt-5 max-w-[680px] text-[1.02rem] leading-[1.78] text-[#c7cfcc]">
          {content.ctaBody}
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link
            href={SALES_ASSETS.requestDemoUrl}
            className="inline-flex min-h-[52px] items-center justify-center rounded-full border border-white/14 px-8 py-3 text-[15px] font-semibold text-white shadow-[0_18px_36px_rgba(91,33,182,0.32)] transition duration-300 hover:translate-y-[-1px]"
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
            className="inline-flex min-h-[52px] items-center justify-center rounded-full border border-white/22 bg-white/[0.045] px-8 py-3 text-[15px] font-semibold text-[#e9eee9] backdrop-blur-md transition duration-300 hover:translate-y-[-1px] hover:bg-white/[0.08]"
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
    <div className="page landing-page">
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
