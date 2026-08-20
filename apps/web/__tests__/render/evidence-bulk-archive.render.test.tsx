/**
 * EVIDENCE LIBRARY — the Archive bulk action actually archives.
 *
 * WHAT WAS WRONG IN PRODUCTION
 * ---------------------------------------------------------------------------
 * Select records → Archive → Run Bulk Action → confirmation dialog → press
 * `Archive` → nothing. No error, no result, no refresh; the dialog just sat
 * there.
 *
 * The confirm button WAS wired and the request WAS issued. What was missing
 * was every path after it:
 *
 *   const runAction = async () => {
 *     setRunning(true);
 *     try { ...await onRun(...) } finally { setRunning(false) }   // no catch
 *   };
 *
 * `onRun` (the page's `runBulkAction`) awaits the mutation AND THEN a list
 * reload and a detail reload. A rejection anywhere in that chain — a 403 on
 * the mutation, or a perfectly successful archive followed by a failing list
 * refresh — propagated out of an `onClick={() => void runAction()}` with no
 * catch: an unhandled rejection, an unchanged dialog, and no way for the
 * operator to tell whether anything had happened.
 *
 * These tests drive the REAL page against a transport double answering the
 * REAL `/v1/evidence/bulk` contract with fictional records, and assert on what
 * was actually sent and what the operator is actually shown.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor, within } from "@testing-library/react";

type Call = { path: string; method: string; body: unknown };

const H = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  /** Records the list endpoint returns. */
  rows: [] as Array<Record<string, unknown>>,
  /** Per-path failures: `${method} ${path}` or bare path. */
  failures: {} as Record<string, { statusCode?: number; code?: string; message?: string }>,
  /** Overrides the bulk response when set. */
  bulkResponse: null as null | ((body: Record<string, unknown>) => unknown),
  /** Resolves the bulk call only when released. */
  gateBulk: null as null | { promise: Promise<void>; release: () => void },
}));

function pathOf(url: string): string {
  return url.split("?")[0];
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = pathOf(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    H.calls.push({ path, method, body });

    const failure = H.failures[`${method} ${path}`] ?? H.failures[path];
    if (failure) {
      throw Object.assign(new Error(failure.message ?? "denied"), failure);
    }

    if (path === "/v1/evidence/bulk") {
      if (H.gateBulk) await H.gateBulk.promise;
      const request = (body ?? {}) as { action: string; evidenceIds: string[] };
      if (H.bulkResponse) return H.bulkResponse(request as Record<string, unknown>);
      const results = request.evidenceIds.map((id) => ({ evidenceId: id, ok: true }));
      // The server archives, so the rows it echoes back carry archivedAt and
      // leave the Active scope.
      for (const id of request.evidenceIds) {
        const row = H.rows.find((r) => r.id === id);
        if (row) row.archivedAt = "2026-08-20T10:00:00.000Z";
      }
      return {
        successCount: results.length,
        failedCount: 0,
        results,
        items: H.rows.filter((r) => request.evidenceIds.includes(r.id as string)),
      };
    }
    if (path === "/v1/evidence") {
      const active = H.rows.filter((r) => !r.archivedAt && !r.deletedAt);
      return { items: active, pageInfo: { hasMore: false, nextCursor: null }, totalCount: active.length };
    }
    if (path === "/v1/evidence/library-summary") {
      const active = H.rows.filter((r) => !r.archivedAt && !r.deletedAt);
      return { totals: { all: active.length } };
    }
    if (path === "/v1/evidence/saved-views") return { views: [] };
    if (path === "/v1/cases") return { items: [] };
    if (path === "/v1/billing/overview") return { plan: { tier: "PRO" } };
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {
    statusCode = 500;
    code = "ERR";
  },
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/evidence",
}));

import EvidenceLibraryPage from "../../app/(app)/evidence/page";
import { PlatformContextProvider } from "../../lib/platform-context";
import { ToastProvider } from "../../components/ui";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

/** A minimal READY envelope: one owned workspace that may view evidence. */
const ENVELOPE = {
  authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
  navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
  workspace: { id: "ws-A", name: "Fictional workspace", status: "active", scope: "OWNED" },
  activeSpace: { type: "ORGANIZATION", id: "ws-A", displayName: "Fictional workspace", roleLabel: "Owner" },
  capabilities: { EVIDENCE_VIEW: true, EVIDENCE_ARCHIVE: true, EVIDENCE_DELETE: true },
  account: { accountPlan: "PRO", accountStatus: "active" },
  contextOptions: {
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [],
    activeContext: { workspaceId: "ws-A", kind: "OWNED", organizationId: null, displayName: "Fictional workspace" },
  },
  diagnostics: { requestId: "t" },
};

// ---------------------------------------------------------------------------
// Fictional, contract-valid records.
// ---------------------------------------------------------------------------
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function record(n: number, over: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    title: `Fictional record ${n}`,
    displayFileName: `record-${n}.jpg`,
    originalFileName: `record-${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: "184320",
    status: "SIGNED",
    createdAt: "2026-08-01T09:00:00.000Z",
    capturedAtUtc: "2026-08-01T08:59:00.000Z",
    archivedAt: null,
    deletedAt: null,
    retentionUntilUtc: null,
    legalHold: false,
    caseIds: [],
    teamId: null,
    ...over,
  };
}

function seed(count: number, over: (n: number) => Record<string, unknown> = () => ({})) {
  H.rows = Array.from({ length: count }, (_, i) => record(i + 1, over(i + 1)));
}

async function mountLibrary() {
  const view = render(
    <PlatformContextProvider testEnvelope={ENVELOPE as never}>
      <ToastProvider>
        <EvidenceLibraryPage />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await waitFor(() => expect(document.querySelectorAll("[data-evidence-row]").length).toBeGreaterThan(0));
  return view;
}

/** Ticks the checkbox on the first `count` rows. */
async function selectRows(count: number) {
  const boxes = Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-evidence-row] input[type='checkbox']"),
  ).slice(0, count);
  await act(async () => {
    for (const box of boxes) {
      box.click();
    }
  });
  return boxes;
}

const runBulkButton = () =>
  document.querySelector<HTMLButtonElement>("[data-evidence-run-bulk]")!;

const confirmDialog = () =>
  document.querySelector<HTMLElement>("[data-matter-modal='evidence-bulk-confirm']");

const confirmArchive = () =>
  within(confirmDialog()!).getByRole("button", { name: /^archiv/i }) as HTMLButtonElement;

async function openConfirm(count: number) {
  await mountLibrary();
  await selectRows(count);
  await act(async () => {
    runBulkButton().click();
  });
  await waitFor(() => expect(confirmDialog()).not.toBeNull());
}

const bulkCalls = (): Call[] => H.calls.filter((c) => c.path === "/v1/evidence/bulk");

beforeEach(() => {
  H.calls = [];
  H.failures = {};
  H.bulkResponse = null;
  H.gateBulk = null;
  seed(3);
});

// ---------------------------------------------------------------------------
// The request actually goes out, once, with every selected id
// ---------------------------------------------------------------------------

describe("Archive bulk action — the request", () => {
  it("sends ARCHIVE with every selected id exactly once", async () => {
    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });

    await waitFor(() => expect(bulkCalls().length).toBe(1));
    const call = bulkCalls()[0]!;
    expect(call.method).toBe("POST");
    const body = call.body as { action: string; evidenceIds: string[] };
    expect(body.action).toBe("ARCHIVE");
    expect(body.evidenceIds).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(new Set(body.evidenceIds).size).toBe(body.evidenceIds.length);
  });

  it("carries all 50 selected records in one request", async () => {
    seed(50);
    await openConfirm(50);
    await act(async () => {
      confirmArchive().click();
    });
    await waitFor(() => expect(bulkCalls().length).toBe(1));
    const body = bulkCalls()[0]!.body as { evidenceIds: string[] };
    expect(body.evidenceIds.length).toBe(50);
  });

  it("a second click while the first is in flight does not issue a second request", async () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.gateBulk = { promise, release };

    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });
    // Pending: the control is disabled and says so.
    await waitFor(() => expect(confirmArchive().disabled).toBe(true));
    expect(confirmArchive().textContent).toMatch(/Archiving/);
    expect(confirmArchive().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      confirmArchive().click();
      confirmArchive().click();
    });
    expect(bulkCalls().length).toBe(1);

    await act(async () => {
      release();
      await promise;
    });
    await waitFor(() => expect(bulkCalls().length).toBe(1));
  });

  it("cannot be opened with an empty selection", async () => {
    await mountLibrary();
    // The toolbar itself only exists while something is selected.
    expect(document.querySelector("[data-evidence-run-bulk]")).toBeNull();
    const boxes = await selectRows(1);
    expect(runBulkButton().disabled).toBe(false);
    await act(async () => {
      boxes[0]!.click();
    });
    expect(document.querySelector("[data-evidence-run-bulk]")).toBeNull();
    expect(confirmDialog()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("Archive bulk action — outcomes", () => {
  it("total success closes the dialog, refreshes the list and clears the selection", async () => {
    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });

    await waitFor(() => expect(confirmDialog()).toBeNull());
    // The archived rows left the Active scope.
    await waitFor(() =>
      expect(document.querySelectorAll("[data-evidence-row]").length).toBe(0),
    );
    // Selection cleared only after the accepted terminal result.
    expect(document.querySelector("[data-evidence-run-bulk]")).toBeNull();
    // The list was re-queried after the mutation.
    const listAfter = H.calls.filter(
      (c, i) => c.path === "/v1/evidence" && i > H.calls.findIndex((x) => x.path === "/v1/evidence/bulk"),
    );
    expect(listAfter.length).toBeGreaterThan(0);
  });

  it("partial success reports both counts and the server's reason per failure", async () => {
    seed(3);
    H.bulkResponse = (body) => {
      const ids = (body as { evidenceIds: string[] }).evidenceIds;
      const [first, ...rest] = ids;
      H.rows.find((r) => r.id === first)!.archivedAt = "2026-08-20T10:00:00.000Z";
      return {
        successCount: 1,
        failedCount: rest.length,
        results: [
          { evidenceId: first, ok: true },
          { evidenceId: rest[0], ok: false, reason: "RETENTION_PROTECTED" },
          { evidenceId: rest[1], ok: false, reason: "LEGAL_HOLD" },
        ],
        items: [],
      };
    };

    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });

    const summary = await waitFor(() => {
      const node = document.querySelector("[data-bulk-result-summary]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(summary.textContent).toMatch(/1 record archived/i);
    expect(summary.textContent).toMatch(/2 records could not be archived/i);
    // Server-projected reasons, in operator language.
    expect(summary.textContent).toMatch(/Protected by retention/i);
    expect(summary.textContent).toMatch(/Legal hold/i);
    // The failed rows stay selected so they can be retried.
    await waitFor(() =>
      expect(runBulkButton().closest(".evidence-library-bulk-toolbar")!.textContent).toMatch(
        /2 selected/,
      ),
    );
  });

  it("total failure keeps the dialog open, preserves the selection and shows the error", async () => {
    H.failures["POST /v1/evidence/bulk"] = { statusCode: 403, code: "FORBIDDEN", message: "Forbidden" };
    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });

    const error = await waitFor(() => {
      const node = document.querySelector("[data-bulk-error]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // Still open, still selected, and the control is usable again.
    expect(confirmDialog()).not.toBeNull();
    expect(confirmArchive().disabled).toBe(false);
    expect(document.querySelectorAll("[data-evidence-row]").length).toBe(3);
    // Focus moved to the error so it is announced.
    expect(document.activeElement).toBe(error);
    expect(error.getAttribute("role")).toBe("alert");
  });

  it("a refresh failure after a successful archive is not reported as a failed archive", async () => {
    // THE SILENT PATH: the mutation succeeded; the list reload did not.
    await openConfirm(3);
    H.failures["GET /v1/evidence"] = { statusCode: 500, code: "SERVER_ERROR" };
    await act(async () => {
      confirmArchive().click();
    });

    await waitFor(() => expect(bulkCalls().length).toBe(1));
    // The archive result is still reported, and nothing claims it failed.
    await waitFor(() => expect(confirmDialog()).toBeNull());
    expect(document.querySelector("[data-bulk-error]")).toBeNull();
  });

  it("names each server refusal in operator language, without inventing a cause", async () => {
    seed(6);
    H.bulkResponse = (body) => {
      const ids = (body as { evidenceIds: string[] }).evidenceIds;
      // Exactly the strings the API projects per record.
      const reasons = [
        "DELETE_BLOCKED_BY_RETENTION",
        "ARCHIVE_BLOCKED_BY_LEGAL_HOLD",
        "ALREADY_ARCHIVED",
        "Evidence not found",
        "Evidence is permanently locked",
        "Something the client has never seen",
      ];
      return {
        successCount: 0,
        failedCount: ids.length,
        results: ids.map((id, i) => ({ evidenceId: id, ok: false, reason: reasons[i] })),
        items: [],
      };
    };

    await openConfirm(6);
    await act(async () => {
      confirmArchive().click();
    });

    const reasons = await waitFor(() => {
      const node = document.querySelector("[data-bulk-result-reasons]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const text = reasons.textContent ?? "";
    expect(text).toMatch(/Protected by retention/);
    expect(text).toMatch(/Legal hold/);
    expect(text).toMatch(/Already archived/);
    expect(text).toMatch(/Insufficient permission/);
    expect(text).toMatch(/Record changed since selection/);
    expect(text).toMatch(/Unknown server failure/);
    // The raw server codes are never shown to the operator…
    expect(text).not.toMatch(/BLOCKED_BY|ALREADY_ARCHIVED/);
    // …and neither are the record identifiers.
    expect(text).not.toMatch(/00000000-0000/);
  });

  it("keeps every selected record when the network never answered", async () => {
    H.failures["POST /v1/evidence/bulk"] = { statusCode: 0, code: "NETWORK_ERROR" };
    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });
    await waitFor(() => expect(document.querySelector("[data-bulk-error]")).not.toBeNull());
    expect(confirmDialog()).not.toBeNull();
    expect(runBulkButton().closest(".evidence-library-bulk-toolbar")!.textContent).toMatch(
      /3 selected/,
    );
    expect(document.querySelectorAll("[data-evidence-row]").length).toBe(3);
  });

  it("refreshes the workspace metrics alongside the list", async () => {
    await openConfirm(3);
    const before = H.calls.filter((c) => c.path === "/v1/evidence/library-summary").length;
    await act(async () => {
      confirmArchive().click();
    });
    await waitFor(() =>
      expect(
        H.calls.filter((c) => c.path === "/v1/evidence/library-summary").length,
      ).toBeGreaterThan(before),
    );
  });

  it("an accepted-but-queued backend is reported as accepted, not as completed", async () => {
    H.bulkResponse = (body) => ({
      accepted: true,
      jobId: "job-1",
      successCount: 0,
      failedCount: 0,
      results: [],
      items: [],
      queued: true,
      pendingCount: (body as { evidenceIds: string[] }).evidenceIds.length,
    });
    await openConfirm(3);
    await act(async () => {
      confirmArchive().click();
    });
    const summary = await waitFor(() => {
      const node = document.querySelector("[data-bulk-result-summary]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(summary.textContent).toMatch(/queued|accepted/i);
    expect(summary.textContent).not.toMatch(/3 records archived/i);
  });
});
