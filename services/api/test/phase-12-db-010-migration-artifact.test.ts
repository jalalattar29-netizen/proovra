/**
 * PHASE 12 CORRECTIVE PASS §7 (DB-010) — THE ARTIFACT GATE, NEGATIVE-TESTED.
 *
 * DB-010's residual risk was stated as "artifact may ship a destructive
 * migration without its guard". The Point-8 boundary gate could not close it:
 * that gate conserves PATHS between three source views, and a path can be
 * perfectly conserved while the SQL inside it drops a table with its guard left
 * in a file that ships in a different release.
 *
 * So the gate reads the SQL in a MATERIALIZED artifact. And because a detector
 * that has never been shown to detect is exactly the fictional control this
 * exercise keeps finding, every rule is driven by an INJECTION: a real
 * artifact is materialized, one specific defect is written into it, and the
 * gate is required to fail with the matching code.
 *
 * The ten injections are the ten §7 names. Each is a defect that has either
 * been observed in this repository's history or is one keystroke away from it.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { materialize } from "../scripts/release-materialize.mjs";
import { verifyArtifact } from "../scripts/verify-migration-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const MIG_REL = "services/api/prisma/migrations";

let baseline: string;
let workdir: string;

/** A fresh copy of the proposed artifact, for one injection to deface. */
function freshArtifact(label: string): string {
  const dir = path.join(workdir, label);
  cpSync(baseline, dir, { recursive: true });
  return dir;
}

function migrationPath(artifact: string, name: string): string {
  return path.join(artifact, MIG_REL, name, "migration.sql");
}

function write(artifact: string, name: string, sql: string): void {
  const p = migrationPath(artifact, name);
  writeFileSync(p, sql, "utf8");
}

function codes(report: { failures: Array<{ code: string }> }): string[] {
  return report.failures.map((f) => f.code);
}

describe("§7 — DB-010: the migration artifact gate", () => {
  beforeAll(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "p12-db010-"));
    baseline = path.join(workdir, "baseline");
    materialize({ view: "proposed", out: baseline });
  }, 300_000);

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("0 — the clean Release-D artifact passes", () => {
    const report = verifyArtifact({ artifactDir: freshArtifact("clean-d"), wave: "D" });
    expect(
      report.failures,
      `the shipped artifact must be clean:\n${JSON.stringify(report.failures, null, 2)}`,
    ).toEqual([]);
    // Positive control: the gate must actually be LOOKING at destructive SQL.
    // If this ever reaches zero the suite below proves nothing.
    expect(
      report.destructiveMigrations.length,
      "the artifact genuinely contains destructive migrations; a gate that sees none is inert",
    ).toBeGreaterThan(3);
  }, 300_000);

  it("1 — a persona drop shipped WITHOUT its guard is refused", () => {
    const a = freshArtifact("i1");
    // The exact shape the previous pass found in the GHCR artifact: the
    // tracked, unguarded `DROP … CASCADE` shipped and the migration carrying
    // its guard did not. The drop's bytes are frozen — they cannot be given a
    // guard — so the ONLY thing that makes it safe is its guard travelling
    // with it, and this is what checks that.
    rmSync(
      path.join(a, MIG_REL, "20270923500000_persona_profiles_removal_precondition"),
      { recursive: true, force: true },
    );
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toContain("DECLARED_GUARD_MISSING_FROM_ARTIFACT");
  });

  it("2 — a guard placed AFTER the drop is refused", () => {
    const a = freshArtifact("i2");
    // Deliberately NOT the persona migration: that one declares an EXTERNAL
    // guard (its bytes are frozen), so the in-file ordering rule does not
    // apply to it and the injection would prove nothing.
    write(
      a,
      "20271105000000_evidence_case_id_removal",
      [
        `ALTER TABLE "evidence" DROP COLUMN "case_id";`,
        `DO $$ BEGIN`,
        `  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'x') THEN`,
        `    RAISE EXCEPTION 'too late';`,
        `  END IF;`,
        `END $$;`,
      ].join("\n"),
    );
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toContain("GUARD_AFTER_DESTRUCTIVE");
  });

  it("3 — an evidence.case_id drop with no executable readiness is refused", () => {
    const a = freshArtifact("i3");
    // Conditional, so it is a no-op where the column is absent — but it says
    // nothing about a database whose ROWS make the drop unsafe. A CONTRACT_DROP
    // must be able to REFUSE, not merely to skip.
    write(
      a,
      "20271105000000_evidence_case_id_removal",
      [
        `DO $$ BEGIN`,
        `  IF EXISTS (`,
        `    SELECT 1 FROM information_schema.columns`,
        `     WHERE table_name = 'evidence' AND column_name = 'case_id'`,
        `  ) THEN`,
        `    EXECUTE 'ALTER TABLE "evidence" DROP COLUMN "case_id"';`,
        `  END IF;`,
        `END $$;`,
      ].join("\n"),
    );
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toContain("CONTRACT_DROP_WITHOUT_READINESS_RAISE");
  });

  it("4 — a legal-hold removal with no backfill/readiness is refused", () => {
    const a = freshArtifact("i4");
    write(
      a,
      "20271108000000_legal_hold_legacy_removal",
      `DROP TABLE IF EXISTS "legal_holds" CASCADE;\nDROP TABLE IF EXISTS "case_legal_holds" CASCADE;\n`,
    );
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        "DESTRUCTIVE_WITHOUT_GUARD",
        "CONTRACT_DROP_WITHOUT_READINESS_RAISE",
      ]),
    );
  });

  it("5 — a Point-4 contract migration in Release A/B/C is refused", () => {
    // No injection needed: the SAME artifact, declared for an earlier wave.
    // That is the point — the file is fine, its PLACEMENT is not.
    for (const wave of ["A", "B", "C"] as const) {
      const report = verifyArtifact({ artifactDir: freshArtifact(`i5-${wave}`), wave });
      expect(codes(report), `wave ${wave}`).toContain("CONTRACT_IN_EARLY_WAVE");
    }
  }, 300_000);

  it("6 — a changed historical checksum is refused", () => {
    const a = freshArtifact("i6");
    const victim = "20260131235343_init";
    const original = readFileSync(migrationPath(a, victim), "utf8");
    // One byte of prose. Harmless to the schema, fatal to every database that
    // recorded the old checksum.
    write(a, victim, `${original}\n-- a comment added after the fact\n`);
    const headChecksums = {
      [victim]: createHash("sha256")
        .update(readFileSync(path.join(REPO, MIG_REL, victim, "migration.sql")))
        .digest("hex"),
    };
    const report = verifyArtifact({ artifactDir: a, wave: "D", headChecksums });
    expect(codes(report)).toContain("HISTORICAL_CHECKSUM_CHANGED");
  });

  it("7 — dynamic destructive SQL is classified, not walked past", () => {
    const a = freshArtifact("i7");
    write(
      a,
      "20271118000000_legal_hold_strict_scope_target",
      [
        `DO $$`,
        `DECLARE t TEXT := 'evidence';`,
        `BEGIN`,
        // Destructive, built from a variable. A keyword scan over the literal
        // text would miss it; the gate reads the EXECUTE body.
        `  EXECUTE format('ALTER TABLE %I DROP COLUMN legacy_col', t);`,
        `END $$;`,
      ].join("\n"),
    );
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toEqual(
      expect.arrayContaining(["DESTRUCTIVE_WITHOUT_GUARD"]),
    );
    const found = report.destructiveMigrations.find(
      (m: { name: string }) =>
        m.name === "20271118000000_legal_hold_strict_scope_target",
    );
    expect(found?.kinds).toEqual(
      expect.arrayContaining(["DYNAMIC_DROP_COLUMN"]),
    );
  });

  it("8 — a source migration missing from the image is refused", () => {
    const a = freshArtifact("i8");
    rmSync(path.join(a, MIG_REL, "20271119000000_search_document_embedding_after_extension"), {
      recursive: true,
      force: true,
    });
    const report = verifyArtifact({ artifactDir: a, wave: "D" });
    expect(codes(report)).toContain("SOURCE_MIGRATION_MISSING_FROM_ARTIFACT");
  });

  it("9 — an API/Worker inventory mismatch is refused", () => {
    const a = freshArtifact("i9");
    const report = verifyArtifact({
      artifactDir: a,
      wave: "D",
      // A Worker image that carries its own, divergent chain. Two processes
      // applying different migration sets to one database is the same
      // split-authority failure SEC-004 documented in another form.
      workerInventory: ["20260131235343_init"],
    });
    expect(codes(report)).toContain("API_WORKER_INVENTORY_MISMATCH");
  });

  it("10 — a floating image identity is refused", () => {
    const a = freshArtifact("i10");
    for (const tag of ["latest", "main", "v1.2.3", ""]) {
      const report = verifyArtifact({ artifactDir: a, wave: "D", imageTag: tag });
      expect(codes(report), `tag "${tag}"`).toContain("FLOATING_IMAGE_IDENTITY");
    }
    // …and an immutable one is accepted.
    const ok = verifyArtifact({
      artifactDir: a,
      wave: "D",
      imageTag: "a".repeat(40),
    });
    expect(codes(ok)).not.toContain("FLOATING_IMAGE_IDENTITY");
    const digest = verifyArtifact({
      artifactDir: a,
      wave: "D",
      imageTag: `sha256:${"b".repeat(64)}`,
    });
    expect(codes(digest)).not.toContain("FLOATING_IMAGE_IDENTITY");
  }, 120_000);

  it("the compose file cannot resolve a floating tag", () => {
    // The production compose already refuses an unset IMAGE_TAG. This pins
    // that it also refuses to DEFAULT one, which is how ":latest" gets in.
    const compose = readFileSync(
      path.join(REPO, "infra/docker/docker-compose.prod.yml"),
      "utf8",
    );
    for (const line of compose.split("\n")) {
      if (!/^\s*image:\s*ghcr\.io/.test(line)) continue;
      expect(
        line,
        "a release image must interpolate a required IMAGE_TAG, never default one",
      ).toMatch(/\$\{IMAGE_TAG:\?/);
      expect(line).not.toMatch(/:latest\b(?!.*not permitted)/);
    }
  });
});
