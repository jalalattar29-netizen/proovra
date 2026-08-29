"use client";

/**
 * The Settings shell's own navigation.
 *
 * Separate from the global app sidebar and rendered inside the page, because
 * Settings is a destination with its own map. On desktop it is a sticky rail;
 * below the two-column breakpoint it becomes a native `<select>`, which is the
 * one control that is guaranteed usable on every mobile browser and needs no
 * focus trap, no portal and no scroll lock.
 *
 * The model is resolved once by `resolveSettingsNavigation` — this component
 * decides nothing about who may see what.
 */

import { HelpCircle, ExternalLink } from "lucide-react";

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
      {/* NARROW: one native control, labelled, keyboard-complete. */}
      <div className="set-nav__mobile">
        <label className="set-nav__mobile-label" htmlFor="settings-section-select">
          Settings section
        </label>
        <select
          id="settings-section-select"
          className="set-nav__select"
          value={active}
          onChange={(event) => onSelect(event.target.value as SettingsPaneId)}
          data-settings-nav-select
        >
          {flat.map((item) => (
            <option key={item.id} value={item.id}>
              {item.group ? `${item.group} — ${item.label}` : item.label}
            </option>
          ))}
        </select>
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

        {/* ONE support surface, at the foot of the map — §29. */}
        <aside className="set-nav__help" data-settings-help>
          <p className="set-nav__help-title">
            <HelpCircle size={14} strokeWidth={2.1} aria-hidden="true" />
            Need help?
          </p>
          <p className="set-nav__help-copy">
            Contact support if you are not sure what a setting does.
          </p>
          {/* The same destination and the same target Billing already uses.
              It opens in a new tab deliberately: /support is outside the
              authenticated route group, and the session token is held in
              memory only, so following it in this tab would destroy the only
              copy of it. */}
          <a
            className="set-action set-action--outline"
            href="/support"
            target="_blank"
            rel="noopener noreferrer"
            data-settings-support-action
          >
            Contact support
            <ExternalLink size={13} strokeWidth={2.1} aria-hidden="true" />
          </a>
        </aside>
      </div>
    </nav>
  );
}

export default SettingsNav;
