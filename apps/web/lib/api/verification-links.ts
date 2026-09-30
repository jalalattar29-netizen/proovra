/**
 * Public verification links — the owner controls (ET-PKG-07).
 *
 * A public link is an opaque share token, never the record's id. The token is
 * returned ONCE, by the call that creates or rotates a link; the server keeps
 * only its hash, so nothing here can fetch it again.
 */
import { apiFetch } from "../api";

export type VerificationLinkState = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";

export type VerificationLink = {
  id: string;
  purpose: "OWNER_SHARE" | "REPORT" | "PACKAGE" | string;
  projection: "BASIC" | "STANDARD" | string;
  audience: string | null;
  reportVersion: number | null;
  state: VerificationLinkState;
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

export type VerificationLinkListing = {
  publicVerifyState: string;
  shareable: boolean;
  links: VerificationLink[];
  legacy: LegacyVerifyLink | null;
};

export type CreatedVerificationLink = {
  link: VerificationLink;
  /** Shown once. It cannot be fetched again. */
  token: string;
  verifyPath: string;
  published?: boolean;
  replacedLinkId?: string;
};

export type CreateVerificationLinkInput = {
  audience: string;
  /** Days until the link expires; null = no expiry. */
  expiresInDays: number | null;
  projection: "BASIC" | "STANDARD";
  maxUses: number | null;
};

const base = (evidenceId: string) => `/v1/evidence/${encodeURIComponent(evidenceId)}/verify-links`;
const json = (headers?: Record<string, string>) => ({ "content-type": "application/json", ...(headers ?? {}) });

export function listVerificationLinks(evidenceId: string): Promise<VerificationLinkListing> {
  return apiFetch(base(evidenceId)) as Promise<VerificationLinkListing>;
}

/** `headers` carries the step-up proof when creating the first link publishes the record. */
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

/** The absolute link a recipient opens, on THIS app's origin. */
export function absoluteVerifyUrl(verifyPath: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_BASE?.trim() || "https://app.proovra.com");
  return `${origin.replace(/\/+$/, "")}${verifyPath.startsWith("/") ? verifyPath : `/${verifyPath}`}`;
}

export { evidencePublicLinksHref } from "../verification-links-href";
