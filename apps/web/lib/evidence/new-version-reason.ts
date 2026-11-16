/**
 * Free audit B5B-F-101 — `outputs.newVersion` can now be
 * `{ action: "NONE", reason: "NO_MATERIAL_CHANGE" }` for a Free plan-funded
 * record whose report is current (the server would refuse a new version with
 * 409 NEW_VERSION_NO_MATERIAL_CHANGE). "Generate updated report" is only ever
 * offered on `CREATE_NEW_VERSION`, so it is hidden; where the reason is shown,
 * it is said in these words. The shared reason table (packages lane) has no
 * entry for it on an older build, so the web names it here.
 */
export const NO_MATERIAL_CHANGE_TITLE = "This report is already current";
export const NO_MATERIAL_CHANGE_COPY =
  "This report is already current. An updated version becomes available when a new verification fact is recorded.";

export function isNoMaterialChange(
  newVersion: { action?: string | null; reason?: string | null } | null | undefined,
): boolean {
  return newVersion?.action === "NONE" && (newVersion.reason ?? "").toUpperCase() === "NO_MATERIAL_CHANGE";
}
