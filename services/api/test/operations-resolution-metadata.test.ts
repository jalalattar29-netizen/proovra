/**
 * PV-OPS-001 — THE RESOLUTION DECISION'S UI METADATA, PINNED TO ITS CONTRACT.
 *
 * Owner decision: the queue renders the resolution decision the server makes
 * — resolutionAuthority, resolvableByOperator, refusalCode (and a runbook
 * destination the console derives from the runbook catalog). The /admin
 * console used to offer Resolve on every open row and let the server refuse,
 * with one sentence for refusals that mean different things.
 *
 * These cases walk EVERY registered condition source, so a source added
 * tomorrow is held to the same table the server decides with
 * (manualResolutionErrorCode):
 *
 *   NO_DIRECT_RESOLUTION            -> not resolvable; CONDITION_NOT_DIRECTLY_RESOLVABLE
 *   SOURCE_TRUTH                    -> resolvable;     CONDITION_STILL_ACTIVE
 *   OPERATOR_DECISION + note        -> resolvable;     RESOLUTION_NOTE_REQUIRED
 *   OPERATOR_DECISION (no note)     -> resolvable;     no refusal
 */

import { describe, expect, it } from "vitest";

import {
  lifecycleForSourceId,
  OPERATIONS_SOURCE_LIFECYCLES,
} from "@proovra/shared-runtime";

import { projectIncident } from "../src/services/observability/incident.service.js";

const TEAM = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-10T12:00:00.000Z");

function row(over: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    teamId: TEAM,
    scope: "WORKSPACE",
    category: "REPORT",
    severity: "HIGH",
    status: "OPEN",
    title: "a stored title",
    safeSummary: "...",
    fingerprint: "no-registered-shape",
    sourceId: null,
    occurrenceCount: 1,
    firstSeenAtUtc: NOW,
    lastSeenAtUtc: NOW,
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    runbookSlug: null,
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    resolutionNote: null,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    metricSnapshot: null,
    ...over,
  } as never;
}

const expectedFor = (authority: string, requiresNote: boolean) => ({
  resolvableByOperator: authority !== "NO_DIRECT_RESOLUTION",
  refusalCode:
    authority === "NO_DIRECT_RESOLUTION"
      ? "CONDITION_NOT_DIRECTLY_RESOLVABLE"
      : authority === "SOURCE_TRUTH"
        ? "CONDITION_STILL_ACTIVE"
        : requiresNote
          ? "RESOLUTION_NOTE_REQUIRED"
          : null,
});

describe("PV-OPS-001 — every registered source projects the decision it is held to", () => {
  it("covers every authority the registry uses", () => {
    const authorities = new Set(
      OPERATIONS_SOURCE_LIFECYCLES.map((s) => s.resolutionAuthority),
    );
    // SOURCE_TRUTH and OPERATOR_DECISION are registered; NO_DIRECT_RESOLUTION
    // is also the fail-closed answer for an unregistered source (next case).
    expect(authorities.has("SOURCE_TRUTH")).toBe(true);
    expect(authorities.has("OPERATOR_DECISION")).toBe(true);
  });

  for (const source of OPERATIONS_SOURCE_LIFECYCLES) {
    it(`${source.sourceId} (${source.resolutionAuthority})`, () => {
      const lifecycle = lifecycleForSourceId(source.sourceId);
      expect(lifecycle).toBeTruthy();
      const projected = projectIncident(row({ sourceId: source.sourceId }));
      expect(projected.lifecycle.resolutionAuthority).toBe(source.resolutionAuthority);
      expect({
        resolvableByOperator: projected.lifecycle.resolvableByOperator,
        refusalCode: projected.lifecycle.refusalCode,
      }).toEqual(expectedFor(source.resolutionAuthority, source.requiresResolutionNote));
      // A resolvable condition is never offered as "manual" unless an operator
      // decides it — the older flag keeps its narrower meaning.
      expect(projected.lifecycle.manualResolution).toBe(
        source.resolutionAuthority === "OPERATOR_DECISION",
      );
    });
  }

  it("an UNREGISTERED source fails closed: not resolvable by hand, and says so", () => {
    const projected = projectIncident(
      row({ sourceId: "no.such_registered_source", fingerprint: "no-registered-shape" }),
    );
    expect(projected.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    expect(projected.lifecycle.resolvableByOperator).toBe(false);
    expect(projected.lifecycle.refusalCode).toBe("CONDITION_NOT_DIRECTLY_RESOLVABLE");
  });
});
