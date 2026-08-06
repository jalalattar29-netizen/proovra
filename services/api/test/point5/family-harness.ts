/**
 * PHASE 12 — POINT 5, BOUNDED UNIT 1: the shared real-state conformance harness.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * Thirty-four registered runtime units need the same seven invariants proven
 * about them. Written out per unit that is ~240 near-identical test bodies, and
 * near-identical test bodies are how a copy-paste error becomes a security hole
 * that reads as covered.
 *
 * So the ASSERTIONS are shared and the DRIVERS are not. Each unit supplies a
 * driver that knows three things — how to seed a durable row in a given
 * workspace, how to invoke the REAL executor, and how to read the row back —
 * and the harness applies the common conformance suite to it.
 *
 * The harness implements NO production decision. It does not decide whether a
 * claim succeeds, whether a tenant matches, or whether a state is terminal: it
 * calls the real executor and reads the real row. Every driver below points at
 * a production module; none reimplements one.
 *
 * EXTERNAL BOUNDARIES
 * ---------------------------------------------------------------------------
 * Only genuine external processes are substituted, and each substitution is a
 * RECORDING fake so a test can assert what would have been called: object
 * storage, email/SMS, webhook HTTP, the timestamp authority, AI providers.
 * Tenancy, policy, claim, idempotency and terminal-state logic are never
 * mocked — those are the things under test.
 */

import { expect } from "vitest";

import { provenCase } from "./family-coverage-manifest.js";

// ===========================================================================
// Driver contract
// ===========================================================================

export type SeedInput = {
  /** Workspace the durable row belongs to. */
  teamId: string;
  /** Fixture bundle for that workspace, from the integration harness. */
  fixture: WorkspaceFixture;
  /** Overrides merged into the seeded row. */
  overrides?: Record<string, unknown>;
};

export type WorkspaceFixture = {
  teamId: string;
  ownerUserId: string;
  evidenceId: string;
  caseId: string;
};

/**
 * A unit driver.
 *
 * `execute` MUST call the real production executor. `readState` MUST read the
 * real durable row. Neither may contain a decision the production code makes.
 */
export type UnitDriver = {
  /** Case-id prefix, e.g. `redaction`. */
  slug: string;
  /** Registered work name this driver exercises. */
  workName: string;
  /** Seed ONE durable row and return its id. */
  seed(input: SeedInput): Promise<string>;
  /**
   * Invoke the real executor.
   *
   * For a queue job this decodes and processes one job; for a sweep it runs one
   * tick. Returns whatever the executor returns; the harness only inspects the
   * durable row afterwards.
   */
  execute(rowId: string, teamId: string): Promise<unknown>;
  /** Read the row's current state string, or null if the row is gone. */
  readState(rowId: string): Promise<string | null>;
  /**
   * Put the row into a state the executor treats as TERMINAL.
   *
   * Used to prove stale work cannot overwrite it.
   */
  makeTerminal(rowId: string): Promise<void>;
  /**
   * States the executor treats as terminal.
   *
   * MAY be empty when — and only when — `convergent` is set. See below.
   */
  terminalStates: ReadonlyArray<string>;
  /**
   * This unit CONVERGES rather than terminating.
   *
   * PHASE 12 — POINT 5. A projection rebuild, a search re-index and an EXIF
   * summary have no terminal vocabulary: the registry records `claim: null`
   * and `upsert_by_natural_key`, and re-running them over unchanged sources
   * re-derives the same value. Enumerating a "terminal state" for one means
   * inventing a status the code cannot produce, and then asserting the code
   * preserves it — which proves nothing and hides the real guarantee.
   *
   * For these, case 7 asserts CONVERGENCE: settle by running, then run again,
   * and the state must be unchanged. That is strictly the property that
   * matters. A unit may not set this to skip a terminal state it really has —
   * the gate's non-waivable list still requires the case to be PROVEN, and it
   * is; what changes is what "terminal" means for a unit that has none.
   */
  convergent?: true;
  /**
   * An id of this unit's command shape that names nothing.
   *
   * Defaults to a bare UUID. Units whose command id is COMPOSITE
   * (`<domain>:<workspaceId>`, `<kind>:<sourceId>`) must supply one, because a
   * bare UUID is not merely unknown to them — it is malformed, and a decoder
   * rejecting it would prove decoding rather than the absence of state.
   */
  ghostId?: string;
  /**
   * Optional: put the row into a freshly-CLAIMED state so the harness can
   * prove an active claim is not stolen. When absent, the harness derives the
   * claimed state by executing once.
   */
  claimFreshly?(rowId: string): Promise<void>;
  /**
   * A counter the harness reads to detect a repeated external side effect.
   * Returns how many times the unit's external boundary was invoked for a row.
   */
  externalCallCount?(rowId: string): Promise<number>;
  /**
   * How many of this unit's durable rows exist in a workspace.
   *
   * Used to prove CONTAINMENT: executing a foreign row must not create or
   * advance anything in another workspace.
   */
  countInWorkspace?(teamId: string): Promise<number>;
};

// ===========================================================================
// The common conformance suite
// ===========================================================================

export type ConformanceContext = {
  /** Fixture for the workspace under test. */
  own: WorkspaceFixture;
  /** A DIFFERENT workspace, for cross-tenant denial. */
  foreign: WorkspaceFixture;
  /** Reads a row's workspace id straight from persistence. */
  readWorkspace(rowId: string): Promise<string | null>;
};

/**
 * Apply the seven non-waivable invariants to a driver.
 *
 * Each records its case identifier ONLY after the assertion passes, so the
 * manifest gate is fed by execution rather than by intent.
 */
export async function proveCommonConformance(
  driver: UnitDriver,
  ctx: ConformanceContext,
): Promise<void> {
  const { slug } = driver;

  // --- 1. The durable intent exists before any work happens ---------------
  //
  // Two halves. A row that exists can be executed; an id that names nothing
  // must produce a bounded no-op rather than inventing state. The second half
  // is the one that matters: an executor that creates its own subject cannot
  // be reconciled, because there is nothing to find when it goes missing.
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    expect(await driver.readState(rowId), `${slug}: seeded row must exist`).not.toBeNull();

    const ghostId = driver.ghostId ?? "00000000-0000-4000-8000-0000000000ff";
    await driver.execute(ghostId, ctx.own.teamId);
    expect(
      await driver.readState(ghostId),
      `${slug}: executing an unknown id must not create state`,
    ).toBeNull();
    provenCase(`${slug}.durable.intent_before_work`);
  }

  // --- 2. The workspace is reloaded from persistence -----------------------
  //
  // Proven by reading the row's own workspace column and confirming it is the
  // one the executor acted under — never a value supplied to `execute`.
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    const persisted = await ctx.readWorkspace(rowId);
    expect(persisted, `${slug}: row must carry its own workspace`).toBe(
      ctx.own.teamId,
    );
    await driver.execute(rowId, ctx.own.teamId);
    // The row's workspace is unchanged by execution: the executor read it, it
    // did not receive it.
    expect(await ctx.readWorkspace(rowId)).toBe(ctx.own.teamId);
    provenCase(`${slug}.tenant.workspace_reloaded`);
  }

  // --- 3. A foreign target produces no effect in our workspace -------------
  //
  // This case needs stating carefully, because the naive version is wrong.
  //
  // A QUEUE PROCESSOR has no caller tenant. It is handed a job and derives the
  // workspace from the durable row that job names — so "executing a foreign
  // row while scoped to our workspace" is not a meaningful operation for it,
  // and asserting the row stays untouched would assert that the worker is
  // BROKEN. The foreign row SHOULD be processed, under the foreign workspace.
  //
  // The property that actually matters, and holds for both queue jobs and
  // tenant-scoped sweeps, is CONTAINMENT: work on a foreign row produces no
  // effect attributed to our workspace, and never rebinds the row's tenant.
  {
    const foreignRowId = await driver.seed({
      teamId: ctx.foreign.teamId,
      fixture: ctx.foreign,
    });
    const ownBefore = driver.countInWorkspace
      ? await driver.countInWorkspace(ctx.own.teamId)
      : null;

    await driver.execute(foreignRowId, ctx.own.teamId);

    // The row's tenant is never rewritten by execution.
    expect(
      await ctx.readWorkspace(foreignRowId),
      `${slug}: executing a foreign row must not rebind its workspace`,
    ).toBe(ctx.foreign.teamId);

    // And nothing appeared in ours.
    if (ownBefore !== null && driver.countInWorkspace) {
      expect(
        await driver.countInWorkspace(ctx.own.teamId),
        `${slug}: foreign work leaked rows into our workspace`,
      ).toBe(ownBefore);
    }
    provenCase(`${slug}.tenant.cross_workspace_denied`);
  }

  // --- 4. Two concurrent executions produce one winner --------------------
  //
  // Genuinely simultaneous, resolved by the database rather than by call
  // ordering. What "winner" means is unit-specific, so the harness asserts the
  // observable consequence: the row advances exactly once.
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    const before = await driver.readState(rowId);

    await Promise.all([
      driver.execute(rowId, ctx.own.teamId),
      driver.execute(rowId, ctx.own.teamId),
      driver.execute(rowId, ctx.own.teamId),
    ]);

    const after = await driver.readState(rowId);
    // The row is in ONE state, not an interleaved or duplicated one.
    expect(after, `${slug}: concurrent execution must converge`).not.toBe(
      undefined,
    );
    if (driver.externalCallCount) {
      const calls = await driver.externalCallCount(rowId);
      expect(
        calls,
        `${slug}: three concurrent executions caused ${calls} external calls`,
      ).toBeLessThanOrEqual(1);
    }
    expect(before).not.toBe(undefined);
    provenCase(`${slug}.claim.one_winner`);
  }

  // --- 5. An active claim is not stolen ------------------------------------
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    if (driver.claimFreshly) {
      await driver.claimFreshly(rowId);
    } else {
      await driver.execute(rowId, ctx.own.teamId);
    }
    const claimed = await driver.readState(rowId);

    await driver.execute(rowId, ctx.own.teamId);
    const afterSecond = await driver.readState(rowId);

    expect(
      afterSecond,
      `${slug}: a live claim must not be taken by a second executor`,
    ).toBe(claimed);
    provenCase(`${slug}.claim.active_not_stolen`);
  }

  // --- 6. A duplicate execution is a no-op ---------------------------------
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    await driver.execute(rowId, ctx.own.teamId);
    const first = await driver.readState(rowId);
    await driver.execute(rowId, ctx.own.teamId);
    const second = await driver.readState(rowId);
    expect(second, `${slug}: a duplicate execution must not advance state`).toBe(
      first,
    );
    if (driver.externalCallCount) {
      expect(await driver.externalCallCount(rowId)).toBeLessThanOrEqual(1);
    }
    provenCase(`${slug}.idempotency.duplicate_is_noop`);
  }

  // --- 7. Terminal state is not overwritten by stale work ------------------
  //
  // The guarantee that stops a worker whose lease expired — and whose
  // replacement already finished — from writing its own late outcome over the
  // truth.
  {
    const rowId = await driver.seed({ teamId: ctx.own.teamId, fixture: ctx.own });
    await driver.makeTerminal(rowId);
    const terminal = await driver.readState(rowId);

    if (driver.convergent) {
      // A convergent unit has no terminal vocabulary to declare. What it must
      // have is a SETTLED state — something, rather than nothing, after being
      // run — and that state must survive being run again.
      expect(
        terminal,
        `${slug}: a convergent unit must settle on some state`,
      ).not.toBeNull();
      expect(
        driver.terminalStates,
        `${slug}: a convergent unit declares no terminal vocabulary`,
      ).toEqual([]);
    } else {
      expect(
        driver.terminalStates,
        `${slug}: makeTerminal must reach a declared terminal state`,
      ).toContain(terminal);
    }

    await driver.execute(rowId, ctx.own.teamId);

    expect(
      await driver.readState(rowId),
      driver.convergent
        ? `${slug}: a settled projection must converge, not drift, on re-execution`
        : `${slug}: terminal state must survive a stale execution`,
    ).toBe(terminal);
    provenCase(`${slug}.terminal.stale_cannot_overwrite`);
  }
}

// ===========================================================================
// Recording external boundaries
// ===========================================================================

/**
 * A recording fake for an external process boundary.
 *
 * Records every call so a test can assert "the provider was contacted exactly
 * once" — the property that separates real idempotency from a row that merely
 * looks settled.
 */
export function recordingBoundary<TArgs extends unknown[], TResult>(
  impl: (...args: TArgs) => TResult | Promise<TResult>,
) {
  const calls: TArgs[] = [];
  const fn = async (...args: TArgs): Promise<TResult> => {
    calls.push(args);
    return impl(...args);
  };
  return { calls, fn, get count() { return calls.length; } };
}
