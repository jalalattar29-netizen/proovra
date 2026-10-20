/**
 * AUD-32 (2026-10-20) — the worker refuses to start its consumers against a
 * schema older than its own code.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXPECTED_MIGRATION_HEAD, enforceSchemaHeadBeforeConsumers, schemaHeadProblem, type MigrationRow } from "../src/schema-head.js";

const MIGRATIONS = fileURLToPath(new URL("../../api/prisma/migrations", import.meta.url));

describe("AUD-32 worker schema head", () => {
  it("the expected head is the newest migration in the repository (adding one without updating this fails)", () => {
    const timestamped = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
      .map((d) => d.name)
      .sort();
    expect(EXPECTED_MIGRATION_HEAD).toBe(timestamped[timestamped.length - 1]);
  });

  const rows = (r: MigrationRow[]) => async () => r;
  const done = (name: string): MigrationRow => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null });

  it("an applied head is no problem", async () => {
    expect(await schemaHeadProblem(rows([done(EXPECTED_MIGRATION_HEAD)]))).toBeNull();
  });

  it("a database that has not applied the head is refused", async () => {
    expect(await schemaHeadProblem(rows([]))).toEqual({ kind: "HEAD_NOT_APPLIED", expected: EXPECTED_MIGRATION_HEAD });
  });

  it("a head that started but never finished, or was rolled back, is refused", async () => {
    const started: MigrationRow = { migration_name: EXPECTED_MIGRATION_HEAD, finished_at: null, rolled_back_at: null };
    const rolledBack: MigrationRow = { migration_name: EXPECTED_MIGRATION_HEAD, finished_at: new Date(), rolled_back_at: new Date() };
    expect(await schemaHeadProblem(rows([started]))).toMatchObject({ kind: "HEAD_FAILED" });
    expect(await schemaHeadProblem(rows([rolledBack]))).toMatchObject({ kind: "HEAD_FAILED" });
    // A retried migration: the failed attempt beside a finished one is applied.
    expect(await schemaHeadProblem(rows([rolledBack, done(EXPECTED_MIGRATION_HEAD)]))).toBeNull();
  });

  it("an unreadable migrations table is refused, never assumed current", async () => {
    const problem = await schemaHeadProblem(async () => {
      throw new Error('relation "_prisma_migrations" does not exist');
    });
    expect(problem).toMatchObject({ kind: "UNREADABLE" });
  });

  it("the worker asks before it registers a single consumer", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    const gate = src.indexOf("await enforceSchemaHeadBeforeConsumers(");
    const firstConsumer = src.indexOf('safeRegisterWorker("report"');
    expect(gate).toBeGreaterThan(-1);
    expect(firstConsumer).toBeGreaterThan(gate);
  });
});

describe("AUD-32 boot gate", () => {
  it("waits for a migration in progress, then starts", async () => {
    let calls = 0;
    const exits: number[] = [];
    const ok = await enforceSchemaHeadBeforeConsumers({
      readRows: async () => (++calls < 3 ? [] : [{ migration_name: EXPECTED_MIGRATION_HEAD, finished_at: new Date(), rolled_back_at: null }]),
      log: () => {},
      exit: (c) => void exits.push(c),
      sleep: async () => {},
      attempts: 5,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(exits).toEqual([]);
  });

  it("exits non-zero when the schema never reaches the head", async () => {
    const exits: number[] = [];
    const ok = await enforceSchemaHeadBeforeConsumers({
      readRows: async () => [],
      log: () => {},
      exit: (c) => void exits.push(c),
      sleep: async () => {},
      attempts: 3,
    });
    expect(ok).toBe(false);
    expect(exits).toEqual([1]);
  });
});
