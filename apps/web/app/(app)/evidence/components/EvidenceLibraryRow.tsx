import type { EvidenceListItem } from "../lib/evidence-library-types";
import {
  getDisplayTitle,
  getRecordStatusLabel,
  getStatusBadgeTone,
} from "../lib/evidence-library-status";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";

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
        <label htmlFor={`evidence-select-${item.id}`} className="app-visually-hidden">
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
        {/* Record id and Case live TOGETHER in the identity zone. The Case is a
            labelled relationship ("Case: <name>"), as TEXT — a neutral "Case:"
            key and the name in the canonical blue. No capsule; a case is a fact
            the record carries, not a state to scan. Absent when unlinked — an
            unfiled record is a normal state, never a placeholder or warning. */}
        <span className="evidence-library-row__identity-meta">
          <span className="evidence-library-row__id" dir="ltr">
            {shortId(item.id)}
          </span>
          {caseName ? (
            <span
              className="evidence-library-row__case"
              title={`Case: ${caseName}`}
              data-evidence-row-case
            >
              <span className="evidence-library-row__case-label">Case:</span>{" "}
              <span className="evidence-library-row__case-name">{caseName}</span>
            </span>
          ) : null}
        </span>
      </span>

      <span className="evidence-library-row__activity">
        <span className="evidence-library-row__activity-line">
          {item.itemCount} item{item.itemCount === 1 ? "" : "s"}
          <span aria-hidden> • </span>
          {getRecordStatusLabel(item.status)}
        </span>
        <time
          className="evidence-library-row__timestamp"
          dateTime={item.createdAt}
          dir="ltr"
        >
          {formatUtcDateTime(item.createdAt)}
        </time>
      </span>

      {/* THE RECORD'S LIFECYCLE STATE, as text. The generic review-state bucket
          that used to sit beside it was a second, vague summary and has been
          removed — the canonical review-priority resolver it read is retained
          for the Priority sort (see page.tsx), just no longer surfaced here. */}
      <span className="evidence-library-row__badges">
        <span className="app-status-text" data-size="md" data-tone={getStatusBadgeTone(item)}>
          {getRecordStatusLabel(item.status)}
        </span>
      </span>

    </li>
  );
}
