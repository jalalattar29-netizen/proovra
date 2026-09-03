/**
 * Admin identity consoles — the MUTATIONS, driven for real.
 *
 * Source text cannot prove that a destructive control confirms before it
 * fires, that cancel really sends nothing, that the success notice waits for
 * the re-read, or that a refused mutation surfaces through the page's own
 * failure path. This file mounts the REAL admin identity pages against
 * contract-shaped fixtures (the apiFetch seam, same pattern as
 * operations-workbench.render.test.tsx) and asserts the behaviour.
 *
 * Mutations under proof (exact routes):
 *
 *   "POST /v1/admin/identity/emergency-revoke"
 *     app/(app)/admin/identity/runtime/page.tsx — reason from the inline
 *     input (data-testid identity-runtime-emergency-reason), typed-confirm
 *     "REVOKE ALL", announced only AFTER the runtime re-read.
 *
 *   "POST /v1/identity-security/reconcile"
 *     app/(app)/admin/identity/runtime/page.tsx — confirm, then step-up,
 *     then reload BEFORE the result is committed.
 *
 *   "POST /v1/admin/identity/elevations"
 *     app/(app)/admin/identity/permission-matrix/page.tsx — bounded
 *     temporary elevation, confirm + step-up, snapshot re-read.
 *
 *   "POST /v1/identity/access-reviews/:id/decision"
 *     app/(app)/admin/identity/access-reviews/page.tsx — per-decision
 *     confirm; note REQUIRED for Suspend / Revoke / No action.
 *
 *   "POST /v1/identity/access-reviews/regenerate"
 *     app/(app)/admin/identity/access-reviews/page.tsx — confirm, empty
 *     JSON body, created-count notice after the queue re-read.
 *
 *   "POST /v1/scim/sync-failures/:id/replay"
 *     app/(app)/admin/identity/scim/page.tsx (ReplayTab) — confirm names
 *     the failure; terminal failures are offered no control at all.
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

/**
 * A rejection shaped exactly like the one `apiFetch` throws: a real Error
 * carrying `statusCode` (and optionally the server's canonical `code`).
 */
function apiFailure(statusCode: number, code?: string): Error {
  const err = new Error("request failed") as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/** A promise whose settlement THIS test controls — the success/failure
 *  ordering proofs hang off it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  usePathname: () => "/admin/identity",
  useParams: () => ({}),
}));

// The workspace context, pinned. The pages read the id and the tenant guard;
// this suite is about the mutation machinery, not workspace switching.
const WS = "ws-1";
vi.mock("../../lib/platform-context", () => {
  // STABLE identities. The pages put `stamp` / `isStale` in useCallback dep
  // arrays; a mock that minted a fresh object per render would re-create the
  // load callbacks every render and spin the load effects forever.
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

// Step-up is PASSTHROUGH here: the challenge ceremony has its own suite. What
// this file must prove is that the wrapped action still fires exactly once
// with the right payload.
vi.mock("../../components/identity-security/StepUpModal", () => {
  // One stable control object, for the same dep-array reason as the tenant
  // guard above.
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
import IdentityRuntimePage from "../../app/(app)/admin/identity/runtime/page";
import PermissionMatrixPage from "../../app/(app)/admin/identity/permission-matrix/page";
import AccessReviewsPage from "../../app/(app)/admin/identity/access-reviews/page";
import ScimPage from "../../app/(app)/admin/identity/scim/page";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ISO = "2026-08-30T10:00:00.000Z";
const SUBJECT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Flush a macrotask too — the confirm dialog's focus timer lands on one. */
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

/** The confirm dialog with the given page-declared testId, or null. */
const modal = (id: string) =>
  q(`[data-confirm-action-modal="${id}"]`) as HTMLElement | null;
/** ANY confirm dialog at all — the reader behind "no dialog appears". */
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

/** toSafeUserError's bounded copy for a 5xx — the page must show THIS, never
 *  the provider's own words. */
const SAFE_500 =
  "Please try again in a moment. Your evidence data has not been changed.";

beforeEach(() => {
  requestLog = [];
  postReply = () => ({ ok: true });
  getReply = () => {
    throw new Error("no GET fixture installed");
  };
});

// ===========================================================================
// 1. /admin/identity/runtime — emergency org-wide revoke
// ===========================================================================

function runtimeGets(path: string): Reply {
  if (path.startsWith("/v1/admin/identity/sessions?")) return { sessions: [] };
  if (path.startsWith("/v1/admin/identity/quarantined-sessions?")) {
    return { items: [] };
  }
  throw new Error(`unexpected GET ${path}`);
}

const REASON = "Compromised credentials";

async function mountRuntime() {
  getReply = runtimeGets;
  await mount(<IdentityRuntimePage />);
}

function typeEmergencyReason(value: string) {
  fireEvent.change(screen.getByTestId("identity-runtime-emergency-reason"), {
    target: { value },
  });
}

async function clickEmergency() {
  await act(async () => {
    fireEvent.click(
      screen.getByTestId("identity-runtime-emergency-revoke-button"),
    );
  });
  await settle();
}

describe("Identity runtime — POST /v1/admin/identity/emergency-revoke", () => {
  it("the control is discoverable, and a short reason is refused BEFORE any dialog or request", async () => {
    await mountRuntime();
    expect(
      screen.getByRole("button", { name: "Emergency org revoke" }),
    ).toBeTruthy();
    typeEmergencyReason("short");
    await clickEmergency();
    expect(document.body.textContent).toContain(
      "Reason must be at least 8 chars.",
    );
    expect(anyModal()).toBeNull();
    expect(posts("/v1/admin/identity/emergency-revoke")).toHaveLength(0);
  });

  it("a valid reason opens the typed-confirm dialog BEFORE any request, and the dialog names the reason and the scope", async () => {
    await mountRuntime();
    typeEmergencyReason(REASON);
    await clickEmergency();

    const dialog = modal("identity-runtime-emergency-revoke");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    const words = descriptionOf(dialog!);
    expect(words).toContain(REASON);
    expect(words).toContain("EVERY active session in this workspace");
    // Nothing has been sent — the dialog comes first.
    expect(posts("/v1/admin/identity/emergency-revoke")).toHaveLength(0);
    // The typed-confirm gate holds the confirm button shut.
    const submit = dialog!.querySelector(
      "[data-confirm-action-submit]",
    ) as HTMLButtonElement;
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.disabled).toBe(true);
  });

  it("cancel sends NOTHING", async () => {
    await mountRuntime();
    typeEmergencyReason(REASON);
    await clickEmergency();
    await cancelModal("identity-runtime-emergency-revoke");
    expect(anyModal()).toBeNull();
    expect(
      requestLog.filter((r) => r.method === "POST"),
    ).toHaveLength(0);
  });

  it("typing REVOKE ALL fires exactly ONE request, and the announcement waits for the runtime re-read", async () => {
    await mountRuntime();
    const dfd = deferred<{ usersRevoked: number; sessionsAffected: number }>();
    postReply = () => dfd.promise;

    typeEmergencyReason(REASON);
    await clickEmergency();
    const sessionReadsBefore = gets("/v1/admin/identity/sessions?").length;
    await submitModal("identity-runtime-emergency-revoke", "REVOKE ALL");

    const revokes = posts("/v1/admin/identity/emergency-revoke");
    expect(revokes).toHaveLength(1);
    expect(JSON.parse(revokes[0].body as string)).toEqual({
      teamId: WS,
      reason: REASON,
    });
    // The response has not resolved: no notice, no re-read yet. (The filter
    // labels legitimately contain the word "Revoked"; the NOTICE is the
    // "Revoked N users" sentence.)
    expect(document.body.textContent).not.toMatch(/Revoked \d+ users/);
    expect(gets("/v1/admin/identity/sessions?").length).toBe(
      sessionReadsBefore,
    );

    dfd.resolve({ usersRevoked: 3, sessionsAffected: 7 });
    await settle();
    await settle();
    // Re-read FIRST, then the notice describing the state now on screen.
    expect(gets("/v1/admin/identity/sessions?").length).toBeGreaterThan(
      sessionReadsBefore,
    );
    expect(document.body.textContent).toContain("Revoked 3 users (7 sessions).");
    // Still exactly one revoke.
    expect(posts("/v1/admin/identity/emergency-revoke")).toHaveLength(1);
  });

  it("a 500 surfaces the safe failure path with no success indicator", async () => {
    await mountRuntime();
    postReply = () => apiFailure(500);
    typeEmergencyReason(REASON);
    await clickEmergency();
    await submitModal("identity-runtime-emergency-revoke", "REVOKE ALL");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(document.body.textContent).not.toMatch(/Revoked \d+ users/);
  });
});

// ===========================================================================
// 2. /admin/identity/runtime — workspace identity-runtime reconcile
// ===========================================================================

describe("Identity runtime — POST /v1/identity-security/reconcile", () => {
  it("confirms first; cancel sends nothing", async () => {
    await mountRuntime();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run reconcile" }));
    });
    await settle();
    const dialog = modal("identity-runtime-reconcile");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain(
      "Reconcile this workspace's identity runtime?",
    );
    expect(posts("/v1/identity-security/reconcile")).toHaveLength(0);
    await cancelModal("identity-runtime-reconcile");
    expect(posts("/v1/identity-security/reconcile")).toHaveLength(0);
  });

  it("confirm fires exactly ONE step-up-wrapped request, and the result is committed only after the reload", async () => {
    await mountRuntime();
    const dfd = deferred<{
      scope: string;
      expiredStepUps: number;
      expiredDevices: number;
    }>();
    postReply = () => dfd.promise;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run reconcile" }));
    });
    await settle();
    const sessionReadsBefore = gets("/v1/admin/identity/sessions?").length;
    await submitModal("identity-runtime-reconcile");

    const reconciles = posts("/v1/identity-security/reconcile");
    expect(reconciles).toHaveLength(1);
    expect(JSON.parse(reconciles[0].body as string)).toEqual({ teamId: WS });
    // Unresolved: no result badges, no reload.
    expect(document.body.textContent).not.toContain("step-up challenges expired");
    expect(gets("/v1/admin/identity/sessions?").length).toBe(
      sessionReadsBefore,
    );

    dfd.resolve({ scope: "workspace", expiredStepUps: 2, expiredDevices: 1 });
    await settle();
    await settle();
    expect(gets("/v1/admin/identity/sessions?").length).toBeGreaterThan(
      sessionReadsBefore,
    );
    expect(document.body.textContent).toContain("2 step-up challenges expired");
    expect(document.body.textContent).toContain("1 device trust withdrawn");
    expect(document.body.textContent).toContain("scope: this workspace");
  });

  it("a 500 surfaces the safe failure and commits no result", async () => {
    await mountRuntime();
    postReply = () => apiFailure(500);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run reconcile" }));
    });
    await settle();
    await submitModal("identity-runtime-reconcile");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("step-up challenges expired");
  });
});

// ===========================================================================
// 3. /admin/identity/permission-matrix — bounded temporary elevation
// ===========================================================================

function matrixGets(path: string): Reply {
  if (path.startsWith("/v1/admin/identity/role-matrix")) {
    return {
      teamId: WS,
      matrix: [
        {
          role: "ADMIN",
          permissions: [{ permission: "evidence.destroy", allowed: true }],
        },
        {
          role: "MEMBER",
          permissions: [{ permission: "evidence.destroy", allowed: false }],
        },
      ],
    };
  }
  if (path.startsWith("/v1/admin/identity/permission-matrix?")) {
    return {
      snapshot: {
        teamId: WS,
        userId: SUBJECT,
        canonicalRole: "MEMBER",
        status: "ACTIVE",
        permissions: [
          {
            permission: "evidence.destroy",
            outcome: "DENY",
            source: "role_default",
            sourceLabel: "Role default",
            reason: "MEMBER does not include this permission.",
          },
        ],
        capabilityGrantCount: 0,
        delegatedScopeCount: 0,
        temporaryElevationCount: 0,
        computedAtUtc: ISO,
      },
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

/** Mount, inspect the subject, pick the DENY row's Elevate…, record a reason. */
async function mountMatrixWithElevationForm() {
  getReply = matrixGets;
  await mount(<PermissionMatrixPage />);
  fireEvent.change(
    q("[data-permission-matrix-subject]") as HTMLInputElement,
    { target: { value: SUBJECT } },
  );
  await act(async () => {
    fireEvent.click(q("[data-permission-matrix-inspect]") as HTMLElement);
  });
  await settle();
  // The Elevate… pick on the denied row is the discoverable route into the form.
  await act(async () => {
    fireEvent.click(
      q('[data-identity-elevation-pick="evidence.destroy"]') as HTMLElement,
    );
  });
  fireEvent.change(q("[data-elevation-reason]") as HTMLInputElement, {
    target: { value: "break-glass fix" },
  });
  await settle();
}

describe("Permission matrix — POST /v1/admin/identity/elevations", () => {
  it("the grant is unreachable without a reason", async () => {
    getReply = matrixGets;
    await mount(<PermissionMatrixPage />);
    fireEvent.change(
      q("[data-permission-matrix-subject]") as HTMLInputElement,
      { target: { value: SUBJECT } },
    );
    await act(async () => {
      fireEvent.click(q("[data-permission-matrix-inspect]") as HTMLElement);
    });
    await settle();
    await act(async () => {
      fireEvent.click(
        q('[data-identity-elevation-pick="evidence.destroy"]') as HTMLElement,
      );
    });
    await settle();
    const submit = q("[data-elevation-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(anyModal()).toBeNull();
    expect(posts("/v1/admin/identity/elevations")).toHaveLength(0);
  });

  it("granting confirms BEFORE any request, and cancel sends nothing", async () => {
    await mountMatrixWithElevationForm();
    await act(async () => {
      fireEvent.click(q("[data-elevation-submit]") as HTMLElement);
    });
    await settle();
    const dialog = modal("identity-temporary-elevation");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain("Grant a temporary elevation?");
    expect(posts("/v1/admin/identity/elevations")).toHaveLength(0);
    await cancelModal("identity-temporary-elevation");
    expect(posts("/v1/admin/identity/elevations")).toHaveLength(0);
  });

  it("confirm fires exactly ONE request with the full bounded payload, then re-reads the snapshot", async () => {
    await mountMatrixWithElevationForm();
    const snapshotReadsBefore = gets(
      "/v1/admin/identity/permission-matrix?",
    ).length;
    await act(async () => {
      fireEvent.click(q("[data-elevation-submit]") as HTMLElement);
    });
    await settle();
    await submitModal("identity-temporary-elevation");

    const grants = posts("/v1/admin/identity/elevations");
    expect(grants).toHaveLength(1);
    expect(JSON.parse(grants[0].body as string)).toEqual({
      teamId: WS,
      userId: SUBJECT,
      permission: "evidence.destroy",
      reason: "break-glass fix",
      ttlSeconds: 3600,
    });
    // The page re-reads the authoritative snapshot rather than patching it.
    expect(gets("/v1/admin/identity/permission-matrix?").length).toBeGreaterThan(
      snapshotReadsBefore,
    );
    // The grant left no failure behind, and the reason field was cleared for
    // the next bounded grant.
    expect(q("[data-elevation-failure]")).toBeNull();
    expect((q("[data-elevation-reason]") as HTMLInputElement).value).toBe("");
    // The success notice SURVIVES the snapshot re-read: the handler awaits
    // `loadSnapshot()` (which resets the panel, notice included) and only
    // then announces — so what the operator reads describes the snapshot now
    // on screen. Announcing first meant the handler's own re-read erased its
    // success message before anyone could read it.
    const notice = q("[data-elevation-notice]") as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain(
      "Elevation granted. The snapshot below now shows it as a temporary-elevation source.",
    );
  });

  it("a 500 lands in the elevation failure region with no notice", async () => {
    await mountMatrixWithElevationForm();
    postReply = () => apiFailure(500);
    await act(async () => {
      fireEvent.click(q("[data-elevation-submit]") as HTMLElement);
    });
    await settle();
    await submitModal("identity-temporary-elevation");
    const failure = q("[data-elevation-failure]") as HTMLElement;
    expect(failure).not.toBeNull();
    expect(failure.textContent).toContain(SAFE_500);
    expect(failure.textContent).not.toContain("request failed");
    expect(q("[data-elevation-notice]")).toBeNull();
  });
});

// ===========================================================================
// 4. /admin/identity/access-reviews — regenerate + decision
// ===========================================================================

function reviewsGets(path: string): Reply {
  if (path.startsWith("/v1/identity/access-reviews")) {
    return {
      accessReviews: [
        {
          id: "r1",
          kind: "STALE_ACCESS",
          status: "PENDING",
          subjectKind: "MEMBER",
          subjectUserId: SUBJECT,
          subjectApiCredentialId: null,
          initiatedAtUtc: ISO,
          dueAtUtc: ISO,
          completedAtUtc: null,
          decisionNote: null,
        },
      ],
      limit: 50,
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountReviews() {
  getReply = reviewsGets;
  await mount(<AccessReviewsPage />);
}

describe("Access reviews — POST /v1/identity/access-reviews/regenerate", () => {
  it("confirms first, cancel sends nothing, confirm posts an empty body ONCE and re-reads the queue", async () => {
    await mountReviews();
    await act(async () => {
      fireEvent.click(q("[data-access-review-regenerate]") as HTMLElement);
    });
    await settle();
    const dialog = modal("identity-access-review-regenerate");
    expect(dialog).not.toBeNull();
    expect(posts("/v1/identity/access-reviews/regenerate")).toHaveLength(0);
    await cancelModal("identity-access-review-regenerate");
    expect(posts("/v1/identity/access-reviews/regenerate")).toHaveLength(0);

    postReply = () => ({ created: 3 });
    const listReadsBefore = gets("/v1/identity/access-reviews").length;
    await act(async () => {
      fireEvent.click(q("[data-access-review-regenerate]") as HTMLElement);
    });
    await settle();
    await submitModal("identity-access-review-regenerate");

    const regens = posts("/v1/identity/access-reviews/regenerate");
    expect(regens).toHaveLength(1);
    expect(JSON.parse(regens[0].body as string)).toEqual({});
    expect(document.body.textContent).toContain(
      "3 new review items added to the queue.",
    );
    expect(gets("/v1/identity/access-reviews").length).toBeGreaterThan(
      listReadsBefore,
    );
  });
});

describe("Access reviews — POST /v1/identity/access-reviews/:id/decision", () => {
  it("Certify (KEEP) confirms, then posts the server's decision vocabulary once", async () => {
    await mountReviews();
    await act(async () => {
      fireEvent.click(q('[data-access-review-decision="r1:KEEP"]') as HTMLElement);
    });
    await settle();
    const dialog = modal("identity-access-review-keep");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain("Certify this access?");
    expect(posts("/v1/identity/access-reviews/r1/decision")).toHaveLength(0);
    await submitModal("identity-access-review-keep");

    const decisions = posts("/v1/identity/access-reviews/r1/decision");
    expect(decisions).toHaveLength(1);
    // No note typed: the payload carries the decision and NOTHING else.
    expect(JSON.parse(decisions[0].body as string)).toEqual({
      decision: "KEEP",
    });
    expect(
      (q('[data-access-review-result="ok"]') as HTMLElement).textContent,
    ).toContain("Recorded: Certify.");
  });

  it("Revoke without a note is refused locally — no dialog, no request", async () => {
    await mountReviews();
    await act(async () => {
      fireEvent.click(
        q('[data-access-review-decision="r1:REVOKE_MEMBER"]') as HTMLElement,
      );
    });
    await settle();
    expect(anyModal()).toBeNull();
    expect(posts("/v1/identity/access-reviews/r1/decision")).toHaveLength(0);
    expect(
      (q('[data-access-review-result="failed"]') as HTMLElement).textContent,
    ).toContain("This decision needs a note.");
  });

  it("Revoke with a note opens the danger dialog and carries the note in the payload", async () => {
    await mountReviews();
    fireEvent.change(q("[data-access-review-note]") as HTMLInputElement, {
      target: { value: "contractor rolled off" },
    });
    await act(async () => {
      fireEvent.click(
        q('[data-access-review-decision="r1:REVOKE_MEMBER"]') as HTMLElement,
      );
    });
    await settle();
    const dialog = modal("identity-access-review-revoke_member");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("data-confirm-action-tone")).toBe("danger");
    await submitModal("identity-access-review-revoke_member");

    const decisions = posts("/v1/identity/access-reviews/r1/decision");
    expect(decisions).toHaveLength(1);
    expect(JSON.parse(decisions[0].body as string)).toEqual({
      decision: "REVOKE_MEMBER",
      decisionNote: "contractor rolled off",
    });
  });

  it("a 500 lands in the row's failure result with no success wording", async () => {
    await mountReviews();
    postReply = () => apiFailure(500);
    await act(async () => {
      fireEvent.click(q('[data-access-review-decision="r1:KEEP"]') as HTMLElement);
    });
    await settle();
    await submitModal("identity-access-review-keep");
    const failed = q('[data-access-review-result="failed"]') as HTMLElement;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("Recorded:");
  });
});

// ===========================================================================
// 5. /admin/identity/scim (ReplayTab) — sync-failure replay
// ===========================================================================

function scimGets(path: string): Reply {
  if (path.startsWith("/v1/admin/identity/scim/tokens")) return { tokens: [] };
  if (path.startsWith("/v1/scim/sync-failures?")) {
    return {
      failures: [
        {
          id: "f1",
          occurredAtUtc: ISO,
          eventType: "scim_user_create_failed",
          severity: "WARNING",
          summary: "User create failed upstream",
          retryEligible: true,
          terminal: false,
        },
        {
          id: "f2",
          occurredAtUtc: ISO,
          eventType: "scim_invalid_token",
          severity: "HIGH",
          summary: "Bearer token rejected",
          retryEligible: false,
          terminal: true,
        },
      ],
      total: 2,
      limit: 100,
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountReplayTab() {
  getReply = scimGets;
  await mount(<ScimPage />);
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Sync replay" }));
  });
  await settle();
}

describe("SCIM ReplayTab — POST /v1/scim/sync-failures/:id/replay", () => {
  it("loads the failures envelope and offers Replay ONLY on eligible rows", async () => {
    await mountReplayTab();
    expect(gets("/v1/scim/sync-failures?")).toHaveLength(1);
    const table = screen.getByRole("table", { name: "SCIM sync failures" });
    const replayButtons = within(table).getAllByRole("button", {
      name: "Replay",
    });
    expect(replayButtons).toHaveLength(1);
    expect(within(table).getByText("Not replayable")).toBeTruthy();
    expect(within(table).getByText("TERMINAL")).toBeTruthy();
  });

  it("Replay confirms BEFORE any request and names the failure; cancel sends nothing", async () => {
    await mountReplayTab();
    const table = screen.getByRole("table", { name: "SCIM sync failures" });
    await act(async () => {
      fireEvent.click(within(table).getByRole("button", { name: "Replay" }));
    });
    await settle();
    const dialog = modal("scim-replay-failure");
    expect(dialog).not.toBeNull();
    expect(descriptionOf(dialog!)).toContain("scim_user_create_failed");
    expect(posts("/v1/scim/sync-failures/")).toHaveLength(0);
    await cancelModal("scim-replay-failure");
    expect(posts("/v1/scim/sync-failures/")).toHaveLength(0);
  });

  it("confirm fires exactly ONE replay with the workspace claim, then re-reads the queue and announces", async () => {
    await mountReplayTab();
    const table = screen.getByRole("table", { name: "SCIM sync failures" });
    const listReadsBefore = gets("/v1/scim/sync-failures?").length;
    await act(async () => {
      fireEvent.click(within(table).getByRole("button", { name: "Replay" }));
    });
    await settle();
    await submitModal("scim-replay-failure");

    const replays = posts("/v1/scim/sync-failures/");
    expect(replays).toHaveLength(1);
    expect(replays[0].path).toBe("/v1/scim/sync-failures/f1/replay");
    expect(JSON.parse(replays[0].body as string)).toEqual({ teamId: WS });
    expect(document.body.textContent).toContain("Replay recorded.");
    expect(gets("/v1/scim/sync-failures?").length).toBeGreaterThan(
      listReadsBefore,
    );
  });

  it("a 500 surfaces the safe failure and no success box", async () => {
    await mountReplayTab();
    postReply = () => apiFailure(500);
    const table = screen.getByRole("table", { name: "SCIM sync failures" });
    await act(async () => {
      fireEvent.click(within(table).getByRole("button", { name: "Replay" }));
    });
    await settle();
    await submitModal("scim-replay-failure");
    expect(document.body.textContent).toContain(SAFE_500);
    expect(document.body.textContent).not.toContain("request failed");
    expect(document.body.textContent).not.toContain("Replay recorded.");
  });
});
