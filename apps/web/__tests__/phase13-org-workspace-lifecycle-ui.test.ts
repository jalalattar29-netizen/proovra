/**
 * PHASE 13 — organization / workspace lifecycle routes that had no product
 * surface at all.
 *
 * Seven registered routes, each a core lifecycle capability, each reachable
 * only with a REST client before this change:
 *
 *   POST /v1/orgs/:id/members/:memberId/suspend
 *   POST /v1/orgs/:id/members/:memberId/restore
 *   POST /v1/orgs/:id/workspaces/:teamId/suspend
 *   POST /v1/orgs/:id/workspaces/:teamId/resume
 *   POST /v1/teams
 *   POST /v1/teams/:id/reopen
 *   POST /v1/teams/:id/transfer-ownership
 *
 * These are pinned by SOURCE SHAPE, following the house convention: what is
 * being defended is that the control EXISTS, addresses the right path with
 * the right method through the canonical client, and carries the states a
 * control that talks to a server must carry — in flight, denied, failed,
 * succeeded, announced. A control that renders but cannot say what happened
 * is the defect this file exists to prevent coming back.
 *
 * Every route is asserted for:
 *   · the exact path + method via `apiFetch` (never a bare relative fetch)
 *   · a real <button> that is disabled while in flight / when not permitted
 *   · aria-busy while the request is open
 *   · role="status" + aria-live announcing success and failure
 *   · a 403 branch whose copy says the caller lacks permission
 *   · a bounded server-error branch (toSafeUserError — never a raw body)
 *   · stale-response protection (mounted + request-sequence guard)
 *   · an explicit confirmation step for the destructive legs
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(WEB_ROOT, rel));

const MEMBER_CONTROLS = "components/organizations/OrgMemberLifecycleControls.tsx";
const WORKSPACE_CONTROLS =
  "components/organizations/OrgWorkspaceLifecycleControls.tsx";
const CREATE_WORKSPACE = "components/workspace-admin/CreateWorkspaceCard.tsx";
const CLOSURE_CARD = "app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx";
const TRANSFER_CARD =
  "app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx";

const MEMBERS_PAGE = "app/(app)/organizations/[id]/admin/members/page.tsx";
const ORG_PAGE = "app/(app)/organizations/[id]/page.tsx";
const SPACES_PAGE = "components/workspace-admin/WorkspaceAdministrationHome.tsx";
const TEAM_PAGE = "app/(app)/teams/[id]/page.tsx";

/**
 * The obligations every one of these controls carries. Asserted as a unit so
 * a new control cannot ship with four of the seven.
 */
function assertControlContract(rel: string, label: string) {
  const src = read(rel);

  // The canonical client, and ONLY the canonical client. A relative fetch
  // resolves against the WEB origin, where /v1 does not exist.
  assert.ok(src.includes("apiFetch"), `${label}: does not use the canonical apiFetch`);
  assert.ok(
    !/fetch\(\s*[`"']\/v1\//.test(src),
    `${label}: calls a bare relative /v1 path — that is the wrong origin`,
  );

  // In-flight.
  assert.ok(/aria-busy=/.test(src), `${label}: no aria-busy while the request is open`);
  assert.ok(
    /disabled=\{[^}]*busy/.test(src),
    `${label}: the control is not disabled while in flight`,
  );

  // Announced. A screen reader must learn the outcome.
  assert.ok(
    src.includes('role="status"') && src.includes('aria-live="polite"'),
    `${label}: no live region announcing success/failure`,
  );

  // Denied.
  assert.ok(
    /don't have permission|don&apos;t have permission/.test(src),
    `${label}: no permission-denied copy`,
  );

  // Failed — bounded and sanitized, never a raw backend body.
  assert.ok(
    src.includes("toSafeUserError"),
    `${label}: unexpected/5xx failures are not sanitized through toSafeUserError`,
  );

  // Superseded. A response that lost its race, or arrived after unmount,
  // must not be written to state.
  assert.ok(
    src.includes("mountedRef") && /\w*[sS]eqRef/.test(src),
    `${label}: no stale-response guard`,
  );
  assert.ok(
    /if \(!mountedRef\.current \|\| seq !== \w*[sS]eqRef\.current\) return;/.test(src),
    `${label}: the stale-response guard is declared but never applied`,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/members/:memberId/suspend
// POST /v1/orgs/:id/members/:memberId/restore
// ---------------------------------------------------------------------------

test("org member suspend/restore: both legs POST the real route, mounted on the roster", () => {
  const src = read(MEMBER_CONTROLS);

  assert.ok(
    src.includes(
      "apiFetch(`/v1/orgs/${orgId}/members/${membershipId}/${action}`",
    ),
    "the membership lifecycle path is not addressed",
  );
  assert.match(src, /method: "POST"/);
  assert.match(src, /type Action = "suspend" \| "restore"/);
  // BOTH legs are reachable from the UI, not just the destructive one.
  assert.ok(src.includes('run("suspend")'), "the suspend leg has no call site");
  assert.ok(src.includes('run("restore")'), "the restore leg has no call site");

  // Destructive leg: explicit confirmation BEFORE the request, plus the
  // reason the route's zod body accepts (1..400) validated client-side.
  assert.ok(
    src.includes("data-action=\"confirm-suspend-org-member\""),
    "suspension has no explicit confirmation control",
  );
  assert.ok(
    src.includes("setConfirming(true)"),
    "the Suspend button fires the request instead of opening a confirmation step",
  );
  assert.match(src, /const MAX_REASON = 400/);
  assert.match(src, /Give a reason/);
  assert.match(src, /aria-invalid=/);
  assert.ok(
    src.includes("JSON.stringify(") && src.includes("{ reason: trimmed }"),
    "the typed reason never reaches the request body",
  );

  // Every stable conflict code the route can answer with is spoken for.
  assert.ok(src.includes("STALE_MEMBERSHIP_GENERATION"));
  assert.ok(src.includes("ILLEGAL_MEMBERSHIP_TRANSITION"));
  assert.match(src, /status === 403/);
  assert.match(src, /status === 404/);

  // The roster is RE-READ; local state is never patched to look right.
  assert.ok(src.includes("await onChanged()"), "success does not refresh the roster");

  assertControlContract(MEMBER_CONTROLS, "org member suspend/restore");
});

test("org member suspend/restore: wired into the canonical members roster", () => {
  const page = read(MEMBERS_PAGE);
  assert.ok(
    page.includes("<OrgMemberLifecycleControls"),
    "the members tab does not mount the lifecycle controls",
  );
  assert.match(page, /orgId=\{orgId\}/);
  assert.match(page, /membershipId=\{m\.membershipId\}/);
  assert.match(page, /canManage=\{canMutate\}/);
  // Self-action is a 409 at the route; the surface says so before the call.
  assert.match(page, /isSelf=\{m\.userId === currentUserId\}/);
  assert.match(page, /onChanged=\{refresh\}/);
  // Organization context comes from the route param the page already reads.
  assert.match(page, /const orgId = params\?\.id \?\? ""/);
});

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/workspaces/:teamId/suspend
// POST /v1/orgs/:id/workspaces/:teamId/resume
// ---------------------------------------------------------------------------

test("org workspace suspend/resume: both legs POST the real route", () => {
  const src = read(WORKSPACE_CONTROLS);

  assert.ok(
    src.includes("`/v1/orgs/${orgId}/workspaces/${workspaceId}/${action}`"),
    "the org-workspace lifecycle path is not addressed",
  );
  assert.match(src, /method: "POST"/);
  assert.match(src, /type Action = "suspend" \| "resume"/);
  assert.ok(src.includes('run("suspend")'), "the suspend leg has no call site");
  assert.ok(src.includes('run("resume")'), "the resume leg has no call site");

  // Destructive leg gets a confirmation step that states the consequence.
  assert.ok(src.includes('data-action="confirm-suspend-org-workspace"'));
  assert.match(src, /Every active member loses/);

  // A personal space is refused by the service — the control says so instead
  // of offering an action that can only 409.
  assert.match(src, /isPersonal/);
  assert.match(src, /data-state="not-applicable"/);

  // Status-keyed denials: the route's bodies carry a nested code with no
  // message, so status is the honest signal.
  assert.match(src, /status === 403/);
  assert.match(src, /status === 404/);
  assert.match(src, /status === 409/);

  assert.ok(src.includes("await onChanged()"), "success does not refresh the list");

  assertControlContract(WORKSPACE_CONTROLS, "org workspace suspend/resume");
});

test("org workspace suspend/resume: wired into the org detail workspaces list", () => {
  const page = read(ORG_PAGE);
  assert.ok(
    page.includes("<OrgWorkspaceLifecycleControls"),
    "the org workspaces section does not mount the lifecycle controls",
  );
  assert.match(page, /workspaceId=\{w\.workspaceId\}/);
  assert.match(page, /isPersonal=\{w\.isPersonal\}/);
  // ORG_ADMIN+ projection already derived by the page — not re-invented.
  assert.match(page, /canManage=\{canMutate\}/);
  assert.match(page, /onChanged=\{fetchAll\}/);
});

// ---------------------------------------------------------------------------
// POST /v1/teams
// ---------------------------------------------------------------------------

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the two create-workspace
// tests were REPLACED by these two.
//
// They pinned a control that has been removed, and they pinned it well: the
// call site, the body, the validation, the denial code, the re-read of the
// envelope, the keyboard contract. None of that was wrong. What changed is
// underneath it — self-service workspace creation is refused now, because
// checkout has one subject and it is the person, so a workspace created there
// could never be paid for and would refuse every piece of evidence recorded in
// it.
//
// A test that keeps a removed capability alive is worse than no test: it makes
// the removal look like a regression. These assert the ABSENCE instead, and —
// the part that actually protects a customer — that the copy which sent people
// to create one is gone with it.

test("create workspace: the control is GONE, not merely disabled", () => {
  assert.equal(
    exists(CREATE_WORKSPACE),
    false,
    "CreateWorkspaceCard still exists — a control for a capability that is refused",
  );
  const home = read("components/workspace-admin/WorkspaceAdministrationHome.tsx");
  assert.equal(home.includes("<CreateWorkspaceCard />"), false);
  assert.equal(home.includes("CreateWorkspaceCard"), false);
});

test("create workspace: the copy no longer says billing lives in a workspace", () => {
  const home = read("components/workspace-admin/WorkspaceAdministrationHome.tsx");
  // It read "members, roles, governance, reviewer ops, and billing live in it"
  // — the obsolete model told to the user in the product's own words.
  assert.equal(home.includes("and billing live in it"), false);
  // JSX wraps prose across lines, so the copy is matched with whitespace
  // collapsed rather than as a single literal.
  const prose = home.replace(/\s+/g, " ");
  assert.ok(prose.includes("lives in your Personal Workspace"));
  assert.ok(prose.includes("part of an Enterprise agreement"));
});

// ---------------------------------------------------------------------------
// POST /v1/teams/:id/reopen
// ---------------------------------------------------------------------------

test("reopen workspace: the one-way door has a way back", () => {
  const src = read(CLOSURE_CARD);

  assert.ok(
    src.includes("apiFetch(`/v1/teams/${teamId}/reopen`"),
    "the reopen call site is missing",
  );
  assert.match(src, /method: "POST"/);

  // Rendered ONLY where it can work — the card's own read says COMPLETED.
  assert.ok(
    src.includes('req.status === "COMPLETED"'),
    "the reopen control is not gated on an actually-closed workspace",
  );
  assert.ok(src.includes('data-action="reopen-workspace"'));

  // Honest about what reopening does NOT restore.
  assert.match(src, /credentials and webhooks stay revoked|are NOT restored/);

  // Denials: 403 owner, 404 gone, 409 closure-in-progress / never closed.
  assert.match(src, /status === 403/);
  assert.match(src, /status === 404/);
  assert.match(src, /status === 409/);

  // Its own announcement region + busy state, separate from the closure leg.
  assert.ok(src.includes("data-workspace-reopen-status"));
  assert.match(src, /aria-busy=\{reopenBusy\}/);
  assert.match(src, /disabled=\{reopenBusy\}/);
  assert.ok(src.includes("await reload()"), "success does not re-read closure state");

  assertControlContract(CLOSURE_CARD, "reopen workspace");
});

// ---------------------------------------------------------------------------
// POST /v1/teams/:id/transfer-ownership
// ---------------------------------------------------------------------------

test("transfer workspace ownership: a real target list, a confirmation, and step-up", () => {
  const src = read(TRANSFER_CARD);

  assert.ok(
    src.includes("apiFetch(`/v1/teams/${teamId}/transfer-ownership`"),
    "the transfer call site is missing",
  );
  assert.match(src, /method: "POST"/);
  assert.ok(
    src.includes("newOwnerUserId: targetUserId"),
    "the chosen member never reaches the request body",
  );

  // Destructive: an explicit confirmation step precedes the request.
  assert.ok(src.includes('data-action="open-workspace-transfer-ownership"'));
  assert.ok(src.includes('data-action="transfer-workspace-ownership"'));
  assert.ok(
    src.includes("setConfirming(true)"),
    "the transfer button fires the request instead of confirming first",
  );

  // Body validation: a target must be chosen.
  assert.match(src, /Choose the member who should own this workspace/);
  assert.match(src, /aria-invalid=/);
  assert.match(src, /disabled=\{busy \|\| !targetUserId\}/);

  // The route is step-up gated; the denial is handled, not swallowed.
  assert.ok(src.includes("StepUpVerify"));
  assert.ok(src.includes("STEP_UP_REQUIRED") && src.includes("STEP_UP_INVALID"));
  assert.ok(src.includes("void transfer(proof)"), "step-up cannot re-drive the action");

  assert.match(src, /status === 403/);
  assert.match(src, /status === 404/);
  assert.match(src, /status === 409/);
  /**
   * PHASE 13 (NEW-049) — the outcome is handed UP, not just shown.
   *
   * This used to pin `await onTransferred()`. A successful transfer demotes
   * the actor out of the ownership this card is gated on, so the refresh it
   * triggers unmounts the card and the live region holding its success
   * message; the announcement survived about one render. The callback now
   * carries the outcome sentence so the page can hold it somewhere that
   * outlives the card.
   */
  assert.ok(
    src.includes("await onTransferred(outcome)"),
    "success does not hand the outcome to the parent",
  );

  assertControlContract(TRANSFER_CARD, "transfer workspace ownership");
});

test("transfer workspace ownership: owner-only, and never offers an ineligible target", () => {
  const page = read(TEAM_PAGE);

  assert.ok(
    page.includes("<WorkspaceOwnershipTransferCard"),
    "the workspace detail page does not mount the transfer card",
  );
  // `isOwner` is the SERVER projection (team.canManageWorkspace), not a
  // client-side role guess.
  assert.match(
    page,
    /isOwner && teamId \? \(\s*<WorkspaceOwnershipTransferCard/,
    "the transfer card is not gated on the server owner projection",
  );
  assert.match(page, /const isOwner = team\?\.canManageWorkspace === true/);

  // Candidates come from the roster the page already read, minus the owner
  // and the caller — the route refuses both.
  assert.match(page, /ownershipTransferCandidates/);
  assert.match(page, /member\.userId !== team\?\.ownerUserId/);
  assert.match(page, /member\.userId !== currentUserId/);
  // NEW-049: the page takes the outcome, holds it, THEN refreshes — and keeps
  // it in a live region that is not inside the owner-gated card, because that
  // card is about to unmount.
  assert.match(page, /onTransferred=\{async \(notice\) => \{/);
  assert.match(page, /setOwnershipNotice\(notice\)/);
  assert.match(page, /await loadData\(\)/);
  assert.match(page, /data-workspace-ownership-notice/);
  assert.ok(
    /ownershipNotice \? \([\s\S]{0,400}role="status"/.test(page),
    "the transfer outcome is not announced in a live region",
  );
});
