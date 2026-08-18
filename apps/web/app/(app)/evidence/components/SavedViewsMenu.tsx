import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import type { EvidenceSavedView } from "../lib/evidence-library-types";
import { useState } from "react";
import { Bookmark as BookmarkIcon, Plus } from "lucide-react";
import { AppListbox } from "../../../../components/app-primitives";

export function SavedViewsMenu({
  views,
  teamOptions,
  onApplyView,
  onCreateView,
  onUpdateView,
  onDeleteView,
  onSetDefault,
}: {
  views: EvidenceSavedView[];
  teamOptions: Array<{ id: string; name: string }>;
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
  const [isOpen, setIsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [editViewId, setEditViewId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [saving, setSaving] = useState(false);

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
    } finally {
      setSaving(false);
    }
  };

  const editView = views.find((view) => view.id === editViewId) ?? null;

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
                  Scope: {view.scope} • Sort: {view.filters.sort}
                  {view.teamId ? " • Team view" : " • Personal view"}
                  {view.isDefault ? " • Default" : ""}
                </p>
                <div className="evidence-library-panel__actions">
                  <button type="button" className="app-secondary-action" onClick={() => onApplyView(view)}>
                    Load View
                  </button>
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
                  <button type="button" className="app-secondary-action" onClick={() => void onSetDefault(view.id)} disabled={view.isDefault}>
                    {view.isDefault ? "Default View" : "Make Default"}
                  </button>
                  <button type="button" className="app-danger-action" onClick={() => void onDeleteView(view.id)}>Delete</button>
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
                      isDefault,
                    }).then(() => {
                      setSaveOpen(false);
                      setEditViewId(null);
                      setName("");
                      setDescription("");
                      setIsDefault(false);
                      setTeamId("");
                    })
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
        <label className="evidence-library-checkbox">
          <input className="app-checkbox" type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
          <span>Make this my default view</span>
        </label>
        <p className="evidence-library-muted">
          This view will restore search, scope, status, type, review, export, case, retention, and sort.
        </p>
      </Modal>
    </>
  );
}
