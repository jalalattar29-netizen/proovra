/**
 * Phase C3–C6 — Copilot foundations (behavioral).
 * C3 context resolvers · C4 citation validation · C5 schemas · C6 human control.
 */
import { describe, expect, it } from "vitest";

import {
  buildAllowlistedFields,
  buildEvidenceContext,
  sanitizeContextScalar,
  EVIDENCE_CONTEXT_ALLOWLIST,
} from "../src/services/ai/ai-context-resolver.service.js";
import {
  validateCitations,
  hasGrounding,
  type AiCitation,
  type CitationResolver,
} from "../src/services/ai/ai-citation.service.js";
import {
  COPILOT_SCHEMAS,
  FORBIDDEN_SCHEMA_KEYS,
  schemaKeys,
  validateCopilotOutput,
} from "../src/services/ai/ai-copilot-schemas.js";
import {
  buildSuggestedAction,
  isCriticalAction,
  ForbiddenAiActionError,
} from "../src/services/ai/ai-suggested-action.service.js";

// ---- C3 ----
describe("C3 — context is allowlisted, sanitized, versioned; no raw record", () => {
  const base = {
    route: "/evidence/[redacted]",
    routeClass: "EVIDENCE" as const,
    role: "OWNER",
    workspaceId: "ws-1",
    workspacePolicyVersion: 1,
    enabledCapabilities: [] as never[],
    dataMode: "METADATA_ONLY" as const,
  };
  it("strips secrets, signed URLs, precise GPS from scalars", () => {
    expect(sanitizeContextScalar("https://s3/x?X-Amz-Signature=abc")).toMatch(/\[redacted-url\]/);
    expect(sanitizeContextScalar("Bearer sk-abcdefghijklmnop")).toMatch(/\[redacted-secret\]/);
    expect(sanitizeContextScalar("37.42199,-122.08421")).toMatch(/\[redacted-location\]/);
    expect(sanitizeContextScalar(5)).toBe(5);
  });
  it("drops non-allowlisted keys", () => {
    const out = buildAllowlistedFields(
      { title: "Photo", storagePath: "/secret/path", downloadUrl: "https://x?token=1", ssn: "123" },
      EVIDENCE_CONTEXT_ALLOWLIST,
    );
    expect(out).toHaveProperty("title");
    expect(out).not.toHaveProperty("storagePath");
    expect(out).not.toHaveProperty("downloadUrl");
    expect(out).not.toHaveProperty("ssn");
  });
  it("evidence context binds id/version and never carries the raw row", () => {
    const ctx = buildEvidenceContext(base, {
      id: "ev-1", teamId: "ws-1", title: "A", status: "SIGNED",
      verificationPackageVersion: 3, storagePath: "/internal/x", signingKeyPem: "-----BEGIN-----",
    });
    expect(ctx.objectId).toBe("ev-1");
    expect(ctx.objectVersion).toBe(3);
    expect(ctx.objectType).toBe("EVIDENCE_RECORD");
    expect(Object.keys(ctx.fields)).not.toContain("storagePath");
    expect(Object.keys(ctx.fields)).not.toContain("signingKeyPem");
    expect(JSON.stringify(ctx)).not.toMatch(/BEGIN|storagePath/);
  });
});

// ---- C4 ----
describe("C4 — citations are server-validated fail-closed", () => {
  const cite = (over: Partial<AiCitation> = {}): AiCitation => ({
    type: "EVIDENCE_RECORD", objectId: "ev-1", displayLabel: "Evidence", sourceField: "status",
    objectVersion: 2, timestampUtc: null, route: "/evidence/ev-1", workspaceId: "ws-1",
    analyzedAtUtc: "2026-07-12T00:00:00Z", ...over,
  });
  const resolver: CitationResolver = async (_type, id) => {
    if (id === "gone") return null;
    if (id === "deleted") return { workspaceId: "ws-1", currentVersion: 2, deleted: true, authorized: true };
    if (id === "other-ws") return { workspaceId: "ws-2", currentVersion: 2, deleted: false, authorized: true };
    if (id === "stale") return { workspaceId: "ws-1", currentVersion: 9, deleted: false, authorized: true };
    if (id === "denied") return { workspaceId: "ws-1", currentVersion: 2, deleted: false, authorized: false };
    return { workspaceId: "ws-1", currentVersion: 2, deleted: false, authorized: true };
  };
  const ctx = { workspaceId: "ws-1" };

  it("accepts a valid citation", async () => {
    const r = await validateCitations([cite()], ctx, resolver);
    expect(r.valid.length).toBe(1);
    expect(hasGrounding(r)).toBe(true);
  });
  it("rejects invented (not found), cross-tenant, stale-version, deleted, unauthorized, malformed route", async () => {
    const r = await validateCitations([
      cite({ objectId: "gone" }),
      cite({ objectId: "other-ws" }),
      cite({ objectId: "stale" }),
      cite({ objectId: "deleted" }),
      cite({ objectId: "denied" }),
      cite({ route: "javascript:alert(1)" }),
      cite({ workspaceId: "ws-2" }),
    ], ctx, resolver);
    expect(r.valid.length).toBe(0);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons).toContain("NOT_FOUND");
    expect(reasons).toContain("CROSS_TENANT");
    expect(reasons).toContain("VERSION_MISMATCH");
    expect(reasons).toContain("DELETED");
    expect(reasons).toContain("NOT_AUTHORIZED");
    expect(reasons).toContain("MALFORMED_ROUTE");
  });
});

// ---- C5 ----
describe("C5 — schemas exclude verdict fields; strict parse + fallback", () => {
  it("no Copilot schema contains a forbidden verdict key", () => {
    for (const surface of Object.keys(COPILOT_SCHEMAS) as Array<keyof typeof COPILOT_SCHEMAS>) {
      const keys = schemaKeys(surface);
      for (const forbidden of FORBIDDEN_SCHEMA_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
      expect(keys).toContain("citations");
      expect(keys).toContain("advisoryBoundary");
    }
  });
  it("invalid output → safe fallback (never raw)", () => {
    const r = validateCopilotOutput("CASE", { caseSummary: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fallback.error).toBe("SCHEMA_MISMATCH");
  });
});

// ---- C6 ----
describe("C6 — AI cannot execute; critical actions never suggestable", () => {
  const meta = { promptVersion: "1", modelVersion: "gpt-4.1-mini", contextSchemaVersion: "1", outputSchemaVersion: "1" };
  it("critical actions throw ForbiddenAiActionError", () => {
    for (const a of ["LEGAL_HOLD_RELEASE", "DESTRUCTION", "EVIDENCE_DELETE", "SIGNER_LIFECYCLE", "FINAL_REVIEWER_DECISION"]) {
      expect(isCriticalAction(a)).toBe(true);
      expect(() => buildSuggestedAction({
        actionType: a, displayLabel: "x", reason: "y",
        affectedObject: { type: "EVIDENCE", id: "ev-1", version: 1 },
        proposedChange: {}, requiredPermission: "p", citations: [], versionMeta: meta,
      })).toThrow(ForbiddenAiActionError);
    }
  });
  it("a suggestable action is a proposal requiring confirmation", () => {
    const s = buildSuggestedAction({
      actionType: "GENERATE_REPORT", displayLabel: "Generate Report", reason: "no report yet",
      affectedObject: { type: "EVIDENCE_RECORD", id: "ev-1", version: 2 },
      proposedChange: { reportVersion: 1 }, requiredPermission: "evidence.report.generate", citations: [], versionMeta: meta,
    });
    expect(s.confirmationRequired).toBe(true);
    expect(s.suggestionId).toHaveLength(32);
    expect(s.actionType).toBe("GENERATE_REPORT");
  });
  it("non-allowlisted action is rejected", () => {
    expect(() => buildSuggestedAction({
      actionType: "DROP_TABLE", displayLabel: "x", reason: "y",
      affectedObject: { type: "X", id: "1", version: null },
      proposedChange: {}, requiredPermission: "p", citations: [], versionMeta: meta,
    })).toThrow(ForbiddenAiActionError);
  });
});
