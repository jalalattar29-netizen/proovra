"use client";

import { useState, useRef, useEffect, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../app/providers";
import type { Locale } from "@proovra/shared";

type LangItem =
  | { code: "auto"; label: string; display: string }
  | { code: Locale; label: string; display: string };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function LanguageSwitcher() {
  const { locale, setLocale, mode, setLocaleMode } = useLocale();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const menuId = useId();

  useEffect(() => setMounted(true), []);

  const languages = useMemo<readonly LangItem[]>(
    () => [
      { code: "auto", label: "Auto", display: "AUTO" },
      { code: "en", label: "English", display: "EN" },
      { code: "ar", label: "العربية", display: "AR" },
      { code: "de", label: "Deutsch", display: "DE" },
      { code: "fr", label: "Français", display: "FR" },
      { code: "es", label: "Español", display: "ES" },
      { code: "tr", label: "Türkçe", display: "TR" },
      { code: "ru", label: "Русский", display: "RU" },
    ],
    []
  );

  const displayCode = mode === "auto" ? "AUTO" : locale.toUpperCase();

  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 184,
  });

  const close = () => setOpen(false);
  const toggle = () => setOpen((v) => !v);

  const measureAndSet = () => {
    const btn = buttonRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const sidePadding = 8;
    const desiredWidth = Math.min(184, viewportWidth - sidePadding * 2);
    const left = clamp(
      r.right - desiredWidth,
      sidePadding,
      viewportWidth - desiredWidth - sidePadding
    );
    const top = Math.min(r.bottom + 10, window.innerHeight - 12);

    setMenuPos({ top, left, width: desiredWidth });
  };

  useEffect(() => {
    if (!open) return;

    measureAndSet();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      const menuEl = document.getElementById(menuId);
      const btnEl = buttonRef.current;

      if (btnEl && target && btnEl.contains(target)) return;
      if (menuEl && target && menuEl.contains(target)) return;

      close();
    };

    const onScroll = () => measureAndSet();
    const onResize = () => measureAndSet();

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, menuId]);

  const menu = open ? (
    <div
      id={menuId}
      role="menu"
      aria-label="Language selector menu"
      className="proovra-language-menu"
      style={{
        position: "fixed",
        top: menuPos.top,
        left: menuPos.left,
        width: menuPos.width,
        maxWidth: "calc(100vw - 16px)",
      }}
    >
      {languages.map((lang) => {
        const active =
          lang.code === "auto"
            ? mode === "auto"
            : mode === "manual" && locale === lang.code;

        return (
          <button
            key={lang.code}
            role="menuitem"
            type="button"
            className={`proovra-language-menu-item ${active ? "is-active" : ""}`}
            onClick={() => {
              if (lang.code === "auto") {
                setLocaleMode("auto");
              } else {
                setLocaleMode("manual");
                setLocale(lang.code);
              }
              close();
            }}
          >
            <span className="proovra-language-menu-code">{lang.display}</span>
            <span className="proovra-language-menu-label">{lang.label}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Language selector"
        className={`proovra-language-trigger ${open ? "is-open" : ""}`}
      >
        <span>{displayCode}</span>
      </button>

      {mounted && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
    </>
  );
}