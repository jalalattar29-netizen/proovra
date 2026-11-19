import { identifierLabel } from "@proovra/shared";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import type { EvidenceSavedView } from "../lib/evidence-library-types";
import { useState } from "react";
import { Bookmark as BookmarkIcon, Plus } from "lucide-react";
import { AppListbox } from "../../../../components/app-primitives";
import { mayEditSavedView, ownsSavedView } from "../../../../lib/evidence/saved-view-sharing";
import { useOptionalPlatformContext } from "../../../../lib/platform-context";

export function SavedViewsMenu({
  views,
  teamOptions,
  currentUserId = null,
  onApplyView,
  onCreateView,
  onUpdateView,
  onDeleteView,
  onSetDefault,
}: {
  views: EvidenceSavedView[];
  teamOptions: Array<{ id: string; name: string }>;
  /**
   * B5B-F-303 — the signed-in user. Making a view the default is owner-only on
   * the server (403 otherwise), so it is offered only on the caller's views.
   */
  currentUserId?: string | null;
  onApplyView: (view: EvidenceSavedView) => void;
  onCreateView: (input: {
    name: string;
    description: string;
    isDefault: boolean;
    teamId?: string | null;
  }) => Promise<void>;
  onUpdateView: (
    id: string,
    input: { name?: string; description?: string; isDefault?: boolean }
  ) => Promise<void>;
  onDeleteView: (id: string) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
}) {
  // PRO-E1-08 — the envelope states the caller's role in each view's workspace.
  const envelope = useOptionalPlatformContext()?.envelope ?? null;
  const [isOpen, setIsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [editViewId, setEditViewId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [saving, setSaving] = useState(false);
  /** B5A-F-07 — Delete asks first: the id awaiting confirmation. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const saveCurrentView = async () => {
    setSaving(true);
    try {
      await onCreateView({
        name,
        description,
        isDefault,
        teamId: teamId || null,
      });
      setSaveOpen(false);
      setName("");
      setDescription("");
      setIsDefault(false);
      setTeamId("");
    } catch {
      // The page has stated the refusal; the dialog stays open with the input.
    } finally {
      setSaving(false);
    }
  };

  const editView = views.find((view) => view.id === editViewId) ?? null;
  const editViewOwned = editView ? ownsSavedView(editView, currentUserId) : true;

  return (
    <>
      {/* Triggers are canonical secondary actions. PART 3 — both dialogs
          below now use the canonical app dialog (focus trap, focus
          restoration, Escape and backdrop dismissal). Every callback,
          validation rule and destructive semantic is unchanged. */}
      <>
        <button
          type="button"
          className="app-secondary-action app-secondary-action--filled"
          onClick={() => setIsOpen(true)}
          data-evidence-saved-views-trigger
        >
          <BookmarkIcon size={16} strokeWidth={1.9} aria-hidden="true" />
          Saved Views
        </button>
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => setSaveOpen(true)}
          data-evidence-save-view-trigger
        >
          <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
          Save Current View
        </button>
      </>

      <Modal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title="Saved Views"
        testid="evidence-saved-views"
        footer={
          <button type="button" className="app-secondary-action" onClick={() => setIsOpen(false)}>
            Close
          </button>
        }
      >
        {views.length === 0 ? (
          <p className="evidence-library-muted">No saved views yet.</p>
        ) : (
          <div className="evidence-library-note-grid">
            {views.map((view) => (
              <div key={view.id} className="evidence-library-note-card">
                <strong>{view.name}</strong>
                <p>{view.description || "Saved evidence library filter set."}</p>
                <p className="evidence-library-muted">
                  Scope: {identifierLabel(view.scope)} • Sort: {view.filters.sort}
                  {view.teamId ? " • Team view" : " • Personal view"}
                  {view.isDefault ? " • Default" : ""}
                </p>
                <div className="evidence-library-panel__actions">
                  <button type="button" className="app-secondary-action" onClick={() => onApplyView(view)}>
                    Load View
                  </button>
                  {mayEditSavedView(view, currentUserId, envelope) ? (
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() => {
                      setEditViewId(view.id);
                      setName(view.name);
                      setDescription(view.description ?? "");
                      setIsDefault(view.isDefault);
                      setSaveOpen(true);
                    }}
                  >
                    Rename
                  </button>
                  ) : null}
                  {ownsSavedView(view, currentUserId) ? (
                    <button
                      type="button"
                      className="app-secondary-action"
                      onClick={() => void onSetDefault(view.id).catch(() => undefined)}
                      disabled={view.isDefault}
                      data-evidence-saved-view-make-default
                    >
                      {view.isDefault ? "Default View" : "Make Default"}
                    </button>
                  ) : null}
                  {confirmDeleteId === view.id ? (
                    <>
                      <span className="evidence-library-muted" role="status">
                        Delete this saved view? This cannot be undone.
                      </span>
                      <button
                        type="button"
                        className="app-danger-action"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          void onDeleteView(view.id).catch(() => undefined);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="app-secondary-action"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Keep view
                      </button>
                    </>
                  ) : mayEditSavedView(view, currentUserId, envelope) ? (
                    <button
                      type="button"
                      className="app-danger-action"
                      onClick={() => setConfirmDeleteId(view.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={saveOpen}
        testid="evidence-save-view"
        onClose={() => {
          setSaveOpen(false);
          setEditViewId(null);
          setName("");
          setDescription("");
          setIsDefault(false);
          setTeamId("");
        }}
        title={editView ? "Update Saved View" : "Save Current View"}
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => {
                setSaveOpen(false);
                setEditViewId(null);
                setName("");
                setDescription("");
                setIsDefault(false);
                setTeamId("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-primary-action"
              onClick={() =>
                void (editViewId
                  ? onUpdateView(editViewId, {
                      name,
                      description,
                      // A colleague's view: never send isDefault (owner-only, 403).
                      ...(editViewOwned ? { isDefault } : {}),
                    }).then(() => {
                      setSaveOpen(false);
                      setEditViewId(null);
                      setName("");
                      setDescription("");
                      setIsDefault(false);
                      setTeamId("");
                    }, () => undefined)
                  : saveCurrentView())
              }
              disabled={!name.trim() || saving}
            >
              {saving ? "Saving..." : editView ? "Update View" : "Save View"}
            </button>
          </>
        }
      >
        <div className="evidence-library-filter-group">
          <label htmlFor="saved-view-name">View name</label>
          <input
            id="saved-view-name"
            className="app-form-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="evidence-library-filter-group">
          <label htmlFor="saved-view-description">Description</label>
          <input
            id="saved-view-description"
            className="app-form-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {!editView ? (
          <div className="evidence-library-filter-group">
            <label id="saved-view-team-label" htmlFor="saved-view-team">View scope</label>
            <AppListbox
              id="saved-view-team"
              ariaLabelledby="saved-view-team-label"
              value={teamId}
              options={[
                { value: "", label: "Personal view" },
                ...teamOptions.map((team) => ({ value: team.id, label: `Team view: ${team.name}` })),
              ]}
              onChange={setTeamId}
            />
          </div>
        ) : null}
        {editViewOwned ? (
          <label className="evidence-library-checkbox">
            <input className="app-checkbox" type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
            <span>Make this my default view</span>
          </label>
        ) : null}
        <p className="evidence-library-muted">
          This view will restore search, scope, status, type, review, export, case, retention, and sort.
        </p>
      </Modal>
    </>
  );
}
