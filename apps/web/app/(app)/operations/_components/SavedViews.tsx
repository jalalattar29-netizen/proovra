"use client";

/**
 * Operations workbench — saved views.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * An operator who watches one slice of the queue — "unassigned CRITICALs",
 * "everything on evidence integrity" — otherwise rebuilds it from four
 * controls every morning. A saved view is the name for that slice.
 *
 * ---------------------------------------------------------------------------
 * A VIEW IS A QUESTION, NOT AN ANSWER
 * ---------------------------------------------------------------------------
 * Nothing here shows a count beside a view's name. A count would be true when
 * it was written and stale immediately afterwards, and a stale count on an
 * operations surface is exactly the false-clear the rest of this page is
 * built to avoid. Applying a view re-reads the queue.
 *
 * ---------------------------------------------------------------------------
 * SHARING SHOWS, IT DOES NOT GRANT
 * ---------------------------------------------------------------------------
 * A shared view is visible to the workspace and carries no authority: opening
 * one issues the ordinary queue read under the reader's own permissions, so a
 * view shared by an administrator shows a viewer exactly what that viewer
 * could have filtered to by hand. Only its author may delete it — sharing
 * results must not also hand over the ability to remove them.
 */

import * as React from "react";

import { AppRowMenu } from "../../../../components/app-primitives/AppRowMenu";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import type { OperationsSavedView } from "../_lib/types";
import { IconDots, IconSpinner } from "./icons";

export function SavedViews({
  views,
  loading,
  busy,
  canSave,
  onApply,
  onSave,
  onRename,
  onDelete,
}: {
  views: ReadonlyArray<OperationsSavedView>;
  loading: boolean;
  busy: boolean;
  /** False while the queue has no filters worth naming. */
  canSave: boolean;
  onApply: (view: OperationsSavedView) => void;
  onSave: (input: { name: string; visibility: "PRIVATE" | "TEAM" }) => void;
  onRename: (view: OperationsSavedView, name: string) => void;
  onDelete: (view: OperationsSavedView) => void;
}) {
  const { confirm: confirmAction } = useConfirmAction();
  const [naming, setNaming] = React.useState(false);
  /** The view being renamed, or null when the form is creating a new one. */
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [shared, setShared] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  const close = React.useCallback(() => {
    setNaming(false);
    setRenaming(null);
    setName("");
    setShared(false);
  }, []);

  // Nothing to show and nothing to save: the whole strip is omitted rather
  // than rendered as an empty shell that reads like a broken feature.
  if (!loading && views.length === 0 && !canSave && !naming) return null;

  return (
    <div className="opsw-views" data-ops-saved-views>
      <span className="opsw-views__label">Views</span>

      {loading ? (
        <span className="opsw-muted" role="status">
          <IconSpinner size={14} /> Loading…
        </span>
      ) : null}

      <ul className="opsw-views__list">
        {views.map((view) => (
          <li key={view.id} className="opsw-views__item">
            <button
              type="button"
              className="app-chip"
              onClick={() => onApply(view)}
              disabled={busy}
              data-ops-saved-view={view.id}
              data-ops-saved-view-visibility={view.visibility}
              title={view.description ?? undefined}
            >
              {view.name}
              {/* Said in a WORD, not only by an icon: whether a colleague can
                  see this is the one property worth being sure about before
                  naming a view after the person you are chasing. */}
              {view.visibility === "TEAM" ? (
                <span className="opsw-views__scope">Shared</span>
              ) : null}
            </button>
            {view.ownedByViewer ? (
              <AppRowMenu
                label={`Actions for the view ${view.name}`}
                dataPrefix="ops-view"
                testId={`ops-view-menu-${view.id}`}
                icon={<IconDots size={16} />}
                actions={[
                  {
                    key: "rename",
                    label: "Rename view",
                    onSelect: () => {
                      // `window.prompt` is not used here for the same reason
                      // `window.confirm` is banned: it is unstyled, not
                      // focus-managed and not announced. The name field the
                      // save flow already owns is reused instead.
                      setRenaming(view.id);
                      setName(view.name);
                      setNaming(true);
                    },
                  },
                  {
                    key: "delete",
                    label: "Delete view",
                    danger: true,
                    onSelect: () => {
                      void confirmAction({
                        title: `Delete “${view.name}”?`,
                        description:
                          view.visibility === "TEAM"
                            ? "This view is shared, so it will disappear for everyone in this workspace. The conditions themselves are not affected."
                            : "The conditions themselves are not affected.",
                        confirmLabel: "Delete view",
                        tone: "danger",
                        testId: "ops-view-delete-confirm",
                      }).then((ok) => {
                        if (ok) onDelete(view);
                      });
                    },
                  },
                ]}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {naming ? (
        <form
          className="opsw-views__save"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            const target = renaming
              ? views.find((v) => v.id === renaming)
              : null;
            if (target) onRename(target, trimmed);
            else onSave({ name: trimmed, visibility: shared ? "TEAM" : "PRIVATE" });
            close();
          }}
        >
          <input
            ref={inputRef}
            className="app-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder={renaming ? "Rename this view" : "Name this view"}
            aria-label={
              renaming ? "New name for the saved view" : "Name for the saved view"
            }
            data-ops-view-name
            onKeyDown={(e) => {
              // Escape abandons the naming without saving. Without it the
              // only way out of the form is to name something you did not
              // want to keep.
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          />
          {renaming ? null : (
          <label className="opsw-views__share">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              data-ops-view-share
            />
            <span>Share with this workspace</span>
          </label>
          )}
          <button
            type="submit"
            className="app-primary-action"
            disabled={busy || name.trim().length === 0}
            data-ops-view-save
          >
            {renaming ? "Rename" : "Save"}
          </button>
          <button type="button" className="app-ghost-action" onClick={close}>
            Cancel
          </button>
        </form>
      ) : canSave ? (
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => setNaming(true)}
          disabled={busy}
          data-ops-view-start-save
        >
          Save this view
        </button>
      ) : null}
    </div>
  );
}

export default SavedViews;
