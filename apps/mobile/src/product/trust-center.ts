/**
 * TRUST CENTER — pure projections for the native trust documentation surface.
 *
 * Ports `apps/web/app/(app)/trust-center/*` over `GET /v1/trust/articles?kind=`.
 *
 * The web renders one section list per article KIND across five routes
 * (methodology, security, AI disclosure, status, subprocessors). Native renders
 * one screen with the kinds as sections — the same content and the same
 * canonical source, re-composed for a phone, which is the adaptation the device
 * requires rather than a reduction.
 *
 * The endpoint is entitlement-gated (`FEATURE_TRUST_CENTER`), so a 403 is a
 * legitimate product state and not an error to shout about.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/** The article kinds the web surfaces, with the route each one backs. */
export const TRUST_SECTIONS: ReadonlyArray<{
  kind: string;
  label: string;
  webRoute: string;
}> = [
  { kind: "METHODOLOGY", label: "Verification methodology", webRoute: "/trust-center/methodology" },
  { kind: "SECURITY", label: "Security", webRoute: "/trust-center/security" },
  { kind: "AI_DISCLOSURE", label: "AI disclosure", webRoute: "/trust-center/ai-disclosure" },
  { kind: "SUBPROCESSOR", label: "Subprocessors", webRoute: "/trust-center/subprocessors" },
  { kind: "STATUS", label: "Status", webRoute: "/trust-center/status" },
];

export interface TrustArticle {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  version: number | null;
  updatedAtIso: string | null;
  status: string;
}

/**
 * One section's outcome. `degraded` is deliberately distinct from `empty`:
 * the endpoint reports a read failure explicitly, and "we could not read this"
 * must never render as "there is nothing here" on a trust surface.
 */
export type TrustSectionState =
  | { phase: "loaded"; articles: TrustArticle[] }
  | { phase: "empty" }
  | { phase: "degraded"; reason: string }
  | { phase: "locked" };

export function buildTrustArticlesPath(kind: string): string {
  return `/v1/trust/articles?kind=${encodeURIComponent(kind)}`;
}

export function parseTrustArticles(payload: unknown): TrustSectionState {
  const o = obj(payload);
  if (o.degraded === true) {
    return { phase: "degraded", reason: str(o.reason) ?? "ARTICLE_READ_FAILED" };
  }
  if (str(o.denial) === "ENTITLEMENT_REQUIRED") return { phase: "locked" };

  const articles = rows(o.articles)
    .map((raw) => {
      const a = obj(raw);
      return {
        id: str(a.id) ?? "",
        slug: str(a.slug) ?? "",
        title: str(a.title) ?? "Untitled",
        summary: str(a.summary) ?? "",
        body: str(a.body) ?? "",
        version: int(a.version),
        updatedAtIso: str(a.updatedAtUtc) ?? str(a.updatedAt),
        status: str(a.status) ?? "PUBLISHED",
      };
    })
    // A DRAFT or DEPRECATED article is not the published trust position, and a
    // trust surface showing an unpublished claim is worse than showing nothing.
    .filter((a) => a.status === "PUBLISHED");

  return articles.length === 0 ? { phase: "empty" } : { phase: "loaded", articles };
}

/** A 403 from the entitlement gate is a product state, not a failure. */
export function isEntitlementDenial(err: unknown): boolean {
  const e = obj(err);
  const status = int(e.status) ?? int(obj(e.response).status);
  const code = str(e.code) ?? str(obj(e.body).denial);
  return status === 403 || code === "ENTITLEMENT_REQUIRED";
}

export function trustSectionTone(state: TrustSectionState): ProovraStatusTone {
  if (state.phase === "degraded") return "risk";
  if (state.phase === "locked") return "governance";
  if (state.phase === "empty") return "neutral";
  return "verified";
}
