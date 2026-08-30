"use client";

/**
 * The Settings shell's own navigation.
 *
 * Separate from the global app sidebar and rendered inside the page, because
 * Settings is a destination with its own map. On desktop it is a sticky rail;
 * below the two-column breakpoint it collapses to one labelled control.
 *
 * That control is `AppListbox`, the same canonical listbox every other
 * selector in the authenticated product uses. It was a native `<select>`,
 * chosen because it needs no portal or scroll lock — but the option list a
 * native select opens is drawn by the OS, so at 390 the ONE control on the
 * page was the one thing that could not look like the product. The canonical
 * listbox carries the full WAI-ARIA listbox contract (roving
 * `aria-activedescendant`, Escape-to-close with focus returned to the
 * trigger, Home/End, outside-click) and escapes clipping ancestors through
 * `AppAnchoredOverlay`, so nothing is given up by moving to it.
 *
 * The model is resolved once by `resolveSettingsNavigation` — this component
 * decides nothing about who may see what.
 */

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import type {
  SettingsNavModel,
  SettingsPaneId,
} from "../../../../lib/settings/settingsNavigation";

export function SettingsNav({
  model,
  active,
  onSelect,
}: {
  model: SettingsNavModel;
  active: SettingsPaneId;
  onSelect: (pane: SettingsPaneId) => void;
}) {
  const flat: Array<{ id: SettingsPaneId; label: string; group?: string }> = [
    { id: model.overview.id, label: model.overview.label },
    ...model.groups.flatMap((g) =>
      g.items.map((i) => ({ id: i.id, label: i.label, group: g.label })),
    ),
  ];

  return (
    <nav className="set-nav" aria-label="Settings sections" data-settings-nav>
      {/* NARROW: one labelled control, keyboard-complete. */}
      <div className="set-nav__mobile">
        <span
          className="set-nav__mobile-label"
          id="settings-section-select-label"
        >
          Settings section
        </span>
        <div className="set-nav__select" data-settings-nav-select>
          <AppListbox
            id="settings-section-select"
            value={active}
            options={flat.map((item) => ({
              value: item.id,
              label: item.group ? `${item.group} — ${item.label}` : item.label,
            }))}
            onChange={(next) => onSelect(next as SettingsPaneId)}
            ariaLabelledby="settings-section-select-label"
          />
        </div>
      </div>

      {/* WIDE: the rail. */}
      <div className="set-nav__rail">
        <p className="set-nav__title">Settings</p>

        <ul className="set-nav__list">
          <li>
            <button
              type="button"
              className="set-nav__item"
              aria-current={active === "overview" ? "page" : undefined}
              onClick={() => onSelect("overview")}
              data-settings-nav-item="overview"
            >
              {model.overview.label}
            </button>
          </li>
        </ul>

        {model.groups.map((group) => (
          <div key={group.id} className="set-nav__group">
            <p className="set-nav__group-label">{group.label}</p>
            <ul className="set-nav__list">
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="set-nav__item"
                    aria-current={active === item.id ? "page" : undefined}
                    onClick={() => onSelect(item.id)}
                    data-settings-nav-item={item.id}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

      </div>
    </nav>
  );
}

export default SettingsNav;
