"use client";

/**
 * DataTable — enterprise table primitive (Phase 7 foundation).
 *
 * A typed, token-driven table for internal list surfaces: clean sticky
 * header, compact rows, optional per-row actions, and built-in loading /
 * empty states — all inside a horizontal-scroll container so narrow
 * viewports never blow out the page width. Presentation only: no sorting
 * logic, no fetching, no selection state. Feed it `columns` + `rows`.
 *
 * COLUMNS
 *   Each column declares a `key`, a `header`, and a `render(row)` (or
 *   relies on `row[key]`). `align`, `width`, and `nowrap` are optional.
 *
 * STATES
 *   - loading   renders shimmer skeleton rows (keeps header).
 *   - empty     renders `emptyState` (pass an <EmptyState/>), spanning
 *               all columns, when `rows` is empty and not loading.
 *
 * ROW ACTIONS
 *   `rowActions(row)` renders a trailing actions cell (right-aligned).
 *   `onRowClick(row)` gives every row ONE primary "Open" button in that
 *   cell (the keyboard and screen-reader path) and keeps a click anywhere
 *   else on the row as a pointer shortcut to the same action.
 *
 * DENSITY: `density="compact"` (default) | "comfortable".
 *
 * A11Y: real <table> semantics, <th scope="col">, caption via
 * `aria-label`; the scroll container is a focusable named region so a
 * keyboard can scroll a table wider than the screen; rows are never
 * themselves interactive (see "ROWS ARE CONTAINERS" below) and honour
 * reduced-motion (see globals.css .ui-datatable__row).
 *
 * USAGE
 *   <DataTable
 *     columns={[
 *       { key: 'label', header: 'Evidence' },
 *       { key: 'status', header: 'Status', render: r => <Badge tone="verified">{r.status}</Badge> },
 *     ]}
 *     rows={items}
 *     getRowId={r => r.id}
 *     loading={loading}
 *     emptyState={<EmptyState title="No evidence" />}
 *     rowActions={r => <Button size="sm" variant="ghost">Open</Button>}
 *   />
 */

import React from "react";

import { scrollRegionProps } from "../../lib/ui/scrollRegion";
import { Button } from "./Button";

/**
 * Whether a row click started on a control of its own — a link to another
 * record, a button, a field. That control already did what was asked; the
 * row's pointer shortcut must not ALSO run (before, clicking the "Customer"
 * link in a workspace row navigated to the customer and then router.push()ed
 * to the workspace).
 */
function startedOnNestedControl(event: React.MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element | null;
  const control = target?.closest?.(
    'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"]',
  );
  return Boolean(
    control && control !== event.currentTarget && event.currentTarget.contains(control),
  );
}

export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  /** Custom cell renderer; defaults to `String((row as any)[key])`. */
  render?: (row: T, rowIndex: number) => React.ReactNode;
  align?: "left" | "center" | "right";
  /** Fixed / min width, e.g. 120 or "20%". */
  width?: number | string;
  /** Prevent wrapping in this column. */
  nowrap?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable row id for React keys. */
  getRowId: (row: T, index: number) => string;
  loading?: boolean;
  /** Rendered (spanning all columns) when there are no rows. */
  emptyState?: React.ReactNode;
  /** Trailing right-aligned per-row actions cell. */
  rowActions?: (row: T, index: number) => React.ReactNode;
  onRowClick?: (row: T, index: number) => void;
  /**
   * Accessible name of a row's primary "Open" button, e.g. `Open Acme Corp`.
   * Without it the button is named "Open" plus the text of the row's first
   * cell, which is unique but can be long.
   */
  rowActionLabel?: (row: T, index: number) => string;
  /**
   * PROGRESSIVE DISCLOSURE for a row.
   *
   * Return content to render a full-width detail row directly beneath the
   * row; return null/false/undefined to render nothing. The caller owns the
   * open/closed state (typically a `rowActions` toggle), so the table stays
   * presentation-only. This is how a list keeps one scannable line per
   * record and still makes the long tail — metadata JSON, identifiers —
   * reachable without a card per entry.
   */
  expandedContent?: (row: T, index: number) => React.ReactNode;
  density?: "compact" | "comfortable";
  /** Accessible name for the table. */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

const DENSITY_PAD: Record<"compact" | "comfortable", string> = {
  compact: "8px 12px",
  comfortable: "12px 16px",
};

const HEADER_TH: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-muted, #94a3b8)",
  background: "var(--surface-header, #f8fafc)",
  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  whiteSpace: "nowrap",
};

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  emptyState,
  rowActions,
  onRowClick,
  rowActionLabel,
  expandedContent,
  density = "compact",
  ariaLabel,
  className,
  style,
}: DataTableProps<T>) {
  const pad = DENSITY_PAD[density];
  const clickable = Boolean(onRowClick);
  const hasActionsCell = Boolean(rowActions) || clickable;
  const totalCols = columns.length + (hasActionsCell ? 1 : 0);
  const idBase = React.useId();

  return (
    <div
      data-ui-datatable-scroll
      /* AUD-0061 — a table wider than a phone scrolls inside this box, and
         only a focusable box can be scrolled from the keyboard. */
      {...scrollRegionProps(ariaLabel ?? "Table")}
      className={["ui-datatable", className].filter(Boolean).join(" ")}
      style={{
        width: "100%",
        overflowX: "auto",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        borderRadius: "var(--radius-card, 14px)",
        background: "var(--surface-card, #ffffff)",
        ...style,
      }}
    >
      <table
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        style={{
          width: "100%",
          /**
           * A NARROW TABLE MUST SCROLL, NOT SQUEEZE.
           *
           * The wrapper has said `overflow-x: auto` all along and it never
           * fired, because a `width: 100%` table with no floor simply shrinks
           * to the container and wraps every cell instead. At 390px the
           * security events table went from 42px per row to 139px — 100 rows,
           * 13,884px, on a page that was 20,067px tall in total.
           *
           * A floor scaled to the column count makes the overflow real, so the
           * table scrolls sideways and the rows stay one line. 116px per
           * column is about what a short cell plus padding needs; the 560px
           * base keeps two- and three-column tables from scrolling
           * unnecessarily.
           */
          minWidth: Math.max(560, totalCols * 116),
          borderCollapse: "collapse",
          fontSize: 13.5,
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={{
                  ...HEADER_TH,
                  padding: pad,
                  textAlign: col.align ?? "left",
                  width: col.width,
                }}
              >
                {col.header}
              </th>
            ))}
            {hasActionsCell ? (
              <th
                scope="col"
                aria-label="Actions"
                /* STICKY, so a row action survives a sideways scroll. See the
                   long comment on the matching <td>. */
                data-row-actions-head
                style={{
                  ...HEADER_TH,
                  padding: pad,
                  textAlign: "right",
                  width: 1,
                  background: "var(--surface-muted, #f8fafc)",
                  zIndex: 2,
                }}
              />
            ) : null}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 4 }).map((_, r) => (
              <tr key={`sk-${r}`} data-ui-datatable-skeleton-row>
                {Array.from({ length: totalCols }).map((__, c) => (
                  <td
                    key={c}
                    style={{
                      padding: pad,
                      borderBottom:
                        "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: "block",
                        height: 12,
                        width: `${60 + ((c * 13 + r * 7) % 35)}%`,
                        borderRadius: 6,
                        background:
                          "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%)",
                        backgroundSize: "400% 100%",
                        animation: "pf-indeterminate-shimmer 1.4s ease infinite",
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={totalCols} style={{ padding: 0 }}>
                {emptyState ?? (
                  <div
                    style={{
                      padding: "32px 16px",
                      textAlign: "center",
                      color: "var(--ink-secondary, #475569)",
                      fontSize: 13.5,
                    }}
                  >
                    No records to display.
                  </div>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const id = getRowId(row, index);
              const detail = expandedContent ? expandedContent(row, index) : null;
              const firstCellId = `${idBase}-r${index}-c0`;
              const openId = `${idBase}-r${index}-open`;
              const openLabel = rowActionLabel ? rowActionLabel(row, index) : null;
              return (
                <React.Fragment key={id}>
                {/*
                  ROWS ARE CONTAINERS, NOT CONTROLS (AUD-0061).

                  A clickable row used to be role="button" with tabIndex=0, and
                  its cells hold links (the customer, the owner): a button
                  containing links, which assistive technology cannot represent
                  (axe nested-interactive, 50 rows on /admin/workspaces). The
                  row is now a plain <tr>; its action is ONE real button in the
                  actions cell, reachable by Tab and announced with the row it
                  opens. A click elsewhere on the row stays as a pointer
                  shortcut to that same action.
                */}
                <tr
                  data-ui-datatable-row
                  data-clickable={clickable || undefined}
                  className="ui-datatable__row"
                  onClick={
                    clickable
                      ? (e) => {
                          if (startedOnNestedControl(e)) return;
                          onRowClick!(row, index);
                        }
                      : undefined
                  }
                  style={{
                    cursor: clickable ? "pointer" : undefined,
                    transition: "background-color 140ms ease",
                  }}
                >
                  {columns.map((col, colIndex) => {
                    const content = col.render
                      ? col.render(row, index)
                      : String(
                          (row as Record<string, unknown>)[col.key] ?? "",
                        );
                    return (
                      <td
                        key={col.key}
                        id={clickable && colIndex === 0 && !openLabel ? firstCellId : undefined}
                        style={{
                          padding: pad,
                          textAlign: col.align ?? "left",
                          whiteSpace: col.nowrap ? "nowrap" : undefined,
                          borderBottom:
                            "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                          verticalAlign: "middle",
                        }}
                      >
                        {content}
                      </td>
                    );
                  })}
                  {hasActionsCell ? (
                    <td
                      // The TABLE owns row height, not the caller.
                      //
                      // `whiteSpace: nowrap` here was already correct and
                      // already ignored: three pages wrapped their buttons in
                      // a div with `flexWrap: "wrap"`, which wraps regardless.
                      // Four buttons in a narrow actions column became four
                      // rows, and the row grew to match — 113px on
                      // /admin/operations, 109px on /admin/identity/runtime,
                      // 205px on /admin/identity/sessions. The CSS rule keyed
                      // on this attribute overrides that inline style, so a
                      // page cannot make a row four lines tall by accident.
                      data-row-actions
                      /**
                       * AND IT STAYS ON SCREEN WHEN THE DATA SCROLLS PAST IT.
                       *
                       * A wide table scrolling inside its own surface is this
                       * console's documented pattern, and off-screen COLUMNS
                       * are fine — they are still columns. An off-screen
                       * BUTTON is a capability the page appears not to have,
                       * with nothing on screen saying otherwise.
                       *
                       * Measured, before this: `/admin/evidence-ops/records`
                       * is eleven columns and 1661px wide in a 1206px
                       * container, so its "What to do" control rendered 348px
                       * past the right edge — invisible until an operator
                       * thought to scroll a table sideways to look for a row
                       * action. `/admin/contact-sales` put "Open →" 5px past
                       * its edge, and `/admin/identity/sessions` put "Revoke
                       * all" 41px past.
                       *
                       * Sticky rather than narrower: the columns those tables
                       * carry are the inventory they exist to show, and the
                       * fix for a wide inventory is not to stop showing it.
                       * The opaque background is required — without it the
                       * scrolling cells read straight through the buttons.
                       */
                      style={{
                        padding: pad,
                        textAlign: "right",
                        whiteSpace: "nowrap",
                        borderBottom:
                          "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                        verticalAlign: "middle",
                        background: "var(--surface-card, #ffffff)",
                        zIndex: 1,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {clickable ? (
                        <Button
                          id={openId}
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-row-primary-action
                          aria-label={openLabel ?? undefined}
                          aria-labelledby={openLabel ? undefined : `${openId} ${firstCellId}`}
                          onClick={() => onRowClick!(row, index)}
                        >
                          Open
                        </Button>
                      ) : null}
                      {rowActions ? rowActions(row, index) : null}
                    </td>
                  ) : null}
                </tr>
                {detail ? (
                  <tr data-ui-datatable-detail-row data-row-id={id}>
                    <td
                      colSpan={totalCols}
                      style={{
                        padding: pad,
                        background: "var(--surface-muted, #f8fafc)",
                        borderBottom:
                          "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                      }}
                    >
                      {detail}
                    </td>
                  </tr>
                ) : null}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
