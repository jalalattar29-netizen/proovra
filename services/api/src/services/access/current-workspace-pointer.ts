/**
 * PHASE 12 REMEDIATION — §4.4 (2026-08-06).
 *
 * ONE canonical repair authority for the `User.currentWorkspaceId`
 * NAVIGATION POINTER.
 *
 * What the pointer is
 * -------------------
 * `User.currentWorkspaceId` records where an operator last chose to be. It
 * is a UI-continuity convenience so a returning session lands back in the
 * context the operator left. It has never been, and must never become, an
 * authorization fact.
 *
 * Why this module exists
 * ----------------------
 * The Phase-12 audit (SEC-001) found the pointer being treated as authority
 * by `external-portal.routes.ts`. That defect is corrected at its ROOT in
 * `middleware/authorize.ts` (`authorizeCurrentWorkspaceOrFail`), which treats
 * the pointer strictly as an INPUT CANDIDATE and revalidates every check
 * against the database.
 *
 * This module is the SECOND, independent half: HYGIENE. When a membership is
 * revoked / suspended / removed, when a user is SCIM-deprovisioned, when a
 * workspace is closed or an Organization suspended, the pointer should stop
 * naming a context the user can no longer enter — otherwise the operator's
 * next visit resolves a context that will only deny.
 *
 * The load-bearing rule
 * ---------------------
 *   AUTHORIZATION MUST NEVER DEPEND ON THIS CLEANUP HAVING RUN.
 *
 * Every function here is best-effort hygiene. A failure to repair a pointer
 * cannot widen access, because the pointer grants nothing. Correspondingly,
 * no function here ever CHOOSES a replacement workspace:
 *
 *   * it clears to NULL, and only to NULL;
 *   * it never "picks the first remaining workspace" — that silently
 *     relocates an operator into a tenant they did not select, which is the
 *     mirror image of the defect being fixed;
 *   * it never relocates into Personal Space — an Organization with
 *     `noPersonalSpace = true` forbids exactly that, and this module has no
 *     business re-deciding it. Context RESTORATION (platform-context) owns
 *     picking a safe next context, and it revalidates DB authority when it
 *     does.
 *
 * Transactionality
 * ----------------
 * Callers pass their own transaction client so the repair commits with the
 * membership mutation that caused it. That makes the pointer consistent at
 * the same instant the access is withdrawn — no window in which the pointer
 * survives a committed revocation.
 */

import { prisma as defaultPrisma } from "../../db.js";

/**
 * Narrow structural client type. Accepts both a `PrismaClient` and an
 * interactive-transaction client without importing Prisma's internal
 * `TransactionClient` type (which is not exported in a stable shape).
 */
export type PointerRepairClient = {
  user: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
};

/**
 * CORRECTIVE PASS (2026-08-06) — STRICT DELEGATE POLICY.
 *
 * The previous pass made an absent `user.updateMany` delegate a silent no-op,
 * so that in-memory test transports which do not model the `user` delegate
 * would not crash. That was the wrong place to solve it: it put a
 * TEST-DRIVEN accommodation into PRODUCTION FAILURE HANDLING, and it meant a
 * genuinely broken client — one where the delegate is missing or has been
 * replaced by something that is not a function — would be reported as a
 * successful repair of zero rows.
 *
 * The accommodation is REMOVED. The delegate is now required by the type and
 * asserted at runtime, and the three service-level suites that inject
 * partial clients supply `user.updateMany` in their own fixtures instead.
 * Test infrastructure adapts to production; production does not soften for
 * test infrastructure.
 *
 * The repair also no longer swallows database errors. It runs inside the
 * caller's transaction, so an error must propagate and roll the whole
 * membership transition back rather than commit a withdrawal whose pointer
 * hygiene silently failed. (This is safe in the other direction too: the
 * pointer grants nothing, so a rolled-back transition leaves access exactly
 * as it was — denied by the canonical primitive on the next request either
 * way.)
 */
function pointerDelegate(client: PointerRepairClient) {
  const fn = client?.user?.updateMany;
  if (typeof fn !== "function") {
    throw new TypeError(
      "currentWorkspaceId pointer repair requires a client exposing user.updateMany",
    );
  }
  return fn.bind(client.user);
}

export type PointerRepairResult = {
  /** How many User rows had their pointer cleared. */
  cleared: number;
};

/**
 * Clear `currentWorkspaceId` for ONE user when — and only when — it currently
 * points at `workspaceId`.
 *
 * Idempotent: a user whose pointer is already NULL, or already points
 * somewhere else, is untouched (`cleared: 0`). Safe to call unconditionally
 * at any membership-withdrawal boundary.
 */
export async function repairStaleCurrentWorkspacePointer(
  input: { userId: string; workspaceId: string },
  client: PointerRepairClient = defaultPrisma as unknown as PointerRepairClient,
): Promise<PointerRepairResult> {
  const update = pointerDelegate(client);
  const res = await update({
    where: { id: input.userId, currentWorkspaceId: input.workspaceId },
    data: { currentWorkspaceId: null },
  });
  return { cleared: res.count };
}

/**
 * Clear `currentWorkspaceId` for EVERY user pointing at any workspace in
 * `workspaceIds`. Used by workspace closure and Organization suspension /
 * closure, where the context becomes unusable for all of its members at once.
 *
 * A caller that already scopes to a single user should prefer
 * `repairStaleCurrentWorkspacePointer` so the write cannot touch anyone else.
 */
export async function repairStaleCurrentWorkspacePointersForWorkspaces(
  input: { workspaceIds: ReadonlyArray<string> },
  client: PointerRepairClient = defaultPrisma as unknown as PointerRepairClient,
): Promise<PointerRepairResult> {
  const ids = input.workspaceIds.filter((id) => typeof id === "string" && id);
  if (ids.length === 0) return { cleared: 0 };
  const update = pointerDelegate(client);
  const res = await update({
    where: { currentWorkspaceId: { in: [...ids] } },
    data: { currentWorkspaceId: null },
  });
  return { cleared: res.count };
}

/**
 * Membership-boundary repair for SEVERAL memberships at once.
 *
 * Takes the `(userId, workspaceId)` pairs the caller ALREADY HOLDS — every
 * withdrawal leg either loads the affected rows before updating them, or
 * receives the updated row back from its own `update()`. Passing them in
 * means this module issues exactly ONE statement and never re-reads
 * TeamMember, so no caller has to widen the client surface it threads
 * through just to satisfy pointer hygiene.
 *
 * Only pointers naming exactly a given pair are cleared: a member revoked
 * from workspace A never has a pointer at workspace B disturbed.
 */
export async function repairStaleCurrentWorkspacePointers(
  input: {
    memberships: ReadonlyArray<{ userId: string; workspaceId: string }>;
  },
  client: PointerRepairClient = defaultPrisma as unknown as PointerRepairClient,
): Promise<PointerRepairResult> {
  const pairs = input.memberships.filter(
    (m) => typeof m?.userId === "string" && typeof m?.workspaceId === "string",
  );
  if (pairs.length === 0) return { cleared: 0 };
  const update = pointerDelegate(client);
  const res = await update({
    where: {
      OR: pairs.map((m) => ({
        id: m.userId,
        currentWorkspaceId: m.workspaceId,
      })),
    },
    data: { currentWorkspaceId: null },
  });
  return { cleared: res.count };
}

// CORRECTIVE PASS (2026-08-06) — `repairStaleCurrentWorkspacePointerBestEffort`
// was REMOVED. It swallowed every error and had ZERO production callers, so it
// was dead code that also stood as an invitation to silence a real database
// failure at a membership-withdrawal boundary. If a genuinely post-commit,
// non-transactional sweep is ever needed, it should be written then — with its
// own explicit error handling and an owner — rather than kept on standby here.
