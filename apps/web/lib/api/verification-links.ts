/**
 * The record's verification page and its secure reviewer shares — the owner
 * controls (ET-PKG-07; disclosure model 2026-10-18).
 *
 * Every finalized record has ONE permanent verification page (`pvr_`). The
 * owner decides what it DISCLOSES (verification only, or a content preview,
 * optionally with the recorded location); the SERVER decides and describes
 * what anonymous visitors see. Nothing here publishes anything.
 *
 * A reviewer share (`pvs_`) is an opaque token, never the record's id. The
 * token is returned ONCE, by the call that creates or rotates a share; the
 * server keeps only its hash, so nothing here can fetch it again.
 */
import { apiFetch } from "../api";

export type VerificationLinkState = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";

export type VerificationLink = {
  id: string;
  purpose: "OWNER_SHARE" | "REPORT" | "PACKAGE" | string;
  /** STANDARD = content preview; BASIC = verification only. */
  projection: "BASIC" | "STANDARD" | string;
  audience: string | null;
  reportVersion: number | null;
  state: VerificationLinkState;
  /**
   * Does following the link answer right now? Projected by the API: an ACTIVE
   * link on a record whose verification page is withdrawn or suspended
   * answers what the page answers. The client never derives it.
   */
  usable: boolean;
  /** Why an ACTIVE link does not answer; null when usable or not ACTIVE. */
  inactiveReason: "PAGE_NOT_AVAILABLE" | null;
  /** OWNER_SHARE only: may this share hand out the original files? */
  allowOriginalDownload: boolean;
  createdAtUtc: string;
  createdByUserId: string | null;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  rotatedFromId: string | null;
  maxUses: number | null;
  useCount: number;
  lastUsedAtUtc: string | null;
};

export type LegacyVerifyLink = {
  active: boolean;
  expiresAtUtc: string;
  graceDays: number;
};

/** The verification page's access state — every identifier answers it. */
export type VerificationAccessState = "AVAILABLE" | "WITHDRAWN" | "SUSPENDED";

export type VerificationLinkListing = {
  verificationAccessState: VerificationAccessState | string;
  shareable: boolean;
  links: VerificationLink[];
  legacy: LegacyVerifyLink | null;
};

export type CreatedVerificationLink = {
  link: VerificationLink;
  /** Shown once. It cannot be fetched again. */
  token: string;
  verifyPath: string;
  replacedLinkId?: string;
};

export type CreateVerificationLinkInput = {
  audience: string;
  /** Days until the share expires; null = no expiry. */
  expiresInDays: number | null;
  projection: "BASIC" | "STANDARD";
  maxUses: number | null;
  /** STANDARD (content preview) shares only; needs a fresh step-up when true. */
  allowOriginalDownload: boolean;
};

const base = (evidenceId: string) => `/v1/evidence/${encodeURIComponent(evidenceId)}/verify-links`;
const json = (headers?: Record<string, string>) => ({ "content-type": "application/json", ...(headers ?? {}) });

export function listVerificationLinks(evidenceId: string): Promise<VerificationLinkListing> {
  return apiFetch(base(evidenceId)) as Promise<VerificationLinkListing>;
}

/** `headers` carries the step-up proof when the share grants the original files. */
export function createVerificationLink(
  evidenceId: string,
  input: CreateVerificationLinkInput,
  headers?: Record<string, string>,
): Promise<CreatedVerificationLink> {
  return apiFetch(base(evidenceId), {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify(input),
  }) as Promise<CreatedVerificationLink>;
}

export function revokeVerificationLink(evidenceId: string, linkId: string): Promise<{ link: VerificationLink; changed: boolean }> {
  return apiFetch(`${base(evidenceId)}/${encodeURIComponent(linkId)}/revoke`, { method: "POST" }) as Promise<{
    link: VerificationLink;
    changed: boolean;
  }>;
}

export function rotateVerificationLink(evidenceId: string, linkId: string): Promise<CreatedVerificationLink> {
  return apiFetch(`${base(evidenceId)}/${encodeURIComponent(linkId)}/rotate`, {
    method: "POST",
  }) as Promise<CreatedVerificationLink>;
}

export function revokeLegacyVerifyLink(evidenceId: string): Promise<{ legacy: LegacyVerifyLink; changed: boolean }> {
  return apiFetch(`${base(evidenceId)}/legacy/revoke`, { method: "POST" }) as Promise<{
    legacy: LegacyVerifyLink;
    changed: boolean;
  }>;
}

export type LegacyVerifyLinkInventory = {
  activeCount: number;
  earliestExpiryUtc: string | null;
  latestExpiryUtc: string | null;
  graceDays: number;
  records: Array<{ evidenceId: string; title: string | null; expiresAtUtc: string }>;
};

/**
 * The active workspace's records that can still be opened by their record id
 * (the bounded transition for records shared before share links existed).
 * The workspace is the caller's own; nothing is passed.
 */
export function legacyVerifyLinkInventory(): Promise<LegacyVerifyLinkInventory> {
  return apiFetch("/v1/verify-links/legacy-inventory") as Promise<LegacyVerifyLinkInventory>;
}

/** The absolute link a recipient opens, on THIS app's origin. */
export function absoluteVerifyUrl(verifyPath: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_BASE?.trim() || "https://app.proovra.com");
  return `${origin.replace(/\/+$/, "")}${verifyPath.startsWith("/") ? verifyPath : `/${verifyPath}`}`;
}

export { evidenceVerificationPageHref } from "../verification-links-href";

/**
 * THE CANONICAL VERIFICATION PAGE (owner decision 2026-10-14) — the record's
 * permanent verification reference and its state. Distinct from the reviewer
 * shares above: it needs no link creation, no publication and never expires.
 */
export type CanonicalVerificationStatus =
  | "NOT_ISSUED"
  | "AVAILABLE"
  | "WITHDRAWN"
  | "TEMPORARILY_UNAVAILABLE"
  | "RETAINED"
  | "PURGED";

export type VerificationWithdrawalReason =
  | "LEGAL_REQUEST"
  | "PRIVACY_REQUEST"
  | "SECURITY_INCIDENT"
  | "OPERATOR_REVIEW";

export type VerificationDisclosureMode = "VERIFICATION_ONLY" | "CONTENT_PREVIEW";

/**
 * What anonymous visitors of the permanent reference see — written by the
 * SERVER from the saved policy. The client prints it; it never derives it.
 */
export type VisitorPreview = { shown: string[]; withheld: string[]; never: string[] };

export type VerificationDisclosure = {
  mode: VerificationDisclosureMode;
  showRecordedLocation: boolean;
  /** The policy version (compare-and-swap for the next change). */
  version: number;
  changedAtUtc?: string | null;
  visitorPreview: VisitorPreview;
};

export type VerificationAccess = {
  status: CanonicalVerificationStatus;
  reference: string | null;
  verifyPath: string | null;
  issuedAtUtc: string | null;
  withdrawal: { state: string; reason: string | null; changedAtUtc: string | null } | null;
  canWithdraw: boolean;
  /** The disclosure policy; null while the record has no page to disclose from. */
  disclosure: VerificationDisclosure | null;
  /** May the caller change the disclosure (the publish permission)? */
  canChangeDisclosure: boolean;
};

export function getVerificationAccess(evidenceId: string): Promise<VerificationAccess> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/verification-access`) as Promise<VerificationAccess>;
}

export type VerificationDisclosureChange = {
  mode: VerificationDisclosureMode;
  showRecordedLocation: boolean;
  /** The version the caller saw; a newer one answers 409 DISCLOSURE_VERSION_CONFLICT. */
  expectedVersion: number;
};

/**
 * Change what the verification page discloses. Widening it (content preview,
 * or the recorded location) answers 401 STEP_UP_REQUIRED until `headers`
 * carries a fresh step-up proof; narrowing never does. The server decides
 * which change widens — the client only retries through the step-up flow.
 */
export function changeVerificationDisclosure(
  evidenceId: string,
  change: VerificationDisclosureChange,
  headers?: Record<string, string>,
): Promise<{ changed: boolean; disclosure: VerificationDisclosure }> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/verification-disclosure`, {
    method: "PUT",
    headers: json(headers),
    body: JSON.stringify(change),
  }) as Promise<{ changed: boolean; disclosure: VerificationDisclosure }>;
}

export function withdrawVerificationAccess(
  evidenceId: string,
  reason: VerificationWithdrawalReason,
): Promise<{ state: string; changed: boolean }> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/verification-access/withdraw`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  }) as Promise<{ state: string; changed: boolean }>;
}

export function reinstateVerificationAccess(evidenceId: string): Promise<{ state: string; changed: boolean }> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/verification-access/reinstate`, {
    method: "POST",
    body: JSON.stringify({}),
  }) as Promise<{ state: string; changed: boolean }>;
}
