/**
 * DECLARED SOURCE IDENTITY — THE MIGRATION, THE RUNTIME AND THE DRILL-DOWN
 * READ ONE TABLE.
 *
 * ---------------------------------------------------------------------------
 * THE DRIFT THIS PREVENTS
 * ---------------------------------------------------------------------------
 * Three things map a legacy fingerprint to a source: the migration's backfill,
 * `resolveConditionSource` at runtime, and the group drill-down's membership
 * predicate. If they disagree, a row is stamped one way, read another and
 * grouped a third — and every one of those readings looks correct on its own.
 *
 * The registry is the authority. The other two are checked against it here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  backfillSourceIdForFingerprint,
  lifecycleForSourceId,
  OPERATIONS_SOURCE_LIFECYCLES,
  resolveConditionSource,
  UNREGISTERED_CONDITION_LIFECYCLE,
} from "@proovra/shared-runtime";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const MIGRATION_RAW = readFileSync(
  `${REPO}/services/api/prisma/migrations/20271226000000_operational_incident_source_identity/migration.sql`,
  "utf8",
);

/**
 * The migration with its `--` commentary removed.
 *
 * Every "this SQL must not contain X" assertion below has to read SQL. The
 * migration's header explains at length that it adds NO NOT NULL and touches
 * NEITHER the event nor the SLA table — so a check reading the raw file would
 * fail on the sentences documenting the very properties it is asserting.
 */
const MIGRATION = MIGRATION_RAW.replace(/^\s*--.*$/gm, "");

/** `('prefix:', 'source.id')` pairs, read out of the migration's VALUES list. */
function migrationMappings(): Array<{ prefix: string; sourceId: string }> {
  return [...MIGRATION.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map(
    (m) => ({ prefix: m[1], sourceId: m[2] }),
  );
}

/** The registry's own prefix table, in the same shape. */
function registryMappings(): Array<{ prefix: string; sourceId: string }> {
  const out: Array<{ prefix: string; sourceId: string }> = [];
  for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
    for (const p of lifecycle.legacyFingerprints) {
      if (p.kind !== "PREFIX") continue;
      out.push({ prefix: `${p.prefix}:`, sourceId: lifecycle.sourceId });
    }
  }
  return out;
}

describe("§2.3 — the backfill and the runtime agree, exactly", () => {
  it("prints the mapping table", () => {
    // eslint-disable-next-line no-console -- the mapping IS the deliverable
    console.table(registryMappings());
    expect(registryMappings().length).toBeGreaterThan(20);
  });

  it("the migration's mappings are EXACTLY the registry's", () => {
    const key = (m: { prefix: string; sourceId: string }) =>
      `${m.prefix} -> ${m.sourceId}`;
    const inMigration = migrationMappings().map(key).sort();
    const inRegistry = registryMappings().map(key).sort();
    expect(inMigration).toEqual(inRegistry);
  });

  it("every migration mapping round-trips through the runtime resolver", () => {
    for (const { prefix, sourceId } of migrationMappings()) {
      // The backfill stamps `sourceId` on any row whose fingerprint starts
      // with `prefix`. The runtime must reach the same source for a row the
      // backfill has NOT yet stamped, or a half-migrated database would show
      // two different lifecycles for two identical conditions.
      const resolved = backfillSourceIdForFingerprint(`${prefix}subject-id`);
      expect(resolved, prefix).toBe(sourceId);
      expect(lifecycleForSourceId(sourceId), sourceId).not.toBeNull();
    }
  });

  it("the migration adds a NULLABLE column and no NOT NULL constraint", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "source_id" VARCHAR\(120\)/);
    // NOT NULL is deliberately a LATER deployment: legacy rows that no pattern
    // claims must stay NULL and fail closed, and tightening in the same
    // release would refuse them instead.
    expect(MIGRATION).not.toMatch(/SET NOT NULL/i);
    expect(MIGRATION).not.toMatch(/NOT NULL/);
  });

  it("the migration rewrites NO history", () => {
    // It touches one previously-absent column on one table. Events and SLA
    // cycles are the record of what happened and are not this migration's to
    // edit — nor is any status, note, actor or occurrence count.
    expect(MIGRATION).not.toMatch(/operational_incident_events/);
    expect(MIGRATION).not.toMatch(/operational_incident_sla_cycles/);
    expect(MIGRATION).not.toMatch(/\bDELETE\b/i);
    expect(MIGRATION).not.toMatch(/\bDROP\b/i);
    for (const column of [
      "status",
      "resolved_at_utc",
      "resolved_by_user_id",
      "resolution_note",
      "acknowledged_at_utc",
      "occurrence_count",
      "first_seen_at_utc",
    ]) {
      expect(
        new RegExp(`SET[^;]*"${column}"`, "i").test(MIGRATION),
        `the backfill writes ${column}`,
      ).toBe(false);
    }
  });

  it("the backfill is guarded, so re-running it is a no-op", () => {
    expect(MIGRATION).toMatch(/WHERE "source_id" IS NULL/);
    // Anchored on the separator: `report_backlog_v2` must not inherit
    // `report_backlog`.
    for (const { prefix } of migrationMappings()) {
      expect(prefix.endsWith(":"), prefix).toBe(true);
    }
  });
});

describe("§2.3 — an ambiguous legacy row fails closed", () => {
  it("a fingerprint no pattern claims is NOT backfilled", () => {
    expect(backfillSourceIdForFingerprint("unclaimed:shape:xyz")).toBeNull();
  });

  it("…and resolves at runtime to NO_DIRECT_RESOLUTION", () => {
    const r = resolveConditionSource({
      sourceId: null,
      category: "GOVERNANCE",
      fingerprint: "unclaimed:shape:xyz",
    });
    expect(r.match).toBe("UNREGISTERED");
    expect(r.lifecycle).toBe(UNREGISTERED_CONDITION_LIFECYCLE);
    expect(r.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
  });

  it("no legacy prefix is claimed by two sources", () => {
    // The registry throws at load if one is. Stated here because the
    // CONSEQUENCE lives in this file: a prefix two sources claimed would make
    // the backfill stamp whichever the registry listed first, and the group
    // drill-down would then contain rows belonging to the other.
    const prefixes = registryMappings().map((m) => m.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("§2.1 — the scope authority composes without collisions", () => {
  it("no caller of workspaceIncidentWhere sets its own top-level AND", () => {
    // The tenant predicate now carries the PLATFORM_INTERNAL exclusion under
    // `AND`, and every caller composes it by object SPREAD. A caller that set
    // its own `AND` would silently overwrite it: the query would still run and
    // the exclusion would quietly stop applying. `workspaceIncidentWhereWith`
    // exists for callers that need one.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const files = execFileSync("git", ["ls-files", "services/api/src"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".ts"));

    const offenders: string[] = [];
    for (const rel of files) {
      if (rel.endsWith("incident-scope.ts")) continue;
      const src = readFileSync(`${REPO}/${rel}`, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const spread = lines[i].match(/^(\s*)\.\.\.workspaceIncidentWhere\(/);
        if (!spread) continue;
        const indent = spread[1];
        // SAME INDENTATION, therefore the same object literal. A key nested
        // deeper belongs to something else and cannot overwrite the spread; a
        // key at THIS level can, silently, and the query keeps working.
        //
        // Only `AND` matters: that is the key the scope authority uses. `OR`
        // and `NOT` at this level are the caller's own and collide with
        // nothing — `listIncidents` legitimately spreads an `OR`-shaped SLA
        // predicate beside it.
        for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
          const line = lines[j];
          // Dedented: the object literal has closed.
          if (line.trim() !== "" && !line.startsWith(indent)) break;
          if (line.startsWith(`${indent}AND:`)) {
            offenders.push(`${rel}:${j + 1}`);
            break;
          }
        }
      }
    }
    expect(
      offenders,
      `spread callers declaring their own top-level AND:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
