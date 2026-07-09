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
import { describe, expect, it } from "vitest";

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
});
