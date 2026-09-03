/**
 * Platform Control Center — Global Search aggregation service.
 *
 * READ-ONLY, platform-admin-only search across the core platform entities.
 * Backs GET /v1/admin/search. NOTHING here mutates state, recomputes an
 * evidence hash, touches custody/signing/reports, or reads a secret.
 *
 * SAFETY CONTRACT (the whole point of this module):
 *   - Every query selects ONLY non-secret, operator-safe columns. It NEVER
 *     reads or projects:
 *       • User.passwordHash / any token / any credential
 *       • Evidence.fileSha256 / storageKey / storageBucket / any hash-derived
 *         secret / any file BYTES / internalNotes
 *       • Report / VerificationPackage storageKey / storageBucket
 *   - Evidence results expose ID + a title/filename METADATA label ONLY —
 *     never file content, never a cryptographic secret.
 *   - The single permitted PII field is `email` / `workEmail`, which the
 *     existing admin roster pages (users, organizations, demo-requests,
 *     contact-sales) already display to the same platform-admin audience.
 *   - Soft-deleted Evidence (deletedAt != null) is excluded.
 *
 * Every result is a uniform, link-first shape:
 *   { type, id, label, sublabel, href }
 * where `href` deep-links to the existing admin detail / roster surface.
 * Each entity is bounded (default max 10 rows) and queried in parallel;
 * an entity that matches nothing returns an honest empty array.
 */

import type { PrismaClient } from "@prisma/client";

import { customerOrganizationWhere } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

// Uniform, secret-free result shape returned for every entity type.
export type AdminSearchResult = {
  type: AdminSearchType;
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
};

export type AdminSearchType =
  | "organization"
  | "user"
  | "team"
  | "demoRequest"
  | "contactSalesRequest"
  | "evidence"
  | "report"
  | "verificationPackage";

export const ALL_SEARCH_TYPES: readonly AdminSearchType[] = [
  "organization",
  "user",
  "team",
  "demoRequest",
  "contactSalesRequest",
  "evidence",
  "report",
  "verificationPackage",
] as const;

export type AdminSearchGroup = {
  type: AdminSearchType;
  results: AdminSearchResult[];
};

export type AdminSearchResponse = {
  query: string;
  groups: AdminSearchGroup[];
  /** Sum of the returned group lengths — a FLOOR when `truncated` is true. */
  total: number;
  /** The per-type `take` every group ran with. */
  perTypeLimit: number;
  /** True when at least one group came back full and was therefore cut off. */
  truncated: boolean;
  /** The group types that were cut off. */
  truncatedGroups: string[];
};

export type AdminSearchFilters = {
  query: string;
  /** When provided, restricts the search to these entity types. */
  types?: AdminSearchType[];
  /** Max results PER entity type (bounded, default 10). */
  perTypeLimit?: number;
};

const insensitive = (q: string) =>
  ({ contains: q, mode: "insensitive" } as const);

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Run a bounded, secret-free global search across the requested entity types.
 * Queries run in parallel; each returns at most `perTypeLimit` rows.
 */
export async function adminGlobalSearch(
  filters: AdminSearchFilters,
  client: PrismaClient = defaultPrisma,
): Promise<AdminSearchResponse> {
  const query = filters.query.trim();
  const limit = Math.min(50, Math.max(1, filters.perTypeLimit ?? 10));

  // Which types to run. Unknown types are ignored; empty → all.
  const requested =
    filters.types && filters.types.length > 0
      ? ALL_SEARCH_TYPES.filter((t) => filters.types!.includes(t))
      : [...ALL_SEARCH_TYPES];

  const wants = (t: AdminSearchType): boolean => requested.includes(t);

  const q = query;

  // --- Parallel, bounded, non-secret projections per entity ----------------
  const [
    organizations,
    users,
    teams,
    demoRequests,
    contactSalesRequests,
    evidence,
    reports,
    verificationPackages,
  ] = await Promise.all([
    wants("organization")
      ? client.organization.findMany({
          // CUSTOMER only. A SYSTEM organization is the 1:1 bootstrap
          // container behind a workspace, not a company anyone sells to,
          // and this result links to `/admin/customers/:id`, a surface that
          // is itself CUSTOMER-scoped. Returning SYSTEM rows here therefore
          // both misrepresented a container as a customer AND produced a
          // result that dead-ended in a 404 when opened.
          where: {
            ...customerOrganizationWhere(),
            OR: [{ name: insensitive(q) }, { legalName: insensitive(q) }],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // id + name/legalName ONLY. No billing owner PII, no secrets.
          select: { id: true, name: true, legalName: true, status: true },
        })
      : Promise.resolve([]),

    wants("user")
      ? client.user.findMany({
          where: {
            OR: [{ email: insensitive(q) }, { displayName: insensitive(q) }],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // email is the single permitted PII field (already shown on the
          // /admin/users roster). NO passwordHash, NO providerUserId secret.
          select: {
            id: true,
            email: true,
            displayName: true,
            platformRole: true,
          },
        })
      : Promise.resolve([]),

    wants("team")
      ? client.team.findMany({
          where: {
            OR: [{ name: insensitive(q) }, { legalName: insensitive(q) }],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // id + workspace name/legalName ONLY.
          select: { id: true, name: true, legalName: true, billingPlan: true },
        })
      : Promise.resolve([]),

    wants("demoRequest")
      ? client.demoRequest.findMany({
          where: {
            OR: [
              { workEmail: insensitive(q) },
              { organization: insensitive(q) },
              { fullName: insensitive(q) },
            ],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // workEmail/organization/fullName metadata — same fields the
          // demo-requests roster shows. NO message body, NO UTM/referrer.
          select: {
            id: true,
            workEmail: true,
            organization: true,
            fullName: true,
            status: true,
          },
        })
      : Promise.resolve([]),

    wants("contactSalesRequest")
      ? client.contactSalesRequest.findMany({
          where: {
            OR: [
              { workEmail: insensitive(q) },
              { organization: insensitive(q) },
              { fullName: insensitive(q) },
            ],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // workEmail/organization/fullName metadata only. NO challenge text,
          // NO ipAddress/userAgent, NO UTM/referrer.
          select: {
            id: true,
            workEmail: true,
            organization: true,
            fullName: true,
            status: true,
          },
        })
      : Promise.resolve([]),

    wants("evidence")
      ? client.evidence.findMany({
          where: {
            // Soft-deleted evidence is excluded.
            deletedAt: null,
            OR: [
              { title: insensitive(q) },
              { originalFileName: insensitive(q) },
              { displayFileName: insensitive(q) },
            ],
          },
          take: limit,
          orderBy: { createdAt: "desc" },
          // ID + title/filename METADATA ONLY. NEVER fileSha256, storageKey,
          // storageBucket, internalNotes, or any file bytes.
          select: {
            id: true,
            title: true,
            originalFileName: true,
            displayFileName: true,
            type: true,
          },
        })
      : Promise.resolve([]),

    wants("report")
      ? client.report.findMany({
          // Reports have no free-text title column that is user-searchable
          // beyond a snapshot; match on id (exact) plus the display-title
          // snapshot metadata. Never expose storageKey/storageBucket.
          where: {
            OR: [
              { displayTitleSnapshot: insensitive(q) },
              ...(isUuidLike(q) ? [{ id: q }, { evidenceId: q }] : []),
            ],
          },
          take: limit,
          orderBy: { generatedAtUtc: "desc" },
          select: {
            id: true,
            evidenceId: true,
            version: true,
            displayTitleSnapshot: true,
          },
        })
      : Promise.resolve([]),

    wants("verificationPackage")
      ? client.verificationPackage.findMany({
          where: {
            OR: [
              ...(isUuidLike(q) ? [{ id: q }, { evidenceId: q }] : []),
              { packageType: insensitive(q) },
            ],
          },
          take: limit,
          orderBy: { generatedAtUtc: "desc" },
          // id + evidenceId + version + packageType. Never storageKey/bucket.
          select: {
            id: true,
            evidenceId: true,
            version: true,
            packageType: true,
          },
        })
      : Promise.resolve([]),
  ]);

  // --- Project rows → uniform, link-first, secret-free results -------------
  const groups: AdminSearchGroup[] = [];

  const pushGroup = (type: AdminSearchType, results: AdminSearchResult[]) => {
    groups.push({ type, results });
  };

  if (wants("organization")) {
    pushGroup(
      "organization",
      organizations.map((o) => ({
        type: "organization" as const,
        id: o.id,
        label: firstNonEmpty(o.name, o.legalName) ?? o.id,
        sublabel: o.status ?? null,
        href: `/admin/customers/${encodeURIComponent(o.id)}`,
      })),
    );
  }

  if (wants("user")) {
    pushGroup(
      "user",
      users.map((u) => ({
        type: "user" as const,
        id: u.id,
        label: firstNonEmpty(u.email, u.displayName) ?? u.id,
        sublabel: u.platformRole ? "Platform admin" : firstNonEmpty(u.displayName),
        // ADM-017 — a REAL detail route. This used to emit
        // `/admin/users?search=<email>` because the roster had no `:id`
        // detail — and the roster never read the parameter either, so the link
        // silently landed on an unfiltered page 1 that might not even contain
        // the user searched for. Both halves are fixed: the detail page exists
        // and the roster honours `?search=`.
        href: `/admin/users/${encodeURIComponent(u.id)}`,
      })),
    );
  }

  if (wants("team")) {
    pushGroup(
      "team",
      teams.map((t) => ({
        type: "team" as const,
        id: t.id,
        label: firstNonEmpty(t.name, t.legalName) ?? t.id,
        sublabel: t.billingPlan ?? null,
        // ADM-018 — the workspace's OWN detail route. This used to point at
        // the customer roster, whose search matches an organization name or an
        // owner email and never a workspace name — so a workspace search could
        // not match even in principle. A workspace directory now exists.
        href: `/admin/workspaces/${encodeURIComponent(t.id)}`,
      })),
    );
  }

  if (wants("demoRequest")) {
    pushGroup(
      "demoRequest",
      demoRequests.map((d) => ({
        type: "demoRequest" as const,
        id: d.id,
        label: firstNonEmpty(d.workEmail, d.fullName) ?? d.id,
        sublabel: firstNonEmpty(d.organization, d.status),
        href: `/admin/demo-requests/${encodeURIComponent(d.id)}`,
      })),
    );
  }

  if (wants("contactSalesRequest")) {
    pushGroup(
      "contactSalesRequest",
      contactSalesRequests.map((c) => ({
        type: "contactSalesRequest" as const,
        id: c.id,
        label: firstNonEmpty(c.workEmail, c.fullName) ?? c.id,
        sublabel: firstNonEmpty(c.organization, c.status),
        href: `/admin/contact-sales/${encodeURIComponent(c.id)}`,
      })),
    );
  }

  if (wants("evidence")) {
    pushGroup(
      "evidence",
      evidence.map((e) => ({
        type: "evidence" as const,
        id: e.id,
        // Title/filename METADATA only — never content.
        label:
          firstNonEmpty(e.title, e.displayFileName, e.originalFileName) ?? e.id,
        sublabel: e.type ?? null,
        // ADM-019 — the id SURVIVES the click. This used to be a bare
        // `/admin/evidence-ops`, a page of global counters that discarded the
        // record entirely: the operator searched for one piece of evidence and
        // landed somewhere it did not appear in any form.
        href: `/admin/evidence-ops/records?evidenceId=${encodeURIComponent(e.id)}`,
      })),
    );
  }

  if (wants("report")) {
    pushGroup(
      "report",
      reports.map((r) => ({
        type: "report" as const,
        id: r.id,
        label: firstNonEmpty(r.displayTitleSnapshot) ?? `Report ${r.id}`,
        sublabel: `v${r.version}`,
        // ADM-019 — a report is ABOUT a piece of evidence, so the drill-down
        // resolves that record rather than dropping the identity.
        href: `/admin/evidence-ops/records?evidenceId=${encodeURIComponent(r.evidenceId)}`,
      })),
    );
  }

  if (wants("verificationPackage")) {
    pushGroup(
      "verificationPackage",
      verificationPackages.map((p) => ({
        type: "verificationPackage" as const,
        id: p.id,
        label: firstNonEmpty(p.packageType) ?? `Package ${p.id}`,
        sublabel: `v${p.version}`,
        // ADM-019 — same rule for a verification package.
        href: `/admin/evidence-ops/records?evidenceId=${encodeURIComponent(p.evidenceId)}`,
      })),
    );
  }

  const total = groups.reduce((sum, g) => sum + g.results.length, 0);

  // `total` is the sum of what the GROUPS RETURNED, and each group ran with
  // its own `take: limit`. A group that came back exactly full was cut off,
  // which makes the sum a floor, not a count — and the page presented it as
  // "N matches". Both facts travel with the result so the surface can say so.
  const truncatedGroups = groups
    .filter((g) => g.results.length >= limit)
    .map((g) => g.type);

  return {
    query,
    groups,
    total,
    perTypeLimit: limit,
    truncated: truncatedGroups.length > 0,
    truncatedGroups,
  };
}

// A cheap UUID-shape guard so we only add exact id/evidenceId equality
// predicates when the needle actually looks like a UUID (avoids scanning
// id columns with a `contains` on arbitrary text).
function isUuidLike(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value.trim(),
  );
}
