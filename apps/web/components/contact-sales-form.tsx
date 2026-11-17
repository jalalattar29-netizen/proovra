"use client";

import { useState } from "react";
import { Input, useToast } from "./ui";
import {
  LeadFieldLabel,
  LeadTextarea,
  PremiumSelect,
  useFocusFirstInvalidField,
} from "./request-demo-form";
import {
  CONTACT_SALES_DEFAULTS,
  CONTACT_SALES_TEAM_SIZE_OPTIONS,
  DEPLOYMENT_TIMELINE_OPTIONS,
  DISCUSSION_TOPIC_OPTIONS,
  ESTIMATED_USERS_OPTIONS,
  STAGE_OPTIONS,
  buildContactSalesPayload,
  type ContactSalesFormValues,
  validateContactSalesForm,
} from "../lib/contact-sales-schema";
import { SALES_ASSETS } from "../lib/sales-assets";
import { fillCopy } from "@proovra/shared/i18n";
import { useT, type TranslationKey } from "../app/providers";
import { EnterpriseSuccessModal } from "./marketing/EnterpriseSuccessModal";

/**
 * B2A-F-12 — the option LABELS in the reader's language. The values the form
 * sends (and the English labels the payload builder writes) are unchanged.
 */
const OPTION_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  "enterprise-pricing": "leadTopicEnterprisePricing",
  "team-rollout": "leadTopicTeamRollout",
  "procurement-review": "leadTopicProcurementReview",
  "security-review": "leadTopicSecurityReview",
  "governance-review": "leadTopicGovernanceReview",
  "data-retention": "leadTopicDataRetention",
  "legal-hold": "leadTopicLegalHold",
  "integrations-apis": "leadTopicIntegrationsApis",
  "multi-team-deployment": "leadTopicMultiTeam",
  "partner-inquiry": "leadTopicPartner",
  other: "leadOptionOther",
};
const STAGE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  exploring: "leadStageExploring",
  comparing: "leadStageComparing",
  "internal-review": "leadStageInternalReview",
  "procurement-review": "leadStageProcurementReview",
  "security-review": "leadStageSecurityReview",
  "ready-to-deploy": "leadStageReadyToDeploy",
};
const TIMELINE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  "this-month": "leadTimelineThisMonth",
  "1-3-months": "leadTimeline1to3",
  "3-6-months": "leadTimeline3to6",
  "6plus-months": "leadTimeline6plus",
  planning: "leadTimelinePlanning",
};

/** The schema's English validation messages (lib/contact-sales-schema.ts), in the reader's language. */
const CONTACT_SALES_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  "Full name is required.": "leadErrorFullNameRequired",
  "Enter a valid email address.": "leadErrorEmailInvalid",
  "Organization is required.": "leadErrorOrganizationRequired",
  "Select your current stage.": "leadErrorStageRequired",
  "Please describe your challenge in a bit more detail.": "leadErrorChallengeDetail",
};

function translatedOptions(
  options: ReadonlyArray<{ value: string; label: string }>,
  keys: Readonly<Record<string, TranslationKey>>,
  t: (key: TranslationKey) => string,
) {
  return options.map((o) => ({ value: o.value, label: keys[o.value] ? t(keys[o.value]) : o.label }));
}

const SUPPORT_EMAIL = "support@proovra.com";

type ContactSalesFormProps = {
  submitUrl?: string;
  submitButtonLabel?: string;
  onSubmitted?: (result: unknown) => void;
};

export function ContactSalesForm({
  submitUrl = "/api/contact-sales",
  submitButtonLabel,
  onSubmitted,
}: ContactSalesFormProps) {
  const { addToast } = useToast();
  const t = useT();
  const errorText = (message: string | undefined) =>
    message && CONTACT_SALES_ERROR_KEYS[message] ? t(CONTACT_SALES_ERROR_KEYS[message]) : message;

  const [form, setForm] = useState<ContactSalesFormValues>(
    CONTACT_SALES_DEFAULTS
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof ContactSalesFormValues, string>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const { formRef, focusFirstInvalid } = useFocusFirstInvalidField();

  const teamSizeOptions = [...CONTACT_SALES_TEAM_SIZE_OPTIONS];
  const topicOptions = translatedOptions(DISCUSSION_TOPIC_OPTIONS, OPTION_LABEL_KEYS, t);
  const stageOptions = translatedOptions(STAGE_OPTIONS, STAGE_LABEL_KEYS, t);
  const timelineOptions = translatedOptions(DEPLOYMENT_TIMELINE_OPTIONS, TIMELINE_LABEL_KEYS, t);
  const usersOptions = [...ESTIMATED_USERS_OPTIONS];

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const nextErrors = validateContactSalesForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      addToast(t("leadFixFields"), "warning");
      focusFirstInvalid();
      return;
    }

    setIsSubmitting(true);

    try {
      const payload = buildContactSalesPayload(form);

      const response = await fetch(submitUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        // Never surface the raw upstream message — always a safe, friendly line.
        addToast(fillCopy(t("leadSalesSubmitFailed"), { email: SUPPORT_EMAIL }), "error");
        return;
      }

      setForm(CONTACT_SALES_DEFAULTS);
      setErrors({});

      onSubmitted?.(data);

      setSuccessOpen(true);
    } catch {
      addToast(fillCopy(t("leadSalesSubmitFailed"), { email: SUPPORT_EMAIL }), "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  function set<K extends keyof ContactSalesFormValues>(
    key: K,
    value: ContactSalesFormValues[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="cs-fullName" required>{t("leadFullName")}</LeadFieldLabel>
          <Input
            id="cs-fullName"
            aria-required="true"
            value={form.fullName}
            onChange={(v) => set("fullName", v)}
            error={errorText(errors.fullName)}
            placeholder={t("leadFullNamePlaceholder")}
            className="min-h-[40px]"
          />
        </div>
        <div>
          <LeadFieldLabel htmlFor="cs-workEmail" required>{t("leadWorkEmail")}</LeadFieldLabel>
          <Input
            id="cs-workEmail"
            aria-required="true"
            value={form.workEmail}
            onChange={(v) => set("workEmail", v)}
            error={errorText(errors.workEmail)}
            placeholder="jane@company.com"
            type="email"
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="cs-organization" required>{t("leadOrganization")}</LeadFieldLabel>
          <Input
            id="cs-organization"
            aria-required="true"
            value={form.organization ?? ""}
            onChange={(v) => set("organization", v)}
            error={errorText(errors.organization)}
            placeholder={t("leadCompanyPlaceholder")}
            className="min-h-[40px]"
          />
        </div>
        <div>
          <LeadFieldLabel htmlFor="cs-jobTitle">{t("leadJobTitle")}</LeadFieldLabel>
          <Input
            id="cs-jobTitle"
            value={form.jobTitle ?? ""}
            onChange={(v) => set("jobTitle", v)}
            placeholder={t("leadSalesJobTitlePlaceholder")}
            className="min-h-[40px]"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel htmlFor="cs-country">{t("leadCountry")}</LeadFieldLabel>
          <Input
            id="cs-country"
            value={form.country ?? ""}
            onChange={(v) => set("country", v)}
            placeholder={t("leadCountryPlaceholder")}
            className="min-h-[40px]"
          />
        </div>
        <div>
          <LeadFieldLabel id="cs-teamSize-label">
            {t("leadTeamSize")}
          </LeadFieldLabel>
          <PremiumSelect
            labelId="cs-teamSize-label"
            value={form.teamSize ?? ""}
            onChange={(v) => set("teamSize", v)}
            options={teamSizeOptions}
            placeholder={t("leadTeamSizePlaceholder")}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel id="cs-discussionTopic-label" required>{t("leadSalesTopic")}</LeadFieldLabel>
          <PremiumSelect
            labelId="cs-discussionTopic-label"
            required
            value={form.discussionTopic ?? ""}
            onChange={(v) => set("discussionTopic", v)}
            options={topicOptions}
            placeholder={t("leadSalesTopicPlaceholder")}
            fieldId="cs-discussionTopic"
            error={errors.discussionTopic ? t("leadSalesTopicRequired") : undefined}
          />
        </div>
        <div>
          <LeadFieldLabel id="cs-stage-label" required>{t("leadSalesStage")}</LeadFieldLabel>
          <PremiumSelect
            labelId="cs-stage-label"
            required
            value={form.stage ?? ""}
            onChange={(v) => set("stage", v)}
            options={stageOptions}
            placeholder={t("leadSalesStagePlaceholder")}
            fieldId="cs-stage"
            error={errorText(errors.stage)}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <LeadFieldLabel id="cs-deploymentTimeline-label">{t("leadSalesTimeline")}</LeadFieldLabel>
          <PremiumSelect
            labelId="cs-deploymentTimeline-label"
            value={form.deploymentTimeline ?? ""}
            onChange={(v) => set("deploymentTimeline", v)}
            options={timelineOptions}
            placeholder={t("leadSalesTimelinePlaceholder")}
          />
        </div>
        <div>
          <LeadFieldLabel id="cs-estimatedUsers-label">{t("leadSalesUsers")}</LeadFieldLabel>
          <PremiumSelect
            labelId="cs-estimatedUsers-label"
            value={form.estimatedUsers ?? ""}
            onChange={(v) => set("estimatedUsers", v)}
            options={usersOptions}
            placeholder={t("leadSalesUsersPlaceholder")}
          />
        </div>
      </div>

      <div>
        <LeadFieldLabel htmlFor="cs-currentChallenge" required>{t("leadSalesChallenge")}</LeadFieldLabel>
        <LeadTextarea
          id="cs-currentChallenge"
          required
          value={form.currentChallenge}
          onChange={(v) => set("currentChallenge", v)}
          error={errorText(errors.currentChallenge)}
          placeholder={t("leadSalesChallengePlaceholder")}
          className="min-h-[110px]"
        />
      </div>

      <div>
        <LeadFieldLabel htmlFor="cs-additionalDetails">{t("leadSalesNotes")}</LeadFieldLabel>
        <LeadTextarea
          id="cs-additionalDetails"
          value={form.additionalDetails ?? ""}
          onChange={(v) => set("additionalDetails", v)}
          error={errorText(errors.additionalDetails)}
          placeholder={t("leadSalesNotesPlaceholder")}
          className="min-h-[80px]"
        />
      </div>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="cs-website">Website</label>
        <input
          id="cs-website"
          name="website"
          type="text"
          value={form.website ?? ""}
          onChange={(e) => set("website", e.target.value)}
          autoComplete="off"
          tabIndex={-1}
        />
      </div>

      <div className="rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
          {t("leadWhatHappensNext")}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#475569]">
          {t("leadSalesNextBody")}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full bg-[#0F172A] px-6 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(15,23,42,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(15,23,42,0.30)] disabled:cursor-not-allowed disabled:opacity-70 disabled:transform-none disabled:shadow-none"
        >
          {isSubmitting ? t("leadSubmitting") : submitButtonLabel ?? t("leadSalesSubmit")}
        </button>

        <a
          href={SALES_ASSETS.requestDemoUrl}
          className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 text-[13.5px] font-semibold text-[#0F172A] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-[#CBD5E1] hover:shadow-[0_8px_18px_rgba(15,23,42,0.06)]"
        >
          {t("leadSalesRequestDemo")}
        </a>
      </div>

      <EnterpriseSuccessModal
        open={successOpen}
        variant="contactSales"
        onClose={() => setSuccessOpen(false)}
      />
    </form>
  );
}
