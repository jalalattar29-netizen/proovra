/**
 * PHASE 13 §1 — TENANT BINDING, derived over the IMPORT-RESOLVED call graph.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The security-family pass named 481 production routes `SESSION_AUTHENTICATED`
 * — "a session was established, no tenant gate was reached". That was an honest
 * report of what the classifier could see, and NOT a claim those routes are
 * unbound. Checking one showed the opposite: `DELETE /v1/cases/:id` reaches
 * `resolveCaseDestructiveGate`, which loads `prisma.teamMember` for the case's
 * OWN `teamId` and refuses unless `teamMemberStatusGrantsAccess(member.status)`
 * — a genuine ACTIVE-membership binding, invisible for two reasons:
 *
 *   1. DEPTH — `classifyRouteAuth` walks a handler two calls deep on purpose.
 *   2. INDEX SCOPE — the canonical status predicate lives in `packages/shared`,
 *      which the route analyzer does not index.
 *
 * WHY IT USES THE RESOLVED GRAPH
 * ---------------------------------------------------------------------------
 * The first attempt raised the depth on a NAME-keyed walk and produced garbage:
 * `POST /v1/auth/google` was credited with reading `evidenceSearchDocument`,
 * because a property-access callee resolves to a bare method name that collides
 * across three trees. Those numbers were not measurements. This version follows
 * `call-graph.mjs`, which resolves each call to a declaration through the
 * file's own import table and RECORDS whatever it cannot resolve.
 *
 * TWO FACTS, KEPT APART
 * ---------------------------------------------------------------------------
 *   membershipAuthority  — a membership+status decision was reached
 *                          (authorization: "may this caller act here?")
 *   tenantScopePredicate — a query was constrained by a tenant column
 *                          (scoping: "which rows can be seen?")
 *
 * Collapsing them would let `findMany({ where: { teamId } })` masquerade as an
 * authorization check. A route that scopes but never authorises is exactly the
 * `SESSION_ONLY_TENANT_ACCESS` defect, and it is only visible while they stay
 * apart.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { buildCallGraph, traverse, ts, REPO } from "./call-graph.mjs";

// ===========================================================================
// TERMINAL TENANT MARKERS — facts about implementation, never names alone.
//
// Each is verified reachable through the resolved graph. The name is the
// lookup key; the WHY records the implementation fact that licenses it.
// ===========================================================================

export const MEMBERSHIP_AUTHORITIES = Object.freeze([
  {
    id: "teamMemberStatusGrantsAccess",
    why: "the canonical workspace membership-status predicate (packages/shared/src/identity.ts)",
  },
  { id: "authorizeOrFail", why: "the canonical authorization evaluator (ACTIVE membership + tenant + capability)" },
  { id: "authorizeWorkspaceOrFail", why: "the canonical workspace authorization evaluator" },
  { id: "authorizeCurrentWorkspaceOrFail", why: "the canonical current-workspace evaluator" },
  { id: "requireLiveAuthorizedWorkspaceContext", why: "the live authorized-workspace context primitive" },
  { id: "authorizeWithEmergencyOverlay", why: "the authorization evaluator with break-glass overlay" },
  { id: "requireDelegatedTier", why: "the delegated-admin tier authority" },
  { id: "requireDelegatedTierAny", why: "the delegated-admin tier authority" },
  { id: "resolveAccessibleWorkspace", why: "the canonical accessible-workspace resolver" },
  {
    id: "checkOrgAccess",
    why: "the canonical organization access evaluator (refuses ARCHIVED/SUSPENDED orgs, ACTIVE org membership by the shared predicate, role precedence, contract expiry)",
  },
  {
    id: "organizationMembershipGrantsAccess",
    why: "the canonical organization membership-status predicate (packages/shared)",
  },
  {
    id: "evaluateMemberAccess",
    why: "the canonical member access-policy evaluator — ACTIVE workspace membership, the permission matrix, AND the central `organization_not_active` deny for a workspace whose parent CUSTOMER organization is missing/SUSPENDED/ARCHIVED",
  },
  { id: "requirePlatformAdmin", why: "platform-admin scope (multi-tenant by design)" },
  { id: "isPlatformAdmin", why: "platform-admin scope (multi-tenant by design)" },
]);
const MEMBERSHIP_IDS = new Set(MEMBERSHIP_AUTHORITIES.map((m) => m.id));

/**
 * Prisma models whose rows BELONG to a workspace/organization.
 *
 * DERIVED FROM THE SCHEMA, not hand-listed. The previous revision carried a
 * 38-name literal set, and a hand-maintained denominator is the exact failure
 * this repository has already paid for once: a model missing from the list is
 * not "safe", it is UNMEASURED. `CaptureSession` was missing, and a route that
 * writes an unvalidated `teamId` into it therefore read as touching no tenant
 * data at all.
 *
 * The rule is mechanical: a model that declares `teamId`, `organizationId`, or
 * `workspaceId` is tenant-owned. Adding such a column to a new model puts it in
 * the denominator automatically, with no list to remember to update.
 *
 * The literal names below are kept ONLY as a floor — models this analysis
 * treated as tenant-owned before the derivation existed, so widening the
 * denominator can never silently narrow it.
 */
const DECLARED_TENANT_OWNED = Object.freeze([
  "case", "evidence", "report", "verificationPackage", "legalHold", "caseAccess",
  "caseAssignment", "caseComment", "caseEvidenceLink", "team", "teamMember",
  "teamInvitation", "organization", "organizationMembership", "organizationInvitation",
  "externalReviewGrant", "reviewAssignment", "reviewDecision", "workflowInstance",
  "workflowIntakeLink", "automationRule", "automationRun", "webhookEndpoint",
  "webhookDelivery", "retentionPolicy", "destructionReview",
  "evidenceSearchDocument", "collaborationTeam", "device", "ssoConnection",
  "apiKey", "redactionJob", "exportJob", "intakeSession", "caseRiskSnapshot",
  "discussionThread", "evidenceRequest", "evidenceLegalHold",
]);

const SCHEMA_PATH = "services/api/prisma/schema.prisma";

/** Prisma delegate name for a model: `EvidenceLegalHold` → `evidenceLegalHold`. */
const delegateName = (model) => model.charAt(0).toLowerCase() + model.slice(1);

export function deriveTenantOwnedModels() {
  const out = new Set(DECLARED_TENANT_OWNED);
  let text;
  try {
    text = readFileSync(path.join(REPO, SCHEMA_PATH), "utf8");
  } catch {
    // A missing schema must not silently shrink the denominator to the floor
    // and call it a measurement.
    throw new Error(`tenant-binding: cannot read ${SCHEMA_PATH}; the tenant denominator is unmeasurable`);
  }
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    if (/^\s*(teamId|organizationId|workspaceId)\s/m.test(body)) out.add(delegateName(name));
  }
  return Object.freeze(out);
}

export const TENANT_OWNED_MODELS = deriveTenantOwnedModels();

/**
 * ACCESSES THAT ARE NOT TENANT DATA ACCESS.
 *
 * Deriving the denominator from the schema (correctly) pulled in two models
 * that carry a `teamId` column but are never read AS tenant data:
 *
 *   - the platform audit chain reads its own last row under an advisory lock to
 *     link the next hash. That is the trail writing itself, not the caller
 *     reading tenant rows — and counting it made 27 unrelated account-self
 *     routes look tenant-unbound, which would have buried the real findings.
 *   - the operations-inbox snapshot probe selects `{ id: true }` inside a
 *     try/catch purely to discover whether the table exists on an un-migrated
 *     environment.
 *
 * Each entry is keyed by FILE + MODEL + OP, so the same model accessed from a
 * route still counts. Each records the implementation fact that licenses it.
 * This is an exclusion from the DENOMINATOR, never a grant of authority.
 */
const INFRASTRUCTURE_ACCESSES = Object.freeze([
  {
    file: "services/api/src/services/platform-audit-log.service.ts",
    model: "adminAuditLog",
    ops: "*",
    why: "the canonical platform audit trail writing and chaining its own rows — the record OF an action, not the action's tenant data",
  },
  {
    file: "services/api/src/services/security/security-event.service.ts",
    model: "securityEvent",
    ops: "*",
    why: "the canonical security-event trail — append-only record of what the actor did, stamped from the actor's own resolved context",
  },
  {
    file: "services/api/src/routes/me-inbox.routes.ts",
    model: "operationsInboxSnapshot",
    ops: new Set(["findFirst"]),
    why: "a table-existence probe selecting `{ id: true }` inside try/catch (P2021/P2022 downgrades History to unavailable)",
  },
]);

function infrastructureAccess(file, model, op) {
  return (
    INFRASTRUCTURE_ACCESSES.find(
      (i) => i.file === file && i.model === model && (i.ops === "*" || i.ops.has(op)),
    ) ?? null
  );
}

const TENANT_COLUMNS = ["teamId", "organizationId", "workspaceId"];
const SELF_COLUMNS = ["userId", "ownerUserId", "actorUserId", "createdByUserId"];

const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);

/** `prisma.case.findUnique(...)` / `tx.evidence.update(...)` → descriptor. */
export function prismaAccess(node) {
  if (!ts.isCallExpression(node)) return null;
  const exp = node.expression;
  if (!ts.isPropertyAccessExpression(exp)) return null;
  const op = exp.name.text;
  const isWrite = WRITE_OPS.has(op);
  if (!READ_OPS.has(op) && !isWrite) return null;
  const modelExpr = exp.expression;
  if (!ts.isPropertyAccessExpression(modelExpr)) return null;
  const model = modelExpr.name.text;
  const root = modelExpr.expression;
  if (!ts.isIdentifier(root)) return null;
  if (!/^(prisma|tx|db|client)$/i.test(root.text)) return null;
  return { model, op, node, kind: isWrite ? "WRITE" : "READ" };
}

/**
 * Scoping is decided by the `where` clause ONLY.
 *
 * The previous revision matched tenant and self columns anywhere in the call
 * text, which included `select`. `payment.findMany({ where: { userId }, select:
 * { …, teamId: true } })` therefore read as "carries a tenant predicate" —
 * crediting a column the caller merely ASKED FOR as though it constrained which
 * rows were reached — and the genuine `userId` self-binding was overwritten.
 * Three correctly self-scoped account routes were reported unbound because of
 * it. A projection is not a predicate.
 */
function predicatesOf(callNode) {
  const arg = callNode.arguments?.[0];
  let text = null;
  if (arg && ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      const key =
        prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
      if (key === "where" && ts.isPropertyAssignment(prop)) text = prop.initializer.getText();
    }
  }
  // No statically readable `where` (a spread, a variable, a raw call): fall back
  // to the whole call rather than silently reporting "unscoped", because an
  // unreadable predicate is an analysis gap, not a proven absence.
  if (text === null) text = callNode.getText();
  return {
    whereText: text,
    tenant: TENANT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(text)),
    self: SELF_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(text)),
  };
}

// ===========================================================================
// Handler analysis
// ===========================================================================

/**
 * Walk a handler through the RESOLVED call graph, collecting membership
 * authorities reached, Prisma models touched, and whether each tenant-owned
 * access carried a tenant or self predicate.
 */
/**
 * @param handlerNode the route handler
 * @param handlerFile the registering file (import context for resolution)
 * @param cg the resolved call graph
 * @param maxDepth traversal bound
 * @param extraRoots additional AST nodes to walk in the same context — the
 *        route's `options` object, so a tenant gate declared as a preHandler
 *        (`{ preHandler: requireCaseAccess }`) is followed too. Without this a
 *        route whose ONLY gate is a preHandler reads as unbound.
 */
export function analyzeHandlerTenancy(handlerNode, handlerFile, cg, maxDepth = 8, extraRoots = []) {
  const membership = new Map();
  const modelsRead = new Set();
  const modelsWritten = new Set();
  let tenantPredicateSites = 0;
  let selfPredicateSites = 0;
  const unscopedSites = [];
  const infrastructureSites = new Set();
  const insertSites = [];
  const scopedRowBindings = new Map();
  const tenantVerificationFiles = new Set();
  const pendingUnscoped = [];
  const tenantAccessModels = new Set();

  /**
   * INLINE membership authorities.
   *
   * The canonical predicate `teamMemberStatusGrantsAccess` is NOT how most of
   * this codebase checks membership. `requireCaseAccess`, for one, loads
   * `prisma.teamMember.findUnique({ where: { teamId_userId: … } })` and then
   * compares `membership.status === "ACTIVE"` inline. That is a real
   * ACTIVE-membership decision against a specific tenant, and treating it as
   * "no authority reached" would report a bound route as unbound — a false
   * finding, which is worse than a missing one.
   *
   * So the IMPLEMENTATION FACT is what counts: a lookup against the membership
   * table, paired with a lifecycle-status comparison. Both halves are required.
   * A membership read with no status check is exactly the STATUS_BLIND defect
   * and must NOT satisfy this.
   */
  let membershipTableSite = null;
  let statusPredicateSite = null;

  /**
   * RESOURCE-OWNER IDENTITY — the third binding idiom in this codebase.
   *
   * `GET /v1/cases/:id/team-members` loads the case and then refuses unless
   * `caseItem.ownerUserId === <the authenticated user>`; `assertOwnedTeamForCheckout`
   * throws 403 unless `team.ownerUserId === userId`; `POST /v1/evidence/:id/restore`
   * refuses unless `evidence.ownerUserId === ownerUserId`. Each is a real
   * authorization decision against the row's own owner column — strictly
   * TIGHTER than membership, since only the owner passes.
   *
   * It is invisible to both other detectors because it is a POST-LOOKUP
   * COMPARISON rather than a query predicate or a membership-table read, which
   * is why nine correctly-bound routes were reported unresolved.
   *
   * THREE facts are required together, so a mere mention of an owner column can
   * never satisfy it:
   *   1. the actor identity is bound from the session (`getAuthUserId(...)`),
   *   2. a strict === / !== compares an owner column against that binding,
   *   3. the same traversal reaches a refusal (403/404, or a thrown 403).
   * Two out of three is not an authorization decision and does not count.
   */
  const actorIdentityBindings = new Set();
  /** @type {Array<{left:string,right:string,file:string}>} */
  const ownerComparisons = [];
  let refusalSite = null;
  const refusalCodes = new Set();

  const ACTOR_IDENTITY_SOURCES = new Set([
    "getAuthUserId",
    "getAuthUserIdOrThrow",
    "requireAuthUserId",
    "resolveAuthUserId",
  ]);
  const OWNER_COLUMNS = new Set([
    "ownerUserId", "userId", "requestedByUserId", "createdByUserId",
    "actorUserId", "assignedToUserId", "uploadedByUserId",
  ]);

  /** `x`, `x.y` → the trailing name; anything else → null. */
  const tailName = (n) =>
    ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : null;

  const onNodeShared = (n, file) => {
      // (1) actor identity bound from the session.
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer
      ) {
        const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (ts.isCallExpression(init)) {
          const callee = ts.isIdentifier(init.expression)
            ? init.expression.text
            : ts.isPropertyAccessExpression(init.expression)
              ? init.expression.name.text
              : null;
          if (callee && ACTOR_IDENTITY_SOURCES.has(callee)) actorIdentityBindings.add(n.name.text);
        }
        // CONFIRMED-ROW BINDING.
        //
        // `const target = await prisma.authenticatedSession.findFirst({ where:
        // { id, userId, revokedAtUtc: null } })` proves the row belongs to the
        // caller; the `update({ where: { id: target.id } })` that follows is
        // scoped BY that proof, not unscoped. Reading the mutation's `where` in
        // isolation reported the strictest idiom in the codebase — confirm,
        // then mutate by confirmed id — as the weakest.
        const initCall = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
        const readAcc = prismaAccess(initCall);
        if (readAcc && readAcc.kind === "READ") {
          const p = predicatesOf(readAcc.node);
          if (p.tenant) scopedRowBindings.set(n.name.text, "tenant");
          else if (p.self) scopedRowBindings.set(n.name.text, "self");
        }
      }
      // A parameter literally named for the actor in a helper that receives it
      // (`assertOwnedTeamForCheckout(userId, teamId)`) is the same binding: the
      // caller's session id, passed one frame down.
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && /^(userId|actorUserId|ownerUserId)$/.test(n.name.text)) {
        actorIdentityBindings.add(n.name.text);
      }
      // (2) owner-column comparison.
      if (
        ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        const l = tailName(n.left);
        const r = tailName(n.right);
        if (l && r && ((OWNER_COLUMNS.has(l) && ts.isPropertyAccessExpression(n.left)) ||
                       (OWNER_COLUMNS.has(r) && ts.isPropertyAccessExpression(n.right)))) {
          ownerComparisons.push({ left: l, right: r, file });
        }
        // POST-READ TENANT VERIFICATION.
        //
        // `conn.team?.organizationId !== managingOrganizationId` → refuse is a
        // SCOPING decision made after the read instead of inside the `where`.
        // `resolveManagedIdentity` loads the SSO connection by the id carried in
        // the actor's own evidence and then refuses unless the connection is
        // owned by the managing Organization — the strictest possible check,
        // reported as "no tenant or self predicate" because the constraint is
        // an equality refusal rather than a query clause.
        //
        // Credited as SCOPING only. It never satisfies the membership
        // authority, so a route that verifies a tenant id but never checks
        // whether the caller belongs to it is still unresolved.
        const tl = ts.isPropertyAccessExpression(n.left) ? n.left.name.text : null;
        const tr = ts.isPropertyAccessExpression(n.right) ? n.right.name.text : null;
        if ((tl && TENANT_COLUMNS.includes(tl)) || (tr && TENANT_COLUMNS.includes(tr))) {
          tenantVerificationFiles.add(file);
        }
      }
      // (3) a refusal in the same reachable code.
      if (ts.isNumericLiteral(n) && (n.text === "403" || n.text === "404")) {
        refusalCodes.add(n.text);
        if (!refusalSite) refusalSite = file;
      }

      if (ts.isIdentifier(n) && MEMBERSHIP_IDS.has(n.text) && !membership.has(n.text)) {
        const hit = MEMBERSHIP_AUTHORITIES.find((m) => m.id === n.text);
        membership.set(n.text, `${file}: ${hit.why}`);
      }
      // Lifecycle-status comparison: `status === "ACTIVE"`, `status: "ACTIVE"`,
      // `{ in: ["ACTIVE"] }`, or a SUSPENDED/REVOKED refusal.
      if (ts.isStringLiteralLike(n) && /^(ACTIVE|SUSPENDED|REVOKED)$/.test(n.text)) {
        if (!statusPredicateSite) statusPredicateSite = file;
      }
      const acc = prismaAccess(n);
      if (!acc) return;
      (acc.kind === "WRITE" ? modelsWritten : modelsRead).add(acc.model);
      if (acc.model === "teamMember" || acc.model === "organizationMembership") {
        if (!membershipTableSite) membershipTableSite = `${file}: ${acc.model}.${acc.op}`;
      }
      if (!TENANT_OWNED_MODELS.has(acc.model)) return;
      const infra = infrastructureAccess(file, acc.model, acc.op);
      if (infra) {
        infrastructureSites.add(`${file}: ${acc.model}.${acc.op} — ${infra.why}`);
        return;
      }
      // AN INSERT IS A DIFFERENT QUESTION FROM A READ.
      //
      // `create` has no `where`: the tenant column in its `data` is a VALUE
      // being stored, not a predicate constraining which rows are reached.
      // Scoring it as "carries a tenant predicate" credited every audit- and
      // security-event emission with a tenant binding it never performed, and
      // scoring it as "unscoped" would have condemned the same emissions.
      // Neither is the truth. The honest question for an insert is PROVENANCE —
      // where the tenant id came from — and it is recorded as its own fact.
      if (acc.op === "create" || acc.op === "createMany") {
        const text = acc.node.getText();
        insertSites.push({
          site: `${file}: ${acc.model}.${acc.op}`,
          carriesTenantValue: TENANT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(text)),
          // WHERE THE STAMPED TENANT ID CAME FROM.
          //
          // `teamId: token.teamId` (resolved from the intake link the server
          // just loaded) and `teamId: body.teamId ?? null` (whatever the caller
          // typed) are the same shape and opposite facts. Only the second can
          // claim a workspace the caller has nothing to do with, so only the
          // second is worth reporting — flagging both would bury the one real
          // instance under four correct ones.
          tenantValueFromRequest: TENANT_COLUMNS.some((c) =>
            // `body` / `params` / `query` (and their `req.`-qualified forms)
            // are the Fastify request surface. `input` and `payload` are NOT
            // in this list: inside a service they name a function parameter
            // the caller already validated, and including them flagged four
            // server-resolved inserts as caller-controlled.
            new RegExp(`\\b${c}\\s*:\\s*\\(?\\s*(req\\.)?(body|params|query)\\b`).test(text),
          ),
        });
        return;
      }
      // Reads and mutations of EXISTING rows are what a membership decision
      // must govern.
      tenantAccessModels.add(acc.model);
      let { tenant, self, whereText } = predicatesOf(acc.node);
      if (!tenant && !self) {
        for (const [name, kind] of scopedRowBindings) {
          if (new RegExp(`\\b${name}\\.`).test(whereText)) {
            if (kind === "tenant") tenant = true;
            else self = true;
            break;
          }
        }
      }
      if (tenant) tenantPredicateSites++;
      else if (self) selfPredicateSites++;
      else {
        // Deferred: a post-read tenant verification appears AFTER the read in
        // source order, so the verdict cannot be taken here.
        pendingUnscoped.push({ file, site: `${file}: ${acc.model}.${acc.op}` });
      }
  };

  let unresolved = [];
  let functionsVisited = 0;
  // Each root is walked IN ITS OWN FILE'S import context. A handler passed by
  // reference resolves to a declaration in another module, while the route's
  // options object stays in the registering file; walking both under one file
  // would resolve one of them against the wrong import table.
  const roots = [{ node: handlerNode, file: handlerFile }, ...extraRoots.map((e) =>
    e && e.node ? { node: e.node, file: e.file ?? handlerFile } : { node: e, file: handlerFile },
  )].filter((r) => r.node);
  for (const root of roots) {
    const r = traverse(root.node, root.file, cg, { maxDepth, onNode: onNodeShared });
    unresolved = unresolved.concat(r.unresolved);
    functionsVisited += r.functionsVisited;
  }

  // Settle the deferred accesses now that the whole traversal is known.
  for (const p of pendingUnscoped) {
    if (tenantVerificationFiles.has(p.file)) tenantPredicateSites++;
    else if (unscopedSites.length < 10) unscopedSites.push(`${p.site} — no tenant or self predicate`);
  }

  if (membershipTableSite && statusPredicateSite && membership.size === 0) {
    membership.set(
      "inline-membership-status-check",
      `${membershipTableSite} paired with a lifecycle-status predicate (${statusPredicateSite})`,
    );
  }

  // RESOURCE-OWNER IDENTITY — all three facts, or nothing.
  const ownerHit = ownerComparisons.find(
    (c) => actorIdentityBindings.has(c.left) || actorIdentityBindings.has(c.right),
  );
  const ownerIdentityAuthority =
    ownerHit && refusalSite
      ? `${ownerHit.file}: an owner column is compared against the session-bound actor (\`${ownerHit.left} === ${ownerHit.right}\`) and the mismatch is refused (${refusalSite})`
      : null;
  if (ownerIdentityAuthority && membership.size === 0) {
    membership.set("resource-owner-identity", ownerIdentityAuthority);
  }

  return {
    ownerIdentityAuthority,
    refusalCodes: [...refusalCodes].sort(),
    membershipAuthorities: [...membership.entries()].map(([id, why]) => ({ id, why })),
    modelsRead: [...modelsRead].sort(),
    modelsWritten: [...modelsWritten].sort(),
    tenantPredicateSites,
    selfPredicateSites,
    unscopedSites,
    infrastructureSites: [...infrastructureSites],
    insertSites,
    tenantAccessModels: [...tenantAccessModels].sort(),
    unresolvedCalls: unresolved.length,
    functionsVisited,
  };
}

// ===========================================================================
// Classification
// ===========================================================================

export const DATA_SCOPES = Object.freeze([
  "PUBLIC_DATA", "GLOBAL_USER_SELF", "PLATFORM_GLOBAL", "WORKSPACE_SCOPED",
  "ORGANIZATION_SCOPED", "MULTI_TENANT_PLATFORM_ADMIN", "TOKEN_SCOPED",
  "PROVIDER_SCOPED", "MACHINE_SCOPED", "NO_DATA_ACCESS",
]);

export const TENANT_TYPES = Object.freeze([
  "NONE", "WORKSPACE", "ORGANIZATION", "WORKSPACE_AND_ORGANIZATION", "TOKEN_BOUND", "PLATFORM",
]);

/** Families whose binding IS the family — a token, a machine secret, a signature. */
const SELF_BOUND_FAMILIES = new Set([
  "PORTAL_OR_REVIEWER_TOKEN", "INTAKE_OR_EVIDENCE_REQUEST_TOKEN", "WEBHOOK_SIGNATURE",
  "CRON_OR_MACHINE_SECRET", "API_KEY_SCOPED", "SCIM_BEARER", "SAML", "OIDC",
]);

/**
 * The tenancy verdict for one route.
 *
 * `tenantBindingResolved` is FALSE only when a route reads or writes
 * tenant-owned rows with neither a membership decision nor a self predicate —
 * the honest definition of unresolved. It is also FALSE when the traversal
 * could not be completed, so an analysis gap can never be reported as a pass.
 */
export function classifyTenantBinding(row, analysis) {
  const fam = row.primarySecurityFamily;
  // Reads and mutations of EXISTING tenant-owned rows — inserts are judged by
  // provenance below, and infrastructure trail accesses are excluded upstream.
  const touchesTenantModels = (analysis.tenantAccessModels ?? []).length > 0;

  /**
   * A route the ROUTE ANALYZER already classified as reaching the canonical
   * evaluator is bound by construction, whether or not this module's
   * handler-side walk sees it again.
   *
   * `WORKSPACE_AUTHORIZED` / `ORGANIZATION_AUTHORIZED` are exactly the families
   * derived from `CAPABILITY_GATED`, which the route analyzer proves by
   * following the route's GUARDS (preHandlers) to `authorizeOrFail`. This
   * module walks the HANDLER, so a gate that lives entirely in a preHandler is
   * invisible here — and requiring this walk to rediscover it would report
   * correctly-gated routes as unbound. Trusting the engine's own prior fact is
   * not a shortcut; it is using the authority that already measured it.
   */
  const gatedByCanonicalEvaluator =
    fam === "WORKSPACE_AUTHORIZED" || fam === "ORGANIZATION_AUTHORIZED";

  const hasMembership =
    analysis.membershipAuthorities.length > 0 || gatedByCanonicalEvaluator;

  let dataScope;
  let tenantType;

  if (fam === "PUBLIC_READ" || fam === "PUBLIC_WRITE") {
    dataScope = "PUBLIC_DATA"; tenantType = "NONE";
  } else if (fam === "PLATFORM_ADMIN") {
    dataScope = "MULTI_TENANT_PLATFORM_ADMIN"; tenantType = "PLATFORM";
  } else if (fam === "OPERATIONAL_HEALTH_METRICS_DEBUG_SEED") {
    dataScope = touchesTenantModels ? "PLATFORM_GLOBAL" : "NO_DATA_ACCESS";
    tenantType = "PLATFORM";
  } else if (SELF_BOUND_FAMILIES.has(fam)) {
    dataScope =
      fam === "WEBHOOK_SIGNATURE" ? "PROVIDER_SCOPED"
      : fam === "CRON_OR_MACHINE_SECRET" ? "MACHINE_SCOPED"
      : "TOKEN_SCOPED";
    tenantType = "TOKEN_BOUND";
  } else if (fam === "ORGANIZATION_AUTHORIZED") {
    dataScope = "ORGANIZATION_SCOPED"; tenantType = "ORGANIZATION";
  } else if (fam === "WORKSPACE_AUTHORIZED") {
    dataScope = "WORKSPACE_SCOPED"; tenantType = "WORKSPACE";
  } else if (!touchesTenantModels) {
    dataScope =
      analysis.modelsRead.length + analysis.modelsWritten.length === 0
        ? "NO_DATA_ACCESS"
        : "GLOBAL_USER_SELF";
    tenantType = "NONE";
  } else if (hasMembership) {
    dataScope = "WORKSPACE_SCOPED"; tenantType = "WORKSPACE";
  } else if (analysis.selfPredicateSites > 0 && analysis.unscopedSites.length === 0) {
    // Every tenant-owned access carried a self predicate: the caller reaches
    // only their own rows. That is a binding, even without a membership call.
    dataScope = "GLOBAL_USER_SELF"; tenantType = "NONE";
  } else {
    dataScope = "WORKSPACE_SCOPED"; tenantType = "WORKSPACE";
  }

  const needsMembership =
    (tenantType === "WORKSPACE" || tenantType === "ORGANIZATION") &&
    !SELF_BOUND_FAMILIES.has(fam) &&
    fam !== "PLATFORM_ADMIN";

  const tenantBindingResolved = !needsMembership || hasMembership;

  // WHERE the tenant identity came from — a fact each route must carry, so a
  // binding can be argued with rather than merely trusted.
  const authorityIds = analysis.membershipAuthorities.map((m) => m.id);
  const tenantIdSource = gatedByCanonicalEvaluator
    ? "CANONICAL_EVALUATOR_GUARD"
    : authorityIds.includes("resource-owner-identity")
      ? "RESOURCE_OWNER_COLUMN"
      : authorityIds.includes("inline-membership-status-check")
        ? "MEMBERSHIP_LOOKUP"
        : authorityIds.length > 0
          ? "NAMED_AUTHORITY"
          : SELF_BOUND_FAMILIES.has(fam)
            ? "BEARER_TOKEN_SUBJECT"
            : analysis.selfPredicateSites > 0
              ? "AUTHENTICATED_SUBJECT"
              : tenantType === "NONE"
                ? "NONE"
                // A PLATFORM-scoped surface is bound by its own gate — the
                // platform-admin lookup or the machine secret — not by a tenant
                // id. Falling through to UNRESOLVED here made four operational
                // routes look like the analysis had reached no decision, and
                // the mutation pass then reported 30 writers as reachable from
                // an ungoverned route.
                : tenantType === "PLATFORM"
                  ? "PLATFORM_SCOPE"
                  : "UNRESOLVED";

  return {
    dataScope,
    tenantType,
    tenantIdSource,
    // The canonical evaluator is where the organization-lifecycle refusal
    // lives (Phase 1 authorization closure); no other idiom asserts it.
    organizationLifecycleRequirement:
      gatedByCanonicalEvaluator ||
      authorityIds.some((id) => /^authorize/.test(id)) ||
      authorityIds.includes("evaluateMemberAccess") ||
      authorityIds.includes("checkOrgAccess")
        ? "ENFORCED_BY_CANONICAL_EVALUATOR"
        : tenantType === "ORGANIZATION" || tenantType === "WORKSPACE_AND_ORGANIZATION"
          ? "NOT_REACHED"
          : "NOT_APPLICABLE",
    // INSERT PROVENANCE — an insert that stamps a tenant id while the route
    // reached no membership decision has taken the tenant id on trust. That is
    // how `POST /v1/capture/sessions` came to write `teamId: body.teamId` for a
    // workspace the caller need not belong to.
    tenantStampingInsertSites: (analysis.insertSites ?? [])
      .filter((i) => i.carriesTenantValue)
      .map((i) => i.site),
    // A token-, machine- or platform-scoped route takes its tenant from the
    // CREDENTIAL it already verified, not from a membership lookup, so an
    // insert there is bound by construction. Only a session-authenticated
    // route can stamp a tenant id it never checked.
    tenantUnboundInsertSites:
      hasMembership || SELF_BOUND_FAMILIES.has(fam) || fam === "PLATFORM_ADMIN"
        ? []
        : (analysis.insertSites ?? [])
            .filter((i) => i.carriesTenantValue && i.tenantValueFromRequest)
            .map((i) => i.site),
    crossTenantRefusalSemantics:
      (analysis.refusalCodes ?? []).length > 0
        ? `refuses with ${(analysis.refusalCodes ?? []).join("/")}`
        : hasMembership
          ? "refusal raised by the named authority"
          : "NONE_OBSERVED",
    tenantBindingAuthority: hasMembership
      ? (analysis.membershipAuthorities.length > 0
          ? analysis.membershipAuthorities.map((m) => m.id).join(" + ")
          : "authorizeOrFail (proven by the route analyzer's guard traversal)")
      : null,
    membershipStatusRequirement: hasMembership ? "ACTIVE (enforced by the named authority)" : null,
    modelsRead: analysis.modelsRead,
    modelsWritten: analysis.modelsWritten,
    tenantPredicateSites: analysis.tenantPredicateSites,
    selfPredicateSites: analysis.selfPredicateSites,
    unscopedTenantModelSites: analysis.unscopedSites.length,
    tenantBindingResolved,
    // Both halves are reported when a binding exists: the authority that
    // licenses it AND every tenant-owned access that carried no predicate of
    // its own. A resource-owner binding legitimately loads the row before it
    // can compare the owner, so its unscoped read is expected — and a reviewer
    // still gets to see it rather than being shown only the reassuring half.
    tenantBindingEvidence: hasMembership
      ? [...analysis.membershipAuthorities.map((m) => m.why), ...analysis.unscopedSites]
      : analysis.unscopedSites,
  };
}

export { buildCallGraph };
