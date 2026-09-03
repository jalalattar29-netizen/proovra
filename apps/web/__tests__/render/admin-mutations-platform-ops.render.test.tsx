/**
 * Admin platform-operations consoles — the MUTATIONS, driven for real.
 *
 * This file mounts the REAL /admin/platform pages against contract-shaped
 * fixtures (the apiFetch seam, same pattern as
 * operations-workbench.render.test.tsx) and proves the mutation machinery:
 * consequential actions confirm BEFORE any request and the dialog names its
 * subject; cancel sends nothing; confirm sends exactly one request with the
 * exact method/path/body; deliberately-unconfirmed actions fire with NO
 * dialog; failures surface through each page's own safe path.
 *
 * Mutations under proof (exact routes):
 *
 *   app/(app)/admin/platform/signers/page.tsx
 *     "POST /v1/operations/custody-attestations/:id/verify"   (NO confirm — read-only report)
 *     "POST /v1/operations/custody-attestations/backfill"     (confirm, step-up)
 *     "POST /v1/operations/signers/:id/preview"               (NO confirm — read-only preview)
 *     "POST /v1/operations/signers/:id/promote"               (confirm, reason required)
 *     "POST /v1/operations/signers/:id/retire"                (confirm, reason required)
 *     "POST /v1/operations/signers/:id/revoke"                (typed-confirm "REVOKE")
 *
 *   app/(app)/admin/platform/recovery/page.tsx
 *     "POST /v1/operations/recovery/validate-backup"          (confirm)
 *     "POST /v1/operations/recovery/validate-restore"         (confirm, step-up)
 *
 *   app/(app)/admin/platform/media-graph/page.tsx
 *     "POST /v1/ops/media-intelligence/runs/:runId/retry"     (confirm; toSafeUserError failures)
 *     "POST /v1/ops/media-intelligence/dlq/replay"            (confirm; toSafeUserError failures)
 *
 *   app/(app)/admin/platform/reliability/page.tsx
 *     "POST /v1/reliability/upload-sessions/:evidenceId/mark-abandoned"
 *     "POST /v1/reliability/upload-sessions/:evidenceId/request-review"
 *       (both confirm; the response row is committed to state, no re-read)
 *
 *   app/(app)/admin/platform/queues/page.tsx
 *     "POST /v1/operations/queues/:queueName/jobs/:jobId/retry"
 *     "POST /v1/operations/queues/:queueName/jobs/:jobId/replay"
 *       (the replay dialog IS the confirmation: effect paragraph, reason
 *        required, teamId + reason + expectedJobName in the payload)
 *
 *   app/(app)/admin/platform/exports/page.tsx
 *     "POST /v1/operations/exports/:id/verify"                (NO confirm — drawer shows the report)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];
let getReply: (path: string) => Reply = () => {
  throw new Error("no GET fixture installed");
};
let postReply: (path: string, body: unknown) => Reply = () => ({ ok: true });

/** A rejection shaped like the one `apiFetch` throws: an Error carrying
 *  `statusCode` (and optionally the server's canonical `code`). */
function apiFailure(statusCode: number, code?: string): Error {
  const err = new Error("request failed") as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const reply =
      method === "GET"
        ? getReply(path)
        : postReply(path, init?.body ? JSON.parse(init.body) : undefined);
    if (reply instanceof Error) throw reply;
    return reply;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  setApiToken: () => {},
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/platform",
  useParams: () => ({}),
}));

const WS = "ws-1";
vi.mock("../../lib/platform-context", () => {
  // STABLE identities — a fresh object per render would re-create the pages'
  // useCallbacks every render and spin the load effects forever.
  const tenantGuard = { stamp: () => 1, isStale: () => false };
  return {
    useTeamId: () => "ws-1",
    useActiveWorkspaceId: () => "ws-1",
    useTenantGuard: () => tenantGuard,
  };
});

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Step-up is PASSTHROUGH: the ceremony has its own suite; this file proves the
// wrapped action fires exactly once with the right payload.
vi.mock("../../components/identity-security/StepUpModal", () => {
  // One stable control object, for the same dep-array reason as above.
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (
      fn: (headers?: Record<string, string>) => Promise<unknown>,
    ) => fn({}),
    cancel: () => {},
    closeIdle: () => {},
    startChallenge: async () => {},
    submitCode: async () => {},
  };
  return {
    useStepUpAction: () => control,
    StepUpModal: () => null,
    StepUpModalProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import OperationsSignersPage from "../../app/(app)/admin/platform/signers/page";
import OperationsRecoveryPage from "../../app/(app)/admin/platform/recovery/page";
import MediaGraphOpsPage from "../../app/(app)/admin/platform/media-graph/page";
import ReliabilityPage from "../../app/(app)/admin/platform/reliability/page";
import OperationsQueuesPage from "../../app/(app)/admin/platform/queues/page";
import OperationsExportsPage from "../../app/(app)/admin/platform/exports/page";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ISO = "2026-08-30T10:00:00.000Z";
const EV1 = "aaaaaaaa-0000-4000-8000-000000000001";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleTimers() {
  await settle();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(node: React.ReactElement) {
  cleanup();
  const utils = render(
    <ToastProvider>
      <ConfirmActionProvider>{node}</ConfirmActionProvider>
    </ToastProvider>,
  );
  await settle();
  return utils;
}

const q = (sel: string) => document.querySelector(sel);
const modal = (id: string) =>
  q(`[data-confirm-action-modal="${id}"]`) as HTMLElement | null;
const anyModal = () => q("[data-confirm-action-modal]");

async function submitModal(id: string, typed?: string) {
  const dialog = modal(id);
  expect(dialog, `dialog ${id} should be open`).not.toBeNull();
  if (typed !== undefined) {
    fireEvent.change(
      dialog!.querySelector("[data-confirm-action-typed-input]") as HTMLElement,
      { target: { value: typed } },
    );
  }
  await act(async () => {
    fireEvent.click(
      dialog!.querySelector("[data-confirm-action-submit]") as HTMLElement,
    );
  });
  await settleTimers();
}

async function cancelModal(id: string) {
  const dialog = modal(id);
  expect(dialog, `dialog ${id} should be open`).not.toBeNull();
  await act(async () => {
    fireEvent.click(
      dialog!.querySelector("[data-confirm-action-cancel]") as HTMLElement,
    );
  });
  await settleTimers();
}

const posts = (prefix: string) =>
  requestLog.filter((r) => r.method === "POST" && r.path.startsWith(prefix));
const gets = (prefix: string) =>
  requestLog.filter((r) => r.method === "GET" && r.path.startsWith(prefix));

const descriptionOf = (dialog: HTMLElement) =>
  (dialog.querySelector("[data-confirm-action-description]")?.textContent ??
    "") + (dialog.querySelector("[data-confirm-action-title]")?.textContent ?? "");

/** toSafeUserError's bounded copy for a 5xx. */
const SAFE_500 =
  "Please try again in a moment. Your evidence data has not been changed.";

async function click(el: Element | null) {
  expect(el, "control should be rendered").not.toBeNull();
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

beforeEach(() => {
  requestLog = [];
  postReply = () => ({ ok: true });
  getReply = () => {
    throw new Error("no GET fixture installed");
  };
});

// ===========================================================================
// 1. /admin/platform/signers
// ===========================================================================

const STAGED_ID = "signer-staged-report";

function signerRecord(over: Record<string, unknown>) {
  return {
    signerId: "signer-active-report",
    signerPurpose: "report_pdf",
    provider: "aws_kms",
    keyId: "alias/proovra-report",
    keyVersion: "1",
    kmsKeyArn: null,
    algorithm: "RSASSA_PSS_SHA_256",
    status: "active",
    activatedAtUtc: ISO,
    retiredAtUtc: null,
    lastUsedAtUtc: null,
    notes: null,
    verificationMaterialRef: null,
    ...over,
  };
}

function signersGets(path: string): Reply {
  if (path.startsWith("/v1/operations/signers?")) {
    return {
      signers: [
        signerRecord({}),
        signerRecord({ signerId: STAGED_ID, status: "staged" }),
      ],
    };
  }
  if (path.startsWith(`/v1/operations/signers/${STAGED_ID}/audit`)) {
    return { events: [] };
  }
  if (path.startsWith(`/v1/operations/signers/${STAGED_ID}?`)) {
    return { signer: signerRecord({ signerId: STAGED_ID, status: "staged" }) };
  }
  if (path.startsWith("/v1/operations/custody-attestations?")) {
    return {
      attestations: [
        {
          attestationId: "att-1",
          custodyEventId: "ce-1",
          evidenceId: EV1,
          signerId: "signer-active-report",
          signedAtUtc: ISO,
          outcome: "verified",
        },
      ],
      total: 1,
      limit: 50,
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountSigners() {
  getReply = signersGets;
  await mount(<OperationsSignersPage />);
}

/** Open the staged signer's drawer and record an operator reason. */
async function openStagedDrawer(reason = "quarterly key rotation") {
  await click(screen.getByRole("button", { name: STAGED_ID }));
  fireEvent.change(screen.getByTestId("signer-reason"), {
    target: { value: reason },
  });
  await settle();
}

describe("Signers — POST /v1/operations/custody-attestations/:id/verify (no confirm)", () => {
  it("Verify fires immediately with NO dialog, once, and renders the report", async () => {
    await mountSigners();
    await click(screen.getByTestId("verify-att-1"));
    // Deliberately unconfirmed: a verify writes nothing.
    expect(anyModal()).toBeNull();
    const verifies = posts("/v1/operations/custody-attestations/att-1/verify");
    expect(verifies).toHaveLength(1);
    expect(JSON.parse(verifies[0].body as string)).toEqual({ teamId: WS });
    // postReply default {ok:true} has no report — install one and re-run.
  });

  it("the verify report is rendered from the response", async () => {
    await mountSigners();
    postReply = () => ({
      report: {
        outcome: "verified",
        summary: "Signature matches the recorded custody event.",
        attestation: {
          signerId: "signer-active-report",
          keyId: "alias/proovra-report",
          keyVersion: "1",
          canonicalPayloadHash: "abc123",
          algorithm: "RSASSA_PSS_SHA_256",
          provider: "aws_kms",
          signedAtUtc: ISO,
        },
        recomputedPayloadHash: "abc123",
        verifiedAtUtc: ISO,
      },
    });
    await click(screen.getByTestId("verify-att-1"));
    const panel = screen.getByTestId("verify-result");
    expect(panel.textContent).toContain("verified");
    expect(panel.textContent).toContain(
      "Signature matches the recorded custody event.",
    );
  });
});

describe("Signers — POST /v1/operations/custody-attestations/backfill", () => {
  it("confirms BEFORE any request; cancel sends nothing; confirm posts the bounded batch once and re-reads", async () => {
    await mountSigners();
    await click(screen.getByTestId("run-backfill"));
    const dialog = modal("custody-backfill");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(
      "Backfill custody attestations for this workspace?",
    );
    expect(posts("/v1/operations/custody-attestations/backfill")).toHaveLength(0);
    await cancelModal("custody-backfill");
    expect(posts("/v1/operations/custody-attestations/backfill")).toHaveLength(0);

    postReply = () => ({
      result: { scanned: 5, signed: 3, skipped: 2, failed: 0 },
    });
    const listReadsBefore = gets("/v1/operations/custody-attestations?").length;
    await click(screen.getByTestId("run-backfill"));
    await submitModal("custody-backfill");

    const backfills = posts("/v1/operations/custody-attestations/backfill");
    expect(backfills).toHaveLength(1);
    expect(JSON.parse(backfills[0].body as string)).toEqual({
      teamId: WS,
      batchSize: 50,
    });
    expect(document.body.textContent).toContain(
      "scanned 5, signed 3, skipped 2, failed 0",
    );
    expect(gets("/v1/operations/custody-attestations?").length).toBeGreaterThan(
      listReadsBefore,
    );
  });
});

describe("Signers — POST /v1/operations/signers/:id/preview (no confirm)", () => {
  it("Preview fires immediately with NO dialog and renders compatibility", async () => {
    await mountSigners();
    await click(screen.getByRole("button", { name: STAGED_ID }));
    postReply = () => ({
      preview: {
        signerPurpose: "report_pdf",
        currentActive: {
          signerId: "signer-active-report",
          provider: "aws_kms",
          keyId: "alias/proovra-report",
          keyVersion: "1",
          algorithm: "RSASSA_PSS_SHA_256",
        },
        staged: {
          signerId: STAGED_ID,
          provider: "aws_kms",
          keyId: "alias/proovra-report-v2",
          keyVersion: "2",
          algorithm: "RSASSA_PSS_SHA_256",
        },
        compatibility: "compatible",
        warnings: [],
        rolloutPlan: "New material signs with the promoted signer immediately.",
        generatedAtUtc: ISO,
      },
    });
    await click(screen.getByRole("button", { name: "Preview rotation" }));
    expect(anyModal()).toBeNull();
    const previews = posts(`/v1/operations/signers/${STAGED_ID}/preview`);
    expect(previews).toHaveLength(1);
    expect(JSON.parse(previews[0].body as string)).toEqual({ teamId: WS });
    expect(document.body.textContent).toContain("compatible");
  });
});

describe("Signers — promote / retire / revoke lifecycle", () => {
  it("an empty reason is refused locally — no dialog, no request", async () => {
    await mountSigners();
    await click(screen.getByRole("button", { name: STAGED_ID }));
    await click(screen.getByTestId("signer-promote"));
    expect(anyModal()).toBeNull();
    expect(posts(`/v1/operations/signers/${STAGED_ID}/promote`)).toHaveLength(0);
    expect(document.body.textContent).toContain("Operator reason is required.");
  });

  it("POST /v1/operations/signers/:id/promote — dialog names the signer; cancel sends nothing; confirm fires once", async () => {
    await mountSigners();
    await openStagedDrawer();
    await click(screen.getByTestId("signer-promote"));
    const dialog = modal("signer-promote-confirm");
    expect(dialog).not.toBeNull();
    const words = descriptionOf(dialog!);
    expect(words).toContain("Promote this signer to active?");
    expect(words).toContain(STAGED_ID);
    expect(words).toContain("report pdf");
    expect(posts(`/v1/operations/signers/${STAGED_ID}/promote`)).toHaveLength(0);
    await cancelModal("signer-promote-confirm");
    expect(posts(`/v1/operations/signers/${STAGED_ID}/promote`)).toHaveLength(0);

    await click(screen.getByTestId("signer-promote"));
    await submitModal("signer-promote-confirm");
    const promotes = posts(`/v1/operations/signers/${STAGED_ID}/promote`);
    expect(promotes).toHaveLength(1);
    expect(JSON.parse(promotes[0].body as string)).toEqual({
      teamId: WS,
      reason: "quarterly key rotation",
    });
    expect(document.body.textContent).toContain("Signer promote recorded.");
  });

  it("POST /v1/operations/signers/:id/retire — confirm fires once with the reason", async () => {
    await mountSigners();
    await openStagedDrawer("staged signer superseded");
    await click(screen.getByTestId("signer-retire"));
    const dialog = modal("signer-retire-confirm");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain("Retire this signer?");
    await submitModal("signer-retire-confirm");
    const retires = posts(`/v1/operations/signers/${STAGED_ID}/retire`);
    expect(retires).toHaveLength(1);
    expect(JSON.parse(retires[0].body as string)).toEqual({
      teamId: WS,
      reason: "staged signer superseded",
    });
    expect(document.body.textContent).toContain("Signer retire recorded.");
  });

  it("POST /v1/operations/signers/:id/revoke — typed 'REVOKE' gates the irreversible leg", async () => {
    await mountSigners();
    await openStagedDrawer("key material exposed");
    await click(screen.getByTestId("signer-revoke"));
    const dialog = modal("signer-revoke-confirm");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("data-confirm-action-tone")).toBe("danger");
    expect(descriptionOf(dialog!)).toContain("cannot be undone");
    const submit = dialog!.querySelector(
      "[data-confirm-action-submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(posts(`/v1/operations/signers/${STAGED_ID}/revoke`)).toHaveLength(0);

    await submitModal("signer-revoke-confirm", "REVOKE");
    const revokes = posts(`/v1/operations/signers/${STAGED_ID}/revoke`);
    expect(revokes).toHaveLength(1);
    expect(JSON.parse(revokes[0].body as string)).toEqual({
      teamId: WS,
      reason: "key material exposed",
    });
  });

  it("a 500 on promote surfaces the safe failure with no success", async () => {
    await mountSigners();
    await openStagedDrawer();
    postReply = () => apiFailure(500);
    await click(screen.getByTestId("signer-promote"));
    await submitModal("signer-promote-confirm");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(document.body.textContent).not.toContain("Signer promote recorded.");
  });
});

// ===========================================================================
// 2. /admin/platform/recovery
// ===========================================================================

function recoveryGets(path: string): Reply {
  if (path.startsWith("/v1/operations/recovery?")) {
    return {
      readiness: {
        objectLockMode: "verified",
        lastBackupReport: null,
        lastRestoreReport: null,
        unsupportedDomains: ["database_backups", "cross_region_failover"],
      },
      recentReports: [],
      recentReportsCap: 20,
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

function recoveryReport(kind: string, outcome = "passed") {
  return {
    report: {
      reportId: "rep-1",
      kind,
      teamId: WS,
      startedAtUtc: ISO,
      finishedAtUtc: ISO,
      overallOutcome: outcome,
      checks: [
        {
          id: "backup_set_present",
          label: "Backup set present",
          outcome,
          detail: "The most recent backup set was located.",
          unsupported: false,
        },
      ],
      unsupportedDomains: [],
      recommendedAction: null,
    },
  };
}

async function mountRecovery() {
  getReply = recoveryGets;
  await mount(<OperationsRecoveryPage />);
}

describe("Recovery — POST /v1/operations/recovery/validate-backup", () => {
  it("confirms BEFORE any request; cancel sends nothing; confirm fires once, opens the report and re-reads", async () => {
    await mountRecovery();
    await click(screen.getByTestId("run-backup-validation"));
    const dialog = modal("recovery-validate-backup");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(
      "Run backup validation for this workspace?",
    );
    expect(posts("/v1/operations/recovery/validate-backup")).toHaveLength(0);
    await cancelModal("recovery-validate-backup");
    expect(posts("/v1/operations/recovery/validate-backup")).toHaveLength(0);

    postReply = () => recoveryReport("backup_validation_report");
    const overviewReadsBefore = gets("/v1/operations/recovery?").length;
    await click(screen.getByTestId("run-backup-validation"));
    await submitModal("recovery-validate-backup");

    const runs = posts("/v1/operations/recovery/validate-backup");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0].body as string)).toEqual({ teamId: WS });
    expect(document.body.textContent).toContain(
      "Backup validation completed (passed).",
    );
    expect(screen.getByTestId("report-drawer")).toBeTruthy();
    expect(gets("/v1/operations/recovery?").length).toBeGreaterThan(
      overviewReadsBefore,
    );
  });

  it("a 500 surfaces the safe failure with no success and no report drawer", async () => {
    await mountRecovery();
    postReply = () => apiFailure(500);
    await click(screen.getByTestId("run-backup-validation"));
    await submitModal("recovery-validate-backup");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain(
      "Backup validation completed",
    );
    expect(screen.queryByTestId("report-drawer")).toBeNull();
  });
});

describe("Recovery — POST /v1/operations/recovery/validate-restore", () => {
  it("confirms, then the step-up-wrapped request fires exactly once", async () => {
    await mountRecovery();
    postReply = () => recoveryReport("restore_validation_report");
    await click(screen.getByTestId("run-restore-validation"));
    const dialog = modal("recovery-validate-restore");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(
      "Run restore validation for this workspace?",
    );
    expect(posts("/v1/operations/recovery/validate-restore")).toHaveLength(0);
    await submitModal("recovery-validate-restore");

    const runs = posts("/v1/operations/recovery/validate-restore");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0].body as string)).toEqual({ teamId: WS });
    expect(document.body.textContent).toContain(
      "Restore validation completed (passed).",
    );
  });
});

// ===========================================================================
// 3. /admin/platform/media-graph
// ===========================================================================

const RUN_ID = "mi-extract_exif-1234";

function mediaGets(path: string): Reply {
  if (path.startsWith("/v1/admin/platform/metrics")) {
    return {
      scope: "platform",
      metrics: {
        uptimeSeconds: 10,
        counters: { media_intelligence_enqueue_total: 4 },
        gauges: { media_intelligence_queue_depth: 2 },
      },
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountMediaGraph() {
  getReply = mediaGets;
  await mount(<MediaGraphOpsPage />);
}

describe("Media graph — POST /v1/ops/media-intelligence/runs/:runId/retry", () => {
  it("an empty job id is refused locally — no dialog, no request", async () => {
    await mountMediaGraph();
    await click(screen.getByRole("button", { name: "Retry" }));
    expect(anyModal()).toBeNull();
    expect(posts("/v1/ops/media-intelligence/")).toHaveLength(0);
    expect(document.body.textContent).toContain("Provide a job id");
  });

  it("confirms BEFORE any request naming the job; cancel sends nothing; confirm fires once", async () => {
    await mountMediaGraph();
    fireEvent.change(screen.getByPlaceholderText("mi-extract_exif-<uuid>"), {
      target: { value: RUN_ID },
    });
    await click(screen.getByRole("button", { name: "Retry" }));
    const dialog = modal("media-graph-retry");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(RUN_ID);
    expect(posts("/v1/ops/media-intelligence/")).toHaveLength(0);
    await cancelModal("media-graph-retry");
    expect(posts("/v1/ops/media-intelligence/")).toHaveLength(0);

    postReply = () => ({ runId: RUN_ID, retried: true });
    await click(screen.getByRole("button", { name: "Retry" }));
    await submitModal("media-graph-retry");

    const retries = posts(`/v1/ops/media-intelligence/runs/${RUN_ID}/retry`);
    expect(retries).toHaveLength(1);
    expect(JSON.parse(retries[0].body as string)).toEqual({ teamId: WS });
    expect(document.body.textContent).toContain(`Job ${RUN_ID} requeued.`);
  });

  it("a 500 is routed through toSafeUserError — bounded copy, never the raw message", async () => {
    await mountMediaGraph();
    postReply = () => apiFailure(500);
    fireEvent.change(screen.getByPlaceholderText("mi-extract_exif-<uuid>"), {
      target: { value: RUN_ID },
    });
    await click(screen.getByRole("button", { name: "Retry" }));
    await submitModal("media-graph-retry");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(document.body.textContent).not.toContain("requeued");
  });
});

describe("Media graph — POST /v1/ops/media-intelligence/dlq/replay", () => {
  it("confirms the bounded batch; confirm fires once with teamId + maxJobs", async () => {
    await mountMediaGraph();
    await click(screen.getByRole("button", { name: "Replay DLQ" }));
    const dialog = modal("media-graph-replay-dlq");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain("Up to 50 dead-lettered");
    expect(posts("/v1/ops/media-intelligence/dlq/replay")).toHaveLength(0);
    await cancelModal("media-graph-replay-dlq");
    expect(posts("/v1/ops/media-intelligence/dlq/replay")).toHaveLength(0);

    postReply = () => ({ attempted: 5, retried: 3, skipped: 2 });
    await click(screen.getByRole("button", { name: "Replay DLQ" }));
    await submitModal("media-graph-replay-dlq");

    const replays = posts("/v1/ops/media-intelligence/dlq/replay");
    expect(replays).toHaveLength(1);
    expect(JSON.parse(replays[0].body as string)).toEqual({
      teamId: WS,
      maxJobs: 50,
    });
    expect(document.body.textContent).toContain(
      "3 of 5 attempted jobs requeued (2 skipped).",
    );
  });
});

// ===========================================================================
// 4. /admin/platform/reliability
// ===========================================================================

function reliabilitySession(over: Record<string, unknown> = {}) {
  return {
    id: "us-1",
    evidenceId: EV1,
    teamId: WS,
    status: "STALLED",
    isMultipart: false,
    expectedPartCount: null,
    completedPartCount: 0,
    retryCount: 1,
    failureReason: null,
    lastActivityAtUtc: ISO,
    stalledAtUtc: ISO,
    abandonedAtUtc: null,
    completedAtUtc: null,
    isTerminal: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

function reliabilityGets(path: string): Reply {
  if (path.startsWith("/v1/reliability/summary?")) {
    return {
      counts: { STALLED: 1 },
      thresholds: { stalledMinutes: 30, abandonedHours: 24 },
      sizeLimits: {
        maxUploadFileSizeBytes: 1073741824,
        multipartThresholdBytes: 8388608,
        multipartPartSizeBytes: 8388608,
      },
      queuePolicies: [],
    };
  }
  if (path.startsWith("/v1/reliability/upload-sessions?")) {
    return { sessions: [reliabilitySession()] };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountReliability() {
  getReply = reliabilityGets;
  await mount(<ReliabilityPage />);
}

/** The one session's own row — the status <select> also spells every state
 *  name, so row-level facts must be read from the row. */
function sessionRow(): HTMLElement {
  const label = screen.getByText(/Evidence aaaaaaaa/);
  const row = label.closest("li");
  expect(row, "session row should be rendered").not.toBeNull();
  return row as HTMLElement;
}

describe("Reliability — POST /v1/reliability/upload-sessions/:evidenceId/mark-abandoned", () => {
  it("confirms naming the evidence; cancel sends nothing; confirm commits the SERVER's row without a re-read", async () => {
    await mountReliability();
    await click(screen.getByRole("button", { name: "Mark abandoned" }));
    const dialog = modal("reliability-mark-abandoned");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(EV1.slice(0, 8));
    expect(posts("/v1/reliability/upload-sessions/")).toHaveLength(0);
    await cancelModal("reliability-mark-abandoned");
    expect(posts("/v1/reliability/upload-sessions/")).toHaveLength(0);
    expect(sessionRow().textContent).toContain("STALLED");

    postReply = () => ({
      session: reliabilitySession({
        status: "ABANDONED",
        isTerminal: true,
        abandonedAtUtc: ISO,
      }),
    });
    const listReadsBefore = gets("/v1/reliability/upload-sessions?").length;
    await click(screen.getByRole("button", { name: "Mark abandoned" }));
    await submitModal("reliability-mark-abandoned");

    const marks = posts(
      `/v1/reliability/upload-sessions/${EV1}/mark-abandoned`,
    );
    expect(marks).toHaveLength(1);
    expect(JSON.parse(marks[0].body as string)).toEqual({ teamId: WS });
    // The response row IS the new state: the badge changed and, being
    // terminal, the row offers no further actions.
    const row = sessionRow();
    expect(row.textContent).toContain("ABANDONED");
    expect(row.textContent).not.toContain("STALLED");
    expect(screen.queryByRole("button", { name: "Mark abandoned" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
    // Committed to state, not re-read.
    expect(gets("/v1/reliability/upload-sessions?").length).toBe(
      listReadsBefore,
    );
  });

  it("a 500 surfaces the safe failure and the row keeps its state", async () => {
    await mountReliability();
    postReply = () => apiFailure(500);
    await click(screen.getByRole("button", { name: "Mark abandoned" }));
    await submitModal("reliability-mark-abandoned");
    expect(document.body.textContent).toContain(SAFE_500);
    // The row keeps the state the server last returned, and its actions stay.
    const row = sessionRow();
    expect(row.textContent).toContain("STALLED");
    expect(row.textContent).not.toContain("ABANDONED");
    expect(screen.getByRole("button", { name: "Mark abandoned" })).toBeTruthy();
  });
});

describe("Reliability — POST /v1/reliability/upload-sessions/:evidenceId/request-review", () => {
  it("confirms, fires once, and commits the REVIEW_REQUIRED row", async () => {
    await mountReliability();
    postReply = () => ({
      session: reliabilitySession({ status: "REVIEW_REQUIRED" }),
    });
    await click(screen.getByRole("button", { name: "Request review" }));
    const dialog = modal("reliability-request-review");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(EV1.slice(0, 8));
    expect(posts("/v1/reliability/upload-sessions/")).toHaveLength(0);
    await submitModal("reliability-request-review");

    const reviews = posts(
      `/v1/reliability/upload-sessions/${EV1}/request-review`,
    );
    expect(reviews).toHaveLength(1);
    expect(JSON.parse(reviews[0].body as string)).toEqual({ teamId: WS });
    expect(sessionRow().textContent).toContain("REVIEW_REQUIRED");
    // A row already under review is offered no second Request review; the
    // non-terminal session can still be abandoned.
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark abandoned" })).toBeTruthy();
  });
});

// ===========================================================================
// 5. /admin/platform/queues
// ===========================================================================

const QUEUE = "media-intelligence";

function queuesGets(path: string): Reply {
  if (path.startsWith("/v1/operations/queues/workers")) {
    return {
      workers: [
        {
          queueName: QUEUE,
          status: "healthy",
          lastActivityAtUtc: ISO,
          stalledCount: 0,
          recommendedAction: null,
        },
      ],
    };
  }
  if (path.startsWith("/v1/operations/queues/replay-safety")) {
    return {
      matrix: [
        {
          queueName: QUEUE,
          jobKind: "extract_exif",
          category: "safe",
          rationale: "Idempotent metadata extraction.",
        },
        {
          queueName: QUEUE,
          jobKind: "destroy_evidence",
          category: "forbidden",
          rationale: "Destructive job kinds are never replayed.",
        },
      ],
    };
  }
  if (path.startsWith(`/v1/operations/queues/${QUEUE}/failed`)) {
    return {
      jobs: [
        {
          jobId: "job-safe-1",
          jobName: "extract_exif",
          failedAtUtc: ISO,
          attemptsMade: 3,
          maxAttempts: 5,
          failureReason: "upstream timeout",
          stackSnippet: null,
          safeRefs: { teamId: WS, evidenceId: null, matterId: null },
        },
        {
          jobId: "job-forbidden-1",
          jobName: "destroy_evidence",
          failedAtUtc: ISO,
          attemptsMade: 1,
          maxAttempts: 1,
          failureReason: "worker crash",
          stackSnippet: null,
          safeRefs: { teamId: WS, evidenceId: null, matterId: null },
        },
      ],
      total: 2,
      limit: 50,
    };
  }
  if (path.startsWith("/v1/operations/queues?")) {
    return {
      queues: [
        {
          queueName: QUEUE,
          label: "Media intelligence",
          counts: { waiting: 0, active: 0, delayed: 0, failed: 2, completed: 10 },
          stalledCount: 0,
          health: "degraded",
          oldestWaitingAgeMs: null,
          disabledReason: null,
        },
      ],
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

/** Mount and select the queue so its failed jobs load. */
async function mountQueuesSelected() {
  getReply = queuesGets;
  await mount(<OperationsQueuesPage />);
  await click(
    within(screen.getByTestId("queue-overview")).getByRole("button", {
      name: /Media intelligence/,
    }),
  );
}

/** Open the replay dialog from the safe failed-job row. */
async function openReplayDialog() {
  const panel = screen.getByTestId("failed-jobs-panel");
  await click(within(panel).getByRole("button", { name: "Replay…" }));
  const dialog = screen.getByTestId("replay-dialog");
  return dialog;
}

describe("Queues — the replay dialog IS the confirmation", () => {
  it("a forbidden job kind is offered NO control, only the refusal", async () => {
    await mountQueuesSelected();
    const panel = screen.getByTestId("failed-jobs-panel");
    expect(
      within(panel).getAllByRole("button", { name: "Replay…" }),
    ).toHaveLength(1);
    expect(panel.textContent).toContain("Forbidden — diagnose via audit center");
  });

  it("the dialog opens BEFORE any request, states the effect, and demands a reason", async () => {
    await mountQueuesSelected();
    const dialog = await openReplayDialog();
    expect(posts("/v1/operations/queues/")).toHaveLength(0);
    // It names the job it is about.
    expect(dialog.textContent).toContain("extract_exif");
    expect(dialog.textContent).toContain("job-safe-1");
    // The effect paragraph explains what each button does to THIS job.
    const effect = screen.getByTestId("replay-effect");
    expect(effect.textContent).toContain("re-runs this one failed job");
    expect(effect.textContent).toContain("enqueues a fresh copy");
    // Reason required: both actions are shut until one is typed.
    const retry = within(dialog).getByRole("button", {
      name: "Retry attempt",
    }) as HTMLButtonElement;
    const replay = within(dialog).getByRole("button", {
      name: "Replay",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(replay.disabled).toBe(true);
  });

  it("Close sends nothing", async () => {
    await mountQueuesSelected();
    const dialog = await openReplayDialog();
    await click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("replay-dialog")).toBeNull();
    expect(posts("/v1/operations/queues/")).toHaveLength(0);
  });

  it("POST /v1/operations/queues/:queueName/jobs/:jobId/retry — once, with teamId + reason + expectedJobName", async () => {
    await mountQueuesSelected();
    const dialog = await openReplayDialog();
    fireEvent.change(screen.getByTestId("replay-reason"), {
      target: { value: "upstream API recovered" },
    });
    const failedReadsBefore = gets(
      `/v1/operations/queues/${QUEUE}/failed`,
    ).length;
    await click(within(dialog).getByRole("button", { name: "Retry attempt" }));
    await settle();

    const retries = posts(
      `/v1/operations/queues/${QUEUE}/jobs/job-safe-1/retry`,
    );
    expect(retries).toHaveLength(1);
    expect(JSON.parse(retries[0].body as string)).toEqual({
      teamId: WS,
      reason: "upstream API recovered",
      expectedJobName: "extract_exif",
    });
    expect(document.body.textContent).toContain("Job retry recorded.");
    // The dialog closes and the queue is re-read from the server.
    expect(screen.queryByTestId("replay-dialog")).toBeNull();
    expect(gets(`/v1/operations/queues/${QUEUE}/failed`).length).toBeGreaterThan(
      failedReadsBefore,
    );
  });

  it("POST /v1/operations/queues/:queueName/jobs/:jobId/replay — once, same payload", async () => {
    await mountQueuesSelected();
    const dialog = await openReplayDialog();
    fireEvent.change(screen.getByTestId("replay-reason"), {
      target: { value: "investigated incident 42" },
    });
    await click(within(dialog).getByRole("button", { name: "Replay" }));
    await settle();

    const replays = posts(
      `/v1/operations/queues/${QUEUE}/jobs/job-safe-1/replay`,
    );
    expect(replays).toHaveLength(1);
    expect(JSON.parse(replays[0].body as string)).toEqual({
      teamId: WS,
      reason: "investigated incident 42",
      expectedJobName: "extract_exif",
    });
    expect(document.body.textContent).toContain("Job replay recorded.");
  });

  it("a 500 surfaces the safe failure and no success", async () => {
    await mountQueuesSelected();
    postReply = () => apiFailure(500);
    const dialog = await openReplayDialog();
    fireEvent.change(screen.getByTestId("replay-reason"), {
      target: { value: "retrying after incident" },
    });
    await click(within(dialog).getByRole("button", { name: "Retry attempt" }));
    await settle();
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(document.body.textContent).not.toContain("Job retry recorded.");
  });
});

// ===========================================================================
// 6. /admin/platform/exports
// ===========================================================================

const EXPORT_ID = "exp-1";

function exportManifestEnvelope() {
  return {
    manifest: {
      manifestVersion: 1,
      kind: "report_pdf",
      exportId: EXPORT_ID,
      exportVersion: 2,
      kindLabel: "Report PDF",
      evidenceId: EV1,
      teamId: WS,
      organizationId: null,
      generatedAtUtc: ISO,
      artifact: {
        storageBucket: "proovra-exports",
        storageKey: "exports/exp-1.pdf",
        storageRegion: "eu-west-1",
        sizeBytes: "2048",
        contentType: "application/pdf",
      },
      objectLock: {
        platformMode: "verified",
        storedMode: "COMPLIANCE",
        storedRetainUntilUtc: ISO,
        storedLegalHoldStatus: "OFF",
      },
      signing: {
        artifactSigned: true,
        artifactSigningKeyId: "key-1",
        artifactSignedAtUtc: ISO,
        artifactUnsignedOptOut: false,
      },
      reproducibility: {
        deterministicProjection: true,
        sourceFields: ["storageKey", "sizeBytes"],
      },
    },
    manifestHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    generatedAtUtc: ISO,
  };
}

function exportsGets(path: string): Reply {
  if (path.startsWith("/v1/operations/exports/object-lock")) {
    return {
      status: {
        mode: "verified",
        bucket: "proovra-exports",
        defaultMode: "COMPLIANCE",
        defaultRetainDays: 30,
        checkedAtUtc: ISO,
      },
    };
  }
  if (path.startsWith(`/v1/operations/exports/${EXPORT_ID}?`)) {
    return { envelope: exportManifestEnvelope() };
  }
  if (path.startsWith("/v1/operations/exports?")) {
    return {
      exports: [
        {
          exportId: EXPORT_ID,
          kind: "report_pdf",
          kindLabel: "Report PDF",
          exportVersion: 2,
          evidenceId: EV1,
          teamId: WS,
          generatedAtUtc: ISO,
          sizeBytes: "2048",
          objectLockStoredMode: "COMPLIANCE",
          artifactSigned: true,
          artifactSigningKeyId: "key-1",
          artifactSignedAtUtc: ISO,
          artifactUnsignedOptOut: false,
          artifactSigningWarning: null,
          verificationPackageSignatureStatus: "NOT_APPLICABLE",
        },
      ],
      limit: 50,
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountExportsWithDrawer() {
  getReply = exportsGets;
  await mount(<OperationsExportsPage />);
  await click(screen.getByRole("button", { name: "Inspect" }));
}

describe("Exports — POST /v1/operations/exports/:id/verify (no confirm)", () => {
  it("the drawer names its subject — the export under inspection", async () => {
    await mountExportsWithDrawer();
    const drawer = screen.getByTestId("export-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("manifest-export-id").textContent).toBe(
      EXPORT_ID,
    );
    expect(drawer.textContent).toContain("Report PDF");
  });

  it("Verify fires immediately with NO dialog, exactly once, and the drawer shows the report", async () => {
    await mountExportsWithDrawer();
    postReply = () => ({
      report: {
        exportId: EXPORT_ID,
        outcome: "match",
        summary: "The manifest re-derives byte-for-byte.",
        manifestEnvelope: exportManifestEnvelope(),
        checks: [
          { field: "sha256", expected: "abc", actual: "abc", ok: true },
        ],
        verifiedAtUtc: ISO,
      },
    });
    await click(screen.getByTestId("verify-button"));
    // Deliberately unconfirmed: verification writes nothing.
    expect(anyModal()).toBeNull();
    const verifies = posts(`/v1/operations/exports/${EXPORT_ID}/verify`);
    expect(verifies).toHaveLength(1);
    expect(JSON.parse(verifies[0].body as string)).toEqual({ teamId: WS });
    const result = screen.getByTestId("verify-result");
    expect(
      within(result).getByTestId("verify-outcome").textContent,
    ).toBe("match");
    expect(result.textContent).toContain(
      "The manifest re-derives byte-for-byte.",
    );
  });

  it("a 500 surfaces the safe failure in the drawer with no report", async () => {
    await mountExportsWithDrawer();
    postReply = () => apiFailure(500);
    await click(screen.getByTestId("verify-button"));
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(screen.queryByTestId("verify-result")).toBeNull();
  });
});
