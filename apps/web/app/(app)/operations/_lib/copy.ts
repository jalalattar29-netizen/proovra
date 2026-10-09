"use client";

/**
 * OPS-020 — the Operations page's chrome in the reader's language, from the
 * ONE shared dictionary (`@proovra/shared/i18n`), which the native screen
 * reads too.
 */
import { fillOperationsCopy, operationsCopyFor, type OperationsCopy } from "@proovra/shared/i18n";

import { useOptionalLocale } from "../../../providers";

export type { OperationsCopy };
export { fillOperationsCopy };

export function useOpsCopy(): OperationsCopy {
  return operationsCopyFor(useOptionalLocale());
}
