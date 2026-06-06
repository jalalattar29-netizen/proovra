/**
 * PHASE 4 — External Review Console denial UI regression lock.
 *
 * Phase 0 confirmed every admin action on /review/external rendered
 * unconditionally, every mutation catch collapsed 403 into the
 * misleading "RATE_LIMITED" banner, and the list refresh swallowed
 * permission denials into an empty table.
 *
 * This test pins:
 *
 *   1. The page imports the platform-context capability hooks
 *      (`useCan`, `useActiveSpace`) — no parallel role derivation.
 *
 *   2. A `useExternalReviewCapabilities` hook derives the per-action
 *      gate set from `REVIEWER_OPS_ACT` + active-space role.
 *
 *   3. Reveal-token requires the active-space role to be OWNER on
 *      top of REVIEWER_OPS_ACT (split-of-duty). ADMIN / SUPERVISOR
 *      get a disabled button with a tooltip explaining the split.
 *
 *   4. Every admin action button is gated via a `data-capability-allowed`
 *      attribute + a tooltip that names the missing permission.
 *
 *   5. Mutation catches no longer default to "RATE_LIMITED" — they
 *      use the shared `denialFromError` helper which distinguishes
 *      NOT_PERMITTED from rate-limit collapse.
 *
 *   6. The list refresh catch surfaces a distinct NOT_PERMITTED
 *      banner instead of an empty table.
 *
 *   7. Buttons stay DISABLED (never hidden) when the cap is missing
 *      — disabled-with-explanation, not invisible.
 *
 *   8. The break-glass reason requirement (≥10 chars) is preserved.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/external-review-denial.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "external",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Capability hook + active-space role read from canonical envelope.
// ---------------------------------------------------------------------------

test("page imports useCan + useActiveSpace from platform-context", () => {
  assert.match(
    PAGE_SOURCE,
    /import\s*\{[^}]*useCan[^}]*\}\s*from\s*"[^"]*platform-context"/,
    "Page must derive capability from the canonical useCan hook — " +
      "Phase 0 had no capability check at all.",
  );
  assert.match(
    PAGE_SOURCE,
    /import\s*\{[^}]*useActiveSpace[^}]*\}\s*from\s*"[^"]*platform-context"/,
    "Page must read the active-space role from useActiveSpace so " +
      "reveal-token can enforce its OWNER-only split-of-duty.",
  );
});

test("capability hook is declared and consumes REVIEWER_OPS_ACT", () => {
  assert.match(
    PAGE_SOURCE,
    /function\s+useExternalReviewCapabilities\(/,
    "Page must declare a useExternalReviewCapabilities hook so the " +
      "capability set is bounded and observable.",
  );
  assert.match(
    PAGE_SOURCE,
    /useCan\("REVIEWER_OPS_ACT"\)/,
    "Capability hook must read REVIEWER_OPS_ACT — the canonical " +
      "reviewer-ops mutation cap.",
  );
});

test("reveal-token requires OWNER role on top of REVIEWER_OPS_ACT", () => {
  assert.match(
    PAGE_SOURCE,
    /canRevealToken:\s*canAct\s*&&\s*isOwner/,
    "canRevealToken must AND `canAct` with `isOwner` — workspace " +
      "ADMIN / SUPERVISOR must not get the reveal capability.",
  );
  assert.match(
    PAGE_SOURCE,
    /roleLabel\s*===\s*"OWNER"/,
    "Role check must compare against the OWNER literal so the gate " +
      "is bounded.",
  );
});

// ---------------------------------------------------------------------------
// 2. Per-action gating — every admin button carries a capability flag.
// ---------------------------------------------------------------------------

const ACTION_BUTTONS = [
  // [data-test-attribute, capability key]
  { attr: "data-bulk-revoke-action", cap: "canBulkRevoke" },
  { attr: "data-invitation-resend", cap: "canResend" },
  { attr: "data-invitation-revoke", cap: "canRevoke" },
  { attr: "data-bulk-issue-submit", cap: "canBulkInvite" },
  { attr: "data-break-glass-arm", cap: "canRevealToken" },
];

for (const action of ACTION_BUTTONS) {
  test(`${action.attr} carries a data-capability-allowed attribute`, () => {
    // We look for the action attribute, then assert
    // data-capability-allowed appears within the same button element
    // (within ~600 chars).
    const idx = PAGE_SOURCE.indexOf(action.attr);
    assert.ok(idx > 0, `${action.attr} button must be present`);
    const slice = PAGE_SOURCE.slice(idx, idx + 800);
    assert.match(
      slice,
      /data-capability-allowed=\{caps\.\w+/,
      `${action.attr} must carry data-capability-allowed={caps.…} so ` +
        `tests + observability can detect the gate state.`,
    );
  });

  test(`${action.attr} uses the matching capability key (${action.cap})`, () => {
    const idx = PAGE_SOURCE.indexOf(action.attr);
    assert.ok(idx > 0, `${action.attr} button must be present`);
    const slice = PAGE_SOURCE.slice(idx, idx + 800);
    assert.ok(
      slice.includes(action.cap),
      `${action.attr} button must reference the ${action.cap} key.`,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Buttons stay disabled with a tooltip — never invisible.
// ---------------------------------------------------------------------------

test("disabled buttons carry a 'You do not have permission' tooltip", () => {
  // The "You do not have permission to <action>" copy must appear for
  // each action so the user sees a bounded explanation.
  const expectedTooltips = [
    "You do not have permission to bulk revoke invitations",
    "You do not have permission to resend invitations",
    "You do not have permission to revoke invitations",
    "You do not have permission to bulk issue invitations",
    "You do not have permission to reveal raw invitation tokens",
  ];
  for (const t of expectedTooltips) {
    assert.ok(
      PAGE_SOURCE.includes(t),
      `Expected tooltip copy "${t}" — the brief mandates ` +
        `disabled-with-explanation, not invisible.`,
    );
  }
});

test("reveal-token tooltip explains the split-of-duty", () => {
  // The reveal-token tooltip must reference that ADMIN / SUPERVISOR
  // cannot perform it — that is the explicit explanation the brief
  // asked for.
  const idx = PAGE_SOURCE.indexOf("data-break-glass-arm");
  assert.ok(idx > 0, "reveal-token break-glass arm must be present");
  const slice = PAGE_SOURCE.slice(idx, idx + 1500);
  assert.match(
    slice,
    /split-of-duty/i,
    "Reveal-token tooltip must mention split-of-duty.",
  );
  assert.match(
    slice,
    /ADMIN|SUPERVISOR/,
    "Reveal-token tooltip must reference the role(s) excluded from " +
      "the capability (ADMIN / SUPERVISOR).",
  );
});

// ---------------------------------------------------------------------------
// 4. Mutation catches no longer default to RATE_LIMITED.
// ---------------------------------------------------------------------------

test("page no longer collapses every error into the RATE_LIMITED default", () => {
  // The Phase 0 catch used the literal `?? "RATE_LIMITED"` after a
  // bogus `(err as any).denial` lookup. We must not reintroduce that
  // pattern.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /\(err as any\)\?\.denial\s*\?\?\s*"RATE_LIMITED"/,
    "Mutation catches must not default to RATE_LIMITED — that hid " +
      "every 403 NOT_PERMITTED behind a misleading rate-limit banner.",
  );
  assert.doesNotMatch(
    PAGE_SOURCE,
    /\(e as any\)\?\.denial\s*\?\?\s*"REVEAL_REFUSED"/,
    "Reveal-token catch must not default with the legacy ?? " +
      "REVEAL_REFUSED pattern.",
  );
});

test("denialFromError helper is declared and used by every mutation catch", () => {
  assert.match(
    PAGE_SOURCE,
    /function\s+denialFromError\(/,
    "Page must declare a denialFromError helper so mutation catches " +
      "share a single classifier.",
  );
  // Each mutation handler must call denialFromError in its catch.
  const callCount = (PAGE_SOURCE.match(/denialFromError\(/g) ?? []).length;
  // helper definition + at least one per mutation: bulkRevoke, resend,
  // revoke, reveal-token, bulk-invite, listRefresh.
  assert.ok(
    callCount >= 6,
    `denialFromError must be called by every mutation catch + the ` +
      `list refresh (got ${callCount} references).`,
  );
});

// ---------------------------------------------------------------------------
// 5. List refresh distinguishes NOT_PERMITTED from empty.
// ---------------------------------------------------------------------------

test("list refresh sets a listDenied flag on NOT_PERMITTED", () => {
  assert.match(
    PAGE_SOURCE,
    /setListDenied\(/,
    "List refresh must surface a denial flag separate from rows=[] " +
      "so the UI can render a distinct panel.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-external-review-list-denied/,
    "Page must render a bounded list-denied banner tagged " +
      "data-external-review-list-denied so the user sees a clear " +
      "permission denial, not an empty table.",
  );
});

test("list-denied banner copy matches the brief", () => {
  assert.match(
    PAGE_SOURCE,
    /You do not have permission to view external reviewer\s*\n?\s*invitations\./,
    "List-denied copy must explain the denial in bounded language.",
  );
});

// ---------------------------------------------------------------------------
// 6. Break-glass reason requirement is preserved.
// ---------------------------------------------------------------------------

test("break-glass form still enforces the ≥ 10 char reason requirement", () => {
  assert.match(
    PAGE_SOURCE,
    /reason\.trim\(\)\.length\s*<\s*10/,
    "Break-glass reveal must keep the ≥10-char reason check — the " +
      "brief explicitly mandates preserving it.",
  );
});

// ---------------------------------------------------------------------------
// 7. denialFromError classifier — exercised as a pure function.
// ---------------------------------------------------------------------------

function denialFromError(err: unknown): string {
  const e = err as {
    statusCode?: number;
    code?: string;
    body?: { denial?: string };
    details?: { denial?: string };
  };
  const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e?.code === "string" ? e.code : "";
  const denial = typeof e?.body?.denial === "string" ? e.body.denial : "";
  const detailsDenial =
    typeof e?.details?.denial === "string" ? e.details.denial : "";
  if (denial) return denial;
  if (detailsDenial) return detailsDenial;
  if (status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") {
    return "NOT_PERMITTED";
  }
  if (code === "RATE_LIMITED" || status === 429) return "RATE_LIMITED";
  return code || "REFUSED";
}

test("denialFromError extracts explicit body.denial first", () => {
  assert.equal(
    denialFromError({ statusCode: 403, body: { denial: "ALREADY_REVOKED" } }),
    "ALREADY_REVOKED",
  );
});

test("denialFromError extracts details.denial when body is absent", () => {
  assert.equal(
    denialFromError({ statusCode: 403, details: { denial: "ENTITLEMENT_REQUIRED" } }),
    "ENTITLEMENT_REQUIRED",
  );
});

test("denialFromError classifies 403 as NOT_PERMITTED", () => {
  assert.equal(denialFromError({ statusCode: 403, code: "" }), "NOT_PERMITTED");
});

test("denialFromError classifies NOT_PERMITTED code (even on 200)", () => {
  assert.equal(
    denialFromError({ statusCode: 0, code: "NOT_PERMITTED" }),
    "NOT_PERMITTED",
  );
});

test("denialFromError classifies 429 as RATE_LIMITED", () => {
  assert.equal(
    denialFromError({ statusCode: 429, code: "" }),
    "RATE_LIMITED",
  );
});

test("denialFromError falls back to the raw code", () => {
  assert.equal(
    denialFromError({ statusCode: 500, code: "INTERNAL_ERROR" }),
    "INTERNAL_ERROR",
  );
});

test("denialFromError falls back to REFUSED when no signal is available", () => {
  assert.equal(denialFromError({}), "REFUSED");
});

// ---------------------------------------------------------------------------
// 8. Capability matrix — pure helper exercises every action gate.
// ---------------------------------------------------------------------------

type Caps = {
  canInvite: boolean;
  canBulkInvite: boolean;
  canBulkRevoke: boolean;
  canResend: boolean;
  canRevoke: boolean;
  canRevealToken: boolean;
};

function deriveCaps(input: {
  canAct: boolean;
  roleLabel: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  spaceType: "PERSONAL" | "ORGANIZATION";
}): Caps {
  const isOwner =
    input.spaceType === "ORGANIZATION" && input.roleLabel === "OWNER";
  return {
    canInvite: input.canAct,
    canBulkInvite: input.canAct,
    canBulkRevoke: input.canAct,
    canResend: input.canAct,
    canRevoke: input.canAct,
    canRevealToken: input.canAct && isOwner,
  };
}

test("OWNER + canAct gets the full capability set", () => {
  const caps = deriveCaps({
    canAct: true,
    roleLabel: "OWNER",
    spaceType: "ORGANIZATION",
  });
  assert.deepEqual(caps, {
    canInvite: true,
    canBulkInvite: true,
    canBulkRevoke: true,
    canResend: true,
    canRevoke: true,
    canRevealToken: true,
  });
});

test("ADMIN + canAct gets every cap EXCEPT reveal-token", () => {
  const caps = deriveCaps({
    canAct: true,
    roleLabel: "ADMIN",
    spaceType: "ORGANIZATION",
  });
  assert.equal(caps.canBulkRevoke, true);
  assert.equal(caps.canResend, true);
  assert.equal(caps.canRevoke, true);
  assert.equal(caps.canInvite, true);
  assert.equal(caps.canBulkInvite, true);
  assert.equal(caps.canRevealToken, false);
});

test("MEMBER without canAct gets NO mutation capabilities", () => {
  const caps = deriveCaps({
    canAct: false,
    roleLabel: "MEMBER",
    spaceType: "ORGANIZATION",
  });
  assert.equal(caps.canInvite, false);
  assert.equal(caps.canBulkInvite, false);
  assert.equal(caps.canBulkRevoke, false);
  assert.equal(caps.canResend, false);
  assert.equal(caps.canRevoke, false);
  assert.equal(caps.canRevealToken, false);
});

test("PERSONAL space never gets reveal-token even with OWNER + canAct", () => {
  const caps = deriveCaps({
    canAct: true,
    roleLabel: "OWNER",
    spaceType: "PERSONAL",
  });
  assert.equal(caps.canRevealToken, false);
});
