"use client";

import type { ReactNode } from "react";
import {
  Anchor,
  CheckCircle2,
  Clock3,
  Eye,
  FileText,
  Folder,
  Layers,
  PenLine,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { SALES_ASSETS } from "../../lib/sales-assets";

export const DEMO_RECORD = {
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

export const DEMO_VERIFY_URL = `${SALES_ASSETS.verificationDemoUrl}#example-record`;

export type TabId =
  | "overview"
  | "integrity"
  | "signatures"
  | "timestamps"
  | "opentimestamp"
  | "custody"
  | "access"
  | "resources"
  | "reports";

export const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
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

export type StatusTone =
  | "valid"
  | "verified"
  | "published"
  | "consistent"
  | "protected";

export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
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

export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        {children}
      </span>
    </div>
  );
}

export function InlineEyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
      {children}
    </span>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mx-auto mt-3 max-w-[760px] text-center text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0F172A] md:text-[2rem]">
      {children}
    </h2>
  );
}

export function HeroChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] font-medium text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <CheckCircle2 size={13} className="text-[#16A34A]" strokeWidth={2.6} />
      {label}
    </span>
  );
}
