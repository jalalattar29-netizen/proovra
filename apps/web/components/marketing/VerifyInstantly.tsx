"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ShieldCheck,
  UploadCloud,
  Hash,
  Link as LinkIcon,
  FingerprintPattern,
  Clock,
  KeyRound,
  Anchor,
  CheckCircle2,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

type Tab = "url" | "package" | "hash";

const TABS: { id: Tab; label: string; Icon: typeof LinkIcon }[] = [
  { id: "url", label: "Verification URL", Icon: LinkIcon },
  { id: "package", label: "Upload Package", Icon: UploadCloud },
  { id: "hash", label: "Enter Hash", Icon: Hash },
];

const TAB_CONFIG: Record<
  Tab,
  { placeholder: string; helper: string; sampleLabel: string }
> = {
  url: {
    placeholder: "Paste a PROOVRA verification URL",
    helper: "Verify against the published evidence record.",
    sampleLabel: "Try our sample:",
  },
  package: {
    placeholder: "Drop a verification package (.zip) or click to upload",
    helper: "Bundles include manifest, signatures, and custody chain.",
    sampleLabel: "Or try the sample:",
  },
  hash: {
    placeholder: "Enter SHA-256 hash",
    helper: "We will look up matching evidence and timestamp records.",
    sampleLabel: "Try a sample hash:",
  },
};

export function VerifyInstantly() {
  const [active, setActive] = useState<Tab>("url");
  const cfg = TAB_CONFIG[active];

  return (
    <section
      id="verify-instantly"
      className="relative overflow-hidden bg-white"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto grid max-w-[1480px] grid-cols-1 gap-10 px-5 md:px-7 py-20 lg:grid-cols-[0.85fr_1.8fr] lg:gap-10 lg:px-10 2xl:px-12 lg:py-28">
        <div className="flex flex-col gap-5">
          <SectionBadge>Verify evidence instantly</SectionBadge>
          <h2 className="text-[30px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[42px]">
            Verify evidence
            <br />
            in seconds.
          </h2>
          <p className="max-w-sm text-[15.5px] leading-[1.6] text-[#475569]">
            Run a live verification against a sample evidence package and
            inspect the cryptographic signals end to end.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Link
              href={MARKETING_LINKS.verifyDemo}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#0B1F5E] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_8px_24px_rgba(11,31,94,0.22)] transition-all hover:bg-[#0a1c54]"
            >
              Try live verification
              <ArrowRight size={15} />
            </Link>
            <Link
              href={MARKETING_LINKS.offlineVerifier}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-[#E5E7EB] bg-white px-5 py-3 text-[14px] font-semibold text-[#0F172A] hover:border-[#CBD5E1]"
            >
              Offline verifier
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="rounded-[24px] border border-[#E5E7EB] bg-white p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <div className="flex gap-1 rounded-2xl bg-[#F8FAFC] p-1">
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActive(id)}
                  className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-[12.5px] font-semibold transition-all ${
                    active === id
                      ? "bg-white text-[#0B1F5E] shadow-[0_2px_6px_rgba(15,23,42,0.06)]"
                      : "text-[#475569] hover:text-[#0F172A]"
                  }`}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>

            <label className="mt-5 block text-[12px] font-medium uppercase tracking-[0.14em] text-[#475569]">
              {active === "package" ? "Verification package" : active === "hash" ? "SHA-256 hash" : "Verification URL"}
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                placeholder={cfg.placeholder}
                aria-label={cfg.placeholder}
                className="h-12 flex-1 rounded-xl border border-[#E5E7EB] bg-white px-4 text-[14px] text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/15"
                readOnly
              />
              <Link
                href={MARKETING_LINKS.verifyDemo}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#7C3AED] px-5 text-[14px] font-semibold text-white shadow-[0_8px_22px_rgba(124,58,237,0.30)] transition-all hover:bg-[#6d28d9]"
              >
                Verify now
                <ArrowRight size={15} />
              </Link>
            </div>
            <p className="mt-3 text-[12.5px] text-[#64748B]">{cfg.helper}</p>
            <div className="mt-5 border-t border-[#EEF1F5] pt-4">
              <p className="text-[12px] font-medium text-[#475569]">{cfg.sampleLabel}</p>
              <Link
                href={MARKETING_LINKS.verifyDemo}
                className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] hover:text-[#1d4ed8]"
              >
                /verify/demo
                <ArrowRight size={12} />
              </Link>
            </div>
          </div>

          <div className="rounded-[24px] border border-[#E5E7EB] bg-white p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <div className="flex items-start gap-3">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-2xl"
                style={{ background: "rgba(16,185,129,0.10)" }}
              >
                <ShieldCheck size={20} className="text-[#10B981]" />
              </span>
              <div>
                <h3 className="text-[16.5px] font-bold text-[#10B981]">Evidence Verified</h3>
                <p className="mt-0.5 text-[12.5px] leading-[1.55] text-[#475569]">
                  Integrity signals match the recorded state.
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              {[
                { label: "Hash Match", value: "SHA-256", Icon: FingerprintPattern },
                { label: "Timestamped", value: "RFC 3161", Icon: Clock },
                { label: "Digital Signature", value: "ED25519", Icon: KeyRound },
                { label: "Anchored", value: "OpenTimestamps", Icon: Anchor },
              ].map(({ label, value, Icon }) => (
                <div
                  key={label}
                  className="rounded-2xl border border-[#EEF1F5] bg-[#F8FAFC] p-3"
                >
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} className="text-[#2563EB]" />
                    <span className="text-[11.5px] font-semibold uppercase tracking-[0.10em] text-[#475569]">
                      {label}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13.5px] font-bold text-[#0F172A]">
                    {value}
                  </p>
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-[#10B981]">
                    <CheckCircle2 size={11} />
                    Verified
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
