/**
 * Evidence ID — attention, rail and review interactions, driven for real
 * (2026-10-23).
 *
 * Characterises the reported record (/evidence/<id> screenshot: no flagged
 * issue, imported upload, file timestamp note, no case, review not started)
 * and pins the repaired behaviour:
 *
 *   A. "What needs attention" lists ONLY actionable items from the server's
 *      classification — "Review ready", "Imported upload" and "File
 *      timestamp note" are not in it; nothing actionable → one calm line;
 *   B. the rail: advisory signals as compact rows (no large risk card for a
 *      healthy record), "Case: None · Optional", no "Due date: Not available";
 *   C. Review actions: Claim visibly changes ownership (the panel re-reads
 *      the record and names the reviewer, never an id); a second click
 *      cannot be sent while one is in flight; Escalate asks for a reason in
 *      the page and says where the review goes; a refusal is said in words;
 *   D. history: creation's automatic events read as one entry, no enum.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import {
  classifyEvidenceAttention,
  projectReviewWorkflowActions,
  type ReviewWorkflowActionAvailability,
} from "@proovra/shared";

const requests: Array<{ path: string; method: string; body?: string }> = [];
let reply: (path: string, method: string) => unknown = () => ({});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body });
    const r = await reply(path, method);
    if (r instanceof Error) throw r;
    return r;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { WhatNeedsAttentionStrip } from "../../app/(app)/evidence/[id]/_tabs/WhatNeedsAttentionStrip";
import { EvidenceRecordRail } from "../../app/(app)/evidence/[id]/_tabs/EvidenceRecordRail";
import { EvidenceReviewActionsPanel } from "../../app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel";
import { ReviewerWorkflowCard } from "../../app/(app)/evidence/[id]/components/ReviewerWorkflowCard";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "54b5d495-2222-4222-8222-bbbbbbbbbbbb";

/** The reported record, classified by the SAME authority the API runs. */
function reportedAttention(over: { reviewNotStarted?: boolean; viewerCanStart?: boolean } = {}) {
  return {
    ...classifyEvidenceAttention({
      alerts: [
        {
          code: "NO_FLAGGED_ISSUES",
          label: "No flagged issues",
          detail: "This record has no flagged issues in the current intelligence summary.",
        },
      ],
      source: { importedUpload: true, oldLastModified: true, screenshotLikeDetected: false, genericMime: false },
      caseAssignment: { assigned: false, policy: "OPTIONAL", viewerCanAssign: true },
      review: {
        applicable: true,
        notStarted: over.reviewNotStarted ?? true,
        viewerCanStart: over.viewerCanStart ?? true,
      },
    }),
    caseAssignment: { assigned: false, policy: "OPTIONAL" as const, restricted: false },
  };
}

function workspaceWith(attention: ReturnType<typeof reportedAttention>, workflow: Record<string, unknown> = {}) {
  return {
    attention,
    relationships: { caseId: null, caseName: null },
    reviewWorkflow: {
      available: true,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedTo: null,
      dueAt: null,
      lastReviewedAt: null,
      note: null,
      ...workflow,
    },
  } as never;
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));

beforeEach(() => {
  cleanup();
  requests.length = 0;
  reply = () => ({});
});

// ===========================================================================
// A. The strip
// ===========================================================================

describe("A — What needs attention holds only what needs attention", () => {
  it("the reported record: ONE recommended item (Review not started · Start review); benign facts absent", () => {
    const onAssignReviewer = vi.fn();
    render(
      <WhatNeedsAttentionStrip
        ctx={{ workspace: workspaceWith(reportedAttention()) } as never}
        onAssignCase={() => {}}
        onAssignReviewer={onAssignReviewer}
        onGoToArtifacts={() => {}}
      />,
    );
    const strip = q("[data-evidence-attention-strip]") as HTMLElement;
    expect(strip.getAttribute("data-evidence-attention-strip")).toBe("ACTION_RECOMMENDED");
    expect(strip.querySelector("h2")?.textContent).toBe("What needs attention");
    expect(qa("[data-evidence-attention-code]").map((e) => e.getAttribute("data-evidence-attention-code"))).toEqual([
      "REVIEW_NOT_STARTED",
    ]);
    for (const benign of ["Review ready", "No flagged issues", "Imported upload", "File timestamp note", "No case assigned"]) {
      expect(strip.textContent).not.toContain(benign);
    }
    // The category is in words, not only a colour.
    expect(strip.textContent).toContain("Recommended");
    fireEvent.click(q('[data-evidence-attention-action="START_REVIEW"]') as HTMLElement);
    expect(onAssignReviewer).toHaveBeenCalledTimes(1);
  });

  it("no classification from the server is said, never shown as calm (audit F14)", () => {
    render(
      <WhatNeedsAttentionStrip
        ctx={{ workspace: workspaceWith(undefined as never) } as never}
        onAssignCase={() => {}}
        onAssignReviewer={() => {}}
        onGoToArtifacts={() => {}}
      />,
    );
    expect(q('[data-evidence-attention-strip="no-action"]')).toBeNull();
    expect(q('[data-evidence-attention-strip="unavailable"]')?.textContent).toContain("could not be read");
    cleanup();
    render(<EvidenceRecordRail workspace={workspaceWith(undefined as never)} verificationPage={null} shareUrl={null} />);
    expect(q("[data-evidence-risk-empty]")).toBeNull();
    expect(q("[data-evidence-risk-unavailable]")?.textContent).toBe("Risk signals could not be read.");
  });

  it("nothing actionable: no heading and no region — one calm line", () => {
    render(
      <WhatNeedsAttentionStrip
        ctx={{ workspace: workspaceWith(reportedAttention({ viewerCanStart: false })) } as never}
        onAssignCase={() => {}}
        onAssignReviewer={() => {}}
        onGoToArtifacts={() => {}}
      />,
    );
    expect(q("h2")).toBeNull();
    const calm = q('[data-evidence-attention-strip="no-action"]') as HTMLElement;
    expect(calm.textContent).toBe("No action required");
    expect(calm.getAttribute("role")).toBe("status");
  });
});

// ===========================================================================
// B. The rail
// ===========================================================================

describe("B — the rail is compact and states optional values honestly", () => {
  it("advisory row for the timestamp note; no large risk card; Case is Optional; no 'Due date: Not available'", () => {
    render(
      <EvidenceRecordRail
        workspace={workspaceWith(reportedAttention())}
        verificationPage={null}
        shareUrl={null}
      />,
    );
    const risk = q('[data-evidence-side="risk-signals"]') as HTMLElement;
    expect(qa("[data-evidence-risk-code]").map((e) => e.getAttribute("data-evidence-risk-code"))).toEqual([
      "FILE_TIMESTAMP_NOTE",
    ]);
    expect(risk.querySelector(".evidence-detail-signal-card")).toBeNull();
    expect(risk.textContent).not.toContain("Review ready");
    expect(risk.textContent).not.toContain("Imported upload");
    expect(risk.textContent).toContain("Advisory");

    expect(q("[data-evidence-rail-case]")?.textContent).toBe("None · Optional");
    expect(document.body.textContent).not.toContain("Not available");
    expect(document.body.textContent).not.toMatch(/Due date|Review due/);
    // Workflow state and priority in words, not enums.
    const workflow = q('[data-evidence-side="operational-summary"]') as HTMLElement;
    expect(workflow.textContent).toContain("Not started");
    expect(workflow.textContent).toContain("Normal");
    expect(workflow.textContent).not.toMatch(/NOT_STARTED|NORMAL/);
  });

  it("a due date that IS set is stated; a hidden case reads as restricted, never 'unassigned'", () => {
    const attention = { ...reportedAttention(), caseAssignment: { assigned: true, policy: "OPTIONAL" as const, restricted: true } };
    render(
      <EvidenceRecordRail
        workspace={workspaceWith(attention, { dueAt: "2026-11-01T09:00:00.000Z" })}
        verificationPage={null}
        shareUrl={null}
      />,
    );
    expect(document.body.textContent).toContain("Review due");
    expect(q("[data-evidence-rail-case]")?.textContent).toBe("Linked to a case you cannot open");
  });

  it("no advisories but a required issue above: the rail points there instead of claiming no risk", () => {
    const attention = {
      ...classifyEvidenceAttention({
        alerts: [{ code: "CUSTODY_CHAIN_ISSUE", label: "Custody chain issue", detail: "…" }],
        source: { importedUpload: false, oldLastModified: false, screenshotLikeDetected: false, genericMime: false },
        caseAssignment: { assigned: true, policy: "OPTIONAL", viewerCanAssign: true },
        review: { applicable: false, notStarted: false, viewerCanStart: false },
      }),
      caseAssignment: { assigned: true, policy: "OPTIONAL" as const, restricted: false },
    };
    render(<EvidenceRecordRail workspace={workspaceWith(attention)} verificationPage={null} shareUrl={null} />);
    expect(q("[data-evidence-risk-empty]")?.textContent).toBe(
      "Issues that need action are listed under What needs attention.",
    );
  });
});

// ===========================================================================
// C. Review actions
// ===========================================================================

function actionsFor(over: Partial<Parameters<typeof projectReviewWorkflowActions>[0]>): ReviewWorkflowActionAvailability[] {
  return projectReviewWorkflowActions({
    dbStatus: "NOT_STARTED",
    assignedToUserId: null,
    viewerUserId: ME,
    viewerMayReview: true,
    hasWorkspace: true,
    decision: { state: "first_required", firstReviewerUserId: null, resolvedByRequestInfo: false },
    ...over,
  });
}

/** A page stand-in: the panel's onChanged re-reads the "server" state. */
function Harness({ initial }: { initial: { status: string; assignedTo: { id: string; displayName: string | null; email: string | null } | null } }) {
  const [state, setState] = React.useState(initial);
  const server = React.useRef(initial);
  serverRef.current = server;
  return (
    <ConfirmActionProvider>
      <EvidenceReviewActionsPanel
        evidenceId="ev-1"
        teamId="team-1"
        currentStatus={state.status}
        assignedTo={state.assignedTo}
        viewerUserId={ME}
        workflowUpdatedAt="2026-10-23T10:00:00.000Z"
        availableActions={actionsFor({ dbStatus: state.status, assignedToUserId: state.assignedTo?.id ?? null })}
        onChanged={async () => {
          setState({ ...server.current });
        }}
      />
    </ConfirmActionProvider>
  );
}
const serverRef: { current: React.MutableRefObject<{ status: string; assignedTo: { id: string; displayName: string | null; email: string | null } | null }> | null } = { current: null };

describe("C — every review click has a visible outcome", () => {
  it("Claim: busy, then the panel re-reads and names YOU as reviewer; Claim is no longer offered", async () => {
    let release: () => void = () => {};
    reply = (path, method) => {
      if (method === "POST" && path.endsWith("/claim")) {
        serverRef.current!.current = { status: "ASSIGNED", assignedTo: { id: ME, displayName: "Dana Reviewer", email: null } };
        return new Promise((r) => {
          release = () => r({ workflow: {} });
        });
      }
      return {};
    };
    render(<Harness initial={{ status: "NOT_STARTED", assignedTo: null }} />);
    expect(q("[data-evidence-review-assignee]")?.textContent).toBe("Reviewer: Unassigned");
    const claim = q('[data-evidence-review-action="CLAIM"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(claim);
    });
    // In flight: busy and every control disabled, so a second click cannot be sent.
    expect(claim.getAttribute("aria-busy")).toBe("true");
    expect(qa("[data-evidence-review-action]").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => {
      fireEvent.click(claim);
      release();
    });
    await waitFor(() => expect(q('[data-evidence-review-outcome="success"]')).not.toBeNull());
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(q("[data-evidence-review-outcome]")?.textContent).toBe("You now own this review.");
    expect(q("[data-evidence-review-assignee]")?.textContent).toBe("Reviewer: You");
    expect(q('[data-evidence-review-action="CLAIM"]')).toBeNull();
    expect(q("[data-evidence-review-stage]")?.textContent).toBe("Assigned");
  });

  it("Begin review (audit F7): after Claim the owner begins the review — a version-checked move to In review — and verdicts follow", async () => {
    reply = (path, method) => {
      if (method === "PATCH" && path.endsWith("/reviewer-workflow")) {
        serverRef.current!.current = { status: "IN_REVIEW", assignedTo: { id: ME, displayName: "Dana", email: null } };
        return { workflow: {} };
      }
      return {};
    };
    render(<Harness initial={{ status: "ASSIGNED", assignedTo: { id: ME, displayName: "Dana", email: null } }} />);
    expect(q('[data-evidence-review-action="APPROVE_INTERNAL"]')).toBeNull();
    const begin = q('[data-evidence-review-action="BEGIN_REVIEW"]') as HTMLButtonElement;
    expect(begin.disabled).toBe(false);
    expect(begin.textContent).toContain("Begin review");
    await act(async () => {
      fireEvent.click(begin);
    });
    await waitFor(() => expect(q('[data-evidence-review-outcome="success"]')).not.toBeNull());
    const sent = requests.filter((r) => r.method === "PATCH");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/v1/evidence/ev-1/reviewer-workflow");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ status: "IN_REVIEW", expectedUpdatedAt: "2026-10-23T10:00:00.000Z" });
    expect(q("[data-evidence-review-outcome]")?.textContent).toBe("Review begun. A verdict can now be recorded.");
    expect(q('[data-evidence-review-action="BEGIN_REVIEW"]')).toBeNull();
    expect((q('[data-evidence-review-action="APPROVE_INTERNAL"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("another reviewer is named by NAME — never a raw id", () => {
    render(<Harness initial={{ status: "ASSIGNED", assignedTo: { id: OTHER, displayName: "Sam Okafor", email: null } }} />);
    expect(q("[data-evidence-review-assignee]")?.textContent).toBe("Reviewer: Sam Okafor");
    expect(document.body.textContent).not.toMatch(/54b5d495/);
    // Claim stays visible, disabled, with the reason beside it.
    const claim = q('[data-evidence-review-action="CLAIM"]') as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    expect(claim.getAttribute("data-disabled-reason")).toBe("Another reviewer owns this review.");
  });

  it("Escalate asks for a reason in the page, says where the review goes, and sends it once", async () => {
    reply = (path, method) => {
      if (method === "POST" && path.endsWith("/decision")) {
        serverRef.current!.current = { status: "ESCALATED", assignedTo: { id: ME, displayName: "Dana", email: null } };
        return { workflow: {} };
      }
      return {};
    };
    render(<Harness initial={{ status: "IN_REVIEW", assignedTo: { id: ME, displayName: "Dana", email: null } }} />);
    fireEvent.click(q('[data-evidence-review-action="ESCALATE"]') as HTMLElement);
    const form = q('[data-evidence-review-reason="ESCALATE"]') as HTMLElement;
    expect(form.textContent).toContain("appears under Escalated in the team review queue");
    const submit = form.querySelector("[data-evidence-review-reason-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(form.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Needs counsel review" } });
    await act(async () => {
      fireEvent.submit(form.querySelector("form") ?? form);
    });
    await waitFor(() => expect(q("[data-evidence-review-stage]")?.textContent).toBe("Escalated"));
    const post = requests.find((r) => r.method === "POST")!;
    expect(JSON.parse(post.body!)).toMatchObject({ decision: "ESCALATE", note: "Needs counsel review", escalationReason: "Needs counsel review" });
    // Escalate is not offered again from Escalated.
    expect(q('[data-evidence-review-action="ESCALATE"]')).toBeNull();
  });

  it("a server refusal is said in words, and the panel re-reads the record", async () => {
    reply = (path, method) => {
      if (method === "POST") {
        const err = new Error("conflict") as Error & { body: unknown; code: string };
        err.body = { error: { code: "already_assigned_elsewhere" } };
        err.code = "already_assigned_elsewhere";
        serverRef.current!.current = { status: "ASSIGNED", assignedTo: { id: OTHER, displayName: "Sam Okafor", email: null } };
        return err;
      }
      return {};
    };
    render(<Harness initial={{ status: "NOT_STARTED", assignedTo: null }} />);
    await act(async () => {
      fireEvent.click(q('[data-evidence-review-action="CLAIM"]') as HTMLElement);
    });
    await waitFor(() => expect(q('[data-evidence-review-outcome="error"]')).not.toBeNull());
    expect(q("[data-evidence-review-outcome]")?.textContent).toBe(
      "Another reviewer claimed this review first. The panel now shows the current owner.",
    );
    expect(q("[data-evidence-review-outcome]")?.getAttribute("role")).toBe("alert");
    expect(q("[data-evidence-review-assignee]")?.textContent).toBe("Reviewer: Sam Okafor");
  });

  it("a viewer without review permission sees ONE sentence and no dead buttons", () => {
    render(
      <ConfirmActionProvider>
        <EvidenceReviewActionsPanel
          evidenceId="ev-1"
          teamId="team-1"
          currentStatus="NOT_STARTED"
          assignedTo={null}
          viewerUserId={ME}
          availableActions={actionsFor({ viewerMayReview: false })}
        />
      </ConfirmActionProvider>,
    );
    expect(qa("[data-evidence-review-action]")).toHaveLength(0);
    expect(q('[data-evidence-review-blocked="NOT_PERMITTED"]')?.textContent).toBe(
      "Your role cannot make review decisions in this workspace.",
    );
  });
});

// ===========================================================================
// D. History
// ===========================================================================

describe("D — the workflow history reads for a person", () => {
  it("creation's four automatic events are ONE entry, attributed to the person who created it; enums and ids never reach the reader", () => {
    const t = "2026-10-20T10:00:00.000Z";
    const owner = { id: OTHER, email: null, displayName: null };
    render(
      <ReviewerWorkflowCard
        workflow={{ available: true, status: "NOT_STARTED", priority: "NORMAL", assignedTo: null, dueAt: null, lastReviewedAt: null, note: null, viewerUserId: ME } as never}
        events={[
          { id: "e1", eventType: "CREATED", note: null, previousValue: null, nextValue: null, createdAt: t, actor: owner },
          { id: "e2", eventType: "UNASSIGNED", note: null, previousValue: null, nextValue: null, createdAt: t, actor: owner },
          { id: "e3", eventType: "STATUS_CHANGED", note: null, previousValue: null, nextValue: null, createdAt: t, actor: owner },
          { id: "e4", eventType: "PRIORITY_CHANGED", note: null, previousValue: null, nextValue: null, createdAt: t, actor: owner },
        ]}
        eventsLoading={false}
        actionBusy={false}
        onRefreshEvents={() => {}}
        onOpenEditor={() => {}}
        formatDateTime={(v) => v ?? ""}
      />,
    );
    const entries = qa("[data-evidence-workflow-entry]");
    expect(entries).toHaveLength(1);
    // A person created it (audit F8: it was always labelled the system's).
    expect(entries[0]!.getAttribute("data-evidence-workflow-entry")).toBe("PERSON");
    expect(entries[0]!.getAttribute("data-evidence-workflow-event-count")).toBe("4");
    expect(entries[0]!.textContent).toContain("Review workflow created");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/PRIORITY CHANGED|STATUS CHANGED|UNASSIGNED|CREATED|NOT_STARTED/);
    expect(text).not.toMatch(/54b5d495/);
    // The summary does not repeat absent optional values.
    expect(text).not.toContain("Not available");
    // ONE boundary line (2026-10-24: it used to be said three times).
    expect(text.match(/Internal review only/g)?.length).toBe(1);
    expect(text).not.toContain("Review history is separate from the evidence");
  });

  it("an SLA event PROOVRA wrote with no actor reads as PROOVRA, never as a former member (audit F8)", () => {
    render(
      <ReviewerWorkflowCard
        workflow={{ available: true, status: "IN_REVIEW", priority: "NORMAL", assignedTo: null, dueAt: null, lastReviewedAt: null, note: null, viewerUserId: ME } as never}
        events={[
          { id: "s1", eventType: "SLA_BREACHED", note: null, previousValue: null, nextValue: null, createdAt: "2026-10-22T10:00:00.000Z", actor: null },
        ]}
        eventsLoading={false}
        actionBusy={false}
        onRefreshEvents={() => {}}
        onOpenEditor={() => {}}
        formatDateTime={(v) => v ?? ""}
      />,
    );
    const entry = q("[data-evidence-workflow-entry]") as HTMLElement;
    expect(entry.getAttribute("data-evidence-workflow-entry")).toBe("SYSTEM");
    expect(entry.textContent).toContain("PROOVRA");
    expect(entry.textContent).not.toContain("Former workspace member");
  });
});

// ===========================================================================
// E. The redesigned Reviewer workflow card (2026-10-24)
// ===========================================================================

describe("E — Reviewer workflow card: state and decision apart, history by round, compact", () => {
  const WF = { available: true, priority: "NORMAL", assignedTo: null, dueAt: null, lastReviewedAt: null, note: null, viewerUserId: ME } as const;
  const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 10, min, 0)).toISOString();
  const ev = (id: string, eventType: string, min: number, nextValue: unknown = null, actor: unknown = { id: OTHER, displayName: "Sam Okafor", email: null }) =>
    ({ id, eventType, note: null, previousValue: null, nextValue, createdAt: at(min), actor }) as never;
  const card = (workflow: Record<string, unknown>, events: unknown[]) =>
    render(
      <ReviewerWorkflowCard
        workflow={{ ...WF, ...workflow } as never}
        events={events as never}
        eventsLoading={false}
        actionBusy={false}
        onRefreshEvents={() => {}}
        onOpenEditor={() => {}}
        formatDateTime={(v) => `${v} Europe/Berlin`}
      />,
    );

  it("Approve then Close reads Workflow: Closed · Decision: Approved — never 'Not accepted'", () => {
    card({ status: "CLOSED", decision: "APPROVED" }, []);
    expect(q('[data-evidence-review-fact="workflow"] dd')?.textContent).toBe("Closed");
    expect(q('[data-evidence-review-fact="decision"] dd')?.textContent).toBe("Approved");
    expect(document.body.textContent).not.toContain("Not accepted");
    cleanup();
    card({ status: "CLOSED", decision: "NO_DECISION" }, []);
    expect(q('[data-evidence-review-fact="decision"] dd')?.textContent).toBe("No decision");
    cleanup();
    card({ status: "CLOSED", decision: "NOT_ACCEPTED" }, []);
    expect(q('[data-evidence-review-fact="decision"] dd')?.textContent).toBe("Not accepted");
    expect(q('[data-evidence-review-fact="workflow"] dd')?.textContent).toBe("Closed");
  });

  it("history is grouped by round: newest round open, older rounds collapsed; a decision is named, Reopen/Close are not decisions", () => {
    card({ status: "CLOSED", decision: "APPROVED" }, [
      ev("a", "CREATED", 0, null, null),
      ev("b", "CLAIMED", 1),
      ev("c", "DECISION_LOGGED", 2, { round: 0, decision: "REJECT", stage: "REJECTED_INSUFFICIENT", state: "resolved" }),
      ev("d", "REOPENED", 3),
      ev("e", "DECISION_LOGGED", 4, { round: 1, decision: "APPROVE", stage: "APPROVED_INTERNAL", state: "resolved" }),
      ev("f", "CLOSED", 5),
    ]);
    const current = q('[data-evidence-review-round-current="true"]') as HTMLElement;
    expect(current.getAttribute("data-evidence-review-round")).toBe("1");
    const labels = [...current.querySelectorAll("li strong")].map((x) => x.textContent);
    expect(labels).toEqual(["Closed", "Decision recorded: Approved", "Reopened"]);
    const older = q('[data-evidence-review-round-disclosure="0"]') as HTMLDetailsElement;
    expect(older.tagName).toBe("DETAILS");
    expect(older.open).toBe(false);
    expect(older.querySelector("summary")?.textContent).toBe("Round 1 · 3 entries");
    const codes = [...document.querySelectorAll("[data-evidence-workflow-code]")].map((x) => [x.querySelector("strong")?.textContent, x.getAttribute("data-evidence-workflow-code")]);
    expect(codes).toContainEqual(["Reopened", "REVIEW_REOPENED"]);
    expect(codes).toContainEqual(["Closed", "REVIEW_CLOSED"]);
    expect(codes).toContainEqual(["Decision recorded: Not accepted", "REVIEW_DECISION_RECORDED"]);
  });

  it("five entries a round until 'Show all N entries'; 'Show less' returns; concise date in the row, the exact zoned time only in the accessible detail", () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(`p${i}`, "PRIORITY_CHANGED", i + 1));
    card({ status: "IN_REVIEW", decision: "NO_DECISION" }, [ev("c", "CREATED", 0, null, null), ...events]);
    const current = q('[data-evidence-review-round-current="true"]') as HTMLElement;
    expect(current.querySelectorAll("li")).toHaveLength(5);
    const more = q("[data-evidence-review-show-all]") as HTMLButtonElement;
    expect(more.textContent).toBe("Show all 9 entries");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(current.querySelectorAll("li")).toHaveLength(9);
    expect(more.textContent).toBe("Show less");
    fireEvent.click(more);
    expect(current.querySelectorAll("li")).toHaveLength(5);
    // The zone is never repeated in the visible rows.
    const visible = [...current.querySelectorAll("time")].map((t) => t.textContent ?? "");
    expect(visible.every((t) => !t.includes("Europe/Berlin"))).toBe(true);
    const first = current.querySelector("time") as HTMLTimeElement;
    expect(first.getAttribute("title")).toContain("Europe/Berlin");
    expect(first.getAttribute("dateTime")).toMatch(/^2026-10-20T10:/);
  });

  it("no raw enums or identifiers reach the reader", () => {
    card({ status: "APPROVED_INTERNAL", decision: "APPROVED" }, [
      ev("x", "DECISION_LOGGED", 1, { round: 0, decision: "REQUEST_INFO", stage: "NEEDS_MORE_INFO", state: "resolved" }),
      ev("y", "STATUS_CHANGED", 2, { status: "IN_REVIEW" }),
    ]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("More information requested");
    expect(text).toContain("Moved to In review");
    expect(q('[data-evidence-review-fact="workflow"] dd')?.textContent).toBe("Decided");
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
