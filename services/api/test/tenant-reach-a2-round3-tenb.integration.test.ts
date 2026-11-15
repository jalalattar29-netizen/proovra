/**
 * FREE-USER AUDIT ROUND 3 — slice TENB: A2-19, A2-20, A2-22 (live PostgreSQL, real routes).
 *
 *   A2-19  Identifiers resolved outside the authorized workspace, and outsider
 *          denials whose body differed from a missing id:
 *            (i)   presence: a foreign case/record id was judged by ITS restricted
 *                  flag (404 vs 200 oracle across tenants);
 *            (ii)  search cursor: a foreign document id positioned the page;
 *            (ii') reviewer queue cursor (audit runtime unknown): PIN only — on Prisma
 *                  7.4.2 a cursor id outside the query's where already yields an empty
 *                  page, exactly like an unknown id (measured: passes with no source change);
 *            (iii) evidence requests and automation rules/destinations/runs: a row of
 *                  a workspace the caller cannot enter answered `not_found` where a
 *                  missing id answered the row's own 404 body; a closed case/record
 *                  on create answered `not_found` where a foreign id answered
 *                  `case_not_in_workspace` / `evidence_not_in_workspace`.
 *   A2-20  GET /v1/evidence/saved-views listed team views from raw status rows,
 *          ignoring access expiry and the organization lifecycle.
 *   A2-22  A discussion thread stored any `evidenceRequestId`, foreign or closed.
 *
 * Every refusal asserts the status, the body (equal to the guessed-id body) and
 * that no durable row changed; each has a positive control on the same route.
 * Every workspace here is created by this file.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeSearchCursor } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tenant = { teamId: string; orgId: string; owner: Person };

describe("free-user audit round 3 (TENB): A2-19, A2-20, A2-22 (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;

  let T: Tenant; // the caller's workspace
  let F: Tenant; // a foreign workspace
  let mem: Person; // MEMBER of T, off every restricted list
  let admin: Person; // ADMIN of T, off every restricted list
  let restrictedT: string; // restricted case in T (nobody listed)
  let hiddenT: string; // record of T linked only to restrictedT
  let openT: string; // open record of T
  let restrictedF: string; // restricted case in F
  let hiddenF: string; // record of F linked only to restrictedF
  let requestF: string; // evidence request in F, on restrictedF

  const tag = () => randomUUID().slice(0, 8);
  const call = (method: string, url: string, who: Person | null, payload?: unknown) => kit.call(method, url, who, payload);

  async function tenant(plan: "TEAM" | "ENTERPRISE"): Promise<Tenant> {
    const owner = await kit.person(null);
    const org = await prisma.organization.create({
      data: { name: `tenb-${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `tenb-${tag()}`,
        ownerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: plan,
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, teamId: team.id } as never });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: team.id } as never });
    return { teamId: team.id, orgId: org.id, owner };
  }

  async function record(t: Tenant, title: string): Promise<string> {
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.teamId,
          organizationId: t.orgId,
          ownerUserId: t.owner.id,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function restrictedCase(t: Tenant): Promise<string> {
    return (
      await prisma.case.create({
        data: { name: `R-${tag()}`, teamId: t.teamId, ownerUserId: t.owner.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
  }

  const link = (t: Tenant, caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: t.teamId } as never });

  const request = async (t: Tenant, ref: { caseId?: string; evidenceId?: string }) =>
    (
      await prisma.evidenceRequest.create({
        data: {
          teamId: t.teamId,
          requestType: "ADDITIONAL_EVIDENCE",
          recipientMode: "INTERNAL_USER",
          requestedByUserId: t.owner.id,
          title: `req-${tag()}`,
          status: "SENT",
          ...ref,
        } as never,
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? randomBytes(32).toString("hex");
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    kit = await coverageKit(h);

    T = await tenant("TEAM");
    F = await tenant("TEAM");
    [mem, admin] = await Promise.all([kit.person(T.teamId, "MEMBER"), kit.person(T.teamId, "ADMIN")]);

    restrictedT = await restrictedCase(T);
    hiddenT = await record(T, `hidden-${tag()}`);
    openT = await record(T, `open-${tag()}`);
    await link(T, restrictedT, hiddenT);

    restrictedF = await restrictedCase(F);
    hiddenF = await record(F, `hidden-f-${tag()}`);
    await link(F, restrictedF, hiddenF);
    requestF = await request(F, { caseId: restrictedF });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // A2-19 (i) — presence ids are bound to the authorized workspace
  // ===========================================================================
  describe("A2-19 (i): presence", () => {
    const heartbeat = (who: Person, resourceKind: string, resourceId: string) =>
      call("POST", "/v1/me/presence/heartbeat", who, { teamId: T.teamId, resourceKind, resourceId });
    const here = (who: Person, resourceKind: string, resourceId: string) =>
      call(
        "GET",
        `/v1/me/presence/here?teamId=${T.teamId}&resourceKind=${resourceKind}&resourceId=${resourceId}`,
        who,
      );

    it("a foreign workspace's restricted case, record and request answer exactly like an id that names nothing", async () => {
      for (const [kind, foreignId] of [
        ["matter", restrictedF],
        ["evidence", hiddenF],
        ["evidence_request", requestF],
        ["discussion_thread", hiddenF],
      ] as const) {
        const guessed = await heartbeat(mem, kind, randomUUID());
        const foreign = await heartbeat(mem, kind, foreignId);
        expect(foreign.statusCode, `${kind} ${foreign.body}`).toBe(guessed.statusCode);
        expect(foreign.json()).toEqual(guessed.json());
        const guessedHere = await here(mem, kind, randomUUID());
        const foreignHere = await here(mem, kind, foreignId);
        expect(foreignHere.statusCode, `${kind} here ${foreignHere.body}`).toBe(guessedHere.statusCode);
        expect(foreignHere.json()).toEqual(guessedHere.json());
      }
    });

    it("control: a restricted case and record of the caller's OWN workspace still answer 404", async () => {
      for (const [kind, id] of [
        ["matter", restrictedT],
        ["evidence", hiddenT],
      ] as const) {
        const r = await heartbeat(mem, kind, id);
        expect(r.statusCode, `${kind} ${r.body}`).toBe(404);
        expect((await here(mem, kind, id)).statusCode).toBe(404);
      }
      expect((await heartbeat(mem, "evidence", openT)).statusCode).toBe(200);
    });
  });

  // ===========================================================================
  // A2-19 (ii) — the search cursor is resolved inside the caller's result set
  // ===========================================================================
  describe("A2-19 (ii): search cursor", () => {
    const docIds: string[] = [];
    let foreignDocId: string;

    async function indexed(t: Tenant, sourceUpdatedAtUtc: Date): Promise<string> {
      const ev = await record(t, `search-${tag()}`);
      return (
        await prisma.evidenceSearchDocument.create({
          data: {
            teamId: t.teamId,
            documentType: "EVIDENCE",
            sourceId: ev,
            evidenceId: ev,
            title: `tenb search ${tag()}`,
            sourceUpdatedAtUtc,
          } as never,
          select: { id: true },
        })
      ).id;
    }

    beforeAll(async () => {
      const now = Date.now();
      for (const hoursAgo of [1, 2, 3]) docIds.push(await indexed(T, new Date(now - hoursAgo * 3_600_000)));
      // Older than every row of T: a page positioned on it holds nothing of T.
      foreignDocId = await indexed(F, new Date(now - 10 * 3_600_000));
    });

    it("a foreign document id in the cursor answers exactly like an unknown id with the same position", async () => {
      const position = new Date(Date.now() + 86_400_000).toISOString();
      const page = async (id: string) => {
        const cursor = encodeSearchCursor({ updatedAtUtc: position, createdAtUtc: position, id });
        const r = await call("GET", `/v1/search?teamId=${T.teamId}&limit=50&cursor=${encodeURIComponent(cursor)}`, T.owner);
        expect(r.statusCode, r.body).toBe(200);
        return (r.json() as { rows: Array<{ id?: string; documentId?: string; evidenceId?: string | null }> }).rows;
      };
      const unknown = await page(randomUUID());
      const foreign = await page(foreignDocId);
      expect(foreign.length).toBe(unknown.length);
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
      // Positive control: the walk resumes from the token's own position, so every row of T is there.
      expect(unknown.length).toBeGreaterThanOrEqual(docIds.length);
      // A live cursor of T still pages normally.
      const firstPage = await call("GET", `/v1/search?teamId=${T.teamId}&limit=1`, T.owner);
      const next = (firstPage.json() as { nextCursor: string | null }).nextCursor;
      expect(next).toBeTruthy();
      const second = await call("GET", `/v1/search?teamId=${T.teamId}&limit=1&cursor=${encodeURIComponent(next!)}`, T.owner);
      expect(second.statusCode, second.body).toBe(200);
      expect((second.json() as { rows: unknown[] }).rows.length).toBe(1);
    });
  });

  // ===========================================================================
  // A2-19 (ii') — the reviewer queue cursor is a workflow of THIS queue
  // ===========================================================================
  // Regression pin (no source change): proves the Prisma cursor does not position on a foreign row.
  describe("A2-19 (ii'): reviewer queue cursor", () => {
    let foreignWorkflowId: string;
    const workflowIds: string[] = [];

    const workflow = async (t: Tenant, priority: string) =>
      (
        await prisma.evidenceReviewWorkflow.create({
          data: {
            evidenceId: await record(t, `wf-${tag()}`),
            teamId: t.teamId,
            workspaceType: "TEAM",
            status: "NOT_STARTED",
            priority,
            // Non-null sort keys, so a cursor row positions the page (a NULL due date
            // makes every keyset comparison NULL and the page empty either way).
            dueAt: new Date(Date.now() + 86_400_000),
          } as never,
          select: { id: true },
        })
      ).id;

    beforeAll(async () => {
      workflowIds.push(await workflow(T, "NORMAL"), await workflow(T, "NORMAL"));
      // Sorts before every row of T (priority desc): a page positioned on it holds all of T.
      foreignWorkflowId = await workflow(F, "URGENT");
    });

    it("a foreign workflow id in the cursor answers exactly like an unknown id", async () => {
      const page = async (cursor: string) => {
        const r = await call("GET", `/v1/reviewer-ops/queue?teamId=${T.teamId}&queue=UNASSIGNED&cursor=${cursor}`, T.owner);
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as { rows: Array<{ id?: string; workflowId?: string }>; nextCursor: string | null };
      };
      const unknown = await page(randomUUID());
      const foreign = await page(foreignWorkflowId);
      expect(foreign).toEqual(unknown);
      expect(JSON.stringify(foreign)).not.toContain(workflowIds[0]!);
      // Positive control: without a cursor, and with a cursor of T, the queue pages normally.
      const all = await call("GET", `/v1/reviewer-ops/queue?teamId=${T.teamId}&queue=UNASSIGNED&limit=1`, T.owner);
      expect(all.statusCode, all.body).toBe(200);
      const first = all.json() as { rows: unknown[]; nextCursor: string | null };
      expect(first.rows.length).toBe(1);
      expect(first.nextCursor).toBeTruthy();
      const second = await page(first.nextCursor!);
      expect(second.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // A2-19 (iii) — outsider and closed ids answer like missing ones
  // ===========================================================================
  describe("A2-19 (iii): evidence requests", () => {
    it("a request of a workspace the caller cannot enter answers byte-identically to a guessed id", async () => {
      for (const suffix of ["", "/deliveries"]) {
        const guessed = await call("GET", `/v1/evidence-requests/${randomUUID()}${suffix}`, mem);
        const foreign = await call("GET", `/v1/evidence-requests/${requestF}${suffix}`, mem);
        expect(guessed.statusCode).toBe(404);
        expect(foreign.statusCode, foreign.body).toBe(404);
        expect(foreign.body).toBe(guessed.body);
      }
      // Mutations too, and nothing changes on the foreign row.
      const guessedCancel = await call("POST", `/v1/evidence-requests/${randomUUID()}/cancel`, mem, {});
      const foreignCancel = await call("POST", `/v1/evidence-requests/${requestF}/cancel`, mem, {});
      expect(foreignCancel.statusCode, foreignCancel.body).toBe(guessedCancel.statusCode);
      expect(foreignCancel.body).toBe(guessedCancel.body);
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: requestF }, select: { status: true } })).status).toBe("SENT");
    });

    it("control: the caller's own request is readable", async () => {
      const own = await request(T, { evidenceId: openT });
      const r = await call("GET", `/v1/evidence-requests/${own}`, mem);
      expect(r.statusCode, r.body).toBe(200);
    });

    it("create naming a closed case or record answers exactly like a foreign or missing id, and writes nothing", async () => {
      const body = (extra: Record<string, unknown>) => ({
        teamId: T.teamId,
        requestType: "ADDITIONAL_EVIDENCE",
        title: `tenb-${tag()}`,
        instructions: "Please photograph the damaged panel in daylight.",
        priority: "NORMAL",
        dueAtUtc: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        recipientLabel: "Claimant",
        recipientEmail: "claimant@test.proovra.local",
        createIntakeLink: false,
        deliverables: [
          { title: "Primary", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 },
        ],
        ...extra,
      });
      const before = await prisma.evidenceRequest.count({ where: { teamId: T.teamId } });
      const closedCase = await call("POST", "/v1/evidence-requests", admin, body({ caseId: restrictedT }));
      const foreignCase = await call("POST", "/v1/evidence-requests", admin, body({ caseId: restrictedF }));
      const guessedCase = await call("POST", "/v1/evidence-requests", admin, body({ caseId: randomUUID() }));
      expect(closedCase.statusCode, closedCase.body).toBe(404);
      expect(closedCase.body).toBe(guessedCase.body);
      expect(foreignCase.body).toBe(guessedCase.body);

      const closedRecord = await call("POST", "/v1/evidence-requests", admin, body({ evidenceId: hiddenT }));
      const foreignRecord = await call("POST", "/v1/evidence-requests", admin, body({ evidenceId: hiddenF }));
      const guessedRecord = await call("POST", "/v1/evidence-requests", admin, body({ evidenceId: randomUUID() }));
      expect(closedRecord.statusCode, closedRecord.body).toBe(404);
      expect(closedRecord.body).toBe(guessedRecord.body);
      expect(foreignRecord.body).toBe(guessedRecord.body);

      // A closed record beside a missing case answers as the missing case (the service's order).
      const both = await call("POST", "/v1/evidence-requests", admin, body({ evidenceId: hiddenT, caseId: randomUUID() }));
      expect(both.body).toBe(guessedCase.body);
      expect(await prisma.evidenceRequest.count({ where: { teamId: T.teamId } })).toBe(before);

      // Positive control: an open record is created.
      const open = await call("POST", "/v1/evidence-requests", admin, body({ evidenceId: openT }));
      expect(open.statusCode, open.body).toBe(201);
    });
  });

  describe("A2-19 (iii): automation rules, destinations and runs", () => {
    let ruleF: string;
    let destinationF: string;
    let runF: string;

    beforeAll(async () => {
      ruleF = (
        await prisma.automationRule.create({
          data: {
            teamId: F.teamId,
            name: `rule-${tag()}`,
            triggerType: "EVIDENCE_REPORTED",
            conditionJson: {},
            actionType: "NOTIFY_USER",
            actionConfigJson: { userId: F.owner.id },
            enabled: true,
            createdByUserId: F.owner.id,
            updatedByUserId: F.owner.id,
          } as never,
          select: { id: true },
        })
      ).id;
      destinationF = (
        await prisma.automationWebhookDestination.create({
          data: {
            teamId: F.teamId,
            name: `dest-${tag()}`,
            url: "https://hooks.example.test/tenb",
            urlOrigin: "https://hooks.example.test",
            encryptedSecret: "fixture-not-a-secret",
            secretFingerprint: "fixture",
            enabled: true,
            createdByUserId: F.owner.id,
            updatedByUserId: F.owner.id,
          } as never,
          select: { id: true },
        })
      ).id;
      runF = (
        await prisma.automationRun.create({
          data: {
            teamId: F.teamId,
            ruleId: ruleF,
            triggerType: "EVIDENCE_REPORTED",
            targetType: "EVIDENCE",
            targetId: hiddenF,
            idempotencyKey: `tenb-${tag()}`,
            actionIdempotencyKey: `tenb-a-${tag()}`,
          } as never,
          select: { id: true },
        })
      ).id;
    });

    it("a rule, destination or run of a workspace the caller cannot enter answers byte-identically to a guessed id; nothing changes", async () => {
      const pairs: Array<[string, string, string]> = [
        ["POST", `/v1/automation/rules/${ruleF}/disable`, `/v1/automation/rules/${randomUUID()}/disable`],
        ["POST", `/v1/automation/webhooks/${destinationF}/disable`, `/v1/automation/webhooks/${randomUUID()}/disable`],
        ["GET", `/v1/automation/runs/${runF}`, `/v1/automation/runs/${randomUUID()}`],
      ];
      for (const [method, foreignUrl, guessedUrl] of pairs) {
        const guessed = await call(method, guessedUrl, T.owner, method === "POST" ? {} : undefined);
        const foreign = await call(method, foreignUrl, T.owner, method === "POST" ? {} : undefined);
        expect(guessed.statusCode, guessedUrl).toBe(404);
        expect(foreign.statusCode, `${foreignUrl} ${foreign.body}`).toBe(404);
        expect(foreign.body).toBe(guessed.body);
      }
      expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: ruleF }, select: { enabled: true } })).enabled).toBe(true);
      expect(
        (await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: destinationF }, select: { enabled: true } })).enabled,
      ).toBe(true);
    });

    it("control: F's owner reads the run (the route still serves its own workspace)", async () => {
      const r = await call("GET", `/v1/automation/runs/${runF}`, F.owner);
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  // ===========================================================================
  // A2-20 — saved views follow the effective workspace membership
  // ===========================================================================
  describe("A2-20: saved views", () => {
    let S: Tenant;
    let viewer: Person;
    let teamViewByOwner: string;
    let ownTeamView: string;
    let ownPersonalView: string;

    const view = async (ownerUserId: string, teamId: string | null) =>
      (
        await prisma.evidenceSavedView.create({
          data: { ownerUserId, teamId, name: `view-${tag()}`, filtersJson: {}, scope: "active", isDefault: false } as never,
          select: { id: true },
        })
      ).id;
    const listed = async (who: Person) => {
      const r = await call("GET", "/v1/evidence/saved-views", who);
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    };

    beforeAll(async () => {
      S = await tenant("TEAM");
      viewer = await kit.person(S.teamId, "MEMBER");
      teamViewByOwner = await view(S.owner.id, S.teamId);
      ownTeamView = await view(viewer.id, S.teamId);
      ownPersonalView = await view(viewer.id, null);
    });

    it("an expired access window hides every team view of that workspace; the personal view stays", async () => {
      expect(await listed(viewer)).toEqual(expect.arrayContaining([teamViewByOwner, ownTeamView, ownPersonalView])); // control
      await prisma.teamMember.updateMany({
        where: { teamId: S.teamId, userId: viewer.id },
        data: { accessExpiresAtUtc: new Date(Date.now() - 1000) } as never,
      });
      try {
        const ids = await listed(viewer);
        expect(ids).not.toContain(teamViewByOwner);
        expect(ids).not.toContain(ownTeamView);
        expect(ids).toContain(ownPersonalView);
        // The same rule the view's own mutation applies: PATCH answers 404.
        const patch = await call("PATCH", `/v1/evidence/saved-views/${ownTeamView}`, viewer, { name: "renamed" });
        expect(patch.statusCode).toBe(404);
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId: S.teamId, userId: viewer.id },
          data: { accessExpiresAtUtc: null } as never,
        });
      }
      expect(await listed(viewer)).toEqual(expect.arrayContaining([teamViewByOwner, ownTeamView]));
    });

    it("a suspended organization hides its workspace's team views", async () => {
      await prisma.organization.update({ where: { id: S.orgId }, data: { status: "SUSPENDED" } as never });
      try {
        const ids = await listed(viewer);
        expect(ids).not.toContain(teamViewByOwner);
        expect(ids).not.toContain(ownTeamView);
        expect(ids).toContain(ownPersonalView);
      } finally {
        await prisma.organization.update({ where: { id: S.orgId }, data: { status: "ACTIVE" } as never });
      }
      expect(await listed(viewer)).toContain(teamViewByOwner);
    });
  });

  // ===========================================================================
  // A2-22 — a thread's evidence request must be one the caller can reach
  // ===========================================================================
  describe("A2-22: discussion thread evidenceRequestId", () => {
    const open = (who: Person, evidenceRequestId: string) =>
      call("POST", "/v1/collaboration/threads", who, {
        teamId: T.teamId,
        evidenceId: openT,
        evidenceRequestId,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: `tenb-thread-${tag()}`,
      });

    it("a foreign, closed or guessed request id answers the same 404 and stores no thread", async () => {
      const closedT = await request(T, { caseId: restrictedT });
      const before = await prisma.discussionThread.count({ where: { teamId: T.teamId } });
      const guessed = await open(mem, randomUUID());
      expect(guessed.statusCode, guessed.body).toBe(404);
      for (const id of [requestF, closedT]) {
        const r = await open(mem, id);
        expect(r.statusCode, r.body).toBe(404);
        expect(r.body).toBe(guessed.body);
      }
      expect(await prisma.discussionThread.count({ where: { teamId: T.teamId } })).toBe(before);
    });

    it("control: a request of this workspace the caller reaches is stored on the thread", async () => {
      const own = await request(T, { evidenceId: openT });
      const r = await open(mem, own);
      expect(r.statusCode, r.body).toBe(201);
      const id = (r.json() as { thread: { id: string } }).thread.id;
      expect((await prisma.discussionThread.findUniqueOrThrow({ where: { id }, select: { evidenceRequestId: true } })).evidenceRequestId).toBe(own);
    });
  });
});
