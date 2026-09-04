import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Camera,
  CheckCircle2,
  FileText,
  Filter,
  Folder,
  Landmark,
  Link2,
  Lock,
  Plus,
  ScrollText,
  Sparkles,
  Users,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { SectionBadge } from "./SectionBadge";

type CardSpec = {
  title: string;
  body: string;
  accent: string;
  accentSoft: string;
  Icon: LucideIcon;
  bullets: string[];
  preview: ReactNode;
  /** True for cards whose preview needs more horizontal room (Capture). */
  widePreview?: boolean;
};

const CARDS: CardSpec[] = [
  {
    title: "Capture & Intake",
    body: "Upload files, collect submissions, and request evidence through secure intake links.",
    accent: "#F97316",
    accentSoft: "rgba(249,115,22,0.12)",
    Icon: Camera,
    bullets: ["Intake Links", "Upload Queue", "Submission Requests"],
    preview: <CapturePreview />,
    widePreview: true,
  },
  {
    title: "AI Assistance",
    // "where enabled" because all three depend on the platform having an AI
    // provider configured AND the workspace not having opted out. The
    // capabilities are real and on by default once AI is configured; the card
    // previously implied they were unconditional. Same phrase as
    // why-proovra/page.tsx and the AI Use Policy.
    body: "Guide evidence collection, detect missing context, and prepare reviewers, where enabled.",
    accent: "#7C3AED",
    accentSoft: "rgba(124,58,237,0.12)",
    Icon: Sparkles,
    bullets: [
      "Missing Context Detection",
      "Smart Suggestions",
      "Review Readiness Score",
    ],
    preview: <AIPreview />,
  },
  {
    title: "Cases & Reviewer Operations",
    body: "Organize evidence by claims, matters, incidents, and investigations.",
    accent: "#2563EB",
    accentSoft: "rgba(37,99,235,0.12)",
    Icon: Users,
    bullets: ["Case Management", "Reviewer Workflows", "Task Assignments"],
    preview: <CasesPreview />,
  },
  {
    title: "Governance",
    body: "Manage retention, legal hold, audit logs, and compliance controls.",
    accent: "#047857",
    accentSoft: "rgba(4,120,87,0.10)",
    Icon: Landmark,
    bullets: ["Retention Policies", "Legal Hold", "Audit Logs & Exports"],
    preview: <GovernancePreview />,
  },
];

const TRUST: { Icon: LucideIcon; title: string; body: string; color: string }[] = [
  { Icon: Link2, title: "Intake Links", body: "Secure evidence collection at scale", color: "#2563EB" },
  { Icon: Sparkles, title: "AI Review", body: "Advisory insights and guidance, where enabled", color: "#7C3AED" },
  { Icon: Users, title: "Reviewer Workflows", body: "Built for teams and investigations", color: "#0F766E" },
  { Icon: Landmark, title: "Legal Hold", body: "Preserve what matters when it matters", color: "#047857" },
  { Icon: Calendar, title: "Retention Controls", body: "Automated policies and preservation", color: "#EA580C" },
  { Icon: FileText, title: "Audit Logs", body: "Complete visibility and accountability", color: "#0F172A" },
];

export function EvidenceOperations() {
  return (
    <section
      id="evidence-operations"
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1400px] px-5 py-20 md:px-7 lg:px-10 lg:py-24 2xl:px-12">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <SectionBadge>Built for Evidence Operations</SectionBadge>
          <h2 className="mt-5 max-w-[1000px] text-[30px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[40px] lg:text-[46px]">
            Built for evidence operations,
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg,#2563EB 0%,#4F46E5 50%,#7C3AED 100%)",
              }}
            >
              not just verification.
            </span>
          </h2>
          <p className="mt-5 max-w-[700px] text-[15.5px] leading-[1.7] text-[#475569]">
            PROOVRA brings together the people, workflows, and controls you need
            to run evidence operations at scale.
          </p>
        </div>

        {/* 2×2 card grid */}
        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {CARDS.map((c) => (
            <OperationsCard key={c.title} spec={c} />
          ))}
        </div>

        {/* Bottom trust strip */}
        <div className="mt-8 overflow-hidden rounded-[20px] border border-[#E5E7EB] bg-white">
          <div className="grid grid-cols-1 divide-y divide-[#E5E7EB] sm:grid-cols-2 sm:divide-y-0 md:grid-cols-3 lg:grid-cols-6 lg:divide-x">
            {TRUST.map(({ Icon, title, body, color }) => (
              <div key={title} className="flex items-start gap-3 px-4 py-5 lg:px-5">
                <span
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F8FAFC]"
                  style={{ color }}
                >
                  <Icon size={17} strokeWidth={1.85} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-bold leading-[1.25] text-[#0F172A]">
                    {title}
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[1.45] text-[#64748B]">
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

function OperationsCard({ spec }: { spec: CardSpec }) {
  const { title, body, accent, accentSoft, Icon, bullets, preview, widePreview } = spec;
  // 44/56 split when the preview needs more room (Capture); 1:1.05 otherwise.
  const colsClass = widePreview
    ? "lg:grid-cols-[44fr_56fr]"
    : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]";
  const gapClass = widePreview ? "gap-6 lg:gap-8" : "gap-6";
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all duration-200 hover:shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <div className={`grid ${gapClass} p-6 md:p-7 ${colsClass}`}>
        {/* Left: heading + bullets */}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              style={{ background: accent, boxShadow: `0 10px 22px ${accent}33` }}
            >
              <Icon size={19} strokeWidth={2.1} className="text-white" />
            </span>
            <h3 className="text-[19px] font-extrabold tracking-[-0.005em] text-[#0F172A] md:text-[20px]">
              {title}
            </h3>
          </div>
          <p className="mt-4 max-w-[260px] text-[13.5px] leading-[1.65] text-[#475569]">
            {body}
          </p>
          <ul className="mt-5 space-y-2.5 pl-0">
            {bullets.map((b) => (
              <li
                key={b}
                className="flex items-center gap-2.5 text-[13px] font-semibold text-[#0F172A]"
                style={{ listStyle: "none" }}
              >
                <span
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                  style={{ background: accentSoft, color: accent }}
                >
                  <CheckCircle2 size={11} strokeWidth={2.6} />
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>

        {/* Right: product-inspired preview */}
        <div className="min-w-0 rounded-[16px] border border-[#E5E7EB] bg-[#F8FAFC] p-3">
          {preview}
        </div>
      </div>
    </div>
  );
}

/* ─── Card 1: Capture & Intake ─────────────────────────────────────────── */

function CapturePreview() {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3">
      {/* Phone mock */}
      <div className="relative h-[210px] overflow-hidden rounded-[14px] border border-[#E5E7EB] bg-white p-1.5">
        <div className="relative h-full overflow-hidden rounded-[10px] bg-[#0F172A]">
          <img
            src="/assets/use-cases/verification-car-rental-return.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-95"
            style={{ objectPosition: "center 30%" }}
            loading="lazy"
          />
          <div className="absolute inset-x-0 top-1.5 flex items-center justify-between px-2 text-[6.5px] font-bold text-white/95">
            <Zap size={7} strokeWidth={2.4} />
            <span className="rounded bg-black/40 px-1 py-0.5">Capture</span>
            <Lock size={7} strokeWidth={2.4} />
          </div>
          <div className="absolute inset-x-0 bottom-1.5 flex items-center justify-around">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/30">
              <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
            </span>
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-[0_4px_10px_rgba(0,0,0,0.3)]">
              <span className="h-4 w-4 rounded-full border-[1.5px] border-[#0F172A]" />
            </span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/30">
              <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
            </span>
          </div>
        </div>
      </div>

      {/* Side panels */}
      <div className="space-y-2.5">
        {/* Intake Link */}
        <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
          <div className="text-[9px] font-bold uppercase tracking-[0.10em] text-[#64748B]">
            Intake Link
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="flex-1 truncate rounded border border-[#E5E7EB] bg-[#F8FAFC] px-2 py-1 font-mono text-[9px] text-[#475569]">
              proovra.com/intake/abc123
            </div>
            <button
              type="button"
              className="rounded px-2 py-1 text-[9px] font-bold text-white"
              style={{ background: "#F97316" }}
            >
              Copy Link
            </button>
          </div>
        </div>

        {/* Upload Queue */}
        <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
          <div className="text-[9px] font-bold uppercase tracking-[0.10em] text-[#64748B]">
            Upload Queue
          </div>
          <UploadRow name="IMG_3647.heic" size="2.4 MB" progress={100} />
          <UploadRow name="VID_2025.mov" size="74.4 MB" progress={76} />
        </div>

        {/* Submission Requests */}
        <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
          <div className="text-[9px] font-bold uppercase tracking-[0.10em] text-[#64748B]">
            Submission Requests
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded border border-[#E5E7EB] bg-[#F8FAFC] px-2 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-[10px] font-bold text-[#0F172A]">
                Insurance Claim Evidence
              </div>
              <div className="text-[8.5px] text-[#64748B]">Requested 2h ago</div>
            </div>
            <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold text-[#9A3412]" style={{ background: "rgba(249,115,22,0.15)" }}>
              Pending
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function UploadRow({ name, size, progress }: { name: string; size: string; progress: number }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#F1F5F9]">
        <FileText size={9} strokeWidth={1.85} className="text-[#475569]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-[9px]">
          <span className="truncate font-semibold text-[#0F172A]">{name}</span>
          <span className="ml-1.5 shrink-0 text-[8px] text-[#64748B]">{size}</span>
        </div>
        <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[#E2E8F0]">
          <span
            className="block h-full rounded-full"
            style={{ width: `${progress}%`, background: progress === 100 ? "#16A34A" : "#2563EB" }}
          />
        </div>
      </div>
      <span className="shrink-0 text-[8px] font-bold text-[#64748B]">{progress}%</span>
    </div>
  );
}

/* ─── Card 2: AI Assistance ────────────────────────────────────────────── */

function AIPreview() {
  return (
    <div className="space-y-2.5">
      {/* AI Review header */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Sparkles size={10} strokeWidth={2.2} className="text-[#7C3AED]" />
            <span className="text-[10px] font-bold text-[#0F172A]">AI Review</span>
          </div>
        </div>
      </div>

      {/* Review Readiness Score */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="flex items-center justify-between text-[9px]">
          <span className="font-bold text-[#0F172A]">Review Readiness</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[14px] font-extrabold text-[#0F172A]">85%</span>
          <span className="text-[9px] font-semibold text-[#15803D]">Good</span>
          <span className="ml-auto text-[9px] font-bold text-[#7C3AED]">Goal</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#E2E8F0]">
          <span className="block h-full w-[85%] rounded-full bg-gradient-to-r from-[#7C3AED] to-[#4F46E5]" />
        </div>
      </div>

      {/* Missing Context */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="text-[9px] font-bold text-[#0F172A]">Missing Context</div>
        <div className="mt-1.5 space-y-1">
          {[
            { label: "Location data missing", level: "High", lvlColor: "#EF4444" },
            { label: "Timestamp missing", level: "High", lvlColor: "#EF4444" },
            { label: "No device information", level: "Medium", lvlColor: "#F97316" },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1 truncate text-[9.5px] text-[#0F172A]">
                <XCircle size={10} strokeWidth={2.4} className="text-[#EF4444]" />
                {row.label}
              </span>
              <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(239,68,68,0.10)", color: row.lvlColor }}>
                {row.level}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Suggested Actions */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="text-[9px] font-bold text-[#0F172A]">Suggested Actions</div>
        <div className="mt-1.5 flex items-center justify-between gap-1.5">
          <span className="flex items-center gap-1 truncate text-[9.5px] text-[#0F172A]">
            <AlertCircle size={10} strokeWidth={2.2} className="text-[#7C3AED]" />
            Add location data
          </span>
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-[8.5px] font-bold text-white"
            style={{ background: "#7C3AED" }}
          >
            Resolve
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Card 3: Cases & Reviewer Operations ──────────────────────────────── */

function CasesPreview() {
  return (
    <div className="space-y-2.5">
      {/* Cases header */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Folder size={10} strokeWidth={2.2} className="text-[#2563EB]" />
            <span className="text-[10px] font-bold text-[#0F172A]">Cases</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 rounded border border-[#E5E7EB] bg-[#F8FAFC] px-1.5 py-0.5 text-[8px] font-semibold text-[#475569]">
              All Cases <Filter size={7.5} strokeWidth={2} />
            </span>
            <span className="inline-flex items-center gap-0.5 rounded border border-[#E5E7EB] bg-[#F8FAFC] px-1.5 py-0.5 text-[8px] font-semibold text-[#475569]">
              <Filter size={7.5} strokeWidth={2} /> Filter
            </span>
            <span
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8px] font-bold text-white"
              style={{ background: "#2563EB" }}
            >
              <Plus size={7.5} strokeWidth={2.4} /> New Case
            </span>
          </div>
        </div>
      </div>

      {/* Case rows */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        {[
          { id: "Claim: CLM-2025-00124", sub: "Motor Vehicle Accident", count: "128", tone: "review" },
          { id: "Matter: MTR-2025-78", sub: "Contract Dispute", count: "84", tone: "review" },
          { id: "Investigation: INV-2025-33", sub: "Policy Violation", count: "156", tone: "analysis" },
        ].map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-2 border-b border-[#F1F5F9] py-1.5 last:border-0 last:pb-0 first:pt-0"
          >
            <div className="min-w-0">
              <div className="truncate text-[9.5px] font-bold text-[#0F172A]">{c.id}</div>
              <div className="truncate text-[8.5px] text-[#64748B]">{c.sub}</div>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="rounded-full px-1.5 py-0.5 text-[8px] font-bold"
                style={{
                  background: c.tone === "review" ? "rgba(37,99,235,0.12)" : "rgba(124,58,237,0.12)",
                  color: c.tone === "review" ? "#2563EB" : "#7C3AED",
                }}
              >
                {c.tone === "review" ? "In Review" : "Analysis"}
              </span>
              <div className="text-right">
                <div className="text-[9.5px] font-extrabold text-[#0F172A]">{c.count}</div>
                <div className="text-[7.5px] text-[#64748B]">Evidence</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reviewer queue */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="text-[9px] font-bold uppercase tracking-[0.10em] text-[#64748B]">
          Reviewer Queue
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {[
            { initials: "SK", name: "Sarah K.", tasks: 12, bg: "#FED7AA", color: "#9A3412" },
            { initials: "JL", name: "James L.", tasks: 8, bg: "#BFDBFE", color: "#1E3A8A" },
            { initials: "MT", name: "Michael T.", tasks: 15, bg: "#C7D2FE", color: "#3730A3" },
          ].map((r) => (
            <div key={r.name} className="rounded border border-[#E5E7EB] bg-white p-1.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-bold"
                  style={{ background: r.bg, color: r.color }}
                >
                  {r.initials}
                </span>
                <span className="truncate text-[9px] font-bold text-[#0F172A]">{r.name}</span>
              </div>
              <div className="mt-0.5 text-[7.5px] text-[#64748B]">{r.tasks} Tasks</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Card 4: Governance ──────────────────────────────────────────────── */

function GovernancePreview() {
  return (
    <div className="space-y-2.5">
      {/* Governance Overview */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="text-[10px] font-bold text-[#0F172A]">Governance Overview</div>
        <div className="mt-1.5 space-y-1">
          {[
            { Icon: Lock, label: "Retention Policy", right: "7 years", rightLabel: "Active", rightColor: "#15803D" },
            { Icon: Landmark, label: "Legal Hold", right: "3 Active Holds", rightLabel: null, rightColor: "#0F172A" },
            { Icon: ScrollText, label: "Audit Log", right: "12,846 Events", rightLabel: null, rightColor: "#0F172A" },
            { Icon: CheckCircle2, label: "Compliance", right: "Security controls active", rightLabel: null, rightColor: "#047857" },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1.5 truncate text-[9.5px] text-[#0F172A]">
                <row.Icon size={10} strokeWidth={1.85} className="text-[#64748B]" />
                {row.label}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-[9px] font-semibold text-[#475569]">{row.right}</span>
                {row.rightLabel ? (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[8px] font-bold"
                    style={{ background: "rgba(4,120,87,0.10)", color: row.rightColor }}
                  >
                    {row.rightLabel}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Audit Logs */}
      <div className="rounded-[10px] border border-[#E5E7EB] bg-white p-2.5">
        <div className="text-[10px] font-bold text-[#0F172A]">Recent Audit Logs</div>
        <div className="mt-1.5 space-y-1">
          {[
            { actor: "User login", who: "Sarah K.", time: "2m ago" },
            { actor: "Evidence exported", who: "James L.", time: "15m ago" },
            { actor: "Legal hold enabled", who: "System", time: "1h ago" },
          ].map((log) => (
            <div key={log.actor + log.time} className="flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1.5 truncate text-[9px] text-[#0F172A]">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#F1F5F9]">
                  <ScrollText size={8} strokeWidth={1.85} className="text-[#475569]" />
                </span>
                <span className="truncate font-semibold">{log.actor}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[8.5px] text-[#64748B]">
                <span className="truncate">{log.who}</span>
                <span>{log.time}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-0.5 text-[8.5px] font-bold text-[#2563EB]">
          View all logs <ArrowRight size={9} strokeWidth={2.2} />
        </div>
      </div>
    </div>
  );
}
