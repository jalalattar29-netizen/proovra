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

const listResponse = (signals: unknown[]) => ({
  evidenceId: EVIDENCE_ID,
  signals,
  catalog: [],
  derivedAssets: [],
  analyzerAvailable: true,
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

const runButton = () => screen.getByRole("button", { name: /run analyzer|working/i });
const runState = () =>
  document.querySelector("[data-media-intelligence-run-state]")?.getAttribute(
    "data-media-intelligence-run-state",
  );

// ---------------------------------------------------------------------------
// Run analyzer
// ---------------------------------------------------------------------------

describe("Run analyzer — a real request with real feedback", () => {
  it("issues the run request and reports that the analysis was queued", async () => {
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

    await waitFor(() => expect(runState()).toBe("polling"));
    expect(document.body.textContent).toMatch(/Analysis queued/i);
  });

  it("shows a pending state and refuses a duplicate submission", async () => {
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

    // Pending, and the control is disabled while in flight.
    expect(runState()).toBe("pending");
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
    expect(runButton().textContent).toMatch(/working/i);

    // A second click while in flight must not produce a second request.
    await act(async () => {
      runButton().click();
    });
    expect(calls.filter((c) => c.path.includes("/media-intelligence/run"))).toHaveLength(1);

    await act(async () => {
      release({ evidenceId: EVIDENCE_ID, mode: "async", queued: true, runId: "run-1" });
    });
  });

  it("reports a refusal with the server's own reason instead of failing silently", async () => {
    responders["/media-intelligence/run"] = () => {
      throw new Error("forbidden");
    };

    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());
    await act(async () => {
      runButton().click();
    });

    await waitFor(() => expect(runState()).toBe("error"));
    expect(document.body.textContent).toMatch(/could not be started/i);
    // The server's reason is carried through, not replaced by a generic string.
    expect(document.body.textContent).toMatch(/forbidden/i);
  });

  it("does not present an unqueued run as a success", async () => {
    // 202 with queued:false — the run row exists, the queue refused it.
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

    await waitFor(() => expect(runState()).toBe("error"));
    expect(document.body.textContent).toMatch(/could not be queued/i);
  });

  it("renders the observations the run produced without a page reload", { timeout: 30_000 }, async () => {
    mount();
    await waitFor(() => expect(runButton()).toBeTruthy());

    // After the run, the server has a second observation.
    responders["/media-intelligence?"] = () =>
      listResponse([signal(), signal({ id: "sig-2", safeSummary: "A second observation." })]);

    await act(async () => {
      runButton().click();
    });
    await waitFor(() => expect(runState()).toBe("polling"));

    // The panel polls on its own — no manual reload.
    await waitFor(
      () => expect(document.body.textContent).toMatch(/A second observation/),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(runState()).toBe("done"), { timeout: 10_000 });
    expect(document.body.textContent).toMatch(/Analysis finished/i);
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
    expect(text).toMatch(/marks this observation as reviewed/i);
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
