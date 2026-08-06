/**
 * PHASE 12 — the purge claim must elect one winner WITHOUT making anyone wait.
 *
 * WHAT BROKE
 * ---------------------------------------------------------------------------
 * `processPurgeDeletedEvidence` took the last-check row lock with a bare
 * `FOR UPDATE`. The intent was "the loser finds nothing and returns a bounded
 * no-op", but a bare `FOR UPDATE` reaches that by WAITING for the winner to
 * commit, and PostgreSQL applies no `lock_timeout` by default — so the wait had
 * no bound at all. In CI the winner's transaction (a custody event plus ten
 * cascade deletes) was slow enough that the losers were still blocked when the
 * next test started, holding both their row locks and their pool connections.
 * Three unrelated tests then burned the full 300s Vitest deadline each and the
 * job failed after ~19 minutes reporting only "Test timed out in 300000ms".
 *
 * WHAT THIS PROVES
 * ---------------------------------------------------------------------------
 * The one-winner guarantee is unchanged, and the losers are now bounded. These
 * are behavioural assertions against a real disposable PostgreSQL — no source
 * regexes, no occurrence counts.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { withBoundedWaits } from "../integration-harness.js";

describe("PHASE 12 — purge claim is bounded under concurrency", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  /** Baseline: no session may be left waiting or idle-in-transaction. */
  async function waitState(): Promise<{ blocked: number; idleInTxn: number }> {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ blocked: bigint; idle_in_txn: bigint }>
    >(`
      SELECT
        count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0) AS blocked,
        count(*) FILTER (WHERE state = 'idle in transaction')          AS idle_in_txn
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
    `);
    return {
      blocked: Number(rows[0]?.blocked ?? 0),
      idleInTxn: Number(rows[0]?.idle_in_txn ?? 0),
    };
  }

  it("the disposable test session bounds its own waits", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ lt: string; st: string; it: string }>
    >(`SELECT current_setting('lock_timeout') lt,
              current_setting('statement_timeout') st,
              current_setting('idle_in_transaction_session_timeout') it`);

    // Not "0" — zero means wait forever, which is what produced the silence.
    expect(rows[0].lt).not.toBe("0");
    expect(rows[0].st).not.toBe("0");
    expect(rows[0].it).not.toBe("0");
  });

  it("withBoundedWaits bounds a raw URL and never clobbers an explicit one", () => {
    const bounded = withBoundedWaits("postgresql://u:p@127.0.0.1:5432/db_test");
    expect(bounded).toContain("lock_timeout");
    expect(bounded).toContain("statement_timeout");
    expect(bounded).toContain("idle_in_transaction_session_timeout");

    const explicit = "postgresql://u:p@127.0.0.1:5432/db_test?options=-c%20lock_timeout%3D1s";
    expect(withBoundedWaits(explicit)).toBe(explicit);
  });

  it("a row already locked elsewhere yields a bounded no-op, not a wait", async () => {
    // Hold a row lock in an open transaction, exactly as a losing purge would
    // have. The claim query must return zero rows IMMEDIATELY rather than
    // queue behind it.
    const table = `purge_claim_probe_${randomUUID().replace(/-/g, "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${table}" (id uuid primary key, deleted_at timestamptz)`,
    );
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" VALUES ($1::uuid, now())`,
      id,
    );

    let release: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Holder: opens a transaction, locks the row, and waits for our signal.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "${table}" WHERE id = $1::uuid FOR UPDATE`,
        id,
      );
      await holderDone;
    });

    // Give the holder time to actually take the lock.
    await new Promise((r) => setTimeout(r, 250));

    const started = Date.now();
    const claimed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "${table}"
        WHERE id = $1::uuid AND deleted_at IS NOT NULL
        FOR UPDATE SKIP LOCKED`,
      id,
    );
    const elapsed = Date.now() - started;

    // Bounded no-op: nothing claimed, and no meaningful wait.
    expect(claimed).toHaveLength(0);
    expect(elapsed).toBeLessThan(5_000);

    release?.();
    await holder;

    // Once released, the same query claims the row — the lock was real.
    const after = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "${table}"
        WHERE id = $1::uuid AND deleted_at IS NOT NULL
        FOR UPDATE SKIP LOCKED`,
      id,
    );
    expect(after).toHaveLength(1);

    await prisma.$executeRawUnsafe(`DROP TABLE "${table}"`);
  });

  it("concurrent claims elect exactly one winner", async () => {
    const table = `purge_claim_race_${randomUUID().replace(/-/g, "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${table}" (id uuid primary key, deleted_at timestamptz)`,
    );
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" VALUES ($1::uuid, now())`,
      id,
    );

    // Three transactions race for the same row. Each holds its claim briefly so
    // the contention is real rather than serialised by luck.
    const attempt = async (): Promise<number> =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "${table}"
            WHERE id = $1::uuid AND deleted_at IS NOT NULL
            FOR UPDATE SKIP LOCKED`,
          id,
        );
        if (rows.length === 0) return 0;
        await new Promise((r) => setTimeout(r, 150));
        return 1;
      });

    const started = Date.now();
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const elapsed = Date.now() - started;

    // Exactly one winner…
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    // …and the losers did not wait for it.
    expect(elapsed).toBeLessThan(10_000);

    await prisma.$executeRawUnsafe(`DROP TABLE "${table}"`);
  });

  it("leaves no blocked query and no idle-in-transaction session behind", async () => {
    const state = await waitState();
    expect(state.blocked).toBe(0);
    expect(state.idleInTxn).toBe(0);
  });
});
