/**
 * MEDIA INTELLIGENCE — the controls are not dead.
 *
 * WHAT WAS WRONG IN PRODUCTION
 * ---------------------------------------------------------------------------
 * `Run analyzer` appeared to do nothing. The request was real and the backend
 * was fine — `POST /v1/evidence/:id/media-intelligence/run` authorizes through
 * `authorizeOrFail`, creates an idempotent run row and enqueues a BullMQ job —
 * but the client threw the whole outcome away:
 *
 *   onRunAnalyzer={async () => { await runAsync(); }}   // result discarded
 *   running={state.loading}                             // the LIST-FETCH flag,
 *                                                       // which runAsync never sets
 *
 * So there was no pending state, `{ ok: false, reason }` never surfaced, a
 * `queued: false` response (queue down, run left PENDING) read as success, and
 * nothing refreshed afterwards because polling was off by default. Acknowledge
 * and Dismiss were `void ack(...)`: no pending state, no duplicate protection,
 * no error path, and the rendered status came from an optimistic local edit
 * rather than from what was persisted.
 *
 * These tests drive the REAL panel against a mocked transport and assert the
 * request actually goes out, the state actually changes, and a failure is
 * actually reported. A restyled dead button passes none of them.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
/** Per-path queue of responses; a function may throw to simulate a failure. */
let responders: Record<string, (body: unknown) => unknown> = {};

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    const key = Object.keys(responders).find((k) => path.includes(k));
    if (!key) return {};
    return responders[key](body);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

import MediaIntelligencePanel from "../../components/media-intelligence/MediaIntelligencePanel";

const EVIDENCE_ID = "ev-mi-1";
const TEAM_ID = "team-mi-1";

function signal(over: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    signalType: "GENERIC_MIME",
    severity: "REVIEW_RECOMMENDED",
    confidence: "HIGH",
    status: "PENDING",
    safeSummary: "The recorded MIME type is generic.",
    createdAtUtc: "2026-07-04T03:47:43Z",
    acknowledgedAtUtc: null,
    ...over,
  };
}

const listResponse = (signals: unknown[], latestRun: unknown = null) => ({
  evidenceId: EVIDENCE_ID,
  signals,
  catalog: [],
  derivedAssets: [],
  analyzerAvailable: true,
  latestRun,
});

/** A run row as the API projects it. */
const runRow = (status: string, over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  status,
  attemptCount: 1,
  startedAtUtc: status === "PENDING" ? null : "2026-07-04T03:47:43Z",
  completedAtUtc: status === "COMPLETED" ? "2026-07-04T03:48:10Z" : null,
  lastError: null,
  ...over,
});

function mount() {
  return render(<MediaIntelligencePanel evidenceId={EVIDENCE_ID} teamId={TEAM_ID} />);
}

beforeEach(() => {
  calls = [];
  responders = {
    "/media-intelligence/run": () => ({
      evidenceId: EVIDENCE_ID,
      mode: "async",
      queued: true,
      runId: "run-1",
      jobId: "job-1",
    }),
    "/media-intelligence?": () => listResponse([signal()]),
    "/action": () => ({ ok: true }),
    "/derived-assets": () => ({ evidenceId: EVIDENCE_ID, assets: [] }),
  };
});

const runButton = () =>
  screen.getByRole("button", { name: /run analyzer|queued|running/i });
const runState = () =>
  document.querySelector("[data-media-intelligence-run-state]")?.getAttribute(
    "data-media-intelligence-run-state",
  );

// ---------------------------------------------------------------------------
// Run analyzer
// ---------------------------------------------------------------------------

describe("Run analyzer — a lifecycle with a terminal outcome", () => {
  it("issues the run request and reports it queued", async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());

    await act(async () => {
      runButton().click();
    });

    const run = calls.find((c) => c.path.includes("/media-intelligence/run"));
    expect(run, "the run endpoint must actually be called").toBeTruthy();
    expect(run!.method).toBe("POST");
    // The tenant goes with the request; the server authorizes on it.
    expect(run!.body).toMatchObject({ teamId: TEAM_ID, async: true });

    await waitFor(() => expect(runState()).toBe("queued"));
  });

  it("a queued run becomes running when the worker claims it", { timeout: 20_000 }, async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });
    await waitFor(() => expect(runState()).toBe("queued"));

    // The worker claims the row.
    responders["/media-intelligence?"] = () => listResponse([signal()], runRow("PROCESSING"));
    await waitFor(() => expect(runState()).toBe("running"), { timeout: 15_000 });
    expect(document.body.textContent).toMatch(/running/i);
  });

  it(
    "a running run becomes completed and reports what changed",
    { timeout: 20_000 },
    async () => {
      mount();
      await waitFor(() => expect(runButton()).toBeTruthy());
      await act(async () => {
        runButton().click();
      });

      responders["/media-intelligence?"] = () =>
        listResponse(
          [signal(), signal({ id: "sig-2", safeSummary: "A second observation." })],
          runRow("COMPLETED"),
        );

      await waitFor(() => expect(runState()).toBe("completed"), { timeout: 15_000 });
      expect(document.body.textContent).toMatch(/Analysis complete/i);
      // The new observation is on screen without a page reload.
      await waitFor(() => expect(document.body.textContent).toMatch(/A second observation/));
    },
  );

  it(
    "completing with ZERO new observations is still a visible completion",
    { timeout: 20_000 },
    async () => {
      // THE PRODUCTION CASE. Re-analysing an already-analysed record produces
      // no new observations, so the old count-watching logic never saw a change
      // and the panel said "still processing" forever.
      mount();
      await waitFor(() => expect(runButton()).toBeTruthy());
      await act(async () => {
        runButton().click();
      });

      responders["/media-intelligence?"] = () => listResponse([signal()], runRow("COMPLETED"));

      await waitFor(() => expect(runState()).toBe("completed"), { timeout: 15_000 });
      expect(document.body.textContent).toMatch(/No new observations/i);
      expect(document.body.textContent).not.toMatch(/still processing/i);
    },
  );

  // -------------------------------------------------------------------------
  // "No new observations; 23 recorded in total" was legitimate but ambiguous:
  // it could be read as an error, as an unfinished run, or as 23 observations
  // this run had just created. These two tests pin the DIFFERENCE between the
  // two situations that produce the same total.
  // -------------------------------------------------------------------------

  const manySignals = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      signal({ id: `sig-${i + 1}`, safeSummary: `Observation ${i + 1}.` }),
    );

  it(
    "new = 0 and total = 23 reads as a complete run that found nothing new",
    { timeout: 20_000 },
    async () => {
      // 23 observations already on the record; the re-run adds none.
      responders["/media-intelligence?"] = () => listResponse(manySignals(23));
      mount();
      await waitFor(() => expect(runButton()).toBeTruthy());
      await act(async () => {
        runButton().click();
      });
      responders["/media-intelligence?"] = () =>
        listResponse(manySignals(23), runRow("COMPLETED"));

      await waitFor(() => expect(runState()).toBe("completed"), { timeout: 15_000 });

      const result = document.querySelector("[data-media-intelligence-result]");
      expect(result, "a completed run renders a result, not a bare sentence").not.toBeNull();
      // The counts come from the completed run's projection, stated separately.
      expect(
        result!.querySelector("[data-media-intelligence-new]")!.getAttribute(
          "data-media-intelligence-new",
        ),
      ).toBe("0");
      expect(
        result!.querySelector("[data-media-intelligence-total]")!.getAttribute(
          "data-media-intelligence-total",
        ),
      ).toBe("23");
      const text = result!.textContent ?? "";
      expect(text).toMatch(/Analysis complete/);
      expect(text).toMatch(/No new observations were found\./);
      expect(text).toMatch(/23 existing observations remain available for review\./);
      // It must NOT read as 23 newly created observations.
      expect(text).not.toMatch(/23 new observations/);
      // It is a completion, not a failure and not an unfinished run.
      expect(text).not.toMatch(/error|failed|still processing/i);
      // The completion time is shown when the API provides one.
      expect(text).toMatch(/Completed /);
    },
  );

  it(
    "new = 23 and total = 23 reads as 23 observations this run recorded",
    { timeout: 20_000 },
    async () => {
      // A first run on a record with nothing on it yet.
      responders["/media-intelligence?"] = () => listResponse([]);
      mount();
      await waitFor(() => expect(runButton()).toBeTruthy());
      await act(async () => {
        runButton().click();
      });
      responders["/media-intelligence?"] = () =>
        listResponse(manySignals(23), runRow("COMPLETED"));

      await waitFor(() => expect(runState()).toBe("completed"), { timeout: 15_000 });

      const result = document.querySelector("[data-media-intelligence-result]")!;
      expect(
        result.querySelector("[data-media-intelligence-new]")!.getAttribute(
          "data-media-intelligence-new",
        ),
      ).toBe("23");
      expect(
        result.querySelector("[data-media-intelligence-total]")!.getAttribute(
          "data-media-intelligence-total",
        ),
      ).toBe("23");
      const text = result.textContent ?? "";
      expect(text).toMatch(/23 new observations were recorded\./);
      expect(text).not.toMatch(/No new observations/);
    },
  );

  it("a failed run shows the server's own reason and offers Retry", { timeout: 20_000 }, async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });

    responders["/media-intelligence?"] = () =>
      listResponse([signal()], runRow("FAILED", { lastError: "probe_timeout" }));

    await waitFor(() => expect(runState()).toBe("failed"), { timeout: 15_000 });
    expect(document.body.textContent).toMatch(/probe_timeout/);
    expect(document.querySelector("[data-media-intelligence-retry]")).not.toBeNull();
  });

  it("a refusal to start reports the reason instead of failing silently", async () => {
    responders["/media-intelligence/run"] = () => {
      throw new Error("forbidden");
    };
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });
    await waitFor(() => expect(runState()).toBe("failed"));
    expect(document.body.textContent).toMatch(/could not be started/i);
    expect(document.body.textContent).toMatch(/forbidden/i);
  });

  it("does not present an unqueued run as a success", async () => {
    responders["/media-intelligence/run"] = () => ({
      evidenceId: EVIDENCE_ID,
      mode: "async",
      queued: false,
      runId: "run-1",
      reason: "queue_unavailable",
    });
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });
    await waitFor(() => expect(runState()).toBe("failed"));
    expect(document.body.textContent).toMatch(/could not be queued/i);
  });

  it(
    "a run that never reports does not stay a fake working state",
    { timeout: 40_000 },
    async () => {
      // The run row stays PENDING forever — queued but never consumed.
      render(
        <MediaIntelligencePanel evidenceId={EVIDENCE_ID} teamId={TEAM_ID} stallAfterPolls={2} />,
      );
      await waitFor(() => expect(runButton()).toBeTruthy());
      await act(async () => {
        runButton().click();
      });
      responders["/media-intelligence?"] = () => listResponse([signal()], runRow("PENDING"));

      await waitFor(() => expect(runState()).toBe("stalled"), { timeout: 30_000 });
      expect(document.body.textContent).toMatch(/has not reported a result/i);
      // And a way to re-check, rather than a spinner with no exit.
      expect(document.querySelector("[data-media-intelligence-refresh]")).not.toBeNull();
    },
  );

  it("refuses a duplicate submission while in flight", async () => {
    let release: (v: unknown) => void = () => {};
    responders["/media-intelligence/run"] = () =>
      new Promise((res) => {
        release = res;
      });

    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });

    expect(runState()).toBe("queued");
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      runButton().click();
    });
    expect(calls.filter((c) => c.path.includes("/media-intelligence/run"))).toHaveLength(1);

    await act(async () => {
      release({ evidenceId: EVIDENCE_ID, mode: "async", queued: true, runId: "run-1" });
    });
  });

  it("fails closed without a workspace projection", async () => {
    render(<MediaIntelligencePanel evidenceId={EVIDENCE_ID} teamId={null} />);
    // No tenant, no analyzer control and no request at all.
    expect(screen.queryByRole("button", { name: /run analyzer/i })).toBeNull();
    expect(calls.filter((c) => c.path.includes("/media-intelligence"))).toHaveLength(0);
    expect(document.body.textContent).toMatch(/Workspace context is required/i);
  });
});

// ---------------------------------------------------------------------------
// Acknowledge / Dismiss
// ---------------------------------------------------------------------------

describe("Acknowledge and Dismiss — real mutations", () => {
  const ackButton = () =>
    document.querySelector<HTMLButtonElement>("[data-media-intelligence-action='acknowledge']")!;
  const dismissButton = () =>
    document.querySelector<HTMLButtonElement>("[data-media-intelligence-action='dismiss']")!;

  it("persists an acknowledgement and re-reads the server state", async () => {
    mount();
    await waitFor(() => expect(ackButton()).toBeTruthy());

    // The server reflects the change on the next read.
    let acked = false;
    responders["/action"] = () => {
      acked = true;
      return { ok: true };
    };
    responders["/media-intelligence?"] = () =>
      listResponse([signal(acked ? { status: "ACKNOWLEDGED" } : {})]);

    await act(async () => {
      ackButton().click();
    });

    const mutation = calls.find((c) => c.path.includes("/action"));
    expect(mutation, "the action endpoint must actually be called").toBeTruthy();
    expect(mutation!.method).toBe("POST");
    expect(mutation!.body).toMatchObject({ teamId: TEAM_ID, action: "ACKNOWLEDGED" });

    // And the panel re-reads rather than trusting only its optimistic edit.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path.includes("/media-intelligence?")).length,
      ).toBeGreaterThan(1),
    );
  });

  it("persists a dismissal with the right action", async () => {
    mount();
    await waitFor(() => expect(dismissButton()).toBeTruthy());
    await act(async () => {
      dismissButton().click();
    });
    expect(calls.find((c) => c.path.includes("/action"))!.body).toMatchObject({
      action: "DISMISSED",
    });
  });

  it("disables both actions while one is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    responders["/action"] = () =>
      new Promise((res) => {
        release = res;
      });

    mount();
    await waitFor(() => expect(ackButton()).toBeTruthy());
    await act(async () => {
      ackButton().click();
    });

    expect(ackButton().disabled).toBe(true);
    expect(dismissButton().disabled).toBe(true);

    // No duplicate mutation from a second click.
    await act(async () => {
      ackButton().click();
    });
    expect(calls.filter((c) => c.path.includes("/action"))).toHaveLength(1);

    await act(async () => {
      release({ ok: true });
    });
  });

  it("reports a failed mutation instead of pretending it worked", async () => {
    responders["/action"] = () => {
      throw new Error("conflict");
    };

    mount();
    await waitFor(() => expect(ackButton()).toBeTruthy());
    await act(async () => {
      ackButton().click();
    });

    await waitFor(() =>
      expect(document.querySelector("[data-media-intelligence-ack-error]")).not.toBeNull(),
    );
    expect(document.body.textContent).toMatch(/could not be acknowledged/i);
    expect(document.body.textContent).toMatch(/Nothing was changed/i);
  });
});

// ---------------------------------------------------------------------------
// Comprehension
// ---------------------------------------------------------------------------

describe("Media Intelligence — what the section says", () => {
  it("states the advisory boundary in full", async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/deterministic metadata observations/i);
    expect(text).toMatch(/advisory/i);
    expect(text).toMatch(/do not establish authenticity, factual truth, or legal admissibility/i);
  });

  it("explains what Acknowledge and Dismiss mean", async () => {
    mount();
    await waitFor(() =>
      expect(
        document.querySelector("[data-media-intelligence-action='acknowledge']"),
      ).not.toBeNull(),
    );
    const text = document.body.textContent ?? "";
    // Stated ONCE for the section, not repeated inside every observation:
    // with several open observations the same paragraph rendered every time.
    expect(text).toMatch(/marks an observation as reviewed/i);
    expect(
      document.querySelectorAll("#mi-action-help"),
      "the action help is declared once",
    ).toHaveLength(1);
    expect(text).toMatch(/does not verify the evidence/i);
    expect(text).toMatch(/does not delete the evidence or its audit history/i);
  });

  it("renders severity, confidence and workflow state as statuses, not controls", async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    const row = document.querySelector("[data-media-intelligence-statuses]")!;
    expect(row).not.toBeNull();
    // Nothing in the status region may be interactive or look clickable.
    expect(row.querySelector("button, a, [role='button'], input")).toBeNull();
    for (const chip of Array.from(row.children)) {
      expect(chip.tagName.toLowerCase()).toBe("span");
    }
  });

  it("puts open observations before resolved ones", async () => {
    responders["/media-intelligence?"] = () =>
      listResponse([
        signal({ id: "sig-open" }),
        signal({ id: "sig-ack", status: "ACKNOWLEDGED" }),
        signal({ id: "sig-dis", status: "DISMISSED" }),
      ]);

    mount();
    await waitFor(() =>
      expect(document.querySelector("[data-media-intelligence-group='open']")).not.toBeNull(),
    );

    const open = document.querySelector("[data-media-intelligence-group='open']")!;
    const resolved = document.querySelector("[data-media-intelligence-group='resolved']")!;
    expect(resolved).not.toBeNull();
    // Open first in document order.
    expect(open.compareDocumentPosition(resolved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every record is preserved — nothing deduplicated away.
    expect(open.querySelectorAll("li")).toHaveLength(1);
    expect(resolved.querySelectorAll("li")).toHaveLength(2);
  });
});
