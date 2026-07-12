/**
 * Phase R1 — Upload-session evidence ownership guard (IDOR fix).
 *
 * Finding (object-level authorization sweep): `POST /v1/uploads/sessions`
 * (and the API-credential `integrations-uploads` variant) authorized the
 * caller only for `body.teamId` — it never verified that the client-
 * supplied `body.evidenceId` belonged to that team. A member of Team A
 * could open a session (row written with A's team_id) targeting Team B's
 * evidence id; the Phase 30.12 multipart-complete bridge
 * (`completeStorageMultipart` → `evidencePart.create({ evidenceId })`)
 * would then attach an `EvidencePart` to Team B's forensic Evidence — a
 * cross-tenant custody-tampering write.
 *
 * The fix lives in `createUploadSession` (the shared choke point both
 * routes flow through): before any row is written it loads
 * `evidence WHERE id = evidenceId AND teamId = teamId` and denies with
 * `evidence_not_found` (mapped to an anti-enumeration 404) when absent.
 *
 * Source-contract assertions (DB-free), matching the repo's existing
 * upload-session test style, so this guards the fix from silently
 * regressing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const serviceSrc = readSource(
  "../src/services/uploads/upload-session.service.ts",
);
const routeSrc = readSource("../src/routes/upload-sessions.routes.ts");
const integrationsSrc = readSource(
  "../src/routes/integrations-uploads.routes.ts",
);

describe("Phase R1 — upload-session evidence ownership guard", () => {
  it("declares the evidence_not_found denial code", () => {
    expect(serviceSrc).toContain('"evidence_not_found"');
  });

  it("createUploadSession loads the evidence scoped to the session team", () => {
    // The guard must filter by BOTH id and teamId (the IDOR-closing pair)
    // and must run before the INSERT.
    const createStart = serviceSrc.indexOf("export async function createUploadSession");
    expect(createStart).toBeGreaterThan(-1);
    const insertIdx = serviceSrc.indexOf(
      'INSERT INTO "evidence_upload_sessions"',
      createStart,
    );
    const guardIdx = serviceSrc.indexOf("evidence.findFirst", createStart);
    expect(guardIdx).toBeGreaterThan(-1);
    // Guard appears before the session INSERT (fail-closed, no row written).
    expect(guardIdx).toBeLessThan(insertIdx);
    const guardRegion = serviceSrc.slice(guardIdx, guardIdx + 220);
    expect(guardRegion).toMatch(/id:\s*input\.evidenceId/);
    expect(guardRegion).toMatch(/teamId:\s*input\.teamId/);
    expect(serviceSrc).toMatch(
      /if \(!owningEvidence\)\s*\{[\s\S]*?reason:\s*"evidence_not_found"/,
    );
  });

  it("both upload routes map evidence_not_found to an anti-enumeration 404", () => {
    for (const src of [routeSrc, integrationsSrc]) {
      // The case sits inside the same block that returns 404.
      const idx = src.indexOf('case "evidence_not_found":');
      expect(idx).toBeGreaterThan(-1);
      const after = src.slice(idx, idx + 80);
      expect(after).toMatch(/return 404/);
    }
  });
});
