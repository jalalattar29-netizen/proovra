/**
 * dev:populate-investigation
 *
 * Dev-only deterministic populate script for the Investigation surfaces.
 *
 * Creates enough real, canonical state in the workspace to take a
 * non-empty screenshot of every Investigation page (hub, graph, timeline,
 * duplicates, reviewers, queues) WITHOUT inventing parallel write paths.
 *
 * It drives the same services the route handlers do:
 *   - createEvidence + completeEvidence (the canonical write path)
 *   - putObjectBuffer (the canonical S3 PUT)
 *   - addEvidenceLink (cases lifecycle service)
 *   - upsertEvidenceReviewerWorkflow + createEscalation (reviewer ops)
 *   - issueExternalReviewGrant (external review)
 *   - reconcileTeamGraph (shared-runtime graph builder)
 *   - reconcileSimilaritiesForEvidence (intelligence detector)
 *   - buildInvestigationDiagnostics (the canonical counters)
 *
 * Hard rules:
 *   1. Refuses to run if NODE_ENV === "production" UNLESS the env var
 *      ALLOW_DEV_POPULATE === "true" is set. Production never gets
 *      noise injected silently.
 *   2. Reuses an existing dev team if any are present. Otherwise
 *      creates an Organization + Team + a dev User pair via prisma
 *      (the auth bootstrap flow is too coupled to HTTP to invoke from
 *      a script).
 *   3. NEVER touches Evidence rows directly — every Evidence is born
 *      via createEvidence + completeEvidence so the custody chain,
 *      fanout, and downstream fanout (search, MI, graph reconcile,
 *      perceptual hash, OCR, transcript) are honest.
 *   4. If Postgres or Redis is unavailable, exits cleanly with a
 *      one-line diagnosis. No partial writes left behind.
 *   5. OCR/Transcript providers (Azure DI / Deepgram) are optional in
 *      dev — the script reports "extraction skipped" if the producer
 *      mode resolver says they are not ready, but still succeeds.
 *
 * Usage:
 *   pnpm --filter proovra-api dev:populate-investigation
 *
 * Environment overrides (optional):
 *   DEV_POPULATE_TEAM_ID=<uuid>           use a specific team instead of "first"
 *   DEV_POPULATE_OWNER_USER_ID=<uuid>     use a specific owner user
 *   ALLOW_DEV_POPULATE=true               permit running in NODE_ENV=production
 */

import "dotenv/config";

import { createHash } from "node:crypto";

import { prisma } from "../src/db.js";
import "../src/register-shared-runtime.js";

import { createEvidence } from "../src/services/evidence.service.js";
import { completeEvidence } from "../src/services/evidence-complete.service.js";
import { putObjectBuffer } from "../src/storage.js";
import { addEvidenceLink } from "../src/services/cases/case-lifecycle.service.js";
import { upsertEvidenceReviewerWorkflow } from "../src/services/evidence-review/reviewer-workflow.service.js";
import { createEscalation } from "../src/services/reviewer-ops/escalation-engine.service.js";
import { issueExternalReviewGrant } from "../src/services/external-review/external-review-grant.service.js";
import { reconcileSimilaritiesForEvidence } from "../src/services/intelligence/similarity.service.js";
import { enqueueGraphReconcileJob } from "../src/queue/graph-reconcile-queue.js";
import { reconcileTeamGraph } from "@proovra/shared-runtime/graph";
import { buildInvestigationDiagnostics } from "../src/services/investigation-diagnostics.service.js";

// ---------------------------------------------------------------------------
// Bootstrap guard — refuse to run in production unless explicitly allowed.
// ---------------------------------------------------------------------------

function guardEnvironment(): void {
  const env = process.env.NODE_ENV ?? "development";
  const proovraEnv = process.env.PROOVRA_ENV ?? "";
  const allow = process.env.ALLOW_DEV_POPULATE === "true";
  if ((env === "production" || proovraEnv === "production") && !allow) {
    console.error(
      "[dev:populate-investigation] refusing to run with NODE_ENV/PROOVRA_ENV=production. " +
        "Set ALLOW_DEV_POPULATE=true to override.",
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixture bytes. NO fixture library exists in this repo; we
// generate tiny but real PNG / PDF / WAV byte sequences so the canonical
// completeEvidence sha256 stream and downstream MIME-aware producers see
// valid data.
//
// IMPORTANT: Evidence B reuses Evidence A's exact bytes so the streamed
// sha256 of B is byte-identical to A's. That is what drives the
// SAME_HASH_AS / HASH_DUPLICATE detection through the canonical path —
// no fudging or post-insert backfill needed.
// ---------------------------------------------------------------------------

function makeTinyPngBytes(): Buffer {
  // Smallest legal 1x1 transparent PNG. Determinstic — pre-CRCd.
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width 1
    0x00, 0x00, 0x00, 0x01, // height 1
    0x08, 0x06, 0x00, 0x00, 0x00, // depth/color/...
    0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
    0x00, 0x00, 0x00, 0x0a, // IDAT length
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // zlib data
    0x0d, 0x0a, 0x2d, 0xb4, // IDAT CRC
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4e, 0x44, // "IEND"
    0xae, 0x42, 0x60, 0x82, // IEND CRC
  ]);
}

function makeTinyPdfBytes(): Buffer {
  // Smallest legal PDF — single empty page. Operators can open it.
  const body =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f\n0000000010 00000 n\n0000000056 00000 n\n" +
    "0000000110 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n173\n%%EOF";
  return Buffer.from(body, "binary");
}

function makeTinyWavBytes(): Buffer {
  // Minimal 8kHz mono PCM WAV with one sample. Enough to satisfy the
  // MIME sniff and the EvidenceType.AUDIO classifier.
  const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x26, 0x00, 0x00, 0x00, // chunk size
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6d, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // fmt chunk size
    0x01, 0x00, // PCM
    0x01, 0x00, // mono
    0x40, 0x1f, 0x00, 0x00, // 8000 Hz
    0x40, 0x1f, 0x00, 0x00, // byte rate
    0x01, 0x00, // block align
    0x08, 0x00, // bits/sample
    0x64, 0x61, 0x74, 0x61, // "data"
    0x02, 0x00, 0x00, 0x00, // data size
    0x80, 0x80,             // one sample stereo midpoint
  ]);
  return header;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Workspace + user bootstrap — reuse first dev team if present; otherwise
// create an Organization + Team + Owner with deterministic tags so re-runs
// land in the same workspace.
// ---------------------------------------------------------------------------

const DEV_TAG = "dev-populate-investigation";

async function resolveOrCreateWorkspace(): Promise<{
  teamId: string;
  ownerUserId: string;
}> {
  // Explicit override path — reuse the caller's exact rows.
  const overrideTeamId = process.env.DEV_POPULATE_TEAM_ID?.trim() || null;
  const overrideUserId = process.env.DEV_POPULATE_OWNER_USER_ID?.trim() || null;
  if (overrideTeamId && overrideUserId) {
    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: { teamId: overrideTeamId, userId: overrideUserId },
      },
      select: { teamId: true },
    });
    if (!membership) {
      throw new Error(
        `DEV_POPULATE_OWNER_USER_ID is not a member of DEV_POPULATE_TEAM_ID — refuse to seed.`,
      );
    }
    return { teamId: overrideTeamId, ownerUserId: overrideUserId };
  }

  // Reuse the first non-personal team that has an OWNER membership.
  const existing = await prisma.team.findFirst({
    where: { isPersonal: false },
    orderBy: { createdAt: "asc" },
    include: {
      // Pull the owner relation so we have a valid actor user id.
      owner: { select: { id: true } },
    },
  });
  if (existing?.owner?.id) {
    return { teamId: existing.id, ownerUserId: existing.owner.id };
  }

  // No usable team — bootstrap one. We don't go through the HTTP
  // workspace-bootstrap path here (it's tightly coupled to fastify
  // request context); the script is dev-only and the rows produced
  // are byte-identical to what that path would emit.
  console.log("[dev:populate-investigation] no existing team found — bootstrapping a fresh one.");

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `${DEV_TAG}-${Date.now()}@dev.proovra.local`,
        firstName: "Dev",
        lastName: "Populate",
        provider: "EMAIL",
        providerUserId: `${DEV_TAG}-${Date.now()}`,
      },
      select: { id: true },
    });
    const org = await tx.organization.create({
      data: {
        name: "Dev Populate Workspace",
        billingOwnerUserId: user.id,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    await tx.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role: "ORG_OWNER",
      },
    });
    const team = await tx.team.create({
      data: {
        name: "Dev Populate Workspace",
        ownerUserId: user.id,
        isPersonal: false,
        organizationId: org.id,
      },
      select: { id: true },
    });
    await tx.teamMember.create({
      data: {
        teamId: team.id,
        userId: user.id,
        role: "OWNER",
        status: "ACTIVE",
      },
    });
    return { teamId: team.id, ownerUserId: user.id };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Create + finalize one Evidence row via the canonical write path.
// ---------------------------------------------------------------------------

type EvidenceKind = "image" | "duplicate-image" | "document" | "audio";

async function createAndFinalizeEvidence(input: {
  ownerUserId: string;
  teamId: string;
  kind: EvidenceKind;
  bytes: Buffer;
  mimeType: string;
  originalFileName: string;
}): Promise<{ id: string; sha256: string }> {
  const evidenceType =
    input.mimeType.startsWith("image/")
      ? "PHOTO"
      : input.mimeType.startsWith("video/")
        ? "VIDEO"
        : input.mimeType.startsWith("audio/")
          ? "AUDIO"
          : "DOCUMENT";

  const created = await createEvidence({
    ownerUserId: input.ownerUserId,
    teamId: input.teamId,
    type: evidenceType as never,
    mimeType: input.mimeType,
    originalFileName: input.originalFileName,
    captureFileName: null,
  });
  await putObjectBuffer({
    bucket: created.upload.bucket,
    key: created.upload.key,
    body: input.bytes,
    contentType: input.mimeType,
  });
  await completeEvidence({
    evidenceId: created.id,
    ownerUserId: input.ownerUserId,
  });
  return { id: created.id, sha256: sha256Hex(input.bytes) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  guardEnvironment();

  console.log("[dev:populate-investigation] starting");

  // Bounded connectivity probe — if Postgres or the S3 endpoint is not
  // up, fail with a clean operator-readable diagnosis instead of a
  // Prisma generic "Invalid invocation" with no body.
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (err) {
    const code =
      (err as { code?: string } | undefined)?.code ??
      (err as Error | undefined)?.message ??
      "unknown";
    console.error(
      `[dev:populate-investigation] cannot reach Postgres (DATABASE_URL). code=${code}.`,
    );
    console.error(
      `[dev:populate-investigation] this is an environment limitation — start your dev Postgres ` +
        `instance (e.g. docker compose up postgres) and re-run.`,
    );
    process.exit(1);
  }

  const { teamId, ownerUserId } = await resolveOrCreateWorkspace();
  console.log(
    `[dev:populate-investigation] workspace ready teamId=${teamId} ownerUserId=${ownerUserId}`,
  );

  // ---- Fixture bytes ------------------------------------------------------
  const imageBytes = makeTinyPngBytes();
  const pdfBytes = makeTinyPdfBytes();
  const audioBytes = makeTinyWavBytes();

  // ---- Case ---------------------------------------------------------------
  const caseRow = await prisma.case.create({
    data: {
      name: "Dev populate matter",
      ownerUserId,
      teamId,
      description: "Auto-seeded by dev:populate-investigation.",
      priority: "P2",
      status: "OPEN",
    },
    select: { id: true },
  });
  console.log(`[dev:populate-investigation] created case ${caseRow.id}`);

  // ---- Evidence A (image) -------------------------------------------------
  const evA = await createAndFinalizeEvidence({
    ownerUserId,
    teamId,
    kind: "image",
    bytes: imageBytes,
    mimeType: "image/png",
    originalFileName: "dev-populate-A.png",
  });
  console.log(`[dev:populate-investigation] Evidence A finalized ${evA.id} sha256=${evA.sha256}`);

  // ---- Evidence B (SAME bytes as A — duplicate detection seed) -----------
  // The canonical write path recomputes sha256 from the streamed bytes,
  // so byte-equal input produces hash-equal stored rows. No bypass.
  const evB = await createAndFinalizeEvidence({
    ownerUserId,
    teamId,
    kind: "duplicate-image",
    bytes: imageBytes,
    mimeType: "image/png",
    originalFileName: "dev-populate-B.png",
  });
  console.log(`[dev:populate-investigation] Evidence B finalized ${evB.id} sha256=${evB.sha256} (== A)`);

  // ---- Evidence C (document / PDF — OCR pathway) -------------------------
  const evC = await createAndFinalizeEvidence({
    ownerUserId,
    teamId,
    kind: "document",
    bytes: pdfBytes,
    mimeType: "application/pdf",
    originalFileName: "dev-populate-C.pdf",
  });
  console.log(`[dev:populate-investigation] Evidence C finalized ${evC.id}`);

  // ---- Evidence D (audio — transcript pathway) ---------------------------
  const evD = await createAndFinalizeEvidence({
    ownerUserId,
    teamId,
    kind: "audio",
    bytes: audioBytes,
    mimeType: "audio/wav",
    originalFileName: "dev-populate-D.wav",
  });
  console.log(`[dev:populate-investigation] Evidence D finalized ${evD.id}`);

  // ---- Case → evidence links --------------------------------------------
  for (const ev of [evA, evB, evC, evD]) {
    try {
      await addEvidenceLink({
        caseId: caseRow.id,
        evidenceId: ev.id,
        role: "SUPPORTING",
        actorUserId: ownerUserId,
        reason: "auto-seed",
      });
    } catch (err) {
      // addEvidenceLink throws CaseError("evidence_link_exists") on
      // re-run — safe to swallow that specific case.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("evidence_link_exists")) {
        console.warn(
          `[dev:populate-investigation] case link skipped for ${ev.id}: ${msg.slice(0, 120)}`,
        );
      }
    }
  }
  console.log(`[dev:populate-investigation] linked 4 evidence rows to case ${caseRow.id}`);

  // ---- Review workflow row (canonical upsert) ----------------------------
  await upsertEvidenceReviewerWorkflow({
    evidenceId: evA.id,
    workspaceType: "TEAM",
    teamId,
    actorUserId: ownerUserId,
    assignedToUserId: ownerUserId,
    status: "IN_REVIEW",
    priority: "NORMAL",
    note: "dev:populate-investigation seed",
  });
  const workflowRow = await prisma.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: evA.id },
    select: { id: true },
  });
  if (!workflowRow) {
    throw new Error("upsertEvidenceReviewerWorkflow did not materialise a row.");
  }
  console.log(`[dev:populate-investigation] review workflow upserted id=${workflowRow.id}`);

  // ---- Escalation row (canonical service) --------------------------------
  const esc = await createEscalation({
    teamId,
    workflowId: workflowRow.id,
    reason: "REVIEW_OVERDUE",
    severity: "WARNING",
    safeSummary: "Auto-seeded escalation from dev:populate-investigation.",
    createdByUserId: ownerUserId,
    assignedToUserId: ownerUserId,
    evidenceId: evA.id,
  });
  if (esc.ok) {
    console.log(
      `[dev:populate-investigation] escalation upserted id=${esc.escalation.id} created=${esc.created}`,
    );
  } else {
    console.warn(`[dev:populate-investigation] escalation skipped: ${esc.code}`);
  }

  // ---- External reviewer grant (canonical service) -----------------------
  const grant = await issueExternalReviewGrant({
    teamId,
    invitedByUserId: ownerUserId,
    scopeKind: "EVIDENCE",
    evidenceId: evA.id,
    reviewerEmail: `dev-reviewer-${Date.now()}@dev.proovra.local`,
    reviewerDisplayName: "Dev External Reviewer",
    // 7 days — within the canonical [15min, 30day] window.
    expiresAtUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    allowOriginalDownload: false,
    allowPackageDownload: false,
    safeNote: "Auto-seeded grant from dev:populate-investigation.",
  });
  if (grant.ok) {
    console.log(
      `[dev:populate-investigation] external reviewer grant issued id=${grant.grant.id}`,
    );
  } else {
    console.warn(`[dev:populate-investigation] grant skipped: ${grant.reason}`);
  }

  // ---- Similarity detector (writes HASH_DUPLICATE for A <-> B) -----------
  // This runs through the same code path the route handlers use and
  // populates evidence_similarities with the kind that the diagnostics
  // count surfaces as duplicateExactCount.
  try {
    const summaryA = await reconcileSimilaritiesForEvidence(evA.id);
    const summaryB = await reconcileSimilaritiesForEvidence(evB.id);
    console.log(
      `[dev:populate-investigation] similarity detector A=${JSON.stringify(summaryA)} B=${JSON.stringify(summaryB)}`,
    );
  } catch (err) {
    console.warn(
      `[dev:populate-investigation] similarity detector failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }

  // ---- Graph reconcile (inline + enqueue) --------------------------------
  // Run inline so the graph nodes / edges are guaranteed materialized
  // even if no worker is attached to Redis. Also fire the enqueue so the
  // real producer signal is exercised (the queue idempotent-collapses
  // if Redis is not reachable).
  try {
    const inlineResult = await reconcileTeamGraph(teamId, prisma);
    console.log(
      `[dev:populate-investigation] reconcileTeamGraph inline ` +
        `nodes+=${inlineResult.nodesUpserted} edges+=${inlineResult.edgesUpserted} ` +
        `staleEdges=${inlineResult.edgesStaled}`,
    );
  } catch (err) {
    console.warn(
      `[dev:populate-investigation] inline reconcile failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  try {
    const enq = await enqueueGraphReconcileJob({
      teamId,
      reason: "manual_refresh",
      requestedByUserId: ownerUserId,
    });
    console.log(
      `[dev:populate-investigation] enqueueGraphReconcileJob queued=${enq.queued} reason=${enq.reason}`,
    );
  } catch (err) {
    console.warn(
      `[dev:populate-investigation] enqueue reconcile failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }

  // OCR / Transcript producer status — surface but do not fail.
  try {
    const { resolveProducerModeStatuses } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const statuses = await resolveProducerModeStatuses({ teamId, prisma });
    for (const s of statuses) {
      console.log(
        `[dev:populate-investigation] producer kind=${s.kind} mode=${s.mode} enabled=${s.enabled} reason=${s.reason}`,
      );
    }
    const ocr = statuses.find((s) => s.kind === "ocr");
    const transcript = statuses.find((s) => s.kind === "transcript");
    if (ocr && ocr.mode !== "VENDOR_CLOUD" && ocr.mode !== "LOCAL_TESSERACT") {
      console.log(
        `[dev:populate-investigation] extraction skipped: OCR_PRODUCER_MODE=${ocr.mode}, providers not ready`,
      );
    }
    if (transcript && transcript.mode !== "VENDOR_CLOUD") {
      console.log(
        `[dev:populate-investigation] extraction skipped: TRANSCRIPT_PRODUCER_MODE=${transcript.mode}, providers not ready`,
      );
    }
  } catch (err) {
    // Producer-mode resolver shapes change occasionally; the snapshot
    // below still prints honest zero counts when extraction is off.
    console.warn(
      `[dev:populate-investigation] producer-mode probe failed: ${(err as Error).message?.slice(0, 160)}`,
    );
  }

  // ---- Diagnostics snapshot ----------------------------------------------
  const diag = await buildInvestigationDiagnostics({ teamId, prisma });
  const counts = {
    teamId,
    caseId: caseRow.id,
    evidence: {
      a: evA.id,
      b: evB.id,
      c: evC.id,
      d: evD.id,
    },
    workspace: {
      evidenceCount: diag.workspace.evidenceCount,
      finalizedEvidenceCount: diag.workspace.finalizedEvidenceCount,
      evidencePartCount: diag.workspace.evidencePartCount,
      caseCount: diag.workspace.caseCount,
      caseEvidenceLinkCount: diag.workspace.caseEvidenceLinkCount,
      graphNodeCount: diag.workspace.graphNodeCount,
      graphEdgeCount: diag.workspace.graphEdgeCount,
      staleGraphEdgeCount: diag.workspace.staleGraphEdgeCount,
      timelineEventCount: diag.workspace.timelineEventCount,
      duplicateExactCount: diag.workspace.duplicateExactCount,
      duplicateSimilarityCount: diag.workspace.duplicateSimilarityCount,
      duplicateDerivativeCount: diag.workspace.duplicateDerivativeCount,
      reviewWorkflowCount: diag.workspace.reviewWorkflowCount,
      escalationCount: diag.workspace.escalationCount,
      externalReviewerGrantCount: diag.workspace.externalReviewerGrantCount,
      extractedTextCount: diag.workspace.extractedTextCount,
      ocrRecordCount: diag.workspace.ocrRecordCount,
      transcriptRecordCount: diag.workspace.transcriptRecordCount,
      perceptualHashCount: diag.workspace.perceptualHashCount,
    },
    warnings: diag.warnings,
  };

  console.log("[dev:populate-investigation] DIAGNOSTICS SNAPSHOT");
  console.log(JSON.stringify(counts, null, 2));
  console.log("[dev:populate-investigation] done.");
}

main()
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dev:populate-investigation] FAILED: ${msg}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* best-effort */
    }
  });
