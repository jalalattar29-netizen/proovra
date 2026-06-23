import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  Building2,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  FileCheck2,
  FileSearch,
  FileText,
  Fingerprint,
  Inbox,
  Landmark,
  Layers,
  Link2,
  Minus,
  Package,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { MARKETING_LINKS } from "../../components/marketing/tokens";
import { RevealSection } from "../../components/motion";

export const metadata: Metadata = {
  title: "Why PROOVRA — Move from files to Evidence Records",
  description:
    "Ordinary files lose context as they move through uploads, folders, screenshots, emails, and review workflows. PROOVRA turns sensitive digital material into structured Evidence Records with integrity signals, custody visibility, verification materials, and reviewer-ready outputs.",
};

const WHY_PROOVRA_HERO_IMAGE = "/assets/hero/whyproovra-hero.png";

// ---------------------------------------------------------------------------
// Shared eyebrow / heading primitives
// ---------------------------------------------------------------------------

function Eyebrow({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: "blue" | "violet" | "white" | "slate";
}) {
  const colorMap: Record<string, string> = {
    blue: "#2563EB",
    violet: "#7C3AED",
    slate: "#64748B",
    white: "rgba(255,255,255,0.78)",
  };
  return (
    <div
      className="text-[12px] font-bold uppercase tracking-[0.16em]"
      style={{ color: colorMap[tone] }}
    >
      {children}
    </div>
  );
}

// ===========================================================================
// SECTION DATA
// ===========================================================================

// Section 2 — failure chain
const FAILURE_CHAIN: ReadonlyArray<{ step: string; risk: string; Icon: LucideIcon }> = [
  { step: "Loose file", risk: "No integrity signal", Icon: FileText },
  { step: "Shared folder", risk: "No custody context", Icon: Database },
  { step: "Email thread", risk: "No timing anchor", Icon: Inbox },
  { step: "Screenshot", risk: "No reviewer package", Icon: Camera },
  { step: "Manual notes", risk: "No independent check", Icon: FileSearch },
  { step: "Reviewer uncertainty", risk: "Context reconstructed later", Icon: Search },
];

// Section 3 — Evidence Record anatomy (record-internal layers ONLY —
// reviewer-facing outputs live in the Reviewer Outputs section).
const RECORD_ANATOMY: ReadonlyArray<{
  label: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
}> = [
  { label: "Original content", body: "The captured or uploaded material itself.", Icon: FileText, accent: "#2563EB" },
  { label: "SHA-256 fingerprint", body: "Cryptographic hash of the recorded content.", Icon: Fingerprint, accent: "#7C3AED" },
  { label: "Structured metadata", body: "Capture context, source, identifiers, file information, and operational fields where available.", Icon: Layers, accent: "#0F766E" },
  { label: "Custody events", body: "Hash-chained record of platform actions on this material.", Icon: Workflow, accent: "#B45309" },
  { label: "Signature context", body: "Signing-key reference and signature material where signing is configured.", Icon: ShieldCheck, accent: "#DB2777" },
  { label: "Timestamp context", body: "RFC 3161 or OpenTimestamps anchoring context where enabled and successfully completed.", Icon: Clock3, accent: "#0891B2" },
  { label: "Governance context", body: "Workspace, case, retention, legal hold, and access-control context where configured.", Icon: Landmark, accent: "#6366F1" },
  { label: "Verification state", body: "Recorded status for hash match, timestamp, signature, custody, and anchoring checks where available.", Icon: FileCheck2, accent: "#2563EB" },
  { label: "Audit context", body: "Recorded access, generation, review, export, and operational activity linked to the evidence workflow.", Icon: Eye, accent: "#7C3AED" },
];

// Section 5 — Capability bands
const CAPABILITY_BANDS: ReadonlyArray<{
  number: string;
  title: string;
  body: string;
  accent: string;
  accentSoft: string;
  Icon: LucideIcon;
}> = [
  {
    number: "01",
    title: "Capture & Intake",
    body: "Upload, capture, intake links, external submissions, and structured evidence creation that brings material into the platform under controlled flows.",
    accent: "#2563EB",
    accentSoft: "#EFF6FF",
    Icon: Inbox,
  },
  {
    number: "02",
    title: "Integrity Layer",
    body: "SHA-256 hashing, structured fingerprints, signature context, and timestamp or anchoring context (RFC 3161 / OpenTimestamps) where enabled.",
    accent: "#7C3AED",
    accentSoft: "#F5F3FF",
    Icon: Fingerprint,
  },
  {
    number: "03",
    title: "Custody Layer",
    body: "Hash-chained custody events and platform-recorded activity history attached to every record so handling context is captured as part of the workflow.",
    accent: "#0F766E",
    accentSoft: "#ECFDF5",
    Icon: Workflow,
  },
  {
    number: "04",
    title: "Governance Layer",
    body: "Workspaces, roles, cases, retention concepts, legal hold concepts, access boundaries, and audit logs aligned to the evidence lifecycle.",
    accent: "#B45309",
    accentSoft: "#FFFBEB",
    Icon: Landmark,
  },
  {
    number: "05",
    title: "Review Layer",
    body: "Verification pages, reports, packages, reviewer access, and explanation-ready outputs designed for counsel, experts, auditors, and external recipients.",
    accent: "#DB2777",
    accentSoft: "#FDF2F8",
    Icon: Eye,
  },
  {
    number: "06",
    title: "AI Assistance",
    body: "Advisory metadata-first assistance for organisation and review preparation where enabled. AI does not determine truth, authorship, identity, liability, or admissibility.",
    accent: "#6366F1",
    accentSoft: "#EEF2FF",
    Icon: Sparkles,
  },
];

// Section 6 — Comparison rows
const COMPARISON_ROWS: ReadonlyArray<{
  feature: string;
  left: boolean | string;
  right: boolean | string;
}> = [
  { feature: "Independent integrity check", left: false, right: true },
  { feature: "Captured time context", left: false, right: "Where anchoring is enabled" },
  { feature: "Linked custody history", left: false, right: true },
  { feature: "Reviewer-ready PDF report", left: false, right: true },
  { feature: "Verification package", left: false, right: true },
  { feature: "Public verification URL", left: false, right: "Where supported" },
  { feature: "Offline or external reviewer inspection", left: false, right: true },
  { feature: "Governance and retention context", left: false, right: true },
  { feature: "AI advisory support", left: false, right: "Where enabled" },
  { feature: "Clear limitation language", left: false, right: true },
];

// Section 7 — Reviewer deliverables pipeline (outputs that LEAVE the
// record and reach a reviewer — distinct from Evidence Record anatomy).
const DELIVERABLES: ReadonlyArray<{
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
}> = [
  {
    title: "Evidence Record summary",
    body: "A structured summary of the record identity, hash, metadata, custody status, and verification state.",
    Icon: FileCheck2,
    accent: "#2563EB",
  },
  {
    title: "Verification Report",
    body: "A human-readable report summarising hashes, custody, signatures, timestamp context, governance context, and verification status where available.",
    Icon: FileText,
    accent: "#7C3AED",
  },
  {
    title: "Verification Package",
    body: "A portable bundle containing report materials, manifest, hashes, signatures, custody references, and technical verification materials for reviewer inspection.",
    Icon: Package,
    accent: "#0F766E",
  },
  {
    title: "Public Verification URL",
    body: "A controlled reviewer-facing surface where selected verification information can be inspected, subject to access controls, token configuration, redaction, expiry, and customer settings.",
    Icon: Link2,
    accent: "#DB2777",
  },
  {
    title: "External Review",
    body: "Counsel, experts, auditors, insurers, journalists, or external recipients apply their own legal, factual, expert, or procedural judgment.",
    Icon: Users,
    accent: "#B45309",
  },
];

// Section 8 — Who uses PROOVRA (six enterprise use-case panels with
// BOTH operational value AND platform capabilities per panel).
const SCENARIOS: ReadonlyArray<{
  tag: string;
  title: string;
  body: string;
  operational: string;
  platform: string;
  Icon: LucideIcon;
  accent: string;
  accentSoft: string;
}> = [
  {
    tag: "Legal",
    title: "Legal Operations",
    body: "Legal teams use PROOVRA to organise matter evidence, prepare reviewer-ready materials, and reduce the need to reconstruct custody from emails, folders, and manual notes.",
    operational:
      "Supports matter review, client evidence intake, expert handoff, disclosure preparation, and dispute-sensitive documentation.",
    platform:
      "Cases & Matters, Evidence Records, Verification Reports, Verification Packages, Public Verification URLs, audit history, role-aware access, and legal hold concepts.",
    Icon: Scale,
    accent: "#2563EB",
    accentSoft: "#EFF6FF",
  },
  {
    tag: "Investigations",
    title: "Investigations",
    body: "Investigation teams use PROOVRA to coordinate collection, review, escalation, and reporting around sensitive incidents, complaints, internal reviews, or field submissions.",
    operational:
      "Helps teams keep evidence, reviewers, notes, custody context, and report outputs connected during fast-moving investigation workflows.",
    platform:
      "Workspaces, secure intake, evidence capture, custody events, reviewer assignments, audit logs, reports, packages, governance controls, and AI-assisted review preparation where enabled.",
    Icon: Search,
    accent: "#7C3AED",
    accentSoft: "#F5F3FF",
  },
  {
    tag: "Insurance",
    title: "Insurance & Claims",
    body: "Claims teams use PROOVRA to organise photos, videos, documents, audio, incident records, damage evidence, and external submissions into structured evidence workflows.",
    operational:
      "Supports FNOL documentation, damage review, fraud escalation, subrogation preparation, expert review, and handoff to external reviewers.",
    platform:
      "Intake links, Evidence Records, metadata capture, hash verification, reports, Verification Packages, reviewer outputs, case organisation, and audit visibility.",
    Icon: Briefcase,
    accent: "#0F766E",
    accentSoft: "#ECFDF5",
  },
  {
    tag: "Compliance",
    title: "Compliance & Audit",
    body: "Compliance and audit teams use PROOVRA to preserve sensitive records with governance context, reviewable activity history, and structured outputs for internal or external audit.",
    operational:
      "Supports policy reviews, regulatory preparation, internal controls, incident documentation, and audit-ready evidence handoffs.",
    platform:
      "Workspaces, cases, audit logs, retention concepts, access controls, governance layer, Verification Reports, Evidence Records, and Trust Center documentation.",
    Icon: Landmark,
    accent: "#B45309",
    accentSoft: "#FFFBEB",
  },
  {
    tag: "Security & Risk",
    title: "Enterprise Security & Risk",
    body: "Security and risk teams use PROOVRA to preserve digital material during incidents, escalations, internal reviews, vendor issues, or operational risk investigations.",
    operational:
      "Supports incident evidence preservation, escalation documentation, reviewer coordination, evidence health visibility, and controlled external sharing.",
    platform:
      "Evidence capture, custody events, audit logs, workspace controls, reviewer workflows, verification status, report generation, legal hold concepts, and security documentation.",
    Icon: ShieldCheck,
    accent: "#DB2777",
    accentSoft: "#FDF2F8",
  },
  {
    tag: "Public Sector",
    title: "Public Sector & Oversight",
    body: "Public-sector, oversight, and accountability workflows use PROOVRA to preserve records with documented handling context, governance visibility, and reviewer-facing materials.",
    operational:
      "Supports citizen complaints, public records, regulatory oversight, investigation support, disclosure preparation, and accountable evidence handling.",
    platform:
      "Evidence Records, retention concepts, access controls, custody history, Verification Reports, Verification Packages, Public Verification URLs, audit logs, and governance records.",
    Icon: Building2,
    accent: "#6366F1",
    accentSoft: "#EEF2FF",
  },
];

// Section 9 — Boundaries
const BOUNDARIES: ReadonlyArray<string> = [
  "PROOVRA does not determine factual truth.",
  "PROOVRA does not determine authorship, identity, intent, or liability.",
  "PROOVRA does not guarantee legal admissibility, evidentiary weight, or court acceptance.",
  "PROOVRA does not certify that a real-world event happened.",
  "AI assistance is advisory only and does not make legal or factual determinations.",
  "Customers remain responsible for lawful capture, consent, permissions, retention, sharing, and use.",
];

// ===========================================================================
// PAGE
// ===========================================================================

export default function WhyProovraPage() {
  return (
    <MarketingPage>
      {/* ───────────────── Section 1 — HERO (image + layout untouched) ───────────────── */}
      <section className="relative min-h-[720px] overflow-hidden bg-white">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: `url("${WHY_PROOVRA_HERO_IMAGE}")`,
            backgroundSize: "100% 100%",
            backgroundPosition: "center center",
            backgroundRepeat: "no-repeat",
          }}
        />

        <div className="relative z-10 mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
          <div className="max-w-[640px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
              Why PROOVRA
            </span>

            <h1 className="mt-4 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
              Move from files to{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)",
                }}
              >
                Evidence Records.
              </span>
            </h1>

            <p className="mt-4 max-w-[580px] text-[15px] leading-[1.65] text-[#475569]">
              Ordinary files lose context as they move through uploads, folders,
              screenshots, emails, and review workflows. PROOVRA turns
              sensitive digital material into structured Evidence Records with
              integrity signals, custody visibility, verification materials,
              and reviewer-ready outputs.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href={MARKETING_LINKS.requestDemo}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition hover:-translate-y-0.5"
              >
                Request a demo
              </Link>
              <Link
                href={MARKETING_LINKS.verifyDemo}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-[#E5E7EB] bg-white px-5 text-[13.5px] font-semibold text-[#0F172A] transition hover:-translate-y-0.5 hover:border-[#CBD5E1]"
              >
                Try live verification
              </Link>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {["Integrity signals", "Custody visibility", "Reviewer-ready outputs"].map(
                (chip) => (
                  <span
                    key={chip}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white/85 px-3 py-1 text-[12px] font-medium text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="block h-1.5 w-1.5 rounded-full bg-[#2563EB]"
                    />
                    {chip}
                  </span>
                )
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── NEW Section 1A — WHY ORGANIZATIONS CHOOSE PROOVRA ─────────────────
          Six enterprise capability panels that communicate the operational
          platform value (workspaces, cases, teams, governance, reviewer
          workflows, verification) immediately after the hero — before the
          page descends into the problem / Evidence Record narrative.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section style={{ background: "#F8FAFC" }}>
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
            <div className="mx-auto max-w-[900px] text-center">
              <Eyebrow tone="blue">Why organizations choose PROOVRA</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Evidence operations need more than secure files.
              </h2>
              <p className="mx-auto mt-5 max-w-[820px] text-[15.5px] leading-[1.78] text-[#475569]">
                Organisations do not choose PROOVRA only because records can be
                hashed, timestamped, or verified. They choose it because
                evidence work becomes operational: teams can collect material,
                organise it into cases, control access, assign review work,
                generate reports, create verification packages, preserve
                custody history, and govern sensitive records from one
                connected workspace.
              </p>
              <p className="mx-auto mt-4 max-w-[820px] text-[15px] leading-[1.78] text-[#475569]">
                Whether the workflow belongs to a solo legal professional, a
                claims team, an internal investigation group, a compliance
                function, or a global enterprise, PROOVRA gives evidence a
                working structure instead of leaving it scattered across
                inboxes, folders, spreadsheets, screenshots, and disconnected
                systems.
              </p>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  {
                    title: "Evidence Operations",
                    body: "Move evidence from disconnected files into structured operational workflows. PROOVRA connects capture, intake, records, reports, verification, packages, review activity, and governance around the same evidence context.",
                    Icon: Workflow,
                    accent: "#2563EB",
                    accentSoft: "#EFF6FF",
                  },
                  {
                    title: "Cases & Matters",
                    body: "Organise evidence, reviewers, reports, notes, packages, and activity around real claims, incidents, investigations, disputes, compliance reviews, and legal matters — instead of managing records as loose files.",
                    Icon: Briefcase,
                    accent: "#7C3AED",
                    accentSoft: "#F5F3FF",
                  },
                  {
                    title: "Workspace Collaboration",
                    body: "Support collaboration across legal, compliance, investigations, claims, review, and administrative teams with role-aware workspaces, responsibilities, reviewer access, and operational separation between teams or matters.",
                    Icon: Users,
                    accent: "#0F766E",
                    accentSoft: "#ECFDF5",
                  },
                  {
                    title: "Governance",
                    body: "Apply retention concepts, legal hold concepts, access boundaries, workspace controls, audit visibility, and lifecycle oversight around sensitive records so evidence handling becomes repeatable and reviewable.",
                    Icon: Landmark,
                    accent: "#B45309",
                    accentSoft: "#FFFBEB",
                  },
                  {
                    title: "Reviewer Workflows",
                    body: "Prepare evidence for internal review, expert review, disclosure, challenge, escalation, audit, and external inspection using structured reports, verification pages, verification packages, and reviewer-ready outputs.",
                    Icon: Eye,
                    accent: "#DB2777",
                    accentSoft: "#FDF2F8",
                  },
                  {
                    title: "Verification",
                    body: "Provide independently reviewable integrity materials instead of unsupported claims. Reviewers can inspect recorded fingerprints, custody context, timestamp or anchoring state where enabled, signatures, reports, and package materials.",
                    Icon: ShieldCheck,
                    accent: "#6366F1",
                    accentSoft: "#EEF2FF",
                  },
                ] as const
              ).map(({ title, body, Icon, accent, accentSoft }) => (
                <div
                  key={title}
                  className="relative flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
                  style={{ borderColor: "#E2E8F0" }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-7 h-8 w-[3px] rounded-r"
                    style={{ background: accent }}
                  />
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                    style={{ background: accentSoft, color: accent }}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                  </span>
                  <h3 className="mt-4 text-[1.05rem] font-semibold tracking-[-0.01em] text-[#081426]">
                    {title}
                  </h3>
                  <p className="mt-2 flex-1 text-[14px] leading-[1.68] text-[#475569]">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── NEW Section 1B — ONE PLATFORM INSTEAD OF MANY TOOLS ─────────────────
          Before / after enterprise transformation: scattered tools on the
          left (warm muted tint), PROOVRA platform on the right (blue/violet
          tint), with a dark-navy bridge between them and a full-width
          outcome row beneath.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
            <div className="mx-auto max-w-[900px] text-center">
              <Eyebrow tone="violet">One platform instead of many tools</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Replace scattered evidence work with one connected platform.
              </h2>
              <p className="mx-auto mt-5 max-w-[820px] text-[15.5px] leading-[1.78] text-[#475569]">
                Evidence work often spreads across too many tools: capture
                apps, shared folders, email threads, spreadsheets, PDF
                exports, case notes, review checklists, audit logs,
                access-control systems, and reporting templates. Each tool
                may solve a small part of the workflow, but the evidence
                context becomes fragmented.
              </p>
              <p className="mx-auto mt-4 max-w-[820px] text-[15px] leading-[1.78] text-[#475569]">
                PROOVRA brings those functions into one evidence operations
                platform. Capture, storage, verification, reporting, case
                organisation, reviewer workflows, governance, auditability,
                and external verification are connected through the same
                Evidence Record, custody context, and workspace controls.
              </p>
            </div>

            {/* Transformation model — left scattered, center bridge, right PROOVRA */}
            <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-8">
              {/* LEFT — Scattered tools (warm muted tint) */}
              <div
                className="relative overflow-hidden rounded-[20px] border p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                style={{
                  borderColor: "#FED7AA",
                  background: "#FFF7ED",
                }}
              >
                <div className="text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#9A3412]">
                  Scattered tools
                </div>
                <h3 className="mt-2 text-[1.15rem] font-semibold tracking-[-0.01em] text-[#7C2D12]">
                  Fragmented evidence handling
                </h3>
                <ul className="mt-5 grid gap-2.5">
                  {[
                    "Capture tools",
                    "Shared drives",
                    "Email threads",
                    "Spreadsheets",
                    "Manual custody notes",
                    "Separate report templates",
                    "Disconnected case folders",
                    "External reviewer handoffs",
                    "Separate audit records",
                  ].map((it) => (
                    <li
                      key={it}
                      className="flex items-start gap-2.5 text-[13.5px] leading-[1.6] text-[#7C2D12]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[0.55em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                        style={{ background: "#FED7AA", color: "#B45309" }}
                      >
                        <Minus size={11} strokeWidth={2.4} />
                      </span>
                      {it}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 border-t border-[#FED7AA] pt-4 text-[12.5px] leading-[1.6] text-[#9A3412]">
                  Each tool may hold part of the workflow, but the context
                  around the evidence is easy to lose.
                </p>
              </div>

              {/* CENTER — Bridge */}
              <div className="relative flex items-center justify-center lg:w-[160px]">
                {/* Mobile bridge */}
                <div className="flex flex-col items-center gap-3 py-2 lg:hidden">
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#64748B]">
                    From fragmented
                  </span>
                  <ArrowRight size={22} className="text-[#7C3AED]" aria-hidden="true" />
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#64748B]">
                    To connected
                  </span>
                </div>

                {/* Desktop bridge — vertical pill */}
                <div className="hidden h-full w-full flex-col items-center justify-center lg:flex">
                  <div
                    className="rounded-[20px] border p-5 text-center text-white shadow-[0_18px_42px_rgba(7,27,77,0.18)]"
                    style={{
                      background:
                        "linear-gradient(180deg, #071B4D 0%, #2D1A6B 100%)",
                      borderColor: "rgba(255,255,255,0.10)",
                    }}
                  >
                    <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-white/70">
                      From → To
                    </div>
                    <div className="mt-3 text-[12px] font-semibold leading-[1.45] text-white">
                      Fragmented evidence handling
                    </div>
                    <ArrowRight
                      size={20}
                      aria-hidden="true"
                      className="mx-auto my-3 rotate-90 text-[#A78BFA]"
                    />
                    <div className="text-[12px] font-semibold leading-[1.45] text-white">
                      Connected evidence operations
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT — PROOVRA Evidence Operations Platform (blue/violet tint) */}
              <div
                className="relative overflow-hidden rounded-[20px] border p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                style={{
                  borderColor: "#DDD6FE",
                  background:
                    "linear-gradient(180deg, #EFF6FF 0%, #EDE9FE 100%)",
                }}
              >
                <div className="text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#5B21B6]">
                  PROOVRA Evidence Operations Platform
                </div>
                <h3 className="mt-2 text-[1.15rem] font-semibold tracking-[-0.01em] text-[#1E1B4B]">
                  Connected evidence operations
                </h3>
                <ul className="mt-5 grid gap-2.5">
                  {[
                    { label: "Capture & intake", Icon: Inbox },
                    { label: "Evidence storage", Icon: Database },
                    { label: "Evidence Records", Icon: FileCheck2 },
                    { label: "Cases & Matters", Icon: Briefcase },
                    { label: "Reviewer Operations", Icon: Eye },
                    { label: "Verification Reports", Icon: FileText },
                    { label: "Verification Packages", Icon: Package },
                    { label: "Governance controls", Icon: Landmark },
                    { label: "Legal hold & retention", Icon: ShieldCheck },
                    { label: "Audit logs", Icon: Layers },
                    { label: "AI assistance", Icon: Sparkles },
                    { label: "External review surfaces", Icon: Link2 },
                  ].map(({ label, Icon }) => (
                    <li
                      key={label}
                      className="flex items-start gap-2.5 text-[13.5px] leading-[1.6] text-[#1E1B4B]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[0.45em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: "rgba(124,58,237,0.16)",
                          color: "#6D28D9",
                        }}
                      >
                        <Icon size={11} strokeWidth={2} />
                      </span>
                      {label}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 border-t border-[#DDD6FE] pt-4 text-[12.5px] leading-[1.6] text-[#5B21B6]">
                  PROOVRA connects the workflow through one record, one
                  custody context, and one governance layer.
                </p>
              </div>
            </div>

            {/* Outcome row */}
            <div
              className="mt-8 rounded-[20px] border bg-white px-6 py-5 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:px-7"
              style={{ borderColor: "#E2E8F0" }}
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[180px_1fr] lg:items-center lg:gap-8">
                <div>
                  <Eyebrow tone="blue">Outcomes</Eyebrow>
                  <div className="mt-1 text-[14px] font-semibold text-[#081426]">
                    What teams gain in practice.
                  </div>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {[
                    "Less reconstruction work",
                    "Better reviewer readiness",
                    "Stronger governance visibility",
                    "More consistent evidence handling",
                    "Clearer handoffs to external reviewers",
                  ].map((out) => (
                    <li key={out}>
                      <span
                        className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#0F172A]"
                        style={{ borderColor: "#DDE6F2" }}
                      >
                        <CheckCircle2
                          size={13}
                          strokeWidth={2.2}
                          className="text-[#10B981]"
                          aria-hidden="true"
                        />
                        {out}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 2 — THE PROBLEM WITH ORDINARY FILES ─────────────────
          ENTIRE section now sits inside one unified premium icon-card card —
          heading, paragraphs, failure chain, and the closing sentence all
          share the same backdrop. ─────────────────────────────────────── */}
      <RevealSection direction="up">
        <section style={{ background: "#F8FAFC" }}>
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            {/* Single unified background card — wraps all of "The problem". */}
            <div
              className="relative overflow-hidden rounded-[32px] border p-8 shadow-[0_24px_60px_rgba(7,27,77,0.22)] md:p-12 lg:p-14"
              style={{
                borderColor: "rgba(255,255,255,0.10)",
                backgroundImage: "url('/assets/cards/icon-card.png')",
                backgroundSize: "cover",
                backgroundPosition: "center center",
                backgroundRepeat: "no-repeat",
                backgroundColor: "#050F33",
              }}
            >
              {/* Readability scrim — keeps heading, paragraphs, chain, and
                  closing line legible without flattening the icon-card art. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(5,15,51,0.50) 0%, rgba(5,15,51,0.64) 100%)",
                }}
              />

              <div className="relative">
                <div className="grid items-start gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16">
                  {/* LEFT — heading + paragraphs */}
                  <div className="lg:sticky lg:top-24">
                    <Eyebrow tone="white">The problem</Eyebrow>
                    <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.3rem]">
                      Files survive. The review context often does not.
                    </h2>
                    <p className="mt-5 text-[15.5px] leading-[1.78] text-[#E2E8F0]">
                      Most organisations already collect digital material. The
                      problem is what happens after capture. Files are renamed,
                      exported, emailed, screenshotted, uploaded into folders,
                      copied into case systems, and shared with reviewers. The file
                      may remain available, but the surrounding context needed to
                      understand and verify it often becomes fragmented.
                    </p>
                    <p className="mt-5 text-[15.5px] leading-[1.78] text-[#E2E8F0]">
                      When evidence is challenged later, teams are forced to
                      reconstruct handling history from emails, chat threads,
                      shared drives, memory, and screenshots. That creates
                      unnecessary friction for legal teams, investigators,
                      compliance reviewers, insurers, journalists, auditors, and
                      external reviewers.
                    </p>
                  </div>

                  {/* RIGHT — Failure chain (no own backdrop — sits on the
                      unified card surface; only the inner step tiles are
                      translucent glass). */}
                  <div>
                    <div className="flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#FCD34D]">
                      <AlertTriangle size={14} aria-hidden="true" />
                      Failure chain
                    </div>

                    <ol className="relative mt-6">
                      <span
                        aria-hidden="true"
                        className="absolute left-[19px] top-3 bottom-3 w-px"
                        style={{
                          background:
                            "linear-gradient(180deg, rgba(252,211,77,0.30) 0%, rgba(252,211,77,0.55) 50%, rgba(252,211,77,0.30) 100%)",
                        }}
                      />
                      <div className="space-y-4">
                        {FAILURE_CHAIN.map(({ step, risk, Icon }) => (
                          <li
                            key={step}
                            className="relative grid grid-cols-[40px_1fr] items-stretch gap-x-5"
                          >
                            <span
                              aria-hidden="true"
                              className="relative z-10 mt-1 flex h-10 w-10 items-center justify-center rounded-full border backdrop-blur-[2px]"
                              style={{
                                borderColor: "rgba(252,211,77,0.40)",
                                color: "#FCD34D",
                                background: "rgba(15,23,42,0.45)",
                              }}
                            >
                              <Icon size={16} strokeWidth={1.9} />
                            </span>
                            <div
                              className="rounded-[14px] border px-4 py-3 backdrop-blur-[12px]"
                              style={{
                                borderColor: "rgba(255,255,255,0.14)",
                                background: "rgba(15,23,42,0.45)",
                              }}
                            >
                              <div className="text-[15px] font-semibold text-white">
                                {step}
                              </div>
                              <div className="mt-1 flex items-center gap-2 text-[12.5px] text-[#FCD34D]">
                                <Minus size={12} strokeWidth={2.4} aria-hidden="true" />
                                {risk}
                              </div>
                            </div>
                          </li>
                        ))}
                      </div>
                    </ol>
                  </div>
                </div>

                {/* Closing sentence — spans the full unified card under both columns. */}
                <p className="mt-10 max-w-[820px] text-[13.5px] leading-[1.7] text-[#E2E8F0] md:text-[14px]">
                  By the time the file reaches the reviewer, the context needed
                  to inspect it has often been left behind.
                </p>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 3 — THE SHIFT TO EVIDENCE RECORDS ───────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mx-auto max-w-[860px] text-center">
              <Eyebrow tone="blue">The shift</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Evidence Records carry context with the content.
              </h2>
              <p className="mt-5 text-[15.5px] leading-[1.78] text-[#475569]">
                PROOVRA changes the unit of work from an ordinary file to an
                Evidence Record. An Evidence Record can carry the uploaded or
                captured material together with recorded metadata, cryptographic
                fingerprints, custody events, signature context, timestamp or
                anchoring context where enabled, reports, verification pages,
                and package materials.
              </p>
              <p className="mt-4 text-[15px] leading-[1.78] text-[#475569]">
                The goal is not to claim that PROOVRA knows what happened in
                the real world. The goal is to preserve the recorded technical
                and operational context so reviewers can inspect what the
                platform recorded — and understand the boundaries of that
                record.
              </p>
            </div>

            {/* Evidence Record Anatomy — architecture diagram */}
            <div className="relative mt-14">
              <div
                className="relative overflow-hidden rounded-[28px] border bg-white p-7 shadow-[0_24px_60px_rgba(15,23,42,0.06)] md:p-10"
                style={{ borderColor: "#E2E8F0" }}
              >
                {/* Soft architectural backdrop */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(circle at 50% 50%, rgba(37,99,235,0.06) 0%, rgba(37,99,235,0.00) 60%), radial-gradient(circle at 80% 20%, rgba(124,58,237,0.05) 0%, transparent 50%)",
                  }}
                />

                <div className="relative grid gap-8 lg:grid-cols-[300px_1fr] lg:gap-12">
                  {/* Center anchor — Evidence Record */}
                  <div className="flex items-center lg:items-start">
                    <div
                      className="relative w-full overflow-hidden rounded-[24px] p-7 text-white shadow-[0_18px_42px_rgba(7,27,77,0.18)] md:p-8"
                      style={{
                        background:
                          "linear-gradient(135deg, #071B4D 0%, #2D1A6B 100%)",
                      }}
                    >
                      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/70">
                        Center of the model
                      </div>
                      <div className="mt-3 text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.01em]">
                        Evidence Record
                      </div>
                      <p className="mt-3 text-[13.5px] leading-[1.65] text-white/85">
                        The structured platform record that travels with the
                        submitted material and carries the recorded technical
                        and operational context around it.
                      </p>
                      <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/75">
                        <Layers size={12} aria-hidden="true" />
                        9 attached layers
                      </div>
                    </div>
                  </div>

                  {/* Anatomy grid */}
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {RECORD_ANATOMY.map(({ label, body, Icon, accent }) => (
                      <div
                        key={label}
                        className="rounded-[16px] border bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
                        style={{ borderColor: "#E2E8F0" }}
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-9 w-9 items-center justify-center rounded-[10px]"
                          style={{
                            background: `${accent}14`,
                            color: accent,
                          }}
                        >
                          <Icon size={16} strokeWidth={1.9} />
                        </span>
                        <div className="mt-3 text-[13.5px] font-semibold text-[#081426]">
                          {label}
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#64748B]">
                          {body}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* Section 4 — PROOVRA OPERATING MODEL: removed per spec. The new
          §1A (Why organizations choose PROOVRA) and §1B (One platform
          instead of many tools) now carry platform-positioning. The single
          load-bearing sentence ("PROOVRA sits between evidence sources,
          review teams, governance requirements, and external handoffs so
          evidence work remains connected from capture to review.") has
          been moved into the §5 Platform capabilities intro below. */}

      {/* ───────────────── Section 5 — CAPABILITY ARCHITECTURE ───────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mx-auto max-w-[860px] text-center">
              <Eyebrow tone="blue">Platform capabilities</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                What PROOVRA adds to evidence workflows.
              </h2>
              <p className="mt-5 text-[15.5px] leading-[1.78] text-[#475569]">
                PROOVRA sits between evidence sources, review teams,
                governance requirements, and external handoffs so evidence
                work remains connected from capture to review. The platform
                combines integrity controls, custody visibility, governance
                context, and reviewer outputs into one evidence operations
                layer.
              </p>
            </div>

            <div className="relative mt-12">
              {/* Vertical architecture rail */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-[19px] top-6 bottom-6 hidden w-px md:block"
                style={{ background: "#E2E8F0" }}
              />

              <div className="space-y-4">
                {CAPABILITY_BANDS.map(({ number, title, body, accent, accentSoft, Icon }) => (
                  <div
                    key={number}
                    className="relative overflow-hidden rounded-[18px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                    style={{ borderColor: "#E2E8F0" }}
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-[3px]"
                      style={{ background: accent }}
                    />
                    <div
                      className="grid gap-y-5 px-6 py-7 md:grid-cols-[220px_1fr] md:gap-x-10 md:px-9 md:py-8"
                      style={{
                        background: `linear-gradient(90deg, ${accent}08 0%, ${accent}03 22%, transparent 38%)`,
                      }}
                    >
                      <div className="flex items-start gap-3.5">
                        <span
                          aria-hidden="true"
                          className="relative z-10 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full"
                          style={{
                            background: accentSoft,
                            color: accent,
                            border: `1px solid ${accent}33`,
                          }}
                        >
                          <Icon size={17} strokeWidth={1.9} />
                        </span>
                        <div className="md:pt-1">
                          <div
                            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                            style={{ color: accent }}
                          >
                            Layer {number}
                          </div>
                          <h3 className="mt-1 text-[1.05rem] font-semibold tracking-[-0.01em] text-[#081426]">
                            {title}
                          </h3>
                        </div>
                      </div>

                      <p className="text-[14.5px] leading-[1.75] text-[#475569]">
                        {body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 6 — SIDE-BY-SIDE COMPARISON ───────────────── */}
      <RevealSection direction="up">
        <section style={{ background: "#F8FAFC" }}>
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mx-auto max-w-[860px] text-center">
              <Eyebrow tone="violet">Side by side</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Ordinary files vs PROOVRA Evidence Records.
              </h2>
            </div>

            <div
              className="mt-12 overflow-x-auto rounded-[24px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{ borderColor: "#E2E8F0" }}
            >
              <table className="min-w-[760px] w-full border-collapse text-left">
                <thead style={{ background: "#F8FAFC" }}>
                  <tr>
                    <th className="px-6 py-4 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                      Capability
                    </th>
                    <th className="px-6 py-4 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#9A3412]">
                      Ordinary files
                    </th>
                    <th className="px-6 py-4 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#1D4ED8]">
                      PROOVRA Evidence Records
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON_ROWS.map((row, idx) => (
                    <tr
                      key={row.feature}
                      style={{
                        borderTop: idx === 0 ? "none" : "1px solid #F1F5F9",
                      }}
                    >
                      <td className="px-6 py-4 align-middle text-[14px] font-semibold text-[#081426]">
                        {row.feature}
                      </td>
                      <td className="px-6 py-4 align-middle">
                        <span className="inline-flex items-center gap-2 text-[13.5px] text-[#9A3412]">
                          <span
                            aria-hidden="true"
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                            style={{ background: "#FEF3C7", color: "#B45309" }}
                          >
                            <Minus size={12} strokeWidth={2.4} />
                          </span>
                          {typeof row.left === "string" ? row.left : "Not built in"}
                        </span>
                      </td>
                      <td className="px-6 py-4 align-middle">
                        <span className="inline-flex items-center gap-2 text-[13.5px] text-[#065F46]">
                          <span
                            aria-hidden="true"
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                            style={{ background: "#D1FAE5", color: "#10B981" }}
                          >
                            <CheckCircle2 size={12} strokeWidth={2.4} />
                          </span>
                          {typeof row.right === "string" ? row.right : "Built in"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mx-auto mt-6 max-w-[820px] text-center text-[13px] leading-[1.65] text-[#64748B]">
              "Where enabled" / "where supported" reflect features that depend
              on platform configuration or plan. See the Verification
              Methodology for the full scope.
            </p>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 7 — REVIEWER DELIVERABLES ───────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mb-12 max-w-[860px]">
              <Eyebrow tone="blue">Reviewer outputs</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                What reviewers actually receive.
              </h2>
              <p className="mt-5 text-[15.5px] leading-[1.78] text-[#475569]">
                PROOVRA is designed so reviewers do not receive only a file or
                a screenshot. Depending on the workflow, they may receive
                structured outputs generated from the Evidence Record that
                explain the recorded integrity state, custody context,
                governance context, and verification boundaries.
              </p>
            </div>

            <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
              {/* Pipeline */}
              <ol className="relative">
                <span
                  aria-hidden="true"
                  className="absolute left-[19px] top-4 bottom-4 w-px"
                  style={{ background: "#E2E8F0" }}
                />
                <div className="space-y-6">
                  {DELIVERABLES.map(({ title, body, Icon, accent }, i) => (
                    <li
                      key={title}
                      className="relative grid grid-cols-[40px_1fr] items-start gap-x-5"
                    >
                      <span
                        aria-hidden="true"
                        className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border bg-white shadow-[0_2px_6px_rgba(15,23,42,0.04)]"
                        style={{
                          borderColor: `${accent}40`,
                          color: accent,
                          background: `linear-gradient(180deg, #FFFFFF 0%, ${accent}0F 100%)`,
                        }}
                      >
                        <Icon size={17} strokeWidth={1.9} />
                      </span>
                      <div
                        className="rounded-[14px] border bg-white px-5 py-4 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                        style={{ borderColor: "#E2E8F0" }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[10.5px] font-bold uppercase tracking-[0.18em]"
                            style={{ color: accent }}
                          >
                            Stage {String(i + 1).padStart(2, "0")}
                          </span>
                        </div>
                        <h3 className="mt-1 text-[1.05rem] font-semibold tracking-[-0.01em] text-[#081426]">
                          {title}
                        </h3>
                        <p className="mt-2 text-[14px] leading-[1.7] text-[#475569]">
                          {body}
                        </p>
                      </div>
                    </li>
                  ))}
                </div>
              </ol>

              {/* Mock preview */}
              <div
                className="relative rounded-[24px] border bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.06)] md:p-7"
                style={{ borderColor: "#E2E8F0" }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-[#2563EB]">
                    Verification Report (mock)
                  </span>
                  <span className="font-mono text-[11px] text-[#64748B]">
                    ER-2026-04812
                  </span>
                </div>

                <div className="mt-5 space-y-3">
                  {[
                    { label: "Integrity state", value: "Match", value2: "Captured at completion" },
                    { label: "Hash · SHA-256", value: "9e3a…f04b", value2: "Recorded fingerprint" },
                    { label: "Timestamp", value: "RFC 3161 anchored", value2: "Where enabled" },
                    { label: "Signature", value: "KMS reference", value2: "Where configured" },
                    { label: "Custody events", value: "12 events", value2: "Hash-chained" },
                    { label: "Retention", value: "Active", value2: "Workspace policy" },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="rounded-[12px] border bg-white p-3"
                      style={{ borderColor: "#F1F5F9" }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12.5px] font-medium text-[#0F172A]">
                          {row.label}
                        </span>
                        <span className="text-[12.5px] font-semibold text-[#1D4ED8]">
                          {row.value}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[#64748B]">
                        {row.value2}
                      </div>
                    </div>
                  ))}
                </div>

                <p className="mt-5 text-[11.5px] leading-[1.6] text-[#64748B]">
                  Illustrative reviewer view. Actual reports reflect configured
                  workflow and platform capabilities.
                </p>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 8 — WHO USES PROOVRA ─────────────────
          Replaces the prior "Why teams choose PROOVRA" section. Each panel
          carries both an Operational value mini-block and a Platform
          capabilities mini-block so buyers see real operational depth.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section style={{ background: "#F8FAFC" }}>
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mb-12 max-w-[880px]">
              <Eyebrow tone="violet">Who uses PROOVRA</Eyebrow>
              <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Built for teams that work with evidence under pressure.
              </h2>
              <p className="mt-5 max-w-[820px] text-[15.5px] leading-[1.78] text-[#475569]">
                PROOVRA is designed for organisations and professionals who
                need digital material to move through capture, review,
                reporting, governance, and external handoff without losing
                context. The platform serves both small teams and enterprise
                organisations by giving evidence a shared operational
                structure: cases, workspaces, reviewer workflows, verification
                outputs, governance controls, audit visibility, and support
                for external review.
              </p>
              <p className="mt-4 max-w-[820px] text-[15px] leading-[1.78] text-[#475569]">
                Different teams use PROOVRA for different reasons. A solo
                legal professional may need clearer matter records and
                reviewer-ready reports. A claims team may need faster
                evidence intake and consistent handoffs. A compliance or
                investigations team may need governance, audit logs, and
                retention context. An enterprise may need workspaces, roles,
                access boundaries, legal hold concepts, security review
                documentation, and repeatable evidence operations across
                departments.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2 lg:gap-6">
              {SCENARIOS.map(({ tag, title, body, operational, platform, Icon, accent, accentSoft }) => (
                <div
                  key={title}
                  className="relative flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)] md:p-7"
                  style={{ borderColor: "#E2E8F0" }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-7 h-10 w-[3px] rounded-r"
                    style={{ background: accent }}
                  />
                  <div className="flex items-start gap-3.5">
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
                      style={{ background: accentSoft, color: accent }}
                    >
                      <Icon size={18} strokeWidth={1.9} />
                    </span>
                    <div className="flex-1">
                      <span
                        className="inline-block rounded-full px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.14em]"
                        style={{ background: accentSoft, color: accent }}
                      >
                        {tag}
                      </span>
                      <h3 className="mt-2 text-[1.1rem] font-semibold tracking-[-0.01em] text-[#081426] md:text-[1.15rem]">
                        {title}
                      </h3>
                    </div>
                  </div>

                  <p className="mt-4 text-[14px] leading-[1.7] text-[#475569]">
                    {body}
                  </p>

                  <div
                    className="mt-5 grid gap-3 rounded-[14px] border p-4"
                    style={{ borderColor: "#E2E8F0", background: "#F8FAFC" }}
                  >
                    <div>
                      <div
                        className="text-[10.5px] font-bold uppercase tracking-[0.16em]"
                        style={{ color: accent }}
                      >
                        Operational value
                      </div>
                      <p className="mt-1.5 text-[13px] leading-[1.65] text-[#0F172A]">
                        {operational}
                      </p>
                    </div>
                    <div className="h-px" style={{ background: "#E2E8F0" }} />
                    <div>
                      <div
                        className="text-[10.5px] font-bold uppercase tracking-[0.16em]"
                        style={{ color: accent }}
                      >
                        Platform capabilities
                      </div>
                      <p className="mt-1.5 text-[13px] leading-[1.65] text-[#0F172A]">
                        {platform}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 9 — IMPORTANT BOUNDARIES ─────────────────
          Solid navy gradient swapped for the icon-card image. Entire
          section container carries the artwork; disclaimer items are
          elevated translucent glass with amber boundary glyphs; CTA
          chips become elevated translucent buttons. ─────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div
              className="relative overflow-hidden rounded-[32px] border p-9 text-white shadow-[0_24px_60px_rgba(7,27,77,0.22)] md:p-14"
              style={{
                borderColor: "rgba(255,255,255,0.10)",
                backgroundImage: "url('/assets/cards/icon-card.png')",
                backgroundSize: "cover",
                backgroundPosition: "center center",
                backgroundRepeat: "no-repeat",
                backgroundColor: "#050F33",
              }}
            >
              {/* Readability scrim — keeps the entire compliance scene legible
                  without flattening the icon-card artwork. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(5,15,51,0.46) 0%, rgba(5,15,51,0.60) 100%)",
                }}
              />

              <div className="relative grid items-start gap-10 lg:grid-cols-[0.95fr_1.05fr]">
                <div>
                  <Eyebrow tone="white">Clear boundaries</Eyebrow>
                  <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.3rem]">
                    Verification is not a truth engine.
                  </h2>
                  <p className="mt-5 max-w-[520px] text-[15px] leading-[1.78] text-[#E2E8F0]">
                    PROOVRA helps preserve and expose recorded technical
                    context. It does not replace legal analysis, expert
                    judgment, investigation, or human review.
                  </p>
                  <div className="mt-7 flex flex-wrap gap-3">
                    <Link
                      href="/legal/verification-methodology"
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border px-5 text-[13.5px] font-semibold text-white backdrop-blur-[12px] transition hover:-translate-y-0.5 hover:bg-white/[0.18]"
                      style={{
                        borderColor: "rgba(255,255,255,0.22)",
                        background: "rgba(15,23,42,0.45)",
                      }}
                    >
                      <ShieldCheck size={14} className="text-[#A78BFA]" />
                      Verification Methodology
                      <ArrowRight size={14} />
                    </Link>
                    <Link
                      href="/legal/verification-disclaimer"
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border px-5 text-[13.5px] font-semibold text-white backdrop-blur-[12px] transition hover:-translate-y-0.5 hover:bg-white/[0.12]"
                      style={{
                        borderColor: "rgba(255,255,255,0.18)",
                        background: "rgba(15,23,42,0.30)",
                      }}
                    >
                      Verification Disclaimer
                    </Link>
                  </div>
                </div>

                <ul className="grid gap-3">
                  {BOUNDARIES.map((b) => (
                    <li
                      key={b}
                      className="flex gap-3 rounded-[14px] border p-4 backdrop-blur-[12px]"
                      style={{
                        borderColor: "rgba(255,255,255,0.12)",
                        background: "rgba(15,23,42,0.40)",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[2px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: "rgba(252,211,77,0.18)",
                          color: "#FCD34D",
                        }}
                      >
                        <Minus size={11} strokeWidth={2.4} />
                      </span>
                      <span className="text-[14px] leading-[1.6] text-white">
                        {b}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────── Section 10 — FINAL CTA (matches Platform / About style) ───────────────── */}
      <RevealSection direction="up">
        <section className="bg-white pb-16 pt-2 md:pb-20">
          <div className="mx-auto max-w-[1180px] px-6 md:px-8">
            <div
              className="relative overflow-hidden rounded-[28px] p-7 text-white shadow-[0_18px_50px_rgba(11,31,91,0.18)] md:p-9"
              style={{
                background:
                  "linear-gradient(90deg,#0B1F5B 0%,#1D2E7A 25%,#8E1F3D 55%,#6A35C9 80%,#7C4DFF 100%)",
              }}
            >
              <div className="relative grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                <div>
                  <div
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                    style={{ background: "rgba(11,31,91,0.35)", color: "#FFFFFF" }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                    Move beyond ordinary files
                  </div>
                  <h2
                    className="mt-3 max-w-[540px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] md:text-[1.85rem]"
                    style={{ color: "#FFFFFF" }}
                  >
                    See why evidence operations need more than files.
                  </h2>
                  <p
                    className="mt-2.5 max-w-[560px] text-[13.5px] leading-[1.6]"
                    style={{ color: "rgba(255,255,255,0.88)" }}
                  >
                    Explore how PROOVRA turns sensitive digital material into
                    Evidence Records with integrity signals, custody context,
                    reports, verification pages, and reviewer-ready packages.
                  </p>
                </div>
                <div className="flex flex-col gap-3 md:items-end">
                  <div className="flex flex-wrap gap-3 md:justify-end">
                    <Link
                      href={MARKETING_LINKS.requestDemo}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#6A35C9] transition-all duration-200 hover:-translate-y-0.5 hover:text-[#5A2CC0]"
                      style={{ fontWeight: 600 }}
                    >
                      Request demo
                      <ArrowRight size={14} />
                    </Link>
                    <Link
                      href={MARKETING_LINKS.verifyDemo}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/40 px-5 text-[13.5px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10"
                    >
                      Try live verification
                    </Link>
                  </div>
                  <Link
                    href="/platform"
                    className="inline-flex items-center gap-1 text-[13px] font-semibold text-white/85 underline-offset-4 transition hover:text-white hover:underline md:justify-end"
                  >
                    Explore platform
                    <ArrowRight size={13} aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>
    </MarketingPage>
  );
}
