"use client";

import { useState, useRef, useEffect, useMemo } from "react";
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

  // زر اللغة (anchor)
  const buttonRef = useRef<HTMLButtonElement>(null);

  // portal container
  const [mounted, setMounted] = useState(false);
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
      { code: "ru", label: "Русский", display: "RU" }
    ],
    []
  );

  const displayCode = mode === "auto" ? "AUTO" : locale.toUpperCase();

  // موقع المنيو على الشاشة
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 160
  });

  const close = () => setOpen(false);
  const toggle = () => setOpen((v) => !v);

  const measureAndSet = () => {
    const btn = buttonRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();
    const desiredWidth = 180; // ثابت حلو للمنيو
    const left = clamp(r.right - desiredWidth, 8, window.innerWidth - desiredWidth - 8);
    const top = r.bottom + 10;

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
      const menuEl = document.getElementById("proovra-lang-menu");
      const btnEl = buttonRef.current;

      // إذا الكليك جوّا الزر أو جوّا المنيو → ما نسكر
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
  }, [open]);

  const menu = open ? (
    <div
      id="proovra-lang-menu"
      role="menu"
      aria-label="Language selector menu"
style={{
  position: "fixed",
  top: menuPos.top,
  left: menuPos.left,
  width: menuPos.width,
  background:
    "linear-gradient(180deg, rgba(10,22,27,0.96) 0%, rgba(7,16,20,0.98) 100%)",
  border: "1px solid rgba(183,157,132,0.22)",
  borderRadius: 18,
  boxShadow:
    "0 22px 44px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.05)",
  zIndex: 999999,
  overflow: "hidden",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)"
}}
    >
      {languages.map((lang, idx) => {
        const active =
          lang.code === "auto"
            ? mode === "auto"
            : mode === "manual" && locale === lang.code;

        return (
          <button
            key={lang.code}
            role="menuitem"
            type="button"
            onClick={() => {
              if (lang.code === "auto") {
                setLocaleMode("auto");
              } else {
                setLocaleMode("manual");
                setLocale(lang.code);
              }
              close();
            }}
style={{
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  minHeight: 48,
  padding: "0 14px",
  border: "none",
  background: active
    ? "linear-gradient(180deg, rgba(183,157,132,0.16) 0%, rgba(255,255,255,0.04) 100%)"
    : "transparent",
  cursor: "pointer",
  fontSize: 13,
  color: active ? "#f3e7d8" : "rgba(226,232,230,0.90)",
  fontWeight: active ? 700 : 500,
  borderBottom:
    idx !== languages.length - 1
      ? "1px solid rgba(183,157,132,0.10)"
      : "none",
  justifyContent: "flex-start",
  textAlign: "left",
  transition: "background 180ms ease, color 180ms ease"
}}
          >
<span
  style={{
    width: 42,
    color: active ? "#d6b89d" : "rgba(205,214,211,0.72)",
    fontWeight: 700,
    letterSpacing: "0.08em",
    fontSize: 12,
    flexShrink: 0
  }}
>
  {lang.display}
</span>
<span
  style={{
    fontSize: 14,
    color: active ? "#f3f5f2" : "rgba(226,232,230,0.90)"
  }}
>
  {lang.label}
</span>
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
      title="Language selector"
style={{
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 44,
  height: 40,
  padding: "0 14px",
  borderRadius: 14,
  border: open
    ? "1px solid rgba(183,157,132,0.34)"
    : "1px solid rgba(255,255,255,0.10)",
  background: open
    ? "linear-gradient(180deg, rgba(183,157,132,0.14) 0%, rgba(255,255,255,0.03) 100%)"
    : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 100%)",
  boxShadow: open
    ? "0 12px 28px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.06)"
    : "inset 0 1px 0 rgba(255,255,255,0.04)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  color: open ? "#f1decb" : "#e6ebea",
  lineHeight: 1,
  userSelect: "none",
  letterSpacing: "0.08em",
  transition:
    "border-color 180ms ease, background 180ms ease, box-shadow 180ms ease, color 180ms ease"
}}
    >
      {/* بدون أيقونة — بس كود اللغة */}
<span style={{ letterSpacing: "0.08em" }}>{displayCode}</span>
    </button>

    {mounted && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
  </>
);
}