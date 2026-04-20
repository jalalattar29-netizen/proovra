import { z } from "zod";

export const PROOVRA_BRAND = {
  name: "Proovra",
  domain: "proovra.com",
  tagline: "Capture truth. Prove it forever.",
} as const;

export const SUPPORT_EMAILS = {
  support: "support@proovra.com",
  legal: "legal@proovra.com",
  admin: "admin@proovra.com",
  security: "security@proovra.com",
} as const;

export const EvidenceTypeSchema = z.enum(["PHOTO", "VIDEO", "DOCUMENT"]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const LegalVersionsSchema = z.object({
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  cookiesVersion: z.string().min(1),
});
export type LegalVersions = z.infer<typeof LegalVersionsSchema>;

export * from "./i18n.js";

export type {
  EnqueueReportJobOptions,
  ReportJobPayload,
  ExistingReportJobState,
  ReportJobEnqueueDecision,
} from "./report-queue.js";

export {
  buildReportJobId,
  buildReportJobPayload,
  decideReportJobEnqueueAction,
  generateReportJobName,
  normalizeRegenerateReason,
} from "./report-queue.js";

export type { CustodyEventCategory } from "./custody.js";

export {
  classifyCustodyEventType,
  isAccessCustodyEventType,
  isForensicCustodyEventType,
} from "./custody.js";