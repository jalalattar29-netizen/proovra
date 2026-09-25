/**
 * REVIEWER CRITERIA — pure projections for the criteria catalogue.
 *
 * Ports `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` over
 * `GET /v1/reviewer-criteria?teamId=`, `.../:id/duplicate`, `.../:id/:action`
 * and `GET .../:id/usage`.
 *
 * ===========================================================================
 * PUBLISHED IS IMMUTABLE, AND THAT IS THE WHOLE POINT
 * ===========================================================================
 * Criteria are human-authored and versioned, and a PUBLISHED version cannot be
 * edited — the API answers 409 `published_immutable`. A reviewer's decision is
 * only meaningful against a criteria version that cannot have changed
 * underneath it afterwards, so a surface that offers "edit" on a published set
 * is not a convenience, it is an invitation to a request that will be refused
 * and, worse, a suggestion that the record could be rewritten.
 *
 * To change a published set you DUPLICATE it, which creates a new draft. That
 * is the affordance this module exposes in its place.
 *
 * AI never creates or publishes criteria. Nothing here generates one.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildCriteriaPath(teamId: string): string {
  return `/v1/reviewer-criteria?teamId=${encodeURIComponent(teamId)}`;
}

export function buildCriteriaActionPath(setId: string, action: string): string {
  return `/v1/reviewer-criteria/${encodeURIComponent(setId)}/${encodeURIComponent(action)}`;
}

export function buildCriteriaUsagePath(setId: string, teamId: string): string {
  return (
    `/v1/reviewer-criteria/${encodeURIComponent(setId)}/usage` +
    `?teamId=${encodeURIComponent(teamId)}`
  );
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface CriteriaVersion {
  id: string;
  version: number;
  title: string;
  publishedAtIso: string | null;
  createdAtIso: string | null;
  criteriaCount: number;
}

export interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  status: string;
  versions: CriteriaVersion[];
  updatedAtIso: string | null;
}

export function parseCriteriaSets(payload: unknown): CriteriaSet[] {
  return rows(obj(payload).sets ?? obj(payload).criteriaSets ?? payload)
    .map((raw) => {
      const s = obj(raw);
      const id = str(s.id);
      if (!id) return null;

      const versions = rows(s.versions)
        .map((vraw) => {
          const v = obj(vraw);
          const vid = str(v.id);
          if (!vid) return null;
          return {
            id: vid,
            version: num(v.version) ?? 0,
            title: str(v.title) ?? "",
            publishedAtIso: str(v.publishedAt),
            createdAtIso: str(v.createdAt),
            // The list sends a COUNT (`_count.criteria`), not the rows; the rows are
            // only on a version's own read.
            criteriaCount: num(obj(v._count).criteria) ?? rows(v.criteria).length,
          };
        })
        .filter((v): v is CriteriaVersion => v !== null)
        // Newest version first: that is the one in force.
        .sort((a, b) => b.version - a.version);

      return {
        id,
        name: str(s.name) ?? "Untitled criteria set",
        description: str(s.description),
        status: str(s.status) ?? "DRAFT",
        versions,
        updatedAtIso: str(s.updatedAt),
      };
    })
    .filter((s): s is CriteriaSet => s !== null);
}

export interface CriteriaUsage {
  version: number;
  runCount: number;
  reviewCount: number;
  reviewerCount: number;
  lastUsedAtIso: string | null;
}

export function parseCriteriaUsage(payload: unknown): CriteriaUsage[] {
  return rows(obj(payload).usage ?? payload)
    .map((raw) => {
      const u = obj(raw);
      const version = num(u.version);
      if (version === null) return null;
      return {
        version,
        runCount: num(u.runCount) ?? 0,
        reviewCount: num(u.reviewCount) ?? 0,
        reviewerCount: num(u.reviewerCount) ?? 0,
        lastUsedAtIso: str(u.lastUsedAt),
      };
    })
    .filter((u): u is CriteriaUsage => u !== null)
    .sort((a, b) => b.version - a.version);
}

// ---------------------------------------------------------------------------
// What a set can actually do
// ---------------------------------------------------------------------------

export type CriteriaAction = "publish" | "duplicate" | "retire";

/**
 * The actions this set permits, in the web's order.
 *
 * Exactly what the web offers, and no more:
 *   DRAFT      → publish, retire
 *   PUBLISHED  → duplicate, retire
 *   RETIRED    → nothing
 *
 * Duplicate is offered ONLY on a published set, because that is the web's
 * affordance and this is a port. A draft is already the editable thing; a
 * second draft of it is a copy nobody asked for.
 *
 * A PUBLISHED set is NOT editable, so no edit affordance is offered for one —
 * the API answers 409 `published_immutable`, and an offer that cannot succeed
 * is worse than an absence because it implies the record could be rewritten.
 */
export function availableActions(set: CriteriaSet): CriteriaAction[] {
  const status = set.status.toUpperCase();
  const out: CriteriaAction[] = [];
  if (status === "DRAFT") out.push("publish");
  if (status === "PUBLISHED") out.push("duplicate");
  if (status !== "RETIRED") out.push("retire");
  return out;
}

export function isEditable(set: CriteriaSet): boolean {
  return set.status.toUpperCase() === "DRAFT";
}

export function criteriaActionLabel(action: CriteriaAction): string {
  switch (action) {
    case "publish":
      return "Publish";
    case "duplicate":
      return "Duplicate as draft";
    case "retire":
      return "Retire";
  }
}

/** Publishing is irreversible: the version it creates can never be edited. */
export function criteriaActionConsequence(action: CriteriaAction): string | null {
  switch (action) {
    case "publish":
      return "Publishing fixes this version permanently. It cannot be edited afterwards — to change it later, duplicate it as a new draft.";
    case "retire":
      return "Retiring takes this set out of use for new reviews. Reviews already made against it are unaffected.";
    case "duplicate":
      return null;
  }
}

export function criteriaStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "PUBLISHED":
      return "verified";
    case "DRAFT":
      return "pending";
    case "RETIRED":
      return "neutral";
    default:
      return "neutral";
  }
}

export function criteriaStatusLabel(status: string): string {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.length === 0 ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}


// ---------------------------------------------------------------------------
// Authoring a draft
// ---------------------------------------------------------------------------
//
// PATCH /v1/reviewer-criteria/:setId/draft edits the latest DRAFT version in
// place. It is the only write that changes what a criteria version SAYS, and
// it carries the two rules that make versioned criteria trustworthy:
//
//   1. It refuses a published version outright — 409 `published_immutable`.
//   2. It is optimistically concurrent. The client sends the `updatedAt` it
//      loaded as `expectedUpdatedAt`; a mismatch is 409 `draft_conflict` with
//      the server's current token, and NOTHING is written. Two admins editing
//      the same draft do not silently overwrite each other.
//
// An earlier note here said authoring was "not ported: a draft half-written on
// a phone is a draft nobody can publish". That was a statement about how long
// the form is, not about whether the product supports it — and it left the one
// surface where criteria are actually written off the device entirely.

export function buildCriteriaSetPath(setId: string, teamId: string): string {
  return (
    `/v1/reviewer-criteria/${encodeURIComponent(setId)}` +
    `?teamId=${encodeURIComponent(teamId)}`
  );
}

export function buildCriteriaDraftPath(setId: string): string {
  return `/v1/reviewer-criteria/${encodeURIComponent(setId)}/draft`;
}

export interface CriterionRow {
  key: string;
  title: string;
  required: boolean;
  reviewGuidance: string;
}

export function emptyCriterionRow(): CriterionRow {
  return { key: "", title: "", required: false, reviewGuidance: "" };
}

export interface DraftState {
  /** The concurrency token. Sent back as `expectedUpdatedAt`. */
  updatedAtIso: string | null;
  /** True when the latest version is published — this editor must not write. */
  latestPublished: boolean;
  version: number | null;
  title: string;
  rows: CriterionRow[];
}

export function parseDraftState(payload: unknown): DraftState | null {
  const set = obj(obj(payload).set);
  const latest = obj(rows(set.versions)[0]);
  if (Object.keys(latest).length === 0) return null;

  return {
    updatedAtIso: str(set.updatedAt),
    latestPublished: str(latest.publishedAt) !== null,
    version: num(latest.version),
    title: str(latest.title) ?? "",
    rows: rows(latest.criteria).map((raw) => {
      const c = obj(raw);
      return {
        key: str(c.key) ?? "",
        title: str(c.title) ?? "",
        required: c.required === true,
        reviewGuidance: str(c.reviewGuidance) ?? "",
      };
    }),
  };
}

/**
 * The bounds are the route's own (`CriterionInput`), checked here so the editor
 * can say which row is wrong instead of surfacing one flat 400 for a form with
 * fifty fields in it.
 */
export const CRITERION_KEY_MAX = 60;
export const CRITERION_TITLE_MAX = 200;
export const CRITERION_GUIDANCE_MAX = 600;
export const VERSION_TITLE_MAX = 160;
export const CRITERIA_MIN = 1;
export const CRITERIA_MAX = 50;

export function validateDraft(title: string, list: CriterionRow[]): string | null {
  if (title.trim().length === 0) return "Give this version a title.";
  if (title.trim().length > VERSION_TITLE_MAX) {
    return `The version title cannot be longer than ${VERSION_TITLE_MAX} characters.`;
  }
  if (list.length < CRITERIA_MIN) return "A version needs at least one criterion.";
  if (list.length > CRITERIA_MAX) {
    return `A version cannot have more than ${CRITERIA_MAX} criteria.`;
  }

  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const n = i + 1;
    const key = r.key.trim();
    if (key.length === 0) return `Criterion ${n} needs a key.`;
    if (key.length > CRITERION_KEY_MAX) {
      return `Criterion ${n}: the key cannot be longer than ${CRITERION_KEY_MAX} characters.`;
    }
    // The route stores criteria as rows under one version; two rows sharing a
    // key make a reviewer's answers ambiguous after the fact, which is the one
    // thing a criteria version exists to prevent.
    if (seen.has(key)) return `Criterion ${n}: the key ${key} is used twice.`;
    seen.add(key);

    if (r.title.trim().length === 0) return `Criterion ${n} needs a title.`;
    if (r.title.trim().length > CRITERION_TITLE_MAX) {
      return `Criterion ${n}: the title cannot be longer than ${CRITERION_TITLE_MAX} characters.`;
    }
    if (r.reviewGuidance.trim().length > CRITERION_GUIDANCE_MAX) {
      return `Criterion ${n}: guidance cannot be longer than ${CRITERION_GUIDANCE_MAX} characters.`;
    }
  }
  return null;
}

export function buildDraftBody(
  teamId: string,
  title: string,
  list: CriterionRow[],
  expectedUpdatedAt: string | null,
) {
  return {
    teamId,
    title: title.trim(),
    // Absent, not empty: the route takes `expectedUpdatedAt?`, and omitting it
    // skips the concurrency check entirely. It is sent whenever it is known, so
    // a save can only ever land on the state it was written against.
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    criteria: list.map((r, i) => ({
      key: r.key.trim(),
      title: r.title.trim(),
      required: r.required,
      // Order is the row position, not a number the author maintains.
      order: i,
      ...(r.reviewGuidance.trim().length > 0
        ? { reviewGuidance: r.reviewGuidance.trim() }
        : {}),
    })),
  };
}

export type DraftFailure =
  | "CONFLICT"
  | "PUBLISHED_IMMUTABLE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "UNKNOWN";

/**
 * Both `draft_conflict` and `published_immutable` are 409, and they call for
 * opposite responses: one means reload and reconcile, the other means this
 * version can never be written again. Reading the code, not the status, is the
 * difference between offering the right recovery and the wrong one.
 */
export function classifyDraftFailure(err: unknown): DraftFailure {
  const e = obj(err);
  const code = str(e.code) ?? str(obj(obj(e.details).error).code);
  if (code === "draft_conflict") return "CONFLICT";
  if (code === "published_immutable") return "PUBLISHED_IMMUTABLE";
  if (code === "permission_denied") return "FORBIDDEN";

  const status = num(e.statusCode);
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  // A 409 whose code did not arrive: the safe reading is the recoverable one,
  // because reloading a version that turns out to be published is harmless
  // while assuming immutability would strand an editable draft.
  if (status === 409) return "CONFLICT";
  return "UNKNOWN";
}

export function draftFailureMessage(failure: DraftFailure): string {
  switch (failure) {
    case "CONFLICT":
      return "This draft was changed by someone else since you loaded it. Your changes were not saved.";
    case "PUBLISHED_IMMUTABLE":
      return "This version has been published, so it can no longer be edited. Duplicate it as a new draft to carry your changes forward.";
    case "FORBIDDEN":
      return "Only workspace owners and admins can edit criteria.";
    case "NOT_FOUND":
      return "This criteria set is no longer available.";
    case "UNKNOWN":
      return "The draft could not be saved.";
  }
}

/**
 * "Save as a new draft" is offered only when the conflicting change was a
 * PUBLISH — then duplicating carries the editor content into v(N+1). If the
 * other change was an ordinary edit there is nothing to duplicate, and the
 * honest recovery is to reload and reconcile.
 */
export function canSaveAsNewDraft(serverState: DraftState | null): boolean {
  return serverState !== null && serverState.latestPublished;
}

/** Rows whose text differs from the server, for the conflict comparison. */
export function diffDraftRows(
  mine: CriterionRow[],
  theirs: CriterionRow[],
): Array<{ key: string; mine: string | null; theirs: string | null }> {
  const keys = new Set([...mine, ...theirs].map((r) => r.key.trim()).filter(Boolean));
  const find = (list: CriterionRow[], k: string) =>
    list.find((r) => r.key.trim() === k) ?? null;

  return [...keys]
    .map((key) => {
      const a = find(mine, key);
      const b = find(theirs, key);
      const at = a ? a.title.trim() : null;
      const bt = b ? b.title.trim() : null;
      return at === bt ? null : { key, mine: at, theirs: bt };
    })
    .filter((d): d is { key: string; mine: string | null; theirs: string | null } => d !== null);
}

// ---------------------------------------------------------------------------
// Creating a set
// ---------------------------------------------------------------------------
//
// POST /v1/reviewer-criteria creates the SET and its v1 DRAFT in one call. The
// set carries a name and an optional description; the version carries a title
// and the criterion rows. They are different things and the route keeps them
// apart, so this does too rather than collapsing them into one field.

export const CRITERIA_CREATE_PATH = "/v1/reviewer-criteria";
export const SET_NAME_MAX = 160;
export const SET_DESCRIPTION_MAX = 600;

export function validateNewSet(
  name: string,
  title: string,
  list: CriterionRow[],
): string | null {
  if (name.trim().length === 0) return "Give this criteria set a name.";
  if (name.trim().length > SET_NAME_MAX) {
    return `The set name cannot be longer than ${SET_NAME_MAX} characters.`;
  }
  // The version rules are the same rules; there is one place that knows them.
  return validateDraft(title, list);
}

export function buildCreateSetBody(
  teamId: string,
  name: string,
  description: string,
  title: string,
  list: CriterionRow[],
) {
  const draft = buildDraftBody(teamId, title, list, null);
  const d = description.trim();
  return {
    teamId,
    name: name.trim(),
    ...(d.length > 0 ? { description: d } : {}),
    title: draft.title,
    criteria: draft.criteria,
  };
}

// ---------------------------------------------------------------------------
// Version history + compare (T-12 — reviewer-criteria/page.tsx:158-276)
// ---------------------------------------------------------------------------

export interface HistoryCriterion {
  key: string;
  title: string;
  required: boolean;
}

export interface HistoryVersion {
  id: string;
  version: number;
  title: string;
  publishedAtIso: string | null;
  createdAtIso: string | null;
  criteria: HistoryCriterion[];
}

/** GET /v1/reviewer-criteria/:setId → `set.versions[]`, every version WITH its criteria, newest first. */
export function parseCriteriaVersionHistory(payload: unknown): HistoryVersion[] {
  return rows(obj(obj(payload).set).versions)
    .map((vraw) => {
      const v = obj(vraw);
      const id = str(v.id);
      const version = num(v.version);
      if (!id || version === null) return null;
      return {
        id,
        version,
        title: str(v.title) ?? "",
        publishedAtIso: str(v.publishedAt),
        createdAtIso: str(v.createdAt),
        criteria: rows(v.criteria)
          .map((craw) => {
            const c = obj(craw);
            const key = str(c.key);
            return key ? { key, title: str(c.title) ?? "", required: c.required === true } : null;
          })
          .filter((c): c is HistoryCriterion => c !== null),
      };
    })
    .filter((v): v is HistoryVersion => v !== null)
    .sort((a, b) => b.version - a.version);
}

/**
 * The web's key-based criteria diff, verbatim (`diffCriteria`): additions and
 * changes in `b`'s order, then removals; one explicit line when nothing
 * differs so an empty result is never mistaken for a failed compare.
 */
export function diffCriteria(a: HistoryCriterion[], b: HistoryCriterion[]): string[] {
  const mapA = new Map(a.map((c) => [c.key, c]));
  const mapB = new Map(b.map((c) => [c.key, c]));
  const out: string[] = [];
  for (const [key, c] of mapB) {
    const prev = mapA.get(key);
    if (!prev) out.push(`Added "${key}" — ${c.title}${c.required ? " (required)" : ""}`);
    else if (prev.title !== c.title || prev.required !== c.required) {
      out.push(`Changed "${key}" — ${prev.title}${prev.required ? " (required)" : ""} → ${c.title}${c.required ? " (required)" : ""}`);
    }
  }
  for (const [key, c] of mapA) {
    if (!mapB.has(key)) out.push(`Removed "${key}" — ${c.title}`);
  }
  return out.length > 0 ? out : ["No criteria differences."];
}

/** The web's per-version usage line; null when usage is unavailable (additive). */
export function versionUsageLine(u: CriteriaUsage | null, formatDate: (iso: string) => string): string | null {
  if (!u) return null;
  if (u.runCount <= 0) return "Not used by any Copilot run yet.";
  return (
    `Used in ${u.runCount} Copilot run(s) across ${u.reviewCount} review(s) by ${u.reviewerCount} reviewer(s)` +
    (u.lastUsedAtIso ? ` · last used ${formatDate(u.lastUsedAtIso)}` : "")
  );
}
