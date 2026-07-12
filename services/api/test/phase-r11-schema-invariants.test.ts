/**
 * Phase R11 — Forensic schema invariant pins (finding F26).
 *
 * The schema is `prisma validate`-clean and the full API suite compiles
 * against the generated client, so schema↔code is consistent. This adds a
 * contract layer over the FORENSIC INVARIANTS a future migration must never
 * silently weaken — the schema-level equivalents of the runtime guards the
 * remediation added.
 *
 * It also PINS the deliberate design choices the audit mis-flagged as gaps
 * (notably `Evidence.teamId` being intentionally nullable = the personal-
 * scope signal) so nobody "fixes" them into a regression.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name} must exist`).toBeGreaterThan(-1);
  const rest = schema.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("Phase R11 — forensic schema invariants (F26)", () => {
  it("CustodyEvent is a hash-linked, gap-free chain per evidence", () => {
    const m = modelBlock("CustodyEvent");
    expect(m).toMatch(/sequence\s+Int/);
    expect(m).toMatch(/prevEventHash\s+String\?/);
    expect(m).toMatch(/eventHash\s+String\?/);
    // One event per (evidence, sequence) — the chain cannot fork or dup.
    expect(m).toMatch(/@@unique\(\[evidenceId,\s*sequence\]\)/);
  });

  it("Report and VerificationPackage are versioned one-per-(evidence,version)", () => {
    expect(modelBlock("Report")).toMatch(/@@unique\(\[evidenceId,\s*version\]\)/);
    expect(modelBlock("VerificationPackage")).toMatch(
      /@@unique\(\[evidenceId,\s*version\]\)/,
    );
  });

  it("EvidenceLegalHold.teamId is REQUIRED — no personal-scope holds (guards F2)", () => {
    const m = modelBlock("EvidenceLegalHold");
    expect(m).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
    expect(m).not.toMatch(/teamId\s+String\?/);
  });

  it("Evidence declares the forensic crypto fields (hash / fingerprint / signature)", () => {
    const m = modelBlock("Evidence");
    expect(m).toMatch(/fileSha256\s+String\?/);
    expect(m).toMatch(/fingerprintHash\s+String\?/);
    expect(m).toMatch(/signatureBase64\s+String\?/);
    expect(m).toMatch(/fingerprintCanonicalJson\s+String\?/);
  });

  it("Evidence.teamId is INTENTIONALLY nullable — the personal-scope signal (do NOT make non-null)", () => {
    // teamId === null means personal-workspace evidence. Making it non-null
    // would break personal capture entirely. This pin documents the intent
    // so the audit's "nullable should be invariant" is never mis-applied.
    const m = modelBlock("Evidence");
    expect(m).toMatch(/teamId\s+String\?\s+@map\("team_id"\)/);
  });

  it("the Phase-A1 tenancy invariant migration exists (team_id ⇒ organization_id)", () => {
    // Personal evidence: team_id NULL. Team evidence: team_id ⇒ organization_id.
    const migReadme = readFileSync(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(migReadme).toMatch(/team_id/);
    expect(migReadme).toMatch(/organization_id/);
  });
});
