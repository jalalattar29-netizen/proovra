/**
 * TEAM REMEDIATION ROUND 2 (2026-11-25) — redaction detection obeys the
 * WORKSPACE AI POLICY.
 *
 * Before: runRedactionDetection asked only the redaction policy, so a workspace
 * that turned AI off, or never allowed raw content, OCR or transcription,
 * still sent its evidence bytes to AWS Rekognition, Azure Document
 * Intelligence and Deepgram. Every other AI entry point already applied the
 * policy (media intelligence, copilots, semantic search, worker embeddings).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let detection: typeof import("../src/services/redaction/redaction-detection.service.js");

beforeAll(async () => {
  h = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  detection = await import("../src/services/redaction/redaction-detection.service.js");
}, 900_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 300_000);

const setPolicy = (teamId: string, data: Record<string, boolean>) =>
  prisma.workspaceAiPolicy.upsert({ where: { teamId }, create: { teamId, ...data }, update: data });

describe("redaction detection — workspace AI policy", () => {
  it("defaults (no policy row): external providers are blocked, local ones are not", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await prisma.workspaceAiPolicy.deleteMany({ where: { teamId } });
    const block = await detection.workspaceAiPolicyBlockFor(teamId);
    expect(block("AWS_REKOGNITION_FACES")).toBe("RAW_CONTENT_NOT_ALLOWED");
    expect(block("AWS_REKOGNITION_TEXT")).toBe("RAW_CONTENT_NOT_ALLOWED");
    expect(block("AZURE_DOCUMENT_INTELLIGENCE")).toBe("RAW_CONTENT_NOT_ALLOWED");
    expect(block("DEEPGRAM_TRANSCRIPT")).toBe("RAW_CONTENT_NOT_ALLOWED");
    expect(block("REGEX_PII")).toBeNull();
    expect(block("MANUAL")).toBeNull();
  });

  it("the master switch blocks every external provider", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await setPolicy(teamId, { aiEnabled: false, rawContentProcessingAllowed: true, ocrAllowed: true, transcriptionAllowed: true });
    const block = await detection.workspaceAiPolicyBlockFor(teamId);
    for (const p of ["AWS_REKOGNITION_FACES", "AWS_REKOGNITION_TEXT", "AZURE_DOCUMENT_INTELLIGENCE", "DEEPGRAM_TRANSCRIPT"] as const) {
      expect(block(p)).toBe("WORKSPACE_DISABLED");
    }
    expect(block("REGEX_PII")).toBeNull();
  });

  it("each data class is its own switch: OCR for text and documents, transcription for audio", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await setPolicy(teamId, { aiEnabled: true, rawContentProcessingAllowed: true, ocrAllowed: true, transcriptionAllowed: false });
    let block = await detection.workspaceAiPolicyBlockFor(teamId);
    expect(block("AWS_REKOGNITION_FACES")).toBeNull();
    expect(block("AWS_REKOGNITION_TEXT")).toBeNull();
    expect(block("AZURE_DOCUMENT_INTELLIGENCE")).toBeNull();
    expect(block("DEEPGRAM_TRANSCRIPT")).toBe("TRANSCRIPTION_NOT_ALLOWED");

    await setPolicy(teamId, { aiEnabled: true, rawContentProcessingAllowed: true, ocrAllowed: false, transcriptionAllowed: true });
    block = await detection.workspaceAiPolicyBlockFor(teamId);
    expect(block("AWS_REKOGNITION_TEXT")).toBe("OCR_NOT_ALLOWED");
    expect(block("AZURE_DOCUMENT_INTELLIGENCE")).toBe("OCR_NOT_ALLOWED");
    expect(block("DEEPGRAM_TRANSCRIPT")).toBeNull();
    await prisma.workspaceAiPolicy.deleteMany({ where: { teamId } });
  });

  it("runRedactionDetection asks the AI policy before any provider is dispatched", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../src/services/redaction/redaction-detection.service.ts"), "utf8");
    const run = src.slice(src.indexOf("export async function runRedactionDetection("));
    const gate = run.indexOf("workspaceAiPolicyBlockFor(input.teamId)");
    const loop = run.indexOf("for (const provider of input.providers)");
    const denied = run.indexOf("const aiDenied = aiBlock(provider);");
    const dispatch = run.indexOf("resolveProvider(provider)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(loop);
    expect(denied).toBeGreaterThan(loop);
    expect(dispatch).toBeGreaterThan(denied);
  });
});
