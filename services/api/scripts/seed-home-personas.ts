/**
 * Phase IA-home-acceptance — Home acceptance persona seed.
 *
 *   pnpm --filter proovra-api tsx scripts/seed-home-personas.ts
 *
 * Creates (idempotently — fixed UUIDs, delete-then-recreate) the three
 * personas the Playwright Home acceptance suite drives:
 *
 *   1. pro-empty      — PRO, Personal Space, ZERO data.
 *   2. pro-populated  — PRO, Personal Space, with evidence + report +
 *                       package + verify state + intake link + delivery
 *                       message + activity (timeline) events.
 *   3. team-org       — TEAM, organization workspace, with a pending
 *                       intake submission + active intake link + delivery
 *                       message + evidence + case + report + trust data.
 *
 * Every row is a REAL Prisma insert against the live schema. Evidence
 * trust columns (tsaStatus / otsStatus / signatureBase64 /
 * publicVerifyState / verificationStatus) are written directly so the
 * `/v1/dashboard/trust-summary` aggregate returns real counts without
 * running the worker pipeline.
 *
 * SAFE BY DESIGN: refuses to run when NODE_ENV === "production".
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";

import { prisma } from "../src/db.js";
import "../src/register-shared-runtime.js";

import { HOME_PERSONAS } from "../src/dev/home-personas.js";

if (process.env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.error("REFUSING to seed personas in production.");
  process.exit(1);
}

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function hmacish(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 64);
}

// Deterministic child ids derived from the persona so re-runs are clean.
const ID = {
  // One Organization per persona workspace (the generated Prisma client
  // requires Team.organizationId; personal spaces get an implicit 1:1 org).
  orgEmpty: "0e000000-0000-4000-8000-000000000010",
  orgPopulated: "0e000000-0000-4000-8000-000000000020",
  orgTeam: "0e000000-0000-4000-8000-000000000030",
  proPopulatedEvidence: "0e000000-0000-4000-8000-0000000000b2",
  proPopulatedIntakeLink: "0e000000-0000-4000-8000-0000000000c2",
  proPopulatedMessage: "0e000000-0000-4000-8000-0000000000d2",
  teamEvidence: "0e000000-0000-4000-8000-0000000000b3",
  teamCase: "0e000000-0000-4000-8000-0000000000e3",
  teamIntakeLink: "0e000000-0000-4000-8000-0000000000c3",
  teamMessage: "0e000000-0000-4000-8000-0000000000d3",
  teamRequest: "0e000000-0000-4000-8000-0000000000f3",
};

async function wipe(): Promise<void> {
  // Order matters — children before parents. Each delete is scoped to
  // the seed's fixed ids so we never touch real data.
  const teamIds = Object.values(HOME_PERSONAS).map((p) => p.workspaceId);
  const userIds = Object.values(HOME_PERSONAS).map((p) => p.userId);

  await prisma.communicationMessage.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.evidenceRequest.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.workflowIntakeLink.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.custodyEvent.deleteMany({
    where: { evidenceId: { in: [ID.proPopulatedEvidence, ID.teamEvidence] } },
  });
  await prisma.report.deleteMany({
    where: { evidenceId: { in: [ID.proPopulatedEvidence, ID.teamEvidence] } },
  });
  await prisma.verificationPackage.deleteMany({
    where: { evidenceId: { in: [ID.proPopulatedEvidence, ID.teamEvidence] } },
  });
  await prisma.evidence.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.case.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
  // Orgs after teams — Team.organizationId FK is Restrict.
  await prisma.organization.deleteMany({
    where: { id: { in: [ID.orgEmpty, ID.orgPopulated, ID.orgTeam] } },
  });
  await prisma.entitlement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const ORG_BY_PERSONA: Record<string, string> = {
  "pro-empty": ID.orgEmpty,
  "pro-populated": ID.orgPopulated,
  "team-org": ID.orgTeam,
};

async function createUserWorkspace(personaKey: keyof typeof HOME_PERSONAS): Promise<void> {
  const p = HOME_PERSONAS[personaKey];

  await prisma.user.create({
    data: {
      id: p.userId,
      provider: "EMAIL",
      providerUserId: `home-persona-${p.key}`,
      email: p.email,
      displayName: `Persona ${p.key}`,
    },
  });

  await prisma.entitlement.create({
    data: { userId: p.userId, plan: p.plan, active: true },
  });

  const organizationId = ORG_BY_PERSONA[p.key];
  await prisma.organization.create({
    data: { id: organizationId, name: p.workspaceName },
  });

  await prisma.team.create({
    data: {
      id: p.workspaceId,
      name: p.workspaceName,
      ownerUserId: p.userId,
      organizationId,
      isPersonal: p.workspaceType === "PERSONAL",
      billingPlan: p.plan,
      billingStatus: "ACTIVE",
      evidenceWorkspaceLabel: p.workspaceName,
    },
  });

  await prisma.teamMember.create({
    data: { teamId: p.workspaceId, userId: p.userId, role: "OWNER", status: "ACTIVE" },
  });
}

async function seedProPopulated(): Promise<void> {
  const p = HOME_PERSONAS["pro-populated"];

  // Evidence with REAL trust columns set → trust-summary counts.
  await prisma.evidence.create({
    data: {
      id: ID.proPopulatedEvidence,
      type: "PHOTO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      title: "Door camera capture — 2026-06-09",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZ25hdHVyZS1wcm8tcG9wdWxhdGVk",
      publicVerifyState: "PUBLISHED",
      createdAt: hoursAgo(20),
    },
  });

  await prisma.report.create({
    data: {
      evidenceId: ID.proPopulatedEvidence,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.proPopulatedEvidence}/v1.pdf`,
      generatedAtUtc: hoursAgo(2),
    },
  });
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.proPopulatedEvidence,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.proPopulatedEvidence}/v1.zip`,
      generatedAtUtc: hoursAgo(1),
    },
  });

  // Activity (timeline) events — the command-center timeline reads
  // these custody rows + the report/package rows above.
  await prisma.custodyEvent.createMany({
    data: [
      { evidenceId: ID.proPopulatedEvidence, eventType: "EVIDENCE_COMPLETED", atUtc: hoursAgo(19), sequence: 1, eventHash: hmacish("c1") },
      { evidenceId: ID.proPopulatedEvidence, eventType: "REPORT_GENERATED", atUtc: hoursAgo(2), sequence: 2, eventHash: hmacish("c2") },
      { evidenceId: ID.proPopulatedEvidence, eventType: "VERIFICATION_PACKAGE_GENERATED", atUtc: hoursAgo(1), sequence: 3, eventHash: hmacish("c3") },
    ],
  });

  // Active intake link + a delivered SMS for the Request & Collect card.
  await prisma.workflowIntakeLink.create({
    data: {
      id: ID.proPopulatedIntakeLink,
      teamId: p.workspaceId,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateSnapshot: {},
      intakeMode: "EXTERNAL_ONE_TIME",
      tokenHash: hmacish(`token-${randomBytes(8).toString("hex")}`),
      tokenVersion: 1,
      recipientLabel: "Witness — Jane Doe",
      recipientPhone: "+14155550123",
      status: "ACTIVE",
      maxUses: 1,
      usedCount: 0,
      allowedAcceptedKinds: ["PHOTO", "DOCUMENT"],
      expiresAtUtc: new Date(NOW.getTime() + 7 * 24 * 3600_000),
      createdByUserId: p.userId,
      createdAt: hoursAgo(5),
    },
  });
  await prisma.communicationMessage.create({
    data: {
      id: ID.proPopulatedMessage,
      teamId: p.workspaceId,
      channel: "SMS",
      direction: "OUTBOUND",
      purpose: "INTAKE_LINK",
      provider: "NOOP",
      recipientHash: hmacish("+14155550123"),
      recipientPreview: "+••• 0123",
      status: "DELIVERED",
      relatedIntakeLinkId: ID.proPopulatedIntakeLink,
      createdAt: hoursAgo(5),
      sentAtUtc: hoursAgo(5),
      deliveredAtUtc: hoursAgo(4),
    },
  });
}

async function seedTeamOrg(): Promise<void> {
  const p = HOME_PERSONAS["team-org"];

  await prisma.case.create({
    data: {
      id: ID.teamCase,
      teamId: p.workspaceId,
      name: "Operation Lighthouse",
      ownerUserId: p.userId,
      status: "OPEN",
    },
  });

  await prisma.evidence.create({
    data: {
      id: ID.teamEvidence,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      caseId: ID.teamCase,
      title: "Field statement — contributor upload",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "PENDING",
      signatureBase64: "ZGV2LXNpZ25hdHVyZS10ZWFt",
      publicVerifyState: "PUBLISHED",
      createdAt: hoursAgo(30),
    },
  });
  await prisma.report.create({
    data: {
      evidenceId: ID.teamEvidence,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.teamEvidence}/v1.pdf`,
      generatedAtUtc: hoursAgo(3),
    },
  });
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.teamEvidence,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.teamEvidence}/v1.zip`,
      generatedAtUtc: hoursAgo(2),
    },
  });
  await prisma.custodyEvent.createMany({
    data: [
      { evidenceId: ID.teamEvidence, eventType: "EVIDENCE_COMPLETED", atUtc: hoursAgo(29), sequence: 1, eventHash: hmacish("t1") },
      { evidenceId: ID.teamEvidence, eventType: "REPORT_GENERATED", atUtc: hoursAgo(3), sequence: 2, eventHash: hmacish("t2") },
    ],
  });

  // Active intake link + delivered WhatsApp message.
  await prisma.workflowIntakeLink.create({
    data: {
      id: ID.teamIntakeLink,
      teamId: p.workspaceId,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateSnapshot: {},
      intakeMode: "EXTERNAL_REUSABLE",
      tokenHash: hmacish(`token-${randomBytes(8).toString("hex")}`),
      tokenVersion: 1,
      recipientLabel: "Source — confidential",
      recipientPhone: "+442079460958",
      status: "ACTIVE",
      maxUses: 100,
      usedCount: 3,
      allowedAcceptedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
      expiresAtUtc: new Date(NOW.getTime() + 14 * 24 * 3600_000),
      createdByUserId: p.userId,
      createdAt: hoursAgo(8),
    },
  });
  await prisma.communicationMessage.create({
    data: {
      id: ID.teamMessage,
      teamId: p.workspaceId,
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      purpose: "INTAKE_LINK",
      provider: "NOOP",
      recipientHash: hmacish("+442079460958"),
      recipientPreview: "+••• 0958",
      status: "DELIVERED",
      relatedIntakeLinkId: ID.teamIntakeLink,
      createdAt: hoursAgo(8),
      sentAtUtc: hoursAgo(8),
      deliveredAtUtc: hoursAgo(7),
    },
  });

  // Pending intake submission — RESPONSE_RECEIVED, no reviewer assigned
  // → appears in /v1/me/inbox intake_submission_pending_review.
  await prisma.evidenceRequest.create({
    data: {
      id: ID.teamRequest,
      teamId: p.workspaceId,
      requestType: "ADDITIONAL_EVIDENCE",
      title: "Witness photos — follow-up request",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      requestedByUserId: p.userId,
      status: "RESPONSE_RECEIVED",
      assignedReviewerUserId: null,
      createdAt: hoursAgo(6),
    },
  });
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("Seeding Home acceptance personas…");
  await wipe();
  await createUserWorkspace("pro-empty");
  await createUserWorkspace("pro-populated");
  await createUserWorkspace("team-org");
  await seedProPopulated();
  await seedTeamOrg();
  // eslint-disable-next-line no-console
  console.log("Done. Personas:");
  for (const p of Object.values(HOME_PERSONAS)) {
    // eslint-disable-next-line no-console
    console.log(`  ${p.key.padEnd(14)} user=${p.userId} workspace=${p.workspaceId} (${p.workspaceType}, ${p.plan})`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
