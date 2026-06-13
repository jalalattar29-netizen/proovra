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
 *   3. pro-issues     — PRO, Personal Space, with issue states Home
 *                       must surface plus evidence-type coverage.
 *   4. team-org       — TEAM, organization workspace, with a pending
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
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";
// Phase HOME-PROOF — index seeded evidence through the SAME indexer the
// production finalize pipeline uses, so /v1/search (which reads
// evidence_search_documents) finds persona fixtures. No bespoke rows.
import { indexEvidence } from "../src/services/search/evidence-indexing.service.js";

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
  proPopulatedDocument: "0e000000-0000-4000-8000-0000000000b4",
  proPopulatedIntakeLink: "0e000000-0000-4000-8000-0000000000c2",
  proPopulatedMessage: "0e000000-0000-4000-8000-0000000000d2",
  teamEvidence: "0e000000-0000-4000-8000-0000000000b3",
  teamCase: "0e000000-0000-4000-8000-0000000000e3",
  teamIntakeLink: "0e000000-0000-4000-8000-0000000000c3",
  teamMessage: "0e000000-0000-4000-8000-0000000000d3",
  teamRequest: "0e000000-0000-4000-8000-0000000000f3",
  teamNeedsMoreRequest: "0e000000-0000-4000-8000-0000000000f4",
  // Phase HOME-PROOF — team-org matter-readiness spread (3 matters).
  teamCaseNeedsWork: "0e000000-0000-4000-8000-0000000000e4",
  teamCaseAction: "0e000000-0000-4000-8000-0000000000e5",
  teamEvidenceNeedsWork: "0e000000-0000-4000-8000-0000000000b8",
  teamEvidenceAction: "0e000000-0000-4000-8000-0000000000b9",
  // Phase HOME-PROOF — the pro-issues persona.
  orgIssues: "0e000000-0000-4000-8000-000000000040",
  issuesPhotoTsaFailed: "0e000000-0000-4000-8000-0000000000c4",
  issuesVideoUnsigned: "0e000000-0000-4000-8000-0000000000c5",
  issuesAudioNoPackage: "0e000000-0000-4000-8000-0000000000c6",
  issuesDocUnpublished: "0e000000-0000-4000-8000-0000000000c7",
  issuesPhotoPublished: "0e000000-0000-4000-8000-0000000000c8",
  issuesIntakeLink: "0e000000-0000-4000-8000-0000000000c9",
  issuesMessageFailed: "0e000000-0000-4000-8000-0000000000ca",
  issuesArchiveSuspended: "0e000000-0000-4000-8000-0000000000cb",
  issuesFolderMultipart: "0e000000-0000-4000-8000-0000000000cc",
  issuesOtherBinary: "0e000000-0000-4000-8000-0000000000cd",
};

const ISSUES_EVIDENCE_IDS = [
  ID.issuesPhotoTsaFailed,
  ID.issuesVideoUnsigned,
  ID.issuesAudioNoPackage,
  ID.issuesDocUnpublished,
  ID.issuesPhotoPublished,
  ID.issuesArchiveSuspended,
  ID.issuesFolderMultipart,
  ID.issuesOtherBinary,
];

async function wipe(): Promise<void> {
  // Order matters — children before parents. Each delete is scoped to
  // the seed's fixed ids so we never touch real data.
  const teamIds = Object.values(HOME_PERSONAS).map((p) => p.workspaceId);
  const userIds = Object.values(HOME_PERSONAS).map((p) => p.userId);

  const seedEvidenceIds = [
    ID.proPopulatedEvidence,
    ID.proPopulatedDocument,
    ID.teamEvidence,
    ID.teamEvidenceNeedsWork,
    ID.teamEvidenceAction,
    ...ISSUES_EVIDENCE_IDS,
  ];
  await prisma.communicationMessage.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.evidenceRequest.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.workflowIntakeLink.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.evidenceReviewWorkflow.deleteMany({
    where: { evidenceId: { in: seedEvidenceIds } },
  });
  await prisma.evidenceSearchDocument
    .deleteMany({ where: { evidenceId: { in: seedEvidenceIds } } })
    .catch(() => null);
  await prisma.custodyEvent.deleteMany({
    where: { evidenceId: { in: seedEvidenceIds } },
  });
  await prisma.report.deleteMany({
    where: { evidenceId: { in: seedEvidenceIds } },
  });
  await prisma.verificationPackage.deleteMany({
    where: { evidenceId: { in: seedEvidenceIds } },
  });
  await prisma.evidenceLifecycleEvent.deleteMany({
    where: { teamId: { in: teamIds } },
  });
  await prisma.operationalIncident.deleteMany({
    where: { teamId: { in: teamIds } },
  });
  await prisma.evidence.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.case.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
  // Orgs after teams — Team.organizationId FK is Restrict.
  await prisma.organization.deleteMany({
    where: { id: { in: [ID.orgEmpty, ID.orgPopulated, ID.orgTeam, ID.orgIssues] } },
  });
  await prisma.entitlement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const ORG_BY_PERSONA: Record<string, string> = {
  "pro-empty": ID.orgEmpty,
  "pro-populated": ID.orgPopulated,
  "pro-issues": ID.orgIssues,
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
      // The platform-context envelope resolves the ACTIVE space from
      // currentWorkspaceId. Without it the team-org persona falls back
      // to an auto-bootstrapped personal space and the Home acceptance
      // run inspects the wrong (empty) workspace.
      currentWorkspaceId: p.workspaceId,
    },
  });

  await prisma.entitlement.create({
    data: { userId: p.userId, plan: p.plan, active: true },
  });

  // Personas must pass the requireLegalAcceptance gate — otherwise
  // /v1/me/inbox and /v1/billing/overview return 428 and the Home
  // Storage / inbox-driven widgets render their degraded states.
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(
      ([policyKey, policyVersion]) => ({
        userId: p.userId,
        policyKey,
        policyVersion,
        source: "home-persona-seed",
      }),
    ),
    skipDuplicates: true,
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
  const org = ORG_BY_PERSONA[p.key];

  // Evidence with REAL trust columns set → trust-summary counts.
  await prisma.evidence.create({
    data: {
      id: ID.proPopulatedEvidence,
      type: "PHOTO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      // Phase A1 CHECK (evidence_team_implies_org_chk): team_id NOT
      // NULL requires organization_id NOT NULL.
      organizationId: org,
      title: "Door camera capture — 2026-06-09",
      mimeType: "image/jpeg",
      originalFileName: "door-camera-2026-06-09.jpg",
      displayFileName: "door-camera-2026-06-09.jpg",
      captureMethod: "SECURE_CAMERA",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZ25hdHVyZS1wcm8tcG9wdWxhdGVk",
      publicVerifyState: "PUBLISHED",
      // Phase HOME-INTELLIGENCE — the timeline projects the publish
      // event from this real timestamp (production publish flow sets it).
      publicVerifyPublishedAtUtc: hoursAgo(2),
      createdAt: hoursAgo(20),
    },
  });
  await prisma.evidence.create({
    data: {
      id: ID.proPopulatedDocument,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Incident statement packet",
      mimeType: "application/pdf",
      originalFileName: "incident-statement-packet.pdf",
      displayFileName: "incident-statement-packet.pdf",
      captureMethod: "IMPORTED_DOCUMENT",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZ25hdHVyZS1wcm8tZG9jdW1lbnQ=",
      publicVerifyState: "PUBLISHED",
      publicVerifyPublishedAtUtc: hoursAgo(11),
      createdAt: hoursAgo(28),
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
  await prisma.report.create({
    data: {
      evidenceId: ID.proPopulatedDocument,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.proPopulatedDocument}/v1.pdf`,
      generatedAtUtc: hoursAgo(12),
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
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.proPopulatedDocument,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.proPopulatedDocument}/v1.zip`,
      generatedAtUtc: hoursAgo(10),
    },
  });

  // Activity (timeline) events — the command-center timeline reads
  // these custody rows + the report/package rows above.
  await prisma.custodyEvent.createMany({
    data: [
      { evidenceId: ID.proPopulatedEvidence, eventType: "EVIDENCE_COMPLETED", atUtc: hoursAgo(19), sequence: 1, eventHash: hmacish("c1") },
      { evidenceId: ID.proPopulatedEvidence, eventType: "REPORT_GENERATED", atUtc: hoursAgo(2), sequence: 2, eventHash: hmacish("c2") },
      { evidenceId: ID.proPopulatedEvidence, eventType: "VERIFICATION_PACKAGE_GENERATED", atUtc: hoursAgo(1), sequence: 3, eventHash: hmacish("c3") },
      { evidenceId: ID.proPopulatedDocument, eventType: "EVIDENCE_COMPLETED", atUtc: hoursAgo(27), sequence: 1, eventHash: hmacish("c4") },
      { evidenceId: ID.proPopulatedDocument, eventType: "REPORT_GENERATED", atUtc: hoursAgo(12), sequence: 2, eventHash: hmacish("c5") },
      { evidenceId: ID.proPopulatedDocument, eventType: "VERIFICATION_PACKAGE_GENERATED", atUtc: hoursAgo(10), sequence: 3, eventHash: hmacish("c6") },
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
      // Prisma 7 driver adapters send NULL for omitted scalar lists —
      // the column is NOT NULL with no default, so set it explicitly.
      ipAllowlistCidrs: [],
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
  const org = ORG_BY_PERSONA[p.key];

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
      // Phase A1 CHECK — see seedProPopulated.
      organizationId: org,
      caseId: ID.teamCase,
      title: "Field statement — contributor upload",
      mimeType: "application/pdf",
      originalFileName: "field-statement.pdf",
      displayFileName: "field-statement.pdf",
      captureMethod: "EXTERNAL_INTAKE_UPLOAD",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "PENDING",
      signatureBase64: "ZGV2LXNpZ25hdHVyZS10ZWFt",
      publicVerifyState: "PUBLISHED",
      publicVerifyPublishedAtUtc: hoursAgo(3),
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
  await prisma.evidenceLifecycleEvent.createMany({
    data: [
      {
        teamId: p.workspaceId,
        evidenceId: ID.teamEvidence,
        fromState: "SIGNED",
        toState: "REPORTED",
        eventType: "lifecycle_transition",
        summary: "Evidence lifecycle updated — report-ready package prepared",
        actorUserId: p.userId,
        createdAt: hoursAgo(4),
      },
      {
        teamId: p.workspaceId,
        evidenceId: ID.teamEvidence,
        fromState: "REPORTED",
        toState: "DESTRUCTION_REVIEW",
        eventType: "destruction_review_created",
        summary: "Retention review recorded — export package queued for policy check",
        actorUserId: p.userId,
        createdAt: hoursAgo(2),
      },
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
      ipAllowlistCidrs: [],
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
  await prisma.evidenceRequest.create({
    data: {
      id: ID.teamNeedsMoreRequest,
      teamId: p.workspaceId,
      requestType: "ADDITIONAL_EVIDENCE",
      title: "Witness photos — need clearer plate image",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      requestedByUserId: p.userId,
      status: "NEEDS_MORE_INFO",
      assignedReviewerUserId: null,
      createdAt: hoursAgo(3),
    },
  });
}

/**
 * Phase HOME-PROOF — the "pro-issues" scenario: every operational
 * problem state Home must visibly surface, plus evidence-type
 * coverage for Images / Documents / Videos / Audio / Archives /
 * Folders / Other Files.
 */
async function seedProIssues(): Promise<void> {
  const p = HOME_PERSONAS["pro-issues"];
  const org = ORG_BY_PERSONA[p.key];

  // 1. PHOTO — TSA FAILED (critical decision + trust row failure).
  await prisma.evidence.create({
    data: {
      id: ID.issuesPhotoTsaFailed,
      type: "PHOTO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Warehouse door photo",
      mimeType: "image/jpeg",
      originalFileName: "warehouse-door.jpg",
      displayFileName: "warehouse-door.jpg",
      captureMethod: "SECURE_CAMERA",
      status: "SIGNED",
      // Phase HOME-CTA-NORMALIZATION proof — a TSA failure realistically
      // bubbles up to "needs human review" (verificationStatus = REVIEW_REQUIRED
      // or FAILED). With this set, trustSummary.needingAttention > 0, so the
      // Operational Queue "Records need an integrity review" item + the
      // Workspace Priorities "resolve_integrity" row both render and the
      // shared HOME_INTEGRITY_REVIEW_HREF can be live-proven.
      verificationStatus: "REVIEW_REQUIRED",
      tsaStatus: "FAILED",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtMQ==",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(26),
    },
  });

  // 2. VIDEO — unsigned + OTS pending (needs-attention signals).
  await prisma.evidence.create({
    data: {
      id: ID.issuesVideoUnsigned,
      type: "VIDEO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "CCTV clip — loading bay",
      mimeType: "video/mp4",
      originalFileName: "loading-bay-cctv.mp4",
      displayFileName: "loading-bay-cctv.mp4",
      captureMethod: "UPLOADED_FILE",
      status: "UPLOADED",
      tsaStatus: "OK",
      otsStatus: "PENDING",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(20),
    },
  });

  // 3. AUDIO — reported with a report but NO package (package gap).
  await prisma.evidence.create({
    data: {
      id: ID.issuesAudioNoPackage,
      type: "AUDIO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Witness call recording",
      mimeType: "audio/mpeg",
      originalFileName: "witness-call.mp3",
      displayFileName: "witness-call.mp3",
      captureMethod: "UPLOADED_FILE",
      status: "REPORTED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtMw==",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(15),
    },
  });
  await prisma.report.create({
    data: {
      evidenceId: ID.issuesAudioNoPackage,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.issuesAudioNoPackage}/v1.pdf`,
      generatedAtUtc: hoursAgo(14),
    },
  });

  // 4. DOCUMENT — report + package ready but verification UNPUBLISHED.
  await prisma.evidence.create({
    data: {
      id: ID.issuesDocUnpublished,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Lease agreement scan",
      mimeType: "application/pdf",
      originalFileName: "lease-agreement.pdf",
      displayFileName: "lease-agreement.pdf",
      captureMethod: "IMPORTED_DOCUMENT",
      status: "REPORTED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtNA==",
      publicVerifyState: "UNPUBLISHED",
      createdAt: hoursAgo(10),
    },
  });
  await prisma.report.create({
    data: {
      evidenceId: ID.issuesDocUnpublished,
      version: 2,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.issuesDocUnpublished}/v2.pdf`,
      generatedAtUtc: hoursAgo(9),
    },
  });
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.issuesDocUnpublished,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.issuesDocUnpublished}/v1.zip`,
      generatedAtUtc: hoursAgo(8),
    },
  });

  // 5. PHOTO — fully healthy + recently PUBLISHED (publication event).
  await prisma.evidence.create({
    data: {
      id: ID.issuesPhotoPublished,
      type: "PHOTO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Site entrance photo",
      mimeType: "image/jpeg",
      originalFileName: "site-entrance.jpg",
      displayFileName: "site-entrance.jpg",
      captureMethod: "SECURE_CAMERA",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtNQ==",
      publicVerifyState: "PUBLISHED",
      publicVerifyPublishedAtUtc: hoursAgo(4),
      createdAt: hoursAgo(40),
    },
  });
  await prisma.report.create({
    data: {
      evidenceId: ID.issuesPhotoPublished,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.issuesPhotoPublished}/v1.pdf`,
      generatedAtUtc: hoursAgo(6),
    },
  });
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.issuesPhotoPublished,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.issuesPhotoPublished}/v1.zip`,
      generatedAtUtc: hoursAgo(5),
    },
  });
  // 6. ARCHIVE — package exists but verification is SUSPENDED.
  await prisma.evidence.create({
    data: {
      id: ID.issuesArchiveSuspended,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Camera export archive",
      mimeType: "application/zip",
      originalFileName: "camera-export.zip",
      displayFileName: "camera-export.zip",
      captureMethod: "UPLOADED_FILE",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtNg==",
      publicVerifyState: "SUSPENDED",
      createdAt: hoursAgo(13),
    },
  });
  await prisma.report.create({
    data: {
      evidenceId: ID.issuesArchiveSuspended,
      version: 1,
      storageBucket: "dev-reports",
      storageKey: `reports/${ID.issuesArchiveSuspended}/v1.pdf`,
      generatedAtUtc: hoursAgo(12),
    },
  });
  await prisma.verificationPackage.create({
    data: {
      evidenceId: ID.issuesArchiveSuspended,
      version: 1,
      storageBucket: "dev-packages",
      storageKey: `packages/${ID.issuesArchiveSuspended}/v1.zip`,
      generatedAtUtc: hoursAgo(11),
    },
  });

  // 7. FOLDER — multipart upload so Home classifies it as "Folders".
  await prisma.evidence.create({
    data: {
      id: ID.issuesFolderMultipart,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Parking-lot folder upload",
      mimeType: "application/octet-stream",
      originalFileName: "parking-lot-folder",
      displayFileName: "parking-lot-folder",
      captureMethod: "MULTIPART_PACKAGE",
      status: "SIGNED",
      tsaStatus: "OK",
      otsStatus: "PENDING",
      signatureBase64: "ZGV2LXNpZy1pc3N1ZXMtNw==",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(17),
    },
  });

  // 8. OTHER FILE — non-document binary, still a real evidence row.
  await prisma.evidence.create({
    data: {
      id: ID.issuesOtherBinary,
      type: "DOCUMENT",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      title: "Sensor export binary",
      mimeType: "application/octet-stream",
      originalFileName: "sensor-export.bin",
      displayFileName: "sensor-export.bin",
      captureMethod: "UPLOADED_FILE",
      status: "UPLOADED",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(9),
    },
  });

  // 9. Active intake link with a FAILED delivery (retryable queue item).
  await prisma.workflowIntakeLink.create({
    data: {
      id: ID.issuesIntakeLink,
      teamId: p.workspaceId,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateSnapshot: {},
      intakeMode: "EXTERNAL_ONE_TIME",
      tokenHash: hmacish(`token-${randomBytes(8).toString("hex")}`),
      tokenVersion: 1,
      recipientLabel: "Source — WhatsApp request",
      recipientPhone: "+14155550999",
      status: "ACTIVE",
      maxUses: 1,
      usedCount: 0,
      allowedAcceptedKinds: ["PHOTO", "DOCUMENT"],
      ipAllowlistCidrs: [],
      expiresAtUtc: new Date(NOW.getTime() + 7 * 24 * 3600_000),
      createdByUserId: p.userId,
      createdAt: hoursAgo(7),
    },
  });
  await prisma.communicationMessage.create({
    data: {
      id: ID.issuesMessageFailed,
      teamId: p.workspaceId,
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      purpose: "INTAKE_LINK",
      provider: "NOOP",
      recipientHash: hmacish("+14155550999"),
      recipientPreview: "+••• 0999",
      status: "FAILED",
      relatedIntakeLinkId: ID.issuesIntakeLink,
      createdAt: hoursAgo(7),
      sentAtUtc: hoursAgo(7),
      failedAtUtc: hoursAgo(6),
    },
  });

  // 10. Real report/package incidents so pipeline failures are not inferred.
  await prisma.operationalIncident.createMany({
    data: [
      {
        teamId: p.workspaceId,
        category: "REPORT",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: "home-proof:report-failure:pro-issues",
        title: "Report generation failed",
        safeSummary: "A report output failed and needs operator review.",
        relatedEvidenceId: ID.issuesAudioNoPackage,
        runbookSlug: "report-pipeline",
        firstSeenAtUtc: hoursAgo(5),
        lastSeenAtUtc: hoursAgo(5),
      },
      {
        teamId: p.workspaceId,
        category: "PACKAGE",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: "home-proof:package-failure:pro-issues",
        title: "Verification package failed",
        safeSummary: "A verification package build failed and needs operator review.",
        relatedEvidenceId: ID.issuesDocUnpublished,
        runbookSlug: "verification-package",
        firstSeenAtUtc: hoursAgo(4),
        lastSeenAtUtc: hoursAgo(4),
      },
    ],
  });
}

/**
 * Phase HOME-PROOF — team-org matter-readiness spread: alongside the
 * complete "Operation Lighthouse" (Healthy), a matter with evidence
 * but no report (Needs work) and a matter with an OVERDUE review
 * workflow (Action required).
 */
async function seedTeamMatterSpread(): Promise<void> {
  const p = HOME_PERSONAS["team-org"];
  const org = ORG_BY_PERSONA[p.key];

  await prisma.case.create({
    data: {
      id: ID.teamCaseNeedsWork,
      teamId: p.workspaceId,
      name: "Acme v. Borealis",
      ownerUserId: p.userId,
      status: "OPEN",
    },
  });
  await prisma.evidence.create({
    data: {
      id: ID.teamEvidenceNeedsWork,
      type: "VIDEO",
      mimeType: "video/mp4",
      originalFileName: "supplier-yard-overview.mp4",
      displayFileName: "supplier-yard-overview.mp4",
      captureMethod: "UPLOADED_FILE",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      caseId: ID.teamCaseNeedsWork,
      title: "Supplier yard overview clip",
      status: "SIGNED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      signatureBase64: "ZGV2LXNpZy10ZWFtLTI=",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(18),
    },
  });

  await prisma.case.create({
    data: {
      id: ID.teamCaseAction,
      teamId: p.workspaceId,
      name: "Harbor Incident",
      ownerUserId: p.userId,
      status: "OPEN",
    },
  });
  await prisma.evidence.create({
    data: {
      id: ID.teamEvidenceAction,
      type: "PHOTO",
      ownerUserId: p.userId,
      teamId: p.workspaceId,
      organizationId: org,
      caseId: ID.teamCaseAction,
      title: "Dock damage photo",
      mimeType: "image/jpeg",
      originalFileName: "dock-damage.jpg",
      displayFileName: "dock-damage.jpg",
      captureMethod: "EXTERNAL_INTAKE_UPLOAD",
      status: "UPLOADED",
      tsaStatus: "OK",
      otsStatus: "ANCHORED",
      publicVerifyState: "NOT_PUBLISHED",
      createdAt: hoursAgo(50),
    },
  });
  // Overdue review workflow → overdueReviewCount > 0 → Action required.
  await prisma.evidenceReviewWorkflow.create({
    data: {
      evidenceId: ID.teamEvidenceAction,
      workspaceType: "TEAM",
      teamId: p.workspaceId,
      status: "QUEUED",
      dueAt: hoursAgo(48),
    },
  });
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("Seeding Home acceptance personas…");
  await wipe();
  await createUserWorkspace("pro-empty");
  await createUserWorkspace("pro-populated");
  await createUserWorkspace("pro-issues");
  await createUserWorkspace("team-org");
  await seedProPopulated();
  await seedProIssues();
  await seedTeamOrg();
  await seedTeamMatterSpread();
  // Phase HOME-PROOF — build evidence_search_documents rows via the
  // canonical indexer (the production finalize pipeline's writer), so
  // the canonical /v1/search finds the fixtures.
  const proPopulated = HOME_PERSONAS["pro-populated"];
  const teamOrg = HOME_PERSONAS["team-org"];
  const indexed = await Promise.all([
    indexEvidence({ teamId: proPopulated.workspaceId, evidenceId: ID.proPopulatedEvidence }),
    indexEvidence({ teamId: proPopulated.workspaceId, evidenceId: ID.proPopulatedDocument }),
    indexEvidence({ teamId: teamOrg.workspaceId, evidenceId: ID.teamEvidence }),
    indexEvidence({ teamId: teamOrg.workspaceId, evidenceId: ID.teamEvidenceNeedsWork }),
    indexEvidence({ teamId: teamOrg.workspaceId, evidenceId: ID.teamEvidenceAction }),
    ...ISSUES_EVIDENCE_IDS.map((evidenceId) =>
      indexEvidence({ teamId: HOME_PERSONAS["pro-issues"].workspaceId, evidenceId }),
    ),
  ]);
  // eslint-disable-next-line no-console
  console.log("search index:", indexed.map((r) => (r.ok ? "ok" : r.reason)).join(", "));
  // eslint-disable-next-line no-console
  console.log("Done. Personas:");
  for (const p of Object.values(HOME_PERSONAS)) {
    // eslint-disable-next-line no-console
    console.log(`  ${p.key.padEnd(14)} user=${p.userId} workspace=${p.workspaceId} (${p.workspaceType}, ${p.plan})`);
  }

  // Phase CAPTURE-DETAIL-WIRING — backfill signing-key metadata on
  // every seeded evidence row that carries a signature but no
  // signing_key_id. The /v1/evidence/:id/review-workspace handler
  // explicitly 409s when a SIGNED row's signing_keys row is missing;
  // without this backfill the entire detail page returns an error
  // for every seed evidence id. The 'audit_local_ed25519' row is
  // created by the shared signing-key bootstrap script that runs
  // ahead of this seed; we only need to point each evidence row at
  // it. Idempotent — runs over every signed row each time.
  const backfilled = await prisma.evidence.updateMany({
    where: {
      signatureBase64: { not: null },
      OR: [{ signingKeyId: null }, { signingKeyVersion: null }],
    },
    data: {
      signingKeyId: "audit_local_ed25519",
      signingKeyVersion: 1,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`signing-key backfill: ${backfilled.count} signed rows pointed at audit_local_ed25519`);

  // Phase CAPTURE-DETAIL-WIRING — seed one rich capture-notes part on
  // the pro-issues TSA-failed photo so the Evidence Detail UI has a
  // record that visibly exercises:
  //   - Evidence.internalNotes
  //   - Evidence.intakePlanJson (template summary + required steps)
  //   - EvidencePart.privateNote / privateRole / sourceLabel / checklistStepId / clientSignals
  // The proof is the data path Capture → finalize → review-workspace
  // → UI; without an exemplar the detail page never showed these.
  const richEvidenceId = ID.issuesPhotoTsaFailed;
  await prisma.evidence.update({
    where: { id: richEvidenceId },
    data: {
      internalNotes:
        "Captured during after-hours inspection. Storage was unsecured. Witness present.",
      intakePlanJson: {
        templateId: "general-evidence-record",
        templateName: "General Evidence Record",
        mode: "CHECKLIST_REQUIRED",
        locationRequirement: "recommended",
        requiredSteps: [
          { id: "primary_evidence", title: "Primary evidence file" },
          { id: "context_photo", title: "Context photo" },
        ],
        optionalSteps: [{ id: "witness_statement", title: "Witness statement" }],
      },
    },
  });
  // The seeded photo row has no EvidencePart yet — create one with
  // the full per-item capture metadata. Idempotent via unique key
  // (evidenceId, partIndex).
  await prisma.evidencePart.upsert({
    where: {
      evidenceId_partIndex: { evidenceId: richEvidenceId, partIndex: 0 },
    },
    create: {
      evidenceId: richEvidenceId,
      partIndex: 0,
      originalFileName: "door-hinge.jpg",
      mimeType: "image/jpeg",
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000001",
      sizeBytes: BigInt(1024),
      storageBucket: "dev-bucket",
      storageKey: `evidence/${richEvidenceId}/parts/000-door-hinge.jpg`,
      privateNote: "Primary photo of door — hinge visibly broken",
      privateRole: "Primary evidence",
      checklistStepId: "primary_evidence",
      sourceLabel: "Phone camera, on-site",
      clientSignals: {
        captureTimeUtc: "2026-06-12T19:42:00Z",
        browserMediaCaptureAvailable: true,
        folderPathPresent: false,
        locationIncluded: true,
        screenshotLike: false,
        genericMime: false,
        oldLastModified: false,
      },
      uploadedAtUtc: hoursAgo(26),
    },
    update: {
      privateNote: "Primary photo of door — hinge visibly broken",
      privateRole: "Primary evidence",
      checklistStepId: "primary_evidence",
      sourceLabel: "Phone camera, on-site",
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
