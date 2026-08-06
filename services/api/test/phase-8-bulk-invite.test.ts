/**
 * Phase 8 Enterprise Production Readiness — SCOPE A (Bulk Invite) +
 * SCOPE B (CSV Import).
 *
 * Hybrid suite:
 *   - PURE tests exercise the exported helpers (CSV parser, email
 *     normalization/validation, domain extraction, restriction-policy
 *     reader) with real imports — no DB.
 *   - SOURCE-CONTRACT tests pin the route plugin's hard rules by reading
 *     the file source (matching this repo's route-test convention, e.g.
 *     phase-3-enterprise-identity-domains-and-sp-signing.test.ts): the
 *     ORG_ADMIN gate, anti-enumeration 404, 200-row cap + truncation note,
 *     reuse of the single-invite writes + ORG_MEMBER_INVITED audit, the
 *     ORG_BULK_INVITATION_* batch audit, per-row outcome vocabulary, seat
 *     computation reuse, verified-domain restriction, dry-run-creates-
 *     nothing, and never-fail-the-batch.
 *   - CATALOG test confirms the two new audit event types were registered.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  asPrismaDouble,
  rec,
  str,
  type DelegateArgs,
  type JsonRecord,
} from "./support/prisma-double.js";

// ---------------------------------------------------------------------------
// Macro-Wave A2 — email TRANSPORT mock. ONLY the transport is mocked; the
// durable outbox + atomic-claim + token-rotation writers under proof are the
// REAL org-invite-delivery.service implementation.
// ---------------------------------------------------------------------------
const { deliverySendMock } = vi.hoisted(() => ({
  deliverySendMock: vi.fn<
    (input: { to: string; subject: string; html: string; text: string }) => Promise<
      | { ok: true; providerMessageId: string | null }
      | { ok: false; errorCode: string; errorMessage: string }
    >
  >(async () => ({ ok: true as const, providerMessageId: "msg-1" })),
}));
vi.mock("../src/services/email.service.js", () => ({
  sendCustomEmailViaResend: deliverySendMock,
  // POINT 5 — the delivery path now derives a provider idempotency key. The
  // stand-in is deterministic and injective for the same reason the real one
  // is: a mock that returned a constant would hide a caller passing the wrong
  // discriminator.
  deterministicEmailKey: (templateKey: string, ...parts: string[]) =>
    [templateKey, ...parts].join(":"),
  renderEmailShell: (input: { bodyHtml: string }) => `<html>${input.bodyHtml}</html>`,
  escapeEmailHtml: (s: string) => s,
  getEmailBrandName: () => "PROOVRA",
  getEmailFromHeader: () => "PROOVRA <no-reply@proovra.test>",
  getEmailWebBaseUrl: () => "https://app.proovra.test",
}));

import {
  parseCsv,
  csvToRows,
  isValidEmail,
  normalizeEmail,
  domainOfEmail,
  isRestrictionPolicyEnabled,
  BULK_INVITE_MAX_ROWS,
  INVITE_DOMAIN_RESTRICTION_KEY,
} from "../src/routes/organizations-bulk-invite.routes.js";
import { ORG_AUDIT_EVENT_TYPES } from "../src/services/organization/org-audit.service.js";
import {
  ORG_INVITE_DELIVERY_EVENT_TYPE,
  ORG_INVITE_DELIVERY_MAX_ATTEMPTS,
  attemptInitialOrgInviteDelivery,
  hashOrgInviteToken,
  processDueOrgInviteDeliveries,
  recordOrgInviteDeliveryPending,
  resendOrgInviteDelivery,
} from "../src/services/organization/org-invite-delivery.service.js";

function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
const ROUTE_SRC = readFileSync(
  apiPath("src/routes/organizations-bulk-invite.routes.ts"),
  "utf8",
);
const SERVER_SRC = readFileSync(apiPath("src/server.ts"), "utf8");

// =============================================================================
// Group — ITEM 4: direct text/csv upload (launch hardening)
// =============================================================================
describe("Phase 8 Item 4 — text/csv body upload", () => {
  it("server registers a SCOPED text/csv + application/csv parser (not global)", () => {
    expect(SERVER_SRC).toMatch(
      /addContentTypeParser\(\s*"text\/csv"/,
    );
    expect(SERVER_SRC).toMatch(
      /addContentTypeParser\(\s*"application\/csv"/,
    );
    // parsed as a raw string with a hard size cap (not a global text parser).
    expect(SERVER_SRC).toMatch(/parseAs:\s*"string",\s*bodyLimit:\s*256\s*\*\s*1024/);
  });

  it("csv route accepts JSON {csv} AND raw text/csv, and rejects other types with 415", () => {
    expect(ROUTE_SRC).toMatch(/ct\.includes\("application\/json"\)/);
    expect(ROUTE_SRC).toMatch(/ct\.includes\("text\/csv"\)\s*\|\|\s*ct\.includes\("application\/csv"\)/);
    expect(ROUTE_SRC).toMatch(/code\(415\)[\s\S]*?unsupported_media_type/);
  });

  it("csv import writes audit events and never logs raw CSV content", () => {
    // Audit on both start + completion of a CSV-sourced batch.
    expect(ROUTE_SRC).toMatch(/ORG_BULK_INVITATION_STARTED[\s\S]*?source: "csv"/);
    expect(ROUTE_SRC).toMatch(/ORG_BULK_INVITATION_COMPLETED/);
    // The raw CSV text is never logged.
    expect(ROUTE_SRC).not.toMatch(/console\.(log|info|warn|error)\([^)]*csvText/);
    expect(ROUTE_SRC).not.toMatch(/log(ger)?[^\n]*csvText/);
  });

  it("csv route stays ORG_ADMIN-gated (personal/pro/team cannot use it)", () => {
    // Same preHandler + org-admin gate as the rest of the plugin.
    expect(ROUTE_SRC).toMatch(/minRole: "ORG_ADMIN"/);
    expect(ROUTE_SRC).toContain('app.post("/v1/orgs/:id/invites/csv"');
  });
});

// =============================================================================
// Group 1 — CSV parser (pure)
// =============================================================================
describe("Phase 8 Group 1 — RFC4180-tolerant CSV parser", () => {
  it("parses a simple header + rows", () => {
    const recs = parseCsv("email,role\r\na@x.com,ORG_MEMBER\r\nb@x.com,ORG_AUDITOR\r\n");
    expect(recs).toHaveLength(3);
    expect(recs[0]!.fields).toEqual(["email", "role"]);
    expect(recs[1]!.fields).toEqual(["a@x.com", "ORG_MEMBER"]);
    expect(recs[1]!.line).toBe(2);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const recs = parseCsv('email,note\r\n"a@x.com","hello, ""world"""\r\n');
    expect(recs[1]!.fields[0]).toBe("a@x.com");
    expect(recs[1]!.fields[1]).toBe('hello, "world"');
  });

  it("tolerates LF-only line endings and a missing trailing newline", () => {
    const recs = parseCsv("email\na@x.com\nb@x.com");
    expect(recs).toHaveLength(3);
    expect(recs[2]!.fields[0]).toBe("b@x.com");
  });

  it("skips fully-blank rows", () => {
    const recs = parseCsv("email\n\na@x.com\n\n");
    expect(recs.map((r) => r.fields[0])).toEqual(["email", "a@x.com"]);
  });

  it("csvToRows requires an email header and ignores unknown columns", () => {
    const bad = csvToRows("name,role\nAlice,ORG_MEMBER");
    expect(bad.ok).toBe(false);

    const good = csvToRows("email,role,extra\na@x.com,ORG_AUDITOR,ignored\nb@x.com,,x");
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.rows).toHaveLength(2);
      expect(good.rows[0]).toMatchObject({ email: "a@x.com", role: "ORG_AUDITOR", line: 2 });
      // Empty role cell → undefined (falls back to default server-side).
      expect(good.rows[1]!.role).toBeUndefined();
      // Line numbers reflect the source CSV line for row-level error reporting.
      expect(good.rows[1]!.line).toBe(3);
    }
  });

  it("csvToRows rejects an empty CSV", () => {
    expect(csvToRows("").ok).toBe(false);
  });
});

// =============================================================================
// Group 2 — email + domain + policy helpers (pure)
// =============================================================================
describe("Phase 8 Group 2 — email / domain / policy helpers", () => {
  it("validates email shape", () => {
    expect(isValidEmail("a@x.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@x")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });

  it("normalizes emails (trim + lowercase)", () => {
    expect(normalizeEmail("  A@X.COM  ")).toBe("a@x.com");
  });

  it("extracts the email domain", () => {
    expect(domainOfEmail("a@Acme.COM")).toBe("acme.com");
    expect(domainOfEmail("broken")).toBeNull();
  });

  it("reads the restriction policy under multiple honest shapes", () => {
    expect(isRestrictionPolicyEnabled(true)).toBe(true);
    expect(isRestrictionPolicyEnabled({ enabled: true })).toBe(true);
    expect(isRestrictionPolicyEnabled({ value: true })).toBe(true);
    expect(isRestrictionPolicyEnabled(false)).toBe(false);
    expect(isRestrictionPolicyEnabled({ enabled: false })).toBe(false);
    expect(isRestrictionPolicyEnabled(null)).toBe(false);
  });

  it("exposes a 200-row cap and the domain policy key", () => {
    expect(BULK_INVITE_MAX_ROWS).toBe(200);
    expect(INVITE_DOMAIN_RESTRICTION_KEY).toBe("invite.restrict_to_verified_domains");
  });
});

// =============================================================================
// Group 3 — route plugin hard rules (source-contract)
// =============================================================================
describe("Phase 8 Group 3 — bulk-invite route plugin contract", () => {
  it("exports a registrable Fastify plugin function", () => {
    expect(ROUTE_SRC).toMatch(/export async function organizationsBulkInviteRoutes\(app: FastifyInstance\)/);
  });

  it("declares all five bulk/CSV endpoints", () => {
    expect(ROUTE_SRC).toContain('"/v1/orgs/:id/invites/bulk/validate"');
    expect(ROUTE_SRC).toContain('"/v1/orgs/:id/invites/bulk"');
    expect(ROUTE_SRC).toContain('"/v1/orgs/:id/invites/bulk/resend"');
    expect(ROUTE_SRC).toContain('"/v1/orgs/:id/invites/csv-template"');
    expect(ROUTE_SRC).toContain('"/v1/orgs/:id/invites/csv"');
  });

  it("gates every endpoint with the ORG_ADMIN requireOrgAdmin + requireAuth chain", () => {
    expect(ROUTE_SRC).toMatch(/checkOrgAccess\(prisma, \{[\s\S]*?minRole: "ORG_ADMIN"/);
    expect(ROUTE_SRC).toContain("const preHandler = [requireAuth, requireLegalAcceptance]");
    // Anti-enumeration: not_found AND forbidden both return 404.
    expect(ROUTE_SRC).toMatch(/if \(result\.kind !== "ok"\) return \{ ok: false, code: 404 \}/);
  });

  it("enforces the 200-row cap WITHOUT silently dropping (truthful truncation note)", () => {
    expect(ROUTE_SRC).toMatch(/rows\.length <= BULK_INVITE_MAX_ROWS/);
    expect(ROUTE_SRC).toMatch(/truncated:/);
    expect(ROUTE_SRC).toMatch(/were not processed/);
  });

  it("reuses the SAME single-invite writes + ORG_MEMBER_INVITED audit (no second invite system)", () => {
    // The execute path writes OrganizationInvite with a SHA-256 token hash and
    // a NULL raw token — identical to organizations.routes.ts.
    expect(ROUTE_SRC).toMatch(/tx\.organizationInvite\.create/);
    expect(ROUTE_SRC).toMatch(/tokenHash/);
    expect(ROUTE_SRC).toMatch(/token: null/);
    expect(ROUTE_SRC).toMatch(/eventType: "ORG_MEMBER_INVITED"/);
    // Never grants evidence access — no Evidence/CaseAccess/reviewer prisma
    // models are ever written by this plugin (only invite + membership).
    expect(ROUTE_SRC).not.toMatch(/prisma\.evidence|tx\.evidence|caseAccess|evidenceAccess/i);
  });

  it("emits ORG_BULK_INVITATION_STARTED + _COMPLETED with a batchId", () => {
    expect(ROUTE_SRC).toMatch(/eventType: "ORG_BULK_INVITATION_STARTED"/);
    expect(ROUTE_SRC).toMatch(/eventType: "ORG_BULK_INVITATION_COMPLETED"/);
    expect(ROUTE_SRC).toMatch(/batchId = randomUUID\(\)/);
    // Individual invites carry bulkBatchId so the audit timeline groups a batch.
    expect(ROUTE_SRC).toMatch(/bulkBatchId: input\.batchId/);
  });

  it("covers the full per-row outcome vocabulary", () => {
    for (const outcome of [
      "WOULD_INVITE",
      "DUPLICATE_IN_BATCH",
      "ALREADY_MEMBER",
      "PENDING_INVITE_EXISTS",
      "INVALID_EMAIL",
      "ROLE_TOO_HIGH",
      "DOMAIN_NOT_ALLOWED",
      "SEAT_LIMIT_EXCEEDED",
      "INVITED",
      "FAILED",
    ]) {
      expect(ROUTE_SRC).toContain(outcome);
    }
  });

  it("rejects roles strictly above the actor's own (role hierarchy)", () => {
    expect(ROUTE_SRC).toMatch(/ORG_ROLE_PRECEDENCE\[role\] > actorRank/);
    expect(ROUTE_SRC).toMatch(/Cannot invite above your own role/);
  });

  it("detects duplicate-in-batch on normalized email", () => {
    expect(ROUTE_SRC).toMatch(/seenInBatch\.has\(email\)/);
    expect(ROUTE_SRC).toMatch(/outcome: "DUPLICATE_IN_BATCH"/);
  });

  it("reuses the billing-rollup seat signal (includedSeats vs member count)", () => {
    expect(ROUTE_SRC).toMatch(/includedSeats/);
    expect(ROUTE_SRC).toMatch(/_count: \{ select: \{ members: true \} \}/);
    expect(ROUTE_SRC).toMatch(/outcome: "SEAT_LIMIT_EXCEEDED"/);
    // Only when the org has an actual seat cap.
    expect(ROUTE_SRC).toMatch(/if \(seat\.hasSeatCap\)/);
  });

  it("restricts to VERIFIED org domains only when the policy is on AND domains exist", () => {
    expect(ROUTE_SRC).toMatch(/organizationDomain\.findMany/);
    expect(ROUTE_SRC).toMatch(/verifiedAt: \{ not: null \}/);
    expect(ROUTE_SRC).toMatch(/INVITE_DOMAIN_RESTRICTION_KEY/);
    // Empty verified set → do NOT restrict (honest policy expression).
    expect(ROUTE_SRC).toMatch(/verifiedDomains\.size === 0.*return \{ restrict: false/);
  });

  it("dry-run creates nothing (validate never writes an invite)", () => {
    // The validate handler calls planRows but NOT executeBatch.
    const validateBlock = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf('"/v1/orgs/:id/invites/bulk/validate"'),
      ROUTE_SRC.indexOf('"/v1/orgs/:id/invites/bulk"', ROUTE_SRC.indexOf('"/v1/orgs/:id/invites/bulk/validate"') + 10),
    );
    expect(validateBlock).toMatch(/planRows/);
    expect(validateBlock).not.toMatch(/executeBatch/);
    expect(validateBlock).toMatch(/dryRun: true/);
  });

  it("never fails the whole batch on one bad row (per-row try/catch → FAILED)", () => {
    expect(ROUTE_SRC).toMatch(/} catch \{[\s\S]*?outcome: "FAILED"/);
    expect(ROUTE_SRC).toMatch(/A single row failing NEVER fails the batch/);
  });

  it("supports CSV dry-run via ?dryRun=1", () => {
    expect(ROUTE_SRC).toMatch(/dryRun = String\(\(req\.query/);
    expect(ROUTE_SRC).toMatch(/csvToRows\(csvText\)/);
  });
});

// =============================================================================
// Group 4 — audit catalog registration
// =============================================================================
describe("Phase 8 Group 4 — audit event catalog", () => {
  it("registers the two new bulk-invitation event types", () => {
    expect(ORG_AUDIT_EVENT_TYPES).toContain("ORG_BULK_INVITATION_STARTED");
    expect(ORG_AUDIT_EVENT_TYPES).toContain("ORG_BULK_INVITATION_COMPLETED");
  });

  it("registers the Macro-Wave A2 rotation event type", () => {
    expect(ORG_AUDIT_EVENT_TYPES).toContain("ORG_INVITE_DELIVERY_ROTATED");
  });
});

// =============================================================================
// Macro-Wave A2 — durable invite delivery chain (behavioral matrix).
//
// REAL writers under proof: recordOrgInviteDeliveryPending (outbox in-tx),
// attemptInitialOrgInviteDelivery (inline first attempt), the sweep's
// atomic claim (updateMany state precondition), rotateAndSend (token
// rotation + lifecycle/binding guards), resendOrgInviteDelivery. ONLY the
// email transport is mocked. Zero raw-token leakage is asserted against
// every durable store (delivery rows + audit rows).
// =============================================================================

const ACCEPT_URL_RE = /org-invites\/([0-9a-f]{64})\/accept/;

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Extract the raw token from the accept URL handed to the (mocked) transport. */
function tokenFromSendCall(callIndex: number): string {
  const arg = deliverySendMock.mock.calls[callIndex]![0] as { text: string };
  const m = ACCEPT_URL_RE.exec(arg.text);
  if (!m) throw new Error("no accept url in email text");
  return m[1]!;
}

/**
 * The OrganizationInvite columns this world serves. Explicit (not an index of
 * any) so a column the delivery/rotation runtime starts reading cannot silently
 * come back undefined and pass a assertion by accident.
 */
type InviteRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedByUserId: string;
  token: string | null;
  tokenHash: string;
  expiresAt: Date;
} & JsonRecord;

/** The NotificationDelivery columns the durable outbox writes and reads back. */
type DeliveryRow = {
  id: string;
  eventType?: string;
  status: string;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  nextAttemptAtUtc: Date | null;
  metadata: JsonRecord | null;
  createdAt: Date;
} & JsonRecord;

function makeDeliveryWorld() {
  const invite: InviteRow = {
    id: "inv-1",
    organizationId: "org-1",
    email: "owner@acme.test",
    role: "ORG_OWNER",
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: "admin-1",
    token: null,
    tokenHash: "initial-hash",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  };
  const deliveries: DeliveryRow[] = [];
  const audits: JsonRecord[] = [];

  const world = {
    notificationDelivery: {
      create: async ({ data }: DelegateArgs) => {
        const row: DeliveryRow = {
          id: `del-${deliveries.length + 1}`,
          status: "PENDING",
          retryCount: 0,
          errorCode: null,
          errorMessage: null,
          providerMessageId: null,
          sentAtUtc: null,
          failedAtUtc: null,
          nextAttemptAtUtc: null,
          metadata: null,
          createdAt: new Date(),
          ...rec(data),
        };
        deliveries.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: DelegateArgs) => {
        const row = deliveries.find((d) => d.id === str(rec(where).id));
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: DelegateArgs) => {
        const w = rec(where);
        const inviteId = str(rec(w.metadata).equals);
        const rows = deliveries.filter(
          (d) =>
            d.eventType === str(w.eventType) &&
            (!inviteId || str(rec(d.metadata).inviteId) === inviteId),
        );
        return rows.length ? { ...rows[rows.length - 1]! } : null;
      },
      findMany: async ({ where, take }: DelegateArgs) => {
        const w = rec(where);
        // PHASE 12 POINT 5 — two shapes reach this delegate now. The SWEEP
        // query is due-bounded and retry-bounded; the RESEND query reads the
        // invite's intent CHAIN newest-first so it can act on the live end of
        // it rather than on a retired predecessor. Serving only the first
        // shape made the second throw the sweep's own guard message.
        const chainInviteId = str(rec(w.metadata).equals);
        if (chainInviteId && !w.status) {
          return deliveries
            .filter(
              (d) =>
                d.eventType === str(w.eventType) &&
                str(rec(d.metadata).inviteId) === chainInviteId,
            )
            .slice()
            .reverse()
            .slice(0, take ?? 25)
            .map((d) => ({ ...d }));
        }
        const due = rec(w.nextAttemptAtUtc).lte;
        const maxRetry = Number(rec(w.retryCount).lt);
        if (!(due instanceof Date)) throw new Error("sweep query lost its due bound");
        return deliveries
          .filter(
            (d) =>
              d.eventType === str(w.eventType) &&
              d.status === str(w.status) &&
              d.retryCount < maxRetry &&
              d.nextAttemptAtUtc instanceof Date &&
              d.nextAttemptAtUtc.getTime() <= due.getTime(),
          )
          .slice(0, take)
          .map((d) => ({ ...d }));
      },
      // The ATOMIC claim — preconditions are enforced faithfully so a
      // concurrent duplicate sweep genuinely loses the race.
      updateMany: async ({ where, data }: DelegateArgs) => {
        const w = rec(where);
        const row = deliveries.find((d) => d.id === str(w.id));
        if (!row) return { count: 0 };
        const wantStatus = str(w.status);
        if (wantStatus && row.status !== wantStatus) return { count: 0 };
        const due = rec(w.nextAttemptAtUtc).lte;
        if (due instanceof Date) {
          if (
            !(row.nextAttemptAtUtc instanceof Date) ||
            row.nextAttemptAtUtc.getTime() > due.getTime()
          ) {
            return { count: 0 };
          }
        }
        Object.assign(row, rec(data));
        return { count: 1 };
      },
      update: async ({ where, data }: DelegateArgs) => {
        const row = deliveries.find((d) => d.id === str(rec(where).id));
        if (!row) throw new Error("delivery_not_found");
        Object.assign(row, rec(data));
        return { ...row };
      },
    },
    organizationInvite: {
      findUnique: async ({ where }: DelegateArgs) =>
        invite.id === str(rec(where).id) ? { ...invite } : null,
      update: async ({ where, data }: DelegateArgs) => {
        if (invite.id !== str(rec(where).id)) throw new Error("invite_not_found");
        Object.assign(invite, rec(data));
        return { ...invite };
      },
    },
    organization: {
      findUnique: async () => ({ name: "Acme Corp" }),
    },
    user: {
      findUnique: async () => ({
        displayName: "Admin",
        email: "admin@acme.test",
      }),
    },
    organizationAuditEvent: {
      create: async ({ data }: DelegateArgs) => {
        audits.push(rec(data));
        return rec(data);
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  const client = asPrismaDouble<PrismaClient>(world);

  /** Seed the canonical outbox row (as the create-invite tx does). */
  async function seedPendingDelivery(): Promise<string> {
    const { deliveryId } = await recordOrgInviteDeliveryPending(client, {
      inviteId: invite.id,
      organizationId: invite.organizationId,
      email: invite.email,
      initiatedByUserId: "admin-1",
    });
    return deliveryId;
  }

  /** Force the row due so the sweep picks it up. */
  function makeDue(deliveryId: string) {
    const row = deliveries.find((d) => d.id === deliveryId)!;
    row.nextAttemptAtUtc = new Date(Date.now() - 1_000);
  }

  function assertNoRawTokenLeak(rawTokens: string[]) {
    const durable = JSON.stringify(deliveries) + JSON.stringify(audits);
    for (const t of rawTokens) {
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(durable).not.toContain(t);
    }
  }

  return {
    client,
    invite,
    deliveries,
    audits,
    seedPendingDelivery,
    makeDue,
    assertNoRawTokenLeak,
  };
}

describe("Macro-Wave A2 — durable invite delivery chain", () => {
  beforeEach(() => {
    deliverySendMock.mockClear();
    deliverySendMock.mockImplementation(async () => ({
      ok: true as const,
      providerMessageId: "msg-1",
    }));
  });

  it("outbox commit + inline first attempt → SENT; the accept URL exists only in the email; durable rows/audits carry no token", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();

    const row = w.deliveries[0]!;
    expect(row.eventType).toBe(ORG_INVITE_DELIVERY_EVENT_TYPE);
    expect(row.status).toBe("PENDING");
    // POINT 5 BLOCK 0.2 — ids plus the minted provider idempotency key. The
    // guarantee this line protects is that NO TOKEN and NO ACCEPT URL is in
    // the row, which is asserted exactly rather than by an equality that also
    // pins unrelated additions.
    expect(row.metadata).toMatchObject({
      inviteId: "inv-1",
      organizationId: "org-1",
    });
    // POINT 5 — the safe id pair, the minted provider key, and the bounded
    // CONTENT IDENTITY that lets a rotation be recognised as new content and
    // given its own key. Still no token and no accept URL, which is what this
    // exact key set is here to protect.
    expect(Object.keys(row.metadata as object).sort()).toEqual([
      "contentFingerprint",
      "contentVersion",
      "idempotencyKey",
      "inviteId",
      "organizationId",
    ]);

    const rawToken = "a".repeat(64);
    const state = await attemptInitialOrgInviteDelivery(
      {
        deliveryId,
        rawToken,
        organizationName: "Acme Corp",
        role: "ORG_OWNER",
        inviterDisplay: "Admin",
        expiresAt: w.invite.expiresAt,
      },
      w.client,
    );
    expect(state).toMatchObject({ status: "SENT", attempts: 1 });
    expect(deliverySendMock).toHaveBeenCalledTimes(1);
    expect(tokenFromSendCall(0)).toBe(rawToken);
    w.assertNoRawTokenLeak([rawToken]);
  });

  it("an inline attempt against an already-SENT row does NOT re-send (duplicate-invocation safety)", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    const rawToken = "b".repeat(64);
    const input = {
      deliveryId,
      rawToken,
      organizationName: "Acme Corp",
      role: "ORG_OWNER",
      expiresAt: w.invite.expiresAt,
    };
    await attemptInitialOrgInviteDelivery(input, w.client);
    const replay = await attemptInitialOrgInviteDelivery(input, w.client);
    expect(replay).toMatchObject({ status: "SENT", attempts: 1 });
    expect(deliverySendMock).toHaveBeenCalledTimes(1); // zero duplicate emails
  });

  it("delivery failure → observable PENDING with bounded error; the sweep retry ROTATES the token so the old emailed link is DEAD", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();

    // First (inline) attempt fails transiently.
    deliverySendMock.mockImplementationOnce(async () => ({
      ok: false as const,
      errorCode: "rate_limit",
      errorMessage: "429 too many requests " + "x".repeat(500),
    }));
    const firstToken = "c".repeat(64);
    const afterFail = await attemptInitialOrgInviteDelivery(
      {
        deliveryId,
        rawToken: firstToken,
        organizationName: "Acme Corp",
        role: "ORG_OWNER",
        expiresAt: w.invite.expiresAt,
      },
      w.client,
    );
    expect(afterFail).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(afterFail!.lastError!.length).toBeLessThanOrEqual(300);
    // The invite still holds its original hash — the failed attempt did
    // not rotate anything.
    expect(w.invite.tokenHash).toBe("initial-hash");

    // Sweep picks the due row up and retries WITH ROTATION.
    w.makeDue(deliveryId);
    const summary = await processDueOrgInviteDeliveries({}, w.client);
    expect(summary).toMatchObject({ pickedUp: 1, sent: 1, failed: 0 });

    // A fresh token was minted and emailed; ONLY its hash was stored.
    expect(deliverySendMock).toHaveBeenCalledTimes(2);
    const rotatedToken = tokenFromSendCall(1);
    expect(rotatedToken).not.toBe(firstToken);
    expect(w.invite.tokenHash).toBe(sha256(rotatedToken));
    expect(w.invite.token).toBeNull();
    // The PREVIOUS emailed link is dead: its hash no longer matches the
    // invite (acceptance is a tokenHash lookup).
    expect(sha256(firstToken)).not.toBe(w.invite.tokenHash);
    expect(hashOrgInviteToken(firstToken)).not.toBe(w.invite.tokenHash);

    // Rotation is audited WITHOUT the token.
    const rotation = w.audits.find(
      (a) => a.eventType === "ORG_INVITE_DELIVERY_ROTATED",
    );
    expect(rotation).toBeTruthy();
    expect(rotation!.metadata).toMatchObject({
      inviteId: "inv-1",
      deliveryId,
    });
    w.assertNoRawTokenLeak([firstToken, rotatedToken]);
  });

  it("duplicate concurrent sweeps send ZERO duplicate emails (atomic claim: exactly one wins)", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    // Put the row in retryable-PENDING shape (a prior failed attempt).
    const row = w.deliveries[0]!;
    row.retryCount = 1;
    w.makeDue(deliveryId);

    const [s1, s2] = await Promise.all([
      processDueOrgInviteDeliveries({}, w.client),
      processDueOrgInviteDeliveries({}, w.client),
    ]);
    expect(s1.pickedUp + s2.pickedUp).toBe(1);
    expect(s1.sent + s2.sent).toBe(1);
    expect(deliverySendMock).toHaveBeenCalledTimes(1);
    // POINT 5 — the rotation retired the intent it read and delivered under a
    // SUCCESSOR with its own provider key. One email either way; what changed
    // is which row records it, and that the retired one can never send again.
    expect(row.status).toBe("CANCELLED");
    expect(row.errorCode).toBe("superseded_by_rotation");
    expect(w.deliveries).toHaveLength(2);
    expect(w.deliveries[1]!.status).toBe("SENT");
  });

  it("a dead invite is never re-mailed: accepted → CANCELLED, revoked → CANCELLED, zero emails", async () => {
    for (const kill of [
      { acceptedAt: new Date() },
      { revokedAt: new Date() },
    ]) {
      deliverySendMock.mockClear();
      const w = makeDeliveryWorld();
      const deliveryId = await w.seedPendingDelivery();
      Object.assign(w.invite, kill);
      w.makeDue(deliveryId);
      const summary = await processDueOrgInviteDeliveries({}, w.client);
      expect(summary).toMatchObject({ pickedUp: 1, cancelled: 1, sent: 0 });
      expect(w.deliveries[0]!.status).toBe("CANCELLED");
      expect(deliverySendMock).not.toHaveBeenCalled();
    }
  });

  it("binding denial: a delivery row whose recipient drifted from the invite email FAILS hard with zero emails", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    w.deliveries[0]!.recipient = "attacker@evil.test";
    w.makeDue(deliveryId);
    const summary = await processDueOrgInviteDeliveries({}, w.client);
    expect(summary).toMatchObject({ pickedUp: 1, failed: 1, sent: 0 });
    expect(w.deliveries[0]!.status).toBe("FAILED");
    expect(w.deliveries[0]!.errorCode).toBe("recipient_binding_mismatch");
    expect(deliverySendMock).not.toHaveBeenCalled();
  });

  it("cross-Organization denial: a delivery row bound to a different org FAILS hard with zero emails", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    w.deliveries[0]!.metadata = {
      inviteId: "inv-1",
      organizationId: "org-OTHER",
    };
    w.makeDue(deliveryId);
    const summary = await processDueOrgInviteDeliveries({}, w.client);
    expect(summary).toMatchObject({ pickedUp: 1, failed: 1, sent: 0 });
    expect(w.deliveries[0]!.errorCode).toBe("organization_binding_mismatch");
    expect(deliverySendMock).not.toHaveBeenCalled();
  });

  it("exhausted rows (retryCount ≥ max) are never picked up again", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    w.deliveries[0]!.retryCount = ORG_INVITE_DELIVERY_MAX_ATTEMPTS;
    w.makeDue(deliveryId);
    const summary = await processDueOrgInviteDeliveries({}, w.client);
    expect(summary).toMatchObject({ pickedUp: 0 });
    expect(deliverySendMock).not.toHaveBeenCalled();
  });

  it("operator resend of a FAILED delivery rotates + re-sends; the fresh accept URL is returned once and never persisted", async () => {
    const w = makeDeliveryWorld();
    const deliveryId = await w.seedPendingDelivery();
    // Drive the row to FAILED via a permanent provider error.
    deliverySendMock.mockImplementationOnce(async () => ({
      ok: false as const,
      errorCode: "invalid_recipient",
      errorMessage: "mailbox does not exist",
    }));
    const failedToken = "d".repeat(64);
    const failedState = await attemptInitialOrgInviteDelivery(
      {
        deliveryId,
        rawToken: failedToken,
        organizationName: "Acme Corp",
        role: "ORG_OWNER",
        expiresAt: w.invite.expiresAt,
      },
      w.client,
    );
    expect(failedState).toMatchObject({ status: "FAILED", attempts: 1 });

    // Operator retry affordance.
    const resent = await resendOrgInviteDelivery(
      {
        inviteId: "inv-1",
        organizationId: "org-1",
        email: "owner@acme.test",
        actorUserId: "admin-2",
      },
      w.client,
    );
    expect(resent).toBeTruthy();
    expect(resent!.state).toMatchObject({ status: "SENT", attempts: 2 });
    expect(deliverySendMock).toHaveBeenCalledTimes(2);
    const rotatedToken = tokenFromSendCall(1);
    expect(resent!.acceptUrl).toContain(`/org-invites/${rotatedToken}/accept`);
    expect(w.invite.tokenHash).toBe(sha256(rotatedToken));
    w.assertNoRawTokenLeak([failedToken, rotatedToken]);
  });
});

// =============================================================================
// Macro-Wave A2 — wiring source-contracts (invite creation paths + sweep
// endpoint + observability surfaces).
// =============================================================================
describe("Macro-Wave A2 — delivery wiring source contracts", () => {
  const ORGS_SRC = readFileSync(
    apiPath("src/routes/organizations.routes.ts"),
    "utf8",
  );
  const PROVISIONING_SRC = readFileSync(
    apiPath("src/services/enterprise-provisioning.service.ts"),
    "utf8",
  );

  it("ALL THREE invite-creation paths commit the outbox row in the SAME transaction (single, bulk, activation-owner)", () => {
    for (const src of [ORGS_SRC, ROUTE_SRC, PROVISIONING_SRC]) {
      expect(src).toMatch(/recordOrgInviteDeliveryPending\(tx, \{/);
      expect(src).toMatch(/attemptInitialOrgInviteDelivery\(/);
    }
  });

  it("the sweep endpoint is cron-secret-guarded and delegates to the canonical sweeper", () => {
    expect(ORGS_SRC).toContain('app.post("/v1/org-invite-deliveries/process"');
    expect(ORGS_SRC).toMatch(
      /requireIntegrationCronSecret\(req, reply\);\s*\r?\n\s*if \(!ok\) return;\s*[\s\S]{0,300}processDueOrgInviteDeliveries/,
    );
  });

  it("resend surfaces re-deliver through the durable chain (single + bulk)", () => {
    expect(ORGS_SRC).toMatch(/resendOrgInviteDelivery\(\{/);
    expect(ROUTE_SRC).toMatch(/resendOrgInviteDelivery\(\{/);
  });

  it("the invite listing endpoint exposes per-invite delivery state (no tokens)", () => {
    expect(ORGS_SRC).toMatch(/getOrgInviteDeliveryStates\(/);
    expect(ORGS_SRC).toMatch(/delivery: deliveryByInvite\.get\(i\.id\) \?\? null/);
  });

  it("the delivery outbox NEVER persists a raw token or accept URL (service-level contract)", () => {
    const DELIVERY_SRC = readFileSync(
      apiPath("src/services/organization/org-invite-delivery.service.ts"),
      "utf8",
    );
    // PHASE 12 POINT 5 — this pinned an inline metadata literal that no longer
    // exists. Both intent-creating paths now build metadata through ONE
    // builder, so a successor intent minted by a rotation cannot be shaped
    // differently from the intent it replaces. The property the pin was
    // protecting is unchanged, and is asserted where it now lives: the
    // builder may write ids, a version, a bounded fingerprint and the provider
    // key, and nothing token-shaped.
    const at = DELIVERY_SRC.indexOf("function buildIntentMetadata(");
    expect(at).toBeGreaterThan(0);
    const builder = DELIVERY_SRC.slice(at, at + 900);
    expect(builder).not.toMatch(/rawToken|acceptUrl|tokenHash/);
    // Rotation stores ONLY the hash; the legacy plaintext column stays NULL.
    expect(DELIVERY_SRC).toMatch(/token: null,\s*\r?\n\s*tokenHash: newTokenHash/);
  });
});
