"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale } from "../app/providers";

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
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
    { code: "en", label: "English", flag: "🇺🇸" },
    { code: "ar", label: "العربية", flag: "🇸🇦" }
  ] as const;

  const currentLanguage = languages.find((l) => l.code === locale) || languages[0];

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
      >
        <span style={{ fontSize: 16 }}>{currentLanguage.flag}</span>
        {currentLanguage.label}
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
            minWidth: 140
          }}
        >
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => {
                setLocale(lang.code as "en" | "ar");
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "10px 12px",
                border: "none",
                background: locale === lang.code ? "#F0F4F8" : "#fff",
                cursor: "pointer",
                fontSize: 12,
                color: locale === lang.code ? "#0B1F2A" : "#475569",
                fontWeight: locale === lang.code ? 600 : 500,
                borderBottom: lang.code !== languages[languages.length - 1].code ? "1px solid #E2E8F0" : "none"
              }}
            >
              <span style={{ fontSize: 16 }}>{lang.flag}</span>
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
