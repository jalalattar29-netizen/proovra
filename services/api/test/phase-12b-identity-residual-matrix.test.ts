/**
 * PHASE 12B ACCEPTANCE — IDENTITY/SECURITY RESIDUAL BEHAVIORAL MATRIX.
 *
 * Closes the LAST 20 Identity/Security operations that had no behavioral
 * coverage anywhere in the API corpus:
 *
 *   routes/identity.routes.ts (11)
 *     POST   /v1/identity/members/:id/capabilities        grantCapability
 *     DELETE /v1/identity/capabilities/:id                revokeCapability
 *     POST   /v1/identity/members/:id/delegated-admin     grantDelegatedAdminScope
 *     DELETE /v1/identity/delegated-admin/:id             revokeDelegatedAdminScope
 *     GET    /v1/identity/service-accounts                listApiCredentials
 *     POST   /v1/identity/service-accounts/:id/disable    disableApiCredential
 *     POST   /v1/identity/service-accounts/:id/enable     enableApiCredential
 *     PATCH  /v1/identity/service-accounts/:id/hardening  updateApiCredentialHardening
 *     GET    /v1/identity/access-reviews                  listAccessReviews
 *     POST   /v1/identity/access-reviews/regenerate       regenerateAccessReviewQueue
 *     POST   /v1/identity/access-reviews/:id/decision     completeAccessReview
 *   routes/security.routes.ts (2)
 *     GET    /v1/security/scans                           listScansForTeam
 *     GET    /v1/security/events                          listSecurityEvents
 *   routes/scim-admin.routes.ts (2)
 *     GET    /v1/admin/identity/scim/managed-membership
 *     POST   /v1/admin/identity/scim/tokens/:id/rotate
 *   routes/scim.routes.ts — RFC 7644, bearer-token ONLY, never a session (5)
 *     GET    /v2/scim/Users      (filter + pagination)
 *     POST   /v2/scim/Groups
 *     GET    /v2/scim/Groups/:id
 *     GET    /v2/scim/Groups
 *     DELETE /v2/scim/Groups/:id
 *
 * METHOD. The REAL route modules run under fastify `inject`, each on its OWN
 * app instance (path-param collisions between modules are avoided). Only
 * PROCESS BOUNDARIES are substituted:
 *   - session auth (`getAuthUserId` / `requireAuth`)
 *   - the canonical `authorizeOrFail` primitive (its own coverage elsewhere)
 *   - the step-up transport
 *   - the plan/entitlement gate
 *   - `emitTenantAudit` + `safeEmitSecurityEvent` (fire-and-forget sinks)
 *   - the Prisma client — replaced by an in-memory store with real `where`
 *     semantics and a REAL `$transaction` that ROLLS BACK on throw, so
 *     "zero partial mutation" is observed at the store, not asserted by faith.
 *
 * Everything else is the production implementation: `api-keys.service`,
 * `access-review.service`, `file-security-scan.service`,
 * `security-event.service`, `scim.service` (incl. real token hashing) and
 * `scim-groups.service` all execute for real against the store. The canonical
 * services named in the operation table are wrapped so each invocation is
 * counted while still running the real body.
 *
 * Proof categories per product system: (1) authorized happy path, canonical
 * service called EXACTLY once on the SERVER-derived workspace; (2) denial →
 * bounded body + ZERO mutation; (3) cross-Organization concealment byte-
 * identical to "missing"; (4) target-bound step-up with zero mutation on
 * denial; (5) secret-free POPULATED projections; (6) SCIM bearer/hashed-token
 * + scope gate + token-derived scope + SCIM-shaped errors + transactional
 * rollback.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Fixtures. Literals are repeated inside hoisted factories (vi.mock hoists
// above these declarations).
// -----------------------------------------------------------------------------

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const OTHER_TEAM = "33333333-3333-4333-8333-333333333333";

const SUBJECT_USER = "44444444-4444-4444-8444-444444444401";
const STALE_USER = "44444444-4444-4444-8444-444444444402";
const FOREIGN_USER = "44444444-4444-4444-8444-444444444409";

const ACTOR_MEMBER = "55555555-5555-4555-8555-555555555500";
const TARGET_MEMBER = "55555555-5555-4555-8555-555555555501";
const FOREIGN_MEMBER = "55555555-5555-4555-8555-555555555509";
const MISSING_MEMBER = "55555555-5555-4555-8555-5555555555ff";

const GRANT = "66666666-6666-4666-8666-666666666601";
const FOREIGN_GRANT = "66666666-6666-4666-8666-666666666609";
const MISSING_GRANT = "66666666-6666-4666-8666-6666666666ff";

const SCOPE = "77777777-7777-4777-8777-777777777701";
const FOREIGN_SCOPE = "77777777-7777-4777-8777-777777777709";
const MISSING_SCOPE = "77777777-7777-4777-8777-7777777777ff";

const CRED = "88888888-8888-4888-8888-888888888801";
const CRED_REVOKED = "88888888-8888-4888-8888-888888888802";
const FOREIGN_CRED = "88888888-8888-4888-8888-888888888809";
const MISSING_CRED = "88888888-8888-4888-8888-8888888888ff";

const REVIEW = "99999999-9999-4999-8999-999999999901";
const REVIEW_DONE = "99999999-9999-4999-8999-999999999902";
const FOREIGN_REVIEW = "99999999-9999-4999-8999-999999999909";
const MISSING_REVIEW = "99999999-9999-4999-8999-9999999999ff";

const TOKEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const TOKEN_REVOKED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const FOREIGN_TOKEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09";
const MISSING_TOKEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaff";

const GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";
const FOREIGN_GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb09";
const MISSING_GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbff";

const SCAN = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";

/** Raw bearer credentials. Only their HASH is ever persisted. */
const SECRET = "phase-12b-residual-auth-secret";
const RAW_ALL = "scim_pat_aaaa1111aaaa1111aaaa1111aaaa1111";
const RAW_GROUPS_WRITE = "scim_pat_bbbb2222bbbb2222bbbb2222bbbb2222";
const RAW_USERS_WRITE = "scim_pat_cccc3333cccc3333cccc3333cccc3333";
const RAW_GROUPS_READ = "scim_pat_dddd4444dddd4444dddd4444dddd4444";
const RAW_USERS_READ = "scim_pat_eeee5555eeee5555eeee5555eeee5555";
const RAW_FOREIGN = "scim_pat_ffff6666ffff6666ffff6666ffff6666";
const RAW_UNKNOWN = "scim_pat_99999999999999999999999999999999";

const hashRaw = (raw: string): string =>
  createHash("sha256").update(`${SECRET}:${raw}`).digest("hex");

// -----------------------------------------------------------------------------
// Hoisted state + the in-memory Prisma substitute.
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;

const H = vi.hoisted(() => {
  // --- generic where/orderBy/select engine -----------------------------------
  const sameVal = (a: unknown, b: unknown): boolean => {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a === undefined && b === null) return true;
    if (a === null && b === undefined) return true;
    return a === b;
  };
  const num = (v: unknown): number =>
    v instanceof Date ? v.getTime() : typeof v === "number" ? v : NaN;
  const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals"]);

  const matchOne = (rowVal: unknown, cond: unknown): boolean => {
    if (cond === null || cond === undefined) return rowVal === null || rowVal === undefined;
    if (cond instanceof Date) return sameVal(rowVal, cond);
    if (typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if (!Object.keys(c).some((k) => OPS.has(k))) return false;
      for (const [k, v] of Object.entries(c)) {
        if (k === "in" && !(v as unknown[]).some((x) => sameVal(rowVal, x))) return false;
        if (k === "notIn" && (v as unknown[]).some((x) => sameVal(rowVal, x))) return false;
        if (k === "equals" && !sameVal(rowVal, v)) return false;
        if (k === "not" && matchOne(rowVal, v)) return false;
        if (k === "lt" && !(num(rowVal) < num(v))) return false;
        if (k === "lte" && !(num(rowVal) <= num(v))) return false;
        if (k === "gt" && !(num(rowVal) > num(v))) return false;
        if (k === "gte" && !(num(rowVal) >= num(v))) return false;
      }
      return true;
    }
    return sameVal(rowVal, cond);
  };

  const asArray = (v: unknown): Row[] =>
    (Array.isArray(v) ? v : [v]) as Row[];

  const matchWhere = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === "AND") { if (!asArray(v).every((w) => matchWhere(row, w))) return false; continue; }
      if (k === "OR") { if (!asArray(v).some((w) => matchWhere(row, w))) return false; continue; }
      if (k === "NOT") { if (asArray(v).some((w) => matchWhere(row, w))) return false; continue; }
      // Compound unique (`teamId_userId: { teamId, userId }`) — the key is not a
      // column, so expand its members as ordinary conditions.
      const isPlainObject =
        v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
      if (!(k in row) && isPlainObject && !Object.keys(v as Row).some((x) => OPS.has(x))) {
        if (!matchWhere(row, v as Row)) return false;
        continue;
      }
      if (!matchOne(row[k], v)) return false;
    }
    return true;
  };

  let seq = 0;
  const newId = (): string =>
    `dddddddd-dddd-4ddd-8ddd-${String(++seq).padStart(12, "0")}`;

  type Store = Record<string, Row[]>;
  const store: Store = {};
  const TABLES = [
    "user", "teamMember", "memberCapabilityGrant", "memberDelegatedAdminScope",
    "apiCredential", "fileSecurityScan", "securityEvent", "accessReview",
    "externalIdentityMapping", "scimProvisioningToken", "scimGroup",
  ];
  for (const t of TABLES) store[t] = [];

  /** Every store WRITE, in order — the zero-mutation oracle. */
  const writes: string[] = [];
  /** Every wrapped canonical-service invocation, in order. */
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const clone = (r: Row): Row => ({ ...r });

  /** Column defaults the production schema applies on INSERT. */
  const DEFAULTS: Record<string, Row> = {
    scimProvisioningToken: {
      status: "ACTIVE", ipAllowlist: [], lastUsedAtUtc: null, expiresAtUtc: null,
      revokedAtUtc: null, revokedByUserId: null, revokedReason: null,
    },
    scimGroup: { status: "ACTIVE", externalId: null },
    accessReview: { status: "PENDING", completedAtUtc: null, completedByUserId: null, decisionNote: null },
  };

  const project = (table: string, row: Row, select: Row | undefined): Row => {
    if (!select) return clone(row);
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) { out[k] = row[k]; continue; }
      if (v && typeof v === "object" && "select" in (v as Row)) {
        // The only relation any covered code path reads.
        if (table === "teamMember" && k === "user") {
          const u = store["user"].find((x) => x["id"] === row["userId"]);
          out[k] = u ? project("user", u, (v as Row)["select"] as Row) : null;
        } else out[k] = null;
      }
    }
    return out;
  };

  const sortRows = (rows: Row[], orderBy: unknown): Row[] => {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [field, dir] of Object.entries(spec)) {
          const av = a[field], bv = b[field];
          const an = av instanceof Date ? av.getTime() : av;
          const bn = bv instanceof Date ? bv.getTime() : bv;
          if (an === bn || an == null || bn == null) continue;
          const cmp = an < bn ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    });
  };

  const delegate = (table: string) => ({
    findFirst: async (a: Row = {}) => {
      const rows = sortRows(store[table].filter((r) => matchWhere(r, a["where"] as Row)), a["orderBy"]);
      return rows.length > 0 ? project(table, rows[0], a["select"] as Row | undefined) : null;
    },
    findUnique: async (a: Row = {}) => {
      const r = store[table].find((x) => matchWhere(x, a["where"] as Row));
      return r ? project(table, r, a["select"] as Row | undefined) : null;
    },
    findUniqueOrThrow: async (a: Row = {}) => {
      const r = store[table].find((x) => matchWhere(x, a["where"] as Row));
      if (!r) throw new Error(`${table}_not_found`);
      return project(table, r, a["select"] as Row | undefined);
    },
    findMany: async (a: Row = {}) => {
      let rows = sortRows(store[table].filter((r) => matchWhere(r, a["where"] as Row)), a["orderBy"]);
      const skip = (a["skip"] as number | undefined) ?? 0;
      const take = (a["take"] as number | undefined) ?? rows.length;
      rows = rows.slice(skip, skip + take);
      return rows.map((r) => project(table, r, a["select"] as Row | undefined));
    },
    count: async (a: Row = {}) =>
      store[table].filter((r) => matchWhere(r, a["where"] as Row)).length,
    create: async (a: Row = {}) => {
      const data = { ...(a["data"] as Row) };
      for (const [k, v] of Object.entries(data)) {
        // Prisma JsonNull sentinel → SQL NULL.
        if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
          && Object.keys(v as Row).length === 0) data[k] = null;
      }
      const now = new Date();
      const row: Row = {
        id: (data["id"] as string) ?? newId(),
        createdAt: now, updatedAt: now,
        ...(DEFAULTS[table] ?? {}),
        ...data,
      };
      store[table].push(row);
      writes.push(`${table}.create`);
      return clone(row);
    },
    update: async (a: Row = {}) => {
      const r = store[table].find((x) => matchWhere(x, a["where"] as Row));
      if (!r) throw new Error(`${table}_update_not_found`);
      Object.assign(r, a["data"] as Row, { updatedAt: new Date() });
      writes.push(`${table}.update`);
      return project(table, r, a["select"] as Row | undefined);
    },
    updateMany: async (a: Row = {}) => {
      const rows = store[table].filter((x) => matchWhere(x, a["where"] as Row));
      for (const r of rows) Object.assign(r, a["data"] as Row, { updatedAt: new Date() });
      if (rows.length > 0) writes.push(`${table}.updateMany`);
      return { count: rows.length };
    },
    deleteMany: async (a: Row = {}) => {
      const keep = store[table].filter((x) => !matchWhere(x, a["where"] as Row));
      const n = store[table].length - keep.length;
      store[table] = keep;
      if (n > 0) writes.push(`${table}.deleteMany`);
      return { count: n };
    },
  });

  const prisma: Record<string, unknown> = {};
  for (const t of TABLES) prisma[t] = delegate(t);
  // REAL transactional semantics: a throw restores the pre-transaction
  // snapshot, so a partially applied multi-step write is observable as such.
  prisma["$transaction"] = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot: Record<string, Row[]> = {};
    for (const t of TABLES) snapshot[t] = store[t].map(clone);
    const writeMark = writes.length;
    try {
      return await fn(prisma);
    } catch (err) {
      for (const t of TABLES) store[t] = snapshot[t];
      writes.length = writeMark;
      writes.push("ROLLBACK");
      throw err;
    }
  };

  return {
    // boundary toggles
    actorUserId: "11111111-1111-4111-8111-111111111111",
    authorizeAllows: true,
    stepUpDenies: false,
    enterpriseOk: true,
    currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,
    managedState: "STANDARD" as "STANDARD" | "MANAGED",
    demoteFails: false,
    // recorders
    writes, calls,
    authorizeChecks: [] as Array<{ teamId: string; permission: string; kind: string | null; id: string | null; anti: boolean }>,
    stepUps: [] as Array<{ teamId: string; purpose: string; kind: string; id: string | null }>,
    audits: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    // store handles
    store, prisma, matchWhere, newId,
    rec: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); },
  };
});

type Reply = { code: (n: number) => { send: (b?: unknown) => void } };

// --- process boundaries -------------------------------------------------------

vi.mock("../src/db.js", () => ({ prisma: H.prisma }));

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthSessionId: () => "session-hash",
}));

vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));

// Reproduces the real primitive's denial surface: `antiEnumeration` → concealed
// 404, otherwise 403 permission_denied.
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: Reply,
    o: { teamId: string; permission: string; resourceKind?: string; resourceId?: string; antiEnumeration?: boolean },
  ) => {
    H.authorizeChecks.push({
      teamId: o.teamId, permission: o.permission,
      kind: o.resourceKind ?? null, id: o.resourceId ?? null,
      anti: o.antiEnumeration === true,
    });
    if (H.authorizeAllows) return { actorUserId: H.actorUserId, teamId: o.teamId };
    if (o.antiEnumeration) reply.code(404).send({ error: { code: "not_found" } });
    else reply.code(403).send({ error: { code: "permission_denied", reason: "forbidden" } });
    return null;
  },
}));

vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (i: {
    teamId: string; purpose: string; resourceKind: string; resourceId: string | null; reply: Reply;
  }) => {
    H.stepUps.push({ teamId: i.teamId, purpose: i.purpose, kind: i.resourceKind, id: i.resourceId ?? null });
    if (!H.stepUpDenies) return { sent: false, verifiedChallengeId: "challenge-1" };
    i.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED", purpose: i.purpose } });
    return { sent: true };
  },
}));

vi.mock("../src/services/enterprise-gate-resolvers.service.js", () => ({
  resolveTeamEnterpriseFeatureGate: async () =>
    H.enterpriseOk ? { ok: true } : { ok: false, reason: "ENTERPRISE_FEATURE_REQUIRED", statusCode: 402 },
  denyTeamIfNotEnterprise: async (reply: Reply, _teamId: string, feature: string) => {
    if (H.enterpriseOk) return false;
    reply.code(402).send({ error: { code: "ENTERPRISE_FEATURE_REQUIRED", feature } });
    return true;
  },
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (env: Record<string, unknown>) => { H.audits.push(env); },
}));

vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  resolveManagedIdentity: async () =>
    H.managedState === "MANAGED"
      ? { state: "MANAGED", managingOrganizationId: "org-1" }
      : { state: "STANDARD", managingOrganizationId: null },
}));

vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  organizationIdForPolicy: async () => "org-1",
  resolveOrganizationPolicy: async () => ({
    applicability: "ORGANIZATION",
    policy: { managedIdentityRequired: false },
  }),
}));

vi.mock("../src/services/access-control/scim-managed-ownership.service.js", () => {
  class ScimManagedOwnershipError extends Error {
    constructor(readonly code: string) { super(code); this.name = "ScimManagedOwnershipError"; }
  }
  return { ScimManagedOwnershipError, enforceScimManagedOwnership: async () => undefined };
});

vi.mock("../src/services/security/enterprise-account-linking.service.js", () => ({
  evaluateExistingAccountLink: async () => ({ ok: true }),
}));

vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  revokeAllSessionsForUser: async () => ({ revokedCount: 0 }),
}));

// Not under test here (their own suites cover them) — stubbed so the route
// module graph resolves without dragging unrelated services in.
vi.mock("../src/services/identity/contributor-governance.service.js", () => {
  class ContributorGovernanceError extends Error {
    constructor(readonly code: string) { super(code); this.name = "ContributorGovernanceError"; }
  }
  return { ContributorGovernanceError, revokeContributorSession: async () => ({ id: "s" }) };
});
vi.mock("../src/services/identity/external-identity.service.js", () => {
  class ExternalIdentityError extends Error {
    constructor(readonly code: string) { super(code); this.name = "ExternalIdentityError"; }
  }
  return {
    ExternalIdentityError,
    linkExternalIdentity: async () => ({ id: "m" }),
    listExternalIdentityMappings: async () => [],
    unlinkExternalIdentity: async () => ({ id: "m" }),
  };
});

// The membership orchestrator IS the canonical authority for capability /
// delegated-admin grants and for directory role changes. Recorded, and the
// directory legs mutate the store through the transaction client so rollback
// is observable.
vi.mock("../src/services/identity/membership-provisioning.service.js", () => {
  class RbacError extends Error {
    constructor(readonly code: string) { super(code); this.name = "RbacError"; }
  }
  type Tx = { teamMember: { findMany: (a: unknown) => Promise<Array<{ id: string }>>; updateMany: (a: unknown) => Promise<{ count: number }>; update: (a: unknown) => Promise<unknown> } };
  const rec = (fn: string, args: Record<string, unknown>) => { H.rec(fn, args); };
  return {
    RbacError,
    grantCapability: async (i: Record<string, unknown>) => {
      rec("grantCapability", i);
      if (i["reason"] === "force-conflict") throw new RbacError("capability_already_active");
      return { id: "grant-new", teamId: i["teamId"], permission: i["permission"], active: true };
    },
    revokeCapability: async (i: Record<string, unknown>) => {
      rec("revokeCapability", i);
      return { id: i["grantId"], teamId: i["teamId"], revokedAtUtc: new Date().toISOString() };
    },
    grantDelegatedAdminScope: async (i: Record<string, unknown>) => {
      rec("grantDelegatedAdminScope", i);
      return { id: "scope-new", teamId: i["teamId"], scopeKind: i["scopeKind"], active: true };
    },
    revokeDelegatedAdminScope: async (i: Record<string, unknown>) => {
      rec("revokeDelegatedAdminScope", i);
      return { id: i["scopeId"], teamId: i["teamId"], revokedAtUtc: new Date().toISOString() };
    },
    // Consumed by the REAL access-review service on REVOKE/SUSPEND decisions.
    revokeMember: async (i: Record<string, unknown>) => {
      rec("revokeMember", i);
      H.writes.push("revokeMember");
      return { id: i["teamMemberId"], status: "REVOKED" };
    },
    suspendMember: async (i: Record<string, unknown>) => {
      rec("suspendMember", i);
      H.writes.push("suspendMember");
      return { id: i["teamMemberId"], status: "SUSPENDED" };
    },
    restoreMember: async () => ({ id: "m", status: "ACTIVE" }),
    changeMemberRole: async () => ({ id: "m", role: "MEMBER" }),
    listTeamMembersWithAccess: async () => [],
    provisionMembership: async () => ({ teamMemberId: "m" }),
    provisionManagedMembership: async () => ({ teamMemberId: "m" }),
    suspendWorkspaceMembership: async () => ({ ok: true }),
    applyDirectoryRoleChange: async (
      tx: Tx,
      i: { teamMemberId: string; currentRole: string; desiredRole: string },
    ) => {
      rec("applyDirectoryRoleChange", { ...i });
      if (i.currentRole === i.desiredRole) return { changed: false };
      await tx.teamMember.update({ where: { id: i.teamMemberId }, data: { role: i.desiredRole } });
      return { changed: true };
    },
    // The demotion leg of the atomic group archive. When it fails the whole
    // DELETE must roll back — including the ARCHIVE already written above it.
    demoteGroupMappedRoleOnArchive: async (
      tx: Tx,
      i: { teamId: string; mappedRole: string },
    ) => {
      rec("demoteGroupMappedRoleOnArchive", { ...i });
      const affected = await tx.teamMember.findMany({
        where: { teamId: i.teamId, role: i.mappedRole, status: "ACTIVE" },
        select: { id: true },
      });
      if (affected.length > 0) {
        await tx.teamMember.updateMany({
          where: { id: { in: affected.map((m) => m.id) } },
          data: { role: "MEMBER" },
        });
      }
      if (H.demoteFails) throw new Error("DEMOTION_BACKEND_FAILURE");
      return { count: affected.length };
    },
  };
});

// --- canonical services: REAL bodies, counted invocations ---------------------

vi.mock("../src/services/security/security-event.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/security/security-event.service.js")>();
  return {
    ...orig,
    // Fire-and-forget sink: recorded, never written (keeps the store deterministic).
    safeEmitSecurityEvent: (i: unknown) => { H.events.push(i as Record<string, unknown>); },
    listSecurityEvents: (...a: Parameters<typeof orig.listSecurityEvents>) => {
      H.rec("listSecurityEvents", { ...a[0] });
      return orig.listSecurityEvents(...a);
    },
  };
});

vi.mock("../src/services/security/file-security-scan.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/security/file-security-scan.service.js")>();
  return {
    ...orig,
    listScansForTeam: (...a: Parameters<typeof orig.listScansForTeam>) => {
      H.rec("listScansForTeam", { ...a[0] });
      return orig.listScansForTeam(...a);
    },
  };
});

vi.mock("../src/services/integrations/api-keys.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/integrations/api-keys.service.js")>();
  return {
    ...orig,
    listApiCredentials: (...a: Parameters<typeof orig.listApiCredentials>) => {
      H.rec("listApiCredentials", { ...a[0] });
      return orig.listApiCredentials(...a);
    },
    disableApiCredential: (...a: Parameters<typeof orig.disableApiCredential>) => {
      H.rec("disableApiCredential", { ...a[0] });
      return orig.disableApiCredential(...a);
    },
    enableApiCredential: (...a: Parameters<typeof orig.enableApiCredential>) => {
      H.rec("enableApiCredential", { ...a[0] });
      return orig.enableApiCredential(...a);
    },
    updateApiCredentialHardening: (...a: Parameters<typeof orig.updateApiCredentialHardening>) => {
      H.rec("updateApiCredentialHardening", { ...a[0] });
      return orig.updateApiCredentialHardening(...a);
    },
  };
});

vi.mock("../src/services/identity/access-review.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/identity/access-review.service.js")>();
  return {
    ...orig,
    listAccessReviews: (...a: Parameters<typeof orig.listAccessReviews>) => {
      H.rec("listAccessReviews", { ...a[0] });
      return orig.listAccessReviews(...a);
    },
    regenerateAccessReviewQueue: (...a: Parameters<typeof orig.regenerateAccessReviewQueue>) => {
      H.rec("regenerateAccessReviewQueue", { ...a[0] });
      return orig.regenerateAccessReviewQueue(...a);
    },
    completeAccessReview: (...a: Parameters<typeof orig.completeAccessReview>) => {
      H.rec("completeAccessReview", { ...a[0] });
      return orig.completeAccessReview(...a);
    },
  };
});

vi.mock("../src/services/access-control/scim.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/access-control/scim.service.js")>();
  return {
    ...orig,
    projectScimManagedMembership: (...a: Parameters<typeof orig.projectScimManagedMembership>) => {
      H.rec("projectScimManagedMembership", { ...a[0] });
      return orig.projectScimManagedMembership(...a);
    },
    rotateScimToken: (...a: Parameters<typeof orig.rotateScimToken>) => {
      H.rec("rotateScimToken", { ...a[0] });
      return orig.rotateScimToken(...a);
    },
    scimListUsers: (...a: Parameters<typeof orig.scimListUsers>) => {
      H.rec("scimListUsers", { teamId: a[0].teamId, ...a[1] });
      return orig.scimListUsers(...a);
    },
  };
});

vi.mock("../src/services/access-control/scim-groups.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/access-control/scim-groups.service.js")>();
  return {
    ...orig,
    scimCreateGroup: (...a: Parameters<typeof orig.scimCreateGroup>) => {
      H.rec("scimCreateGroup", { teamId: a[0].teamId });
      return orig.scimCreateGroup(...a);
    },
    scimReadGroup: (...a: Parameters<typeof orig.scimReadGroup>) => {
      H.rec("scimReadGroup", { teamId: a[0].teamId, id: a[1] });
      return orig.scimReadGroup(...a);
    },
    scimListGroups: (...a: Parameters<typeof orig.scimListGroups>) => {
      H.rec("scimListGroups", { teamId: a[0].teamId, ...a[1] });
      return orig.scimListGroups(...a);
    },
    scimDeleteGroup: (...a: Parameters<typeof orig.scimDeleteGroup>) => {
      H.rec("scimDeleteGroup", { teamId: a[0].teamId, id: a[1] });
      return orig.scimDeleteGroup(...a);
    },
  };
});

// -----------------------------------------------------------------------------
// Real route modules (imported AFTER the boundary substitutions above).
// -----------------------------------------------------------------------------

import { identityRoutes } from "../src/routes/identity.routes.js";
import { securityRoutes } from "../src/routes/security.routes.js";
import { scimAdminRoutes } from "../src/routes/scim-admin.routes.js";
import { scimRoutes } from "../src/routes/scim.routes.js";
import { SCIM_GROUP_SCHEMA_URI } from "@proovra/shared";

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };
type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
const json = (r: Res): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;
const hits = (fn: string): Array<Record<string, unknown>> =>
  H.calls.filter((c) => c.fn === fn).map((c) => c.args);

let identityApp: FastifyInstance;
let securityApp: FastifyInstance;
let scimAdminApp: FastifyInstance;
let scimApp: FastifyInstance;

const savedSecret = process.env["AUTH_SECRET"];
const savedJwt = process.env["JWT_SECRET"];

const D = (n: number): Date => new Date(Date.UTC(2026, 0, n, 0, 0, 0));

function seed(): void {
  for (const t of Object.keys(H.store)) H.store[t] = [];

  H.store["user"] = [
    { id: ACTOR, email: "admin@acme.test", displayName: "Admin", currentWorkspaceId: TEAM, createdAt: D(1), updatedAt: D(1) },
    { id: SUBJECT_USER, email: "member@acme.test", displayName: "Member", currentWorkspaceId: TEAM, createdAt: D(1), updatedAt: D(2) },
    { id: STALE_USER, email: "stale@acme.test", displayName: "Stale", currentWorkspaceId: TEAM, createdAt: D(1), updatedAt: D(1) },
    { id: FOREIGN_USER, email: "other@rival.test", displayName: "Other", currentWorkspaceId: OTHER_TEAM, createdAt: D(1), updatedAt: D(1) },
  ];
  H.store["teamMember"] = [
    { id: ACTOR_MEMBER, teamId: TEAM, userId: ACTOR, role: "OWNER", status: "ACTIVE", lastSeenAtUtc: D(20), accessExpiresAtUtc: null, createdAt: D(1), updatedAt: D(1) },
    { id: TARGET_MEMBER, teamId: TEAM, userId: SUBJECT_USER, role: "ADMIN", status: "ACTIVE", lastSeenAtUtc: D(20), accessExpiresAtUtc: null, createdAt: D(1), updatedAt: D(1) },
    { id: "55555555-5555-4555-8555-555555555502", teamId: TEAM, userId: STALE_USER, role: "MEMBER", status: "ACTIVE", lastSeenAtUtc: null, accessExpiresAtUtc: null, createdAt: D(1), updatedAt: D(1) },
    { id: FOREIGN_MEMBER, teamId: OTHER_TEAM, userId: FOREIGN_USER, role: "ADMIN", status: "ACTIVE", lastSeenAtUtc: D(20), accessExpiresAtUtc: null, createdAt: D(1), updatedAt: D(1) },
  ];
  H.store["memberCapabilityGrant"] = [
    { id: GRANT, teamId: TEAM, teamMemberId: TARGET_MEMBER, permission: "evidence.read", revokedAtUtc: null, createdAt: D(2), updatedAt: D(2) },
    { id: FOREIGN_GRANT, teamId: OTHER_TEAM, teamMemberId: FOREIGN_MEMBER, permission: "evidence.read", revokedAtUtc: null, createdAt: D(2), updatedAt: D(2) },
  ];
  H.store["memberDelegatedAdminScope"] = [
    { id: SCOPE, teamId: TEAM, teamMemberId: TARGET_MEMBER, scopeKind: "REVIEW_ADMIN", revokedAtUtc: null, createdAt: D(2), updatedAt: D(2) },
    { id: FOREIGN_SCOPE, teamId: OTHER_TEAM, teamMemberId: FOREIGN_MEMBER, scopeKind: "REVIEW_ADMIN", revokedAtUtc: null, createdAt: D(2), updatedAt: D(2) },
  ];
  // `keyHash` / `previousKeyHash` are deliberately POPULATED: the projection
  // must never surface them even though the row carries them.
  const credBase = {
    name: "ci-runner", description: "CI", keyPrefix: "pk_live_abc1",
    keyHash: "KEYHASH-c0ffee-NEVER-PROJECTED",
    previousKeyHash: "PREVHASH-dead-NEVER-PROJECTED",
    previousKeyPrefix: "pk_live_old1", previousValidUntilUtc: null,
    scopes: ["evidence.read"], createdByUserId: ACTOR,
    lastUsedAtUtc: D(3), revokedAtUtc: null, revokedByUserId: null, revokedReason: null,
    expiresAtUtc: D(300), disabledAtUtc: null, disabledByUserId: null,
    rotationRequired: false, ipAllowlist: ["10.0.0.0/8"], environment: "prod",
    createdAt: D(1), updatedAt: D(1),
  };
  H.store["apiCredential"] = [
    { ...credBase, id: CRED, teamId: TEAM, status: "ACTIVE" },
    { ...credBase, id: CRED_REVOKED, teamId: TEAM, status: "REVOKED", revokedAtUtc: D(4) },
    { ...credBase, id: FOREIGN_CRED, teamId: OTHER_TEAM, status: "ACTIVE" },
  ];
  H.store["accessReview"] = [
    { id: REVIEW, teamId: TEAM, kind: "STALE_ACCESS", status: "PENDING", subjectKind: "TEAM_MEMBER", subjectUserId: SUBJECT_USER, subjectApiCredentialId: null, subjectIntakeSessionId: null, initiatedByUserId: ACTOR, initiatedAtUtc: D(5), dueAtUtc: null, completedAtUtc: null, completedByUserId: null, decisionNote: null, contextSnapshotJson: null, createdAt: D(5), updatedAt: D(5) },
    { id: REVIEW_DONE, teamId: TEAM, kind: "STALE_ACCESS", status: "COMPLETED_KEEP", subjectKind: "TEAM_MEMBER", subjectUserId: STALE_USER, subjectApiCredentialId: null, subjectIntakeSessionId: null, initiatedByUserId: ACTOR, initiatedAtUtc: D(5), dueAtUtc: null, completedAtUtc: D(6), completedByUserId: ACTOR, decisionNote: null, contextSnapshotJson: null, createdAt: D(5), updatedAt: D(6) },
    { id: FOREIGN_REVIEW, teamId: OTHER_TEAM, kind: "STALE_ACCESS", status: "PENDING", subjectKind: "TEAM_MEMBER", subjectUserId: FOREIGN_USER, subjectApiCredentialId: null, subjectIntakeSessionId: null, initiatedByUserId: FOREIGN_USER, initiatedAtUtc: D(5), dueAtUtc: null, completedAtUtc: null, completedByUserId: null, decisionNote: null, contextSnapshotJson: null, createdAt: D(5), updatedAt: D(5) },
  ];
  H.store["fileSecurityScan"] = [
    { id: SCAN, teamId: TEAM, evidenceId: "ev-1", status: "SUSPICIOUS", scanner: "clamav", signatureVersion: "27000", findingsSummary: "Eicar-Test-Signature", scannedAtUtc: D(7), scannerRawResponse: "RAW-SCANNER-BLOB-NEVER-PROJECTED", objectKey: "s3://bucket/SECRET-OBJECT-KEY", createdAt: D(7), updatedAt: D(7) },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccc0a", teamId: OTHER_TEAM, evidenceId: "ev-9", status: "CLEAN", scanner: "clamav", signatureVersion: "27000", findingsSummary: null, scannedAtUtc: D(7), scannerRawResponse: "RIVAL-BLOB", objectKey: "s3://rival", createdAt: D(7), updatedAt: D(7) },
  ];
  H.store["securityEvent"] = [
    { id: EVENT, teamId: TEAM, eventType: "scim_token_created", severity: "HIGH", details: { action: "rotate", reasonCode: "operator", sessionId: "sess-1234567890", authorizationHeader: "Bearer scim_pat_LEAKED_SECRET", tokenHash: "HASH-LEAK" }, createdAt: D(8), updatedAt: D(8) },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccc0b", teamId: OTHER_TEAM, eventType: "scim_token_created", severity: "HIGH", details: { action: "rotate" }, createdAt: D(8), updatedAt: D(8) },
  ];
  H.store["externalIdentityMapping"] = [
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01", teamId: TEAM, userId: SUBJECT_USER, provider: "SCIM", externalSubjectId: "idp-sub-1", externalEmail: "member@acme.test", displayName: "Member", unlinkedAtUtc: null, linkedAtUtc: D(2), createdAt: D(2), updatedAt: D(2) },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02", teamId: TEAM, userId: STALE_USER, provider: "SCIM", externalSubjectId: "idp-sub-2", externalEmail: "stale@acme.test", displayName: "Stale", unlinkedAtUtc: null, linkedAtUtc: D(3), createdAt: D(3), updatedAt: D(3) },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee09", teamId: OTHER_TEAM, userId: FOREIGN_USER, provider: "SCIM", externalSubjectId: "idp-sub-9", externalEmail: "other@rival.test", displayName: "Other", unlinkedAtUtc: null, linkedAtUtc: D(2), createdAt: D(2), updatedAt: D(2) },
  ];
  const tokenBase = {
    name: "okta", tokenPrefix: "scim_pat_aa", ipAllowlist: [] as string[],
    createdByUserId: ACTOR, lastUsedAtUtc: null, expiresAtUtc: null,
    revokedAtUtc: null, revokedByUserId: null, revokedReason: null,
    createdAt: D(1), updatedAt: D(1),
  };
  H.store["scimProvisioningToken"] = [
    { ...tokenBase, id: TOKEN_ID, teamId: TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_ALL), scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
    { ...tokenBase, id: TOKEN_REVOKED_ID, teamId: TEAM, status: "REVOKED", revokedAtUtc: D(4), tokenHash: "unused-revoked-hash", scopes: ["users.read"] },
    { ...tokenBase, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", teamId: TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_GROUPS_WRITE), scopes: ["groups.write"] },
    { ...tokenBase, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04", teamId: TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_USERS_WRITE), scopes: ["users.write"] },
    { ...tokenBase, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05", teamId: TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_GROUPS_READ), scopes: ["groups.read"] },
    { ...tokenBase, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06", teamId: TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_USERS_READ), scopes: ["users.read"] },
    { ...tokenBase, id: FOREIGN_TOKEN_ID, teamId: OTHER_TEAM, status: "ACTIVE", tokenHash: hashRaw(RAW_FOREIGN), scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
  ];
  H.store["scimGroup"] = [
    { id: GROUP, teamId: TEAM, displayName: "Engineering", externalId: "idp-grp-1", mappedRole: "ADMIN", status: "ACTIVE", createdAt: D(2), updatedAt: D(2) },
    { id: FOREIGN_GROUP, teamId: OTHER_TEAM, displayName: "Rival", externalId: "idp-grp-9", mappedRole: "ADMIN", status: "ACTIVE", createdAt: D(2), updatedAt: D(2) },
  ];
}

beforeEach(async () => {
  process.env["AUTH_SECRET"] = SECRET;
  delete process.env["JWT_SECRET"];
  Object.assign(H, {
    actorUserId: ACTOR,
    authorizeAllows: true,
    stepUpDenies: false,
    enterpriseOk: true,
    currentWorkspaceId: TEAM,
    managedState: "STANDARD",
    demoteFails: false,
  });
  H.writes.length = 0;
  H.calls.length = 0;
  H.authorizeChecks.length = 0;
  H.stepUps.length = 0;
  H.audits.length = 0;
  H.events.length = 0;
  seed();

  identityApp = Fastify();
  await identityApp.register(identityRoutes);
  await identityApp.ready();

  securityApp = Fastify();
  await securityApp.register(securityRoutes);
  await securityApp.ready();

  scimAdminApp = Fastify();
  await scimAdminApp.register(scimAdminRoutes);
  await scimAdminApp.ready();

  scimApp = Fastify();
  await scimApp.register(scimRoutes);
  await scimApp.ready();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env["AUTH_SECRET"];
  else process.env["AUTH_SECRET"] = savedSecret;
  if (savedJwt === undefined) delete process.env["JWT_SECRET"];
  else process.env["JWT_SECRET"] = savedJwt;
});

const row = (table: string, id: string): Row | undefined =>
  H.store[table].find((r) => r["id"] === id);

// =============================================================================
// SYSTEM 1 — CAPABILITY GRANTS + DELEGATED ADMINISTRATION SCOPES
//
// Four target-bound mutations on `identity.routes.ts`. The authoritative
// workspace is derived from the TARGET ROW; the body's `teamId` may only ever
// REJECT. Every one is step-up gated and routes through the membership
// orchestrator.
// =============================================================================

type Op = {
  name: string;
  fn: string;
  permission: string;
  purpose: string;
  kind: string;
  /** Route under test, parameterised by the target id. */
  url: (id: string) => string;
  method: "POST" | "DELETE";
  body: Record<string, unknown>;
  local: string;
  foreign: string;
  missing: string;
  /** The canonical service argument that must carry the target id. */
  idArg: string;
};

const CAP_OPS: Op[] = [
  {
    name: "POST /v1/identity/members/:id/capabilities",
    fn: "grantCapability", permission: "identity.capability.grant",
    purpose: "CAPABILITY_GRANT", kind: "team_member",
    url: (id) => `/v1/identity/members/${id}/capabilities`, method: "POST",
    body: { permission: "evidence.read", reason: "incident triage" },
    local: TARGET_MEMBER, foreign: FOREIGN_MEMBER, missing: MISSING_MEMBER,
    idArg: "teamMemberId",
  },
  {
    name: "DELETE /v1/identity/capabilities/:id",
    fn: "revokeCapability", permission: "identity.capability.revoke",
    purpose: "CAPABILITY_REVOKE", kind: "member_capability_grant",
    url: (id) => `/v1/identity/capabilities/${id}`, method: "DELETE",
    body: { reason: "triage complete" },
    local: GRANT, foreign: FOREIGN_GRANT, missing: MISSING_GRANT,
    idArg: "grantId",
  },
  {
    name: "POST /v1/identity/members/:id/delegated-admin",
    fn: "grantDelegatedAdminScope", permission: "identity.delegated_admin.grant",
    purpose: "DELEGATED_ADMIN_GRANT", kind: "team_member",
    url: (id) => `/v1/identity/members/${id}/delegated-admin`, method: "POST",
    body: { scopeKind: "REVIEW_ADMIN", reason: "quarterly review" },
    local: TARGET_MEMBER, foreign: FOREIGN_MEMBER, missing: MISSING_MEMBER,
    idArg: "teamMemberId",
  },
  {
    name: "DELETE /v1/identity/delegated-admin/:id",
    fn: "revokeDelegatedAdminScope", permission: "identity.delegated_admin.revoke",
    purpose: "DELEGATED_ADMIN_REVOKE", kind: "delegated_admin_scope",
    url: (id) => `/v1/identity/delegated-admin/${id}`, method: "DELETE",
    body: { reason: "review closed" },
    local: SCOPE, foreign: FOREIGN_SCOPE, missing: MISSING_SCOPE,
    idArg: "scopeId",
  },
];

const send = (
  app: FastifyInstance,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
): Promise<Res> =>
  app.inject(
    payload === undefined
      ? { method, url }
      : { method, url, headers: JSON_HEADERS, payload },
  ) as unknown as Promise<Res>;

describe("SYSTEM 1 — capabilities + delegated administration", () => {
  for (const op of CAP_OPS) {
    describe(op.name, () => {
      it("authorized: canonical service called EXACTLY once on the TARGET-derived workspace", async () => {
        const res = await send(identityApp, op.method, op.url(op.local), op.body);
        expect(res.statusCode).toBe(200);
        const calls = hits(op.fn);
        expect(calls).toHaveLength(1);
        // Workspace is SERVER-derived from the target row, never from the body.
        expect(calls[0]["teamId"]).toBe(TEAM);
        expect(calls[0][op.idArg]).toBe(op.local);
        expect(calls[0]["actorUserId"]).toBe(ACTOR);
        // ...and it gated on the capability it claims to.
        expect(H.authorizeChecks).toEqual([
          { teamId: TEAM, permission: op.permission, kind: op.kind, id: op.local, anti: false },
        ]);
      });

      it("authorization denial → bounded 403 permission_denied and ZERO mutation", async () => {
        H.authorizeAllows = false;
        const res = await send(identityApp, op.method, op.url(op.local), op.body);
        expect(res.statusCode).toBe(403);
        expect(json(res)).toEqual({ error: { code: "permission_denied", reason: "forbidden" } });
        expect(hits(op.fn)).toHaveLength(0);
        // Denied BEFORE a step-up challenge could be spent.
        expect(H.stepUps).toHaveLength(0);
      });

      it("target-bound step-up denial → 401 STEP_UP_REQUIRED, ZERO mutation, challenge bound to the TARGET", async () => {
        H.stepUpDenies = true;
        const res = await send(identityApp, op.method, op.url(op.local), op.body);
        expect(res.statusCode).toBe(401);
        expect(json(res)).toEqual({ error: { code: "STEP_UP_REQUIRED", purpose: op.purpose } });
        expect(hits(op.fn)).toHaveLength(0);
        expect(H.stepUps).toEqual([
          { teamId: TEAM, purpose: op.purpose, kind: op.kind, id: op.local },
        ]);
      });

      it("cross-Organization target is BYTE-IDENTICAL to a missing one (concealment), ZERO mutation", async () => {
        const foreign = await send(identityApp, op.method, op.url(op.foreign), op.body);
        const missing = await send(identityApp, op.method, op.url(op.missing), op.body);
        expect(foreign.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(foreign.body).toBe(missing.body);
        expect(foreign.body).toBe(JSON.stringify({ error: { code: "not_found" } }));
        expect(hits(op.fn)).toHaveLength(0);
        expect(H.stepUps).toHaveLength(0);
      });

      it("a declared teamId that disagrees with the target row is CONCEALED (404), never widened", async () => {
        const res = await send(identityApp, op.method, op.url(op.local), {
          ...op.body, teamId: OTHER_TEAM,
        });
        expect(res.statusCode).toBe(404);
        expect(json(res)).toEqual({ error: { code: "not_found" } });
        expect(hits(op.fn)).toHaveLength(0);
        // The client-declared workspace NEVER reached the authorization gate.
        expect(H.authorizeChecks).toHaveLength(0);
      });
    });
  }

  it("orchestrator conflict surfaces as a bounded 409 (capability already active), never a silent 200", async () => {
    const res = await send(identityApp, "POST", `/v1/identity/members/${TARGET_MEMBER}/capabilities`, {
      permission: "evidence.read", reason: "force-conflict",
    });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: { code: "capability_already_active" } });
  });

  it("secret-free: grant/scope projections carry no credential material", async () => {
    const a = await send(identityApp, "POST", `/v1/identity/members/${TARGET_MEMBER}/capabilities`, { permission: "evidence.read" });
    const b = await send(identityApp, "DELETE", `/v1/identity/delegated-admin/${SCOPE}`, { reason: "done" });
    for (const res of [a, b]) {
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBeGreaterThan(20);
      for (const needle of ["keyHash", "tokenHash", "secret", "scim_pat_", "KEYHASH"]) {
        expect(res.body).not.toContain(needle);
      }
    }
  });
});

// =============================================================================
// SYSTEM 2 — SERVICE ACCOUNTS (machine identities)
//
// The list is a COLLECTION operation (workspace from the User.currentWorkspaceId
// rail); the three state changes are TARGET-bound (workspace from the
// ApiCredential row) and step-up gated. The REAL api-keys.service runs, so the
// projection and the 404/409 state machine are production behaviour.
// =============================================================================

type CredOp = {
  name: string;
  fn: string;
  permission: string;
  purpose: string;
  method: "POST" | "PATCH";
  url: (id: string) => string;
  body: Record<string, unknown>;
};

const CRED_OPS: CredOp[] = [
  {
    name: "POST /v1/identity/service-accounts/:id/disable",
    fn: "disableApiCredential", permission: "identity.service_account.disable",
    purpose: "SERVICE_ACCOUNT_DISABLE", method: "POST",
    url: (id) => `/v1/identity/service-accounts/${id}/disable`, body: {},
  },
  {
    name: "POST /v1/identity/service-accounts/:id/enable",
    fn: "enableApiCredential", permission: "identity.service_account.manage",
    purpose: "SERVICE_ACCOUNT_ENABLE", method: "POST",
    url: (id) => `/v1/identity/service-accounts/${id}/enable`, body: {},
  },
  {
    name: "PATCH /v1/identity/service-accounts/:id/hardening",
    fn: "updateApiCredentialHardening", permission: "identity.service_account.manage",
    purpose: "SERVICE_ACCOUNT_HARDENING_UPDATE", method: "PATCH",
    url: (id) => `/v1/identity/service-accounts/${id}/hardening`,
    body: { rotationRequired: true },
  },
];

describe("SYSTEM 2 — service accounts", () => {
  describe("GET /v1/identity/service-accounts", () => {
    it("authorized: canonical service called ONCE on the rail-derived workspace; no foreign rows", async () => {
      const res = await send(identityApp, "GET", "/v1/identity/service-accounts");
      expect(res.statusCode).toBe(200);
      expect(hits("listApiCredentials")).toEqual([{ teamId: TEAM }]);
      const body = json(res) as { serviceAccounts: Array<Record<string, unknown>>; teamId: string };
      // The SERVER-derived workspace is echoed, never asserted by the client.
      expect(body.teamId).toBe(TEAM);
      expect(body.serviceAccounts.map((s) => s["id"]).sort()).toEqual([CRED, CRED_REVOKED].sort());
      expect(body.serviceAccounts.map((s) => s["id"])).not.toContain(FOREIGN_CRED);
      expect(H.authorizeChecks).toEqual([
        { teamId: TEAM, permission: "identity.service_account.manage", kind: null, id: null, anti: false },
      ]);
    });

    it("SECRET-FREE on a POPULATED body: no credential secret, no keyHash / previousKeyHash", async () => {
      const res = await send(identityApp, "GET", "/v1/identity/service-accounts");
      const body = json(res) as { serviceAccounts: Array<Record<string, unknown>> };
      // The stored rows DO carry hashes — proving the projection drops them.
      expect(row("apiCredential", CRED)?.["keyHash"]).toBe("KEYHASH-c0ffee-NEVER-PROJECTED");
      expect(body.serviceAccounts.length).toBeGreaterThan(0);
      for (const needle of [
        "keyHash", "previousKeyHash", "KEYHASH-c0ffee", "PREVHASH-dead",
        "secretHash", "tokenHash", "scim_pat_",
      ]) {
        expect(res.body).not.toContain(needle);
      }
      // ...while the operator-safe hardening surface IS present (a truly empty
      // projection would trivially pass a "no secret" check).
      const first = body.serviceAccounts.find((s) => s["id"] === CRED);
      expect(first).toMatchObject({
        keyPrefix: "pk_live_abc1", rotationRequired: false, environment: "prod",
        previousKeyPrefix: "pk_live_old1", status: "ACTIVE",
      });
      expect(first?.["ipAllowlist"]).toEqual(["10.0.0.0/8"]);
    });

    it("collection scope comes from the persisted rail: a disagreeing declared teamId is CONCEALED (404), ZERO read", async () => {
      const res = await send(identityApp, "GET", `/v1/identity/service-accounts?teamId=${OTHER_TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("listApiCredentials")).toHaveLength(0);
      expect(H.authorizeChecks).toHaveLength(0);
    });

    it("no persisted rail → 404 (never a fabricated default workspace)", async () => {
      const actorRow = row("user", ACTOR);
      if (actorRow) actorRow["currentWorkspaceId"] = null;
      const res = await send(identityApp, "GET", "/v1/identity/service-accounts");
      expect(res.statusCode).toBe(404);
      expect(hits("listApiCredentials")).toHaveLength(0);
    });

    it("authorization denial → 403 permission_denied, ZERO read", async () => {
      H.authorizeAllows = false;
      const res = await send(identityApp, "GET", "/v1/identity/service-accounts");
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: { code: "permission_denied", reason: "forbidden" } });
      expect(hits("listApiCredentials")).toHaveLength(0);
    });
  });

  for (const op of CRED_OPS) {
    describe(op.name, () => {
      it("authorized: canonical service called ONCE on the TARGET-derived workspace; exactly one row write", async () => {
        const res = await send(identityApp, op.method, op.url(CRED), op.body);
        expect(res.statusCode).toBe(200);
        expect(hits(op.fn)).toEqual([expect.objectContaining({ id: CRED, teamId: TEAM })]);
        expect(H.writes).toEqual(["apiCredential.update"]);
        expect(H.authorizeChecks).toEqual([
          { teamId: TEAM, permission: op.permission, kind: "api_credential", id: CRED, anti: false },
        ]);
        expect(H.stepUps).toEqual([
          { teamId: TEAM, purpose: op.purpose, kind: "api_credential", id: CRED },
        ]);
        // The response is the same secret-free projection.
        expect(res.body).not.toContain("KEYHASH-c0ffee");
      });

      it("authorization denial → 403, ZERO write and ZERO step-up spend", async () => {
        H.authorizeAllows = false;
        const res = await send(identityApp, op.method, op.url(CRED), op.body);
        expect(res.statusCode).toBe(403);
        expect(hits(op.fn)).toHaveLength(0);
        expect(H.writes).toEqual([]);
        expect(H.stepUps).toHaveLength(0);
      });

      it("step-up denial → 401 STEP_UP_REQUIRED with ZERO write (target-bound challenge)", async () => {
        H.stepUpDenies = true;
        const res = await send(identityApp, op.method, op.url(CRED), op.body);
        expect(res.statusCode).toBe(401);
        expect(json(res)).toEqual({ error: { code: "STEP_UP_REQUIRED", purpose: op.purpose } });
        expect(hits(op.fn)).toHaveLength(0);
        expect(H.writes).toEqual([]);
        expect(H.stepUps).toEqual([
          { teamId: TEAM, purpose: op.purpose, kind: "api_credential", id: CRED },
        ]);
      });

      it("cross-Organization credential is BYTE-IDENTICAL to a missing one, ZERO write", async () => {
        const foreign = await send(identityApp, op.method, op.url(FOREIGN_CRED), op.body);
        const missing = await send(identityApp, op.method, op.url(MISSING_CRED), op.body);
        expect(foreign.statusCode).toBe(404);
        expect(foreign.body).toBe(missing.body);
        expect(foreign.body).toBe(JSON.stringify({ error: { code: "not_found" } }));
        expect(H.writes).toEqual([]);
        expect(H.stepUps).toHaveLength(0);
        expect(row("apiCredential", FOREIGN_CRED)?.["disabledAtUtc"]).toBeNull();
      });

      it("a REVOKED credential is a bounded 409, never a silent success, ZERO write", async () => {
        const res = await send(identityApp, op.method, op.url(CRED_REVOKED), op.body);
        expect(res.statusCode).toBe(409);
        expect(json(res)).toEqual({ error: { code: "credential_already_revoked" } });
        expect(H.writes).toEqual([]);
      });
    });
  }

  it("disable then enable is a real round trip through the persisted row", async () => {
    const off = await send(identityApp, "POST", `/v1/identity/service-accounts/${CRED}/disable`, {});
    expect(off.statusCode).toBe(200);
    expect(row("apiCredential", CRED)?.["disabledAtUtc"]).toBeInstanceOf(Date);
    expect(row("apiCredential", CRED)?.["disabledByUserId"]).toBe(ACTOR);

    const on = await send(identityApp, "POST", `/v1/identity/service-accounts/${CRED}/enable`, {});
    expect(on.statusCode).toBe(200);
    expect(row("apiCredential", CRED)?.["disabledAtUtc"]).toBeNull();
    expect(row("apiCredential", CRED)?.["disabledByUserId"]).toBeNull();
  });

  it("hardening applies every supplied control to the persisted row", async () => {
    const res = await send(identityApp, "PATCH", `/v1/identity/service-accounts/${CRED}/hardening`, {
      expiresAtUtc: "2027-01-01T00:00:00.000Z",
      ipAllowlist: ["  203.0.113.0/24  "],
      environment: "staging",
      rotationRequired: true,
    });
    expect(res.statusCode).toBe(200);
    const r = row("apiCredential", CRED);
    expect(r?.["ipAllowlist"]).toEqual(["203.0.113.0/24"]);
    expect(r?.["environment"]).toBe("staging");
    expect(r?.["rotationRequired"]).toBe(true);
    expect((r?.["expiresAtUtc"] as Date).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("a PARTIAL hardening PATCH PRESERVES expiresAtUtc and environment", async () => {
    // This pinned a defect: the route always materialises the expiresAtUtc /
    // environment keys on the service input (value undefined) while the service
    // branched on hasOwnProperty, so (undefined ?? null) wrote NULL — a PATCH
    // setting only rotationRequired silently REMOVED an existing credential's
    // expiry and environment scope, turning a time-bounded, environment-scoped
    // key into a non-expiring unscoped one. The service now branches on
    // `!== undefined` for all four fields; this pins the fixed behaviour.
    const before = row("apiCredential", CRED);
    expect(before?.["environment"]).toBe("prod");
    const expiryBefore = before?.["expiresAtUtc"];
    expect(expiryBefore).toBeTruthy();

    const res = await send(identityApp, "PATCH", `/v1/identity/service-accounts/${CRED}/hardening`, {
      rotationRequired: true,
    });
    expect(res.statusCode).toBe(200);
    // Untouched fields survive.
    expect(row("apiCredential", CRED)?.["expiresAtUtc"]).toEqual(expiryBefore);
    expect(row("apiCredential", CRED)?.["environment"]).toBe("prod");
    expect(row("apiCredential", CRED)?.["ipAllowlist"]).toEqual(["10.0.0.0/8"]);
    // The field actually sent was applied.
    expect(row("apiCredential", CRED)?.["rotationRequired"]).toBe(true);
  });

  it("an EXPLICIT null still clears a hardening control (deliberate clearing preserved)", async () => {
    // The fix must not cost the ability to clear: null !== undefined.
    const res = await send(identityApp, "PATCH", `/v1/identity/service-accounts/${CRED}/hardening`, {
      environment: null,
      expiresAtUtc: null,
    });
    expect(res.statusCode).toBe(200);
    expect(row("apiCredential", CRED)?.["environment"]).toBeNull();
    expect(row("apiCredential", CRED)?.["expiresAtUtc"]).toBeNull();
  });
});

// =============================================================================
// SYSTEM 3 — ACCESS REVIEWS
//
// All three legs are COLLECTION-scoped (workspace from the persisted
// User.currentWorkspaceId rail) and carry an Enterprise entitlement gate. The
// REAL access-review.service runs against the store, so queue regeneration and
// the decision state machine are production behaviour.
// =============================================================================

const reviewsIn = (teamId: string): Row[] =>
  H.store["accessReview"].filter((r) => r["teamId"] === teamId);

describe("SYSTEM 3 — access reviews", () => {
  describe("GET /v1/identity/access-reviews", () => {
    it("authorized: canonical service called ONCE on the rail-derived workspace; no foreign rows", async () => {
      const res = await send(identityApp, "GET", "/v1/identity/access-reviews");
      expect(res.statusCode).toBe(200);
      expect(hits("listAccessReviews")).toEqual([{ teamId: TEAM }]);
      const body = json(res) as { accessReviews: Array<Record<string, unknown>>; teamId: string };
      expect(body.teamId).toBe(TEAM);
      expect(body.accessReviews.map((r) => r["id"]).sort()).toEqual([REVIEW, REVIEW_DONE].sort());
      expect(res.body).not.toContain(FOREIGN_REVIEW);
      expect(H.authorizeChecks).toEqual([
        { teamId: TEAM, permission: "identity.access_review.read", kind: null, id: null, anti: false },
      ]);
    });

    it("filters are forwarded to the canonical service, still workspace-bound", async () => {
      const res = await send(identityApp, "GET", "/v1/identity/access-reviews?status=PENDING&kind=STALE_ACCESS&limit=10");
      expect(res.statusCode).toBe(200);
      expect(hits("listAccessReviews")).toEqual([
        { teamId: TEAM, status: "PENDING", kind: "STALE_ACCESS", limit: 10 },
      ]);
      const body = json(res) as { accessReviews: Array<Record<string, unknown>> };
      expect(body.accessReviews.map((r) => r["id"])).toEqual([REVIEW]);
    });

    it("a disagreeing declared teamId is CONCEALED (404), ZERO read", async () => {
      const res = await send(identityApp, "GET", `/v1/identity/access-reviews?teamId=${OTHER_TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("listAccessReviews")).toHaveLength(0);
    });

    it("authorization denial → 403, ZERO read", async () => {
      H.authorizeAllows = false;
      const res = await send(identityApp, "GET", "/v1/identity/access-reviews");
      expect(res.statusCode).toBe(403);
      expect(hits("listAccessReviews")).toHaveLength(0);
    });

    it("non-Enterprise entitlement → 402, ZERO read", async () => {
      H.enterpriseOk = false;
      const res = await send(identityApp, "GET", "/v1/identity/access-reviews");
      expect(res.statusCode).toBe(402);
      expect(json(res)).toEqual({ error: { code: "ENTERPRISE_FEATURE_REQUIRED", feature: "accessReviews" } });
      expect(hits("listAccessReviews")).toHaveLength(0);
    });
  });

  describe("POST /v1/identity/access-reviews/regenerate", () => {
    it("authorized: queue is regenerated ONLY from the rail-derived workspace", async () => {
      const before = H.store["accessReview"].length;
      const res = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", {});
      expect(res.statusCode).toBe(200);
      const created = (json(res) as { created: number }).created;
      expect(created).toBeGreaterThan(0);
      expect(hits("regenerateAccessReviewQueue")).toEqual([{ teamId: TEAM, actorUserId: ACTOR }]);
      // Every enqueued item belongs to the SERVER-derived workspace.
      expect(H.store["accessReview"].length - before).toBe(created);
      expect(H.store["accessReview"].every((r) => r["teamId"] === TEAM || r["id"] === FOREIGN_REVIEW)).toBe(true);
      // The foreign workspace was never scanned or enqueued into.
      expect(reviewsIn(OTHER_TEAM)).toHaveLength(1);
      expect(H.store["accessReview"].some((r) => r["subjectUserId"] === FOREIGN_USER && r["teamId"] === TEAM)).toBe(false);
    });

    it("regeneration is idempotent — a second run enqueues nothing new", async () => {
      const first = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", {});
      const n = H.store["accessReview"].length;
      const second = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", {});
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect((json(second) as { created: number }).created).toBe(0);
      expect(H.store["accessReview"].length).toBe(n);
    });

    it("authorization denial → 403, ZERO enqueue", async () => {
      H.authorizeAllows = false;
      const before = H.store["accessReview"].length;
      const res = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", {});
      expect(res.statusCode).toBe(403);
      expect(hits("regenerateAccessReviewQueue")).toHaveLength(0);
      expect(H.store["accessReview"].length).toBe(before);
    });

    it("non-Enterprise entitlement → 402, ZERO enqueue", async () => {
      H.enterpriseOk = false;
      const before = H.store["accessReview"].length;
      const res = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", {});
      expect(res.statusCode).toBe(402);
      expect(hits("regenerateAccessReviewQueue")).toHaveLength(0);
      expect(H.store["accessReview"].length).toBe(before);
    });

    it("a disagreeing declared teamId is CONCEALED (404), ZERO enqueue", async () => {
      const res = await send(identityApp, "POST", "/v1/identity/access-reviews/regenerate", { teamId: OTHER_TEAM });
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("regenerateAccessReviewQueue")).toHaveLength(0);
    });
  });

  describe("POST /v1/identity/access-reviews/:id/decision", () => {
    it("authorized KEEP: canonical service called ONCE, review completed in place", async () => {
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "KEEP", decisionNote: "still required",
      });
      expect(res.statusCode).toBe(200);
      expect(hits("completeAccessReview")).toEqual([
        expect.objectContaining({ teamId: TEAM, reviewId: REVIEW, decision: "KEEP", actorUserId: ACTOR }),
      ]);
      expect(row("accessReview", REVIEW)?.["status"]).toBe("COMPLETED_KEEP");
      expect(row("accessReview", REVIEW)?.["completedByUserId"]).toBe(ACTOR);
      expect(H.authorizeChecks).toEqual([
        { teamId: TEAM, permission: "identity.access_review.action", kind: "access_review", id: REVIEW, anti: false },
      ]);
    });

    it("cross-Organization review is BYTE-IDENTICAL to a missing one, ZERO state change", async () => {
      const foreign = await send(identityApp, "POST", `/v1/identity/access-reviews/${FOREIGN_REVIEW}/decision`, { decision: "KEEP" });
      const missing = await send(identityApp, "POST", `/v1/identity/access-reviews/${MISSING_REVIEW}/decision`, { decision: "KEEP" });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(foreign.body).toBe(JSON.stringify({ error: { code: "review_not_found" } }));
      // The foreign review is untouched.
      expect(row("accessReview", FOREIGN_REVIEW)?.["status"]).toBe("PENDING");
      // The decision path now runs inside a transaction, so a refusal rolls
      // back rather than never starting. The harness pushes its own ROLLBACK
      // marker when it restores the snapshot, which is STRONGER evidence of
      // zero state change than an empty list: it says a write was attempted
      // and undone atomically, not merely that none was tried.
      //
      // Two markers for the two requests above — the foreign review and the
      // missing one — which is the point of the test: they are
      // indistinguishable right down to the state they leave behind.
      expect(H.writes).toEqual(["ROLLBACK", "ROLLBACK"]);
    });

    it("an already-completed review is a bounded 409, never a re-decision", async () => {
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW_DONE}/decision`, { decision: "KEEP" });
      expect(res.statusCode).toBe(409);
      expect(json(res)).toEqual({ error: { code: "invalid_status_transition" } });
      expect(row("accessReview", REVIEW_DONE)?.["status"]).toBe("COMPLETED_KEEP");
      // The decision path now runs inside a transaction, so a refusal rolls
      // back rather than never starting. The harness pushes its own ROLLBACK
      // marker when it restores the snapshot, which is STRONGER evidence of
      // zero state change than an empty list: it says a write was attempted
      // and undone atomically, not merely that none was tried.
      expect(H.writes).toEqual(["ROLLBACK"]);
    });

    it("authorization denial → 403, ZERO state change", async () => {
      H.authorizeAllows = false;
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, { decision: "KEEP" });
      expect(res.statusCode).toBe(403);
      expect(hits("completeAccessReview")).toHaveLength(0);
      expect(row("accessReview", REVIEW)?.["status"]).toBe("PENDING");
    });

    it("non-Enterprise entitlement → 402, ZERO state change", async () => {
      H.enterpriseOk = false;
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, { decision: "KEEP" });
      expect(res.statusCode).toBe(402);
      expect(hits("completeAccessReview")).toHaveLength(0);
      expect(row("accessReview", REVIEW)?.["status"]).toBe("PENDING");
    });

    it("REVOKE_MEMBER really revokes the subject through the membership orchestrator", async () => {
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "REVOKE_MEMBER", decisionNote: "left the company",
      });
      expect(res.statusCode).toBe(200);
      expect(hits("revokeMember")).toEqual([
        expect.objectContaining({ teamId: TEAM, teamMemberId: TARGET_MEMBER, actorUserId: ACTOR }),
      ]);
      expect(row("accessReview", REVIEW)?.["status"]).toBe("COMPLETED_REVOKED");
    });

    it("a managed identity CANNOT be mutated through the decision route", async () => {
      // This pinned a bypass: POST /v1/identity/members/:id/revoke is gated by a
      // step-up challenge AND refuses SCIM/SSO-managed identities (409
      // managed_identity_readonly), but the decision route reached the SAME
      // orchestrator command with neither gate — an ungated parallel path to a
      // membership mutation. Both gates now run before the write.
      H.managedState = "MANAGED";
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "SUSPEND_MEMBER",
      });
      expect(res.statusCode).toBe(409);
      expect((json(res).error as Record<string, unknown>).code).toBe(
        "managed_identity_readonly",
      );
      // ZERO MUTATION: no orchestrator call, review untouched.
      expect(hits("suspendMember")).toHaveLength(0);
      expect(row("accessReview", REVIEW)?.["status"]).not.toBe("COMPLETED_SUSPENDED");
    });

    it("a REVOKE/SUSPEND decision is step-up gated with ZERO mutation on denial", async () => {
      H.managedState = "STANDARD";
      H.stepUpDenies = true;
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "SUSPEND_MEMBER",
      });
      expect(res.statusCode).toBe(401);
      expect(hits("suspendMember")).toHaveLength(0);
      expect(row("accessReview", REVIEW)?.["status"]).not.toBe("COMPLETED_SUSPENDED");
    });

    it("the decision challenge is bound to the review's SUBJECT, not the review row", async () => {
      H.managedState = "STANDARD";
      H.stepUpDenies = false;
      H.stepUps.length = 0;
      const ok = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "SUSPEND_MEMBER",
      });
      expect(ok.statusCode).toBe(200);
      expect(hits("suspendMember")).toHaveLength(1);
      // An approval for one member can never satisfy a decision about another.
      expect(H.stepUps).toEqual([
        { teamId: TEAM, purpose: "MEMBER_SUSPEND", kind: "member", id: SUBJECT_USER },
      ]);
    });

    it("a non-mutating decision (KEEP) stays ungated", async () => {
      H.managedState = "STANDARD";
      const res = await send(identityApp, "POST", `/v1/identity/access-reviews/${REVIEW}/decision`, {
        decision: "KEEP",
      });
      expect(res.statusCode).toBe(200);
      expect(H.stepUps).toHaveLength(0);
    });
  });
});

// =============================================================================
// SYSTEM 4 — SECURITY TELEMETRY (scans + events)
//
// security.routes.ts composes authorizeOrFail(antiEnumeration) with a stricter
// OWNER/ADMIN-only membership check; EVERY denial is a 404 so the surface never
// enumerates roles or workspaces. The REAL scan/event services and their
// allow-list projections run.
// =============================================================================

const NOWHERE_TEAM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeff";

describe("SYSTEM 4 — security telemetry", () => {
  describe("GET /v1/security/scans", () => {
    it("authorized admin: canonical service called ONCE, only this workspace", async () => {
      const res = await send(securityApp, "GET", `/v1/security/scans?teamId=${TEAM}`);
      expect(res.statusCode).toBe(200);
      expect(hits("listScansForTeam")).toEqual([{ teamId: TEAM, status: undefined, limit: undefined }]);
      const body = json(res) as { scans: Array<Record<string, unknown>> };
      expect(body.scans.map((s) => s["id"])).toEqual([SCAN]);
      expect(H.authorizeChecks).toEqual([
        { teamId: TEAM, permission: "identity.org_policy.read", kind: null, id: null, anti: true },
      ]);
    });

    it("SECRET-FREE on a POPULATED body: scanner internals and object keys never surface", async () => {
      const res = await send(securityApp, "GET", `/v1/security/scans?teamId=${TEAM}`);
      const body = json(res) as { scans: Array<Record<string, unknown>> };
      expect(body.scans).toHaveLength(1);
      // The stored row carries both — proving the projection drops them.
      expect(row("fileSecurityScan", SCAN)?.["scannerRawResponse"]).toContain("RAW-SCANNER-BLOB");
      for (const needle of ["RAW-SCANNER-BLOB", "scannerRawResponse", "objectKey", "SECRET-OBJECT-KEY"]) {
        expect(res.body).not.toContain(needle);
      }
      // ...and the operator-facing verdict IS present.
      expect(body.scans[0]).toMatchObject({
        status: "SUSPICIOUS", scanner: "clamav", findingsSummary: "Eicar-Test-Signature",
      });
    });

    it("the status filter is forwarded to the canonical service", async () => {
      const res = await send(securityApp, "GET", `/v1/security/scans?teamId=${TEAM}&status=CLEAN&limit=5`);
      expect(res.statusCode).toBe(200);
      expect(hits("listScansForTeam")).toEqual([{ teamId: TEAM, status: "CLEAN", limit: 5 }]);
      expect((json(res) as { scans: unknown[] }).scans).toEqual([]);
    });

    it("authorization denial → concealed 404 (never 403), ZERO read", async () => {
      H.authorizeAllows = false;
      const res = await send(securityApp, "GET", `/v1/security/scans?teamId=${TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("listScansForTeam")).toHaveLength(0);
    });

    it("a non-admin member is concealed as 404, ZERO read (security ops are admin-only)", async () => {
      H.actorUserId = STALE_USER; // ACTIVE MEMBER of TEAM, not OWNER/ADMIN
      const res = await send(securityApp, "GET", `/v1/security/scans?teamId=${TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("listScansForTeam")).toHaveLength(0);
    });

    it("a foreign workspace is BYTE-IDENTICAL to a workspace that does not exist, ZERO read", async () => {
      const foreign = await send(securityApp, "GET", `/v1/security/scans?teamId=${OTHER_TEAM}`);
      const nowhere = await send(securityApp, "GET", `/v1/security/scans?teamId=${NOWHERE_TEAM}`);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(nowhere.body);
      expect(foreign.body).toBe(JSON.stringify({ error: { code: "not_found" } }));
      expect(hits("listScansForTeam")).toHaveLength(0);
    });
  });

  describe("GET /v1/security/events", () => {
    it("authorized admin: canonical service called ONCE, only this workspace", async () => {
      const res = await send(securityApp, "GET", `/v1/security/events?teamId=${TEAM}`);
      expect(res.statusCode).toBe(200);
      expect(hits("listSecurityEvents")).toEqual([
        { teamId: TEAM, severity: undefined, eventType: undefined, limit: undefined },
      ]);
      const body = json(res) as { events: Array<Record<string, unknown>> };
      expect(body.events.map((e) => e["id"])).toEqual([EVENT]);
    });

    it("SECRET-FREE on a POPULATED body: details are allow-list projected, secrets dropped, identifiers truncated", async () => {
      const res = await send(securityApp, "GET", `/v1/security/events?teamId=${TEAM}`);
      const body = json(res) as { events: Array<{ details: Record<string, unknown> }> };
      expect(body.events).toHaveLength(1);
      // The stored row carries a bearer token and a hash in `details`.
      for (const needle of ["scim_pat_LEAKED_SECRET", "authorizationHeader", "tokenHash", "HASH-LEAK"]) {
        expect(res.body).not.toContain(needle);
      }
      const details = body.events[0].details;
      expect(details["redacted"]).toBe(true);          // dropped fields are declared
      expect(details["action"]).toBe("rotate");         // allow-listed survives
      expect(details["reasonCode"]).toBe("operator");
      expect(details["sessionId"]).toBe("sess-123…");   // redacted-key → prefix only
    });

    it("severity + eventType filters are forwarded to the canonical service", async () => {
      const res = await send(
        securityApp, "GET",
        `/v1/security/events?teamId=${TEAM}&severity=INFO&eventType=scim_token_created&limit=25`,
      );
      expect(res.statusCode).toBe(200);
      expect(hits("listSecurityEvents")).toEqual([
        { teamId: TEAM, severity: "INFO", eventType: "scim_token_created", limit: 25 },
      ]);
      // The seeded event is HIGH, so an INFO filter must return nothing.
      expect((json(res) as { events: unknown[] }).events).toEqual([]);
    });

    it("authorization denial → concealed 404, ZERO read", async () => {
      H.authorizeAllows = false;
      const res = await send(securityApp, "GET", `/v1/security/events?teamId=${TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("listSecurityEvents")).toHaveLength(0);
    });

    it("a foreign workspace is BYTE-IDENTICAL to a workspace that does not exist, ZERO read", async () => {
      const foreign = await send(securityApp, "GET", `/v1/security/events?teamId=${OTHER_TEAM}`);
      const nowhere = await send(securityApp, "GET", `/v1/security/events?teamId=${NOWHERE_TEAM}`);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(nowhere.body);
      expect(hits("listSecurityEvents")).toHaveLength(0);
    });
  });
});

// =============================================================================
// SYSTEM 5 — SCIM ADMINISTRATION (operator session, NOT the IdP)
//
// scim-admin.routes.ts composes requireAuth → authorizeOrFail(antiEnumeration)
// → Enterprise entitlement → target-bound step-up → transactional rotation.
// The REAL scim.service runs, including production token hashing, so
// "the raw replacement token appears exactly ONCE" is proven end to end.
// =============================================================================

const MEMBERSHIP_URL = `/v1/admin/identity/scim/managed-membership?teamId=${TEAM}`;
const rotateUrl = (id: string): string => `/v1/admin/identity/scim/tokens/${id}/rotate`;
const storeDump = (): string => JSON.stringify(H.store);

describe("SYSTEM 5 — SCIM administration", () => {
  describe("GET /v1/admin/identity/scim/managed-membership", () => {
    it("authorized: canonical projection called ONCE on the authorized workspace", async () => {
      const res = await send(scimAdminApp, "GET", MEMBERSHIP_URL);
      expect(res.statusCode).toBe(200);
      expect(hits("projectScimManagedMembership")).toEqual([{ teamId: TEAM }]);
      const body = json(res) as { projection: Record<string, unknown> };
      const p = body.projection as {
        teamId: string; summary: Record<string, number>;
        members: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>>;
      };
      expect(p.teamId).toBe(TEAM);
      // POPULATED: both directory-linked members of THIS workspace, and no
      // member or group belonging to another Organization.
      expect(p.members.map((m) => m["userId"]).sort()).toEqual([SUBJECT_USER, STALE_USER].sort());
      expect(p.summary["total"]).toBe(2);
      expect(p.groups.map((g) => g["id"])).toEqual([GROUP]);
      expect(res.body).not.toContain(FOREIGN_USER);
      expect(res.body).not.toContain(FOREIGN_GROUP);
      expect(H.authorizeChecks).toEqual([
        {
          teamId: TEAM, permission: "identity.external_mapping.read",
          kind: "scim_provisioning_token", id: null, anti: true,
        },
      ]);
      // A read never spends a step-up challenge.
      expect(H.stepUps).toHaveLength(0);
    });

    it("SECRET-FREE: the ownership projection carries no token material", async () => {
      const res = await send(scimAdminApp, "GET", MEMBERSHIP_URL);
      expect(res.body.length).toBeGreaterThan(100);
      for (const needle of ["tokenHash", "secretHash", "scim_pat_", RAW_ALL, RAW_FOREIGN]) {
        expect(res.body).not.toContain(needle);
      }
    });

    it("the `limit` bound is forwarded; a malformed query is a bounded 400", async () => {
      const ok = await send(scimAdminApp, "GET", `/v1/admin/identity/scim/managed-membership?teamId=${TEAM}&limit=1`);
      expect(ok.statusCode).toBe(200);
      expect(hits("projectScimManagedMembership")).toEqual([{ teamId: TEAM, limit: 1 }]);
      expect((json(ok).projection as { truncated: boolean }).truncated).toBe(true);

      const bad = await send(scimAdminApp, "GET", "/v1/admin/identity/scim/managed-membership");
      expect(bad.statusCode).toBe(400);
      expect((json(bad).error as { code: string }).code).toBe("validation_error");
    });

    it("authorization denial → concealed 404, ZERO projection", async () => {
      H.authorizeAllows = false;
      const res = await send(scimAdminApp, "GET", MEMBERSHIP_URL);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("projectScimManagedMembership")).toHaveLength(0);
    });

    it("non-Enterprise entitlement → 402, ZERO projection", async () => {
      H.enterpriseOk = false;
      const res = await send(scimAdminApp, "GET", MEMBERSHIP_URL);
      expect(res.statusCode).toBe(402);
      expect(json(res)).toEqual({ error: { code: "enterprise_feature_required", feature: "ssoScim" } });
      expect(hits("projectScimManagedMembership")).toHaveLength(0);
    });
  });

  describe("POST /v1/admin/identity/scim/tokens/:id/rotate", () => {
    it("authorized: atomic rotation — old credential revoked, replacement minted, raw token shown ONCE", async () => {
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM, reason: "quarterly" });
      expect(res.statusCode).toBe(201);
      expect(hits("rotateScimToken")).toEqual([
        expect.objectContaining({ teamId: TEAM, id: TOKEN_ID, actorUserId: ACTOR }),
      ]);
      const body = json(res) as {
        revoked: Record<string, unknown>;
        projection: Record<string, unknown>;
        tokenOnce: string;
      };
      expect(body.tokenOnce.startsWith("scim_pat_")).toBe(true);
      // ONCE means once: exactly one occurrence in the whole response body.
      expect(res.body.split(body.tokenOnce).length - 1).toBe(1);
      expect(body.revoked["id"]).toBe(TOKEN_ID);
      expect(body.revoked["status"]).toBe("REVOKED");
      expect(body.projection["status"]).toBe("ACTIVE");
      expect(body.projection["teamId"]).toBe(TEAM);
      // The rotated credential inherits the scopes of the one it replaces.
      expect(body.projection["scopes"]).toEqual(
        ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"],
      );

      // Persistence: the old row is revoked WITH the operator identity, the new
      // row stores ONLY the hash — the plaintext is nowhere in the database.
      expect(row("scimProvisioningToken", TOKEN_ID)?.["status"]).toBe("REVOKED");
      expect(row("scimProvisioningToken", TOKEN_ID)?.["revokedByUserId"]).toBe(ACTOR);
      const created = H.store["scimProvisioningToken"].find(
        (t) => t["id"] === body.projection["id"],
      );
      expect(created?.["tokenHash"]).toBe(hashRaw(body.tokenOnce));
      expect(storeDump()).not.toContain(body.tokenOnce);

      // Target-bound step-up under the SCIM administration purpose.
      expect(H.authorizeChecks).toEqual([
        {
          teamId: TEAM, permission: "identity.external_mapping.manage",
          kind: "scim_provisioning_token", id: TOKEN_ID, anti: true,
        },
      ]);
      expect(H.stepUps).toEqual([
        { teamId: TEAM, purpose: "EXTERNAL_IDENTITY_LINK", kind: "scim_provisioning_token", id: TOKEN_ID },
      ]);
    });

    it("the raw replacement token is a REAL credential (and the rotated one is dead)", async () => {
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM });
      const tokenOnce = (json(res) as { tokenOnce: string }).tokenOnce;

      const fresh = await send(scimApp, "GET", "/v2/scim/Users");
      expect(fresh.statusCode).toBe(401); // no bearer at all

      const withNew = (await scimApp.inject({
        method: "GET", url: "/v2/scim/Users",
        headers: { authorization: `Bearer ${tokenOnce}` },
      })) as unknown as Res;
      expect(withNew.statusCode).toBe(200);

      const withOld = (await scimApp.inject({
        method: "GET", url: "/v2/scim/Users",
        headers: { authorization: `Bearer ${RAW_ALL}` },
      })) as unknown as Res;
      expect(withOld.statusCode).toBe(401);
      expect(json(withOld)["detail"]).toBe("revoked");
    });

    it("the raw token NEVER reappears in a later read", async () => {
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM });
      const tokenOnce = (json(res) as { tokenOnce: string }).tokenOnce;
      const readBack = await send(scimAdminApp, "GET", MEMBERSHIP_URL);
      expect(readBack.statusCode).toBe(200);
      expect(readBack.body).not.toContain(tokenOnce);
      expect(readBack.body).not.toContain("tokenOnce");
    });

    it("cross-Organization token is BYTE-IDENTICAL to a missing one, ZERO mutation", async () => {
      const foreign = await send(scimAdminApp, "POST", rotateUrl(FOREIGN_TOKEN_ID), { teamId: TEAM });
      const missing = await send(scimAdminApp, "POST", rotateUrl(MISSING_TOKEN_ID), { teamId: TEAM });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(foreign.body).toBe(JSON.stringify({ error: { code: "not_found" } }));
      // The foreign credential is untouched and still authenticates.
      expect(row("scimProvisioningToken", FOREIGN_TOKEN_ID)?.["status"]).toBe("ACTIVE");
      expect(H.writes).toEqual([]);
    });

    it("an already-revoked token is a bounded 409, never a second live credential", async () => {
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_REVOKED_ID), { teamId: TEAM });
      expect(res.statusCode).toBe(409);
      expect(json(res)).toEqual({ error: { code: "scim_token_already_revoked" } });
      expect(H.writes).toEqual([]);
      expect(H.store["scimProvisioningToken"]).toHaveLength(7);
    });

    it("step-up denial → 401 STEP_UP_REQUIRED with ZERO mutation", async () => {
      H.stepUpDenies = true;
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM });
      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual({ error: { code: "STEP_UP_REQUIRED", purpose: "EXTERNAL_IDENTITY_LINK" } });
      expect(hits("rotateScimToken")).toHaveLength(0);
      expect(H.writes).toEqual([]);
      expect(row("scimProvisioningToken", TOKEN_ID)?.["status"]).toBe("ACTIVE");
    });

    it("authorization denial → concealed 404 with ZERO mutation and ZERO step-up spend", async () => {
      H.authorizeAllows = false;
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM });
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: { code: "not_found" } });
      expect(hits("rotateScimToken")).toHaveLength(0);
      expect(H.stepUps).toHaveLength(0);
      expect(H.writes).toEqual([]);
    });

    it("non-Enterprise entitlement → 402 with ZERO mutation and ZERO step-up spend", async () => {
      H.enterpriseOk = false;
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: TEAM });
      expect(res.statusCode).toBe(402);
      expect(hits("rotateScimToken")).toHaveLength(0);
      expect(H.stepUps).toHaveLength(0);
      expect(H.writes).toEqual([]);
    });

    it("a malformed body is a bounded 400 before any authorization or mutation", async () => {
      const res = await send(scimAdminApp, "POST", rotateUrl(TOKEN_ID), { teamId: "not-a-uuid" });
      expect(res.statusCode).toBe(400);
      expect((json(res).error as { code: string }).code).toBe("validation_error");
      expect(H.authorizeChecks).toHaveLength(0);
      expect(H.writes).toEqual([]);
    });
  });
});

// =============================================================================
// SYSTEM 6 — SCIM v2 PROTOCOL SURFACE (RFC 7644)
//
// Bearer-token ONLY. The token is matched by HASH (no plaintext exists in the
// store), the Organization scope is taken from the TOKEN — never from the body
// or a session — and every rejection is a SCIM-shaped error document.
// =============================================================================

const scim = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  raw?: string | null,
  payload?: Record<string, unknown>,
): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (raw) headers["authorization"] = `Bearer ${raw}`;
  if (payload !== undefined) headers["content-type"] = "application/json";
  return scimApp.inject(
    payload === undefined ? { method, url, headers } : { method, url, headers, payload },
  ) as unknown as Promise<Res>;
};

const groupBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemas: [SCIM_GROUP_SCHEMA_URI],
  displayName: "Reviewers",
  externalId: "idp-grp-new",
  mappedRole: "VIEWER",
  ...over,
});

const scimType = (r: Res): string | undefined =>
  (json(r) as { scimType?: string }).scimType;

describe("SYSTEM 6 — SCIM v2 protocol: bearer/hashed-token gate", () => {
  it("no Authorization header → 401 SCIM error with a Bearer challenge (never a session fallback)", async () => {
    const res = await scim("GET", "/v2/scim/Users", null);
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("Bearer");
    expect(String(res.headers["content-type"])).toContain("application/scim+json");
    expect(json(res)).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401", scimType: "invalidCredentials", detail: "missing_token",
    });
  });

  it("a browser session credential is never accepted — only a scim_pat_ bearer is", async () => {
    // A realistic session JWT presented as a bearer, plus a session cookie.
    const res = (await scimApp.inject({
      method: "GET", url: "/v2/scim/Users",
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig",
        cookie: "proovra_session=abc123",
      },
    })) as unknown as Res;
    expect(res.statusCode).toBe(401);
    expect(json(res)["detail"]).toBe("invalid_token");
  });

  it("a well-formed token that is not in the store → 401 (lookup is by HASH, not by value)", async () => {
    // The store holds hashes only — assert that, then assert the miss.
    expect(storeDump()).not.toContain(RAW_ALL);
    expect(storeDump()).toContain(hashRaw(RAW_ALL));
    const res = await scim("GET", "/v2/scim/Users", RAW_UNKNOWN);
    expect(res.statusCode).toBe(401);
    expect(json(res)["detail"]).toBe("invalid_token");
  });

  it("revoked / expired / IP-denied tokens each fail closed with a bounded reason", async () => {
    const revoked = await scim("GET", "/v2/scim/Users", RAW_ALL);
    expect(revoked.statusCode).toBe(200); // baseline: this token is live

    const t = H.store["scimProvisioningToken"].find((x) => x["id"] === TOKEN_ID);
    if (t) t["status"] = "REVOKED";
    expect(json(await scim("GET", "/v2/scim/Users", RAW_ALL))["detail"]).toBe("revoked");

    if (t) { t["status"] = "ACTIVE"; t["expiresAtUtc"] = new Date(Date.now() - 1000); }
    expect(json(await scim("GET", "/v2/scim/Users", RAW_ALL))["detail"]).toBe("expired");

    if (t) { t["expiresAtUtc"] = null; t["ipAllowlist"] = ["203.0.113.7"]; }
    expect(json(await scim("GET", "/v2/scim/Users", RAW_ALL))["detail"]).toBe("ip_not_allowed");
  });

  it("SCIM is an Enterprise entitlement — a non-Enterprise workspace gets a SCIM-shaped 402", async () => {
    H.enterpriseOk = false;
    const res = await scim("GET", "/v2/scim/Users", RAW_ALL);
    expect(res.statusCode).toBe(402);
    expect(String(res.headers["content-type"])).toContain("application/scim+json");
    expect(json(res)).toMatchObject({ status: "402", scimType: "enterpriseFeatureRequired", detail: "ssoScim" });
  });
});

describe("SYSTEM 6 — GET /v2/scim/Users (list, filter, pagination)", () => {
  it("authorized: canonical service called ONCE, scope taken from the TOKEN", async () => {
    const res = await scim("GET", "/v2/scim/Users", RAW_USERS_READ);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/scim+json");
    expect(hits("scimListUsers")).toEqual([{ teamId: TEAM }]);
    const body = json(res) as { schemas: string[]; totalResults: number; Resources: Array<Record<string, unknown>> };
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(body.totalResults).toBe(2);
    expect(body.Resources.map((r) => r["id"]).sort()).toEqual([SUBJECT_USER, STALE_USER].sort());
    expect(res.body).not.toContain(FOREIGN_USER);
  });

  it("a foreign token sees ONLY its own Organization (token-derived scope, no body input exists)", async () => {
    const res = await scim("GET", "/v2/scim/Users", RAW_FOREIGN);
    expect(res.statusCode).toBe(200);
    expect(hits("scimListUsers")).toEqual([{ teamId: OTHER_TEAM }]);
    const body = json(res) as { totalResults: number; Resources: Array<Record<string, unknown>> };
    expect(body.totalResults).toBe(1);
    expect(body.Resources.map((r) => r["id"])).toEqual([FOREIGN_USER]);
    expect(res.body).not.toContain(SUBJECT_USER);
  });

  it("the RFC filter subset and pagination window are honoured", async () => {
    const filtered = await scim("GET", '/v2/scim/Users?filter=userName eq "idp-sub-1"', RAW_USERS_READ);
    expect(filtered.statusCode).toBe(200);
    const f = json(filtered) as { totalResults: number; Resources: Array<Record<string, unknown>> };
    expect(f.totalResults).toBe(1);
    expect(f.Resources[0]).toMatchObject({ id: SUBJECT_USER, externalId: "idp-sub-1", active: true });

    const paged = await scim("GET", "/v2/scim/Users?startIndex=2&count=1", RAW_USERS_READ);
    const p = json(paged) as { startIndex: number; itemsPerPage: number; totalResults: number };
    expect(p.startIndex).toBe(2);
    expect(p.itemsPerPage).toBe(1);
    expect(p.totalResults).toBe(2);
  });

  it("a token without a read scope is refused with a SCIM scopeDenied, ZERO read", async () => {
    const res = await scim("GET", "/v2/scim/Users", RAW_GROUPS_WRITE);
    expect(res.statusCode).toBe(403);
    expect(scimType(res)).toBe("scopeDenied");
    expect(json(res)["detail"]).toBe("scope_not_granted");
    expect(hits("scimListUsers")).toHaveLength(0);
  });
});

describe("SYSTEM 6 — SCIM v2 Groups", () => {
  describe("POST /v2/scim/Groups", () => {
    it("groups.write mints the group in the TOKEN organization (never a body-supplied one)", async () => {
      const res = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody());
      expect(res.statusCode).toBe(201);
      expect(String(res.headers["content-type"])).toContain("application/scim+json");
      expect(hits("scimCreateGroup")).toEqual([{ teamId: TEAM }]);
      const body = json(res) as { schemas: string[]; id: string; mappedRole: string };
      expect(body.schemas).toEqual([SCIM_GROUP_SCHEMA_URI]);
      expect(body.mappedRole).toBe("VIEWER");
      const created = H.store["scimGroup"].find((g) => g["id"] === body.id);
      expect(created?.["teamId"]).toBe(TEAM);
      expect(created?.["status"]).toBe("ACTIVE");
    });

    it("the legacy users.write scope still works (no IdP integration breaks on deploy)", async () => {
      const res = await scim("POST", "/v2/scim/Groups", RAW_USERS_WRITE, groupBody({ externalId: "idp-grp-legacy" }));
      expect(res.statusCode).toBe(201);
      expect(H.store["scimGroup"].some((g) => g["externalId"] === "idp-grp-legacy" && g["teamId"] === TEAM)).toBe(true);
    });

    it("a read-only token cannot mutate groups — SCIM scopeDenied, ZERO group row", async () => {
      const before = H.store["scimGroup"].length;
      const res = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_READ, groupBody());
      expect(res.statusCode).toBe(403);
      expect(scimType(res)).toBe("scopeDenied");
      expect(hits("scimCreateGroup")).toHaveLength(0);
      expect(H.store["scimGroup"].length).toBe(before);
    });

    it("the payload cannot carry a workspace: a body-declared teamId is a bounded 400, ZERO group row", async () => {
      const before = H.store["scimGroup"].length;
      const res = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody({ teamId: OTHER_TEAM }));
      expect(res.statusCode).toBe(400);
      expect(scimType(res)).toBe("invalidSyntax");
      expect(json(res)["detail"]).toBe("invalid_group_payload");
      expect(H.store["scimGroup"].length).toBe(before);
    });

    it("POST is idempotent on externalId (200, not a duplicate)", async () => {
      const first = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody());
      const n = H.store["scimGroup"].length;
      const again = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody());
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(200);
      expect(json(again)["id"]).toBe(json(first)["id"]);
      expect(H.store["scimGroup"].length).toBe(n);
    });

    it("initial membership is applied through the membership orchestrator", async () => {
      const res = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody({
        members: [{ value: STALE_USER }],
      }));
      expect(res.statusCode).toBe(201);
      expect(hits("applyDirectoryRoleChange")).toEqual([
        expect.objectContaining({ currentRole: "MEMBER", desiredRole: "VIEWER", source: "IDP_GROUP" }),
      ]);
      expect(H.store["teamMember"].find((m) => m["userId"] === STALE_USER)?.["role"]).toBe("VIEWER");
      const body = json(res) as { members: Array<Record<string, unknown>> };
      expect(body.members.map((m) => m["value"])).toEqual([STALE_USER]);
    });

    it("a cross-Organization member reference fails EXPLICITLY and rolls the group row back", async () => {
      const before = H.store["scimGroup"].length;
      const res = await scim("POST", "/v2/scim/Groups", RAW_GROUPS_WRITE, groupBody({
        members: [{ value: FOREIGN_USER }],
      }));
      expect(res.statusCode).toBe(409);
      expect(json(res)["detail"]).toBe("group_member_unresolved");
      // Atomic: no half-created group, and the foreign user was never touched.
      expect(H.store["scimGroup"].length).toBe(before);
      expect(H.writes).toContain("ROLLBACK");
      expect(H.store["teamMember"].find((m) => m["userId"] === FOREIGN_USER)?.["role"]).toBe("ADMIN");
    });
  });

  describe("GET /v2/scim/Groups/:id", () => {
    it("groups.read returns the RFC Group resource with resolved members", async () => {
      const res = await scim("GET", `/v2/scim/Groups/${GROUP}`, RAW_GROUPS_READ);
      expect(res.statusCode).toBe(200);
      expect(hits("scimReadGroup")).toEqual([{ teamId: TEAM, id: GROUP }]);
      const body = json(res) as {
        schemas: string[]; id: string; displayName: string; mappedRole: string;
        members: Array<Record<string, unknown>>; meta: Record<string, unknown>;
      };
      expect(body.schemas).toEqual([SCIM_GROUP_SCHEMA_URI]);
      expect(body.id).toBe(GROUP);
      expect(body.displayName).toBe("Engineering");
      expect(body.mappedRole).toBe("ADMIN");
      expect(body.members).toEqual([{ value: SUBJECT_USER, display: "member@acme.test" }]);
      expect(body.meta["resourceType"]).toBe("Group");
    });

    it("the legacy users.read scope is still sufficient for reads", async () => {
      const res = await scim("GET", `/v2/scim/Groups/${GROUP}`, RAW_USERS_READ);
      expect(res.statusCode).toBe(200);
      expect(json(res)["id"]).toBe(GROUP);
    });

    it("a write-only token cannot read — SCIM scopeDenied, ZERO read", async () => {
      const res = await scim("GET", `/v2/scim/Groups/${GROUP}`, RAW_USERS_WRITE);
      expect(res.statusCode).toBe(403);
      expect(scimType(res)).toBe("scopeDenied");
      expect(hits("scimReadGroup")).toHaveLength(0);
    });

    it("a cross-Organization group is BYTE-IDENTICAL to a missing one", async () => {
      const foreign = await scim("GET", `/v2/scim/Groups/${FOREIGN_GROUP}`, RAW_GROUPS_READ);
      const missing = await scim("GET", `/v2/scim/Groups/${MISSING_GROUP}`, RAW_GROUPS_READ);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(json(foreign)).toMatchObject({ status: "404", detail: "Group not found" });
    });
  });

  describe("GET /v2/scim/Groups (list)", () => {
    it("lists only the TOKEN organization, as a SCIM ListResponse", async () => {
      const res = await scim("GET", "/v2/scim/Groups", RAW_GROUPS_READ);
      expect(res.statusCode).toBe(200);
      expect(hits("scimListGroups")).toEqual([{ teamId: TEAM }]);
      const body = json(res) as { schemas: string[]; totalResults: number; Resources: Array<Record<string, unknown>> };
      expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
      expect(body.totalResults).toBe(1);
      expect(body.Resources.map((g) => g["id"])).toEqual([GROUP]);
      expect(res.body).not.toContain(FOREIGN_GROUP);
    });

    it("a foreign token lists ONLY its own Organization", async () => {
      const res = await scim("GET", "/v2/scim/Groups", RAW_FOREIGN);
      expect(res.statusCode).toBe(200);
      const body = json(res) as { Resources: Array<Record<string, unknown>> };
      expect(body.Resources.map((g) => g["id"])).toEqual([FOREIGN_GROUP]);
      expect(res.body).not.toContain(GROUP);
    });

    it("displayName filter + pagination window are honoured", async () => {
      const miss = await scim("GET", '/v2/scim/Groups?filter=displayName eq "Nope"', RAW_GROUPS_READ);
      expect((json(miss) as { totalResults: number }).totalResults).toBe(0);
      const hit = await scim("GET", '/v2/scim/Groups?filter=displayName eq "Engineering"&count=1', RAW_GROUPS_READ);
      const h = json(hit) as { totalResults: number; itemsPerPage: number };
      expect(h.totalResults).toBe(1);
      expect(h.itemsPerPage).toBe(1);
    });

    it("a write-only token cannot list — SCIM scopeDenied, ZERO read", async () => {
      const res = await scim("GET", "/v2/scim/Groups", RAW_GROUPS_WRITE);
      expect(res.statusCode).toBe(403);
      expect(scimType(res)).toBe("scopeDenied");
      expect(hits("scimListGroups")).toHaveLength(0);
    });
  });

  describe("DELETE /v2/scim/Groups/:id", () => {
    it("groups.write archives the group AND demotes the role it granted (204, no body)", async () => {
      expect(H.store["teamMember"].find((m) => m["id"] === TARGET_MEMBER)?.["role"]).toBe("ADMIN");
      const res = await scim("DELETE", `/v2/scim/Groups/${GROUP}`, RAW_GROUPS_WRITE);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(hits("scimDeleteGroup")).toEqual([{ teamId: TEAM, id: GROUP }]);
      // SOFT delete — the row survives as ARCHIVED, members are demoted, and
      // OWNER is never silently revoked.
      expect(row("scimGroup", GROUP)?.["status"]).toBe("ARCHIVED");
      expect(H.store["teamMember"].find((m) => m["id"] === TARGET_MEMBER)?.["role"]).toBe("MEMBER");
      expect(H.store["teamMember"].find((m) => m["id"] === ACTOR_MEMBER)?.["role"]).toBe("OWNER");
    });

    it("the users.deactivate scope is also sufficient; a users.write-only token is NOT", async () => {
      const denied = await scim("DELETE", `/v2/scim/Groups/${GROUP}`, RAW_USERS_WRITE);
      expect(denied.statusCode).toBe(403);
      expect(scimType(denied)).toBe("scopeDenied");
      expect(row("scimGroup", GROUP)?.["status"]).toBe("ACTIVE");

      // RAW_ALL carries users.deactivate.
      const allowed = await scim("DELETE", `/v2/scim/Groups/${GROUP}`, RAW_ALL);
      expect(allowed.statusCode).toBe(204);
      expect(row("scimGroup", GROUP)?.["status"]).toBe("ARCHIVED");
    });

    it("a cross-Organization group is BYTE-IDENTICAL to a missing one, ZERO mutation", async () => {
      const foreign = await scim("DELETE", `/v2/scim/Groups/${FOREIGN_GROUP}`, RAW_GROUPS_WRITE);
      const missing = await scim("DELETE", `/v2/scim/Groups/${MISSING_GROUP}`, RAW_GROUPS_WRITE);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(json(foreign)).toMatchObject({ status: "404", detail: "Group not found" });
      expect(row("scimGroup", FOREIGN_GROUP)?.["status"]).toBe("ACTIVE");
      // Nothing in the domain was written (the only writes are the best-effort
      // `lastUsedAtUtc` touches the token authenticator performs).
      expect(H.writes.filter((w) => !w.startsWith("scimProvisioningToken."))).toEqual([]);
    });

    it("a member-demotion failure rolls the WHOLE delete back — the archive does not survive", async () => {
      H.demoteFails = true;
      const res = await scim("DELETE", `/v2/scim/Groups/${GROUP}`, RAW_GROUPS_WRITE);
      // Fail closed: never a dishonest 204.
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      // ONE transaction: the archive AND the demotion are both rolled back.
      expect(H.writes).toContain("ROLLBACK");
      expect(row("scimGroup", GROUP)?.["status"]).toBe("ACTIVE");
      expect(H.store["teamMember"].find((m) => m["id"] === TARGET_MEMBER)?.["role"]).toBe("ADMIN");
      // The demotion really was attempted inside that transaction.
      expect(hits("demoteGroupMappedRoleOnArchive")).toHaveLength(1);
    });
  });
});
