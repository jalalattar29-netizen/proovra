/**
 * SCIM SYNC-FAILURE FILTERING HAPPENS ON THE SERVER, AND THE COUNT IS REAL.
 *
 * ===========================================================================
 * WHAT THIS REPLACES
 * ===========================================================================
 * The endpoint took `teamId` and `limit` and nothing else. The page asked for
 * 100 rows and rendered them, so an operator looking for token failures in a
 * workspace with more than 100 sync errors had no way to reach them, and the
 * page could not say how many there were.
 *
 * Two things had to be true for the fix to be worth anything:
 *
 *   1. the narrowing happens in the QUERY, not in the browser — otherwise the
 *      100-row cap still applies to an unfiltered window and the filter only
 *      hides rows the reader already has;
 *
 *   2. the count reflects the FILTER rather than the page, or the page is back
 *      to reporting "100 failures" when it means "the newest 100".
 *
 * These assert the contract of the pure query builder rather than booting the
 * server, so they run in the unit project and stay fast. The live behaviour is
 * covered by the browser matrix.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SCIM_FAILURE_EVENT_TYPES,
  listScimSyncFailures,
} from "../src/services/access-control/scim-reconciliation.service.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const code = (rel: string) =>
  readFileSync(resolve(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * A Prisma double that records the arguments rather than answering them.
 *
 * The question here is "what query did the service build", and a real database
 * would answer it only indirectly. Recording the call is the direct answer.
 */
function recordingClient(rows: unknown[] = [], total = 0) {
  const calls: { findMany?: unknown; count?: unknown } = {};
  return {
    calls,
    client: {
      securityEvent: {
        findMany: async (args: unknown) => {
          calls.findMany = args;
          return rows;
        },
        count: async (args: unknown) => {
          calls.count = args;
          return total;
        },
      },
    } as never,
  };
}

describe("the filter reaches the query", () => {
  it("passes eventType into the where clause", async () => {
    const { client, calls } = recordingClient();
    await listScimSyncFailures(
      { teamId: "t1", eventType: "scim_invalid_token" },
      client,
    );
    expect(calls.findMany.where.eventType).toBe("scim_invalid_token");
  });

  it("falls back to the full family when no eventType is given", async () => {
    // Not "no filter" — the endpoint only ever reports SCIM failures, and
    // dropping the `in` clause would start returning every security event.
    const { client, calls } = recordingClient();
    await listScimSyncFailures({ teamId: "t1" }, client);
    expect(calls.findMany.where.eventType).toEqual({
      in: [...SCIM_FAILURE_EVENT_TYPES],
    });
  });

  it("passes severity and sinceUtc through", async () => {
    const { client, calls } = recordingClient();
    await listScimSyncFailures(
      { teamId: "t1", severity: "HIGH", sinceUtc: "2026-01-01T00:00:00.000Z" },
      client,
    );
    expect(calls.findMany.where.severity).toBe("HIGH");
    expect(calls.findMany.where.createdAt).toEqual({
      gte: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("omits absent filters rather than sending undefined", async () => {
    // `severity: undefined` is not the same query as no severity key, and the
    // difference has bitten Prisma users before.
    const { client, calls } = recordingClient();
    await listScimSyncFailures({ teamId: "t1" }, client);
    expect("severity" in calls.findMany.where).toBe(false);
    expect("createdAt" in calls.findMany.where).toBe(false);
  });
});

describe("the count matches the rows", () => {
  it("counts with the SAME where clause the page query used", async () => {
    // A summary count built from a second, separately-written predicate is how
    // a total and its drill-down come to disagree. This repository has already
    // fixed that once, for incidents.
    const { client, calls } = recordingClient([], 7);
    await listScimSyncFailures(
      { teamId: "t1", eventType: "scim_user_create_failed", severity: "HIGH" },
      client,
    );
    expect(calls.count.where).toEqual(calls.findMany.where);
  });

  it("returns the filter total and the cap, not just the rows", async () => {
    const { client } = recordingClient([], 250);
    const r = await listScimSyncFailures({ teamId: "t1", limit: 100 }, client);
    expect(r.total).toBe(250);
    expect(r.limit).toBe(100);
    expect(r.failures).toEqual([]);
  });

  it("clamps the limit at both ends", async () => {
    const { client } = recordingClient();
    expect((await listScimSyncFailures({ teamId: "t1", limit: 0 }, client)).limit).toBe(1);
    expect((await listScimSyncFailures({ teamId: "t1", limit: 9999 }, client)).limit).toBe(200);
    expect((await listScimSyncFailures({ teamId: "t1" }, client)).limit).toBe(50);
  });
});

describe("the route validates against the service's own list", () => {
  it("uses the exported event-type enum rather than a second copy", () => {
    const src = code("routes/identity-operations-completion.routes.ts");
    expect(src).toMatch(/z\.enum\(SCIM_FAILURE_EVENT_TYPES\)/);
  });

  it("rejects an unknown filter value instead of returning nothing", () => {
    // A bad value must be a 400. Silently returning an empty list reads as
    // "there are none of those", which is a different and false statement.
    const src = code("routes/identity-operations-completion.routes.ts");
    expect(src).toMatch(/safeParse\(req\.query/);
    expect(src).toMatch(/VALIDATION_ERROR/);
  });

  it("still requires identity-admin authority for the workspace", () => {
    // Adding filters must not have moved the authorization boundary.
    const src = code("routes/identity-operations-completion.routes.ts");
    const handler = src.slice(
      src.indexOf('"/v1/scim/sync-failures"'),
      src.indexOf('"/v1/scim/sync-failures/:id/replay"'),
    );
    expect(handler).toMatch(/requireIdentityAdmin\(req, reply, q\.teamId\)/);
  });
});
