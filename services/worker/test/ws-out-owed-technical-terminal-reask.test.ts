/**
 * PRO-W1-04 (WS-OUT RG-03) — an outage longer than the retry budget left a
 * finalized record without its report/package until a human acted: every
 * automatic re-ask collapsed onto the TECHNICAL terminal of the same request
 * identity.
 *
 * Behavioural: requestReportGenerationFromWorker runs against a stored latest
 * request row and a writer that behaves as the shared writer does — it mints a
 * NEW request only when asked to supersede a technical terminal, and otherwise
 * answers the terminal head. The outcome read back is whether the owed output
 * is enqueued again.
 *
 *   * allowed: an OWED re-ask after the terminal has rested 30 minutes is
 *     enqueued as a new request (report and package-only recovery);
 *   * refused: a terminal younger than the rest, a non-owed caller, and a
 *     latest row that is not FAILED_TERMINAL are not superseded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  latest: null as null | { state: string; completedAtUtc: Date | null; updatedAtUtc: Date | null },
  findFirstArgs: [] as unknown[],
  writerInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    reportGenerationRequest: {
      findFirst: async (args: unknown) => {
        state.findFirstArgs.push(args);
        return state.latest;
      },
    },
  },
}));

vi.mock("@proovra/shared-runtime/reports", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The shared writer's contract for a terminal head: supersede only when
    // asked; otherwise the caller collapses onto the terminal row.
    createReportGenerationRequest: async (_client: unknown, input: Record<string, unknown>) => {
      state.writerInputs.push(input);
      if (state.latest?.state === "FAILED_TERMINAL" && input.supersedeTechnicalTerminal !== true) {
        return { created: true, requestId: "terminal-head", state: "FAILED_TERMINAL" };
      }
      return { created: true, requestId: "new-request", state: "QUEUED" };
    },
  };
});

import {
  OWED_TECHNICAL_RETRY_BACKOFF_MS,
  requestReportGenerationFromWorker,
} from "../src/report-generation-authority.js";

const EVIDENCE = "44444444-4444-4444-8444-444444444444";
const MIN = 60 * 1000;

function ask(extra: Record<string, unknown> = {}) {
  const enqueued: string[] = [];
  const run = requestReportGenerationFromWorker({
    evidenceId: EVIDENCE,
    purpose: "first_issuance",
    machineId: "worker.first-issuance",
    enqueue: async (id: string) => {
      enqueued.push(id);
      return { enqueued: true };
    },
    ...extra,
  } as never);
  return run.then((res) => ({ res, enqueued }));
}

const terminalAgo = (ms: number) => ({
  state: "FAILED_TERMINAL",
  completedAtUtc: new Date(Date.now() - ms),
  updatedAtUtc: new Date(Date.now() - ms),
});

beforeEach(() => {
  state.latest = null;
  state.findFirstArgs.length = 0;
  state.writerInputs.length = 0;
});

describe("PRO-W1-04 — an owed output is re-asked after a technical terminal has rested", () => {
  it("the rest is 30 minutes", () => {
    expect(OWED_TECHNICAL_RETRY_BACKOFF_MS).toBe(30 * MIN);
  });

  it("allowed: an owed first issuance whose terminal rested 31 minutes is enqueued as a new request", async () => {
    state.latest = terminalAgo(31 * MIN);
    const { res, enqueued } = await ask({ owed: true });
    expect(res).toMatchObject({ enqueued: true, requestId: "new-request" });
    expect(enqueued).toEqual(["new-request"]);
  });

  it("allowed: owed package-only recovery for a report version is superseded on that version's history", async () => {
    state.latest = terminalAgo(45 * MIN);
    const { res, enqueued } = await ask({ owed: true, purpose: "package_recovery", packageForReportVersion: 3 });
    expect(res.enqueued).toBe(true);
    expect(enqueued).toEqual(["new-request"]);
    expect(JSON.stringify(state.findFirstArgs[0])).toContain("VERIFICATION_PACKAGE");
    expect(JSON.stringify(state.findFirstArgs[0])).toContain('"reportVersion":3');
  });

  it("refused: a terminal younger than the rest collapses onto it (nothing enqueued)", async () => {
    state.latest = terminalAgo(10 * MIN);
    const { res, enqueued } = await ask({ owed: true });
    expect(res).toMatchObject({ enqueued: false, reason: "already_terminal" });
    expect(enqueued).toEqual([]);
  });

  it("refused: a caller that is not owed never supersedes, however old the terminal", async () => {
    state.latest = terminalAgo(24 * 60 * MIN);
    const { res, enqueued } = await ask({});
    expect(res).toMatchObject({ enqueued: false, reason: "already_terminal" });
    expect(enqueued).toEqual([]);
  });

  it("refused: a latest row that is not FAILED_TERMINAL is not superseded", async () => {
    state.latest = { state: "SUCCEEDED", completedAtUtc: new Date(Date.now() - 60 * MIN), updatedAtUtc: null };
    await ask({ owed: true });
    expect(state.writerInputs[0]?.supersedeTechnicalTerminal).toBe(false);
  });
});
