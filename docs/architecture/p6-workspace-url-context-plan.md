# P6 — Workspace-Aware URL / Deep-Link Context (Staged Plan)

Status: **PLANNED** (deferred from the 2026-07-21 domain remediation; the
context-safety layer — server-authorized `contextOptions`, switch lifecycle
gates, record-route safe landing, dirty-work guard — shipped in P0–P4).

## Why
Active workspace context is currently server session state
(`users.current_workspace_id`) only. Sensitive operational URLs carry record
ids but no workspace identity, so a deep link cannot be validated against, or
safely switch to, its owning workspace, and the address bar never tells the
operator which tenant they are acting in.

## Target shape
```
/w/{workspaceId}/home
/w/{workspaceId}/capture
/w/{workspaceId}/cases/{caseId}
/w/{workspaceId}/evidence/{evidenceId}
/w/{workspaceId}/reports/{reportId}
```
Rules (unchanged from the remediation mandate):
- URL context is presentation/navigation only — NEVER authorization. The
  server keeps validating record ownership → ACTIVE membership.
- Resource ownership must match the URL workspace; mismatch → safe failure
  (no record-existence leak; offer an explicit authorized switch).
- Public verification links stay workspace-independent.

## Stages
1. **Middleware + route group**: add `app/(app)/w/[workspaceId]/…` as thin
   re-exports of the existing pages; a layout guard compares
   `params.workspaceId` to the envelope's active context and (a) offers an
   explicit switch when authorized, (b) renders the canonical denial state
   when not. Legacy paths keep working untouched.
2. **Link producers**: navigation registry, sidebar, command palette,
   breadcrumbs, and record lists emit `/w/{id}/…` links (feature-flagged).
3. **Notifications/emails**: OpsCenter items, invite/report emails, and
   share flows include the owning workspace id in links.
4. **Redirect compatibility**: legacy record URLs 302 → the `/w/` form by
   resolving the record's owning workspace server-side (authorized callers
   only; unauthorized → canonical denial, never a leak).
5. **Cutover + cleanup**: after producers/tests/docs migrate and telemetry
   shows no legacy-path traffic, retire the legacy record routes.

## Gates per stage
tsc + full web/API suites + build; new tests: URL/context mismatch (allow /
deny / no-leak), redirect correctness, notification link shape.
