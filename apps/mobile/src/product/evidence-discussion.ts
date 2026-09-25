/**
 * EVIDENCE DISCUSSION THREADS (T-12 / RC-13) — the native port of
 * `EvidenceDiscussionPanel.tsx` + `DiscussionThreadLifecycle.tsx`.
 *
 * The threads attached to ONE evidence record, in its review workspace
 * (`reviewWorkflow.teamId`), shown when the review workspace's capability
 * snapshot says `discussionEnabled` or `discussionReadOnly`. Messages post to
 * the audited thread route; the four lifecycle actions (resolve, reopen,
 * assign, escalate) are each confirmed by REREADING the thread detail before
 * success is announced.
 *
 * Discussion is a collaboration record — not custody, not integrity, not
 * public verification — and the copy says so.
 */

export type ThreadAction = "resolve" | "reopen" | "assign" | "escalate";
export type ThreadFilterPreset = "all" | "unresolved" | "escalated" | "resolved";

export const THREAD_FILTER_OPTIONS: ReadonlyArray<{ value: ThreadFilterPreset; label: string }> = [
  { value: "all", label: "All" },
  { value: "unresolved", label: "Unresolved" },
  { value: "escalated", label: "Escalated" },
  { value: "resolved", label: "Resolved" },
];

export const EVIDENCE_DISCUSSION_COPY = {
  title: "Discussion",
  intro:
    "Operational coordination attached to this evidence. Threads are workspace-scoped and audit-visible — use this surface instead of external chat tools to preserve traceability.",
  boundary:
    "Workspace discussion is a collaboration record, not part of the forensic custody chain, the recorded integrity state, public verification, or the verification package. Posting a message does not change what was preserved about this evidence.",
  noWorkspace:
    "Discussion threads are workspace-scoped. This evidence does not have an active workspace context. Switch to a workspace this evidence belongs to in order to coordinate with reviewers.",
  readOnlyTitle: "Read-only discussion",
  readOnlyBody: "Existing discussion history is preserved, but new messages cannot be posted in the current workspace context.",
  loadFailedTitle: "Discussion could not be loaded",
  threadsFailed: "Threads could not be loaded, so none are listed. Reload the tab to try again.",
  noMatch: "No threads match the current filter.",
  empty:
    "No discussion threads yet. Threads created from the classic reviewer surfaces appear here. Operational coordination on this evidence should be recorded as a thread so the audit trail remains complete.",
  messagesFailed: "Messages could not be loaded. Select the thread again to retry.",
  noMessages: "No messages in this thread yet. Post one below — it will be attributed to your account in the workspace audit trail.",
  readOnlyComposer: "This workspace is in read-only mode for discussion. History above is preserved; new messages cannot be posted.",
  resolvedComposer: "This thread is resolved. Use Reopen above, with a reason, to continue the discussion.",
  closedComposer: "This thread is closed and is kept as a record. It cannot be continued here.",
  composerPlaceholder: "Write an operational message. Use @username to mention a workspace member.",
  composerNote: "Audit-attributed. Workspace-scoped.",
  detailFailed: "The thread details could not be loaded.",
  notConfirmed: "The request was accepted, but the reloaded thread does not show the change. Refresh the thread before trying again.",
  rereadFailed:
    "The change was sent, but the thread could not be reloaded to confirm it. Refresh the thread before making another change.",
  stale: "This thread changed since it was loaded. Refresh the thread and try again.",
  updateFailed: "The thread could not be updated.",
  postFailed: "Could not post message.",
} as const;

export const THREAD_ACTION_LABEL: Record<ThreadAction, string> = {
  resolve: "Resolve thread",
  reopen: "Reopen thread",
  assign: "Assign thread",
  escalate: "Escalate thread",
};

/** Server bounds (collaboration.routes.ts). */
export const MESSAGE_MAX = 8 * 1024;
export const RESOLUTION_NOTE_MAX = 1000;
export const REASON_MAX = 400;

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* --------------------------------------------------------------- transport */

export function buildEvidenceThreadsPath(teamId: string, evidenceId: string): string {
  return `/v1/collaboration/threads?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`;
}
export function buildThreadDetailPath(threadId: string, teamId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}?teamId=${encodeURIComponent(teamId)}`;
}
export function buildEvidenceThreadMessagesPath(threadId: string, teamId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/messages?teamId=${encodeURIComponent(teamId)}`;
}
export function buildThreadMentionsReadPath(threadId: string, teamId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/mark-mentions-read?teamId=${encodeURIComponent(teamId)}`;
}
export function buildThreadActionPath(threadId: string, action: ThreadAction): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/${action}`;
}

/* ------------------------------------------------------------------- gates */

/** `review-workspace.workspaceCapabilitySnapshot` — the web's `canSeeDiscussion` + `readOnly`. */
export function projectDiscussionCaps(reviewWorkspace: unknown): { visible: boolean; readOnly: boolean } {
  const caps = o(o(reviewWorkspace)["workspaceCapabilitySnapshot"]);
  const enabled = caps["discussionEnabled"] === true;
  const readOnly = caps["discussionReadOnly"] === true;
  return { visible: enabled || readOnly, readOnly };
}

/* ------------------------------------------------------------------ threads */

export interface EvidenceThread {
  id: string;
  title: string;
  kind: string;
  status: string;
  escalatedAtUtc: string | null;
  updatedAt: string | null;
}

export function parseEvidenceThreads(payload: unknown): EvidenceThread[] {
  const list = o(payload)["threads"];
  const out: EvidenceThread[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = o(raw);
    const id = s(t["id"]);
    if (!id) continue;
    out.push({
      id,
      title: s(t["title"]) ?? "Untitled thread",
      kind: s(t["kind"]) ?? "",
      status: s(t["status"]) ?? "OPEN",
      escalatedAtUtc: s(t["escalatedAtUtc"]),
      updatedAt: s(t["updatedAt"]),
    });
  }
  return out;
}

/** The web's client-side filters over the loaded list, verbatim. */
export function filterEvidenceThreads(threads: EvidenceThread[], preset: ThreadFilterPreset, text: string): EvidenceThread[] {
  const q = text.trim().toLowerCase();
  return threads.filter((t) => {
    if (preset === "unresolved" && (t.status === "RESOLVED" || t.status === "CLOSED")) return false;
    if (preset === "escalated" && !t.escalatedAtUtc) return false;
    if (preset === "resolved" && t.status !== "RESOLVED" && t.status !== "CLOSED") return false;
    if (q && !t.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

/* ----------------------------------------------------------------- messages */

export interface EvidenceThreadMessage {
  id: string;
  body: string;
  authorKind: string;
  /** What the server sends for a person (projectDiscussionMessage has no name). */
  authorUserId: string | null;
  authorName: string | null;
  contributorLabel: string | null;
  createdAt: string | null;
  editedAtUtc: string | null;
}

export function parseEvidenceThreadMessages(payload: unknown): EvidenceThreadMessage[] {
  const list = o(payload)["messages"];
  const out: EvidenceThreadMessage[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = o(raw);
    const id = s(m["id"]);
    if (!id) continue;
    out.push({
      id,
      body: typeof m["body"] === "string" ? (m["body"] as string) : "",
      authorKind: s(m["authorKind"]) ?? "USER",
      authorUserId: s(m["authorUserId"]),
      authorName: s(o(m["author"])["displayName"]),
      contributorLabel: s(m["contributorLabel"]),
      createdAt: s(m["createdAt"]),
      editedAtUtc: s(m["editedAtUtc"]),
    });
  }
  return out;
}

/**
 * Who wrote it. The server projects only `authorUserId` for a person
 * (discussion.service.ts projectDiscussionMessage — no display name), so the
 * name comes from the workspace roster the screen already reads. The web prints
 * the raw id; native never prints a bare UUID and never invents a name: an id
 * the roster does not know reads "A workspace member".
 */
export function messageAuthorLabel(m: EvidenceThreadMessage, roster: Readonly<Record<string, string>> = {}): string {
  if (m.authorKind === "CONTRIBUTOR") return m.contributorLabel ?? "Contributor";
  if (m.authorKind === "SYSTEM") return "System";
  if (m.authorName) return m.authorName;
  if (m.authorUserId && roster[m.authorUserId]) return roster[m.authorUserId] as string;
  return m.authorUserId ? "A workspace member" : "Reviewer";
}

export function canPostMessage(draft: string): boolean {
  const t = draft.trim();
  return t.length > 0 && t.length <= MESSAGE_MAX;
}

/* ---------------------------------------------------------------- lifecycle */

export interface ThreadDetail {
  status: string;
  assignedToUserId: string | null;
  escalatedAtUtc: string | null;
  reopenCount: number;
  resolutionNote: string | null;
  escalationReason: string | null;
}

export function parseThreadDetail(payload: unknown): ThreadDetail | null {
  const d = o(payload);
  const t = o(d["thread"]);
  if (!s(t["id"])) return null;
  return {
    status: s(t["status"]) ?? "OPEN",
    assignedToUserId: s(t["assignedToUserId"]),
    escalatedAtUtc: s(t["escalatedAtUtc"]),
    reopenCount: typeof t["reopenCount"] === "number" ? (t["reopenCount"] as number) : 0,
    resolutionNote: s(d["resolutionNote"]),
    escalationReason: s(d["escalationReason"]),
  };
}

export function isActiveThread(status: string): boolean {
  return status === "OPEN" || status === "IN_PROGRESS";
}

/** Exactly the actions the web offers for this state. */
export function offeredThreadActions(detail: ThreadDetail | null, readOnly: boolean): ThreadAction[] {
  if (!detail || readOnly) return [];
  const out: ThreadAction[] = [];
  if (isActiveThread(detail.status)) out.push("resolve", "assign");
  if (detail.status === "RESOLVED") out.push("reopen");
  if (isActiveThread(detail.status) && !detail.escalatedAtUtc) out.push("escalate");
  return out;
}

export function threadActionBlocked(
  action: ThreadAction,
  text: string,
  assigneeUserId: string | null,
  detail: ThreadDetail | null,
): string | null {
  if (action === "assign") {
    if (!assigneeUserId) return "Choose a workspace member to assign.";
    if (assigneeUserId === detail?.assignedToUserId) return "This member is already assigned to the thread.";
    return null;
  }
  if ((action === "reopen" || action === "escalate") && !text.trim()) return "Enter the internal reason.";
  return null;
}

export function threadActionBody(action: ThreadAction, teamId: string, text: string, assigneeUserId: string | null) {
  const t = text.trim();
  if (action === "resolve") return { teamId, resolutionNote: t || null };
  if (action === "assign") return { teamId, assignedToUserId: assigneeUserId };
  return { teamId, reason: t };
}

/** Resolve and escalate ask first (web `confirm`); reopen and assign do not. */
export function threadActionConfirm(
  action: ThreadAction,
): { title: string; consequence: string; confirmLabel: string; tone: "neutral" | "warning" } | null {
  if (action === "resolve") {
    return {
      title: "Resolve this thread?",
      consequence:
        "The thread is marked resolved and closes for new messages until it is reopened. The resolution note stays internal to the workspace.",
      confirmLabel: "Resolve thread",
      tone: "neutral",
    };
  }
  if (action === "escalate") {
    return {
      title: "Escalate this thread?",
      consequence:
        "The thread is flagged as escalated for everyone in the workspace who can see it. The reason stays internal to the workspace.",
      confirmLabel: "Escalate thread",
      tone: "warning",
    };
  }
  return null;
}

/** Did the reread show the change? */
export function threadActionConfirmed(action: ThreadAction, d: ThreadDetail, assigneeUserId: string | null): boolean {
  if (action === "resolve") return d.status === "RESOLVED";
  if (action === "reopen") return isActiveThread(d.status);
  if (action === "assign") return d.assignedToUserId === assigneeUserId;
  return d.escalatedAtUtc !== null;
}

export function threadActionSuccess(action: ThreadAction, assigneeLabel: string | null): string {
  if (action === "resolve") return "Thread resolved. The saved thread was reloaded.";
  if (action === "reopen") return "Thread reopened. New messages can be posted again.";
  if (action === "assign") return `Thread assigned to ${assigneeLabel ?? "the member"}. The saved thread was reloaded.`;
  return "Thread escalated. The saved thread was reloaded.";
}

/** A stale transition is named as such; anything else goes through the safe-error projection. */
export function isStaleThreadError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "invalid_status_transition" || code === "thread_terminal";
}

/**
 * T-15 — the SERVER owns the collaboration vocabulary (GET
 * /v1/collaboration/catalogs). Curated wording first; a kind the server offers
 * that has no copy is humanised rather than dropped; anything else shows as
 * the raw token (EvidenceDiscussionPanel.tsx labelForKind). The catalog is
 * presentation metadata: if it cannot be read the curated labels still render.
 */
export const COLLABORATION_CATALOGS_PATH = "/v1/collaboration/catalogs";

const THREAD_KIND_LABELS: Record<string, string> = {
  EVIDENCE_GENERAL: "General",
  REVIEW_REQUEST_CLARIFICATION: "Review clarification",
  INVESTIGATION_COORDINATION: "Investigation",
  WORKFLOW_DISCUSSION: "Workflow",
};

export function parseCatalogThreadKinds(payload: unknown): string[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const kinds = d["threadKinds"];
  return Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : [];
}

export function threadKindLabel(kind: string, catalogKinds: ReadonlyArray<string>): string {
  const curated = THREAD_KIND_LABELS[kind];
  if (curated) return curated;
  if (catalogKinds.includes(kind)) {
    const lower = kind.replace(/_/g, " ").toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  return kind;
}
