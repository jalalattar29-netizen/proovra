"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale } from "../app/providers";
import type { Locale } from "@proovra/shared";

export function LanguageSwitcher() {
  const { locale, setLocale, mode, setLocaleMode } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const languages = [
    { code: "auto" as const, label: "Auto", display: "AUTO" },
    { code: "en", label: "English", display: "EN" },
    { code: "ar", label: "العربية", display: "AR" },
    { code: "de", label: "Deutsch", display: "DE" },
    { code: "fr", label: "Français", display: "FR" },
    { code: "es", label: "Español", display: "ES" },
    { code: "tr", label: "Türkçe", display: "TR" },
    { code: "ru", label: "Русский", display: "RU" }
  ] as const;

  const displayCode = mode === "auto" ? "AUTO" : locale.toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 8,
          border: "1px solid #E2E8F0",
          background: "#fff",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: "#475569"
        }}
        title="Language selector"
      >
        <span style={{ fontSize: 16 }}>🌐</span>
        {displayCode}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            background: "#fff",
            border: "1px solid #E2E8F0",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 1000,
            minWidth: 160
          }}
        >
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => {
                if (lang.code === "auto") {
                  setLocaleMode("auto");
                } else {
                  setLocaleMode("manual");
                  setLocale(lang.code as Locale);
                }
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "10px 12px",
                border: "none",
                background:
                  lang.code === "auto"
                    ? mode === "auto"
                      ? "#F0F4F8"
                      : "#fff"
                    : locale === lang.code && mode === "manual"
                    ? "#F0F4F8"
                    : "#fff",
                cursor: "pointer",
                fontSize: 12,
                color:
                  lang.code === "auto"
                    ? mode === "auto"
                      ? "#0B1F2A"
                      : "#475569"
                    : locale === lang.code && mode === "manual"
                    ? "#0B1F2A"
                    : "#475569",
                fontWeight:
                  lang.code === "auto"
                    ? mode === "auto"
                      ? 600
                      : 500
                    : locale === lang.code && mode === "manual"
                    ? 600
                    : 500,
                borderBottom: lang.code !== languages[languages.length - 1].code ? "1px solid #E2E8F0" : "none",
                justifyContent: "flex-start"
              }}
            >
              <span>{lang.display}</span>
              <span style={{ fontSize: 13 }}>{lang.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

