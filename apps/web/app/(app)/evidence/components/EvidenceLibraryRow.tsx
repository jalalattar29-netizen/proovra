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
        {/* Record id and Case live TOGETHER in the identity zone. The Case chip
            used to sit inside the activity run, after the timestamp, so its
            width pushed the badges to a different x on every row. */}
        <span className="evidence-library-row__identity-meta">
          <span className="evidence-library-row__id" dir="ltr">
            {shortId(item.id)}
          </span>
          {caseName ? (
            <span className="app-chip evidence-library-row__case" title={caseName}>
              {caseName}
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

      {/* THE RECORD'S STATE AND ITS REVIEW SIGNAL, as text.
          Two tinted capsules per row, on every row, made this column the
          loudest thing in the library while it repeated the same handful of
          phrases down the whole page. The tones are unchanged — the same two
          mappers still own them; only the surfaces are gone. This container is
          already a wrapping flex row with its own gap — it does not also need
          `.app-status-text-row`, which exists for the surfaces that have no
          such container. */}
      <span className="evidence-library-row__badges">
        <span className="app-status-text" data-tone={getStatusBadgeTone(item)}>
          {getRecordStatusLabel(item.status)}
        </span>
        <span
          className="app-status-text"
          data-tone={getReviewPriorityTone(priority.level)}
          data-evidence-row-priority={priority.level}
        >
          {priority.label}
        </span>
      </span>

    </li>
  );
}
