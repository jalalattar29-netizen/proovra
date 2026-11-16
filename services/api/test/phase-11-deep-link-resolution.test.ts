/**
 * PHASE 11 — canonical deep-link resolution: the URL is never authoritative
 * tenant truth. The authoritative Workspace comes from the PERSISTED resource;
 * a URL-declared workspace must match it; every denial conceals as 404.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ authAllowed: true, actorUserId: "u1", teamId: "team-of-resource" }));

vi.mock("../src/middleware/authorize.js", () => ({
  evaluateAuthorize: async (_req: unknown, opts: { teamId: string }) =>
    H.authAllowed
      ? { allowed: true, actorUserId: H.actorUserId, teamId: opts.teamId }
      : { allowed: false, reasonCode: "not_a_member", httpStatus: 403 },
}));

import { resolveDeepLink } from "../src/services/identity/deep-link-resolution.service.js";

function client(teamId: string | null, closed = 0) {
  const row = teamId === null ? null : { teamId };
  // B2A-F-07 — `count` answers the record-reach rule (restricted-case closure).
  return {
    evidence: { findUnique: async () => row, count: async () => closed },
    case: { findUnique: async () => row, count: async () => closed },
    evidenceRequest: { findUnique: async () => (row ? { ...row, evidenceId: null, caseId: "c-1" } : null) },
    report: { findUnique: async () => (row ? { evidenceId: "ev-1", evidence: { teamId: row.teamId } } : null) },
  } as never;
}
const req = {} as never;

afterEach(() => { H.authAllowed = true; });

describe("Phase 11 — resolveDeepLink", () => {
  it("resolves the authoritative Workspace from the PERSISTED resource + authorizes", async () => {
    const d = await resolveDeepLink(req, { resourceType: "evidence", resourceId: "ev-1" }, client("team-A"));
    expect(d).toMatchObject({ ok: true, teamId: "team-A", resourceType: "evidence", resourceId: "ev-1" });
  });

  it("missing resource → concealed 404 (anti-enumeration)", async () => {
    const d = await resolveDeepLink(req, { resourceType: "evidence", resourceId: "nope" }, client(null));
    expect(d).toMatchObject({ ok: false, reason: "not_found", httpStatus: 404 });
  });

  it("URL-declared workspace that mismatches persistence → concealed 404 (no override)", async () => {
    const d = await resolveDeepLink(
      req,
      { resourceType: "evidence", resourceId: "ev-1", declaredWorkspaceId: "team-B" },
      client("team-A"),
    );
    expect(d).toMatchObject({ ok: false, reason: "context_mismatch", httpStatus: 404 });
  });

  it("declared workspace that MATCHES persistence → allowed", async () => {
    const d = await resolveDeepLink(
      req,
      { resourceType: "evidence", resourceId: "ev-1", declaredWorkspaceId: "team-A" },
      client("team-A"),
    );
    expect(d.ok).toBe(true);
  });

  it("authz denial (lifecycle/policy/membership/capability) → concealed 404, never leaks reason", async () => {
    H.authAllowed = false;
    const d = await resolveDeepLink(req, { resourceType: "evidence", resourceId: "ev-1" }, client("team-A"));
    expect(d).toMatchObject({ ok: false, reason: "unauthorized", httpStatus: 404 });
  });

  it("B2A-F-07 — cases, investigations and evidence requests resolve with their read authority (evidence.read + reach)", async () => {
    for (const resourceType of ["cases", "investigation", "evidence-requests"] as const) {
      const d = await resolveDeepLink(req, { resourceType, resourceId: "c-1" }, client("team-A"));
      expect(d, resourceType).toMatchObject({ ok: true, teamId: "team-A" });
    }
  });

  it("B2A-F-07 — a case or request closed to the caller by a restricted case is concealed (404)", async () => {
    for (const resourceType of ["cases", "evidence-requests", "evidence"] as const) {
      const d = await resolveDeepLink(req, { resourceType, resourceId: "c-1" }, client("team-A", 1));
      expect(d, resourceType).toMatchObject({ ok: false, reason: "unauthorized", httpStatus: 404 });
    }
  });

  it("B2A-F-07 — a report id binds to its parent record's workspace", async () => {
    const d = await resolveDeepLink(req, { resourceType: "reports", resourceId: "r-1" }, client("team-R"));
    expect(d).toMatchObject({ ok: true, teamId: "team-R" });
  });

  it("B2A-F-07 — review / audit-transparency carry no id-bearing page: explicit unsupported type (no lookup)", async () => {
    for (const resourceType of ["review", "audit-transparency"] as const) {
      const d = await resolveDeepLink(req, { resourceType, resourceId: "x" }, client("team-A"));
      expect(d, resourceType).toMatchObject({ ok: false, reason: "unsupported_type", httpStatus: 422 });
    }
  });

  it("that same family WITH an explicit capability resolves + authorizes", async () => {
    const d = await resolveDeepLink(
      req,
      { resourceType: "cases", resourceId: "c-1", permission: "evidence.read" as never },
      client("team-A"),
    );
    expect(d.ok).toBe(true);
  });
});
