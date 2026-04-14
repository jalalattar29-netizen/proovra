import { z } from "zod";

export const TEAM_SIZE_OPTIONS = [
  { value: "1-5", label: "1–5" },
  { value: "6-20", label: "6–20" },
  { value: "21-50", label: "21–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-1000", label: "201–1000" },
  { value: "1000+", label: "1000+" },
] as const;

export const requestDemoSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required.").max(160),
  workEmail: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .max(320),
  organization: z.string().trim().max(180).optional().or(z.literal("")),
  jobTitle: z.string().trim().max(120).optional().or(z.literal("")),
  country: z.string().trim().max(120).optional().or(z.literal("")),
  teamSize: z.string().trim().max(64).optional().or(z.literal("")),
  useCase: z
    .string()
    .trim()
    .min(10, "Please provide a bit more detail.")
    .max(5000),
  message: z
    .string()
    .trim()
    .max(5000, "Message is too long.")
    .optional()
    .or(z.literal("")),
  website: z.string().trim().max(300).optional().or(z.literal("")),
});

export type RequestDemoFormValues = z.infer<typeof requestDemoSchema>;

export type RequestDemoPayload = {
  fullName: string;
  workEmail: string;
  organization: string | null;
  jobTitle: string | null;
  country: string | null;
  teamSize: string | null;
  useCase: string;
  message: string | null;
  website: string | null;
  source: string;
  sourcePath: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
};

export type RequestDemoFieldErrors = Partial<
  Record<keyof RequestDemoFormValues, string>
>;

export const REQUEST_DEMO_DEFAULT_VALUES: RequestDemoFormValues = {
  fullName: "",
  workEmail: "",
  organization: "",
  jobTitle: "",
  country: "",
  teamSize: "",
  useCase: "",
  message: "",
  website: "",
};

export function normalizeOptional(value?: string): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function validateRequestDemoForm(
  values: RequestDemoFormValues
): RequestDemoFieldErrors {
  const parsed = requestDemoSchema.safeParse(values);
  if (parsed.success) return {};

  const errors: RequestDemoFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) {
      errors[field as keyof RequestDemoFormValues] = issue.message;
    }
  }
  return errors;
}

export function buildRequestDemoPayload(
  values: RequestDemoFormValues,
  sourcePath = "/request-demo"
): RequestDemoPayload {
  const search =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;

  return {
    fullName: values.fullName.trim(),
    workEmail: values.workEmail.trim(),
    organization: normalizeOptional(values.organization),
    jobTitle: normalizeOptional(values.jobTitle),
    country: normalizeOptional(values.country),
    teamSize: normalizeOptional(values.teamSize),
    useCase: values.useCase.trim(),
    message: normalizeOptional(values.message),
    website: normalizeOptional(values.website),
    source:
      typeof window !== "undefined"
        ? document.referrer
          ? "website_referral"
          : "website_direct"
        : "website",
    sourcePath,
    referrer: typeof window !== "undefined" ? document.referrer || null : null,
    utmSource: search?.get("utm_source") ?? null,
    utmMedium: search?.get("utm_medium") ?? null,
    utmCampaign: search?.get("utm_campaign") ?? null,
    utmTerm: search?.get("utm_term") ?? null,
    utmContent: search?.get("utm_content") ?? null,
  };
}