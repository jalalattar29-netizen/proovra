"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { MARKETING_BTN } from "../../../lib/marketing-buttons";
import { SECTION_BORDER } from "./shared";

const TRUST_CHIPS = [
  "Read-only verification",
  "No account required",
  "Reviewer-facing record",
  "Public verification token",
];

const HELPER_BULLETS = [
  "Inspect recorded integrity and custody context.",
  "Review available reports, timestamps, signatures, and supporting materials.",
  "Use for external review, compliance review, claims review, or independent technical inspection.",
];

export function VerifyHero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-[url('/assets/hero/verify-hero.png')] bg-cover bg-center bg-no-repeat"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-white/20"
      />

      <div className="relative z-10">
        <MarketingHeader />

        <div
          className="mx-auto max-w-[1320px] px-6 pb-12 pt-16 md:px-8 md:pb-16 md:pt-20 lg:pb-20 lg:pt-24"
          style={{ minHeight: "min(680px, calc(100vh - 96px))" }}
        >
          <div className="grid gap-10 lg:grid-cols-[minmax(0,580px)_1fr] lg:items-start lg:gap-12">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-[#DDE7F3] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
                Public Verify
              </span>
              <h1 className="mt-5 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.028em] text-[#071326] md:text-[2.6rem] lg:text-[2.95rem]">
                Review digital evidence through a verification-first record.{" "}
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg,#2563EB 0%,#7C3AED 60%,#DB2777 100%)",
                  }}
                >
                  No account required.
                </span>
              </h1>
              <p className="mt-5 max-w-[560px] text-[15.5px] leading-[1.7] text-[#526176]">
                Open a PROOVRA verification token or public verification ID to
                inspect recorded integrity state, custody context, timing
                context, access activity, and supporting verification materials
                where available.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="#token-card"
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#07132B] px-5 py-2.5 text-[14px] font-semibold text-white shadow-[0_12px_28px_rgba(7,19,43,0.22)] transition hover:bg-[#0B1E3A]"
                >
                  Open verification
                  <ArrowRight size={14} />
                </a>
                <Link href="/offline-verifier" className={MARKETING_BTN.heroSecondary}>
                  Offline Verifier
                  <ArrowRight size={14} />
                </Link>
              </div>

              <ul className="mt-6 flex max-w-[560px] flex-wrap gap-2">
                {TRUST_CHIPS.map((label) => (
                  <li
                    key={label}
                    className="inline-flex items-center gap-2 rounded-full border border-[#DDE7F3] bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#0F172A] shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
                  >
                    <CheckCircle2 size={13} strokeWidth={2.4} className="text-[#10A37F]" />
                    {label}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-4 lg:mt-8">
              <VerifyTokenCard />

              <div
                className="rounded-[14px] border bg-white/85 px-4 py-3 text-[12.5px] leading-[1.55] text-[#526176] shadow-[0_8px_22px_rgba(15,23,42,0.06)] backdrop-blur"
                style={{ borderColor: SECTION_BORDER }}
              >
                <strong className="font-semibold text-[#07142F]">Boundary notice.</strong>{" "}
                PROOVRA verifies recorded technical and workflow materials. It does
                not determine factual truth, authorship, identity, legal
                admissibility, or evidentiary weight.
              </div>

              <ul
                className="rounded-[14px] border bg-white/85 px-4 py-3 shadow-[0_8px_22px_rgba(15,23,42,0.06)] backdrop-blur"
                style={{ borderColor: SECTION_BORDER }}
              >
                {HELPER_BULLETS.map((line) => (
                  <li
                    key={line}
                    className="mt-1.5 flex items-start gap-2.5 text-[12.5px] leading-[1.55] text-[#0F172A] first:mt-0"
                  >
                    <CheckCircle2
                      size={13}
                      strokeWidth={2.4}
                      className="mt-0.5 shrink-0 text-[#10A37F]"
                    />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function VerifyTokenCard() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);

  const trimmed = useMemo(() => token.trim(), [token]);
  const canSubmit = trimmed.length > 0;
  const showEmptyError = touched && !canSubmit;

  const onSubmit = useCallback(
    (e?: FormEvent) => {
      if (e) e.preventDefault();
      setTouched(true);
      if (!canSubmit) return;
      router.push(`/verify/${encodeURIComponent(trimmed)}`);
    },
    [canSubmit, router, trimmed],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      id="token-card"
      className="overflow-hidden rounded-[20px] border bg-white"
      style={{
        borderColor: "#DDE7F3",
        boxShadow: "0 28px 64px rgba(15, 23, 42, 0.12)",
      }}
    >
      <div className="px-5 pt-5 md:px-6 md:pt-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-10 w-10 items-center justify-center rounded-[12px]"
            style={{
              background: "rgba(37,99,235,0.10)",
              border: "1px solid rgba(37,99,235,0.28)",
            }}
          >
            <ShieldCheck size={18} strokeWidth={2} className="text-[#2563EB]" />
          </span>
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.005em] text-[#07142F]">
              Enter verification token
            </h2>
            <p className="text-[13px] text-[#526176]">
              Paste the token from a PROOVRA report or shared verification record.
            </p>
          </div>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="px-5 pb-5 pt-4 md:px-6 md:pb-6"
        noValidate
      >
        <label
          htmlFor="verification-token"
          className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#475569]"
        >
          Verification token or public verification ID
        </label>
        <input
          id="verification-token"
          data-testid="verification-token-input"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            if (touched) setTouched(false);
          }}
          onBlur={() => setTouched(true)}
          onKeyDown={onKeyDown}
          placeholder="Paste token here"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          inputMode="text"
          spellCheck={false}
          aria-invalid={showEmptyError}
          aria-describedby="verification-token-help"
          className="mt-2 block h-12 w-full rounded-[12px] border bg-white px-4 text-[15px] text-[#0F172A] outline-none transition focus:border-[#2563EB] focus:shadow-[0_0_0_4px_rgba(37,99,235,0.14)]"
          style={{
            borderColor: showEmptyError ? "#DC2626" : "#DDE7F3",
            boxShadow: "0 8px 22px rgba(15,23,42,0.05)",
          }}
        />

        {showEmptyError ? (
          <p
            role="alert"
            className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#B91C1C]"
          >
            <AlertTriangle size={13} strokeWidth={2.4} />
            Enter a verification token to continue.
          </p>
        ) : (
          <p
            id="verification-token-help"
            className="mt-2 text-[12px] leading-[1.55] text-[#526176]"
          >
            This opens a read-only verification view. It does not modify the
            evidence record.
          </p>
        )}

        <button
          type="submit"
          data-testid="verification-submit"
          className="mt-4 inline-flex items-center justify-center gap-2 rounded-[12px] px-5 py-2.5 text-[14px] font-semibold transition"
          style={{
            background: "#07132B",
            color: "#FFFFFF",
            border: "1px solid #07132B",
            boxShadow: "0 12px 28px rgba(7,19,43,0.22)",
          }}
        >
          Open verification
          <ArrowRight size={14} />
        </button>
      </form>
    </div>
  );
}
