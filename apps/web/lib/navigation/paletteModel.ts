import type { RouteDefinition } from "./routeRegistry";

/**
 * HOW THE COMMAND PALETTE DECIDES WHAT TO SHOW, AND IN WHAT ORDER.
 *
 * =============================================================================
 * THE PARADOX THIS EXPLAINS
 * =============================================================================
 * A FREE account saw "All Tools" in the palette and a PRO account did not.
 * There is no plan rule anywhere that says so, and that is exactly the problem:
 * the behaviour was an accident of truncation.
 *
 * The old ranking was three booleans — `canLoad` (+2) and `!advancedByDefault`
 * (+1) — giving every route a score of 0 to 3, sorted, then
 * `.slice(0, MAX_RESULTS)` with `MAX_RESULTS = 20`. The registry holds 142
 * routes, 117 of them palette-visible and 114 of them `advancedByDefault`.
 *
 * `/tools` is advanced-by-default, so it scores 2. Every non-advanced route the
 * user can load scores 3. A PRO account is entitled to MORE routes, so it has
 * more 3s — enough to fill all twenty slots and push every 2 off the list.
 * A FREE account has fewer, so the 2s reach the visible twenty.
 *
 * More entitlements meant FEWER things visible. Not a flag, not a cache, not a
 * role, not an experiment: an ordering with only four possible values and a
 * hard cut at twenty.
 *
 * =============================================================================
 * WHAT REPLACES IT
 * =============================================================================
 * A query gets RELEVANCE. Typing "billing" must put Billing first — under the
 * old scheme every loadable non-advanced route tied at 3, so ties broke by
 * registry order and a route whose *description* mentioned billing could
 * outrank the Billing page itself.
 *
 * An empty query gets a DELIBERATE default: the surfaces someone would
 * actually jump to, in a fixed order, rather than whichever twenty routes won
 * a tie-break. What a user sees when they press cmd-K should not depend on how
 * many features they have bought.
 */

/** The four groups a palette row can belong to. */
export type PaletteGroup = "Pages" | "Settings" | "Tools" | "Governance";

/**
 * Which group a route belongs to.
 *
 * Settings first: a settings subpage is a settings destination whatever else
 * it is about, and the screenshots showed seven of them rendered as though
 * they were unrelated product tools.
 */
export function paletteGroupFor(route: RouteDefinition): PaletteGroup {
  /*
   * Settings subpages are HASH routes on one page — `/settings#preferences`,
   * `/settings#privacy`, `/settings#security` and so on — not `/settings/x`.
   * A predicate that only looked for the slash form missed every one of them,
   * which is exactly how seven Settings tabs came to be rendered in the
   * palette as though they were unrelated product tools.
   */
  if (route.href === "/settings" || /^\/settings[#/]/.test(route.href)) {
    return "Settings";
  }
  if (route.requiredActiveSpace === "ORGANIZATION_ONLY") return "Governance";
  if (route.advancedByDefault) return "Tools";
  return "Pages";
}

/**
 * The title shown in the palette.
 *
 * A settings row is prefixed so it reads as a destination WITHIN Settings —
 * "Settings · Preferences", not a standalone tool called "Preferences". The
 * prefix is not added when the label already carries it, so the canonical
 * label stays the single source of the name.
 */
export function paletteTitleFor(route: RouteDefinition): string {
  if (paletteGroupFor(route) !== "Settings") return route.label;
  if (route.href === "/settings") return "Settings · Overview";
  if (/^settings\b/i.test(route.label)) return route.label;
  return `Settings · ${route.label}`;
}

/**
 * Relevance of one route to one query. Higher wins; 0 means no match.
 *
 * The bands are wide apart on purpose. An exact title match must beat a
 * description match by more than any tie-break can recover, because the
 * failure being fixed is precisely a description match outranking the page the
 * user named.
 */
export function scorePaletteMatch(route: RouteDefinition, query: string): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;

  const label = route.label.toLowerCase();
  const title = paletteTitleFor(route).toLowerCase();

  if (label === q || title === q) return 1000;
  if (label.startsWith(q)) return 800;
  // "settings preferences" should find "Settings · Preferences".
  if (title.includes(q)) return 600;
  if (label.includes(q)) return 500;
  if (route.id.toLowerCase().includes(q)) return 200;
  if (route.description.toLowerCase().includes(q)) return 100;
  return 0;
}

/**
 * The routes shown when nothing has been typed.
 *
 * Deliberately NOT "the top N by score". A default list assembled by ranking
 * is a default list that changes when entitlements change, which is how the
 * FREE/PRO paradox happened. These are the destinations someone opening a
 * command palette is actually looking for.
 */
export const PALETTE_DEFAULT_ROUTE_IDS: readonly string[] = [
  "workspace.home",
  "workspace.capture",
  "workspace.evidence",
  "workspace.cases",
  "workspace.reports",
  "workspace.search",
  "account.notifications",
  "account.settings",
];

export type PaletteCandidate<T> = {
  route: RouteDefinition;
  canLoad: boolean;
  item: T;
};

/**
 * Order candidates for display.
 *
 * With a query: relevance, then whether it can actually be opened, then
 * non-advanced before advanced, then registry order.
 *
 * Without a query: the curated defaults in their listed order, then anything
 * else the user can open. `/tools` is advanced, so it never displaces a
 * primary destination — the behaviour the paradox was really about.
 */
export function orderPaletteCandidates<T>(
  candidates: PaletteCandidate<T>[],
  query: string,
): PaletteCandidate<T>[] {
  const q = query.trim();

  if (q.length === 0) {
    const rank = new Map(PALETTE_DEFAULT_ROUTE_IDS.map((id, i) => [id, i]));
    return [...candidates]
      .filter((c) => rank.has(c.route.id))
      .sort((a, b) => (rank.get(a.route.id) ?? 0) - (rank.get(b.route.id) ?? 0));
  }

  return [...candidates]
    .map((c, index) => ({ c, index, score: scorePaletteMatch(c.route, q) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.c.canLoad) - Number(a.c.canLoad) ||
        Number(a.c.route.advancedByDefault) - Number(b.c.route.advancedByDefault) ||
        a.index - b.index,
    )
    .map((x) => x.c);
}

/**
 * Collapse rows that resolve to the same destination.
 *
 * By HREF, never by title. Two registry entries can carry different labels for
 * one route (`workspace.review` and `review.queue` both point at `/review`),
 * and two genuinely different surfaces can carry similar titles — Notifications
 * and Settings · Notification preferences are not the same page and must both
 * survive. The href is the destination; the title is only how it reads.
 *
 * The first occurrence wins, so ordering decides which label is kept.
 */
export function dedupeByDestination<T extends { route: RouteDefinition }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.route.href)) continue;
    seen.add(item.route.href);
    out.push(item);
  }
  return out;
}
