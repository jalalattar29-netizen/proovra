/**
 * The public Verify "Record" tab: which summary fields it shows, by label.
 *
 * The list named "Capture Method" after the field was renamed "Acquisition"
 * (UC-0), so the acquisition statement silently dropped out of the tab, and
 * "Workspace" was never listed. Every label here must be a label the summary
 * actually produces.
 */
export const RECORD_TAB_FIELD_LABELS: readonly string[] = [
  "Evidence Status At Report Generation",
  "Verification Status",
  "Integrity Status",
  "Evidence Title",
  "Evidence ID",
  "Evidence Type",
  "Evidence Structure",
  "Acquisition",
  "Submitted By",
  "Auth Provider",
  "Identity Level",
  "Workspace",
  "Organization",
  "Organization Verified",
  "Report Version",
  "Verification Package Version",
  "Reviewer Summary Version",
  "Created At",
  "Server received at",
  "Uploaded At",
  "Signed At",
  "Generated At",
  // Match the renamed label from Blocker 1.
  "Last meaningful verification",
  "Last public verify page view",
  "Current public verify page view",
  "File Type",
];

export function selectRecordTabFields<T extends { label: string }>(fields: readonly T[]): T[] {
  return fields.filter((field) => RECORD_TAB_FIELD_LABELS.includes(field.label));
}
