import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),

  S3_PUBLIC_BASE_URL: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(1).optional()
  ),

  // ✅ الجديد (مهم للـ verify + PDF + public links)
  REPORT_VERIFY_BASE_URL: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional()
  ),

  // (اختياري بس أنصح فيه لهيكل أوضح)
  REPORT_APP_BASE_URL: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional()
  ),

  SENTRY_DSN: z.string().min(1).optional(),
  WORKER_BUILD_INFO: z.string().min(1).optional(),

  WORKER_PORT: z.coerce.number().int().positive().default(8090),
});

export const env = EnvSchema.parse(process.env);