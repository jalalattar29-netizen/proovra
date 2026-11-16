/**
 * B4-F-207 — the Clear Session consequence states the reservation truthfully:
 * a failed Finish may already have reserved an (unfinished) evidence record,
 * which Clear releases. It used to say no record existed in every case.
 */
export function clearSessionConsequence(reservedEvidenceId: string | null): string {
  const base = "This will remove all staged materials, mapping, private notes, and local review progress.";
  return reservedEvidenceId
    ? `${base} An unfinished evidence record was already reserved for this session; clearing releases it, and nothing is sealed.`
    : `${base} No evidence record has been created yet.`;
}
