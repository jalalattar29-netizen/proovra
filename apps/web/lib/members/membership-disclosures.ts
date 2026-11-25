/**
 * Team remediation T-105 — three behaviours an owner should know about, said
 * plainly while the decision on them is pending (ADDENDUM P5; DECISION-MEMO
 * D-1..D-4). Each sentence describes TODAY's behaviour; none changes it.
 *
 *   MEM-01  members keep access, including write, after the owner's plan is
 *           lowered or cancelled (a lowering is disclosure-only);
 *   MEM-03  there is no workspace-wide member ceiling on Pro or Team — only
 *           each Collaboration Team has a size limit;
 *   MEM-04  a case restricted to named people is invisible to an owner or
 *           admin who is not on its access list.
 *
 * One source for Members & Access help, the plan drawer and the case
 * restriction confirmation, so they cannot drift apart.
 */

/** MEM-01 — said where a plan is lowered or cancelled. */
export const MEMBER_ACCESS_AFTER_PLAN_CHANGE =
  "People you have added to your workspace keep their access, including adding and changing records, after your plan is lowered or cancelled. Remove anyone who should no longer have access from Members & Access.";

/** MEM-01 — the same fact, said on Members & Access. */
export const MEMBER_ACCESS_AFTER_DOWNGRADE_HELP =
  "Members keep their access, including adding and changing records, if the owner's plan is lowered or cancelled. Remove anyone who should no longer have access.";

/** MEM-03 — no workspace-wide ceiling. */
export const NO_WORKSPACE_MEMBER_CEILING =
  "There is no limit on the total number of members in this workspace. Limits apply to each Collaboration Team, not to the workspace as a whole.";

/** MEM-04 — restricted cases and the owner. */
export const RESTRICTED_CASE_OWNER_VISIBILITY =
  "A case restricted to named people is hidden from everyone not on its access list, including the workspace owner and admins. They cannot see it unless they are given access.";
