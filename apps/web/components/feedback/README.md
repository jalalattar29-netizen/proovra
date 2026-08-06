# PROOVRA Feedback System

One design language for every user-facing feedback surface — public site and
authenticated app. Light pearl/white surfaces, deep-navy ink, restrained
severity accents (green / amber / red / slate-blue), subtle borders, soft
shadows. No dark-navy toast blocks, no loud colours, no raw developer text.

Shared severity model + icons: `severity.tsx`.

## Primitives

| Component | Use for |
| --- | --- |
| `ProovraToast` (via `useToast().addToast`) | short confirmation · non-blocking error · background action done · lightweight status |
| `ProovraInlineError` | form field problems (missing/invalid input) |
| `ProovraAlert` / `ProovraBanner` | page-level state — degraded service, plan/quota, trust/security, report issue |
| `ProovraModalFeedback` | user must decide — destructive failure, payment confirm/fail, irreversible workflow |
| `ProovraSystemState` | full-surface system state — 404, 403, 410, 500, workspace/organization unavailable, capability degraded, invitation/token failure. Public + authenticated share the design; only actions differ. `ProovraDenialState` is the contained authenticated preset used by the gates. |
| `components/ui/EmptyState` | generic product empty state — "no records / nothing selected yet". Dense/table lists use `components/operational/OperationalEmptyState`. |
| `ProovraLoadingState` | short indeterminate waits ("Preparing evidence record") |
| `ProovraProgressState` | long real workflows — upload, signing, timestamping, OTS, report/package generation |
| `ProovraSupportReference` | the ONLY way to show a request/trace id (labelled + Copy) |
| `toSafeUserError` / `notifyApiError` | turn any thrown error into safe feedback |

## Notification hierarchy (prevents "everything is a toast")

- **Toast** — transient, non-blocking, self-dismissing.
- **Inline validation** — field-level; NEVER toast a form validation error.
- **Banner/Alert** — persistent page state.
- **Modal** — a decision is required before continuing.
- **Error page** — the route/page itself failed (404/500/global).
- **Loading/Progress** — long-running work; use real progress when known, honest indeterminate otherwise.

Do not over-toast: if a success is already visible on screen (row appears,
panel updates), skip the toast.

## Copy guidelines

Every user-facing error answers three questions:
1. **What happened?** 2. **Is the user's data safe?** 3. **What can they do next?**

Rules: sentence case · no developer jargon / API / backend wording · no raw
enums · no `requestId` inline · no bare "Something went wrong" / "Forbidden" /
"Permission denied" · no blame · no scary language unless security-critical.
Short title + useful body + a next action.

| Don't | Do |
| --- | --- |
| "Something went wrong" | "We couldn't complete that action. Please try again — your evidence data has not been changed." |
| "Forbidden" | "You don't have access to this area. Ask a workspace admin for access, or return to the dashboard." |
| "requestId: abc123" | Support reference · `ABC123` · [Copy] |
| "API error" / "Unauthorized" | "The service is temporarily unavailable. Please try again in a moment." / "Your session may have expired. Please sign in again." |

## Success copy

Short, specific, calm — and visually distinct from errors (green accent):
"Evidence preserved" · "Report is ready" · "Case created" · "Settings saved" ·
"Intake link copied". Not "Done".

## Loading/progress copy

"Preparing evidence record" · "Generating verification report" · "Signing
preserved package" · "Saving settings" — never bare "Loading…"/"Processing…".
Never invent fake progress.

## Do not break existing enterprise systems

`AccessGate`, `PageRouteGate`, `OperationalEmptyState`, `RuntimeStatusBanner`,
`EvidenceLifecycleError`, `InvestigationError` are already strong. Reuse their
tokens; do not replace them with weaker primitives.
