/**
 * PRO-K1-07 — CASE NOTES, PAGE BY PAGE.
 *
 * The matter workspace returns the newest page of case comments ("notes");
 * older notes were kept but unreachable. This is the one paged reader both the
 * workspace's first page and `GET /v1/cases/:id/comments` use, so every page —
 * not only the first — goes through the canonical note read filter
 * (`caseCommentReadFilter` over `caseCommentVisibilitiesFor`, EVID-011): a note
 * the viewer may not read never appears on any page, and the page boundary is
 * computed after the filter, so a hidden note cannot shift or leak through it.
 *
 * Ordering is stable keyset order: `createdAt DESC, id DESC`. The cursor is the
 * last row's (createdAt, id), opaque to clients. A cursor names a position, not
 * a permission: the filter is re-applied on every request, so a forged or
 * replayed cursor can only move the window, never widen it.
 */
import type * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { caseCommentReadFilter, caseCommentVisibilitiesFor } from "./case-lifecycle.service.js";
import { getCaseAssignmentRoles } from "./case-permission.service.js";

export const CASE_NOTES_PAGE_SIZE = 25;
export const CASE_NOTES_PAGE_MAX = 100;

export type CaseNotesCursor = { createdAt: Date; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCaseNotesCursor(c: CaseNotesCursor): string {
  return Buffer.from(`v1|${c.createdAt.toISOString()}|${c.id}`, "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module wrote. */
export function decodeCaseNotesCursor(raw: string): CaseNotesCursor | null {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [version, iso, id] = text.split("|");
  if (version !== "v1" || !iso || !id || !UUID.test(id)) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, id };
}

/**
 * The canonical note read filter for one viewer of one case — the same inputs
 * the matter workspace resolves (EVID-011).
 */
export async function caseNotesReadFilterForViewer(input: {
  caseId: string;
  caseOwnerUserId: string | null;
  viewerUserId: string;
  accessRole: string;
}): Promise<prismaPkg.Prisma.CaseCommentWhereInput> {
  const assignmentRoles = await getCaseAssignmentRoles(input.caseId, input.viewerUserId);
  return caseCommentReadFilter(
    input.caseId,
    input.viewerUserId,
    caseCommentVisibilitiesFor({
      accessRole: input.accessRole,
      isCaseOwner: input.caseOwnerUserId === input.viewerUserId,
      isAssigned: assignmentRoles.length > 0,
    }),
  );
}

export type CaseNoteRow = {
  id: string;
  authorUserId: string;
  body: string;
  visibility: string;
  resolvedAtUtc: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
};

export type CaseNotesPage = {
  items: CaseNoteRow[];
  /** Cursor for the next (older) page; null when this page is the last. */
  nextCursor: string | null;
  hasMore: boolean;
};

/** One page of the notes `filter` admits, newest first, strictly older than `cursor`. */
export async function listCaseNotesPage(input: {
  filter: prismaPkg.Prisma.CaseCommentWhereInput;
  cursor?: CaseNotesCursor | null;
  limit?: number;
}): Promise<CaseNotesPage> {
  const take = Math.min(Math.max(input.limit ?? CASE_NOTES_PAGE_SIZE, 1), CASE_NOTES_PAGE_MAX);
  const where: prismaPkg.Prisma.CaseCommentWhereInput = input.cursor
    ? {
        AND: [
          input.filter,
          {
            OR: [
              { createdAt: { lt: input.cursor.createdAt } },
              { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
            ],
          },
        ],
      }
    : input.filter;
  const rows = await prisma.caseComment.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      authorUserId: true,
      body: true,
      visibility: true,
      resolvedAtUtc: true,
      resolvedByUserId: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((c) => ({
      id: c.id,
      authorUserId: c.authorUserId,
      body: c.body,
      visibility: String(c.visibility),
      resolvedAtUtc: c.resolvedAtUtc?.toISOString() ?? null,
      resolvedByUserId: c.resolvedByUserId,
      createdAt: c.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCaseNotesCursor({ createdAt: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}
