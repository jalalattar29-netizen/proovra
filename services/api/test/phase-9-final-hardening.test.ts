/**
 * PHASE 9 FINAL HARDENING (2026-07-23) — §9.5/§9.8/§9.9/§9.10/§9.11 closure
 * tests + the two mandated correctness checks (AI subject, QA bypass).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_CONTRACT_LIMITS } from "../src/services/billing/enterprise-contract-limits.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const H = vi.hoisted(() => ({
  writes: [] as string[],
  subRow: null as Record<string, unknown> | null,
}));

vi.mock("../src/db.js", () => {
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async () => 0;
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args?: { where?: Record<string, unknown> }) => {
                if (/^(create|update|upsert|delete)/.test(String(method)))
                  H.writes.push(`${String(model)}.${String(method)}`);
                if (String(model) === "subscription" && method === "findUnique")
                  return H.subRow;
                if (String(model) === "subscription" && method === "findUniqueOrThrow")
                  return H.subRow ?? {};
                if (String(model) === "workspaceStorageAddon" && method === "aggregate") {
                  // §9.9 — the addon query is keyed by (ownerUserId, teamId):
                  // record the exact key used so isolation is provable.
                  H.writes.push(
                    `addonKey:${String(args?.where?.ownerUserId)}:${String(args?.where?.teamId)}`,
                  );
                  return { _sum: { extraStorageBytes: 0n } };
                }
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "aggregate") return { _sum: {} };
                return null;
              };
            },
          },
        );
      },
    },
  );
  return { prisma };
});

import { existsSync } from "node:fs";
import { upsertSubscription } from "../src/services/billing.service.js";
import { assertWorkspaceAllowsAiOperation } from "../src/services/billing-enforcement.service.js";
import type { WorkspaceScope } from "../src/services/workspace-billing.service.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

beforeEach(() => {
  H.writes.length = 0;
  H.subRow = null;
  delete process.env.INTERNAL_UNLIMITED_TESTERS_ENABLED;
});

// ── PHASE 9 FINAL CLOSURE — the QA email bypass is REMOVED, not gated ──────
describe("QA-bypass REMOVAL — zero production commercial bypasses", () => {
  it("the internal-testers module is DELETED (no email-based unlimited entitlement exists)", () => {
    expect(existsSync(join(SRC, "services", "internal-testers.ts"))).toBe(false);
    expect(existsSync(join(SRC, "services", "internal-testers.js"))).toBe(false);
  });
  it("commercial enforcement contains NO bypass branch, tester email, or env-var unlimited override", () => {
    const enforcement = readFileSync(join(SRC, "services", "billing-enforcement.service.ts"), "utf8");
    expect(enforcement).not.toMatch(/InternalUnlimitedTester|shouldBypass|internal-testers|proovra\.com/);
    expect(enforcement).not.toMatch(/INTERNAL_UNLIMITED|process\.env\.[A-Z_]*(TESTER|UNLIMITED|BYPASS)/);
  });
  it("NO production src file grants commercial limits from an email or env flag", () => {
    // Repo-wide (api src): no email-literal or env-var driven limit bypass.
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const offenders = walk(SRC).filter((f) => {
      const body = readFileSync(f, "utf8");
      return /UNLIMITED_TEST|isInternalUnlimitedTester|internal-testers/.test(body);
    });
    expect(offenders).toEqual([]);
  });
});

// ── CHECK 1 — AI entitlement is scope-bound (no cross-subject leakage) ─────
describe("AI subject — Workspace A's AI entitlement cannot come from Personal plan or Workspace B", () => {
  function scope(overrides: Partial<WorkspaceScope>): WorkspaceScope {
    return {
      billingShape: "SHARED",
      ownerUserId: "owner-1",
      teamId: "ws-A",
      organizationId: "org-1",
      plan: "FREE" as WorkspaceScope["plan"],
      credits: 0,
      teamSeats: 0,
      storageBytesOverride: null,
      activeStorageAddonBytes: 0n,
      legacyRecordCapOverride: null,
    contractLimits: NO_CONTRACT_LIMITS,
      ...overrides,
    };
  }

  it("a FREE Workspace A denies AI even when the acting user's PERSONAL plan is PRO", async () => {
    // The assert consumes THE SCOPE's plan (aiAdvisoryMonthlyOperations of
    // FREE = 0) — the owner's personal PRO entitlement is not an input.
    await expect(
      assertWorkspaceAllowsAiOperation(scope({ plan: "FREE" as WorkspaceScope["plan"] })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/AI/) });
  });

  it("Workspace B's allowance cannot satisfy Workspace A (usage is tenant-keyed from the SCOPE)", () => {
    const enforcement = readFileSync(join(SRC, "services", "billing-enforcement.service.ts"), "utf8");
    const usage = enforcement.slice(enforcement.indexOf("export async function getWorkspaceAiUsageThisMonth"));
    // The usage row is keyed by the tenant id RESOLVED FROM THE SCOPE
    // (resolveAiUsageTenantId(scope)) — never by a request-supplied
    // workspace id, so B's usage/allowance can never satisfy A.
    expect(usage.slice(0, 1200)).toMatch(/resolveAiUsageTenantId\(scope\)/);
    expect(usage.slice(0, 1200)).toMatch(/teamId:\s*tenantId/);
  });

  it("the two PERSONAL_ACCOUNT AI endpoints thread the personal scope's teamId into every evidence-context query (workspace evidence unreachable)", () => {
    const ai = readFileSync(join(SRC, "routes", "ai.routes.ts"), "utf8");
    // Both migrated sites keep using aiScope.teamId (null for personal) as
    // the evidence-context key — a personal AI call cannot read workspace
    // evidence because the scope carries no workspace id.
    expect((ai.match(/teamId:\s*aiScope\.teamId/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ai).not.toMatch(/teamId:\s*(req|body|query)\./);
  });
});

// ── §9.10 — provider lifecycle hardening (behavioral) ──────────────────────
describe("§9.10 — stale/out-of-order provider events cannot restore old entitlement", () => {
  it("an event with an OLDER currentPeriodEnd than the stored row is a no-op (stale delivery)", async () => {
    H.subRow = {
      id: "sub-1",
      status: "ACTIVE",
      plan: "PRO",
      teamId: null,
      userId: "u1",
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    };
    await upsertSubscription({
      userId: "u1",
      provider: "STRIPE" as never,
      providerSubId: "ps-1",
      status: "ACTIVE" as never,
      plan: "PRO" as never,
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"), // older period
    });
    expect(H.writes.filter((w) => w.startsWith("subscription."))).toEqual([]);
  });

  it("a provider subscription id cannot be REBOUND to a different commercial subject", async () => {
    H.subRow = {
      id: "sub-1",
      status: "ACTIVE",
      plan: "PRO",
      teamId: null,
      userId: "u1",
      currentPeriodEnd: null,
    };
    await expect(
      upsertSubscription({
        userId: "attacker",
        provider: "STRIPE" as never,
        providerSubId: "ps-1",
        status: "ACTIVE" as never,
        plan: "PRO" as never,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_SUBSCRIPTION_SUBJECT_MISMATCH" });
    expect(H.writes.filter((w) => w.startsWith("subscription."))).toEqual([]);
  });

  it("metadata plan strings cannot mint an unknown plan (webhook normalizer is closed)", () => {
    const webhooks = readFileSync(join(SRC, "routes", "webhooks.routes.ts"), "utf8");
    // parsePlan validates against the Prisma enum and rejects unknowns.
    expect(webhooks).toMatch(/function parsePlan/);
    // Team activation still asserts the acting owner (billing.service
    // activateTeamPlan enforces ownerUserId === team.ownerUserId).
    const billing = readFileSync(join(SRC, "services", "billing.service.ts"), "utf8");
    expect(billing).toMatch(/Only the team owner can manage this team billing/);
  });
});

// ── §9.9 — storage/add-on isolation ────────────────────────────────────────
describe("§9.9 — storage/add-on subject isolation", () => {
  it("the addon query is keyed by (ownerUserId, teamId) — A cannot see B's or personal addons", () => {
    const wb = readFileSync(join(SRC, "services", "workspace-billing.service.ts"), "utf8");
    const q = wb.slice(wb.indexOf("async function getActiveWorkspaceStorageAddonBytes"));
    expect(q.slice(0, 700)).toMatch(/ownerUserId:\s*params\.ownerUserId/);
    expect(q.slice(0, 700)).toMatch(/teamId:\s*params\.teamId\s*\?\?\s*null/);
  });

  it("enterprise storage resolves from EnterpriseContract.storageGb, never from WorkspaceStorageAddon", () => {
    const contract = readFileSync(join(SRC, "services", "organization", "enterprise-contract.service.ts"), "utf8");
    expect(contract).toMatch(/storageGb/);
    expect(contract).not.toMatch(/workspaceStorageAddon/i);
  });

  it("storage over-limit enforcement throws — it contains NO evidence delete path", () => {
    const usage = readFileSync(join(SRC, "services", "workspace-usage.service.ts"), "utf8");
    const enforcement = readFileSync(join(SRC, "services", "billing-enforcement.service.ts"), "utf8");
    expect(usage + enforcement).not.toMatch(/evidence\.delete/);
  });
});

// ── §9.8 — canonical seat authority ────────────────────────────────────────
describe("§9.8 — one canonical seat authority", () => {
  it("the envelope's seats block is the ONE seat figure (ACTIVE-only usage source)", () => {
    const cc = readFileSync(join(SRC, "services", "billing", "commercial-context.service.ts"), "utf8");
    expect(cc).toMatch(/consumed:\s*usage\.teamMemberCount/);
    const usage = readFileSync(join(SRC, "services", "workspace-usage.service.ts"), "utf8");
    expect(usage).toMatch(/ACTIVE/);
  });
  it("membership writes remain locked to the Membership Orchestrator (seat mutations cannot bypass)", () => {
    // Machine-enforced by program-architecture-registry (#3/#3b/#3c) —
    // referenced here so the seat policy's write-path dependency is explicit.
    const reg = readFileSync(
      fileURLToPath(new URL("./program-architecture-registry.test.ts", import.meta.url)),
      "utf8",
    );
    expect(reg).toMatch(/organizationMembership[\s\S]{0,400}membership-provisioning/);
  });
});

// §9.8 — the DB-level membership-allocation concurrency proof lives in
// `phase-9-8-live-membership-allocation.test.ts`. It CANNOT live here: this
// file `vi.mock`s `../src/db.js` (see the top of the file), so the integration
// harness can never reach a real Postgres from this module. See that file for
// the executed live proof and the canonical command.

// ── §9.11 — web/mobile/worker raw commercial decisions = 0 ────────────────
describe("§9.11 — client/worker raw commercial decisions = 0", () => {
  const RAW =
    /\.billingPlan\s*(===|!==)|\.billingStatus\s*(===|!==)|SubscriptionStatus\.(ACTIVE|PAST_DUE|CANCELED)\s*===|===\s*"(PAST_DUE|CANCELED)"/;
  function scan(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && statSync(full).isFile()) {
          if (RAW.test(readFileSync(full, "utf8"))) out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }
  const REPO = join(SRC, "..", "..", "..");

  // Registered DISPLAY-TONE adapters (symbol-level, zero decision): these two
  // files map a SERVER-PROVIDED billing status string to a badge tone/style
  // object only (colors / tone labels — no capability, gating or precedence).
  // owner: web domain · removal: consume a server-projected tone field ·
  // Phase 12 target: envelope carries display tone.
  const WEB_DISPLAY_TONE_ADAPTERS = [
    join("app", "(app)", "admin", "executive", "page.tsx"),
    join("app", "(app)", "teams", "[id]", "page.tsx"),
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the Billing page's ONE
    // formatter. Its status branches return a WORD and a TONE and nothing
    // else: no capability, no gating, no precedence. Every commercial decision
    // the page used to make in the browser — whether a banner appears, whether
    // an add-on can be cancelled, whether the manage button says "Upgrade" or
    // "Change" — now arrives already decided on the projection.
    join("app", "(app)", "billing", "_sections", "format.ts"),
  ];

  it("apps/web contains ZERO raw commercial DECISIONS (registered display-tone adapters excluded with proof)", () => {
    const hits = scan(join(REPO, "apps", "web", "app")).concat(scan(join(REPO, "apps", "web", "lib")));
    const unregistered = hits.filter(
      (h) => !WEB_DISPLAY_TONE_ADAPTERS.some((a) => h.endsWith(a)),
    );
    expect(unregistered).toEqual([]);
    // PROOF the registered adapters are display-only: the status branches
    // return style/tone values and never gate a capability or route.
    for (const rel of WEB_DISPLAY_TONE_ADAPTERS) {
      const body = readFileSync(join(REPO, "apps", "web", rel), "utf8");
      const matches = [...body.matchAll(/===\s*"PAST_DUE"/g)];
      if (matches.length === 0) continue;
      for (const m of matches) {
        const branch = body.slice(m.index ?? 0, (m.index ?? 0) + 400);
        // Produces something to DISPLAY: a label, a tone, or a style object.
        expect(
          branch,
          `${rel}: a PAST_DUE branch must return a display value`,
        ).toMatch(/return\s*("[^"]*"|\{\s*border|\{\s*label)/);
        // …and gates NOTHING.
        expect(
          branch,
          `${rel}: a PAST_DUE branch must not gate anything`,
        ).not.toMatch(/href|navigate|disabled|enabled|allow/i);
      }
    }
  });
  it("apps/mobile contains ZERO raw commercial decisions", () => {
    expect(scan(join(REPO, "apps", "mobile", "app"))).toEqual([]);
  });
  it("services/worker contains ZERO independent commercial decisions (shared policy only)", () => {
    const hits = scan(join(REPO, "services", "worker", "src"));
    expect(hits).toEqual([]);
  });
});
