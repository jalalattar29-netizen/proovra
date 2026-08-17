/**
 * PHASE 13 — POINT 7: shared fixtures for the UI-capability browser matrix.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Twenty-four write capabilities were implemented in this pass as NEW web
 * components. Each of them is a control that a user can see and press, and the
 * only question worth asking about a control is whether pressing it makes the
 * server do the thing. Twenty-four independently-provisioned environments
 * would answer that question twenty-four times and would also be twenty-four
 * chances to prove something about a fixture instead of about the product.
 *
 * So there is ONE tenant shape here — an ENTERPRISE Organization with an
 * owner, a non-privileged member, and a second Organization owned by an
 * outsider — and every journey borrows it. The second Organization is not
 * decoration: it is the only way "the write landed on THIS tenant" can be
 * distinguished from "a write happened somewhere".
 *
 * WHAT IS SEEDED VERSUS WHAT IS DRIVEN
 * ---------------------------------------------------------------------------
 * Accounts are registered through the real HTTP route (`createAccount` in
 * `_harness.ts`). Commercial provisioning — the Organization row, the
 * ORGANIZATION workspace, the ENTERPRISE entitlement grants — is written with
 * raw SQL, because enterprise provisioning is Point 4's subject and driving it
 * again here would prove nothing about a governance form. Everything that is
 * under test is driven through Chromium against the running product.
 *
 * The one deliberate exception is `seedDelegatedTier`. Three governance routes
 * require a CROSS-CUTTING delegated tier (SECURITY_OFFICER / COMPLIANCE_
 * OFFICER) which — unlike the org-chain tiers — the workspace owner does NOT
 * implicitly hold (`delegated-admin.service.ts`, the `ownerImpliedTiers`
 * ladder). That grant is the PRECONDITION of those capabilities, not one of
 * them, so it is seeded. Issuing a grant is separately a capability of its
 * own and IS driven through the browser.
 *
 * WHAT "PROVEN" MEANS HERE
 * ---------------------------------------------------------------------------
 * `proveMutationCapability` is the single driver every capability runs
 * through. It refuses to accept a DOM assertion as evidence: a capability
 * passes only when Chromium was observed issuing one request, with the right
 * method, to the right path, on the API origin, and the row it claims to have
 * created is readable with raw SQL on the right tenant and absent on the
 * other. The reason it is one driver rather than twenty-four hand-written
 * sequences is that the dishonest version of this suite is the one where
 * capability seventeen quietly checks less than capability one.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, type Locator, type Page, type Request } from "@playwright/test";

import {
  API_BASE,
  WEB_BASE,
  type BrowserAccount,
  countRows,
  createAccount,
  directApiCall,
  sql,
  waitForStepUpCode,
} from "./_harness";

// ===========================================================================
// The tenant shape
// ===========================================================================

/**
 * The ENTERPRISE feature grants an Organization on an ENTERPRISE contract
 * would hold.
 *
 * Copied from `PLAN_LINE_ENTITLEMENTS.ENTERPRISE` in
 * `services/api/src/services/packaging/entitlement.service.ts` — deliberately
 * the full set rather than only the keys a given journey needs, because a
 * fixture that grants exactly the entitlement under test cannot tell an
 * entitlement gate that works from one that was never reached.
 *
 * `resolveEntitlement` reads `entitlement_grants` and falls back to
 * `DEFAULT_ENTITLEMENTS` (every FEATURE_* default is `false`) — there is no
 * plan-matrix fallback at read time. Without these rows an ENTERPRISE
 * workspace is indistinguishable from a free one at the entitlement layer.
 */
export const ENTERPRISE_FEATURE_KEYS: ReadonlyArray<string> = [
  "FEATURE_REVIEWER_WORKSPACE",
  "FEATURE_TRUST_CENTER",
  "FEATURE_REDACTION",
  "FEATURE_EXTERNAL_PORTAL",
  "FEATURE_INTELLIGENCE",
  "FEATURE_GOVERNANCE_PLATFORM",
  "FEATURE_EVIDENCE_EXCHANGE",
  "FEATURE_WEBHOOKS",
  "FEATURE_CHAIN_TRANSFER",
  "FEATURE_LEGAL_HOLD",
  "FEATURE_ARCHIVE_TIERS",
  "FEATURE_DESTRUCTION_GOVERNANCE",
  "FEATURE_LIFECYCLE_DASHBOARD",
  "FEATURE_DELEGATED_ADMIN",
  "FEATURE_DEPARTMENT_ISOLATION",
  "FEATURE_CROSS_ORG_REVIEW",
];

export type UiTenant = {
  organizationId: string;
  workspaceId: string;
  /** The workspace slug used in URLs and assertions. */
  workspaceName: string;
};

export type UiEnterpriseFixture = {
  /** Workspace owner: `teams.owner_user_id`, therefore implicit ORG_ADMIN. */
  owner: BrowserAccount;
  /** ACTIVE member with the MEMBER TeamRole — holds no write capability. */
  member: BrowserAccount;
  /** Owner of a SEPARATE Organization. Never a member of `tenant`. */
  outsider: BrowserAccount;
  tenant: UiTenant;
  /** The outsider's Organization — the "other tenant" in every leak check. */
  otherTenant: UiTenant;
};

let fixtureCounter = 0;

/**
 * Provision one Organization with one ORGANIZATION workspace and put `ownerId`
 * in it as OWNER.
 *
 * Mirrors the shape `provisionOrganization` establishes in
 * `plan-journeys.spec.ts` — same tables, same enums — so the two suites cannot
 * disagree about what an enterprise tenant is.
 */
async function provisionTenant(input: {
  label: string;
  ownerUserId: string;
  memberUserId?: string;
}): Promise<UiTenant> {
  fixtureCounter += 1;
  const name = `p7-ui-${input.label}-${Date.now().toString(36)}-${fixtureCounter}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, input.ownerUserId],
    )
  )[0]!;
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
    [org.id, input.ownerUserId],
  );
  const workspaceName = `${name}-ws`;
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [workspaceName, input.ownerUserId, org.id],
    )
  )[0]!;
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, input.ownerUserId],
  );
  await sql(
    `INSERT INTO organization_security_policies (organization_id, team_id, no_personal_space, updated_at)
     VALUES ($1, $2, false, NOW())`,
    [org.id, ws.id],
  );
  await sql(
    `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
     VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
    [org.id],
  );
  for (const key of ENTERPRISE_FEATURE_KEYS) {
    await sql(
      `INSERT INTO entitlement_grants (team_id, key, kind, value_bool, source, product_line, granted_at_utc)
       VALUES ($1, $2, 'FEATURE', true, 'PLAN', 'ENTERPRISE', NOW())
       ON CONFLICT (team_id, key) DO NOTHING`,
      [ws.id, key],
    );
  }
  if (input.memberUserId) {
    await sql(
      `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
       VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
      [org.id, input.memberUserId],
    );
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
      [ws.id, input.memberUserId],
    );
  }
  return { organizationId: org.id, workspaceId: ws.id, workspaceName };
}

/**
 * The whole tenant shape every journey borrows.
 *
 * `platformAdminOwner` exists for exactly one surface. The automation console
 * (`/operations/automation`) is registered with
 * `requiredActiveSpace: "PLATFORM_ADMIN"` (`routeRegistry.ts`, id
 * `platform.automation`), so `resolveRouteAccess` short-circuits to
 * `PLATFORM_ADMIN_ONLY` for everybody else — while the AUTOMATION_MANAGE
 * capability the page's controls read is granted only at TEAM scope to an
 * OWNER/ADMIN. The single actor who satisfies both is a platform admin who
 * also owns a non-personal workspace, and that is what this flag builds. It
 * is a faithful reproduction of the product's own gate, not a bypass: the
 * server-side permission (`integration.webhook.manage`) is still resolved from
 * the workspace role, and platform admins are explicitly denied a bypass there.
 */
export async function buildEnterpriseFixture(input: {
  label: string;
  platformAdminOwner?: boolean;
}): Promise<UiEnterpriseFixture> {
  const owner = await createAccount({ label: `${input.label}-owner`, plan: "ENTERPRISE" });
  const member = await createAccount({ label: `${input.label}-member`, plan: "FREE" });
  const outsider = await createAccount({ label: `${input.label}-outsider`, plan: "ENTERPRISE" });

  const tenant = await provisionTenant({
    label: input.label,
    ownerUserId: owner.userId,
    memberUserId: member.userId,
  });
  const otherTenant = await provisionTenant({
    label: `${input.label}-other`,
    ownerUserId: outsider.userId,
  });

  if (input.platformAdminOwner) {
    await sql(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [owner.userId]);
  }

  // Restore both actors INTO the organization workspace, the way the product
  // restores the workspace a user last worked in. Without this the session
  // bootstraps into a personal space and every ORGANIZATION_ONLY route gate
  // answers NEEDS_ORGANIZATION before the surface under test is ever reached.
  await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = ANY($2::uuid[])`, [
    tenant.workspaceId,
    [owner.userId, member.userId],
  ]);
  await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
    otherTenant.workspaceId,
    outsider.userId,
  ]);

  return { owner, member, outsider, tenant, otherTenant };
}

/**
 * Issue a delegated-admin grant directly.
 *
 * PRECONDITION SEEDING, NOT BEHAVIOUR. The cross-cutting tiers are the ones
 * `hasDelegatedTier` will only honour from an explicit ACTIVE row — the
 * implicit workspace-owner ladder covers ORG_ADMIN / DEPARTMENT_ADMIN /
 * WORKSPACE_ADMIN and stops there. Policy authoring and access-review
 * campaigns need SECURITY_OFFICER or COMPLIANCE_OFFICER, so the row is
 * written here and the FORM is what gets tested.
 */
export async function seedDelegatedTier(input: {
  tenant: UiTenant;
  granteeUserId: string;
  grantedByUserId: string;
  tier:
    | "GLOBAL_ADMIN"
    | "ORG_ADMIN"
    | "DEPARTMENT_ADMIN"
    | "WORKSPACE_ADMIN"
    | "REVIEWER_LEAD"
    | "SECURITY_OFFICER"
    | "COMPLIANCE_OFFICER";
}): Promise<string> {
  const rows = await sql<{ id: string }>(
    // `granted_to_user_id` is the physical column; the Prisma field is
    // `granteeUserId` (`schema.prisma` DelegatedAdminGrant, @map). Raw SQL
    // must use the column, and the rename is exactly the kind of drift a
    // Prisma-mediated read-back would have hidden.
    `INSERT INTO delegated_admin_grants
       (team_id, organization_id, granted_to_user_id, tier, state, granted_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, NOW())
     RETURNING id`,
    [
      input.tenant.workspaceId,
      input.tenant.organizationId,
      input.granteeUserId,
      input.tier,
      input.grantedByUserId,
    ],
  );
  return rows[0]!.id;
}

/**
 * Create an evidence record inside a specific workspace, through the real
 * route, from inside the authenticated page.
 *
 * Used as the SUBJECT of the destruction-review, public-verify and video
 * capabilities. Created through the API rather than with an INSERT because the
 * lifecycle state, the custody chain head and the workspace binding are things
 * the write path computes, and a hand-written row would be a plausible-looking
 * record that no product code ever produced.
 */
export async function seedEvidence(
  page: Page,
  input: { teamId: string; title: string; type?: string },
): Promise<string> {
  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/evidence",
    body: { title: input.title, type: input.type ?? "PHOTO", teamId: input.teamId },
  });
  expect(res.status, `seedEvidence failed: ${res.body}`).toBeLessThan(300);
  const id = (JSON.parse(res.body) as { id?: string }).id;
  expect(id, `seedEvidence returned no id: ${res.body}`).toBeTruthy();
  return id!;
}

/** Register a capture device so the revoke control has something to act on. */
export async function seedCaptureDevice(input: {
  teamId: string;
  ownerUserId: string;
  label: string;
}): Promise<string> {
  const suffix = Math.random().toString(16).slice(2, 10);
  const rows = await sql<{ id: string }>(
    `INSERT INTO devices
       (team_id, owner_user_id, label, public_key_hex, public_key_fingerprint,
        attestation_provider, signature_algorithm, registered_at_utc, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'NONE', 'ED25519', NOW(), NOW())
     RETURNING id`,
    [
      input.teamId,
      input.ownerUserId,
      input.label,
      `p7uikey${suffix}`,
      `p7uifp${suffix}`,
    ],
  );
  return rows[0]!.id;
}

// ===========================================================================
// Workspace-shaped preconditions (Phase 13 §B2 — capabilities 7–13)
// ===========================================================================

/**
 * An OWNED workspace: a self-service workspace whose owner is a person, not
 * an Organization.
 *
 * WHY THIS IS SEEDED RATHER THAN DRIVEN. Four of the workspace capabilities
 * — closure request, closure cancellation, reopen, ownership transfer —
 * REFUSE an ORGANIZATION workspace by design (`workspace-lifecycle.service.ts`
 * answers `ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED` / the closure preflight
 * treats the org as the governing party), and they equally refuse a Personal
 * Space. They can only be exercised against the OWNED kind. Creating one IS
 * capability 7 and is driven through the browser there; everywhere else the
 * owned workspace is the SUBJECT of the capability, not the capability, so it
 * is written directly.
 *
 * The shape mirrors what `POST /v1/teams` actually produces
 * (`teams.routes.ts:469-506`): a SYSTEM-kind container Organization — never a
 * CUSTOMER one, because a CUSTOMER parent is exactly what the owned-workspace
 * classifier excludes — an ORG_OWNER membership for the owner, a
 * `workspaceKind: "OWNED"` Team, and an OWNER TeamMember row. A drift between
 * this and the route is therefore a drift the route's own tests would catch.
 */
export async function seedOwnedWorkspace(input: {
  label: string;
  ownerUserId: string;
  /** Added as an ACTIVE MEMBER — the only shape an ownership transfer may target. */
  memberUserId?: string;
}): Promise<{ workspaceId: string; organizationId: string; name: string }> {
  fixtureCounter += 1;
  const name = `p7-ui-owned-${input.label}-${Date.now().toString(36)}-${fixtureCounter}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'SYSTEM'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, input.ownerUserId],
    )
  )[0]!;
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
    [org.id, input.ownerUserId],
  );
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'OWNED'::"WorkspaceKind",
               'PRO'::"PlanType", 'INACTIVE', NOW())
       RETURNING id`,
      [name, input.ownerUserId, org.id],
    )
  )[0]!;
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, input.ownerUserId],
  );
  if (input.memberUserId) {
    await sql(
      `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
       VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
      [org.id, input.memberUserId],
    );
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
      [ws.id, input.memberUserId],
    );
  }
  return { workspaceId: ws.id, organizationId: org.id, name };
}

/**
 * A SECOND ORGANIZATION workspace inside an existing tenant.
 *
 * The org-level suspend / resume capabilities need a workspace that is NOT
 * the one the operator's own session is parked in: suspension clears
 * `users.current_workspace_id` for every member of the suspended workspace
 * (`workspace-lifecycle.service.ts:343-346`), so suspending the session's own
 * workspace would eject the operator mid-journey and the surface under test
 * would be replaced by a context-recovery path. Seeding a sibling workspace
 * with exactly one ACTIVE member makes `membersSuspended` a number the test
 * can predict and leaves the driver's session untouched.
 */
export async function seedOrganizationWorkspace(input: {
  tenant: UiTenant;
  label: string;
  ownerUserId: string;
  /** The one ACTIVE member whose row suspension will move. */
  memberUserId: string;
}): Promise<{ workspaceId: string; name: string }> {
  fixtureCounter += 1;
  const name = `p7-ui-orgws-${input.label}-${Date.now().toString(36)}-${fixtureCounter}`;
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [name, input.ownerUserId, input.tenant.organizationId],
    )
  )[0]!;
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, input.memberUserId],
  );
  return { workspaceId: ws.id, name };
}

/**
 * A closure request row in a chosen state.
 *
 * PRECONDITION SEEDING FOR TWO CAPABILITIES THAT CANNOT CREATE THEIR OWN
 * SUBJECT.
 *
 *   - Cancellation acts on an OPEN request. The request leg is itself a
 *     capability and IS driven through the browser; what it cannot do is
 *     produce a second open request on a second workspace, which the
 *     error-path pass needs (a workspace may hold at most one open request —
 *     `closure_request_active`).
 *   - Reopen requires a COMPLETED request, and COMPLETED is written ONLY by
 *     the closure worker's execution pass. Waiting for a cron in a browser
 *     test would be waiting for a scheduler, not for the product; the row is
 *     the state the worker leaves behind and the CONTROL is what is tested.
 */
export async function seedWorkspaceClosureRequest(input: {
  teamId: string;
  requestedByUserId: string;
  status:
    | "REQUESTED"
    | "BLOCKED"
    | "COOLING_OFF"
    | "SCHEDULED"
    | "PROCESSING"
    | "COMPLETED"
    | "CANCELLED"
    | "FAILED";
}): Promise<string> {
  const terminal = input.status === "COMPLETED";
  const rows = await sql<{ id: string }>(
    `INSERT INTO workspace_closure_requests
       (team_id, requested_by_user_id, status, requested_at_utc,
        cooling_off_ends_at_utc, completed_at_utc, updated_at)
     VALUES ($1, $2, $3, NOW(),
             CASE WHEN $4::boolean THEN NULL ELSE NOW() + INTERVAL '7 days' END,
             CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
             NOW())
     RETURNING id`,
    [input.teamId, input.requestedByUserId, input.status, terminal],
  );
  return rows[0]!.id;
}

/** The latest closure request for a workspace, or null. */
export async function latestClosureRequest(
  teamId: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await sql<{ id: string; status: string }>(
    `SELECT id, status FROM workspace_closure_requests
      WHERE team_id = $1 ORDER BY requested_at_utc DESC LIMIT 1`,
    [teamId],
  );
  return rows[0] ?? null;
}

// ===========================================================================
// The browser-side probe
// ===========================================================================

export type UiProbe = {
  /** Every request Chromium issued, in order. */
  all: Request[];
  /** `console.error`-level messages, in order. */
  consoleErrors: string[];
  /** Uncaught exceptions that reached the page. */
  pageErrors: string[];
  /** Requests matching a method + path fragment, on the API origin only. */
  apiMutations(method: string, pathFragment: string): Request[];
  /** Requests issued to the WEB origin for a `/v1/*` path — always a defect. */
  wrongOriginV1(): Request[];
  /** CSP violations the document reported, read out of the page. */
  cspViolations(): Promise<string[]>;
  /** A marker the caller can use to scope later assertions to "since now". */
  mark(): number;
};

/**
 * Attach the recorder.
 *
 * Must be called BEFORE `login`, because the CSP listener is installed with
 * `addInitScript` and only applies to documents created afterwards — and the
 * login navigation is the first document of the session.
 *
 * The `securitypolicyviolation` listener is the point of this: a nonce-based
 * CSP that silently blocks the page's own scripts produces a page that looks
 * static rather than a page that errors, and the previous corrective pass
 * shipped exactly that defect to production. Reading the event out of the
 * document is the only way a browser test can see it.
 */
export async function attachUiProbe(page: Page): Promise<UiProbe> {
  const all: Request[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  await page.addInitScript(() => {
    const w = window as unknown as { __P7_CSP__?: string[] };
    w.__P7_CSP__ = w.__P7_CSP__ ?? [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const e = event as SecurityPolicyViolationEvent;
      /**
       * PHASE 13 (NEW-060) — record WHERE the violation came from.
       *
       * The first real run reported `script-src blocked eval` on several
       * pages and the record could not be acted on, because "something in this
       * document called eval" does not say WHAT. The production bundle
       * contains no `eval(` or `new Function(` call at all — only Sentry's
       * stack-trace parser, which merely mentions the word in string literals
       * — so the report was as consistent with harness instrumentation as with
       * product code, and an assertion nobody can attribute is an assertion
       * nobody can fix.
       *
       * `sourceFile`, `lineNumber` and `sample` are exactly what tells the two
       * apart. They are part of the event and were simply being thrown away.
       */
      w.__P7_CSP__!.push(
        `${e.violatedDirective} blocked ${e.blockedURI} (${e.documentURI})` +
          ` [source=${e.sourceFile ?? "<none>"}:${e.lineNumber ?? 0}:${e.columnNumber ?? 0}` +
          ` sample=${JSON.stringify(e.sample ?? "")}]`,
      );
    });
  });

  page.on("request", (r) => all.push(r));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  return {
    all,
    consoleErrors,
    pageErrors,
    mark: () => all.length,
    apiMutations: (method, pathFragment) =>
      all.filter(
        (r) =>
          r.url().startsWith(API_BASE) &&
          r.method().toUpperCase() === method.toUpperCase() &&
          r.url().includes(pathFragment),
      ),
    wrongOriginV1: () =>
      all.filter((r) => r.url().startsWith(`${WEB_BASE}/v1/`)),
    cspViolations: async () =>
      page.evaluate(
        () => (window as unknown as { __P7_CSP__?: string[] }).__P7_CSP__ ?? [],
      ),
  };
}

// ===========================================================================
// Timing and fault injection
// ===========================================================================

/**
 * Hold a REAL response in flight for `ms`.
 *
 * The response is the server's — only its delivery is delayed. That is the
 * whole mechanism behind the double-submit and stale-response assertions: a
 * control that disables itself while a request is outstanding can only be
 * observed doing so if there IS an observable window in which it is
 * outstanding, and against a loopback stack that window is otherwise a
 * millisecond wide.
 *
 * Registered after `blockThirdParties`, so Playwright's last-registered-wins
 * ordering puts this handler first; anything it does not match falls back to
 * the outbound guard rather than escaping it.
 */
export async function holdApiResponse(
  page: Page,
  input: { method: string; pathFragment: string; ms: number },
): Promise<() => Promise<void>> {
  const pattern = `${API_BASE}/**`;
  await page.route(pattern, async (route) => {
    const req = route.request();
    if (
      req.method().toUpperCase() !== input.method.toUpperCase() ||
      !req.url().includes(input.pathFragment)
    ) {
      return route.fallback();
    }
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, input.ms));
    await route.fulfill({ response });
  });
  return async () => {
    await page.unroute(pattern);
  };
}

/**
 * A marker string that MUST NOT reach the DOM.
 *
 * Injected as the `message` of a synthetic 500 so "the surface rendered
 * bounded copy" is a checkable claim rather than a reading of the copy. If the
 * component passes the backend message through, this token appears on screen.
 */
export const POISON_MARKER = "P7-RAW-BACKEND-DETAIL-MUST-NOT-RENDER";

/** Answer the next matching request with a 500 carrying `POISON_MARKER`. */
export async function failApiResponse(
  page: Page,
  input: { method: string; pathFragment: string },
): Promise<() => Promise<void>> {
  const pattern = `${API_BASE}/**`;
  await page.route(pattern, async (route) => {
    const req = route.request();
    if (
      req.method().toUpperCase() !== input.method.toUpperCase() ||
      !req.url().includes(input.pathFragment)
    ) {
      return route.fallback();
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal_error", message: POISON_MARKER },
        message: POISON_MARKER,
      }),
    });
  });
  return async () => {
    await page.unroute(pattern);
  };
}

/** Switch the browser session's active workspace through the real route. */
export async function switchWorkspace(page: Page, workspaceId: string): Promise<void> {
  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/platform/context/switch-workspace",
    body: { workspaceId },
  });
  expect(res.status, `switch-workspace failed: ${res.body}`).toBeLessThan(300);
}

// ===========================================================================
// Step-up
// ===========================================================================

/**
 * Answer the shared "Verify it's you" panel with the account's own password.
 *
 * Shaped to be handed straight to `proveMutationCapability`'s `resolveStepUp`.
 *
 * WHY A PASSWORD AND NOT A TOTP CODE. `StepUpVerify` decides what to ask for
 * from the `methods` array the SERVER sent with its 401
 * (`PersonalSecuritySections.tsx:542-543`): when "password" is offered it
 * renders the password field and ignores "mfa" entirely. The accounts these
 * journeys use are password accounts, so the panel a real operator sees here
 * is the password one — asking for a TOTP code would be answering a panel the
 * product never rendered. `_step-up-fixtures.ts` covers the mfa-only shape,
 * and `dropPasswordCredential` is how that shape is constructed; neither is
 * what these capabilities put on screen.
 *
 * The wait matters: the panel only exists after the first attempt has been
 * REFUSED, and that refusal is deliberately held in flight by
 * `holdApiResponse` so the in-flight window is observable. Filling the field
 * without waiting would race the challenge rather than answer it.
 */
export function stepUpWithPassword(
  page: Page,
  password: string,
): () => Promise<void> {
  return async () => {
    const panel = page.locator("[data-cc-step-up-verify]").first();
    await expect(
      panel,
      "the server must challenge this mutation with a step-up prompt",
    ).toBeVisible({ timeout: 30_000 });
    const field = panel.locator("[data-cc-step-up-input]");
    await expect(
      field,
      "the step-up panel must offer a proof field — a 'reauth'-only panel " +
        "cannot be answered in place, which would mean the server did not " +
        "advertise the password method for this account",
    ).toBeVisible({ timeout: 15_000 });
    await field.fill(password);
    await panel.locator("[data-cc-step-up-submit]").click();
  };
}

/**
 * Answer the ENTERPRISE step-up challenge — the `StepUpModal` one — by doing
 * what the operator does: type the handset, ask for a code, read the code off
 * that handset, type it back.
 *
 * Shaped to be handed straight to `proveMutationCapability`'s `resolveStepUp`.
 *
 * THIS IS A DIFFERENT GATE FROM `stepUpWithPassword`, AND THE DIFFERENCE IS
 * THE POINT
 * ---------------------------------------------------------------------------
 * The workspace-lifecycle routes call `verifyAccountStepUp`, which re-checks
 * something the account already holds — a password or an enrolled factor. The
 * sensitive-action routes call `requireStepUpForSensitiveAction`, which will
 * accept nothing but an `x-proovra-step-up-challenge-id` naming a challenge
 * that was APPROVED out of band. Neither is a stand-in for the other, and
 * neither is weakened here: the challenge is started through the product's own
 * route, approved through the product's own route, and consumed once by the
 * middleware.
 *
 * The only thing that changed to make this reachable is WHERE THE CODE COMES
 * FROM. Twilio Verify mints it on the far side of a socket the harness aborts
 * by design, so nothing local could ever read it back; the recording provider
 * mints and records it instead. That is a boundary substitution — the same one
 * the recording EMAIL provider already makes for invitation links — not a
 * behaviour substitution. Reading the `step_up_challenges` row instead would
 * prove nothing: the service never persists the code, so a database-driven
 * approval could only be manufactured by writing one, which demonstrates that
 * the gate can be written around rather than that a user can pass it.
 *
 * `recipient` must be the E.164 string the caller TYPES, because that is what
 * the recorder aliases. Give each journey its own number: the recorder returns
 * the newest `verification_start` for an alias, and the provider additionally
 * rate-limits starts per recipient per hour.
 */
export function stepUpWithRecordedCode(
  page: Page,
  recipient: string,
): () => Promise<void> {
  return async () => {
    const modal = page.locator("[data-step-up-modal]");
    await expect(
      modal,
      "a STEP_UP_REQUIRED denial must open the challenge, not a generic error",
    ).toBeVisible({ timeout: 30_000 });
    /**
     * PHASE 13 (NEW-058) — THERE IS NO HANDSET STEP ANY MORE, AND THE FIXTURE
     * MUST NOT REINTRODUCE ONE.
     *
     * This used to fill `[data-step-up-phone-input]` and click "Send code".
     * Both are gone from the product on purpose: a challenge answered on a
     * handset the CALLER named proves possession of nothing, so the destination
     * is now resolved from the account's ACTIVE, verified contact factor and
     * `StartBody` is `.strict()` with no `phone` field at all.
     *
     * Typing a destination here would therefore be the fixture asserting a
     * contract the product deliberately no longer has. The account must be
     * ENROLLED before this helper runs — see `enrolContactFactor`, which does
     * it through the product's own enrolment surface — and `recipient` is
     * still needed only because the RECORDER aliases the code by destination.
     */
    await expect
      .poll(async () => (await modal.getAttribute("data-step-up-state")) ?? "", {
        message: "the challenge must leave the sending step",
        timeout: 30_000,
      })
      .not.toBe("starting");
    const state = await modal.getAttribute("data-step-up-state");
    if (state === "enrollment_required") {
      throw new Error(
        "The step-up challenge refused with STEP_UP_ENROLLMENT_REQUIRED: this " +
          "account has no ACTIVE contact factor. The gate resolves its " +
          "destination from an enrolled factor (NEW-058), so a journey that " +
          "needs step-up must enrol first via `enrolContactFactor`. This is a " +
          "fixture ordering problem, not a product defect.",
      );
    }
    if (state !== "verifying") {
      const reason =
        ((await modal.locator("[data-step-up-failed]").textContent()) ?? "").trim();
      throw new Error(
        `The step-up challenge could not be started (state=${state}): "${reason}". ` +
          "CHECK FIRST that apps/web/components/identity-security/StepUpModal.tsx " +
          "sends NEITHER `phone` NOR a lowercase `channel`: StartBody in " +
          "services/api/src/routes/identity-security.routes.ts is `.strict()` and " +
          'declares `channel: z.enum(["SMS", "WHATSAPP"])`. Zod neither case-folds ' +
          "an enum nor tolerates an unknown key, so either mistake makes `.parse()` " +
          "reject every challenge the product starts, and NO step-up-gated action " +
          "is reachable from any surface. If that is what happened, it is a product " +
          "defect, not a fixture problem.",
      );
    }

    // The code the handset received. Read from the recorder, never from the
    // database — the database deliberately does not hold it.
    const code = await waitForStepUpCode({ recipient, timeoutMs: 20_000 });
    await modal.locator("[data-step-up-code-input]").fill(code);
    await modal.locator("[data-step-up-verify]").click();
  };
}

/**
 * PHASE 13 (NEW-058) — ENROL A CONTACT FACTOR THROUGH THE PRODUCT'S OWN
 * SURFACE.
 *
 * Every step-up-gated journey now needs an ACTIVE contact factor on the acting
 * account, and the ONLY honest way to create one is the way a user does: open
 * Settings → Security, type the destination into the one field in the product
 * that legitimately accepts one, read the code the recording provider captured,
 * and hand it back. Seeding an `mfa_factors` row directly would prove that the
 * gate can be written around, not that a user can satisfy it — the same reason
 * the step-up code is read from the recorder rather than the database.
 *
 * The panel lives at `/settings#security` and NOT in `/security-center`,
 * because the surface-tier table gates the latter at ENTERPRISE with
 * `directAccessPolicy: "notFound"`. A contact factor is account-owned, so its
 * enrolment surface has to be reachable by every account that can be asked for
 * step-up.
 *
 * Leaves the browser on the settings page; callers navigate on.
 */
export async function enrolContactFactor(
  page: Page,
  recipient: string,
): Promise<void> {
  await page.goto("/settings#security", { waitUntil: "domcontentloaded" });

  const panel = page.locator("[data-contact-factor-panel]");
  await expect(
    panel,
    "the contact-factor enrolment panel must render on /settings#security — " +
      "without it NO account can satisfy the step-up gate and every " +
      "step-up-dependent feature is unreachable (NEW-058)",
  ).toBeVisible({ timeout: 30_000 });

  await panel.locator("[data-contact-factor-destination]").fill(recipient);
  await panel.locator("[data-contact-factor-send]").click();

  // The panel either advances to the code step or it reported why it could
  // not. Naming the state here turns a send failure into a readable finding
  // instead of a timeout on the code field.
  await expect
    .poll(async () => (await panel.getAttribute("data-contact-factor-state")) ?? "", {
      message: "enrolment must leave the destination step",
      timeout: 30_000,
    })
    .not.toBe("sending");
  const afterSend = await panel.getAttribute("data-contact-factor-state");
  if (afterSend !== "otp_sent") {
    throw new Error(
      `Contact-factor enrolment did not send a code (state=${afterSend}). ` +
        "`already_enrolled` means this account already holds a factor for that " +
        "destination; `provider_unavailable` means the recording messaging " +
        "provider was not wired into the API process; `rate_limited` means the " +
        "account exceeded 5 enrolment starts in an hour — give each journey its " +
        "own handset via `uniqueHandset()`.",
    );
  }

  // The code the handset received, from the recorder — the database
  // deliberately never holds it.
  const code = await waitForStepUpCode({ recipient, timeoutMs: 20_000 });
  await panel.locator("[data-contact-factor-code]").fill(code);
  await panel.locator("[data-contact-factor-verify]").click();

  await expect(
    panel,
    "a verified code must leave the account with an ACTIVE factor",
  ).toHaveAttribute("data-contact-factor-state", /enrolled|replacement_complete/, {
    timeout: 30_000,
  });
}

/**
 * A handset number unique to one journey.
 *
 * E.164 with eleven digits, which is what `normaliseToE164` accepts and what
 * the recorder therefore aliases. Unique per call because the provider
 * rate-limits verification starts per recipient per hour, and because the
 * recorder answers with the NEWEST code for an alias — two journeys sharing a
 * number would be two journeys reading each other's mail.
 */
let handsetCounter = 0;

export function uniqueHandset(): string {
  handsetCounter += 1;
  const suffix = String((Date.now() + handsetCounter * 7919) % 10_000).padStart(4, "0");
  return `+1415551${suffix}`;
}

// ===========================================================================
// The capability ledger
// ===========================================================================

export const UI_CAPABILITY_LEDGER = ".p7tmp/ui-capability-ledger.jsonl";

export type UiCapabilityRecord = {
  capabilityId: string;
  /** The route the control lives on. */
  pageUrl: string;
  /** Selector or accessible label of the control that was activated. */
  control: string;
  method: string;
  /** Canonical route template, e.g. `POST /v1/governance/policies`. */
  apiPath: string;
  /** Whether Chromium was OBSERVED issuing the request. */
  requestObserved: boolean;
  responseStatus: number | null;
  /** Workspace the session was operating in when the request was issued. */
  tenantWorkspaceId: string;
  /** What the surface showed afterwards, read from its aria-live region. */
  resultingUiState: string;
  dimension:
    | "authorized_positive"
    | "permission_denied"
    | "error_state"
    | "stale_context";
};

/**
 * Append one observation.
 *
 * The outcome scalars the closure gate reports (`BrowserVerifiedUiCapabilities`,
 * `DisconnectedVisibleUiActions`, `WrongOriginUiRequests`, `CrossTenantUiLeaks`)
 * are derived from this file, so a capability that renders a control and never
 * emits a request is recorded with `requestObserved: false` rather than simply
 * failing an assertion and leaving no trace.
 */
export function recordUiCapability(record: UiCapabilityRecord): void {
  const file = resolve(process.cwd(), UI_CAPABILITY_LEDGER);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({ ...record, atUtc: new Date().toISOString() })}\n`,
    "utf8",
  );
}

// ===========================================================================
// The driver
// ===========================================================================

export type CapabilityDescriptor = {
  capabilityId: string;
  /** Route the surface lives on, for the ledger. */
  pageUrl: string;
  /** Selector or label of the control, for the ledger. */
  control: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** Canonical template, for the ledger. */
  apiPath: string;
  /** Substring used to correlate an observed request with this capability. */
  pathFragment: string;
  /** Workspace the session is operating in. */
  tenantWorkspaceId: string;
};

export type CapabilityProbeInput = {
  page: Page;
  probe: UiProbe;
  descriptor: CapabilityDescriptor;
  /** Navigate to the surface and reveal the control. Idempotent. */
  open: () => Promise<void>;
  /** Fill the form so that a submit WOULD succeed. Called before each attempt. */
  arm: () => Promise<void>;
  /**
   * Click through to the mutation. When `double` is true the FINAL control is
   * activated twice in immediate succession — the double-submit probe.
   * When `keyboard` is true the final activation is a key press, not a click.
   */
  fire: (opts: { double: boolean; keyboard: boolean }) => Promise<void>;
  /** The control whose disabled/aria-busy state is asserted while in flight. */
  submitControl: () => Locator;
  /** The `role="status"` region this surface announces its outcome in. */
  statusRegion: () => Locator;
  /**
   * Where a FAILURE is announced, when that is a different region.
   *
   * Some surfaces close the form on success and report through a page-level
   * status region, while a failure keeps the form mounted and reports inside
   * it (the automation console is the example). Asserting the error against
   * the success region there would read the previous success text and pass
   * for the wrong reason. Defaults to `statusRegion`.
   */
  errorStatusRegion?: () => Locator;
  /** Durable rows on the ACTIVE tenant. */
  countHere: () => Promise<number>;
  /** Durable rows on the OTHER tenant. Must never move. */
  countThere: () => Promise<number>;
  /** Copy the surface must show on success. */
  successCopy: RegExp;
  /** Assert the list/panel reflects the new state without a manual reload. */
  expectRefreshed?: () => Promise<void>;
  /** Expected successful response status. Defaults to "anything under 300". */
  expectStatus?: number;
  /** How long to hold the response, so the in-flight window is observable. */
  holdMs?: number;
  /**
   * Step-up-gated surfaces (workspace closure, ownership transfer, public
   * verify publication) answer the FIRST attempt with `401 STEP_UP_REQUIRED`
   * and only mutate after a proof is supplied — and `apiFetch` additionally
   * retries a 401 once. On those surfaces "exactly one request" is the wrong
   * invariant and would fail against correct behaviour; the invariant that
   * survives is EXACTLY ONE SUCCESSFUL MUTATION, because a challenge is not a
   * write. Supplying this callback switches the count to successful responses
   * and gives the spec somewhere to answer the challenge.
   */
  resolveStepUp?: () => Promise<void>;
};

/**
 * Run one capability through every dimension that matters, in one browser
 * session, and record what was observed.
 *
 * The order is deliberate. The authorized positive path runs FIRST and under a
 * held response, so the single-request and disabled-while-in-flight claims are
 * made about a real in-flight window. The error path runs SECOND, because a
 * synthetic 500 legitimately produces a browser console error and would
 * otherwise poison the console assertion for the positive path — so the
 * console is asserted clean against a snapshot taken before the fault is
 * injected, and after the fault only uncaught exceptions and CSP violations
 * (neither of which a 500 can cause) are still required to be absent.
 */
export async function proveMutationCapability(
  input: CapabilityProbeInput,
): Promise<void> {
  const { page, probe, descriptor: d } = input;
  const holdMs = input.holdMs ?? 900;

  // -------------------------------------------------------------------------
  // 1. Authorized positive path
  // -------------------------------------------------------------------------
  await input.open();
  await input.arm();

  const control = input.submitControl();
  await expect(
    control,
    `${d.capabilityId}: the control must be present and enabled for an authorized caller`,
  ).toBeEnabled();

  // Keyboard reachability: the control takes focus and IS the focused element.
  await control.focus();
  await expect(
    control,
    `${d.capabilityId}: the control must be reachable and operable by keyboard`,
  ).toBeFocused();

  const beforeHere = await input.countHere();
  const beforeThere = await input.countThere();
  const consoleBaseline = probe.consoleErrors.length;
  const mutationsBefore = probe.apiMutations(d.method, d.pathFragment).length;

  // Successful mutations are counted from RESPONSES, not requests, because a
  // step-up challenge is a request that is deliberately not a write.
  let successfulMutations = 0;
  const countSuccess = (r: { url(): string; status(): number; request(): { method(): string } }) => {
    if (
      r.url().startsWith(API_BASE) &&
      r.url().includes(d.pathFragment) &&
      r.request().method().toUpperCase() === d.method &&
      r.status() < 300
    ) {
      successfulMutations += 1;
    }
  };
  page.on("response", countSuccess);

  const release = await holdApiResponse(page, {
    method: d.method,
    pathFragment: d.pathFragment,
    ms: holdMs,
  });

  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().startsWith(API_BASE) &&
      r.url().includes(d.pathFragment) &&
      r.request().method().toUpperCase() === d.method &&
      // On a step-up surface the challenge answers first; the response that
      // settles this capability is the one that is not a challenge.
      (input.resolveStepUp === undefined || r.status() !== 401),
    { timeout: 30_000 },
  );

  // Activate twice, by keyboard. A control that does not disable itself while
  // its mutation is outstanding will issue two writes here.
  await input.fire({ double: true, keyboard: true });
  if (input.resolveStepUp) await input.resolveStepUp();

  // While the held response is outstanding the control must refuse a further
  // activation — asserted directly rather than inferred from the request count.
  await expect
    .poll(
      async () => (await control.isDisabled()) || (await control.getAttribute("aria-busy")) === "true",
      {
        message: `${d.capabilityId}: the control must disable (or mark itself busy) while the mutation is in flight`,
        timeout: holdMs,
      },
    )
    .toBe(true);

  const response = await responsePromise;
  const status = response.status();
  await release();

  const observed = input.resolveStepUp
    ? successfulMutations
    : probe.apiMutations(d.method, d.pathFragment).length - mutationsBefore;
  page.off("response", countSuccess);
  expect(
    observed,
    `${d.capabilityId}: a double activation must produce EXACTLY ONE ${d.method} ${d.apiPath} ` +
      `${input.resolveStepUp ? "successful mutation" : "request"} — observed ${observed}`,
  ).toBe(1);

  if (input.expectStatus !== undefined) {
    expect(status, `${d.capabilityId}: unexpected response status`).toBe(
      input.expectStatus,
    );
  } else {
    expect(
      status,
      `${d.capabilityId}: the authorized path must succeed, got ${status}`,
    ).toBeLessThan(300);
  }

  // The request went to the API origin, carrying the browser's own session.
  const issued = probe.apiMutations(d.method, d.pathFragment).at(-1)!;
  expect(
    issued.url().startsWith(API_BASE),
    `${d.capabilityId}: the mutation must address the API origin, not the web origin`,
  ).toBe(true);

  // Durable effect, on THIS tenant only.
  await expect
    .poll(async () => await input.countHere(), {
      message: `${d.capabilityId}: the durable row must exist on the active tenant`,
      timeout: 10_000,
    })
    .toBe(beforeHere + 1);
  expect(
    await input.countThere(),
    `${d.capabilityId}: CROSS-TENANT LEAK — the write reached the other tenant`,
  ).toBe(beforeThere);

  // Screen-reader announcement, from the surface's own live region.
  const statusRegion = input.statusRegion();
  await expect(
    statusRegion,
    `${d.capabilityId}: the outcome must be announced in a live region`,
  ).toHaveAttribute("aria-live", /polite|assertive/);
  await expect(
    statusRegion,
    `${d.capabilityId}: the outcome must be announced with role=status`,
  ).toHaveAttribute("role", "status");
  await expect(
    statusRegion,
    `${d.capabilityId}: the success outcome must be announced`,
  ).toContainText(input.successCopy, { timeout: 15_000 });

  const announced = ((await statusRegion.textContent()) ?? "").trim();

  // Cache invalidation — the surface reflects the new state without a reload.
  if (input.expectRefreshed) await input.expectRefreshed();

  // Boundary assertions for the clean path.
  /**
   * PHASE 13 (HARNESS CORRECTION) — A STEP-UP CHALLENGE IS A 401 BY DESIGN.
   *
   * On a step-up-gated surface the server ANSWERS THE FIRST ATTEMPT with
   * `401 STEP_UP_REQUIRED` and only mutates once a proof is supplied — which is
   * why `resolveStepUp` exists and why the request-count invariant above already
   * switches to counting SUCCESSFUL mutations. Chromium logs a console error for
   * any 401 resource load, so on those capabilities this assertion was demanding
   * that correct product behaviour leave no trace, and it could never pass.
   *
   * The allowance is deliberately not a blanket ignore. It is narrowed three
   * ways: only on capabilities that declared `resolveStepUp`; only lines that are
   * a 401 resource load; and the challenge must actually have HAPPENED — a
   * step-up-gated capability that produced no 401 at all means the gate was not
   * exercised, which is a stronger check than the original made. Every other
   * console error still fails, including a 404 (that is how NEW-071's dangling
   * asset reference was found).
   */
  const consoleSinceFire = probe.consoleErrors.slice(consoleBaseline);
  const is401ResourceLoad = (line: string) =>
    /Failed to load resource: the server responded with a status of 401\b/.test(
      line,
    );
  if (input.resolveStepUp) {
    expect(
      consoleSinceFire.filter(is401ResourceLoad).length,
      `${d.capabilityId}: a step-up-gated capability must be CHALLENGED — no 401 ` +
        "was observed, so the step-up gate was never exercised",
    ).toBeGreaterThan(0);
  }
  expect(
    input.resolveStepUp
      ? consoleSinceFire.filter((l) => !is401ResourceLoad(l))
      : consoleSinceFire,
    `${d.capabilityId}: the authorized path must produce no console errors`,
  ).toEqual([]);
  expect(
    probe.pageErrors,
    `${d.capabilityId}: the authorized path must produce no uncaught exceptions`,
  ).toEqual([]);
  expect(
    await probe.cspViolations(),
    `${d.capabilityId}: the surface must produce no CSP violations`,
  ).toEqual([]);
  expect(
    probe.wrongOriginV1().map((r) => r.url()),
    `${d.capabilityId}: no /v1/* request may be issued to the WEB origin`,
  ).toEqual([]);

  recordUiCapability({
    capabilityId: d.capabilityId,
    pageUrl: d.pageUrl,
    control: d.control,
    method: d.method,
    apiPath: d.apiPath,
    requestObserved: true,
    responseStatus: status,
    tenantWorkspaceId: d.tenantWorkspaceId,
    resultingUiState: announced,
    dimension: "authorized_positive",
  });

  // -------------------------------------------------------------------------
  // 2. Error state — a server failure renders bounded copy, writes nothing
  // -------------------------------------------------------------------------
  const settledHere = await input.countHere();
  await input.open();
  await input.arm();
  const errorRegion = input.errorStatusRegion ?? input.statusRegion;
  const restore = await failApiResponse(page, {
    method: d.method,
    pathFragment: d.pathFragment,
  });
  try {
    await input.fire({ double: false, keyboard: false });
    await expect(
      errorRegion(),
      `${d.capabilityId}: a server failure must be reported to the operator`,
    ).not.toHaveText("", { timeout: 20_000 });
    const errorText = ((await errorRegion().textContent()) ?? "").trim();
    expect(
      errorText,
      `${d.capabilityId}: the raw backend message must never be rendered`,
    ).not.toContain(POISON_MARKER);
    expect(
      await page.locator("body").innerText(),
      `${d.capabilityId}: the raw backend message must not appear anywhere on the page`,
    ).not.toContain(POISON_MARKER);
    expect(
      await input.countHere(),
      `${d.capabilityId}: a failed mutation must not leave a durable row`,
    ).toBe(settledHere);

    recordUiCapability({
      capabilityId: d.capabilityId,
      pageUrl: d.pageUrl,
      control: d.control,
      method: d.method,
      apiPath: d.apiPath,
      requestObserved: true,
      responseStatus: 500,
      tenantWorkspaceId: d.tenantWorkspaceId,
      resultingUiState: errorText,
      dimension: "error_state",
    });
  } finally {
    await restore();
  }

  // A synthetic 500 is a network-level console error by construction, so the
  // console is not re-asserted here. What a 500 CANNOT cause is an uncaught
  // exception or a CSP violation, and both are still required to be absent.
  expect(
    probe.pageErrors,
    `${d.capabilityId}: a server failure must not become an uncaught exception`,
  ).toEqual([]);
  expect(
    await probe.cspViolations(),
    `${d.capabilityId}: the error surface must produce no CSP violations`,
  ).toEqual([]);
}

/**
 * Prove the SERVER refuses a caller who lacks the right, from inside that
 * caller's own authenticated browser session.
 *
 * A hidden button proves that the client decided not to render a button. This
 * issues the request the control would have issued, with the browser's real
 * cookie and origin, and asserts the refusal came from the server and that
 * nothing durable moved. Recorded as the capability's `permission_denied`
 * dimension.
 */
export async function proveServerRefusal(input: {
  page: Page;
  capabilityId: string;
  pageUrl: string;
  control: string;
  method: string;
  apiPath: string;
  requestPath: string;
  body?: unknown;
  tenantWorkspaceId: string;
  countRowsNow: () => Promise<number>;
}): Promise<void> {
  const before = await input.countRowsNow();
  const res = await directApiCall(input.page, {
    method: input.method,
    path: input.requestPath,
    body: input.body,
  });
  expect(
    res.status,
    `${input.capabilityId}: the SERVER must refuse an unauthorized caller (got ${res.status}: ${res.body})`,
  ).toBeGreaterThanOrEqual(400);
  expect(
    res.status,
    `${input.capabilityId}: a refusal must not be a server fault`,
  ).toBeLessThan(500);
  expect(
    await input.countRowsNow(),
    `${input.capabilityId}: a refused mutation must leave no durable row`,
  ).toBe(before);

  recordUiCapability({
    capabilityId: input.capabilityId,
    pageUrl: input.pageUrl,
    control: input.control,
    method: input.method,
    apiPath: input.apiPath,
    requestObserved: true,
    responseStatus: res.status,
    tenantWorkspaceId: input.tenantWorkspaceId,
    resultingUiState: "refused-by-server",
    dimension: "permission_denied",
  });
}

/**
 * Assert the page under test actually rendered, rather than the route gate's
 * denial panel.
 *
 * Every surface in this matrix sits behind `PageRouteGate`, and a gate that
 * denies renders a `<main data-page-route-gate>` in place of the page. Without
 * this check a suite can "pass" its DOM assertions by finding nothing and
 * asserting nothing — so the gate is checked explicitly, and its failure names
 * the reason the product gave.
 */
export async function expectSurfaceRendered(
  page: Page,
  routeId: string,
): Promise<void> {
  const gate = page.locator(`[data-page-route-gate-route-id="${routeId}"]`);
  if ((await gate.count()) > 0) {
    const state = await gate.first().getAttribute("data-page-route-gate-state");
    throw new Error(
      `PageRouteGate denied "${routeId}" with state ${state}. ` +
        "If the state is NEEDS_UPGRADE on a workspace that IS on an ENTERPRISE " +
        "contract, this is the PageRouteGate defect reported by Phase 13 Agent B: " +
        "apps/web/components/navigation/PageRouteGate.tsx:79-93 calls " +
        "resolveRouteAccess() WITHOUT isEnterpriseWorkspace / planFeatures, while " +
        "AppSidebarV2.tsx:561, tools/page.tsx:110 and CommandPalette.tsx:107 all " +
        "pass them — so every ENTERPRISE_ONLY_ROUTE_IDS route fails closed at the " +
        "page gate while remaining visible in navigation.",
    );
  }
}

/**
 * Activate a control once — by keyboard where the caller asked for it.
 *
 * Keyboard activation is `Enter` on a focused button, which is what a keyboard
 * user actually does and what the browser's own activation behaviour handles.
 * It is not a synthetic `click()` wearing a keyboard costume.
 */
export async function activateOnce(
  control: Locator,
  keyboard: boolean,
): Promise<void> {
  if (keyboard) {
    await control.focus();
    await control.press("Enter");
    return;
  }
  await control.click();
}

/**
 * Activate a control twice in immediate succession — the double-submit probe.
 *
 * The SECOND activation is best-effort. A control that has disabled itself, or
 * a confirmation dialog that has closed, cannot be activated again — and that
 * is the product preventing the second write, which is precisely the property
 * under test. Swallowing the resulting Playwright error here does not weaken
 * anything: the assertion that matters is made by the caller, and it is that
 * EXACTLY ONE request was observed. A control that stays live issues two, and
 * that count is what fails.
 */
export async function activateTwice(
  control: Locator,
  keyboard: boolean,
): Promise<void> {
  await activateOnce(control, keyboard);
  /**
   * PHASE 13 (HARNESS CORRECTION) — BEST-EFFORT MUST NOT MEAN "WAIT A SECOND".
   *
   * The docblock above already says a closed confirmation dialog "cannot be
   * activated again — and that is the product preventing the second write". The
   * code then WAITED 1000 ms for that removed element to come back, and the wait
   * was not free: the caller's very next assertion is
   *
   *   "the control must disable (or mark itself busy) while the mutation is in
   *    flight"
   *
   * polled for `holdMs` (900 ms) — the window `holdApiResponse` holds the
   * response open. On a dialog-gated capability the first activation resolves the
   * confirm, the mutation starts, the dialog unmounts, and this function then
   * burned >900 ms on a detached locator. By the time the poll began, the held
   * response had landed and the control had correctly re-enabled itself, so a
   * control that DID disable was recorded as one that never did. Exactly the two
   * dialog-gated capabilities failed that way (destruction review, capture-device
   * revoke) while every non-dialog capability passed — the harness was measuring
   * its own latency.
   *
   * Asking whether the control is still there is immediate: `isVisible` and
   * `isEnabled` do NOT auto-wait, so a removed or disabled control is skipped at
   * once and a control the product left live still receives a genuine second
   * activation. Nothing is weakened — the invariant the caller enforces is
   * EXACTLY ONE request, and a control that stays live still issues two.
   *
   * `force: true` is gone with the wait it existed to defeat: actionability is
   * now established explicitly rather than bypassed.
   */
  try {
    if (!(await control.isVisible()) || !(await control.isEnabled())) return;
    if (keyboard) {
      await control.press("Enter", { timeout: 500 });
    } else {
      await control.click({ timeout: 500 });
    }
  } catch {
    // The control refused a second activation. Recorded by the request count.
  }
}

/** Wait for a surface's own readiness attribute before touching its controls. */
export async function waitForSurface(
  page: Page,
  selector: string,
  timeoutMs = 30_000,
): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "attached", timeout: timeoutMs });
}

/** Convenience: rows on a table for one tenant, used by the count callbacks. */
export async function tenantRowCount(
  table: string,
  teamIdColumn: string,
  teamId: string,
  extraWhere = "",
  extraValues: unknown[] = [],
): Promise<number> {
  const where = extraWhere ? `${teamIdColumn} = $1 AND ${extraWhere}` : `${teamIdColumn} = $1`;
  return countRows(table, where, [teamId, ...extraValues]);
}
