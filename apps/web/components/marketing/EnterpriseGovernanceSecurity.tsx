import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CalendarClock,
  Database,
  KeyRound,
  Landmark,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";

type ControlCard = {
  title: string;
  body: string;
  chips: string[];
  Icon: LucideIcon;
  accent: string;
  soft: string;
};

const CONTROL_CARDS: ControlCard[] = [
  {
    title: "Enterprise Identity",
    body: "Secure access for teams with enterprise identity controls.",
    chips: ["SAML SSO", "SCIM", "MFA", "Adaptive Auth"],
    Icon: KeyRound,
    accent: "#2563EB",
    soft: "rgba(37,99,235,0.10)",
  },
  {
    title: "Legal Hold",
    body: "Preserve records when investigations, disputes, or policies require it.",
    chips: ["Hold enforcement", "Matter context", "Export blocking"],
    Icon: Landmark,
    accent: "#7C3AED",
    soft: "rgba(124,58,237,0.10)",
  },
  {
    title: "Retention Policies",
    body: "Automate lifecycle rules across evidence, reports, and governance workflows.",
    chips: ["Policy-based retention", "Lifecycle controls", "Reconciliation"],
    Icon: CalendarClock,
    accent: "#0F766E",
    soft: "rgba(15,118,110,0.10)",
  },
  {
    title: "Complete Audit Trails",
    body: "Track activity across capture, review, verification, reporting, and access.",
    chips: ["Exportable logs", "Reviewer activity", "Governance-ready"],
    Icon: Activity,
    accent: "#0891B2",
    soft: "rgba(8,145,178,0.10)",
  },
  {
    title: "Immutable Storage",
    body: "Protect preserved evidence with object-lock and tamper-evident storage controls.",
    chips: ["Object Lock", "Retention mode", "Integrity checks"],
    Icon: Database,
    accent: "#4F46E5",
    soft: "rgba(79,70,229,0.10)",
  },
  {
    title: "Access Governance",
    body: "Review access, manage sessions, and reduce operational risk across workspaces.",
    chips: ["Access reviews", "Session governance", "Risk controls"],
    Icon: UsersRound,
    accent: "#DB2777",
    soft: "rgba(219,39,119,0.10)",
  },
];

const QUICK_BADGES = [
  "SSO",
  "SCIM",
  "MFA",
  "Legal Hold",
  "Retention",
  "Audit Logs",
  "Object Lock",
  "Access Reviews",
  "Session Governance",
];

export function EnterpriseGovernanceSecurity() {
  return (
    <section
      id="enterprise-governance-security"
      className="relative bg-white"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        paddingTop: 96,
        paddingBottom: 96,
      }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 lg:px-10 2xl:px-12">
        <div
          className="relative overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-[#FAFBFD] px-6 py-12 shadow-[0_24px_60px_rgba(15,23,42,0.05)] md:px-10 md:py-14 lg:px-12 lg:py-16"
        >
          {/* Header */}
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
              Enterprise Control Layer
            </span>
            <h2 className="mt-5 text-[1.85rem] font-bold leading-[1.12] tracking-[-0.02em] text-[#07132B] md:text-[2.2rem]">
              Governance, identity, and auditability built into every evidence
              workflow.
            </h2>
            <p className="mt-5 max-w-[760px] text-[14.5px] leading-[1.7] text-[#475569]">
              PROOVRA gives enterprise teams the controls required to manage
              evidence at scale — from identity and access to retention, legal
              hold, immutable storage, and complete audit visibility.
            </p>
          </div>

          {/* 3 × 2 control card grid */}
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {CONTROL_CARDS.map((c) => {
              const Icon = c.Icon;
              return (
                <div
                  key={c.title}
                  className="relative flex flex-col rounded-[20px] border border-[#E5E7EB] bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(15,23,42,0.06)]"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border bg-white"
                      style={{
                        borderColor: `${c.accent}33`,
                        color: c.accent,
                      }}
                    >
                      <Icon size={17} strokeWidth={1.85} />
                    </span>
                    <h3 className="text-[15px] font-extrabold tracking-[-0.005em] text-[#07132B]">
                      {c.title}
                    </h3>
                  </div>
                  <p className="mt-3 text-[12.5px] leading-[1.6] text-[#475569]">
                    {c.body}
                  </p>
                  <ul className="mt-4 flex flex-wrap gap-1.5 pl-0">
                    {c.chips.map((chip) => (
                      <li key={chip} style={{ listStyle: "none" }}>
                        <span
                          className="inline-flex items-center rounded-full border bg-white px-2.5 py-0.5 text-[10.5px] font-semibold"
                          style={{
                            borderColor: `${c.accent}33`,
                            color: c.accent,
                            background: c.soft,
                          }}
                        >
                          {chip}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-[2px] rounded-b-[20px]"
                    style={{
                      background: `linear-gradient(90deg, ${c.accent} 0%, ${c.accent}66 100%)`,
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Compact "Enterprise-ready controls" badge row */}
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="text-[10.5px] font-extrabold uppercase tracking-[0.18em] text-[#64748B]">
              Enterprise-ready controls
            </div>
            <ul className="mt-4 flex flex-wrap justify-center gap-1.5 pl-0">
              {QUICK_BADGES.map((b) => (
                <li key={b} style={{ listStyle: "none" }}>
                  <span className="inline-flex items-center rounded-full border border-[#E2E8F0] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0F172A]">
                    {b}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* CTA */}
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-5">
            <Link
              href={MARKETING_LINKS.platform.overview}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#07132B] px-5 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(7,19,43,0.20)] transition-all duration-200 hover:-translate-y-0.5"
            >
              Explore platform controls
              <ArrowRight size={14} />
            </Link>
            <Link
              href={MARKETING_LINKS.security}
              className="inline-flex h-11 items-center justify-center gap-1.5 text-[13px] font-semibold text-[#2563EB] transition-colors duration-200 hover:text-[#1D4ED8]"
            >
              View security overview
              <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
