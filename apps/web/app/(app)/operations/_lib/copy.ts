"use client";

/**
 * OPS-020 — the Operations page's chrome in the reader's language, from the
 * ONE shared dictionary (`@proovra/shared/i18n`), which the native screen
 * reads too.
 *
 * D10 (2026-10-12) — the dictionary now carries the whole Operations
 * vocabulary (severity, status, source, SLA, KPI labels and notes, filters,
 * table headers, states, bulk toolbar, refusal copy, Workspace Health and the
 * Enterprise roll-up), and numbers are formatted for the ACTIVE locale rather
 * than a hard-coded "en-US".
 */
import * as React from "react";
import { fillOperationsCopy, operationsCopyFor, type OperationsCopy } from "@proovra/shared/i18n";

import { useOptionalLocale } from "../../../providers";
import { formatOpsNumber } from "./format";
import { opsDuration, opsRelativeTime } from "./time";

export { formatOpsNumber };

export type { OperationsCopy };
export { fillOperationsCopy };

export function useOpsCopy(): OperationsCopy {
  return operationsCopyFor(useOptionalLocale());
}

/** The active locale, normalised to a BCP-47 tag Intl accepts. */
export function useOpsLocale(): string {
  const locale = useOptionalLocale();
  return typeof locale === "string" && locale.trim() ? locale : "en";
}


/** A memoised number formatter bound to the active locale. */
export function useOpsNumber(): (value: number) => string {
  const locale = useOpsLocale();
  return React.useCallback((value: number) => formatOpsNumber(value, locale), [locale]);
}

/**
 * Relative time ("2h ago") and spans ("15h 2m") in the reader's language,
 * via Intl.RelativeTimeFormat / Intl.NumberFormat for the active locale.
 */
export function useOpsTime(): {
  ago: (iso: string | null | undefined) => string;
  span: (seconds: number | null | undefined) => string;
} {
  const locale = useOpsLocale();
  const copy = useOpsCopy();
  return React.useMemo(
    () => ({
      ago: (iso) => opsRelativeTime(iso, locale, copy),
      span: (seconds) => opsDuration(seconds, locale, copy),
    }),
    [locale, copy],
  );
}
