"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Input, useToast } from "./ui";
import {
  ORGANIZATION_TYPE_OPTIONS,
  PRIMARY_INTEREST_OPTIONS,
  REQUEST_DEMO_DEFAULT_VALUES,
  TEAM_SIZE_OPTIONS,
  buildRequestDemoPayload,
  type RequestDemoFormValues,
  validateRequestDemoForm,
} from "../lib/request-demo-schema";
import { SALES_ASSETS } from "../lib/sales-assets";
import { EnterpriseSuccessModal } from "./marketing/EnterpriseSuccessModal";

type SelectOption = { value: string; label: string };

export function PremiumSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" && focusIdx >= 0) {
        e.preventDefault();
        onChange(options[focusIdx].value);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, focusIdx, options, onChange]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setFocusIdx(options.findIndex((o) => o.value === value));
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-[12px] border border-[#E2E8F0] bg-white px-3 text-[13.5px] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-all duration-200 hover:border-[#CBD5E1] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/20"
        style={{ minHeight: 40 }}
      >
        <span className={selected ? "text-[#0F172A]" : "text-[#94A3B8]"}>
          {selected ? selected.label : placeholder ?? "Select"}
        </span>
        <ChevronDown
          size={14}
          className={`text-[#64748B] transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-56 overflow-auto rounded-[12px] border border-[#E2E8F0] bg-white p-1 shadow-[0_12px_28px_rgba(15,23,42,0.12)]"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isFocused = i === focusIdx;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setFocusIdx(i)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                className={`cursor-pointer rounded-[8px] px-2.5 py-1.5 text-[13.5px] ${
                  isSelected
                    ? "bg-[#EFF6FF] font-semibold text-[#2563EB]"
                    : isFocused
                      ? "bg-[#F1F5F9] text-[#0F172A]"
                      : "text-[#475569]"
                }`}
              >
                {opt.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type RequestDemoFormProps = {
  submitUrl?: string;
  redirectOnSuccess?: boolean;
  successUrl?: string;
  submitButtonLabel?: string;
  sourcePath?: string;
  onSubmitted?: (result: unknown) => void;
};

export function RequestDemoForm({
  submitUrl = "/api/request-demo",
  redirectOnSuccess = false, // success modal is the default UX now
  successUrl = SALES_ASSETS.requestDemoSuccessUrl,
  submitButtonLabel = "Submit demo request",
  sourcePath = "/request-demo",
  onSubmitted,
}: RequestDemoFormProps) {
  const router = useRouter();
  const { addToast } = useToast();

  const [form, setForm] = useState<RequestDemoFormValues>(
    REQUEST_DEMO_DEFAULT_VALUES
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof RequestDemoFormValues, string>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);

  const teamSizeOptions = [...TEAM_SIZE_OPTIONS];
  const primaryInterestOptions = [...PRIMARY_INTEREST_OPTIONS];
  const organizationTypeOptions = [...ORGANIZATION_TYPE_OPTIONS];

  const isEnterpriseFlow = useMemo(
    () =>
      sourcePath.includes("/contact-sales") ||
      sourcePath.includes("track=enterprise"),
    [sourcePath]
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const nextErrors = validateRequestDemoForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      addToast("Please fix the highlighted fields.", "warning");
      return;
    }

    setIsSubmitting(true);

    try {
      const payload = buildRequestDemoPayload(form, sourcePath);

      const response = await fetch(submitUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const upstreamMessage =
          data?.error?.message || data?.error || data?.message;
        const errorMessage =
          typeof upstreamMessage === "string" && upstreamMessage.trim()
            ? upstreamMessage
            : "We couldn't submit your demo request right now. Please try again or contact support@proovra.com.";

        addToast(errorMessage, "error");
        return;
      }

      setForm(REQUEST_DEMO_DEFAULT_VALUES);
      setErrors({});

      onSubmitted?.(data);

      if (redirectOnSuccess) {
        router.push(successUrl);
        return;
      }

      // Default: show the in-place success modal instead of redirecting.
      setSuccessOpen(true);
    } catch {
      addToast(
        "We couldn't submit your demo request right now. Please try again or contact support@proovra.com.",
        "error"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Full name <span className="text-[#F97316]">*</span>
          </label>
          <Input
            value={form.fullName}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                fullName: value,
              }))
            }
            error={errors.fullName}
            placeholder="Jane Doe"
            className="min-h-[40px]"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Work email <span className="text-[#F97316]">*</span>
          </label>
          <Input
            value={form.workEmail}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                workEmail: value,
              }))
            }
            error={errors.workEmail}
            placeholder="jane@company.com"
            type="email"
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Organization
          </label>
          <Input
            value={form.organization ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                organization: value,
              }))
            }
            placeholder="Company name"
            className="min-h-[40px]"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Job title
          </label>
          <Input
            value={form.jobTitle ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                jobTitle: value,
              }))
            }
            placeholder="Legal Counsel"
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Country
          </label>
          <Input
            value={form.country ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                country: value,
              }))
            }
            placeholder="Germany"
            className="min-h-[40px]"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Team size
          </label>
          <PremiumSelect
            value={form.teamSize ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                teamSize: value,
              }))
            }
            options={teamSizeOptions}
            placeholder="Select team size"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Primary interest <span className="text-[#F97316]">*</span>
          </label>
          <PremiumSelect
            value={form.primaryInterest ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                primaryInterest: value,
              }))
            }
            options={primaryInterestOptions}
            placeholder="What you want to evaluate"
          />
          {errors.primaryInterest ? (
            <div className="input-error">{errors.primaryInterest}</div>
          ) : null}
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Organization type <span className="text-[#F97316]">*</span>
          </label>
          <PremiumSelect
            value={form.organizationType ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                organizationType: value,
              }))
            }
            options={organizationTypeOptions}
            placeholder="Select organization type"
          />
          {errors.organizationType ? (
            <div className="input-error">{errors.organizationType}</div>
          ) : null}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
          Primary use case <span className="text-[#F97316]">*</span>
        </label>
        <textarea
          value={form.useCase}
          onChange={(e) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              useCase: e.target.value,
            }))
          }
          placeholder="Describe your workflow, for example claims review, legal matter review, external evidence intake, compliance investigation, incident response, or public verification."
          className={`input min-h-[96px] w-full resize-y ${
            errors.useCase ? "input-has-error" : ""
          }`}
        />
        {errors.useCase ? (
          <div className="input-error">{errors.useCase}</div>
        ) : null}
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
          Additional context
        </label>
        <textarea
          value={form.message ?? ""}
          onChange={(e) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              message: e.target.value,
            }))
          }
          placeholder="Tell us what you want to evaluate, current challenges, systems involved, review process, governance requirements, or timeline."
          className={`input min-h-[72px] w-full resize-y ${
            errors.message ? "input-has-error" : ""
          }`}
        />
        {errors.message ? (
          <div className="input-error">{errors.message}</div>
        ) : null}
      </div>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          value={form.website ?? ""}
          onChange={(e) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              website: e.target.value,
            }))
          }
          autoComplete="off"
          tabIndex={-1}
        />
      </div>

      <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
          What happens next
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#475569]">
          We review your request, use case, team context, and areas of interest
          so the demo can focus on the workflows that matter most to you.{" "}
          {isEnterpriseFlow
            ? `Complete enterprise inquiries are typically reviewed ${SALES_ASSETS.expectedEnterpriseResponseWindowText}.`
            : `Relevant requests usually receive a reply ${SALES_ASSETS.expectedResponseWindowText}.`}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full bg-gradient-to-r from-[#2563EB] via-[#5B21B6] to-[#EC4899] px-6 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(91,33,182,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(91,33,182,0.40)] disabled:cursor-not-allowed disabled:opacity-70 disabled:transform-none disabled:shadow-none"
        >
          {isSubmitting ? "Submitting..." : submitButtonLabel}
        </button>

        <a
          href={SALES_ASSETS.pricingUrl}
          className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 text-[13.5px] font-semibold text-[#0F172A] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-[#CBD5E1] hover:shadow-[0_8px_18px_rgba(15,23,42,0.06)]"
        >
          View pricing
        </a>
      </div>

      <EnterpriseSuccessModal
        open={successOpen}
        variant="requestDemo"
        onClose={() => setSuccessOpen(false)}
      />
    </form>
  );
}