"use client";

// Shared enterprise success modal for marketing lead-capture forms.
//
// Two variants — "requestDemo" and "contactSales" — but a single
// implementation so the design language and accessibility wiring stay
// consistent. Replaces the previous full-page redirect to
// /request-demo/success. The visitor stays on the page they submitted
// from; the modal is the success affordance.
//
// Accessibility:
//   - role="dialog" + aria-modal="true" + labelled-by/described-by
//   - focus trap restores focus to the trigger on close
//   - ESC + backdrop click close (plus explicit close button)
//   - body scroll locked while open
//   - reduced-motion respected (no animation if user prefers)

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { SALES_ASSETS } from "../../lib/sales-assets";

type Variant = "requestDemo" | "contactSales";

const COPY = {
  requestDemo: {
    eyebrow: "Request submitted",
    title: "Request submitted",
    body: "Thank you for your interest in PROOVRA. Your request has been received and will be reviewed by the appropriate team. If your workflow is a good fit for a live walkthrough, we will contact you shortly.",
    primary: { label: "View Sample Report", href: SALES_ASSETS.sampleReportUrl, external: true },
    secondary: { label: "Open Verification Demo", href: SALES_ASSETS.verificationDemoUrl, external: false },
    tertiary: { label: "Continue Browsing", action: "close" as const },
  },
  contactSales: {
    eyebrow: "Message received",
    title: "Message received",
    body: "Your inquiry has been submitted successfully. A member of the PROOVRA team will review your request and respond as soon as possible.",
    primary: { label: "View Platform Overview", href: "/platform", external: false },
    secondary: { label: "Open Verification Demo", href: SALES_ASSETS.verificationDemoUrl, external: false },
    tertiary: { label: "Continue Browsing", action: "close" as const },
  },
} as const;

function getFocusables(container: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.hasAttribute("data-no-focus") && el.offsetParent !== null
  );
}

export function LeadSuccessModal({
  open,
  variant,
  onClose,
}: {
  open: boolean;
  variant: Variant;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Remember the element that had focus before opening so we can
  // restore focus there on close.
  useEffect(() => {
    if (open) {
      triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    } else if (triggerRef.current && typeof triggerRef.current.focus === "function") {
      triggerRef.current.focus();
    }
  }, [open]);

  // Body scroll lock + ESC handler + initial focus.
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

    // Focus the close button shortly after open so screen readers
    // announce the dialog title (which sits above it).
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

  return (
    <div
      aria-hidden={false}
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-8"
      onClick={onBackdrop}
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(8,12,28,0.55) 0%, rgba(8,12,28,0.68) 100%)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-success-title"
        aria-describedby="lead-success-body"
        className="relative w-full max-w-[520px] rounded-[22px] border border-white/40 bg-white/95 p-7 shadow-[0_30px_80px_rgba(15,23,42,0.35)] backdrop-blur-xl md:p-9"
        style={{
          backgroundImage:
            "radial-gradient(circle at 12% 0%, rgba(122,60,255,0.07), transparent 45%), radial-gradient(circle at 92% 100%, rgba(0,212,255,0.07), transparent 45%)",
        }}
      >
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close success message"
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-[#E2E8F0] bg-white text-[#475569] transition hover:bg-[#F8FAFC] hover:text-[#0F172A]"
        >
          <X size={16} />
        </button>

        <div className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-[#F8FAFC] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
          {copy.eyebrow}
        </div>

        <h2
          id="lead-success-title"
          className="mt-5 text-[1.5rem] font-semibold leading-[1.2] tracking-[-0.02em] text-[#0F172A] md:text-[1.7rem]"
        >
          {copy.title}
        </h2>

        <p
          id="lead-success-body"
          className="mt-3 text-[14.5px] leading-[1.7] text-[#475569]"
        >
          {copy.body}
        </p>

        <div className="mt-7 flex flex-col gap-3">
          {copy.primary.external ? (
            <a
              href={copy.primary.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full px-6 py-3 text-[14px] font-semibold text-white shadow-[0_18px_38px_rgba(232,63,174,0.32)] transition duration-300 hover:translate-y-[-1px] hover:brightness-110"
              style={{
                background:
                  "linear-gradient(120deg,#E83FAE 0%,#6D28D9 100%)",
              }}
            >
              {copy.primary.label}
              <ArrowRight size={15} />
            </a>
          ) : (
            <Link
              href={copy.primary.href}
              onClick={onClose}
              className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full px-6 py-3 text-[14px] font-semibold text-white shadow-[0_18px_38px_rgba(232,63,174,0.32)] transition duration-300 hover:translate-y-[-1px] hover:brightness-110"
              style={{
                background:
                  "linear-gradient(120deg,#E83FAE 0%,#6D28D9 100%)",
              }}
            >
              {copy.primary.label}
              <ArrowRight size={15} />
            </Link>
          )}

          <Link
            href={copy.secondary.href}
            onClick={onClose}
            className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-6 py-3 text-[14px] font-semibold text-[#5B21B6] transition duration-300 hover:bg-[#F5F3FF] hover:translate-y-[-1px]"
          >
            <Sparkles size={14} />
            {copy.secondary.label}
          </Link>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[42px] items-center justify-center rounded-full px-6 py-2 text-[13px] font-medium text-[#475569] transition hover:text-[#0F172A]"
          >
            {copy.tertiary.label}
          </button>
        </div>
      </div>
    </div>
  );
}
