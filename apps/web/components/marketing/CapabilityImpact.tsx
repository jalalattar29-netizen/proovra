"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  Fingerprint,
  ClockCounterClockwise,
  LinkSimple,
  Package,
  Scroll,
} from "@phosphor-icons/react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const CAPABILITIES = [
  {
    title: "Cryptographic integrity",
    body: "SHA-256 fingerprints + ED25519 signatures on every record.",
    Icon: Fingerprint,
  },
  {
    title: "Timestamp verification",
    body: "RFC 3161 trusted timestamps anchored to Bitcoin via OTS.",
    Icon: ClockCounterClockwise,
  },
  {
    title: "Tamper-evident custody",
    body: "Linked-hash custody log with prior-event binding.",
    Icon: LinkSimple,
  },
  {
    title: "Verification packages",
    body: "Portable signed bundles with manifest and chain.",
    Icon: Package,
  },
  {
    title: "Governance-ready records",
    body: "Legal-hold, retention, and reviewable destruction controls.",
    Icon: Scroll,
  },
];

function GradientIcon({ Icon }: { Icon: typeof Fingerprint }) {
  return (
    <span
      className="inline-flex h-12 w-12 items-center justify-center rounded-2xl p-[2.5px] shadow-[0_8px_18px_rgba(15,23,42,0.05)]"
      style={{
        background:
          "linear-gradient(135deg,#2D2A7B 0%,#8A2F9B 48%,#E91E7A 100%)",
      }}
    >
      <span className="flex h-full w-full items-center justify-center rounded-[15px] bg-[var(--proovra-surface)]">
<Icon size={25} weight="bold" color="#8A2F9B" />
      </span>
    </span>
  );
}

export function CapabilityImpact() {
  return (
    <section
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="capabilityIconGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2D2A7B" />
            <stop offset="48%" stopColor="#8A2F9B" />
            <stop offset="100%" stopColor="#E91E7A" />
          </linearGradient>
        </defs>
      </svg>

      <div className="mx-auto max-w-[1480px] px-5 py-16 md:px-7 lg:px-10 lg:py-24 2xl:px-12">
        <div className="mb-8 flex items-center gap-3">
          <SectionBadge>PROOVRA Capabilities</SectionBadge>
          <span className="h-px flex-1 bg-[#E5E7EB]" />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_1.4fr] lg:gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-3">
            {CAPABILITIES.map(({ title, body, Icon }) => (
              <div
                key={title}
                className="flex flex-col gap-3 rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-4 shadow-[0_2px_8px_rgba(15,23,42,0.03)] transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,23,42,0.07)]"
              >
                <GradientIcon Icon={Icon} />

                <h3 className="text-[14px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                  {title}
                </h3>

                <p className="text-[12px] leading-[1.55] text-[#475569]">
                  {body}
                </p>
              </div>
            ))}
          </div>

          <Link
            href={MARKETING_LINKS.contactSales}
            className="group relative flex flex-col justify-between gap-4 overflow-hidden rounded-[24px] p-6 shadow-[0_18px_40px_rgba(124,58,237,0.30)] transition-all hover:-translate-y-0.5"
            style={{
              background:
                "linear-gradient(135deg, #F97316 0%, #EC4899 45%, #7C3AED 100%)",
              color: "#FFFFFF",
            }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-50 blur-2xl"
              style={{ background: "rgba(255,255,255,0.25)" }}
            />

            <div className="relative">
              <span
                className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: "rgba(255,255,255,0.92)" }}
              >
                Ready to transform your evidence operations?
              </span>

              <h3
                className="mt-3 text-[19px] font-extrabold leading-[1.2] tracking-tight"
                style={{ color: "#FFFFFF" }}
              >
                Request a personalized demo or speak with an expert.
              </h3>
            </div>

            <span className="relative inline-flex w-fit items-center gap-2 rounded-2xl bg-[var(--proovra-surface)] px-5 py-2.5 text-[13.5px] font-semibold text-[#7C3AED] shadow-[0_8px_22px_rgba(15,23,42,0.10)] transition-all group-hover:bg-[var(--proovra-page-bg-soft)]">
              Talk to an expert
              <ArrowRight size={14} />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}