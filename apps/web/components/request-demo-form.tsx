"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Select, useToast } from "./ui";
import {
  REQUEST_DEMO_DEFAULT_VALUES,
  TEAM_SIZE_OPTIONS,
  buildRequestDemoPayload,
  type RequestDemoFormValues,
  validateRequestDemoForm,
} from "../lib/request-demo-schema";
import { SALES_ASSETS } from "../lib/sales-assets";

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
  redirectOnSuccess = true,
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

  const teamSizeOptions = [...TEAM_SIZE_OPTIONS];

  const isEnterpriseFlow = useMemo(
    () =>
      sourcePath.includes("/contact-sales") ||
      sourcePath.includes("track=enterprise"),
    [sourcePath]
  );

  const nextStepText = isEnterpriseFlow
    ? `We review enterprise inquiries for workflow fit, shared review requirements, rollout scope, and commercial readiness. Complete enterprise inquiries are typically reviewed ${SALES_ASSETS.expectedEnterpriseResponseWindowText}.`
    : `We review requests for workflow fit, team context, and use-case clarity. Relevant requests usually receive a reply ${SALES_ASSETS.expectedResponseWindowText}.`;

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
        const errorMessage =
          data?.error?.message ||
          data?.error ||
          data?.message ||
          "Unable to submit your request right now.";

        addToast(errorMessage, "error");
        return;
      }

      setForm(REQUEST_DEMO_DEFAULT_VALUES);
      setErrors({});
      addToast("Demo request submitted successfully.", "success");

      onSubmitted?.(data);

      if (redirectOnSuccess) {
        router.push(successUrl);
        return;
      }
    } catch {
      addToast("Network error while submitting the demo request.", "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 grid gap-5">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
            Full name *
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
            className="min-h-[48px]"
          />
        </div>

        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
            Work email *
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
            className="min-h-[48px]"
          />
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
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
            className="min-h-[48px]"
          />
        </div>

        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
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
            className="min-h-[48px]"
          />
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
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
            className="min-h-[48px]"
          />
        </div>

        <div>
          <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
            Team size
          </label>
          <Select
            value={form.teamSize ?? ""}
            onChange={(value) =>
              setForm((prev: RequestDemoFormValues) => ({
                ...prev,
                teamSize: value,
              }))
            }
            options={teamSizeOptions}
            className="min-h-[48px]"
          />
        </div>
      </div>

      <div>
        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
          Primary use case *
        </label>
        <textarea
          value={form.useCase}
          onChange={(e) =>
            setForm((prev: RequestDemoFormValues) => ({
              ...prev,
              useCase: e.target.value,
            }))
          }
          placeholder={
            isEnterpriseFlow
              ? "Describe your shared review, enterprise rollout, retention, procurement, audit, or policy-fit workflow."
              : "Describe your review, compliance, legal, claims, investigation, or enterprise workflow."
          }
          className={`input min-h-[140px] w-full resize-y ${
            errors.useCase ? "input-has-error" : ""
          }`}
        />
        {errors.useCase ? (
          <div className="input-error">{errors.useCase}</div>
        ) : null}
      </div>

      <div>
        <label className="mb-2 block text-[0.88rem] font-semibold text-[#31464a]">
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
          placeholder="Anything else we should know before reviewing the request?"
          className={`input min-h-[120px] w-full resize-y ${
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

      <div className="rounded-[18px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.34)] p-4">
        <div className="text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#8e7863]">
          What happens next
        </div>
        <p className="mt-3 text-[0.95rem] leading-[1.8] text-[#55666a]">
          {nextStepText}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="submit"
          disabled={isSubmitting}
          className="rounded-[16px] px-6 py-3 text-[0.95rem] font-medium hover-button-primary"
        >
          {isSubmitting ? "Submitting..." : submitButtonLabel}
        </Button>

        <a
          href={SALES_ASSETS.pricingUrl}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[16px] border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] px-6 py-3 text-sm font-semibold text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] transition duration-300 hover:translate-y-[-1px]"
        >
          View Pricing
        </a>
      </div>
    </form>
  );
}