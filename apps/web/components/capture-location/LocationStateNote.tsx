/**
 * LocationStateNote — the canonical location state on the signed-in Evidence
 * surfaces (Integrity tab, Technical Appendix).
 *
 * The state, label, tone and detail come from the ONE authority
 * (`resolveEvidenceLocation`, packages/shared capture-location.ts), served by
 * the review workspace as `locationState`. An older response without it is
 * read from the coordinates alone (recorded or not recorded) — never guessed
 * beyond that. "Location not recorded" is neutral: no warning icon, no danger,
 * no "blocked". Only invalid stored coordinates carry a caution tone. A plan
 * that required location is stated on its own line, apart from what was
 * recorded.
 */

import { localizeEvidenceLocation, resolveEvidenceLocation, type EvidenceLocationTone } from "@proovra/shared";
import { AppStatusBadge, type AppTone } from "../app-primitives/AppStatusBadge";

export type LocationStateView = {
  state: string;
  label: string;
  tone: EvidenceLocationTone;
  detail: string | null;
  requirement?: { level: string; label: string; unmet: boolean } | null;
};

const TONE: Record<EvidenceLocationTone, AppTone> = {
  info: "blue",
  neutral: "slate",
  warning: "amber",
};

export function locationStateBadgeTone(tone: EvidenceLocationTone): AppTone {
  return TONE[tone] ?? "slate";
}

/**
 * The served state, or the coordinates' own reading for an older response —
 * in the reader's words (en / de / ar), read from the STATE and requirement
 * LEVEL, never by translating the served English sentence.
 */
export function readLocationState(
  served: LocationStateView | null | undefined,
  coordinates: { lat: number | null; lng: number | null } | null | undefined,
  locale?: string | null,
): LocationStateView {
  if (served && typeof served.label === "string" && served.label) return localizeEvidenceLocation(served, locale);
  const r = resolveEvidenceLocation({ lat: coordinates?.lat ?? null, lng: coordinates?.lng ?? null });
  return localizeEvidenceLocation({ state: r.state, label: r.label, tone: r.tone, detail: r.detail, requirement: null }, locale);
}

export default function LocationStateNote({
  location,
  showDetail = true,
}: {
  location: LocationStateView;
  showDetail?: boolean;
}) {
  const unmet = location.requirement?.unmet === true;
  return (
    <div className="evidence-location-state" data-location-state={location.state}>
      <AppStatusBadge tone={locationStateBadgeTone(location.tone)} data-location-state-label>
        {location.label}
      </AppStatusBadge>
      {showDetail && location.detail ? (
        <p className="evidence-detail-muted" data-location-state-detail>
          {location.detail}
        </p>
      ) : null}
      {unmet ? (
        <p className="evidence-detail-muted" data-location-requirement="unmet">
          {location.requirement!.label}
        </p>
      ) : null}
    </div>
  );
}
