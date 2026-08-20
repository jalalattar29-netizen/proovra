-- Search index reconciliation joins the existing reconciliation-run authority.
--
-- Deliberately NOT a new table. `governance_reconciliation_runs` already
-- provides per-(kind, lock_key) database exclusion via the partial unique
-- index `governance_reconciliation_runs_running_lock_uniq`, a lease, terminal
-- transitions and append-only history. A second run table would be a second
-- lock, and two locks over one workspace's index exclude nothing — which is
-- exactly how the worker scheduler and the API's reconcile endpoint could
-- otherwise start conflicting runs for the same workspace.
ALTER TYPE "GovernanceReconciliationKind" ADD VALUE IF NOT EXISTS 'SEARCH_INDEX';
