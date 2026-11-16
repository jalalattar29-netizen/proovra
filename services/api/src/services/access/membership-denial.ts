/**
 * WHICH REFUSALS ARE "A CONTEXT YOU CANNOT ENTER" — the one list.
 *
 * Under anti-enumeration a refusal that is about the caller's MEMBERSHIP (no
 * row, not active, access expired, organization not active, kind unprovable)
 * is answered exactly like a missing resource (404): a former or suspended
 * member must not learn that a case or workspace still exists. A refusal that
 * is about a PERMISSION the valid member lacks stays a 403.
 *
 * `middleware/authorize.ts#resolveDenyHttpStatus` decides from this list, and
 * so do the routes that still evaluate membership themselves (SIU case
 * routes, the graph admin gate — free-audit 0ea0 B3C-F-011), so the two can
 * never disagree.
 */
export const MEMBERSHIP_DENIAL_REASONS: ReadonlySet<string> = new Set([
  "no_actor",
  "member_not_active",
  "member_access_expired",
  "organization_not_active",
  "workspace_kind_unresolved",
]);

export function isMembershipDenial(reason: string | null | undefined): boolean {
  return typeof reason === "string" && MEMBERSHIP_DENIAL_REASONS.has(reason);
}
