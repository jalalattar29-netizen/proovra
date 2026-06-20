import { z } from "zod";

export const DISCUSSION_TOPIC_OPTIONS = [
  { value: "enterprise-pricing", label: "Enterprise Pricing" },
  { value: "team-rollout", label: "Team Rollout" },
  { value: "procurement-review", label: "Procurement Review" },
  { value: "security-review", label: "Security Review" },
  { value: "governance-review", label: "Governance Review" },
  { value: "data-retention", label: "Data Retention" },
  { value: "legal-hold", label: "Legal Hold" },
  { value: "integrations-apis", label: "Integrations & APIs" },
  { value: "multi-team-deployment", label: "Multi-Team Deployment" },
  { value: "partner-inquiry", label: "Partner Inquiry" },
  { value: "other", label: "Other" },
] as const;

export const STAGE_OPTIONS = [
  { value: "exploring", label: "Exploring options" },
  { value: "comparing", label: "Comparing vendors" },
  { value: "internal-review", label: "Internal review" },
  { value: "procurement-review", label: "Procurement review" },
  { value: "security-review", label: "Security review" },
  { value: "ready-to-deploy", label: "Ready to deploy" },
] as const;

export const DEPLOYMENT_TIMELINE_OPTIONS = [
  { value: "this-month", label: "This month" },
  { value: "1-3-months", label: "1–3 months" },
  { value: "3-6-months", label: "3–6 months" },
  { value: "6plus-months", label: "6+ months" },
  { value: "planning", label: "Planning stage" },
] as const;

export const ESTIMATED_USERS_OPTIONS = [
  { value: "1-10", label: "1–10" },
  { value: "11-50", label: "11–50" },
  { value: "51-250", label: "51–250" },
  { value: "251-1000", label: "251–1000" },
  { value: "1000+", label: "1000+" },
] as const;

export const CONTACT_SALES_TEAM_SIZE_OPTIONS = [
  { value: "1-5", label: "1–5" },
  { value: "6-20", label: "6–20" },
  { value: "21-50", label: "21–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-1000", label: "201–1000" },
  { value: "1000+", label: "1000+" },
] as const;

export const contactSalesSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required.").max(160),
  workEmail: z.string().trim().email("Enter a valid email address.").max(320),
  organization: z.string().trim().min(1, "Organization is required.").max(180),
  jobTitle: z.string().trim().max(120).optional().or(z.literal("")),
  country: z.string().trim().max(120).optional().or(z.literal("")),
  teamSize: z.string().trim().max(64).optional().or(z.literal("")),
  discussionTopic: z
    .string()
    .trim()
    .min(1, "Select a discussion topic.")
    .max(64),
  stage: z.string().trim().min(1, "Select your current stage.").max(64),
  deploymentTimeline: z.string().trim().max(64).optional().or(z.literal("")),
  estimatedUsers: z.string().trim().max(64).optional().or(z.literal("")),
  currentChallenge: z
    .string()
    .trim()
    .min(10, "Please describe your challenge in a bit more detail.")
    .max(5000),
  additionalDetails: z
    .string()
    .trim()
    .max(5000, "Message is too long.")
    .optional()
    .or(z.literal("")),
  website: z.string().trim().max(300).optional().or(z.literal("")),
});

export type ContactSalesFormValues = z.infer<typeof contactSalesSchema>;

export type ContactSalesFieldErrors = Partial<
  Record<keyof ContactSalesFormValues, string>
>;

export const CONTACT_SALES_DEFAULTS: ContactSalesFormValues = {
  fullName: "",
  workEmail: "",
  organization: "",
  jobTitle: "",
  country: "",
  teamSize: "",
  discussionTopic: "",
  stage: "",
  deploymentTimeline: "",
  estimatedUsers: "",
  currentChallenge: "",
  additionalDetails: "",
  website: "",
};

export function validateContactSalesForm(
  values: ContactSalesFormValues
): ContactSalesFieldErrors {
  const parsed = contactSalesSchema.safeParse(values);
  if (parsed.success) return {};
  const errors: ContactSalesFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) {
      errors[field as keyof ContactSalesFormValues] = issue.message;
    }
  }
  return errors;
}

function normalizeOptional(value?: string): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/**
 * Builds a payload the existing /api/request-demo endpoint accepts while
 * preserving contact-sales-specific intent in the message + ancillary fields.
 * Maps:
 *   discussionTopic  → primaryInterest (existing schema requires this)
 *   organizationType → fixed "contact-sales" so downstream can route
 *   currentChallenge → useCase
 *   stage + timeline + users + additionalDetails → message (structured)
 */
export function buildContactSalesPayload(values: ContactSalesFormValues) {
  const search =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;

  const messageLines: string[] = [];
  if (values.stage) {
    const stageLabel =
      STAGE_OPTIONS.find((o) => o.value === values.stage)?.label ?? values.stage;
    messageLines.push(`Stage: ${stageLabel}`);
  }
  if (values.deploymentTimeline) {
    const tlLabel =
      DEPLOYMENT_TIMELINE_OPTIONS.find(
        (o) => o.value === values.deploymentTimeline
      )?.label ?? values.deploymentTimeline;
    messageLines.push(`Deployment timeline: ${tlLabel}`);
  }
  if (values.estimatedUsers) {
    const usersLabel =
      ESTIMATED_USERS_OPTIONS.find((o) => o.value === values.estimatedUsers)
        ?.label ?? values.estimatedUsers;
    messageLines.push(`Estimated users: ${usersLabel}`);
  }
  if (values.additionalDetails && values.additionalDetails.trim()) {
    messageLines.push("");
    messageLines.push("Additional details:");
    messageLines.push(values.additionalDetails.trim());
  }
  const message = messageLines.length ? messageLines.join("\n") : null;

  return {
    fullName: values.fullName.trim(),
    workEmail: values.workEmail.trim(),
    organization: values.organization.trim(),
    jobTitle: normalizeOptional(values.jobTitle),
    country: normalizeOptional(values.country),
    teamSize: normalizeOptional(values.teamSize),
    primaryInterest: values.discussionTopic.trim(),
    organizationType: "contact-sales",
    useCase: values.currentChallenge.trim(),
    message,
    website: normalizeOptional(values.website),
    discussionTopic: values.discussionTopic.trim(),
    stage: values.stage.trim(),
    deploymentTimeline: normalizeOptional(values.deploymentTimeline),
    estimatedUsers: normalizeOptional(values.estimatedUsers),
    additionalDetails: normalizeOptional(values.additionalDetails),
    source:
      typeof window !== "undefined"
        ? document.referrer
          ? "website_referral"
          : "website_direct"
        : "website",
    sourcePath: "/contact-sales",
    referrer: typeof window !== "undefined" ? document.referrer || null : null,
    utmSource: search?.get("utm_source") ?? null,
    utmMedium: search?.get("utm_medium") ?? null,
    utmCampaign: search?.get("utm_campaign") ?? null,
    utmTerm: search?.get("utm_term") ?? null,
    utmContent: search?.get("utm_content") ?? null,
  };
}
