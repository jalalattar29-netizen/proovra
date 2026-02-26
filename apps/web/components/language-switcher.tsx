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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        background: "rgba(11, 20, 32, 0.92)",
        border: "1px solid rgba(101, 235, 255, 0.18)",
        borderRadius: 12,
        boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
        zIndex: 999999,
        overflow: "hidden",
        backdropFilter: "blur(10px)"
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
              gap: 10,
              width: "100%",
              padding: "10px 12px",
              border: "none",
              background: active ? "rgba(101, 235, 255, 0.12)" : "transparent",
              cursor: "pointer",
              fontSize: 12,
              color: active ? "rgba(227, 251, 255, 1)" : "rgba(226, 232, 240, 0.92)",
              fontWeight: active ? 700 : 500,
              borderBottom: idx !== languages.length - 1 ? "1px solid rgba(101, 235, 255, 0.10)" : "none",
              justifyContent: "flex-start",
              textAlign: "left"
            }}
          >
            <span style={{ width: 44, opacity: active ? 1 : 0.9 }}>{lang.display}</span>
            <span style={{ fontSize: 13, opacity: active ? 1 : 0.9 }}>{lang.label}</span>
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
          gap: 8,
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.16)",
          background: "rgba(255,255,255,0.06)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          color: "rgba(226,232,240,0.95)",
          lineHeight: 1,
          userSelect: "none"
        }}
      >
        <span style={{ fontSize: 14, opacity: 0.95 }}>🌐</span>
        <span style={{ letterSpacing: 0.3 }}>{displayCode}</span>
      </button>

      {/* Portal to body so it never gets clipped */}
      {mounted && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </>
  );
}