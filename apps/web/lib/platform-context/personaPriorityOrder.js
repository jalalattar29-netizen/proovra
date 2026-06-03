/**
 * PHASE 38 — Persona-aware sidebar reordering.
 *
 * Pure function. Reorders an existing list of sidebar items based on the
 * active persona. NEVER adds or removes items — the canonical capability
 * registry is the sole source of truth for what the user can see.
 *
 * The "priority" of each persona is a bounded list of nav-item id prefixes
 * (the canonical ids the server emits in `navigation.sidebar.groups[*].items[*].id`).
 * Items whose id starts with one of the priority prefixes are pulled to
 * the top, preserving their relative order; the remaining items keep
 * their original order.
 */
// Bounded priority ordering per persona. Item ids are matched by exact
// equality or dotted-prefix (`workspace.capture` matches `workspace.capture`
// or `workspace.capture.*`). Matches the canonical id space declared in
// services/api/src/services/platform-context/navigation-registry.ts.
export const PERSONA_PRIORITY_PREFIXES = {
    INDIVIDUAL: [
        "workspace.capture",
        "workspace.evidence",
        "workspace.cases",
        "workspace.reports",
        "workspace.search",
        "account.billing",
    ],
    LAWYER: [
        "workspace.cases",
        "workspace.evidence",
        "workspace.reports",
        "governance.hub",
        "governance.lifecycle",
        "review.queue",
    ],
    INSURANCE: [
        "review.queue",
        "review.sla",
        "review.escalations",
        "workspace.cases",
        "workspace.evidence",
        "governance.hub",
    ],
    INVESTIGATOR: [
        "workspace.capture",
        "workspace.search",
        "workspace.cases",
        "workspace.evidence",
        "workspace.reports",
        "review.queue",
    ],
    JOURNALIST: [
        "workspace.capture",
        "workspace.reports",
        "workspace.evidence",
        "workspace.search",
        "workspace.cases",
    ],
    ENTERPRISE_COMPLIANCE: [
        "governance.hub",
        "governance.lifecycle",
        "governance.policy",
        "governance.retention",
        "governance.destruction",
        "platform.ops_center",
    ],
    ADMIN_OPERATOR: [
        "platform.ops_center",
        "platform.observability",
        "platform.runbooks",
        "platform.security_center",
        "review.queue",
        "governance.hub",
    ],
};
/**
 * Reorder a list of items by persona priority. Items whose `id` starts
 * with one of the persona's priority prefixes are moved to the top
 * (in priority-list order); the rest retain their original order.
 */
export function reorderByPersona(items, persona) {
    const { priority, more } = splitByPersona(items, persona);
    return [...priority, ...more];
}
/**
 * PHASE 38.1 — split a list of items into a "priority" bucket (items
 * matching the persona's priority prefixes) and a "more" bucket
 * (everything else, in original order).
 *
 * NEVER drops items. Combined `priority.length + more.length === items.length`.
 * Pure function — no side effects.
 *
 * For the default `INDIVIDUAL` persona, every item is treated as
 * priority (the canonical order is the intended order).
 */
export function splitByPersona(items, persona) {
    const prefixes = PERSONA_PRIORITY_PREFIXES[persona] ?? [];
    if (items.length === 0) {
        return { priority: [], more: [] };
    }
    // INDIVIDUAL has the canonical order — render every item as priority.
    // The "More / Advanced" disclosure only kicks in for operator personas
    // who actually demote some surfaces.
    if (persona === "INDIVIDUAL" || prefixes.length === 0) {
        return { priority: [...items], more: [] };
    }
    const priority = [];
    const claimed = new Set();
    for (const prefix of prefixes) {
        for (const item of items) {
            if (claimed.has(item.id))
                continue;
            if (item.id === prefix ||
                item.id.startsWith(`${prefix}.`) ||
                item.id.startsWith(`${prefix}-`)) {
                priority.push(item);
                claimed.add(item.id);
            }
        }
    }
    const more = items.filter((item) => !claimed.has(item.id));
    return { priority, more };
}
