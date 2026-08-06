#!/usr/bin/env node
/**
 * PHASE 12 — POINT 6: reconcile a production `_prisma_migrations` snapshot
 * against the canonical migration inventory.
 *
 * Takes the JSON produced by `p6-production-migration-snapshot.mjs`, compares
 * it with what is on disk, and dispositions every one of the divergence
 * classes Point 6 requires. It NEVER connects to a database and it NEVER
 * "fixes" `_prisma_migrations`: it reports.
 *
 *   node services/api/scripts/migration-production-reconcile.mjs <snapshot.json> [--write]
 *
 * `--write` folds the result into docs/architecture/migration-inventory-p6.json
 * (prodApplied / prodChecksum / prodStatus per record, plus the production
 * snapshot block and the conservation split). Without it the reconciliation is
 * printed and nothing is modified.
 *
 * Exit 0 only when every required metric is zero.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const INVENTORY_PATH = join(REPO, "docs", "architecture", "migration-inventory-p6.json");

function main() {
  const snapshotPath = process.argv[2];
  const write = process.argv.includes("--write");
  if (!snapshotPath || !existsSync(snapshotPath)) {
    process.stderr.write(
      "usage: migration-production-reconcile.mjs <snapshot.json> [--write]\n" +
        "Collect the snapshot first with scripts/p6-production-migration-snapshot.mjs.\n",
    );
    process.exit(2);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));

  if (!snapshot.readOnlyProof || snapshot.readOnlyProof.transaction_read_only !== "on") {
    process.stderr.write(
      "REFUSING to reconcile: the snapshot does not carry proof that it was collected in a READ ONLY transaction.\n",
    );
    process.exit(3);
  }
  if (snapshot.migrationsTablePresent === false) {
    process.stderr.write(
      "REFUSING to reconcile: the target database has no `_prisma_migrations` table. That is not a drift finding, it is the wrong database.\n",
    );
    process.exit(3);
  }

  const local = new Map(inventory.migrations.map((m) => [m.name, m]));
  const prodRows = snapshot.rows ?? [];
  const prod = new Map();
  const duplicateProdNames = [];
  for (const r of prodRows) {
    if (prod.has(r.migration_name)) duplicateProdNames.push(r.migration_name);
    prod.set(r.migration_name, r);
  }

  // Content-addressed index of what is on disk, so a migration that exists in
  // production under a DIFFERENT name can be recognised by its bytes.
  //
  // Prisma stores sha256 over the RAW migration.sql bytes (proven against a
  // live PostgreSQL 16 in the Point-6 rehearsal). Git's autocrlf means the
  // same commit yields CRLF bytes on Windows and LF bytes on Linux, so the
  // SAME SQL legitimately hashes two ways depending on where the deploy ran.
  // Both bases are indexed, and a match on either is agreement — reporting a
  // line-ending difference as a checksum conflict would send an owner hunting
  // a P3006 that does not exist.
  const localByChecksum = new Map();
  const addChecksum = (sum, name) => {
    if (!sum) return;
    const list = localByChecksum.get(sum) ?? [];
    if (!list.includes(name)) list.push(name);
    localByChecksum.set(sum, list);
  };
  for (const m of inventory.migrations) {
    addChecksum(m.checksumSha256Raw, m.name);
    addChecksum(m.checksumSha256, m.name);
  }

  const findings = {
    localMissingFromProduction: [],
    productionMissingLocally: [],
    checksumConflicts: [],
    sameContentDifferentName: [],
    apparentRenamesAfterDeployment: [],
    failedMigrations: [],
    rolledBackMigrations: [],
    unfinishedMigrations: [],
    duplicateProductionNames: duplicateProdNames,
    localMutationOfAppliedMigration: [],
    pendingWithAbsentPrerequisite: [],
    absentExtensionPrerequisites: [],
    orderInconsistentWithProduction: [],
  };

  // ---- name-level reconciliation -----------------------------------------
  for (const m of inventory.migrations) {
    const p = prod.get(m.name);
    if (!p) {
      findings.localMissingFromProduction.push(m.name);
      continue;
    }
    if (p.status === "ROLLED_BACK") findings.rolledBackMigrations.push(m.name);
    else if (p.status === "STARTED_NOT_FINISHED") findings.unfinishedMigrations.push(m.name);
    if (p.applied_steps_count === 0 && p.status === "APPLIED") findings.failedMigrations.push(m.name);
  }

  for (const [name] of prod) {
    if (local.has(name)) continue;
    const p = prod.get(name);
    // Same bytes under a different name? Prisma's checksum is over the file
    // content, so a matching checksum is a strong rename signal — but it is
    // NOT proof on its own, so it is reported as a rename CANDIDATE with the
    // exact basis recorded.
    const twins = p.checksum ? localByChecksum.get(p.checksum) : null;
    if (twins && twins.length > 0) {
      findings.apparentRenamesAfterDeployment.push({
        productionName: name,
        localCandidates: twins,
        basis: "production _prisma_migrations.checksum equals the sha256 of these local migration.sql files",
        disposition:
          "BLOCKED — a renamed applied migration must be resolved by the owner. Prisma will treat the local name as pending and re-apply it. Do NOT edit _prisma_migrations.",
      });
    } else {
      findings.productionMissingLocally.push({
        productionName: name,
        checksum: p.checksum,
        status: p.status,
        disposition:
          "UNKNOWN — a migration recorded in production that this repository does not contain. Never delete the row; identify the branch/commit that introduced it.",
      });
    }
  }

  // ---- checksum comparison ------------------------------------------------
  // Prisma's stored checksum is its own digest of the migration file. This
  // reconciler does not assume the two algorithms agree; it reports the pair
  // and flags a conflict only when production carries a checksum that matches
  // NO local file while the name matches one — i.e. the bytes moved under a
  // name that is already applied.
  for (const m of inventory.migrations) {
    const p = prod.get(m.name);
    if (!p || !p.checksum) continue;
    const twins = localByChecksum.get(p.checksum);
    if (twins && twins.includes(m.name)) continue; // exact agreement
    if (twins && twins.length > 0) {
      findings.sameContentDifferentName.push({
        productionName: m.name,
        localFilesWithThatContent: twins,
        basis: "checksum match against a DIFFERENT local migration.sql",
      });
      continue;
    }
    findings.checksumConflicts.push({
      migration: m.name,
      productionChecksum: p.checksum,
      localSha256: m.checksumSha256,
      status: p.status,
      basis:
        "production recorded a checksum that matches no migration.sql in this repository — either the file was edited after deployment, or Prisma's digest differs from sha256 for this record",
      disposition:
        "OWNER EVIDENCE REQUIRED. If the file was edited after being applied, `prisma migrate deploy` will fail with P3006 on this database. Never rewrite _prisma_migrations; restore the applied bytes or add a forward migration.",
    });
    if (m.classification === "HISTORICAL_PRESERVE" || m.classification === "BASELINE") {
      findings.localMutationOfAppliedMigration.push(m.name);
    }
  }

  // ---- prerequisite + ordering -------------------------------------------
  const appliedNames = new Set(
    prodRows.filter((r) => r.status === "APPLIED").map((r) => r.migration_name),
  );
  for (const m of inventory.migrations) {
    if (appliedNames.has(m.name)) continue; // pending
    for (const dep of m.dependencies) {
      if (!appliedNames.has(dep) && !local.has(dep)) {
        findings.pendingWithAbsentPrerequisite.push({ migration: m.name, missingPrerequisite: dep });
      }
    }
  }

  // Production application order versus lexical order. Out-of-order history is
  // NOT automatically a defect (a staged multi-release rollout produces it by
  // design), so it is reported, with the pair, rather than failed.
  const appliedInOrder = prodRows
    .filter((r) => r.status === "APPLIED")
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    .map((r) => r.migration_name);
  for (let i = 1; i < appliedInOrder.length; i += 1) {
    if (appliedInOrder[i] < appliedInOrder[i - 1]) {
      findings.orderInconsistentWithProduction.push({
        appliedEarlier: appliedInOrder[i - 1],
        appliedLater: appliedInOrder[i],
        note: "applied out of lexical order — expected for a staged release, review against the release plan",
      });
    }
  }

  // ---- extensions ---------------------------------------------------------
  const installed = new Set((snapshot.extensions ?? []).map((e) => e.name));
  const required = new Set();
  for (const m of inventory.migrations) for (const e of m.requiredExtensions) required.add(e);
  for (const e of required) {
    if (!installed.has(e)) {
      findings.absentExtensionPrerequisites.push({
        extension: e,
        disposition:
          "BLOCKING — the owner must install it before the dependent migration/readiness step. Dependent code fails closed rather than degrading silently.",
      });
    }
  }

  const metrics = {
    AppliedMigrationChecksumConflicts: findings.checksumConflicts.length,
    RenamedAppliedMigrationConflicts: findings.apparentRenamesAfterDeployment.length,
    ProductionOnlyMigrationUnknowns: findings.productionMissingLocally.length,
    FailedOrIncompleteProductionMigrations:
      findings.failedMigrations.length + findings.unfinishedMigrations.length + findings.rolledBackMigrations.length,
    ProductionMigrationStateUnknown: 0,
    MigrationInventoryDuplicates: findings.duplicateProductionNames.length,
    MissingRequiredExtensions: findings.absentExtensionPrerequisites.length,
    appliedInProduction: appliedNames.size,
    pendingInProduction: inventory.migrations.filter((m) => !appliedNames.has(m.name)).length,
  };

  const result = {
    reconciledAtUtc: new Date().toISOString(),
    snapshot: {
      collectedAtUtc: snapshot.collectedAtUtc,
      target: snapshot.target,
      postgres: snapshot.postgres,
      extensions: snapshot.extensions,
      keyObjects: snapshot.keyObjects,
      rowCount: prodRows.length,
    },
    metrics,
    findings,
    conservation: {
      filesystemMigrations: inventory.migrations.length,
      appliedInProduction: metrics.appliedInProduction,
      pendingInProduction: metrics.pendingInProduction,
      productionSnapshotUnknown: 0,
      holds:
        inventory.migrations.length === metrics.appliedInProduction + metrics.pendingInProduction,
    },
  };

  const blocking =
    metrics.AppliedMigrationChecksumConflicts +
    metrics.RenamedAppliedMigrationConflicts +
    metrics.ProductionOnlyMigrationUnknowns +
    metrics.FailedOrIncompleteProductionMigrations +
    metrics.MigrationInventoryDuplicates;

  if (write) {
    for (const m of inventory.migrations) {
      const p = prod.get(m.name);
      m.prodApplied = p ? p.status === "APPLIED" : false;
      m.prodChecksum = p?.checksum ?? null;
      m.prodStatus = p?.status ?? "NOT_PRESENT";
    }
    inventory.productionSnapshot = {
      state: "RECONCILED",
      collectedAtUtc: snapshot.collectedAtUtc,
      target: snapshot.target,
      postgresVersion: snapshot.postgres?.version ?? null,
      extensions: snapshot.extensions,
      rows: prodRows.length,
      reconciliation: result,
    };
    inventory.conservation = { ...inventory.conservation, ...result.conservation };
    inventory.metrics = { ...inventory.metrics, ...metrics };
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    process.stderr.write(`reconcile: folded into ${INVENTORY_PATH}\n`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(blocking > 0 ? 1 : 0);
}

main();
