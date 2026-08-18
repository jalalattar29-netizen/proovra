import type { EvidenceListItem } from "../lib/evidence-library-types";
import {
  getDisplayTitle,
  getRecordStatusLabel,
  getReviewPriorityTone,
  getStatusBadgeTone,
} from "../lib/evidence-library-status";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";
import { buildReviewPriority } from "../lib/evidence-library-alerts";

/**
 * Evidence queue row.
 *
 * FIGMA (decoded, "Row Item (Default)"): a card carrying the checkbox, the
 * filename as Heading 4, the truncated record id, the item count, the reported
 * status and UTC timestamp, then the status badge and the operational badge.
 *
 * Selected state = purple border + checked purple box on the SAME white card,
 * with no size change, so selecting a row causes no layout shift.
 *
 * ACCESSIBILITY: the row is NOT a button wrapping other buttons (the previous
 * build nested `<button>` inside `<button>` and `<button>` inside `<a>`). The
 * checkbox owns selection, the filename is the single control that opens the
 * record, and the trailing actions are ordinary buttons.
 */
export function EvidenceLibraryRow({
  item,
  caseName,
  selected,
  checked,
  onSelect,
  onToggleChecked,
}: {
  item: EvidenceListItem;
  caseName: string | null;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleChecked: (id: string, checked: boolean) => void;
}) {
  const priority = buildReviewPriority(item);
  const title = getDisplayTitle(item);

  return (
    <li
      className="app-panel evidence-library-row"
      data-selected={selected ? "true" : undefined}
      data-evidence-row={item.id}
    >
      <span className="evidence-library-row__check">
        <input
          id={`evidence-select-${item.id}`}
          className="app-checkbox"
          type="checkbox"
          checked={checked}
          onChange={(event) => onToggleChecked(item.id, event.target.checked)}
        />
        <label htmlFor={`evidence-select-${item.id}`} className="sr-only">
          Select evidence record {title}
        </label>
      </span>

      <span className="evidence-library-row__identity">
        <button
          type="button"
          className="evidence-library-row__title"
          onClick={() => onSelect(item.id)}
          aria-pressed={selected}
          title={title}
          data-evidence-row-title={item.id}
        >
          {title}
        </button>
        <span className="evidence-library-row__id">{shortId(item.id)}</span>
      </span>

      <span className="evidence-library-row__meta">
        <span>
          {item.itemCount} item{item.itemCount === 1 ? "" : "s"}
        </span>
        <span aria-hidden>•</span>
        <span>{getRecordStatusLabel(item.status)}</span>
        <time dateTime={item.createdAt}>{formatUtcDateTime(item.createdAt)}</time>
        {caseName ? <span className="app-chip">{caseName}</span> : null}
      </span>

      <span className="evidence-library-row__badges">
        <span className="app-status-badge" data-tone={getStatusBadgeTone(item)}>
          {getRecordStatusLabel(item.status)}
        </span>
        <span
          className="app-status-badge"
          data-tone={getReviewPriorityTone(priority.level)}
          data-evidence-row-priority={priority.level}
        >
          {priority.label}
        </span>
      </span>

    </li>
  );
}
