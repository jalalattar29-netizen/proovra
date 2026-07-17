/**
 * Effective notification timezone (2026-07-17 Settings remediation, §6).
 *
 * ONE pure rule, identical to the server-side digest scheduler:
 *
 *   1. explicit per-workspace notification-schedule override
 *   2. the account timezone (Settings → Preferences)
 *   3. UTC
 *
 * Empty/whitespace values are treated as unset so a cleared input never
 * silently becomes a fake override.
 */
export function resolveEffectiveTimezone(
  workspaceOverride: string | null | undefined,
  accountTimezone: string | null | undefined,
): string {
  const override = workspaceOverride?.trim();
  if (override) return override;
  const account = accountTimezone?.trim();
  if (account) return account;
  return "UTC";
}
