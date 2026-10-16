/**
 * Public Verify — the record's location when NO coordinates are shown.
 *
 * The state and label come from the one authority (packages/shared
 * resolveEvidenceLocation), served as `locationState`. A record with recorded
 * coordinates is stated by the Capture Context card (map + coordinates); this
 * section states every other case in one neutral line — "Location not
 * recorded" is never a warning, a failure or "blocked". Only invalid stored
 * coordinates carry the caution colour. No map, no empty map shell.
 */
import { evidenceLocationCopy, localizeEvidenceLocation } from "@proovra/shared";
import { useOptionalLocale } from "../../providers";
import { VERIFY_BRAND, VERIFY_TYPO } from "./_verify-theme";

export type VerifyLocationState = {
  state: string;
  label: string;
  tone: "info" | "neutral" | "warning";
  detail: string | null;
} | null;

export function readVerifyLocationState(data: unknown): VerifyLocationState {
  const v = (data as { locationState?: unknown } | null)?.locationState;
  if (!v || typeof v !== "object") return null;
  const s = v as NonNullable<VerifyLocationState>;
  return typeof s.state === "string" && typeof s.label === "string" ? s : null;
}

export function VerifyLocationStateSection({ location: served }: { location: VerifyLocationState }) {
  // The reader's words (en / de / ar), from the served STATE — never a
  // translation of the served English sentence.
  const locale = useOptionalLocale();
  if (!served || served.state === "RECORDED") return null;
  const location = localizeEvidenceLocation(served, locale);
  const caution = location.tone === "warning";
  return (
    <section
      data-verify-location-state={location.state}
      style={{
        border: `1px solid ${VERIFY_BRAND.softLine}`,
        borderLeft: `4px solid ${caution ? VERIFY_BRAND.warning : VERIFY_BRAND.line}`,
        borderRadius: 18,
        background: caution ? VERIFY_BRAND.warningSoft : VERIFY_BRAND.glassStrong,
        padding: 16,
        display: "grid",
        gap: 4,
      }}
    >
      <div style={VERIFY_TYPO.kicker}>{evidenceLocationCopy(locale).heading}</div>
      <div style={{ ...VERIFY_TYPO.value, fontSize: 14, color: VERIFY_BRAND.ink }} data-verify-location-label>
        {location.label}
      </div>
      {location.detail ? (
        <div style={{ ...VERIFY_TYPO.small, fontSize: 12.5 }}>{location.detail}</div>
      ) : null}
    </section>
  );
}
