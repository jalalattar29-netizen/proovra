/**
 * Team remediation stage F — Evidence Detail load, refresh and download states
 * (T-137, T-138, T-139, T-144, T-145; audit JRN-08 a, b, c, h, i).
 *
 * The REAL page and the REAL apiFetch over a stubbed `fetch`, answered from the
 * shared Evidence Detail fixture. Each case failed on the audited page:
 *   - a failed background reload replaced the whole record with the error card;
 *   - a failed case-list read read as "No attachable cases";
 *   - Artifacts-tab version downloads stayed enabled on an integrity-failed record;
 *   - the first-load error card was the same for 404, 403 and a network failure,
 *     always with Retry.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const EVIDENCE_ID = "ev-stage-f-1";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/api/intelligence", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchEvidenceIntelligence: async () => ({ evidenceId: EVIDENCE_ID, entities: [], extractedText: [], similarities: [] }),
  readEvidenceIntelligence: async () => ({ kind: "ok", data: { entities: [], extractedTexts: [], similarities: [], disclaimer: "" } }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: EVIDENCE_ID }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/evidence/${EVIDENCE_ID}`,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import EvidenceDetailPage from "../../app/(app)/evidence/[id]/page";
import { respondEvidenceDetail } from "./_fixtures/evidence-detail-fixture";

type Override = { status: number; body: unknown } | "network";
/** Per-path answers (first match by substring), consumed in order; the last one sticks. */
let overrides: Array<{ match: string; answers: Override[] }>;
let patchWorkspace: ((w: Record<string, unknown>) => void) | undefined;
let calls: string[];

const TEAM_ENVELOPE = {
  authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
  navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
  capabilities: { EVIDENCE_VIEW: true },
  diagnostics: { requestId: "test-team" },
  workspace: { id: "ws-team", name: "Harbour Investigations", status: "active", scope: "ORGANIZATION" },
  activeSpace: { type: "ORGANIZATION", id: "ws-team", displayName: "Harbour Investigations", roleLabel: "Owner" },
  contextOptions: {
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [],
    activeContext: { workspaceId: "ws-team", kind: "ORGANIZATION", organizationId: null, displayName: "Harbour Investigations" },
  },
  account: { accountPlan: "TEAM", accountStatus: "active" },
  flags: { isEnterpriseWorkspace: false },
  platform: { isPlatformAdmin: false },
  planFeatures: { intakeIncluded: true, reviewerOperationsIncluded: true },
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  overrides = [];
  patchWorkspace = undefined;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const o = overrides.find((x) => path.includes(x.match));
      if (o) {
        const next = o.answers.length > 1 ? o.answers.shift()! : o.answers[0]!;
        if (next === "network") throw new TypeError("Failed to fetch");
        return json(next.status, next.body);
      }
      return json(200, respondEvidenceDetail(path, { evidenceId: EVIDENCE_ID, patchWorkspace }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

async function mount() {
  const view = render(
    <PlatformContextProvider testEnvelope={TEAM_ENVELOPE as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <EvidenceDetailPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await flush();
  return view;
}

const ok = (body: unknown) => ({ status: 200, body });
const loaded = () => respondEvidenceDetail(`/v1/evidence/${EVIDENCE_ID}/review-workspace`, { evidenceId: EVIDENCE_ID, patchWorkspace });

/** The fixture's version history under the key the Artifacts tab reads. */
function withHistory(w: Record<string, unknown>) {
  const av = w.artifactVersions as Record<string, unknown>;
  av.history = { reports: av.reports, verificationPackages: av.verificationPackages };
}

function selectTab(id: string) {
  const tab = document.querySelector(`[data-evidence-tab="${id}"]`) as HTMLElement;
  expect(tab).not.toBeNull();
  fireEvent.click(tab);
}

describe("Evidence Detail — load and refresh states (stage F)", () => {
  it("T-137: a failed background reload keeps the record and shows a status banner with Retry", async () => {
    // A pending anchoring keeps "Check latest status" (a plain reload) on screen.
    patchWorkspace = (w) => {
      const pm = w.preservationMatrix as { ots: Record<string, unknown> };
      pm.ots = { ...pm.ots, state: "PENDING", recheckAvailable: true };
    };
    overrides.push({
      match: "/review-workspace",
      answers: [ok(loaded()), { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "down" } } }],
    });
    const view = await mount();
    expect(document.querySelector(".evidence-detail-hero")).not.toBeNull();
    selectTab("integrity");
    await flush();
    const check = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Check latest status")!;
    expect(check).toBeTruthy();
    await act(async () => {
      check.click();
    });
    await flush();
    // The record is still on screen; the failure is a non-blocking banner.
    expect(document.querySelector(".evidence-detail-hero")).not.toBeNull();
    expect(view.queryByText("Unable to load the record")).toBeNull();
    const banner = document.querySelector("[data-evidence-refresh-error]") as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute("role")).toBe("status");
    // Retry re-reads and clears it.
    overrides[0]!.answers = [ok(loaded())];
    await act(async () => {
      (document.querySelector("[data-evidence-refresh-retry]") as HTMLElement).click();
    });
    await flush();
    expect(document.querySelector("[data-evidence-refresh-error]")).toBeNull();
  });

  it("T-145: a first-load 403 says permission and offers no Retry", async () => {
    overrides.push({ match: "/review-workspace", answers: [{ status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } }] });
    await mount();
    const card = document.querySelector("[data-evidence-load-failure]") as HTMLElement;
    expect(card.getAttribute("data-evidence-load-failure")).toBe("forbidden");
    expect(card.textContent).toContain("permission");
    expect(document.querySelector("[data-evidence-load-retry]")).toBeNull();
  });

  it("T-145: a first-load 404 says not found or no access, without Retry", async () => {
    overrides.push({ match: "/review-workspace", answers: [{ status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } }] });
    await mount();
    const card = document.querySelector("[data-evidence-load-failure]") as HTMLElement;
    expect(card.getAttribute("data-evidence-load-failure")).toBe("not_found");
    expect(card.textContent).toContain("no longer have access");
    expect(document.querySelector("[data-evidence-load-retry]")).toBeNull();
  });

  it("T-145: a network failure on first load offers Retry, and Retry loads the record", async () => {
    overrides.push({ match: "/review-workspace", answers: ["network", ok(loaded())] });
    await mount();
    expect(document.querySelector("[data-evidence-load-failure]")?.getAttribute("data-evidence-load-failure")).toBe("unavailable");
    await act(async () => {
      (document.querySelector("[data-evidence-load-retry]") as HTMLElement).click();
    });
    await flush();
    expect(document.querySelector(".evidence-detail-hero")).not.toBeNull();
  });

  it("T-138: a failed case-list read is an error with Retry in the assign dialog, not 'No attachable cases'", async () => {
    overrides.push({ match: "/v1/cases?", answers: [{ status: 500, body: { error: { code: "INTERNAL_ERROR", message: "x" } } }] });
    await mount();
    selectTab("review");
    await flush();
    const attach = document.querySelector('[data-evidence-action="attach-to-case"]') as HTMLButtonElement;
    expect(attach).not.toBeNull();
    await act(async () => {
      attach.click();
    });
    await flush();
    expect(document.querySelector("[data-evidence-assign-case-error]")).not.toBeNull();
    expect(document.querySelector("[data-evidence-assign-case-empty]")).toBeNull();
    expect(document.body.textContent).not.toContain("No attachable cases are available");
  });

  it("T-139: on an integrity-failed record every version download is disabled with the header's reason", async () => {
    patchWorkspace = (w) => {
      withHistory(w);
      (w.evidence as Record<string, unknown>).status = "FAILED_HASH_MISMATCH";
    };
    await mount();
    selectTab("artifacts");
    await flush();
    const versionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-evidence-artifact-version-download], [data-testid="truth-download-report"], [data-testid="truth-download-package"]',
      ),
    );
    expect(versionButtons.length).toBeGreaterThan(0);
    for (const b of versionButtons) {
      expect(b.disabled, b.outerHTML.slice(0, 120)).toBe(true);
      expect(b.getAttribute("data-evidence-disabled-reason")).toContain("integrity");
    }
  });
});

describe("Evidence Detail — Restore to active asks first (T-140)", () => {
  it("clicking Restore to active opens a confirmation and posts nothing until it is confirmed", async () => {
    patchWorkspace = (w) => {
      (w.evidence as Record<string, unknown>).archived = true;
      (w.evidence as Record<string, unknown>).lifecycle = {
        productState: "ARCHIVED", canArchive: false, canUnarchive: true, canTrash: false, canRestoreFromTrash: false,
        canRestoreFromArchive: false, trashBlockReason: null, archiveBlockReason: null, trashGraceUntilUtc: null,
        appRetentionUntilUtc: null, objectLockRetainUntilUtc: null, effectiveRetentionUntilUtc: null,
        objectLockCompliance: false, legalHold: false,
      };
    };
    await mount();
    selectTab("review");
    await flush();
    const restore = document.querySelector('[data-evidence-action="restore-archive"]') as HTMLButtonElement;
    expect(restore).not.toBeNull();
    await act(async () => {
      restore.click();
    });
    await flush();
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/unarchive"))).toBe(false);
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Restore this record to active?");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Restore to active") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });
    await flush();
    expect(calls.filter((c) => c.startsWith("POST") && c.includes("/unarchive"))).toHaveLength(1);
  });
});

describe("Evidence Detail — a download in flight is not started twice (T-144)", () => {
  it("a double click on a version download asks for one signed URL", async () => {
    patchWorkspace = withHistory;
    await mount();
    selectTab("artifacts");
    await flush();
    const button = document.querySelector('[data-evidence-artifact-version-download="report"], [data-testid^="download-report-v"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // A slow signed-URL answer: the second click lands while the first waits.
    const waiters: Array<() => void> = [];
    let attempts = 0;
    overrides.push({ match: "/reports/", answers: [{ status: 200, body: { url: null } }] });
    const realFetch = globalThis.fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/reports/")) {
          attempts += 1;
          await new Promise<void>((r) => waiters.push(r));
        }
        return realFetch(input, init);
      }),
    );
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await act(async () => {
      button.click();
      button.click();
    });
    await flush();
    for (const w of waiters) w();
    await flush();
    expect(attempts).toBe(1);
    expect(opened.mock.calls.length).toBeLessThanOrEqual(1);
    // Once the first finished, a new click starts a new download.
    await act(async () => {
      button.click();
    });
    await flush();
    for (const w of waiters) w();
    await flush();
    await waitFor(() => expect(attempts).toBe(2));
  });
});
