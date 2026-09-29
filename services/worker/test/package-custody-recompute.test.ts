/**
 * ET-PKG-01 — custody.json in the verification package recomputes.
 *
 * A recipient following the package README must be able to recompute every
 * eventHash from custody.json. The hash formula is implemented here
 * INDEPENDENTLY of @proovra/shared (from the README's words), and the events
 * are hashed by the production buildCustodyEventHash.
 *
 * On a40ca76f the processor REPLACED each payload with its presentation copy
 * before export, so any event carrying captureMethodSnapshot / uploadKind
 * failed to recompute — reading as tampering.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildCustodyEventHash } from "@proovra/shared/custody-hash";

import {
  normalizeCustodyEventPayloadForPresentation,
  packageCustodyEntry,
} from "../src/report-v2/normalizers.js";

/** The README's formula, written from its words. */
function readmeCanonical(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(readmeCanonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${readmeCanonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
function readmeHash(evidenceId: string, e: { sequence: number; eventType: string; atUtc: string; payload?: unknown; prevEventHash: string | null }) {
  const canonical = readmeCanonical({
    v: 1,
    evidenceId,
    sequence: e.sequence,
    eventType: e.eventType,
    atUtc: e.atUtc,
    payload: e.payload ?? null,
    prevEventHash: e.prevEventHash ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const EVIDENCE_ID = "8d7f0f3e-5b8c-4c7a-9e57-2f3f1c0a9b11";
const INTAKE = { acquisitionMode: "SECURE_INTAKE_LINK", isIntake: true };

function chain() {
  const raw = [
    { eventType: "EVIDENCE_CREATED", payload: { captureMethodSnapshot: "MULTIPART_PACKAGE", n: 1 } },
    { eventType: "UPLOAD_AUTHORIZED", payload: { uploadKind: "intake_authorization" } },
    { eventType: "SIGNATURE_APPLIED", payload: { fileSha256: "ab".repeat(32) } },
    { eventType: "REPORT_GENERATED", payload: null },
  ];
  let prev: string | null = null;
  return raw.map((r, i) => {
    const atUtc = new Date(Date.UTC(2026, 8, 29, 12, 0, i)).toISOString();
    const eventHash = buildCustodyEventHash({
      evidenceId: EVIDENCE_ID,
      sequence: i + 1,
      eventType: r.eventType,
      atUtc: new Date(atUtc),
      payload: r.payload,
      prevEventHash: prev,
    });
    const e = { sequence: i + 1, atUtc, eventType: r.eventType, payload: r.payload as unknown, prevEventHash: prev, eventHash };
    prev = eventHash;
    return e;
  });
}

describe("verification package custody.json (ET-PKG-01)", () => {
  it("every exported event recomputes with the README formula, and the chain links", () => {
    const exported = chain().map((e) => packageCustodyEntry(e, INTAKE));
    let prev: string | null = null;
    for (const e of exported) {
      expect(readmeHash(EVIDENCE_ID, e)).toBe(e.eventHash);
      expect(e.prevEventHash).toBe(prev);
      prev = e.eventHash;
    }
  });

  it("the role-safe presentation rides beside the hashed payload, only where it differs", () => {
    const [created, authorized, signed] = chain().map((e) => packageCustodyEntry(e, INTAKE));
    expect(created.payload).toEqual({ captureMethodSnapshot: "MULTIPART_PACKAGE", n: 1 });
    expect(created.presentationPayload).toMatchObject({ captureMethodSnapshot: "Secure Intake Link" });
    // For an intake record the intake authorization label is already right.
    expect("presentationPayload" in authorized).toBe(false);
    expect("presentationPayload" in signed).toBe(false);
  });

  it("contrast: substituting the presentation copy for the payload (the prior export) does not recompute", () => {
    const [created] = chain();
    const priorExport = {
      ...created,
      payload: normalizeCustodyEventPayloadForPresentation(created.payload, INTAKE),
    };
    expect(readmeHash(EVIDENCE_ID, priorExport)).not.toBe(created.eventHash);
  });

  it("the processor exports custody through packageCustodyEntry and never overwrites payload", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/processor.ts", import.meta.url)), "utf8");
    expect(src).toContain("custody: finalized.finalizedCustodyEvents.map((e) =>\n            packageCustodyEntry(e, {");
    expect(src).not.toMatch(/payload:\s*normalizeCustodyEventPayloadForPresentation\(/);
  });
});
