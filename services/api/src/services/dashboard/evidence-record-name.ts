/**
 * The name a dashboard row shows for an evidence record.
 *
 * `Evidence.title` is optional and is often the generated "Digital Evidence
 * Record" placeholder, while the file the customer uploaded still has a name.
 * Reading only `title` printed "Untitled evidence" beside records that do have
 * one. Returns null when the record really has no name, so the caller decides
 * the fallback; nothing here invents a name.
 */
export type EvidenceNameFields = {
  title?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
};

const GENERATED_TITLE = /^digital evidence record$/i;

export function evidenceRecordName(record: EvidenceNameFields): string | null {
  const title = record.title?.trim();
  if (title && !GENERATED_TITLE.test(title)) return title;
  return record.displayFileName?.trim() || record.originalFileName?.trim() || null;
}
