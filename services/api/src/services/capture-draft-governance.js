import { sanitizeDisplayFileName, stripRelativePath, } from "@proovra/shared-evidence-presentation";
export const CAPTURE_DRAFT_EXPIRY_DAYS = 7;
export const CAPTURE_DRAFT_EXPIRY_MS = CAPTURE_DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
/**
 * Drafts persist metadata only. This helper intentionally handles small
 * JSON/session fields only and never accepts or stores raw file bytes.
 */
export function buildDefaultCaptureDraftExpiry(now = Date.now()) {
    return new Date(now + CAPTURE_DRAFT_EXPIRY_MS);
}
/**
 * Strip path-bearing values before draft persistence so folder structure is
 * not retained in resumable metadata.
 */
export function sanitizeCaptureSessionItem(item, index) {
    return {
        ...item,
        fileName: sanitizeDisplayFileName(item.fileName, {
            fallbackIndex: index,
        }),
        relativePath: item.relativePath === undefined
            ? undefined
            : item.relativePath === null
                ? null
                : stripRelativePath(item.relativePath),
    };
}
