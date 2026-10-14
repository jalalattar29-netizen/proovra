/**
 * OPERATIONS CONDITION MESSAGES, END TO END (live PostgreSQL 16).
 *
 * A writer's code and params are stored beside the English they render, the
 * projection carries them, and a client resolves them in its own language:
 *
 *   - API writer: code + params stored, English rendered from the catalogue;
 *   - worker writer: the same, through `recordWorkerIncident`;
 *   - a LEGACY row (English only, no code) is untouched by every read and
 *     resolves to its stored text in de/ar — no history is rewritten;
 *   - a legacy row is stamped by its next observation, words and code together;
 *   - an invalid message is written WITHOUT a code under the source's label;
 *   - the workspace-health alert list and the group drill-down carry the code.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { localizeCondition } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const FP = "message-code-it";

describe("condition message codes are stored, projected and localized (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let emitter: typeof import("../../worker/src/governance/incident-emitter.js");
  let drilldown: typeof import("../src/services/operations/operations-group-drilldown.service.js");
  let teamId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    emitter = await import("../../worker/src/governance/incident-emitter.js");
    drilldown = await import("../src/services/operations/operations-group-drilldown.service.js");
    teamId = harness.fixtures.teamA.teamId;
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // Only this file's own rows — never another suite's.
  afterEach(async () => {
    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint: { contains: FP } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.operationalIncidentSlaCycle.deleteMany({ where: { incidentId: { in: ids } } });
      await prisma.operationalIncidentEvent.deleteMany({ where: { incidentId: { in: ids } } });
      await prisma.operationalIncident.deleteMany({ where: { id: { in: ids } } });
    }
  });

  const unique = (tag: string) => `${FP}:${tag}:${Math.random().toString(36).slice(2, 10)}`;

  it("the API writer stores the code and params, and the English rendered from them", async () => {
    const { incident } = await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint: unique("webhook"),
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 9 } },
    });
    const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(row.messageCode).toBe("ops.integration.webhook_destination_disabled");
    expect(row.messageParams).toEqual({ failures: 9 });
    expect(row.title).toBe("Webhook destination disabled after repeated failures");
    expect(row.safeSummary).toContain("after 9 consecutive failed deliveries");

    const projected = incidents.projectIncident(row);
    expect(projected.message).toEqual({
      code: "ops.integration.webhook_destination_disabled",
      params: { failures: 9 },
      titleSource: "CONDITION",
    });
    const de = localizeCondition("de", { ...projected, sourceId: projected.lifecycle.sourceId, titleSource: projected.message.titleSource });
    expect(de.title).toBe("Webhook-Ziel nach wiederholten Fehlern deaktiviert");
    expect(de.summary).toContain("9");
    const ar = localizeCondition("ar", { ...projected, sourceId: projected.lifecycle.sourceId, titleSource: projected.message.titleSource });
    expect(ar.title).toMatch(/[؀-ۿ]/);
    expect(localizeCondition("en", projected).title).toBe(row.title);
  });

  it("the worker writer stores the code and params the same way", async () => {
    const evidenceId = harness.fixtures.teamA.evidenceId;
    const row = await emitter.recordWorkerIncident({
      sourceId: "pipeline.report_generation_failed",
      teamId,
      category: "REPORT",
      severity: "HIGH",
      fingerprint: unique("REPORT"),
      message: {
        code: "ops.pipeline.report_generation_failed.not_retriable",
        params: { version: 2, recordRef: "9f1d2c3b", errorClass: "UNCLASSIFIED" },
      },
      relatedEvidenceId: evidenceId,
    });
    expect(row).toBeTruthy();
    const stored = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row!.id } });
    expect(stored.messageCode).toBe("ops.pipeline.report_generation_failed.not_retriable");
    expect(stored.messageParams).toEqual({ version: 2, recordRef: "9f1d2c3b", errorClass: "UNCLASSIFIED" });
    expect(stored.title).toBe("Report v2 generation failed — record 9f1d2c3b");
  });

  it("a legacy English row is never rewritten by a read and renders its stored text", async () => {
    const { incident } = await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint: unique("legacy"),
      title: "A legacy English title",
      safeSummary: "A legacy English summary written before codes existed.",
    });
    const before = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(before.messageCode).toBeNull();
    expect(before.messageParams).toBeNull();

    const projected = incidents.projectIncident(before);
    expect(projected.message.code).toBeNull();
    for (const locale of ["en", "de", "ar"]) {
      const r = localizeCondition(locale, { ...projected, sourceId: projected.lifecycle.sourceId, titleSource: projected.message.titleSource });
      expect(r.title).toBe("A legacy English title");
      expect(r.summary).toBe("A legacy English summary written before codes existed.");
    }
    // Reading did not touch it.
    const after = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.title).toBe(before.title);
    expect(after.messageCode).toBeNull();
  });

  it("a legacy row is stamped by its next observation, words and code together", async () => {
    const fingerprint = unique("restamp");
    await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint,
      title: "Old words",
      safeSummary: "Old summary.",
    });
    const { incident } = await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint,
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 11 } },
    });
    const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    // (2026-10-14) A disabled destination is a STATE: the re-observation
    // restamps the words and code without counting a second occurrence.
    expect(row.occurrenceCount).toBe(1);
    expect(row.messageCode).toBe("ops.integration.webhook_destination_disabled");
    expect(row.title).toBe("Webhook destination disabled after repeated failures");
    // The history keeps what was written then.
    const events = await prisma.operationalIncidentEvent.findMany({ where: { incidentId: row.id } });
    expect(events.some((e) => e.safeMessage === "Old summary.")).toBe(true);
  });

  it("an invalid message is written without a code, under the source's own label", async () => {
    const { incident } = await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint: unique("invalid"),
      // A param of the wrong type: the code is refused, the observation kept.
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: "nine" as never } },
    });
    const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(row.messageCode).toBeNull();
    expect(row.title).toBe("Webhook destination disabled after repeated failures");
    expect(row.safeSummary).toBe("This condition was recorded without readable details.");
  });

  it("the workspace-health alert list carries each alert's code (and still no fingerprint)", async () => {
    await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint: unique("alerts"),
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 4 } },
    });
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/operations/alerts`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ title: string; safeSummary: string | null; message: { code: string | null; params: unknown; titleSource: string } }> };
    const mine = body.items.find((i) => i.message?.code === "ops.integration.webhook_destination_disabled");
    expect(mine).toBeTruthy();
    expect(mine!.message).toEqual({ code: "ops.integration.webhook_destination_disabled", params: { failures: 4 }, titleSource: "CONDITION" });
    expect(localizeCondition("de", { title: mine!.title, safeSummary: mine!.safeSummary ?? "", message: mine!.message as never }).title).toBe(
      "Webhook-Ziel nach wiederholten Fehlern deaktiviert",
    );
    expect(JSON.stringify(body)).not.toContain("fingerprint");
  });

  it("the group drill-down carries each record's code", async () => {
    await incidents.recordIncident({
      sourceId: "integration.webhook_destination_disabled",
      teamId,
      category: "INTEGRATION",
      severity: "HIGH",
      fingerprint: unique("drill"),
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 3 } },
    });
    const page = await drilldown.listGroupAffectedRecords({
      teamId,
      sourceId: "integration.webhook_destination_disabled",
      limit: 50,
    });
    const mine = page.records.find((r) => r.message.code === "ops.integration.webhook_destination_disabled");
    expect(mine).toBeTruthy();
    expect(mine!.message.params).toEqual({ failures: 3 });
  });
});
