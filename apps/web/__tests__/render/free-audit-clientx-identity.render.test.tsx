/**
 * Free-user audit 0ea0 — CLIENT-X: the web identity / collaboration halves of
 * the API-lane cross-lane requests, over the REAL apiFetch (fetch mocked)
 * wherever a server answer is read.
 *
 *   B1-F-003          security center: `scope: "self"` lists offer no Revoke; a 403 policy-impact card is hidden
 *   R1-F-05           thread assignment offers only members who can review; 422 assignee_not_eligible is named
 *   B3A-F-008         reopen answers a step-up challenge with the closure sheet; 404 team_not_found copy
 *   B1-F-020          MFA self-check no longer warns that checking spends a backup code (consumed:false)
 *   B7A-F-003         operator reconcile: scheduler-only legs say so
 *   B5B-F-303 et al.  a Viewer saves SIU views as private; Make Default only on own views
 *   B3B-F-101/102     intake send 409 INTAKE_NOT_INCLUDED / delivery_in_progress copy
 *   B3A-F-002         API key revoked for creator_lost_authority says so
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const guard = { stamp: () => 0, isStale: () => false };
type Ctx = { envelope: Record<string, unknown> | null };
let ctx: Ctx = { envelope: null };

vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTeamId: () => "team-1",
  useTenantGuard: () => guard,
}));
vi.mock("../../lib/platform-context/PlatformContextProvider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPlatformContext: () => ctx,
}));
vi.mock("../../components/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ addToast: vi.fn() }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true, askReason: async () => "reason" }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({
  AccessAnomaliesCard: () => null,
  OrgHealthSnapshotCard: () => null,
}));
vi.mock("../../app/(app)/security-center/components/CaptureDevicesSection", () => ({
  CaptureDevicesSection: () => null,
}));
vi.mock("../../components/mfa-recovery/MfaRecoveryRequestPanel", () => ({
  MfaRecoveryRequestPanel: () => null,
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import SecurityCenterPage from "../../app/(app)/security-center/page";
import { TrustedDevicesSection } from "../../app/(app)/security-center/identity/sessions/_sections/TrustedDevicesSection";
import { SessionPolicyImpactSection } from "../../app/(app)/security-center/identity/sessions/_sections/SessionPolicyImpactSection";
import { SessionGovernanceSection } from "../../app/(app)/security-center/identity/_sections/SessionGovernanceSection";
import { MfaSelfCheckSection } from "../../app/(app)/security-center/posture/_sections/MfaSelfCheckSection";
import { WorkspaceMemberSelect } from "../../app/(app)/evidence/[id]/components/WorkspaceMemberSelect";
import { safeMessage } from "../../app/(app)/evidence/[id]/components/DiscussionThreadLifecycle";
import { WorkspaceClosureCard } from "../../app/(app)/teams/[id]/components/WorkspaceClosureCard";
import { SiuWorklistPanel } from "../../app/(app)/cases/components/SiuWorklistPanel";
import { SavedViewsMenu } from "../../app/(app)/evidence/components/SavedViewsMenu";
import { LinkCreatedDialog } from "../../app/(app)/intake-links/_components/LinkCreatedDialog";
import type { EvidenceSavedView } from "../../app/(app)/evidence/lib/evidence-library-types";
import type { CreatedIntakeLink } from "../../app/(app)/intake-links/_lib/types";
import { apiFetch, setActiveWorkspaceId } from "../../lib/api";
import { mayShareSavedViewsIn } from "../../lib/evidence/saved-view-sharing";
import { apiKeyRevocationNote } from "../../lib/integrations/api-key-revocation";

type Reply = { status?: number; body?: unknown };
type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => Reply> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  ctx = { envelope: null };
  setActiveWorkspaceId("team-1");
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const call: Call = {
      path,
      method: (init.method ?? "GET").toUpperCase(),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => `${call.method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? routes[key](call) : { status: 404, body: { error: { code: "not_found" } } };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.path.includes(suffix));

// ---------------------------------------------------------------------------
// B1-F-003
// ---------------------------------------------------------------------------
const DEVICE = {
  id: "dev-1",
  userId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  uaPreview: "Firefox",
  ipPreview: "10.0.x.x",
  status: "ACTIVE",
  trustedUntilUtc: "2026-12-01T00:00:00.000Z",
  firstSeenAtUtc: "2026-11-01T00:00:00.000Z",
  lastSeenAtUtc: "2026-11-10T00:00:00.000Z",
  revokedAtUtc: null,
};
const REVOCATION = {
  id: "rev-1",
  userId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scope: "ALL_FOR_USER",
  reason: "OPERATOR_REVOKED",
  revokedAtUtc: "2026-11-10T00:00:00.000Z",
  revokedByUserId: null,
};

function securityRoutes(scope: "self" | "team" | undefined) {
  const s = scope ? { scope } : {};
  routes = {
    "GET /v1/identity-security/mfa-policy": () => ({
      body: {
        policy: { teamId: "team-1", level: "OFF", stepUpTtlSeconds: 300, trustedDeviceTtlDays: 30, mfaRequiredFlag: false, ssoReadyFlag: false, scimReadyFlag: false },
        currentUserRequirement: { required: false, reason: "off", policyLevel: "OFF" },
      },
    }),
    "GET /v1/identity-security/devices": () => ({ body: { devices: [DEVICE], ...s } }),
    "GET /v1/identity-security/sessions": () => ({ body: { revoked: [REVOCATION], ...s } }),
    "GET /v1/identity-security/risk/me": () => ({ body: { level: "LOW", score: 1, signalCount: 0 } }),
    "GET /v1/identity/mfa/factors": () => ({ body: { hasMfa: true, factors: [], recoveryCodesRemaining: 5 } }),
    "GET /v1/identity/mfa-admin/recovery-requests": () => ({ status: 403, body: { error: { code: "permission_denied" } } }),
  };
}

describe("B1-F-003: security telemetry honours scope", () => {
  it("a read-only role (scope self) sees its own devices and revocations with no Revoke buttons", async () => {
    securityRoutes("self");
    render(<SecurityCenterPage />);
    await screen.findByText("Your trusted devices");
    expect(screen.getByText("Your recent session revocations")).toBeTruthy();
    expect(q("[data-cc-devices-self-note]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke all for user" })).toBeNull();
  });

  it("an administrator (scope team) keeps the member-wide lists and their Revoke buttons", async () => {
    securityRoutes("team");
    render(<SecurityCenterPage />);
    await screen.findByRole("button", { name: "Revoke" });
    expect(screen.getByRole("button", { name: "Revoke all for user" })).toBeTruthy();
    expect(screen.queryByText("Your trusted devices")).toBeNull();
  });

  it("an older API without scope renders exactly as before", async () => {
    securityRoutes(undefined);
    render(<SecurityCenterPage />);
    await screen.findByRole("button", { name: "Revoke" });
    expect(screen.getByText("Trusted devices")).toBeTruthy();
  });

  it("the sessions console's trusted-devices card offers neither trust nor remove-trust on a self list", async () => {
    routes = { "GET /v1/identity-security/devices": () => ({ body: { devices: [DEVICE], scope: "self" } }) };
    render(<TrustedDevicesSection />);
    await waitFor(() => expect(q('[data-trusted-devices-scope="self"]')).not.toBeNull());
    expect(screen.getByText("Your trusted devices")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove trust" })).toBeNull();
    expect(q("[data-trusted-device-trust-self]")).toBeNull();
  });

  it("a 403 on session-policy impact hides the administrator card instead of showing a refusal", async () => {
    routes = {
      "GET /v1/identity-security/session-policy-impact": () => ({ status: 403, body: { error: { code: "permission_denied" } } }),
    };
    const { container } = render(<SessionPolicyImpactSection />);
    await waitFor(() =>
      expect(calls.some((c) => c.path.startsWith("/v1/identity-security/session-policy-impact"))).toBe(true),
    );
    await flush();
    await flush();
    expect(container.textContent).not.toMatch(/Session policy impact/);
  });
});

// ---------------------------------------------------------------------------
// R1-F-05
// ---------------------------------------------------------------------------
describe("R1-F-05: thread assignment offers only members who can review", () => {
  it("a Viewer is not offered when the picker requires evidence_request.review", async () => {
    routes = {
      "GET /v1/teams/team-1/members": () => ({
        body: {
          members: [
            { userId: "u-admin", label: "Ada Admin", role: "ADMIN", status: "ACTIVE" },
            { userId: "u-member", label: "Mo Member", role: "MEMBER", status: "ACTIVE" },
            { userId: "u-viewer", label: "Vi Viewer", role: "VIEWER", status: "ACTIVE" },
          ],
          nextCursor: null,
        },
      }),
    };
    render(
      <WorkspaceMemberSelect
        teamId="team-1"
        id="assignee"
        label="Assign to"
        value={null}
        onChange={() => undefined}
        requiredPermission="evidence_request.review"
      />,
    );
    const trigger = await waitFor(() => {
      const el = document.getElementById("assignee");
      if (!el) throw new Error("listbox not rendered");
      return el;
    });
    fireEvent.click(trigger);
    const options = await screen.findAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Ada Admin"))).toBe(true);
    expect(labels.some((l) => l.includes("Mo Member"))).toBe(true);
    expect(labels.some((l) => l.includes("Vi Viewer"))).toBe(false);
  });

  it("the thread lifecycle's assign picker asks for evidence_request.review", () => {
    const src = readFileSync(
      resolve(__dirname, "../../app/(app)/evidence/[id]/components/DiscussionThreadLifecycle.tsx"),
      "utf8",
    );
    expect(src).toMatch(/requiredPermission="evidence_request\.review"/);
  });

  it("a 422 assignee_not_eligible from the real apiFetch is named, not generic", async () => {
    routes = {
      "POST /v1/collaboration/threads/t-1/assign": () => ({
        status: 422,
        body: { error: { code: "assignee_not_eligible", details: null } },
      }),
    };
    const err = await apiFetch("/v1/collaboration/threads/t-1/assign", {
      method: "POST",
      body: JSON.stringify({ teamId: "team-1", assigneeUserId: "u-viewer" }),
    }).catch((e: unknown) => e);
    expect(safeMessage(err, "The thread could not be updated.")).toMatch(/can't be assigned this thread/);
  });
});

// ---------------------------------------------------------------------------
// B3A-F-008
// ---------------------------------------------------------------------------
const CLOSED = {
  request: {
    id: "req-1",
    status: "COMPLETED",
    blockersJson: null,
    requestedAtUtc: "2026-10-01T00:00:00.000Z",
    coolingOffEndsAtUtc: null,
    failureCode: null,
  },
  blockers: [],
  confirmationPhrase: "CLOSE",
  coolingOffDays: 7,
  membersLosingAccess: 0,
};

describe("B3A-F-008: reopen carries account step-up; a non-owner reads 404 copy", () => {
  it("a STEP_UP_REQUIRED answer opens the sheet and the retry carries the stepUp proof", async () => {
    routes = {
      "GET /v1/teams/team-1/closure": () => ({ body: CLOSED }),
      "POST /v1/teams/team-1/reopen": (call) =>
        (call.body as { stepUp?: unknown })?.stepUp
          ? { body: { reopened: { teamId: "team-1" } } }
          : { status: 403, body: { error: { code: "STEP_UP_REQUIRED", methods: ["password"] } } },
    };
    render(<WorkspaceClosureCard teamId="team-1" />);
    const button = await waitFor(() => {
      const el = q<HTMLButtonElement>('[data-action="reopen-workspace"]');
      if (!el) throw new Error("no reopen");
      return el;
    });
    fireEvent.click(button);
    const input = await waitFor(() => {
      const el = q<HTMLInputElement>("[data-cc-step-up-input]");
      if (!el) throw new Error("no step-up sheet");
      return el;
    });
    expect(screen.getByText("Confirm reopening this workspace.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "pw-test" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(posts("/reopen").length).toBe(2));
    expect(posts("/reopen")[1].body).toEqual({ stepUp: { method: "password", currentPassword: "pw-test" } });
    await screen.findByText(/Workspace reopened/);
  });

  it("404 team_not_found (a non-owner) says not found or not the owner", async () => {
    routes = {
      "GET /v1/teams/team-1/closure": () => ({ body: CLOSED }),
      "POST /v1/teams/team-1/reopen": () => ({ status: 404, body: { error: { code: "team_not_found" } } }),
    };
    render(<WorkspaceClosureCard teamId="team-1" />);
    const button = await waitFor(() => {
      const el = q<HTMLButtonElement>('[data-action="reopen-workspace"]');
      if (!el) throw new Error("no reopen");
      return el;
    });
    fireEvent.click(button);
    await screen.findByText(/could not be found, or you are not its owner/);
  });
});

// ---------------------------------------------------------------------------
// B1-F-020
// ---------------------------------------------------------------------------
describe("B1-F-020: checking a backup code does not spend it", () => {
  it("the copy no longer warns that a verified backup code is used up, and consumed:false says it stays valid", async () => {
    routes = {
      "POST /v1/identity/mfa/challenge/verify": () => ({ body: { ok: true, used: "recovery_code", consumed: false } }),
    };
    render(<MfaSelfCheckSection />);
    fireEvent.click(screen.getByLabelText(/Backup code/));
    expect(document.body.textContent).not.toMatch(/USED UP/);
    expect(document.body.textContent).toMatch(/does not use it up/);
    const input = q<HTMLInputElement>("[data-mfa-self-check-input]")!;
    fireEvent.change(input, { target: { value: "ABCD-EFGH" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(q('[data-mfa-self-check-result="verified"]')).not.toBeNull());
    expect(q("[data-mfa-self-check-backup-state]")?.textContent).toMatch(/still valid/);
  });

  it("an older server that still consumed the code (no consumed field) is not told it stays valid", async () => {
    routes = {
      "POST /v1/identity/mfa/challenge/verify": () => ({ body: { ok: true, used: "recovery_code" } }),
    };
    render(<MfaSelfCheckSection />);
    fireEvent.click(screen.getByLabelText(/Backup code/));
    const input = q<HTMLInputElement>("[data-mfa-self-check-input]")!;
    fireEvent.change(input, { target: { value: "ABCD-EFGH" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(q("[data-mfa-self-check-backup-state]")).not.toBeNull());
    expect(q("[data-mfa-self-check-backup-state]")?.textContent).toMatch(/used the backup code up/);
  });
});

// ---------------------------------------------------------------------------
// B7A-F-003
// ---------------------------------------------------------------------------
describe("B7A-F-003: operator reconcile states the scheduler-only legs", () => {
  it("skipped legs read 'Platform clean-up runs on the scheduler', and the panel no longer claims a geo sweep", async () => {
    routes = {
      "POST /v1/admin/identity/sessions/reconcile-stale": () => ({
        body: {
          sessions: { scanned: 3, staleDetected: 1, swept: 1 },
          callbackAttempts: { swept: 0, skipped: "scheduler_only" },
        },
      }),
      "POST /v1/admin/identity/runtime/reconcile": () => ({
        body: {
          risk: { scanned: 2, recomputed: 2, skippedCooldown: 0, escalatedToQuarantine: 0, highRiskCount: 0 },
          decay: { scanned: 1, decayed: 0, autoInvalidated: 0, quarantined: 0 },
          releases: { released: 0 },
          geo: { swept: 0, remaining: null, skipped: "scheduler_only" },
        },
      }),
    };
    const stepUp = { runStepUpAction: <T,>(fn: (h?: Record<string, string>) => Promise<T>) => fn() };
    render(<SessionGovernanceSection stepUp={stepUp} />);
    expect(document.body.textContent).not.toMatch(/sweeps the geo cache/);
    fireEvent.click(q("[data-identity-reconcile-stale]")!);
    await waitFor(() => expect(q("[data-identity-reconcile-stale-result]")).not.toBeNull());
    fireEvent.click(q("[data-identity-reconcile-runtime]")!);
    await waitFor(() => expect(q("[data-identity-reconcile-runtime-result]")).not.toBeNull());
    const notes = Array.from(document.querySelectorAll("[data-identity-reconcile-scheduler-only]")).map(
      (n) => n.textContent,
    );
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toMatch(/Platform clean-up runs on the scheduler/);
  });
});

// ---------------------------------------------------------------------------
// B5B-F-303 / B2A-F-09 / B5A-F-14
// ---------------------------------------------------------------------------
const viewerEnvelope = {
  user: { id: "me" },
  workspace: { id: "team-1", membership: { role: "VIEWER" } },
  contextOptions: { ownedWorkspaces: [{ workspaceId: "team-1", name: "Claims", role: "VIEWER" }] },
};
const memberEnvelope = {
  user: { id: "me" },
  workspace: { id: "team-1", membership: { role: "MEMBER" } },
  contextOptions: { ownedWorkspaces: [{ workspaceId: "team-1", name: "Claims", role: "MEMBER" }] },
};

function siuRoutes() {
  routes = {
    "GET /v1/siu/saved-views/custom": () => ({ body: { views: [] } }),
    "GET /v1/siu/saved-views": () => ({ body: { views: [] } }),
    "GET /v1/siu/intake-templates": () => ({ body: { templates: [] } }),
    "POST /v1/siu/saved-views": () => ({ body: { view: { id: "v-new" } } }),
  };
}

async function createSiuView() {
  render(<SiuWorklistPanel teamId="team-1" />);
  const name = await screen.findByTestId("siu-draft-name");
  fireEvent.change(name, { target: { value: "My queue" } });
  fireEvent.click(screen.getByTestId("siu-create-view"));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/siu/saved-views")).toBe(true));
  return calls.find((c) => c.method === "POST" && c.path === "/v1/siu/saved-views")!.body as { visibility: string };
}

describe("A2-14 saved views: a Viewer saves a personal view, never a shared one", () => {
  it("SIU: a Viewer's Save view is sent as private", async () => {
    ctx = { envelope: viewerEnvelope };
    siuRoutes();
    expect((await createSiuView()).visibility).toBe("private");
  });

  it("SIU: a Member (and an unknown role) still create a team view", async () => {
    ctx = { envelope: memberEnvelope };
    siuRoutes();
    expect((await createSiuView()).visibility).toBe("team");
  });

  it("evidence library: a Viewer is offered no team scope (teamId stays null); a Member is", () => {
    expect(mayShareSavedViewsIn(viewerEnvelope as never, "team-1")).toBe(false);
    expect(mayShareSavedViewsIn(memberEnvelope as never, "team-1")).toBe(true);
    expect(mayShareSavedViewsIn(null, "team-1")).toBe(true);
    const src = readFileSync(resolve(__dirname, "../../app/(app)/evidence/page.tsx"), "utf8");
    // PRO-E1-08 (WS-ENT) — the list now also offers the ACTIVE workspace (an
    // ADMIN/MEMBER of someone else's workspace may share there), so the rule
    // is applied to the merged {id, name} options.
    expect(src).toMatch(/\.filter\(\(workspace\) => mayShareSavedViewsIn\(envelope, workspace\.id\)\)/);
  });

  it("Make Default is offered only on the caller's own views, and a colleague's rename omits isDefault", async () => {
    // PRO-E1-08 (WS-ENT) — Rename / Delete on a COLLEAGUE's team view are the
    // workspace OWNER's / ADMIN's (assertSavedViewAccess); a MEMBER is no
    // longer offered them. This case is the admin renaming a colleague's view.
    ctx = {
      envelope: {
        user: { id: "me" },
        workspace: { id: "team-1", membership: { role: "ADMIN" } },
        contextOptions: { ownedWorkspaces: [{ workspaceId: "team-1", name: "Claims", role: "ADMIN" }] },
      },
    };
    const view = (id: string, ownerUserId: string): EvidenceSavedView => ({
      id,
      ownerUserId,
      teamId: "team-1",
      name: id,
      description: null,
      filters: { sort: "newest" } as EvidenceSavedView["filters"],
      sortKey: null,
      scope: "ALL" as EvidenceSavedView["scope"],
      isDefault: false,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const onUpdateView = vi.fn(async () => undefined);
    render(
      <SavedViewsMenu
        views={[view("mine", "me"), view("theirs", "colleague")]}
        teamOptions={[]}
        currentUserId="me"
        onApplyView={() => undefined}
        onCreateView={async () => undefined}
        onUpdateView={onUpdateView}
        onDeleteView={async () => undefined}
        onSetDefault={async () => undefined}
      />,
    );
    fireEvent.click(q("[data-evidence-saved-views-trigger]")!);
    await waitFor(() => expect(document.querySelectorAll("[data-evidence-saved-view-make-default]").length).toBe(1));
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[1]);
    await screen.findByRole("button", { name: "Update View" });
    expect(screen.queryByText("Make this my default view")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update View" }));
    await waitFor(() => expect(onUpdateView).toHaveBeenCalled());
    expect(onUpdateView.mock.calls[0]).toEqual(["theirs", { name: "theirs", description: "" }]);
  });
});

// ---------------------------------------------------------------------------
// B3B-F-101 / B3B-F-102
// ---------------------------------------------------------------------------
const CREATED = {
  link: { id: "link-1", hasRecipientEmail: true, hasRecipientPhone: false },
  rawToken: "tok-test",
  delivery: { method: "MANUAL", status: "skipped" },
} as unknown as CreatedIntakeLink;

describe("B3B-F-101 / B3B-F-102: intake send refusals in words", () => {
  it("409 INTAKE_NOT_INCLUDED names the plan", async () => {
    routes = {
      "POST /v1/workflow/intake-links/link-1/send": () => ({
        status: 409,
        body: { error: { code: "INTAKE_NOT_INCLUDED", message: "Secure intake is not included." } },
      }),
    };
    render(<LinkCreatedDialog created={CREATED} intakeUrl="https://example.test/i" onClose={() => undefined} />);
    fireEvent.click(q('[data-intake-link-send="EMAIL"]')!);
    await waitFor(() => expect(q("[data-intake-link-send-error]")).not.toBeNull());
    expect(q("[data-intake-link-send-error]")!.textContent).toBe(
      "Secure intake is not included in this workspace's plan.",
    );
  });

  it("409 delivery_in_progress says it is already sending", async () => {
    routes = {
      "POST /v1/workflow/intake-links/link-1/send": () => ({
        status: 409,
        body: { error: { code: "delivery_in_progress" } },
      }),
    };
    render(<LinkCreatedDialog created={CREATED} intakeUrl="https://example.test/i" onClose={() => undefined} />);
    fireEvent.click(q('[data-intake-link-send="EMAIL"]')!);
    await waitFor(() => expect(q("[data-intake-link-send-error]")).not.toBeNull());
    expect(q("[data-intake-link-send-error]")!.textContent).toBe("Already sending — check again in a moment.");
  });

  it("B3A-F-002: a key revoked for creator_lost_authority is labelled", () => {
    expect(apiKeyRevocationNote("creator_lost_authority")).toMatch(/no longer holds the authority/);
    expect(apiKeyRevocationNote("creator_removed")).toMatch(/left the workspace/);
    expect(apiKeyRevocationNote("typed by a person")).toBeNull();
    const src = readFileSync(resolve(__dirname, "../../app/(app)/integrations/page.tsx"), "utf8");
    expect(src).toMatch(/from "\.\.\/\.\.\/\.\.\/lib\/integrations\/api-key-revocation"/);
  });
});
