/**
 * PHASE 13 — six registered governance routes that had NO product surface.
 *
 *   POST /v1/governance/cross-org-review
 *   POST /v1/governance/cross-org-review/:id/accept
 *   POST /v1/governance/access-reviews/campaigns
 *   POST /v1/governance/destruction-reviews
 *   POST /v1/governance/policies
 *
 * (The sixth, POST /v1/governance/delegated-admin, belonged to the retired
 * delegated-admin TIER model and now answers 410. ONE delegated-administration
 * authority remains — member delegated scopes in the permission engine — and
 * the tests below pin that the console followed: permission denials, a
 * permission-based client mirror, and no surface left on the retired routes.)
 *
 * Each one is a governance CAPABILITY whose console already listed the
 * entity, and already offered the follow-on transitions (open/close,
 * activate/deprecate, decline/revoke, approve/execute) — while the row those
 * transitions act on could only be brought into existence with a REST client.
 * A queue you can walk but never enqueue is not a shipped capability.
 *
 * These assertions are on SOURCE SHAPE, following the house convention: what
 * regressed in this class of defect is a URL, a method, a missing disabled
 * state, or a swallowed failure — all of which are visible in the source and
 * none of which need a DOM to pin. Each route is checked for the exact path,
 * the method, every required body field, and the seven states a write control
 * on this codebase must carry: permission, loading, validation, denial,
 * server error, success-with-refetch, and an announced status.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");

const ACTION_STATE = "components/governance/governance-action-state.ts";
const FORM_FIELD = "components/governance/GovernanceFormField.tsx";
const CROSS_ORG_FORMS = "components/governance/CrossOrgReviewForms.tsx";
const CAMPAIGN_FORM = "components/governance/AccessReviewCampaignForm.tsx";
const DELEGATED_FORM = "components/governance/DelegatedAdminGrantForm.tsx";
const MEMBERS_SECTION = "app/(app)/security-center/identity/_sections/MembersSection.tsx";
const LABELS = "lib/labels/governanceReviewLabels.ts";
const POLICY_FORM = "components/governance/GovernancePolicyForm.tsx";
const DESTRUCTION_FORM = "components/governance/DestructionReviewForm.tsx";

const CROSS_ORG_PAGE = "app/(app)/governance-platform/cross-org/page.tsx";
const ACCESS_REVIEWS_PAGE = "app/(app)/governance-platform/access-reviews/page.tsx";
const DELEGATED_PAGE = "app/(app)/governance-platform/delegated-admin/page.tsx";
const POLICIES_PAGE = "app/(app)/governance-platform/policies/page.tsx";
const DESTRUCTION_PAGE = "app/(app)/governance/destruction/page.tsx";

const ALL_FORMS = [
  CROSS_ORG_FORMS,
  CAMPAIGN_FORM,
  POLICY_FORM,
  DESTRUCTION_FORM,
];

// ---------------------------------------------------------------------------
// The shared runner — every one of the six controls inherits its stale-response
// protection and its bounded failure copy from here, so this is pinned once.
// ---------------------------------------------------------------------------

test("the shared governance action runner drops superseded, unmounted and cross-tenant responses", () => {
  const src = read(ACTION_STATE);

  // Three independent supersession conditions, ANDed into one predicate.
  assert.ok(src.includes("const seq = ++seqRef.current"), "no per-call sequence token");
  assert.ok(src.includes("mountedRef.current"), "no unmount guard");
  assert.ok(src.includes("!isStale(generation)"), "no tenant-generation guard");
  assert.match(
    src,
    /const current = \(\) =>\s*\n?\s*mountedRef\.current && seq === seqRef\.current && !isStale\(generation\)/,
    "the three guards must be composed into one `current()` predicate",
  );
  // Both the success and the failure branch must consult it — a late failure
  // overwriting a fresh success is the same defect wearing the other hat.
  const runBody = src.slice(src.indexOf("const run = useCallback<"));
  const guards = (runBody.slice(0, runBody.indexOf("return useMemo")).match(/if \(!current\(\)\) return;/g) ?? []).length;
  assert.ok(guards >= 2, "success and failure branches must both drop a superseded response");

  // aria-busy is driven from real in-flight state, not a timer.
  assert.ok(src.includes("setBusy(true)") && src.includes("setBusy(false)"));
});

test("failure classification is bounded — no raw backend body ever reaches the DOM", () => {
  const src = read(ACTION_STATE);

  assert.ok(src.includes("export function classifyGovernanceFailure"));
  // The five buckets the six routes can actually produce.
  assert.match(src, /status === 403 \|\| status === 404/, "403/404 must fold into one denial state");
  assert.match(src, /status === 402/, "the Enterprise plan gate (402) is unhandled");
  assert.match(src, /status === 400 \|\| status === 422/, "no client-visible validation state for a server 400");
  assert.match(src, /status === 409/, "no conflict state");
  assert.match(
    src,
    /kind: "error",\s*\n?\s*message: toSafeUserError\(err, \{ message: fallback \}\)\.message/,
    "the >=500 / unexpected bucket must route through toSafeUserError",
  );

  // Only two fragments of the response body may be echoed, and both are
  // gated: a permission key against the shared catalog (and then rendered as
  // its label), an entitlement key against a strict pattern.
  assert.ok(
    src.includes('denial === "PERMISSION_REQUIRED" && isKnownPermission(permission)'),
    "a permission key is echoed without checking it is in the shared catalog",
  );
  assert.ok(src.includes("permissionRequiredDetail(permission)"), "the permission is not rendered through its label");
  assert.ok(src.includes("ENTITLEMENT_PATTERN.test(entitlement)"), "an entitlement key is echoed unchecked");
  // The retired tier denial is gone from the classifier.
  assert.equal(/requiredTier|DELEGATED_ADMIN_REQUIRED|KNOWN_TIERS/.test(src), false, "the retired tier denial is still classified");
  assert.equal(
    /message: [a-zA-Z]*[eE]rr[a-zA-Z]*\.message/.test(src.replace(/toSafeUserError\([^)]*\)\.message/g, "")),
    false,
    "a raw error message is being rendered",
  );
  // An unknown 409 code must fall back to generic copy, never render the code.
  assert.ok(src.includes("CONFLICT_COPY[key] ??"), "an unmapped denial code would be rendered raw");
});

test("the client-side permission mirror follows the permission engine and stays advisory", () => {
  const src = read(ACTION_STATE);
  // The tier mirror is gone, and nothing reads the retired (410) endpoint.
  assert.equal(src.includes("useDelegatedTierAccess"), false, "the retired tier mirror is still exported");
  assert.equal(src.includes('apiFetch("/v1/governance/delegated-admin"'), false, "the mirror still reads the retired tier endpoint");
  assert.ok(src.includes("export function useWorkspacePermissionAccess"));

  // Built from the engine's own three sources, through the SHARED tables:
  // role floor, live capability grants, live delegated scopes.
  assert.ok(src.includes("roleHasPermission(role, permission)"), "the role floor is not the shared role matrix");
  assert.ok(
    src.includes("listPermissionsForDelegatedAdminScope("),
    "delegated scopes are not expanded through the shared scope → permission table",
  );
  assert.match(
    src,
    /apiFetch\("\/v1\/identity\/members", \{ method: "GET" \}\)/,
    "the caller's own grants and scopes must come from the existing member roster",
  );
  assert.ok(src.includes("rows.find((m) => m.userId === userId)"), "the mirror does not read the CALLER's own row");
  // Revoked or expired grants/scopes never count.
  assert.ok(src.includes("if (row.revokedAtUtc) return false;"), "a revoked grant would still enable the control");
  assert.ok(
    src.includes("new Date(row.expiresAtUtc).getTime() <= now"),
    "an expired grant would still enable the control",
  );
  // Both role shapes the platform context emits ("OWNER" and the Personal "Owner").
  assert.ok(src.includes('roleLabel === "Owner"'), "the Personal Space owner shape is not accepted");
  // "missing" only when the whole picture was seen; an unreadable roster is
  // "unknown" and leaves the server to decide — never "granted".
  assert.ok(src.includes('if (rosterRead && ownRow !== undefined) return "missing";'));
  assert.ok(src.includes('return "unknown";'));
  assert.ok(src.includes('verdict(permission) !== "missing"'), "allows() must refuse only a confirmed gap");
});

test("PERMISSION_REQUIRED copy names the permission in words and who can grant it", () => {
  const src = read(LABELS);
  assert.equal(/delegatedTierLabel|DELEGATED_TIER_LABELS/.test(src), false, "the tier label map is still present");
  // One permission-label map: the shared one, not a second copy.
  assert.ok(src.includes('import { permissionLabel } from "./identityOrgLabels"'));
  assert.ok(src.includes("KNOWN_PERMISSIONS.has(value)"), "an unknown key would be echoed");
  assert.ok(
    src.includes(
      "A workspace owner or admin can grant it to you, or give you a delegated scope that includes it, in Security Center.",
    ),
    "the copy does not say who can grant the permission, or where",
  );
});

test("the retired tier console is gone and points at Security Center", () => {
  assert.equal(existsSync(join(WEB_ROOT, DELEGATED_FORM)), false, "the tier grant form still ships");
  const page = read(DELEGATED_PAGE);
  assert.equal(/apiFetch|\bfetch\(/.test(page), false, "the retired page still calls the tier API");
  assert.ok(page.includes('href="/security-center/identity"'), "the retired page does not point at Security Center");
  assert.ok(page.includes("remain in the audit history"), "the retired page does not say where past grants went");

  const hub = read("app/(app)/governance-platform/page.tsx");
  assert.ok(
    hub.includes('data-governance-platform-link="delegated-admin" href="/security-center/identity"'),
    "the hub nav still links to the retired tier console",
  );
  const orgDepartments = read("app/(app)/organizations/[id]/admin/departments/page.tsx");
  assert.ok(orgDepartments.includes('href="/security-center/identity"'));
  assert.equal(/DEPT_ADMIN|SECURITY_OFFICER|tier-scoped/.test(orgDepartments), false, "tier copy survives on the org departments page");

  // No consumer of the retired tier shapes anywhere in the forms.
  for (const rel of [...ALL_FORMS, ACTION_STATE]) {
    assert.equal(
      /hasTier\(|hasAnyTier\(|requiredTier|DELEGATED_ADMIN_REQUIRED/.test(read(rel)),
      false,
      `${rel} still consumes the retired tier model`,
    );
  }
});

test("the organization id is server-derived, never typed by the operator", () => {
  const src = read(ACTION_STATE);
  assert.match(
    src,
    /apiFetch\("\/v1\/governance\/departments", \{\s*\n?\s*method: "GET",/,
    "the organization id must come from the departments listing's server echo",
  );
  assert.ok(src.includes('typeof res?.organizationId === "string"'));
  for (const rel of [CROSS_ORG_FORMS, CAMPAIGN_FORM]) {
    assert.ok(
      read(rel).includes("useGovernanceOrganization"),
      `${rel} must take the organization id from the server-derived hook`,
    );
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants across all five new write surfaces
// ---------------------------------------------------------------------------

test("every governance write goes through apiFetch — never a relative fetch to another origin", () => {
  for (const rel of ALL_FORMS) {
    const src = read(rel);
    assert.ok(src.includes('from "../../lib/api"'), `${rel} does not import the canonical client`);
    assert.equal(
      /[^.\w]fetch\(\s*["'`]\//.test(src),
      false,
      `${rel} issues a relative fetch — it resolves against the Next origin and never reaches the API`,
    );
  }
});

test("every governance write control is a real submit button, disabled while it cannot act", () => {
  for (const rel of ALL_FORMS) {
    const src = read(rel);
    assert.ok(src.includes('type="submit"'), `${rel} has no submit control`);
    assert.ok(src.includes("loading={busy}"), `${rel} has no loading state on its control`);
    assert.ok(src.includes("disabled={!canSubmit}"), `${rel} leaves its control enabled when it cannot act`);
    assert.ok(src.includes("onSubmit={submit}"), `${rel} is not keyboard-submittable`);
    assert.ok(src.includes("useGovernanceAction"), `${rel} does not use the guarded runner`);
  }
});

test("every governance form announces its result to a screen reader", () => {
  const field = read(FORM_FIELD);
  assert.ok(field.includes('role="status"'), "no status role on the shared status region");
  assert.ok(field.includes('aria-live="polite"'), "the status region does not announce");
  assert.ok(field.includes("aria-busy={busy || undefined}"), "the status region is not marked busy in flight");
  // Labels are real labels, bound to real controls.
  assert.ok(field.includes("<label htmlFor={id}"), "fields are not labelled with htmlFor");
  assert.ok(field.includes('aria-invalid={error ? true : undefined}'), "an invalid field is not marked invalid");
  assert.ok(field.includes("aria-describedby="), "a field error is not associated with its control");

  for (const rel of ALL_FORMS) {
    assert.ok(
      read(rel).includes("GovernanceActionStatus"),
      `${rel} renders no screen-reader status region`,
    );
  }
});

test("no governance form renders a raw error object", () => {
  for (const rel of ALL_FORMS) {
    const src = read(rel);
    assert.equal(
      /\berr(or)?\.message\b/.test(src),
      false,
      `${rel} renders a raw error message instead of bounded copy`,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/governance/cross-org-review
// ---------------------------------------------------------------------------

test("POST /v1/governance/cross-org-review — invite is wired, validated, gated and refetches", () => {
  const src = read(CROSS_ORG_FORMS);

  assert.match(
    src,
    /apiFetch\("\/v1\/governance\/cross-org-review", \{\s*\n?\s*method: "POST",/,
    "the invite call site is missing or addresses the wrong path/method",
  );
  // Exact body contract (trust-and-governance.routes.ts:1323).
  for (const field of [
    "invitingOrganizationId: organizationId",
    "invitedOrgSlug: invitedOrgSlug.trim()",
    "scope: scope.trim()",
    // D17 — the record under review is required by the route.
    "subject: { kind: target.kind, id: target.id }",
    "expiresAtUtc: toIsoInstant(expiresAt)",
  ]) {
    assert.ok(src.includes(field), `invite body is missing ${field}`);
  }

  // Client-side validation of every required field, matching the zod schema.
  assert.ok(src.includes("ORG_SLUG_PATTERN.test(slug)"), "the invited slug regex is not enforced client-side");
  assert.ok(src.includes("An invited organization slug is required."));
  assert.ok(src.includes("Describe what the invited organization may review."));
  assert.ok(src.includes("trimmedScope.length > 600"), "the 600-char scope bound is not enforced");

  // Permission: requireWorkspacePermission("governance.exchange.manage").
  assert.ok(
    src.includes('const CROSS_ORG_PERMISSION = "governance.exchange.manage"'),
    "the cross-org controls do not mirror the permission their routes require",
  );
  assert.ok(
    src.includes("const permitted = access.ready && access.allows(CROSS_ORG_PERMISSION);"),
    "the invite control does not mirror its required permission",
  );
  assert.ok(src.includes('data-cross-org-invite-blocked="permission"'), "no permission-denied state on the control");
  assert.ok(src.includes("permissionRequiredDetail(CROSS_ORG_PERMISSION)"), "the denial does not name the permission");
  assert.ok(src.includes("<ReviewScopePicker"), "the invite does not ask which record is under review");
  assert.ok(src.includes('data-cross-org-invite-blocked="subject"'), "no visible reason while no record is chosen");
  assert.ok(src.includes("subject.target !== null"), "submit is not blocked until a record is chosen");
  assert.ok(
    src.includes('data-cross-org-invite-blocked="organization"'),
    "no state for a workspace with no governance organization",
  );

  // Success refetches the list the page already renders.
  assert.ok(src.includes("await onCreated()"), "a successful invite does not refresh the grant list");
  assert.ok(src.includes("data-cross-org-invite-status"), "no status region for the invite");

  // The page mounts it and hands it the real refetch.
  const page = read(CROSS_ORG_PAGE);
  assert.ok(page.includes("<CrossOrgInviteForm onCreated={refresh} />"), "the page does not mount the invite form");
});

// ---------------------------------------------------------------------------
// POST /v1/governance/cross-org-review/:id/accept
// ---------------------------------------------------------------------------

test("POST /v1/governance/cross-org-review/:id/accept — accept is wired with its body and permission gate", () => {
  const src = read(CROSS_ORG_FORMS);

  assert.match(
    src,
    /apiFetch\(\s*`\/v1\/governance\/cross-org-review\/\$\{grant\.id\}\/accept`,\s*\{\s*\n?\s*method: "POST",/,
    "the accept call site is missing or addresses the wrong path/method",
  );
  assert.ok(
    src.includes("acceptingOrganizationId: organizationId"),
    "accept body is missing acceptingOrganizationId",
  );
  assert.ok(
    src.includes("externalReviewGrantId: trimmed ? trimmed : null"),
    "accept body is missing the optional external grant binding",
  );

  // The optional uuid is validated before it is sent.
  assert.ok(src.includes("trimmed && !isUuid(trimmed)"), "the external grant id is not validated as a UUID");

  // Permission: the same governance.exchange.manage check, on both controls.
  assert.equal(
    (src.match(/const permitted = access\.ready && access\.allows\(CROSS_ORG_PERMISSION\);/g) ?? []).length,
    2,
    "the accept control does not mirror its required permission",
  );
  assert.ok(src.includes('data-cross-org-accept-blocked="permission"'), "no permission-denied state on accept");
  assert.ok(src.includes("await onAccepted()"), "a successful accept does not refresh the grant list");
  assert.ok(src.includes("data-cross-org-accept-status"), "no status region for accept");

  // The row action opens the form (accept carries a body, so it cannot fire
  // straight from the row), and success refetches the list.
  const page = read(CROSS_ORG_PAGE);
  assert.ok(page.includes("data-cross-org-accept={g.id}"), "INVITED rows offer no Accept control");
  assert.ok(page.includes("onClick={() => setAcceptFor(g)}"));
  /**
   * PHASE 13 (NEW-067) — success REFRESHES; it must NOT also close the form.
   *
   * This used to require `setAcceptFor(null)` on the success path. That is the
   * line that made the accept outcome unannounceable: closing the form unmounts
   * `CrossOrgAcceptForm`, and the `role="status"` / `aria-live="polite"` region
   * asserted two lines above (`data-cross-org-accept-status`) lives inside it.
   * A live region detached in the same tick it receives text tells a
   * screen-reader user nothing, so the test was pinning the defect in place.
   *
   * The refresh half is still required — that is the part that makes the row
   * visibly ACCEPTED. The dismissal stays available through `onCancel`, which
   * is asserted below, so the form is not stuck open.
   */
  assert.match(
    page,
    /onAccepted=\{async \(\) => \{\s*\n?\s*await refresh\(\);/,
    "accepting must refresh the list",
  );
  // Scoped to the handler BODY — the surrounding JSX legitimately contains
  // `setAcceptFor(null)` in `onCancel`, so a windowed regex over the whole file
  // would match the dismissal and report a defect that is not there.
  const acceptedBody = (() => {
    const open = page.indexOf("onAccepted={async () => {");
    if (open < 0) return null;
    const close = page.indexOf("}}", open);
    return close < 0 ? null : page.slice(open, close);
  })();
  assert.ok(acceptedBody, "no onAccepted handler found on the cross-org page");
  assert.ok(
    !acceptedBody!.includes("setAcceptFor"),
    "accepting must NOT unmount the form that holds its own live region (NEW-067)",
  );
  assert.ok(
    page.includes("onCancel={() => setAcceptFor(null)}"),
    "the operator must still be able to dismiss the accept form",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/governance/access-reviews/campaigns
// ---------------------------------------------------------------------------

test("POST /v1/governance/access-reviews/campaigns — campaign creation is wired end to end", () => {
  const src = read(CAMPAIGN_FORM);

  assert.match(
    src,
    /apiFetch\("\/v1\/governance\/access-reviews\/campaigns", \{\s*\n?\s*method: "POST",/,
    "the campaign create call site is missing or addresses the wrong path/method",
  );
  // Exact body contract (trust-and-governance.routes.ts:1186).
  for (const field of [
    "kind,",
    "name: name.trim()",
    "organizationId: org.organizationId",
    "departmentId: departmentId ? departmentId : null",
    "scheduledStartUtc: startIso",
    "scheduledEndUtc: endIso",
    "items,",
  ]) {
    assert.ok(src.includes(field), `campaign body is missing ${field}`);
  }

  // Validation for every required field, including the ordering rule the
  // service enforces (`scheduledEndUtc <= scheduledStartUtc` → POLICY_REJECTED).
  assert.ok(src.includes("A campaign name is required."));
  assert.ok(src.includes("A scheduled start is required."));
  assert.ok(src.includes("A scheduled end is required."));
  assert.ok(
    src.includes("The scheduled end must be after the scheduled start."),
    "the end-after-start rule is not checked client-side, so it costs a round trip",
  );
  assert.ok(src.includes("MAX_ITEMS = 500"), "the 500-item cap is not enforced client-side");

  // Permission: requireWorkspacePermission("identity.access_review.action").
  assert.ok(src.includes('const CAMPAIGN_PERMISSION = "identity.access_review.action"'));
  assert.ok(src.includes("const permitted = access.ready && access.allows(CAMPAIGN_PERMISSION);"));
  assert.ok(src.includes('data-access-review-campaign-blocked="permission"'), "no permission-denied state");
  assert.ok(src.includes("permissionRequiredDetail(CAMPAIGN_PERMISSION)"), "the denial does not name the permission");

  // The item builder is a list, so it needs an empty state.
  assert.ok(src.includes("data-access-review-items-empty"), "the attached-grants list has no empty state");
  assert.ok(src.includes("<EmptyState"), "the attached-grants empty state is not the canonical primitive");

  assert.ok(src.includes("await onCreated()"), "a created campaign does not refresh the list");
  assert.ok(src.includes("data-access-review-campaign-status"), "no status region");

  const page = read(ACCESS_REVIEWS_PAGE);
  assert.ok(page.includes("<AccessReviewCampaignForm"), "the page does not mount the campaign form");
  assert.match(
    page,
    /onCreated=\{async \(\) => \{\s*\n?\s*await refresh\(\);\s*\n?\s*await loadEscalated\(\);/,
    "creating a campaign must refetch both projections the page renders",
  );
});

// ---------------------------------------------------------------------------
// Delegated administration — member scopes in Security Center
// ---------------------------------------------------------------------------

test("delegated scopes are granted, updated and revoked per member in Security Center, under step-up", () => {
  const src = read(MEMBERS_SECTION);
  assert.match(src, /`\/v1\/identity\/members\/\$\{selected\.teamMemberId\}\/delegated-admin`/, "no grant call site");
  assert.match(
    src,
    /apiFetch\(`\/v1\/identity\/delegated-admin\/\$\{scope\.id\}`, \{\s*\n?\s*method: "PATCH",/,
    "no update call site on the PATCH route",
  );
  assert.match(
    src,
    /apiFetch\(`\/v1\/identity\/delegated-admin\/\$\{scope\.id\}`, \{\s*\n?\s*method: "DELETE",/,
    "no revoke call site",
  );
  // The update rides the same step-up runner as grant and revoke.
  const update = src.slice(src.indexOf("const updateDelegated = useCallback("), src.indexOf("const revokeDelegated = useCallback("));
  assert.ok(update.includes("await run("), "the scope update bypasses the step-up runner");
  assert.ok(update.includes("JSON.stringify(built.body)"), "the update body is not the changed-fields body");
  // Kind, grant time, expiry and reason are all inspectable on the row.
  for (const anchor of [
    "data-identity-delegated-granted={s.id}",
    "data-identity-delegated-expiry={s.id}",
    "data-identity-delegated-reason={s.id}",
    "data-identity-delegated-edit={s.id}",
  ]) {
    assert.ok(src.includes(anchor), `the scope row is missing ${anchor}`);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/governance/destruction-reviews
// ---------------------------------------------------------------------------

test("POST /v1/governance/destruction-reviews — enqueueing is wired, confirmed and permission-gated", () => {
  const src = read(DESTRUCTION_FORM);

  assert.match(
    src,
    /apiFetch\("\/v1\/governance\/destruction-reviews", \{\s*\n?\s*method: "POST",/,
    "the destruction-review create call site is missing or addresses the wrong path/method",
  );
  // Exact body contract (governance-lifecycle.routes.ts:449). `teamId` is in
  // the BODY on this route, not the query.
  for (const field of [
    "teamId,",
    "evidenceId: evidenceId.trim()",
    "reason,",
    "retentionPolicyId: trimmedPolicy ? trimmedPolicy : null",
    "retentionPolicyVersion: trimmedVersion ? Number(trimmedVersion) : null",
  ]) {
    assert.ok(src.includes(field), `destruction-review body is missing ${field}`);
  }

  // Validation: the uuid, the bounded reason enum, and the version integer.
  assert.ok(src.includes("!isUuid(trimmed)"), "the evidence id is not validated as a UUID");
  assert.ok(src.includes("An evidence id is required."));
  assert.ok(src.includes("DESTRUCTION_REVIEW_REASONS"), "the reason is not bound to the shared enum");
  assert.ok(
    src.includes("!Number.isInteger(parsed) || parsed < 1"),
    "the retention policy version is not validated as a positive integer",
  );

  // Permission mirrors requireMember(teamId, "evidence.delete") through the
  // canonical shared role matrix — not a locally re-derived role rule.
  assert.ok(src.includes("roleHasPermission(mapTeamRoleToCanonical(role), \"evidence.delete\")"));
  assert.ok(src.includes('data-destruction-review-blocked="permission"'), "no permission-denied state");
  assert.ok(src.includes('data-destruction-review-blocked="workspace"'), "no no-workspace state");

  // Opening a destruction review is consequential — it is confirmed first,
  // through the same primitive the queue's transitions use.
  assert.ok(src.includes("await confirm({"), "the create is not confirmed before it leaves");
  assert.ok(src.includes("if (!confirmed) return;"));

  assert.ok(src.includes("await onCreated()"), "a new review does not refresh the queue");
  assert.ok(src.includes("data-destruction-review-status"), "no status region");

  const page = read(DESTRUCTION_PAGE);
  assert.ok(
    page.includes("<DestructionReviewForm teamId={teamId} onCreated={refresh} />"),
    "the queue page does not mount the create form with its workspace + refetch",
  );
  // The parallel lifecycle route writes a different model and must not be
  // mistaken for this one.
  assert.equal(
    page.includes("/v1/lifecycle/destruction/requests"),
    false,
    "the queue page must not address the parallel DestructionRequest route",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/governance/policies
// ---------------------------------------------------------------------------

test("POST /v1/governance/policies — policy authoring is wired with a locally-parsed rule object", () => {
  const src = read(POLICY_FORM);

  assert.match(
    src,
    /apiFetch\("\/v1\/governance\/policies", \{\s*\n?\s*method: "POST",/,
    "the policy create call site is missing or addresses the wrong path/method",
  );
  // Exact body contract (trust-and-governance.routes.ts:979).
  for (const field of [
    "kind,",
    "slug: slug.trim()",
    "name: name.trim()",
    "summary: summary.trim()",
    "enforcementMode,",
    "rule: parsedRule.rule",
  ]) {
    assert.ok(src.includes(field), `policy body is missing ${field}`);
  }

  // Validation for all six required fields, including the slug regex the
  // service re-checks and the z.record shape of `rule`.
  assert.ok(src.includes("POLICY_SLUG_PATTERN.test(trimmedSlug)"), "the slug regex is not enforced client-side");
  assert.ok(src.includes("A policy name is required."));
  assert.ok(src.includes("A one-paragraph summary is required."));
  assert.ok(src.includes("trimmedSummary.length > 600"), "the 600-char summary bound is not enforced");
  assert.ok(src.includes("The rule must be valid JSON."), "an unparseable rule would be posted");
  assert.ok(
    src.includes("The rule must be a JSON object, not an array or a scalar."),
    "an array or scalar rule would be posted against a z.record schema",
  );

  // Permission: requireWorkspacePermission("governance.policy.manage").
  assert.ok(src.includes('const POLICY_PERMISSION = "governance.policy.manage"'));
  assert.ok(src.includes("const permitted = access.ready && access.allows(POLICY_PERMISSION);"));
  assert.ok(src.includes('data-governance-policy-blocked="permission"'), "no permission-denied state");
  assert.ok(src.includes("permissionRequiredDetail(POLICY_PERMISSION)"), "the denial does not name the permission");

  assert.ok(src.includes("await onCreated()"), "a new policy does not refresh the registry");
  assert.ok(src.includes("data-governance-policy-status"), "no status region");

  const page = read(POLICIES_PAGE);
  assert.ok(page.includes("<GovernancePolicyForm"), "the page does not mount the policy form");
  assert.match(
    page,
    /onCreated=\{async \(\) => \{\s*\n?\s*await refresh\(\);\s*\n?\s*await loadEffective\(\);/,
    "creating a policy must refetch the registry AND the effective chain",
  );
});

// ---------------------------------------------------------------------------
// Nothing sensitive lands in the DOM
// ---------------------------------------------------------------------------

test("no governance form puts a token, secret or credential into the DOM", () => {
  for (const rel of [...ALL_FORMS, ACTION_STATE, FORM_FIELD]) {
    const src = read(rel);
    assert.equal(
      /readApiToken|setApiToken|Authorization|Bearer |localStorage|sessionStorage/.test(src),
      false,
      `${rel} touches credential material — the session cookie is the only auth these controls may use`,
    );
    assert.equal(
      /type="password"/.test(src),
      false,
      `${rel} collects a credential`,
    );
  }
});
