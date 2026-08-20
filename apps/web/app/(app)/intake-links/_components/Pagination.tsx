"use client";

/**
 * Intake links — pagination footer.
 *
 * Rendered whenever more rows match than fit on one page. The page-size control
 * is an `AppListbox`, not a native `<select>`, and the pager arrows are mirrored
 * in RTL because they mean previous/next, not left/right.
 */

import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { PAGE_SIZES } from "../_lib/filters";
import { IconChevronNext, IconChevronPrev } from "./icons";

export function Pagination({
  page,
  pageCount,
  pageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const labelId = React.useId();
  return (
    <nav className="ilk-pagination" aria-label="Pagination" data-intake-links-pagination>
      <div className="ilk-pagination__group">
        <span className="ilk-pagination__status" id={labelId}>
          Rows per page
        </span>
        <div className="ilk-pagination__size">
          <AppListbox
            value={String(pageSize)}
            options={PAGE_SIZES.map((s) => ({
              value: String(s),
              label: String(s),
            }))}
            ariaLabelledby={labelId}
            onChange={(v) => onPageSize(Number(v))}
          />
        </div>
      </div>
      <div className="ilk-pagination__group">
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          data-intake-links-prev-page
        >
          <IconChevronPrev size={16} className="ilk-pager-icon" />
          <span>Previous</span>
        </button>
        <span className="ilk-pagination__status" aria-live="polite">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => onPage(Math.min(pageCount, page + 1))}
          disabled={page >= pageCount}
          data-intake-links-next-page
        >
          <span>Next</span>
          <IconChevronNext size={16} className="ilk-pager-icon" />
        </button>
      </div>
    </nav>
  );
}

export default Pagination;
