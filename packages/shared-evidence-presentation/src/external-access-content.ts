/**
 * Phase E8 — Bounded external access content (single source of truth).
 *
 * Codifies the canonical external-participant model. Phase E8 does NOT
 * introduce a generic file-sharing platform — it ratifies the bounded
 * external surfaces that already exist (workflow intake links,
 * external review grants, evidence requests, public verify) and adds
 * the contract tests + Trust Center alignment that pin the security
 * invariants.
 *
 * Hard rules pinned by `phase-e8-external-distribution.test.ts`:
 *
 *   1. Every external participant type carries a bounded set of
 *      capabilities — never inherits team membership, never bypasses
 *      governance.
 *   2. Every external token must be: hashed (never stored raw),
 *      expiring, revocable, scoped to a single resource,
 *      rate-limited (where the surface is publicly reachable), and
 *      emit at least one audit event per access lifecycle transition.
 *   3. External-facing copy MUST stay inside the E5 trust-language
 *      boundary. The exact forbidden shapes are listed below in
 *      EXTERNAL_ACCESS_FORBIDDEN_PATTERNS.
 *   4. Anti-enumeration: unknown / revoked / expired tokens MUST
 *      surface an identical deny code so attackers cannot tell
 *      revoked from non-existent.
 *   5. Public verify is read-only and ID-based (not token-based);
 *      content-access is policy-gated; no S3 URL ever leaves the
 *      backend.
 *
 * This module is pure data — no fs, fetch, Prisma. It is shared
 * across web + api test surfaces.
 */

import {
  PROOVRA_REQUIRED_BOUNDARY_PHRASES,
} from "./claims-matrix.js";

// ---------------------------------------------------------------------------
// Bounded external participant enum
// ---------------------------------------------------------------------------

export const EXTERNAL_PARTICIPANT_TYPES = [
  "EXTERNAL_SUBMITTER",
  "EXTERNAL_REVIEWER",
  "CLAIMANT",
  "LAW_FIRM_PARTICIPANT",
  "FIELD_CONTRIBUTOR",
  "TEMPORARY_AUDITOR",
] as const;

export type ExternalParticipantType = (typeof EXTERNAL_PARTICIPANT_TYPES)[number];

// ---------------------------------------------------------------------------
// Per-type contract record
// ---------------------------------------------------------------------------

export type ExternalAccessCapability =
  /** May POST evidence content via presigned upload + submit a session. */
  | "SUBMIT_EVIDENCE"
  /** May read a single bounded resource (one evidence record, one case, one package). */
  | "READ_SCOPED_RESOURCE"
  /** May answer intake questionnaire content (consent + free-text where allowed by the link). */
  | "RESPOND_TO_REQUEST"
  /** May download original evidence bytes (only when the operator granted it). */
  | "DOWNLOAD_ORIGINAL"
  /** May download a verification package (only when the operator granted it). */
  | "DOWNLOAD_PACKAGE";

export type ExternalAccessParticipantContent = {
  type: ExternalParticipantType;
  displayLabel: string;
  summary: string;
  /** Bounded capability set — the only things the participant may do. */
  capabilities: ReadonlyArray<ExternalAccessCapability>;
  /** Concrete backend surface that grants this participant access. */
  backedBy: string;
  /** Hard-rule list every implementation MUST satisfy. */
  hardRules: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// External surface inventory — captures every public-facing surface
// that already exists, plus its bounded posture. Updated whenever a
// surface is added; tests assert each row's invariants.
// ---------------------------------------------------------------------------

export type ExternalSurfaceRecord = {
  id: string;
  title: string;
  /** Public path or template. */
  publicSurface: string;
  /** API path or template. */
  apiSurface: string;
  /** "ID" (UUID in path) or "TOKEN" (hashed + scoped + expiring). */
  accessShape: "ID" | "TOKEN" | "STUB";
  /** Whether the surface is gated by a feature flag. */
  featureFlag: string | null;
  /** Whether the surface enforces a per-request rate limit. */
  rateLimited: boolean;
  /** Whether the surface emits audit events on access lifecycle transitions. */
  emitsAuditEvents: boolean;
  /** Token storage shape (when accessShape === "TOKEN"). */
  tokenStorage: "HMAC-SHA256" | "SHA-256" | "NONE";
  /** Whether tokens / grants are eagerly checked for revocation + expiry on every request. */
  eagerRevocationCheck: boolean;
  notes: string;
};

export const EXTERNAL_SURFACE_INVENTORY: ReadonlyArray<ExternalSurfaceRecord> = [
  {
    id: "workflow-intake-link",
    title: "Workflow intake link",
    publicSurface: "external-intake (token-based POST)",
    apiSurface: "/v1/external-intake/:token/* (POST)",
    accessShape: "TOKEN",
    featureFlag: "WORKFLOW_INTAKE_LINKS_ENABLED + WORKFLOW_INTAKE_TOKEN_SECRET",
    rateLimited: true,
    emitsAuditEvents: true,
    tokenStorage: "HMAC-SHA256",
    eagerRevocationCheck: true,
    notes:
      "Token returned ONCE at creation; never re-derivable. Per-link expiresAtUtc + revokedAtUtc + usedCount/maxUses. Session status enum; IP hashed. Three custody events: EXTERNAL_INTAKE_LINK_USED, EXTERNAL_INTAKE_CONSENT_ACCEPTED, EXTERNAL_INTAKE_SUBMITTED.",
  },
  {
    id: "external-review-grant",
    title: "External review grant",
    publicSurface: "external-review (token-based GET + accept)",
    apiSurface: "/v1/external-review/access/:token/*",
    accessShape: "TOKEN",
    featureFlag: null,
    rateLimited: false,
    emitsAuditEvents: true,
    tokenStorage: "SHA-256",
    eagerRevocationCheck: true,
    notes:
      "Operator creation requires governance.legal_hold.manage. Token returned ONCE; SHA-256 hashed. Single-scope per grant (EVIDENCE | CASE | PACKAGE). 15min–30day lifetime. Anti-enumeration: identical 'grant_not_active' deny code for unknown/revoked/expired. Legal hold blocks redemption. GAP (DEF-028): no rate limit on reviewer-redemption routes. GAP (DEF-029): no feature flag kill switch.",
  },
  {
    id: "evidence-request",
    title: "Evidence request workflow",
    publicSurface: "external-intake (token-based via WorkflowIntakeLink)",
    apiSurface: "/v1/evidence-requests/* (admin) + /v1/external-intake/:token/* (responder)",
    accessShape: "TOKEN",
    featureFlag: "EVIDENCE_REQUESTS_ENABLED",
    rateLimited: true,
    emitsAuditEvents: true,
    tokenStorage: "HMAC-SHA256",
    eagerRevocationCheck: true,
    notes:
      "Reuses WorkflowIntakeLink token model. Status: RECEIVED → UNDER_REVIEW | ACCEPTED | NEEDS_MORE_INFO | REJECTED. EvidenceRequestEvent table append-only. GAP (DEF-030): external responder submission emits no SecurityEvent — only EvidenceRequestEvent.",
  },
  {
    id: "public-verify",
    title: "Public verify page",
    publicSurface: "/verify/:id (web) → /public/verify/:id (api)",
    apiSurface: "GET /public/verify/:id",
    accessShape: "ID",
    featureFlag: null,
    rateLimited: true,
    emitsAuditEvents: true,
    tokenStorage: "NONE",
    eagerRevocationCheck: true,
    notes:
      "ID-based (UUID), no token. Per-IP rate limit 60/60s. Publication gate (404 if not PUBLISHED — no state disclosure). Finalization gate (409 if not SIGNED/REPORTED). Content access policy via PUBLIC_VERIFY_CONTENT_MODE env var; default 'preview_only'. No raw S3 URL exposure. Custody chain NOT polluted by views (analytics-only writes).",
  },
  {
    id: "share-link",
    title: "Share link (deferred)",
    publicSurface: "/share/[id] (web stub)",
    apiSurface: "(none)",
    accessShape: "STUB",
    featureFlag: null,
    rateLimited: false,
    emitsAuditEvents: false,
    tokenStorage: "NONE",
    eagerRevocationCheck: false,
    notes:
      "CR1 Part 2 placeholder. No backend route, no token model. Users are directed to 'Share Evidence' UI on the evidence detail page. Intentionally NOT activated in E8.",
  },
];

// ---------------------------------------------------------------------------
// Bounded participant content
// ---------------------------------------------------------------------------

export const EXTERNAL_ACCESS_PARTICIPANTS: Record<
  ExternalParticipantType,
  ExternalAccessParticipantContent
> = {
  EXTERNAL_SUBMITTER: {
    type: "EXTERNAL_SUBMITTER",
    displayLabel: "External submitter",
    summary:
      "A person invited to upload evidence into a specific workflow intake link or evidence request, with no other workspace access.",
    capabilities: ["SUBMIT_EVIDENCE", "RESPOND_TO_REQUEST"],
    backedBy: "WorkflowIntakeLink (token) + WorkflowIntakeSession",
    hardRules: [
      "Bounded to the single intake link or request the token was issued for.",
      "Cannot browse other evidence, other cases, or any analytics / governance / admin surface.",
      "Submission emits EXTERNAL_INTAKE_LINK_USED, EXTERNAL_INTAKE_CONSENT_ACCEPTED, EXTERNAL_INTAKE_SUBMITTED custody events.",
      "Token is single-use by default (configurable up to maxUses).",
      "Expiry + revocation are checked on every request — no grace period.",
    ],
  },
  EXTERNAL_REVIEWER: {
    type: "EXTERNAL_REVIEWER",
    displayLabel: "External reviewer",
    summary:
      "A reviewer invited to access one specific evidence record, case, or verification package — read-only by default, optionally with original or package download.",
    capabilities: ["READ_SCOPED_RESOURCE", "DOWNLOAD_ORIGINAL", "DOWNLOAD_PACKAGE"],
    backedBy: "ExternalReviewerGrant (SHA-256 hashed token)",
    hardRules: [
      "Single-scope per grant: exactly one EVIDENCE record, one CASE, or one PACKAGE.",
      "Grant lifetime is 15 minutes to 30 days; expiration is checked on every request.",
      "Download flags (allowOriginalDownload, allowPackageDownload) are off by default and must be explicitly enabled by the operator.",
      "Active legal hold blocks token redemption.",
      "Anti-enumeration: unknown / revoked / expired tokens surface an identical deny code ('grant_not_active').",
      "External reviewer never appears in TeamMember table and never inherits capability registry permissions.",
    ],
  },
  CLAIMANT: {
    type: "CLAIMANT",
    displayLabel: "Claimant",
    summary:
      "Specialization of EXTERNAL_SUBMITTER for insurance workflows: a claimant submitting evidence for a specific claim intake.",
    capabilities: ["SUBMIT_EVIDENCE", "RESPOND_TO_REQUEST"],
    backedBy: "WorkflowIntakeLink (token) with claim-context EvidenceRequest binding",
    hardRules: [
      "Inherits all EXTERNAL_SUBMITTER hard rules.",
      "Scoped to one claim intake link; cannot enumerate other claimants' intake links.",
      "Submissions become EvidenceRequestResponse rows bound to the originating request.",
    ],
  },
  LAW_FIRM_PARTICIPANT: {
    type: "LAW_FIRM_PARTICIPANT",
    displayLabel: "Law firm participant",
    summary:
      "Specialization of EXTERNAL_REVIEWER for legal workflows: outside counsel reviewer accessing one matter or one evidence record.",
    capabilities: ["READ_SCOPED_RESOURCE", "DOWNLOAD_ORIGINAL", "DOWNLOAD_PACKAGE"],
    backedBy: "ExternalReviewerGrant (CASE or EVIDENCE scope)",
    hardRules: [
      "Inherits all EXTERNAL_REVIEWER hard rules.",
      "Operator-side creation surfaces firm name + matter id in the audit event metadata where supplied.",
      "Active legal hold on the underlying evidence blocks redemption — outside counsel is not a hold exception.",
    ],
  },
  FIELD_CONTRIBUTOR: {
    type: "FIELD_CONTRIBUTOR",
    displayLabel: "Field contributor",
    summary:
      "Specialization of EXTERNAL_SUBMITTER for newsroom and investigation workflows: a contributor delegated to capture in the field.",
    capabilities: ["SUBMIT_EVIDENCE"],
    backedBy: "WorkflowIntakeLink (token) with capture-template binding",
    hardRules: [
      "Inherits all EXTERNAL_SUBMITTER hard rules.",
      "Source-protection boundaries are operator-managed — the platform does not impersonate, anonymize, or proxy the contributor.",
      "Field contributor cannot finalize evidence; finalize remains internal-reviewer territory.",
    ],
  },
  TEMPORARY_AUDITOR: {
    type: "TEMPORARY_AUDITOR",
    displayLabel: "Temporary auditor",
    summary:
      "Specialization of EXTERNAL_REVIEWER for compliance and governance: a short-window auditor accessing a specific package or case for review.",
    capabilities: ["READ_SCOPED_RESOURCE", "DOWNLOAD_PACKAGE"],
    backedBy: "ExternalReviewerGrant (PACKAGE or CASE scope, short-lifetime)",
    hardRules: [
      "Inherits all EXTERNAL_REVIEWER hard rules, including scope, expiry, revocation, and audit emission.",
      "Recommended grant lifetime is at the short end of the allowed window (hours, not weeks).",
      "Download is restricted to the verification package (not the original evidence content) by default.",
    ],
  },
};

// ---------------------------------------------------------------------------
// Forbidden external-facing trust-claim shapes
// ---------------------------------------------------------------------------

export const EXTERNAL_ACCESS_FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\blegally\s+verified\s+evidence\b/i,
  /\bcourt[- ]?certified\s+upload\b/i,
  /\bauthenticity\s+guaranteed\b/i,
  /\btamper[- ]?proof\s+forever\b/i,
  /\btamper[- ]?proof\b/i,
  /\bforensically\s+(?:validated|certified)\s+by\s+AI\b/i,
  /\bforensically\s+validated\b/i,
  /\bcourt[- ]?ready\s+(?:link|upload|submission)\b/i,
  /\bAI[- ]?validated\b/i,
  /\bSOC\s*2\s+(?:compliant|certified)\b/i,
  /\bzero[- ]?trust\s+(?:guaranteed|certified)\b/i,
  /\bpermanent\s+share\s+link\b/i,
  /\bpublic\s+evidence\s+(?:bucket|folder|repository)\b/i,
];

// ---------------------------------------------------------------------------
// Required boundary phrases on external-facing copy
// ---------------------------------------------------------------------------

export const EXTERNAL_ACCESS_REQUIRED_PHRASES = [
  ...PROOVRA_REQUIRED_BOUNDARY_PHRASES,
  // External flows MUST surface revocability / expiry / scope explicitly.
  "revocable",
  "expir",
  "scope",
] as const;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function getExternalParticipantContent(
  type: ExternalParticipantType,
): ExternalAccessParticipantContent {
  return EXTERNAL_ACCESS_PARTICIPANTS[type];
}

export function getExternalSurfaceRecord(
  id: string,
): ExternalSurfaceRecord | null {
  return EXTERNAL_SURFACE_INVENTORY.find((s) => s.id === id) ?? null;
}

export function listExternalSurfaceIds(): ReadonlyArray<string> {
  return EXTERNAL_SURFACE_INVENTORY.map((s) => s.id);
}
