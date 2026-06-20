"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, useToast } from "./ui";
import { PremiumSelect } from "./request-demo-form";
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
import { LeadSuccessModal } from "./marketing/LeadSuccessModal";

type ContactSalesFormProps = {
  submitUrl?: string;
  redirectOnSuccess?: boolean;
  successUrl?: string;
  submitButtonLabel?: string;
  onSubmitted?: (result: unknown) => void;
};

export function ContactSalesForm({
  submitUrl = "/api/contact-sales",
  redirectOnSuccess = false, // success modal is the default UX now
  successUrl = SALES_ASSETS.requestDemoSuccessUrl,
  submitButtonLabel = "Contact sales",
  onSubmitted,
}: ContactSalesFormProps) {
  const router = useRouter();
  const { addToast } = useToast();

  const [form, setForm] = useState<ContactSalesFormValues>(
    CONTACT_SALES_DEFAULTS
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof ContactSalesFormValues, string>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);

  const teamSizeOptions = [...CONTACT_SALES_TEAM_SIZE_OPTIONS];
  const topicOptions = [...DISCUSSION_TOPIC_OPTIONS];
  const stageOptions = [...STAGE_OPTIONS];
  const timelineOptions = [...DEPLOYMENT_TIMELINE_OPTIONS];
  const usersOptions = [...ESTIMATED_USERS_OPTIONS];

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const nextErrors = validateContactSalesForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      addToast("Please fix the highlighted fields.", "warning");
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
        const upstreamMessage =
          data?.error?.message || data?.error || data?.message;
        const errorMessage =
          typeof upstreamMessage === "string" && upstreamMessage.trim()
            ? upstreamMessage
            : "We couldn't submit your enterprise inquiry right now. Please try again or contact support@proovra.com.";
        addToast(errorMessage, "error");
        return;
      }

      setForm(CONTACT_SALES_DEFAULTS);
      setErrors({});

      onSubmitted?.(data);

      if (redirectOnSuccess) {
        router.push(successUrl);
        return;
      }

      setSuccessOpen(true);
    } catch {
      addToast(
        "We couldn't submit your enterprise inquiry right now. Please try again or contact support@proovra.com.",
        "error"
      );
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
    <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Full name <span className="text-[#F97316]">*</span>
          </label>
          <Input
            value={form.fullName}
            onChange={(v) => set("fullName", v)}
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
            onChange={(v) => set("workEmail", v)}
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
            Organization <span className="text-[#F97316]">*</span>
          </label>
          <Input
            value={form.organization ?? ""}
            onChange={(v) => set("organization", v)}
            error={errors.organization}
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
            onChange={(v) => set("jobTitle", v)}
            placeholder="Director of Operations"
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
            onChange={(v) => set("country", v)}
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
            onChange={(v) => set("teamSize", v)}
            options={teamSizeOptions}
            placeholder="Select team size"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Primary topic <span className="text-[#F97316]">*</span>
          </label>
          <PremiumSelect
            value={form.discussionTopic ?? ""}
            onChange={(v) => set("discussionTopic", v)}
            options={topicOptions}
            placeholder="What you want to discuss"
          />
          {errors.discussionTopic ? (
            <div className="input-error">Select a primary topic.</div>
          ) : null}
        </div>
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            What stage are you in? <span className="text-[#F97316]">*</span>
          </label>
          <PremiumSelect
            value={form.stage ?? ""}
            onChange={(v) => set("stage", v)}
            options={stageOptions}
            placeholder="Select your current stage"
          />
          {errors.stage ? (
            <div className="input-error">{errors.stage}</div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Expected deployment timeline
          </label>
          <PremiumSelect
            value={form.deploymentTimeline ?? ""}
            onChange={(v) => set("deploymentTimeline", v)}
            options={timelineOptions}
            placeholder="Select expected timeline"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
            Estimated users
          </label>
          <PremiumSelect
            value={form.estimatedUsers ?? ""}
            onChange={(v) => set("estimatedUsers", v)}
            options={usersOptions}
            placeholder="Select estimated users"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
          Current challenge <span className="text-[#F97316]">*</span>
        </label>
        <textarea
          value={form.currentChallenge}
          onChange={(e) => set("currentChallenge", e.target.value)}
          placeholder="Describe the challenge you are trying to solve, such as evidence intake from external parties, review bottlenecks, governance requirements, deployment planning, procurement review, integrations, audit readiness, or legal hold needs."
          className={`input min-h-[110px] w-full resize-y ${
            errors.currentChallenge ? "input-has-error" : ""
          }`}
        />
        {errors.currentChallenge ? (
          <div className="input-error">{errors.currentChallenge}</div>
        ) : null}
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#0F172A]">
          Security, governance, or procurement notes
        </label>
        <textarea
          value={form.additionalDetails ?? ""}
          onChange={(e) => set("additionalDetails", e.target.value)}
          placeholder="Share any security, governance, retention, legal hold, SSO/SCIM, procurement, contract, timeline, or stakeholder requirements we should know before responding."
          className={`input min-h-[80px] w-full resize-y ${
            errors.additionalDetails ? "input-has-error" : ""
          }`}
        />
        {errors.additionalDetails ? (
          <div className="input-error">{errors.additionalDetails}</div>
        ) : null}
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
          What happens next
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#475569]">
          We review your topic, organization context, stage, timeline, and
          deployment needs so the right PROOVRA team can respond. Enterprise
          sales, security, governance, or deployment specialists may be included
          depending on your request.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full bg-[#0F172A] px-6 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(15,23,42,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_14px_32px_rgba(15,23,42,0.30)] disabled:cursor-not-allowed disabled:opacity-70 disabled:transform-none disabled:shadow-none"
        >
          {isSubmitting ? "Submitting..." : submitButtonLabel}
        </button>

        <a
          href={SALES_ASSETS.requestDemoUrl}
          className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white px-6 text-[13.5px] font-semibold text-[#0F172A] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.015] hover:border-[#CBD5E1] hover:shadow-[0_8px_18px_rgba(15,23,42,0.06)]"
        >
          Request a demo
        </a>
      </div>

      <LeadSuccessModal
        open={successOpen}
        variant="contactSales"
        onClose={() => setSuccessOpen(false)}
      />
    </form>
  );
}
