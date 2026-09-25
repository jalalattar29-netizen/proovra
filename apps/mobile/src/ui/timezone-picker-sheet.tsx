/**
 * TIMEZONE PICKER — the web's IANA timezone selector (lib/timezones.ts
 * `timezoneOptions`), as a searchable sheet.
 *
 * A selector, not free text: "Syria" is a country and "Asia/Damascus" is a
 * timezone, and both the account timezone (PATCH /v1/users/me) and the
 * notification schedule (PUT /v1/me/notification-schedule) reject a non-IANA
 * name. Used by Settings › Preferences and Settings › Notifications.
 */
import { useMemo, useState } from "react";

import { theme } from "../theme/theme";
import { supportedTimezones, timezoneLabel } from "../product/settings-overview";
import { ProovraBadge, ProovraFormField, ProovraInput, ProovraListRow, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

export function TimezonePickerSheet({
  visible,
  title,
  current,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  current: string | null;
  onPick: (tz: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const zones = useMemo(() => (visible ? supportedTimezones() : []), [visible]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? zones.filter((z) => z.toLowerCase().includes(q)) : zones;
    // A held value the runtime does not list still appears, as on the web.
    const withHeld = current && !zones.includes(current) && (!q || current.toLowerCase().includes(q)) ? [current, ...list] : list;
    return withHeld.slice(0, 60);
  }, [zones, filter, current]);

  return (
    <ProovraSheet visible={visible} title={title} onClose={onClose}>
      <ProovraFormField label="Search timezones">
        <ProovraInput value={filter} onChangeText={setFilter} placeholder="e.g. Berlin" autoCapitalize="none" accessibilityLabel="Search timezones" />
      </ProovraFormField>
      {zones.length === 0 ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          This device cannot list timezones. Use your current timezone instead.
        </ProovraText>
      ) : (
        shown.map((tz) => (
          <ProovraListRow
            key={tz}
            title={timezoneLabel(tz)}
            trailing={tz === current ? <ProovraBadge label="Current" tone="verified" /> : undefined}
            onPress={() => onPick(tz)}
          />
        ))
      )}
    </ProovraSheet>
  );
}
