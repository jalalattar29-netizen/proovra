"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppListbox } from "./app-primitives/AppListbox";
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
import { MARKETING_BTN } from "../lib/marketing-buttons";

type SelectOption = { value: string; label: string };

/**
 * The lead forms' select, now the shared AppListbox (PRO-006).
 *
 * The hand-written menu it replaces listened for keys on the whole DOCUMENT
 * while open, and never closed when focus left: open "Team size", Tab to the
 * next field, press ArrowDown + Enter, and Team size changed while another
 * control had focus. AppListbox reads keys only on its own listbox, closes
 * when focus leaves it, returns focus to its trigger on Tab, and exposes the
 * active option through aria-activedescendant.
 *
 * `labelId` names the control from the visible label above it (PRO-002): the
 * label is a <span> with that id, since a <label> can only name a labelable
 * element and the trigger is a combobox button.
 */
export function PremiumSelect({
  value,
  onChange,
  options,
  placeholder,
  labelId,
  describedBy,
  required = false,
  fieldId,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  labelId: string;
  describedBy?: string;
  required?: boolean;
  /** Base for the error text's id (`<fieldId>-error`); required with `error`. */
  fieldId?: string;
  /** AUD-0059 — the field's error, announced on the trigger and shown below it. */
  error?: string;
}) {
  const errorId = fieldId ? leadErrorId(fieldId) : undefined;
  return (
    <>
      <AppListbox
        value={value || null}
        onChange={onChange}
        options={options}
        placeholder={placeholder ?? "Select"}
        ariaLabelledby={labelId}
        triggerProps={{
          "aria-describedby": joinIds(describedBy, error ? errorId : undefined),
          "aria-required": required || undefined,
          "aria-invalid": error ? true : undefined,
        }}
      />
      <LeadFieldError id={errorId} message={error} />
    </>
  );
}

/*
 * AUD-0059 — lead-form field errors are announced, not only drawn.
 *
 * Before: after an empty submit every field turned red, but no control had
 * aria-invalid or an aria-describedby naming its error, focus stayed on the
 * submit button, and the only announcement was the "Please fix the
 * highlighted fields." toast. Now (the pattern /register uses for its email
 * and password fields): an invalid control carries aria-invalid="true" and
 * aria-describedby naming its `.input-error` text, keeping any hint id first,
 * and a failed submit moves focus to the first invalid control in the form.
 * The shared text Input (ui-legacy) applies the same rule to its own error.
 */

/** The id of a lead-form field's error text. Matches the shared Input's. */
export function leadErrorId(fieldId: string): string {
  return `${fieldId}-error`;
}

function joinIds(...ids: Array<string | undefined>): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

/** A lead-form field's error text, with the id its control describes itself by. */
export function LeadFieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <div id={id} className="input-error">
      {message}
    </div>
  );
}

/** A lead-form textarea whose error is announced (AUD-0059). */
export function LeadTextarea({
  id,
  value,
  onChange,
  error,
  required = false,
  placeholder,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const errorId = leadErrorId(id);
  return (
    <>
      <textarea
        id={id}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`input w-full resize-y ${className ?? ""} ${error ? "input-has-error" : ""}`}
      />
      <LeadFieldError id={errorId} message={error} />
    </>
  );
}

/**
 * Moves focus to the first invalid control of a form after a failed submit.
 * Runs after the render that set aria-invalid, so the control is announced
 * with its error when focus lands on it.
 */
export function useFocusFirstInvalidField() {
  const formRef = useRef<HTMLFormElement>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (request === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [request]);
  const focusFirstInvalid = useCallback(() => setRequest((n) => n + 1), []);
  return { formRef, focusFirstInvalid };
}

/** The label above a lead-form field; `htmlFor` for inputs, `id` for selects. */
export function LeadFieldLabel({
  htmlFor,
  id,
  required = false,
  children,
}: {
  htmlFor?: string;
  id?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  const className = "mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]";
  const mark = required ? (
    <span className="text-[#F97316]" aria-hidden="true">
      {" "}*
    </span>
  ) : null;
  // The marker sits beside the naming element, not in it, so the name is the
  // label's words alone; required-ness is announced by aria-required.
  return (
    <div className={className}>
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id}>
          {children}
        </label>
      ) : (
        <span id={id}>{children}</span>
      )}
      {mark}
    </div>
  );
}

type RequestDemoFormProps = {
  submitUrl?: string;
  submitButtonLabel?: string;
  sourcePath?: string;
  onSubmitted?: (result: unknown) => void;
};

export function RequestDemoForm({
  submitUrl = "/api/request-demo",
  submitButtonLabel = "Submit demo request",
  sourcePath = "/request-demo",
  onSubmitted,
}: RequestDemoFormProps) {
  const { addToast } = useToast();

  const [form, setForm] = useState<RequestDemoFormValues>(
    REQUEST_DEMO_DEFAULT_VALUES
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof RequestDemoFormValues, string>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const { formRef, focusFirstInvalid } = useFocusFirstInvalidField();

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
      focusFirstInvalid();
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
        // Never surface the raw upstream message — always a safe, friendly line.
        addToast(
          "We couldn't submit your demo request right now. Please try again, or email support@proovra.com.",
          "error",
        );
        return;
      }

      setForm(REQUEST_DEMO_DEFAULT_VALUES);
      setErrors({});

      onSubmitted?.(data);

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
    <form ref={formRef} onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="rd-fullName" required>Full name</LeadFieldLabel>
          <Input
            id="rd-fullName"
            aria-required="true"
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
          <LeadFieldLabel htmlFor="rd-workEmail" required>Work email</LeadFieldLabel>
          <Input
            id="rd-workEmail"
            aria-required="true"
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
          <LeadFieldLabel htmlFor="rd-organization">Organization</LeadFieldLabel>
          <Input
            id="rd-organization"
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
          <LeadFieldLabel htmlFor="rd-jobTitle">Job title</LeadFieldLabel>
          <Input
            id="rd-jobTitle"
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
          <LeadFieldLabel htmlFor="rd-country">Country</LeadFieldLabel>
          <Input
            id="rd-country"
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
          <LeadFieldLabel id="rd-teamSize-label">
            Team size
          </LeadFieldLabel>
          <PremiumSelect
            labelId="rd-teamSize-label"
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
          <LeadFieldLabel id="rd-primaryInterest-label" required>Primary interest</LeadFieldLabel>
          <PremiumSelect
            labelId="rd-primaryInterest-label"
            required
            value={form.primaryInterest ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                primaryInterest: value,
              }))
            }
            options={primaryInterestOptions}
            placeholder="What you want to evaluate"
            fieldId="rd-primaryInterest"
            error={errors.primaryInterest}
          />
        </div>

        <div>
          <LeadFieldLabel id="rd-organizationType-label" required>Organization type</LeadFieldLabel>
          <PremiumSelect
            labelId="rd-organizationType-label"
            required
            value={form.organizationType ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                organizationType: value,
              }))
            }
            options={organizationTypeOptions}
            placeholder="Select organization type"
            fieldId="rd-organizationType"
            error={errors.organizationType}
          />
        </div>
      </div>

      <div>
        <LeadFieldLabel htmlFor="rd-useCase" required>Primary use case</LeadFieldLabel>
        <LeadTextarea
          id="rd-useCase"
          required
          value={form.useCase}
          onChange={(value) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              useCase: value,
            }))
          }
          error={errors.useCase}
          placeholder="Describe your workflow, for example claims review, legal matter review, external evidence intake, compliance investigation, incident response, or public verification."
          className="min-h-[96px]"
        />
      </div>

      <div>
        <LeadFieldLabel htmlFor="rd-message">Additional context</LeadFieldLabel>
        <LeadTextarea
          id="rd-message"
          value={form.message ?? ""}
          onChange={(value) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              message: value,
            }))
          }
          error={errors.message}
          placeholder="Tell us what you want to evaluate, current challenges, systems involved, review process, governance requirements, or timeline."
          className="min-h-[72px]"
        />
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
          className={MARKETING_BTN.purpleSecondary}
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