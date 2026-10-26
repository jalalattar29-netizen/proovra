/**
 * SECOND RE-AUDIT INV-03 + MEM-03 — the workspace People page, rendered.
 *
 * INV-03: creating an invitation whose email could not be delivered
 * (`emailSent: false`) is not reported as "sent" — the person is told the
 * invitation exists and to use Resend. A repeat invitation (`existing: true`)
 * says it was already pending. Positive control: a delivered invitation says so.
 *
 * MEM-03: a failed activity read renders the error state with a retry, never
 * an empty panel; positive control: a successful read renders the events.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  platform: { envelope: { user: { id: "me-user" } }, contextGeneration: 1 },
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => false }) }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui", async (orig) => ({ ...((await orig()) as object), useToast: () => ({ addToast: mocks.toast }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../lib/platform-context", async (orig) => ({ ...((await orig()) as object), usePlatformContext: () => mocks.platform }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/people",
  useSearchParams: () => new URLSearchParams(),
}));

import TeamDetailPage from "../../app/(app)/teams/[id]/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITE = "11111111-1111-4111-8111-111111111111";
const NEW_EMAIL = "new.person@example.org";

type CreateAnswer = { emailSent: boolean; existing: boolean };
let createAnswer: CreateAnswer = { emailSent: true, existing: false };
let activityFails = false;

function reply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path === `/v1/teams/${TEAM}/invites`) {
    return {
      invite: {
        id: INVITE, email: NEW_EMAIL, role: "MEMBER", status: "PENDING",
        createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", acceptedAt: null,
      },
      ...createAnswer,
      // The server's own sentence is never shown (it says "created successfully").
      message: createAnswer.emailSent ? "Invitation sent successfully" : "Invitation created successfully",
    };
  }
  if (path === `/v1/teams/${TEAM}`) {
    return { id: TEAM, name: "Casework", ownerUserId: "owner", canManageMembers: true, stats: { memberCount: 1, pendingInviteCount: 0, caseCount: 0 }, members: [] };
  }
  if (path === `/v1/teams/${TEAM}/invites`) return { invites: [] };
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return { members: [], nextCursor: null, total: 0 };
  if (path === `/v1/teams/${TEAM}/cases`) return { items: [] };
  if (path === `/v1/teams/${TEAM}/activity`) {
    if (activityFails) throw { statusCode: 503, code: "SERVICE_UNAVAILABLE" };
    return {
      activities: [
        { id: "act-1", eventType: "invite_created", targetType: "invite", createdAt: "2026-10-01T00:00:00.000Z", actor: { id: "owner", displayName: "Olivia Owner" }, metadata: {} },
      ],
    };
  }
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  return {};
}

beforeEach(() => {
  createAnswer = { emailSent: true, existing: false };
  activityFails = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.toast.mockReset();
});
afterEach(cleanup);

async function createInvite() {
  render(<TeamDetailPage />);
  fireEvent.click(await screen.findByTestId("people-invite-open"));
  fireEvent.change(await screen.findByTestId("people-invite-email"), { target: { value: NEW_EMAIL } });
  fireEvent.click(screen.getByTestId("people-invite-submit"));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.some(([p, init]) => p === `/v1/teams/${TEAM}/invites` && init?.method === "POST")).toBe(true),
  );
}

describe("INV-03 — the create-invite toast says what the server did", () => {
  it("emailSent:false → a warning naming Resend, never 'sent'", async () => {
    createAnswer = { emailSent: false, existing: false };
    await createInvite();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        `The invitation for ${NEW_EMAIL} was created, but the email could not be delivered. Use Resend to try again.`,
        "warning",
      ),
    );
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
    expect(mocks.toast).not.toHaveBeenCalledWith("Invitation created successfully", expect.anything());
  });

  it("positive control: emailSent:true → 'Invitation sent'", async () => {
    await createInvite();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(`Invitation sent to ${NEW_EMAIL}.`, "success"));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "warning");
  });

  it("existing:true (a repeat invitation) → says it was already pending and sent again", async () => {
    createAnswer = { emailSent: true, existing: true };
    await createInvite();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        `An invitation for ${NEW_EMAIL} was already pending. It has been sent again.`,
        "success",
      ),
    );
  });
});

describe("MEM-03 — a failed activity read is said, not shown as no activity", () => {
  it("renders the error state with a retry that re-reads the activity", async () => {
    activityFails = true;
    render(<TeamDetailPage />);
    const panel = await screen.findByTestId("people-activity-error");
    expect(panel.textContent).toContain("Recent activity could not be loaded.");
    expect(screen.queryByTestId("people-activity")).toBeNull();

    const reads = () => mocks.fetch.mock.calls.filter(([p]) => p === `/v1/teams/${TEAM}/activity`).length;
    const before = reads();
    activityFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await screen.findByTestId("people-activity");
    expect(screen.queryByTestId("people-activity-error")).toBeNull();
  });

  it("positive control: a successful read renders the activity panel, no error", async () => {
    render(<TeamDetailPage />);
    await screen.findByTestId("people-activity");
    expect(screen.queryByTestId("people-activity-error")).toBeNull();
  });
});
