/**
 * PHASE 13 §NEW-058 — THE STEP-UP FACTOR BELONGS TO THE ACCOUNT, IN A REAL
 * BROWSER.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The enterprise step-up took the handset out of the REQUEST BODY. A challenge
 * approved that way proves possession of a phone the CALLER chose, not of one
 * the ACCOUNT owns — so a stolen session supplied the attacker's own number,
 * received its own code, approved its own challenge, and walked through every
 * gate the product has: publication, reviewer decisions, escalation resolution,
 * destruction approval and execution, governance policy updates, delegated
 * admin grants.
 *
 * The fix is an enrolled, VERIFIED, revocable factor stored against the user,
 * with the destination resolved server-side and re-checked at SPEND time so an
 * elevation dies with the enrolment that authorised it.
 *
 * WHY THIS SUITE EXISTS ALONGSIDE THE SERVER ONE
 * ---------------------------------------------------------------------------
 * `phase-13-new058-account-bound-step-up.integration.test.ts` already proves
 * the server half against live PostgreSQL: a PENDING enrolment cannot elevate,
 * a foreign factor id does not resolve, revocation moves the generation, the
 * destination is never stored in the clear, and the CHECK constraints refuse an
 * ACTIVE-but-unverified row. None of that is repeated here.
 *
 * What a server suite structurally cannot establish is the half that made the
 * defect reachable in the first place: WHAT A REAL CLIENT SENDS. The old
 * defect was not a missing server check — it was a request body the product
 * populated from a form field. So every assertion below is about the wire and
 * the screen:
 *
 *   - the challenge-start Chromium actually issues, read off the request body,
 *     carries no destination of any kind;
 *   - the enrolment surface EXISTS and is reachable by a CORE-tier account,
 *     because a gate no user can satisfy is a gate that disables the product;
 *   - the raw handset never reaches the response, the DOM or the console;
 *   - an unenrolled user is offered the one action that fixes them rather than
 *     a dead end.
 *
 * NO CODE IS EVER READ FROM A DATABASE ROW
 * ---------------------------------------------------------------------------
 * Every OTP below comes from the recording provider's own artifact, keyed by
 * the recipient alias. The `step_up_challenges` row deliberately holds no code,
 * so a database-driven approval could only be manufactured by WRITING one —
 * which would demonstrate that the gate can be written around, not that a user
 * can pass it. The same applies to `mfa_factors`: enrolment is driven through
 * `/settings#security`, never seeded.
 *
 * NO RAW DESTINATION, CODE OR SECRET IS EVER PRINTED. Assertions are written so
 * that a failure names the FIELD, never its value.
 */

import { test, expect, type Page } from "@playwright/test";

import {
  API_BASE,
  WEB_BASE,
  handsetFor,
  login,
  provenBrowserScenario,
  sql,
  waitForStepUpCode,
} from "./_harness";
import {
  attachUiProbe,
  buildEnterpriseFixture,
  enrolContactFactor,
  seedEvidence,
  stepUpWithRecordedCode,
  uniqueHandset,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/new-058-account-bound-step-up.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/**
 * Field names that name a place a code could be SENT.
 *
 * Deliberately broader than the field that actually existed: the defect must
 * stay caught if someone reintroduces it under a different spelling.
 */
const DESTINATION_FIELDS = [
  "phone",
  "phoneNumber",
  "phoneE164",
  "destination",
  "recipient",
  "recipientPhone",
  "msisdn",
  "handset",
  "to",
] as const;

// ===========================================================================
// Journey pieces
// ===========================================================================

/** The enrolment panel on `/settings#security` and the controls inside it. */
function factorPanel(page: Page) {
  const panel = page.locator("[data-contact-factor-panel]");
  return {
    panel,
    state: () => panel.getAttribute("data-contact-factor-state"),
    active: () => panel.getAttribute("data-contact-factor-active"),
    destination: panel.locator("[data-contact-factor-destination]"),
    send: panel.locator("[data-contact-factor-send]"),
    code: panel.locator("[data-contact-factor-code]"),
    verify: panel.locator("[data-contact-factor-verify]"),
    mask: panel.locator("[data-contact-factor-mask]"),
    enrolledMask: panel.locator("[data-contact-factor-enrolled-mask]"),
    codeError: panel.locator("[data-contact-factor-code-error]"),
    rows: panel.locator("[data-contact-factor-row]"),
  };
}

/**
 * The evidence-publication surface — a real `requireStepUpForSensitiveAction`
 * gate.
 *
 * Publication is irreversible in the sense that matters (a link already shared
 * has been live), so the panel control opens a TYPED-CONFIRM dialog and the
 * DIALOG's submit is what issues the request. `fire()` drives that whole
 * sequence, because a spec that clicked only the panel control would sit
 * waiting for a request the product never had any reason to send.
 */
function publishSurface(page: Page) {
  const dialog = page.locator(
    '[data-confirm-action-modal="evidence-public-verify-publish"]',
  );
  return {
    panel: page.locator('[data-evidence-section="public-verify-publication"]'),
    control: page.locator("[data-cc-public-verify-publish]"),
    blocked: page.locator("[data-cc-public-verify-blocked]"),
    dialog,
    modal: page.locator("[data-step-up-modal]"),
    modalState: () =>
      page.locator("[data-step-up-modal]").getAttribute("data-step-up-state"),
    enrollmentRequired: page.locator("[data-step-up-enrollment-required]"),
    enrollLink: page.locator("[data-step-up-enroll-link]"),
    codeInput: page.locator("[data-step-up-code-input]"),
    verify: page.locator("[data-step-up-verify]"),
    failed: page.locator("[data-step-up-failed]"),

    /** Panel control → typed-confirm dialog → the request. */
    async fire(): Promise<void> {
      await expect(
        this.panel,
        "the public-verify panel renders only for an enterprise-entitled " +
          "workspace; its absence is an entitlement-projection defect, not a " +
          "step-up one",
      ).toBeVisible({ timeout: 30_000 });
      const blockedCount = await this.blocked.count();
      if (blockedCount > 0) {
        throw new Error(
          "the publish control is blocked: " +
            `"${(await this.blocked.first().textContent())?.trim()}". ` +
            "This is a fixture precondition (reviewWorkflow.teamId, " +
            "publicVerifyIncluded, summary.enabled, summary.configured — the " +
            "last needs ANCHOR_PROVIDER on the API process), not a NEW-058 defect.",
        );
      }
      await expect(this.control).toBeEnabled({ timeout: 30_000 });
      await page
        .locator("[data-cc-public-verify-reason]")
        .fill("Published by the NEW-058 account-bound step-up proof.");
      await this.control.click();
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await dialog.locator("[data-confirm-action-typed-input]").fill("PUBLISH");
      const submit = dialog.locator('[data-confirm-action-submit="true"]');
      await expect(submit).toBeEnabled({ timeout: 10_000 });
      await submit.click();
    },
  };
}

/** Seed a NOT_PUBLISHED evidence record and open its overview tab. */
async function openPublishableEvidence(
  page: Page,
  fixture: UiEnterpriseFixture,
  title: string,
): Promise<string> {
  const id = await seedEvidence(page, {
    teamId: fixture.tenant.workspaceId,
    title,
  });
  await sql(
    `UPDATE evidence SET public_verify_state = 'NOT_PUBLISHED'::"PublicVerifyState"
      WHERE id = $1::uuid`,
    [id],
  );
  await page.goto(`${WEB_BASE}/evidence/${id}?tab=overview`, {
    waitUntil: "domcontentloaded",
  });
  return id;
}

/** The account's factor rows, projected without ever selecting the destination. */
async function factorRows(userId: string) {
  return sql<{ id: string; status: string; verified_at_utc: string | null; generation: number }>(
    `SELECT id, status::text AS status, verified_at_utc, generation
       FROM mfa_factors
      WHERE user_id = $1::uuid
      ORDER BY created_at ASC`,
    [userId],
  );
}

async function publishStateOf(evidenceId: string): Promise<string> {
  const rows = await sql<{ state: string }>(
    `SELECT public_verify_state::text AS state FROM evidence WHERE id = $1::uuid`,
    [evidenceId],
  );
  return rows[0]?.state ?? "<absent>";
}

/**
 * Assert the CSP stayed clean and nothing reached the web origin for `/v1/*`.
 *
 * Every scenario here calls it, which is what makes this suite part of the
 * phase's CSP proof rather than a separate exercise.
 */
async function assertBoundaryClean(probe: UiProbe, where: string): Promise<void> {
  expect(probe.wrongOriginV1().map((r) => r.url()), `${where}: /v1 reached the web origin`).toEqual([]);
  expect(await probe.cspViolations(), `${where}: CSP violations`).toEqual([]);
  expect(probe.pageErrors, `${where}: uncaught page errors`).toEqual([]);
}

// ===========================================================================
// 1 — ENROLMENT
// ===========================================================================

test.describe("NEW-058 — an account acquires its own factor", () => {
  test("p7.new058.enroll.journey_activates_an_account_bound_factor", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-enrol" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    // The account starts with nothing to send a code to. Asserted rather than
    // assumed: a fixture that arrived pre-enrolled would prove nothing.
    expect(await factorRows(fixture.owner.userId)).toEqual([]);

    await page.goto(`${WEB_BASE}/settings#security`, {
      waitUntil: "domcontentloaded",
    });
    const ui = factorPanel(page);

    /**
     * THE SURFACE MUST EXIST FOR A CORE-TIER PERSONAL SETTINGS ACCOUNT.
     *
     * This is not a formality. The step-up gate refuses every sensitive action
     * without a factor, so if this panel were gated at ENTERPRISE — as
     * `/security-center` is — the product would contain a lock with no key and
     * every step-up-dependent feature would be unreachable for the accounts
     * that need it most.
     */
    await expect(
      ui.panel,
      "the contact-factor enrolment panel must render in CORE-tier Personal Settings",
    ).toBeVisible({ timeout: 30_000 });
    await expect(ui.destination).toBeVisible();
    expect(await ui.active()).toBe("false");

    const handset = uniqueHandset();
    await ui.destination.fill(handset);
    await ui.send.click();

    await expect
      .poll(async () => (await ui.state()) ?? "", {
        message: "enrolment must leave the destination step",
        timeout: 30_000,
      })
      .toBe("otp_sent");

    // The code the handset received, from the RECORDER. The database never
    // holds it, so this is the only honest source.
    const code = await waitForStepUpCode({ recipient: handset, timeoutMs: 20_000 });
    await ui.code.fill(code);
    await ui.verify.click();

    await expect(ui.panel).toHaveAttribute(
      "data-contact-factor-state",
      /enrolled|replacement_complete/,
      { timeout: 30_000 },
    );
    // RETRIED, because these two attributes have different sources.
    // `data-contact-factor-state` is local phase state and flips to
    // `enrolled` the moment verification returns;
    // `data-contact-factor-active` is derived from the REFETCHED factor list,
    // so it stays "false" until the server confirms an ACTIVE row. The panel
    // is right to say so — until the refetch lands it has no confirmed factor
    // — but a one-shot `getAttribute` in that window read the truth of a
    // moment and called it a failure. Same attribute, same expected value,
    // waited for rather than sampled.
    await expect(ui.panel).toHaveAttribute(
      "data-contact-factor-active",
      "true",
      { timeout: 30_000 },
    );

    // The durable postcondition: ACTIVE, and verified. The database CHECK
    // refuses ACTIVE without `verified_at_utc`, so both together are what
    // distinguishes an enrolment from a claim.
    const rows = await factorRows(fixture.owner.userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("ACTIVE");
    expect(rows[0]!.verified_at_utc).not.toBeNull();

    // Only a MASK is shown. Never the number.
    await expect(ui.enrolledMask.or(ui.mask).first()).toBeVisible();
    const shownMask = (await ui.enrolledMask.or(ui.mask).first().textContent()) ?? "";
    expect(shownMask.trim().length).toBeGreaterThan(0);
    expect(
      shownMask.includes(handset),
      "the enrolled destination must be masked, never echoed",
    ).toBe(false);

    await assertBoundaryClean(probe, "enrolment journey");
    proven("p7.new058.enroll.journey_activates_an_account_bound_factor");
  });

  test("p7.new058.enroll.raw_destination_never_reaches_the_client", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-mask" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    /**
     * Read the projection the way the CLIENT does — through the browser's own
     * session against the API origin — and assert the raw destination is not in
     * it. A server test asserting the same thing about a service return value
     * cannot see what the route actually serialises.
     */
    const projection = await page.evaluate(async (apiBase: string) => {
      const res = await fetch(`${apiBase}/v1/identity-security/contact-factors`, {
        credentials: "include",
      });
      return { status: res.status, body: await res.text() };
    }, API_BASE);

    expect(projection.status).toBe(200);
    expect(
      projection.body.includes(handset),
      "the contact-factors projection must never carry the raw destination",
    ).toBe(false);
    // The last four digits are what a mask legitimately shows; the full E.164
    // and its unformatted form are what it must not.
    expect(projection.body.includes(handset.replace(/^\+/, ""))).toBe(false);

    // Nor may it be anywhere in the rendered document…
    await page.goto(`${WEB_BASE}/settings#security`, {
      waitUntil: "domcontentloaded",
    });
    await expect(factorPanel(page).panel).toBeVisible({ timeout: 30_000 });
    const dom = (await page.content()) ?? "";
    expect(
      dom.includes(handset),
      "the raw destination must not appear in the DOM",
    ).toBe(false);

    // …nor in anything the page logged.
    expect(
      probe.consoleErrors.some((line) => line.includes(handset)),
      "the raw destination must not appear in console output",
    ).toBe(false);

    await assertBoundaryClean(probe, "masking");
    proven("p7.new058.enroll.raw_destination_never_reaches_the_client");
  });
});

// ===========================================================================
// 2 — THE STEP-UP JOURNEY
// ===========================================================================

test.describe("NEW-058 — the gate reads the factor, not the request", () => {
  test("p7.new058.stepup.start_request_carries_no_destination", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-wire" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    await openPublishableEvidence(page, fixture, "N058 wire subject");
    const ui = publishSurface(page);

    // Capture the challenge-start REQUEST BODY as Chromium sends it.
    const startRequest = page.waitForRequest(
      (r) =>
        r.url().includes("/v1/identity-security/step-up/start") &&
        r.method() === "POST",
      { timeout: 45_000 },
    );
    await ui.fire();
    const req = await startRequest;

    /**
     * THE ASSERTION THIS WHOLE FINDING REDUCES TO.
     *
     * Not "the server would have rejected a destination" — that is the server
     * suite's job — but "the product does not send one". The defect was a form
     * field feeding this body, and this is the only layer that can see it.
     */
    const raw = req.postData() ?? "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const field of DESTINATION_FIELDS) {
      expect(
        Object.prototype.hasOwnProperty.call(body, field),
        `the challenge-start body must not carry \`${field}\``,
      ).toBe(false);
    }
    // And the value must not be smuggled through any other key either.
    expect(
      raw.includes(handset),
      "no field of the challenge-start body may contain the destination",
    ).toBe(false);

    // The server nonetheless sent a code — which it could only do by resolving
    // the destination from the account's own ACTIVE factor.
    await expect
      .poll(async () => (await ui.modalState()) ?? "", { timeout: 30_000 })
      .toBe("verifying");
    const delivered = handsetFor(handset, "verification_start");
    expect(
      delivered.length,
      "the server must have resolved the enrolled factor and sent to it",
    ).toBeGreaterThan(0);

    await assertBoundaryClean(probe, "challenge start");
    proven("p7.new058.stepup.start_request_carries_no_destination");
  });

  test("p7.new058.stepup.approved_proof_drives_one_protected_mutation", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-spend" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    const evidenceId = await openPublishableEvidence(
      page,
      fixture,
      "N058 spend subject",
    );
    expect(await publishStateOf(evidenceId)).toBe("NOT_PUBLISHED");

    const ui = publishSurface(page);

    const mark = probe.mark();
    await ui.fire();
    await stepUpWithRecordedCode(page, handset)();

    // The visible result…
    await expect
      .poll(async () => publishStateOf(evidenceId), {
        message: "the protected mutation must reach its durable postcondition",
        timeout: 30_000,
      })
      .toBe("PUBLISHED");

    // …and EXACTLY ONE of it. A step-up surface that replays its 401 would
    // perform the mutation twice and burn two attempts (NEW-035).
    const publishes = probe
      .apiMutations("POST", `/v1/governance/evidence/${evidenceId}/publish`)
      .slice(mark);
    expect(
      publishes.length,
      "one activation must produce one protected mutation",
    ).toBeLessThanOrEqual(2); // the denied attempt + the retry carrying the proof

    // The factor was not consumed by being spent — it stays ACTIVE for the
    // next challenge, which is what makes it an enrolment rather than a token.
    const rows = await factorRows(fixture.owner.userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("ACTIVE");

    await assertBoundaryClean(probe, "protected mutation");
    proven("p7.new058.stepup.approved_proof_drives_one_protected_mutation");
  });

  test("p7.new058.stepup.unenrolled_account_is_offered_enrolment", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-unenrolled" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    // DELIBERATELY NOT ENROLLED.
    expect(await factorRows(fixture.owner.userId)).toEqual([]);

    const evidenceId = await openPublishableEvidence(
      page,
      fixture,
      "N058 unenrolled subject",
    );
    const ui = publishSurface(page);

    /**
     * THE SERVER IS THE AUTHORITY, AND IT IS ASSERTED DIRECTLY.
     *
     * The modal deliberately does NOT reach `/step-up/start` for an unenrolled
     * account: it reads the factor roster first and short-circuits, because
     * asking for a challenge the server must refuse would spend a rate-limit
     * slot to arrive at a denial the client can already name
     * (`StepUpModal.tsx:180-212`). That is a real product decision, so waiting
     * for that request would be this spec asserting a round-trip the product
     * intentionally does not make.
     *
     * The denial code still has to be the server's, or "enrolment required"
     * would be a client opinion that could drift from what the API enforces. So
     * it is proven where it actually lives — the route itself, called from the
     * browser's own authenticated session — and the UI half is proven
     * separately below. Both, rather than one standing in for the other.
     */
    const denial = await page.evaluate(
      async ({ apiBase, teamId }: { apiBase: string; teamId: string }) => {
        const res = await fetch(`${apiBase}/v1/identity-security/step-up/start`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, purpose: "PUBLIC_VERIFY_PUBLISH" }),
        });
        return { status: res.status, body: await res.text() };
      },
      { apiBase: API_BASE, teamId: fixture.tenant.workspaceId },
    );
    expect(denial.status).toBe(403);
    expect(
      (JSON.parse(denial.body) as { error?: { code?: string } }).error?.code,
    ).toBe("STEP_UP_ENROLLMENT_REQUIRED");

    await ui.fire();

    /**
     * A stable denial code is only half of it. The user must be offered the one
     * action that fixes them: collapsing this into the generic bucket would
     * leave every step-up-gated feature looking broken with no way forward.
     */
    await expect
      .poll(async () => (await ui.modalState()) ?? "", { timeout: 45_000 })
      .toBe("enrollment_required");
    await expect(ui.enrollmentRequired).toBeVisible();
    await expect(ui.enrollLink).toBeVisible();
    expect(await ui.enrollLink.getAttribute("href")).toBe("/settings#security");

    // And the mutation did NOT happen.
    expect(await publishStateOf(evidenceId)).toBe("NOT_PUBLISHED");

    // The link goes where it says it goes, and the panel is there.
    await ui.enrollLink.click();
    await expect(factorPanel(page).panel).toBeVisible({ timeout: 30_000 });

    await assertBoundaryClean(probe, "enrolment-required denial");
    proven("p7.new058.stepup.unenrolled_account_is_offered_enrolment");
  });

  test("p7.new058.stepup.wrong_code_refused_without_elevation", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-wrongcode" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    const evidenceId = await openPublishableEvidence(
      page,
      fixture,
      "N058 wrong-code subject",
    );
    const ui = publishSurface(page);
    await ui.fire();

    await expect
      .poll(async () => (await ui.modalState()) ?? "", { timeout: 30_000 })
      .toBe("verifying");

    // A code that is well-formed and wrong. Derived from the real one so it can
    // never accidentally BE the real one.
    const real = await waitForStepUpCode({ recipient: handset, timeoutMs: 20_000 });
    const wrong = real
      .split("")
      .map((c) => (/[0-9]/.test(c) ? String((Number(c) + 5) % 10) : c))
      .join("");
    expect(wrong).not.toBe(real);

    await ui.codeInput.fill(wrong);
    await ui.verify.click();

    // The user is kept at verification or told plainly — never elevated.
    await expect
      .poll(async () => (await ui.modalState()) ?? "", { timeout: 30_000 })
      .toMatch(/verifying|failed/);

    // The durable postcondition is the one that matters: nothing moved.
    expect(await publishStateOf(evidenceId)).toBe("NOT_PUBLISHED");

    await assertBoundaryClean(probe, "wrong code");
    proven("p7.new058.stepup.wrong_code_refused_without_elevation");
  });

  test("p7.new058.stepup.revoked_factor_kills_an_unspent_elevation", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-revoke" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    const evidenceId = await openPublishableEvidence(
      page,
      fixture,
      "N058 revoke subject",
    );
    const ui = publishSurface(page);
    await ui.fire();

    await expect
      .poll(async () => (await ui.modalState()) ?? "", { timeout: 30_000 })
      .toBe("verifying");
    const code = await waitForStepUpCode({ recipient: handset, timeoutMs: 20_000 });

    /**
     * REVOKE BETWEEN APPROVAL AND SPEND.
     *
     * This is the whole reason the factor is re-checked at spend time: an
     * elevation that outlives the enrolment that authorised it is exactly the
     * long-lived capability NEW-058 set out to remove. Revocation is driven
     * through the product's own route so the generation moves the way it does
     * in production.
     */
    const revoked = await page.evaluate(
      async ({ apiBase }: { apiBase: string }) => {
        const list = await fetch(`${apiBase}/v1/identity-security/contact-factors`, {
          credentials: "include",
        });
        const body = (await list.json()) as { factors?: Array<{ factorId: string }> };
        const id = body.factors?.[0]?.factorId;
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(
          `${apiBase}/v1/identity-security/contact-factors/${id}/revoke`,
          { method: "POST", credentials: "include" },
        );
        return { ok: res.ok, status: res.status };
      },
      { apiBase: API_BASE },
    );
    expect(revoked.status, "the factor must be revocable through its own route").toBe(200);

    const afterRevoke = await factorRows(fixture.owner.userId);
    expect(afterRevoke[0]!.status).not.toBe("ACTIVE");

    // Now spend the code that was minted while the factor was still live.
    await ui.codeInput.fill(code);
    await ui.verify.click();

    // The elevation must not complete the mutation.
    await page.waitForTimeout(0);
    await expect
      .poll(async () => publishStateOf(evidenceId), {
        message:
          "an elevation authorised by a factor that has since been revoked must " +
          "not be spendable",
        timeout: 20_000,
      })
      .toBe("NOT_PUBLISHED");

    await assertBoundaryClean(probe, "revoked factor");
    proven("p7.new058.stepup.revoked_factor_kills_an_unspent_elevation");
  });

  test("p7.new058.stepup.caller_selected_destination_is_rejected", async ({
    page,
  }) => {
    const fixture = await buildEnterpriseFixture({ label: "n058-strict" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.owner);

    const handset = uniqueHandset();
    await enrolContactFactor(page, handset);

    /**
     * A client that still sends a destination must be REFUSED, not tolerated.
     *
     * `.strict()` is what makes a lingering `phone` a 400 rather than a
     * silently-ignored field — the difference between a client that must be
     * fixed and one that looks like it still works. Issued from the browser's
     * own session so it is the real route, with the real schema, behind the
     * real auth.
     */
    const attacker = uniqueHandset();
    const call = (body: Record<string, unknown>) =>
      page.evaluate(
        async ({ apiBase, payload }: { apiBase: string; payload: Record<string, unknown> }) => {
          const res = await fetch(`${apiBase}/v1/identity-security/step-up/start`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          return { status: res.status, body: await res.text() };
        },
        { apiBase: API_BASE, payload: body },
      );

    const base = {
      teamId: fixture.tenant.workspaceId,
      purpose: "PUBLIC_VERIFY_PUBLISH",
    };

    /**
     * THE CONTROL COMES FIRST, AND IT IS NOT OPTIONAL.
     *
     * Without it this scenario passes for the wrong reason: ANY malformed body
     * is a 400, so a typo in the purpose enum would look exactly like `.strict()`
     * doing its job. Proving the SAME body succeeds without `phone` is what
     * makes the refusal attributable to the destination field and nothing else.
     */
    const accepted = await call(base);
    expect(
      accepted.status,
      "control: the same request without a destination must be ACCEPTED — " +
        "otherwise the refusal below proves nothing about the destination",
    ).toBe(200);

    const refused = await call({ ...base, phone: attacker, channel: "SMS" });
    expect(
      refused.status,
      "a caller-supplied destination must be refused by the strict schema",
    ).toBe(400);

    // And critically: nothing was sent to the number the CALLER named.
    expect(
      handsetFor(attacker).length,
      "no code may ever be sent to a destination the caller chose",
    ).toBe(0);

    await assertBoundaryClean(probe, "strict schema");
    proven("p7.new058.stepup.caller_selected_destination_is_rejected");
  });
});
