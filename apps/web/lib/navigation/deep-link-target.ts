/**
 * B2A-F-07 (Free-user audit 0ea0) — WHAT A DEEP LINK POINTS AT, AND WHERE IT
 * MUST LAND.
 *
 * The shared parser (`parseInternalResourcePath`) reads exactly two segments
 * and drops the rest, so the chokepoint navigated to `/evidence/E` for
 * `/evidence/E?tab=discussion#note-3`, parsed `/investigation/cases/K/graph`
 * as an "investigation" with id "cases" (which never resolves), and treated
 * section pages such as `/review/queues` or `/reports?evidenceId=…` as
 * resources the server could only deny.
 *
 * This module classifies a destination against the app's REAL record routes:
 *   /evidence/:id[/…]                 → evidence :id
 *   /cases/:id[/…]                    → case :id
 *   /evidence-requests/:id[/…]        → evidence request :id
 *   /investigation/cases/:id[/…]      → case :id (the case's graph)
 * Anything else — `/reports…`, `/review/…`, `/audit-transparency…`, the other
 * `/investigation/…` pages, section roots — is a plain in-app destination:
 * there is no id-bearing page there to resolve, and the page gates itself.
 *
 * `path` is always the ORIGINAL destination (sub-path, query and hash kept);
 * resolution decides whether, and in which workspace, to open it — never what
 * to open.
 */
import type { InternalResourceType } from "@proovra/shared";

export type DeepLinkTarget = {
  /** The record the destination names, or null for a plain in-app path. */
  resource: { type: InternalResourceType; id: string } | null;
  /** The destination to open, exactly as given (internal paths only). */
  path: string;
};

const RECORD_ROUTES: ReadonlyArray<{ re: RegExp; type: InternalResourceType }> = [
  { re: /^\/evidence\/([^/?#]+)/, type: "evidence" },
  { re: /^\/cases\/([^/?#]+)/, type: "cases" },
  { re: /^\/evidence-requests\/([^/?#]+)/, type: "evidence-requests" },
  { re: /^\/investigation\/cases\/([^/?#]+)/, type: "cases" },
];

/** Static (non-record) children of the record families: never ids. */
const NOT_AN_ID = new Set(["archive", "new"]);

export function parseDeepLinkTarget(href: string): DeepLinkTarget {
  const path = href.trim();
  for (const route of RECORD_ROUTES) {
    const m = route.re.exec(path);
    if (!m) continue;
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return { resource: null, path };
    }
    if (!id || NOT_AN_ID.has(id.toLowerCase())) return { resource: null, path };
    return { resource: { type: route.type, id }, path };
  }
  return { resource: null, path };
}
