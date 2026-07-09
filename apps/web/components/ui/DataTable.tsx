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
 *   `onRowClick(row)` makes rows keyboard-focusable + clickable.
 *
 * DENSITY: `density="compact"` (default) | "comfortable".
 *
 * A11Y: real <table> semantics, <th scope="col">, caption via
 * `aria-label`; clickable rows expose role/button affordances and honour
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
  density = "compact",
  ariaLabel,
  className,
  style,
}: DataTableProps<T>) {
  const pad = DENSITY_PAD[density];
  const totalCols = columns.length + (rowActions ? 1 : 0);
  const clickable = Boolean(onRowClick);

  return (
    <div
      data-ui-datatable-scroll
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
            {rowActions ? (
              <th
                scope="col"
                aria-label="Actions"
                style={{ ...HEADER_TH, padding: pad, textAlign: "right", width: 1 }}
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
              return (
                <tr
                  key={id}
                  data-ui-datatable-row
                  data-clickable={clickable || undefined}
                  className="ui-datatable__row"
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? "button" : undefined}
                  onClick={clickable ? () => onRowClick!(row, index) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick!(row, index);
                          }
                        }
                      : undefined
                  }
                  style={{
                    cursor: clickable ? "pointer" : undefined,
                    transition: "background-color 140ms ease",
                  }}
                >
                  {columns.map((col) => {
                    const content = col.render
                      ? col.render(row, index)
                      : String(
                          (row as Record<string, unknown>)[col.key] ?? "",
                        );
                    return (
                      <td
                        key={col.key}
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
                  {rowActions ? (
                    <td
                      style={{
                        padding: pad,
                        textAlign: "right",
                        whiteSpace: "nowrap",
                        borderBottom:
                          "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                        verticalAlign: "middle",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rowActions(row, index)}
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
