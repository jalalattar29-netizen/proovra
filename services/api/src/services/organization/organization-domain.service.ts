/**
 * Phase 3 — Enterprise Identity: Organization domain ownership verification.
 *
 * An organization proves it owns an email domain by publishing a DNS TXT
 * record. Once proven (verifiedAt set), SSO connections configured with
 * `restrictToVerifiedDomains` only admit logins whose email domain matches a
 * VERIFIED OrganizationDomain row for the connection's owning org.
 *
 * This is a REAL ownership proof — distinct from the admin-typed, UNVERIFIED
 * `SsoConnection.allowedEmailDomains` allow-list, which is layered underneath
 * (both must pass when verified-domain restriction is on).
 *
 * DNS challenge convention (documented + stable):
 *
 *   Record name:  _proovra-verify.<domain>
 *   Record type:  TXT
 *   Record value: proovra-domain-verify=<verificationToken>
 *
 * We resolve the TXT records at `_proovra-verify.<domain>` and accept the
 * domain as verified iff ANY returned TXT string contains the exact token
 * (as `proovra-domain-verify=<token>` or the bare token, to tolerate
 * providers that strip the prefix). No wildcard, no substring-of-token match.
 *
 * Hard rules:
 *   - `verificationToken` is a DNS challenge value, safe to surface to the
 *     org admin publishing the record. It is NOT a credential.
 *   - DNS lookups are bounded and failure-closed: a lookup error means "not
 *     verified", never "verified".
 *   - This module never mutates SSO state; it only reads/writes
 *     OrganizationDomain rows and answers verification questions.
 */

import { randomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DNS label prefix for the ownership-challenge TXT record. */
export const DOMAIN_VERIFY_DNS_PREFIX = "_proovra-verify";
/** Value prefix inside the TXT record. */
export const DOMAIN_VERIFY_TXT_PREFIX = "proovra-domain-verify=";

// ---------------------------------------------------------------------------
// Domain normalisation + validation
// ---------------------------------------------------------------------------

/**
 * Normalises a user-supplied domain to a bare, lowercased hostname.
 * Strips scheme, path, port, leading `@`, and surrounding whitespace.
 * Returns null when the result is not a plausible DNS domain.
 */
export function normalizeDomain(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (d.length === 0) return null;
  // Strip a leading "@" (users sometimes paste "@acme.com").
  if (d.startsWith("@")) d = d.slice(1);
  // Strip scheme if present.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Strip anything from the first path/query/port separator onward.
  d = d.split(/[/?#]/)[0] ?? d;
  d = d.split(":")[0] ?? d;
  // Strip a trailing dot (FQDN form).
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length === 0 || d.length > 253) return null;
  // Must be at least two labels (has a dot) and only valid DNS chars.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    return null;
  }
  return d;
}

/** Extracts the lowercased domain from an email address, or null. */
export function domainFromEmail(email: string): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/** Generates an opaque, URL-safe DNS challenge token. */
export function generateVerificationToken(): string {
  return randomBytes(24).toString("base64url");
}

// ---------------------------------------------------------------------------
// DNS TXT verification (pure-ish; DNS resolver is injectable for tests)
// ---------------------------------------------------------------------------

export type TxtResolver = (hostname: string) => Promise<string[][]>;

/**
 * Checks whether the DNS TXT records at `_proovra-verify.<domain>` contain
 * the expected token. Failure-closed: any resolver error yields false.
 *
 * @param resolveTxt injectable resolver (defaults to node:dns resolveTxt) so
 *   tests can exercise this without real DNS.
 */
export async function checkDomainDnsTxt(
  domain: string,
  expectedToken: string,
  resolveTxt: TxtResolver = dnsPromises.resolveTxt,
): Promise<boolean> {
  const normalized = normalizeDomain(domain);
  if (!normalized || !expectedToken || expectedToken.trim().length === 0) {
    return false;
  }
  const recordName = `${DOMAIN_VERIFY_DNS_PREFIX}.${normalized}`;
  let records: string[][];
  try {
    records = await resolveTxt(recordName);
  } catch {
    // NXDOMAIN, SERVFAIL, timeout — all mean "not proven".
    return false;
  }
  const wantWithPrefix = `${DOMAIN_VERIFY_TXT_PREFIX}${expectedToken}`;
  for (const chunks of records) {
    // A single TXT record may be split into multiple strings; join them.
    const value = chunks.join("").trim();
    if (value === wantWithPrefix || value === expectedToken) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// isEmailDomainVerifiedForOrg — enforcement helper consumed by the SSO path.
// ---------------------------------------------------------------------------

/**
 * Returns true iff the email's domain is a VERIFIED OrganizationDomain for the
 * given org. Used by the SSO JIT path when a connection restricts logins to
 * verified domains.
 *
 * A blank/invalid email domain is never verified (failure-closed).
 */
export async function isEmailDomainVerifiedForOrg(
  input: { organizationId: string; email: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const domain = domainFromEmail(input.email);
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;

  const row = await client.organizationDomain.findFirst({
    where: {
      organizationId: input.organizationId,
      domain: normalized,
      verifiedAt: { not: null },
    },
    select: { id: true },
  });
  return row !== null;
}
