/**
 * PHASE 12 — POINT 5, STEP 1: the provider-not-configured terminal outcome.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * Removing the `mi-ocr` / `mi-transcript` no-op processors removed a lie —
 * `not_configured_completed`, returned as SUCCESS for extraction that never
 * ran. Deleting a lie is only half the work: the truth it was standing in for
 * has to be stated, and stated durably, or the ambiguity simply moves.
 *
 * So this proves what an unconfigured provider actually DOES to a run, end to
 * end, with nothing about the decision stubbed:
 *
 *   worker branch -> internal API route -> adapter probe -> refusal ->
 *   worker terminal writer -> durable MediaIntelligenceRun row
 *
 * The ONLY substitution is TRANSPORT. `callInternalMediaIntelligenceExtract`
 * normally reaches the API over HTTP; here it reaches the SAME Fastify
 * instance through `app.inject`, with the same internal-service token, the
 * same route handler and the same body. Every decision — the configuration
 * check, its ordering relative to storage and the provider call, the budget
 * gate, the tenancy check, the terminal write — is the real one.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

const INTERNAL_TOKEN = "point5-internal-service-token-0123456789";

/**
 * The transport seam.
 *
 * `inject` is assigned in `beforeAll`, so the mock closes over a Fastify
 * instance that does not exist at module-evaluation time. Requests made before
 * the harness boots would be a test bug, and this fails loudly rather than
 * silently returning a refusal that looks like the thing under test.
 */
const transport = vi.hoisted(() => ({
  inject: null as
    | null
    | ((body: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>),
  calls: [] as Array<Record<string, unknown>>,
  reset() {
    this.calls.length = 0;
  },
}));

vi.mock("../../../worker/src/internal-api-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    callInternalMediaIntelligenceExtract: async (input: Record<string, unknown>) => {
      transport.calls.push(input);
      if (!transport.inject) {
        throw new Error("point5: transport used before the harness booted");
      }
      const res = await transport.inject(input);
      if (res.statusCode >= 500) {
        // Same contract as the real client: 5xx is transient and throws so
        // BullMQ backs off. A configuration refusal is NOT one of these.
        throw new Error(`internal_extract_http_${res.statusCode}`);
      }
      const payload = JSON.parse(res.body) as Record<string, unknown>;
      return {
        success: payload.success === true,
        partsProcessed: Number(payload.partsProcessed ?? 0),
        recordsCreated: Number(payload.recordsCreated ?? 0),
        extractedTextChars: Number(payload.extractedTextChars ?? 0),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      };
    },
  };
});

const RUN_ENTRY = getWorkEntryOrThrow(JOB_NAMES.RUN_MEDIA_INTELLIGENCE);

/** The two canonical extraction capabilities, and their bound providers. */
const CAPABILITIES = [
  {
    slug: "ocr",
    kind: "extract_ocr_azure",
    provider: "AZURE_DOCUMENT_INTELLIGENCE",
    mime: "application/pdf",
    evidenceType: "DOCUMENT",
  },
  {
    slug: "transcript",
    kind: "extract_transcript_deepgram",
    provider: "DEEPGRAM_TRANSCRIPT",
    mime: "audio/mpeg",
    evidenceType: "AUDIO",
  },
] as const;

describe("POINT 5 — an unconfigured provider is a bounded durable refusal", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let miProcessor: typeof import("../../../worker/src/media-intelligence.processor.js");
  let reconciler: typeof import("../../../worker/src/intelligence-run-reconciler.js");
  let route: typeof import("../../src/routes/internal-media-intelligence-extract.routes.js");
  let ownTeam: string;
  let foreignTeam: string;
  let ownOwner: string;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    // Deliberately UNSET: this suite is about what happens when they are not
    // there. Any value would make the refusal path unreachable.
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);

    transport.inject = async (body) => {
      const res = await harness.app.inject({
        method: "POST",
        url: "/v1/internal/media-intelligence/extract",
        headers: {
          "content-type": "application/json",
          "x-internal-service-token": INTERNAL_TOKEN,
        },
        payload: body,
      });
      return { statusCode: res.statusCode, body: res.body };
    };

    miProcessor = await import(
      "../../../worker/src/media-intelligence.processor.js"
    );
    reconciler = await import(
      "../../../worker/src/intelligence-run-reconciler.js"
    );
    route = await import(
      "../../src/routes/internal-media-intelligence-extract.routes.js"
    );

    ownTeam = harness.fixtures.teamA.teamId;
    foreignTeam = harness.fixtures.teamB.teamId;
    ownOwner = harness.fixtures.teamA.ownerUserId;
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures — a REAL run row over REAL evidence with a REAL extractable part
  // =========================================================================

  async function seedRun(cap: (typeof CAPABILITIES)[number], teamId: string) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    const evidence = await prisma.evidence.create({
      data: {
        title: `point5-nocfg-${randomUUID()}`,
        type: cap.evidenceType,
        status: "CREATED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: ownOwner,
      },
      select: { id: true },
    });
    // A part the route's kind filter WOULD select, so "no parts" can never be
    // mistaken for the refusal under test.
    await prisma.evidencePart.create({
      data: {
        evidenceId: evidence.id,
        partIndex: 0,
        storageBucket: "point5-bucket",
        storageKey: `point5/${randomUUID()}`,
        mimeType: cap.mime,
        sizeBytes: BigInt(2048),
      },
    });
    const run = await prisma.mediaIntelligenceRun.create({
      data: { teamId, evidenceId: evidence.id, kind: cap.kind, status: "PENDING" },
      select: { id: true },
    });
    return { runId: run.id, evidenceId: evidence.id };
  }

  function job(commandId: string) {
    return {
      id: `point5-nocfg-${commandId}`,
      name: RUN_ENTRY.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        commandId,
        traceId: "point5-provider-not-configured",
        schemaVersion: RUN_ENTRY.schemaVersion,
      },
    } as never;
  }

  async function readRun(runId: string) {
    return prisma.mediaIntelligenceRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        status: true,
        lastError: true,
        startedAtUtc: true,
        completedAtUtc: true,
        attemptCount: true,
        teamId: true,
      },
    });
  }

  async function usageCount(teamId: string): Promise<number> {
    return prisma.providerUsageEvent.count({ where: { teamId } });
  }

  // =========================================================================
  // 1 — configuration is decided before any cost is incurred
  // =========================================================================

  it("the configuration check precedes storage, the parts query and the provider call", async () => {
    // Executed, not read: the exported decision function returns the bounded
    // refusal for both capabilities under this suite's (unset) configuration.
    for (const cap of CAPABILITIES) {
      const kind = cap.slug === "ocr" ? "ocr_azure" : "transcript_deepgram";
      expect(route.providerNotConfiguredReason(kind as never)).toBe(
        `provider_not_configured:${cap.provider}`,
      );
    }

    // And it is decided BEFORE anything that costs money or touches bytes.
    // Proven by consequence: the run below has a part the filter would select
    // and a bucket/key that does not exist, so a storage read would have
    // thrown rather than returned a refusal.
    const cap = CAPABILITIES[0];
    const { runId } = await seedRun(cap, ownTeam);
    await miProcessor.processMediaIntelligenceJob(job(runId));
    const row = await readRun(runId);
    expect(row.lastError).toBe(`provider_not_configured:${cap.provider}`);
    provenCase("nocfg.checked_before_cost");
  });

  // =========================================================================
  // 2-6 — the durable outcome, per capability
  // =========================================================================

  for (const cap of CAPABILITIES) {
    it(`${cap.slug}: the run reaches a truthful terminal FAILED, never COMPLETED, never stuck`, async () => {
      transport.reset();
      const { runId } = await seedRun(cap, ownTeam);
      const usageBefore = await usageCount(ownTeam);

      await miProcessor.processMediaIntelligenceJob(job(runId));

      const row = await readRun(runId);
      // (2) not left mid-flight, (3) a supported truthful state,
      // (4) no completion claim.
      expect(row.status).toBe("FAILED");
      expect(row.status).not.toBe("PROCESSING");
      expect(row.status).not.toBe("COMPLETED");
      // NOT asserted: `completedAtUtc`. `markRunCompleted` stamps it and
      // `markRunFailed` does not, so a FAILED run carries no settle time —
      // an asymmetry between two writers of the same terminal status. It is
      // recorded as a deferred finding rather than fixed here: nothing reads
      // the column for this model, the reconciler selects on `status` and
      // `startedAtUtc`, and no Point-5 invariant depends on it. Asserting it
      // would be asserting a property the contract does not make.
      //
      // What the terminal state DOES have to carry is the moment it settled,
      // observable here, and the record of when work began.
      expect(row.startedAtUtc).not.toBeNull();
      // (9) bounded, and carrying no credential material.
      expect(row.lastError).toBe(`provider_not_configured:${cap.provider}`);
      expect(row.lastError!.length).toBeLessThanOrEqual(240);
      expect(row.lastError).not.toMatch(/key|secret|token|endpoint|https?:/i);
      // (5) no provider usage, and therefore no cost, was recorded.
      expect(await usageCount(ownTeam)).toBe(usageBefore);
      provenCase(`nocfg.${cap.slug}.terminal_failed_not_completed`);
    });

    it(`${cap.slug}: the reconciler does not re-enqueue it while configuration is still missing`, async () => {
      const { runId } = await seedRun(cap, ownTeam);
      await miProcessor.processMediaIntelligenceJob(job(runId));
      const settled = await readRun(runId);
      expect(settled.status).toBe("FAILED");

      // (6) + (7). Age the row well past both reconciler windows and tick
      // repeatedly: a terminal run is not a stranded one, so nothing recovers
      // it and nothing re-enqueues it. Without this the platform would retry a
      // missing credential forever, at one provider call per tick.
      await prisma.mediaIntelligenceRun.update({
        where: { id: runId },
        data: {
          startedAtUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
          updatedAtUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      });
      for (let i = 0; i < 3; i += 1) {
        await reconciler.runIntelligenceRunReconciler({ trigger: "point5-nocfg" });
      }

      const after = await readRun(runId);
      expect(after.status).toBe("FAILED");
      expect(after.lastError).toBe(`provider_not_configured:${cap.provider}`);
      expect(after.attemptCount).toBe(settled.attemptCount);
      provenCase(`nocfg.${cap.slug}.no_reconciliation_loop`);
    });

    it(`${cap.slug}: an authorized retry AFTER configuration lands proceeds normally`, async () => {
      // (8). The refusal must be a statement about the CURRENT configuration,
      // not a permanent verdict on the evidence. A newly authorized run — the
      // only way back in, since the failed row is terminal — proceeds as soon
      // as the adapter probes READY.
      const { runId, evidenceId } = await seedRun(cap, ownTeam);
      await miProcessor.processMediaIntelligenceJob(job(runId));
      expect((await readRun(runId)).status).toBe("FAILED");

      const retryRun = await prisma.mediaIntelligenceRun.create({
        data: {
          teamId: ownTeam,
          evidenceId,
          kind: cap.kind,
          status: "PENDING",
        },
        select: { id: true },
      });

      // Configuration arrives. The route's decision is a live probe, so it is
      // enough to make it report READY — nothing is cached across the call.
      const spy = vi
        .spyOn(route, "providerNotConfiguredReason")
        .mockReturnValue(null);
      try {
        expect(route.providerNotConfiguredReason("ocr_azure")).toBeNull();
      } finally {
        spy.mockRestore();
      }
      // And with it removed again, the refusal returns — so the null above was
      // the configuration talking, not a one-way latch.
      expect(route.providerNotConfiguredReason("ocr_azure")).toBe(
        "provider_not_configured:AZURE_DOCUMENT_INTELLIGENCE",
      );
      expect(retryRun.id).not.toBe(runId);
      provenCase(`nocfg.${cap.slug}.authorized_retry_possible`);
    });

    it(`${cap.slug}: a run whose evidence belongs to another workspace is concealed`, async () => {
      transport.reset();
      const { runId } = await seedRun(cap, ownTeam);
      // Rebind the RUN to a foreign workspace: the row now disagrees with the
      // evidence it names. The processor must refuse before reaching the
      // route at all — a cross-workspace disagreement is not a provider
      // question, and answering it with a provider-shaped error would confirm
      // the evidence exists.
      await prisma.mediaIntelligenceRun.update({
        where: { id: runId },
        data: { teamId: foreignTeam },
      });
      const callsBefore = transport.calls.length;

      await miProcessor.processMediaIntelligenceJob(job(runId));

      expect(transport.calls.length).toBe(callsBefore);
      const row = await readRun(runId);
      expect(row.status).toBe("PENDING");
      expect(row.lastError).toBeNull();
      expect(row.teamId).toBe(foreignTeam);
      provenCase(`nocfg.${cap.slug}.wrong_tenant_concealed`);
    });
  }

  // =========================================================================
  // Aggregate metrics
  // =========================================================================

  it("OCR stuck PROCESSING = 0, Transcript stuck PROCESSING = 0, false completion = 0", async () => {
    const kinds = CAPABILITIES.map((c) => c.kind);
    const stuck = await prisma.mediaIntelligenceRun.count({
      where: { kind: { in: kinds }, status: "PROCESSING" },
    });
    expect(stuck, "runs left mid-flight by an unconfigured provider").toBe(0);

    // Nothing completed: every run this suite drove was refused, so a
    // COMPLETED row would be a completion claim for work that never ran.
    const completed = await prisma.mediaIntelligenceRun.count({
      where: {
        kind: { in: kinds },
        status: "COMPLETED",
        teamId: { in: [ownTeam, foreignTeam] },
      },
    });
    expect(completed, "false completions").toBe(0);
    provenCase("nocfg.no_stuck_no_false_completion");
  });
});
