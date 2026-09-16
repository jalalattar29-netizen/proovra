# Export snapshots

Open Governance → Export Governance, or /governance?tab=exports.

The existing governance export tab lists immutable snapshots with purpose and evidence filters, 25 records per page, detail reads, and a hash check. A snapshot records governance state; it does not create a downloadable export, select case records, or confer permission to export. With no evidence ID it records workspace governance.

Creation is confirmed before submission. The server projects creation access from the same evidence.generate_package authorization evaluator used by POST; listing, detail and verification retain governance.policy.read. Platform status never bypasses tenant membership. The server always checks POST authority again.

Success requires rereading the created snapshot. A failed or refused list remains an error, and an unsuccessful detail reread is reported separately from the completed write. Verify integrity compares the stored payload to the recorded hash; it does not establish legal admissibility.

Pagination binds its continuation to workspace, purpose and evidence filters and orders by creation time and ID. A malformed or mismatched continuation returns bounded 400. Cross-workspace reads and foreign evidence references return 404. No historical migration changes.

Verification: services/api/test/export-snapshot-workflow.integration.test.ts and apps/web/__tests__/render/export-snapshots.render.test.tsx. Browser and final integrated verification remain pending until recorded in the remediation ledger.
