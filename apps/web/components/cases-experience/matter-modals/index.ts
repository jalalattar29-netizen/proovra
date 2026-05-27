/**
 * Phase 32.8D-frontend-closure — Matter Workspace action modal barrel.
 *
 * Centralizes the bounded set of action modals used by the matter
 * workspace. Adding a new action modal requires registering it here.
 */

export { Modal } from "./Modal";
export {
  AssignmentPickerModal,
  type AssignmentRole,
} from "./AssignmentPickerModal";
export {
  EvidenceLinkModal,
  type EvidenceLinkRole,
} from "./EvidenceLinkModal";
export { StatusChangeModal, type AllowedStatus } from "./StatusChangeModal";
export { ConfirmModal } from "./ConfirmModal";
// Phase 2.1 — surfaces `POST /v1/cases` (which already existed but was
// not reachable from the canonical Cases page).
export { CreateCaseModal } from "./CreateCaseModal";
