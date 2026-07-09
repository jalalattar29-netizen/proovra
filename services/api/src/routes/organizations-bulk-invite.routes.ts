/**
 * Phase 8 Enterprise Production Readiness — SCOPE A (Bulk Invite) +
 * SCOPE B (CSV Import).
 *
 * A NEW Fastify plugin exposing bulk org-invitation surfaces. It does
 * NOT build a second invite system — every write reuses the EXACT same
 * model writes + audit as the canonical single-invite path in
 * `organizations.routes.ts` (OrganizationInvite + SHA-256 token hash +
 * ORG_MEMBER_INVITED audit). The batch orchestration MIRRORS the
 * external-reviewer bulk service
 * (`services/external-review/portal-bulk-invitations.service.ts`):
 * per-row outcomes, a shared batchId, START/COMPLETED audit, and the
 * invariant that a single bad row NEVER fails the whole batch.
 *
 * Endpoints (all gated by requireOrgAdmin — ORG_ADMIN+, the SAME gate as
 * the single-invite / governance routes; anti-enumeration 404 on
 * org-not-accessible):
 *
 *   POST /v1/orgs/:id/invites/bulk/validate  — DRY RUN, creates nothing.
 *   POST /v1/orgs/:id/invites/bulk           — EXECUTE.
 *   POST /v1/orgs/:id/invites/bulk/resend    — resend still-pending invites.
 *   GET  /v1/orgs/:id/invites/csv-template   — text/csv download template.
 *   POST /v1/orgs/:id/invites/csv            — parse CSV then dry-run/execute.
 *
 * HARD RULES honored:
 *   - Bulk invite creates ONLY OrganizationInvite / OrganizationMembership
 *     (via the same single-invite writes). NEVER evidence access.
 *   - No new migration. Org audit uses free-form eventType; this plugin
 *     adds ORG_BULK_INVITATION_STARTED / _COMPLETED.
 *   - Honesty: partial-success is truthful per-row; a truncation note is
 *     returned (never a silent drop) when the batch exceeds the max.
 *   - Seat check reuses the SAME computation as GET /v1/orgs/:id/billing/rollup
 *     (Team.includedSeats vs current TeamMember count across the org's
 *     non-personal workspaces).
 *   - Domain policy: if the org has an `invite.restrict_to_verified_domains`
 *     OrganizationPolicy set truthy AND has ≥1 VERIFIED OrganizationDomain,
 *     rows whose email domain is not a verified domain are DOMAIN_NOT_ALLOWED.
 *     If no such policy (or no verified domains) we do NOT restrict.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
import type { OrgRole } from "../services/organization/organization-resolver.service.js";
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";

// ---------------------------------------------------------------------------
// Constants + shapes
// ---------------------------------------------------------------------------

/** Max rows accepted per batch. Rows beyond this are NOT silently dropped —
 *  the response carries a truncation note documenting the overflow. */
export const BULK_INVITE_MAX_ROWS = 200;

/** OrganizationPolicy key holding the domain-restriction toggle. */
export const INVITE_DOMAIN_RESTRICTION_KEY = "invite.restrict_to_verified_domains";

const ORG_ROLES = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
] as const;
type OrgRoleValue = (typeof ORG_ROLES)[number];

const ORG_ROLE_PRECEDENCE: Record<OrgRoleValue, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

const UuidParam = z.string().uuid();

const RowInput = z.object({
  email: z.string().max(320),
  role: z.enum(ORG_ROLES).optional(),
});

const BulkBody = z.object({
  defaultRole: z.enum(ORG_ROLES).optional(),
  rows: z.array(RowInput).min(0),
});

const CsvBody = z.object({
  csv: z.string().max(200_000),
  defaultRole: z.enum(ORG_ROLES).optional(),
});

const ResendBody = z
  .object({
    batchId: z.string().uuid().optional(),
    inviteIds: z.array(z.string().uuid()).max(BULK_INVITE_MAX_ROWS).optional(),
  })
  .refine((b) => !!b.batchId || (b.inviteIds && b.inviteIds.length > 0), {
    message: "Provide batchId or a non-empty inviteIds list.",
  });

/**
 * Dry-run outcome vocabulary. Execute maps WOULD_INVITE→INVITED and adds
 * FAILED for genuine write errors.
 */
type ValidateOutcome =
  | "WOULD_INVITE"
  | "DUPLICATE_IN_BATCH"
  | "ALREADY_MEMBER"
  | "PENDING_INVITE_EXISTS"
  | "INVALID_EMAIL"
  | "ROLE_TOO_HIGH"
  | "DOMAIN_NOT_ALLOWED"
  | "SEAT_LIMIT_EXCEEDED";

type ExecuteOutcome =
  | "INVITED"
  | "DUPLICATE"
  | "ALREADY_MEMBER"
  | "PENDING_INVITE_EXISTS"
  | "INVALID_EMAIL"
  | "ROLE_TOO_HIGH"
  | "DOMAIN_NOT_ALLOWED"
  | "SEAT_LIMIT_EXCEEDED"
  | "FAILED";

type PlannedRow = {
  /** 1-based source line number (CSV) or array index; null for pasted arrays without a line. */
  line: number | null;
  email: string;
  role: OrgRoleValue;
  outcome: ValidateOutcome;
  /** null → eligible to invite. Non-null explains the denial. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Token hashing — MIRRORS organizations.routes.ts hashInviteToken exactly so
// the bulk-written invites are indistinguishable from single-invite rows.
// ---------------------------------------------------------------------------
function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}
function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
function inviteExpiresAt(now = Date.now()): Date {
  return new Date(now + 7 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Small helpers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/** RFC5322-lite shape check, matching the single-invite validator intent. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * SMALL inline RFC4180-tolerant CSV parser. NO npm dependency.
 * Handles quoted fields, escaped double-quotes (""), embedded commas +
 * newlines inside quotes, and CRLF/LF line endings. Returns records with
 * their 1-based source line number (of the record's FIRST physical line).
 */
export function parseCsv(
  input: string,
): Array<{ line: number; fields: string[] }> {
  const records: Array<{ line: number; fields: string[] }> = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let physicalLine = 1;
  let recordStartLine = 1;
  let sawFieldOrData = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Skip fully-empty rows (a single empty field and nothing else).
    const isBlank = row.length === 1 && row[0]!.trim() === "";
    if (!isBlank) records.push({ line: recordStartLine, fields: row });
    row = [];
    sawFieldOrData = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (!sawFieldOrData && row.length === 0 && field === "") {
      recordStartLine = physicalLine;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") physicalLine++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawFieldOrData = true;
      continue;
    }
    if (ch === ",") {
      pushField();
      sawFieldOrData = true;
      continue;
    }
    if (ch === "\r") {
      // swallow; the \n (if any) triggers the row push
      continue;
    }
    if (ch === "\n") {
      pushRow();
      physicalLine++;
      continue;
    }
    field += ch;
    sawFieldOrData = true;
  }
  // Flush trailing record (file not newline-terminated).
  if (field !== "" || row.length > 0) {
    pushRow();
  }
  return records;
}

/**
 * Map parsed CSV records → invite rows. Requires an `email` header column;
 * an optional `role` column. Unknown columns are ignored gracefully. Returns
 * the extracted rows (with source line numbers) OR a header error.
 */
export function csvToRows(
  csv: string,
): { ok: true; rows: Array<{ line: number; email: string; role?: string }> }
  | { ok: false; error: string } {
  const records = parseCsv(csv);
  if (records.length === 0) {
    return { ok: false, error: "CSV is empty." };
  }
  const header = records[0]!.fields.map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  const roleIdx = header.indexOf("role");
  if (emailIdx < 0) {
    return { ok: false, error: "CSV must include an 'email' header column." };
  }
  const rows: Array<{ line: number; email: string; role?: string }> = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!;
    const email = (rec.fields[emailIdx] ?? "").trim();
    const role =
      roleIdx >= 0 ? (rec.fields[roleIdx] ?? "").trim() || undefined : undefined;
    // Skip fully-empty data rows.
    if (email === "" && !role) continue;
    rows.push({ line: rec.line, email, role });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Gate — SAME requireOrgAdmin contract as organizations-governance.routes.ts.
// Anti-enumeration: 404 for both not_found and forbidden.
// ---------------------------------------------------------------------------
async function requireOrgAdmin(input: {
  orgId: string;
  userId: string;
}): Promise<{ ok: true; role: OrgRole } | { ok: false; code: number }> {
  const result = await checkOrgAccess(prisma, {
    orgId: input.orgId,
    userId: input.userId,
    minRole: "ORG_ADMIN",
  });
  if (result.kind !== "ok") return { ok: false, code: 404 };
  return { ok: true, role: result.role };
}

// ---------------------------------------------------------------------------
// Seat computation — reuses the SAME signal as GET /v1/orgs/:id/billing/rollup:
// sum of Team.includedSeats and current TeamMember counts across the org's
// non-personal workspaces.
// ---------------------------------------------------------------------------
async function computeSeatUsage(orgId: string): Promise<{
  totalIncludedSeats: number;
  totalUsedSeats: number;
  hasSeatCap: boolean;
}> {
  const workspaces = await prisma.team.findMany({
    where: { organizationId: orgId, isPersonal: false },
    select: { includedSeats: true, _count: { select: { members: true } } },
  });
  let totalIncludedSeats = 0;
  let totalUsedSeats = 0;
  let hasSeatCap = false;
  for (const ws of workspaces) {
    const included = ws.includedSeats ?? 0;
    totalIncludedSeats += included;
    totalUsedSeats += ws._count.members;
    if (included > 0) hasSeatCap = true;
  }
  return { totalIncludedSeats, totalUsedSeats, hasSeatCap };
}

// ---------------------------------------------------------------------------
// Domain policy — verified-domain restriction, honestly gated behind an
// explicit OrganizationPolicy toggle AND the presence of verified domains.
// ---------------------------------------------------------------------------
async function loadDomainPolicy(orgId: string): Promise<{
  restrict: boolean;
  verifiedDomains: Set<string>;
}> {
  const policy = await prisma.organizationPolicy.findUnique({
    where: {
      organization_policies_org_key_uniq: {
        organizationId: orgId,
        key: INVITE_DOMAIN_RESTRICTION_KEY,
      },
    },
    select: { value: true },
  });
  const enabled = isRestrictionPolicyEnabled(policy?.value ?? null);
  if (!enabled) return { restrict: false, verifiedDomains: new Set() };

  const domains = await prisma.organizationDomain.findMany({
    where: { organizationId: orgId, verifiedAt: { not: null } },
    select: { domain: true },
  });
  const verifiedDomains = new Set(domains.map((d) => d.domain.trim().toLowerCase()));
  // If the org enabled the policy but has NO verified domains yet, we do NOT
  // restrict — restricting against an empty set would reject every invite,
  // which is not an honest policy expression.
  if (verifiedDomains.size === 0) return { restrict: false, verifiedDomains };
  return { restrict: true, verifiedDomains };
}

/** Accepts `true`, `{ enabled: true }`, or `{ value: true }` shapes. */
export function isRestrictionPolicyEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (rec.enabled === true) return true;
    if (rec.value === true) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core planner — produces the per-row plan shared by dry-run AND execute.
// Reads existing members + pending invites in bulk (one query each) to keep
// the batch bounded. Duplicate-in-batch is detected on normalized email.
// ---------------------------------------------------------------------------
type RawRow = { line: number | null; email: string; role?: string };

async function planRows(input: {
  orgId: string;
  actorRole: OrgRole;
  defaultRole: OrgRoleValue;
  rows: RawRow[];
}): Promise<{ planned: PlannedRow[]; wouldInviteCount: number }> {
  const { orgId, actorRole, defaultRole, rows } = input;
  const actorRank = ORG_ROLE_PRECEDENCE[actorRole as OrgRoleValue];

  const domainPolicy = await loadDomainPolicy(orgId);
  const seat = await computeSeatUsage(orgId);

  // Bulk lookups: normalized emails → existing member? pending invite?
  const normalized = rows.map((r) => normalizeEmail(r.email));
  const uniqueEmails = Array.from(new Set(normalized.filter(isValidEmail)));

  const now = new Date();
  const [usersWithEmail, pendingInvites] = await Promise.all([
    uniqueEmails.length
      ? prisma.user.findMany({
          where: { email: { in: uniqueEmails } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
    uniqueEmails.length
      ? prisma.organizationInvite.findMany({
          where: {
            organizationId: orgId,
            email: { in: uniqueEmails },
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { email: true },
        })
      : Promise.resolve([]),
  ]);

  const userIdsByEmail = new Map(usersWithEmail.map((u) => [u.email, u.id]));
  const memberUserIds = userIdsByEmail.size
    ? new Set(
        (
          await prisma.organizationMembership.findMany({
            where: {
              organizationId: orgId,
              userId: { in: Array.from(userIdsByEmail.values()) },
            },
            select: { userId: true },
          })
        ).map((m) => m.userId),
      )
    : new Set<string>();
  const pendingEmails = new Set(pendingInvites.map((p) => p.email));

  const seenInBatch = new Set<string>();
  const planned: PlannedRow[] = [];
  let wouldInviteCount = 0;
  // Track how many NEW seats the eligible rows would consume so we deny
  // once the cap is crossed (honest running total, not a per-row snapshot).
  let projectedNewSeats = 0;

  for (const raw of rows) {
    const email = normalizeEmail(raw.email);
    const roleRaw = raw.role ?? defaultRole;
    const role = (ORG_ROLES as ReadonlyArray<string>).includes(roleRaw)
      ? (roleRaw as OrgRoleValue)
      : null;

    const base = { line: raw.line ?? null, email };

    if (!isValidEmail(email)) {
      planned.push({ ...base, role: defaultRole, outcome: "INVALID_EMAIL", reason: "Malformed email address." });
      continue;
    }
    if (role === null) {
      planned.push({ ...base, role: defaultRole, outcome: "ROLE_TOO_HIGH", reason: `Unknown role '${roleRaw}'.` });
      continue;
    }
    if (ORG_ROLE_PRECEDENCE[role] > actorRank) {
      planned.push({ ...base, role, outcome: "ROLE_TOO_HIGH", reason: "Cannot invite above your own role." });
      continue;
    }
    if (seenInBatch.has(email)) {
      planned.push({ ...base, role, outcome: "DUPLICATE_IN_BATCH", reason: "Repeated in this batch." });
      continue;
    }
    seenInBatch.add(email);

    const userId = userIdsByEmail.get(email);
    if (userId && memberUserIds.has(userId)) {
      planned.push({ ...base, role, outcome: "ALREADY_MEMBER", reason: "Already an organization member." });
      continue;
    }
    if (pendingEmails.has(email)) {
      planned.push({ ...base, role, outcome: "PENDING_INVITE_EXISTS", reason: "A pending invite already exists." });
      continue;
    }
    if (domainPolicy.restrict) {
      const dom = domainOfEmail(email);
      if (!dom || !domainPolicy.verifiedDomains.has(dom)) {
        planned.push({ ...base, role, outcome: "DOMAIN_NOT_ALLOWED", reason: "Email domain is not a verified org domain." });
        continue;
      }
    }
    // Seat check — only when the org has an actual seat cap.
    if (seat.hasSeatCap) {
      const afterInvite = seat.totalUsedSeats + projectedNewSeats + 1;
      if (afterInvite > seat.totalIncludedSeats) {
        planned.push({ ...base, role, outcome: "SEAT_LIMIT_EXCEEDED", reason: "Inviting would exceed the seat allotment." });
        continue;
      }
    }

    projectedNewSeats += 1;
    wouldInviteCount += 1;
    planned.push({ ...base, role, outcome: "WOULD_INVITE", reason: null });
  }

  return { planned, wouldInviteCount };
}

function summarize<T extends string>(rows: Array<{ outcome: T }>): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1;
  return summary;
}

function seatPreview(
  seat: { totalIncludedSeats: number; totalUsedSeats: number; hasSeatCap: boolean },
  wouldInviteCount: number,
) {
  return {
    used: seat.totalUsedSeats,
    included: seat.totalIncludedSeats,
    afterInvite: seat.totalUsedSeats + wouldInviteCount,
    hasSeatCap: seat.hasSeatCap,
  };
}

// ---------------------------------------------------------------------------
// Execute — for every WOULD_INVITE row perform the SAME model writes as the
// single-invite handler, each in its OWN transaction, so one row's failure
// never rolls back the batch. Emits ORG_BULK_INVITATION_STARTED/_COMPLETED.
// ---------------------------------------------------------------------------
async function executeBatch(input: {
  orgId: string;
  actorUserId: string;
  planned: PlannedRow[];
  batchId: string;
}): Promise<Array<{ line: number | null; email: string; role: OrgRoleValue; outcome: ExecuteOutcome; reason: string | null; inviteId: string | null }>> {
  const results: Array<{
    line: number | null;
    email: string;
    role: OrgRoleValue;
    outcome: ExecuteOutcome;
    reason: string | null;
    inviteId: string | null;
  }> = [];

  for (const row of input.planned) {
    if (row.outcome !== "WOULD_INVITE") {
      // Carry the dry-run denial through unchanged (it is a genuine per-row
      // outcome, e.g. ALREADY_MEMBER / SEAT_LIMIT_EXCEEDED).
      results.push({
        line: row.line,
        email: row.email,
        role: row.role,
        outcome: row.outcome as ExecuteOutcome,
        reason: row.reason,
        inviteId: null,
      });
      continue;
    }
    try {
      const created = await prisma.$transaction(async (tx) => {
        // Re-check inside the tx to close the read→write race (another admin
        // may have invited this email between plan and execute).
        const nowTx = new Date();
        const existingPending = await tx.organizationInvite.findFirst({
          where: {
            organizationId: input.orgId,
            email: row.email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: nowTx },
          },
          select: { id: true },
        });
        if (existingPending) return { kind: "pending" as const };

        const userWithEmail = await tx.user.findFirst({
          where: { email: row.email },
          select: { id: true },
        });
        if (userWithEmail) {
          const alreadyMember = await tx.organizationMembership.findFirst({
            where: { organizationId: input.orgId, userId: userWithEmail.id },
            select: { id: true },
          });
          if (alreadyMember) return { kind: "member" as const };
        }

        const token = newInviteToken();
        const tokenHash = hashInviteToken(token);
        const invite = await tx.organizationInvite.create({
          data: {
            organizationId: input.orgId,
            email: row.email,
            role: row.role,
            token: null,
            tokenHash,
            invitedByUserId: input.actorUserId,
            expiresAt: inviteExpiresAt(),
          },
          select: { id: true, expiresAt: true },
        });

        // SAME audit event as the single-invite path.
        await emitOrgAuditEvent(tx, {
          organizationId: input.orgId,
          actorUserId: input.actorUserId,
          eventType: "ORG_MEMBER_INVITED",
          targetType: "organization_invite",
          targetId: invite.id,
          metadata: {
            inviteId: invite.id,
            email: row.email,
            role: row.role,
            expiresAt: invite.expiresAt.toISOString(),
            invitedByUserId: input.actorUserId,
            bulkBatchId: input.batchId,
          },
        });
        return { kind: "ok" as const, inviteId: invite.id };
      });

      if (created.kind === "ok") {
        results.push({ line: row.line, email: row.email, role: row.role, outcome: "INVITED", reason: null, inviteId: created.inviteId });
      } else if (created.kind === "pending") {
        results.push({ line: row.line, email: row.email, role: row.role, outcome: "PENDING_INVITE_EXISTS", reason: "A pending invite already exists.", inviteId: null });
      } else {
        results.push({ line: row.line, email: row.email, role: row.role, outcome: "ALREADY_MEMBER", reason: "Already an organization member.", inviteId: null });
      }
    } catch {
      // A single row failing NEVER fails the batch.
      results.push({ line: row.line, email: row.email, role: row.role, outcome: "FAILED", reason: "Invite write failed.", inviteId: null });
    }
  }

  return results;
}

// ===========================================================================
// Plugin
// ===========================================================================
export async function organizationsBulkInviteRoutes(app: FastifyInstance) {
  const preHandler = [requireAuth, requireLegalAcceptance];

  // Shared: resolve gate + parse orgId; returns null on rejection (already replied).
  async function gate(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ orgId: string; userId: string; role: OrgRole } | null> {
    const parsed = UuidParam.safeParse((req.params as { id: string }).id);
    if (!parsed.success) {
      reply.code(404).send({ message: "Organization not found", code: "org_not_found" });
      return null;
    }
    const orgId = parsed.data;
    const userId = getAuthUserId(req);
    const access = await requireOrgAdmin({ orgId, userId });
    if (!access.ok) {
      reply.code(access.code).send({ message: "Organization not found", code: "org_not_found" });
      return null;
    }
    return { orgId, userId, role: access.role };
  }

  /** Enforce the row cap; return the bounded slice + a truthful truncation note. */
  function boundRows<T>(rows: T[]): { rows: T[]; truncated: null | { received: number; accepted: number; note: string } } {
    if (rows.length <= BULK_INVITE_MAX_ROWS) return { rows, truncated: null };
    return {
      rows: rows.slice(0, BULK_INVITE_MAX_ROWS),
      truncated: {
        received: rows.length,
        accepted: BULK_INVITE_MAX_ROWS,
        note: `Batch limited to ${BULK_INVITE_MAX_ROWS} rows; ${rows.length - BULK_INVITE_MAX_ROWS} row(s) were not processed. Split into multiple batches.`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites/bulk/validate — DRY RUN.
  // -------------------------------------------------------------------------
  app.post("/v1/orgs/:id/invites/bulk/validate", { preHandler }, async (req, reply) => {
    const ctx = await gate(req, reply);
    if (!ctx) return;
    const body = BulkBody.parse(req.body);
    const defaultRole: OrgRoleValue = body.defaultRole ?? "ORG_MEMBER";

    const bounded = boundRows(
      body.rows.map((r, idx) => ({ line: idx + 1, email: r.email, role: r.role } as RawRow)),
    );
    const { planned, wouldInviteCount } = await planRows({
      orgId: ctx.orgId,
      actorRole: ctx.role,
      defaultRole,
      rows: bounded.rows,
    });
    const seat = await computeSeatUsage(ctx.orgId);

    return reply.code(200).send({
      organizationId: ctx.orgId,
      dryRun: true,
      summary: summarize(planned),
      seatPreview: seatPreview(seat, wouldInviteCount),
      truncated: bounded.truncated,
      rows: planned,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites/bulk — EXECUTE.
  // -------------------------------------------------------------------------
  app.post("/v1/orgs/:id/invites/bulk", { preHandler }, async (req, reply) => {
    const ctx = await gate(req, reply);
    if (!ctx) return;
    const body = BulkBody.parse(req.body);
    const defaultRole: OrgRoleValue = body.defaultRole ?? "ORG_MEMBER";

    const bounded = boundRows(
      body.rows.map((r, idx) => ({ line: idx + 1, email: r.email, role: r.role } as RawRow)),
    );
    const { planned } = await planRows({
      orgId: ctx.orgId,
      actorRole: ctx.role,
      defaultRole,
      rows: bounded.rows,
    });

    const batchId = randomUUID();
    await emitOrgAuditEvent(prisma, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      eventType: "ORG_BULK_INVITATION_STARTED",
      targetType: "organization",
      targetId: ctx.orgId,
      metadata: { batchId, totalRows: planned.length, eligibleRows: planned.filter((p) => p.outcome === "WOULD_INVITE").length },
    });

    const results = await executeBatch({ orgId: ctx.orgId, actorUserId: ctx.userId, planned, batchId });
    const summary = summarize(results);

    await emitOrgAuditEvent(prisma, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      eventType: "ORG_BULK_INVITATION_COMPLETED",
      targetType: "organization",
      targetId: ctx.orgId,
      metadata: { batchId, totalRows: results.length, ...summary },
    });

    const seat = await computeSeatUsage(ctx.orgId);
    return reply.code(200).send({
      organizationId: ctx.orgId,
      batchId,
      dryRun: false,
      summary,
      seatPreview: seatPreview(seat, 0),
      truncated: bounded.truncated,
      rows: results,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites/bulk/resend — resend still-pending invites in a
  // batch (or an explicit inviteIds list) reusing the single-invite resend
  // semantics (extend expiry + bump resendCount + ORG_INVITE_RESENT audit).
  // -------------------------------------------------------------------------
  app.post("/v1/orgs/:id/invites/bulk/resend", { preHandler }, async (req, reply) => {
    const ctx = await gate(req, reply);
    if (!ctx) return;
    const body = ResendBody.parse(req.body);

    // Resolve candidate invite ids.
    let inviteIds: string[] = body.inviteIds ?? [];
    if (body.batchId && inviteIds.length === 0) {
      // A batch groups its rows by the ORG_MEMBER_INVITED metadata.bulkBatchId.
      const events = await prisma.organizationAuditEvent.findMany({
        where: { organizationId: ctx.orgId, eventType: "ORG_MEMBER_INVITED" },
        select: { targetId: true, metadata: true },
        take: 1000,
      });
      inviteIds = events
        .filter((e) => {
          const md = e.metadata as Record<string, unknown> | null;
          return md && md.bulkBatchId === body.batchId;
        })
        .map((e) => e.targetId)
        .filter((x): x is string => !!x);
    }
    inviteIds = Array.from(new Set(inviteIds)).slice(0, BULK_INVITE_MAX_ROWS);

    const now = new Date();
    const results: Array<{ inviteId: string; outcome: "RESENT" | "NOT_PENDING" | "NOT_FOUND" | "FAILED"; reason: string | null }> = [];
    for (const inviteId of inviteIds) {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          const invite = await tx.organizationInvite.findFirst({
            where: { id: inviteId, organizationId: ctx.orgId },
            select: { id: true, email: true, role: true, acceptedAt: true, revokedAt: true, expiresAt: true, resendCount: true },
          });
          if (!invite) return { kind: "not_found" as const };
          if (invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
            return { kind: "not_pending" as const };
          }
          const updated = await tx.organizationInvite.update({
            where: { id: invite.id },
            data: { lastResentAt: new Date(), resendCount: { increment: 1 }, expiresAt: inviteExpiresAt() },
            select: { expiresAt: true, resendCount: true },
          });
          await emitOrgAuditEvent(tx, {
            organizationId: ctx.orgId,
            actorUserId: ctx.userId,
            eventType: "ORG_INVITE_RESENT",
            targetType: "organization_invite",
            targetId: invite.id,
            metadata: {
              inviteId: invite.id,
              email: invite.email,
              role: invite.role,
              newExpiresAt: updated.expiresAt.toISOString(),
              resendCount: updated.resendCount,
            },
          });
          return { kind: "ok" as const };
        });
        if (outcome.kind === "ok") results.push({ inviteId, outcome: "RESENT", reason: null });
        else if (outcome.kind === "not_found") results.push({ inviteId, outcome: "NOT_FOUND", reason: "Invite not found." });
        else results.push({ inviteId, outcome: "NOT_PENDING", reason: "Invite is accepted, revoked, or expired." });
      } catch {
        results.push({ inviteId, outcome: "FAILED", reason: "Resend write failed." });
      }
    }

    return reply.code(200).send({
      organizationId: ctx.orgId,
      batchId: body.batchId ?? null,
      summary: summarize(results),
      rows: results,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/invites/csv-template — downloadable template.
  // -------------------------------------------------------------------------
  app.get("/v1/orgs/:id/invites/csv-template", { preHandler }, async (req, reply) => {
    const ctx = await gate(req, reply);
    if (!ctx) return;
    const csv =
      "email,role\r\n" +
      "alice@example.com,ORG_MEMBER\r\n" +
      "bob@example.com,ORG_AUDITOR\r\n";
    return reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="proovra-bulk-invite-template.csv"')
      .send(csv);
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites/csv — parse CSV then run dry-run / execute.
  // Accepts application/json {csv,defaultRole?} OR raw text/csv body.
  // ?dryRun=1 → validate only (creates nothing).
  // -------------------------------------------------------------------------
  app.post("/v1/orgs/:id/invites/csv", { preHandler }, async (req, reply) => {
    const ctx = await gate(req, reply);
    if (!ctx) return;

    const dryRun = String((req.query as { dryRun?: string } | undefined)?.dryRun ?? "") === "1";

    // Body may be JSON {csv} or raw CSV text depending on content-type.
    let csvText: string;
    let defaultRole: OrgRoleValue = "ORG_MEMBER";
    // Content-type is validated: only application/json | text/csv |
    // application/csv are accepted. Arbitrary bodies are NOT treated as CSV.
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      const body = CsvBody.parse(req.body);
      csvText = body.csv;
      if (body.defaultRole) defaultRole = body.defaultRole;
    } else if (ct.includes("text/csv") || ct.includes("application/csv")) {
      // Raw CSV string body (parsed by the scoped content-type parser).
      csvText = typeof req.body === "string" ? req.body : String(req.body ?? "");
      const q = req.query as { defaultRole?: string } | undefined;
      if (q?.defaultRole && (ORG_ROLES as ReadonlyArray<string>).includes(q.defaultRole)) {
        defaultRole = q.defaultRole as OrgRoleValue;
      }
    } else {
      return reply.code(415).send({
        message: "unsupported_media_type",
        code: "unsupported_media_type",
        detail: "Use application/json {csv} or text/csv.",
      });
    }

    const parsed = csvToRows(csvText);
    if (!parsed.ok) {
      return reply.code(400).send({ message: parsed.error, code: "csv_invalid" });
    }

    const bounded = boundRows(parsed.rows);
    const rawRows: RawRow[] = bounded.rows.map((r) => ({ line: r.line, email: r.email, role: r.role }));
    const { planned, wouldInviteCount } = await planRows({
      orgId: ctx.orgId,
      actorRole: ctx.role,
      defaultRole,
      rows: rawRows,
    });

    if (dryRun) {
      const seat = await computeSeatUsage(ctx.orgId);
      return reply.code(200).send({
        organizationId: ctx.orgId,
        dryRun: true,
        source: "csv",
        summary: summarize(planned),
        seatPreview: seatPreview(seat, wouldInviteCount),
        truncated: bounded.truncated,
        rows: planned,
      });
    }

    const batchId = randomUUID();
    await emitOrgAuditEvent(prisma, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      eventType: "ORG_BULK_INVITATION_STARTED",
      targetType: "organization",
      targetId: ctx.orgId,
      metadata: { batchId, source: "csv", totalRows: planned.length, eligibleRows: wouldInviteCount },
    });
    const results = await executeBatch({ orgId: ctx.orgId, actorUserId: ctx.userId, planned, batchId });
    const summary = summarize(results);
    await emitOrgAuditEvent(prisma, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      eventType: "ORG_BULK_INVITATION_COMPLETED",
      targetType: "organization",
      targetId: ctx.orgId,
      metadata: { batchId, source: "csv", totalRows: results.length, ...summary },
    });

    const seat = await computeSeatUsage(ctx.orgId);
    return reply.code(200).send({
      organizationId: ctx.orgId,
      batchId,
      dryRun: false,
      source: "csv",
      summary,
      seatPreview: seatPreview(seat, 0),
      truncated: bounded.truncated,
      rows: results,
    });
  });
}
