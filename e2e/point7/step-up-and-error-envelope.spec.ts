/**
 * PHASE 13 §2 — THE ERROR ENVELOPE AND THE STEP-UP FLOWS, IN A REAL BROWSER.
 *
 * WHAT THIS LAYER ADDS
 * ---------------------------------------------------------------------------
 * `apps/web/__tests__/phase13-api-error-envelope.test.ts` drives the real
 * `apiFetch` against a stubbed `fetch` and proves the envelope is built
 * correctly. It is a good test and this suite does not repeat it. What it
 * cannot reach is the half that made the defects matter:
 *
 *   NEW-030  `ApiError` never assigned `body`, so every one of the sixteen
 *            `err.body?.error?.code` branches in the application read
 *            `undefined` and rendered the generic fallback instead of the
 *            specific, actionable sentence.
 *   NEW-032  a nested code with NO `message` — `{ error: { code:
 *            "owner_required" } }`, which is literally what three of these
 *            routes send — failed the "standard shape" test, fell to the
 *            generic branch, and arrived as a plain `Error` with code
 *            `API_ERROR` and no body at all. `extractStepUp()` could therefore
 *            never see a server denial, and the step-up panel could never open
 *            from one.
 *
 * Neither defect changes a status code, a route, or a database row. Both are
 * invisible to any assertion that stops at "the request was refused". The only
 * way to prove they are fixed is to make a REAL route refuse a REAL mutation
 * and then look at what the user is shown — which is what every scenario below
 * does, in a production build, through the real controls.
 *
 * HOW THE PROOF IS CONSTRUCTED
 * ---------------------------------------------------------------------------
 * Three independent facts are asserted together for each denial:
 *
 *   the SERVER's response  (status and raw body, correlated to the click)
 *   the DOM               (the exact sentence, and the absence of the generic)
 *   the DATABASE          (read with raw SQL: what was, or was not, written)
 *
 * The DOM assertion is the one that carries the envelope proof, and it is
 * deliberately preferred over reading the client's internals. A branch keyed on
 * `e.body?.error?.code` can only produce its sentence if `body` arrived; the
 * step-up panel can only render an authenticator field if `methods` arrived
 * beside a code that carried no message. Observing the consequence proves the
 * mechanism; reading `ApiError` directly would only prove that a field exists.
 *
 * PRECONDITIONS ARE CONSTRUCTED, NEVER INTERCEPTED
 * ---------------------------------------------------------------------------
 * Every denial here is produced by putting the system into the state the route
 * checks — an active billing relationship, an already-open closure request, a
 * membership removed between page load and submit. Nothing is stubbed and no
 * response is rewritten, because a denial manufactured at the boundary proves
 * only that the boundary can be manufactured.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";

import {
  WEB_BASE,
  createAccount,
  directApiCall,
  login,
  provenBrowserScenario,
  sql,
  type BrowserAccount,
} from "./_harness";
import {
  BOUNDED_FORBIDDEN_COPY,
  DENIAL_COPY,
  GENERIC_FALLBACK_COPY,
  WORKSPACE_CLOSURE_PHRASE,
  awaitApiResponse,
  createOwnedWorkspace,
  denialEnvelope,
  dropPasswordCredential,
  enrolTotpFactor,
  invalidTotpCodeFor,
  makeWorkspaceBillingActive,
  orgRoleOf,
  provisionOrganizationWithMember,
  totpCodeFor,
  watchPage,
  workspaceClosureRows,
  type ObservedResponse,
  type PageWatch,
} from "./_step-up-fixtures";

const SUITE = "e2e/point7/step-up-and-error-envelope.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

// ===========================================================================
// Shared journey pieces
// ===========================================================================

/** The workspace closure card, and the controls inside it. */
function closureCard(page: Page) {
  const card = page.locator("[data-workspace-closure-card]");
  return {
    card,
    open: card.locator('[data-action="open-workspace-closure"]'),
    phrase: page.locator("#workspace-closure-confirm"),
    submit: card.locator('[data-action="request-workspace-closure"]'),
    stepUp: card.locator("[data-cc-step-up-verify]"),
    stepUpInput: card.locator("[data-cc-step-up-input]"),
    stepUpSubmit: card.locator("[data-cc-step-up-submit]"),
    alert: card.locator('[role="alert"]'),
    status: card.locator("[data-workspace-closure-status]"),
    blockers: card.locator("[data-workspace-closure-blockers]"),
  };
}

/**
 * Sign in, create an owned workspace, and open its closure form with the
 * correct confirmation phrase typed in.
 *
 * Stops one click short of submitting, because every scenario below diverges at
 * exactly that point — which denial the server is about to produce depends on
 * the state each test constructs next.
 */
async function openClosureForm(
  page: Page,
  account: BrowserAccount,
  label: string,
): Promise<{ teamId: string; watch: PageWatch }> {
  const watch = await watchPage(page);
  await login(page, account);
  const teamId = await createOwnedWorkspace(page, `p7 step-up ${label}`);
  await page.goto(`${WEB_BASE}/teams/${teamId}`, {
    waitUntil: "domcontentloaded",
  });

  const ui = closureCard(page);
  // The card is owner-only AND self-hides when its own read is refused, so its
  // presence is already a statement about authorization rather than markup.
  await expect(ui.card).toBeVisible();
  await ui.open.click();
  await ui.phrase.fill(WORKSPACE_CLOSURE_PHRASE);
  return { teamId, watch };
}

/**
 * Assert that a rendered sentence is the SPECIFIC copy for a denial code and
 * not the generic fallback.
 *
 * The negative half is the load-bearing one. Before NEW-030 every one of these
 * surfaces rendered a plausible-looking error box — it simply contained the
 * wrong sentence, which no "an error appeared" assertion can distinguish.
 */
async function expectSpecificDenialCopy(
  region: Locator,
  expected: string,
): Promise<void> {
  await expect(region).toBeVisible();
  await expect(region).toContainText(expected);
  const rendered = (await region.innerText()).trim();
  for (const generic of GENERIC_FALLBACK_COPY) {
    expect(
      rendered,
      `the generic fallback surfaced instead of the specific denial copy`,
    ).not.toContain(generic);
  }
  // A denial the user can act on never shows them a raw code or a broken
  // interpolation.
  expect(rendered).not.toMatch(/undefined|\[object Object\]/);
}

/** The `error` object a denial carried, asserted to be a real envelope. */
function envelopeOf(res: ObservedResponse, code: string): Record<string, unknown> {
  const env = denialEnvelope(res);
  expect(env, `the denial carried no error envelope: ${res.text}`).not.toBeNull();
  expect(env!["code"]).toBe(code);
  return env!;
}

// ===========================================================================
// 1 — The step-up panel opens from a REAL server denial, and the retry lands
// ===========================================================================

test("p7.stepup.workspace_closure.panel_opens_from_server_denial", async ({
  page,
}) => {
  const account = await createAccount({ label: "su-pw", plan: "PRO" });
  const { teamId, watch } = await openClosureForm(page, account, "password");
  const ui = closureCard(page);

  // --- the denial ---------------------------------------------------------
  // A password account can prove itself in place, so the account step-up
  // service answers 401 STEP_UP_REQUIRED with `methods: ["password"]`
  // (services/api/src/services/identity-security/account-step-up.service.ts:221).
  const denied = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  expect(denied.status, denied.text).toBe(401);
  const envelope = envelopeOf(denied, "STEP_UP_REQUIRED");
  expect(envelope["methods"]).toEqual(["password"]);

  // --- the consequence ----------------------------------------------------
  // The panel is the SHARED `StepUpVerify` from the security centre, opened by
  // the SHARED `extractStepUp()`. It can only be here if `err.body.error.code`
  // survived `apiFetch`: `extractStepUp` reads nothing else.
  await expect(ui.stepUp).toBeVisible();
  // And `methods` reached the component. The panel's own default state is
  // ["reauth"], which renders a "sign out and sign back in" paragraph with NO
  // input at all — so a password field here is only possible if the array
  // beside the code arrived with it.
  await expect(ui.stepUpInput).toBeVisible();
  expect(await ui.stepUpInput.getAttribute("type")).toBe("password");
  await expect(ui.stepUp).toContainText("Current password");

  // Nothing was written by the refused attempt.
  expect(await workspaceClosureRows(teamId)).toEqual([]);
  await watch.assertClean("step-up panel opened from server denial");
  proven("p7.stepup.workspace_closure.panel_opens_from_server_denial");

  // --- the retry ----------------------------------------------------------
  // The panel hands the proof back to the SAME call site, which re-issues the
  // ORIGINAL mutation with it. That is the behaviour NEW-032 removed entirely:
  // with no body there was no panel, so there was no retry to make.
  const accepted = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(account.password);
      await ui.stepUpSubmit.click();
    },
  );
  expect(accepted.status, accepted.text).toBe(201);

  // The durable effect, read with raw SQL rather than through the same models
  // the write path used.
  const rows = await workspaceClosureRows(teamId);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("COOLING_OFF");

  // And the surface settled into the post-mutation state: panel gone, the
  // workspace now showing an open closure request it can still cancel.
  await expect(ui.stepUp).toHaveCount(0);
  await expect(ui.status).toHaveAttribute(
    "data-workspace-closure-status",
    "COOLING_OFF",
  );
  await watch.assertClean("step-up retry completed");
  proven("p7.stepup.workspace_closure.proof_retries_original_mutation");
});

// ===========================================================================
// 2 — STEP_UP_INVALID returns to the verification state, and is not a dead end
// ===========================================================================

test("p7.stepup.invalid_proof.returns_to_verification_state", async ({ page }) => {
  const account = await createAccount({ label: "su-invalid", plan: "PRO" });
  const { teamId, watch } = await openClosureForm(page, account, "invalid");
  const ui = closureCard(page);

  await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  await expect(ui.stepUp).toBeVisible();

  // --- a wrong proof ------------------------------------------------------
  const invalid = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill("not-this-accounts-password");
      await ui.stepUpSubmit.click();
    },
  );
  expect(invalid.status, invalid.text).toBe(401);
  const envelope = envelopeOf(invalid, "STEP_UP_INVALID");
  expect(envelope["methods"]).toEqual(["password"]);

  // The panel stays, carrying the SERVER's own explanation — `extractStepUp`
  // surfaces `message` only for STEP_UP_INVALID, so this sentence appearing is
  // a second, independent proof that the envelope's `message` survived.
  await expect(ui.stepUp).toBeVisible();
  await expect(ui.stepUp).toContainText("The current password is incorrect.");
  await expect(ui.stepUpInput).toBeVisible();
  // Not a dead end and not a raw error: the generic alert box did NOT take
  // over the card.
  await expect(ui.alert).toHaveCount(0);
  expect(await workspaceClosureRows(teamId)).toEqual([]);

  // --- and the correct proof still works from there ------------------------
  const accepted = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(account.password);
      await ui.stepUpSubmit.click();
    },
  );
  expect(accepted.status, accepted.text).toBe(201);
  const rows = await workspaceClosureRows(teamId);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("COOLING_OFF");

  await watch.assertClean("invalid proof returned to the verification state");
  proven("p7.stepup.invalid_proof.returns_to_verification_state");
});

// ===========================================================================
// 3 — `methods` decides which factor the user is asked for
// ===========================================================================

test("p7.stepup.methods_drive_the_factor_input", async ({ page }) => {
  const account = await createAccount({ label: "su-totp", plan: "PRO" });
  const watch = await watchPage(page);
  await login(page, account);

  // Enrol a real authenticator through the real routes, then remove the
  // password so "mfa" is the ONLY proof this account can offer. Order matters:
  // a password account signs in with its password.
  const factor = await enrolTotpFactor(page);
  await dropPasswordCredential(account.userId);

  const teamId = await createOwnedWorkspace(page, "p7 step-up totp");
  await page.goto(`${WEB_BASE}/teams/${teamId}`, {
    waitUntil: "domcontentloaded",
  });
  const ui = closureCard(page);
  await expect(ui.card).toBeVisible();
  await ui.open.click();
  await ui.phrase.fill(WORKSPACE_CLOSURE_PHRASE);

  const denied = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  expect(denied.status, denied.text).toBe(401);
  const envelope = envelopeOf(denied, "STEP_UP_REQUIRED");
  expect(envelope["methods"]).toEqual(["mfa"]);

  // THE assertion this scenario exists for. `StepUpVerify` picks its field
  // purely from `methods`: password wins if present, mfa otherwise, and with
  // neither it renders a re-sign-in paragraph and no input. The component's own
  // default is ["reauth"], so an authenticator field can only be on screen
  // because the array travelled inside `ApiError.body.error` — the exact
  // journey NEW-030 and NEW-032 broke between them.
  await expect(ui.stepUp).toBeVisible();
  await expect(ui.stepUpInput).toBeVisible();
  expect(await ui.stepUpInput.getAttribute("type")).toBe("text");
  await expect(ui.stepUp).toContainText("authenticator app");
  await expect(ui.stepUp).not.toContainText("Current password");
  await watch.assertClean("methods drove the factor input");
  proven("p7.stepup.methods_drive_the_factor_input");

  // --- a wrong code keeps the user in the same place ----------------------
  const rejected = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(invalidTotpCodeFor(factor.secretBase32));
      await ui.stepUpSubmit.click();
    },
  );
  expect(rejected.status, rejected.text).toBe(401);
  envelopeOf(rejected, "STEP_UP_INVALID");
  await expect(ui.stepUp).toContainText("That code didn't match. Try again.");
  expect(await workspaceClosureRows(teamId)).toEqual([]);

  // --- and the authenticator completes the original mutation ---------------
  const accepted = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(totpCodeFor(factor.secretBase32));
      await ui.stepUpSubmit.click();
    },
  );
  expect(accepted.status, accepted.text).toBe(201);
  const rows = await workspaceClosureRows(teamId);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("COOLING_OFF");

  await watch.assertClean("totp proof retried and completed");
  proven("p7.stepup.totp_proof.retries_original_mutation");
});

// ===========================================================================
// 4 — closure_blocked: a nested code with NO message reaches its own branch
// ===========================================================================

test("p7.apierror.closure_blocked.specific_copy_from_message_less_code", async ({
  page,
}) => {
  const account = await createAccount({ label: "ae-blocked", plan: "PRO" });
  const watch = await watchPage(page);
  await login(page, account);
  const teamId = await createOwnedWorkspace(page, "p7 blocked closure");
  // The precondition the PRODUCTION preflight reads. The blocker itself is
  // computed by the preflight service; only the billing state is seeded.
  await makeWorkspaceBillingActive(teamId);

  await page.goto(`${WEB_BASE}/teams/${teamId}`, {
    waitUntil: "domcontentloaded",
  });
  const ui = closureCard(page);
  await expect(ui.card).toBeVisible();
  // The card is honest up front: it lists the blocker it already knows about
  // and still offers the control, because the server is the authority.
  await expect(ui.blockers).toContainText("active billing relationship");
  await ui.open.click();
  await ui.phrase.fill(WORKSPACE_CLOSURE_PHRASE);

  await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  await expect(ui.stepUp).toBeVisible();

  const blocked = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(account.password);
      await ui.stepUpSubmit.click();
    },
  );
  expect(blocked.status, blocked.text).toBe(409);
  const envelope = envelopeOf(blocked, "closure_blocked");
  // THE NEW-032 SHAPE, from a real route: a nested code and nothing else.
  // Before the fix this body failed the standard-shape test, arrived as a
  // plain Error with code "API_ERROR" and no `body`, and the branch below
  // could not fire.
  expect(
    envelope["message"],
    "this route deliberately sends no message; if it gains one, this scenario " +
      "stops proving the message-less shape and must move to another code",
  ).toBeUndefined();

  await expectSpecificDenialCopy(ui.alert, DENIAL_COPY.closure_blocked);

  // Durable: the request was recorded as BLOCKED rather than scheduled, and
  // the card's own re-read now shows that state.
  const rows = await workspaceClosureRows(teamId);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("BLOCKED");
  await expect(ui.status).toHaveAttribute(
    "data-workspace-closure-status",
    "BLOCKED",
  );
  await watch.assertClean("closure_blocked rendered its own copy");
  proven("p7.apierror.closure_blocked.specific_copy_from_message_less_code");
});

// ===========================================================================
// 5 — closure_request_active: a stale form meets a request opened meanwhile
// ===========================================================================

test("p7.apierror.closure_request_active.stale_form_denied_with_specific_copy", async ({
  page,
}) => {
  const account = await createAccount({ label: "ae-active", plan: "PRO" });
  const { teamId, watch } = await openClosureForm(page, account, "already-open");
  const ui = closureCard(page);

  // A closure request is opened for this workspace while the form sits open —
  // through the REAL route, carrying its own step-up proof, so the row and its
  // state machine are the product's and not the harness's. This is the real
  // race the branch exists for: a second tab, or the same owner elsewhere.
  const outOfBand = await directApiCall(page, {
    method: "POST",
    path: `/v1/teams/${teamId}/closure`,
    body: {
      confirmation: WORKSPACE_CLOSURE_PHRASE,
      stepUp: { method: "password", currentPassword: account.password },
    },
  });
  expect(outOfBand.status, outOfBand.body).toBe(201);

  await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  await expect(ui.stepUp).toBeVisible();

  const conflict = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(account.password);
      await ui.stepUpSubmit.click();
    },
  );
  expect(conflict.status, conflict.text).toBe(409);
  envelopeOf(conflict, "closure_request_active");

  await expectSpecificDenialCopy(ui.alert, DENIAL_COPY.closure_request_active);

  // The conflict denied the SECOND request without disturbing the first: still
  // exactly one row, still cooling off.
  const rows = await workspaceClosureRows(teamId);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("COOLING_OFF");
  await watch.assertClean("closure_request_active rendered its own copy");
  proven(
    "p7.apierror.closure_request_active.stale_form_denied_with_specific_copy",
  );
});

// ===========================================================================
// 6 — confirmation_mismatch: the SERVER's own sentence reaches the user
// ===========================================================================

test("p7.apierror.confirmation_mismatch.server_message_reaches_the_user", async ({
  page,
}) => {
  const account = await createAccount({ label: "ae-phrase", plan: "PRO" });
  const { teamId, watch } = await openClosureForm(page, account, "phrase");
  const ui = closureCard(page);

  // Reaching this branch through the product takes the step-up retry, and the
  // sequence is an ordinary one: type the phrase, submit, get asked to verify,
  // change your mind about the wording while the panel is open, then verify.
  // The retry re-reads the confirmation field, so the second request carries
  // the edited phrase. (The submit button itself gates on a client-side match
  // with the same comparison the server performs, so a first attempt can never
  // mismatch — see the finding accompanying this suite.)
  await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  await expect(ui.stepUp).toBeVisible();
  await ui.phrase.fill("close this workspce");

  const mismatch = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.stepUpInput.fill(account.password);
      await ui.stepUpSubmit.click();
    },
  );
  expect(mismatch.status, mismatch.text).toBe(400);
  const envelope = envelopeOf(mismatch, "confirmation_mismatch");
  expect(envelope["message"]).toBe(DENIAL_COPY.confirmation_mismatch);

  // The DECISIVE envelope assertion of this suite: the component renders
  // `e.body?.error?.message` verbatim here, and its fallback for the same
  // branch is a DIFFERENT sentence ("The confirmation phrase does not match.").
  // Seeing the server's own wording — with the expected phrase inside it —
  // proves the message field of the envelope survived `apiFetch`, not just the
  // code.
  await expectSpecificDenialCopy(ui.alert, DENIAL_COPY.confirmation_mismatch);
  await expect(ui.alert).not.toContainText(
    "The confirmation phrase does not match.",
  );

  // A refused confirmation writes nothing.
  expect(await workspaceClosureRows(teamId)).toEqual([]);
  await watch.assertClean("confirmation_mismatch surfaced the server message");
  proven("p7.apierror.confirmation_mismatch.server_message_reaches_the_user");
});

// ===========================================================================
// 7 — target_not_member: the organization ownership transfer
// ===========================================================================

test("p7.apierror.org_transfer.target_not_member_specific_copy", async ({
  page,
}) => {
  const owner = await createAccount({ label: "ae-org-owner", plan: "FREE" });
  const member = await createAccount({ label: "ae-org-member", plan: "FREE" });
  const org = await provisionOrganizationWithMember({
    ownerUserId: owner.userId,
    memberUserId: member.userId,
  });

  const watch = await watchPage(page);
  await login(page, owner);
  await page.goto(`${WEB_BASE}/organizations/${org.organizationId}`, {
    waitUntil: "domcontentloaded",
  });

  // The lifecycle controls are owner-only, and the page states the role it
  // resolved — so this is also the assertion that the fixture is what it says.
  await expect(page.locator("[data-caller-role]")).toHaveAttribute(
    "data-caller-role",
    "ORG_OWNER",
  );
  const danger = page.locator('[data-section="org-danger-zone"]');
  const target = danger.locator('[data-control="transfer-ownership-target"]');
  await expect(target).toBeVisible();
  await target.selectOption(member.userId);

  // The precondition: the chosen member leaves the organization after the page
  // read the roster. This is the exact race the copy is written for — "is no
  // longer a member" — and it is why the check lives inside the transaction.
  await sql(
    `DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
    [org.organizationId, member.userId],
  );

  // The control confirms first (ownership moves billing with it), then the
  // route asks for step-up, and only then does the transaction discover the
  // missing membership.
  await danger.locator('[data-action="transfer-ownership"]').click();
  const modal = page.locator('[data-confirm-action-modal="org-transfer-confirm"]');
  await expect(modal).toBeVisible();
  await awaitApiResponse(
    page,
    { fragment: `/v1/orgs/${org.organizationId}/transfer-ownership`, method: "POST" },
    async () => {
      await modal.locator("[data-confirm-action-submit]").click();
    },
  );

  const stepUp = danger.locator("[data-cc-step-up-verify]");
  await expect(stepUp).toBeVisible();
  const notMember = await awaitApiResponse(
    page,
    { fragment: `/v1/orgs/${org.organizationId}/transfer-ownership`, method: "POST" },
    async () => {
      await danger.locator("[data-cc-step-up-input]").fill(owner.password);
      await danger.locator("[data-cc-step-up-submit]").click();
    },
  );
  expect(notMember.status, notMember.text).toBe(404);
  const envelope = envelopeOf(notMember, "target_not_member");
  // Another message-less nested code from a real route.
  expect(envelope["message"]).toBeUndefined();

  await expectSpecificDenialCopy(
    danger.locator('[role="alert"]'),
    DENIAL_COPY.target_not_member,
  );

  // The refused transfer moved nothing: the caller is still the owner.
  expect(await orgRoleOf(org.organizationId, owner.userId)).toBe("ORG_OWNER");
  await watch.assertClean("target_not_member rendered its own copy");
  proven("p7.apierror.org_transfer.target_not_member_specific_copy");
});

// ===========================================================================
// 8 — owner_required: authority lost between rendering and submitting
// ===========================================================================

test("p7.apierror.org_transfer.owner_required_specific_copy", async ({ page }) => {
  const owner = await createAccount({ label: "ae-own-owner", plan: "FREE" });
  const member = await createAccount({ label: "ae-own-member", plan: "FREE" });
  const org = await provisionOrganizationWithMember({
    ownerUserId: owner.userId,
    memberUserId: member.userId,
  });

  const watch = await watchPage(page);
  await login(page, owner);
  await page.goto(`${WEB_BASE}/organizations/${org.organizationId}`, {
    waitUntil: "domcontentloaded",
  });
  const danger = page.locator('[data-section="org-danger-zone"]');
  const target = danger.locator('[data-control="transfer-ownership-target"]');
  await expect(target).toBeVisible();
  await target.selectOption(member.userId);

  // The precondition: the caller is demoted after the page rendered the
  // owner-only controls. Frontend visibility is not authorization, and this is
  // the case that proves the product says so in words rather than only in a
  // status code.
  await sql(
    `UPDATE organization_memberships
        SET role = 'ORG_ADMIN'::"OrganizationRole", updated_at = NOW()
      WHERE organization_id = $1 AND user_id = $2`,
    [org.organizationId, owner.userId],
  );

  await danger.locator('[data-action="transfer-ownership"]').click();
  const modal = page.locator('[data-confirm-action-modal="org-transfer-confirm"]');
  await expect(modal).toBeVisible();
  const refused = await awaitApiResponse(
    page,
    { fragment: `/v1/orgs/${org.organizationId}/transfer-ownership`, method: "POST" },
    async () => {
      await modal.locator("[data-confirm-action-submit]").click();
    },
  );
  expect(refused.status, refused.text).toBe(403);
  const envelope = envelopeOf(refused, "owner_required");
  expect(envelope["message"]).toBeUndefined();

  await expectSpecificDenialCopy(
    danger.locator('[role="alert"]'),
    DENIAL_COPY.owner_required,
  );
  // The authorization check runs BEFORE step-up, so the user is told what is
  // actually wrong instead of being asked to verify something that could never
  // have succeeded.
  await expect(danger.locator("[data-cc-step-up-verify]")).toHaveCount(0);

  // Nothing moved.
  expect(await orgRoleOf(org.organizationId, owner.userId)).toBe("ORG_ADMIN");
  expect(await orgRoleOf(org.organizationId, member.userId)).toBe("ORG_MEMBER");
  await watch.assertClean("owner_required rendered its own copy");
  proven("p7.apierror.org_transfer.owner_required_specific_copy");
});

// ===========================================================================
// 9 — an UNHANDLED code falls back safely
// ===========================================================================

test("p7.apierror.unhandled_code.bounded_fallback_without_raw_detail", async ({
  page,
}) => {
  const account = await createAccount({ label: "ae-unknown", plan: "PRO" });
  const stranger = await createAccount({ label: "ae-stranger", plan: "PRO" });
  const { teamId, watch } = await openClosureForm(page, account, "unhandled");
  const ui = closureCard(page);

  // `owner_required` is a code the workspace closure card has no branch for,
  // which makes it the honest way to drive the fallback: a real route sending a
  // real code that this particular surface does not enumerate. The workspace
  // changes hands after the owner-only card rendered.
  await sql(`UPDATE teams SET owner_user_id = $1, updated_at = NOW() WHERE id = $2`, [
    stranger.userId,
    teamId,
  ]);

  const refused = await awaitApiResponse(
    page,
    { fragment: `/v1/teams/${teamId}/closure`, method: "POST" },
    async () => {
      await ui.submit.click();
    },
  );
  expect(refused.status, refused.text).toBe(403);
  envelopeOf(refused, "owner_required");

  // Bounded copy, chosen by status because the code is unmapped. What matters
  // is what is NOT there: no raw code, no backend sentence, no empty box, and
  // no crash.
  await expect(ui.alert).toBeVisible();
  const rendered = (await ui.alert.innerText()).trim();
  expect(rendered).toContain(BOUNDED_FORBIDDEN_COPY);
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered).not.toContain("owner_required");
  expect(rendered).not.toMatch(/undefined|\[object Object\]|prisma|SELECT |at Object/i);

  // The page is still alive and the control is still usable — a fallback, not a
  // dead end.
  await expect(ui.card).toBeVisible();
  await expect(ui.submit).toBeEnabled();
  expect(await workspaceClosureRows(teamId)).toEqual([]);

  await watch.assertClean("unhandled code fell back safely");
  proven("p7.apierror.unhandled_code.bounded_fallback_without_raw_detail");
});
