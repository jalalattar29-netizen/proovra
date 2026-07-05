"use client";

/**
 * Minimal public-site language switcher.
 *
 * Enterprise-clean and intentionally quiet: a plain text 2-letter code
 * (EN / DE / AR / ES / FR / TR / RU) with a small chevron — NO globe,
 * NO flag, NO colored pill, NO "Auto" entry, NO browser-language
 * detection. English is the universal default (enforced in
 * `lib/i18n.ts::resolveInitialLocale`); any other language is an
 * explicit, persisted user choice.
 *
 * It reuses the shared i18n provider (`useLocale`) — selecting a locale
 * calls `setLocaleMode("manual") + setLocale(code)`, which the
 * `LocaleProvider` persists to localStorage (gated on preferences
 * consent) and, for `ar`, flips `document.documentElement.dir` to RTL.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { useLocale } from "../../app/providers";
import type { Locale } from "@proovra/shared";

const LANGUAGES: ReadonlyArray<{ code: Locale; name: string; display: string }> = [
  { code: "en", name: "English", display: "EN" },
  { code: "de", name: "Deutsch", display: "DE" },
  { code: "ar", name: "العربية", display: "AR" },
  { code: "es", name: "Español", display: "ES" },
  { code: "fr", name: "Français", display: "FR" },
  { code: "tr", name: "Türkçe", display: "TR" },
  { code: "ru", name: "Русский", display: "RU" },
];

export function MarketingLanguageSwitcher({
  variant = "desktop",
}: {
  variant?: "desktop" | "mobile";
}) {
  const { locale, setLocale, setLocaleMode } = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // `locale` always resolves to a concrete supported code (never "auto"),
  // so the header shows a clean 2-letter code — EN by default.
  const current = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[0];

  const select = (code: Locale) => {
    setLocaleMode("manual");
    setLocale(code);
    setOpen(false);
  };

  // Desktop opens downward, right-anchored under the code; mobile opens
  // upward (it sits near the bottom action block) so it never clips.
  const menuPositionClass =
    variant === "mobile" ? "bottom-full mb-2 right-0" : "top-full mt-2 right-0";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Language — ${current.name}`}
        title="Language"
        className="flex items-center gap-1 rounded-full px-2.5 py-2 text-[14px] font-medium text-[#0F172A] transition-colors hover:bg-[#F1F5F9]"
      >
        <span>{current.display}</span>
        <ChevronDown
          size={13}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Select language"
          className={`absolute ${menuPositionClass} z-[120] w-[200px] rounded-[16px] border border-[#E5E7EB] bg-white p-1.5 shadow-[0_24px_60px_rgba(15,23,42,0.12)]`}
        >
          {LANGUAGES.map((l) => {
            const active = l.code === locale;
            return (
              <button
                key={l.code}
                type="button"
                role="menuitem"
                onClick={() => select(l.code)}
                className={`flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-[14px] transition-colors hover:bg-[#F8FAFC] ${
                  active ? "font-semibold text-[#0B1F5E]" : "font-medium text-[#334155]"
                }`}
              >
                <span>{l.name}</span>
                <span
                  className={`text-[12px] font-semibold ${
                    active ? "text-[#0B1F5E]" : "text-[#94A3B8]"
                  }`}
                >
                  {l.display}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
