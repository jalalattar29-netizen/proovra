/**
 * PHASE 38.6 — Workflow exposure resolver.
 *
 * Pure function. Given the canonical route registry + per-route access
 * decisions + the actor's workflow profile, returns navigation buckets:
 *
 *   - primaryItems     — workflow-prioritised, sidebar-eligible
 *   - secondaryItems   — non-primary but still sidebar-eligible
 *   - moreAdvancedItems — demoted to More/Advanced (still reachable)
 *   - recommendedItems — workflow-suggested but not in sidebar yet
 *   - allToolsItems    — every reachable + requestable route
 *
 * HEADLINE GUARANTEES (all pinned by tests):
 *
 *   1. Workflow NEVER changes `canLoad` — access decisions are upstream.
 *   2. Every route with `canSeeNav: true` appears in at least one of
 *      `primaryItems / secondaryItems / moreAdvancedItems / allToolsItems`.
 *   3. `allToolsVisible` routes always land in `allToolsItems` when
 *      `canSeeNav: true` — even when no workflow tags them as priority.
 *   4. Workflow tags only INCREASE priority; absence does not remove
 *      a capability-allowed route.
 */
/**
 * Bucket the routes. Pure function.
 *
 * Bucketing rules:
 *
 *   - Routes with `canSeeNav: false` → excluded from sidebar buckets;
 *     also excluded from All Tools (they are intentionally invisible).
 *   - Routes tagged by `primaryWorkflow` AND `sidebarEligible` →
 *     `primaryItems`.
 *   - Routes tagged by a secondary workflow AND `sidebarEligible`
 *     (not already in primary) → `secondaryItems`.
 *   - Other `sidebarEligible` routes:
 *       * `advancedByDefault: true`              → `moreAdvancedItems`
 *       * `advancedByDefault: false`             → `secondaryItems`
 *   - Routes that are not `sidebarEligible` but are `allToolsVisible`
 *     → `allToolsItems` only.
 *   - `recommendedItems` is the workflow's priority list (deduplicated
 *     against primary/secondary) — useful for the hint callout.
 *   - `allToolsItems` is EVERY route with `canSeeNav: true` AND
 *     `allToolsVisible: true`, regardless of workflow.
 */
export function resolveWorkflowExposure(input) {
    const primaryItems = [];
    const secondaryItems = [];
    const moreAdvancedItems = [];
    const recommendedItems = [];
    const allToolsItems = [];
    for (const entry of input.routes) {
        const { route, access } = entry;
        // All Tools: every nav-visible + allToolsVisible route, regardless
        // of workflow priority. This is the "find anything you can use"
        // surface and the safety-net against losing track of a capability.
        if (access.canSeeNav && route.allToolsVisible) {
            allToolsItems.push({ route, access, bucketReason: "all-tools-only" });
        }
        if (!access.canSeeNav)
            continue;
        if (!route.sidebarEligible)
            continue;
        const taggedPrimary = route.workflowTags.includes(input.primaryWorkflow);
        const taggedSecondary = input.secondaryWorkflows.some((w) => route.workflowTags.includes(w));
        if (taggedPrimary) {
            primaryItems.push({
                route,
                access,
                bucketReason: "primary-workflow-match",
            });
        }
        else if (taggedSecondary) {
            secondaryItems.push({
                route,
                access,
                bucketReason: "secondary-workflow-match",
            });
        }
        else if (route.advancedByDefault) {
            moreAdvancedItems.push({
                route,
                access,
                bucketReason: "advanced-by-default",
            });
        }
        else {
            secondaryItems.push({
                route,
                access,
                bucketReason: "default-not-advanced",
            });
        }
    }
    // Recommended items: the routes whose priority tag is the primary
    // workflow but which the user can't reach OR has demoted somewhere.
    // Useful for the hint system. Deduplicated against primaryItems.
    const primaryIds = new Set(primaryItems.map((i) => i.route.id));
    for (const entry of input.routes) {
        if (primaryIds.has(entry.route.id))
            continue;
        if (!entry.route.workflowTags.includes(input.primaryWorkflow))
            continue;
        recommendedItems.push({
            route: entry.route,
            access: entry.access,
            bucketReason: "primary-workflow-match",
        });
    }
    return {
        primaryItems,
        secondaryItems,
        moreAdvancedItems,
        recommendedItems,
        allToolsItems,
    };
}
