/**
 * CANONICAL NATIVE INTAKE LINKS (Master Program §9, Workstream F) — pure.
 *
 * GET /v1/workflow/intake-links?teamId → { items[] } (member-accessible;
 * feature-flag guarded). IMPORTANT truthful constraint: the intake token is a
 * server-side SECRET — the raw link URL is returned only once at creation and is
 * NEVER exposed in listings (links are delivered server-side via /send). So the
 * native surface is view + revoke; it does not (and cannot) show/copy an existing
 * link's URL, and it never fabricates one. Creation stays web-managed (it needs
 * the public web origin + template catalog + the one-time URL).
 *
 * These pure parsers read the enriched list projection defensively (item.link.*
 * with a flat fallback) and map status → tone; the RN screen is a thin shell.
 */

import { listEnvelope } from "./envelope";
import type { ProovraStatusTone } from "@proovra/ui";
import { humanizeEnum } from "./domain-display";

export interface IntakeLinkItem {
  id: string;
  templateName: string;
  recipientLabel: string | null;
  status: string;
  usedCount: number;
  maxUses: number | null;
  expiresAtUtc: string | null;
  archived: boolean;
}

const STATUS_TONE: Record<string, ProovraStatusTone> = {
  ACTIVE: "info",
  OPEN: "info",
  SENT: "info",
  OPENED: "info",
  VIEWED: "info",
  IN_PROGRESS: "pending",
  SUBMITTED: "verified",
  FULFILLED: "verified",
  COMPLETED: "verified",
  EXPIRED: "neutral",
  REVOKED: "risk",
  ARCHIVED: "neutral",
};

export function intakeStatusDisplay(status: string | null | undefined): { label: string; tone: ProovraStatusTone } {
  const key = (status ?? "").toUpperCase();
  return { label: key ? humanizeEnum(key) : "Unknown", tone: STATUS_TONE[key] ?? "neutral" };
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse GET /v1/workflow/intake-links → { items } into view rows (defensive). */
export function parseIntakeLinks(data: unknown): IntakeLinkItem[] {
  const items = Array.isArray(o(data)["items"]) ? (o(data)["items"] as unknown[]) : [];
  const out: IntakeLinkItem[] = [];
  for (const raw of items) {
    const item = o(raw);
    // Enriched projection nests the row under `link`; fall back to flat fields.
    const link = "link" in item ? o(item["link"]) : item;
    const lifecycle = o(item["lifecycle"]);
    const id = s(link["id"]);
    if (!id) continue;
    out.push({
      id,
      templateName: s(link["workflowTemplateName"]) ?? s(link["workflowTemplateSlug"]) ?? "Intake link",
      recipientLabel: s(link["recipientLabel"]) ?? s(link["customerId"]),
      status: s(lifecycle["state"]) ?? s(link["status"]) ?? "",
      usedCount: n(link["usedCount"]) ?? 0,
      maxUses: n(link["maxUses"]),
      expiresAtUtc: s(link["expiresAtUtc"]),
      archived: !!link["archivedAtUtc"],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Submissions, archive, send, and the one audited disclosure
// ---------------------------------------------------------------------------

export function buildIntakeSubmissionsPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/submissions`;
}

export function buildIntakeArchivePath(linkId: string, archived: boolean): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/${archived ? "unarchive" : "archive"}`;
}

export function buildIntakeSendPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/send`;
}

export function buildIntakeRevealPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/recipient-contact`;
}

export interface IntakeSubmission {
  id: string;
  status: string;
  submitterName: string | null;
  /** Already MASKED by the server. Never the raw address. */
  submitterEmailPreview: string | null;
  submitterPhonePreview: string | null;
  pseudonym: string | null;
  submittedAtIso: string | null;
  abandonedAtIso: string | null;
}

function io(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function is(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * `GET /v1/workflow/intake-links/:id/submissions` sends
 * `{ link, sessions, totals }` - `loadIntakeLinkSubmissions` in
 * services/api/src/services/intake-link-lifecycle.service.ts:705, and the web
 * drawer reads `payload.sessions` (SubmissionsDrawer.tsx:92).
 *
 * This read `submissions`, a key the route has never sent, then fell through
 * to the bare payload and reported an empty list - so the drawer showed "no
 * submissions" for every link that had them. The per-session field names below
 * were right all along; only the envelope was guessed.
 *
 * `submissions` is NOT kept as a compatibility key. A compatibility key is a
 * shape the server once sent; this one was invented by the client, so keeping
 * it would only preserve the defect in a form no test could see.
 */
export function parseIntakeSubmissions(payload: unknown): IntakeSubmission[] {
  return listEnvelope(payload, ["sessions"])
    .map((entry) => {
      const s = io(entry);
      const id = is(s["id"]);
      if (!id) return null;
      return {
        id,
        status: is(s["status"]) ?? "OPENED",
        submitterName: is(s["submitterDisplayName"]),
        // The projection masks these itself, for everybody. Nothing here
        // un-masks them and nothing here asks for the raw form.
        submitterEmailPreview: is(s["submitterEmailPreview"]),
        submitterPhonePreview: is(s["submitterPhonePreview"]),
        pseudonym: is(s["pseudonym"]),
        submittedAtIso: is(s["submittedAtUtc"]),
        abandonedAtIso: is(s["abandonedAtUtc"]),
      };
    })
    .filter((s): s is IntakeSubmission => s !== null);
}

/** The two channels that remain. A request naming a retired one is refused. */
export const INTAKE_SEND_CHANNELS = ["SMS", "EMAIL"] as const;
export type IntakeSendChannel = (typeof INTAKE_SEND_CHANNELS)[number];

/**
 * Resending needs the RAW TOKEN, which the API never persists.
 *
 * So a resend is possible only for a link whose token this client still holds
 * — in practice, one created in this session. After a relaunch it is gone, and
 * offering a Send control then would produce a request that cannot be formed.
 * The surface offers it exactly when it can be honoured.
 */
export function canResendIntakeLink(rawToken: string | null | undefined): boolean {
  return typeof rawToken === "string" && rawToken.length >= 8;
}

export function buildIntakeSendBody(input: {
  channel: IntakeSendChannel;
  rawToken: string;
  intakeUrl: string;
  idempotencyKey?: string;
}) {
  const body: Record<string, unknown> = {
    channel: input.channel,
    rawToken: input.rawToken,
    intakeUrl: input.intakeUrl,
  };
  // The nonce is why tapping Resend twice does not become two provider calls.
  if (input.idempotencyKey) body.idempotencyKey = input.idempotencyKey;
  return body;
}

export interface RevealedContact {
  email: string | null;
  phone: string | null;
}

export function parseRevealedContact(payload: unknown): RevealedContact {
  const c = io(io(payload)["recipientContact"]);
  return { email: is(c["recipientEmail"]), phone: is(c["recipientPhone"]) };
}

/**
 * The words shown before a reveal happens.
 *
 * This is the ONLY place a raw recipient address leaves the API. Every
 * projection ships the masked form for everybody; asking here is an act with a
 * consequence, it requires a capability, and the disclosure is recorded at
 * WARNING severity. A user should know that before they tap, not discover it
 * in an audit log afterwards.
 */
export const INTAKE_REVEAL_CONSEQUENCE =
  "Revealing the recipient's contact details is recorded against your account, with the reason. " +
  "Everywhere else in the product this address stays masked.";
