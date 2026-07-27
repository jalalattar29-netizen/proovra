/**
 * PHASE 4 §7.1 (2026-07-22) — Enterprise provisioning idempotency.
 *
 * Behavioral (mocked prisma, real service): the five required behaviors —
 *   1. same key + same payload → original result replayed, NO second
 *      org/workspace/membership/invite/contract/audit;
 *   2. same key + different payload → IDEMPOTENCY_CONFLICT, zero mutation;
 *   3. different keys + same name → NOT merged; advisory duplicate ids;
 *   4. concurrent same-key (unique-constraint loser) → in-progress/replay,
 *      exactly one provisioning result;
 *   5. FAILED attempt + same-key retry → re-runs safely (single-tx = no
 *      partial customer), never a second customer.
 * Plus: one-time invite tokens are REDACTED from the replay snapshot.
 *
 * rbac boundary: rbac.service is a SUBORDINATE transition engine of the
 * Phase 3 orchestrator — its only production callers are the identity
 * routes/access-review, and it composes the orchestrator's provenance
 * helpers (enforced below).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  requests: new Map<string, Record<string, unknown>>(), // key → row
  provisionCalls: 0,
  orgs: [] as Array<{ id: string; name: string; kind: string }>,
  failNextProvision: false,
  idSeq: 0,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    enterpriseProvisioningRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = data.idempotencyKey as string;
        if (H.requests.has(key)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = {
          id: `req-${++H.idSeq}`,
          ...data,
          updatedAt: new Date(),
          resultJson: null,
          resultOrganizationId: null,
        };
        H.requests.set(key, row);
        return { id: row.id };
      },
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        H.requests.get(where.idempotencyKey) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const row of H.requests.values()) {
          if (row.id === where.id) Object.assign(row, data, { updatedAt: new Date() });
        }
        return {};
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of H.requests.values()) {
          if (row.id === where.id && row.status === "PENDING") {
            Object.assign(row, data, { updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },
    },
    organization: {
      findMany: async ({ where }: { where: { name?: { equals: string }; id?: { not: string } } }) =>
        H.orgs
          .filter(
            (o) =>
              o.kind === "CUSTOMER" &&
              o.name.toLowerCase() === (where.name?.equals ?? "").toLowerCase() &&
              o.id !== where.id?.not,
          )
          .map((o) => ({ id: o.id })),
    },
    // The real provisionEnterpriseCustomer is mocked below — no tx needed.
  },
}));

import { provisionEnterpriseCustomerIdempotent } from "../src/services/enterprise-provisioning.service.js";
import { prisma } from "../src/db.js";

// The inner single-tx provisioning is injected via the wrapper's `deps`
// parameter (production always uses the real implementation).
const fakeProvision = vi.fn(async (input: { organizationName: string }) => {
  H.provisionCalls += 1;
  if (H.failNextProvision) {
    H.failNextProvision = false;
    throw new Error("simulated mid-provisioning failure");
  }
  const id = `org-${H.provisionCalls}`;
  H.orgs.push({ id, name: input.organizationName, kind: "CUSTOMER" });
  return {
    organizationId: id,
    ownerInviteToken: "raw-secret-token",
    inviteUrl: "https://x/invite",
    provisioned: false as const,
    pendingOwner: true as const,
  };
});

const run = (
  input: Parameters<typeof provisionEnterpriseCustomerIdempotent>[0],
) =>
  provisionEnterpriseCustomerIdempotent(input, prisma as never, {
    provision: fakeProvision as never,
  });

const BASE = {
  organizationName: "Acme Corp",
  ownerEmail: "owner@acme.example",
  actorUserId: "admin-1",
  idempotencyKey: "crm-contract-0001",
};

beforeEach(() => {
  H.requests.clear();
  H.provisionCalls = 0;
  H.orgs.length = 0;
  H.failNextProvision = false;
  H.idSeq = 0;
});

describe("Phase 4 §7.1 — provisioning idempotency", () => {
  it("1: same key + same payload replays the ORIGINAL result; provisioning runs ONCE", async () => {
    const first = await run(BASE);
    expect(first.idempotentReplay).toBe(false);
    expect(H.provisionCalls).toBe(1);

    const second = await run(BASE);
    expect(second.idempotentReplay).toBe(true);
    expect(H.provisionCalls).toBe(1); // NO second customer
    expect(H.orgs).toHaveLength(1);
    // The replay carries the same organization identity…
    expect((second.result as { organizationId?: string }).organizationId).toBe("org-1");
    // …but the one-time secret is NOT re-returned (locked token contract).
    expect((second.result as { ownerInviteToken?: unknown }).ownerInviteToken).toBeNull();
    expect((second.result as { oneTimeSecretRedacted?: boolean }).oneTimeSecretRedacted).toBe(true);
  });

  it("2: same key + materially different payload → IDEMPOTENCY_CONFLICT, zero mutation", async () => {
    await run(BASE);
    await expect(
      run({ ...BASE, seats: 500 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(H.provisionCalls).toBe(1);
    expect(H.orgs).toHaveLength(1);
  });

  it("3: different keys + same name → NOT merged; advisory duplicate ids returned", async () => {
    await run(BASE);
    const second = await run({
      ...BASE,
      idempotencyKey: "crm-contract-0002",
    });
    // Two distinct customers exist (no auto-merge)…
    expect(H.orgs).toHaveLength(2);
    // …and the second result flags the first as a possible duplicate.
    expect(second.possibleDuplicateOrganizationIds).toEqual(["org-1"]);
  });

  it("4: concurrent same-key (fresh PENDING row) → PROVISIONING_IN_PROGRESS, exactly one result", async () => {
    // Simulate the in-flight claim: a PENDING row updated just now.
    H.requests.set(BASE.idempotencyKey, {
      id: "req-x",
      idempotencyKey: BASE.idempotencyKey,
      payloadHash: undefined, // recompute below via a real first call path
      status: "PENDING",
      updatedAt: new Date(),
    });
    // Match the payload hash the wrapper computes: easiest is to copy from a
    // real claim in a scratch map.
    const scratch = new Map(H.requests);
    H.requests.clear();
    await run(BASE).catch(() => null);
    const real = H.requests.get(BASE.idempotencyKey)!;
    scratch.get(BASE.idempotencyKey)!.payloadHash = real.payloadHash;
    H.requests.clear();
    H.requests.set(BASE.idempotencyKey, scratch.get(BASE.idempotencyKey)!);
    H.provisionCalls = 0;
    H.orgs.length = 0;

    await expect(
      run(BASE),
    ).rejects.toMatchObject({ code: "PROVISIONING_IN_PROGRESS" });
    expect(H.provisionCalls).toBe(0); // the loser provisions NOTHING
  });

  it("5: FAILED attempt + same-key retry re-runs safely — never a second customer", async () => {
    H.failNextProvision = true;
    await expect(run(BASE)).rejects.toThrow(
      "simulated mid-provisioning failure",
    );
    expect(H.requests.get(BASE.idempotencyKey)).toMatchObject({ status: "FAILED" });
    expect(H.orgs).toHaveLength(0); // single-tx: no partial customer

    const retry = await run(BASE);
    expect(retry.idempotentReplay).toBe(false);
    expect(H.orgs).toHaveLength(1); // exactly one customer after retry
    expect(H.requests.get(BASE.idempotencyKey)).toMatchObject({ status: "COMPLETED" });
  });
});

// ---------------------------------------------------------------------------
// rbac subordinate-engine boundary
// ---------------------------------------------------------------------------

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.name.endsWith(".ts")) out.push(f);
  }
  return out;
}

describe("Phase 4 — rbac.service is a subordinate engine, not a competing orchestrator", () => {
  it("rbac composes the Phase 3 orchestrator's provenance helpers", () => {
    const src = readFileSync(
      join(API_SRC, "services", "identity", "rbac.service.ts"),
      "utf8",
    );
    expect(src).toContain("membership-provisioning.service.js");
    expect(src).toContain("recordMembershipGrant");
    expect(src).toContain("revokeAllMembershipGrants");
  });

  it("rbac's production callers are ONLY the registered entry surfaces", () => {
    // WAVE A FINAL CLOSURE (2026-07-22) — rbac SUBORDINATION tightened: the
    // engine is importable ONLY by the Membership Orchestrator, which
    // re-exports the public command surface. identity.routes and
    // access-review now consume transitions via the orchestrator module.
    const ALLOWED = new Set([
      "rbac.service.ts", // itself
      "membership-provisioning.service.ts", // the ONLY importer (orchestrator public commands)
    ]);
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      const src = readFileSync(file, "utf8");
      if (/from "[^"]*\/rbac\.service\.js"|from "\.\/rbac\.service\.js"/.test(src)) {
        const b = basename(file);
        if (!ALLOWED.has(b)) offenders.push(b);
      }
    }
    expect(offenders).toEqual([]);
  });
});
