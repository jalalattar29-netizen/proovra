/**
 * Production regression — PRO user must not get a false 402 on
 * POST /v1/collaboration-teams from a STALE terminal Subscription row.
 *
 * PHASE 9 STEP 5 (2026-07-22): the subscription-active + grace DECISION was
 * relocated out of billing-guards' `assertSubscriptionActiveOrGraceAllowed`
 * into ONE canonical lifecycle policy. EVIDENCE OUTPUT LIFECYCLE (2026-09-29):
 * that policy moved, rules unchanged, to `readCommercialLifecycle` in
 * `@proovra/shared-runtime`, so the worker's issuance gates read the SAME
 * answer; `resolvePaidLifecycle` in commercial-context is now a thin adapter.
 *
 * Because the policy is now a pure reader over an injected client, the four
 * branches are pinned by BEHAVIOUR instead of by source text:
 *
 *   1. Live (ACTIVE/TRIALING) matching-scope row → allow.
 *   2. Matching PAST_DUE row inside the ONE bounded grace window → allow.
 *   3. No matching-scope row → allow (authoritative field governs; tolerate
 *      webhook lag) — a stale row for a DIFFERENT plan never leaks in.
 *   4. Every matching row terminal → block (SUBSCRIPTION_INACTIVE → 402).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readCommercialLifecycle } from "@proovra/shared-runtime";

import { functionSource } from "../../../scripts/source-contract/index.mjs";

function readApi(rel: string) {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const RESOLVER = readApi("src/services/billing/commercial-context.service.ts");
const BILLING_GUARDS = readApi("src/services/collaboration-team/billing-guards.ts");
const SHARED_CODES = readFileSync(
  fileURLToPath(new URL("../../../packages/shared/src/collaboration-team-billing-codes.ts", import.meta.url)),
  "utf8",
);

type Row = {
  userId?: string;
  teamId?: string;
  plan: string;
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED";
  currentPeriodEnd: Date | null;
  updatedAt: Date;
};

/** A subscription table honouring the where-shapes the reader uses. */
function fakeClient(rows: Row[]) {
  const queries: Array<Record<string, unknown>> = [];
  const match = (where: Record<string, unknown>) => (r: Row) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === "status") {
        const s = v as string | { in: string[] };
        if (typeof s === "string" ? r.status !== s : !s.in.includes(r.status)) return false;
      } else if ((r as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
  };
  const sorted = (where: Record<string, unknown>) =>
    rows.filter(match(where)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return {
    queries,
    client: {
      subscription: {
        findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
          queries.push(args.where);
          return sorted(args.where).slice(0, args.take ?? Infinity);
        },
        findFirst: async (args: { where: Record<string, unknown> }) => {
          queries.push(args.where);
          return sorted(args.where)[0] ?? null;
        },
      },
    } as never,
  };
}

const NOW = new Date("2026-09-29T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);
const PERSONAL = { kind: "PERSONAL" as const, ownerUserId: "u1", plan: "PRO" };
const WORKSPACE = { kind: "WORKSPACE" as const, teamId: "t1", plan: "TEAM" };

describe("Phase 9 STEP 5 — canonical lifecycle no longer picks stale rows", () => {
  it("resolvePaidLifecycle is a thin adapter over the shared reader", () => {
    const fn = functionSource(RESOLVER, "resolvePaidLifecycle", "commercial-context.service.ts");
    expect(fn).toMatch(/readCommercialLifecycle\(/);
    expect(fn).not.toMatch(/subscription\.find/);
  });

  it("every query is scope-filtered: a personal subject by user AND plan, a workspace by team", async () => {
    const p = fakeClient([]);
    await readCommercialLifecycle(p.client, PERSONAL, NOW);
    expect(p.queries.length).toBeGreaterThan(0);
    for (const q of p.queries) expect(q).toMatchObject({ userId: "u1", plan: "PRO" });
    const w = fakeClient([]);
    await readCommercialLifecycle(w.client, WORKSPACE, NOW);
    for (const q of w.queries) expect(q).toMatchObject({ teamId: "t1" });
  });

  it("a stale terminal row for a DIFFERENT plan never leaks into the decision", async () => {
    const { client } = fakeClient([
      { userId: "u1", plan: "BASIC", status: "CANCELED", currentPeriodEnd: at(-30), updatedAt: at(-1) },
    ]);
    const r = await readCommercialLifecycle(client, PERSONAL, NOW);
    expect(r.state).toBe("ACTIVE");
    expect(r.mutationsAllowed).toBe(true);
  });
});

describe("Phase 9 STEP 5 — four-branch corroboration policy (behaviour)", () => {
  it("Step 1 — a live (ACTIVE/TRIALING) matching row allows", async () => {
    for (const status of ["ACTIVE", "TRIALING"] as const) {
      const { client } = fakeClient([
        { userId: "u1", plan: "PRO", status, currentPeriodEnd: at(20), updatedAt: at(-1) },
        { userId: "u1", plan: "PRO", status: "CANCELED", currentPeriodEnd: at(-60), updatedAt: at(-90) },
      ]);
      const r = await readCommercialLifecycle(client, PERSONAL, NOW);
      expect(r.state).toBe("ACTIVE");
      expect(r.providerStatus).toBe(status);
    }
  });

  it("Step 2 — a matching PAST_DUE row is in the ONE bounded grace window, then expires", async () => {
    const inside = fakeClient([
      { userId: "u1", plan: "PRO", status: "PAST_DUE", currentPeriodEnd: at(-3), updatedAt: at(-1) },
    ]);
    const g = await readCommercialLifecycle(inside.client, PERSONAL, NOW);
    expect(g.state).toBe("GRACE");
    expect(g.mutationsAllowed).toBe(true);
    const outside = fakeClient([
      { userId: "u1", plan: "PRO", status: "PAST_DUE", currentPeriodEnd: at(-8), updatedAt: at(-1) },
    ]);
    const x = await readCommercialLifecycle(outside.client, PERSONAL, NOW);
    expect(x.state).toBe("PAST_DUE_EXPIRED");
    expect(x.mutationsAllowed).toBe(false);
  });

  it("Step 3 — no matching-scope row tolerates webhook lag: ACTIVE", async () => {
    const { client } = fakeClient([]);
    expect((await readCommercialLifecycle(client, WORKSPACE, NOW)).state).toBe("ACTIVE");
  });

  it("Step 4 — a terminal matching row: paid-through respected, then denied (CANCELLED, fail closed)", async () => {
    const paidThrough = fakeClient([
      { teamId: "t1", plan: "TEAM", status: "CANCELED", currentPeriodEnd: at(5), updatedAt: at(-1) },
    ]);
    expect((await readCommercialLifecycle(paidThrough.client, WORKSPACE, NOW)).state).toBe("ACTIVE");
    const ended = fakeClient([
      { teamId: "t1", plan: "TEAM", status: "CANCELED", currentPeriodEnd: at(-1), updatedAt: at(-1) },
    ]);
    const r = await readCommercialLifecycle(ended.client, WORKSPACE, NOW);
    expect(r.state).toBe("CANCELLED");
    expect(r.mutationsAllowed).toBe(false);
  });

  it("FREE short-circuits before any subscription query", async () => {
    const f = fakeClient([
      { userId: "u1", plan: "FREE", status: "PAST_DUE", currentPeriodEnd: null, updatedAt: at(-1) },
    ]);
    const r = await readCommercialLifecycle(f.client, { ...PERSONAL, plan: "FREE" }, NOW);
    expect(r.state).toBe("INACTIVE");
    expect(f.queries).toEqual([]);
  });
});

describe("Phase 9 STEP 5 — billing-guards is a thin adapter (no competing engine)", () => {
  function extractAdapter(src: string) {
    const fn = functionSource(src, "assertSubscriptionActiveOrGraceAllowed", "billing-guards.ts");
    expect(
      fn.startsWith("export async function assertSubscriptionActiveOrGraceAllowed"),
      "adapter must exist",
    ).toBe(true);
    return fn;
  }
  const ADAPTER = extractAdapter(BILLING_GUARDS);
  it("delegates to resolveCommercialContext and reads its lifecycle", () => {
    /**
     * WCR-04 (2026-09-07) — the DELEGATION is unchanged; the SUBJECT is fixed.
     *
     * This pinned `resolveCommercialContext({ ownerUserId: userId })`, which
     * with no `teamId` resolves the ACTOR'S OWN PERSONAL SPACE. Six
     * collaboration mutations therefore asked whether the actor's personal
     * subscription was in good standing before letting them act inside a
     * workspace that is not theirs — so an invited ADMIN of a fully-paid TEAM
     * workspace was refused because of their own lapsed personal plan, while
     * the entitlement projection beside it reported the WORKSPACE lifecycle
     * and said they could.
     *
     * The adapter now resolves the workspace subject through the same
     * discriminated envelope every other guard in the module uses. The pin
     * follows: it asserts the subject is declared, and asserts the actor-plan
     * shape has not come back.
     */
    expect(ADAPTER).toMatch(/type:\s*"WORKSPACE"/);
    expect(ADAPTER).toMatch(/type:\s*"PERSONAL_ACCOUNT"/);
    expect(ADAPTER).not.toMatch(/resolveCommercialContext\(\{\s*ownerUserId:\s*userId\s*\}\)/);
    expect(ADAPTER).toMatch(/ctx\.lifecycle/);
  });
  it("contains NO independent subscription query or grace calculation", () => {
    expect(ADAPTER).not.toMatch(/subscription\.findFirst/);
    expect(ADAPTER).not.toMatch(/currentPeriodEnd/);
  });
  it("still maps a terminal verdict to SUBSCRIPTION_INACTIVE", () => {
    expect(ADAPTER).toMatch(/code:\s*"SUBSCRIPTION_INACTIVE"/);
  });
});

describe("Production fix — error-code mapping is unchanged", () => {
  it("SUBSCRIPTION_INACTIVE still maps to HTTP 402", () => {
    expect(SHARED_CODES).toMatch(/SUBSCRIPTION_INACTIVE:\s*402/);
  });
});
