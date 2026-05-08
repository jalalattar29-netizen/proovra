import { Button, Modal } from "../../../../components/ui";
import type { EvidenceSavedView } from "../lib/evidence-library-types";
import { useState } from "react";

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
      <div className="evidence-library-toolbar">
        <Button variant="secondary" onClick={() => setIsOpen(true)}>
          Saved Views
        </Button>
        <Button variant="secondary" onClick={() => setSaveOpen(true)}>
          Save Current View
        </Button>
      </div>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Saved Views"
        actions={<Button variant="secondary" onClick={() => setIsOpen(false)}>Close</Button>}
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
                  <Button variant="secondary" onClick={() => onApplyView(view)}>
                    Load View
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditViewId(view.id);
                      setName(view.name);
                      setDescription(view.description ?? "");
                      setIsDefault(view.isDefault);
                      setSaveOpen(true);
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="secondary" onClick={() => void onSetDefault(view.id)} disabled={view.isDefault}>
                    {view.isDefault ? "Default View" : "Make Default"}
                  </Button>
                  <Button onClick={() => void onDeleteView(view.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={saveOpen}
        onClose={() => {
          setSaveOpen(false);
          setEditViewId(null);
          setName("");
          setDescription("");
          setIsDefault(false);
          setTeamId("");
        }}
        title={editView ? "Update Saved View" : "Save Current View"}
        actions={
          <>
            <Button
              variant="secondary"
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
            </Button>
            <Button
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
            </Button>
          </>
        }
      >
        <div className="evidence-library-filter-group">
          <label htmlFor="saved-view-name">View name</label>
          <input id="saved-view-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="evidence-library-filter-group" style={{ marginTop: 12 }}>
          <label htmlFor="saved-view-description">Description</label>
          <input
            id="saved-view-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {!editView ? (
          <div className="evidence-library-filter-group" style={{ marginTop: 12 }}>
            <label htmlFor="saved-view-team">View scope</label>
            <select
              id="saved-view-team"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">Personal view</option>
              {teamOptions.map((team) => (
                <option key={team.id} value={team.id}>
                  Team view: {team.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <label className="evidence-library-checkbox" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
          <span>Make this my default view</span>
        </label>
        <p className="evidence-library-muted" style={{ marginTop: 12 }}>
          This view will restore search, scope, status, type, review, export, case, retention, and sort.
        </p>
      </Modal>
    </>
  );
}
