/**
 * PROOVRA Phase 4A Closure — Trust Article drift detection.
 *
 * Walks every TrustCenterArticle row in the workspace, resolves
 * each entry in `implementationReferences` against the monorepo
 * root, and marks the article CURRENT or STALE based on whether
 * every cited path still exists.
 *
 * Hard rules:
 *   * Workspace-anchored — every entry point requires `teamId`.
 *   * Bounded `driftState` vocabulary from
 *     `@proovra/shared/trust-and-governance.ts` (CURRENT / STALE /
 *     NEEDS_REVIEW).
 *   * Path checks use `node:fs.existsSync` ONLY — we never read
 *     the contents of cited files.
 *   * NEVER raw article body in lifecycle event payloads — only
 *     bounded ids + counts.
 *   * Lifecycle emission via the existing
 *     `intelligence-activity.service.ts` write path so the audit
 *     federator sees one canonical event stream.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  TRUST_ARTICLE_DRIFT_STATES,
  type TrustArticleDriftState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTrustArticleEvent } from "./trust-and-governance-audit.service.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RunTrustArticleDriftScanInput = {
  prisma?: PrismaClient;
  teamId: string;
};

export type RunTrustArticleDriftScanResult = {
  scanned: number;
  current: number;
  stale: number;
  missingReferenceCount: number;
};

/**
 * Re-scan every TrustCenterArticle in the workspace and update its
 * `driftState` + `missingReferences` + `lastReferenceCheckAt`.
 *
 * Emits a TRUST_ARTICLE_MARKED_STALE lifecycle event when the row
 * transitions CURRENT -> STALE. Other transitions (STALE -> CURRENT,
 * NEEDS_REVIEW -> *) update the row in place without emitting; the
 * mutation audit stream owns those signals.
 */
export async function runTrustArticleDriftScan(
  input: RunTrustArticleDriftScanInput,
): Promise<RunTrustArticleDriftScanResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const monorepoRoot = resolveMonorepoRoot();

  const rows = await prisma.trustCenterArticle.findMany({
    where: { teamId: input.teamId },
    select: {
      id: true,
      kind: true,
      slug: true,
      driftState: true,
      implementationReferences: true,
    },
  });

  let current = 0;
  let stale = 0;
  let missingReferenceCount = 0;

  for (const row of rows) {
    const refs = parseImplementationReferences(row.implementationReferences);
    const missing: string[] = [];
    for (const ref of refs) {
      const absolute = isAbsolute(ref) ? ref : resolve(monorepoRoot, ref);
      if (!existsSync(absolute)) {
        missing.push(ref);
      }
    }

    const previousState = normalizeDriftState(row.driftState ?? null);
    const nextState: TrustArticleDriftState =
      missing.length === 0 ? "CURRENT" : "STALE";

    await prisma.trustCenterArticle.update({
      where: { id: row.id },
      data: {
        driftState: nextState,
        lastReferenceCheckAt: new Date(),
        missingReferences:
          missing.length === 0 ? Prisma.JsonNull : (missing as never),
      },
    });

    if (nextState === "CURRENT") current += 1;
    else stale += 1;
    missingReferenceCount += missing.length;

    if (previousState === "CURRENT" && nextState === "STALE") {
      // Bounded payload only — id + counts. Never the article body
      // or the missing path strings (they may reveal internal file
      // tree shape beyond the public references list).
      await emitTrustArticleEvent({
        prisma,
        teamId: input.teamId,
        articleId: row.id,
        code: "TRUST_ARTICLE_MARKED_STALE",
        reason: `missing=${missing.length}`,
        payload: {
          articleId: row.id,
          kind: row.kind,
          slug: row.slug,
          missingCount: missing.length,
        },
      });
    }
  }

  return {
    scanned: rows.length,
    current,
    stale,
    missingReferenceCount,
  };
}

export type ListStaleTrustArticlesInput = {
  prisma?: PrismaClient;
  teamId: string;
};

export type StaleTrustArticleProjection = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  missingReferences: ReadonlyArray<string>;
  lastReferenceCheckAtUtc: string | null;
};

/**
 * Bounded read of every TrustCenterArticle currently flagged STALE.
 * Used by the governance dashboard + drift remediation surface.
 */
export async function listStaleTrustArticles(
  input: ListStaleTrustArticlesInput,
): Promise<ReadonlyArray<StaleTrustArticleProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.trustCenterArticle.findMany({
    where: { teamId: input.teamId, driftState: "STALE" },
    select: {
      id: true,
      kind: true,
      slug: true,
      title: true,
      missingReferences: true,
      lastReferenceCheckAt: true,
    },
    orderBy: [{ kind: "asc" }, { slug: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    missingReferences: parseImplementationReferences(r.missingReferences),
    lastReferenceCheckAtUtc: r.lastReferenceCheckAt?.toISOString() ?? null,
  }));
}

export type MarkArticleNeedsReviewInput = {
  prisma?: PrismaClient;
  teamId: string;
  articleId: string;
  actorUserId: string;
  reason: string;
};

/**
 * Operator-driven transition: flag a trust article as needing a
 * human re-validation pass. Emits TRUST_ARTICLE_REVIEWED so the
 * audit federator records the decision.
 */
export async function markArticleNeedsReview(
  input: MarkArticleNeedsReviewInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.trustCenterArticle.findFirst({
    where: { id: input.articleId, teamId: input.teamId },
    select: { id: true },
  });
  if (!row) return { ok: false };

  await prisma.trustCenterArticle.update({
    where: { id: row.id },
    data: { driftState: "NEEDS_REVIEW" },
  });

  await emitTrustArticleEvent({
    prisma,
    teamId: input.teamId,
    articleId: row.id,
    code: "TRUST_ARTICLE_REVIEWED",
    actorUserId: input.actorUserId,
    reason: input.reason.slice(0, 200),
    payload: {
      articleId: row.id,
      transition: "NEEDS_REVIEW",
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `implementationReferences` JSON column into a typed
 * string array. Anything non-string is dropped silently — the column
 * is bounded by the upsert path but we defend in depth.
 */
function parseImplementationReferences(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry);
    }
  }
  return out;
}

function normalizeDriftState(value: string | null): TrustArticleDriftState {
  if (!value) return "CURRENT";
  return (TRUST_ARTICLE_DRIFT_STATES as ReadonlyArray<string>).includes(value)
    ? (value as TrustArticleDriftState)
    : "CURRENT";
}

/**
 * Walk upward from `process.cwd()` until we find a directory that
 * contains `packages/shared`. That anchor is the monorepo root and
 * is what every entry in `implementationReferences` is relative to.
 *
 * Falls back to `process.cwd()` if no anchor is found — drift will
 * then mark every relative reference STALE, which is the correct
 * honest verdict in a mis-configured runtime.
 */
function resolveMonorepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(current, "packages", "shared"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}
