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

const anchorModeSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" ? undefined : trimmed;
  },
  z.enum(["off", "ready", "active"]).default("ready")
);

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
  /**
   * LEGACY AND INERT (2026-08-24). Nothing reads this into an S3 request any
   * more — see `readObjectLockDefaults` in `storage.ts`.
   *
   * `OFF` and unset are accepted so existing deployments keep booting; both do
   * nothing. `ON` is REFUSED, and the refusal is the point. Before this pass
   * that single character would have placed a NATIVE S3 legal hold on every
   * newly finalized object — holds this codebase cannot release, because it
   * persists no S3 VersionId and has no release path, and which on a
   * COMPLIANCE bucket no account can clear. An operator who sets it is
   * reaching for a capability that does not exist yet; failing to start says
   * so, where silently ignoring it would let them believe evidence was
   * protected by something that was never applied.
   */
  S3_OBJECT_LOCK_LEGAL_HOLD: z
    .enum(["ON", "OFF"])
    .optional()
    .refine((v) => v !== "ON", {
      message:
        "S3_OBJECT_LOCK_LEGAL_HOLD=ON is not supported: native S3 Object Lock legal hold is not implemented. " +
        "PROOVRA enforces legal hold in the application (EvidenceLegalHold), and has no per-version apply/release " +
        "path, so ON would place holds that cannot be released. Unset it or use OFF.",
    }),

  REPORT_VERIFY_BASE_URL: optionalUrl,
  REPORT_APP_BASE_URL: optionalUrl,

  ANCHOR_PROVIDER: optionalTrimmedString,
  ANCHOR_MODE: anchorModeSchema,

  SENTRY_DSN: optionalTrimmedString,
  WORKER_BUILD_INFO: optionalTrimmedString,

  WORKER_PORT: z.coerce.number().int().positive().default(8090),
});

export const env = EnvSchema.parse(process.env);
