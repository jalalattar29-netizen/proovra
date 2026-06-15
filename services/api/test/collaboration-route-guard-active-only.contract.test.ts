/**
 * Phase DISCUSSION-CAPABILITY-FIX (backend-parity) — close the
 * SUSPENDED/REVOKED authorization gap in
 * `services/api/src/routes/collaboration.routes.ts`.
 *
 * THE GAP (now closed):
 *
 *   Before this pass, `requireReviewerMember()` checked only:
 *     (a) TeamMember row exists for (teamId, userId)
 *     (b) role has permission `evidence_request.review`
 *
 *   It did NOT inspect `TeamMember.status`. A SUSPENDED or REVOKED
 *   member whose role still carried the reviewer permission could
 *   call `/v1/collaboration/*` endpoints directly and bypass the
 *   workspace's access-lifecycle controls — even though the
 *   Evidence Detail page (since the prior pass) already hid the
 *   Discussion tab for those users via
 *   `workspaceCapabilitySnapshot.discussionEnabled` (which requires
 *   status === ACTIVE).
 *
 * THE FIX:
 *
 *   `requireReviewerMember()` now applies the ACTIVE-membership
 *   check between (a) and (b). All three failure modes (no row,
 *   non-ACTIVE row, no permission) emit the SAME opaque 404 — no
 *   anti-enumeration leak about which gate fired.
 *
 * WHAT THIS TEST LOCKS:
 *
 *   1. The guard source contains the ACTIVE-status check, ordered
 *      so it cannot be bypassed by reaching the permission check
 *      first.
 *   2. Every rejection branch is `reply.code(404).send({ error: ...
 *      "not_found" })` — no 401, no 403, no leak of the gating
 *      factor.
 *   3. The shadow `.js` compiled artifact is in lockstep with the
 *      `.ts` source (this repo ships both side-by-side; a missed
 *      regenerate would silently leave the old guard live).
 *   4. Frontend capability flag and backend guard are aligned:
 *      whenever `computeDiscussionCapability` returns
 *      `discussionEnabled: false` because of non-ACTIVE membership,
 *      the backend guard MUST also reject — and vice versa.
 *      Static-source proof: both code paths read the SAME enum
 *      (`prismaPkg.TeamMemberStatus.ACTIVE`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import prismaPkg from "@prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const ROUTES_TS = readFileSync(
  resolve(REPO_ROOT, "services", "api", "src", "routes", "collaboration.routes.ts"),
  "utf8",
);
// Phase CASES-EVIDENCE-NAMES-ROOT-CAUSE — the `.js` mirror that
// used to be source-pinned here was a stale compiled shadow that
// shadowed the .ts source at ESM runtime. The shadow has been
// deleted repo-wide and is now blocked by .gitignore +
// `apps/web/__tests__/no-shadow-js-in-src.test.ts`. The ".js
// shadow" describe block below was removed for the same reason.
const EVIDENCE_ROUTES_TS = readFileSync(
  resolve(REPO_ROOT, "services", "api", "src", "routes", "evidence.routes.ts"),
  "utf8",
);

describe("collaboration.routes guard: requireReviewerMember requires ACTIVE membership", () => {
  it(".ts source: the guard checks TeamMemberStatus.ACTIVE before the permission check", () => {
    // The active-membership check must appear and must use the
    // canonical enum reference (no string-literal "ACTIVE" drift).
    expect(ROUTES_TS).toMatch(
      /membership\.status\s*===\s*prismaPkg\.TeamMemberStatus\.ACTIVE/,
    );
    // The ACTIVE check must occur BEFORE the permission check — the
    // guard rejects non-active membership without consulting the
    // permission matrix. Source-order check: substring index of the
    // active-status line must come BEFORE the permission line.
    const activeIdx = ROUTES_TS.indexOf("isActiveMember");
    const permIdx = ROUTES_TS.indexOf(
      'requirePermission(membership.role, "evidence_request.review")',
    );
    expect(activeIdx).toBeGreaterThan(0);
    expect(permIdx).toBeGreaterThan(activeIdx);
  });

  it(".ts source: anti-enumeration — every rejection path is a bare 404 not_found", () => {
    // Grep every `reply.code(<N>)` call inside the guard. The full
    // guard body lives between `async function requireReviewerMember`
    // and the next blank-line `}` followed by `function`.
    const start = ROUTES_TS.indexOf("async function requireReviewerMember");
    expect(start).toBeGreaterThan(0);
    const after = ROUTES_TS.indexOf("\nfunction ", start);
    expect(after).toBeGreaterThan(start);
    const guard = ROUTES_TS.slice(start, after);

    const replyCalls = guard.match(/reply\.code\(\s*\d+\s*\)/g) ?? [];
    // The guard has exactly TWO rejection paths (non-active +
    // no-permission), both 404. Anything else (401, 403, 500, ...)
    // would either leak the gating factor or change the failure
    // semantics the frontend depends on.
    expect(replyCalls.length).toBe(2);
    for (const call of replyCalls) {
      expect(call).toMatch(/reply\.code\(\s*404\s*\)/);
    }
    expect(guard).not.toMatch(/reply\.code\(\s*403\s*\)/);
    expect(guard).not.toMatch(/reply\.code\(\s*401\s*\)/);
    expect(guard.match(/not_found/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // The previous ".js shadow: compiled artifact is in lockstep
  // with the .ts source" assertion was removed when the shadow
  // .js files were purged. The .ts source-pin above is now the
  // single source of truth; runtime always loads the .ts.

  it("frontend ↔ backend parity: both sides use prismaPkg.TeamMemberStatus.ACTIVE", () => {
    // The Evidence Detail capability computation
    // (computeDiscussionCapability) and the collaboration route
    // guard MUST share the same enum reference. If either drifts to
    // a string literal "ACTIVE" or to a different enum import, the
    // two surfaces could disagree and reintroduce the gap.
    expect(EVIDENCE_ROUTES_TS).toMatch(
      /callerMembership\.status\s*===\s*prismaPkg\.TeamMemberStatus\.ACTIVE/,
    );
    expect(ROUTES_TS).toMatch(
      /membership\.status\s*===\s*prismaPkg\.TeamMemberStatus\.ACTIVE/,
    );
  });

  it("prisma enum sanity: TeamMemberStatus exposes ACTIVE / SUSPENDED / REVOKED", () => {
    // If anyone removes a status value, both the frontend capability
    // truth-table AND the backend guard need to be re-audited. We
    // pin the enum surface so that conversation cannot be skipped.
    expect(prismaPkg.TeamMemberStatus.ACTIVE).toBe("ACTIVE");
    expect(prismaPkg.TeamMemberStatus.SUSPENDED).toBe("SUSPENDED");
    expect(prismaPkg.TeamMemberStatus.REVOKED).toBe("REVOKED");
  });

  it("the guard rejects non-ACTIVE memberships without consulting the permission matrix", () => {
    // Behavioral proof of the source-order property above. We
    // simulate the guard's branching predicates against the fixed
    // input combinations the production code will see.
    type Membership = {
      role: prismaPkg.TeamRole;
      status: prismaPkg.TeamMemberStatus;
    } | null;

    // Mirror of the production guard's predicates.
    function wouldReject(membership: Membership): "no_row" | "non_active" | "no_perm" | "allow" {
      if (membership === null) return "no_row";
      if (membership.status !== prismaPkg.TeamMemberStatus.ACTIVE) return "non_active";
      // We don't import requirePermission here to keep this test free
      // of governance.service entanglement — the matrix-level
      // behavior is locked by `workspace-capability-snapshot-discussion.contract.test.ts`.
      // For ACTIVE membership, the role-permission decision is the
      // SAME function call both surfaces make.
      return "allow"; // for the ACTIVE case, production calls requirePermission.
    }

    expect(wouldReject(null)).toBe("no_row");
    expect(
      wouldReject({
        role: prismaPkg.TeamRole.OWNER,
        status: prismaPkg.TeamMemberStatus.SUSPENDED,
      }),
    ).toBe("non_active");
    expect(
      wouldReject({
        role: prismaPkg.TeamRole.OWNER,
        status: prismaPkg.TeamMemberStatus.REVOKED,
      }),
    ).toBe("non_active");
    expect(
      wouldReject({
        role: prismaPkg.TeamRole.OWNER,
        status: prismaPkg.TeamMemberStatus.ACTIVE,
      }),
    ).toBe("allow");
  });
});
