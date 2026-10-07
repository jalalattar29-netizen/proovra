/**
 * THE ACQUISITION IDENTITY SNAPSHOT, PER CHANNEL — live PostgreSQL 16, each
 * channel's REAL creation path.
 *
 * createEvidence is the one writer of the creation-time
 * IDENTITY_SNAPSHOT_RECORDED custody event, and
 * resolveAcquisitionIdentitySnapshot (@proovra/shared) is the one reader. For
 * every channel this suite:
 *   1. creates the record through that channel's own entry point;
 *   2. reads the custody chain from the database and asserts the event payload
 *      (actorKind, accountRole, workspaceKind, emailVerified, identity level,
 *      provider; intake: the contributor's address is never in it);
 *   3. asserts the resolver reads it as OBSERVED_AT_CAPTURE with those values
 *      (a record with no event: RECORDED_ON_RECORD / UNAVAILABLE, and
 *      organizationVerified always null);
 *   4. NEVER STRENGTHENED: verifies the owner's email, marks the workspace
 *      VERIFIED, renames it — and even rewrites the record's own identity
 *      columns the way an old report run did — and asserts the resolver output
 *      for the EXISTING record is unchanged. A control proves those very
 *      mutations ARE what the writer reads for a NEW record.
 *
 * Paths driven:
 *   web upload ........ POST /v1/evidence (real HTTP)
 *   secure intake ..... createOrLoadExternalEvidence(pair, seed) on a real
 *                       link (createWorkflowIntakeLink) + real session row
 *   direct capture .... POST /v1/capture/direct-sessions then
 *                       POST /v1/capture/direct-sessions/:id/evidence (real
 *                       HTTP, reserveDirectCaptureEvidence); the extension
 *                       mode with its own capture-scoped credential
 *   guest owner ....... createEvidence (no guest sign-in path exists any more:
 *                       guest login is removed and legacy guest tokens cannot
 *                       authenticate, so the writer is the deepest real layer)
 *   legacy ............ a row written directly, with no creation event
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAcquisitionIdentitySnapshot, type AcquisitionIdentitySnapshot } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

describe("acquisition identity snapshot — every channel, real creation path (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let extensionToken: string;
  let originalBilling: Record<string, unknown> | null = null;
  const provisionedPolicies: string[] = [];
  const extraUserIds: string[] = [];
  const extraTeamIds: string[] = [];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "acq-identity-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    const A = h.fixtures.teamA;
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: A.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });

    // UC-SEC-004 — an extension capture is checked against the target
    // Organization's provisioned security policy (as uc1-web-capture does).
    const t = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    if (t.organizationId && !(await prisma.organizationSecurityPolicy.findUnique({ where: { organizationId: t.organizationId } }))) {
      await prisma.organizationSecurityPolicy.create({ data: { organizationId: t.organizationId } });
      provisionedPolicies.push(t.organizationId);
    }
    const { signJwt } = await import("../src/services/jwt.js");
    const { EXTENSION_CAPTURE_SCOPE } = await import("../src/services/auth/extension-scope.js");
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: A.ownerUserId }, select: { email: true } });
    extensionToken = signJwt(
      {
        sub: A.ownerUserId,
        provider: "EMAIL",
        email: ownerRow.email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        scope: EXTENSION_CAPTURE_SCOPE,
      } as never,
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
  }, 600_000);

  afterAll(async () => {
    if (!h) return;
    for (const organizationId of provisionedPolicies) {
      await prisma.organizationSecurityPolicy.delete({ where: { organizationId } }).catch(() => undefined);
    }
    if (originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    if (extraTeamIds.length) {
      await prisma.evidence.deleteMany({ where: { teamId: { in: extraTeamIds } } }).catch(() => undefined);
      await prisma.teamMember.deleteMany({ where: { teamId: { in: extraTeamIds } } }).catch(() => undefined);
      await prisma.team.deleteMany({ where: { id: { in: extraTeamIds } } }).catch(() => undefined);
    }
    if (extraUserIds.length) {
      await prisma.guestIdentity.deleteMany({ where: { userId: { in: extraUserIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Reading a record back
  // ---------------------------------------------------------------------------

  async function readBack(evidenceId: string) {
    const events = await prisma.custodyEvent.findMany({
      where: { evidenceId },
      orderBy: { sequence: "asc" },
      select: { eventType: true, atUtc: true, payload: true },
    });
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: {
        acquisitionMode: true,
        identityLevelSnapshot: true,
        submittedByAuthProvider: true,
        submittedByEmail: true,
        submittedByUserId: true,
        workspaceNameSnapshot: true,
        organizationNameSnapshot: true,
        organizationVerifiedSnapshot: true,
      },
    });
    const identityEvents = events.filter((e) => e.eventType === "IDENTITY_SNAPSHOT_RECORDED");
    const resolved = resolveAcquisitionIdentitySnapshot({
      custodyEvents: events.map((e) => ({ eventType: e.eventType, atUtc: e.atUtc, payload: e.payload })),
      row,
      acquisitionMode: row.acquisitionMode,
    });
    return {
      row,
      identityEvents,
      payload: (identityEvents[0]?.payload ?? null) as Record<string, unknown> | null,
      resolved,
    };
  }

  type Expected = {
    acquisitionMode: string;
    actorKind: "ACCOUNT_USER" | "INTAKE_CONTRIBUTOR" | "GUEST_SESSION";
    accountRole: "SUBMITTER" | "INTAKE_LINK_ISSUER";
    contributorEmailProvided: boolean | null;
    workspaceKind: "PERSONAL" | "SHARED";
    emailVerified: boolean;
    identityLevel: string;
    authProvider: string;
    workspaceName: string | null;
    organizationVerified: boolean;
    submittedByUserId: string;
    submittedByEmail: string | null;
  };

  /** Steps 2 and 3: the event payload and the resolver's reading of it. */
  async function assertObserved(evidenceId: string, x: Expected): Promise<AcquisitionIdentitySnapshot> {
    const { row, identityEvents, payload, resolved } = await readBack(evidenceId);
    expect(row.acquisitionMode).toBe(x.acquisitionMode);
    // Exactly one creation-time snapshot, written by the canonical writer.
    expect(identityEvents).toHaveLength(1);
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      actorKind: x.actorKind,
      accountRole: x.accountRole,
      contributorEmailProvided: x.contributorEmailProvided,
      workspaceKind: x.workspaceKind,
      emailVerified: x.emailVerified,
      identityLevelSnapshot: x.identityLevel,
      submittedByAuthProvider: x.authProvider,
      submittedByUserId: x.submittedByUserId,
      submittedByEmail: x.submittedByEmail,
      workspaceNameSnapshot: x.workspaceName,
      organizationVerifiedSnapshot: x.organizationVerified,
    });

    expect(resolved).toMatchObject({
      basis: "OBSERVED_AT_CAPTURE",
      actorKind: x.actorKind,
      accountRole: x.accountRole,
      contributorEmailProvided: x.contributorEmailProvided,
      workspaceKind: x.workspaceKind,
      emailVerified: x.emailVerified,
      identityLevel: x.identityLevel,
      authProvider: x.authProvider,
      workspaceName: x.workspaceName,
      organizationVerified: x.organizationVerified,
      submittedByUserId: x.submittedByUserId,
      submittedByEmail: x.submittedByEmail,
    });
    expect(resolved.recordedAtUtc).not.toBeNull();
    return resolved;
  }

  /**
   * Step 4 — NEVER STRENGTHENED. Every piece of CURRENT state the writer reads
   * is strengthened (owner email verified, workspace VERIFIED, workspace and
   * legal name changed, workspace label set), and the record's own identity
   * columns are rewritten the way an old report run re-derived them. The
   * resolver output for the existing record must be identical. Current state
   * is restored afterwards so cases stay independent.
   */
  async function assertNeverStrengthened(
    evidenceId: string,
    who: { ownerUserId: string; teamId: string },
    before: AcquisitionIdentitySnapshot,
    opts: { rewriteRecordColumns: boolean } = { rewriteRecordColumns: true },
  ): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: who.ownerUserId }, select: { emailVerifiedAt: true } });
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: who.teamId },
      select: { name: true, legalName: true, verificationState: true, evidenceWorkspaceLabel: true },
    });
    try {
      await prisma.user.update({ where: { id: who.ownerUserId }, data: { emailVerifiedAt: new Date() } });
      await prisma.team.update({
        where: { id: who.teamId },
        data: {
          name: `Renamed ${randomUUID().slice(0, 8)}`,
          legalName: "Renamed Legal Entity Ltd",
          evidenceWorkspaceLabel: "Renamed Label",
          verificationState: "VERIFIED",
        },
      });
      if (opts.rewriteRecordColumns) {
        await prisma.evidence.update({
          where: { id: evidenceId },
          data: {
            identityLevelSnapshot: "VERIFIED_ORGANIZATION",
            organizationVerifiedSnapshot: true,
            workspaceNameSnapshot: "Renamed Label",
            organizationNameSnapshot: "Renamed Legal Entity Ltd",
          } as never,
        });
      }
      const after = (await readBack(evidenceId)).resolved;
      expect(after).toEqual(before);
      // Named explicitly — the four facts the mandate pins.
      expect(after.identityLevel).toBe(before.identityLevel);
      expect(after.emailVerified).toBe(before.emailVerified);
      expect(after.organizationVerified).toBe(before.organizationVerified);
      expect(after.workspaceName).toBe(before.workspaceName);
    } finally {
      await prisma.user.update({ where: { id: who.ownerUserId }, data: { emailVerifiedAt: user.emailVerifiedAt } });
      await prisma.team.update({ where: { id: who.teamId }, data: team });
    }
  }

  const emailOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
  const teamNameOf = async (teamId: string) =>
    (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { name: true } })).name;

  // ---------------------------------------------------------------------------
  // Channel drivers
  // ---------------------------------------------------------------------------

  async function webUpload(token: string, teamId: string | null): Promise<string> {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "PHOTO", mimeType: "image/jpeg", ...(teamId ? { teamId } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { id?: string }).id;
    expect(typeof id).toBe("string");
    return id!;
  }

  async function directCapture(token: string, mode: string, teamId: string | null): Promise<string> {
    const open = await h.app.inject({
      method: "POST",
      url: "/v1/capture/direct-sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { mode, ...(teamId ? { teamId } : {}), deviceId: null },
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = (open.json() as { session: { captureSessionId: string } }).session.captureSessionId;
    const reserve = await h.app.inject({
      method: "POST",
      url: `/v1/capture/direct-sessions/${sessionId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "PHOTO", mimeType: "image/jpeg" },
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = (reserve.json() as { evidence: { evidenceId: string; acquisitionMode: string } }).evidence.evidenceId;
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { finalizedEvidenceId: true } });
    expect(session.finalizedEvidenceId).toBe(evidenceId);
    return evidenceId;
  }

  async function intake(contributorEmail: string | null): Promise<string> {
    const A = h.fixtures.teamA;
    const { createWorkflowIntakeLink } = await import("../src/services/workflow-intake-link.service.js");
    const { createOrLoadExternalEvidence } = await import("../src/services/external-intake-orchestration.service.js");
    const minted = await createWorkflowIntakeLink(
      {
        teamId: A.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        recipientLabel: "acquisition identity",
        maxUses: 5,
        expiresAtUtc: new Date(Date.now() + 3_600_000),
      } as never,
      { actorUserId: A.ownerUserId },
    );
    const linkId = (minted.link as { id: string }).id;
    const sessionRow = await prisma.workflowIntakeSession.create({
      data: {
        intakeLinkId: linkId,
        status: "OPENED",
        openedAtUtc: new Date(),
        consentAcceptedAtUtc: new Date(),
        submitterEmail: contributorEmail,
        submitterDisplayName: contributorEmail ? "Contributor With Email" : null,
        expiresAtUtc: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    // The real rows, exactly as the public intake route loads them.
    const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: linkId } });
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sessionRow.id } });
    const evidence = await createOrLoadExternalEvidence({ link, session }, { mimeType: "image/jpeg", originalFileName: "intake.jpg" });
    const bound = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sessionRow.id }, select: { evidenceId: true } });
    expect(bound.evidenceId).toBe(evidence.id);
    return evidence.id;
  }

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------

  it("web upload, PERSONAL workspace (POST /v1/evidence): signed-in submitter, basic account, personal", async () => {
    const P = h.fixtures.personal;
    const id = await webUpload(P.token, null);
    const before = await assertObserved(id, {
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      actorKind: "ACCOUNT_USER",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
      workspaceKind: "PERSONAL",
      emailVerified: false,
      identityLevel: "BASIC_ACCOUNT",
      authProvider: "EMAIL",
      workspaceName: null,
      organizationVerified: false,
      submittedByUserId: P.userId,
      submittedByEmail: await emailOf(P.userId),
    });
    await assertNeverStrengthened(id, { ownerUserId: P.userId, teamId: P.teamId }, before);
  });

  it("web upload, SHARED workspace (POST /v1/evidence): signed-in submitter, organization account, not verified", async () => {
    const A = h.fixtures.teamA;
    const id = await webUpload(A.ownerToken, A.teamId);
    const before = await assertObserved(id, {
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      actorKind: "ACCOUNT_USER",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
      workspaceKind: "SHARED",
      emailVerified: false,
      identityLevel: "ORGANIZATION_ACCOUNT",
      authProvider: "EMAIL",
      workspaceName: await teamNameOf(A.teamId),
      organizationVerified: false,
      submittedByUserId: A.ownerUserId,
      submittedByEmail: await emailOf(A.ownerUserId),
    });
    await assertNeverStrengthened(id, { ownerUserId: A.ownerUserId, teamId: A.teamId }, before);
  });

  it("CONTROL: the strengthened current state IS what the writer reads for a NEW record", async () => {
    const A = h.fixtures.teamA;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: A.ownerUserId }, select: { emailVerifiedAt: true } });
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A.teamId },
      select: { name: true, legalName: true, verificationState: true, evidenceWorkspaceLabel: true },
    });
    try {
      await prisma.user.update({ where: { id: A.ownerUserId }, data: { emailVerifiedAt: new Date() } });
      await prisma.team.update({
        where: { id: A.teamId },
        data: { verificationState: "VERIFIED", evidenceWorkspaceLabel: "Control Label", legalName: "Control Legal Ltd" },
      });
      const id = await webUpload(A.ownerToken, A.teamId);
      const { resolved } = await readBack(id);
      expect(resolved).toMatchObject({
        basis: "OBSERVED_AT_CAPTURE",
        identityLevel: "VERIFIED_ORGANIZATION",
        emailVerified: true,
        organizationVerified: true,
        workspaceName: "Control Label",
        organizationName: "Control Legal Ltd",
        workspaceKind: "SHARED",
      });
    } finally {
      await prisma.user.update({ where: { id: A.ownerUserId }, data: { emailVerifiedAt: user.emailVerifiedAt } });
      await prisma.team.update({ where: { id: A.teamId }, data: team });
    }
  });

  for (const withEmail of [true, false]) {
    it(`secure intake (createOrLoadExternalEvidence), contributor ${withEmail ? "WITH" : "WITHOUT"} an email: intake contributor, link-issuer account fields, address never recorded`, async () => {
      const A = h.fixtures.teamA;
      const contributorEmail = withEmail ? `contributor-${randomUUID().slice(0, 8)}@contributor.example` : null;
      const id = await intake(contributorEmail);
      const before = await assertObserved(id, {
        acquisitionMode: "SECURE_INTAKE_LINK",
        actorKind: "INTAKE_CONTRIBUTOR",
        accountRole: "INTAKE_LINK_ISSUER",
        contributorEmailProvided: withEmail,
        workspaceKind: "SHARED",
        emailVerified: false,
        identityLevel: "ORGANIZATION_ACCOUNT",
        authProvider: "EMAIL",
        workspaceName: await teamNameOf(A.teamId),
        organizationVerified: false,
        // The account fields describe the link's ISSUER, never the contributor.
        submittedByUserId: A.ownerUserId,
        submittedByEmail: await emailOf(A.ownerUserId),
      });
      const { payload, row } = await readBack(id);
      if (contributorEmail) {
        expect(JSON.stringify(payload)).not.toContain(contributorEmail);
        expect(JSON.stringify(payload)).not.toContain("contributor.example");
        expect(JSON.stringify(before)).not.toContain(contributorEmail);
        // The snapshot is independent of the record's columns: the intake
        // ingress post-updates `evidence.submittedByEmail` to the contributor's
        // address (documented in external-intake-orchestration.service.ts),
        // yet neither the creation event nor the resolver carries it.
        expect(row.submittedByEmail).toBe(contributorEmail);
        expect(before.submittedByEmail).toBe(await emailOf(A.ownerUserId));
      }
      await assertNeverStrengthened(id, { ownerUserId: A.ownerUserId, teamId: A.teamId }, before);
    });
  }

  const directModes: Array<{ label: string; mode: string; extension?: boolean }> = [
    { label: "mobile app", mode: "PROOVRA_MOBILE_APP" },
    { label: "browser extension (capture-scoped credential)", mode: "DIRECT_WEB_CAPTURE_EXTENSION", extension: true },
    { label: "Android screen capture", mode: "DIRECT_SCREEN_CAPTURE_ANDROID" },
    { label: "Android continuous capture", mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" },
    { label: "iOS screen capture", mode: "DIRECT_SCREEN_CAPTURE_IOS" },
  ];
  for (const c of directModes) {
    it(`direct capture — ${c.label} (POST /v1/capture/direct-sessions + /:id/evidence): signed-in submitter, shared workspace`, async () => {
      const A = h.fixtures.teamA;
      const id = await directCapture(c.extension ? extensionToken : A.ownerToken, c.mode, A.teamId);
      const before = await assertObserved(id, {
        acquisitionMode: c.mode,
        actorKind: "ACCOUNT_USER",
        accountRole: "SUBMITTER",
        contributorEmailProvided: null,
        workspaceKind: "SHARED",
        emailVerified: false,
        identityLevel: "ORGANIZATION_ACCOUNT",
        authProvider: "EMAIL",
        workspaceName: await teamNameOf(A.teamId),
        organizationVerified: false,
        submittedByUserId: A.ownerUserId,
        submittedByEmail: await emailOf(A.ownerUserId),
      });
      await assertNeverStrengthened(id, { ownerUserId: A.ownerUserId, teamId: A.teamId }, before);
    });
  }

  it("direct capture — mobile app into the PERSONAL workspace: personal, basic account", async () => {
    const P = h.fixtures.personal;
    const id = await directCapture(P.token, "PROOVRA_MOBILE_APP", null);
    const before = await assertObserved(id, {
      acquisitionMode: "PROOVRA_MOBILE_APP",
      actorKind: "ACCOUNT_USER",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
      workspaceKind: "PERSONAL",
      emailVerified: false,
      identityLevel: "BASIC_ACCOUNT",
      authProvider: "EMAIL",
      workspaceName: null,
      organizationVerified: false,
      submittedByUserId: P.userId,
      submittedByEmail: await emailOf(P.userId),
    });
    await assertNeverStrengthened(id, { ownerUserId: P.userId, teamId: P.teamId }, before);
  });

  it("guest owner (createEvidence; no guest sign-in path exists): GUEST_SESSION actor", async () => {
    const { createEvidence } = await import("../src/services/evidence.service.js");
    const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
    const guest = await prisma.user.create({
      data: { provider: "GUEST", providerUserId: `guest-${randomUUID()}` } as never,
      select: { id: true },
    });
    extraUserIds.push(guest.id);
    const personal = await ensurePersonalWorkspace({ userId: guest.id });
    extraTeamIds.push(personal.teamId);
    const created = await createEvidence({
      ownerUserId: guest.id,
      type: "PHOTO",
      mimeType: "image/jpeg",
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
    });
    const before = await assertObserved(created.id, {
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      actorKind: "GUEST_SESSION",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
      workspaceKind: "PERSONAL",
      emailVerified: false,
      identityLevel: "BASIC_ACCOUNT",
      authProvider: "GUEST",
      workspaceName: null,
      organizationVerified: false,
      submittedByUserId: guest.id,
      submittedByEmail: null,
    });
    await assertNeverStrengthened(created.id, { ownerUserId: guest.id, teamId: personal.teamId }, before);
  });

  // ---------------------------------------------------------------------------
  // Legacy / imported — no creation event
  // ---------------------------------------------------------------------------

  async function legacyRow(data: Record<string, unknown>): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "legacy acquisition identity fixture",
        type: "PHOTO",
        status: "CREATED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        ...data,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  it("legacy record WITH stored identity columns: RECORDED_ON_RECORD, organizationVerified null, never strengthened", async () => {
    const A = h.fixtures.teamA;
    const id = await legacyRow({
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      acquisitionModeSource: "RECORDED_AT_CREATION",
      identityLevelSnapshot: "ORGANIZATION_ACCOUNT",
      submittedByAuthProvider: "EMAIL",
      submittedByEmail: "legacy@workspace.example",
      submittedByUserId: A.ownerUserId,
      workspaceNameSnapshot: "Legacy Workspace",
      organizationNameSnapshot: "Legacy Org",
      // A value an old report run may have re-derived from CURRENT state —
      // the resolver never presents it as recorded at capture.
      organizationVerifiedSnapshot: true,
    });
    const { identityEvents, resolved } = await readBack(id);
    expect(identityEvents).toHaveLength(0);
    expect(resolved).toMatchObject({
      basis: "RECORDED_ON_RECORD",
      recordedAtUtc: null,
      actorKind: "ACCOUNT_USER",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
      identityLevel: "ORGANIZATION_ACCOUNT",
      authProvider: "EMAIL",
      emailVerified: null,
      workspaceKind: "NOT_RECORDED",
      workspaceName: "Legacy Workspace",
      organizationName: "Legacy Org",
      organizationVerified: null,
      submittedByEmail: "legacy@workspace.example",
    });
    // Current state strengthened; the record's own columns untouched here (they
    // ARE the legacy source, so rewriting them would be a different record).
    await assertNeverStrengthened(id, { ownerUserId: A.ownerUserId, teamId: A.teamId }, resolved, { rewriteRecordColumns: false });
  });

  it("legacy record of a GUEST owner (provider recorded GUEST): GUEST_SESSION from the recorded provider", async () => {
    const id = await legacyRow({
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      acquisitionModeSource: "RECORDED_AT_CREATION",
      identityLevelSnapshot: "BASIC_ACCOUNT",
      submittedByAuthProvider: "GUEST",
    });
    const { resolved } = await readBack(id);
    expect(resolved).toMatchObject({ basis: "RECORDED_ON_RECORD", actorKind: "GUEST_SESSION", accountRole: "SUBMITTER", organizationVerified: null });
  });

  it("legacy record with NOTHING recorded: UNAVAILABLE, nothing inferred, never strengthened", async () => {
    const A = h.fixtures.teamA;
    const id = await legacyRow({});
    const { identityEvents, resolved } = await readBack(id);
    expect(identityEvents).toHaveLength(0);
    expect(resolved).toEqual({
      basis: "UNAVAILABLE",
      recordedAtUtc: null,
      actorKind: "NOT_RECORDED",
      accountRole: "NOT_RECORDED",
      contributorEmailProvided: null,
      identityLevel: null,
      authProvider: null,
      emailVerified: null,
      workspaceKind: "NOT_RECORDED",
      workspaceName: null,
      organizationName: null,
      organizationVerified: null,
      submittedByEmail: null,
      submittedByUserId: null,
    });
    await assertNeverStrengthened(id, { ownerUserId: A.ownerUserId, teamId: A.teamId }, resolved, { rewriteRecordColumns: false });
  });

  it("legacy intake record with nothing recorded: UNAVAILABLE, actor read from the immutable acquisition mode", async () => {
    const id = await legacyRow({ acquisitionMode: "SECURE_INTAKE_LINK", acquisitionModeSource: "RECORDED_AT_CREATION" });
    const { resolved } = await readBack(id);
    expect(resolved).toMatchObject({
      basis: "UNAVAILABLE",
      actorKind: "INTAKE_CONTRIBUTOR",
      accountRole: "INTAKE_LINK_ISSUER",
      contributorEmailProvided: null,
      organizationVerified: null,
      emailVerified: null,
      identityLevel: null,
    });
  });
});
