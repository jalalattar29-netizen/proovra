/**
 * HOTFIX — Worker startup bootstrap regression test.
 *
 * Production crash: the search-indexing processor instantiated its
 * own `new PrismaClient()` at module top-level. Because the
 * schema.prisma datasource has no `url` (Prisma reads the
 * connection via the PrismaPg driver adapter wired up in
 * `services/worker/src/db.ts`), bare `new PrismaClient()` throws
 * `PrismaClientInitializationError` at import time. That throw
 * killed the entire worker runtime — report generation,
 * verification package generation, and every queue went down.
 *
 * These tests prevent the regression by enforcing two source-level
 * invariants:
 *
 *   1. NO worker file outside `db.ts` may instantiate `new PrismaClient(...)`.
 *      Every other consumer must import the shared `prisma` from
 *      `./db.js` (or its relative path).
 *
 *   2. `index.ts` must construct every BullMQ Worker through
 *      `safeRegisterWorker(...)` so that an import-time crash in
 *      one processor cannot kill the entire runtime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKER_SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const ALL_WORKER_TS = walk(WORKER_SRC);

// =============================================================================
// PART 1 — Canonical Prisma bootstrap
// =============================================================================

describe("worker bootstrap — canonical Prisma path", () => {
  it("only `db.ts` instantiates new PrismaClient(...)", () => {
    const offenders: string[] = [];
    for (const file of ALL_WORKER_TS) {
      const src = readFileSync(file, "utf8");
      // Strip block + line comments so doc-strings explaining the
      // hotfix don't trip the regression check.
      const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      if (/new\s+PrismaClient\s*\(/.test(noComments)) {
        // Only db.ts is allowed.
        if (!file.replace(/\\/g, "/").endsWith("/src/db.ts")) {
          offenders.push(file);
        }
      }
    }
    expect(
      offenders,
      `forbidden bare PrismaClient construction in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("db.ts uses the PrismaPg driver adapter (canonical pattern)", () => {
    const dbSrc = readFileSync(join(WORKER_SRC, "db.ts"), "utf8");
    expect(dbSrc).toMatch(/import\s*\{\s*PrismaPg\s*\}\s*from\s*"@prisma\/adapter-pg"/);
    expect(dbSrc).toMatch(/new\s+PrismaClient\s*\(\s*\{\s*adapter\s*\}/);
  });

  it("search-indexing.processor.ts imports prisma from db (not constructs its own)", () => {
    const src = readFileSync(
      join(WORKER_SRC, "search-indexing.processor.ts"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });
});

// =============================================================================
// PART 2 — Startup readiness protection
// =============================================================================

describe("worker bootstrap — startup readiness protection", () => {
  const indexSrc = readFileSync(join(WORKER_SRC, "index.ts"), "utf8");

  it("declares safeRegisterWorker helper", () => {
    expect(indexSrc).toMatch(
      /function safeRegisterWorker\([\s\S]*?\): Worker \| null/,
    );
  });

  it("safeRegisterWorker wraps construction in try/catch", () => {
    const fn = indexSrc.match(
      /function safeRegisterWorker\([\s\S]*?\): Worker \| null\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/try\s*\{/);
    expect(fn!).toMatch(/\}\s*catch\s*\(err\)/);
  });

  it("safeRegisterWorker emits structured operational alert + returns null on failure", () => {
    const fn = indexSrc.match(
      /function safeRegisterWorker\([\s\S]*?\): Worker \| null\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/emitOperationalAlert/);
    expect(fn!).toMatch(/reason:\s*"processor_registration_failed"/);
    expect(fn!).toMatch(/return null/);
  });

  it("safeRegisterWorker logs success registrations (operator visibility)", () => {
    const fn = indexSrc.match(
      /function safeRegisterWorker\([\s\S]*?\): Worker \| null\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/worker\.processor_registered/);
  });

  it("ALL 4 BullMQ workers in index.ts are constructed via safeRegisterWorker (no bare new Worker)", () => {
    // Strip the inline factory arrows inside safeRegisterWorker
    // calls so we count only TOP-LEVEL bare constructions.
    const topLevel = indexSrc
      .replace(/safeRegisterWorker\([\s\S]*?\),/g, "");
    expect(topLevel).not.toMatch(/^const \w+Worker = new Worker\(/m);
  });

  it("shutdown null-checks each worker before pause/close", () => {
    // Every worker has a null guard in shutdown.
    for (const w of [
      "reportWorker",
      "otsUpgradeWorker",
      "evidencePurgeWorker",
      "searchIndexingWorker",
      "mediaIntelligenceWorker",
    ]) {
      expect(indexSrc, `${w} missing null-check in shutdown`).toMatch(
        new RegExp(`if\\s*\\(${w}\\)\\s*\\{[\\s\\S]*?await ${w}\\.close`),
      );
    }
  });

  it("media-intelligence processor is constructed via safeRegisterWorker", () => {
    expect(indexSrc).toMatch(
      /safeRegisterWorker\(\s*"media-intelligence"\s*,\s*\(\)\s*=>/,
    );
  });

  it("media-intelligence processor imports prisma from db (not constructs its own)", () => {
    const src = readFileSync(
      join(WORKER_SRC, "media-intelligence.processor.ts"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });
});

// =============================================================================
// PART 3 — Schema datasource still adapter-driven (root cause documentation)
// =============================================================================

describe("worker bootstrap — Prisma schema datasource", () => {
  it("schema.prisma datasource has NO `url` line (adapter-driven by design)", () => {
    // The root cause of the bare-PrismaClient crash is that the
    // datasource block has no url field — Prisma can only get the
    // connection from the supplied driver adapter. This test
    // documents that fact so any future schema change that adds
    // `url` AND keeps the adapter contract is reviewed deliberately.
    const schemaPath = fileURLToPath(
      new URL(
        "../../api/prisma/schema.prisma",
        import.meta.url,
      ),
    );
    const schemaSrc = readFileSync(schemaPath, "utf8");
    // Pull the datasource block.
    const datasource = schemaSrc.match(
      /datasource\s+db\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(datasource).toBeTruthy();
    // The block must NOT declare a url. (Adding one would mean
    // bare `new PrismaClient()` could work — but then the adapter
    // path in db.ts must be revisited in lockstep.)
    expect(datasource!).not.toMatch(/\burl\s*=/);
  });
});
