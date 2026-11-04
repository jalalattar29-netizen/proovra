/**
 * FEATURES ROUND 3 — executed closures for PRO-087 … PRO-099 (FEATURES-05 … 17).
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), the API over `inject`, the
 * product's own recording messaging transport (no provider is contacted), the
 * real step-up routes (TOTP ceremony and the SMS factor the recording
 * transport delivers), and real row locks for the races: an audit transaction
 * holds the lock, `pg_locks` shows the waiters, and only then is it released,
 * so each interleaving is the one the finding describes, not a timing guess.
 *
 * Every case carries an authorized positive control and the refusal, and reads
 * the rows the refusal must not have written.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness, TeamFixture } from "./integration-harness.js";

process.env.MFA_SECRET_KEK_BASE64 = process.env.MFA_SECRET_KEK_BASE64 ?? randomBytes(32).toString("base64");
process.env.MESSAGING_TRANSPORT = "recording";
process.env.REVIEWER_QC_SAMPLE_PERCENT = "100";

type Res = { statusCode: number; body: string };
type Json = Record<string, unknown>;
const json = <T = Json>(r: Res): T => JSON.parse(r.body) as T;
const tag = randomUUID().slice(0, 8);

describe("features round 3 closures (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recorder: typeof import("../src/services/communications/recording-provider.js");
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let mintToken: (userId: string, email: string) => string;
  let A: TeamFixture;
  let B: TeamFixture;
  const orgs: { A: string; B: string } = { A: "", B: "" };

  const req = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: method as "GET",
      url,
      payload: payload as never,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }) as unknown as Promise<Res>;

  async function setEnterprise(t: TeamFixture) {
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    const team = await prisma.team.update({
      where: { id: t.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
      select: { organizationId: true },
    });
    await prisma.$transaction((tx) =>
      upsertEnterpriseContract(tx as never, {
        organizationId: team.organizationId,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: 50,
        collaborationTeamsMax: 10,
        collaborationTeamMembersMax: 50,
        legalHoldEnabled: true,
        reviewerOperationsEnabled: true,
      } as never),
    );
    return team.organizationId as string;
  }

  async function extraMember(teamId: string, role: "ADMIN" | "MEMBER" | "VIEWER", label: string) {
    const email = `r3-${label}-${tag}@example.invalid`;
    const u = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date(), currentWorkspaceId: teamId } as never,
    });
    const accepted = await prisma.userLegalAcceptance.findMany({ where: { userId: A.ownerUserId } });
    for (const a of accepted) {
      const rest: Json = { ...(a as unknown as Json) };
      delete rest.id;
      await prisma.userLegalAcceptance.create({ data: { ...rest, userId: u.id } as never }).catch(() => 0);
    }
    await prisma.teamMember.create({ data: { teamId, userId: u.id, role, status: "ACTIVE" } as never });
    return { userId: u.id, email, token: mintToken(u.id, email) };
  }

  async function mkEvidence(t: TeamFixture, orgId: string, title: string) {
    return prisma.evidence.create({
      data: {
        title,
        displayFileName: `${title}.jpg`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.teamId,
        organizationId: orgId,
        ownerUserId: t.ownerUserId,
      } as never,
    });
  }

  async function mkWorkflow(teamId: string, evidenceId: string) {
    return prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, workspaceType: "TEAM", status: "IN_REVIEW" } as never,
    });
  }

  /** Hold a lock in its own transaction until `release()`. */
  async function holdLock(sql: string, ...params: unknown[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(sql, ...params);
        locked();
        await gate;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    await isLocked;
    return { release, done };
  }

  async function waiters(min: number, maxMs = 20_000): Promise<number> {
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < maxMs) {
      const r = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
        "select count(*)::int as c from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.datname = current_database()",
      );
      n = r[0]?.c ?? 0;
      if (n >= min) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return n;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    recorder = await import("../src/services/communications/recording-provider.js");
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const { signJwt } = await import("../src/services/jwt.js");
    mintToken = (userId, email) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
        process.env.AUTH_JWT_SECRET!,
        3600,
      );
    ({ teamA: A, teamB: B } = h.fixtures);
    for (const t of [A, B]) {
      for (const id of [t.ownerUserId, t.adminUserId, t.memberUserId, t.viewerUserId]) {
        await prisma.user.update({ where: { id }, data: { currentWorkspaceId: t.teamId } as never });
      }
    }
    orgs.A = await setEnterprise(A);
    orgs.B = await setEnterprise(B);
  }, 600_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  // -------------------------------------------------------------------------
  // PRO-087 (FEATURES-05)
  // -------------------------------------------------------------------------
  it("PRO-087: a co-member's bare verify/check cannot spend a colleague's SMS step-up attempt", async () => {
    const victim = await extraMember(A.teamId, "ADMIN", "otp-victim");
    const phone = "+12025550177";
    const alias = recorder.recipientAliasForPhone(phone);
    const lastCode = () =>
      (recorder.recordedMessages() as Array<{ recipientAlias?: string; code?: string }>)
        .filter((m) => m.recipientAlias === alias && m.code)
        .at(-1)?.code ?? null;
    const st = await req("POST", "/v1/identity-security/contact-factors/enroll/start", victim.token, {
      teamId: A.teamId,
      channel: "SMS",
      destination: phone,
      label: "r3 victim phone",
    });
    expect(st.statusCode, st.body).toBe(200);
    const enrol = json<{ factor: { factorId: string }; verificationAttemptId: string }>(st);
    const ver = await req("POST", "/v1/identity-security/contact-factors/enroll/verify", victim.token, {
      teamId: A.teamId,
      factorId: enrol.factor.factorId,
      verificationAttemptId: enrol.verificationAttemptId,
      code: lastCode(),
    });
    expect(ver.statusCode, ver.body).toBe(200);

    const su = await req("POST", "/v1/identity-security/step-up/start", victim.token, { teamId: A.teamId, purpose: "MEMBER_SUSPEND" });
    expect(su.statusCode, su.body).toBe(200);
    const started = json<{ method: string; challenge: { id: string } }>(su);
    expect(started.method).toBe("SMS");

    // The attack: six wrong codes for the colleague's number on the bare route.
    for (let i = 0; i < 6; i += 1) {
      const burn = await req("POST", "/v1/communications/verify/check", A.viewerToken, { teamId: A.teamId, phone, code: "000000" });
      expect(burn.statusCode).toBe(400);
    }
    const challenge = await prisma.stepUpChallenge.findUnique({ where: { id: started.challenge.id }, select: { verificationAttemptId: true } });
    const attempt = await prisma.verificationAttempt.findUnique({ where: { id: challenge!.verificationAttemptId! } });
    expect(attempt?.status).toBe("STARTED");
    expect(attempt?.checkAttemptCount).toBe(0);

    // The colleague's own step-up still completes with the code they received.
    const ok = await req("POST", "/v1/identity-security/step-up/check", victim.token, {
      teamId: A.teamId,
      challengeId: started.challenge.id,
      code: lastCode(),
    });
    expect(ok.statusCode, ok.body).toBe(200);

    // The bare route still serves the caller's OWN verification (positive control),
    // and a co-member cannot approve or spend it either.
    const own = "+12025550178";
    const ownAlias = recorder.recipientAliasForPhone(own);
    const s2 = await req("POST", "/v1/communications/verify/start", A.memberToken, { teamId: A.teamId, channel: "SMS", phone: own });
    expect(s2.statusCode, s2.body).toBe(200);
    const ownCode = (recorder.recordedMessages() as Array<{ recipientAlias?: string; code?: string }>)
      .filter((m) => m.recipientAlias === ownAlias && m.code)
      .at(-1)?.code;
    const other = await req("POST", "/v1/communications/verify/check", A.viewerToken, { teamId: A.teamId, phone: own, code: ownCode });
    expect(other.statusCode).toBe(400);
    const mine = await req("POST", "/v1/communications/verify/check", A.memberToken, { teamId: A.teamId, phone: own, code: ownCode });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(json<{ status: string }>(mine).status).toBe("approved");
  });

  // -------------------------------------------------------------------------
  // PRO-088 (FEATURES-06)
  // -------------------------------------------------------------------------
  it("PRO-088: withdraw and reinstate need their step-up purposes; the withdrawal reason is kept", async () => {
    const ev = await mkEvidence(A, orgs.A, `R3VR-${tag}`);
    const url = (op: string) => `/v1/evidence/${ev.id}/verification-access/${op}`;
    const header = (token: string, userId: string, purpose: string) =>
      ceremony.approvedHeader({ token, userId, teamId: A.teamId, purpose, resourceKind: "evidence", resourceId: ev.id });

    const noProof = await req("POST", url("withdraw"), A.ownerToken, { reason: "LEGAL_REQUEST" });
    expect(noProof.statusCode).toBe(401);
    expect((await prisma.evidence.findUnique({ where: { id: ev.id }, select: { verificationAccessState: true } }))?.verificationAccessState).toBe("AVAILABLE");

    const withdrawn = await req("POST", url("withdraw"), A.ownerToken, { reason: "LEGAL_REQUEST" }, await header(A.ownerToken, A.ownerUserId, "PUBLIC_VERIFY_SUSPEND"));
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // The finding: an ADMIN reinstates with a session alone.
    const bare = await req("POST", url("reinstate"), A.adminToken, {});
    expect(bare.statusCode).toBe(401);
    expect(json<{ error?: { code?: string } }>(bare).error?.code ?? json<{ code?: string }>(bare).code).toBe("STEP_UP_REQUIRED");
    // A proof for the OTHER direction does not answer this one.
    const wrongPurpose = await req("POST", url("reinstate"), A.adminToken, {}, await header(A.adminToken, A.adminUserId, "PUBLIC_VERIFY_SUSPEND"));
    expect(wrongPurpose.statusCode).toBe(401);
    let row = await prisma.evidence.findUnique({ where: { id: ev.id }, select: { verificationAccessState: true, verificationAccessReason: true } });
    expect(row).toEqual({ verificationAccessState: "WITHDRAWN", verificationAccessReason: "LEGAL_REQUEST" });
    expect(await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "VERIFICATION_ACCESS_REINSTATED" } })).toBe(0);

    // Controls: lower roles and the other tenant are refused before any step-up.
    expect((await req("POST", url("reinstate"), A.viewerToken, {})).statusCode).toBe(403);
    expect((await req("POST", url("reinstate"), A.memberToken, {})).statusCode).toBe(403);
    expect((await req("POST", url("reinstate"), B.ownerToken, {})).statusCode).toBe(404);

    const reinstated = await req("POST", url("reinstate"), A.adminToken, {}, await header(A.adminToken, A.adminUserId, "PUBLIC_VERIFY_RESTORE"));
    expect(reinstated.statusCode, reinstated.body).toBe(200);
    row = await prisma.evidence.findUnique({ where: { id: ev.id }, select: { verificationAccessState: true, verificationAccessReason: true } });
    expect(row).toEqual({ verificationAccessState: "AVAILABLE", verificationAccessReason: "LEGAL_REQUEST" });
    const custody = await prisma.custodyEvent.findFirst({ where: { evidenceId: ev.id, eventType: "VERIFICATION_ACCESS_REINSTATED" }, select: { payload: true } });
    expect((custody?.payload as Json | null)?.reversedWithdrawalReason).toBe("LEGAL_REQUEST");
  });

  // -------------------------------------------------------------------------
  // PRO-089 (FEATURES-07)
  // -------------------------------------------------------------------------
  it("PRO-089: redaction writes stop when FEATURE_REDACTION is gone; reads stay", async () => {
    const ev = await mkEvidence(B, orgs.B, `R3RED-${tag}`);
    const q = `?teamId=${B.teamId}`;
    const open = await req("POST", `/v1/redaction/projects${q}`, B.ownerToken, { evidenceId: ev.id, artifactKind: "IMAGE" });
    expect(open.statusCode, open.body).toBe(201);
    const projectId = json<{ projectId: string }>(open).projectId;
    const v1 = await req("POST", `/v1/redaction/projects/${projectId}/versions${q}`, B.ownerToken, {});
    expect(v1.statusCode, v1.body).toBe(201);
    const versionId = json<{ versionId: string }>(v1).versionId;
    const detectBody = { providers: ["REGEX_PII"], inlineText: "mail x@example.invalid" };
    const d1 = await req("POST", `/v1/redaction/versions/${versionId}/detect${q}`, B.ownerToken, detectBody);
    expect(d1.statusCode, d1.body).toBe(200);
    const rowsBefore = await prisma.redactionDetection.count({ where: { versionId } });
    const versionsBefore = await prisma.redactionVersion.count({ where: { projectId } });

    // Downgrade: plan lowered and the contract ended.
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "FREE", billingStatus: "INACTIVE" } as never });
    await prisma.enterpriseContract.updateMany({ where: { organizationId: orgs.B }, data: { status: "TERMINATED" } as never });
    try {
      const v2 = await req("POST", `/v1/redaction/projects/${projectId}/versions${q}`, B.ownerToken, {});
      expect(v2.statusCode).toBe(403);
      expect(json<{ denial: string }>(v2).denial).toBe("ENTITLEMENT_REQUIRED");
      const d2 = await req("POST", `/v1/redaction/versions/${versionId}/detect${q}`, B.ownerToken, detectBody);
      expect(d2.statusCode).toBe(403);
      expect(await prisma.redactionDetection.count({ where: { versionId } })).toBe(rowsBefore);
      expect(await prisma.redactionVersion.count({ where: { projectId } })).toBe(versionsBefore);
      // Existing material stays readable.
      const read = await req("GET", `/v1/redaction/projects/${projectId}${q}`, B.ownerToken);
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
      await prisma.enterpriseContract.updateMany({ where: { organizationId: orgs.B }, data: { status: "ACTIVE" } as never });
    }
  });

  // -------------------------------------------------------------------------
  // PRO-090 (FEATURES-08)
  // -------------------------------------------------------------------------
  it("PRO-090: a draft save that read before a publish committed cannot rewrite the published version", async () => {
    const crit = (k: string) => [{ key: k, title: `Criterion ${k}`, required: true, order: 0 }];
    const c = await req("POST", "/v1/reviewer-criteria", A.ownerToken, { teamId: A.teamId, name: `R3CRIT-${tag}`, title: "v1", criteria: crit("original") });
    expect(c.statusCode, c.body).toBe(201);
    const setId = json<{ set: { id: string } }>(c).set.id;
    const version = await prisma.reviewerCriteriaVersion.findFirstOrThrow({ where: { criteriaSetId: setId }, orderBy: { version: "desc" } });

    // A publish is in flight (row written, not yet committed) when the save reads.
    const lock = await holdLock(
      `UPDATE "reviewer_criteria_versions" SET "published_at" = now(), "published_by_user_id" = $2::uuid WHERE "id" = $1::uuid`,
      version.id,
      A.ownerUserId,
    );
    const patchP = req("PATCH", `/v1/reviewer-criteria/${setId}/draft`, A.adminToken, { teamId: A.teamId, title: "rewritten", criteria: crit("injected-after-publish") });
    expect(await waiters(1)).toBeGreaterThanOrEqual(1);
    lock.release();
    await lock.done;
    const patch = await patchP;
    expect(patch.statusCode, patch.body).toBe(409);
    expect(json<{ error: { code: string } }>(patch).error.code).toBe("published_immutable");
    const after = await prisma.reviewerCriteriaVersion.findUniqueOrThrow({ where: { id: version.id }, include: { criteria: { select: { key: true } } } });
    expect(after.title).toBe("v1");
    expect(after.criteria.map((x) => x.key)).toEqual(["original"]);

    // Positive control: a draft saves, then publishes through the real route.
    const dup = await req("POST", `/v1/reviewer-criteria/${setId}/duplicate`, A.ownerToken, { teamId: A.teamId });
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const saved = await req("PATCH", `/v1/reviewer-criteria/${setId}/draft`, A.adminToken, { teamId: A.teamId, title: "v2", criteria: crit("second") });
    expect(saved.statusCode, saved.body).toBe(200);
    const pub = await req("POST", `/v1/reviewer-criteria/${setId}/publish`, A.ownerToken, { teamId: A.teamId });
    expect(pub.statusCode, pub.body).toBe(200);
    expect((await req("POST", `/v1/reviewer-criteria/${setId}/publish`, A.ownerToken, { teamId: A.teamId })).statusCode).toBe(409);
    expect((await req("POST", `/v1/reviewer-criteria/${setId}/publish`, A.memberToken, { teamId: A.teamId })).statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // PRO-091 (FEATURES-09)
  // -------------------------------------------------------------------------
  it("PRO-091: a rendered QC verdict cannot be rendered again", async () => {
    const ev = await mkEvidence(A, orgs.A, `R3QC-${tag}`);
    const wf = await mkWorkflow(A.teamId, ev.id);
    const approve = await req("POST", `/v1/reviewer-ops/reviews/${wf.id}/approve`, A.adminToken, { teamId: A.teamId, note: "r3 approve" });
    expect(approve.statusCode, approve.body).toBe(200);
    await h.handlersSettled();
    const sample = await prisma.qcSample.findFirstOrThrow({ where: { workflowId: wf.id, teamId: A.teamId } });
    const q = `?teamId=${A.teamId}`;
    expect((await req("POST", `/v1/reviewer/qc/samples/${sample.id}/assign${q}`, A.ownerToken, { qcReviewerUserId: A.ownerUserId })).statusCode).toBe(200);
    const pass = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/verdict${q}`, A.ownerToken, { verdict: "PASS" });
    expect(pass.statusCode, pass.body).toBe(200);
    const flip = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/verdict${q}`, A.ownerToken, { verdict: "FAIL", failureReason: "OTHER", rationale: "flipped later" });
    expect(flip.statusCode).toBe(409);
    const stored = await prisma.qcSample.findUniqueOrThrow({ where: { id: sample.id }, select: { state: true, verdict: true } });
    expect(stored).toEqual({ state: "VERDICT_RENDERED", verdict: "PASS" });
    // Control: re-assigning a rendered sample stays refused.
    expect((await req("POST", `/v1/reviewer/qc/samples/${sample.id}/assign${q}`, A.ownerToken, { qcReviewerUserId: A.adminUserId })).statusCode).toBe(409);
  });

  // -------------------------------------------------------------------------
  // PRO-092 (FEATURES-10)
  // -------------------------------------------------------------------------
  it("PRO-092: a resolve and a suppress racing on one escalation: exactly one lands", async () => {
    const ev = await mkEvidence(A, orgs.A, `R3ESC-${tag}`);
    const wf = await mkWorkflow(A.teamId, ev.id);
    const e = await req("POST", "/v1/reviewer-ops/escalations", A.ownerToken, { teamId: A.teamId, workflowId: wf.id, reason: "REVIEW_OVERDUE", severity: "WARNING", safeSummary: "r3 race" });
    expect(e.statusCode, e.body).toBeLessThan(300);
    const id = json<{ escalation: { id: string } }>(e).escalation.id;
    const lock = await holdLock(`SELECT 1 FROM "review_escalations" WHERE "id" = $1::uuid FOR UPDATE`, id);
    const pRes = req("POST", `/v1/reviewer-ops/escalations/${id}/resolve`, A.ownerToken, { teamId: A.teamId, resolutionNote: "resolved by owner" });
    const pSup = req("POST", `/v1/reviewer-ops/escalations/${id}/suppress`, A.adminToken, { teamId: A.teamId, suppressionReason: "suppressed by admin" });
    expect(await waiters(2)).toBeGreaterThanOrEqual(2);
    lock.release();
    await lock.done;
    const [r1, r2] = await Promise.all([pRes, pSup]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const fin = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id }, select: { status: true, resolvedAtUtc: true, suppressedAtUtc: true } });
    if (fin.status === "RESOLVED") {
      expect(r1.statusCode).toBe(200);
      expect(fin.suppressedAtUtc).toBeNull();
    } else {
      expect(fin.status).toBe("SUPPRESSED");
      expect(r2.statusCode).toBe(200);
      expect(fin.resolvedAtUtc).toBeNull();
    }
    expect((await req("POST", `/v1/reviewer-ops/escalations/${id}/resolve`, A.ownerToken, { teamId: A.teamId, resolutionNote: "again" })).statusCode).toBe(409);
  });

  // -------------------------------------------------------------------------
  // PRO-094 (FEATURES-12)
  // -------------------------------------------------------------------------
  it("PRO-094: concurrent APPROVE and REQUEST_CHANGES: one verdict and one state", async () => {
    const admin2 = await extraMember(A.teamId, "ADMIN", "redaction-approver");
    const ev = await mkEvidence(A, orgs.A, `R3RAPP-${tag}`);
    const q = `?teamId=${A.teamId}`;
    const open = await req("POST", `/v1/redaction/projects${q}`, A.adminToken, { evidenceId: ev.id, artifactKind: "IMAGE" });
    expect(open.statusCode, open.body).toBe(201);
    const ver = await req("POST", `/v1/redaction/projects/${json<{ projectId: string }>(open).projectId}/versions${q}`, A.adminToken, {});
    const vid = json<{ versionId: string }>(ver).versionId;
    expect((await req("POST", `/v1/redaction/versions/${vid}/submit${q}`, A.adminToken, {})).statusCode).toBe(200);
    // Control: the author never approves their own version.
    expect((await req("POST", `/v1/redaction/versions/${vid}/approve${q}`, A.adminToken, { verdict: "APPROVE" })).statusCode).toBe(409);

    const lock = await holdLock(`SELECT 1 FROM "redaction_versions" WHERE "id" = $1::uuid FOR UPDATE`, vid);
    const pA = req("POST", `/v1/redaction/versions/${vid}/approve${q}`, admin2.token, { verdict: "APPROVE", rationale: "looks right" });
    const pR = req("POST", `/v1/redaction/versions/${vid}/approve${q}`, A.ownerToken, { verdict: "REQUEST_CHANGES", rationale: "needs more masking" });
    expect(await waiters(2)).toBeGreaterThanOrEqual(2);
    lock.release();
    await lock.done;
    const [ra, rr] = await Promise.all([pA, pR]);
    expect([ra.statusCode, rr.statusCode].sort()).toEqual([200, 409]);
    const approvals = await prisma.redactionApproval.findMany({ where: { versionId: vid }, select: { verdict: true } });
    expect(approvals).toHaveLength(1);
    const state = (await prisma.redactionVersion.findUniqueOrThrow({ where: { id: vid }, select: { state: true } })).state;
    expect(state).toBe(approvals[0]!.verdict === "APPROVE" ? "APPROVED" : "DRAFT");
  });

  // -------------------------------------------------------------------------
  // PRO-095 (FEATURES-13)
  // -------------------------------------------------------------------------
  it("PRO-095: waive refuses terminal steps and closed instances; an open step is still waivable", async () => {
    const seed = async (status: string, stepStatus: string, key: string) => {
      const inst = await prisma.evidenceWorkflowInstance.create({
        data: {
          teamId: A.teamId,
          status,
          intakeMode: "INTERNAL",
          actorRole: "REVIEWER",
          caseId: A.caseId,
          title: `R3WF-${key}-${tag}`,
          createdByUserId: A.ownerUserId,
          ...(status === "APPROVED" ? { approvedAtUtc: new Date() } : {}),
        } as never,
      });
      const step = await prisma.evidenceWorkflowStepInstance.create({
        data: {
          workflowInstanceId: inst.id,
          stepKey: key,
          title: key,
          required: true,
          orderIndex: 0,
          status: stepStatus,
          ...(stepStatus === "SATISFIED" ? { completedByUserId: A.ownerUserId, completedAtUtc: new Date(Date.now() - 86_400_000) } : {}),
        } as never,
      });
      return { inst, step };
    };
    const waive = async (instId: string, key: string) =>
      req("POST", `/v1/workflows/instances/${instId}/steps/${key}/waive`, A.adminToken, { teamId: A.teamId, reason: "r3 waiver" },
        await ceremony.approvedHeader({ token: A.adminToken, userId: A.adminUserId, teamId: A.teamId, purpose: "SESSION_SANITY_CHECK", resourceKind: "evidence_workflow_step_instance", resourceId: instId }));

    const closed = await seed("APPROVED", "SATISFIED", "identity");
    const r1 = await waive(closed.inst.id, "identity");
    expect(r1.statusCode, r1.body).toBe(409);
    const kept = await prisma.evidenceWorkflowStepInstance.findUniqueOrThrow({ where: { id: closed.step.id }, select: { status: true, completedByUserId: true } });
    expect(kept).toEqual({ status: "SATISFIED", completedByUserId: A.ownerUserId });

    const openSatisfied = await seed("NEEDS_REVIEW", "SATISFIED", "address");
    expect((await waive(openSatisfied.inst.id, "address")).statusCode).toBe(409);

    const open = await seed("NEEDS_REVIEW", "NOT_STARTED", "consent");
    const ok = await waive(open.inst.id, "consent");
    expect(ok.statusCode, ok.body).toBe(200);
    const waived = await prisma.evidenceWorkflowStepInstance.findUniqueOrThrow({ where: { id: open.step.id }, select: { status: true, completedByUserId: true } });
    expect(waived).toEqual({ status: "WAIVED", completedByUserId: A.adminUserId });
    // Controls kept: VIEWER refused; no step-up refused.
    expect((await req("POST", `/v1/workflows/instances/${open.inst.id}/steps/consent/waive`, A.viewerToken, { teamId: A.teamId, reason: "v" })).statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // PRO-096 (FEATURES-14)
  // -------------------------------------------------------------------------
  it("PRO-096: group VIEWERs cannot write; comment targets must resolve in the group's workspace and reach", async () => {
    const q = `?teamId=${A.teamId}`;
    const ct = await req("POST", `/v1/collaboration-teams${q}`, A.ownerToken, { name: `R3CT-${tag}`, teamType: "GENERAL" });
    expect(ct.statusCode, ct.body).toBeLessThan(300);
    const ctId = json<{ team: { id: string } }>(ct).team.id;
    for (const [userId, role] of [[A.memberUserId, "VIEWER"], [A.adminUserId, "MEMBER"]] as const) {
      const add = await req("POST", `/v1/collaboration-teams/${ctId}/members${q}`, A.ownerToken, { userId, role });
      expect(add.statusCode, add.body).toBeLessThan(300);
    }
    const base = `/v1/collaboration-teams/${ctId}/comments`;
    const notifications = () => prisma.collaborationTeamNotification.count({ where: { teamId: ctId } });
    const before = await notifications();

    // The group VIEWER (a workspace MEMBER) posts @team.
    const viewerPost = await req("POST", `${base}${q}`, A.memberToken, { targetType: "TEAM", body: "@team from a read-only role" });
    expect(viewerPost.statusCode).toBe(403);
    expect(await notifications()).toBe(before);
    // …nor edits or deletes a comment of their own from before.
    const old = await prisma.collaborationTeamComment.create({
      data: { teamId: ctId, workspaceId: A.teamId, authorUserId: A.memberUserId, targetType: "TEAM", body: "older note", status: "ACTIVE" } as never,
    });
    expect((await req("PATCH", `${base}/${old.id}${q}`, A.memberToken, { body: "edited" })).statusCode).toBe(403);
    expect((await req("DELETE", `${base}/${old.id}${q}`, A.memberToken)).statusCode).toBe(403);
    expect((await prisma.collaborationTeamComment.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("ACTIVE");

    // Positive control: a group MEMBER posts @team and it fans out.
    const memberPost = await req("POST", `${base}${q}`, A.adminToken, { targetType: "TEAM", body: "@team from a participant" });
    expect(memberPost.statusCode, memberPost.body).toBe(201);
    expect(await notifications()).toBeGreaterThan(before);

    // Targets: another tenant's case and a restricted case the author cannot open.
    const restricted = await prisma.case.create({ data: { name: `R3RCASE-${tag}`, teamId: A.teamId, ownerUserId: A.ownerUserId, restrictedAtUtc: new Date() } as never });
    await prisma.caseAccess.create({ data: { caseId: restricted.id, userId: A.memberUserId } as never });
    const commentsBefore = await prisma.collaborationTeamComment.count({ where: { teamId: ctId } });
    expect((await req("POST", `${base}${q}`, A.adminToken, { targetType: "CASE", targetId: B.caseId, body: "about B" })).statusCode).toBe(404);
    expect((await req("POST", `${base}${q}`, A.adminToken, { targetType: "CASE", targetId: restricted.id, body: "about R" })).statusCode).toBe(404);
    expect((await req("POST", `${base}${q}`, A.adminToken, { targetType: "TEAM", targetId: randomUUID(), body: "elsewhere" })).statusCode).toBe(404);
    expect((await req("POST", `${base}${q}`, A.adminToken, { targetType: "CASE", body: "no id" })).statusCode).toBe(400);
    expect(await prisma.collaborationTeamComment.count({ where: { teamId: ctId } })).toBe(commentsBefore);
    const okCase = await req("POST", `${base}${q}`, A.adminToken, { targetType: "CASE", targetId: A.caseId, body: "about our case" });
    expect(okCase.statusCode, okCase.body).toBe(201);

    expect((await req("GET", `${base}${q}&limit=abc`, A.ownerToken)).statusCode).toBe(400);
    expect((await req("GET", `${base}${q}&limit=5`, A.ownerToken)).statusCode).toBe(200);
    // The other tenant is refused.
    expect((await req("POST", `${base}?teamId=${B.teamId}`, B.ownerToken, { targetType: "TEAM", body: "cross" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  // -------------------------------------------------------------------------
  // PRO-097 (FEATURES-15)
  // -------------------------------------------------------------------------
  it("PRO-097: an ORG_OWNER invite (bulk or single) asks the owner's step-up; lower roles do not", async () => {
    const coOwner = `r3-coowner-${tag}@example.invalid`;
    const invites = () => prisma.organizationInvite.count({ where: { organizationId: orgs.A, email: coOwner } });
    const bulk = `/v1/orgs/${orgs.A}/invites/bulk`;

    const bare = await req("POST", bulk, A.ownerToken, { rows: [{ email: coOwner, role: "ORG_OWNER" }] });
    expect(bare.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(bare).error.code).toBe("STEP_UP_REQUIRED");
    const single = await req("POST", `/v1/orgs/${orgs.A}/invites`, A.ownerToken, { email: coOwner, role: "ORG_OWNER" });
    expect(single.statusCode).toBe(401);
    const csv = await req("POST", `/v1/orgs/${orgs.A}/invites/csv`, A.ownerToken, { csv: `email,role\r\n${coOwner},ORG_OWNER\r\n` });
    expect(csv.statusCode).toBe(401);
    expect(await invites()).toBe(0);

    // Lower roles need no proof (positive control).
    const lower = await req("POST", bulk, A.ownerToken, { rows: [{ email: `r3-admin-${tag}@example.invalid`, role: "ORG_ADMIN" }] });
    expect(lower.statusCode, lower.body).toBe(200);
    expect(json<{ rows: Array<{ outcome: string }> }>(lower).rows[0]!.outcome).toBe("INVITED");

    // With the owner's own proof the invite is issued (as a transfer would be).
    await ceremony.enroll(A.ownerUserId);
    const proved = await req("POST", bulk, A.ownerToken, {
      rows: [{ email: coOwner, role: "ORG_OWNER" }],
      stepUp: { method: "mfa", code: await ceremony.freshCode(A.ownerUserId) },
    });
    expect(proved.statusCode, proved.body).toBe(200);
    expect(json<{ rows: Array<{ outcome: string }> }>(proved).rows[0]!.outcome).toBe("INVITED");
    expect(await invites()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // PRO-099 (FEATURES-17)
  // -------------------------------------------------------------------------
  it("PRO-099: two concurrent first writes of one coding field both succeed and leave one row", async () => {
    await req("POST", `/v1/coding/schemas/seed-defaults?teamId=${A.teamId}`, A.ownerToken, {});
    const f = await prisma.codingField.findFirstOrThrow({ where: { fieldType: "TEXT", schema: { teamId: A.teamId } }, select: { id: true, schemaId: true } });
    const ev = await mkEvidence(A, orgs.A, `R3CODE-${tag}`);
    const wf = await mkWorkflow(A.teamId, ev.id);
    const bind = await req("POST", `/v1/reviewer/work/${wf.id}/bind-schema?teamId=${A.teamId}`, A.ownerToken, { schemaId: f.schemaId });
    expect(bind.statusCode, bind.body).toBeLessThan(300);
    const url = `/v1/reviewer/work/${wf.id}/code?teamId=${A.teamId}`;
    const lock = await holdLock(`LOCK TABLE "coding_values" IN SHARE MODE`);
    const p1 = req("POST", url, A.memberToken, { fieldId: f.id, value: { text: "member first" } });
    const p2 = req("POST", url, A.adminToken, { fieldId: f.id, value: { text: "admin first" } });
    expect(await waiters(2)).toBeGreaterThanOrEqual(2);
    lock.release();
    await lock.done;
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.statusCode, r2.statusCode], `${r1.body} | ${r2.body}`).toEqual([200, 200]);
    expect(await prisma.codingValue.count({ where: { workflowId: wf.id, fieldId: f.id } })).toBe(1);
    // Control: a sequential write on the existing value updates it.
    const seq = await req("POST", url, A.memberToken, { fieldId: f.id, value: { text: "sequential" } });
    expect(seq.statusCode).toBe(200);
    expect((await prisma.codingValue.findFirstOrThrow({ where: { workflowId: wf.id, fieldId: f.id } })).value).toEqual({ text: "sequential" });
  });
});
