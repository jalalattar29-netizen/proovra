/**
 * SAVED SEARCHES — read side of GET /v1/search/saved-views?teamId
 * (search.routes.ts:407 → `{ views }`, each `projectView` in
 * services/api/src/services/search/saved-search.service.ts:42:
 * { id, name, description, visibility: PRIVATE|TEAM, pinned, …, query }).
 *
 * The web lists these in its guidance column for every user and applies one
 * on tap (SearchGuidance.tsx "Saved searches"). Creating, renaming and
 * deleting a view live in the filter rail behind `isPlatformAdmin`
 * (search/page.tsx:2144) and are not ported.
 */
import {
  SEARCH_DOCUMENT_TYPES,
  SEARCH_LIFECYCLE_TOGGLES,
  SEARCH_SORT_OPTIONS,
  type SearchDocumentType,
  type SearchEvidenceKind,
  type SearchLifecycleFlag,
  type SearchMode,
  type SearchSortMode,
} from "./search";

export interface SearchSavedView {
  id: string;
  name: string;
  /** search/page.tsx SAVED_VIEW_VISIBILITY_LABEL — TEAM is "Workspace" in product words. */
  visibilityLabel: string;
  pinned: boolean;
  query: {
    q: string | null;
    documentTypes: SearchDocumentType[];
    evidenceTypes: SearchEvidenceKind[];
    lifecycle: Partial<Record<SearchLifecycleFlag, boolean>>;
    updatedSinceUtc: string | null;
    updatedUntilUtc: string | null;
    sort: SearchSortMode | null;
    mode: SearchMode | null;
  };
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const KINDS: readonly string[] = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];
const MODES: readonly string[] = ["KEYWORD", "SEMANTIC", "HYBRID"];

export function parseSavedViews(payload: unknown): SearchSavedView[] {
  const list = Array.isArray(o(payload)["views"]) ? (o(payload)["views"] as unknown[]) : [];
  const out: SearchSavedView[] = [];
  for (const raw of list) {
    const v = o(raw);
    if (typeof v["id"] !== "string" || typeof v["name"] !== "string") continue;
    const q = o(v["query"]);
    const lifecycle: Partial<Record<SearchLifecycleFlag, boolean>> = {};
    for (const { flag } of SEARCH_LIFECYCLE_TOGGLES) if (q[flag] === true) lifecycle[flag] = true;
    const sort = SEARCH_SORT_OPTIONS.find((s) => s.value === q["sort"])?.value ?? null;
    const mode = typeof q["mode"] === "string" ? q["mode"].toUpperCase() : null;
    out.push({
      id: v["id"] as string,
      name: v["name"] as string,
      visibilityLabel: v["visibility"] === "TEAM" ? "Workspace" : "Private",
      pinned: v["pinned"] === true,
      query: {
        q: typeof q["q"] === "string" && q["q"].trim() ? (q["q"] as string) : null,
        documentTypes: strs(q["documentTypes"]).filter((t): t is SearchDocumentType => (SEARCH_DOCUMENT_TYPES as readonly string[]).includes(t)),
        evidenceTypes: strs(q["evidenceTypes"]).filter((t): t is SearchEvidenceKind => KINDS.includes(t)),
        lifecycle,
        updatedSinceUtc: typeof q["updatedSinceUtc"] === "string" ? (q["updatedSinceUtc"] as string) : null,
        updatedUntilUtc: typeof q["updatedUntilUtc"] === "string" ? (q["updatedUntilUtc"] as string) : null,
        sort,
        mode: mode && MODES.includes(mode) ? (mode as SearchMode) : null,
      },
    });
  }
  return out;
}
