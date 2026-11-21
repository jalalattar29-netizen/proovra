/**
 * PRO-G2-01 — pure account / relation classification for the restricted holder
 * inventory (trust-exposure-holder-inventory.ts). No I/O.
 */
import { createHmac } from "node:crypto";

export const DEFAULT_OPERATOR_DOMAINS = ["proovra.com"] as const;
export const DEFAULT_TEST_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "test",
  "invalid",
  "localhost",
  "example",
  "mailinator.com",
  "proovra.test",
] as const;

export type AccountClass = "OPERATOR" | "TEST_DOMAIN" | "NO_EMAIL" | "EXTERNAL";
export type SourceRelation =
  | "SAME_OWNER_USER"
  | "SAME_ORGANIZATION"
  | "SHARED_MEMBER"
  | "BOTH_OPERATOR"
  | "TEST_DOMAIN"
  | "INDEPENDENT";
export type PackageScope = "NO_DISTINCT_SOURCE" | "SAME_OWNER_ONLY" | "OPERATOR_OR_TEST_ONLY" | "CROSS_PARTY";

export type MaskedAccount = { userId: string; domain: string | null; localPartHmac: string | null; class: AccountClass };

export type TeamFact = {
  teamId: string;
  organizationId: string;
  workspaceKind: string;
  isPersonal: boolean;
  closed: boolean;
  owner: MaskedAccount;
  activeMemberUserIds: string[];
};

function domainMatches(domain: string, list: readonly string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function maskEmail(
  userId: string,
  email: string | null,
  opts: { hashSalt: string; operatorDomains: readonly string[]; testDomains: readonly string[] },
): MaskedAccount {
  const at = email ? email.lastIndexOf("@") : -1;
  if (!email || at <= 0) return { userId, domain: null, localPartHmac: null, class: "NO_EMAIL" };
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const localPartHmac = createHmac("sha256", opts.hashSalt).update(local).digest("hex").slice(0, 16);
  const cls: AccountClass = domainMatches(domain, opts.operatorDomains)
    ? "OPERATOR"
    : domainMatches(domain, opts.testDomains)
      ? "TEST_DOMAIN"
      : "EXTERNAL";
  return { userId, domain, localPartHmac, class: cls };
}

/** How a SOURCE workspace relates to the HOLDING workspace (first match wins, strongest tie first). */
export function classifySourceRelation(holder: TeamFact, source: TeamFact): SourceRelation {
  if (holder.owner.userId === source.owner.userId) return "SAME_OWNER_USER";
  if (holder.organizationId === source.organizationId) return "SAME_ORGANIZATION";
  const members = new Set(holder.activeMemberUserIds);
  if (source.activeMemberUserIds.some((u) => members.has(u))) return "SHARED_MEMBER";
  if (holder.owner.class === "OPERATOR" && source.owner.class === "OPERATOR") return "BOTH_OPERATOR";
  if (holder.owner.class === "TEST_DOMAIN" || source.owner.class === "TEST_DOMAIN") return "TEST_DOMAIN";
  return "INDEPENDENT";
}

export function packageScope(relations: readonly SourceRelation[]): PackageScope {
  // FOREIGN_DUPLICATE_ONLY packages: foreign rows repeated content the holder has; no source attributed.
  if (relations.length === 0) return "NO_DISTINCT_SOURCE";
  if (relations.every((r) => r === "SAME_OWNER_USER" || r === "SAME_ORGANIZATION" || r === "SHARED_MEMBER")) return "SAME_OWNER_ONLY";
  if (relations.every((r) => r !== "INDEPENDENT")) return "OPERATOR_OR_TEST_ONLY";
  return "CROSS_PARTY";
}
