/**
 * Neutral internal-product design primitives (`app-*`).
 *
 * CSS classes (`.app-page-header`, `.app-panel`, `.app-inner-surface`,
 * `.app-primary-action`, `.app-secondary-action`, `.app-danger-action`,
 * `.app-form-input`, `.app-search-field`, `.app-tabs`, `.app-tab`,
 * `.app-table`, `.app-status-badge`, `.app-listbox`, `.app-dialog`, …) live
 * in `app-primitives.css`, imported globally from `app/globals.css`.
 *
 * React components:
 */
export { AppListbox, type AppListboxOption, type AppListboxProps } from "./AppListbox";
export { AppStatusBadge, type AppTone, type AppStatusBadgeProps } from "./AppStatusBadge";
