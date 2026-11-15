import type { CaptureDraftDetail } from "../_hooks/useCaptureDraftList";
import type { SessionItem } from "./types";

/**
 * C-05 (Free-user audit of 4d9b78963) — a resumed draft gives its per-file
 * metadata back when the file is re-attached.
 *
 * The draft keeps, per staged file, its name, size, type and the person's role,
 * private note, checklist step and source label (file contents are never
 * stored). Resume used to list them for reference only: a re-attached file
 * started blank, autosave then overwrote the saved details, and the next
 * Finish presigned the parts without the notes the person had written.
 *
 * A re-attached item takes the metadata of the first unclaimed draft entry with
 * the same file name, size and type; each entry is claimed once. Only values
 * the draft actually holds are applied. Items already looked at are never
 * looked at again (the person's later edits are theirs).
 */
export type DraftRestoreState = { checked: Set<string>; claimed: Set<number> };

export const newDraftRestoreState = (): DraftRestoreState => ({ checked: new Set(), claimed: new Set() });

type Patch = Partial<Pick<SessionItem, "role" | "privateNote" | "checklistStepId" | "sourceLabel">>;

export function restoreDraftItemMetadata(
  items: readonly SessionItem[],
  saved: CaptureDraftDetail["items"],
  state: DraftRestoreState,
): Map<string, Patch> {
  const patches = new Map<string, Patch>();
  for (const item of items) {
    if (state.checked.has(item.id)) continue;
    state.checked.add(item.id);
    const index = saved.findIndex(
      (entry, i) =>
        !state.claimed.has(i) &&
        entry.fileName === item.file.name &&
        entry.sizeBytes === item.file.size &&
        (entry.mimeType ?? item.mimeType) === item.mimeType,
    );
    if (index < 0) continue;
    state.claimed.add(index);
    const entry = saved[index]!;
    const patch: Patch = {};
    if (entry.role) patch.role = entry.role;
    if (entry.privateNote) patch.privateNote = entry.privateNote;
    if (entry.checklistStepId) patch.checklistStepId = entry.checklistStepId;
    if (entry.sourceLabel) patch.sourceLabel = entry.sourceLabel;
    if (Object.keys(patch).length > 0) patches.set(item.id, patch);
  }
  return patches;
}
