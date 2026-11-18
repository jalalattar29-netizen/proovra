/**
 * PRO-AI1-05 — a copilot citation links to the VALIDATED object's own page,
 * derived by the server; the model's route is never rendered, and a
 * protocol-relative route is rejected. At the base SHA a model route of
 * "//example.org/x" or "/settings/billing" was kept for a valid evidence id.
 */
import { describe, expect, it } from "vitest";

import {
  isSafeInAppRoute,
  projectValidatedCitations,
  validateCitations,
  type AiCitation,
  type CitationResolver,
} from "../src/services/ai/ai-citation.service.js";

const EVIDENCE = "11111111-1111-4111-8111-111111111111";

const resolver: CitationResolver = async (type, id) =>
  type === "EVIDENCE_RECORD" && id === EVIDENCE
    ? { workspaceId: "ws-1", currentVersion: null, deleted: false, authorized: true, route: `/evidence/${id}` }
    : null;

function cite(route: string): AiCitation {
  return {
    type: "EVIDENCE_RECORD",
    objectId: EVIDENCE,
    displayLabel: "Record",
    sourceField: null,
    objectVersion: null,
    timestampUtc: null,
    route,
    workspaceId: "ws-1",
    analyzedAtUtc: new Date().toISOString(),
  } as AiCitation;
}

describe("PRO-AI1-05 — server-bound citation routes", () => {
  it("a protocol-relative model route is rejected", async () => {
    const r = await validateCitations([cite("//example.org/x")], { workspaceId: "ws-1" }, resolver);
    expect(r.valid).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("MALFORMED_ROUTE");
    expect(isSafeInAppRoute("//example.org/x")).toBe(false);
    expect(isSafeInAppRoute("/evidence/x")).toBe(true);
  });

  it("an unrelated in-app model route is replaced by the cited object's own page", async () => {
    const r = await validateCitations([cite("/settings/billing")], { workspaceId: "ws-1" }, resolver);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.route).toBe(`/evidence/${EVIDENCE}`);
    const out = projectValidatedCitations(
      [{ type: "EVIDENCE_RECORD", objectId: EVIDENCE, displayLabel: "Record", route: "/settings/billing", objectVersion: null }],
      r,
    );
    expect(out).toEqual([
      expect.objectContaining({ objectId: EVIDENCE, route: `/evidence/${EVIDENCE}` }),
    ]);
  });

  it("an invalid citation cannot ride on a valid one's id under another type", async () => {
    const r = await validateCitations([cite("/x")], { workspaceId: "ws-1" }, resolver);
    const out = projectValidatedCitations(
      [
        { type: "EVIDENCE_RECORD", objectId: EVIDENCE, route: "/x" },
        { type: "CASE", objectId: EVIDENCE, route: "/x" },
      ],
      r,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("EVIDENCE_RECORD");
  });
});
