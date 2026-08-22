/**
 * PHASE 13 §UI — Automation rule lifecycle: shared client types.
 *
 * Mirrors the projection returned by `projectRule` in
 * `services/api/src/routes/automation.routes.ts`. Kept in one place so the
 * page (`app/(app)/admin/platform/automation/page.tsx`) and the lifecycle
 * controls (`AutomationRuleForm`, `AutomationRuleToggle`) cannot drift.
 */

export type AutomationRule = {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  conditionJson: unknown;
  actionType: string;
  actionConfigJson: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

export type AutomationAllowlist = {
  triggerTypes: readonly string[];
  actionTypes: readonly string[];
};
