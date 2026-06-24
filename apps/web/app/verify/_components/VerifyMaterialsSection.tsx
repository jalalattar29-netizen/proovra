"use client";

import type { ElementType } from "react";
import {
  Fingerprint,
  Link2,
  Clock3,
  PenLine,
  FileText,
  Eye,
} from "lucide-react";
import { SECTION_BORDER } from "./shared";

const ITEMS: { label: string; Icon: ElementType; color: string }[] = [
  { label: "SHA-256 Fingerprints", Icon: Fingerprint, color: "#2563EB" },
  { label: "Chain of Custody", Icon: Link2, color: "#7C3AED" },
  { label: "Timestamp Context", Icon: Clock3, color: "#DB2777" },
  { label: "Digital Signatures", Icon: PenLine, color: "#10A37F" },
  { label: "Verification Reports", Icon: FileText, color: "#F97316" },
  { label: "Access Activity", Icon: Eye, color: "#2563EB" },
];

export function VerifyMaterialsSection() {
  return (
    <section className="bg-white py-10 md:py-12">
      <div className="mx-auto max-w-[1100px] px-6 md:px-8">
        <div className="text-center">
          <span
            className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#2563EB]"
            style={{ borderColor: SECTION_BORDER }}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            Verification Materials May Include
          </span>
          <p className="mx-auto mt-3 max-w-[720px] text-[14px] leading-[1.65] text-[#526176]">
            A public verification record may expose selected review materials
            depending on what was recorded, shared, and supported for the
            evidence record.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {ITEMS.map((item) => (
            <span
              key={item.label}
              className="inline-flex items-center gap-2 rounded-full border bg-[#F7FAFC] px-3.5 py-1.5 text-[12.5px] font-medium text-[#0F172A] shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
              style={{ borderColor: SECTION_BORDER }}
            >
              <span
                aria-hidden
                className="flex h-6 w-6 items-center justify-center rounded-full"
                style={{
                  background: `${item.color}14`,
                  border: `1px solid ${item.color}3D`,
                }}
              >
                <item.Icon size={12} strokeWidth={2} style={{ color: item.color }} />
              </span>
              {item.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
