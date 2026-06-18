"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ArrowRight,
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
import { ShieldCheckGlyph } from "./RailIcons";

const EMPTY_ERROR = "Enter a verification URL or record ID.";
const INVALID_ERROR = "Enter a valid PROOVRA verification URL or record ID.";

function resolveVerifyTarget(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const fromUrl = raw.match(/\/verify\/([^/?#\s]+)/i);
  if (fromUrl && fromUrl[1]) return `/verify/${fromUrl[1]}`;

  // Looks like a URL but didn't carry a /verify/{id} segment — reject.
  if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) return null;

  // Treat as a raw record id / hash.
  if (/^[A-Za-z0-9._-]+$/.test(raw)) return `/verify/${raw}`;

  return null;
}

export function VerifyInstantly() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleVerify = () => {
    const raw = value.trim();
    if (!raw) {
      setError(EMPTY_ERROR);
      return;
    }
    const target = resolveVerifyTarget(raw);
    if (!target) {
      setError(INVALID_ERROR);
      return;
    }
    setError(null);
    router.push(target);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleVerify();
    }
  };

  return (
    <section
      id="verify-instantly"
      className="relative bg-[var(--proovra-page-bg)]"
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
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-5 py-3 text-[14px] font-semibold text-[#0F172A] hover:border-[var(--proovra-border-warm-hover)]"
            >
              Offline verifier
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="rounded-[24px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            {/* Tab strip — all three render with their original visual style.
                "Verification URL" is the only active mode; the other two are
                inert visual labels (no click handler, no view switch). */}
            <div className="flex gap-1 rounded-2xl bg-[var(--proovra-page-bg-soft)] p-1">
              <button
                type="button"
                aria-current="true"
                className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--proovra-surface)] px-2 py-2 text-[12.5px] font-semibold text-[#0B1F5E] shadow-[0_2px_6px_rgba(15,23,42,0.06)]"
              >
                <LinkIcon size={13} />
                Verification URL
              </button>
              <button
                type="button"
                className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-[12.5px] font-semibold text-[#475569] transition-colors hover:text-[#0F172A]"
              >
                <UploadCloud size={13} />
                Upload Package
              </button>
              <button
                type="button"
                className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-[12.5px] font-semibold text-[#475569] transition-colors hover:text-[#0F172A]"
              >
                <Hash size={13} />
                Enter Hash
              </button>
            </div>

            <label
              htmlFor="verify-input"
              className="mt-5 block text-[12px] font-medium uppercase tracking-[0.14em] text-[#475569]"
            >
              Verification URL
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="verify-input"
                type="text"
                placeholder="Paste a PROOVRA verification URL or enter a record ID"
                aria-label="Paste a PROOVRA verification URL or enter a record ID"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={handleKeyDown}
                className="h-12 flex-1 rounded-xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-4 text-[14px] text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#1769E0] focus:outline-none focus:ring-2 focus:ring-[#1769E0]/15"
              />
              <button
                type="button"
                onClick={handleVerify}
                className="relative inline-flex h-12 items-center justify-center gap-2 overflow-hidden rounded-xl px-5 text-[14px] font-semibold text-white transition-all hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-[#1769E0]/40 focus:ring-offset-1"
                style={{
                  background:
                    "linear-gradient(135deg, #0B3B8F 0%, #1769E0 55%, #4DA3FF 100%)",
                  boxShadow: "0 14px 30px rgba(23,105,224,0.25)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 100%)",
                  }}
                />
                <span className="relative inline-flex items-center gap-2">
                  Verify now
                  <ArrowRight size={15} />
                </span>
              </button>
            </div>

            {error ? (
              <p
                role="alert"
                aria-live="polite"
                className="mt-2 text-[12.5px] text-[#DC2626]"
              >
                {error}
              </p>
            ) : (
              <p className="mt-3 text-[12.5px] text-[#64748B]">
                Paste a published verification URL or the record ID from an
                evidence report. We will open the live verification page so you
                can inspect every integrity signal — hash, timestamp, signature,
                and custody chain.
              </p>
            )}

            <div className="mt-5 border-t border-[var(--proovra-border-warm)] pt-4">
              <p className="text-[12px] font-medium text-[#475569]">
                Try our sample:
              </p>
              <Link
                href={MARKETING_LINKS.verifyDemo}
                className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] hover:text-[#1d4ed8]"
              >
                /verify/demo
                <ArrowRight size={12} />
              </Link>
            </div>
          </div>

          <div className="rounded-[24px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <div className="flex items-start gap-3">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-full"
                style={{
                  background: "#10B981",
                  boxShadow: "0 10px 22px rgba(16,185,129,0.30)",
                }}
              >
                <ShieldCheckGlyph size={20} className="text-white" />
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
                  className="rounded-2xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-page-bg-soft)] p-3"
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
