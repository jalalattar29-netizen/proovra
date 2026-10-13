/**
 * A group's heading in the reader's language.
 *
 * A registered group is titled by its source's declared label, which the
 * shared catalogue carries in every locale. An unregistered group's title is
 * its members' stored text and is shown as stored. Never a raw source id.
 */
import { conditionSourceLabel, localizeCondition } from "@proovra/shared/i18n";

import type { AffectedRecord, IncidentGroup } from "./types";

export function localizedGroupTitle(
  group: Pick<IncidentGroup, "title" | "sourceId" | "titleSource">,
  locale: string,
): string {
  if (group.titleSource !== "SOURCE_LABEL") return group.title;
  return conditionSourceLabel(locale, group.sourceId) ?? group.title;
}

/** One affected record's condition title in the reader's language. */
export function localizedRecordTitle(record: Pick<AffectedRecord, "title" | "message">, locale: string): string {
  return localizeCondition(locale, {
    title: record.title,
    safeSummary: "",
    message: record.message ?? null,
    titleSource: "CONDITION",
  }).title;
}
