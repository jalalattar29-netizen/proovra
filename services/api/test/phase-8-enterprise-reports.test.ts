/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE C.
 * Enterprise OPERATIONAL reports (CSV exports over EXISTING real data).
 *
 * Two styles, matching the sibling phase-8 API suites:
 *
 *   (A) BEHAVIOURAL — over the pure `csv-export` serializer. Proves the
 *       RFC-4180 escaping + CRLF shape + honest header-only-on-empty
 *       behaviour that every report reuses. No DB / no server boot.
 *
 *   (B) SOURCE-CONTRACT — over organizations-reports.routes.ts. Pins the
 *       constitutional invariants that can't drift without breaking the
 *       scope: each export uses the REAL underlying query (not fabricated
 *       data), the correct org-role gate, an ORG_REPORT_EXPORTED audit
 *       write, the honest-unavailable download-audit, and the "no Stripe
 *       ids in seats.csv" guarantee.
 *
 * Runs under `vitest run` (services/api test convention).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  csvEscape,
  toCsv,
  csvDownloadHeaders,
  type CsvColumn,
} from "../src/services/reporting/csv-export.js";

const ROUTES = readFileSync(
  fileURLToPath(
    new URL("../src/routes/organizations-reports.routes.ts", import.meta.url),
  ),
  "utf8",
);

const CSV_HELPER = readFileSync(
  fileURLToPath(
    new URL("../src/services/reporting/csv-export.ts", import.meta.url),
  ),
  "utf8",
);

// ===========================================================================
// (A) BEHAVIOURAL — the shared CSV serializer.
// ===========================================================================

describe("Phase 8 reports — csv-export serializer (RFC-4180 + honest shape)", () => {
  it("csvEscape quotes fields containing comma / quote / CR / LF and doubles quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('has "quote"')).toBe('"has ""quote"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("cr\rlf")).toBe('"cr\rlf"');
  });

  it("csvEscape renders null/undefined as the empty string (honest, not 'null')", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("toCsv emits a header line + CRLF-joined rows with correct coercion", () => {
    type Row = { a: string; b: number | null; c: boolean };
    const cols: CsvColumn<Row>[] = [
      { header: "a", value: (r) => r.a },
      { header: "b", value: (r) => r.b },
      { header: "c", value: (r) => r.c },
    ];
    const csv = toCsv(
      [
        { a: "x,y", b: 3, c: true },
        { a: "z", b: null, c: false },
      ],
      cols,
    );
    expect(csv).toBe('a,b,c\r\n"x,y",3,true\r\nz,,false');
  });

  it("toCsv on an EMPTY dataset returns header-only (never a fabricated row)", () => {
    type Row = { id: string };
    const csv = toCsv<Row>([], [{ header: "id", value: (r) => r.id }]);
    expect(csv).toBe("id");
    // A single line = headers only, zero data rows.
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("csvDownloadHeaders sets the canonical text/csv attachment headers", () => {
    const h = csvDownloadHeaders("org-members.csv");
    expect(h["content-type"]).toBe("text/csv; charset=utf-8");
    expect(h["content-disposition"]).toBe(
      'attachment; filename="org-members.csv"',
    );
  });

  it("csvDownloadHeaders rejects an unsafe filename (header-injection guard)", () => {
    const h = csvDownloadHeaders('evil"; drop\ntable');
    expect(h["content-disposition"]).toBe('attachment; filename="report.csv"');
  });

  it("the serializer contains NO data-fetch logic (it only serializes)", () => {
    // Honesty guard: the shared helper must never import prisma / query the
    // DB. Data resolution belongs to the route layer.
    expect(CSV_HELPER).not.toContain("prisma");
    expect(CSV_HELPER).not.toContain("findMany");
  });
});

// ===========================================================================
// (B) SOURCE-CONTRACT — the report routes.
// ===========================================================================

describe("Phase 8 reports — endpoints exist over the six operational reports", () => {
  const ENDPOINTS = [
    "members.csv",
    "seats.csv",
    "audit.csv",
    "governance.csv",
    "external-access.csv",
    "download-audit.csv",
  ];
  for (const file of ENDPOINTS) {
    it(`declares GET /v1/orgs/:id/reports/${file}`, () => {
      expect(ROUTES).toContain(`/v1/orgs/:id/reports/${file}`);
    });
  }
});

describe("Phase 8 reports — reuse the shared CSV helper (no duplicated escape logic)", () => {
  it("imports toCsv + csvDownloadHeaders from the shared reporting helper", () => {
    expect(ROUTES).toMatch(
      /from\s+"\.\.\/services\/reporting\/csv-export\.js"/,
    );
    expect(ROUTES).toContain("toCsv");
    expect(ROUTES).toContain("csvDownloadHeaders");
  });

  it("does NOT re-declare its own csvEscape (single source of truth)", () => {
    expect(ROUTES).not.toMatch(/function\s+csvEscape/);
  });
});

describe("Phase 8 reports — role gates mirror the backing endpoints", () => {
  it("members.csv is ORG_AUDITOR+", () => {
    expect(sliceEndpoint("members.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_AUDITOR")',
    );
  });
  it("seats.csv is ORG_BILLING_ADMIN+", () => {
    expect(sliceEndpoint("seats.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_BILLING_ADMIN")',
    );
  });
  it("audit.csv is ORG_AUDITOR+", () => {
    expect(sliceEndpoint("audit.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_AUDITOR")',
    );
  });
  it("governance.csv is ORG_AUDITOR+", () => {
    expect(sliceEndpoint("governance.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_AUDITOR")',
    );
  });
  it("external-access.csv is ORG_AUDITOR+", () => {
    expect(sliceEndpoint("external-access.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_AUDITOR")',
    );
  });
  it("download-audit.csv is ORG_AUDITOR+", () => {
    expect(sliceEndpoint("download-audit.csv")).toContain(
      'requireOrgRole(orgId, userId, "ORG_AUDITOR")',
    );
  });

  it("every non-OK access returns the anti-enumeration 404 (never distinguishes forbidden)", () => {
    // requireOrgRole returns { ok:false, code:404 } for both not_found +
    // forbidden, and each endpoint replies with that code.
    expect(ROUTES).toContain("if (!access.ok) return reply.code(access.code).send(NOT_FOUND);");
    expect(ROUTES).toMatch(/code:\s*404/);
  });
});

describe("Phase 8 reports — REAL data sources (not fabricated)", () => {
  it("members.csv reads organizationMembership (same model as /members)", () => {
    expect(sliceEndpoint("members.csv")).toContain(
      "prisma.organizationMembership.findMany",
    );
  });
  it("seats.csv reads team billing fields (same source as billing/rollup)", () => {
    const s = sliceEndpoint("seats.csv");
    expect(s).toContain("prisma.team.findMany");
    expect(s).toContain("_count: { select: { members: true } }");
  });
  it("audit.csv reads organizationAuditEvent (same model as /audit-events)", () => {
    expect(sliceEndpoint("audit.csv")).toContain(
      "prisma.organizationAuditEvent.findMany",
    );
  });
  it("governance.csv reads the published retention policy", () => {
    expect(sliceEndpoint("governance.csv")).toContain(
      "prisma.organizationPolicy.findUnique",
    );
  });
  it("external-access.csv reads ExternalReviewerRoleAssignment scoped to org workspaces", () => {
    const s = sliceEndpoint("external-access.csv");
    expect(s).toContain("prisma.externalReviewerRoleAssignment.findMany");
    // Scoped by the org's resolved team ids (org workspaces), not global.
    expect(s).toContain("teamId: { in: teamIds }");
  });
});

describe("Phase 8 reports — seats.csv carries NO payment/Stripe identifiers", () => {
  it("selects only counts + names, never Stripe / customer / subscription ids", () => {
    const s = sliceEndpoint("seats.csv");
    expect(s.toLowerCase()).not.toContain("stripe");
    expect(s.toLowerCase()).not.toContain("subscriptionid");
    expect(s.toLowerCase()).not.toContain("customerid");
    expect(s.toLowerCase()).not.toContain("paymentmethod");
  });
});

describe("Phase 8 reports — external-access.csv never exposes tokens / secrets", () => {
  it("selects neither rawToken, tokenHash, nor ssoSubjectHash", () => {
    const s = sliceEndpoint("external-access.csv");
    expect(s).not.toContain("rawToken");
    expect(s).not.toContain("tokenHash");
    expect(s).not.toContain("ssoSubjectHash");
  });
});

describe("Phase 8 reports — audit.csv is bounded + signals truncation honestly", () => {
  it("caps the query and detects truncation via take = cap + 1", () => {
    const s = sliceEndpoint("audit.csv");
    expect(s).toContain("take: AUDIT_ROW_CAP + 1");
    expect(s).toContain("const truncated = events.length > AUDIT_ROW_CAP");
    expect(s).toContain('reply.header("x-report-truncated", "true")');
  });
  it("supports an ?eventType= filter", () => {
    expect(sliceEndpoint("audit.csv")).toContain("eventType: { in: eventTypeFilter }");
  });
});

describe("Phase 8 reports — every export writes an ORG_REPORT_EXPORTED audit event", () => {
  it("calls auditExport with report name + row count on each endpoint", () => {
    // Six endpoints → six auditExport calls.
    const calls = ROUTES.match(/auditExport\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });
  it("auditExport emits eventType ORG_REPORT_EXPORTED with { report, rowCount }", () => {
    expect(ROUTES).toContain('eventType: "ORG_REPORT_EXPORTED"');
    expect(ROUTES).toContain("metadata: { report, rowCount");
  });
  it("ORG_REPORT_EXPORTED is registered in the org-audit catalog", () => {
    const catalog = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/organization/org-audit.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(catalog).toContain('"ORG_REPORT_EXPORTED"');
  });
});

describe("Phase 8 reports — download-audit is HONEST-unavailable (never 500, never fabricated)", () => {
  const s = () => sliceEndpoint("download-audit.csv");
  it("returns 200 with a documented not-available note, not an error", () => {
    expect(s()).toContain("not_available_at_org_tier");
    expect(s()).toContain('reply.header("x-report-available", "false")');
  });
  it("does NOT throw / 500 and does NOT invent download rows", () => {
    const block = s();
    expect(block).not.toContain("throw new Error");
    expect(block).not.toContain(".code(500)");
    // No evidence/custody query is run here — it only serves the note.
    expect(block).not.toContain("findMany");
  });
  it("audits the export with available:false + rowCount 0", () => {
    expect(s()).toContain('auditExport(orgId, userId, "download-audit", 0, {');
    expect(s()).toContain("available: false");
  });
});

describe("Phase 8 reports — does not touch the evidence PDF / signing pipeline", () => {
  it("no hashing / signing / TSA / OTS / verification-package internals", () => {
    // Ban the actual internal CALLS/identifiers. (The honest download-audit
    // NOTE legitimately mentions the words "verification package" in prose,
    // so we assert on code identifiers, not on the English phrase.)
    for (const banned of [
      "signReport",
      "computeSha256",
      "requestTsaTimestamp",
      "presignGetObject",
      "generateVerificationPackage",
    ]) {
      expect(ROUTES).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: slice one endpoint handler's source (from its route path marker to
// the next route declaration) so per-endpoint asserts don't bleed.
// ---------------------------------------------------------------------------
function sliceEndpoint(file: string): string {
  // Anchor on the actual route DECLARATION (app.get("...")), not the first
  // mention of the path (which appears in the file's header doc-comment).
  const marker = `app.get(\n    "/v1/orgs/:id/reports/${file}"`;
  const altMarker = `app.get("/v1/orgs/:id/reports/${file}"`;
  let start = ROUTES.indexOf(marker);
  if (start === -1) start = ROUTES.indexOf(altMarker);
  if (start === -1) throw new Error(`endpoint declaration not found: ${file}`);
  // The next route declaration (or EOF) bounds this handler.
  const next = ROUTES.indexOf("app.get(", start + 8);
  return ROUTES.slice(start, next === -1 ? undefined : next);
}
