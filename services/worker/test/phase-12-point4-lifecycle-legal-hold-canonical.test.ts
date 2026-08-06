/**
 * PHASE 12 POINT 4 — the Report v2 lifecycle section reads the CANONICAL
 * legal-hold store.
 *
 * It previously counted the legacy scope-generic `legal_holds` table with a
 * per-query `.catch(() => 0)`. Two defects in one:
 *
 *   1. the legacy store is not the authority, so a report could disagree with
 *      the destruction gate about whether evidence is preserved;
 *   2. once the owner applies `20271108000000_legal_hold_legacy_removal`,
 *      every count would throw and be swallowed into a confident
 *      "0 active legal holds" for a workspace that has them — a false
 *      forensic claim in a signed report.
 *
 * These tests pin the canonical read and the fail-closed reporting.
 */

import { describe, expect, it } from "vitest";

import {
  loadLifecycleSummary,
  renderLifecycleSummarySection,
  type LifecycleSummaryPrisma,
} from "../src/report-v2/sections/lifecycle-summary.js";

/** The delegate shape the loader consumes (see LifecycleSummaryPrisma). */
type Delegate = LifecycleSummaryPrisma[keyof LifecycleSummaryPrisma];

const DELEGATE_NAMES = [
  "archiveTierTransition",
  "chainTransfer",
  "destructionRequest",
  "evidenceLegalHold",
  "intelligenceActivityEvent",
  "retentionPolicyConfig",
] as const;

type DelegateName = (typeof DELEGATE_NAMES)[number];

/** Delegate answering every read with an empty result, recording what it saw. */
function emptyDelegate(name: string, touched: string[]): Delegate {
  return {
    count: async () => {
      touched.push(`${name}.count`);
      return 0;
    },
    groupBy: async () => {
      touched.push(`${name}.groupBy`);
      return [];
    },
    findMany: async () => {
      touched.push(`${name}.findMany`);
      return [];
    },
    findFirst: async () => {
      touched.push(`${name}.findFirst`);
      return null;
    },
    aggregate: async () => {
      touched.push(`${name}.aggregate`);
      return {};
    },
  };
}

/** A delegate whose reads all throw — the "store is unreadable" case. */
function throwingDelegate(message: string): Delegate {
  const boom = async () => {
    throw new Error(message);
  };
  return {
    count: boom,
    groupBy: boom,
    findMany: boom,
    findFirst: boom,
    aggregate: boom,
  };
}

function makePrisma(overrides: Partial<Record<DelegateName, Delegate>> = {}): {
  client: LifecycleSummaryPrisma;
  touched: string[];
} {
  const touched: string[] = [];
  const client = {} as LifecycleSummaryPrisma;
  for (const name of DELEGATE_NAMES) {
    client[name] = overrides[name] ?? emptyDelegate(name, touched);
  }
  return { client, touched };
}

describe("Phase 12 Point 4 — lifecycle summary legal holds", () => {
  it("counts the CANONICAL evidenceLegalHold store, never the legacy one", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const canonical: Delegate = {
      count: async (args?: unknown) => {
        seen.push((args as { where: Record<string, unknown> }).where);
        return 3;
      },
      groupBy: async () => [{ scope: "EVIDENCE", _count: { _all: 3 } }],
      findMany: async () => [],
      findFirst: async () => null,
      aggregate: async () => ({}),
    };
    const { client, touched } = makePrisma({ evidenceLegalHold: canonical });

    const data = await loadLifecycleSummary({ prisma: client, teamId: "team-1" });

    expect(data).not.toBeNull();
    // The legacy `legalHold` delegate is not part of the declared surface, so a
    // legacy read cannot even compile — and nothing touched one at runtime.
    expect(touched.some((t) => t.startsWith("legalHold."))).toBe(false);
    // Filtered on the canonical `status` column, not the legacy `state`.
    expect(seen.map((w) => w.status)).toEqual(["ACTIVE", "RELEASED", "EXPIRED"]);
    expect(seen.every((w) => w.teamId === "team-1")).toBe(true);
    expect(data!.legalHolds.available).toBe(true);
    expect(data!.legalHolds.totalActive).toBe(3);
    expect(data!.legalHolds.byKind).toEqual({ EVIDENCE: 3 });
  });

  it("an unreadable hold store reports UNAVAILABLE, never '0 active'", async () => {
    const { client } = makePrisma({
      evidenceLegalHold: throwingDelegate(
        'relation "evidence_legal_holds" does not exist',
      ),
    });

    const data = await loadLifecycleSummary({ prisma: client, teamId: "team-1" });

    expect(data).not.toBeNull();
    expect(data!.legalHolds.available).toBe(false);

    const html = renderLifecycleSummarySection(data);
    // The section still renders, and it says the control could not be read
    // instead of asserting a count.
    expect(html).toContain('data-legal-hold-unavailable="true"');
    expect(html).not.toMatch(/0 active · 0 released · 0 expired/);
  });
});
