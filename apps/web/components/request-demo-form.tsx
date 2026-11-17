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
import { fillCopy } from "@proovra/shared/i18n";
import { useT, type TranslationKey } from "../app/providers";

/**
 * B2A-F-12 — the option LABELS in the reader's language. The values the form
 * sends are unchanged.
 */
const INTEREST_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  "full-platform": "leadInterestFullPlatform",
  "capture-intake": "leadInterestCaptureIntake",
  verification: "leadInterestVerification",
  "reports-packages": "leadInterestReportsPackages",
  "cases-reviewers": "leadInterestCasesReviewers",
  governance: "leadInterestGovernance",
  "ai-assistant": "leadInterestAiAssistant",
  "integrations-apis": "leadInterestIntegrations",
  "security-trust": "leadInterestSecurityTrust",
  other: "leadOptionOther",
};
const ORG_TYPE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  insurance: "leadOrgInsurance",
  legal: "leadOrgLegal",
  "corporate-investigations": "leadOrgInvestigations",
  government: "leadOrgGovernment",
  compliance: "leadOrgCompliance",
  journalism: "leadOrgJournalism",
  "enterprise-security": "leadOrgEnterpriseSecurity",
  other: "leadOptionOther",
};

/** The schema's English validation messages (lib/request-demo-schema.ts), in the reader's language. */
const REQUEST_DEMO_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  "Full name is required.": "leadErrorFullNameRequired",
  "Enter a valid email address.": "leadErrorEmailInvalid",
  "Select a primary interest.": "leadErrorInterestRequired",
  "Select an organization type.": "leadErrorOrgTypeRequired",
  "Please provide a bit more detail.": "leadErrorUseCaseDetail",
};

/**
 * The reply window in the reader's language when it is the one this dictionary
 * knows; any other configured text is shown as configured.
 */
const RESPONSE_WINDOW_KEYS: Readonly<Record<string, TranslationKey>> = {
  "within 1 business day": "leadResponseWindowStandard",
  "within 4 business hours": "leadResponseWindowEnterprise",
};

const SUPPORT_EMAIL = "support@proovra.com";

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
  const t = useT();
  return (
    <>
      <AppListbox
        value={value || null}
        onChange={onChange}
        options={options}
        placeholder={placeholder ?? t("leadSelectPlaceholder")}
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
  /** The dictionary key of the submit label when no explicit label is passed (B2A-F-12). */
  submitLabelKey?: "leadDemoSubmit" | "leadDemoRequestSubmit";
  sourcePath?: string;
  onSubmitted?: (result: unknown) => void;
};

export function RequestDemoForm({
  submitUrl = "/api/request-demo",
  submitButtonLabel,
  submitLabelKey = "leadDemoSubmit",
  sourcePath = "/request-demo",
  onSubmitted,
}: RequestDemoFormProps) {
  const { addToast } = useToast();
  const t = useT();
  const errorText = (message: string | undefined) =>
    message && REQUEST_DEMO_ERROR_KEYS[message] ? t(REQUEST_DEMO_ERROR_KEYS[message]) : message;
  const responseWindow = (text: string) =>
    RESPONSE_WINDOW_KEYS[text] ? t(RESPONSE_WINDOW_KEYS[text]) : text;

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
  const primaryInterestOptions = PRIMARY_INTEREST_OPTIONS.map((o) => ({
    value: o.value,
    label: INTEREST_LABEL_KEYS[o.value] ? t(INTEREST_LABEL_KEYS[o.value]) : o.label,
  }));
  const organizationTypeOptions = ORGANIZATION_TYPE_OPTIONS.map((o) => ({
    value: o.value,
    label: ORG_TYPE_LABEL_KEYS[o.value] ? t(ORG_TYPE_LABEL_KEYS[o.value]) : o.label,
  }));

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
      addToast(t("leadFixFields"), "warning");
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
        addToast(fillCopy(t("leadDemoSubmitFailed"), { email: SUPPORT_EMAIL }), "error");
        return;
      }

      setForm(REQUEST_DEMO_DEFAULT_VALUES);
      setErrors({});

      onSubmitted?.(data);

      setSuccessOpen(true);
    } catch {
      addToast(fillCopy(t("leadDemoSubmitFailed"), { email: SUPPORT_EMAIL }), "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="rd-fullName" required>{t("leadFullName")}</LeadFieldLabel>
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
            error={errorText(errors.fullName)}
            placeholder={t("leadFullNamePlaceholder")}
            className="min-h-[40px]"
          />
        </div>

        <div>
          <LeadFieldLabel htmlFor="rd-workEmail" required>{t("leadWorkEmail")}</LeadFieldLabel>
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
            error={errorText(errors.workEmail)}
            placeholder="jane@company.com"
            type="email"
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="rd-organization">{t("leadOrganization")}</LeadFieldLabel>
          <Input
            id="rd-organization"
            value={form.organization ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                organization: value,
              }))
            }
            placeholder={t("leadCompanyPlaceholder")}
            className="min-h-[40px]"
          />
        </div>

        <div>
          <LeadFieldLabel htmlFor="rd-jobTitle">{t("leadJobTitle")}</LeadFieldLabel>
          <Input
            id="rd-jobTitle"
            value={form.jobTitle ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                jobTitle: value,
              }))
            }
            placeholder={t("leadDemoJobTitlePlaceholder")}
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="rd-country">{t("leadCountry")}</LeadFieldLabel>
          <Input
            id="rd-country"
            value={form.country ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                country: value,
              }))
            }
            placeholder={t("leadCountryPlaceholder")}
            className="min-h-[40px]"
          />
        </div>

        <div>
          <LeadFieldLabel id="rd-teamSize-label">
            {t("leadTeamSize")}
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
            placeholder={t("leadTeamSizePlaceholder")}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel id="rd-primaryInterest-label" required>{t("leadDemoInterest")}</LeadFieldLabel>
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
            placeholder={t("leadDemoInterestPlaceholder")}
            fieldId="rd-primaryInterest"
            error={errorText(errors.primaryInterest)}
          />
        </div>

        <div>
          <LeadFieldLabel id="rd-organizationType-label" required>{t("leadDemoOrgType")}</LeadFieldLabel>
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
            placeholder={t("leadDemoOrgTypePlaceholder")}
            fieldId="rd-organizationType"
            error={errorText(errors.organizationType)}
          />
        </div>
      </div>

      <div>
        <LeadFieldLabel htmlFor="rd-useCase" required>{t("leadDemoUseCase")}</LeadFieldLabel>
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
          error={errorText(errors.useCase)}
          placeholder={t("leadDemoUseCasePlaceholder")}
          className="min-h-[96px]"
        />
      </div>

      <div>
        <LeadFieldLabel htmlFor="rd-message">{t("leadDemoContext")}</LeadFieldLabel>
        <LeadTextarea
          id="rd-message"
          value={form.message ?? ""}
          onChange={(value) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              message: value,
            }))
          }
          error={errorText(errors.message)}
          placeholder={t("leadDemoContextPlaceholder")}
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
          {t("leadWhatHappensNext")}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#475569]">
          {t("leadDemoNextBody")}{" "}
          {isEnterpriseFlow
            ? fillCopy(t("leadDemoNextEnterprise"), {
                window: responseWindow(SALES_ASSETS.expectedEnterpriseResponseWindowText),
              })
            : fillCopy(t("leadDemoNextStandard"), {
                window: responseWindow(SALES_ASSETS.expectedResponseWindowText),
              })}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full bg-gradient-to-r from-[#2563EB] via-[#5B21B6] to-[#EC4899] px-6 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(91,33,182,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(91,33,182,0.40)] disabled:cursor-not-allowed disabled:opacity-70 disabled:transform-none disabled:shadow-none"
        >
          {isSubmitting ? t("leadSubmitting") : submitButtonLabel ?? t(submitLabelKey)}
        </button>

        <a
          href={SALES_ASSETS.pricingUrl}
          className={MARKETING_BTN.purpleSecondary}
        >
          {t("leadDemoViewPricing")}
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