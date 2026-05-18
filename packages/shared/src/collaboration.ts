/**
 * Phase 16 — Enterprise collaboration canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - Thread kind / status / visibility catalogs
 *   - Message author-kind + participant role catalogs
 *   - Status transition matrix
 *   - Mention parser
 *   - Body sanitiser (plain text, no markdown / HTML injection)
 *
 * Wording rule (Phase 16 brief, rule 5): collaboration NEVER claims
 * "authentic / fake / manipulated / legally admissible / verified".
 * Threads are operational; messages are operator coordination only.
 */

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

export const DISCUSSION_THREAD_KINDS = [
  "EVIDENCE_GENERAL",
  "REVIEW_REQUEST_CLARIFICATION",
  "INVESTIGATION_COORDINATION",
  "WORKFLOW_DISCUSSION",
] as const;
export type DiscussionThreadKind =
  (typeof DISCUSSION_THREAD_KINDS)[number];

export const DISCUSSION_THREAD_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
] as const;
export type DiscussionThreadStatus =
  (typeof DISCUSSION_THREAD_STATUSES)[number];

export const DISCUSSION_THREAD_TERMINAL_STATUSES: ReadonlySet<DiscussionThreadStatus> =
  new Set(["CLOSED"]);

export function isDiscussionThreadTerminal(
  status: DiscussionThreadStatus,
): boolean {
  return DISCUSSION_THREAD_TERMINAL_STATUSES.has(status);
}

export const DISCUSSION_THREAD_VISIBILITIES = [
  "INTERNAL",
  "CONTRIBUTOR_SCOPED",
] as const;
export type DiscussionThreadVisibility =
  (typeof DISCUSSION_THREAD_VISIBILITIES)[number];

export const DISCUSSION_MESSAGE_AUTHOR_KINDS = [
  "USER",
  "CONTRIBUTOR",
  "SYSTEM",
] as const;
export type DiscussionMessageAuthorKind =
  (typeof DISCUSSION_MESSAGE_AUTHOR_KINDS)[number];

export const DISCUSSION_PARTICIPANT_ROLES = [
  "PARTICIPANT",
  "RESOLVER",
  "WATCHER",
  "CONTRIBUTOR",
] as const;
export type DiscussionParticipantRole =
  (typeof DISCUSSION_PARTICIPANT_ROLES)[number];

// -----------------------------------------------------------------------------
// Status transition matrix
//
// Mirrors the Phase 13 review-stage pattern. Every transition is
// explicit. Self-transitions are no-op heartbeats. CLOSED can only
// reopen via REOPEN action.
// -----------------------------------------------------------------------------

const TRANSITIONS: Readonly<
  Record<DiscussionThreadStatus, ReadonlyArray<DiscussionThreadStatus>>
> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["IN_PROGRESS", "CLOSED"],
  CLOSED: ["IN_PROGRESS"],
};

export function isAllowedDiscussionThreadTransition(
  from: DiscussionThreadStatus,
  to: DiscussionThreadStatus,
): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedDiscussionThreadTransitions(
  from: DiscussionThreadStatus,
): ReadonlyArray<DiscussionThreadStatus> {
  return TRANSITIONS[from] ?? [];
}

// -----------------------------------------------------------------------------
// Body sanitiser
//
// Collaboration bodies are PLAIN TEXT. We strip control characters,
// normalise newlines, cap length, and decline to interpret markdown
// or HTML. The UI renders the body in a text element (not innerHTML).
// -----------------------------------------------------------------------------

export const DISCUSSION_BODY_MAX_BYTES = 8 * 1024;

export function sanitiseDiscussionBody(input: string): string {
  // 1. Reject embedded NULs and most control chars (allow \n \r \t).
  let cleaned = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (
      code === 0 ||
      (code < 32 && code !== 9 && code !== 10 && code !== 13)
    ) {
      continue;
    }
    if (code === 127) continue; // DEL
    cleaned += ch;
  }
  // 2. Normalise line endings.
  cleaned = cleaned.replace(/\r\n?/g, "\n");
  // 3. Trim + cap.
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").trim();
  if (cleaned.length > DISCUSSION_BODY_MAX_BYTES) {
    cleaned = cleaned.slice(0, DISCUSSION_BODY_MAX_BYTES);
  }
  return cleaned;
}

// -----------------------------------------------------------------------------
// Mention parser
//
// Recognises `@local-part` tokens where `local-part` matches
// /^[a-zA-Z0-9._-]+$/. The token must follow whitespace / start of
// string / open bracket and must NOT be inside an email address. The
// caller resolves tokens against the workspace membership; bare
// strings here are advisory until reconciled.
// -----------------------------------------------------------------------------

const MENTION_RE = /(^|[\s(\[{])@([a-zA-Z0-9._-]{2,64})(?=$|[\s.,:;!?)\]}\n])/g;

export function parseMentionTokens(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    // Skip @ inside an email pattern: the previous boundary captured
    // a leading char that is NOT part of an alphanum email local-part.
    const previous = m[1];
    if (/[A-Za-z0-9]/.test(previous)) continue;
    out.add(m[2].toLowerCase());
  }
  return Array.from(out);
}
