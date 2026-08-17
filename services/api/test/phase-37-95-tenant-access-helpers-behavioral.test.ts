/**
 * PHASE 37.95 — tenant access helpers: REMOVED (LEGACY-003, 2026-08-15).
 *
 * This file used to prove, against a mocked Prisma and a mocked authorize
 * middleware, that `requireEvidenceAccess` / `requireCaseAccess` /
 * `requireReportAccess` / `requirePackageAccess` / `requireActiveSpaceAccess`
 * in `src/services/access/tenant-access.helpers.ts` refused cross-tenant
 * access: 404 for a missing resource, 404 (anti-enumeration) for a
 * non-member, and authorization against the DB-resolved teamId rather than
 * the client's claim.
 *
 * LEGACY-003 REMOVED that module. It was a PARALLEL AUTHORIZATION AUTHORITY:
 * it re-derived access from raw membership rows while `authorizeOrFail` is
 * canonical (ACTIVE membership + Organization lifecycle + capability +
 * fail-closed + anti-enumeration), and it had zero importers — no route ever
 * called it. A second authority that nothing calls is the exact shape the
 * Phase-1 authorization closure removed everywhere else; the danger was that
 * one route would eventually reach for it and get a weaker answer.
 *
 * No production behaviour lost a check, and no coverage was silently dropped:
 * the refusals this file asserted against mocks are proven against the REAL
 * Fastify app on a disposable PostgreSQL by the canonical guard's own suite
 * (NEW-005 — all 48 guard registrations × eleven refusal families, including
 * SUSPENDED, REVOKED, deleted, expired access, expired/revoked grant,
 * suspended workspace, suspended parent Organization, cross-workspace grant,
 * wrong tier and stale pointer). Those are stronger than the mocked
 * equivalents removed here, because they run the real middleware.
 *
 * What remains is the invariant the removal creates: the parallel authority
 * stays gone. `scripts/verify-module-reachability.mjs` holds the general
 * contract (see phase-12-legacy-003-module-reachability.test.ts); this file
 * keeps the named assertion where a reader looking for these helpers will
 * find it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_SRC = resolve(__dirname, "../src");

describe("Phase 37.95 — tenant access helpers stay removed", () => {
  it("the parallel tenant-access authority is not back on disk", () => {
    expect(
      existsSync(join(API_SRC, "services/access/tenant-access.helpers.ts")),
      "tenant-access.helpers.ts is REMOVED (LEGACY-003) and must not return",
    ).toBe(false);
  });

  it("no production module imports the removed helpers", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          if (/from\s+["'][^"']*tenant-access\.helpers(\.js)?["']/.test(readFileSync(full, "utf8"))) {
            offenders.push(full);
          }
        }
      }
    };
    walk(API_SRC);
    expect(offenders).toEqual([]);
  });
});
