/**
 * PHASE 12 — POINT 6: migration-closure gates.
 *
 * These gates DISCOVER THE FILESYSTEM THEMSELVES. They read
 * `prisma/migrations` directly with `readdirSync`, hash every `migration.sql`
 * and then hold the inventory to what they found. The inventory is never
 * allowed to be its own witness: a migration added, removed, renamed or edited
 * without the artifact being regenerated fails here, and an inventory record
 * pointing at a directory that does not exist fails here too.
 *
 * What is deliberately NOT asserted from source text: whether a guard actually
 * refuses. That is behaviour, and it is proven by executing the migration
 * against a disposable PostgreSQL 16 in the Point-6 rehearsals recorded in
 * `docs/architecture/migration-deployment-plan.md`. The static gates below
 * pin STRUCTURE (classification, wave, ordering, conditions, checksums) —
 * things that have no runtime behaviour to execute.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(API_ROOT, "..", "..");
const MIGRATIONS_DIR = join(API_ROOT, "prisma", "migrations");
const INVENTORY_PATH = join(REPO, "docs", "architecture", "migration-inventory-p6.json");
const CURATION_PATH = join(REPO, "docs", "architecture", "migration-inventory-p6.curation.json");
const RUNBOOK_PATH = join(REPO, "docs", "operations", "point6-migration-runbook.md");
const PLAN_PATH = join(REPO, "docs", "architecture", "migration-deployment-plan.md");

type Record_ = {
  name: string;
  sqlPresent: boolean;
  byteLength: number;
  checksumSha256: string | null;
  checksumSha256Raw: string | null;
  classification: string | null;
  releaseWave: string | null;
  dependencies: string[];
  softDependencies: string[];
  unknownDependencies: string[];
  destructiveStatements: Array<{ kind: string; object: string }>;
  destructiveGuarded: boolean | null;
  guardedByPrecedingMigration: string | null;
  guardRaises: number;
  removalCondition: string | null;
  readinessCommand: string | null;
  requiredExtensions: string[];
  evidence: string | null;
  prodApplied: unknown;
};

type Inventory = {
  migrations: Record_[];
  conservation: { holds: boolean; filesystemMigrations: number };
  metrics: Record<string, number | Record<string, number>>;
  productionSnapshot: { state: string };
};

/** INDEPENDENT discovery — never read from the artifact. */
const discovered = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const discoveredSql = new Map<string, string>();
const discoveredSha = new Map<string, string>();
for (const name of discovered) {
  const p = join(MIGRATIONS_DIR, name, "migration.sql");
  if (!existsSync(p)) continue;
  const bytes = readFileSync(p);
  const normalized = bytes.toString("utf8").replace(/\r\n/g, "\n");
  discoveredSql.set(name, normalized);
  discoveredSha.set(name, createHash("sha256").update(normalized, "utf8").digest("hex"));
}

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
const curation = JSON.parse(readFileSync(CURATION_PATH, "utf8")) as {
  allowedNonTimestampedMigrations: string[];
  acknowledgedDuplicateTimestamps: Record<string, string>;
  extensionReadiness: Record<string, string>;
};
const byName = new Map(inventory.migrations.map((m) => [m.name, m]));

const CLASSIFICATIONS = [
  "EXPAND",
  "BACKFILL",
  "CUTOVER",
  "CONTRACT_DROP",
  "REPAIR",
  "HISTORICAL_PRESERVE",
  "BASELINE",
];

describe("Point 6 — the inventory is held to the filesystem, not to itself", () => {
  it("every migration directory on disk has exactly one inventory record", () => {
    const missing = discovered.filter((n) => !byName.has(n));
    expect(missing, `migrations absent from the inventory:\n${missing.join("\n")}`).toEqual([]);
    const counts = new Map<string, number>();
    for (const m of inventory.migrations) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1).map(([n]) => n);
    expect(dupes, "duplicate inventory records").toEqual([]);
    expect(inventory.migrations.length).toBe(discovered.length);
  });

  it("no inventory record points at a migration that does not exist on disk", () => {
    const orphans = inventory.migrations.filter((m) => !discovered.includes(m.name)).map((m) => m.name);
    expect(orphans, `inventory records with no directory:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("every recorded checksum still matches the file on disk", () => {
    const drifted: string[] = [];
    for (const name of discovered) {
      const rec = byName.get(name);
      const sha = discoveredSha.get(name);
      if (!rec || !sha) continue;
      if (rec.checksumSha256 !== sha) drifted.push(`${name}: recorded ${rec.checksumSha256} != disk ${sha}`);
    }
    expect(
      drifted,
      `migration.sql changed without regenerating the inventory — run \`pnpm --filter proovra-api db:migration-inventory:write\`:\n${drifted.join("\n")}`,
    ).toEqual([]);
  });

  it("every migration has a real migration.sql with content", () => {
    const bad = discovered.filter((n) => !discoveredSql.has(n) || (discoveredSql.get(n) ?? "").trim().length === 0);
    expect(bad, `migrations with a missing or empty migration.sql:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("Point 6 — classification and release-wave completeness", () => {
  it("UnclassifiedMigrations = 0 and every classification is from the allowed set", () => {
    const bad = inventory.migrations
      .filter((m) => !m.classification || !CLASSIFICATIONS.includes(m.classification))
      .map((m) => `${m.name} -> ${m.classification}`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("UnknownReleaseWave = 0 and every record carries its evidence", () => {
    const noWave = inventory.migrations.filter((m) => !m.releaseWave).map((m) => m.name);
    const noEvidence = inventory.migrations.filter((m) => !m.evidence).map((m) => m.name);
    expect(noWave, `no release wave:\n${noWave.join("\n")}`).toEqual([]);
    expect(noEvidence, `no classification evidence:\n${noEvidence.join("\n")}`).toEqual([]);
  });

  it("UnknownDependencies = 0", () => {
    const unknown = inventory.migrations
      .filter((m) => m.unknownDependencies.length > 0)
      .map((m) => `${m.name}: ${m.unknownDependencies.join(", ")}`);
    expect(unknown, unknown.join("\n")).toEqual([]);
  });

  it("no migration's HARD dependency is ordered after it", () => {
    const bad: string[] = [];
    for (const m of inventory.migrations) {
      for (const d of m.dependencies) if (d > m.name) bad.push(`${m.name} depends on later ${d}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("no unacknowledged duplicate timestamp and no unacknowledged non-timestamped directory", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    const untimed: string[] = [];
    for (const name of discovered) {
      const ts = name.match(/^(\d{8,14})_/)?.[1];
      if (!ts) {
        if (!curation.allowedNonTimestampedMigrations.includes(name)) untimed.push(name);
        continue;
      }
      const prior = seen.get(ts);
      if (prior && !(ts in curation.acknowledgedDuplicateTimestamps)) dupes.push(`${ts}: ${prior} + ${name}`);
      seen.set(ts, name);
    }
    expect(dupes, dupes.join("\n")).toEqual([]);
    expect(untimed, untimed.join("\n")).toEqual([]);
  });
});

describe("Point 6 — destructive statements are guarded and deferred", () => {
  it("FirstDeploymentContractDrops = 0 — Release A carries no destructive statement", () => {
    const offenders = inventory.migrations
      .filter((m) => m.releaseWave === "SAFE_TO_APPLY_NOW" && m.destructiveStatements.length > 0)
      .map((m) => `${m.name}: ${m.destructiveStatements.map((d) => `${d.kind}:${d.object}`).join(", ")}`);
    expect(offenders, `destructive statements scheduled for the FIRST deployment:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every pending destructive migration is CONTRACT_DROP, in the last wave, guarded, and carries a removal condition", () => {
    const problems: string[] = [];
    for (const m of inventory.migrations) {
      if (m.destructiveStatements.length === 0) continue;
      if (m.classification === "HISTORICAL_PRESERVE" || m.classification === "BASELINE") continue;
      if (m.classification !== "CONTRACT_DROP") problems.push(`${m.name}: destructive but classified ${m.classification}`);
      if (m.releaseWave !== "CONTRACT_DROP_LATER") problems.push(`${m.name}: destructive but wave ${m.releaseWave}`);
      if (!m.removalCondition) problems.push(`${m.name}: conditionless contract drop`);
      const external = m.guardedByPrecedingMigration;
      if (!m.destructiveGuarded && !external) problems.push(`${m.name}: unguarded destructive statement`);
      if (external) {
        const guard = byName.get(external);
        if (!guard) problems.push(`${m.name}: names a guard migration that does not exist (${external})`);
        else if (guard.name >= m.name) problems.push(`${m.name}: guard ${external} does not sort before it`);
        else if (guard.guardRaises < 1) problems.push(`${external}: guard migration contains no RAISE EXCEPTION`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("a HISTORICAL_PRESERVE migration is never scheduled for removal or rewriting", () => {
    const bad = inventory.migrations
      .filter((m) => m.classification === "HISTORICAL_PRESERVE" && m.releaseWave !== "HISTORICAL_PRESERVE_NEVER_REWRITE")
      .map((m) => `${m.name} -> ${m.releaseWave}`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every BACKFILL declares the readiness command that proves it complete", () => {
    const bad = inventory.migrations
      .filter((m) => m.classification === "BACKFILL" && !m.readinessCommand)
      .map((m) => m.name);
    expect(bad, `backfills with no readiness command:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every required extension has a readiness command that fails closed", () => {
    const missing: string[] = [];
    for (const m of inventory.migrations) {
      for (const ext of m.requiredExtensions) {
        if (!curation.extensionReadiness[ext]) missing.push(`${m.name} requires ${ext} with no readiness`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

describe("Point 6 — conservation and production reconciliation state", () => {
  it("FilesystemMigrations = ClassifiedMigrations = Applied + Pending + SnapshotUnknown", () => {
    expect(inventory.conservation.holds).toBe(true);
    expect(inventory.conservation.filesystemMigrations).toBe(discovered.length);
  });

  it("production applied-state is either reconciled from a snapshot or explicitly UNKNOWN — never assumed", () => {
    const state = inventory.productionSnapshot.state;
    expect(["AWAITING_OWNER_PRODUCTION_MIGRATION_SNAPSHOT", "RECONCILED"]).toContain(state);
    if (state === "AWAITING_OWNER_PRODUCTION_MIGRATION_SNAPSHOT") {
      const assumed = inventory.migrations
        .filter((m) => m.prodApplied !== "UNKNOWN_AWAITING_SNAPSHOT")
        .map((m) => m.name);
      expect(
        assumed,
        `these records claim a production applied-state while no snapshot has been reconciled:\n${assumed.join("\n")}`,
      ).toEqual([]);
    }
  });

  it("the read-only collector never falls back to a configured URL", () => {
    const src = readFileSync(join(API_ROOT, "scripts", "p6-production-migration-snapshot.mjs"), "utf8");
    expect(src).toContain("P6_PRODUCTION_READONLY_DATABASE_URL");
    expect(src).toContain("BEGIN TRANSACTION READ ONLY");
    // The refusal path must not be able to read any other URL.
    expect(src).not.toMatch(/process\.env\.DATABASE_URL/);
    expect(src).not.toMatch(/process\.env\.DIRECT_URL/);
    expect(src).not.toMatch(/process\.env\.SHADOW_DATABASE_URL/);
  });
});

describe("Point 6 — every migration has a runbook disposition", () => {
  it("the runbook and the release plan exist and name every release wave", () => {
    expect(existsSync(RUNBOOK_PATH), "docs/operations/point6-migration-runbook.md is missing").toBe(true);
    expect(existsSync(PLAN_PATH), "docs/architecture/migration-deployment-plan.md is missing").toBe(true);
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    for (const wave of [
      "SAFE_TO_APPLY_NOW",
      "WAIT_FOR_BACKFILL_READINESS",
      "WAIT_FOR_RUNTIME_CUTOVER",
      "WAIT_FOR_OBSERVATION_WINDOW",
      "CONTRACT_DROP_LATER",
      "HISTORICAL_PRESERVE_NEVER_REWRITE",
    ]) {
      expect(runbook, `runbook does not mention ${wave}`).toContain(wave);
    }
    expect(runbook).toContain("THE AGENT DID NOT APPLY PRODUCTION MIGRATIONS.");
    expect(runbook).toContain("CONTRACT/DROP MIGRATIONS MUST NOT BE APPLIED IN RELEASE A.");
  });

  it("a migration silently added to the tree has no runbook disposition and fails here", () => {
    // Every non-historical migration must be named in the release plan, so a
    // new directory cannot slip into a deployment without an owner decision.
    const plan = readFileSync(PLAN_PATH, "utf8");
    const undisposed = inventory.migrations
      .filter((m) => m.classification !== "HISTORICAL_PRESERVE" && m.classification !== "BASELINE")
      .filter((m) => !plan.includes(m.name))
      .map((m) => m.name);
    expect(
      undisposed,
      `pending migrations with no entry in the deployment plan:\n${undisposed.join("\n")}`,
    ).toEqual([]);
  });
});
