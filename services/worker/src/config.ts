import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional()
);

const optionalPositiveInt = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number().int().positive().optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),

  S3_PUBLIC_BASE_URL: optionalTrimmedString,
  S3_ALLOW_INSECURE: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .optional()
    .default("true"),

  S3_OBJECT_LOCK_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  S3_OBJECT_LOCK_MODE: z
    .enum(["GOVERNANCE", "COMPLIANCE"])
    .optional(),
  S3_OBJECT_LOCK_RETAIN_DAYS: optionalPositiveInt,
  S3_OBJECT_LOCK_LEGAL_HOLD: z
    .enum(["ON", "OFF"])
    .optional(),

  REPORT_VERIFY_BASE_URL: optionalUrl,
  REPORT_APP_BASE_URL: optionalUrl,

  ANCHOR_PROVIDER: optionalTrimmedString,
  ANCHOR_MODE: optionalTrimmedString,
  ANCHOR_PUBLIC_BASE_URL: optionalUrl,

  SENTRY_DSN: optionalTrimmedString,
  WORKER_BUILD_INFO: optionalTrimmedString,

  WORKER_PORT: z.coerce.number().int().positive().default(8090),
});

export const env = EnvSchema.parse(process.env);
