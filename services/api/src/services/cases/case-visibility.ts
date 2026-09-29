/**
 * WHO MAY SEE A CASE (2026-09-29) — the restricted-case rule, once.
 *
 * A case with an access list is visible only to its owner and the people on
 * the list; a case with no access list is visible to its workspace. Every case
 * surface applies this rule; Reports and exchange-package creation now share
 * this one predicate instead of each restating it.
 *
 * With no caller (a machine path) only unrestricted cases are visible.
 */
import type { Prisma } from "@prisma/client";

export function caseVisibleToWhere(callerUserId: string | null | undefined): Prisma.CaseWhereInput {
  return callerUserId
    ? {
        OR: [
          { access: { none: {} } },
          { access: { some: { userId: callerUserId } } },
          { ownerUserId: callerUserId },
        ],
      }
    : { access: { none: {} } };
}
