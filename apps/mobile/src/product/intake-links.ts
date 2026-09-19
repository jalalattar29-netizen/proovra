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
