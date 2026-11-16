/**
 * R1-F-03 — web discussion names authors and keeps notices apart from failures.
 *
 * The author column printed the raw authorUserId (a UUID), and a successful
 * post with an unresolved @mention showed a red "Discussion could not be
 * loaded" alert.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));

import EvidenceDiscussionPanel from "../../app/(app)/evidence/[id]/components/EvidenceDiscussionPanel";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const evidenceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const threadId = "11111111-1111-4111-8111-111111111111";
const dana = "22222222-2222-4222-8222-222222222222";
const stranger = "99999999-9999-4999-8999-999999999999";

const thread = {
  id: threadId, evidenceId, kind: "EVIDENCE_GENERAL", status: "OPEN", visibility: "INTERNAL",
  title: "Chain of custody question", createdByUserId: dana, assignedToUserId: null,
  resolvedAtUtc: null, reopenCount: 0, escalatedAtUtc: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
const msg = (id: string, authorUserId: string, body: string) => ({
  id, threadId, authorKind: "USER", authorUserId, contributorLabel: null, body, editedAtUtc: null, createdAt: "2026-09-02T00:00:00.000Z",
});

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/v1/collaboration/catalogs")) return null;
    if (path.startsWith("/v1/teams/")) {
      return { members: [{ userId: dana, label: "Dana Reyes", role: "ADMIN", status: "ACTIVE" }], nextCursor: null };
    }
    if (path.startsWith("/v1/collaboration/threads?")) return { threads: [thread] };
    if (path.includes("/messages") && method === "POST") {
      return { message: { id: "m-3" }, unresolvedMentions: [{ token: "sam", reason: "ambiguous" }] };
    }
    if (path.includes("/messages")) return { messages: [msg("m-1", dana, "First note"), msg("m-2", stranger, "Second note")] };
    if (path.includes("/mark-mentions-read")) return { ok: true };
    if (path.startsWith(`/v1/collaboration/threads/${threadId}?`)) return { thread, resolutionNote: null, escalationReason: null };
    throw new Error("unexpected " + method + " " + path);
  });
});
afterEach(() => cleanup());

describe("R1-F-03", () => {
  it("names authors from the roster and never prints a user id", async () => {
    render(<EvidenceDiscussionPanel evidenceId={evidenceId} teamId={teamId} initialThreadId={threadId} />);
    await screen.findByText("First note");
    await waitFor(() => expect(screen.getAllByText("Dana Reyes").length).toBeGreaterThan(0));
    expect(screen.getByText("A workspace member")).toBeTruthy();
    expect(document.body.textContent).not.toContain(stranger);
    expect(document.body.textContent).not.toContain(dana);
  });

  it("an unresolved-mention notice after a successful post is a notice, not a load failure", async () => {
    render(<EvidenceDiscussionPanel evidenceId={evidenceId} teamId={teamId} initialThreadId={threadId} />);
    await screen.findByText("First note");
    fireEvent.change(screen.getByLabelText("Post a message"), { target: { value: "@sam please check" } });
    fireEvent.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Message posted");
    expect(screen.getByText(/matches more than one person/)).toBeTruthy();
    expect(screen.queryByText("Discussion could not be loaded")).toBeNull();
  });
});
