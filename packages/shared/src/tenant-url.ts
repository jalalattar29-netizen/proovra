/**
 * PHASE 11 — THE ONE canonical internal URL builder / parser / classifier.
 *
 * This is a ZERO-DECISION vocabulary. It constructs and parses the product's
 * EXISTING route shapes (resource-id based: /evidence/:id, /cases/:id, …) and
 * classifies a link as internal-authenticated / public-signed / external. It
 * never decides authorization, Workspace kind, membership, or trusts a declared
 * tenant. The authoritative Workspace is ALWAYS re-derived server-side from the
 * persisted resource (see the deep-link resolution service) — a URL carries a
 * resource locator, never authoritative tenant truth.
 *
 * Personal Space is a navigation/context concept, NOT a URL tenant segment: the
 * app switches Workspace through the canonical context establishment path, so
 * internal URLs never encode a Customer Organization and an Owned/Personal
 * Workspace can never "inherit" an Organization from a URL.
 *
 * Redirect safety composes the existing authority `isSafeRedirectAfter`.
 */

import { isSafeRedirectAfter } from "./identity-hardening.js";

/** The canonical internal resource families (match the real app routes). */
export const INTERNAL_RESOURCE_TYPES = [
  "evidence",
  "cases",
  "reports",
  "evidence-requests",
  "review",
  "investigation",
  "audit-transparency",
] as const;
export type InternalResourceType = (typeof INTERNAL_RESOURCE_TYPES)[number];

/** A resource locator — the ONLY tenant-relevant thing an internal URL carries. */
export type InternalResourceRef = {
  type: InternalResourceType;
  /** The persisted resource id; the server resolves its authoritative Workspace. */
  id: string;
};

export type LinkClassification =
  | "INTERNAL_AUTHENTICATED"
  | "PUBLIC_SIGNED"
  | "EXTERNAL";

/** Public/signed share surfaces — token-scoped, never an authenticated context. */
const PUBLIC_PREFIXES = ["/share/", "/portal/"] as const;

function isResourceType(v: string): v is InternalResourceType {
  return (INTERNAL_RESOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * Build the canonical RELATIVE internal path for a resource. Callers compose it
 * with the absolute base only for outbound (email/notification) links. The id
 * is URL-encoded; no tenant segment is emitted.
 */
export function internalResourcePath(ref: InternalResourceRef): string {
  return `/${ref.type}/${encodeURIComponent(ref.id)}`;
}

/**
 * Build a canonical RELATIVE internal navigation path (a section root or an
 * already-canonical sub-path). Rejects absolute/protocol-relative inputs by
 * normalising to a leading slash; never emits a tenant segment.
 */
export function internalNavPath(section: string): string {
  const s = section.startsWith("/") ? section : `/${section}`;
  // Collapse a protocol-relative "//x" to a single-slash safe path.
  return s.replace(/^\/{2,}/, "/");
}

/** Compose an absolute internal URL from a validated base origin + relative path. */
export function absoluteInternalUrl(baseOrigin: string, relativePath: string): string {
  const base = baseOrigin.replace(/\/+$/, "");
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${base}${path}`;
}

/** Build a public/signed share URL (token-scoped; never an authenticated context). */
export function publicShareUrl(baseOrigin: string, token: string): string {
  return absoluteInternalUrl(baseOrigin, `/share/${encodeURIComponent(token)}`);
}

/**
 * Parse ONLY the supported canonical internal resource shape. Returns null for
 * anything else (nav-only paths, public/signed, external) — callers must treat
 * null as "no resource binding to validate", never as a tenant.
 */
export function parseInternalResourcePath(path: string): InternalResourceRef | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const [seg1, seg2] = path.replace(/^\//, "").split("/");
  if (!seg1 || !seg2) return null;
  if (!isResourceType(seg1)) return null;
  const id = decodeURIComponent(seg2.split("?")[0].split("#")[0]);
  if (!id) return null;
  return { type: seg1, id };
}

/**
 * Classify a link. `internalOrigins` are the app's own origins; anything on
 * them under a public prefix is PUBLIC_SIGNED, otherwise INTERNAL_AUTHENTICATED;
 * everything else is EXTERNAL. A relative path is internal (public if it sits
 * under a public prefix).
 */
export function classifyLink(
  value: string,
  internalOrigins: ReadonlyArray<string>,
): LinkClassification {
  const publicPath = (p: string) => PUBLIC_PREFIXES.some((pre) => p.startsWith(pre));
  if (value.startsWith("/") && !value.startsWith("//")) {
    return publicPath(value) ? "PUBLIC_SIGNED" : "INTERNAL_AUTHENTICATED";
  }
  try {
    const u = new URL(value);
    if (!internalOrigins.includes(u.origin)) return "EXTERNAL";
    return publicPath(u.pathname) ? "PUBLIC_SIGNED" : "INTERNAL_AUTHENTICATED";
  } catch {
    return "EXTERNAL";
  }
}

/**
 * Preserve a login-intended destination ONLY when it is a safe relative in-app
 * path (composes the existing `isSafeRedirectAfter`). Returns "/" otherwise —
 * never an open redirect. This is the ONLY sanctioned way to carry a post-login
 * destination; the server re-runs all authorization/context checks after login.
 */
export function safeIntendedDestination(
  value: string | null | undefined,
  allowedOrigins: ReadonlyArray<string> = [],
): string {
  return isSafeRedirectAfter(value, allowedOrigins) && value ? value : "/";
}

export { isSafeRedirectAfter };
