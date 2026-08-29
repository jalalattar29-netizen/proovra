"use client";

/**
 * Capture — session activity, collapsed.
 *
 * THE SOURCE IS CANONICAL AND ALREADY LOADED.
 * ---------------------------------------------------------------------------
 * `sessionTimeline` is `SessionTimelineEvent[]`, recorded by
 * `recordTimelineEvent` inside `useCaptureSessionOrchestration` as the session
 * actually progresses. It is component state that the page already holds, so
 * this disclosure fetches nothing: opening it costs a re-render and no
 * request, which is the whole reason it can be collapsed by default without
 * hiding anything expensive to get back.
 *
 * Nothing is synthesised. If the orchestration recorded no events, the row
 * says zero rather than inventing plausible ones.
 *
 * WHY COLLAPSED
 * ---------------------------------------------------------------------------
 * The log is genuinely useful and almost never the reason an operator opened
 * this page. Expanded by default it sat between the material list and the
 * finalize bar — between the work and the way out of it. Collapsed it is one
 * row, and the count still tells you whether there is anything to look at.
 */

import { useId, useState } from "react";
import { ChevronDown, History } from "lucide-react";

import { formatUserTime } from "../../../../lib/date";
import type { SessionTimelineEvent } from "./types";

export function CaptureActivityDisclosure({
  events,
}: {
  events: ReadonlyArray<SessionTimelineEvent>;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section
      className="capture-activity"
      data-capture-activity
      data-capture-activity-open={open ? "true" : "false"}
      data-capture-activity-count={events.length}
    >
      {/* A real <button> with the disclosure contract wired: `aria-expanded`
          for the state, `aria-controls` for the panel it owns. Keyboard
          activation is the element's own, not a keydown handler bolted onto a
          div. */}
      <button
        type="button"
        className="capture-activity__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        data-capture-activity-toggle
      >
        <History size={15} strokeWidth={2.1} aria-hidden="true" />
        <span className="capture-activity__label">
          Session activity
          <span className="capture-activity__count">
            {" · "}
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="capture-activity__action">
          {open ? "Hide activity" : "View activity"}
          <ChevronDown size={15} strokeWidth={2.2} aria-hidden="true" />
        </span>
      </button>

      {open ? (
        <div id={panelId} className="capture-activity__panel">
          {events.length === 0 ? (
            <p className="capture-activity__empty">
              No activity recorded in this session yet.
            </p>
          ) : (
            <ol className="capture-activity__list">
              {events.map((event) => (
                <li key={event.id} data-capture-activity-tone={event.tone}>
                  <time dateTime={event.atUtc}>
                    {formatUserTime(event.atUtc)}
                  </time>
                  <span>
                    <strong>{event.title}</strong>
                    {event.detail ? <small>{event.detail}</small> : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default CaptureActivityDisclosure;
