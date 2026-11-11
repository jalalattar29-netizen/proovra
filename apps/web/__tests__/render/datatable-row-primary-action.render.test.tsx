/**
 * AUD-0061 (3) and (4) — DataTable rows are containers, and its scroll box is
 * a keyboard-reachable region.
 *
 * axe reported `nested-interactive` on 50 rows of /admin/workspaces: a
 * clickable row was `role="button"` + `tabIndex=0` and its cells hold links (the
 * customer, the owner). It also reported `scrollable-region-focusable` on the
 * DataTable scroll box at phone width on a dozen admin routes. These tests pin
 * the replacement contract:
 *
 *   - no row carries a role or a tab stop; no `role=button`/`<button>` in the
 *     table contains another interactive element;
 *   - each clickable row has exactly one primary "Open" button, named after
 *     the row, that the keyboard reaches and that runs the row action;
 *   - a click on the row still runs it (pointer shortcut), but a click on a
 *     nested link does NOT also run it;
 *   - the scroll container is a named `region` with `tabIndex=0`.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable, type DataTableColumn } from "../../components/ui/DataTable";

type Row = { id: string; name: string; customer: string };

const ROWS: Row[] = [
  { id: "w1", name: "Northwind legal", customer: "Northwind" },
  { id: "w2", name: "Quiet Chambers", customer: "Quiet Chambers LLP" },
];

const COLUMNS: DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Workspace",
    render: (r) => (
      <div>
        <div>{r.name}</div>
        <div>Created 05 Sept 2026</div>
      </div>
    ),
  },
  {
    key: "customer",
    header: "Customer",
    render: (r) => (
      <a href={`/admin/customers/${r.id}`} onClick={(e) => e.preventDefault()}>
        {r.customer}
      </a>
    ),
  },
];

const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]';

function renderTable(extra: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  const onRowClick = vi.fn();
  render(
    <DataTable<Row>
      ariaLabel="Platform workspaces"
      columns={COLUMNS}
      rows={ROWS}
      getRowId={(r) => r.id}
      onRowClick={onRowClick}
      {...extra}
    />,
  );
  return { onRowClick };
}

describe("DataTable rows are containers with one primary action (nested-interactive)", () => {
  it("renders rows with no role and no tab stop", () => {
    renderTable();
    const rows = document.querySelectorAll("tr[data-ui-datatable-row]");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("role")).toBeNull();
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  it("never nests an interactive element inside another one", () => {
    renderTable();
    const table = screen.getByRole("table", { name: "Platform workspaces" });
    const controls = table.querySelectorAll('button, [role="button"], a[href], [role="link"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.querySelector(INTERACTIVE), control.outerHTML).toBeNull();
    }
  });

  it("gives every row exactly one Open button, named after the row", () => {
    renderTable();
    for (const [i, row] of ROWS.entries()) {
      const tr = document.querySelectorAll("tr[data-ui-datatable-row]")[i] as HTMLElement;
      const primary = within(tr).getAllByRole("button");
      expect(primary).toHaveLength(1);
      // Default name: "Open" + the first cell's text, so 50 rows never
      // produce 50 buttons all called just "Open".
      expect(primary[0].textContent).toBe("Open");
      expect(within(tr).getByRole("button", { name: new RegExp(`^Open ${row.name}`) })).toBe(
        primary[0],
      );
    }
  });

  it("uses rowActionLabel for the button's name when the page supplies one", () => {
    renderTable({ rowActionLabel: (r) => `Open workspace ${r.name}` });
    expect(screen.getByRole("button", { name: "Open workspace Northwind legal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open workspace Quiet Chambers" })).toBeTruthy();
  });

  it("reaches the row action from the keyboard", async () => {
    const user = userEvent.setup();
    const { onRowClick } = renderTable();
    const open = screen.getByRole("button", { name: /^Open Quiet Chambers/ });
    open.focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0][0]).toEqual(ROWS[1]);
    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("keeps a click on the row as a pointer shortcut, but not a click on a nested link", async () => {
    const user = userEvent.setup();
    const { onRowClick } = renderTable();
    await user.click(screen.getByText("Northwind legal"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0][0]).toEqual(ROWS[0]);

    await user.click(screen.getByRole("link", { name: "Northwind" }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("renders no Open button and no actions column for a read-only table", () => {
    render(
      <DataTable<Row> ariaLabel="Read only" columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("[data-row-actions-head]")).toBeNull();
  });

  it("puts the Open button beside the page's own row actions", () => {
    renderTable({ rowActions: () => <button type="button">Suspend</button> });
    const tr = document.querySelector("tr[data-ui-datatable-row]") as HTMLElement;
    const buttons = within(tr).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Open", "Suspend"]);
  });
});

describe("DataTable scroll container (scrollable-region-focusable)", () => {
  it("is a focusable region named after the table", () => {
    renderTable();
    const region = screen.getByRole("region", { name: "Platform workspaces" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.hasAttribute("data-ui-datatable-scroll")).toBe(true);
    expect(region.hasAttribute("data-scroll-region")).toBe(true);
    expect(within(region).getByRole("table", { name: "Platform workspaces" })).toBeTruthy();
  });

  it("is still named when the caller passes no aria-label", () => {
    render(<DataTable<Row> columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />);
    expect(screen.getByRole("region", { name: "Table" }).getAttribute("tabindex")).toBe("0");
  });
});
