/**
 * PHASE 11 §5 — THE ONE canonical billing Workspace locator.
 *
 * Before this module there were TWO overlapping vocabularies for naming
 * the billing/pricing workspace in a URL:
 *
 *   - `?workspace=personal|team`  (built by the marketing pricing page)
 *   - `?team=<uuid>`              (built by the team detail page)
 *
 * They are now converged into ONE query param — `?workspace=` — whose value
 * encodes both the workspace KIND and (for a team) the specific workspace id:
 *
 *   personal          → workspace=personal
 *   team (no id)       → workspace=team
 *   team (with id)     → workspace=team:<uuid>
 *
 * This file is the ONLY producer AND the ONLY parser of that param. Callers
 * never hand-write `?workspace=` / `?team=` for billing again. The legacy
 * `?team=<uuid>` alias is deleted product-wide (folded into `team:<uuid>`).
 *
 * IMPORTANT — this locator NAMES the workspace; it does NOT grant anything.
 * The server remains authoritative for every commercial capability
 * (persisted membership, lifecycle, org policy, commercial management). A
 * URL value can never select a workspace/plan the server would reject.
 */

/** The single canonical query param that names the billing workspace. */
export const BILLING_WORKSPACE_PARAM = "workspace";

/** The optional checkout-plan hint that may accompany the locator. */
export const BILLING_PLAN_PARAM = "plan";

/** Self-serve checkout plan hints (the workspace locator is separate from these). */
export type BillingPlanHint = "PAYG" | "PRO" | "TEAM";

/**
 * A billing workspace locator — a KIND plus, for a team, an optional
 * specific workspace id. This is the ONLY shape callers build/parse.
 */
export type BillingWorkspaceLocator =
  | { kind: "personal" }
  | { kind: "team"; teamId?: string | null }
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — an ORGANIZATION billing
   * account.
   *
   * Added to the EXISTING vocabulary rather than beside it. Billing now selects
   * one of three account kinds, and an Enterprise organization is a billing
   * subject in its own right — its constituent workspaces bill through its
   * contract rather than each carrying one. A second query parameter would have
   * meant two parsers for one question, which is the ambiguity this module was
   * created to end.
   *
   * The id is deliberately part of the VALUE ("organization:<id>") rather than
   * a bare id: a bare id cannot say whether it names a workspace or an
   * organization, and the two are different tenancy objects.
   */
  | { kind: "organization"; organizationId: string };

/** Minimal read surface shared by URLSearchParams and Next's ReadonlyURLSearchParams. */
type ParamReader = { get(name: string): string | null };

/**
 * Encode a locator to the canonical `workspace` param VALUE (one vocabulary).
 * The team id is URL-encoded; personal + bare-team never emit an id.
 */
export function encodeBillingWorkspace(locator: BillingWorkspaceLocator): string {
  if (locator.kind === "personal") return "personal";
  if (locator.kind === "organization") {
    return `organization:${encodeURIComponent(locator.organizationId)}`;
  }
  const id = locator.teamId?.trim();
  return id ? `team:${encodeURIComponent(id)}` : "team";
}

/**
 * Parse the canonical `workspace` param into a locator. Anything unknown or
 * absent falls back to the billing default (personal). This parser reads ONLY
 * the `workspace` param — it deliberately does NOT read the retired `?team=`
 * alias, so the old vocabulary can never leak back in through the parser.
 */
export function parseBillingWorkspaceLocator(
  params: ParamReader,
): BillingWorkspaceLocator {
  const raw = params.get(BILLING_WORKSPACE_PARAM);
  if (!raw) return { kind: "personal" };
  const value = raw.trim().toLowerCase() === "personal" ? "personal" : raw.trim();
  if (value === "personal") return { kind: "personal" };
  if (value === "team") return { kind: "team" };
  if (value.startsWith("team:")) {
    const id = decodeURIComponent(value.slice("team:".length)).trim();
    return id ? { kind: "team", teamId: id } : { kind: "team" };
  }
  if (value.startsWith("organization:")) {
    const id = decodeURIComponent(value.slice("organization:".length)).trim();
    // An organization locator with no id names nothing. Falling back to the
    // default is safer than inventing a tenant.
    return id ? { kind: "organization", organizationId: id } : { kind: "personal" };
  }
  // Unknown value — never trust it as a tenant; fall back to the default.
  return { kind: "personal" };
}

/**
 * Build a canonical billing href from a locator (+ optional plan hint). This
 * is the ONLY sanctioned way to construct a billing link that names a
 * workspace. The plan hint is a separate checkout concern appended after the
 * workspace param; it is not part of the workspace identity vocabulary.
 */
export function buildBillingHref(
  locator: BillingWorkspaceLocator,
  opts?: { plan?: BillingPlanHint; basePath?: string },
): string {
  const base = opts?.basePath ?? "/billing";
  const search = new URLSearchParams();
  search.set(BILLING_WORKSPACE_PARAM, encodeBillingWorkspace(locator));
  if (opts?.plan) search.set(BILLING_PLAN_PARAM, opts.plan);
  return `${base}?${search.toString()}`;
}
