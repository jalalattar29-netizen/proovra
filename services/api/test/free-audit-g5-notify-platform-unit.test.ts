/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G5-NOTIFY-PLATFORM (unit).
 *
 * The parts of the group that need no database: the reminder claim and link
 * (B2B-F-14, fake client), the preference link in emails (B2B-F-08), the
 * lease failure mode (B8-F-004), the bounded in-memory limiter (B8-F-304),
 * the staging cookie scope (B8-F-007), the derived contract signal
 * (B8-F-401/402), the active-projection follow-up (B8-F-003), the logout
 * overload exemption (B8-F-001) and the lead limiter key (B2A-F-16).
 * The live behaviour is in free-audit-g5-notify-platform.integration.test.ts.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sends: [] as Array<Record<string, any>>,
}));

vi.mock("../src/services/notifications/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isNotificationsFeatureEnabled: () => true,
    safeSendEmailNotification: async (input: Record<string, any>) => {
      m.sends.push(input);
      return null;
    },
  };
});

import {
  enqueueCanonicalJob,
  routeEpochSkew,
  clientBelowMinimumContract,
  PRESENTATION_CONTRACT_ROUTE_EPOCH,
  PRESENTATION_CONTRACT_VERSION,
} from "@proovra/shared";

import { isProovraProductionRequest } from "../src/http/cors-origin-policy.js";
import { leadForwardedClientIpKey } from "../src/middleware/client-ip.js";
import { installOverloadGate } from "../src/middleware/overload-gate.js";
import { runReminderScheduler } from "../src/services/notifications/reminder-scheduler.js";
import { renderTransactionalTemplate } from "../src/services/notifications/templates.js";
import { clearAllRateLimitBuckets } from "../src/services/rate-limit.js";
import {
  checkPresentationContract,
  extractApiRoutes,
  readContractConstants,
  readManifest,
} from "../../../scripts/presentation-contract-manifest.mjs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// B2B-F-14 — reminders: one per cooldown, and only with a live link.
// ---------------------------------------------------------------------------
describe("B2B-F-14 — evidence-request reminders", () => {
  const savedFlag = process.env.NOTIFICATION_REMINDERS_ENABLED;
  beforeEach(async () => {
    process.env.NOTIFICATION_REMINDERS_ENABLED = "true";
    // The per-request claim REFUSES when a CONFIGURED Redis cannot answer
    // (B8-F-004) — correct in production, and the reason these failed on the CI
    // unit step, which has no Redis on the setup file's 127.0.0.1:56379 (they
    // passed only where a local one was running). A unit test runs as ONE
    // process with no Redis configured: the in-process lease still makes the
    // two overlapping runs below exclusive. The setup file re-asserts the
    // variable before every test, so this beforeEach (which runs after it)
    // clears it each time.
    delete process.env.REDIS_URL;
    m.sends.length = 0;
    await clearAllRateLimitBuckets();
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.NOTIFICATION_REMINDERS_ENABLED;
    else process.env.NOTIFICATION_REMINDERS_ENABLED = savedFlag;
  });

  function fakeClient(opts: { linkStatus?: string; sentUrl?: string | null } = {}) {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      title: "Upload the invoice",
      instructions: null,
      dueAtUtc: new Date(Date.now() + 86_400_000),
      recipientEmail: "contributor@example.test",
      recipientLabel: "Contributor",
      evidenceId: null,
      intakeLinkId: "33333333-3333-4333-8333-333333333333",
      intakeLink: {
        status: opts.linkStatus ?? "ACTIVE",
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
        maxUses: 5,
        usedCount: 0,
      },
      deliverables: [],
    };
    const sentUrl = opts.sentUrl === undefined ? "https://www.proovra.com/intake/raw-token-abc" : opts.sentUrl;
    return {
      // PRO-N1Z-02 — the re-invitation gate reads the request status and the link
      // (an unknown link is not plan-checked; the plan gate is proven in integration).
      evidenceRequest: { findMany: async () => [request], findUnique: async () => ({ status: "SENT" }) },
      workflowIntakeLink: { findUnique: async () => null },
      team: { findUnique: async () => ({ name: "Workspace", evidenceWorkspaceLabel: null }) },
      notificationDelivery: {
        findFirst: async (args: { where: { eventType: string } }) => {
          // A real read takes time; this is the window two runs used to share.
          await sleep(15);
          if (args.where.eventType === "EVIDENCE_REQUEST_REMINDER") {
            return m.sends.length > 0 ? { id: "prior" } : null;
          }
          return sentUrl === null
            ? null
            : { templateContextJson: { kind: "EvidenceRequest", data: { intakeUrl: sentUrl } } };
        },
      },
    } as never;
  }

  it("two overlapping runs send ONE reminder (claim before check-and-send)", async () => {
    const client = fakeClient();
    const [a, b] = await Promise.all([
      runReminderScheduler({}, client),
      runReminderScheduler({}, client),
    ]);
    expect(m.sends).toHaveLength(1);
    expect(a.reminded + b.reminded).toBe(1);
    expect(a.skippedClaimed + b.skippedClaimed + a.skippedRecent + b.skippedRecent).toBe(1);
  });

  it("the reminder carries the live upload link the original request email sent", async () => {
    await runReminderScheduler({}, fakeClient());
    expect(m.sends).toHaveLength(1);
    expect(m.sends[0]!.template.data.intakeUrl).toBe("https://www.proovra.com/intake/raw-token-abc");
    const rendered = renderTransactionalTemplate("EVIDENCE_REQUEST_REMINDER", m.sends[0]!.template);
    expect(rendered.text).toContain("Secure upload link: https://www.proovra.com/intake/raw-token-abc");
  });

  it("no live link (revoked link, or no stored original) → no reminder", async () => {
    const revoked = await runReminderScheduler({}, fakeClient({ linkStatus: "REVOKED" }));
    const missing = await runReminderScheduler({}, fakeClient({ sentUrl: null }));
    expect(m.sends).toHaveLength(0);
    expect(revoked.skippedNoLink).toBe(1);
    expect(missing.skippedNoLink).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B2B-F-08 — the way to stop an email is in the email.
// ---------------------------------------------------------------------------
describe("B2B-F-08 — manage-preferences link", () => {
  it("digest and preference-governed emails carry the Notifications settings link (HTML and text)", () => {
    const digest = renderTransactionalTemplate("OPERATIONS_DIGEST", {
      kind: "OperationsDigest",
      data: {
        workspaceName: "W",
        cadenceLabel: "Daily",
        items: [{ title: "t", category: "mention", severity: "info" }],
        totalUnread: 1,
        operationsCenterUrl: null,
      },
    });
    const mention = renderTransactionalTemplate("DISCUSSION_MENTION_RECEIVED", {
      kind: "ReviewAssigned",
      data: { workspaceName: "W", requestTitle: "R", reviewerName: null, requestUrl: null },
    });
    for (const r of [digest, mention]) {
      expect(r.html).toContain("Manage notification preferences");
      expect(r.html).toContain("/settings#notifications");
      expect(r.text).toMatch(/Manage notification preferences: https?:\/\/[^\s]+\/settings#notifications/);
    }
  });
});

// ---------------------------------------------------------------------------
// B8-F-007 — a staging deployment is never the production cookie domain.
// ---------------------------------------------------------------------------
describe("B8-F-007 — cookie-domain production detection", () => {
  it("PROOVRA_ENV=staging under *.proovra.com → not production; production/undeclared unchanged", () => {
    expect(isProovraProductionRequest("api.staging.proovra.com", undefined, { PROOVRA_ENV: "staging" })).toBe(false);
    expect(isProovraProductionRequest("api.proovra.com", "https://www.proovra.com", { APP_ENV: "staging" })).toBe(false);
    expect(isProovraProductionRequest("api.proovra.com", undefined, { NODE_ENV: "production" })).toBe(true);
    expect(isProovraProductionRequest("api.proovra.com", undefined, {})).toBe(true);
    expect(isProovraProductionRequest("proovra.com.evil.example", undefined, { NODE_ENV: "production" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B8-F-401 / B8-F-402 — the compatibility signal is derived and enforced.
// ---------------------------------------------------------------------------
describe("B8-F-401 / B8-F-402 — derived presentation contract", () => {
  it("the recorded route table matches the API source and the shared constants", () => {
    const verdict = checkPresentationContract();
    expect(verdict.problems).toEqual([]);
    expect(readContractConstants()).toEqual({
      contractVersion: PRESENTATION_CONTRACT_VERSION,
      routeEpoch: PRESENTATION_CONTRACT_ROUTE_EPOCH,
    });
    expect(extractApiRoutes()).toContain("POST /v1/me/inbox/mark-all-read");
  });

  it("an added route without an epoch increment, or a removed route without a version bump, fails the check", () => {
    const manifest = readManifest();
    const constants = readContractConstants();
    const added = checkPresentationContract({ routes: [...manifest.routes, "GET /v1/new-thing"], constants, manifest });
    expect(added.ok).toBe(false);
    expect(added.added).toEqual(["GET /v1/new-thing"]);
    const removed = checkPresentationContract({ routes: manifest.routes.slice(1), constants, manifest });
    expect(removed.ok).toBe(false);
    expect(removed.problems.join(" ")).toMatch(/PRESENTATION_CONTRACT_VERSION bump/);
  });

  it("clients read the new headers additively (absent header → no effect)", () => {
    expect(routeEpochSkew(null)).toBe("UNKNOWN");
    expect(routeEpochSkew(String(PRESENTATION_CONTRACT_ROUTE_EPOCH))).toBe("CURRENT");
    expect(routeEpochSkew("1", 2)).toBe("CLIENT_NEWER");
    expect(clientBelowMinimumContract(undefined, 1)).toBe(false);
    expect(clientBelowMinimumContract("2", 1)).toBe(true);
    expect(clientBelowMinimumContract("1", 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B8-F-003 — an ACTIVE projection job gets one follow-up instead of a collapse.
// ---------------------------------------------------------------------------
describe("B8-F-003 — enqueue while a projection job is active", () => {
  function fakeQueue(state: string) {
    const added: Array<{ name: string; opts: Record<string, unknown> }> = [];
    const jobs = new Map<string, { id: string; getState: () => Promise<string>; remove: () => Promise<void> }>();
    const queue = {
      getJob: async (id: string) => jobs.get(id) ?? null,
      add: async (name: string, _data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, opts });
        jobs.set(String(opts.jobId), { id: String(opts.jobId), getState: async () => "waiting", remove: async () => undefined });
      },
    };
    return { queue, added, jobs, seed: (id: string) => jobs.set(id, { id, getState: async () => state, remove: async () => undefined }) };
  }
  const retry = { attempts: 3, backoff: "exponential" as const, backoffDelayMs: 1000, timeoutMs: 60_000 };
  const projection = { workName: "RebuildSearchDocument", jobIdPrefix: "search-index", schemaVersion: 1, retry, family: "reconciliation" };
  const render = { workName: "GenerateReport", jobIdPrefix: "report", schemaVersion: 1, retry, family: "reports_packages" };
  const commandId = "evidence:44444444-4444-4444-8444-444444444444";

  it("active reconciliation job → one follow-up under the derived id; a second enqueue collapses onto it", async () => {
    // The base job is scheduled, then becomes ACTIVE (the running rebuild);
    // a change committed now must get exactly one follow-up.
    const g = fakeQueue("active");
    const base = await enqueueCanonicalJob({ queue: g.queue as never, entry: { ...projection, family: undefined }, commandId, traceId: "t" });
    const baseJobId = (base as { jobId: string }).jobId;
    g.seed(baseJobId);
    const followUp = await enqueueCanonicalJob({ queue: g.queue as never, entry: projection, commandId, traceId: "t" });
    expect(followUp).toMatchObject({ enqueued: true, collapsed: false });
    expect((followUp as { jobId: string }).jobId).not.toBe(baseJobId);
    const again = await enqueueCanonicalJob({ queue: g.queue as never, entry: projection, commandId, traceId: "t" });
    expect(again).toMatchObject({ enqueued: true, collapsed: true, jobId: (followUp as { jobId: string }).jobId });
    expect(g.added).toHaveLength(2); // the base and exactly one follow-up
  });

  it("waiting jobs, and active jobs of other families, still collapse", async () => {
    const w = fakeQueue("waiting");
    const seeded = await enqueueCanonicalJob({ queue: w.queue as never, entry: projection, commandId, traceId: "t" });
    w.seed((seeded as { jobId: string }).jobId);
    expect(await enqueueCanonicalJob({ queue: w.queue as never, entry: projection, commandId, traceId: "t" })).toMatchObject({ collapsed: true });
    const r = fakeQueue("active");
    const rs = await enqueueCanonicalJob({ queue: r.queue as never, entry: render, commandId, traceId: "t" });
    r.seed((rs as { jobId: string }).jobId);
    expect(await enqueueCanonicalJob({ queue: r.queue as never, entry: render, commandId, traceId: "t" })).toMatchObject({ collapsed: true });
  });
});

// ---------------------------------------------------------------------------
// B8-F-001 (cross-lane) — the overload gate never refuses sign-out.
// ---------------------------------------------------------------------------
describe("B8-F-001 — logout is exempt from the overload gate", () => {
  it("under overload every route is 503 except POST /v1/auth/logout", async () => {
    const app = Fastify();
    installOverloadGate(
      app,
      { maxInFlight: 0, maxEventLoopDelayMs: 1, retryAfterSeconds: 2, sampleIntervalMs: 500 },
      { eventLoopDelayMs: () => 10_000 },
    );
    app.post("/v1/auth/logout", async () => ({ ok: true }));
    app.get("/v1/other", async () => ({ ok: true }));
    const other = await app.inject({ method: "GET", url: "/v1/other" });
    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout" });
    await app.close();
    expect(other.statusCode).toBe(503);
    expect(logout.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// B2A-F-16 (cross-lane) — a forwarded IP picks the bucket only with the key.
// ---------------------------------------------------------------------------
describe("B2A-F-16 — lead limiter key", () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" } }) as never;
  const keyMatches = (p: unknown) => p === "a-long-enough-forwarding-key";

  it("with the proxy key → the leftmost forwarded visitor; without it → the resolved client, whatever XFF says", () => {
    expect(leadForwardedClientIpKey(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.9", "x-internal-key": "a-long-enough-forwarding-key" }), keyMatches)).toBe("fwd:203.0.113.7");
    expect(leadForwardedClientIpKey(req({ "x-forwarded-for": "203.0.113.7" }), keyMatches)).toBe("10.0.0.9");
    expect(leadForwardedClientIpKey(req({ "x-forwarded-for": "203.0.113.7", "x-internal-key": "wrong" }), keyMatches)).toBe("10.0.0.9");
  });
});
