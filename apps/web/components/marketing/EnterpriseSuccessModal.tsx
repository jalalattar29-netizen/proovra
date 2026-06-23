"use client";

// Enterprise success modal shared by the two public marketing
// lead-capture forms (Request Demo, Contact Sales).
//
// Design intent: enterprise legal-tech / governance — Relativity,
// Everlaw, Datadog, Vanta, Drata, Stripe Enterprise, Notion Enterprise.
// Not consumer SaaS, not crypto, not AI landing-page.
//
// Hierarchy (top to bottom):
//   1. Check affordance (small, single accent)
//   2. Eyebrow "REQUEST RECEIVED"
//   3. Title
//   4. Calm one-line explanation
//   5. Information panel (Response time / Status / Next step)
//   6. Primary CTA — medium navy, NOT a gradient
//   7. Secondary text links — NOT buttons
//
// Accessibility:
//   - role="dialog" + aria-modal="true" + labelled-by/described-by
//   - focus trap with restore-on-close
//   - ESC + backdrop click + close button
//   - body scroll locked while open
//   - prefers-reduced-motion respected (no scale/fade)
//   - polite live-region announcement on open

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { SALES_ASSETS } from "../../lib/sales-assets";

export type EnterpriseSuccessVariant = "requestDemo" | "contactSales";

type CopySet = {
  eyebrow: string;
  title: string;
  body: string;
  info: {
    responseTime: string;
    status: string;
    nextStep: string;
  };
  primary: { label: string; href: string; external: boolean };
  secondaryLink: { label: string; href: string };
};

const COPY: Record<EnterpriseSuccessVariant, CopySet> = {
  requestDemo: {
    eyebrow: "Request received",
    title: "Request received",
    body: "Your request has been securely received and routed to the appropriate PROOVRA team.",
    info: {
      responseTime: "Within 1 business day",
      status: "Received",
      nextStep: "Workspace review",
    },
    primary: {
      label: "View sample report",
      href: SALES_ASSETS.sampleReportUrl,
      external: true,
    },
    secondaryLink: {
      label: "Open verification demo",
      href: SALES_ASSETS.verificationDemoUrl,
    },
  },
  contactSales: {
    eyebrow: "Request received",
    title: "Contact request received",
    body: "Your inquiry has been securely received and routed to the PROOVRA enterprise team.",
    info: {
      responseTime: "Within 1 business day",
      status: "Received",
      nextStep: "Workspace review",
    },
    primary: {
      label: "View sample report",
      href: SALES_ASSETS.sampleReportUrl,
      external: true,
    },
    secondaryLink: {
      label: "Open verification demo",
      href: SALES_ASSETS.verificationDemoUrl,
    },
  },
};

function getFocusables(container: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.hasAttribute("data-no-focus") && el.offsetParent !== null
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function EnterpriseSuccessModal({
  open,
  variant,
  onClose,
}: {
  open: boolean;
  variant: EnterpriseSuccessVariant;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(false);

  // Remember the element focused before open; restore on close.
  useEffect(() => {
    if (open) {
      triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    } else if (
      triggerRef.current &&
      typeof triggerRef.current.focus === "function"
    ) {
      triggerRef.current.focus();
    }
  }, [open]);

  // Drive enter animation on the next frame so the initial paint shows
  // the from-state. Skipped when prefers-reduced-motion is on.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    if (prefersReducedMotion) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, prefersReducedMotion]);

  // Body scroll lock + ESC + tab trap + initial focus.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = getFocusables(dialogRef.current);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const onBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  const copy = COPY[variant];

  const motionStyle: React.CSSProperties = prefersReducedMotion
    ? { opacity: 1, transform: "none" }
    : {
        opacity: entered ? 1 : 0,
        transform: entered ? "scale(1)" : "scale(0.98)",
        transition:
          "opacity 180ms ease-out, transform 180ms ease-out",
      };

  const backdropStyle: React.CSSProperties = prefersReducedMotion
    ? { opacity: 1 }
    : {
        opacity: entered ? 1 : 0,
        transition: "opacity 220ms ease-out",
      };

  const checkStyle: React.CSSProperties = prefersReducedMotion
    ? { opacity: 1, transform: "none" }
    : {
        opacity: entered ? 1 : 0,
        transform: entered ? "scale(1)" : "scale(0.6)",
        transition:
          "opacity 320ms ease-out 80ms, transform 320ms ease-out 80ms",
      };

  return (
    <div
      aria-hidden={false}
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-8"
      onClick={onBackdrop}
    >
      {/* Backdrop — calm ink wash, light blur. No purple/cyan glow. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: "rgba(15,23,42,0.50)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          ...backdropStyle,
        }}
      />

      {/* Dialog — pure white paper, single hairline border, square corners. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enterprise-success-title"
        aria-describedby="enterprise-success-body"
        className="relative w-full max-w-[480px] rounded-[14px] border border-[#E2E8F0] bg-white p-7 shadow-[0_24px_64px_rgba(15,23,42,0.18)] md:p-8"
        style={motionStyle}
      >
        {/* Polite live-region for screen readers — announces title once
            the dialog is mounted. */}
        <div
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {copy.title}. {copy.body}
        </div>

        {/* Close — neutral, small, top-right. */}
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close confirmation"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-[#64748B] transition hover:bg-[#F1F5F9] hover:text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#1E293B]/20"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* ─── 1 + 2: Check + Eyebrow ─────────────────────────────── */}
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#D1FAE5] bg-[#ECFDF5] text-[#059669]"
            style={checkStyle}
          >
            <Check size={16} strokeWidth={2.5} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#475569]">
            {copy.eyebrow}
          </span>
        </div>

        {/* ─── 3: Title ─────────────────────────────────────────────── */}
        <h2
          id="enterprise-success-title"
          className="mt-5 text-[22px] font-semibold leading-[1.25] tracking-[-0.01em] text-[#0F172A]"
        >
          {copy.title}
        </h2>

        {/* ─── 4: Body ──────────────────────────────────────────────── */}
        <p
          id="enterprise-success-body"
          className="mt-2.5 text-[14px] leading-[1.6] text-[#475569]"
        >
          {copy.body}
        </p>

        {/* ─── 5: Information panel ─────────────────────────────────── */}
        <dl
          className="mt-6 overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC]"
          aria-label="Request details"
        >
          <InfoRow label="Response time" value={copy.info.responseTime} />
          <div className="h-px bg-[#EEF2F6]" aria-hidden="true" />
          <InfoRow
            label="Request status"
            value={copy.info.status}
            withDot
          />
          <div className="h-px bg-[#EEF2F6]" aria-hidden="true" />
          <InfoRow label="Next step" value={copy.info.nextStep} />
        </dl>

        {/* ─── 6: Primary CTA — medium navy, NOT gradient ───────────── */}
        <div className="mt-6">
          {copy.primary.external ? (
            <a
              href={copy.primary.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex h-[42px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#0F172A] px-5 text-[13.5px] font-semibold text-white transition-colors duration-150 hover:bg-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#1E293B]/30 focus:ring-offset-2"
            >
              {copy.primary.label}
              <ArrowRight
                size={14}
                className="transition-transform duration-150 group-hover:translate-x-0.5"
              />
            </a>
          ) : (
            <Link
              href={copy.primary.href}
              onClick={onClose}
              className="group inline-flex h-[42px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#0F172A] px-5 text-[13.5px] font-semibold text-white transition-colors duration-150 hover:bg-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#1E293B]/30 focus:ring-offset-2"
            >
              {copy.primary.label}
              <ArrowRight
                size={14}
                className="transition-transform duration-150 group-hover:translate-x-0.5"
              />
            </Link>
          )}
        </div>

        {/* ─── 7: Secondary text links — NOT buttons ────────────────── */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px]">
          <Link
            href={copy.secondaryLink.href}
            onClick={onClose}
            className="inline-flex items-center gap-1 font-medium text-[#1E293B] underline-offset-4 transition-colors hover:text-[#0F172A] hover:underline focus:outline-none focus:underline"
          >
            {copy.secondaryLink.label}
            <span aria-hidden="true">→</span>
          </Link>
          <span
            aria-hidden="true"
            className="h-1 w-1 rounded-full bg-[#CBD5E1]"
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 font-medium text-[#475569] underline-offset-4 transition-colors hover:text-[#0F172A] hover:underline focus:outline-none focus:underline"
          >
            Continue browsing
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  withDot = false,
}: {
  label: string;
  value: string;
  withDot?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.10em] text-[#64748B]">
        {label}
      </dt>
      <dd className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[#0F172A]">
        {withDot && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-[#2563EB]"
          />
        )}
        {value}
      </dd>
    </div>
  );
}
