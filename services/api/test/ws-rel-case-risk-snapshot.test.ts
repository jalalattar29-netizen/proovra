/**
 * WS-REL / PRO-K1-14 — reading a case does not insert a CaseRiskSnapshot on
 * every load: ten reloads with an unchanged risk persist at most one row, and
 * a changed risk is still recorded.
 *
 * The real recordCaseRiskSnapshot / computeCaseRisk over an empty in-memory
 * store (every count 0, every list empty); only db is a double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ snapshots: [] as Array<Record<string, unknown>> }));

vi.mock("../src/db.js", () => {
  const generic = (method: string) => {
    if (method === "count") return 0;
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "aggregate") return { _count: { _all: 0 }, _sum: {}, _max: {}, _min: {} };
    return null;
  };
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async () => [];
        return new Proxy(
          {},
          {
            get: (_t2, method: string) => async (args: { data?: Record<string, unknown> }) => {
              if (model === "caseRiskSnapshot" && method === "create") {
                H.snapshots.push({ ...args.data, sampledAtUtc: new Date() });
                return args.data;
              }
              if (model === "caseRiskSnapshot" && method === "findFirst") {
                return H.snapshots[H.snapshots.length - 1] ?? null;
              }
              return generic(String(method));
            },
          },
        );
      },
    },
  );
  return { prisma };
});

import { recordCaseRiskSnapshot } from "../src/services/cases/case-risk-engine.service.js";

beforeEach(() => {
  H.snapshots.length = 0;
});

describe("PRO-K1-14 case risk snapshots", () => {
  it("ten reloads with an unchanged risk persist one snapshot", async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordCaseRiskSnapshot({ teamId: "t1", caseId: "c1" });
    }
    expect(H.snapshots).toHaveLength(1);
  });

  it("a changed risk (or an old snapshot) is recorded again", async () => {
    await recordCaseRiskSnapshot({ teamId: "t1", caseId: "c1" });
    // The latest differs from what the engine now computes.
    (H.snapshots[0] as { riskScore: number }).riskScore = 99;
    await recordCaseRiskSnapshot({ teamId: "t1", caseId: "c1" });
    expect(H.snapshots).toHaveLength(2);
    (H.snapshots[1] as { sampledAtUtc: Date }).sampledAtUtc = new Date(Date.now() - 2 * 60 * 60_000);
    await recordCaseRiskSnapshot({ teamId: "t1", caseId: "c1" });
    expect(H.snapshots).toHaveLength(3);
  });
});
