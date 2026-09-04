import {
  ArrowRight,
  BrainCircuit,
  Camera,
  CheckCircle2,
  FileText,
  Globe2,
  Landmark,
  Link2,
  Lock,
  Package,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { SectionBadge } from "./SectionBadge";

type Stage = {
  n: string;
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
  accentSoft: string;
  preview: ReactNode;
};

const STAGES: Stage[] = [
  {
    n: "01",
    title: "Capture",
    body: "Collect evidence from any device or source.",
    Icon: Camera,
    accent: "#F97316",
    accentSoft: "rgba(249,115,22,0.10)",
    preview: <CapturePreview />,
  },
  {
    n: "02",
    title: "Intake",
    body: "Request evidence through secure intake links.",
    Icon: Link2,
    accent: "#2563EB",
    accentSoft: "rgba(37,99,235,0.10)",
    preview: <IntakePreview />,
  },
  {
    n: "03",
    title: "AI Review",
    body: "Spot missing context before submission, where enabled.",
    Icon: BrainCircuit,
    accent: "#7C3AED",
    accentSoft: "rgba(124,58,237,0.10)",
    preview: <AIReviewPreview />,
  },
  {
    n: "04",
    title: "Verify",
    body: "Check integrity, timestamps, and custody.",
    Icon: ShieldCheck,
    accent: "#047857",
    accentSoft: "rgba(4,120,87,0.08)",
    preview: <VerifyPreview />,
  },
  {
    n: "05",
    title: "Report",
    body: "Generate review-ready evidence reports.",
    Icon: FileText,
    accent: "#0891B2",
    accentSoft: "rgba(8,145,178,0.10)",
    preview: <ReportPreview />,
  },
  {
    n: "06",
    title: "Package",
    body: "Share sealed verification packages.",
    Icon: Package,
    accent: "#DB2777",
    accentSoft: "rgba(219,39,119,0.10)",
    preview: <PackagePreview />,
  },
  {
    n: "07",
    title: "Govern",
    body: "Apply retention, legal hold, and audit controls.",
    Icon: Landmark,
    accent: "#4F46E5",
    accentSoft: "rgba(79,70,229,0.10)",
    preview: <GovernPreview />,
  },
];

const TRUST_ITEMS: { Icon: LucideIcon; title: string; body: string }[] = [
  { Icon: ShieldCheck, title: "End-to-end integrity", body: "Cryptographic protection at every step" },
  { Icon: Lock, title: "Tamper-evident", body: "Records you can trust in any environment" },
  { Icon: Globe2, title: "Independent verification", body: "Anyone can verify anywhere, anytime" },
  { Icon: CheckCircle2, title: "Audit ready", body: "Built for compliance and review" },
  { Icon: Landmark, title: "Enterprise governance", body: "Control access, retention, and legal hold" },
];

export function EvidenceLifecycle() {
  return (
    <section
      id="evidence-lifecycle"
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1560px] px-5 py-20 md:px-7 lg:px-10 lg:py-24 2xl:px-12">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <SectionBadge>Complete Evidence Lifecycle</SectionBadge>
          <h2 className="mt-5 max-w-[1000px] text-[30px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[40px] lg:text-[46px]">
            From capture to proof.
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg,#2563EB 0%,#7C3AED 50%,#DB2777 100%)",
              }}
            >
              Every step. Every signal. Every time.
            </span>
          </h2>
          <p className="mt-5 max-w-[720px] text-[15.5px] leading-[1.7] text-[#475569]">
            PROOVRA connects every stage of the evidence lifecycle into a secure,
            verifiable, and audit-ready workflow you can trust.
          </p>
        </div>

        {/* 7-card row */}
        <div className="mt-12 -mx-5 overflow-x-auto px-5 pb-2 md:mx-0 md:overflow-visible md:px-0">
          <div className="grid min-w-[1180px] grid-cols-7 gap-4 md:min-w-0 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {STAGES.map((stage, idx) => (
              <LifecycleCard key={stage.n} stage={stage} showArrow={idx < STAGES.length - 1} />
            ))}
          </div>
        </div>

        {/* Bottom trust strip — aligned with the card row */}
        <div className="mt-12 overflow-hidden rounded-[20px] border border-[#E5E7EB] bg-white">
          <div className="grid grid-cols-1 divide-y divide-[#E5E7EB] sm:grid-cols-2 sm:divide-y-0 md:grid-cols-3 lg:grid-cols-5 lg:divide-x">
            {TRUST_ITEMS.map(({ Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3 px-5 py-5 lg:px-6">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F8FAFC] text-[#0F172A]">
                  <Icon size={17} strokeWidth={1.85} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-bold leading-[1.25] text-[#0F172A]">
                    {title}
                  </div>
                  <div className="mt-1 text-[12px] leading-[1.45] text-[#64748B]">
                    {body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LifecycleCard({ stage, showArrow }: { stage: Stage; showArrow: boolean }) {
  const { n, title, body, Icon, accent, accentSoft, preview } = stage;
  return (
    <div className="relative">
      <div className="relative flex h-full min-h-[320px] flex-col overflow-hidden rounded-[22px] border border-[#E5E7EB] bg-white px-4 pb-4 pt-4 shadow-[0_2px_6px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
        {/* Step number chip */}
        <div className="flex items-start justify-between">
          <span
            className="rounded-md px-2 py-0.5 text-[11px] font-extrabold tracking-[0.04em]"
            style={{ color: accent, background: accentSoft }}
          >
            {n}
          </span>
        </div>

        {/* Icon disc */}
        <div className="flex justify-center pt-2">
          <span
            className="inline-flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: accent, boxShadow: `0 10px 22px ${accent}33` }}
          >
            <Icon size={20} strokeWidth={2.1} className="text-white" />
          </span>
        </div>

        {/* Preview tile — uniform height across all cards */}
        <div className="mt-3 flex h-[112px] items-center">
          <div
            className="w-full overflow-hidden rounded-[10px] border border-[#E5E7EB] bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
            style={{ minHeight: 96 }}
          >
            {preview}
          </div>
        </div>

        {/* Title + body */}
        <div className="mt-3 flex flex-1 flex-col">
          <h3 className="text-[15px] font-bold tracking-[-0.005em] text-[#0F172A]">
            {title}
          </h3>
          <p className="mt-1 text-[12px] leading-[1.5] text-[#475569]">
            {body}
          </p>
        </div>

        {/* Bottom accent line */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px]"
          style={{ background: accent }}
        />
      </div>

      {/* Arrow between cards — desktop only */}
      {showArrow ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-[18px] top-[60px] z-10 hidden h-7 w-7 items-center justify-center rounded-full border border-[#E2E8F0] bg-white text-[#94A3B8] shadow-[0_1px_3px_rgba(15,23,42,0.05)] xl:flex"
        >
          <ArrowRight size={13} strokeWidth={2.2} />
        </span>
      ) : null}
    </div>
  );
}

/* ─── Mini UI previews ────────────────────────────────────────────────── */

function CapturePreview() {
  return (
    <div className="relative -m-2.5 h-[120px] overflow-hidden rounded-[8px]">
      <img
        src="/assets/use-cases/verification-car-rental-return.png"
        alt=""
        className="h-full w-full object-cover"
        style={{ objectPosition: "center 28%" }}
        loading="lazy"
      />
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-white shadow-[0_4px_10px_rgba(249,115,22,0.45)]"
        style={{ background: "#F97316" }}
      >
        <Camera size={11} strokeWidth={2.2} />
      </span>
    </div>
  );
}

function IntakePreview() {
  return (
    <div className="space-y-1.5">
      <div className="text-[8.5px] font-semibold uppercase tracking-[0.10em] text-[#64748B]">
        Intake Link
      </div>
      <div className="truncate rounded border border-[#E5E7EB] bg-[#F8FAFC] px-1.5 py-1 text-[8px] font-mono text-[#475569]">
        proovra.com/intake/abc123
      </div>
      <div
        className="rounded px-1.5 py-1 text-center text-[8.5px] font-bold text-white"
        style={{ background: "#2563EB" }}
      >
        Copy Link
      </div>
    </div>
  );
}

function AIReviewPreview() {
  const items: { dot: string; label: string }[] = [
    { dot: "#EF4444", label: "Missing location" },
    { dot: "#F97316", label: "No timestamp" },
    { dot: "#7C3AED", label: "Low quality image" },
  ];
  return (
    <div className="space-y-1.5">
      <div className="text-[8.5px] font-semibold uppercase tracking-[0.10em] text-[#64748B]">
        AI Review
      </div>
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5 text-[8.5px] text-[#0F172A]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: it.dot }} />
          <span className="truncate">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function VerifyPreview() {
  const rows: { label: string; right: string }[] = [
    { label: "Integrity", right: "SHA-256" },
    { label: "Timestamp", right: "RFC 3161" },
    { label: "Custody", right: "Verified" },
  ];
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-1.5 text-[8.5px]">
          <span className="flex items-center gap-1 truncate text-[#0F172A]">
            <CheckCircle2 size={9} strokeWidth={2.6} className="text-[#047857]" />
            {r.label}
          </span>
          <span className="rounded bg-[#F1F5F9] px-1 py-0.5 font-mono text-[7.5px] text-[#475569]">
            {r.right}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReportPreview() {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="grid h-7 w-5 grid-rows-3 gap-0.5">
        <span className="rounded-[2px] bg-[#E2E8F0]" />
        <span className="rounded-[2px] bg-[#CBD5E1]" />
        <span className="rounded-[2px] bg-[#E2E8F0]" />
      </div>
      <div className="flex-1 space-y-1">
        <span className="block h-1 w-full rounded bg-[#E2E8F0]" />
        <span className="block h-1 w-4/5 rounded bg-[#E2E8F0]" />
        <span className="block h-1 w-3/5 rounded bg-[#E2E8F0]" />
      </div>
    </div>
  );
}

function PackagePreview() {
  return (
    <div className="space-y-1.5">
      <div className="text-[8.5px] font-semibold uppercase tracking-[0.10em] text-[#64748B]">
        Verification Package
      </div>
      <div className="flex items-center gap-1 rounded border border-[#E5E7EB] bg-[#F8FAFC] px-1.5 py-1 font-mono text-[8px] text-[#475569]">
        <Lock size={7.5} strokeWidth={2.2} className="text-[#64748B]" />
        7A3F-9B21-EFC0-…
      </div>
    </div>
  );
}

function GovernPreview() {
  const rows: { label: string; right: string; rightColor: string }[] = [
    { label: "Retention", right: "7 years", rightColor: "#0F172A" },
    { label: "Legal Hold", right: "Active", rightColor: "#047857" },
    { label: "Audit Log", right: "Complete", rightColor: "#0F172A" },
  ];
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between text-[8.5px]">
          <span className="text-[#475569]">{r.label}</span>
          <span className="font-semibold" style={{ color: r.rightColor }}>
            {r.right}
          </span>
        </div>
      ))}
    </div>
  );
}
