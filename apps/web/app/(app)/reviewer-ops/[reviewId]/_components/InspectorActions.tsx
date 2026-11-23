"use client";

/**
 * "What you can do now" + the reviewer action controls.
 *
 * Driven by the action map (`deriveActions`): every control is enabled or
 * disabled exactly as the server said, and a disabled control carries its
 * reason as visible text linked by `aria-describedby` — never a silent grey
 * button. One primary control: the next step forward.
 */

import { useId } from "react";
import {
  ACTION_LABELS,
  INLINE_ACTIONS,
  mainBlockedReason,
  primaryAction,
  type ActionMap,
  type ViewerActionName,
} from "./inspector-model";

export type InspectorActionHandlers = Partial<Record<ViewerActionName, () => void>>;

export function InspectorActions({
  actions,
  handlers,
  busy,
  paused,
  fromViewer,
}: {
  actions: ActionMap;
  handlers: InspectorActionHandlers;
  /** The action in flight, if any. */
  busy: ViewerActionName | null;
  paused: boolean;
  /** Whether the map came from the server's `viewer` block. */
  fromViewer: boolean;
}) {
  const baseId = useId();
  const allowed = (Object.keys(ACTION_LABELS) as ViewerActionName[]).filter(
    (name) => actions[name].allowed,
  );
  const blocked = mainBlockedReason(actions);
  const primary = primaryAction(actions);
  // Pause and Resume are one slot: show the one that applies.
  const showResume = actions.resume.allowed || (paused && !actions.pause.allowed);
  const inline = INLINE_ACTIONS.filter((name) =>
    name === "pause" ? !showResume : name === "resume" ? showResume : true,
  );

  return (
    <div data-reviewer-actions data-reviewer-actions-source={fromViewer ? "viewer" : "lifecycle"}>
      <h3 className="app-panel__title">What you can do now</h3>
      {allowed.length > 0 ? (
        <ul data-reviewer-allowed-actions style={{ margin: "0 0 8px", paddingLeft: "1.1rem", fontSize: 13 }}>
          {allowed.map((name) => (
            <li key={name} data-reviewer-allowed-action={name}>
              {ACTION_LABELS[name]}
              {name === "reassign" ? " — from the review queue" : ""}
              {name === "adjudicate" ? " — in the adjudication panel" : ""}
              {name === "archive" ? " — from the review queue" : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p data-reviewer-allowed-actions-empty className="app-field-help" style={{ marginTop: 0 }}>
          There is nothing for you to do on this review right now.
        </p>
      )}
      {/* The main blocked reason only when nothing can be done: otherwise it
          repeats the reason already shown under the disabled button. */}
      {blocked && allowed.length === 0 ? (
        <p data-reviewer-main-blocked-reason className="app-alert app-alert--warn" style={{ margin: "0 0 12px" }}>
          {blocked}
        </p>
      ) : null}

      <h3 className="app-panel__title">Reviewer actions</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
          gap: 10,
          marginTop: 8,
        }}
      >
        {inline.map((name) => {
          const state = actions[name];
          const reasonId = `${baseId}-${name}-reason`;
          const isBusy = busy === name;
          const className =
            name === primary
              ? "app-primary-action"
              : name === "reject"
                ? "app-secondary-action app-secondary-action--danger"
                : "app-secondary-action";
          return (
            <div key={name} style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <button
                type="button"
                className={className}
                disabled={!state.allowed || busy !== null || !handlers[name]}
                aria-describedby={!state.allowed && state.reason ? reasonId : undefined}
                aria-busy={isBusy || undefined}
                onClick={() => handlers[name]?.()}
                data-reviewer-action={name}
                data-reviewer-action-allowed={state.allowed ? "true" : "false"}
                {...(name === "request_info" ? { "data-reviewer-action-request-info": "" } : {})}
                {...(name === "reject" ? { "data-reviewer-action-reject": "" } : {})}
                {...(name === "pause" ? { "data-reviewer-action-pause": "" } : {})}
                {...(name === "resume" ? { "data-reviewer-action-resume": "" } : {})}
                style={{ width: "100%", whiteSpace: "normal", minHeight: 36, height: "auto" }}
              >
                {isBusy ? "Working…" : ACTION_LABELS[name]}
              </button>
              {!state.allowed && state.reason ? (
                <span
                  id={reasonId}
                  className="app-field-help"
                  data-reviewer-action-reason={name}
                  style={{ margin: 0, overflowWrap: "anywhere" }}
                >
                  {state.reason}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
