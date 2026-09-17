/**
 * D46 — the ownership-transfer picker reaches EVERY eligible member.
 *
 * The picker used to be fed the members embedded in `GET /v1/teams/:id`, a
 * bounded first page of 50, so the 51st eligible member could never be chosen.
 * It now reads `GET /v1/teams/:id/members?eligible=ownership_transfer`, where
 * the server applies eligibility, search and paging.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  platform: { envelope: { user: { id: "user-owner" } }, contextGeneration: 1 },
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
vi.mock("../../app/(app)/security-center/components/PersonalSecuritySections", () => ({
  StepUpVerify: () => null,
  extractStepUp: () => null,
}));

import { WorkspaceOwnershipTransferCard } from "../../app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard";
import TeamDetailPage from "../../app/(app)/teams/[id]/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "user-owner";

function person(n: number) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    userId: `user-${n}`,
    role: "MEMBER",
    status: "ACTIVE",
    label: `Heir ${n}`,
    user: { id: `user-${n}`, displayName: `Heir ${n}`, email: `h${n}@example.org` },
  };
}
const ALL = Array.from({ length: 61 }, (_, i) => person(i + 1));

function membersReply(path: string) {
  const url = new URL(path, "http://x");
  const q = url.searchParams.get("q");
  if (q) {
    const hits = ALL.filter((m) => m.user.displayName.toLowerCase() === q.toLowerCase());
    return { members: hits, nextCursor: null, total: hits.length };
  }
  if (url.searchParams.get("cursor")) {
    return { members: ALL.slice(50), nextCursor: null, total: ALL.length };
  }
  return { members: ALL.slice(0, 50), nextCursor: ALL[49].id, total: ALL.length };
}

function reply(path: string, init?: RequestInit): unknown {
  if (path === `/v1/teams/${TEAM}`) {
    // The detail read embeds only a bounded first page — the old picker source.
    return {
      id: TEAM,
      name: "Casework",
      ownerUserId: ME,
      canManageMembers: true,
      canManageWorkspace: true,
      stats: { memberCount: 62, pendingInviteCount: 0, caseCount: 0 },
      members: ALL.slice(0, 50),
    };
  }
  if (path === `/v1/teams/${TEAM}/invites`) return { invites: [] };
  if (path === `/v1/teams/${TEAM}/cases`) return { items: [] };
  if (path === `/v1/teams/${TEAM}/activity`) return { activities: [] };
  if (path === `/v1/teams/${TEAM}/closure`) return { request: null, blockers: [], confirmationPhrase: "CLOSE Casework", coolingOffDays: 7, membersLosingAccess: 0 };
  if (path === `/v1/teams/${TEAM}/access-review`) return { teamId: TEAM, summary: {}, members: [], pendingInvites: [], externalCollaborators: [] };
  if (init?.method === "POST") return { transfer: { teamId: TEAM, fromUserId: ME, toUserId: "user-61" } };
  if (path.startsWith(`/v1/teams/${TEAM}/members?`)) return membersReply(path);
  return {};
}

const memberReads = () =>
  mocks.fetch.mock.calls
    .filter(([p]) => String(p).startsWith(`/v1/teams/${TEAM}/members?`))
    .map(([p]) => new URL(String(p), "http://x").searchParams);
const optionLabels = () =>
  Array.from(
    (screen.getByLabelText("New owner") as HTMLSelectElement).options,
  ).map((o) => o.textContent);

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
});
afterEach(cleanup);

describe("workspace ownership transfer — eligible-member picker", () => {
  it("on the People page, the owner can choose a member beyond the first 50 the detail read embeds", async () => {
    render(<TeamDetailPage />);
    const card = (await screen.findByText("Transfer ownership")).closest(
      "[data-workspace-ownership-transfer-card]",
    ) as HTMLElement;
    expect(card).not.toBeNull();
    const more = await within(card).findByRole("button", { name: "Show more members" });
    fireEvent.click(more);
    await within(card).findByText("Showing 61 of 61 members who can take ownership");
    const select = within(card).getByLabelText("New owner") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("Heir 61");
  });

  it("reads the server's eligible list and reaches the 61st member with Show more", async () => {
    const onTransferred = vi.fn();
    render(
      <WorkspaceOwnershipTransferCard
        teamId={TEAM}
        teamName="Casework"
        currentUserId={ME}
        onTransferred={onTransferred}
      />,
    );
    await screen.findByText("Showing 50 of 61 members who can take ownership");
    const first = memberReads()[0];
    expect(first.get("eligible")).toBe("ownership_transfer");
    expect(first.get("limit")).toBe("50");
    expect(first.has("cursor")).toBe(false);
    expect(optionLabels()).not.toContain("Heir 61");

    fireEvent.click(screen.getByRole("button", { name: "Show more members" }));
    await screen.findByText("Showing 61 of 61 members who can take ownership");
    expect(memberReads().at(-1)!.get("cursor")).toBe(ALL[49].id);
    expect(optionLabels()).toContain("Heir 61");
    expect(screen.queryByRole("button", { name: "Show more members" })).toBeNull();

    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "user-61" } });
    fireEvent.click(screen.getByRole("button", { name: /Transfer ownership/ }));
    expect(screen.getByText(/Transfer/, { selector: "p" }).textContent).toContain("Heir 61");
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(onTransferred).toHaveBeenCalledTimes(1));
    const post = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe(`/v1/teams/${TEAM}/transfer-ownership`);
    expect(JSON.parse(String(post[1].body))).toEqual({ newOwnerUserId: "user-61" });
    expect(onTransferred.mock.calls[0][0]).toContain("Heir 61 now owns Casework");
  });

  it("searches on the server and keeps the chosen member when the search changes", async () => {
    render(
      <WorkspaceOwnershipTransferCard
        teamId={TEAM}
        teamName="Casework"
        currentUserId={ME}
        onTransferred={() => {}}
      />,
    );
    await screen.findByText("Showing 50 of 61 members who can take ownership");
    fireEvent.change(screen.getByLabelText("Find a member"), { target: { value: "Heir 60" } });
    await screen.findByText("Showing 1 of 1 matching member who can take ownership");
    const last = memberReads().at(-1)!;
    expect(last.get("q")).toBe("Heir 60");
    expect(last.get("eligible")).toBe("ownership_transfer");
    expect(last.has("cursor")).toBe(false);
    expect(optionLabels()).toEqual(["Select the new owner…", "Heir 60"]);

    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "user-60" } });
    fireEvent.change(screen.getByLabelText("Find a member"), { target: { value: "nobody" } });
    await screen.findByText("No active member matches that search.");
    // The chosen person is still selected and still named.
    expect((screen.getByLabelText("New owner") as HTMLSelectElement).value).toBe("user-60");
    expect(optionLabels()).toContain("Heir 60");
  });

  it("says so when nobody is eligible, and reports a failed read with a retry instead", async () => {
    let fail = true;
    mocks.fetch.mockImplementation(async (path: string) => {
      if (String(path).startsWith(`/v1/teams/${TEAM}/members?`)) {
        if (fail) throw { statusCode: 500 };
        return { members: [], nextCursor: null, total: 0 };
      }
      return {};
    });
    render(
      <WorkspaceOwnershipTransferCard teamId={TEAM} teamName="Casework" currentUserId={ME} onTransferred={() => {}} />,
    );
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain("Try again");
    expect(screen.queryByText(/Invite another member first/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Invite another member first/);
  });
});
